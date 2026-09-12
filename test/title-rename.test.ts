import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_TITLE_LENGTH,
  UNTITLED_TITLE,
  claimGenerationJob,
  completeGame,
  createPendingGame,
  draftTitleFromPrompt,
  hashJobToken,
  normalizeTitle,
  publishGame,
  removeGame,
  renameGame,
} from '../src/games.js';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  REVIEW_RENAMED_SQL,
  REVIEW_STATE_COLUMN,
  TITLE_CHANGES_TABLE,
  reviewAttentionSql,
} from '../src/reports.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import { inspectText } from '../src/output-moderation.js';
import {
  WORK_RENAME_GAME_ID_FIELD,
  WORK_RENAME_PATH,
  WORK_RENAME_TITLE_FIELD,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者による改名（5.4 / 8.4 / #366）。
 *
 * **`test/work-page.test.ts` と分けている。** 同じ波の複数レーンが作品ページを触って
 * おり、1 つのファイルを 2 レーンの所有にすると衝突の余地が生まれる
 * （`docs/handoff.md` 4 章「所有ファイルを重ねない」。`test/schema-admin.test.ts` が
 * 同じ理由で分かれている）。
 *
 * # この検査が見ているもの
 *
 *   1. 作者以外・未ログインが断られること（**変異で確認した**）
 *   2. 正規化が生成側（`draftTitleFromPrompt`）と 1 文字も違わないこと
 *   3. 8.3 の語で断り、**語も分類も応答に出さない**こと
 *   4. 改名と履歴が 1 つの batch であること（**履歴が落ちれば題名も変わらない**）
 *   5. `cleared` が `NULL` へ戻り、**`queued` にはならない**こと（**変異で確認した**）
 *   6. 改名後の通報を拾う条件（`REVIEW_RENAMED_SQL`）が、既知の行に対して正しいこと
 *   7. 作品の行を消すときに履歴も消せること（確定26 / 3.7 の削除規約）
 *
 * **6 をシェル側で見るのは `scripts/report-selftest.sh` の 11 節である**（あちらは
 * `scripts/report-queue.sh` をスクリプトとして走らせる）。ここで見るのは条件そのものの
 * 意味で、あちらが見るのは取り出しと差し込みが繋がっていることである。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-title-rename-1';

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `rename-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 完成した（`ready`・未公開）作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param prompt プロンプト（初期の題名になる）
 * @returns 作者の id と作品 id
 */
async function seedReady(
  suffix: string,
  prompt = 'ねこが主人公のパズル',
): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * セッション cookie を組み立てる。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * いま保存されている題名を読む。
 *
 * @param gameId 作品 id
 * @returns 題名
 */
async function titleOf(gameId: string): Promise<string> {
  const row = await env.DB.prepare('select title from games where id = ?')
    .bind(gameId)
    .first<{ title: string }>();
  return row?.title ?? '';
}

/**
 * いまの審査状態を読む。
 *
 * @param gameId 作品 id
 * @returns 審査状態（`NULL` なら null）
 */
async function reviewStateOf(gameId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `select ${REVIEW_STATE_COLUMN} as review_state from games where id = ?`,
  )
    .bind(gameId)
    .first<{ review_state: string | null }>();
  return row?.review_state ?? null;
}

/**
 * 改名の履歴を新しい順に読む。
 *
 * @param gameId 作品 id
 * @returns 履歴の行
 */
async function historyOf(
  gameId: string,
): Promise<readonly { old_title: string; new_title: string; changed_at: number }[]> {
  const rows = await env.DB.prepare(
    `select old_title, new_title, changed_at from ${TITLE_CHANGES_TABLE}
      where game_id = ? order by changed_at desc, rowid desc`,
  )
    .bind(gameId)
    .all<{ old_title: string; new_title: string; changed_at: number }>();
  return rows.results;
}

/**
 * 改名の経路へ POST する（素の `<form>` と同じ形）。
 *
 * @param gameId 作品 id
 * @param title 新しい題名
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function postRename(gameId: string, title: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const body = new URLSearchParams({
    [WORK_RENAME_GAME_ID_FIELD]: gameId,
    [WORK_RENAME_TITLE_FIELD]: title,
  });
  return await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${WORK_RENAME_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * 作品ページを開く。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 本文
 */
async function openWork(gameId: string, cookie?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const response = await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${workPagePath(gameId)}`, { headers }),
    testEnv(),
  );
  return await response.text();
}

