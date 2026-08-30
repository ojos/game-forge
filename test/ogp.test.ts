import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import { createPublishRoutes } from '../src/publish.js';
import { PUBLISH_GAME_ID_FIELD, PUBLISH_PATH } from '../src/paths.js';
import {
  claimGenerationJob,
  completeGame,
  createJobToken,
  createPendingGame,
  hashJobToken,
} from '../src/games.js';
import {
  MAX_OGP_IMAGE_BYTES,
  OGP_CALLBACK_PATH,
  OGP_GAME_ID_HEADER,
  OGP_IMAGE_HEIGHT,
  OGP_IMAGE_WIDTH,
  OGP_TOKEN_HEADER,
  claimOgpCapture,
  ogpImagePath,
  ogpObjectKey,
  ogpRoutes,
  startOgpCapture,
} from '../src/ogp.js';
import type { OgpCaptureJob } from '../src/ogp-client.js';
import {
  ASYNC_INVOCATION_TYPE,
  OgpInvokeFailed,
  createOgpCaptureStart,
  invokeEndpoint,
  missingOgpSecrets,
} from '../src/ogp-client.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workPageRoutes, workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-ogp-endpoint-01';

/** 1×1 の PNG（`PNG signature` を含む最小の実体）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * テスト用の env（AWS の資格情報つき）。
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

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `ogp-user-${suffix}`;
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
 * 完成済み（未公開）の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者の id と作品 id
 */
async function seedReadyGame(suffix: string): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: `ゴリラ${suffix}` });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * 公開して、撮影のトークンを受け取る。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者の id・作品 id・撮影のトークン
 */
async function seedPublishedGame(
  suffix: string,
): Promise<{ userId: string; id: string; ogpToken: string }> {
  const { userId, id } = await seedReadyGame(suffix);
  const jobs: OgpCaptureJob[] = [];
  const response = await dispatch(
    createPublishRoutes(async (_env, job) => {
      jobs.push(job);
    }),
    new Request(`${APP_ORIGIN}${PUBLISH_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        cookie: await sessionCookie(userId),
      },
      body: new URLSearchParams({ [PUBLISH_GAME_ID_FIELD]: id }).toString(),
    }),
    testEnv(),
  );
  expect(response.status).toBe(303);
  expect(jobs).toHaveLength(1);
  return { userId, id, ogpToken: jobs[0]!.ogpToken };
}

/**
 * 撮影の結果を送る。
 *
 * @param gameId 作品 id
 * @param token 撮影のトークン
 * @param body 本文（`null` なら失敗の通知）
 * @returns レスポンス
 */
async function sendCallback(
  gameId: string,
  token: string,
  body: Uint8Array | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    [OGP_GAME_ID_HEADER]: gameId,
    [OGP_TOKEN_HEADER]: token,
    'content-type': body === null ? 'application/json' : 'image/png',
  };
  return await dispatch(
    ogpRoutes,
    new Request(`${APP_ORIGIN}${OGP_CALLBACK_PATH}`, {
      method: 'POST',
      headers,
      body: body === null ? '{"error":"capture-failed"}' : body,
    }),
    testEnv(),
  );
}

/**
 * 画像を取りに行く。
 *
 * @param gameId 作品 id
 * @returns レスポンス
 */
async function fetchImage(gameId: string): Promise<Response> {
  return await dispatch(
    ogpRoutes,
    new Request(`${APP_ORIGIN}${ogpImagePath(gameId)}`),
    testEnv(),
  );
}

/**
 * 作品ページの本文を読む。
 *
 * @param gameId 作品 id
 * @returns HTML
 */
async function workPage(gameId: string): Promise<string> {
  const response = await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${workPagePath(gameId)}`),
    testEnv(),
  );
  return await response.text();
}

/**
 * `games.ogp_state` を読む。
 *
 * @param id 作品 id
 * @returns 撮影の状態と鍵
 */
async function readOgp(id: string): Promise<{ ogp_state: string | null; ogp_key: string | null }> {
  const row = await env.DB.prepare('select ogp_state, ogp_key from games where id = ?')
    .bind(id)
    .first<{ ogp_state: string | null; ogp_key: string | null }>();
  if (row === null) {
    throw new Error(`作品が見つかりません: ${id}`);
  }
  return row;
}

beforeAll(async () => {
  await applySchema();
});

