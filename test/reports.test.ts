import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  REVIEW_THRESHOLD_REPORTERS,
  hasReported,
  inviteQuotaHalted,
  recordReport,
  reviewVisibleSql,
} from '../src/reports.js';
import { countPublishedForks, listPublishedForks, publishGame } from '../src/games.js';
import { issueInvite } from '../src/invites.js';
import { applySchema } from './helpers/schema.js';
import { resolveSessionUser } from '../src/session-user.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { dispatch } from '../src/routes.js';
import { GENERATE_PATH, generateRoutes } from '../src/generate.js';
import { forkRoutes } from '../src/fork.js';
import { reviseRoutes } from '../src/revise.js';
import { FORK_PATH, REVISE_PATH } from '../src/paths.js';

/** セッションの署名鍵（`test/work-page.test.ts` と同じ形）。 */
const SECRET = 'test-secret-value-for-reports-endpoint-1';

/**
 * 署名鍵を差した env。
 *
 * @returns バインディングと環境変数
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as unknown as Env;
}

/**
 * 有効なセッション cookie を組み立てる。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function bannedCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * cookie を載せた要求を作る。
 *
 * @param cookie `Cookie` ヘッダの値
 * @returns リクエスト
 */
function request(cookie: string): Request {
  return new Request('https://app.example.invalid/', { headers: { cookie } });
}

/** 生成にあたる 3 経路（どれも `resolveSessionUser` を通る）。 */
const GENERATION_ENTRY_POINTS = [
  { name: '生成', routes: generateRoutes, path: GENERATE_PATH },
  { name: 'フォーク', routes: forkRoutes, path: FORK_PATH },
  { name: '推敲', routes: reviseRoutes, path: REVISE_PATH },
] as const;

/**
 * 経路へ POST する。
 *
 * @param routes 経路表
 * @param path パス
 * @param cookie `Cookie` ヘッダの値
 * @returns レスポンス
 */
async function post(
  routes: readonly { readonly method: string; readonly path: string }[],
  path: string,
  cookie: string,
): Promise<Response> {
  return await dispatch(
    routes as never,
    new Request(`https://app.example.invalid${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'ねこのパズル' }),
    }),
    testEnv(),
  );
}

/**
 * 利用者を 1 人用意する。
 *
 * @param id 利用者の id
 * @param invitedBy 招待した人の id（省略すると招待元なし）
 * @returns 利用者の id
 */
async function seedUser(id: string, invitedBy: string | null = null): Promise<string> {
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, invited_by, created_at, banned_at)
     values (?, ?, ?, ?, ?, 0, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.invalid`, id, invitedBy)
    .run();
  return id;
}

/**
 * 作品を 1 件用意する。
 *
 * @param id 作品 id
 * @param authorId 作者
 * @param status 公開状態
 * @param parentId 親（省略すると無し）
 * @returns 作品 id
 */
async function seedGame(
  id: string,
  authorId: string,
  status = 'published',
  parentId: string | null = null,
): Promise<string> {
  await env.DB.prepare(
    `insert or ignore into games
       (id, author_id, parent_id, status, title, go_version, fork_count, created_at, published_at)
     values (?, ?, ?, ?, ?, '1.23', 0, 0, 0)`,
  )
    .bind(id, authorId, parentId, status, `title-${id}`)
    .run();
  return id;
}

/**
 * 作品の審査状態を読む。
 *
 * @param id 作品 id
 * @returns 審査状態
 */
async function reviewStateOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare('select review_state from games where id = ?')
    .bind(id)
    .first<{ review_state: string | null }>();
  return row?.review_state ?? null;
}

/**
 * 作品の公開状態を読む。
 *
 * @param id 作品 id
 * @returns 公開状態
 */
async function statusOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare('select status from games where id = ?')
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

beforeAll(async () => {
  await applySchema();
});

