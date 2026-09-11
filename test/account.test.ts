import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_CHANGE_INTERVAL_SECONDS,
  DISPLAY_NAME_MAX_LENGTH,
  createAccountRoutes,
  validateDisplayName,
} from '../src/account.js';
import {
  ACCOUNT_DISPLAY_NAME_PATH,
  ACCOUNT_PATH,
  DISPLAY_NAME_FIELD,
} from '../src/account-paths.js';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { toIsoTimestamp } from '../src/jst.js';
import { ssrPagePaths } from '../src/page-paths.js';
import type { Route } from '../src/routes.js';
import { dispatch, findDuplicateRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 登録情報の画面と表示名の変更（#341 / 仕様 5.9）。
 *
 * **#341 の acceptance のうち、この経路が持つものを機械判定できる形へ落とす。**
 *
 * 1. 31 文字・空白だけ・改行を含む名前が弾かれる
 * 2. 60 秒以内の 2 回目が書き込まれない
 * 3. `/account` が未ログインでログインへ送られる
 *
 * 「再ログインで戻らない」「変えていない人は追随する」はログインの経路が持つので
 * `test/auth-google.test.ts`、XSS は `test/display-name-escape.test.ts` が持つ。
 *
 * # 「書き込まれない」を値ではなく UPDATE の発火で見る
 *
 * **断った要求の後に値が変わっていないことだけを見ると、「同じ値を書き直す」実装が
 * 緑になる**（`set display_name = case when ... then ? else display_name end` の形）。
 * それは 5.9 が禁じている「断った要求を書き込む」そのもので、連打を止める意味が無い。
 * そこで**このファイルの利用者だけに効くトリガ**を張り、`users` の行に UPDATE が
 * 1 回でも届いたかを数える。値が同じでも、行が WHERE に当たればトリガは発火する。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-account-page-0001';

/** このファイルが作る利用者の id の接頭辞。トリガの対象をここへ絞る。 */
const USER_PREFIX = 'acct-';

/** 固定の時刻（UNIX 秒）。60 秒の境界をこれを起点に動かす。 */
const NOW = 1_800_000_000;

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

beforeAll(async () => {
  await applySchema();
  // **このファイルの利用者だけを数える。** `users` はテストファイルをまたいで共有される
  // ので、条件を付けずに張ると他のファイルの UPDATE まで数える。
  await env.DB.prepare(
    'create table if not exists account_test_user_updates (user_id text not null)',
  ).run();
  await env.DB.prepare(
    `create trigger if not exists account_test_count_user_updates
       after update on users
       when new.id like '${USER_PREFIX}%'
     begin
       insert into account_test_user_updates (user_id) values (new.id);
     end`,
  ).run();
});

afterAll(async () => {
  await env.DB.prepare('drop trigger if exists account_test_count_user_updates').run();
  await env.DB.prepare('drop table if exists account_test_user_updates').run();
});

/**
 * 利用者を 1 人用意する。
 *
 * @param overrides 列の指定
 * @returns 利用者の id
 */
async function seedUser(
  overrides: {
    readonly displayName?: string;
    readonly email?: string;
    readonly createdAt?: number;
    readonly displayNameSetAt?: number | null;
  } = {},
): Promise<string> {
  const id = `${USER_PREFIX}${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, display_name_set_at)
     values (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `sub-${id}`,
      overrides.email ?? `${id}@example.com`,
      overrides.displayName ?? 'Google の名前',
      overrides.createdAt ?? 1,
      overrides.displayNameSetAt ?? null,
    )
    .run();
  return id;
}

/**
 * 利用者のセッション cookie（`Cookie` ヘッダへ載せる形）を作る。
 *
 * **発行時刻は実時刻にする。** `resolveSessionUser` は実時刻で期限を見るので、
 * 固定の過去時刻で署名すると期限切れとして断られる。
 *
 * @param userId 利用者の id
 * @returns `名前=値`
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * `users` から表示名とその時刻を引く。
 *
 * @param userId 利用者の id
 * @returns 表示名と `display_name_set_at`
 */
async function nameOf(
  userId: string,
): Promise<{ display_name: string; display_name_set_at: number | null }> {
  const row = await env.DB.prepare(
    'select display_name, display_name_set_at from users where id = ?',
  )
    .bind(userId)
    .first<{ display_name: string; display_name_set_at: number | null }>();
  expect(row, `${userId} の行`).not.toBeNull();
  return row!;
}

/**
 * その利用者の行に UPDATE が届いた回数（上のトリガが数えたもの）。
 *
 * @param userId 利用者の id
 * @returns 回数
 */
async function updatesOf(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'select count(*) as n from account_test_user_updates where user_id = ?',
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 表示名の変更を送る。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param name 送る表示名（項目ごと省くなら null）
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function postName(
  routes: readonly Route[],
  cookie: string | null,
  name: string | null,
  contentType = 'application/x-www-form-urlencoded',
): Promise<Response> {
  const body = name === null ? '' : new URLSearchParams({ [DISPLAY_NAME_FIELD]: name }).toString();
  const headers: Record<string, string> = { 'content-type': contentType, accept: 'text/html' };
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_DISPLAY_NAME_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * 登録情報の画面を開く。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param query query 文字列（`?` を含む。省略可）
 * @returns レスポンス
 */
async function openAccount(cookie: string | null, query = ''): Promise<Response> {
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${ACCOUNT_PATH}${query}`, {
      headers: cookie === null ? {} : { cookie },
    }),
    testEnv(),
  );
}

