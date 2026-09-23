// variants.mjs — 書き出す PNG の一覧（#438）。**この一覧が正本である。**
//
// docs/logo.md は種類と使い分けを説明するだけで、ファイル名とサイズを書き写さない
// （書き写した一覧は必ず古くなる。shared-ai-rules 12 章）。brand/logo/ の中身との
// 過不足は main.mjs --check が見る。
//
// ## 名前の付け方
//
// - 透過の画像は、置く地の明るさで `for-light-bg` / `for-dark-bg` を付ける
//   （墨の色が #16181A か #E7E9EB かが変わる。アンバーはどちらも同じ）。
// - 地色を塗った画像は、その地色で `white` / `black` を付ける。
// - 倍率で決まる画像は `x2`、寸法で決まる画像は `512` や `1200x630` を付ける。

import { SYMBOL, horizontalLockup, stackedLockup, wordmark } from './logo.mjs';

/** 色（仕様 2.3 系の画面の色と揃える。明: 墨 #16181A / 地 #FFFFFF、暗: 墨 #E7E9EB / 地 #131517）。 */
export const COLORS = Object.freeze({
  inkOnLight: '#16181A',
  inkOnDark: '#E7E9EB',
  amber: '#F59E0B',
  white: '#FFFFFF',
  black: '#131517',
});

/**
 * @typedef {object} Variant
 * @property {string} path brand/logo/ からの相対パス
 * @property {readonly string[]} grid ドットの格子
 * @property {number} scale 1 ドットの画素数（整数）
 * @property {'light' | 'dark'} ink 墨を明るい地用・暗い地用のどちらにするか
 * @property {'transparent' | 'white' | 'black'} ground 地
 * @property {number} [width] 画像の幅。省くと格子の幅 × scale
 * @property {number} [height] 画像の高さ。省くと格子の高さ × scale
 * @property {number} [left] 格子の左端の位置（画素）。省くと横は中央
 */

/**
 * 地を塗り、格子を中央に置く画像の定義を作る。中央からずれる端数は左上へ寄せる。
 * `left` を渡すと、横だけその位置へ置く（縦は中央のまま）。
 * @param {string} path
 * @param {readonly string[]} grid
 * @param {number} scale
 * @param {'white' | 'black'} ground
 * @param {number} width
 * @param {number} height
 * @param {number} [left] 格子の左端の位置（画素）
 * @returns {Variant}
 */
function framed(path, grid, scale, ground, width, height, left) {
  return { path, grid, scale, ink: ground === 'white' ? 'light' : 'dark', ground, width, height, ...(left === undefined ? {} : { left }) };
}

/**
 * 書き出す PNG をすべて列挙する。
 * @param {Map<string, string[]>} [glyphs] テストで差し替えるための書体の表
 * @returns {Variant[]}
 */
export function listVariants(glyphs) {
  const H = horizontalLockup(glyphs);
  const S = stackedLockup(glyphs);
  const W = wordmark(glyphs);
  /** @type {Variant[]} */
  const out = [];
  const bgs = /** @type {const} */ ([['light', 'for-light-bg'], ['dark', 'for-dark-bg']]);

  // シンボル: 16×16 の整数倍だけを出す（16 / 32 / 48 / 64 / 128 / 256 / 512）。
  for (const px of [16, 32, 48, 64, 128, 256, 512]) {
    for (const [ink, tag] of bgs) {
      out.push({ path: `symbol/symbol-${px}-${tag}.png`, grid: SYMBOL, scale: px / 16, ink, ground: 'transparent' });
    }
  }
  // アプリアイコン: 地を塗った正方形。角は丸めない（丸めは iOS / Android の側が行う）。
  // シンボルは一辺の 3/4 以下に収まる最大の整数倍にする（180 → 8 倍、192 → 9 倍、512 → 24 倍）。
  for (const px of [180, 192, 512]) {
    const k = Math.floor((px * 3) / 4 / 16);
    for (const ground of /** @type {const} */ (['white', 'black'])) {
      out.push(framed(`app-icon/app-icon-${px}-${ground}.png`, SYMBOL, k, ground, px, px));
    }
  }
  for (const k of [1, 2, 4, 8]) {
    for (const [ink, tag] of bgs) {
      out.push({ path: `lockup-horizontal/lockup-horizontal-x${k}-${tag}.png`, grid: H, scale: k, ink, ground: 'transparent' });
    }
  }
  for (const k of [2, 4, 8]) {
    for (const [ink, tag] of bgs) {
      out.push({ path: `lockup-stacked/lockup-stacked-x${k}-${tag}.png`, grid: S, scale: k, ink, ground: 'transparent' });
    }
  }
  for (const k of [1, 2, 4, 8]) {
    for (const [ink, tag] of bgs) {
      out.push({ path: `wordmark/wordmark-x${k}-${tag}.png`, grid: W, scale: k, ink, ground: 'transparent' });
    }
  }
  for (const ground of /** @type {const} */ (['white', 'black'])) {
    // OGP: 横組みを幅の 3/4 以下に収まる最大の整数倍で中央に置く。
    out.push(framed(`social/ogp-1200x630-${ground}.png`, H, Math.floor((1200 * 3) / 4 / H[0].length), ground, 1200, 630));
    // プロフィール: 円く切り抜かれる前提で、シンボルの四隅が内接円に入る 16 倍（256px）にする。
    out.push(framed(`social/profile-400-${ground}.png`, SYMBOL, 16, ground, 400, 400));
    // 帯状のヘッダー: **幅に対する割合はサービスごとに違う**（#780）。
    // 版面より狭く切って出す側があり、OGP の 3/4 をそのまま当てると切れるためである。
    // note は表示のときに上下が切られる（中央の 1920×340 ほどの帯だけが出る）ので、
    // その帯へ余白ごと収まる 45% にする。X は切られないので 55%。
    // OFUSE のカバーアートは帯そのもの（1000×150）なので、幅ではなく
    // 高さの 3/4 で決める（アプリアイコンと同じ決め方）。
    out.push(framed(`social/header-note-1920x1006-${ground}.png`, H, Math.floor((1920 * 0.45) / H[0].length), ground, 1920, 1006));
    out.push(framed(`social/header-x-1500x500-${ground}.png`, H, Math.floor((1500 * 0.55) / H[0].length), ground, 1500, 500));
    // **OFUSE だけ横を左へ寄せる**（#783）。この版面は、カバーアートの中央下に
    // プロフィールのアイコンの円と白いカードを重ねる。中央に置くと、実機で
    // 「Game Forge」の「ame」がアイコンに隠れた（2026-09-23 に本番の画面で確認）。
    // 左の余白は版面の高さと同じ 1/8（125px）。
    out.push(framed(`social/header-ofuse-1000x150-${ground}.png`, H, Math.floor((150 * 3) / 4 / H.length), ground, 1000, 150, 125));
  }
  return out;
}
