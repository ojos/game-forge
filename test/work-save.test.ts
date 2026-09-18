import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PATH } from '../src/auth/google.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import {
  DESCRIPTION_CHANGES_TABLE,
  MAX_DESCRIPTION_LENGTH,
  claimGenerationJob,
  completeGame,
  createPendingGame,
  describeGame,
  hashJobToken,
  publishGame,
  retagGame,
} from '../src/games.js';
import type { OgpCaptureJob } from '../src/ogp.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workEditPath } from '../src/work-edit-paths.js';
import { PUBLISH_SOURCE_NOTICE } from '../src/work-page.js';
import {
  PUBLISH_CONFIRM_ITEMS,
  PUBLISH_IRREVERSIBLE_ITEMS,
  UNPUBLISH_CONFIRM_ITEMS,
  WORK_SAVE_CONFIRM_FIELD,
  WORK_SAVE_CONFIRMED,
  WORK_SAVE_DESCRIPTION_FIELD,
  WORK_SAVE_GAME_ID_FIELD,
  WORK_SAVE_PATH,
  WORK_SAVE_TITLE_FIELD,
  WORK_SAVE_VISIBILITY_FIELD,
  createWorkSaveRoutes,
} from '../src/work-save.js';
import { WORK_TAG_FIELD } from '../src/work-tags.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { markGameRemoved } from './helpers/removed-work.js';
import { applySchema } from './helpers/schema.js';

/**
 * エディットページのまとめて保存する口（`POST /api/works/save`。#664）。
 *
 * **acceptance の「1 回の保存で、作品名・説明・タグがまとめて変わる。公開設定は確認を通らないと変わらない」と、
 * constraints の「まとめて保存する経路でも、公開前の確認を省かない」「既存の口の検査を弱めない」を見る。**
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-save-endpoint-1';

/**
 * テスト用の env。**撮影の資格情報の形だけを入れる**（`src/ogp.ts` の撮影の起動は、設定が無いと段を呼ばない。
 * `test/publish.test.ts` と同じ）。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return {
    ...env,
    SESSION_SECRET: SECRET,
    BUILD_AWS_REGION: 'ap-northeast-1',
    BUILD_AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    BUILD_AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  } as Env;
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `save-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
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
 * 完成した作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param publish 公開しておくか
 * @param tags 公開するときのタグ
 * @returns 作者の id と作品 id
 */
