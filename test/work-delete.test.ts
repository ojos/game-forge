import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import type { GameDeletionRejection } from '../src/game-deletion.js';
import { PURGED_TITLE } from '../src/game-deletion.js';
import { STALE_AFTER_SECONDS } from '../src/games.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import {
  DELETE_REFUSALS,
  WORK_DELETE_GAME_ID_FIELD,
  WORK_DELETE_PATH,
  deletionBlockOf,
  workDeletePath,
} from '../src/work-delete.js';
import { workPagePath } from '../src/work-page.js';
// **削除の導線はエディットページにある**（#664）。
import { workEditPath } from '../src/work-edit-paths.js';
import { WORK_SAVE_PATH, WORK_SAVE_VISIBILITY_FIELD } from '../src/work-save.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者が自分の下書きと取り下げ済みの作品を、確認画面を経て削除する（#517 / M15-2）。
 *
 * **#517 の acceptance のうち、テストの行を 1 つずつ機械判定する。**
 *
 * 1. 作者本人の下書き（完成・失敗）と取り下げ済みの作品のページにだけ削除の導線が出て、他人・未ログイン・
 *    公開中・生成中の作品には出ない
 * 2. 確認画面を経ずに POST しても、作者本人でなければ何も消えない
 * 3. 削除した作品が「あなたの作品」一覧に出ず、作品ページが取り下げ済みの表示になる（行を残した作品）。
 *    行ごと消えた作品のページは 404 になる
 *
 * あわせて、断る理由ごとに文言とステータスが分かれていること、確認画面のボタンが主でないこと、
 * 旧い呼び名（#513）が出ないことを見る。
 *
 * **変異の記録**（PR の本文にも書く）:
 *
 * - `handleDelete` の作者の確認から `author_id` の比較だけを外す → 「作者本人でなければ何も消えない」が赤。
 *   確認をまるごと外す → それに加えて「存在しない id に成功を返さない」が赤
 * - `showWorkPage` の `deletable` から `owner` を外す → 「他人・未ログインには出ない」が赤
 * - 公開中の作品に導線を出す: **2 層ある。** 描画側（`publishedSection` が `deleteSection` を呼ばない）と、表示の条件
 *   （`deletionBlockOf` の `published` の枝）。`deletionBlockOf` の枝だけを外す → 単体の「並びと同じ順」と確認画面の
 *   「フォームの代わりに理由を出す」が赤（作品ページは第 1 層が止める）。**両方を外す → 「公開中の作品には出さず」も赤**
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-delete-page-1';

beforeAll(async () => {
  await applySchema();
});

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `wdel-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '削除する人')
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

/** 作品行の下準備。 */
interface SeedWork {
  readonly authorId: string;
  readonly status: 'draft' | 'published' | 'removed';
  readonly generationState: 'pending' | 'running' | 'ready' | 'failed';
  readonly parentId?: string;
  /** 生成を始めた時刻（UNIX 秒）。既定は現在時刻（区切りの内側）。 */
  readonly startedAt?: number;
}

/**
 * 作品行を 1 つ作り、完成していれば成果物を R2 に置いて版を 1 つ積む（本番の完成の経路と同じ形）。
 *
 * @param seed 下準備
 * @returns 作品 id・題名・成果物のキー
 */
async function seedWork(
  seed: SeedWork,
): Promise<{ id: string; title: string; sourceKey: string; wasmKey: string }> {
  const id = crypto.randomUUID();
  const title = `削除の題名-${id.slice(0, 8)}`;
  const sourceKey = `builds/${id}/source.go`;
  const wasmKey = `builds/${id}/go1.27.0/game.wasm.br`;
  const now = Math.floor(Date.now() / 1000);
  const ready = seed.generationState === 'ready';
  const published = seed.status !== 'draft';
  await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key, created_at,
        generation_started_at, published_at, preview_key, generation_state, generation_error)
     values (?, ?, ?, ?, ?, 'go1.27.0', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      seed.authorId,
      seed.parentId ?? null,
      seed.status,
      title,
      ready ? sourceKey : null,
      ready ? wasmKey : null,
      seed.startedAt ?? now,
      seed.startedAt ?? now,
      published ? now : null,
      ready ? crypto.randomUUID().replaceAll('-', '') : null,
      seed.generationState,
      seed.generationState === 'failed' ? 'build-failed' : null,
    )
    .run();
  if (ready) {
    await env.DB.prepare(
      `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
       values (?, 1, ?, ?, 'go1.27.0', null, ?)`,
    )
      .bind(id, sourceKey, wasmKey, now)
      .run();
    await env.BUCKET.put(sourceKey, 'package main');
    await env.BUCKET.put(wasmKey, 'wasm');
  }
  return { id, title, sourceKey, wasmKey };
}

/**
 * リフォージのジョブを 1 行積む。
 *
 * @param gameId 作品 id
 * @param createdAt 作った時刻（区切りより古ければ「止まった」リフォージになる）
 */
async function seedRevisionJob(gameId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
     values (?, 'h', 'p', 'running', null, null, ?)`,
  )
    .bind(gameId, createdAt)
    .run();
}

