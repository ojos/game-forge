/**
 * 運営からのお知らせ（2.3.1 / #375。M12-7）。一覧（`/news`）・記事（`/news/<id>`）・トップの節。
 *
 * ## D1 に触らない
 *
 * **記事は静的な定義である**（`src/news-articles.ts`。置き場の理由と代償はあちらの冒頭）。
 * このモジュールは `env.DB` を 1 度も読まないので、**トップへ節を足しても 2.3.3 の条件 1
 * （1 画面あたりの読み取り件数を固定する）の読み取りは 1 行も増えない**
 * ——増分は固定の 0 である。`test/news.test.ts` がトップの問い合わせの本数で確かめる。
 *
 * **D1 が落ちていてもお知らせは出る。** 障害の告知を載せる欄が、障害で一緒に消えない
 * （ただし更新には配備が要る。あちらの冒頭）。
 *
 * ## 空のときは節ごと出さない（2.3.1 v1.57 注記 / `src/home.ts` の規律）
 *
 * **見出しだけの欄は「出来ていないものを出来ているように書く」ことである。** 記事が
 * 0 本なら、トップの節も一覧の画面も記事の画面も作らない（経路ごと登録しない）。
 *
 * ## 最終更新日を出す
 *
 * **更新が止まったお知らせ欄は、無いより誤解を生む**（#375 の constraints）。いつの時点の
 * 情報かを、トップの節と一覧の両方で読めるようにする。
 *
 * ## このモジュールは Lambda の束に入らない
 *
 * 読むのは `src/html.ts` / `src/legal.ts` / `src/routes.ts` と、お知らせの葉 2 つだけで、
 * **オーケストレータが読むモジュールはここを import しない。**
 */
