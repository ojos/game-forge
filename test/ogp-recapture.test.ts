import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import { createPublishRoutes } from '../src/publish.js';
import {
  OGP_RECAPTURE_GAME_ID_FIELD,
  OGP_RECAPTURE_PATH,
  PUBLISH_GAME_ID_FIELD,
  PUBLISH_PATH,
} from '../src/paths.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
} from '../src/games.js';
import {
  OGP_CALLBACK_PATH,
  OGP_GAME_ID_HEADER,
  OGP_STALE_AFTER_SECONDS,
  OGP_TOKEN_HEADER,
  listStaleOgpCaptures,
  ogpCaptureIsStale,
  ogpRoutes,
  startOgpCapture,
  startOgpRecapture,
} from '../src/ogp.js';
import { createOgpRecaptureRoutes } from '../src/ogp-recapture.js';
import type { OgpCaptureJob } from '../src/ogp-client.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workPageRoutes, workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-recapture-endpoint';

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
  const id = `recap-user-${suffix}`;
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
 * 公開まで済ませ、撮影中（`capturing`）の作品を 1 件用意する。
 *
 * **公開の経路をそのまま通す。** 行を手で作ると、この issue が守ろうとしている
 * 「公開の関門を壊していない」ことを、壊れた土台の上で確かめることになる。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作者の id・作品 id・1 通目の撮影トークン
 */
async function seedCapturingGame(
  suffix: string,
): Promise<{ userId: string; id: string; ogpToken: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: `ゴリラ${suffix}` });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());

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
      body: new URLSearchParams({ [PUBLISH_GAME_ID_FIELD]: pending.id }).toString(),
    }),
    testEnv(),
  );
  expect(response.status).toBe(303);
  expect(jobs).toHaveLength(1);
  return { userId, id: pending.id, ogpToken: jobs[0]!.ogpToken };
}

/**
 * 撮影を始めた時刻を過去へ動かす（時間切れを再現する）。
 *
 * **時計を進める代わりに行を古くする。** 撮影が 15 分かかるのを待てないので、
 * 「いつ撮り始めたか」のほうを動かす。
 *
 * **境界を見る検査では `now` を渡し、判定側と同じ時計を使うこと**（#260）。
 * 既定のまま呼ぶと、ここが引いた「いま」と判定側の「いま」が別の瞬間になり、
 * **その間に壁時計が 1 秒またぐと境界ちょうどの行が「以上」に該当する。**
 * 実際に CI をランダムに赤くしていた（コードを 1 バイトも触っていない差分の
 * ゲートまで落ちた）。**閾値ちょうど・閾値の 1 秒手前を置く呼び出しでは、
 * 既定に頼らない。**
 *
 * 判定が HTTP の経路の中で走る検査（作品ページの描画・撮り直しの POST）には
 * 時計を渡す口が無い。そちらは {@link WELL_INSIDE_WINDOW_SECONDS} を使い、
 * **1 秒のずれでは跨げない位置**へ置く。
 *
 * @param id 作品 id
 * @param secondsAgo 何秒前に始めたことにするか
 * @param now 現在時刻（UNIX 秒）。判定側と共有する時計
 * @returns 実際に使った時計（呼び出し側が判定へ渡せるようにする）
 */
async function ageCapture(
  id: string,
  secondsAgo: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  await env.DB.prepare('update games set ogp_started_at = ? where id = ?')
    .bind(now - secondsAgo, id)
    .run();
  return now;
}

/**
 * 「まだ期限切れではない」と確実に言える古さ（秒）。
 *
 * **`OGP_STALE_AFTER_SECONDS - 1` を使わない。** 1 秒手前に置くと、判定までに
 * 壁時計が 1 秒進んだだけで閾値に達する（#260）。**時計を渡せる検査は境界
 * そのものを見るので、渡せない検査まで境界に置く必要は無い。**
 *
 * 60 秒にしたのは、遅い CI でも 1 つの `it` がここまで掛からないためである。
 */
const WELL_INSIDE_WINDOW_SECONDS = OGP_STALE_AFTER_SECONDS - 60;

/**
 * `games` の撮影まわりを読む。
 *
 * @param id 作品 id
 * @returns 撮影の状態・鍵・トークンのハッシュ・撮り始めた時刻
 */
async function readOgp(id: string): Promise<{
  ogp_state: string | null;
  ogp_key: string | null;
  ogp_token_hash: string | null;
  ogp_started_at: number | null;
}> {
  const row = await env.DB.prepare(
    'select ogp_state, ogp_key, ogp_token_hash, ogp_started_at from games where id = ?',
  )
    .bind(id)
    .first<{
      ogp_state: string | null;
      ogp_key: string | null;
      ogp_token_hash: string | null;
      ogp_started_at: number | null;
    }>();
  if (row === null) {
    throw new Error(`作品が見つかりません: ${id}`);
  }
  return row;
}

