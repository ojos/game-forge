import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { avatarUrl, sandboxOriginOf } from '../src/avatar-paths.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS } from '../src/games.js';
import {
  DAILY_QUOTA_MESSAGE_KEY,
  GENERATE_MESSAGES,
  MONTHLY_LIMIT_MESSAGE_KEY,
  QUOTA_UNKNOWN_NOTICE,
} from '../src/generate-page.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { changeHandle } from '../src/handle.js';
import { handlePagePath } from '../src/handle-paths.js';
import { purgeListCache } from '../src/list-cache.js';
import { GENERATE_PAGE_PATH } from '../src/paths.js';
import { normalizeProfileLink } from '../src/profile.js';
import {
  DAILY_QUOTA_PER_USER,
  DAILY_QUOTA_REASON,
  MONTHLY_COST_LIMIT_JPY,
  MONTHLY_LIMIT_REASON,
  remainingQuotaNotice,
} from '../src/quota.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { publicWorksCountSql, usersApiRoutes } from '../src/users-api.js';
import { ME_API_PATH, USER_API_PREFIX, userApiPath } from '../src/users-api-paths.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { authorCacheKey, likesReceivedSql } from '../src/users-page.js';
import { MY_WORKS_API_PATH } from '../src/works-api-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * ユーザー情報を機械が読める口（#700 / M19-3 / 仕様 5.14）。
 *
 * **#700 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. 未ログインは 401
 * 2. 公開情報が作者ページと一致する（**作者ページを実際に開いて照合する**。値を書き写した期待値と
 *    比べると、両方が同じ向きに間違えたときに緑になる）
 * 3. メールアドレスなど非公開の項目が含まれない（**値を必ず入れてから見る**。入れないと「出ていない」が
 *    値がそもそも無いだけで緑になる。`test/users-page.test.ts` の `seedUser` と同じ規律）
 * 4. `/api/me` の残り枠が画面（生成画面）の表示と一致する
 * 5. 退会した利用者と無い id は同じ 404
 *
 * **経路表を通す**（`handleAppRequest`）。ハンドラを直接呼ぶと、`src/app.ts` への登録漏れと、
 * `/api/me` と `/api/me/works` の食い合いを見逃す。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-users-api-endpoint';

/** 固定の時刻（ハンドル名を取るときの UNIX 秒）。 */
const NOW = 1_950_000_000;

/** 仕込む非公開の値の目印（応答の本文に 1 文字も出てはいけない）。 */
const SECRET_MARK = 'zzsecretzz';

