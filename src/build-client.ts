/**
 * Workers からビルド関数（AWS Lambda `game-forge-build`）を呼ぶ経路（3.3-5..7 / 3.8 / #19）。
 *
 * **関数の器は #103 が持つ**（`terraform/build-function.tf` と
 * `docker/isolated-build/`、手順は `docs/build-function.md`）。ここが持つのは
 * **呼び出し側**、すなわち認証・待ち時間・結果の読み取り・失敗の区別・
 * ビルド結果キャッシュ（`src/build-cache.ts`）の 5 つだけである。
 *
 * ## 認証は IAM の SigV4（`src/bedrock.ts` と同じ）
 *
 * Workers は AWS の外で動くため IAM ロールを引き受ける経路が無く、長命のアクセスキーを
 * Pages のシークレットへ置いて署名する（4.1 / 9.2 / `docs/bedrock-access.md`）。
 * 署名は `aws4fetch` で行い、**サービス名は `lambda`** である。
 *
 * **Bedrock の資格情報とは別の名前にする**（`BUILD_AWS_*`）。用途が違うものに同じ名前を
 * 付けると、どちらの資格情報で何を叩いているかが読めなくなる（`.dev.vars.example` の
 * `BEDROCK_` 接頭辞と同じ理由）。加えて、Bedrock を呼ぶ IAM ユーザーのポリシーは
 * `bedrock:InvokeModel` だけを許しており（`terraform/bedrock.tf`）、そのままでは
 * `lambda:InvokeFunction` を通せない。**最小権限を保つには principal ごと分ける。**
 *
 * ## リトライしない
 *
 * `aws4fetch` の `AwsClient.fetch` は 5xx / 429 を自前で再試行するが、ここでは
 * `sign` だけを使って送信は自分で行う。**ビルドの再送は Lambda の課金時間の再発生**で
 * あり、しかも 3.3 の順序では費用計上（3.3-4）が既に済んでいる。再試行の判断は
 * #20 が持つ（`src/bedrock.ts` と同じ方針）。
 *
 * ## 待ち時間（Cloudflare 側の制約との突き合わせ。1.2.24 の申し送り）
 *
 * 3.3-5 は同期呼び出しで、関数のタイムアウトは 30 秒である（1.2.24 / 確定24）。
 * **Cloudflare 側にこれを妨げる制約は無い。** 一次情報（developers.cloudflare.com）で
 * 確かめた点は次のとおりで、詳細と出典は `docs/build-invocation.md` にある。
 *
 * - **HTTP 起動の Worker の実時間に上限が無い**（クライアントが接続している限り）。
 * - **個々の subrequest にも時間の上限が無い**（`fetch` は自前で `AbortSignal` を
 *   渡さない限り待ち続ける）。
 * - **待ち時間は CPU 時間に算入されない。** CPU の上限（Paid 既定 30 秒）に対して、
 *   30 秒待つこと自体は 1 ms も使わない。
 * - 524（Proxy Read Timeout 125 秒）は Cloudflare のプロキシがオリジンに対して持つ
 *   もので、Worker の外向き subrequest の話ではない。
 * - Pages Functions は Workers と同じ実行時制限に従う（別の上限を持たない）。
 *
 * **したがって同期のまま維持する。** 残る現実的な上限は「利用者のブラウザ側の
 * タイムアウト」であり、これは 30 秒に対しては通常問題にならない。
 *
 * ## 失敗を 4 つに分ける（#20 / 3.8 の degrade 判定）
 *
 * | 種別 | 型 | 誰が受け取るか |
 * |---|---|---|
 * | ビルド失敗（生成コードがコンパイルを通らない） | {@link BuildRejected} | **#20（自動リトライ）** |
 * | タイムアウト | {@link BuildTimedOut} | 3.8 の degrade 判定 |
 * | 関数のエラー・呼び出しの失敗 | {@link BuildFunctionFailed} | 3.8 の degrade 判定 |
 * | 設定の不足 | {@link BuildNotConfigured} | 運用（呼び出す前に落ちる） |
 *
 * **ビルド失敗を「関数の障害」と混ぜない。** 関数側も同じ線引きをしており、利用者の
 * コードの問題は 200 応答の中の `ok:false` で返る（`docker/isolated-build/handler/handler.go`）。
 * 混ぜると 3.8 の degrade（「ビルド依頼の失敗」で発火する）が、利用者のコードの誤りで
 * 誤爆する。逆に**時間切れは `ok:false` で返らない**ことも関数側が保証している。
 */
