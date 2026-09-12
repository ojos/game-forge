import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/html.js';
import { dispatch } from '../src/routes.js';
import { renderWorkPage } from '../src/work-page.js';
import type { WorkPageView } from '../src/work-page.js';
import {
  FORKS_OFFSET_PARAM,
  FORKS_PER_PAGE,
  GENERATION_IS_SYNCHRONOUS,
  OPERATOR_MARK,
  storedLikeCount,
  WORK_PAGE_PREFIX,
  WORK_REMOVE_GAME_ID_FIELD,
  WORK_REMOVE_PATH,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import {
  claimGenerationJob,
  completeGame,
  createForkedGame,
  createPendingGame,
  failGame,
  hashJobToken,
  publishGame,
  removeGame,
} from '../src/games.js';
import {
  LIKE_CANCEL_GAME_ID_FIELD,
  LIKE_CANCEL_PATH,
  LIKE_GAME_ID_FIELD,
  LIKE_PATH,
} from '../src/like-paths.js';
import { changeLike } from '../src/likes.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { defaultPipeline, runJobInline, startGeneration } from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import {
  FORK_PARENT_ID_FIELD,
  FORK_PATH,
  REVISE_PATH,
  RESTORE_PATH,
} from '../src/paths.js';
import {
  DAILY_QUOTA_PER_USER,
  remainingQuotaNotice,
  REVISIONS_PER_GAME,
} from '../src/quota.js';
import { appendRevision, claimRevisionSlot, failRevision } from '../src/revisions.js';
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

  it('完成すると作者にサンドボックス用ホストの試遊 URL が出る', async () => {
    const { userId, id, jobToken } = await seedPending('ready');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome());

    const previewKey = (
      await env.DB.prepare('select preview_key from games where id = ?')
        .bind(id)
        .first<{ preview_key: string }>()
    )?.preview_key;

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('できました');
    // **7.2 の別オリジンから配る。** アプリ用ホストで作品を描かない。
    expect(body).toContain(`https://${env.SANDBOX_HOST}/p/${previewKey}/`);
  });

  it('プレビュー URL は本人にしか出ない（#26）', async () => {
    // `preview_key` は unlisted 配信の唯一の資格情報である（5.4 /
    // migrations/0006_games_preview_key.sql）。**状態は誰でも読めるが、鍵は読めない。**
    // ここが緩いと、公開していない作品が id を知っているだけの相手に遊ばれる。
    const { id, jobToken } = await seedPending('ready-anon');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome());

    const previewKey = (
      await env.DB.prepare('select preview_key from games where id = ?')
        .bind(id)
        .first<{ preview_key: string }>()
    )?.preview_key;
    expect(previewKey).toBeTypeOf('string');

    const body = await (await open(workPagePath(id))).text();
    // 状態は読める。
    expect(body).toContain('できました');
    // 鍵は読めない。
    expect(body).not.toContain(previewKey!);
    expect(body).toContain('まだ公開されていません');
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

describe('推敲の口と版の一覧（5.7 / #193）', () => {
  /**
   * 完成した未公開の作品を 1 件用意し、初回の版まで積む。
   *
   * @param suffix テスト内で一意な接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedReady(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`rev-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-rev-${suffix}` }));
    const row = await env.DB.prepare(
      `select go_version, source_key, wasm_key from games where id = ?`,
    )
      .bind(id)
      .first<{ go_version: string; source_key: string; wasm_key: string }>();
    await appendRevision(
      env,
      id,
      { goVersion: row!.go_version, sourceKey: row!.source_key, wasmKey: row!.wasm_key },
      null,
    );
    return { userId, id };
  }

  it('作者には推敲の口が出る', async () => {
    const { userId, id } = await seedReady('owner');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    expect(body).toContain(REVISE_PATH);
    expect(body).toContain('気になるところを直す');
    // **待ち時間と費用を隠さない**（5.7）。
    expect(body).toContain('生成枠を 1 回使います');
  });

  it('作者以外には推敲の口が出ない', async () => {
    const { id } = await seedReady('not-owner');
    const stranger = await seedUser('rev-stranger');

    for (const cookie of [undefined, await sessionCookie(stranger)]) {
      const body = await (await open(workPagePath(id), cookie)).text();
      expect(body).not.toContain(REVISE_PATH);
      expect(body).not.toContain(RESTORE_PATH);
    }
  });

  it('日次の残枠と、この作品の残り回数が出る', async () => {
    const { userId, id } = await seedReady('remaining');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    // **4.4 の文言を書き写さない。** 正本の組み立て関数と突き合わせる
    // （`src/quota.ts`。あちらが 4.4 の本文と機械照合されている）。
    expect(body).toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
    expect(body).toContain(`あと ${REVISIONS_PER_GAME} 回手直しできます`);
  });

  it('本日の枠が尽きていたらフォームを出さず、残数は出す（4.4）', async () => {
    const { userId, id } = await seedReady('daily-spent');
    // **費用の出る呼び出しを日次の上限まで積む**（確定25 は台帳の行数で数える）。
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            cost_jpy, succeeded, created_at)
         values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 1, 1, ?)`,
      )
        .bind(`gen-daily-${id}-${i}`, userId, DEFAULT_GENERATION_MODEL_KEY, now)
        .run();
    }

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **押せば 429 で断られる操作を、押せる形で出さない**（4.4 の裏返し）。
    expect(body).not.toContain(REVISE_PATH);
    // **残数は出したまま。** 消すと「昨日はあった口が消えた」としか読めない。
    expect(body).toContain('気になるところを直す');
    expect(body).toContain(remainingQuotaNotice(0));
  });

  it('上限に達したら口を出さない', async () => {
    const { userId, id } = await seedReady('exhausted');
    await env.DB.prepare('update games set revise_count = ? where id = ?')
      .bind(REVISIONS_PER_GAME, id)
      .run();

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain(REVISE_PATH);
  });

  it('推敲が走っているあいだは口を出さず、自動更新する', async () => {
    const { userId, id } = await seedReady('running');
    await claimRevisionSlot(env, id, userId, '玉を速く', 'work-page-hash-1');

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **二重送信をボタンの無効化ではなく「フォームが無い」ことで防ぐ**（JS を要求しない）。
    expect(body).not.toContain(REVISE_PATH);
    expect(body).toContain('手直しをしています');
    // **`state` は `ready` のままなので、この検査が無いと画面は止まって見える。**
    expect(body).toContain('http-equiv="refresh"');
  });

  it('失敗した推敲は理由を出し、作品が無事であることを言う', async () => {
    const { userId, id } = await seedReady('failed');
    await claimRevisionSlot(env, id, userId, '玉を速く', 'work-page-hash-2');
    await failRevision(env, id, 'build-failed');

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('前回の手直しはうまくいきませんでした');
    expect(body).toContain('作品はそのまま残っています');
    // 作品は壊れていないので、次の手直しの口はそのまま出ている。
    expect(body).toContain(REVISE_PATH);
  });

  it('版が 2 つ以上あるときだけ一覧を出し、いまの版には戻す口を出さない', async () => {
    const { userId, id } = await seedReady('list');
    const cookie = await sessionCookie(userId);

    // 版が 1 つのうちは、戻す先が現在地しかないので出さない。
    expect(await (await open(workPagePath(id), cookie)).text()).not.toContain(RESTORE_PATH);

    await appendRevision(
      env,
      id,
      { goVersion: 'go1.27.0', sourceKey: 'builds/n/source.go', wasmKey: 'builds/n/game.wasm.br' },
      '玉を速く',
    );
    await env.DB.prepare(
      'update games set source_key = ?, wasm_key = ?, go_version = ? where id = ?',
    )
      .bind('builds/n/source.go', 'builds/n/game.wasm.br', 'go1.27.0', id)
      .run();

    const body = await (await open(workPagePath(id), cookie)).text();
    expect(body).toContain('これまでの版');
    expect(body).toContain(RESTORE_PATH);
    expect(body).toContain('戻すのに生成枠は使いません');
    // `seq = 1` のプロンプトは null（確定27 により版から引けない）。
    expect(body).toContain('最初の生成');
    // いまの版には戻す口を出さない（戻す先が現在地である）。
    expect(body).toContain('（いまの版）');
    expect([...body.matchAll(new RegExp(RESTORE_PATH, 'gu'))]).toHaveLength(1);
  });

  it('版のプロンプトはエスケープされる（UGC 由来）', async () => {
    const { userId, id } = await seedReady('escape');
    await appendRevision(
      env,
      id,
      { goVersion: 'go1.27.0', sourceKey: 'builds/e/source.go', wasmKey: 'builds/e/game.wasm.br' },
      '<script>alert(1)</script>',
    );

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('フォークの口（5.3 / M5-1 / #32）', () => {
  /**
   * 公開済みの作品を 1 件用意する。
   *
   * **フォークの親になれるのは公開済みの作品だけである**（5.3）。作品ページの側でも
   * 同じ条件で口を出す（`src/work-page.ts` の `forkableId`）。
   *
   * @param suffix テスト内で一意な接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`fork-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-fork-${suffix}` }));
    const published = await publishGame(env, id, userId);
    expect(published.ok).toBe(true);
    return { userId, id };
  }

  it('ログイン済みには差分プロンプトの口が出て、親としてこの作品が入る', async () => {
    const { id } = await seedPublished('form');
    const visitor = await seedUser('fork-visitor');

    const body = await (await open(workPagePath(id), await sessionCookie(visitor))).text();

    expect(body).toContain(`action="${FORK_PATH}"`);
    // **親はこの作品である。** 送り先の項目名も綴りを書き写さない（`src/paths.ts`）。
    expect(body).toContain(`<input type="hidden" name="${FORK_PARENT_ID_FIELD}" value="${id}">`);
    expect(body).toContain('どう改造しますか');
    // **待ち時間と費用を隠さない**（5.7 の推敲と同じ扱い。1 回は生成 1 回そのもの）。
    expect(body).toContain('生成枠を 1 回使います');
    expect(body).toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });

  it('作者本人にも出る（5.7「公開後に手を入れたい作者はフォークする」）', async () => {
    const { userId, id } = await seedPublished('self');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain(`action="${FORK_PATH}"`);
  });

  it('未ログインには待機リストの導線のまま（10.2 の唯一の送り手を壊さない）', async () => {
    const { id } = await seedPublished('anon');
    const body = await (await open(workPagePath(id))).text();

    // **この綴りが 10.2 の分子である**（`src/waitlist.ts` の受け皿と対になっている）。
    expect(body).toContain('href="/signup?from=fork-cta"');
    expect(body).toContain('改造には招待が必要です');
    // 押しても 401 になる口を、未ログインの人へ出さない。
    expect(body).not.toContain(FORK_PATH);
  });

  it('未公開の作品には口が出ない（親になれるのは公開済みだけ）', async () => {
    const { userId, id, jobToken } = await seedPending('fork-draft');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: 'sha-fork-draft' }));
    const visitor = await seedUser('fork-draft-visitor');

    for (const cookie of [await sessionCookie(userId), await sessionCookie(visitor)]) {
      const body = await (await open(workPagePath(id), cookie)).text();
      expect(body).not.toContain(FORK_PATH);
    }
  });

  it('本日の枠が尽きていたらフォームを出さず、見出しと残数は出す（4.4 / 3.4-5）', async () => {
    const { id } = await seedPublished('daily-spent');
    const visitor = await seedUser('fork-spent-visitor');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            cost_jpy, succeeded, created_at)
         values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 1, 1, ?)`,
      )
        .bind(`gen-fork-daily-${i}`, visitor, DEFAULT_GENERATION_MODEL_KEY, now)
        .run();
    }

    const body = await (await open(workPagePath(id), await sessionCookie(visitor))).text();

    // **押せば 429 で断られる操作を、押せる形で出さない**（4.4 の裏返し）。
    expect(body).not.toContain(FORK_PATH);
    // **3.4-5 の 4 要素は 1 つも条件付きにしない。** 見出しと残数は残る。
    expect(body).toContain('このゲームを改造する');
    expect(body).toContain(remainingQuotaNotice(0));
  });
});

describe('系統の近傍表示（5.5 / M5-3 / #34）', () => {
  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedPublishedWork(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`lin-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-lin-${suffix}` }));
    const published = await publishGame(env, id, userId);
    expect(published.ok).toBe(true);
    return { userId, id };
  }

  /**
   * 子の `games` 行を直接 1 件入れる。
   *
   * **生成の経路を通さない。** ここで確かめたいのは画面の引き方と並べ方であって、
   * 行の作られ方ではない（`test/games.test.ts` が経路側を見ている）。`status` と
   * `published_at` を自由に置けるほうが、除外と並び順を少ない行数で網羅できる。
   *
   * @param authorId 作者
   * @param parentId 親の作品 id
   * @param overrides 列の指定
   * @returns 作った作品の id
   */
  async function seedChild(
    authorId: string,
    parentId: string,
    overrides: { readonly status?: string; readonly title?: string; readonly publishedAt?: number } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games
         (id, author_id, parent_id, status, title, go_version, fork_count,
          created_at, published_at, generation_state)
       values (?, ?, ?, ?, ?, '', 0, 1, ?, 'ready')`,
    )
      .bind(
        id,
        authorId,
        parentId,
        overrides.status ?? 'published',
        overrides.title ?? '改造された作品',
        overrides.publishedAt ?? 1000,
      )
      .run();
    return id;
  }

  it('公開済みの作品に「このゲームからの改造: N 件」と子へのリンクが出る', async () => {
    const { id } = await seedPublishedWork('list');
    const forker = await seedUser('lin-list-forker');
    const older = await seedChild(forker, id, { title: '古い改造', publishedAt: 100 });
    const newer = await seedChild(forker, id, { title: '新しい改造', publishedAt: 200 });

    const body = await (await open(workPagePath(id))).text();

    expect(body).toContain('このゲームからの改造: 2 件');
    expect(body).toContain(`<a href="${workPagePath(newer)}">新しい改造</a>`);
    expect(body).toContain(`<a href="${workPagePath(older)}">古い改造</a>`);
    // **新しい順である**（5.5）。
    expect(body.indexOf('新しい改造')).toBeLessThan(body.indexOf('古い改造'));
  });

  it('draft の子は一覧にも件数にも出ない（#34 の acceptance）', async () => {
    const { id } = await seedPublishedWork('draft-child');
    const forker = await seedUser('lin-draft-forker');
    await seedChild(forker, id, { status: 'draft', title: '未公開の改造' });
    await seedChild(forker, id, { status: 'removed', title: '取り下げた改造' });
    const shown = await seedChild(forker, id, { title: '公開された改造' });

    const body = await (await open(workPagePath(id))).text();

    expect(body).toContain('このゲームからの改造: 1 件');
    expect(body).toContain(`<a href="${workPagePath(shown)}">公開された改造</a>`);
    // **題名はプロンプト由来である。** 出せば 5.4 の「公開して初めて有効になる」の
    // 抜け道になる。
    expect(body).not.toContain('未公開の改造');
    expect(body).not.toContain('取り下げた改造');
  });

  it('21 件目は「もっと見る」で取れる（20 件＋もっと見る）', async () => {
    const { id } = await seedPublishedWork('paging');
    const forker = await seedUser('lin-paging-forker');
    const children: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      children.push(await seedChild(forker, id, { title: `改造 ${i}`, publishedAt: 1000 + i }));
    }
    const newestFirst = [...children].reverse();

    const first = await (await open(workPagePath(id))).text();
    expect(first).toContain('このゲームからの改造: 21 件');
    // 20 件だけ出て、21 件目（＝いちばん古い 1 件）は出ていない。
    expect(first).toContain(`<a href="${workPagePath(newestFirst[19]!)}">改造 1</a>`);
    expect(first).not.toContain(`<a href="${workPagePath(newestFirst[20]!)}">改造 0</a>`);

    const morePath = `${workPagePath(id)}?${FORKS_OFFSET_PARAM}=${FORKS_PER_PAGE}`;
    expect(first).toContain(`<a href="${morePath}">もっと見る</a>`);

    // **画面に出ているリンクをそのまま辿る**（テストが URL を組み立て直すと、
    // 画面の綴りが変わっても緑のままになる）。
    const second = await (await open(morePath)).text();
    expect(second).toContain(`<a href="${workPagePath(newestFirst[20]!)}">改造 0</a>`);
    // 2 頁目には次が無いので「もっと見る」は出ない。
    expect(second).not.toContain('もっと見る');
    // 戻る道はある。
    expect(second).toContain(`<a href="${workPagePath(id)}">前へ</a>`);
  });

  it('改造が 1 件も無ければ 0 件と言い、一覧は出さない', async () => {
    const { id } = await seedPublishedWork('empty');
    const body = await (await open(workPagePath(id))).text();
    // **見出しを消さない。**「まだ誰も改造していない」と「機能が無い」を区別できる形にする。
    expect(body).toContain('このゲームからの改造: 0 件');
    expect(body).not.toContain('<ul class="gf-fork-list">');
    expect(body).not.toContain('もっと見る');
  });

  it('壊れた forks の値で 500 にしない（1 頁目に倒す）', async () => {
    // **問い合わせ文字列は誰でも書ける。** 例外にすると、拡散の着地点を 1 つの
    // クエリで落とせることになる。
    const { id } = await seedPublishedWork('bad-offset');
    const forker = await seedUser('lin-bad-offset-forker');
    await seedChild(forker, id, { title: 'ある改造' });

    for (const raw of ['-1', '1.5', 'abc', '', '9007199254740993']) {
      const response = await open(`${workPagePath(id)}?${FORKS_OFFSET_PARAM}=${raw}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('ある改造');
    }
  });

  it('範囲の外を指す forks は 1 頁目へ倒す（控えた URL が空の頁にならない）', async () => {
    // **`?forks=20` を控えたあとに改造が取り下げられれば、総数は減る。** 同じ URL が
    // 空の頁になり、戻る道が URL の手編集しか無くなる形にしない。
    const { id } = await seedPublishedWork('out-of-range');
    const forker = await seedUser('lin-out-of-range-forker');
    await seedChild(forker, id, { title: '唯一の改造' });

    const body = await (
      await open(`${workPagePath(id)}?${FORKS_OFFSET_PARAM}=${FORKS_PER_PAGE}`)
    ).text();

    expect(body).toContain('このゲームからの改造: 1 件');
    expect(body).toContain('唯一の改造');
    // 1 頁目なので「前へ」も「もっと見る」も出ない。
    expect(body).not.toContain('前へ');
    expect(body).not.toContain('もっと見る');
  });

  it('子の題名を escape する（UGC 由来）', async () => {
    const { id } = await seedPublishedWork('escape-child');
    const forker = await seedUser('lin-escape-forker');
    await seedChild(forker, id, { title: '<script>alert(1)</script>' });

    const body = await (await open(workPagePath(id))).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('未公開の作品ページには系統の一覧を出さない', async () => {
    // 公開済みの作品しかフォークの親になれない（5.3）ので、未公開の行に公開済みの
    // 子は現れない。**引きに行かないことを画面の側でも固定する**（3.6 の読み取りが
    // そのまま費用になる）。
    const { userId, id, jobToken } = await seedPending('lin-unpublished');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: 'sha-lin-unpublished' }));

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('このゲームからの改造');
  });
});

