import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { NEWS_ARTICLES } from '../src/news-articles.js';
import { newsArticlePath } from '../src/news-paths.js';
import { ssrPagePaths } from '../src/page-paths.js';
import { ROBOTS_PATH } from '../src/robots.js';
import { SITEMAP_EXCLUDED_PATHS, SITEMAP_PATH, SITEMAP_STATIC_PATHS, renderSitemap } from '../src/sitemap.js';
import { handlePagePath } from '../src/handle-paths.js';
import { workPagePath } from '../src/paths.js';
import { applySchema } from './helpers/schema.js';
import { isAllowed, parseRobotsTxt } from './helpers/robots-txt.js';

/**
 * サイトマップ（`/sitemap.xml`。#595）。
 *
 * **中心にあるのは「両方向の照合」である**（`src/sitemap.ts` の「`noindex` の画面を載せない」）。
 * `noindex` は実行時のフラグで経路表から読めないので、**実際に画面を開いて**、
 * 載せるべきものが載っているか・載せてはいけないものが載っていないかを、両方向から見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;

/** 公開した作品の id（サイトマップに載るべき）。 */
let publishedGameId = '';
/** 審査で落とした作品の id（載ってはいけない）。 */
let removedGameId = '';
/** 下書きの作品の id（載ってはいけない）。 */
let draftGameId = '';
/** 審査で新規露出を止めた作品の id（載ってはいけない）。 */
let hiddenGameId = '';
/** ハンドル名を決めた作者のハンドル（載るべき）。 */
const authorHandle = 'sitemap_author';

/**
 * 作品を 1 件仕込む。
 *
 * @param id 作品の id
 * @param status 状態
 * @param reviewState 審査の状態（null なら未審査）
 */
async function seedGame(id: string, status: string, reviewState: string | null): Promise<void> {
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state, published_at, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', 1, ?)`,
  )
    .bind(id, 'sitemap-author', status, `作品 ${id}`, reviewState)
    .run();
}

beforeAll(async () => {
  await applySchema();
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind('sitemap-author', 'sub-sitemap-author', 'sitemap@example.invalid', '作者')
    .run();
  await env.DB.prepare('insert into handles (handle, user_id, claimed_at) values (?, ?, 1)')
    .bind(authorHandle, 'sitemap-author')
    .run();
  // **手放したハンドルも 1 つ置く**（載ってはいけないことを確かめるため）。
  await env.DB.prepare('insert into handles (handle, user_id, claimed_at, released_at) values (?, ?, 1, 2)')
    .bind('sitemap_old', 'sitemap-author')
    .run();

  // **退会の処理が進行中の作者**（PR #602 の Copilot code review）。`withdrawal_started_at` は
  // 立っているが、`handles.released_at` はまだ NULL という**実際に起きる中間状態**を作る。
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at, withdrawal_started_at) values (?, ?, ?, ?, 1, 1)',
  )
    .bind('sitemap-leaving', 'sub-sitemap-leaving', 'leaving@example.invalid', '退会中')
    .run();
  await env.DB.prepare('insert into handles (handle, user_id, claimed_at) values (?, ?, 1)')
    .bind('sitemap_leaving', 'sitemap-leaving')
    .run();

  publishedGameId = '11111111-1111-4111-8111-111111111111';
  removedGameId = '22222222-2222-4222-8222-222222222222';
  draftGameId = '33333333-3333-4333-8333-333333333333';
  hiddenGameId = '44444444-4444-4444-8444-444444444444';
  await seedGame(publishedGameId, 'published', null);
  await seedGame(removedGameId, 'removed', null);
  await seedGame(draftGameId, 'draft', null);
  await seedGame(hiddenGameId, 'published', 'queued');
});

/**
 * サイトマップを取り、`<loc>` の一覧を返す。
 *
 * @returns 状態・`Content-Type`・本文・URL の一覧
 */
async function fetchSitemap(): Promise<{ status: number; type: string | null; body: string; locs: string[] }> {
  const res = await SELF.fetch(`${APP_ORIGIN}${SITEMAP_PATH}`);
  const body = await res.text();
  const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/gu)].map((matched) => matched[1]!);
  return { status: res.status, type: res.headers.get('content-type'), body, locs };
}

/**
 * 画面を開いて `noindex` かどうかを見る。
 *
 * @param path パス
 * @returns 状態と `noindex` の有無
 */
async function openPage(path: string): Promise<{ status: number; noindex: boolean }> {
  const res = await SELF.fetch(`${APP_ORIGIN}${path}`);
  const body = await res.text();
  return { status: res.status, noindex: body.includes('<meta name="robots" content="noindex">') };
}

