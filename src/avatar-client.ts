/**
 * アイコンの再エンコード関数（AWS Lambda）を**同期で**呼ぶ段（#380 / M12-12 / 仕様 5.10）。
 *
 * これは**エッジ側**の実装である。受け取って走る側は `lambda/avatar-encode/`（sharp）で、器は
 * `terraform/avatar-function.tf`、配備は `scripts/deploy-avatar.sh` にある。
 *
 * ## なぜ Lambda で再エンコードするのか
 *
 * **Worker の CPU 時間（無料枠 10 ms）では、画像を復号できない。** 受け付ける上限の 4 MiB の JPEG
 * （4032 × 3024）は、復号だけで 48 MB の画素になる。wasm の画像ライブラリを Worker に載せる形は、
 * 1 枚の変換が CPU の上限を桁で超える（**実測するまでもなく採らない**。仕様 5.10 の実装注記）。
 * Cloudflare Images の変換は、別の課金と外部状態（ゾーンの設定）を持ち込む。
 *
 * **AWS には既に OGP 撮影関数（`terraform/ogp-function.tf`）が居り、呼び出しの資格情報も IAM も
 * 配備手順もその形が出来ている。** 足すのはこの関数 1 つと、許可 1 つである（`src/ogp-client.ts` と
 * 同じ判断）。
 *
 * ## OGP と違い、応答を待つ
 *
 * **`X-Amz-Invocation-Type: RequestResponse`。** アイコンは設定した画面にすぐ出る必要があり、
 * 変換できなかったことをその場で利用者へ返したい。1 枚の変換は数百ミリ秒（冷えていても数秒）で、
 * **Worker が応答を待つ間は CPU 時間を使わない**（壁時計の時間であって CPU ではない）。
 *
 * ## 画像は応答の本文で戻り、R2 へ書くのは Worker である
 *
 * **関数に R2 の資格情報を渡さない**（`src/ogp.ts` の「R2 へ書くのは Worker である」と同じ理由）。
 * 変換した WebP は応答の JSON（base64）で戻り、R2 バインディングを持つ Worker が書く
 * （`src/avatar.ts`）。
 *
 * ## ペイロードに載せるのは画像だけである
 *
 * **出力の大きさ・品質・上限は関数側の環境変数が持つ**（`terraform/avatar-function.tf`）。ペイロードで
 * 渡すと、ペイロードを差し替えられる者が「巨大な出力を作らせる」ことができる（`src/ogp-client.ts` の
 * 「撮る URL も送り先もペイロードで渡さない」と同じ判断）。
 *
 * ## 資格情報は `BUILD_AWS_*` を使う（増やさない）
 *
 * **足すのは許可 1 つだけ**である——`game-forge-build-invoker` に「この関数を `lambda:InvokeFunction`
 * する」を加える（`terraform/avatar-function.tf` の `avatar_invoke`）。
 *
 * ## リトライしない
 *
 * **失敗は利用者へ返す**（「時間をおいてもう一度」）。自分で投げ直すと、関数が壊れた日に 1 回の
 * 送信が何回もの変換になる。
 */
import { AwsClient } from 'aws4fetch';

/** SigV4 の署名対象サービス名。 */
const SIGNING_SERVICE = 'lambda';

/** Lambda の `Invoke` API の版。 */
const LAMBDA_API_VERSION = '2015-03-31';

/**
 * 同期呼び出しであることを表すヘッダの値。
 *
 * **`Event` に変えると応答に画像が載らない**（202 だけが返る）。定数として置き、
 * `test/avatar.test.ts` が署名済み要求のヘッダで照合する。
 */
export const SYNC_INVOCATION_TYPE = 'RequestResponse';

/**
 * 呼ぶ相手の名前を持つ環境変数（`wrangler.toml` の `[vars]`）。
 *
 * **秘密ではないので `[vars]` に置く**（`OGP_FUNCTION_NAME` と同じ扱い）。正本は
 * `terraform/avatar-function.tf` の `local.avatar_function_name` で、突き合わせは
 * `scripts/check-avatar-copies.sh` が行う。
 */
