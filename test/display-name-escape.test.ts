import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAccountRoutes } from '../src/account.js';
import { ACCOUNT_DISPLAY_NAME_PATH, ACCOUNT_PATH, DISPLAY_NAME_FIELD } from '../src/account-paths.js';
import { handleAppRequest } from '../src/app.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import { listCacheKey, purgeListCache } from '../src/list-cache.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { authorCacheKey, authorPagePath } from '../src/users-page.js';
import { renderWorkCard } from '../src/work-card.js';
import { workPagePath } from '../src/work-page.js';
import { PUBLIC_WORKS_PATH } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * 表示名を HTML へ出す場所が、すべてエスケープしていること（#341 / 仕様 5.9）。
 *
 * # なぜ要るのか
 *
 * **保存時の制約は XSS を防がない。** 5.9 が弾くのは長さ（30 文字）と制御文字だけで、
 * `<script>` も `"` も 30 文字に収まる。表示名は v1.50 で**未ログインの閲覧者にも見える
 * 値**になり（2.3）、#341 で**利用者が自由に決められる値**になった。1 か所でも
 * エスケープが抜ければ、その画面を開いた全員に対して任意のスクリプトが走る。
 *
 * # 何を確かめるか
 *
 * 表示名を出す画面を**1 枚ずつ**開き、生の名前が本文に 1 度も現れず、エスケープした
 * 形で現れることを見る。**「エスケープした形が現れる」まで見る**のは、名前を出さない
 * 画面（別の値を引いている、表示が消えた）を渡しても「生の名前が無い」だけなら緑に
 * なるためである（検査が空振りしたまま緑になる形を置かない）。
 *
 * | 画面 | 出す場所 |
 * |---|---|
 * | 作品ページ（`/works/<id>`） | `src/work-page.ts` の「作者:」 |
 * | 作品カード（`/works` ほか） | `src/work-card.ts` の `.gf-card-author` |
 * | 登録情報（`/account`） | `src/account.ts` の入力欄の `value` 属性 |
 * | **作者ページ（`/users/<user_id>`）** | `src/users-page.ts` の `<h1>` と `<title>` |
 *
 * **作者ページは #330 で足した。** あの画面は表示名を**見出しと `<title>` の両方**へ
 * 出すので、本文としても確かめる（`<title>` のエスケープは `siteHead` が中で行う。
 * 呼び出し側で二重に掛けていないことも、ここが通ることで分かる）。
 *
 * # 名前に何を入れるか
 *
 * **`"` と `'` と `<script>` を 1 つの名前に入れる。** `"` は属性値（`value="..."`）を
 * 閉じる文字で、本文だけをエスケープする実装はここで破れる。30 文字に収まることは
 * 最初のテストで、本物の変更の口を通して確かめる。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-name-escape-0001';

/** 属性も要素も破りにいく表示名（28 文字）。 */
const HOSTILE_NAME = `"'><script>alert(1)</script>`;

/**
 * {@link HOSTILE_NAME} をエスケープした形。
 *
 * **`escapeHtml` を呼んで作らない。** 期待値を検査対象と同じ関数で作ると、その関数が
 * 何もしなくなっても両辺が同じだけ変わって緑のままになる。
 */
const ESCAPED_NAME = '&quot;&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName: string): Promise<string> {
  const id = `escape-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 公開済みの作品を 1 件用意する。
 *
 * **公開時刻を遠い未来に置く。** `games` はテストファイルをまたいで共有されるので、
 * 公開一覧の 1 頁目（新しい順）に確実に載る値にする（`test/works-list.test.ts` の
 * 払い出しは 9,000,000,000 から 1 ずつ進む。それより十分に新しい）。
 *
 * @param authorId 作者
 * @returns 作品の id
 */
async function seedPublishedGame(authorId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, published_at,
                        generation_state, preview_key)
     values (?, ?, ?, ?, '', 1, ?, 'ready', ?)`,
  )
    .bind(id, authorId, PUBLISHED_STATUS, 'エスケープ検査の作品', 9_999_999_000, `escape-${id}`)
    .run();
  return id;
}

/**
 * 利用者のセッション cookie（`Cookie` ヘッダへ載せる形）を作る。
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
 * 本文に生の名前が無く、エスケープした形があることを確かめる。
 *
 * @param body HTML
 * @param where どの画面か（失敗時の見出し）
 */
function expectEscaped(body: string, where: string): void {
  expect(body, `${where} に生の表示名が出ています`).not.toContain(HOSTILE_NAME);
  expect(body, `${where} に表示名が見当たりません（検査が空振りします）`).toContain(ESCAPED_NAME);
}

beforeAll(async () => {
  await applySchema();
});

