import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, ADMIN_ACTION_TARGET_KINDS, setReviewState } from '../src/admin/actions.js';
import { PUBLISHED_STATUS, renameGame } from '../src/games.js';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  REVIEW_REPORTED_AFTER_CLEAR_SQL,
  REVIEW_STATE_COLUMN,
  recordReport,
  reviewAttentionSql,
} from '../src/reports.js';
import { applySchema } from './helpers/schema.js';

/**
 * 「問題なしとしたあとに通報が付いた」作品の条件（8.4 / #366 / #394）。
 *
 * # この検査が見ているもの
 *
 *   1. 綴りが定数と一致していること（1 行の文字列リテラルなので、書き写しを機械照合する）
 *   2. **(a) 運営が見終えた作品が出ない**こと（issue #394 の再現）
 *   3. **(b) `cleared` にした後の通報は出る**こと。同じ秒は拾う側へ倒す
 *   4. **履歴の無い `cleared`（#361 より前）は、通報があれば出る**こと
 *   5. 基準は「その作品の」「作品を対象にした」「`review-cleared` の」時刻であること
 *   6. 履歴の行数を増やしても、条件の読み取り行数が増えないこと（`0029` の索引）
 *
 * **変異で確かめた**（2026-09-12。条件の文字列を 1 か所ずつ書き換え、このファイルと
 * `test/admin-screens.test.ts` を回した。どの変異も少なくとも 1 本が赤くなった）。
 *
 *   - #366 の条件（最後の改名より後の通報）へ戻す … 2（issue の再現・往復）と 3 が赤
 *   - 比較を `<` に反転する／後半を偽にする … 2 と 3 がそれぞれ赤
 *   - `>=` を `>` にする … 3 の同じ秒が赤
 *   - `coalesce(…, 0)` を外す／最後の改名の時刻へ倒す … 4 が赤
 *   - `a.target_id = g.id` を外す … 5 の「別の作品」が赤
 *   - `a.action = 'review-cleared'` を外す … 5 の「端末で戻した作品」が赤
 *   - `a.target_kind = 'game'` を外す … 5 の「対象の種類」と 6 が赤（索引の先頭列を
 *     使えなくなり、読み取りが履歴の行数に比例する）
 *
 * **状態は本物の関数で動かす**（`recordReport` / `setReviewState` / `renameGame`）。
 * 直接 UPDATE で状態を作ると、**履歴を積まない経路**を作ってしまい、それ自体が 4 の
 * 「履歴の無い `cleared`」になる——確かめたい区別がテストの側で潰れる。直接 UPDATE を
 * 使うのは、4 を作るとき（#361 より前の運用の再現）だけである。
 *
 * **シェル側（`scripts/report-queue.sh` が同じ定数を取り出して使うこと）は
 * `scripts/report-selftest.sh` の 11 節が見る。** 画面の節との対応は
 * `test/admin-screens.test.ts` が見る。
 */

/** 仕込む利用者。 */
const users = { admin: '', author: '', reporters: [] as string[] };

/**
 * `users` を 1 行入れる。
 *
 * @param label 名前の目印
 * @returns 利用者の id
 */
async function insertUser(label: string): Promise<string> {
  const id = `${label}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 1)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, label)
    .run();
  return id;
}

/**
 * 公開済み・生成完了の作品を 1 本入れる（審査状態は `NULL`）。
 *
 * @returns 作品の id
 */
async function insertGame(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, 'もとの題名', '', 1, 'ready', 1, 0, 0, 'ready', null)`,
  )
    .bind(id, users.author, PUBLISHED_STATUS)
    .run();
  return id;
}

/**
 * 通報する（本物の {@link recordReport}。`NULL` なら `queued` へ上がる）。
 *
 * @param gameId 作品 id
 * @param reporterIndex 何人目の通報者か（同じ人は 2 度通報できない）
 * @param now 時刻（UNIX 秒）
 */
async function report(gameId: string, reporterIndex: number, now: number): Promise<void> {
  const outcome = await recordReport(env, gameId, users.reporters[reporterIndex]!, '通報', now);
  expect(outcome.ok, '通報が通っていない（仕込みの前提が崩れている）').toBe(true);
}

