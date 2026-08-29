/**
 * ジョブをオーケストレータ Lambda へ**非同期で**投げる段（3.3-2.6 / #160）。
 *
 * これは**エッジ側**の実装である。受け取って走る側は `src/orchestrator/handler.ts`。
 *
 * ## なぜ 2 つ目のデプロイ単位が要るのか
 *
 * `ctx.waitUntil()` は応答送信またはクライアント切断から 30 秒で打ち切られ、未解決の
 * Promise はキャンセルされる（Cloudflare の明文）。生成は 90.9 秒（1.2.38）で収まらない。
 * **Pages Functions は queue consumer になれず、Durable Object を定義できず、Workflows の
 * binding も持たない**ため、Cloudflare 側で解くには例外なく 2 つ目のデプロイ単位が要る。
 * 既にある AWS へ寄せたのが A 案である（#160）。
 *
 * ## 呼び出しは「投げっぱなし」である
 *
 * `X-Amz-Invocation-Type: Event` を付けると、Lambda は**キューへ入れた時点で 202 を
 * 返す。** 関数の実行結果は応答に現れない。したがってこの段が投げる例外は
 * **「投げ込めなかった」だけ**で、生成そのものの失敗は `games` 行に現れる
 * （`GenerationPipeline.startJob` の契約。`src/generate.ts`）。
 *
 * ## 重複配信は設定では防げない
 *
 * **Lambda の非同期呼び出しのキューは結果整合で、AWS 自身が「関数がエラーを返さなくても
 * 同じイベントを複数回受け取りうる」と明記している。** 何度も投げないよう気をつける、
 * では担保にならない。**「LLM を 1 回だけ呼ぶ」は D1 の条件付き UPDATE（`claim`）が
 * 担保する**（`src/games.ts` の `claimGenerationJob`）。オーケストレータは最初の動作を
 * `claim` にし、`false` が返ったら Bedrock を呼ばずに降りる。
 *
 * ## 資格情報は `BUILD_AWS_*` を使う（増やさない）
 *
 * **#160 の積極的な理由は「エッジから長命の AWS 資格情報が 1 組減る」ことである**（9.2）。
 * 専用の 3 組目を足すと、その理由が消える。
 *
 * 移行後のエッジは**ビルド関数を直接呼ばない**（呼ぶのはオーケストレータの実行ロール
 * である）。したがって `game-forge-build-invoker` に要る許可は
 * 「オーケストレータを `lambda:InvokeFunction` する」ことだけになり、対象 ARN だけが
 * 移る（`terraform/build-invoker.tf`）。**動作も鍵の本数も変わらない。**
 *
 * 名前を `ORCHESTRATOR_AWS_*` へ改めない理由は 2 つある。改名はローテーション手順・
 * 雛形・型・文書へ同時に波及するのに対し、**得られるのは綴りの気分だけ**である。
 * そして `BUILD_` が指しているのは「AWS Lambda を呼ぶ側の鍵」であって、
 * 「ビルド関数だけを呼ぶ鍵」ではない。
 *
 * ## リトライしない
 *
 * `aws4fetch` の `AwsClient.fetch` は 5xx / 429 を自前で再試行するが、ここでは `sign`
 * だけを使って送信は自分で行う（`src/build-client.ts` と同じ）。**投げ直しは
 * 重複配信を自分で作る行為である。** `claim` があるので LLM は 1 回に留まるが、
 * 関門を自分で叩きに行く必要は無い。**投げ込めなかったことは利用者へ 5xx で返り、
 * 利用者が押し直せる**（`games` 行はその場で `failed` になる。`startGeneration`）。
 */
import { AwsClient } from 'aws4fetch';
import type { GenerationJob, GenerationPipeline } from '../generate.js';
import { selectGenerationModel } from '../generation-models.js';
import { buildOrchestratorPayload } from './payload.js';

/** SigV4 の署名対象サービス名（`src/build-client.ts` と同じ）。 */
const SIGNING_SERVICE = 'lambda';

/** Lambda の `Invoke` API の版（パスに現れる。日付であってリージョンではない）。 */
const LAMBDA_API_VERSION = '2015-03-31';

