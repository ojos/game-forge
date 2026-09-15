import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 同じ条件式で読むキーの組の列（`migrations/0043_source_input_keys_alias_groups.sql` / #543）の形を確かめる。
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

describe('同じ条件式で読むキーの組の列（0043 / #543）', () => {
  it('source_input_keys に alias_groups がある（TEXT / NULL 可 / 既定値なし）', async () => {
    const columns = await env.DB.prepare('pragma table_info(source_input_keys)').all<ColumnInfo>();
    const column = columns.results.find((row) => row.name === 'alias_groups');
    expect(column, 'source_input_keys.alias_groups').toBeDefined();
    expect(column!.type).toBe('TEXT');
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();
  });

  it('列を指定しない書き込み（#529 の今の UPSERT はこの列を指定しない）では NULL になる', async () => {
    // **NULL は「同じ条件式で読むキーの組がまだ記録されていない」を意味する**（0043 の冒頭）。#543 の実装が入るまでの
    // 書き込みはこの列を書かないので、規則の版 2 以下の行として NULL が残り、3.9.6 の今の規則 5 のとおり方向をボタンに回す。
    const sourceKey = `builds/${'b'.repeat(64)}/source.go`;
    await env.DB.prepare(
      'insert into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, ?, ?)',
    )
      .bind(sourceKey, '["ArrowLeft"]', 2, 1)
      .run();
    const row = await env.DB.prepare('select alias_groups from source_input_keys where source_key = ?')
      .bind(sourceKey)
      .first<{ alias_groups: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.alias_groups).toBeNull();
  });
});
