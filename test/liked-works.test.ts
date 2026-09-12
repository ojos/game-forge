import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS } from '../src/games.js';
import type { PublicWork } from '../src/games.js';
import {
  HIDDEN_NOTICE,
  LIKED_PAGE_PARAM,
  LIKED_WORKS_PATH,
  LIKED_WORKS_PER_PAGE,
  MAX_LIKED_PAGE,
  likedWorksPath,
  likedWorksSql,
  renderLikedWorksPage,
  toLikedPageNumber,
  ALL_HIDDEN_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from '../src/liked-works.js';
import type { LikedWorksView } from '../src/liked-works.js';
import { changeLike } from '../src/likes.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import {
  findDuplicateRoutes,
  findMalformedPrefixRoutes,
} from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { WORK_PAGE_PREFIX, workPagePath } from '../src/work-page.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 「いいねした作品」（`/works/liked`。仕様 5.8 / 2.3.1 / M9-8 / #340）。
 *
 * # #340 の acceptance のうち、この画面が持つもの
 *
 * 1. **未ログインでログインへ送られる**
 * 2. **他人のいいねが 1 件も出ない**
 * 3. **公開をやめた作品が出ない**（審査で新規露出を止めた作品も出ない）
 *
 * # 絞り込みは引く時点で行う（#152 の規律）
 *
 * **画面側で `filter` していないことを、SQL そのものから確かめる**（{@link likedWorksSql}
 * が返す文字列を見る）。書き忘れても公開作品は正しく出るので、**動作では気づけない**
 * ——`src/games.ts` の `publishedGamesSql` について `test/works-list.test.ts` が同じ形で
 * 確かめている。
 *
 * # 1 頁が 20 件に満たないことを受け入れる
 *
 * 5.8 が明記している。**画面はそれを隠さず**（欠けている頁に断りを出す）、**検査は
 * 「20 件より少ない頁が正しい」ことを見る**（件数を揃える実装へ戻すと赤くなる）。
 *
 * # 経路表を通す
 *
 * `handleAppRequest` で叩く。**`src/app.ts` への登録漏れと、作品ページの前方一致に
 * 飲み込まれることの両方を捕まえる**（`/works/liked` は `/works/` の下にある）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-liked-works-0001';

beforeAll(async () => {
  await applySchema();
});

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/** 公開時刻の払い出し（`games` はテストファイルをまたいで共有される）。 */
let publishedAtSeq = 9_700_000_000;

/**
 * 次の公開時刻を返す。
 *
 * @returns UNIX 秒
 */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/**
 * 利用者を 1 人用意する。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName = 'いいねする人'): Promise<string> {
  const id = `liked-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 作品を 1 件用意する。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作品の id
 */
