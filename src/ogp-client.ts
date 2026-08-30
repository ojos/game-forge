/**
 * OGP 撮影関数（AWS Lambda）へジョブを**非同期で**投げる段（5.4 / 11.2 / #26）。
 *
 * これは**エッジ側**の実装である。受け取って走る側は `docker/ogp-shot/`（headless
 * chromium）で、配備の手順は `docs/ogp-capture.md` にある。
 *
 * ## なぜ AWS で撮るのか（利用者の決定）
 *
 * 11.2 は「**MVP は初回フレームの静止画 1 枚**」と定める。撮る手段は 2 つあった。
 *
 *   (a) Cloudflare Browser Rendering
 *   (b) **AWS Lambda に headless chromium の関数を足す（これ）**
 *
 * **(a) は Workers の有料プラン（$5/月）を要求する。** 3.2 の「Workers は無料枠」と
 * 4.6 の「実質ゼロ」の両方を崩す。5.5 が Cloudflare Email Sending を退けて Resend を
 * 採ったのと**同じ理由・同じ結論**である。AWS には既にビルド関数とオーケストレータが
 * 居り、資格情報も IAM も配備手順もその形が出来ている。
 *
 * ## 呼び出しは「投げっぱなし」である
 *
 * `X-Amz-Invocation-Type: Event` を付けると、Lambda は**キューへ入れた時点で 202 を
 * 返す。** 撮影そのものは数秒かかるが、**公開の応答はそれを待たない。** 5.4 は
 * 「1タップに畳んでフォーク連鎖の遅延を最小化する」と定めており、公開の押し心地に
 * 撮影の時間を載せない。
 *
 * 撮れたかどうかは `games.ogp_state` に現れる（`src/ogp.ts`）。**この段が投げる例外は
 * 「投げ込めなかった」だけ**である（`src/orchestrator/start-job.ts` と同じ契約）。
 *
 * ## 撮る URL も送り先もペイロードで渡さない
 *
 * **ペイロードに載せるのは `gameId` と使い捨てトークンだけである。** 撮影対象の URL
 * （`https://<SANDBOX_HOST>/g/<game_id>/`）とコールバックの宛先は、**関数側の環境変数**
 * が持つ（`terraform/ogp-function.tf`）。
 *
 * 理由は `src/orchestrator/payload.ts` が `CALLBACK_BASE_URL` について書いたものと同じで、
 * **ペイロードを差し替えられる者に、撮る先と送り先を決めさせない**ためである。URL を
 * 載せる形は、この関数を「任意の URL を撮って任意の宛先へ送る道具」に変える。
 *
 * ## 資格情報は `BUILD_AWS_*` を使う（増やさない）
 *
 * #160 の「エッジから長命の AWS 資格情報が 1 組減る」という成果（9.2）を、こちらで
 * 巻き戻さない。**足すのは許可 1 つだけ**である——`game-forge-build-invoker` に
 * 「OGP 関数を `lambda:InvokeFunction` する」を加える（`terraform/ogp-function.tf`。
 * 宣言は `terraform/build-invoker.tf` を触らずに、別のインラインポリシーとして置く）。
 *
 * ## リトライしない
 *
 * `aws4fetch` の `AwsClient.fetch` は 5xx / 429 を自前で再試行するが、ここでは `sign`
 * だけを使って送信は自分で行う（`src/build-client.ts` / `src/orchestrator/start-job.ts` と
 * 同じ）。**投げ直しは重複配信を自分で作る行為である。** 投げ込めなかったことは
 * `games.ogp_state = 'failed'` として残る（`src/ogp.ts` の `startOgpCapture`）。
 */
import { AwsClient } from 'aws4fetch';

/** SigV4 の署名対象サービス名（`src/orchestrator/start-job.ts` と同じ）。 */
const SIGNING_SERVICE = 'lambda';

/** Lambda の `Invoke` API の版（パスに現れる。日付であってリージョンではない）。 */
const LAMBDA_API_VERSION = '2015-03-31';

/**
 * 非同期呼び出しであることを表すヘッダの値。
 *
 * **これが `RequestResponse` に戻ると、撮影の数秒が公開の応答へ帰ってくる。**
 * 定数として置き、`test/ogp.test.ts` が署名済み要求のヘッダで照合する。
 */
export const ASYNC_INVOCATION_TYPE = 'Event';

/**
 * 呼ぶ相手の名前を持つ環境変数（`wrangler.toml` の `[vars]`）。
 *
 * **秘密ではないので `[vars]` に置く**（`BUILD_FUNCTION_NAME` /
 * `ORCHESTRATOR_FUNCTION_NAME` と同じ扱い）。正本は `terraform/ogp-function.tf` の
 * `local.ogp_function_name` である。
 */
export const OGP_FUNCTION_NAME_VAR = 'OGP_FUNCTION_NAME';

