import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  failGame,
  hashJobToken,
  publishGame,
} from '../src/games.js';
import { LIKED_WORKS_PATH } from '../src/liked-works-paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { WORK_EDIT_FORM_ID } from '../src/work-edit.js';
import { WORK_EDIT_SUFFIX, workEditPath } from '../src/work-edit-paths.js';
import { workPagePath } from '../src/work-page.js';
import { WORK_SAVE_PATH } from '../src/work-save.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { markGameRemoved } from './helpers/removed-work.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * エディットページ（`/works/<id>/edit`）と、作品ページの作者の見え方（#664）。
 *
 * **アプリの経路表そのもの（`handleAppRequest`）を通す**——`/works/mine`・`/works/liked` が `/edit` の経路に
 * 飲み込まれないことは、完全一致と前方一致が同じ表に並んだ状態でしか確かめられない（`src/routes.ts`）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-edit-page-1';

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
  const id = `edit-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, `利用者 ${suffix}`)
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

/** 作品の状態。 */
type Seeded = 'working' | 'failed' | 'draft' | 'published' | 'removed';

/**
 * 指定の状態の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param state 状態
 * @returns 作者の id と作品 id
 */
async function seedWork(suffix: string, state: Seeded): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: `ひみつの題名 ${suffix}` });
  if (state === 'working') {
    return { userId, id: pending.id };
  }
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  if (state === 'failed') {
    await failGame(env, pending.id, 'source-rejected');
    return { userId, id: pending.id };
  }
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-edit-${suffix}` }));
  if (state === 'published' || state === 'removed') {
    expect((await publishGame(env, pending.id, userId)).ok).toBe(true);
  }
  if (state === 'removed') {
    await markGameRemoved(pending.id);
  }
  return { userId, id: pending.id };
}

/**
 * アプリの経路表で開く。
 *
 * @param path パス
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function open(path: string, cookie?: string): Promise<Response> {
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } }),
    testEnv(),
  );
}

/**
 * 応答の比べられる部分（ステータス・遷移先・本文）。
 *
 * @param response レスポンス
 * @returns 比べる値
 */
async function comparable(response: Response): Promise<{ status: number; location: string | null; body: string }> {
  return { status: response.status, location: response.headers.get('location'), body: await response.text() };
}

beforeAll(async () => {
  await applySchema();
});

describe('作者が /works/<id>/edit を開くと 200、作者以外と未ログインは作品ページと同じ応答（#664 の acceptance 1）', () => {
  for (const state of ['working', 'failed', 'draft', 'published', 'removed'] as const) {
    it(`${state}: 作者には 200 のエディットページ、作者以外と未ログインには作品ページと同じ応答`, async () => {
      const { userId, id } = await seedWork(`acc1-${state}`, state);
      const owner = await open(workEditPath(id), await sessionCookie(userId));
      expect(owner.status).toBe(200);
      const ownerBody = await owner.text();
      expect(ownerBody).toContain('<h1>作品の編集</h1>');
      expect(ownerBody).toContain('<meta name="robots" content="noindex">');

      const stranger = await seedUser(`acc1-${state}-stranger`);
      for (const cookie of [undefined, await sessionCookie(stranger)]) {
        const asEdit = await comparable(await open(workEditPath(id), cookie));
        const asPage = await comparable(await open(workPagePath(id), cookie));
        // **1 バイトも違わない**——ステータス・遷移先・本文（ヘッダ・パンくずを含む）まで同じである。
        expect(asEdit, `${state} / ${cookie === undefined ? '未ログイン' : '他人'}`).toEqual(asPage);
        expect(asEdit.body).not.toContain('作品の編集');
        expect(asEdit.body).not.toContain(WORK_SAVE_PATH);
        // **下書きの存在を漏らさない**——公開していない作品の仮の題名（プロンプト由来）も試遊 URL も出さない。
        if (state !== 'published') {
          expect(asEdit.body).not.toContain(`ひみつの題名 acc1-${state}`);
          expect(asEdit.body).not.toContain('/p/');
        }
      }
    });
  }

  it('存在しない作品と、綴りの違う id も、作品ページと同じ 404', async () => {
    const userId = await seedUser('acc1-missing');
    const missing = '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f';
    const cookie = await sessionCookie(userId);
    const asEdit = await comparable(await open(workEditPath(missing), cookie));
    const asPage = await comparable(await open(workPagePath(missing), cookie));
    expect(asEdit.status).toBe(404);
    expect(asEdit).toEqual(asPage);
    expect((await open(`/works/not-a-uuid${WORK_EDIT_SUFFIX}`, cookie)).status).toBe(404);
  });
});

