// ops-report-images-selftest.mjs — 運営報告の画像の段の自己試験（#957）
//
// 使い方: node scripts/ops-report-images-selftest.mjs <作業ディレクトリ>
// 終了コード: 0 = OPS_REPORT_IMAGES_SELFTEST_PASS / 1 = どれかが期待と違う
//
// scripts/check-ops-report-selftest.sh の 3 節から回る（ローカル層）。**ブラウザも日本語のフォントも使わない。**
// PNG にする部分（sharp）と画面を撮る部分（Chromium）は試さず、図を組む関数と画面を選ぶ関数を試す。
//
// 作業ディレクトリに、偽の材料（material.json）と、図に描いた文字（trend-labels.md）と、値を 1 つ書き換えた
// 文字（trend-labels-tampered.md）を置く。呼ぶ側がそれを scripts/check-ops-report.sh に通し、下書きと同じ
// 検査で「材料に無い数を描かない」ことを確かめる。
//
// 確かめること:
//   - 図に描いた値はすべて材料にあり、棒・値・月の数が材料の月の数と同じ
//   - 材料に無い値を描いた図は verifyTrendChart が落とす（書き換えた図・材料を減らした図）
//   - 推移が無い・最後の月が対象の月でない・値が整数でない・並びが逆、の材料を読まない
//   - 月が多くても月を落とさず全部の棒を描き、札は最初の月・1 月・対象の月だけにする
//   - 画面は対応表の中からだけ選ぶ（語を数える・同点は表の上・どれも当たらなければ default・節の外は数えない）
//   - 対応表の形の確かめ（スキーム・//・クエリ・知らない埋め字・default が 2 つ、を通さない）。本物の表は通る

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LABEL_ALL_MIN_SLOT,
  buildTrendChart,
  labelsMarkdown,
  readTrend,
  verifyTrendChart,
} from './ops-report-trend.mjs';
import { DEFAULT_TABLE, loadTable, pickPage, sectionOf, validateTable } from './ops-report-shot.mjs';

let fails = 0;
/** @param {string} name */
const ok = (name) => console.log(`[ops-report-images-selftest] ok   ${name}`);
/** @param {string} name */
const ng = (name) => {
  console.error(`[ops-report-images-selftest] NG   ${name}`);
  fails += 1;
};
/**
 * @param {string} name 確かめること
 * @param {boolean} cond 期待どおりなら true
 */
const expect = (name, cond) => (cond ? ok(name) : ng(name));
/**
 * 投げることを確かめる。
 *
 * @param {string} name 確かめること
 * @param {() => unknown} fn 呼ぶ関数
 */
