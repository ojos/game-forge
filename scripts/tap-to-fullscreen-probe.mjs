// tap-to-fullscreen-probe.mjs — 作品ページの「タップして全画面で遊ぶ」を実ブラウザで操作し、判定材料を JSON で返す（層 7。#502 / 仕様 3.9.4）。
//
// # 何を観測するか
//
// 同じブラウザで、同じ作品ページ（`/works/<id>`）を 3 つの形で開く。
//
// 1. **タッチ端末**（390×844、`Emulation.setTouchEmulationEnabled`）。`matchMedia('(pointer: coarse)')` が実際に true に
//    なったことを読んだうえで、
//    - 開いてから落ち着くまでに、**サンドボックス用ホストへ出た要求**（`Network.requestWillBeSent`）
//    - 口（スクリーンショット）を CDP の `Input.dispatchTouchEvent` でタップした後の覆い・iframe・起動の合図
//    - 縦持ちのまま撮り、横持ち（844×390）に変えて並べ方を読んで撮る（`--shot-dir` を渡したときだけ撮る）
//    - 「閉じる」をタップした後、もう一度開いた後、**戻る操作**（`Page.navigateToHistoryEntry`）の後
//    - もう一度開き、**iframe の中の文書を読み直させた**（2 回目の `load`。仕様 3.9.7）後
//    - もう一度開き、**全画面を解除した**後（全画面に入れた環境だけ。入れたかどうかも残す）
//    - プレイ数の計上（`POST /api/plays`）の回数。**2 回目を開く前に sessionStorage を消す**——消しても 2 回目が数えられない
//      なら、効いているのは同じページの中の畳み方（`src/plays.ts` の `reported`。#377）である
// 2. **デスクトップ**（1280×900、タッチなし）。開いた時点の iframe の属性と位置
// 3. **JavaScript を止めた**デスクトップ（`Emulation.setScriptExecutionDisabled`）。`<noscript>` の中の iframe
//
// # このファイルは判定しない
//
// 合否は `scripts/tap-to-fullscreen-verdict.mjs` が持つ（観測と判定を分ける理由は `scripts/sandbox-browser-probe.mjs` の冒頭）。
//
// # 観測のために足すもの
//
// **主文書に `message` の記録係を 1 つだけ足す**（`Page.addScriptToEvaluateOnNewDocument`。ページのスクリプトより先に動く）。
// 起動の合図は親の文書にしか届かず、ページは届いたことを画面に出さないためである。記録係は受け取るだけで、何も送らない。
// iframe の中の読み直しは、その文書の**隔離された世界**（`Page.createIsolatedWorld`）から `location.reload()` を呼ぶ——
// 作品が自分の枠を遷移させることの代わりである（作品の文書の大域には何も足さない）。
//
// 使い方:
//   node scripts/tap-to-fullscreen-probe.mjs --browser <path> --url <作品ページ> --sandbox-host <host> [--timeout-ms 45000] [--shot-dir <dir>]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, POLL_INTERVAL_MS, launchBrowser, openSocket } from './lib/cdp.mjs';

/** 既定の待ち時間（1 つの状態に届くまで）。 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** 読み込みが終わってから、要求が出ないことを見届けるまでの時間。 */
const SETTLE_MS = 2_000;

/** 縦持ちと横持ちの大きさ（issue #502 の acceptance の撮影の大きさ）。 */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/** デスクトップの大きさ（段 3）。 */
const DESKTOP = { width: 1280, height: 900 };

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, url: string, sandboxHost: string, timeoutMs: number, shotDir: string | null}} 設定
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
  const sandboxHost = values['sandbox-host'];
  if (browser === undefined || url === undefined || sandboxHost === undefined) {
    throw new Error('--browser と --url と --sandbox-host は必須です');
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return { browser, url, sandboxHost, timeoutMs, shotDir: values['shot-dir'] ?? null };
}

/**
 * 主文書に足す記録係（起動の合図を受け取った事実だけを残す）。
 *
 * **主文書でだけ動く**（同じスクリプトは iframe の文書でも評価されるため、`top` と比べて抜ける）。
 * 合図が「いま覆いの中にある iframe」から届いたかを、受け取った時点で `event.source` と比べて残す。
 */
const SIGNAL_RECORDER = `(() => {
  if (window.top !== window) { return; }
  window.__gfSignals = [];
  window.addEventListener('message', (event) => {
    const frame = document.querySelector('iframe.gf-frame');
    window.__gfSignals.push({
      data: typeof event.data === 'string' ? event.data : null,
      origin: String(event.origin),
      fromCurrentFrame: frame !== null && event.source === frame.contentWindow,
    });
  });
})();`;

