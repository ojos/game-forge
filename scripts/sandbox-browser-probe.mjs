// sandbox-browser-probe.mjs — 実ブラウザで 1 ページを開き、判定材料を JSON で返す（#180）。
//
// # なぜこれが要るのか
//
// **#180 は、機械的な代理検査を全部すり抜けた。** #28 / #29 の検査は「CSP が許して
// いるか」を CSP ヘッダの照合で見ていたが、7.2 必須要件 1（`sandbox allow-scripts`、
// `allow-same-origin` なし）の帰結で文書が**不透明オリジン**になるため、
// **CSP は許しているのに CORS が別の理由で塞ぐ**という組み合わせが成立する。
// その組み合わせは、CSP を読む検査でも curl でも原理的に捕まらない
// （**curl は CORS を評価しない**）。捕まえられるのは実ブラウザだけである。
//
// # 依存を 1 つも足さない
//
// Playwright / Puppeteer を入れず、**Chromium を直接起動して CDP を素で話す。**
// Node 22 以降は `WebSocket` が組み込みなので、必要なのは
// **ブラウザの実行ファイル 1 つ**だけになる。検査の前提が「npm の依存が入っていること」
// まで広がると、入っていない環境で黙って飛ばす経路ができる（#180 が通り抜けた形そのもの）。
//
// # このファイルは判定しない
//
// 開いて、観測して、JSON を出すだけである。**合否は scripts/check-sandbox-browser.sh が
// 決める。** 観測と判定を混ぜると、失敗したときに「何が観測されたのか」が読めなくなる。
//
// 使い方:
//   node scripts/sandbox-browser-probe.mjs --browser <path> --url <url> [--timeout-ms 30000]
//
// 標準出力: 観測結果 1 個の JSON
// 終了コード: 0 = 観測できた（合否とは無関係） / 1 = 観測そのものができなかった

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 既定の待ち時間。1.9MB 級の wasm の取得・コンパイル・起動まで含む。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 起動したブラウザが CDP の口を開くまでの待ち時間。 */
const LAUNCH_TIMEOUT_MS = 20_000;

/** ページの状態を読む間隔。 */
const POLL_INTERVAL_MS = 100;

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{browser: string, url: string, timeoutMs: number}} 読み取った設定
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
  const browser = values['browser'];
  const url = values['url'];
  if (browser === undefined || url === undefined) {
    throw new Error('--browser と --url は必須です');
  }
  const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms の値が不正です: ${String(values['timeout-ms'])}`);
  }
  return { browser, url, timeoutMs };
}

/**
 * Chromium を起動し、CDP の WebSocket エンドポイントを返す。
 *
 * ポートは 0 を渡して OS に選ばせ、**実際に開いた口を標準エラーから読む。**
 * 固定ポートにすると、並列実行や取り残されたプロセスと衝突したときに
 * 「別のブラウザへ繋いで観測していた」という最悪の形になりうる。
 *
 * @param {string} executable ブラウザの実行ファイル
 * @param {string} userDataDir 使い捨てのプロファイル置き場
 * @returns {Promise<{child: import('node:child_process').ChildProcess, endpoint: string, stderr: () => string}>} 起動したブラウザ
 */
function launchBrowser(executable, userDataDir) {
  const child = spawn(
    executable,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      // 開発用の自己署名証明書（scripts/dev-certs.sh）を受け入れる。
      // **検査対象は TLS ではない。** 7.2 の検証に HTTPS が要るのは `__Host-` cookie の
      // ためで（docs/local-dev.md）、証明書の信頼までは要求していない。
      '--ignore-certificate-errors',
      // `*.localtest.me` は公開 DNS が 127.0.0.1 を返すが、**この環境では AAAA が
      // 先に引かれて ::1 になる**（実測）。dev サーバは 127.0.0.1 で待つため、
      // 名前解決をブラウザ側で固定する。**対象を絞る**（`MAP *` にすると、
      // 意図しない宛先まで loopback へ向く）。
      '--host-resolver-rules=MAP *.localtest.me 127.0.0.1',
      // コンテナ内の非 root 実行では user namespace が使えないことがある。
      // **ここで守るものが無い**（開くのは自分で立てたローカルサーバだけ）。
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
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
        resolve({ child, endpoint: match[1], stderr: () => stderr });
      }
    });
  });
}

/**
 * CDP の 1 接続。
 *
 * flatten モード（`Target.attachToTarget` の `flatten: true`）を使い、
 * 1 本の WebSocket で browser セッションと page セッションの両方を話す。
 */
class CdpConnection {
  /**
   * @param {WebSocket} socket 接続済みの WebSocket
   */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason: Error) => void}>} */
    this.pending = new Map();
    /** @type {Array<{method: string, params: unknown}>} */
    this.events = [];

    socket.addEventListener('message', (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.id === undefined) {
        this.events.push({ method: frame.method, params: frame.params });
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (waiter === undefined) {
        return;
      }
      this.pending.delete(frame.id);
      if (frame.error !== undefined) {
        waiter.reject(new Error(`${frame.method ?? 'CDP'}: ${JSON.stringify(frame.error)}`));
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
}

/**
 * WebSocket を開く。
 *
 * @param {string} endpoint `ws://...`
 * @returns {Promise<WebSocket>} 接続済みの WebSocket
 */
function openSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`CDP へ接続できませんでした: ${endpoint}`)), {
      once: true,
    });
  });
}

/**
 * ページの中から読み取る観測値。
 *
 * # 不透明オリジンであることを必ず観測する
 *
 * **この検査の前提は「文書が不透明オリジンになっていること」である**（7.2 必須要件 1）。
 * 前提が崩れた状態で緑を出すのが #180 の再来そのものなので、**判定側で必ず見る。**
 *
 * **`location.origin` を使ってはならない。** これは HTML 仕様どおり
 * **URL のオリジン**を返すため、不透明オリジンの文書でも `https://host:port` を返す
 * （実測。この誤りで一度、同一オリジン取得を「不透明オリジンからの取得」と誤認した）。
 * 見るべきは**設定オブジェクトのオリジン**である `globalThis.origin`（＝ `self.origin`）で、
 * 不透明なら文字列 `"null"` を返す。
 *
 * 裏取りとして `localStorage` の参照も見る。不透明オリジンでは
 * `SecurityError` を投げるため、**綴りの解釈に依らない証拠**になる。
 */
const PAGE_STATE_EXPRESSION = `(() => {
  const status = document.getElementById('gf-status');
  const storageThrows = (() => {
    try {
      void localStorage;
      return false;
    } catch {
      return true;
    }
  })();
  return {
    settingsOrigin: String(globalThis.origin),
    locationOrigin: String(location.origin),
    storageThrows,
    wasmRan: globalThis.__gfWasmRan ?? null,
    statusText: status === null ? null : String(status.textContent ?? ''),
    statusHidden: status === null ? null : Boolean(status.hidden),
    hasCanvas: document.querySelector('canvas') !== null,
  };
})()`;

/**
 * ページの中にある**すべての実行文脈**を読む（#30 の層 4）。
 *
 * # なぜ子ターゲットではなく実行文脈なのか
 *
 * 埋め込まれたサンドボックス文書（`/works/<id>` の中の iframe）は、**別ターゲットに
 * ならないことがある。** `Target.setAutoAttach` で待っても `attachedToTarget` は
 * 1 件も来ない（実測）。アプリ用ホストとサンドボックス用ホストは**同一サイト**であり
 * （7.2「同一サイトであることの帰結」）、Chromium の site isolation は同一サイトの
 * フレームを同じプロセスへ置くためである。**不透明オリジンでも別プロセスにはならない。**
 *
 * 見るべきは同じターゲットの中の**別の実行文脈**である。`Runtime.enable` が
 * `Runtime.executionContextCreated` で通知するので、そこから id を集めて評価する。
 *
 * **文脈を選り分けない。** `auxData` の中身は版によって変わりうるので、**全部に対して
 * 評価して、評価できたものだけを返す**（遷移で消えた文脈は例外になる。握り潰す）。
 * 判定側は「不透明オリジンで、かつ wasm が走った文脈が 1 つ以上あるか」を見る。
 *
 * @param {CdpConnection} connection CDP 接続
 * @param {string} sessionId 対象のセッション
 * @returns {Promise<Array<{id: number, state: any}>>} 文脈ごとの観測値
 */
