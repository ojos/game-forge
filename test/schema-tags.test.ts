import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAGGED_WORK_SORTS } from '../src/games.js';
import { reviewVisibleSql } from '../src/reports.js';
import { MAX_WORK_TAGS } from '../src/work-tags.js';
import { applySchema } from './helpers/schema.js';

/**
 * `games` のタグの枠と部分索引（`migrations/` の `games_tags`。#376 / 仕様 2.3.3・2.3.5）。
 *
 * **列と索引があることより、索引の条件が一覧の条件と同じ綴りであることを見る**
 * （`test/schema-likes.test.ts` と同じ形）。SQLite は問い合わせの条件が部分索引の条件を含むと
 * 示せたときだけ索引を使うので、`reviewVisibleSql` を書き換えた日に索引の条件だけが古いと、
 * **結果は正しいまま読み取りだけが増える。** 実行計画そのものは `test/works-list.test.ts` が
 * `taggedGamesSql` で見る。
 *
 * **マイグレーションの番号をここに書かない**（取り込みの順で振り直されうる）。
 */

beforeAll(async () => {
  await applySchema();
});

/** 並びの軸ごとの索引の名前の中ほどと、列の並び（`order by` と同じ順）。 */
const AXES: Readonly<Record<(typeof TAGGED_WORK_SORTS)[number], { name: string; columns: string }>> = {
  recent: { name: 'published_at', columns: 'published_at DESC, id DESC' },
  forked: { name: 'fork_count', columns: 'fork_count DESC, published_at DESC, id DESC' },
};

/** 枠の番号（1 始まり）。**上限の値から作る**——枠を足した日に検査が追随する。 */
const SLOTS = Array.from({ length: MAX_WORK_TAGS }, (_, index) => index + 1);

/**
 * 索引の定義文をカタログから引く。
 *
 * @param name 索引の名前
 * @returns `create index` の文。無ければ null
 */
async function indexSql(name: string): Promise<string | null> {
  const row = await env.DB.prepare("select sql from sqlite_master where type = 'index' and name = ?")
    .bind(name)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
}

describe('タグの枠（#376）', () => {
  it('枠は上限と同じ数だけあり、NULL 可・既定値なし（タグ無しを許す）', async () => {
    const columns = await env.DB.prepare(
      "select name, type, \"notnull\" as not_null, dflt_value from pragma_table_info('games')",
    ).all<{ name: string; type: string; not_null: number; dflt_value: string | null }>();
    const tagColumns = columns.results.filter((column) => /^tag\d+$/u.test(column.name));

    // **枠の数 = 1 作品のタグの上限**（2.3.5「1〜3 個」）。片方だけを変えた日に赤くなる。
    expect(tagColumns.map((column) => column.name)).toEqual(SLOTS.map((slot) => `tag${slot}`));
    for (const column of tagColumns) {
      expect(column).toEqual({ name: column.name, type: 'TEXT', not_null: 0, dflt_value: null });
    }
    const setAt = columns.results.find((column) => column.name === 'tags_set_at');
    expect(setAt).toEqual({ name: 'tags_set_at', type: 'INTEGER', not_null: 0, dflt_value: null });
  });

  it('語彙を CHECK で縛らない（語彙を足すたびに games を作り直さない）', async () => {
    // **語彙はコードが持つ**（`src/work-tags.ts`）。語彙に無い値が入っても画面は読み飛ばす
    // （`test/work-tags.test.ts`）。ここでは、表の側が値を断らないことだけを固定する。
    const id = crypto.randomUUID();
    const author = `schema-tags-${id}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(author, `sub-${author}`, `${author}@example.com`, 'タグの表')
      .run();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state, tag1)
       values (?, ?, 'published', 't', '', 1, 'ready', 'not-in-vocabulary')`,
    )
      .bind(id, author)
      .run();
    const row = await env.DB.prepare('select tag1 from games where id = ?')
      .bind(id)
      .first<{ tag1: string }>();
    expect(row?.tag1).toBe('not-in-vocabulary');
  });
});

describe('枠 × 軸の部分索引（2.3.3 の条件 2 / #376）', () => {
  it('絞り込み中の並べ替えは 2 軸で、索引は枠 × 軸の本数ある', () => {
    // 軸を足したのに索引の検査へ足し忘れると、その軸だけが索引なしで通る。
    expect([...TAGGED_WORK_SORTS].sort()).toEqual(Object.keys(AXES).sort());
  });

  for (const slot of SLOTS) {
    for (const sort of TAGGED_WORK_SORTS) {
      const axis = AXES[sort];
      const name = `games_tag${slot}_${axis.name}_idx`;

      it(`${name} が審査の可視条件を reviewVisibleSql と同じ綴りで持つ`, async () => {
        const sql = await indexSql(name);
        expect(sql, name).not.toBeNull();
        // **綴りの一致を見る。** 意味が同じでも綴りが違えば、SQLite が「含む」と示せずに
        // 索引を使わないことがある。
        expect(sql).toContain(reviewVisibleSql());
        expect(sql).toContain("status = 'published'");
        // **タグ無しの作品を索引へ載せない**（タグ無しの公開で書き込みを増やさない）。
        expect(sql).toContain(`tag${slot} IS NOT NULL`);
        // 列の並びは一覧の `order by` と同じ（一時 B-tree を出さない形）。
        expect(sql).toContain(`(tag${slot}, ${axis.columns})`);
      });
    }
  }
});
