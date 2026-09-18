import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteGame } from '../src/game-deletion.js';
import { STALE_AFTER_SECONDS, failGame } from '../src/games.js';
import {
  STALE_GENERATION_SWEEP_SECONDS,
  STALE_SWEEP_BATCH_LIMIT,
  STALE_SWEEP_ERROR_CODE,
  sweepStaleGenerations,
} from '../src/stale-generation-sweep.js';
import type { DeletionTargetRow } from '../src/work-delete.js';
import { DELETION_TARGET_SQL, deletionBlockOf, deletionStateOf } from '../src/work-delete.js';
import type { CleanupEnv } from '../workers/cleanup/src/hub.js';
import cleanupWorker from '../workers/cleanup/src/index.js';
import { countingEnv } from './helpers/d1-counting.js';
import { applySchema } from './helpers/schema.js';

/**
 * 止まったまま残った生成・推敲の行を、cron で `failed` に畳む（#681）。
 *
 * **#681 の acceptance のうち、テストの行を 1 つずつ機械判定する。**
 *
 * 1. 区切りを超えた `pending` / `running` の作品の行と推敲ジョブの行が、`scheduled` の 1 回で `failed` になる
 * 2. 区切りの内側の行・`ready` / `failed` の行・公開中の行は変わらない
 * 3. 区切りが orchestrator の `maximum_event_age` ＋ `timeout` を超える（terraform の値を読む）
 * 4. 畳んだ作品で `deletionBlockOf` が null を返す（削除の導線が出る）
 *
 * あわせて、1 回の起動の D1 の文が枠（50）に収まり、件数に上限がかかること、畳んだ行に遅れて
 * 失敗の通知が来ても二重に書かないことを見る。
 */

beforeAll(async () => {
  await applySchema();
});

/** cron の予定時刻（UNIX 秒）。区切りの内外はこの時刻から数える。 */
const NOW = 1_800_000_000;

/** 区切りをちょうど過ぎた開始時刻。 */
const STALE_AT = NOW - STALE_GENERATION_SWEEP_SECONDS;

/** 区切りの 1 秒内側の開始時刻。 */
const FRESH_AT = STALE_AT + 1;

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `sgs-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '止まった人')
    .run();
  return id;
}

/** {@link seedGame} の指定。 */
interface GameSeed {
  readonly state: 'pending' | 'running' | 'ready' | 'failed';
  readonly createdAt: number;
  readonly startedAt?: number | null;
  readonly status?: 'draft' | 'published';
  readonly error?: string | null;
}

/**
 * 作品行を 1 つ作る。
 *
 * @param authorId 作者
 * @param seed 状態と時刻
 * @returns 作品 id
 */
async function seedGame(authorId: string, seed: GameSeed): Promise<string> {
  const id = crypto.randomUUID();
  const status = seed.status ?? 'draft';
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, published_at,
                        generation_state, generation_started_at, generation_error, job_token_hash)
     values (?, ?, ?, '題名', 'go1.27.0', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      status,
      seed.createdAt,
      status === 'published' ? seed.createdAt : null,
      seed.state,
      seed.startedAt ?? null,
      seed.error ?? null,
      seed.state === 'pending' || seed.state === 'running' ? `hash-${id}` : null,
    )
    .run();
  return id;
}

/**
 * 推敲ジョブを 1 つ作る。
 *
 * @param gameId 作品
 * @param state 状態
 * @param createdAt 作成時刻
 * @param startedAt 開始時刻
 * @param error 失敗の分類名
 */
async function seedJob(
  gameId: string,
  state: 'pending' | 'running' | 'failed',
  createdAt: number,
  startedAt: number | null = null,
  error: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
     values (?, ?, '直して', ?, ?, ?, ?)`,
  )
    .bind(gameId, `job-${gameId}`, state, error, startedAt, createdAt)
    .run();
}

/**
 * 作品行の状態を読む。
 *
 * @param id 作品 id
 * @returns 状態・分類名・トークン
 */