/**
 * 画面を開く。
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
 * 削除の口を、素の HTML フォームと同じ形（または JSON）で叩く。
 *
 * @param gameId 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @param accept `Accept` ヘッダ
 * @returns レスポンス
 */
async function postDelete(
  gameId: string,
  cookie?: string,
  accept = 'text/html',
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept,
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${WORK_DELETE_PATH}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ [WORK_DELETE_GAME_ID_FIELD]: gameId }).toString(),
    }),
    testEnv(),
  );
}

/**
 * 作品行が在るか。
 *
 * @param id 作品 id
 * @returns 行（無ければ null）
 */
async function gameRow(
  id: string,
): Promise<{ status: string; purged_at: number | null; title: string } | null> {
  return await env.DB.prepare('select status, purged_at, title from games where id = ?')
    .bind(id)
    .first<{ status: string; purged_at: number | null; title: string }>();
}

/**
 * 作品ページに削除の導線（確認画面へのリンク）が在るか。
 *
 * @param body 作品ページの HTML
 * @param id 作品 id
 * @returns 在れば true
 */
function hasDeleteLink(body: string, id: string): boolean {
  return body.includes(`href="${workDeletePath(id)}"`);
}

describe('削除の導線（#517 の acceptance 1）', () => {
  it('作者本人の下書き（完成）・下書き（失敗）・取り下げ済みの作品にだけ出る', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    for (const seed of [
      { status: 'draft', generationState: 'ready' },
      { status: 'draft', generationState: 'failed' },
      { status: 'removed', generationState: 'ready' },
    ] as const) {
      const work = await seedWork({ authorId: author, ...seed });
      const body = await (await open(workEditPath(work.id), cookie)).text();
      expect(hasDeleteLink(body, work.id), `${seed.status}/${seed.generationState}`).toBe(true);
      // **押しても消えない**——エディットページの導線は確認画面への移動（`<a>`）で、削除の口へ送るフォームを置かない。
      expect(body, `${seed.status}/${seed.generationState}`).not.toContain(`action="${WORK_DELETE_PATH}"`);
      // **主にしない**（仕様 2.5.5。破壊的な操作）。
      expect(body).toContain(`<a class="gf-button gf-button-secondary" href="${workDeletePath(work.id)}">`);
    }
  });

  it('他人・未ログインには出ない（下書きでも取り下げ済みでも）', async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    for (const seed of [
      { status: 'draft', generationState: 'ready' },
      { status: 'draft', generationState: 'failed' },
      { status: 'removed', generationState: 'ready' },
    ] as const) {
      const work = await seedWork({ authorId: author, ...seed });
      // **作品ページでも、エディットページの URL でも出ない**（#664。後者は作者以外を作品ページへ 303 で送り返す。#690）。
      for (const path of [workPagePath(work.id), workEditPath(work.id)]) {
        const theirs = await (await open(path, await sessionCookie(stranger))).text();
        expect(hasDeleteLink(theirs, work.id), `他人 ${path} ${seed.status}/${seed.generationState}`).toBe(false);
        const anon = await (await open(path)).text();
        expect(hasDeleteLink(anon, work.id), `未ログイン ${path} ${seed.status}/${seed.generationState}`).toBe(false);
      }
    }
  });

  it('公開中の作品には出さず、先に公開をやめることを書く', async () => {
    const author = await seedUser();
    const work = await seedWork({ authorId: author, status: 'published', generationState: 'ready' });
    const body = await (await open(workEditPath(work.id), await sessionCookie(author))).text();
    expect(hasDeleteLink(body, work.id)).toBe(false);
    // 公開をやめる口はある（作者本人・公開中。#664 からはエディットページの公開設定で「下書き」を選んで保存する）。
    // 削除には下書きへ戻すのが先に要ることは、断りの文言（`DELETE_REFUSALS.published`）と確認画面が言う。
    expect(body).toContain(`action="${WORK_SAVE_PATH}"`);
    expect(body).toContain(`name="${WORK_SAVE_VISIBILITY_FIELD}" value="draft"`);
  });

  it('生成中の作品には出さない（区切りを過ぎて止まった行も）', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    const old = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS - 60;
    for (const seed of [
      { generationState: 'pending' },
      { generationState: 'running' },
      { generationState: 'running', startedAt: old },
    ] as const) {
      const work = await seedWork({ authorId: author, status: 'draft', ...seed });
      const body = await (await open(workEditPath(work.id), cookie)).text();
      expect(body).toContain('生成中です');
      expect(hasDeleteLink(body, work.id), JSON.stringify(seed)).toBe(false);
    }
  });

  it('リフォージのジョブが走っている作品には出さない。止まったリフォージなら理由を書く', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    const now = Math.floor(Date.now() / 1000);

    const running = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    await seedRevisionJob(running.id, now);
    const runningBody = await (await open(workEditPath(running.id), cookie)).text();
    expect(hasDeleteLink(runningBody, running.id)).toBe(false);
    expect(runningBody).not.toContain('直前のリフォージが止まったまま残っているため');

    const stalled = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    await seedRevisionJob(stalled.id, now - STALE_AFTER_SECONDS - 60);
    const stalledBody = await (await open(workEditPath(stalled.id), cookie)).text();
    expect(hasDeleteLink(stalledBody, stalled.id)).toBe(false);
    expect(stalledBody).toContain('直前のリフォージが止まったまま残っているため、いまはこの作品を削除できません。');
  });

  it('表示の条件は deleteGame が断る並びと同じ順で理由を返す', () => {
    const base = { status: 'draft', generationState: 'ready', purged: false, revisionInFlight: false };
    expect(deletionBlockOf(base)).toBeNull();
    expect(deletionBlockOf({ ...base, status: 'removed' })).toBeNull();
    expect(deletionBlockOf({ ...base, generationState: 'failed' })).toBeNull();
    expect(deletionBlockOf({ ...base, status: 'published' })).toBe('published');
    expect(deletionBlockOf({ ...base, generationState: 'pending' })).toBe('generating');
    expect(deletionBlockOf({ ...base, generationState: 'unexpected' })).toBe('generating');
    expect(deletionBlockOf({ ...base, revisionInFlight: true })).toBe('revising');
    expect(deletionBlockOf({ ...base, status: 'removed', purged: true })).toBe('purged');
  });
});

