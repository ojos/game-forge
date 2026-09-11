import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * 運営フラグの列（`migrations/0021_users_operator.sql` / #334）の形を確かめる。
 *
 * **`test/schema.test.ts` と分けている。** 並列作業で同じ波の複数レーンがマイグレーションを
 * 足しており、1 つのファイルを 2 レーンの所有にすると衝突の余地が生まれる
 * （`docs/handoff.md` 4 章「所有ファイルを重ねない」）。
 *
 * # この検査が確かめないこと
 *
 * **見ているのはテスト用 D1 の列の形であって、本番の行に 1 が立っていることではない。**
 * 本番で運営アカウントのフラグが失われても（行の作り直し・誤った UPDATE・復元）、
 * **この検査はすべて緑のまま通る**——D1 の行データは機械照合を置けない
 * （`docs/operator-account.md` の「限界」）。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * `users` を 1 行入れる。**`is_operator` を指定しない**（既定値の検査に使うため）。
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

describe('運営フラグの列（0021 / #334）', () => {
  it('users に is_operator がある（INTEGER / NOT NULL / 既定 0）', async () => {
    const columns = await env.DB.prepare('pragma table_info(users)').all<ColumnInfo>();
    const column = columns.results.find((row) => row.name === 'is_operator');
    expect(column, 'users.is_operator').toBeDefined();
    expect(column!.type).toBe('INTEGER');
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe('0');
  });

  it('指定せずに作った利用者は 0 になる（ログインで作られる行と同じ形）', async () => {
    // `src/auth/google.ts` の `createUser` は列を名指しして INSERT し、この列を書かない。
    // **新しく登録した人が運営として出ないのは、既定値のおかげである。**
    await insertUser('operator-default');
    const row = await env.DB.prepare('select is_operator from users where id = ?')
      .bind('operator-default')
      .first<{ is_operator: number }>();
    expect(row?.is_operator).toBe(0);
  });

  it('0 と 1 だけを受け付ける（人の手で書く列なので、綴り違いを書いた瞬間に弾く）', async () => {
    await insertUser('operator-check');
    const update = (value: unknown): Promise<D1Result> =>
      env.DB.prepare('update users set is_operator = ? where id = ?')
        .bind(value, 'operator-check')
        .run();

    await expect(update(1)).resolves.toBeDefined();
    await expect(update(0)).resolves.toBeDefined();
    for (const bad of [2, -1, 'yes', null]) {
      await expect(update(bad), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it('適用時に既にある行は 0 で埋まる（既存の作者の表示を変えない）', async () => {
    // **テストの D1 は空の状態でマイグレーションが流れる**ので、適用の瞬間には
    // 1 行も埋まらない。**0021 の SQL そのものを取り出し、行がある表へ当てて回す**
    // （`test/schema.test.ts` が 0013 の埋め戻しを確かめているのと同じ形。期待する
    // 定義をテストへ書き写すと、0021 を書き換えた日にこの検査だけが古くなる）。
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0021_'));
    expect(migration, '0021 のマイグレーション').toBeDefined();
    const alter = migration!.queries.find((query) =>
      /alter\s+table\s+users\s+add\s+column\s+is_operator/iu.test(query),
    );
    expect(alter, '0021 の ALTER 文').toBeDefined();
    // **行コメントを落としてから 1 行へ潰す。** `exec` は文を 1 行で受け取るので、
    // `--` を残したまま改行を消すと文全体がコメントになり、何も実行せずに緑になる。
    const sql = alter!
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();

    // 本物の `users` には既に列がある。**同じ文を、0021 より前の形の表へ向け直す。**
    // 向け直しが当たったことを先に確かめる（当たらなければ本物の `users` へ 2 度目の
    // ALTER が飛び、別の理由で落ちる）。
    const probe = 'users_before_0021';
    const retargeted = sql.replace(/^alter table users /iu, `ALTER TABLE ${probe} `);
    expect(retargeted, '表名の向け直しが当たっていない').not.toBe(sql);

    await env.DB.exec(`CREATE TABLE ${probe} (id TEXT PRIMARY KEY, display_name TEXT NOT NULL)`);
    try {
      await env.DB.prepare(`insert into ${probe} (id, display_name) values ('a', '運営'), ('b', 'b')`).run();

      await env.DB.exec(retargeted);

      const rows = await env.DB.prepare(`select id, is_operator from ${probe} order by id`).all<{
        id: string;
        is_operator: number;
      }>();
      // **名前が「運営」の行も 0 である。** 列は名前から何も導かない。
      expect(rows.results).toEqual([
        { id: 'a', is_operator: 0 },
        { id: 'b', is_operator: 0 },
      ]);
    } finally {
      await env.DB.exec(`DROP TABLE ${probe}`);
    }
  });
});
