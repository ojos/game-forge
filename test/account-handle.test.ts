import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLE_REDIRECT_NOTICE, createAccountHandleRoutes } from '../src/account-handle.js';
import { ACCOUNT_HANDLE_API_PATH, ACCOUNT_HANDLE_PATH, ACCOUNT_TABS, HANDLE_FIELD } from '../src/account-paths.js';
import { appReservedHandles, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import {
  HANDLE_CHANGES_TABLE,
  HANDLE_RENAME_INTERVAL_SECONDS,
  HANDLE_RESERVATION_DAYS,
  changeHandle,
  currentHandleOf,
} from '../src/handle.js';
import { handlePagePath } from '../src/handle-paths.js';
import { formatJstMinutes } from '../src/jst.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 登録情報の画面の、ハンドル名のタブ（`/account/handle`）と保存の口（#381 / 仕様 5.10）。
 *
 * - **改名の画面で「旧い URL は 90 日間、新しいハンドルへ転送されます」と告げる**（利用者の決定）
 * - **予約語は経路表から導いたものが口に届いている**（`src/app.ts` が注入する。結線を `handleAppRequest` で見る）
 * - **断った要求は書き込まない**（PRG の分類だけを query に載せ、入力は載せない）
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-account-handle-01';

/** 固定の時刻（UNIX 秒）。 */
const NOW = 1_960_000_000;

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
});

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `account-handle-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, 'タブの検査')
    .run();
  return id;
}

/**
 * 利用者のセッション cookie を作る。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 衝突しないハンドル名を作る。
 *
 * @param prefix 先頭の語
 * @returns ハンドル名
 */
function uniqueHandle(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 時刻を固定したハンドル名のタブの経路（予約語は本物の導出を使う）。
 *
 * @param now 現在時刻（UNIX 秒）
 * @returns 経路表
 */
function routesAt(now: number): readonly Route[] {
  return createAccountHandleRoutes({ reservedHandles: () => appReservedHandles(env), now: () => now });
}

/**
 * ハンドル名を送る。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param body フォームの本文
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function post(
  routes: readonly Route[],
  cookie: string | null,
  body: string,
  contentType = 'application/x-www-form-urlencoded',
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_HANDLE_API_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * ハンドル名のタブを開く。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param query query（`?` を含む）
 * @returns レスポンス
 */
async function openTab(routes: readonly Route[], cookie: string | null, query = ''): Promise<Response> {
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_HANDLE_PATH}${query}`, { headers: cookie === null ? {} : { cookie } }),
    testEnv(),
  );
}

/**
 * 利用者の履歴の行数。
 *
 * @param userId 利用者の id
 * @returns 行数
 */
