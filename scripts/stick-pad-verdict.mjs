// stick-pad-verdict.mjs — 仮想パッドの方向の操作の形（スティック / 十字）と切り替えを判定する（層 9。#530 / 仕様 3.9.6）。
//
// `scripts/stick-pad-probe.mjs` の観測結果（JSON）を読み、issue #530 の acceptance と仕様 3.9.6 の「方向の操作の形」の決めごとを見る。
//
// | # | 見るもの |
// |---|---|
// | 前提 | どの作品でもタッチ端末の形（`pointer: coarse`）で覆いが開き、その iframe から起動の合図が届いた |
// | 1 | 横だけの作品は**スティック**で出る（十字は隠れ、切り替えは「十字にする」）。スティックの左右が ←→ の押下・離しとして届き、**上下に倒しても ↑↓ は送られない**。↑ は右のボタンに出て、押すと届く。触れているあいだだけ円を描く |
// | 2 | 8 方向の作品は**スティック**で出る。右上が ↑ と → の同時押しとして届き、**方向を変えると外れたキーの keyup が加わったキーの keydown より先に届く**。離すと押しているキーがすべて離れる |
// | 3 | 十字の作品（4 方向とも J）は**十字**で出る（切り替えは「スティックにする」） |
// | 4 | 版 1 の行（`held_codes` が NULL）の作品は**十字**で出る。行が無い作品はパッドも切り替えも出ない |
// | 5 | 切り替えで形が変わり（十字の ← が効く）、覚えた値が `localStorage` に入り、**文書を開き直すと覚えた形で出る**。`localStorage` が使えない状態でも推定した形で出て、切り替えが効き、ページの例外が出ない |
// | 7 | **Space と同じ条件式で読む ↑ は右のボタンに出ない**（#543。見えているキーは Space だけで、押すと Space が届く） |
// | 8 | **Space と別の条件式で読む ↑↓ は右のボタンに出る**（#543。ケロケロ舌合戦型。Space・Z・↑・↓ が見え、↑ と ↓ が届く） |
// | 6 | スティックを倒したまま右のボタン（Space）を押す同時押しが届く。スティックを倒したまま隠れる（`visibilitychange`）・閉じると keyup が届き、その後に倒し直しても離しても何も届かない |
// | 形 | 見えているキーは 48px 以上。切り替えは控えめのボタンの部品。縦持ちはゲームの下の左にスティック・右にボタン、横持ちはゲームの左にスティック・右にボタン。触れた位置が円の中心で、つまみは倒した向きにある |
//
// **どのキーをどの形に出すかの規則はここへ書き写さない。** 規則は `src/virtual-pad.ts` の単体テストが見る。ここは、検査用に仕込んだ
// 3 つの読み方（横だけ・8 方向・十字）と、同じ条件式で読むキーの組の 2 つ（Space と同じ組・別の組。#543）が、それぞれの形とキーとして
// 実ブラウザで届くことを見る。
//
// 使い方:
//   node scripts/stick-pad-verdict.mjs --probe <json> --label <prefix>
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';

/** 押せる大きさの下限（CSS ピクセル。仕様 3.9.6）。 */
const MIN_KEY_SIZE = 48;

/** 矩形の比較で許す差（CSS ピクセル）。 */
const TOLERANCE = 2;

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
  if (values['probe'] === undefined) {
    throw new Error('--probe は必須です');
  }
  return { probe: values['probe'], label: values['label'] ?? '[stick-pad]' };
}

/**
 * 並びが期待と同じか。
 *
 * @param {any} actual 観測した `type:code` の並び
 * @param {string[]} expected 期待する並び
 * @returns {boolean} 同じか
 */
function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * 並びを比べ、違えば理由を足す。
 *
 * @param {string[]} problems 理由の置き場所
 * @param {string} what 何を見たか
 * @param {any} actual 観測した並び
 * @param {string[]} expected 期待する並び
 * @param {string} [hint] 違ったときの手がかり
 */
function expectSequence(problems, what, actual, expected, hint = '') {
  if (!same(actual, expected)) {
    problems.push(`${what}: 作品が受けたキーが ${JSON.stringify(expected)} ではありません（${JSON.stringify(actual ?? null)}）。${hint}`);
  }
}

/**
 * 見えているキーの `code` の並び（置き場所つき）。
 *
 * @param {any} state 状態
 * @returns {string[]} `place:code`
 */
