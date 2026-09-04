/**
 * Chromium を起動して CDP を素で話すための共有部品（#303）。
 *
 * # なぜ共有するのか
 *
 * **同じものを 2 度書いていた。** `scripts/page-width-probe.mjs`（幅の検査）と
 * 画面の撮影が、どちらもブラウザの起動・CDP の接続・cookie の投入・遷移待ちを持つ。
 * **写しは必ず腐る**（`.ai-playbook/shared-ai-rules.md` 12 章）ので、置く前に寄せる。
 *
 * # 依存を 1 つも足さない
 *
 * Playwright / Puppeteer を入れず、**Chromium を直接起動して CDP を素で話す。**
 * Node 22 以降は `WebSocket` が組み込みなので、必要なのは**ブラウザの実行ファイル
 * 1 つ**だけになる（理由は `scripts/sandbox-browser-probe.mjs` の冒頭）。
 *
 * # ここは判定しない
 *
 * 開いて、観測できる状態にするだけである。**合否も、何を観測するかも、呼ぶ側が持つ。**
 */

import { spawn } from 'node:child_process';

/** 起動したブラウザが CDP の口を開くまでの待ち時間。 */
export const LAUNCH_TIMEOUT_MS = 20_000;

/** ページの状態を読む間隔。 */
export const POLL_INTERVAL_MS = 100;

/**
 * Chromium を起動し、CDP の WebSocket エンドポイントを返す。
 *
 * 起動オプションの理由は `scripts/sandbox-browser-probe.mjs` の同じ関数に書いてある。
 *
 * @param {string} executable ブラウザの実行ファイル
 * @param {string} userDataDir 使い捨てのプロファイル置き場
 * @returns {Promise<{child: import('node:child_process').ChildProcess, endpoint: string}>} 起動したブラウザ
 */
export function launchBrowser(executable, userDataDir) {
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
      // スクロールバーの幅が観測値へ混ざらないようにする。**これを入れないと、
      // 縦に長い画面だけ innerWidth が 15px ほど小さく出て、判定が幅ではなく
      // 「そのページが縦に長いか」を見ることになる。**
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stdout.resume();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ブラウザが CDP の口を開きませんでした（${LAUNCH_TIMEOUT_MS}ms）:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);

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

/** CDP の 1 接続（flatten モード）。 */
export class CdpConnection {
  /**
   * @param {WebSocket} socket 接続済みの WebSocket
   */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (value: any) => void, reject: (reason: Error) => void}>} */
    this.pending = new Map();
    /** @type {Array<(frame: any) => void>} */
    this.listeners = [];

    socket.addEventListener('message', (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.id === undefined) {
        for (const listener of this.listeners) {
          listener(frame);
        }
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (waiter === undefined) {
        return;
      }
      this.pending.delete(frame.id);
      if (frame.error !== undefined) {
        waiter.reject(new Error(`CDP: ${JSON.stringify(frame.error)}`));
        return;
      }
      waiter.resolve(frame.result);
    });
  }

  /**
   * CDP のコマンドを 1 つ送る。
   *
   * @param {string} method メソッド名
   * @param {object} [params] 引数
   * @param {string} [sessionId] 対象セッション（省略で browser セッション）
   * @returns {Promise<any>} 応答
   */
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const frame = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(frame));
    });
  }

  /**
   * イベントの受け口を足す。
   *
   * @param {(frame: any) => void} listener 受け口
   */
  on(listener) {
    this.listeners.push(listener);
  }
}

/**
 * WebSocket を開く。
 *
 * @param {string} endpoint `ws://...`
 * @returns {Promise<WebSocket>} 接続済みの WebSocket
 */
export function openSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`CDP へ接続できませんでした: ${endpoint}`)), {
      once: true,
    });
  });
}