async function gameRow(
  id: string,
): Promise<{ generation_state: string; generation_error: string | null; job_token_hash: string | null; status: string }> {
  const row = await env.DB.prepare(
    'select generation_state, generation_error, job_token_hash, status from games where id = ?',
  )
    .bind(id)
    .first<{ generation_state: string; generation_error: string | null; job_token_hash: string | null; status: string }>();
  if (row === null) throw new Error(`作品が無い: ${id}`);
  return row;
}

/**
 * 推敲ジョブの状態を読む。
 *
 * @param gameId 作品 id
 * @returns 状態と分類名
 */
async function jobRow(gameId: string): Promise<{ state: string; error: string | null }> {
  const row = await env.DB.prepare('select state, error from game_revision_jobs where game_id = ?')
    .bind(gameId)
    .first<{ state: string; error: string | null }>();
  if (row === null) throw new Error(`ジョブが無い: ${gameId}`);
  return row;
}

/**
 * 台帳の行数（畳んでも増えないことを見る）。
 *
 * @returns 件数
 */
async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from generations').first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * cron を 1 回走らせる（DO は起こしたことだけを記録する偽物にし、D1 は本物を渡す）。
 *
 * @param now 予定時刻（UNIX 秒）
 * @returns 起こした DO のインスタンス名
 */
async function runCron(now: number = NOW): Promise<string[]> {
  const woken: string[] = [];
  const fakeEnv = {
    DB: env.DB,
    WITHDRAWAL_HUB: {
      idFromName: (name: string): unknown => ({ name }),
      get: (id: { name: string }): { wake: () => Promise<void> } => ({
        wake: async (): Promise<void> => {
          woken.push(id.name);
        },
      }),
    },
  } as unknown as CleanupEnv;
  await cleanupWorker.scheduled({ cron: '*/5 * * * *', scheduledTime: now * 1000, noRetry: () => {} }, fakeEnv);
  return woken;
}

/**
 * 残っている止まった行を全部畳み切る（テストどうしが上限を取り合わないように、各テストの前後で使う）。
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const result = await sweepStaleGenerations(env, NOW);
    if (result.games === 0 && result.revisionJobs === 0) return;
  }
  throw new Error('畳み切れない');
}

describe('区切りは、コールバックが届きうる時間の外側にある（terraform の値と照合する）', () => {
  /**
   * `locals` の数値を 1 つ読む。
   *
   * @param name 名前
   * @returns 値
   */
  function localNumber(name: string): number {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, 'mu').exec(env.TEST_ORCHESTRATOR_TF);
    if (match?.[1] === undefined) throw new Error(`terraform/orchestrator.tf に ${name} が無い`);
    return Number(match[1]);
  }

  it('maximum_event_age ＋ timeout より長く、画面の区切りより長い', () => {
    const tf = env.TEST_ORCHESTRATOR_TF;
    // **宣言が locals を読んでいること**を先に見る。リソースへ数値を直に書かれると、下の値は読めても
    // 実際の設定とずれる。
    expect(tf).toMatch(/^\s*timeout\s*=\s*local\.orchestrator_timeout_seconds\s*$/mu);
    expect(tf).toMatch(/^\s*maximum_event_age_in_seconds\s*=\s*local\.orchestrator_maximum_event_age_seconds\s*$/mu);
    expect(tf).toMatch(/^\s*maximum_retry_attempts\s*=\s*local\.orchestrator_maximum_retry_attempts\s*$/mu);

    const eventAge = localNumber('orchestrator_maximum_event_age_seconds');
    const timeout = localNumber('orchestrator_timeout_seconds');
    const retries = localNumber('orchestrator_maximum_retry_attempts');

    // 基盤のリトライがあると、届きうる時間は（リトライ＋1）回ぶんの実行に延びる。前提が崩れたら
    // この区切りを見直す（いまは 0。`scripts/check-orchestrator-retry.sh` も見ている）。
    expect(retries).toBe(0);
    expect(STALE_GENERATION_SWEEP_SECONDS).toBeGreaterThan(eventAge + timeout);
    expect(STALE_GENERATION_SWEEP_SECONDS).toBeGreaterThan(STALE_AFTER_SECONDS);
  });
});

