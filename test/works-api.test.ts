import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerationJob, GenerationPipeline } from '../src/generate.js';
import { createGenerateRoutes, defaultPipeline } from '../src/generate.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  failGame,
  hashJobToken,
  STALE_AFTER_SECONDS,
} from '../src/games.js';
import { failureMessageOf } from '../src/generation-failure.js';
import { REVISE_PATH } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER, QUOTA_EXCEEDED_STATUS } from '../src/quota.js';
import { createReviseRoutes } from '../src/revise.js';
import { appendRevision } from '../src/revisions.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workEditPath } from '../src/work-edit-paths.js';
import { MY_WORKS_API_PAGE_SIZE, worksApiRoutes } from '../src/works-api.js';
import { MY_WORKS_API_PATH, myWorkApiPath, myWorkSourceApiPath } from '../src/works-api-paths.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-works-api-endpoint';
const SOURCE = 'package main\n\nfunc main() {}\n';

beforeAll(async () => {
  await applySchema();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/** @returns 作った利用者の id */
async function createUser(label: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 0)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, label)
    .run();
  return id;
}

/** @returns セッション cookie を載せたヘッダ */
async function sessionHeaders(userId: string, extra: Record<string, string> = {}): Promise<HeadersInit> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return { ...extra, cookie: buildSessionCookie(token, 3600).split(';')[0]! };
}

/**
 * 口を GET で叩く。
 *
 * @param userId 送る利用者（null なら未ログイン）
 * @param path パス（クエリを含んでよい）
 * @returns レスポンス
 */
async function get(userId: string | null, path: string): Promise<Response> {
  const headers = userId === null ? {} : await sessionHeaders(userId);
  return await dispatch(worksApiRoutes, new Request(`${APP_ORIGIN}${path}`, { headers }), testEnv());
}

/**
 * 完成した作品を 1 件作り、R2 にソースを置き、1 版目を積む。
 *
 * @param userId 作者
 * @param prompt 最初の指示文
 * @returns 作品 id
 */
