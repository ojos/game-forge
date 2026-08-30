import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PATH } from '../src/auth/google.js';
import { dispatch } from '../src/routes.js';
import { createPublishRoutes } from '../src/publish.js';
import { PUBLISH_GAME_ID_FIELD, PUBLISH_PATH } from '../src/paths.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  failGame,
  hashJobToken,
  publishGame,
} from '../src/games.js';
import type { OgpCaptureJob } from '../src/ogp-client.js';
import { handleSandboxRequest } from '../src/sandbox.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const SECRET = 'test-secret-value-for-publish-endpoint-1';

/**
 * テスト用の env。
 *
 * **AWS の資格情報を入れておく。** 入れないと `startOgpCapture` が設定不足として
 * 起動の手前で降りるため、「未公開では撮影しない」の検査が**理由の違いで緑になる**
 * （撮らなかったのは未公開だからではなく、鍵が無いから）。**空振りを作らない。**
 *
 * @returns 秘密を差し替えた env
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

/** 撮影の起動を記録する差し替え。**呼ばれた回数と中身を見る。** */
function captureSpy(): { calls: OgpCaptureJob[]; start: (env: Env, job: OgpCaptureJob) => Promise<void> } {
  const calls: OgpCaptureJob[] = [];
  return {
    calls,
    start: async (_env: Env, job: OgpCaptureJob) => {
      calls.push(job);
    },
  };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `publish-user-${suffix}`;
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
 * 完成済み（`generation_state='ready'`・`status='draft'`）の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者の id と作品 id
 */
async function seedReadyGame(suffix: string): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: `ねこの${suffix}` });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * 公開を要求する。
 *
 * @param gameId 作品 id（`null` なら項目ごと送らない）
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @param start 撮影を投げる段
 * @returns レスポンス
 */
