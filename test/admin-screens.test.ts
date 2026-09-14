import { env } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIONS_PATH,
  ADMIN_BAN_API_PATH,
  ADMIN_GAME_ID_FIELD,
  ADMIN_HOME_PATH,
  ADMIN_NEXT_FIELD,
  ADMIN_REASON_FIELD,
  ADMIN_REVIEW_API_PATH,
  ADMIN_TAKEDOWNS_PATH,
  ADMIN_TAKEDOWN_ACTION_FIELD,
  ADMIN_TAKEDOWN_API_PATH,
  ADMIN_TAKEDOWN_ID_FIELD,
  ADMIN_USERS_PATH,
  ADMIN_USER_ID_FIELD,
} from '../src/admin-paths.js';
import { changeDisplayName } from '../src/account.js';
import { ADMIN_LIST_LIMIT, listAdminActions } from '../src/admin/actions.js';
import { REPORT_EVIDENCE_PER_GAME } from '../src/admin/report-evidence.js';
import { ADMIN_OPEN_ROUTES, createAdminRoutes, handleAdminRequest } from '../src/admin/routes.js';
import { BAN_NEXT_ACTIVE, BAN_NEXT_BANNED } from '../src/admin/users.js';
import {
  DESCRIPTION_CHANGES_TABLE,
  PUBLISHED_STATUS,
  describeGame,
  renameGame,
} from '../src/games.js';
import { ssrPagePaths } from '../src/page-paths.js';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  TITLE_CHANGES_TABLE,
  reviewAttentionSql,
} from '../src/reports.js';
import {
  DISPLAY_NAME_CHANGES_TABLE,
  DISPLAY_NAME_HISTORY_START_TABLE,
} from '../src/display-name-changes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 管理画面の 3 枚と 2 つの口（仕様 2.4.3 / 2.4.4 / #361。M10-3）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ここが見るのは「経路表を通した実物」である
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **ハンドラを直接呼ばない。** 呼ぶと、経路表への登録漏れ（画面はあるが開けない）と、
 * **境界の掛かり方**（`handleAdminRequest` が経路表を引く手前で権限を見る）を 1 つも
 * 見ないことになる。書き込みそのものの不変条件は `test/admin-actions.test.ts` が持つ。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 足した経路すべてが 404 になることは、一覧を書き写さずに確かめる
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `test/admin-guard.test.ts` が**経路表を歩いて**同じことを見ている（あれが M10-2 で
 * 用意した「M10-3 のための仕掛け」である）。ここが足すのは、**M10-3 が足した 4 本が
 * 本当にその歩く対象に入っていること**——つまり `ADMIN_OPEN_ROUTES` へ 1 本も
 * 足していないこと——の確認である。
 */

const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SECRET = 'test-secret-value-for-admin-screens-checks-1';

/** 仕込む利用者。 */
const users = { admin: '', other: '', author: '' };

/** 管理者の cookie。 */
let adminCookie = '';

/**
 * 秘密を明示した env を作る（`test/admin-guard.test.ts` の `testEnv` と同じ理由）。
 *
 * @returns ハンドラへ渡す env
 */
function testEnv(): Env {
  return {
    APP_HOST: env.APP_HOST,
    ADMIN_HOST: env.ADMIN_HOST,
    SANDBOX_HOST: env.SANDBOX_HOST,
    DB: env.DB,
    BUCKET: env.BUCKET,
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret-value',
  } as unknown as Env;
}

/**
 * 署名付きセッション cookie の `name=value` を作る。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダへ載せる文字列
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * `users` を 1 行入れる。
 *
 * @param label 名前の目印
 * @returns 利用者の id
 */
async function insertUser(label: string): Promise<string> {
  const id = `${label}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, label, Math.floor(Date.now() / 1000))
    .run();
  return id;
}

/**
 * 公開済みの作品を 1 本入れる。
 *
 * @param reviewState 審査状態
 * @param title 題名
 * @param authorId 作者（既定は `users.author`。表示名の履歴を見るテストは作者を分ける）
 * @returns 作品の id
 */
async function insertGame(
  reviewState: string | null,
  title = '審査の対象',
  authorId: string = users.author,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', 1, 0, 0, 'ready', ?)`,
  )
    .bind(id, authorId, PUBLISHED_STATUS, title, reviewState)
    .run();
  return id;
}

/**
 * 画面を開く。
 *
 * @param path パス
 * @param cookie 送る cookie（省略すると未ログイン）
 * @returns ステータスと本文
 */
async function open(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const response = await handleAdminRequest(
    new Request(`${ADMIN_ORIGIN}${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
    testEnv(),
  );
  return { status: response.status, body: await response.text() };
}

/**
 * 口へフォームを送る。
 *
 * @param path パス
 * @param fields 項目
 * @param cookie 送る cookie（省略すると未ログイン）
 * @returns ステータスと遷移先
 */
async function post(
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<{ status: number; location: string }> {
  const response = await handleAdminRequest(
    new Request(`${ADMIN_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv(),
  );
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

/**
 * 作品の審査状態を読む。
 *
 * @param gameId 作品の id
 * @returns 審査状態
 */
async function reviewStateOf(gameId: string): Promise<string | null> {
  const row = await env.DB.prepare('select review_state from games where id = ?')
    .bind(gameId)
    .first<{ review_state: string | null }>();
  return row?.review_state ?? null;
}

/**
 * BAN の時刻を読む。
 *
 * @param userId 利用者の id
 * @returns `banned_at`
 */
async function bannedAtOf(userId: string): Promise<number | null> {
  const row = await env.DB.prepare('select banned_at from users where id = ?')
    .bind(userId)
    .first<{ banned_at: number | null }>();
  return row?.banned_at ?? null;
}

beforeAll(async () => {
  await applySchema();
  users.admin = await insertUser('管理者');
  users.other = await insertUser('別の利用者');
  users.author = await insertUser('作者');
  await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(users.admin).run();
  adminCookie = await cookieFor(users.admin);
});

beforeEach(async () => {
  await env.DB.prepare('delete from admin_actions').run();
  // **作品を指す表を先に消す**（外部キー。#367 で通報と改名の履歴を仕込むようになった）。
  // **`admin_actions` も毎回空にする**（#394 で、条件がこの表の `review-cleared` を読む）。
  await env.DB.prepare(`delete from ${TITLE_CHANGES_TABLE}`).run();
  // 説明の履歴（#388 / `migrations/0028`）も作品を外部キーで指す。
  await env.DB.prepare(`delete from ${DESCRIPTION_CHANGES_TABLE}`).run();
  await env.DB.prepare('delete from reports').run();
  await env.DB.prepare('delete from games').run();
  // 削除依頼（#406）。作品を外部キーで指さないが、画面の件数を毎回 0 から数える。
  await env.DB.prepare('delete from takedown_requests').run();
  await env.DB.prepare('update users set banned_at = null').run();
});

describe('足した経路は、権限が無いと 404 になる（2.4.2 / ADMIN_OPEN_ROUTES に足さない）', () => {
  /** M10-3 が足した 4 本と、#406 が足した 2 本（**綴りは正本の定数から取る**）。 */
  const ADDED: readonly { readonly method: 'GET' | 'POST'; readonly path: string }[] = [
    { method: 'GET', path: ADMIN_USERS_PATH },
    { method: 'GET', path: ADMIN_ACTIONS_PATH },
    { method: 'POST', path: ADMIN_REVIEW_API_PATH },
    { method: 'POST', path: ADMIN_BAN_API_PATH },
    { method: 'GET', path: ADMIN_TAKEDOWNS_PATH },
    { method: 'POST', path: ADMIN_TAKEDOWN_API_PATH },
  ];

  it('足した経路が、本当に経路表に登録されている', () => {
    const registered = createAdminRoutes().map((route) => `${route.method} ${route.path}`);
    for (const route of ADDED) {
      expect(registered, `${route.method} ${route.path}`).toContain(
        `${route.method} ${route.path}`,
      );
    }
  });

  it('足した経路が 1 つも ADMIN_OPEN_ROUTES に入っていない（既定は「閉」）', () => {
    // **これが「何もしなければ守られる」ことの確認である**（`src/admin/routes.ts`）。
    // 開けたい理由ができたときだけ、あちらへ 1 行足して理由を書くことになる。
    for (const route of ADDED) {
      expect(
        ADMIN_OPEN_ROUTES.some(
          (open_) => open_.method === route.method && open_.path === route.path,
        ),
        `${route.method} ${route.path} が未ログインで開いている`,
      ).toBe(false);
    }
  });

  it('未ログイン・is_admin = 0 のどちらでも 404 で、本文も遷移先も返さない', async () => {
    for (const cookie of [undefined, await cookieFor(users.other)]) {
      for (const route of ADDED) {
        const response = await handleAdminRequest(
          new Request(`${ADMIN_ORIGIN}${route.path}`, {
            method: route.method,
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              ...(cookie === undefined ? {} : { cookie }),
            },
            body: route.method === 'POST' ? 'x=1' : undefined,
          }),
          testEnv(),
        );
        expect(response.status, `${route.method} ${route.path}`).toBe(404);
        // **303 で返すと、口の存在が遷移先から読める**（404 の中身は経路が無いときと同じ）。
        expect(response.headers.get('location'), `${route.method} ${route.path}`).toBeNull();
        expect(response.headers.get('allow'), `${route.method} ${route.path}`).toBeNull();
      }
    }
  });

  it('権限の無い POST は、D1 を 1 行も書かない', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);
    await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '権限が無いのに通ったら赤',
      },
      await cookieFor(users.other),
    );
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    expect(await listAdminActions(env)).toEqual([]);
  });
});

describe('画面が経路表から導かれる（2.4.5。一覧を書き写さない）', () => {
  it('導出した画面が 4 枚あり、綴りが正本と一致する', () => {
    // **`ssrPagePaths` は `test/admin-page-shell.test.ts` が外枠の検査に使う導出である。**
    // ここでは「M10-3 の 3 枚と #406 の削除依頼がその網に入った」ことだけを見る
    // （`/api/*` の 3 本は POST なので、画面としては導かれない）。
    expect(ssrPagePaths(createAdminRoutes()).sort()).toEqual(
      [ADMIN_HOME_PATH, ADMIN_USERS_PATH, ADMIN_TAKEDOWNS_PATH, ADMIN_ACTIONS_PATH].sort(),
    );
  });
});

