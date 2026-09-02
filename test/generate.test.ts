import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GENERATE_PATH,
  MAX_PROMPT_LENGTH,
  PipelineStepNotImplemented,
  QuotaExceeded,
  createGenerateRoutes,
  defaultPipeline,
  GenerationNotCompletable,
  notImplementedPipeline,
  runJobInline,
  startGeneration,
  withTidyInstruction,
} from '../src/generate.js';
import { startJobOnLambda } from '../src/orchestrator/start-job.js';
import { failGame } from '../src/games.js';
import type { GenerationPipeline } from '../src/generate.js';
import { workPagePath } from '../src/work-page.js';
import type { GenerationResult } from '../src/generation-models.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import { BedrockNotConfigured } from '../src/bedrock.js';
import {
  BuildFunctionFailed,
  BuildNotConfigured,
  BuildRejected,
  BuildTimedOut,
} from '../src/build-client.js';
import type { BuildFailure } from '../src/build-client.js';
import { BuildRetriesExhausted, MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import type { BuildRetryContext } from '../src/build-retry.js';
import { recordGenerationCost } from '../src/cost-ledger.js';
import {
  DAILY_QUOTA_PER_USER,
  DAILY_QUOTA_REASON,
  MONTHLY_LIMIT_REASON,
  UNCLASSIFIED_QUOTA_CODE,
  jstDayRange,
} from '../src/quota.js';
import { buildSystemPrompt } from '../src/system-prompt.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession } from '../src/session.js';
import { GeneratedSourceRejected } from '../src/source-inspection.js';
import { MAX_SOURCE_BYTES, TIDY_ATTEMPTS } from '../src/source-size.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * 仕様書 5.2-7 が宣言するリトライの上限（**再試行の回数**）を拾う形。
 *
 * 本文と、#20 の注記の両方に現れる。`test/quota.test.ts` の照合と同じで、
 * 「更新したか」ではなく「一致しているか」を見る。
 */
const RETRY_LIMIT_PATTERN = /自動リトライ（最大\s*([0-9]+)\s*回）/gu;
const SECRET = 'test-secret-value-for-generate-endpoint-1';

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
 * @param options BAN 状態
 * @returns 利用者の id
 */
async function seedUser(suffix: string, options: { banned?: boolean } = {}): Promise<string> {
  const id = `gen-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at, banned_at) values (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix, options.banned === true ? 1 : null)
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
  // 失効時刻は**実時刻から取る**。`resolveSessionUser` は `verifySession` を既定の
  // 現在時刻で呼ぶため、固定値にすると「その時刻を過ぎた日からテストが壊れる」
  // 時限式になる（レビューで指摘された。固定値は将来の日付だったので今は通っていた）。
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 生成リクエストを送る。
 *
 * @param routes 経路表
 * @param body 本文（文字列ならそのまま送る）
 * @param cookie `Cookie` ヘッダ（省略すると未認証）
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function post(
  routes: readonly Route[],
  body: unknown,
  cookie?: string,
  contentType = 'application/json',
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${GENERATE_PATH}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    testEnv(),
  );
}

/** 呼ばれた段を順に記録するパイプライン。 */
function recordingPipeline(): { calls: string[]; pipeline: GenerationPipeline } {
  const calls: string[] = [];
  return {
    calls,
    pipeline: {
      checkQuota: async () => {
        calls.push('checkQuota');
        return { allowed: true };
      },
      generateSource: async () => {
        calls.push('generateSource');
        // **どのモデルで生成したかは型が必須にしている**（#83）。骨組みのテストでも
        // 省けないので、登録簿の既定モデルをそのまま使う。
        return {
          modelKey: DEFAULT_GENERATION_MODEL_KEY,
          modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
          source: 'package main',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: null,
            cacheWriteInputTokens: null,
          },
          stopReason: 'end_turn',
        };
      },
      recordCost: async () => {
        calls.push('recordCost');
      },
      inspectSource: () => {
        calls.push('inspectSource');
      },
      build: async () => {
        calls.push('build');
        return fakeBuildOutcome();
      },
      completeGame: async () => {
        calls.push('completeGame');
        return true;
      },
      // **`startJob` は同期実行に固定する**（#150）。この一群のテストが見ているのは
      // 3.3 の**順序**であって、ジョブをどこで走らせるかではない。既定
      // （`defaultPipeline`）と同じ実装を借りるので、写しにもならない。
      startJob: runJobInline,
    },
  };
}

/**
 * この一群のテストが `startGeneration` へ渡す利用者を、実在する行として用意する。
 *
 * **#150 で必要になった。** 生成の経路はクォータ判定の直後に `games` 行を作るように
 * なり（3.3-2.5）、`games.author_id` は `users(id)` への外部キーである。以前は
 * 作品行がパイプラインの最後でしか作られず、しかもその段はテスト側の差し替えで
 * 潰していたため、利用者が実在しなくても通っていた。
 *
 * **`insert or ignore` にしてある。** 同じ id を複数のテストが使うので、2 回目以降は
 * 何もしない。
 *
 * @param ids 用意する利用者の id
 */
async function seedPipelineUsers(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await env.DB.prepare(
      `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
       values (?, ?, ?, ?, 1, null)`,
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, id)
      .run();
  }
}

beforeAll(async () => {
  await applySchema();
  await seedPipelineUsers([
    'user-1',
    'user-retry-1',
    'user-retry-2',
    'user-retry-3',
    'user-retry-4',
    'user-retry-5',
    'user-tidy-1',
    'user-tidy-2',
    'user-tidy-3',
  ]);
});

describe('未認証リクエストを拒否する（#15 acceptance 1）', () => {
  const routes = createGenerateRoutes();

  it('cookie が無ければ 401', async () => {
    const response = await post(routes, { prompt: 'シューティングゲーム' });
    expect(response.status).toBe(401);
  });

  it('署名が通らない cookie は 401', async () => {
    const response = await post(
      routes,
      { prompt: 'シューティングゲーム' },
      `${SESSION_COOKIE}=forged.token`,
    );
    expect(response.status).toBe(401);
  });

  it('別の鍵で署名した cookie は 401', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { userId: 'someone', issuedAt, expiresAt: issuedAt + 3600 },
      'another-secret-value-of-sufficient-length',
    );
    const response = await post(
      routes,
      { prompt: 'シューティングゲーム' },
      `${SESSION_COOKIE}=${token}`,
    );
    expect(response.status).toBe(401);
  });

  it('存在しない利用者を指すセッションは 401', async () => {
    // 招待の消費に失敗して取り消された行（T7 の補償）のセッションがこれにあたる。
    const response = await post(
      routes,
      { prompt: 'シューティングゲーム' },
      await sessionCookie('gen-user-missing'),
    );
    expect(response.status).toBe(401);
  });

  it('BAN された利用者は 401', async () => {
    // セッションの寿命は 7 日で失効させる手段が無いため、署名だけを信じると
    // BAN（7.3）が最大 7 日効かない。
    const userId = await seedUser('banned', { banned: true });
    const response = await post(routes, { prompt: 'シューティングゲーム' }, await sessionCookie(userId));
    expect(response.status).toBe(401);
  });

  it('未認証なら本文の検証まで進まない', async () => {
    // 認証を先に見ることが 7.3 の入口の絞りになっている。壊れた本文でも 400 ではなく
    // 401 を返すことで、順序が保たれていることを固定する。
    const response = await post(routes, 'not json at all');
    expect(response.status).toBe(401);
  });
});

describe('スキーマ違反を拒否する（#15 acceptance 2）', () => {
  const routes = createGenerateRoutes();
  let cookie: string;

  beforeAll(async () => {
    cookie = await sessionCookie(await seedUser('schema'));
  });

  it('Content-Type が JSON でなければ 400', async () => {
    const response = await post(
      routes,
      'prompt=x',
      cookie,
      'application/x-www-form-urlencoded',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported-content-type' });
  });

  it('壊れた JSON は 400', async () => {
    const response = await post(routes, '{"prompt":', cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'malformed-json' });
  });

  it('オブジェクトでない JSON は 400', async () => {
    for (const body of ['"文字列"', '[]', 'null', '42']) {
      const response = await post(routes, body, cookie);
      expect(response.status, body).toBe(400);
    }
  });

  it('prompt が無い / 空 / 文字列でない場合は 400', async () => {
    for (const body of [{}, { prompt: '' }, { prompt: '   ' }, { prompt: 123 }, { prompt: null }]) {
      const response = await post(routes, body, cookie);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: 'missing-prompt' });
    }
  });

  it('未知の項目があれば 400', async () => {
    // prompt の綴り違いが「空のプロンプトで生成した」形で通るのを防ぐ。生成は
    // 課金を伴うので、曖昧な入力を推測で受け取らない。
    const response = await post(routes, { prompt: 'ゲーム', promt: 'typo' }, cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown-field' });
  });

  it('プロンプトが長すぎれば 400', async () => {
    const response = await post(routes, { prompt: 'あ'.repeat(MAX_PROMPT_LENGTH + 1) }, cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'prompt-too-long' });
  });

  it('上限ちょうどは受け付ける', async () => {
    // 上限で弾き始めると、境界の 1 文字が理由不明の失敗になる。
    const response = await post(routes, { prompt: 'あ'.repeat(MAX_PROMPT_LENGTH) }, cookie);
    expect(response.status).not.toBe(400);
  });

  it('文字数で数える（バイト数ではない）', async () => {
    // バイト数で数えると、同じ内容でも日本語のプロンプトだけが短く切られる。
    const japanese = 'あ'.repeat(MAX_PROMPT_LENGTH);
    expect(new TextEncoder().encode(japanese).byteLength).toBeGreaterThan(MAX_PROMPT_LENGTH);
    const response = await post(routes, { prompt: japanese }, cookie);
    expect(response.status).not.toBe(400);
  });

  it('本文が大きすぎれば 400', async () => {
    const response = await post(routes, { prompt: 'あ'.repeat(100_000) }, cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'body-too-large' });
  });
});

describe('オーケストレーションの骨組み（3.3 の順序）', () => {
  it('3.3 の順序どおりに段を呼ぶ', async () => {
    // 順序を先に固定しておく。後から段を実装するときに順序を議論し直さないため。
    const { calls, pipeline } = recordingPipeline();
    const result = await startGeneration(
      testEnv(),
      'user-1',
      { prompt: 'ゲーム' },
      pipeline,
    );
    expect(calls).toEqual([
      'checkQuota',
      'generateSource',
      'recordCost',
      'inspectSource',
      'build',
      'completeGame',
    ]);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it('費用の計上が検査とビルドより前にある', async () => {
    // 生成が返った時点で課金は済んでいる。計上をビルドの後ろへ動かすと、検査や
    // ビルドで落ちた分が台帳から漏れ、4.3 の「リトライ分も必ず計上する」が崩れる。
    const { calls, pipeline } = recordingPipeline();
    await startGeneration(testEnv(), 'user-1', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );
    expect(calls.indexOf('recordCost')).toBeLessThan(calls.indexOf('inspectSource'));
    expect(calls.indexOf('recordCost')).toBeLessThan(calls.indexOf('build'));
  });

  it('クォータ超過なら生成へ進まない', async () => {
    const { calls, pipeline } = recordingPipeline();
    const denied: GenerationPipeline = {
      ...pipeline,
      checkQuota: async () => {
        calls.push('checkQuota');
        return { allowed: false, reason: 'daily' };
      },
    };
    await expect(
      startGeneration(testEnv(), 'user-1', { prompt: 'ゲーム' }, denied),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(calls).toEqual(['checkQuota']);
  });

  it('クォータ超過は 429 で返す', async () => {
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes({
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: MONTHLY_LIMIT_REASON }),
    });
    const cookie = await sessionCookie(await seedUser('quota'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);
    expect(response.status).toBe(429);
  });

  it('429 は日次と月次を区別して返す（4.4 / #132）', async () => {
    // 4.4 は 2 つを**別のメッセージ**として求める（日次は翌日の再開時刻、月次は
    // プレイと共有の継続）。**応答が区別を持たないと、画面はどちらかを必ず誤る。**
    const { pipeline } = recordingPipeline();
    const cookie = await sessionCookie(await seedUser('quota-scope'));
    const resetsAt = jstDayRange(Math.floor(Date.now() / 1000)).toSeconds;

    const dailyRoutes = createGenerateRoutes({
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: DAILY_QUOTA_REASON, resetsAt }),
    });
    const daily = await post(dailyRoutes, { prompt: 'ゲーム' }, cookie);
    expect(daily.status).toBe(429);
    // **日次には翌日の再開時刻が載る**（4.4）。
    expect(await daily.json()).toEqual({ error: DAILY_QUOTA_REASON, resetsAt });

    const monthlyRoutes = createGenerateRoutes({
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: MONTHLY_LIMIT_REASON }),
    });
    const monthly = await post(monthlyRoutes, { prompt: 'ゲーム' }, cookie);
    expect(monthly.status).toBe(429);
    // **月次には載せない。** 復帰は翌月であり、4.4 が求めているのは別のことである。
    expect(await monthly.json()).toEqual({ error: MONTHLY_LIMIT_REASON });
  });

  it('段が返した文字列を 429 の応答へ流さない（8.3）', async () => {
    // 段は差し替えられる。**応答に出てよいのは時刻と固定の分類名だけ**なので、
    // 知らない理由は 1 つの値へ倒す（`src/quota.ts` の `describeQuotaRejection`）。
    const hostile = '<img src=x onerror=alert(1)>';
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes({
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: hostile, resetsAt: 1 }),
    });
    const cookie = await sessionCookie(await seedUser('quota-hostile'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);

    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).not.toContain(hostile);
    expect(JSON.parse(text)).toEqual({ error: UNCLASSIFIED_QUOTA_CODE });
  });

  it('既定のパイプラインはすべての段が未実装である', async () => {
    // 空の実装を「成功」にしない。成功にすると、段を実装し忘れたまま経路が 200 を
    // 返し、生成できていないのに作品ができたように見える。
    await expect(
      startGeneration(testEnv(), 'user-1', { prompt: 'ゲーム' }, notImplementedPipeline),
    ).rejects.toBeInstanceOf(PipelineStepNotImplemented);
  });

  it('未実装の段は 501 とその名前を返す', async () => {
    // **`notImplementedPipeline` を明示的に渡す。** #23 でクォータ判定が実装されたため、
    // 既定のパイプラインで叩いても最初の段はもう 501 を投げない。ここで見たいのは
    // 「未実装の段が 501 とその名前になること」であり、どの段が未実装かではない。
    const routes = createGenerateRoutes(notImplementedPipeline);
    const cookie = await sessionCookie(await seedUser('notimpl'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'not implemented', step: 'checkQuota' });
  });

  it('全段が揃えば 202 と作品 id・作品ページの URL を返す', async () => {
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes(pipeline);
    const cookie = await sessionCookie(await seedUser('complete'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);
    expect(response.status).toBe(202);

    // **#150 で `url` が増えた。** id は段の戻り値ではなく、クォータ判定の直後に
    // Worker が採番したものになったので、値ではなく形で見る。
    const body = (await response.json()) as { gameId: string; url: string };
    expect(body.gameId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    // **URL は id から組み立てられている。** 2 つが食い違うと、返した URL が
    // 別の作品を指す（あるいはどこも指さない）。
    expect(body.url).toBe(workPagePath(body.gameId));
  });

  it('段が投げた例外を 500 にし、プロンプトを応答にもログにも漏らさない', async () => {
    // 段が投げる例外の中身はこちらで決まらない。8.2 のモデレーション対象になる入力を、
    // 保管場所も寿命も違うログへ段の実装しだいで流してよい理由がない。
    const { pipeline } = recordingPipeline();
    const secret = 'この文字列は応答にもログにも出てはいけない';
    const routes = createGenerateRoutes({
      ...pipeline,
      generateSource: async (_env, request) => {
        throw new Error(`失敗: ${request.prompt}`);
      },
    });
    const cookie = await sessionCookie(await seedUser('boom'));

    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '));
    };
    let response: Response;
    try {
      response = await post(routes, { prompt: secret }, cookie);
    } finally {
      console.error = original;
    }

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
    // 種類だけは残す。何も出さないと、落ちたことすら分からなくなる。
    expect(logged.join('\n')).toContain('Error');
  });
});

describe('生成の段が Bedrock へ結線されている（#83）', () => {
  /**
   * Bedrock の資格情報を入れた env。
   *
   * **実在の鍵を使わない。** ここで見たいのは結線であって、呼び出しの成否ではない。
   *
   * @returns 差し替えた env
   */
  function bedrockEnv(): Env {
    return {
      ...testEnv(),
      BEDROCK_AWS_REGION: 'ap-northeast-1',
      BEDROCK_AWS_ACCESS_KEY_ID: 'test-access-key-id',
      BEDROCK_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
      BEDROCK_AWS_SESSION_TOKEN: '',
    };
  }

  it('既定の生成の段は未実装の段そのものではない', () => {
    expect(defaultPipeline.generateSource).not.toBe(notImplementedPipeline.generateSource);
  });

  it('検査（#17）とビルド（#19）が結線されている', () => {
    // **同一性で見る。** 「501 を投げないこと」で見ると、未実装の段を別の例外へ
    // 変えただけの実装でも通ってしまう。
    expect(defaultPipeline.inspectSource).not.toBe(notImplementedPipeline.inspectSource);
    expect(defaultPipeline.build).not.toBe(notImplementedPipeline.build);
  });

  it('許可外の import を含む生成は 422 で拒否され、500 にはならない', async () => {
    // **経路の端まで見る。** `test/source-inspection.test.ts` は適合層までしか見て
    // おらず、`handleGenerate` の catch に分岐が無ければ汎用の 500 へ落ちる。
    // ここが 500 に戻ると、利用者には「システム障害」に見えて再試行を促してしまう。
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes({
      ...pipeline,
      generateSource: async () => ({
        modelKey: DEFAULT_GENERATION_MODEL_KEY,
        modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
        source: 'package main\n\nimport "os/exec"\n\nfunc main() {}\n',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: null,
          cacheWriteInputTokens: null,
        },
        stopReason: 'end_turn',
      }),
      // **既定の実装を借りる。** ここでテスト専用の検査を書くと、結線した現物では
      // なく写しを検査することになる。
      inspectSource: defaultPipeline.inspectSource,
    });

    const cookie = await sessionCookie(await seedUser('rejected'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; offending: readonly string[] };
    expect(body.error).toBe('source-rejected');
    expect(body.offending).toContain('os/exec');
  });

  it('システムプロンプト（#16）が結線されている', async () => {
    // **#16 で本文が入った。** 以前ここは `systemPrompt:<モデル>` の 501 を期待して
    // いたが、本物のリゾルバ（`src/system-prompt.ts`）へ差し替えたので、その段は
    // もう落ちない。
    //
    // **鍵を落とした env で確かめる。** `createBedrockGenerateSource` は
    // 「モデル決定 → システムプロンプト解決 → 資格情報」の順で解決するので、
    // 資格情報の不足まで到達したことが、そのままプロンプトが解決できた証拠になる。
    // **この経路は Bedrock を呼ばない**（呼べば課金が受け入れ条件に混ざる）。
    const withoutKeys: Env = { ...bedrockEnv(), BEDROCK_AWS_ACCESS_KEY_ID: '' };
    await expect(
      defaultPipeline.generateSource(withoutKeys, { prompt: 'ゲーム' }),
    ).rejects.toBeInstanceOf(BedrockNotConfigured);

    // 本文そのものの検査は `test/system-prompt.test.ts` が持つ。ここでは既定の経路が
    // その本文を使っていることだけを見る。
    const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
    expect(buildSystemPrompt(model).length).toBeGreaterThan(1);
  });

  it('費用の出る段は、費用を止める段より先に開かない（#23 / 4.3）', async () => {
    // **既定の経路を、枠を使い切った利用者で叩く。** クォータ判定（#23）が
    // 結線されていれば 429 で止まり、Bedrock へは進まない。
    //
    // **429 であること自体が「到達していない」証拠である。** この env には Bedrock の
    // 資格情報が無いので、生成の段まで進んでいれば `BedrockNotConfigured` で 500 になる。
    //
    // **時計を止めてから行を置く。** 既定の判定は現在時刻で日次の枠を数えるので、
    // 「現在時刻」で行を置くと**挿入と判定の間に JST の 0 時を跨いだ瞬間に枠が 0 に
    // 戻り**、この経路が Bedrock まで進む（#122 のレビュー指摘 3）。単に落ちるのでは
    // なく、**課金の出る経路へ入る**ため、跨ぐ可能性そのものを消す。
    //
    // `toFake` を `Date` だけに絞るのは、`setTimeout` まで差し替えると D1 の I/O が
    // 進まなくなるためである。セッションの発行・検証も同じ固定時計の上で行う。
    const userId = await seedUser('over-quota');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2020, 4, 15, 3));
      const now = Math.floor(Date.now() / 1000);
      for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
        await env.DB.prepare(
          `insert into generations
             (id, game_id, user_id, prompt, model,
              input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
              cost_jpy, succeeded, created_at)
           values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 0, 1, ?)`,
        )
          .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, now)
          .run();
      }

      const routes = createGenerateRoutes();
      const response = await post(routes, { prompt: 'ゲーム' }, await sessionCookie(userId));
      expect(response.status).toBe(429);
      // **既定の経路が日次で止まったことまで応答から読める**（4.4 / #132）。
      // 再開時刻は判定と同じ境界（JST の翌 0 時）である。
      expect(await response.json()).toEqual({
        error: DAILY_QUOTA_REASON,
        resetsAt: jstDayRange(now).toSeconds,
      });
    } finally {
      vi.useRealTimers();
      // **この経路が置いた行を残さない。** 固定時計を戻したあとの他のテストからは
      // 見えない月の行だが、storage を共有する経路が将来できたときに効く。
      await env.DB.prepare('delete from generations where user_id = ?').bind(userId).run();
    }
  });
});

describe('整理パスは 1 回で打ち切る（確定18 の条件 3・4 / M5-2 / #33）', () => {
  /** 上限を 1 バイト超えた元ソース（整理パスの入口）。 */
  const OVER_LIMIT = 'x'.repeat(MAX_SOURCE_BYTES + 1);

  /** 上限に収まった元ソース（通常のフォーク）。 */
  const IN_LIMIT = 'x'.repeat(MAX_SOURCE_BYTES);

  /**
   * 常にビルドが失敗するパイプラインと、生成の呼び出し記録。
   *
   * @returns 生成へ渡された `prompt` の記録と、パイプライン
   */
  function alwaysFailingBuild(): { prompts: string[]; pipeline: GenerationPipeline } {
    const base = recordingPipeline();
    const prompts: string[] = [];
    return {
      prompts,
      pipeline: {
        ...base.pipeline,
        generateSource: async (env, request, retry) => {
          prompts.push(request.prompt);
          return await base.pipeline.generateSource(env, request, retry);
        },
        build: async () => {
          throw new BuildRejected('build', './main.go:1:1: boom');
        },
      },
    };
  }

  afterAll(async () => {
    await env.DB.prepare("delete from generations where user_id like 'user-tidy-%'").run();
  });

  it('整理パスはコンパイルに失敗しても 1 回で終わる（条件 4）', async () => {
    // 条件 4 の理由欄は「リトライが乗ると最悪 3 回分の枠を消費する。失敗の連鎖を
    // 切る」。整理パスは 1 回でも 26〜41 円の見積もりなので、3 回に回すと
    // 1 度の操作で 120 円前後を失う。
    const { prompts, pipeline } = alwaysFailingBuild();

    await expect(
      startGeneration(
        testEnv(),
        'user-tidy-1',
        { prompt: 'ゲーム', baseSource: OVER_LIMIT },
        pipeline,
      ),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    expect(prompts).toHaveLength(TIDY_ATTEMPTS);
    expect(TIDY_ATTEMPTS).toBe(1);
  });

  it('整理パスでない生成は、いままでどおり 3 回試す', () => {
    // **整理パスの打ち切りが、通常のリトライを巻き込んでいないこと。**
    // ここが崩れると 5.2-7 が黙って消える。
    expect(MAX_GENERATION_ATTEMPTS).toBe(3);
  });

  it('上限に収まった元ソースのフォークは 3 回試す（条件 4 は整理パスだけ）', async () => {
    const { prompts, pipeline } = alwaysFailingBuild();

    await expect(
      startGeneration(testEnv(), 'user-tidy-2', { prompt: 'ゲーム', baseSource: IN_LIMIT }, pipeline),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    expect(prompts).toHaveLength(3);
  });
});

describe('整理の指示は包み層の中だけで足す（確定18 / M5-2 / #33）', () => {
  /**
   * 生成の段が受け取ったプロンプトを記録する。
   *
   * @returns 記録と、包んだ生成の段
   */
  function recordingGenerate(): {
    seen: string[];
    generate: (
      env: Env,
      request: { readonly prompt: string; readonly baseSource?: string },
    ) => Promise<GenerationResult>;
  } {
    const seen: string[] = [];
    return {
      seen,
      generate: async (_env, request) => {
        seen.push(request.prompt);
        return {
          modelKey: DEFAULT_GENERATION_MODEL_KEY,
          modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
          source: 'package main',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: null,
            cacheWriteInputTokens: null,
          },
          stopReason: 'end_turn',
        };
      },
    };
  }

  it('整理パスでは、利用者のプロンプトを消さずに指示を足す', async () => {
    const { seen, generate } = recordingGenerate();
    const wrapped = withTidyInstruction(generate);

    await wrapped({} as Env, { prompt: '敵を 3 体にする', baseSource: 'x'.repeat(MAX_SOURCE_BYTES + 1) });

    expect(seen[0]!.startsWith('敵を 3 体にする')).toBe(true);
    expect(seen[0]).toContain(String(MAX_SOURCE_BYTES));
  });

  it('整理パスでなければ 1 文字も足さない', async () => {
    // **新規生成と通常のフォークのプロンプトを変えない。** 変えると 4.5 の
    // キャッシュのプレフィックスが動き、4.2 の実測と比較できなくなる。
    const { seen, generate } = recordingGenerate();
    const wrapped = withTidyInstruction(generate);

    await wrapped({} as Env, { prompt: 'ゲーム' });
    await wrapped({} as Env, { prompt: 'ゲーム', baseSource: 'x'.repeat(MAX_SOURCE_BYTES) });

    expect(seen).toEqual(['ゲーム', 'ゲーム']);
  });

  it('費用の計上へ渡るのは、組み替える前のリクエストである', async () => {
    // `generations.prompt`（5.1）は利用者が書いた文字列を持つ。整理の指示を入れると、
    // **利用者が書いていない文字列が利用者の入力として残る。**
    //
    // **台帳の行ではなく、段へ渡る値を見る。** 3.3-4 の呼び出しが元のリクエストで
    // 行われることが確かめたい性質で、そこから先（`src/cost-ledger.ts` が D1 へ
    // 書くこと）は別の検査が持っている。
    const base = recordingPipeline();
    const toGenerate: string[] = [];
    const toLedger: string[] = [];
    const pipeline: GenerationPipeline = {
      ...base.pipeline,
      generateSource: withTidyInstruction(async (env, request) => {
        toGenerate.push(request.prompt);
        return await base.pipeline.generateSource(env, request);
      }),
      recordCost: async (_env, _userId, request) => {
        toLedger.push(request.prompt);
      },
    };

    await startGeneration(
      testEnv(),
      'user-tidy-3',
      { prompt: '敵を 3 体にする', baseSource: 'x'.repeat(MAX_SOURCE_BYTES + 1) },
      pipeline,
    );

    // 生成には指示が載り、台帳には載らない。**この 2 つが同じになったら赤になる。**
    expect(toLedger).toEqual(['敵を 3 体にする']);
    expect(toGenerate[0]).not.toBe('敵を 3 体にする');
    expect(toGenerate[0]!.startsWith('敵を 3 体にする')).toBe(true);
  });
});

describe('コンパイル失敗時の自動リトライ（5.2-7 / #20）', () => {
  /** Go の診断の代わり。**応答にもログにも台帳にも出てはいけない文字列。** */
  const DIAGNOSTICS = './main.go:12:2: undefined: ebiten.RunGameX';

  /**
   * 常にビルドが失敗するパイプライン。
   *
   * @param failures 何回目までビルドを失敗させるか（既定は常に）
   * @returns 観測用の配列と、パイプライン
   */
  function failingBuildPipeline(failures = Number.POSITIVE_INFINITY): {
    attempts: (BuildRetryContext | undefined)[];
    calls: string[];
    pipeline: GenerationPipeline;
  } {
    const base = recordingPipeline();
    const attempts: (BuildRetryContext | undefined)[] = [];
    let built = 0;
    return {
      attempts,
      calls: base.calls,
      pipeline: {
        ...base.pipeline,
        generateSource: async (env, request, retry) => {
          attempts.push(retry);
          return await base.pipeline.generateSource(env, request, retry);
        },
        build: async (env, generated) => {
          built += 1;
          if (built > failures) {
            return await base.pipeline.build(env, generated);
          }
          base.calls.push('build');
          throw new BuildRejected('build', DIAGNOSTICS);
        },
      },
    };
  }

  /**
   * 台帳の行を読む。
   *
   * @param userId 利用者の id
   * @returns 記録された行（古い順）
   */
  async function ledgerRows(
    userId: string,
  ): Promise<{ prompt: string; succeeded: number; model: string }[]> {
    const rows = await env.DB.prepare(
      'select prompt, succeeded, model from generations where user_id = ? order by rowid',
    )
      .bind(userId)
      .all<{ prompt: string; succeeded: number; model: string }>();
    return rows.results;
  }

  afterAll(async () => {
    // **この describe が置いた行だけを消す。** 月次上限（4.3 層 1）はサービス全体の
    // 累計で判定するので、実物の台帳へ書いた行を残すと他の経路の判定に効く
    // （`test/quota.test.ts` と同じ後始末）。
    await env.DB.prepare("delete from generations where user_id like 'gen-user-retry-%'").run();
  });

  it('常に失敗するソースは 3 回（初回＋2）で打ち切られる（acceptance 1）', async () => {
    const { attempts, calls, pipeline } = failingBuildPipeline();

    await expect(
      startGeneration(testEnv(), 'user-retry-1', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    // **回数を定数からも直値からも見る。** 定数だけで見ると、上限を 4 に変えた
    // 実装がテストごと追随して通る（変異が検出できない）。
    expect(MAX_GENERATION_ATTEMPTS).toBe(3);
    expect(attempts.length).toBe(3);
    expect(calls.filter((call) => call === 'generateSource').length).toBe(3);
    expect(calls.filter((call) => call === 'build').length).toBe(3);
    // 作品行は作られない。ビルドが通っていない以上、成果物は R2 に無い。
    expect(calls).not.toContain('completeGame');
  });

  it('クォータ判定はリトライの外側で 1 回だけ行う（4.3 / 3.3-2）', async () => {
    // 4.3 は「上限の判定は 3.3-2 の 1 か所で行う」と定める。ループの中で数え直すと
    // 判定位置が 2 か所になり、D1 の読み取りも試行のたびに増える（3.6）。
    // **枠の消費は台帳の行数で数える**ので、判定が 1 回でも消費は 3 回分である。
    const { calls, pipeline } = failingBuildPipeline();
    await startGeneration(testEnv(), 'user-retry-2', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );
    expect(calls.filter((call) => call === 'checkQuota').length).toBe(1);
    expect(calls.filter((call) => call === 'recordCost').length).toBe(3);
  });

  it('2 回目以降の生成に直前の診断とソースを渡す', async () => {
    const { attempts, pipeline } = failingBuildPipeline();
    await startGeneration(testEnv(), 'user-retry-3', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );

    expect(attempts[0]).toBeUndefined();
    expect(attempts[1]?.failedAttempt).toBe(1);
    expect(attempts[1]?.diagnostics).toBe(DIAGNOSTICS);
    expect(attempts[1]?.previousSource).toBe('package main');
    expect(attempts[2]?.failedAttempt).toBe(2);
    expect(attempts[2]?.diagnostics).toBe(DIAGNOSTICS);
  });

  it('通ったらそこで止まる（3 回まで回し切らない）', async () => {
    const { attempts, calls, pipeline } = failingBuildPipeline(1);
    const result = await startGeneration(
      testEnv(),
      'user-retry-4',
      { prompt: 'ゲーム' },
      pipeline,
    );
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(attempts.length).toBe(2);
    expect(calls.filter((call) => call === 'recordCost').length).toBe(2);
    expect(calls).toContain('completeGame');
  });

  it('各試行が台帳に 1 行ずつ記録され、succeeded が正しい（acceptance 2）', async () => {
    // **台帳は実物を使う**（`src/cost-ledger.ts`）。写しを使うと、記録の単位
    // （1 呼び出し 1 行）も `succeeded` の決まり方も検証したことにならない。
    const userId = await seedUser('retry-ledger');
    const { pipeline } = failingBuildPipeline();

    await expect(
      startGeneration(
        testEnv(),
        userId,
        { prompt: 'ゲーム' },
        { ...pipeline, recordCost: recordGenerationCost },
      ),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    const rows = await ledgerRows(userId);
    // 4.3「リトライ分も必ず計上する」。行をまとめたり上書きしたりしない。
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // `succeeded` は「使えるソースが返ったか」であって「作品ができたか」ではない
      // （4.3 の記録規約）。3 回ともビルドは失敗しているが、生成は成功している。
      expect(row.succeeded).toBe(1);
      // **台帳に残るのは利用者のプロンプトである。** 組み替えた側を記録すると、
      // 8.3 の検査を通っていない生成物と Go の診断が D1 の列へ入る。
      expect(row.prompt).toBe('ゲーム');
      expect(row.prompt).not.toContain(DIAGNOSTICS);
    }
  });

  it('記録を 1 回に減らすと acceptance 2 が破れる（この検査が効いていることの確認）', async () => {
    // **変異検査。** 計上をループの外へ出した実装（初回だけ記録する）を作り、
    // 上の検査が本当に 3 行を要求していることを確かめる。
    const userId = await seedUser('retry-ledger-once');
    const { pipeline } = failingBuildPipeline();
    let recorded = 0;

    await startGeneration(
      testEnv(),
      userId,
      { prompt: 'ゲーム' },
      {
        ...pipeline,
        recordCost: async (env, id, request, generated) => {
          recorded += 1;
          if (recorded > 1) {
            return;
          }
          await recordGenerationCost(env, id, request, generated);
        },
      },
    ).catch(() => undefined);

    expect((await ledgerRows(userId)).length).toBe(1);
  });

  it('リトライ対象でないビルド失敗は 1 回で止まる', async () => {
    // 回しても直らない失敗を回すと、1 リクエストで 3 回課金して必ず失敗する。
    const failures: readonly BuildFailure[] = [
      new BuildNotConfigured(['BUILD_AWS_ACCESS_KEY_ID']),
      new BuildTimedOut('function', 'req-1'),
      new BuildFunctionFailed(429, 'TooManyRequestsException', null, 'req-1'),
    ];

    for (const failure of failures) {
      const { attempts, pipeline } = failingBuildPipeline();
      await expect(
        startGeneration(
          testEnv(),
          'user-retry-5',
          { prompt: 'ゲーム' },
          {
            ...pipeline,
            build: async () => {
              throw failure;
            },
          },
        ),
        failure.name,
      ).rejects.toBe(failure);
      expect(attempts.length, failure.name).toBe(1);
    }
  });

  it('5.2-5 の拒否（許可外 import）はリトライしない', async () => {
    // 5.2-5 は「違反は再生成に回さず拒否」。混ぜると、禁止パッケージを使いたがる
    // プロンプトが 1 リクエストで 3 回の生成を起こせる。
    const { attempts, pipeline } = failingBuildPipeline();
    const routes = createGenerateRoutes({
      ...pipeline,
      generateSource: async (env, request, retry) => {
        attempts.push(retry);
        return {
          modelKey: DEFAULT_GENERATION_MODEL_KEY,
          modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
          source: 'package main\n\nimport "os/exec"\n\nfunc main() {}\n',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: null,
            cacheWriteInputTokens: null,
          },
          stopReason: 'end_turn',
        };
      },
      inspectSource: defaultPipeline.inspectSource,
    });

    const response = await post(routes, { prompt: 'ゲーム' }, await sessionCookie(await seedUser('reject-noretry')));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('source-rejected');
    expect(attempts.length).toBe(1);
  });

  it('max_tokens で切れたソースはリトライせず、失敗として 1 行だけ記録する（#17 の申し送り）', async () => {
    // **`max_tokens` それ自体は引き金にしない**（`src/build-retry.ts` の決定）。
    // 返せる診断が無く、しかも出力枠を使い切った最も高い失敗である。切れたソースは
    // 5.2-5 の検査で `unparsable` として落ち、422 のまま返る。
    const userId = await seedUser('retry-max-tokens');
    const { attempts, pipeline } = failingBuildPipeline();
    const truncated = 'package main\n\nimport (\n\t"github.com/hajimehoshi/ebiten/v2"\n';

    const routes = createGenerateRoutes({
      ...pipeline,
      generateSource: async (_env, _request, retry) => {
        attempts.push(retry);
        return {
          modelKey: DEFAULT_GENERATION_MODEL_KEY,
          modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
          source: truncated,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: null,
            cacheWriteInputTokens: null,
          },
          stopReason: 'max_tokens',
        };
      },
      recordCost: recordGenerationCost,
      inspectSource: defaultPipeline.inspectSource,
    });

    const response = await post(routes, { prompt: 'ゲーム' }, await sessionCookie(userId));
    expect(response.status).toBe(422);
    expect(attempts.length).toBe(1);

    const rows = await ledgerRows(userId);
    // **課金は発生している。** 記録しないのではなく、失敗として記録する（4.3）。
    expect(rows.length).toBe(1);
    expect(rows[0]?.succeeded).toBe(0);
  });

  it('上限に達したら 422 と利用者向けの文言を返し、診断を漏らさない', async () => {
    const { pipeline } = failingBuildPipeline();
    const routes = createGenerateRoutes(pipeline);
    const cookie = await sessionCookie(await seedUser('retry-exhausted'));

    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '));
    };
    let response: Response;
    try {
      response = await post(routes, { prompt: 'ゲーム' }, cookie);
    } finally {
      console.error = original;
    }

    expect(response.status).toBe(422);
    const text = await response.text();
    const body = JSON.parse(text) as { error: string; attempts: number; message: string };
    expect(body.error).toBe('build-failed');
    expect(body.attempts).toBe(MAX_GENERATION_ATTEMPTS);
    expect(body.message).not.toBe('');
    // **500 に落ちない。** 落ちると利用者には「システム障害」に見えて再試行を促す。
    // **診断は Go が生成コードの行を引用したもの**で、応答にもログにも出さない。
    expect(text).not.toContain(DIAGNOSTICS);
    expect(logged.join('\n')).not.toContain(DIAGNOSTICS);
    // 落ちたことと回数だけは残す。何も出さないと運用時に追えない。
    expect(logged.join('\n')).toContain('BuildRetriesExhausted');
  });

  it('リトライ回数の宣言とコード側の定数が一致する（5.2-7）', () => {
    // 同じ数値が仕様書とコードの 2 か所にある以上、機械で照合する
    // （shared-ai-rules 12 章。`test/quota.test.ts` と同じやり方）。
    // **仕様書は再試行の回数、定数は試行の総数**なので、+1 して突き合わせる。
    const values = [...env.TEST_PRODUCT_SPEC.matchAll(RETRY_LIMIT_PATTERN)].map((matched) =>
      Number(matched[1]),
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value + 1).toBe(MAX_GENERATION_ATTEMPTS);
    }
  });

  it('仕様書側を変異させると照合が破れる', () => {
    const doctored = env.TEST_PRODUCT_SPEC.replace(
      '自動リトライ（最大2回）',
      '自動リトライ（最大5回）',
    );
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    const values = [...doctored.matchAll(RETRY_LIMIT_PATTERN)].map((matched) =>
      Number(matched[1]),
    );
    expect(values).toContain(5);
  });

  it('既定の生成の段は診断を織り込む層で包まれている（#20 の結線）', () => {
    // **同一性ではなく引数の数で見る。** 包む層（`withBuildDiagnostics`）を外すと
    // `createBedrockGenerateSource` が返す 2 引数の関数がそのまま入り、
    // **リトライは診断を捨てた引き直しになる**（型は通る。第 3 引数は任意なので）。
    // 実呼び出しでは確かめられない（呼べば課金される）。
    expect(defaultPipeline.generateSource.length).toBe(3);
  });
});

describe('経路', () => {
  it('GET は受け付けない', async () => {
    const response = await dispatch(
      createGenerateRoutes(),
      new Request(`${APP_ORIGIN}${GENERATE_PATH}`),
      testEnv(),
    );
    expect(response.status).toBe(405);
  });
});

describe('失敗も必ず作品行へ書く（#150）', () => {
  /**
   * 作品行の生成状態を読む。
   *
   * @param userId 作者
   * @returns いちばん新しい行の状態と分類名
   */
  async function latestStateOf(
    userId: string,
  ): Promise<{ state: string; error: string | null } | null> {
    const row = await env.DB.prepare(
      `select generation_state, generation_error from games
        where author_id = ? order by rowid desc limit 1`,
    )
      .bind(userId)
      .first<{ generation_state: string; generation_error: string | null }>();
    return row === null ? null : { state: row.generation_state, error: row.generation_error };
  }

  it('failGame の段を省いた実装でも、失敗は行へ書かれる（#160）', async () => {
    // **`failGame` は任意の段である**（`src/generate.ts`）。省いた実装——順序だけを
    // 見る既存のテストが作るもの——では D1 へ直接書く既定に落ちる。**落ちなければ
    // 行は `running` のまま残り、作品ページが永久に「生成中」を出し続ける。**
    const userId = await seedUser('fail-default-stage');
    const { pipeline } = recordingPipeline();
    expect(pipeline.failGame).toBeUndefined();
    const failing: GenerationPipeline = {
      ...pipeline,
      build: async () => {
        throw new BuildRejected('build', 'prog.go:1:1: syntax error');
      },
    };

    await expect(
      startGeneration(env, userId, { prompt: '段を省いた作品' }, failing),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);
    expect(await latestStateOf(userId)).toEqual({ state: 'failed', error: 'build-failed' });
  });

  it('failGame の段を差し替えると、そちらが呼ばれる（#160）', async () => {
    // **オーケストレータはここを `finish` コールバックへ差し替える。** 差し替えが
    // 効いていることを、D1 側が更新されないことで見る（段が無視されると、
    // Lambda から D1 のバインディングを要求する経路が残る）。
    const userId = await seedUser('fail-stage-swap');
    const seen: string[] = [];
    const { pipeline } = recordingPipeline();
    const failing: GenerationPipeline = {
      ...pipeline,
      build: async () => {
        throw new BuildRejected('build', 'prog.go:1:1: syntax error');
      },
      failGame: async (_env, _gameId, errorCode) => {
        seen.push(errorCode);
        return true;
      },
    };

    await expect(
      startGeneration(env, userId, { prompt: '段を差し替えた作品' }, failing),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);
    expect(seen).toEqual(['build-failed']);
    // **分類名は `internal` になる。** 段が D1 を触らなかったので、行を閉じたのは
    // `startGeneration` の catch（Worker 側。D1 を持つ）である。**そちらは段を
    // 経由しない**——非同期実装で「投げ込めなかった」ときに行を閉じるのは、
    // コールバックではなく Worker 自身の仕事だからである（`src/generate.ts`）。
    expect(await latestStateOf(userId)).toEqual({ state: 'failed', error: 'internal' });
  });

  it('degrade の信号を段へ渡す（#140 / 3.8 / 確定24）', async () => {
    // **`errorCode` では代われない。** ビルド関数の障害も D1 の不調も `internal` に
    // 落ちる（`src/games.ts` の語彙に区別が無い）。段の 4 つ目の引数だけが、
    // 生成画面がサービス全体の停止を判定できる材料である。
    //
    // 分類そのものは `src/build-health.ts` が持ち、その網羅は
    // `test/build-health.test.ts` が見る。**ここが見るのは「渡っているか」だけ**である。
    /**
     * ビルドの段を落として、段へ渡った信号を取り出す。
     *
     * @param suffix テスト内で一意な接尾辞
     * @param error ビルドの段が投げる値
     * @returns 段が受け取った（分類名, 信号）
     */
    async function signalOf(
      suffix: string,
      error: unknown,
    ): Promise<{ code: string; signal: boolean | undefined }> {
      const userId = await seedUser(`signal-${suffix}`);
      const seen: { code: string; signal: boolean | undefined }[] = [];
      const { pipeline } = recordingPipeline();
      const failing: GenerationPipeline = {
        ...pipeline,
        build: async () => {
          throw error;
        },
        failGame: async (_env, _gameId, errorCode, buildPathFailed) => {
          seen.push({ code: errorCode, signal: buildPathFailed });
          return true;
        },
      };
      await expect(
        startGeneration(env, userId, { prompt: `${suffix} の作品` }, failing),
      ).rejects.toBeTruthy();
      expect(seen).toHaveLength(1);
      return seen[0]!;
    }

    // 確定24 の停止事象（スロットリング）。**分類名は `internal` である。**
    expect(
      await signalOf('function', new BuildFunctionFailed(429, 'TooManyRequestsException', null, 'r')),
    ).toEqual({ code: 'internal', signal: true });

    // **D1 の不調。分類名は同じ `internal` だが、信号は立たない。**
    // ここが #140 の acceptance 2 の分かれ目である。
    expect(await signalOf('d1', new Error('D1_ERROR: database is locked'))).toEqual({
      code: 'internal',
      signal: false,
    });

    // 時間切れは 3.8 の #164 注記が明示的に除外している。
    expect(await signalOf('timeout', new BuildTimedOut('function', 'req'))).toEqual({
      code: 'build-timeout',
      signal: false,
    });

    // コンパイルが通らなかっただけ（5.2-7 の上限まで試した結果）。
    expect(await signalOf('rejected', new BuildRejected('build', 'prog.go:1:1: syntax error'))).toEqual(
      { code: 'build-failed', signal: false },
    );
  });

  it('ビルドを使い切った失敗は build-failed として残る', async () => {
    const userId = await seedUser('fail-build');
    const { pipeline } = recordingPipeline();
    const failing: GenerationPipeline = {
      ...pipeline,
      build: async () => {
        throw new BuildRejected('build', 'prog.go:1:1: syntax error');
      },
    };

    await expect(
      startGeneration(env, userId, { prompt: '失敗する作品' }, failing),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    // **`startGeneration` の catch が `internal` で上書きしないこと。**
    // `failGame` は `pending` / `running` からしか遷移しないので、既に書かれた
    // 分類名が残る。ここが `internal` になったら、利用者に出る説明が壊れる。
    expect(await latestStateOf(userId)).toEqual({ state: 'failed', error: 'build-failed' });
  });

  it('許可外 import の拒否は source-rejected として残る', async () => {
    const userId = await seedUser('fail-source');
    const { pipeline } = recordingPipeline();
    const rejecting: GenerationPipeline = {
      ...pipeline,
      inspectSource: () => {
        throw new GeneratedSourceRejected('not-allowed', ['os/exec']);
      },
    };

    await expect(
      startGeneration(env, userId, { prompt: '許可外の作品' }, rejecting),
    ).rejects.toBeInstanceOf(GeneratedSourceRejected);
    expect(await latestStateOf(userId)).toEqual({ state: 'failed', error: 'source-rejected' });
  });

  it('行を完成させられなかったら成功にしない（永遠に「生成中」を作らない）', async () => {
    // **戻り値を捨てると、ジョブが成功扱いのまま行が `running` で残る。**
    // 作品ページが永遠に「生成中」を出し続ける状態そのものである。
    // **回り続ける表示より、失敗として読めるほうがよい。**
    const userId = await seedUser('not-completable');
    const { pipeline } = recordingPipeline();
    const stuck: GenerationPipeline = {
      ...pipeline,
      // 0 行更新（もう `running` ではない）を再現する。
      completeGame: async () => false,
    };

    await expect(
      startGeneration(env, userId, { prompt: '完成できない作品' }, stuck),
    ).rejects.toBeInstanceOf(GenerationNotCompletable);

    // `running` のまま残らないこと。
    expect(await latestStateOf(userId)).toEqual({ state: 'failed', error: 'internal' });
  });

  it('クォータで断られたときは行を 1 つも作らない', async () => {
    // **3.3 の順序が保たれていることの確認。** 判定は行の作成より前にある（4.3）。
    const userId = await seedUser('fail-quota');
    const { pipeline } = recordingPipeline();
    const denied: GenerationPipeline = {
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: DAILY_QUOTA_REASON }),
    };

    await expect(
      startGeneration(env, userId, { prompt: 'ゲーム' }, denied),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(await latestStateOf(userId)).toBeNull();
  });
});

describe('ジョブの起動点が既定へ結線されている（#150 / #160 / 3.3-2.6）', () => {
  it('startJob が非同期実装（startJobOnLambda）である', () => {
    // **同一性で見る**（`test/quota.test.ts` / `test/games.test.ts` と同じ形）。
    // #160 でここが差し替わったこと自体が、待ち時間の設計が変わった合図である。
    expect(defaultPipeline.startJob).toBe(startJobOnLambda);
    // **同期実装は既定ではない。** 戻っていれば `test/work-page.test.ts` の
    // `GENERATION_IS_SYNCHRONOUS` 照合も同時に落ちる。
    expect(defaultPipeline.startJob).not.toBe(runJobInline);
  });

  it('失敗の記録（failGame）が既定へ結線されている（#160）', () => {
    // **段にしたのはオーケストレータが D1 を持たないからである**（`src/generate.ts`）。
    // 既定では D1 へ直接書く実装が入っていること自体を、同一性で確かめる。
    expect(defaultPipeline.failGame).toBe(failGame);
  });

  it('未実装の起動点は 501 として扱える（空実装を成功にしない）', async () => {
    expect(() => notImplementedPipeline.startJob({} as Env, {} as never, notImplementedPipeline))
      .toThrow(PipelineStepNotImplemented);
  });
});