describe('cron の 1 回で、区切りを超えた行を failed に畳む', () => {
  it('作品の行（pending / running）と推敲ジョブの行（pending / running）が failed になり、他は変わらない', async () => {
    await drain();
    const userId = await seedUser();
    const ledgerBefore = await ledgerCount();

    // 畳まれる行。
    const stalePending = await seedGame(userId, { state: 'pending', createdAt: STALE_AT });
    const staleRunning = await seedGame(userId, { state: 'running', createdAt: STALE_AT - 60, startedAt: STALE_AT });
    const jobPendingHost = await seedGame(userId, { state: 'ready', createdAt: 100 });
    await seedJob(jobPendingHost, 'pending', STALE_AT);
    // 公開中の作品の推敲ジョブも、ジョブの行だけを畳む（作品の行は触らない）。
    const jobRunningHost = await seedGame(userId, { state: 'ready', createdAt: 100, status: 'published' });
    await seedJob(jobRunningHost, 'running', STALE_AT - 60, STALE_AT);

    // 変わらない行。
    const freshPending = await seedGame(userId, { state: 'pending', createdAt: FRESH_AT });
    // 作成は古いが、握ってから区切りの内側（開始時刻から数える）。
    const freshRunning = await seedGame(userId, {
      state: 'running',
      createdAt: STALE_AT - 600,
      startedAt: FRESH_AT,
    });
    const oldReady = await seedGame(userId, { state: 'ready', createdAt: 100 });
    const oldFailed = await seedGame(userId, { state: 'failed', createdAt: 100, error: 'build-failed' });
    const publishedRunning = await seedGame(userId, {
      state: 'running',
      createdAt: 100,
      startedAt: 100,
      status: 'published',
    });
    const freshJobHost = await seedGame(userId, { state: 'ready', createdAt: 100 });
    await seedJob(freshJobHost, 'running', STALE_AT - 600, FRESH_AT);
    const failedJobHost = await seedGame(userId, { state: 'ready', createdAt: 100 });
    await seedJob(failedJobHost, 'failed', 100, 100, 'build-failed');

    expect(await runCron()).toEqual(['withdrawal']);

    for (const id of [stalePending, staleRunning]) {
      expect(await gameRow(id)).toEqual({
        generation_state: 'failed',
        generation_error: STALE_SWEEP_ERROR_CODE,
        job_token_hash: null,
        status: 'draft',
      });
    }
    for (const id of [jobPendingHost, jobRunningHost]) {
      expect(await jobRow(id)).toEqual({ state: 'failed', error: STALE_SWEEP_ERROR_CODE });
      expect((await gameRow(id)).generation_state).toBe('ready');
    }
    expect((await gameRow(jobRunningHost)).status).toBe('published');

    expect(await gameRow(freshPending)).toMatchObject({ generation_state: 'pending', generation_error: null });
    expect(await gameRow(freshRunning)).toMatchObject({ generation_state: 'running', generation_error: null });
    expect(await gameRow(oldReady)).toMatchObject({ generation_state: 'ready', generation_error: null });
    expect(await gameRow(oldFailed)).toMatchObject({ generation_state: 'failed', generation_error: 'build-failed' });
    expect(await gameRow(publishedRunning)).toEqual({
      generation_state: 'running',
      generation_error: null,
      job_token_hash: `hash-${publishedRunning}`,
      status: 'published',
    });
    expect(await jobRow(freshJobHost)).toEqual({ state: 'running', error: null });
    expect(await jobRow(failedJobHost)).toEqual({ state: 'failed', error: 'build-failed' });

    // **台帳には書かない。**
    expect(await ledgerCount()).toBe(ledgerBefore);

    // 片付け（公開中の止まった行は畳まれずに残るので、後続のテストの数に入らないよう ready にする）。
    await env.DB.prepare("update games set generation_state = 'ready' where id = ?").bind(publishedRunning).run();
  });

  it('畳んだ行に遅れて失敗の通知が来ても、二重に書かない（条件付き UPDATE）', async () => {
    await drain();
    const userId = await seedUser();
    const id = await seedGame(userId, { state: 'running', createdAt: STALE_AT, startedAt: STALE_AT });
    await runCron();
    expect(await failGame(env, id, 'build-failed')).toBe(false);
    expect((await gameRow(id)).generation_error).toBe(STALE_SWEEP_ERROR_CODE);
    // もう一度走らせても、畳む行は無い。
    expect(await sweepStaleGenerations(env, NOW)).toEqual({ games: 0, revisionJobs: 0 });
  });
});

