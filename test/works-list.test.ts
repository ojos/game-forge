import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import {
  DRAFT_STATUS,
  PUBLIC_WORK_SORTS,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  TAGGED_WORK_SORTS,
  publishedGamesSql,
  taggedGamesSql,
  toTaggedWorkSort,
} from '../src/games.js';
import { cachedRows, listCacheKey, purgeListCache } from '../src/list-cache.js';
import { MY_WORKS_PATH } from '../src/my-works.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { WORK_PAGE_PREFIX, workPagePath } from '../src/work-page.js';
import {
  MAX_PAGE,
  MOVED_NOTICE,
  PUBLIC_WORKS_PATH,
  SEARCH_REJECTION_MESSAGES,
  SEARCH_SORT_NOTICE,
  TAG_FILTER_NOTICE,
  WORKS_PER_PAGE,
  renderWorksListPage,
  toPageNumber,
  toWorkTagFilter,
  worksListPath,
  worksSearchCacheKey,
} from '../src/works-list.js';
import { WORK_SEARCH_FIELD, parseWorkSearch } from '../src/work-search.js';
import { WORK_TAGS, WORK_TAG_FIELD } from '../src/work-tags.js';
import { siteViewerAt } from '../src/html.js';
import { applySchema } from './helpers/schema.js';

/**
 * 公開作品の一覧（#328 / M9-2 / 仕様 2.3）。
 *
 * **#328 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. `draft` の作品が一覧に出ない
 * 2. 21 件目がページングで取得できる
 * 3. 並べ替え 3 軸それぞれ（`liked` は #339）
 * 4. **索引が効いていること**（`EXPLAIN QUERY PLAN` が全表走査でない）
 * 5. `/works/mine` が未ログインでログインへ送られる（`test/my-works.test.ts` が持つ）
 *
 * **キャッシュを毎回捨ててから開く。** `caches.default` はテスト間で共有されるので、
 * 捨てないと前のテストが仕込んだ行を読む。**本番と同じ実装へ口を開けている**
 * （`src/list-cache.ts` の `purgeListCache`）ので、確かめたものと動くものが別になる
 * 形にはなっていない。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

beforeAll(async () => {
  await applySchema();
});

/**
 * 作者を 1 人用意する。
 *
 * id を毎回ランダムにするのは、`games` が他のテストファイルとも共有されるためである。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName: string): Promise<string> {
  const id = `list-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 公開時刻を 1 つ払い出す。
 *
 * **必ず「いままでで最も新しい」値を返す。** `games` はテストファイルをまたいで
 * 共有されるうえ、このファイル自身も 21 件を仕込む。固定値で仕込むと、**先に走った
 * テストが 1 頁目を埋めた瞬間に、あとのテストが自分の行を見失う**（順序に依存した
 * テストになる）。払い出しにすれば、仕込んだ行は常に 1 頁目の先頭側へ来る。
 *
 * 起点を遠い未来に置くのは、他のテストファイルが入れた行と競らないためである。
 */
let publishedAtSeq = 9_000_000_000;

/**
 * 次の公開時刻を返す。
 *
 * @returns UNIX 秒（呼ぶたびに 1 秒ずつ新しくなる）
 */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/**
 * `games` の行を 1 件入れる。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作った作品の id
 */
async function seedGame(
  authorId: string,
  overrides: {
    readonly status?: string;
    readonly title?: string;
    readonly publishedAt?: number | null;
    readonly forkCount?: number;
    readonly likeCount?: number;
    /** プレイ数（`games.play_count`。#377）。 */
    readonly playCount?: number;
    readonly ogpState?: string | null;
    readonly reviewState?: string | null;
    readonly parentId?: string | null;
    /** タグの枠（`[tag1, tag2, tag3]`。省略するとタグ無し。#376）。 */
    readonly tags?: readonly (string | null)[];
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, play_count, ogp_state, review_state, parent_id,
        tag1, tag2, tag3)
     values (?, ?, ?, ?, '', 1, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.publishedAt === undefined ? nextPublishedAt() : overrides.publishedAt,
      overrides.forkCount ?? 0,
      overrides.likeCount ?? 0,
      overrides.playCount ?? 0,
      overrides.ogpState === undefined ? 'ready' : overrides.ogpState,
      overrides.reviewState ?? null,
      overrides.parentId ?? null,
      overrides.tags?.[0] ?? null,
      overrides.tags?.[1] ?? null,
      overrides.tags?.[2] ?? null,
    )
    .run();
  return id;
}

/**
 * 一覧を開く。
 *
 * **経路表を通す。** ハンドラを直接呼ぶと、`src/app.ts` への登録漏れを見逃す。
 *
 * @param query クエリ文字列（`?` を含む。省略可）
 * @returns レスポンス
 */
