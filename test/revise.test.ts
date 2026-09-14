import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PATH } from '../src/auth/google.js';
import type { GenerationJob, GenerationPipeline } from '../src/generate.js';
import { defaultPipeline } from '../src/generate.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
  publishGame,
  STALE_AFTER_SECONDS,
} from '../src/games.js';
import {
  REVISE_GAME_ID_FIELD,
  REVISE_PATH,
  REVISE_PROMPT_FIELD,
  REVISE_SEQ_FIELD,
  RESTORE_PATH,
} from '../src/paths.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { DAILY_QUOTA_PER_USER, QUOTA_EXCEEDED_STATUS } from '../src/quota.js';
import { MAX_SOURCE_BYTES } from '../src/system-prompt.js';
import { createReviseRoutes } from '../src/revise.js';
import {
  appendRevision,
  claimRevisionJob,
  claimRevisionSlot,
  listRevisions,
  revisionStatus,
} from '../src/revisions.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-revise-endpoint-1';
const BASE_SOURCE = 'package main\n\nfunc main() {}\n';

beforeAll(async () => {
  await applySchema();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/**
 * ジョブの起動を記録する差し替え。
 *
 * **既定の `defaultPipeline` を使わない。** 使うと単体テストが Lambda への実呼び出しを
 * 要求し、1 回 約 16 円が受け入れ条件に混ざる（`src/revise.ts`）。
 *
 * @param fail true なら起動が失敗する
 * @returns 起動されたジョブの記録と、差し替えた pipeline
 */
function startSpy(fail = false): { calls: GenerationJob[]; pipeline: GenerationPipeline } {
  const calls: GenerationJob[] = [];
  return {
    calls,
    pipeline: {
      ...defaultPipeline,
      startJob: async (_env: Env, job: GenerationJob) => {
        calls.push(job);
        if (fail) {
          throw new Error('invoke failed');
        }
      },
    },
  };
}

/** @returns セッション cookie を載せたヘッダ */
async function sessionHeaders(userId: string, extra: Record<string, string>): Promise<HeadersInit> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return { ...extra, cookie: buildSessionCookie(token, 3600).split(';')[0]! };
}

/** @returns 作った利用者の id */
async function createUser(id: string): Promise<string> {
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 0)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * 完成した作品を 1 件作り、R2 にソースを置く。
 *
 * @param userId 作者
 * @returns 作品 id
 */
async function createReadyGame(userId: string): Promise<string> {
  const pending = await createPendingGame(env, userId, { prompt: '玉を避けるゲーム' });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-${pending.id}` }));
  const row = await env.DB.prepare(
    `select go_version, source_key, wasm_key from games where id = ?`,
  )
    .bind(pending.id)
    .first<{ go_version: string; source_key: string; wasm_key: string }>();
  await env.BUCKET.put(row!.source_key, BASE_SOURCE);
  await appendRevision(env, pending.id, {
    goVersion: row!.go_version,
    sourceKey: row!.source_key,
    wasmKey: row!.wasm_key,
  }, null);
  return pending.id;
}

/**
 * 推敲を要求する。
 *
 * @param userId 送る利用者（null なら未ログイン）
 * @param gameId 対象
 * @param prompt 差分プロンプト
 * @param pipeline 差し替えた pipeline
 * @returns レスポンス
 */
async function postRevise(
  userId: string | null,
  gameId: string,
  prompt: string,
  pipeline: GenerationPipeline,
): Promise<Response> {
  const base = { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' };
  const headers = userId === null ? base : await sessionHeaders(userId, base);
  const body = new URLSearchParams({
    [REVISE_GAME_ID_FIELD]: gameId,
    [REVISE_PROMPT_FIELD]: prompt,
  }).toString();
  return await dispatch(
    createReviseRoutes(pipeline),
    new Request(`${APP_ORIGIN}${REVISE_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

describe('推敲の受け口（5.7 / #192）', () => {
  it('未ログインならログインへ送る', async () => {
    const spy = startSpy();
    const response = await postRevise(null, crypto.randomUUID(), '玉を速く', spy.pipeline);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(spy.calls).toHaveLength(0);
  });

  it('作者本人なら起動され、元のソースが載る', async () => {
    const userId = await createUser('revise-ok');
    const gameId = await createReadyGame(userId);
    const spy = startSpy();

    const response = await postRevise(userId, gameId, '玉を速く', spy.pipeline);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(gameId));
    expect(spy.calls).toHaveLength(1);
    // **これが推敲の要である。** 載っていなければ、差分プロンプトだけで
    // まったく別のゲームが生成される（`src/orchestrator/payload.ts`）。
    expect(spy.calls[0]!.request.baseSource).toBe(BASE_SOURCE);
    expect(spy.calls[0]!.request.prompt).toBe('玉を速く');
    expect((await revisionStatus(env, gameId)).used).toBe(1);
  });

  it('他人の作品は推敲できず、起動もされない', async () => {
    const userId = await createUser('revise-owner');
    const other = await createUser('revise-other');
    const gameId = await createReadyGame(userId);
    const spy = startSpy();

    const response = await postRevise(other, gameId, '乗っ取り', spy.pipeline);

    expect(response.status).toBe(409);
    expect(spy.calls).toHaveLength(0);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });

  it('公開済みの作品は推敲できない（5.7 の対象は draft だけ）', async () => {
    const userId = await createUser('revise-published');
    const gameId = await createReadyGame(userId);
    await publishGame(env, gameId, userId);
    const spy = startSpy();

    expect((await postRevise(userId, gameId, '直したい', spy.pipeline)).status).toBe(409);
    expect(spy.calls).toHaveLength(0);
  });

  // **1 作品あたりの上限（3 回）はなくした**（#515 / 仕様 5.7 / 確定32）。回数を縛るのは日次枠だけである。
  for (const reviseCount of [3, 4, 50]) {
    it(`revise_count が ${reviseCount} の draft でも、日次枠が残っていれば起動される（#515）`, async () => {
      const userId = await createUser(`revise-no-per-game-limit-${reviseCount}`);
      const gameId = await createReadyGame(userId);
      await env.DB.prepare('update games set revise_count = ? where id = ?')
        .bind(reviseCount, gameId)
        .run();
      const spy = startSpy();

      const response = await postRevise(userId, gameId, 'もう 1 回', spy.pipeline);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(workPagePath(gameId));
      expect(spy.calls).toHaveLength(1);
      // **数えることはやめていない**（10.2 の観測に使う。#515 の scope.out）。
      expect((await revisionStatus(env, gameId)).used).toBe(reviseCount + 1);
    });
  }

  it('日次枠を使い切っていれば、これまでどおり 429 で断られ、起動も枠の取得もしない（#515）', async () => {
    const userId = await createUser('revise-daily-spent');
    const gameId = await createReadyGame(userId);
    // **費用の出る呼び出しを日次の上限まで積む**（確定25 は台帳の行数で数える）。
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            cost_jpy, succeeded, created_at)
         values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 1, 1, ?)`,
      )
        .bind(`gen-revise-daily-${gameId}-${i}`, userId, DEFAULT_GENERATION_MODEL_KEY, now)
        .run();
    }
    const spy = startSpy();

    expect((await postRevise(userId, gameId, 'もう 1 回', spy.pipeline)).status).toBe(QUOTA_EXCEEDED_STATUS);
    expect(QUOTA_EXCEEDED_STATUS).toBe(429);
    expect(spy.calls).toHaveLength(0);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });

  it('空のプロンプトは 400 で、枠を消費しない', async () => {
    const userId = await createUser('revise-empty');
    const gameId = await createReadyGame(userId);
    const spy = startSpy();

    expect((await postRevise(userId, gameId, '   ', spy.pipeline)).status).toBe(400);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });

  it('起動に失敗しても枠は返さず、ジョブを failed にする', async () => {
    const userId = await createUser('revise-start-failed');
    const gameId = await createReadyGame(userId);
    const spy = startSpy(true);

    expect((await postRevise(userId, gameId, '玉を速く', spy.pipeline)).status).toBe(500);

    const status = await revisionStatus(env, gameId);
    // **枠は返さない。** 起動を試みたあとは、相手が走り出している可能性を否定できない（`src/revise.ts`）。
    expect(status.used).toBe(1);
    expect(status.running).toBe(false);
    expect(status.failed).toBe('internal');
  });

  it('元のソースが R2 に無ければ起動せず、枠を返す（LLM を呼んでいない）', async () => {
    const userId = await createUser('revise-no-source');
    const gameId = await createReadyGame(userId);
    const row = await env.DB.prepare('select source_key from games where id = ?')
      .bind(gameId)
      .first<{ source_key: string }>();
    await env.BUCKET.delete(row!.source_key);
    const spy = startSpy();

    expect((await postRevise(userId, gameId, '玉を速く', spy.pipeline)).status).toBe(500);
    expect(spy.calls).toHaveLength(0);

    const status = await revisionStatus(env, gameId);
    // **確定28 が失敗を数える根拠は「費用は出ている」こと。** 呼んでいない以上、
    // その根拠は当てはまらない。ジョブ行も残さない。
    expect(status.used).toBe(0);
    expect(status.running).toBe(false);
    expect(status.failed).toBeNull();
  });

  it('30KB を超えるソースは 409 で、枠を消費しない（何度やっても成功しないため）', async () => {
    const userId = await createUser('revise-too-large');
    const gameId = await createReadyGame(userId);
    const row = await env.DB.prepare('select source_key from games where id = ?')
      .bind(gameId)
      .first<{ source_key: string }>();
    await env.BUCKET.put(row!.source_key, 'a'.repeat(MAX_SOURCE_BYTES + 1));
    const spy = startSpy();

    // **500「時間をおいてもう一度」にしない。** 整理パス（M5-2）が入るまで成功しない
    // 操作を、上限の回数だけ繰り返させることになる。
    expect((await postRevise(userId, gameId, '玉を速く', spy.pipeline)).status).toBe(409);
    expect(spy.calls).toHaveLength(0);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });
});

describe('版へ戻す受け口（5.7）', () => {
  /**
   * 復元を要求する。
   *
   * @param userId 送る利用者
   * @param gameId 対象
   * @param seq 戻したい版
   * @returns レスポンス
   */
  async function postRestore(userId: string, gameId: string, seq: number): Promise<Response> {
    const headers = await sessionHeaders(userId, {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    });
    const body = new URLSearchParams({
      [REVISE_GAME_ID_FIELD]: gameId,
      [REVISE_SEQ_FIELD]: String(seq),
    }).toString();
    return await dispatch(
      createReviseRoutes(startSpy().pipeline),
      new Request(`${APP_ORIGIN}${RESTORE_PATH}`, { method: 'POST', headers, body }),
      testEnv(),
    );
  }

  it('戻すと作品ページへ返り、枠は減らない', async () => {
    const userId = await createUser('restore-ok');
    const gameId = await createReadyGame(userId);
    await appendRevision(
      env,
      gameId,
      { goVersion: 'go1.27.0', sourceKey: 'builds/n/source.go', wasmKey: 'builds/n/game.wasm.br' },
      '玉を速く',
    );
    await env.DB.prepare('update games set source_key = ? where id = ?')
      .bind('builds/n/source.go', gameId)
      .run();

    const response = await postRestore(userId, gameId, 1);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(gameId));
    // **LLM を呼ばないので枠は動かない**（4.2 の 1 段目と同じ層）。
    expect((await revisionStatus(env, gameId)).used).toBe(0);
    expect(await listRevisions(env, gameId)).toHaveLength(2);
  });

  it('推敲が走っている最中は 409', async () => {
    const userId = await createUser('restore-busy');
    const gameId = await createReadyGame(userId);
    await postRevise(userId, gameId, '玉を速く', startSpy().pipeline);

    expect((await postRestore(userId, gameId, 1)).status).toBe(409);
  });

  for (const state of ['pending', 'running'] as const) {
    /**
     * 版を 2 つにし（作品は 2 つ目を指す）、推敲ジョブを 1 本、指定の時刻に始まったものとして残す。
     *
     * @param suffix 利用者ごとに一意な接尾辞
     * @param since ジョブの作成（running なら開始も）の時刻
     * @returns 作者と作品 id
     */
    async function prepareLeftJob(
      suffix: string,
      since: number,
    ): Promise<{ userId: string; gameId: string }> {
      const userId = await createUser(`restore-${suffix}-${state}`);
      const gameId = await createReadyGame(userId);
      await appendRevision(
        env,
        gameId,
        { goVersion: 'go1.27.0', sourceKey: 'builds/n/source.go', wasmKey: 'builds/n/game.wasm.br' },
        '玉を速く',
      );
      await env.DB.prepare('update games set source_key = ? where id = ?')
        .bind('builds/n/source.go', gameId)
        .run();
      const hash = `restore-left-${gameId}`;
      expect(await claimRevisionSlot(env, gameId, userId, '止まった手直し', hash, since)).toBe(true);
      if (state === 'running') {
        expect(await claimRevisionJob(env, gameId, hash, since)).toBe(true);
      }
      return { userId, gameId };
    }

    it(`区切りを過ぎた ${state} の推敲が残っていても戻せる（#480）`, async () => {
      const { userId, gameId } = await prepareLeftJob(
        'stalled',
        Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS - 1,
      );

      const response = await postRestore(userId, gameId, 1);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(workPagePath(gameId));
      const row = await env.DB.prepare('select source_key from games where id = ?')
        .bind(gameId)
        .first<{ source_key: string }>();
      expect(row!.source_key).not.toBe('builds/n/source.go');
      // **止まった行は書き換えない**（掃除は #480 の scope.out）。
      const job = await env.DB.prepare('select state from game_revision_jobs where game_id = ?')
        .bind(gameId)
        .first<{ state: string }>();
      expect(job!.state).toBe(state);
    });

    it(`区切りの内側の ${state} の推敲があれば、いまと同じく 409「いま戻せません」（#480）`, async () => {
      const { userId, gameId } = await prepareLeftJob(
        'live',
        Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS + 60,
      );

      const response = await postRestore(userId, gameId, 1);

      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain('いま戻せません');
      expect(body).toContain('リフォージが終わってから、もう一度お試しください。');
      const row = await env.DB.prepare('select source_key from games where id = ?')
        .bind(gameId)
        .first<{ source_key: string }>();
      expect(row!.source_key).toBe('builds/n/source.go');
    });
  }

  it('存在しない版は 404', async () => {
    const userId = await createUser('restore-missing');
    const gameId = await createReadyGame(userId);

    expect((await postRestore(userId, gameId, 99)).status).toBe(404);
  });
});
