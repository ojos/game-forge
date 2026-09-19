/**
 * MCP の認可サーバー（#696 / M19-1 / 仕様 5.15）。**`@cloudflare/workers-oauth-provider` をアプリのホストに載せる。**
 *
 * ## 部品が持つ口と、アプリが持つ口
 *
 * | 口 | 持ち主 |
 * |---|---|
 * | `/.well-known/oauth-authorization-server`（RFC 8414）・`/.well-known/oauth-protected-resource`（RFC 9728。`/mcp` 付きの形も） | 部品 |
 * | `/token`（発行・refresh の入れ替え・失効）・`/register`（DCR） | 部品 |
 * | `/mcp`（トークンを検証してから `src/mcp-server.ts` の `handleMcpRequest` へ渡す） | 部品 → アプリ |
 * | `/authorize`（同意画面）・`/account/apps`（接続の解除） | **アプリの経路表**（`src/oauth-authorize.ts` / `src/account-apps.ts`） |
 *
 * **振り分けは `src/index.ts` のアプリのホストの枝で行う**（{@link isOAuthProviderPath}）。部品の `fetch` に
 * すべての要求を通す形（部品の既定の使い方）は採らない——アプリの経路表の全画面が部品の分岐を 1 段くぐることになり、
 * 部品の版を上げた日に、画面まで挙動が変わりうる。**sandbox と admin のホストには載せない**（あちらの枝は部品を呼ばない）。
 *
 * ## 決めた値（仕様 5.15 の決定）
 *
 * - scope は `works:read` と `works:generate`（`src/oauth-paths.ts`）
 * - アクセストークン 1 時間。リフレッシュトークンは refresh のたびに入れ替わる（部品の既定の挙動）。**最後に使ってから 30 日で
 *   切れ、使い続けても同意から 1 年で切れる**（`src/oauth-paths.ts` の `GRANT_IDLE_LIMIT_SECONDS` と `GRANT_MAX_AGE_SECONDS`）。
 *   1 年は部品の期限（`refreshTokenTTL`）、30 日の無活動は {@link tokenExchangeCallback} がこちらで判定する
 * - PKCE は S256 だけ（`allowPlainPKCE: false`）。implicit と token exchange は許さない
 * - CIMD と DCR の両方を受ける（CIMD は `global_fetch_strictly_public` の互換フラグが要る。`wrangler.toml`）
 * - **口（resource）を `https://<アプリのホスト>/mcp` に固定する**（`resourceMetadata.resource`）。発行する
 *   トークンの audience はこの 1 つに縛られ、`/api/*` など別の口では受けない（RFC 8707）。
 *
 * ## ホストの綴りは要求から取る
 *
 * 部品のメタデータ（issuer・各口の URL）は要求の origin から組まれる。resource も同じ origin から組む
 * （`src/index.ts` が `APP_HOST` と一致したホストだけをここへ渡すので、origin はアプリのホストに限られる。
 * ローカルの `https://game-forge.localtest.me:8787` のようにポートが付く形も、そのまま一貫する）。
 */