async function createReadyGame(userId: string, prompt = '玉を避けるゲーム'): Promise<string> {
  const pending = await createPendingGame(env, userId, { prompt });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-${pending.id}` }));
  const row = await env.DB.prepare('select go_version, source_key, wasm_key from games where id = ?')
    .bind(pending.id)
    .first<{ go_version: string; source_key: string; wasm_key: string }>();
  await env.BUCKET.put(row!.source_key, SOURCE);
  await appendRevision(
    env,
    pending.id,
    { goVersion: row!.go_version, sourceKey: row!.source_key, wasmKey: row!.wasm_key },
    null,
  );
  return pending.id;
}

/** @returns ジョブの起動を記録するだけの pipeline */
function recordingPipeline(): { calls: GenerationJob[]; pipeline: GenerationPipeline } {
  const calls: GenerationJob[] = [];
  return {
    calls,
    pipeline: {
      ...defaultPipeline,
      startJob: async (_env: Env, job: GenerationJob) => {
        calls.push(job);
      },
    },
  };
}

describe('機械が読める口の認証（#694）', () => {
  it('未ログインは 3 つの口とも 401', async () => {
    const id = crypto.randomUUID();
    for (const path of [MY_WORKS_API_PATH, myWorkApiPath(id), myWorkSourceApiPath(id)]) {
      const response = await get(null, path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('退会を始めた利用者も 401', async () => {
    const userId = await createUser('退会中');
    await env.DB.prepare('update users set withdrawal_started_at = 1 where id = ?').bind(userId).run();
    expect((await get(userId, MY_WORKS_API_PATH)).status).toBe(401);
  });
});

describe('自作の詳細（GET /api/me/works/<id>）', () => {
  it('最初の指示文・生成の状況・版の一覧・リンクを返す', async () => {
    const userId = await createUser('作者');
    const gameId = await createReadyGame(userId, '赤い玉を避けるゲーム');

    const response = await get(userId, myWorkApiPath(gameId));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: gameId,
      status: 'draft',
      prompt: '赤い玉を避けるゲーム',
      generation: { state: 'ready', stalled: false, error: null, message: null },
      revision: { used: 0, running: false, stalled: false, error: null, message: null },
      links: { edit: workEditPath(gameId), source: myWorkSourceApiPath(gameId) },
    });
    expect(body['versions']).toEqual([
      expect.objectContaining({ seq: 1, prompt: null, current: true }),
    ]);
  });

  it('他人の作品・無い id・形の違う id・取り下げ・削除中は、どれも同じ 404', async () => {
    const owner = await createUser('持ち主');
    const other = await createUser('他人');
    const others = await createReadyGame(other);
    const removed = await createReadyGame(owner);
    await env.DB.prepare(`update games set status = 'removed' where id = ?`).bind(removed).run();
    const deleting = await createReadyGame(owner);
    await env.DB.prepare('update games set deletion_started_at = 1 where id = ?').bind(deleting).run();

    for (const id of [others, crypto.randomUUID(), 'not-a-uuid', removed, deleting]) {
      for (const path of [myWorkApiPath(id), myWorkSourceApiPath(id)]) {
        const response = await get(owner, path);
        expect(response.status, path).toBe(404);
        expect(await response.json(), path).toEqual({ error: 'not-found' });
      }
    }
  });

  it('生成中で止まっていれば stalled、失敗なら分類と文言を返す', async () => {
    const userId = await createUser('生成中');
    const stuck = await createPendingGame(env, userId, { prompt: '止まる' }, Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS - 1);
    const failed = await createPendingGame(env, userId, { prompt: '失敗する' });
    await failGame(env, failed.id, 'build-failed');

    const stuckBody = (await (await get(userId, myWorkApiPath(stuck.id))).json()) as { generation: unknown };
    expect(stuckBody.generation).toEqual({ state: 'pending', stalled: true, error: null, message: null });

    const failedBody = (await (await get(userId, myWorkApiPath(failed.id))).json()) as {
      prompt: string | null;
      generation: unknown;
    };
    expect(failedBody.generation).toEqual({
      state: 'failed',
      stalled: false,
      error: 'build-failed',
      message: failureMessageOf('build-failed'),
    });
    // 入力の検査で止めたのでなければ、指示文は残る。
    expect(failedBody.prompt).toBe('失敗する');
  });

  it('入力の検査で止めた作品は、指示文を作品の行に残さない（0047）', async () => {
    const userId = await createUser('止められた');
    const blocked = await createPendingGame(env, userId, { prompt: '止められる指示' });
    await failGame(env, blocked.id, 'prompt-blocked');

    const row = await env.DB.prepare('select prompt, generation_error from games where id = ?')
      .bind(blocked.id)
      .first<{ prompt: string | null; generation_error: string }>();
    expect(row).toEqual({ prompt: null, generation_error: 'prompt-blocked' });
    const body = (await (await get(userId, myWorkApiPath(blocked.id))).json()) as { prompt: unknown };
    expect(body.prompt).toBeNull();
  });
});

describe('自作のソース（GET /api/me/works/<id>/source）', () => {
  it('下書きのソースを読める', async () => {
    const userId = await createUser('下書きの作者');
    const gameId = await createReadyGame(userId);
    const response = await get(userId, myWorkSourceApiPath(gameId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: gameId, source: SOURCE });
  });

  it('まだソースの無い作品は 409', async () => {
    const userId = await createUser('生成待ち');
    const pending = await createPendingGame(env, userId, { prompt: 'まだ' });
    const response = await get(userId, myWorkSourceApiPath(pending.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'source-not-ready' });
  });
});

describe('自作の一覧（GET /api/me/works）', () => {
  it('自作だけを新しい順で返し、指示文は載せない', async () => {
    const userId = await createUser('一覧の作者');
    const other = await createUser('一覧の他人');
    const older = await createReadyGame(userId, '古いほう');
    const newer = await createPendingGame(env, userId, { prompt: '新しいほう' }, Math.floor(Date.now() / 1000) + 10);
    await createReadyGame(other);

    const response = await get(userId, MY_WORKS_API_PATH);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { filter: string; works: Record<string, unknown>[]; nextOffset: unknown };
    expect(body.filter).toBe('all');
    expect(body.works.map((work) => work['id'])).toEqual([newer.id, older]);
    expect(body.works[0]).toMatchObject({ generation: { state: 'pending', stalled: false }, url: myWorkApiPath(newer.id) });
    expect(body.works.every((work) => !('prompt' in work))).toBe(true);
    expect(body.nextOffset).toBeNull();

    const generating = (await (await get(userId, `${MY_WORKS_API_PATH}?state=generating`)).json()) as {
      works: { id: string }[];
    };
    expect(generating.works.map((work) => work.id)).toEqual([newer.id]);
  });

  it('1 ページを超えると nextOffset を返す', async () => {
    const userId = await createUser('多作');
    for (let index = 0; index <= MY_WORKS_API_PAGE_SIZE; index += 1) {
      await createPendingGame(env, userId, { prompt: `作品 ${index}` }, 1000 + index);
    }
    const first = (await (await get(userId, MY_WORKS_API_PATH)).json()) as { works: unknown[]; nextOffset: unknown };
    expect(first.works).toHaveLength(MY_WORKS_API_PAGE_SIZE);
    expect(first.nextOffset).toBe(MY_WORKS_API_PAGE_SIZE);
    const second = (await (await get(userId, `${MY_WORKS_API_PATH}?offset=${MY_WORKS_API_PAGE_SIZE}`)).json()) as {
      works: unknown[];
      nextOffset: unknown;
    };
    expect(second.works).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
  });

  it('形の違う offset は 400', async () => {
    const userId = await createUser('offset');
    for (const offset of ['-1', 'abc', '99999']) {
      const response = await get(userId, `${MY_WORKS_API_PATH}?offset=${offset}`);
      expect(response.status, offset).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid-offset' });
    }
  });
});

describe('開始の口の応答（#694）', () => {
  it('推敲の 202 にも statusUrl が載る', async () => {
    const userId = await createUser('推敲の作者');
    const gameId = await createReadyGame(userId);
    const { calls, pipeline } = recordingPipeline();
    const response = await dispatch(
      createReviseRoutes(pipeline),
      new Request(`${APP_ORIGIN}${REVISE_PATH}`, {
        method: 'POST',
        headers: await sessionHeaders(userId, { 'content-type': 'application/json' }),
        body: JSON.stringify({ game_id: gameId, prompt: '玉を速く' }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      gameId,
      url: workEditPath(gameId),
      statusUrl: myWorkApiPath(gameId),
    });
    expect(calls).toHaveLength(1);

    // 走っている推敲は、状況の口に running で出る。
    const detail = (await (await get(userId, myWorkApiPath(gameId))).json()) as { revision: unknown };
    expect(detail.revision).toMatchObject({ running: true, stalled: false });
  });

  it('生成した作品は、状況の口で最初の指示文ごと読める。枠切れは既存と同じ分類', async () => {
    const userId = await createUser('生成の作者');
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes(pipeline);
    const post = async (): Promise<Response> =>
      await dispatch(
        routes,
        new Request(`${APP_ORIGIN}/api/generate`, {
          method: 'POST',
          headers: await sessionHeaders(userId, { 'content-type': 'application/json' }),
          body: JSON.stringify({ prompt: '青い玉を集めるゲーム' }),
        }),
        testEnv(),
      );

    const started = await post();
    expect(started.status).toBe(202);
    const { gameId, statusUrl } = (await started.json()) as { gameId: string; statusUrl: string };
    expect(statusUrl).toBe(myWorkApiPath(gameId));
    const detail = (await (await get(userId, statusUrl)).json()) as { prompt: unknown; generation: unknown };
    expect(detail.prompt).toBe('青い玉を集めるゲーム');
    expect(detail.generation).toMatchObject({ state: 'pending' });

    // 日次枠を使い切った状態を作る（確定25。数えるのは台帳の行）。
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at)
         values (?, null, ?, 'p', 'sonnet-4-6', 0, 0, 0, 0, 0, 1, ?)`,
      )
        .bind(crypto.randomUUID(), userId, now)
        .run();
    }
    await failGame(env, gameId, 'internal');
    const refused = await post();
    expect(refused.status).toBe(QUOTA_EXCEEDED_STATUS);
    expect(await refused.json()).toMatchObject({ error: 'daily-quota' });
  });
});
