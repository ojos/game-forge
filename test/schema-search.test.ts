import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_STATUS } from '../src/games.js';
import { reviewVisibleSql } from '../src/reports.js';
import { applySchema } from './helpers/schema.js';

/**
 * キーワード検索の索引（`migrations/` の `game_search`。#378 / 仕様 2.3.5）。
 *
 * **表とトリガがあることより、トリガの条件が一覧の条件と同じ綴りであることを見る**
 * （`test/schema-plays.test.ts` と同じ理由）。`reviewVisibleSql` を書き換えた日にトリガの条件だけが
 * 古いと、**審査で止めた作品が索引に残る**（引く時点の条件がもう一度落とすので画面には出ないが、
 * 二重の守りが 1 枚になったことに誰も気づかない）。
 *
 * **トリガが同期すること**（公開・取り下げ・審査・改名・物理削除）は `test/work-search.test.ts` が
 * 行き来で見る。ここは定義の形を見る。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * カタログから定義文を引く。
 *
 * @param type `table` / `trigger` など
 * @param name 名前
 * @returns 定義文。無ければ null
 */
async function definitionOf(type: string, name: string): Promise<string | null> {
  const row = await env.DB.prepare('select sql from sqlite_master where type = ? and name = ?')
    .bind(type, name)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
}

/**
 * 空白をつぶして 1 行にする（定義文の改行と字下げに照合を依存させない）。
 *
 * @param sql 定義文
 * @returns 空白を 1 つにした文
 */
function squash(sql: string): string {
  return sql.replace(/\s+/gu, ' ');
}

/** 可視の条件の、トリガの中での綴り（`new` の行について）。 */
const VISIBLE_NEW = `new.status = '${PUBLISHED_STATUS}' and ${reviewVisibleSql('new')}`;

describe('対応表と FTS5 表（#378 の利用者の決定 3）', () => {
  it('対応表は INTEGER PRIMARY KEY の doc_id と、UNIQUE の game_id を持つ', async () => {
    const columns = await env.DB.prepare(
      "select name, type, pk, \"notnull\" as not_null from pragma_table_info('game_search_docs') order by cid",
    ).all<{ name: string; type: string; pk: number; not_null: number }>();
    expect(columns.results).toEqual([
      { name: 'doc_id', type: 'INTEGER', pk: 1, not_null: 0 },
      { name: 'game_id', type: 'TEXT', pk: 0, not_null: 1 },
    ]);
    const unique = await env.DB.prepare(
      `select il.name from pragma_index_list('game_search_docs') il
        where il."unique" = 1 and exists (
          select 1 from pragma_index_info(il.name) ii where ii.name = 'game_id')`,
    ).all<{ name: string }>();
    expect(unique.results).toHaveLength(1);
  });

  it('FTS5 表は trigram の通常の表で、games の暗黙の rowid に繋がない（外部コンテンツにしない）', async () => {
    const sql = await definitionOf('table', 'game_search_fts');
    expect(sql).not.toBeNull();
    const squashed = squash(sql!).toLowerCase();
    expect(squashed).toContain('using fts5(title, description');
    expect(squashed).toContain("tokenize = 'trigram'");
    // **`content=` / `content_rowid=` を持たない**（持つと games の暗黙の rowid を指す形になる）。
    expect(squashed).not.toContain('content');
  });
});

