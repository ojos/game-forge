/**
 * オーケストレータ側の {@link GenerationPipeline}（#160）。
 *
 * ## 段の中身は 1 つも書き直さない
 *
 * 3.3-3..8 の順序とリトライ（5.2-7 / 4.2）は `src/generate.ts` の
 * `runGenerationJob` が持っており、**それがそのまま Lambda で走る。** ここが作るのは、
 * その関数へ渡す段の束だけである。
 *
 * | 段 | エッジ（`defaultPipeline`） | オーケストレータ（ここ） |
 * |---|---|---|
 * | `checkQuota` | `checkGenerationQuota`（D1） | **使わない。** 判定は 3.3-2 の 1 か所（4.3） |
 * | `generateSource` | Bedrock | **同じ**（資格情報だけが実行ロール由来） |
 * | `recordCost` | D1 へ直接 | `ledger` コールバック |
 * | `inspectSource` | AST 検査 | **同じ**（純粋な関数） |
 * | `build` | 索引（D1/R2）＋ Lambda | `cache-lookup` コールバック＋ Lambda |
 * | `completeGame` | D1 へ直接 | `finish` コールバック |
 * | `failGame` | D1 へ直接 | `finish` コールバック |
 * | `startJob` | 非同期呼び出し | `claim` してから走らせる |
 *
 * **`src/go-imports.ts`（5.2-5 の許可パッケージ検査）を Go で書き直さない**という
 * #160 の制約は、この表の「同じ」の 2 行が守っている。あれは #17 が仕様書と機械照合
 * しているセキュリティ層で、書き直すと複製が生まれる（shared-ai-rules 12 章）。
 *
 * ## ビルド関数は無改造である
 *
 * オーケストレータは**生成コードを一度もコンパイルしない。** ビルドは今までどおり
 * `game-forge-build` を同期で呼ぶだけで、あの関数へ Bedrock の鍵は入らない（7.1）。
 * 攻撃者が `go build` の RCE で得るものは、R2 の書き込みのままである。
 */
import type { BuildOutcome } from '../build-client.js';
import {
  artifactKeysOf,
  buildCacheRecordOf,
  createBuildTimeoutBudget,
  invokeBuildFunction,
} from '../build-client.js';
import { sourceCacheKey } from '../build-cache.js';
import { createBedrockGenerateSource } from '../bedrock.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { withInputModeration } from '../input-moderation.js';
import { withBuildDiagnostics } from '../build-retry.js';
import { inspectGeneratedSource } from '../source-inspection.js';
import type { GenerationJob, GenerationPipeline } from '../generate.js';
import {
  GenerationJobNotClaimable,
  notImplementedPipeline,
  runGenerationJob,
  withTidyInstruction,
} from '../generate.js';
import type { GenerationResult } from '../generation-models.js';
import type { CallbackClient } from './callbacks.js';

/** 外から差し替えられるもの。 */
export interface OrchestratorPipelineDependencies {
  /** ビルド関数を呼ぶときの `fetch`（テストの継ぎ目）。 */
  readonly buildFetch?: (request: Request) => Promise<Response>;
  /** Bedrock を呼ぶときの `fetch`（テストの継ぎ目）。 */
  readonly bedrockFetch?: (request: Request) => Promise<Response>;
  /** 台帳の id を採番する（テストの継ぎ目。既定は `crypto.randomUUID`）。 */
  readonly newGenerationId?: () => string;
}

/**
 * オーケストレータ側のパイプラインを組み立てる。
 *
 * **`notImplementedPipeline` を土台にする**（`defaultPipeline` と同じ形）。
 * 使わない段（`checkQuota`）を空の成功にしないためで、うっかり呼んだときに
 * **クォータを判定せずに通った**状態を作らない。
 *
 * **この関数は 1 ジョブにつき 1 回だけ呼ばれる**（`./handler.ts`）。時間切れの
 * 呼び直しの枠を依頼ごとに持たせているのは、その性質に乗っている（#174）。
 *
 * @param client このジョブのコールバッククライアント
 * @param deps 外部依存
 * @returns パイプライン
 */
