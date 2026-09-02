import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import { generateCallbackRoutes } from '../src/generate-callback.js';
import { createPendingGame } from '../src/games.js';
import { MAX_PROMPT_LENGTH } from '../src/generate.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import {
  ORCHESTRATOR_PAYLOAD_VERSION,
  ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE,
  ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY,
  buildOrchestratorPayload,
  parseOrchestratorPayload,
} from '../src/orchestrator/payload.js';
import {
  ASYNC_INVOCATION_TYPE,
  OrchestratorInvokeFailed,
  OrchestratorNotConfigured,
  createLambdaJobStart,
  invokeEndpoint,
  missingOrchestratorSecrets,
} from '../src/orchestrator/start-job.js';
import {
  LedgerNotRecorded,
  OrchestratorEnvIncomplete,
  OrchestratorPayloadRejected,
  OutcomeNotRecorded,
  handleOrchestratorEvent,
  missingOrchestratorEnv,
} from '../src/orchestrator/handler.js';
import { MAX_BUILD_INVOCATIONS_ON_TIMEOUT } from '../src/build-client.js';
import { recordBuildCache, sourceCacheKey } from '../src/build-cache.js';
import { MAX_SOURCE_BYTES, TIDY_MAX_SOURCE_BYTES } from '../src/source-size.js';
import { applySchema } from './helpers/schema.js';

/** 生成の段が返す Go ソース（許可パッケージ検査を通る最小の形）。 */
const GO_SOURCE = 'package main\n\nfunc main() {}\n';

/**
 * オーケストレータへ渡す環境変数。
 *
 * **実在の鍵を使わない**（`test/bedrock.test.ts` と同じ方針）。署名の検査に本物を
 * 使う理由が無く、置いていない環境で落ちる。
 *
 * @param overrides 差し替える値（`null` を渡すとそのキーを消す）
 * @returns 環境変数
 */
function lambdaEnv(overrides: Record<string, string | null> = {}): Record<string, string | undefined> {
  const base: Record<string, string> = {
    CALLBACK_BASE_URL: `https://${env.APP_HOST}`,
    BUILD_FUNCTION_NAME: 'game-forge-build',
    AWS_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'test-access-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    AWS_SESSION_TOKEN: 'test-session-token',
  };
  const values: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete values[key];
    } else {
      values[key] = value;
    }
  }
  return values;
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `orc-user-${suffix}`;
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

/** `Converse` の成功応答（`test/bedrock.test.ts` と同じ形）。 */
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
 * ビルド関数の成功応答（`test/build-client.test.ts` と同じ形）。
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
      timings: { resetMs: 0, prepareMs: 20, buildMs: 18_562, compressMs: 2_373, uploadMs: 310, totalMs: 21_265 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-1' } },
  );
}

/** ビルドが「コンパイルを通らなかった」ときの応答（`ok:false`）。 */
/**
 * 関数側の時間切れ（`Task timed out` 相当）。
 *
 * **`x-amz-function-error` が付く**ので 200 でも失敗として読まれる
 * （`src/build-client.ts`。本文の綴りで時間切れと判定する）。
 */
function functionTimeoutResponse(): Response {
  return new Response(
    JSON.stringify({
      errorMessage: 'ビルドが時間内に終わりませんでした: context deadline exceeded',
      errorType: 'BuildFunctionError',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-amz-function-error': 'Unhandled',
        'x-amzn-requestid': 'req-timeout',
      },
    },
  );
}

