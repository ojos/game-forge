import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 管理権限の列（`migrations/0025_users_is_admin.sql` / #356 / 仕様 2.4.2）の形を確かめる。
 *
 * **`test/schema.test.ts` と分けている。** 同じ波の複数レーンがマイグレーションを足して
 * おり、1 つのファイルを 2 レーンの所有にすると衝突の余地が生まれる
 * （`docs/handoff.md` 4 章「所有ファイルを重ねない」。0021 の `test/schema-operator.test.ts`
 * が同じ理由で分かれている）。
 *
 * # この検査が確かめないこと
 *
 * **見ているのはテスト用 D1 の列の形であって、本番の行に 1 が立っていることではない。**
 * 本番で管理者のフラグが失われても（行の作り直し・誤った UPDATE・復元）、
 * **この検査はすべて緑のまま通る**——D1 の行データに機械照合は置けない
 * （`docs/admin-host.md` の「限界」）。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * `users` を 1 行入れる。**`is_admin` を指定しない**（既定値の検査に使うため）。
 *
 * 列の並びは `src/auth/google.ts` の `createUser` と同じく名指しである。あちらが
 * この列を書かないことが、**新しく登録した人が管理画面へ入れない唯一の根拠**なので、
 * ここも同じ形で入れて既定値を見る。
 *
 * @param id 利用者の id
 */
async function insertUser(id: string): Promise<void> {
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
}

/** `pragma table_info` の 1 行。 */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

describe('管理権限の列（0025 / #356）', () => {
  it('users に is_admin がある（INTEGER / NOT NULL / 既定 0）', async () => {
    const columns = await env.DB.prepare('pragma table_info(users)').all<ColumnInfo>();
    const column = columns.results.find((row) => row.name === 'is_admin');
    expect(column, 'users.is_admin').toBeDefined();
    expect(column!.type).toBe('INTEGER');
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe('0');
  });

  it('指定せずに作った利用者は 0 になる（ログインで作られる行と同じ形）', async () => {
    // **既定が 0 であることが、この機構の安全性そのものである。** 既定が 1 だったり
    // NULL 許容だったりすると、新しく登録した人が管理画面へ入れる。
    await insertUser('admin-default');
    const row = await env.DB.prepare('select is_admin from users where id = ?')
      .bind('admin-default')
      .first<{ is_admin: number }>();
    expect(row?.is_admin).toBe(0);
  });

  it('0 と 1 だけを受け付ける（人の手で書く列なので、綴り違いを書いた瞬間に弾く）', async () => {
    // **画面から管理者を増やす経路は作らない**（2.4.2）。この列を書くのは人の手であり、
    // `set is_admin = 'yes'` や `= 2` を書いた瞬間に弾く必要がある。
    await insertUser('admin-check');
    const update = (value: unknown): Promise<D1Result> =>
      env.DB.prepare('update users set is_admin = ? where id = ?')
        .bind(value, 'admin-check')
        .run();

    await expect(update(1)).resolves.toBeDefined();
    await expect(update(0)).resolves.toBeDefined();
    for (const bad of [2, -1, 'yes', null]) {
      await expect(update(bad), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it('運営フラグ（is_operator）とは別の列である（#334 / 2.4.2 の決定を保つ）', async () => {
    // **一体にすると、後から分けられない**（0025 の冒頭）。「バッジを出したい人」と
    // 「他人のアカウントを止められる人」が別の集合であることを、**列が 2 本あることで
    // 機械的に保つ。** 片方を立てても、もう片方は 0 のままであることまで見る。
    const columns = await env.DB.prepare('pragma table_info(users)').all<ColumnInfo>();
    const names = columns.results.map((row) => row.name);
    expect(names).toContain('is_admin');
    expect(names).toContain('is_operator');

    await insertUser('admin-not-operator');
    await env.DB.prepare('update users set is_admin = 1 where id = ?')
      .bind('admin-not-operator')
      .run();
    const row = await env.DB.prepare('select is_admin, is_operator from users where id = ?')
      .bind('admin-not-operator')
      .first<{ is_admin: number; is_operator: number }>();
    // **運営フラグは立たない。** 導出でも同期でもなく、独立した 2 本である。
    expect(row).toEqual({ is_admin: 1, is_operator: 0 });
  });

  it('適用時に既にある行は 0 で埋まる（既存の利用者の振る舞いを変えない）', async () => {
    // **テストの D1 は空の状態でマイグレーションが流れる**ので、適用の瞬間には 1 行も
    // 埋まらない。**0025 の SQL そのものを取り出し、行がある表へ当てて回す**
    // （`test/schema-operator.test.ts` が 0021 で、`test/schema.test.ts` が 0013 で
    // 使っているのと同じ形。期待する定義をテストへ書き写すと、0025 を書き換えた日に
    // この検査だけが古くなる）。
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0025_'));
    expect(migration, '0025 のマイグレーション').toBeDefined();
    const alter = migration!.queries.find((query) =>
      /alter\s+table\s+users\s+add\s+column\s+is_admin/iu.test(query),
    );
    expect(alter, '0025 の ALTER 文').toBeDefined();
    // **行コメントを落としてから 1 行へ潰す。** `exec` は文を 1 行で受け取るので、
    // `--` を残したまま改行を消すと文全体がコメントになり、何も実行せずに緑になる。
    const sql = alter!
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();

    // 本物の `users` には既に列がある。**同じ文を、0025 より前の形の表へ向け直す。**
    // 向け直しが当たったことを先に確かめる（当たらなければ本物の `users` へ 2 度目の
    // ALTER が飛び、別の理由で落ちる）。
    const probe = 'users_before_0025';
    const retargeted = sql.replace(/^alter table users /iu, `ALTER TABLE ${probe} `);
    expect(retargeted, '表名の向け直しが当たっていない').not.toBe(sql);

    await env.DB.exec(`CREATE TABLE ${probe} (id TEXT PRIMARY KEY, is_operator INTEGER NOT NULL)`);
    try {
      await env.DB.prepare(`insert into ${probe} (id, is_operator) values ('a', 1), ('b', 0)`).run();

      await env.DB.exec(retargeted);

      const rows = await env.DB.prepare(`select id, is_admin from ${probe} order by id`).all<{
        id: string;
        is_admin: number;
      }>();
      // **運営フラグが立っている行も 0 である。** 埋め戻しは他の列から何も導かない
      // ——既にある運営アカウントが、この列を足しただけで管理者になってはいけない。
      expect(rows.results).toEqual([
        { id: 'a', is_admin: 0 },
        { id: 'b', is_admin: 0 },
      ]);
    } finally {
      await env.DB.exec(`DROP TABLE ${probe}`);
    }
  });
});