/**
 * 撮り直しの口を叩く。
 *
 * @param gameId 対象の作品 id
 * @param cookie セッション cookie（未ログインなら null）
 * @param jobs 撮影の呼び出しを記録する配列
 * @param options 応答の形と、投げる段の差し替え
 * @returns レスポンス
 */
async function postRecapture(
  gameId: string,
  cookie: string | null,
  jobs: OgpCaptureJob[],
  options: { asHtml?: boolean; throwOnStart?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.asHtml !== false) {
    headers['accept'] = 'text/html';
  }
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    createOgpRecaptureRoutes(async (_env, job) => {
      if (options.throwOnStart === true) {
        throw new Error('boom');
      }
      jobs.push(job);
    }),
    new Request(`${APP_ORIGIN}${OGP_RECAPTURE_PATH}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ [OGP_RECAPTURE_GAME_ID_FIELD]: gameId }).toString(),
    }),
    testEnv(),
  );
}

/**
 * 撮影の結果を送る。
 *
 * @param gameId 作品 id
 * @param token 撮影のトークン
 * @returns レスポンス
 */
async function sendCallback(gameId: string, token: string): Promise<Response> {
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
    testEnv(),
  );
}

/**
 * 作品ページの本文を読む。
 *
 * @param gameId 作品 id
 * @param cookie セッション cookie（未ログインなら null）
 * @returns HTML
 */
async function workPage(gameId: string, cookie: string | null): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  const response = await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${workPagePath(gameId)}`, { headers }),
    testEnv(),
  );
  return await response.text();
}

beforeAll(async () => {
  await applySchema();
});

describe('中断したままの撮影を検出する（#235 の acceptance 1）', () => {
  it('閾値を超えた行だけが挙がる（境界は「以上」）', async () => {
    const fresh = await seedCapturingGame('detect-fresh');
    const stale = await seedCapturingGame('detect-stale');

    // **1 秒足りない行は挙がらない。** 走っている撮影を掴み直さないための境界である。
    //
    // **3 つの呼び出しで 1 つの時計を共有する**（#260）。別々に `Date.now()` を
    // 引くと、その間に秒が繰り上がったときに 899 秒前の行が 900 秒前になり、
    // **この検査だけがランダムに落ちる。**
    const now = Math.floor(Date.now() / 1000);
    await ageCapture(fresh.id, OGP_STALE_AFTER_SECONDS - 1, now);
    await ageCapture(stale.id, OGP_STALE_AFTER_SECONDS, now);

    const ids = (await listStaleOgpCaptures(env, now)).map((row) => row.gameId);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it('画面の判定（ogpCaptureIsStale）と一覧が一致する', async () => {
    // **SQL と TS に同じ定義が 2 つある**（`OGP_CAPTURE_SINCE_SQL` と
    // `ogpCaptureIsStale`）。片方だけを直すと「検出できるのに掴めない」行が生まれる
    // ので、**両者が同じ答えを出すことを機械で見る。**
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      OGP_STALE_AFTER_SECONDS - 1,
      OGP_STALE_AFTER_SECONDS,
      OGP_STALE_AFTER_SECONDS + 1,
    ];
    const seeded: { id: string; startedAt: number }[] = [];
    for (const age of cases) {
      const game = await seedCapturingGame(`agree-${age}`);
      // **`seeded` に積む値と DB に入る値を同じ時計から作る**（#260）。
      await ageCapture(game.id, age, now);
      seeded.push({ id: game.id, startedAt: now - age });
    }

    const listed = new Set((await listStaleOgpCaptures(env, now)).map((row) => row.gameId));
    for (const row of seeded) {
      expect(
        ogpCaptureIsStale({ state: 'capturing', startedAt: row.startedAt, publishedAt: null }, now),
        `${row.id}（${now - row.startedAt} 秒前）`,
      ).toBe(listed.has(row.id));
    }
  });

  it('ogp_started_at が無い行（0012 より前）も published_at で拾える', async () => {
    // **新しい列を足したら、既存の行がその経路を通っていないことを疑う**
    // （#202 / #203 の形）。NULL のまま検出から漏れると、いちばん回収したい行が見えない。
    const { id } = await seedCapturingGame('legacy-null');
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'update games set ogp_started_at = null, published_at = ? where id = ?',
    )
      .bind(now - OGP_STALE_AFTER_SECONDS - 60, id)
      .run();

    const ids = (await listStaleOgpCaptures(env, now)).map((row) => row.gameId);
    expect(ids).toContain(id);
  });

  it('ready の行は、いくら古くても挙がらない', async () => {
    const { id, ogpToken } = await seedCapturingGame('detect-ready');
    expect((await sendCallback(id, ogpToken)).status).toBe(200);
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 10);

    const ids = (await listStaleOgpCaptures(env)).map((row) => row.gameId);
    expect(ids).not.toContain(id);
    expect(
      ogpCaptureIsStale({ state: 'ready', startedAt: 0, publishedAt: 0 }, Math.floor(Date.now() / 1000)),
    ).toBe(false);
  });
});

