import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setReviewState } from '../src/admin/actions.js';
import {
  DRAFT_STATUS,
  PUBLISHED_STATUS,
  describeGame,
  listPublishedGames,
  publishGame,
  publishedGamesSql,
  removeGame,
  renameGame,
} from '../src/games.js';
import { REVIEW_CLEARED, REVIEW_QUEUED, recordReport } from '../src/reports.js';
import type { AcceptedSearch } from '../src/work-search.js';
import {
  INDEXED_TERM_MIN_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_TERMS,
  ftsMatchExpression,
  listSearchedGames,
  parseWorkSearch,
  searchWorksStatement,
} from '../src/work-search.js';
import { WORKS_PER_PAGE } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * キーワード検索（#378 / M12-10 / 仕様 2.3.5）。
 *
 * **#378 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. **日本語の語で引ける**——**2 文字の語（「宇宙」）で「宇宙シューティング」が当たる**（利用者の決定 1）
 * 2. **非公開化した作品が検索結果から消える**（取り下げ・通報で審査へ・運営の審査・運営が D1 を直接
 *    UPDATE する取り下げ）。**守りは 2 層あり、それぞれを別の検査が見る**——索引の層（トリガ）と、
 *    引く時点の層（`games` と結合して可視条件を掛ける）。**片方を外すと、その層の検査だけが赤くなる**
 * 3. **実行計画で全表走査が出ない**（3 文字以上の語）。**`EXPLAIN` の字面だけで判定しない**——
 *    `rows_read` も見る（handoff 1 章「`L0` は索引の証拠ではない」）
 *
 * 索引の形（トリガの条件の綴り・対応表）は `test/schema-search.test.ts` が見る。画面は
 * `test/works-list.test.ts` が見る。
 */

