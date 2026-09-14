// tap-to-fullscreen-verdict.mjs — 作品ページの「タップして全画面で遊ぶ」を判定する（層 7。#502 / 仕様 3.9.4）。
//
// `scripts/tap-to-fullscreen-probe.mjs` の観測結果（JSON）を読み、issue #502 の acceptance と仕様 3.9.4 の決めごとを見る。
//
// | # | 見るもの |
// |---|---|
// | 前提 | タッチ端末の形で `matchMedia('(pointer: coarse)')` が true、デスクトップの形で false だった（**エミュレートが効いていない緑は無意味**） |
// | 1 | タッチ端末では、タップの前にサンドボックス用ホストへ要求を 1 つも出さず、iframe も無い。「遊ぶ」のボタンは見えている |
// | 2 | 口をタップすると覆いが画面いっぱいに開き、iframe が覆いのゲームの領域いっぱいに作られ、その iframe から起動の合図が届く |
// | 3 | 「閉じる」のボタン・戻る操作・iframe の 2 回目の `load`（3.9.7）・全画面の解除（入れた環境だけ）のそれぞれで覆いが閉じ、iframe が取り除かれる |
// | 4 | デスクトップでは、開いた時点で iframe が `<noscript>` の直前にある |
// | 5 | JavaScript を止めると、`<noscript>` の中の iframe がある |
// | 属性 | 3 つの形の iframe の属性が、順序まで同じ（**出どころが 1 か所であることの実物での裏取り**）。`src` は作品の `/g/<id>/`、`sandbox` は `allow-scripts` だけ、`allowfullscreen` も `allow` も無い |
// | 並べ方 | 縦持ちは「閉じる」の行がゲームの上、横持ちは「閉じる」がゲームの右。どちらもゲームの領域が覆いの残りを使う |
// | #377 | sessionStorage を消して 2 回開いても、計上の要求（`POST /api/plays`）は 1 回だけ |
//
// **属性の値（`class` / `title`）はここへ書き写さない。** 3 つの形を互いに比べ、`<noscript>` の HTML が `src/work-play.ts` の
// 1 か所から組み立てられていることは単体テスト（`test/work-play.test.ts`）が見る。
//
// 使い方:
//   node scripts/tap-to-fullscreen-verdict.mjs --probe <json> --expected-src <URL> --label <prefix>
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';

/** 矩形の比較で許す差（CSS ピクセル）。 */
const TOLERANCE = 1;

/** 計上の口（`src/plays.ts` の `PLAY_PATH`。probe が同じ綴りで数える）。 */
const PLAY_PATH = '/api/plays';

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{probe: string, expectedSrc: string, label: string}} 設定
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
  if (values['probe'] === undefined || values['expected-src'] === undefined) {
    throw new Error('--probe と --expected-src は必須です');
  }
  return { probe: values['probe'], expectedSrc: values['expected-src'], label: values['label'] ?? '[tap-to-fullscreen]' };
}

/**
 * 2 つの矩形がほぼ同じか。
 *
 * @param {any} a 矩形
 * @param {any} b 矩形
 * @returns {boolean} 同じとみなせるか
 */
function sameRect(a, b) {
  return (
    a !== null &&
    b !== null &&
    a !== undefined &&
    b !== undefined &&
    ['x', 'y', 'width', 'height'].every((key) => Math.abs(Number(a[key]) - Number(b[key])) <= TOLERANCE)
  );
}

/**
 * 観測結果を判定する。
 *
 * @param {any} result 観測結果
 * @param {string} expectedSrc 作品の遊ぶ URL
 * @returns {string[]} 不合格の理由（空なら合格）
 */
