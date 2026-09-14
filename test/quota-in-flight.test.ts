/**
 * 進行中の要求がある利用者の生成・フォーク・推敲を断る（#455 / 3.3-2 / 4.3 / 確定25）。
 *
 * # issue の acceptance と、それをどこで見るか
 *
 * | acceptance | 見る場所 |
 * |---|---|
 * | 進行中の新規生成・フォーク・推敲がある利用者は、3 経路のどれでも断られる。`generations` に行が増えず、LLM も呼ばれない（3 × 3） | 「3 × 3 の組み合わせ」 |
 * | 時間の区切りを過ぎた `pending` / `running` の行があっても、新しい要求が通る | 「時間の区切り」 |
 * | 同時に届いた 2 本の要求のうち、通るのは 1 本だけ | 「同時に届いた 2 本」 |
 * | 断られたときの応答が、日次枠切れ・月次上限の応答と区別される | 「応答の区別」 |
 *
 * # 生成 API を呼ばない
 *
 * **1 回 ¥22.41 が受け入れ条件に混ざる形にしない**（`test/fork.test.ts` / `test/revise.test.ts`
 * と同じ方針）。経路のハンドラを直接叩き、段を差し替える。
 *
 * **ただし「LLM が呼ばれない」「台帳が増えない」を空の検査にしない。** 2 本目の要求には
 * {@link probePipeline} を渡す。これはジョブの起動で**生成の段（LLM の代わり）を呼び、
 * 本物の台帳（`recordGenerationCost`）へ 1 行書く。** 断る判定が抜けていれば、呼び出しの
 * 回数と `generations` の行数が実際に増える——そうなることを「進行中が無ければ通る」で
 * 先に確かめてある（対照）。
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createForkRoutes } from '../src/fork.js';
import type { GenerationJob, GenerationPipeline } from '../src/generate.js';
import { GENERATE_PATH, createGenerateRoutes, defaultPipeline } from '../src/generate.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import type { GenerationResult } from '../src/generation-models.js';
import {
  STALE_AFTER_SECONDS,
  claimGenerationJob,
  completeGame,
  createPendingGame,
  createPendingGameIfIdle,
  hashJobToken,
  publishGame,
} from '../src/games.js';
import {
  GENERATE_MESSAGES,
  IN_FLIGHT_MESSAGE_KEY,
  DAILY_QUOTA_MESSAGE_KEY,
  MONTHLY_LIMIT_MESSAGE_KEY,
  selectGenerateMessageKey,
} from '../src/generate-page.js';
import {
  FORK_PARENT_ID_FIELD,
  FORK_PATH,
  FORK_PROMPT_FIELD,
  REVISE_GAME_ID_FIELD,
  REVISE_PATH,
  REVISE_PROMPT_FIELD,
} from '../src/paths.js';
import {
  DAILY_QUOTA_PER_USER,
  DAILY_QUOTA_REASON,
  IN_FLIGHT_HEADING,
  IN_FLIGHT_REASON,
  IN_FLIGHT_STATUS,
  MONTHLY_COST_LIMIT_JPY,
  MONTHLY_LIMIT_REASON,
  QUOTA_EXCEEDED_STATUS,
} from '../src/quota.js';
import { createReviseRoutes } from '../src/revise.js';
import {
  claimRevisionJob,
  claimRevisionSlot,
  completeRevision,
  revisionStatus,
} from '../src/revisions.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { looksStalled } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-in-flight-guard-01';
const BASE_SOURCE = 'package main\n\nfunc main() {}\n';
const JSON_TYPE = 'application/json';

/** 3 経路。**進行中の側と、あとから届く側の両方に同じ 3 つが並ぶ。** */
const ROUTES = ['generate', 'fork', 'revise'] as const;
type RouteKind = (typeof ROUTES)[number];

/** フォークの親（公開済み。誰の要求でも親にできる）。 */
let publishedParentId = '';

