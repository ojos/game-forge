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
 * OFUSE のカバーアートの版面（#788）。**テストはこの値を読む。書き写さない。**
 *
 * OFUSE のクリエイターページは、カバーアートの**横中央**にプロフィールのアイコンの円を
 * 重ねる。円は中央（x = width / 2）に固定で、直径は約 111px。帯の下側では x=444..556 を
 * 占める（2026-09-23 に本番の画面で実測）。`iconClearance` はその半径に余裕を足した値で、
 * 中央からこれだけ離れた内側はロゴを置ける領域ではない。
 *
 * #783 は横組み（シンボル＋文字）を左へ寄せたが、インクの右端が 491 になり、円へ 40px
 * 食い込んだままだった。**「中央をまたがない」では足りない**（当時のテストはそこまでしか
 * 見ておらず、隠れたまま緑で通った）。
 */
export const OFUSE_COVER = Object.freeze({ width: 1000, height: 150, iconClearance: 60 });

/**
 * OFUSE のカバーアートへワードマークを置く倍率と左端を決める。
 *
 * 上・下・左の余白を等しくし（左端 = 縦の中央寄せと同じ式）、インクの右端がアイコンの
 * 占有域へ入らない最大の整数倍を返す。右端は倍率について単調に増えるので、入った時点で
 * 打ち切ってよい。ワードマーク（84×14 ドット）では 4 倍（336×56・左端 47・右端 383）になり、
 * 5 倍は右端 459 で円に入る。
 *
 * シンボルを外すのは、重なるアイコンがまさにそのシンボルを出しているためである。文字だけに
 * すると倍率を上げられ、文字の高さは #783 の 42px から 56px へ増える。
 * @param {readonly string[]} grid ワードマークの格子
 * @returns {{ scale: number, left: number }}
 */
function ofuseWordmarkPlacement(grid) {
  const { width, height, iconClearance } = OFUSE_COVER;
  const limit = width / 2 - iconClearance;
  /** @type {{ scale: number, left: number } | undefined} */
  let best;
  for (let scale = 1; ; scale++) {
    const left = Math.floor((height - grid.length * scale) / 2);
    if (left < 0 || left + grid[0].length * scale > limit) break;
    best = { scale, left };
  }
  if (!best) throw new Error(`OFUSE のカバーアートに収まる倍率がありません（使える幅 ${limit}px）`);
  return best;
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
    // **OFUSE だけシンボルを外し、ワードマークを左へ置く**（#788）。置き方の理由と
    // 倍率の決め方は OFUSE_COVER / ofuseWordmarkPlacement に書いた。
    const ofuse = ofuseWordmarkPlacement(W);
    out.push(framed(`social/header-ofuse-${OFUSE_COVER.width}x${OFUSE_COVER.height}-${ground}.png`, W, ofuse.scale, ground, OFUSE_COVER.width, OFUSE_COVER.height, ofuse.left));
  }
  return out;
}