async function openList(query = ''): Promise<Response> {
  const url = new URL(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}${query}`);
  const page = toPageNumber(url.searchParams.get('page'));
  // **絞り込むときは、経路と同じ鍵を捨てる**（#376。鍵にタグが入り、軸は 2 つへ落ちる）。
  const tag = toWorkTagFilter(url.searchParams.get(WORK_TAG_FIELD));
  // **検索するときも、経路と同じ鍵を捨てる**（#378。鍵に整えた検索語が入る）。
  const search = parseWorkSearch(url.searchParams.get(WORK_SEARCH_FIELD));
  if (search.kind === 'accepted') {
    await purgeListCache(worksSearchCacheKey(search.key, page, tag));
  } else if (tag === null) {
    const sort = url.searchParams.get('sort') ?? 'recent';
    await purgeListCache(listCacheKey('works', { sort, page }));
  } else {
    const sort = toTaggedWorkSort(url.searchParams.get('sort'));
    await purgeListCache(listCacheKey('works', { sort, page, [WORK_TAG_FIELD]: tag }));
  }
  return await handleAppRequest(new Request(url, { headers: { accept: 'text/html' } }), env);
}

describe('経路の登録（#328）', () => {
  it('公開一覧が作品ページの親の位置にある', () => {
    // **`/games` を新設しない**（仕様 2.3.2。同じものに綴りを 2 つ作らない）。
    // 末尾を削れば一覧に着くという #152 の性質を、公開側が引き継いだ。
    expect(WORK_PAGE_PREFIX).toBe(`${PUBLIC_WORKS_PATH}/`);
  });

  it('公開一覧・自分の作品・作品ページが別の経路になっている', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
    expect(PUBLIC_WORKS_PATH).not.toBe(MY_WORKS_PATH);
    // **完全一致は前方一致より先に見られる**（`src/routes.ts`）。`/works/mine` が
    // 作品ページの前方一致へ飲み込まれないことが、この移設の前提になっている。
    expect(MY_WORKS_PATH.startsWith(WORK_PAGE_PREFIX)).toBe(true);
  });
});

describe('引く時点で絞る（5.4 / 8.4）', () => {
  it('draft の作品が一覧に出ない', async () => {
    const author = await seedUser('下書きの作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS, title: 'したがき' });
    const published = await seedGame(author, { title: 'こうかい' });

    const body = await (await openList()).text();
    expect(body).toContain(workPagePath(published));
    expect(body).not.toContain(workPagePath(draft));
  });

  it('removed の作品が一覧に出ない', async () => {
    const author = await seedUser('削除の作者');
    const removed = await seedGame(author, { status: REMOVED_STATUS });

    expect(await (await openList()).text()).not.toContain(workPagePath(removed));
  });

  it('審査待ちの作品が一覧に出ない', async () => {
    // 系統の一覧（`listPublishedForks`）と**同じ断片を借りている**ことの検査でもある。
    // 画面ごとに条件を書き分けると、足した画面だけが素通しになる（8.4 / #40）。
    const author = await seedUser('通報された作者');
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED });

    expect(await (await openList()).text()).not.toContain(workPagePath(queued));
  });

  it('作者のメールアドレスと招待者が本文に出ない', async () => {
    // 仕様 2.3.6。**引く側が `display_name` しか選んでいない**ので、カードが誤って
    // 出す経路が無いことを、画面まで通して固定する。
    const inviter = await seedUser('招待した人');
    const author = await seedUser('招待された人');
    await env.DB.prepare('update users set invited_by = ? where id = ?').bind(inviter, author).run();
    await seedGame(author);

    const body = await (await openList()).text();
    expect(body).toContain('招待された人');
    expect(body).not.toContain(`${author}@example.com`);
    expect(body).not.toContain(inviter);
  });
});

describe('並べ替えと頁送り（仕様 2.3.3 / 2.3.4）', () => {
  it('新着順と改造された数の順で、先頭に来る作品が入れ替わる', async () => {
    const author = await seedUser('並べ替えの作者');
    // **2 件とも 1 頁目に来る新しさで仕込む**（`nextPublishedAt` の払い出し順で、
    // あとに入れた `newest` のほうが新しい）。頁の外へ落ちると比較そのものが成り立たない。
    const mostForked = await seedGame(author, { forkCount: 99 });
    const newest = await seedGame(author, { forkCount: 0 });

    const recent = await (await openList('?sort=recent')).text();
    const forked = await (await openList('?sort=forked')).text();

    expect(recent.indexOf(workPagePath(newest))).toBeLessThan(
      recent.indexOf(workPagePath(mostForked)),
    );
    expect(forked.indexOf(workPagePath(mostForked))).toBeLessThan(
      forked.indexOf(workPagePath(newest)),
    );
  });

  it('いいねの数の順で、いいねの多い作品が先頭に来る（#339）', async () => {
    // 値は `games.like_count`（DO から写した数）を読む。一覧は DO を呼ばない（5.8）。
    const author = await seedUser('いいねの作者');
    const mostLiked = await seedGame(author, { likeCount: 99 });
    const newest = await seedGame(author, { likeCount: 0 });

    const recent = await (await openList('?sort=recent')).text();
    const liked = await (await openList('?sort=liked')).text();

    expect(recent.indexOf(workPagePath(newest))).toBeLessThan(
      recent.indexOf(workPagePath(mostLiked)),
    );
    expect(liked.indexOf(workPagePath(mostLiked))).toBeLessThan(
      liked.indexOf(workPagePath(newest)),
    );
  });

  it('いいねの数の順でも、draft と審査待ちは出ない（#339）', async () => {
    // **部分索引の条件と、一覧の SQL の条件が両方効いていること。** 索引が条件を
    // 持っていても、SQL の側が落とせば素通しになる（逆も同じ）。
    const author = await seedUser('いいねの絞り込みの作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS, likeCount: 10_000 });
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED, likeCount: 10_000 });

    const body = await (await openList('?sort=liked')).text();
    expect(body).not.toContain(workPagePath(draft));
    expect(body).not.toContain(workPagePath(queued));
  });

  it('プレイ数の順で、よく遊ばれた作品が先頭に来て、カードに数が出る（#377）', async () => {
    // 値は `games.play_count`（DO から写した数）を読む。一覧は DO を呼ばない。
    const author = await seedUser('プレイ数の作者');
    const mostPlayed = await seedGame(author, { playCount: 98_765 });
    const newest = await seedGame(author, { playCount: 0 });

    const recent = await (await openList('?sort=recent')).text();
    const played = await (await openList('?sort=played')).text();

    expect(recent.indexOf(workPagePath(newest))).toBeLessThan(
      recent.indexOf(workPagePath(mostPlayed)),
    );
    expect(played.indexOf(workPagePath(mostPlayed))).toBeLessThan(
      played.indexOf(workPagePath(newest)),
    );
    expect(played).toContain('<span class="gf-card-plays">プレイ 98765</span>');
    // 並べ替えの札に「プレイ数」が並び、いま選んでいる軸はリンクにしない。
    const sortNav = played.slice(played.indexOf('<nav class="gf-sort"'));
    expect(sortNav.slice(0, sortNav.indexOf('</nav>'))).toContain(
      '<li><span aria-current="page">プレイ数</span></li>',
    );
    expect(recent).toContain(`<li><a href="${worksListPath('played', 1)}">プレイ数</a></li>`);
  });

  it('プレイ数の順でも、draft と審査待ちは出ない（#377）', async () => {
    const author = await seedUser('プレイ数の絞り込みの作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS, playCount: 10_000_000 });
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED, playCount: 10_000_000 });

    const body = await (await openList('?sort=played')).text();
    expect(body).not.toContain(workPagePath(draft));
    expect(body).not.toContain(workPagePath(queued));
  });

  it('21 件目が次の頁で取得できる', async () => {
    const author = await seedUser('頁送りの作者');
    const ids: string[] = [];
    for (let count = 0; count < WORKS_PER_PAGE + 1; count += 1) {
      // 新しいほど先に出る。**最後に入れたものが 1 頁目の先頭**になる。
      ids.push(await seedGame(author));
    }
    const oldest = ids[0]!;

    const first = await (await openList('?sort=recent&page=1')).text();
    const second = await (await openList('?sort=recent&page=2')).text();

    expect(first).not.toContain(workPagePath(oldest));
    expect(first).toContain('次の');
    expect(second).toContain(workPagePath(oldest));
  });

  it('壊れたクエリは既定へ落ちる（400 にしない）', async () => {
    expect(toPageNumber(null)).toBe(1);
    expect(toPageNumber('0')).toBe(1);
    expect(toPageNumber('-3')).toBe(1);
    expect(toPageNumber('ぜろ')).toBe(1);
    // **頁の上限は読み取りの上限そのものである**（`OFFSET` は読み飛ばした行を数える）。
    expect(toPageNumber('999999')).toBe(MAX_PAGE);

    const response = await openList('?sort=いいね&page=なな');
    expect(response.status).toBe(200);
  });
});

describe('索引が効いている（仕様 2.3.3 の条件 2）', () => {
  it('4 軸とも全表走査ではなく、軸ごとの索引を使う', async () => {
    // **検査が SQL を書き写さない。** `publishedGamesSql` が返す文字列をそのまま
    // 実行計画に掛ける（`.ai-playbook/shared-ai-rules.md` 12 章）。
    //
    // `liked` は 0020 の**部分索引**である（審査の可視条件を含む。2.3.3 の v1.51 注記）。
    // SQLite は、問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使う。
    // **`status` は束縛で渡している**ので、束縛した値で照合されることまでここで確かめる
    // （本番と同じ `bind` で掛けている）。
    for (const [sort, index] of [
      ['recent', 'games_status_published_at_idx'],
      ['forked', 'games_status_fork_count_idx'],
      ['liked', 'games_status_like_count_idx'],
      // `played` は `games_play_count` の部分索引（#377。`liked` と同じ形・同じ条件の綴り）。
      ['played', 'games_status_play_count_idx'],
    ] as const) {
      const plan = await env.DB.prepare(`explain query plan ${publishedGamesSql(sort)}`)
        .bind(PUBLISHED_STATUS, WORKS_PER_PAGE, 0)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' | ');

      expect(detail, `${sort} の実行計画: ${detail}`).toContain(index);
      // **並べ替えのための一時 B-tree が出たら、索引の列順が並びと合っていない。**
      expect(detail, `${sort} の実行計画: ${detail}`).not.toContain('USE TEMP B-TREE');
      // **索引を使わない `SCAN g` が出たら全表走査である**（`SCAN g USING INDEX ...` は
      // 索引の上を順に読む正しい形なので除く）。
      expect(detail, `${sort} の実行計画: ${detail}`).not.toMatch(/SCAN g(?! USING)/u);
    }
  });

  it('並べ替えの軸と索引が 1 対 1 に揃っている（#339）', () => {
    // 軸を足したのに索引の検査へ足し忘れると、その軸だけが全表走査のまま通る。
    expect([...PUBLIC_WORK_SORTS].sort()).toEqual(['forked', 'liked', 'played', 'recent']);
  });

  it('タグで絞り込むと、2 軸とも枠ごとの部分索引を順に読んで併合する（#376）', async () => {
    // **本番と同じ `bind` で掛ける**（`status` と `tag` は束縛。部分索引の条件と照合される）。
    for (const [sort, axis] of [
      ['recent', 'published_at'],
      ['forked', 'fork_count'],
    ] as const) {
      const plan = await env.DB.prepare(`explain query plan ${taggedGamesSql(sort)}`)
        .bind('puzzle', PUBLISHED_STATUS, 'puzzle', PUBLISHED_STATUS, 'puzzle', PUBLISHED_STATUS, WORKS_PER_PAGE + 1, 0)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' | ');

      for (const slot of [1, 2, 3]) {
        expect(detail, `${sort} の実行計画: ${detail}`).toContain(`games_tag${slot}_${axis}_idx`);
      }
      // **枠ごとの結果を並べ替えずに併合している**（各枠が索引の順で読めている）。
      expect(detail, `${sort} の実行計画: ${detail}`).toContain('MERGE (UNION ALL)');
      expect(detail, `${sort} の実行計画: ${detail}`).not.toContain('USE TEMP B-TREE');
      expect(detail, `${sort} の実行計画: ${detail}`).not.toMatch(/SCAN g(?! USING)/u);
      // **`users` は主キーで引く**（結合を `UNION ALL` の外に置いた形。全表走査しない）。
      expect(detail, `${sort} の実行計画: ${detail}`).not.toMatch(/SCAN u(?! USING)/u);
    }
  });

  it('絞り込み中の軸は新着と改造された数だけで、どちらも絞り込まない軸に含まれる（#376）', () => {
    expect([...TAGGED_WORK_SORTS].sort()).toEqual(['forked', 'recent']);
    for (const sort of TAGGED_WORK_SORTS) {
      expect(PUBLIC_WORK_SORTS).toContain(sort);
    }
  });
});

describe('タグで絞り込む（#376 / 仕様 2.3.5）', () => {
  it('タグ無しの作品が、絞り込まない一覧に出る', async () => {
    const author = await seedUser('タグ無しの作者');
    const untagged = await seedGame(author);
    const tagged = await seedGame(author, { tags: ['puzzle'] });

    const body = await (await openList()).text();
    expect(body).toContain(workPagePath(untagged));
    expect(body).toContain(workPagePath(tagged));
  });

  it('?tag= で、どの枠に入っていても そのタグの作品だけが出る', async () => {
    const author = await seedUser('絞り込みの作者');
    const inSlot1 = await seedGame(author, { tags: ['puzzle'] });
    const inSlot2 = await seedGame(author, { tags: ['action', 'puzzle'] });
    const inSlot3 = await seedGame(author, { tags: ['action', 'board-card', 'puzzle'] });
    const otherTag = await seedGame(author, { tags: ['action'] });
    const untagged = await seedGame(author);

    const body = await (await openList('?tag=puzzle')).text();
    expect(body).toContain(workPagePath(inSlot1));
    expect(body).toContain(workPagePath(inSlot2));
    expect(body).toContain(workPagePath(inSlot3));
    expect(body).not.toContain(workPagePath(otherTag));
    expect(body).not.toContain(workPagePath(untagged));
    // **同じ作品が 2 度並ばない**（枠は重複しない。`UNION ALL` で束ねている）。
    expect(body.split(`href="${workPagePath(inSlot2)}"`).length - 1).toBe(1);
    // 絞り込んでいることを結果の側にも書く。
    expect(body).toContain('タグ「パズル」の作品');
  });

  it('絞り込んでも draft・removed・審査待ちは出ない', async () => {
    const author = await seedUser('絞り込みの可視条件の作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS, tags: ['puzzle'] });
    const removed = await seedGame(author, { status: REMOVED_STATUS, tags: ['puzzle'] });
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED, tags: ['puzzle'] });

    const body = await (await openList('?tag=puzzle')).text();
    expect(body).not.toContain(workPagePath(draft));
    expect(body).not.toContain(workPagePath(removed));
    expect(body).not.toContain(workPagePath(queued));
  });

  it('語彙に無い ?tag= は無視して、絞り込まない一覧を出す（400 にしない）', async () => {
    const author = await seedUser('未知のタグの作者');
    const untagged = await seedGame(author);

    for (const query of ['?tag=unknown', '?tag=', '?tag=Puzzle', `?tag=${encodeURIComponent('パズル')}`]) {
      const response = await openList(query);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(workPagePath(untagged));
      expect(body).toContain('<span class="gf-chip gf-chip-current" aria-current="page">すべて</span>');
    }
  });

  it('左カラムは <a href> だけで組み、絞り込むとタグの付いた作品だけが出ることを書く', async () => {
    const body = await (await openList('?tag=idle')).text();
    const nav = body.slice(body.indexOf('<nav class="gf-tag-filter gf-block"'));
    const filter = nav.slice(0, nav.indexOf('</nav>'));

    expect(filter).toContain(TAG_FILTER_NOTICE);
    expect(filter).toContain(`<a class="gf-chip" href="${worksListPath('recent', 1)}">すべて</a>`);
    for (const tag of WORK_TAGS) {
      if (tag.id === 'idle') {
        // **いま選んでいるものはリンクにしない。** 見た目は選んでいるチップ（#474）。
        expect(filter).toContain(`<span class="gf-chip gf-chip-current" aria-current="page">${tag.label}</span>`);
      } else {
        expect(filter).toContain(`<a class="gf-chip" href="${worksListPath('recent', 1, tag.id)}">${tag.label}</a>`);
      }
    }
    // **JavaScript もフォームも使わない**（9.3）。
    expect(filter).not.toContain('<script');
    expect(filter).not.toContain('<form');
    expect(filter).not.toContain('onclick');
  });

  it('絞り込み中は、いいね順のリンクを出さず、?sort=liked も未知の軸も新着にする', async () => {
    const author = await seedUser('絞り込みの並べ替えの作者');
    const mostLiked = await seedGame(author, { tags: ['shooting'], likeCount: 999 });
    const newest = await seedGame(author, { tags: ['shooting'] });

    for (const query of ['?tag=shooting&sort=liked', '?tag=shooting&sort=played', '?tag=shooting&sort=x']) {
      const body = await (await openList(query)).text();
      const sortNav = body.slice(body.indexOf('<nav class="gf-sort"'));
      const nav = sortNav.slice(0, sortNav.indexOf('</nav>'));
      expect(nav).not.toContain('いいねの数');
      // **プレイ数順も絞り込み中は出さない**（#377。#376 の決定で `TAGGED_WORK_SORTS` は変えない）。
      expect(nav).not.toContain('プレイ数');
      expect(nav).toContain('<li><span aria-current="page">新着</span></li>');
      expect(nav).toContain(`<li><a href="${worksListPath('forked', 1, 'shooting')}">改造された数</a></li>`);
      expect(body.indexOf(workPagePath(newest))).toBeLessThan(body.indexOf(workPagePath(mostLiked)));
    }
  });

  it('絞り込み中も改造された数で並べられる', async () => {
    const author = await seedUser('絞り込みの改造の作者');
    const mostForked = await seedGame(author, { tags: ['board-card'], forkCount: 9_999 });
    const newest = await seedGame(author, { tags: ['board-card'] });

    const recent = await (await openList('?tag=board-card&sort=recent')).text();
    const forked = await (await openList('?tag=board-card&sort=forked')).text();
    expect(recent.indexOf(workPagePath(newest))).toBeLessThan(recent.indexOf(workPagePath(mostForked)));
    expect(forked.indexOf(workPagePath(mostForked))).toBeLessThan(forked.indexOf(workPagePath(newest)));
  });

  it('頁送りでタグを保ち、21 件目が次の頁で取得できる', async () => {
    const author = await seedUser('絞り込みの頁送りの作者');
    const ids: string[] = [];
    for (let count = 0; count < WORKS_PER_PAGE + 1; count += 1) {
      ids.push(await seedGame(author, { tags: ['rhythm-sound'] }));
    }
    const oldest = ids[0]!;

    const first = await (await openList('?tag=rhythm-sound&sort=recent&page=1')).text();
    const second = await (await openList('?tag=rhythm-sound&sort=recent&page=2')).text();

    expect(first).not.toContain(workPagePath(oldest));
    expect(first).toContain(`href="${worksListPath('recent', 2, 'rhythm-sound')}"`);
    expect(second).toContain(workPagePath(oldest));
    expect(second).toContain(`href="${worksListPath('recent', 1, 'rhythm-sound')}"`);
  });

  it('「このタグの作品はまだない」と「公開作品が 0 本」を書き分ける', () => {
    const viewer = siteViewerAt(PUBLIC_WORKS_PATH, false, null);
    const filtered = renderWorksListPage(
      { works: [], sort: 'recent', page: 1, hasNext: false, tag: 'idle' },
      viewer,
    );
    const unfiltered = renderWorksListPage(
      { works: [], sort: 'recent', page: 1, hasNext: false, tag: null },
      viewer,
    );

    expect(filtered).toContain('このタグの作品はまだありません。');
    expect(filtered).not.toContain('まだ公開された作品がありません。');
    expect(filtered).toContain(
      `<a class="gf-button gf-button-secondary gf-button-sm" href="${worksListPath('recent', 1)}">すべての作品を見る</a>`,
    );
    expect(unfiltered).toContain('まだ公開された作品がありません。');
    expect(unfiltered).not.toContain('このタグの作品はまだありません。');
  });
});

describe('カードの見え方（仕様 2.3.6）', () => {
  it('スクリーンショットが撮れていない作品も並ぶ', async () => {
    // 撮影は公開時に 1 回だけで、中断したまま残る行がありうる（#235）。
    // 落とすと「公開したのに一覧に出ない」になる。
    const author = await seedUser('撮影中の作者');
    const pending = await seedGame(author, { ogpState: null });

    const body = await (await openList()).text();
    expect(body).toContain(workPagePath(pending));
    expect(body).toContain('画面の準備中');
  });

  it('移設先の案内が出る', async () => {
    // `/works` の意味が変わることを黙って変えない（仕様 2.3.2）。
    expect(await (await openList()).text()).toContain(MOVED_NOTICE);
    expect(MOVED_NOTICE).toContain(MY_WORKS_PATH);
  });
});

describe('Cache API の前段（仕様 2.3.3 の条件 3）', () => {
  it('2 回目は D1 を引き直さず、捨てれば引き直す', async () => {
    const author = await seedUser('キャッシュの作者');
    const key = listCacheKey('works', { sort: 'recent', page: 1 });
    await purgeListCache(key);

    const before = await seedGame(author);
    // `openList` は毎回捨てるので、ここは経路を直接叩いて溜める。
    const url = `${APP_ORIGIN}${PUBLIC_WORKS_PATH}?sort=recent&page=1`;
    const first = await handleAppRequest(new Request(url), env);
    expect(await first.text()).toContain(workPagePath(before));

    const after = await seedGame(author);
    const cached = await handleAppRequest(new Request(url), env);
    // **キャッシュが効いていれば、あとから入れた行は見えない。**
    expect(await cached.text()).not.toContain(workPagePath(after));

    expect(await purgeListCache(key)).toBe(true);
    const fresh = await handleAppRequest(new Request(url), env);
    expect(await fresh.text()).toContain(workPagePath(after));
  });

  it('キャッシュが投げても一覧は出る', async () => {
    // **この層が無くても一覧は正しく出る**（Copilot code review の指摘。2026-09-05）。
    // `caches` を差し替えて、`match` も `put` も投げる状態を作る。
    const original = Reflect.get(globalThis, 'caches') as unknown;
    const broken = {
      default: {
        match: () => Promise.reject(new Error('match が使えない')),
        put: () => Promise.reject(new Error('put が使えない')),
        delete: () => Promise.reject(new Error('delete が使えない')),
      },
    };
    Reflect.set(globalThis, 'caches', broken);
    try {
      const rows = await cachedRows('https://list-cache.game-forge.invalid/x?y=1', async () => [
        'ok',
      ]);
      expect(rows).toEqual(['ok']);
      // 捨てる側も投げるが、false を返すだけで落ちない。
      expect(await purgeListCache('https://list-cache.game-forge.invalid/x?y=1')).toBe(false);
    } finally {
      Reflect.set(globalThis, 'caches', original);
    }
  });

  it('絞り込んだ一覧と絞り込まない一覧は、別の鍵に載る（#376）', async () => {
    const author = await seedUser('鍵のタグの作者');
    const tagged = `${APP_ORIGIN}${PUBLIC_WORKS_PATH}?tag=other&sort=recent&page=1`;
    const plain = `${APP_ORIGIN}${PUBLIC_WORKS_PATH}?sort=recent&page=1`;
    await purgeListCache(listCacheKey('works', { sort: 'recent', page: 1, [WORK_TAG_FIELD]: 'other' }));
    await purgeListCache(listCacheKey('works', { sort: 'recent', page: 1 }));

    // 絞り込んだ一覧を先に溜める。
    await (await handleAppRequest(new Request(tagged), env)).text();
    const after = await seedGame(author, { tags: ['other'] });

    // **同じ鍵なら、絞り込まない一覧も溜めた行を返してしまう。**
    expect(await (await handleAppRequest(new Request(plain), env)).text()).toContain(workPagePath(after));
    // 絞り込んだ一覧は溜めた行のまま（キャッシュが効いている）。
    expect(await (await handleAppRequest(new Request(tagged), env)).text()).not.toContain(
      workPagePath(after),
    );
    expect(
      listCacheKey('works', { sort: 'recent', page: 1, [WORK_TAG_FIELD]: 'other' }),
    ).not.toBe(listCacheKey('works', { sort: 'recent', page: 1, [WORK_TAG_FIELD]: 'idle' }));
  });

  it('鍵は並べ替え軸と頁で分かれる', () => {
    expect(listCacheKey('works', { sort: 'recent', page: 1 })).not.toBe(
      listCacheKey('works', { sort: 'forked', page: 1 }),
    );
    expect(listCacheKey('works', { sort: 'recent', page: 1 })).not.toBe(
      listCacheKey('works', { sort: 'recent', page: 2 }),
    );
    // **並びが違っても同じ鍵になる**（同じ一覧が何本も溜まらない）。
    expect(listCacheKey('works', { page: 1, sort: 'recent' })).toBe(
      listCacheKey('works', { sort: 'recent', page: 1 }),
    );
  });
});

describe('キーワード検索の画面（#378 / 仕様 2.3.5）', () => {
  it('?q= で当たった作品だけが並び、並べ替えの軸は出さずに新着順だと書く', async () => {
    const author = await seedUser('検索の画面の作者');
    const older = await seedGame(author, { title: '宇宙シューティング' });
    const newer = await seedGame(author, { title: '宇宙の果ての灯台' });
    const other = await seedGame(author, { title: '海底たんけん' });

    const body = await (await openList(`?q=${encodeURIComponent('宇宙')}&sort=forked`)).text();
    expect(body).toContain(workPagePath(older));
    expect(body).toContain(workPagePath(newer));
    expect(body).not.toContain(workPagePath(other));
    expect(body.indexOf(workPagePath(newer))).toBeLessThan(body.indexOf(workPagePath(older)));
    expect(body).toContain('<p class="gf-search-filtered">「宇宙」の検索結果</p>');
    // **並べ替えの軸を出さない**（決定 4）。`?sort=forked` を付けても新着のまま。
    expect(body).not.toContain('<nav class="gf-sort"');
    expect(body).toContain(SEARCH_SORT_NOTICE);
    // **検索結果の画面は索引させない**。検索窓に語が戻る。
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).toMatch(/<input id="gf-header-search-q"[^>]* value="宇宙">/u);
  });

  it('検索しない一覧は #378 の前と同じで、noindex も検索の見出しも出ない', async () => {
    const body = await (await openList()).text();
    expect(body).not.toContain('noindex');
    expect(body).not.toContain('gf-search-filtered');
    expect(body).toContain('<nav class="gf-sort"');
    expect(worksListPath('recent', 2)).toBe(`${PUBLIC_WORKS_PATH}?sort=recent&page=2`);
    expect(worksListPath('forked', 1, 'puzzle')).toBe(`${PUBLIC_WORKS_PATH}?tag=puzzle&sort=forked&page=1`);
  });

  it('検索語は escape して出す（見出し・空の結果・検索窓・リンク）', async () => {
    const raw = '<img src=x onerror=alert(1)>"';
    const body = await (await openList(`?q=${encodeURIComponent(raw)}`)).text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img');
    expect(body).toContain('に当たる作品はありませんでした。');
    expect(body).toContain(
      `<a class="gf-button gf-button-secondary gf-button-sm" href="${worksListPath('recent', 1)}">検索をやめて一覧を見る</a>`,
    );
  });

  it('タグの絞り込みと併用でき、タグを選び直しても検索語を保つ', async () => {
    const author = await seedUser('検索とタグの作者');
    const tagged = await seedGame(author, { title: '星降る迷宮パズル', tags: ['puzzle'] });
    const untagged = await seedGame(author, { title: '星降る迷宮パズル' });

    const body = await (await openList(`?tag=puzzle&q=${encodeURIComponent('星降る')}`)).text();
    expect(body).toContain(workPagePath(tagged));
    expect(body).not.toContain(workPagePath(untagged));
    expect(body).toContain('タグ「パズル」の作品');
    const nav = body.slice(body.indexOf('<nav class="gf-tag-filter gf-block"'));
    const filter = nav.slice(0, nav.indexOf('</nav>'));
    expect(filter).toContain(`<a class="gf-chip" href="${worksListPath('recent', 1, null, '星降る')}">すべて</a>`);
    expect(filter).toContain(`<a class="gf-chip" href="${worksListPath('recent', 1, 'action', '星降る')}">アクション</a>`);
    expect(worksListPath('recent', 1, 'action', '星降る')).toBe(
      `${PUBLIC_WORKS_PATH}?tag=action&q=${encodeURIComponent('星降る')}&page=1`,
    );
  });

  it('頁送りで検索語とタグを保ち、21 件目が次の頁に来る', async () => {
    const author = await seedUser('検索の頁送りの作者');
    const ids: string[] = [];
    for (let count = 0; count < WORKS_PER_PAGE + 1; count += 1) {
      ids.push(await seedGame(author, { title: '頁をめくる羅針盤', tags: ['idle'] }));
    }
    const query = `?tag=idle&q=${encodeURIComponent('羅針盤')}`;
    const first = await (await openList(`${query}&page=1`)).text();
    const second = await (await openList(`${query}&page=2`)).text();

    expect(first).not.toContain(workPagePath(ids[0]!));
    expect(first).toContain(`href="${worksListPath('recent', 2, 'idle', '羅針盤')}"`);
    expect(second).toContain(workPagePath(ids[0]!));
    expect(second).toContain(`href="${worksListPath('recent', 1, 'idle', '羅針盤')}"`);
    // **頁の上限は一覧と同じ。**
    const capped = await openList(`${query}&page=999999`);
    expect(capped.status).toBe(200);
  });

  it('断った検索は理由を書き、D1 を 1 回も引かない（400 にしない）', async () => {
    const throwingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare' || property === 'batch') {
          return () => {
            throw new Error('断った検索で D1 を引いた');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const noDb = { ...env, DB: throwingDb } as Env;
    for (const [q, reason] of [
      ['宇', 'too-short'],
      ['あい かき さし たち なに はひ', 'too-many-terms'],
      ['あ'.repeat(41), 'too-long'],
    ] as const) {
      const response = await handleAppRequest(
        new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}?${WORK_SEARCH_FIELD}=${encodeURIComponent(q)}`),
        noDb,
      );
      expect(response.status, q).toBe(200);
      const body = await response.text();
      expect(body, q).toContain(SEARCH_REJECTION_MESSAGES[reason]);
      expect(body, q).not.toContain('gf-search-filtered');
    }
  });

  it('上限の境界に絵文字が跨る長い検索語でも 500 にならず、断る画面になる（PR #432 の Copilot の指摘）', async () => {
    // 区切る前の上限（UTF-16 で 160）の 159 番目の直後に絵文字を置き、`slice` で切ると上位サロゲートが
    // 1 つだけ残る形にする。**残ると、タグのリンクを組む `encodeURIComponent` が `URIError` を投げる。**
    const q = `${'a'.repeat(159)}🎮🎮`;
    const response = await openList(`?q=${encodeURIComponent(q)}&tag=puzzle`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(SEARCH_REJECTION_MESSAGES['too-long']);
    expect(body).toContain(
      `<a class="gf-chip" href="${worksListPath('recent', 1, 'action', 'a'.repeat(159))}">アクション</a>`,
    );
  });

  it('非公開化は、一覧と同じくキャッシュの TTL（60 秒）の後に検索から消える', async () => {
    // **検索の鍵に検索語が入る**ことと、**捨てれば取り下げが反映される**ことを見る。
    const author = await seedUser('検索のキャッシュの作者');
    const id = await seedGame(author, { title: '消える前の砂時計' });
    const url = `${APP_ORIGIN}${PUBLIC_WORKS_PATH}?q=${encodeURIComponent('砂時計')}`;
    const key = worksSearchCacheKey('砂時計', 1, null);
    await purgeListCache(key);

    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(workPagePath(id));
    await env.DB.prepare(`update games set status = '${REMOVED_STATUS}' where id = ?`).bind(id).run();
    // 溜めた行が返る間は残る（一覧と同じ。仕様 2.3.3 の条件 3）。
    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(workPagePath(id));
    expect(await purgeListCache(key)).toBe(true);
    expect(await (await handleAppRequest(new Request(url), env)).text()).not.toContain(workPagePath(id));

    // 空白の数や語の重複が違うだけの URL は同じ鍵に載り、語が違えば別の鍵になる。
    expect(parseWorkSearch(' 砂時計　 砂時計 ')).toMatchObject({ kind: 'accepted', text: '砂時計' });
    expect(worksSearchCacheKey('砂時計 迷路', 1, null)).not.toBe(key);
    expect(worksSearchCacheKey('砂時計', 1, 'puzzle')).not.toBe(key);
    // **英字の大文字小文字だけが違う検索は、同じ鍵に載る**（検索が区別しないので結果が同じ）。
    const upper = parseWorkSearch('Puzzle 砂時計');
    const lower = parseWorkSearch('puzzle 砂時計');
    expect(upper.kind === 'accepted' && lower.kind === 'accepted').toBe(true);
    if (upper.kind === 'accepted' && lower.kind === 'accepted') {
      expect(upper.text).toBe('Puzzle 砂時計');
      expect(worksSearchCacheKey(upper.key, 1, null)).toBe(worksSearchCacheKey(lower.key, 1, null));
    }
    expect(key).not.toBe(listCacheKey('works', { sort: 'recent', page: 1 }));
  });
});