import { AwsClient } from 'aws4fetch';
import type { GenerationResult } from './generation-models.js';
import type { BuildCacheEntry } from './build-cache.js';
import { readBuildCache, sourceCacheKey, toHex } from './build-cache.js';

/**
 * SigV4 の署名対象サービス名。
 *
 * Bedrock と違い、ホスト名（`lambda.<region>.amazonaws.com`）と署名名が一致する。
 * それでも定数として置くのは、`src/bedrock.ts` が「ホスト名から導出しない」と決めた
 * 形をそろえるためである。
 */
const SIGNING_SERVICE = 'lambda';

/** Lambda の `Invoke` API の版（パスに現れる。日付であってリージョンではない）。 */
const LAMBDA_API_VERSION = '2015-03-31';

/**
 * ビルド関数のタイムアウト（秒）。**正本は `terraform/build-function.tf` である。**
 *
 * ここに写しがあるのは、Workers 側の待ち時間を「関数のタイムアウトより長く」決める
 * ためだけである。宣言を変えたらこの値も追随させること（`docs/build-invocation.md`）。
 */
export const BUILD_FUNCTION_TIMEOUT_SECONDS = 30;

/**
 * Workers 側で待つ上限（ミリ秒）。
 *
 * **関数のタイムアウトより長くする。** 短くすると、先に諦めるのは呼び出し側になり、
 *
 *   1. 関数はそのまま走り続けて課金される（4.6）。
 *   2. 返るのは中身の無い中断であって、**どの段で時間を食ったかが残らない**
 *      （関数側が返す `timings` も、AWS が返す `Task timed out` も届かない）。
 *
 * 逆に長くしておけば、時間切れは必ず関数側から**理由付きで**返る。この値が効くのは
 * 「関数の応答が返ってこない」（AWS 側の異常）ときだけで、そこは 3.8 の degrade が
 * 見たい事象そのものである。
 */
export const BUILD_INVOKE_TIMEOUT_MS = (BUILD_FUNCTION_TIMEOUT_SECONDS + 5) * 1000;

/**
 * ビルド関数を呼ぶために必須の秘密（`.dev.vars` / `wrangler pages secret`）。
 *
 * **不足を報告するときは名前だけを出す**（値は決して出さない）。`src/bedrock.ts` の
 * `BEDROCK_SECRET_NAMES` と同じ方針。
 *
 * `BUILD_AWS_SESSION_TOKEN` は**必須に入れない。** ローカルで SSO の一時資格情報を
 * 使うときだけ要り、本番の長命キーでは存在しない。
 *
 * `BUILD_FUNCTION_NAME` も入れない。**秘密ではなく構成**なので `wrangler.toml` の
 * `[vars]` が環境ごとに宣言する（`GENERATION_MODEL` と同じ扱い）。
 */
export const BUILD_SECRET_NAMES = [
  'BUILD_AWS_REGION',
  'BUILD_AWS_ACCESS_KEY_ID',
  'BUILD_AWS_SECRET_ACCESS_KEY',
] as const;

/** 署名に使う資格情報と、呼ぶ相手。 */
interface BuildCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** SSO の一時資格情報を使うときだけ入る。 */
  readonly sessionToken: string | undefined;
  readonly functionName: string;
}

/** 失敗の種別。**`kind` で分岐できる**ようにしてある（#20 は `'build'` だけを見る）。 */
export type BuildFailureKind = 'config' | 'build' | 'timeout' | 'function';