describe('同期のトリガ（#378）', () => {
  it('insert のトリガは、可視の行だけを reviewVisibleSql と同じ綴りの条件で入れる', async () => {
    const sql = await definitionOf('trigger', 'games_search_ai');
    expect(sql).not.toBeNull();
    const squashed = squash(sql!);
    expect(squashed).toMatch(/AFTER INSERT ON games/iu);
    expect(squashed.toLowerCase()).toContain(`when ${VISIBLE_NEW.toLowerCase()}`);
  });

  it('update のトリガは status / review_state / title / description の更新にだけ発火する', async () => {
    const sql = await definitionOf('trigger', 'games_search_au');
    expect(sql).not.toBeNull();
    const squashed = squash(sql!);
    // **`like_count` / `play_count` の 5 分おきの同期や、タグ・撮影の状態の更新で発火させない。**
    expect(squashed).toMatch(/AFTER UPDATE OF status, review_state, title, description ON games/iu);
    for (const column of ['like_count', 'play_count', 'fork_count', 'tag1', 'ogp_state', 'published_at']) {
      expect(squashed, column).not.toContain(column);
    }
    // 入れ直す条件の綴りは insert と同じ。
    expect(squashed.toLowerCase()).toContain(`where ${VISIBLE_NEW.toLowerCase()}`);
  });

  it('delete のトリガがある', async () => {
    const sql = await definitionOf('trigger', 'games_search_ad');
    expect(sql).not.toBeNull();
    expect(squash(sql!)).toMatch(/AFTER DELETE ON games/iu);
  });

  it('games のトリガはこの 4 本だけで、検索の 3 本以外は表を書かない', async () => {
    // **トリガを足した日に、ここを見直す**（書き込みの費用が増える経路だから）。
    //
    // **`games_skip_withdrawn_author`（0045 / #586）は書かない。** 本体は
    // `SELECT RAISE(IGNORE)` だけで、退会を始めた作者の作品の挿入を黙って飛ばす。
    // 書き込みの費用は増えず、増えるのは挿入 1 行あたり `users` を 1 行引く読み取りだけである
    // （下の `rows_written` の検査がそれを見ている）。
    const rows = await env.DB.prepare(
      "select name from sqlite_master where type = 'trigger' and tbl_name = 'games' order by name",
    ).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual([
      'games_search_ad',
      'games_search_ai',
      'games_search_au',
      'games_skip_withdrawn_author',
    ]);

    // **検索の 3 本以外が表を書いていないこと**を綴りで見る（`insert` / `update` / `delete` を
    // 持たない）。トリガの数だけを数えると、次に足したトリガが黙って書き込みを増やしうる。
    const skip = await definitionOf('trigger', 'games_skip_withdrawn_author');
    expect(skip).not.toBeNull();
    const body = squash(skip!).toLowerCase();
    expect(body).toContain('select raise(ignore)');
    for (const verb of ['insert into', 'update ', 'delete from']) {
      expect(body, verb).not.toContain(verb);
    }
  });

  it('いいね数・プレイ数の同期は索引に 1 行も書かない（rows_written）', async () => {
    const author = `schema-search-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(author, `sub-${author}`, `${author}@example.com`, '索引の書き込みの作者')
      .run();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state, published_at)
       values (?, ?, 'published', '書き込みを数える', '', 1, 'ready', 1)`,
    )
      .bind(id, author)
      .run();

    // **比較の対照**: 題名を変えると、索引の書き直しの分だけ増える。
    const renamed = await env.DB.prepare("update games set title = '書き込みを数える改' where id = ?")
      .bind(id)
      .run();
    // いいね数とプレイ数の同期と同じ形の UPDATE（`workers/likes/src/hub.ts` / `play-hub.ts`）。
    const liked = await env.DB.prepare('update games set like_count = ? where id = ? and like_count <> ?')
      .bind(7, id, 7)
      .run();
    const played = await env.DB.prepare('update games set play_count = ? where id = ? and play_count <> ?')
      .bind(9, id, 9)
      .run();
    // **同じ値を入れ直す改名は、`WHEN` で索引を書き直さない。**
    const same = await env.DB.prepare("update games set title = '書き込みを数える改' where id = ?")
      .bind(id)
      .run();

    expect(renamed.meta.rows_written).toBeGreaterThan(liked.meta.rows_written);
    // 表の行と、部分索引の行の 2 行だけ（索引の表には触れない）。
    expect(liked.meta.rows_written).toBe(2);
    expect(played.meta.rows_written).toBe(2);
    expect(same.meta.rows_written).toBeLessThan(renamed.meta.rows_written);
  });

  it('初期投入は入っていない作品だけを入れ、二度流しても重複しない', async () => {
    // **マイグレーションの投入文をそのまま流す**（書き写さない）。トリガが入れた後に流しても、
    // 対応表の UNIQUE と FTS5 表の `rowid` がぶつからないこと。
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.endsWith('_game_search.sql'));
    expect(migration, 'game_search のマイグレーションが見つからない').toBeDefined();
    const backfill = migration!.queries.filter((query) => /^\s*INSERT (OR IGNORE )?INTO game_search_/iu.test(query));
    expect(backfill).toHaveLength(2);

    const author = `schema-backfill-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(author, `sub-${author}`, `${author}@example.com`, '投入の作者')
      .run();
    const lost = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state, published_at)
       values (?, ?, 'published', '索引から漏れた作品', '', 1, 'ready', 1)`,
    )
      .bind(lost, author)
      .run();
    // **漏れた状態を作る**（トリガが外れていた間に公開された作品と同じ）。
    await env.DB.batch([
      env.DB.prepare(
        'delete from game_search_fts where rowid = (select doc_id from game_search_docs where game_id = ?)',
      ).bind(lost),
      env.DB.prepare('delete from game_search_docs where game_id = ?').bind(lost),
    ]);

    const count = async (): Promise<{ docs: number; fts: number; visible: number }> =>
      (await env.DB.prepare(
        `select (select count(*) from game_search_docs) as docs,
                (select count(*) from game_search_fts) as fts,
                (select count(*) from games where status = ? and ${reviewVisibleSql()}) as visible`,
      )
        .bind(PUBLISHED_STATUS)
        .first<{ docs: number; fts: number; visible: number }>())!;

    const before = await count();
    expect(before.docs).toBe(before.visible - 1);
    for (let round = 0; round < 2; round += 1) {
      for (const query of backfill) {
        await env.DB.prepare(query).run();
      }
      const after = await count();
      expect(after, `${round + 1} 回目`).toEqual({ docs: after.visible, fts: after.visible, visible: after.visible });
    }
    // FTS5 の整合性検査が通る（本番で親が照合するのと同じ文）。
    await env.DB.prepare("insert into game_search_fts(game_search_fts) values ('integrity-check')").run();
  });
});
