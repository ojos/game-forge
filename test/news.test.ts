import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { FAQ_ENTRIES } from '../src/faq.js';
import { OAUTH_SCOPE_LABELS } from '../src/oauth-paths.js';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { HOME_PATH } from '../src/home.js';
import { BREADCRUMB_PARENTS, newsBreadcrumbParents } from '../src/html.js';
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
import { DAILY_QUOTA_PER_USER, jstDayRange } from '../src/quota.js';
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

describe('AI からの接続の記事が、案内先と一致する（#696）', () => {
  /** @returns 記事の全段落をつないだ文字列 */
  function aiConnectArticleText(): string {
    const found = NEWS_ARTICLES.find((item) => item.id === 'ai-connect');
    expect(found, 'AI からの接続の記事').toBeDefined();
    return found!.body.join('\n');
  }

  it('引いている FAQ の見出しが、実在する項目の見出しと一字一句同じ', () => {
    const entry = FAQ_ENTRIES.find((item) => item.id === 'ai-connect');
    expect(entry, 'FAQ の ai-connect').toBeDefined();
    expect(aiConnectArticleText()).toContain(`「${entry!.question}」`);
  });

  it('許可の範囲の言い回しが、同意画面の表示名と一致する', () => {
    expect(aiConnectArticleText()).toContain(`「${OAUTH_SCOPE_LABELS['works:generate']!.name}」を外すと`);
  });

  it('できないこと（公開・削除・退会・他人の作品）を書いている', () => {
    const text = aiConnectArticleText();
    for (const phrase of ['公開・削除', '退会はできません', 'ほかの方の作品も読めません']) {
      expect(text, phrase).toContain(phrase);
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

  it('月次の上限については、いつ戻るかを書かない（仕様 1.2.37）', () => {
    // 4.4 が月次に求めているのは「プレイと共有は継続できる」ことで、復帰の時刻ではない。
    const text = quotaArticleText();
    expect(text).toContain('その月は全員の生成が止まります');
    expect(text).toContain('遊ぶことと共有することは引き続きご利用いただけます');
    expect(text).not.toContain('再開');
    expect(text).not.toContain('月が替わる');
  });

  it('1 作品あたりの直せる回数の上限を書かない（#515 で上限をなくした）', () => {
    const text = quotaArticleText();
    expect(text).not.toContain('1 作品につき');
    expect(text).not.toMatch(/[0-9]+ ?回までです。$/mu);
    // 自分の作品を直す操作が日次の枠を共有することは、引き続き書く。
    expect(text).toContain('自分の作品を直す操作も、同じ 1 日の枠から使います。');
  });

  it('直したので `updatedOn` を付け、公開日は変えない（#515）', () => {
    const found = NEWS_ARTICLES.find((item) => item.id === 'generation-quota');
    expect(found?.publishedOn).toBe('2026-09-12');
    expect(found?.updatedOn).toBe('2026-09-14');
  });
});

describe('トップの節（renderHomeNewsSection）', () => {
  it('記事が 0 本なら節ごと出さない', () => {
    expect(renderHomeNewsSection([])).toBe('');
  });

  it('記事が 0 本なら経路を 1 本も登録しない', () => {
    expect(createNewsRoutes([])).toEqual([]);
  });

  it('記事が 0 本ならパンくずの親にも一覧を入れない（経路と同じ条件）', () => {
    expect(newsBreadcrumbParents([])).toEqual([]);
    expect(newsBreadcrumbParents([article()])).toEqual([{ path: NEWS_PATH, label: NEWS_TITLE }]);
  });

  it('いまの記事で、パンくずの親の一覧と経路表の一覧が噛み合う', () => {
    // **片方だけが一覧を持つ状態を作らない。** 経路表に `/news` が無ければ親にも無く、
    // あれば親にもある（どちらも記事の本数で決まる）。
    const routed = createAppRoutes(env).some((route) => route.path === NEWS_PATH);
    const parent = BREADCRUMB_PARENTS.some((item) => item.path === NEWS_PATH);
    expect(parent).toBe(routed);
  });

  it('日付・分類・見出し（記事へのリンク）・本文の 1 段落目・最終更新日を出す', () => {
    const html = renderHomeNewsSection([
      article({ id: 'a', publishedOn: '2026-09-10', updatedOn: '2026-09-11', category: 'generation' }),
    ]);
    expect(html).toContain(`>${NEWS_TITLE}</h2>`);
    expect(html).toContain('<time datetime="2026-09-10">2026-09-10</time>');
    expect(html).toContain(NEWS_CATEGORY_LABELS.generation);
    expect(html).toContain(`<a class="gf-link-quiet" href="${newsArticlePath('a')}">見出し</a>`);
    expect(html).toContain('<p>1 段落目</p>');
    // **2 段落目以降は記事の画面で読む。**
    expect(html).not.toContain('2 段落目');
    expect(html).toContain('最終更新日: <time datetime="2026-09-11">');
    expect(html).toContain(`href="${NEWS_PATH}"`);
  });

  it('見出しの行は 見出し・最終更新日 → 「すべて見る」の副ボタン、記事はブロックの中の行、分類はチップ（#471）', () => {
    // **仕様 2.5.3 / 2.5.4 / 2.5.5。** HTML の順＝見た目の順＝Tab の順（見出し → 最終更新日 → ボタン → 記事の行）。
    const html = renderHomeNewsSection([
      article({ id: 'a', publishedOn: '2026-09-10', category: 'generation' }),
    ]);
    const heading = html.indexOf('<h2 id="gf-news-heading">');
    const updated = html.indexOf('class="gf-news-updated"');
    const more = html.indexOf(`<a class="gf-button gf-button-secondary gf-button-sm" href="${NEWS_PATH}">お知らせをすべて見る</a>`);
    const list = html.indexOf('<ul class="gf-news-list gf-block gf-block-rows">');
    expect(html).toContain('<div class="gf-home-head">');
    expect(heading).toBeGreaterThan(0);
    expect(updated).toBeGreaterThan(heading);
    expect(more).toBeGreaterThan(updated);
    expect(list).toBeGreaterThan(more);
    expect(html).toContain(
      `<span class="gf-chip gf-news-category">${NEWS_CATEGORY_LABELS.generation}</span>`,
    );
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
    // 記事はブロックの中の行（仕様 2.5.4。#471）。トップの節と同じ形である。
    expect(page.split('<ul class="gf-news-list gf-block gf-block-rows">').length - 1).toBe(1);
    expect(page.split('<li class="gf-news-item">').length - 1).toBe(NEWS_ARTICLES.length);
  });

  it('記事の画面に全段落が出て、パンくずの親が一覧である', async () => {
    for (const item of NEWS_ARTICLES) {
      const { status, body } = await open(newsArticlePath(item.id));
      expect(status, item.id).toBe(200);
      const page = pageBodyOf(body);
      for (const paragraph of item.body) {
        expect(page, item.id).toContain(`<p>${paragraph}</p>`);
      }
      // 一覧へ戻る導線は小さい副のボタン（仕様 2.5.5。#471）。
      expect(page, item.id).toContain(
        `<a class="gf-button gf-button-secondary gf-button-sm" href="${NEWS_PATH}">お知らせの一覧へ</a>`,
      );
      expect(body, item.id).toContain(`<li><a href="${NEWS_PATH}">${NEWS_TITLE}</a></li>`);
    }
  });

  it('直した記事は、一覧と記事の画面の日付の行に「（更新: …）」が出る（#509）', async () => {
    // **「招待制のクローズドβについて」は 2026-09-14 に画面名を直した**（#472 で /signup が「ログイン・登録」になった）。
    const closedBeta = NEWS_ARTICLES.find((item) => item.id === 'closed-beta');
    expect(closedBeta, 'クローズドβの記事').toBeDefined();
    expect(closedBeta!.updatedOn).toBe('2026-09-14');
    const text = closedBeta!.body.join('\n');
    const screenName = 'ログイン・登録の画面';
    expect(text).toContain(`${screenName}から待機リストに登録できます`);
    // 旧い呼び名（「ログイン・」の無い形）が残っていない。**旧い綴りを直に書かない**のは、#509 の acceptance の
    // grep（旧い呼び名が src と test に残っていないこと）にこの行が当たらないようにするため。
    expect(text.replaceAll(screenName, '')).not.toContain(screenName.slice('ログイン・'.length));

    const edited = NEWS_ARTICLES.filter((item) => item.updatedOn !== undefined);
    expect(edited.map((item) => item.id)).toContain('closed-beta');
    const list = pageBodyOf((await open(NEWS_PATH)).body);
    for (const item of edited) {
      const meta = `<p class="gf-news-meta"><time datetime="${item.publishedOn}">${item.publishedOn}</time>` +
        `（更新: <time datetime="${item.updatedOn!}">${item.updatedOn!}</time>）`;
      expect(list, item.id).toContain(meta);
      expect(pageBodyOf((await open(newsArticlePath(item.id))).body), item.id).toContain(meta);
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
  it('トップにお知らせの節が出る（作品の節の後ろ、フッタの前）', async () => {
    // **#471 で案内を告知 1 つに絞り、告知はヘッダの直下へ移った**（仕様 2.3.3 の #435 注記。並びは ヘッダ →
    // 告知 → 作品の 4 節 → お知らせの節 → フッタ）。
    await purgeListCache(HOME_CACHE_KEY);
    const { status, body } = await open(HOME_PATH);
    expect(status).toBe(200);
    expect(body).toContain('<section class="gf-news-section"');
    expect(body).toContain(`href="${newsArticlePath(NEWS_ARTICLES[0]!.id)}"`);
    const news = body.indexOf('gf-news-section');
    expect(news).toBeGreaterThan(body.indexOf('gf-home-notice'));
    expect(news).toBeGreaterThan(body.lastIndexOf('<section class="gf-home-section"'));
    expect(news).toBeLessThan(body.indexOf('<footer class="gf-footer">'));
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
