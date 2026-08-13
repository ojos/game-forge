import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthRoutes } from '../src/auth/google.js';
import type { TokenExchange } from '../src/auth/google.js';
import { normalizeInviteCode } from '../src/invite-code.js';
import { SIGNUP_PATH, WAITLIST_THANKS_PATH } from '../src/paths.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, verifySession } from '../src/session.js';
import { createSignupRoutes } from '../src/signup.js';
import { waitlistRoutes } from '../src/waitlist.js';
import { applySchema } from './helpers/schema.js';

/**
 * このテストも**ネットワークへ出ない**（`test/auth-google.test.ts` と同じ理由）。
 *
 * 見ているのは #14 の受け入れ条件そのもの、すなわち「無効コードでは OAuth 画面に
 * 到達しない」と「待機リスト登録が保存され、登録数を取得できる」である。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const GOOGLE_AUTHORIZE_HOST = 'accounts.google.com';

const SECRET = 'test-secret-value-for-signup-flow-00001';
const CLIENT_ID = 'signup-test-client-id.apps.googleusercontent.com';
const NOW = 1_780_000_000;

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 's' };
}

/**
 * 招待を 1 枚用意する。
 *
 * @param code 正規形の招待コード（`I` `L` `O` `U` を含められない）
 * @param options 期限や使用済みの指定
 * @returns 発行者の id
 */
