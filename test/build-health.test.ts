import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_STOP_FAILURE_THRESHOLD,
  BUILD_STOP_WINDOW_SECONDS,
  buildPathStopped,
  clearBuildPathFailures,
  isBuildPathFailure,
  recordBuildPathFailure,
} from '../src/build-health.js';
import {
  BuildFunctionFailed,
  BuildNotConfigured,
  BuildRejected,
  BuildResponseUnreadable,
  BuildTimedOut,
} from '../src/build-client.js';
import { BuildRetriesExhausted } from '../src/build-retry.js';
import { dispatch } from '../src/routes.js';
import { generateCallbackRoutes } from '../src/generate-callback.js';
import { createPendingGame } from '../src/games.js';
import { forgetBuildCache, recordBuildCache, sourceCacheKey } from '../src/build-cache.js';
import { handleOrchestratorEvent } from '../src/orchestrator/handler.js';
import { buildOrchestratorPayload } from '../src/orchestrator/payload.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { applySchema } from './helpers/schema.js';

/**
 * 3.8 の degrade の発火信号（#140 / 確定24）。
 *
 * issue #140 の acceptance は 2 件で、**2 件目が本体**である。
 *
 *   1. ビルド依頼が失敗した状態を作ると生成画面が「生成停止中」を出す
 *   2. **D1 の不調では出ない**ことを、1 と区別してテストで確認できる
 *
 * どちらも**同じ経路を実際に通して**確かめる（`handleOrchestratorEvent` →
 * `/api/generate/callback` → D1 → 画面）。段をモックにすると、検証したい
 * 「ビルドの失敗と D1 の不調が別の扱いを受ける」がそのまま空になる
 * （docs/handoff.md 4 章「検査そのものを疑うこと」）。
 *
 * **`/api/generate` は呼ばない。** 呼べば 1 回あたり約 16〜19 円が実際に課金される。
 * Bedrock もビルド関数も `fetch` の差し替えで偽装する（`test/build-client.test.ts` /
 * `test/orchestrator.test.ts` と同じ継ぎ目）。
 *
 * 画面側（「生成停止中」を出すこと・フォームを描かないこと）は
 * `test/generate-page.test.ts` が持つ。ここが持つのは**信号そのもの**である。
 */

/** 生成の段が返す Go ソース（許可パッケージ検査を通る最小の形）。 */
const GO_SOURCE = 'package main\n\nfunc main() {}\n';

/**
 * オーケストレータへ渡す環境変数（`test/orchestrator.test.ts` と同じ形）。
 *
 * **実在の鍵を使わない。** 署名の検査に本物を使う理由が無い。
 *
 * @returns 環境変数
 */