describe('畳んだ作品は、作者が削除できる', () => {
  it('生成が止まった作品と、推敲が止まった作品のどちらも deletionBlockOf が null になり、deleteGame が通る', async () => {
    await drain();
    const userId = await seedUser();
    const stalledGeneration = await seedGame(userId, { state: 'pending', createdAt: STALE_AT });
    const stalledRevision = await seedGame(userId, { state: 'ready', createdAt: 100 });
    await seedJob(stalledRevision, 'running', STALE_AT, STALE_AT);

    const blockOf = async (id: string): Promise<ReturnType<typeof deletionBlockOf>> => {
      const row = await env.DB.prepare(DELETION_TARGET_SQL).bind(id).first<DeletionTargetRow>();
      if (row === null) throw new Error(`作品が無い: ${id}`);
      return deletionBlockOf(deletionStateOf(row));
    };

    // 畳む前は、止まった行も「生成中」「リフォージ中」として断られる（#516 / #517）。
    expect(await blockOf(stalledGeneration)).toBe('generating');
    expect(await blockOf(stalledRevision)).toBe('revising');
    expect(await deleteGame(env, stalledGeneration, NOW)).toEqual({ ok: false, reason: 'generating' });

    await runCron();

    expect(await blockOf(stalledGeneration)).toBeNull();
    expect(await blockOf(stalledRevision)).toBeNull();
    expect((await deleteGame(env, stalledGeneration, NOW)).ok).toBe(true);
    expect((await deleteGame(env, stalledRevision, NOW)).ok).toBe(true);
  });
});

describe('1 回の起動を枠に収める', () => {
  it('表ごとに上限の件数だけ畳み、D1 の文は 2 本で、残りは次の回に畳む', async () => {
    await drain();
    const userId = await seedUser();
    const extra = 3;
    const games: string[] = [];
    for (let i = 0; i < STALE_SWEEP_BATCH_LIMIT + extra; i += 1) {
      games.push(await seedGame(userId, { state: 'pending', createdAt: STALE_AT - i }));
    }
    const hosts: string[] = [];
    for (let i = 0; i < STALE_SWEEP_BATCH_LIMIT + extra; i += 1) {
      const host = await seedGame(userId, { state: 'ready', createdAt: 100 });
      await seedJob(host, 'pending', STALE_AT - i);
      hosts.push(host);
    }

    const counted = countingEnv(env);
    expect(await sweepStaleGenerations(counted.env, NOW)).toEqual({
      games: STALE_SWEEP_BATCH_LIMIT,
      revisionJobs: STALE_SWEEP_BATCH_LIMIT,
    });
    expect(counted.count()).toBe(2);

    expect(await sweepStaleGenerations(env, NOW)).toEqual({ games: extra, revisionJobs: extra });
    for (const id of games) {
      expect((await gameRow(id)).generation_state).toBe('failed');
    }
    for (const id of hosts) {
      expect((await jobRow(id)).state).toBe('failed');
    }
  });
});
