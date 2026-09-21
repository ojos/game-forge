import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthRoutes } from '../src/auth/google.js';
import type { TokenExchange } from '../src/auth/google.js';
import { normalizeInviteCode } from '../src/invite-code.js';
import { SIGNUP_PATH, WAITLIST_PATH, WAITLIST_THANKS_PATH } from '../src/paths.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH, LOGIN_REQUIRED_REASON } from '../src/auth/google.js';
import {
  SESSION_COOKIE,
  buildSessionCookie,
  signSession,
  verifySession,
} from '../src/session.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
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
 * @param cookie 送る `Cookie` ヘッダ（空文字なら未ログイン）
 * @returns レスポンス
 */
async function submitCode(
  routes: readonly Route[],
  code: string,
  cookie = '',
): Promise<Response> {
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${SIGNUP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
      },
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
    expect(body).toContain(`action="${WAITLIST_PATH}"`);
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

  it('ログインが必要な画面から送られてきた人に、そう言う（2.3.11 / #374）', async () => {
    // 「登録には招待コードが必要です」だけだと、押した操作と着地した画面がつながらない
    // （開こうとしたのは登録画面ではない）。
    const response = await dispatch(
      routes,
      new Request(`${APP_ORIGIN}${SIGNUP_PATH}?reason=${LOGIN_REQUIRED_REASON}`),
      testEnv(),
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('この画面にはログインが必要です。');
    // 戻り先そのものは画面へ出さない（query に載っていないものは出しようがない）。
    expect(body).not.toContain(`${SIGNUP_PATH}?reason=`);
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

/**
 * ログイン・登録の画面の形（仕様 2.3.1 / 2.3.11 の #435 注記 / 2.5.5 / #472）。
 *
 * **並びは HTML の順だけで決まる**（app.css は `order` を使わない。仕様 2.5.6 の #469 実装注記）ので、
 * 本文の中の出現順を見れば、見た目の順と Tab の順も見たことになる。実ブラウザでの並びは PR で確かめた。
 */
describe('ログイン・登録の画面（#472）', () => {
  const routes = createSignupRoutes({ now: () => NOW });

  /**
   * 画面を開いて本文（パンくずの後からフッタの前まで）を返す。
   *
   * @param query 付ける query（無ければ空文字）
   * @returns 本文の HTML
   */
  async function mainOf(query = ''): Promise<string> {
    const response = await dispatch(routes, new Request(`${APP_ORIGIN}${SIGNUP_PATH}${query}`), testEnv());
    const body = await response.text();
    const start = body.indexOf('<h1>');
    const end = body.indexOf('<footer');
    expect(start, '本文の <h1> が無い').toBeGreaterThan(-1);
    expect(end, 'フッタが無い').toBeGreaterThan(start);
    return body.slice(start, end);
  }

  /**
   * 3 つのブロックを HTML の順に取り出す。
   *
   * @param main 本文の HTML
   * @returns ブロックごとの HTML
   */
  function blocksOf(main: string): string[] {
    return [...main.matchAll(/<section class="gf-block gf-signup-option"[\s\S]*?<\/section>/gu)].map((match) => match[0]);
  }

  it('題名と <h1> が「ログイン・登録」である', async () => {
    const response = await dispatch(routes, new Request(`${APP_ORIGIN}${SIGNUP_PATH}`), testEnv());
    const body = await response.text();
    expect(body).toContain('<title>ログイン・登録 - Game Forge</title>');
    expect(body.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gu)).toEqual(['<h1>ログイン・登録</h1>']);
    expect(body).not.toContain('Game Forge に登録する');
  });

  it('3 つのブロックが、ログイン・招待コード・待機リストの順に並ぶ', async () => {
    const blocks = blocksOf(await mainOf());
    // 見出しの文節の区切り（`<wbr>`。#510）は文字を足さないので、外して文言を比べる。
    expect(blocks.map((block) => /<h2[^>]*>((?:[^<]|<wbr>)*)<\/h2>/u.exec(block)?.[1]?.replaceAll('<wbr>', ''))).toEqual([
      'すでにアカウントをお持ちの方',
      '招待コードをお持ちの方',
      '招待コードをお持ちでない方',
    ]);
    // 中身もその順で入っている（見出しだけを並べ替えた形を通さない）。
    expect(blocks[0]).toContain('Google でログイン');
    expect(blocks[1]).toContain(`action="${SIGNUP_PATH}"`);
    expect(blocks[1]).toContain('name="code"');
    expect(blocks[2]).toContain(`action="${WAITLIST_PATH}"`);
    expect(blocks[2]).toContain('name="email"');
    // 3 つはひとつの並べ枠の中にある（折り返しで並べる枠。app.css の `@section signup`）。
    expect(await mainOf()).toMatch(/<div class="gf-signup-options">\s*<section class="gf-block gf-signup-option"/u);
  });

  it('3 つの見出しは、文節の区切りにだけ <wbr> を持ち、id と文言は変わらない（#510）', async () => {
    const blocks = blocksOf(await mainOf());
    // **見出しの要素をそのまま比べる。** 区切りの位置・`id`・中に他の要素が無いことを 1 度に見る
    // （`aria-labelledby` が読む名前は `<wbr>` を除いた文字で、`id` が変わると名前を失う）。
    expect(blocks.map((block) => /<h2\b[^>]*>[\s\S]*?<\/h2>/u.exec(block)?.[0])).toEqual([
      '<h2 id="signup-login">すでに<wbr>アカウントを<wbr>お持ちの方</h2>',
      '<h2 id="signup-invite">招待コードを<wbr>お持ちの方</h2>',
      '<h2 id="signup-waitlist">招待コードを<wbr>お持ちでない方</h2>',
    ]);
    expect(blocks.map((block) => /aria-labelledby="([^"]+)"/u.exec(block)?.[1])).toEqual([
      'signup-login',
      'signup-invite',
      'signup-waitlist',
    ]);
  });

  it('見出しは区切りの外で折れない（app.css の `@section signup` が `word-break: keep-all` を持ち、幅の @media を置かない。#510）', () => {
    const css = env.TEST_APP_CSS;
    // **区画の見出しの行で切る**（`@section signup` という綴りは `@section shell` のコメントにも出てくる）。
    const start = css.indexOf('   @section signup —');
    const end = css.indexOf('   @section news —');
    expect(start, '`@section signup` が無い（検査が空振りする）').toBeGreaterThan(-1);
    expect(end, '`@section signup` の次の区画が無い').toBeGreaterThan(start);
    const section = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const rule = /\.gf-signup-option\s*>\s*h2\s*\{([^}]*)\}/u.exec(section);
    expect(rule, '見出しの規則が無い').not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|;)\s*word-break:\s*keep-all\s*;/u);
    // 器より長い塊だけは折る——`body` の `overflow-wrap: anywhere` を見出しで打ち消さない。
    expect(section).not.toMatch(/overflow-wrap:\s*normal|white-space:\s*nowrap/u);
    expect(section).not.toContain('@media');
  });

  it('主のボタンは「Google でログイン」の 1 つだけで、`<a>` で Google の認証へ送る（仕様 2.5.5 / 2.3.11 の #435 注記）', async () => {
    const main = await mainOf();
    const primaries = [...main.matchAll(/<(a|button)\b[^>]*\bgf-button-primary\b[^>]*>([^<]*)<\/\1>/gu)];
    expect(primaries.map((match) => match[0])).toEqual([
      `<a class="gf-button gf-button-primary" href="${LOGIN_PATH}">Google でログイン</a>`,
    ]);
    // 残る 2 つの送信は副のボタン（要素は動作なので <button>）。
    expect(main.match(/<button class="gf-button gf-button-secondary" type="submit">[^<]*<\/button>/gu)).toEqual([
      '<button class="gf-button gf-button-secondary" type="submit">コードを確認して Google でログイン</button>',
      '<button class="gf-button gf-button-secondary" type="submit">待機リストに登録する</button>',
    ]);
  });

  it('JavaScript を要求しない（素の <form method="post"> で、スクリプトを持たない）', async () => {
    const main = await mainOf();
    const forms = main.match(/<form\b[^>]*>/gu) ?? [];
    expect(forms).toEqual([
      `<form method="post" action="${SIGNUP_PATH}">`,
      `<form method="post" action="${WAITLIST_PATH}">`,
    ]);
    expect(main).not.toContain('<script');
  });

  it('ログインが必要な画面から戻ってきたときの通知は、3 つのブロックより前に出る（2.3.11）', async () => {
    const main = await mainOf(`?reason=${LOGIN_REQUIRED_REASON}`);
    const alert = main.indexOf('<p class="error" role="alert">この画面にはログインが必要です。');
    expect(alert).toBeGreaterThan(-1);
    expect(alert).toBeLessThan(main.indexOf('<div class="gf-signup-options">'));
  });

  it('「改造する」から来た人への前置きを残し、待機リストの記録には導線を渡す（2.2-4 / 10.2）', async () => {
    const main = await mainOf('?from=fork-cta');
    const intro = main.indexOf('フォークできるのは招待された方だけです');
    expect(intro).toBeGreaterThan(-1);
    expect(intro).toBeLessThan(main.indexOf('<div class="gf-signup-options">'));
    expect(blocksOf(main)[2]).toContain('<input type="hidden" name="source" value="fork-cta">');
  });

  it('待機人数と案内は、待機リストのブロックの中に出す（丸めて 0 のときは人数を出さない）', async () => {
    // **件数は 10 件単位に丸めて出す**（`coarsenWaitlistCount`）。この describe の時点での件数から、丸めた値が
    // 0 か否かを決めて見る——ほかの検査が積んだ行で結果が変わっても、空振りも誤検知もしない。
    const countNow = async (): Promise<number> =>
      (await env.DB.prepare('select count(*) as n from waitlist').first<{ n: number }>())!.n;
    const blockNow = async (): Promise<string> => blocksOf(await mainOf())[2]!;

    const before = await countNow();
    const first = await blockNow();
    expect(first).toContain('<p class="gf-signup-note">招待枠が空いたらご連絡します。</p>');
    if (before < 10) {
      expect(await mainOf()).not.toContain('人以上が登録して待っています');
    }

    await env.DB.batch(
      Array.from({ length: 10 }, (_, index) =>
        env.DB.prepare('insert into waitlist (id, email, source, created_at) values (?, ?, ?, ?)').bind(
          `signup-count-${index}`,
          `signup-count-${index}@example.com`,
          'signup',
          NOW,
        ),
      ),
    );
    const expected = Math.floor((before + 10) / 10) * 10;
    const main = await mainOf();
    expect(blocksOf(main)[2]).toContain(
      `<p class="gf-signup-note">現在 ${expected} 人以上が登録して待っています。</p>`,
    );
    // ほかのブロックには出さない。
    expect(main.split('人以上が登録して待っています')).toHaveLength(2);
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
      new Request(`${APP_ORIGIN}${WAITLIST_PATH}`, {
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
    const body = await response.text();
    expect(body).toContain('待機リストに登録しました');
    // **戻り先の文言は、戻る画面の名前に合わせる**（#472）。
    expect(body).toContain(`<a href="${SIGNUP_PATH}">ログイン・登録の画面へ戻る</a>`);
    expect(body).not.toContain('登録画面へ戻る');
    // **検索避けする**（#610）。操作を終えた人だけが見る画面で、検索から来てもその人は
    // 待機リストに載っていない。**サイトマップから外すこととは別である**——載せなくても、
    // クローラは辿り着けば索引に載せる。
    expect(body).toContain('<meta name="robots" content="noindex">');
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
      new Request(`${APP_ORIGIN}${WAITLIST_PATH}`, {
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

/**
 * 断られた登録画面のヘッダ（2.3.7 / #331 / PR #353 の Copilot code review）。
 *
 * **`POST /signup` は、断ったときに同じ画面をその場で返す**（303 で逃がすと失敗の理由が
 * URL に残る。`signupError`）。**やり直す先が同じ画面である以上、外枠も同じでなければ
 * ならない**——到達した経路でヘッダが変わると、ログイン済みの利用者だけが自分の画面で
 * 「ログイン」を出される。
 */
describe('断られた登録画面のヘッダ（2.3.7）', () => {
  const routes = createSignupRoutes({ now: () => NOW });

  /**
   * HTML からヘッダの区画だけを取り出す。
   *
   * **本文を巻き込まない。** この画面の本文には「すでにアカウントをお持ちの方」の
   * ログイン導線が**正しく**在るので、全文で照合すると常に真になる。
   *
   * @param body HTML
   * @returns `<header>` の中身
   */
  function headerOf(body: string): string {
    const header = /<header class="gf-header">[\s\S]*?<\/header>/u.exec(body);
    expect(header, 'ヘッダが無い（検査が空振りする）').not.toBeNull();
    return header![0];
  }

  it('未ログインで断られたら、ヘッダの「ログイン」はログイン・登録（この画面）へ送る', async () => {
    const response = await submitCode(routes, 'ZZZZZZZZZZZZ');
    expect(response.status).toBe(400);
    const header = headerOf(await response.text());
    // **ヘッダの「ログイン」の行き先は `/signup`**（2.3.7 の #435 注記 / #472）。Google の認証へは直接送らない。
    expect(header).toContain(`href="${SIGNUP_PATH}"`);
    expect(header).not.toContain(`href="${LOGIN_PATH}"`);
    expect(header).not.toContain(`href="${MY_WORKS_PATH}"`);
  });

  it('ログイン済みで断られても、ヘッダは自分の作品と設定のままである', async () => {
    // **ログイン済みの利用者も無効なコードを送れる**（2 本目の招待を試す、など）。
    // ここが cookie を見ないと、その人のヘッダだけが「ログイン」に戻る。
    // **実時刻で署名する。** `NOW`（この検査が経路へ渡す固定時刻）は過去の日付なので、
    // それで作ると期限切れになり、**未ログイン扱いのまま緑に見える**（`verifySession` は
    // 既定で実時刻を見る）。
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { userId: 'signup-header-user', issuedAt, expiresAt: issuedAt + 3600 },
      SECRET,
    );
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;

    const response = await submitCode(routes, 'ZZZZZZZZZZZZ', cookie);
    expect(response.status).toBe(400);
    const header = headerOf(await response.text());
    expect(header).toContain(`href="${MY_WORKS_PATH}"`);
    expect(header).toContain(`href="${ACCOUNT_PATH}"`);
    expect(header).not.toContain(`href="${SIGNUP_PATH}"`);
    expect(header).not.toContain(`href="${LOGIN_PATH}"`);
  });
});