beforeAll(async () => {
  await applySchema();
});

describe('改名の口は作者にだけ出る（#366）', () => {
  it('作者の画面には改名のフォームが出る', async () => {
    const { userId, id } = await seedReady('form-owner');
    const body = await openWork(id, await sessionCookie(userId));
    expect(body).toContain(WORK_RENAME_PATH);
    expect(body).toContain(WORK_RENAME_TITLE_FIELD);
    expect(body).toContain('作品名を変える');
  });

  it('未ログイン・他人の画面にはフォームが 1 バイトも出ない', async () => {
    // **公開してから見る。** 未公開の作品ページは他人に題名すら出さないので、
    // 公開済みの——**題名が誰にでも見える**——状態で確かめる。
    const { userId, id } = await seedReady('form-stranger');
    await publishGame(env, id, userId);

    const stranger = await seedUser('form-onlooker');
    expect(await openWork(id)).not.toContain(WORK_RENAME_PATH);
    expect(await openWork(id, await sessionCookie(stranger))).not.toContain(WORK_RENAME_PATH);
  });

  it('いまの題名を初期値に入れる（UGC なのでエスケープする）', async () => {
    const { userId, id } = await seedReady('form-escape', '"><script>alert(1)</script>');
    const body = await openWork(id, await sessionCookie(userId));

    // **`value` 属性から抜け出せない。** `escapeHtml` は `"` と `'` まで置き換える。
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('取り下げた作品にはフォームを出さない', async () => {
    const { userId, id } = await seedReady('form-removed');
    await publishGame(env, id, userId);
    await removeGame(env, id, userId);
    expect(await openWork(id, await sessionCookie(userId))).not.toContain(WORK_RENAME_PATH);
  });
});

describe('改名できるのは作者だけである（#366）', () => {
  it('未ログインの改名は断られ、題名も変わらない', async () => {
    const { id } = await seedReady('anon', 'もとの題名');
    const before = await titleOf(id);

    const response = await postRename(id, 'のっとられた題名');

    // 素の `<form>` はログインへ送る（`handleRemove` / `handleReport` と同じ形）。
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await titleOf(id)).toBe(before);
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('他人の改名は断られ、題名も変わらない', async () => {
    const { id } = await seedReady('stranger-write', 'もとの題名');
    const stranger = await seedUser('stranger-writer');
    const before = await titleOf(id);

    const response = await postRename(id, 'のっとられた題名', await sessionCookie(stranger));

    // **理由を撃ち分けない**（他人の作品は「無い」と同じ扱い。`removeGame` と同じ）。
    expect(response.status).toBe(404);
    expect(await titleOf(id)).toBe(before);
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('作者の改名は通り、作品ページへ戻す', async () => {
    const { userId, id } = await seedReady('owner-write', 'もとの題名');

    const response = await postRename(id, 'あたらしい題名', await sessionCookie(userId));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(id));
    expect(await titleOf(id)).toBe('あたらしい題名');
  });

  it('取り下げた作品は改名できない', async () => {
    const { userId, id } = await seedReady('removed-write', 'もとの題名');
    await publishGame(env, id, userId);
    await removeGame(env, id, userId);

    const outcome = await renameGame(env, id, userId, 'あたらしい題名');

    expect(outcome).toEqual({ ok: false, reason: 'removed' });
    expect(await titleOf(id)).toBe('もとの題名');
  });
});

describe('正規化は生成側と同じ関数を通る（#365 / #366）', () => {
  // **生成側の結果と突き合わせる。** `normalizeTitle` と比べるだけでは「改名が
  // あの関数を呼んでいる」ことしか言えず、**生成側が別の関数を呼び始めた日に
  // 気づけない。**
  const candidates = [
    { name: '40 文字を超える', value: 'あ'.repeat(MAX_TITLE_LENGTH + 10) },
    { name: '制御文字（NEL を含む）', value: 'ね\u0085こ\u0007の\u001fゲーム' },
    { name: '行区切り（U+2028）', value: 'ねこ\u2028ゲーム' },
    { name: '前後の空白', value: '  ねこのゲーム  ' },
    { name: '空白だけ', value: '   ' },
    { name: '空文字', value: '' },
    { name: 'サロゲート対', value: '🐱'.repeat(MAX_TITLE_LENGTH + 5) },
  ];

  for (const [index, candidate] of candidates.entries()) {
    it(`${candidate.name} の改名は、生成側の正規化と同じ結果になる`, async () => {
      const { userId, id } = await seedReady(`normalize-${index}`, 'もとの題名');

      const outcome = await renameGame(env, id, userId, candidate.value);

      expect(outcome.ok).toBe(true);
      const expected = draftTitleFromPrompt(candidate.value);
      expect(await titleOf(id)).toBe(expected);
      expect(outcome.ok && outcome.title).toBe(expected);
      // **切るのはコードポイント単位である**（サロゲート対を割らない）。
      expect([...(await titleOf(id))].length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    });
  }

  it('空の改名は断らずに既定の題名へ倒す', async () => {
    const { userId, id } = await seedReady('normalize-empty', 'もとの題名');
    await renameGame(env, id, userId, '   ');
    expect(await titleOf(id)).toBe(UNTITLED_TITLE);
    expect(UNTITLED_TITLE).toBe(normalizeTitle(''));
  });
});

describe('8.3 の表を掛ける（#366）', () => {
  // **表から 1 語借りる。** 語をここへ書き写すと、表から消えた日にこの検査だけが
  // 古い語を使い続ける（`src/denied-terms.ts` は「語を足すのは運用の仕事」と書いている）。
  const denied = DENIED_TERMS[0]!;

  it('表の語を含む改名は断られ、題名も履歴も変わらない', async () => {
    const { userId, id } = await seedReady('denied', 'もとの題名');

    const outcome = await renameGame(env, id, userId, `これは${denied.term}です`);

    expect(outcome).toEqual({ ok: false, reason: 'denied-term' });
    expect(await titleOf(id)).toBe('もとの題名');
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('応答に語も分類も出ない（8.2 の方針に倣う）', async () => {
    const { userId, id } = await seedReady('denied-response', 'もとの題名');

    const response = await postRename(id, `これは${denied.term}です`, await sessionCookie(userId));
    const body = await response.text();

    expect(response.status).toBe(400);
    // **当てては消しを繰り返せば表が復元できる**ので、語も分類も返さない。
    expect(body).not.toContain(denied.term);
    expect(body).not.toContain(denied.category);
    expect(body).toContain('この作品名は使えません');
  });

  it('綴りを崩しても（全角・不可視文字）同じ規則で当たる', async () => {
    // **突き合わせの規則が 8.3 と同じ 1 本であることの検査である**（`inspectText` は
    // `inspectStringLiterals` と `collectCategories` を共有している）。
    expect(inspectText(denied.term.toUpperCase()).ok).toBe(false);
    expect(inspectText(`${denied.term[0]}\u200b${denied.term.slice(1)}`).ok).toBe(false);
    expect(inspectText('ふつうのゲーム').ok).toBe(true);
  });

  it('Go のエスケープは展開しない（利用者が書いた文字はその文字である）', () => {
    // `キ` は Go のリテラルなら「キ」だが、題名としては**その 6 文字**である。
    expect(inspectText('\\u30ad', [{ term: 'キ', match: 'substring', category: 'discriminatory' }]).ok).toBe(
      true,
    );
  });
});

describe('改名と履歴は 1 つの batch で書く（#366 / #361 の規律）', () => {
  it('改名すると履歴が 1 行増える', async () => {
    const { userId, id } = await seedReady('history', 'もとの題名');

    await renameGame(env, id, userId, 'あたらしい題名', 1_700_000_000);

    const history = await historyOf(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      old_title: 'もとの題名',
      new_title: 'あたらしい題名',
      changed_at: 1_700_000_000,
    });
  });

  it('履歴は追記のみ（2 回改名すれば 2 行になる）', async () => {
    const { userId, id } = await seedReady('history-append', 'だい 1 版');
    await renameGame(env, id, userId, 'だい 2 版', 1_700_000_100);
    await renameGame(env, id, userId, 'だい 3 版', 1_700_000_200);

    const history = await historyOf(id);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.new_title)).toEqual(['だい 3 版', 'だい 2 版']);
    // 前の行は書き換わっていない。
    expect(history[1]!.old_title).toBe('だい 1 版');
  });

  it('同じ題名の入れ直しは、題名も履歴も動かさない', async () => {
    const { userId, id } = await seedReady('history-same', 'おなじ題名');

    const outcome = await renameGame(env, id, userId, ' おなじ題名 ');

    // **失敗にしない**（二度押しと同じ扱い。`removeGame` の 2 回目と同じ）。
    expect(outcome).toEqual({ ok: true, title: 'おなじ題名', changed: false });
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('履歴の追記に失敗したら題名も変わらない', async () => {
    const { userId, id } = await seedReady('history-atomic', 'もとの題名');

    // **`changed_at > 0` の CHECK を踏ませる**（`migrations/0027_title_changes.sql`）。
    // 履歴の insert が落ちると、**batch ごと巻き戻って UPDATE も入らない。**
    await expect(renameGame(env, id, userId, 'あたらしい題名', 0)).rejects.toThrow();

    expect(await titleOf(id)).toBe('もとの題名');
    expect(await historyOf(id)).toHaveLength(0);
  });
});

describe('改名は審査状態を戻す（#366）', () => {
  it('cleared の作品を改名すると NULL へ戻る', async () => {
    const { userId, id } = await seedReady('review-cleared', 'もとの題名');
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, id)
      .run();

    await renameGame(env, id, userId, 'あたらしい題名');

    expect(await reviewStateOf(id)).toBeNull();
  });

  it('queued にはならない（善意の改名で作品がトップから消えない）', async () => {
    // **`cleared` からも `NULL` からも `queued` へ行かない。** `queued` は新規露出を
    // 止める状態である（`reviewVisibleSql`）。
    const cleared = await seedReady('review-not-queued-cleared', 'もとの題名');
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, cleared.id)
      .run();
    await renameGame(env, cleared.id, cleared.userId, 'あたらしい題名');
    expect(await reviewStateOf(cleared.id)).not.toBe(REVIEW_QUEUED);

    const plain = await seedReady('review-not-queued-null', 'もとの題名');
    await renameGame(env, plain.id, plain.userId, 'あたらしい題名');
    expect(await reviewStateOf(plain.id)).toBeNull();
  });

  it('queued の作品は queued のまま（審査待ちを解かない）', async () => {
    const { userId, id } = await seedReady('review-queued', 'もとの題名');
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_QUEUED, id)
      .run();

    await renameGame(env, id, userId, 'あたらしい題名');

    // **改名で審査待ちを解けてはいけない**（解けるなら、通報された作品は改名だけで
    // キューから出られる）。
    expect(await reviewStateOf(id)).toBe(REVIEW_QUEUED);
  });
});

describe('改名後の通報を拾う条件（#366 / #367 が借りる）', () => {
  it('綴りは定数から組み立てられている（書き写していない）', () => {
    // **一覧の複製は機械照合で担保する**（shared-ai-rules 12 章）。1 行の文字列
    // リテラルにしてあるのはシェルから取り出すためで、そのぶん綴りをここで見る。
    expect(REVIEW_RENAMED_SQL).toContain(`'${REVIEW_CLEARED}'`);
    expect(REVIEW_RENAMED_SQL).toContain(TITLE_CHANGES_TABLE);
    expect(REVIEW_RENAMED_SQL).toContain(`g.${REVIEW_STATE_COLUMN}`);
    expect(REVIEW_RENAMED_SQL).toContain('reports');
    // 和のほうは審査待ちも含む。
    expect(reviewAttentionSql()).toContain(`'${REVIEW_QUEUED}'`);
    expect(reviewAttentionSql()).toContain(REVIEW_RENAMED_SQL);
  });

  /**
   * 条件に当たる作品 id を引く。
   *
   * @param sql where 句に置く断片
   * @returns 当たった作品 id（昇順）
   */
  async function matching(sql: string): Promise<readonly string[]> {
    const rows = await env.DB.prepare(
      `select g.id from games g where ${sql} order by g.id`,
    ).all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  it('cleared かつ最後の改名より後に通報があれば当たる', async () => {
    const { userId, id } = await seedReady('attention-hit', 'もとの題名');
    const reporter = await seedUser('attention-reporter');
    await renameGame(env, id, userId, 'あたらしい題名', 1_700_001_000);
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, id)
      .run();
    await env.DB.prepare(
      'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
    )
      .bind(`report-${id}`, id, reporter, '改名後の通報', 1_700_002_000)
      .run();

    expect(await matching(REVIEW_RENAMED_SQL)).toContain(id);
    expect(await matching(reviewAttentionSql())).toContain(id);
  });

  it('通報が改名より前なら当たらない', async () => {
    const { userId, id } = await seedReady('attention-old-report', 'もとの題名');
    const reporter = await seedUser('attention-old-reporter');
    await env.DB.prepare(
      'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
    )
      .bind(`report-${id}`, id, reporter, '改名前の通報', 1_700_001_000)
      .run();
    await renameGame(env, id, userId, 'あたらしい題名', 1_700_002_000);
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, id)
      .run();

    expect(await matching(REVIEW_RENAMED_SQL)).not.toContain(id);
  });

  it('改名していない cleared は当たらない（審査は終わっている）', async () => {
    const { id } = await seedReady('attention-no-rename', 'もとの題名');
    const reporter = await seedUser('attention-no-rename-reporter');
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_CLEARED, id)
      .run();
    await env.DB.prepare(
      'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
    )
      .bind(`report-${id}`, id, reporter, '通報', 1_700_002_000)
      .run();

    expect(await matching(REVIEW_RENAMED_SQL)).not.toContain(id);
  });

  it('審査待ちは和のほうに当たる', async () => {
    const { id } = await seedReady('attention-queued', 'もとの題名');
    await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
      .bind(REVIEW_QUEUED, id)
      .run();

    expect(await matching(reviewAttentionSql())).toContain(id);
    expect(await matching(REVIEW_RENAMED_SQL)).not.toContain(id);
  });
});

describe('履歴は作品と同じ寿命である（確定26 / 3.7 の削除規約）', () => {
  it('作品の行を指す外部キーを持つ', async () => {
    const rows = await env.DB.prepare(
      `pragma foreign_key_list(${TITLE_CHANGES_TABLE})`,
    ).all<{ table: string; from: string; to: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ table: 'games', from: 'game_id', to: 'id' });
  });

  it('作品の行を消すときに履歴も消せる（順序は履歴が先）', async () => {
    const { userId, id } = await seedReady('lifetime', 'もとの題名');
    await renameGame(env, id, userId, 'あたらしい題名', 1_700_003_000);
    expect(await historyOf(id)).toHaveLength(1);

    // **3.7 の掃除が作品行まで消す日の手順である**（いまの実装に `games` の物理削除は
    // 無い。5.3 の tombstone 化）。**履歴を先に消す**——逆順にすると外部キーが宙に浮く。
    await env.DB.batch([
      env.DB.prepare(`delete from ${TITLE_CHANGES_TABLE} where game_id = ?`).bind(id),
      env.DB.prepare('delete from games where id = ?').bind(id),
    ]);

    expect(await historyOf(id)).toHaveLength(0);
    const left = await env.DB.prepare(
      `select count(*) as n from ${TITLE_CHANGES_TABLE}
        where game_id not in (select id from games)`,
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