/**
 * 画面の口と同じ関数で状態を動かす（履歴を 1 行積む）。
 *
 * @param gameId 作品 id
 * @param to 動かす先
 * @param now 時刻（UNIX 秒）
 */
async function review(gameId: string, to: typeof REVIEW_QUEUED | typeof REVIEW_CLEARED, now: number): Promise<void> {
  const outcome = await setReviewState(env, {
    gameId,
    from: to === REVIEW_CLEARED ? REVIEW_QUEUED : REVIEW_CLEARED,
    to,
    actorId: users.admin,
    reason: '見た',
    now,
  });
  expect(outcome, '審査の操作が通っていない（仕込みの前提が崩れている）').toEqual({
    ok: true,
    changed: true,
  });
}

/**
 * 条件に当たるか。
 *
 * @param sql where 句に置く断片（別名は `g`）
 * @param gameId 作品 id
 * @returns 当たれば true
 */
async function matches(sql: string, gameId: string): Promise<boolean> {
  const row = await env.DB.prepare(`select 1 as hit from games g where g.id = ? and ${sql}`)
    .bind(gameId)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * いまの審査状態。
 *
 * @param gameId 作品 id
 * @returns 審査状態
 */
async function stateOf(gameId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `select ${REVIEW_STATE_COLUMN} as review_state from games where id = ?`,
  )
    .bind(gameId)
    .first<{ review_state: string | null }>();
  return row?.review_state ?? null;
}

beforeAll(async () => {
  await applySchema();
  users.admin = await insertUser('管理者');
  users.author = await insertUser('作者');
  for (let index = 0; index < 4; index += 1) {
    users.reporters.push(await insertUser(`通報者${index}`));
  }
  await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(users.admin).run();
});

describe('綴りは定数と一致している（1 行の文字列リテラルの機械照合。#366 / #394）', () => {
  it('審査状態の綴りと列名', () => {
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain(`g.${REVIEW_STATE_COLUMN} = '${REVIEW_CLEARED}'`);
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain('from reports r');
  });

  it('履歴の表の綴りが src/admin/actions.ts の正本と一致する', () => {
    // **`src/admin/actions.ts` から import できない**（循環参照になり、オーケストレータの
    // 束に admin のコードが載る）ので、1 行の文字列に書いた綴りをここで照合する。
    const cleared: (typeof ADMIN_ACTIONS)[number] = 'review-cleared';
    const game: (typeof ADMIN_ACTION_TARGET_KINDS)[number] = 'game';
    expect(ADMIN_ACTIONS).toContain(cleared);
    expect(ADMIN_ACTION_TARGET_KINDS).toContain(game);
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain('from admin_actions a');
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain(`a.action = '${cleared}'`);
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain(`a.target_kind = '${game}'`);
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).toContain('a.target_id = g.id');
  });

  it('1 行の二重引用符つきリテラルで、シェルから取り出せる形である', () => {
    // `scripts/report-queue.sh` の awk は「宣言の次に現れる `"…"`」を取る。
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).not.toContain('\n');
    expect(REVIEW_REPORTED_AFTER_CLEAR_SQL).not.toContain('"');
    expect(reviewAttentionSql()).toContain(`'${REVIEW_QUEUED}'`);
    expect(reviewAttentionSql()).toContain(REVIEW_REPORTED_AFTER_CLEAR_SQL);
  });

  it('`not` を付けても NULL にならない（通報の無い cleared が両方の節から消えない）', async () => {
    const gameId = await insertGame();
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, gameId)
      .run();
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
    expect(await matches(`not ${REVIEW_REPORTED_AFTER_CLEAR_SQL}`, gameId)).toBe(true);
  });
});