/** 作品ページの状態を読む式。 */
const STATE_EXPRESSION = `(() => {
  const rectOf = (element) => {
    if (element === null) { return null; }
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const overlay = document.querySelector('.gf-play-overlay');
  const stage = document.querySelector('.gf-play-stage');
  const openButton = document.querySelector('.gf-play-open');
  const closeButton = document.querySelector('.gf-play-close');
  const frames = [...document.querySelectorAll('iframe')].map((frame) => ({
    attributes: [...frame.attributes].map((attribute) => [attribute.name, attribute.value]),
    parentTag: frame.parentElement === null ? null : frame.parentElement.tagName,
    inStage: stage !== null && stage.contains(frame),
    previousTag: frame.previousElementSibling === null ? null : frame.previousElementSibling.tagName,
    nextTag: frame.nextElementSibling === null ? null : frame.nextElementSibling.tagName,
    rect: rectOf(frame),
  }));
  return {
    readyState: document.readyState,
    coarse: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : null,
    viewport: { width: innerWidth, height: innerHeight },
    frames,
    overlayPresent: overlay !== null,
    overlayHidden: overlay === null ? null : overlay.hidden,
    overlayDisplay: overlay === null ? null : getComputedStyle(overlay).display,
    overlayRect: rectOf(overlay),
    stageRect: rectOf(stage),
    closeRect: rectOf(closeButton),
    openHidden: openButton === null ? null : openButton.hidden,
    openDisplay: openButton === null ? null : getComputedStyle(openButton).display,
    entryRect: rectOf(document.querySelector('.gf-play-entry')),
    locked: document.documentElement.classList.contains('gf-play-locked'),
    fullscreen: document.fullscreenElement === null ? null : document.fullscreenElement === overlay ? 'overlay' : 'other',
    signals: Array.isArray(window.__gfSignals) ? window.__gfSignals.slice() : null,
    historyLength: history.length,
  };
})()`;

/**
 * 1 つのタブ（ターゲット）を開き、操作と観測の道具を返す。
 *
 * @param {CdpConnection} cdp 接続
 * @param {{timeoutMs: number, sandboxHost: string}} options 設定
 * @returns {Promise<any>} 道具
 */
async function openTab(cdp, options) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  /** @type {Array<{phase: string, url: string, method: string}>} */
  const requests = [];
  let phase = 'initial';
  let loadCount = 0;
  cdp.on((frame) => {
    if (frame.sessionId !== sessionId) {
      return;
    }
    if (frame.method === 'Page.loadEventFired') {
      loadCount += 1;
    }
    if (frame.method === 'Network.requestWillBeSent') {
      requests.push({ phase, url: String(frame.params.request.url), method: String(frame.params.request.method) });
    }
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);

  const tab = {
    sessionId,
    requests,
    /** @param {string} next 以後の要求に付ける段階の名前 */
    setPhase(next) {
      phase = next;
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
     * 条件が成り立つまで状態を読み続ける。成り立たなければ最後の状態を返す（観測値を残す）。
     *
     * @param {(state: any) => boolean} predicate 条件
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
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      return { reached: false, state: last };
    },
    /** @param {string} url 開く URL */
    async navigate(url) {
      const before = loadCount;
      await cdp.send('Page.navigate', { url }, sessionId);
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline && loadCount === before) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (loadCount === before) {
        throw new Error(`読み込みが終わりませんでした: ${url}`);
      }
    },
    /**
     * 要素の中央を指 1 本でタップする（画面の中へ入れてから）。
     *
     * @param {string} selector セレクタ
     * @returns {Promise<{x: number, y: number} | null>} タップした座標（要素が無ければ null）
     */
    async tap(selector) {
      const point = await tab.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null) { return null; }
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      if (point === null) {
        return null;
      }
      const touchPoints = [{ x: point.x, y: point.y, id: 0 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints }, sessionId);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
      return point;
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
    /** 戻る操作（ブラウザの「戻る」と同じく、履歴の 1 つ前の項目へ移る）。 */
    async back() {
      const history = await cdp.send('Page.getNavigationHistory', {}, sessionId);
      const previous = history.entries[history.currentIndex - 1];
      if (previous === undefined) {
        return false;
      }
      await cdp.send('Page.navigateToHistoryEntry', { entryId: previous.id }, sessionId);
      return true;
    },
    /** 覆いの中の iframe の文書を読み直させる（2 回目の load。作品が自分の枠を遷移させることの代わり）。 */
    async reloadChildFrame() {
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
      const child = (frameTree.childFrames ?? [])[0];
      if (child === undefined) {
        return false;
      }
      const { executionContextId } = await cdp.send(
        'Page.createIsolatedWorld',
        { frameId: child.frame.id, worldName: 'gf-tap-to-fullscreen-probe' },
        sessionId,
      );
      await cdp.send('Runtime.evaluate', { expression: 'location.reload()', contextId: executionContextId }, sessionId);
      return true;
    },
    /** @param {string} path パス @returns {number} その段階までに出た POST の数 */
    postsTo(path) {
      return requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname === path).length;
    },
    /** @param {string} phaseName 段階 @returns {string[]} その段階でサンドボックス用ホストへ出た要求 */
    sandboxRequestsIn(phaseName) {
      return requests
        .filter((request) => request.phase === phaseName && hostOf(request.url) === options.sandboxHost)
        .map((request) => request.url);
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
  return tab;
}

/**
 * URL のホスト名（読めなければ空文字）。
 *
 * @param {string} url URL
 * @returns {string} ホスト名
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 覆いが開き、覆いの中の iframe から起動の合図が `count` 個目まで届いたか。
 *
 * @param {number} count 合図の数
 * @returns {(state: any) => boolean} 条件
 */
