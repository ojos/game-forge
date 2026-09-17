import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { escapeHtml, siteViewerAt } from '../src/html.js';
import { pageBodyOf } from './helpers/site-shell.js';
import { dispatch } from '../src/routes.js';
import { renderWorkPage as renderWorkPageFor } from '../src/work-page.js';
import type { WorkDetails, WorkPageView } from '../src/work-page.js';
import {
  FORKS_OFFSET_PARAM,
  FORKS_PER_PAGE,
  GENERATION_IS_SYNCHRONOUS,
  FORK_TIDY_QUOTA_NOTICE,
  GENERATION_RETRY_QUOTA_NOTICE,
  OPERATOR_MARK,
  PUBLISH_SOURCE_NOTICE,
  WORK_ROW_SQL,
  formatWasmSize,
  storedLikeCount,
  storedWasmBytes,
  WORK_DESCRIBE_ANCHOR,
  WORK_PAGE_PREFIX,
  WORK_RENAME_ANCHOR,
  WORK_UNPUBLISH_GAME_ID_FIELD,
  WORK_UNPUBLISH_PATH,
  workPagePath,
  workPageRoutes,
} from '../src/work-page.js';
import {
  claimGenerationJob,
  completeGame,
  createForkedGame,
  createPendingGame,
  describeGame,
  failGame,
  hashJobToken,
  publishGame,
  STALE_AFTER_SECONDS,
} from '../src/games.js';
import {
  LIKE_CANCEL_GAME_ID_FIELD,
  LIKE_CANCEL_PATH,
  LIKE_GAME_ID_FIELD,
  LIKE_PATH,
} from '../src/like-paths.js';
import { changeLike } from '../src/likes.js';
import { PLAY_PATH, playReportScript } from '../src/plays.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { authorPagePath } from '../src/users-page-paths.js';
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
} from '../src/quota.js';
import {
  appendRevision,
  claimRevisionJob,
  claimRevisionSlot,
  failRevision,
} from '../src/revisions.js';
import { MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { TIDY_ATTEMPTS } from '../src/source-size.js';
import { NEWS_ARTICLES } from '../src/news-articles.js';
import { workSourcePath } from '../src/work-source.js';
import { playEmbed } from '../src/work-play.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { markGameRemoved } from './helpers/removed-work.js';

/**
 * 1 作品あたりの回数の上限を言う文の形（#515 でなくした）。
 *
 * **#515 より前の文言は「この作品はあと N 回手直しできます」だった**（#513 で「リフォージできます」）。
 * 呼び名が変わっても当たるよう、語ではなく「あと N 回」「N 回まで」の形で見る。
 */
const PER_WORK_LIMIT_WORDING = /あと ?[0-9]+ ?回|1 作品につき|[0-9]+ ?回まで(?:リフォージ|手直し|推敲)/u;

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * お知らせの記事「生成枠の扱いについて」から、自動のやり直しと枠の消費を言う 1 文を拾う（#402）。
 *
 * **作品ページの推敲とフォークの文言は、この 1 文と同じ言い方にする。** 記事は回数を
 * 直書きした日付の付いた写しで、`test/news.test.ts` が `MAX_GENERATION_ATTEMPTS` と照合して
 * いる。作品ページは定数から文言を作るので、**定数を動かすと作品ページだけが動き、
 * ここでの一致が崩れて落ちる。**
 *
 * @returns 記事の 1 文（句点まで）
 */
function quotaArticleRetrySentence(): string {
  const article = NEWS_ARTICLES.find((candidate) => candidate.id === 'generation-quota');
  expect(article, '生成枠の記事が無い').toBeDefined();
  const sentence = /生成されたコードがコンパイルできなかったときは[^。]*。/u.exec(article!.body.join(''));
  expect(sentence, '記事にやり直しの 1 文が無い').not.toBeNull();
  return sentence![0];
}
const SECRET = 'test-secret-value-for-work-page-endpoint-1';

/**
 * 作品ページを、**ヘッダの状態を固定して**組み立てる（#331）。
 *
 * この一連の検査が見ているのは**本文**である（題名のエスケープ・IP の断り・いいねの口）。
 * ヘッダの出し分け（2.3.7）は全画面に共通する外枠なので、**画面ごとに書くのではなく
 * `test/page-shell.test.ts` が経路表から導いて両方の状態で見る。** ここで状態を振ると、
 * 同じことを 2 か所で検査したうえに、片方だけが古くなる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderWorkPage(view: WorkPageView): string {
  return renderWorkPageFor(view, siteViewerAt(WORK_PAGE_PREFIX, false, null));
}

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

describe('推敲とフォークで使う生成枠の説明（#402 / 5.2-7 / 4.3）', () => {
  it('お知らせの記事と同じ 1 文で、回数は `MAX_GENERATION_ATTEMPTS` から作る', () => {
    // **枠は成否に関わらず LLM を呼んだ回数で数える**（4.3）。コンパイルに失敗すると
    // 自動で 1 回やり直すので、1 回の操作で最大 `MAX_GENERATION_ATTEMPTS` 回分減る。
    expect(GENERATION_RETRY_QUOTA_NOTICE).toContain(
      `枠を最大 ${MAX_GENERATION_ATTEMPTS} 回分使うことがあります`,
    );
    // **同じ事実を記事と画面で別の言い方にしない。** 記事は回数を直書きしているので、
    // 定数だけを動かすとここが落ちる（記事を直すか、新しい記事を足す合図）。
    expect(GENERATION_RETRY_QUOTA_NOTICE).toBe(quotaArticleRetrySentence());
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
    // **待ち時間と費用を隠さない**（5.7）。**枠は 1 回ではなく最大
    // `MAX_GENERATION_ATTEMPTS` 回分減る**（5.2-7 の自動のやり直し。#402）。
    const shown = pageBodyOf(body);
    expect(shown).not.toContain('生成枠を 1 回使います');
    expect(shown).toContain(`枠を最大 ${MAX_GENERATION_ATTEMPTS} 回分使う`);
    expect(shown).toContain(quotaArticleRetrySentence());
    // 整理パスはフォークだけの経路である。推敲の口には添えない。
    expect(shown).not.toContain(FORK_TIDY_QUOTA_NOTICE);
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

  it('日次の残枠は出し、1 作品あたりの残り回数は出さない（#515）', async () => {
    const { userId, id } = await seedReady('remaining');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    // **4.4 の文言を書き写さない。** 正本の組み立て関数と突き合わせる
    // （`src/quota.ts`。あちらが 4.4 の本文と機械照合されている）。
    expect(body).toContain(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
    // **1 作品あたりの上限はなくした**（#515）。回数の上限を言う文を出さない。
    expect(pageBodyOf(body)).not.toMatch(PER_WORK_LIMIT_WORDING);
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

  it('revise_count が 3 以上でも、日次枠が残っていれば口を出す（1 作品あたりの上限は無い。#515）', async () => {
    const { userId, id } = await seedReady('exhausted');
    await env.DB.prepare('update games set revise_count = ? where id = ?')
      .bind(3, id)
      .run();

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain(REVISE_PATH);
    expect(pageBodyOf(body)).not.toMatch(PER_WORK_LIMIT_WORDING);
  });

  it('推敲が走っているあいだは口を出さず、自動更新する', async () => {
    const { userId, id } = await seedReady('running');
    await claimRevisionSlot(env, id, userId, '玉を速く', 'work-page-hash-1');

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **二重送信をボタンの無効化ではなく「フォームが無い」ことで防ぐ**（JS を要求しない）。
    expect(body).not.toContain(REVISE_PATH);
    expect(body).toContain('リフォージしています');
    // **`state` は `ready` のままなので、この検査が無いと画面は止まって見える。**
    expect(body).toContain('http-equiv="refresh"');
  });

  /**
   * 2 つ目の版を積み、作品をそちらへ差し替える（「版に戻す」の口が出る状態を作る）。
   *
   * @param id 作品 id
   */
  async function addSecondRevision(id: string): Promise<void> {
    await appendRevision(
      env,
      id,
      { goVersion: 'go1.27.0', sourceKey: `builds/${id}/source.go`, wasmKey: `builds/${id}/game.wasm.br` },
      '玉を速く',
    );
    await env.DB.prepare(
      'update games set source_key = ?, wasm_key = ?, go_version = ? where id = ?',
    )
      .bind(`builds/${id}/source.go`, `builds/${id}/game.wasm.br`, 'go1.27.0', id)
      .run();
  }

  /**
   * 推敲ジョブを 1 本、指定の時刻に始まったものとして残す（経路の関数に時刻だけを与える）。
   *
   * @param userId 作者
   * @param id 作品 id
   * @param since ジョブの作成（running なら開始も）の時刻
   * @param state 残す状態
   */
  async function leaveRevisionJob(
    userId: string,
    id: string,
    since: number,
    state: 'pending' | 'running',
  ): Promise<void> {
    const hash = `work-page-left-${id}-${state}`;
    expect(await claimRevisionSlot(env, id, userId, '止まった手直し', hash, since)).toBe(true);
    if (state === 'running') {
      expect(await claimRevisionJob(env, id, hash, since)).toBe(true);
    }
  }

  for (const state of ['pending', 'running'] as const) {
    it(`区切りを過ぎた ${state} の推敲では中断を知らせ、自動更新せず、推敲の口と「版に戻す」を出す（#480）`, async () => {
      const { userId, id } = await seedReady(`stalled-${state}`);
      await addSecondRevision(id);
      await leaveRevisionJob(
        userId,
        id,
        Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS - 1,
        state,
      );

      const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
      expect(body).toContain('リフォージが中断した可能性があります');
      expect(body).toContain('作品はそのまま残っています');
      expect(body).not.toContain('リフォージしています');
      // **待っても画面は変わらない**ので、読み取りを続けない。
      expect(body).not.toContain('http-equiv="refresh"');
      // 止まった行は次の推敲が引き取る（`claimRevisionSlot`）ので、口を出す。
      expect(body).toContain(REVISE_PATH);
      expect(body).toContain('気になるところを直す');
      // 戻す操作も断らない（`restoreRevision`）。いまの版以外の 1 つに口が出る。
      expect(body).toContain('これまでの版');
      expect([...body.matchAll(new RegExp(RESTORE_PATH, 'gu'))]).toHaveLength(1);
    });

    it(`区切りの内側の ${state} の推敲は、いまと同じく「手直しをしています」と自動更新で、口も戻す口も出さない（#480）`, async () => {
      const { userId, id } = await seedReady(`live-${state}`);
      await addSecondRevision(id);
      await leaveRevisionJob(
        userId,
        id,
        Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS + 60,
        state,
      );

      const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
      expect(body).toContain('リフォージしています');
      expect(body).toContain('http-equiv="refresh"');
      expect(body).not.toContain('中断した可能性');
      expect(body).not.toContain(REVISE_PATH);
      // 版の一覧は出すが、戻す口は出さない（90 秒後に黙って上書きされるため）。
      expect(body).toContain('これまでの版');
      expect(body).not.toContain(RESTORE_PATH);
    });
  }

  it('止まった推敲の案内は作者にだけ出る（#480）', async () => {
    const { userId, id } = await seedReady('stalled-stranger');
    await leaveRevisionJob(
      userId,
      id,
      Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS - 1,
      'running',
    );
    const stranger = await seedUser('rev-stalled-outsider');

    for (const cookie of [undefined, await sessionCookie(stranger)]) {
      const body = await (await open(workPagePath(id), cookie)).text();
      expect(body).not.toContain('中断した可能性');
      expect(body).not.toContain(REVISE_PATH);
    }
  });

  it('描画: 止まった推敲（revisionStalled）は自動更新を付けず、走っている推敲は付ける（#480）', () => {
    const owned = { ...baseView, owner: true, revisable: false };
    const stalled = renderWorkPage({ ...owned, revisionStalled: true });
    expect(stalled).not.toContain('http-equiv="refresh"');
    expect(stalled).toContain('リフォージが中断した可能性があります');

    const running = renderWorkPage({ ...owned, revisionRunning: true });
    expect(running).toContain('http-equiv="refresh"');
    expect(running).toContain('リフォージしています');
    expect(running).not.toContain('中断した可能性');
  });

  it('失敗した推敲は理由を出し、作品が無事であることを言う', async () => {
    const { userId, id } = await seedReady('failed');
    await claimRevisionSlot(env, id, userId, '玉を速く', 'work-page-hash-2');
    await failRevision(env, id, 'build-failed');

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('前回のリフォージはうまくいきませんでした');
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
    expect(body).toContain('どう変えてフォークしますか');
    // **待ち時間と費用を隠さない**（5.7 の推敲と同じ扱い。1 回は生成 1 回そのもので、
    // 自動のやり直しが乗ると枠は最大 `MAX_GENERATION_ATTEMPTS` 回分減る。#402）。
    const shown = pageBodyOf(body);
    expect(shown).not.toContain('生成枠を 1 回使います');
    expect(shown).toContain(`枠を最大 ${MAX_GENERATION_ATTEMPTS} 回分使う`);
    expect(shown).toContain(quotaArticleRetrySentence());
    // **整理パスは `TIDY_ATTEMPTS` で打ち切り、自動のやり直しが乗らない**（5.3 の確定18）。
    // 口は親の大きさを読まないので、例外を言葉で添える（PR #407 のレビュー指摘）。
    expect(TIDY_ATTEMPTS).toBe(1);
    expect(shown).toContain(FORK_TIDY_QUOTA_NOTICE);
    expect(FORK_TIDY_QUOTA_NOTICE).toContain('自動のやり直しは行わず');
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
    expect(body).toContain('フォークには招待が必要です');
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
    expect(body).toContain('このゲームをフォークする');
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

  it('公開済みの作品に「このゲームからのフォーク: N 件」と子へのリンクが出る', async () => {
    const { id } = await seedPublishedWork('list');
    const forker = await seedUser('lin-list-forker');
    const older = await seedChild(forker, id, { title: '古い改造', publishedAt: 100 });
    const newer = await seedChild(forker, id, { title: '新しい改造', publishedAt: 200 });

    const body = await (await open(workPagePath(id))).text();

    expect(body).toContain('このゲームからのフォーク: 2 件');
    expect(body).toContain(`<a class="gf-link-quiet" href="${workPagePath(newer)}">新しい改造</a>`);
    expect(body).toContain(`<a class="gf-link-quiet" href="${workPagePath(older)}">古い改造</a>`);
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

    expect(body).toContain('このゲームからのフォーク: 1 件');
    expect(body).toContain(`<a class="gf-link-quiet" href="${workPagePath(shown)}">公開された改造</a>`);
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
    expect(first).toContain('このゲームからのフォーク: 21 件');
    // 20 件だけ出て、21 件目（＝いちばん古い 1 件）は出ていない。
    expect(first).toContain(`<a class="gf-link-quiet" href="${workPagePath(newestFirst[19]!)}">改造 1</a>`);
    // **行き先だけで見る**（クラスの綴りに依らず、21 件目へのリンクが 1 本も無いこと）。
    expect(first).not.toContain(`href="${workPagePath(newestFirst[20]!)}"`);

    const morePath = `${workPagePath(id)}?${FORKS_OFFSET_PARAM}=${FORKS_PER_PAGE}`;
    // **小さい副のボタンである**（#474 / 仕様 2.5.5）。
    expect(first).toContain(`<a class="gf-button gf-button-secondary gf-button-sm" href="${morePath}">もっと見る</a>`);

    // **画面に出ているリンクをそのまま辿る**（テストが URL を組み立て直すと、
    // 画面の綴りが変わっても緑のままになる）。
    const second = await (await open(morePath)).text();
    expect(second).toContain(`<a class="gf-link-quiet" href="${workPagePath(newestFirst[20]!)}">改造 0</a>`);
    // 2 頁目には次が無いので「もっと見る」は出ない。
    expect(second).not.toContain('もっと見る');
    // 戻る道はある。
    expect(second).toContain(`<a class="gf-button gf-button-secondary gf-button-sm" href="${workPagePath(id)}">前へ</a>`);
  });

  it('改造が 1 件も無ければ 0 件と言い、一覧は出さない', async () => {
    const { id } = await seedPublishedWork('empty');
    const body = await (await open(workPagePath(id))).text();
    // **見出しを消さない。**「まだ誰も改造していない」と「機能が無い」を区別できる形にする。
    expect(body).toContain('このゲームからのフォーク: 0 件');
    // **クラスの綴りの前方だけで見る**（#474 で `gf-block gf-block-rows` が足された。完全一致だと空振りする）。
    expect(body).not.toContain('<ul class="gf-fork-list');
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

    expect(body).toContain('このゲームからのフォーク: 1 件');
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
    expect(body).not.toContain('このゲームからのフォーク');
  });
});

describe('公開をやめて下書きへ戻す（5.4 / 確定35 / #637。もとは #35 の tombstone 化）', () => {
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
      new Request(`${APP_ORIGIN}${WORK_UNPUBLISH_PATH}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ [WORK_UNPUBLISH_GAME_ID_FIELD]: gameId }).toString(),
      }),
      testEnv(),
    );
  }

  it('作者にだけ取り下げの口が出る', async () => {
    const { userId, id } = await seedPublishedWork('cta');
    const stranger = await seedUser('rm-cta-stranger');

    const mine = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(mine).toContain(`action="${WORK_UNPUBLISH_PATH}"`);
    expect(mine).toContain(`<input type="hidden" name="${WORK_UNPUBLISH_GAME_ID_FIELD}" value="${id}">`);
    // **連鎖しないことを押す前に書く**（5.3「連鎖削除は荒れるため採らない」）。
    expect(mine).toContain('そのまま公開されたままです');

    // 押しても 404 になる口を、他人へ出さない。
    const theirs = await (await open(workPagePath(id), await sessionCookie(stranger))).text();
    expect(theirs).not.toContain(WORK_UNPUBLISH_PATH);
    const anon = await (await open(workPagePath(id))).text();
    expect(anon).not.toContain(WORK_UNPUBLISH_PATH);
  });

  it('公開をやめると作品ページへ戻り、下書きになる。子は published のまま残る（#35 / #637 の acceptance）', async () => {
    const parent = await seedPublishedWork('cascade');
    const child = await seedPublishedWork('cascade-child', parent.id);

    const response = await postRemove(parent.id, await sessionCookie(parent.userId));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(parent.id));

    const rows = await env.DB.prepare('select id, status from games where id in (?, ?)')
      .bind(parent.id, child.id)
      .all<{ id: string; status: string }>();
    const byId = new Map(rows.results.map((row) => [row.id, row.status]));
    // **`removed` にしない**（#637 / 確定35）。下書きなら「あなたの作品」から辿れる。
    expect(byId.get(parent.id)).toBe('draft');
    // **連鎖しない。**
    expect(byId.get(child.id)).toBe('published');
  });

  it('下書きへ戻した作品のページに、公開の口とリフォージの口が戻る（#637 の acceptance）', async () => {
    const { userId, id } = await seedPublishedWork('back-to-draft');
    await postRemove(id, await sessionCookie(userId));

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **公開し直せる。**
    expect(body).toContain('公開して共有');
    // **リフォージも版の復元も、下書きと同じ条件で通る**（`src/revisions.ts` は `status = 'draft'` で引く）。
    expect(body).toContain(REVISE_PATH);
    // **公開をやめる口は、もう出ない**（公開中ではない）。
    expect(body).not.toContain(`action="${WORK_UNPUBLISH_PATH}"`);
  });

  it('親が下書きへ戻ると、子は「まだ公開されていない作品から派生」になる（#35 / #637）', async () => {
    const parent = await seedPublishedWork('parent-line');
    const child = await seedPublishedWork('parent-line-child', parent.id);

    // 公開をやめる前は、親の題名がリンクとして出ている。
    const before = await (await open(workPagePath(child.id))).text();
    expect(before).toContain(`元ゲーム: <a href="${workPagePath(parent.id)}">`);

    await postRemove(parent.id, await sessionCookie(parent.userId));

    const after = await (await open(workPagePath(child.id))).text();
    // **「削除済み」ではない**（親は消えていない。`removed` は運営の措置と退会の状態である）。
    expect(after).toContain('元ゲーム: まだ公開されていない作品から派生');
    // **題名は出さない**（プロンプト由来。公開していない作品の題名は本人にしか出さない）。
    expect(after).not.toContain(`<a href="${workPagePath(parent.id)}">`);
  });

  it('親が tombstone（運営の措置）なら、子は「削除済みの作品から派生」のまま（#35 の acceptance）', async () => {
    const parent = await seedPublishedWork('parent-line-removed');
    const child = await seedPublishedWork('parent-line-removed-child', parent.id);

    await markGameRemoved(parent.id);

    const after = await (await open(workPagePath(child.id))).text();
    expect(after).toContain('元ゲーム: 削除済みの作品から派生');
  });

  it('tombstone のページは、誰にでも公開されていないと言う', async () => {
    const { userId, id } = await seedPublishedWork('tombstone-page');
    await markGameRemoved(id);

    const anon = await (await open(workPagePath(id))).text();
    // **404 にしない。** 子のページが「削除済みの作品から派生」と言っている以上、
    // 公開が止まっていることは既に公開の事実である。
    expect(anon).toContain('この作品は公開されていません');
    // **段落を閉じる。** ブラウザの自動補正に寄りかからない（他の枝はどれも閉じている）。
    expect(anon).toContain('<p>この作品は公開を停止しています。</p>');
    // 題名（プロンプト由来）は出さない。
    expect(anon).not.toContain('作品 tombstone-page');

    const owner = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(owner).toContain('この作品は公開されていません');
    expect(owner).toContain('そのまま公開されたままです');
    // **「あなたが取り下げました」と言わない**（#637。この状態を作るのは作者ではない）。
    expect(owner).not.toContain('あなたが取り下げました');
  });

  it('tombstone に、公開・改造・撮り直しの口を出さない', async () => {
    const { userId, id } = await seedPublishedWork('no-cta');
    await markGameRemoved(id);

    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    // **押せば `publishGame` が `removed` で断る操作を、押せる形で出さない。**
    expect(body).not.toContain('公開して共有');
    expect(body).not.toContain(FORK_PATH);
    expect(body).not.toContain(REVISE_PATH);
    // `/p/` は removed を返さないので、試遊 URL も出さない。
    expect(body).not.toContain('/p/');
    // 公開をやめる口も、もう出ない。
    expect(body).not.toContain(WORK_UNPUBLISH_PATH);
  });

  it('他人は公開をやめられない（作品は無傷のまま）', async () => {
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
  // 作品が読むキー（#494）。**既定は空＝パッドを出さない**（表示規則は `test/virtual-pad.test.ts`、覆いの HTML は `test/work-play.test.ts`）。
  inputKeyCodes: [],
  // 押し続けて読むキー（#530）。既定は null（版 1 の行と同じ扱い＝十字。キーが空なのでパッドは出ない）。
  inputHeldCodes: null,
  // 同じ条件式で読むキーの組（#543）。既定は null（版 2 以下の行と同じ扱い＝今の規則 5 のまま）。
  inputAliasGroups: null,
  // 作品のおすすめの向き（#514）。既定は null（版 3 以下の行・正方形と同じ扱い＝向きの操作をしない）。
  playOrientation: null,
  workId: '00000000-0000-4000-8000-000000000001',
  publishableId: null,
  forkableId: null,
  shareUrl: null,
  imageUrl: null,
  imagePath: null,
  authorName: null,
  authorPageId: null,
  authorIsOperator: false,
  parent: { kind: 'none' },
  forks: { total: 0, items: [], morePath: null, backPath: null },
  signedIn: false,
  revisable: false,
  dailyRemaining: null,
  revisionRunning: false,
  revisionStalled: false,
  revisionError: null,
  revisions: [],
  recapturableId: null,
  // 改名の口（5.4 / #366）。**既定は出さない**（作者にだけ出る。
  // 出し分けそのものは `test/title-rename.test.ts` が見る）。
  renamableId: null,
  // 説明（#388）。**既定は出さない**（公開済みのときだけ入り、フォームは作者にだけ出る。
  // 出し分けそのものは `test/work-description.test.ts` が見る）。
  description: null,
  describableId: null,
  // タグ（#376）。**既定はタグ無し・口を出さない**（出し分けそのものは `test/work-tags.test.ts` が見る）。
  tags: [],
  retaggableId: null,
  unpublishableId: null,
  deletableId: null,
  likeCount: 0,
  // プレイ数（#377）。**既定は数を出さず、数えるスクリプトも置かない。**
  playCount: 0,
  playCountableId: null,
  likableId: null,
  unlikableId: null,
  // 詳細情報パネル（#383）。**既定は出さない**（公開済み・取り下げていない作品のときだけ入る）。
  details: null,
};

/**
 * 詳細情報パネルを出すときの値（#383）。描画だけを見る検査で使う。
 *
 * @param gameId 作品 id
 * @returns パネルの値
 */
function sampleDetails(gameId = '00000000-0000-4000-8000-0000000000aa'): WorkDetails {
  return { gameId, createdAt: 1, publishedAt: 2, wasmBytes: null, sourcePath: null };
}

/**
 * いいねのボタンの隣に出る数（#340。#383 でも位置を変えていない）。
 *
 * @param count いいねの数
 * @returns HTML の断片
 */
function likeRow(count: number): string {
  return `<p class="gf-likes">いいね ${count}</p>`;
}

/**
 * 詳細情報パネルのいいねの行（#383。ボタンの隣の数と同じ値を並べる）。
 *
 * @param count いいねの数
 * @returns HTML の断片
 */
function panelLikeRow(count: number): string {
  return `<div><dt>いいね</dt><dd>${count}</dd></div>`;
}

/**
 * 詳細情報パネルのプレイ数の行（#383）。
 *
 * @param count プレイ数
 * @returns HTML の断片
 */
function playRow(count: number): string {
  return `<div class="gf-plays"><dt>プレイ</dt><dd>${count}</dd></div>`;
}

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
    // `<title>` は本文ではないので数えない（タブ名と見出しは別の役目である）。**パンくずの
    // 末尾（いまの画面の名前）も外枠なので数えない**（#372。外枠は `test/page-shell.test.ts`）。
    const html = pageBodyOf(renderWorkPage({ ...baseView, title: 'よけて跳ねる箱' }));
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
  const MARK_ELEMENT = `<span class="gf-chip gf-operator">${OPERATOR_MARK}</span>`;

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

  /**
   * 期待する作者の行を組み立てる（#330 で作者名が作者ページへのリンクになった）。
   *
   * **写す範囲を 1 か所に閉じている。** 以下の it は**行を全体で比べる**（部分一致に
   * しない——空白 1 つ・空の `<span>` 1 つが足されても落ちる形を保つ）ので、綴りは
   * どこかに要る。**4 か所に散らすと、印やリンクの位置を変えたときに 3 か所だけ直す
   * 事故が起きる。**
   *
   * **`authorPagePath` は借りる**（`src/users-page-paths.ts`）。`/users/` の綴りを
   * 検査へ書き写すと、変えた日に検査だけが古い綴りを見続ける。
   *
   * **構造は `<strong><a>名前</a></strong>印 である。** リンクは `<strong>` の内側、
   * **印は `<strong>` の外＝リンクの外**である（押した先が作者ページになる印を作らない）。
   *
   * @param userId 作者の id
   * @param name 表示名（**エスケープ前**。この関数が通す）
   * @param mark 名前の後ろに続く印（運営バッジ。既定は無し）
   * @returns `<p class="gf-author">…</p>`
   */
  function expectedAuthorLine(userId: string, name: string, mark = ''): string {
    const link = `<a class="gf-author-link gf-link-quiet" href="${authorPagePath(userId)}">${escapeHtml(name)}</a>`;
    return `<p class="gf-author">作者: <strong>${link}</strong>${mark}</p>`;
  }

  it('フラグが立った作者の作品ページには、名前の隣に印が出る', async () => {
    const { userId, id } = await seedPublished('op-flagged');
    await markOperator(userId);

    const body = await (await open(workPagePath(id))).text();

    // 印は `<strong>`（利用者が決めた名前）の**外**、同じ行の中にある。
    // **リンク（#330）は `<strong>` の内側である**——印の「外」の意味を動かさない。
    expect(authorLine(body)).toBe(expectedAuthorLine(userId, 'op-flagged', ` ${MARK_ELEMENT}`));
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

    // **印に関わるものが 1 バイトも足されていない行である。** 部分一致ではなく全体で
    // 比べる——空白 1 つ・空の `<span>` 1 つが足されても落ちる。
    //
    // **#334 の時点の期待値は `<strong>op-default</strong>` だった**（「#334 の前と
    // 1 バイトも違わない」）。#330 が作者名をリンクにしたので、その 1 点だけが変わって
    // いる。**印については変わっていないこと**を、下の 2 行と合わせて見る。
    expect(authorLine(body)).toBe(expectedAuthorLine(userId, 'op-default'));
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
   * @returns 作品ページの HTML と、作者の id（作者ページのリンクの期待値に要る）
   */
  async function openAsRenamed(
    suffix: string,
    name: string,
  ): Promise<{ body: string; userId: string }> {
    const { userId, id } = await seedPublished(suffix);
    const result = await env.DB.prepare('update users set display_name = ? where id = ?')
      .bind(name, userId)
      .run();
    // **書き換えが当たったことを先に確かめる。** 0 行の UPDATE だと名前は
    // `op-disguise-*` のままで、下の「印が無い」は**なりすましを 1 度も試さずに**通る。
    expect(result.meta.changes, name).toBe(1);
    return { body: await (await open(workPagePath(id))).text(), userId };
  }

  it('名前で「運営」と名乗っても印は出ない（名前で判定しない）', async () => {
    // 仕様 5.9（#341）以後は、誰でも表示名を自由に決められる。**名前が何であっても、
    // フラグが立っていなければ印の要素は 1 つも現れない。**
    const disguises = ['運営', OPERATOR_MARK, `（${OPERATOR_MARK}）`, `運営 ${OPERATOR_MARK}`];
    for (const [index, name] of disguises.entries()) {
      const { body, userId } = await openAsRenamed(`op-disguise-${index}`, name);

      expect(body, name).not.toMatch(BADGE_ELEMENT);
      // 名前は `<strong>` の中にだけ現れ、行はそこで終わる。**書き換えた名前そのもの**が
      // 出ていることも見る（元の名前のままなら、ここで落ちる）。
      expect(authorLine(body), name).toBe(expectedAuthorLine(userId, name));
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
      const { body, userId } = await openAsRenamed(`op-inject-${index}`, name);

      expect(body, name).not.toMatch(BADGE_ELEMENT);
      // **リンクの中でもエスケープされる**（#330）。名前は `<a>` の中身になるだけで、
      // `href` は `authorPagePath` が組み立てた値のままである。
      expect(authorLine(body), name).toBe(expectedAuthorLine(userId, name));
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

  it('作者名そのものが作者ページへのリンクになる（#330）', async () => {
    const { userId, id } = await seedPublished('op-author-link');
    const body = await (await open(workPagePath(id))).text();
    expect(body).toContain(`href="${authorPagePath(userId)}"`);
    // **リンクは `<strong>` の内側、中身は名前だけである。** 行き先が 1 行に 2 つ
    // 並んでいないこと（ラベル付きのリンクを別に置いていないこと）も、行を全体で
    // 比べることで固定される。
    expect(authorLine(body)).toBe(expectedAuthorLine(userId, 'op-author-link'));
    expect(body.match(/gf-author-link/gu) ?? []).toHaveLength(1);
  });

  it('印はリンクの外にある（押した先が作者ページになる印を作らない。#330 / #334）', async () => {
    const { userId, id } = await seedPublished('op-link-and-mark');
    await markOperator(userId);
    const body = await (await open(workPagePath(id))).text();
    const line = authorLine(body);

    expect(line).toBe(expectedAuthorLine(userId, 'op-link-and-mark', ` ${MARK_ELEMENT}`));
    // **`</a>` が印より前に来る**（＝印は `<a>` の中に無い）。綴りの全体比較でも
    // 押さえているが、**何を守っているのかを名指しで 1 行にしておく。**
    expect(line.indexOf('</a>')).toBeLessThan(line.indexOf('gf-operator'));
    // リンクは 1 本だけである（印を足したことで 2 本になっていない）。
    expect(body.match(/gf-author-link/gu) ?? []).toHaveLength(1);
  });

  it('作者の行が引けていなければリンクにしない（404 へ送らない。#330）', () => {
    // **`author_id` は NOT NULL の外部キー**なので通常は当たるが、当たらなかったときに
    // **リンクだけが残ると押した人を必ず 404 へ送る**（作者ページは存在しない利用者を
    // 404 にする）。経路側は `published && row.author_name !== null` で畳んでおり、
    // ここは描画側が `authorPageId` の真偽だけで決めることを見る。
    const view: WorkPageView = {
      ...baseView,
      published: true,
      authorName: null,
      authorPageId: null,
      forkableId: '00000000-0000-4000-8000-000000000000',
    };
    expect(renderWorkPage(view)).not.toContain('gf-author-link');
    expect(renderWorkPage(view)).toContain('<strong>不明</strong>');
    // 空振りしないことを対で見る（id を渡せば出る）。
    expect(
      renderWorkPage({ ...view, authorPageId: '00000000-0000-4000-8000-0000000000aa' }),
    ).toContain('gf-author-link');
  });

  it('リンクの中でも表示名がエスケープされる（5.9 / #330）', async () => {
    // **リンクにしたことでエスケープが抜けていないこと。** `<a>` の中身になっても
    // `escapeHtml` を通る（`test/display-name-escape.test.ts` が経路でも見ている）。
    const hostile = `"'><script>alert(1)</script>`;
    const { body, userId } = await openAsRenamed('op-link-escape', hostile);
    expect(body).not.toContain(hostile);
    expect(authorLine(body)).toBe(expectedAuthorLine(userId, hostile));
    // **`href` は名前から作られていない**（`authorPagePath` が組み立てた値である）。
    expect(body).toContain(`href="${authorPagePath(userId)}"`);
  });

  it('未公開の作品ページには作者ページへのリンクも出ない（名前を出さない画面である）', async () => {
    const { userId, id } = await seedPending('op-draft-link');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('gf-author-link');
    expect(body).not.toContain(authorPagePath(userId));
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
    expect(body).toContain(likeRow(3));
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
    expect(body).toContain(likeRow(1));
    expect(body).not.toContain(likeRow(99));
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
    expect(before.body).not.toContain(likeRow(1));

    const at = Math.floor(Date.now() / 1000);
    expect(await changeLike(env, 'like', fan, id, at)).toBe('liked');
    const liked = await openRecording(workPagePath(id), cookie);
    expect(liked.body).toMatch(CANCEL_FORM);
    expect(liked.body).not.toMatch(LIKE_FORM);
    expect(liked.body).toContain(likeRow(1));

    expect(await changeLike(env, 'unlike', fan, id, at)).toBe('unliked');
    const cancelled = await openRecording(workPagePath(id), cookie);
    expect(cancelled.body).toMatch(LIKE_FORM);
    expect(cancelled.body).not.toMatch(CANCEL_FORM);
    expect(cancelled.body).not.toContain(likeRow(1));
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
    expect(body).toContain(likeRow(1));
  });

  it('審査で新規露出を止めた作品にはボタンを出さない（口が 404 にするものを出さない）', async () => {
    const { id } = await seedPublished('review');
    const fan = await seedUser('like-review-fan');
    const cookie = await sessionCookie(fan);

    // 止める前は出る（**この検査が空振りしていない**ことを先に見る）。
    expect((await openRecording(workPagePath(id), cookie)).body).toMatch(LIKE_FORM);

    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, id)
      .run();
    // **行数ではなく、行を読み直して確かめる**（#378。`games` の検索の索引のトリガが書いた行も
    // `meta.changes` に数えられ、1 にならない）。
    const queued = await env.DB.prepare('select review_state from games where id = ?')
      .bind(id)
      .first<{ review_state: string | null }>();
    expect(queued?.review_state).toBe(REVIEW_QUEUED);

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
    await markGameRemoved(id);

    const { body, touched } = await openRecording(workPagePath(id), await sessionCookie(fan));

    expect(touched, '取り下げた作品で DO を呼んでいる').toEqual([]);
    // **本文だけを見る。** ヘッダのアカウントのメニューが「いいねした作品」を持つ（#372）。
    expect(pageBodyOf(body)).not.toContain('いいね');
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
    const removed = renderWorkPage({
      ...baseView,
      removed: true,
      likeCount: 4,
      likableId: id,
      details: sampleDetails(id),
    });
    expect(removed).not.toContain(likeRow(4));
    expect(removed).not.toMatch(LIKE_FORM);
    // 同じ view で `removed` だけを倒すと出る（この検査が空振りしていない）。
    const shown = renderWorkPage({
      ...baseView,
      published: true,
      removed: false,
      likeCount: 4,
      likableId: id,
      details: sampleDetails(id),
    });
    expect(shown).toContain(likeRow(4));
    expect(shown).toMatch(LIKE_FORM);
  });

  it('未公開の作品ページには数もボタンも出さず、DO も呼ばない', async () => {
    const { userId, id } = await seedPending('like-draft');
    await setStoredLikeCount(id, 5);

    const { body, touched } = await openRecording(workPagePath(id), await sessionCookie(userId));

    expect(touched).toEqual([]);
    // **本文だけを見る。** ヘッダのアカウントのメニューが「いいねした作品」を持つ（#372）。
    expect(pageBodyOf(body)).not.toContain('いいね');
  });

  it('描画は view の 3 つの値だけで決まる（画面側で押せるかを組み立てていない）', () => {
    // 経路を通さず `renderWorkPage` に直に渡す。**経路側の条件を全部満たしていない
    // view でも、載っていればそのまま描く**——押せるかの判定は窓口が持つ（5.8）。
    const id = '00000000-0000-4000-8000-000000000001';
    const view: WorkPageView = { ...baseView, published: true, forkableId: id, details: sampleDetails(id) };

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
    expect(renderWorkPage({ ...view, likeCount: 1 })).toContain(likeRow(1));
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

describe('プレイ数（#377 / 仕様 2.3.6）', () => {
  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`play-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-play-${suffix}` }));
    const published = await publishGame(env, id, userId);
    expect(published.ok).toBe(true);
    return { userId, id };
  }

  /**
   * プレイ数の DO のバインディングへの触り方を記録する env を作る（いいねの `recordingHubEnv` と
   * 同じ形。**プロパティへ 1 度も触っていなければ呼んでいない**）。
   *
   * @returns 差し替えた env と、触ったプロパティ名の記録
   */
  function recordingPlayHubEnv(): { env: Env; touched: string[] } {
    const touched: string[] = [];
    const proxy = new Proxy(env.PLAY_HUB as unknown as object, {
      get(target, property) {
        if (typeof property === 'string') {
          touched.push(property);
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      env: { ...env, SESSION_SECRET: SECRET, PLAY_HUB: proxy } as unknown as Env,
      touched,
    };
  }

  it('0 なら出さず、1 以上なら詳細情報パネルにいいねの数と並べて出す（#383 で移した）', () => {
    const published = { ...baseView, published: true, details: sampleDetails() };
    expect(renderWorkPage({ ...published, playCount: 0 })).not.toContain('gf-plays');
    const body = renderWorkPage({ ...published, playCount: 8, likeCount: 2 });
    // **パネルのいいねの行の直後に置く**（#377 ではボタンの隣でいいねの直前だった。#383 でパネルの行になった）。
    expect(body).toContain(`${panelLikeRow(2)}\n${playRow(8)}`);
    // いいねの数はボタンの隣にも残る（5.8 の対。同じ値）。
    expect(body).toContain(likeRow(2));
    // **同じ数を 2 か所に出さない**（パネルの外にプレイ数の表示が残っていない）。
    expect(body.split('gf-plays').length - 1).toBe(1);
    expect(body).not.toContain('プレイ 8');
  });

  it('公開済みの作品ページは D1 の写しを出し、計上のスクリプトを iframe の直前に置き、DO を呼ばない', async () => {
    const { id, userId } = await seedPublished('shown');
    const updated = await env.DB.prepare('update games set play_count = 5 where id = ?').bind(id).run();
    expect(updated.meta.changes).toBe(1);

    for (const cookie of [undefined, await sessionCookie(userId)]) {
      const recording = recordingPlayHubEnv();
      const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
      const response = await dispatch(
        workPageRoutes,
        new Request(`${APP_ORIGIN}${workPagePath(id)}`, { headers }),
        recording.env,
      );
      const body = await response.text();

      // **画面の経路は DO を呼ばない**（数えるのはブラウザのスクリプトで、口は別にある）。
      expect(recording.touched, 'プレイ数の DO に触れている').toEqual([]);
      expect(body).toContain(playRow(5));
      // スクリプトは 1 つで、中身は窓口が組み立てたものそのままである（書き写さない）。
      expect(body).toContain(playReportScript(id));
      expect(body.split(`fetch(${JSON.stringify(PLAY_PATH)}`).length - 1).toBe(1);
      // **iframe の直前**（合図より先にリスナーを登録する。PR #425 の Copilot の指摘）。ヘッダには置かない。
      // #502 から iframe はスクリプトが作り、デスクトップでは `<noscript>` の直前（＝計上のスクリプトの直後）に入る。
      expect(body).toContain(`${playReportScript(id)}\n<noscript class="gf-play-noscript"><iframe class="gf-frame"`);
      expect(body.indexOf('</header>')).toBeLessThan(body.indexOf(playReportScript(id)));
      // 数える iframe は `/g/` を指し、`sandbox` は `allow-scripts` だけのまま（7.2）。
      expect(body).toContain(`src="https://${env.SANDBOX_HOST}/g/${id}/" sandbox="allow-scripts"`);
    }
  });

  it('未公開（試遊の /p/）と取り下げた作品には、数もスクリプトも出さない', async () => {
    const draft = await seedPending('play-draft');
    await claimGenerationJob(env, draft.id, await hashJobToken(draft.jobToken));
    await completeGame(env, draft.id, fakeBuildOutcome({ sourceSha256: 'sha-play-draft' }));
    await env.DB.prepare('update games set play_count = 9 where id = ?').bind(draft.id).run();
    // **作者が試遊する `/p/` は数えない**（iframe はあるがスクリプトを置かない）。
    const draftBody = await (await open(workPagePath(draft.id), await sessionCookie(draft.userId))).text();
    expect(draftBody).toContain('/p/');
    expect(draftBody).not.toContain(PLAY_PATH);
    expect(draftBody).not.toContain('gf-plays');

    const { id, userId } = await seedPublished('removed');
    await env.DB.prepare('update games set play_count = 9 where id = ?').bind(id).run();
    await markGameRemoved(id);
    const removedBody = await (await open(workPagePath(id))).text();
    expect(removedBody).not.toContain(PLAY_PATH);
    expect(removedBody).not.toContain('gf-plays');
  });

  it('プレイ数の見た目は app.css に規則を持ち、色の値を直に書かない', () => {
    for (const selector of ['gf-plays', 'gf-card-plays']) {
      const rule = new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'mu').exec(env.TEST_APP_CSS);
      expect(rule, `app.css に .${selector} の規則が無い`).not.toBeNull();
      expect(rule![1]!, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    }
  });
});

describe('詳細情報パネル（#383 / 仕様 2.3.12）', () => {
  /** 64 桁の 16 進（本番のキャッシュ鍵と同じ形。キーの綴り `builds/<sha>/...` を本番に揃える）。 */
  function randomSha(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }

  /**
   * 公開済みの作品を 1 件用意する（**`build_cache` の行も `completeGame` が書く**）。
   *
   * @param suffix テスト内で一意な接尾辞
   * @param sha ソースの SHA-256
   * @returns 作者の id と作品 id
   */
  async function seedPublished(
    suffix: string,
    sha: string = randomSha(),
  ): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`details-${suffix}`, `パネル${suffix}\n本文`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: sha }));
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    return { userId, id };
  }

  /**
   * 本文からパネルだけを取り出す。
   *
   * @param body 画面の HTML
   * @returns パネルの HTML（無ければ null）
   */
  function panelOf(body: string): string | null {
    return /<aside class="gf-details[ "][\s\S]*?<\/aside>/u.exec(body)?.[0] ?? null;
  }

  it('来歴を並べる（作品 ID・日時・元ゲーム・配信サイズ・改造された数・いいね・プレイ）とソースへのリンク', async () => {
    const parent = await seedPublished('parent');
    const { id } = await seedPublished('shown');
    await env.DB.prepare('update games set parent_id = ?, like_count = 3, play_count = 12 where id = ?')
      .bind(parent.id, id)
      .run();
    // 親の側から見て、改造された数が実件数で出る（`fork_count` 列は読まない。5.5）。
    await env.DB.prepare('update games set fork_count = 99 where id = ?').bind(parent.id).run();

    const panel = panelOf(await (await open(workPagePath(id))).text());
    expect(panel, 'パネルが無い').not.toBeNull();
    expect(panel).toContain(`<dt>作品 ID</dt><dd><code>${id}</code></dd>`);
    expect(panel).toMatch(/<dt>生成日時<\/dt><dd><time datetime="[^"]+">\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>/u);
    expect(panel).toMatch(/<dt>公開日時<\/dt><dd><time datetime="[^"]+">/u);
    expect(panel).toContain(`<dt>元ゲーム</dt><dd><a href="${workPagePath(parent.id)}">パネルparent</a></dd>`);
    // `fakeBuildOutcome` の圧縮後のバイト数（2,282,839）。**配信している大きさ**である。
    expect(panel).toContain('<dt>Wasm のサイズ</dt><dd>2.3 MB（配信時の圧縮後）</dd>');
    expect(panel).toContain('<dt>フォークされた数</dt><dd>0 件</dd>');
    expect(panel).toContain(panelLikeRow(3));
    expect(panel).toContain(playRow(12));
    expect(panel).toContain(
      `<a class="gf-button gf-button-secondary gf-button-sm" href="${workSourcePath(id)}">ソースコードを見る</a>`,
    );
    // **項目名と値の並び（`.gf-kv`）で、パネルは面のブロックである**（#474 / 仕様 2.5.4）。
    expect(panel).toContain('<aside class="gf-details gf-block"');
    expect(panel).toContain('<dl class="gf-kv">');
    // **モデル名の行は無い**（確定27。作品からモデルへ辿れない）。
    expect(panel).not.toContain('モデル');

    const parentPanel = panelOf(await (await open(workPagePath(parent.id))).text());
    expect(parentPanel).toContain('<dt>フォークされた数</dt><dd>1 件</dd>');
  });

  it('ロード中画面と枠は全幅のまま、その下を「本文 | パネル」にする（本文が先）', async () => {
    const { id } = await seedPublished('layout');
    const body = await (await open(workPagePath(id))).text();
    const split = body.indexOf('<div class="gf-split-end">');
    expect(split, '2 カラムの器が無い').toBeGreaterThan(0);
    // 枠・ロード中画面は器より前（全幅）。
    expect(body.indexOf('<iframe class="gf-frame"')).toBeLessThan(split);
    expect(body.indexOf('<div class="gf-context gf-block">')).toBeLessThan(split);
    // 本文（改造の一覧）が先、パネルが後（狭い段では本文の下に積まれる）。
    const main = body.indexOf('<div class="gf-work-main">');
    expect(main).toBeGreaterThan(split);
    expect(body.indexOf('このゲームからのフォーク')).toBeGreaterThan(main);
    expect(body.indexOf('<aside class="gf-details gf-block"')).toBeGreaterThan(body.indexOf('このゲームからのフォーク'));
    // 説明（#388）はパネルに入れない。
    expect(panelOf(body)).not.toContain('作品の説明');
  });

  it('審査で新規露出を止めた作品では、パネルは出すがソースへのリンクを出さない', async () => {
    const { id } = await seedPublished('queued');
    expect(panelOf(await (await open(workPagePath(id))).text())).toContain(workSourcePath(id));

    await env.DB.prepare('update games set review_state = ? where id = ?').bind(REVIEW_QUEUED, id).run();
    const panel = panelOf(await (await open(workPagePath(id))).text());
    expect(panel, 'パネルごと消えている').not.toBeNull();
    // **押せば 404 になるリンクを出さない**（4.4）。変異: `row.review_visible === 1 &&` を外すと赤。
    expect(panel).not.toContain(workSourcePath(id));
    expect(panel).not.toContain('ソースコードを見る');
  });

  it('未公開と取り下げた作品にはパネルを出さない', async () => {
    const draft = await seedPending('details-draft');
    await claimGenerationJob(env, draft.id, await hashJobToken(draft.jobToken));
    await completeGame(env, draft.id, fakeBuildOutcome({ sourceSha256: randomSha() }));
    const draftBody = await (await open(workPagePath(draft.id), await sessionCookie(draft.userId))).text();
    expect(panelOf(draftBody)).toBeNull();
    expect(draftBody).not.toContain(workSourcePath(draft.id));

    const { id, userId } = await seedPublished('removed');
    await markGameRemoved(id);
    const removedBody = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(panelOf(removedBody)).toBeNull();
    expect(removedBody).not.toContain(workSourcePath(id));
  });

  it('索引の行が引けない・別の成果物を指すときは、サイズの行ごと出さない（0 と書かない）', async () => {
    const sha = randomSha();
    const { id } = await seedPublished('no-index', sha);
    expect(panelOf(await (await open(workPagePath(id))).text())).toContain('Wasm のサイズ');

    // Go の更新などで、同じソースの索引が別の成果物を指すようになった場合。
    // 変異: 結合から `and b.wasm_key = g.wasm_key` を外すと、別の成果物のサイズが出て赤（2026-09-13）。
    await env.DB.prepare('update build_cache set wasm_key = ? where source_sha256 = ?')
      .bind(`builds/${sha}/go9.99.9/game.wasm.br`, sha)
      .run();
    expect(panelOf(await (await open(workPagePath(id))).text())).not.toContain('Wasm のサイズ');

    await env.DB.prepare('delete from build_cache where source_sha256 = ?').bind(sha).run();
    const panel = panelOf(await (await open(workPagePath(id))).text());
    expect(panel).not.toBeNull();
    expect(panel).not.toContain('Wasm のサイズ');
  });

  it('build_cache は主キーで 1 行だけ引く（索引の全行を読まない）', async () => {
    // 変異: 結合を `on b.wasm_key = g.wasm_key` だけにすると `SCAN b` になって赤（2026-09-13）。
    const plan = await env.DB.prepare(`explain query plan ${WORK_ROW_SQL}`)
      .bind('00000000-0000-4000-8000-000000000383')
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    const cache = details.filter((detail) => /\bb\b/u.test(detail));
    expect(cache.length, details.join(' / ')).toBeGreaterThan(0);
    for (const detail of cache) {
      expect(detail, details.join(' / ')).toMatch(/^SEARCH b USING INDEX sqlite_autoindex_build_cache_1 \(source_sha256=\?\)/u);
    }
  });

  it('サイズの表記と、読めない値の倒し方', () => {
    expect(formatWasmSize(2_282_839)).toBe('2.3 MB');
    expect(formatWasmSize(1_000_000)).toBe('1.0 MB');
    expect(formatWasmSize(999_499)).toBe('999 KB');
    expect(formatWasmSize(12)).toBe('1 KB');
    for (const broken of [undefined, null, Number.NaN, '3', -1, 0]) {
      expect(storedWasmBytes(broken), String(broken)).toBeNull();
    }
    expect(storedWasmBytes(2_282_839.5)).toBe(2_282_839);
  });

  it('パネルの見た目は app.css の @section work に規則を持ち、色の値を直に書かない', () => {
    for (const selector of ['gf-details', 'gf-source']) {
      const rule = new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'mu').exec(env.TEST_APP_CSS);
      expect(rule, `app.css に .${selector} の規則が無い`).not.toBeNull();
      expect(rule![1]!, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    }
    // **ソースの `<pre>` だけを横に送り、ページ全体を横スクロールさせない。**
    const source = /^\.gf-source\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS)![1]!;
    expect(source).toContain('overflow-x: auto');
    expect(source).toContain('max-width: 100%');
  });
});

describe('公開フォームは「ソースも公開される」ことを押す前に言う（#383 の決定 1）', () => {
  it('公開のボタンと同じフォームの中に、ボタンより前にある', async () => {
    const { userId, id, jobToken } = await seedPending('publish-source-notice');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: 'sha-publish-source-notice' }));
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    const form = /<form method="post" action="[^"]*publish[^"]*">[\s\S]*?<\/form>/u.exec(body)?.[0] ?? '';
    expect(form, '公開フォームが無い').toContain('公開して共有');
    expect(form).toContain(PUBLISH_SOURCE_NOTICE);
    expect(form.indexOf(PUBLISH_SOURCE_NOTICE)).toBeLessThan(form.indexOf('<button'));
    expect(PUBLISH_SOURCE_NOTICE).toContain('ソースコード');
  });
});