describe('通報の受付（8.4 / #40）', () => {
  it('閾値に達したら審査キューへ入り、自動非表示にはならない', async () => {
    // **#40 の acceptance 1。** 8.4 は「自動非表示は組織的通報で正常なコンテンツを
    // 消せてしまう」と書いており、**`status` が動かないことがこの検査の本体である。**
    const author = await seedUser('rep-author-1');
    const reporter = await seedUser('rep-reporter-1');
    const gameId = await seedGame('rep-g1', author);

    const outcome = await recordReport(env, gameId, reporter, 'ひどい');
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.outcome.queued).toBe(true);
    expect(outcome.ok && outcome.outcome.reporters).toBe(REVIEW_THRESHOLD_REPORTERS);

    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    // **ここが要点。** 自動非表示にしていない。
    expect(await statusOf(gameId)).toBe('published');
  });

  it('同じ人の 2 度目は、データ側の一意制約で断る', async () => {
    const author = await seedUser('rep-author-2');
    const reporter = await seedUser('rep-reporter-2');
    const gameId = await seedGame('rep-g2', author);

    await recordReport(env, gameId, reporter, '');
    const second = await recordReport(env, gameId, reporter, '');
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe('already-reported');

    // 行が 2 本にならない。
    const rows = await env.DB.prepare('select count(*) as n from reports where game_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('同時に走っても 2 行にならない（先に SELECT する形では防げない）', async () => {
    // **`src/invites.ts` が二重使用の防止で「先に SELECT して確認する形にしない」と
    // 書いているのと同じ理由。** SELECT で見てから INSERT すると、同時の 2 本は
    // どちらもすり抜ける。判定はデータ側の一意制約が持つ。
    const author = await seedUser('rep-author-race');
    const reporter = await seedUser('rep-reporter-race');
    const gameId = await seedGame('rep-g-race', author);

    const outcomes = await Promise.all([
      recordReport(env, gameId, reporter, 'a'),
      recordReport(env, gameId, reporter, 'b'),
      recordReport(env, gameId, reporter, 'c'),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const rows = await env.DB.prepare('select count(*) as n from reports where game_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('自分の作品は通報できない', async () => {
    const author = await seedUser('rep-author-3');
    const gameId = await seedGame('rep-g3', author);
    const outcome = await recordReport(env, gameId, author, '');
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('own-work');
  });

  it('存在しない作品は断る', async () => {
    const reporter = await seedUser('rep-reporter-4');
    const outcome = await recordReport(env, 'no-such-game', reporter, '');
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('game-not-found');
  });

  it('理由が長すぎれば断る（行も作らない）', async () => {
    const author = await seedUser('rep-author-5');
    const reporter = await seedUser('rep-reporter-5');
    const gameId = await seedGame('rep-g5', author);

    const outcome = await recordReport(env, gameId, reporter, 'あ'.repeat(501));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('reason-too-long');

    const rows = await env.DB.prepare('select count(*) as n from reports where game_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('cleared にした作品は、通報が来てもキューへ戻さない', async () => {
    // 一度見て問題無しとした作品が同じ通報で戻ると、**審査が終わらない。**
    const author = await seedUser('rep-author-6');
    const gameId = await seedGame('rep-g6', author);
    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_CLEARED, gameId)
      .run();

    const reporter = await seedUser('rep-reporter-6');
    const outcome = await recordReport(env, gameId, reporter, '');
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.outcome.queued).toBe(false);
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);
  });

  it('通報済みかを読める', async () => {
    const author = await seedUser('rep-author-7');
    const reporter = await seedUser('rep-reporter-7');
    const other = await seedUser('rep-other-7');
    const gameId = await seedGame('rep-g7', author);

    expect(await hasReported(env, gameId, reporter)).toBe(false);
    await recordReport(env, gameId, reporter, '');
    expect(await hasReported(env, gameId, reporter)).toBe(true);
    expect(await hasReported(env, gameId, other)).toBe(false);
  });
});

describe('新規露出だけを止める（8.4 / #40）', () => {
  it('審査待ちの子は系統の一覧に出ず、件数からも消える', async () => {
    const author = await seedUser('exp-author');
    const parent = await seedGame('exp-parent', author);
    const clean = await seedGame('exp-child-ok', author, 'published', parent);
    const queued = await seedGame('exp-child-queued', author, 'published', parent);

    expect(await countPublishedForks(env, parent)).toBe(2);

    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, queued)
      .run();

    // **件数と一覧が同じ断片を借りているので、ずれない。**
    expect(await countPublishedForks(env, parent)).toBe(1);
    const items = await listPublishedForks(env, parent, 20);
    expect(items.map((item) => item.id)).toEqual([clean]);
  });

  it('cleared の子は一覧へ戻る', async () => {
    const author = await seedUser('exp2-author');
    const parent = await seedGame('exp2-parent', author);
    const child = await seedGame('exp2-child', author, 'published', parent);

    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, child)
      .run();
    expect(await countPublishedForks(env, parent)).toBe(0);

    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_CLEARED, child)
      .run();
    expect(await countPublishedForks(env, parent)).toBe(1);
  });

  it('既存 URL は生きたままである（status を動かしていない）', async () => {
    // 8.4 の「新規露出のみ停止し既存 URL は生かす」。**配信は `status` で引く**ので、
    // `status` が変わっていないことが「URL が生きている」ことの担保になる。
    const author = await seedUser('exp3-author');
    const gameId = await seedGame('exp3-game', author);
    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, gameId)
      .run();
    expect(await statusOf(gameId)).toBe('published');
  });

  it('露出の条件は 1 か所から来ている（別名を付けても付けなくても同じ）', () => {
    // 書き写しを防ぐための断片なので、**両方の形で同じ意味になること**を見る。
    expect(reviewVisibleSql()).toContain('review_state');
    expect(reviewVisibleSql('g')).toContain('g.review_state');
    expect(reviewVisibleSql()).toContain(REVIEW_CLEARED);
  });
});