describe('親の tombstone 化（5.3 / M5-4 / #35）', () => {
  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞
   * @param parentId 親の作品 id（オリジナルなら省略）
   * @returns 作者の id と作品 id
   */
  async function seedPublishedWork(
    suffix: string,
    parentId?: string,
  ): Promise<{ userId: string; id: string }> {
    const userId = await seedUser(`rm-${suffix}`);
    const pending =
      parentId === undefined
        ? await createPendingGame(env, userId, { prompt: `作品 ${suffix}` })
        : await createForkedGame(env, userId, { prompt: `改造 ${suffix}` }, parentId);
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
    await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-rm-${suffix}` }));
    expect((await publishGame(env, pending.id, userId)).ok).toBe(true);
    return { userId, id: pending.id };
  }

  /**
   * 取り下げの経路を、素の HTML フォームと同じ形で叩く。
   *
   * @param gameId 取り下げる作品 id
   * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
   * @returns レスポンス
   */
  async function postRemove(gameId: string, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    };
    if (cookie !== undefined) {
      headers['cookie'] = cookie;
    }
    return await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${WORK_REMOVE_PATH}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ [WORK_REMOVE_GAME_ID_FIELD]: gameId }).toString(),
      }),
      testEnv(),
    );
  }

  it('作者にだけ取り下げの口が出る', async () => {
    const { userId, id } = await seedPublishedWork('cta');
    const stranger = await seedUser('rm-cta-stranger');

    const mine = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(mine).toContain(`action="${WORK_REMOVE_PATH}"`);
    expect(mine).toContain(`<input type="hidden" name="${WORK_REMOVE_GAME_ID_FIELD}" value="${id}">`);
    // **連鎖しないことを押す前に書く**（5.3「連鎖削除は荒れるため採らない」）。
    expect(mine).toContain('そのまま公開されたままです');

    // 押しても 404 になる口を、他人へ出さない。
    const theirs = await (await open(workPagePath(id), await sessionCookie(stranger))).text();
    expect(theirs).not.toContain(WORK_REMOVE_PATH);
    const anon = await (await open(workPagePath(id))).text();
    expect(anon).not.toContain(WORK_REMOVE_PATH);
  });

  it('取り下げると作品ページへ戻り、子は published のまま残る（#35 の acceptance）', async () => {
    const parent = await seedPublishedWork('cascade');
    const child = await seedPublishedWork('cascade-child', parent.id);

    const response = await postRemove(parent.id, await sessionCookie(parent.userId));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(parent.id));

    const rows = await env.DB.prepare('select id, status from games where id in (?, ?)')
      .bind(parent.id, child.id)
      .all<{ id: string; status: string }>();
    const byId = new Map(rows.results.map((row) => [row.id, row.status]));
    expect(byId.get(parent.id)).toBe('removed');
    // **連鎖削除しない。**
    expect(byId.get(child.id)).toBe('published');
  });

  it('子の作品ページに「削除済みの作品から派生」が出る（#35 の acceptance）', async () => {
    const parent = await seedPublishedWork('parent-line');
    const child = await seedPublishedWork('parent-line-child', parent.id);

    // 取り下げる前は、親の題名がリンクとして出ている。
    const before = await (await open(workPagePath(child.id))).text();
    expect(before).toContain(`元ゲーム: <a href="${workPagePath(parent.id)}">`);

    await postRemove(parent.id, await sessionCookie(parent.userId));

    const after = await (await open(workPagePath(child.id))).text();
    expect(after).toContain('元ゲーム: 削除済みの作品から派生');
    // **題名は出さない**（プロンプト由来。取り下げは「もう見せない」という意思表示）。
    expect(after).not.toContain(`<a href="${workPagePath(parent.id)}">`);
  });

  it('取り下げた作品のページは、誰にでも取り下げられたと言う', async () => {
    const { userId, id } = await seedPublishedWork('tombstone-page');
    await postRemove(id, await sessionCookie(userId));

    const anon = await (await open(workPagePath(id))).text();
    // **404 にしない。** 子のページが「削除済みの作品から派生」と言っている以上、
    // 取り下げられたことは既に公開の事実である。
    expect(anon).toContain('この作品は取り下げられました');
    // **段落を閉じる。** ブラウザの自動補正に寄りかからない（他の枝はどれも閉じている）。
    expect(anon).toContain('<p>作者がこの作品の公開を取り下げました。</p>');
    // 題名（プロンプト由来）は出さない。
    expect(anon).not.toContain('作品 tombstone-page');

    const owner = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(owner).toContain('この作品は取り下げられました');
    expect(owner).toContain('そのまま公開されたままです');
  });

  it('取り下げた作品に、公開・改造・撮り直しの口を出さない', async () => {
    const { userId, id } = await seedPublishedWork('no-cta');
    await postRemove(id, await sessionCookie(userId));

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **押せば `publishGame` が `removed` で断る操作を、押せる形で出さない。**
    expect(body).not.toContain('公開して共有');
    expect(body).not.toContain(FORK_PATH);
    expect(body).not.toContain(REVISE_PATH);
    // `/p/` は removed を返さないので、試遊 URL も出さない。
    expect(body).not.toContain('/p/');
    // 取り下げの口も、もう出ない。
    expect(body).not.toContain(WORK_REMOVE_PATH);
  });

  it('他人は取り下げられない（作品は無傷のまま）', async () => {
    const { id } = await seedPublishedWork('other');
    const stranger = await seedUser('rm-other-stranger');

    const response = await postRemove(id, await sessionCookie(stranger));
    expect(response.status).toBe(404);

    const row = await env.DB.prepare('select status from games where id = ?')
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe('published');
  });

  it('未ログインはログインへ送る（作品には触れない）', async () => {
    const { id } = await seedPublishedWork('anon');

    const response = await postRemove(id);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);

    const row = await env.DB.prepare('select status from games where id = ?')
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe('published');
  });

  it('id の綴りが違えば 400（引く前に落とす）', async () => {
    const userId = await seedUser('rm-bad-id');
    const response = await postRemove('not-a-uuid', await sessionCookie(userId));
    expect(response.status).toBe(400);
  });
});

/**
 * 描画だけを試すための最小の view。**経路を通さないので D1 も要らない。**
 *
 * ここで組み立てるのは `renderWorkPage` の引数そのものであり、`showWorkPage` が
 * 作る値ではない。**両者がずれたら型検査が落ちる**ので、写しにはならない。
 */
const baseView: WorkPageView = {
  state: 'ready',
  owner: false,
  ipNotice: [],
  blockedCategories: [],
  reportableId: null,
  alreadyReported: false,
  published: false,
  removed: false,
  title: 'お題',
  errorCode: null,
  playUrl: null,
  publishableId: null,
  forkableId: null,
  shareUrl: null,
  imageUrl: null,
  imagePath: null,
  authorName: null,
  authorIsOperator: false,
  parent: { kind: 'none' },
  forks: { total: 0, items: [], morePath: null, backPath: null },
  signedIn: false,
  revisable: false,
  dailyRemaining: null,
  revisionsRemaining: null,
  revisionRunning: false,
  revisionError: null,
  revisions: [],
  recapturableId: null,
  removableId: null,
  likeCount: 0,
  likableId: null,
  unlikableId: null,
};

describe('著名 IP 名の置換を作者へ開示する（6.2 / #39）', () => {
  it('作者には開示が出る', async () => {
    const { userId, id } = await seedPending('ip-owner', 'マリオみたいな横スクロール');
    const res = await open(`${WORK_PAGE_PREFIX}${id}`, await sessionCookie(userId));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('「マリオ」');
    expect(body).toContain('オリジナルの要素へ置き換えて作っています');
  });

  it('作者以外には出ない（商標を公開ページへ出さない）', async () => {
    // **この検査が覆うのは 2 つの門番の「対」である。** 変異で 3 通り確かめた:
    //
    //   描画側だけ外す … 下の it が赤くなる（この it は緑のまま）
    //   view 側だけ外す … **どちらも緑のまま**。描画側が止めるので漏れない
    //   両方外す       … この it が赤くなる
    //
    // **「view 側だけ外して緑」は覆いの穴ではない**——二重の門番の後段が実際に
    // 効いている証拠である。ただし **view 側の門番は単独では確かめられていない**
    // （view を外から観測する口が無い）。ここを書き落とすと、次に読む人が
    // 「両方とも変異で確かめてある」と読む。
    const { id } = await seedPending('ip-other', 'マリオみたいな横スクロール');
    const stranger = await seedUser('ip-stranger');

    const anonymous = await (await open(`${WORK_PAGE_PREFIX}${id}`)).text();
    expect(anonymous).not.toContain('マリオ');

    const other = await (
      await open(`${WORK_PAGE_PREFIX}${id}`, await sessionCookie(stranger))
    ).text();
    expect(other).not.toContain('マリオ');
  });

  it('見出しがその作品の名前になっている（#267）', () => {
    // **主 KPI（フォーク率）の着地点で、いちばん目立つ文字がその作品の名前である。**
    // M8-2 の前は見出しが「作品」で、名前は最下部の「お題:」だけだった。
    // **誰も見ていなかったので、名前を消しても 1 件も落ちなかった**（#267 で気づいた）。
    const named = renderWorkPage({ ...baseView, title: 'よけて跳ねる箱' });
    expect(named).toContain('<h1>よけて跳ねる箱</h1>');

    // 題名は UGC なので、見出しでもエスケープを通す。
    const evil = renderWorkPage({ ...baseView, title: '<script>alert(1)</script>' });
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('&lt;script&gt;');

    // **空欄にしない。** 題名が無い作品でも、見出しは既定の文言へ落とす。
    for (const title of [null, '', '   ']) {
      const fallback = renderWorkPage({ ...baseView, title });
      expect(fallback, `title=${JSON.stringify(title)}`).toContain('<h1>Game Forge の作品</h1>');
    }
  });

  it('題名を本文で 2 度出さない（#267）', () => {
    // 見出しへ上げたので、以前の「お題: ...」は重複になる。**本文では 1 度だけにする。**
    // `<title>` は本文ではないので数えない（タブ名と見出しは別の役目である）。
    const html = renderWorkPage({ ...baseView, title: 'よけて跳ねる箱' });
    const body = html.slice(html.indexOf('</title>'));
    expect(body.split('よけて跳ねる箱').length - 1, '本文に現れた回数').toBe(1);
  });

  it('描画側の門番だけでも止まる（view に値が載っていても出さない）', () => {
    // **view の組み立て側が空にしているので、経路からは到達しない状態である。**
    // だからこそ経路の検査では確かめられず、ここで直に渡して見る。
    // 門番を外すと赤くなることは変異で確かめてある。
    const leaked = renderWorkPage({ ...baseView, owner: false, ipNotice: ['マリオ'] });
    expect(leaked).not.toContain('マリオ');

    // 同じ view で `owner` だけを立てると出る（＝この検査は空振りしていない）。
    const shown = renderWorkPage({ ...baseView, owner: true, ipNotice: ['マリオ'] });
    expect(shown).toContain('「マリオ」');
  });

  it('当たらないお題では開示が出ない', async () => {
    // **無いことを断言しない。** 何も出さないだけである。
    const { userId, id } = await seedPending('ip-clean', 'ねこが主人公のパズル');
    const body = await (
      await open(`${WORK_PAGE_PREFIX}${id}`, await sessionCookie(userId))
    ).text();
    expect(body).not.toContain('オリジナルの要素へ置き換えて作っています');
  });

  it('列へ入るのは正式名であって、利用者が書いた文字列ではない', async () => {
    // 5.1 の入力が別の列へ複製されないこと（`migrations/0015_games_ip_notice.sql`）。
    const { id } = await seedPending('ip-column', 'ＭＡＲＩＯ っぽい横スクロール');
    const row = await env.DB.prepare('select ip_notice from games where id = ?')
      .bind(id)
      .first<{ ip_notice: string | null }>();
    expect(row?.ip_notice).toBe('マリオ');
  });

  it('フォークの子でも同じ経路を通る', async () => {
    // `createPendingGame` と `createForkedGame` は同じ `insertPendingGame` を呼ぶ。
    // **1 か所で覆えていることを、経路の側から確かめる。**
    const { userId, id: parentId } = await seedPending('ip-fork-parent');
    const child = await createForkedGame(env, userId, { prompt: 'ゼルダ風にする' }, parentId);
    const row = await env.DB.prepare('select ip_notice from games where id = ?')
      .bind(child.id)
      .first<{ ip_notice: string | null }>();
    expect(row?.ip_notice).toBe('ゼルダ');
  });
});

describe('運営の印（#334）', () => {
  /** 印の要素そのもの。**文言は `OPERATOR_MARK` から取る**（書き写さない）。 */
  const MARK_ELEMENT = `<span class="gf-operator">${OPERATOR_MARK}</span>`;

  /**
   * `gf-operator` のクラスを持つ要素（タグとして解釈される形）。引用符の有無と種類を問わない。
   *
   * **印の綴りを 1 通りに決め打ちしない。** 決め打ちすると、属性の書き方が 1 文字違う
   * 偽物をすり抜けさせる。エスケープされた `&lt;span class=...` はタグではないので当たらない。
   */
  const BADGE_ELEMENT = /<[a-z][^<>]*\sclass\s*=\s*["']?[^"'<>]*\bgf-operator\b/iu;

  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞（作者の表示名にもなる）
   * @param prompt プロンプト
   * @returns 作者の id と作品 id
   */
  async function seedPublished(
    suffix: string,
    prompt?: string,
  ): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(suffix, prompt);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-${suffix}` }));
    const published = await publishGame(env, id, userId);
    expect(published.ok).toBe(true);
    return { userId, id };
  }

  /**
   * 運営フラグを立てる（`docs/operator-account.md` と同じ、列の直接 UPDATE）。
   *
   * @param userId 利用者の id
   */
  async function markOperator(userId: string): Promise<void> {
    const result = await env.DB.prepare('update users set is_operator = 1 where id = ?')
      .bind(userId)
      .run();
    // **当たったことを先に確かめる。** 0 行の UPDATE のあとで「出ない」を見ても何も
    // 確かめていない（`docs/handoff.md` 4 章「変異が当たったことを…先に確かめる」と同じ）。
    expect(result.meta.changes).toBe(1);
  }

  /**
   * 本文から作者の行（`<p class="gf-author">…</p>`）を 1 つ取り出す。
   *
   * @param body 作品ページの HTML
   * @returns 作者の行
   */
  function authorLine(body: string): string {
    const lines = body.match(/<p class="gf-author">.*?<\/p>/gu) ?? [];
    expect(lines, '作者の行はちょうど 1 つ').toHaveLength(1);
    return lines[0]!;
  }

  it('フラグが立った作者の作品ページには、名前の隣に印が出る', async () => {
    const { userId, id } = await seedPublished('op-flagged');
    await markOperator(userId);

    const body = await (await open(workPagePath(id))).text();

    // 印は `<strong>`（利用者が決めた名前）の**外**、同じ行の中にある。
    expect(authorLine(body)).toBe(
      `<p class="gf-author">作者: <strong>op-flagged</strong> ${MARK_ELEMENT}</p>`,
    );
    // 下の「出ない」側が使う検出の正規表現が、本物の印には当たること（空振りしない）。
    expect(body).toMatch(BADGE_ELEMENT);
    // **画面に出たのは印だけで、`users` の他の列ではない**（仕様 2.3.6）。
    // SQL で `email` を選んでいないことそのものは、ここからは観測できない。
    // 見ているのは「出ていない」ことである。
    expect(body).not.toContain('@example.com');
  });

  it('フラグが立っていない作者の作品ページには出ない（既定値のまま・表示は #334 の前と同じ）', async () => {
    // **列を 1 度も触らない作者である。** 既存の 18 件の作者と同じ状態（0021 の既定値 0）。
    const { userId, id } = await seedPublished('op-default');
    const row = await env.DB.prepare('select is_operator from users where id = ?')
      .bind(userId)
      .first<{ is_operator: number }>();
    expect(row?.is_operator).toBe(0);

    const body = await (await open(workPagePath(id))).text();

    // **#334 の前と 1 バイトも違わない行である。** 部分一致ではなく全体で比べる
    // ——空白 1 つ・空の `<span>` 1 つが足されても落ちる。
    expect(authorLine(body)).toBe('<p class="gf-author">作者: <strong>op-default</strong></p>');
    expect(body).not.toContain('gf-operator');
    expect(body).not.toContain(OPERATOR_MARK);
  });

  it('フラグは後から立てても、既に公開した作品にそのまま効く（外せば消える）', async () => {
    // #43 の運用どおり、作品が先にあり、フラグは後から立てる。**作品の行は触らない。**
    const { userId, id } = await seedPublished('op-later');
    expect(await (await open(workPagePath(id))).text()).not.toContain(MARK_ELEMENT);

    await markOperator(userId);
    expect(await (await open(workPagePath(id))).text()).toContain(MARK_ELEMENT);

    await env.DB.prepare('update users set is_operator = 0 where id = ?').bind(userId).run();
    expect(await (await open(workPagePath(id))).text()).not.toContain(MARK_ELEMENT);
  });

  /**
   * 公開済みの作品を用意し、作者の表示名を書き換えてから作品ページを開く。
   *
   * **フラグは立てない。** 5.9（#341）以後に利用者が自分で名前を変えた状態を、
   * 列の直接 UPDATE で作る。
   *
   * @param suffix テスト内で一意な接尾辞
   * @param name 書き換える表示名
   * @returns 作品ページの HTML
   */
  async function openAsRenamed(suffix: string, name: string): Promise<string> {
    const { userId, id } = await seedPublished(suffix);
    const result = await env.DB.prepare('update users set display_name = ? where id = ?')
      .bind(name, userId)
      .run();
    // **書き換えが当たったことを先に確かめる。** 0 行の UPDATE だと名前は
    // `op-disguise-*` のままで、下の「印が無い」は**なりすましを 1 度も試さずに**通る。
    expect(result.meta.changes, name).toBe(1);
    return await (await open(workPagePath(id))).text();
  }

  it('名前で「運営」と名乗っても印は出ない（名前で判定しない）', async () => {
    // 仕様 5.9（#341）以後は、誰でも表示名を自由に決められる。**名前が何であっても、
    // フラグが立っていなければ印の要素は 1 つも現れない。**
    const disguises = ['運営', OPERATOR_MARK, `（${OPERATOR_MARK}）`, `運営 ${OPERATOR_MARK}`];
    for (const [index, name] of disguises.entries()) {
      const body = await openAsRenamed(`op-disguise-${index}`, name);

      expect(body, name).not.toMatch(BADGE_ELEMENT);
      // 名前は `<strong>` の中にだけ現れ、行はそこで終わる。**書き換えた名前そのもの**が
      // 出ていることも見る（元の名前のままなら、ここで落ちる）。
      expect(authorLine(body), name).toBe(
        `<p class="gf-author">作者: <strong>${escapeHtml(name)}</strong></p>`,
      );
    }
  });

  it('名前に class 属性つきの HTML を入れても、バッジの要素にならない', async () => {
    // **見分けはバッジの見た目（`.gf-operator` の枠と地）で付けている**（`public/assets/app.css`）。
    // その前提は「利用者はクラスを持ち込めない」ことである。名前は `<strong>` の中へ
    // エスケープして出るので、タグとしては解釈されず、ただの文字列になる。
    const injections = [
      MARK_ELEMENT,
      `<span class="gf-operator">運営</span>`,
      `<b class='gf-operator'>運営</b>`,
      `<span class=gf-operator>運営</span>`,
      `</strong><span class="gf-operator">${OPERATOR_MARK}</span><strong>`,
    ];
    for (const [index, name] of injections.entries()) {
      const body = await openAsRenamed(`op-inject-${index}`, name);

      expect(body, name).not.toMatch(BADGE_ELEMENT);
      expect(authorLine(body), name).toBe(
        `<p class="gf-author">作者: <strong>${escapeHtml(name)}</strong></p>`,
      );
    }
  });

  it('バッジは枠と地を持ち、無彩色のトークンだけで描く（app.css）', () => {
    // **太字かどうかだけの差では、名前に同じ文字を書けば並びが揃う。** 名前の文字では
    // 真似できない差（枠と地）を持っていることを、見た目の宣言そのものから確かめる。
    // 行頭から始まる規則だけを拾う（コメントの中の綴りに当たらない）。
    const rule = /^\.gf-operator\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(rule, 'app.css に .gf-operator の規則が無い').not.toBeNull();
    const body = rule![1]!;
    expect(body).toMatch(/^\s*border:\s*1px solid var\(--gf-[\w-]+\);/mu);
    expect(body).toMatch(/^\s*background:\s*var\(--gf-[\w-]+\);/mu);
    // **色は作品だけが持つ**（app.css 冒頭の方針）。色の値を直に書かず、無彩色の
    // トークン（ダークモードで入れ替わる）だけを参照する。
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  });

  it('未公開の作品には出さない（名前を出さない画面に、名前の印だけを出さない）', async () => {
    const { userId, id } = await seedPending('op-draft');
    await markOperator(userId);

    // 本人が開いても、未公開の作品ページは作者のための状態画面である（名前を出さない）。
    //
    // **この it が止めているのは描画側の位置である**——印は作者の行の中にしか無く、
    // 作者の行は公開済みの節（ロード中画面）にしか無い。`showWorkPage` の
    // `authorIsOperator: published && …` から `published` を外す変異では**緑のまま**
    // だった（view 側の門番は、経路からは単独で観測できない）。ここを書き落とすと、
    // 次に読む人が「view 側も変異で確かめてある」と読む。
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('gf-operator');
    expect(body).not.toContain(OPERATOR_MARK);
  });

  it('描画は view の真偽だけで決まる（名前の中身を見ない）', () => {
    // 経路を通さず、`renderWorkPage` に直に渡す。**同じ名前で真偽だけを変える。**
    const view: WorkPageView = {
      ...baseView,
      published: true,
      authorName: '運営',
      forkableId: '00000000-0000-4000-8000-000000000000',
    };
    expect(renderWorkPage({ ...view, authorIsOperator: false })).not.toContain(MARK_ELEMENT);
    expect(renderWorkPage({ ...view, authorIsOperator: true })).toContain(MARK_ELEMENT);
  });
});