import type { NewsArticle } from './news-articles.js';
import { NEWS_ARTICLES, NEWS_CATEGORY_LABELS } from './news-articles.js';
import type { SiteViewer } from './html.js';
import { READING_CLASS, escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { NEWS_PATH, newsArticlePath } from './news-paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';

export { NEWS_PATH, newsArticlePath } from './news-paths.js';

/**
 * トップに並べる記事の本数。
 *
 * **固定する。** 記事が増えてもトップが長くならない（2.3.3 の条件 1 と同じ考え方で、
 * こちらは読み取りではなく画面の長さの上限である）。残りは一覧が持つ。
 */
export const HOME_NEWS_LIMIT = 3;

/** 一覧と節の見出し。**パンくずの親の名前も同じ綴りである**（`src/html.ts` の `BREADCRUMB_PARENTS`）。 */
export const NEWS_TITLE = 'お知らせ';

/**
 * 記事の最終更新日（直していなければ公開日）。
 *
 * @param article 記事
 * @returns `YYYY-MM-DD`
 */
function lastUpdatedOf(article: NewsArticle): string {
  return article.updatedOn ?? article.publishedOn;
}

/**
 * お知らせ全体の最終更新日。
 *
 * **`YYYY-MM-DD` は文字列のまま大小を比べられる**（桁が揃っているため）。形は
 * `test/news.test.ts` が全記事で見る。
 *
 * @param articles 記事
 * @returns いちばん新しい公開日か更新日。記事が無ければ null
 */
export function newsLastUpdatedOn(articles: readonly NewsArticle[]): string | null {
  let latest: string | null = null;
  for (const article of articles) {
    const date = lastUpdatedOf(article);
    if (latest === null || date > latest) {
      latest = date;
    }
  }
  return latest;
}

/**
 * 日付を `<time>` にする。
 *
 * @param date `YYYY-MM-DD`
 * @returns HTML
 */
function timeTag(date: string): string {
  const safe = escapeHtml(date);
  return `<time datetime="${safe}">${safe}</time>`;
}

/**
 * 最終更新日の 1 行。
 *
 * @param articles 記事（1 本以上）
 * @returns HTML（記事が無ければ空文字）
 */
function lastUpdatedLine(articles: readonly NewsArticle[]): string {
  const latest = newsLastUpdatedOn(articles);
  return latest === null ? '' : `<p class="gf-news-updated">最終更新日: ${timeTag(latest)}</p>`;
}

/**
 * お知らせの一覧（ブロックの中の行）。**トップの節と一覧の画面が同じ形を使う**（仕様 2.5.4 / #471）。
 *
 * **1 つのブロック（`.gf-block`）の中に記事を行（`.gf-block-rows`）で並べ、行の間に淡い罫線を引く。** 面は器の幅
 * いっぱいに置く（2.5.3。記事の抜粋は 1〜2 行で終わる短い文なので、行長を 42rem で止めない）。
 *
 * @param articles 並べる記事（新しい順。1 本以上）
 * @param headingLevel 見出しの階層（トップの節の中なら 3、一覧なら 2）
 * @returns HTML
 */
function renderList(articles: readonly NewsArticle[], headingLevel: 2 | 3): string {
  const items = articles.map((article) => renderListItem(article, headingLevel)).join('\n');
  return `<ul class="gf-news-list gf-block gf-block-rows">
${items}
</ul>`;
}

/**
 * 記事の日付と分類の 1 行。
 *
 * @param article 記事
 * @returns HTML
 */
function articleMeta(article: NewsArticle): string {
  const updated =
    article.updatedOn === undefined ? '' : `（更新: ${timeTag(article.updatedOn)}）`;
  // **分類はチップ（押せない札の `span.gf-chip`）である**（仕様 2.5.5 の表「お知らせの分類」。#471）。
  return `<p class="gf-news-meta">${timeTag(article.publishedOn)}${updated}` +
    ` <span class="gf-chip gf-news-category">${escapeHtml(NEWS_CATEGORY_LABELS[article.category])}</span></p>`;
}

/**
 * 一覧とトップに並べる 1 項目（日付・分類・見出し・本文の 1 段落目）。
 *
 * **見出しを記事へのリンクにする。** 2 段落目以降は記事の画面で読む。リンクは**文章の外のリンク**
 * （`.gf-link-quiet`。仕様 2.5.5 の表「一覧の行の題名」。下線はホバーと焦点だけ）。
 *
 * @param article 記事
 * @param headingLevel 見出しの階層（トップの節の中なら 3、一覧なら 2）
 * @returns HTML
 */
function renderListItem(article: NewsArticle, headingLevel: 2 | 3): string {
  const tag = `h${headingLevel}`;
  return `<li class="gf-news-item">
${articleMeta(article)}
<${tag} class="gf-news-title"><a class="gf-link-quiet" href="${newsArticlePath(article.id)}">${escapeHtml(article.title)}</a></${tag}>
<p>${escapeHtml(article.body[0])}</p>
</li>`;
}

/**
 * トップの「お知らせ」の節（2.3.1）。
 *
 * **記事が 0 本なら空文字を返す**（節ごと出さない）。新しい順に {@link HOME_NEWS_LIMIT} 本まで。
 *
 * **一覧へのリンクは、トップに出しきれない記事があるときだけではなく常に置く。**
 * 一覧には最終更新日と全記事があり、行き先は記事が 1 本でもあれば実在する。
 *
 * ## 見出しの行（仕様 2.5.3 / #471）
 *
 * **左に見出しと最終更新日、右に「お知らせをすべて見る」（小さい副のボタン）を同じ行に置く。** 作品の節の見出しの行
 * （`src/home.ts` の `.gf-home-head`）と同じ行の部品を使う。**HTML の順は 見出し → 最終更新日 → ボタン → 記事の行**で、
 * 見た目の順と Tab の順も同じである。
 *
 * **クラス名に `gf-home-section` を使わない。** そちらは作品の 4 節の目印で、
 * `test/home.test.ts` が節の数を数えている。
 *
 * @param articles 記事（新しい順）
 * @returns HTML
 */
export function renderHomeNewsSection(articles: readonly NewsArticle[]): string {
  if (articles.length === 0) {
    return '';
  }
  return `
<section class="gf-news-section" aria-labelledby="gf-news-heading">
<div class="gf-home-head">
<div class="gf-news-heading">
<h2 id="gf-news-heading">${NEWS_TITLE}</h2>
${lastUpdatedLine(articles)}
</div>
<a class="gf-button gf-button-secondary gf-button-sm" href="${NEWS_PATH}">お知らせをすべて見る</a>
</div>
${renderList(articles.slice(0, HOME_NEWS_LIMIT), 3)}
</section>`;
}

/**
 * お知らせの一覧の画面。
 *
 * @param articles 記事（1 本以上。新しい順）
 * @param viewer いま見ている人と画面
 * @returns HTML
 */
function newsListPage(articles: readonly NewsArticle[], viewer: SiteViewer): string {
  return `${siteHead({ title: `${NEWS_TITLE} - Game Forge`, viewer })}
<h1>${NEWS_TITLE}</h1>
<p>Game Forge の運営からのお知らせです。</p>
${lastUpdatedLine(articles)}
${renderList(articles, 2)}
${siteFooter()}
`;
}

/**
 * 記事 1 本の画面。
 *
 * **`<title>` は記事の見出しである**——パンくずの末尾の名前になる（2.3.10）。
 *
 * **本文は読み物の器いっぱいに組む**（長い文を読ませる画面。仕様 2.5.3 / #761）。**一覧へ戻る導線は小さい副のボタン**（2.5.5。移動なので `<a>`）。
 *
 * **記事と一覧へ戻る導線を、1 つの読み物の器（`READING_CLASS`）で包む**（仕様 2.5.3 / #564）。記事（`<article>`）の
 * 外にあるボタンも、パンくず・見出し・段落と同じ器の端に揃える。
 *
 * @param article 記事
 * @param viewer いま見ている人と画面
 * @returns HTML
 */
function newsArticlePage(article: NewsArticle, viewer: SiteViewer): string {
  const paragraphs = article.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n');
  return `${siteHead({ title: `${article.title} - Game Forge`, viewer, reading: true })}
<div class="${READING_CLASS}">
<article class="gf-news-article">
${articleMeta(article)}
<h1>${escapeHtml(article.title)}</h1>
${paragraphs}
</article>
<p class="gf-news-more"><a class="gf-button gf-button-secondary gf-button-sm" href="${NEWS_PATH}">お知らせの一覧へ</a></p>
</div>
${siteFooter()}
`;
}

/**
 * お知らせの経路を組み立てる。
 *
 * ## 記事ごとに完全一致で登録する（前方一致の `/news/` を使わない）
 *
 * **記事は配備の時点で決まっている**ので、実在する id だけを経路表へ載せられる。
 * 前方一致にすると、存在しない id を画面の側で 404 に倒す分岐が要るうえ、
 * 外枠の検査（`test/page-shell.test.ts`）と幅の検査（`scripts/lib/dev-fixture.sh`）へ
 * 「補う id」を足すことになる。**完全一致なら全記事の画面が経路表から自動で検査に乗る。**
 * 存在しない id は経路表の既定の 404 である。
 *
 * **記事が 0 本なら 1 本も登録しない**（空の一覧を置かない。冒頭）。
 *
 * @param articles 記事（新しい順）
 * @returns 経路
 */
export function createNewsRoutes(articles: readonly NewsArticle[]): readonly Route[] {
  if (articles.length === 0) {
    return [];
  }
  return [
    {
      method: 'GET',
      path: NEWS_PATH,
      handler: async (request, env) =>
        html(newsListPage(articles, await resolveSiteViewer(request, env))),
    },
    ...articles.map(
      (article): Route => ({
        method: 'GET',
        path: newsArticlePath(article.id),
        handler: async (request, env) =>
          html(newsArticlePage(article, await resolveSiteViewer(request, env))),
      }),
    ),
  ];
}

/** お知らせの経路（`src/app.ts` の経路表へ連結する）。 */
export const newsRoutes: readonly Route[] = createNewsRoutes(NEWS_ARTICLES);