/**
 * ビルド経路の失敗の基底。
 *
 * 種別ごとに別の型を作ったうえで共通の基底を置くのは、**呼び出し側が
 * `instanceof` の連鎖を書かずに分岐できる**ようにするためである。#20 は
 * 「`kind === 'build'` なら再生成、それ以外は再生成しない」だけを判断すればよい。
 */
export abstract class BuildFailure extends Error {
  abstract readonly kind: BuildFailureKind;
}

/** 資格情報や宛先が揃っていない。**名前だけ**を持つ。 */
export class BuildNotConfigured extends BuildFailure {
  readonly kind = 'config';
  constructor(readonly missing: readonly string[]) {
    super(`ビルド関数の設定が揃っていません: ${missing.join(', ')}`);
    this.name = 'BuildNotConfigured';
  }
}

/**
 * 生成コードがコンパイルを通らなかった（3.3-5 の平常の結果）。
 *
 * **関数の障害ではない。** #20（自動リトライ）が受け取り、診断を添えて再生成する。
 *
 * **診断を `message` に入れない。** Go の診断は生成コードの行を引用するため、
 * `message` へ入れると 8.3 の検査を通っていない文字列がそのままログへ出る
 * （`src/generate.ts` の `describeGenerateError` は `name` しか出さないが、それは
 * この経路の呼び出し側が 1 つだけであることに依存しない設計にしておく）。
 * **#20 が読むのは {@link diagnostics} である。**
 */
export class BuildRejected extends BuildFailure {
  readonly kind = 'build';
  constructor(
    /** 関数が止まった段（`request` / `build` / `compress`）。 */
    readonly stage: string,
    /** Go の診断（最大 8 KiB で関数側が切り詰めてある）。**ログへ出さないこと。** */
    readonly diagnostics: string,
  ) {
    super(`生成コードのビルドに失敗しました（stage=${stage}）`);
    this.name = 'BuildRejected';
  }
}

/**
 * 時間内に終わらなかった。
 *
 * `where` は誰が打ち切ったかを表す。
 *
 * - `function`: 関数（またはその手前の Lambda プラットフォーム）が打ち切った。
 *   **想定される側。** 3.8 の 30 秒に対して、実測はコールドで 23.7 秒である。
 * - `worker`: Workers 側が {@link BUILD_INVOKE_TIMEOUT_MS} まで待っても応答が
 *   返らなかった。**関数のタイムアウトより長く待っているので、これは AWS 側の異常**
 *   （応答が失われた、スロットリングの滞留など）を意味する。
 */
export class BuildTimedOut extends BuildFailure {
  readonly kind = 'timeout';
  constructor(
    readonly where: 'function' | 'worker',
    /** Lambda のリクエスト ID。CloudWatch のログを引くのに使う。 */
    readonly requestId: string | null = null,
  ) {
    super(`ビルドが時間内に終わりませんでした（打ち切り: ${where}）`);
    this.name = 'BuildTimedOut';
  }
}

/**
 * 関数を呼べなかった、または関数が障害として失敗した（3.8 の degrade 判定の対象）。
 *
 * **本文（`errorMessage`）を持たない。** `src/bedrock.ts` の `BedrockCallFailed` と
 * 同じ理由で、関数の失敗本文には brotli の標準エラーなど外から来た文字列が混ざりうる。
 * 残すのは切り分けに足りるものだけにする。
 *
 * - `status`: HTTP の状態コード（Invoke は成功時 200。429 はスロットリング）。
 * - `awsErrorType`: `x-amzn-errortype`（`TooManyRequestsException` など）。
 * - `functionErrorType`: 応答本文の `errorType`（関数自身が投げた種別）。
 * - `requestId`: `x-amzn-RequestId`。**CloudWatch の該当ログへ辿る唯一の手掛かり。**
 */
