import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { artifactDeletionPlanSql } from '../src/build-cache.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作品を消す土台のスキーマ（`migrations/0041_game_deletion.sql`。#516 / M15-1）。
 *
 * **列と索引があることより、被参照判定の実行計画が全走査にならないことを見る**
 * （`test/schema-in-flight.test.ts` と同じ考え方。索引の存在の検査は、索引を使えない形に
 * 問い合わせを書き換えても通る）。判定は削除のたびに走り、候補のキーは版の数の 2 倍ある。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * 実行計画を 1 行の文字列にする（`test/schema-in-flight.test.ts` と同じ形）。
 *
 * @param sql 実行する文
 * @param binds 束縛する値
 * @returns `EXPLAIN QUERY PLAN` の detail を連ねたもの
 */
async function planOf(sql: string, binds: readonly unknown[]): Promise<string> {
  const plan = await env.DB.prepare(`explain query plan ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(' | ');
}

describe('games の 2 列（0041）', () => {
  it('deletion_started_at と purged_at は INTEGER で、既定は NULL である', async () => {
    const columns = await env.DB.prepare(
      "select name, type, \"notnull\" as not_null, dflt_value from pragma_table_info('games') where name in ('deletion_started_at', 'purged_at') order by name",
    ).all<{ name: string; type: string; not_null: number; dflt_value: string | null }>();
    expect(columns.results).toEqual([
      { name: 'deletion_started_at', type: 'INTEGER', not_null: 0, dflt_value: null },
      { name: 'purged_at', type: 'INTEGER', not_null: 0, dflt_value: null },
    ]);
  });
});

describe('版の表のキーの索引（0041）', () => {
  it('game_revisions の source_key と wasm_key に 1 本ずつ索引がある（部分索引ではない）', async () => {
    const rows = await env.DB.prepare(
      "select name, sql from sqlite_master where type = 'index' and tbl_name = 'game_revisions' and name like 'game_revisions_%_key_idx' order by name",
    ).all<{ name: string; sql: string }>();
    expect(rows.results.map((row) => row.name)).toEqual([
      'game_revisions_source_key_idx',
      'game_revisions_wasm_key_idx',
    ]);
    for (const row of rows.results) {
      expect(row.sql.toLowerCase()).not.toContain(' where ');
    }
  });

  it('被参照判定の文は games も game_revisions も全走査しない', async () => {
    // **実装が返す文をそのまま掛ける**（書き写さない）。
    const id = 'plan-game';
    const detail = await planOf(artifactDeletionPlanSql(), [id, id, id, id, id, id]);
    // 参照者の数え: キーの索引（0004 / 0041）を `or` で使う。
    expect(detail, detail).toMatch(/SEARCH g USING (?:COVERING )?INDEX games_source_key_idx/u);
    expect(detail, detail).toMatch(/SEARCH g USING (?:COVERING )?INDEX games_wasm_key_idx/u);
    expect(detail, detail).toMatch(/SEARCH r USING (?:COVERING )?INDEX game_revisions_source_key_idx/u);
    expect(detail, detail).toMatch(/SEARCH r USING (?:COVERING )?INDEX game_revisions_wasm_key_idx/u);
    // 候補の収集: 主キーから入る。
    expect(detail, detail).toMatch(/SEARCH game_revisions USING (?:COVERING )?INDEX \S+ \(game_id=\?\)/u);
    // 索引を使わない `SCAN games` / `SCAN game_revisions` / `SCAN g` / `SCAN r` が出たら全走査である。
    expect(detail, detail).not.toMatch(/SCAN (?:games|game_revisions|g|r)(?! USING)\b/u);
  });
});
