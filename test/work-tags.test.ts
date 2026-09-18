import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PATH } from '../src/auth/google.js';
import {
  WORK_TAGS_CHANGE_INTERVAL_SECONDS,
  claimGenerationJob,
  completeGame,
  createForkedGame,
  createPendingGame,
  hashJobToken,
  publishGame,
  retagGame,
  validateWorkTags,
  workTagsOf,
} from '../src/games.js';
import { REVIEW_CLEARED, REVIEW_QUEUED, REVIEW_STATE_COLUMN } from '../src/reports.js';
import { WORK_EDIT_FORM_ID, workRoutes } from '../src/work-edit.js';
import { workEditPath } from '../src/work-edit-paths.js';
import { WORK_SAVE_PATH } from '../src/work-save.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { knownWorkTags, workTagListPath } from '../src/work-card.js';
import {
  WORK_RETAG_GAME_ID_FIELD,
  WORK_RETAG_PATH,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import { MAX_WORK_TAGS, WORK_TAGS, WORK_TAG_FIELD } from '../src/work-tags.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';
import { markGameRemoved } from './helpers/removed-work.js';

/**
 * 作品のタグ（#376 / 仕様 2.3.5・2.3.6・5.4）。
 *
 * **`test/work-page.test.ts` と分けている**（`test/title-rename.test.ts` と同じ理由。同じ波の
 * 別レーンが作品ページの近くを触っている）。一覧の絞り込みは `test/works-list.test.ts`、公開の
 * 口でタグを選ぶことは `test/publish.test.ts`、索引の綴りは `test/schema-tags.test.ts` が見る。
 *
 * # この検査が見ているもの
 *
 *   1. 語彙が利用者の決定どおりの 8 個で、識別子が URL と D1 にそのまま載る形であること
 *   2. 検査の規則（語彙に無い値・4 個以上を断る。語彙の順に並べ、重複を畳む）
 *   3. 画面が語彙に無い値・欠けた値で壊れないこと
 *   4. **付け直しは作者だけができ、未ログイン・他人・未公開は断られ、何も書かないこと
 *      （変異で確認した）**
 *   5. 付け直しの間隔・同じ組の入れ直し・審査状態に触れないこと
 *   6. **フォークは親のタグを受け継がない**こと
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-tags-00001';

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
  const id = `tags-user-${suffix}`;
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
  const pending = await createPendingGame(env, userId, { prompt: `タグの${suffix}` });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * 公開済みの作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param tags 公開のときに選ぶタグ
 * @returns 作者の id と作品 id
 */
async function seedPublished(
  suffix: string,
  tags: readonly string[] = [],
): Promise<{ userId: string; id: string }> {
  const seeded = await seedReady(suffix);
  const outcome = await publishGame(env, seeded.id, seeded.userId, 1_000, tags);
  expect(outcome.ok).toBe(true);
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
 * いま保存されているタグの枠と付け直しの時刻を読む。
 *
 * @param gameId 作品 id
 * @returns 枠と時刻
 */
async function slotsOf(
  gameId: string,
): Promise<{ tag1: string | null; tag2: string | null; tag3: string | null; tags_set_at: number | null }> {
  const row = await env.DB.prepare('select tag1, tag2, tag3, tags_set_at from games where id = ?')
    .bind(gameId)
    .first<{ tag1: string | null; tag2: string | null; tag3: string | null; tags_set_at: number | null }>();
  if (row === null) {
    throw new Error(`作品が見つかりません: ${gameId}`);
  }
  return row;
}

/**
 * 付け直しの経路へ POST する（素の `<form>` と同じ形。チェックを外した項目は送られない）。
 *
 * @param gameId 作品 id
 * @param tags 選んだタグ
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function postRetag(
  gameId: string,
  tags: readonly string[],
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const body = new URLSearchParams([
    [WORK_RETAG_GAME_ID_FIELD, gameId],
    ...tags.map((tag): [string, string] => [WORK_TAG_FIELD, tag]),
  ]);
  return await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${WORK_RETAG_PATH}`, { method: 'POST', headers, body }),
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

/**
 * エディットページを開く（#664。タグの欄は作品ページからここへ移った）。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 本文
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
  return await response.text();
}

/**
 * エディットページの、まとめて保存するフォームだけを切り出す。
 *
 * @param body エディットページの本文
 * @returns `<form id="work-edit-form" …>` から `</form>` まで
 */
function saveFormOf(body: string): string {
  const form = body.slice(body.indexOf(`<form id="${WORK_EDIT_FORM_ID}"`));
  return form.slice(0, form.indexOf('</form>'));
}

beforeAll(async () => {
  await applySchema();
});

describe('語彙（#376 の利用者の決定）', () => {
  it('8 個のラベルが決定どおりの順に並ぶ', () => {
    expect(WORK_TAGS.map((tag) => tag.label)).toEqual([
      'アクション',
      'パズル',
      'シューティング',
      'レース・スポーツ',
      'ボード・カード',
      'リズム・音',
      '放置',
      'その他',
    ]);
  });

  it('識別子は小文字の ASCII とハイフンだけで、URL に載せても形が変わらない', () => {
    for (const tag of WORK_TAGS) {
      expect(tag.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
      expect(encodeURIComponent(tag.id)).toBe(tag.id);
    }
  });

  it('識別子もラベルも重複しない', () => {
    expect(new Set(WORK_TAGS.map((tag) => tag.id)).size).toBe(WORK_TAGS.length);
    expect(new Set(WORK_TAGS.map((tag) => tag.label)).size).toBe(WORK_TAGS.length);
  });

  it('上限は 3 個である（2.3.5）', () => {
    expect(MAX_WORK_TAGS).toBe(3);
  });
});

describe('検査の規則（validateWorkTags）', () => {
  it('タグ無しを通す（公開の入力を必須にしない）', () => {
    expect(validateWorkTags([])).toEqual({ ok: true, tags: [] });
  });

  it('語彙の順に並べ直し、重複を畳む（枠は tag1 から詰める・重複しない）', () => {
    expect(validateWorkTags(['other', 'action', 'puzzle', 'action'])).toEqual({
      ok: true,
      tags: ['action', 'puzzle', 'other'],
    });
  });

  it('4 個以上は断る（先頭の 3 個を黙って採らない）', () => {
    expect(validateWorkTags(['action', 'puzzle', 'shooting', 'idle'])).toEqual({
      ok: false,
      reason: 'too-many-tags',
    });
  });

  it('語彙に無い値・空文字・大文字違いは断る（黙って読み飛ばさない）', () => {
    for (const bad of ['unknown', '', 'Puzzle', 'パズル']) {
      expect(validateWorkTags(['action', bad])).toEqual({ ok: false, reason: 'unknown-tag' });
    }
  });

  it('行から読むときは枠の順に、NULL と空を除く', () => {
    expect(workTagsOf({ tag1: 'puzzle', tag2: null, tag3: 'other' })).toEqual(['puzzle', 'other']);
    expect(workTagsOf({})).toEqual([]);
    expect(workTagsOf({ tag1: '', tag2: 3, tag3: null })).toEqual([]);
  });
});

describe('画面は語彙に照らして描く（knownWorkTags）', () => {
  it('語彙にある識別子にだけラベルを添える', () => {
    expect(knownWorkTags(['puzzle', 'not-in-vocabulary', 'idle'])).toEqual([
      { id: 'puzzle', label: 'パズル' },
      { id: 'idle', label: '放置' },
    ]);
  });

  it('配列でない・文字列でない・重複・4 個以上でも壊れない', () => {
    expect(knownWorkTags(undefined)).toEqual([]);
    expect(knownWorkTags(null)).toEqual([]);
    expect(knownWorkTags('puzzle')).toEqual([]);
    expect(knownWorkTags([1, { id: 'puzzle' }, 'puzzle', 'puzzle'])).toEqual([
      { id: 'puzzle', label: 'パズル' },
    ]);
    expect(knownWorkTags(['action', 'puzzle', 'shooting', 'idle'])).toHaveLength(MAX_WORK_TAGS);
  });

  it('タグのリンクは絞り込んだ一覧を指す', () => {
    expect(workTagListPath('race-sports')).toBe('/works?tag=race-sports');
  });
});

describe('エディットページのタグのチェックボックス（5.4 / #376 / #664）', () => {
  it('下書きでも任意のチェックボックスが 8 個並び、まとめて保存する口へ送る（必須にしない）', async () => {
    const { userId, id } = await seedReady('publish-form');
    const body = await openEdit(id, await sessionCookie(userId));
    const saveForm = saveFormOf(body);

    expect(saveForm).toContain(`action="${WORK_SAVE_PATH}"`);
    for (const tag of WORK_TAGS) {
      expect(saveForm).toContain(`name="${WORK_TAG_FIELD}" value="${tag.id}"`);
      expect(saveForm).toContain(tag.label);
    }
    expect(saveForm.split('type="checkbox"').length - 1).toBe(WORK_TAGS.length);
    // **必須にしない**（何も選ばずに公開すればタグ無しで公開される）。作品名の欄だけが `required` を持つ。
    expect(saveForm.split('required').length - 1).toBe(1);
    // **1 項目ずつの付け直しの口・公開の口は出さない**（まとめて保存する口に畳んだ。#664）。
    expect(body).not.toContain(WORK_RETAG_PATH);
    expect(body).not.toContain('action="/api/publish"');
  });
});

describe('作品ページのタグと付け直しの口（#376）', () => {
  it('公開済みの作品のタグは誰にでも出て、絞り込んだ一覧へのリンクになる', async () => {
    const { id } = await seedPublished('page-tags', ['rhythm-sound', 'action']);
    const body = await openWork(id);
    // **1 つずつがチップ**（#474 / 仕様 2.5.5）。
    expect(body).toContain(`<a class="gf-chip" href="${workTagListPath('action')}">アクション</a>`);
    expect(body).toContain(`<a class="gf-chip" href="${workTagListPath('rhythm-sound')}">リズム・音</a>`);
  });

  it('語彙に無い値が行に入っていても、本文に出さず 200 を返す', async () => {
    const { id } = await seedPublished('page-unknown');
    await env.DB.prepare("update games set tag1 = '<b>not-in-vocabulary</b>' where id = ?")
      .bind(id)
      .run();
    const response = await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${workPagePath(id)}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('not-in-vocabulary');
    expect(body).not.toContain('class="gf-work-tags"');
  });

  it('作者のエディットページには、いまのタグを選んだ状態のチェックボックスが出る（#664）', async () => {
    const { userId, id } = await seedPublished('page-owner', ['idle']);
    const saveForm = saveFormOf(await openEdit(id, await sessionCookie(userId)));
    expect(saveForm).toContain(`value="idle" checked`);
    expect(saveForm).not.toContain(`value="puzzle" checked`);
  });

  it('未ログイン・他人の画面にはタグを変えるフォームが 1 バイトも出ない', async () => {
    const { id } = await seedPublished('page-stranger', ['idle']);
    const stranger = await seedUser('page-onlooker');
    for (const body of [
      await openWork(id),
      await openWork(id, await sessionCookie(stranger)),
      await openEdit(id),
      await openEdit(id, await sessionCookie(stranger)),
    ]) {
      expect(body).not.toContain(WORK_RETAG_PATH);
      expect(body).not.toContain(WORK_SAVE_PATH);
    }
  });
});

describe('付け直せるのは公開済みの作品の作者だけである（#376）', () => {
  it('作者の付け直しは通り、語彙の順に tag1 から詰めてエディットページへ戻す（#664）', async () => {
    const { userId, id } = await seedPublished('owner-retag', ['idle']);

    const response = await postRetag(id, ['other', 'puzzle'], await sessionCookie(userId));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workEditPath(id));
    const slots = await slotsOf(id);
    expect([slots.tag1, slots.tag2, slots.tag3]).toEqual(['puzzle', 'other', null]);
    expect(slots.tags_set_at).not.toBeNull();
  });

  it('未ログインの付け直しは断られ、タグも変わらない', async () => {
    const { id } = await seedPublished('anon-retag', ['idle']);

    const fromForm = await postRetag(id, ['puzzle']);
    expect(fromForm.status).toBe(303);
    expect(fromForm.headers.get('location')).toBe(LOGIN_PATH);

    const fromApi = await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${WORK_RETAG_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [WORK_RETAG_GAME_ID_FIELD]: id, [WORK_TAG_FIELD]: ['puzzle'] }),
      }),
      testEnv(),
    );
    expect(fromApi.status).toBe(401);

    expect(await slotsOf(id)).toEqual({ tag1: 'idle', tag2: null, tag3: null, tags_set_at: null });
  });

  it('他人の付け直しは断られ、タグも変わらない（理由を撃ち分けない）', async () => {
    const { id } = await seedPublished('stranger-retag', ['idle']);
    const stranger = await seedUser('stranger-retagger');

    const response = await postRetag(id, ['puzzle'], await sessionCookie(stranger));

    expect(response.status).toBe(404);
    expect(await slotsOf(id)).toEqual({ tag1: 'idle', tag2: null, tag3: null, tags_set_at: null });
  });

  it('未公開の作品は付け直せない（タグは公開フォームで選ぶ）', async () => {
    const { userId, id } = await seedReady('draft-retag');

    const response = await postRetag(id, ['puzzle'], await sessionCookie(userId));

    expect(response.status).toBe(409);
    expect((await slotsOf(id)).tag1).toBeNull();
  });

  it('取り下げた作品は付け直せない', async () => {
    const { userId, id } = await seedPublished('removed-retag', ['idle']);
    await markGameRemoved(id);

    expect(await retagGame(env, id, userId, ['puzzle'], 5_000)).toEqual({
      ok: false,
      reason: 'removed',
    });
    expect((await slotsOf(id)).tag1).toBe('idle');
  });

  it('4 個以上・語彙に無い値は、行を引く前に断り、1 行も書かない', async () => {
    const { userId, id } = await seedPublished('invalid-retag', ['idle']);
    const cookie = await sessionCookie(userId);

    const tooMany = await postRetag(id, ['action', 'puzzle', 'shooting', 'other'], cookie);
    expect(tooMany.status).toBe(400);
    expect(await tooMany.text()).toContain(`${MAX_WORK_TAGS} 個まで`);

    const unknown = await postRetag(id, ['puzzle', 'unknown'], cookie);
    expect(unknown.status).toBe(400);

    expect(await slotsOf(id)).toEqual({ tag1: 'idle', tag2: null, tag3: null, tags_set_at: null });
  });

  it('全部外して送るとタグ無しになる（外すのも正当な操作である）', async () => {
    const { userId, id } = await seedPublished('clear-retag', ['idle', 'puzzle']);

    expect((await postRetag(id, [], await sessionCookie(userId))).status).toBe(303);

    const slots = await slotsOf(id);
    expect([slots.tag1, slots.tag2, slots.tag3]).toEqual([null, null, null]);
  });

  it('JSON では結果のタグと changed が返り、形の違う値は 400', async () => {
    const { userId, id } = await seedPublished('json-retag', ['idle']);
    const cookie = await sessionCookie(userId);
    const post = async (body: unknown): Promise<Response> =>
      await dispatch(
        workPageRoutes,
        new Request(`${APP_ORIGIN}${WORK_RETAG_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
        testEnv(),
      );

    const retagged = await post({ [WORK_RETAG_GAME_ID_FIELD]: id, [WORK_TAG_FIELD]: ['shooting'] });
    expect(retagged.status).toBe(200);
    expect(await retagged.json()).toEqual({ retagged: true, tags: ['shooting'], changed: true });

    const notArray = await post({ [WORK_RETAG_GAME_ID_FIELD]: id, [WORK_TAG_FIELD]: 'puzzle' });
    expect(notArray.status).toBe(400);
    expect((await slotsOf(id)).tag1).toBe('shooting');
  });

  it('JSON の tag が null なら断ってタグを外さず、項目が無ければタグを外す（PR #419 のレビュー）', async () => {
    const { userId, id } = await seedPublished('json-null-retag', ['idle', 'puzzle']);
    const cookie = await sessionCookie(userId);
    const post = async (body: unknown): Promise<Response> =>
      await dispatch(
        workPageRoutes,
        new Request(`${APP_ORIGIN}${WORK_RETAG_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
        testEnv(),
      );

    // **`null` を「項目が無い」と同じに扱わない**——扱うと、壊れた要求がタグを全部外す。
    const refused = await post({ [WORK_RETAG_GAME_ID_FIELD]: id, [WORK_TAG_FIELD]: null });
    expect(refused.status).toBe(400);
    expect(await slotsOf(id)).toEqual({ tag1: 'puzzle', tag2: 'idle', tag3: null, tags_set_at: null });

    // 対照: 項目ごと無ければタグを外す（チェックを全部外したフォームと同じ意味）。
    const cleared = await post({ [WORK_RETAG_GAME_ID_FIELD]: id });
    expect(cleared.status).toBe(200);
    const slots = await slotsOf(id);
    expect([slots.tag1, slots.tag2, slots.tag3]).toEqual([null, null, null]);
  });
});