export class BuildFunctionFailed extends BuildFailure {
  readonly kind = 'function';
  constructor(
    readonly status: number,
    readonly awsErrorType: string | null,
    readonly functionErrorType: string | null,
    readonly requestId: string | null,
  ) {
    super(
      `ビルド関数の呼び出しに失敗しました: HTTP ${status}` +
        `（${awsErrorType ?? functionErrorType ?? '種別不明'} / request-id: ${requestId ?? '不明'}）`,
    );
    this.name = 'BuildFunctionFailed';
  }
}

/**
 * 応答の形が想定と違う。
 *
 * **どの項目が読めなかったかだけ**を持つ。応答には成果物が入るので、例外へ入れない。
 */
export class BuildResponseUnreadable extends BuildFailure {
  readonly kind = 'function';
  constructor(readonly field: string) {
    super(`ビルド関数の応答を読めませんでした: ${field}`);
    this.name = 'BuildResponseUnreadable';
  }
}

/** 成果物 1 つ分の申告（関数の `Artifact` に対応）。 */
export interface ArtifactDigest {
  readonly bytes: number;
  readonly sha256: string;
}

/** 各段の所要時間（ミリ秒）。関数の `Timings` に対応する。 */
export interface BuildTimings {
  readonly resetMs: number;
  readonly prepareMs: number;
  readonly buildMs: number;
  readonly compressMs: number;
  readonly totalMs: number;
}

/** ビルドが成功したときの成果物の申告。 */
export interface BuiltArtifact {
  /** 未圧縮 wasm。**本体は返らない**（8〜12 MB あり同期応答の 6 MB を超える）。 */
  readonly wasm: ArtifactDigest;
  /** `.wasm.br`。3.4-1 が R2 のメタデータへ求める `contentEncoding` を含む。 */
  readonly compressed: ArtifactDigest & { readonly contentEncoding: string };
}

/** 関数が返した成功応答（読み取り済み）。 */
export interface BuildFunctionResult {
  readonly goVersion: string;
  readonly artifact: BuiltArtifact;
  /**
   * `.wasm.br` の本体。
   *
   * **`null` になりうる。** 3.3-6 は「関数が R2 へ直接書く」と定めており、
   * `compressed.data` は器の段階の暫定である（`docs/build-function.md`）。
   * 関数が R2 へ書くようになれば本体は返らなくなる。**その日にこちらが壊れないよう、
   * 不在を異常として扱わない。**
   */
  readonly compressedData: Uint8Array | null;
  readonly timings: BuildTimings;
  readonly requestId: string | null;
}

/** 3.3-5..7 の結果。**キャッシュヒットかどうかで持ち物が変わる。** */
export type BuildOutcome =
  | {
      readonly cached: true;
      readonly sourceSha256: string;
      readonly goVersion: string;
      readonly artifact: BuiltArtifact;
      /** 索引が指していた R2 のキー。#21 はこれを `games` 行へ写す。 */
      readonly entry: BuildCacheEntry;
    }
  | ({
      readonly cached: false;
      readonly sourceSha256: string;
    } & BuildFunctionResult);

