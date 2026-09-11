import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 表示名を決めた時刻の列（0022 / #341 / 仕様 5.1・5.9）。
 *
 * **`test/schema.test.ts` とは別のファイルに置く。** あちらは並行するレーンがそれぞれ
 * マイグレーションを足すたびに追記する場所で、同じファイルを 2 レーンが所有すると
 * 衝突する（`docs/handoff.md` 4 章）。検査の中身は同じ流儀に揃えてある。
 */

beforeAll(async () => {
  await applySchema();
});

describe('表示名を決めた時刻（0022 / #341）', () => {
  it('users に display_name_set_at がある（INTEGER・NULL を許す）', async () => {
    const columns = await env.DB.prepare('select * from pragma_table_info(?)')
      .bind('users')
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    const found = columns.results.find((row) => row.name === 'display_name_set_at');
    expect(found, 'users.display_name_set_at').toBeDefined();
    // **時刻はすべて UNIX 秒の INTEGER で持つ**（0001 の冒頭）。
    expect(found?.type).toBe('INTEGER');
    // NULL が「Google の表示名に追随する」を意味する（5.9）。NOT NULL にすると
    // 既存の行へ値を埋めることになり、全員が「決めた」扱いになる。
    expect(found?.notnull).toBe(0);
    expect(found?.dflt_value).toBeNull();
  });

  it('列を指定せずに作った利用者は NULL で始まる（Google に追随する）', async () => {
    // ログインの経路（`src/auth/google.ts` の `createUser`）はこの列を書かない。
    // **新規の利用者も、既存の利用者と同じく追随から始まる。**
    const id = `schema-name-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, '名前')
      .run();
    const row = await env.DB.prepare('select display_name_set_at from users where id = ?')
      .bind(id)
      .first<{ display_name_set_at: number | null }>();
    expect(row?.display_name_set_at).toBeNull();
  });

  it('索引を張っていない（読むのは 1 行へ絞った後だけ。3.6）', async () => {
    // 張ると、変更のたびに索引の書き込みが 1 行増える（3.6「索引込みで見積もる」）。
    // 必要とする問い合わせが来たら張る（0001 の冒頭の規約）。
    const indexes = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and tbl_name = 'users'",
    ).all<{ name: string }>();
    for (const { name } of indexes.results) {
      const info = await env.DB.prepare('select name from pragma_index_info(?)')
        .bind(name)
        .all<{ name: string }>();
      expect(
        info.results.map((column) => column.name),
        `${name} が display_name_set_at を含んでいます`,
      ).not.toContain('display_name_set_at');
    }
  });
});