describe('サイトマップの形', () => {
  it('application/xml の 200 を返し、妥当な XML である', async () => {
    const { status, type, body, locs } = await fetchSitemap();
    expect(status).toBe(200);
    expect(type).toBe('application/xml; charset=utf-8');
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body.trimEnd().endsWith('</urlset>')).toBe(true);
    // 開いた要素と閉じた要素の数が合う（壊れた XML を緑にしない）。
    expect((body.match(/<url>/gu) ?? []).length).toBe(locs.length);
    expect((body.match(/<\/url>/gu) ?? []).length).toBe(locs.length);
  });

  it('すべて絶対 URL で、app ホストを指す', async () => {
    const { locs } = await fetchSitemap();
    expect(locs.length).toBeGreaterThan(5);
    for (const loc of locs) {
      expect(loc.startsWith(`${APP_ORIGIN}/`), loc).toBe(true);
    }
  });

  it('同じ URL を 2 度載せない', async () => {
    const { locs } = await fetchSitemap();
    expect(new Set(locs).size).toBe(locs.length);
  });

  it('XML として危険な文字を書かない', () => {
    const xml = renderSitemap('https://example.invalid', ['/works?a=1&b=2']);
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('a=1&b=2');
  });
});

describe('載せる作品と、載せない作品', () => {
  it('公開作品は載る', async () => {
    const { locs } = await fetchSitemap();
    expect(locs).toContain(`${APP_ORIGIN}${workPagePath(publishedGameId)}`);
  });

  it('下書き・審査で落とした作品・審査で新規露出を止めた作品は載らない', async () => {
    // `games.status` は draft / published / removed の 3 つで、**公開の取り下げは draft へ戻る。**
    // 索引に載せてよいのは published だけで、そのうえで `reviewVisibleSql` が 8.4 の露出停止を外す。
    const { locs } = await fetchSitemap();
    for (const [label, id] of [
      ['下書き（取り下げを含む）', draftGameId],
      ['審査で落とした', removedGameId],
      ['審査で新規露出を止めた', hiddenGameId],
    ] as const) {
      expect(locs, `${label}の作品が載っている`).not.toContain(`${APP_ORIGIN}${workPagePath(id)}`);
    }
  });

  it('ハンドル名を決めた作者は載り、手放した名前は載らない', async () => {
    const { locs } = await fetchSitemap();
    expect(locs).toContain(`${APP_ORIGIN}${handlePagePath(authorHandle)}`);
    expect(locs).not.toContain(`${APP_ORIGIN}${handlePagePath('sitemap_old')}`);
  });

  it('退会の処理が進行中の作者は載らない（サイトマップが 404 を案内しない）', async () => {
    // **退会は `withdrawal_started_at` を先に立て、`handles.released_at` の更新は後段である。**
    // その間、作者ページは既に 404 を返す。**載せると、サイトマップが 404 の URL を案内する**
    // ——しかも応答は 1 時間キャッシュされるので、食い違いはその間ずっと残る。
    const { locs } = await fetchSitemap();
    expect(locs).not.toContain(`${APP_ORIGIN}${handlePagePath('sitemap_leaving')}`);
    // **本当に 404 であることまで確かめる**（前提が変わったらこの検査も落ちる）。
    expect((await SELF.fetch(`${APP_ORIGIN}${handlePagePath('sitemap_leaving')}`)).status).toBe(404);
  });

  it('お知らせの記事は、定義されているものがすべて載る', async () => {
    const { locs } = await fetchSitemap();
    expect(NEWS_ARTICLES.length).toBeGreaterThan(0);
    for (const article of NEWS_ARTICLES) {
      expect(locs, `記事 ${article.id} が載っていない`).toContain(`${APP_ORIGIN}${newsArticlePath(article.id)}`);
    }
  });
});