/** 呼び出し側が外から受け取るもの。 */
export interface BuildDependencies {
  /**
   * 送信に使う `fetch`。
   *
   * **テストから差し替えるための継ぎ目（seam）。** 既定にすると単体テストが実 Lambda を
   * 要求し、**課金と 20 秒超の待ちが受け入れ条件に混ざる**（`src/bedrock.ts` と同じ）。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** Workers 側で待つ上限（ミリ秒）。既定は {@link BUILD_INVOKE_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

/**
 * 不足している設定の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingBuildSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  const missing = BUILD_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  // 宛先は秘密ではないが、**無ければ呼べない**のは同じである。同じ検査で一度に返す。
  const functionName = values['BUILD_FUNCTION_NAME'];
  if (typeof functionName !== 'string' || functionName.trim() === '') {
    return [...missing, 'BUILD_FUNCTION_NAME'];
  }
  return missing;
}

/**
 * env から資格情報と宛先を取り出す。
 *
 * @param env バインディングと環境変数
 * @returns 資格情報と関数名
 * @throws {BuildNotConfigured} 必須の値が欠けているとき
 */
function readBuildCredentials(env: Env): BuildCredentials {
  const missing = missingBuildSecrets(env);
  if (missing.length > 0) {
    throw new BuildNotConfigured(missing);
  }
  const values = env as unknown as Record<string, string | undefined>;
  const sessionToken = values['BUILD_AWS_SESSION_TOKEN'];
  return {
    region: values['BUILD_AWS_REGION']!.trim(),
    accessKeyId: values['BUILD_AWS_ACCESS_KEY_ID']!.trim(),
    secretAccessKey: values['BUILD_AWS_SECRET_ACCESS_KEY']!.trim(),
    // 空文字を渡すと `aws4fetch` が空の `X-Amz-Security-Token` を署名対象に含め、
    // 長命キーの署名が壊れる。**空は「無い」として扱う**（`src/bedrock.ts` と同じ）。
    sessionToken:
      typeof sessionToken === 'string' && sessionToken.trim() !== ''
        ? sessionToken.trim()
        : undefined,
    functionName: values['BUILD_FUNCTION_NAME']!.trim(),
  };
}

/**
 * `Invoke` のエンドポイントを組み立てる。
 *
 * **リージョンはホスト名に現れる。** 関数名は `encodeURIComponent` に通す（ARN や
 * 修飾子付きの綴りを指す構成があり、`:` と `/` を含みうる）。
 *
 * @param region リージョン
 * @param functionName 関数名（または ARN）
 * @returns エンドポイントの URL
 */
export function invokeEndpoint(region: string, functionName: string): string {
  return `https://lambda.${region}.amazonaws.com/${LAMBDA_API_VERSION}/functions/${encodeURIComponent(functionName)}/invocations`;
}

/**
 * ビルド関数を 1 回呼ぶ。**キャッシュを見ない**（見るのは {@link createLambdaBuild}）。
 *
 * @param env バインディングと環境変数
 * @param source ビルドする Go ソース
 * @param deps 外部依存
 * @returns 成功応答
 * @throws {BuildNotConfigured} 設定が欠けているとき
 * @throws {BuildRejected} 生成コードがコンパイルを通らないとき
 * @throws {BuildTimedOut} 時間内に終わらなかったとき
 * @throws {BuildFunctionFailed} 関数を呼べなかった・関数が障害として失敗したとき
 * @throws {BuildResponseUnreadable} 応答の形が想定と違うとき
 */
export async function invokeBuildFunction(
  env: Env,
  source: string,
  deps: BuildDependencies = {},
): Promise<BuildFunctionResult> {
  const credentials = readBuildCredentials(env);
  const send = deps.fetch ?? ((request: Request) => fetch(request));
  const timeoutMs = deps.timeoutMs ?? BUILD_INVOKE_TIMEOUT_MS;

  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: SIGNING_SERVICE,
    region: credentials.region,
  });

  // 打ち切りを自前の `AbortController` で持つ。**`AbortSignal.timeout` を使わないのは、
  // 「自分が打ち切った」ことを例外の綴りに頼らず判定するため**である（ランタイムが
  // 投げる中断の `name` は環境差があり、ネットワーク断と区別できない）。
  const controller = new AbortController();
  let abortedByUs = false;
  const timer = setTimeout(() => {
    abortedByUs = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    const signed = await aws.sign(invokeEndpoint(credentials.region, credentials.functionName), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 同期呼び出し（3.3-5）。既定値だが、**非同期へ変える判断は仕様側にある**ので
        // 明示して、変えるときに宣言が目に入るようにする。
        'x-amz-invocation-type': 'RequestResponse',
      },
      body: JSON.stringify({ source }),
      signal: controller.signal,
    });
    response = await send(signed);
  } catch (error) {
    if (abortedByUs) {
      throw new BuildTimedOut('worker');
    }
    // 送信そのものが失敗した（DNS・TLS・接続断）。**degrade の対象**なので、
    // 種別が読めなくても「関数のエラー」として返す。状態コードは持たない。
    throw new BuildFunctionFailed(0, describeSendError(error), null, null);
  } finally {
    clearTimeout(timer);
  }

  const requestId = response.headers.get('x-amzn-requestid');

  if (!response.ok) {
    // Invoke API そのものが失敗した（権限・関数不在・スロットリング）。
    throw new BuildFunctionFailed(
      response.status,
      await readAwsErrorType(response),
      null,
      requestId,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BuildResponseUnreadable('本文が JSON ではありません');
  }

  // **関数が例外で終わったかどうかは本文ではなくヘッダで判る。** Invoke は状態コード
  // 200 のまま `X-Amz-Function-Error` を立てる。ここを見落とすと、エラー本文を
  // 成功応答として読もうとして「形が違う」という誤った診断になる。
  if (response.headers.get('x-amz-function-error') !== null) {
    throw toFunctionFailure(payload, response.status, requestId);
  }

  return await readBuildResult(payload, requestId);
}

