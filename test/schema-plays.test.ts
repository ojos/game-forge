import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { reviewVisibleSql } from '../src/reports.js';
import { applySchema } from './helpers/schema.js';

/**
 * `games.play_count` と `played` の部分索引（`migrations/` の `games_play_count`。#377 / 2.3.4）。
 *
 * **列と索引があることより、索引の条件が一覧の条件と同じ綴りであることを見る**
 * （`test/schema-likes.test.ts` と同じ理由）。SQLite は問い合わせの条件が部分索引の条件を
 * 含むと示せたときだけ索引を使うので、`reviewVisibleSql` を書き換えた日に索引の条件だけが
 * 古いと、**黙って全表走査へ戻る**（実行計画の検査は `test/works-list.test.ts` が持つ）。
 */

beforeAll(async () => {
  await applySchema();
});

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

describe('games.play_count（#377）', () => {
  it('既存の行は 0 から始まり、NULL を持てない', async () => {
    // **写しなので、同期される前の作品は「プレイ 0」として並ぶ**（`like_count` と同じ）。
    const columns = await env.DB.prepare(
      "select name, \"notnull\" as not_null, dflt_value from pragma_table_info('games')",
    ).all<{ name: string; not_null: number; dflt_value: string | null }>();
    const playCount = columns.results.find((column) => column.name === 'play_count');
    expect(playCount).toEqual({ name: 'play_count', not_null: 1, dflt_value: '0' });
  });
});

describe('played の部分索引（#377 / 2.3.3 の条件 2）', () => {
  it('審査の可視条件を reviewVisibleSql と同じ綴りで持ち、liked と同じ列の形である', async () => {
    const sql = await indexSql('games_status_play_count_idx');
    expect(sql).not.toBeNull();
    expect(sql).toContain(reviewVisibleSql());
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain('(status, play_count DESC, published_at DESC, id DESC)');
  });

  it('タグの枠ごとのプレイ数の索引は張らない（#376 の決定）', async () => {
    // **絞り込み中はプレイ数順を出さない。** 枠ごとに張ると、同期の書き込みが枠の数だけ増える。
    const rows = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and sql like '%play_count%'",
    ).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual(['games_status_play_count_idx']);
  });
});