describe('確認画面（GET /works/<id>/delete）', () => {
  it('作者本人には、起きること・起きないことと、主でない削除のボタンを出す', async () => {
    const author = await seedUser();
    const work = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const response = await open(workDeletePath(work.id), await sessionCookie(author));
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain(work.title);
    expect(body).toContain('元に戻せません');
    expect(body).toContain('ソースコード・遊ぶためのファイル・紹介用の画像が消えます');
    expect(body).toContain('この作品をフォークした作品は消えません');
    expect(body).toContain('1 日の生成枠は戻りません');
    // **JS なしの `<form method="post">` で送れる。**
    expect(body).toContain(`<form method="post" action="${WORK_DELETE_PATH}">`);
    expect(body).toContain(`<input type="hidden" name="${WORK_DELETE_GAME_ID_FIELD}" value="${work.id}">`);
    // **削除のボタンは副で、この画面に主のボタンは無い**（仕様 2.5.5）。
    expect(body).toContain('<button type="submit" class="gf-button gf-button-secondary">この作品を削除する</button>');
    expect(body).not.toContain('gf-button-primary');
    // やめる道はエディットページへの移動（#664。削除の導線はそこにある）。
    expect(body).toContain(`<a href="${workEditPath(work.id)}">削除せずに編集へ戻る</a>`);
    // 外枠に乗っている（`test/page-shell.test.ts` は経路表から導くので、前方一致の続きのこの画面は開かない）。
    expect(body).toContain('<header class="gf-header">');
    expect(body).toContain('<footer class="gf-footer">');
    expect(body).toContain('<meta name="robots" content="noindex">');
    // **旧い呼び名を出さない**（#513）。
    expect(oldOperationNamesIn(body)).toEqual([]);
  });

  it('他人の作品と存在しない作品は、どちらも 404（題名を出さない）', async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    const work = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });

    const theirs = await open(workDeletePath(work.id), await sessionCookie(stranger));
    expect(theirs.status).toBe(404);
    const theirsBody = await theirs.text();
    expect(theirsBody).not.toContain(work.title);
    expect(theirsBody).not.toContain(WORK_DELETE_PATH);

    const missing = await open(workDeletePath(crypto.randomUUID()), await sessionCookie(stranger));
    expect(missing.status).toBe(404);
  });

  it('未ログインはログインへ送る', async () => {
    const author = await seedUser();
    const work = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const response = await open(workDeletePath(work.id));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('公開中・生成中の作品では、フォームの代わりに理由を出す', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    const published = await seedWork({ authorId: author, status: 'published', generationState: 'ready' });
    const pending = await seedWork({ authorId: author, status: 'draft', generationState: 'pending' });

    for (const [work, reason] of [
      [published, 'published'],
      [pending, 'generating'],
    ] as const) {
      const response = await open(workDeletePath(work.id), cookie);
      expect(response.status, reason).toBe(DELETE_REFUSALS[reason].status);
      const body = await response.text();
      expect(body).toContain(DELETE_REFUSALS[reason].heading);
      expect(body).not.toContain(`action="${WORK_DELETE_PATH}"`);
      expect(body).toContain(`<a href="${workEditPath(work.id)}">編集へ戻る</a>`);
    }
  });

  it('id の綴りが違えば作品ページと同じ 404', async () => {
    const author = await seedUser();
    for (const path of ['/works/not-a-uuid/delete', '/works/delete', '/works//delete']) {
      expect((await open(path, await sessionCookie(author))).status, path).toBe(404);
    }
  });
});

