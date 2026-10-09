// ops-report-trend.mjs — 月次の運営報告に添える「月ごとの生成回数」の図を、材料の値だけから描く（#957）
//
// 使い方:
//   node scripts/ops-report-trend.mjs <材料.json> <出力先のディレクトリ>
//
// 出力先に次を書く:
//   trend.svg         図の SVG（描いたものの正本）
//   trend-labels.md   図に描いた文字を 1 行 1 つで並べたもの（scripts/check-ops-report.sh に通すため）
//   trend.png         SVG を PNG にしたもの（sharp。人が note に貼る）
// 標準出力の最後の行: TREND_PASS / 終了コード: 0 = 書けた / 1 = 書けない（理由を標準エラーへ 1 行）
//
// # 材料に無い数を描かない
//
// 図に載せる数は、`material.trend.months[].generations`（scripts/ops-report-collect.sh が usage-report.sh の
// 日ごとの行から足し上げた値）だけである。**目盛りの数も描かない。** 目盛りの 50・100 は材料に無い数で、
// 公開の記事に「材料に無い数字」を持ち込む口になる（下書きの検査と同じ決まり。#936）。
// 描いた後で、値の札がすべて材料の数値の葉にあること・棒の数が材料の月の数と同じことを確かめ、
// 合わなければ書かずに落ちる。呼ぶ側（scripts/ops-report-images.sh）は trend-labels.md をさらに
// scripts/check-ops-report.sh に通す（日付の扱いも含めて、下書きと同じ検査を通す）。
//
// # 日本語のフォント
//
// PNG にする sharp（librsvg）は、システムのフォントで文字を描く。日本語のフォントが無い devcontainer では
// 文字が豆腐（□）になり、それでも PNG はできてしまう。**描く前に、日本語の 1 文字と私用領域の 1 文字を
// 描き比べ、同じ絵になったら（どちらも豆腐なら）落ちる。** 入れ方は docs/ops-report.md「画像の段の前提」（作り直しで scripts/install-browser.sh が入れる）。
//
// 自己試験は scripts/ops-report-images-selftest.mjs（scripts/check-ops-report-selftest.sh から回る）。
// PNG にする部分は試さない（CI にフォントが無い）。SVG を組む部分は純粋な関数で、そこを試す。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 図の大きさ（px）。note の本文の画像は横長で読まれるので 16:9 にする。 */
export const WIDTH = 1280;
export const HEIGHT = 720;

/**
 * 札をすべての棒に付けられる、1 か月あたりの幅の下限（px）。これより狭いと札が重なるので、最初の月・1 月・
 * 対象の月にだけ札を付ける。**月は落とさない**（サービスが始まった月から全部の棒を描く）。
 */
export const LABEL_ALL_MIN_SLOT = 64;

/** 図の題名と添え書き。**数字を入れない**（材料に無い数を描かないため）。 */
export const TITLE = '月ごとの生成回数';
export const CAPTION = 'Game Forge 運営報告';

/** 文字の書体。sharp は fontconfig で探すので、devcontainer に入る IPA ゴシックを先に置く。 */
const FONT_FAMILY = "'IPAGothic', 'IPAexGothic', 'Noto Sans CJK JP', 'Noto Sans JP', 'Hiragino Sans', sans-serif";

/** 色（public/assets/app.css のトークンの値）。対象の月だけ濃くする。 */
const COLOR = {
  ground: '#ffffff',
  ink: '#16181a',
  inkSoft: '#55595e',
  bar: '#aeb3b8',
  barCurrent: '#16181a',
  rule: '#d6d9dc',
};

/**
 * @typedef {{month: string, generations: number}} TrendMonth
 * @typedef {{kind: 'title' | 'caption' | 'month' | 'value', text: string, month?: string}} ChartLabel
 * @typedef {{svg: string, labels: ChartLabel[], months: TrendMonth[]}} TrendChart
 */

/**
 * 材料から月ごとの推移を読み、形を確かめる。
 *
 * @param {unknown} material scripts/ops-report-collect.sh の出力
 * @returns {TrendMonth[]} 古い順の月ごとの値（材料の全部の月）
 * @throws {Error} 推移が無い・形が違う・月が飛んでいる・最後の月が対象の月でない・最後の月の値が
 *   `figures.month.generations`（本文の「今月の数字」と同じ集計）と違う
 */