/**
 * 投げるために必須の秘密（`.dev.vars` / `wrangler pages secret`）。
 *
 * **`src/orchestrator/start-job.ts` の `ORCHESTRATOR_SECRET_NAMES` と同じ 3 つである。**
 * import で結ばずに独立した一覧として置くのは、あちらと同じ理由——**同じ鍵を別の用途で
 * 要求している**ことを、それぞれの場所で明示するためである。
 *
 * `BUILD_AWS_SESSION_TOKEN` は必須に入れない（ローカルの SSO でだけ入る）。
 */
export const OGP_SECRET_NAMES = [
  'BUILD_AWS_REGION',
  'BUILD_AWS_ACCESS_KEY_ID',
  'BUILD_AWS_SECRET_ACCESS_KEY',
] as const;

/** 呼び出しに必要な設定が足りない。 */
export class OgpNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    // **値は出さない。名前だけ**（`src/build-client.ts` などと同じ）。
    super(`OGP 撮影の呼び出しに必要な設定がありません: ${missing.join(', ')}`);
    this.name = 'OgpNotConfigured';
  }
}

/** 非同期呼び出しを投げ込めなかった。 */
export class OgpInvokeFailed extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string | null,
    readonly requestId: string | null,
  ) {
    super(`OGP 撮影への非同期呼び出しに失敗しました（status=${status}）`);
    this.name = 'OgpInvokeFailed';
  }
}

/** 撮影関数へ渡すもの。**URL は 1 本も入らない**（モジュール冒頭）。 */
export interface OgpCaptureJob {
  /** 撮る作品の id。関数側が `https://<SANDBOX_HOST>/g/<gameId>/` を組み立てる。 */
  readonly gameId: string;
  /** 使い捨てトークンの**平文**。D1 にはハッシュだけが入っている。 */
  readonly ogpToken: string;
}

/** 外から差し替えられるもの。 */
export interface OgpCaptureDependencies {
  /**
   * 送信に使う `fetch`。
   *
   * **テストから差し替えるための継ぎ目（seam）。** 既定にすると単体テストが実 Lambda を
   * 要求する（`src/build-client.ts` / `src/orchestrator/start-job.ts` と同じ）。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** 署名に使う資格情報と、呼ぶ相手。 */
interface InvokeCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | undefined;
  readonly functionName: string;
}

/**
 * 不足している設定の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingOgpSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  const missing = OGP_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  const functionName = values[OGP_FUNCTION_NAME_VAR];
  if (typeof functionName !== 'string' || functionName.trim() === '') {
    return [...missing, OGP_FUNCTION_NAME_VAR];
  }
  return missing;
}

/**
 * env から資格情報と宛先を取り出す。
 *
 * @param env バインディングと環境変数
 * @returns 資格情報と関数名
 * @throws {OgpNotConfigured} 必須の値が欠けているとき
 */
function readInvokeCredentials(env: Env): InvokeCredentials {
  const missing = missingOgpSecrets(env);
  if (missing.length > 0) {
    throw new OgpNotConfigured(missing);
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
    functionName: values[OGP_FUNCTION_NAME_VAR]!.trim(),
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

/** 撮影を投げる段。`src/ogp.ts` がこの形で受け取る。 */
export type StartOgpCapture = (env: Env, job: OgpCaptureJob) => Promise<void>;

/**
 * 撮影関数への非同期呼び出しを作る。
 *
 * @param deps 外部依存
 * @returns 撮影を投げる関数
 */
export function createOgpCaptureStart(deps: OgpCaptureDependencies = {}): StartOgpCapture {
  return async (env: Env, job: OgpCaptureJob): Promise<void> => {
    const credentials = readInvokeCredentials(env);
    const send = deps.fetch ?? ((request: Request) => fetch(request));

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
            // **`RequestResponse` に戻さない。** 戻すと公開の応答が撮影を待つ。
            'x-amz-invocation-type': ASYNC_INVOCATION_TYPE,
          },
          // **URL は 1 本も載せない**（モジュール冒頭）。
          body: JSON.stringify({ gameId: job.gameId, ogpToken: job.ogpToken }),
        },
      );
      response = await send(signed);
    } catch (error) {
      // 送信そのものが失敗した（DNS・TLS・接続断）。**理由の文字列は出すが、
      // ペイロードは出さない**（トークンが載っている）。
      throw new OgpInvokeFailed(0, describeSendError(error), null);
    }

    const requestId = response.headers.get('x-amzn-requestid');
    // 非同期呼び出しの成功は 202 である。**200 も許さない**——200 が返ったなら
    // それは同期呼び出しであり、`x-amz-invocation-type` が効いていない。
    if (response.status !== 202) {
      throw new OgpInvokeFailed(response.status, await readAwsErrorType(response), requestId);
    }
  };
}

/**
 * 既定の実装。**本番の結線はこれ 1 つである。**
 */
export const startOgpCaptureOnLambda: StartOgpCapture = createOgpCaptureStart();

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