describe('付け直しの間隔と、同じ組の入れ直し（#376 / 3.6）', () => {
  it('間隔の内側の付け直しは断られ、過ぎれば通る', async () => {
    const { userId, id } = await seedPublished('interval', ['idle']);

    expect((await retagGame(env, id, userId, ['puzzle'], 10_000)).ok).toBe(true);
    expect(
      await retagGame(env, id, userId, ['action'], 10_000 + WORK_TAGS_CHANGE_INTERVAL_SECONDS - 1),
    ).toEqual({ ok: false, reason: 'too-soon' });
    expect((await slotsOf(id)).tag1).toBe('puzzle');

    expect(
      (await retagGame(env, id, userId, ['action'], 10_000 + WORK_TAGS_CHANGE_INTERVAL_SECONDS)).ok,
    ).toBe(true);
    expect((await slotsOf(id)).tag1).toBe('action');
  });

  it('同じ組の入れ直しは、間隔の内側でも成功にし、時刻を動かさない', async () => {
    const { userId, id } = await seedPublished('same', ['idle']);
    expect(await retagGame(env, id, userId, ['puzzle', 'idle'], 20_000)).toEqual({
      ok: true,
      tags: ['puzzle', 'idle'],
      changed: true,
    });

    // 並びを変えて送っても同じ組である（語彙の順に並べ直してから比べる）。
    expect(await retagGame(env, id, userId, ['idle', 'puzzle'], 20_001)).toEqual({
      ok: true,
      tags: ['puzzle', 'idle'],
      changed: false,
    });
    expect((await slotsOf(id)).tags_set_at).toBe(20_000);
  });

  it('公開の時点では間隔を数え始めない（公開直後の付け間違いを待たせない）', async () => {
    const { userId, id } = await seedPublished('right-after', ['idle']);
    expect((await slotsOf(id)).tags_set_at).toBeNull();
    expect((await retagGame(env, id, userId, ['puzzle'], 1_001)).ok).toBe(true);
  });
});