describe('(a) 運営が見終えた作品は出ない（#394）', () => {
  it('通報 → 問題なし、で出ない', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_000_100);
    expect(await stateOf(gameId)).toBe(REVIEW_QUEUED);
    await review(gameId, REVIEW_CLEARED, 1_700_000_200);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
    expect(await matches(reviewAttentionSql(), gameId)).toBe(false);
  });

  it('issue の再現: 通報 → 問題なし → 改名 → 通報 → 問題なし、で出ない', async () => {
    // **#366 の条件（最後の改名より後に通報がある）は、最後の 1 手で当たり始め、次に
    // 改名されるまで出続けた。** 改名後の通報は運営が見て問題なしにし直している。
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_001_100);
    await review(gameId, REVIEW_CLEARED, 1_700_001_200);
    const renamed = await renameGame(env, gameId, users.author, 'あたらしい題名', 1_700_001_300);
    expect(renamed.ok).toBe(true);
    expect(await stateOf(gameId)).toBeNull();
    await report(gameId, 1, 1_700_001_400);
    expect(await stateOf(gameId)).toBe(REVIEW_QUEUED);
    await review(gameId, REVIEW_CLEARED, 1_700_001_500);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
    expect(await matches(reviewAttentionSql(), gameId)).toBe(false);
  });

  it('往復したあとは、最後の問題なしが基準になる（その前の通報では出ない）', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_002_100);
    await review(gameId, REVIEW_CLEARED, 1_700_002_200);
    // 問題なしのあとの通報（ここでは出る）を見て、審査待ちへ戻し、再び問題なしにする。
    await report(gameId, 1, 1_700_002_300);
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
    await review(gameId, REVIEW_QUEUED, 1_700_002_400);
    await review(gameId, REVIEW_CLEARED, 1_700_002_500);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
  });
});

describe('(b) cleared にした後の通報は出る（#394）', () => {
  it('問題なしのあとに付いた通報は出る（状態は cleared のまま）', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_003_100);
    await review(gameId, REVIEW_CLEARED, 1_700_003_200);
    await report(gameId, 1, 1_700_003_300);

    // **`cleared` は終端なので、状態は動かない**——だからこの条件が要る。
    expect(await stateOf(gameId)).toBe(REVIEW_CLEARED);
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
    expect(await matches(reviewAttentionSql(), gameId)).toBe(true);
  });

  it('改名が無くても出る（改名に固有の穴ではない）', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_004_100);
    await review(gameId, REVIEW_CLEARED, 1_700_004_200);
    await report(gameId, 1, 1_700_004_900);

    const renames = await env.DB.prepare('select count(*) as n from title_changes where game_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(renames?.n).toBe(0);
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });

  it('改名 → 通報 → 問題なし のあとにもう 1 件付けば出る', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_005_100);
    await review(gameId, REVIEW_CLEARED, 1_700_005_200);
    await renameGame(env, gameId, users.author, 'あたらしい題名', 1_700_005_300);
    await report(gameId, 1, 1_700_005_400);
    await review(gameId, REVIEW_CLEARED, 1_700_005_500);
    await report(gameId, 2, 1_700_005_600);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });

  it('問題なしと同じ秒の通報も出る（拾う側へ倒す。#366 と同じ）', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_006_100);
    await review(gameId, REVIEW_CLEARED, 1_700_006_200);
    await report(gameId, 1, 1_700_006_200);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });

  it('審査待ちは条件の和のほうに当たる（こちらの条件には当たらない）', async () => {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_007_100);

    expect(await matches(reviewAttentionSql(), gameId)).toBe(true);
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
  });
});