beforeAll(async () => {
  await applySchema();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 利用者を 1 人用意する。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName: string): Promise<string> {
  const id = `search-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 公開時刻を払い出す（**呼ぶたびに最も新しい**。`test/works-list.test.ts` と同じ理由で、仕込んだ行が
 * 新着順の先頭側へ来るようにする）。
 */
let publishedAtSeq = 9_500_000_000;

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
 * `games` の行を 1 件入れる（**insert のトリガを通る**）。
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
    readonly description?: string;
    readonly reviewState?: string | null;
    readonly tags?: readonly (string | null)[];
    readonly likeCount?: number;
    readonly forkCount?: number;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, description, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state, tag1, tag2, tag3)
     values (?, ?, ?, ?, ?, '', 1, 'ready', ?, ?, ?, 'ready', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.description ?? '',
      nextPublishedAt(),
      overrides.forkCount ?? 0,
      overrides.likeCount ?? 0,
      overrides.reviewState ?? null,
      overrides.tags?.[0] ?? null,
      overrides.tags?.[1] ?? null,
      overrides.tags?.[2] ?? null,
    )
    .run();
  return id;
}

/**
 * 検索語を受け付けた形へ落とす（受け付けられない語を渡したら検査を落とす）。
 *
 * @param text 検索語
 * @returns 受け付けた検索
 */
function accepted(text: string): AcceptedSearch {
  const search = parseWorkSearch(text);
  if (search.kind !== 'accepted') {
    throw new Error(`検索語「${text}」を受け付けなかった: ${JSON.stringify(search)}`);
  }
  return search;
}

/**
 * 検索して、当たった作品の id を返す（1 頁目・タグ無し）。
 *
 * @param text 検索語
 * @param tag 絞り込むタグ
 * @returns 当たった作品の id（新着順）
 */
async function searchIds(text: string, tag: 'puzzle' | 'action' | null = null): Promise<string[]> {
  const works = await listSearchedGames(env, accepted(text), tag, 1_000, 0);
  return works.map((work) => work.id);
}

/**
 * 索引（対応表）にその作品の文書があるか。**引く時点の条件を通さずに、索引の層だけを見る。**
 *
 * @param gameId 作品 id
 * @returns 文書があり、FTS5 表にも同じ `rowid` の行があれば true
 */
async function indexed(gameId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `select count(*) as n
       from game_search_docs d
       join game_search_fts f on f.rowid = d.doc_id
      where d.game_id = ?`,
  )
    .bind(gameId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/**
 * 実行計画を 1 行の文字列にする（**本番と同じ文と束縛値を掛ける**）。
 *
 * @param search 受け付けた検索
 * @param tag 絞り込むタグ
 * @returns `EXPLAIN QUERY PLAN` の detail を連ねたもの
 */
async function planOf(search: AcceptedSearch, tag: 'puzzle' | null): Promise<string> {
  const statement = searchWorksStatement(search, tag, WORKS_PER_PAGE + 1, 0);
  const plan = await env.DB.prepare(`explain query plan ${statement.sql}`)
    .bind(...statement.binds)
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(' | ');
}

describe('検索語の解釈（#378 の利用者の決定 2）', () => {
  it('空と空白だけは検索しない', () => {
    expect(parseWorkSearch(null)).toEqual({ kind: 'none' });
    expect(parseWorkSearch('')).toEqual({ kind: 'none' });
    expect(parseWorkSearch(' 　\t ')).toEqual({ kind: 'none' });
  });

  it('全角の空白でも区切り、同じ語は 1 つにまとめ、語の長さで引き方を分ける', () => {
    expect(parseWorkSearch('  宇宙　シューティング 宇宙  ')).toEqual({
      kind: 'accepted',
      text: '宇宙 シューティング',
      indexedTerms: ['シューティング'],
      shortTerms: ['宇宙'],
    });
    // **索引で引ける最短は trigram の 3 文字**（#370）。
    expect(INDEXED_TERM_MIN_LENGTH).toBe(3);
    expect(accepted('迷路').indexedTerms).toEqual([]);
    expect(accepted('迷路島').indexedTerms).toEqual(['迷路島']);
  });

  it('1 文字の語だけの検索は断り、2 文字以上の語と並んでいれば受け付ける', () => {
    expect(parseWorkSearch('宇')).toEqual({ kind: 'rejected', text: '宇', reason: 'too-short' });
    expect(parseWorkSearch('a b')).toEqual({ kind: 'rejected', text: 'a b', reason: 'too-short' });
    expect(accepted('宇宙 a').shortTerms).toEqual(['宇宙', 'a']);
  });

  it('語の数と長さに上限を置く（コードポイントで数える）', () => {
    expect(MAX_SEARCH_TERMS).toBe(5);
    expect(MAX_SEARCH_LENGTH).toBe(40);
    expect(parseWorkSearch('あい かき さし たち なに').kind).toBe('accepted');
    expect(parseWorkSearch('あい かき さし たち なに はひ')).toMatchObject({ reason: 'too-many-terms' });
    // **絵文字を 2 文字と数えない**（上限ちょうどは通る）。
    expect(parseWorkSearch('🎮'.repeat(MAX_SEARCH_LENGTH)).kind).toBe('accepted');
    expect(parseWorkSearch('🎮'.repeat(MAX_SEARCH_LENGTH + 1))).toMatchObject({ reason: 'too-long' });
    // **区切る前にも切る**（空白を大量に挟んだ入力を分割しない）。
    expect(parseWorkSearch(`あい${' '.repeat(10_000)}かき`)).toMatchObject({ reason: 'too-long' });
  });

  it('FTS5 の式は語ごとのフレーズで、中の " を二重にする', () => {
    expect(ftsMatchExpression(['宇宙船', 'a"b c'])).toBe('"宇宙船" "a""b c"');
  });
});

describe('日本語で引ける（#378 の acceptance / 利用者の決定 1）', () => {
  it('部分語（3 文字以上）で題名が当たる', async () => {
    const author = await seedUser('部分語の作者');
    const breakout = await seedGame(author, { title: 'ブロック崩しゲーム' });
    expect(await searchIds('ゲーム')).toContain(breakout);
    expect(await searchIds('ブロック')).toContain(breakout);
  });

  it('**2 文字の語「宇宙」で「宇宙シューティング」が当たる**', async () => {
    // **trigram の `match` では 0 件になり、黙って外れる語である**（#370）。
    const author = await seedUser('宇宙の作者');
    const space = await seedGame(author, { title: '宇宙シューティング' });
    const other = await seedGame(author, { title: '海底たんけん' });

    const ids = await searchIds('宇宙');
    expect(ids).toContain(space);
    expect(ids).not.toContain(other);
  });

  it('説明でも当たり、空白で区切った語はすべてを含む作品だけが当たる（AND）', async () => {
    const author = await seedUser('説明の作者');
    const both = await seedGame(author, { title: '虹色迷宮', description: '迷路を抜けて宝を探す' });
    const titleOnly = await seedGame(author, { title: '虹色迷宮Ⅱ', description: '空を飛ぶ' });

    expect(await searchIds('宝を探す')).toEqual([both]);
    // 3 文字以上の語（索引）と 2 文字の語（後から絞る）を並べる。題名と説明をまたいでよい。
    const ids = await searchIds('虹色迷宮 迷路');
    expect(ids).toContain(both);
    expect(ids).not.toContain(titleOnly);
    // 2 文字の語どうしの AND。
    expect(await searchIds('迷路 宝を')).toEqual([both]);
  });

  it('英字は大文字と小文字を区別しない（3 文字以上も 2 文字以下も）', async () => {
    const author = await seedUser('英字の作者');
    const puzzle = await seedGame(author, { title: 'Puzzle Game Deluxe', description: 'a 3D maze' });
    expect(await searchIds('puzzle')).toContain(puzzle);
    expect(await searchIds('3d')).toContain(puzzle);
  });

  it('FTS5 の演算子や引用符を打っても、構文として解釈されず落ちない', async () => {
    const author = await seedUser('演算子の作者');
    const quoted = await seedGame(author, { title: '"引用"の作品 NOT OR' });
    for (const text of ['"引用"の', 'NOT OR', 'title:引用', '引用* OR (', 'NEAR(ab cd)']) {
      await expect(searchIds(text), text).resolves.toBeInstanceOf(Array);
    }
    expect(await searchIds('"引用"の')).toContain(quoted);
    // `NOT` は演算子にならず、語として当たる（大文字小文字は区別しない）。
    expect(await searchIds('not or')).toContain(quoted);
  });

  it('タグの絞り込みと併用でき、新着順に並ぶ', async () => {
    const author = await seedUser('タグ併用の作者');
    const older = await seedGame(author, { title: '星屑パズル', tags: ['puzzle'] });
    const untagged = await seedGame(author, { title: '星屑パズル' });
    const newer = await seedGame(author, { title: '星屑パズル', tags: ['action', 'puzzle'] });

    expect(await searchIds('星屑パズル', 'puzzle')).toEqual([newer, older]);
    expect(await searchIds('星屑パズル')).toEqual([newer, untagged, older]);
    // 2 文字の語だけでも同じ。
    expect((await searchIds('星屑', 'puzzle')).slice(0, 2)).toEqual([newer, older]);
  });

  it('一覧と同じ形のカードの入力を返す（行の写し方が一覧とずれていない）', async () => {
    const author = await seedUser('写しの作者');
    const id = await seedGame(author, {
      title: '写し比べの題名',
      tags: ['puzzle'],
      likeCount: 3,
      forkCount: 2,
    });
    const listed = (await listPublishedGames(env, 'recent', 200, 0)).find((work) => work.id === id);
    const searched = (await listSearchedGames(env, accepted('写し比べ'), null, 20, 0)).find(
      (work) => work.id === id,
    );
    expect(listed).toBeDefined();
    expect(searched).toEqual(listed);
  });

  it('検索が選ぶ列は、一覧（publishedGamesSql）が選ぶ列と同じである', () => {
    const columnsOf = (sql: string): string =>
      /^\s*select\s+([\s\S]*?)\s+from\s/iu.exec(sql)![1]!.replace(/\s+/gu, ' ');
    const list = columnsOf(publishedGamesSql('recent'));
    for (const text of ['宇宙船', '宇宙']) {
      expect(columnsOf(searchWorksStatement(accepted(text), null, 21, 0).sql)).toBe(list);
    }
  });
});

describe('非公開化した作品が検索結果から消える（#378 の acceptance）', () => {
  // **引く時点の層を外しても、ここの画面側の結果は索引の層が守る**（逆も同じ）。だから層ごとの
  // 検査を別に置く——「索引の層」の describe と「引く時点の層」の describe。

  it('取り下げ（removeGame）で消え、索引からも文書が消える', async () => {
    const author = await seedUser('取り下げの作者');
    const id = await seedGame(author, { title: '取り下げる流星群' });
    expect(await searchIds('流星群')).toContain(id);
    expect(await indexed(id)).toBe(true);

    expect(await removeGame(env, id, author)).toEqual({ ok: true, firstTime: true });
    expect(await searchIds('流星群')).not.toContain(id);
    expect(await searchIds('流星')).not.toContain(id);
    expect(await indexed(id)).toBe(false);
  });

  it('通報で審査へ（queued）入ると消え、運営が問題なしにすると戻る', async () => {
    const author = await seedUser('通報の作者');
    const reporter = await seedUser('通報した人');
    const admin = await seedUser('運営');
    const id = await seedGame(author, { title: '通報される銀河鉄道' });
    expect(await searchIds('銀河鉄道')).toContain(id);

    const reported = await recordReport(env, id, reporter, '不適切');
    expect(reported).toMatchObject({ ok: true, outcome: { queued: true } });
    expect(await searchIds('銀河鉄道')).not.toContain(id);
    expect(await indexed(id)).toBe(false);

    const cleared = await setReviewState(env, {
      gameId: id,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: admin,
      reason: '問題なし',
    });
    expect(cleared).toMatchObject({ ok: true, changed: true });
    expect(await searchIds('銀河鉄道')).toContain(id);
    expect(await indexed(id)).toBe(true);

    // 運営が審査へ戻すと、また消える。
    await setReviewState(env, {
      gameId: id,
      from: REVIEW_CLEARED,
      to: REVIEW_QUEUED,
      actorId: admin,
      reason: '再審査',
    });
    expect(await searchIds('銀河鉄道')).not.toContain(id);
  });

  it('運営が D1 を直接 UPDATE した取り下げも拾う（アプリの経路を通らない）', async () => {
    const author = await seedUser('直接の作者');
    const id = await seedGame(author, { title: '直接消される砂時計' });
    expect(await searchIds('砂時計')).toContain(id);

    await env.DB.prepare("update games set status = 'removed' where id = ?").bind(id).run();
    expect(await searchIds('砂時計')).not.toContain(id);
    expect(await indexed(id)).toBe(false);
  });

  it('下書きは当たらず、公開（publishGame）すると当たる', async () => {
    const author = await seedUser('公開の作者');
    const id = await seedGame(author, { status: DRAFT_STATUS, title: 'これから出す灯台守' });
    expect(await searchIds('灯台守')).not.toContain(id);
    expect(await indexed(id)).toBe(false);

    expect(await publishGame(env, id, author)).toMatchObject({ ok: true, firstTime: true });
    expect(await searchIds('灯台守')).toContain(id);
  });

  it('改名と説明の変更で、古い語では当たらなくなり、新しい語で当たる', async () => {
    const author = await seedUser('改名の作者');
    const id = await seedGame(author, { title: '古い名前の風車小屋', description: '古い説明の麦畑' });

    expect(await renameGame(env, id, author, '新しい名前の水車小屋')).toMatchObject({ ok: true, changed: true });
    expect(await searchIds('風車小屋')).not.toContain(id);
    expect(await searchIds('水車小屋')).toContain(id);

    expect(await describeGame(env, id, author, '新しい説明の果樹園', 2_000_000_000)).toMatchObject({ ok: true });
    expect(await searchIds('麦畑')).not.toContain(id);
    expect(await searchIds('果樹園')).toContain(id);
  });

  it('物理削除でも索引から消える', async () => {
    const author = await seedUser('削除の作者');
    const id = await seedGame(author, { title: '消えてなくなる蜃気楼' });
    expect(await indexed(id)).toBe(true);
    await env.DB.prepare('delete from games where id = ?').bind(id).run();
    expect(await indexed(id)).toBe(false);
  });
});

describe('引く時点の層: 索引がずれていても、非公開の作品は出ない（二重に守る）', () => {
  it('索引に残った取り下げ済み・審査中・下書きの文書を、結合した可視条件で落とす', async () => {
    // **トリガが外れた日と同じ状態を手で作る**——`games` を非公開にしてから、索引へ文書を戻す。
    // **引く時点の `status = ?` と `reviewVisibleSql('g')` を外すと、ここが赤くなる。**
    const author = await seedUser('ずれの作者');
    const removed = await seedGame(author, { title: 'ずれた索引の幽霊船' });
    const queued = await seedGame(author, { title: 'ずれた索引の幽霊船' });
    const draft = await seedGame(author, { title: 'ずれた索引の幽霊船', status: DRAFT_STATUS });
    const visible = await seedGame(author, { title: 'ずれた索引の幽霊船' });
    await env.DB.prepare("update games set status = 'removed' where id = ?").bind(removed).run();
    await env.DB.prepare('update games set review_state = ? where id = ?').bind(REVIEW_QUEUED, queued).run();

    for (const id of [removed, queued, draft]) {
      await env.DB.batch([
        env.DB.prepare('insert into game_search_docs (game_id) values (?)').bind(id),
        env.DB.prepare(
          `insert into game_search_fts (rowid, title, description)
           select doc_id, 'ずれた索引の幽霊船', '' from game_search_docs where game_id = ?`,
        ).bind(id),
      ]);
      expect(await indexed(id)).toBe(true);
    }

    for (const text of ['幽霊船', 'ずれた索引の幽霊船', '幽霊', '幽霊 索引']) {
      const ids = await searchIds(text);
      expect(ids, text).toContain(visible);
      expect(ids, text).not.toContain(removed);
      expect(ids, text).not.toContain(queued);
      expect(ids, text).not.toContain(draft);
    }
  });
});

describe('読み取りが該当しない公開作品の数に比例しない（#378 の決定 4 / 仕様 2.3.3 の条件 2）', () => {
  it('3 文字以上の語は FTS5 の match から引き、games を並びの順に読まない', async () => {
    // **本番と同じ文と束縛値で掛ける**（`searchWorksStatement` の出力をそのまま使う）。
    for (const [search, tag] of [
      [accepted('宇宙シューティング'), null],
      [accepted('宇宙船 宇宙 a'), 'puzzle'],
    ] as const) {
      const detail = await planOf(search, tag);
      expect(detail, detail).toMatch(/SCAN f VIRTUAL TABLE INDEX \d+:M/u);
      expect(detail, detail).toContain('SEARCH d USING INTEGER PRIMARY KEY (rowid=?)');
      expect(detail, detail).toMatch(/SEARCH g USING (INDEX sqlite_autoindex_games_1|PRIMARY KEY) \(id=\?\)/u);
      expect(detail, detail).not.toMatch(/SCAN g\b/u);
      expect(detail, detail).not.toMatch(/SCAN d\b/u);
      expect(detail, detail).not.toMatch(/SCAN u(?! USING)/u);
    }
  });

  it('2 文字以下の語だけのときは FTS5 を使わず、公開一覧の索引を新しい順に読む（公開 500 本まで許す）', async () => {
    const detail = await planOf(accepted('宇宙'), null);
    expect(detail, detail).toContain('games_status_published_at_idx');
    expect(detail, detail).not.toContain('VIRTUAL TABLE');
    expect(detail, detail).not.toContain('USE TEMP B-TREE');
    expect(detail, detail).not.toMatch(/SCAN g(?! USING)/u);
  });

  it('rows_read: 3 文字以上の語は当たらない公開作品を読まず、2 文字の語だけなら読む', async () => {
    // **`EXPLAIN` の字面だけで判定しない**（handoff 1 章。`L0` は 2 文字でも出た）。当たらない
    // 公開作品を 120 本足し、当たる 1 本を引いたときに D1 が数えた `rows_read` を見る。
    const author = await seedUser('読み取りの作者');
    const noise = 120;
    for (let index = 0; index < noise; index += 1) {
      await seedGame(author, { title: `関係のない作品その${index}`, description: '当たらない説明' });
    }
    const target = await seedGame(author, { title: '一本だけの羅針盤' });

    const indexedStatement = searchWorksStatement(accepted('羅針盤'), null, WORKS_PER_PAGE + 1, 0);
    const indexedResult = await env.DB.prepare(indexedStatement.sql)
      .bind(...indexedStatement.binds)
      .all<{ id: string }>();
    expect(indexedResult.results.map((row) => row.id)).toEqual([target]);

    // 2 文字の語で、仕込んだ当たらない作品より古い 1 本を引く（新しい順に読み、途中で止まれない）。
    const shortStatement = searchWorksStatement(accepted('嵐雲'), null, WORKS_PER_PAGE + 1, 0);
    const shortResult = await env.DB.prepare(shortStatement.sql)
      .bind(...shortStatement.binds)
      .all<{ id: string }>();
    expect(shortResult.results).toEqual([]);

    const indexedRead = indexedResult.meta.rows_read;
    const shortRead = shortResult.meta.rows_read;
    expect(typeof indexedRead, 'D1 が rows_read を返していない（検査が空振りする）').toBe('number');
    // **当たらない 120 本を読んでいない**（FTS5 の内部の表と、当たった 1 本の結合だけ）。
    expect(indexedRead, `3 文字以上の rows_read = ${indexedRead}`).toBeLessThan(noise / 4);
    // **2 文字の語だけなら、公開作品を少なくとも仕込んだ数だけ読む**（比較の対照。ここが壊れていれば
    // 上の検査は何も言っていない）。
    expect(shortRead, `2 文字の rows_read = ${shortRead}`).toBeGreaterThanOrEqual(noise);
  });

  it('頁の件数は一覧と同じで、上限より 1 件多く引いて次の頁を判定できる', async () => {
    const author = await seedUser('頁の作者');
    const ids: string[] = [];
    for (let index = 0; index < WORKS_PER_PAGE + 1; index += 1) {
      ids.push(await seedGame(author, { title: '頁を送る天球儀' }));
    }
    const first = await listSearchedGames(env, accepted('天球儀'), null, WORKS_PER_PAGE + 1, 0);
    const second = await listSearchedGames(env, accepted('天球儀'), null, WORKS_PER_PAGE + 1, WORKS_PER_PAGE);
    expect(first).toHaveLength(WORKS_PER_PAGE + 1);
    // 新しい順なので、最初に入れた 1 本が 2 頁目に来る。
    expect(second.map((work) => work.id)).toEqual([ids[0]]);
  });
});

describe('検索語を SQL とログに入れない', () => {
  it('SQL の文字列に検索語が現れず、すべて束縛で渡す', () => {
    const text = "宇宙'; drop -- 迷路";
    const search = parseWorkSearch(text);
    expect(search.kind).toBe('accepted');
    const statement = searchWorksStatement(search as AcceptedSearch, 'puzzle', 21, 0);
    expect(statement.sql).not.toContain('宇宙');
    expect(statement.sql).not.toContain('drop');
    expect(statement.sql).not.toContain('迷路');
    expect(statement.sql).not.toContain('puzzle');
    expect(statement.binds).toContain('迷路');
    expect(statement.binds).toContain(`"宇宙';" "drop"`);
  });

  it('D1 が失敗しても、ログにも投げ直した例外にも検索語が載らない', async () => {
    const secret = '秘密の検索語';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = {
      ...env,
      DB: {
        prepare: () => ({
          bind: () => ({
            all: () => Promise.reject(new Error(`fts5: syntax error near "${secret}"`)),
          }),
        }),
      },
    } as unknown as Env;

    const outcome = await listSearchedGames(failing, accepted(secret), null, 21, 0).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).not.toContain(secret);
    expect((outcome as Error).cause).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    for (const call of errors.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(secret);
    }
  });
});