export const AVATAR_FUNCTION_NAME_VAR = 'AVATAR_FUNCTION_NAME';

/**
 * 呼ぶために必須の秘密（`src/ogp-client.ts` の `OGP_SECRET_NAMES` と同じ 3 つ）。
 *
 * **import で結ばない**のは、あちらと同じ理由——同じ鍵を別の用途で要求していることを、
 * それぞれの場所で明示するためである。
 */
export const AVATAR_SECRET_NAMES = [
  'BUILD_AWS_REGION',
  'BUILD_AWS_ACCESS_KEY_ID',
  'BUILD_AWS_SECRET_ACCESS_KEY',
] as const;

/**
 * 関数が断ったときの理由（`lambda/avatar-encode/encode.mjs` の `REJECTIONS` の写し）。
 *
 * **写しの一致は `scripts/check-avatar-copies.sh` が見る。** ずれると、関数が断った理由を
 * Worker が「読めない応答」として扱い、利用者に「保存できませんでした」と出る。
 */
export const AVATAR_ENCODE_REJECTIONS = ['unsupported', 'animated', 'too-large', 'broken'] as const;

/** 関数が断ったときの理由。 */
export type AvatarEncodeRejection = (typeof AVATAR_ENCODE_REJECTIONS)[number];

/** 変換の結果。 */
export type AvatarEncodeResult =
  | { readonly ok: true; readonly webp: Uint8Array }
  | { readonly ok: false; readonly reason: AvatarEncodeRejection };

/** 呼び出しに必要な設定が足りない。 */
export class AvatarNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    // **値は出さない。名前だけ**（`src/ogp-client.ts` と同じ）。
    super(`アイコンの変換の呼び出しに必要な設定がありません: ${missing.join(', ')}`);
    this.name = 'AvatarNotConfigured';
  }
}

/** 呼び出しに失敗した（送れなかった・関数が落ちた・応答が読めない）。 */
export class AvatarEncodeFailed extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(`アイコンの変換の呼び出しに失敗しました（status=${status}）`);
    this.name = 'AvatarEncodeFailed';
  }
}

/** 外から差し替えられるもの。 */
export interface AvatarEncodeDependencies {
  /**
   * 送信に使う `fetch`。**テストから差し替えるための継ぎ目**（既定にすると単体テストが実 Lambda を要求する）。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** 変換を呼ぶ段。`src/avatar.ts` がこの形で受け取る。 */
export type EncodeAvatar = (env: Env, image: Uint8Array) => Promise<AvatarEncodeResult>;

/**
 * 不足している設定の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingAvatarSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  const missing: string[] = AVATAR_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  const functionName = values[AVATAR_FUNCTION_NAME_VAR];
  if (typeof functionName !== 'string' || functionName.trim() === '') {
    missing.push(AVATAR_FUNCTION_NAME_VAR);
  }
  return missing;
}

/**
 * `Invoke` のエンドポイントを組み立てる。
 *
 * @param region リージョン
 * @param functionName 関数名
 * @returns エンドポイントの URL
 */
function invokeEndpoint(region: string, functionName: string): string {
  return `https://lambda.${region}.amazonaws.com/${LAMBDA_API_VERSION}/functions/${encodeURIComponent(functionName)}/invocations`;
}

/**
 * 同期呼び出しの段を作る。
 *
 * @param deps 外部依存
 * @returns 変換を呼ぶ関数
 */
export function createAvatarEncode(deps: AvatarEncodeDependencies = {}): EncodeAvatar {
  return async (env: Env, image: Uint8Array): Promise<AvatarEncodeResult> => {
    const missing = missingAvatarSecrets(env);
    if (missing.length > 0) {
      throw new AvatarNotConfigured(missing);
    }
    const values = env as unknown as Record<string, string | undefined>;
    const region = values['BUILD_AWS_REGION']!.trim();
    const sessionToken = values['BUILD_AWS_SESSION_TOKEN'];
    const aws = new AwsClient({
      accessKeyId: values['BUILD_AWS_ACCESS_KEY_ID']!.trim(),
      secretAccessKey: values['BUILD_AWS_SECRET_ACCESS_KEY']!.trim(),
      // 空文字を渡すと空の `X-Amz-Security-Token` が署名に入り、長命キーの署名が壊れる（`src/ogp-client.ts`）。
      sessionToken: typeof sessionToken === 'string' && sessionToken.trim() !== '' ? sessionToken.trim() : undefined,
      service: SIGNING_SERVICE,
      region,
    });
    const send = deps.fetch ?? ((request: Request) => fetch(request));

    let response: Response;
    try {
      const signed = await aws.sign(invokeEndpoint(region, values[AVATAR_FUNCTION_NAME_VAR]!.trim()), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // **`Event` に戻さない。** 戻すと応答に画像が載らない。
          'x-amz-invocation-type': SYNC_INVOCATION_TYPE,
        },
        body: JSON.stringify({ image: bytesToBase64(image) }),
      });
      response = await send(signed);
    } catch (error) {
      // **ペイロード（利用者の画像）はログにも例外にも入れない。**
      throw new AvatarEncodeFailed(0, error instanceof Error ? `${error.name}: ${error.message}` : 'unknown send error');
    }