describe('見た目の規約の部品（#474 / M13-10 / 仕様 2.5）', () => {
  /** 主のボタンの部品のクラス。**1 画面に 1 つまで**（仕様 2.5.5）。 */
  const PRIMARY = /\bgf-button-primary\b/gu;

  /**
   * 主のボタンの要素（`<a>` か `<button>`）をすべて拾う。
   *
   * @param html 画面の HTML（外枠を含む。ヘッダとフッタにも主を置かない）
   * @returns 要素の開始タグから閉じタグまで
   */
  function primaries(html: string): string[] {
    return html.match(/<(a|button)\b[^>]*\bgf-button-primary\b[^>]*>[\s\S]*?<\/\1>/gu) ?? [];
  }

  /**
   * 本文の `<button>` のうち、部品のクラスを持たないもの（`<button>` の既定の見た目に寄りかかっているもの）。
   *
   * **既定の見た目は M13 の最後の 1 本が副へ切り替える**ので、強さを部品で明示していないボタンは、切り替えの
   * 前後で見え方が変わる（主に見えたり、主が副に見えたりする）。外枠（ヘッダのメニューのログアウト）は #469 の範囲なので外す。
   *
   * @param html 画面の HTML
   * @returns 部品のクラスを持たない `<button>` の開始タグ
   */
  function bareButtons(html: string): string[] {
    return (pageBodyOf(html).match(/<button\b[^>]*>/gu) ?? []).filter((tag) => !/\bgf-button\b/u.test(tag));
  }

  /**
   * 公開済みの作品を 1 件用意する。
   *
   * @param suffix テスト内で一意な接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`parts-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: `sha-parts-${suffix}` }));
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    return { userId, id };
  }

  it('公開済みの作品ページの主のボタンは「改造する」の 1 つだけ（未ログイン・ログイン済み・作者本人）', async () => {
    const { userId, id } = await seedPublished('primary');
    const visitor = await seedUser('parts-primary-visitor');

    const anonymous = await (await open(workPagePath(id))).text();
    const member = await (await open(workPagePath(id), await sessionCookie(visitor))).text();
    const owner = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    // 未ログインは登録へ送る `<a>`（移動）、ログイン済みと作者は差分プロンプトの送信 `<button>`（動作）。
    expect(anonymous.match(PRIMARY) ?? []).toHaveLength(1);
    expect(primaries(anonymous)[0]).toMatch(/^<a class="gf-fork-link gf-button gf-button-primary" href="[^"]*from=fork-cta[^"]*">このゲームをフォークする<\/a>$/u);
    for (const [name, body] of [
      ['ログイン済み', member],
      ['作者本人', owner],
    ] as const) {
      expect(body.match(PRIMARY) ?? [], name).toHaveLength(1);
      expect(primaries(body)[0], name).toBe('<button type="submit" class="gf-button gf-button-primary">この内容でフォークする</button>');
      // **主はフォークのフォームの中にある**（見た目だけ主の別の送信ではない）。
      const fork = body.slice(body.indexOf(`action="${FORK_PATH}"`));
      expect(fork.slice(0, fork.indexOf('</form>')), name).toContain('gf-button-primary');
      expect(bareButtons(body), name).toEqual([]);
    }
    // 作者本人には設定の口（副のボタン）が並ぶが、主は増えない。
    expect(owner).toContain('<section class="gf-block gf-block-rows gf-work-settings" aria-label="作品の設定">');
    expect(owner).toContain('<button type="submit" class="gf-button gf-button-secondary">公開をやめて下書きに戻す</button>');
    expect(bareButtons(anonymous)).toEqual([]);
  });

  it('描画: 口がすべて出ている状態でも主は 1 つで、ほかの動作と導線は副（いいね・設定・通報・もっと見る・ソース）', () => {
    const id = '00000000-0000-4000-8000-000000000474';
    const body = renderWorkPage({
      ...baseView,
      published: true,
      owner: true,
      signedIn: true,
      dailyRemaining: 3,
      title: '題',
      playUrl: 'https://sandbox.example/g/x/',
      shareUrl: `https://app.example${workPagePath(id)}`,
      forkableId: id,
      reportableId: id,
      likableId: id,
      likeCount: 2,
      tags: ['action', 'puzzle'],
      description: '説明',
      recapturableId: id,
      renamableId: id,
      describableId: id,
      retaggableId: id,
      unpublishableId: id,
      forks: {
        total: 21,
        items: [{ id, title: '子', publishedAt: 1 }],
        morePath: `${workPagePath(id)}?${FORKS_OFFSET_PARAM}=${FORKS_PER_PAGE}`,
        backPath: workPagePath(id),
      },
      details: { ...sampleDetails(id), wasmBytes: 2_282_839, sourcePath: workSourcePath(id) },
    });

    expect(body.match(PRIMARY) ?? []).toHaveLength(1);
    expect(bareButtons(body)).toEqual([]);
    // いいね・もっと見る・前へ・ソース・通報は小さい副のボタン。設定の 5 つは副のボタン。
    expect(body).toContain(`<button type="submit" class="gf-button gf-button-secondary gf-button-sm">いいね</button>`);
    expect(body).toContain('<button type="submit" class="gf-button gf-button-secondary gf-button-sm">通報する</button>');
    for (const label of ['スクリーンショットを撮り直す', 'この名前にする', 'この説明にする', 'このタグにする', '公開をやめて下書きに戻す']) {
      expect(body, label).toContain(`<button type="submit" class="gf-button gf-button-secondary">${label}</button>`);
    }
    // 設定は 1 つのブロックの行で、並びは #474 の前と同じ（撮り直し → 作品名 → 説明 → タグ → 公開をやめる）。
    const settings = body.slice(body.indexOf('gf-work-settings'));
    // **見出しの属性を綴りに含めない**——改名の見出しは飛び先の `id` と `tabindex` を持つ（#600）。
    const order = ['スクリーンショット', '作品名を変える', '作品の説明を書く', 'タグを付け直す', '公開をやめる'].map((heading) =>
      settings.indexOf(`>${heading}</h3>`),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // タグはチップ、共有する URL はブロックの面、改造の一覧はブロックの行、パネルは `.gf-kv`。
    expect(body).toContain('<p class="gf-work-tags"><span class="gf-work-tags-label">タグ</span><a class="gf-chip"');
    expect(body).toContain(`<p class="gf-block gf-work-share-url"><code>https://app.example${workPagePath(id)}</code></p>`);
    expect(body).toContain('<ul class="gf-fork-list gf-block gf-block-rows">');
    expect(body).toContain('<aside class="gf-details gf-block" aria-labelledby="gf-details-heading">');
    expect(body).toContain('<div><dt>Wasm のサイズ</dt><dd>2.3 MB（配信時の圧縮後）</dd></div>');
    // 4 要素のブロックの並びは今のまま（スクリーンショット → 作者 → 元ゲーム → 改造する。3.4-5）。
    const context = body.slice(body.indexOf('<div class="gf-context gf-block">'), body.indexOf('<iframe'));
    const elements = ['gf-shot', '<p class="gf-author">', '<p class="gf-parent">', '<p class="gf-fork">'].map((needle) =>
      context.indexOf(needle),
    );
    expect(elements.every((at) => at > 0)).toBe(true);
    expect([...elements].sort((a, b) => a - b)).toEqual(elements);
    // **iframe の属性は変えない**（7.2）。
    expect(body).toContain('<iframe class="gf-frame" src="https://sandbox.example/g/x/" sandbox="allow-scripts" title="ゲーム"></iframe>');
  });

  it('描画: 本日の枠が尽きたログイン済みでは、主のボタンを出さない（押せない主を置かない。4.4）', () => {
    const id = '00000000-0000-4000-8000-000000000475';
    const body = renderWorkPage({ ...baseView, published: true, signedIn: true, dailyRemaining: 0, forkableId: id });
    expect(body.match(PRIMARY) ?? []).toHaveLength(0);
    expect(body).toContain('<p class="gf-fork">このゲームをフォークする</p>');
  });

  it('未公開の作品（作者）の主は「公開して共有」だけで、手直し・版に戻す・改名は副', async () => {
    const { userId, id, jobToken } = await seedPending('parts-draft');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: 'sha-parts-draft' }));
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    expect(primaries(body)).toEqual(['<button type="submit" class="gf-button gf-button-primary">公開して共有</button>']);
    expect(bareButtons(body)).toEqual([]);
    expect(body).toContain('<div class="gf-block gf-work-state">\n<h2>できました</h2>');
    expect(body).toContain('<button type="submit" class="gf-button gf-button-secondary">この名前にする</button>');
  });

  it('状態の知らせ（生成中・生成できませんでした・取り下げ・見つかりません）は面のブロック', async () => {
    const working = renderWorkPage({ ...baseView, state: 'working' });
    expect(working).toContain('<div class="gf-block gf-work-state">\n<h2>生成中です</h2>');
    const failed = renderWorkPage({ ...baseView, state: 'failed' });
    expect(failed).toContain('<div class="gf-block gf-work-state">\n<h2>生成できませんでした</h2>');
    const removed = renderWorkPage({ ...baseView, removed: true });
    expect(removed).toContain('<div class="gf-block gf-work-state">\n<h2>この作品は公開されていません</h2>');

    const missing = await (await open(workPagePath('00000000-0000-4000-8000-00000000dead'))).text();
    expect(missing).toContain('<h1>作品が見つかりません</h1>\n<p class="gf-block">URL が正しいかご確認ください。</p>');
  });

  it('作品の情報パネルと 4 要素のブロックの規則は、枠線・影・並べ替え・幅の断点を持たない（app.css の `@section work`）', () => {
    const css = env.TEST_APP_CSS;
    const start = css.indexOf('\n   @section work ');
    const end = css.indexOf('\n   @section ', start + 1);
    expect(start, '`@section work` が見つかりません').toBeGreaterThan(0);
    const section = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    for (const selector of ['.gf-details', '.gf-context', '.gf-context-body', '.gf-work-settings']) {
      const rules = [...section.matchAll(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'gu'))];
      expect(rules.length, `${selector} の規則が無い`).toBeGreaterThan(0);
      for (const rule of rules) {
        // 面で区切り、枠線も影も使わない（2.5.4）。**段で並べ替えない**（2.5.6 の #469 実装注記）。
        expect(rule[1], selector).not.toMatch(/(^|\s)border(-(top|right|bottom|left))?\s*:|box-shadow\s*:|order\s*:|display:\s*contents/u);
      }
    }
    // **補助カラムの幅は変えない**（`--gf-aside` を画面の区画で定義しない）。
    expect(section).not.toMatch(/--gf-aside\s*:/u);
  });
});

describe('仮想パッドのキーを読む（#494 / 仕様 3.9.5 / 3.9.6）', () => {
  /**
   * 公開済みの作品を 1 つ作り、その `source_key` を返す。
   *
   * @param suffix 利用者と作品を分ける接尾辞
   * @returns 作品 id と `games.source_key`
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string; sourceKey: string }> {
    const { userId, id, jobToken } = await seedPending(`pad-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    const sha = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: sha }));
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    const row = await env.DB.prepare('select source_key from games where id = ?').bind(id).first<{ source_key: string }>();
    expect(row?.source_key).toBe(`builds/${sha}/source.go`);
    return { userId, id, sourceKey: row!.source_key };
  }

  /**
   * 保存したキーの集合を置く（`codes` は文字列のまま入れる。壊れた値も入れられる）。
   *
   * @param sourceKey ソースの R2 キー
   * @param codes `source_input_keys.codes` の値
   */
  async function storeCodes(sourceKey: string, codes: string): Promise<void> {
    await env.DB.prepare(
      'insert or replace into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, 1, 1)',
    )
      .bind(sourceKey, codes)
      .run();
  }

  /**
   * 本文から、パッドのキー（`<button>`）の `data-code` を出てくる順に取り出す。
   *
   * @param body 作品ページの HTML
   * @returns `code` の並び
   */
  function padCodesOf(body: string): string[] {
    return [...body.matchAll(/<button type="button" class="[^"]*\bgf-play-pad-key\b[^"]*" data-code="([^"]*)"/gu)].map(
      (found) => found[1]!,
    );
  }

  it('保存したキーの集合から、表示規則のとおりに十字とボタンを出す', async () => {
    const { id, sourceKey } = await seedPublished('shown');
    await storeCodes(sourceKey, JSON.stringify(['ArrowLeft', 'ArrowRight', 'Enter', 'KeyA', 'Space']));
    const body = await (await open(workPagePath(id))).text();
    // 十字（上・左・右・下の順に、読む矢印だけ）→ ボタン（Space。Enter は Space があるので除く。WASD は矢印があるので出さない）。
    expect(padCodesOf(body)).toEqual(['ArrowLeft', 'ArrowRight', 'Space']);
    expect(body).toContain('data-code="ArrowLeft" aria-label="左">←</button>');
  });

  it('行が無い・壊れた JSON・配列でない・許可表外の値は、パッドを出さない（D1 の値を信じ切らない）', async () => {
    const { id, sourceKey } = await seedPublished('broken');
    // 行が無い（まだ拾っていない）。
    let body = await (await open(workPagePath(id))).text();
    expect(body, '覆いが無い（検査の前提が崩れている）').toContain('gf-play-overlay');
    expect(padCodesOf(body)).toEqual([]);
    expect(body).toContain('<div class="gf-play-pad gf-play-pad-dpad"></div>');

    for (const broken of ['not json', '{"codes":["Space"]}', '"Space"', '[]', 'null']) {
      await storeCodes(sourceKey, broken);
      body = await (await open(workPagePath(id))).text();
      expect(padCodesOf(body), broken).toEqual([]);
    }

    // 許可表外の値と文字列でない値は捨て、許可表の値だけを残す。
    await storeCodes(sourceKey, JSON.stringify(['"><script>', 'constructor', 'KeyQQ', 1, null, 'KeyZ']));
    body = await (await open(workPagePath(id))).text();
    expect(padCodesOf(body)).toEqual(['KeyZ']);
    expect(body).not.toContain('"><script>');
  });

  it('games.source_key が NULL の作品は、同じソースの行があっても引かない', async () => {
    const { id, sourceKey } = await seedPublished('null-key');
    await storeCodes(sourceKey, JSON.stringify(['Space']));
    expect(padCodesOf(await (await open(workPagePath(id))).text())).toEqual(['Space']);
    await env.DB.prepare('update games set source_key = null where id = ?').bind(id).run();
    expect(padCodesOf(await (await open(workPagePath(id))).text())).toEqual([]);
  });

  /**
   * 押し続けて読むキーの集合を置く（`held_codes` は文字列のまま入れる。NULL・壊れた値も入れられる。#530）。
   *
   * @param sourceKey ソースの R2 キー
   * @param codes `source_input_keys.codes` の値
   * @param held `source_input_keys.held_codes` の値（版 1 の行は null）
   */
  async function storeHeld(sourceKey: string, codes: string, held: string | null): Promise<void> {
    await env.DB.prepare(
      'insert or replace into source_input_keys (source_key, codes, held_codes, rule_version, extracted_at) values (?, ?, ?, 2, 1)',
    )
      .bind(sourceKey, codes, held)
      .run();
  }

  /**
   * 本文から、覆いに付けた推定の形を取り出す（方向の操作が無ければ null）。
   *
   * @param body 作品ページの HTML
   * @returns `stick` / `dpad` / null
   */
  function padShapeOf(body: string): string | null {
    return /<div class="gf-play-overlay"[^>]* data-pad-shape="([^"]*)"/u.exec(body)?.[1] ?? null;
  }

  it('押し続けて読むキー（held_codes）を同じ行から読み、最初の形を推定する（#530 / 仕様 3.9.6 の規則 1〜6）', async () => {
    const { id, sourceKey } = await seedPublished('held');
    const codes = JSON.stringify(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space']);
    // 横だけ H: スティック。↑ は右のボタン（スティックの形でだけ）に回る。
    await storeHeld(sourceKey, codes, JSON.stringify(['ArrowLeft', 'ArrowRight']));
    let body = await (await open(workPagePath(id))).text();
    expect(padShapeOf(body)).toBe('stick');
    expect(body).toContain('<div class="gf-play-pad gf-play-pad-stick" data-stick-left="ArrowLeft" data-stick-right="ArrowRight">');
    expect(body).toContain(`data-pad-memory="gf-pad-shape:${id}"`);
    expect(body).toContain('data-code="ArrowUp" aria-label="上" data-pad-only="stick">↑</button>');
    // 押し続けて読むキーが無い（[]）: 十字。
    await storeHeld(sourceKey, codes, '[]');
    body = await (await open(workPagePath(id))).text();
    expect(padShapeOf(body)).toBe('dpad');
    // 版 1 の行（NULL）・壊れた値・配列でない値・許可表の外だけ: 十字（読み方がまだ無い）。
    for (const held of [null, 'not json', '{"0":"ArrowLeft"}', '"ArrowLeft"', JSON.stringify(['constructor'])]) {
      await storeHeld(sourceKey, codes, held);
      body = await (await open(workPagePath(id))).text();
      expect(padShapeOf(body), String(held)).toBe('dpad');
      expect(padCodesOf(body), String(held)).toEqual(['ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space']);
    }
  });

  it('同じ条件式で読むキーの組（alias_groups）を同じ行から読み、Space と同じ組の ↑ を右のボタンに出さない（#543）', async () => {
    const { id, sourceKey } = await seedPublished('alias');
    const codes = JSON.stringify(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space']);
    const store = async (groups: string | null): Promise<void> => {
      await env.DB.prepare(
        'insert or replace into source_input_keys (source_key, codes, held_codes, alias_groups, rule_version, extracted_at) values (?, ?, ?, ?, 3, 1)',
      )
        .bind(sourceKey, codes, JSON.stringify(['ArrowLeft', 'ArrowRight']), groups)
        .run();
    };
    // Space || ↑ の組: スティックのまま、↑ のボタンを出さない。十字にしたときの十字（隠して置く）にも ↑ を出さない（#549）。
    await store(JSON.stringify([['ArrowUp', 'Space']]));
    let body = await (await open(workPagePath(id))).text();
    expect(padShapeOf(body)).toBe('stick');
    expect(padCodesOf(body)).toEqual(['ArrowLeft', 'ArrowRight', 'Space']);
    expect(body).not.toContain('data-code="ArrowUp" aria-label="上" data-pad-only="stick">↑</button>');
    expect(body).not.toContain('gf-play-pad-up" data-code="ArrowUp"');
    // 組が未記録（NULL）・壊れた値・配列でない値・許可表の外だけ・別の組: 今の規則 5 のまま ↑ を右のボタンに回す。
    for (const groups of [null, 'not json', '{"0":["ArrowUp","Space"]}', JSON.stringify([['ArrowUp', 'constructor']]), JSON.stringify([['ArrowUp', 'KeyW']])]) {
      await store(groups);
      body = await (await open(workPagePath(id))).text();
      expect(padShapeOf(body), String(groups)).toBe('stick');
      expect(body, String(groups)).toContain('data-code="ArrowUp" aria-label="上" data-pad-only="stick">↑</button>');
      expect(body, String(groups)).toContain('gf-play-pad-up" data-code="ArrowUp"');
    }
  });

  it('行が無い作品は、今どおりパッドも切り替えも出さない（規則 6）', async () => {
    const { id } = await seedPublished('held-no-row');
    const body = await (await open(workPagePath(id))).text();
    expect(body, '覆いが無い（検査の前提が崩れている）').toContain('gf-play-overlay');
    expect(padShapeOf(body)).toBeNull();
    expect(padCodesOf(body)).toEqual([]);
    expect(body).not.toContain('<button type="button" class="gf-button gf-button-tertiary gf-play-pad-toggle"');
  });

  it('論理解像度（layout_width / layout_height）を同じ行から読み、おすすめの向きを覆いに持たせる（#514 / 仕様 3.9.4）', async () => {
    const { id, sourceKey } = await seedPublished('layout');
    const orientationOf = (body: string): string | null => /<div class="gf-play-overlay"[^>]* data-orientation="([^"]*)"/u.exec(body)?.[1] ?? null;
    const store = async (width: unknown, height: unknown, version: number): Promise<void> => {
      await env.DB.prepare(
        'insert or replace into source_input_keys (source_key, codes, held_codes, alias_groups, layout_width, layout_height, rule_version, extracted_at) values (?, ?, ?, ?, ?, ?, ?, 1)',
      )
        .bind(sourceKey, '[]', '[]', '[]', width, height, version)
        .run();
    };
    await store(320, 240, 4);
    let body = await (await open(workPagePath(id))).text();
    expect(orientationOf(body)).toBe('landscape');
    expect(body).toContain(`data-orientation-memory="gf-orientation:${id}"`);
    expect(body).toContain('<p class="gf-play-orient-hint" role="status" hidden><span>横にすると</span><span>大きく遊べます</span></p>');
    expect(body).toContain('<button type="button" class="gf-button gf-button-tertiary gf-play-orient-toggle" hidden>');
    await store(320, 480, 4);
    body = await (await open(workPagePath(id))).text();
    expect(orientationOf(body)).toBe('portrait');
    expect(body).toContain('<p class="gf-play-orient-hint" role="status" hidden><span>縦にすると</span><span>大きく遊べます</span></p>');
    // 正方形・拾えなかった（版 4 の NULL）・版 3 以下の行（NULL）・壊れた値: 向きの操作をしない（属性もボタンも案内も無い）。
    for (const [width, height, version] of [
      [480, 480, 4],
      [null, null, 4],
      [null, null, 3],
      ['wide', 'tall', 4],
    ] as const) {
      await store(width, height, version);
      body = await (await open(workPagePath(id))).text();
      const label = `${String(width)}x${String(height)} v${version}`;
      expect(body, `${label}: 覆いが無い（検査の前提が崩れている）`).toContain('gf-play-overlay');
      expect(orientationOf(body), label).toBeNull();
      expect(body.slice(0, body.lastIndexOf('<script>')), label).not.toContain('gf-play-orient-toggle" hidden>');
      expect(body, label).not.toContain('<p class="gf-play-orient-hint"');
    }
    // 行が無い作品も同じ。
    const { id: noRow } = await seedPublished('layout-no-row');
    expect(orientationOf(await (await open(workPagePath(noRow))).text())).toBeNull();
  });

  it('source_input_keys は主キーで 1 行だけ引く（表の全行を読まない）', async () => {
    const plan = await env.DB.prepare(`explain query plan ${WORK_ROW_SQL}`)
      .bind('00000000-0000-4000-8000-000000000494')
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    const keys = details.filter((detail) => /\bk\b/u.test(detail));
    expect(keys.length, details.join(' / ')).toBeGreaterThan(0);
    for (const detail of keys) {
      expect(detail, details.join(' / ')).toMatch(/^SEARCH k USING INDEX sqlite_autoindex_source_input_keys_1 \(source_key=\?\)/u);
    }
  });
});

