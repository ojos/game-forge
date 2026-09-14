// virtual-pad-verdict.mjs — 作品ページの仮想パッドを判定する（層 8。#494 / 仕様 3.9.6 / 3.9.7）。
//
// `scripts/virtual-pad-probe.mjs` の観測結果（JSON）を読み、issue #494 の acceptance と仕様 3.9.6 / 3.9.7 の決めごとを見る。
//
// | # | 見るもの |
// |---|---|
// | 前提 | タッチ端末の形で `pointer: coarse`、デスクトップの形で `pointer: coarse` でない。覆いが開き、その iframe から起動の合図が届いた |
// | 形 | パッドのキーは `<button type="button">` で副のボタンの部品を持ち、1 つ 48px 以上（縦持ち・横持ち）。十字のキーは読み上げの名前を持つ。出したキーは保存したキーの集合の中だけ。縦持ちはゲームの下に左から十字・ボタン、横持ちはゲームの左に十字・右にボタン。置き場所は `user-select: none` |
// | 1 | パッドへのタッチが、キーの押下と離しとして作品へ届く（`keydown` → `keyup`。`code` だけで `key` は空、`repeat` は false）。押しているあいだフォーカスはパッドへ移らない |
// | 2 | 同時押し（左を押したまま Space）が、離しを挟まずに 2 つの押下として届き、離した指のキーだけが離れる |
// | 3 | 許可表に無いキー名・形の違うメッセージ（親から）、親と同じオリジンの別の iframe から、直接開いたローダーの自己送信は、どれも作品へ届かない。**対照として、親から送った許可表のキーは届き、2 回目の down / up は重ならない** |
// | 4 | デスクトップでは覆いが開かず、パッドのキーは表示されず、作品へキーが届かない |
// | 5 | 押したまま `window` の `blur` で、iframe を残したまま `keyup` が届き（親の release）、その後に指を離しても何も届かない。押したまま覆いを閉じると `keyup` が届き、閉じた後に指を離しても何も届かない |
// | 6 | キーの集合が空の作品では、パッドの置き場所が空で、ゲームの領域が覆いの残りいっぱいを使う |
//
// **表示規則（どのキーをどこに出すか）はここへ書き写さない。** 規則は `src/virtual-pad.ts` の単体テストが見る。ここは、出したキーが
// 保存した集合の中にあること（`--codes`）と、観測に使う ArrowLeft / ArrowRight / Space があることだけを見る。
//
// 使い方:
//   node scripts/virtual-pad-verdict.mjs --probe <json> --codes <保存したキーの JSON 配列> --label <prefix>
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';

/** 押せる大きさの下限（CSS ピクセル。仕様 3.9.6）。 */
const MIN_KEY_SIZE = 48;

/** 矩形の比較で許す差（CSS ピクセル）。 */
const TOLERANCE = 1;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{probe: string, codes: string[], label: string}} 設定
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
  if (values['probe'] === undefined || values['codes'] === undefined) {
    throw new Error('--probe と --codes は必須です');
  }
  const codes = JSON.parse(values['codes']);
  if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string')) {
    throw new Error(`--codes は文字列の JSON 配列です: ${values['codes']}`);
  }
  return { probe: values['probe'], codes, label: values['label'] ?? '[virtual-pad]' };
}

/**
 * 作品が受けたキーを `type:code` の並びにする（比べやすくする）。
 *
 * @param {any} events 受けたキー
 * @returns {string[] | null} 並び（配列でなければ null）
 */
function sequenceOf(events) {
  return Array.isArray(events) ? events.map((event) => `${String(event?.type)}:${String(event?.code)}`) : null;
}

/**
 * 並びが期待と同じか。
 *
 * @param {any} events 受けたキー
 * @param {string[]} expected 期待する `type:code` の並び
 * @returns {boolean} 同じか
 */
function sameSequence(events, expected) {
  return JSON.stringify(sequenceOf(events)) === JSON.stringify(expected);
}

/**
 * 観測結果を判定する。
 *
 * @param {any} result 観測結果
 * @param {string[]} storedCodes 保存したキーの集合
 * @returns {string[]} 不合格の理由（空なら合格）
 */
