import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  GENERATE_PATH,
  MAX_PROMPT_LENGTH,
  PipelineStepNotImplemented,
  QuotaExceeded,
  createGenerateRoutes,
  notImplementedPipeline,
  runGenerationPipeline,
} from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
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
        return { source: 'package main' };
      },
      recordCost: async () => {
        calls.push('recordCost');
      },
      inspectSource: () => {
        calls.push('inspectSource');
      },
      build: async () => {
        calls.push('build');
        return { wasmKey: 'k' };
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
    const routes = createGenerateRoutes();
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