describe('表示名のエスケープ（#341 / 5.9）', () => {
  it('この名前は保存時の制約（30 文字・制御文字なし）を通る', async () => {
    // **通ることが前提である。** 保存時に弾かれるなら、以下の検査は起こりえない形を
    // 確かめていることになる。本物の変更の口を通して、変更できたことまで見る。
    expect([...HOSTILE_NAME].length).toBeLessThanOrEqual(30);
    const userId = await seedUser('Google の名前');
    const response = await dispatch(
      createAccountRoutes(),
      new Request(`${APP_ORIGIN}${ACCOUNT_DISPLAY_NAME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: await cookieFor(userId),
        },
        body: new URLSearchParams({ [DISPLAY_NAME_FIELD]: HOSTILE_NAME }).toString(),
      }),
      testEnv(),
    );
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=1`);
    const row = await env.DB.prepare('select display_name from users where id = ?')
      .bind(userId)
      .first<{ display_name: string }>();
    expect(row?.display_name).toBe(HOSTILE_NAME);
  });

  it('登録情報（/account）の入力欄でエスケープされる', async () => {
    const userId = await seedUser(HOSTILE_NAME);
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${ACCOUNT_PATH}`, { headers: { cookie: await cookieFor(userId) } }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expectEscaped(body, '/account');
    // 属性値の中に入っていることまで見る（本文だけをエスケープする実装を落とす）。
    expect(body).toContain(`value="${ESCAPED_NAME}"`);
  });

  it('作品ページ（/works/<id>）の作者名でエスケープされる', async () => {
    const authorId = await seedUser(HOSTILE_NAME);
    const gameId = await seedPublishedGame(authorId);
    // 未ログインの閲覧者として開く（表示名が外から見える、という 5.9 の前提そのもの）。
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${workPagePath(gameId)}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expectEscaped(body, '作品ページ');
    // **#330 で作者名が作者ページへのリンクになった。** エスケープが**リンクの中でも**
    // 効いていること（`<a>` の中身になっても素の名前へ戻っていないこと）を、
    // リンクの綴りごと確かめる。`/users/` の綴りは `authorPagePath` から取る。
    expect(body).toContain(
      `<a class="gf-author-link" href="${authorPagePath(authorId)}">${ESCAPED_NAME}</a>`,
    );
  });

  it('いいねの数が出る行でもエスケープされる（#340 でカードに数が増えた）', () => {
    // **項目を足した行でも抜けないことを見る**（#339 からの申し送り）。数は `<span>` を
    // 1 つ増やすので、`.gf-card-meta` の組み立てを書き換えた日にここを通る。
    // **数値そのものはエスケープの対象ではない**（`games.like_count` は整数列で、
    // UGC 由来の文字列ではない）。見ているのは、**同じ行に並ぶ表示名**である。
    const html = renderWorkCard({
      id: '00000000-0000-4000-8000-000000000001',
      title: '題名',
      authorName: HOSTILE_NAME,
      publishedAt: 1_800_000_000,
      forkCount: 3,
      likeCount: 7,
      hasParent: true,
      hasShot: false,
    });
    expectEscaped(html, 'いいねの数が出る作品カード');
    // 数が本当に出ていること（**空振りしないことを対で見る**）。
    expect(html, 'いいねの数が出ていない（検査が空振りします）').toContain('いいね 7');
  });

  it('作品カードの作者名でエスケープされる（部品そのもの）', () => {
    // 一覧・トップ・作者ページが同じ部品を使う（`src/work-card.ts`）。**部品で確かめて
    // おけば、カードを並べる画面が増えても抜けない。**
    const html = renderWorkCard({
      id: '00000000-0000-4000-8000-000000000000',
      title: '題名',
      authorName: HOSTILE_NAME,
      publishedAt: 1_800_000_000,
      forkCount: 0,
      likeCount: 0,
      hasParent: false,
      hasShot: false,
    });
    expectEscaped(html, '作品カード');
  });

  it('作者ページ（/users/<user_id>）の見出しでエスケープされる（#330）', async () => {
    // **表示名を `<h1>` に出す画面である。** 未ログインの閲覧者として開く（5.9 の
    // 「未ログインの閲覧者にも見える値」の前提そのもの）。
    const authorId = await seedUser(HOSTILE_NAME);
    await seedPublishedGame(authorId);
    // 作者ページも Cache API を前段に置く（`src/users-page.ts`）。開く前に捨てる。
    await purgeListCache(authorCacheKey(authorId, 1));
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${authorPagePath(authorId)}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expectEscaped(body, '作者ページ');
    // **見出しの中に入っていることまで見る**（`<title>` だけが出ていても通る形にしない）。
    expect(body).toContain(`<h1>${ESCAPED_NAME}</h1>`);
    // `<title>` は `siteHead` がエスケープする。**二重にエスケープしていない**
    // （`&amp;quot;` になっていたら、ここで落ちる）。
    expect(body).toContain(`<title>${ESCAPED_NAME} の作品 - Game Forge</title>`);
  });

  it('公開作品の一覧（/works）に並んだカードでエスケープされる', async () => {
    // 部品だけでなく、**画面まで通した経路**でも重ねて確かめる。一覧が部品を使わずに
    // 独自に作者名を書く形へ変わったとき、部品のテストだけでは気づけない。
    const authorId = await seedUser(HOSTILE_NAME);
    await seedPublishedGame(authorId);
    // 一覧は Cache API を前段に置く（`src/list-cache.ts`）。前のテストが溜めた行を
    // 読まないよう、開く前に捨てる（`test/works-list.test.ts` と同じ手順）。
    await purgeListCache(listCacheKey('works', { sort: 'recent', page: 1 }));
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}?sort=recent&page=1`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expectEscaped(await response.text(), '/works');
  });
});