export function readTrend(material) {
  if (material === null || typeof material !== 'object') {
    throw new Error('材料が JSON のオブジェクトではありません');
  }
  const record = /** @type {Record<string, unknown>} */ (material);
  const trend = /** @type {Record<string, unknown> | undefined} */ (record['trend']);
  const months = trend?.['months'];
  if (!Array.isArray(months) || months.length === 0) {
    throw new Error('材料に月ごとの推移（trend.months）がありません。scripts/ops-report-collect.sh で集め直してください');
  }
  /** @type {TrendMonth[]} */
  const out = [];
  for (const entry of months) {
    const month = entry?.month;
    const generations = entry?.generations;
    if (typeof month !== 'string' || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/u.test(month)) {
      throw new Error(`trend.months の月の形が違います: ${String(month)}`);
    }
    if (!Number.isInteger(generations) || generations < 0) {
      throw new Error(`trend.months の ${month} の生成回数が 0 以上の整数ではありません`);
    }
    if (out.length > 0 && nextMonth(out[out.length - 1].month) !== month) {
      throw new Error(`trend.months が古い順に 1 か月ずつ並んでいません（${out[out.length - 1].month} の次が ${month}）`);
    }
    out.push({ month, generations });
  }
  if (out[out.length - 1].month !== record['month']) {
    throw new Error(`trend.months の最後の月が、対象の月（${String(record['month'])}）ではありません`);
  }
  // 本文の「今月の数字」と図の対象の月が食い違わないこと（保存した材料を手で直した、など）。
  const figures = /** @type {Record<string, Record<string, unknown>> | undefined} */ (record['figures']);
  const generations = figures?.['month']?.['generations'];
  if (!Number.isInteger(generations)) {
    throw new Error('材料に figures.month.generations（本文の生成回数）がありません。図と本文を照らせないので描きません');
  }
  if (generations !== out[out.length - 1].generations) {
    throw new Error(`trend.months の対象の月の値（${out[out.length - 1].generations}）が、figures.month.generations（${String(generations)}）と違います`);
  }
  return out;
}

/**
 * 次の月（YYYY-MM）。
 *
 * @param {string} month 月
 * @returns {string} 次の月
 */
function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * 月の札。最初の月と 1 月だけ年を付ける（「2026年8月」「9月」）。
 *
 * 下書きの検査（scripts/check-ops-report.sh）は、この 2 つの綴りを日付として照合から外す。
 *
 * @param {TrendMonth[]} months 図に描く月
 * @param {number} index 何番目か
 * @returns {string} 札の文字
 */
export function monthLabel(months, index) {
  const [year, month] = months[index].month.split('-').map(Number);
  return index === 0 || month === 1 ? `${year}年${month}月` : `${month}月`;
}

/**
 * XML の文字参照へ逃がす。
 *
 * @param {string} text 文字
 * @returns {string} 逃がした文字
 */
