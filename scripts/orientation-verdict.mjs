// orientation-verdict.mjs — 作品のおすすめの向きで開き、あとで入れ替えられることを判定する（層 10。#514 / 仕様 3.9.4）。
//
// `scripts/orientation-probe.mjs` の観測結果（JSON）を読み、仕様 3.9.4 の「作品のおすすめの向きで開き、あとで入れ替えられる」の決めごとを見る。
//
// | # | 見るもの |
// |---|---|
// | 前提 | どの段でもタッチ端末の形（`pointer: coarse`）で覆いが開き、差し替えが入り、ページの例外が出ていない |
// | 1 | 横長の作品で固定できる端末: **全画面に入った後で** `lock('landscape')` が 1 回呼ばれ、上の行に控えめのボタン「縦向きにする」が出て、案内は出ない |
// | 2 | ボタンを押すと `lock('portrait')` が呼ばれ、ボタンが「横向きにする」になり、`localStorage` に `portrait` を覚える |
// | 3 | 「閉じる」で閉じると `unlock()` が呼ばれる。開き直すと**覚えた向き（`portrait`）で固定**し、ボタンは「横向きにする」。全画面の解除で閉じても `unlock()` が呼ばれる |
// | 4 | 横長の作品で固定を拒む端末: ボタンは出ず、縦持ちでは案内「横にすると大きく遊べます」が出て、横持ちに回すと消え、縦持ちに戻すとまた出る |
// | 5 | 横長の作品で固定の API が無い端末: `lock` は呼ばれず、ボタンは出ず、縦持ちでは案内が出る |
// | 6 | 縦長の作品: 固定できれば `lock('portrait')` とボタン「横向きにする」、固定を拒む端末の横持ちでは案内「縦にすると大きく遊べます」 |
// | 7 | 正方形の作品と論理解像度の無い作品: 覆いに向きの属性が無く、ボタンも案内も置かれず、`lock` も `unlock` も呼ばれない |
// | 形 | 縦持ち 390px で、上の行（向きのボタン・案内・十字 / スティックの切り替え・「閉じる」）が画面の横幅からはみ出さず、重ならない |
//
// 使い方:
//   node scripts/orientation-verdict.mjs --probe <json> --label <prefix>
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';

/** 矩形の比較で許す差（CSS ピクセル）。 */
const TOLERANCE = 1;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{probe: string, label: string}} 設定
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
  if (values.probe === undefined) {
    throw new Error('--probe は必須です');
  }
  return { probe: values.probe, label: values.label ?? '[orientation]' };
}

/**
 * 観測結果を判定する。
 *
 * @param {any} result 観測結果
 * @returns {string[]} 不合格の理由（空なら合格）
 */