const expectThrow = (name, fn) => {
  try {
    fn();
    ng(name);
  } catch {
    ok(name);
  }
};

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('使い方: node scripts/ops-report-images-selftest.mjs <作業ディレクトリ>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// ── 推移の図 ─────────────────────────────────────────────────────────────────
const material = {
  kind: 'ops-report-material',
  month: '2027-01',
  figures: { month: { generations: 245, llmCostJpy: 3120.5 } },
  trend: {
    metric: 'generations',
    months: [
      { month: '2026-11', generations: 117 },
      { month: '2026-12', generations: 0 },
      { month: '2027-01', generations: 245 },
    ],
  },
};
writeFileSync(join(outDir, 'material.json'), `${JSON.stringify(material, null, 2)}\n`);

const chart = buildTrendChart(material);
const values = chart.labels.filter((l) => l.kind === 'value').map((l) => Number(l.text));
expect('図に描いた値が、材料の月ごとの値と同じ並び', JSON.stringify(values) === '[117,0,245]');
expect('棒の数が材料の月の数と同じ', (chart.svg.match(/data-kind="bar"/gu) ?? []).length === 3);
expect('月の札は、最初の月と 1 月に年を付ける', JSON.stringify(chart.labels.filter((l) => l.kind === 'month').map((l) => l.text)) === '["2026年11月","12月","2027年1月"]');
expect('組んだ図は材料と合う', verifyTrendChart(chart, material).length === 0);
expect('目盛りの数を描かない（SVG の文字は一覧に載せたものだけ）', [...chart.svg.matchAll(/<text\b/gu)].length === chart.labels.length);
writeFileSync(join(outDir, 'trend-labels.md'), labelsMarkdown(chart));

// 値を 1 つ書き換えた図（材料に無い 999）。関数でも、下書きの検査（呼ぶ側）でも落ちる。
const tampered = {
  ...chart,
  svg: chart.svg.replace('>245</text>', '>999</text>'),
  labels: chart.labels.map((l) => (l.kind === 'value' && l.text === '245' ? { ...l, text: '999' } : l)),
};
expect('材料に無い値を描いた図を落とす', verifyTrendChart(tampered, material).some((p) => p.includes('999')));
writeFileSync(join(outDir, 'trend-labels-tampered.md'), labelsMarkdown(tampered));

// 絵（SVG）の数だけを書き換えて一覧はそのままの図も落とす（一覧だけを検査する抜け道）。
const svgOnly = { ...chart, svg: chart.svg.replace('>117</text>', '>999</text>') };
expect('SVG の数だけを書き換えた図を落とす', verifyTrendChart(svgOnly, material).length > 0);
// 一覧に載せずに文字を描いた図も落とす（一覧だけ検査して、絵に別の数を描く抜け道を塞ぐ）。
const hidden = { ...chart, svg: chart.svg.replace('</svg>', '<text>500</text></svg>') };
expect('一覧に無い文字を描いた図を落とす', verifyTrendChart(hidden, material).length > 0);

// 棒を 1 本落とした図も落とす（推移の点の数が材料と合わない）。
const missing = { ...chart, svg: chart.svg.replace(/<rect data-kind="bar"[^>]*\/>/u, '') };
expect('棒の数が材料と合わない図を落とす', verifyTrendChart(missing, material).length > 0);

// 題名に数字を入れた図も落とす。
const titled = { ...chart, labels: chart.labels.map((l) => (l.kind === 'title' ? { ...l, text: '直近 3 か月' } : l)) };
expect('題名に数字のある図を落とす', verifyTrendChart(titled, material).length > 0);

expectThrow('推移が無い材料を読まない', () => readTrend({ month: '2027-01' }));
expectThrow('最後の月が対象の月でない材料を読まない', () => readTrend({ ...material, month: '2027-02' }));
expectThrow('値が整数でない材料を読まない', () =>
  readTrend({ ...material, trend: { months: [{ month: '2027-01', generations: 1.5 }] } }));
expectThrow('負の値の材料を読まない', () =>
  readTrend({ ...material, trend: { months: [{ month: '2027-01', generations: -1 }] } }));
expectThrow('並びが逆の材料を読まない', () =>
  readTrend({ ...material, trend: { months: [{ month: '2027-01', generations: 1 }, { month: '2026-12', generations: 2 }] } }));
expectThrow('月が飛んでいる材料を読まない', () =>
  readTrend({ ...material, trend: { months: [{ month: '2026-11', generations: 1 }, { month: '2027-01', generations: 245 }] } }));
expectThrow('figures.month.generations が無い材料を読まない', () => readTrend({ ...material, figures: {} }));
expectThrow('対象の月の値が figures.month.generations と違う材料を読まない', () =>
  readTrend({ ...material, figures: { month: { generations: 8 } } }));
expectThrow('月の形が違う材料を読まない', () =>
  readTrend({ ...material, month: '2027-13', trend: { months: [{ month: '2027-13', generations: 1 }] } }));

const many = [];
for (let i = 0; i < 30; i += 1) {
  const y = 2026 + Math.floor((7 + i) / 12);
  const m = ((7 + i) % 12) + 1;
  many.push({ month: `${y}-${String(m).padStart(2, '0')}`, generations: i + 1 });
}
const manyMaterial = {
  month: many[many.length - 1].month,
  figures: { month: { generations: many[many.length - 1].generations } },
  trend: { months: many },
};
const manyChart = buildTrendChart(manyMaterial);
const manyValues = manyChart.labels.filter((l) => l.kind === 'value');
expect(`月が多くても（30 か月。1 か月の幅が ${LABEL_ALL_MIN_SLOT} px 未満）月を落とさず全部の棒を描く`,
  (manyChart.svg.match(/data-kind="bar"/gu) ?? []).length === 30 && verifyTrendChart(manyChart, manyMaterial).length === 0);
expect('月が多いときの札は、最初の月・1 月・対象の月だけ',
  JSON.stringify(manyValues.map((l) => l.month)) === JSON.stringify(many.map((m, i) => (i === 0 || i === 29 || m.month.endsWith('-01') ? m.month : null)).filter((m) => m !== null)));
// 月を 1 つ落とした図（材料の月の数と合わない）を落とす。
const dropped = buildTrendChart({ ...manyMaterial, trend: { months: many.slice(1) } });
expect('材料の月を落とした図を落とす', verifyTrendChart(dropped, manyMaterial).length > 0);
// 札を別の月へ付け替えた図（値は材料にあるが、その月の値ではない）を落とす。
const swapped = {
  ...chart,
  labels: chart.labels.map((l) => (l.kind === 'value' && l.month === '2026-11' ? { ...l, text: '245' } : l)),
};
expect('値の札がその月の値でない図を落とす', verifyTrendChart(swapped, material).length > 0);

// ── 画面の選び方 ─────────────────────────────────────────────────────────────
const table = validateTable({
  width: 1280,
  height: 720,
  pages: [
    { key: 'chat', path: '/generate', label: 'チャット', keywords: ['チャット', '相談'] },
    { key: 'apps', path: '/account/apps', label: 'アプリ', keywords: ['MCP'] },
    { key: 'work', path: '/works/{GAME_ID}', label: '作品', keywords: ['作品ページ'] },
    { key: 'top', path: '/', label: 'トップ', keywords: ['トップ'], default: true },
  ],
});
const draft = (/** @type {string} */ added) =>
  `# 運営報告\n\n## 今月の数字\n\n- MCP MCP MCP MCP\n\n## 入れたもの\n\n${added}\n\n## 直したもの\n\n- チャット チャット チャット\n`;
expect('節の本文だけを抜く', sectionOf(draft('- 本文')).trim() === '- 本文');
expect('番号付きの見出しでも節を抜く', sectionOf('## 2. 入れたもの\n\n- 本文\n\n## 直したもの\n').trim() === '- 本文');
expect('語がいちばん多く出た画面を選ぶ', pickPage(draft('- チャットで相談できます。MCP も。'), table).key === 'chat');
expect('同じ回数なら表の上の画面', pickPage(draft('- MCP とチャット'), table).key === 'chat');
expect('「入れたもの」の外で出た語は数えない', pickPage(draft('- 作品ページを直しました'), table).key === 'work');
const none = pickPage(draft('- 見た目を整えました'), table);
expect('どれも当たらなければ default の画面', none.key === 'top' && none.hits === 0);
expect('「入れたもの」の節が無ければ default の画面', pickPage('# 運営報告\n\n- チャット\n', table).key === 'top');
expect('下書きの中の URL やパスは撮る画面にならない',
  pickPage(draft('- https://example.com/admin と /admin/queue を見てください'), table).path === '/');
expect('URL・パス・リンク先の中の語は数えない',
  pickPage(draft('- https://example.com/チャット と /generate/相談 と [見た目](https://example.com/MCP)'), table).key === 'top');

const base = { width: 1280, height: 720 };
const page = (/** @type {Record<string, unknown>} */ extra) => ({
  ...base,
  pages: [{ key: 'a', path: '/a', label: 'A', keywords: ['A'], ...extra }, { key: 'top', path: '/', label: 'T', keywords: ['T'], default: true }],
});
expectThrow('スキームのある path を通さない', () => validateTable(page({ path: 'https://example.com/' })));
expectThrow('// で始まる path を通さない', () => validateTable(page({ path: '//example.com/a' })));
expectThrow('クエリのある path を通さない', () => validateTable(page({ path: '/a?x=1' })));
expectThrow('.. を含む path を通さない', () => validateTable(page({ path: '/a/../admin' })));
expectThrow('知らない埋め字を通さない', () => validateTable(page({ path: '/works/{OTHER}' })));
expectThrow('keywords が空の画面を通さない', () => validateTable(page({ keywords: [] })));
expectThrow('default が 2 つの表を通さない', () => validateTable(page({ default: true })));
expectThrow('key が重なる表を通さない', () => validateTable(page({ key: 'top' })));

/** @type {import('./ops-report-shot.mjs').PageTable | null} */
let real = null;
try {
  real = loadTable(DEFAULT_TABLE);
} catch (error) {
  ng(`本物の対応表（scripts/ops-report-pages.json）が形の確かめを通りません: ${String(error)}`);
}
if (real !== null) {
  ok('本物の対応表（scripts/ops-report-pages.json）は形の確かめを通る');
  expect('本物の対応表で、チャットの話は作品を作る画面を選ぶ',
    pickPage(draft('- AI と相談しながら作れるようになりました。生成の前にチャットして指示文を練れます。'), real).key === 'generate');
}

if (fails > 0) {
  console.error(`[ops-report-images-selftest] ${fails} 件が期待と違います`);
  console.log('OPS_REPORT_IMAGES_SELFTEST_FAIL');
  process.exit(1);
}
console.log('OPS_REPORT_IMAGES_SELFTEST_PASS');
