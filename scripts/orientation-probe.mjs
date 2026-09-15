// orientation-probe.mjs — 作品のおすすめの向きで覆いを開き、入れ替えられることを実ブラウザで操作し、判定材料を JSON で返す（層 10。#514 / 仕様 3.9.4）。
//
// # 何を観測するか
//
// タッチ端末の形（390×844、`Emulation.setTouchEmulationEnabled`）で作品ページを開き、口をタップして覆いを開いてから、
// 覆いの上の行（向きを入れ替えるボタン・案内・十字 / スティックの切り替え・「閉じる」）と、`screen.orientation.lock()` /
// `unlock()` の呼ばれ方を読む。**作品は 4 つ**（横長で方向の操作がある作品・縦長の作品・正方形の作品・論理解像度の無い作品）。
//
// | 段 | 作品 | 固定の API | 操作 |
// |---|---|---|---|
// | `landscapeGranted` | 横長 | 固定できる | 縦持ちで開く → 横持ちに回す → ボタンを押す → 縦持ちに回す → 「閉じる」で閉じる → 開き直す（覚えた向き）→ 全画面を解除して閉じる |
// | `portraitPending` | 縦長 | 固定が決着しない（#572） | 縦持ちで開く → ボタンを押す → 横持ちに回す → 古い固定の拒否（AbortError）を遅れて届ける → 閉じる → 縦持ちで開き直す（覚えた向き）→ 横持ちに回す → ボタンを押す → 縦持ちに回す → 最新の固定を拒む |
// | `landscapeRefused` | 横長 | 固定を拒む | 縦持ちで開く → 横持ちに回す → 縦持ちに戻す → 閉じる |
// | `landscapeAbsent` | 横長 | API が無い | 縦持ちで開く |
// | `portraitGranted` | 縦長 | 固定できる | 開く |
// | `portraitRefused` | 縦長 | 固定を拒む | 横持ちで開く |
// | `square` / `noLayout` | 正方形 / 解像度が無い | 固定できる | 開く → 閉じる |
//
// # 観測のために足すもの（ページより先に動く。主文書だけ）
//
// **ヘッドレスの Chromium の `screen.orientation.lock()` は実機と同じ結果にならない**（端末の向きを持たない）ので、`ScreenOrientation` の
// `lock` / `unlock` を**呼ばれた記録を残す差し替え**にする（`Page.addScriptToEvaluateOnNewDocument`）。固定できる形は解決する Promise、拒む形は
// `NotSupportedError` で拒む Promise、**決着しない形（#572。Android の Chrome の実機で、覚えた向きで固定を頼むと Promise が決着しないことがあった）は
// 検査が後から拒める Promise**（`window.__gfOrientation.reject(番号, 名前)`）を返し、API が無い形は `lock` を消す。呼ばれた時点で覆いが全画面か
// （`document.fullscreenElement`）も残す。
//
// **差し替えの lock は画面を回さない。** 実機で固定したときの画面の回転は、固定の呼ばれ方を見てから検査が `Emulation.setDeviceMetricsOverride`
// （幅・高さと `screenOrientation`）で起こす。ボタンの文言は今見えている向きで決まる（#572）ので、回す前と回した後の両方を読む。
// **ページのスクリプトには手を入れない**（固定の判定・ボタン・案内・覚える処理は、配信した本物のスクリプトが動く）。
//
// # このファイルは判定しない
//
// 合否は `scripts/orientation-verdict.mjs` が持つ（観測と判定を分ける理由は `scripts/sandbox-browser-probe.mjs` の冒頭）。
//
// 使い方:
//   node scripts/orientation-probe.mjs --browser <path> --landscape-url <作品ページ> --portrait-url <作品ページ>
//     --square-url <作品ページ> --no-layout-url <作品ページ> [--timeout-ms 45000] [--shot-dir <dir>]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, POLL_INTERVAL_MS, launchBrowser, openSocket } from './lib/cdp.mjs';

/** 既定の待ち時間（1 つの状態に届くまで）。 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** 何かが起きないことを見届けるまでの時間（固定の要求が決着するまで・案内が変わるまで）。 */
const SETTLE_MS = 1_000;

