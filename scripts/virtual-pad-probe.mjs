// virtual-pad-probe.mjs — 作品ページの仮想パッドを実ブラウザで操作し、判定材料を JSON で返す（層 8。#494 / 仕様 3.9.6 / 3.9.7）。
//
// # 何を観測するか
//
// 1. **キーを読む作品の作品ページを、タッチ端末の形**（390×844、`Emulation.setTouchEmulationEnabled`）で開き、口をタップして覆いを開く。
//    - パッドのボタン（置き場所・`code`・文字・読み上げの名前・クラス・矩形）を、縦持ちと横持ち（844×390）で読む（`--shot-dir` を渡せば撮る）
//    - **パッドへのタッチ**（CDP の `Input.dispatchTouchEvent`）: 左を押して離す／左を押したまま Space を押し、Space・左の順に離す
//    - **無視されるべきメッセージ**: 親の文書から、許可表に無いキー名・形の違うメッセージを送る（対照として、同じ親から許可表のキーも送る）。
//      親と同じオリジンの**別の iframe** から、形の正しいメッセージを送る
//    - **押したままゲームの iframe へフォーカスを移す**（離さない）・**押したままゲーム以外の iframe へフォーカスを移す**（iframe を残したまま
//      親の「すべて離す」を試す）・**押したまま覆いを閉じる**（「閉じる」の `click()`）
// 2. **サンドボックス URL を直接開いた**ローダー文書で、自分自身へ形の正しいメッセージを送る（親の居ない文書）
// 3. **デスクトップ**（1280×900、タッチなし）で同じ作品ページを開く
// 4. **キーの集合が空の作品**の作品ページを、タッチ端末の形で開いて覆いを開く
// 5. **長いキー名を 4 つ含む作品**の作品ページを、縦持ち 390px と横持ちで開いて覆いを開く（ボタンが列の幅を超えないか。`--shot-dir` で撮る）
//
// # 作品が受けたキーの観測
//
// 検査用の作品（`scripts/check-sandbox-browser.sh` がその場でビルドする Go）は canvas の keydown / keyup を `__gfKeyLog` に残し、
// **`__gfKeyBinding` があれば呼ぶ。** ここは `Runtime.addBinding` でその名前を足し、`Runtime.bindingCalled` を段階の名前つきで集める。
// **覆いを閉じると iframe は取り除かれ、`__gfKeyLog` ごと消える**ので、閉じるときの keyup はバインディングでしか観測できない。
//
// # このファイルは判定しない
//
// 合否は `scripts/virtual-pad-verdict.mjs` が持つ（観測と判定を分ける理由は `scripts/sandbox-browser-probe.mjs` の冒頭）。
//
// 使い方:
//   node scripts/virtual-pad-probe.mjs --browser <path> --url <キーを読む作品のページ> --empty-url <キーの無い作品のページ> \
//     --long-url <長いキー名の作品のページ> --direct-url <サンドボックス URL> [--timeout-ms 45000] [--shot-dir <dir>]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, POLL_INTERVAL_MS, launchBrowser, openSocket } from './lib/cdp.mjs';

/** 既定の待ち時間（1 つの状態に届くまで）。 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** 1 つの操作の後、作品へキーが届くのを待つ時間（届かないことを見る段階でも同じだけ待つ）。 */
const DELIVERY_MS = 400;

/** 縦持ちと横持ちの大きさ（層 7 と同じ）。 */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/** デスクトップの大きさ。 */
const DESKTOP = { width: 1280, height: 900 };

/** 作品が受けたキーを渡してもらうバインディングの名前（検査用の作品の Go が同じ綴りで引く）。 */
const KEY_BINDING = '__gfKeyBinding';

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, url: string, emptyUrl: string, longUrl: string, directUrl: string, timeoutMs: number, shotDir: string | null}} 設定
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
  const { browser, url } = values;
  const emptyUrl = values['empty-url'];
  const longUrl = values['long-url'];
  const directUrl = values['direct-url'];
  if (browser === undefined || url === undefined || emptyUrl === undefined || longUrl === undefined || directUrl === undefined) {
    throw new Error('--browser と --url と --empty-url と --long-url と --direct-url は必須です');
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return { browser, url, emptyUrl, longUrl, directUrl, timeoutMs, shotDir: values['shot-dir'] ?? null };
}

