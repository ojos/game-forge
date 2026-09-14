// tap-mouse-verdict.mjs — タップがマウスの操作として作品へ届いたかを判定する（層 6。#491 / 仕様 3.9.3）。
//
// `scripts/sandbox-browser-probe.mjs --touch` の観測結果（JSON）を読み、ローダー文書の中で
// **検査用の作品が canvas で受けたマウスイベント**が、仕様 3.9.3 の表どおりかを見る。
//
// ## 判定を 1 か所に集める
//
// **直接開いた形と、作品ページに埋め込んだ形の 2 回呼ぶ。** 呼ぶ側
// （`scripts/check-sandbox-browser.sh`）へ 2 回書くと、片方だけ直る日が来る（#182 で実際に起きた。
// `scripts/wasm-body-verdict.mjs` の冒頭）。
//
// ## 何を見るか
//
// 送るタッチは「`(x1,y1)` で触れ、`(x2,y2)` へ動かし、離す」の 1 本である。届くべきマウスイベントは
// **この順のちょうど 4 つ**:
//
// | # | type | button | buttons | 座標 |
// |---|---|---|---|---|
// | 1 | mousemove | 0 | 1 | 触れた位置 |
// | 2 | mousedown | 0 | 1 | 触れた位置 |
// | 3 | mousemove | 0 | 1 | 動かした位置 |
// | 4 | mouseup   | 0 | 0 | 動かした位置（最後の座標） |
//
// - **4 つより多いと不合格にする。** ブラウザが互換のマウスイベントを作っていれば二重になる
//   （仕様 3.9.3「二重になることは無い」の反証）。
// - **すべて `isTrusted: false` であること。** 本物のマウスイベント（ブラウザが作ったもの）が
//   混ざっていないことの裏取りである。
// - **検査用の作品が本物のタッチも受けていること**（`touchCount > 0`）。ローダーは `preventDefault` も
//   `stopPropagation` も呼ばないので、Ebitengine の canvas のリスナーはこれまでどおり受ける（仕様 3.9.3-1）。
// - 座標は 1 CSS ピクセルまでの差を許す。埋め込んだ形では iframe の位置が小数になりうる。
//
// 使い方:
//   node scripts/tap-mouse-verdict.mjs --probe <json> --label <prefix>
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';

/** 座標の比較で許す差（CSS ピクセル）。 */
const COORDINATE_TOLERANCE = 1;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{probe: string, label: string}} 読み取った設定
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error(`引数の形が違います: ${String(name)}`);
    }
    values[name.slice(2)] = value;
  }
  if (values['probe'] === undefined) {
    throw new Error('--probe は必須です');
  }
  return { probe: values['probe'], label: values['label'] ?? '[tap-mouse]' };
}

/**
 * 観測結果から、wasm が走ったローダー文書の観測値を選ぶ。
 *
 * **不透明オリジン（`settingsOrigin === "null"`）で、wasm が走った文書だけ**を対象にする。
 * 直接開いた形では主文書、埋め込んだ形では子の文脈がそれにあたる。
 *
 * @param {any} result 観測結果
 * @returns {any | null} ローダー文書の観測値
 */
function loaderStateOf(result) {
  const candidates = [result.state, ...(result.frameContexts ?? []).map((/** @type {any} */ context) => context.state)];
  return (
    candidates.find((state) => state?.settingsOrigin === 'null' && state?.wasmRan === 'ok' && Array.isArray(state?.mouseLog)) ??
    null
  );
}

/**
 * 観測結果を判定する。
 *
 * @param {any} result 観測結果
 * @returns {string[]} 不合格の理由（空なら合格）
 */
function problemsOf(result) {
  const plan = result.touch?.plan;
  if (plan === undefined || plan === null) {
    return ['タッチを送っていません（probe に --touch が渡っていない）。この状態では何も確かめていません。'];
  }
  const state = loaderStateOf(result);
  if (state === null) {
    return [
      '検査用の作品のマウスの記録（__gfMouseLog）を持つ、wasm が走った不透明オリジンの文書がありません。' +
        ' 層 1〜4 が通っているなら、検査用の作品（check-sandbox-browser.sh の Go）の installInputProbe を確認してください。',
    ];
  }

  /** @type {string[]} */
  const problems = [];
  if (typeof state.touchCount !== 'number' || state.touchCount <= 0) {
    problems.push(
      `検査用の作品の canvas が本物のタッチを受けていません（touchCount=${String(state.touchCount)}）。` +
        ' ローダーが stopPropagation を呼んでいるか、タッチが canvas に当たっていません。',
    );
  }

  const expected = [
    { type: 'mousemove', buttons: 1, x: plan.startX, y: plan.startY },
    { type: 'mousedown', buttons: 1, x: plan.startX, y: plan.startY },
    { type: 'mousemove', buttons: 1, x: plan.endX, y: plan.endY },
    { type: 'mouseup', buttons: 0, x: plan.endX, y: plan.endY },
  ];
  /** @type {any[]} */
  const log = state.mouseLog;
  if (log.length !== expected.length) {
    problems.push(
      `canvas が受けたマウスイベントが ${log.length} 個です（期待は ${expected.length} 個: ` +
        `${expected.map((entry) => entry.type).join(' → ')}）。` +
        (log.length === 0
          ? ' タップがマウスとして届いていません。src/sandbox-loader.ts の TAP_TO_MOUSE_SCRIPT が文書に入っているかを確認してください。'
          : ' 多いなら、ブラウザの互換のマウスイベントと二重になっています。'),
    );
  } else {
    expected.forEach((want, index) => {
      const got = log[index];
      const mismatches = [];
      if (got?.type !== want.type) mismatches.push(`type=${String(got?.type)}（期待 ${want.type}）`);
      if (got?.button !== 0) mismatches.push(`button=${String(got?.button)}（期待 0）`);
      if (got?.buttons !== want.buttons) mismatches.push(`buttons=${String(got?.buttons)}（期待 ${want.buttons}）`);
      if (!(Math.abs(Number(got?.clientX) - want.x) <= COORDINATE_TOLERANCE)) {
        mismatches.push(`clientX=${String(got?.clientX)}（期待 ${want.x}）`);
      }
      if (!(Math.abs(Number(got?.clientY) - want.y) <= COORDINATE_TOLERANCE)) {
        mismatches.push(`clientY=${String(got?.clientY)}（期待 ${want.y}）`);
      }
      if (got?.isTrusted !== false) {
        mismatches.push(`isTrusted=${String(got?.isTrusted)}（期待 false。ブラウザが作ったイベントが混ざっている）`);
      }
      if (mismatches.length > 0) {
        problems.push(`${index + 1} 個目のマウスイベントが違います: ${mismatches.join(', ')}`);
      }
    });
  }
  return problems;
}

try {
  const { probe, label } = parseArgs(process.argv.slice(2));
  const result = JSON.parse(readFileSync(probe, 'utf8'));
  const problems = problemsOf(result);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${label} ${problem}\n`);
    }
    process.stderr.write(`${label} --- 観測結果（ローダー文書の候補） ---\n`);
    process.stderr.write(
      `${JSON.stringify({ touch: result.touch, state: result.state, frameContexts: result.frameContexts }, null, 2)}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${label} OK: タップが mousemove → mousedown → mousemove → mouseup として canvas へ届きました。\n`);
} catch (error) {
  process.stderr.write(`[tap-mouse] 判定できませんでした: ${String(error)}\n`);
  process.exit(1);
}
