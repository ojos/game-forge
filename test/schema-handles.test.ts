import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLE_CHANGES_TABLE, HANDLES_TABLE } from '../src/handle.js';
import { HANDLE_PATTERN } from '../src/handle-paths.js';
import { authorHandleColumnSql } from '../src/handle-sql.js';
import { applySchema } from './helpers/schema.js';

/**
 * ハンドル名の表と、変更の履歴の表（`migrations/` の user_handles / #381 / 仕様 5.10）。
 *
 * **`test/schema.test.ts` とは別のファイルに置く**（並行するレーンがそれぞれマイグレーションを足すたびに
 * 追記する場所で、同じファイルを 2 レーンが所有すると衝突する。`docs/handoff.md` 4 章）。
 * **マイグレーションの番号をここに書かない**（取り込みの順で振り直すことがある）。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `schema-handles-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, '名前')
    .run();
  return id;
}

/**
 * 表へ 1 行入れてみて、入ったかを返す（CHECK の検査用）。
 *
 * @param handle 入れるハンドル名
 * @returns 入れば true
 */
async function accepts(handle: string): Promise<boolean> {
  const userId = await seedUser();
  try {
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 1)`)
      .bind(handle, userId)
      .run();
    return true;
  } catch {
    return false;
  }
}

describe('handles の形', () => {
  it('ハンドル名の CHECK は、コードの形（HANDLE_PATTERN）と同じ入力を通し、同じ入力を断る', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    for (const handle of [
      `ok_${suffix}`,
      `abc${suffix}`.slice(0, 3),
      `a${suffix}`.padEnd(20, '9'),
      `Upper${suffix}`,
      `ab`,
      `a${suffix}`.padEnd(21, '9'),
      `has-dash${suffix}`,
      `ｆｕｌｌ${suffix}`,
      `zero\u200bwidth${suffix}`,
      `dot.${suffix}`,
    ]) {
      expect(await accepts(handle), JSON.stringify(handle)).toBe(HANDLE_PATTERN.test(handle));
    }
  });

  it('主キーはハンドル名で、同じ名前は現役と予約中を合わせて 1 行しか入らない', async () => {
    const handle = `pk_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const first = await seedUser();
    const second = await seedUser();
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at, released_at) values (?, ?, 1, 2)`)
      .bind(handle, first)
      .run();
    await expect(
      env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 3)`)
        .bind(handle, second)
        .run(),
    ).rejects.toThrow(`UNIQUE constraint failed: ${HANDLES_TABLE}.handle`);
  });

  it('利用者ごとに、いま使っているハンドル名は 1 つだけ入る（予約中はいくつでも）', async () => {
    const userId = await seedUser();
    const name = (label: string): string => `${label}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at, released_at) values (?, ?, 1, 5)`)
      .bind(name('r1'), userId)
      .run();
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at, released_at) values (?, ?, 1, 6)`)
      .bind(name('r2'), userId)
      .run();
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 7)`)
      .bind(name('c1'), userId)
      .run();
    await expect(
      env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 8)`)
        .bind(name('c2'), userId)
        .run(),
    ).rejects.toThrow('UNIQUE constraint failed');
  });

  it('時刻は 0 より大きく、手放した時刻は取った時刻より前にならない', async () => {
    const userId = await seedUser();
    const name = `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await expect(
      env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 0)`)
        .bind(name, userId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at, released_at) values (?, ?, 10, 9)`)
        .bind(name, userId)
        .run(),
    ).rejects.toThrow();
  });

  it('利用者の行を指す外部キーを持つ', async () => {
    for (const table of [HANDLES_TABLE, HANDLE_CHANGES_TABLE]) {
      const keys = await env.DB.prepare(`pragma foreign_key_list(${table})`).all<{
        table: string;
        from: string;
        to: string;
      }>();
      expect(keys.results, table).toHaveLength(1);
      expect(keys.results[0], table).toMatchObject({ table: 'users', from: 'user_id', to: 'id' });
    }
  });
});

describe('handle_changes の形（#405 の申し送り）', () => {
  it('(user_id, changed_at) の索引を持ち、changed_at は 0 より大きい', async () => {
    const index = await env.DB.prepare(
      "select name from pragma_index_info('handle_changes_user_changed_idx') order by seqno",
    ).all<{ name: string }>();
    expect(index.results.map((row) => row.name)).toEqual(['user_id', 'changed_at']);

    const userId = await seedUser();
    await expect(
      env.DB.prepare(
        `insert into ${HANDLE_CHANGES_TABLE} (id, user_id, old_handle, new_handle, changed_at) values (?, ?, null, 'abc', 0)`,
      )
        .bind(crypto.randomUUID(), userId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `insert into ${HANDLE_CHANGES_TABLE} (id, user_id, old_handle, new_handle, changed_at) values (?, ?, 'ABC', 'abc', 1)`,
      )
        .bind(crypto.randomUUID(), userId)
        .run(),
    ).rejects.toThrow();
  });
});

describe('一覧の SQL が引くハンドル名', () => {
  it('部分索引の 1 行を引き、表を素で走らない', async () => {
    const plan = await env.DB.prepare(
      `explain query plan select ${authorHandleColumnSql('u.id')} from users u where u.id = ?`,
    )
      .bind('nobody')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join('\n');
    expect(detail, detail).toContain('handles_user_current_idx');
    expect(detail, detail).not.toMatch(/SCAN hh(?! USING)/u);
  });

  it('予約中の旧いハンドル名は引かない', async () => {
    const userId = await seedUser();
    const released = `rel_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at, released_at) values (?, ?, 1, 2)`)
      .bind(released, userId)
      .run();
    const before = await env.DB.prepare(`select ${authorHandleColumnSql('u.id')} from users u where u.id = ?`)
      .bind(userId)
      .first<{ author_handle: string | null }>();
    expect(before).toEqual({ author_handle: null });

    const current = `cur_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 3)`)
      .bind(current, userId)
      .run();
    const after = await env.DB.prepare(`select ${authorHandleColumnSql('u.id')} from users u where u.id = ?`)
      .bind(userId)
      .first<{ author_handle: string | null }>();
    expect(after).toEqual({ author_handle: current });
  });
});
