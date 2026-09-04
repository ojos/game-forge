// page-width-probe.mjs — 実ブラウザで SSR 画面を 1 つの幅で開き、判定材料を JSON で返す（#282）。
//
// # なぜこれが要るのか
//
// **#282 の 2 件目は、機械的な代理検査を全部すり抜けた。** 削除申請フォームの
// `size="50"` は、幅 390px の端末で **layout viewport を 498px へ広げる**。
// `meta[name=viewport]` は正しく入っているので viewport の検査では捕まらず、
// HTML の文字列照合でも `curl` でも「属性が 1 つある」以上のことは分からない。
// **捕まえられるのは、実際にレイアウトを組んだブラウザだけ**である。
//
// # 依存を 1 つも足さない
//
// Playwright / Puppeteer を入れず、**Chromium を直接起動して CDP を素で話す**
// （`scripts/sandbox-browser-probe.mjs` と同じ型。理由はそちらの冒頭）。
//
// # このファイルは判定しない
//
// 開いて、観測して、JSON を出すだけである。**合否は scripts/check-page-width.sh が
// 決める。** 観測と判定を混ぜると、失敗したときに「何が観測されたのか」が読めなくなる。
//
// 使い方:
//   node scripts/page-width-probe.mjs --browser <path> --base <origin> \
//     --paths </a,/b,...> --width 390 [--cookie <name=value>] [--timeout-ms 20000]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, POLL_INTERVAL_MS, launchBrowser, openSocket } from './lib/cdp.mjs';

/** ページの読み込みを待つ既定の時間。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, base: string, paths: string[], width: number, cookie: string | null, timeoutMs: number}} 読み取った設定
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
  for (const required of ['browser', 'base', 'paths', 'width']) {
    if (values[required] === undefined) {
      throw new Error(`--${required} は必須です`);
    }
  }
  const width = Number(values['width']);
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`--width の値が不正です: ${String(values['width'])}`);
  }
  const timeoutMs =
    values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  const paths = values['paths'].split(',').map((path) => path.trim()).filter((path) => path !== '');
  if (paths.length === 0) {
    throw new Error('--paths が空です');
  }
  return {
    browser: values['browser'],
    base: values['base'],
    paths,
    width,
    cookie: values['cookie'] ?? null,
    timeoutMs,
  };
}

/**
 * ページの中から読み取る観測値。
 *
 * **`window.innerWidth` を見る。** これは layout viewport の幅であり、
 * `size="50"` のような「内容が端末より広い」宣言があると、`meta[name=viewport]` が
 * `width=device-width` を指定していても**広がる**（#282 の実測: 390 の端末で 498）。
 * 端末の幅より広ければ、ブラウザはページ全体を縮めて表示している。
 *
 * `scrollWidth` も併せて読む。innerWidth が広がりきらずに横スクロールが出る形も
 * あり、どちらか片方だけでは「横にはみ出している」を取りこぼす。
 *
 * **いちばん右まで出ている要素**も返す。赤くなったときに、どの要素が原因かを
 * 人が読めるようにするため（判定には使わない）。
 */
const PAGE_STATE_EXPRESSION = `(() => {
  const doc = document.documentElement;
  let widest = null;
  let right = 0;
  for (const element of document.querySelectorAll('body *')) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.right > right) {
      right = box.right;
      widest = element.tagName.toLowerCase()
        + (element.getAttribute('name') ? '[name=' + element.getAttribute('name') + ']' : '')
        + (element.getAttribute('size') ? '[size=' + element.getAttribute('size') + ']' : '');
    }
  }
  return {
    innerWidth: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    widest,
    widestRight: Math.round(right),
    title: document.title,
  };
})()`;

const args = parseArgs(process.argv.slice(2));
const userDataDir = mkdtempSync(join(tmpdir(), 'gf-page-width-'));
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

try {
  const launched = await launchBrowser(args.browser, userDataDir);
  child = launched.child;
  const cdp = new CdpConnection(await openSocket(launched.endpoint));

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  if (args.cookie !== null) {
    const separator = args.cookie.indexOf('=');
    if (separator < 0) {
      throw new Error(`--cookie の形が違います（name=value）: ${args.cookie}`);
    }
    // `domain` を渡す。**`__Host-` 接頭辞があるので `Set-Cookie` ヘッダなら
    // `Domain` 属性は拒否される**が、CDP の `Network.setCookie` は host-only cookie
    // として受理する（`secure` かつ `path=/` で、ホストが一致するため）。
    // **実測で確かめてある**——この cookie を外すと `/works` と `/invites` が
    // `/auth/google/start` へ飛び、`check-page-width.sh` が赤くなる。
    await cdp.send(
      'Network.setCookie',
      {
        name: args.cookie.slice(0, separator),
        value: args.cookie.slice(separator + 1),
        domain: new URL(args.base).hostname,
        path: '/',
        secure: true,
        httpOnly: true,
      },
      sessionId,
    );
  }

  // 主フレームの応答を拾う。**リダイレクトされた画面を「幅は正しい」で通さない**
  // ため、判定側がステータスと最終 URL を見られるようにする。
  //
  // **`Network.responseReceived` は最終応答でも発火する。** 303 を返した経路でも、
  // 追跡した先の 200 で上書きされてステータスだけでは気づけない。だから最終 URL も
  // 返し、要求した URL との一致は判定側が見る（`scripts/check-page-width.sh`）。
  let status = null;
  let responseUrl = null;
  // **`Page.navigate` は「遷移を始めた」時点で返る。** 直後に `readyState` を読むと、
  // まだ**前の文書**が載っていて `'complete'` を返す。1 周目で抜けて前のページを
  // 観測する（初回は about:blank）——第二意見の指摘で気づいた実在の競合である。
  // `Page.loadEventFired` を待ってから読む。
  let loadFired = false;
  cdp.on((frame) => {
    if (frame.sessionId !== sessionId) {
      return;
    }
    if (frame.method === 'Page.loadEventFired') {
      loadFired = true;
      return;
    }
    if (frame.method === 'Network.responseReceived' && frame.params.type === 'Document') {
      status = frame.params.response.status;
      responseUrl = frame.params.response.url;
    }
  });

  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: args.width, height: 800, deviceScaleFactor: 1, mobile: args.width < 700 },
    sessionId,
  );

  const observations = [];
  for (const path of args.paths) {
    status = null;
    responseUrl = null;
    loadFired = false;
    const url = `${args.base}${path}`;
    await cdp.send('Page.navigate', { url }, sessionId);

    // まず `load` を待ち、そのうえで `readyState` を確かめる。**片方だけにしない**
    // ——`load` は前の文書では発火せず、`readyState` は「解析まで終わったか」を
    // 別の角度から見る。両方が揃ってから観測する。
    let loaded = false;
    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() < deadline) {
      if (loadFired) {
        const result = await cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId,
        );
        if (result.result?.value === 'complete') {
          loaded = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const state = await cdp.send(
      'Runtime.evaluate',
      { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
      sessionId,
    );

    observations.push({ path, url, loaded, status, responseUrl, ...state.result.value });
  }

  cdp.socket.close();
  console.log(JSON.stringify({ width: args.width, observations }, null, 2));
} catch (error) {
  console.error(`[page-width-probe] ${String(error)}`);
  process.exitCode = 1;
} finally {
  if (child !== null) {
    child.kill('SIGTERM');
  }
  rmSync(userDataDir, { recursive: true, force: true });
}
