import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import {
  FORKS_OFFSET_PARAM,
  FORKS_PER_PAGE,
  GENERATION_IS_SYNCHRONOUS,
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
} from '../src/games.js';
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