describe('見た目の規約の部品（#474 / M13-10 / 仕様 2.5）', () => {
  const viewer = siteViewerAt(PUBLIC_WORKS_PATH, false, null);

  it('並べ替えはタブ（.gf-tabs）で、いまの軸だけに aria-current があり、リンクにしない', () => {
    for (const sort of PUBLIC_WORK_SORTS) {
      const body = renderWorksListPage({ works: [], sort, page: 1, hasNext: false }, viewer);
      const start = body.indexOf('<nav class="gf-sort" aria-label="並べ替え">\n<ul class="gf-tabs">');
      expect(start, sort).toBeGreaterThan(0);
      const nav = body.slice(start, body.indexOf('</nav>', start));
      expect(nav.match(/aria-current="page"/gu) ?? [], sort).toHaveLength(1);
      expect(nav).toContain(`<li><span aria-current="page">`);
      // いまの軸へのリンクは無く、ほかの軸はリンクである。
      expect(nav).not.toContain(`href="${worksListPath(sort, 1)}"`);
      expect(nav.match(/<li><a href="/gu) ?? [], sort).toHaveLength(PUBLIC_WORK_SORTS.length - 1);
    }
  });

  it('タグの絞り込みはブロックの中のチップで、選んでいるタグにだけ .gf-chip-current と aria-current がある', () => {
    for (const current of [null, ...WORK_TAGS.map((tag) => tag.id)]) {
      const body = renderWorksListPage({ works: [], sort: 'recent', page: 1, hasNext: false, tag: current }, viewer);
      const start = body.indexOf('<nav class="gf-tag-filter gf-block" aria-label="タグで絞り込む">');
      expect(start, String(current)).toBeGreaterThan(0);
      const nav = body.slice(start, body.indexOf('</nav>', start));
      expect(nav.match(/gf-chip-current/gu) ?? [], String(current)).toHaveLength(1);
      expect(nav.match(/aria-current="page"/gu) ?? [], String(current)).toHaveLength(1);
      // 選んでいるチップの要素に、クラスと aria-current の両方が付いている。
      expect(nav).toMatch(/<span class="gf-chip gf-chip-current" aria-current="page">[^<]+<\/span>/u);
      // 選んでいないものはすべて押せるチップ（`a.gf-chip`）。
      expect(nav.match(/<a class="gf-chip" href="/gu) ?? [], String(current)).toHaveLength(WORK_TAGS.length);
    }
  });

  it('頁送りは小さい副のボタンで、次は右端へ寄せるクラスを持つ（DOM の順は前 → 次）', () => {
    const body = renderWorksListPage({ works: [], sort: 'recent', page: 2, hasNext: true }, viewer);
    const start = body.indexOf('<nav class="gf-pager" aria-label="頁送り">');
    expect(start).toBeGreaterThan(0);
    const nav = body.slice(start, body.indexOf('</nav>', start));
    const back = nav.indexOf(
      `<a class="gf-button gf-button-secondary gf-button-sm" href="${worksListPath('recent', 1)}">前の ${WORKS_PER_PAGE} 件</a>`,
    );
    const next = nav.indexOf(
      `<a class="gf-button gf-button-secondary gf-button-sm gf-pager-next" href="${worksListPath('recent', 3)}">次の ${WORKS_PER_PAGE} 件</a>`,
    );
    expect(back).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(back);
  });

  it('移設の案内・断った検索・0 件の知らせは面のブロックで、主のボタンを置かない', () => {
    const empty = renderWorksListPage({ works: [], sort: 'recent', page: 1, hasNext: false }, viewer);
    expect(empty).toContain(`<p class="gf-block gf-works-moved">${MOVED_NOTICE}</p>`);
    expect(empty).toContain('<div class="gf-block gf-works-empty">\n<p>まだ公開された作品がありません。</p>');
    expect(empty).not.toContain('gf-button-primary');

    const rejected = renderWorksListPage(
      { works: [], sort: 'recent', page: 1, hasNext: false, search: parseWorkSearch('宇') },
      viewer,
    );
    expect(rejected).toContain(`<p class="gf-block gf-search-rejected">${SEARCH_REJECTION_MESSAGES['too-short']}</p>`);
    expect(rejected).not.toContain('gf-button-primary');
  });

  it('@section sort-pager は幅の断点も並べ替えも持たない', () => {
    const css = env.TEST_APP_CSS;
    const start = css.indexOf('\n   @section sort-pager');
    const end = css.indexOf('\n   @section ', start + 1);
    expect(start).toBeGreaterThan(0);
    const section = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    expect(section).not.toMatch(/@media|(^|[\s;{])order\s*:|display:\s*contents/u);
  });
});
