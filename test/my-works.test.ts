import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH, OAUTH_COOKIE } from '../src/auth/google.js';
import {
  DRAFT_STATUS,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  UNTITLED_TITLE,
  listAuthoredGames,
} from '../src/games.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import {
  DAILY_QUOTA_MESSAGE_KEY,
  GENERATE_MESSAGES,
  remainingQuotaNotice,
} from '../src/generate-page.js';
import {
  EMPTY_MY_WORKS_STATS,
  LIKES_DELAY_NOTE,
  PLAYS_SINCE_NOTE,
  STATS_UNAVAILABLE_NOTICE,
  STAT_CARDS,
  loadMyWorksStats,
  myWorksStatsBinds,
  myWorksStatsSql,
  renderMyWorksStats,
} from '../src/my-works-stats.js';
import { GENERATE_PAGE_PATH } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER } from '../src/quota.js';
import { HOME_PATH } from '../src/home.js';
import { formatJstMinutes, toIsoTimestamp } from '../src/jst.js';
import {
  MAX_MY_WORKS_PAGE,
  MY_WORKS_PAGE_PARAM,
  MY_WORKS_PATH,
  MY_WORKS_PER_PAGE,
  displayTitleOf,
  myWorksPath,
  publicationLabelOf,
  rowStateOf,
  toMyWorksPageNumber,
} from '../src/my-works.js';
import { LIKED_WORKS_PATH } from '../src/liked-works-paths.js';
import {
  MY_WORKS_FILTERS,
  MY_WORKS_FILTER_PARAM,
  myWorksSql,
  toMyWorksFilter,
} from '../src/my-works-query.js';
import type { MyWorksFilter } from '../src/my-works-query.js';
import { ogpImagePath } from '../src/ogp.js';
import {
  MY_WORKS_BULK_PATH,
  WORKS_BULK_ACTION_FIELD,
  WORKS_BULK_GAME_ID_FIELD,
} from '../src/works-bulk-paths.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { PUBLIC_WORKS_PATH } from '../src/works-list.js';
import { STALE_AFTER_SECONDS, WORK_PAGE_PREFIX } from '../src/work-page.js';
// **各行はエディットページへ移る**（#664 / #666）。
import { workEditPath } from '../src/work-edit-paths.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 「あなたの作品」一覧（#152）。
 *
 * **#152 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. ログイン済みで開くと自分の作品が新しい順に出る
 * 2. **他人の draft が出ない**
 * 3. 生成中の作品が一覧に出て、そこから URL へ辿れる
 *
 * 2 は `test/games.test.ts` が引く層で押さえており、ここでは**画面まで通した経路**で
 * 重ねて確かめる。層を 1 つに絞らないのは、絞り込みが SQL から画面側へ移された場合に
 * （それ自体が防ぎたい変更である）引く層のテストだけが落ちる形にしたいためである。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-my-works-list-1';

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * id を毎回ランダムにするのは、`games` が他のテストファイルとも共有されるためである。
 * 作者を一意にしておけば、一覧の絞り込みがそのままテストの独立性になる。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `works-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * `games` の行を 1 件入れる。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作った作品の id
 */
async function seedGame(
  authorId: string,
  overrides: {
    readonly status?: string;
    readonly title?: string;
    readonly createdAt?: number;
    readonly generationState?: string;
    readonly forkCount?: number;
    readonly likeCount?: number;
    /** `games.play_count`（#377）。 */
    readonly playCount?: number;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state, fork_count, like_count,
        play_count)
     values (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? DRAFT_STATUS,
      overrides.title ?? 'タイトル',
      overrides.createdAt ?? Math.floor(Date.now() / 1000),
      overrides.generationState ?? 'ready',
      overrides.forkCount ?? 0,
      overrides.likeCount ?? 0,
      overrides.playCount ?? 0,
    )
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * 失効時刻は実時刻から取る（固定値にすると、その時刻を過ぎた日から落ちる時限式の
 * テストになる。`test/invite-issuance.test.ts` と同じ理由）。
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
 * 作者の作品を、指定した件数だけまとめて入れる（#552 の頁送りの検査用）。
 *
 * **1 件ずつ `run` しない。** 1,000 件を超える検査があり、往復の数がそのまま検査の時間になる。
 * `created_at` は `index` の昇順に 1 秒ずつずらす——**添字が大きいほど新しい**ので、
 * 新しい順の一覧では配列を逆にした順に並ぶ。
 *
 * @param authorId 作者
 * @param count 入れる件数
 * @returns 作った作品の id（古い順）
 */
async function seedGames(authorId: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const statement = env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
     values (?, ?, ?, 'タイトル', '', ?, 'ready')`,
  );
  for (let start = 0; start < count; start += 100) {
    await env.DB.batch(
      ids
        .slice(start, start + 100)
        .map((id, offset) => statement.bind(id, authorId, DRAFT_STATUS, 1_600_000_000 + start + offset)),
    );
  }
  return ids;
}

/**
 * 一覧を開く。
 *
 * **経路表を通す。** ハンドラを直接呼ぶと、`src/app.ts` への登録漏れを見逃す。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら省略）
 * @param search クエリ（`?page=2` など。省略なら付けない）
 * @returns レスポンス
 */
async function openList(cookie?: string, search = ''): Promise<Response> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${MY_WORKS_PATH}${search}`, { headers }),
    testEnv(),
  );
}

/**
 * 頁送りの `<nav>` を取り出す。
 *
 * @param page 画面の HTML
 * @returns 頁送りの HTML（出ていなければ空文字）
 */
function pagerOf(page: string): string {
  return /<nav class="gf-pager" aria-label="頁送り">[\s\S]*?<\/nav>/u.exec(pageBodyOf(page))?.[0] ?? '';
}

/** 「前の 30 件」のリンク。 */
function previousLink(page: number): string {
  return `<a class="gf-button gf-button-secondary gf-button-sm" href="${myWorksPath(page)}">前の ${MY_WORKS_PER_PAGE} 件</a>`;
}

/** 「次の 30 件」のリンク（右端に寄せる `.gf-pager-next` 付き）。 */
function nextLink(page: number): string {
  return `<a class="gf-button gf-button-secondary gf-button-sm gf-pager-next" href="${myWorksPath(page)}">次の ${MY_WORKS_PER_PAGE} 件</a>`;
}

describe('経路の登録（#152）', () => {
  it('「あなたの作品」は作品ページと同じ接頭辞の下にある（#328 で移した）', () => {
    // 綴りを 2 か所に書かない決定を、導出の結果として固定する。
    expect(MY_WORKS_PATH.startsWith(WORK_PAGE_PREFIX)).toBe(true);
    // **親の位置は公開作品の一覧が取った**（#328 / 仕様 2.3.2）。「URL を 1 本でも
    // 覚えている人が末尾を削るだけで一覧に着く」（#152）は失われていない——
    // 着く先が、共有 URL を踏んだ未ログインの閲覧者にとって意味のある行き先になった。
    expect(WORK_PAGE_PREFIX).toBe(`${PUBLIC_WORKS_PATH}/`);
  });

  it('経路表に登録されていて、重複も綴り違いも無い', () => {
    const routes = createAppRoutes(env);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain(
      `GET ${MY_WORKS_PATH}`,
    );
    // 完全一致の `/works` と前方一致の `/works/` は別の鍵になる（`src/routes.ts`）。
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
  });

  it('作品ページの前方一致に飲み込まれない', async () => {
    // `/works` は前方一致 `/works/` に一致しないが、**登録順や一致規則を変えた瞬間に
    // 一覧が 404 になる**ため、実際に引いて確かめる。
    const response = await openList();
    expect(response.status).not.toBe(404);
  });
});

describe('ログインの要求（#152）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openList();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('ログインへ送るときに、戻り先を署名付きの一時 cookie へ積む（2.3.11 / #374）', async () => {
    // 戻り先は query へ出さない（オープンリダイレクトの入口を作らない）。着地まで
    // 通す検査は `test/auth-google.test.ts` が持つ。
    const response = await openList();
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${OAUTH_COOKIE}=`))).toBe(
      true,
    );
  });

  it('未ログインの応答に作品の id が 1 つも載らない', async () => {
    const author = await seedUser();
    const gameId = await seedGame(author);
    const body = await (await openList()).text();
    expect(body).not.toContain(gameId);
  });

  it('BAN された利用者には出さない', async () => {
    // 判定は `resolveSessionUser` が持つ（署名だけを信じない）。一覧がその判定を
    // 迂回していないことを見る。
    const userId = await seedUser();
    await seedGame(userId);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(userId).run();

    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });
});