export function createOrchestratorPipeline(
  client: CallbackClient,
  deps: OrchestratorPipelineDependencies = {},
): GenerationPipeline {
  const newGenerationId = deps.newGenerationId ?? (() => crypto.randomUUID());

  // **1 依頼ぶんの、時間切れによる呼び直しの枠**（#174 / `src/build-client.ts`）。
  // **ここで 1 つだけ作る。** ビルドごとに作ると、1 依頼で最大 9 回の呼び直しが
  // 積める状態へ戻り、`terraform/orchestrator.tf` の実行時間の見積もりが崩れる
  // （溢れると `finish` が届かず、作品行は `running` のまま残る）。
  const buildTimeoutBudget = createBuildTimeoutBudget();

  return {
    ...notImplementedPipeline,

    // 3.3-3: 生成。**エッジと同じ実装**である。違うのは資格情報の出どころだけで、
    // `BEDROCK_AWS_*` に実行ロールの一時資格情報が写っている（`./handler.ts`）。
    // **整理パスの指示も同じ順で掛ける**（確定18 / #33）。エッジ
    // （`src/generate.ts` の `defaultPipeline`）と**包み方まで揃える**——ずれると、
    // 同じジョブが実行環境によって別のプロンプトで走る。
    //
    // **モデレーションはいちばん外側である**（8.2 / #37）。内側に置くと、整理パスの
    // 指示や再試行の診断が織り込まれた**後**のプロンプトを検査することになり、
    // **利用者が書いていない文字列で遮断が起きうる。** 検査するのは 5.1 の入力そのもの。
    generateSource: withInputModeration(
      withBuildDiagnostics(
        withTidyInstruction(
          createBedrockGenerateSource({
            systemPrompt: buildSystemPrompt,
            ...(deps.bedrockFetch === undefined ? {} : { fetch: deps.bedrockFetch }),
          }),
        ),
      ),
      {
        record: async (categories, prompt) => await client.blocked(categories, prompt),
        ...(deps.bedrockFetch === undefined ? {} : { fetch: deps.bedrockFetch }),
      },
    ),

    // 3.3-4: 費用の計上。**id はここで採番する**（1 回の LLM 呼び出しにつき 1 つ）。
    // 再送しても同じ id を送るので、行は 1 行のままである（確定25）。
    //
    // **`userId` を送らない。** 作者は `games` 行が知っており、そちらが正である
    // （`src/generate-callback.ts`）。
    recordCost: async (_env, _userId, request, generated) => {
      await client.ledger({
        generationId: newGenerationId(),
        prompt: request.prompt,
        generated,
      });
    },

    // 5.2-5: ホワイトリスト検査。**純粋な関数なのでそのまま借りる。**
    inspectSource: inspectGeneratedSource,

    // 3.3-5..7: 索引を先に引き、ミスならビルド関数を呼ぶ。
    // **`createLambdaBuild` を使えない**のは、あちらが D1 と R2 のバインディングで
    // 索引を引くためである（`src/build-cache.ts`）。引き方だけを差し替える。
    build: async (env: Env, generated: GenerationResult): Promise<BuildOutcome> => {
      const sourceSha256 = await sourceCacheKey(generated.source);

      const cached = await client.cacheLookup(sourceSha256);
      if (cached.hit) {
        return {
          cached: true,
          sourceSha256,
          goVersion: cached.entry.goVersion,
          artifact: {
            wasm: { bytes: cached.entry.wasmBytes, sha256: cached.entry.wasmSha256 },
            compressed: {
              bytes: cached.entry.compressedBytes,
              sha256: cached.entry.compressedSha256,
              contentEncoding: cached.entry.contentEncoding,
            },
          },
          entry: cached.entry,
        };
      }

      const built = await invokeBuildFunction(env, generated.source, {
        // **枠はジョブごとの 1 つを渡す**（#174。作るのはこの関数の冒頭）。
        budget: buildTimeoutBudget,
        ...(deps.buildFetch === undefined ? {} : { fetch: deps.buildFetch }),
      });
      return { cached: false, sourceSha256, ...built };
    },

    // 3.3-8: 行の完成。**索引の更新もここで送る**（ヒット時は null＝書き直さない）。
    // `artifactKeysOf` / `buildCacheRecordOf` を借りるので、キーの綴りを組み立て直さない。
    completeGame: async (_env, _gameId, built) => {
      const keys = artifactKeysOf(built);
      return await client.finishWithArtifacts({
        goVersion: built.goVersion,
        sourceKey: keys.sourceKey,
        wasmKey: keys.wasmKey,
        cacheRecord: buildCacheRecordOf(built),
      });
    },

    // 失敗の記録（8.3）。**送れなければ例外になる**ので、行が `running` のまま
    // 残ったことが呼び出し元（`./handler.ts`）から分かる。
    //
    // **3.8 の degrade の信号も、ここで一緒に渡す**（#140）。この Lambda は D1 を
    // 持たないため、信号を書けるのは Worker 側だけである（#150 の A 案）。
    // **判定はしない**——`buildPathFailed` は `src/build-health.ts` が
    // `src/generate.ts` の catch で決めたもので、ここは運ぶだけである。
    failGame: async (_env, _gameId, errorCode, buildPathFailed) =>
      await client.finishWithError(errorCode, buildPathFailed === true),

    // **最初の動作を `claim` にする。** `false` なら Bedrock を呼ばずに降りる。
    startJob: async (env, job, pipeline) => await runJobViaCallbacks(client, env, job, pipeline),
  };
}

/**
 * `claim` してからジョブを走らせる（`runJobInline` の非同期版）。
 *
 * **重複配信は正常な入力である。** AWS は「関数がエラーを返さなくても同じイベントを
 * 複数回受け取りうる」と明記しており、設定では防げない。**条件付き UPDATE が
 * 唯一の担保である**（`src/games.ts` の `claimGenerationJob`）。
 *
 * 握れなければ {@link GenerationJobNotClaimable} を投げる。**呼び出し元
 * （`./handler.ts`）はこれを正常な結果として飲む**——同期実行では起こらないので、
 * 例外の型で区別できるようにしてある。
 *
 * @param client コールバッククライアント
 * @param env 環境変数（実行ロールの資格情報が写っている）
 * @param job 走らせるジョブ
 * @param pipeline 段の束
 * @throws {GenerationJobNotClaimable} 既に他の配信が握っていたとき
 */
export async function runJobViaCallbacks(
  client: CallbackClient,
  env: Env,
  job: GenerationJob,
  pipeline: GenerationPipeline,
): Promise<void> {
  const claimed = await client.claim();
  if (!claimed) {
    throw new GenerationJobNotClaimable(job.gameId);
  }
  await runGenerationJob(env, job, pipeline);
}
