// trial-recording-browser-probe.mjs — 試用の録画（#978）を実ブラウザ（headless の Chromium）で通し、観測を JSON で返す。
//
// # 何を通すか
//
// 偽のマイクと画面（`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`）を与えた Chromium で、
// 手元の dev サーバの `/trial` を録画の準備の段から開き、次を順に行う。
//
//   1. 「録画を始める」を押す → 録画が始まり、自由に触る段へ**ページを読み込み直さずに**進む
//   2. 断片を 2 つ以上送らせる
//   3. **断片の口を CDP の Fetch で落とし**、送れない断片が溜まって画面に量が出ることを見る → 戻すと送り切る
//   4. 振り返り 1 の段で、映像の線に `ended` を送って「共有を停止」を再現する → 止まった理由が出て、
//      「録画を再開する」が出る → 押して録画を再開する
//   5. 振り返り 5 まで進め、アンケートの段で録画が止まり、残りを送り切る → アンケートを送って終える
//   6. 管理画面で「録画を落とす」を押し、つないだ 1 本を `<video>` で開いて、映像と声が復号できることを見る
//
// **「共有を停止」は合図を合成して再現する。** 本物は利用者がブラウザの帯のボタンを押したときに映像の線が
// `ended` になる。headless には帯が無いので、ページより先に `getDisplayMedia` を包んで線を拾っておき、
// 同じ `ended` の合図を送る（スクリプトが聞いているのはこの合図だけである）。
//
// # このファイルは判定しない
//
// 開いて、操作して、観測を JSON で出すだけである。**合否は scripts/check-trial-recording-browser.sh が決める**
// （`scripts/page-width-probe.mjs` と同じ分け方）。
//
// 依存を足さない（Chromium を直接起動して CDP を素で話す。`scripts/lib/cdp.mjs` の接続を使う）。
//
// 使い方:
//   node scripts/trial-recording-browser-probe.mjs --browser <path> --base <origin> --admin-base <origin> \
//     --cookie <name=value> [--timeout-ms 30000]
//
// 標準出力: 観測結果 1 個の JSON / 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, LAUNCH_TIMEOUT_MS, POLL_INTERVAL_MS, openSocket } from './lib/cdp.mjs';

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, base: string, adminBase: string, cookie: string, timeoutMs: number}} 設定
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
  for (const required of ['browser', 'base', 'admin-base', 'cookie']) {
    if (values[required] === undefined) {
      throw new Error(`--${required} は必須です`);
    }
  }
  return {
    browser: values['browser'],
    base: values['base'],
    adminBase: values['admin-base'],
    cookie: values['cookie'],
    timeoutMs: Number(values['timeout-ms'] ?? '30000'),
  };
}

/**
 * 偽のマイクと画面を与えて Chromium を起動する（`scripts/lib/cdp.mjs` の `launchBrowser` に、取り込みの旗を足した形）。
 *
 * **画面の取り込みの選択は旗が自動で受ける**（`--use-fake-ui-for-media-stream`）。headless の Chromium では、
 * 取り込むのはそのタブ自身になる（実測。2026-10-11）。
 *
 * @param {string} executable ブラウザの実行ファイル
 * @param {string} userDataDir 使い捨てのプロファイル置き場
 * @returns {Promise<{child: import('node:child_process').ChildProcess, endpoint: string}>} 起動したブラウザ
 */