describe('公開前の作品ページでも、公開後と同じ遊び方にする（#575 / 仕様 3.9.4）', () => {
  /**
   * 完成した未公開の作品を 1 つ作り、キーと論理解像度の行を置く（`source_input_keys` の版 4 の行。層 10 の横長の作品と同じ形）。
   *
   * @param suffix 利用者と作品を分ける接尾辞
   * @returns 作者の id・作品 id・試遊 URL
   */
  async function seedDraftWithKeys(suffix: string): Promise<{ userId: string; id: string; playUrl: string }> {
    const { userId, id, jobToken } = await seedPending(`draft-play-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    const sha = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: sha }));
    const row = await env.DB.prepare('select status, source_key, preview_key from games where id = ?')
      .bind(id)
      .first<{ status: string; source_key: string; preview_key: string }>();
    // **公開していない行である**（ここが公開済みだと、公開後の `loadingScreen` を見ていることになる）。
    expect(row?.status).toBe('draft');
    await env.DB.prepare(
      'insert or replace into source_input_keys (source_key, codes, held_codes, alias_groups, layout_width, layout_height, rule_version, extracted_at) values (?, ?, ?, ?, ?, ?, 4, 1)',
    )
      .bind(row!.source_key, JSON.stringify(DRAFT_CODES), JSON.stringify(DRAFT_HELD), '[]', 320, 240)
      .run();
    return { userId, id, playUrl: `https://${env.SANDBOX_HOST}/p/${row!.preview_key}/` };
  }

  /** 作品が読むキー（←→↑ Enter Space。#575 の報告の作品と同じ集合）。 */
  const DRAFT_CODES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter', 'Space'];
  /** 押し続けて読むキー。 */
  const DRAFT_HELD = ['ArrowLeft', 'ArrowRight'];

  /**
   * 文字列が本文に何回出るか。
   *
   * @param body 本文
   * @param needle 探す文字列
   * @returns 回数
   */
  function countOf(body: string, needle: string): number {
    return body.split(needle).length - 1;
  }

  it('作者本人には、公開後と同じ playEmbed（/p/ の URL・作品のキー・向き）を 1 つだけ出し、試遊 URL のリンクと説明を残す', async () => {
    const { userId, id, playUrl } = await seedDraftWithKeys('owner');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('できました');

    // **公開後の画面と 1 文字も違わない埋め込み**（`src/work-play.ts` の 1 か所から組み立てる。写しを持たない）。
    expect(body).toContain(playEmbed(playUrl, id, DRAFT_CODES, DRAFT_HELD, [], 'landscape'));
    // iframe は `<noscript>` の中の 1 つだけで、`/p/` を指し、`sandbox` は `allow-scripts` だけのまま（7.2）。
    expect(body).toContain(`<noscript class="gf-play-noscript"><iframe class="gf-frame" src="${playUrl}" sandbox="allow-scripts" title="ゲーム"></iframe></noscript>`);
    expect(countOf(body, '<iframe')).toBe(1);
    expect(body).not.toContain(`/g/${id}/`);
    // 覆い・口・「遊ぶ」のボタン・スクリプトはどれも 1 つ（覆いのスクリプトは document.querySelector で最初の 1 つを引く）。
    expect(countOf(body, '<div class="gf-play-overlay"')).toBe(1);
    expect(countOf(body, '<div class="gf-play-entry">')).toBe(1);
    expect(countOf(body, 'gf-play-open" hidden>遊ぶ</button>')).toBe(1);
    expect(countOf(body, '<noscript class="gf-play-noscript">')).toBe(1);
    // パッドのキー（作品のキー）と向きの属性。
    expect(body).toContain('data-code="ArrowUp"');
    expect(body).toContain('data-code="Space"');
    expect(body).toContain('<div class="gf-play-pad gf-play-pad-stick" data-stick-left="ArrowLeft" data-stick-right="ArrowRight">');
    expect(body).toContain(`data-orientation="landscape" data-orientation-memory="gf-orientation:${id}"`);
    // 口は状態のブロックの中、埋め込みはブロックの外（直後）。覆いを `.gf-block` の中へ入れない。
    const entryAt = body.indexOf('<div class="gf-work-draft-play">');
    const overlayAt = body.indexOf('<div class="gf-play-overlay"');
    const stateEnd = body.indexOf('</div>\n<noscript class="gf-play-noscript">');
    expect(entryAt).toBeGreaterThan(body.indexOf('<div class="gf-block gf-work-state">'));
    expect(stateEnd).toBeGreaterThan(entryAt);
    expect(overlayAt).toBeGreaterThan(stateEnd);

    // 試遊 URL のリンクと「あなただけが知っている URL」の説明は残す（人に渡す URL）。
    expect(body).toContain(`<a href="${playUrl}">試遊 URL</a>`);
    expect(body).toContain('<strong>あなただけが知っている URL</strong>');
    expect(body).toContain('この URL を人に渡すと');
    // 公開の口は今のまま出る。
    expect(body).toContain('公開して共有');
  });

  it('試遊（/p/）は数えない: 計上のスクリプトも数も出さない', async () => {
    const { userId, id } = await seedDraftWithKeys('no-count');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body, '覆いが無い（検査の前提が崩れている）').toContain('gf-play-overlay');
    expect(body).not.toContain(PLAY_PATH);
    expect(body).not.toContain(playReportScript(id));
    expect(body).not.toContain('gf-plays');
  });

  it('本人以外（未ログイン・別の利用者）には、埋め込みも鍵も出さない', async () => {
    const { id, playUrl } = await seedDraftWithKeys('stranger');
    const stranger = await seedUser('draft-play-stranger-viewer');
    for (const cookie of [undefined, await sessionCookie(stranger)]) {
      const body = await (await open(workPagePath(id), cookie)).text();
      expect(body, String(cookie)).toContain('この作品はまだ公開されていません。');
      expect(body, String(cookie)).not.toContain('gf-play-');
      expect(body, String(cookie)).not.toContain('<iframe');
      expect(body, String(cookie)).not.toContain(playUrl);
    }
  });

  it('試遊 URL を組み立てられないときは今のまま（埋め込まない）', () => {
    const body = renderWorkPage({ ...baseView, owner: true, playUrl: null, publishableId: baseView.workId });
    expect(body).toContain('試遊 URL を組み立てられませんでした');
    expect(body).not.toContain('gf-play-');
    expect(body).not.toContain('<iframe');
  });

  it('リフォージの実行中（画面が自動で再読み込みされる間）は埋め込まず、リンクだけを出す', () => {
    const playUrl = 'https://sandbox.example.invalid/p/0123456789abcdef0123456789abcdef/';
    const running = renderWorkPage({ ...baseView, owner: true, playUrl, revisionRunning: true });
    expect(running).toContain('http-equiv="refresh"');
    expect(running).not.toContain('gf-play-');
    expect(running).toContain(`<a href="${playUrl}">この作品を遊ぶ</a>`);
    expect(running).toContain('<strong>あなただけが知っている URL</strong>');
    // 対照: 実行中でなければ埋め込む。
    expect(renderWorkPage({ ...baseView, owner: true, playUrl })).toContain('gf-play-overlay');
  });

  it('口のパネルはタッチ端末でだけ見せ、埋め込みは状態のブロックとの間を空ける（app.css）', () => {
    const hidden = /^\.gf-work-draft-play > \.gf-play-entry:not\(\.gf-play-entry-touch\)\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(hidden, 'app.css に口を隠す規則が無い').not.toBeNull();
    expect(hidden![1]!).toMatch(/display:\s*none/u);
    const entry = /^\.gf-work-draft-play > \.gf-play-entry\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(entry, 'app.css に口の位置の規則が無い（「遊ぶ」のボタンを重ねる基準）').not.toBeNull();
    expect(entry![1]!).toMatch(/position:\s*relative/u);
    expect(env.TEST_APP_CSS).toMatch(/^\.gf-work-state \+ \.gf-frame\s*\{/mu);
  });
});

describe('作品ページの出力に旧い呼び名（改造・推敲・手直し）が出ない（#513）', () => {
  const id = '00000000-0000-4000-8000-0000000000b1';
  const published: WorkPageView = {
    ...baseView,
    published: true,
    title: 'よけて跳ねる箱',
    playUrl: '/g/00000000-0000-4000-8000-0000000000b1/',
    forkableId: id,
    shareUrl: `https://app.example.invalid${workPagePath(id)}`,
    authorName: '作者',
    parent: { kind: 'published', title: '元の箱', path: workPagePath('00000000-0000-4000-8000-0000000000b2') },
    forks: { total: 1, items: [{ id: '00000000-0000-4000-8000-0000000000b3', title: '跳ねる箱', publishedAt: 3 }], morePath: null, backPath: null },
    details: sampleDetails(id),
  };
  const draftOwner: WorkPageView = {
    ...baseView,
    owner: true,
    title: 'よけて跳ねる箱',
    playUrl: '/g/00000000-0000-4000-8000-0000000000b1/preview/',
    publishableId: id,
    revisable: true,
    dailyRemaining: DAILY_QUOTA_PER_USER,
    renamableId: id,
  };

  const cases: readonly (readonly [string, WorkPageView])[] = [
    ['公開済み（未ログイン。フォークの導線は待機リストへ）', published],
    ['公開済み（ログイン済み。フォークの入力）', { ...published, signedIn: true, dailyRemaining: DAILY_QUOTA_PER_USER }],
    ['公開済み（作者本人。取り下げの口）', { ...published, owner: true, signedIn: true, dailyRemaining: 1, unpublishableId: id }],
    ['取り下げた作品（作者本人）', { ...baseView, owner: true, removed: true, title: 'よけて跳ねる箱' }],
    ['未公開（作者の画面。リフォージの入力）', draftOwner],
    ['未公開（リフォージの実行中）', { ...draftOwner, revisable: false, revisionRunning: true }],
    ['未公開（リフォージの失敗）', { ...draftOwner, revisionError: 'build-failed' }],
    ['未公開（リフォージの中断）', { ...draftOwner, revisionStalled: true }],
  ];

  for (const [name, view] of cases) {
    it(name, () => {
      expect(oldOperationNamesIn(renderWorkPage(view)), name).toEqual([]);
    });
  }

  it('検査が空振りしていない: 同じ画面にフォーク・リフォージの語が出ている', () => {
    expect(renderWorkPage({ ...published, signedIn: true, dailyRemaining: 1 })).toContain('この内容でフォークする');
    expect(renderWorkPage(draftOwner)).toContain('この内容でリフォージする');
    expect(renderWorkPage({ ...draftOwner, revisionRunning: true })).toContain('リフォージしています');
    expect(renderWorkPage({ ...draftOwner, revisionError: 'build-failed' })).toContain('前回のリフォージはうまくいきませんでした');
    expect(renderWorkPage({ ...draftOwner, revisionStalled: true })).toContain('リフォージが中断した可能性があります');
    expect(renderWorkPage(published)).toContain('このゲームからのフォーク: 1 件');
  });
});

describe('デスクトップの操作の案内（#599 / M16-1 / 仕様 3.9.11）', () => {
  /**
   * 公開済みの作品を 1 つ作り、キーの集合を置く。
   *
   * @param suffix 利用者と作品を分ける接尾辞
   * @param codes 置くキー（null なら `source_input_keys` の行を作らない）
   * @returns 作者の id と作品 id
   */
  async function seedWithCodes(suffix: string, codes: readonly string[] | null): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`legend-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    const sha = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: sha }));
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    if (codes !== null) {
      await env.DB.prepare(
        'insert or replace into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, 1, 1)',
      )
        .bind(`builds/${sha}/source.go`, JSON.stringify(codes))
        .run();
    }
    return { userId, id };
  }

  /**
   * 案内の札（`<span class="gf-chip">`）の文字を、出てくる順に取り出す。
   *
   * @param body 作品ページの HTML
   * @returns 札の文字の並び（案内が無ければ空）
   */
  function legendLabelsOf(body: string): string[] {
    const line = /<p class="gf-key-legend">.*?<\/p>/su.exec(body);
    if (line === null) {
      return [];
    }
    return [...line[0].matchAll(/<span class="gf-chip">([^<]*)<\/span>/gu)].map((found) => found[1]!);
  }

  it('キーを記録した公開済みの作品では、枠の直後・本文の列の先頭に案内が出る', async () => {
    const { id } = await seedWithCodes('shown', ['ArrowLeft', 'ArrowRight', 'Space', 'KeyZ']);
    const body = await (await open(workPagePath(id))).text();
    // 方向（十字と同じ順）→ 残りのキー（Space → KeyZ）。文字は許可表から決まる固定の文字列である。
    expect(legendLabelsOf(body)).toEqual(['←', '→', 'Space', 'Z']);
    expect(body).toContain('<span class="gf-key-legend-label">操作</span>');
    // **枠より後ろ**（4 要素と枠の間に割り込まない）で、**共有する URL より前**（本文の列の先頭）。
    const legendAt = body.indexOf('<p class="gf-key-legend">');
    expect(legendAt).toBeGreaterThan(body.indexOf('<noscript class="gf-play-noscript">'));
    expect(legendAt).toBeLessThan(body.indexOf('<div class="gf-work-share">'));
  });

  it('キーの記録が無い作品では 1 バイトも出さない（「操作: なし」を並べない）', async () => {
    const { id } = await seedWithCodes('no-row', null);
    const body = await (await open(workPagePath(id))).text();
    expect(body).not.toContain('gf-key-legend');
  });

  it('許可表の外の値・壊れた JSON だけの作品でも出さない（D1 の値を信じ切らない）', async () => {
    const { id } = await seedWithCodes('unknown', ['NotAKey']);
    expect(await (await open(workPagePath(id))).text()).not.toContain('gf-key-legend');

    const { id: broken, userId } = await seedWithCodes('broken', []);
    await env.DB.prepare('update source_input_keys set codes = ? where source_key = (select source_key from games where id = ?)')
      .bind('{not json', broken)
      .run();
    expect(await (await open(workPagePath(broken), await sessionCookie(userId))).text()).not.toContain('gf-key-legend');
  });

  it('作者の公開前の完成画面では、埋め込みの直後・設定のブロックの手前に出る', async () => {
    const { userId, id, jobToken } = await seedPending('legend-draft');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    const sha = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await completeGame(env, id, fakeBuildOutcome({ sourceSha256: sha }));
    await env.DB.prepare(
      'insert or replace into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, 1, 1)',
    )
      .bind(`builds/${sha}/source.go`, JSON.stringify(['ArrowUp', 'Space']))
      .run();
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('できました');
    expect(legendLabelsOf(body)).toEqual(['↑', 'Space']);
    const legendAt = body.indexOf('<p class="gf-key-legend">');
    expect(legendAt).toBeGreaterThan(body.indexOf('<noscript class="gf-play-noscript">'));
    expect(legendAt).toBeLessThan(body.indexOf('gf-work-settings'));
  });
});

describe('完成画面の題名の直下から改名へ飛ぶ（#600 / M16-2 / 仕様 5.4）', () => {
  /**
   * 完成した未公開の作品を 1 つ作る。
   *
   * @param suffix 利用者と作品を分ける接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedReadyDraft(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`rename-jump-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({}));
    return { userId, id };
  }

  it('作者の完成画面では、題名（h1）の直後にリンクが 1 つあり、飛び先の id が実在する', async () => {
    const { userId, id } = await seedReadyDraft('owner');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    const jump = `<p class="gf-work-rename-jump"><a href="#${WORK_RENAME_ANCHOR}">作品名を変える</a></p>`;
    expect(body).toContain(jump);
    // **h1 の直後である**（間に何も挟まない）。h1 は共通の描画が出しているので、ここが題名の直下になる。
    expect(body).toMatch(new RegExp(`</h1>\\n${jump.replace(/[.*+?^$()|[\]\\]/gu, '\\$&')}`, 'u'));
    // 飛び先が実在する（押しても何も起きないリンクを出さない。4.4）。
    expect(body).toContain(`<h3 id="${WORK_RENAME_ANCHOR}" tabindex="-1">作品名を変える</h3>`);
    // リンクは 1 つだけ（設定のブロックの見出しと二重に出さない）。
    expect(body.split(`href="#${WORK_RENAME_ANCHOR}"`).length - 1).toBe(1);
  });

  it('「公開して共有」のフォームと文言は 1 文字も変わっていない（5.4 の 1 タップを増やさない）', async () => {
    const { userId, id } = await seedReadyDraft('publish-untouched');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).toContain('>公開して共有</button>');
    expect(body).toContain('遊んでみて、よければ公開できます。');
    // **飛ぶ 1 行は状態のブロックの外（手前）にある。** 主のボタンの面へ別の導線を並べない（#474）。
    expect(body.indexOf('gf-work-rename-jump')).toBeLessThan(body.indexOf('<div class="gf-block gf-work-state">'));
  });

  it('改名できない相手には出さない（本人でない・生成中・取り下げ済み）', async () => {
    // 本人でない（未ログイン）。
    const { id } = await seedReadyDraft('not-owner');
    expect(await (await open(workPagePath(id))).text()).not.toContain('gf-work-rename-jump');

    // 生成中（完成していない）。作者本人でも出さない。
    const { userId: runningUser, id: running } = await seedPending('rename-jump-running');
    const body = await (await open(workPagePath(running), await sessionCookie(runningUser))).text();
    expect(body).not.toContain('gf-work-rename-jump');

    // **取り下げ済み**（PR #608 の Copilot の指摘）。いまは 2 つの理由で出ない——`renamableId` が
    // null になり、画面も `readySection` ではなくなる。**どちらか片方を変えた日に気づけるようにする。**
    const { userId: removedUser, id: removed } = await seedReadyDraft('removed');
    expect((await publishGame(env, removed, removedUser)).ok).toBe(true);
    await markGameRemoved(removed);
    const removedBody = await (await open(workPagePath(removed), await sessionCookie(removedUser))).text();
    expect(removedBody).toContain('この作品は公開されていません');
    expect(removedBody).not.toContain('gf-work-rename-jump');
    expect(removedBody).not.toContain(`href="#${WORK_RENAME_ANCHOR}"`);
  });
});