async function seedWork(
  suffix: string,
  publish: boolean,
  tags: readonly string[] = [],
): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: `もとの題名 ${suffix}` });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-save-${suffix}` }));
  if (publish) {
    expect((await publishGame(env, pending.id, userId, 1_000, tags)).ok).toBe(true);
  }
  return { userId, id: pending.id };
}

/** 保存の前後で比べる作品の列。 */
interface SavedRow {
  status: string;
  title: string;
  description: string;
  tag1: string | null;
  tag2: string | null;
  tag3: string | null;
  preview_key: string | null;
  published_at: number | null;
}

/**
 * 作品の列を読む。
 *
 * @param id 作品 id
 * @returns 列
 */
async function rowOf(id: string): Promise<SavedRow> {
  const row = await env.DB.prepare(
    'select status, title, description, tag1, tag2, tag3, preview_key, published_at from games where id = ?',
  )
    .bind(id)
    .first<SavedRow>();
  expect(row).not.toBeNull();
  return row!;
}

/** 撮影と通知の呼び出しを記録する。 */
interface Spies {
  readonly captures: OgpCaptureJob[];
  readonly notices: string[];
}

/**
 * 保存の口を素の HTML フォームと同じ形で叩く。
 *
 * @param fields 送る項目（同じ名前を並べるときは配列）
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @param spies 撮影と通知の記録先
 * @returns レスポンス
 */
async function postSave(
  fields: Record<string, string | readonly string[]>,
  cookie: string | undefined,
  spies: Spies = { captures: [], notices: [] },
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of typeof value === 'string' ? [value] : value) {
      body.append(name, one);
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html,application/xhtml+xml',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    createWorkSaveRoutes(
      async (_env, job) => {
        spies.captures.push(job);
      },
      async (_env, gameId) => {
        spies.notices.push(gameId);
        return 'not-a-fork';
      },
    ),
    new Request(`${APP_ORIGIN}${WORK_SAVE_PATH}`, { method: 'POST', headers, body: body.toString() }),
    testEnv(),
  );
}

/**
 * エディットページのフォームが送る項目を組み立てる（いまの値を初期値にしたフォームを、そのまま押した形）。
 *
 * @param id 作品 id
 * @param values 送る値
 * @returns 項目
 */
function formFields(
  id: string,
  values: { title: string; description: string; tags: readonly string[]; visibility: string; confirm?: boolean },
): Record<string, string | readonly string[]> {
  const fields: Record<string, string | readonly string[]> = {
    [WORK_SAVE_GAME_ID_FIELD]: id,
    [WORK_SAVE_TITLE_FIELD]: values.title,
    [WORK_SAVE_DESCRIPTION_FIELD]: values.description,
    [WORK_TAG_FIELD]: values.tags,
    [WORK_SAVE_VISIBILITY_FIELD]: values.visibility,
  };
  if (values.confirm === true) {
    fields[WORK_SAVE_CONFIRM_FIELD] = WORK_SAVE_CONFIRMED;
  }
  return fields;
}

beforeAll(async () => {
  await applySchema();
});

describe('1 回の保存で、作品名・説明・タグがまとめて変わる（#664 の acceptance 2）', () => {
  it('公開中の作品の作品名・説明・タグを 1 回で変え、エディットページへ戻す', async () => {
    const { userId, id } = await seedWork('together', true, ['idle']);

    const response = await postSave(
      formFields(id, {
        title: 'あたらしい題名',
        // ブラウザは `<textarea>` の改行を `\r\n` で送る（`describeGame` が `\n` へ畳む）。
        description: '左右キーで動かします。\r\n\r\n素材は自作です。',
        tags: ['puzzle', 'action'],
        visibility: 'published',
      }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workEditPath(id));
    const row = await rowOf(id);
    expect(row.title).toBe('あたらしい題名');
    expect(row.description).toBe('左右キーで動かします。\n\n素材は自作です。');
    expect([row.tag1, row.tag2, row.tag3]).toEqual(['action', 'puzzle', null]);
    // 公開設定は変えていないので、確認の画面を通らず、公開のままである。
    expect(row.status).toBe('published');
  });

  it('変えていない項目は呼ばない（タグを付け直した直後でも、作品名だけの保存は変更の間隔に掛からない）', async () => {
    const { userId, id } = await seedWork('untouched', true, ['idle']);
    // 直前に説明とタグを変えた（どちらも 60 秒に 1 回まで）。
    const now = Math.floor(Date.now() / 1000);
    expect((await describeGame(env, id, userId, 'いまの説明', now)).ok).toBe(true);
    expect((await retagGame(env, id, userId, ['puzzle'], now)).ok).toBe(true);

    const response = await postSave(
      formFields(id, { title: '題名だけ変える', description: 'いまの説明', tags: ['puzzle'], visibility: 'published' }),
      await sessionCookie(userId),
    );
    expect(response.status).toBe(303);
    expect((await rowOf(id)).title).toBe('題名だけ変える');
  });

  it('JSON でも送れ、省いた項目は変えない', async () => {
    const { userId, id } = await seedWork('json', true, ['idle']);
    const response = await dispatch(
      createWorkSaveRoutes(async () => undefined, async () => 'not-a-fork'),
      new Request(`${APP_ORIGIN}${WORK_SAVE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await sessionCookie(userId) },
        body: JSON.stringify({ [WORK_SAVE_GAME_ID_FIELD]: id, [WORK_SAVE_TITLE_FIELD]: 'JSON の題名' }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, parts: ['作品名'] });
    const row = await rowOf(id);
    expect(row.title).toBe('JSON の題名');
    expect(row.tag1).toBe('idle');
  });
});

