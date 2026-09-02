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
    // **期待値を数字で書かない。** `migrations/` へ 1 本足すたびにここを直す運用は、
    // 直し忘れが「台帳の記録漏れ」と区別できない赤になる。ランナーが読み込んだ
    // マイグレーションの本数（vitest.config.ts の TEST_MIGRATIONS）と突き合わせる
    // （shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
    expect(row?.applied).toBe(env.TEST_MIGRATIONS.length);
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

  it('build_health は 1 依頼 1 行で、索引を持たない（#140 / 3.6）', async () => {
    // 3.8 の degrade の発火信号（`migrations/0010_build_health.sql`）。
    expect(await catalogNames('table')).toContain('build_health');

    // **`game_id` が主キーである。** 数えるのは失敗した**依頼**の数で、ビルド関数を
    // 何回叩いたかではない（1 依頼で最大 9 回走りうる。呼び出しを数えると、1 人の
    // 要求だけで閾値へ届く）。重複配信（0007）でも行が増えないのは同じ理由による。
    //
    // **`sqlite_autoindex_build_health_1` という名前で引かない**（PR #189 のレビュー指摘）。
    // あれは SQLite が主キーのために勝手に作る索引の名前で、**末尾の連番は表に
    // UNIQUE 制約が増えるだけで動く。** 確かめたいのは「`game_id` が主キーであること」
    // であって索引の名前ではないので、名前で引くと**この検査の目的と無関係な理由で
    // 赤になる**（docs/handoff.md 4 章 / #175 と同じ形）。
    //
    // `pragma_table_info` の `pk` は**主キーの中での位置**（1 始まり。主キーでなければ 0）
    // である。位置つきで取るので、複合主キーになったときも順序ごと落ちる。
    const columns = await env.DB.prepare('select name, pk from pragma_table_info(?)')
      .bind('build_health')
      .all<{ name: string; pk: number }>();
    const primaryKey = columns.results
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    expect(primaryKey).toEqual(['game_id']);

    // **索引を張らない。** 索引は 1 行の insert につき 1 行の書き込みを足す（3.6）。
    // この表は平常時 0 行なので、全走査で足りる。
    const declared = (await catalogNames('index')).filter((name) =>
      name.startsWith('build_health'),
    );
    expect(declared).toEqual([]);
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

describe('OGP 画像の列（0009 / #26）', () => {
  it('games に ogp_key / ogp_state / ogp_token_hash がある', async () => {
    const columns = await env.DB.prepare('select * from pragma_table_info(?)')
      .bind('games')
      .all<{ name: string }>();
    const names = columns.results.map((row) => row.name);
    for (const expected of ['ogp_key', 'ogp_state', 'ogp_token_hash']) {
      expect(names, expected).toContain(expected);
    }
  });

  it('ogp_state が NULL と 3 つの綴りだけを受け付ける', async () => {
    // **遷移そのものなので CHECK を張る**（0007 の generation_state と同じ軸。
    // 表示の都合で増える語彙には張らない）。
    const authorId = await insertUser('ogp-state');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-ogp-state', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    for (const state of ['capturing', 'ready', 'failed']) {
      await expect(
        env.DB.prepare('update games set ogp_state = ? where id = ?')
          .bind(state, 'g-ogp-state')
          .run(),
      ).resolves.toBeTruthy();
    }
    await expect(
      env.DB.prepare('update games set ogp_state = ? where id = ?')
        .bind('shooting', 'g-ogp-state')
        .run(),
    ).rejects.toThrow();
  });

  it('既定は NULL である（既存行は「撮っていない」）', async () => {
    // 0007 の generation_state を 'ready' に倒したのとは逆で、**既存行はすべて未公開**
    // なので、NULL がそのまま真になる。
    const authorId = await insertUser('ogp-default');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-ogp-default', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    const row = await env.DB.prepare(
      'select ogp_key, ogp_state, ogp_token_hash from games where id = ?',
    )
      .bind('g-ogp-default')
      .first<{ ogp_key: string | null; ogp_state: string | null; ogp_token_hash: string | null }>();
    expect(row?.ogp_key).toBeNull();
    expect(row?.ogp_state).toBeNull();
    expect(row?.ogp_token_hash).toBeNull();
  });
});

describe('OGP の撮影を始めた時刻（0012 / #235）', () => {
  it('games に ogp_started_at がある（INTEGER）', async () => {
    const columns = await env.DB.prepare('select * from pragma_table_info(?)')
      .bind('games')
      .all<{ name: string; type: string }>();
    const found = columns.results.find((row) => row.name === 'ogp_started_at');
    expect(found, 'games.ogp_started_at').toBeDefined();
    // **時刻はすべて UNIX 秒の INTEGER で持つ**（0001 の冒頭）。
    expect(found?.type).toBe('INTEGER');
  });

  it('既定は NULL である（まだ撮り始めていない）', async () => {
    const authorId = await insertUser('ogp-started-default');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-ogp-started-default', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    const row = await env.DB.prepare('select ogp_started_at from games where id = ?')
      .bind('g-ogp-started-default')
      .first<{ ogp_started_at: number | null }>();
    expect(row?.ogp_started_at).toBeNull();
  });
});

