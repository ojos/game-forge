import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import {
  GENERATION_IS_SYNCHRONOUS,
  WORK_PAGE_PREFIX,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  failGame,
  hashJobToken,
} from '../src/games.js';
import { defaultPipeline, runJobInline, startGeneration } from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-page-endpoint-1';

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
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `work-user-${suffix}`;
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
 * 作品ページを開く。
 *
 * @param path 開くパス
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function open(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${path}`, { headers }),
    testEnv(),
  );
}

/**
 * 生成中の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param prompt プロンプト（仮タイトルになる）
 * @returns 作者の id、作品 id、ジョブトークン
 */
async function seedPending(
  suffix: string,
  prompt = 'ねこが主人公のパズル',
): Promise<{ userId: string; id: string; jobToken: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt });
  return { userId, id: pending.id, jobToken: pending.jobToken };
}

beforeAll(async () => {
  await applySchema();
});

describe('作品ページの入口（#150）', () => {
  it('id の綴りが違えば 404', async () => {
    // **理由を分けない。** 分けると、任意の id が実在するかを外から確かめられる。
    for (const path of ['/works/', '/works/not-a-uuid', '/works/../etc', '/works/x/y']) {
      expect((await open(path)).status, path).toBe(404);
    }
  });

  it('存在しない作品も 404', async () => {
    const response = await open(workPagePath('9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f'));
    expect(response.status).toBe(404);
  });

  it('パスは work-page が持つ綴りから組み立てられている', () => {
    expect(workPagePath('abc')).toBe(`${WORK_PAGE_PREFIX}abc`);
  });
});

describe('状態は誰でも読め、詳細は本人だけが読める（#150 の決定）', () => {
  it('生成中であることは、ログインしていなくても読める', async () => {
    const { id } = await seedPending('anon-working');
    const response = await open(workPagePath(id));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('生成中です');
    // **#160 で非同期実行になったので「閉じてよい」が正しい。**
    // できていないことを、できているように書かない——そして、できるように
    // なったことを、できていないように書かない。
    //
    // **期待値を実行形態から引く。** ここへどちらか一方を焼き込むと、段を戻したときに
    // このテストだけが古い文言を要求する（照合の正本は `GENERATION_IS_SYNCHRONOUS`
    // であり、それを `startJob` と突き合わせる検査が下にある）。
    if (GENERATION_IS_SYNCHRONOUS) {
      expect(body).toContain('このタブを開いたままにしてください');
      expect(body).not.toContain('タブを閉じても生成は進みます');
    } else {
      expect(body).toContain('タブを閉じても生成は進みます');
      expect(body).not.toContain('このタブを開いたままにしてください');
    }
  });

  it('仮タイトル（プロンプト由来）は本人にしか出さない', async () => {
    const { userId, id } = await seedPending('title', 'ひみつのアイデア');

    const asStranger = await (await open(workPagePath(id))).text();
    expect(asStranger).not.toContain('ひみつのアイデア');

    const asOwner = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(asOwner).toContain('ひみつのアイデア');
  });

  it('別の利用者は仮タイトルを読めない', async () => {
    const { id } = await seedPending('other', 'べつのひとのアイデア');
    const stranger = await seedUser('stranger');
    const body = await (await open(workPagePath(id), await sessionCookie(stranger))).text();
    expect(body).not.toContain('べつのひとのアイデア');
  });

  it('失敗の分類は本人にだけ具体的に出る', async () => {
    const { userId, id, jobToken } = await seedPending('failed-detail');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await failGame(env, id, 'source-rejected');

    const asOwner = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(asOwner).toContain('生成できませんでした');
    expect(asOwner).toContain('許可していない機能');

    const asStranger = await (await open(workPagePath(id))).text();
    expect(asStranger).toContain('生成できませんでした');
    // 何がどう失敗したかは作者の情報である。
    expect(asStranger).not.toContain('許可していない機能');
  });
});

describe('状態ごとの表示（#150）', () => {
  it('生成中は自動更新し、完成後は自動更新しない', async () => {
    const { id, jobToken } = await seedPending('refresh');
    expect(await (await open(workPagePath(id))).text()).toContain('http-equiv="refresh"');

    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome());
    // 完成後に再読み込みを続けても表示は変わらない。D1 の読み取りを増やさない。
    expect(await (await open(workPagePath(id))).text()).not.toContain('http-equiv="refresh"');
  });

  it('完成するとサンドボックス用ホストの試遊 URL が出る', async () => {
    const { id, jobToken } = await seedPending('ready');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome());

    const previewKey = (
      await env.DB.prepare('select preview_key from games where id = ?')
        .bind(id)
        .first<{ preview_key: string }>()
    )?.preview_key;

    const body = await (await open(workPagePath(id))).text();
    expect(body).toContain('できました');
    // **7.2 の別オリジンから配る。** アプリ用ホストで作品を描かない。
    expect(body).toContain(`https://${env.SANDBOX_HOST}/p/${previewKey}/`);
  });

  it('長く止まっている生成は「中断した可能性」を出す', async () => {
    const { id, jobToken } = await seedPending('stalled');
    await claimGenerationJob(env, id, await hashJobToken(jobToken), 1);

    const body = await (await open(workPagePath(id))).text();
    expect(body).toContain('中断した可能性があります');

    // **D1 は書き換えない。** GET が状態を壊せる形にしない。
    const row = await env.DB.prepare('select generation_state from games where id = ?')
      .bind(id)
      .first<{ generation_state: string }>();
    expect(row?.generation_state).toBe('running');
  });
});

