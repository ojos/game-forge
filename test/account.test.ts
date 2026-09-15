import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_CHANGE_INTERVAL_SECONDS,
  DISPLAY_NAME_MAX_LENGTH,
  FORK_NOTICE_UNMUTE_INTERVAL_SECONDS,
  changeDisplayName,
  createAccountRoutes,
  validateDisplayName,
} from '../src/account.js';
import { DISPLAY_NAME_CHANGES_TABLE } from '../src/display-name-changes.js';
import {
  ACCOUNT_DETAILS_PATH,
  ACCOUNT_DISPLAY_NAME_PATH,
  ACCOUNT_MAIL_API_PATH,
  ACCOUNT_MAIL_PATH,
  ACCOUNT_PATH,
  ACCOUNT_TABS,
  DISPLAY_NAME_FIELD,
  FORK_NOTICE_FIELD,
  FORK_NOTICE_MUTE,
  FORK_NOTICE_RECEIVE,
} from '../src/account-paths.js';
import { notifyForkPublished } from '../src/mail/fork-notice.js';
import { MAIL_KINDS, unmutableUserMailKinds } from '../src/mail/kinds.js';
import { sendMail } from '../src/mail/resend.js';
import { ACCOUNT_PROFILE_PATH } from '../src/profile-paths.js';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import { LOGIN_PATH, LOGOUT_PATH, OAUTH_COOKIE } from '../src/auth/google.js';
import { toIsoTimestamp } from '../src/jst.js';
import { ssrPagePaths } from '../src/page-paths.js';
import type { Route } from '../src/routes.js';
import { dispatch, findDuplicateRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { OPERATOR_MARK, workPagePath } from '../src/work-page.js';
import { applySchema } from './helpers/schema.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { pageBodyOf } from './helpers/site-shell.js';

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

/**
 * 登録情報の画面のアカウントのタブ（`/account/details`。#379）を開く。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param query query 文字列（`?` を含む。省略可）
 * @returns レスポンス
 */
async function openDetails(cookie: string | null, query = ''): Promise<Response> {
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${ACCOUNT_DETAILS_PATH}${query}`, {
      headers: cookie === null ? {} : { cookie },
    }),
    testEnv(),
  );
}

/**
 * 登録情報の画面のメール配信のタブ（`/account/mail`。#384）を開く。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param query query 文字列（`?` を含む。省略可）
 * @returns レスポンス
 */
async function openMail(cookie: string | null, query = ''): Promise<Response> {
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${ACCOUNT_MAIL_PATH}${query}`, {
      headers: cookie === null ? {} : { cookie },
    }),
    testEnv(),
  );
}

/**
 * メール配信の設定を送る。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param value 送る値（項目ごと省くなら null）
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function postMail(
  routes: readonly Route[],
  cookie: string | null,
  value: string | null,
  contentType = 'application/x-www-form-urlencoded',
): Promise<Response> {
  const body = value === null ? '' : new URLSearchParams({ [FORK_NOTICE_FIELD]: value }).toString();
  const headers: Record<string, string> = { 'content-type': contentType, accept: 'text/html' };
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_MAIL_API_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * `users.fork_notice_muted_at` を引く。
 *
 * @param userId 利用者の id
 * @returns 止めた時刻（受け取っているなら null）
 */
async function mutedAtOf(userId: string): Promise<number | null> {
  const row = await env.DB.prepare('select fork_notice_muted_at from users where id = ?')
    .bind(userId)
    .first<{ fork_notice_muted_at: number | null }>();
  expect(row, `${userId} の行`).not.toBeNull();
  return row!.fork_notice_muted_at;
}

describe('経路の登録（#341）', () => {
  it('画面と変更の口がアプリの経路表に載っている', () => {
    const registered = createAppRoutes(testEnv()).map((route) => `${route.method} ${route.path}`);
    expect(registered).toContain(`GET ${ACCOUNT_PATH}`);
    expect(registered).toContain(`GET ${ACCOUNT_DETAILS_PATH}`);
    expect(registered).toContain(`POST ${ACCOUNT_DISPLAY_NAME_PATH}`);
    expect(registered).toContain(`POST ${ACCOUNT_PROFILE_PATH}`);
    expect(registered).toContain(`GET ${ACCOUNT_MAIL_PATH}`);
    expect(registered).toContain(`POST ${ACCOUNT_MAIL_API_PATH}`);
    expect(findDuplicateRoutes(createAppRoutes(testEnv()))).toEqual([]);
  });

  it('/account が SSR 画面として導かれ、全画面の外枠検査（M8-1）の対象に入る', () => {
    // `test/page-shell.test.ts` は `ssrPagePaths` の結果を歩く。**ここに入っていれば、
    // app.css への link・viewport・ヘッダ・フッタの検査が /account にも掛かる。**
    // 変更の口は `/api/` なので画面から外れる（`src/page-paths.ts` の接頭辞）。
    const paths = ssrPagePaths(createAppRoutes(testEnv()));
    expect(paths).toContain(ACCOUNT_PATH);
    expect(paths).not.toContain(ACCOUNT_DISPLAY_NAME_PATH);
    expect(paths).not.toContain(ACCOUNT_PROFILE_PATH);
    expect(paths).not.toContain(ACCOUNT_MAIL_API_PATH);
  });

  it('タブの行き先はすべて経路表の画面である（タブを足した人が経路を書き忘れると赤くなる。#379）', () => {
    // **タブはパスで分ける**（`src/account-paths.ts`）。画面であれば外枠の検査と幅の検査に
    // 自動で乗る。**#384 がメール配信のタブを足すときも、ここが両方の追随を見る。**
    const paths = ssrPagePaths(createAppRoutes(testEnv()));
    expect(ACCOUNT_TABS.length).toBeGreaterThanOrEqual(3);
    expect(ACCOUNT_TABS.map((tab) => tab.path)).toContain(ACCOUNT_MAIL_PATH);
    for (const tab of ACCOUNT_TABS) {
      expect(paths, `${tab.path} が経路表の画面に無い`).toContain(tab.path);
    }
    expect(ACCOUNT_TABS[0]?.path).toBe(ACCOUNT_PATH);
  });
});

