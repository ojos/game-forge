import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import { HANDLE_RENAME_INTERVAL_SECONDS, HANDLE_RESERVATION_SECONDS, changeHandle } from '../src/handle.js';
import { HANDLE_PAGE_PREFIX, handlePagePath } from '../src/handle-paths.js';
import { dispatch } from '../src/routes.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { createUsersPageRoutes, handleFromPath } from '../src/users-page.js';
import { WORKS_PER_PAGE } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者ページの `/@handle` と、`/users/<user_id>` からの転送（#381 / 仕様 2.3.1 / 5.10）。
 *
 * **#381 の acceptance「`/users/<user_id>` が `/@handle` へリダイレクトする」をここで見る。**
 * 利用者の決定（猶予中は `/@旧` を `/@新` へ送り、期限後は 404。`/users/<id>` は常に生かす）も固定する。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

/** 固定の時刻（UNIX 秒）。 */
const NOW = 1_950_000_000;

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName = 'ハンドルの作者'): Promise<string> {
  const id = `handle-page-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, displayName)
    .run();
  return id;
}

/**
 * 衝突しないハンドル名を作る。
 *
 * @param prefix 先頭の語
 * @returns ハンドル名
 */
function uniqueHandle(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * アプリの経路表で開く（転送は追わない）。
 *
 * @param path パス
 * @returns レスポンス
 */
async function open(path: string): Promise<Response> {
  return await handleAppRequest(new Request(`${APP_ORIGIN}${path}`), env);
}

/**
 * 時刻を固定した作者ページの経路で開く（90 日の境界を見るため）。
 *
 * @param path パス
 * @param now 現在時刻（UNIX 秒）
 * @returns レスポンス
 */
async function openAt(path: string, now: number): Promise<Response> {
  return await dispatch(createUsersPageRoutes({ now: () => now }), new Request(`${APP_ORIGIN}${path}`), env);
}

describe('`/users/<user_id>` から `/@handle` へ', () => {
  it('ハンドル名を決めた作者は、301 と no-store で `/@handle` へ送る（query を持ち越す）', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('to');
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);

    const response = await open(authorPagePath(userId));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(handlePagePath(handle));
    expect(response.headers.get('cache-control')).toBe('no-store');

    const paged = await open(`${authorPagePath(userId)}?page=2`);
    expect(paged.headers.get('location')).toBe(`${handlePagePath(handle)}?page=2`);
  });

  it('ハンドル名を決めていない作者は、いままでどおり `/users/<user_id>` の画面を出す（自動で作らない）', async () => {
    const userId = await seedUser('ハンドル名なしの作者');
    const response = await open(authorPagePath(userId));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>ハンドル名なしの作者</h1>');
    const rows = await env.DB.prepare('select count(*) as n from handles where user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('改名しても、`/users/<user_id>` はいまのハンドル名へ送る（常に生きている）', async () => {
    const userId = await seedUser();
    const first = uniqueHandle('a');
    const second = uniqueHandle('b');
    expect((await changeHandle(env.DB, userId, first, NOW)).ok).toBe(true);
    expect((await changeHandle(env.DB, userId, second, NOW + HANDLE_RENAME_INTERVAL_SECONDS)).ok).toBe(true);
    expect((await open(authorPagePath(userId))).headers.get('location')).toBe(handlePagePath(second));
  });
});

describe('`/@handle` の作者ページ', () => {
  it('いま使っているハンドル名で作者ページを出し、カードと頁送りも `/@handle` を指す', async () => {
    const userId = await seedUser('アットの作者');
    const handle = uniqueHandle('at');
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);
    // 次の頁が出るだけの公開作品を仕込む。
    for (let i = 0; i <= WORKS_PER_PAGE; i++) {
      await env.DB.prepare(
        `insert into games (id, author_id, status, title, go_version, created_at, generation_state, published_at)
         values (?, ?, ?, ?, '', 1, 'ready', ?)`,
      )
        .bind(crypto.randomUUID(), userId, PUBLISHED_STATUS, `作品${i}`, 9_800_000_000 + i)
        .run();
    }

    const response = await open(handlePagePath(handle));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<h1>アットの作者</h1>');
    expect(body).toContain(`<a class="gf-card-author gf-link-quiet" href="${handlePagePath(handle)}">`);
    expect(body).not.toContain(`href="${authorPagePath(userId)}"`);
    expect(body).toContain(`href="${handlePagePath(handle)}?page=2"`);
  });

  it('大文字を含む綴りは、301 で小文字の綴りへ送る（大文字小文字違いは同じハンドル名）', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('case');
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);
    const response = await open(`${HANDLE_PAGE_PREFIX}${handle.toUpperCase()}?page=1`);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`${handlePagePath(handle)}?page=1`);
  });

  it('知らない名前・形を満たさない綴り・2 セグメントは 404', async () => {
    for (const path of [
      `${HANDLE_PAGE_PREFIX}${uniqueHandle('nobody')}`,
      `${HANDLE_PAGE_PREFIX}ab`,
      `${HANDLE_PAGE_PREFIX}has-dash`,
      `${HANDLE_PAGE_PREFIX}%66oo`,
    ]) {
      expect((await open(path)).status, path).toBe(404);
    }
    // **1 セグメントの経路は `/@a/b` に一致しない**（経路表の 404。作者ページの 404 ではない）。
    const deep = await open(`${HANDLE_PAGE_PREFIX}someone/works`);
    expect(deep.status).toBe(404);
    expect(deep.headers.get('content-type')).toContain('application/json');
    expect((await open(HANDLE_PAGE_PREFIX)).status).toBe(404);
  });

  it('パスから取り出すのは形を満たす綴りだけ', () => {
    expect(handleFromPath('/@Foo_1')).toBe('Foo_1');
    expect(handleFromPath('/@fo')).toBeNull();
    expect(handleFromPath('/@f%6fo')).toBeNull();
    expect(handleFromPath('/@\u212aey')).toBeNull();
  });
});

describe('旧いハンドル名の転送（利用者の決定: 90 日のあいだ新しいハンドル名へ、期限後は 404）', () => {
  /**
   * 改名を 2 回済ませた作者を用意する（1 つ目 → 2 つ目 → 3 つ目）。
   *
   * @returns 利用者と 3 つのハンドル名、最後に改名した時刻
   */
  async function renamedTwice(): Promise<{
    userId: string;
    first: string;
    second: string;
    third: string;
    lastRenameAt: number;
  }> {
    const userId = await seedUser();
    const first = uniqueHandle('one');
    const second = uniqueHandle('two');
    const third = uniqueHandle('three');
    expect((await changeHandle(env.DB, userId, first, NOW)).ok).toBe(true);
    expect((await changeHandle(env.DB, userId, second, NOW + HANDLE_RENAME_INTERVAL_SECONDS)).ok).toBe(true);
    const lastRenameAt = NOW + HANDLE_RENAME_INTERVAL_SECONDS * 2;
    expect((await changeHandle(env.DB, userId, third, lastRenameAt)).ok).toBe(true);
    return { userId, first, second, third, lastRenameAt };
  }

  it('猶予中の旧いハンドル名は、302 と no-store で「いま」のハンドル名へ直接送る（転送を鎖にしない）', async () => {
    const { first, second, third, lastRenameAt } = await renamedTwice();
    for (const old of [first, second]) {
      const response = await openAt(`${handlePagePath(old)}?page=3`, lastRenameAt + 1);
      expect(response.status, old).toBe(302);
      expect(response.headers.get('location'), old).toBe(`${handlePagePath(third)}?page=3`);
      expect(response.headers.get('cache-control'), old).toBe('no-store');
    }
  });

  it('手放してから 90 日を過ぎた旧いハンドル名は 404（ほかの人が取る前でも）', async () => {
    const { second, lastRenameAt } = await renamedTwice();
    const expiredAt = lastRenameAt + HANDLE_RESERVATION_SECONDS;
    expect((await openAt(handlePagePath(second), expiredAt - 1)).status).toBe(302);
    expect((await openAt(handlePagePath(second), expiredAt)).status).toBe(404);
  });

  it('期限後にほかの人が取ったら、その名前はその人の作者ページになる', async () => {
    const { second, lastRenameAt } = await renamedTwice();
    const other = await seedUser('あとから取った人');
    const takenAt = lastRenameAt + HANDLE_RESERVATION_SECONDS;
    expect((await changeHandle(env.DB, other, second, takenAt)).ok).toBe(true);
    const response = await openAt(handlePagePath(second), takenAt);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>あとから取った人</h1>');
  });
});
