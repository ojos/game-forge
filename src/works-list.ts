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
 * 2. **索引を張る。** `migrations/0019_games_public_list_idx.sql`（`recent` と `forked`）と
 *    `migrations/0020_games_like_count.sql`（`liked`。審査の可視条件を含む部分索引）と
 *    `migrations/` の `games_play_count`（`played`。同じ形の部分索引。#377）。
 *    タグで絞り込むときは `migrations/` の `games_tags`（枠 3 × 軸 2 の部分索引。#376）
 * 3. **Cache API を前段に置く。** 載せるのは HTML ではなく引いた行だけ（`src/list-cache.ts`）
 *
 * ## タグで絞り込める（#376 / 仕様 2.3.5）
 *
 * **左カラムのリンク（`?tag=<識別子>`）で 1 つだけ選ぶ。** JavaScript を使わない（`<a href>`
 * だけで組む。9.3）。{@link renderTagFilter} に判断をまとめてある。
 *
 * - **絞り込むとタグの付いた作品だけが出る**ことを、左カラムに書く（タグ無しを許したため。
 *   #376 の決定）。**絞り込まない一覧はタグで絞らない**——タグ無しの作品も並ぶ
 * - **絞り込み中の並べ替えは新着と改造された数だけ**（#376 の利用者の決定。理由は
 *   `src/games.ts` の `TAGGED_WORK_SORTS`）。いいね順・プレイ数順のリンクは出さず、`?sort=liked` /
 *   `?sort=played` は新着へ落とす
 * - **語彙に無い `?tag=` は無視して、絞り込まない一覧を出す**（400 にしない。`?sort=` と同じ扱い）
 * - **並べ替えと頁送りでタグを保つ。** キャッシュの鍵にもタグを入れる
 *
 * ## キーワードで検索できる（#378 / 仕様 2.3.5）
 *
 * **`?q=` があれば、検索の結果を同じ画面に描く**（issue の scope.in「`/works` の絞り込みと同居させる」）。
 * 語の解釈と索引の引き方は `src/work-search.ts` が持つ。ここが決めるのは見せ方だけである。
 *
 * - **並べ替えの軸を出さず、新着順に固定する**（#378 の利用者の決定 4）。`?sort=` は無視する
 * - **タグの絞り込みと併用できる。** タグを選んでも検索語を保ち、検索しても選んだタグを保つ
 * - **頁送りの上限は一覧と同じ**（{@link WORKS_PER_PAGE} 件・{@link MAX_PAGE} 頁）
 * - **断った検索（1 文字だけ・語が多すぎる・長すぎる）では D1 を引かない。** 400 にせず、理由を書く
 * - **キャッシュの鍵に検索語を入れる**（語を整えた後の綴り）。**非公開化の反映は、一覧と同じく最大
 *   60 秒遅れる**（`src/list-cache.ts`）
 * - **検索結果の画面は `noindex` にする。** 利用者が打った語を見出しに含むので、任意の語で
 *   索引される頁を外から作らせない
 *
 * ## 出さないもの
 *
 * 並べ替えは新着・「改造された数」・
 * 「いいねの数」・「プレイ数」の 4 軸である（2.3.4。v1.51 で `liked`、#377 で `played` を足した）。
 * 無限スクロールも置かない——**18 本しか無いところに置くものではない**（2.3.3）。
 *
 * **いいねの数とプレイ数は最大 5 分遅れる。** 並べ替えが読むのは `games.like_count` /
 * `games.play_count`（Durable Objects から写した数）で、正本は DO にある（5.8 / #377）。
 * **一覧を開くことで DO を呼ばない**——外部の閲覧者が大半で、閲覧数で DO の枠を減らさない。
 */
import type { PublicWork, PublicWorkSort } from './games.js';
import {
  TAGGED_WORK_SORTS,
  listPublishedGames,
  listTaggedGames,
  toPublicWorkSort,
  toTaggedWorkSort,
} from './games.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { cachedRows, listCacheKey } from './list-cache.js';
import { GENERATE_PAGE_PATH } from './paths.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from './works-paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { renderWorkCards } from './work-card.js';
import { WORK_TAGS, WORK_TAG_FIELD } from './work-tags.js';
import type { WorkTagId } from './work-tags.js';
import type { SearchRejection, WorkSearch } from './work-search.js';
import {
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_TERMS,
  WORK_SEARCH_FIELD,
  listSearchedGames,
  parseWorkSearch,
} from './work-search.js';

