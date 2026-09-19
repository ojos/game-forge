import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { appReservedHandles } from '../src/app.js';
import { ACCOUNT_APPS_PATH, ACCOUNT_APPS_REVOKE_API_PATH, ACCOUNT_WITHDRAW_API_PATH } from '../src/account-paths.js';
import { LOGIN_PATH, OAUTH_COOKIE } from '../src/auth/google.js';
import {
  CONSENT_DECISION_FIELD,
  CONSENT_SCOPE_FIELD,
  CONSENT_TOKEN_FIELD,
  DECISION_APPROVE,
  DECISION_DENY,
  describeRedirect,
  offeredScopes,
  signConsentToken,
  signPendingAuthorization,
  verifyPendingAuthorization,
} from '../src/oauth-authorize.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_PATH,
  AUTHORIZE_RESUME_PATH,
  OAUTH_SCOPES,
  PENDING_AUTHORIZATION_COOKIE,
  SCOPE_WORKS_GENERATE,
  SCOPE_WORKS_READ,
} from '../src/oauth-paths.js';
import { isOAuthProviderPath, oauthHelpers } from '../src/oauth-provider.js';
import { isOAuthUserActive } from '../src/oauth-user.js';
import { resolveSessionUser } from '../src/session-user.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * MCP の認可の土台（#696 PR① / 仕様 5.15）。
 *
 * **フロー全体を、本番と同じ入口（`src/index.ts` の既定の輸出）から通す。** 部品（`@cloudflare/workers-oauth-provider`）の
 * 口と、アプリの経路表の口（同意画面・接続中のアプリ・退会）が、同じホストの上で噛み合うことを見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-oauth-foundation-0001';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:9999/callback';
const WEB_REDIRECT = 'https://client.example.com/oauth/callback';

/** KV の操作の記録（{@link countingKV}）。 */
interface KvOp {
  readonly op: 'get' | 'put' | 'delete' | 'list';
  readonly key: string;
}

/** いま数えている KV の操作（null なら数えない）。 */
let kvOps: KvOp[] | null = null;

/**
 * KV の操作を数える包み。**書き込み（put / delete）と list の回数を実測する**（仕様 5.15「KV の書き込みの見込み」）。
 *
 * @param kv 元の KV
 * @returns 包んだ KV
 */
function countingKV(kv: KVNamespace): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'get' || prop === 'put' || prop === 'delete' || prop === 'list') {
        return (...args: unknown[]) => {
          const first = args[0];
          const key =
            typeof first === 'string' ? first : JSON.stringify((first as { prefix?: string } | undefined)?.prefix ?? '');
          kvOps?.push({ op: prop, key: key.split(':')[0] ?? '' });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * セッションの秘密を差し替え、KV を数える包みを被せた env。
 *
 * @returns env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET, OAUTH_KV: countingKV(env.OAUTH_KV) } as unknown as Env;
}

/**
 * 本番と同じ入口へ要求を渡す。
 *
 * @param method メソッド
 * @param pathOrUrl パス（または絶対 URL）
 * @param init ヘッダと本文
 * @returns 応答
 */