describe('公開設定は確認を通らないと変わらない（#664 の acceptance 2 / constraints）', () => {
  it('下書きを「公開」にして保存すると、何も書かずに確認の画面を出す（ソースが読めるようになる・戻せないもの）', async () => {
    const { userId, id } = await seedWork('confirm-publish', false);
    const before = await rowOf(id);
    const spies: Spies = { captures: [], notices: [] };

    const response = await postSave(
      formFields(id, { title: '公開する題名', description: '', tags: ['action'], visibility: 'published' }),
      await sessionCookie(userId),
      spies,
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<h1>この作品を公開しますか</h1>');
    // **公開前の確認（5.4 / #383 の決定 1）を省かない**——ソースが読めるようになることと、戻せないものを、
    // 公開のボタンより前に書く。
    const buttonAt = body.indexOf('>公開する</button>');
    expect(buttonAt).toBeGreaterThan(0);
    for (const item of [...PUBLISH_CONFIRM_ITEMS, ...PUBLISH_IRREVERSIBLE_ITEMS]) {
      expect(body.indexOf(item), item).toBeGreaterThan(0);
      expect(body.indexOf(item), item).toBeLessThan(buttonAt);
    }
    expect(PUBLISH_CONFIRM_ITEMS).toContain(PUBLISH_SOURCE_NOTICE);
    expect(body).toContain('あとから戻せないもの');
    // 送った値を持ち回し、確認の印を足して同じ口へ送り直す。
    expect(body).toContain(`<form method="post" action="${WORK_SAVE_PATH}">`);
    expect(body).toContain(`name="${WORK_SAVE_CONFIRM_FIELD}" value="${WORK_SAVE_CONFIRMED}"`);
    expect(body).toContain(`name="${WORK_SAVE_TITLE_FIELD}" value="公開する題名"`);
    expect(body).toContain(`name="${WORK_TAG_FIELD}" value="action"`);
    expect(body).toContain(`<a href="${workEditPath(id)}">公開せずに編集へ戻る</a>`);

    // **1 行も書いていない。** 撮影も通知も起こしていない。
    expect(await rowOf(id)).toEqual(before);
    expect(spies.captures).toEqual([]);
    expect(spies.notices).toEqual([]);
  });

  it('確認の画面から送り直すと公開し、作品名・説明・タグもあわせて保存する（撮影は 1 回だけ起こす）', async () => {
    const { userId, id } = await seedWork('confirmed-publish', false);
    const spies: Spies = { captures: [], notices: [] };

    const response = await postSave(
      formFields(id, {
        title: '公開する題名',
        description: '公開と同時に書く説明',
        tags: ['action', 'other'],
        visibility: 'published',
        confirm: true,
      }),
      await sessionCookie(userId),
      spies,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workEditPath(id));
    const row = await rowOf(id);
    expect(row.status).toBe('published');
    expect(row.published_at).not.toBeNull();
    expect(row.title).toBe('公開する題名');
    expect(row.description).toBe('公開と同時に書く説明');
    expect([row.tag1, row.tag2, row.tag3]).toEqual(['action', 'other', null]);
    // **公開の口と同じ 1 本（`runPublish`）を通る**——撮影と改造の通知を、実際に公開したときに 1 回だけ起こす。
    expect(spies.captures.map((job) => job.gameId)).toEqual([id]);
    expect(spies.notices).toEqual([id]);
  });

  it('公開中の作品を「下書き」にして保存すると、確認の画面が試遊 URL が変わること・フォークが残ることを言う', async () => {
    const { userId, id } = await seedWork('confirm-unpublish', true);
    const before = await rowOf(id);

    const response = await postSave(
      formFields(id, { title: before.title, description: '', tags: [], visibility: 'draft' }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<h1>公開をやめて下書きに戻しますか</h1>');
    const buttonAt = body.indexOf('>公開をやめて下書きに戻す</button>');
    expect(buttonAt).toBeGreaterThan(0);
    for (const item of UNPUBLISH_CONFIRM_ITEMS) {
      expect(body.indexOf(item), item).toBeGreaterThan(0);
      expect(body.indexOf(item), item).toBeLessThan(buttonAt);
    }
    expect(body).toContain('試遊用の URL は新しいものに変わります');
    expect(await rowOf(id)).toEqual(before);
  });

  it('確認の画面から送り直すと下書きに戻り、試遊 URL が作り直される', async () => {
    const { userId, id } = await seedWork('confirmed-unpublish', true);
    const before = await rowOf(id);

    const response = await postSave(
      formFields(id, { title: before.title, description: '', tags: [], visibility: 'draft', confirm: true }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(303);
    const row = await rowOf(id);
    expect(row.status).toBe('draft');
    expect(row.preview_key).not.toBe(before.preview_key);
  });

  it('JSON では確認が要ることを 409 で返し、何も書かない', async () => {
    const { userId, id } = await seedWork('json-confirm', false);
    const response = await dispatch(
      createWorkSaveRoutes(async () => undefined, async () => 'not-a-fork'),
      new Request(`${APP_ORIGIN}${WORK_SAVE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await sessionCookie(userId) },
        body: JSON.stringify({ [WORK_SAVE_GAME_ID_FIELD]: id, [WORK_SAVE_VISIBILITY_FIELD]: 'published' }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'confirmation-required', visibility: 'published' });
    expect((await rowOf(id)).status).toBe('draft');
  });
});

describe('1 項目ずつの口の検査を弱めない（#664 の constraints）', () => {
  it('他人の作品は 404 で、何も変わらない（存在しない作品と区別しない）', async () => {
    const { id } = await seedWork('stranger', true);
    const stranger = await seedUser('stranger-writer');
    const before = await rowOf(id);

    for (const visibility of ['published', 'draft']) {
      const response = await postSave(
        formFields(id, { title: 'のっとり', description: 'のっとり', tags: [], visibility, confirm: true }),
        await sessionCookie(stranger),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('編集へ戻る');
    }
    expect(await rowOf(id)).toEqual(before);
  });

  it('未ログインはログインへ送る', async () => {
    const { id } = await seedWork('anon', true);
    const response = await postSave(
      formFields(id, { title: 'のっとり', description: '', tags: [], visibility: 'published' }),
      undefined,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('下書きのまま説明を変えると、説明の口と同じ理由で断り、作品名も書かない（呼ぶ順）', async () => {
    const { userId, id } = await seedWork('draft-description', false);
    const before = await rowOf(id);

    const response = await postSave(
      formFields(id, { title: '変えた題名', description: '下書きの説明', tags: [], visibility: 'draft' }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain('説明は公開してから書けます');
    expect(body).toContain('何も保存していません。');
    expect(body).toContain(`<a href="${workEditPath(id)}">編集へ戻る</a>`);
    expect(await rowOf(id)).toEqual(before);
  });

  it('長すぎる説明は断る。先に保存できた作品名は、保存したと言う', async () => {
    const { userId, id } = await seedWork('too-long', true);

    const response = await postSave(
      formFields(id, {
        title: '先に保存される題名',
        description: 'あ'.repeat(MAX_DESCRIPTION_LENGTH + 1),
        tags: [],
        visibility: 'published',
      }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain(`${MAX_DESCRIPTION_LENGTH} 文字まで`);
    expect(body).toContain('<strong>作品名は保存しました。</strong>');
    const row = await rowOf(id);
    expect(row.title).toBe('先に保存される題名');
    expect(row.description).toBe('');
    const history = await env.DB.prepare(`select count(*) as n from ${DESCRIPTION_CHANGES_TABLE} where game_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(history?.n).toBe(0);
  });

  it('8.3 の語を含む作品名は断る（語も分類も言わない）', async () => {
    const { userId, id } = await seedWork('denied', true);
    const before = await rowOf(id);
    const denied = DENIED_TERMS[0]!;

    const response = await postSave(
      formFields(id, { title: `ねこの${denied.term}`, description: '', tags: [], visibility: 'published' }),
      await sessionCookie(userId),
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('この作品名は使えません');
    expect(body).not.toContain(denied.term);
    expect(await rowOf(id)).toEqual(before);
  });

  it('説明の変更の間隔（60 秒に 1 回）は、まとめて保存しても効く', async () => {
    const { userId, id } = await seedWork('interval', true);
    const cookie = await sessionCookie(userId);
    expect((await postSave(formFields(id, { title: (await rowOf(id)).title, description: '1 回目', tags: [], visibility: 'published' }), cookie)).status).toBe(303);

    const response = await postSave(
      formFields(id, { title: (await rowOf(id)).title, description: '2 回目', tags: [], visibility: 'published' }),
      cookie,
    );
    expect(response.status).toBe(429);
    expect((await rowOf(id)).description).toBe('1 回目');
  });

  it('語彙に無いタグ・4 個以上のタグは、公開もせずに断る', async () => {
    const { userId, id } = await seedWork('bad-tags', false);
    const spies: Spies = { captures: [], notices: [] };
    const response = await postSave(
      formFields(id, {
        title: (await rowOf(id)).title,
        description: '',
        tags: ['action', 'puzzle', 'shooting', 'idle'],
        visibility: 'published',
        confirm: true,
      }),
      await sessionCookie(userId),
      spies,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('何も保存していません。');
    expect((await rowOf(id)).status).toBe('draft');
    expect(spies.captures).toEqual([]);
  });

  it('取り下げた作品・できあがっていない作品は、確認の画面より前に断る', async () => {
    const { userId, id } = await seedWork('removed', true);
    await markGameRemoved(id);
    const removed = await postSave(
      formFields(id, { title: 'x', description: '', tags: [], visibility: 'draft' }),
      await sessionCookie(userId),
    );
    expect(removed.status).toBe(409);
    expect(await removed.text()).toContain('公開を停止した作品は編集できません');

    const pendingUser = await seedUser('pending');
    const pending = await createPendingGame(env, pendingUser, { prompt: 'まだの作品' });
    const notReady = await postSave(
      formFields(pending.id, { title: 'x', description: '', tags: [], visibility: 'published' }),
      await sessionCookie(pendingUser),
    );
    expect(notReady.status).toBe(409);
    expect(await notReady.text()).toContain('生成が終わってから保存してください');
  });

  it('id の綴りが違えば 400・媒体型が違えば 415（引く前に落とす）', async () => {
    const userId = await seedUser('shape');
    const bad = await postSave(
      formFields('not-a-uuid', { title: 'x', description: '', tags: [], visibility: 'draft' }),
      await sessionCookie(userId),
    );
    expect(bad.status).toBe(400);

    const media = await dispatch(
      createWorkSaveRoutes(async () => undefined, async () => 'not-a-fork'),
      new Request(`${APP_ORIGIN}${WORK_SAVE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie: await sessionCookie(userId) },
        body: 'title=x',
      }),
      testEnv(),
    );
    expect(media.status).toBe(415);
  });
});
