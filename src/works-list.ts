/**
 * 公開作品の一覧（`/works`）。**発見（discovery）の面の中心である**（仕様 2.3 / #328）。
 *
 * ## なぜ `/works` なのか
 *
 * **`/games` を新設しない。** そうすると `作品 = /works/<id>` と `作品の一覧 = /games` で
 * **同じものに綴りが 2 つ**できる。`/works` の意味を変えるほうを採った（仕様 2.3.2）。
 *
 * **#152 の「末尾を削れば一覧に着く」は、むしろ強まる。** 削って着く先が「その人だけの
 * 一覧」から「公開作品の一覧」になり、**共有 URL を踏んだ未ログインの閲覧者にとって
 * 意味のある行き先**になる。いま `/works` が返している「自分の作品」は `/works/mine` へ
 * 移した（`src/my-works.ts`）。
 *
 * **代償は払っている。** 既存の参加者が `/works` を控えていれば行き先が変わる。だから
 * 一覧の先頭に移設先を出す（{@link MOVED_NOTICE}）。数十人規模のクローズドβ（2.1）の
 * 間にしか払えない代償であり、先送りするほど高くなる。
 *
 * ## 読み取りは 3 つの条件で押さえる（仕様 2.3.3）
 *
 * 1. **件数を固定する。** 1 頁 {@link WORKS_PER_PAGE} 件、頁数の上限は {@link MAX_PAGE}。
 *    母数が増えても 1 回の読み取りが増えない
 * 2. **索引を張る。** `migrations/0019_games_public_list_idx.sql`（2 軸ぶん）
 * 3. **Cache API を前段に置く。** 載せるのは HTML ではなく引いた行だけ（`src/list-cache.ts`）
 *
 * ## 出さないもの
 *
 * いいね・プレイ数・タグ・キーワード検索は**持たない**（仕様 2.3.5）。並べ替えは
 * 新着と「改造された数」の 2 軸だけである（2.3.4）。無限スクロールも置かない——
 * **18 本しか無いところに置くものではない**（2.3.3）。
 */
import type { PublicWork, PublicWorkSort } from './games.js';
import { listPublishedGames, toPublicWorkSort } from './games.js';
import { siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { cachedRows, listCacheKey } from './list-cache.js';
import { GENERATE_PAGE_PATH, WORK_PAGE_PREFIX } from './paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { renderWorkCards } from './work-card.js';

/**
 * 公開一覧のパス（`/works`）。
 *
 * **`WORK_PAGE_PREFIX` から導く**（`src/my-works.ts` が同じ理由でそうしていた）。
 * `/works` と書き写すと、作品ページの綴りを変えた日に一覧だけが古い場所に残る。
 * 末尾の `/` を落とすので経路表には**完全一致**で載り、前方一致の `/works/` とは
 * 別の鍵になる（`src/routes.ts` の `dispatch` は完全一致を先に見る）。
 */
export const PUBLIC_WORKS_PATH = WORK_PAGE_PREFIX.slice(0, -1);

/**
 * 1 頁に並べる件数。
 *
 * **20 件。** 仕様 2.3.3 の条件 1（件数を固定する）の実体である。カード 1 枚に画像が
 * 1 枚付くので、`src/my-works.ts` の 50 件（文字だけの行）より少なくする。
 */
export const WORKS_PER_PAGE = 20;

/**
 * 頁数の上限。
 *
 * **`OFFSET` は読み飛ばした行を数える。** 上限が無いと `?page=999999` の 1 本で、
 * 索引の上を大量に走らせられる。条件 1 の「母数が増えても読み取りが増えない」は、
 * **利用者が URL を書き換えた場合にも成り立たなければならない。**
 *
 * **50 頁（＝1,000 件）。** 公開作品が 100 本を超えたら情報設計を見直すと決めてある
 * （仕様 2.3.8）ので、その 10 倍を天井に置く。**ここに当たるより先に 2.3.8 の契機が
 * 来る**——来ないまま当たるようなら、頁送りではなく続きの鍵で辿る形（keyset）へ
 * 変える時期である。
 */
export const MAX_PAGE = 50;

/** 移設の案内。**綴りを 1 か所に置く**（画面とテストが同じ文字列を見る）。 */
export const MOVED_NOTICE = '自分の作品は /works/mine へ移りました。';

/** 並べ替えの札。**綴りの正本は `src/games.ts` の `PUBLIC_WORK_SORTS` である。** */
const SORT_LABELS: Record<PublicWorkSort, string> = {
  recent: '新着',
  forked: '改造された数',
};

/**
 * `?page=` を頁番号へ落とす。
 *
 * **落とすのであって、失敗させない**（`toPublicWorkSort` と同じ扱い）。手で書き換えた
 * URL が 400 を返すより、1 頁目が出るほうがよい。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 1 以上 {@link MAX_PAGE} 以下の整数
 */
export function toPageNumber(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, MAX_PAGE);
}

