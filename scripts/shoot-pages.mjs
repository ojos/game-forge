// shoot-pages.mjs — SSR 画面を実ブラウザで開き、PNG に撮る（#303）。
//
// # なぜこれが要るのか
//
// **M8（#266 / #267 / #268）は、全画面を撮って見比べながら進めた。**
// #282 の 2 件（フッタ位置・スマホで縮む入力欄）も、M8-2 で CTA をボタンにした失敗も、
// **撮った 1 枚目で分かったもの**である——どれも `curl` も型検査も 1,400 件超のテストも
// 通り抜けている。**見た目は、見ないと分からない。**
//
// # このファイルは判定しない
//
// 開いて、撮って、観測結果を JSON で出すだけである。**見た目の良し悪しは機械が決めない**
// （M8 の acceptance が「見た目の良し悪しは acceptance に入れない」と決めている）。
// 判定するのは人で、この道具はその材料を出す。
//
// 幅が端末に収まっているかの**合否**は `scripts/check-page-width.sh` が持つ。
// **役割を混ぜない**（`scripts/page-width-probe.mjs` の冒頭と同じ規律）。
//
// # 依存を 1 つも足さない
//
// ブラウザの起動と CDP の接続は `scripts/lib/cdp.mjs` が持つ（#303 で寄せた）。
//
// 使い方:
//   node scripts/shoot-pages.mjs --browser <path> --base <origin> \
//     --out <dir> --paths </a,/b,...> [--widths 390,1280] [--cookie <name=value>]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 撮れた / 1 = 撮れなかった

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, POLL_INTERVAL_MS, launchBrowser, openSocket } from './lib/cdp.mjs';

/** ページの読み込みを待つ既定の時間。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 既定で撮る幅。
 *
 * **狭い側を外さない。** 見た目の不具合は狭い端末で先に出る（#282 の `size="50"` も、
 * M8-2 の CTA も、幅 390px で初めて分かった）。
 */
const DEFAULT_WIDTHS = '390,1280';

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, base: string, out: string, paths: string[], widths: number[], cookie: string | null, timeoutMs: number}} 読み取った設定
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
  for (const required of ['browser', 'base', 'out', 'paths']) {
    if (values[required] === undefined) {
      throw new Error(`--${required} は必須です`);
    }
  }
  const paths = values['paths'].split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (paths.length === 0) {
    throw new Error('--paths が空です');
  }
  const widths = (values['widths'] ?? DEFAULT_WIDTHS)
    .split(',')
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isInteger(w) && w > 0);
  if (widths.length === 0) {
    throw new Error(`--widths の値が不正です: ${String(values['widths'])}`);
  }
  const timeoutMs =
    values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return {
    browser: values['browser'],
    base: values['base'],
    out: values['out'],
    paths,
    widths,
    cookie: values['cookie'] ?? null,
    timeoutMs,
  };
}

/**
 * パスを、ファイル名に使える形へ落とす。
 *
 * @param {string} path 経路
 * @returns {string} ファイル名の一部
 */
function slugOf(path) {
  const slug = path.replace(/^\//u, '').replace(/[^A-Za-z0-9._-]+/gu, '_');
  return slug === '' ? 'root' : slug;
}

/**
 * ページの中から読み取る、撮影に添える観測値。
 *
 * **土台に乗っているかをここで見る。** 画像だけ見ても `link` の有無は分からないので、
 * 撮ったものが何だったかを後から読めるようにしておく。
 */
const PAGE_STATE_EXPRESSION = `JSON.stringify({
  href: location.href,
  title: document.title,
  stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
  inlineStyles: document.querySelectorAll('style').length,
  viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
})`;

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'gf-shoot-'));
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
    // `domain` を渡す理由は `scripts/page-width-probe.mjs` に書いてある（`__Host-`）。
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

  let status = null;
  let responseUrl = null;
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

  const shots = [];
  for (const path of args.paths) {
    for (const width of args.widths) {
      status = null;
      responseUrl = null;
      loadFired = false;

      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 800, deviceScaleFactor: 1, mobile: width < 700 },
        sessionId,
      );
      const url = `${args.base}${path}`;
      await cdp.send('Page.navigate', { url }, sessionId);

      // **`Page.navigate` は「遷移を始めた」時点で返る。** `load` を待ってから
      // `readyState` を確かめる（理由は `scripts/page-width-probe.mjs`）。
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

      // **ページ全体を撮る。** 折り返しより下は、まさに「見ていないところ」である。
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const content = metrics.cssContentSize ?? metrics.contentSize;
      const height = Math.max(1, Math.ceil(content.height));
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        },
        sessionId,
      );

      const file = join(args.out, `${slugOf(path)}@${width}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      const state = await cdp.send(
        'Runtime.evaluate',
        { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
        sessionId,
      );

      shots.push({
        path,
        width,
        height,
        file,
        loaded,
        status,
        responseUrl,
        ...JSON.parse(state.result.value),
      });
    }
  }

  cdp.socket.close();
  console.log(JSON.stringify({ out: args.out, widths: args.widths, shots }, null, 2));
} catch (error) {
  console.error(`[shoot-pages] ${String(error)}`);
  process.exitCode = 1;
} finally {
  if (child !== null) {
    child.kill('SIGTERM');
  }
  rmSync(userDataDir, { recursive: true, force: true });
}
