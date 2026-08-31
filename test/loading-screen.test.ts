/**
 * ロード中画面（M4-5 / #30）の検査。
 *
 * # acceptance が確かめたいこと
 *
 * > Wasm のロード完了前に 4 要素すべてが描画されることを検証するテストが通る
 *
 * **「ページを開いたら 4 要素がある」では、この acceptance を確かめたことにならない。**
 * 4 要素が wasm の到着を待って描かれる実装でも同じ緑になるためである。**ロードが
 * 完了しえない状態を作って**確かめる。
 *
 * ここでは R2 に `.wasm` の実体を 1 バイトも置かない。**したがって
 * `/g/<id>/game.wasm` は成功しえず、ロードは永久に完了しない。** その状態で作品ページを
 * 引き、4 要素がすべて揃っていることを見る。あわせて、
 *
 * - 4 要素が**文書順で iframe より前**にあること（HTML は上から解釈される）
 * - 作品ページに `<script>` が 1 つも無いこと（**どの要素も load イベントに依存しえない**）
 * - iframe の中の文書（サンドボックス）に 4 要素の UGC が 1 つも現れないこと（7.2）
 *
 * を見る。この 3 つが揃って初めて「ロード完了前に描かれている」が構造として言える。
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import { createPublishRoutes } from '../src/publish.js';
import { FORK_PATH, PUBLISH_GAME_ID_FIELD, PUBLISH_PATH } from '../src/paths.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
} from '../src/games.js';
import {
  OGP_CALLBACK_PATH,
  OGP_GAME_ID_HEADER,
  OGP_TOKEN_HEADER,
  ogpImagePath,
  ogpRoutes,
} from '../src/ogp.js';
import type { OgpCaptureJob } from '../src/ogp-client.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { handleSandboxRequest } from '../src/sandbox.js';
import { signupRoutes } from '../src/signup.js';
import { waitlistRoutes } from '../src/waitlist.js';
import { WASM_FILE } from '../src/sandbox-delivery.js';
import { parentWorkOf, workPagePath, workPageRoutes } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const SECRET = 'test-secret-value-for-loading-screen-1';

/** 1×1 の PNG（撮影結果として送る最小の実体）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * テスト用の env。
 *
 * AWS の資格情報を入れてあるのは、**公開が撮影の呼び出しまで到達する**ようにする
 * ためである（`src/ogp-client.ts` の `missingOgpSecrets`）。呼び出しそのものは
 * `createPublishRoutes` で差し替えるので、**AWS へは 1 回も出ない。**
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
 * @param displayName 表示名（画面に出る作者名）
 * @returns 利用者の id
 */
async function seedUser(suffix: string, displayName: string): Promise<string> {
  const id = `loading-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
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
 * **R2 には何も置かない。** 置かないことがこのテストの前提である（下記
 * `wasmIsUnreachable`）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param options 作者名とお題
 * @returns 作者の id と作品 id
 */
async function seedReadyGame(
  suffix: string,
  options: { author?: string; prompt?: string } = {},
): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix, options.author ?? `作者${suffix}`);
  const pending = await createPendingGame(env, userId, {
    prompt: options.prompt ?? `お題${suffix}`,
  });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome());
  return { userId, id: pending.id };
}

/**
 * 公開する（撮影の呼び出しは差し替える。**AWS を呼ばない**）。
 *
 * @param userId 作者の id
 * @param id 作品 id
 * @returns 撮影のトークン
 */
async function publish(userId: string, id: string): Promise<string> {
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
  return jobs[0]!.ogpToken;
}

/**
 * 撮影の結果（PNG）を送り、`ogp_state` を `ready` にする。
 *
 * @param id 作品 id
 * @param token 撮影のトークン
 */
async function sendScreenshot(id: string, token: string): Promise<void> {
  const response = await dispatch(
    ogpRoutes,
    new Request(`${APP_ORIGIN}${OGP_CALLBACK_PATH}`, {
      method: 'POST',
      headers: {
        [OGP_GAME_ID_HEADER]: id,
        [OGP_TOKEN_HEADER]: token,
        'content-type': 'image/png',
      },
      body: PNG_BYTES,
    }),
    testEnv(),
  );
  expect(response.ok).toBe(true);
}

/**
 * 公開済みで、スクリーンショットも撮れている作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param options 作者名とお題
 * @returns 作者の id と作品 id
 */
async function seedPlayableGame(
  suffix: string,
  options: { author?: string; prompt?: string } = {},
): Promise<{ userId: string; id: string }> {
  const { userId, id } = await seedReadyGame(suffix, options);
  await sendScreenshot(id, await publish(userId, id));
  return { userId, id };
}

/**
 * 作品ページを開く。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns HTML
 */
async function workPage(gameId: string, cookie?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const response = await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${workPagePath(gameId)}`, { headers }),
    testEnv(),
  );
  expect(response.status).toBe(200);
  return await response.text();
}