describe('登録情報のタブ（#379）', () => {
  it('どのタブにも同じタブの列が出て、いまのタブだけがリンクでない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    for (const [path, response] of [
      [ACCOUNT_PATH, await openAccount(cookie)],
      [ACCOUNT_DETAILS_PATH, await openDetails(cookie)],
      [ACCOUNT_MAIL_PATH, await openMail(cookie)],
    ] as const) {
      expect(response.status, path).toBe(200);
      const body = pageBodyOf(await response.text());
      const nav = /<nav class="gf-account-tabs"[\s\S]*?<\/nav>/u.exec(body)?.[0] ?? '';
      expect(nav, `${path} にタブが無い`).not.toBe('');
      // **見た目はタブの部品（`.gf-tabs`）で、いまのタブは `aria-current`**（仕様 2.5.5 / #473）。
      expect(nav, path).toContain('<ul class="gf-tabs">');
      expect(nav.match(/aria-current="page"/gu) ?? [], path).toHaveLength(1);
      for (const tab of ACCOUNT_TABS) {
        if (tab.path === path) {
          expect(nav).toContain(`<span aria-current="page">${tab.label}</span>`);
          expect(nav).not.toContain(`href="${tab.path}"`);
        } else {
          expect(nav).toContain(`<a href="${tab.path}">${tab.label}</a>`);
        }
      }
    }
  });

  it('アカウントのタブも未ログインならログインへ送る', async () => {
    const response = await openDetails(null);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('メールアドレスはアカウントのタブにだけ出て、プロフィールのタブには出ない', async () => {
    const userId = await seedUser({ email: 'tab-split@example.com' });
    const cookie = await cookieFor(userId);
    expect(await (await openDetails(cookie)).text()).toContain('tab-split@example.com');
    expect(await (await openAccount(cookie)).text()).not.toContain('tab-split@example.com');
  });
});