function lambdaEnv(): Record<string, string | undefined> {
  return {
    CALLBACK_BASE_URL: `https://${env.APP_HOST}`,
    BUILD_FUNCTION_NAME: 'game-forge-build',
    AWS_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'test-access-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    AWS_SESSION_TOKEN: 'test-session-token',
  };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `health-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 生成中の作品を 1 件用意し、そのペイロードを作る。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者・作品 id・ペイロード
 */
async function seedJob(suffix: string): Promise<{
  userId: string;
  gameId: string;
  payload: ReturnType<typeof buildOrchestratorPayload>;
}> {
  const userId = await seedUser(suffix);
  const request = { prompt: `${suffix} のゲーム` };
  const pending = await createPendingGame(env, userId, request);
  return {
    userId,
    gameId: pending.id,
    payload: buildOrchestratorPayload(
      { gameId: pending.id, jobToken: pending.jobToken, request },
      DEFAULT_GENERATION_MODEL_KEY,
    ),
  };
}

/** `Converse` の成功応答（`test/orchestrator.test.ts` と同じ形）。 */
function converseResponse(): Response {
  return Response.json({
    output: { message: { role: 'assistant', content: [{ text: GO_SOURCE }] } },
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1_092,
      outputTokens: 4_171,
      cacheReadInputTokens: 4_841,
      cacheWriteInputTokens: 0,
    },
  });
}

/**
 * ビルド関数の成功応答（`test/orchestrator.test.ts` と同じ形）。
 *
 * @param suffix 成果物のキーを一意にする接尾辞
 * @returns 応答
 */
async function buildResponse(suffix: string): Promise<Response> {
  const bytes = new TextEncoder().encode(`brotli-${suffix}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const prefix = suffix.padEnd(64, '0').slice(0, 64);
  return new Response(
    JSON.stringify({
      ok: true,
      goVersion: 'go1.26.5',
      wasm: { bytes: 11_404_411, sha256: 'a'.repeat(64) },
      compressed: { bytes: bytes.byteLength, sha256, contentEncoding: 'br', data: btoa(binary) },
      storage: {
        sourceKey: `builds/${prefix}/source.go`,
        wasmKey: `builds/${prefix}/go1.26.5/game.wasm.br`,
      },
      timings: {
        resetMs: 0,
        prepareMs: 20,
        buildMs: 18_562,
        compressMs: 2_373,
        uploadMs: 310,
        totalMs: 21_265,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-1' } },
  );
}

/**
 * Invoke API がスロットリングした応答（確定24 の停止事象の 1 つ）。
 *
 * **`BuildFunctionFailed`（`kind='function'`）になる。**
 *
 * @returns 応答
 */
function throttledResponse(): Response {
  return new Response(JSON.stringify({ message: 'Rate exceeded' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'x-amzn-errortype': 'TooManyRequestsException',
      'x-amzn-requestid': 'req-throttled',
    },
  });
}

/** ビルドが「コンパイルを通らなかった」ときの応答（`ok:false`。経路は生きている）。 */
function buildRejectedResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      stage: 'build',
      message: './main.go:7:2: undefined: ebiten.RunGam',
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-1' } },
  );
}

/**
 * コールバックを Worker の経路へ流す `fetch`。
 *
 * @param binding 経路へ渡す env（D1 を壊した env を渡せるようにしてある）
 * @returns `fetch`
 */
function callbackFetch(binding: Env = env): (request: Request) => Promise<Response> {
  return async (request: Request) => await dispatch(generateCallbackRoutes, request, binding);
}

/**
 * 予算をすぐ使い切る時計。
 *
 * コールバックの再送は**実時間の予算**で打ち切る（`src/orchestrator/callbacks.ts`）。
 * `sleep` を空にしただけだと、予算 120 秒ぶんの空回りが実時間で走る。
 *
 * @returns 呼ぶたびに 30 秒進む `now`
 */
function fastClock(): () => number {
  let at = Date.now();
  return () => {
    at += 30_000;
    return at;
  };
}

/** `build_health` の行数。 */
async function signalCount(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from build_health').first<{ n: number }>();
  return row!.n;
}

beforeAll(async () => {
  await applySchema();
});

afterEach(async () => {
  // **信号はサービス全体の状態である。** 残すと次のテストの判定に効く。
  await env.DB.prepare('delete from build_health').run();
  await env.DB.prepare("delete from generations where user_id like 'health-user-%'").run();
});

describe('何を停止事象と数えるか（確定24）', () => {
  it('数えるのは kind=function だけ（関数の失敗・スロットリング・リージョン障害）', () => {
    // **`BuildFunctionFailed` が 3 つをまとめて運ぶ**（`src/build-client.ts`）。
    expect(isBuildPathFailure(new BuildFunctionFailed(429, 'TooManyRequestsException', null, 'r'))).toBe(
      true,
    );
    // 送信そのものが失敗した（DNS・TLS・接続断）。状態コードは持たない。
    expect(isBuildPathFailure(new BuildFunctionFailed(0, 'TypeError', null, null))).toBe(true);
    // 応答の形が違う。**同じ `kind` を名乗る**ので同じ扱いになる。
    expect(isBuildPathFailure(new BuildResponseUnreadable('本文が JSON ではありません'))).toBe(true);
  });

  it('数えないもの（それぞれ別の理由で、経路は生きている）', () => {
    // 生成コードがコンパイルを通らなかった＝ 3.3-5 の平常の結果。
    expect(isBuildPathFailure(new BuildRejected('build', '診断'))).toBe(false);
    // **時間切れは 3.8 の #164 注記が明示的に除外している。**
    expect(isBuildPathFailure(new BuildTimedOut('function', 'req'))).toBe(false);
    expect(isBuildPathFailure(new BuildTimedOut('worker'))).toBe(false);
    // 資格情報が揃っていない＝ AWS へ 1 度も届いていない配備の誤り。
    expect(isBuildPathFailure(new BuildNotConfigured(['BUILD_AWS_REGION']))).toBe(false);
    // 上限まで試して通らなかった（5.2-7）。
    expect(isBuildPathFailure(new BuildRetriesExhausted(3, 'build'))).toBe(false);
  });

  it('ビルドの失敗ですらないものは、型として数えられない（#140 の誤爆の根）', () => {
    // **これがこのモジュールの核である。** D1 の不調は `BuildFailure` を作らない。
    // 「気をつけて分類する」のではなく、分類できる形になっていない。
    expect(isBuildPathFailure(new Error('D1_ERROR: no such table'))).toBe(false);
    expect(isBuildPathFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isBuildPathFailure(null)).toBe(false);
    expect(isBuildPathFailure(undefined)).toBe(false);
    expect(isBuildPathFailure('BuildFunctionFailed')).toBe(false);
    // **綴りで判定していない。** 名前を騙る値が通ると、8.3 の対象である生成物由来の
    // 文字列が判定へ混ざる経路ができる。
    expect(isBuildPathFailure({ kind: 'function', name: 'BuildFunctionFailed' })).toBe(false);
  });
});

describe('窓と閾値（誤爆のコストは見逃しより高い）', () => {
  const NOW = 1_800_000_000;

  it('1 件では停止と言わない（1 人の要求からは読み取れない。確定24）', async () => {
    await recordBuildPathFailure(env, 'game-a', NOW);
    expect(await signalCount()).toBe(1);
    expect(await buildPathStopped(env, NOW)).toBe(false);
  });

  it('閾値に達したら停止と言う', async () => {
    for (let index = 0; index < BUILD_STOP_FAILURE_THRESHOLD; index += 1) {
      await recordBuildPathFailure(env, `game-${index}`, NOW);
    }
    expect(await buildPathStopped(env, NOW)).toBe(true);
  });

  it('窓から出た失敗は数えない（＝誤爆は自動で解ける）', async () => {
    for (let index = 0; index < BUILD_STOP_FAILURE_THRESHOLD; index += 1) {
      await recordBuildPathFailure(env, `game-old-${index}`, NOW);
    }
    expect(await buildPathStopped(env, NOW + BUILD_STOP_WINDOW_SECONDS - 1)).toBe(true);
    // **窓が切れることが、停止中の唯一の復帰経路である**（停止中はフォームを描かない
    // ので、成功でほどけることが無い。`src/build-health.ts`）。
    expect(await buildPathStopped(env, NOW + BUILD_STOP_WINDOW_SECONDS + 1)).toBe(false);
  });

  it('同じ依頼を 2 回記録しても 1 件（Lambda の重複配信で閾値へ届かせない）', async () => {
    await recordBuildPathFailure(env, 'game-dup', NOW);
    await recordBuildPathFailure(env, 'game-dup', NOW + 5);
    expect(await signalCount()).toBe(1);
    expect(await buildPathStopped(env, NOW + 5)).toBe(false);
  });

  it('記録するときに窓の外の行を落とす（掃除のための書き込み経路を作らない）', async () => {
    await recordBuildPathFailure(env, 'game-stale', NOW);
    await recordBuildPathFailure(env, 'game-fresh', NOW + BUILD_STOP_WINDOW_SECONDS + 10);
    expect(await signalCount()).toBe(1);
  });
});

describe('D1 の書き込みを増やさない（3.6）', () => {
  it('平常時（表が空）の消去は行書き込みを 1 行も増やさない', async () => {
    // **これが「生成 1 回あたりの書き込みを増やさない」の実体である。** 成功した
    // 生成が通るのはこの経路だけで、平常時の表は空である。
    // **言葉で担保しない**（`src/build-health.ts` / shared-ai-rules 12 章）。
    expect(await signalCount()).toBe(0);
    expect(await clearBuildPathFailures(env)).toBe(0);
  });

  it('停止していたときだけ、消した行数ぶんの書き込みが出る', async () => {
    await recordBuildPathFailure(env, 'game-x', 1_800_000_000);
    await recordBuildPathFailure(env, 'game-y', 1_800_000_000);
    expect(await clearBuildPathFailures(env)).toBeGreaterThan(0);
    expect(await signalCount()).toBe(0);
  });

  it('信号の表に索引を張らない（索引は insert ごとに書き込みを足す）', async () => {
    const indexes = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and tbl_name = 'build_health'"
    ).all<{ name: string }>();
    // SQLite が主キーのために作る内部索引（`sqlite_autoindex_*`）は数えない。
    const declared = indexes.results
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_autoindex_'));
    expect(declared).toEqual([]);
  });
});

