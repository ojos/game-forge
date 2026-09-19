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
import { MY_WORKS_BREADCRUMB_LABEL, WORK_EDIT_FORM_ID } from '../src/work-edit.js';
import { WORK_EDIT_SUFFIX, workEditPath } from '../src/work-edit-paths.js';
import { workPagePath } from '../src/work-page.js';
import { WORK_SAVE_PATH } from '../src/work-save.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { markGameRemoved } from './helpers/removed-work.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';
import { countingEnv } from './helpers/d1-counting.js';

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

describe('作者が /works/<id>/edit を開くと 200、作者以外と未ログインは作品ページへ 303（#664 の acceptance 1 / #690）', () => {
  for (const state of ['working', 'failed', 'draft', 'published', 'removed'] as const) {
    it(`${state}: 作者には 200 のエディットページ、作者以外と未ログインには /works/<id> への 303`, async () => {
      const { userId, id } = await seedWork(`acc1-${state}`, state);
      const owner = await open(workEditPath(id), await sessionCookie(userId));
      expect(owner.status).toBe(200);
      const ownerBody = await owner.text();
      expect(ownerBody).toContain('<h1>作品の編集</h1>');
      expect(ownerBody).toContain('<meta name="robots" content="noindex">');

      const stranger = await seedUser(`acc1-${state}-stranger`);
      for (const cookie of [undefined, await sessionCookie(stranger)]) {
        const who = `${state} / ${cookie === undefined ? '未ログイン' : '他人'}`;
        const asEdit = await comparable(await open(workEditPath(id), cookie));
        // **作品の状態に関わらず、同じ 303 の 1 通りである**（#690。本文は空で、エディットページがあることを漏らさない）。
        expect(asEdit, who).toEqual({ status: 303, location: workPagePath(id), body: '' });
        // 送り先は、作品ページを直接開いたときと同じ応答である（ステータスは #690 の前と変わらない）。
        const followed = await comparable(await open(asEdit.location!, cookie));
        const direct = await comparable(await open(workPagePath(id), cookie));
        expect(followed, who).toEqual(direct);
        expect(followed.status, who).toBe(200);
        expect(followed.body).not.toContain('作品の編集');
        expect(followed.body).not.toContain(WORK_SAVE_PATH);
        // **下書きの存在を漏らさない**——公開していない作品の仮の題名（プロンプト由来）も試遊 URL も出さない。
        if (state !== 'published') {
          expect(followed.body).not.toContain(`ひみつの題名 acc1-${state}`);
          expect(followed.body).not.toContain('/p/');
        }
      }
    });
  }

  it('送り返しは 303 で、キャッシュさせない（301 だと、後でログインした作者のブラウザにも残る。#690）', async () => {
    const { id } = await seedWork('acc1-cache', 'draft');
    const response = await open(workEditPath(id));
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('存在しない作品も、作者以外と未ログインには同じ 303 で、送り先が 404 を返す。綴りの違う id は 404（#690）', async () => {
    const userId = await seedUser('acc1-missing');
    const missing = '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f';
    for (const cookie of [undefined, await sessionCookie(userId)]) {
      const asEdit = await comparable(await open(workEditPath(missing), cookie));
      // **有る id と同じ応答にする**（ここで 404 を返すと、303 か 404 かの差から存在が読める）。
      expect(asEdit).toEqual({ status: 303, location: workPagePath(missing), body: '' });
      expect((await open(asEdit.location!, cookie)).status).toBe(404);
    }
    expect((await open(`/works/not-a-uuid${WORK_EDIT_SUFFIX}`, await sessionCookie(userId))).status).toBe(404);
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
      .replace(/<a class="gf-work-edit-link[^"]*" href="[^"]*">編集する<\/a>/u, '')
      .replace(/\n<form class="gf-like"[\s\S]*?<\/form>/u, '')
      .replace(/\n<div class="gf-work-like">\n<\/div>/u, '')
      .replace(/\n<details class="gf-report" id="report">[\s\S]*?<\/details>/u, '')
      // 「…」メニューの「この作品を通報する」の項目（#665 / PR #674。自分の作品には押せないので作者には出さない）。
      .replace(/\n<li><a class="gf-link-quiet" href="#report">この作品を通報する<\/a><\/li>/u, '');
  }

  it('公開作品の作品ページは、作者に出す HTML と作者以外に出す HTML が「編集する」以外で一致する', async () => {
    const { userId, id } = await seedWork('acc4', 'published');
    const other = await seedUser('acc4-other');

    const ownerHtml = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    const otherHtml = await (await open(workPagePath(id), await sessionCookie(other))).text();

    // 作者には「編集する」が出て、作者以外には出ない。
    // **#665 から作者の行の中**（#664 では題名の直下の 1 行に仮置きしていた）。
    const editLine = `<a class="gf-work-edit-link gf-button gf-button-secondary gf-button-sm" href="${workEditPath(id)}">編集する</a>`;
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
      normalized(html)
        // 開く「フォークする」は行の外（PR #674）、未ログインの導線は行の中に置く。どちらも外して比べる。
        .replace(/\n<details class="gf-fork-open">[\s\S]*?<\/details>/u, '')
        .replace(/<a class="gf-fork-link[^>]*>[^<]*<\/a>/u, '')
        .replace(' gf-watch-author-forkable', '')
        .replace(/\n<p class="gf-fork-note">フォークには招待が必要です。[^<]*<\/p>/u, '');
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
    expect(body.indexOf('gf-draft-banner')).toBeLessThan(body.indexOf('<h1 class="gf-watch-title">'));
    // 公開後と同じ本文（#665 の視聴ページの配置・系統）。「公開しています」とは言わない。
    expect(body).toContain('<div class="gf-watch-byline">');
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
      expect(body).not.toContain('gf-watch-author');
    }
  });

  it('公開済みの作品には帯を出さない', async () => {
    const { userId, id } = await seedWork('acc5-published', 'published');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(body).not.toContain('gf-draft-banner');
    expect(body).toContain('<div class="gf-watch-byline">');
  });
});

describe('作者以外には、未公開の作品の状態を言い分けない（#690 の acceptance 3）', () => {
  /** 未公開の状態（#690 の goal (2) の 5 つ）。 */
  const UNPUBLISHED = ['working', 'stalled', 'failed', 'draft', 'revising'] as const;

  /**
   * 未公開の作品を 1 件、指定の状態で用意する。
   *
   * - `stalled` … 生成を受け付けたまま区切りを過ぎた（`started_at` を大昔にする）
   * - `revising` … 完成した下書きのリフォージ中（`game_revision_jobs` が `running`。推敲中も `games` は `ready` のまま。
   *   `migrations/0009_game_revisions.sql`）
   *
   * @param suffix テスト内で一意な接尾辞
   * @param state 状態
   * @returns 作品 id
   */
  async function seedUnpublished(suffix: string, state: (typeof UNPUBLISHED)[number]): Promise<string> {
    if (state === 'working' || state === 'failed' || state === 'draft') {
      return (await seedWork(suffix, state)).id;
    }
    const userId = await seedUser(suffix);
    const pending = await createPendingGame(env, userId, { prompt: `ひみつの題名 ${suffix}` });
    if (state === 'stalled') {
      await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken), 1);
      return pending.id;
    }
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
    await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-edit-${suffix}` }));
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h', 'ひみつの手直し', 'running', null, ?, ?)`,
    )
      .bind(pending.id, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
      .run();
    return pending.id;
  }

  it('生成中・止まった・失敗・完成した下書き・リフォージ中のどれも、同じ本文「この作品はまだ公開されていません」になる', async () => {
    const stranger = await seedUser('acc3-stranger');
    for (const cookie of [undefined, await sessionCookie(stranger)]) {
      const who = cookie === undefined ? '未ログイン' : '他人';
      const pages: string[] = [];
      for (const state of UNPUBLISHED) {
        const id = await seedUnpublished(`acc3-${state}-${cookie === undefined ? 'anon' : 'other'}`, state);
        const response = await open(workPagePath(id), cookie);
        // **ステータスは変えない**（#690 の constraints。未公開の作品ページは 200 のまま）。
        expect(response.status, `${who} / ${state}`).toBe(200);
        const html = await response.text();
        expect(html, `${who} / ${state}`).toContain('<div class="gf-block gf-work-state">\n<p>この作品はまだ公開されていません。</p>\n</div>');
        for (const word of ['できました', '生成中です', '閉じても', '生成できませんでした', '中断した可能性', 'リフォージ']) {
          expect(html, `${who} / ${state} / ${word}`).not.toContain(word);
        }
        // **自動更新もしない**（更新の有無で状態が読める差を残さない）。
        expect(html, `${who} / ${state}`).not.toContain('http-equiv="refresh"');
        // 仮の題名（プロンプト由来）は出さない（#150）。
        expect(html, `${who} / ${state}`).not.toContain('ひみつの題名');
        // **作品 id を伏せれば、5 つの状態で 1 バイトも違わない**（見出し・`<title>`・パンくずまで同じ）。
        pages.push(html.replaceAll(id, '<id>'));
      }
      for (const [at, page] of pages.entries()) {
        expect(page, `${who} / ${UNPUBLISHED[at]}`).toBe(pages[0]);
      }
    }
  });

  it('作者本人には、エディットページで状態を言い分ける（作者の表示は変えない）', async () => {
    const expected: Record<(typeof UNPUBLISHED)[number], string> = {
      working: '生成中です',
      stalled: '中断した可能性があります',
      failed: '生成できませんでした',
      draft: '<h1>作品の編集</h1>',
      revising: 'http-equiv="refresh"',
    };
    for (const state of UNPUBLISHED) {
      const id = await seedUnpublished(`acc3-owner-${state}`, state);
      const row = await env.DB.prepare('select author_id from games where id = ?').bind(id).first<{ author_id: string }>();
      const response = await open(workEditPath(id), await sessionCookie(row!.author_id));
      expect(response.status, state).toBe(200);
      const body = await response.text();
      expect(body, state).toContain(expected[state]);
      expect(body, state).not.toContain('<p>この作品はまだ公開されていません。</p>');
    }
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

describe('作者以外が /edit を開いても、重い読み込みを 2 度しない（PR #671 の Copilot の指摘）', () => {
  /**
   * D1 の文の数を数えながら開く。
   *
   * @param path パス
   * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
   * @returns 発行した文の数
   */
  async function statementsFor(path: string, cookie?: string): Promise<number> {
    const counted = countingEnv(testEnv());
    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } }),
      counted.env,
    );
    await response.text();
    return counted.count();
  }

  it('作者以外の /edit は、作者を確かめる軽い読み取りだけで送り返す（#690 から作品ページの読み取りもしない）', async () => {
    const { id } = await seedWork('light-check', 'published');
    const stranger = await seedUser('light-check-stranger');
    const cookie = await sessionCookie(stranger);

    // ログイン済みの他人: セッションの 1 文と `author_id` の 1 文だけ（通報の状態・いいね・フォークの近傍・生成枠を読まない）。
    expect(await statementsFor(workEditPath(id), cookie)).toBe(2);
    // 未ログイン: セッションの cookie が無いので、D1 を 1 文も読まない。
    expect(await statementsFor(workEditPath(id))).toBe(0);
  });
});

describe('エディットページのパンくず（PR #671。2026-09-18 の利用者の決定）', () => {
  it('「トップ › あなたの作品 › ○○ の編集」にする（「作品をさがす」の下に置かない）', async () => {
    const { userId, id } = await seedWork('breadcrumb', 'draft');
    const body = await (await open(workEditPath(id), await sessionCookie(userId))).text();
    const crumb = /<nav class="gf-breadcrumb"[\s\S]*?<\/nav>/u.exec(body)?.[0] ?? '';
    const items = [...crumb.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((found) => found[1]!);
    expect(items).toEqual([
      '<a href="/">トップ</a>',
      `<a href="${MY_WORKS_PATH}">${MY_WORKS_BREADCRUMB_LABEL}</a>`,
      '<span aria-current="page">ひみつの題名 breadcrumb の編集</span>',
    ]);
    expect(crumb).not.toContain('作品をさがす');
    // 親の名前は「あなたの作品」の画面の見出しと同じ語である。
    expect(await (await open(MY_WORKS_PATH, await sessionCookie(userId))).text()).toContain(
      `<h1>${MY_WORKS_BREADCRUMB_LABEL}</h1>`,
    );
  });

  it('作品ページのパンくずは変えない（URL から導く）', async () => {
    const { userId, id } = await seedWork('breadcrumb-page', 'published');
    const body = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    const crumb = /<nav class="gf-breadcrumb"[\s\S]*?<\/nav>/u.exec(body)?.[0] ?? '';
    expect(crumb).toContain('作品をさがす');
    expect(crumb).not.toContain(MY_WORKS_BREADCRUMB_LABEL);
  });
});

describe('下書きのプレビューには、フォークの見出しと説明を出さない（PR #671。2026-09-18 の利用者の決定）', () => {
  it('作者が下書きを作品ページで開いても「フォークする」の塊が無い。公開後は出る（#665 の作者の行でも保つ）', async () => {
    const { userId, id } = await seedWork('no-fork-cta', 'draft');
    const preview = await (await open(workPagePath(id), await sessionCookie(userId))).text();
    expect(preview).toContain('gf-draft-banner');
    expect(preview).not.toContain('フォークする');
    expect(preview).not.toContain('gf-fork-open');
    expect(preview).not.toContain('class="gf-fork"');
    expect(preview).not.toContain('gf-fork-note');

    const published = await seedWork('no-fork-cta-published', 'published');
    const page = await (await open(workPagePath(published.id), await sessionCookie(published.userId))).text();
    expect(page).toContain('<summary class="gf-fork gf-button gf-button-primary">フォークする</summary>');
  });
});
