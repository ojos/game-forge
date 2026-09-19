import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DESCRIPTION_CHANGES_TABLE,
  DESCRIPTION_CHANGE_INTERVAL_SECONDS,
  MAX_DESCRIPTION_LENGTH,
  claimGenerationJob,
  completeGame,
  createPendingGame,
  describeGame,
  hashJobToken,
  publishGame,
  validateDescription,
} from '../src/games.js';
import { REVIEW_CLEARED, REVIEW_QUEUED, REVIEW_STATE_COLUMN } from '../src/reports.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import { validateDisplayName } from '../src/account.js';
import {
  WORK_DESCRIBE_GAME_ID_FIELD,
  WORK_DESCRIBE_PATH,
  WORK_DESCRIBE_TEXT_FIELD,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';
import { workRoutes } from '../src/work-edit.js';
import { workEditPath } from '../src/work-edit-paths.js';
import { WORK_SAVE_DESCRIPTION_FIELD, WORK_SAVE_PATH } from '../src/work-save.js';
import { markGameRemoved } from './helpers/removed-work.js';

/**
 * 作者が書く作品の説明（#388）。
 *
 * **`test/title-rename.test.ts`（#366）と分けている。** 形はあちらを写してあるが、
 * 同じ波の複数レーンが作品ページを触っており、1 つのファイルを 2 つの issue の所有に
 * しない（`docs/handoff.md` 4 章「所有ファイルを重ねない」）。
 *
 * # この検査が見ているもの（#388 の acceptance）
 *
 *   1. 作者が公開済みの作品に書け、作品ページに出ること
 *   2. 他人の作品には書けないこと（**変異で確認した**。`describeGame` の WHERE から
 *      `author_id = ?` を外すと、この節の「他人」の it が赤くなる）
 *   3. 下書きの作品には**1 件ずつの口からは**書けないこと（#673 からは、エディットページのまとめて保存する口
 *      だけが下書きにも書く。そちらは `test/work-save.test.ts` が見る）
 *   4. HTML を入れてもそのまま描画されないこと
 *   5. 8.3 の表の語で断り、**語も分類も応答に出さない**こと
 *   6. **通報の無い** `cleared` の作品の説明を変えると `NULL` へ戻ること（**`cleared` のあとに
 *      届いた通報があれば `queued` へ入る**ことは、改名と規則を共有しているので
 *      `test/review-attention.test.ts` が並べて見る。#404）
 *   7. 変更で履歴が 1 行増え、**履歴の追記に失敗すれば説明も変わらない**こと
 *
 * それに加えて、issue の constraints（長さの上限で断る・禁じた文字の組が表示名と
 * 同じ・変更の間隔）を見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-description-1';

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
  const id = `describe-user-${suffix}`;
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
 * @returns 作者の id と作品 id
 */
async function seedReady(suffix: string): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: 'ねこが主人公のパズル' });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * 公開済みの作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者の id と作品 id
 */
async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
  const seeded = await seedReady(suffix);
  await publishGame(env, seeded.id, seeded.userId);
  return seeded;
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
 * いま保存されている説明を読む。
 *
 * @param gameId 作品 id
 * @returns 説明
 */