describe('説明が空のあいだ、作者に説明を書く口への案内を出す（#616 / M16-3 / 仕様 5.4）', () => {
  /** 案内の 1 行（本文の列に出る `<p>`）。 */
  const INVITE = '<p class="gf-work-describe-invite">';

  /**
   * 公開済みの作品を 1 つ作る。
   *
   * @param suffix 利用者と作品を分ける接尾辞
   * @returns 作者の id と作品 id
   */
  async function seedPublished(suffix: string): Promise<{ userId: string; id: string }> {
    const { userId, id, jobToken } = await seedPending(`describe-invite-${suffix}`);
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({}));
    expect((await publishGame(env, id, userId)).ok).toBe(true);
    return { userId, id };
  }

  it('説明が空の公開済みの作品を作者本人で開くと案内が出て、飛び先の id が実在する', async () => {
    const { userId, id } = await seedPublished('empty');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    expect(body).toContain(INVITE);
    expect(body).toContain(`<a href="#${WORK_DESCRIBE_ANCHOR}">作品の説明を書く</a>`);
    // 飛び先が実在する（押しても何も起きないリンクを出さない。4.4）。
    expect(body).toContain(`<h3 id="${WORK_DESCRIBE_ANCHOR}" tabindex="-1">作品の説明を書く</h3>`);
    // 案内は本文の列（設定のブロックより前）にある。
    expect(body.indexOf(INVITE)).toBeLessThan(body.indexOf('gf-work-settings'));
  });

  it('説明を書いた後は出ない（書けば消える）', async () => {
    const { userId, id } = await seedPublished('written');
    expect((await describeGame(env, id, userId, '左右キーで動かします。', 2_000)).ok).toBe(true);
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    expect(body).not.toContain(INVITE);
    // 説明そのものは出ており、飛び先（フォームの見出し）は作者なので残る。
    expect(body).toContain('左右キーで動かします。');
    expect(body).toContain(`<h3 id="${WORK_DESCRIBE_ANCHOR}" tabindex="-1">作品の説明を書く</h3>`);
  });

  it('閲覧者には 1 バイトも出さない（未ログイン・別の利用者）', async () => {
    const { id } = await seedPublished('viewer');
    expect(await (await open(workPagePath(id))).text()).not.toContain('gf-work-describe-invite');

    const other = await seedUser('describe-invite-other');
    const body = await (await open(workPagePath(id), await sessionCookie(other))).text();
    expect(body).not.toContain('gf-work-describe-invite');
  });

  it('未公開の完成画面には出さない（説明は公開後にしか書けない。5.4 を変えない）', async () => {
    const { userId, id, jobToken } = await seedPending('describe-invite-draft');
    await claimGenerationJob(env, id, await hashJobToken(jobToken));
    await completeGame(env, id, fakeBuildOutcome({}));
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();

    expect(body).toContain('できました');
    expect(body).not.toContain('gf-work-describe-invite');
  });
});
