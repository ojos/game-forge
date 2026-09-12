import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  LOGIN_REQUIRED_REASON,
  LOGOUT_PATH,
  OAUTH_COOKIE,
  createAuthRoutes,
  loginRequiredRedirect,
  parseGoogleIdToken,
  safeReturnPath,
  startInvitedLogin,
} from '../src/auth/google.js';
import type { TokenExchange, TokenExchangeParams } from '../src/auth/google.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession, verifySession } from '../src/session.js';
import { createAccountRoutes } from '../src/account.js';
import { ACCOUNT_DISPLAY_NAME_PATH, ACCOUNT_PATH, DISPLAY_NAME_FIELD } from '../src/account-paths.js';
import { normalizeInviteCode } from '../src/invite-code.js';
import { SIGNUP_PATH } from '../src/paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * このテストは**ネットワークへ出ない**。
 *
 * 認可コードの交換は `createAuthRoutes` の `exchange` で差し替える。既定の実装
 * （`exchangeCodeWithGoogle`）はこのファイルから一度も呼ばない。実 HTTP を叩く
 * テストを書くと、Google の可用性がローカル層の受け入れ条件へ混ざり、実装が
 * 正しいのにループが止まる（loop-workflow.md「受け入れ条件の二層」）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

/** テスト用の秘密鍵。実鍵ではなく、長さの下限（32 文字）を満たすためだけの値。 */
const SECRET = 'test-secret-value-for-oauth-signing-0001';
const OTHER_SECRET = 'test-secret-value-for-oauth-signing-0002';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret-value';

const NOW = 1_770_000_000;

/** `randomToken` を差し替えるときに使う固定値（base64url 文字だけで構成する）。 */
const FIXED_STATE = 'fixed-state-token-0000000000000000000000000';
const FIXED_VERIFIER = 'fixed-code-verifier-000000000000000000000000';

beforeAll(async () => {
  await applySchema();
});

/**
 * 秘密を一切持たない env を作る。
 *
 * **`{ ...env }` で作らないこと。** `.dev.vars` を置いた開発者の手元では、そこに
 * 本物の `SESSION_SECRET` が入ってくる。テストの結果が「手元に `.dev.vars` が
 * あるか」で変わる状態は、実装の合否とは別の理由で赤や緑を出す（実測: 展開で
 * 作ったとき、未設定を検査するテストだけが `.dev.vars` のある環境で落ちた）。
 * 必要なバインディングだけを明示して組み立てる。
 *
 * @returns wrangler.toml の宣言だけを持つ env
 */
function bareEnv(): Env {
  return {
    APP_HOST: env.APP_HOST,
    SANDBOX_HOST: env.SANDBOX_HOST,
    DB: env.DB,
    BUCKET: env.BUCKET,
  } as unknown as Env;
}

/**
 * 秘密を設定した env を作る。
 *
 * `.dev.vars` の有無でテストの結果が変わらないよう、値をここで固定する。
 *
 * @param overrides 差し替える値
 * @returns ハンドラへ渡す env
 */
function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...bareEnv(),
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as unknown as Env;
}

/**
 * `state` と `code_verifier` を固定で返す乱数源を作る。
 *
 * @returns 1 回目に state、2 回目に verifier を返す関数
 */
function fixedRandomToken(): () => string {
  const values = [FIXED_STATE, FIXED_VERIFIER];
  let index = 0;
  return () => values[index++] ?? `extra-token-${index}`;
}

/** 交換の呼び出しを記録する seam。 */
interface RecordedExchange {
  readonly calls: TokenExchangeParams[];
  readonly exchange: TokenExchange;
}

/**
 * 認可コードの交換を差し替える。
 *
 * @param idToken 返す ID トークン（失敗を試すときは null）
 * @returns 記録付きの seam
 */
function recordExchange(idToken: string | null): RecordedExchange {
  const calls: TokenExchangeParams[] = [];
  const exchange: TokenExchange = async (params) => {
    calls.push(params);
    return idToken === null ? { ok: false, reason: 'test failure' } : { ok: true, idToken };
  };
  return { calls, exchange };
}

/**
 * 値を base64url へ変換する（JWT の各要素を組み立てるため）。
 *
 * `btoa` は Latin-1 しか受け付けないため、先に UTF-8 のバイト列へ落とす
 * （表示名に日本語が入る場合がある）。
 *
 * @param value JSON へ落とす値
 * @returns base64url 文字列
 */
function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * ID トークン（JWT）を組み立てる。
 *
 * 署名部分は検証されない（`parseGoogleIdToken` の JSDoc を参照）。トークンの
 * 信頼はトークンエンドポイントとの TLS 接続から来るため、ここでは形だけを作る。
 *
 * @param overrides 差し替えるクレーム
 * @returns ID トークン
 */
function buildIdToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: NOW + 3600,
    iat: NOW,
    sub: 'google-sub-default',
    email: 'default@example.com',
    email_verified: true,
    name: 'Default User',
    ...overrides,
  };
  return `${base64UrlJson({ alg: 'RS256', kid: 'test' })}.${base64UrlJson(claims)}.not-verified`;
}

/**
 * レスポンスの `Set-Cookie` をすべて取り出す。
 *
 * @param response 対象
 * @returns `Set-Cookie` の値
 */
function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/**
 * `Set-Cookie` の中から指定した名前のものを 1 つ返す。
 *
 * @param response 対象
 * @param name cookie 名
 * @returns `Set-Cookie` の値、または見つからなければ undefined
 */
