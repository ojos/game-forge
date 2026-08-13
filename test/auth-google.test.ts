import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { appRoutes } from '../src/app.js';
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  OAUTH_COOKIE,
  createAuthRoutes,
  parseGoogleIdToken,
} from '../src/auth/google.js';
import type { TokenExchange, TokenExchangeParams } from '../src/auth/google.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, verifySession } from '../src/session.js';
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
    const exchanged = recordExchange(buildIdToken({ sub, email: 'first@example.com', name: '最初の人' }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());

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
    // 招待との結線は #14（T7）が持つ。ここで埋めない。
    expect(rows[0]!.invited_by).toBeNull();

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
    const first = recordExchange(buildIdToken({ sub, email: 'old@example.com', name: '旧名' }));
    const routesFirst = createAuthRoutes({
      exchange: first.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const startedFirst = await startLogin(routesFirst, testEnv());
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
    const exchanged = recordExchange(buildIdToken({ sub: 'google-sub-discard' }));
    const routes = createAuthRoutes({
      exchange: exchanged.exchange,
      now: () => NOW,
      randomToken: fixedRandomToken(),
    });
    const started = await startLogin(routes, testEnv());
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
  it('認証の 3 経路が appRoutes に登録されている', () => {
    const registered = appRoutes.map((route) => `${route.method} ${route.path}`);
    expect(registered).toEqual(
      expect.arrayContaining([
        `GET ${LOGIN_PATH}`,
        `GET ${CALLBACK_PATH}`,
        `POST ${LOGOUT_PATH}`,
      ]),
    );
  });
});