/**
 * 非同期呼び出しであることを表すヘッダの値。
 *
 * **これが `RequestResponse` に戻ると、待ち時間が Worker へ帰ってくる。**
 * 定数として置き、`test/orchestrator.test.ts` が署名済み要求のヘッダで照合する。
 */
export const ASYNC_INVOCATION_TYPE = 'Event';

/**
 * 呼ぶ相手の名前を持つ環境変数（`wrangler.toml` の `[vars]`）。
 *
 * **秘密ではないので `[vars]` に置く**（`BUILD_FUNCTION_NAME` と同じ扱い）。
 * 正本は `terraform/orchestrator.tf` の `local.orchestrator_function_name` である。
 */
export const ORCHESTRATOR_FUNCTION_NAME_VAR = 'ORCHESTRATOR_FUNCTION_NAME';

/**
 * 投げるために必須の秘密（`.dev.vars` / `wrangler pages secret`）。
 *
 * **`src/build-client.ts` の `BUILD_SECRET_NAMES` と同じ 3 つである。**
 * 書き写さずに import すると、あちらの一覧の意味（「ビルド関数を呼ぶために要る」）と
 * 食い違う説明になる。ここでは同じ鍵を**別の用途で**要求していることを、
 * 独立した一覧として明示する。
 *
 * `BUILD_AWS_SESSION_TOKEN` は必須に入れない（ローカルの SSO でだけ入る）。
 */
export const ORCHESTRATOR_SECRET_NAMES = [
  'BUILD_AWS_REGION',
  'BUILD_AWS_ACCESS_KEY_ID',
  'BUILD_AWS_SECRET_ACCESS_KEY',
] as const;

/** 呼び出しに必要な設定が足りない。 */
export class OrchestratorNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    // **値は出さない。名前だけ**（`src/bedrock.ts` / `src/build-client.ts` と同じ）。
    super(`オーケストレータの呼び出しに必要な設定がありません: ${missing.join(', ')}`);
    this.name = 'OrchestratorNotConfigured';
  }
}

/** 非同期呼び出しを投げ込めなかった。 */
export class OrchestratorInvokeFailed extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string | null,
    readonly requestId: string | null,
  ) {
    super(`オーケストレータへの非同期呼び出しに失敗しました（status=${status}）`);
    this.name = 'OrchestratorInvokeFailed';
  }
}

/** 署名に使う資格情報と、呼ぶ相手。 */
interface InvokeCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | undefined;
  readonly functionName: string;
}