describe('改造通知の記録（0013 / #36）', () => {
  it('fork_notices は 1 フォーク 1 行で、索引を持たない（3.6）', async () => {
    expect(await catalogNames('table')).toContain('fork_notices');

    // **`game_id`（＝子作品の id）が主キーである。** 数えるのは「改造 1 件につき
    // 1 通」であって、親ごとでも作者ごとでもない。親を主キーにすると 2 人目の
    // 改造者の通知が消え、作者を主キーにすると 2 作目の改造の通知が消える。
    //
    // **`sqlite_autoindex_...` の名前で引かない**（build_health と同じ理由）。
    // 位置つきで取るので、複合主キーになったときも順序ごと落ちる。
    const columns = await env.DB.prepare('select * from pragma_table_info(?)')
      .bind('fork_notices')
      .all<{ name: string; pk: number; type: string }>();
    const primaryKey = columns.results
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    expect(primaryKey).toEqual(['game_id']);

    // 時刻は UNIX 秒の INTEGER（0001 の規約）。
    expect(columns.results.find((row) => row.name === 'claimed_at')?.type).toBe('INTEGER');

    // **明示的な索引を張らない。** 引き方は主キー 1 本だけで、索引は 1 行の insert に
    // つき 1 行の書き込みを足す（3.6）。
    const declared = (await catalogNames('index')).filter((name) => name.startsWith('fork_notices'));
    expect(declared).toEqual([]);
  });

  it('outcome が 4 つの綴りだけを受け付ける', async () => {
    const authorId = await insertUser('fork-notice-outcome');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-fork-notice-outcome', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    for (const outcome of ['claimed', 'sent', 'send-failed', 'backfilled']) {
      await env.DB.prepare(
        `insert into fork_notices (game_id, claimed_at, outcome) values (?, 1, ?)
         on conflict (game_id) do update set outcome = excluded.outcome`,
      )
        .bind('g-fork-notice-outcome', outcome)
        .run();
    }
    await expect(
      env.DB.prepare('update fork_notices set outcome = ? where game_id = ?')
        .bind('mailed', 'g-fork-notice-outcome')
        .run(),
    ).rejects.toThrow();
  });

  it('同じフォークの 2 行目は主キーで弾かれる（1 フォーク 1 通の関門）', async () => {
    const authorId = await insertUser('fork-notice-pk');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
    )
      .bind('g-fork-notice-pk', authorId, 'draft', 'T', 'go1.25.0')
      .run();

    await env.DB.prepare(
      "insert into fork_notices (game_id, claimed_at, outcome) values (?, 1, 'claimed')",
    )
      .bind('g-fork-notice-pk')
      .run();
    await expect(
      env.DB.prepare(
        "insert into fork_notices (game_id, claimed_at, outcome) values (?, 2, 'claimed')",
      )
        .bind('g-fork-notice-pk')
        .run(),
    ).rejects.toThrow();
  });

  it('適用時に公開済みだったフォークを backfilled として埋める（#202 / #203 の形）', async () => {
    // **既存行はこの実装の経路を 1 度も通っていない**（docs/handoff.md 1 章）。
    // 空の表を「1 通も送っていない」と読む運用を書いた人が、過去のフォーク全部へ
    // 通知を撒くことになる。0013 はその読みを塞ぐために埋めている。
    //
    // **テストの D1 は空の状態でマイグレーションが流れる**ので、適用の瞬間には
    // 0 行しか埋まらない。**SQL そのものを取り出して、行がある状態で回す**
    // （期待値をテストへ書き写すと、0013 を書き換えた日にこの検査だけが古くなる）。
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0013_'));
    expect(migration, '0013 のマイグレーション').toBeDefined();
    const backfill = migration!.queries.find((query) => /insert\s+into\s+fork_notices/iu.test(query));
    expect(backfill, '0013 の埋め戻し文').toBeDefined();
    // **行コメントを落としてから 1 行へ潰す。** `exec` は文を 1 行で受け取るので、
    // `--` を残したまま改行を消すと**文全体がコメントになり、0 行で緑になる。**
    const sql = backfill!
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    expect(sql).toMatch(/^insert into fork_notices/iu);

    const authorId = await insertUser('fork-backfill');
    const rows: readonly [string, string | null, string][] = [
      ['g-backfill-parent', null, 'published'],
      ['g-backfill-published', 'g-backfill-parent', 'published'],
      ['g-backfill-removed', 'g-backfill-parent', 'removed'],
      ['g-backfill-draft', 'g-backfill-parent', 'draft'],
    ];
    for (const [id, parentId, status] of rows) {
      await env.DB.prepare(
        `insert into games (id, author_id, parent_id, status, title, go_version, created_at, published_at)
         values (?, ?, ?, ?, ?, ?, 7, 9)`,
      )
        .bind(id, authorId, parentId, status, 'T', 'go1.25.0')
        .run();
    }

    await env.DB.exec(sql);

    const marked = await env.DB.prepare(
      "select game_id, claimed_at, outcome from fork_notices where game_id like 'g-backfill-%' order by game_id",
    ).all<{ game_id: string; claimed_at: number; outcome: string }>();
    // **親そのものと、まだ公開していないフォークは埋めない。** 前者は改造ではなく、
    // 後者はこれから公開されるときに通知されるべきものである。
    expect(marked.results.map((row) => row.game_id)).toEqual([
      'g-backfill-published',
      'g-backfill-removed',
    ]);
    for (const row of marked.results) {
      expect(row.outcome).toBe('backfilled');
      // `published_at` を入れる（その時点で真である値。0012 と同じ考え方）。
      expect(row.claimed_at).toBe(9);
    }
  });
});