describe('#150 の acceptance: 接続を切っても、あとで URL を開けば結果がある', () => {
  /**
   * ジョブを**起動しない**パイプライン。
   *
   * オーケストレータ Lambda へ投げたあと、この Worker が何もしない状態を表す。
   * **利用者がタブを閉じたのと同じ**であり、それでも id と URL は既に存在する。
   *
   * @returns パイプライン
   */
  function dispatchedElsewhere(): GenerationPipeline {
    return {
      ...defaultPipeline,
      checkQuota: async () => ({ allowed: true }),
      // ジョブは別のところで走る。ここでは何もしない。
      startJob: async () => undefined,
    };
  }

  it('送信すると 91 秒待たずに URL が返り、その URL で状態が読める', async () => {
    const userId = await seedUser('acceptance');

    // **LLM を 1 回も呼ばずに id が返る。**
    const started = await startGeneration(
      env,
      userId,
      { prompt: '接続を切っても残る作品' },
      dispatchedElsewhere(),
    );
    expect(started.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );

    // **別のタブ（cookie 無し）で開いても状態が読める。**
    const whileWorking = await open(workPagePath(started.id));
    expect(whileWorking.status).toBe(200);
    expect(await whileWorking.text()).toContain('生成中です');

    // そのあいだにジョブが Worker の外で完走した。
    const row = await env.DB.prepare('select job_token_hash from games where id = ?')
      .bind(started.id)
      .first<{ job_token_hash: string }>();
    await claimGenerationJob(env, started.id, row!.job_token_hash);
    await completeGame(env, started.id, fakeBuildOutcome());

    // **同じ URL を開き直すと結果がある。** 再送も「復帰」も要らない。
    const afterwards = await open(workPagePath(started.id), await sessionCookie(userId));
    expect(afterwards.status).toBe(200);
    const body = await afterwards.text();
    expect(body).toContain('できました');
    expect(body).toContain('接続を切っても残る作品');
  });

  it('生成中の作品はサンドボックス配信から引けない（500 に化けない）', async () => {
    // **#28 の「D1 に行があるのに R2 に実体が無い場合は 500」と衝突させないための
    // 構造そのものを見る。** `preview_key` が無い以上、あの経路は行に到達できない。
    const userId = await seedUser('isolated');
    const started = await startGeneration(
      env,
      userId,
      { prompt: 'まだ成果物が無い作品' },
      dispatchedElsewhere(),
    );

    const row = await env.DB.prepare(
      `select preview_key, status from games where id = ?`,
    )
      .bind(started.id)
      .first<{ preview_key: string | null; status: string }>();

    // `/p/` は `where preview_key = ?` で引く。NULL は 16 進 32 桁と一致しない。
    expect(row?.preview_key).toBeNull();
    // `/g/` は `status = 'published'` だけを返す。
    expect(row?.status).toBe('draft');

    // 配信側の問い合わせをそのまま撃っても、行は 1 件も返らない。
    const byPreview = await env.DB.prepare(
      "select id from games where preview_key = ? and status <> 'removed'",
    )
      .bind('0'.repeat(32))
      .first();
    expect(byPreview).toBeNull();
  });
});

describe('画面の文言が、いまの実行形態と食い違わない（#150）', () => {
  it('GENERATION_IS_SYNCHRONOUS が startJob の既定と一致する', () => {
    // **段を差し替えたら、この検査が文言の更新を要求して落ちる。**
    // オーケストレータ Lambda（別 issue）が `startJob` を非同期実装へ替えたとき、
    // `GENERATION_IS_SYNCHRONOUS` を false にしないと画面が嘘をつく——今度は
    // 「開いたままにしてください」という不要な制約として。
    //
    // import で結ばずにここで結ぶのは、`src/generate.ts` が work-page から
    // `workPagePath` を取っており、逆向きの import が循環参照になるためである。
    expect(defaultPipeline.startJob === runJobInline).toBe(GENERATION_IS_SYNCHRONOUS);
  });

  it('同期実行のあいだは「閉じてよい」と書かない', async () => {
    const { id } = await seedPending('wording');
    const body = await (await open(workPagePath(id))).text();

    if (GENERATION_IS_SYNCHRONOUS) {
      expect(body).toContain('いま閉じると生成は中断します');
      // 恒久的な URL であること自体は、いまでも本当なので言ってよい。
      expect(body).toContain('恒久的な URL');
    } else {
      expect(body).toContain('タブを閉じても生成は進みます');
    }
  });
});
