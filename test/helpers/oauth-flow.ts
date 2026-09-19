import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import worker from '../../src/index.js';
import { CONSENT_DECISION_FIELD, CONSENT_SCOPE_FIELD, CONSENT_TOKEN_FIELD, DECISION_APPROVE } from '../../src/oauth-authorize.js';
import { AUTHORIZE_PATH, OAUTH_SCOPES } from '../../src/oauth-paths.js';
import { buildSessionCookie, signSession } from '../../src/session.js';

/**
 * MCP の接続（DCR → 同意 → code → token）を、**本番と同じ入口（`src/index.ts` の既定の輸出）から**通す道具（#696 PR②）。
 *
 * `test/oauth.test.ts`（PR①）の同じ名前の道具を、MCP サーバーのテスト（`test/mcp-server.test.ts`）から使える形にしたもの。
 * あちらは KV を数える包みを被せる都合で自前の道具を持ったままにしてある。
 */

/** アプリのホストの origin。 */
export const APP_ORIGIN = `https://${env.APP_HOST}`;

/** テストのセッションの秘密。 */
export const OAUTH_FLOW_SECRET = 'test-secret-value-for-mcp-server-000001';

/** DCR で登録する戻り先（loopback）。 */
const LOOPBACK_REDIRECT = 'http://127.0.0.1:9999/callback';

/**
 * 本番と同じ入口へ要求を渡す。
 *
 * @param request 要求
 * @param overrides env の差し替え
 * @returns 応答
 */
export async function callWorker(request: Request, overrides: Partial<Record<string, unknown>> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, SESSION_SECRET: OAUTH_FLOW_SECRET, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * パスとメソッドで入口を呼ぶ。
 *
 * @param method メソッド
 * @param path パス
 * @param init ヘッダと本文
 * @param init.headers ヘッダ
 * @param init.body 本文
 * @returns 応答
 */
async function call(
  method: string,
  path: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<Response> {
  return await callWorker(
    new Request(`${APP_ORIGIN}${path}`, { method, headers: init.headers ?? {}, body: init.body, redirect: 'manual' }),
  );
}

/**
 * 利用者を 1 人作る。
 *
 * @returns id と cookie（`Cookie` ヘッダの形）
 */
export async function seedOAuthUser(): Promise<{ readonly id: string; readonly cookie: string }> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, 'MCP の作者', 100)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`)
    .run();
  const token = await signSession({ userId: id, issuedAt: now, expiresAt: now + 3600 }, OAUTH_FLOW_SECRET);
  return { id, cookie: buildSessionCookie(token, 3600).split(';')[0]! };
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
 * DCR → 同意（選んだ scope）→ code → token を 1 回通し、アクセストークンを返す。
 *
 * @param cookie 利用者の cookie
 * @param scopes 同意画面で選ぶ scope
 * @returns アクセストークンと、発行された scope
 */
export async function connectMcp(
  cookie: string,
  scopes: readonly string[] = OAUTH_SCOPES,
): Promise<{ readonly accessToken: string; readonly scope: string }> {
  const registered = await call('POST', '/register', {
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify({
      client_name: 'MCP のテスト',
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'mcp-state',
    resource: `${APP_ORIGIN}/mcp`,
  });
  const consent = await call('GET', `${AUTHORIZE_PATH}?${params.toString()}`, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const action = /<form method="post" action="(\/authorize\?[^"]+)">/u.exec(html)?.[1]?.replaceAll('&amp;', '&');
  const token = new RegExp(`name="${CONSENT_TOKEN_FIELD}" value="([^"]+)"`, 'u').exec(html)?.[1];
  expect(action).toBeDefined();
  expect(token).toBeDefined();
  const form = new URLSearchParams();
  form.append(CONSENT_TOKEN_FIELD, token!);
  for (const scope of scopes) {
    form.append(CONSENT_SCOPE_FIELD, scope);
  }
  form.append(CONSENT_DECISION_FIELD, DECISION_APPROVE);
  const approved = await call('POST', action!, {
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code');
  expect(code).not.toBeNull();

  const issued = await call('POST', '/token', {
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
  expect(issued.status).toBe(200);
  const json = (await issued.json()) as { access_token: string; scope: string };
  return { accessToken: json.access_token, scope: json.scope };
}
