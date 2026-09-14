#!/usr/bin/env node
// check-token-contrast.mjs — app.css の色のトークンが WCAG 2.2 の AA を満たすことを、値から計算して見る（#457 / 仕様 2.5.2）
//
// ## なぜ要るのか
//
// 仕様 2.5.2 は「文字の段は、置く面の上で AA を満たす」と決め、2026-09-13 に今のトークンが 2 か所で届いていない
// ことを実測した（三次の文字 4.05:1・入力欄の枠 1.42:1）。**直した値は、次に誰かがトークンを 1 つ淡くした日に
// 黙って戻る。** 画面を目で見ても 4.4:1 と 4.5:1 の差は分からないので、値から計算して落とす。
//
// ## 見るもの（明暗の両テーマ）
//
//   - 文字の段 `--gf-ink` / `--gf-ink-soft` / `--gf-ink-faint` が、地（`--gf-ground`）と面（`--gf-surface`）の
//     上で 4.5:1 以上（本文の大きさの文字。1.4.3）
//   - 入力欄の枠 `--gf-rule-input` が、地の上で 3:1 以上（部品の境界。1.4.11）
//
// **暗いテーマは `@media (prefers-color-scheme: dark)` の `:root` で上書きした値**を、明るいテーマの値の上に
// 重ねて読む（上書きしていないトークンは明るいテーマの値のままになる——CSS と同じ解決の仕方）。
//
// 使い方:
//   node scripts/check-token-contrast.mjs [app.css のパス]
//
// 終了コード: 0 = 合格（標準出力 TOKEN_CONTRAST_PASS）/ 1 = 不合格
//
// 依存パッケージを使わない（`tools/logobake` と同じ。Node だけで動く）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = process.argv[2] ?? path.join(here, '..', 'public', 'assets', 'app.css');

/** 文字の段と、その下に来うる面。 */
const TEXT_TOKENS = ['--gf-ink', '--gf-ink-soft', '--gf-ink-faint'];
const GROUND_TOKENS = ['--gf-ground', '--gf-surface'];
const TEXT_MIN = 4.5;
/** 部品の境界。入力欄は枠で見分けるので 3:1（1.4.11）。 */
const BORDER_CHECKS = [{ token: '--gf-rule-input', on: '--gf-ground', min: 3 }];

/**
 * コメントを除いた CSS から、ブロックの中の `--gf-*: #rrggbb;` を読む。
 *
 * @param {string} block `{ … }` の中身
 * @returns {Map<string, string>} トークン名 → 色
 */
function readColorTokens(block) {
  const tokens = new Map();
  for (const match of block.matchAll(/(--gf-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(match[1], match[2].toLowerCase());
  }
  return tokens;
}

/**
 * 相対輝度（WCAG 2.x の定義）。
 *
 * @param {string} hex `#rrggbb`
 * @returns {number} 0〜1
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * コントラスト比。
 *
 * @param {string} a `#rrggbb`
 * @param {string} b `#rrggbb`
 * @returns {number} 1〜21
 */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const lightBlock = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(css);
const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(css);
if (lightBlock === null || darkBlock === null) {
  console.error('[token-contrast] app.css に明るいテーマの :root か、暗いテーマの @media の :root が見つかりません（見ていないことを合格にしない）');
  process.exit(1);
}

const light = readColorTokens(lightBlock[1]);
const themes = [
  ['明るいテーマ', light],
  ['暗いテーマ', new Map([...light, ...readColorTokens(darkBlock[1])])],
];

const failures = [];
let checked = 0;
for (const [theme, tokens] of themes) {
  const color = (name) => {
    const value = tokens.get(name);
    if (value === undefined) {
      failures.push(`${theme}: ${name} が #rrggbb で定義されていません`);
    }
    return value;
  };
  for (const text of TEXT_TOKENS) {
    for (const ground of GROUND_TOKENS) {
      const fg = color(text);
      const bg = color(ground);
      if (fg === undefined || bg === undefined) continue;
      checked += 1;
      const ratio = contrast(fg, bg);
      if (ratio < TEXT_MIN) {
        failures.push(`${theme}: ${text}（${fg}）が ${ground}（${bg}）の上で ${ratio.toFixed(2)}:1（${TEXT_MIN}:1 以上が要る）`);
      }
    }
  }
  for (const { token, on, min } of BORDER_CHECKS) {
    const fg = color(token);
    const bg = color(on);
    if (fg === undefined || bg === undefined) continue;
    checked += 1;
    const ratio = contrast(fg, bg);
    if (ratio < min) {
      failures.push(`${theme}: ${token}（${fg}）が ${on}（${bg}）の上で ${ratio.toFixed(2)}:1（${min}:1 以上が要る）`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[token-contrast] ${failure}`);
  console.error('[token-contrast] 仕様 2.5.2 の「文字の段は置く面の上で AA を満たす」を割っています。');
  process.exit(1);
}
console.log(`[token-contrast] 明暗の両テーマで ${checked} 組が AA を満たしています`);
console.log('TOKEN_CONTRAST_PASS');