/** 縦持ちと横持ちの大きさ（層 7 と同じ）。 */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, landscapeUrl: string, portraitUrl: string, squareUrl: string, noLayoutUrl: string, timeoutMs: number, shotDir: string | null}} 設定
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
  const required = ['browser', 'landscape-url', 'portrait-url', 'square-url', 'no-layout-url'];
  for (const name of required) {
    if (values[name] === undefined) {
      throw new Error(`--${name} は必須です`);
    }
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return {
    browser: values.browser,
    landscapeUrl: values['landscape-url'],
    portraitUrl: values['portrait-url'],
    squareUrl: values['square-url'],
    noLayoutUrl: values['no-layout-url'],
    timeoutMs,
    shotDir: values['shot-dir'] ?? null,
  };
}

/**
 * `screen.orientation` の差し替え（主文書だけ）。
 *
 * @param {'grant' | 'refuse' | 'pending' | 'absent'} mode 固定できる / 拒む / 決着しない（検査が後から拒める）/ API が無い
 * @returns {string} ページより先に評価するスクリプト
 */
function orientationStub(mode) {
  return `(() => {
  if (window.top !== window) { return; }
  const rejecters = [];
  const record = {
    locks: [],
    unlocks: 0,
    // 決着しない形で、番号の固定を後から拒む（呼べたら true）。
    reject(index, name) {
      const rejecter = rejecters[index];
      if (typeof rejecter !== 'function') { return false; }
      rejecters[index] = null;
      rejecter(new DOMException('検査の差し替えが拒んだ', name));
      return true;
    },
  };
  window.__gfOrientation = record;
  const proto = typeof ScreenOrientation === 'function' ? ScreenOrientation.prototype : null;
  if (proto === null) { record.error = 'ScreenOrientation が無い'; return; }
  const mode = ${JSON.stringify(mode)};
  if (mode === 'absent') {
    Object.defineProperty(proto, 'lock', { value: undefined, configurable: true, writable: true });
  } else {
    Object.defineProperty(proto, 'lock', {
      configurable: true,
      writable: true,
      value: function (orientation) {
        const overlay = document.querySelector('.gf-play-overlay');
        record.locks.push({
          orientation: String(orientation),
          fullscreen: document.fullscreenElement === null ? null : document.fullscreenElement === overlay ? 'overlay' : 'other',
        });
        if (mode === 'pending') {
          return new Promise((resolve, reject) => { rejecters.push(reject); });
        }
        rejecters.push(null);
        return mode === 'grant' ? Promise.resolve() : Promise.reject(new DOMException('検査の差し替えが拒んだ', 'NotSupportedError'));
      },
    });
  }
  Object.defineProperty(proto, 'unlock', {
    configurable: true,
    writable: true,
    value: function () { record.unlocks += 1; },
  });
})();`;
}