import type { OAuthHelpers, OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { GrantType, OAuthError, OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { grantHelpers, revokeAllUserGrants } from './oauth-grants.js';
import { handleMcpRequest } from './mcp-server.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_PATH,
  MCP_PATH,
  OAUTH_PROVIDER_PATHS,
  OAUTH_SCOPES,
  PROTECTED_RESOURCE_METADATA_PATH,
  GRANT_IDLE_LIMIT_SECONDS,
  GRANT_MAX_AGE_SECONDS,
  REGISTER_PATH,
  TOKEN_PATH,
} from './oauth-paths.js';
import { REGISTER_MAX_BODY_BYTES, guardRegistration } from './oauth-guard.js';
import { readLimitedText } from './routes.js';

/**
 * トークンに載る利用者の情報（部品の `props`）。**利用者の id だけ**を載せ、Google のトークンや
 * メールアドレスは載せない（token passthrough の禁止。仕様 5.15）。
 *
 * - 許可（grant）の props は `{ userId }`（同意画面の `completeAuthorization` が渡す）
 * - アクセストークンの props は、それに **そのトークンの scope** を足したもの（{@link tokenExchangeCallback}）。
 *   MCP の道具（#696 PR②）が `insufficient_scope` を判定するのに使う
 */
export interface OAuthTokenProps {
  readonly userId: string;
  readonly scope?: readonly string[];
}

/**
 * 許可（grant）の props。**暗号化して保存される**（部品。鍵はリフレッシュトークンでしか解けない）。
 *
 * - `userId` … 同意画面の `completeAuthorization` が入れる
 * - `lastUsedAt` … 最後にトークンを発行・refresh した時刻（UNIX 秒）。code の交換で入れ、refresh のたびに更新する
 *   （{@link tokenExchangeCallback}）。**30 日の無活動の判定に使う**
 */
export interface OAuthGrantProps {
  readonly userId: string;
  readonly lastUsedAt?: number;
}

/**
 * 同意のときに許可（grant）へ残す情報（部品の `metadata`。**暗号化されない**）。
 *
 * 「接続中のアプリ」のタブ（`src/account-apps.ts`）が読む。**DCR のクライアントは 1 年で消え、同意の時点の名前と変わりうる**ので、
 * アプリ名はクライアントの登録からではなく、同意のときの値をここへ写しておく。
 */
export interface OAuthGrantMetadata {
  /** 同意画面に出したアプリ名。 */
  readonly clientName: string;
  /** 戻り先のホスト名（同意画面に出したもの）。 */
  readonly redirectHost: string;
}

/**
 * 部品へ渡す設定を組み立てる。
 *
 * @param origin アプリのホストの origin（`https://app.game-forge.ojos.jp`）
 * @param env バインディングと環境変数（無活動で切った許可を消すのに使う）
 * @returns 設定
 */
function providerOptions(origin: string, env: Env): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_PATH,
    // **MCP サーバー本体**（#696 PR②）。部品がトークンを検証し、props を `ctx.props` に置いてから呼ぶ。
    apiHandler: { fetch: (request, handlerEnv, ctx) => handleMcpRequest(request, handlerEnv, ctx) },
    // **ここへは届かない**（`src/index.ts` は部品の口だけをここへ渡す）。届いたら 404 にする。
    defaultHandler: {
      fetch: () => jsonResponse({ error: 'not-found' }, 404),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: GRANT_MAX_AGE_SECONDS,
    // **DCR のクライアントの寿命を許可の上限と揃える**（部品の既定は 90 日）。refresh のたびに部品はクライアントを引き直し
    // （`parseTokenEndpointRequest` → `getClient`）、消えていれば `invalid_client` で断る。90 日のままだと、DCR で登録した
    // 接続は使い続けても 90 日目に切れる。**短くはできない**（同じ理由で、許可より先にクライアントが消える）。
    clientRegistrationTTL: GRANT_MAX_AGE_SECONDS,
    scopesSupported: [...OAUTH_SCOPES],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}${MCP_PATH}`,
      scopes_supported: [...OAUTH_SCOPES],
      resource_name: 'Game Forge',
    },
    tokenExchangeCallback: (options) => tokenExchangeCallback(options, env, origin),
  };
}

/**
 * トークンを発行するたびに呼ばれる（部品の `tokenExchangeCallback`）。**3 つのことをする。**
 *
 * 1. **refresh のとき、最後に使ってから {@link GRANT_IDLE_LIMIT_SECONDS} 秒を超えていたら断る**（利用者の決定。使うたびに延びる
 *    30 日）。部品の `OAuthError('invalid_grant')` を投げると、部品がそのまま token のエンドポイントの 400 `invalid_grant` にする
 *    （0.10.3 の `handleTokenRequest` → `createOAuthErrorResponse`。何も書かない）。**断った許可はその場で消す**（ベストエフォート）——
 *    二度と使えない記録を 1 年の期限まで KV に残さない。`lastUsedAt` を持たない許可（この変更より前の形）は同意の時刻で見る
 * 2. 断らなければ、**許可の props の `lastUsedAt` を今に更新した新しい props を返す**（`newProps`）。code の交換のときも同じく今を入れる。
 *    部品は refresh のたびに許可の記録を書き直しているので（リフレッシュトークンの入れ替え）、**KV の書き込みは増えない**
 * 3. **アクセストークンの props には、そのトークンの scope を足す**（`accessTokenProps`。PR② が `insufficient_scope` の判定に使う）。
 *    refresh でクライアントが scope を狭めたときにも、そのトークンの scope（`requestedScope`）が載る
 *
 * @param options 部品が渡す値
 * @param env バインディングと環境変数
 * @param origin アプリのホストの origin
 * @returns 許可とアクセストークンの props
 * @throws OAuthError 無活動で切れた許可を refresh しようとしたとき（`invalid_grant`）
 */
export async function tokenExchangeCallback(
  options: {
    grantType: GrantType | string;
    userId: string;
    grantId: string;
    requestedScope: string[];
    props: unknown;
  },
  env: Env,
  origin: string,
): Promise<{ newProps: OAuthGrantProps; accessTokenProps: OAuthTokenProps } | undefined> {
  if (options.grantType !== GrantType.AUTHORIZATION_CODE && options.grantType !== GrantType.REFRESH_TOKEN) {
    // token exchange と EMA は許していない（設定で閉じている）。来ても props を変えない。
    return undefined;
  }
  const props = options.props as { userId?: unknown; lastUsedAt?: unknown } | null;
  const userId = typeof props?.userId === 'string' ? props.userId : '';
  const now = Math.floor(Date.now() / 1000);
  if (options.grantType === GrantType.REFRESH_TOKEN) {
    const lastUsedAt = typeof props?.lastUsedAt === 'number' ? props.lastUsedAt : await grantCreatedAt(env, options);
    if (lastUsedAt === null || now - lastUsedAt > GRANT_IDLE_LIMIT_SECONDS) {
      try {
        await grantHelpers(env.OAUTH_KV).revokeGrant(options.grantId, options.userId);
      } catch (error) {
        console.error(
          `[oauth-provider] 無活動で切れた許可を消せませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      throw new OAuthError('invalid_grant', { description: 'Grant expired due to inactivity' });
    }
  }
  return {
    newProps: { userId, lastUsedAt: now },
    accessTokenProps: { userId, scope: [...options.requestedScope] },
  };
}

