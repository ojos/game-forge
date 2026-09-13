import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_CHANGES_TABLE } from '../src/profile.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者のプロフィールの列と、変更の履歴の表（`migrations/` の user_profile / #379 / 仕様 5.10）。
 *
 * **`test/schema.test.ts` とは別のファイルに置く**（並行するレーンがそれぞれマイグレーションを
 * 足すたびに追記する場所で、同じファイルを 2 レーンが所有すると衝突する。`docs/handoff.md` 4 章）。
 * **マイグレーションの番号をここに書かない**（取り込みの順で振り直すことがある）。
 */

beforeAll(async () => {
  await applySchema();
});

/** `pragma_table_info` の 1 行。 */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

/**
 * 表の列を引く。
 *
 * @param table 表の名前
 * @returns 列の情報
 */
async function columnsOf(table: string): Promise<ColumnInfo[]> {
  const rows = await env.DB.prepare('select * from pragma_table_info(?)').bind(table).all<ColumnInfo>();
  return rows.results;
}

describe('users のプロフィールの列（#379）', () => {
  it('bio と profile_links は NOT NULL で空から始まり、profile_set_at は NULL を許す', async () => {
    const columns = await columnsOf('users');
    const find = (name: string): ColumnInfo | undefined => columns.find((column) => column.name === name);
    // **空を NULL にしない**（NULL との比較は常に NULL で、`bio <> ?` の変更の判定が当たらない）。
    expect(find('bio')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "''" });
    expect(find('profile_links')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'[]'" });
    // 時刻は UNIX 秒の INTEGER。NULL が「1 度も変えていない」。
    expect(find('profile_set_at')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    // **`x_handle` は消していない**（5.6 の決定を 5.10 の実装注記に残した）。
    expect(find('x_handle')).toBeDefined();
  });

  it('列を指定せずに作った利用者は、空の自己紹介と空のリンクの列で始まる', async () => {
    const id = `schema-profile-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, '名前')
      .run();
    const row = await env.DB.prepare('select bio, profile_links, profile_set_at from users where id = ?')
      .bind(id)
      .first<{ bio: string; profile_links: string; profile_set_at: number | null }>();
    expect(row).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
  });
});

describe('プロフィールの変更の履歴（#379 / #405 の申し送り）', () => {
  it('利用者の行を指す外部キーと、(user_id, changed_at) の索引を持つ', async () => {
    const keys = await env.DB.prepare(`pragma foreign_key_list(${PROFILE_CHANGES_TABLE})`).all<{
      table: string;
      from: string;
      to: string;
    }>();
    expect(keys.results).toHaveLength(1);
    expect(keys.results[0]).toMatchObject({ table: 'users', from: 'user_id', to: 'id' });

    const index = await env.DB.prepare(
      "select name from pragma_index_info('profile_changes_user_changed_idx') order by seqno",
    ).all<{ name: string }>();
    expect(index.results.map((row) => row.name)).toEqual(['user_id', 'changed_at']);
  });

  it('旧い値と新しい値の列を持ち、changed_at は 0 より大きい', async () => {
    const names = (await columnsOf(PROFILE_CHANGES_TABLE)).map((column) => column.name);
    expect(names).toEqual(['id', 'user_id', 'old_bio', 'new_bio', 'old_links', 'new_links', 'changed_at']);

    const id = `schema-profile-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, '名前')
      .run();
    await expect(
      env.DB.prepare(
        `insert into ${PROFILE_CHANGES_TABLE} (id, user_id, old_bio, new_bio, old_links, new_links, changed_at)
         values (?, ?, '', 'a', '[]', '[]', 0)`,
      )
        .bind(crypto.randomUUID(), id)
        .run(),
    ).rejects.toThrow();
  });

  it('users の行を消すときは、履歴を先に消せば消せる（cascade は書かない）', async () => {
    const id = `schema-profile-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, '名前')
      .run();
    await env.DB.prepare(
      `insert into ${PROFILE_CHANGES_TABLE} (id, user_id, old_bio, new_bio, old_links, new_links, changed_at)
       values (?, ?, '', 'a', '[]', '[]', 1)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();
    await expect(env.DB.prepare('delete from users where id = ?').bind(id).run()).rejects.toThrow();
    await env.DB.batch([
      env.DB.prepare(`delete from ${PROFILE_CHANGES_TABLE} where user_id = ?`).bind(id),
      env.DB.prepare('delete from users where id = ?').bind(id),
    ]);
    const left = await env.DB.prepare('select count(*) as n from users where id = ?').bind(id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