/**
 * 3.3-5..7 の段を作る（`GenerationPipeline['build']` に嵌まる形）。
 *
 * **キャッシュを先に見る**（3.8）。ヒットすれば関数を呼ばない。ミスなら関数を呼び、
 * **索引は書かない。** 成果物が R2 に入るのは #21（3.3-6）の仕事で、まだ存在しない
 * オブジェクトを指す索引を作らないためである。#21 は書き込みのあとで
 * `recordBuildCache` を呼ぶ（`src/build-cache.ts`）。
 *
 * **`src/generate.ts` への結線は本 issue では行わない**（#17 が同じ `defaultPipeline` を
 * 触るため。issue #19 の 2026-08-28 追記）。結線は後続の単独 PR で行う。
 *
 * @param deps 外部依存
 * @returns `GenerationPipeline['build']` に嵌まる関数
 */
export function createLambdaBuild(
  deps: BuildDependencies = {},
): (env: Env, generated: GenerationResult) => Promise<BuildOutcome> {
  return async (env: Env, generated: GenerationResult): Promise<BuildOutcome> => {
    const sourceSha256 = await sourceCacheKey(generated.source);

    const cached = await readBuildCache(env, sourceSha256);
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

    const built = await invokeBuildFunction(env, generated.source, deps);
    return { cached: false, sourceSha256, ...built };
  };
}

/**
 * 関数が障害として失敗したときの応答を、種別へ写す。
 *
 * **タイムアウトだけを分ける。** 3.8 の degrade はどちらでも発火するが、
 * 「時間が足りない」と「壊れている」は運用の打ち手が違う（前者はメモリ配分と
 * タイムアウトの見直し、後者はイメージとロールの確認）。
 *
 * 判定に使うのは 2 つの綴りである。
 *
 * - `Task timed out` … Lambda プラットフォームが打ち切ったときの定型文。
 * - `context deadline exceeded` … 関数が自分の deadline（プラットフォームの 500 ms
 *   手前）で打ち切ったときの Go の定型文（`docker/isolated-build/handler/main.go` の
 *   `deadlineMargin`）。**こちらが通常の経路**で、`timings` 付きの診断がログに残る。
 *
 * **綴りに頼る判定だが、外すと安全側に倒れる。** 見落とせば
 * {@link BuildFunctionFailed} になり、degrade の判定としては同じ扱いになる。
 *
 * @param payload 応答本文
 * @param status HTTP の状態コード
 * @param requestId Lambda のリクエスト ID
 * @returns 投げる例外
 */
function toFunctionFailure(
  payload: unknown,
  status: number,
  requestId: string | null,
): BuildFailure {
  const errorType = stringOrNull(pick(payload, 'errorType'));
  const errorMessage = stringOrNull(pick(payload, 'errorMessage')) ?? '';
  if (
    errorType === 'Sandbox.Timedout' ||
    errorMessage.includes('Task timed out') ||
    errorMessage.includes('context deadline exceeded')
  ) {
    return new BuildTimedOut('function', requestId);
  }
  return new BuildFunctionFailed(status, null, errorType, requestId);
}