/**
 * `lastUsedAt` を持たない許可の、同意の時刻を読む（KV の読み取り 1。書き込みはしない）。
 *
 * @param env バインディングと環境変数
 * @param options 利用者と許可の id
 * @param options.userId 利用者の id
 * @param options.grantId 許可の id
 * @returns 同意の時刻（UNIX 秒）。読めなければ null（断る側に倒す）
 */
async function grantCreatedAt(
  env: Env,
  options: { readonly userId: string; readonly grantId: string },
): Promise<number | null> {
  const grant = await env.OAUTH_KV.get<{ createdAt?: unknown }>(`grant:${options.userId}:${options.grantId}`, 'json');
  return typeof grant?.createdAt === 'number' ? grant.createdAt : null;
}

/**
 * アプリの画面から部品の操作（要求の検証・同意の完了・許可の一覧と解除）を呼ぶための道具を返す。
 *
 * **部品の `fetch` を通さずに呼べる**（`getOAuthApi`）。同意画面と「接続中のアプリ」のタブはアプリの経路表に
 * 置くので、部品が `env.OAUTH_PROVIDER` を差し込む経路を通らない。
 *
 * @param env バインディングと環境変数
 * @param origin アプリのホストの origin（要求の URL から取る）
 * @returns 部品の操作
 */
export function oauthHelpers(env: Env, origin: string): OAuthHelpers {
  return getOAuthApi(providerOptions(origin, env), env);
}

/**
 * パスが部品へ渡す口かどうか（`src/index.ts` の振り分け）。
 *
 * **`/mcp` は完全一致と `/mcp/` の下だけ**を渡す（部品の API の判定は前方一致なので、`/mcpx` も API として
 * 扱ってしまう。そちらはアプリの経路表の 404 へ落とす）。`/.well-known/oauth-protected-resource` は、
 * RFC 9728 の「口のパスを後ろに付けた形」（`/mcp` 付き）も部品へ渡す。
 *
 * @param pathname 要求のパス
 * @returns 部品へ渡すなら true
 */