function visibleKeys(state) {
  return (state?.keys ?? []).map((key) => `${String(key.place)}:${String(key.code)}`);
}

/**
 * 最初の形を見る。
 *
 * @param {string[]} problems 理由の置き場所
 * @param {string} name 作品の名前
 * @param {any} state 状態
 * @param {'stick' | 'dpad'} shape 期待する形
 */
function expectShape(problems, name, state, shape) {
  const stickShown = state?.stickShown === true;
  const dpadShown = state?.dpadShown === true;
  const label = shape === 'stick' ? '十字にする' : 'スティックにする';
  if (shape === 'stick' ? !stickShown || dpadShown : stickShown || !dpadShown) {
    problems.push(
      `${name}: ${shape === 'stick' ? 'スティック' : '十字'}で出ていません（スティック=${String(state?.stickShown)}・十字=${String(state?.dpadShown)}、` +
        `推定=${String(state?.estimated)}、覚えた値=${String(state?.remembered)}）。`,
    );
  }
  if (state?.toggleShown !== true || state?.toggleLabel !== label) {
    problems.push(`${name}: 切り替えのボタンが「${label}」で出ていません（見える=${String(state?.toggleShown)}、文言=${JSON.stringify(state?.toggleLabel ?? null)}）。`);
  }
  if (!state?.toggleClasses?.includes('gf-button') || !state?.toggleClasses?.includes('gf-button-tertiary')) {
    problems.push(`${name}: 切り替えのボタンが控えめのボタンの部品（gf-button gf-button-tertiary）を持ちません（${JSON.stringify(state?.toggleClasses ?? null)}）。仕様 2.5.5。`);
  }
  for (const key of state?.keys ?? []) {
    if (!(key.rect?.width >= MIN_KEY_SIZE - 1 && key.rect?.height >= MIN_KEY_SIZE - 1)) {
      problems.push(`${name}: ${String(key.code)} の押せる大きさが ${MIN_KEY_SIZE}px に届きません（${JSON.stringify(key.rect)}）。`);
    }
  }
}

/**
 * 前提（覆いが開き、合図が届いた）を見る。
 *
 * @param {string[]} problems 理由の置き場所
 * @param {string} name 作品の名前
 * @param {any} part 観測
 * @returns {boolean} 前提が成り立ったか
 */
function opened(problems, name, part) {
  if (typeof part?.error === 'string') {
    problems.push(`${name}の観測が途中で止まりました: ${part.error}`);
  }
  if (part?.opened?.reached !== true || part?.opened?.state?.coarse !== true) {
    problems.push(`前提: ${name}で、タッチ端末の形で覆いが開いて起動の合図が届く状態になりませんでした。最後の状態: ${JSON.stringify(part?.opened?.state ?? null)}`);
    return false;
  }
  return true;
}

/**
 * 観測結果を判定する。
 *
 * @param {any} result 観測結果
 * @returns {string[]} 不合格の理由（空なら合格）
 */