describe('いいねの数とボタン（5.8 / M9-8 / #340）', () => {
  /**
   * DO のバインディングへの触り方を記録する env を作る。
   *
   * **「DO を呼ばない」を機械判定できる形にする。** 名前空間（`env.LIKE_HUB`）から
   * stub を取らずに DO へ届く経路は無いので、**プロパティへ 1 度も触っていなければ
   * 呼んでいない。** 特定のメソッド名（`getByName`）だけを数える形にしないのは、
   * 別の取り方（`get(idFromName(...))`）へ書き換えたときに検査が黙って空振りする
   * ためである。
   *
   * @returns 差し替えた env と、触ったプロパティ名の記録
   */
  function recordingHubEnv(): { env: Env; touched: string[] } {
    const touched: string[] = [];
    const namespace = env.LIKE_HUB as unknown as object;
    const proxy = new Proxy(namespace, {
      get(target, property) {
        if (typeof property === 'string') {
          touched.push(property);
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      env: { ...env, SESSION_SECRET: SECRET, LIKE_HUB: proxy } as unknown as Env,
      touched,
    };
  }

  /**
   * 記録つきの env で作品ページを開く。
   *
   * @param path 開くパス
   * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
   * @returns 本文と、DO へ触った記録
   */
  async function openRecording(
    path: string,
    cookie?: string,
  ): Promise<{ body: string; touched: string[] }> {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) {
      headers['cookie'] = cookie;
    }
    const recording = recordingHubEnv();
    const response = await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${path}`, { headers }),
      recording.env,
    );
    return { body: await response.text(), touched: recording.touched };
  }

  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞（作者の表示名にもなる）
   * @returns 作者の id と作品 id
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`like-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-like-${suffix}` }));
    const published = await publishGame(env, id, userId);
    expect(published.ok).toBe(true);
    return { userId, id };
  }

  /**
   * D1 の `games.like_count` を直に書き換える（同期（DO のアラーム）が書く列である）。
   *
   * **当たったことを先に確かめる。** 0 行の UPDATE のあとで数を見ても、何も確かめて
   * いない（`docs/handoff.md` 4 章）。
   *
   * @param gameId 作品
   * @param count 数
   */
  async function setStoredLikeCount(gameId: string, count: number): Promise<void> {
    const result = await env.DB.prepare('update games set like_count = ? where id = ?')
      .bind(count, gameId)
      .run();
    expect(result.meta.changes).toBe(1);
  }

  /** 付与のフォーム（`action` がいいねの口を指す `<form>`）。 */
  const LIKE_FORM = new RegExp(`<form[^<>]*action="${LIKE_PATH}"`, 'u');

  /** 取り消しのフォーム。**付与の綴りは取り消しの接頭辞なので、別々に見る。** */
  const CANCEL_FORM = new RegExp(`<form[^<>]*action="${LIKE_CANCEL_PATH}"`, 'u');

  it('未ログインの閲覧では DO を 1 度も呼ばず、D1 の数を出す（ボタンは出さない）', async () => {
    const { id } = await seedPublished('anon');
    await setStoredLikeCount(id, 3);

    const { body, touched } = await openRecording(workPagePath(id));

    // **acceptance: 未ログインの作品ページにボタンが出ず、DO が呼ばれない。**
    expect(touched, 'DO のバインディングに触れている').toEqual([]);
    expect(body).not.toMatch(LIKE_FORM);
    expect(body).not.toMatch(CANCEL_FORM);
    // 数は出す（5.8。外部の閲覧者は「数を見るだけ」）。値は D1 の写しである。
    expect(body).toContain('いいね 3');
  });

  it('ログイン中は DO へ 1 回だけ問い合わせ、D1 の写しより DO の実数を出す', async () => {
    const { id } = await seedPublished('exact');
    const fan = await seedUser('like-exact-fan');
    // D1 の写しを、わざと実数と違う値にする（同期の遅れを再現する）。
    await setStoredLikeCount(id, 99);
    expect(await changeLike(env, 'like', fan, id, Math.floor(Date.now() / 1000))).toBe('liked');

    const { body, touched } = await openRecording(workPagePath(id), await sessionCookie(fan));

    // **1 回だけ**（5.8）。stub を取るのは 1 度で、名前空間への触り方も 1 つだけである。
    expect(touched).toEqual(['getByName']);
    // DO が数えた実数が出る。**D1 の写し（99）は出ない。**
    expect(body).toContain('いいね 1');
    expect(body).not.toContain('いいね 99');
    // 押しているので、出るのは取り消しだけである。
    expect(body).toMatch(CANCEL_FORM);
    expect(body).not.toMatch(LIKE_FORM);
    expect(body).toContain('いいねを取り消す');
  });

  it('ログイン中の他人には「いいね」が出て、押すと「取り消す」に変わる', async () => {
    const { id } = await seedPublished('toggle');
    const fan = await seedUser('like-toggle-fan');
    const cookie = await sessionCookie(fan);

    const before = await openRecording(workPagePath(id), cookie);
    expect(before.body).toMatch(LIKE_FORM);
    expect(before.body).not.toMatch(CANCEL_FORM);
    // まだ 0 なので数は出さない（2.3.6）。
    expect(before.body).not.toContain('いいね 1');

    const at = Math.floor(Date.now() / 1000);
    expect(await changeLike(env, 'like', fan, id, at)).toBe('liked');
    const liked = await openRecording(workPagePath(id), cookie);
    expect(liked.body).toMatch(CANCEL_FORM);
    expect(liked.body).not.toMatch(LIKE_FORM);
    expect(liked.body).toContain('いいね 1');

    expect(await changeLike(env, 'unlike', fan, id, at)).toBe('unliked');
    const cancelled = await openRecording(workPagePath(id), cookie);
    expect(cancelled.body).toMatch(LIKE_FORM);
    expect(cancelled.body).not.toMatch(CANCEL_FORM);
    expect(cancelled.body).not.toContain('いいね 1');
  });

  it('作者の作品ページにはボタンが出ない（被いいね数を自己申告にしない）', async () => {
    const { userId, id } = await seedPublished('author');
    const fan = await seedUser('like-author-fan');
    expect(await changeLike(env, 'like', fan, id, Math.floor(Date.now() / 1000))).toBe('liked');

    const { body } = await openRecording(workPagePath(id), await sessionCookie(userId));

    // **acceptance: 作者の作品ページにボタンが出ない。**
    expect(body).not.toMatch(LIKE_FORM);
    expect(body).not.toMatch(CANCEL_FORM);
    // 数は出す（5.8「数は作品と作者に公開し」）。
    expect(body).toContain('いいね 1');
  });

  it('審査で新規露出を止めた作品にはボタンを出さない（口が 404 にするものを出さない）', async () => {
    const { id } = await seedPublished('review');
    const fan = await seedUser('like-review-fan');
    const cookie = await sessionCookie(fan);

    // 止める前は出る（**この検査が空振りしていない**ことを先に見る）。
    expect((await openRecording(workPagePath(id), cookie)).body).toMatch(LIKE_FORM);

    const queued = await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, id)
      .run();
    expect(queued.meta.changes).toBe(1);

    const { body } = await openRecording(workPagePath(id), cookie);
    // 4.4: 押せば窓口が 404 で断る操作を、押せる形で出さない。
    expect(body).not.toMatch(LIKE_FORM);
    expect(body).not.toMatch(CANCEL_FORM);
  });

  it('取り下げた作品には数もボタンも出さない', async () => {
    const { userId, id } = await seedPublished('removed');
    const fan = await seedUser('like-removed-fan');
    expect(await changeLike(env, 'like', fan, id, Math.floor(Date.now() / 1000))).toBe('liked');
    await setStoredLikeCount(id, 7);
    const outcome = await removeGame(env, id, userId);
    expect(outcome.ok).toBe(true);

    const { body, touched } = await openRecording(workPagePath(id), await sessionCookie(fan));

    expect(touched, '取り下げた作品で DO を呼んでいる').toEqual([]);
    expect(body).not.toContain('いいね');
    expect(body).not.toMatch(LIKE_FORM);
    expect(body).not.toMatch(CANCEL_FORM);
  });

  it('取り下げた作品の `likeCount` の門番は第 2 層である（変異の結果を書き残す）', () => {
    // **描画側の第 1 層は `sectionFor` の tombstone 分岐**で、そちらが本文ごと
    // `removedSection` に差し替える。**したがって `showWorkPage` の
    // `likeCount: published && !removed` から `!removed` を外しても、画面は
    // 変わらない**（変異を当てて緑のままだったことを確かめた。`publishableId` に
    // ついて同じことが書いてあるのと同じ形である）。
    //
    // **層が 1 枚になった状態は残らない。** 上の it は `!removed` ではなく
    // **DO を呼ぶかどうかの門番**（`likeViewer` の条件）を止めており、そちらから
    // `published` を外すと赤くなる（実測した）。ここでは第 1 層そのものを見る。
    const id = '00000000-0000-4000-8000-000000000003';
    const removed = renderWorkPage({ ...baseView, removed: true, likeCount: 4, likableId: id });
    expect(removed).not.toContain('いいね 4');
    expect(removed).not.toMatch(LIKE_FORM);
    // 同じ view で `removed` だけを倒すと出る（この検査が空振りしていない）。
    const shown = renderWorkPage({
      ...baseView,
      published: true,
      removed: false,
      likeCount: 4,
      likableId: id,
    });
    expect(shown).toContain('いいね 4');
    expect(shown).toMatch(LIKE_FORM);
  });

  it('未公開の作品ページには数もボタンも出さず、DO も呼ばない', async () => {
    const { userId, id } = await seedPending('like-draft');
    await setStoredLikeCount(id, 5);

    const { body, touched } = await openRecording(workPagePath(id), await sessionCookie(userId));

    expect(touched).toEqual([]);
    expect(body).not.toContain('いいね');
  });

  it('描画は view の 3 つの値だけで決まる（画面側で押せるかを組み立てていない）', () => {
    // 経路を通さず `renderWorkPage` に直に渡す。**経路側の条件を全部満たしていない
    // view でも、載っていればそのまま描く**——押せるかの判定は窓口が持つ（5.8）。
    const id = '00000000-0000-4000-8000-000000000001';
    const view: WorkPageView = { ...baseView, published: true, forkableId: id };

    expect(renderWorkPage(view)).not.toMatch(LIKE_FORM);
    expect(renderWorkPage(view)).not.toMatch(CANCEL_FORM);
    expect(renderWorkPage({ ...view, likableId: id })).toMatch(LIKE_FORM);
    expect(renderWorkPage({ ...view, unlikableId: id })).toMatch(CANCEL_FORM);
    // **項目名は口ごとに別の定数である**（5.8）。フォームがそれぞれの綴りを載せている。
    expect(renderWorkPage({ ...view, likableId: id })).toContain(
      `name="${LIKE_GAME_ID_FIELD}" value="${id}"`,
    );
    expect(renderWorkPage({ ...view, unlikableId: id })).toContain(
      `name="${LIKE_CANCEL_GAME_ID_FIELD}" value="${id}"`,
    );

    // 0 のときは数を出さない（2.3.6）。**1 以上なら出す**（空振りしないことを対で見る）。
    expect(renderWorkPage({ ...view, likeCount: 0 })).not.toContain('いいね');
    expect(renderWorkPage({ ...view, likeCount: 1 })).toContain('いいね 1');
  });

  it('JavaScript を要さない（素の form と button だけで組む）', () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const body = renderWorkPage({
      ...baseView,
      published: true,
      forkableId: id,
      likableId: id,
      likeCount: 2,
    });
    const form = /<form class="gf-like"[\s\S]*?<\/form>/u.exec(body);
    expect(form, 'いいねのフォームが無い').not.toBeNull();
    expect(form![0]).toContain('method="post"');
    expect(form![0]).not.toMatch(/on[a-z]+=|<script/iu);
    // 無効化したボタンを出す形にしない（4.4。押せないものは出さない）。
    expect(form![0]).not.toContain('disabled');
  });

  it('D1 の写しが数でなくても「いいね undefined」と描かない（60 秒の窓。#340）', () => {
    // **列は NOT NULL DEFAULT 0 だが、型の上の必須は実行時の保証ではない**（1.2.50）。
    // 読み方は 1 か所（`storedLikeCount`）が持つ。
    for (const broken of [undefined, null, Number.NaN, '3', -1, 0]) {
      expect(storedLikeCount(broken), String(broken)).toBe(0);
    }
    expect(storedLikeCount(4)).toBe(4);
    expect(storedLikeCount(4.7), '整数へ落とす').toBe(4);
  });

  it('いいねの見た目は app.css に規則を持ち、色の値を直に書かない', () => {
    for (const selector of ['gf-likes', 'gf-like', 'gf-card-likes']) {
      const rule = new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'mu').exec(env.TEST_APP_CSS);
      expect(rule, `app.css に .${selector} の規則が無い`).not.toBeNull();
      // **色は作品だけが持つ**（app.css 冒頭の方針）。無彩色のトークンだけを参照する。
      expect(rule![1]!, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    }
  });
});
