// ops-report-shot.mjs — 運営報告の「入れたもの」に添える画面を、決まった一覧から選び、撮った画像を整える（#957）
//
// 使い方:
//   node scripts/ops-report-shot.mjs pick <下書き.md> [<対応表.json>]   # 撮る画面を選び、1 行の JSON を出す
//   node scripts/ops-report-shot.mjs crop <撮った.png> <出力.png> [<対応表.json>]   # 上端から対応表の大きさで切る
//
// 対応表の既定は scripts/ops-report-pages.json。撮るのは scripts/ops-report-images.sh（手元の開発用の仕込みと
// dev サーバ。本番には接続しない）。
//
// # 任意の URL を撮らせない
//
// 撮る画面は**対応表の path だけ**から選ぶ。下書き（生成した文章）からは、表の keywords が「入れたもの」の節に
// 何回出るかを数えるだけで、下書きの中の URL やパスは読まない。選んだ path は、さらに撮る側
// （scripts/ops-report-images.sh）が dev_fixture_paths の一覧に載っていることを確かめる。
//
// # 選び方
//
// 「## 入れたもの」の見出し（先頭の番号は問わない）から次の「## 」の見出しまでで、各画面の keywords が出た回数を足す。いちばん多い画面を
// 選ぶ（同じなら表の上のもの）。どれも 0 なら default の画面。**生成をもう 1 回呼ばない**（費用と、生成が表の外の
// 画面を言い出す口を増やさない）。同じ下書きからは必ず同じ画面になる。
//
// 自己試験は scripts/ops-report-images-selftest.mjs。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 既定の対応表。 */
export const DEFAULT_TABLE = fileURLToPath(new URL('./ops-report-pages.json', import.meta.url));

/** path に書いてよい埋め字（scripts/ops-report-images.sh が仕込みの値で埋める）。 */
export const PLACEHOLDERS = ['{GAME_ID}', '{PUBLISHED_GAME_ID}', '{HANDLE}'];

/** 選ぶ節の見出しの文字（docs/ops-report-template.md の型の 2 つ目の節）。「## 」と先頭の番号は外して比べる。 */
export const SECTION_HEADING = '入れたもの';

/**
 * @typedef {{key: string, path: string, label: string, keywords: string[], default?: boolean}} PageEntry
 * @typedef {{width: number, height: number, pages: PageEntry[]}} PageTable
 * @typedef {{key: string, path: string, label: string, hits: number}} PagePick
 */

/**
 * 対応表の形を確かめる。
 *
 * - key は英小文字・数字・- で、重ならない
 * - path は / で始まり、スキーム・ホスト・クエリ・断片・.. を持たず、埋め字は {@link PLACEHOLDERS} だけ
 * - keywords は空でない文字列が 1 つ以上
 * - default はちょうど 1 つ
 *
 * @param {unknown} raw 対応表の JSON
 * @returns {PageTable} 確かめた対応表
 * @throws {Error} 形が違う
 */
export function validateTable(raw) {
  const table = /** @type {Record<string, unknown>} */ (raw ?? {});
  const width = table['width'];
  const height = table['height'];
  const pages = table['pages'];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('対応表の width / height が正の整数ではありません');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('対応表の pages が空です');
  }
  const keys = new Set();
  let defaults = 0;
  for (const page of pages) {
    const key = page?.key;
    const path = page?.path;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(key) || keys.has(key)) {
      throw new Error(`対応表の key が不正か重なっています: ${String(key)}`);
    }
    keys.add(key);
    const bare = typeof path === 'string' ? PLACEHOLDERS.reduce((p, h) => p.split(h).join(''), path) : '';
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[:?#\\\s{}]/u.test(bare) ||
      bare.split('/').includes('..')
    ) {
      throw new Error(`対応表の path が不正です（${key}）: ${String(path)}`);
    }
    if (typeof page.label !== 'string' || page.label === '') {
      throw new Error(`対応表の label がありません（${key}）`);
    }
    if (!Array.isArray(page.keywords) || page.keywords.length === 0 || !page.keywords.every((k) => typeof k === 'string' && k !== '')) {
      throw new Error(`対応表の keywords が空です（${key}）`);
    }
    if (page.default === true) defaults += 1;
  }
  if (defaults !== 1) {
    throw new Error(`対応表の default がちょうど 1 つではありません（${defaults} 個）`);
  }
  return /** @type {PageTable} */ (raw);
}