describe('審査キューの画面（2.4.3 / 8.4）', () => {
  it('queued の作品が並び、cleared の作品は別の節に並ぶ', async () => {
    const queued = await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    const cleared = await insertGame(REVIEW_CLEARED, '問題なしとした作品');
    const untouched = await insertGame(null, '通報されていない作品');

    const { status, body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(status).toBe(200);
    expect(body).toContain(queued);
    expect(body).toContain(cleared);
    // **NULL の作品は出さない**（審査の対象ではない。8.4 は投入を通報の側に置いている）。
    expect(body).not.toContain(untouched);
    expect(body).toContain('審査待ちの作品');
    expect(body).toContain('問題なしとした作品');
  });

  it('題名をエスケープして出す（D1 の値を HTML へ入れる場所である）', async () => {
    await insertGame(REVIEW_QUEUED, '<script>alert(1)</script>');
    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('作品ページへのリンクが app ホストの絶対 URL である（4.4）', async () => {
    // **admin ホストに `/works/<id>` は無い。** 相対リンクで置くと 404 へ送る。
    const gameId = await insertGame(REVIEW_QUEUED);
    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(body).toContain(`https://${env.APP_HOST}/works/${gameId}`);
  });

  it('一覧の件数を固定する（2.3.3 の条件 1 と同じ考え方）', async () => {
    const statements = [];
    for (let index = 0; index < ADMIN_LIST_LIMIT + 3; index += 1) {
      statements.push(
        env.DB.prepare(
          `insert into games
             (id, author_id, status, title, go_version, created_at, generation_state,
              published_at, fork_count, like_count, ogp_state, review_state)
           values (?, ?, ?, ?, '', 1, 'ready', ?, 0, 0, 'ready', ?)`,
        ).bind(
          crypto.randomUUID(),
          users.author,
          PUBLISHED_STATUS,
          `作品 ${index}`,
          1000 + index,
          REVIEW_QUEUED,
        ),
      );
    }
    await env.DB.batch(statements);

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    // **行の数を数える。** 母数が増えても読み取りが増えない形であることの現れである。
    expect(body.split('<li class="gf-block gf-admin-row">').length - 1).toBe(ADMIN_LIST_LIMIT);
  });

  it('取り下げ済み（removed）の作品は、審査待ちのままでも並べない', async () => {
    // **`removeGame` は `status` だけを動かし、`review_state` を残す**（`src/games.ts`）。
    // 並べると、**戻らない露出について「新規露出を戻す」ボタンを出す**ことになる
    // （PR #364 のレビューの指摘。2.4.3 は取り下げを画面へ置かないと決めている）。
    const removed = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games
         (id, author_id, status, title, go_version, created_at, generation_state,
          published_at, fork_count, like_count, ogp_state, review_state)
       values (?, ?, 'removed', '取り下げ済みの作品', '', 1, 'ready', 1, 0, 0, 'ready', ?)`,
    )
      .bind(removed, users.author, REVIEW_QUEUED)
      .run();

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(body).not.toContain(removed);
  });

  it('取り下げ済みの作品は、口からも動かせない（履歴も残らない）', async () => {
    const removed = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games
         (id, author_id, status, title, go_version, created_at, generation_state,
          published_at, fork_count, like_count, ogp_state, review_state)
       values (?, ?, 'removed', '取り下げ済みの作品', '', 1, 'ready', 1, 0, 0, 'ready', ?)`,
    )
      .bind(removed, users.author, REVIEW_QUEUED)
      .run();

    const { location } = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: removed,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '取り下げ済みを戻そうとした',
      },
      adminCookie,
    );
    expect(location).toBe(`${ADMIN_HOME_PATH}?outcome=not-applicable`);
    expect(await reviewStateOf(removed)).toBe(REVIEW_QUEUED);
    // **履歴も 1 行も残らない**（操作していない履歴を作らない）。
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('未知の outcome を画面へ反射しない', async () => {
    // **query に載るのは固定の綴りだけである**（`src/admin/outcome.ts`）。
    const { status, body } = await open(
      `${ADMIN_HOME_PATH}?outcome=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
      adminCookie,
    );
    expect(status).toBe(400);
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('操作の結果を確認できませんでした');
  });
});

/** 審査キューの節の見出し（**画面の文言である**。節の切り出しにだけ使う）。 */
const HEADINGS = {
  queued: '審査待ち',
  reported: '問題なしとしたあとに通報が付いた作品',
  cleared: '問題なしとした作品',
} as const;

/**
 * 審査キューの本文から 1 つの節を切り出す（見出しから次の見出しまで）。
 *
 * **節を分けて見る。** 本文全体に id が含まれるかだけを見ると、「`cleared` の節に
 * 出ている」ことと「問題なしのあとに通報が付いた節に出ている」ことが区別できない
 * ——#367 / #394 の受け入れはまさにその区別である。
 *
 * @param body 画面の本文
 * @param key 節
 * @returns その節の HTML（見つからなければ空文字）
 */
function sectionOf(body: string, key: keyof typeof HEADINGS): string {
  const start = body.indexOf(`<h2>${HEADINGS[key]}（`);
  if (start < 0) {
    return '';
  }
  const next = body.indexOf('<h2>', start + 1);
  return next < 0 ? body.slice(start) : body.slice(start, next);
}

/**
 * 通報を 1 件入れる（時刻を指定する。問題なしとの前後を決めるため）。
 *
 * **`recordReport` を通さない。** あちらは `review_state` を動かすので、`cleared` の
 * 作品へ「問題なしのあとの通報」を置く状況を、時刻を決めて直接作れない。
 * **同じ作品へ 2 件目を置くときは通報者を変える**（同じ人は同じ作品を 2 度通報できない。
 * 0017 の一意制約）。**通報者を行ごとに作らない**——利用者の一覧（上限 50 件）を押し出す。
 *
 * @param gameId 作品の id
 * @param createdAt 通報の時刻（UNIX 秒）
 * @param reporterId 通報者（既定は `users.other`）
 */
async function insertReport(
  gameId: string,
  createdAt: number,
  reporterId: string = users.other,
): Promise<void> {
  await env.DB.prepare(
    'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), gameId, reporterId, '通報の理由', createdAt)
    .run();
}

/**
 * 「画面から問題なしにした」履歴を 1 行、時刻を決めて積む。
 *
 * **口（`POST /api/review`）を通すと時刻が「いま」になり、通報との前後を決められない。**
 * 口を通した往復は「審査の往復」の describe と `test/review-attention.test.ts` が見る。
 *
 * @param gameId 作品の id
 * @param createdAt 問題なしにした時刻（UNIX 秒）
 */
async function insertClearedAction(gameId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
     values (?, ?, ?, 'review-cleared', 'game', ?, '問題なし')`,
  )
    .bind(crypto.randomUUID(), users.admin, createdAt, gameId)
    .run();
}

/**
 * 「問題なしにしたあと改名され、問題なしにし直した**あとに**通報が付いた」作品を 1 本作る。
 *
 * **改名は `cleared` を `NULL` へ戻す**（`renameGame`）ので、改名の後で `cleared` へ
 * 書き直し、その時刻の履歴を積む。**改名を挟むのは「最終改名」の時刻を行に出すため**で、
 * 条件そのものは改名に依らない（#394）。
 *
 * @param title 改名後の題名
 * @returns 作品の id
 */
async function insertReportedAfterClear(title = '改名後の題名'): Promise<string> {
  const gameId = await insertGame(REVIEW_CLEARED, '改名前の題名');
  const renamed = await renameGame(env, gameId, users.author, title, 1_700_001_000);
  expect(renamed.ok, '改名が通っていない（仕込みの前提が崩れている）').toBe(true);
  await env.DB.prepare('update games set review_state = ? where id = ?')
    .bind(REVIEW_CLEARED, gameId)
    .run();
  await insertClearedAction(gameId, 1_700_001_500);
  await insertReport(gameId, 1_700_002_000);
  return gameId;
}

describe('審査キューに「問題なしとしたあとに通報が付いた作品」を出す（#367 / #394）', () => {
  it('問題なしにした後に通報が付いた作品が、その節に出る（cleared の節には出ない）', async () => {
    const reported = await insertReportedAfterClear();

    const { status, body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(status).toBe(200);
    expect(sectionOf(body, 'reported')).toContain(reported);
    // **行は片方にしか出さない**（同じ作品に操作のフォームを 2 つ並べない）。
    expect(sectionOf(body, 'cleared')).not.toContain(reported);
    expect(sectionOf(body, 'queued')).not.toContain(reported);
    expect(body.split(`value="${reported}"`).length - 1).toBe(1);
  });

  it('改名が無くても、問題なしにした後の通報なら出る（改名に絞らない。#394）', async () => {
    const plain = await insertGame(REVIEW_CLEARED, '改名していない作品');
    await insertClearedAction(plain, 1_700_001_500);
    await insertReport(plain, 1_700_002_000);

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(body, 'reported')).toContain(plain);
    expect(sectionOf(body, 'cleared')).not.toContain(plain);
  });

  it('見終えた作品（通報が最後の問題なしより前）は出ない（#394 の (a)）', async () => {
    // **issue #394 の再現である。** 改名のあとの通報を見て問題なしにし直した作品が、
    // #366 の条件（最後の改名より後に通報がある）では次の改名まで出続けた。
    const gameId = await insertGame(REVIEW_CLEARED, '改名前の題名');
    await insertReport(gameId, 1_700_000_500);
    await insertClearedAction(gameId, 1_700_000_600);
    await renameGame(env, gameId, users.author, '改名後の題名', 1_700_001_000);
    await insertReport(gameId, 1_700_001_200, users.admin);
    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_CLEARED, gameId)
      .run();
    await insertClearedAction(gameId, 1_700_001_400);

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(body, 'reported')).not.toContain(gameId);
    expect(sectionOf(body, 'reported')).toContain('いま該当する作品はありません。');
    // **cleared の節からは消えない**（往復の「審査待ちへ戻す」を失わない）。
    expect(sectionOf(body, 'cleared')).toContain(gameId);
  });

  it('履歴の無い cleared（#361 より前に端末で問題なしにした作品）は、通報があれば出る', async () => {
    // **黙って落とさない**（`src/reports.ts` の但し書き）。通報の無い cleared は出ない。
    const legacy = await insertGame(REVIEW_CLEARED, '端末で問題なしにした作品');
    await insertReport(legacy, 1_600_000_000);
    const quiet = await insertGame(REVIEW_CLEARED, '通報の無い作品');

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(body, 'reported')).toContain(legacy);
    expect(sectionOf(body, 'cleared')).not.toContain(legacy);
    expect(sectionOf(body, 'cleared')).toContain(quiet);
    // **注記がこの扱いを書いている**（運営が「見た覚えの無い作品が出た」を不具合と読まないため）。
    expect(sectionOf(body, 'reported')).toContain('管理画面ができる前に問題なしとした作品');
  });

  it('queued の行と区別できる（札と最終改名の時刻はこの節の行にだけ付く）', async () => {
    const queued = await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    const reported = await insertReportedAfterClear();

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    const reportedSection = sectionOf(body, 'reported');
    const queuedSection = sectionOf(body, 'queued');

    // **札はチップの部品である**（仕様 2.5.5 / #475。止まっていない露出に目を向けさせる印なので強調のチップ）。
    expect(reportedSection).toContain(
      '<p class="gf-admin-row-head"><span class="gf-chip gf-chip-emphasis">問題なしのあとに通報あり</span></p>',
    );
    // **いつ改名されたか**を出す。**通報の時点の題名は通報ごとに出す**（#405）が、この作品の
    // 通報は改名より後なので、通報の時点の題名も改名後であり、改名前の題名はどこにも出ない。
    expect(reportedSection).toContain('最終改名: <time datetime="');
    expect(reportedSection).toContain('改名後の題名');
    expect(reportedSection).not.toContain('改名前の題名');

    expect(queuedSection).toContain(queued);
    expect(queuedSection).not.toContain('問題なしのあとに通報あり');
    expect(queuedSection).not.toContain('最終改名');
    // **押す操作も違う**（この節の行は `cleared` なので、向かう先は `queued`）。
    const reportedRow = reportedSection
      .split('<li class="gf-block gf-admin-row">')
      .find((row) => row.includes(reported));
    expect(reportedRow).toContain(`name="${ADMIN_NEXT_FIELD}" value="${REVIEW_QUEUED}"`);
  });

  it('審査待ちとこの節を合わせると、scripts/report-queue.sh と同じ条件（reviewAttentionSql）の集合になる', async () => {
    // **条件を 2 か所に書かない**ことの確認である。スクリプトは `reviewAttentionSql` と
    // 同じ形（`REVIEW_QUEUED` or `REVIEW_REPORTED_AFTER_CLEAR_SQL`）をソースから組み立てる。
    // 画面が別の条件を書き始めたら、この集合がずれて赤くなる。
    const legacy = await insertGame(REVIEW_CLEARED, '履歴の無い cleared');
    await insertReport(legacy, 1_600_000_000);
    const expected = [
      await insertGame(REVIEW_QUEUED, '審査待ち'),
      await insertReportedAfterClear('この節 1'),
      await insertReportedAfterClear('この節 2'),
      legacy,
    ];
    const seen = await insertGame(REVIEW_CLEARED, '見終わった作品');
    await insertReport(seen, 1_700_002_000);
    await insertClearedAction(seen, 1_700_003_000);
    await insertGame(REVIEW_CLEARED, '通報されていない作品');
    await insertGame(null, '通報されていない作品');

    const attention = await env.DB.prepare(
      `select g.id from games g where ${reviewAttentionSql()} and g.status = ? order by g.id`,
    )
      .bind(PUBLISHED_STATUS)
      .all<{ id: string }>();
    expect(attention.results.map((row) => row.id)).toEqual([...expected].sort());

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    const shown = `${sectionOf(body, 'queued')}${sectionOf(body, 'reported')}`;
    const allIds = (
      await env.DB.prepare('select id from games').all<{ id: string }>()
    ).results.map((row) => row.id);
    expect(allIds.filter((id) => shown.includes(`value="${id}"`)).sort()).toEqual(
      [...expected].sort(),
    );
  });

  it('作者が題名や説明を変えると、この節から審査待ちの節へ移り、reviewAttentionSql の集合は変わらない（#404）', async () => {
    // **#366 / #388 は変更で `cleared` を `NULL` へ戻し、この節の作品をどの節からも消していた**
    // （届いていた通報が埋もれる）。#404 からは審査待ちの節へ移る。**スクリプトと画面が
    // 同じ集合を返すことは、変更の前後の両方で見る。**
    const renamed = await insertGame(REVIEW_CLEARED, '改名される作品');
    const described = await insertGame(REVIEW_CLEARED, '説明が変わる作品');
    for (const gameId of [renamed, described]) {
      await insertClearedAction(gameId, 1_700_001_500);
      await insertReport(gameId, 1_700_002_000);
    }
    // 通報が問題なしより前の作品は、変更で `NULL` へ戻り、どの節にも出ない（露出を止めない）。
    const quiet = await insertGame(REVIEW_CLEARED, '見終えた作品');
    await insertReport(quiet, 1_700_000_500);
    await insertClearedAction(quiet, 1_700_001_500);

    /**
     * スクリプトと同じ条件の集合と、画面の審査待ち・この節に出た作品を読む。
     *
     * @returns 条件の集合と、画面の節ごとの作品
     */
    const snapshot = async (): Promise<{
      attention: string[];
      queued: string[];
      reported: string[];
      cleared: string[];
    }> => {
      const attention = await env.DB.prepare(
        `select g.id from games g where ${reviewAttentionSql()} and g.status = ? order by g.id`,
      )
        .bind(PUBLISHED_STATUS)
        .all<{ id: string }>();
      const { body } = await open(ADMIN_HOME_PATH, adminCookie);
      const ids = [renamed, described, quiet];
      const inSection = (key: keyof typeof HEADINGS): string[] =>
        ids.filter((id) => sectionOf(body, key).includes(`value="${id}"`)).sort();
      return {
        attention: attention.results.map((row) => row.id),
        queued: inSection('queued'),
        reported: inSection('reported'),
        cleared: inSection('cleared'),
      };
    };

    const before = await snapshot();
    expect(before.reported).toEqual([renamed, described].sort());
    expect(before.queued).toEqual([]);
    expect(before.attention).toEqual([renamed, described].sort());

    expect(await renameGame(env, renamed, users.author, '改名後の題名', 1_700_003_000)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await describeGame(env, described, users.author, '書き足した説明', 1_700_003_000)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await renameGame(env, quiet, users.author, '見終えた作品の新しい題名', 1_700_003_000)).toMatchObject({
      ok: true,
      changed: true,
    });

    const after = await snapshot();
    expect(after.queued).toEqual([renamed, described].sort());
    expect(after.reported).toEqual([]);
    expect(after.cleared).toEqual([]);
    expect(after.attention).toEqual(before.attention);
    expect([...after.queued, ...after.reported].sort()).toEqual(after.attention);
    expect(await reviewStateOf(quiet)).toBeNull();
  });

  it('この節も件数を固定する（2.3.3 の条件 1 と同じ考え方）', async () => {
    for (let index = 0; index < ADMIN_LIST_LIMIT + 3; index += 1) {
      await insertReportedAfterClear(`改名後 ${index}`);
    }

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(body, 'reported').split('<li class="gf-block gf-admin-row">').length - 1).toBe(
      ADMIN_LIST_LIMIT,
    );
  });

  it('この節の行から審査待ちへ戻し、問題なしにし直すと節から外れる（新しい操作ではなく、既存の口を通る）', async () => {
    const reported = await insertReportedAfterClear();
    const back = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: reported,
        [ADMIN_NEXT_FIELD]: REVIEW_QUEUED,
        [ADMIN_REASON_FIELD]: '改名後の題名が不適切',
      },
      adminCookie,
    );
    expect(back.status).toBe(303);
    expect(back.location).toBe(`${ADMIN_HOME_PATH}?outcome=applied`);
    expect(await reviewStateOf(reported)).toBe(REVIEW_QUEUED);

    const afterBack = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(afterBack.body, 'queued')).toContain(reported);
    expect(sectionOf(afterBack.body, 'reported')).not.toContain(reported);

    // **確かめて問題が無ければ、問題なしにし直す。** 口が積む履歴の時刻（いま）が新しい
    // 基準になり、それより前の通報では当たらない——#367 のときは次の改名まで残った。
    const forward = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: reported,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '確かめたが問題なし',
      },
      adminCookie,
    );
    expect(forward.location).toBe(`${ADMIN_HOME_PATH}?outcome=applied`);

    const afterForward = await open(ADMIN_HOME_PATH, adminCookie);
    expect(sectionOf(afterForward.body, 'reported')).not.toContain(reported);
    expect(sectionOf(afterForward.body, 'cleared')).toContain(reported);
  });

  it('権限が無ければ 404 のままで、この節の作品は本文に 1 バイトも出ない', async () => {
    // **この issue は経路を足していない**（`ADMIN_OPEN_ROUTES` にも足していない）。
    // 足した「中身」が権限の手前へ漏れていないことを、同じ `/` で確かめる。
    const reported = await insertReportedAfterClear('漏れてはいけない題名');
    expect(
      ADMIN_OPEN_ROUTES.some((route) => route.path === ADMIN_HOME_PATH),
      '/ が未ログインで開いている',
    ).toBe(false);

    for (const cookie of [undefined, await cookieFor(users.other)]) {
      const { status, body } = await open(ADMIN_HOME_PATH, cookie);
      expect(status).toBe(404);
      expect(body).not.toContain(reported);
      expect(body).not.toContain('漏れてはいけない題名');
      expect(body).not.toContain('問題なしのあとに通報あり');
    }
  });

  it('3 つの節（と、節ごとの通報の時点の値。#405）を 1 つの batch で読む（同じ時点の状態から描き、同じ作品を 2 節に出さない）', async () => {
    // **節ごとに別々に読むと、間に別の管理者の操作が挟まったとき、同じ作品が
    // 向きの違うボタン付きで 2 節に並ぶ**（PR #392 の Copilot レビュー）。D1 の batch は
    // 1 つの SQL トランザクションで、文を順に・並行せずに実行する（Cloudflare の D1
    // Worker API の `batch()`）。ここでは画面がその経路を通ることを見る。
    await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    await insertReportedAfterClear();
    const batches: number[] = [];
    const spied = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            batches.push(statements.length);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await handleAdminRequest(
      new Request(`${ADMIN_ORIGIN}${ADMIN_HOME_PATH}`, { headers: { cookie: adminCookie } }),
      { ...testEnv(), DB: spied } as Env,
    );
    expect(response.status).toBe(200);
    // **一覧 3 本と、通報の時点の値 3 本**（#405）。本数が通報の数に依らないことは
    // #405 の describe が見る。
    expect(batches).toEqual([6]);
  });

  it('操作が成功した直後に一覧が読めなければ、成功の知らせと読み取り失敗の知らせを両方出す', async () => {
    // **成功の知らせは消さない**——操作と履歴は既にコミットされている。消すと運営は
    // 失敗したと読んで押し直す。**不完全なのは一覧の側**なので、それを並べて書く。
    await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    await env.DB.prepare(`alter table ${TITLE_CHANGES_TABLE} rename to title_changes_hidden`).run();
    try {
      const { status, body } = await open(`${ADMIN_HOME_PATH}?outcome=applied`, adminCookie);
      expect(status).toBe(500);
      expect(body).toContain('<p class="gf-notice" role="status">');
      expect(body).toContain('一覧の一部を読み込めませんでした。下の一覧は不完全です。');
    } finally {
      await env.DB.prepare(`alter table title_changes_hidden rename to ${TITLE_CHANGES_TABLE}`).run();
    }
  });

  // **履歴の表のどちらが読めなくても、審査待ちの節は出る。** `title_changes`（0027）は
  // 最終改名の時刻が、`admin_actions`（0026）は #394 の条件が読む。
  for (const table of [TITLE_CHANGES_TABLE, 'admin_actions']) {
    it(`${table} が読めなくても、審査待ちの節は出る（適用漏れで一覧ごと落とさない）`, async () => {
      // **あとから足した読み取りの失敗で、#361 から動いていた一覧を巻き添えにしない。**
      // 表の名前を一時的に変えて「no such table」を再現する。
      const queued = await insertGame(REVIEW_QUEUED, '審査待ちの作品');
      await env.DB.prepare(`alter table ${table} rename to ${table}_hidden`).run();
      try {
        const { status, body } = await open(ADMIN_HOME_PATH, adminCookie);
        // **成功したかのようにログへ残さない。**
        expect(status).toBe(500);
        expect(sectionOf(body, 'queued')).toContain(queued);
        // **0 件と描かない**（「該当なし」と「読めていない」を区別する）。
        expect(body).toContain(`<h2>${HEADINGS.reported}（読み込めませんでした）</h2>`);
        expect(body).toContain(`<h2>${HEADINGS.cleared}（読み込めませんでした）</h2>`);
        expect(body).not.toContain('いま該当する作品はありません。');
      } finally {
        await env.DB.prepare(`alter table ${table}_hidden rename to ${table}`).run();
      }
    });
  }
});