function escapeXml(text) {
  return text.replace(/[&<>"']/gu, (c) => `&#${c.codePointAt(0)};`);
}

/**
 * 材料の値だけから、月ごとの生成回数の棒グラフを SVG で組む。
 *
 * 目盛りの数は描かない（冒頭）。棒の上に値、下に月を書き、対象の月（最後の棒）だけ濃くする。
 * 月が多くて棒が狭いときは、札を最初の月・1 月・対象の月にだけ付ける（棒は全部描く）。
 *
 * @param {unknown} material 材料
 * @returns {TrendChart} SVG と、描いた文字の一覧
 */
export function buildTrendChart(material) {
  const months = readTrend(material);
  /** @type {ChartLabel[]} */
  const labels = [];
  /** @type {string[]} */
  const parts = [];
  const text = (/** @type {ChartLabel} */ label, /** @type {string} */ attrs) => {
    labels.push(label);
    const month = label.month === undefined ? '' : ` data-month="${label.month}"`;
    parts.push(`<text data-kind="${label.kind}"${month} ${attrs}>${escapeXml(label.text)}</text>`);
  };

  const left = 96;
  const right = WIDTH - 96;
  const top = 200;
  const baseline = HEIGHT - 120;
  const slot = (right - left) / months.length;
  const barWidth = Math.min(180, slot * 0.6);
  const max = Math.max(1, ...months.map((m) => m.generations));
  // 値の札が題名にかからないよう、いちばん高い棒でも上に札 1 つ分を空ける。
  const scale = (baseline - top) / max;

  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLOR.ground}"/>`);
  text({ kind: 'title', text: TITLE }, `x="${left}" y="96" font-size="48" font-weight="bold" fill="${COLOR.ink}"`);
  text(
    { kind: 'caption', text: CAPTION },
    `x="${right}" y="96" font-size="28" text-anchor="end" fill="${COLOR.inkSoft}"`,
  );
  parts.push(`<line x1="${left}" y1="${baseline}" x2="${right}" y2="${baseline}" stroke="${COLOR.rule}" stroke-width="2"/>`);

  const labelAll = slot >= LABEL_ALL_MIN_SLOT;
  months.forEach((m, index) => {
    const current = index === months.length - 1;
    const labelled = labelAll || index === 0 || current || m.month.endsWith('-01');
    const cx = left + slot * (index + 0.5);
    // 0 の月も、その月があることが見えるよう、高さ 3 px の棒を置く（値の札は 0 のまま）。
    const height = Math.max(3, Math.round(m.generations * scale));
    const fill = current ? COLOR.barCurrent : COLOR.bar;
    parts.push(
      `<rect data-kind="bar" data-month="${m.month}" x="${(cx - barWidth / 2).toFixed(1)}" y="${baseline - height}" ` +
        `width="${barWidth.toFixed(1)}" height="${height}" fill="${fill}"/>`,
    );
    if (!labelled) return;
    text(
      { kind: 'value', text: String(m.generations), month: m.month },
      `x="${cx.toFixed(1)}" y="${baseline - height - 16}" font-size="40" font-weight="bold" text-anchor="middle" fill="${COLOR.ink}"`,
    );
    text(
      { kind: 'month', text: monthLabel(months, index), month: m.month },
      `x="${cx.toFixed(1)}" y="${baseline + 52}" font-size="32" text-anchor="middle" fill="${current ? COLOR.ink : COLOR.inkSoft}"`,
    );
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `font-family="${FONT_FAMILY}">${parts.join('')}</svg>\n`;
  return { svg, labels, months };
}

/**
 * 材料の JSON の数値の葉をすべて集める（scripts/check-ops-report.sh が「材料にある」とみなす数の一部）。
 *
 * @param {unknown} value 材料
 * @param {Set<number>} [into] 足し込む先
 * @returns {Set<number>} 数値の集合
 */
export function numbersIn(value, into = new Set()) {
  if (typeof value === 'number') {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) numbersIn(v, into);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) numbersIn(v, into);
  }
  return into;
}

/**
 * 組んだ図が材料と合っているかを確かめる。合わなければ理由を返す（合えば空の配列）。
 *
 * - 値の札がすべて材料の数値の葉にあり、その札の月の値と同じ
 * - 棒の数が、材料の月の数と同じ（月を落とさない）。対象の月には値の札がある
 * - 題名と添え書きに数字が無い
 *
 * @param {TrendChart} chart {@link buildTrendChart} の戻り値
 * @param {unknown} material 材料
 * @returns {string[]} 合わない理由
 */
export function verifyTrendChart(chart, material) {
  const known = numbersIn(material);
  /** @type {string[]} */
  const problems = [];
  const values = chart.labels.filter((l) => l.kind === 'value');
  const monthLabels = chart.labels.filter((l) => l.kind === 'month');
  const bars = (chart.svg.match(/data-kind="bar"/gu) ?? []).length;
  const byMonth = new Map(readTrend(material).map((m) => [m.month, m.generations]));
  for (const v of values) {
    if (!/^[0-9]+$/u.test(v.text) || !known.has(Number(v.text))) {
      problems.push(`材料に無い数を描いています: ${v.text}`);
    } else if (v.month === undefined || byMonth.get(v.month) !== Number(v.text)) {
      problems.push(`値の札 ${v.text} が、その月（${String(v.month)}）の材料の値と違います`);
    }
  }
  if (bars !== byMonth.size || chart.months.length !== byMonth.size) {
    problems.push(`棒 ${bars} 本が、材料の月の数 ${byMonth.size} と合いません`);
  }
  if (values.length !== monthLabels.length || values.length > byMonth.size) {
    problems.push(`値の札 ${values.length} 個と月の札 ${monthLabels.length} 個が合いません`);
  }
  const lastMonth = chart.months[chart.months.length - 1]?.month;
  if (!values.some((v) => v.month === lastMonth)) {
    problems.push('対象の月に値の札がありません');
  }
  for (const l of chart.labels.filter((x) => x.kind === 'title' || x.kind === 'caption')) {
    if (/[0-9０-９]/u.test(l.text)) {
      problems.push(`題名か添え書きに数字があります: ${l.text}`);
    }
  }
  // SVG に実際に描いた文字が、一覧と 1 つずつ同じであること（種類・月・文字まで）。一覧だけを検査して、
  // 絵には別の数を描く抜け道を塞ぐ。値と月の照合も、一覧ではなく SVG から読んだもので行う。
  const drawn = drawnLabels(chart.svg);
  const same =
    drawn.length === chart.labels.length &&
    drawn.every((d, i) => {
      const l = chart.labels[i];
      return d.kind === l.kind && d.text === l.text && d.month === l.month;
    });
  if (!same) {
    problems.push(`SVG に描いた文字（${drawn.length} 個）が、一覧（${chart.labels.length} 個）と合いません`);
  }
  for (const d of drawn.filter((x) => x.kind === 'value')) {
    if (d.month === undefined || byMonth.get(d.month) !== Number(d.text) || !/^[0-9]+$/u.test(d.text)) {
      problems.push(`SVG に、その月の材料の値でない数を描いています: ${d.text}`);
    }
  }
  return problems;
}

/**
 * SVG に描いた文字を、描いた順に読む（文字参照は戻す）。
 *
 * @param {string} svg SVG
 * @returns {ChartLabel[]} 描いた文字（種類のない <text> は kind が空になり、一覧と合わなくなる）
 */
export function drawnLabels(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gu)].map((m) => {
    const attrs = m[1];
    const kind = /data-kind="([a-z]+)"/u.exec(attrs)?.[1] ?? '';
    const month = /data-month="([0-9-]+)"/u.exec(attrs)?.[1];
    const text = m[2].replace(/&#([0-9]+);/gu, (_, n) => String.fromCodePoint(Number(n)));
    return /** @type {ChartLabel} */ (month === undefined ? { kind, text } : { kind, text, month });
  });
}

