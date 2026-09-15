// stick-pad-probe.mjs — 仮想パッドの方向の操作の形（スティック / 十字）と切り替えを実ブラウザで操作し、判定材料を JSON で返す
// （層 9。#530 / 仕様 3.9.6 の「方向の操作の形: 十字とスティック」）。
//
// # 何を観測するか
//
// すべてタッチ端末の形（390×844、`Emulation.setTouchEmulationEnabled`）で作品ページを開き、口をタップして覆いを開く。
//
// 1. **横だけの作品**（←→ H・↑ J・Space）
//    - 最初の形（覆いの `data-pad-shape`・見えている置き場所・見えているキー・切り替えの文言）と並べ方の矩形（縦持ち・横持ち）
//    - **スティック**（CDP の `Input.dispatchTouchEvent`）: 触れて右・上・左・下へ倒し、右へ倒して離す。右のボタンの ↑ を押して離す
//    - **同時押し**: スティックを右へ倒したまま Space を押して離し、スティックを離す
//    - **隠れる**: スティックを右へ倒したまま、親の文書で `visibilitychange`（hidden）を起こす。その後に倒し直しても離しても何も届かないか
//    - **閉じる**: スティックを右へ倒したまま「閉じる」を押す。その後に離しても何も届かないか
//    - **切り替え**: 開き直して切り替えのボタンを押し、形が変わるか・覚えた値。**文書を開き直して**、覚えた形で出るか
//    - `--shot-dir` を渡せば、スティックに触れて倒している状態を縦持ち・横持ちで撮る
// 2. **`localStorage` が使えない**（読むと例外を投げる）状態で、同じ横だけの作品を開く（1 で十字を覚えた後）。推定した形で出て、
//    切り替えが効き、ページの例外が出ないか
// 3. **8 方向の作品**（4 方向とも H）: 右上へ倒す・左へ・左上へ・右上へと倒し、離す（外れたキーの keyup が先に届くか）。撮影もする
// 4. **十字の作品**（4 方向とも J）・**版 1 の行の作品**（`held_codes` が NULL）・**行が無い作品**: 最初の形
//
// # 作品が受けたキーの観測
//
// 層 8 と同じく、検査用の作品の canvas の keydown / keyup を `Runtime.addBinding`（`__gfKeyBinding`）で段階の名前つきで集める
// （`scripts/virtual-pad-probe.mjs` の冒頭）。
//
// # このファイルは判定しない
//
// 合否は `scripts/stick-pad-verdict.mjs` が持つ。
//
// 使い方:
//   node scripts/stick-pad-probe.mjs --browser <path> --horizontal-url <横だけの作品> --eight-url <8 方向の作品> \
//     --dpad-url <十字の作品> --v1-url <版 1 の行の作品> --no-row-url <行が無い作品> [--timeout-ms 45000] [--shot-dir <dir>]
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

/** 縦持ちと横持ちの大きさ（層 7・層 8 と同じ）。 */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/** 作品が受けたキーを渡してもらうバインディングの名前（検査用の作品の Go が同じ綴りで引く）。 */
const KEY_BINDING = '__gfKeyBinding';

/**
 * スティックを倒す量（CSS ピクセル）。**円の半径（56px）ちょうど**にする——遊び（30%）を十分に超え、つまみが縁に届く。
 * 半径の値そのものは判定しない（仕様の数字は単体テストが見る）。
 */
const TILT = 56;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, horizontalUrl: string, eightUrl: string, dpadUrl: string, v1Url: string, noRowUrl: string, timeoutMs: number, shotDir: string | null}} 設定
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
  const required = ['browser', 'horizontal-url', 'eight-url', 'dpad-url', 'v1-url', 'no-row-url'];
  for (const name of required) {
    if (values[name] === undefined) {
      throw new Error(`--${required.join(' と --')} は必須です`);
    }
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return {
    browser: values['browser'],
    horizontalUrl: values['horizontal-url'],
    eightUrl: values['eight-url'],
    dpadUrl: values['dpad-url'],
    v1Url: values['v1-url'],
    noRowUrl: values['no-row-url'],
    timeoutMs,
    shotDir: values['shot-dir'] ?? null,
  };
}