describe('通報された時点の題名・説明・作者名を、いまの値と並べて出す（#405）', () => {
  /*
   * **変異で確かめた**（2026-09-13。`src/admin/report-evidence.ts` / `src/admin/review.ts` を
   * 1 か所ずつ書き換え、この describe と `test/report-evidence.test.ts` を回した）。
   *
   *   - 規則を無視していまの値を出す … 題名・説明・作者名の「通報の時点」と、規則の単体テストが赤
   *   - 規則の 1 と 2 の順を入れ替える … 「履歴が繋がっていないとき」と単体テストが赤（**履歴が
   *     繋がっていれば 2 つは同じ値になり、画面の他のテストでは区別できない**）
   *   - 同じ秒を無視する（関数で／SQL の `exists` を常に偽にして）… 「同じ秒」が赤
   *   - SQL の境界を 1 つずつずらす（`<=` → `<` / `<` → `<=` / `>=` → `>`）… 「同じ秒」か
   *     「履歴が繋がっていないとき」が赤。**`old_after` の `>` → `>=` だけは等価な変異である**
   *     （その列を使うのは T 以前に変更が無いときで、そのとき T と同じ秒の変更も無い）
   *   - 同じ秒の「前」の規則の順を入れ替える … 「履歴が繋がっていないとき」が赤
   *   - 記録の有無を見ない／履歴を書き始めた時刻と同じ秒を記録ありへ倒す … 「記録前の通報」
   *     「同じ秒の通報」と単体テストが赤
   *   - `??` を `||` にする … 単体テストの「空文字は値である」が赤
   *   - 表示名の履歴を作品の id で引く … 「表示名を変えた作者」「同じ秒」が赤
   *   - 1 作品の件数の上限を外す … 「5 件まで」が赤
   *   - 「変わっています」を常に偽にする … 3 つの「変わった」テストが赤
   *   - 通報の時点の値を `escapeHtml` に通さない … 「エスケープ」が赤
   *   - batch のあと、通報 1 件ごとに `select` を 1 本発行する … 「本数は通報の数に比例しない」が赤
   *   - 読み直しの中段（一覧の 3 本だけを読む）を外す … 「表示名の履歴が読めなくても」が赤
   */

  /** 表示名の履歴を書き始めた時刻（migration が書いた値。describe の後で戻す）。 */
  let originalStart = 0;

  /** 通報者（同じ人は同じ作品を 2 度通報できないので、何人か用意する）。 */
  const reporters: string[] = [];

  /** 表示名の履歴を書き始めた時刻として、テストが置く値（通報の時刻より十分前）。 */
  const RECORDED_SINCE = 1_600_000_000;

  beforeAll(async () => {
    const row = await env.DB.prepare(
      `select started_at from ${DISPLAY_NAME_HISTORY_START_TABLE} where id = 1`,
    ).first<{ started_at: number }>();
    originalStart = row?.started_at ?? 0;
    for (let index = 0; index < REPORT_EVIDENCE_PER_GAME + 2; index += 1) {
      reporters.push(await insertUser(`通報者${index}`));
    }
  });

  beforeEach(async () => {
    // **migration が書く時刻は「テストを走らせた瞬間」で、仕込む通報（2023 年）より後になる。**
    // そのままだと表示名はすべて「記録がありません」になるので、この describe では前へ置く。
    await setRecordedSince(RECORDED_SINCE);
  });

  afterAll(async () => {
    await setRecordedSince(originalStart);
  });

  /**
   * 表示名の履歴を書き始めた時刻を置き換える。
   *
   * @param startedAt 時刻（UNIX 秒）
   */
  async function setRecordedSince(startedAt: number): Promise<void> {
    await env.DB.prepare(`update ${DISPLAY_NAME_HISTORY_START_TABLE} set started_at = ? where id = 1`)
      .bind(startedAt)
      .run();
  }

  /**
   * 本文から、ある作品の行を切り出す。
   *
   * @param body 画面の本文
   * @param gameId 作品の id
   * @returns 行の HTML（見つからなければ空文字）
   */
  function rowOf(body: string, gameId: string): string {
    return body.split('<li class="gf-block gf-admin-row">').find((row) => row.includes(`value="${gameId}"`)) ?? '';
  }

  /**
   * 行から、通報 1 件の塊を切り出す（新しい順で何件目か）。
   *
   * @param row 行の HTML
   * @param index 0 始まりの位置
   * @returns 通報 1 件の HTML（無ければ空文字）
   */
  function reportOf(row: string, index = 0): string {
    return row.split('<li class="gf-admin-evidence-report">')[index + 1]?.split('</li>')[0] ?? '';
  }

  /**
   * 通報 1 件の塊から、項目 1 つ（見出しと値）を切り出す。
   *
   * @param report 通報 1 件の HTML
   * @param label 項目の名前（題名・説明・作者名）
   * @returns 項目の HTML（無ければ空文字）
   */
  function fieldOf(report: string, label: '題名' | '説明' | '作者名'): string {
    const start = report.indexOf(`<dt>${label} `);
    if (start < 0) {
      return '';
    }
    return report.slice(start, report.indexOf('</dd>', start));
  }

  /**
   * 「通報の時点」などの 1 行の値を出す形（エスケープ済みの本文と突き合わせる）。
   *
   * @param caption 行の見出し
   * @param value 値
   * @returns HTML の断片
   */
  function line(caption: string, value: string): string {
    return `<span class="gf-admin-evidence-label">${caption}</span> <span class="gf-admin-evidence-value">${value}</span>`;
  }

  it('通報のあとに改名された作品で、通報の時点の題名といまの題名を並べ、変わったと分かる', async () => {
    // **#405 の acceptance の 1 行目。**
    const gameId = await insertGame(REVIEW_QUEUED, '通報された題名');
    await insertReport(gameId, 1_700_002_000);
    expect(await renameGame(env, gameId, users.author, '穏当な題名', 1_700_003_000)).toMatchObject({
      ok: true,
      changed: true,
    });

    const { status, body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(status).toBe(200);
    const title = fieldOf(reportOf(rowOf(body, gameId)), '題名');
    expect(title).toContain('<span class="gf-chip">変わっています</span>');
    expect(title).toContain(line('通報の時点', '通報された題名'));
    expect(title).toContain(line('いま', '穏当な題名'));
  });

  it('通報の前に改名し、通報のあとにもう一度改名した作品では、通報の時点の題名は中間のもの', async () => {
    // **規則の 1（T 以前で最後の変更の新しい値）と 2（T より後で最初の変更の古い値）を
    // 1 つの作品の 2 件の通報で見る。** 1 件目は最初の改名より前、2 件目は 2 回の改名の間。
    const gameId = await insertGame(REVIEW_QUEUED, '最初の題名');
    await insertReport(gameId, 1_700_000_500, reporters[0]);
    await renameGame(env, gameId, users.author, '中間の題名', 1_700_001_000);
    await insertReport(gameId, 1_700_002_000, reporters[1]);
    await renameGame(env, gameId, users.author, '最後の題名', 1_700_003_000);

    const row = rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId);
    // **新しい順に並ぶ**（2 件目が先）。
    expect(fieldOf(reportOf(row, 0), '題名')).toContain(line('通報の時点', '中間の題名'));
    expect(fieldOf(reportOf(row, 1), '題名')).toContain(line('通報の時点', '最初の題名'));
    expect(fieldOf(reportOf(row, 1), '題名')).toContain(line('いま', '最後の題名'));
  });

  it('変更が 1 件も無ければ、いまの値を通報の時点の値として出し、変わっていないと書く（題名・説明）', async () => {
    // **題名と説明は、履歴を足す前にも変える経路が無かった**（`src/admin/report-evidence.ts` の
    // 冒頭）ので、変更が無ければいまの値でよい。
    const gameId = await insertGame(REVIEW_QUEUED, '変えていない題名');
    await insertReport(gameId, 1_700_002_000);

    const report = reportOf(rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId));
    expect(fieldOf(report, '題名')).toContain('<span class="gf-chip">変わっていません</span>');
    expect(fieldOf(report, '題名')).toContain(line('通報の時点', '変えていない題名'));
    // 説明は空（書いていない）。**空を「値が無い」と取り違えない**ように「（空）」と書く。
    expect(fieldOf(report, '説明')).toContain('変わっていません');
    expect(fieldOf(report, '説明')).toContain(
      '<span class="gf-admin-evidence-label">通報の時点</span> <span class="gf-admin-evidence-none">（空）</span>',
    );
  });

  it('通報のあとに説明を書き換えた作品で、通報の時点の説明が出る', async () => {
    // **#405 の acceptance の 2 行目。**
    const gameId = await insertGame(REVIEW_QUEUED, '説明のある作品');
    expect(await describeGame(env, gameId, users.author, '通報された説明\n2 行目', 1_700_001_000)).toMatchObject({
      ok: true,
    });
    await insertReport(gameId, 1_700_002_000);
    expect(await describeGame(env, gameId, users.author, '穏当な説明', 1_700_003_000)).toMatchObject({
      ok: true,
      changed: true,
    });

    const description = fieldOf(
      reportOf(rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId)),
      '説明',
    );
    expect(description).toContain('変わっています');
    // **改行はそのまま残す**（CSS の `pre-wrap` で保つ）。
    expect(description).toContain(line('通報の時点', '通報された説明\n2 行目'));
    expect(description).toContain(line('いま', '穏当な説明'));
  });

  it('通報のあとに表示名を変えた作者で、通報の時点の表示名が出る', async () => {
    // **#405 の acceptance の 3 行目。** 変更は本物の関数で行う（履歴を書く経路を通す）。
    const author = await insertUser('運営を名乗った作者');
    const gameId = await insertGame(REVIEW_QUEUED, 'なりすましの作品', author);
    await insertReport(gameId, 1_700_002_000);
    expect(await changeDisplayName(env.DB, author, '穏当な名前', 1_700_003_000)).toEqual({ ok: true });

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    const name = fieldOf(reportOf(rowOf(body, gameId)), '作者名');
    expect(name).toContain('変わっています');
    expect(name).toContain(line('通報の時点', '運営を名乗った作者'));
    expect(name).toContain(line('いま', '穏当な名前'));
  });

  it('表示名の履歴を書き始める前の通報では、いまの名前を通報の時点の名前として出さない', async () => {
    // **#405 の acceptance の 4 行目。** 通報は履歴を書き始める前、名前の変更（記録されない）も
    // その前にあったとすると、いまの名前は通報の時点の名前ではない。**見分けられないので、
    // 記録が無いと書く。**
    const author = await insertUser('記録前の作者');
    const gameId = await insertGame(REVIEW_QUEUED, '記録前に通報された作品', author);
    await insertReport(gameId, 1_700_002_000);
    await setRecordedSince(1_700_002_500);

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    const name = fieldOf(reportOf(rowOf(body, gameId)), '作者名');
    expect(name).toContain('<span class="gf-chip">記録がありません</span>');
    expect(name).toContain('この時点の作者名の記録はありません');
    expect(name).not.toContain(line('通報の時点', '記録前の作者'));
    // **いまの値は出す**（並べる片方として。当時の値としてではない）。
    expect(name).toContain(line('いま', '記録前の作者'));
    // **題名は同じ通報でも復元する**（表示名だけの扱いである）。
    expect(fieldOf(reportOf(rowOf(body, gameId)), '題名')).toContain(
      line('通報の時点', '記録前に通報された作品'),
    );
  });

  it('履歴を書き始めた時刻と同じ秒の通報も、記録が無い側に倒す', async () => {
    const author = await insertUser('境界の作者');
    const gameId = await insertGame(REVIEW_QUEUED, '境界の作品', author);
    await insertReport(gameId, 1_700_002_000);
    await setRecordedSince(1_700_002_000);

    const name = fieldOf(reportOf(rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId)), '作者名');
    expect(name).toContain('この時点の作者名の記録はありません');

    // 1 秒前へずらせば記録がある。
    await setRecordedSince(1_700_001_999);
    const recorded = fieldOf(
      reportOf(rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId)),
      '作者名',
    );
    expect(recorded).toContain(line('通報の時点', '境界の作者'));
  });

  it('通報と同じ秒の変更は、どちらかに倒さず、前と後の両方を出して同じ秒だと書く', async () => {
    const author = await insertUser('同じ秒の作者');
    const gameId = await insertGame(REVIEW_QUEUED, '同じ秒の前の題名', author);
    await insertReport(gameId, 1_700_002_000);
    await renameGame(env, gameId, author, '同じ秒の後の題名', 1_700_002_000);
    await changeDisplayName(env.DB, author, '同じ秒の後の名前', 1_700_002_000);

    const report = reportOf(rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId));
    for (const [label, before, after] of [
      ['題名', '同じ秒の前の題名', '同じ秒の後の題名'],
      ['作者名', '同じ秒の作者', '同じ秒の後の名前'],
    ] as const) {
      const field = fieldOf(report, label);
      expect(field, label).toContain(
        '<span class="gf-chip">通報と同じ秒に変更がありました</span>',
      );
      expect(field, label).toContain(line('同じ秒の変更の前', before));
      expect(field, label).toContain(line('同じ秒の変更の後', after));
      // **「通報の時点」として 1 つの値を出さない。**
      expect(field, label).not.toContain('<span class="gf-admin-evidence-label">通報の時点</span>');
    }
  });

  it('履歴が繋がっていないとき（記録されない変更を挟んだとき）も、規則の順と秒の境界を守る', async () => {
    // **履歴が繋がっていれば「T 以前で最後の新しい値」と「T より後で最初の古い値」は同じ値**に
    // なり、規則の順や `<=` / `<` の取り違えが画面に出ない。運営の直接 UPDATE（5.9）は履歴を
    // 書かないので、実際には繋がらない履歴がありうる。**行を直接積んで、その形を作る。**
    const gameId = await insertGame(REVIEW_QUEUED, 'いまの題名');
    /**
     * 改名の履歴を 1 行、時刻と値を決めて積む。
     *
     * @param oldTitle 旧い題名
     * @param newTitle 新しい題名
     * @param changedAt 時刻（UNIX 秒）
     */
    const history = async (oldTitle: string, newTitle: string, changedAt: number): Promise<void> => {
      await env.DB.prepare(
        `insert into ${TITLE_CHANGES_TABLE} (id, game_id, old_title, new_title, changed_at) values (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), gameId, oldTitle, newTitle, changedAt)
        .run();
    };
    await history('A', 'B', 1_700_001_000);
    await history('C', 'D', 1_700_002_000);
    await history('E', 'いまの題名', 1_700_003_000);
    // 1 件目: 2 つの変更の間（同じ秒の変更なし）。**規則の 1（B）を、規則の 2（E ではなく C）より先に使う。**
    await insertReport(gameId, 1_700_001_500, reporters[0]);
    // 2 件目: 2 つ目の変更と同じ秒。**前は B**（境界を 1 秒手前へずらした規則の 1——その秒より
    // 前で最後の変更の新しい値を、その秒の変更の古い値 C より先に使う）、**後は D。**
    await insertReport(gameId, 1_700_002_000, reporters[1]);

    const row = rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId);
    const sameSecond = fieldOf(reportOf(row, 0), '題名');
    expect(sameSecond).toContain(line('同じ秒の変更の前', 'B'));
    expect(sameSecond).toContain(line('同じ秒の変更の後', 'D'));
    expect(fieldOf(reportOf(row, 1), '題名')).toContain(line('通報の時点', 'B'));
  });

  it('通報の時点の値もエスケープして出す（利用者が書いた値である）', async () => {
    const gameId = await insertGame(REVIEW_QUEUED, '<img src=x onerror=alert(1)>');
    await insertReport(gameId, 1_700_002_000);
    await renameGame(env, gameId, users.author, '改名後', 1_700_003_000);

    const { body } = await open(ADMIN_HOME_PATH, adminCookie);
    expect(body).not.toContain('<img src=x');
    expect(fieldOf(reportOf(rowOf(body, gameId)), '題名')).toContain(
      line('通報の時点', '&lt;img src=x onerror=alert(1)&gt;'),
    );
  });

  it(`1 作品に出す通報は新しい順に ${REPORT_EVIDENCE_PER_GAME} 件までで、残りの件数を書く`, async () => {
    const gameId = await insertGame(REVIEW_QUEUED, '通報の多い作品');
    for (let index = 0; index < REPORT_EVIDENCE_PER_GAME + 2; index += 1) {
      await insertReport(gameId, 1_700_002_000 + index, reporters[index]);
    }

    const row = rowOf((await open(ADMIN_HOME_PATH, adminCookie)).body, gameId);
    expect(row.split('<li class="gf-admin-evidence-report">').length - 1).toBe(REPORT_EVIDENCE_PER_GAME);
    expect(row).toContain(
      `通報 ${REPORT_EVIDENCE_PER_GAME + 2} 件のうち、新しい ${REPORT_EVIDENCE_PER_GAME} 件の時点の値です（ほかに古い通報が 2 件あります）。`,
    );
  });

  it('読み取りの本数は、通報の数に比例しない（通報ごとに問い合わせを発行しない）', async () => {
    // **#405 の acceptance。** 通報が少ない画面と多い画面で、`prepare` の回数と batch の形を
    // 突き合わせる。**すべての文が 1 つの batch に入り、本数が変わらない**ことを見る
    // （batch の外で `.all()` / `.first()` を呼ぶ文があれば、`prepare` の回数が batch の本数を超える）。
    /**
     * 画面を開き、D1 の呼ばれ方を数える。
     *
     * @returns `prepare` の回数と、batch ごとの文の本数
     */
    const measure = async (): Promise<{ prepares: number; batches: number[] }> => {
      let prepares = 0;
      const batches: number[] = [];
      const spied = new Proxy(env.DB, {
        get(target, property) {
          if (property === 'prepare') {
            return (sql: string) => {
              prepares += 1;
              return target.prepare(sql);
            };
          }
          if (property === 'batch') {
            return (statements: D1PreparedStatement[]) => {
              batches.push(statements.length);
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const response = await handleAdminRequest(
        new Request(`${ADMIN_ORIGIN}${ADMIN_HOME_PATH}`, { headers: { cookie: adminCookie } }),
        { ...testEnv(), DB: spied } as Env,
      );
      expect(response.status).toBe(200);
      return { prepares, batches };
    };

    const games = [
      await insertGame(REVIEW_QUEUED, '比べる作品 1'),
      await insertGame(REVIEW_QUEUED, '比べる作品 2'),
    ];
    const cleared = await insertGame(REVIEW_CLEARED, '比べる作品 3');
    await insertReport(games[0]!, 1_700_002_000, reporters[0]);
    const few = await measure();

    // 通報を 1 件から 15 件へ増やす（3 つの節にまたがる）。
    for (const gameId of [...games, cleared]) {
      for (let index = 1; index < REPORT_EVIDENCE_PER_GAME + 1; index += 1) {
        await insertReport(gameId, 1_700_002_000 + index, reporters[index]);
      }
    }
    const many = await measure();

    // **認可の読み取り（`handleAdminRequest` が batch の手前で行う）も同じ本数である**ので、
    // 回数そのものを比べてよい。
    expect(many).toEqual(few);
    expect(many.batches).toEqual([6]);
    // 増やした通報が実際に画面に出ている（読み取りを減らして「出していない」ではない）。
    const body = (await open(ADMIN_HOME_PATH, adminCookie)).body;
    expect(rowOf(body, cleared).split('<li class="gf-admin-evidence-report">').length - 1).toBe(
      REPORT_EVIDENCE_PER_GAME,
    );
  });

  it('表示名の履歴が読めなくても、一覧の 3 節は出し、通報の時点の値だけを読めなかったと書く', async () => {
    // **#405 で足した表の適用漏れで、#367 / #394 から動いていた一覧を巻き添えにしない。**
    const queued = await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    await insertReport(queued, 1_700_002_000);
    const reported = await insertReportedAfterClear();
    await env.DB.prepare(`alter table ${DISPLAY_NAME_CHANGES_TABLE} rename to ${DISPLAY_NAME_CHANGES_TABLE}_hidden`).run();
    try {
      const { status, body } = await open(ADMIN_HOME_PATH, adminCookie);
      // **成功したかのようにログへ残さない。**
      expect(status).toBe(500);
      expect(body).toContain('一覧の一部を読み込めませんでした。下の一覧は不完全です。');
      expect(sectionOf(body, 'queued')).toContain(queued);
      expect(sectionOf(body, 'reported')).toContain(reported);
      expect(body).not.toContain('（読み込めませんでした）</h2>');
      // **「通報が無い」と書かない**（読めていないだけである）。
      expect(rowOf(body, queued)).toContain('通報の時点の題名・説明・作者名を読み込めませんでした');
      expect(rowOf(body, queued)).not.toContain('この作品の通報は見つかりませんでした。');
    } finally {
      await env.DB.prepare(`alter table ${DISPLAY_NAME_CHANGES_TABLE}_hidden rename to ${DISPLAY_NAME_CHANGES_TABLE}`).run();
    }
  });

  it('権限が無ければ 404 のままで、通報の時点の値は本文に 1 バイトも出ない', async () => {
    const gameId = await insertGame(REVIEW_QUEUED, '改名前の漏れてはいけない題名');
    await insertReport(gameId, 1_700_002_000);
    await renameGame(env, gameId, users.author, '改名後の漏れてはいけない題名', 1_700_003_000);
    expect(ADMIN_OPEN_ROUTES.some((route) => route.path === ADMIN_HOME_PATH)).toBe(false);

    for (const cookie of [undefined, await cookieFor(users.other)]) {
      const { status, body } = await open(ADMIN_HOME_PATH, cookie);
      expect(status).toBe(404);
      expect(body).not.toContain('漏れてはいけない題名');
      expect(body).not.toContain('gf-admin-evidence');
    }
  });
});

describe('審査の往復（口を通す。2.4.3）', () => {
  it('queued → cleared → queued が往復でき、履歴が 2 行積まれる', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);

    const forward = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '見たが問題なし',
      },
      adminCookie,
    );
    // **POST-redirect-GET で一覧へ戻す**（9.3。303 でなければ再送が操作を積む）。
    expect(forward.status).toBe(303);
    expect(forward.location).toBe(`${ADMIN_HOME_PATH}?outcome=applied`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);

    const back = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: REVIEW_QUEUED,
        [ADMIN_REASON_FIELD]: '追加の通報があった',
      },
      adminCookie,
    );
    expect(back.status).toBe(303);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);

    const entries = await listAdminActions(env);
    expect(entries.map((entry) => entry.action)).toEqual(['review-queued', 'review-cleared']);
    expect(entries.every((entry) => entry.actorId === users.admin)).toBe(true);
  });

  it('理由が空だと断り、状態も履歴も動かない（2.4.4）', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);
    const { status, location } = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '   ',
      },
      adminCookie,
    );

    expect(status).toBe(303);
    expect(location).toBe(`${ADMIN_HOME_PATH}?outcome=reason-empty`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('理由の項目そのものが無い要求も断る', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);
    const { location } = await post(
      ADMIN_REVIEW_API_PATH,
      { [ADMIN_GAME_ID_FIELD]: gameId, [ADMIN_NEXT_FIELD]: REVIEW_CLEARED },
      adminCookie,
    );
    expect(location).toBe(`${ADMIN_HOME_PATH}?outcome=reason-empty`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
  });

  it('知らない向きを既定へ落とさずに断る（反対向きの操作にしない）', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);
    const { location } = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: 'removed',
        [ADMIN_REASON_FIELD]: '取り下げはこの画面に無い',
      },
      adminCookie,
    );
    expect(location).toBe(`${ADMIN_HOME_PATH}?outcome=invalid-target`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('画面を開いたまま状態が変わっていたら、上書きせずに断る', async () => {
    // **先に SELECT して確認する形にしない**（`src/invites.ts` と同じ規律）。
    // ここでは「別の管理者が先に `cleared` にした」状況を作る。
    const gameId = await insertGame(REVIEW_CLEARED);
    const { location } = await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        // 画面は `queued` の行として描いていたので、`cleared` にしようとする。
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '古い画面から押した',
      },
      adminCookie,
    );
    // **既にその状態だった**（操作は履歴に残るが、状態は動かない）。
    expect(location).toBe(`${ADMIN_HOME_PATH}?outcome=unchanged`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);
    expect((await listAdminActions(env)).length).toBe(1);
  });

  it('フォーム以外の形式を断る', async () => {
    const response = await handleAdminRequest(
      new Request(`${ADMIN_ORIGIN}${ADMIN_REVIEW_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: '{}',
      }),
      testEnv(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ADMIN_HOME_PATH}?outcome=invalid-request`);
  });
});

describe('利用者の一覧と BAN（2.4.3 / 7.3）', () => {
  it('利用者が並び、メールアドレスは出さない', async () => {
    const { status, body } = await open(ADMIN_USERS_PATH, adminCookie);
    expect(status).toBe(200);
    expect(body).toContain(users.other);
    // **出す理由が無いものを出さない**（`src/admin/users.ts`）。
    expect(body).not.toContain('@example.test');
  });

  it('自分自身には BAN のボタンを出さない', async () => {
    const { body } = await open(ADMIN_USERS_PATH, adminCookie);
    const ownRow = body
      .split('<li class="gf-block gf-admin-row">')
      .find((chunk) => chunk.includes(users.admin));
    expect(ownRow, '自分の行が無い').toBeDefined();
    expect(ownRow!).toContain('自分自身は BAN できません');
    expect(ownRow!).not.toContain(`value="${BAN_NEXT_BANNED}"`);
  });

  it('BAN と解除が往復でき、履歴が 2 行積まれる', async () => {
    const banned = await post(
      ADMIN_BAN_API_PATH,
      {
        [ADMIN_USER_ID_FIELD]: users.other,
        [ADMIN_NEXT_FIELD]: BAN_NEXT_BANNED,
        [ADMIN_REASON_FIELD]: '費用 DoS の疑い',
      },
      adminCookie,
    );
    expect(banned.status).toBe(303);
    expect(banned.location).toBe(`${ADMIN_USERS_PATH}?outcome=applied`);
    expect(await bannedAtOf(users.other)).not.toBeNull();

    const lifted = await post(
      ADMIN_BAN_API_PATH,
      {
        [ADMIN_USER_ID_FIELD]: users.other,
        [ADMIN_NEXT_FIELD]: BAN_NEXT_ACTIVE,
        [ADMIN_REASON_FIELD]: '誤認だった',
      },
      adminCookie,
    );
    expect(lifted.location).toBe(`${ADMIN_USERS_PATH}?outcome=applied`);
    expect(await bannedAtOf(users.other)).toBeNull();

    expect((await listAdminActions(env)).map((entry) => entry.action)).toEqual([
      'user-unbanned',
      'user-banned',
    ]);
  });

  it('自分自身を BAN する要求は、本文を手で作っても断る', async () => {
    // **画面にボタンが無いことは、口が守っていることではない。**
    const { location } = await post(
      ADMIN_BAN_API_PATH,
      {
        [ADMIN_USER_ID_FIELD]: users.admin,
        [ADMIN_NEXT_FIELD]: BAN_NEXT_BANNED,
        [ADMIN_REASON_FIELD]: '自分を止める',
      },
      adminCookie,
    );
    expect(location).toBe(`${ADMIN_USERS_PATH}?outcome=invalid-target`);
    expect(await bannedAtOf(users.admin)).toBeNull();
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('理由が空だと断り、BAN も履歴も入らない', async () => {
    const { location } = await post(
      ADMIN_BAN_API_PATH,
      {
        [ADMIN_USER_ID_FIELD]: users.other,
        [ADMIN_NEXT_FIELD]: BAN_NEXT_BANNED,
        [ADMIN_REASON_FIELD]: '',
      },
      adminCookie,
    );
    expect(location).toBe(`${ADMIN_USERS_PATH}?outcome=reason-empty`);
    expect(await bannedAtOf(users.other)).toBeNull();
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('BAN で止まる範囲と、止まらない露出の両方を画面に書いてある（7.3）', async () => {
    // **書かないと、運営は「BAN したのに作品が出ている」を不具合だと読む。**
    // **止まる範囲も正しく書く**——`resolveSessionUser` が拒否するので、生成も招待も
    // 止まる（PR #364 のレビューの指摘）。「ログインだけ」と書くと誤認させる。
    const { body } = await open(ADMIN_USERS_PATH, adminCookie);
    expect(body).toContain('ログインを要する操作がすべて止まります');
    expect(body).toContain('止まらないのは露出です');
  });
});

describe('操作の履歴の画面（2.4.4）', () => {
  it('操作した内容と理由が並ぶ', async () => {
    const gameId = await insertGame(REVIEW_QUEUED);
    await post(
      ADMIN_REVIEW_API_PATH,
      {
        [ADMIN_GAME_ID_FIELD]: gameId,
        [ADMIN_NEXT_FIELD]: REVIEW_CLEARED,
        [ADMIN_REASON_FIELD]: '通報を見たが問題なし',
      },
      adminCookie,
    );

    const { status, body } = await open(ADMIN_ACTIONS_PATH, adminCookie);
    expect(status).toBe(200);
    expect(body).toContain('通報を見たが問題なし');
    expect(body).toContain(gameId);
    expect(body).toContain('管理者');
    // **実行者の id も出す**（表示名は変えられて重複も許されるので、名前だけでは
    // どの管理者が操作したのかを決められない。PR #364 のレビューの指摘）。
    expect(body).toContain(users.admin);
  });

  it('理由をエスケープして出す（運営が書いた自由記述である）', async () => {
    await env.DB.prepare(
      `insert into admin_actions
         (id, actor_id, created_at, action, target_kind, target_id, reason)
       values (?, ?, 1, 'user-banned', 'user', ?, ?)`,
    )
      .bind(crypto.randomUUID(), users.admin, users.other, '<script>alert(1)</script>')
      .run();

    const { body } = await open(ADMIN_ACTIONS_PATH, adminCookie);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('限界（端末からは書き換えられる）を画面に書いてある', async () => {
    // **「改竄できない記録」と誤解させない**（`migrations/0026_admin_actions.sql`）。
    const { body } = await open(ADMIN_ACTIONS_PATH, adminCookie);
    expect(body).toContain('追記のみ');
    expect(body).toContain('D1 の資格情報を持つ端末からは');
  });

  it('操作の口を持たない（読むだけの画面である）', () => {
    const posts = createAdminRoutes()
      .filter((route) => route.method === 'POST')
      .map((route) => route.path);
    expect(posts).not.toContain(ADMIN_ACTIONS_PATH);
  });
});

/**
 * 削除依頼を 1 件入れる（受付の口は `test/legal.test.ts` が見る）。
 *
 * @param gameId 依頼に書かれた作品の id（実在しなくてよい）
 * @param fields 上書きする列
 * @returns 依頼の id
 */
async function insertTakedown(
  gameId: string,
  fields: {
    readonly claimantName?: string;
    readonly receivedAt?: number;
    readonly handledAt?: number;
    readonly action?: string;
    readonly note?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into takedown_requests
       (id, game_id, claimant_name, claimant_contact, body, received_at, handled_at, action, note)
     values (?, ?, ?, 'owner@example.invalid', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      gameId,
      fields.claimantName ?? '権利者',
      '当社の著作物です。\n2 行目の本文。',
      fields.receivedAt ?? 100,
      fields.handledAt ?? null,
      fields.action ?? null,
      fields.note ?? null,
    )
    .run();
  return id;
}

describe('削除依頼の一覧と措置の記録（2.4.3 / 8.4 / #406）', () => {
  it('未対応の依頼が先に出て、フォームを持つ。措置済みはフォームを持たない', async () => {
    const gameId = await insertGame(null, '依頼された作品');
    const handled = await insertTakedown(gameId, {
      receivedAt: 500,
      handledAt: 600,
      action: 'rejected',
      note: '根拠が無い',
    });
    const pending = await insertTakedown(gameId, { receivedAt: 100 });

    const { status, body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    expect(status).toBe(200);
    // **受付が新しくても、措置済みは未対応より後に出る。**
    expect(body.indexOf(`takedown-${pending}`)).toBeGreaterThan(-1);
    expect(body.indexOf(`takedown-${pending}`)).toBeLessThan(body.indexOf(`takedown-${handled}`));
    // 未対応の行にだけ、その依頼の id を運ぶフォームがある。
    expect(body).toContain(`name="${ADMIN_TAKEDOWN_ID_FIELD}" value="${pending}"`);
    expect(body).not.toContain(`name="${ADMIN_TAKEDOWN_ID_FIELD}" value="${handled}"`);
    expect(body).toContain('根拠が無い');
    expect(body).toContain('依頼された作品');
    // **依頼者の値は未検証だと書く**（0018）。
    expect(body).toContain('依頼者（未検証）');
    expect(body).toContain('連絡先（未検証）');
    // **連絡先をリンクにしない。**
    expect(body).not.toContain('mailto:owner@example.invalid');
    // **画面より前に端末で記録した措置には、実行者の履歴が無いことを書く。**
    expect(body).toContain('履歴なし');
  });

  it('実在しない作品の依頼も壊れずに出る（0018）', async () => {
    const missing = `missing-${crypto.randomUUID()}`;
    await insertTakedown(missing);

    const { status, body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    expect(status).toBe(200);
    expect(body).toContain('見つかりません');
    expect(body).toContain(missing);
  });

  it('依頼の中身と作品の題名をエスケープして出す（非ログインの誰でも書ける値である）', async () => {
    const gameId = await insertGame(null, '<b>題名</b>');
    await insertTakedown(gameId, { claimantName: '<script>alert(1)</script>' });

    const { body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('<b>題名</b>');
  });

  it('restricted を送ると、作品が審査キューへ入り、履歴が 2 行増える', async () => {
    const gameId = await insertGame(null);
    const id = await insertTakedown(gameId);

    const { status, location } = await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'restricted',
        [ADMIN_REASON_FIELD]: '権利者の依頼により新規露出を止める',
      },
      adminCookie,
    );

    expect(status).toBe(303);
    expect(location).toBe(`${ADMIN_TAKEDOWNS_PATH}?outcome=applied`);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    expect((await listAdminActions(env)).map((entry) => entry.action).sort()).toEqual([
      'review-queued',
      'takedown-restricted',
    ]);

    // 記録した行は措置済みとして出て、実行者が分かる。
    const { body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    expect(body).not.toContain(`name="${ADMIN_TAKEDOWN_ID_FIELD}" value="${id}"`);
    expect(body).toContain(users.admin);
  });

  it('restricted でも止める作品が無ければ、その旨を出す（新規露出が止まったと読ませない）', async () => {
    const id = await insertTakedown(`missing-${crypto.randomUUID()}`);

    const { location } = await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'restricted',
        [ADMIN_REASON_FIELD]: '作品が見つからない',
      },
      adminCookie,
    );

    expect(location).toBe(`${ADMIN_TAKEDOWNS_PATH}?outcome=recorded-not-queued`);
    const { status, body } = await open(location, adminCookie);
    expect(status).toBe(200);
    expect(body).toContain('審査キューへは入れていません');
  });

  it('記録済みの依頼へもう 1 度送ると断り、何も書かない', async () => {
    const gameId = await insertGame(null);
    const id = await insertTakedown(gameId);
    const fields = {
      [ADMIN_TAKEDOWN_ID_FIELD]: id,
      [ADMIN_TAKEDOWN_ACTION_FIELD]: 'rejected',
      [ADMIN_REASON_FIELD]: '認めない',
    };
    await post(ADMIN_TAKEDOWN_API_PATH, fields, adminCookie);
    const before = await listAdminActions(env);

    const { location } = await post(
      ADMIN_TAKEDOWN_API_PATH,
      { ...fields, [ADMIN_TAKEDOWN_ACTION_FIELD]: 'restricted' },
      adminCookie,
    );

    expect(location).toBe(`${ADMIN_TAKEDOWNS_PATH}?outcome=already-handled`);
    expect(await listAdminActions(env)).toEqual(before);
    expect(await reviewStateOf(gameId)).toBeNull();
    const { status } = await open(location, adminCookie);
    expect(status).toBe(400);
  });

  it('知らない措置の綴りと空の理由は、D1 に触れずに断る', async () => {
    const gameId = await insertGame(null);
    const id = await insertTakedown(gameId);

    const unknown = await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'deleted',
        [ADMIN_REASON_FIELD]: '綴りが違う',
      },
      adminCookie,
    );
    expect(unknown.location).toBe(`${ADMIN_TAKEDOWNS_PATH}?outcome=invalid-target`);

    const empty = await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'rejected',
        [ADMIN_REASON_FIELD]: '　',
      },
      adminCookie,
    );
    expect(empty.location).toBe(`${ADMIN_TAKEDOWNS_PATH}?outcome=reason-empty`);

    const row = await env.DB.prepare('select handled_at from takedown_requests where id = ?')
      .bind(id)
      .first<{ handled_at: number | null }>();
    expect(row?.handled_at).toBeNull();
    expect(await listAdminActions(env)).toEqual([]);
  });

  it('removed を記録しても作品は公開中のままで、手作業が残っていることを出す（2.4.3）', async () => {
    const gameId = await insertGame(null);
    const id = await insertTakedown(gameId);

    await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'removed',
        [ADMIN_REASON_FIELD]: '依頼を認める',
      },
      adminCookie,
    );

    const game = await env.DB.prepare('select status from games where id = ?')
      .bind(gameId)
      .first<{ status: string }>();
    expect(game?.status).toBe(PUBLISHED_STATUS);
    const { body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    expect(body).toContain('作品はまだ公開中です');
  });

  it('操作の履歴に、削除依頼の措置と一覧の該当行へのリンクが出る', async () => {
    const id = await insertTakedown(`missing-${crypto.randomUUID()}`);
    await post(
      ADMIN_TAKEDOWN_API_PATH,
      {
        [ADMIN_TAKEDOWN_ID_FIELD]: id,
        [ADMIN_TAKEDOWN_ACTION_FIELD]: 'rejected',
        [ADMIN_REASON_FIELD]: '根拠が無い',
      },
      adminCookie,
    );

    const { body } = await open(ADMIN_ACTIONS_PATH, adminCookie);
    expect(body).toContain('「認めない」の措置を記録した');
    expect(body).toContain(`href="${ADMIN_TAKEDOWNS_PATH}#takedown-${id}"`);
  });

  it('本文の文の途中に、改行が作る空白を入れない', async () => {
    // **日本語の文の途中で HTML を改行すると、ブラウザはそこを空白 1 つとして描く**
    // （「措置は 上書きしません」。本番の画面で見つかった）。タグを落とした本文で、
    // 文が続いていることを見る。
    const { body } = await open(ADMIN_TAKEDOWNS_PATH, adminCookie);
    const text = body.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ');
    expect(text).toContain('届いただけでは作品は動きません。読んで判断し');
    expect(text).toContain('1 度記録した措置は上書きしません。');
    expect(text).toContain('戻せない操作なので、この画面に置いていません');
  });

  it('ヘッダのナビから削除依頼の画面へ行ける', async () => {
    const { body } = await open(ADMIN_ACTIONS_PATH, adminCookie);
    expect(body).toContain(`href="${ADMIN_TAKEDOWNS_PATH}"`);
  });
});

describe('管理画面の本文が見た目の規約の部品で組まれている（仕様 2.5 / #475）', () => {
  /** 4 画面（**綴りは正本の定数から取る**）。 */
  const SCREENS = [ADMIN_HOME_PATH, ADMIN_USERS_PATH, ADMIN_TAKEDOWNS_PATH, ADMIN_ACTIONS_PATH] as const;

  /** 1 件のブロックの開始タグ（審査キュー・利用者。削除依頼は `id` 属性が続く）。 */
  const ROW = '<li class="gf-block gf-admin-row">';

  /**
   * 本文から、ある id を含む 1 件を切り出す。
   *
   * @param body 画面の本文
   * @param id 行が含む id
   * @returns 行の HTML（見つからなければ空文字）
   */
  function rowContaining(body: string, id: string): string {
    return body.split(ROW).find((chunk) => chunk.includes(id)) ?? '';
  }

  /**
   * 4 画面のどれにも行と操作が出るように仕込む。
   *
   * @returns 仕込んだ作品と削除依頼の id
   */
  async function seedAll(): Promise<{ queued: string; pendingTakedown: string; handledTakedown: string }> {
    const queued = await insertGame(REVIEW_QUEUED, '審査待ちの作品');
    await insertReport(queued, 1_700_002_000);
    await insertReportedAfterClear();
    await insertGame(REVIEW_CLEARED, '問題なしとした作品');
    const pendingTakedown = await insertTakedown(queued, { receivedAt: 100 });
    const handledTakedown = await insertTakedown(queued, {
      receivedAt: 50,
      handledAt: 60,
      action: 'rejected',
      note: '根拠が無い',
    });
    await insertClearedAction(queued, 1_700_000_100);
    return { queued, pendingTakedown, handledTakedown };
  }

  it('4 画面で、行の操作のボタンがすべて副で、主のボタンが無い', async () => {
    // **行ごとに操作がある画面では主のボタンを使わない**（2.5.10 の第 4 版の決定。「主は 1 画面に 1 つ」を保つ）。
    // **BAN や措置の記録も副にし、赤くしない**（赤はエラーの意味だけ。2.5.2）。
    await seedAll();
    for (const path of SCREENS) {
      const { status, body } = await open(path, adminCookie);
      expect(status, path).toBe(200);
      const buttons = body.match(/<button\b[^>]*>/gu) ?? [];
      if (path !== ADMIN_ACTIONS_PATH) {
        // 操作の履歴は読むだけの画面で、ボタンを持たない（`src/admin/history.ts`）。
        expect(buttons.length, `${path} のボタンの数`).toBeGreaterThan(0);
      }
      for (const button of buttons) {
        expect(button, `${path} のボタン`).toBe('<button type="submit" class="gf-button gf-button-secondary">');
      }
      expect(body, `${path} に主のボタン`).not.toContain('gf-button-primary');
    }
  });

  it('4 画面で、フォームの中の並びがラベル → 入力欄 → ボタンのまま（DOM の順＝Tab の順）', async () => {
    // **見た目で並べ替えない**（`admin.css` は `order` も `display: contents` も使わない。下のテスト）。
    await seedAll();
    for (const path of SCREENS) {
      const { body } = await open(path, adminCookie);
      for (const form of body.match(/<form\b[\s\S]*?<\/form>/gu) ?? []) {
        const label = form.indexOf('<label for="reason-');
        const input = form.indexOf(`name="${ADMIN_REASON_FIELD}"`);
        const button = form.indexOf('<button ');
        expect(label, `${path} の理由のラベル`).toBeGreaterThan(-1);
        expect(label, path).toBeLessThan(input);
        expect(input, path).toBeLessThan(button);
        // **入力欄とボタンは 1 つの並びに入る**（狭い段では折り返して縦に積む。`admin.css` の `.gf-admin-submit`）。
        expect(form, path).toMatch(
          /<div class="gf-admin-submit">\s*<input [^>]*type="text" required>\s*<button [^>]*>[^<]*<\/button>\s*<\/div>/u,
        );
      }
    }
  });

  it('1 件ずつがブロックで、冒頭の説明もブロックにある', async () => {
    const { queued, pendingTakedown } = await seedAll();
    for (const path of SCREENS) {
      const { body } = await open(path, adminCookie);
      expect(body.split('<div class="gf-block gf-admin-intro">').length - 1, `${path} の冒頭の説明`).toBe(1);
      // **日本語の文の途中で HTML を改行しない**（ブラウザが空白 1 つとして描く。削除依頼の画面のテストと同じ理由）。
      const intro = /<div class="gf-block gf-admin-intro">([\s\S]*?)<\/div>/u.exec(body)?.[1] ?? '';
      for (const paragraph of intro.match(/<p>[\s\S]*?<\/p>/gu) ?? []) {
        expect(paragraph, `${path} の冒頭の説明の段落`).not.toContain('\n');
      }
    }
    expect(rowContaining((await open(ADMIN_HOME_PATH, adminCookie)).body, queued)).not.toBe('');
    const usersBody = (await open(ADMIN_USERS_PATH, adminCookie)).body;
    expect(usersBody.split(ROW).length - 1).toBeGreaterThanOrEqual(3);
    expect((await open(ADMIN_TAKEDOWNS_PATH, adminCookie)).body).toContain(
      `<li class="gf-block gf-admin-row" id="takedown-${pendingTakedown}">`,
    );
    // **操作の履歴は 1 つのブロックの中の行である**（行ごとに操作が無いので、1 件ずつのブロックに分けない）。
    expect((await open(ADMIN_ACTIONS_PATH, adminCookie)).body).toContain(
      '<ul class="gf-block gf-block-rows gf-admin-history">',
    );
  });

  it('審査キューの証跡・削除依頼の本文が、ブロックの中の地の色の面にある', async () => {
    const { queued, pendingTakedown } = await seedAll();

    const row = rowContaining((await open(ADMIN_HOME_PATH, adminCookie)).body, `value="${queued}"`);
    expect(row).toContain('<div class="gf-admin-evidence">');
    const takedownRow =
      (await open(ADMIN_TAKEDOWNS_PATH, adminCookie)).body
        .split('<li class="gf-block gf-admin-row"')
        .find((chunk) => chunk.includes(`id="takedown-${pendingTakedown}"`)) ?? '';
    expect(takedownRow).toContain('<p class="gf-admin-takedown-body">当社の著作物です。');

    // **地の色の面は `admin.css` の `.gf-admin-evidence` / `.gf-admin-row > .gf-admin-takedown-body` が塗る**
    // （`background: var(--gf-ground)`）。**CSS の中身はこのテストから読めない**——`public/` の下のファイルは Vite が
    // `?raw` で中身を渡さず（空文字になる）、`vitest.config.ts` の束縛にあるのは app.css だけである。面の色は撮影で確かめる（#475 の PR の本文）。
    // ここでは、**その面の要素が 1 件のブロック（`.gf-block`）の中にある**ことを見る。
    expect(row.length, '審査キューの行が無い').toBeGreaterThan(0);
    expect(takedownRow.length, '削除依頼の行が無い').toBeGreaterThan(0);
  });

  it('状態の印（変更あり・BAN 中・未対応 など）がチップの部品である', async () => {
    const { queued } = await seedAll();
    await renameGame(env, queued, users.author, '改名した題名', 1_700_003_000);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(users.other).run();
    await env.DB.prepare('update users set is_operator = 1 where id = ?').bind(users.admin).run();
    try {
      // 審査キュー: 節の札は強調のチップ、証跡の印は押せない札のチップ。
      const review = (await open(ADMIN_HOME_PATH, adminCookie)).body;
      expect(review).toContain('<span class="gf-chip gf-chip-emphasis">問題なしのあとに通報あり</span>');
      expect(rowContaining(review, `value="${queued}"`)).toContain(
        `<dt>題名 <span class="gf-chip">変わっています</span></dt>`,
      );

      // 利用者: 管理者・運営はチップ、**BAN 中だけ強調のチップ**。「通常」の札は付けない。
      const usersBody = (await open(ADMIN_USERS_PATH, adminCookie)).body;
      const rowFor = (id: string): string => rowContaining(usersBody, id);
      expect(rowFor(users.admin)).toContain('<span class="gf-chip">管理者</span>');
      expect(rowFor(users.admin)).toContain('<span class="gf-chip">運営</span>');
      expect(rowFor(users.admin)).not.toContain('BAN 中');
      expect(rowFor(users.other)).toContain('<span class="gf-chip gf-chip-emphasis">BAN 中</span>');
      expect(rowFor(users.author)).not.toContain('gf-chip');
      expect(usersBody).not.toContain('通常');

      // 削除依頼: **未対応だけ強調のチップ**、措置済みは押せない札のチップ。
      const takedowns = (await open(ADMIN_TAKEDOWNS_PATH, adminCookie)).body;
      expect(takedowns).toContain('<p class="gf-admin-row-head"><span class="gf-chip gf-chip-emphasis">未対応</span></p>');
      expect(takedowns).toContain('<p class="gf-admin-row-head"><span class="gf-chip">措置済み</span></p>');
    } finally {
      await env.DB.prepare('update users set is_operator = 0 where id = ?').bind(users.admin).run();
    }
  });
});
