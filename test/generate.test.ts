import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GENERATE_PATH,
  MAX_PROMPT_LENGTH,
  PipelineStepNotImplemented,
  QuotaExceeded,
  createGenerateRoutes,
  defaultPipeline,
  notImplementedPipeline,
  runGenerationPipeline,
} from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
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
import { DAILY_QUOTA_PER_USER } from '../src/quota.js';
import { buildSystemPrompt } from '../src/system-prompt.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession } from '../src/session.js';
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
      createGame: async () => {
        calls.push('createGame');
        return { id: 'game-1' };
      },
    },
  };
}

beforeAll(async () => {
  await applySchema();
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
    const result = await runGenerationPipeline(
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
      'createGame',
    ]);
    expect(result.id).toBe('game-1');
  });

  it('費用の計上が検査とビルドより前にある', async () => {
    // 生成が返った時点で課金は済んでいる。計上をビルドの後ろへ動かすと、検査や
    // ビルドで落ちた分が台帳から漏れ、4.3 の「リトライ分も必ず計上する」が崩れる。
    const { calls, pipeline } = recordingPipeline();
    await runGenerationPipeline(testEnv(), 'user-1', { prompt: 'ゲーム' }, pipeline).catch(
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
      runGenerationPipeline(testEnv(), 'user-1', { prompt: 'ゲーム' }, denied),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(calls).toEqual(['checkQuota']);
  });

  it('クォータ超過は 429 で返す', async () => {
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes({
      ...pipeline,
      checkQuota: async () => ({ allowed: false, reason: 'monthly' }),
    });
    const cookie = await sessionCookie(await seedUser('quota'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);
    expect(response.status).toBe(429);
  });

  it('既定のパイプラインはすべての段が未実装である', async () => {
    // 空の実装を「成功」にしない。成功にすると、段を実装し忘れたまま経路が 200 を
    // 返し、生成できていないのに作品ができたように見える。
    await expect(
      runGenerationPipeline(testEnv(), 'user-1', { prompt: 'ゲーム' }, notImplementedPipeline),
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

  it('全段が揃えば 202 と作品 id を返す', async () => {
    const { pipeline } = recordingPipeline();
    const routes = createGenerateRoutes(pipeline);
    const cookie = await sessionCookie(await seedUser('complete'));
    const response = await post(routes, { prompt: 'ゲーム' }, cookie);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ gameId: 'game-1' });
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
    const body = (await response.json()) as { error: string; imports: readonly string[] };
    expect(body.error).toBe('source-rejected');
    expect(body.imports).toContain('os/exec');
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
      expect(await response.json()).toEqual({ error: 'quota exceeded' });
    } finally {
      vi.useRealTimers();
      // **この経路が置いた行を残さない。** 固定時計を戻したあとの他のテストからは
      // 見えない月の行だが、storage を共有する経路が将来できたときに効く。
      await env.DB.prepare('delete from generations where user_id = ?').bind(userId).run();
    }
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
      runGenerationPipeline(testEnv(), 'user-retry-1', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    // **回数を定数からも直値からも見る。** 定数だけで見ると、上限を 4 に変えた
    // 実装がテストごと追随して通る（変異が検出できない）。
    expect(MAX_GENERATION_ATTEMPTS).toBe(3);
    expect(attempts.length).toBe(3);
    expect(calls.filter((call) => call === 'generateSource').length).toBe(3);
    expect(calls.filter((call) => call === 'build').length).toBe(3);
    // 作品行は作られない。ビルドが通っていない以上、成果物は R2 に無い。
    expect(calls).not.toContain('createGame');
  });

  it('クォータ判定はリトライの外側で 1 回だけ行う（4.3 / 3.3-2）', async () => {
    // 4.3 は「上限の判定は 3.3-2 の 1 か所で行う」と定める。ループの中で数え直すと
    // 判定位置が 2 か所になり、D1 の読み取りも試行のたびに増える（3.6）。
    // **枠の消費は台帳の行数で数える**ので、判定が 1 回でも消費は 3 回分である。
    const { calls, pipeline } = failingBuildPipeline();
    await runGenerationPipeline(testEnv(), 'user-retry-2', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );
    expect(calls.filter((call) => call === 'checkQuota').length).toBe(1);
    expect(calls.filter((call) => call === 'recordCost').length).toBe(3);
  });

  it('2 回目以降の生成に直前の診断とソースを渡す', async () => {
    const { attempts, pipeline } = failingBuildPipeline();
    await runGenerationPipeline(testEnv(), 'user-retry-3', { prompt: 'ゲーム' }, pipeline).catch(
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
    const result = await runGenerationPipeline(
      testEnv(),
      'user-retry-4',
      { prompt: 'ゲーム' },
      pipeline,
    );
    expect(result.id).toBe('game-1');
    expect(attempts.length).toBe(2);
    expect(calls.filter((call) => call === 'recordCost').length).toBe(2);
    expect(calls).toContain('createGame');
  });

  it('各試行が台帳に 1 行ずつ記録され、succeeded が正しい（acceptance 2）', async () => {
    // **台帳は実物を使う**（`src/cost-ledger.ts`）。写しを使うと、記録の単位
    // （1 呼び出し 1 行）も `succeeded` の決まり方も検証したことにならない。
    const userId = await seedUser('retry-ledger');
    const { pipeline } = failingBuildPipeline();

    await expect(
      runGenerationPipeline(
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

    await runGenerationPipeline(
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
        runGenerationPipeline(
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