function launchRecordingBrowser(executable, userDataDir) {
  const child = spawn(
    executable,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--ignore-certificate-errors',
      '--host-resolver-rules=MAP *.localtest.me 127.0.0.1',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stdout.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ブラウザが CDP の口を開きませんでした:\n${stderr}`)), LAUNCH_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ブラウザを起動できませんでした: ${String(error)}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`ブラウザが起動直後に終了しました（code=${String(code)}）:\n${stderr}`));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /^DevTools listening on (ws:\/\/\S+)$/mu.exec(stderr);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ child, endpoint: match[1] });
      }
    });
  });
}

/**
 * 待つ。
 *
 * @param {number} ms ミリ秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ページより先に入れる小さな包み（`getDisplayMedia` が返した線を拾っておく）。 */
const CAPTURE_HOOK = `
(() => {
  const original = navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia;
  if (!original) { return; }
  window.__probeDisplayStreams = [];
  navigator.mediaDevices.getDisplayMedia = async function (...args) {
    const stream = await original.apply(this, args);
    window.__probeDisplayStreams.push(stream);
    return stream;
  };
})();
`;

/** 観測の状態を読む式。 */
const READ_STATE = `(() => {
  const panel = document.getElementById('trial-recorder');
  const stage = document.getElementById('trial-stage');
  const pending = panel ? panel.querySelector('[data-trial-recorder-pending]') : null;
  const state = panel ? panel.querySelector('[data-trial-recorder-state]') : null;
  const restart = document.getElementById('trial-record-restart');
  const start = document.getElementById('trial-record-start');
  return {
    href: location.href,
    navigations: performance.getEntriesByType('navigation').length,
    loadedAt: window.__probeLoadedAt || null,
    stage: stage ? stage.getAttribute('data-trial-stage') : null,
    recording: panel ? panel.getAttribute('data-trial-recording') : null,
    endReason: panel ? panel.getAttribute('data-trial-end-reason') : null,
    pending: panel ? Number(panel.getAttribute('data-trial-pending') || '0') : null,
    pendingText: pending ? pending.textContent : null,
    stateText: state ? state.textContent : null,
    restartVisible: !!(restart && !restart.closest('[data-trial-toggle]').hidden),
    startVisible: !!(start && !start.closest('[data-trial-toggle]').hidden),
    body: document.body ? document.body.innerText.slice(0, 2000) : '',
  };
})()`;

/**
 * 観測を 1 本にまとめて走らせる。
 *
 * @param {ReturnType<typeof parseArgs>} args 設定
 * @returns {Promise<object>} 観測
 */
async function probe(args) {
  const profile = mkdtempSync(join(tmpdir(), 'trial-recording-probe-'));
  const { child, endpoint } = await launchRecordingBrowser(args.browser, profile);
  /** @type {Record<string, unknown>} */
  const observed = { steps: [], errors: [] };
  const steps = /** @type {object[]} */ (observed.steps);
  try {
    const cdp = new CdpConnection(await openSocket(endpoint));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_HOOK }, sessionId);
    // **headless の名乗り（`HeadlessChrome/`）を、PC の Chrome の名乗りに戻す。** サーバーは名乗りで録画に対応する
    // ブラウザかを見る（`detectTrialBrowser`）ので、そのままだと「このブラウザでは録画できません」になる。
    const { userAgent } = await cdp.send('Browser.getVersion');
    observed.userAgent = userAgent.replace('HeadlessChrome/', 'Chrome/');
    await cdp.send('Network.setUserAgentOverride', { userAgent: observed.userAgent }, sessionId);
    const separator = args.cookie.indexOf('=');
    for (const base of [args.base, args.adminBase]) {
      await cdp.send(
        'Network.setCookie',
        {
          name: args.cookie.slice(0, separator),
          value: args.cookie.slice(separator + 1),
          domain: new URL(base).hostname,
          path: '/',
          secure: true,
          httpOnly: true,
        },
        sessionId,
      );
    }

    // ページの例外と console.error を拾う（スクリプトが落ちたことを、観測に残す）。
    cdp.on((frame) => {
      if (frame.sessionId !== sessionId) return;
      if (frame.method === 'Runtime.exceptionThrown') {
        /** @type {string[]} */ (observed.errors).push(frame.params.exceptionDetails?.exception?.description ?? 'exception');
      }
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
        /** @type {string[]} */ (observed.errors).push(frame.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    /**
     * 式を評価する（利用者の操作として。画面の取り込みの許可に要る）。
     *
     * @param {string} expression 式
     * @returns {Promise<any>} 値
     */
    async function evaluate(expression) {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId,
      );
      if (result.exceptionDetails !== undefined) {
        throw new Error(`評価に失敗しました: ${result.exceptionDetails.exception?.description ?? expression}`);
      }
      return result.result.value;
    }

    /**
     * 条件が真になるまで状態を読み続ける。
     *
     * @param {string} label 何を待つか（観測に残す）
     * @param {(state: any) => boolean} predicate 条件
     * @param {number} [timeoutMs] 待つ上限
     * @returns {Promise<any>} 最後に読んだ状態
     */
    async function waitFor(label, predicate, timeoutMs = args.timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let state = null;
      for (;;) {
        try {
          state = await evaluate(READ_STATE);
        } catch {
          state = null;
        }
        if (state !== null && predicate(state)) {
          const { body: _body, ...rest } = state;
          steps.push({ label, ok: true, ...rest });
          return state;
        }
        if (Date.now() > deadline) {
          steps.push({ label, ok: false, last: state });
          throw new Error(`待ちきれませんでした: ${label}`);
        }
        await sleep(POLL_INTERVAL_MS * 2);
      }
    }

    /**
     * いまの段のフォームの送信ボタンを押す。
     */
    async function pressStep() {
      await evaluate(`document.querySelector('#trial-stage form button[type="submit"]').click()`);
    }

    // ── 1. 録画を始める ─────────────────────────────────────────────────────────
    await cdp.send('Page.navigate', { url: `${args.base}/trial` }, sessionId);
    await waitFor('録画の準備の段で「録画を始める」が出る', (s) => s.stage === 'recording' && s.startVisible);
    await evaluate(`window.__probeLoadedAt = Date.now(); document.getElementById('trial-record-start').click()`);
    const started = await waitFor(
      '録画が始まり、自由に触る段へ読み込み直さずに進む',
      (s) => s.recording === 'active' && s.stage === 'explore',
    );
    observed.sameDocumentAfterStart = started.loadedAt !== null;

    // ── 2. 断片を送る ───────────────────────────────────────────────────────────
    await sleep(11_000);
    await waitFor('断片を送り切っている', (s) => s.pending === 0);

    // ── 3. 口を落として溜まることを見る → 戻して送り切る ────────────────────────
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/trial/recording/chunk*' }] }, sessionId);
    let failed = 0;
    let blocking = true;
    cdp.on((frame) => {
      if (frame.sessionId !== sessionId || frame.method !== 'Fetch.requestPaused') return;
      const requestId = frame.params.requestId;
      if (blocking) {
        failed += 1;
        void cdp.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }, sessionId).catch(() => {});
      } else {
        void cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      }
    });
    const piled = await waitFor('送れない断片が溜まり、量が画面に出る', (s) => s.pending >= 1 && /送れていない録画/u.test(s.pendingText ?? ''), 20_000);
    observed.offlinePendingText = piled.pendingText;
    blocking = false;
    await cdp.send('Fetch.disable', {}, sessionId);
    observed.failedWhileOffline = failed;
    await waitFor('通信が戻ると送り切る', (s) => s.pending === 0 && /すべて送りました/u.test(s.pendingText ?? ''), 60_000);

    // ── 4. 振り返り 1 で「共有を停止」→ 再開 ──────────────────────────────────
    await pressStep();
    await waitFor('振り返り 1 の段へ進む（録画は続いている）', (s) => s.stage === 'q1' && s.recording === 'active');
    await evaluate(
      `window.__probeDisplayStreams[window.__probeDisplayStreams.length - 1].getVideoTracks()[0].dispatchEvent(new Event('ended'))`,
    );
    const shareEnded = await waitFor(
      '共有の停止で録画が止まり、「録画を再開する」が出る',
      (s) => s.recording === 'stopped' && s.endReason === 'share-ended' && s.restartVisible,
    );
    observed.shareEndedText = shareEnded.stateText;
    await evaluate(`document.getElementById('trial-record-restart').click()`);
    await waitFor('録画を再開する', (s) => s.recording === 'active' && !s.restartVisible);
    await sleep(6_000);

    // ── 5. 振り返り 5 まで進めて、アンケートで止める ───────────────────────────
    for (const [from, to] of [
      ['q1', 'q2'],
      ['q2', 'q3'],
      ['q3', 'q4'],
      ['q4', 'q5'],
      ['q5', 'survey'],
    ]) {
      await pressStep();
      await waitFor(`${from} から ${to} へ進む`, (s) => s.stage === to);
    }
    const stopped = await waitFor(
      'アンケートの段で録画が止まり、残りを送り切る',
      (s) => s.recording === 'stopped' && s.endReason === 'finished' && s.pending === 0,
      60_000,
    );
    observed.sameDocumentUntilSurvey = stopped.loadedAt === started.loadedAt && stopped.loadedAt !== null;
    // 録画が止まったことを口へ伝え終えるのを待つ（送り切った直後に知らせを送る）。
    await sleep(1_500);
    await evaluate(`(() => {
      document.getElementById('trial-browser').value = 'Chromium（自動の検査）';
      document.getElementById('trial-ai').value = 'なし';
      document.querySelector('#trial-survey-form button[type="submit"]').click();
    })()`);
    await waitFor('アンケートを送って終える', (s) => /ありがとうございました/u.test(s.body ?? ''));

    // ── 6. 管理画面で落として再生する ──────────────────────────────────────────
    await cdp.send('Page.navigate', { url: `${args.adminBase}/trials` }, sessionId);
    const deadline = Date.now() + args.timeoutMs;
    let buttons = 0;
    while (Date.now() < deadline) {
      buttons = await evaluate(`document.querySelectorAll('[data-trial-download]').length`).catch(() => 0);
      if (buttons > 0) break;
      await sleep(POLL_INTERVAL_MS * 2);
    }
    observed.downloadButtons = buttons;
    /** @type {object[]} */
    const playbacks = [];
    for (let index = 0; index < buttons; index += 1) {
      const result = await evaluate(`(async () => {
        const button = document.querySelectorAll('[data-trial-download]')[${index}];
        button.click();
        const started = Date.now();
        let link = null;
        while (Date.now() - started < 60000) {
          link = button.parentElement.querySelector('[data-trial-download-url]');
          if (link) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!link) return { id: button.getAttribute('data-trial-download'), error: 'no link: ' + button.parentElement.textContent };
        const blob = await (await fetch(link.href)).blob();
        const head = Array.from(new Uint8Array(await blob.slice(0, 4).arrayBuffer())).map((b) => b.toString(16).padStart(2, '0')).join('');
        const video = document.createElement('video');
        video.muted = true;
        video.src = link.href;
        document.body.appendChild(video);
        const metadata = await new Promise((resolve) => {
          video.addEventListener('loadedmetadata', () => resolve('ok'), { once: true });
          video.addEventListener('error', () => resolve('error ' + (video.error && video.error.message)), { once: true });
          setTimeout(() => resolve('timeout'), 15000);
        });
        let played = 'skipped';
        if (metadata === 'ok') {
          try { await video.play(); await new Promise((r) => setTimeout(r, 2000)); played = 'ok'; } catch (e) { played = 'error ' + e.message; }
        }
        // MediaRecorder の WebM は長さを持たないので、末尾へ送ってから読む。
        const duration = await new Promise((resolve) => {
          if (Number.isFinite(video.duration)) { resolve(video.duration); return; }
          video.addEventListener('durationchange', () => { if (Number.isFinite(video.duration)) resolve(video.duration); });
          video.currentTime = 1e9;
          setTimeout(() => resolve(video.duration), 5000);
        });
        return {
          id: button.getAttribute('data-trial-download'),
          name: link.download,
          size: blob.size,
          head,
          metadata,
          played,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          duration: Number.isFinite(duration) ? duration : null,
          videoBytes: video.webkitVideoDecodedByteCount ?? null,
          audioBytes: video.webkitAudioDecodedByteCount ?? null,
        };
      })()`);
      playbacks.push(result);
    }
    observed.playbacks = playbacks;
    observed.ok = true;
  } catch (error) {
    observed.ok = false;
    observed.failure = error instanceof Error ? error.message : String(error);
  } finally {
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
  return observed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const observed = await probe(args);
  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`[trial-recording-probe] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