async function call(
  method: string,
  pathOrUrl: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${APP_ORIGIN}${pathOrUrl}`;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(url, { method, headers: init.headers ?? {}, body: init.body, redirect: 'manual' }),
    testEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * 利用者を 1 人作る。
 *
 * @param state BAN・退会を始めたか
 * @returns id と cookie（`Cookie` ヘッダの形）
 */
async function seedUser(
  state: 'active' | 'banned' | 'withdrawing' = 'active',
): Promise<{ readonly id: string; readonly cookie: string }> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, banned_at, withdrawal_started_at)
     values (?, ?, ?, 'MCP の人', 100, ?, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, state === 'banned' ? now : null, state === 'withdrawing' ? now - 60 : null)
    .run();
  const token = await signSession({ userId: id, issuedAt: now, expiresAt: now + 3600 }, SECRET);
  return { id, cookie: buildSessionCookie(token, 3600).split(';')[0]! };
}

/**
 * DCR でクライアントを登録する。
 *
 * @param redirectUri 戻り先
 * @param name アプリ名
 * @returns client_id
 */
async function register(redirectUri: string = LOOPBACK_REDIRECT, name = 'Test MCP Client'): Promise<string> {
  const response = await call('POST', '/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/**
 * PKCE の検証子と challenge（S256）。
 *
 * @returns 2 つの値
 */
async function pkce(): Promise<{ readonly verifier: string; readonly challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
}

/**
 * base64url（パディングなし）。
 *
 * @param bytes バイト列
 * @returns 文字列
 */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * 認可の要求の URL（パスと query）を組む。
 *
 * @param clientId client_id
 * @param challenge PKCE の challenge
 * @param options 戻り先・scope・state
 * @returns `/authorize?…`
 */
function authorizePath(
  clientId: string,
  challenge: string,
  options: { readonly redirectUri?: string; readonly scope?: string; readonly state?: string } = {},
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri ?? LOOPBACK_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: options.state ?? 'state-123',
    resource: `${APP_ORIGIN}/mcp`,
  });
  if (options.scope !== undefined) {
    params.set('scope', options.scope);
  }
  return `${AUTHORIZE_PATH}?${params.toString()}`;
}

/**
 * 同意画面から、フォームの送り先と同意の値を取り出す。
 *
 * @param body HTML
 * @returns 送り先と値
 */
function consentFormOf(body: string): { readonly action: string; readonly token: string } {
  // ヘッダのログアウトのフォームと取り違えない（同意のフォームは `/authorize?` へ送る）。
  const action = /<form method="post" action="(\/authorize\?[^"]+)">/u.exec(body)?.[1];
  const token = new RegExp(`name="${CONSENT_TOKEN_FIELD}" value="([^"]+)"`, 'u').exec(body)?.[1];
  expect(action, '同意画面にフォームが無い').toBeDefined();
  expect(token, '同意画面に同意の値が無い').toBeDefined();
  return { action: action!.replaceAll('&amp;', '&'), token: token! };
}

/**
 * 同意を POST する。
 *
 * @param action 送り先
 * @param cookie cookie
 * @param fields 項目
 * @returns 応答
 */
async function postConsent(
  action: string,
  cookie: string,
  fields: readonly (readonly [string, string])[],
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of fields) {
    body.append(name, value);
  }
  return await call('POST', action, {
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/** 接続の一式（許可→code→トークン）を済ませた結果。 */
interface Connected {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scope: string;
}

/**
 * 登録→同意→code→トークンを 1 回通す。
 *
 * @param cookie 利用者の cookie
 * @param scopes 同意画面で選ぶ scope
 * @returns トークン
 */
async function connect(cookie: string, scopes: readonly string[] = OAUTH_SCOPES): Promise<Connected> {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const consent = await call('GET', authorizePath(clientId, challenge), { headers: { cookie } });
  expect(consent.status).toBe(200);
  const { action, token } = consentFormOf(await consent.text());
  const approved = await postConsent(action, cookie, [
    [CONSENT_TOKEN_FIELD, token],
    ...scopes.map((scope) => [CONSENT_SCOPE_FIELD, scope] as const),
    [CONSENT_DECISION_FIELD, DECISION_APPROVE],
  ]);
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code');
  expect(code).not.toBeNull();
  const tokens = await call('POST', '/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: LOOPBACK_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${APP_ORIGIN}/mcp`,
    }).toString(),
  });
  expect(tokens.status).toBe(200);
  const json = (await tokens.json()) as { access_token: string; refresh_token: string; scope: string };
  return { clientId, accessToken: json.access_token, refreshToken: json.refresh_token, scope: json.scope };
}

/**
 * Bearer で `/mcp` を叩く。
 *
 * @param accessToken アクセストークン
 * @param headers 追加のヘッダ
 * @returns 応答
 */
