import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 作品の論理解像度の列（`migrations/0044_source_input_keys_layout.sql` / #514）の形を確かめる。
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

describe('作品の論理解像度の列（0044 / #514）', () => {
  it('source_input_keys に layout_width と layout_height がある（INTEGER / NULL 可 / 既定値なし）', async () => {
    const columns = await env.DB.prepare('pragma table_info(source_input_keys)').all<ColumnInfo>();
    for (const name of ['layout_width', 'layout_height']) {
      const column = columns.results.find((row) => row.name === name);
      expect(column, `source_input_keys.${name}`).toBeDefined();
      expect(column!.type).toBe('INTEGER');
      expect(column!.notnull).toBe(0);
      expect(column!.dflt_value).toBeNull();
    }
  });

  it('列を指定しない書き込み（今の UPSERT はこの列を指定しない）では、どちらも NULL になる', async () => {
    // **NULL は「解像度が分からない」を意味する**（0044 の冒頭）。#514 の実装が入るまでの書き込みはこの列を書かないので、
    // 規則の版 3 以下の行として NULL が残り、仕様 3.9.4 のとおり向きの操作をしない。
    const sourceKey = `builds/${'c'.repeat(64)}/source.go`;
    await env.DB.prepare(
      'insert into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, ?, ?)',
    )
      .bind(sourceKey, '["ArrowLeft"]', 3, 1)
      .run();
    const row = await env.DB.prepare('select layout_width, layout_height from source_input_keys where source_key = ?')
      .bind(sourceKey)
      .first<{ layout_width: number | null; layout_height: number | null }>();
    expect(row).not.toBeNull();
    expect(row!.layout_width).toBeNull();
    expect(row!.layout_height).toBeNull();
  });
});
