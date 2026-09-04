/**
 * 画面を組み立てるときの小さな道具。
 *
 * ## なぜ独立したモジュールなのか
 *
 * `escapeHtml` は `src/signup.ts` が持っていたが、**`src/legal.ts` が借りた時点で
 * 循環参照になった**——`legal` は `signup` の `escapeHtml` を読み、`signup` は
 * `legal` の `siteFooter` を読む（Copilot の指摘。2026-09-04）。
 *
 * **いまは動く。** どちらもトップレベルで相手を呼んでいないためだが、
 * **テンプレートを定数へ畳んだ日に、初期化前の参照で落ちる。** 落ち方が分かりにくい
 * ので、**借りられる側を独立させて向きを一方向にする。**
 */

/**
 * HTML の特殊文字を実体参照へ置き換える。
 *
 * **属性値にも本文にも使える形にする。** `"` と `'` まで含めるのは、属性を
 * 引用符で囲む書き方が混ざったときに片方だけ安全になる状態を作らないためである。
 *
 * @param value 元の文字列
 * @returns 置き換えた文字列
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

import { HOME_PATH } from './paths.js';

/**
 * 見た目の土台となる 1 枚の CSS のパス（9.3 / #266）。
 *
 * **`public/` から静的に配る。** Pages は静的ファイルを Functions より先に解決するので
 * （`functions/[[path]].ts` の冒頭）、Worker も D1 も CPU も通らない。
 *
 * **各ページへ `<style>` を差し込む案は採らない。** すべてのページ応答に
 * `cache-control: no-store` が付いており（`src/routes.ts` の `html()`）、CSS 本文が
 * ページを開くたび丸ごと再送される。`no-store` は保存そのものを禁じるため、
 * 再検証で 304 に落とすこともできない。
 *
 * このパスが経路表のどの `path` とも衝突しないことは `test/page-shell.test.ts` が見る。
 */
export const APP_CSS_PATH = '/assets/app.css';

/**
 * 全画面の先頭に出すヘッダ（#266）。
 *
 * **サービス名 1 つだけに絞る。** 導線を増やすと情報設計の変更になり、
 * #266 の scope.out に当たる。
 *
 * ここが要るのは、**共有された URL から `/works/<id>` へ直接来た人**である。
 * その画面の `<h1>` は「作品」で、いま見ているのが何のサイトかを示すものが
 * どこにも無かった。主 KPI（フォーク率）の入口なので、そこを空けておかない。
 *
 * @returns HTML
 */
function siteHeader(): string {
  return `\n<header class="gf-header"><a href="${HOME_PATH}">Game Forge</a></header>`;
}

/** {@link siteHead} に渡す設定。 */
export interface SiteHeadOptions {
  /** `<title>` の中身。**エスケープはこの関数が行う**（呼び出し側で二重に掛けない）。 */
  readonly title: string;
  /** 検索避けが要る画面なら true。 */
  readonly noindex?: boolean;
  /** `<title>` のあとへ足す HTML（OGP の `meta` など）。既にエスケープ済みで渡す。 */
  readonly extraHead?: string;
  /** `<meta charset>` の直後へ足す HTML（`http-equiv` の再読み込みなど）。 */
  readonly beforeTitle?: string;
}

/**
 * 全画面に共通する文書の頭を組み立てる（#266）。
 *
 * ## なぜ 1 か所に置くか
 *
 * `siteFooter` と同じ理由である。**各ページで組み立てると、画面を 1 枚足したときに
 * 書き漏らす。** 実際 #282 では、全画面へ足したはずのフッタが 1 枚だけ違う位置に
 * 付いていた。ここを通す形にしておけば、**新しい画面は黙って土台に乗る。**
 *
 * 乗り損ねたことは `test/page-shell.test.ts` が経路表から導いて検出するが、
 * **検査は最後の砦であって一次の対策ではない。** 書き漏らしようがない形を先に作る。
 *
 * ## `charset` を最初に置く
 *
 * `<meta charset>` は文書の先頭 1024 バイト以内になければならない。`extraHead` を
 * 前へ回せる形にすると、呼び出し側の都合でそこが崩れうるので、**足せるのは
 * `charset` より後ろだけ**にしてある。
 *
 * ## `extraHead` はヘッダより前に出す
 *
 * `<meta>` は本文が始まる前に無ければならない。ヘッダ（`<header>`）は本文なので、
 * **必ず `extraHead` の後ろへ置く。** 逆にすると OGP の `meta` が本文へ落ち、
 * 共有時に読まれなくなる。
 *
 * @param options 設定
 * @returns `<!doctype html>` から始まる文書の頭と、共通ヘッダ
 */
export function siteHead(options: SiteHeadOptions): string {
  const robots = options.noindex === true ? '\n<meta name="robots" content="noindex">' : '';
  const beforeTitle = options.beforeTitle ?? '';
  const extraHead = options.extraHead ?? '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${APP_CSS_PATH}">${beforeTitle}${robots}
<title>${escapeHtml(options.title)}</title>${extraHead}${siteHeader()}`;
}