async function callMcp(accessToken: string, headers: Record<string, string> = {}): Promise<Response> {
  return await call('POST', '/mcp', {
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

/**
 * 利用者の KV の鍵の数（許可とトークン）。
 *
 * @param userId 利用者の id
 * @returns 数
 */
async function kvKeysOf(userId: string): Promise<{ readonly grants: number; readonly tokens: number }> {
  const grants = await env.OAUTH_KV.list({ prefix: `grant:${userId}:` });
  const tokens = await env.OAUTH_KV.list({ prefix: `token:${userId}:` });
  return { grants: grants.keys.length, tokens: tokens.keys.length };
}

beforeAll(async () => {
  await applySchema();
});

describe('メタデータとトークンなしの /mcp（部品の口）', () => {
  it('認可サーバーのメタデータ（RFC 8414）が、決めた値を宣言する', async () => {
    const response = await call('GET', '/.well-known/oauth-authorization-server');
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata['issuer']).toBe(APP_ORIGIN);
    expect(metadata['authorization_endpoint']).toBe(`${APP_ORIGIN}/authorize`);
    expect(metadata['token_endpoint']).toBe(`${APP_ORIGIN}/token`);
    expect(metadata['registration_endpoint']).toBe(`${APP_ORIGIN}/register`);
    expect(metadata['scopes_supported']).toEqual([SCOPE_WORKS_READ, SCOPE_WORKS_GENERATE]);
    // **PKCE は S256 だけ**（plain を許さない）。implicit は出さない。
    expect(metadata['code_challenge_methods_supported']).toEqual(['S256']);
    expect(metadata['response_types_supported']).toEqual(['code']);
    // **CIMD は、互換フラグ（`global_fetch_strictly_public`）が効いているときだけ true になる**（部品の判定）。
    // Claude は `none` と CIMD の両方の宣言を見て CIMD を使う（仕様 5.15）。
    expect(metadata['client_id_metadata_document_supported']).toBe(true);
    expect(metadata['token_endpoint_auth_methods_supported']).toContain('none');
  });

  it('保護されたリソースのメタデータ（RFC 9728）は、根の形も /mcp 付きの形も口を /mcp に固定する', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await call('GET', path);
      expect(response.status, path).toBe(200);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata['resource'], path).toBe(`${APP_ORIGIN}/mcp`);
      expect(metadata['authorization_servers'], path).toEqual([APP_ORIGIN]);
      expect(metadata['scopes_supported'], path).toEqual([SCOPE_WORKS_READ, SCOPE_WORKS_GENERATE]);
    }
  });

  it('トークンなしの /mcp は 401 と WWW-Authenticate（resource_metadata）', async () => {
    const response = await call('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('でたらめなトークンの /mcp は 401', async () => {
    const response = await callMcp('u:g:not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('部品へ渡す口の判定は /mcp の下だけで、/mcpx は経路表（404）へ落ちる', async () => {
    expect(isOAuthProviderPath('/mcp')).toBe(true);
    expect(isOAuthProviderPath('/mcp/x')).toBe(true);
    expect(isOAuthProviderPath('/mcpx')).toBe(false);
    expect(isOAuthProviderPath('/token')).toBe(true);
    expect(isOAuthProviderPath('/tokens')).toBe(false);
    expect(isOAuthProviderPath('/authorize')).toBe(false);
    expect(isOAuthProviderPath('/.well-known/oauth-protected-resource/mcp')).toBe(true);
    expect(isOAuthProviderPath('/.well-known/security.txt')).toBe(false);
    const response = await call('GET', '/mcpx');
    expect(response.status).toBe(404);
  });

  it('部品の口の名前と同意画面の名前は、ハンドル名として名乗れない', () => {
    const reserved = appReservedHandles(testEnv());
    for (const word of ['token', 'register', 'mcp', 'authorize']) {
      expect(reserved.has(word), word).toBe(true);
    }
  });
});

describe('フロー全体（DCR → 同意 → code → token → /mcp → refresh）', () => {
  it('承諾で code が出て、トークンで /mcp が仮の 404 を返し、refresh で入れ替わる', async () => {
    const user = await seedUser();
    const connected = await connect(user.cookie);
    expect(connected.scope.split(' ').sort()).toEqual([SCOPE_WORKS_GENERATE, SCOPE_WORKS_READ]);
    // トークンの形は `<利用者の id>:<許可の id>:<秘密>`（部品）。
    expect(connected.accessToken.startsWith(`${user.id}:`)).toBe(true);

    const mcp = await callMcp(connected.accessToken);
    expect(mcp.status).toBe(404);
    expect(await mcp.json()).toEqual({ error: 'not-found' });

    const refreshed = await call('POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connected.refreshToken,
        client_id: connected.clientId,
      }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string; expires_in: number };
    // **入れ替わる**（部品の既定。古い refresh は新しいものが使われるまでの 1 世代だけ猶予される）。
    expect(next.refresh_token).not.toBe(connected.refreshToken);
    expect(next.access_token).not.toBe(connected.accessToken);
    expect(next.expires_in).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_SECONDS);
    expect((await callMcp(next.access_token)).status).toBe(404);

    // 新しい refresh を使った後は、最初の refresh はもう通らない。
    const again = await call('POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: next.refresh_token,
        client_id: connected.clientId,
      }).toString(),
    });
    expect(again.status).toBe(200);
    const stale = await call('POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connected.refreshToken,
        client_id: connected.clientId,
      }).toString(),
    });
    expect(stale.status).toBe(400);
  });

  it('scope を 1 つだけ選ぶと、発行されるトークンの scope もその 1 つになる', async () => {
    const user = await seedUser();
    const connected = await connect(user.cookie, [SCOPE_WORKS_READ]);
    expect(connected.scope).toBe(SCOPE_WORKS_READ);
    // トークンの props にも、そのトークンの scope が載る（PR② の insufficient_scope の判定に使う）。
    const unwrapped = await oauthHelpers(testEnv(), APP_ORIGIN).unwrapToken<{ userId: string; scope: string[] }>(
      connected.accessToken,
    );
    expect(unwrapped?.grant.props).toEqual({ userId: user.id, scope: [SCOPE_WORKS_READ] });
    expect(unwrapped?.scope).toEqual([SCOPE_WORKS_READ]);
  });

  it('MCP のトークンでは /api/* を呼べない（Bearer を受けるのは /mcp だけ）', async () => {
    const user = await seedUser();
    const connected = await connect(user.cookie);
    const response = await call('GET', '/api/me/works', { headers: { authorization: `Bearer ${connected.accessToken}` } });
    expect(response.status).toBe(401);
  });

  it('Origin がアプリのホスト以外なら /mcp は 403（DNS rebinding の対策）。アプリのホストと Origin なしは通す', async () => {
    const user = await seedUser();
    const connected = await connect(user.cookie);
    expect((await callMcp(connected.accessToken, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await callMcp(connected.accessToken, { origin: 'null' })).status).toBe(403);
    expect((await callMcp(connected.accessToken, { origin: APP_ORIGIN })).status).toBe(404);
    expect((await callMcp(connected.accessToken)).status).toBe(404);
  });

  it('BAN・退会を始めた利用者のトークンは、トークンが生きていても /mcp で 401', async () => {
    for (const column of ['banned_at', 'withdrawal_started_at'] as const) {
      const user = await seedUser();
      const connected = await connect(user.cookie);
      await env.DB.prepare(`update users set ${column} = ? where id = ?`)
        .bind(Math.floor(Date.now() / 1000) - 10, user.id)
        .run();
      const response = await callMcp(connected.accessToken);
      expect(response.status, column).toBe(401);
      expect(response.headers.get('www-authenticate'), column).toContain('invalid_token');
    }
  });

  it('拒否と、scope を 1 つも選ばない承諾は、access_denied で戻す（許可を作らない）', async () => {
    const user = await seedUser();
    for (const fields of [
      [[CONSENT_DECISION_FIELD, DECISION_DENY], [CONSENT_SCOPE_FIELD, SCOPE_WORKS_READ]],
      [[CONSENT_DECISION_FIELD, DECISION_APPROVE]],
    ] as const) {
      const clientId = await register();
      const { challenge } = await pkce();
      const consent = await call('GET', authorizePath(clientId, challenge, { state: 'deny-state' }), {
        headers: { cookie: user.cookie },
      });
      const { action, token } = consentFormOf(await consent.text());
      const response = await postConsent(action, user.cookie, [[CONSENT_TOKEN_FIELD, token], ...fields]);
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location')!);
      expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('deny-state');
      expect(location.searchParams.get('iss')).toBe(APP_ORIGIN);
      expect(location.searchParams.get('code')).toBeNull();
    }
    expect((await kvKeysOf(user.id)).grants).toBe(0);
  });

  it('許せない scope だけを求める要求は invalid_scope で戻す。知らない scope は黙って落とす', async () => {
    expect(offeredScopes([])).toEqual([...OAUTH_SCOPES]);
    expect(offeredScopes(['works:read', 'admin'])).toEqual([SCOPE_WORKS_READ]);
    expect(offeredScopes(['admin'])).toEqual([]);
    const user = await seedUser();
    const clientId = await register();
    const { challenge } = await pkce();
    const response = await call('GET', authorizePath(clientId, challenge, { scope: 'admin' }), {
      headers: { cookie: user.cookie },
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });
});

describe('同意画面（/authorize）', () => {
  it('未ログインは、要求を署名した一時 cookie に積んでログインへ送り、固定の戻り先で受け直す', async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const response = await call('GET', path);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    const cookies = response.headers.getSetCookie();
    const pending = cookies.find((cookie) => cookie.startsWith(`${PENDING_AUTHORIZATION_COOKIE}=`));
    expect(pending, '要求を積む一時 cookie が無い').toBeDefined();
    // `__Host-` の受理条件と、10 分の寿命。
    for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600']) {
      expect(pending!).toContain(attribute);
    }
    expect(pending!).not.toContain('Domain=');
    // ログインの一時 cookie（戻り先を運ぶ）も付く。**戻り先は固定の定数**で、要求の query を運ばない。
    expect(cookies.some((cookie) => cookie.startsWith(`${OAUTH_COOKIE}=`))).toBe(true);
    const loginCookie = cookies.find((cookie) => cookie.startsWith(`${OAUTH_COOKIE}=`))!;
    expect(loginCookie).not.toContain(clientId);

    // 戻り先で受け直すと、元の要求へ送り直し、一時 cookie を消す。
    const value = pending!.split(';')[0]!;
    const resumed = await call('GET', AUTHORIZE_RESUME_PATH, { headers: { cookie: value } });
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get('location')).toBe(path);
    expect(resumed.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('戻り先で一時 cookie が読めない（無い・改竄・期限切れ）なら、要求の無い形の 400 へ送る', async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await signPendingAuthorization(SECRET, 'client_id=x', now);
    expect(await verifyPendingAuthorization(SECRET, valid, now)).toBe('client_id=x');
    expect(await verifyPendingAuthorization(SECRET, `${valid}x`, now)).toBeNull();
    expect(await verifyPendingAuthorization('another-secret-another-secret-0000000', valid, now)).toBeNull();
    expect(await verifyPendingAuthorization(SECRET, valid, now + 601)).toBeNull();
    for (const cookie of ['', `${PENDING_AUTHORIZATION_COOKIE}=${valid}x`]) {
      const response = await call('GET', AUTHORIZE_RESUME_PATH, { headers: cookie === '' ? {} : { cookie } });
      expect(response.status).toBe(303);
      const location = response.headers.get('location')!;
      expect(location).toBe(`${AUTHORIZE_PATH}?expired=1`);
      const page = await call('GET', location);
      expect(page.status).toBe(400);
      expect(await page.text()).toContain('接続の要求を受け付けられませんでした');
    }
  });

  it('同意画面は枠への埋め込みを禁じ、アプリ名・戻り先のホスト名・2 つの scope のチェックボックスを出す', async () => {
    const user = await seedUser();
    const clientId = await register(WEB_REDIRECT, '<b>悪い名前</b>');
    const { challenge } = await pkce();
    const response = await call('GET', authorizePath(clientId, challenge, { redirectUri: WEB_REDIRECT }), {
      headers: { cookie: user.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.text();
    // アプリ名はエスケープして出す（DCR の名前は誰でも名乗れる）。
    expect(body).toContain('&lt;b&gt;悪い名前&lt;/b&gt;');
    expect(body).not.toContain('<b>悪い名前</b>');
    expect(body).toContain('アプリ自身が名乗った名前です');
    expect(body).toContain('<strong>client.example.com</strong>');
    expect(body).not.toContain('このコンピュータの中');
    for (const scope of OAUTH_SCOPES) {
      expect(body).toContain(`type="checkbox" name="${CONSENT_SCOPE_FIELD}" value="${scope}" checked`);
    }
  });

  it('loopback への戻りなら、その旨を添える', async () => {
    expect(describeRedirect('http://127.0.0.1:33418/callback')).toEqual({ label: '127.0.0.1', loopback: true });
    expect(describeRedirect('http://localhost:8080/cb')).toEqual({ label: 'localhost', loopback: true });
    expect(describeRedirect('https://claude.ai/api/mcp/auth_callback')).toEqual({ label: 'claude.ai', loopback: false });
    expect(describeRedirect('cursor://anysphere.cursor-mcp/oauth/callback').loopback).toBe(false);
    const user = await seedUser();
    const clientId = await register(LOOPBACK_REDIRECT);
    const { challenge } = await pkce();
    const response = await call('GET', authorizePath(clientId, challenge), { headers: { cookie: user.cookie } });
    const body = await response.text();
    expect(body).toContain('<strong>127.0.0.1</strong>');
    expect(body).toContain('このコンピュータの中');
  });

  it('壊れた要求は 400 の画面（500 にしない）。戻り先が登録と違えば、そこへは戻さない', async () => {
    const user = await seedUser();
    const clientId = await register();
    const { challenge } = await pkce();
    const cases = [
      `${AUTHORIZE_PATH}?response_type=code`,
      authorizePath('no-such-client', challenge),
      authorizePath(clientId, challenge, { redirectUri: 'https://attacker.example/cb' }),
    ];
    for (const path of cases) {
      const response = await call('GET', path, { headers: { cookie: user.cookie } });
      expect(response.status, path).toBe(400);
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
    }
    // 戻り先が確かめられた後の誤り（PKCE の方式が plain）は、戻り先へ error を付けて返す。
    const plain = `${authorizePath(clientId, challenge)}`.replace('code_challenge_method=S256', 'code_challenge_method=plain');
    const response = await call('GET', plain, { headers: { cookie: user.cookie } });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('CIMD: 文書を取りに行き、置き場所のホスト名を出す。読めなければ 400 の画面（500 にしない）', async () => {
    // **外へは出さない。** 部品は大域の `fetch` で文書を取るので、テストの間だけ差し替える（テストと部品は同じ isolate で動く）。
    const clientId = 'https://mcp-client.example.com/oauth/client.json';
    const original = globalThis.fetch;
    const fetched: string[] = [];
    let respond: () => Response = () =>
      Response.json(
        {
          client_id: clientId,
          client_name: 'CIMD のアプリ',
          redirect_uris: [WEB_REDIRECT],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return respond();
    }) as typeof fetch;
    try {
      const user = await seedUser();
      const { challenge } = await pkce();
      const path = authorizePath(clientId, challenge, { redirectUri: WEB_REDIRECT });
      const ok = await call('GET', path, { headers: { cookie: user.cookie } });
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).toContain('CIMD のアプリ');
      expect(body).toContain('アプリの情報の置き場所: <strong>mcp-client.example.com</strong>');
      expect(fetched).toContain(clientId);

      respond = () => new Response('not found', { status: 404 });
      const broken = await call('GET', path, { headers: { cookie: user.cookie } });
      expect(broken.status).toBe(400);
      expect(await broken.text()).toContain('接続の要求を受け付けられませんでした');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('要求を持たずに開くと、何の画面かを 200 で説明する', async () => {
    const response = await call('GET', AUTHORIZE_PATH);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('AI アプリとの接続');
  });

  it('同意の値が無い・改竄・期限切れ・別の利用者・別の要求のものは 403 で断り、許可を作らない', async () => {
    const user = await seedUser();
    const other = await seedUser();
    const clientId = await register();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const consent = await call('GET', path, { headers: { cookie: user.cookie } });
    const { action, token } = consentFormOf(await consent.text());

    const helpers = oauthHelpers(testEnv(), APP_ORIGIN);
    const parsed = await helpers.parseAuthRequest(new Request(`${APP_ORIGIN}${path}`));
    const now = Math.floor(Date.now() / 1000);
    const expired = await signConsentToken(SECRET, user.id, parsed, now - 601);
    const othersToken = await signConsentToken(SECRET, other.id, parsed, now);
    const otherRequest = await signConsentToken(SECRET, user.id, { ...parsed, state: 'another-state' }, now);
    const [expiresAt, signature] = token.split('.');
    const tampered = `${Number(expiresAt) + 1}.${signature}`;

    const approve = [
      [CONSENT_SCOPE_FIELD, SCOPE_WORKS_READ],
      [CONSENT_DECISION_FIELD, DECISION_APPROVE],
    ] as const;
    for (const [label, fields] of [
      ['値が無い', [...approve]],
      ['改竄', [[CONSENT_TOKEN_FIELD, tampered], ...approve]],
      ['期限切れ', [[CONSENT_TOKEN_FIELD, expired], ...approve]],
      ['別の利用者', [[CONSENT_TOKEN_FIELD, othersToken], ...approve]],
      ['別の要求', [[CONSENT_TOKEN_FIELD, otherRequest], ...approve]],
      ['2 つ送る', [[CONSENT_TOKEN_FIELD, token], [CONSENT_TOKEN_FIELD, token], ...approve]],
    ] as const) {
      const response = await postConsent(action, user.cookie, fields);
      expect(response.status, label).toBe(403);
      expect(response.headers.get('location'), label).toBeNull();
    }
    // 別の利用者が、他人の画面の値を自分の cookie で送っても通らない。
    const stolen = await postConsent(action, other.cookie, [[CONSENT_TOKEN_FIELD, token], ...approve]);
    expect(stolen.status).toBe(403);
    expect((await kvKeysOf(user.id)).grants).toBe(0);
    expect((await kvKeysOf(other.id)).grants).toBe(0);

    // 同じ値を正しく送れば通る（上の断りが「値の照合」で落ちていたことの確かめ）。
    const ok = await postConsent(action, user.cookie, [[CONSENT_TOKEN_FIELD, token], ...approve]);
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).searchParams.get('code')).not.toBeNull();
  });

  it('BAN・退会を始めた利用者には同意させない（画面も POST もログインへ送る）', async () => {
    for (const state of ['banned', 'withdrawing'] as const) {
      const user = await seedUser(state);
      const clientId = await register();
      const { challenge } = await pkce();
      const path = authorizePath(clientId, challenge);
      const page = await call('GET', path, { headers: { cookie: user.cookie } });
      expect(page.status, state).toBe(303);
      expect(page.headers.get('location'), state).toBe(LOGIN_PATH);

      const parsed = await oauthHelpers(testEnv(), APP_ORIGIN).parseAuthRequest(new Request(`${APP_ORIGIN}${path}`));
      const token = await signConsentToken(SECRET, user.id, parsed, Math.floor(Date.now() / 1000));
      const posted = await postConsent(path, user.cookie, [
        [CONSENT_TOKEN_FIELD, token],
        [CONSENT_SCOPE_FIELD, SCOPE_WORKS_READ],
        [CONSENT_DECISION_FIELD, DECISION_APPROVE],
      ]);
      expect(posted.status, state).toBe(303);
      expect(posted.headers.get('location'), state).toBe(LOGIN_PATH);
      expect((await kvKeysOf(user.id)).grants, state).toBe(0);
    }
  });
});

describe('接続中のアプリ（/account/apps）', () => {
  it('本人の接続を並べ、解除するとトークンも使えなくなる', async () => {
    const user = await seedUser();
    const connected = await connect(user.cookie, [SCOPE_WORKS_READ]);
    const page = await call('GET', ACCOUNT_APPS_PATH, { headers: { cookie: user.cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Test MCP Client');
    expect(body).toContain('自分の作品を読む');
    expect(body).not.toContain('作品を生成・推敲する');
    expect(body).toContain('接続した日時');
    expect(body).toContain('aria-current="page">接続中のアプリ');
    const grantId = /name="grant_id" value="([^"]+)"/u.exec(body)?.[1];
    expect(grantId).toBeDefined();

    const revoked = await call('POST', ACCOUNT_APPS_REVOKE_API_PATH, {
      headers: { cookie: user.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_id=${grantId!}`,
    });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe(`${ACCOUNT_APPS_PATH}?revoked=1`);
    expect(await kvKeysOf(user.id)).toEqual({ grants: 0, tokens: 0 });
    expect((await callMcp(connected.accessToken)).status).toBe(401);
    const after = await (await call('GET', ACCOUNT_APPS_PATH, { headers: { cookie: user.cookie } })).text();
    expect(after).toContain('接続中のアプリはありません');
  });

  it('他人の許可は解除できない（not-found で戻し、許可もトークンも残る）', async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const connected = await connect(owner.cookie);
    const grantId = connected.accessToken.split(':')[1]!;
    const response = await call('POST', ACCOUNT_APPS_REVOKE_API_PATH, {
      headers: { cookie: attacker.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_id=${grantId}`,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_APPS_PATH}?reason=not-found`);
    expect((await kvKeysOf(owner.id)).grants).toBe(1);
    expect((await callMcp(connected.accessToken)).status).toBe(404);
  });

  it('形の違う id・重なった id は invalid-request。未ログインはログインへ', async () => {
    const user = await seedUser();
    for (const body of ['grant_id=a:b', 'grant_id=a&grant_id=b', '']) {
      const response = await call('POST', ACCOUNT_APPS_REVOKE_API_PATH, {
        headers: { cookie: user.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      expect(response.headers.get('location'), body).toBe(`${ACCOUNT_APPS_PATH}?reason=invalid-request`);
    }
    const anonymous = await call('GET', ACCOUNT_APPS_PATH);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(LOGIN_PATH);
  });
});

describe('退会で許可が消える', () => {
  it('退会が確定すると、その利用者の KV の許可とトークンがすべて消える（他人の許可は残る）', async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    await connect(user.cookie);
    await connect(user.cookie, [SCOPE_WORKS_READ]);
    const kept = await connect(bystander.cookie);
    expect((await kvKeysOf(user.id)).grants).toBe(2);

    const response = await call('POST', ACCOUNT_WITHDRAW_API_PATH, { headers: { cookie: user.cookie } });
    expect(response.status).toBe(303);
    expect(await kvKeysOf(user.id)).toEqual({ grants: 0, tokens: 0 });
    expect((await kvKeysOf(bystander.id)).grants).toBe(1);
    expect((await callMcp(kept.accessToken)).status).toBe(404);
  });
});

describe('トークンの利用者の確認（src/oauth-user.ts）', () => {
  it('セッションの判定（resolveSessionUser）と同じ行に同じ答えを返す', async () => {
    const active = await seedUser();
    const banned = await seedUser('banned');
    const withdrawing = await seedUser('withdrawing');
    const missing = { id: crypto.randomUUID(), cookie: '' };
    const now = Math.floor(Date.now() / 1000);
    const missingCookie = buildSessionCookie(
      await signSession({ userId: missing.id, issuedAt: now, expiresAt: now + 3600 }, SECRET),
      3600,
    ).split(';')[0]!;
    for (const [user, cookie, expected] of [
      [active, active.cookie, true],
      [banned, banned.cookie, false],
      [withdrawing, withdrawing.cookie, false],
      [missing, missingCookie, false],
    ] as const) {
      const session = await resolveSessionUser(new Request(APP_ORIGIN, { headers: { cookie } }), testEnv());
      expect(session.ok, user.id).toBe(expected);
      expect(await isOAuthUserActive(env.DB, user.id), user.id).toBe(expected);
    }
    expect(await isOAuthUserActive(env.DB, undefined)).toBe(false);
    expect(await isOAuthUserActive(env.DB, '')).toBe(false);
  });
});

describe('KV の書き込みの実測（仕様 5.15「KV の書き込みの見込み」）', () => {
  /**
   * 操作を数える。
   *
   * @param run 数える処理
   * @returns 種類ごとの回数
   */
  async function count(run: () => Promise<unknown>): Promise<Record<string, number>> {
    kvOps = [];
    try {
      await run();
      const counts: Record<string, number> = {};
      for (const op of kvOps) {
        counts[op.op] = (counts[op.op] ?? 0) + 1;
      }
      return counts;
    } finally {
      kvOps = null;
    }
  }

  it('DCR・接続・発行・refresh・/mcp・解除の 1 回ずつの操作を数える', async () => {
    const user = await seedUser();
    let clientId = '';
    const dcr = await count(async () => {
      clientId = await register();
    });
    const { verifier, challenge } = await pkce();
    const path = authorizePath(clientId, challenge);
    const consentPage = await call('GET', path, { headers: { cookie: user.cookie } });
    const { action, token } = consentFormOf(await consentPage.text());
    let code = '';
    const authorize = await count(async () => {
      const response = await postConsent(action, user.cookie, [
        [CONSENT_TOKEN_FIELD, token],
        [CONSENT_SCOPE_FIELD, SCOPE_WORKS_READ],
        [CONSENT_DECISION_FIELD, DECISION_APPROVE],
      ]);
      code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    });
    let refreshToken = '';
    let accessToken = '';
    const issue = await count(async () => {
      const response = await call('POST', '/token', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: LOOPBACK_REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      const json = (await response.json()) as { access_token: string; refresh_token: string };
      refreshToken = json.refresh_token;
      accessToken = json.access_token;
    });
    const refresh = await count(async () => {
      await call('POST', '/token', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
      });
    });
    const mcp = await count(async () => {
      await callMcp(accessToken);
    });
    const grantId = accessToken.split(':')[1]!;
    const revoke = await count(async () => {
      const response = await call('POST', ACCOUNT_APPS_REVOKE_API_PATH, {
        headers: { cookie: user.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_id=${grantId}`,
      });
      expect(response.headers.get('location')).toBe(`${ACCOUNT_APPS_PATH}?revoked=1`);
    });
    console.log('[kv-ops]', JSON.stringify({ dcr, authorize, issue, refresh, mcp, revoke }));

    // 書き込み（put + delete）と list の回数。**無料枠はそれぞれ 1 日 1,000 回**（仕様 5.15）。
    const writes = (counts: Record<string, number>): number => (counts['put'] ?? 0) + (counts['delete'] ?? 0);
    expect(writes(dcr)).toBe(1);
    expect(writes(authorize)).toBe(1);
    expect(authorize['list'] ?? 0).toBe(1);
    expect(writes(issue)).toBe(2);
    expect(writes(refresh)).toBe(2);
    expect(writes(mcp)).toBe(0);
    expect(mcp['list'] ?? 0).toBe(0);
    // 解除: 一覧（本人の許可に在るか）1 + トークンの一覧 1、消すのは許可 1 とトークン（アクセストークン 2 本）。
    expect(revoke['list'] ?? 0).toBe(2);
    expect(writes(revoke)).toBe(3);
  });
});