describe('撮影の関門（5.4 の「公開時まで遅延する」）', () => {
  it('未公開の作品では撮影の権利を取れない', async () => {
    // **これが「未公開作品の OGP 生成が実行されない」の機構である**（#26 acceptance 2）。
    // 呼び出し側の `if` ではなく、UPDATE の `where status = 'published'` が止める。
    const { id } = await seedReadyGame('claim-draft');
    expect(await claimOgpCapture(env, id, 'a'.repeat(64))).toBe(false);
    expect((await readOgp(id)).ogp_state).toBeNull();
  });

  it('未公開の作品に対しては撮影の呼び出しが 1 回も起きない', async () => {
    const { id } = await seedReadyGame('start-draft');
    const calls: OgpCaptureJob[] = [];
    const outcome = await startOgpCapture(testEnv(), id, async (_env, job) => {
      calls.push(job);
    });
    expect(outcome).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('公開済みでも二度目の起動は止まる', async () => {
    const { id } = await seedPublishedGame('claim-twice');
    const calls: OgpCaptureJob[] = [];
    const outcome = await startOgpCapture(testEnv(), id, async (_env, job) => {
      calls.push(job);
    });
    expect(outcome).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('設定が無い環境では撮影を起こさず、状態も触らない', async () => {
    const { id } = await seedReadyGame('unconfigured');
    await env.DB.prepare("update games set status = 'published' where id = ?").bind(id).run();
    const calls: OgpCaptureJob[] = [];
    // **`BUILD_AWS_*` を持たない env**（ローカル開発の通常の状態）。
    const outcome = await startOgpCapture(env, id, async (_env, job) => {
      calls.push(job);
    });
    expect(missingOgpSecrets(env).length).toBeGreaterThan(0);
    expect(outcome).toBe('skipped');
    expect(calls).toEqual([]);
    // **`failed` にしない**（撮ろうとして撮れなかったのではない）。
    expect((await readOgp(id)).ogp_state).toBeNull();
  });

  it('投げ込めなければ failed になる', async () => {
    const { id } = await seedReadyGame('invoke-failed');
    await env.DB.prepare("update games set status = 'published' where id = ?").bind(id).run();
    const outcome = await startOgpCapture(testEnv(), id, async () => {
      throw new Error('boom');
    });
    expect(outcome).toBe('failed');
    // 権利を取ったまま誰も進められない行を残さない。
    expect((await readOgp(id)).ogp_state).toBe('failed');
  });
});

describe('撮影の結果を受け取る', () => {
  it('PNG を受け取ると R2 へ入り ogp_state が ready になる', async () => {
    const { id, ogpToken } = await seedPublishedGame('callback-ok');

    const response = await sendCallback(id, ogpToken, PNG_BYTES);
    expect(response.status).toBe(200);

    const row = await readOgp(id);
    expect(row.ogp_state).toBe('ready');
    expect(row.ogp_key).toBe(ogpObjectKey(id));

    const object = await env.BUCKET.get(ogpObjectKey(id));
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);
    expect(object!.httpMetadata?.contentType).toBe('image/png');
  });

  it('同じトークンの 2 通目は 404（使い捨て）', async () => {
    // Lambda の非同期呼び出しは同じイベントを複数回配信しうる（AWS 明文）。
    const { id, ogpToken } = await seedPublishedGame('callback-twice');
    expect((await sendCallback(id, ogpToken, PNG_BYTES)).status).toBe(200);
    expect((await sendCallback(id, ogpToken, PNG_BYTES)).status).toBe(404);
    expect((await readOgp(id)).ogp_state).toBe('ready');
  });

  it('トークンが違えば 404', async () => {
    const { id } = await seedPublishedGame('callback-bad-token');
    const response = await sendCallback(id, createJobToken(), PNG_BYTES);
    expect(response.status).toBe(404);
    expect((await readOgp(id)).ogp_state).toBe('capturing');
    expect(await env.BUCKET.get(ogpObjectKey(id))).toBeNull();
  });

  it('トークンが違う要求は、既にある画像を上書きできない', async () => {
    // **キーは作品 id から決まる。** 照合を R2 への書き込みより後ろに置くと、
    // id を知っているだけの相手が公開済みの作品の画像を差し替えられる
    // （D1 は変わらないので、行を見ても気づけない）。
    const { id, ogpToken } = await seedPublishedGame('callback-no-overwrite');
    await sendCallback(id, ogpToken, PNG_BYTES);

    const forged = new Uint8Array(PNG_BYTES);
    forged[forged.length - 1] = 0x00;
    const response = await sendCallback(id, createJobToken(), forged);

    expect(response.status).toBe(404);
    const object = await env.BUCKET.get(ogpObjectKey(id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('PNG でない本文は 400 で、R2 にも入らない', async () => {
    const { id, ogpToken } = await seedPublishedGame('callback-not-png');
    const response = await dispatch(
      ogpRoutes,
      new Request(`${APP_ORIGIN}${OGP_CALLBACK_PATH}`, {
        method: 'POST',
        headers: {
          [OGP_GAME_ID_HEADER]: id,
          [OGP_TOKEN_HEADER]: ogpToken,
          'content-type': 'image/png',
        },
        body: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01]),
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(await env.BUCKET.get(ogpObjectKey(id))).toBeNull();
    expect((await readOgp(id)).ogp_state).toBe('capturing');
  });

  it('上限を超える本文は 413', async () => {
    const { id, ogpToken } = await seedPublishedGame('callback-too-large');
    const oversized = new Uint8Array(MAX_OGP_IMAGE_BYTES + 1);
    oversized.set(PNG_BYTES.slice(0, 8));
    const response = await dispatch(
      ogpRoutes,
      new Request(`${APP_ORIGIN}${OGP_CALLBACK_PATH}`, {
        method: 'POST',
        headers: {
          [OGP_GAME_ID_HEADER]: id,
          [OGP_TOKEN_HEADER]: ogpToken,
          'content-type': 'image/png',
        },
        body: oversized,
      }),
      testEnv(),
    );
    expect(response.status).toBe(413);
    expect(await env.BUCKET.get(ogpObjectKey(id))).toBeNull();
  });

  it('失敗の通知は failed として記録される', async () => {
    const { id, ogpToken } = await seedPublishedGame('callback-failed');
    const response = await sendCallback(id, ogpToken, null);
    expect(response.status).toBe(200);
    expect((await readOgp(id)).ogp_state).toBe('failed');
    expect((await readOgp(id)).ogp_key).toBeNull();
  });

  it('綴りの違うヘッダは本文を読む前に断る', async () => {
    const { id, ogpToken } = await seedPublishedGame('callback-headers');
    expect((await sendCallback('not-a-uuid', ogpToken, PNG_BYTES)).status).toBe(400);
    expect((await sendCallback(id, 'not-a-token', PNG_BYTES)).status).toBe(400);
    expect((await readOgp(id)).ogp_state).toBe('capturing');
  });
});

describe('画像の配信', () => {
  it('公開済みで撮影済みなら PNG を返す', async () => {
    const { id, ogpToken } = await seedPublishedGame('serve-ok');
    await sendCallback(id, ogpToken, PNG_BYTES);

    const response = await fetchImage(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('max-age');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('未公開の作品の画像は 404（画像も公開の対象である）', async () => {
    const { id, ogpToken } = await seedPublishedGame('serve-unpublished');
    await sendCallback(id, ogpToken, PNG_BYTES);
    // 撮影済みのまま draft へ戻す（通常は起こらないが、条件が 1 つでないことを確かめる）。
    await env.DB.prepare("update games set status = 'draft' where id = ?").bind(id).run();

    expect((await fetchImage(id)).status).toBe(404);
  });

  it('まだ撮れていない作品は 404', async () => {
    const { id } = await seedPublishedGame('serve-capturing');
    expect((await fetchImage(id)).status).toBe(404);
  });

  it('綴りが違えば 404', async () => {
    for (const path of ['/ogp/', '/ogp/not-a-uuid.png', '/ogp/x.jpg']) {
      const response = await dispatch(ogpRoutes, new Request(`${APP_ORIGIN}${path}`), testEnv());
      expect(response.status, path).toBe(404);
    }
  });

  it('行は ready でも実体が無ければ 404（黙って空を返さない）', async () => {
    const { id, ogpToken } = await seedPublishedGame('serve-missing-object');
    await sendCallback(id, ogpToken, PNG_BYTES);
    await env.BUCKET.delete(ogpObjectKey(id));
    expect((await fetchImage(id)).status).toBe(404);
  });
});

describe('OGP のメタタグ（#26 acceptance 3）', () => {
  it('公開後に og:image と og:url が正しい URL を返す', async () => {
    const { id, ogpToken } = await seedPublishedGame('meta-ready');
    await sendCallback(id, ogpToken, PNG_BYTES);

    const body = await workPage(id);
    expect(body).toContain(
      `<meta property="og:image" content="${APP_ORIGIN}${ogpImagePath(id)}">`,
    );
    expect(body).toContain(
      `<meta property="og:url" content="${APP_ORIGIN}${workPagePath(id)}">`,
    );
    expect(body).toContain(`<meta property="og:image:width" content="${OGP_IMAGE_WIDTH}">`);
    expect(body).toContain(`<meta property="og:image:height" content="${OGP_IMAGE_HEIGHT}">`);
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
    // **画像の URL は実際に引ける。** メタタグと配信が食い違っていないことまで見る。
    expect((await fetchImage(id)).status).toBe(200);
  });

  it('未公開の作品にはメタタグを出さず、noindex を残す', async () => {
    const { id } = await seedReadyGame('meta-draft');
    const body = await workPage(id);
    expect(body).not.toContain('og:image');
    expect(body).not.toContain('og:url');
    expect(body).toContain('<meta name="robots" content="noindex">');
  });

  it('撮影が終わるまでは og:image を出さない', async () => {
    // 公開の直後は `capturing` である。**出すと、クローラが 404 を引く。**
    const { id } = await seedPublishedGame('meta-capturing');
    const body = await workPage(id);
    expect(body).toContain('og:url');
    expect(body).not.toContain('og:image');
    expect(body).toContain('<meta name="twitter:card" content="summary">');
    expect(body).not.toContain('<meta name="robots" content="noindex">');
  });

  it('公開すると題名が誰にでも見える', async () => {
    // 未公開のあいだはプロンプト由来の題名を本人にしか出さない（#150）。
    // **公開そのものが「これを作品として出す」という意思表示である**（5.4）。
    const { id } = await seedReadyGame('meta-title');
    expect(await workPage(id)).not.toContain('ゴリラmeta-title');
    await env.DB.prepare("update games set status = 'published' where id = ?").bind(id).run();
    expect(await workPage(id)).toContain('ゴリラmeta-title');
  });
});

describe('撮影関数の呼び出し（src/ogp-client.ts）', () => {
  /**
   * 署名済みの要求を捕まえる。
   *
   * @param status 返すステータス
   * @returns 捕まえた要求と、投げる関数
   */
  function recorder(status: number): {
    sent: Request[];
    start: (env: Env, job: OgpCaptureJob) => Promise<void>;
  } {
    const sent: Request[] = [];
    return {
      sent,
      start: createOgpCaptureStart({
        fetch: async (request: Request) => {
          sent.push(request);
          return new Response(null, { status });
        },
      }),
    };
  }

  it('非同期呼び出しとして署名され、URL を 1 本も載せない', async () => {
    const { sent, start } = recorder(202);
    const job: OgpCaptureJob = { gameId: '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f', ogpToken: 'f'.repeat(64) };

    await start(testEnv(), job);

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe(invokeEndpoint('ap-northeast-1', env.OGP_FUNCTION_NAME));
    // **`RequestResponse` に戻ると、撮影の数秒が公開の応答へ帰ってくる。**
    expect(request.headers.get('x-amz-invocation-type')).toBe(ASYNC_INVOCATION_TYPE);
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');

    const body = await request.text();
    expect(JSON.parse(body)).toEqual(job);
    // **撮る先も送り先もペイロードに無い**（差し替えられる者に決めさせない）。
    expect(body).not.toContain('http');
    expect(body).not.toContain(env.SANDBOX_HOST);
    expect(body).not.toContain(env.APP_HOST);
  });

  it('202 以外は失敗として投げる（200 も許さない）', async () => {
    const { start } = recorder(200);
    await expect(
      start(testEnv(), { gameId: '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f', ogpToken: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(OgpInvokeFailed);
  });

  it('不足している設定の名前を返す', () => {
    expect(missingOgpSecrets(env)).toContain('BUILD_AWS_REGION');
    expect(missingOgpSecrets(testEnv())).toEqual([]);
  });
});
