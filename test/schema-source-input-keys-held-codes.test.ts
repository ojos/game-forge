import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 押し続けて読むキーの列（`migrations/0042_source_input_keys_held_codes.sql` / #528 / #529）の形を確かめる。
 *
 * **`test/schema.test.ts` と分けている。** 並列作業で同じ波の複数レーンがマイグレーションやスキーマの検査を
 * 足しうるので、1 つのファイルを複数の作業の所有にしない（`test/schema-operator.test.ts` と同じ理由）。
 *
 * # この検査が確かめないこと
 *
 * **見ているのはテスト用 D1 の列の形であって、本番に適用されていることではない。** 本番への適用は
 * `scripts/check-migrations-applied.sh --remote` と deploy の関門が見る。
 */

beforeAll(async () => {
  await applySchema();
});

/** `pragma table_info` の 1 行。 */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

describe('押し続けて読むキーの列（0042 / #529）', () => {
  it('source_input_keys に held_codes がある（TEXT / NULL 可 / 既定値なし）', async () => {
    const columns = await env.DB.prepare('pragma table_info(source_input_keys)').all<ColumnInfo>();
    const column = columns.results.find((row) => row.name === 'held_codes');
    expect(column, 'source_input_keys.held_codes').toBeDefined();
    expect(column!.type).toBe('TEXT');
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();
  });

  it('列を指定しない書き込み（#493 の今の UPSERT と同じ形）では NULL になる', async () => {
    // **NULL は「押し続けて読むキーがまだ記録されていない」を意味する**（0042 の冒頭）。#529 が入るまでの
    // 書き込みはこの列を書かないので、規則の版 1 の行として NULL が残り、3.9.6 の規則 6 で十字になる。
    const sourceKey = `builds/${'a'.repeat(64)}/source.go`;
    await env.DB.prepare(
      'insert into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, ?, ?)',
    )
      .bind(sourceKey, '["ArrowLeft"]', 1, 1)
      .run();
    const row = await env.DB.prepare('select held_codes from source_input_keys where source_key = ?')
      .bind(sourceKey)
      .first<{ held_codes: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.held_codes).toBeNull();
  });
});