beforeAll(async () => {
  await applySchema();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/**
 * 公開時刻を 1 つ払い出す（**必ず最も新しい値**。`games` はテストファイルをまたいで共有される）。
 */
let publishedAtSeq = 9_300_000_000;

/** @returns UNIX 秒（呼ぶたびに 1 秒ずつ新しくなる） */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/**
 * 利用者を 1 人用意する。**非公開の列をすべて埋める**（上の 3）。
 *
 * id は UUID にする（アイコンの URL は UUID の id でしか組み立たない。`src/avatar-paths.ts`）。
 *
 * @param displayName 表示名
 * @param overrides 列の指定
 * @returns 利用者の id
 */
async function seedUser(
  displayName: string,
  overrides: { readonly bannedAt?: number | null; readonly invitedBy?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, x_handle, invited_by, created_at, banned_at,
                        fork_notice_muted_at)
     values (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
  )
    .bind(
      id,
      `sub-${SECRET_MARK}-${id}`,
      `${SECRET_MARK}-${id}@example.com`,
      displayName,
      `@x_${SECRET_MARK}`,
      overrides.invitedBy ?? null,
      overrides.bannedAt ?? null,
    )
    .run();
  return id;
}

/**
 * 自己紹介・外部リンク・アイコンを入れる。
 *
 * @param userId 利用者 id
 * @returns 入れた外部リンク
 */
async function seedProfile(userId: string): Promise<string> {
  const normalized = normalizeProfileLink('https://example.com/me');
  if (!normalized.ok) {
    throw new Error('テストのリンクが正規化を通りません');
  }
  await env.DB.prepare(
    `update users set bio = ?, profile_links = ?, avatar_sha256 = ?, avatar_set_at = ? where id = ?`,
  )
    .bind('ゲームを作っています。\n\nよろしく', JSON.stringify([normalized.href]), 'a'.repeat(64), 1_900_000_123, userId)
    .run();
  return normalized.href;
}

/**
 * `games` の行を 1 件入れる。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作品 id
 */
async function seedGame(
  authorId: string,
  overrides: { readonly status?: string; readonly likeCount?: number; readonly reviewState?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, 'タイトル', '', 1, 'ready', ?, 0, ?, 'ready', ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      nextPublishedAt(),
      overrides.likeCount ?? 0,
      overrides.reviewState ?? null,
    )
    .run();
  return id;
}

/** @returns セッション cookie */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * アプリの経路表で GET する（転送は追わない）。
 *
 * @param viewer 送る利用者（null なら未ログイン）
 * @param path パス
 * @param accept `accept` ヘッダ
 * @param target 渡す env（既定は秘密を差し替えた env）
 * @returns レスポンス
 */
async function get(
  viewer: string | null,
  path: string,
  accept = 'application/json',
  target: Env = testEnv(),
): Promise<Response> {
  const headers: Record<string, string> = { accept };
  if (viewer !== null) {
    headers.cookie = await sessionCookie(viewer);
  }
  return await handleAppRequest(new Request(`${APP_ORIGIN}${path}`, { headers }), target);
}

/**
 * JSON を取る（ステータスも見る）。
 *
 * @param viewer 送る利用者
 * @param path パス
 * @returns 本文
 */
async function getJson(viewer: string | null, path: string): Promise<Record<string, unknown>> {
  const response = await get(viewer, path);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 作者ページを開いて本文を取る（**キャッシュを捨ててから**。`caches.default` はテスト間で共有される）。
 *
 * @param path 作者ページのパス（`/users/<id>` か `/@handle`）
 * @param userId 作者の id（キャッシュの鍵）
 * @returns HTML
 */
async function authorPageBody(path: string, userId: string): Promise<string> {
  await purgeListCache(authorCacheKey(userId, 1));
  const response = await get(null, path, 'text/html');
  const body = await response.text();
  expect(response.status, body.slice(0, 300)).toBe(200);
  return body;
}

/**
 * 仕込んだ非公開の値が本文に 1 つも無いことを見る。
 *
 * @param text 応答の本文
 * @param inviterId 招待した人の id（入れていれば）
 */
function expectNoPrivateValues(text: string, inviterId?: string): void {
  expect(text).not.toContain(SECRET_MARK);
  expect(text).not.toContain('@example.com');
  for (const key of [
    'email',
    'google_sub',
    'googleSub',
    'invited_by',
    'invitedBy',
    'x_handle',
    'fork_notice_muted_at',
    'banned_at',
    'withdrawal_started_at',
    'is_operator',
    'is_admin',
    'display_name_set_at',
  ]) {
    expect(text, key).not.toContain(`"${key}"`);
  }
  if (inviterId !== undefined) {
    expect(text).not.toContain(inviterId);
  }
}

/**
 * 生成画面から、指定した `id` の `<p>` の中身を取り出す（`test/my-works.test.ts` と同じ）。
 *
 * @param page HTML
 * @param id 要素の id
 * @returns 中身
 */
function paragraphById(page: string, id: string): string {
  return page.match(new RegExp(`<p[^>]* id="${id}">([^<]*)</p>`, 'u'))?.[1] ?? '(出ていない)';
}

/**
 * 台帳へ 1 行積む（日次の枠を 1 回減らす）。
 *
 * **費用は既定で 0 円**——月次はサービス全体なので、積むと同じ月を見る他の検査を動かす。月次の上限を
 * 仕込む検査だけが、時刻を離れた月へ固定してから費用を積む（下の「月次の上限」）。
 *
 * @param userId 利用者 id
 * @param costJpy 費用（円）
 */
async function seedLedgerRow(userId: string, costJpy = 0): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, ?, 1, ?)`,
  )
    .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, costJpy, Math.floor(Date.now() / 1000))
    .run();
}

describe('経路（#700）', () => {
  it('経路表に重複と不正な前方一致を作らない', () => {
    const routes = createAppRoutes(testEnv());
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
    expect(usersApiRoutes.map((route) => route.path)).toEqual([ME_API_PATH, USER_API_PREFIX]);
  });

  it('`/api/me` を足しても、`/api/me/works` は自作の一覧の口のまま', async () => {
    const userId = await seedUser('一覧の人');
    const body = await getJson(userId, MY_WORKS_API_PATH);
    expect(body).toHaveProperty('works');
    expect(body).not.toHaveProperty('quota');
  });
});

describe('未ログインは 401（#700）', () => {
  it('2 つの口とも 401 `unauthorized`', async () => {
    const userId = await seedUser('誰か');
    for (const path of [ME_API_PATH, userApiPath(userId), userApiPath('no-such-user')]) {
      const response = await get(null, path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('BAN された呼び出し元・退会を始めた呼び出し元も 401', async () => {
    const banned = await seedUser('BAN された呼び出し元', { bannedAt: 1 });
    const withdrawing = await seedUser('退会中の呼び出し元');
    await env.DB.prepare('update users set withdrawal_started_at = 1 where id = ?').bind(withdrawing).run();
    for (const caller of [banned, withdrawing]) {
      for (const path of [ME_API_PATH, userApiPath(caller)]) {
        const response = await get(caller, path);
        expect(response.status, path).toBe(401);
        expect(await response.json()).toEqual({ error: 'unauthorized' });
      }
    }
  });
});

describe('公開情報は作者ページと一致する（#700）', () => {
  it('ハンドル名・自己紹介・外部リンク・アイコンのある作者', async () => {
    const viewer = await seedUser('見る人');
    const authorId = await seedUser('作者の名前');
    const link = await seedProfile(authorId);
    const handle = `api${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    expect((await changeHandle(env.DB, authorId, handle, NOW)).ok).toBe(true);
    // 数えるもの 2 件（審査を通った 1 件を含む）と、数えないもの 3 件（下書き・取り下げ・審査待ち）。
    await seedGame(authorId, { likeCount: 3 });
    await seedGame(authorId, { likeCount: 4, reviewState: REVIEW_CLEARED });
    await seedGame(authorId, { status: DRAFT_STATUS, likeCount: 100 });
    await seedGame(authorId, { status: REMOVED_STATUS, likeCount: 100 });
    await seedGame(authorId, { likeCount: 100, reviewState: REVIEW_QUEUED });

    const api = await getJson(viewer, userApiPath(authorId));

    // `/users/<id>` は `/@handle` へ送る。**API の `links.page` はその行き先と同じ**。
    const redirect = await get(null, authorPagePath(authorId), 'text/html');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe(handlePagePath(handle));
    const page = await authorPageBody(handlePagePath(handle), authorId);

    expect(api.id).toBe(authorId);
    expect(api.handle).toBe(handle);
    expect(api.links).toEqual({ page: handlePagePath(handle), api: userApiPath(authorId) });
    expect(page).toContain(`<h1>${api.displayName as string}</h1>`);
    expect(api.displayName).toBe('作者の名前');
    expect(page).toContain(`<p class="gf-author-likes">受け取ったいいね ${api.likesReceived as number}</p>`);
    expect(api.likesReceived).toBe(7);
    // **作者ページは数を出していない**ので、並んだカードを数える（20 件未満なので 1 頁に収まる）。
    expect(page.split('<li class="gf-card gf-block">').length - 1).toBe(api.publicWorks);
    expect(api.publicWorks).toBe(2);
    expect(api.profileLinks).toEqual([link]);
    expect(page).toContain(`href="${link}"`);
    expect(api.bio).toBe('ゲームを作っています。\n\nよろしく');
    expect(page).toContain('<p>ゲームを作っています。</p>');
    expect(page).toContain('<p>よろしく</p>');
    const expectedAvatar = avatarUrl(
      sandboxOriginOf(new Request(APP_ORIGIN), env.SANDBOX_HOST),
      authorId,
      1_900_000_123,
    );
    expect(api.avatarUrl).toBe(expectedAvatar);
    expect(page).toContain(expectedAvatar!);
  });

  it('ハンドル名もプロフィールも作品も無い作者', async () => {
    const viewer = await seedUser('見る人');
    const authorId = await seedUser('作品の無い作者');
    const api = await getJson(viewer, userApiPath(authorId));
    const page = await authorPageBody(authorPagePath(authorId), authorId);
    expect(api).toEqual({
      id: authorId,
      displayName: '作品の無い作者',
      handle: null,
      bio: '',
      profileLinks: [],
      avatarUrl: null,
      publicWorks: 0,
      likesReceived: 0,
      links: { page: authorPagePath(authorId), api: userApiPath(authorId) },
    });
    expect(page).toContain('<h1>作品の無い作者</h1>');
    expect(page).toContain('受け取ったいいね 0');
  });

  it('BAN された作者も 404 にしない（作者ページと同じ。#330）', async () => {
    const viewer = await seedUser('見る人');
    const authorId = await seedUser('BAN された作者', { bannedAt: 1 });
    await seedGame(authorId, { likeCount: 2 });
    const api = await getJson(viewer, userApiPath(authorId));
    expect(api.publicWorks).toBe(1);
    expect(api.likesReceived).toBe(2);
    await authorPageBody(authorPagePath(authorId), authorId);
  });

  it('数と被いいねは同じ条件で数える（`reviewVisibleSql` を共有する）', () => {
    const whereOf = (sql: string): string => sql.slice(sql.indexOf('where'));
    expect(whereOf(publicWorksCountSql())).toBe(whereOf(likesReceivedSql()));
  });
});