describe('付け直しは審査状態に触れない（#376）', () => {
  for (const state of [REVIEW_CLEARED, REVIEW_QUEUED, null]) {
    it(`${state ?? 'NULL'} の作品を付け直しても審査状態は変わらない`, async () => {
      const { userId, id } = await seedPublished(`review-${state ?? 'null'}`, ['idle']);
      await env.DB.prepare(`update games set ${REVIEW_STATE_COLUMN} = ? where id = ?`)
        .bind(state, id)
        .run();

      expect((await retagGame(env, id, userId, ['puzzle'], 30_000)).ok).toBe(true);

      const row = await env.DB.prepare(`select ${REVIEW_STATE_COLUMN} as s from games where id = ?`)
        .bind(id)
        .first<{ s: string | null }>();
      expect(row?.s ?? null).toBe(state);
    });
  }
});

describe('フォークは親のタグを受け継がない（#376）', () => {
  it('タグの付いた作品をフォークしても、子はタグ無しで始まる', async () => {
    const { id: parentId } = await seedPublished('fork-parent', ['puzzle', 'idle']);
    const forker = await seedUser('forker');

    const child = await createForkedGame(env, forker, { prompt: '改造する' }, parentId);

    expect(await slotsOf(child.id)).toEqual({ tag1: null, tag2: null, tag3: null, tags_set_at: null });
  });
});