function buildRejectedResponse(): Response {
  return new Response(
    JSON.stringify({ ok: false, stage: 'build', message: './main.go:7:2: undefined: ebiten.RunGam' }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-1' } },
  );
}

/** 作品行の状態と成果物。 */
async function rowOf(gameId: string): Promise<{
  state: string;
  error: string | null;
  wasmKey: string | null;
  tokenHash: string | null;
}> {
  const row = await env.DB.prepare(
    'select generation_state, generation_error, wasm_key, job_token_hash from games where id = ?',
  )
    .bind(gameId)
    .first<{
      generation_state: string;
      generation_error: string | null;
      wasm_key: string | null;
      job_token_hash: string | null;
    }>();
  return {
    state: row!.generation_state,
    error: row!.generation_error,
    wasmKey: row!.wasm_key,
    tokenHash: row!.job_token_hash,
  };
}

/** 台帳の行数。**確定25 は日次枠をこの行数で数える。** */
async function ledgerCount(userId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from generations where user_id = ?')
    .bind(userId)
    .first<{ n: number }>();
  return row!.n;
}

/**
 * コールバックを Worker の経路へ流す `fetch`。
 *
 * **実際の `/api/generate/callback` を通す**（`test/generate-callback.test.ts` と同じ
 * `dispatch`）。ここをモックにすると、検証したい「D1 の条件付き UPDATE が重複配信を
 * 止める」が空になる。
 */
function callbackFetch(): (request: Request) => Promise<Response> {
  return async (request: Request) => await dispatch(generateCallbackRoutes, request, env);
}

/** 呼び出し回数を数える `fetch`。 */
function counting(handler: () => Promise<Response> | Response): {
  calls: () => number;
  fetch: (request: Request) => Promise<Response>;
} {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      return await handler();
    },
  };
}

beforeAll(async () => {
  await applySchema();
});