describe('BAN と招待枠の停止（7.3 / #40）', () => {
  it('招待した相手が BAN されると、招待枠が止まる', async () => {
    // **#40 の acceptance 3。**
    const inviter = await seedUser('ban-inviter');
    const invitee = await seedUser('ban-invitee', inviter);

    expect(await inviteQuotaHalted(env, inviter)).toBe(false);

    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(invitee).run();
    expect(await inviteQuotaHalted(env, inviter)).toBe(true);
  });

  it('止まると、招待コードを発行できない', async () => {
    // 停止の実体は「枠 0 を渡すこと」である（`src/invite-issuance.ts`）。
    const inviter = await seedUser('ban-inviter-2');
    const invitee = await seedUser('ban-invitee-2', inviter);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(invitee).run();

    const halted = await inviteQuotaHalted(env, inviter);
    const issued = await issueInvite(env.DB, inviter, halted ? 0 : 3);
    expect(issued.ok).toBe(false);
  });

  it('BAN を取り消すと枠が戻る（列で持っていないので戻し忘れが起きない）', async () => {
    const inviter = await seedUser('ban-inviter-3');
    const invitee = await seedUser('ban-invitee-3', inviter);

    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(invitee).run();
    expect(await inviteQuotaHalted(env, inviter)).toBe(true);

    await env.DB.prepare('update users set banned_at = null where id = ?').bind(invitee).run();
    expect(await inviteQuotaHalted(env, inviter)).toBe(false);
  });

  it('他人が招待した相手の BAN では止まらない', async () => {
    const mine = await seedUser('ban-mine');
    const theirs = await seedUser('ban-theirs');
    const banned = await seedUser('ban-theirs-invitee', theirs);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(banned).run();

    expect(await inviteQuotaHalted(env, mine)).toBe(false);
    expect(await inviteQuotaHalted(env, theirs)).toBe(true);
  });
});

describe('公開した子は、審査待ちでも親の fork_count を動かさない前提を壊さない', () => {
  it('publishGame は review_state を触らない', async () => {
    // **状態を 2 か所で持たない**（`migrations/0017_games_review_state.sql`）。
    const author = await seedUser('pub-author');
    const parent = await seedGame('pub-parent', author);
    await env.DB.prepare(
      `insert or ignore into games
         (id, author_id, parent_id, status, title, go_version, fork_count, created_at,
          preview_key, generation_state)
       values ('pub-child', ?, ?, 'draft', 't', '1.23', 0, 0, 'k', 'ready')`,
    )
      .bind(author, parent)
      .run();
    await env.DB.prepare('update games set review_state = ? where id = ?')
      .bind(REVIEW_QUEUED, 'pub-child')
      .run();

    await publishGame(env, 'pub-child', author);
    expect(await reviewStateOf('pub-child')).toBe(REVIEW_QUEUED);
  });
});

describe('BAN された利用者が生成できない（7.3 / #40 の acceptance 2）', () => {
  it('セッションの解決が拒否され、3 経路すべてが止まる', async () => {
    // **この機構は #40 より前から在る**（`src/session-user.ts`）。#40 で新しく作った
    // ものではないが、**acceptance が要求している以上、在ることを検査で押さえる**
    // ——「既に在るはず」で済ませると、次に誰かが外した日に気づけない。
    const user = await seedUser('gen-banned');
    const cookie = await bannedCookie(user);

    // 生成・フォーク・推敲の 3 経路は、どれも `resolveSessionUser` を通る。
    const before = await resolveSessionUser(request(cookie), testEnv());
    expect(before.ok).toBe(true);

    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(user).run();

    const after = await resolveSessionUser(request(cookie), testEnv());
    expect(after.ok).toBe(false);
  });

  it('3 経路とも、BAN された利用者の要求を 401 で断る', async () => {
    // **経路を実際に叩く。** 上の検査は `resolveSessionUser` 単体を見ているので、
    // **経路がその関門を通らなくなったら緑のまま意味を失う。** ここは HTTP の
    // 入口から入って、3 つとも止まることを見る。
    const user = await seedUser('gen-banned-routes');
    const cookie = await bannedCookie(user);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(user).run();

    for (const entry of GENERATION_ENTRY_POINTS) {
      const res = await post(entry.routes, entry.path, cookie);
      expect(res.status, entry.name).toBe(401);
    }
  });
});