function findCookie(response: Response, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

/**
 * `Set-Cookie` の値から `名前=値` の部分だけを取り出す（`Cookie` ヘッダへ載せる形）。
 *
 * @param setCookie `Set-Cookie` の値
 * @returns `名前=値`
 */
function toCookieHeader(setCookie: string): string {
  const separator = setCookie.indexOf(';');
  return separator === -1 ? setCookie : setCookie.slice(0, separator);
}

/** ログイン開始の結果。 */
interface StartedLogin {
  readonly response: Response;
  readonly authorize: URL;
  /** コールバックの `Cookie` ヘッダへそのまま載せられる形。 */
  readonly cookieHeader: string;
}

/**
 * ログインを開始し、認可 URL と一時 cookie を取り出す。
 *
 * @param routes 経路表
 * @param target 対象の env
 * @returns 開始の結果
 */
async function startLogin(routes: readonly Route[], target: Env): Promise<StartedLogin> {
  const response = await dispatch(routes, new Request(`${APP_ORIGIN}${LOGIN_PATH}`), target);
  expect(response.status).toBe(303);
  const cookie = findCookie(response, OAUTH_COOKIE);
  expect(cookie).toBeDefined();
  return {
    response,
    authorize: new URL(response.headers.get('location')!),
    cookieHeader: toCookieHeader(cookie!),
  };
}

/**
 * 招待を 1 枚用意する。
 *
 * 8.1 の「生成は招待コード保有者のみ」を機構にした結果、**新規登録には必ず招待が要る**。
 * 登録の往復を書くテストは、まず発行者と招待コードを用意する。
 *
 * @param code 正規形の招待コード（12 桁）。文字集合は Crockford Base32 で、
 *   `I` `L` `O` `U` を含められない（含めると正規化で別の文字へ寄り、正規形でなくなる）
 * @returns 発行者の id
 */
async function seedInvite(code: string): Promise<string> {
  // 正規形でないコードをそのまま挿入させない。ここを素通しにすると、誤りは
  // 一時 cookie の形式検査（`I` `L` `O` `U` を含む値は正規形にならない）で落ち、
  // 「state cookie の検証に失敗」という無関係な症状として現れる。
  expect(normalizeInviteCode(code), code).toBe(code);
  const issuerId = `issuer-${code}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(issuerId, `sub-${issuerId}`, `${issuerId}@example.com`, '発行者')
    .run();
  await env.DB.prepare('insert into invites (code, issued_by) values (?, ?)')
    .bind(code, issuerId)
    .run();
  return issuerId;
}

/**
 * 検証済みの招待コードを携えてログインを開始する。
 *
 * 登録画面（`POST /signup`）が通す経路と同じものを、画面を介さずに叩く。
 *
 * @param overrides 差し替える依存
 * @param target 対象の env
 * @param inviteCode 招待コード
 * @returns 開始の結果
 */
async function startLoginWithInvite(
  overrides: Parameters<typeof createAuthRoutes>[0],
  target: Env,
  inviteCode: string,
): Promise<StartedLogin> {
  const response = await startInvitedLogin(
    new Request(`${APP_ORIGIN}${LOGIN_PATH}`),
    target,
    inviteCode,
    overrides,
  );
  expect(response.status).toBe(303);
  const cookie = findCookie(response, OAUTH_COOKIE);
  expect(cookie).toBeDefined();
  return {
    response,
    authorize: new URL(response.headers.get('location')!),
    cookieHeader: toCookieHeader(cookie!),
  };
}

/**
 * コールバックを叩く。
 *
 * @param routes 経路表
 * @param target 対象の env
 * @param query query 文字列（`?` を含まない）
 * @param cookieHeader `Cookie` ヘッダ（省略可）
 * @returns レスポンス
 */
async function callback(
  routes: readonly Route[],
  target: Env,
  query: string,
  cookieHeader?: string,
): Promise<Response> {
  return await dispatch(
    routes,
    new Request(
      `${APP_ORIGIN}${CALLBACK_PATH}?${query}`,
      cookieHeader === undefined ? undefined : { headers: { cookie: cookieHeader } },
    ),
    target,
  );
}

/**
 * `google_sub` で `users` 行を引く。
 *
 * @param sub Google のアカウント識別子
 * @returns 行の一覧
 */
async function usersBySub(
  sub: string,
): Promise<{ id: string; email: string; display_name: string; invited_by: string | null }[]> {
  const result = await env.DB.prepare(
    'select id, email, display_name, invited_by from users where google_sub = ?',
  )
    .bind(sub)
    .all<{ id: string; email: string; display_name: string; invited_by: string | null }>();
  return result.results;
}

describe('ログインの開始（8.1）', () => {
  it('Google の認可エンドポイントへ PKCE 付きで送る', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());

    expect(started.authorize.origin).toBe('https://accounts.google.com');
    expect(started.authorize.pathname).toBe('/o/oauth2/v2/auth');
    expect(started.authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(started.authorize.searchParams.get('response_type')).toBe('code');
    expect(started.authorize.searchParams.get('scope')).toContain('openid');
    expect(started.authorize.searchParams.get('state')).toBe(FIXED_STATE);
    // plain を使わない。verifier をそのまま送る形では、認可要求を覗ける相手に対して
    // 何の保護にもならない。
    expect(started.authorize.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('code_challenge が cookie の code_verifier の S256 である', async () => {
    // ここが一致しないと PKCE は「付いているのに効かない」状態になる。実際に
    // ハッシュを計算して突き合わせる。
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(FIXED_VERIFIER),
    );
    let binary = '';
    for (const byte of new Uint8Array(digest)) {
      binary += String.fromCharCode(byte);
    }
    const expected = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

    expect(started.authorize.searchParams.get('code_challenge')).toBe(expected);
    expect(started.cookieHeader).toContain(FIXED_VERIFIER);
  });

  it('リダイレクト URI がコールバックのパスを指し、ポートを落とさない', async () => {
    // APP_HOST から組むとローカル開発のポート（:8787）が落ち、開発時のログインだけが
    // 通らなくなる。リクエスト側のホストから組んでいることを固定する。
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const response = await dispatch(
      routes,
      new Request(`https://${env.APP_HOST}:8787${LOGIN_PATH}`),
      testEnv(),
    );
    const authorize = new URL(response.headers.get('location')!);
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `https://${env.APP_HOST}:8787${CALLBACK_PATH}`,
    );
  });

  it('一時 cookie が __Host- の受理条件をすべて満たす', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const cookie = findCookie(started.response, OAUTH_COOKIE)!;

    expect(OAUTH_COOKIE.startsWith('__Host-')).toBe(true);
    // どれか 1 つでも欠けるとブラウザは黙って捨てるため、個別に検査する。
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie.toLowerCase()).not.toContain('domain=');
  });

  it('既定の乱数源が推測困難な state と verifier を作る', async () => {
    // 差し替え可能にした結果、既定の実装が検査されないまま残るのを避ける。
    const routes = createAuthRoutes({ exchange: recordExchange(null).exchange, now: () => NOW });
    const first = await startLogin(routes, testEnv());
    const second = await startLogin(routes, testEnv());

    const firstState = first.authorize.searchParams.get('state')!;
    expect(firstState).not.toBe(second.authorize.searchParams.get('state'));
    // PKCE の検証子に許される長さは 43〜128 文字。32 バイトを base64url して 43 文字。
    expect(firstState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('秘密が未設定なら認可へ送らずに落とす', async () => {
    // 設定漏れを「素通し」にしない。ここで通すと、鍵の無い環境で認証だけが
    // 成立したように見える経路ができる。
    for (const missing of ['SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
      const routes = createAuthRoutes({
        exchange: recordExchange(null).exchange,
        now: () => NOW,
        randomToken: fixedRandomToken(),
      });
      const response = await dispatch(
        routes,
        new Request(`${APP_ORIGIN}${LOGIN_PATH}`),
        testEnv({ [missing]: '' }),
      );
      expect(response.status, missing).toBe(503);
      expect(response.headers.get('location'), missing).toBeNull();
      expect(setCookies(response), missing).toEqual([]);
    }
  });

  it('env にキー自体が無くても落とす', async () => {
    // `.dev.vars` を置いていない環境では、型が string でも実行時は undefined になる。
    const routes = createAuthRoutes({ exchange: recordExchange(null).exchange, now: () => NOW });
    const response = await dispatch(routes, new Request(`${APP_ORIGIN}${LOGIN_PATH}`), bareEnv());
    expect(response.status).toBe(503);
  });
});

describe('コールバックと users 行の作成（#12 scope.in）', () => {
  it('初回ログインで users 行を作り、セッション cookie を発行する', async () => {
    const sub = 'google-sub-first-login';
    // 新規登録には招待が要る（8.1）。登録画面が通す経路と同じ形で開始する。
    const issuerId = await seedInvite('FRSTGN012345');
    const exchanged = recordExchange(buildIdToken({ sub, email: 'first@example.com', name: '最初の人' }));
    const overrides = {
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWithInvite(overrides, testEnv(), 'FRSTGN012345');

    const response = await callback(
      routes,
      testEnv(),
      `code=auth-code-1&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');

    const rows = await usersBySub(sub);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('first@example.com');
    expect(rows[0]!.display_name).toBe('最初の人');
    // 招待を消費した結果として招待者が記録される（8.1「誰が誰を呼んだか」）。
    // 記録するのは #13 の consumeInvite で、ここはそれを呼ぶ順序を固定している。
    expect(rows[0]!.invited_by).toBe(issuerId);

    const session = findCookie(response, SESSION_COOKIE);
    expect(session).toBeDefined();
    const token = toCookieHeader(session!).slice(`${SESSION_COOKIE}=`.length);
    const verified = await verifySession(token, SECRET, NOW);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.payload.userId).toBe(rows[0]!.id);
  });

  it('cookie の code_verifier をトークンエンドポイントへ渡す', async () => {
    // PKCE は verifier が交換要求に載って初めて効く。cookie に入れただけで
    // 送っていない実装でも、ログイン自体は成功してしまう。
    const exchanged = recordExchange(buildIdToken({ sub: 'google-sub-pkce' }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());

    await callback(routes, testEnv(), `code=auth-code-2&state=${FIXED_STATE}`, started.cookieHeader);

    expect(exchanged.calls).toHaveLength(1);
    expect(exchanged.calls[0]!.codeVerifier).toBe(FIXED_VERIFIER);
    expect(exchanged.calls[0]!.code).toBe('auth-code-2');
    expect(exchanged.calls[0]!.clientSecret).toBe(CLIENT_SECRET);
    expect(exchanged.calls[0]!.redirectUri).toBe(`${APP_ORIGIN}${CALLBACK_PATH}`);
  });

  it('同じ google_sub の再ログインで行が増えない', async () => {
    // 同一性の判定は google_sub（users.google_sub は UNIQUE）。email は変わりうる
    // ため使わない。email が変わっても同じ行が更新されることまで見る。
    const sub = 'google-sub-relogin';
    await seedInvite('RETRYN012345');
    const first = recordExchange(buildIdToken({ sub, email: 'old@example.com', name: '旧名' }));
    const overridesFirst = {
      exchange: first.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routesFirst = createAuthRoutes(overridesFirst);
    // 1 回目は登録なので招待が要る。
    const startedFirst = await startLoginWithInvite(overridesFirst, testEnv(), 'RETRYN012345');
    await callback(
      routesFirst,
      testEnv(),
      `code=code-a&state=${FIXED_STATE}`,
      startedFirst.cookieHeader,
    );
    const before = await usersBySub(sub);

    const second = recordExchange(buildIdToken({ sub, email: 'new@example.com', name: '新名' }));
    const routesSecond = createAuthRoutes({
      exchange: second.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    // 2 回目は既存利用者なので招待は要らない。招待を消費しないことも含めて見る。
    const startedSecond = await startLogin(routesSecond, testEnv());
    const response = await callback(
      routesSecond,
      testEnv(),
      `code=code-b&state=${FIXED_STATE}`,
      startedSecond.cookieHeader,
    );

    expect(response.status).toBe(303);
    const after = await usersBySub(sub);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.email).toBe('new@example.com');
    expect(after[0]!.display_name).toBe('新名');
  });

  it('成功しても一時 cookie を消す', async () => {
    // 使い切りにする。残すと、期限内に同じ state で何度でも試せる。
    await seedInvite('DSCARD012345');
    const exchanged = recordExchange(buildIdToken({ sub: 'google-sub-discard' }));
    const overrides = {
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWithInvite(overrides, testEnv(), 'DSCARD012345');
    const response = await callback(
      routes,
      testEnv(),
      `code=code-c&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(setCookies(response)).toHaveLength(2);
    const discarded = findCookie(response, OAUTH_COOKIE)!;
    expect(discarded).toContain('Max-Age=0');
    expect(discarded).toContain('Path=/');
  });

  it('BAN された利用者にセッションを発行しない', async () => {
    // BAN は google_sub 単位（7.3）。行を消さないため、毎回ここではじく。
    const sub = 'google-sub-banned';
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at, banned_at) values (?, ?, ?, ?, 1, 2)',
    )
      .bind('u-banned', sub, 'banned@example.com', 'banned')
      .run();

    const exchanged = recordExchange(buildIdToken({ sub }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await callback(
      routes,
      testEnv(),
      `code=code-d&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(response.status).toBe(403);
    expect(findCookie(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('秘密が未設定ならコールバックも通さない', async () => {
    const exchanged = recordExchange(buildIdToken({ sub: 'google-sub-unconfigured' }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await callback(
      routes,
      testEnv({ SESSION_SECRET: '' }),
      `code=code-e&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(response.status).toBe(503);
    expect(exchanged.calls).toHaveLength(0);
    expect(await usersBySub('google-sub-unconfigured')).toHaveLength(0);
  });
});

describe('表示名は、利用者が決めたらログインで上書きしない（5.9 / #341）', () => {
  /**
   * 既存の利用者を 1 人作る（2 回目以降のログインを試すため。招待は要らない）。
   *
   * @param sub Google のアカウント識別子
   * @param displayName いまの表示名
   * @returns 利用者の id
   */
  async function seedExistingUser(sub: string, displayName: string): Promise<string> {
    const id = `u-${sub}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, sub, `${sub}@example.com`, displayName)
      .run();
    return id;
  }

  /**
   * Google の名前とメールアドレスを差し替えてログインし直す。
   *
   * @param sub Google のアカウント識別子
   * @param claims ID トークンに載せる名前とメールアドレス
   * @returns コールバックの応答
   */
  async function relogin(sub: string, claims: { name: string; email: string }): Promise<Response> {
    const exchanged = recordExchange(buildIdToken({ sub, ...claims }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    return await callback(
      routes,
      testEnv(),
      `code=code-name&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
  }

  /**
   * `users` から表示名まわりの列を引く。
   *
   * @param sub Google のアカウント識別子
   * @returns 表示名・メールアドレス・`display_name_set_at`
   */
  async function nameColumns(
    sub: string,
  ): Promise<{ display_name: string; email: string; display_name_set_at: number | null }> {
    const row = await env.DB.prepare(
      'select display_name, email, display_name_set_at from users where google_sub = ?',
    )
      .bind(sub)
      .first<{ display_name: string; email: string; display_name_set_at: number | null }>();
    expect(row).not.toBeNull();
    return row!;
  }

  it('決めていない利用者は、ログインのたびに Google の表示名に追随する', async () => {
    // **既存の利用者は NULL のまま始まり、振る舞いが変わらない**（5.9）。
    // `case` の条件を外して「常に今の名前を残す」にすると、ここが赤くなる。
    const sub = 'google-sub-follows-google';
    await seedExistingUser(sub, 'Google の旧名');

    const response = await relogin(sub, { name: 'Google の新名', email: 'follows@example.com' });

    expect(response.status).toBe(303);
    expect(await nameColumns(sub)).toEqual({
      display_name: 'Google の新名',
      email: 'follows@example.com',
      // **ログインは印を付けない。** 付けると、次のログインから追随しなくなる。
      display_name_set_at: null,
    });
  });

  it('表示名を変えた利用者が再ログインしても、表示名は Google の名前へ戻らない', async () => {
    // **変更は本物の口（`POST /api/account/display-name`）で行う。** 列を直接埋めると、
    // 変更の口が印を付け忘れても緑になる。
    const sub = 'google-sub-keeps-own-name';
    const userId = await seedExistingUser(sub, 'Google の名前');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
    const changed = await dispatch(
      createAccountRoutes({ now: () => NOW }),
      new Request(`${APP_ORIGIN}${ACCOUNT_DISPLAY_NAME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: buildSessionCookie(token, 3600).split(';')[0]!,
        },
        body: new URLSearchParams({ [DISPLAY_NAME_FIELD]: '自分で決めた名前' }).toString(),
      }),
      testEnv(),
    );
    expect(changed.status).toBe(303);
    expect((await nameColumns(sub)).display_name).toBe('自分で決めた名前');

    const response = await relogin(sub, { name: 'Google の名前', email: 'changed@example.com' });

    expect(response.status).toBe(303);
    expect(await nameColumns(sub)).toEqual({
      display_name: '自分で決めた名前',
      // **メールアドレスは今までどおり毎回更新する**（5.9。宛先が古いまま残ると届かない）。
      email: 'changed@example.com',
      display_name_set_at: NOW,
    });
  });

  it('運営フラグ（is_operator）は、再ログインで消えない（#334）', async () => {
    // **ログインの UPDATE は `users` の行を毎回書く。** そこへ列を 1 つ書き足す変更
    // （たとえば既定値へ戻す `is_operator = 0`）が入ると、運営が次にログインした瞬間に
    // 印が消える。印は運営が D1 を直接 UPDATE して立てるもので（`docs/operator-account.md`）、
    // 消えても誰も気づかず、**名前で「運営」を名乗る利用者と見分けが付かなくなる**（5.9）。
    const sub = 'google-sub-operator-keeps-flag';
    const userId = await seedExistingUser(sub, 'Google の名前');
    const marked = await env.DB.prepare('update users set is_operator = 1 where id = ?')
      .bind(userId)
      .run();
    // 当たったことを先に確かめる（0 行のまま「消えない」を見ても何も確かめていない）。
    expect(marked.meta.changes).toBe(1);

    const response = await relogin(sub, { name: 'Google の新名', email: 'operator@example.com' });

    expect(response.status).toBe(303);
    const row = await env.DB.prepare(
      'select is_operator, display_name, email from users where google_sub = ?',
    )
      .bind(sub)
      .first<{ is_operator: number; display_name: string; email: string }>();
    // **ログインそのものは今までどおり進んだ**（名前は追随し、メールアドレスも更新された）
    // うえで、印だけが残っていることを見る。
    expect(row).toEqual({
      is_operator: 1,
      display_name: 'Google の新名',
      email: 'operator@example.com',
    });
  });
});

describe('state と一時 cookie による CSRF 対策', () => {
  /**
   * 交換が呼ばれないことまで見る。state の照合はコードの交換より前に行う。
   *
   * @param query コールバックの query
   * @param cookieHeader `Cookie` ヘッダ
   * @param sub 行が作られていないことを確かめる google_sub
   * @returns レスポンス
   */
  async function rejected(
    query: string,
    cookieHeader: string | undefined,
    sub: string,
  ): Promise<Response> {
    const exchanged = recordExchange(buildIdToken({ sub }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const response = await callback(routes, testEnv(), query, cookieHeader);
    expect(exchanged.calls).toHaveLength(0);
    expect(await usersBySub(sub)).toHaveLength(0);
    return response;
  }

  it('一時 cookie が無いコールバックを拒否する', async () => {
    const response = await rejected(`code=x&state=${FIXED_STATE}`, undefined, 'google-sub-nocookie');
    expect(response.status).toBe(400);
  });

  it('state が一致しないコールバックを拒否する', async () => {
    // 攻撃者のコードを利用者のブラウザで交換させられると、利用者が攻撃者の
    // アカウントでログインした状態になる（ログイン CSRF）。
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await rejected(
      'code=x&state=attacker-state',
      started.cookieHeader,
      'google-sub-badstate',
    );
    expect(response.status).toBe(400);
  });

  it('state が無いコールバックを拒否する', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await rejected('code=x', started.cookieHeader, 'google-sub-nostate');
    expect(response.status).toBe(400);
  });

  it('署名を書き換えた一時 cookie を拒否する', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    // 1 文字だけ変える。全体を差し替えるより、実際に起こる改竄に近い。
    const parts = started.cookieHeader.split('.');
    const signature = parts[3]!;
    parts[3] = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    const response = await rejected(
      `code=x&state=${FIXED_STATE}`,
      parts.join('.'),
      'google-sub-tampered',
    );
    expect(response.status).toBe(400);
  });

  it('state を差し替えた一時 cookie を拒否する', async () => {
    // 署名の対象が state を含んでいなければ、ここが通ってしまう。
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const parts = started.cookieHeader.split('.');
    parts[0] = `${OAUTH_COOKIE}=attacker-state`;

    const response = await rejected(
      'code=x&state=attacker-state',
      parts.join('.'),
      'google-sub-forgedstate',
    );
    expect(response.status).toBe(400);
  });

  it('別の鍵で署名した一時 cookie を拒否する', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv({ SESSION_SECRET: OTHER_SECRET }));

    const response = await rejected(
      `code=x&state=${FIXED_STATE}`,
      started.cookieHeader,
      'google-sub-otherkey',
    );
    expect(response.status).toBe(400);
  });

  it('期限を過ぎた一時 cookie を拒否する', async () => {
    const started = await startLogin(
      createAuthRoutes({
        exchange: recordExchange(null).exchange,
        now: () => NOW,
        randomToken: fixedRandomToken(),
      }),
      testEnv(),
    );

    const exchanged = recordExchange(buildIdToken({ sub: 'google-sub-expired' }));
    const expiredRoutes = createAuthRoutes({
      exchange: exchanged.exchange,
      // 発行から 601 秒後。Max-Age=600 の窓を 1 秒過ぎている。
      now: () => NOW + 601,
      randomToken: fixedRandomToken(),
    });
    const response = await callback(
      expiredRoutes,
      testEnv(),
      `code=x&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(response.status).toBe(400);
    expect(exchanged.calls).toHaveLength(0);
    expect(await usersBySub('google-sub-expired')).toHaveLength(0);
  });

  it('Google がエラーを返した場合を区別して扱う', async () => {
    const response = await rejected('error=access_denied', undefined, 'google-sub-denied');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'oauth denied', reason: 'access_denied' });
  });

  it('code が無いコールバックを拒否する', async () => {
    const routes = createAuthRoutes({
      exchange: recordExchange(null).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await rejected(`state=${FIXED_STATE}`, started.cookieHeader, 'google-sub-nocode');
    expect(response.status).toBe(400);
  });
});

describe('トークン交換の失敗', () => {
  it('交換に失敗したら users 行を作らない', async () => {
    const exchanged = recordExchange(null);
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
    const response = await callback(
      routes,
      testEnv(),
      `code=x&state=${FIXED_STATE}`,
      started.cookieHeader,
    );

    expect(response.status).toBe(502);
    expect(findCookie(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('受け付けない ID トークンでは users 行を作らない', async () => {
    for (const [label, overrides] of [
      ['別のアプリ向け', { aud: 'other-client-id', sub: 'google-sub-badaud' }],
      ['発行者が違う', { iss: 'https://evil.example.com', sub: 'google-sub-badiss' }],
      ['失効済み', { exp: NOW, sub: 'google-sub-expiredtoken' }],
      ['sub が無い', { sub: '' }],
      ['email が未検証', { email_verified: false, sub: 'google-sub-unverified' }],
    ] as const) {
      const sub = typeof overrides.sub === 'string' ? overrides.sub : '';
      const exchanged = recordExchange(buildIdToken(overrides));
      const routes = createAuthRoutes({
        exchange: exchanged.exchange,
        now: () => NOW,
        randomToken: fixedRandomToken(),
      });
      const started = await startLogin(routes, testEnv());
      const response = await callback(
        routes,
        testEnv(),
        `code=x&state=${FIXED_STATE}`,
        started.cookieHeader,
      );

      expect(response.status, label).toBe(401);
      expect(findCookie(response, SESSION_COOKIE), label).toBeUndefined();
      if (sub !== '') {
        expect(await usersBySub(sub), label).toHaveLength(0);
      }
    }
  });
});

describe('ID トークンの検証', () => {
  it('正しいトークンから同一性を取り出す', () => {
    const result = parseGoogleIdToken(
      buildIdToken({ sub: 'sub-1', email: 'a@example.com', name: 'A' }),
      CLIENT_ID,
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      identity: { sub: 'sub-1', email: 'a@example.com', displayName: 'A' },
    });
  });

  it('name が無ければ email のローカル部を表示名にする', () => {
    // display_name は NOT NULL（5.1）。欠けたときの既定を決めておく。
    const result = parseGoogleIdToken(
      buildIdToken({ sub: 'sub-2', email: 'local-part@example.com', name: undefined }),
      CLIENT_ID,
      NOW,
    );
    expect(result.ok && result.identity.displayName).toBe('local-part');
  });

  it('失効時刻ちょうどを失効として扱う', () => {
    // 境界の向きは招待コード・セッションと揃える（失効時刻を含めて失効）。
    expect(parseGoogleIdToken(buildIdToken({ exp: NOW }), CLIENT_ID, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(parseGoogleIdToken(buildIdToken({ exp: NOW + 1 }), CLIENT_ID, NOW).ok).toBe(true);
  });

  it('accounts.google.com の 2 つの表記をどちらも受け付ける', () => {
    // 片方だけを許すと、もう片方が返った日に全ログインが落ちる。
    for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
      expect(parseGoogleIdToken(buildIdToken({ iss }), CLIENT_ID, NOW).ok, iss).toBe(true);
    }
  });

  it('形の壊れたトークンを拒否する', () => {
    for (const broken of ['', 'a.b', 'a.b.c.d', 'a..c', 'a.@@@.c']) {
      expect(parseGoogleIdToken(broken, CLIENT_ID, NOW).ok, broken).toBe(false);
    }
    const notObject = `${base64UrlJson({})}.${base64UrlJson([1, 2])}.sig`;
    expect(parseGoogleIdToken(notObject, CLIENT_ID, NOW)).toEqual({
      ok: false,
      reason: 'bad-payload',
    });
  });
});

describe('ログアウト（#12 scope.in）', () => {
  it('セッション cookie を発行時と同じ属性で消す', async () => {
    // `redirect: 'manual'` が要る。既定ではランタイムが 303 を追い、`/` の 200 が
    // 返ってきて Set-Cookie が観測できない。
    const response = await SELF.fetch(`${APP_ORIGIN}${LOGOUT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');

    const cookie = findCookie(response, SESSION_COOKIE);
    expect(cookie).toBeDefined();
    // Path が違うとブラウザは別の cookie とみなし、古いものが残る。
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie!.toLowerCase()).not.toContain('domain=');
  });

  it('秘密が未設定でもログアウトできる', async () => {
    // cookie を消すのに鍵は要らない。ここを設定に依存させると、設定を壊した瞬間に
    // ログアウト不能になる。
    const routes = createAuthRoutes({ exchange: recordExchange(null).exchange, now: () => NOW });
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${LOGOUT_PATH}`, { method: 'POST' }),
      bareEnv(),
    );
    expect(response.status).toBe(303);
    expect(findCookie(response, SESSION_COOKIE)).toBeDefined();
  });

  it('GET では受け付けない', async () => {
    // GET なら <img src="/auth/logout"> を踏ませるだけで他人をログアウトさせられる。
    const response = await SELF.fetch(`${APP_ORIGIN}${LOGOUT_PATH}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('経路表への連結', () => {
  it('認証の 3 経路が経路表に登録されている', () => {
    const registered = createAppRoutes(env).map((route) => `${route.method} ${route.path}`);
    expect(registered).toEqual(
      expect.arrayContaining([
        `GET ${LOGIN_PATH}`,
        `GET ${CALLBACK_PATH}`,
        `POST ${LOGOUT_PATH}`,
      ]),
    );
  });
});

describe('ログインの後は、開こうとしていた画面へ戻す（2.3.11 / #374）', () => {
  /**
   * 既存の利用者を 1 人作る（戻り先の検査に招待は要らない）。
   *
   * @param sub Google のアカウント識別子
   * @returns 利用者の id
   */
  async function seedReturningUser(sub: string): Promise<string> {
    const id = `ret-${sub}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, sub, `${sub}@example.com`, '戻る人')
      .run();
    return id;
  }

  /**
   * 一時 cookie を引き継いでログインを開始する。
   *
   * `startLogin` ヘルパとの違いは `Cookie` ヘッダを載せられることだけである。
   * **戻り先はここで引き継がれる**（`state` と `code_verifier` は作り直される）。
   *
   * @param routes 経路表
   * @param target 対象の env
   * @param cookieHeader 画面が積んだ一時 cookie（省略可）
   * @returns 開始の結果
   */
  async function startLoginWith(
    routes: readonly Route[],
    target: Env,
    cookieHeader?: string,
  ): Promise<StartedLogin> {
    const response = await dispatch(
      routes,
      new Request(
        `${APP_ORIGIN}${LOGIN_PATH}`,
        cookieHeader === undefined ? undefined : { headers: { cookie: cookieHeader } },
      ),
      target,
    );
    expect(response.status).toBe(303);
    const cookie = findCookie(response, OAUTH_COOKIE);
    expect(cookie).toBeDefined();
    return {
      response,
      authorize: new URL(response.headers.get('location')!),
      cookieHeader: toCookieHeader(cookie!),
    };
  }

  /**
   * 戻り先を積んだ一時 cookie を作る（画面が未ログインの利用者を送るときと同じ形）。
   *
   * **`loginRequiredRedirect` は値を検証しない**（検証は着地の 1 か所だけにある）。
   * だからこそ、ここへ外部ホストを渡せば「署名は通るが着地させてはいけない戻り先」を
   * 本物の鍵で作れる。query から仕込む経路は、そもそも存在しない。
   *
   * @param returnPath 積む戻り先
   * @returns `Cookie` ヘッダへ載せられる形
   */
  async function stackReturn(returnPath: string): Promise<string> {
    const response = await loginRequiredRedirect(testEnv(), returnPath, {
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    return toCookieHeader(findCookie(response, OAUTH_COOKIE)!);
  }

  /**
   * 戻り先を積んでからログインを最後まで通し、着地のパスを返す。
   *
   * @param sub Google のアカウント識別子（テストごとに変える）
   * @param returnPath 積む戻り先（null なら積まない）
   * @returns `Location` ヘッダの値
   */
  async function landAfterLogin(sub: string, returnPath: string | null): Promise<string> {
    await seedReturningUser(sub);
    const overrides = {
      exchange: recordExchange(buildIdToken({ sub, email: `${sub}@example.com` })).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const pending = returnPath === null ? undefined : await stackReturn(returnPath);
    const started = await startLoginWith(routes, testEnv(), pending);

    const response = await callback(
      routes,
      testEnv(),
      `code=code-return&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
    expect(response.status).toBe(303);
    return response.headers.get('location')!;
  }

  it('未ログインで /account を開き、ログイン後に /account へ着く', async () => {
    // 画面側は既定の依存で動かす（本番と同じ経路で cookie が積まれることを見る）。
    const sub = 'google-sub-return-account';
    await seedReturningUser(sub);

    const guard = await dispatch(
      createAccountRoutes(),
      new Request(`${APP_ORIGIN}${ACCOUNT_PATH}`),
      testEnv(),
    );
    expect(guard.status).toBe(303);
    // 送り先は今までどおり。**変わったのは cookie が 1 枚増えたことだけ**である。
    expect(guard.headers.get('location')).toBe(LOGIN_PATH);
    // 戻り先を query へ出していないこと（オープンリダイレクトの入口を作らない）。
    expect(guard.headers.get('location')).not.toContain(ACCOUNT_PATH);
    const pending = findCookie(guard, OAUTH_COOKIE);
    expect(pending).toBeDefined();

    const overrides = {
      exchange: recordExchange(buildIdToken({ sub, email: `${sub}@example.com` })).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWith(routes, testEnv(), toCookieHeader(pending!));
    // ログインの開始は `state` を作り直す（CSRF と PKCE を守る値は、Google へ送る
    // 要求が持たなければならない）。引き継ぐのは戻り先だけである。
    expect(started.authorize.searchParams.get('state')).toBe(FIXED_STATE);

    const response = await callback(
      routes,
      testEnv(),
      `code=code-account&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(ACCOUNT_PATH);
    expect(findCookie(response, SESSION_COOKIE)).toBeDefined();
  });

  it('戻り先が無いときは / へ着く', async () => {
    expect(await landAfterLogin('google-sub-return-none', null)).toBe('/');
  });

  it('外部へ向く戻り先を仕込んでも / へ着く', async () => {
    // **署名は通る**（`loginRequiredRedirect` が本物の鍵で署名している）。
    // ここを守るのは、着地の直前の検証だけである。
    const evil = [
      '//evil.example',
      '//evil.example/account',
      'https://evil.example/',
      'http://evil.example',
      // `\` を `/` として解釈するブラウザでは、これがプロトコル相対 URL になる。
      '/\\evil.example',
      '/\\/evil.example',
      // スキーム付き（`/` で始まらない）。
      'javascript:alert(1)',
      'data:text/html,x',
      // 相対パス。着地の起点が要求ごとに変わる形は受けない。
      'account',
      '',
    ];
    for (const [index, path] of evil.entries()) {
      expect(await landAfterLogin(`google-sub-evil-${index}`, path), path).toBe('/');
    }
  });

  it('制御文字や長すぎる戻り先を仕込んでも / へ着く', async () => {
    const broken = [
      '/account\nSet-Cookie: x=1',
      '/account\r\n',
      '/account\u0000',
      `/${'a'.repeat(600)}`,
    ];
    for (const [index, path] of broken.entries()) {
      expect(await landAfterLogin(`google-sub-broken-${index}`, path), path).toBe('/');
    }
  });

  it('解き直すと形の変わる戻り先は / へ着く（解釈の層）', async () => {
    // **字句の検査だけでは通ってしまう値**をここへ置く。`URL` に実際に解かせ、
    // 解いた結果が入力と 1 文字も違わないことまで見ている、という層を固定する。
    const normalized = ['/../evil.example', '/./account', '/ account', '/a<b>', '/a b?c=d'];
    for (const [index, path] of normalized.entries()) {
      expect(await landAfterLogin(`google-sub-normalized-${index}`, path), path).toBe('/');
    }
  });

  it('別の鍵で署名された戻り先は引き継がない', async () => {
    // 一時 cookie の署名は `SESSION_SECRET` で行う。鍵が合わない cookie は
    // 「戻り先が無い」のと同じ扱いにする（ログインそのものは落とさない）。
    const sub = 'google-sub-return-otherkey';
    await seedReturningUser(sub);
    const forged = await loginRequiredRedirect(
      testEnv({ SESSION_SECRET: OTHER_SECRET }),
      ACCOUNT_PATH,
      { now: () => NOW, randomToken: fixedRandomToken() },
    );
    const overrides = {
      exchange: recordExchange(buildIdToken({ sub, email: `${sub}@example.com` })).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWith(
      routes,
      testEnv(),
      toCookieHeader(findCookie(forged, OAUTH_COOKIE)!),
    );

    const response = await callback(
      routes,
      testEnv(),
      `code=code-otherkey&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
    expect(response.headers.get('location')).toBe('/');
  });

  it('秘密が未設定でも、ログインへは送る（戻り先は積めない）', async () => {
    // 画面の入口を設定の欠落で塞がない（`handleLogout` と同じ向きの判断）。
    const response = await loginRequiredRedirect(bareEnv(), ACCOUNT_PATH);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(findCookie(response, OAUTH_COOKIE)).toBeUndefined();
  });

  it('自サイト内のパスだけを通す（着地の直前の検証）', () => {
    const allowed = ['/', '/account', '/works/mine', '/works/liked', '/invites', '/works?sort=new'];
    for (const path of allowed) {
      expect(safeReturnPath(path), path).toBe(path);
    }
    const rejected = [null, '', '//evil.example', '/\\evil', 'https://evil.example/', '/a\\b'];
    for (const path of rejected) {
      expect(safeReturnPath(path), String(path)).toBe('/');
    }
  });

  it('ログインが必要な画面から来た未登録の利用者へは、そう言う', async () => {
    // 「登録には招待コードが必要です」だけだと、押した操作と着地した画面がつながらない。
    const sub = 'google-sub-return-noaccount';
    const overrides = {
      exchange: recordExchange(buildIdToken({ sub, email: `${sub}@example.com` })).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWith(routes, testEnv(), await stackReturn(ACCOUNT_PATH));

    const response = await callback(
      routes,
      testEnv(),
      `code=code-noaccount&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SIGNUP_PATH}?reason=${LOGIN_REQUIRED_REASON}`);
    // **戻り先そのものは query へ出さない**（出せば外から与えられる形に戻る）。
    expect(response.headers.get('location')).not.toContain(ACCOUNT_PATH);
    expect(await usersBySub(sub)).toHaveLength(0);
  });

  it('戻り先を積んでいない未登録の利用者は、今までどおり招待の文言で戻る', async () => {
    const sub = 'google-sub-plain-noaccount';
    const overrides = {
      exchange: recordExchange(buildIdToken({ sub, email: `${sub}@example.com` })).exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    };
    const routes = createAuthRoutes(overrides);
    const started = await startLoginWith(routes, testEnv());

    const response = await callback(
      routes,
      testEnv(),
      `code=code-plain&state=${FIXED_STATE}`,
      started.cookieHeader,
    );
    expect(response.headers.get('location')).toBe(`${SIGNUP_PATH}?reason=invite-required`);
  });
});