describe('D1 が読めないときに停止と言わない（#140 acceptance 2 の土台）', () => {
  /**
   * `build_health` の読み書きだけを失敗させる env。
   *
   * @returns 壊れた env
   */
  function brokenSignalStore(): Env {
    return {
      ...env,
      DB: {
        prepare(query: string) {
          if (query.includes('build_health')) {
            throw new Error('D1 is down');
          }
          return env.DB.prepare(query);
        },
        // 記録は `batch` を通る（`recordBuildPathFailure`）。**引数は使わない**ので、
        // 未使用であることが読めるように `_` を付ける（`src/generate.ts` の段の実装と
        // 同じ流儀）。**到達しない `return` を置かない**（PR #189 のレビュー指摘）。
        batch(_statements: unknown[]): never {
          throw new Error('D1 is down');
        },
      } as unknown as D1Database,
    } as Env;
  }

  it('読めなければ「止まっていない」を返す（信号が D1 障害の増幅器にならない）', async () => {
    // **`src/quota.ts` の `readForDecision` と逆に倒している。** あちらは費用の出る
    // 判断なので「迷ったら止まる側」だが、ここは止めるかどうかの判断であり、迷った
    // ときに止めるのは安全側ではない。
    await expect(buildPathStopped(brokenSignalStore(), 1_800_000_000)).resolves.toBe(false);
  });

  it('書けなくても投げない（結末の記録を信号のために巻き戻さない）', async () => {
    await expect(
      recordBuildPathFailure(brokenSignalStore(), 'game-z', 1_800_000_000),
    ).resolves.toBeUndefined();
    await expect(clearBuildPathFailures(brokenSignalStore())).resolves.toBeNull();
  });
});