async function descriptionOf(gameId: string): Promise<string> {
  const row = await env.DB.prepare('select description from games where id = ?')
    .bind(gameId)
    .first<{ description: string }>();
  return row?.description ?? '<no row>';
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
 * 審査状態を直接置く（運営の操作の代わり）。
 *
 * @param gameId 作品 id
 * @param state 置く状態
 */
async function setReviewState(gameId: string, state: string): Promise<void> {
  await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
    .bind(state, gameId)
    .run();
}

/**
 * 説明の履歴を新しい順に読む。
 *
 * @param gameId 作品 id
 * @returns 履歴の行
 */
async function historyOf(
  gameId: string,
): Promise<readonly { old_description: string; new_description: string; changed_at: number }[]> {
  const rows = await env.DB.prepare(
    `select old_description, new_description, changed_at from ${DESCRIPTION_CHANGES_TABLE}
      where game_id = ? order by changed_at desc, rowid desc`,
  )
    .bind(gameId)
    .all<{ old_description: string; new_description: string; changed_at: number }>();
  return rows.results;
}

/**
 * 説明の経路へ POST する（素の `<form>` と同じ形）。
 *
 * @param gameId 作品 id
 * @param description 説明
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function postDescribe(
  gameId: string,
  description: string,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const body = new URLSearchParams({
    [WORK_DESCRIBE_GAME_ID_FIELD]: gameId,
    [WORK_DESCRIBE_TEXT_FIELD]: description,
  });
  return await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${WORK_DESCRIBE_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * 作品ページを開き、外枠を除いた本文を返す（#372 の外枠に題名や `<form` が入るため）。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 外枠を除いた本文
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
  return pageBodyOf(await response.text());
}

/**
 * エディットページを開き、外枠を除いた本文を返す（#664。説明の欄は作品ページからここへ移った）。
 *
 * **作者以外・未ログインは作品ページへ 303 で送り返され、本文は空である**（#690。`src/work-edit.ts`）。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 外枠を除いた本文
 */
async function openEdit(gameId: string, cookie?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const response = await dispatch(
    workRoutes,
    new Request(`${APP_ORIGIN}${workEditPath(gameId)}`, { headers }),
    testEnv(),
  );
  return pageBodyOf(await response.text());
}

beforeAll(async () => {
  await applySchema();
});

// **このファイルが作った行を片付ける**（PR #401 の Copilot レビュー）。`description_changes`
// は `games` を外部キーで指すので、**履歴を残したままにすると、`games` を丸ごと消す別の
// テスト（`test/admin-screens.test.ts` の beforeEach）が外部キーに阻まれうる。** 順序は
// 履歴 → 作品（`title_changes` は作らないが、念のため同じ作者の分を先に消す）。
afterAll(async () => {
  const mine = "(select id from games where author_id like 'describe-user-%')";
  await env.DB.batch([
    env.DB.prepare(`delete from ${DESCRIPTION_CHANGES_TABLE} where game_id in ${mine}`),
    env.DB.prepare(`delete from title_changes where game_id in ${mine}`),
    env.DB.prepare(`delete from reports where game_id in ${mine}`),
    env.DB.prepare("delete from games where author_id like 'describe-user-%'"),
  ]);
});

describe('説明の欄は、作者のエディットページにだけ出る（#388 / #664）', () => {
  it('公開済みの作品の作者には、エディットページに説明の欄が出て、まとめて保存する口へ送る', async () => {
    const { userId, id } = await seedPublished('form-owner');
    const body = await openEdit(id, await sessionCookie(userId));
    expect(body).toContain(`action="${WORK_SAVE_PATH}"`);
    expect(body).toContain(`name="${WORK_SAVE_DESCRIPTION_FIELD}"`);
    // **作品ページには出さない**（作者にも作者以外と同じ画面を出す。#664）。
    const page = await openWork(id, await sessionCookie(userId));
    expect(page).not.toContain(WORK_SAVE_PATH);
    expect(page).not.toContain(WORK_DESCRIBE_PATH);
  });

  it('未ログイン・他人の画面にはフォームが出ない', async () => {
    const { id } = await seedPublished('form-stranger');
    const stranger = await seedUser('form-onlooker');
    for (const body of [
      await openEdit(id),
      await openEdit(id, await sessionCookie(stranger)),
      await openWork(id),
      await openWork(id, await sessionCookie(stranger)),
    ]) {
      expect(body).not.toContain(WORK_DESCRIBE_PATH);
      expect(body).not.toContain(WORK_SAVE_PATH);
    }
  });

  it('下書きでも説明の欄を出し、保存しても作者にしか見えないことを押す前に言う（#664 / #673）', async () => {
    const { userId, id } = await seedReady('form-draft');
    const body = await openEdit(id, await sessionCookie(userId));
    expect(body).toContain(`name="${WORK_SAVE_DESCRIPTION_FIELD}"`);
    expect(body).toContain('下書きのあいだは、説明とタグはあなたにだけ見えます。');
    expect(body).toContain('公開すると、作品ページを開いた人なら誰でも読めます。');
    expect(body).not.toContain('公開している作品にだけ保存できます');
  });

  it('取り下げた作品にはフォームも説明も出さない', async () => {
    const { userId, id } = await seedPublished('form-removed');
    await describeGame(env, id, userId, '取り下げる前の説明', 1_700_000_000);
    await markGameRemoved(id);

    const body = await openEdit(id, await sessionCookie(userId));
    expect(body).not.toContain(WORK_DESCRIBE_PATH);
    expect(body).not.toContain(WORK_SAVE_PATH);
    expect(body).not.toContain('取り下げる前の説明');
  });
});

describe('作者は公開済みの作品に説明を書け、作品ページに出る（#388）', () => {
  it('作者が書くとエディットページへ戻り（#664）、誰が開いても説明が出る', async () => {
    const { userId, id } = await seedPublished('owner-write');

    const response = await postDescribe(
      id,
      '矢印キーで動かします。\r\n\r\n素材: ねこの絵は自作です。',
      await sessionCookie(userId),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workEditPath(id));
    // **`\r\n` は `\n` へ畳んで保存する**（ブラウザは `<textarea>` の改行を `\r\n` で送る）。
    expect(await descriptionOf(id)).toBe('矢印キーで動かします。\n\n素材: ねこの絵は自作です。');

    // 未ログインの閲覧者にも出る（公開済みの作品の本文である）。
    const body = await openWork(id);
    expect(body).toContain('作品の説明');
    expect(body).toContain('<p>矢印キーで動かします。</p>');
    expect(body).toContain('<p>素材: ねこの絵は自作です。</p>');
  });

  it('段落の中の改行は <br> になる', async () => {
    const { userId, id } = await seedPublished('owner-br');
    await describeGame(env, id, userId, '1 行目\n2 行目', 1_700_000_000);
    expect(await openWork(id)).toContain('<p>1 行目<br>\n2 行目</p>');
  });

  it('説明が無ければ説明の見出しを出さない', async () => {
    const { id } = await seedPublished('owner-empty');
    expect(await openWork(id)).not.toContain('<h3>作品の説明</h3>');
  });

  it('説明を消す（空にする）ことができ、それも履歴に残る', async () => {
    const { userId, id } = await seedPublished('owner-clear');
    await describeGame(env, id, userId, 'いったん書いた説明', 1_700_000_000);

    const outcome = await describeGame(env, id, userId, '  \n ', 1_700_000_100);

    expect(outcome).toEqual({ ok: true, description: '', changed: true });
    expect(await descriptionOf(id)).toBe('');
    expect((await historyOf(id))[0]).toMatchObject({
      old_description: 'いったん書いた説明',
      new_description: '',
    });
  });

  it('JSON でも書ける（結果の説明と changed が返る）', async () => {
    const { userId, id } = await seedPublished('owner-json');
    const response = await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${WORK_DESCRIBE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await sessionCookie(userId) },
        body: JSON.stringify({
          [WORK_DESCRIBE_GAME_ID_FIELD]: id,
          [WORK_DESCRIBE_TEXT_FIELD]: ' JSON の説明 ',
        }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      described: true,
      description: 'JSON の説明',
      changed: true,
    });
  });

  it('説明でない値（文字列でない・項目が無い）は 400 で、説明は変わらない', async () => {
    const { userId, id } = await seedPublished('owner-json-bad');
    const cookie = await sessionCookie(userId);
    for (const payload of [
      { [WORK_DESCRIBE_GAME_ID_FIELD]: id, [WORK_DESCRIBE_TEXT_FIELD]: { evil: true } },
      { [WORK_DESCRIBE_GAME_ID_FIELD]: id },
    ]) {
      const response = await dispatch(
        workPageRoutes,
        new Request(`${APP_ORIGIN}${WORK_DESCRIBE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(payload),
        }),
        testEnv(),
      );
      expect(response.status).toBe(400);
    }
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });
});

describe('説明を書けるのは、公開済みの作品の作者だけである（#388）', () => {
  it('未ログインは断られ、説明も履歴も変わらない', async () => {
    const { id } = await seedPublished('anon');

    const response = await postDescribe(id, 'のっとられた説明');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('他人の作品には書けない（説明も履歴も変わらない）', async () => {
    const { id } = await seedPublished('stranger-write');
    const stranger = await seedUser('stranger-writer');

    const response = await postDescribe(id, 'のっとられた説明', await sessionCookie(stranger));

    // **理由を撃ち分けない**（他人の作品は「無い」と同じ扱い。`renameGame` と同じ）。
    expect(response.status).toBe(404);
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
    // 関数を直接呼んでも同じ（画面の条件は経路の関門ではない）。
    expect(await describeGame(env, id, stranger, 'のっとられた説明')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await descriptionOf(id)).toBe('');
  });

  it('下書きの作品には書けない（公開後に書くもの）', async () => {
    const { userId, id } = await seedReady('draft-write');

    const response = await postDescribe(id, '公開前の説明', await sessionCookie(userId));

    expect(response.status).toBe(409);
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('取り下げた作品には書けない', async () => {
    const { userId, id } = await seedPublished('removed-write');
    await markGameRemoved(id);

    expect(await describeGame(env, id, userId, '取り下げた後の説明')).toEqual({
      ok: false,
      reason: 'removed',
    });
    expect(await descriptionOf(id)).toBe('');
  });
});

describe('HTML をそのまま描画しない（#388）', () => {
  it('説明に入れた HTML は、表示でもフォームの初期値でもエスケープされる', async () => {
    const { userId, id } = await seedPublished('escape');
    const evil = '</textarea><script>alert(1)</script><b onmouseover="x">太字</b>';
    await describeGame(env, id, userId, evil, 1_700_000_000);

    // **保存は入力のまま**（防ぐのは出力側のエスケープである。5.9）。
    expect(await descriptionOf(id)).toBe(evil);

    for (const body of [await openWork(id), await openWork(id, await sessionCookie(userId))]) {
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).not.toContain('<b onmouseover');
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
    // **`</textarea>` を書かれても要素から抜け出せない。** フォームの初期値として
    // エスケープされた形で入り、生の閉じタグは作者の画面に 1 つ（本物）しか無い。
    const ownerBody = await openWork(id, await sessionCookie(userId));
    expect(ownerBody).toContain('&lt;/textarea&gt;');
    expect(ownerBody.match(/<\/textarea>/gu)?.length).toBe(
      ownerBody.match(/<textarea\b/gu)?.length,
    );
  });
});

describe('8.3 の表を掛ける（#388。#366 の inspectText を共有する）', () => {
  // **表から 1 語借りる**（語を書き写さない。`test/title-rename.test.ts` と同じ）。
  const denied = DENIED_TERMS[0]!;

  it('表の語を含む説明は断られ、説明も履歴も変わらない', async () => {
    const { userId, id } = await seedPublished('denied');

    const outcome = await describeGame(env, id, userId, `遊び方\nこれは${denied.term}です`);

    expect(outcome).toEqual({ ok: false, reason: 'denied-term' });
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });

  it('応答に語も分類も出ない（8.2 の方針に倣う）', async () => {
    const { userId, id } = await seedPublished('denied-response');

    const response = await postDescribe(id, `これは${denied.term}です`, await sessionCookie(userId));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain(denied.term);
    expect(body).not.toContain(denied.category);
    expect(body).toContain('使えない表現が含まれています');
  });
});

describe('形の検査（長さは切らずに断る・禁じた文字は表示名と同じ組）', () => {
  it(`${MAX_DESCRIPTION_LENGTH} 文字ちょうどは通り、1 文字超えると断る（黙って切らない）`, async () => {
    expect(validateDescription('あ'.repeat(MAX_DESCRIPTION_LENGTH)).ok).toBe(true);
    expect(validateDescription('あ'.repeat(MAX_DESCRIPTION_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });

    const { userId, id } = await seedPublished('too-long');
    const response = await postDescribe(
      id,
      'あ'.repeat(MAX_DESCRIPTION_LENGTH + 1),
      await sessionCookie(userId),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`${MAX_DESCRIPTION_LENGTH} 文字まで`);
    expect(await descriptionOf(id)).toBe('');
  });

  it('長さはコードポイントで数え、改行（\\r\\n）は 1 文字に数える', () => {
    expect(validateDescription('🐱'.repeat(MAX_DESCRIPTION_LENGTH)).ok).toBe(true);
    expect(validateDescription('🐱'.repeat(MAX_DESCRIPTION_LENGTH + 1)).ok).toBe(false);
    const withNewlines = `${'あ\r\n'.repeat(MAX_DESCRIPTION_LENGTH / 2 - 1)}ああ`;
    expect(validateDescription(withNewlines).ok).toBe(true);
  });

  it('先頭や末尾に置いた禁じた文字も、trim で消さずに断る', () => {
    // `String#trim` は U+2028 / U+2029 とタブを除く（PR #401 の Copilot レビュー）。
    for (const character of ['\u2028', '\u2029', '\t', '\u202e']) {
      expect(validateDescription(`${character}遊び方`).ok).toBe(false);
      expect(validateDescription(`遊び方${character}`).ok).toBe(false);
    }
    // 前後の空白と改行は除いて通す。
    expect(validateDescription('\n  遊び方 \r\n')).toEqual({ ok: true, value: '遊び方' });
  });

  it('改行（LF / CR / CRLF）は通り、LF へ畳まれる', () => {
    expect(validateDescription('a\nb\r\nc\rd')).toEqual({ ok: true, value: 'a\nb\nc\nd' });
  });

  it('改行以外で禁じる文字の組は、表示名の検査と 1 文字も違わない', () => {
    // **書き写した組は必ず腐る**（shared-ai-rules 12 章）。`src/games.ts` は束の都合で
    // `src/account.ts` を import できないので、**振る舞いを文字ごとに突き合わせる。**
    // 基本多言語面をすべてと、補助面の代表（絵文字・タグ文字）を見る。
    const mismatches: string[] = [];
    const codePoints: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      codePoints.push(cp);
    }
    codePoints.push(0x1f431, 0xe0001, 0xe007f, 0x10fffd);
    for (const cp of codePoints) {
      // **改行だけは説明が持つ**（LF はそのまま、CR は LF へ畳む）。
      if (cp === 0x0a || cp === 0x0d) {
        continue;
      }
      const sample = `a${String.fromCodePoint(cp)}b`;
      const nameRefused =
        !validateDisplayName(sample).ok &&
        (validateDisplayName(sample) as { reason: string }).reason === 'control-char';
      const descriptionRefused = !validateDescription(sample).ok;
      if (nameRefused !== descriptionRefused) {
        mismatches.push(cp.toString(16));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('禁じた文字を含む説明は断られる（タブ・NEL・行区切り・RLO）', async () => {
    for (const character of ['\t', '', ' ', '‮']) {
      expect(validateDescription(`遊び方${character}です`)).toEqual({
        ok: false,
        reason: 'forbidden-character',
      });
    }
    const { userId, id } = await seedPublished('forbidden');
    const response = await postDescribe(id, '遊び方‮です', await sessionCookie(userId));
    expect(response.status).toBe(400);
    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });
});

describe('変更の間隔（表示名と同じ考え方。#388）', () => {
  it(`前回から ${DESCRIPTION_CHANGE_INTERVAL_SECONDS} 秒経つまでは断り、1 行も書かない`, async () => {
    const { userId, id } = await seedPublished('interval');
    const start = 1_700_010_000;
    await describeGame(env, id, userId, '1 回目', start);

    const early = await describeGame(
      env,
      id,
      userId,
      '2 回目',
      start + DESCRIPTION_CHANGE_INTERVAL_SECONDS - 1,
    );
    expect(early).toEqual({ ok: false, reason: 'too-soon' });
    expect(await descriptionOf(id)).toBe('1 回目');
    expect(await historyOf(id)).toHaveLength(1);

    const later = await describeGame(
      env,
      id,
      userId,
      '2 回目',
      start + DESCRIPTION_CHANGE_INTERVAL_SECONDS,
    );
    expect(later).toEqual({ ok: true, description: '2 回目', changed: true });
    expect(await historyOf(id)).toHaveLength(2);
  });

  it('同じ説明の入れ直しは、間隔の内側でも失敗にしない（説明も履歴も動かさない）', async () => {
    const { userId, id } = await seedPublished('interval-same');
    await describeGame(env, id, userId, 'おなじ説明', 1_700_020_000);

    const outcome = await describeGame(env, id, userId, ' おなじ説明\r\n', 1_700_020_001);

    expect(outcome).toEqual({ ok: true, description: 'おなじ説明', changed: false });
    expect(await historyOf(id)).toHaveLength(1);
  });

  it('間隔の内側の要求は 429 で断る', async () => {
    const { userId, id } = await seedPublished('interval-http');
    const cookie = await sessionCookie(userId);
    expect((await postDescribe(id, '1 回目', cookie)).status).toBe(303);
    const response = await postDescribe(id, '2 回目', cookie);
    expect(response.status).toBe(429);
    expect(await descriptionOf(id)).toBe('1 回目');
  });
});

describe('説明と履歴は 1 つの batch で書く（#366 / #361 の規律）', () => {
  it('説明を変えると履歴が 1 行増える（旧い説明と新しい説明の両方を持つ）', async () => {
    const { userId, id } = await seedPublished('history');
    await describeGame(env, id, userId, 'はじめの説明', 1_700_030_000);
    await describeGame(env, id, userId, 'つぎの説明', 1_700_030_100);

    const history = await historyOf(id);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({
      old_description: 'はじめの説明',
      new_description: 'つぎの説明',
      changed_at: 1_700_030_100,
    });
    // 前の行は書き換わっていない（追記のみ）。
    expect(history[1]).toEqual({
      old_description: '',
      new_description: 'はじめの説明',
      changed_at: 1_700_030_000,
    });
  });

  it('履歴の追記に失敗したら説明も変わらない', async () => {
    const { userId, id } = await seedPublished('history-atomic');

    // **`changed_at > 0` の CHECK を踏ませる**（`migrations/0028_game_descriptions.sql`）。
    // 履歴の insert が落ちると、**batch ごと巻き戻って UPDATE も入らない。**
    await expect(describeGame(env, id, userId, 'あたらしい説明', 0)).rejects.toThrow();

    expect(await descriptionOf(id)).toBe('');
    expect(await historyOf(id)).toHaveLength(0);
  });
});

describe('説明の変更は審査状態を戻す（#366 に揃える / #404）', () => {
  it('通報の無い cleared の作品の説明を変えると NULL へ戻る', async () => {
    const { userId, id } = await seedPublished('review-cleared');
    await setReviewState(id, REVIEW_CLEARED);

    await describeGame(env, id, userId, '書き換えた説明');

    expect(await reviewStateOf(id)).toBeNull();
  });

  it('通報が無ければ queued にはならず、queued の作品は queued のまま', async () => {
    const plain = await seedPublished('review-null');
    await describeGame(env, plain.id, plain.userId, '説明');
    expect(await reviewStateOf(plain.id)).toBeNull();

    const queued = await seedPublished('review-queued');
    await setReviewState(queued.id, REVIEW_QUEUED);
    await describeGame(env, queued.id, queued.userId, '説明');
    // **説明の変更で審査待ちを解けてはいけない。**
    expect(await reviewStateOf(queued.id)).toBe(REVIEW_QUEUED);
  });

  it('断られた変更は審査状態を動かさない', async () => {
    const { userId, id } = await seedPublished('review-refused');
    await setReviewState(id, REVIEW_CLEARED);
    const stranger = await seedUser('review-refused-stranger');

    await describeGame(env, id, stranger, '他人の説明');

    expect(await reviewStateOf(id)).toBe(REVIEW_CLEARED);
    // 作者の要求でも、同じ説明（空）の入れ直しは何も変えない。
    await describeGame(env, id, userId, '');
    expect(await reviewStateOf(id)).toBe(REVIEW_CLEARED);
  });
});

describe('履歴は作品と同じ寿命である（確定26 / 3.7 の削除規約。0027 と同じ形）', () => {
  it('作品の行を指す外部キーと、(game_id, changed_at) の索引を持つ', async () => {
    const keys = await env.DB.prepare(
      `pragma foreign_key_list(${DESCRIPTION_CHANGES_TABLE})`,
    ).all<{ table: string; from: string; to: string }>();
    expect(keys.results).toHaveLength(1);
    expect(keys.results[0]).toMatchObject({ table: 'games', from: 'game_id', to: 'id' });

    const columns = await env.DB.prepare(
      "select name from pragma_index_info('description_changes_game_changed_idx') order by seqno",
    ).all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(['game_id', 'changed_at']);
  });

  it('作品の行を消すときに履歴も消せる（順序は履歴が先）', async () => {
    const { userId, id } = await seedPublished('lifetime');
    await describeGame(env, id, userId, '説明', 1_700_040_000);
    expect(await historyOf(id)).toHaveLength(1);

    // 他の表（`title_changes` 以外にも）が作品を指していないことは前提にしない。
    // この作品に改名の履歴は無いので、説明の履歴を先に消せば作品の行を消せる。
    await env.DB.batch([
      env.DB.prepare(`delete from ${DESCRIPTION_CHANGES_TABLE} where game_id = ?`).bind(id),
      env.DB.prepare('delete from games where id = ?').bind(id),
    ]);

    expect(await historyOf(id)).toHaveLength(0);
  });
});

describe('説明は概要欄の「もっと見る」から読める（#665。#627 の枠の直前の折りたたみを畳んだ）', () => {
  /** 概要欄の「もっと見る」の折りたたみの開始タグ。 */
  const MORE = '<details class="gf-watch-overview-more">\n<summary>もっと見る</summary>';

  it('説明があると、概要欄の「もっと見る」の中に出る（最初は閉じている）', async () => {
    const { userId, id } = await seedPublished('peek-shown');
    await describeGame(env, id, userId, '遊び方: 左右キーで動かします。', 1_700_000_000);
    const body = await openWork(id);

    expect(body).toContain(MORE);
    // **最初は閉じている**（`open` を付けない）。
    expect(body).not.toContain('<details class="gf-watch-overview-more" open');
    // 中身は従来と同じ見出しと段落である。
    const more = body.slice(body.indexOf(MORE));
    expect(more).toContain('<h3>作品の説明</h3>');
    expect(more).toContain('<p>遊び方: 左右キーで動かします。</p>');
  });

  it('ゲームの枠より後ろにあり、二重に出さない（#665 でゲームを最上段へ上げた）', async () => {
    const { userId, id } = await seedPublished('peek-order');
    await describeGame(env, id, userId, '二重に出ないことを見る説明です。', 1_700_000_000);
    const body = await openWork(id);

    const moreAt = body.indexOf(MORE);
    const frameAt = body.indexOf('<noscript class="gf-play-noscript">');
    expect(moreAt).toBeGreaterThan(-1);
    expect(frameAt).toBeGreaterThan(-1);
    expect(moreAt).toBeGreaterThan(frameAt);
    // **本文（`.gf-work-description`）は 1 つだけ**——二重に出さない。#627 の折りたたみも残っていない。
    expect(body.split('<div class="gf-work-description">').length - 1).toBe(1);
    expect(body).not.toContain('gf-work-description-peek');
    expect(body.indexOf('<div class="gf-work-description">')).toBeGreaterThan(moreAt);
  });

  it('説明が無ければ説明の見出しを出さない（「もっと見る」は元ゲームと作品の情報のために残る）', async () => {
    const { id } = await seedPublished('peek-empty');
    const body = await openWork(id);
    expect(body).not.toContain('<h3>作品の説明</h3>');
    expect(body).toContain(MORE);
  });

  it('JavaScript を要求しない（details と summary だけで組む）', async () => {
    const { userId, id } = await seedPublished('peek-nojs');
    await describeGame(env, id, userId, 'スクリプト無しで開くことを見る説明です。', 1_700_000_000);
    const body = await openWork(id);

    const more = /<details class="gf-watch-overview-more">[\s\S]*?<\/details>/u.exec(body);
    expect(more).not.toBeNull();
    expect(more![0]).not.toContain('<script');
    expect(more![0]).not.toContain('onclick');
  });
});

describe('折りたたみは説明の形で壊れない（#627 の acceptance。#665 から概要欄）', () => {
  it('上限に近い長い説明でも、本文は「もっと見る」の中にあり、段落は切れない', async () => {
    const { userId, id } = await seedPublished('peek-long');
    // **上限（1000 文字）に近い長さにする。** 超えると `describeGame` が断るので、900〜1000 の間に収める。
    const long = Array.from({ length: 5 }, (_, i) => `${i + 1} 段落目です。`.repeat(24)).join('\n\n');
    expect([...long].length).toBeGreaterThan(900);
    expect([...long].length).toBeLessThanOrEqual(1000);
    expect((await describeGame(env, id, userId, long, 1_700_000_000)).ok).toBe(true);
    const body = await openWork(id);

    const moreAt = body.indexOf('<details class="gf-watch-overview-more">');
    const summaryEnd = body.indexOf('</summary>', moreAt);
    expect(body.indexOf('<div class="gf-work-description">')).toBeGreaterThan(summaryEnd);
    const description = body.slice(
      body.indexOf('<div class="gf-work-description">'),
      body.indexOf('</div>', body.indexOf('<div class="gf-work-description">')),
    );
    expect(description.split('<p>').length - 1).toBe(5);
  });

  it('改行だけの説明は空として扱い、説明の見出しを出さない', async () => {
    const { userId, id } = await seedPublished('peek-blank');
    const outcome = await describeGame(env, id, userId, '  \n\n \n ', 1_700_000_000);
    expect(outcome).toEqual({ ok: true, description: '', changed: false });
    expect(await openWork(id)).not.toContain('<h3>作品の説明</h3>');
  });
});
