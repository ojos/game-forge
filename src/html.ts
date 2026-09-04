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