function openedWithSignals(count) {
  return (state) =>
    state?.overlayHidden === false &&
    state.frames.length === 1 &&
    state.frames[0].inStage === true &&
    Array.isArray(state.signals) &&
    state.signals.filter((signal) => signal.fromCurrentFrame && signal.data === 'gf-loader-started').length >= count;
}

/**
 * 覆いが閉じ、iframe が 1 つも無いか。
 *
 * @param {any} state 状態
 * @returns {boolean} 閉じたか
 */
function closed(state) {
  return state?.overlayHidden === true && state.frames.length === 0;
}

/**
 * タッチ端末の形を観測する。
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SIGNAL_RECORDER }, tab.sessionId);

    tab.setPhase('before-tap');
    await tab.navigate(options.url);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    steps.beforeTap = await tab.state();
    steps.shotEntry = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'entry-portrait-390x844.png'));

    // 1 回目: 口をタップして開く。
    tab.setPhase('open-1');
    steps.tapEntry = await tab.tap('.gf-play-entry');
    steps.opened = await tab.waitFor(openedWithSignals(1));
    steps.shotPortrait = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'overlay-portrait-390x844.png'));
    await tab.resize(LANDSCAPE, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    steps.landscape = await tab.state();
    steps.shotLandscape = await tab.shoot(options.shotDir === null ? null : join(options.shotDir, 'overlay-landscape-844x390.png'));
    await tab.resize(PORTRAIT, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    steps.portrait = await tab.state();
    steps.playsAfterFirstOpen = tab.postsTo('/api/plays');

    // 「閉じる」のボタンで閉じる。
    tab.setPhase('close-button');
    steps.tapClose = await tab.tap('.gf-play-close');
    steps.closedByButton = await tab.waitFor(closed);

    // 2 回目: sessionStorage を消してから開き直す（同じページの中の畳み方だけで数えないことを見る）。
    await tab.evaluate('sessionStorage.clear()');
    tab.setPhase('open-2');
    steps.tapEntryAgain = await tab.tap('.gf-play-entry');
    steps.reopened = await tab.waitFor(openedWithSignals(2));
    // 合図が届いてから計上の要求が出るまでの間を置く。
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    steps.playsAfterSecondOpen = tab.postsTo('/api/plays');

    // 戻る操作で閉じる。
    tab.setPhase('back');
    steps.backNavigated = await tab.back();
    steps.closedByBack = await tab.waitFor(closed);

    // 3 回目: 開いて、iframe の中の文書を読み直させる（2 回目の load）。
    tab.setPhase('open-3');
    steps.tapEntryThird = await tab.tap('.gf-play-entry');
    steps.thirdOpened = await tab.waitFor(openedWithSignals(3));
    tab.setPhase('child-reload');
    steps.childReloaded = await tab.reloadChildFrame();
    steps.closedByChildNavigation = await tab.waitFor(closed);

    // 4 回目: 開いて、全画面を解除する（全画面に入れた環境でだけ意味を持つ。入れたかどうかも観測値に残す）。
    tab.setPhase('open-4');
    steps.tapEntryFourth = await tab.tap('.gf-play-entry');
    steps.fourthOpened = await tab.waitFor(openedWithSignals(4));
    steps.fullscreenAfterOpen = steps.fourthOpened.state?.fullscreen ?? null;
    if (steps.fullscreenAfterOpen === 'overlay') {
      tab.setPhase('exit-fullscreen');
      await tab.evaluate('document.exitFullscreen()');
      steps.closedByFullscreenExit = await tab.waitFor(closed);
    }

    steps.sandboxRequestsBeforeTap = tab.sandboxRequestsIn('before-tap');
    steps.sandboxRequestsAfterTap = tab.sandboxRequestsIn('open-1');
    steps.playsTotal = tab.postsTo('/api/plays');
    return steps;
  } catch (error) {
    steps.error = String(error);
    return steps;
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * デスクトップの形を観測する（JavaScript を止めた形も）。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @param {boolean} scriptDisabled JavaScript を止めるか
 * @returns {Promise<object>} 観測結果
 */
async function observeDesktop(cdp, options, scriptDisabled) {
  const tab = await openTab(cdp, options);
  /** @type {Record<string, any>} */
  const steps = {};
  try {
    await tab.resize(DESKTOP, false);
    if (scriptDisabled) {
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, tab.sessionId);
    }
    tab.setPhase('load');
    await tab.navigate(options.url);
    // **読み込みが終わった時点の状態を先に読む**（デスクトップは「開いた時点で iframe がある」ことを見る）。
    steps.loaded = await tab.state();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    steps.sandboxRequests = tab.sandboxRequestsIn('load');
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'gf-tap-probe-'));
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
      sandboxHost: options.sandboxHost,
      touch: await observeTouch(cdp, options),
      desktop: await observeDesktop(cdp, options, false),
      noscript: await observeDesktop(cdp, options, true),
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
  process.stderr.write(`[tap-probe] 観測できませんでした: ${String(error)}\n`);
  process.exit(1);
}