describe('noindex との照合（両方向。これがこのファイルの主題）', () => {
  it('載せると決めた画面は、本当に noindex でない', async () => {
    // 向き 1。**載せてはいけないものを載せると落ちる。**
    //
    // **静的な一覧だけでなく、実際に出力された URL をすべて開く**（PR #602 の Copilot code review）。
    // 公開作品と `/@handle` は実行時に載るので、静的な一覧だけを見ると
    // **どちらかに `noindex` が付いた日に、載せたまま緑になる。**
    const { locs } = await fetchSitemap();
    const paths = locs.map((loc) => new URL(loc).pathname);
    expect(paths).toContain(workPagePath(publishedGameId));
    expect(paths).toContain(handlePagePath(authorHandle));
    for (const path of paths) {
      const { status, noindex } = await openPage(path);
      expect(status, `${path} が開けない`).toBe(200);
      expect(noindex, `${path} は noindex なのにサイトマップに載せている`).toBe(false);
    }
  });

  it('noindex でない画面は、載っているか、理由つきで除外されているかのどちらかである', async () => {
    // 向き 2。**画面を 1 枚足して載せ忘れると落ちる。**
    //
    // **実際に載っている URL と突き合わせる**（静的な一覧とではない）。お知らせの記事のように
    // `SITEMAP_STATIC_PATHS` を通らずに載るものがあり、一覧とだけ比べると「載っているのに
    // 漏れている」と誤って落ちる（実際に落ちた）。
    //
    // 続きを補う経路（`/works/` `/@` など）はここでは見ない——補う id は画面ごとに違い、
    // それぞれ上の describe が実物で確かめている。ここが見るのは**完全一致の画面**である。
    const routes = createAppRoutes(env);
    const openEnded = new Set(
      routes.filter((route) => route.match === 'prefix' || route.match === 'segment').map((route) => route.path),
    );
    const exactPages = ssrPagePaths(routes).filter((path) => !openEnded.has(path));
    expect(exactPages.length).toBeGreaterThan(5);

    const listed = new Set((await fetchSitemap()).locs.map((loc) => new URL(loc).pathname));
    const missing: string[] = [];
    for (const path of exactPages) {
      const { status, noindex } = await openPage(path);
      // 開けない画面（ログインが要る 302 / 503 など）は、この向きでは見ない。**noindex かどうかを
      // 確かめられないものを、載っている・載っていないの判定に使わない。**
      if (status !== 200 || noindex) {
        continue;
      }
      if (!listed.has(path) && !SITEMAP_EXCLUDED_PATHS.includes(path)) {
        missing.push(path);
      }
    }
    expect(
      missing,
      `noindex でないのにサイトマップへ載せず、除外の理由も書いていない画面がある: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('除外すると書いた画面は、本当に載っていない（腐った例外を捕まえる）', async () => {
    // 逆向き。**除外の一覧だけが生き残った状態を緑にしない**（`src/admin/routes.ts` の
    // `ADMIN_OPEN_ROUTES` に対する検査と同じ考え方）。
    const listed = new Set((await fetchSitemap()).locs.map((loc) => new URL(loc).pathname));
    expect(SITEMAP_EXCLUDED_PATHS.length).toBeGreaterThan(0);
    for (const path of SITEMAP_EXCLUDED_PATHS) {
      expect(listed.has(path), `${path} は除外すると書いてあるのに載っている`).toBe(false);
    }
  });

  it('載せた URL は、すべて robots.txt が許可している', async () => {
    // **`Disallow` した先を「ここにあります」と教えない。** 2 つの宣言が食い違うと、
    // クローラから見て何を言いたいのか決まらない。
    const robots = parseRobotsTxt(await (await SELF.fetch(`${APP_ORIGIN}${ROBOTS_PATH}`)).text());
    const { locs } = await fetchSitemap();
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      expect(isAllowed(robots, 'Googlebot', path), `${path} は robots.txt で Disallow されている`).toBe(true);
    }
  });
});

describe('robots.txt との結線', () => {
  it('app の robots.txt が Sitemap 行を持ち、その URL が 200 を返す', async () => {
    const body = await (await SELF.fetch(`${APP_ORIGIN}${ROBOTS_PATH}`)).text();
    const sitemapUrl = /^Sitemap:\s*(\S+)$/mu.exec(body)?.[1];
    expect(sitemapUrl, 'Sitemap 行が無い').toBeDefined();
    expect(sitemapUrl).toBe(`${APP_ORIGIN}${SITEMAP_PATH}`);
    expect((await SELF.fetch(sitemapUrl!)).status).toBe(200);
  });

  it('Sitemap 行はグループに属さないので、拒否したクローラの判定を変えない', async () => {
    // `Sitemap` を `User-agent` グループの内側に置くと、読む側によっては解釈が揺れる。
    // **拒否の判定が変わっていないこと**を、読む側で確かめる。
    const robots = parseRobotsTxt(await (await SELF.fetch(`${APP_ORIGIN}${ROBOTS_PATH}`)).text());
    expect(isAllowed(robots, 'GPTBot', '/')).toBe(false);
    expect(isAllowed(robots, 'Googlebot', '/')).toBe(true);
  });
});

describe('app ホストにだけ置く', () => {
  it('sandbox と admin の /sitemap.xml は 404', async () => {
    for (const origin of [SANDBOX_ORIGIN, ADMIN_ORIGIN]) {
      expect((await SELF.fetch(`${origin}${SITEMAP_PATH}`)).status, origin).toBe(404);
    }
  });
});