describe('削除の口（POST /api/works/delete）', () => {
  it('確認画面を経ずに POST しても、作者本人でなければ何も消えない（#517 の acceptance 2）', async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    const draft = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const removed = await seedWork({ authorId: author, status: 'removed', generationState: 'ready' });

    for (const work of [draft, removed]) {
      const response = await postDelete(work.id, await sessionCookie(stranger));
      expect(response.status).toBe(404);
      expect(await response.text()).toContain(DELETE_REFUSALS['not-found'].heading);

      const row = await gameRow(work.id);
      expect(row).not.toBeNull();
      expect(row!.purged_at).toBeNull();
      expect(row!.title).toBe(work.title);
      expect(await env.BUCKET.head(work.sourceKey)).not.toBeNull();
      expect(await env.BUCKET.head(work.wasmKey)).not.toBeNull();
    }

    // 未ログインはログインへ送り、何も消さない。
    const anon = await postDelete(draft.id);
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toBe(LOGIN_PATH);
    expect(await gameRow(draft.id)).not.toBeNull();
  });

  it('存在しない id に成功を返さない（deleteGame は存在しない id にも deleted を返す）', async () => {
    const someone = await seedUser();
    const html = await postDelete(crypto.randomUUID(), await sessionCookie(someone));
    expect(html.status).toBe(404);
    expect(html.headers.get('location')).toBeNull();

    const asJson = await postDelete(crypto.randomUUID(), await sessionCookie(someone), 'application/json');
    expect(asJson.status).toBe(404);
    expect(await asJson.json()).toEqual({ error: 'not-found' });
  });

  it('作者の下書きを消すと「あなたの作品」へ戻り、一覧にも作品ページにも出ない（#517 の acceptance 3）', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    const ready = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const failed = await seedWork({ authorId: author, status: 'draft', generationState: 'failed' });
    const kept = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });

    const before = await (await open(MY_WORKS_PATH, cookie)).text();
    expect(before).toContain(workPagePath(ready.id));
    expect(before).toContain(workPagePath(failed.id));

    for (const work of [ready, failed]) {
      const response = await postDelete(work.id, cookie);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(MY_WORKS_PATH);
      // 子も運営の記録も無いので、行ごと消える。
      expect(await gameRow(work.id)).toBeNull();
      expect((await open(workPagePath(work.id), cookie)).status).toBe(404);
    }
    // 共有していないキーは R2 から消える。
    expect(await env.BUCKET.head(ready.sourceKey)).toBeNull();
    expect(await env.BUCKET.head(ready.wasmKey)).toBeNull();

    const after = await (await open(MY_WORKS_PATH, cookie)).text();
    expect(after).not.toContain(workPagePath(ready.id));
    expect(after).not.toContain(workPagePath(failed.id));
    // **消していない作品は残る**（一覧が空になったから緑、にならないように）。
    expect(after).toContain(workPagePath(kept.id));
  });

  it('子のいる取り下げ済みの作品を消すと、行を残して中身を消し、作品ページは取り下げ済みの表示になる（#517 の acceptance 3）', async () => {
    const author = await seedUser();
    const forker = await seedUser();
    const cookie = await sessionCookie(author);
    const parent = await seedWork({ authorId: author, status: 'removed', generationState: 'ready' });
    const child = await seedWork({
      authorId: forker,
      status: 'published',
      generationState: 'ready',
      parentId: parent.id,
    });

    const response = await postDelete(parent.id, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(MY_WORKS_PATH);

    const row = await gameRow(parent.id);
    expect(row?.status).toBe('removed');
    expect(row?.purged_at).not.toBeNull();
    expect(row?.title).toBe(PURGED_TITLE);
    expect(await env.BUCKET.head(parent.sourceKey)).toBeNull();

    // 作品ページは取り下げ済みの表示のまま。誰にでも同じ見出しを出し、本人にだけ中身が消えたことを言う。
    const anon = await (await open(workPagePath(parent.id))).text();
    expect(anon).toContain('この作品は公開されていません');
    expect(anon).not.toContain(parent.title);
    // **作者はエディットページで読む**（#664。作者が取り下げ済みの作品を作品ページで開くと、エディットページへ送る）。
    expect((await open(workPagePath(parent.id), cookie)).headers.get('location')).toBe(workEditPath(parent.id));
    const mine = await (await open(workEditPath(parent.id), cookie)).text();
    expect(mine).toContain('この作品は公開されていません');
    expect(mine).toContain('この作品はあなたが削除しました。');
    // もう消す物は無いので、導線を出さない。
    expect(hasDeleteLink(mine, parent.id)).toBe(false);

    // 「あなたの作品」には、もともと取り下げ済みの作品は出ない（`status <> 'removed'`）。消したあとも出ない。
    expect(await (await open(MY_WORKS_PATH, cookie)).text()).not.toContain(workPagePath(parent.id));

    // 子は公開されたまま残る。
    expect((await gameRow(child.id))?.status).toBe('published');

    // 確認画面を開き直すと「すでに削除されています」。
    const again = await open(workDeletePath(parent.id), cookie);
    expect(again.status).toBe(DELETE_REFUSALS.purged.status);
    expect(await again.text()).toContain(DELETE_REFUSALS.purged.heading);

    // 2 回目の POST も成功として戻す（`deleteGame` は冪等）。
    const second = await postDelete(parent.id, cookie);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe(MY_WORKS_PATH);
  });

  it('断る理由ごとに文言とステータスを分け、何も書き換えない', async () => {
    const author = await seedUser();
    const cookie = await sessionCookie(author);
    const now = Math.floor(Date.now() / 1000);

    const published = await seedWork({ authorId: author, status: 'published', generationState: 'ready' });
    // **止まったまま残った生成中の行も「生成中」として断る**（#516 の申し送り。`deleteGame` の条件は変えない）。
    const stalled = await seedWork({
      authorId: author,
      status: 'draft',
      generationState: 'running',
      startedAt: now - STALE_AFTER_SECONDS - 60,
    });
    const revising = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    await seedRevisionJob(revising.id, now);

    for (const [work, reason] of [
      [published, 'published'],
      [stalled, 'generating'],
      [revising, 'revising'],
    ] as const) {
      const response = await postDelete(work.id, cookie);
      expect(response.status, reason).toBe(DELETE_REFUSALS[reason].status);
      const body = await response.text();
      expect(body, reason).toContain(DELETE_REFUSALS[reason].heading);
      expect(body, reason).toContain(DELETE_REFUSALS[reason].body);
      expect(oldOperationNamesIn(body), reason).toEqual([]);

      const asJson = await postDelete(work.id, cookie, 'application/json');
      expect(asJson.status, reason).toBe(DELETE_REFUSALS[reason].status);
      expect(await asJson.json(), reason).toEqual({ error: reason });

      const row = await gameRow(work.id);
      expect(row?.purged_at, reason).toBeNull();
      expect(row?.title, reason).toBe(work.title);
    }
  });

  it('JSON で叩くと、成功は結果を返す', async () => {
    const author = await seedUser();
    const work = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const response = await postDelete(work.id, await sessionCookie(author), 'application/json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, result: 'deleted' });
  });

  it('本文を JSON で送っても作品 id を読み、他人の作品は消さない（PR #532 のレビュー指摘）', async () => {
    const author = await seedUser();
    const someone = await seedUser();
    /** 本文を `application/json` で送る（{@link postDelete} はフォームの形でしか送らない）。 */
    const postJson = async (body: string, cookie: string): Promise<Response> =>
      await handleAppRequest(
        new Request(`${APP_ORIGIN}${WORK_DELETE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
          body,
        }),
        testEnv(),
      );

    const others = await seedWork({ authorId: author, status: 'draft', generationState: 'ready' });
    const refused = await postJson(
      JSON.stringify({ [WORK_DELETE_GAME_ID_FIELD]: others.id }),
      await sessionCookie(someone),
    );
    expect(refused.status).toBe(404);
    expect((await gameRow(others.id))?.title).toBe(others.title);

    // 壊れた JSON は id として読まない（何も消さない）。
    const broken = await postJson(`{"${WORK_DELETE_GAME_ID_FIELD}": "${others.id}"`, await sessionCookie(author));
    expect(broken.status).toBe(400);
    expect((await gameRow(others.id))?.title).toBe(others.title);

    const deleted = await postJson(
      JSON.stringify({ [WORK_DELETE_GAME_ID_FIELD]: others.id }),
      await sessionCookie(author),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, result: 'deleted' });
    expect(await gameRow(others.id)).toBeNull();
  });

  it('断りの文言の表は、理由ごとに見出しが分かれ、状態の断りは 409・見つからないは 404', () => {
    const reasons: readonly (GameDeletionRejection | 'not-found' | 'purged')[] = [
      'not-found',
      'published',
      'generating',
      'revising',
      'busy',
      'purged',
    ];
    const headings = reasons.map((reason) => DELETE_REFUSALS[reason].heading);
    expect(new Set(headings).size).toBe(reasons.length);
    expect(DELETE_REFUSALS['not-found'].status).toBe(404);
    for (const reason of ['published', 'generating', 'revising', 'busy', 'purged'] as const) {
      expect(DELETE_REFUSALS[reason].status, reason).toBe(409);
    }
    for (const reason of reasons) {
      expect(oldOperationNamesIn(DELETE_REFUSALS[reason].body), reason).toEqual([]);
    }
  });

  it('id の綴りが違えば 400（引く前に落とす）', async () => {
    const author = await seedUser();
    const response = await postDelete('not-a-uuid', await sessionCookie(author));
    expect(response.status).toBe(400);
  });
});