describe('登録情報の画面（GET /account）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openAccount(null);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('ログインへ送るときに、戻り先を署名付きの一時 cookie へ積む（2.3.11 / #374）', async () => {
    // 戻り先は query へ出さない（オープンリダイレクトの入口を作らない）。着地まで
    // 通す検査は `test/auth-google.test.ts` が持つ。
    const response = await openAccount(null);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${OAUTH_COOKIE}=`))).toBe(
      true,
    );
  });

  it('署名の壊れた cookie でもログインへ送る（画面を出さない）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const response = await openAccount(`${cookie}x`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('プロフィールのタブに表示名、アカウントのタブにメールアドレス・登録日（日本時間）を出す', async () => {
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
    // 本人にしか出ない画面である。
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const details = await openDetails(await cookieFor(userId));
    expect(details.status).toBe(200);
    const detailsBody = await details.text();
    expect(detailsBody).toContain('account-owner@example.com');
    expect(detailsBody).toContain(`<time datetime="${toIsoTimestamp(createdAt)}">2026-09-11</time>`);
    expect(detailsBody).toContain('<meta name="robots" content="noindex">');
    expect(details.headers.get('cache-control')).toBe('no-store');
  });

  it('メールアドレスは本人のものしか出ない', async () => {
    // **画面は利用者を引数に取らない。** 他人の id を query に付けても本人の行を引く。
    const other = await seedUser({ email: 'someone-else@example.com' });
    const me = await seedUser({ email: 'me-myself@example.com' });
    const response = await openDetails(await cookieFor(me), `?user=${other}&id=${other}`);
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

  it('ログアウトは POST のフォームで 1 つだけで、本文ではなくヘッダのメニューにある（#362 → #372）', async () => {
    // #362 はこの画面の末尾に置いた。**v1.57 で 2.3.7 が置き場所をヘッダのアカウントの
    // メニューへ移した**（#372）。この画面にもヘッダは出るので導線は失われないが、
    // **本文に残すと同じボタンが 1 画面に 2 つ並ぶ。**
    //
    // **`<form>` の開始タグを数える。** 本文に `/auth/logout` という文字列があることだけを
    // 見ると、押せない場所（説明文やコメント）にあっても緑になる。
    const userId = await seedUser();
    const body = await (await openAccount(await cookieFor(userId))).text();

    const logoutForms = (body.match(/<form[^>]*>/g) ?? []).filter((tag) =>
      tag.includes(`action="${LOGOUT_PATH}"`),
    );
    expect(logoutForms).toHaveLength(1);
    expect(logoutForms[0]).toContain('method="post"');
    expect(pageBodyOf(body)).not.toContain(LOGOUT_PATH);
  });

  it('ログアウトを GET で押せる形にしない（`href` を置かない。#362）', async () => {
    // **GET の口を足し戻したら赤くする。** GET なら `<img src="/auth/logout">` を踏ませる
    // だけで他人をログアウトさせられる（`src/auth/google.ts` の経路表）。全画面のヘッダに
    // ついては `test/page-shell.test.ts` が同じことを見ている。
    const userId = await seedUser();
    const body = await (await openAccount(await cookieFor(userId))).text();

    expect(body).not.toContain(`href="${LOGOUT_PATH}"`);
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

  it('文字の向きを変える書式文字（Bidi_Control の 12 個）を、真ん中にも末尾にも含めさせない', () => {
    // **期待する一覧を実装の定数から作らない。** 定数から 1 つ落としたとき、両辺が同じだけ
    // 減って緑のままになる。コードポイントをここへ独立に並べる（取り込みで決めた 11 個と、
    // 第二意見のレビューで漏れを指摘された U+061C）。
    //
    // 文字そのものをソースに書かない（目に見えず、書いたかどうかを読んで確かめられない）。
    const directionControls = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ];
    for (const codePoint of directionControls) {
      const mark = String.fromCodePoint(codePoint);
      const label = `U+${codePoint.toString(16).toUpperCase()}`;
      expect(validateDisplayName(`名前${mark}の後ろ`), label).toEqual({
        ok: false,
        reason: 'control-char',
      });
      // **末尾に置いても `trim` では消えない**（空白でも行終端でもない）。名前の直後に
      // 並ぶもの（作品カードの日時・運営の印）を並び替えるのは、まさにこの位置である。
      expect(validateDisplayName(`名前${mark}`), `${label}（末尾）`).toEqual({
        ok: false,
        reason: 'control-char',
      });
    }
  });

  it('向きを変えない書式文字までは広げない（ゼロ幅空白・ゼロ幅接合子）', () => {
    // 取り込みの判断で、弾くのは向きを変える 11 個に限る。ゼロ幅接合子（U+200D）は
    // 絵文字の合成（家族の絵文字など）に要る。
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(validateDisplayName(`ゼロ幅${zeroWidthSpace}空白`).ok).toBe(true);
    expect(validateDisplayName(`家族${family}`).ok).toBe(true);
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

  it('同じ名前を入れ直しても書く（Google に追随するのをやめる唯一の方法。履歴は #405 の describe）', async () => {
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
      // 右から左への上書き（RLO）を末尾に置いた名前。画面の口を通しても弾かれる。
      [`名前${String.fromCodePoint(0x202e)}`, 'control-char'],
      // アラビア文字の印（ALM）。General Punctuation の外にあり、範囲の書き並べから漏れやすい。
      [`名前${String.fromCodePoint(0x061c)}`, 'control-char'],
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

/**
 * その利用者の表示名の変更の履歴（`display_name_changes`。#405）を、書いた順に引く。
 *
 * @param userId 利用者の id
 * @returns 旧い名前・新しい名前・時刻
 */
async function historyOf(
  userId: string,
): Promise<{ old_display_name: string; new_display_name: string; changed_at: number }[]> {
  const rows = await env.DB.prepare(
    `select old_display_name, new_display_name, changed_at
       from ${DISPLAY_NAME_CHANGES_TABLE} where user_id = ? order by rowid`,
  )
    .bind(userId)
    .all<{ old_display_name: string; new_display_name: string; changed_at: number }>();
  return rows.results;
}

describe('表示名の変更の履歴（#405 / migrations/0030）', () => {
  /*
   * **変異で確かめた**（2026-09-13。`src/display-name-changes.ts` と `src/account.ts` を
   * 1 か所ずつ書き換えて、この describe を回した）。
   *
   *   - 履歴の文から間隔の条件を外す（`where` を `id = ?` だけにする）… 「断られた変更」が赤
   *   - 履歴の文から `display_name <> ?` を外す … 「同じ名前の入れ直し」と、`test/auth-google.test.ts`
   *     の「名前が変わらないログイン」が赤
   *   - UPDATE を先に単独で送り、履歴をその後に別の文で送る（batch にしない。失敗は握る）…
   *     「1 行積む」「断られた変更」「履歴が書けなければ名前も変わらない」と、画面の表示名の 2 本が赤
   *
   * Google の経路（`src/auth/google.ts`）の変異は `test/auth-google.test.ts` の 3 本が受ける
   * （履歴の文を `select 1` に差し替える → 「1 行積む」が赤、`display_name_set_at is null` を外す →
   * 「名前を決めた利用者」が赤）。
   */
  it('名前を変えると、旧い名前と新しい名前と時刻を 1 行積む', async () => {
    const userId = await seedUser({ displayName: 'Google の名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), '決めた名前');
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=1`);
    expect(await historyOf(userId)).toEqual([
      { old_display_name: 'Google の名前', new_display_name: '決めた名前', changed_at: NOW },
    ]);
  });

  it(`頻度の上限（${DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} 秒）で断られた変更は、履歴を書かない`, async () => {
    // **#405 の acceptance。** 断った要求で履歴だけが積まれると、「その名前だった時刻」が
    // 実在しないのに記録に残り、通報の時点の名前の復元を誤らせる。
    const userId = await seedUser({ displayName: 'Google の名前' });
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });

    await postName(routes, cookie, '1 回目');
    now = NOW + DISPLAY_NAME_CHANGE_INTERVAL_SECONDS - 1;
    const tooSoon = await postName(routes, cookie, '断られる名前');
    expect(tooSoon.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=too-soon`);
    expect(await nameOf(userId)).toEqual({ display_name: '1 回目', display_name_set_at: NOW });
    expect(await historyOf(userId)).toEqual([
      { old_display_name: 'Google の名前', new_display_name: '1 回目', changed_at: NOW },
    ]);

    // **間隔が空けば積む**（条件が常に偽になっていないことを、同じ利用者で確かめる）。
    now = NOW + DISPLAY_NAME_CHANGE_INTERVAL_SECONDS;
    await postName(routes, cookie, '2 回目');
    expect((await historyOf(userId)).map((row) => row.new_display_name)).toEqual(['1 回目', '2 回目']);
  });

  it('同じ名前の入れ直しは、名前が変わらないので履歴を書かない（印は付く）', async () => {
    const userId = await seedUser({ displayName: 'そのままの名前' });
    const routes = createAccountRoutes({ now: () => NOW });
    await postName(routes, await cookieFor(userId), 'そのままの名前');
    expect(await nameOf(userId)).toEqual({ display_name: 'そのままの名前', display_name_set_at: NOW });
    expect(await historyOf(userId)).toEqual([]);
  });

  it('履歴が書けなければ、名前も変わらない（1 つの batch である）', async () => {
    // **`changed_at > 0` の CHECK で履歴の insert を落とす**（0027 / 0028 のテストと同じ使い方）。
    // 時刻 0 でも間隔の条件は `display_name_set_at is null` で通るので、落ちるのは履歴だけである。
    const userId = await seedUser({ displayName: 'Google の名前' });
    await expect(changeDisplayName(env.DB, userId, '入らない名前', 0)).rejects.toThrow();
    expect(await nameOf(userId)).toEqual({ display_name: 'Google の名前', display_name_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });
});

describe('運営フラグ（#334）との組み合わせ', () => {
  /**
   * 印の要素（タグとして解釈される形）。`test/work-page.test.ts` の同名の検査と同じ形で、
   * 引用符の有無と種類を問わない。エスケープされた `&lt;b class=...` はタグではないので当たらない。
   */
  const BADGE_ELEMENT = /<[a-z][^<>]*\sclass\s*=\s*["']?[^"'<>]*\bgf-operator\b/giu;

  /**
   * 公開済みの作品を 1 件用意し、作品ページの本文を返す。
   *
   * @param authorId 作者
   * @returns 作品ページの HTML
   */
  async function publishedPageOf(authorId: string): Promise<string> {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, published_at,
                          generation_state, preview_key)
       values (?, ?, ?, ?, '', 1, 1, 'ready', ?)`,
    )
      .bind(id, authorId, PUBLISHED_STATUS, '運営の組み合わせ検査', `acct-${id}`)
      .run();
    // 未ログインの閲覧者として開く（印も名前も、外から見える値である）。
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${workPagePath(id)}`), testEnv());
    expect(response.status).toBe(200);
    return await response.text();
  }

  /**
   * 表示名を本物の変更の口で変える。
   *
   * @param userId 利用者の id
   * @param name 新しい表示名
   */
  async function rename(userId: string, name: string): Promise<void> {
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postName(routes, await cookieFor(userId), name);
    expect(response.headers.get('location'), name).toBe(`${ACCOUNT_PATH}?saved=1`);
  }

  it('名前を変えた運営の作品ページに、決めた名前とは別に印が 1 つ出る', async () => {
    // 5.9「なりすましは名前で見分けない」。**名前を変えても印は列（is_operator）から出る**
    // ——名前の変更が印を消したり、印が名前の中へ入り込んだりしないことを見る。
    const userId = await seedUser({ displayName: 'Google の名前' });
    await env.DB.prepare('update users set is_operator = 1 where id = ?').bind(userId).run();
    // 当たったことを読み戻して確かめる。**`meta.changes` では数えない**——このファイルが
    // 張ったトリガの INSERT まで数えに入り、1 行の UPDATE が 2 と返る（実測）。
    const flag = await env.DB.prepare('select is_operator from users where id = ?')
      .bind(userId)
      .first<{ is_operator: number }>();
    expect(flag?.is_operator).toBe(1);
    await rename(userId, '新しい運営の名前');

    const body = await publishedPageOf(userId);
    // **#330 で作者名が作者ページへのリンクになった。** 綴りのうち変わったのはそこだけで、
    // **印の位置は変わっていない**——リンクは `<strong>` の内側にあり、印は
    // `<strong>` の外＝リンクの外である（`src/work-page.ts` の `authorLabel`）。
    // `/users/` の綴りは `authorPagePath` から取る（検査へ書き写さない）。
    expect(body).toContain(
      `作者: <strong><a class="gf-author-link gf-link-quiet" href="${authorPagePath(userId)}">新しい運営の名前</a></strong>` +
        ` <span class="gf-chip gf-operator">${OPERATOR_MARK}</span>`,
    );
    // **この 2 行が #341 の主眼である。** 「決めた名前とは別に印がちょうど 1 つ出る」
    // ——リンクにしたことで印が名前の中へ入ったり、2 つに増えたりしていない。
    expect(body.match(BADGE_ELEMENT)).toHaveLength(1);
    // **印が `<a>` の外にある**ことを、綴りの全体比較とは別の軸でも押さえる。
    const line = /<p class="gf-author">.*?<\/p>/u.exec(body)?.[0] ?? '';
    expect(line, '作者の行が見当たらない').not.toBe('');
    expect(line.indexOf('</a>')).toBeLessThan(line.indexOf('gf-operator'));
  });

  it('運営でない利用者が名前で印を真似ても、印の要素は 1 つも出ない', async () => {
    // 変更の口を通る名前（30 文字以内・制御文字なし）で真似る。**保存時には弾かない**
    // （語の検査をしない。5.9）ので、見分けは出力側に懸かっている。
    for (const name of [OPERATOR_MARK, '<b class=gf-operator>運営</b>']) {
      const userId = await seedUser({ displayName: 'Google の名前' });
      await rename(userId, name);
      const body = await publishedPageOf(userId);
      expect(body.match(BADGE_ELEMENT), name).toBeNull();
    }
  });
});

describe('メール配信のタブ（GET /account/mail。#384 / 5.11）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openMail(null);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('既定は「受け取る」が選ばれている', async () => {
    const userId = await seedUser();
    const response = await openMail(await cookieFor(userId));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = pageBodyOf(await response.text());
    expect(body).toContain(`action="${ACCOUNT_MAIL_API_PATH}"`);
    expect(body).toContain(`name="${FORK_NOTICE_FIELD}" value="${FORK_NOTICE_RECEIVE}" checked`);
    expect(body).not.toContain(`value="${FORK_NOTICE_MUTE}" checked`);
  });

  it('受け取らない設定なら「受け取らない」が選ばれている', async () => {
    const userId = await seedUser();
    await env.DB.prepare('update users set fork_notice_muted_at = ? where id = ?').bind(NOW, userId).run();
    const body = pageBodyOf(await (await openMail(await cookieFor(userId))).text());
    expect(body).toContain(`value="${FORK_NOTICE_MUTE}" checked`);
    expect(body).not.toContain(`value="${FORK_NOTICE_RECEIVE}" checked`);
  });

  it('止められない種別を、登録簿のとおりに設定の外として並べる（書き写さない）', async () => {
    const userId = await seedUser();
    const body = pageBodyOf(await (await openMail(await cookieFor(userId))).text());
    const unmutable = body.slice(body.indexOf('設定にかかわらず送るメール'));
    expect(unmutable, '止められない種別の節が無い').not.toBe('');
    const kinds = unmutableUserMailKinds();
    // 5.11 の「アカウントのセキュリティに関わる通知、重要な仕様変更の告知」と、利用者の決定の生成の完了。
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    for (const kind of kinds) {
      expect(unmutable, kind.label).toContain(`<strong>${kind.name}</strong>: ${kind.note}`);
    }
    // **止められる種別を、止められない側に並べない。**
    for (const kind of MAIL_KINDS.filter((entry) => entry.mutable)) {
      expect(unmutable, kind.label).not.toContain(kind.name);
    }
    // **運用者宛ての種別は利用者の画面に出さない。**
    for (const kind of MAIL_KINDS.filter((entry) => entry.audience === 'operator')) {
      expect(body, kind.label).not.toContain(kind.name);
    }
  });

  it('フォーク通知の設定は「フォークのお知らせ」と書き、旧い呼び名（改造・推敲・手直し）を出さない（#513）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    // **登録簿（`src/mail/kinds.ts`）から写さず、画面の文言をそのまま書く。** 写すと、登録簿の name / note に
    // 旧語が戻っても、ここは同じ値を期待して緑になる。
    for (const query of ['', '?saved=1', '?reason=too-soon']) {
      const html = await (await openMail(cookie, query)).text();
      expect(oldOperationNamesIn(html), query || '(既定)').toEqual([]);
      const body = pageBodyOf(html);
      expect(body, query || '(既定)').toContain('<legend>フォークのお知らせ</legend>');
      expect(body, query || '(既定)').toContain(
        '<p>ほかの人があなたの作品をフォークして公開したときに、1 通お知らせします。</p>',
      );
      expect(body, query || '(既定)').toContain('受け取らない設定にしていたあいだに公開されたフォークは');
    }
  });

  it('断った理由を固定の文言で 400 で出し、query の値そのものは出さない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const tooSoon = await openMail(cookie, '?reason=too-soon');
    expect(tooSoon.status).toBe(400);
    expect(await tooSoon.text()).toContain(`${FORK_NOTICE_UNMUTE_INTERVAL_SECONDS} 秒のあいだは`);

    const injected = await openMail(cookie, `?reason=${encodeURIComponent('<b>x</b>')}`);
    expect(injected.status).toBe(400);
    const body = await injected.text();
    expect(body).not.toContain('<b>x</b>');
    expect(body).toContain('メール配信の設定を保存できませんでした。');

    const saved = await openMail(cookie, '?saved=1');
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('メール配信の設定を保存しました。');
  });
});

describe('メール配信の設定の保存（POST /api/account/mail。#384 / 5.11）', () => {
  it('受け取らない設定にして /account/mail へ戻し、止めた時刻を書く', async () => {
    const userId = await seedUser();
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postMail(routes, await cookieFor(userId), FORK_NOTICE_MUTE);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_MAIL_PATH}?saved=1`);
    expect(await mutedAtOf(userId)).toBe(NOW);
    expect(await updatesOf(userId)).toBe(1);
  });

  it('同じ設定の入れ直しは書き込まない（止める側も、受け取る側も）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });

    // 受け取っている人が「受け取る」を送る。
    expect((await postMail(routes, cookie, FORK_NOTICE_RECEIVE)).headers.get('location')).toBe(
      `${ACCOUNT_MAIL_PATH}?saved=1`,
    );
    expect(await updatesOf(userId)).toBe(0);

    // 止めてから、もう一度「受け取らない」を送る。**止めた時刻を上書きしない**——上書きすると、
    // 受け取る設定へ戻す間隔が入れ直しのたびに延びる。
    await postMail(routes, cookie, FORK_NOTICE_MUTE);
    expect(await updatesOf(userId)).toBe(1);
    now = NOW + 300;
    expect((await postMail(routes, cookie, FORK_NOTICE_MUTE)).headers.get('location')).toBe(
      `${ACCOUNT_MAIL_PATH}?saved=1`,
    );
    expect(await mutedAtOf(userId)).toBe(NOW);
    expect(await updatesOf(userId)).toBe(1);
  });

  it(`止めてから ${FORK_NOTICE_UNMUTE_INTERVAL_SECONDS} 秒以内は受け取る設定へ戻さず、空けば戻す`, async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });
    await postMail(routes, cookie, FORK_NOTICE_MUTE);
    expect(await updatesOf(userId)).toBe(1);

    // **境界の 1 秒手前。** 断り、UPDATE を 1 回も届かせない。
    now = NOW + FORK_NOTICE_UNMUTE_INTERVAL_SECONDS - 1;
    const tooSoon = await postMail(routes, cookie, FORK_NOTICE_RECEIVE);
    expect(tooSoon.headers.get('location')).toBe(`${ACCOUNT_MAIL_PATH}?reason=too-soon`);
    expect(await mutedAtOf(userId)).toBe(NOW);
    expect(await updatesOf(userId)).toBe(1);

    // **ちょうど 60 秒で戻す。**
    now = NOW + FORK_NOTICE_UNMUTE_INTERVAL_SECONDS;
    const later = await postMail(routes, cookie, FORK_NOTICE_RECEIVE);
    expect(later.headers.get('location')).toBe(`${ACCOUNT_MAIL_PATH}?saved=1`);
    expect(await mutedAtOf(userId)).toBeNull();
    expect(await updatesOf(userId)).toBe(2);
  });

  it('知らない値・項目の無い本文・フォーム以外の形式は受けず、書かない', async () => {
    // **「知らない値は受け取らない」と読まない。** 壊れた要求で通知が黙って止まる。
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    for (const response of [
      await postMail(routes, cookie, 'off'),
      await postMail(routes, cookie, ''),
      await postMail(routes, cookie, null),
      await postMail(routes, cookie, FORK_NOTICE_MUTE, 'application/json'),
    ]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`${ACCOUNT_MAIL_PATH}?reason=invalid-request`);
    }
    expect(await mutedAtOf(userId)).toBeNull();
    expect(await updatesOf(userId)).toBe(0);
  });

  it('同じ項目が重なった本文は、先頭の値で受けずに断り、書かない（PR #423 の Copilot の指摘）', async () => {
    // **先頭を黙って採らない**（`src/signup.ts` の招待コードと同じ判断）。受け取っている人にも、
    // 止めている人にも、どちらの並びでも D1 を変えないことを見る。
    const receiving = await seedUser();
    const muted = await seedUser();
    await env.DB.prepare('update users set fork_notice_muted_at = ? where id = ?').bind(NOW - 600, muted).run();
    const routes = createAccountRoutes({ now: () => NOW });
    for (const [userId, before] of [
      [receiving, null],
      [muted, NOW - 600],
    ] as const) {
      const cookie = await cookieFor(userId);
      const updates = await updatesOf(userId);
      for (const order of [
        [FORK_NOTICE_MUTE, FORK_NOTICE_RECEIVE],
        [FORK_NOTICE_RECEIVE, FORK_NOTICE_MUTE],
        [FORK_NOTICE_MUTE, FORK_NOTICE_MUTE],
      ]) {
        const body = order.map((value) => `${FORK_NOTICE_FIELD}=${value}`).join('&');
        const response = await dispatch(
          routes,
          new Request(`${APP_ORIGIN}${ACCOUNT_MAIL_API_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
            body,
          }),
          testEnv(),
        );
        expect(response.status, body).toBe(303);
        expect(response.headers.get('location'), body).toBe(`${ACCOUNT_MAIL_PATH}?reason=invalid-request`);
      }
      expect(await mutedAtOf(userId)).toBe(before);
      expect(await updatesOf(userId)).toBe(updates);
    }
  });

  it('未ログインならログインへ送り、何も書かない', async () => {
    const userId = await seedUser();
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postMail(routes, null, FORK_NOTICE_MUTE);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await updatesOf(userId)).toBe(0);
  });

  it('BAN された利用者は変えられない', async () => {
    const userId = await seedUser();
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(userId).run();
    const before = await updatesOf(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postMail(routes, await cookieFor(userId), FORK_NOTICE_MUTE);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await updatesOf(userId)).toBe(before);
    expect(await mutedAtOf(userId)).toBeNull();
  });

  it('画面で止めると改造通知が送られなくなり、戻すとまた送られる（往復）', async () => {
    // **この画面が書いた列を、送信の口が実際に読んでいること**を 1 本で通す（5.11「配信の口が、
    // この設定を実際に見る」）。送信は `fetcher` を差し替えて手前で止める（`test/mail.test.ts`）。
    const parentAuthor = await seedUser();
    const forker = await seedUser();
    const cookie = await cookieFor(parentAuthor);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });
    const mailEnv = {
      ...testEnv(),
      RESEND_API_KEY: 'test-api-key',
      MAIL_FROM: 'Game Forge <no-reply@example.com>',
    } as Env;
    const requests: Request[] = [];
    const deps = {
      fetcher: async (request: Request) => {
        requests.push(request);
        return new Response('{}', { status: 200 });
      },
      send: sendMail,
    };
    const seedFork = async (suffix: string): Promise<string> => {
      const parentId = `${USER_PREFIX}mail-parent-${suffix}-${crypto.randomUUID()}`;
      const childId = `${USER_PREFIX}mail-child-${suffix}-${crypto.randomUUID()}`;
      for (const [id, author, parent] of [
        [parentId, parentAuthor, null],
        [childId, forker, parentId],
      ] as const) {
        await env.DB.prepare(
          `insert into games (id, author_id, parent_id, status, title, go_version, created_at, published_at)
           values (?, ?, ?, 'published', 'ねこのゲーム', 'go1.25.0', 1, 2)`,
        )
          .bind(id, author, parent)
          .run();
      }
      return childId;
    };

    await postMail(routes, cookie, FORK_NOTICE_MUTE);
    expect(await notifyForkPublished(mailEnv, await seedFork('muted'), deps)).toBe('muted');
    expect(requests).toHaveLength(0);

    now = NOW + FORK_NOTICE_UNMUTE_INTERVAL_SECONDS;
    await postMail(routes, cookie, FORK_NOTICE_RECEIVE);
    expect(await notifyForkPublished(mailEnv, await seedFork('receiving'), deps)).toBe('sent');
    expect(requests).toHaveLength(1);
  });
});

describe('登録情報の見た目の規約の部品（#473 / 仕様 2.5.4 / 2.5.5）', () => {
  /**
   * 画面全体の主のボタンの数（外枠のヘッダは主を持たない。`test/html.test.ts`）。
   *
   * @param page 画面の HTML
   * @returns 主のボタンの数
   */
  function primaryButtonsOf(page: string): number {
    return (page.match(/\bgf-button-primary\b/gu) ?? []).length;
  }

  it('どのタブにも主のボタンを置かない（保存のボタンはすべて副）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    for (const [path, response] of [
      [ACCOUNT_PATH, await openAccount(cookie)],
      [ACCOUNT_DETAILS_PATH, await openDetails(cookie)],
      [ACCOUNT_MAIL_PATH, await openMail(cookie)],
    ] as const) {
      const body = await response.text();
      expect(primaryButtonsOf(body), path).toBe(0);
      // 本文のボタンはどれも副の部品である（ログアウトはヘッダのメニューが持つ）。
      for (const tag of pageBodyOf(body).match(/<button[^>]*>/gu) ?? []) {
        expect(tag, path).toContain('class="gf-button gf-button-secondary"');
      }
    }
  });

  it('プロフィールのタブは、表示名・自己紹介と外部リンク・アイコンを 1 つずつブロックにし、表示名と自己紹介を左の列に包んでこの順に並べる', async () => {
    // #551: 利用者が撮影した 3 案から選んだ並び。**DOM の順＝見た目の順＝Tab の順**なので、HTML の並びそのものを固定する。
    const userId = await seedUser();
    const body = pageBodyOf(await (await openAccount(await cookieFor(userId))).text());
    const blocks = /<div class="gf-account-blocks">([\s\S]*)<\/div>\n<p class="gf-account-author">/u.exec(body)?.[1] ?? '';
    expect(blocks, 'ブロックの並びが無い').not.toBe('');
    const nameBlock = `action="${ACCOUNT_DISPLAY_NAME_PATH}"`;
    const profileBlock =
      '<section class="gf-block gf-account-block" aria-labelledby="account-profile-heading">\n<h2 id="account-profile-heading">自己紹介と外部リンク</h2>';
    const avatarBlock =
      '<section class="gf-block gf-account-block" aria-labelledby="account-avatar-heading">\n<h2 id="account-avatar-heading">アイコン</h2>';
    const order = [nameBlock, profileBlock, avatarBlock].map((part) => blocks.indexOf(part));
    expect(order.every((position) => position >= 0), order.join(',')).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(blocks.match(/class="gf-block gf-account-block"/gu) ?? []).toHaveLength(3);
    // 格子の子は 2 つ: 左の列（表示名 → 自己紹介）と、その直後のアイコンのブロック。**アイコンを列の中へ入れない**
    // （入れると 1 列の縦積みになり、広い段で 2 列にならない）。
    // 左の列の終わりは「`</div>` の直後にアイコンのブロックが来る」ところで決める（表示名のブロックも `</div>` で閉じるため）。
    const columns =
      /^\n<div class="gf-account-column">\n([\s\S]*?)\n<\/div>\n(<section class="gf-block gf-account-block" aria-labelledby="account-avatar-heading">[\s\S]*<\/section>)\n$/u.exec(
        blocks,
      );
    expect(columns, '左の列とアイコンのブロックの形が違う').not.toBeNull();
    const [, left = '', right = ''] = columns ?? [];
    expect(left).toContain(nameBlock);
    expect(left).toContain(profileBlock);
    expect(left).not.toContain('account-avatar-heading');
    expect(left.match(/class="gf-block gf-account-block"/gu) ?? []).toHaveLength(2);
    expect(right.startsWith(avatarBlock), right.slice(0, 120)).toBe(true);
    expect(right.match(/class="gf-block gf-account-block"/gu) ?? []).toHaveLength(1);
    // 自分の作者ページへの導線は小さい副のボタン（移動なので `<a>`）。
    expect(body).toContain(
      `<p class="gf-account-author"><a class="gf-button gf-button-secondary gf-button-sm" href="${authorPagePath(userId)}">自分の作者ページを見る</a></p>`,
    );
  });

  it('@section account は幅の断点も並べ替えも持たず、左の列のブロックの間は格子の間と同じ gap にする', () => {
    // #551: 見た目の順を CSS で入れ替えない（`order` / `grid-template-areas` / `display: contents`）。幅の `@media` は `@section shell` だけが持つ。
    const css = env.TEST_APP_CSS;
    const start = css.indexOf('\n   @section account');
    const end = css.indexOf('\n   @section ', start + 1);
    expect(start).toBeGreaterThan(0);
    const section = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    expect(section).not.toMatch(/@media|(^|[\s;{])order\s*:|grid-template-areas|display:\s*contents/u);
    // 表示名と自己紹介の間（列の中）と、狭い段での自己紹介とアイコンの間（格子）を同じ値にする。
    const gapOf = (selector: string): string | undefined =>
      new RegExp(`(?:^|\\n)${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(section)?.[1]?.match(/(?:^|[\s;])gap:\s*([^;]+);/u)?.[1];
    expect(gapOf('.gf-account-blocks')).toBe('var(--gf-gap-4)');
    expect(gapOf('.gf-account-column')).toBe('var(--gf-gap-4)');
    // 列ごとに縦に積む（行で高さを揃える格子にしない）。
    expect(section).toMatch(/\n\.gf-account-column\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/u);
  });

  it('変更の完了の知らせはブロックである', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    for (const [query, message] of [
      ['?saved=1', '表示名を変更しました。'],
      ['?saved=profile', '自己紹介と外部リンクを保存しました。'],
      ['?saved=avatar', 'アイコンを設定しました。'],
      ['?saved=avatar-removed', 'アイコンを外しました。'],
    ] as const) {
      expect(pageBodyOf(await (await openAccount(cookie, query)).text()), query).toContain(
        `<p class="gf-block" role="status">${message}</p>`,
      );
    }
    const mail = pageBodyOf(await (await openMail(cookie, '?saved=1')).text());
    expect(mail).toContain('<p class="gf-block" role="status">メール配信の設定を保存しました。</p>');
    // メール配信のフォームもブロックである。
    expect(mail).toContain(`<form class="gf-block" method="post" action="${ACCOUNT_MAIL_API_PATH}">`);
  });
});