/**
 * 公開一覧のパス（`/works`）。
 *
 * **正本は `src/works-paths.ts` である**（`src/paths.ts` の冒頭が定める「提供する側と、
 * そこへ送り返す側が別モジュールになるもの」に当たる。移設の案内でここが `/works/mine`
 * を出し、「あなたの作品」の側がここを出すので、値を持ち合うと循環参照になる。
 * `src/paths.ts` そのものに置かないのは、Lambda の束に入るからである——#336）。
 * ここから再輸出するのは、既にこのモジュールから読んでいる箇所を動かさないためで、
 * 値を二重に持っているわけではない（`src/home.ts` の `HOME_PATH` と同じ扱い）。
 */
export { PUBLIC_WORKS_PATH }

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

/**
 * 移設の案内。
 *
 * **綴りを書き写さない。** `/works/mine` とリテラルで書くと、作品ページの綴りを変えた
 * 日に**案内文だけが古い場所を指す**（Copilot code review の指摘。2026-09-05）。
 * 正本（`src/works-paths.ts`）から組み立てる。
 */
export const MOVED_NOTICE = `自分の作品は ${MY_WORKS_PATH} へ移りました。`;

/**
 * 並べ替えの札。**綴りの正本は `src/games.ts` の `PUBLIC_WORK_SORTS` である。**
 *
 * `Record` にしてあるので、軸を足して札を書き忘れると型の検査で落ちる。
 */