/**
 * 主文書に足す記録係（起動の合図を受け取った事実だけを残す。層 7 の probe と同じ形）。
 */
const SIGNAL_RECORDER = `(() => {
  if (window.top !== window) { return; }
  window.__gfSignals = [];
  // 親の window の blur が実際に起きたか（フォーカスの手順が空振りしていないことを見る）。
  window.__gfBlurs = 0;
  window.addEventListener('blur', () => { window.__gfBlurs += 1; });
  window.addEventListener('message', (event) => {
    const frame = document.querySelector('iframe.gf-frame');
    window.__gfSignals.push({
      data: typeof event.data === 'string' ? event.data : null,
      fromCurrentFrame: frame !== null && event.source === frame.contentWindow,
    });
  });
})();`;

/** 作品ページの状態（覆い・ゲームの領域・パッドのボタン）を読む式。 */
const STATE_EXPRESSION = `(() => {
  const rectOf = (element) => {
    if (element === null) { return null; }
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const overlay = document.querySelector('.gf-play-overlay');
  const stage = document.querySelector('.gf-play-stage');
  const dpad = document.querySelector('.gf-play-pad-dpad');
  const buttons = document.querySelector('.gf-play-pad-buttons');
  const keys = [...document.querySelectorAll('.gf-play-pad-key')].map((key) => ({
    code: key.getAttribute('data-code'),
    label: key.textContent,
    ariaLabel: key.getAttribute('aria-label'),
    tag: key.tagName,
    type: key.getAttribute('type'),
    classes: [...key.classList],
    place: dpad !== null && dpad.contains(key) ? 'dpad' : buttons !== null && buttons.contains(key) ? 'buttons' : 'other',
    rect: rectOf(key),
    display: getComputedStyle(key).display,
    // 文字がキーの中に収まっているか（はみ出し・切り取り）。
    scrollWidth: key.scrollWidth,
    clientWidth: key.clientWidth,
  }));
  return {
    coarse: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : null,
    viewport: { width: innerWidth, height: innerHeight },
    frames: document.querySelectorAll('iframe.gf-frame').length,
    overlayHidden: overlay === null ? null : overlay.hidden,
    overlayRect: rectOf(overlay),
    stageRect: rectOf(stage),
    dpadRect: rectOf(dpad),
    buttonsRect: rectOf(buttons),
    dpadChildren: dpad === null ? null : dpad.childNodes.length,
    buttonsChildren: buttons === null ? null : buttons.childNodes.length,
    padUserSelect: dpad === null ? null : getComputedStyle(dpad).userSelect,
    keys,
    activeIsPadKey: document.activeElement !== null && document.activeElement.classList.contains('gf-play-pad-key'),
    activeIsGameFrame: document.activeElement !== null && document.activeElement.matches('.gf-play-stage iframe.gf-frame'),
    blurs: typeof window.__gfBlurs === 'number' ? window.__gfBlurs : null,
    signals: Array.isArray(window.__gfSignals) ? window.__gfSignals.slice() : null,
  };
})()`;

/**
 * 待つ。
 *
 * @param {number} ms ミリ秒
 * @returns {Promise<void>} 待ち終わり
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1 つのタブ（ターゲット）を開き、操作と観測の道具を返す。
 *
 * @param {CdpConnection} cdp 接続
 * @param {{timeoutMs: number}} options 設定
 * @returns {Promise<any>} 道具
 */