/**
 * 成功応答（`ok` を持つ本文）を読む。
 *
 * `ok:false` は**関数の障害ではない**（生成コードの問題）。{@link BuildRejected} へ
 * 写して #20 へ渡す。
 *
 * @param payload 応答本文
 * @param requestId Lambda のリクエスト ID
 * @returns 成功応答
 * @throws {BuildRejected} `ok:false` で `stage` が読めたとき
 * @throws {BuildResponseUnreadable} 必要な項目が読めないとき
 */
export async function readBuildResult(
  payload: unknown,
  requestId: string | null = null,
): Promise<BuildFunctionResult> {
  const ok = pick(payload, 'ok');
  if (ok !== true) {
    if (ok !== false) {
      throw new BuildResponseUnreadable('ok');
    }
    const stage = stringOrNull(pick(payload, 'stage'));
    if (stage === null) {
      // **`'unknown'` で埋めない**（レビュー指摘 / #19）。埋めると、契約を満たして
      // いない応答が `kind='build'` として #20 へ渡る。#20 は診断を添えて再生成する
      // 段なので、**診断の無いビルド失敗を渡すと、手がかりの無いまま生成と課金を
      // もう一度起こす**（3.3-4 の費用計上はビルドより前にある）。しかも `stage` が
      // 無いので、どこで止まったのかも後から辿れない。
      //
      // `ok:false` なのに `stage` が無いのは**関数側の契約違反**であり、
      // `goVersion` や `compressed.contentEncoding` が欠けたときと同じ扱いにする。
      // `kind='function'` になり、#20 は再生成しない。
      throw new BuildResponseUnreadable('stage');
    }
    // **診断は空でも通す。** `stage` と違い、空であること自体は契約違反ではない
    // （関数が診断を持たずに落ちる段がある）。#20 は空を受け取れる。
    throw new BuildRejected(stage, stringOrNull(pick(payload, 'message')) ?? '');
  }

  const goVersion = stringOrNull(pick(payload, 'goVersion'));
  if (goVersion === null) {
    // 3.5 の `wasm_exec.js` 出し分けに要る値で、欠けたまま `games` 行を作ると
    // **配信できない作品**になる。0 や空文字で埋めない。
    throw new BuildResponseUnreadable('goVersion');
  }

  const wasm = readArtifact(pick(payload, 'wasm'), 'wasm');
  const compressedNode = pick(payload, 'compressed');
  const compressed = readArtifact(compressedNode, 'compressed');
  const contentEncoding = stringOrNull(pick(compressedNode, 'contentEncoding'));
  if (contentEncoding === null) {
    // 3.4-2: `Content-Encoding` を落とすと、圧縮は効いているのにストリーミングだけが
    // 黙って失われる。**関数が名前ごと決めている値**なので、欠けたら読めないとする。
    throw new BuildResponseUnreadable('compressed.contentEncoding');
  }

  const compressedData = decodeCompressedData(compressedNode);
  if (compressedData !== null) {
    if (compressedData.byteLength !== compressed.bytes) {
      throw new BuildResponseUnreadable('compressed.bytes');
    }
    if (!(await matchesDigest(compressedData, compressed.sha256))) {
      throw new BuildResponseUnreadable('compressed.sha256');
    }
  }

  return {
    goVersion,
    artifact: { wasm, compressed: { ...compressed, contentEncoding } },
    compressedData,
    timings: readTimings(pick(payload, 'timings')),
    requestId,
  };
}