function problemsOf(result, storedCodes) {
  /** @type {string[]} */
  const problems = [];
  const touch = result.touch ?? {};
  const direct = result.direct ?? {};
  const desktop = result.desktop ?? {};
  const empty = result.empty ?? {};
  for (const [name, part] of [
    ['タッチ端末', touch],
    ['直接開いたローダー', direct],
    ['デスクトップ', desktop],
    ['キーの集合が空の作品', empty],
  ]) {
    if (typeof part.error === 'string') {
      problems.push(`${name}の観測が途中で止まりました: ${part.error}`);
    }
  }

  // ── 前提 ──────────────────────────────────────────────────────────────────
  if (touch.opened?.reached !== true || touch.portrait?.coarse !== true) {
    problems.push(
      `前提: タッチ端末の形で覆いが開いて起動の合図が届く状態になりませんでした（pointer: coarse=${String(touch.portrait?.coarse)}）。` +
        ` 最後の状態: ${JSON.stringify(touch.opened?.state ?? null)}`,
    );
    return problems;
  }

  // ── 形 ────────────────────────────────────────────────────────────────────
  for (const [name, state] of [
    ['縦持ち', touch.portrait],
    ['横持ち', touch.landscape],
  ]) {
    const keys = state?.keys ?? [];
    if (keys.length === 0) {
      problems.push(`形: ${name}でパッドのキーが 1 つもありません。`);
      continue;
    }
    for (const key of keys) {
      const where = `${name}の ${String(key.code)}`;
      if (key.tag !== 'BUTTON' || key.type !== 'button') {
        problems.push(`形: ${where} が <button type="button"> ではありません（${String(key.tag)} / ${String(key.type)}）。`);
      }
      if (!key.classes?.includes('gf-button') || !key.classes?.includes('gf-button-secondary')) {
        problems.push(`形: ${where} が副のボタンの部品（gf-button gf-button-secondary）を持ちません（${JSON.stringify(key.classes)}）。仕様 2.5.5。`);
      }
      if (!(key.rect?.width >= MIN_KEY_SIZE - TOLERANCE && key.rect?.height >= MIN_KEY_SIZE - TOLERANCE)) {
        problems.push(`形: ${where} の押せる大きさが ${MIN_KEY_SIZE}px に届きません（${JSON.stringify(key.rect)}）。`);
      }
      if (!storedCodes.includes(key.code)) {
        problems.push(`形: ${where} は保存したキーの集合にありません（${JSON.stringify(storedCodes)}）。`);
      }
      if (key.place === 'dpad' && (typeof key.ariaLabel !== 'string' || key.ariaLabel === '')) {
        problems.push(`形: ${where} は十字のキーなのに読み上げの名前（aria-label）がありません。`);
      }
      if (key.place === 'other') {
        problems.push(`形: ${where} がパッドの置き場所（十字・ボタン）の外にあります。`);
      }
    }
    if (state.padUserSelect !== 'none') {
      problems.push(`形: ${name}でパッドの置き場所が user-select: none ではありません（${String(state.padUserSelect)}）。`);
    }
  }
  const portrait = touch.portrait;
  if (portrait?.stageRect && portrait?.dpadRect && portrait?.buttonsRect) {
    const stageBottom = portrait.stageRect.y + portrait.stageRect.height;
    if (!(portrait.dpadRect.y >= stageBottom - TOLERANCE && portrait.buttonsRect.y >= stageBottom - TOLERANCE)) {
      problems.push(`形: 縦持ちでパッドがゲームの下にありません（ゲーム ${JSON.stringify(portrait.stageRect)} / 十字 ${JSON.stringify(portrait.dpadRect)} / ボタン ${JSON.stringify(portrait.buttonsRect)}）。`);
    }
    if (!(portrait.dpadRect.x + portrait.dpadRect.width <= portrait.buttonsRect.x + TOLERANCE)) {
      problems.push(`形: 縦持ちで十字がボタンの左にありません（十字 ${JSON.stringify(portrait.dpadRect)} / ボタン ${JSON.stringify(portrait.buttonsRect)}）。`);
    }
  } else {
    problems.push('形: 縦持ちのゲームの領域とパッドを観測できていません。');
  }
  const landscape = touch.landscape;
  if (landscape?.stageRect && landscape?.dpadRect && landscape?.buttonsRect) {
    if (!(landscape.dpadRect.x + landscape.dpadRect.width <= landscape.stageRect.x + TOLERANCE)) {
      problems.push(`形: 横持ちで十字がゲームの左にありません（十字 ${JSON.stringify(landscape.dpadRect)} / ゲーム ${JSON.stringify(landscape.stageRect)}）。`);
    }
    if (!(landscape.buttonsRect.x >= landscape.stageRect.x + landscape.stageRect.width - TOLERANCE)) {
      problems.push(`形: 横持ちでボタンがゲームの右にありません（ボタン ${JSON.stringify(landscape.buttonsRect)} / ゲーム ${JSON.stringify(landscape.stageRect)}）。`);
    }
  } else {
    problems.push('形: 横持ちのゲームの領域とパッドを観測できていません。');
  }
  if (!sameSequence(touch.keysOnOpen, [])) {
    problems.push(`形: 覆いを開いただけで作品へキーが届きました（${JSON.stringify(sequenceOf(touch.keysOnOpen))}）。`);
  }

  // ── 1. タッチがキーとして届く ────────────────────────────────────────────────
  if (!sameSequence(touch.tapLeftDown, ['keydown:ArrowLeft'])) {
    problems.push(
      `1: 左のキーに触れても、作品へ keydown ArrowLeft が 1 つだけ届きませんでした（${JSON.stringify(sequenceOf(touch.tapLeftDown))}）。` +
        ' パッドの送信（src/work-play.ts）か、ローダーの受け手（src/sandbox-loader.ts）が効いていません。',
    );
  }
  if (!sameSequence(touch.tapLeftUp, ['keyup:ArrowLeft'])) {
    problems.push(`1: 左のキーから指を離しても、作品へ keyup ArrowLeft が 1 つだけ届きませんでした（${JSON.stringify(sequenceOf(touch.tapLeftUp))}）。`);
  }
  if (JSON.stringify(touch.heldWhileLeft) !== JSON.stringify(['ArrowLeft'])) {
    problems.push(`1: 押しているあいだ、押しているキーだけに印（gf-play-pad-held）が付いていません（${JSON.stringify(touch.heldWhileLeft)}）。`);
  }
  if (touch.focusWhileLeft !== false) {
    problems.push('1: パッドを押すとフォーカスがパッドへ移りました（pointerdown で preventDefault を呼んでいない。仕様 3.9.6）。');
  }
  const allKeys = (touch.allKeyEvents ?? []).map((event) => event.entry);
  for (const entry of [...allKeys, ...(Array.isArray(direct.keyLog) ? direct.keyLog : [])]) {
    if (entry?.isTrusted !== false || entry?.repeat !== false || entry?.key !== '') {
      problems.push(`1: 作品が受けたキーの形が合成したイベントの形ではありません（${JSON.stringify(entry)}。isTrusted=false・repeat=false・key が空のはず）。`);
      break;
    }
  }

  // ── 2. 同時押し ────────────────────────────────────────────────────────────
  const chord = touch.chord ?? {};
  if (
    !sameSequence(chord.leftDown, ['keydown:ArrowLeft']) ||
    !sameSequence(chord.spaceDown, ['keydown:Space']) ||
    !sameSequence(chord.spaceUp, ['keyup:Space']) ||
    !sameSequence(chord.leftUp, ['keyup:ArrowLeft'])
  ) {
    problems.push(
      '2: 左を押したまま Space を押し、Space・左の順に離したときの届き方が違います' +
        `（左を押す ${JSON.stringify(sequenceOf(chord.leftDown))} / Space を押す ${JSON.stringify(sequenceOf(chord.spaceDown))} / ` +
        `Space を離す ${JSON.stringify(sequenceOf(chord.spaceUp))} / 左を離す ${JSON.stringify(sequenceOf(chord.leftUp))}）。` +
        ' ボタンごとに指（pointerId）を覚えていないか、押下の途中でフォーカスが動いて離されています。',
    );
  }

  // ── 3. 捨てるべきメッセージ ─────────────────────────────────────────────────
  if (touch.parentInvalidPosted !== true || !sameSequence(touch.parentInvalid, [])) {
    problems.push(
      `3: 許可表に無いキー名・形の違うメッセージが作品へ届きました（送れた=${String(touch.parentInvalidPosted)}、` +
        `届いたもの ${JSON.stringify(sequenceOf(touch.parentInvalid))}）。受け手の形と許可表の検査を確認してください。`,
    );
  }
  if (touch.parentValidPosted !== true || !sameSequence(touch.parentValid, ['keydown:KeyZ', 'keyup:KeyZ'])) {
    problems.push(
      `3 の対照: 親から送った許可表のキー（down・down・up・up）が、keydown・keyup の 1 つずつとして届きませんでした` +
        `（${JSON.stringify(sequenceOf(touch.parentValid))}）。この状態では「届かない」の緑に意味がありません。`,
    );
  }
  if (touch.siblingSameOrigin !== true) {
    problems.push('3 の前提: 別の iframe が親と同じオリジンになっていません（source の検査だけを試す形になっていない）。');
  }
  if (!sameSequence(touch.sibling, [])) {
    problems.push(
      `3: 親と同じオリジンの別の iframe から送ったメッセージが作品へ届きました（${JSON.stringify(sequenceOf(touch.sibling))}）。` +
        ' 受け手の event.source === window.parent の検査が効いていません。',
    );
  }
  if (direct.started?.reached !== true || direct.started?.state?.top !== true || direct.posted !== true) {
    problems.push(`3 の前提: 直接開いたローダーで作品が起動し、自分へ送れる状態になりませんでした（${JSON.stringify(direct.started ?? null)}）。`);
  } else if (!sameSequence(direct.keyLog, []) || !sameSequence(direct.selfPost, [])) {
    problems.push(
      `3: 直接開いたローダーの自己送信が作品へ届きました（${JSON.stringify(sequenceOf(direct.keyLog))}）。` +
        ' 受け手の window.parent !== window と event.source / event.origin の検査が効いていません。',
    );
  }

  // ── 4. デスクトップ ─────────────────────────────────────────────────────────
  const loaded = desktop.loaded;
  if (desktop.started?.reached !== true || loaded?.coarse !== false) {
    problems.push(`4 の前提: デスクトップの形（pointer: coarse でない）で作品が起動しませんでした（coarse=${String(loaded?.coarse)}）。`);
  } else {
    if (loaded.overlayHidden !== true) {
      problems.push('4: デスクトップで覆いが開いています。');
    }
    const shown = (loaded.keys ?? []).filter((key) => key.rect?.width > 0 || key.rect?.height > 0);
    if (shown.length > 0) {
      problems.push(`4: デスクトップでパッドのキーが表示されています（${JSON.stringify(shown.map((key) => key.code))}）。`);
    }
    if (!sameSequence(desktop.keys, [])) {
      problems.push(`4: デスクトップで作品へキーが届きました（${JSON.stringify(sequenceOf(desktop.keys))}）。`);
    }
  }

  // ── 5. 隠れる・閉じると離す ─────────────────────────────────────────────────
  // **閉じるときの keyup は、iframe を取り除いたときのローダー自身の pagehide でも届く**ので、親の release はここ（iframe を残す blur）で見る。
  if (!sameSequence(touch.holdUp, ['keydown:ArrowUp'])) {
    problems.push(`5 の前提: 上のキーを押しても keydown ArrowUp が届きませんでした（${JSON.stringify(sequenceOf(touch.holdUp))}）。`);
  } else if (!sameSequence(touch.blurWhileHeld, ['keyup:ArrowUp']) || touch.afterBlur?.overlayHidden !== false || touch.afterBlur?.frames !== 1) {
    problems.push(
      `5: 押したまま window の blur で、覆いを開いたまま keyup ArrowUp が 1 つだけ届きませんでした（${JSON.stringify(sequenceOf(touch.blurWhileHeld))}、` +
        `覆いが開いている=${String(touch.afterBlur?.overlayHidden === false)}）。親の releasePad が release を送っていません。`,
    );
  }
  if (touch.heldAfterBlur !== 0 || !sameSequence(touch.liftAfterBlur, [])) {
    problems.push(
      `5: blur の後に押している印が残ったか、指を離すとキーが届きました（印 ${String(touch.heldAfterBlur)}、${JSON.stringify(sequenceOf(touch.liftAfterBlur))}）。`,
    );
  }
  if (!sameSequence(touch.holdRight, ['keydown:ArrowRight'])) {
    problems.push(`5 の前提: 右のキーを押しても keydown ArrowRight が届きませんでした（${JSON.stringify(sequenceOf(touch.holdRight))}）。`);
  } else if (touch.closed?.reached !== true) {
    problems.push(`5: 「閉じる」で覆いが閉じませんでした。最後の状態: ${JSON.stringify(touch.closed?.state ?? null)}`);
  } else if (!sameSequence(touch.closeWhileHeld, ['keyup:ArrowRight'])) {
    problems.push(
      `5: 押したまま覆いを閉じても、作品へ keyup ArrowRight が届きませんでした（${JSON.stringify(sequenceOf(touch.closeWhileHeld))}）。` +
        ' 閉じる処理（releasePad）の release も、iframe を取り除いたときのローダー自身の pagehide も効いていません。',
    );
  }
  if (!sameSequence(touch.afterClose, []) || touch.heldAfterClose !== 0) {
    problems.push(
      `5: 閉じた後に指を離すと、キーが届いたか押している印が残りました（${JSON.stringify(sequenceOf(touch.afterClose))}、印 ${String(touch.heldAfterClose)}）。`,
    );
  }

  // ── 6. キーの集合が空の作品 ─────────────────────────────────────────────────
  if (empty.opened?.reached !== true) {
    problems.push(`6 の前提: キーの集合が空の作品で覆いが開きませんでした。最後の状態: ${JSON.stringify(empty.opened?.state ?? null)}`);
  } else {
    for (const [name, state] of [
      ['縦持ち', empty.portrait],
      ['横持ち', empty.landscape],
    ]) {
      if ((state?.keys ?? []).length !== 0 || state?.dpadChildren !== 0 || state?.buttonsChildren !== 0) {
        problems.push(
          `6: キーの集合が空の作品で、${name}のパッドの置き場所が空ではありません（キー ${JSON.stringify((state?.keys ?? []).map((key) => key.code))}、` +
            `子 ${String(state?.dpadChildren)} / ${String(state?.buttonsChildren)}）。`,
        );
      }
    }
    const p = empty.portrait;
    if (p?.stageRect && p?.overlayRect && Math.abs(p.stageRect.y + p.stageRect.height - (p.overlayRect.y + p.overlayRect.height)) > TOLERANCE) {
      problems.push(`6: キーの集合が空の作品で、縦持ちのゲームの領域が覆いの下端まで届いていません（ゲーム ${JSON.stringify(p.stageRect)} / 覆い ${JSON.stringify(p.overlayRect)}）。`);
    }
    const l = empty.landscape;
    if (l?.stageRect && Math.abs(l.stageRect.x) > TOLERANCE) {
      problems.push(`6: キーの集合が空の作品で、横持ちのゲームの領域が左端から始まっていません（${JSON.stringify(l.stageRect)}）。`);
    }
  }
  return problems;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = JSON.parse(readFileSync(args.probe, 'utf8'));
  const problems = problemsOf(result, args.codes);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${args.label} ${problem}\n`);
    }
    process.stderr.write(`${args.label} --- 観測結果 ---\n${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${args.label} OK: パッドのタッチがキーの押下と離しとして作品へ届き（同時押しも）、許可外のキー名・別の iframe・直接開いた文書からの` +
      'メッセージは捨てられ、デスクトップでは出ず、閉じると release で離れ、キーの集合が空の作品では出ません。\n',
  );
} catch (error) {
  process.stderr.write(`[virtual-pad] 判定できませんでした: ${String(error)}\n`);
  process.exit(1);
}