/**
 * 図に描いた文字を、下書きの検査に通せる Markdown にする（1 行 1 つの箇条書き）。
 *
 * @param {TrendChart} chart 図
 * @returns {string} Markdown
 */
export function labelsMarkdown(chart) {
  return `# 推移の図に描いた文字\n\n${chart.labels.map((l) => `- ${l.text}`).join('\n')}\n`;
}

/**
 * 日本語のフォントで描けるかを確かめる。「月」と私用領域の 1 文字を描き比べ、同じ絵なら描けない。
 *
 * @param {typeof import('sharp')} sharp sharp
 * @returns {Promise<boolean>} 描けるなら true
 */
export async function canDrawJapanese(sharp) {
  const glyph = async (/** @type {string} */ ch) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/>` +
          `<text x="8" y="52" font-size="48" font-family="${FONT_FAMILY}">${ch}</text></svg>`,
      ),
    )
      .raw()
      .toBuffer();
  const [kanji, privateUse] = await Promise.all([glyph('月'), glyph('&#xE000;')]);
  return !kanji.equals(privateUse);
}

/**
 * コマンドラインから呼ばれたときの入口。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv.length !== 2) {
    throw new Error('使い方: node scripts/ops-report-trend.mjs <材料.json> <出力先のディレクトリ>');
  }
  const [materialPath, outDir] = argv;
  /** @type {unknown} */
  let material;
  try {
    material = JSON.parse(readFileSync(materialPath, 'utf8'));
  } catch (error) {
    throw new Error(`材料を JSON として読めません: ${String(error)}`);
  }
  const chart = buildTrendChart(material);
  const problems = verifyTrendChart(chart, material);
  if (problems.length > 0) {
    throw new Error(problems.join(' / '));
  }

  // sharp は devDependencies にある（リポジトリの node_modules から読む）。
  const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)));
  /** @type {typeof import('sharp')} */
  const sharp = require('sharp');
  if (!(await canDrawJapanese(sharp))) {
    throw new Error('日本語のフォントがありません（文字が豆腐になります）。bash scripts/install-browser.sh で入れてください（docs/ops-report.md「画像の段の前提」）');
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'trend.svg'), chart.svg);
  writeFileSync(join(outDir, 'trend-labels.md'), labelsMarkdown(chart));
  await sharp(Buffer.from(chart.svg)).png().toFile(join(outDir, 'trend.png'));
  console.log(`[ops-report-trend] ${chart.months.length} か月分の図を ${join(outDir, 'trend.png')} に書きました`);
  console.log('TREND_PASS');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[ops-report-trend] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