describe('固定の経路が /edit に飲み込まれない（#664 の constraints / src/routes.ts の優先順位）', () => {
  it('/works/mine と /works/liked は完全一致の経路のまま開く', async () => {
    const userId = await seedUser('routes');
    const cookie = await sessionCookie(userId);
    const mine = await open(MY_WORKS_PATH, cookie);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain('<h1>あなたの作品</h1>');
    const liked = await open(LIKED_WORKS_PATH, cookie);
    expect(liked.status).toBe(200);
    expect(await liked.text()).not.toContain('作品の編集');
  });

  it('/works/mine/edit と /works/liked/edit は、作品 id の綴りに合わないので作品ページと同じ 404', async () => {
    const userId = await seedUser('routes-edit');
    const cookie = await sessionCookie(userId);
    for (const path of [`${MY_WORKS_PATH}${WORK_EDIT_SUFFIX}`, `${LIKED_WORKS_PATH}${WORK_EDIT_SUFFIX}`]) {
      const response = await open(path, cookie);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain('<h1>作品が見つかりません</h1>');
    }
  });
});

describe('作品ページは作者にも作者以外と同じ画面を出す（#664 の acceptance 4）', () => {
  /**
   * 作者と作者以外で違ってよいものを外す。
   *
   * - 「編集する」の 1 行（作者にだけ足す）
   * - いいねのフォームと通報の口（自分の作品には押せない。5.8 / 8.4——押せないボタンを出さない）
   *
   * **外枠（ヘッダのアバター・メニュー）は比べない**（見ている人の外枠である。`pageBodyOf`）。
   *
   * @param html 作品ページの HTML
   * @returns 比べる本文
   */
  function normalized(html: string): string {
    return pageBodyOf(html)
      .replace(/<p class="gf-work-edit-link">[\s\S]*?<\/p>\n/u, '')
      .replace(/\n<form class="gf-like"[\s\S]*?<\/form>/u, '')
      .replace(/\n<div class="gf-work-like">\n<\/div>/u, '')
      .replace(/\n<details class="gf-report">[\s\S]*?<\/details>/u, '');
  }

  it('公開作品の作品ページは、作者に出す HTML と作者以外に出す HTML が「編集する」以外で一致する', async () => {
    const { userId, id } = await seedWork('acc4', 'published');
    const other = await seedUser('acc4-other');

    const ownerHtml = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    const otherHtml = await (await open(workPagePath(id), await sessionCookie(other))).text();

    // 作者には「編集する」が出て、作者以外には出ない。
    const editLine = `<p class="gf-work-edit-link"><a class="gf-button gf-button-secondary gf-button-sm" href="${workEditPath(id)}">編集する</a></p>`;
    expect(ownerHtml).toContain(editLine);
    expect(otherHtml).not.toContain('gf-work-edit-link');
    // 作者以外には押せる口（いいね・通報）があり、作者には無い（自分の作品には押せない）。
    expect(otherHtml).toContain('class="gf-like"');
    expect(otherHtml).toContain('class="gf-report"');
    expect(ownerHtml).not.toContain('class="gf-like"');
    expect(ownerHtml).not.toContain('class="gf-report"');

    // **それ以外は 1 バイトも違わない**（作者だけの設定・開示・版・削除の口は出さない）。
    expect(normalized(ownerHtml)).toBe(normalized(otherHtml));
    expect(ownerHtml).not.toContain('gf-work-settings');
    expect(ownerHtml).not.toContain(WORK_SAVE_PATH);
  });

  it('未ログインの画面とは、外枠とフォークの導線（待機リストへ）だけが違う', async () => {
    const { userId, id } = await seedWork('acc4-anon', 'published');
    const ownerHtml = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    const anonHtml = await (await open(workPagePath(id))).text();
    const stripFork = (html: string): string =>
      normalized(html).replace(/<p class="gf-fork">[\s\S]*?<\/div>\n<\/div>/u, '<FORK>');
    expect(stripFork(ownerHtml)).toBe(stripFork(anonHtml));
  });
});