/** 覆いと上の行の状態を読む式。 */
const STATE_EXPRESSION = `(() => {
  const rectOf = (element) => {
    if (element === null) { return null; }
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const shown = (element) => element !== null && !element.hidden && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0;
  const overlay = document.querySelector('.gf-play-overlay');
  const bar = document.querySelector('.gf-play-bar');
  const toggle = document.querySelector('.gf-play-orient-toggle');
  const hint = document.querySelector('.gf-play-orient-hint');
  const record = window.__gfOrientation ?? null;
  let memory = null;
  let memoryError = null;
  try {
    const key = overlay === null ? null : overlay.getAttribute('data-orientation-memory');
    memory = key === null ? null : localStorage.getItem(key);
  } catch (error) {
    memoryError = String(error);
  }
  const barChildren = bar === null ? [] : [...bar.children].filter(shown).map((child) => ({
    className: child.className,
    rect: rectOf(child),
    scrollWidth: child.scrollWidth,
    clientWidth: child.clientWidth,
  }));
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    portrait: matchMedia('(orientation: portrait)').matches,
    viewport: { width: innerWidth, height: innerHeight },
    overlayOpen: overlay !== null && !overlay.hidden,
    frames: document.querySelectorAll('.gf-play-stage iframe').length,
    fullscreen: document.fullscreenElement === null ? null : document.fullscreenElement === overlay ? 'overlay' : 'other',
    orientationAttribute: overlay === null ? null : overlay.getAttribute('data-orientation'),
    memoryAttribute: overlay === null ? null : overlay.getAttribute('data-orientation-memory'),
    toggleExists: toggle !== null,
    toggleShown: shown(toggle),
    toggleLabel: toggle === null ? null : [...toggle.querySelectorAll('[data-orient-label]')].filter((span) => !span.hidden).map((span) => span.textContent),
    toggleClasses: toggle === null ? null : [...toggle.classList],
    toggleRect: rectOf(toggle),
    hintExists: hint !== null,
    hintShown: shown(hint),
    hintText: hint === null ? null : hint.textContent,
    hintRect: rectOf(hint),
    padToggleShown: shown(document.querySelector('.gf-play-pad-toggle')),
    closeRect: rectOf(document.querySelector('.gf-play-close')),
    barRect: rectOf(bar),
    barScrollWidth: bar === null ? null : bar.scrollWidth,
    barClientWidth: bar === null ? null : bar.clientWidth,
    barChildren,
    locks: record === null || !Array.isArray(record.locks) ? null : record.locks.slice(),
    unlocks: record === null ? null : record.unlocks,
    stubError: record === null ? 'record が無い' : (record.error ?? null),
    memory,
    memoryError,
  };
})()`;

/**
 * 1 つのタブを開き、操作と観測の道具を返す。
 *
 * @param {CdpConnection} cdp 接続
 * @param {{timeoutMs: number}} options 設定
 * @param {'grant' | 'refuse' | 'pending' | 'absent'} mode 固定の API の形
 * @returns {Promise<any>} 道具
 */
async function openTab(cdp, options, mode) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  let loadCount = 0;
  /** @type {string[]} */
  const exceptions = [];
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
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: orientationStub(mode) }, sessionId);

  const tab = {
    sessionId,
    exceptions,
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
    /** 何かが起きないことを見届けてから状態を読む。 */
    async settled() {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return tab.state();
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
     * 要素の中央を指 1 本でタップする。
     *
     * @param {string} selector セレクタ
     * @returns {Promise<{x: number, y: number} | null>} タップした座標（要素が無ければ null）
     */
    async tap(selector) {
      const point = await tab.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null) { return null; }
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) { return null; }
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
    async close() {
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
  return tab;
}

/**
 * 覆いが開いたか。
 *
 * @param {any} state 状態
 * @returns {boolean} 開いたか
 */
function opened(state) {
  return state?.overlayOpen === true && state.frames === 1;
}

/**
 * 覆いが閉じたか。
 *
 * @param {any} state 状態
 * @returns {boolean} 閉じたか
 */
function closed(state) {
  return state?.overlayOpen === false && state.frames === 0;
}

/**
 * 作品ページをタッチ端末の形で開き、口をタップして覆いを開く。
 *
 * @param {any} tab 道具
 * @param {string} url 作品ページ
 * @param {{width: number, height: number}} size 大きさ
 * @returns {Promise<object>} 開いた後の観測
 */
async function openOverlay(tab, url, size) {
  await tab.resize(size);
  await tab.navigate(url);
  const loaded = await tab.state();
  const tapped = await tab.tap('.gf-play-entry');
  const open = await tab.waitFor(opened);
  // 全画面の要求と固定の要求が決着するまで待つ。
  const settled = await tab.settled();
  return { loaded, tapped, opened: open.reached, state: settled };
}

/**
 * 1 つの段を観測する（タブを開いて閉じる）。
 *
 * @param {CdpConnection} cdp 接続
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @param {'grant' | 'refuse' | 'pending' | 'absent'} mode 固定の API の形
 * @param {(tab: any, steps: Record<string, any>) => Promise<void>} run 操作
 * @returns {Promise<object>} 観測結果
 */
async function observe(cdp, options, mode, run) {
  const tab = await openTab(cdp, options, mode);
  /** @type {Record<string, any>} */
  const steps = { mode };
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, tab.sessionId);
    await run(tab, steps);
  } catch (error) {
    steps.error = String(error);
  } finally {
    steps.exceptions = tab.exceptions.slice();
    await tab.close().catch(() => {});
  }
  return steps;
}