async function seedInvite(
  code: string,
  options: { expiresAt?: number; usedBy?: string } = {},
): Promise<string> {
  expect(normalizeInviteCode(code), code).toBe(code);
  const issuerId = `signup-issuer-${code}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(issuerId, `sub-${issuerId}`, `${issuerId}@example.com`, '発行者')
    .run();
  await env.DB.prepare(
    'insert into invites (code, issued_by, expires_at, used_by, used_at) values (?, ?, ?, ?, ?)',
  )
    .bind(code, issuerId, options.expiresAt ?? null, options.usedBy ?? null, options.usedBy ? 1 : null)
    .run();
  return issuerId;
}

/**
 * 登録画面へコードを送る（素の HTML フォームと同じ形）。
 *
 * @param routes 経路表
 * @param code 入力された招待コード
 * @returns レスポンス
 */
async function submitCode(routes: readonly Route[], code: string): Promise<Response> {
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${SIGNUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }).toString(),
    }),
    testEnv(),
  );
}

/**
 * レスポンスが Google の同意画面へ送っているかを判定する。
 *
 * @param response 判定するレスポンス
 * @returns 送っていれば true
 */
function reachesGoogle(response: Response): boolean {
  const location = response.headers.get('location');
  if (location === null) {
    return false;
  }
  try {
    return new URL(location).host === GOOGLE_AUTHORIZE_HOST;
  } catch {
    return false;
  }
}

/**
 * ID トークンを組み立てる（署名は検証されないため形だけ整える）。
 *
 * @param sub Google のアカウント識別子
 * @returns JWT の形をした文字列
 */
function buildIdToken(sub: string): string {
  // btoa は Latin1 しか扱えないため、先に UTF-8 のバイト列へ落とす
  // （表示名に非 ASCII を入れると、ここを飛ばした実装は例外になる）。
  const encode = (value: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };
  return `${encode({ alg: 'RS256' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: NOW + 600,
    sub,
    email: `${sub}@example.com`,
    email_verified: true,
    name: '新入り',
  })}.signature`;
}

beforeAll(async () => {
  await applySchema();
});

describe('無効コードでは OAuth 画面に到達しない（#14 acceptance 1）', () => {
  const routes = createSignupRoutes({ now: () => NOW });

  it('存在しないコードで認可要求を組み立てない', async () => {
    const response = await submitCode(routes, 'ZZZZZZZZZZZZ');
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
    // 一時 cookie も発行しない。発行してしまうと、あとから state だけ揃えて
    // コールバックを叩く足がかりになる。
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('形式が不正なコードで認可要求を組み立てない', async () => {
    for (const invalid of ['', 'short', 'ZZZZZZZZZZZZZZZZ', '<script>alert(1)</script>']) {
      const response = await submitCode(routes, invalid);
      expect(response.status, invalid).toBe(400);
      expect(reachesGoogle(response), invalid).toBe(false);
    }
  });

  it('使用済みのコードで認可要求を組み立てない', async () => {
    const issuerId = await seedInvite('SEEDMARK0001');
    await seedInvite('SEEDMARK0002', { usedBy: issuerId });
    const response = await submitCode(routes, 'SEEDMARK0002');
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
  });

  it('期限切れのコードで認可要求を組み立てない', async () => {
    await seedInvite('EXPRED000001', { expiresAt: NOW - 1 });
    const response = await submitCode(routes, 'EXPRED000001');
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
  });

  it('有効なコードでだけ認可要求を組み立てる', async () => {
    await seedInvite('GRANTPASS001');
    const response = await submitCode(routes, 'GRANTPASS001');
    expect(response.status).toBe(303);
    expect(reachesGoogle(response)).toBe(true);
  });

  it('表示用の区切りと小文字でも受け付ける', async () => {
    await seedInvite('GRANTPASS002');
    const response = await submitCode(routes, 'grant-pass-002');
    expect(response.status).toBe(303);
    expect(reachesGoogle(response)).toBe(true);
  });

  it('検証しただけでは招待を消費しない', async () => {
    // 同意画面で離脱した利用者の招待が戻らなくなるため、ここでは消費しない。
    await seedInvite('PENDNGSEED01');
    await submitCode(routes, 'PENDNGSEED01');
    const row = await env.DB.prepare('select used_by from invites where code = ?')
      .bind('PENDNGSEED01')
      .first<{ used_by: string | null }>();
    expect(row?.used_by).toBeNull();
  });
});

describe('招待を経由した登録が完了する（8.1 の順序）', () => {
  it('コード検証 → OAuth の往復で users 行と invited_by ができる', async () => {
    const issuerId = await seedInvite('FASTPATH0001');
    const exchange: TokenExchange = async () => ({
      ok: true,
      idToken: buildIdToken('google-sub-fullflow'),
    });
    const overrides = { exchange, now: () => NOW };
    const signup = createSignupRoutes(overrides);
    const auth = createAuthRoutes(overrides);

    const started = await submitCode(signup, 'FASTPATH0001');
    expect(started.status).toBe(303);
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const oauthCookie = started.headers.get('set-cookie')!.split(';')[0]!;

    const done = await dispatch(
      auth,
      new Request(`${APP_ORIGIN}/auth/google/callback?code=c&state=${state}`, {
        headers: { cookie: oauthCookie },
      }),
      testEnv(),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/');

    const row = await env.DB.prepare(
      'select id, invited_by from users where google_sub = ?',
    )
      .bind('google-sub-fullflow')
      .first<{ id: string; invited_by: string | null }>();
    expect(row?.invited_by).toBe(issuerId);

    const used = await env.DB.prepare('select used_by from invites where code = ?')
      .bind('FASTPATH0001')
      .first<{ used_by: string | null }>();
    expect(used?.used_by).toBe(row!.id);

    const session = (done.headers.get('set-cookie') ?? '')
      .split(', ')
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!;
    const token = session.split(';')[0]!.slice(`${SESSION_COOKIE}=`.length);
    const verified = await verifySession(token, SECRET, NOW);
    expect(verified.ok && verified.payload.userId).toBe(row!.id);
  });

  it('招待を持たない新規利用者はアカウントを作られない', async () => {
    // 画面を経由せず GET /auth/google/start から入った場合。8.1 の
    // 「生成は招待コード保有者のみ」を、アカウントを作る側でも保証する。
    const exchange: TokenExchange = async () => ({
      ok: true,
      idToken: buildIdToken('google-sub-uninvited'),
    });
    const overrides = { exchange, now: () => NOW };
    const auth = createAuthRoutes(overrides);

    const started = await dispatch(
      auth,
      new Request(`${APP_ORIGIN}/auth/google/start`),
      testEnv(),
    );
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const oauthCookie = started.headers.get('set-cookie')!.split(';')[0]!;

    const done = await dispatch(
      auth,
      new Request(`${APP_ORIGIN}/auth/google/callback?code=c&state=${state}`, {
        headers: { cookie: oauthCookie },
      }),
      testEnv(),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${SIGNUP_PATH}?reason=invite-required`);
    expect(done.headers.get('set-cookie') ?? '').not.toContain(SESSION_COOKIE);

    const row = await env.DB.prepare('select id from users where google_sub = ?')
      .bind('google-sub-uninvited')
      .first();
    expect(row).toBeNull();
  });

  it('同じ google_sub の同時登録で 500 にならず招待も 1 枚しか減らない', async () => {
    // 引き当てと作成の間に別のリクエストが同じ利用者を作る状況。素の INSERT だと
    // UNIQUE 制約違反で 500 になり、利用者にはタブを 2 つ開いただけに見える。
    await seedInvite('RACESAME0001');
    await seedInvite('RACESAME0002');
    const exchange: TokenExchange = async () => ({
      ok: true,
      idToken: buildIdToken('google-sub-same-race'),
    });
    const overrides = { exchange, now: () => NOW };
    const signup = createSignupRoutes(overrides);
    const auth = createAuthRoutes(overrides);

    /**
     * 招待コードから、コールバックまで到達する要求を組み立てる。
     *
     * @param code 招待コード
     * @returns コールバックの Request
     */
    async function preparedCallback(code: string): Promise<Request> {
      const started = await submitCode(signup, code);
      const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
      const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
      return new Request(`${APP_ORIGIN}/auth/google/callback?code=c&state=${state}`, {
        headers: { cookie },
      });
    }

    const requests = await Promise.all([
      preparedCallback('RACESAME0001'),
      preparedCallback('RACESAME0002'),
    ]);
    const responses = await Promise.all(
      requests.map((request) => dispatch(auth, request, testEnv())),
    );

    for (const response of responses) {
      expect(response.status).not.toBe(500);
    }
    const rows = await env.DB.prepare('select count(*) as n from users where google_sub = ?')
      .bind('google-sub-same-race')
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // 負けた側は招待を消費しない。先行の成否が決まる前にその行を掴んで
    // セッションを出すと、直後に消えた users.id を指すセッションが残る。
    const used = await env.DB.prepare(
      "select count(*) as n from invites where code in ('RACESAME0001', 'RACESAME0002') and used_by is not null",
    ).first<{ n: number }>();
    expect(used?.n).toBe(1);

    // 負けた側に発行されたセッションが、存在しない利用者を指していないこと。
    for (const response of responses) {
      const setCookie = response.headers.get('set-cookie') ?? '';
      if (!setCookie.includes(`${SESSION_COOKIE}=`)) {
        continue;
      }
      const token = setCookie
        .split(', ')
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!
        .split(';')[0]!
        .slice(`${SESSION_COOKIE}=`.length);
      const verified = await verifySession(token, SECRET, NOW);
      expect(verified.ok).toBe(true);
      const row = await env.DB.prepare('select id from users where id = ?')
        .bind(verified.ok ? verified.payload.userId : '')
        .first();
      expect(row).not.toBeNull();
    }
  });

  it('招待の消費に失敗したら作った users 行を残さない', async () => {
    // 検証から同意までの間に、同じコードが他所で使われた場合。補償で取り消す。
    const issuerId = await seedInvite('RACETRACK001');
    const exchange: TokenExchange = async () => ({
      ok: true,
      idToken: buildIdToken('google-sub-race'),
    });
    const overrides = { exchange, now: () => NOW };
    const signup = createSignupRoutes(overrides);
    const auth = createAuthRoutes(overrides);

    const started = await submitCode(signup, 'RACETRACK001');
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const oauthCookie = started.headers.get('set-cookie')!.split(';')[0]!;

    // 同意している間に別の誰かが使い切った状況を作る。
    await env.DB.prepare('update invites set used_by = ?, used_at = 1 where code = ?')
      .bind(issuerId, 'RACETRACK001')
      .run();

    const done = await dispatch(
      auth,
      new Request(`${APP_ORIGIN}/auth/google/callback?code=c&state=${state}`, {
        headers: { cookie: oauthCookie },
      }),
      testEnv(),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${SIGNUP_PATH}?reason=used`);
    const row = await env.DB.prepare('select id from users where google_sub = ?')
      .bind('google-sub-race')
      .first();
    expect(row).toBeNull();
  });
});

describe('登録画面', () => {
  const routes = createSignupRoutes({ now: () => NOW });

  it('招待コードの入力欄と待機リストの導線を両方出す', async () => {
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain(`action="${SIGNUP_PATH}"`);
    expect(body).toContain('action="/waitlist"');
    expect(body).toContain('name="code"');
    expect(body).toContain('name="email"');
  });

  it('reason を画面へそのまま流さない', async () => {
    // query から来る値を出力へ通すと、そのまま反射型の差し込みになる。
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}?reason=%3Cscript%3Ealert(1)%3C%2Fscript%3E`),
      testEnv(),
    );
    const body = await response.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('この招待コードは使えません。');
  });

  it('既知の reason は文言を出し分ける', async () => {
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}?reason=invite-required`),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('登録には招待コードが必要です。');
  });

  it('JSON では受け付けない', async () => {
    // この経路は画面のためのもので、API として叩かれる想定が無い。
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'GRANTPASS001' }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
  });

  it('上限を超える本文を読み切らずに拒否する', async () => {
    // 全量を読んでから長さを見る形では、上限を置いた意味を満たさない。
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `code=${'A'.repeat(4096)}`,
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
  });

  it('待機リストの失敗に招待コードの文言を出さない', async () => {
    // 分類ごとに直すべき場所が違う。ここを共通の文言にすると、利用者が
    // メールアドレスではなく招待コードを直そうとする。
    const invalid = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}?reason=waitlist-invalid-email`),
      testEnv(),
    );
    const invalidBody = await invalid.text();
    expect(invalidBody).toContain('メールアドレスの形式が正しくありません。');
    expect(invalidBody).not.toContain('この招待コードは使えません。');

    // 個別の文言を持たない waitlist- 由来の分類も、招待コードの文言へ落ちない。
    const other = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}?reason=waitlist-body-too-large`),
      testEnv(),
    );
    const otherBody = await other.text();
    expect(otherBody).toContain('待機リスト');
    expect(otherBody).not.toContain('この招待コードは使えません。');
  });

  it('code が複数回現れる本文を拒否する', async () => {
    await seedInvite('DBFFEED00001');
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'code=DBFFEED00001&code=ZZZZZZZZZZZZ',
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(reachesGoogle(response)).toBe(false);
  });
});

describe('待機リストの no-JS 送信（#14 acceptance 2）', () => {
  const routes = [...createSignupRoutes({ now: () => NOW }), ...waitlistRoutes];

  /**
   * 素の HTML フォームと同じ形で送る。
   *
   * @param email メールアドレス
   * @returns レスポンス
   */
  async function submitForm(email: string): Promise<Response> {
    return await dispatch(
      routes,
      new Request(`${APP_ORIGIN}/waitlist`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html,application/xhtml+xml',
        },
        body: new URLSearchParams({ email, source: 'signup' }).toString(),
      }),
      testEnv(),
    );
  }

  it('登録が保存され、受け皿へ 303 で送る', async () => {
    const response = await submitForm('nojs@example.com');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(WAITLIST_THANKS_PATH);

    const row = await env.DB.prepare('select source from waitlist where email = ?')
      .bind('nojs@example.com')
      .first<{ source: string | null }>();
    expect(row?.source).toBe('signup');
  });

  it('受け皿の画面が引ける', async () => {
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${WAITLIST_THANKS_PATH}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('待機リストに登録しました');
  });

  it('不正な入力でも JSON を返さず画面へ戻す', async () => {
    const response = await submitForm('not-an-email');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain(SIGNUP_PATH);
  });

  it('fetch からの送信は JSON のままにする', async () => {
    // `Accept` を明示しない fetch の既定（*/*）を HTML と取り違えないこと。
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'fetch@example.com', source: 'signup' }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ registered: true });
  });

  it('登録数を取得できる', async () => {
    // 10.2 の「待機リスト登録率」の分子。正確な件数は countWaitlist が返す。
    const before = await env.DB.prepare('select count(*) as n from waitlist').first<{ n: number }>();
    await submitForm('counted@example.com');
    const after = await env.DB.prepare('select count(*) as n from waitlist').first<{ n: number }>();
    expect(after!.n).toBe(before!.n + 1);
  });
});
