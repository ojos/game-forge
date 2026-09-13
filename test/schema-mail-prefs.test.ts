import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 改造通知を受け取らない設定の列（`migrations/` の fork_notice_mute / #384 / 仕様 5.11）。
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

describe('users.fork_notice_muted_at（#384）', () => {
  it('INTEGER で NULL を許し、既定値を持たない', async () => {
    const columns = await env.DB.prepare('select * from pragma_table_info(?)').bind('users').all<ColumnInfo>();
    const column = columns.results.find((row) => row.name === 'fork_notice_muted_at');
    // **時刻（UNIX 秒）で持つ**——受け取る設定へ戻す間隔の判定に要るのは止めた時刻そのもの。
    expect(column).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
  });

  it('列を指定せずに作った利用者は NULL（受け取る）で始まる', async () => {
    // **既定は受け取る**（5.11「既存の利用者の挙動を黙って変えない」）。`src/auth/google.ts` の
    // 新規登録は列を名指しして INSERT し、この列を書かない。
    const id = `schema-mail-prefs-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, '名前')
      .run();
    const row = await env.DB.prepare('select fork_notice_muted_at from users where id = ?')
      .bind(id)
      .first<{ fork_notice_muted_at: number | null }>();
    expect(row).toEqual({ fork_notice_muted_at: null });
  });

  it('列に索引を張らない（引き方は主キーだけ）', async () => {
    const indexes = await env.DB.prepare(
      `select il.name as name
         from pragma_index_list('users') as il
         join pragma_index_info(il.name) as ii
        where ii.name = 'fork_notice_muted_at'`,
    ).all<{ name: string }>();
    expect(indexes.results).toEqual([]);
  });
});