const SORT_LABELS: Record<PublicWorkSort, string> = {
  recent: '新着',
  forked: '改造された数',
  liked: 'いいねの数',
  played: 'プレイ数',
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
 * `?tag=` を語彙の識別子へ落とす（#376）。
 *
 * **語彙に無い値は null（＝絞り込まない）にする。** 失敗させないのは {@link toPageNumber} と
 * 同じ理由で、共有された古い URL や書き間違いが 400 を返すより、全件の一覧が出るほうがよい。
 * **語彙に無い値で D1 を 1 回も引かない**（null なら絞り込みの問い合わせ自体を起こさない）。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 語彙の識別子。語彙に無ければ null
 */
export function toWorkTagFilter(value: string | null): WorkTagId | null {
  return WORK_TAGS.find((tag) => tag.id === value)?.id ?? null;
}

/**
 * 一覧の URL を組み立てる。
 *
 * **タグは並べ替えと頁より前に置き、絞り込まないときは付けない**（#376。絞り込まない一覧の
 * URL は #376 の前と 1 文字も変わらない——トップの「もっと見る」が同じ関数で組み立てている）。
 *
 * **検索語はタグの後に置き、検索しているときは並べ替えを付けない**（#378。検索中は新着順に
 * 固定で、`?sort=` を読まない。読まない値を URL に載せると、変えれば並びが変わるように見える）。
 * 検索しないときの URL は #378 の前と 1 文字も変わらない。
 *
 * @param sort 並べ替え軸
 * @param page 頁番号
 * @param tag 絞り込むタグ（絞り込まないなら null）
 * @param query 検索語（`src/work-search.ts` が整えた綴り。検索しないなら null）
 * @returns アプリ用ホスト上の絶対パス
 */
export function worksListPath(
  sort: PublicWorkSort,
  page: number,
  tag: WorkTagId | null = null,
  query: string | null = null,
): string {
  const filter = tag === null ? '' : `${WORK_TAG_FIELD}=${encodeURIComponent(tag)}&`;
  if (query !== null) {
    return `${PUBLIC_WORKS_PATH}?${filter}${WORK_SEARCH_FIELD}=${encodeURIComponent(query)}&page=${page}`;
  }
  return `${PUBLIC_WORKS_PATH}?${filter}sort=${sort}&page=${page}`;
}

/**
 * 検索の状態から、URL に載せる検索語を取り出す。
 *
 * **断った検索の語も載せる**——タグを選び直したときに、打った語が消えない（検索窓にも戻る）。
 *
 * @param search 検索の状態（省略は検索しない）
 * @returns 検索語。検索しないなら null
 */
function queryOf(search: WorkSearch | undefined): string | null {
  return search === undefined || search.kind === 'none' ? null : search.text;
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
  /**
   * 絞り込んでいるタグ（#376）。絞り込まないなら null。
   *
   * **省略可にしてある**のは、#376 より前に書いた描画の呼び出し（検査を含む）が絞り込まない
   * 一覧を描くときに、値を足さずに済むようにするためである。省略は null と同じ。
   */
  readonly tag?: WorkTagId | null;
  /**
   * 検索の状態（#378）。**省略は検索しない**（`{ kind: 'none' }` と同じ）。
   *
   * 省略可にしてあるのは {@link tag} と同じ理由である。
   */
  readonly search?: WorkSearch;
}

/**
 * 並べ替えの切り替えを組み立てる。
 *
 * **いま選ばれている軸をリンクにしない。** 押しても同じ場所へ来るリンクは、
 * 「押せるが何も起きないもの」である（2.2 / 4.4 が出さないと定めているもの）。
 *
 * **絞り込み中は、索引で保証している軸（新着と改造された数）だけを出す**（#376）。いいね順・
 * プレイ数順（#377）のリンクを出すと、押した先で新着に落ちる——**押しても何も起きないリンク**になる。
 * 軸を切り替えてもタグは保つ。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderSortNav(view: WorksListView): string {
  const tag = view.tag ?? null;
  // **検索中は並べ替えの軸を出さない**（#378 の決定 4）。押せる軸が無いことを書くだけにする
  // ——軸のリンクを出すと、押した先でも新着のまま（押しても何も起きないリンク）になる。
  if (queryOf(view.search) !== null) {
    return `<p class="gf-sort">${SEARCH_SORT_NOTICE}</p>`;
  }
  const sorts: readonly PublicWorkSort[] =
    tag === null ? (Object.keys(SORT_LABELS) as PublicWorkSort[]) : TAGGED_WORK_SORTS;
  const items = sorts.map((sort) =>
    sort === view.sort
      ? `<strong class="gf-sort-current">${SORT_LABELS[sort]}</strong>`
      : `<a href="${worksListPath(sort, 1, tag)}">${SORT_LABELS[sort]}</a>`,
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
  const tag = view.tag ?? null;
  const query = queryOf(view.search);
  const links: string[] = [];
  // **頁を送ってもタグと検索語を保つ**（#376 / #378）。
  if (view.page > 1) {
    links.push(
      `<a href="${worksListPath(view.sort, view.page - 1, tag, query)}">前の ${WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (view.hasNext) {
    links.push(
      `<a href="${worksListPath(view.sort, view.page + 1, tag, query)}">次の ${WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join(' ')}</nav>`;
}

/**
 * 絞り込みの但し書き（#376）。**タグ無しを許したので、絞り込むと出ない作品があることを書く。**
 *
 * 綴りを検査が借りられるように輸出する（`test/works-list.test.ts`）。
 */
export const TAG_FILTER_NOTICE =
  'タグで絞り込むと、作者がタグを付けた作品だけが出ます。タグの無い作品は「すべて」に並びます。';

/**
 * 検索中の並べ替えの代わりに出す一文（#378）。綴りを検査が借りられるように輸出する。
 */
export const SEARCH_SORT_NOTICE = '検索の結果は新着順に並びます。';

/**
 * 検索を断ったときの文言（#378）。
 *
 * **`Record` にしてあるので、断る理由を足して文言を書き忘れると型の検査で落ちる。**
 * 数は正本の定数から差し込む（書き写さない）。
 */
export const SEARCH_REJECTION_MESSAGES: Readonly<Record<SearchRejection, string>> = {
  'too-short': '1 文字だけでは検索できません。2 文字以上の語を入れてください。',
  'too-many-terms': `検索語は ${MAX_SEARCH_TERMS} 語までです。語を減らしてください。`,
  'too-long': `検索語は ${MAX_SEARCH_LENGTH} 文字までです。短くしてください。`,
};

/**
 * 左カラムのタグの絞り込みを組み立てる（#376 / 仕様 2.3.5）。
 *
 * # `<a href>` だけで組む
 *
 * **JavaScript もフォームも使わない**（9.3）。選べるのは 1 つだけで、押せばその URL へ移る。
 * **いま選んでいるものはリンクにしない**（{@link renderSortNav} と同じ理由）。
 *
 * # 行き先の並べ替え
 *
 * タグを選ぶと 1 頁目へ戻る（件数が変わるので、同じ頁番号に意味が無い）。並べ替えは、
 * 絞り込み中にも使える軸（新着・改造された数）ならそのまま保ち、いいね順・プレイ数順なら新着へ落とす。
 * 「すべて」へ戻るときは、いまの軸をそのまま保つ。
 *
 * # 置き場所
 *
 * **器の `.gf-split` の補助カラムに置く**（`public/assets/app.css` の `@section shell` が、
 * タグの絞り込みのために用意した枠）。段 3 では左に並び、狭い段では結果の上に積まれる。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderTagFilter(view: WorksListView): string {
  const current = view.tag ?? null;
  // **タグを選び直しても検索語を保つ**（#378。併用できる）。
  const query = queryOf(view.search);
  const items = [
    current === null
      ? '<li><strong class="gf-tag-current" aria-current="page">すべて</strong></li>'
      : `<li><a href="${worksListPath(view.sort, 1, null, query)}">すべて</a></li>`,
    ...WORK_TAGS.map((tag) =>
      tag.id === current
        ? `<li><strong class="gf-tag-current" aria-current="page">${tag.label}</strong></li>`
        : `<li><a href="${worksListPath(toTaggedWorkSort(view.sort), 1, tag.id, query)}">${tag.label}</a></li>`,
    ),
  ];
  return `<nav class="gf-tag-filter" aria-label="タグで絞り込む">
<h2>タグ</h2>
<ul>
${items.join('\n')}
</ul>
<p class="gf-tag-filter-note">${TAG_FILTER_NOTICE}</p>
</nav>`;
}

/**
 * 一覧が空のときの本文（#376）。
 *
 * **「このタグの作品はまだない」と「公開作品が 0 本」を書き分ける。** 絞り込んだ結果が空でも
 * 公開作品はあるかもしれないので、前者で「最初の 1 本を作る」を勧めると嘘になる。前者には
 * 「すべて」へ戻る道を置く（押せば作品が並ぶかもしれない場所である）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderEmpty(view: WorksListView): string {
  const tag = view.tag ?? null;
  const search = view.search ?? { kind: 'none' };
  // **検索の結果が空でも、公開作品はあるかもしれない**（#378）。検索をやめる道を置く
  // （タグは保つ——タグだけの一覧へ戻る）。断った検索では文言を上に出しているので、ここは道だけにする。
  if (search.kind !== 'none') {
    const clear = `<p><a href="${worksListPath('recent', 1, tag)}">検索をやめて一覧を見る</a></p>`;
    if (search.kind === 'rejected') {
      return clear;
    }
    return `<p>「${escapeHtml(search.text)}」に当たる作品はありませんでした。</p>
${clear}`;
  }
  if (tag !== null) {
    return `<p>このタグの作品はまだありません。</p>
<p><a href="${worksListPath(view.sort, 1)}">すべての作品を見る</a></p>`;
  }
  return `<p>まだ公開された作品がありません。</p>
<p><a class="gf-cta" href="${GENERATE_PAGE_PATH}">最初の 1 本を作る</a>（招待コードでの登録が必要です）</p>`;
}

/**
 * 一覧の HTML を組み立てる。
 *
 * **`noindex` を付けない。** ここは誰にでも見せる発見の面であり、`src/my-works.ts` や
 * 作品ページの下書き表示とは性質が違う。
 *
 * @param view 表示に必要な値
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderWorksListPage(view: WorksListView, viewer: SiteViewer): string {
  const cards = renderWorkCards(view.works);
  const body = cards === '' ? renderEmpty(view) : cards;
  const tag = view.tag ?? null;
  const tagLabel = WORK_TAGS.find((entry) => entry.id === tag)?.label ?? null;
  // **絞り込んでいることを結果の側にも書く**（狭い段では左カラムが上に積まれ、結果までの間に
  // 画面が 1 枚ぶん挟まる）。ラベルは語彙の固定の文字列で、UGC ではない。
  const filtered = tagLabel === null ? '' : `\n<p class="gf-tag-filtered">タグ「${tagLabel}」の作品</p>`;
  const search = view.search ?? { kind: 'none' };
  // **検索語は利用者の入力なので、見出しに出すときは必ず escape する**（#378）。
  const searched =
    search.kind === 'accepted'
      ? `\n<p class="gf-search-filtered">「${escapeHtml(search.text)}」の検索結果</p>`
      : search.kind === 'rejected'
        ? `\n<p class="gf-notice gf-search-rejected">${SEARCH_REJECTION_MESSAGES[search.reason]}</p>`
        : '';

  return `${siteHead({
    title: '作品をさがす - Game Forge',
    viewer,
    // **検索結果の画面は索引させない**（冒頭の「キーワードで検索できる」）。検索窓へ語を戻す。
    noindex: search.kind !== 'none',
    searchQuery: queryOf(search) ?? undefined,
    extraHead:
      '\n<meta name="description" content="Game Forge で公開されているブラウザ2Dゲームの一覧。新着順・改造された数の順・いいねの数の順・プレイ数の順に並べ替えられます。">',
  })}
<h1>作品をさがす</h1>
<p>公開された作品が並んでいます。遊ぶのに登録は要りません。</p>
<p class="gf-notice">${MOVED_NOTICE}</p>
<div class="gf-split">
${renderTagFilter(view)}
<div class="gf-works-results">${filtered}${searched}
${renderSortNav(view)}
${body}
${renderPager(view)}
</div>
</div>
${siteFooter()}`;
}

/**
 * 検索の結果を載せるキャッシュの鍵（#378）。
 *
 * **検索しない一覧の鍵と同じ関数（`listCacheKey`）で、項を 1 つ足した形にする。** 並べ替えは新着に
 * 固定なので `sort=recent` を入れる（検索しない新着の一覧とは `q` の項で分かれる）。検査が同じ鍵を
 * 捨てられるように輸出する。
 *
 * @param query 検索語（`src/work-search.ts` が整えた綴り）
 * @param page 頁番号
 * @param tag 絞り込むタグ（絞り込まないなら null）
 * @returns 鍵に使う URL
 */
export function worksSearchCacheKey(query: string, page: number, tag: WorkTagId | null): string {
  return listCacheKey('works', {
    sort: 'recent',
    page,
    [WORK_SEARCH_FIELD]: query,
    ...(tag === null ? {} : { [WORK_TAG_FIELD]: tag }),
  });
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
 * **絞り込むときは鍵にタグも入れる**（#376）。**絞り込まない一覧の鍵は #376 の前と同じ**に
 * してある（`tag` の項を足さない）ので、配備の前後で同じ一覧の保存物が 2 通りに増えない。
 * 配備の直後 60 秒は `tags` を持たない行が返りうるが、カードはタグを出さないだけで壊れない
 * （`src/work-card.ts` の `knownWorkTags`）。
 *
 * **検索するときは鍵に検索語も入れる**（#378。`src/work-search.ts` が整えた綴り——空白の数や
 * 語の重複が違うだけの URL は同じ鍵に載る）。**検索しない一覧の鍵は #378 の前と同じ**である。
 * **断った検索は鍵も D1 も使わない。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWorksList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tag = toWorkTagFilter(url.searchParams.get(WORK_TAG_FIELD));
  const search = parseWorkSearch(url.searchParams.get(WORK_SEARCH_FIELD));
  // **検索中は新着に固定する**（#378 の決定 4）。**絞り込み中は、索引で保証している 2 軸へ落とす**
  // （未知の軸も `liked` も新着。#376）。
  const sort: PublicWorkSort =
    search.kind !== 'none'
      ? 'recent'
      : tag === null
        ? toPublicWorkSort(url.searchParams.get('sort'))
        : toTaggedWorkSort(url.searchParams.get('sort'));
  const page = toPageNumber(url.searchParams.get('page'));
  const offset = (page - 1) * WORKS_PER_PAGE;

  let fetched: readonly PublicWork[];
  if (search.kind === 'rejected') {
    fetched = [];
  } else if (search.kind === 'accepted') {
    fetched = await cachedRows(worksSearchCacheKey(search.text, page, tag), async () =>
      listSearchedGames(env, search, tag, WORKS_PER_PAGE + 1, offset),
    );
  } else if (tag === null) {
    fetched = await cachedRows(listCacheKey('works', { sort, page }), async () =>
      listPublishedGames(env, sort, WORKS_PER_PAGE + 1, offset),
    );
  } else {
    fetched = await cachedRows(
      listCacheKey('works', { sort, page, [WORK_TAG_FIELD]: tag }),
      async () => listTaggedGames(env, tag, toTaggedWorkSort(sort), WORKS_PER_PAGE + 1, offset),
    );
  }

  return html(
    renderWorksListPage(
      {
        works: fetched.slice(0, WORKS_PER_PAGE),
        sort,
        page,
        hasNext: fetched.length > WORKS_PER_PAGE && page < MAX_PAGE,
        tag,
        search,
      },
      // **ヘッダだけが出し分かる**（2.3.7 / #331）。**鍵に混ぜない**——上のキャッシュに
      // 載るのは D1 から引いた行だけで、HTML はこのリクエストの状態で毎回組む
      // （2.3.3 の条件 3）。
      await resolveSiteViewer(request, env),
    ),
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