async function seedGame(
  authorId: string,
  overrides: {
    readonly status?: string;
    readonly title?: string;
    readonly reviewState?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', ?, 0, 0, 'ready', ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'いいねした作品の題',
      nextPublishedAt(),
      overrides.reviewState ?? null,
    )
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * @param userId 利用者
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/** いいねの時刻の払い出し（**押した順**が読めるように 1 秒ずつ進める）。 */
let likedAtSeq = 1_800_000_000;

/**
 * いいねを付ける（**窓口を通す**。5.8）。
 *
 * @param userId 押す人
 * @param gameId 作品
 */
async function like(userId: string, gameId: string): Promise<void> {
  likedAtSeq += 1;
  const outcome = await changeLike(env, 'like', userId, gameId, likedAtSeq);
  // **当たったことを先に確かめる。** 断られたあとで一覧を見ても、何も確かめていない。
  expect(outcome, `${gameId} に押せていない`).toBe('liked');
}

/**
 * 一覧を開く。
 *
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @param query クエリ文字列（`?` を含む）
 * @returns レスポンス
 */
async function openLiked(cookie?: string, query = ''): Promise<Response> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${LIKED_WORKS_PATH}${query}`, { headers }),
    testEnv(),
  );
}

describe('経路の登録（5.8 / 2.3.1）', () => {
  it('作品ページと同じ接頭辞の下にあり、前方一致に飲み込まれない', () => {
    // **綴りを式で持たない**（`src/liked-works-paths.ts` の規約。Lambda の束の事情）。
    // 関係はここで機械照合する。
    expect(LIKED_WORKS_PATH).toBe(`${WORK_PAGE_PREFIX}liked`);
    expect(LIKED_WORKS_PATH).not.toBe(MY_WORKS_PATH);
  });

  it('経路表に登録されていて、重複も綴り違いも無い', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
    const gets = routes
      .filter((route) => route.method === 'GET' && route.match !== 'prefix')
      .map((route) => route.path);
    expect(gets).toContain(LIKED_WORKS_PATH);
  });

  it('作品ページの前方一致より先に見られる（liked という id の作品にならない）', async () => {
    const userId = await seedUser();
    const response = await openLiked(await sessionCookie(userId));
    expect(response.status).toBe(200);
    // 作品ページの 404（「作品が見つかりません」）へ落ちていないこと。
    expect(await response.text()).toContain('いいねした作品');
  });

  it('頁の URL を組み立てられる（1 頁目はクエリを付けない）', () => {
    expect(likedWorksPath(1)).toBe(LIKED_WORKS_PATH);
    expect(likedWorksPath(3)).toBe(`${LIKED_WORKS_PATH}?${LIKED_PAGE_PARAM}=3`);
  });

  it('?page= は落とすのであって、失敗させない', () => {
    for (const value of [null, '', 'abc', '0', '-1', '1.5']) {
      expect(toLikedPageNumber(value), String(value)).toBe(1);
    }
    expect(toLikedPageNumber('3')).toBe(3);
    // **`OFFSET` は読み飛ばした行を数える。** 手で書き換えた URL で上限を超えない。
    expect(toLikedPageNumber('999999')).toBe(MAX_LIKED_PAGE);
  });
});

describe('本人だけが見られる（5.8「誰が押したかは公開しない」）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openLiked();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('未ログインの応答に作品の id が 1 つも載らない', async () => {
    const userId = await seedUser();
    const game = await seedGame(await seedUser());
    await like(userId, game);

    const response = await openLiked();
    expect(await response.text()).not.toContain(game);
  });

  it('他人のいいねが 1 件も出ない', async () => {
    const me = await seedUser('わたし');
    const other = await seedUser('ほかの人');
    const author = await seedUser('作者');
    const mine = await seedGame(author, { title: 'わたしが押した作品' });
    const theirs = await seedGame(author, { title: 'ほかの人が押した作品' });

    await like(me, mine);
    await like(other, theirs);

    const body = await (await openLiked(await sessionCookie(me))).text();
    expect(body).toContain(workPagePath(mine));
    expect(body, '他人のいいねが出ている').not.toContain(workPagePath(theirs));
    expect(body).not.toContain('ほかの人が押した作品');

    // 逆向きも見る（**片方だけで緑になる形を置かない**）。
    const theirBody = await (await openLiked(await sessionCookie(other))).text();
    expect(theirBody).toContain(workPagePath(theirs));
    expect(theirBody).not.toContain(workPagePath(mine));
  });

  it('検索避けする（`noindex`。クローラに対しても本人だけの画面である）', async () => {
    const userId = await seedUser();
    const body = await (await openLiked(await sessionCookie(userId))).text();
    expect(body).toContain('noindex');
  });
});

describe('引く時点で絞る（#152 の規律 / 5.4 / 8.4）', () => {
  it('SQL が公開状態と審査の可視条件を where に持つ', () => {
    const sql = likedWorksSql(3);
    // **画面側で `filter` していない**ことを、SQL そのものから見る。
    expect(sql).toMatch(/where[\s\S]*g\.status = \?/u);
    expect(sql).toMatch(/g\.review_state is null or g\.review_state = 'cleared'/u);
    // `in (...)` の `?` の数が件数から作られている（id は束縛パラメータである）。
    expect(likedWorksSql(1)).toContain('g.id in (?)');
    expect(sql).toContain('g.id in (?, ?, ?)');
    // **`users` からは表示名 1 列だけ**（`email` と `invited_by` は公開しない。2.3.6）。
    expect(sql).toContain('u.display_name as author_name');
    expect(sql).not.toContain('u.email');
    expect(sql).not.toContain('invited_by');
  });

  it('公開をやめた作品が出ない（いいねは残っている）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const kept = await seedGame(author, { title: '公開されたまま' });
    const withdrawn = await seedGame(author, { title: 'あとで取り下げた' });

    await like(me, kept);
    await like(me, withdrawn);

    // 取り下げる前は 2 件出る（**この検査が空振りしていない**ことを先に見る）。
    const before = await (await openLiked(await sessionCookie(me))).text();
    expect(before).toContain(workPagePath(kept));
    expect(before).toContain(workPagePath(withdrawn));

    const removed = await env.DB.prepare('update games set status = ? where id = ?')
      .bind(REMOVED_STATUS, withdrawn)
      .run();
    expect(removed.meta.changes).toBe(1);

    const body = await (await openLiked(await sessionCookie(me))).text();
    expect(body).toContain(workPagePath(kept));
    expect(body, '公開をやめた作品が出ている').not.toContain(workPagePath(withdrawn));
    expect(body).not.toContain('あとで取り下げた');
  });

  it('審査で新規露出を止めた作品が出ない（「問題なし」にすれば戻る）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const game = await seedGame(author, { title: '審査に入った作品' });
    await like(me, game);
    expect((await (await openLiked(await sessionCookie(me))).text())).toContain(
      workPagePath(game),
    );

    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, game)
      .run();
    expect(await (await openLiked(await sessionCookie(me))).text()).not.toContain(
      workPagePath(game),
    );

    // 8.4 の審査が「問題なし」とすれば、また出る（行を消していない）。
    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_CLEARED, game)
      .run();
    expect(await (await openLiked(await sessionCookie(me))).text()).toContain(
      workPagePath(game),
    );
  });

  it('draft の作品が出ない（押せないので通常は起きないが、絞りが効いていることを見る）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const published = await seedGame(author);
    const draft = await seedGame(author, { title: 'したがき' });
    await like(me, published);
    // **`draft` には押せない**（窓口が 404 にする）。押せた状態を作るために、公開済みで
    // 押してから `draft` へ戻す——移行や運用で起きうる形である。
    await like(me, draft);
    await env.DB.prepare('update games set status = ? where id = ?').bind(DRAFT_STATUS, draft).run();

    const body = await (await openLiked(await sessionCookie(me))).text();
    expect(body).toContain(workPagePath(published));
    expect(body).not.toContain(workPagePath(draft));
    expect(body).not.toContain('したがき');
  });

  it('行が消えた作品でも画面が落ちない（引けなかった id は落ちる）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const alive = await seedGame(author);
    const doomed = await seedGame(author);
    await like(me, alive);
    await like(me, doomed);
    await env.DB.prepare('delete from games where id = ?').bind(doomed).run();

    const response = await openLiked(await sessionCookie(me));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(workPagePath(alive));
    expect(body).not.toContain(doomed);
  });
});

describe('押した新しい順（5.8）', () => {
  it('あとで押した作品が先に並ぶ', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const first = await seedGame(author, { title: 'さいしょに押した' });
    const second = await seedGame(author, { title: 'つぎに押した' });
    const third = await seedGame(author, { title: 'さいごに押した' });

    await like(me, first);
    await like(me, second);
    await like(me, third);

    const body = await (await openLiked(await sessionCookie(me))).text();
    const order = [third, second, first].map((id) => body.indexOf(workPagePath(id)));
    expect(order.every((index) => index >= 0), 'すべて並んでいない').toBe(true);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);

    // **公開日時の順ではない**ことを対で見る（`first` がいちばん古い公開である）。
    // 押した順が D1 の `published_at` の順と一致してしまうと、この検査は
    // 「D1 で並べ替えた」実装も通す。押す順を公開の逆にして作り直す。
    const me2 = await seedUser();
    await like(me2, third);
    await like(me2, first);
    const body2 = await (await openLiked(await sessionCookie(me2))).text();
    expect(body2.indexOf(workPagePath(first))).toBeLessThan(
      body2.indexOf(workPagePath(third)),
    );
  });

  it('取り消した作品は一覧から消える', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const game = await seedGame(author);
    await like(me, game);
    expect(await (await openLiked(await sessionCookie(me))).text()).toContain(workPagePath(game));

    likedAtSeq += 1;
    expect(await changeLike(env, 'unlike', me, game, likedAtSeq)).toBe('unliked');
    expect(await (await openLiked(await sessionCookie(me))).text()).not.toContain(
      workPagePath(game),
    );
  });
});

describe('20 件ずつ（5.8）', () => {
  it('21 件目は「次の 20 件」で取れ、そこに前へ戻る導線がある', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const ids: string[] = [];
    for (let index = 0; index < LIKED_WORKS_PER_PAGE + 1; index += 1) {
      const id = await seedGame(author, { title: `作品 ${index}` });
      ids.push(id);
      await like(me, id);
    }
    const newestFirst = [...ids].reverse();
    const cookie = await sessionCookie(me);

    const first = await (await openLiked(cookie)).text();
    for (const id of newestFirst.slice(0, LIKED_WORKS_PER_PAGE)) {
      expect(first, id).toContain(workPagePath(id));
    }
    // 21 件目（いちばん古い＝最初に押した）は 1 頁目に出ない。
    expect(first).not.toContain(workPagePath(newestFirst[LIKED_WORKS_PER_PAGE]!));
    expect(first).toContain(likedWorksPath(2));
    expect(first).not.toContain(`>前の ${LIKED_WORKS_PER_PAGE} 件<`);

    const second = await (
      await openLiked(cookie, `?${LIKED_PAGE_PARAM}=2`)
    ).text();
    expect(second).toContain(workPagePath(newestFirst[LIKED_WORKS_PER_PAGE]!));
    expect(second).toContain(likedWorksPath(1));
    // 3 頁目は無い（押しても何も起きない導線を出さない。4.4）。
    expect(second).not.toContain(likedWorksPath(3));
  });

  it('ちょうど 20 件では「次へ」を出さない（空の頁へ送らない）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    for (let index = 0; index < LIKED_WORKS_PER_PAGE; index += 1) {
      await like(me, await seedGame(author));
    }
    const body = await (await openLiked(await sessionCookie(me))).text();
    expect(body).not.toContain(likedWorksPath(2));
  });

  it('絞った結果 1 頁が 20 件未満になることを受け入れ、断りを出す', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const hidden: string[] = [];
    const shown: string[] = [];
    // **1 頁目が欠ける形を作る。** 21 件押して、そのうち 1 頁目に載る 5 件を取り下げる。
    const ids: string[] = [];
    for (let index = 0; index < LIKED_WORKS_PER_PAGE + 1; index += 1) {
      const id = await seedGame(author, { title: `頁の作品 ${index}` });
      ids.push(id);
      await like(me, id);
    }
    const newestFirst = [...ids].reverse();
    for (const [index, id] of newestFirst.slice(0, LIKED_WORKS_PER_PAGE).entries()) {
      if (index < 5) {
        hidden.push(id);
        await env.DB.prepare('update games set status = ? where id = ?')
          .bind(REMOVED_STATUS, id)
          .run();
      } else {
        shown.push(id);
      }
    }

    const body = await (await openLiked(await sessionCookie(me))).text();

    // **20 件未満で正しい。** 件数を揃えるために DO を引き直す実装へ戻すと赤くなる。
    const listed = [...body.matchAll(/class="gf-card-link" href="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(listed).toHaveLength(LIKED_WORKS_PER_PAGE - 5);
    for (const id of shown) {
      expect(listed, id).toContain(workPagePath(id));
    }
    for (const id of hidden) {
      expect(listed, id).not.toContain(workPagePath(id));
    }
    // **隠さない**（5.8 の「1 ページが 20 件に満たないことがある」を画面が言う）。
    expect(body).toContain(HIDDEN_NOTICE);
    // 次の頁はまだある（絞りで落ちた分を「次が無い」と読んでいない）。
    expect(body).toContain(likedWorksPath(2));
  });
});

describe('空のとき（4.4 / 押せない導線を出さない）', () => {
  it('1 件も押していなければ、探す導線を出す', async () => {
    const userId = await seedUser();
    const body = await (await openLiked(await sessionCookie(userId))).text();
    expect(body).toContain('まだいいねした作品がありません');
    expect(body).toContain('公開されている作品をさがす');
    // 頁送りは出さない（前も次も無い）。
    expect(body).not.toContain('class="gf-pager"');
    // **押していないことと、押したものが隠れていることは別である。**
    expect(body).not.toContain(HIDDEN_NOTICE);
  });

  it('2 頁目以降が空のときは、言うことを変える', () => {
    // 経路を通さず `renderLikedWorksPage` に直に渡す（範囲の外の頁を手で開いた形）。
    const first = renderLikedWorksPage({
      works: [],
      page: 1,
      hasNext: false,
      unavailable: false,
      likedOnPage: 0,
    });
    const later = renderLikedWorksPage({
      works: [],
      page: 3,
      hasNext: false,
      unavailable: false,
      likedOnPage: 0,
    });
    expect(first).toContain('まだいいねした作品がありません');
    expect(later).toContain('この頁に並ぶ作品がありません');
    expect(later).not.toContain('まだいいねした作品がありません');
    // 2 頁目以降には前へ戻る導線がある（戻る道が URL の手編集だけにならない）。
    expect(later).toContain(likedWorksPath(2));
  });
});

describe('「あなたの作品」からの導線（2.3.7 / 5.8）', () => {
  it('この一覧から「あなたの作品」へ戻れる（ヘッダには置かない）', async () => {
    const userId = await seedUser();
    const body = await (await openLiked(await sessionCookie(userId))).text();
    expect(body).toContain(`href="${MY_WORKS_PATH}"`);
    // **ヘッダに置かない**（2.3.7。本人だけの画面が 2 枚並ぶので項目を増やさない）。
    // ヘッダは `siteHead` が出す 1 行だけである。
    const header = /<header class="gf-header">[\s\S]*?<\/header>/u.exec(body);
    expect(header, 'ヘッダが無い').not.toBeNull();
    expect(header![0]).not.toContain(LIKED_WORKS_PATH);
  });
});

describe('DO へ届かなくても画面ごと落とさない（5.8「止まるのはいいねだけ」/ #340）', () => {
  /**
   * DO のバインディングが必ず投げる env を作る。
   *
   * **`game-forge-likes` が配られていない・DO の枠が尽きた状態を再現する。** ローカルの
   * 開発では実際にこの状態になる（`wrangler pages dev` だけでは likes Worker が居ないので、
   * `scripts/check-page-width.sh` がこれを 500 として捕まえた）。
   *
   * @returns 差し替えた env
   */
  function brokenHubEnv(): Env {
    return {
      ...env,
      SESSION_SECRET: SECRET,
      LIKE_HUB: new Proxy(
        {},
        {
          get() {
            throw new Error('Durable Object namespace is not available');
          },
        },
      ),
    } as unknown as Env;
  }

  /**
   * 壊れた DO で一覧を開く。
   *
   * @param cookie `Cookie` ヘッダ
   * @returns レスポンス
   */
  async function openBroken(cookie: string): Promise<Response> {
    return await handleAppRequest(
      new Request(`${APP_ORIGIN}${LIKED_WORKS_PATH}`, {
        headers: { accept: 'text/html', cookie },
      }),
      brokenHubEnv(),
    );
  }

  it('500 にせず、読めなかったことを言う（「まだいいねがありません」と嘘をつかない）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    await like(me, await seedGame(author));
    const cookie = await sessionCookie(me);

    // 壊す前は並ぶ（**この検査が空振りしていない**ことを先に見る）。
    expect((await openLiked(cookie)).status).toBe(200);

    const response = await openBroken(cookie);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(UNAVAILABLE_MESSAGE);
    // **「まだいいねした作品がありません」と言わない**（押していないことと、読めない
    // ことは別である。`src/home.ts` の「出来ていないものを出来ているように書かない」）。
    expect(body).not.toContain('まだいいねした作品がありません');
    // 頁送りも出さない（次があるかどうかも分かっていない。4.4）。
    expect(body).not.toContain('class="gf-pager"');
    expect(body).not.toContain(HIDDEN_NOTICE);
    // **外枠は保たれる**（M8-1 の 3 検査が見ているもの）。
    expect(body).toContain('/assets/app.css');
  });

  it('未ログインの判定は DO より先である（壊れていてもログインへ送る）', async () => {
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${LIKED_WORKS_PATH}`, { headers: { accept: 'text/html' } }),
      brokenHubEnv(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('作品ページも 500 にならない（拡散の着地点を、いいねの障害で止めない）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const game = await seedGame(author);
    await env.DB.prepare('update games set like_count = 4 where id = ?').bind(game).run();

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${workPagePath(game)}`, {
        headers: { accept: 'text/html', cookie: await sessionCookie(me) },
      }),
      brokenHubEnv(),
    );

    expect(response.status, 'DO が落ちると作品ページが 500 になる').toBe(200);
    const body = await response.text();
    // **D1 の写しへ倒れる**（5 分遅れるが、数としては正しい）。
    expect(body).toContain('いいね 4');
    // **ボタンは出さない**（押しても届かない。4.4）。
    expect(body).not.toMatch(/<form[^<>]*action="\/api\/like/u);
  });
});

describe('空に見える 3 つの状態を書き分ける（PR #348 のレビュー指摘）', () => {
  /**
   * 描画だけを試すための最小の view。
   *
   * **`LikedWorksView` そのものを組み立てる**（型が変わったら落ちるので写しにならない）。
   *
   * @param overrides 差し替える値
   * @returns view
   */
  function view(overrides: Partial<LikedWorksView> = {}): LikedWorksView {
    return {
      works: [],
      page: 1,
      hasNext: false,
      unavailable: false,
      likedOnPage: 0,
      ...overrides,
    };
  }

  it('1 件も押していない頁と、全部落ちた頁を書き分ける', () => {
    // **押していない**（DO が 0 件返した）。
    const none = renderLikedWorksPage(view());
    expect(none).toContain('まだいいねした作品がありません');
    expect(none).not.toContain(ALL_HIDDEN_MESSAGE);

    // **押したものはあるが、D1 で全部落ちた。** 「まだありません」と言うと嘘になる。
    const allHidden = renderLikedWorksPage(view({ likedOnPage: 3 }));
    expect(allHidden).toContain(ALL_HIDDEN_MESSAGE);
    expect(allHidden, '押した本人に「まだありません」と言っている').not.toContain(
      'まだいいねした作品がありません',
    );
    // 本文がすでに同じことを言っているので、断りを 2 度出さない。
    expect(allHidden).not.toContain(HIDDEN_NOTICE);
  });

  it('読めなかった頁は、そのどちらとも違う', () => {
    const broken = renderLikedWorksPage(view({ unavailable: true }));
    expect(broken).toContain(UNAVAILABLE_MESSAGE);
    expect(broken).not.toContain('まだいいねした作品がありません');
    expect(broken).not.toContain(ALL_HIDDEN_MESSAGE);
  });

  it('読めなかった頁では、行が載っていてもカードを描かない（含意に寄りかからない）', () => {
    // `listLikedWorks` は `unavailable` のとき必ず空の `works` を返すので、**経路からは
    // この組み合わせが来ない。** それでも描画側で止める——**`unavailable` と `works` が
    // 別の項目である以上、片方だけを変えた日に食い違いうる。**
    const work: PublicWork = {
      id: '00000000-0000-4000-8000-000000000009',
      title: '載ってしまった作品',
      authorName: '作者',
      publishedAt: 1_800_000_000,
      forkCount: 0,
      likeCount: 0,
      hasParent: false,
      hasShot: false,
    };
    const broken = renderLikedWorksPage(view({ unavailable: true, works: [work] }));
    expect(broken).toContain(UNAVAILABLE_MESSAGE);
    expect(broken, '読めなかったのにカードを描いている').not.toContain('載ってしまった作品');
    // 同じ view で `unavailable` だけを倒すと描く（この検査が空振りしていない）。
    expect(renderLikedWorksPage(view({ unavailable: false, works: [work], likedOnPage: 1 }))).toContain(
      '載ってしまった作品',
    );
  });

  it('断りは DO が返した件数との差で決まる（`hasNext` からは導かない）', () => {
    const work: PublicWork = {
      id: '00000000-0000-4000-8000-000000000001',
      title: '並んだ作品',
      authorName: '作者',
      publishedAt: 1_800_000_000,
      forkCount: 0,
      likeCount: 0,
      hasParent: false,
      hasShot: false,
    };

    // **最終頁（`hasNext` が false）でも、落ちていれば出す。** これが指摘そのものである
    // ——以前は `hasNext && works.length < 20` で判定しており、ここが緑のまま抜けていた。
    expect(
      renderLikedWorksPage(view({ works: [work], hasNext: false, likedOnPage: 2 })),
    ).toContain(HIDDEN_NOTICE);

    // **自然に短い最終頁では出さない**（DO が 1 件返して 1 件並んだ）。
    expect(
      renderLikedWorksPage(view({ works: [work], hasNext: false, likedOnPage: 1 })),
    ).not.toContain(HIDDEN_NOTICE);

    // 次の頁がある側でも、差が無ければ出さない。
    expect(
      renderLikedWorksPage(view({ works: [work], hasNext: true, likedOnPage: 1 })),
    ).not.toContain(HIDDEN_NOTICE);
  });

  it('文言が審査の状態を漏らさない（`status` は published のままである）', () => {
    // **「公開されていない」と書かない。** 審査で新規露出を止めた作品は
    // `status = 'published'` のままで URL も生きており、本人が開けば遊べる。
    // 「公開されているのに一覧に出ない」＝審査中、と読めてしまう形にもしない。
    for (const message of [HIDDEN_NOTICE, ALL_HIDDEN_MESSAGE]) {
      expect(message).not.toContain('公開されていない');
      expect(message).not.toContain('公開をやめ');
      expect(message).not.toContain('審査');
      expect(message).not.toContain('通報');
      expect(message).not.toContain('削除');
    }
  });

  it('最終頁でちょうど 20 件返り 1 件落ちても、断りが出る（経路を通す）', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const ids: string[] = [];
    // **ちょうど 20 件**押す（`hasNext` が false になる）。
    for (let index = 0; index < LIKED_WORKS_PER_PAGE; index += 1) {
      const id = await seedGame(author, { title: `最終頁の作品 ${index}` });
      ids.push(id);
      await like(me, id);
    }
    const cookie = await sessionCookie(me);

    // 落とす前: 20 件並び、断りも「次へ」も出ない。
    const full = await (await openLiked(cookie)).text();
    expect(full).not.toContain(HIDDEN_NOTICE);
    expect(full).not.toContain(likedWorksPath(2));

    await env.DB.prepare('update games set status = ? where id = ?')
      .bind(REMOVED_STATUS, ids[0]!)
      .run();

    const body = await (await openLiked(cookie)).text();
    const listed = [...body.matchAll(/class="gf-card-link" href="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(listed).toHaveLength(LIKED_WORKS_PER_PAGE - 1);
    // **ここが以前は抜けていた**（`hasNext` が false なので断りが出なかった）。
    expect(body).toContain(HIDDEN_NOTICE);
    expect(body).not.toContain(likedWorksPath(2));
  });

  it('全件落ちた頁は、経路を通しても「まだありません」と言わない', async () => {
    const me = await seedUser();
    const author = await seedUser();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = await seedGame(author, { title: `全部落ちる ${index}` });
      ids.push(id);
      await like(me, id);
    }
    const cookie = await sessionCookie(me);
    expect(await (await openLiked(cookie)).text()).toContain(workPagePath(ids[0]!));

    for (const id of ids) {
      await env.DB.prepare('update games set status = ? where id = ?')
        .bind(REMOVED_STATUS, id)
        .run();
    }

    const body = await (await openLiked(cookie)).text();
    expect(body).toContain(ALL_HIDDEN_MESSAGE);
    expect(body, '押した本人に「まだありません」と言っている').not.toContain(
      'まだいいねした作品がありません',
    );
  });
});

describe('いいねした作品のカードも作者ページへ辿れる（#330 / PR #350）', () => {
  it('`likedWorksSql` が `author_id` を選び、画面でリンクになる', async () => {
    // **この一覧だけが `src/games.ts` の `listPublishedGames` を通らない**（DO が返した
    // id を D1 で引き直す 2 段である）。選び忘れると、**この一覧だけ作者名がリンクに
    // ならない。** 画面は正しく出るので、綴りと画面の両方で見る（PR #350 の Copilot の指摘）。
    const author = await seedUser('リンクになる作者');
    const me = await seedUser('押す人');
    const game = await seedGame(author);
    await like(me, game);

    const body = await (await openLiked(await sessionCookie(me))).text();
    expect(body).toContain(workPagePath(game));
    expect(body).toContain(`<a class="gf-card-author" href="${authorPagePath(author)}">`);
    expect(body).toContain('>リンクになる作者</a>');
    // 綴りの側も見る（選ばなくなったら赤くなる）。
    expect(likedWorksSql(1)).toContain('g.author_id');
  });
});
