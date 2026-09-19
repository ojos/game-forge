/**
 * MCP の認可サーバー（#696 / M19-1 / 仕様 5.15）。**`@cloudflare/workers-oauth-provider` をアプリのホストに載せる。**
 *
 * ## 部品が持つ口と、アプリが持つ口
 *
 * | 口 | 持ち主 |
 * |---|---|
 * | `/.well-known/oauth-authorization-server`（RFC 8414）・`/.well-known/oauth-protected-resource`（RFC 9728。`/mcp` 付きの形も） | 部品 |
 * | `/token`（発行・refresh の入れ替え・失効）・`/register`（DCR） | 部品 |
 * | `/mcp`（トークンを検証してから {@link mcpPlaceholderHandler} へ渡す） | 部品 → アプリ |
 * | `/authorize`（同意画面）・`/account/apps`（接続の解除） | **アプリの経路表**（`src/oauth-authorize.ts` / `src/account-apps.ts`） |
 *
 * **振り分けは `src/index.ts` のアプリのホストの枝で行う**（{@link isOAuthProviderPath}）。部品の `fetch` に
 * すべての要求を通す形（部品の既定の使い方）は採らない——アプリの経路表の全画面が部品の分岐を 1 段くぐることになり、
 * 部品の版を上げた日に、画面まで挙動が変わりうる。**sandbox と admin のホストには載せない**（あちらの枝は部品を呼ばない）。
 *
 * ## 決めた値（仕様 5.15 の決定）
 *
 * - scope は `works:read` と `works:generate`（`src/oauth-paths.ts`）
 * - アクセストークン 1 時間・リフレッシュトークン 30 日（refresh のたびに入れ替わる。部品の既定の挙動）。**30 日は同意から数え、
 *   使っていても延びない**（`src/oauth-paths.ts` の `REFRESH_TOKEN_TTL_SECONDS`）
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
import { OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { isOAuthUserActive } from './oauth-user.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_PATH,
  MCP_PATH,
  OAUTH_PROVIDER_PATHS,
  OAUTH_SCOPES,
  PROTECTED_RESOURCE_METADATA_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  REGISTER_PATH,
  TOKEN_PATH,
} from './oauth-paths.js';
import { normalizeHost } from './origins.js';

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
 * 同意のときに許可（grant）へ残す情報（部品の `metadata`。**暗号化されない**）。
 *
 * 「接続中のアプリ」のタブ（`src/account-apps.ts`）が読む。**DCR のクライアントは 90 日で消える**（部品の既定）ので、
 * アプリ名はクライアントの登録からではなく、同意のときの値をここへ写しておく。
 */
export interface OAuthGrantMetadata {
  /** 同意画面に出したアプリ名。 */
  readonly clientName: string;
  /** 戻り先のホスト名（同意画面に出したもの）。 */
  readonly redirectHost: string;
}

/** 1 回の要求で解除する許可の上限（退会のとき。KV の list 1 回の既定の上限と同じ）。 */
const GRANT_PAGE_SIZE = 100;

/**
 * 部品へ渡す設定を組み立てる。
 *
 * @param origin アプリのホストの origin（`https://app.game-forge.ojos.jp`）
 * @returns 設定
 */
function providerOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: mcpPlaceholderHandler },
    // **ここへは届かない**（`src/index.ts` は部品の口だけをここへ渡す）。届いたら 404 にする。
    defaultHandler: {
      fetch: () => jsonResponse({ error: 'not-found' }, 404),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
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
    tokenExchangeCallback,
  };
}

/**
 * トークンを発行するたびに、アクセストークンの props へそのトークンの scope を足す。
 *
 * **許可（grant）の props は変えない**（`newProps` を返さない）。refresh でクライアントが scope を狭めたときにも、
 * そのトークンの scope（`requestedScope`）が載る。
 *
 * @param options 部品が渡す値
 * @param options.requestedScope このトークンに付く scope
 * @param options.props 許可の props
 * @returns アクセストークンの props
 */
function tokenExchangeCallback(options: { requestedScope: string[]; props: unknown }): {
  accessTokenProps: OAuthTokenProps;
} {
  const props = options.props as { userId?: unknown } | null;
  return {
    accessTokenProps: {
      userId: typeof props?.userId === 'string' ? props.userId : '',
      scope: [...options.requestedScope],
    },
  };
}