/**
 * 撮影の保存先。
 *
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @param {string} name ファイル名
 * @returns {string | null} 保存先
 */
function shotPath(options, name) {
  return options.shotDir === null ? null : join(options.shotDir, name);
}

/**
 * 観測する。
 *
 * @param {ReturnType<typeof parseArgs>} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function probe(options) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'gf-orientation-probe-'));
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
    const result = {};

    // 横長・固定できる: 縦持ちで開く → 固定した向き（横）に回す → 入れ替える → 入れ替えた向き（縦）に回す → 閉じる → 覚えた向きで開き直す
    // → 全画面の解除で閉じる。
    result.landscapeGranted = await observe(cdp, options, 'grant', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.landscapeUrl, PORTRAIT);
      steps.shotFirst = await tab.shoot(shotPath(options, 'orientation-landscape-granted-390x844.png'));
      await tab.resize(LANDSCAPE);
      steps.rotatedFirst = await tab.settled();
      steps.tappedToggle = await tab.tap('.gf-play-orient-toggle');
      steps.afterToggle = await tab.settled();
      await tab.resize(PORTRAIT);
      steps.afterToggleRotated = await tab.settled();
      steps.tappedClose = await tab.tap('.gf-play-close');
      steps.closedByButton = await tab.waitFor(closed);
      // 閉じるときに始めた戻りの決着を待つ（src/work-play.ts の開き直しの待ち）。
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      steps.afterClose = await tab.state();
      steps.tappedEntryAgain = await tab.tap('.gf-play-entry');
      steps.reopened = (await tab.waitFor(opened)).reached;
      steps.second = await tab.settled();
      if (steps.second.fullscreen === 'overlay') {
        await tab.evaluate('document.exitFullscreen()');
        steps.closedByFullscreenExit = await tab.waitFor(closed);
        steps.afterFullscreenExit = await tab.settled();
      }
      // 覚えた向きを消す（同じブラウザの後の段が、おすすめの向きから始まるように）。
      await tab.evaluate('localStorage.clear()');
    });

    // 縦長・固定が決着しない（#572 の実機の形）: 覚えた向きが無い回と、覚えた向きで開き直した回の両方で、決着を待たずにボタンが出ること、
    // 文言が今見えている向きの逆になること、押すと逆の向きで固定を頼んで覚えること、古い固定の拒否が遅れて届いてもボタンが隠れないこと、
    // 最新の入れ替えが拒まれたら覚えた値が押す前に戻りボタンは出たままであることを見る。
    result.portraitPending = await observe(cdp, options, 'pending', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.portraitUrl, PORTRAIT);
      steps.tappedToggle = await tab.tap('.gf-play-orient-toggle');
      steps.afterToggle = await tab.settled();
      await tab.resize(LANDSCAPE);
      steps.afterToggleRotated = await tab.settled();
      // 開いたときの固定（番号 0）の取り消しが、入れ替えの固定（番号 1）の後に遅れて届く（Chrome は新しい固定で前の固定を AbortError で取り消す）。
      steps.abortedOld = await tab.evaluate("window.__gfOrientation.reject(0, 'AbortError')");
      steps.afterAbort = await tab.settled();
      steps.tappedClose = await tab.tap('.gf-play-close');
      steps.closedByButton = await tab.waitFor(closed);
      // 閉じると固定が外れ、端末の持ち方（縦持ち）に戻る。
      await tab.resize(PORTRAIT);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      steps.afterClose = await tab.state();
      steps.tappedEntryAgain = await tab.tap('.gf-play-entry');
      steps.reopened = (await tab.waitFor(opened)).reached;
      steps.second = await tab.settled();
      await tab.resize(LANDSCAPE);
      steps.secondRotated = await tab.settled();
      steps.tappedToggleAgain = await tab.tap('.gf-play-orient-toggle');
      steps.afterSecondToggle = await tab.settled();
      await tab.resize(PORTRAIT);
      steps.afterSecondToggleRotated = await tab.settled();
      // 最新の入れ替えの固定を拒む（覚えた値は押す前に戻り、ボタンは出たまま）。
      steps.refusedLatest = await tab.evaluate(
        "window.__gfOrientation.reject(window.__gfOrientation.locks.length - 1, 'NotSupportedError')",
      );
      steps.afterRefuseLatest = await tab.settled();
      // 押した直後に閉じ、その後で最新の入れ替えの固定が拒まれる（PR #573 の Copilot の指摘）: 閉じた後でも覚えた値を押す前に戻す。
      await tab.resize(LANDSCAPE);
      steps.beforeClosedRefuse = await tab.settled();
      steps.tappedToggleBeforeClose = await tab.tap('.gf-play-orient-toggle');
      steps.tappedCloseAfterToggle = await tab.tap('.gf-play-close');
      steps.closedAfterToggle = await tab.waitFor(closed);
      steps.refusedAfterClose = await tab.evaluate(
        "window.__gfOrientation.reject(window.__gfOrientation.locks.length - 1, 'NotSupportedError')",
      );
      steps.afterRefuseAfterClose = await tab.settled();
      // 押した直後に閉じ、閉じるときの unlock で最新の固定が取り消される（AbortError）: 取り消しは拒否ではないので、覚えた値は入れ替え先のまま。
      await tab.resize(PORTRAIT);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      steps.tappedEntryThird = await tab.tap('.gf-play-entry');
      steps.reopenedThird = (await tab.waitFor(opened)).reached;
      await tab.resize(LANDSCAPE);
      steps.third = await tab.settled();
      steps.tappedToggleThird = await tab.tap('.gf-play-orient-toggle');
      steps.tappedCloseThird = await tab.tap('.gf-play-close');
      steps.closedThird = await tab.waitFor(closed);
      steps.abortedAfterClose = await tab.evaluate("window.__gfOrientation.reject(window.__gfOrientation.locks.length - 1, 'AbortError')");
      steps.afterAbortAfterClose = await tab.settled();
      await tab.evaluate('localStorage.clear()');
    });

    // 横長・固定を拒む: 縦持ちで開く（案内が出る）→ 横持ちに回す（消える）→ 縦持ちに戻す（また出る）→ 閉じる（消える）。
    result.landscapeRefused = await observe(cdp, options, 'refuse', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.landscapeUrl, PORTRAIT);
      steps.shotFirst = await tab.shoot(shotPath(options, 'orientation-landscape-refused-390x844.png'));
      await tab.resize(LANDSCAPE);
      steps.rotated = await tab.settled();
      await tab.resize(PORTRAIT);
      steps.rotatedBack = await tab.settled();
      steps.tappedClose = await tab.tap('.gf-play-close');
      steps.closed = await tab.waitFor(closed);
    });

    // 横長・API が無い（iPhone の Safari の形）: 縦持ちで開く。
    result.landscapeAbsent = await observe(cdp, options, 'absent', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.landscapeUrl, PORTRAIT);
    });

    // 縦長・固定できる: 開く。
    result.portraitGranted = await observe(cdp, options, 'grant', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.portraitUrl, PORTRAIT);
    });

    // 縦長・固定を拒む: 横持ちで開く（案内が出る）。
    result.portraitRefused = await observe(cdp, options, 'refuse', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.portraitUrl, LANDSCAPE);
      steps.shotFirst = await tab.shoot(shotPath(options, 'orientation-portrait-refused-844x390.png'));
    });

    // 正方形・解像度が無い: 開いて閉じる（固定も解除も呼ばない）。
    for (const [name, url] of [
      ['square', options.squareUrl],
      ['noLayout', options.noLayoutUrl],
    ]) {
      result[name] = await observe(cdp, options, 'grant', async (tab, steps) => {
        steps.first = await openOverlay(tab, url, PORTRAIT);
        steps.tappedClose = await tab.tap('.gf-play-close');
        steps.closed = await tab.waitFor(closed);
        steps.afterClose = await tab.settled();
      });
    }
    return result;
  } finally {
    child.kill('SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

try {
  const result = await probe(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`[orientation-probe] 観測できませんでした: ${String(error)}\n`);
  process.exit(1);
}