    // 同期呼び出しの成功は 200。**関数の中で投げた例外も 200 で返り、`X-Amz-Function-Error` が付く。**
    const functionError = response.headers.get('x-amz-function-error');
    if (response.status !== 200 || functionError !== null) {
      throw new AvatarEncodeFailed(response.status, functionError ?? response.headers.get('x-amzn-errortype'));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AvatarEncodeFailed(response.status, 'unreadable payload');
    }
    return readEncodePayload(payload, response.status);
  };
}

/**
 * 関数の応答を読む。**形が合わなければ例外にする**（読めない応答を「断った」に倒さない）。
 *
 * @param payload JSON を解析した値
 * @param status HTTP の状態（例外に載せる）
 * @returns 変換の結果
 * @throws {AvatarEncodeFailed} 形が合わないとき
 */
function readEncodePayload(payload: unknown, status: number): AvatarEncodeResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new AvatarEncodeFailed(status, 'payload is not an object');
  }
  const record = payload as Record<string, unknown>;
  if (record['ok'] === true && typeof record['webp'] === 'string') {
    const webp = base64ToBytes(record['webp']);
    if (webp === null) {
      throw new AvatarEncodeFailed(status, 'webp is not base64');
    }
    return { ok: true, webp };
  }
  const reason = record['reason'];
  if (record['ok'] === false && (AVATAR_ENCODE_REJECTIONS as readonly unknown[]).includes(reason)) {
    return { ok: false, reason: reason as AvatarEncodeRejection };
  }
  throw new AvatarEncodeFailed(status, 'unexpected payload shape');
}

/** 既定の実装。**本番の結線はこれ 1 つである。** */
export const encodeAvatarOnLambda: EncodeAvatar = createAvatarEncode();

/** `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64`（ランタイムにあれば使う）。 */
interface Base64Capable {
  toBase64?: () => string;
}

/**
 * バイト列を base64 にする。
 *
 * **ランタイムの `Uint8Array#toBase64` があれば使う**（ネイティブで、4 MiB でも CPU 時間を食わない）。
 * 無ければ 32 KiB ずつ `btoa` へ渡す（引数の数の上限を超えないため）。
 *
 * @param bytes バイト列
 * @returns base64
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Capable).toBase64;
  if (typeof native === 'function') {
    return native.call(bytes);
  }
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * base64 をバイト列に戻す（読めなければ null）。
 *
 * @param text base64
 * @returns バイト列
 */
export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