function judge(result) {
  /** @type {string[]} */
  const problems = [];
  const fail = (message) => problems.push(message);
  const json = (value) => JSON.stringify(value);

  // ── 前提 ─────────────────────────────────────────────────────────────
  for (const name of ['landscapeGranted', 'landscapeRefused', 'landscapeAbsent', 'portraitGranted', 'portraitRefused', 'square', 'noLayout']) {
    const steps = result?.[name];
    if (steps === undefined || steps === null) {
      fail(`前提: 段 ${name} の観測がありません。`);
      continue;
    }
    if (steps.error !== undefined) {
      fail(`前提: 段 ${name} の観測が途中で止まりました: ${steps.error}`);
    }
    if (steps.first?.opened !== true || steps.first?.state?.coarse !== true) {
      fail(`前提: 段 ${name} でタッチ端末の形の覆いが開きませんでした（opened=${json(steps.first?.opened)}, coarse=${json(steps.first?.state?.coarse)}）。`);
    }
    if (steps.first?.state?.stubError !== null && steps.first?.state?.stubError !== undefined) {
      fail(`前提: 段 ${name} で固定の API の差し替えが入っていません: ${steps.first.state.stubError}`);
    }
    if (Array.isArray(steps.exceptions) && steps.exceptions.length > 0) {
      fail(`前提: 段 ${name} でページの例外が出ました: ${json(steps.exceptions)}`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }

  // ── 1〜3: 横長・固定できる ─────────────────────────────────────────────────
  const granted = result.landscapeGranted;
  const first = granted.first.state;
  if (first.orientationAttribute !== 'landscape') {
    fail(`1: 横長の作品の覆いに data-orientation="landscape" がありません（${json(first.orientationAttribute)}）。`);
  }
  if (json(first.locks) !== json([{ orientation: 'landscape', fullscreen: 'overlay' }])) {
    fail(`1: 開いたときの固定が「全画面に入った後で landscape を 1 回」ではありません: ${json(first.locks)}`);
  }
  if (first.toggleShown !== true || json(first.toggleLabel) !== json(['縦向きにする'])) {
    fail(`1: 固定できたのに、ボタン「縦向きにする」が出ていません（shown=${json(first.toggleShown)}, label=${json(first.toggleLabel)}）。`);
  }
  if (!Array.isArray(first.toggleClasses) || !first.toggleClasses.includes('gf-button-tertiary')) {
    fail(`1: 向きのボタンが控えめのボタンの部品ではありません: ${json(first.toggleClasses)}`);
  }
  if (first.hintShown !== false) {
    fail('1: 固定できたのに、案内が出ています。');
  }
  const toggled = granted.afterToggle;
  if (granted.tappedToggle === null || toggled === undefined) {
    fail('2: 向きのボタンを押せませんでした。');
  } else {
    if (toggled.locks?.length !== 2 || toggled.locks[1]?.orientation !== 'portrait') {
      fail(`2: ボタンを押しても portrait で固定し直していません: ${json(toggled.locks)}`);
    }
    if (toggled.toggleShown !== true || json(toggled.toggleLabel) !== json(['横向きにする'])) {
      fail(`2: 入れ替えた後のボタンが「横向きにする」ではありません（shown=${json(toggled.toggleShown)}, label=${json(toggled.toggleLabel)}）。`);
    }
    if (toggled.memory !== 'portrait') {
      fail(`2: 入れ替えた向きを localStorage に覚えていません（${json(toggled.memory)}, ${json(toggled.memoryError)}）。`);
    }
  }
  if (granted.closedByButton?.reached !== true) {
    fail('3: 「閉じる」で覆いが閉じませんでした。');
  } else if (!(Number(granted.afterClose?.unlocks) >= 1)) {
    fail(`3: 「閉じる」で閉じたのに unlock() が呼ばれていません（${json(granted.afterClose?.unlocks)}）。`);
  }
  const second = granted.second;
  if (granted.reopened !== true || second === undefined) {
    fail('3: 閉じた後に開き直せませんでした。');
  } else {
    const last = Array.isArray(second.locks) ? second.locks[second.locks.length - 1] : undefined;
    if (last?.orientation !== 'portrait' || last?.fullscreen !== 'overlay') {
      fail(`3: 開き直したときに、覚えた向き（portrait）で全画面に入った後に固定していません: ${json(second.locks)}`);
    }
    if (second.toggleShown !== true || json(second.toggleLabel) !== json(['横向きにする'])) {
      fail(`3: 開き直したときのボタンが「横向きにする」ではありません（shown=${json(second.toggleShown)}, label=${json(second.toggleLabel)}）。`);
    }
    if (second.fullscreen !== 'overlay') {
      fail(`3: 開き直した覆いが全画面に入っていません（全画面の解除で閉じる経路を見られません。${json(second.fullscreen)}）。`);
    } else if (granted.closedByFullscreenExit?.reached !== true) {
      fail('3: 全画面の解除で覆いが閉じませんでした。');
    } else if (!(Number(granted.afterFullscreenExit?.unlocks) > Number(second.unlocks))) {
      fail(`3: 全画面の解除で閉じたのに unlock() が呼ばれていません（前 ${json(second.unlocks)} → 後 ${json(granted.afterFullscreenExit?.unlocks)}）。`);
    }
  }

  // ── 4: 横長・固定を拒む ────────────────────────────────────────────────────
  const refused = result.landscapeRefused;
  const refusedFirst = refused.first.state;
  if (json(refusedFirst.locks) !== json([{ orientation: 'landscape', fullscreen: 'overlay' }])) {
    fail(`4: 固定を拒む端末で、全画面に入った後に landscape の固定を試していません: ${json(refusedFirst.locks)}`);
  }
  if (refusedFirst.toggleShown !== false) {
    fail('4: 固定を拒まれたのに、向きのボタンが出ています。');
  }
  if (refusedFirst.portrait !== true || refusedFirst.hintShown !== true || refusedFirst.hintText !== '横にすると大きく遊べます') {
    fail(
      `4: 縦持ちで固定を拒まれたのに、案内「横にすると大きく遊べます」が出ていません（portrait=${json(refusedFirst.portrait)}, shown=${json(refusedFirst.hintShown)}, text=${json(refusedFirst.hintText)}）。`,
    );
  }
  if (refused.rotated?.portrait !== false || refused.rotated?.hintShown !== false) {
    fail(`4: 横持ちに回したのに、案内が消えていません（portrait=${json(refused.rotated?.portrait)}, shown=${json(refused.rotated?.hintShown)}）。`);
  }
  if (refused.rotatedBack?.portrait !== true || refused.rotatedBack?.hintShown !== true) {
    fail(`4: 縦持ちに戻したのに、案内がまた出ていません（portrait=${json(refused.rotatedBack?.portrait)}, shown=${json(refused.rotatedBack?.hintShown)}）。`);
  }
  if (refused.rotatedBack?.toggleShown !== false) {
    fail('4: 向きが変わった後に、向きのボタンが出ています。');
  }
  if (refused.closed?.reached !== true) {
    fail('4: 「閉じる」で覆いが閉じませんでした。');
  }

  // ── 5: 横長・API が無い ────────────────────────────────────────────────────
  const absent = result.landscapeAbsent.first.state;
  if (json(absent.locks) !== json([])) {
    fail(`5: 固定の API が無いのに、lock が呼ばれています: ${json(absent.locks)}`);
  }
  if (absent.toggleShown !== false || absent.hintShown !== true || absent.hintText !== '横にすると大きく遊べます') {
    fail(`5: 固定の API が無い端末の縦持ちで、ボタンを出さず案内を出す形になっていません（toggle=${json(absent.toggleShown)}, hint=${json(absent.hintShown)}）。`);
  }

  // ── 6: 縦長 ─────────────────────────────────────────────────────────────
  const portrait = result.portraitGranted.first.state;
  if (portrait.orientationAttribute !== 'portrait' || json(portrait.locks) !== json([{ orientation: 'portrait', fullscreen: 'overlay' }])) {
    fail(`6: 縦長の作品を portrait で固定していません（attribute=${json(portrait.orientationAttribute)}, locks=${json(portrait.locks)}）。`);
  }
  if (portrait.toggleShown !== true || json(portrait.toggleLabel) !== json(['横向きにする']) || portrait.hintShown !== false) {
    fail(`6: 縦長の作品を固定できたのに、ボタン「横向きにする」だけが出る形になっていません（label=${json(portrait.toggleLabel)}, hint=${json(portrait.hintShown)}）。`);
  }
  const portraitRefused = result.portraitRefused.first.state;
  if (portraitRefused.portrait !== false || portraitRefused.hintShown !== true || portraitRefused.hintText !== '縦にすると大きく遊べます' || portraitRefused.toggleShown !== false) {
    fail(
      `6: 縦長の作品を横持ちで開いて固定を拒まれたのに、案内「縦にすると大きく遊べます」だけが出る形になっていません（portrait=${json(portraitRefused.portrait)}, hint=${json(portraitRefused.hintShown)}, text=${json(portraitRefused.hintText)}, toggle=${json(portraitRefused.toggleShown)}）。`,
    );
  }

  // ── 7: 正方形・解像度が無い ─────────────────────────────────────────────────
  for (const name of ['square', 'noLayout']) {
    const steps = result[name];
    const state = steps.first.state;
    if (state.orientationAttribute !== null || state.toggleExists !== false || state.hintExists !== false) {
      fail(`7: ${name} の覆いに向きの属性・ボタン・案内があります（attribute=${json(state.orientationAttribute)}, toggle=${json(state.toggleExists)}, hint=${json(state.hintExists)}）。`);
    }
    if (json(state.locks) !== json([])) {
      fail(`7: ${name} で lock が呼ばれています: ${json(state.locks)}`);
    }
    if (steps.closed?.reached !== true) {
      fail(`7: ${name} で「閉じる」で覆いが閉じませんでした。`);
    } else if (steps.afterClose?.unlocks !== 0) {
      fail(`7: ${name} で閉じたときに unlock() が呼ばれています（向きの操作をしない作品。${json(steps.afterClose?.unlocks)}）。`);
    }
  }

  // ── 形: 縦持ち 390px の上の行が画面からはみ出さず、重ならない ─────────────────────────
  for (const [label, state, expected] of [
    ['固定できた（ボタン・切り替え・閉じる）', first, ['gf-play-orient-toggle', 'gf-play-pad-toggle', 'gf-play-close']],
    ['固定を拒まれた（案内・切り替え・閉じる）', refusedFirst, ['gf-play-orient-hint', 'gf-play-pad-toggle', 'gf-play-close']],
  ]) {
    const children = Array.isArray(state.barChildren) ? state.barChildren : [];
    for (const name of expected) {
      if (!children.some((child) => String(child.className).split(/\s+/u).includes(name))) {
        fail(`形: ${label} の上の行に ${name} が見えていません: ${json(children.map((child) => child.className))}`);
      }
    }
    if (!(Number(state.barScrollWidth) <= Number(state.barClientWidth) + TOLERANCE)) {
      fail(`形: ${label} の上の行が横にはみ出しています（scrollWidth=${json(state.barScrollWidth)}, clientWidth=${json(state.barClientWidth)}）。`);
    }
    for (const child of children) {
      const rect = child.rect;
      if (rect === null || rect.x < -TOLERANCE || rect.x + rect.width > state.viewport.width + TOLERANCE) {
        fail(`形: ${label} の ${child.className} が画面の横幅（${state.viewport.width}px）からはみ出しています: ${json(rect)}`);
      }
      if (Number(child.scrollWidth) > Number(child.clientWidth) + TOLERANCE) {
        fail(`形: ${label} の ${child.className} の中身が収まっていません（scrollWidth=${json(child.scrollWidth)}, clientWidth=${json(child.clientWidth)}）。`);
      }
    }
    for (let index = 0; index < children.length; index += 1) {
      for (let other = index + 1; other < children.length; other += 1) {
        const a = children[index].rect;
        const b = children[other].rect;
        if (
          a !== null &&
          b !== null &&
          a.x + a.width > b.x + TOLERANCE &&
          b.x + b.width > a.x + TOLERANCE &&
          a.y + a.height > b.y + TOLERANCE &&
          b.y + b.height > a.y + TOLERANCE
        ) {
          fail(`形: ${label} の ${children[index].className} と ${children[other].className} が重なっています: ${json([a, b])}`);
        }
      }
    }
  }
  return problems;
}

{
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = JSON.parse(readFileSync(options.probe, 'utf8'));
    const problems = judge(result);
    if (problems.length > 0) {
      for (const problem of problems) {
        process.stderr.write(`${options.label} ${problem}\n`);
      }
      process.exit(1);
    }
    process.stdout.write(`${options.label} OK: 横長は横向き・縦長は縦向きで固定し、固定できたときだけ入れ替えのボタンが出て覚え、閉じると外れます。固定できない端末は向きが合わないときだけ案内を出し、正方形と解像度の無い作品は何もしません。\n`);
  } catch (error) {
    process.stderr.write(`[orientation-verdict] 判定できませんでした: ${String(error)}\n`);
    process.exit(1);
  }
}