describe('他人の draft が出ない（#152 acceptance 2）', () => {
  it('別の利用者の作品は id もタイトルも出ない', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    const myGame = await seedGame(mine, { title: '自分の作品' });
    // 他人の側は「生成中」「完成」の両方を置く。**どちらも draft である**
    // （公開の操作は M4-1 / #26 が持ち、未実装。5.4）。
    const theirReady = await seedGame(theirs, { title: '他人の完成した下書き' });
    const theirPending = await seedGame(theirs, {
      title: '他人の生成中',
      generationState: 'pending',
    });

    const body = await (await openList(await sessionCookie(mine))).text();
    expect(body).toContain(myGame);
    expect(body).toContain('自分の作品');
    expect(body).not.toContain(theirReady);
    expect(body).not.toContain(theirPending);
    expect(body).not.toContain('他人の完成した下書き');
    expect(body).not.toContain('他人の生成中');
  });

  it('作品を 1 件も持たない利用者には空の一覧を出す', async () => {
    // 他人の作品があるときに、**それが 0 件の利用者の一覧へ漏れない**ことを見る。
    const stranger = await seedUser();
    const other = await seedUser();
    const otherGame = await seedGame(other, { title: '無関係な作品' });

    const body = await (await openList(await sessionCookie(stranger))).text();
    expect(body).toContain('まだ作品がありません');
    expect(body).not.toContain(otherGame);
    expect(body).not.toContain('無関係な作品');
  });
});

