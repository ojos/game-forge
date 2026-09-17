/**
 * サイトマップ（`/sitemap.xml`。#595）。
 *
 * # 何を載せるか
 *
 * **索引に載せてよい URL だけを載せる。** `robots.txt`（`src/robots.ts`）が「近寄ってよいか」を、
 * `noindex`（`src/html.ts` の `siteHead`）が「索引に載せてよいか」を言うのに対し、ここは
 * **載せてよいものの在処を教える。**
 *
 * | 種類 | 出所 |
 * |---|---|
 * | 公開の静的画面 | {@link SITEMAP_STATIC_PATHS}（この表） |
 * | お知らせの記事 | `src/news-articles.ts` の `NEWS_ARTICLES`（配備の時点で決まっている） |
 * | 公開作品 | D1（`status = 'published'` かつ `reviewVisibleSql`） |
 * | ハンドル名を決めた作者 | D1（`handles` の `released_at is null`） |
 *
 * # `noindex` の画面を載せない
 *
 * **一覧を手書きすると必ず古くなる**（`.ai-playbook/shared-ai-rules.md` 12 章）。だからといって
 * **経路表から機械的に導くこともできない**——`noindex` は `siteHead` へ渡す実行時のフラグで、
 * **同じパスが状態によって変わる。** 実際に 2 か所ある。
 *
 * - 作品ページ: `noindex: !view.published`（公開済みなら索引に載る。`src/work-page.ts`）
 * - 公開一覧: `noindex: search.kind !== 'none'`（検索していなければ索引に載る。`src/works-list.ts`）
 *
 * **したがって照合で担保する。** `test/sitemap.test.ts` が経路表の全画面を実際に開き、
 * 次の両方向を見る。
 *
 * 1. **`noindex` でない画面が、この表に載っているか**（画面を足して載せ忘れると落ちる）
 * 2. **この表の画面が、本当に `noindex` でないか**（載せてはいけないものを載せると落ちる）
 *
 * **どちらの向きにも失敗が閉じる。** 一覧を持つこと自体は避けられないが、**古くなったまま
 * 緑にはならない。**
 *
 * # 作者ページの綴りは `/@handle` だけを載せる
 *
 * `/users/<user_id>` は生きているが、ハンドル名を決めた作者では `/@handle` へ 301 する
 * （仕様 2.3.1 の #381 実装注記）。**転送元を載せない**——正しい綴りが 1 つあるなら、
 * それだけを教える。ハンドル名を決めていない作者は、そもそも `/@handle` を持たない。
 *
 * # 上限に達したらどうなるか
 *
 * サイトマップ 1 本に書けるのは 50,000 URL・50MB までである。**いまは公開作品が 2 桁で、
 * 遠い。** 近づいたら索引ファイルへ分割する（#595 の scope.out）。**黙って切り捨てない**
 * ——{@link SITEMAP_URL_LIMIT} を超えたら記録を残す。
 */
import { NEWS_ARTICLES } from './news-articles.js';
import { NEWS_PATH, newsArticlePath } from './news-paths.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TAKEDOWN_THANKS_PATH, TERMS_PATH } from './legal-paths.js';
import { HANDLES_TABLE } from './handle.js';
import { handlePagePath } from './handle-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH, SIGNUP_PATH, WAITLIST_THANKS_PATH, workPagePath } from './paths.js';
import { PUBLISHED_STATUS } from './games.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { PUBLIC_WORKS_PATH } from './works-paths.js';

/** `sitemap.xml` の綴り。 */
export const SITEMAP_PATH = '/sitemap.xml';

/**
 * サイトマップに載せる静的画面。
 *
 * **ここに `noindex` の画面を足さないこと。** `test/sitemap.test.ts` が実際に開いて確かめる
 * （モジュール冒頭「`noindex` の画面を載せない」）。
 *
 * **綴りは定数から取る。** 書き写すと、パスを変えた日にサイトマップだけが 404 を指し続ける。
 *
 * `/signup`（ログイン・登録）と `/takedown`（削除依頼フォーム）も載せる。**どちらも
 * ログイン不要で、検索から直接来る意味がある**（利用者の決定。2026-09-17）——削除依頼の
 * 窓口は、権利者が本サービスの利用者でないまま辿り着く必要がある（仕様 8.4）。
 */
export const SITEMAP_STATIC_PATHS: readonly string[] = [
  HOME_PATH,
  PUBLIC_WORKS_PATH,
  NEWS_PATH,
  FAQ_PATH,
  TERMS_PATH,
  PRIVACY_PATH,
  TAKEDOWN_PATH,
  SIGNUP_PATH,
];

/**
 * **索引に載る（`noindex` でない）のに、サイトマップへ載せない画面。**
 *
 * `src/page-paths.ts` の `NON_PAGE_PATHS` と同じ向きの一覧である——**一覧を持つのは
 * 載せるものではなく例外の側**にして、足した画面が黙って漏れない形にする。
 * `test/sitemap.test.ts` が、ここに無い画面の漏れを捕まえる。
 *
 * **載せない理由は 2 通りしかない。**
 *
 * 1. `robots.txt` で `Disallow` している（クロールされないものを教える意味が無い。`src/robots.ts`）
 * 2. **操作の完了画面**である（単独で検索から来ても、その人には何も起きていない）
 *
 * **`noindex` を付けるべきかどうかとは別の判断である。** 完了画面に `noindex` を付けるかは
 * それぞれの画面の所有者が決めることで、#595 では変えていない。ここが決めるのは
 * 「サイトマップで在処を教えるか」だけである。
 */
