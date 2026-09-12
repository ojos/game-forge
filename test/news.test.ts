import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import { MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { HOME_PATH } from '../src/home.js';
import { HOME_CACHE_KEY, loadHomeFeed } from '../src/home-feed.js';
import { purgeListCache } from '../src/list-cache.js';
import type { NewsArticle, NewsCategory } from '../src/news-articles.js';
import { NEWS_ARTICLES, NEWS_CATEGORY_LABELS } from '../src/news-articles.js';
import {
  HOME_NEWS_LIMIT,
  NEWS_PATH,
  NEWS_TITLE,
  createNewsRoutes,
  newsArticlePath,
  newsLastUpdatedOn,
  renderHomeNewsSection,
} from '../src/news.js';
import { DAILY_QUOTA_PER_USER, REVISIONS_PER_GAME, jstDayRange } from '../src/quota.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 運営からのお知らせ（#375 / M12-7。仕様 2.3.1）。
 *
 * **ここが持つのは 4 つである。**
 *
 * 1. **記事の定義が壊れていない**（id の綴り・日付の形・新しい順）——静的な定義は
 *    端末から直接書かれるので、画面を開く前にここで落とす
 * 2. **0 本のときは節ごと出ない**（#375 の acceptance）
 * 3. **トップの D1 の読み取りが増えていない**（2.3.3 の条件 1。#375 の acceptance）
 * 4. **記事に書いた数字が、その正本と一致している**（`.ai-playbook/shared-ai-rules.md` 12 章）
 *
 * 外枠（ヘッダ・パンくず・フッタ）は `test/page-shell.test.ts` が経路表から導いて見る。
 * **記事の画面は完全一致の経路なので、あちらに自動で乗る。**
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

beforeAll(async () => {
  await applySchema();
});

/**
 * テスト用の記事を作る。
 *
 * @param overrides 差し替える項目
 * @returns 記事
 */
function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'test-article',
    publishedOn: '2026-09-01',
    category: 'service',
    title: '見出し',
    body: ['1 段落目', '2 段落目'],
    ...overrides,
  };
}

/**
 * `env.DB` の `prepare` の呼び出し回数を数える env を作る。
 *
 * @returns 数える env と、数を読む関数
 */
function watchedEnv(): { readonly target: Env; readonly count: () => number } {
  let prepared = 0;
  const target = {
    ...env,
    DB: new Proxy(env.DB, {
      get(db, property, receiver) {
        const value = Reflect.get(db, property, receiver) as unknown;
        if (property === 'prepare') {
          prepared += 1;
        }
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(db)
          : value;
      },
    }),
  } as unknown as Env;
  return { target, count: () => prepared };
}

/** 触った瞬間に投げる D1。 */
const BROKEN_ENV = {
  ...env,
  DB: new Proxy(
    {},
    {
      get() {
        throw new Error('D1 が使えません');
      },
    },
  ),
} as unknown as Env;

/**
 * 画面を開く。
 *
 * @param path パス
 * @param target 使う env
 * @returns ステータスと本文
 */
async function open(path: string, target: Env = env): Promise<{ status: number; body: string }> {
  const response = await handleAppRequest(new Request(`${APP_ORIGIN}${path}`), target);
  return { status: response.status, body: await response.text() };
}