describe('履歴の無い cleared（#361 より前に端末で問題なしにした作品）を黙って落とさない（#394）', () => {
  /**
   * #361 より前の運用を再現する: 通報で `queued` になり、端末の SQL で `cleared` にした
   * （`admin_actions` に行が無い）。
   *
   * @returns 作品 id
   */
  async function clearedFromTerminal(): Promise<string> {
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_008_100);
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, gameId)
      .run();
    const history = await env.DB.prepare('select count(*) as n from admin_actions where target_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(history?.n, '履歴が無い前提が崩れている').toBe(0);
    return gameId;
  }

  it('通報があれば出る（いつ問題なしにしたかが分からないので、見落とす側へ倒さない）', async () => {
    const gameId = await clearedFromTerminal();
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
    expect(await matches(reviewAttentionSql(), gameId)).toBe(true);
  });

  it('通報が 1 件も無ければ出ない', async () => {
    const gameId = await insertGame();
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, gameId)
      .run();
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
  });

  it('画面から 1 度往復させれば外れる（代償は 1 度きり）', async () => {
    const gameId = await clearedFromTerminal();
    await review(gameId, REVIEW_QUEUED, 1_700_008_200);
    await review(gameId, REVIEW_CLEARED, 1_700_008_300);
    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(false);
  });

  it('別の作品の問題なしの時刻を借りない', async () => {
    // **相関の条件（`a.target_id = g.id`）を落とすと、ほかの作品の新しい履歴で
    // この作品の通報が「問題なしより前」に化ける。**
    const gameId = await clearedFromTerminal();
    const other = await insertGame();
    await report(other, 0, 1_700_008_050);
    await review(other, REVIEW_CLEARED, 1_700_009_000);

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });
});

describe('基準は review-cleared の時刻である（ほかの操作の時刻を借りない）', () => {
  it('審査待ちへ戻したあと端末で cleared に戻した作品は、画面の最後の問題なしを基準にする', async () => {
    // **`review-queued` の時刻を基準にすると、その前の通報が見えなくなる。** 端末で
    // 戻した操作は履歴を積まないので、分かっている最後の問題なし（より前）へ倒す——
    // 多く出す向きである。
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_010_100);
    await review(gameId, REVIEW_CLEARED, 1_700_010_200);
    await report(gameId, 1, 1_700_010_300);
    await review(gameId, REVIEW_QUEUED, 1_700_010_400);
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, gameId)
      .run();

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });

  it('対象の種類が作品でない履歴は基準にならない（対象の種類で絞る）', async () => {
    // **対象の id が作品の id と同じ綴りの行を、利用者の操作として積む。** 実際には
    // 起こらない（id は別々の UUID）が、表の CHECK は `action` と `target_kind` の組を
    // 縛っていない（0026）ので、条件の側で絞っていることを見る。
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_011_100);
    await review(gameId, REVIEW_CLEARED, 1_700_011_200);
    await report(gameId, 1, 1_700_011_300);
    await env.DB.prepare(
      `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
       values (?, ?, ?, 'review-cleared', 'user', ?, '種類の違う行')`,
    )
      .bind(crypto.randomUUID(), users.admin, 1_700_011_900, gameId)
      .run();

    expect(await matches(REVIEW_REPORTED_AFTER_CLEAR_SQL, gameId)).toBe(true);
  });
});

describe('読み取りは索引で抑える（migrations/0029）', () => {
  it('admin_actions_target_idx が条件の列の順で張られている', async () => {
    const row = await env.DB.prepare(
      "select sql from sqlite_master where type = 'index' and name = 'admin_actions_target_idx'",
    ).first<{ sql: string }>();
    expect(row?.sql.replace(/\s+/g, ' ')).toContain(
      'admin_actions (target_kind, target_id, action, created_at)',
    );
  });

  it('履歴の行数を増やしても、条件の読み取り行数は増えない', async () => {
    // **`EXPLAIN QUERY PLAN` の字面ではなく、D1 が数えた読み取り行数で見る**（#370）。
    // 実測の全体は `migrations/0029` の冒頭にある。ここは「履歴の雑音に比例しない」
    // ことだけを固定する。
    const gameId = await insertGame();
    await report(gameId, 0, 1_700_012_100);
    await review(gameId, REVIEW_CLEARED, 1_700_012_200);
    const statement = env.DB.prepare(
      `select g.id from games g where g.id = ? and ${REVIEW_REPORTED_AFTER_CLEAR_SQL}`,
    ).bind(gameId);
    const before = (await statement.all()).meta.rows_read;

    const noise = Array.from({ length: 300 }, () =>
      env.DB.prepare(
        `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
         values (?, ?, 1700012150, 'user-banned', 'user', ?, '雑音')`,
      ).bind(crypto.randomUUID(), users.admin, users.author),
    );
    await env.DB.batch(noise);
    const after = (await statement.all()).meta.rows_read;

    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});