/**
 * 下書きから「入れたもの」の節の本文を抜く（見出しの行は含めない）。無ければ空文字。
 *
 * @param {string} draft 下書きの Markdown
 * @returns {string} 節の本文
 */
export function sectionOf(draft) {
  const lines = draft.split('\n');
  const start = lines.findIndex((l) => l.trim().replace(/^## +(?:[0-9]+[.)] +)?/u, '') === SECTION_HEADING && l.startsWith('## '));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /u.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * 節の本文から、URL とパスの形の綴りを外す（その中の語を数えない。下書きの中の URL やパスで画面を選ばせない）。
 *
 * @param {string} text 節の本文
 * @returns {string} 外した本文
 */
export function withoutLinks(text) {
  return text
    .replace(/\]\([^)]*\)/gu, '] ')
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s)>」』）]*/gu, ' ')
    .replace(/(^|[\s(（「『`])\/[^\s)>」』）`]*/gu, '$1 ');
}

/**
 * 語が文の中に何回出るかを数える（重ならない数え方）。
 *
 * @param {string} text 文
 * @param {string} word 語
 * @returns {number} 回数
 */
function countOf(text, word) {
  return text.split(word).length - 1;
}

/**
 * 下書きの「入れたもの」から、撮る画面を対応表の中だけで選ぶ。
 *
 * @param {string} draft 下書きの Markdown
 * @param {PageTable} table {@link validateTable} を通した対応表
 * @returns {PagePick} 選んだ画面（hits は keywords が出た回数。0 なら default）
 */
export function pickPage(draft, table) {
  const section = withoutLinks(sectionOf(draft));
  /** @type {PagePick | null} */
  let best = null;
  for (const page of table.pages) {
    const hits = page.keywords.reduce((sum, k) => sum + countOf(section, k), 0);
    if (hits > 0 && (best === null || hits > best.hits)) {
      best = { key: page.key, path: page.path, label: page.label, hits };
    }
  }
  if (best !== null) return best;
  const fallback = /** @type {PageEntry} */ (table.pages.find((p) => p.default === true));
  return { key: fallback.key, path: fallback.path, label: fallback.label, hits: 0 };
}

/**
 * 対応表を読んで確かめる。
 *
 * @param {string} path 対応表のパス
 * @returns {PageTable} 対応表
 */
export function loadTable(path) {
  return validateTable(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * 撮った画像（ページ全体）の上端から、対応表の大きさで切る。短ければ下を白で埋める。
 *
 * @param {string} input 撮った PNG
 * @param {string} output 書き出す PNG
 * @param {PageTable} table 対応表
 * @returns {Promise<void>}
 */
async function crop(input, output, table) {
  const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)));
  /** @type {typeof import('sharp')} */
  const sharp = require('sharp');
  const meta = await sharp(input).metadata();
  if (meta.width !== table.width) {
    throw new Error(`撮った画像の幅が ${String(meta.width)} px で、対応表の ${table.width} px と違います`);
  }
  const height = Math.min(table.height, meta.height ?? 0);
  await sharp(input)
    .extract({ left: 0, top: 0, width: table.width, height })
    .extend({ bottom: table.height - height, background: '#ffffff' })
    .png()
    .toFile(output);
}

/**
 * コマンドラインの入口。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Promise<void>}
 */
async function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'pick' && (rest.length === 1 || rest.length === 2)) {
    const table = loadTable(rest[1] ?? DEFAULT_TABLE);
    const pick = pickPage(readFileSync(rest[0], 'utf8'), table);
    console.log(JSON.stringify({ ...pick, width: table.width, height: table.height }));
    return;
  }
  if (mode === 'crop' && (rest.length === 2 || rest.length === 3)) {
    await crop(rest[0], rest[1], loadTable(rest[2] ?? DEFAULT_TABLE));
    return;
  }
  throw new Error('使い方: node scripts/ops-report-shot.mjs pick <下書き.md> [<対応表.json>] | crop <撮った.png> <出力.png> [<対応表.json>]');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[ops-report-shot] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
