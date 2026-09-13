import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './helpers/schema.js';

/**
 * `admin_actions` の作り直し（`migrations/0031_admin_actions_takedown.sql` / #406）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ別のファイルに置くのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **この検査は `admin_actions` を実際に消して作り直す。** ほかの検査と同じファイルに置くと、
 * 作り直しの途中の状態を別の検査が読む余地が生まれる。ファイルを分ければ D1 の状態も分かれる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 確かめ方
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **テストの D1 は空の状態でマイグレーションが流れる**ので、適用の瞬間には移す行が無い。
 * そこで **0031 の SQL そのものを取り出し、行を入れた表へもう 1 度流す**
 * （`test/schema-admin.test.ts` が 0025 の ALTER を当て直しているのと同じ形。期待する定義を
 * テストへ書き写すと、0031 を書き換えた日にこの検査だけが古くなる）。
 *
 * **もう 1 度流してよいのは、0031 が「作り直した表をもう 1 度作り直す」だけの手順だから
 * である。** 作り直しの前後で列も CHECK も索引も同じなので、2 回目は 1 回目と同じ形に落ちる。
 *
 * 見ること:
 *
 *   1. **行が 1 つも失われず、全列が一致する**
 *   2. **rowid が保たれる**（同じ秒の並びを `rowid desc` で決めている。0031 の「rowid を写す」）
 *   3. **索引（`admin_actions_target_idx`）が同じ列の順で張り直されている**（0029）
 *   4. **既存の綴りも新しい綴りも入り、`game-removed` は入らない**
 */

/** 移す前後で比べる 1 行。 */
interface HistoryRow {
  readonly rowid: number;
  readonly id: string;
  readonly actor_id: string;
  readonly created_at: number;
  readonly action: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly reason: string;
}

/** 仕込む管理者。 */
let adminId = '';

/**
 * 0031 の文を取り出す。
 *
 * @returns 準備済みの文（ファイルの順）
 */
function rebuildStatements(): D1PreparedStatement[] {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0031_'));
  expect(migration, '0031 のマイグレーション').toBeDefined();
  return migration!.queries.map((query) => env.DB.prepare(query));
}

/**
 * 全行を rowid の順に読む。
 *
 * @returns 行
 */
async function readAll(): Promise<HistoryRow[]> {
  const rows = await env.DB.prepare(
    `select rowid, id, actor_id, created_at, action, target_kind, target_id, reason
       from admin_actions order by rowid`,
  ).all<HistoryRow>();
  return rows.results;
}

beforeAll(async () => {
  await applySchema();
  adminId = `rebuild-admin-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, is_admin)
     values (?, ?, ?, '作り直しの管理者', 1, 1)`,
  )
    .bind(adminId, `sub-${adminId}`, `${adminId}@example.test`)
    .run();
});

describe('admin_actions の作り直し（0031 / #406）', () => {
  it('行と rowid を保ち、索引を張り直す', async () => {
    // **同じ秒の行を、rowid の順と id の順が食い違うように入れる。** rowid を写さない
    // 作り直しは、SELECT が返した順で振り直すので、ここで前後が入れ替わりうる。
    const inserts = [
      ['zzzz', 'review-queued', 'game', 'g-1', '1 行目'],
      ['aaaa', 'review-cleared', 'game', 'g-1', '2 行目'],
      ['mmmm', 'user-banned', 'user', 'u-1', '3 行目'],
      ['bbbb', 'takedown-rejected', 'takedown', 't-1', '4 行目'],
    ];
    await env.DB.batch(
      inserts.map(([id, action, kind, target, reason]) =>
        env.DB.prepare(
          `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
           values (?, ?, 1700000000, ?, ?, ?, ?)`,
        ).bind(id, adminId, action, kind, target, reason),
      ),
    );
    // **rowid に隙間を作る。** 連番のままだと、写さずに振り直しても同じ値になり、検査が
    // 空振りする。
    await env.DB.prepare("delete from admin_actions where id = 'aaaa'").run();
    await env.DB.prepare(
      `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
       values ('cccc', ?, 1700000000, 'user-unbanned', 'user', 'u-1', '5 行目')`,
    )
      .bind(adminId)
      .run();
    const before = await readAll();
    expect(before.map((row) => row.rowid)).not.toEqual([1, 2, 3, 4]);

    await env.DB.batch(rebuildStatements());

    expect(await readAll()).toEqual(before);

    const index = await env.DB.prepare(
      "select sql from sqlite_master where type = 'index' and name = 'admin_actions_target_idx'",
    ).first<{ sql: string }>();
    expect(index, '索引が張り直されていない').not.toBeNull();
    expect(index!.sql.replace(/\s+/gu, ' ')).toContain(
      'admin_actions (target_kind, target_id, action, created_at)',
    );

    // **作業用の表が残っていない。**
    const leftover = await env.DB.prepare(
      "select name from sqlite_master where name = 'admin_actions_new'",
    ).first();
    expect(leftover).toBeNull();
  });

  it('作り直した表は、既存の綴りも措置の綴りも受け付け、game-removed は受け付けない', async () => {
    const insert = (action: string, kind: string) =>
      env.DB.prepare(
        `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
         values (?, ?, 1, ?, ?, 'x', '理由')`,
      )
        .bind(crypto.randomUUID(), adminId, action, kind)
        .run();

    await expect(insert('review-cleared', 'game')).resolves.toBeDefined();
    await expect(insert('user-banned', 'user')).resolves.toBeDefined();
    for (const action of ['takedown-removed', 'takedown-restricted', 'takedown-rejected']) {
      await expect(insert(action, 'takedown'), action).resolves.toBeDefined();
    }
    // **取り下げは画面に置かない操作のまま**（2.4.3 / 0026）。
    await expect(insert('game-removed', 'game')).rejects.toThrow();
    await expect(insert('review-queued', 'report')).rejects.toThrow();
  });
});