describe('二度撮りの関門を壊していない（#235 の acceptance 3）', () => {
  it('公開の経路は、期限切れの行でも掴まない', async () => {
    // **`claimOgpCapture` の `ogp_state is null` は 1 文字も緩めていない。**
    // 撮り直しは互いに排他な別の UPDATE が通す。
    const { id } = await seedCapturingGame('gate-publish');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);

    const calls: OgpCaptureJob[] = [];
    const outcome = await startOgpCapture(testEnv(), id, async (_env, job) => {
      calls.push(job);
    });
    expect(outcome).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('撮り直しても、同時に走る撮影は 1 つである（古いトークンは無効になる）', async () => {
    const { userId, id, ogpToken } = await seedCapturingGame('gate-token');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS);

    const jobs: OgpCaptureJob[] = [];
    expect((await postRecapture(id, await sessionCookie(userId), jobs)).status).toBe(303);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ogpToken).not.toBe(ogpToken);

    // 遅れて届いた 1 通目は弾かれる（R2 も書かれない）。
    expect((await sendCallback(id, ogpToken)).status).toBe(404);
    expect((await readOgp(id)).ogp_state).toBe('capturing');

    // 2 通目（掴み直したトークン）は通る。
    expect((await sendCallback(id, jobs[0]!.ogpToken)).status).toBe(200);
    expect((await readOgp(id)).ogp_state).toBe('ready');
  });

  it('連打しても、実際に走るのは閾値に 1 回だけ', async () => {
    // 掴み直すと `ogp_started_at` が現在時刻へ動く。**費用の上限はこの SQL が決める。**
    const { userId, id } = await seedCapturingGame('gate-repeat');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS);
    const cookie = await sessionCookie(userId);

    const jobs: OgpCaptureJob[] = [];
    expect((await postRecapture(id, cookie, jobs)).status).toBe(303);
    expect((await postRecapture(id, cookie, jobs)).status).toBe(409);
    expect(jobs).toHaveLength(1);
  });
});