/**
 * サンドボックス用ホストから 1 本引く。
 *
 * @param path パス
 * @returns レスポンス
 */
async function sandbox(path: string): Promise<Response> {
  return await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}${path}`), testEnv());
}

/**
 * **ロードが完了しえないことを、実際に引いて確かめる。**
 *
 * この前提が崩れた（＝ R2 に実体が置かれるようになった）ら、このテストは
 * 「ロード完了前」を見なくなる。**前提そのものを毎回確かめる。**
 *
 * @param gameId 作品 id
 */
async function expectWasmUnreachable(gameId: string): Promise<void> {
  const response = await sandbox(`/g/${gameId}/${WASM_FILE}`);
  expect(response.status).not.toBe(200);
}

/**
 * `haystack` の中で `needle` が現れる位置。**見つからなければテストを落とす。**
 *
 * @param haystack 探す対象
 * @param needle 探す文字列
 * @returns 位置
 */
function indexOf(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  expect(at, `見つかりません: ${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

beforeAll(async () => {
  await applySchema();
});

describe('#30 の acceptance: Wasm のロード完了前に 4 要素すべてが描かれる', () => {
  it('ロードが完了しえない状態でも、4 要素が揃って描かれている', async () => {
    const parent = await seedPlayableGame('acc-parent', {
      author: '親の作者',
      prompt: 'おやゲーム',
    });
    const child = await seedPlayableGame('acc-child', {
      author: 'ゴリラ太郎',
      prompt: 'こゲーム',
    });
    await env.DB.prepare('update games set parent_id = ? where id = ?')
      .bind(parent.id, child.id)
      .run();

    // **前提。** R2 に実体が無いので、この作品の wasm は永久に取得できない。
    await expectWasmUnreachable(child.id);

    const body = await workPage(child.id);

    // 4 要素。
    const shot = `<img class="gf-shot" src="${ogpImagePath(child.id)}"`;
    const author = 'ゴリラ太郎';
    const parentName = 'おやゲーム';
    const fork = '改造する';
    expect(body).toContain(shot);
    expect(body).toContain(author);
    expect(body).toContain(parentName);
    expect(body).toContain(fork);

    // **どれも iframe より前にある。** HTML は上から解釈されるので、枠の中身が
    // 1 バイトも届かないうちに 4 要素は描かれる。
    const frameAt = indexOf(body, '<iframe');
    for (const element of [shot, author, parentName, fork]) {
      expect(indexOf(body, element), element).toBeLessThan(frameAt);
    }

    // **この画面はスクリプトを 1 つも持たない。** したがって、どの要素も
    // 「読み込みが終わってから描く」ことが原理的にできない。
    expect(body).not.toContain('<script');
  });

  it('スクリーンショットの URL は実際に引ける（枠だけ描いて 404 にしない）', async () => {
    const { id } = await seedPlayableGame('acc-image');
    const body = await workPage(id);
    expect(body).toContain(`src="${ogpImagePath(id)}"`);

    const image = await dispatch(
      ogpRoutes,
      new Request(`${APP_ORIGIN}${ogpImagePath(id)}`),
      testEnv(),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
  });

  it('撮影が終わっていなくても、4 要素の場所は残る', async () => {
    // 公開の直後は `capturing` である。**要素ごと消すと版面が飛び、
    // 「4 要素すべて」がデータの状態しだいで崩れる。**
    const { userId, id } = await seedReadyGame('acc-capturing');
    await publish(userId, id);

    const body = await workPage(id);
    expect(body).toContain('スクリーンショットを準備しています');
    expect(body).not.toContain('<img class="gf-shot"');
    expect(body).toContain('作者:');
    expect(body).toContain('元ゲーム:');
    expect(body).toContain('改造する');
  });
});

describe('4 要素をアプリ用ホスト側に描く（7.2 を崩さないための判断。#30）', () => {
  it('iframe の sandbox は allow-scripts だけである', async () => {
    const { id } = await seedPlayableGame('sandbox-attr');
    const body = await workPage(id);

    expect(body).toContain(`<iframe class="gf-frame" src="${SANDBOX_ORIGIN}/g/${id}/" `);
    expect(body).toContain('sandbox="allow-scripts"');
    // **1 つでも足りたら 7.2 が崩れる。**
    expect(body).not.toContain('allow-same-origin');
    expect(body).not.toContain('allow-popups');
    expect(body).not.toContain('allow-top-navigation');
    expect(body).not.toContain('allow-forms');
  });

  it('サンドボックス文書には UGC 由来の文字列が 1 つも現れない', async () => {
    const { id } = await seedPlayableGame('no-ugc', {
      author: 'ウガンダ次郎',
      prompt: 'ひみつのおだい',
    });
    const response = await sandbox(`/g/${id}/`);
    expect(response.status).toBe(200);
    const document = await response.text();

    // **作者名も題名も入れない**（`src/sandbox-loader.ts` の冒頭）。
    // ここが緩むと `script-src 'unsafe-inline'` と組み合わさって即座に実行になる。
    expect(document).not.toContain('ウガンダ次郎');
    expect(document).not.toContain('ひみつのおだい');
    // CSP は 1 文字も変えていない（`img-src` を緩める必要が無い）。
    expect(response.headers.get('content-security-policy')).toContain('img-src data:');
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  });

  it('サンドボックス文書がロード進捗を出す（割合ではなく段階）', async () => {
    const { id } = await seedPlayableGame('progress');
    const document = await (await sandbox(`/g/${id}/`)).text();

    // 文書が届いた時点の段階。
    expect(document).toContain('読み込み中');
    // 取得とコンパイルの段階（待ち時間の大半）。
    expect(document).toContain('ゲームを読み込んでいます');
    // 不確定の棒。**値を持たない**（分母が取れないため。ローダーの冒頭）。
    expect(document).toContain('<progress id="gf-progress"></progress>');
    // 割合を計算していない＝ `Content-Length` を読んでいない。
    expect(document).not.toContain('content-length');
  });

  it('未公開の作品はページに埋め込まない', async () => {
    // ロード中画面は公開済みの作品のためのものである。未公開のプレビューは
    // `preview_key` が唯一の資格情報で、作者本人にだけリンクとして出す（5.4）。
    const { userId, id } = await seedReadyGame('draft-no-frame');
    const body = await workPage(id, await sessionCookie(userId));
    expect(body).toContain('できました');
    expect(body).not.toContain('<iframe');
  });
});

describe('「改造する」の行き先（2.2-4 / 4.4 / #30）', () => {
  it('未ログインには待機リストの導線を出し、その先は実在する', async () => {
    const { id } = await seedPlayableGame('fork-anon');
    const body = await workPage(id);
    expect(body).toContain('href="/signup?from=fork-cta"');
    expect(body).toContain('改造には招待が必要です');

    // **押した先が実際に開く。** 行き先の無いボタンを描かない（4.4）。
    const landing = await dispatch(
      signupRoutes,
      new Request(`${APP_ORIGIN}/signup?from=fork-cta`),
      testEnv(),
    );
    expect(landing.status).toBe(200);
    const landingBody = await landing.text();
    // そこで実際に登録できる（10.2 が見る導線として記録される形で）。
    expect(landingBody).toContain('<input type="hidden" name="source" value="fork-cta">');
    expect(landingBody).toContain('改造（フォーク）できるのは招待された方だけです');
  });

  it('その導線からの登録が fork-cta として記録される（10.2 の分子）', async () => {
    const email = 'fork-cta-visitor@example.com';
    const response = await dispatch(
      waitlistRoutes,
      new Request(`${APP_ORIGIN}/api/waitlist`, {
        method: 'POST',
        // 素のフォーム送信（ブラウザのナビゲーション）と同じ形で送る。
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: new URLSearchParams({ email, source: 'fork-cta' }).toString(),
      }),
      testEnv(),
    );
    expect(response.status).toBe(303);

    const row = await env.DB.prepare('select source from waitlist where email = ?')
      .bind(email)
      .first<{ source: string | null }>();
    expect(row?.source).toBe('fork-cta');
  });

  it('ログイン済みには差分プロンプトの口を出す（M5-1 で本物の導線になった。#32）', async () => {
    // **#30 の時点ではここが生成画面へのリンクで、「親のソースを引き継ぐ改造はまだ
    // 用意できていません」と書いていた。** M5-1（#32）でフォークの生成が入ったので、
    // ボタンの名前どおりの着地点になった。**未ログイン側は 1 文字も変わっていない**
    // （上の 2 つのテスト。10.2 の分子への唯一の送り手である）。
    const { userId, id } = await seedPlayableGame('fork-member');
    const body = await workPage(id, await sessionCookie(userId));
    expect(body).toContain(`action="${FORK_PATH}"`);
    expect(body).toContain(`value="${id}"`);
    expect(body).not.toContain('from=fork-cta');
  });

  it('押せないボタンにしない（disabled も、行き先の無い button も出さない）', async () => {
    const { id } = await seedPlayableGame('fork-not-dead');
    const body = await workPage(id);
    expect(body).toContain('<a class="gf-fork-link"');
    expect(body).not.toContain('disabled');
  });
});

describe('元ゲームの出し分け（3.4-5 / 5.3 / 5.5）', () => {
  it('親が無ければ「オリジナル」と書く（行ごと消さない）', async () => {
    const { id } = await seedPlayableGame('parent-none');
    expect(await workPage(id)).toContain('元ゲーム: ありません（この作品がオリジナルです）');
  });

  it('親が公開されていれば題名とリンクを出す', async () => {
    const parent = await seedPlayableGame('parent-pub', { prompt: 'おやのおだい' });
    const child = await seedPlayableGame('child-pub');
    await env.DB.prepare('update games set parent_id = ? where id = ?')
      .bind(parent.id, child.id)
      .run();

    const body = await workPage(child.id);
    expect(body).toContain(`<a href="${workPagePath(parent.id)}">おやのおだい</a>`);
  });

  it('親が未公開なら題名を出さない（プロンプト由来のため）', async () => {
    const parent = await seedReadyGame('parent-draft', { prompt: 'みこうかいのおだい' });
    const child = await seedPlayableGame('child-of-draft');
    await env.DB.prepare('update games set parent_id = ? where id = ?')
      .bind(parent.id, child.id)
      .run();

    const body = await workPage(child.id);
    expect(body).not.toContain('みこうかいのおだい');
    expect(body).toContain('元ゲーム: まだ公開されていない作品から派生');
  });

  it('親の状態から表示を導く関数が、4 つの場合をすべて区別する', () => {
    // 表示の分岐そのものを直接見る。画面越しだと `removed` の親（M5-4）を
    // 作る経路がまだ無く、**検査できない場合が残る。**
    expect(parentWorkOf({ parent_ref: null, parent_status: null, parent_title: null })).toEqual({
      kind: 'none',
    });
    expect(
      parentWorkOf({ parent_ref: 'x', parent_status: 'removed', parent_title: 'きえた' }),
    ).toEqual({ kind: 'removed' });
    // 行ごと消えた場合も「削除済み」に倒す（`parent_id` がある以上、派生である）。
    expect(parentWorkOf({ parent_ref: 'x', parent_status: null, parent_title: null })).toEqual({
      kind: 'removed',
    });
    expect(parentWorkOf({ parent_ref: 'x', parent_status: 'draft', parent_title: 'した' })).toEqual(
      { kind: 'unlisted' },
    );
    expect(
      parentWorkOf({ parent_ref: 'x', parent_status: 'published', parent_title: 'おや' }),
    ).toEqual({ kind: 'published', title: 'おや', path: workPagePath('x') });
  });
});

describe('UGC 由来の文字列は必ずエスケープする（8.3 / 7.2）', () => {
  it('作者名に含まれる山括弧がタグにならない', async () => {
    const { id } = await seedPlayableGame('escape-author', {
      author: '<script>alert(1)</script>',
    });
    const body = await workPage(id);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script');
  });

  it('親の題名に含まれる山括弧がタグにならない', async () => {
    const parent = await seedPlayableGame('escape-parent', { prompt: '<img src=x onerror=1>' });
    const child = await seedPlayableGame('escape-child');
    await env.DB.prepare('update games set parent_id = ? where id = ?')
      .bind(parent.id, child.id)
      .run();

    const body = await workPage(child.id);
    expect(body).toContain('&lt;img src=x onerror=1&gt;');
    expect(body).not.toContain('<img src=x');
  });
});