/** 外から差し替えられるもの。 */
export interface StartJobDependencies {
  /**
   * 送信に使う `fetch`。
   *
   * **テストから差し替えるための継ぎ目（seam）。** 既定にすると単体テストが実 Lambda を
   * 要求する（`src/build-client.ts` / `src/bedrock.ts` と同じ）。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * 不足している設定の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingOrchestratorSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  const missing = ORCHESTRATOR_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  const functionName = values[ORCHESTRATOR_FUNCTION_NAME_VAR];
  if (typeof functionName !== 'string' || functionName.trim() === '') {
    return [...missing, ORCHESTRATOR_FUNCTION_NAME_VAR];
  }
  return missing;
}

/**
 * env から資格情報と宛先を取り出す。
 *
 * @param env バインディングと環境変数
 * @returns 資格情報と関数名
 * @throws {OrchestratorNotConfigured} 必須の値が欠けているとき
 */
function readInvokeCredentials(env: Env): InvokeCredentials {
  const missing = missingOrchestratorSecrets(env);
  if (missing.length > 0) {
    throw new OrchestratorNotConfigured(missing);
  }
  const values = env as unknown as Record<string, string | undefined>;
  const sessionToken = values['BUILD_AWS_SESSION_TOKEN'];
  return {
    region: values['BUILD_AWS_REGION']!.trim(),
    accessKeyId: values['BUILD_AWS_ACCESS_KEY_ID']!.trim(),
    secretAccessKey: values['BUILD_AWS_SECRET_ACCESS_KEY']!.trim(),
    // 空文字を渡すと `aws4fetch` が空の `X-Amz-Security-Token` を署名対象に含め、
    // 長命キーの署名が壊れる（`src/build-client.ts` と同じ）。
    sessionToken:
      typeof sessionToken === 'string' && sessionToken.trim() !== ''
        ? sessionToken.trim()
        : undefined,
    functionName: values[ORCHESTRATOR_FUNCTION_NAME_VAR]!.trim(),
  };
}

/**
 * `Invoke` のエンドポイントを組み立てる。
 *
 * @param region リージョン
 * @param functionName 関数名（または ARN）
 * @returns エンドポイントの URL
 */
export function invokeEndpoint(region: string, functionName: string): string {
  return `https://lambda.${region}.amazonaws.com/${LAMBDA_API_VERSION}/functions/${encodeURIComponent(functionName)}/invocations`;
}

/**
 * `GenerationPipeline['startJob']` に嵌まる非同期実装を作る。
 *
 * @param deps 外部依存
 * @returns `startJob` に嵌まる関数
 */
export function createLambdaJobStart(
  deps: StartJobDependencies = {},
): (env: Env, job: GenerationJob, pipeline: GenerationPipeline) => Promise<void> {
  return async (env: Env, job: GenerationJob): Promise<void> => {
    const credentials = readInvokeCredentials(env);
    const send = deps.fetch ?? ((request: Request) => fetch(request));

    // **モデルの選択はエッジが持つ**（確定5 / 4.2 の A/B）。未知の綴りはここで
    // 例外になる（`selectGenerationModel`）。オーケストレータ側にもう 1 つ
    // `GENERATION_MODEL` を置かないための形である（`./payload.ts`）。
    const model = selectGenerationModel(env);
    const payload = buildOrchestratorPayload(job, model.key);

    const aws = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: SIGNING_SERVICE,
      region: credentials.region,
    });

    let response: Response;
    try {
      const signed = await aws.sign(
        invokeEndpoint(credentials.region, credentials.functionName),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // **ここが A 案の要である。** `RequestResponse` に戻すと、91 秒の待ちが
            // そのまま Worker へ帰ってくる。
            'x-amz-invocation-type': ASYNC_INVOCATION_TYPE,
          },
          body: JSON.stringify(payload),
        },
      );
      response = await send(signed);
    } catch (error) {
      // 送信そのものが失敗した（DNS・TLS・接続断）。**理由の文字列は出すが、
      // ペイロードは出さない**（ジョブトークンが載っている）。
      throw new OrchestratorInvokeFailed(0, describeSendError(error), null);
    }

    const requestId = response.headers.get('x-amzn-requestid');
    // 非同期呼び出しの成功は 202 である。**200 も許さない**——200 が返ったなら
    // それは同期呼び出しであり、`x-amz-invocation-type` が効いていない。
    if (response.status !== 202) {
      throw new OrchestratorInvokeFailed(response.status, await readAwsErrorType(response), requestId);
    }
  };
}

/**
 * 既定の非同期実装（`defaultPipeline.startJob`）。
 *
 * **`runJobInline` と対になる名前にしてある。** どちらが結線されているかは
 * `src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS` と `test/work-page.test.ts` が
 * 照合しており、差し替えると画面の文言の更新を要求して落ちる。
 */
export const startJobOnLambda = createLambdaJobStart();

/**
 * AWS のエラー応答から種別だけを取り出す。
 *
 * **本文をそのまま例外へ入れない**（`src/build-client.ts` と同じ方針）。
 *
 * @param response エラー応答
 * @returns 種別名、読めなければ null
 */
async function readAwsErrorType(response: Response): Promise<string | null> {
  const header = response.headers.get('x-amzn-errortype');
  if (header !== null && header !== '') {
    // `Type:http://internal/...` の形で返ることがある。前半だけを採る。
    return header.split(':')[0] ?? null;
  }
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const type = body['__type'] ?? body['Error'];
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}

/**
 * 送信の失敗を 1 行にする。
 *
 * @param error catch した値
 * @returns 説明
 */
function describeSendError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return 'unknown send error';
}
