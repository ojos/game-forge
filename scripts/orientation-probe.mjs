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
// | `landscapeGranted` | 横長 | 固定できる | 開く → ボタンを押す → 「閉じる」で閉じる → 開き直す（覚えた向き）→ 全画面を解除して閉じる |
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
// `NotSupportedError` で拒む Promise を返し、API が無い形は `lock` を消す。呼ばれた時点で覆いが全画面か（`document.fullscreenElement`）も残す。
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
 * @param {'grant' | 'refuse' | 'absent'} mode 固定できる / 拒む / API が無い
 * @returns {string} ページより先に評価するスクリプト
 */
function orientationStub(mode) {
  return `(() => {
  if (window.top !== window) { return; }
  const record = { locks: [], unlocks: 0 };
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
    locks: record === null ? null : record.locks.slice(),
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
 * @param {'grant' | 'refuse' | 'absent'} mode 固定の API の形
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
 * @param {'grant' | 'refuse' | 'absent'} mode 固定の API の形
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

    // 横長・固定できる: 開く → 入れ替える → 閉じる → 覚えた向きで開き直す → 全画面の解除で閉じる。
    result.landscapeGranted = await observe(cdp, options, 'grant', async (tab, steps) => {
      steps.first = await openOverlay(tab, options.landscapeUrl, PORTRAIT);
      steps.shotFirst = await tab.shoot(shotPath(options, 'orientation-landscape-granted-390x844.png'));
      steps.tappedToggle = await tab.tap('.gf-play-orient-toggle');
      steps.afterToggle = await tab.settled();
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
