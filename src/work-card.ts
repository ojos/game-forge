/**
 * 作品カード。**一覧・トップ・作者ページが同じ 1 つの部品を使う**（仕様 2.3.6 / #328）。
 *
 * ## なぜ部品として切り出すのか
 *
 * M9 は作品が並ぶ画面を 3 枚増やす（公開一覧 #328 / トップ #329 / 作者ページ #330）。
 * **3 枚が別々にカードを書くと、項目が 1 つずれた日に気づけない。** 出す項目と
 * 出さない項目は仕様 2.3.6 が決めており、その決定が効く場所をここ 1 か所にする。
 *
 * ## 出さないもの
 *
 * **`users.email` と `users.invited_by` はここへ届かない。** 引く側
 * （`src/games.ts` の `listPublishedGames`）が `display_name` しか選んでいないので、
 * カードが誤って出す経路が無い。**「出さない」を表示側の注意ではなく、引く形で担保する**
 * （#152 の絞り込みと同じ規律）。
 *
 * **いいね数・プレイ数・タグも出さない。** 仕様 2.3.5 が「持たない」と決めている。
 *
 * ## スクリーンショットが無い作品も並べる
 *
 * OGP は公開時に 1 回だけ撮り（5.4）、**撮影が中断したまま残る行がありうる**
 * （#235 が撮り直しの経路を足したのはそのためである）。撮れていない作品をカードごと
 * 落とすと、**公開したのに一覧に出ない**という、作者からは理由の見えない状態になる。
 * 画像だけを代替表示にして、行は必ず並べる。
 */
import { UNTITLED_TITLE } from './games.js';
import type { PublicWork } from './games.js';
import { escapeHtml } from './html.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import { OGP_IMAGE_HEIGHT, OGP_IMAGE_WIDTH, ogpImagePath } from './ogp.js';
import { workPagePath } from './paths.js';

/**
 * 作者名が引けなかったときに出す名前。
 *
 * **`users` の行が消えている作品は通常ありえない**（`games.author_id` は外部キーで、
 * 0001 は BAN でも行を消さないと定めている）。それでも既定を持つのは、**1 行の欠けで
 * カードが無名になるより、分からないと言うほうがよい**ためである。
 *
 * 綴りの正本はここに置き、作品ページ（`src/work-page.ts`）も借りる。
 */
export const UNKNOWN_AUTHOR = '不明';

/**
 * 題名を決める。
 *
 * `games.title` は `NOT NULL` で、生成の経路は必ず非空の仮題名を入れる
 * （`src/games.ts` の `draftTitleFromPrompt`）。**それでも空を扱えるようにしておく**のは、
 * 不変条件を画面が前提にしないためである（`src/my-works.ts` と同じ方針）。
 *
 * @param title `games.title`
 * @returns 画面に出す題名（空にならない）
 */
export function cardTitleOf(title: string): string {
  return title.trim() === '' ? UNTITLED_TITLE : title;
}

/**
 * スクリーンショットの部分を組み立てる。
 *
 * **`alt` を空にする。** 直後に題名が文字で並んでおり、読み上げが題名を 2 度言うのを
 * 避ける（カード全体が 1 本のリンクである）。作品ページの `<img>` が
 * `alt="この作品の画面"` を持つのは、あちらが**主役として 1 枚だけ**出すためで、
 * 役割が違う。
 *
 * @param work 作品
 * @returns HTML
 */
function renderShot(work: PublicWork): string {
  if (!work.hasShot) {
    return '<span class="gf-card-shot gf-card-shot-pending">画面の準備中</span>';
  }
  return (
    `<img class="gf-card-shot" src="${ogpImagePath(work.id)}"` +
    ` width="${OGP_IMAGE_WIDTH}" height="${OGP_IMAGE_HEIGHT}" alt="" loading="lazy">`
  );
}

/**
 * カードの下段（作者・改造された数・公開日時）を組み立てる。
 *
 * **`fork_count` が 0 の作品には何も出さない。** 全行に「改造 0」が並ぶ一覧は区別を
 * 何も運ばない（`src/my-works.ts` が全行に同じ警告を並べないと決めたのと同じ）。
 *
 * @param work 作品
 * @returns HTML
 */
function renderMeta(work: PublicWork): string {
  const parts = [
    `<span class="gf-card-author">${escapeHtml(work.authorName ?? UNKNOWN_AUTHOR)}</span>`,
  ];
  if (work.hasParent) {
    parts.push('<span class="gf-card-tag">改造された作品</span>');
  }
  if (work.forkCount > 0) {
    parts.push(`<span class="gf-card-forks">改造 ${work.forkCount}</span>`);
  }
  // **読めない日時では `<time>` ごと落とす。** `datetime=""` は不正であり、空の属性を
  // 出すくらいなら出さない（`src/my-works.ts` と同じ扱い）。カードは残る。
  const iso = work.publishedAt === null ? '' : toIsoTimestamp(work.publishedAt);
  if (iso !== '') {
    parts.push(`<time datetime="${iso}">${formatJstMinutes(work.publishedAt!)}</time>`);
  }
  return `<p class="gf-card-meta">${parts.join(' ')}</p>`;
}

/**
 * 作品カード 1 枚を組み立てる。
 *
 * **`escapeHtml` を通すのは題名と作者名だけである。** 他はこのモジュールが持つ固定の
 * 文字列か、`games.id`（`crypto.randomUUID()` の出力）と数値である。どちらも UGC 由来で、
 * **カードが D1 の値を HTML へ入れる場所はこの 2 つに限られる。**
 *
 * @param work 作品
 * @returns `<li>` 1 つ
 */
export function renderWorkCard(work: PublicWork): string {
  return (
    `  <li class="gf-card"><a class="gf-card-link" href="${workPagePath(work.id)}">` +
    `${renderShot(work)}` +
    `<span class="gf-card-title">${escapeHtml(cardTitleOf(work.title))}</span></a>` +
    `${renderMeta(work)}</li>`
  );
}

/**
 * 作品カードを並べる。
 *
 * **空のときは `<ul>` ごと出さない。** 空のリストは読み上げにも見た目にも意味が無く、
 * 「まだ無い」ことは呼び出し側が文で言うほうがよい（画面ごとに言うべきことが違う）。
 *
 * @param works 作品（既に並べ替えと件数の上限を適用してある）
 * @returns HTML。作品が 0 件なら空文字
 */
export function renderWorkCards(works: readonly PublicWork[]): string {
  if (works.length === 0) {
    return '';
  }
  return `<ul class="gf-cards">\n${works.map(renderWorkCard).join('\n')}\n</ul>`;
}
