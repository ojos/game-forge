// logobake — Game Forge のロゴを用途別・サイズ別の PNG へ書き出す（#438）。
//
// ## 使い方
//
//	node tools/logobake/main.mjs            # brand/logo/ へ書き出す（一覧に無い PNG は消す）
//	node tools/logobake/main.mjs --check    # 書き出し直した結果と brand/logo/ を照合する
//
// **スクリプトと PNG を両方コミットする**（tools/fontbake と glyphs_gen.go の関係と同じ）。
// PNG が無いと別の worktree や端末でロゴを使えず、スクリプトが無いと形や大きさを
// 変えたいときに作り直せない。
//
// ## --check が見るもの
//
// - 一覧の全項目が brand/logo/ にあり、**画素が一致する**こと
// - brand/logo/ に、一覧に無い PNG が無いこと
//
// **バイト一致ではなく画素で比べる。** 圧縮に使う zlib は版が変わると同じ入力から別の
// バイト列を出しうるので、バイト一致を合否にすると、Node を上げた日に絵が 1 画素も
// 変わっていないのに落ちる。バイトが同じならそこで合格にし、違うときだけ復号して比べる。
//
// 終了コード: 0 = 一致 / 1 = 不一致 / 2 = 実行の失敗

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVariants } from './variants.mjs';
import { renderVariant } from './render.mjs';
import { encodePng, decodePng, readPngHeader, toRgba } from './png.mjs';

/** 書き出し先（リポジトリの brand/logo/）。 */
export const OUT_DIR = fileURLToPath(new URL('../../brand/logo/', import.meta.url));

/**
 * ディレクトリ以下の PNG を、そのディレクトリからの相対パスで列挙する。
 * @param {string} dir
 * @returns {string[]}
 */
export function listPngs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.png'))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort();
}

/**
 * 一覧をすべて書き出す。一覧に無い PNG は消す（名前を変えた古いファイルを残さない）。
 * @param {string} [dir]
 * @returns {number} 書き出した枚数
 */
export function writeAll(dir = OUT_DIR) {
  const variants = listVariants();
  const wanted = new Set(variants.map((v) => v.path));
  for (const stale of listPngs(dir).filter((p) => !wanted.has(p))) rmSync(join(dir, stale));
  for (const v of variants) {
    const file = join(dir, v.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, encodePng(renderVariant(v)));
  }
  return variants.length;
}

/**
 * 一覧と dir の中身を照合し、食い違いを文で返す（空なら一致）。
 * @param {string} [dir]
 * @returns {string[]}
 */
export function checkAll(dir = OUT_DIR) {
  const problems = [];
  const variants = listVariants();
  const wanted = new Set(variants.map((v) => v.path));
  for (const extra of listPngs(dir).filter((p) => !wanted.has(p))) problems.push(`一覧に無い PNG がある: ${extra}`);
  for (const v of variants) {
    const file = join(dir, v.path);
    if (!existsSync(file)) { problems.push(`無い: ${v.path}`); continue; }
    const image = renderVariant(v);
    const actual = readFileSync(file);
    if (actual.equals(encodePng(image))) continue;
    // 寸法は展開する前に比べる（巨大な寸法を名乗る壊れた PNG で検査が止まらないように）。
    let got;
    try {
      const head = readPngHeader(actual);
      if (head.width !== image.width || head.height !== image.height) {
        problems.push(`寸法が違う: ${v.path}（${head.width}×${head.height}、一覧では ${image.width}×${image.height}）`);
        continue;
      }
      got = decodePng(actual);
    } catch (e) {
      problems.push(`読めない: ${v.path}（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    if (!Buffer.from(got.rgba).equals(Buffer.from(toRgba(image).rgba))) {
      problems.push(`画素が違う: ${v.path}`);
    }
  }
  return problems;
}

/**
 * コマンドラインの入口。
 * @param {string[]} argv
 * @returns {number} 終了コード
 */
function main(argv) {
  try {
    if (argv.includes('--check')) {
      const problems = checkAll();
      for (const p of problems) console.error(`[logobake] ${p}`);
      if (problems.length > 0) {
        console.error('[logobake] 直すには: node tools/logobake/main.mjs');
        return 1;
      }
      console.log(`[logobake] 一致: ${listVariants().length} 枚`);
      return 0;
    }
    console.log(`[logobake] 書き出した: ${writeAll()} 枚 → ${relative(process.cwd(), OUT_DIR) || OUT_DIR}`);
    return 0;
  } catch (e) {
    console.error(`[logobake] 失敗: ${e instanceof Error ? e.stack : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