beforeAll(async () => {
  await applySchema();
  const author = await createUser('in-flight-parent-author');
  publishedParentId = await createReadyDraft(author);
  const published = await publishGame(env, publishedParentId, author);
  expect(published.ok).toBe(true);
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/** @returns 現在時刻（UNIX 秒） */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 利用者を 1 人用意する。
 *
 * @param id 利用者の id
 * @returns 利用者の id
 */
async function createUser(id: string): Promise<string> {
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 0)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * 完成済みの `draft` を 1 件作り、R2 にソースを置く（**進行中ではない**）。
 *
 * @param userId 作者
 * @returns 作品 id
 */
async function createReadyDraft(userId: string): Promise<string> {
  const pending = await createPendingGame(env, userId, { prompt: '玉を避けるゲーム' });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  // 成果物のキーを作品ごとに変える（`test/fork.test.ts` の `createReadyGame` と同じ理由）。
  const sha = `${'0'.repeat(56)}${pending.id.slice(0, 8)}`;
  expect(
    await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: sha })),
  ).toBe(true);
  const row = await env.DB.prepare('select source_key from games where id = ?')
    .bind(pending.id)
    .first<{ source_key: string }>();
  await env.BUCKET.put(row!.source_key, BASE_SOURCE);
  return pending.id;
}

/**
 * ジョブを起動したことにするだけの段（**行は `pending` のまま残る＝進行中**）。
 *
 * @returns 差し替えた pipeline
 */
function holdPipeline(): GenerationPipeline {
  return { ...defaultPipeline, startJob: async () => undefined };
}

/** 生成の段が返す雛形（`test/generate.test.ts` の `recordingPipeline` と同じ形）。 */
function fakeGeneration(): GenerationResult {
  return {
    modelKey: DEFAULT_GENERATION_MODEL_KEY,
    modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
    source: BASE_SOURCE,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    },
    stopReason: 'end_turn',
  };
}

/**
 * **断られなければ LLM を呼んで台帳へ書く**段（モジュール冒頭）。
 *
 * クォータ判定（`checkGenerationQuota`）と台帳（`recordGenerationCost`）は既定のまま
 * 本物を使う。起動の段は生成の段を 1 回呼び、その結果を台帳へ 1 行書く
 * （`runGenerationJob` の 1 試行ぶんの費用の出方と同じ）。
 *
 * @returns LLM 呼び出しの記録と、差し替えた pipeline
 */
function probePipeline(): { llmCalls: GenerationJob[]; pipeline: GenerationPipeline } {
  const llmCalls: GenerationJob[] = [];
  const pipeline: GenerationPipeline = {
    ...defaultPipeline,
    generateSource: async () => fakeGeneration(),
    startJob: async (stageEnv, job, stages) => {
      llmCalls.push(job);
      const generated = await stages.generateSource(stageEnv, job.request);
      await stages.recordCost(stageEnv, job.userId, job.request, generated);
    },
  };
  return { llmCalls, pipeline };
}

/**
 * セッション cookie を載せたヘッダを作る。
 *
 * @param userId 利用者
 * @param accept `Accept`（省くと JSON の応答を受ける）
 * @returns ヘッダ
 */
async function headersFor(userId: string, accept?: string): Promise<Record<string, string>> {
  const issuedAt = nowSeconds();
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return {
    'content-type': JSON_TYPE,
    cookie: buildSessionCookie(token, 3600).split(';')[0]!,
    ...(accept === undefined ? {} : { accept }),
  };
}

/** 要求の宛先（推敲は対象の作品が要る）。 */
interface Target {
  /** 推敲する作品（自分の `draft`）。 */
  readonly draftId: string;
}

/**
 * 3 経路のどれかへ要求を送る。
 *
 * @param route 経路
 * @param userId 送る利用者
 * @param target 推敲の対象
 * @param pipeline 差し替えた pipeline
 * @param accept `Accept`（省くと JSON）
 * @returns レスポンス
 */