describe('記事の定義（src/news-articles.ts）', () => {
  it('初期記事が入っている（空の一覧で始めない）', () => {
    expect(NEWS_ARTICLES.length).toBeGreaterThan(0);
  });

  it('id が URL に使える綴りで、重複しない', () => {
    const ids = NEWS_ARTICLES.map((item) => item.id);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('日付が実在する `YYYY-MM-DD` で、更新日は公開日より前にならない', () => {
    for (const item of NEWS_ARTICLES) {
      for (const date of [item.publishedOn, item.updatedOn].filter(
        (value): value is string => value !== undefined,
      )) {
        expect(date, item.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        // 2026-02-30 のような綴りは `Date` が繰り上げるので、往復で一致しない。
        expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), item.id).toBe(date);
      }
      if (item.updatedOn !== undefined) {
        expect(item.updatedOn >= item.publishedOn, item.id).toBe(true);
      }
    }
  });

  it('新しい順に並んでいる（画面の側で並べ直さない）', () => {
    const dates = NEWS_ARTICLES.map((item) => item.publishedOn);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('見出しと段落が空でない', () => {
    for (const item of NEWS_ARTICLES) {
      expect(item.title.trim(), item.id).not.toBe('');
      for (const paragraph of item.body) {
        expect(paragraph.trim(), item.id).not.toBe('');
      }
    }
  });

  it('分類にはすべて見出しがある', () => {
    for (const item of NEWS_ARTICLES) {
      expect(NEWS_CATEGORY_LABELS[item.category as NewsCategory], item.id).toBeTruthy();
    }
  });
});

describe('記事に書いた数字が正本と一致する（shared-ai-rules 12 章）', () => {
  /**
   * 生成枠の記事の本文。
   *
   * @returns 全段落をつないだ文字列
   */
  function quotaArticleText(): string {
    const found = NEWS_ARTICLES.find((item) => item.id === 'generation-quota');
    expect(found, '生成枠の記事').toBeDefined();
    return found!.body.join('\n');
  }

  it('1 人 1 日の回数が `DAILY_QUOTA_PER_USER` と一致する', () => {
    expect(quotaArticleText()).toContain(`1 人 1 日 ${DAILY_QUOTA_PER_USER} 回まで`);
  });

  it('枠が戻る時刻が `jstDayRange` の境界（日本時間の 0 時）と一致する', () => {
    expect(quotaArticleText()).toContain('毎日 0 時（日本時間）に戻ります');
    // 日本時間の 0 時は UTC の 15 時である。
    const { toSeconds } = jstDayRange(Math.floor(Date.UTC(2026, 8, 12, 3, 0, 0) / 1000));
    expect(toSeconds % (24 * 60 * 60)).toBe(15 * 60 * 60);
  });

  it('やり直しの回数と、1 回の操作で使う最大の枠が `MAX_GENERATION_ATTEMPTS` と一致する', () => {
    const text = quotaArticleText();
    expect(MAX_GENERATION_ATTEMPTS - 1).toBe(1);
    expect(text).toContain('自動で 1 回だけやり直す');
    expect(text).toContain(`枠を最大 ${MAX_GENERATION_ATTEMPTS} 回分使う`);
  });

  it('1 作品あたりの直せる回数が `REVISIONS_PER_GAME` と一致する', () => {
    expect(quotaArticleText()).toContain(`1 作品につき ${REVISIONS_PER_GAME} 回まで`);
  });
});

describe('トップの節（renderHomeNewsSection）', () => {
  it('記事が 0 本なら節ごと出さない', () => {
    expect(renderHomeNewsSection([])).toBe('');
  });

  it('記事が 0 本なら経路を 1 本も登録しない', () => {
    expect(createNewsRoutes([])).toEqual([]);
  });

  it('日付・分類・見出し（記事へのリンク）・本文の 1 段落目・最終更新日を出す', () => {
    const html = renderHomeNewsSection([
      article({ id: 'a', publishedOn: '2026-09-10', updatedOn: '2026-09-11', category: 'generation' }),
    ]);
    expect(html).toContain(`>${NEWS_TITLE}</h2>`);
    expect(html).toContain('<time datetime="2026-09-10">2026-09-10</time>');
    expect(html).toContain(NEWS_CATEGORY_LABELS.generation);
    expect(html).toContain(`<a href="${newsArticlePath('a')}">見出し</a>`);
    expect(html).toContain('<p>1 段落目</p>');
    // **2 段落目以降は記事の画面で読む。**
    expect(html).not.toContain('2 段落目');
    expect(html).toContain('最終更新日: <time datetime="2026-09-11">');
    expect(html).toContain(`href="${NEWS_PATH}"`);
  });

  it(`並べるのは ${HOME_NEWS_LIMIT} 本までである`, () => {
    const many = Array.from({ length: HOME_NEWS_LIMIT + 2 }, (_, index) =>
      article({ id: `a${index}`, title: `見出し${index}` }),
    );
    const html = renderHomeNewsSection(many);
    expect(html.split('<li class="gf-news-item">').length - 1).toBe(HOME_NEWS_LIMIT);
  });

  it('見出しと本文をエスケープする', () => {
    const html = renderHomeNewsSection([
      article({ title: '<script>alert(1)</script>', body: ['<img src=x onerror=alert(1)>'] }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('最終更新日（newsLastUpdatedOn）', () => {
  it('記事が無ければ null', () => {
    expect(newsLastUpdatedOn([])).toBeNull();
  });

  it('公開日と更新日のうち、いちばん新しい日を返す', () => {
    expect(
      newsLastUpdatedOn([
        article({ id: 'a', publishedOn: '2026-09-10' }),
        article({ id: 'b', publishedOn: '2026-09-01', updatedOn: '2026-09-12' }),
      ]),
    ).toBe('2026-09-12');
  });
});

describe('一覧と記事の画面（/news・/news/<id>）', () => {
  it('一覧に全記事と最終更新日が出る', async () => {
    const { status, body } = await open(NEWS_PATH);
    expect(status).toBe(200);
    const page = pageBodyOf(body);
    expect(page).toContain(`<h1>${NEWS_TITLE}</h1>`);
    for (const item of NEWS_ARTICLES) {
      expect(page, item.id).toContain(`href="${newsArticlePath(item.id)}"`);
    }
    expect(page).toContain(`最終更新日: <time datetime="${newsLastUpdatedOn(NEWS_ARTICLES)}">`);
  });

  it('記事の画面に全段落が出て、パンくずの親が一覧である', async () => {
    for (const item of NEWS_ARTICLES) {
      const { status, body } = await open(newsArticlePath(item.id));
      expect(status, item.id).toBe(200);
      const page = pageBodyOf(body);
      for (const paragraph of item.body) {
        expect(page, item.id).toContain(`<p>${paragraph}</p>`);
      }
      expect(body, item.id).toContain(`<li><a href="${NEWS_PATH}">${NEWS_TITLE}</a></li>`);
    }
  });

  it('存在しない id は 404 である', async () => {
    const { status } = await open(newsArticlePath('no-such-article'));
    expect(status).toBe(404);
  });

  it('D1 が落ちていても一覧と記事は出る（D1 を読まない）', async () => {
    expect((await open(NEWS_PATH, BROKEN_ENV)).status).toBe(200);
    expect((await open(newsArticlePath(NEWS_ARTICLES[0]!.id), BROKEN_ENV)).status).toBe(200);
  });
});

describe('トップへの表示（#375。仕様 2.3.3 の条件 1）', () => {
  it('トップにお知らせの節が出る（作品の節の後ろ、案内の前）', async () => {
    await purgeListCache(HOME_CACHE_KEY);
    const { status, body } = await open(HOME_PATH);
    expect(status).toBe(200);
    expect(body).toContain('<section class="gf-news-section"');
    expect(body).toContain(`href="${newsArticlePath(NEWS_ARTICLES[0]!.id)}"`);
    expect(body.indexOf('gf-news-section')).toBeLessThan(body.indexOf('<h2>いまの状態</h2>'));
  });

  it('トップの D1 の問い合わせは、作品の節を引く本数から 1 本も増えていない', async () => {
    // **増分は固定の 0 である。** お知らせは静的な定義で、D1 を読まない（`src/news.ts`）。
    // 作品の節だけを引いたときの本数と、トップ全体を開いたときの本数を突き合わせる。
    // **両方ともキャッシュを捨ててから数える**（捨てないと片方が 0 本になり、比べる意味が無い）。
    await purgeListCache(HOME_CACHE_KEY);
    const feedOnly = watchedEnv();
    await loadHomeFeed(feedOnly.target);
    expect(feedOnly.count()).toBeGreaterThan(0);

    await purgeListCache(HOME_CACHE_KEY);
    const wholeHome = watchedEnv();
    const { status } = await open(HOME_PATH, wholeHome.target);
    expect(status).toBe(200);
    expect(wholeHome.count()).toBe(feedOnly.count());
    await purgeListCache(HOME_CACHE_KEY);
  });

  it('D1 が落ちていてもトップのお知らせの節は出る', async () => {
    await purgeListCache(HOME_CACHE_KEY);
    const { status, body } = await open(HOME_PATH, BROKEN_ENV);
    expect(status).toBe(200);
    expect(body).toContain('<section class="gf-news-section"');
  });
});
