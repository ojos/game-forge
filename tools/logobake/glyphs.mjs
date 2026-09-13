// glyphs.mjs — ゲームに組み込んでいるドット書体（jpfont）のグリフを読み出す（#438）。
//
// **ロゴの文字は、ゲームの画面に出る文字と 1 ドット単位で同じにする。** そのために
// Web フォントの DotGothic16 で似せるのではなく、tools/fontbake が 16×16 に焼いて
// コミットした glyphs_gen.go を直接読む。焼き直されたら、ロゴも同じ焼き結果に追随する
// （追随したかは main.mjs --check が落ちて教える）。
//
// **Go のソースを文字列として読む。** 形は fontbake の出力に固定されている——
// 1 グリフ 1 行で `"\xHH × 32" + // U+XXXX`。この形が変わったら、読めた数が 0 になり
// readGlyphs が例外で落ちる（黙って空のワードマークを書き出さない）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** glyphs_gen.go の既定の場所（このファイルからの相対）。 */
export const GLYPHS_GO = fileURLToPath(new URL('../../docker/isolated-build/template/jpfont/glyphs_gen.go', import.meta.url));

/** 半角グリフの送り幅（ドット）。glyphs_gen.go の advances が ASCII に与える値。 */
export const HALF_ADVANCE = 8;

/**
 * glyphs_gen.go を読み、文字 → 16 行の文字列（`#` が点、`.` が空き）の表を返す。
 * @param {string} [path]
 * @returns {Map<string, string[]>}
 */
export function readGlyphs(path = GLYPHS_GO) {
  const src = readFileSync(path, 'utf8');
  const glyphs = new Map();
  for (const m of src.matchAll(/"((?:\\x[0-9a-f]{2}){32})" \+ \/\/ U\+([0-9A-F]{4,6})/g)) {
    const bytes = m[1].match(/[0-9a-f]{2}/g).map((h) => parseInt(h, 16));
    const rows = [];
    for (let r = 0; r < 16; r++) {
      const v = (bytes[r * 2] << 8) | bytes[r * 2 + 1];
      let row = '';
      for (let c = 0; c < 16; c++) row += v & (1 << (15 - c)) ? '#' : '.';
      rows.push(row);
    }
    glyphs.set(String.fromCodePoint(parseInt(m[2], 16)), rows);
  }
  if (glyphs.size === 0) throw new Error(`グリフを 1 つも読めなかった（glyphs_gen.go の形が変わった可能性）: ${path}`);
  return glyphs;
}
