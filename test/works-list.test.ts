import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import {
  DRAFT_STATUS,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  publishedGamesSql,
} from '../src/games.js';
import { listCacheKey, purgeListCache } from '../src/list-cache.js';
import { MY_WORKS_PATH } from '../src/my-works.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { WORK_PAGE_PREFIX, workPagePath } from '../src/work-page.js';
import {
  MAX_PAGE,
  MOVED_NOTICE,
  PUBLIC_WORKS_PATH,
  WORKS_PER_PAGE,
  toPageNumber,
} from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * 公開作品の一覧（#328 / M9-2 / 仕様 2.3）。
 *
 * **#328 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. `draft` の作品が一覧に出ない
 * 2. 21 件目がページングで取得できる
 * 3. 並べ替え 2 軸それぞれ
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
    readonly ogpState?: string | null;
    readonly reviewState?: string | null;
    readonly parentId?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, ogp_state, review_state, parent_id)
     values (?, ?, ?, ?, '', 1, 'ready', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.publishedAt === undefined ? nextPublishedAt() : overrides.publishedAt,
      overrides.forkCount ?? 0,
      overrides.ogpState === undefined ? 'ready' : overrides.ogpState,
      overrides.reviewState ?? null,
      overrides.parentId ?? null,
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
  const sort = url.searchParams.get('sort') ?? 'recent';
  const page = toPageNumber(url.searchParams.get('page'));
  await purgeListCache(listCacheKey('works', { sort, page }));
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
  it('2 軸とも全表走査ではなく、0019 の索引を使う', async () => {
    // **検査が SQL を書き写さない。** `publishedGamesSql` が返す文字列をそのまま
    // 実行計画に掛ける（`.ai-playbook/shared-ai-rules.md` 12 章）。
    for (const [sort, index] of [
      ['recent', 'games_status_published_at_idx'],
      ['forked', 'games_status_fork_count_idx'],
    ] as const) {
      const plan = await env.DB.prepare(`explain query plan ${publishedGamesSql(sort)}`)
        .bind(PUBLISHED_STATUS, WORKS_PER_PAGE, 0)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' | ');

      expect(detail, `${sort} の実行計画: ${detail}`).toContain(index);
      // **並べ替えのための一時 B-tree が出たら、索引の列順が並びと合っていない。**
      expect(detail, `${sort} の実行計画: ${detail}`).not.toContain('USE TEMP B-TREE');
    }
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