describe('非公開の項目は返さない（#700）', () => {
  it('他人の公開プロフィールにも、自分の情報にも、メールアドレス・Google の識別子・招待の関係・配信の設定が無い', async () => {
    const inviter = await seedUser('招待した人');
    const userId = await seedUser('招待された人', { invitedBy: inviter });
    await seedProfile(userId);
    const viewer = await seedUser('見る人');

    for (const [caller, path] of [
      [viewer, userApiPath(userId)],
      [userId, ME_API_PATH],
    ] as const) {
      const response = await get(caller, path);
      const text = await response.text();
      expect(response.status, path).toBe(200);
      expectNoPrivateValues(text, inviter);
    }
  });

  it('`/api/me` のキーは公開プロフィールに `quota` を足したものだけ', async () => {
    const userId = await seedUser('自分');
    const me = await getJson(userId, ME_API_PATH);
    const profile = await getJson(userId, userApiPath(userId));
    const { quota, ...rest } = me;
    expect(rest).toEqual(profile);
    expect(Object.keys(quota as object).sort()).toEqual(['dailyLimit', 'remaining', 'resetsAt', 'state']);
  });
});

describe('`/api/me` の残り枠は生成画面の表示と一致する（#700）', () => {
  /**
   * 生成画面の残枠の文言と、口の `quota` を並べる。
   *
   * @param userId 利用者 id
   * @returns 両方の値
   */
  async function quotaOnBoth(
    userId: string,
  ): Promise<{ readonly page: string; readonly api: Record<string, unknown> }> {
    const page = await (await get(userId, GENERATE_PAGE_PATH, 'text/html')).text();
    const me = await getJson(userId, ME_API_PATH);
    return { page: paragraphById(page, 'generate-quota'), api: me.quota as Record<string, unknown> };
  }

  it('枠が残っているとき、残り回数が「本日の残り生成枠 N回」と同じ', async () => {
    const userId = await seedUser('生成した人');
    for (let index = 0; index < 3; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBoth(userId);
    expect(shown.api).toEqual({
      state: 'available',
      remaining: DAILY_QUOTA_PER_USER - 3,
      dailyLimit: DAILY_QUOTA_PER_USER,
      resetsAt: null,
    });
    expect(shown.page).toBe(remainingQuotaNotice(shown.api.remaining as number));
  });

  it('日次の枠が尽きたとき、画面は日次の文言で、口は `daily-quota` と残り 0 と戻る時刻', async () => {
    const userId = await seedUser('使い切った人');
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBoth(userId);
    expect(shown.page).toBe(GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]);
    expect(shown.api.state).toBe(DAILY_QUOTA_REASON);
    expect(shown.api.remaining).toBe(0);
    expect(shown.api.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('残枠を読めなくても口ごと 500 にせず、200 で `unknown` を返す（画面も「読めない」の文言）', async () => {
    const userId = await seedUser('読めない人');
    // 枠の集計（月次の費用）だけを失敗させる。セッションの解決とプロフィールの読み取りは通す
    // （`test/generate-page.test.ts` の「残枠を読めなくても画面は出る」と同じ仕込み）。
    const broken = {
      ...testEnv(),
      DB: {
        prepare(query: string) {
          if (query.includes('sum(cost_jpy)')) {
            throw new Error('D1 is down');
          }
          return env.DB.prepare(query);
        },
        batch: env.DB.batch.bind(env.DB),
      } as unknown as D1Database,
    };

    const response = await get(userId, ME_API_PATH, 'application/json', broken);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.quota).toEqual({
      state: 'unknown',
      remaining: null,
      dailyLimit: DAILY_QUOTA_PER_USER,
      resetsAt: null,
    });
    // プロフィールは読めている（枠の失敗に巻き込まない）。
    expect(body.displayName).toBe('読めない人');

    const page = await (await get(userId, GENERATE_PAGE_PATH, 'text/html', broken)).text();
    expect(paragraphById(page, 'generate-quota')).toBe(QUOTA_UNKNOWN_NOTICE);
  });

  it('他人の公開プロフィールには残り枠を載せない', async () => {
    const viewer = await seedUser('見る人');
    const other = await seedUser('他人');
    const body = await getJson(viewer, userApiPath(other));
    expect(body).not.toHaveProperty('quota');
  });
});

describe('退会した利用者と無い id は同じ 404（#700）', () => {
  it('退会を始めた・退会を終えた・無い・形の違う id は、すべて `{"error":"not-found"}`', async () => {
    const viewer = await seedUser('見る人');
    const withdrawing = await seedUser('退会中の作者');
    await seedGame(withdrawing);
    await env.DB.prepare('update users set withdrawal_started_at = 1 where id = ?').bind(withdrawing).run();
    const withdrawn = await seedUser('退会した作者');
    await env.DB.prepare('update users set withdrawal_started_at = 1, withdrawn_at = 2 where id = ?')
      .bind(withdrawn)
      .run();

    const paths = [
      userApiPath(withdrawing),
      userApiPath(withdrawn),
      userApiPath(crypto.randomUUID()),
      userApiPath('x'.repeat(65)),
      `${USER_API_PREFIX}%`,
      `${USER_API_PREFIX}a/b`,
      USER_API_PREFIX,
    ];
    const bodies = new Set<string>();
    for (const path of paths) {
      const response = await get(viewer, path);
      const text = await response.text();
      expect(response.status, path).toBe(404);
      expect(JSON.parse(text), path).toEqual({ error: 'not-found' });
      bodies.add(text);
    }
    expect(bodies.size).toBe(1);

    // 作者ページも同じ判断をしている（退会は 404）。
    for (const id of [withdrawing, withdrawn]) {
      await purgeListCache(authorCacheKey(id, 1));
      expect((await get(null, authorPagePath(id), 'text/html')).status).toBe(404);
    }
  });
});

describe('`/api/me` の月次の上限（#700）', () => {
  /**
   * **月次はサービス全体の累計である**（4.3）。上限ぶんの費用を積むと、同じ月を見る他の検査がすべて
   * 月次で止まる。**時刻を離れた月へ固定してから積む**（`test/generate-page.test.ts` の残枠の検査と同じ
   * 手順。あちらの 2020 年 5 月とも重ならない月にする）。`Date` だけを差し替えるのは、`setTimeout` まで
   * 差し替えると D1 の I/O が進まなくなるためである。
   */
  const AT_MS = Date.UTC(2031, 2, 15, 3);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('月次の上限に達したら `monthly-limit`・残り null・戻る時刻 null で、生成画面は月次の文言', async () => {
    // 止めた利用者と、口を叩く利用者は別で構わない（月次は 1 人の枠ではない）。
    const spender = await seedUser('月次を使い切った人');
    await seedLedgerRow(spender, MONTHLY_COST_LIMIT_JPY);
    const userId = await seedUser('月次で止まった人');

    const me = await getJson(userId, ME_API_PATH);
    expect(me.quota).toEqual({
      state: MONTHLY_LIMIT_REASON,
      remaining: null,
      dailyLimit: DAILY_QUOTA_PER_USER,
      resetsAt: null,
    });

    const page = await (await get(userId, GENERATE_PAGE_PATH, 'text/html')).text();
    expect(paragraphById(page, 'generate-quota')).toBe(GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY]);
  });
});