describe('実際の経路で信号が立つ（#140 acceptance 1）', () => {
  it('ビルド依頼が失敗すると、依頼 1 件ぶんの信号が残る', async () => {
    const { gameId, payload } = await seedJob('throttled');

    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      // 確定24 の停止事象そのもの（スロットリング）。
      buildFetch: async () => throttledResponse(),
      sleep: async () => {},
      now: fastClock(),
    });

    // 分類名は `internal` のままである（`src/games.ts` に語彙が無い）。**だからこそ
    // 別の口が要る**（`src/generate.ts` の `GenerationPipeline.failGame`）。
    expect(outcome).toEqual({ status: 'failed', errorCode: 'internal' });

    const rows = await env.DB.prepare('select game_id from build_health').all<{ game_id: string }>();
    expect(rows.results.map((row) => row.game_id)).toEqual([gameId]);
    // 1 件では停止と言わない（確定24）。
    expect(await buildPathStopped(env, Math.floor(Date.now() / 1000))).toBe(false);
  });

  it('別の依頼でもう 1 件失敗すると、停止とみなす', async () => {
    for (const suffix of ['stop-1', 'stop-2']) {
      const { payload } = await seedJob(suffix);
      await handleOrchestratorEvent(payload, lambdaEnv(), {
        fetch: callbackFetch(),
        bedrockFetch: async () => converseResponse(),
        buildFetch: async () => throttledResponse(),
        sleep: async () => {},
        now: fastClock(),
      });
    }
    expect(await signalCount()).toBe(BUILD_STOP_FAILURE_THRESHOLD);
    expect(await buildPathStopped(env, Math.floor(Date.now() / 1000))).toBe(true);
  });

  it('コンパイルが通らなかっただけなら信号は立たない（経路は生きている）', async () => {
    const { payload } = await seedJob('rejected');
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => buildRejectedResponse(),
      sleep: async () => {},
      now: fastClock(),
    });
    expect(outcome).toEqual({ status: 'failed', errorCode: 'build-failed' });
    expect(await signalCount()).toBe(0);
  });
});