async function openTab(cdp, options) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  /** @type {Array<{phase: string, entry: any}>} */
  const keyEvents = [];
  let phase = 'initial';
  let loadCount = 0;
  cdp.on((frame) => {
    if (frame.sessionId !== sessionId) {
      return;
    }
    if (frame.method === 'Page.loadEventFired') {
      loadCount += 1;
    }
    if (frame.method === 'Runtime.bindingCalled' && frame.params.name === KEY_BINDING) {
      let entry;
      try {
        entry = JSON.parse(String(frame.params.payload));
      } catch {
        entry = { unreadable: String(frame.params.payload) };
      }
      keyEvents.push({ phase, entry });
    }
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Runtime.addBinding', { name: KEY_BINDING }, sessionId);

  const tab = {
    sessionId,
    keyEvents,
    /** @param {string} next 以後のキーの記録に付ける段階の名前 */
    setPhase(next) {
      phase = next;
    },
    /** @param {string} name 段階 @returns {any[]} その段階で作品が受けたキー */
    keysIn(name) {
      return keyEvents.filter((event) => event.phase === name).map((event) => event.entry);
    },
    /** @param {string} expression 式 */
    async evaluate(expression) {
      const evaluated = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (evaluated.exceptionDetails !== undefined) {
        throw new Error(`評価に失敗しました: ${JSON.stringify(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text)}`);
      }
      return evaluated.result.value;
    },
    async state() {
      return tab.evaluate(STATE_EXPRESSION);
    },
    /**
     * 条件が成り立つまで式を読み続ける。成り立たなければ最後の値を返す（観測値を残す）。
     *
     * @param {(value: any) => boolean} predicate 条件
     * @param {string} [expression] 読む式（既定は作品ページの状態）
     * @returns {Promise<{reached: boolean, state: any}>} 結果
     */
    async waitFor(predicate, expression = STATE_EXPRESSION) {
      const deadline = Date.now() + options.timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = await tab.evaluate(expression);
          if (predicate(last)) {
            return { reached: true, state: last };
          }
        } catch {
          // 遷移の途中は評価できないことがある。
        }
        await sleep(POLL_INTERVAL_MS);
      }
      return { reached: false, state: last };
    },
    /** @param {string} url 開く URL */
    async navigate(url) {
      const before = loadCount;
      await cdp.send('Page.navigate', { url }, sessionId);
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline && loadCount === before) {
        await sleep(POLL_INTERVAL_MS);
      }
      if (loadCount === before) {
        throw new Error(`読み込みが終わりませんでした: ${url}`);
      }
    },
    /**
     * 要素の中央の座標（要素が無ければ null）。
     *
     * @param {string} selector セレクタ
     * @returns {Promise<{x: number, y: number} | null>} 座標
     */
    async centerOf(selector) {
      return tab.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null) { return null; }
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
    },
    /**
     * タッチを 1 つ送る。
     *
     * `touchStart` は触れている指のすべてを渡し（前の状態に無い指が押される）、**`touchEnd` は離す指だけを渡す**
     * （空なら残りのすべてを離す。この Chromium で実測した: 2 本のうち `touchEnd` に渡した指だけが `pointerup` になる）。
     *
     * @param {'touchStart' | 'touchMove' | 'touchEnd'} type 種類
     * @param {Array<{x: number, y: number, id: number}>} touchPoints 指
     */
    async touch(type, touchPoints) {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints }, sessionId);
    },
    /** @param {string} selector セレクタ @returns {Promise<boolean>} タップできたか */
    async tap(selector) {
      const point = await tab.centerOf(selector);
      if (point === null) {
        return false;
      }
      await tab.touch('touchStart', [{ ...point, id: 0 }]);
      await tab.touch('touchEnd', []);
      return true;
    },
    /** @param {{width: number, height: number}} size 大きさ @param {boolean} mobile 携帯端末として扱うか */
    async resize(size, mobile) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile,
          screenOrientation: mobile
            ? size.width > size.height
              ? { type: 'landscapePrimary', angle: 90 }
              : { type: 'portraitPrimary', angle: 0 }
            : undefined,
        },
        sessionId,
      );
    },
    /** @param {string | null} path 保存先（null なら撮らない） */
    async shoot(path) {
      if (path === null) {
        return null;
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      return path;
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
  return tab;
}

/**
 * 覆いが開き、覆いの中の iframe から起動の合図が届いたか。
 *
 * @param {any} state 状態
 * @returns {boolean} 開いて合図が届いたか
 */
function openedWithSignal(state) {
  return (
    state?.overlayHidden === false &&
    state.frames === 1 &&
    Array.isArray(state.signals) &&
    state.signals.some((signal) => signal.fromCurrentFrame && signal.data === 'gf-loader-started')
  );
}

/** 親の文書から、覆いの中の iframe へメッセージを送る式（**親の中の別のスクリプト**の代わり。信頼の境界の内側。仕様 3.9.8 の 7）。 */
function postFromParent(messages) {
  return `(() => {
    const frame = document.querySelector('.gf-play-stage iframe.gf-frame');
    if (frame === null || frame.contentWindow === null) { return false; }
    for (const message of ${JSON.stringify(messages)}) {
      frame.contentWindow.postMessage(message, '*');
    }
    return true;
  })()`;
}

/**
 * 親と同じオリジンの別の iframe を作り、**その iframe の中で動くスクリプトから**覆いの中の iframe へ送る式。
 *
 * `eval` を別の iframe の窓で呼ぶので、`postMessage` を呼んだ文書（`event.source`）はその iframe になり、`event.origin` は
 * 親アプリのオリジンになる——**source の検査だけが捨てる理由になる**形である。送った後に取り除く。
 */
const POST_FROM_SIBLING = `(() => {
  const frame = document.querySelector('.gf-play-stage iframe.gf-frame');
  if (frame === null) { return false; }
  const sibling = document.createElement('iframe');
  sibling.setAttribute('title', 'gf-virtual-pad-probe-sibling');
  document.body.appendChild(sibling);
  sibling.contentWindow.eval(
    "parent.document.querySelector('.gf-play-stage iframe.gf-frame').contentWindow.postMessage({ type: 'gf-pad', op: 'down', code: 'Space' }, '*');" +
    "parent.document.querySelector('.gf-play-stage iframe.gf-frame').contentWindow.postMessage({ type: 'gf-pad', op: 'down', code: 'ArrowUp' }, '*');",
  );
  return sibling.contentWindow.origin === location.origin;
})()`;

/** 別の iframe を片付ける式。 */
const REMOVE_SIBLING = `(() => {
  const sibling = document.querySelector('iframe[title="gf-virtual-pad-probe-sibling"]');
  if (sibling !== null) { sibling.remove(); }
  return true;
})()`;

/**
 * キーを読む作品を、タッチ端末の形で観測する。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeTouch(cdp, options) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(PORTRAIT, true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, tab.sessionId);
    // ヘッドレスのタブは前面にないので、focus / blur を実際に起こすには焦点のエミュレートが要る（5a / 5b）。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, tab.sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_RECORDER }, tab.sessionId);
    await tab.navigate(options.url);
    steps.beforeTap = await tab.state();

    tab.setPhase('open');
    steps.tapEntry = await tab.tap('.gf-play-entry');
    steps.opened = await tab.waitFor(openedWithSignal);
    // 合図の直後に、起動した作品が canvas のリスナーを付け終えている（Go の main が合図より前に付ける）。
    await sleep(DELIVERY_MS);
    steps.portrait = await tab.state();
    steps.shotPortrait = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'pad-portrait-390x844.png'));
    await tab.resize(LANDSCAPE, true);
    await sleep(500);
    steps.landscape = await tab.state();
    steps.shotLandscape = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'pad-landscape-844x390.png'));
    await tab.resize(PORTRAIT, true);
    await sleep(500);
    steps.keysOnOpen = tab.keysIn('open');

    // 1. 左を押して離す。
    const left = await tab.centerOf('.gf-play-pad-key[data-code="ArrowLeft"]');
    const space = await tab.centerOf('.gf-play-pad-key[data-code="Space"]');
    const right = await tab.centerOf('.gf-play-pad-key[data-code="ArrowRight"]');
    steps.points = { left, space, right };
    if (left === null || space === null || right === null) {
      throw new Error('パッドに ArrowLeft / Space / ArrowRight のボタンがありません（検査の前提が崩れています）');
    }
    tab.setPhase('tap-left-down');
    await tab.touch('touchStart', [{ ...left, id: 1 }]);
    await sleep(DELIVERY_MS);
    steps.heldWhileLeft = await tab.evaluate(`[...document.querySelectorAll('.gf-play-pad-held')].map((key) => key.getAttribute('data-code'))`);
    steps.focusWhileLeft = (await tab.state()).activeIsPadKey;
    tab.setPhase('tap-left-up');
    await tab.touch('touchEnd', []);
    await sleep(DELIVERY_MS);
    steps.tapLeftDown = tab.keysIn('tap-left-down');
    steps.tapLeftUp = tab.keysIn('tap-left-up');

    // 2. 同時押し: 左を押したまま Space を押し、Space → 左の順に離す。
    tab.setPhase('chord-left-down');
    await tab.touch('touchStart', [{ ...left, id: 1 }]);
    await sleep(DELIVERY_MS);
    tab.setPhase('chord-space-down');
    await tab.touch('touchStart', [
      { ...left, id: 1 },
      { ...space, id: 2 },
    ]);
    await sleep(DELIVERY_MS);
    tab.setPhase('chord-space-up');
    await tab.touch('touchEnd', [{ ...space, id: 2 }]);
    await sleep(DELIVERY_MS);
    tab.setPhase('chord-left-up');
    await tab.touch('touchEnd', [{ ...left, id: 1 }]);
    await sleep(DELIVERY_MS);
    steps.chord = {
      leftDown: tab.keysIn('chord-left-down'),
      spaceDown: tab.keysIn('chord-space-down'),
      spaceUp: tab.keysIn('chord-space-up'),
      leftUp: tab.keysIn('chord-left-up'),
    };

    // 3a. 親の文書から、許可表に無いキー名と形の違うメッセージ。
    tab.setPhase('parent-invalid');
    steps.parentInvalidPosted = await tab.evaluate(
      postFromParent([
        { type: 'gf-pad', op: 'down', code: 'KeyQQ' },
        { type: 'gf-pad', op: 'down', code: 'constructor' },
        { type: 'gf-pad', op: 'down', code: '__proto__' },
        { type: 'gf-pad', op: 'down' },
        { type: 'gf-pad', op: 'press', code: 'Space' },
        { type: 'other', op: 'down', code: 'Space' },
        'gf-pad',
        ['gf-pad', 'down', 'Space'],
      ]),
    );
    await sleep(DELIVERY_MS);
    steps.parentInvalid = tab.keysIn('parent-invalid');
    // 対照: 同じ親から、許可表のキーなら届く（上の「届かない」が、経路そのものが塞がっていることの見間違いでない）。
    tab.setPhase('parent-valid');
    steps.parentValidPosted = await tab.evaluate(
      postFromParent([
        { type: 'gf-pad', op: 'down', code: 'KeyZ' },
        { type: 'gf-pad', op: 'down', code: 'KeyZ' },
        { type: 'gf-pad', op: 'up', code: 'KeyZ' },
        { type: 'gf-pad', op: 'up', code: 'KeyZ' },
      ]),
    );
    await sleep(DELIVERY_MS);
    steps.parentValid = tab.keysIn('parent-valid');

    // 3b. 親と同じオリジンの別の iframe から、形の正しいメッセージ。
    tab.setPhase('sibling');
    steps.siblingSameOrigin = await tab.evaluate(POST_FROM_SIBLING);
    await sleep(DELIVERY_MS);
    steps.sibling = tab.keysIn('sibling');
    await tab.evaluate(REMOVE_SIBLING);

    // 5a. 押したままゲームの iframe をタップしてフォーカスを移しても、離さない（PR #524）。**iframe を取り除かない**ので、
    // 届く keyup は親の release による（閉じるときの keyup は、iframe を取り除いたときのローダー自身の pagehide でも届き、親の release と
    // 見分けられない。2026-09-14 に実測）。
    const up = await tab.centerOf('.gf-play-pad-key[data-code="ArrowUp"]');
    const stage = await tab.centerOf('.gf-play-stage');
    steps.points.up = up;
    steps.points.stage = stage;
    if (up === null || stage === null) {
      throw new Error('パッドに ArrowUp のボタンか、ゲームの領域がありません（検査の前提が崩れています）');
    }
    tab.setPhase('hold-up');
    await tab.touch('touchStart', [{ ...up, id: 4 }]);
    await sleep(DELIVERY_MS);
    steps.holdUp = tab.keysIn('hold-up');
    const blursBeforeGame = (await tab.state()).blurs;
    tab.setPhase('focus-game-while-held');
    // 指をもう 1 本ゲームに置いて離し、フォーカスをゲームの iframe へ移す（タップで移らない作品もあるので、移す操作を明示的にも行う）。
    await tab.touch('touchStart', [
      { ...up, id: 4 },
      { ...stage, id: 5 },
    ]);
    await tab.touch('touchEnd', [{ ...stage, id: 5 }]);
    await tab.evaluate(`document.querySelector('.gf-play-stage iframe.gf-frame').focus()`);
    await sleep(DELIVERY_MS);
    steps.focusGameWhileHeld = tab.keysIn('focus-game-while-held');
    steps.afterFocusGame = await tab.state();
    steps.afterFocusGame.blursBefore = blursBeforeGame;
    tab.setPhase('lift-after-focus-game');
    await tab.touch('touchEnd', [{ ...up, id: 4 }]);
    await sleep(DELIVERY_MS);
    steps.liftAfterFocusGame = tab.keysIn('lift-after-focus-game');

    // 5b. 押したままゲーム以外（親と同じオリジンの別の iframe）へフォーカスを移すと、親の release で離す。
    await tab.evaluate(`document.querySelector('.gf-play-close').focus()`);
    await sleep(DELIVERY_MS);
    tab.setPhase('hold-up-again');
    await tab.touch('touchStart', [{ ...up, id: 6 }]);
    await sleep(DELIVERY_MS);
    steps.holdUpAgain = tab.keysIn('hold-up-again');
    const blursBeforeOther = (await tab.state()).blurs;
    tab.setPhase('focus-other-while-held');
    await tab.evaluate(`(() => {
      const other = document.createElement('iframe');
      other.setAttribute('title', 'gf-virtual-pad-probe-focus');
      document.body.appendChild(other);
      other.focus();
      return true;
    })()`);
    await sleep(DELIVERY_MS);
    steps.focusOtherWhileHeld = tab.keysIn('focus-other-while-held');
    steps.afterFocusOther = await tab.state();
    steps.afterFocusOther.blursBefore = blursBeforeOther;
    steps.heldAfterFocusOther = await tab.evaluate(`document.querySelectorAll('.gf-play-pad-held').length`);
    steps.activeIsOther = await tab.evaluate(`document.activeElement !== null && document.activeElement.getAttribute('title') === 'gf-virtual-pad-probe-focus'`);
    tab.setPhase('lift-after-focus-other');
    await tab.touch('touchEnd', []);
    await sleep(DELIVERY_MS);
    steps.liftAfterFocusOther = tab.keysIn('lift-after-focus-other');
    await tab.evaluate(`(() => {
      const other = document.querySelector('iframe[title="gf-virtual-pad-probe-focus"]');
      if (other !== null) { other.remove(); }
      document.querySelector('.gf-play-close').focus();
      return true;
    })()`);

    // 5c. 押したまま覆いを閉じる。
    tab.setPhase('hold-right');
    await tab.touch('touchStart', [{ ...right, id: 3 }]);
    await sleep(DELIVERY_MS);
    steps.holdRight = tab.keysIn('hold-right');
    tab.setPhase('close-while-held');
    await tab.evaluate(`document.querySelector('.gf-play-close').click()`);
    steps.closed = await tab.waitFor((state) => state?.overlayHidden === true && state.frames === 0);
    await sleep(DELIVERY_MS);
    steps.closeWhileHeld = tab.keysIn('close-while-held');
    tab.setPhase('after-close');
    await tab.touch('touchEnd', []);
    await sleep(DELIVERY_MS);
    steps.afterClose = tab.keysIn('after-close');
    steps.heldAfterClose = await tab.evaluate(`document.querySelectorAll('.gf-play-pad-held').length`);
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    steps.allKeyEvents = tab.keyEvents;
    await tab.close().catch(() => {});
  }
}

/**
 * サンドボックス URL を直接開いたローダー文書で、自分自身へ送る。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeDirect(cdp, options) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(DESKTOP, false);
    await tab.navigate(options.directUrl);
    steps.started = await tab.waitFor(
      (value) => value?.ran === 'ok' && value.canvas === true,
      `({ ran: window.__gfWasmRan ?? null, canvas: document.querySelector('canvas') !== null, top: window.parent === window })`,
    );
    tab.setPhase('self-post');
    steps.posted = await tab.evaluate(`(() => {
      window.postMessage({ type: 'gf-pad', op: 'down', code: 'Space' }, '*');
      window.postMessage({ type: 'gf-pad', op: 'down', code: 'ArrowLeft' }, '*');
      return true;
    })()`);
    await sleep(DELIVERY_MS);
    steps.keyLog = await tab.evaluate(`Array.isArray(window.__gfKeyLog) ? window.__gfKeyLog.slice() : null`);
    steps.selfPost = tab.keysIn('self-post');
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * デスクトップの形で作品ページを開く。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeDesktop(cdp, options) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(DESKTOP, false);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_RECORDER }, tab.sessionId);
    tab.setPhase('desktop');
    await tab.navigate(options.url);
    steps.started = await tab.waitFor(
      (state) => Array.isArray(state?.signals) && state.signals.some((signal) => signal.fromCurrentFrame && signal.data === 'gf-loader-started'),
    );
    await sleep(DELIVERY_MS);
    steps.loaded = await tab.state();
    steps.keys = tab.keysIn('desktop');
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * キーの集合が空の作品を、タッチ端末の形で開いて覆いを開く。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeEmpty(cdp, options) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(PORTRAIT, true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, tab.sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_RECORDER }, tab.sessionId);
    await tab.navigate(options.emptyUrl);
    steps.tapEntry = await tab.tap('.gf-play-entry');
    steps.opened = await tab.waitFor(openedWithSignal);
    steps.portrait = steps.opened.state;
    await tab.resize(LANDSCAPE, true);
    await sleep(500);
    steps.landscape = await tab.state();
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * 長いキー名の作品を、縦持ちの 390px で開いて覆いを開く（ボタンの文字が列の幅を超えないか。PR #524）。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeLong(cdp, options) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(PORTRAIT, true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, tab.sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_RECORDER }, tab.sessionId);
    await tab.navigate(options.longUrl);
    steps.tapEntry = await tab.tap('.gf-play-entry');
    steps.opened = await tab.waitFor(openedWithSignal);
    await sleep(500);
    steps.portrait = await tab.state();
    steps.shotPortrait = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'pad-long-keys-portrait-390x844.png'));
    await tab.resize(LANDSCAPE, true);
    await sleep(500);
    steps.landscape = await tab.state();
    steps.shotLandscape = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'pad-long-keys-landscape-844x390.png'));
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * 観測する。
 *
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function probe(options) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'gf-pad-probe-'));
  let launched;
  try {
    launched = await launchBrowser(options.browser, userDataDir);
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
  const { child, endpoint } = launched;
  try {
    const cdp = new CdpConnection(await openSocket(endpoint));
    return {
      url: options.url,
      emptyUrl: options.emptyUrl,
      longUrl: options.longUrl,
      directUrl: options.directUrl,
      touch: await observeTouch(cdp, options),
      direct: await observeDirect(cdp, options),
      desktop: await observeDesktop(cdp, options),
      empty: await observeEmpty(cdp, options),
      long: await observeLong(cdp, options),
    };
  } finally {
    child.kill('SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

try {
  const result = await probe(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[virtual-pad-probe] 観測できませんでした: ${String(error)}\n`);
  process.exit(1);
}