export function isOAuthProviderPath(pathname: string): boolean {
  if (pathname === MCP_PATH || pathname.startsWith(`${MCP_PATH}/`)) {
    return true;
  }
  if (pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PATH}/`)) {
    return true;
  }
  return OAUTH_PROVIDER_PATHS.includes(pathname);
}

/**
 * 部品の口への要求を処理する（`src/index.ts` のアプリのホストの枝から呼ぶ）。
 *
 * **env は写してから渡す**——部品は `env.OAUTH_PROVIDER` を代入するので、Pages が渡した env の
 * オブジェクトを書き換えさせない。**部品は要求ごとに組む**——`tokenExchangeCallback` がその要求の env（無活動の許可を消す KV）を
 * 閉じ込めるので、組んだ部品を要求をまたいで使い回さない。組むのは設定の検査だけで、KV も fetch も触らない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param ctx 実行文脈（部品が `ctx.props` に利用者の情報を置く。無いと 500 になる）
 * @returns レスポンス
 */
export async function handleOAuthProviderRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  let forwarded = request;
  if (url.pathname === REGISTER_PATH && request.method === 'POST') {
    const checked = await checkRegistration(request, env);
    if (checked instanceof Response) {
      return checked;
    }
    forwarded = checked;
  }
  const copied = { ...env };
  return await new OAuthProvider<Env>(providerOptions(url.origin, copied)).fetch(forwarded, copied, ctx);
}

/**
 * DCR（`POST /register`）を部品へ渡す前に受ける（#696 のセキュリティレビューの中-1）。
 *
 * 部品の DCR は認証も件数の制限も持たず、1 回ごとに KV へ 1 件書く（本文 1 MiB まで）。KV の書き込みの無料枠は
 * 1 日 1,000 回で全員が共有するので、**ログインしていない人が約 1,000 回叩くと、全員の同意・code の交換・refresh が止まる。**
 *
 * 1. **本文を 8 KB で切る**（`src/oauth-guard.ts` の `REGISTER_MAX_BODY_BYTES`）。超えたら **413** と
 *    `{"error":"invalid_client_metadata"}`。RFC 7591 の誤りの形（`error` の値）に揃えつつ、ステータスは大きさの誤りだと分かる
 *    413 にした（400 にすると、クライアントが中身の誤りと読んで直しに行く）。`Content-Length` が上限を超えていれば本文を読まずに断る
 * 2. **IP ごとの短い窓と、全体の 1 日の総量**（`guardRegistration`）。超えたら 429 と `Retry-After`。数えられなければ 503
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 部品へ渡すリクエスト（本文を読み直した形）、または断りの応答
 */
async function checkRegistration(request: Request, env: Env): Promise<Request | Response> {
  const tooLarge = (): Response =>
    jsonResponse({ error: 'invalid_client_metadata', error_description: 'Registration request is too large' }, 413);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > REGISTER_MAX_BODY_BYTES) {
    return tooLarge();
  }
  const read = await readLimitedText(request, REGISTER_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === 'body-too-large'
      ? tooLarge()
      : jsonResponse({ error: 'invalid_client_metadata', error_description: 'Unreadable request body' }, 400);
  }
  const verdict = await guardRegistration(env, request.headers.get('cf-connecting-ip'), Math.floor(Date.now() / 1000));
  if (verdict === 'rate-limited') {
    return jsonResponse({ error: 'rate-limited' }, 429, { 'retry-after': '60' });
  }
  if (verdict === 'unavailable') {
    return jsonResponse({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '60' });
  }
  return new Request(request, { body: read.text });
}

/**
 * 利用者の許可（MCP の接続）をすべて消す（退会のとき。仕様 5.15「退会」）。中身は `src/oauth-grants.ts`（cleanup の Worker と共有）。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @returns 消した許可の数
 */
export async function revokeAllOAuthGrants(env: Pick<Env, 'OAUTH_KV'>, userId: string): Promise<number> {
  return await revokeAllUserGrants(env.OAUTH_KV, userId);
}

/**
 * JSON の応答を組み立てる（`src/routes.ts` の `json` と同じヘッダ。部品の設定のモジュールに経路表の依存を
 * 持ち込まないために、ここで組む）。
 *
 * @param body 本文
 * @param status ステータス
 * @param headers 追加のヘッダ
 * @returns レスポンス
 */
function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
