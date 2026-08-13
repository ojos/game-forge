import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/** 5.1 の 5 テーブルと、#14 の待機リスト。 */
const EXPECTED_TABLES = [
  'users',
  'invites',
  'games',
  'generations',
  'reports',
  'waitlist',
] as const;

/**
 * D1 のカタログからオブジェクト名を引く。
 *
 * @param type `table` か `index`
 * @returns 名前の配列
 */
async function catalogNames(type: 'table' | 'index'): Promise<string[]> {
  const result = await env.DB.prepare('select name from sqlite_master where type = ?')
    .bind(type)
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

beforeAll(async () => {
  await applySchema();
});

describe('マイグレーションの適用（#11 acceptance 1）', () => {
  it('二度目の適用が何もせずに成功する', async () => {
    // 冪等性は SQL の `IF NOT EXISTS` ではなく `d1_migrations` 台帳が担保する。
    // ここが落ちるとしたら台帳が記録されておらず、CREATE TABLE が再実行されている。
    await expect(applySchema()).resolves.toBeUndefined();
    await expect(applySchema()).resolves.toBeUndefined();
  });

  it('適用済みの一覧が台帳へ記録されている', async () => {
    const row = await env.DB.prepare('select count(*) as applied from d1_migrations').first<{
      applied: number;
    }>();
    expect(row?.applied).toBe(1);
  });
});

describe('テーブルとインデックスの存在（#11 acceptance 2）', () => {
  it('5.1 の 5 テーブルと waitlist が存在する', async () => {
    const tables = await catalogNames('table');
    for (const expected of EXPECTED_TABLES) {
      expect(tables, expected).toContain(expected);
    }
  });

  it('games.parent_id にインデックスがある', async () => {
    // 5.5 の「この作品からの改造 N 件」を引くためのもので、5.1 が明示的に要求する。
    const indexes = await catalogNames('index');
    expect(indexes).toContain('games_parent_id_idx');

    const info = await env.DB.prepare('select * from pragma_index_info(?)')
      .bind('games_parent_id_idx')
      .all<{ name: string }>();
    expect(info.results.map((row) => row.name)).toEqual(['parent_id']);
  });

  it('invites.issued_by にインデックスがある', async () => {
    // 招待枠の残数管理（#13）が「発行者ごとの発行済み件数」を数える。
    const indexes = await catalogNames('index');
    expect(indexes).toContain('invites_issued_by_idx');
  });
});

/**
 * テスト用の利用者を 1 行作る。
 *
 * テストごとに固有の id を渡して自己完結させる。前のテストが入れた行に依存すると、
 * 単体で実行したとき（`vitest run -t ...`）に、行が無いことを理由に落ちる。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作成した利用者の id
 */
async function insertUser(suffix: string): Promise<string> {
  const id = `u-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${suffix}`, `${suffix}@example.com`, suffix)
    .run();
  return id;
}

describe('列と制約', () => {
  it('users.google_sub が一意である', async () => {
    // 5.1 の「一意」。email は変わりうるため、同一性の判定はこちらで行う。
    await insertUser('unique-sub');
    await expect(
      env.DB.prepare(
        'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
      )
        .bind('u-unique-sub-2', 'sub-unique-sub', 'other@example.com', 'other')
        .run(),
    ).rejects.toThrow();
  });

  it('games.status が draft / published / removed だけを受け付ける', async () => {
    const authorId = await insertUser('status');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-status', authorId, 'draft', 'T', 'go1.25.0')
      .run();
    await expect(
      env.DB.prepare(
        'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
      )
        .bind('g-status-2', authorId, 'archived', 'T', 'go1.25.0')
        .run(),
    ).rejects.toThrow();
  });

  it('games.fork_count が既定で 0 になる', async () => {
    // 非正規化列（5.1）。既定値が無いと、作成側が毎回 0 を書く必要が出る。
    const authorId = await insertUser('fork-count');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-fork-count', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    const row = await env.DB.prepare('select fork_count from games where id = ?')
      .bind('g-fork-count')
      .first<{ fork_count: number }>();
    expect(row?.fork_count).toBe(0);
  });

  it('generations が usage の 4 種を持つ', async () => {
    // 4.1.1 / 4.5。prompt caching の効きを見るために別々に持つ。
    const columns = await env.DB.prepare('select * from pragma_table_info(?)')
      .bind('generations')
      .all<{ name: string }>();
    const names = columns.results.map((row) => row.name);
    for (const expected of [
      'input_tokens',
      'output_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('waitlist.email が一意である', async () => {
    // 同じ人が何度押しても登録数が増えないようにする（10.2 の登録率の分子）。
    await env.DB.prepare('insert into waitlist (id, email, created_at) values (?, ?, 1)')
      .bind('w-unique', 'waitlist-unique@example.com')
      .run();
    await expect(
      env.DB.prepare('insert into waitlist (id, email, created_at) values (?, ?, 1)')
        .bind('w-unique-2', 'waitlist-unique@example.com')
        .run(),
    ).rejects.toThrow();
  });

  it('時刻の列が INTEGER である', async () => {
    // UNIX 秒で揃える。文字列の日時にすると比較のたびに変換が要り、境界の扱いが
    // 実装ごとにぶれる（招待コード・セッションの失効判定と揃えている）。
    for (const [table, column] of [
      ['users', 'created_at'],
      ['invites', 'expires_at'],
      ['games', 'published_at'],
      ['generations', 'created_at'],
      ['reports', 'created_at'],
      ['waitlist', 'created_at'],
    ] as const) {
      const columns = await env.DB.prepare('select * from pragma_table_info(?)')
        .bind(table)
        .all<{ name: string; type: string }>();
      const found = columns.results.find((row) => row.name === column);
      expect(found?.type, `${table}.${column}`).toBe('INTEGER');
    }
  });
});