async function historyCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${HANDLE_CHANGES_TABLE} where user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('ハンドル名のタブ', () => {
  it('タブの列に入っていて、未ログインならログインへ送る', async () => {
    expect(ACCOUNT_TABS.map((tab) => tab.path)).toContain(ACCOUNT_HANDLE_PATH);
    const routes = routesAt(NOW);
    const opened = await openTab(routes, null);
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe(LOGIN_PATH);
    const posted = await post(routes, null, `${HANDLE_FIELD}=someone`);
    expect(posted.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('改名すると旧い URL が 90 日間転送されること・30 日に 1 回・予約を、変える前に告げる', async () => {
    const userId = await seedUser();
    const response = await openTab(routesAt(NOW), await cookieFor(userId));
    expect(response.status).toBe(200);
    const body = pageBodyOf(await response.text());
    // **利用者の決定の文言そのもの**（#381 のコメント）。
    expect(HANDLE_REDIRECT_NOTICE).toBe('旧い URL は 90 日間、新しいハンドルへ転送されます');
    expect(body).toContain(HANDLE_REDIRECT_NOTICE);
    expect(body).toContain('30 日に 1 回まで');
    expect(body).toContain(`${HANDLE_RESERVATION_DAYS} 日のあいだ、旧いハンドル名はほかの人が使えません`);
    expect(body).toContain('ハンドル名はまだ決めていません');
    expect(body).toContain('<span aria-current="page">ハンドル名</span>');
  });

  it('決めたハンドル名と、次に変えられる日時を出す', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('shown');
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);
    const body = pageBodyOf(await (await openTab(routesAt(NOW + 60), await cookieFor(userId))).text());
    expect(body).toContain(`<strong>@${handle}</strong>`);
    expect(body).toContain(`href="${handlePagePath(handle)}"`);
    expect(body).toContain(formatJstMinutes(NOW + HANDLE_RENAME_INTERVAL_SECONDS));

    // 30 日を過ぎたら、待つ案内は出さない。
    const later = pageBodyOf(
      await (await openTab(routesAt(NOW + HANDLE_RENAME_INTERVAL_SECONDS), await cookieFor(userId))).text(),
    );
    expect(later).not.toContain('次にハンドル名を変更できるのは');
  });
});

describe('ハンドル名の保存の口', () => {
  it('保存できたら saved へ戻し、小文字で保存する', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('save');
    const response = await post(routesAt(NOW), await cookieFor(userId), `${HANDLE_FIELD}=${handle.toUpperCase()}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_HANDLE_PATH}?saved=1`);
    expect(await currentHandleOf(env.DB, userId)).toEqual({ handle, claimedAt: NOW });
  });

  it('予約語は、アプリの経路表から導いた一覧で断られる（`src/app.ts` の結線）', async () => {
    const userId = await seedUser();
    for (const word of ['works', 'Account', 'avatars', 'official']) {
      const response = await handleAppRequest(
        new Request(`${APP_ORIGIN}${ACCOUNT_HANDLE_API_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: await cookieFor(userId) },
          body: `${HANDLE_FIELD}=${word}`,
        }),
        testEnv(),
      );
      expect(response.headers.get('location'), word).toBe(`${ACCOUNT_HANDLE_PATH}?reason=handle-reserved`);
    }
    expect(await currentHandleOf(env.DB, userId)).toBeNull();
    expect(await historyCount(userId)).toBe(0);
  });

  it('断る理由ごとに分類を返し、入力を URL に載せず、何も書かない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = routesAt(NOW);
    const cases: readonly [string, string][] = [
      [`${HANDLE_FIELD}=`, 'handle-empty'],
      [`${HANDLE_FIELD}=${encodeURIComponent('ｆｏｏｂａｒ')}`, 'handle-invalid'],
      [`${HANDLE_FIELD}=ab`, 'handle-length'],
      [`${HANDLE_FIELD}=${'a'.repeat(2000)}`, 'handle-length'],
      [`${HANDLE_FIELD}=abc&${HANDLE_FIELD}=def`, 'handle-invalid-request'],
    ];
    for (const [body, reason] of cases) {
      const response = await post(routes, cookie, body);
      expect(response.headers.get('location'), body.slice(0, 40)).toBe(`${ACCOUNT_HANDLE_PATH}?reason=${reason}`);
    }
    const json = await post(routes, cookie, JSON.stringify({ handle: 'abcdef' }), 'application/json');
    expect(json.headers.get('location')).toBe(`${ACCOUNT_HANDLE_PATH}?reason=handle-invalid-request`);
    expect(await currentHandleOf(env.DB, userId)).toBeNull();
    expect(await historyCount(userId)).toBe(0);
  });

  it('ほかの人のハンドル名は taken、30 日以内の改名は too-soon で断り、画面が文言を出す', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const handle = uniqueHandle('own');
    expect((await changeHandle(env.DB, owner, handle, NOW)).ok).toBe(true);

    const taken = await post(routesAt(NOW), await cookieFor(other), `${HANDLE_FIELD}=${handle}`);
    expect(taken.headers.get('location')).toBe(`${ACCOUNT_HANDLE_PATH}?reason=handle-taken`);

    const soon = await post(routesAt(NOW + 1), await cookieFor(owner), `${HANDLE_FIELD}=${uniqueHandle('next')}`);
    expect(soon.headers.get('location')).toBe(`${ACCOUNT_HANDLE_PATH}?reason=handle-too-soon`);
    const page = await openTab(routesAt(NOW + 1), await cookieFor(owner), '?reason=handle-too-soon');
    expect(page.status).toBe(400);
    expect(pageBodyOf(await page.text())).toContain('ハンドル名の変更は 30 日に 1 回までです。');

    const unknown = await openTab(routesAt(NOW), await cookieFor(owner), '?reason=%3Cscript%3E');
    const unknownBody = pageBodyOf(await unknown.text());
    expect(unknownBody).toContain('ハンドル名を保存できませんでした。');
    expect(unknownBody).not.toContain('<script>');
  });
});