export const SITEMAP_EXCLUDED_PATHS: readonly string[] = [
  GENERATE_PAGE_PATH, // 1. `robots.txt` で Disallow（ログインが要る）
  WAITLIST_THANKS_PATH, // 2. 待機リストに登録した人への完了画面
  TAKEDOWN_THANKS_PATH, // 2. 削除依頼を送った人への完了画面
];

/** サイトマップ 1 本に書ける URL の上限（サイトマップの仕様）。 */
export const SITEMAP_URL_LIMIT = 50000;

/** D1 から引く 1 件。 */
interface IdRow {
  id: string;
}

/** `handles` から引く 1 件。 */
interface HandleRow {
  handle: string;
}

/**
 * XML のテキストとして安全な形へ落とす。
 *
 * **`escapeHtml` を借りない。** あちらは HTML 用で、XML では `&apos;` の扱いが違う
 * （HTML の実体参照をそのまま XML へ持ち込まない）。**URL に現れうる 5 文字だけを見る。**
 *
 * @param value 生の文字列
 * @returns XML へ書ける文字列
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * サイトマップに載せるパスを、順序を決めて並べる。
 *
 * **静的画面 → お知らせの記事 → 公開作品 → 作者**の順にする。**新しい順ではない**
 * ——サイトマップの順序に意味は無く、**差分を読む人にとって安定していることのほうが役に立つ。**
 *
 * @param env バインディングと環境変数
 * @returns パスの配列（絶対 URL にする前の、サイトの中のパス）
 */
export async function sitemapPaths(env: Env): Promise<string[]> {
  const paths: string[] = [...SITEMAP_STATIC_PATHS, ...NEWS_ARTICLES.map((article) => newsArticlePath(article.id))];

  // **公開作品。** `status` と `reviewVisibleSql` の両方で絞る（8.4 で新規露出を止めた作品を
  // サイトマップから教えない）。**取り下げ・下書き・削除済み・退会で消えた作品は `status` で外れる。**
  const games = await env.DB.prepare(
    `select id from games where status = ? and ${reviewVisibleSql()} order by id`,
  )
    .bind(PUBLISHED_STATUS)
    .all<IdRow>();
  for (const row of games.results) {
    paths.push(workPagePath(row.id));
  }

  // **ハンドル名を決めた作者。** `released_at is null` がいま使っている行である
  // （`migrations/0039_user_handles.sql`）。**手放した名前は載せない**——90 日の転送は
  // 生きているが、正しい綴りではない。
  //
  // **退会の処理が進行中の作者を外す**（PR #602 の Copilot code review）。退会は
  // `withdrawal_started_at` を先に立て、`handles.released_at` の更新は後段の処理で行う
  // （`src/withdrawal.ts`）。**その間、作者ページは既に 404 を返す**
  // （`src/users-page.ts` の `withdrawal_started_at !== null`）ので、ここで外さないと
  // **サイトマップが 404 の URL を案内する。** しかも応答は 1 時間キャッシュされるので、
  // 食い違いはその間ずっと残る。
  //
  // **作品の側は同じ手当てが要らない。** あちらは退会の処理が `games.status` を変えることで
  // 取り下げ、作品ページは `withdrawal_started_at` を見ない——つまり `status = 'published'`
  // で絞っている限り、載っている URL は 404 にならない。
  const handles = await env.DB.prepare(
    `select h.handle from ${HANDLES_TABLE} h
       join users u on u.id = h.user_id
      where h.released_at is null and u.withdrawal_started_at is null
      order by h.handle`,
  ).all<HandleRow>();
  for (const row of handles.results) {
    paths.push(handlePagePath(row.handle));
  }

  return paths;
}

/**
 * サイトマップの XML を組み立てる。
 *
 * **`lastmod` を出さない**（#595 の scope.out）。作品の更新時刻は持っているが、**正しくない
 * `lastmod` は出さないほうがよい**——クローラは繰り返し裏切られると読まなくなる。必要になったら、
 * 何をもって「更新」とするかを決めてから足す。
 *
 * @param origin サイトのオリジン（`https://app.game-forge.ojos.jp`）
 * @param paths 載せるパス
 * @returns XML
 */
export function renderSitemap(origin: string, paths: readonly string[]): string {
  const urls = paths
    .map((path) => `  <url>\n    <loc>${escapeXml(new URL(path, origin).toString())}</loc>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * サイトマップの経路（**app ホストだけ**）。
 *
 * sandbox と admin は `robots.txt` で全面拒否しており、載せる URL が 1 つも無い
 * （`src/robots.ts`）。**あちらには登録しない**ので、それぞれのホストでは 404 になる。
 */
export const sitemapRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: SITEMAP_PATH,
    handler: async (request, env) => {
      const paths = await sitemapPaths(env);
      if (paths.length > SITEMAP_URL_LIMIT) {
        // **黙って切り捨てない。** 分割が要る合図である（モジュール冒頭「上限に達したら」）。
        console.error(`[sitemap] URL が上限を超えました: ${paths.length} 件（上限 ${SITEMAP_URL_LIMIT}）`);
      }
      return new Response(renderSitemap(new URL(request.url).origin, paths), {
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          // `robots.txt` と同じ扱い（`src/robots.ts` の `robotsResponse`）。**クローラは
          // 繰り返し取りに来る**ので、1 時間は聞き直させない。
          'cache-control': 'public, max-age=3600',
        },
      });
    },
  },
];