describe('D1 の不調では信号が立たない（#140 acceptance 2）', () => {
  it('台帳が書けずに落ちた生成は、停止として数えない', async () => {
    const { gameId, payload } = await seedJob('d1-sick');

    // **D1 の不調を、実際に D1 の側で起こす。** 台帳（`generations` への insert）
    // だけを失敗させると、`recordCost` の段がコールバックの 500 で落ち、
    // `generationErrorCodeOf` は `internal` を返す——**ビルド関数の障害と同じ分類名
    // である。** ここで区別できなければ、#140 が恐れている誤爆がそのまま出る。
    const sickDb = {
      ...env,
      DB: {
        prepare(query: string) {
          if (query.includes('insert into generations')) {
            throw new Error('D1_ERROR: database is locked');
          }
          return env.DB.prepare(query);
        },
        batch: (statements: unknown[]) =>
          (env.DB as unknown as { batch: (s: unknown[]) => unknown }).batch(statements),
      } as unknown as D1Database,
    } as Env;

    // 台帳が届かないので、記録規約が壊れたことは運用へ出る（#160）。
    await expect(
      handleOrchestratorEvent(payload, lambdaEnv(), {
        fetch: callbackFetch(sickDb),
        bedrockFetch: async () => converseResponse(),
        buildFetch: async () => await buildResponse('d1-sick'),
        sleep: async () => {},
        now: fastClock(),
      }),
    ).rejects.toThrow();

    // **行は `internal` で閉じている**（利用者から見て失敗している）。
    const row = await env.DB.prepare(
      'select generation_state, generation_error from games where id = ?',
    )
      .bind(gameId)
      .first<{ generation_state: string; generation_error: string | null }>();
    expect(row).toMatchObject({ generation_state: 'failed', generation_error: 'internal' });

    // **それでも停止の信号は 1 件も立たない。** ここが acceptance 2 である。
    expect(await signalCount()).toBe(0);
    expect(await buildPathStopped(env, Math.floor(Date.now() / 1000))).toBe(false);
  });

  it('コールバックは buildPathFailed を推測で読まない（誤爆を送り込めない）', async () => {
    const { gameId } = await seedJob('coerce');
    const response = await dispatch(
      generateCallbackRoutes,
      new Request(`https://${env.APP_HOST}/api/generate/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gameId,
          jobToken: 'irrelevant',
          kind: 'finish',
          errorCode: 'internal',
          // 真偽値ではない。**真として飲むと、サービス全体の停止を外から作れる。**
          buildPathFailed: 'true',
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid-build-signal' });
    expect(await signalCount()).toBe(0);
  });

  it('成功側に信号が付いていたら断る（成功は停止の証拠になりえない）', async () => {
    const { gameId } = await seedJob('success-signal');
    const response = await dispatch(
      generateCallbackRoutes,
      new Request(`https://${env.APP_HOST}/api/generate/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gameId,
          jobToken: 'irrelevant',
          kind: 'finish',
          artifacts: {
            goVersion: 'go1.26.5',
            sourceKey: 'builds/x/source.go',
            wasmKey: 'builds/x/go1.26.5/game.wasm.br',
            cacheRecord: null,
          },
          buildPathFailed: true,
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid-build-signal' });
  });
});

describe('復帰（ビルド関数を実際に呼んで成功した）', () => {
  it('実ビルドの成功で信号を捨てる', async () => {
    await recordBuildPathFailure(env, 'game-before-1', Math.floor(Date.now() / 1000));
    await recordBuildPathFailure(env, 'game-before-2', Math.floor(Date.now() / 1000));
    expect(await buildPathStopped(env, Math.floor(Date.now() / 1000))).toBe(true);

    const { payload } = await seedJob('recovered');
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('recovered'),
      sleep: async () => {},
      now: fastClock(),
    });
    expect(outcome).toEqual({ status: 'completed' });
    expect(await signalCount()).toBe(0);
  });

  it('キャッシュヒットの成功では捨てない（関数を呼んでいない）', async () => {
    // 索引と成果物を置く。**ヒットの判定には R2 の実在確認が入る**（3.8 / #19）ので、
    // 索引だけでは足りない。
    const sourceSha256 = await sourceCacheKey(GO_SOURCE);
    const sourceKey = 'builds/health-cache/source.go';
    const wasmKey = 'builds/health-cache/go1.26.5/game.wasm.br';
    await env.BUCKET.put(sourceKey, GO_SOURCE);
    await env.BUCKET.put(wasmKey, 'brotli');
    await recordBuildCache(env, {
      sourceSha256,
      goVersion: 'go1.26.5',
      sourceKey,
      wasmKey,
      wasmBytes: 11_404_411,
      wasmSha256: 'a'.repeat(64),
      compressedBytes: 6,
      compressedSha256: 'b'.repeat(64),
      contentEncoding: 'br',
    });

    // そのあとに停止が起きたことにする。
    const at = Math.floor(Date.now() / 1000);
    await recordBuildPathFailure(env, 'game-after-1', at);
    await recordBuildPathFailure(env, 'game-after-2', at);

    // 2 件目は同じソースなのでキャッシュにヒットし、**ビルド関数を呼ばない。**
    const second = await seedJob('cache-hit');
    const outcome = await handleOrchestratorEvent(second.payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => {
        throw new Error('キャッシュヒット時にビルド関数を呼んではならない');
      },
      sleep: async () => {},
      now: fastClock(),
    });
    expect(outcome).toEqual({ status: 'completed' });

    // **D1 と R2 を引いただけで、AWS Lambda が生きている証拠にはならない。**
    expect(await buildPathStopped(env, at)).toBe(true);

    // 索引と成果物は、このテストが置いたものである。**他のテストへ漏らさない。**
    await forgetBuildCache(env, sourceSha256);
    await env.BUCKET.delete([sourceKey, wasmKey]);
  });
});