/**
 * `.wasm.br` の本体（base64）を復号する。
 *
 * **不在は異常ではない**（{@link BuildFunctionResult.compressedData} の注記）。
 *
 * 復号したバイト列は呼び出し側で `bytes` と `sha256` の両方に突き合わせる。
 * **6 MB 上限に対して実測 2,282,980 bytes（q9。1.2.21）と余裕はあるが、本文が途中で
 * 切れても base64 は途中まで復号できてしまう。** 壊れた `.wasm.br` は R2 へ入るまで
 * 誰も気づかず、気づくのはプレイヤーである。関数が `sha256` を返しているのは、
 * まさにこの照合のためである。
 *
 * @param node 応答の `compressed` ノード
 * @returns 復号したバイト列（本体が無ければ null）
 * @throws {BuildResponseUnreadable} base64 として読めないとき
 */
function decodeCompressedData(node: unknown): Uint8Array | null {
  const data = stringOrNull(pick(node, 'data'));
  if (data === null || data === '') {
    return null;
  }
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new BuildResponseUnreadable('compressed.data');
  }
}

/**
 * 成果物の申告（`bytes` / `sha256`）を読む。
 *
 * @param node 応答のノード
 * @param field 診断に出す項目名
 * @returns 申告値
 * @throws {BuildResponseUnreadable} 読めないとき
 */
function readArtifact(node: unknown, field: string): ArtifactDigest {
  const bytes = pick(node, 'bytes');
  const sha256 = stringOrNull(pick(node, 'sha256'));
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || sha256 === null) {
    throw new BuildResponseUnreadable(`${field}.bytes / ${field}.sha256`);
  }
  return { bytes, sha256 };
}

/**
 * `timings` を読む。
 *
 * **欠けても例外にしない。** 3.8 の「どの段が食っているか」を読むための計測値であり、
 * これが無いことを理由に成果物を捨てるのは割に合わない。読めない項目は 0 にする。
 *
 * @param node 応答の `timings` ノード
 * @returns 各段の所要時間
 */
function readTimings(node: unknown): BuildTimings {
  return {
    resetMs: numberOr(pick(node, 'resetMs'), 0),
    prepareMs: numberOr(pick(node, 'prepareMs'), 0),
    buildMs: numberOr(pick(node, 'buildMs'), 0),
    compressMs: numberOr(pick(node, 'compressMs'), 0),
    totalMs: numberOr(pick(node, 'totalMs'), 0),
  };
}

/**
 * 復号した `.wasm.br` が申告どおりの内容かを確かめる。
 *
 * @param data 復号したバイト列
 * @param expectedSha256 申告された SHA-256（小文字 16 進）
 * @returns 一致したかどうか
 */
async function matchesDigest(data: Uint8Array, expectedSha256: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(digest)) === expectedSha256.toLowerCase();
}

/**
 * 失敗応答から AWS のエラー種別だけを取り出す。
 *
 * **本文（`message`）は読み捨てる**（`src/bedrock.ts` の `readAwsErrorType` と同じ）。
 *
 * @param response 失敗した応答
 * @returns エラー種別（読めなければ null）
 */
async function readAwsErrorType(response: Response): Promise<string | null> {
  const header = response.headers.get('x-amzn-errortype');
  if (header !== null && header !== '') {
    // `Type:https://...` の形で返ることがあるので、種別名だけにする。
    return header.split(':')[0]!.split('#').pop() ?? null;
  }
  try {
    const type = pick(await response.json(), '__type');
    return typeof type === 'string' ? (type.split('#').pop() ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * 送信そのものが失敗したときに、ログへ出してよい 1 行を作る。
 *
 * **`message` を出さない**（宛先や資格情報の断片が混ざる経路を作らない）。
 *
 * @param error catch した値
 * @returns 例外の種類だけ
 */
function describeSendError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * オブジェクトから項目を取り出す（`null` / 非オブジェクトは `undefined`）。
 *
 * @param value 対象
 * @param key 項目名
 * @returns 値
 */
function pick(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * 文字列ならそのまま、それ以外は `null`。
 *
 * @param value 対象
 * @returns 文字列または null
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 有限の数値ならそのまま、それ以外は既定値。
 *
 * @param value 対象
 * @param fallback 既定値
 * @returns 数値
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