async function readExecutionContexts(connection, sessionId) {
  const ids = connection.events
    .filter((event) => event.method === 'Runtime.executionContextCreated')
    .map((event) => /** @type {any} */ (event.params).context?.id)
    .filter((id) => typeof id === 'number');

  const contexts = [];
  for (const id of ids) {
    try {
      const evaluated = await connection.send(
        'Runtime.evaluate',
        { expression: PAGE_STATE_EXPRESSION, returnByValue: true, contextId: id },
        sessionId,
      );
      if (evaluated.exceptionDetails === undefined && evaluated.result?.value !== undefined) {
        contexts.push({ id, state: evaluated.result.value });
      }
    } catch {
      // 遷移で消えた文脈。**観測できないことは失敗ではない。**
    }
  }
  return contexts;
}

/**
 * 1 ページを開いて観測する。
 *
 * @param {{browser: string, url: string, timeoutMs: number}} options 設定
 * @returns {Promise<object>} 観測結果
 */
async function probe(options) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'gf-browser-probe-'));
  let launched;
  try {
    launched = await launchBrowser(options.browser, userDataDir);
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }

  const { child, endpoint } = launched;
  try {
    const connection = new CdpConnection(await openSocket(endpoint));

    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });

    // **落ちたときに「なぜ落ちたか」を残すために全部有効にする。** とくに
    // `Network.loadingFailed` は CORS で破棄された取得の理由（`corsErrorStatus`）を
    // 持っており、#180 の症状（`TypeError: Failed to fetch`）の一段下を見せてくれる。
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send('Network.enable', {}, sessionId);
    await connection.send('Log.enable', {}, sessionId);

    await connection.send('Page.navigate', { url: options.url }, sessionId);

    const deadline = Date.now() + options.timeoutMs;
    /** @type {any} */
    let state = null;
    /** @type {Array<{id: number, state: any}>} */
    let frameContexts = [];
    while (Date.now() < deadline) {
      const evaluated = await connection.send(
        'Runtime.evaluate',
        { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
        sessionId,
      );
      // 遷移の途中では評価できないことがある（about:blank のまま等）。握り潰さず、
      // 最後の 1 回の結果を返す形にして、時間切れでも観測値が残るようにする。
      if (evaluated.exceptionDetails === undefined && evaluated.result?.value !== undefined) {
        state = evaluated.result.value;
        if (state.wasmRan !== null) {
          break;
        }
      }
      // **埋め込み（層 4）のときは、印が立つのは子の文脈である。** 主文書だけを見て
      // 待ち続けると、通っていても必ず時間切れになる。
      frameContexts = await readExecutionContexts(connection, sessionId);
      if (frameContexts.some((context) => context.state?.wasmRan !== null && context.state?.wasmRan !== undefined)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return {
      url: options.url,
      state,
      // 主文書を含む、読めたすべての実行文脈（層 4 の判定材料）。
      frameContexts,
      // 判定には使わないが、失敗したときに読む材料。
      console: connection.events
        .filter((event) => event.method === 'Runtime.consoleAPICalled')
        .map((event) => ({
          type: /** @type {any} */ (event.params).type,
          text: /** @type {any} */ (event.params).args
            ?.map((/** @type {any} */ argument) => String(argument.value ?? argument.description ?? ''))
            .join(' '),
        })),
      exceptions: connection.events
        .filter((event) => event.method === 'Runtime.exceptionThrown')
        .map((event) => /** @type {any} */ (event.params).exceptionDetails?.text ?? ''),
      logEntries: connection.events
        .filter((event) => event.method === 'Log.entryAdded')
        .map((event) => /** @type {any} */ (event.params).entry)
        .map((entry) => ({ source: entry?.source, level: entry?.level, text: entry?.text })),
      loadingFailed: connection.events
        .filter((event) => event.method === 'Network.loadingFailed')
        .map((event) => ({
          errorText: /** @type {any} */ (event.params).errorText,
          corsErrorStatus: /** @type {any} */ (event.params).corsErrorStatus ?? null,
          blockedReason: /** @type {any} */ (event.params).blockedReason ?? null,
        })),
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
  process.stderr.write(`[probe] 観測できませんでした: ${String(error)}\n`);
  process.exit(1);
}
