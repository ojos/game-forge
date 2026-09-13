// logo.mjs — Game Forge のロゴをドットの格子として定義し、組み合わせる（#438）。
//
// ## 格子の表し方
//
// 1 行 1 文字列の配列で、`.` が空き、`K` が墨（明るい地では #16181A、暗い地では #E7E9EB）、
// `A` がアンバー（#F59E0B）。**PNG の画素ではなくドットで持つ**——書き出すときに整数倍へ
// 拡大するので、どの大きさでも輪郭がぼやけない。
//
// ## シンボル（16×16）
//
// 左にホーンのある金床と、途中で 2 本に分かれて先に火の粉を 2 つ持つ火花。枝分かれは
// 改造（フォーク）の系統を表す。**16×16 にしてあるのは、16px のファビコンで 1 マスが
// ちょうど 1px になるから**で、小さい大きさ用の別の形を持たない。
// 決めた経緯と見送った案は docs/logo.md。

import { readGlyphs, HALF_ADVANCE } from './glyphs.mjs';

/** シンボル（16×16）。 */
export const SYMBOL = Object.freeze([
  '................',
  '....A..........A',
  '................',
  '......AA....AA..',
  '.......AA..AA...',
  '........AAAA....',
  '.........AA.....',
  '.........AA.....',
  'KKKKKKKKKKKKKKKK',
  '..KKKKKKKKKKKKKK',
  '.....KKKKKKKKKK.',
  '......KKKKKKKK..',
  '.......KKKKKK...',
  '.......KKKKKK...',
  '.....KKKKKKKKK..',
  '...KKKKKKKKKKKK.',
]);

/** ワードマークの語間（ドット）。グリフの空白は 8 ドットあり、ロゴでは開きすぎるため詰める。 */
export const WORD_SPACE = 4;

/**
 * 格子を整数倍に拡大する。
 * @param {readonly string[]} grid
 * @param {number} k 1 以上の整数
 * @returns {string[]}
 */
export function scaleGrid(grid, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`倍率は 1 以上の整数: ${k}`);
  return grid.flatMap((row) => Array(k).fill([...row].map((c) => c.repeat(k)).join('')));
}

/**
 * グリフを横に 1 ドット太らせる（各点の右隣も点にする）。
 *
 * ゲームの書体は線が 1 ドット幅で、シンボルの太いドットと並べると細すぎる。**幅を 1 列
 * 足してから太らせる**ので、文字の右端が次の文字に食い込まず、字間は元のまま残る。
 * @param {readonly string[]} rows 16 行、`#` が点
 * @returns {string[]} 幅が 1 列増えた 16 行、`K` が点
 */
export function emboldenGlyph(rows) {
  return rows.map((row) => {
    const wide = `${row}.`;
    return [...wide].map((c, i) => (c === '#' || wide[i - 1] === '#' ? 'K' : '.')).join('');
  });
}

/**
 * 文字列をゲームの書体で組む（半角のみ）。
 * @param {string} text
 * @param {{ bold?: boolean, glyphs?: Map<string, string[]> }} [opts]
 * @returns {string[]} 16 行
 */
export function setText(text, { bold = true, glyphs = readGlyphs() } = {}) {
  const cells = [...text].map((ch) => {
    if (ch === ' ') return Array(16).fill('.'.repeat(WORD_SPACE));
    const g = glyphs.get(ch);
    if (!g) throw new Error(`書体に無い文字: ${JSON.stringify(ch)}`);
    const half = g.map((r) => r.slice(0, HALF_ADVANCE));
    return bold ? emboldenGlyph(half) : half.map((r) => r.replaceAll('#', 'K'));
  });
  return Array.from({ length: 16 }, (_, y) => cells.map((c) => c[y]).join(''));
}

/**
 * 複数の格子を重ねて 1 枚にする。後に置いたものが上になる。
 * @param {{ grid: readonly string[], x: number, y: number }[]} layers
 * @returns {string[]}
 */
export function composeGrids(layers) {
  const w = Math.max(...layers.map(({ grid, x }) => x + grid[0].length));
  const h = Math.max(...layers.map(({ grid, y }) => y + grid.length));
  const out = Array.from({ length: h }, () => Array(w).fill('.'));
  for (const { grid, x, y } of layers) {
    grid.forEach((row, dy) => [...row].forEach((c, dx) => { if (c !== '.') out[y + dy][x + dx] = c; }));
  }
  return out.map((r) => r.join(''));
}

/**
 * 点のある範囲だけを残して周りの空きを削る。
 * @param {readonly string[]} grid
 * @returns {string[]}
 */
export function trimGrid(grid) {
  const ys = grid.map((r, y) => (/[^.]/.test(r) ? y : -1)).filter((y) => y >= 0);
  if (ys.length === 0) throw new Error('点が 1 つも無い格子は削れない');
  const inked = grid.slice(ys[0], ys.at(-1) + 1);
  const left = Math.min(...inked.map((r) => r.search(/[^.]/)).filter((x) => x >= 0));
  const right = Math.max(...inked.map((r) => r.search(/\.*$/) - 1));
  return inked.map((r) => r.slice(left, right + 1));
}

/**
 * ワードマーク（「Game Forge」を太らせた版）。
 * @param {Map<string, string[]>} [glyphs]
 * @returns {string[]}
 */
export function wordmark(glyphs) {
  return trimGrid(setText('Game Forge', { glyphs }));
}

/**
 * 横組み。シンボルを 2 倍にし、文字の大文字の下端を金床の底に揃える。
 *
 * 2 倍にするのは、文字（大文字の高さ 13 ドット）に対してシンボルが小さく見えないため。
 * 文字の格子は 1 行目から大文字が始まり 13 行目が下端なので、y を 31 − 13 = 18 に置くと
 * 金床の底（2 倍した格子の 31 行目）と揃う。
 * @param {Map<string, string[]>} [glyphs]
 * @returns {string[]}
 */
export function horizontalLockup(glyphs) {
  const text = setText('Game Forge', { glyphs });
  return trimGrid(composeGrids([
    { grid: scaleGrid(SYMBOL, 2), x: 0, y: 0 },
    { grid: text, x: 38, y: 18 },
  ]));
}

/**
 * 縦組み。2 倍のシンボルを文字の中央の上に置く。
 * @param {Map<string, string[]>} [glyphs]
 * @returns {string[]}
 */
export function stackedLockup(glyphs) {
  const text = setText('Game Forge', { glyphs });
  return trimGrid(composeGrids([
    { grid: scaleGrid(SYMBOL, 2), x: Math.floor((text[0].length - 32) / 2), y: 0 },
    { grid: text, x: 0, y: 34 },
  ]));
}
