import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROBOTS_TAG_HEADER, ROBOTS_TAG_NOINDEX } from '../src/robots.js';
import { dispatch } from '../src/routes.js';
import { createPublishRoutes } from '../src/publish.js';
import { PUBLISH_GAME_ID_FIELD, PUBLISH_PATH } from '../src/paths.js';
import {
  claimGenerationJob,
  completeGame,
  createJobToken,
  createPendingGame,
  hashJobToken,
  publishGame,
  unpublishGame,
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
import { deleteGame } from '../src/game-deletion.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workPageRoutes, workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';
import { markGameRemoved } from './helpers/removed-work.js';

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

/**
 * その作品の紹介用の画像として R2 に在るオブジェクトの鍵を並べる（#640）。
 *
 * **鍵は撮影ごとに変わる**（`newOgpObjectKey`）ので、テストは鍵を組み立てずに接頭辞で数える。
 * **「1 枚だけ在る」ことを見られる**のが要点で、古い画像が残っていれば 2 枚になる。
 *
 * @param id 作品 id
 * @returns 鍵の並び
 */
async function listOgpObjects(id: string): Promise<string[]> {
  const listed = await env.BUCKET.list({ prefix: `ogp/${id}` });
  return listed.objects.map((object) => object.key);
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
    // **鍵は撮影ごとに違う**（#640）。組み立てて比べず、形と、R2 に 1 枚だけ在ることを見る。
    expect(row.ogp_key).toMatch(new RegExp(`^ogp/${id}/[0-9a-f-]{36}\\.png$`, 'u'));
    expect(await listOgpObjects(id)).toEqual([row.ogp_key]);

    const object = await env.BUCKET.get(row.ogp_key!);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);
    expect(object!.httpMetadata?.contentType).toBe('image/png');
  });

  it('撮り直すと前の画像は消える（在るのは行が指す 1 枚だけ。#640）', async () => {
    // **鍵が撮影ごとに変わるので、消さないと撮り直すたびに 1 枚ずつ増える。**
    const { userId, id, ogpToken } = await seedPublishedGame('recapture-cleanup');
    expect((await sendCallback(id, ogpToken, PNG_BYTES)).status).toBe(200);
    const first = (await readOgp(id)).ogp_key!;

    // 公開をやめて公開し直すと `ogp_state` が NULL へ戻り、次の撮影を掴める（#637 / 確定35）。
    expect(await unpublishGame(env, id, userId)).toEqual({ ok: true, firstTime: true });
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    const nextToken = createJobToken();
    expect(await claimOgpCapture(env, id, await hashJobToken(nextToken))).toBe(true);
    const fresh = new Uint8Array(PNG_BYTES);
    fresh[fresh.length - 1] = 0x21;
    expect((await sendCallback(id, nextToken, fresh)).status).toBe(200);

    const second = (await readOgp(id)).ogp_key!;
    expect(second).not.toBe(first);
    // **前の画像は消えている。**
    expect(await env.BUCKET.head(first)).toBeNull();
    expect(await listOgpObjects(id)).toEqual([second]);
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
    expect(await listOgpObjects(id)).toEqual([]);
  });

  it('トークンが違う要求は、既にある画像を上書きできない', async () => {
    // **照合を R2 への書き込みより後ろに置かない。** 断れる要求に R2 を 1 回書かせない
    // （#640 で鍵が撮影ごとに分かれたので上書きは起こらないが、書かせないこと自体を保つ）。
    const { id, ogpToken } = await seedPublishedGame('callback-no-overwrite');
    await sendCallback(id, ogpToken, PNG_BYTES);
    const key = (await readOgp(id)).ogp_key!;

    const forged = new Uint8Array(PNG_BYTES);
    forged[forged.length - 1] = 0x00;
    const response = await sendCallback(id, createJobToken(), forged);

    expect(response.status).toBe(404);
    const object = await env.BUCKET.get(key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);
    // **偽の要求は 1 バイトも書いていない**（在るのは正当な 1 枚だけ）。
    expect(await listOgpObjects(id)).toEqual([key]);
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
    expect(await listOgpObjects(id)).toEqual([]);
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
    expect(await listOgpObjects(id)).toEqual([]);
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
    // **索引に載せない**（#594）。共有時にカードとして描かれるための画像で、画像検索に
    // 単独で並ぶ理由が無い。**取得そのものは許す**——OGP クローラが読めないとカードが
    // 描かれない（仕様 5.4。`src/robots.ts`）。
    expect(response.headers.get(ROBOTS_TAG_HEADER)).toBe(ROBOTS_TAG_NOINDEX);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('未公開の作品の画像は 404（画像も公開の対象である）', async () => {
    const { id, ogpToken } = await seedPublishedGame('serve-unpublished');
    await sendCallback(id, ogpToken, PNG_BYTES);
    // 撮影済みのまま draft へ戻す（通常は起こらないが、条件が 1 つでないことを確かめる）。
    await env.DB.prepare("update games set status = 'draft' where id = ?").bind(id).run();

    expect((await fetchImage(id)).status).toBe(404);
  });

  it('404 にも X-Robots-Tag が付く（この経路の応答で付いたり付かなかったりしない。#610）', async () => {
    // **実害の解消ではなく、誤読の防止である。** 404 が索引に載ることは無いが、
    // 同じ経路で付いたり付かなかったりすると、文書が誤って書かれる
    // （PR #604 で「全応答に乗る」と書いてしまい、本番の実測で直した）。
    //
    // **3 つの経路をすべて見る。** 綴りの誤り・存在しない id・撮れていない作品で、
    // `notFound()` へ入る道が違う。
    const { id } = await seedPublishedGame('robots-tag-404');
    const malformed = await dispatch(ogpRoutes, new Request(`${APP_ORIGIN}/ogp/not-a-uuid.png`), testEnv());
    const missing = await fetchImage('00000000-0000-4000-8000-000000000000');
    const notCaptured = await fetchImage(id);
    for (const [label, response] of [
      ['綴りの誤り', malformed],
      ['存在しない id', missing],
      ['撮れていない作品', notCaptured],
    ] as const) {
      expect(response.status, label).toBe(404);
      expect(response.headers.get(ROBOTS_TAG_HEADER), label).toBe(ROBOTS_TAG_NOINDEX);
    }
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
    await env.BUCKET.delete((await readOgp(id)).ogp_key!);
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

describe('撮影のコールバックと作品の削除の競合（#516 / PR #523 のレビュー）', () => {
  /**
   * 撮影の照合（`readPendingCapture` の読み取り）が終わった直後に、1 度だけ出来事を差し込む `Env`。
   *
   * **照合と R2 の書き込みのあいだに削除が走る**順序を、決定的に作るために使う。
   *
   * @param between 差し込む出来事
   * @returns 差し替えた `DB` を持つ `Env`
   */
  function afterPendingCheck(between: () => Promise<void>): Env {
    let fired = false;
    const base = testEnv();
    const db = new Proxy(base.DB, {
      get(target, property, receiver) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
        return (sql: string): D1PreparedStatement => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('select ogp_token_hash')) return statement;
          return new Proxy(statement, {
            get(inner, key, innerReceiver) {
              const value = Reflect.get(inner, key, innerReceiver) as unknown;
              if (typeof value !== 'function') return value;
              return (...args: unknown[]): unknown => {
                const result = (value as (...a: unknown[]) => unknown).apply(inner, args);
                if (key === 'bind') {
                  const bound = result as D1PreparedStatement;
                  return new Proxy(bound, {
                    get(b, k, r) {
                      const v = Reflect.get(b, k, r) as unknown;
                      if (typeof v !== 'function') return v;
                      return async (...a: unknown[]): Promise<unknown> => {
                        const resolved = await (v as (...x: unknown[]) => Promise<unknown>).apply(b, a);
                        if (k === 'first' && !fired) {
                          fired = true;
                          await between();
                        }
                        return resolved;
                      };
                    },
                  });
                }
                return result;
              };
            },
          });
        };
      },
    });
    return { ...base, DB: db } as Env;
  }

  /**
   * 撮影の結果（PNG）を、差し替えた `Env` で送る。
   *
   * @param target 送り先の `Env`
   * @param gameId 作品 id
   * @param token 撮影のトークン
   * @returns レスポンス
   */
  async function sendPng(target: Env, gameId: string, token: string): Promise<Response> {
    return await dispatch(
      ogpRoutes,
      new Request(`${APP_ORIGIN}${OGP_CALLBACK_PATH}`, {
        method: 'POST',
        headers: {
          [OGP_GAME_ID_HEADER]: gameId,
          [OGP_TOKEN_HEADER]: token,
          'content-type': 'image/png',
        },
        body: PNG_BYTES,
      }),
      target,
    );
  }

  it('削除が掴んで確定した後に届いた画像は、R2 に残らない（行ごと消えた場合）', async () => {
    const { userId, id, ogpToken } = await seedPublishedGame('race-deleted');
    await markGameRemoved(id);

    const raced = afterPendingCheck(async () => {
      expect(await deleteGame(env, id)).toEqual({ ok: true, result: 'deleted' });
    });
    expect((await sendPng(raced, id, ogpToken)).status).toBe(404);

    expect(await listOgpObjects(id)).toEqual([]);
  });

  it('削除が掴んだ後に届いた画像は、R2 に残らない（行を残して中身を消した場合）', async () => {
    const { userId, id, ogpToken } = await seedPublishedGame('race-purged');
    // 子がいるので行は残る（中身を消した tombstone）。
    const child = await seedReadyGame('race-purged-child');
    await env.DB.prepare('update games set parent_id = ? where id = ?').bind(id, child.id).run();
    await markGameRemoved(id);

    const raced = afterPendingCheck(async () => {
      expect(await deleteGame(env, id)).toEqual({ ok: true, result: 'purged' });
    });
    expect((await sendPng(raced, id, ogpToken)).status).toBe(404);

    expect(await listOgpObjects(id)).toEqual([]);
  });

  it('重複配信では、負けた側が自分の分だけ消す（行が指す画像は残る）', async () => {
    const { id, ogpToken } = await seedPublishedGame('race-duplicate');
    // 照合の直後に、同じトークンのもう 1 通が先に完成させる。
    const raced = afterPendingCheck(async () => {
      expect((await sendCallback(id, ogpToken, PNG_BYTES)).status).toBe(200);
    });
    expect((await sendPng(raced, id, ogpToken)).status).toBe(404);

    // **鍵は 1 通ごとに違う**（#640）ので、負けた側は自分の分を消せる。**在るのは行が指す 1 枚だけ。**
    const key = (await readOgp(id)).ogp_key!;
    expect(await env.BUCKET.head(key)).not.toBeNull();
    expect(await listOgpObjects(id)).toEqual([key]);
    expect((await readOgp(id)).ogp_state).toBe('ready');
  });

  it('照合の後に公開をやめて撮り直しても、遅れて届いた古い画像が新しい画像を塗り替えない（#640）', async () => {
    // **#637 で作者が公開をやめて公開し直せるようになり、この往復が数秒で起きるようになった。**
    // 鍵が作品ごとに 1 つだった頃は、遅れて着いた `put` が新しい画像を古い中身で上書きしえた。
    const { userId, id, ogpToken } = await seedPublishedGame('race-unpublish');
    const fresh = new Uint8Array(PNG_BYTES);
    fresh[fresh.length - 1] = 0x7f;

    const raced = afterPendingCheck(async () => {
      // 公開をやめる → `ogp_state` が NULL に戻る（#637 / 確定35）
      expect(await unpublishGame(env, id, userId)).toEqual({ ok: true, firstTime: true });
      expect((await publishGame(env, id, userId)).ok).toBe(true);
      // 公開し直して、新しい撮影が完成するところまで進める。
      const nextToken = createJobToken();
      expect(await claimOgpCapture(env, id, await hashJobToken(nextToken))).toBe(true);
      expect((await sendCallback(id, nextToken, fresh)).status).toBe(200);
    });

    // ここで古い（照合を通っていた）コールバックの書き込みが着く。
    expect((await sendPng(raced, id, ogpToken)).status).toBe(404);

    const key = (await readOgp(id)).ogp_key!;
    const object = await env.BUCKET.get(key);
    // **新しい撮影の中身のままである。**
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(fresh);
    // **古い側は自分の分を消したので、残るのは 1 枚だけ。**
    expect(await listOgpObjects(id)).toEqual([key]);
  });
});