function problemsOf(result, expectedSrc) {
  /** @type {string[]} */
  const problems = [];
  const touch = result.touch ?? {};
  const desktop = result.desktop ?? {};
  const noscript = result.noscript ?? {};
  for (const [name, part] of [
    ['タッチ端末', touch],
    ['デスクトップ', desktop],
    ['JavaScript を止めた形', noscript],
  ]) {
    if (typeof part.error === 'string') {
      problems.push(`${name}の観測が途中で止まりました: ${part.error}`);
    }
  }

  // ── 前提 ──────────────────────────────────────────────────────────────────
  if (touch.beforeTap?.coarse !== true) {
    problems.push(
      `前提: タッチ端末の形で matchMedia('(pointer: coarse)') が true になっていません（${String(touch.beforeTap?.coarse)}）。` +
        ' タッチのエミュレートが効いていない状態の緑は無意味です。',
    );
    return problems;
  }
  if (desktop.loaded?.coarse !== false) {
    problems.push(`前提: デスクトップの形で matchMedia('(pointer: coarse)') が false になっていません（${String(desktop.loaded?.coarse)}）。`);
  }

  // ── 1. タップの前は読み込まない ──────────────────────────────────────────────
  const before = touch.beforeTap;
  if (!Array.isArray(touch.sandboxRequestsBeforeTap) || touch.sandboxRequestsBeforeTap.length !== 0) {
    problems.push(
      `1: タッチ端末で、タップの前にサンドボックス用ホストへ要求が出ています: ${JSON.stringify(touch.sandboxRequestsBeforeTap)}。` +
        ' 開いた時点で iframe を作っています（src/work-play.ts の判定か、遅延作成が外れている）。',
    );
  }
  if (before.frames?.length !== 0) {
    problems.push(`1: タッチ端末で、タップの前に iframe が ${String(before.frames?.length)} 個あります。`);
  }
  if (before.overlayHidden !== true) {
    problems.push('1: タップの前に覆いが開いています。');
  }
  if (before.openHidden !== false || before.openDisplay === 'none') {
    problems.push(`1: タッチ端末で「遊ぶ」のボタンが見えていません（hidden=${String(before.openHidden)}, display=${String(before.openDisplay)}）。`);
  }

  // ── 2. タップで開き、iframe が作られ、合図が届く ─────────────────────────────
  const opened = touch.opened;
  if (opened?.reached !== true) {
    problems.push(
      '2: 口をタップしても、覆いが開いて iframe から起動の合図が届く状態になりませんでした。最後の状態: ' +
        JSON.stringify(opened?.state ?? null),
    );
  } else {
    const state = opened.state;
    const viewport = { x: 0, y: 0, width: state.viewport.width, height: state.viewport.height };
    if (!sameRect(state.overlayRect, viewport)) {
      problems.push(`2: 覆いが画面いっぱいではありません（覆い ${JSON.stringify(state.overlayRect)} / 画面 ${JSON.stringify(viewport)}）。`);
    }
    if (!sameRect(state.frames[0].rect, state.stageRect)) {
      problems.push(`2: iframe がゲームの領域いっぱいではありません（iframe ${JSON.stringify(state.frames[0].rect)} / 領域 ${JSON.stringify(state.stageRect)}）。`);
    }
    if (state.locked !== true) {
      problems.push('2: 覆いを開いているのに、下のページのスクロールを止める印（html.gf-play-locked）がありません。');
    }
    if (!Array.isArray(touch.sandboxRequestsAfterTap) || touch.sandboxRequestsAfterTap.length === 0) {
      problems.push('2: タップの後にサンドボックス用ホストへの要求が観測されていません（観測の前提が崩れています）。');
    }
  }

  // 並べ方（縦持ちと横持ち）。
  const portrait = touch.portrait;
  if (portrait?.closeRect && portrait?.stageRect) {
    if (!(portrait.closeRect.y + portrait.closeRect.height <= portrait.stageRect.y + TOLERANCE)) {
      problems.push(`並べ方: 縦持ちで「閉じる」がゲームの上の行にありません（閉じる ${JSON.stringify(portrait.closeRect)} / ゲーム ${JSON.stringify(portrait.stageRect)}）。`);
    }
    if (Math.abs(portrait.stageRect.width - portrait.viewport.width) > TOLERANCE) {
      problems.push(`並べ方: 縦持ちでゲームの領域が画面の幅を使っていません（${JSON.stringify(portrait.stageRect)}）。`);
    }
  } else {
    problems.push('並べ方: 縦持ちの覆いを観測できていません。');
  }
  const landscape = touch.landscape;
  if (landscape?.closeRect && landscape?.stageRect) {
    if (!(landscape.closeRect.x >= landscape.stageRect.x + landscape.stageRect.width - TOLERANCE)) {
      problems.push(`並べ方: 横持ちで「閉じる」がゲームの右にありません（閉じる ${JSON.stringify(landscape.closeRect)} / ゲーム ${JSON.stringify(landscape.stageRect)}）。`);
    }
    if (!(landscape.closeRect.y <= landscape.viewport.height / 2)) {
      problems.push(`並べ方: 横持ちで「閉じる」が上の隅にありません（${JSON.stringify(landscape.closeRect)}）。`);
    }
    if (Math.abs(landscape.stageRect.height - landscape.viewport.height) > TOLERANCE) {
      problems.push(`並べ方: 横持ちでゲームの領域が画面の高さを使っていません（${JSON.stringify(landscape.stageRect)}）。`);
    }
  } else {
    problems.push('並べ方: 横持ちの覆いを観測できていません。');
  }

  // ── 3. 閉じる手段のそれぞれで閉じ、iframe を取り除く ──────────────────────────
  for (const [name, step] of [
    ['「閉じる」のボタン', touch.closedByButton],
    ['戻る操作', touch.closedByBack],
    ['iframe の 2 回目の load（遷移。3.9.7）', touch.closedByChildNavigation],
  ]) {
    if (step?.reached !== true) {
      problems.push(`3: ${name}で覆いが閉じず、iframe が残っています。最後の状態: ${JSON.stringify(step?.state ?? null)}`);
    } else if (step.state.locked !== false) {
      problems.push(`3: ${name}で閉じたのに、スクロールを止める印が残っています。`);
    }
  }
  if (touch.backNavigated !== true) {
    problems.push('3: 戻る操作をする履歴がありませんでした（開くときに履歴を積んでいない）。');
  }
  if (touch.reopened?.reached !== true || touch.thirdOpened?.reached !== true || touch.fourthOpened?.reached !== true) {
    problems.push('3: 閉じた後にもう一度開けませんでした（開き直すと新しい iframe で最初から始まる。3.9.4）。');
  }
  if (touch.closedByButton?.state?.fullscreen !== null && touch.closedByButton?.state?.fullscreen !== undefined) {
    problems.push(`3: 「閉じる」のボタンで閉じたのに、全画面が残っています（${String(touch.closedByButton.state.fullscreen)}）。`);
  }
  if (touch.fullscreenAfterOpen === 'overlay' && touch.closedByFullscreenExit?.reached !== true) {
    problems.push('3: 全画面を解除しても覆いが閉じませんでした（fullscreenchange）。');
  }
  if (touch.fullscreenAfterOpen === 'other') {
    problems.push('3: 全画面になっているのが覆いの要素ではありません（全画面にするのは親の文書の覆いである。3.9.4）。');
  }

  // ── #377. 同じページでは 1 回だけ数える ─────────────────────────────────────
  if (touch.playsAfterFirstOpen !== 1 || touch.playsAfterSecondOpen !== 1 || touch.playsTotal !== 1) {
    problems.push(
      `#377: 計上の要求（POST ${PLAY_PATH}）の数が 1 回ではありません（1 回目の後 ${String(touch.playsAfterFirstOpen)}、` +
        `sessionStorage を消して開き直した後 ${String(touch.playsAfterSecondOpen)}、最後 ${String(touch.playsTotal)}）。`,
    );
  }

  // ── 4. デスクトップ / 5. JavaScript を止めた形 ─────────────────────────────
  const desktopFrames = desktop.loaded?.frames ?? [];
  if (desktopFrames.length !== 1) {
    problems.push(`4: デスクトップで、開いた時点の iframe が ${desktopFrames.length} 個です（期待は 1 個）。`);
  } else {
    const frame = desktopFrames[0];
    if (frame.parentTag === 'NOSCRIPT' || frame.inStage) {
      problems.push(`4: デスクトップの iframe が、今と同じ位置（<noscript> の直前）にありません（親 ${String(frame.parentTag)}）。`);
    }
    if (frame.nextTag !== 'NOSCRIPT') {
      problems.push(`4: デスクトップの iframe の直後が <noscript> ではありません（${String(frame.nextTag)}）。`);
    }
    if (desktop.loaded.overlayHidden !== true || desktop.loaded.openHidden !== true) {
      problems.push('4: デスクトップで、覆いか「遊ぶ」のボタンが見えています。');
    }
  }
  const noscriptFrames = noscript.loaded?.frames ?? [];
  if (noscriptFrames.length !== 1 || noscriptFrames[0].parentTag !== 'NOSCRIPT') {
    problems.push(
      `5: JavaScript を止めた形で、<noscript> の中の iframe がありません（${JSON.stringify(noscriptFrames.map((frame) => frame.parentTag))}）。`,
    );
  } else if (!Array.isArray(noscript.sandboxRequests) || noscript.sandboxRequests.length === 0) {
    problems.push('5: JavaScript を止めた形で、iframe がサンドボックス用ホストを読み込んでいません。');
  }

  // ── 属性: 3 つの形が同じで、7.2 の形のまま ───────────────────────────────────
  const forms = [
    ['タッチ端末の覆い', opened?.state?.frames?.[0]?.attributes],
    ['デスクトップ', desktopFrames[0]?.attributes],
    ['JavaScript を止めた形', noscriptFrames[0]?.attributes],
  ];
  const reference = JSON.stringify(forms[2][1] ?? null);
  for (const [name, attributes] of forms) {
    if (!Array.isArray(attributes)) {
      continue;
    }
    if (JSON.stringify(attributes) !== reference) {
      problems.push(`属性: ${name}の iframe の属性が <noscript> の埋め込みと違います（${JSON.stringify(attributes)} / ${reference}）。`);
    }
    const map = new Map(attributes);
    if (map.get('src') !== expectedSrc) {
      problems.push(`属性: ${name}の iframe の src が作品の遊ぶ URL ではありません（${String(map.get('src'))} / 期待 ${expectedSrc}）。`);
    }
    if (map.get('sandbox') !== 'allow-scripts') {
      problems.push(`属性: ${name}の iframe の sandbox が allow-scripts だけではありません（${String(map.get('sandbox'))}。7.2）。`);
    }
    if (map.has('allowfullscreen') || map.has('allow')) {
      problems.push(`属性: ${name}の iframe に allowfullscreen / allow があります（全画面にするのは親の文書の覆いである。3.9.8）。`);
    }
  }
  return problems;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = JSON.parse(readFileSync(args.probe, 'utf8'));
  const problems = problemsOf(result, args.expectedSrc);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${args.label} ${problem}\n`);
    }
    process.stderr.write(`${args.label} --- 観測結果 ---\n${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${args.label} OK: タップの前は読み込まず、タップで覆いが開いて合図が届き、閉じる手段のそれぞれで iframe を取り除き、` +
      `デスクトップと JavaScript を止めた形は同じ属性の iframe を持つ（全画面: ${String(result.touch?.fullscreenAfterOpen)}）。\n`,
  );
} catch (error) {
  process.stderr.write(`[tap-to-fullscreen] 判定できませんでした: ${String(error)}\n`);
  process.exit(1);
}