describe('撮り直しの経路（#235 の acceptance 2）', () => {
  it('期限切れの行を撮り直せる（成功すれば ready）', async () => {
    const { userId, id } = await seedCapturingGame('recap-ok');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS + 1);
    const before = await readOgp(id);

    const jobs: OgpCaptureJob[] = [];
    const response = await postRecapture(id, await sessionCookie(userId), jobs);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.gameId).toBe(id);

    const after = await readOgp(id);
    // **`capturing` のままである。** 撮り直しは「投げた」までで、撮れたとは言わない。
    expect(after.ogp_state).toBe('capturing');
    expect(after.ogp_token_hash).not.toBe(before.ogp_token_hash);
    expect(after.ogp_started_at).toBeGreaterThan(before.ogp_started_at!);

    expect((await sendCallback(id, jobs[0]!.ogpToken)).status).toBe(200);
    expect((await readOgp(id)).ogp_state).toBe('ready');
  });

  it('投げ込めなければ failed になる（進める手段の無い行を残さない）', async () => {
    const { userId, id } = await seedCapturingGame('recap-invoke-failed');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS);

    const response = await postRecapture(id, await sessionCookie(userId), [], {
      throwOnStart: true,
    });
    expect(response.status).toBe(502);
    expect((await readOgp(id)).ogp_state).toBe('failed');
  });

  it('まだ期限切れでなければ 409（走っている撮影を横から掴まない）', async () => {
    const { userId, id } = await seedCapturingGame('recap-fresh');
    // **判定は POST の経路の中で走るので時計を渡せない**（#260）。境界そのものは
    // 上の「閾値を超えた行だけが挙がる」と「画面の判定と一覧が一致する」が
    // 決定的に見ているので、ここは**跨げない位置**に置く。
    await ageCapture(id, WELL_INSIDE_WINDOW_SECONDS);

    const jobs: OgpCaptureJob[] = [];
    expect((await postRecapture(id, await sessionCookie(userId), jobs)).status).toBe(409);
    expect(jobs).toEqual([]);
    expect((await readOgp(id)).ogp_state).toBe('capturing');
  });

  it('作者でなければ撮り直せない（撮影の呼び出しは 0 回）', async () => {
    const { id } = await seedCapturingGame('recap-other');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);
    const stranger = await seedUser('recap-stranger');

    const jobs: OgpCaptureJob[] = [];
    expect((await postRecapture(id, await sessionCookie(stranger), jobs)).status).toBe(409);
    expect(jobs).toEqual([]);
    expect((await readOgp(id)).ogp_state).toBe('capturing');
  });

  it('未ログインはログインへ送る（JSON なら 401）', async () => {
    const { id } = await seedCapturingGame('recap-anon');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);

    const jobs: OgpCaptureJob[] = [];
    const html = await postRecapture(id, null, jobs);
    expect(html.status).toBe(303);
    const api = await postRecapture(id, null, jobs, { asHtml: false });
    expect(api.status).toBe(401);
    expect(jobs).toEqual([]);
  });

  it('作品 id の形が違えば 400（D1 へ問い合わせない形で落とす）', async () => {
    const jobs: OgpCaptureJob[] = [];
    const userId = await seedUser('recap-badid');
    const response = await dispatch(
      createOgpRecaptureRoutes(async (_env, job) => {
        jobs.push(job);
      }),
      new Request(`${APP_ORIGIN}${OGP_RECAPTURE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
          cookie: await sessionCookie(userId),
        },
        body: new URLSearchParams({ [OGP_RECAPTURE_GAME_ID_FIELD]: '../../etc' }).toString(),
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(jobs).toEqual([]);
  });

  it('設定が無い環境では撮り直さず、状態も触らない', async () => {
    // ローカル開発の通常の状態（`.dev.vars` に `BUILD_AWS_*` が無い）。
    const { userId, id } = await seedCapturingGame('recap-unconfigured');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);
    const before = await readOgp(id);

    const jobs: OgpCaptureJob[] = [];
    const outcome = await startOgpRecapture(env, id, userId, async (_env, job) => {
      jobs.push(job);
    });
    expect(outcome).toBe('skipped');
    expect(jobs).toEqual([]);
    const after = await readOgp(id);
    expect(after.ogp_state).toBe('capturing');
    // **掴んでいないので、時刻もトークンも動かない**（掴んでから諦めると、
    // 900 秒のあいだ本当の撮り直しができなくなる）。
    expect(after.ogp_token_hash).toBe(before.ogp_token_hash);
    expect(after.ogp_started_at).toBe(before.ogp_started_at);
  });
});

describe('作品ページに出る口（#235 の「気づく経路」）', () => {
  it('作者には、中断したときだけフォームが出る', async () => {
    const { userId, id } = await seedCapturingGame('page-owner');
    const cookie = await sessionCookie(userId);

    // まだ走っているうちは出さない（押しても何も起きないボタンを出さない）。
    // **描画の中で判定が走るので時計を渡せない**（#260。上の 409 の検査と同じ）。
    await ageCapture(id, WELL_INSIDE_WINDOW_SECONDS);
    expect(await workPage(id, cookie)).not.toContain(OGP_RECAPTURE_PATH);

    await ageCapture(id, OGP_STALE_AFTER_SECONDS);
    const stalled = await workPage(id, cookie);
    expect(stalled).toContain(OGP_RECAPTURE_PATH);
    expect(stalled).toContain(id);
    // **同じページが「準備中」と「止まったまま」を同時に言わない。**
    expect(stalled).not.toContain('スクリーンショットを準備しています');
    expect(stalled).toContain('スクリーンショットの撮影が止まっています');
  });

  it('作者以外には出さない（未ログインにも）', async () => {
    const { id } = await seedCapturingGame('page-stranger');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);
    const stranger = await seedUser('page-stranger-viewer');

    const anonymous = await workPage(id, null);
    expect(anonymous).not.toContain(OGP_RECAPTURE_PATH);
    expect(await workPage(id, await sessionCookie(stranger))).not.toContain(OGP_RECAPTURE_PATH);
    // **中断を見せても、その人にできることが 1 つも無い。** 文言は従来のままにする。
    expect(anonymous).toContain('スクリーンショットを準備しています');
  });

  it('撮れたら口は消える', async () => {
    const { userId, id, ogpToken } = await seedCapturingGame('page-ready');
    await ageCapture(id, OGP_STALE_AFTER_SECONDS * 2);
    expect((await sendCallback(id, ogpToken)).status).toBe(200);

    expect(await workPage(id, await sessionCookie(userId))).not.toContain(OGP_RECAPTURE_PATH);
  });
});
