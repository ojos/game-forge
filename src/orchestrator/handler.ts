/**
 * オーケストレータ Lambda の入口（#160 / 3.3 の再配置）。
 *
 * ## 何のためにあるか
 *
 * 生成は 90.9 秒（1.2.38）かかる。**`ctx.waitUntil()` は応答送信またはクライアント
 * 切断から 30 秒で打ち切られる**ため、Worker の中では走り切れない。この関数は
 * 応答を返したあとも走り切れる実行体で、#150 の「タブを閉じてよい」を本当にする。
 *
 * ## 最初の動作は `claim` である
 *
 * **重複配信は設定では防げない。** Lambda の非同期呼び出しのキューは結果整合で、
 * AWS 自身が「関数がエラーを返さなくても同じイベントを複数回受け取りうる」と明記
 * している。**唯一の担保は D1 の条件付き UPDATE** で、`false` が返ったら Bedrock を
 * 呼ばずに降りる（`./pipeline.ts` の `runJobViaCallbacks`）。
 *
 * ## 基盤のリトライは 0 である
 *
 * 5.2-7 が既に最大 3 試行を持っている。掛け算にすると**最大 9 回・約 144 円・
 * 日次枠 9 個**が 1 回の送信から出る。`MaximumRetryAttempts=0` は
 * `terraform/orchestrator.tf` が宣言し、`scripts/check-orchestrator-retry.sh` が
 * 宣言側を機械で押さえる。
 *
 * ## 何を投げ、何を飲むか
 *
 * **投げた例外は OnFailure destination（SQS）へ行く。** したがって「運用が見るべき
 * ことだけ」を投げる。
 *
 * | 事象 | 投げるか | 理由 |
 * |---|---|---|
 * | 重複配信で握れなかった | **飲む** | 正常な結果である（上記） |
 * | 生成が失敗し、`finish` は届いた | **飲む** | 利用者は作品ページで結果を見ている。8.3 の分類名も記録済み |
 * | `ledger` が届かなかった | **投げる** | **課金だけ出て日次枠が減らない**（4.3 / 確定25） |
 * | `claim` / `finish` が届かなかった | **投げる** | 作品行が未確定のまま残り、作品ページが永久に「生成中」 |
 * | ペイロード・設定が壊れている | **投げる** | 契約違反。1 件も成功しないので早く見える必要がある |
 *
 * **結末を先に記録してから投げる。** 順序を逆にすると、DLQ には出るが利用者の画面は
 * 回り続ける。**回り続ける表示より失敗として読めるほうがよい**（`src/generate.ts`）。
 *
 * ## 資格情報は実行ロールから来る
 *
 * **`BEDROCK_AWS_*` はエッジのシークレットから消える**（#160 の積極的な理由。9.2）。
 * この関数は AWS の中で動くので IAM ロールを引き受けられ、Lambda が
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` を環境へ注入する。
 * **その 3 つを、既存のモジュールが読む名前へ写すだけでよい**（下記 {@link workerLikeEnv}）。
 * `src/bedrock.ts` も `src/build-client.ts` も 1 行も変えない。
 */
import type { GenerationErrorCode } from '../games.js';
import type { GenerationJob } from '../generate.js';
import { GenerationJobNotClaimable, generationErrorCodeOf } from '../generate.js';
import { CallbackClient } from './callbacks.js';
import type { CallbackDependencies } from './callbacks.js';
import { createOrchestratorPipeline } from './pipeline.js';
import type { OrchestratorPipelineDependencies } from './pipeline.js';
import { parseOrchestratorPayload } from './payload.js';

/**
 * ペイロードが運ばない値の置き場所。
 *
 * **`userId` は運ばない**（`./payload.ts`）。台帳の作者は `games` 行が知っており、
 * そちらが正である。`runGenerationJob` は型として受け取るが、オーケストレータの
 * `recordCost` はこの値を使わない。
 */
const USER_ID_NOT_CARRIED = '';

/** この関数が要る環境変数（`terraform/orchestrator.tf` が宣言する）。 */
export const ORCHESTRATOR_ENV_NAMES = ['CALLBACK_BASE_URL', 'BUILD_FUNCTION_NAME'] as const;

/**
 * Lambda が実行ロールから注入する資格情報の名前。
 *
 * **この 3 つを宣言しない。** Lambda 側が入れるもので、宣言に書くと予約名の衝突で
 * 関数の作成が失敗する（`terraform/orchestrator.tf`）。
 */