async function publish(
  gameId: string | null,
  cookie: string | undefined,
  start: (env: Env, job: OgpCaptureJob) => Promise<void>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    // **素のフォームからのナビゲーションを再現する。** ブラウザは `Accept` に
    // `text/html` を明示し、経路はそれを見て JSON と HTML を出し分ける
    // （src/publish.ts の `wantsHtml`）。付けないと、この検査は
    // 「フォームから押した」場合を確かめていないことになる。
    accept: 'text/html,application/xhtml+xml',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const body =
    gameId === null ? '' : new URLSearchParams({ [PUBLISH_GAME_ID_FIELD]: gameId }).toString();
  return await dispatch(
    createPublishRoutes(start),
    new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * `games` の 1 行を読む。
 *
 * @param id 作品 id
 * @returns 公開と撮影に関わる列
 */
async function readGame(id: string): Promise<{
  status: string;
  published_at: number | null;
  ogp_state: string | null;
}> {
  const row = await env.DB.prepare(
    'select status, published_at, ogp_state from games where id = ?',
  )
    .bind(id)
    .first<{ status: string; published_at: number | null; ogp_state: string | null }>();
  if (row === null) {
    throw new Error(`作品が見つかりません: ${id}`);
  }
  return row;
}

beforeAll(async () => {
  await applySchema();
});

describe('draft の公開 URL は 404（#26 acceptance 1）', () => {
  it('未公開の作品の /g/<game_id>/ が 404 を返す', async () => {
    const { id } = await seedReadyGame('g-404');
    // **完成している。** 生成が終わっていないから 404 なのではなく、
    // **公開していないから** 404 であることを、この前提が固定する。
    expect((await readGame(id)).status).toBe('draft');

    const response = await handleSandboxRequest(
      new Request(`${SANDBOX_ORIGIN}/g/${id}/`),
      testEnv(),
    );
    expect(response.status).toBe(404);
  });

  it('公開すると同じ URL が 200 を返す', async () => {
    // **対照が無いと、404 は「経路が無いから」でも通ってしまう。**
    const { userId, id } = await seedReadyGame('g-200');
    const spy = captureSpy();
    expect((await publish(id, await sessionCookie(userId), spy.start)).status).toBe(303);

    const response = await handleSandboxRequest(
      new Request(`${SANDBOX_ORIGIN}/g/${id}/`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('未公開の作品を撮影しない（#26 acceptance 2 / 5.4）', () => {
  it('公開に失敗した要求は撮影を起こさない（他人の作品）', async () => {
    const { id } = await seedReadyGame('other-author');
    const stranger = await seedUser('stranger');
    const spy = captureSpy();

    const response = await publish(id, await sessionCookie(stranger), spy.start);

    // **他人の作品は「存在しない」と同じ扱いにする**（理由を撃ち分けない）。
    expect(response.status).toBe(404);
    expect(spy.calls).toEqual([]);
    const row = await readGame(id);
    expect(row.status).toBe('draft');
    expect(row.published_at).toBeNull();
    // **撮影の状態にも触らない。**
    expect(row.ogp_state).toBeNull();
  });

  it('生成が完了していない作品は公開できず、撮影も起こらない', async () => {
    const userId = await seedUser('not-ready');
    const pending = await createPendingGame(env, userId, { prompt: 'まだ生成中' });
    const spy = captureSpy();

    const response = await publish(pending.id, await sessionCookie(userId), spy.start);

    expect(response.status).toBe(409);
    expect(spy.calls).toEqual([]);
    expect((await readGame(pending.id)).status).toBe('draft');
  });

  it('生成に失敗した作品も公開できない', async () => {
    const userId = await seedUser('failed');
    const pending = await createPendingGame(env, userId, { prompt: '失敗した作品' });
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
    await failGame(env, pending.id, 'build-failed');
    const spy = captureSpy();

    expect((await publish(pending.id, await sessionCookie(userId), spy.start)).status).toBe(409);
    expect(spy.calls).toEqual([]);
    expect((await readGame(pending.id)).status).toBe('draft');
  });

  it('未ログインの要求は行にも撮影にも届かない', async () => {
    const { id } = await seedReadyGame('anon');
    const spy = captureSpy();

    // 画面（フォーム）から来た未ログインはログインへ送る。
    const fromForm = await publish(id, undefined, spy.start);
    expect(fromForm.status).toBe(303);
    expect(fromForm.headers.get('location')).toBe(LOGIN_PATH);

    // API として呼ばれたら 401 を返す（送り先を持たない相手にリダイレクトを返さない）。
    const fromApi = await dispatch(
      createPublishRoutes(spy.start),
      new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [PUBLISH_GAME_ID_FIELD]: id }),
      }),
      testEnv(),
    );
    expect(fromApi.status).toBe(401);

    expect(spy.calls).toEqual([]);
    expect((await readGame(id)).status).toBe('draft');
  });
});

describe('公開の遷移（5.4 / #26）', () => {
  it('作者本人が公開すると published と published_at が入る', async () => {
    const { userId, id } = await seedReadyGame('happy');
    const spy = captureSpy();
    const before = Math.floor(Date.now() / 1000);

    const response = await publish(id, await sessionCookie(userId), spy.start);

    // 素のフォームからの POST は POST-redirect-GET で作品ページへ戻る。
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(id));

    const row = await readGame(id);
    expect(row.status).toBe('published');
    expect(row.published_at).toBeGreaterThanOrEqual(before);
    // 撮影は**公開のあと**に 1 回だけ投げられる。
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.gameId).toBe(id);
    // トークンは平文でジョブへ渡り、D1 にはハッシュだけが入る。
    expect(spy.calls[0]!.ogpToken).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await env.DB.prepare('select ogp_token_hash from games where id = ?')
      .bind(id)
      .first<{ ogp_token_hash: string | null }>();
    expect(stored?.ogp_token_hash).toBe(await hashJobToken(spy.calls[0]!.ogpToken));
    expect(row.ogp_state).toBe('capturing');
  });

  it('二度押しても二重に撮影せず、公開時刻も動かない', async () => {
    // **冪等性。** 5.4 の主ボタンは 1 タップで、通信が不安定なら二度押される。
    // 二度目に撮影が走ると、そのぶん Lambda が余分に動く。
    const { userId, id } = await seedReadyGame('idempotent');
    const cookie = await sessionCookie(userId);
    const spy = captureSpy();

    await publish(id, cookie, spy.start);
    const first = await readGame(id);
    await publish(id, cookie, spy.start);
    const second = await readGame(id);

    expect(spy.calls).toHaveLength(1);
    expect(second.published_at).toBe(first.published_at);
    expect(second.status).toBe('published');
  });

  it('JSON で呼ぶと 2 回目は firstPublish=false を返す', async () => {
    const { userId, id } = await seedReadyGame('json');
    const cookie = await sessionCookie(userId);
    const spy = captureSpy();
    const request = (): Request =>
      new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ [PUBLISH_GAME_ID_FIELD]: id }),
      });

    const first = (await (
      await dispatch(createPublishRoutes(spy.start), request(), testEnv())
    ).json()) as Record<string, unknown>;
    const second = (await (
      await dispatch(createPublishRoutes(spy.start), request(), testEnv())
    ).json()) as Record<string, unknown>;

    expect(first['published']).toBe(true);
    expect(first['firstPublish']).toBe(true);
    expect(first['ogp']).toBe('started');
    expect(second['firstPublish']).toBe(false);
    // **2 回目は撮影を起こさないので、報告する結果も無い。**
    expect(second['ogp']).toBeNull();
    expect(spy.calls).toHaveLength(1);
  });

  it('上限を超える本文は 413（400 に潰さない）', async () => {
    // `readLimitedText` は body-too-large と unreadable-body を区別して返す。
    // **潰すと「送った内容が悪い」と読めるが、実際には大きさだけの問題である。**
    // src/ogp.ts のコールバックが 413 を返すのと、流儀を揃えてある。
    const { userId, id } = await seedReadyGame('too-large');
    const cookie = await sessionCookie(userId);
    const spy = captureSpy();
    const padded = new URLSearchParams({
      [PUBLISH_GAME_ID_FIELD]: id,
      pad: 'x'.repeat(2048),
    }).toString();

    const fromForm = await dispatch(
      createPublishRoutes(spy.start),
      new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
          cookie,
        },
        body: padded,
      }),
      testEnv(),
    );
    expect(fromForm.status).toBe(413);

    const fromApi = await dispatch(
      createPublishRoutes(spy.start),
      new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ [PUBLISH_GAME_ID_FIELD]: id, pad: 'x'.repeat(2048) }),
      }),
      testEnv(),
    );
    expect(fromApi.status).toBe(413);
    expect(((await fromApi.json()) as Record<string, unknown>)['error']).toBe('body-too-large');

    // **公開もしていない。** 断った要求が行を進めていないことまで見る。
    expect(spy.calls).toEqual([]);
    expect((await readGame(id)).status).toBe('draft');
  });

  it('対応しない Content-Type は 415、形が違う id は 400', async () => {
    // 断りの理由ごとにステータスが違うこと（1 つの分岐式へ畳んでいないこと）。
    const { userId, id } = await seedReadyGame('status-codes');
    const cookie = await sessionCookie(userId);
    const spy = captureSpy();

    const wrongType = await dispatch(
      createPublishRoutes(spy.start),
      new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie },
        body: `game_id=${id}`,
      }),
      testEnv(),
    );
    expect(wrongType.status).toBe(415);

    expect((await publish('not-a-uuid', cookie, spy.start)).status).toBe(400);
    expect(spy.calls).toEqual([]);
  });

  it('存在しない作品は 404', async () => {
    const userId = await seedUser('missing');
    const spy = captureSpy();
    const response = await publish(
      '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f',
      await sessionCookie(userId),
      spy.start,
    );
    expect(response.status).toBe(404);
    expect(spy.calls).toEqual([]);
  });
});

describe('publishGame（SQL の条件そのもの）', () => {
  it('removed の作品は作者でも公開できない', async () => {
    const { userId, id } = await seedReadyGame('removed');
    await env.DB.prepare("update games set status = 'removed' where id = ?").bind(id).run();

    const outcome = await publishGame(env, id, userId);
    expect(outcome).toEqual({ ok: false, reason: 'removed' });
    expect((await readGame(id)).status).toBe('removed');
  });

  it('他人の id を渡しても理由を撃ち分けない', async () => {
    const { id } = await seedReadyGame('leak');
    const stranger = await seedUser('leak-stranger');
    // 実在する作品でも、作者でなければ「無い」と同じ答えになる。
    expect(await publishGame(env, id, stranger)).toEqual({ ok: false, reason: 'not-found' });
    expect(await publishGame(env, '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f', stranger)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});