/** origin ごとに組んだ部品（組むのは要求ごとでも安いが、設定の検査を毎回走らせない）。 */
const providers = new Map<string, OAuthProvider<Env>>();

/**
 * origin に対応する部品を返す。
 *
 * @param origin アプリのホストの origin
 * @returns 部品
 */
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (provider === undefined) {
    provider = new OAuthProvider<Env>(providerOptions(origin));
    providers.set(origin, provider);
  }
  return provider;
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
  return getOAuthApi(providerOptions(origin), env);
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
 * オブジェクトを書き換えさせない。
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
  const origin = new URL(request.url).origin;
  return await providerFor(origin).fetch(request, { ...env }, ctx);
}

/**
 * MCP の口の仮の処理（#696 PR①）。**部品がトークンを検証した後にだけ呼ばれる。**
 *
 * PR② で MCP サーバー（道具 6 本）に差し替える。それまでは次だけを行い、404 を返す。
 *
 * 1. **Origin を確かめる**（MCP の仕様の DNS rebinding の対策）。`Origin` が付いていれば、ホスト名が
 *    アプリのホスト（`APP_HOST`。本番・プレビューとも `app.game-forge.ojos.jp`）と一致するときだけ通す。
 *    付いていない要求（ブラウザでないクライアント）は通す
 * 2. **トークンの利用者が今も操作してよいか**（BAN・退会。{@link isOAuthUserActive}）。だめなら 401
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param ctx 実行文脈（`ctx.props` にトークンの props が載っている）
 * @returns レスポンス
 */
async function mcpPlaceholderHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAllowedMcpOrigin(request.headers.get('origin'), env)) {
    return jsonResponse({ error: 'forbidden-origin' }, 403);
  }
  const props = (ctx as unknown as { props?: Partial<OAuthTokenProps> }).props;
  if (!(await isOAuthUserActive(env.DB, props?.userId))) {
    const url = new URL(request.url);
    return jsonResponse({ error: 'invalid_token' }, 401, {
      'www-authenticate': `Bearer error="invalid_token", resource_metadata="${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}"`,
    });
  }
  return jsonResponse({ error: 'not-found' }, 404);
}

/**
 * MCP の口へ来た要求の `Origin` を許すか（DNS rebinding の対策）。
 *
 * **許すのはアプリのホストだけ**（`APP_HOST`。ポートは問わない——ローカルは `:8787` で動く）。`Origin` が無い要求は
 * 許す（MCP のクライアントの多くはブラウザではなく、`Origin` を付けない）。読めない `Origin`（`null` を含む）は拒む。
 *
 * @param origin `Origin` ヘッダの値
 * @param env バインディングと環境変数
 * @returns 許すなら true
 */
export function isAllowedMcpOrigin(origin: string | null, env: Env): boolean {
  if (origin === null) {
    return true;
  }
  const appHost: unknown = env.APP_HOST;
  if (typeof appHost !== 'string' || appHost.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && normalizeHost(parsed.hostname) === normalizeHost(appHost);
  } catch {
    return false;
  }
}

/**
 * 利用者の許可（MCP の接続）をすべて消す（退会のとき。仕様 5.15「退会」）。
 *
 * 許可を消すと、その許可から出たアクセストークンとリフレッシュトークンもすべて無効になる（部品の `revokeGrant`）。
 *
 * @param env バインディングと環境変数
 * @param origin アプリのホストの origin
 * @param userId 利用者の id
 * @returns 消した許可の数
 */
export async function revokeAllOAuthGrants(env: Env, origin: string, userId: string): Promise<number> {
  const helpers = oauthHelpers(env, origin);
  let revoked = 0;
  // **一覧を 1 周してから消す**——消しながら cursor で送ると、KV の list の結果がずれうる。
  const grantIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { limit: GRANT_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
    for (const grant of page.items) {
      grantIds.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (const grantId of grantIds) {
    await helpers.revokeGrant(grantId, userId);
    revoked += 1;
  }
  return revoked;
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