/**
 * 一覧の URL を組み立てる。
 *
 * @param sort 並べ替え軸
 * @param page 頁番号
 * @returns アプリ用ホスト上の絶対パス
 */
export function worksListPath(sort: PublicWorkSort, page: number): string {
  return `${PUBLIC_WORKS_PATH}?sort=${sort}&page=${page}`;
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface WorksListView {
  /** 並べる作品（既に {@link WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly PublicWork[];
  /** 並べ替え軸。 */
  readonly sort: PublicWorkSort;
  /** 頁番号（1 始まり）。 */
  readonly page: number;
  /** 次の頁があるか。 */
  readonly hasNext: boolean;
}

/**
 * 並べ替えの切り替えを組み立てる。
 *
 * **いま選ばれている軸をリンクにしない。** 押しても同じ場所へ来るリンクは、
 * 「押せるが何も起きないもの」である（2.2 / 4.4 が出さないと定めているもの）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderSortNav(view: WorksListView): string {
  const items = (Object.keys(SORT_LABELS) as PublicWorkSort[]).map((sort) =>
    sort === view.sort
      ? `<strong class="gf-sort-current">${SORT_LABELS[sort]}</strong>`
      : `<a href="${worksListPath(sort, 1)}">${SORT_LABELS[sort]}</a>`,
  );
  return `<nav class="gf-sort" aria-label="並べ替え">並べ替え: ${items.join(' / ')}</nav>`;
}

/**
 * 頁送りを組み立てる。
 *
 * **無限スクロールを置かない**（仕様 2.3.3）。JavaScript も増やさない（9.3）。
 *
 * @param view 表示に必要な値
 * @returns HTML。前も次も無ければ空文字
 */
function renderPager(view: WorksListView): string {
  const links: string[] = [];
  if (view.page > 1) {
    links.push(`<a href="${worksListPath(view.sort, view.page - 1)}">前の ${WORKS_PER_PAGE} 件</a>`);
  }
  if (view.hasNext) {
    links.push(`<a href="${worksListPath(view.sort, view.page + 1)}">次の ${WORKS_PER_PAGE} 件</a>`);
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join(' ')}</nav>`;
}

/**
 * 一覧の HTML を組み立てる。
 *
 * **`noindex` を付けない。** ここは誰にでも見せる発見の面であり、`src/my-works.ts` や
 * 作品ページの下書き表示とは性質が違う。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderWorksListPage(view: WorksListView): string {
  const cards = renderWorkCards(view.works);
  const body =
    cards === ''
      ? `<p>まだ公開された作品がありません。</p>
<p><a class="gf-cta" href="${GENERATE_PAGE_PATH}">最初の 1 本を作る</a>（招待コードでの登録が必要です）</p>`
      : cards;

  return `${siteHead({
    title: '作品をさがす - Game Forge',
    extraHead:
      '\n<meta name="description" content="Game Forge で公開されているブラウザ2Dゲームの一覧。新着順と、改造された数の順に並べ替えられます。">',
  })}
<h1>作品をさがす</h1>
<p>公開された作品が並んでいます。遊ぶのに登録は要りません。</p>
<p class="gf-notice">${MOVED_NOTICE}</p>
${renderSortNav(view)}
${body}
${renderPager(view)}
${siteFooter()}`;
}

/**
 * 一覧を表示する。
 *
 * **上限より 1 件多く引く。** 「ちょうど 20 件あった」と「次の頁がある」は引いた件数
 * だけでは区別できず、区別せずに「次へ」を出すと**空の頁へ送る**ことになる
 * （`src/my-works.ts` が同じ理由で 1 件多く引いている）。
 *
 * **キャッシュの鍵に頁と軸を入れる。** ログイン状態は入れない——載せるのは
 * 全員に同じものが出る行だけである（`src/list-cache.ts`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWorksList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sort = toPublicWorkSort(url.searchParams.get('sort'));
  const page = toPageNumber(url.searchParams.get('page'));
  const offset = (page - 1) * WORKS_PER_PAGE;

  const fetched = await cachedRows(listCacheKey('works', { sort, page }), async () =>
    listPublishedGames(env, sort, WORKS_PER_PAGE + 1, offset),
  );

  return html(
    renderWorksListPage({
      works: fetched.slice(0, WORKS_PER_PAGE),
      sort,
      page,
      hasNext: fetched.length > WORKS_PER_PAGE && page < MAX_PAGE,
    }),
  );
}

/**
 * 公開一覧の経路（#328 / M9-2）。
 *
 * `src/app.ts` の経路表へ連結する。**完全一致で登録する**（{@link PUBLIC_WORKS_PATH}）。
 */
export const worksListRoutes: readonly Route[] = [
  { method: 'GET', path: PUBLIC_WORKS_PATH, handler: showWorksList },
];