describe('下書きを作者が作品ページで開くと帯が出る。作者以外は開けない（#664 の acceptance 5）', () => {
  it('作者には「下書きです」の帯と「編集へ戻る」がつき、公開後と同じ本文を出す（検索避けのまま・OGP なし）', async () => {
    const { userId, id } = await seedWork('acc5', 'draft');
    const response = await open(workPagePath(id), await sessionCookie(userId));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<div class="gf-block gf-draft-banner" role="note">');
    expect(body).toContain('<strong>下書きです。</strong>');
    expect(body).toContain(`<a class="gf-button gf-button-secondary gf-button-sm" href="${workEditPath(id)}">編集へ戻る</a>`);
    // 帯は題名（h1）より上にある。
    expect(body.indexOf('gf-draft-banner')).toBeLessThan(body.indexOf('<h1>'));
    // 公開後と同じ本文（4 要素のブロック・操作・系統）。「公開しています」とは言わない。
    expect(body).toContain('<div class="gf-context gf-block">');
    expect(body).toContain('このゲームからのフォーク: 0 件');
    expect(body).not.toContain('<h2>公開しています</h2>');
    // 公開していないので、検索避けのまま・OGP のメタタグも出さない（5.4）。
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).not.toContain('property="og:');
    // 「編集する」の 1 行は出さない（帯の「編集へ戻る」と同じ行き先を 2 つ並べない）。
    expect(body).not.toContain('gf-work-edit-link');
  });

  it('作者以外（未ログイン・別の利用者）には帯も本文も出さず、状態だけを言う', async () => {
    const { id } = await seedWork('acc5-stranger', 'draft');
    const stranger = await seedUser('acc5-viewer');
    for (const cookie of [undefined, await sessionCookie(stranger)]) {
      const body = await (await open(workPagePath(id), cookie)).text();
      expect(body).toContain('この作品はまだ公開されていません。');
      expect(body).not.toContain('gf-draft-banner');
      expect(body).not.toContain('ひみつの題名 acc5-stranger');
      expect(body).not.toContain('/p/');
      expect(body).not.toContain('gf-context');
    }
  });

  it('公開済みの作品には帯を出さない', async () => {
    const { userId, id } = await seedWork('acc5-published', 'published');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('gf-draft-banner');
    expect(body).toContain('<h2>公開しています</h2>');
  });
});

describe('作者が生成中・失敗・取り下げ済みの作品を作品ページで開くと、エディットページへ送る（#664）', () => {
  for (const state of ['working', 'failed', 'removed'] as const) {
    it(`${state}: 303 でエディットページへ（完了メールのリンクから着いても作者の画面になる）`, async () => {
      const { userId, id } = await seedWork(`redirect-${state}`, state);
      const response = await open(workPagePath(id), await sessionCookie(userId));
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(workEditPath(id));
    });
  }
});

describe('エディットページの形（#664）', () => {
  it('右上に「変更を元に戻す」と「保存」を置き、左の作品名・説明・タグと右の公開設定を 1 つのフォームで送る', async () => {
    const { userId, id } = await seedWork('layout', 'published');
    const body = await (await open(workEditPath(id), await sessionCookie(userId))).text();

    // 右上の 2 つのボタンはフォームの外にあり、`form` 属性で結ぶ。主は「保存」だけ。
    const bar = body.slice(body.indexOf('<div class="gf-edit-bar">'), body.indexOf(`<form id="${WORK_EDIT_FORM_ID}"`));
    expect(bar).toContain(`<button type="reset" form="${WORK_EDIT_FORM_ID}" class="gf-button gf-button-secondary">変更を元に戻す</button>`);
    expect(bar).toContain(`<button type="submit" form="${WORK_EDIT_FORM_ID}" class="gf-button gf-button-primary">保存</button>`);
    // 「作品ページで見る」「あなたの作品へ戻る」（Studio の左端のアイコン列の代わり）。
    expect(body).toContain(`<a class="gf-link-quiet" href="${workPagePath(id)}">作品ページで見る</a>`);
    expect(body).toContain(`<a class="gf-link-quiet" href="${MY_WORKS_PATH}">あなたの作品へ戻る</a>`);
    // 左（フォーム）→ 右（プレビュー・共有 URL・公開設定）の順。
    const formAt = body.indexOf(`<form id="${WORK_EDIT_FORM_ID}" class="gf-edit-main gf-block" method="post" action="${WORK_SAVE_PATH}">`);
    const previewAt = body.indexOf('<section class="gf-edit-preview"');
    const shareAt = body.indexOf('<p class="gf-work-share-label">共有する URL</p>');
    const visibilityAt = body.indexOf('<fieldset class="gf-edit-visibility gf-block">');
    expect(formAt).toBeGreaterThan(0);
    expect(previewAt).toBeGreaterThan(formAt);
    expect(shareAt).toBeGreaterThan(previewAt);
    expect(visibilityAt).toBeGreaterThan(shareAt);
    expect(body).toContain(`form="${WORK_EDIT_FORM_ID}" checked> 公開</label>`);
  });

  it('生成中は自動更新し、失敗は作者に分類を言い、削除の導線を出す', async () => {
    const working = await seedWork('layout-working', 'working');
    const workingBody = await (await open(workEditPath(working.id), await sessionCookie(working.userId))).text();
    expect(workingBody).toContain('http-equiv="refresh"');
    expect(workingBody).toContain('生成中です');
    expect(workingBody).not.toContain('作品ページで見る');

    const failed = await seedWork('layout-failed', 'failed');
    const failedBody = await (await open(workEditPath(failed.id), await sessionCookie(failed.userId))).text();
    expect(failedBody).toContain('生成できませんでした');
    expect(failedBody).toContain('許可していない機能');
    expect(failedBody).toContain('この作品を削除する');
    expect(failedBody).not.toContain('http-equiv="refresh"');
  });
});