/** 主文書に足す記録係（起動の合図を受け取った事実だけを残す。層 8 の probe と同じ形）。 */
const SIGNAL_RECORDER = `(() => {
  if (window.top !== window) { return; }
  window.__gfSignals = [];
  window.addEventListener('message', (event) => {
    const frame = document.querySelector('iframe.gf-frame');
    window.__gfSignals.push({
      data: typeof event.data === 'string' ? event.data : null,
      fromCurrentFrame: frame !== null && event.source === frame.contentWindow,
    });
  });
})();`;

/** `localStorage` を読むと例外を投げる状態にする（主文書だけ。使えない環境の代わり）。 */
const BREAK_STORAGE = `(() => {
  if (window.top !== window) { return; }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('localStorage is disabled by the probe', 'SecurityError'); },
  });
})();`;

/** 作品ページの状態（覆い・置き場所・見えているキー・切り替え）を読む式。 */
const STATE_EXPRESSION = `(() => {
  const rectOf = (element) => {
    if (element === null) { return null; }
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const shown = (element) => element !== null && element.getClientRects().length > 0;
  const overlay = document.querySelector('.gf-play-overlay');
  const stick = document.querySelector('.gf-play-pad-stick');
  const dpad = document.querySelector('.gf-play-pad-dpad');
  const buttons = document.querySelector('.gf-play-pad-buttons');
  const toggle = document.querySelector('.gf-play-pad-toggle');
  const ring = document.querySelector('.gf-play-stick-ring');
  const keys = [...document.querySelectorAll('.gf-play-pad-key')].filter(shown).map((key) => ({
    code: key.getAttribute('data-code'),
    label: key.textContent,
    ariaLabel: key.getAttribute('aria-label'),
    place: dpad !== null && dpad.contains(key) ? 'dpad' : buttons !== null && buttons.contains(key) ? 'buttons' : 'other',
    rect: rectOf(key),
  }));
  let remembered;
  try {
    const key = overlay === null ? null : overlay.getAttribute('data-pad-memory');
    remembered = key === null ? null : window.localStorage.getItem(key);
  } catch (error) {
    remembered = 'unavailable';
  }
  return {
    coarse: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : null,
    viewport: { width: innerWidth, height: innerHeight },
    frames: document.querySelectorAll('iframe.gf-frame').length,
    overlayHidden: overlay === null ? null : overlay.hidden,
    estimated: overlay === null ? null : overlay.getAttribute('data-pad-shape'),
    remembered,
    stickShown: shown(stick),
    stickCodes: stick === null ? null : {
      up: stick.getAttribute('data-stick-up'),
      down: stick.getAttribute('data-stick-down'),
      left: stick.getAttribute('data-stick-left'),
      right: stick.getAttribute('data-stick-right'),
    },
    dpadShown: shown(dpad) && dpad.children.length > 0,
    buttonsShown: shown(buttons) && buttons.children.length > 0,
    toggleShown: shown(toggle),
    // 見えている文言だけ（今の形でない方の文言は hidden で持っている）。
    toggleLabel: toggle === null ? null : toggle.innerText.trim(),
    toggleClasses: toggle === null ? null : [...toggle.classList],
    ringShown: shown(ring),
    overlayRect: rectOf(overlay),
    stageRect: rectOf(document.querySelector('.gf-play-stage')),
    stickRect: rectOf(stick),
    dpadRect: rectOf(dpad),
    buttonsRect: rectOf(buttons),
    keys,
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

/**
 * 1 つのタブ（ターゲット）を開き、タッチ端末の形にして、操作と観測の道具を返す。
 *
 * @param {CdpConnection} cdp 接続
 * @param {{timeoutMs: number}} options 設定
 * @param {string[]} initScripts 文書ごとに先に動かすスクリプト
 * @returns {Promise<any>} 道具
 */
async function openTouchTab(cdp, options, initScripts) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  /** @type {Array<{phase: string, entry: any}>} */
  const keyEvents = [];
  /** @type {string[]} */
  const exceptions = [];
  let phase = 'initial';
  let loadCount = 0;
  cdp.on((frame) => {
    if (frame.sessionId !== sessionId) {
      return;
    }
    if (frame.method === 'Page.loadEventFired') {
      loadCount += 1;
    }
    if (frame.method === 'Runtime.exceptionThrown') {
      exceptions.push(String(frame.params.exceptionDetails?.exception?.description ?? frame.params.exceptionDetails?.text));
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
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  for (const source of [SIGNAL_RECORDER, ...initScripts]) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
  }

  const tab = {
    exceptions,
    /** @param {string} next 以後のキーの記録に付ける段階の名前 */
    setPhase(next) {
      phase = next;
    },
    /** @param {string} name 段階 @returns {string[]} その段階で作品が受けたキー（`type:code`） */
    keysIn(name) {
      return keyEvents.filter((event) => event.phase === name).map((event) => `${String(event.entry?.type)}:${String(event.entry?.code)}`);
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
     * 条件が成り立つまで状態を読み続ける。成り立たなければ最後の値を返す。
     *
     * @param {(value: any) => boolean} predicate 条件
     * @returns {Promise<{reached: boolean, state: any}>} 結果
     */
    async waitFor(predicate) {
      const deadline = Date.now() + options.timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = await tab.state();
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
     * 要素の中央の座標（要素が無い・見えなければ null）。
     *
     * @param {string} selector セレクタ
     * @returns {Promise<{x: number, y: number} | null>} 座標
     */
    async centerOf(selector) {
      return tab.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null || element.getClientRects().length === 0) { return null; }
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
    },
    /**
     * タッチを 1 つ送る（`touchEnd` は離す指だけを渡す。`scripts/virtual-pad-probe.mjs` の注記）。
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
    /** @param {{width: number, height: number}} size 大きさ */
    async resize(size) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile: true,
          screenOrientation: size.width > size.height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
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
    /**
     * 作品ページを開いて口をタップし、覆いが開いて合図が届くまで待つ。
     *
     * @param {string} url 作品ページ
     * @returns {Promise<{reached: boolean, state: any}>} 開いた状態
     */
    async openWork(url) {
      await tab.resize(PORTRAIT);
      await tab.navigate(url);
      await tab.tap('.gf-play-entry');
      const opened = await tab.waitFor(openedWithSignal);
      // 合図の直後に、起動した作品が canvas のリスナーを付け終えている（Go の main が合図より前に付ける）。
      await sleep(DELIVERY_MS);
      return opened;
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
  return tab;
}

/**
 * スティックに触れて倒し、段階ごとに作品が受けたキーを集める。
 *
 * @param {any} tab 道具
 * @param {string} name 段階の名前
 * @param {'touchStart' | 'touchMove' | 'touchEnd'} type 種類
 * @param {Array<{x: number, y: number, id: number}>} points 指
 * @returns {Promise<string[]>} 作品が受けたキー
 */
async function step(tab, name, type, points) {
  tab.setPhase(name);
  await tab.touch(type, points);
  await sleep(DELIVERY_MS);
  return tab.keysIn(name);
}

/**
 * スティックに触れて倒した状態を撮り、並べ方の矩形を読む（縦持ちと横持ち）。
 *
 * @param {any} tab 道具
 * @param {string | null} shotDir 撮影先
 * @param {string} prefix ファイル名の接頭辞
 * @param {{dx: number, dy: number}} tilt 倒す向き
 * @returns {Promise<object>} 状態と撮影のパス
 */
async function shootTouching(tab, shotDir, prefix, tilt) {
  /** @type {Record<string, any>} */
  const result = {};
  for (const [name, size] of [
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ]) {
    await tab.resize(size);
    await sleep(500);
    const center = await tab.centerOf('.gf-play-pad-stick');
    if (center === null) {
      result[name] = { error: 'スティックの置き場所が見えません' };
      continue;
    }
    tab.setPhase(`shot-${name}`);
    await tab.touch('touchStart', [{ ...center, id: 9 }]);
    await tab.touch('touchMove', [{ x: center.x + tilt.dx, y: center.y + tilt.dy, id: 9 }]);
    await sleep(DELIVERY_MS);
    const state = await tab.state();
    const knob = await tab.evaluate(`(() => {
      const knob = document.querySelector('.gf-play-stick-knob');
      const ring = document.querySelector('.gf-play-stick-ring');
      if (knob === null || ring === null) { return null; }
      const k = knob.getBoundingClientRect();
      const r = ring.getBoundingClientRect();
      return { knob: { x: k.x + k.width / 2, y: k.y + k.height / 2 }, ring: { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width } };
    })()`);
    const shot = await tab.shoot(
      shotDir === null ? null : join(shotDir, `${prefix}-${name}-${size.width}x${size.height}.png`),
    );
    await tab.touch('touchEnd', []);
    await sleep(DELIVERY_MS);
    result[name] = { state, knob, center, shot, keys: tab.keysIn(`shot-${name}`), ringAfterLift: (await tab.state()).ringShown };
  }
  await tab.resize(PORTRAIT);
  await sleep(500);
  return result;
}

/**
 * 横だけの作品を観測する（スティックの軸・↑ のボタン・同時押し・隠れる・閉じる・切り替え）。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeHorizontal(cdp, options) {
  const tab = await openTouchTab(cdp, options, []);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    steps.opened = await tab.openWork(options.horizontalUrl);
    steps.initial = await tab.state();
    const center = await tab.centerOf('.gf-play-pad-stick');
    const up = await tab.centerOf('.gf-play-pad-buttons .gf-play-pad-key[data-code="ArrowUp"]');
    const space = await tab.centerOf('.gf-play-pad-buttons .gf-play-pad-key[data-code="Space"]');
    steps.points = { center, up, space };
    if (center === null || up === null || space === null) {
      throw new Error('スティックの置き場所か、右のボタンの ↑ / Space が見えません（検査の前提が崩れています）');
    }
    const at = (dx, dy, id = 1) => [{ x: center.x + dx, y: center.y + dy, id }];

    // 1. 軸: 触れる → 右 → 上 → 左 → 下 → 右 → 離す。
    steps.axis = {
      touch: await step(tab, 'axis-touch', 'touchStart', at(0, 0)),
    };
    steps.axis.ringWhileTouching = (await tab.state()).ringShown;
    steps.axis.right = await step(tab, 'axis-right', 'touchMove', at(TILT, 0));
    steps.axis.up = await step(tab, 'axis-up', 'touchMove', at(0, -TILT));
    steps.axis.left = await step(tab, 'axis-left', 'touchMove', at(-TILT, 0));
    steps.axis.down = await step(tab, 'axis-down', 'touchMove', at(0, TILT));
    steps.axis.upRight = await step(tab, 'axis-up-right', 'touchMove', at(TILT, -TILT));
    steps.axis.lift = await step(tab, 'axis-lift', 'touchEnd', []);
    steps.axis.ringAfterLift = (await tab.state()).ringShown;

    // 1. 右のボタンの ↑。
    steps.upButton = {
      down: await step(tab, 'up-button-down', 'touchStart', [{ ...up, id: 2 }]),
      up: await step(tab, 'up-button-up', 'touchEnd', []),
    };

    // 6. 同時押し: スティックを右へ倒したまま Space。
    steps.chord = {
      stickTouch: await step(tab, 'chord-touch', 'touchStart', at(0, 0, 3)),
      stickRight: await step(tab, 'chord-right', 'touchMove', at(TILT, 0, 3)),
      spaceDown: await step(tab, 'chord-space-down', 'touchStart', [...at(TILT, 0, 3), { ...space, id: 4 }]),
      spaceUp: await step(tab, 'chord-space-up', 'touchEnd', [{ ...space, id: 4 }]),
      stickLift: await step(tab, 'chord-stick-lift', 'touchEnd', at(TILT, 0, 3)),
    };

    // 6. 隠れる: 親の文書の visibilitychange（hidden）。**ヘッドレスのタブの見え方は変えられないので、親の受け手に同じ出来事を渡す。**
    steps.hide = {
      stickTouch: await step(tab, 'hide-touch', 'touchStart', at(0, 0, 5)),
      stickRight: await step(tab, 'hide-right', 'touchMove', at(TILT, 0, 5)),
    };
    tab.setPhase('hide-hidden');
    steps.hide.visibility = await tab.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
      return document.visibilityState;
    })()`);
    await sleep(DELIVERY_MS);
    steps.hide.hidden = tab.keysIn('hide-hidden');
    steps.hide.moveAfter = await step(tab, 'hide-move-after', 'touchMove', at(-TILT, 0, 5));
    steps.hide.liftAfter = await step(tab, 'hide-lift-after', 'touchEnd', []);

    // 6. 閉じる: スティックを右へ倒したまま「閉じる」。
    steps.close = {
      stickTouch: await step(tab, 'close-touch', 'touchStart', at(0, 0, 6)),
      stickRight: await step(tab, 'close-right', 'touchMove', at(TILT, 0, 6)),
    };
    tab.setPhase('close-while-held');
    await tab.evaluate(`document.querySelector('.gf-play-close').click()`);
    steps.close.closed = await tab.waitFor((state) => state?.overlayHidden === true && state.frames === 0);
    await sleep(DELIVERY_MS);
    steps.close.whileHeld = tab.keysIn('close-while-held');
    steps.close.liftAfter = await step(tab, 'close-lift-after', 'touchEnd', []);

    // 5. 切り替え: 開き直す（閉じた直後の戻りの決着を待つ）→ 切り替え → 閉じる → 文書を開き直す。
    await sleep(1500);
    await tab.tap('.gf-play-entry');
    steps.toggle = { reopened: await tab.waitFor(openedWithSignal) };
    await sleep(DELIVERY_MS);
    steps.toggle.before = await tab.state();
    steps.toggle.tapped = await tab.tap('.gf-play-pad-toggle');
    await sleep(DELIVERY_MS);
    steps.toggle.after = await tab.state();
    // 十字にした後、十字の ← が効く（形が変わっただけでなく、見えている十字が使える）。
    const dpadLeft = await tab.centerOf('.gf-play-pad-dpad .gf-play-pad-key[data-code="ArrowLeft"]');
    steps.toggle.dpadLeft =
      dpadLeft === null
        ? null
        : {
            down: await step(tab, 'toggle-dpad-left-down', 'touchStart', [{ ...dpadLeft, id: 7 }]),
            up: await step(tab, 'toggle-dpad-left-up', 'touchEnd', []),
          };
    await tab.evaluate(`document.querySelector('.gf-play-close').click()`);
    await tab.waitFor((state) => state?.overlayHidden === true && state.frames === 0);
    await sleep(1500);
    steps.reload = { opened: await tab.openWork(options.horizontalUrl) };
    steps.reload.state = await tab.state();
    steps.exceptions = tab.exceptions.slice();
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * `localStorage` が使えない状態で、横だけの作品を開く（覚えた十字は読めないので、推定したスティックで出るはず）。撮影もここで行う。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeNoStorage(cdp, options) {
  const tab = await openTouchTab(cdp, options, [BREAK_STORAGE]);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    steps.opened = await tab.openWork(options.horizontalUrl);
    steps.initial = await tab.state();
    steps.tapped = await tab.tap('.gf-play-pad-toggle');
    await sleep(DELIVERY_MS);
    steps.afterToggle = await tab.state();
    steps.tappedBack = await tab.tap('.gf-play-pad-toggle');
    await sleep(DELIVERY_MS);
    steps.afterToggleBack = await tab.state();
    steps.exceptions = tab.exceptions.slice();
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * 8 方向の作品を観測する（斜めの同時押し・方向を変えたときの送る順序）。撮影もする。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function observeEight(cdp, options) {
  const tab = await openTouchTab(cdp, options, []);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    steps.opened = await tab.openWork(options.eightUrl);
    steps.initial = await tab.state();
    const center = await tab.centerOf('.gf-play-pad-stick');
    if (center === null) {
      throw new Error('スティックの置き場所が見えません（検査の前提が崩れています）');
    }
    const at = (dx, dy) => [{ x: center.x + dx, y: center.y + dy, id: 1 }];
    const diagonal = Math.round(TILT * Math.SQRT1_2);
    steps.touch = await step(tab, 'eight-touch', 'touchStart', at(0, 0));
    steps.upRight = await step(tab, 'eight-up-right', 'touchMove', at(diagonal, -diagonal));
    steps.left = await step(tab, 'eight-left', 'touchMove', at(-TILT, 0));
    steps.upLeft = await step(tab, 'eight-up-left', 'touchMove', at(-diagonal, -diagonal));
    steps.upRightAgain = await step(tab, 'eight-up-right-again', 'touchMove', at(diagonal, -diagonal));
    steps.lift = await step(tab, 'eight-lift', 'touchEnd', []);
    steps.exceptions = tab.exceptions.slice();
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * 最初の形だけを観測する（十字の作品・版 1 の行の作品・行が無い作品）。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @param {string} url 作品ページ
 * @returns {Promise<object>} 観測結果
 */
async function observeInitial(cdp, options, url) {
  const tab = await openTouchTab(cdp, options, []);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    steps.opened = await tab.openWork(url);
    steps.initial = await tab.state();
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * 撮影する（スティックに触れて倒している状態。縦持ち・横持ち）。**判定には使わないが、並べ方の矩形とつまみの位置は残す。**
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @param {string} url 作品ページ
 * @param {string} prefix ファイル名の接頭辞
 * @param {{dx: number, dy: number}} tilt 倒す向き
 * @returns {Promise<object>} 観測結果
 */
async function observeShots(cdp, options, url, prefix, tilt) {
  const tab = await openTouchTab(cdp, options, [BREAK_STORAGE]);
  try {
    await tab.openWork(url);
    return await shootTouching(tab, options.shotDir, prefix, tilt);
  } catch (error) {
    return { error: String(error) };
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'gf-stick-probe-'));
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
    const diagonal = Math.round(TILT * Math.SQRT1_2);
    return {
      horizontal: await observeHorizontal(cdp, options),
      noStorage: await observeNoStorage(cdp, options),
      eight: await observeEight(cdp, options),
      dpad: await observeInitial(cdp, options, options.dpadUrl),
      v1: await observeInitial(cdp, options, options.v1Url),
      noRow: await observeInitial(cdp, options, options.noRowUrl),
      // 撮影は localStorage を使わない形で開く（1 で覚えた十字ではなく、推定したスティックを撮る）。
      shots: {
        horizontal: await observeShots(cdp, options, options.horizontalUrl, 'stick-horizontal', { dx: TILT, dy: 0 }),
        eight: await observeShots(cdp, options, options.eightUrl, 'stick-eight', { dx: diagonal, dy: -diagonal }),
      },
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
  process.stderr.write(`[stick-pad-probe] 観測できませんでした: ${String(error)}\n`);
  process.exit(1);
}