describe('ペイロードの契約（#160）', () => {
  it('往復できる', () => {
    const payload = buildOrchestratorPayload(
      { gameId: 'g-1', jobToken: 't-1', request: { prompt: 'ゲーム' } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    expect(payload.version).toBe(ORCHESTRATOR_PAYLOAD_VERSION);
    expect(parseOrchestratorPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it('userId を運ばない（作者は games 行が知っている）', () => {
    const payload = buildOrchestratorPayload(
      { gameId: 'g-1', jobToken: 't-1', request: { prompt: 'ゲーム' } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    // **トークンを持つ者が本文で他人を名指しできる形を作らない**（`payload.ts`）。
    expect(Object.keys(payload).sort()).toEqual([
      'gameId',
      'jobToken',
      'modelKey',
      'prompt',
      'version',
    ]);
  });

  it('知らない版・知らない項目・知らないモデルは断る', () => {
    const base = {
      version: ORCHESTRATOR_PAYLOAD_VERSION,
      gameId: 'g',
      jobToken: 't',
      prompt: 'p',
      modelKey: DEFAULT_GENERATION_MODEL_KEY,
    };
    expect(parseOrchestratorPayload({ ...base, version: 999 })).toBeNull();
    expect(parseOrchestratorPayload({ ...base, extra: 1 })).toBeNull();
    expect(parseOrchestratorPayload({ ...base, modelKey: 'gpt-9' })).toBeNull();
    expect(parseOrchestratorPayload({ ...base, prompt: '' })).toBeNull();
    expect(parseOrchestratorPayload({ ...base, prompt: 'あ'.repeat(MAX_PROMPT_LENGTH + 1) })).toBeNull();
    expect(parseOrchestratorPayload(null)).toBeNull();
    expect(parseOrchestratorPayload([base])).toBeNull();
  });
});

/** 上限内の元ソース（版 2 の帯）。 */
const IN_LIMIT_SOURCE = 'x'.repeat(MAX_SOURCE_BYTES);

/** 上限を 1 バイト超えた元ソース（整理パス＝版 3 の帯）。 */
const OVER_LIMIT_SOURCE = 'x'.repeat(MAX_SOURCE_BYTES + 1);

describe('整理パスの版（確定18 の条件 2〜4 / M5-2 / #33）', () => {
  /**
   * 版と `baseSource` を指定して本文を組み立てる。
   *
   * @param version 名乗る版
   * @param baseSource 載せる元ソース
   * @returns 受け側へ渡す本文
   */
  function payloadOf(version: number, baseSource: string): Record<string, unknown> {
    return {
      version,
      gameId: 'g',
      jobToken: 't',
      prompt: 'p',
      modelKey: DEFAULT_GENERATION_MODEL_KEY,
      baseSource,
    };
  }

  it('版 2 の受け入れ条件は 1 つも変わっていない', () => {
    // **配備順の事故を防ぐ要である**（`docs/handoff.md` 1 章。2026-09-01 に本番の生成が
    // 12 分止まった）。版 3 を足したことで版 2 の判定が動くと、**整理と関係の無い
    // 推敲とフォークが全部落ちる。**
    expect(parseOrchestratorPayload(payloadOf(2, IN_LIMIT_SOURCE))).not.toBeNull();
    expect(parseOrchestratorPayload(payloadOf(2, OVER_LIMIT_SOURCE))).toBeNull();
  });

  it('版 3 だけが上限超の元ソースを載せられる', () => {
    // **上限を無条件に緩めない。** 緩めると 5.3 の上限そのものが消える。
    expect(parseOrchestratorPayload(payloadOf(3, OVER_LIMIT_SOURCE))).not.toBeNull();
  });

  it('版 3 でも整理の上限（30KB の 2 倍）は超えられない', () => {
    expect(
      parseOrchestratorPayload(payloadOf(3, 'x'.repeat(TIDY_MAX_SOURCE_BYTES))),
    ).not.toBeNull();
    expect(
      parseOrchestratorPayload(payloadOf(3, 'x'.repeat(TIDY_MAX_SOURCE_BYTES + 1))),
    ).toBeNull();
  });

  it('版 3 を名乗って上限内のソースを載せた本文は断る', () => {
    // **版 2 の規則と同じ**（「版 2 を名乗って `baseSource` が無い本文は断る」）。
    // 版が能力の宣言である以上、**名乗りと中身が食い違う本文を解釈しない。**
    // `buildOrchestratorPayload` は整理パスのときしか版 3 を作らないので、そうでない
    // 版 3 が届いたら送り側の不具合である。
    expect(parseOrchestratorPayload(payloadOf(3, IN_LIMIT_SOURCE))).toBeNull();
    expect(parseOrchestratorPayload(payloadOf(3, 'x'.repeat(100)))).toBeNull();
  });

  it('版 1 は元ソースを載せられないままである', () => {
    expect(parseOrchestratorPayload(payloadOf(1, IN_LIMIT_SOURCE))).toBeNull();
  });

  it('送る側は、整理パスのときだけ版 3 を名乗る', () => {
    const plain = buildOrchestratorPayload(
      { gameId: 'g', jobToken: 't', request: { prompt: 'p', baseSource: IN_LIMIT_SOURCE } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    const tidy = buildOrchestratorPayload(
      { gameId: 'g', jobToken: 't', request: { prompt: 'p', baseSource: OVER_LIMIT_SOURCE } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    expect(plain.version).toBe(ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE);
    expect(tidy.version).toBe(ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY);
  });

  it('組み立てた版 3 の本文は、そのまま受け側を通る（往復）', () => {
    // **送る側と受ける側が別々に「整理かどうか」を決めていないこと。** 片方だけが
    // そう思っている本文が作れると、上限超のソースが版 2 として送られて必ず落ちる。
    const payload = buildOrchestratorPayload(
      { gameId: 'g', jobToken: 't', request: { prompt: 'p', baseSource: OVER_LIMIT_SOURCE } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    expect(parseOrchestratorPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it('版 3 は項目を増やしていない（tidy の印を本文へ足さない）', () => {
    // 整理かどうかは**元ソースの大きさ**が決める（`src/source-size.ts` の `isTidyPass`）。
    // 印を別項目で運ぶと、`src/orchestrator/handler.ts` が組み直す `GenerationJob` を
    // 通らず、**エッジでは効いてオーケストレータでは黙って消える。**
    const payload = buildOrchestratorPayload(
      { gameId: 'g', jobToken: 't', request: { prompt: 'p', baseSource: OVER_LIMIT_SOURCE } },
      DEFAULT_GENERATION_MODEL_KEY,
    );
    expect(Object.keys(payload).sort()).toEqual([
      'baseSource',
      'gameId',
      'jobToken',
      'modelKey',
      'prompt',
      'version',
    ]);
  });
});

describe('エッジ側の起動（startJob。#160 / 3.3-2.6）', () => {
  const job = { gameId: 'g-1', jobToken: 't-1', userId: 'u-1', request: { prompt: 'ゲーム' } };

  /**
   * 呼び出し用の env（`BUILD_AWS_*` を使う。鍵を増やさない）。
   *
   * @param overrides 差し替える値
   * @returns env
   */
  function edgeEnv(overrides: Record<string, string | null> = {}): Env {
    const copy = { ...env } as unknown as Record<string, unknown>;
    const base: Record<string, string> = {
      BUILD_AWS_REGION: 'ap-northeast-1',
      BUILD_AWS_ACCESS_KEY_ID: 'test-access-key-id',
      BUILD_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      BUILD_AWS_SESSION_TOKEN: '',
      GENERATION_MODEL: DEFAULT_GENERATION_MODEL_KEY,
    };
    for (const [key, value] of Object.entries({ ...base, ...overrides })) {
      if (value === null) {
        delete copy[key];
      } else {
        copy[key] = value;
      }
    }
    return copy as unknown as Env;
  }

  it('非同期呼び出しである（x-amz-invocation-type: Event）', async () => {
    let seen: Request | null = null;
    const start = createLambdaJobStart({
      fetch: async (request) => {
        seen = request;
        return new Response(null, { status: 202 });
      },
    });

    await start(edgeEnv(), job, {} as never);

    const sent = seen as unknown as Request;
    // **ここが `RequestResponse` に戻ると、91 秒の待ちが Worker へ帰ってくる。**
    expect(sent.headers.get('x-amz-invocation-type')).toBe(ASYNC_INVOCATION_TYPE);
    expect(ASYNC_INVOCATION_TYPE).toBe('Event');
    expect(sent.url).toBe(
      invokeEndpoint('ap-northeast-1', env.ORCHESTRATOR_FUNCTION_NAME),
    );
    // 署名されていること（値は見ない）。
    expect(sent.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(JSON.parse(await sent.text())).toEqual({
      version: ORCHESTRATOR_PAYLOAD_VERSION,
      gameId: 'g-1',
      jobToken: 't-1',
      prompt: 'ゲーム',
      modelKey: DEFAULT_GENERATION_MODEL_KEY,
    });
  });

  it('202 以外は投げ込めなかったものとして扱う（200 も含む）', async () => {
    for (const status of [200, 400, 429, 500]) {
      const start = createLambdaJobStart({
        fetch: async () => new Response('{}', { status }),
      });
      await expect(start(edgeEnv(), job, {} as never)).rejects.toBeInstanceOf(
        OrchestratorInvokeFailed,
      );
    }
  });

  it('送信そのものが失敗しても、ペイロードを例外へ載せない', async () => {
    const start = createLambdaJobStart({
      fetch: async () => {
        throw new TypeError('network down');
      },
    });
    const error = await start(edgeEnv(), job, {} as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorInvokeFailed);
    expect(String(error)).not.toContain('t-1');
  });

  it('設定が足りなければ、名前だけを挙げて呼ぶ前に落ちる', async () => {
    const start = createLambdaJobStart({
      fetch: async () => {
        throw new Error('呼んではいけない');
      },
    });
    await expect(
      start(edgeEnv({ BUILD_AWS_SECRET_ACCESS_KEY: null }), job, {} as never),
    ).rejects.toBeInstanceOf(OrchestratorNotConfigured);
    expect(missingOrchestratorSecrets(edgeEnv({ BUILD_AWS_SECRET_ACCESS_KEY: '  ' }))).toEqual([
      'BUILD_AWS_SECRET_ACCESS_KEY',
    ]);
    expect(missingOrchestratorSecrets(edgeEnv())).toEqual([]);
  });

  it('鍵を増やしていない（BUILD_AWS_* をそのまま使う）', () => {
    // #160 の積極的な理由は「エッジから長命の資格情報が 1 組減る」ことである。
    // 3 組目を足すとその理由が消える（`src/orchestrator/start-job.ts`）。
    expect(missingOrchestratorSecrets(edgeEnv({ BEDROCK_AWS_ACCESS_KEY_ID: null }))).toEqual([]);
  });
});

describe('環境変数の検査（実行ロールで動いていること）', () => {
  it('足りない名前だけを挙げる', () => {
    expect(missingOrchestratorEnv(lambdaEnv())).toEqual([]);
    expect(missingOrchestratorEnv(lambdaEnv({ CALLBACK_BASE_URL: null }))).toEqual([
      'CALLBACK_BASE_URL',
    ]);
  });

  it('AWS_SESSION_TOKEN が無い状態を合格にしない', () => {
    // 無い＝ロールではなく長命キーで動いている状態で、**9.2 が消したかった構図
    // そのもの**である（`src/orchestrator/handler.ts`）。
    expect(missingOrchestratorEnv(lambdaEnv({ AWS_SESSION_TOKEN: '' }))).toEqual([
      'AWS_SESSION_TOKEN',
    ]);
  });
});

describe('重複配信でも LLM は 1 回（#160 acceptance 2）', () => {
  it('同じイベントを 2 回処理しても Bedrock を 1 回しか呼ばない', async () => {
    const { userId, gameId, payload } = await seedJob('dup');
    const bedrock = counting(() => converseResponse());
    const build = counting(async () => await buildResponse('dup'));
    const deps = {
      fetch: callbackFetch(),
      bedrockFetch: bedrock.fetch,
      buildFetch: build.fetch,
      sleep: async () => {},
    };

    const first = await handleOrchestratorEvent(payload, lambdaEnv(), deps);
    expect(first).toEqual({ status: 'completed' });
    expect(await rowOf(gameId)).toMatchObject({ state: 'ready', error: null });

    // **2 通目。** AWS は「関数がエラーを返さなくても同じイベントを複数回受け取り
    // うる」と明記しており、設定では防げない。**止めるのは D1 の条件付き UPDATE
    // だけである。**
    const second = await handleOrchestratorEvent(payload, lambdaEnv(), deps);
    expect(second).toEqual({ status: 'claimed-elsewhere' });

    expect(bedrock.calls()).toBe(1);
    expect(build.calls()).toBe(1);
    // **台帳も 1 行のまま**（確定25 は日次枠をこの行数で数える）。
    expect(await ledgerCount(userId)).toBe(1);
  });

  it('完了した行のトークンは捨てられている（遅れた再送が届かない）', async () => {
    const { gameId, payload } = await seedJob('token-burn');
    await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('token-burn'),
      sleep: async () => {},
    });
    expect((await rowOf(gameId)).tokenHash).toBeNull();
  });
});

describe('失敗の記録と、運用へ出すもの（#160）', () => {
  it('ビルドが通らなければ build-failed で行を閉じ、例外は投げない', async () => {
    const { userId, gameId, payload } = await seedJob('build-fail');
    const bedrock = counting(() => converseResponse());

    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: bedrock.fetch,
      buildFetch: async () => buildRejectedResponse(),
      sleep: async () => {},
    });

    // **投げない。** 利用者は作品ページで結果を見ており、DLQ へ出す理由が無い。
    expect(outcome).toEqual({ status: 'failed', errorCode: 'build-failed' });
    expect(await rowOf(gameId)).toMatchObject({ state: 'failed', error: 'build-failed' });
    // 5.2-7 の最大 3 試行。**基盤のリトライと掛け算にしない**理由がこれである
    // （`terraform/orchestrator.tf` の MaximumRetryAttempts=0）。
    expect(bedrock.calls()).toBe(3);
    expect(await ledgerCount(userId)).toBe(3);
  });

  it('時間切れの呼び直しは 1 依頼につき 1 回で打ち止め（#174）', async () => {
    const { gameId, payload } = await seedJob('build-timeout');

    // **依頼をまたいで枠が残っているかを見る。**
    //   1 回目: 時間切れ → 呼び直し（枠を使う） → コンパイル失敗（#20 が次の試行へ）
    //   2 回目: 時間切れ → **枠が無いので呼び直さない**
    // 枠がビルドごとなら、ここで 4 回目が飛ぶ。
    let calls = 0;
    const buildFetch = async (): Promise<Response> => {
      calls += 1;
      return calls === 2 ? buildRejectedResponse() : functionTimeoutResponse();
    };
    const bedrock = counting(() => converseResponse());

    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: bedrock.fetch,
      buildFetch,
      sleep: async () => {},
    });

    // 時間切れは #20 の再試行に回らない（診断が無い）ので、2 試行目で降りる。
    expect(outcome).toEqual({ status: 'failed', errorCode: 'build-timeout' });
    expect(await rowOf(gameId)).toMatchObject({ state: 'failed', error: 'build-timeout' });
    expect(bedrock.calls()).toBe(2);
    // **1 依頼あたりの呼び直しは MAX_BUILD_INVOCATIONS_ON_TIMEOUT − 1 回**
    // （`src/build-client.ts` の BuildTimeoutBudget）。ビルドごとに枠を作ると、
    // 1 依頼で最大 18 回まで伸びうる——`terraform/orchestrator.tf` の実行時間の
    // 見積もりはその形では成り立たない。
    expect(calls).toBe(2 + (MAX_BUILD_INVOCATIONS_ON_TIMEOUT - 1));
  });

  it('台帳が届かなければ、行を閉じたうえで運用へ投げる', async () => {
    const { userId, gameId, payload } = await seedJob('ledger-lost');
    const real = callbackFetch();
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: async (request) => {
        const body = (await request.clone().json()) as { kind: string };
        // `ledger` だけを永久に落とす。**課金は出ているのに日次枠が減らない**状態。
        if (body.kind === 'ledger') {
          return new Response('{}', { status: 503 });
        }
        return await real(request);
      },
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('ledger-lost'),
      sleep: async () => {},
      now: (() => {
        // 予算（既定 120 秒）を 2 回目の判定で使い切らせる。
        let calls = 0;
        return () => {
          calls += 1;
          return calls * 1_000_000;
        };
      })(),
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(LedgerNotRecorded);
    // **先に行を閉じてから投げる。** 逆順だと DLQ には出るが画面は回り続ける。
    expect(await rowOf(gameId)).toMatchObject({ state: 'failed', error: 'internal' });
    expect(await ledgerCount(userId)).toBe(0);
  });

  it('結末が届かなければ、運用へ投げる（行が running のまま残る）', async () => {
    const { gameId, payload } = await seedJob('finish-lost');
    const real = callbackFetch();
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: async (request) => {
        const body = (await request.clone().json()) as { kind: string };
        if (body.kind === 'finish') {
          return new Response('{}', { status: 503 });
        }
        return await real(request);
      },
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('finish-lost'),
      sleep: async () => {},
      now: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls * 1_000_000;
        };
      })(),
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(OutcomeNotRecorded);
    expect(await rowOf(gameId)).toMatchObject({ state: 'running' });
  });

  it('台帳は届くまで再送し、届けば行は 1 行のまま', async () => {
    const { userId, gameId, payload } = await seedJob('ledger-retry');
    const real = callbackFetch();
    let ledgerAttempts = 0;
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: async (request) => {
        const body = (await request.clone().json()) as { kind: string };
        if (body.kind === 'ledger') {
          ledgerAttempts += 1;
          if (ledgerAttempts < 3) {
            return new Response('{}', { status: 503 });
          }
        }
        return await real(request);
      },
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('ledger-retry'),
      sleep: async () => {},
    });

    expect(outcome).toEqual({ status: 'completed' });
    expect(ledgerAttempts).toBe(3);
    // **再送は LLM を呼ばないので費用ゼロ**、そして行は 1 行である（採番した id が鍵）。
    expect(await ledgerCount(userId)).toBe(1);
    expect(await rowOf(gameId)).toMatchObject({ state: 'ready' });
  });

  it('4xx は再送しない（同じ本文を送り直しても変わらない）', async () => {
    const { gameId, payload } = await seedJob('no-retry-4xx');
    let attempts = 0;
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: async () => {
        attempts += 1;
        return new Response('{"error":"unknown-field"}', { status: 400 });
      },
      bedrockFetch: async () => converseResponse(),
      buildFetch: async () => await buildResponse('no-retry-4xx'),
      sleep: async () => {},
    }).catch((error: unknown) => error);

    // 最初の動作は `claim` で、そこで落ちる。**Bedrock は呼ばない。**
    expect(outcome).toBeInstanceOf(OutcomeNotRecorded);
    expect(attempts).toBe(1);
    // **`claim` が届かなかったので、行は `pending` のままである。** 同じ例外が
    // `finish` 不達（`running` のまま）でも投げられるので、**メッセージで状態を
    // 断定してはいけない**（DLQ を見た人が最初に見る場所を間違える。#163）。
    expect(await rowOf(gameId)).toMatchObject({ state: 'pending' });
    expect(String(outcome)).not.toContain('running');
  });
});

describe('契約違反は早く見える（#160）', () => {
  it('壊れたペイロードは呼ぶ前に落ちる', async () => {
    await expect(handleOrchestratorEvent({ nope: 1 }, lambdaEnv())).rejects.toBeInstanceOf(
      OrchestratorPayloadRejected,
    );
  });

  it('宛先が読めれば、断るときも行を閉じる（#242）', async () => {
    // **2026-09-01 に本番で起きた形をそのまま置く。** 登録簿のずれで modelKey が
    // 未知になり（#241）、ペイロードが契約に合わなくなった。**当時はコールバックを
    // 1 通も送らず、作品行は pending のまま 15 分残った。**
    const { gameId, payload } = await seedJob('reject-close');
    const broken = { ...payload, modelKey: 'sonnet-4-6-does-not-exist' };

    await expect(
      handleOrchestratorEvent(broken, lambdaEnv(), { fetch: callbackFetch() }),
    ).rejects.toBeInstanceOf(OrchestratorPayloadRejected);

    // **握ってから閉じている**（finish は running の行にしか効かない）。
    expect(await rowOf(gameId)).toMatchObject({ state: 'failed', error: 'internal' });
    // **トークンは捨てられている**（遅れた再送が届かない）。
    expect((await rowOf(gameId)).tokenHash).toBeNull();
  });

  it('宛先が読めなければ、何も送らずに落ちる（#242）', async () => {
    // gameId も jobToken も無い本文。**送り先が無いので、送らない。**
    const callback = counting(() => new Response('{}', { status: 200 }));
    await expect(
      handleOrchestratorEvent({ nope: 1 }, lambdaEnv(), { fetch: callback.fetch }),
    ).rejects.toBeInstanceOf(OrchestratorPayloadRejected);
    expect(callback.calls()).toBe(0);
  });

  it('握れなければ閉じない。それでも契約違反の報告は消えない（#242）', async () => {
    // **別の呼び出しが既に進めている行を、こちらが閉じてはいけない。**
    // `claim` が false を返したら、何も書かずに降りる。
    const { gameId, payload } = await seedJob('reject-unclaimable');
    const broken = { ...payload, modelKey: 'sonnet-4-6-does-not-exist' };
    const callback = counting(() => Response.json({ claimed: false }));

    await expect(
      handleOrchestratorEvent(broken, lambdaEnv(), { fetch: callback.fetch }),
    ).rejects.toBeInstanceOf(OrchestratorPayloadRejected);

    // **claim を 1 回試しただけで、finish は送っていない。**
    expect(callback.calls()).toBe(1);
    // **行は触られていない。**
    expect(await rowOf(gameId)).toMatchObject({ state: 'pending', error: null });
  });

  it('環境変数が足りなければ、名前だけを挙げて落ちる', async () => {
    const { payload } = await seedJob('env-missing');
    const error = await handleOrchestratorEvent(
      payload,
      lambdaEnv({ CALLBACK_BASE_URL: null }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorEnvIncomplete);
    expect(String(error)).toContain('CALLBACK_BASE_URL');
    // **値は出さない。** 資格情報が混ざる位置なので、方針を崩さない。
    expect(String(error)).not.toContain('test-secret-access-key');
  });
});

// **このファイルの最後に置く。** 索引と成果物を置く検査なので、前に置くと以降の
// テストが同じ生成ソースでキャッシュヒットし、ビルド段が呼ばれなくなる（実測で踏んだ）。
describe('3.8 のビルド結果キャッシュ（#160）', () => {
  it('ヒットすればビルド関数を呼ばない', async () => {
    const { gameId, payload } = await seedJob('cache-hit');
    // 索引と成果物を先に置く。**cache-lookup は R2 の実在まで確かめる**ので、
    // 索引だけを置いてもヒットにならない（src/build-cache.ts）。
    const sourceSha256 = await sourceCacheKey(GO_SOURCE);
    const sourceKey = `builds/${sourceSha256}/source.go`;
    const wasmKey = `builds/${sourceSha256}/go1.26.5/game.wasm.br`;
    await env.BUCKET.put(sourceKey, GO_SOURCE);
    await env.BUCKET.put(wasmKey, 'br');
    await recordBuildCache(env, {
      sourceSha256,
      goVersion: 'go1.26.5',
      sourceKey,
      wasmKey,
      wasmBytes: 11_404_411,
      wasmSha256: 'a'.repeat(64),
      compressedBytes: 2,
      compressedSha256: 'b'.repeat(64),
      contentEncoding: 'br',
    });

    const build = counting(async () => await buildResponse('cache-hit'));
    const outcome = await handleOrchestratorEvent(payload, lambdaEnv(), {
      fetch: callbackFetch(),
      bedrockFetch: async () => converseResponse(),
      buildFetch: build.fetch,
      sleep: async () => {},
    });

    expect(outcome).toEqual({ status: 'completed' });
    // **約 16 円と 21.6 秒を払わずに済む経路である。**
    expect(build.calls()).toBe(0);
    expect(await rowOf(gameId)).toMatchObject({ state: 'ready', wasmKey });
  });
});