async function send(
  route: RouteKind,
  userId: string,
  target: Target,
  pipeline: GenerationPipeline,
  accept?: string,
): Promise<Response> {
  const headers = await headersFor(userId, accept);
  if (route === 'generate') {
    return await dispatch(
      createGenerateRoutes(pipeline),
      new Request(`${APP_ORIGIN}${GENERATE_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: '新しいゲーム' }),
      }),
      testEnv(),
    );
  }
  if (route === 'fork') {
    return await dispatch(
      createForkRoutes(pipeline),
      new Request(`${APP_ORIGIN}${FORK_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          [FORK_PARENT_ID_FIELD]: publishedParentId,
          [FORK_PROMPT_FIELD]: '敵を増やす',
        }),
      }),
      testEnv(),
    );
  }
  return await dispatch(
    createReviseRoutes(pipeline),
    new Request(`${APP_ORIGIN}${REVISE_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        [REVISE_GAME_ID_FIELD]: target.draftId,
        [REVISE_PROMPT_FIELD]: '玉を速く',
      }),
    }),
    testEnv(),
  );
}

/** 利用者 1 人ぶんの、判定が動かしうるものの数。 */
interface Footprint {
  /** `generations` の行数（台帳。日次枠が数えるもの）。 */
  readonly generations: number;
  /** 自分の `games` の行数。 */
  readonly games: number;
  /** 自分の作品の推敲ジョブのうち、`pending` / `running` の数。 */
  readonly revisionJobs: number;
  /** 自分の作品の `revise_count` の合計。 */
  readonly reviseCount: number;
}

/**
 * 利用者 1 人ぶんの数を読む。
 *
 * @param userId 利用者
 * @returns 数
 */
async function footprintOf(userId: string): Promise<Footprint> {
  const row = await env.DB.prepare(
    `select
       (select count(*) from generations where user_id = ?1) as generations,
       (select count(*) from games where author_id = ?1) as games,
       (select count(*) from game_revision_jobs j join games g on g.id = j.game_id
         where g.author_id = ?1 and j.state in ('pending', 'running')) as revision_jobs,
       (select coalesce(sum(revise_count), 0) from games where author_id = ?1) as revise_count`,
  )
    .bind(userId)
    .first<{ generations: number; games: number; revision_jobs: number; revise_count: number }>();
  return {
    generations: row!.generations,
    games: row!.games,
    revisionJobs: row!.revision_jobs,
    reviseCount: row!.revise_count,
  };
}

/**
 * 利用者を用意し、推敲の対象になる `draft` を 2 件作る。
 *
 * **2 件にするのは、推敲中に「別の作品の」推敲を押す組み合わせを見るためである。**
 * 同じ作品の 2 本目は #455 より前から主キーで止まっていた（`src/revisions.ts`）。
 *
 * @param id 利用者の id
 * @returns 利用者と、進行中にする側・あとから押す側の作品
 */
async function prepareUser(
  id: string,
): Promise<{ userId: string; first: Target; second: Target }> {
  const userId = await createUser(id);
  return {
    userId,
    first: { draftId: await createReadyDraft(userId) },
    second: { draftId: await createReadyDraft(userId) },
  };
}

/** 受け付けたときのステータス（HTML ではなく JSON で受けるので 202）。 */
const ACCEPTED = 202;

describe('3 × 3 の組み合わせ（acceptance 1）', () => {
  it('対照: 進行中が無ければ 3 経路とも通り、LLM が呼ばれ台帳が 1 行増える', async () => {
    // **この対照が落ちるなら、下の「増えない」は何も確かめていない。**
    for (const route of ROUTES) {
      const { userId, first } = await prepareUser(`in-flight-control-${route}`);
      const before = await footprintOf(userId);
      const probe = probePipeline();

      const response = await send(route, userId, first, probe.pipeline);

      expect(response.status, route).toBe(ACCEPTED);
      expect(probe.llmCalls, route).toHaveLength(1);
      expect((await footprintOf(userId)).generations, route).toBe(before.generations + 1);
    }
  });

  for (const inFlight of ROUTES) {
    for (const next of ROUTES) {
      it(`${inFlight} が進行中の利用者は ${next} を断られ、台帳も行も増えず LLM も呼ばれない`, async () => {
        const { userId, first, second } = await prepareUser(`in-flight-${inFlight}-then-${next}`);

        // 1 本目: ジョブは起動したことになるが終わらない（＝進行中）。
        const started = await send(inFlight, userId, first, holdPipeline());
        expect(started.status).toBe(ACCEPTED);

        const before = await footprintOf(userId);
        const probe = probePipeline();

        const refused = await send(next, userId, second, probe.pipeline);

        expect(refused.status).toBe(IN_FLIGHT_STATUS);
        expect(await refused.json()).toEqual({ error: IN_FLIGHT_REASON });
        // **LLM を呼ばない。** 起動の段まで来ていない。
        expect(probe.llmCalls).toHaveLength(0);
        // **台帳も行も、推敲の枠も動かない。**
        expect(await footprintOf(userId)).toEqual(before);
      });
    }
  }

  it('進行中の要求は、その利用者だけを止める（他の利用者は通る）', async () => {
    const busy = await prepareUser('in-flight-busy-owner');
    const other = await prepareUser('in-flight-busy-other');
    expect((await send('generate', busy.userId, busy.first, holdPipeline())).status).toBe(ACCEPTED);

    const probe = probePipeline();
    const response = await send('generate', other.userId, other.first, probe.pipeline);

    expect(response.status).toBe(ACCEPTED);
    expect(probe.llmCalls).toHaveLength(1);
  });

  it('終わった要求（ready / failed）は進行中に数えない', async () => {
    const { userId, first } = await prepareUser('in-flight-finished');
    // 1 本目を失敗で閉じる（`failGame` の経路）。起動の段が投げると経路層が行を閉じる。
    const failing: GenerationPipeline = {
      ...defaultPipeline,
      startJob: async () => {
        throw new Error('invoke failed');
      },
    };
    expect((await send('fork', userId, first, failing)).status).toBe(500);
    expect((await send('revise', userId, first, failing)).status).toBe(500);

    const probe = probePipeline();
    expect((await send('generate', userId, first, probe.pipeline)).status).toBe(ACCEPTED);
    expect(probe.llmCalls).toHaveLength(1);
  });
});

/**
 * 進行中にした行を、区切りの外（または内）へ動かす。
 *
 * **作成時刻と開始時刻の両方を動かす。** 判定は「開始時刻、まだ握られていなければ作成時刻」
 * から数えるので、片方だけを動かすと、どちらを見ているかを確かめられない。
 *
 * @param userId 利用者
 * @param since 行の作成・開始の時刻（UNIX 秒）
 * @param state `running` にするなら開始時刻も入れる
 */
async function ageInFlightRows(
  userId: string,
  since: number,
  state: 'pending' | 'running',
): Promise<void> {
  const startedAt = state === 'running' ? since : null;
  await env.DB.batch([
    env.DB.prepare(
      `update games set created_at = ?, generation_state = ?, generation_started_at = ?
        where author_id = ? and generation_state in ('pending', 'running')`,
    ).bind(since, state, startedAt, userId),
    env.DB.prepare(
      `update game_revision_jobs set created_at = ?, state = ?, started_at = ?
        where state in ('pending', 'running')
          and game_id in (select id from games where author_id = ?)`,
    ).bind(since, state, startedAt, userId),
  ]);
}

describe('時間の区切り（acceptance 2）', () => {
  for (const inFlight of ROUTES) {
    for (const state of ['pending', 'running'] as const) {
      for (const next of ROUTES) {
        it(`区切りを過ぎた ${inFlight}（${state}）が残っていても ${next} は通る`, async () => {
          const { userId, first, second } = await prepareUser(
            `in-flight-stale-${inFlight}-${state}-${next}`,
          );
          expect((await send(inFlight, userId, first, holdPipeline())).status).toBe(ACCEPTED);
          // **止まったまま残った行**を作る。`STALE_AFTER_SECONDS` ちょうど前に開始した行は、
          // 作品ページが「中断した可能性」と言い始める行である（`looksStalled`）。
          await ageInFlightRows(userId, nowSeconds() - STALE_AFTER_SECONDS - 1, state);

          const probe = probePipeline();
          const response = await send(next, userId, second, probe.pipeline);

          expect(response.status).toBe(ACCEPTED);
          expect(probe.llmCalls).toHaveLength(1);
        });
      }
    }
  }

  it('区切りの内側（開始から区切りの 1 分前）の行はまだ進行中である', async () => {
    const { userId, first, second } = await prepareUser('in-flight-within-window');
    expect((await send('generate', userId, first, holdPipeline())).status).toBe(ACCEPTED);
    await ageInFlightRows(userId, nowSeconds() - STALE_AFTER_SECONDS + 60, 'running');

    const probe = probePipeline();
    expect((await send('revise', userId, second, probe.pipeline)).status).toBe(IN_FLIGHT_STATUS);
    expect(probe.llmCalls).toHaveLength(0);
  });

  it('境界は作品ページの「中断した可能性」と同じ瞬間である（ずれない）', async () => {
    const userId = await createUser('in-flight-boundary');
    const createdAt = 1_000_000;
    const held = await createPendingGame(env, userId, { prompt: '境界' }, createdAt);
    expect(held.id).not.toBe('');

    for (const offset of [STALE_AFTER_SECONDS - 1, STALE_AFTER_SECONDS, STALE_AFTER_SECONDS + 1]) {
      const now = createdAt + offset;
      const stalled = looksStalled({ createdAt, startedAt: null }, now);
      const created = await createPendingGameIfIdle(env, userId, { prompt: `境界 ${offset}` }, now);
      // **止まって見える瞬間に、判定も通す。** 通したら次の検査のために閉じる。
      expect(created !== null, `offset=${offset}`).toBe(stalled);
      if (created !== null) {
        await env.DB.prepare(`update games set generation_state = 'failed' where id = ?`)
          .bind(created.id)
          .run();
      }
    }
  });

  it('握られた（running の）行は、作成時刻ではなく開始時刻から数える', async () => {
    const userId = await createUser('in-flight-started-at');
    const createdAt = 2_000_000;
    const held = await createPendingGame(env, userId, { prompt: '開始' }, createdAt);
    // キューで待ってから、作成の 500 秒後に走り始めた（`pending` の有効期限は 300 秒だが、
    // ここで見たいのは「どちらの時刻から数えるか」だけである）。
    const startedAt = createdAt + 500;
    expect(
      await claimGenerationJob(env, held.id, await hashJobToken(held.jobToken), startedAt),
    ).toBe(true);

    // 作成時刻から数えれば区切りの外、開始時刻から数えれば内側。
    const now = createdAt + STALE_AFTER_SECONDS + 10;
    expect(await createPendingGameIfIdle(env, userId, { prompt: 'まだ走っている' }, now)).toBeNull();
    expect(
      await createPendingGameIfIdle(
        env,
        userId,
        { prompt: '走り終えたはず' },
        startedAt + STALE_AFTER_SECONDS,
      ),
    ).not.toBeNull();
  });
});

/** 推敲ジョブ 1 本ぶんの状態（D1 の列そのもの）。 */
interface RevisionJobRow {
  job_token_hash: string;
  state: string;
  created_at: number;
  started_at: number | null;
}

/**
 * 作品の推敲ジョブの行を読む。
 *
 * @param gameId 作品 id
 * @returns 行（無ければ null）
 */
async function revisionJobOf(gameId: string): Promise<RevisionJobRow | null> {
  return await env.DB.prepare(
    'select job_token_hash, state, created_at, started_at from game_revision_jobs where game_id = ?',
  )
    .bind(gameId)
    .first<RevisionJobRow>();
}

describe('同じ作品に止まったまま残った推敲ジョブ（acceptance 2 / PR #467 のレビュー）', () => {
  /**
   * 同じ作品に、指定の時刻に始まった推敲ジョブを 1 本残す（**経路を通さず、直接**）。
   *
   * @param userId 作者
   * @param gameId 作品
   * @param since ジョブの作成（running なら開始も）の時刻
   * @param state 残す状態
   * @returns 残したジョブのトークンのハッシュ
   */
  async function leaveRevisionJob(
    userId: string,
    gameId: string,
    since: number,
    state: 'pending' | 'running',
  ): Promise<string> {
    const oldHash = `stuck-${gameId}-${state}`;
    expect(await claimRevisionSlot(env, gameId, userId, '止まった手直し', oldHash, since)).toBe(true);
    if (state === 'running') {
      expect(await claimRevisionJob(env, gameId, oldHash, since)).toBe(true);
    }
    return oldHash;
  }

  for (const state of ['pending', 'running'] as const) {
    it(`区切りを過ぎた ${state} のジョブがあっても同じ作品を推敲でき、ジョブは新しいトークンの pending に置き換わる`, async () => {
      const { userId, first } = await prepareUser(`in-flight-stuck-revision-${state}`);
      const oldHash = await leaveRevisionJob(
        userId,
        first.draftId,
        nowSeconds() - STALE_AFTER_SECONDS - 1,
        state,
      );

      const probe = probePipeline();
      const response = await send('revise', userId, first, probe.pipeline);

      // **断りの文言（not-revisable / generation-in-flight）のどちらも選ばない。** 通る。
      expect(response.status).toBe(ACCEPTED);
      expect(probe.llmCalls).toHaveLength(1);
      const job = await revisionJobOf(first.draftId);
      expect(job?.state).toBe('pending');
      expect(job?.started_at).toBeNull();
      expect(job?.job_token_hash).not.toBe(oldHash);
      expect(job?.job_token_hash).toBe(await hashJobToken(probe.llmCalls[0]!.jobToken));
      // 止まった 1 回も枠は返さない（費用が出ていた可能性がある）。新しい 1 回を足す。
      expect((await revisionStatus(env, first.draftId)).used).toBe(2);

      // **遅れて戻った古いジョブは何も書けない。** トークンが入れ替わっている。
      expect(await claimRevisionJob(env, first.draftId, oldHash)).toBe(false);
      expect(await claimGenerationJob(env, first.draftId, oldHash)).toBe(false);
      expect(
        await completeRevision(env, first.draftId, oldHash, {
          goVersion: 'go1.26.5',
          sourceKey: 'builds/stale/source.go',
          wasmKey: 'builds/stale/game.wasm.br',
        }),
      ).toBe(false);
      expect((await revisionJobOf(first.draftId))?.job_token_hash).toBe(job?.job_token_hash);
    });

    it(`区切りの内側の ${state} のジョブがあれば、同じ作品の推敲は進行中の文言で断られる`, async () => {
      const { userId, first } = await prepareUser(`in-flight-live-revision-${state}`);
      const oldHash = await leaveRevisionJob(
        userId,
        first.draftId,
        nowSeconds() - STALE_AFTER_SECONDS + 60,
        state,
      );

      const probe = probePipeline();
      const response = await send('revise', userId, first, probe.pipeline);

      expect(response.status).toBe(IN_FLIGHT_STATUS);
      // **理由の分類を誤らない。** まだ走っている推敲なので「推敲できない作品」ではない。
      expect(await response.json()).toEqual({ error: IN_FLIGHT_REASON });
      expect(probe.llmCalls).toHaveLength(0);
      const job = await revisionJobOf(first.draftId);
      expect(job?.job_token_hash).toBe(oldHash);
      expect(job?.state).toBe(state);
      expect((await revisionStatus(env, first.draftId)).used).toBe(1);
    });
  }
});

describe('同時に届いた 2 本（acceptance 3）', () => {
  it('対照: 排他の無い作成では、同時の 2 本が両方とも入る（検査が効いていることの確認）', async () => {
    const userId = await createUser('in-flight-race-control');
    const created = await Promise.all([
      createPendingGame(env, userId, { prompt: '1 本目' }),
      createPendingGame(env, userId, { prompt: '2 本目' }),
    ]);
    expect(created.filter((game) => game !== null)).toHaveLength(2);
  });

  it('行を作る文そのものが 1 本しか通さない（実際の D1）', async () => {
    for (let round = 0; round < 5; round += 1) {
      const userId = await createUser(`in-flight-race-direct-${round}`);
      const created = await Promise.all([
        createPendingGameIfIdle(env, userId, { prompt: '1 本目' }),
        createPendingGameIfIdle(env, userId, { prompt: '2 本目' }),
        createPendingGameIfIdle(env, userId, { prompt: '3 本目' }),
      ]);
      expect(created.filter((game) => game !== null), `round=${round}`).toHaveLength(1);
      expect((await footprintOf(userId)).games).toBe(1);
    }
  });

  it('推敲の枠の取得も、別々の作品へ同時に 2 本を通さない', async () => {
    const { userId, first, second } = await prepareUser('in-flight-race-revision');
    const claimed = await Promise.all([
      claimRevisionSlot(env, first.draftId, userId, '1 本目', 'race-hash-1'),
      claimRevisionSlot(env, second.draftId, userId, '2 本目', 'race-hash-2'),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const after = await footprintOf(userId);
    expect(after.revisionJobs).toBe(1);
    // **枠を取れなかった側の回数は増えない**（同じ batch の条件付き加算。`src/revisions.ts`）。
    expect(after.reviseCount).toBe(1);
  });

  for (const [a, b] of [
    ['generate', 'generate'],
    ['generate', 'fork'],
    ['fork', 'revise'],
    ['revise', 'revise'],
    ['revise', 'generate'],
  ] as const) {
    it(`経路をまたいで同時に届いた ${a} と ${b} のうち、通るのは 1 本だけ`, async () => {
      const { userId, first, second } = await prepareUser(`in-flight-race-${a}-${b}`);
      const before = await footprintOf(userId);
      const probe = probePipeline();

      const responses = await Promise.all([
        send(a, userId, first, probe.pipeline),
        send(b, userId, second, probe.pipeline),
      ]);
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([ACCEPTED, IN_FLIGHT_STATUS].sort());
      expect(probe.llmCalls).toHaveLength(1);
      expect((await footprintOf(userId)).generations).toBe(before.generations + 1);
    });
  }
});

/**
 * 日次枠を使い切った状態を作る（確定25。台帳の行数で数える）。
 *
 * @param userId 利用者
 */
async function exhaustDailyQuota(userId: string): Promise<void> {
  const now = nowSeconds();
  for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
    await env.DB.prepare(
      `insert into generations
         (id, game_id, user_id, prompt, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          cost_jpy, succeeded, created_at)
       values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 0, 1, ?)`,
    )
      .bind(`in-flight-daily-${userId}-${i}`, userId, DEFAULT_GENERATION_MODEL_KEY, now)
      .run();
  }
}

/**
 * 断りの画面の見出しを取り出す。
 *
 * @param response HTML の応答
 * @returns `<h1>` の中身
 */
async function headingOf(response: Response): Promise<string> {
  return headingIn(await response.text());
}

/**
 * 画面の HTML から `<h1>` の文字を取り出す。
 *
 * @param body 画面の HTML
 * @returns 見出し（無ければ空文字）
 */
function headingIn(body: string): string {
  return /<h1>([^<]*)<\/h1>/u.exec(body)?.[1] ?? '';
}

/**
 * 進行中の断りの本文の 1 文目（#455 / #513）。**定数（`IN_FLIGHT_BODY`）から写さない**——写すと、定数に
 * 旧い呼び名が戻っても同じ値を期待して緑になる。
 */
const IN_FLIGHT_BODY_TEXT = '生成・フォーク・リフォージは 1 つずつ行えます。いま進んでいるものが終わってから、もう一度お試しください。';

describe('応答の区別（acceptance 4）', () => {
  it('3 経路とも、進行中の断りは日次枠切れ（429）と別のステータス・分類名・見出しで返る', async () => {
    for (const route of ROUTES) {
      // 進行中の利用者。
      const busy = await prepareUser(`in-flight-response-busy-${route}`);
      expect((await send('generate', busy.userId, busy.first, holdPipeline())).status).toBe(
        ACCEPTED,
      );
      // 日次枠を使い切った利用者（進行中の要求は無い）。
      const exhausted = await prepareUser(`in-flight-response-daily-${route}`);
      await exhaustDailyQuota(exhausted.userId);

      const inFlightJson = await send(route, busy.userId, busy.second, probePipeline().pipeline);
      const dailyJson = await send(route, exhausted.userId, exhausted.second, probePipeline().pipeline);

      expect(inFlightJson.status, route).toBe(IN_FLIGHT_STATUS);
      expect(dailyJson.status, route).toBe(QUOTA_EXCEEDED_STATUS);
      expect(IN_FLIGHT_STATUS).not.toBe(QUOTA_EXCEEDED_STATUS);
      expect((await inFlightJson.json()) as { error: string }, route).toEqual({
        error: IN_FLIGHT_REASON,
      });
      expect(((await dailyJson.json()) as { error: string }).error, route).toBe(DAILY_QUOTA_REASON);

      if (route === 'generate') {
        // 生成は API だけ（画面は `GENERATE_MESSAGES` で文言を引く。下の検査）。
        continue;
      }
      const html = 'text/html';
      const inFlightHtml = await send(route, busy.userId, busy.second, probePipeline().pipeline, html);
      const dailyHtml = await send(
        route,
        exhausted.userId,
        exhausted.second,
        probePipeline().pipeline,
        html,
      );
      expect(inFlightHtml.status, route).toBe(IN_FLIGHT_STATUS);
      const inFlightText = await inFlightHtml.text();
      expect(headingIn(inFlightText), route).toBe(IN_FLIGHT_HEADING);
      expect(await headingOf(dailyHtml), route).not.toBe(IN_FLIGHT_HEADING);
      // **断りの画面に旧い呼び名（改造・推敲・手直し）を出さない**（#513）。本文は 3 経路で共有する
      // `IN_FLIGHT_BODY`（`src/quota.ts`）なので、定数から写さず画面の文言をそのまま書いて照合する。
      expect(oldOperationNamesIn(inFlightText), route).toEqual([]);
      expect(inFlightText, route).toContain(IN_FLIGHT_BODY_TEXT);
    }
  });

  it('生成画面の文言は、日次・月次の文言と別の鍵で、枠切れの言い回しを含まない', () => {
    const key = selectGenerateMessageKey(IN_FLIGHT_STATUS, IN_FLIGHT_REASON);
    expect(key).toBe(IN_FLIGHT_MESSAGE_KEY);
    expect(key).not.toBe(DAILY_QUOTA_MESSAGE_KEY);
    expect(key).not.toBe(MONTHLY_LIMIT_MESSAGE_KEY);

    const message = GENERATE_MESSAGES[IN_FLIGHT_MESSAGE_KEY]!;
    expect(message).toContain(IN_FLIGHT_HEADING);
    // 生成画面の断りにも同じ本文が出る。旧い呼び名を出さない（#513）。
    expect(message).toContain(IN_FLIGHT_BODY_TEXT);
    expect(oldOperationNamesIn(message)).toEqual([]);
    // **4.4 の 2 つの停止の言い回しを混ぜない**（枠は尽きていない）。
    expect(message).not.toContain('本日の枠は終了しました');
    expect(message).not.toContain('今月の生成は終了しました');
    expect(message).not.toContain('使い切り');
    // 枠を消費していないことを言う（日次枠切れと読まれないため）。
    expect(message).toContain('消費していません');
  });

  it('月次上限の断り（429 monthly-limit）とも区別される', async () => {
    // **サービス全体の費用を上限まで積む**ので、この検査の最後に必ず消す
    // （同じファイルの他の検査へ漏らさない）。
    const busy = await prepareUser('in-flight-response-busy-monthly');
    expect((await send('generate', busy.userId, busy.first, holdPipeline())).status).toBe(ACCEPTED);
    const other = await prepareUser('in-flight-response-monthly');
    const ledgerId = 'in-flight-monthly-limit-row';
    await env.DB.prepare(
      `insert into generations
         (id, game_id, user_id, prompt, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          cost_jpy, succeeded, created_at)
       values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, ?, 1, ?)`,
    )
      .bind(ledgerId, other.userId, DEFAULT_GENERATION_MODEL_KEY, MONTHLY_COST_LIMIT_JPY, nowSeconds())
      .run();
    try {
      for (const route of ROUTES) {
        const monthly = await send(route, other.userId, other.second, probePipeline().pipeline);
        expect(monthly.status, route).toBe(QUOTA_EXCEEDED_STATUS);
        expect(((await monthly.json()) as { error: string }).error, route).toBe(MONTHLY_LIMIT_REASON);
      }
    } finally {
      await env.DB.prepare('delete from generations where id = ?').bind(ledgerId).run();
    }
    // 月次が戻れば、進行中の利用者は 429 ではなく 409 で断られる。
    const inFlight = await send('fork', busy.userId, busy.second, probePipeline().pipeline);
    expect(inFlight.status).toBe(IN_FLIGHT_STATUS);
  });
});
