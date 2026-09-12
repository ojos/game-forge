import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIONS_PATH,
  ADMIN_BAN_API_PATH,
  ADMIN_GAME_ID_FIELD,
  ADMIN_HOME_PATH,
  ADMIN_NEXT_FIELD,
  ADMIN_REASON_FIELD,
  ADMIN_REVIEW_API_PATH,
  ADMIN_USERS_PATH,
  ADMIN_USER_ID_FIELD,
} from '../src/admin-paths.js';
import { ADMIN_LIST_LIMIT, listAdminActions } from '../src/admin/actions.js';
import { ADMIN_OPEN_ROUTES, createAdminRoutes, handleAdminRequest } from '../src/admin/routes.js';
import { BAN_NEXT_ACTIVE, BAN_NEXT_BANNED } from '../src/admin/users.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import { ssrPagePaths } from '../src/page-paths.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
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
 * @returns 作品の id
 */
async function insertGame(reviewState: string | null, title = '審査の対象'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', 1, 0, 0, 'ready', ?)`,
  )
    .bind(id, users.author, PUBLISHED_STATUS, title, reviewState)
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
  await env.DB.prepare('delete from games').run();
  await env.DB.prepare('update users set banned_at = null').run();
});

describe('足した経路は、権限が無いと 404 になる（2.4.2 / ADMIN_OPEN_ROUTES に足さない）', () => {
  /** M10-3 が足した 4 本（**綴りは正本の定数から取る**）。 */
  const ADDED: readonly { readonly method: 'GET' | 'POST'; readonly path: string }[] = [
    { method: 'GET', path: ADMIN_USERS_PATH },
    { method: 'GET', path: ADMIN_ACTIONS_PATH },
    { method: 'POST', path: ADMIN_REVIEW_API_PATH },
    { method: 'POST', path: ADMIN_BAN_API_PATH },
  ];

  it('足した 4 本が、本当に経路表に登録されている', () => {
    const registered = createAdminRoutes().map((route) => `${route.method} ${route.path}`);
    for (const route of ADDED) {
      expect(registered, `${route.method} ${route.path}`).toContain(
        `${route.method} ${route.path}`,
      );
    }
  });

  it('足した 4 本が 1 つも ADMIN_OPEN_ROUTES に入っていない（既定は「閉」）', () => {
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
  it('導出した画面が 3 枚あり、綴りが正本と一致する', () => {
    // **`ssrPagePaths` は `test/admin-page-shell.test.ts` が外枠の検査に使う導出である。**
    // ここでは「M10-3 の 3 枚がその網に入った」ことだけを見る（`/api/*` の 2 本は
    // POST なので、画面としては導かれない）。
    expect(ssrPagePaths(createAdminRoutes()).sort()).toEqual(
      [ADMIN_HOME_PATH, ADMIN_USERS_PATH, ADMIN_ACTIONS_PATH].sort(),
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
    expect(body.split('<li class="gf-admin-row">').length - 1).toBe(ADMIN_LIST_LIMIT);
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
      .split('<li class="gf-admin-row">')
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

  it('BAN は露出を止めないと画面に書いてある（7.3）', async () => {
    // **書かないと、運営は「BAN したのに作品が出ている」を不具合だと読む。**
    const { body } = await open(ADMIN_USERS_PATH, adminCookie);
    expect(body).toContain('BAN で止まるのはログインだけです');
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
  });

  it('理由をエスケープして出す（運営が書いた自由記述である）', async () => {
    await env.DB.prepare(
      `insert into admin_actions
         (id, actor_id, created_at, action, target_type, target_id, reason)
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