export const ROLE_CREDENTIAL_NAMES = [
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/** 実行の結末。**呼び出し元（Lambda ランタイム）へは返らない**が、ログとテストが読む。 */
export type OrchestratorOutcome =
  /** 重複配信。既に他の配信が握っていた。**LLM は 1 回も呼んでいない。** */
  | { readonly status: 'claimed-elsewhere' }
  /** 生成が完走し、`games` 行が `ready` になった。 */
  | { readonly status: 'completed' }
  /** 生成が失敗し、`games` 行が `failed` になった（8.3 の分類名つき）。 */
  | { readonly status: 'failed'; readonly errorCode: GenerationErrorCode };

/** 設定が足りない。 */
export class OrchestratorEnvIncomplete extends Error {
  constructor(readonly missing: readonly string[]) {
    // **値は出さない。名前だけ。** 資格情報が混ざる位置なので、方針を崩さない。
    super(`オーケストレータの環境変数が足りません: ${missing.join(', ')}`);
    this.name = 'OrchestratorEnvIncomplete';
  }
}

/** ペイロードが契約に合わない。 */
export class OrchestratorPayloadRejected extends Error {
  constructor() {
    // **中身を出さない。** ジョブトークンが載っている（`./payload.ts`）。
    super('オーケストレータのペイロードが契約に合いません');
    this.name = 'OrchestratorPayloadRejected';
  }
}

/**
 * 結末を記録できなかった。**作品行は未確定のまま残っている。**
 *
 * **どの状態で止まったかは断定できない。** この例外が表しているのは「結末が
 * 記録されていない」ことだけで、止まった位置は**どのコールバックが届かなかったか**で
 * 変わる。
 *
 * | 届かなかったもの | 作品行 |
 * |---|---|
 * | `claim` | `pending` のまま（LLM は 1 回も呼んでいない） |
 * | `finish` | `running` のまま（生成は走り、結果を書けなかった） |
 *
 * **メッセージで状態を断定しない。** これは DLQ を見た人が最初に読む文字列で、
 * **断定が外れると、最初に見る場所を間違える。**
 */
export class OutcomeNotRecorded extends Error {
  constructor(readonly gameId: string) {
    super(
      `結末を記録できませんでした: ${gameId}（コールバックが届かず、作品行は未確定のまま残っています。どの状態かは行を見ること）`,
    );
    this.name = 'OutcomeNotRecorded';
  }
}

/** 台帳を記録できなかった。**課金だけ出て日次枠が減っていない**（4.3 / 確定25）。 */
export class LedgerNotRecorded extends Error {
  constructor(
    readonly gameId: string,
    readonly failures: number,
  ) {
    super(`台帳を記録できませんでした: ${gameId}（${failures} 件。課金だけ出て日次枠が減っていません）`);
    this.name = 'LedgerNotRecorded';
  }
}

/** 外から差し替えられるもの。 */
export interface OrchestratorDependencies
  extends CallbackDependencies,
    OrchestratorPipelineDependencies {
  /** コールバックに使う `fetch`（`CallbackDependencies` の `fetch`）。 */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * 1 件のイベントを処理する。**テストが直接叩く入口である。**
 *
 * @param event 非同期呼び出しで届いたペイロード
 * @param values 環境変数（実行ロールの資格情報を含む）
 * @param deps 外部依存
 * @returns 結末
 * @throws {OrchestratorPayloadRejected} ペイロードが契約に合わないとき
 * @throws {OrchestratorEnvIncomplete} 環境変数が足りないとき
 * @throws {OutcomeNotRecorded} 結末を記録できなかったとき
 * @throws {LedgerNotRecorded} 台帳を記録できなかったとき
 */
export async function handleOrchestratorEvent(
  event: unknown,
  values: Readonly<Record<string, string | undefined>>,
  deps: OrchestratorDependencies = {},
): Promise<OrchestratorOutcome> {
  const payload = parseOrchestratorPayload(event);
  if (payload === null) {
    throw new OrchestratorPayloadRejected();
  }

  const missing = missingOrchestratorEnv(values);
  if (missing.length > 0) {
    throw new OrchestratorEnvIncomplete(missing);
  }

  const client = new CallbackClient(
    {
      baseUrl: values['CALLBACK_BASE_URL']!.trim(),
      gameId: payload.gameId,
      jobToken: payload.jobToken,
    },
    deps,
  );
  const pipeline = createOrchestratorPipeline(client, deps);
  const env = workerLikeEnv(values, payload.modelKey);
  const job: GenerationJob = {
    gameId: payload.gameId,
    jobToken: payload.jobToken,
    userId: USER_ID_NOT_CARRIED,
    request: { prompt: payload.prompt },
  };

  let outcome: OrchestratorOutcome;
  try {
    await pipeline.startJob(env, job, pipeline);
    outcome = { status: 'completed' };
  } catch (error) {
    if (error instanceof GenerationJobNotClaimable) {
      // **重複配信。正常な結果である。** LLM は 1 回も呼んでいない。
      console.log(`[orchestrator] duplicate delivery, standing down: ${payload.gameId}`);
      return { status: 'claimed-elsewhere' };
    }
    if (!client.outcomeRecorded) {
      // `runGenerationJob` の catch は必ず `failGame` を呼ぶ。それでも記録が残って
      // いないなら、**コールバックそのものが届いていない。**
      //
      // **`claim` が届かなかった場合もここへ来る**（その場合 LLM は 1 回も呼んで
      // いない）。どちらなのかは例外の綴りでは区別しないので、断定しない。
      console.error(`[orchestrator] outcome not recorded: ${payload.gameId} (${describe(error)})`);
      throw new OutcomeNotRecorded(payload.gameId);
    }
    // **同じ判定を書き写さない**（shared-ai-rules 12 章）。`failGame` へ渡した
    // のと同じ分類名を、同じ関数から得る。
    outcome = { status: 'failed', errorCode: generationErrorCodeOf(error) };
  }

  if (client.ledgerFailures > 0) {
    // **結末は記録済みである**（利用者の画面は止まっている）。そのうえで、
    // 4.3 の記録規約が壊れたことを運用へ出す。
    throw new LedgerNotRecorded(payload.gameId, client.ledgerFailures);
  }

  console.log(`[orchestrator] ${outcome.status}: ${payload.gameId}`);
  return outcome;
}

/**
 * AWS Lambda の入口（`index.handler`）。
 *
 * **環境変数はここでだけ読む。** `process` は Workers のランタイムに無いため、
 * モジュールの評価時ではなく呼び出し時に、存在を確かめてから読む
 * （`test/orchestrator.test.ts` は workerd の上で走る）。
 *
 * @param event 非同期呼び出しで届いたペイロード
 * @returns 結末
 */
export async function handler(event: unknown): Promise<OrchestratorOutcome> {
  return await handleOrchestratorEvent(event, processEnv());
}

/**
 * 足りない環境変数の名前を返す。
 *
 * @param values 環境変数
 * @returns 足りない名前（揃っていれば空配列）
 */
export function missingOrchestratorEnv(
  values: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return [...ORCHESTRATOR_ENV_NAMES, ...ROLE_CREDENTIAL_NAMES].filter((name) => {
    // `AWS_SESSION_TOKEN` は実行ロールでは必ず入る。**それでも必須に入れている**のは、
    // 入っていない状態＝ロールではなく長命キーで動いている状態であり、
    // **9.2 が消したかった構図そのもの**だからである。
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * 既存のモジュールが読む名前へ、実行ロールの資格情報を写す。
 *
 * **`src/bedrock.ts` と `src/build-client.ts` を 1 行も変えないための層である。**
 * あちらは `BEDROCK_AWS_*` / `BUILD_AWS_*` という名前で env を読む。Lambda が注入する
 * のは `AWS_*` なので、ここで対応づける。
 *
 * **同じ資格情報が両方に入る。** エッジでは principal を分けていたが（鍵 1 本の漏洩で
 * 生成とビルドの両方が開かないように）、ここでは principal は 1 つの実行ロールである。
 * 分ける相手がいない以上、名前だけを分けても実体は同じで、**それはむしろ読み違えを
 * 生む**（`terraform/build-invoker.tf` が「名前だけが分かれていて実体が同じ」を
 * 避けたいと書いているのと同じ理由で、ここでは分けない）。
 *
 * @param values 環境変数
 * @param modelKey 生成に使うモデルの鍵（ペイロードが運ぶ）
 * @returns Worker 側のモジュールが読める形
 */
function workerLikeEnv(
  values: Readonly<Record<string, string | undefined>>,
  modelKey: string,
): Env {
  const region = values['AWS_REGION']!.trim();
  const accessKeyId = values['AWS_ACCESS_KEY_ID']!.trim();
  const secretAccessKey = values['AWS_SECRET_ACCESS_KEY']!.trim();
  const sessionToken = values['AWS_SESSION_TOKEN']!.trim();

  return {
    BEDROCK_AWS_REGION: region,
    BEDROCK_AWS_ACCESS_KEY_ID: accessKeyId,
    BEDROCK_AWS_SECRET_ACCESS_KEY: secretAccessKey,
    BEDROCK_AWS_SESSION_TOKEN: sessionToken,
    BUILD_AWS_REGION: region,
    BUILD_AWS_ACCESS_KEY_ID: accessKeyId,
    BUILD_AWS_SECRET_ACCESS_KEY: secretAccessKey,
    BUILD_AWS_SESSION_TOKEN: sessionToken,
    BUILD_FUNCTION_NAME: values['BUILD_FUNCTION_NAME']!.trim(),
    // **モデルはペイロードが運ぶ**（正本は `wrangler.toml`。`./payload.ts`）。
    GENERATION_MODEL: modelKey,
    // D1 / R2 のバインディングは**持たない。** 使う段はすべてコールバックへ
    // 差し替えてあり（`./pipeline.ts`）、持たないことが 7.3 / 9.2 の要件である。
  } as unknown as Env;
}

/**
 * 例外を 1 行にする。**生成物もプロンプトもトークンも出さない。**
 *
 * @param error catch した値
 * @returns 説明
 */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/**
 * `process.env` を、無い環境でも壊れずに読む。
 *
 * @returns 環境変数（`process` が無ければ空）
 */
function processEnv(): Readonly<Record<string, string | undefined>> {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env ?? {};
}