describe('一覧の中身（#152 acceptance 1・3）', () => {
  it('自分の作品が新しい順に出る', async () => {
    const userId = await seedUser();
    const oldest = await seedGame(userId, { createdAt: 1_700_000_000 });
    const middle = await seedGame(userId, { createdAt: 1_700_000_100 });
    const newest = await seedGame(userId, { createdAt: 1_700_000_200 });

    const body = await (await openList(await sessionCookie(userId))).text();
    const positions = [newest, middle, oldest].map((id) => body.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('生成中の作品が出て、そこから作品のエディットページへ辿れる（#664）', async () => {
    const userId = await seedUser();
    const pending = await seedGame(userId, { generationState: 'pending' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain(`href="${workEditPath(pending)}"`);
    expect(body).toContain('生成中');
  });

  it('状態ごとの札が出る', async () => {
    const userId = await seedUser();
    await seedGame(userId, { generationState: 'ready' });
    await seedGame(userId, { generationState: 'failed' });

    const body = await (await openList(await sessionCookie(userId))).text();
    // #666 で表の「状態」の列にした。生成が済んだ行は公開中か下書き、失敗した行は「失敗」である。
    expect(body).toContain('<td class="gf-works-state"><span class="gf-chip">下書き</span></td>');
    expect(body).toContain('<td class="gf-works-state"><span class="gf-chip">失敗</span></td>');
  });

  it('長く動いていない生成は「時間がかかっています」と出す', async () => {
    // 閾値の判断は `src/work-page.ts` の `looksStalled` を共有する（文言だけが別）。
    const userId = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    await seedGame(userId, {
      generationState: 'running',
      createdAt: now - STALE_AFTER_SECONDS - 60,
    });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain('時間がかかっています');
  });

  it('生成日時が機械可読な形と日本時間の両方で出る', async () => {
    // **「もうすぐ消える」を出さない代わりに置いている事実である**（`src/my-works.ts`）。
    // 14 日の掃除（3.7 / 確定13）は M5-4（#35）が未着手で、残り日数を出すと
    // 動いていない削除を動いているように書くことになる。
    const userId = await seedUser();
    await seedGame(userId, { createdAt: 1_700_000_000 });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain('datetime="2023-11-14T22:13:20.000Z"');
    expect(body).toContain('2023-11-15 07:13');
  });

  it('タイトルを HTML へそのまま入れない', async () => {
    // 仮タイトルはプロンプト由来の利用者入力である（`draftTitleFromPrompt`）。
    const userId = await seedUser();
    await seedGame(userId, { title: '<script>alert(1)</script>' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('removed は一覧に出ない', async () => {
    const userId = await seedUser();
    const removed = await seedGame(userId, { status: 'removed', title: '取り下げた作品' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).not.toContain(removed);
    expect(body).not.toContain('取り下げた作品');
  });

  it('行に公開中と下書きを出す（#641）', async () => {
    // **#637 で公開をやめた作品が下書きとして戻るようになり、この一覧に 2 つの状態が混ざる。**
    // 混ざるのに見分けられないと、戻した作品を作者が探せない（2026-09-17 の本番の確認）。
    const userId = await seedUser();
    await seedGame(userId, { status: PUBLISHED_STATUS, title: '出している作品', createdAt: 1_700_000_200 });
    await seedGame(userId, { status: DRAFT_STATUS, title: '下書きの作品', createdAt: 1_700_000_100 });

    const body = await (await openList(await sessionCookie(userId))).text();
    const published = body.slice(body.indexOf('出している作品'), body.indexOf('下書きの作品'));
    const draft = body.slice(body.indexOf('下書きの作品'));

    expect(published).toContain('<span class="gf-chip">公開中</span>');
    expect(published).not.toContain('下書き');
    expect(draft).toContain('<span class="gf-chip">下書き</span>');
    expect(draft).not.toContain('公開中');
  });

  it('生成中の行の札は「生成中」の 1 枚である（#666 で表の 1 列に畳んだ）', async () => {
    // #641 では 2 枚（生成中 ＋ 下書き）を並べていた。**公開できるのは生成が済んだ作品だけ**なので、生成中の行は必ず
    // 下書きであり、4 つ（公開中／下書き／生成中／失敗）は重ならない（`src/my-works.ts` の `stateChipOf`）。
    const userId = await seedUser();
    await seedGame(userId, { status: DRAFT_STATUS, generationState: 'running', title: '生成中の作品' });

    const body = await (await openList(await sessionCookie(userId))).text();
    const row = /<tr><td class="gf-works-select">(?:(?!<\/tr>)[\s\S])*生成中の作品[\s\S]*?<\/tr>/u.exec(body)?.[0] ?? '';
    expect(row).toContain('<td class="gf-works-state"><span class="gf-chip gf-chip-emphasis">生成中</span></td>');
    expect(row).not.toContain('<span class="gf-chip">下書き</span>');
  });

  it('知らない status では札を出さない（公開中と言い切らない）', () => {
    expect(publicationLabelOf('published')).toBe('公開中');
    expect(publicationLabelOf('draft')).toBe('下書き');
    // **`removed` はこの一覧に来ない**が、来ても「公開中」とは言わない。
    expect(publicationLabelOf('removed')).toBeNull();
    expect(publicationLabelOf('unexpected')).toBeNull();
  });
});

describe('頁送り（#552）', () => {
  it('75 件の作者で、1 頁目 30 件・2 頁目 30 件・3 頁目 15 件になり、前／次が正しく出る（#666 で 30 件ずつ）', async () => {
    const userId = await seedUser();
    // 新しい順に並べた id（先頭がいちばん新しい）。
    const newestFirst = (await seedGames(userId, 75)).reverse();
    const cookie = await sessionCookie(userId);

    const pages = await Promise.all(
      ['', `?${MY_WORKS_PAGE_PARAM}=2`, `?${MY_WORKS_PAGE_PARAM}=3`].map(
        async (search) => await (await openList(cookie, search)).text(),
      ),
    );
    const expected = [newestFirst.slice(0, 30), newestFirst.slice(30, 60), newestFirst.slice(60)];
    pages.forEach((page, index) => {
      const shown = newestFirst.filter((id) => page.includes(id));
      // 件数だけでなく**どの作品か**を見る（2 頁目が 1 頁目と同じ 30 件を出しても件数は合う）。
      expect(shown, `${index + 1} 頁目`).toEqual(expected[index]);
      // 頁の中でも新しい順である。
      const positions = shown.map((id) => page.indexOf(id));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
    expect(pages.map((page) => newestFirst.filter((id) => page.includes(id)).length)).toEqual([30, 30, 15]);
    // 31 件目（新しい順）は 1 頁目に出ず、2 頁目の先頭に出る（#666 の acceptance）。
    expect(pages[0]).not.toContain(newestFirst[30]);
    expect(newestFirst.filter((id) => pages[1]!.includes(id))[0]).toBe(newestFirst[30]);

    // 1 頁目: 前は無く、次は 2 頁目（`?page=` を付ける）。
    expect(pagerOf(pages[0]!)).toBe(`<nav class="gf-pager" aria-label="頁送り">${nextLink(2)}</nav>`);
    // 2 頁目: 前は 1 頁目（`?page=` を付けない綴り）、次は 3 頁目。DOM の順は前 → 次。
    expect(pagerOf(pages[1]!)).toBe(`<nav class="gf-pager" aria-label="頁送り">${previousLink(1)}\n${nextLink(3)}</nav>`);
    expect(myWorksPath(1)).toBe(MY_WORKS_PATH);
    // 3 頁目: 前は 2 頁目で、次は無い（押しても空の頁へ行く導線を出さない）。
    expect(pagerOf(pages[2]!)).toBe(`<nav class="gf-pager" aria-label="頁送り">${previousLink(2)}</nav>`);
    expect(`${MY_WORKS_PATH}?${MY_WORKS_PAGE_PARAM}=2`).toBe(myWorksPath(2));
  });

  it('頁送りは一覧の直後で、「いいねした作品」などの副のボタンより前にある', async () => {
    const userId = await seedUser();
    const newestFirst = (await seedGames(userId, MY_WORKS_PER_PAGE + 1)).reverse();
    const main = pageBodyOf(await (await openList(await sessionCookie(userId))).text());
    const pager = main.indexOf('<nav class="gf-pager"');
    expect(pager).toBeGreaterThan(main.indexOf(workEditPath(newestFirst[MY_WORKS_PER_PAGE - 1]!)));
    expect(pager).toBeLessThan(main.indexOf(`href="${LIKED_WORKS_PATH}"`));
  });

  it('ちょうど 30 件なら頁送りを出さない（1 件多く引いて「次」の有無を決める）', async () => {
    const userId = await seedUser();
    await seedGames(userId, MY_WORKS_PER_PAGE);
    const page = await (await openList(await sessionCookie(userId))).text();
    expect(pagerOf(page)).toBe('');
    expect(page).not.toContain('gf-pager');
  });

  it('読めない `?page=`（0・負・文字列・上限を超える値）は 1 頁目になる', async () => {
    const userId = await seedUser();
    const newestFirst = (await seedGames(userId, 75)).reverse();
    const cookie = await sessionCookie(userId);
    const firstPage = newestFirst.slice(0, MY_WORKS_PER_PAGE);

    // `2abc`・`2.5`・`2e3`・前後の空白・`02` は `parseInt` なら 2 頁目になる綴りである（PR #560 の Copilot code review）。
    for (const value of [
      '0', '-1', '-20', 'abc', '', String(MAX_MY_WORKS_PAGE + 1), '999999', '1e3',
      '2abc', '2.5', '2e3', ' 2', '2 ', '02', '+2', '0x2',
    ]) {
      const page = await (await openList(cookie, `?${MY_WORKS_PAGE_PARAM}=${encodeURIComponent(value)}`)).text();
      expect(newestFirst.filter((id) => page.includes(id)), `?page=${value}`).toEqual(firstPage);
      expect(pagerOf(page), `?page=${value}`).toBe(`<nav class="gf-pager" aria-label="頁送り">${nextLink(2)}</nav>`);
    }
  });

  it('`?page=` を頁番号へ落とす（純関数）', () => {
    expect(toMyWorksPageNumber(null)).toBe(1);
    expect(toMyWorksPageNumber('')).toBe(1);
    expect(toMyWorksPageNumber('0')).toBe(1);
    expect(toMyWorksPageNumber('-3')).toBe(1);
    expect(toMyWorksPageNumber('abc')).toBe(1);
    expect(toMyWorksPageNumber('2')).toBe(2);
    expect(toMyWorksPageNumber(String(MAX_MY_WORKS_PAGE))).toBe(MAX_MY_WORKS_PAGE);
    // 上限を超える値は上限の頁へ寄せず、1 頁目にする（#552 の acceptance）。
    expect(toMyWorksPageNumber(String(MAX_MY_WORKS_PAGE + 1))).toBe(1);
    expect(toMyWorksPageNumber('99999999999999999999')).toBe(1);
    // 文字列全体が 1 から始まる 10 進の数字のときだけ数に直す（`parseInt` のように先頭の数字だけを読まない）。
    for (const value of ['2abc', '2.5', '2e3', ' 2', '2 ', '\t2', '2\n', '02', '002', '+2', '0x2', '２']) {
      expect(toMyWorksPageNumber(value), JSON.stringify(value)).toBe(1);
    }
    expect(toMyWorksPageNumber('10')).toBe(10);
    expect(MY_WORKS_PER_PAGE).toBe(30);
    expect(MAX_MY_WORKS_PAGE).toBe(50);
  });

  it('50 件を超えても「新しい 50 件までを表示しています」を出さず、51 件目以降も頁送りでたどれる', async () => {
    const userId = await seedUser();
    const newestFirst = (await seedGames(userId, 51)).reverse();
    const cookie = await sessionCookie(userId);

    const pages = await Promise.all(
      [1, 2, 3].map(async (page) => await (await openList(cookie, page === 1 ? '' : `?page=${page}`)).text()),
    );
    for (const page of pages) {
      expect(page).not.toContain('新しい 50 件までを表示しています');
      expect(page).not.toContain('件までを表示しています');
    }
    // #152 の形では落ちていた、いちばん古い 1 件（51 件目）が、30 件ずつの 2 頁目に出る。
    expect(pages[Math.floor(50 / MY_WORKS_PER_PAGE)]).toContain(newestFirst[50]);
  });

  it('統計と残りの生成枠は、どの頁にも出る', async () => {
    const userId = await seedUser();
    await seedGames(userId, 75);
    await seedLedgerRow(userId);
    const cookie = await sessionCookie(userId);

    for (const search of ['', '?page=2', '?page=3']) {
      const page = await (await openList(cookie, search)).text();
      // 統計は頁ではなく作者の全作品で数える（2 頁目で「作品数 20」にならない）。
      expect(statCardsOf(page)['作品数'], search).toBe('75');
      expect(paragraphById(page, 'works-quota'), search).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER - 1));
    }
  });

  it('作品のある利用者が範囲の外の頁を開いても「まだ作品がありません」と言わない', async () => {
    const userId = await seedUser();
    await seedGames(userId, 3);
    const page = await (await openList(await sessionCookie(userId), '?page=5')).text();

    expect(page).toContain('<p class="gf-block">この頁に並ぶ作品がありません。</p>');
    expect(page).not.toContain('まだ作品がありません');
    // 戻る口は出す（前の頁）。次は出さない。
    expect(pagerOf(page)).toBe(`<nav class="gf-pager" aria-label="頁送り">${previousLink(4)}</nav>`);
  });

  it(`上限の ${MAX_MY_WORKS_PAGE} 頁目では、続きがあっても「次」を出さない`, async () => {
    // 51 頁目は 1 頁目に戻るので、「次」を出すと押しても先頭へ戻るだけの導線になる。
    const userId = await seedUser();
    const newestFirst = (await seedGames(userId, MY_WORKS_PER_PAGE * MAX_MY_WORKS_PAGE + 1)).reverse();
    const page = await (await openList(await sessionCookie(userId), `?page=${MAX_MY_WORKS_PAGE}`)).text();

    const last = (MAX_MY_WORKS_PAGE - 1) * MY_WORKS_PER_PAGE;
    expect(newestFirst.filter((id) => page.includes(id))).toEqual(newestFirst.slice(last, last + MY_WORKS_PER_PAGE));
    expect(pagerOf(page)).toBe(`<nav class="gf-pager" aria-label="頁送り">${previousLink(MAX_MY_WORKS_PAGE - 1)}</nav>`);
  }, 30_000);
});

describe('索引（migrations/0008）', () => {
  it('一覧の問い合わせが索引を使い、並べ替えのための一時 B-tree を作らない（頁を送っても同じ）', async () => {
    // **索引が「存在すること」を見ない。** 存在の検査は、索引を使えない形へ問い合わせを
    // 書き換えても通る。ここで見たいのは「この問い合わせが実際にそれを使うか」である
    // （shared-ai-rules 12 章）。
    //
    // **SQL を書き写さない**（#552）。`listAuthoredGames` が実際に `prepare` した文を拾って計画を見る。
    // 書き写すと、`offset` を足した・並びを変えたときに、検査だけが古い文を見続ける。
    const { env: recording, prepared } = recordingEnv();
    await listAuthoredGames(recording, 'someone', MY_WORKS_PER_PAGE + 1, MY_WORKS_PER_PAGE);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatch(/limit \? offset \?/u);

    for (const offset of [0, MY_WORKS_PER_PAGE * (MAX_MY_WORKS_PAGE - 1)]) {
      const plan = await env.DB.prepare(`explain query plan ${prepared[0]!}`)
        .bind('someone', MY_WORKS_PER_PAGE + 1, offset)
        .all<{ detail: string }>();
      const detail = plan.results.map((row) => row.detail).join(' | ');

      expect(detail).toContain('SEARCH');
      expect(detail).toContain('games_author_id_created_at_idx');
      // 一時 B-tree が出るなら、`limit` があっても**その作者の全行を読んでから並べている**。
      expect(detail).not.toContain('TEMP B-TREE');
    }
  });
});

describe('トップからの導線（#152 goal）', () => {
  it('公開トップから一覧へ辿れる', async () => {
    // 導線が無ければ「その URL を知っている人だけが使える一覧」になり、#152 が
    // 解こうとしている問題をそのまま繰り返す。
    //
    // **#471 でトップの本文の「参加している方へ」を外し、導線はアカウントのメニュー（「自分の作品」）だけになった**
    // （仕様 2.3.3 の #435 注記の表。メニューは #469 で全画面の外枠に入っている）。ログインの着地点は `/` なので、
    // **ログインした人がトップで辿れる**ことを見る。
    const userId = await seedUser();
    const body = await (
      await handleAppRequest(
        new Request(`${APP_ORIGIN}${HOME_PATH}`, { headers: { cookie: await sessionCookie(userId) } }),
        testEnv(),
      )
    ).text();
    expect(body).toContain(`href="${MY_WORKS_PATH}"`);
  });
});

describe('表示のための純関数', () => {
  it('知らない `generation_state` は「生成中」に落とさない', () => {
    expect(rowStateOf('pending', false)).toBe('working');
    expect(rowStateOf('running', false)).toBe('working');
    expect(rowStateOf('running', true)).toBe('stalled');
    expect(rowStateOf('ready', false)).toBe('ready');
    expect(rowStateOf('failed', false)).toBe('failed');
    expect(rowStateOf('generating', false)).toBe('unknown');
    // 完了した行は、閾値を超えていても「生成中」に見えてはいけない。
    expect(rowStateOf('ready', true)).toBe('ready');
    expect(rowStateOf('failed', true)).toBe('failed');
  });

  it('空のタイトルを無地の行にしない', () => {
    expect(displayTitleOf('   ')).toBe(UNTITLED_TITLE);
    expect(displayTitleOf('ゴリラソーダ')).toBe('ゴリラソーダ');
  });

  it('日本時間の表記が ICU に依存しない', () => {
    expect(formatJstMinutes(0)).toBe('1970-01-01 09:00');
    expect(formatJstMinutes(1_700_000_000)).toBe('2023-11-15 07:13');
    expect(formatJstMinutes(Number.NaN)).toBe('');
  });

  it('Date の範囲外でも投げずに空文字を返す', () => {
    // **`toISOString()` は範囲外の Date で `RangeError` を投げる。** 有限な数でも
    // ±8.64e15 ミリ秒の外に出れば Invalid Date になるため、`Number.isFinite` だけでは
    // 足りない。1 行の異常で一覧全体が 500 になる形を塞ぐ。
    for (const value of [1e15, -1e15, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatJstMinutes(value)).not.toThrow();
      expect(() => toIsoTimestamp(value)).not.toThrow();
      expect(formatJstMinutes(value), String(value)).toBe('');
      expect(toIsoTimestamp(value), String(value)).toBe('');
    }
  });

  it('読める日時では ISO と日本時間の両方を返す', () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('壊れた行が一覧全体を落とさない（#161 レビュー指摘 1）', () => {
  it('日時が読めない行があっても 200 で、他の作品は出る', async () => {
    // #152 が作ろうとしているのは「URL を控えていなくても戻れる道」である。**1 行の
    // 異常で道ごと消える形はその性質と噛み合わない。** 日時は行の付加情報であって、
    // 行を出す条件ではない。
    const userId = await seedUser();
    const broken = await seedGame(userId, { createdAt: 1e15, title: '壊れた日時の作品' });
    const normal = await seedGame(userId, { createdAt: 1_700_000_000, title: '普通の作品' });

    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(200);

    const body = await response.text();
    // 壊れた行も落とさない（作品へは辿れる）。落とすのは `<time>` だけである。
    expect(body).toContain(broken);
    expect(body).toContain('壊れた日時の作品');
    expect(body).toContain(normal);
    expect(body).toContain('普通の作品');
    expect(body).not.toContain('datetime=""');
  });
});

describe('「いいねした作品」への導線（2.3.7 / 5.8 / #340）', () => {
  it('「あなたの作品」から `/works/liked` へ行ける', async () => {
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain(`href="${LIKED_WORKS_PATH}"`);
    expect(body).toContain('いいねした作品');
  });

  it('本文の導線は、ヘッダのメニューへ移さずに残す（2.3.7 v1.57 / #372）', async () => {
    // **v1.57 はヘッダのアカウントのメニューにも「いいねした作品」を置いた**（ドロップダウンの
    // 中身はヘッダの項目ではない）。**本文の導線はそのまま残す**——メニューは閉じているので、
    // 「あなたの作品」を見ている人の目に入る導線が要る。外枠の側は `test/page-shell.test.ts`。
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(pageBodyOf(body)).toContain(`href="${LIKED_WORKS_PATH}"`);
  });

  it('未ログインの応答には出さない（ログインへ送るだけである）', async () => {
    const response = await openList();
    expect(response.status).toBe(303);
    expect(await response.text()).not.toContain(LIKED_WORKS_PATH);
  });
});

/**
 * 生成の台帳に 1 行置く（枠の判定が数える単位。確定25）。
 *
 * **`/api/generate` を呼ばない**（呼べば実際に課金される）。枠の判定が見るのは
 * `user_id` / `created_at` / `cost_jpy` だけなので、そこを直接置く
 * （`test/generate-page.test.ts` の `seedLedgerRow` と同じ方針）。**費用は 0 円にする**——
 * 月次上限はサービス全体の金額なので、ここで積むと同じ D1 を見る他の検査の状態を変える。
 *
 * @param userId 利用者の id
 * @returns なし
 */
async function seedLedgerRow(userId: string): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 0, 1, ?)`,
  )
    .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * 画面から、指定した `id` の `<p>` の中身を取り出す。
 *
 * @param page 画面の HTML
 * @param id 取り出す要素の id
 * @returns 中身（出ていなければ「(出ていない)」）
 */
function paragraphById(page: string, id: string): string {
  return page.match(new RegExp(`<p[^>]* id="${id}">([^<]*)</p>`, 'u'))?.[1] ?? '(出ていない)';
}

/**
 * 統計カードを「見出し: 数」の並びへ落とす。
 *
 * @param page 画面の HTML
 * @returns 見出しから数への対応
 */
function statCardsOf(page: string): Record<string, string> {
  const cards: Record<string, string> = {};
  for (const match of pageBodyOf(page).matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/gu)) {
    cards[match[1]!] = match[2]!;
  }
  return cards;
}

/**
 * `DB.prepare` に渡った SQL を記録する（あるいは、指定した SQL で失敗させる）env を作る。
 *
 * @param options `failOn` に一致した SQL の `prepare` で投げる
 * @returns 差し替えた env と、記録した SQL
 */
function recordingEnv(options: { readonly failOn?: string } = {}): {
  readonly env: Env;
  readonly prepared: string[];
} {
  const prepared: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          prepared.push(sql);
          if (sql === options.failOn) {
            throw new Error('D1 の不調を模した失敗');
          }
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...testEnv(), DB: db }, prepared };
}

describe('統計カード（2.3.13 / #382）', () => {
  it('作品が 0 本でも 200 で、全部のカードが 0 を出す', async () => {
    const userId = await seedUser();
    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(statCardsOf(body)).toEqual(
      Object.fromEntries(STAT_CARDS.map(({ label }) => [label, '0'])),
    );
    // 一覧の空の案内も残る（統計が一覧を押しのけていない）。
    expect(body).toContain('まだ作品がありません');
    // 枠はまだ 1 回も使っていない。
    expect(paragraphById(body, 'works-quota')).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });

  it('作品数・公開中・下書き・合計改造された数・合計いいね数・合計プレイ数を、自分の作品だけで数える', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await seedGame(userId, { status: DRAFT_STATUS, likeCount: 0 });
    // 生成中・生成に失敗した作品も下書きである（一覧にも出ている行）。
    await seedGame(userId, { status: DRAFT_STATUS, generationState: 'failed' });
    await seedGame(userId, { status: PUBLISHED_STATUS, forkCount: 2, likeCount: 5, playCount: 30 });
    await seedGame(userId, { status: PUBLISHED_STATUS, forkCount: 1, likeCount: 7, playCount: 12 });
    // **removed は数えない**（一覧に出ない作品を数に入れると、作品数と行数が合わない）。
    await seedGame(userId, { status: REMOVED_STATUS, forkCount: 100, likeCount: 100, playCount: 100 });
    // 他人の作品は数えない。
    await seedGame(other, { status: PUBLISHED_STATUS, forkCount: 50, likeCount: 50, playCount: 50 });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(statCardsOf(body)).toEqual({
      作品数: '4',
      公開中: '2',
      下書き: '2',
      合計フォークされた数: '3',
      合計いいね数: '12',
      合計プレイ数: '42',
    });
  });

  it('合計プレイ数のカードを出し、数え始めた時期を書き添える（#377。#382 の申し送り）', async () => {
    // **#382 は列が無いのでカードを出さなかった**（0 と出すと「遊ばれていない」と「数えていない」を
    // 区別できない）。列を持ったので出す。**数え始める前の起動は含まないので、時期を書き添える。**
    const userId = await seedUser();
    await seedGame(userId, { status: PUBLISHED_STATUS });
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(STAT_CARDS.map(({ label }) => label)).toContain('合計プレイ数');
    expect(statCardsOf(body)['合計プレイ数']).toBe('0');
    expect(pageBodyOf(body)).toContain(PLAYS_SINCE_NOTE);
    expect(PLAYS_SINCE_NOTE).toContain('から数えています');
  });

  it('いいね数が遅れて反映されることを書き添える（5.8）', async () => {
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(pageBodyOf(body)).toContain(LIKES_DELAY_NOTE);
  });

  it('統計を読めなくても画面ごと落とさず、「0 本」とも言わない', async () => {
    const userId = await seedUser();
    const gameId = await seedGame(userId, { title: '読めても出る作品' });
    const { env: failing } = recordingEnv({ failOn: myWorksStatsSql() });

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${MY_WORKS_PATH}`, {
        headers: { accept: 'text/html', cookie: await sessionCookie(userId) },
      }),
      failing,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(STATS_UNAVAILABLE_NOTICE);
    expect(statCardsOf(body)).toEqual({});
    // 作品へ戻る道は残る。
    expect(body).toContain(gameId);
  });

  it('描画は作品 0 本の統計でも、読めなかったときでも壊れない（純関数）', () => {
    const empty = renderMyWorksStats(EMPTY_MY_WORKS_STATS, remainingQuotaNotice(3));
    expect(statCardsOf(empty)).toEqual(
      Object.fromEntries(STAT_CARDS.map(({ label }) => [label, '0'])),
    );
    const unavailable = renderMyWorksStats(null, remainingQuotaNotice(3));
    expect(unavailable).toContain(STATS_UNAVAILABLE_NOTICE);
    expect(paragraphById(unavailable, 'works-quota')).toBe(remainingQuotaNotice(3));
  });
});

describe('今日の残り生成回数は、生成画面と同じ経路から引く（2.3.13 / 4.4 / #382）', () => {
  /**
   * 生成画面と「あなたの作品」を同じ利用者で開き、残枠の文言を並べる。
   *
   * @param userId 利用者の id
   * @returns 両画面の文言
   */
  async function quotaOnBothPages(
    userId: string,
  ): Promise<{ readonly generate: string; readonly mine: string }> {
    const cookie = await sessionCookie(userId);
    const generate = await (
      await handleAppRequest(
        new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, {
          headers: { accept: 'text/html', cookie },
        }),
        testEnv(),
      )
    ).text();
    const mine = await (await openList(cookie)).text();
    return {
      generate: paragraphById(generate, 'generate-quota'),
      mine: paragraphById(mine, 'works-quota'),
    };
  }

  it('枠が残っているとき、生成画面と同じ「本日の残り生成枠 N回」を出す', async () => {
    const userId = await seedUser();
    for (let index = 0; index < 3; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(shown.generate);
    expect(shown.mine).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER - 3));
  });

  it('日次の枠が尽きたとき、生成画面と同じ文言を出す（「残り 0 回」を別に作らない）', async () => {
    const userId = await seedUser();
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(shown.generate);
    // **同じ状態に 2 つの文言を作らない**（`src/generate-page.ts` の `availabilityNotice`）。
    expect(shown.mine).toBe(GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]);
  });

  it('他人の生成は自分の残り回数を減らさない', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await seedLedgerRow(other);
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });
});

describe('統計の読み取り（2.3.3 の条件 1 / #382 の訂正）', () => {
  it('統計は集計 1 回で引く（カードの数だけ問い合わせを出さない）', async () => {
    const userId = await seedUser();
    await seedGame(userId, { status: PUBLISHED_STATUS });
    await seedGame(userId, { status: DRAFT_STATUS });
    const { env: recording, prepared } = recordingEnv();

    await loadMyWorksStats(recording, userId);
    expect(prepared).toEqual([myWorksStatsSql()]);
  });

  it('作者で絞った SEARCH であり、games を全件 SCAN しない（公開作品の総数に比例しない）', async () => {
    // **索引が「存在すること」ではなく、この問い合わせが実際に使うことを見る。**
    // SEARCH（`author_id=?`）であれば、読む行はその作者の作品に限られる——自分の作品数には
    // 比例するが、母数（公開作品の総数）には比例しない（#382 の訂正で読み替えた基準）。
    const plan = await env.DB.prepare(`explain query plan ${myWorksStatsSql()}`)
      .bind(...myWorksStatsBinds('someone'))
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');

    expect(detail).toContain('SEARCH');
    expect(detail).toContain('games_author_id_created_at_idx');
    expect(detail).toContain('author_id=?');
    expect(detail).not.toMatch(/\bSCAN games\b/u);
  });
});

describe('見た目の規約の部品（#473 / 仕様 2.5.4 / 2.5.5）', () => {
  it('主のボタンは「新しく生成する」の 1 つだけで、「作品の一覧」の見出しの行の右にある', async () => {
    const userId = await seedUser();
    await seedGame(userId, { generationState: 'ready' });
    const body = await (await openList(await sessionCookie(userId))).text();
    // 外枠（ヘッダ）は主を持たないので、画面全体で数える。
    expect(body.match(/\bgf-button-primary\b/gu) ?? []).toHaveLength(1);
    expect(pageBodyOf(body)).toMatch(
      new RegExp(
        `<div class="gf-heading-row">\\s*<h2>作品の一覧</h2>\\s*<a class="gf-button gf-button-primary gf-button-sm" href="${GENERATE_PAGE_PATH}">新しく生成する</a>\\s*</div>`,
        'u',
      ),
    );
  });

  it('作品が 0 本でも主のボタンは 1 つで、知らせはブロックである', async () => {
    const body = await (await openList(await sessionCookie(await seedUser()))).text();
    expect(body.match(/\bgf-button-primary\b/gu) ?? []).toHaveLength(1);
    expect(pageBodyOf(body)).toContain('<div class="gf-block gf-my-works-empty">\n<p>まだ作品がありません。</p>');
    // 見出しの行の主と同じ行き先の導線は、小さい副のボタン（主と素のリンクを並べない。PR #505 の Copilot code review）。
    expect(pageBodyOf(body)).toContain(
      `<p class="gf-my-works-empty-action"><a class="gf-button gf-button-secondary gf-button-sm" href="${GENERATE_PAGE_PATH}">最初のゲームを生成する</a></p>`,
    );
    const generateLinks = pageBodyOf(body).match(new RegExp(`<a [^>]*href="${GENERATE_PAGE_PATH}"`, 'gu')) ?? [];
    expect(generateLinks.every((link) => link.includes('class="gf-button ')), generateLinks.join(' / ')).toBe(true);
  });

  it('「いいねした作品」「公開されている作品をさがす」は、一覧の後ろの小さい副のボタンである', async () => {
    const userId = await seedUser();
    const listed = await seedGame(userId);
    const main = pageBodyOf(await (await openList(await sessionCookie(userId))).text());
    const liked = main.indexOf(`<a class="gf-button gf-button-secondary gf-button-sm" href="${LIKED_WORKS_PATH}">いいねした作品</a>`);
    const browse = main.indexOf(
      `<a class="gf-button gf-button-secondary gf-button-sm" href="${PUBLIC_WORKS_PATH}">公開されている作品をさがす</a>`,
    );
    expect(liked).toBeGreaterThan(main.indexOf(workEditPath(listed)));
    expect(browse).toBeGreaterThan(liked);
  });

  it('一覧はブロックの面の表で、状態の札はチップ（生成中と時間がかかっているだけ地を塗る。#666）', async () => {
    const userId = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    const ready = await seedGame(userId, { generationState: 'ready', createdAt: now - 40 });
    const failed = await seedGame(userId, { generationState: 'failed', createdAt: now - 30 });
    const working = await seedGame(userId, { generationState: 'pending', createdAt: now - 20 });
    const stalled = await seedGame(userId, { generationState: 'running', createdAt: now - STALE_AFTER_SECONDS - 60 });

    const main = pageBodyOf(await (await openList(await sessionCookie(userId))).text());
    expect(main).toContain('<table class="gf-block gf-works-table">');
    const stateOf = (id: string): string =>
      new RegExp(`value="${id}"[\\s\\S]*?<td class="gf-works-state">(<span class="[^"]*">[^<]*</span>)</td>`, 'u').exec(main)?.[1] ?? '';
    expect(stateOf(ready)).toBe('<span class="gf-chip">下書き</span>');
    expect(stateOf(failed)).toBe('<span class="gf-chip">失敗</span>');
    expect(stateOf(working)).toBe('<span class="gf-chip gf-chip-emphasis">生成中</span>');
    expect(stateOf(stalled)).toMatch(/^<span class="gf-chip gf-chip-emphasis">[^<]*時間がかかっています[^<]*<\/span>$/u);
    // 題名は文章の外のリンク（`.gf-link-quiet`）で、行き先はエディットページ（#664 / #666 の scope.in）。
    expect(main).toContain(`<a class="gf-link-quiet gf-works-title" href="${workEditPath(ready)}">`);
    // #473 の前の札（`.gf-state`）と、#666 の前の行（`ul.gf-works`）は残さない。
    expect(main).not.toContain('gf-state');
    expect(main).not.toContain('gf-block-rows gf-works');
  });

  it('統計のカードはブロックで、残枠は「統計」の見出しの行の右にある', () => {
    const section = renderMyWorksStats(EMPTY_MY_WORKS_STATS, remainingQuotaNotice(4));
    expect(section).toMatch(
      /<div class="gf-heading-row">\s*<h2 id="works-stats-heading">統計<\/h2>\s*<p class="gf-stats-quota" id="works-quota">/u,
    );
    // #666 で 6 枚のカードを 1 つのブロックの帯に詰めた（項目の並びと見出しは変えていない）。
    expect(section.match(/<dl class="gf-block gf-stats-band">/gu) ?? []).toHaveLength(1);
    expect(section.match(/<div class="gf-stats-item"><dt>/gu) ?? []).toHaveLength(STAT_CARDS.length);
    // 注記は折りたたむ（開けば #377 / #382 の文がそのまま読める）。
    expect(section).toMatch(/<details class="gf-stats-notes">\s*<summary>数え方について<\/summary>/u);
    // 読めなかったときの知らせもブロックである。
    expect(renderMyWorksStats(null, remainingQuotaNotice(4))).toContain(`<p class="gf-block">${STATS_UNAVAILABLE_NOTICE}</p>`);
  });
});

/**
 * 表の検査用に、状態と数を指定して作品を入れる（#666）。
 *
 * @param authorId 作者
 * @param seed 列の指定
 * @returns 作品 id
 */
async function seedTableGame(
  authorId: string,
  seed: {
    readonly status?: string;
    readonly generationState?: string;
    readonly title?: string;
    readonly createdAt?: number;
    readonly publishedAt?: number | null;
    readonly playCount?: number;
    readonly likeCount?: number;
    readonly forkCount?: number;
    readonly tags?: readonly string[];
    readonly ogpState?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const [tag1, tag2, tag3] = [...(seed.tags ?? []), null, null, null];
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, published_at, generation_state,
        play_count, like_count, fork_count, tag1, tag2, tag3, ogp_state, ogp_key)
     values (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      seed.status ?? DRAFT_STATUS,
      seed.title ?? 'タイトル',
      seed.createdAt ?? Math.floor(Date.now() / 1000),
      seed.publishedAt ?? null,
      seed.generationState ?? 'ready',
      seed.playCount ?? 0,
      seed.likeCount ?? 0,
      seed.forkCount ?? 0,
      tag1 ?? null,
      tag2 ?? null,
      tag3 ?? null,
      seed.ogpState ?? null,
      seed.ogpState === 'ready' ? `ogp/${id}/x.png` : null,
    )
    .run();
  return id;
}

/**
 * 画面から、ある作品の `<tr>` を取り出す。
 *
 * @param page 画面の HTML
 * @param id 作品 id
 * @returns 行（無ければ空文字）
 */
function tableRowOf(page: string, id: string): string {
  return new RegExp(`<tr><td class="gf-works-select"><input [^>]*value="${id}"[\\s\\S]*?</tr>`, 'u').exec(page)?.[0] ?? '';
}

describe('Studio 型の表（#666）', () => {
  it('列は 選択・画像・作品名とタグ・状態・日付・プレイ・いいね・フォークされた数 で、数と日付を行ごとに出す', async () => {
    const userId = await seedUser();
    const published = await seedTableGame(userId, {
      status: PUBLISHED_STATUS,
      title: '公開中の作品',
      publishedAt: 1_700_000_000,
      playCount: 1234,
      likeCount: 56,
      forkCount: 7,
      tags: ['puzzle', 'idle'],
      ogpState: 'ready',
    });
    const draft = await seedTableGame(userId, { title: '下書きの作品', createdAt: 1_700_000_500 });
    const unpublished = await seedTableGame(userId, { title: '戻した作品', publishedAt: 1_700_000_100 });
    const page = await (await openList(await sessionCookie(userId))).text();

    expect(page).toContain(
      '<thead><tr><th scope="col" class="gf-works-select">選択</th><th scope="col" class="gf-works-thumb">画像</th><th scope="col">作品</th><th scope="col">状態</th><th scope="col">日付</th><th scope="col" class="gf-works-count">プレイ</th><th scope="col" class="gf-works-count">いいね</th><th scope="col" class="gf-works-count">フォークされた数</th></tr></thead>',
    );
    const row = tableRowOf(page, published);
    expect(row).toContain(`<input type="checkbox" name="${WORKS_BULK_GAME_ID_FIELD}" value="${published}" aria-label="公開中の作品 を選ぶ">`);
    // 紹介用の画像は、配信できるとき（公開中で撮影済み）だけ `<img>` にする。
    expect(row).toContain(`<img class="gf-works-shot" src="${ogpImagePath(published)}"`);
    expect(row).toContain('<span class="gf-works-tags"><span class="gf-chip">パズル</span> <span class="gf-chip">放置</span></span>');
    expect(row).toContain('<td class="gf-works-state"><span class="gf-chip">公開中</span></td>');
    expect(row).toContain('<span class="gf-works-date-label">公開</span> <time datetime="2023-11-14T22:13:20.000Z">');
    expect(row).toContain('<td class="gf-works-count" data-label="プレイ">1234</td><td class="gf-works-count" data-label="いいね">56</td><td class="gf-works-count" data-label="フォーク">7</td>');

    // 公開したことが無い作品は生成日、下書きへ戻した作品は「初公開」の日を出す。
    const draftRow = tableRowOf(page, draft);
    expect(draftRow).toContain('<span class="gf-works-date-label">生成</span>');
    expect(draftRow).toContain('<span class="gf-works-shot gf-works-shot-pending">公開前</span>');
    expect(draftRow).not.toContain('<img');
    expect(tableRowOf(page, unpublished)).toContain('<span class="gf-works-date-label">初公開</span>');
  });

  it('公開中でも撮影が済んでいなければ画像を指さない（配信の条件と同じ）', async () => {
    const userId = await seedUser();
    const capturing = await seedTableGame(userId, { status: PUBLISHED_STATUS, publishedAt: 1, ogpState: 'capturing' });
    const row = tableRowOf(await (await openList(await sessionCookie(userId))).text(), capturing);
    expect(row).toContain('<span class="gf-works-shot gf-works-shot-pending">撮影中</span>');
    expect(row).not.toContain(ogpImagePath(capturing));
  });

  it('表は素の GET のフォームで、押すと確認画面へ移る（一括操作のボタンは 3 つとも小さい副のボタン）', async () => {
    const userId = await seedUser();
    await seedTableGame(userId);
    const page = pageBodyOf(await (await openList(await sessionCookie(userId))).text());
    expect(page).toContain(`<form class="gf-works-bulk" method="get" action="${MY_WORKS_BULK_PATH}">`);
    for (const [action, label] of [['publish', '公開する'], ['unpublish', '下書きに戻す'], ['delete', '削除する']]) {
      expect(page).toContain(
        `<button type="submit" class="gf-button gf-button-secondary gf-button-sm" name="${WORKS_BULK_ACTION_FIELD}" value="${action}">${label}</button>`,
      );
    }
    // 主は「新しく生成する」の 1 つだけのまま。
    expect(page.match(/\bgf-button-primary\b/gu) ?? []).toHaveLength(1);
  });

  it('統計は表より前の帯で、注記は折りたたむ', async () => {
    const userId = await seedUser();
    await seedTableGame(userId);
    const page = pageBodyOf(await (await openList(await sessionCookie(userId))).text());
    expect(page.indexOf('<dl class="gf-block gf-stats-band">')).toBeGreaterThan(0);
    expect(page.indexOf('<dl class="gf-block gf-stats-band">')).toBeLessThan(page.indexOf('<table'));
    expect(page).toContain(`<details class="gf-stats-notes">\n<summary>数え方について</summary>\n<p class="gf-stats-note">${LIKES_DELAY_NOTE}</p>\n<p class="gf-stats-note">${PLAYS_SINCE_NOTE}</p>\n</details>`);
  });
});

describe('状態での絞り込み（#666）', () => {
  /**
   * 状態の混ざった作者を用意する（公開 3・下書き 35・生成中 2・失敗 4）。
   *
   * @returns 作者と、状態ごとの作品 id（新しい順）
   */
  async function seedMixed(): Promise<{ userId: string; ids: Record<Exclude<MyWorksFilter, 'all'>, string[]> }> {
    const userId = await seedUser();
    const ids: Record<Exclude<MyWorksFilter, 'all'>, string[]> = { published: [], draft: [], generating: [], failed: [] };
    const plan: [Exclude<MyWorksFilter, 'all'>, number][] = [['published', 3], ['draft', 35], ['generating', 2], ['failed', 4]];
    let at = 1_700_000_000;
    for (const [filter, count] of plan) {
      for (let i = 0; i < count; i += 1) {
        at += 1;
        const id = await seedTableGame(userId, {
          createdAt: at,
          status: filter === 'published' ? PUBLISHED_STATUS : DRAFT_STATUS,
          publishedAt: filter === 'published' ? at : null,
          generationState: filter === 'generating' ? 'running' : filter === 'failed' ? 'failed' : 'ready',
        });
        ids[filter].unshift(id);
      }
    }
    return { userId, ids };
  }

  it('絞り込むと、その状態の作品だけが出て、タブの件数が表の行数と合う', async () => {
    const { userId, ids } = await seedMixed();
    const cookie = await sessionCookie(userId);
    const all = Object.values(ids).flat();
    for (const filter of ['published', 'generating', 'failed'] as const) {
      const page = await (await openList(cookie, `?${MY_WORKS_FILTER_PARAM}=${filter}`)).text();
      const shown = all.filter((id) => page.includes(`value="${id}"`));
      expect(shown.sort(), filter).toEqual([...ids[filter]].sort());
      expect(page, filter).toContain(`<li><span aria-current="page">${{ published: '公開中', generating: '生成中', failed: '失敗' }[filter]}（${ids[filter].length}）</span></li>`);
      expect(page, filter).toContain(`<p class="gf-works-range">全 ${ids[filter].length} 件中 1〜${ids[filter].length} 件目</p>`);
    }
    // 「すべて」のタブは件数の合計（44）を持ち、ほかのタブはリンクである。
    const first = await (await openList(cookie)).text();
    expect(first).toContain('<li><span aria-current="page">すべて（44）</span></li>');
    expect(first).toContain(`<li><a href="${MY_WORKS_PATH}?${MY_WORKS_FILTER_PARAM}=draft">下書き（35）</a></li>`);
  });

  it('絞り込みとページ送りを組み合わせても件数が合う（下書き 35 件 = 30 件 + 5 件。31 件目は 2 頁目）', async () => {
    const { userId, ids } = await seedMixed();
    const cookie = await sessionCookie(userId);
    const drafts = ids.draft;
    const first = await (await openList(cookie, `?${MY_WORKS_FILTER_PARAM}=draft`)).text();
    const second = await (await openList(cookie, `?${MY_WORKS_FILTER_PARAM}=draft&${MY_WORKS_PAGE_PARAM}=2`)).text();
    expect(drafts.filter((id) => first.includes(`value="${id}"`))).toEqual(drafts.slice(0, 30));
    expect(drafts.filter((id) => second.includes(`value="${id}"`))).toEqual(drafts.slice(30));
    // ほかの状態の作品は、どちらの頁にも混ざらない。
    for (const id of [...ids.published, ...ids.generating, ...ids.failed]) {
      expect(first).not.toContain(id);
      expect(second).not.toContain(id);
    }
    expect(first).toContain('<p class="gf-works-range">全 35 件中 1〜30 件目</p>');
    expect(second).toContain('<p class="gf-works-range">全 35 件中 31〜35 件目</p>');
    // 頁送りは絞り込みを保つ。
    expect(pagerOf(first)).toContain(`href="${myWorksPath(2, 'draft')}"`);
    expect(myWorksPath(2, 'draft')).toBe(`${MY_WORKS_PATH}?${MY_WORKS_FILTER_PARAM}=draft&${MY_WORKS_PAGE_PARAM}=2`);
    expect(pagerOf(second)).toContain(`href="${myWorksPath(1, 'draft')}"`);
    expect(pagerOf(second)).not.toContain('gf-pager-next');
  });

  it('絞り込んで空なら「まだ作品がありません」と言わない', async () => {
    const userId = await seedUser();
    await seedTableGame(userId);
    const page = await (await openList(await sessionCookie(userId), `?${MY_WORKS_FILTER_PARAM}=failed`)).text();
    expect(page).toContain('<p class="gf-block">「失敗」の作品はありません。</p>');
    expect(page).not.toContain('まだ作品がありません');
  });

  it('`?state=` を読む（読めない値は「すべて」。純関数）', () => {
    for (const filter of MY_WORKS_FILTERS) {
      expect(toMyWorksFilter(filter)).toBe(filter);
    }
    for (const value of [null, '', 'removed', 'Published', ' draft']) {
      expect(toMyWorksFilter(value), JSON.stringify(value)).toBe('all');
    }
    expect(myWorksPath(1, 'all')).toBe(MY_WORKS_PATH);
    expect(myWorksPath(1, 'failed')).toBe(`${MY_WORKS_PATH}?${MY_WORKS_FILTER_PARAM}=failed`);
  });

  it('どの絞り込みも作者の索引で SEARCH し、一時 B-tree を作らない（頁を送っても同じ）', async () => {
    for (const filter of MY_WORKS_FILTERS) {
      for (const offset of [0, MY_WORKS_PER_PAGE * (MAX_MY_WORKS_PAGE - 1)]) {
        const plan = await env.DB.prepare(`explain query plan ${myWorksSql(filter)}`)
          .bind('someone', MY_WORKS_PER_PAGE + 1, offset)
          .all<{ detail: string }>();
        const detail = plan.results.map((row) => row.detail).join(' | ');
        expect(detail, filter).toContain('SEARCH');
        expect(detail, filter).toContain('games_author_id_created_at_idx');
        expect(detail, filter).not.toContain('TEMP B-TREE');
      }
    }
  });

  it('他人の作品はどの絞り込みにも出ない', async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const others = await seedTableGame(stranger, { status: PUBLISHED_STATUS, publishedAt: 1 });
    const cookie = await sessionCookie(userId);
    for (const filter of MY_WORKS_FILTERS) {
      expect(await (await openList(cookie, `?${MY_WORKS_FILTER_PARAM}=${filter}`)).text(), filter).not.toContain(others);
    }
  });
});