function problemsOf(result) {
  /** @type {string[]} */
  const problems = [];

  // ── 1. 横だけの作品 ────────────────────────────────────────────────────────
  const horizontal = result.horizontal ?? {};
  if (opened(problems, '横だけの作品', horizontal)) {
    const initial = horizontal.initial;
    expectShape(problems, '1: 横だけの作品', initial, 'stick');
    if (!same(visibleKeys(initial), ['buttons:Space', 'buttons:ArrowUp'])) {
      problems.push(`1: 横だけの作品で、見えているキーが右のボタンの Space と ↑ ではありません（${JSON.stringify(visibleKeys(initial))}）。仕様 3.9.6 の規則 5。`);
    }
    const axis = horizontal.axis ?? {};
    expectSequence(problems, '1: スティックに触れただけ', axis.touch, []);
    expectSequence(problems, '1: スティックを右へ倒す', axis.right, ['keydown:ArrowRight']);
    expectSequence(
      problems,
      '1: 右から上へ倒し直す',
      axis.up,
      ['keyup:ArrowRight'],
      ' 横だけの作品のスティックは縦の成分を捨て、↑ を送らないはずです（軸の制限）。',
    );
    expectSequence(problems, '1: 上から左へ倒し直す', axis.left, ['keydown:ArrowLeft']);
    expectSequence(problems, '1: 左から下へ倒し直す', axis.down, ['keyup:ArrowLeft'], ' ↓ を送らないはずです（軸の制限）。');
    expectSequence(problems, '1: 右上へ倒す', axis.upRight, ['keydown:ArrowRight'], ' 横の成分の → だけを送るはずです（軸の制限）。');
    expectSequence(problems, '1: スティックから指を離す', axis.lift, ['keyup:ArrowRight']);
    if (axis.ringWhileTouching !== true || axis.ringAfterLift !== false) {
      problems.push(`1: 円が触れているあいだだけ描かれていません（触れている=${String(axis.ringWhileTouching)}、離した後=${String(axis.ringAfterLift)}）。`);
    }
    expectSequence(problems, '1: 右のボタンの ↑ を押す', horizontal.upButton?.down, ['keydown:ArrowUp']);
    expectSequence(problems, '1: 右のボタンの ↑ を離す', horizontal.upButton?.up, ['keyup:ArrowUp']);

    // ── 6. 同時押し・隠れる・閉じる ─────────────────────────────────────────
    const chord = horizontal.chord ?? {};
    expectSequence(problems, '6: 同時押しの前にスティックを右へ倒す', chord.stickRight, ['keydown:ArrowRight']);
    expectSequence(problems, '6: スティックを倒したまま Space を押す', chord.spaceDown, ['keydown:Space'], ' スティックとボタンは別の指（pointerId）で同時に押せるはずです。');
    expectSequence(problems, '6: Space を離す（スティックは倒したまま）', chord.spaceUp, ['keyup:Space']);
    expectSequence(problems, '6: スティックを離す', chord.stickLift, ['keyup:ArrowRight']);
    const hide = horizontal.hide ?? {};
    expectSequence(problems, '6: 隠れる前にスティックを右へ倒す', hide.stickRight, ['keydown:ArrowRight']);
    if (hide.visibility === undefined) {
      problems.push('6 の前提: 親の文書で visibilitychange を起こせませんでした。');
    }
    expectSequence(problems, '6: スティックを倒したまま隠れる', hide.hidden, ['keyup:ArrowRight'], ' 親の releasePad がスティックも離して release を送るはずです。');
    expectSequence(problems, '6: 隠れた後にスティックを倒し直す', hide.moveAfter, [], ' 離した指の後の pointermove は何も送らないはずです。');
    expectSequence(problems, '6: 隠れた後にスティックから指を離す', hide.liftAfter, []);
    const close = horizontal.close ?? {};
    expectSequence(problems, '6: 閉じる前にスティックを右へ倒す', close.stickRight, ['keydown:ArrowRight']);
    if (close.closed?.reached !== true) {
      problems.push(`6: 「閉じる」で覆いが閉じませんでした。最後の状態: ${JSON.stringify(close.closed?.state ?? null)}`);
    } else {
      expectSequence(problems, '6: スティックを倒したまま閉じる', close.whileHeld, ['keyup:ArrowRight']);
      expectSequence(problems, '6: 閉じた後にスティックから指を離す', close.liftAfter, []);
    }

    // ── 5. 切り替え・覚えた形 ──────────────────────────────────────────────
    const toggle = horizontal.toggle ?? {};
    if (toggle.reopened?.reached !== true || toggle.tapped !== true) {
      problems.push(`5 の前提: 開き直して切り替えのボタンを押せませんでした（開いた=${String(toggle.reopened?.reached)}、押せた=${String(toggle.tapped)}）。`);
    } else {
      expectShape(problems, '5: 切り替える前', toggle.before, 'stick');
      expectShape(problems, '5: 切り替えた後', toggle.after, 'dpad');
      if (!same(visibleKeys(toggle.after), ['dpad:ArrowUp', 'dpad:ArrowLeft', 'dpad:ArrowRight', 'buttons:Space'])) {
        problems.push(`5: 十字にした後の見えているキーが、十字の ↑←→ と Space ではありません（${JSON.stringify(visibleKeys(toggle.after))}）。↑ のボタンはスティックの形でだけ出すはずです。`);
      }
      if (toggle.after?.remembered !== 'dpad') {
        problems.push(`5: 切り替えた形が localStorage に覚えられていません（${JSON.stringify(toggle.after?.remembered ?? null)}）。`);
      }
      expectSequence(problems, '5: 十字にした後に十字の ← を押す', toggle.dpadLeft?.down, ['keydown:ArrowLeft']);
      expectSequence(problems, '5: 十字にした後に十字の ← を離す', toggle.dpadLeft?.up, ['keyup:ArrowLeft']);
    }
    const reload = horizontal.reload ?? {};
    if (reload.opened?.reached !== true) {
      problems.push(`5 の前提: 文書を開き直して覆いを開けませんでした。最後の状態: ${JSON.stringify(reload.opened?.state ?? null)}`);
    } else {
      if (reload.state?.estimated !== 'stick') {
        problems.push(`5 の前提: 開き直した文書の推定がスティックではありません（${String(reload.state?.estimated)}）。`);
      }
      expectShape(problems, '5: 文書を開き直した後（覚えた十字が推定のスティックより優先するはず）', reload.state, 'dpad');
    }
    if ((horizontal.exceptions ?? []).length > 0) {
      problems.push(`5: 横だけの作品のページで例外が出ました（${JSON.stringify(horizontal.exceptions)}）。`);
    }
  }

  const noStorage = result.noStorage ?? {};
  if (opened(problems, 'localStorage が使えない状態の横だけの作品', noStorage)) {
    if (noStorage.initial?.remembered !== 'unavailable') {
      problems.push(`5 の前提: localStorage が使えない状態になっていません（${JSON.stringify(noStorage.initial?.remembered ?? null)}）。`);
    }
    expectShape(problems, '5: localStorage が使えない状態（推定したスティックで出るはず）', noStorage.initial, 'stick');
    if (noStorage.tapped !== true) {
      problems.push('5: localStorage が使えない状態で、切り替えのボタンを押せませんでした。');
    } else {
      expectShape(problems, '5: localStorage が使えない状態で切り替えた後', noStorage.afterToggle, 'dpad');
      expectShape(problems, '5: localStorage が使えない状態でもう一度切り替えた後', noStorage.afterToggleBack, 'stick');
    }
    if ((noStorage.exceptions ?? []).length > 0) {
      problems.push(`5: localStorage が使えない状態で、ページの例外が出ました（${JSON.stringify(noStorage.exceptions)}）。読み書きの失敗は握りつぶすはずです。`);
    }
  }

  // ── 2. 8 方向の作品 ────────────────────────────────────────────────────────
  const eight = result.eight ?? {};
  if (opened(problems, '8 方向の作品', eight)) {
    expectShape(problems, '2: 8 方向の作品', eight.initial, 'stick');
    if (!same(visibleKeys(eight.initial), ['buttons:Space'])) {
      problems.push(`2: 8 方向の作品で、見えているキーが右のボタンの Space だけではありません（${JSON.stringify(visibleKeys(eight.initial))}）。`);
    }
    expectSequence(problems, '2: スティックに触れただけ', eight.touch, []);
    expectSequence(problems, '2: 右上へ倒す', eight.upRight, ['keydown:ArrowUp', 'keydown:ArrowRight'], ' 斜めの扇では 2 つのキーを押すはずです。');
    expectSequence(
      problems,
      '2: 右上から左へ倒し直す',
      eight.left,
      ['keyup:ArrowUp', 'keyup:ArrowRight', 'keydown:ArrowLeft'],
      ' 外れたキーの up を先に、加わったキーの down を後に送るはずです（仕様 3.9.6 の「送り方」）。',
    );
    expectSequence(problems, '2: 左から左上へ倒し直す', eight.upLeft, ['keydown:ArrowUp'], ' 変わらないキー（←）は送り直さないはずです。');
    expectSequence(
      problems,
      '2: 左上から右上へ倒し直す',
      eight.upRightAgain,
      ['keyup:ArrowLeft', 'keydown:ArrowRight'],
      ' 外れたキーの up を先に送るはずです。',
    );
    expectSequence(problems, '2: スティックから指を離す', eight.lift, ['keyup:ArrowUp', 'keyup:ArrowRight']);
  }

  // ── 3 / 4. 十字の作品・版 1 の行・行が無い作品 ─────────────────────────────
  const dpad = result.dpad ?? {};
  if (opened(problems, '十字の作品', dpad)) {
    expectShape(problems, '3: 十字の作品（4 方向とも J）', dpad.initial, 'dpad');
    if (dpad.initial?.estimated !== 'dpad') {
      problems.push(`3: 十字の作品の推定が十字ではありません（${String(dpad.initial?.estimated)}）。`);
    }
  }
  const v1 = result.v1 ?? {};
  if (opened(problems, '版 1 の行の作品', v1)) {
    expectShape(problems, '4: 版 1 の行の作品（held_codes が NULL）', v1.initial, 'dpad');
    if (v1.initial?.estimated !== 'dpad') {
      problems.push(`4: 版 1 の行の作品の推定が十字ではありません（${String(v1.initial?.estimated)}）。`);
    }
  }
  const noRow = result.noRow ?? {};
  if (opened(problems, '行が無い作品', noRow)) {
    const state = noRow.initial;
    if ((state?.keys ?? []).length !== 0 || state?.stickShown !== false || state?.dpadShown !== false || state?.toggleShown !== false || state?.estimated !== null) {
      problems.push(
        `4: 行が無い作品で、パッドか切り替えが出ています（キー ${JSON.stringify(visibleKeys(state))}、スティック=${String(state?.stickShown)}、` +
          `十字=${String(state?.dpadShown)}、切り替え=${String(state?.toggleShown)}、推定=${String(state?.estimated)}）。`,
      );
    }
  }

  // ── 7 / 8. 同じ働きの方向をボタンに出さない（#543）──────────────────────────
  const alias = result.alias ?? {};
  if (opened(problems, 'Space と同じ組の作品', alias)) {
    expectShape(problems, '7: Space と同じ組の作品', alias.initial, 'stick');
    if (!same(visibleKeys(alias.initial), ['buttons:Space'])) {
      problems.push(
        `7: Space と同じ条件式で読む ↑ の作品で、見えているキーが右のボタンの Space だけではありません（${JSON.stringify(visibleKeys(alias.initial))}）。` +
          '仕様 3.9.6 の #543: すでにボタンに出るキーと同じ組の方向は出さないはずです。',
      );
    }
    expectSequence(problems, '7: 右のボタンの Space を押す', alias.presses?.Space?.down, ['keydown:Space']);
    expectSequence(problems, '7: 右のボタンの Space を離す', alias.presses?.Space?.up, ['keyup:Space']);
    if (alias.presses?.ArrowUp !== null) {
      problems.push(`7: Space と同じ組の作品で、右のボタンの ↑ が見えていて押せました（${JSON.stringify(alias.presses?.ArrowUp ?? null)}）。`);
    }
    if ((alias.exceptions ?? []).length > 0) {
      problems.push(`7: Space と同じ組の作品のページで例外が出ました（${JSON.stringify(alias.exceptions)}）。`);
    }
  }
  const separate = result.separate ?? {};
  if (opened(problems, 'Space と別の組の作品', separate)) {
    expectShape(problems, '8: Space と別の組の作品', separate.initial, 'stick');
    if (!same(visibleKeys(separate.initial), ['buttons:Space', 'buttons:KeyZ', 'buttons:ArrowUp', 'buttons:ArrowDown'])) {
      problems.push(
        `8: Space と別の条件式で読む ↑↓ の作品で、見えているキーが右のボタンの Space・Z・↑・↓ ではありません（${JSON.stringify(visibleKeys(separate.initial))}）。` +
          '別の働きの方向はボタンに残るはずです（ケロケロ舌合戦の上段・下段）。',
      );
    }
    expectSequence(problems, '8: 右のボタンの ↑ を押す', separate.presses?.ArrowUp?.down, ['keydown:ArrowUp']);
    expectSequence(problems, '8: 右のボタンの ↑ を離す', separate.presses?.ArrowUp?.up, ['keyup:ArrowUp']);
    expectSequence(problems, '8: 右のボタンの ↓ を押す', separate.presses?.ArrowDown?.down, ['keydown:ArrowDown']);
    expectSequence(problems, '8: 右のボタンの ↓ を離す', separate.presses?.ArrowDown?.up, ['keyup:ArrowDown']);
    if ((separate.exceptions ?? []).length > 0) {
      problems.push(`8: Space と別の組の作品のページで例外が出ました（${JSON.stringify(separate.exceptions)}）。`);
    }
  }

  // ── 形: 並べ方と、触れている状態の描画（撮影と同じ手順）─────────────────────
  for (const [name, shots] of [
    ['横だけの作品', result.shots?.horizontal],
    ['8 方向の作品', result.shots?.eight],
  ]) {
    if (typeof shots?.error === 'string') {
      problems.push(`形: ${name}の撮影の手順が途中で止まりました: ${shots.error}`);
      continue;
    }
    for (const orientation of ['portrait', 'landscape']) {
      const shot = shots?.[orientation];
      const where = `形: ${name}の${orientation === 'portrait' ? '縦持ち' : '横持ち'}`;
      const state = shot?.state;
      if (typeof shot?.error === 'string' || !state?.stickRect || !state?.stageRect || !state?.buttonsRect) {
        problems.push(`${where}で、スティック・ゲーム・ボタンの矩形を観測できていません（${JSON.stringify(shot ?? null)}）。`);
        continue;
      }
      const stick = state.stickRect;
      const stage = state.stageRect;
      const buttons = state.buttonsRect;
      if (orientation === 'portrait') {
        if (!(stick.y >= stage.y + stage.height - TOLERANCE && buttons.y >= stage.y + stage.height - TOLERANCE)) {
          problems.push(`${where}で、スティックとボタンがゲームの下にありません（ゲーム ${JSON.stringify(stage)} / スティック ${JSON.stringify(stick)} / ボタン ${JSON.stringify(buttons)}）。`);
        }
        if (!(stick.x + stick.width <= buttons.x + TOLERANCE)) {
          problems.push(`${where}で、スティックがボタンの左にありません（スティック ${JSON.stringify(stick)} / ボタン ${JSON.stringify(buttons)}）。`);
        }
      } else {
        if (!(stick.x + stick.width <= stage.x + TOLERANCE)) {
          problems.push(`${where}で、スティックがゲームの左にありません（スティック ${JSON.stringify(stick)} / ゲーム ${JSON.stringify(stage)}）。`);
        }
        if (!(buttons.x >= stage.x + stage.width - TOLERANCE)) {
          problems.push(`${where}で、ボタンがゲームの右にありません（ボタン ${JSON.stringify(buttons)} / ゲーム ${JSON.stringify(stage)}）。`);
        }
      }
      if (!(stick.width >= MIN_KEY_SIZE * 2 && stick.height >= MIN_KEY_SIZE * 2)) {
        problems.push(`${where}で、スティックの受け付ける範囲が小さすぎます（${JSON.stringify(stick)}）。`);
      }
      if (state.ringShown !== true || shot.ringAfterLift !== false || !shot.knob || !shot.center) {
        problems.push(`${where}で、触れているあいだの円が描かれていないか、離しても残っています（${JSON.stringify({ ring: state.ringShown, after: shot.ringAfterLift })}）。`);
        continue;
      }
      if (Math.abs(shot.knob.ring.x - shot.center.x) > TOLERANCE || Math.abs(shot.knob.ring.y - shot.center.y) > TOLERANCE) {
        problems.push(`${where}で、円の中心が触れた位置にありません（円 ${JSON.stringify(shot.knob.ring)} / 触れた位置 ${JSON.stringify(shot.center)}）。`);
      }
      const knobDx = shot.knob.knob.x - shot.knob.ring.x;
      const knobDy = shot.knob.knob.y - shot.knob.ring.y;
      const radius = shot.knob.ring.width / 2;
      if (Math.hypot(knobDx, knobDy) > radius + TOLERANCE || Math.hypot(knobDx, knobDy) < radius / 2) {
        problems.push(`${where}で、つまみが倒した向きに描かれていません（中心からのずれ ${knobDx.toFixed(1)}, ${knobDy.toFixed(1)} / 半径 ${radius}）。`);
      }
    }
  }
  return problems;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = JSON.parse(readFileSync(args.probe, 'utf8'));
  const problems = problemsOf(result);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${args.label} ${problem}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `${args.label} OK: 横だけの作品はスティック（上下を送らず ↑ は右のボタン）、8 方向の作品は斜めの同時押しで外れたキーを先に離し、` +
      '十字の作品と版 1 の行は十字、行が無い作品は何も出ません。切り替えは覚えた形で開き直し、localStorage が使えなくても推定で出ます。' +
      'スティックとボタンの同時押し、隠れる・閉じると離れます。Space と同じ条件式で読む ↑ は右のボタンに出ず、別の条件式の ↑↓ は出て届きます。\n',
  );
} catch (error) {
  process.stderr.write(`[stick-pad] 判定できませんでした: ${String(error)}\n`);
  process.exit(1);
}