describe('経路の登録（#341）', () => {
  it('画面と変更の口がアプリの経路表に載っている', () => {
    const registered = createAppRoutes(testEnv()).map((route) => `${route.method} ${route.path}`);
    expect(registered).toContain(`GET ${ACCOUNT_PATH}`);
    expect(registered).toContain(`POST ${ACCOUNT_DISPLAY_NAME_PATH}`);
    expect(findDuplicateRoutes(createAppRoutes(testEnv()))).toEqual([]);
  });

  it('/account が SSR 画面として導かれ、全画面の外枠検査（M8-1）の対象に入る', () => {
    // `test/page-shell.test.ts` は `ssrPagePaths` の結果を歩く。**ここに入っていれば、
    // app.css への link・viewport・ヘッダ・フッタの検査が /account にも掛かる。**
    // 変更の口は `/api/` なので画面から外れる（`src/page-paths.ts` の接頭辞）。
    const paths = ssrPagePaths(createAppRoutes(testEnv()));
    expect(paths).toContain(ACCOUNT_PATH);
    expect(paths).not.toContain(ACCOUNT_DISPLAY_NAME_PATH);
  });
});

describe('登録情報の画面（GET /account）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openAccount(null);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('署名の壊れた cookie でもログインへ送る（画面を出さない）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const response = await openAccount(`${cookie}x`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('表示名・メールアドレス・登録日（日本時間）を出す', async () => {
    // 2026-09-10T15:30:00Z は日本時間で 2026-09-11 00:30。**日付が繰り上がる時刻を選ぶ**
    // ——UTC のまま日付を出す実装なら 09-10 になって赤くなる。
    const createdAt = Date.UTC(2026, 8, 10, 15, 30, 0) / 1000;
    const userId = await seedUser({
      displayName: '登録情報の人',
      email: 'account-owner@example.com',
      createdAt,
    });
    const response = await openAccount(await cookieFor(userId));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('value="登録情報の人"');
    expect(body).toContain('account-owner@example.com');
    expect(body).toContain(`<time datetime="${toIsoTimestamp(createdAt)}">2026-09-11</time>`);
    // 本人にしか出ない画面である。
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('メールアドレスは本人のものしか出ない', async () => {
    // **画面は利用者を引数に取らない。** 他人の id を query に付けても本人の行を引く。
    const other = await seedUser({ email: 'someone-else@example.com' });
    const me = await seedUser({ email: 'me-myself@example.com' });
    const response = await openAccount(await cookieFor(me), `?user=${other}&id=${other}`);
    const body = await response.text();
    expect(body).toContain('me-myself@example.com');
    expect(body).not.toContain('someone-else@example.com');
  });

  it('Google に追随しているか、決めた名前かを言い分ける', async () => {
    const following = await seedUser({ displayNameSetAt: null });
    const decided = await seedUser({ displayNameSetAt: NOW });
    const followingBody = await (await openAccount(await cookieFor(following))).text();
    const decidedBody = await (await openAccount(await cookieFor(decided))).text();
    expect(followingBody).toContain('ログインのたびに Google 側の名前に合わせます');
    expect(decidedBody).toContain('ログインしても Google アカウントの名前には戻りません');
  });

  it('断った理由を固定の文言で出し、query の値そのものは出さない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);

    const tooLong = await openAccount(cookie, '?reason=too-long');
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain(`表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字までです。`);

    // 未知の値は既定の文言へ倒す。**反射させない。**
    const injected = await openAccount(cookie, `?reason=${encodeURIComponent('<b>x</b>')}`);
    expect(injected.status).toBe(400);
    const body = await injected.text();
    expect(body).not.toContain('<b>x</b>');
    expect(body).toContain('表示名を変更できませんでした。');
  });

  it('変更できた後は、その旨を 200 で出す', async () => {
    const userId = await seedUser();
    const response = await openAccount(await cookieFor(userId), '?saved=1');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('表示名を変更しました。');
  });
});

describe('表示名の検査（5.9）', () => {
  it('前後の空白を除いた値を返す', () => {
    expect(validateDisplayName('  新しい名前　 ')).toEqual({ ok: true, value: '新しい名前' });
  });

  it(`${DISPLAY_NAME_MAX_LENGTH} 文字ちょうどは通し、${DISPLAY_NAME_MAX_LENGTH + 1} 文字は弾く`, () => {
    expect(validateDisplayName('あ'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateDisplayName('あ'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('長さをコードポイントで数える（サロゲート対を 2 文字と数えない）', () => {
    // '😀' は UTF-16 で 2 単位。`String#length` で数える実装なら 15 個で上限に達する。
    const emoji = '😀'.repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(emoji.length).toBe(DISPLAY_NAME_MAX_LENGTH * 2);
    expect(validateDisplayName(emoji).ok).toBe(true);
    expect(validateDisplayName(`${emoji}😀`)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('空・空白だけ（全角空白を含む）を弾く', () => {
    for (const raw of ['', ' ', '   ', '　　', ' 　 ']) {
      expect(validateDisplayName(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('改行・タブ・その他の制御文字を真ん中に含む名前を弾く', () => {
    for (const raw of [
      '一行目\n二行目',
      '一行目\r\n二行目',
      '一行目\r二行目',
      'タブ\t入り',
      'ヌル\u0000入り',
      'DEL\u007f入り',
      'NEL\u0085入り',
      '行区切り\u2028入り',
      '段落区切り\u2029入り',
    ]) {
      expect(validateDisplayName(raw), JSON.stringify(raw)).toEqual({
        ok: false,
        reason: 'control-char',
      });
    }
  });

  it('HTML に効く文字は通す（防ぐのは出力側のエスケープである）', () => {
    // 5.9「保存時の制約は XSS を防がない」。ここで弾く実装にすると、出力側のエスケープが
    // 抜けていても気づけなくなる。
    expect(validateDisplayName('"><script>alert(1)</script>')).toEqual({
      ok: true,
      value: '"><script>alert(1)</script>',
    });
  });
});

describe('表示名の変更（POST /api/account/display-name）', () => {
  it('変更して /account へ戻し、以後 Google に追随しない印を付ける', async () => {
    const userId = await seedUser({ displayName: 'Google の名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), '  決めた名前  ');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=1`);
    expect(await nameOf(userId)).toEqual({ display_name: '決めた名前', display_name_set_at: NOW });
    expect(await updatesOf(userId)).toBe(1);
  });

  it('同じ名前を入れ直しても書く（Google に追随するのをやめる唯一の方法）', async () => {
    const userId = await seedUser({ displayName: 'そのままの名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), 'そのままの名前');
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=1`);
    expect(await nameOf(userId)).toEqual({
      display_name: 'そのままの名前',
      display_name_set_at: NOW,
    });
  });

  it('未ログインならログインへ送り、何も書かない', async () => {
    const userId = await seedUser();
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, null, '勝手な名前');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await updatesOf(userId)).toBe(0);
  });

  it('31 文字・空白だけ・改行入りを弾き、1 行も書かない', async () => {
    const userId = await seedUser({ displayName: '元の名前' });
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });

    const cases: readonly [string | null, string][] = [
      ['あ'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'too-long'],
      ['   ', 'empty'],
      ['　', 'empty'],
      [null, 'empty'],
      ['一行目\n二行目', 'control-char'],
    ];
    for (const [name, reason] of cases) {
      const response = await postName(routes, cookie, name);
      expect(response.status, JSON.stringify(name)).toBe(303);
      expect(response.headers.get('location'), JSON.stringify(name)).toBe(
        `${ACCOUNT_PATH}?reason=${reason}`,
      );
    }
    expect(await nameOf(userId)).toEqual({ display_name: '元の名前', display_name_set_at: null });
    expect(await updatesOf(userId)).toBe(0);
  });

  it('長すぎる本文は 413 ではなく「長すぎる名前」として戻す', async () => {
    const userId = await seedUser({ displayName: '元の名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), 'あ'.repeat(2000));
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=too-long`);
    expect(await updatesOf(userId)).toBe(0);
  });

  it('フォーム以外の形式は受けず、書かない', async () => {
    const userId = await seedUser({ displayName: '元の名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), '新しい名前', 'text/plain');
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=invalid-request`);
    expect(await updatesOf(userId)).toBe(0);
  });

  it(`${DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} 秒以内の 2 回目は書き込まず、空けば書く`, async () => {
    const userId = await seedUser({ displayName: 'Google の名前' });
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });

    expect((await postName(routes, cookie, '1 回目')).headers.get('location')).toBe(
      `${ACCOUNT_PATH}?saved=1`,
    );
    expect(await updatesOf(userId)).toBe(1);

    // **境界の 1 秒手前。** 断り、UPDATE を 1 回も届かせない。
    now = NOW + DISPLAY_NAME_CHANGE_INTERVAL_SECONDS - 1;
    const tooSoon = await postName(routes, cookie, '2 回目');
    expect(tooSoon.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=too-soon`);
    expect(await nameOf(userId)).toEqual({ display_name: '1 回目', display_name_set_at: NOW });
    expect(await updatesOf(userId)).toBe(1);

    // **ちょうど 60 秒で書く**（5.9「60 秒以上空いた要求だけ書く」）。
    now = NOW + DISPLAY_NAME_CHANGE_INTERVAL_SECONDS;
    const later = await postName(routes, cookie, '3 回目');
    expect(later.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=1`);
    expect(await nameOf(userId)).toEqual({ display_name: '3 回目', display_name_set_at: now });
    expect(await updatesOf(userId)).toBe(2);
  });

  it('既に決めた名前がある利用者も、前回から 60 秒以内なら断る', async () => {
    // 間隔は「この画面を開いてから」ではなく `display_name_set_at` から数える。
    const userId = await seedUser({ displayName: '前の名前', displayNameSetAt: NOW - 30 });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), '次の名前');
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=too-soon`);
    expect(await updatesOf(userId)).toBe(0);
  });

  it('BAN された利用者は変えられない', async () => {
    const userId = await seedUser({ displayName: '元の名前' });
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(userId).run();
    const before = await updatesOf(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), '新しい名前');
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await updatesOf(userId)).toBe(before);
  });

  it('変えた名前が /account に出る（往復）', async () => {
    const userId = await seedUser({ displayName: 'Google の名前' });
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    await postName(routes, cookie, '往復した名前');
    const body = await (await openAccount(cookie, '?saved=1')).text();
    expect(body).toContain('value="往復した名前"');
    expect(body).toContain('ログインしても Google アカウントの名前には戻りません');
  });
});
