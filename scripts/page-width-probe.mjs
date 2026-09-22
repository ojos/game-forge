// page-width-probe.mjs — 実ブラウザで SSR 画面を各幅で開き、判定材料を JSON で返す（#282 / #371）。
//
// # なぜこれが要るのか
//
// **#282 の 2 件目は、機械的な代理検査を全部すり抜けた。** 削除依頼フォームの
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
// # 幅は複数受け取り、ブラウザは 1 回しか起動しない（#371）
//
// 画面幅を 3 段で持つと決めたので（2.3.9）、**検査も 3 段すべてを見る。** 幅ごとに
// この道具を呼ぶと、いちばん高い費用（ブラウザの起動と dev サーバへの初回接続）を
// 段の数だけ払うことになる。**同じターゲットへ `Emulation.setDeviceMetricsOverride` を
// 掛け直して回る**（`scripts/shoot-pages.mjs` が先に採っている形）。
//
// # アカウントのメニューを、JavaScript を止めて開閉する（#372）
//
// **ヘッダのアバターのドロップダウンは `<details>` / `<summary>` で、JavaScript を
// 要求しない**（2.3.7 v1.57）。HTML の文字列照合で分かるのは「そう書いてある」までで、
// **本当に開くか・開いた中身が幅に収まるか・読み上げに名前と開閉の状態が渡るか**は、
// レイアウトを組んだブラウザでしか分からない。`--menu-path` を渡すと、幅ごとに
// その画面を **JavaScript を止めて**開き直し、キーボード（Enter）とポインタ（クリック）で
// 開閉して観測する。**開いた中身もこの検査の幅に収まっていなければならない**——閉じた
// 状態だけを見る幅の検査は、開くと横にはみ出すメニューを通してしまう。
//
// 使い方:
//   node scripts/page-width-probe.mjs --browser <path> --base <origin> \
//     --paths </a,/b,...> --widths 390,768,1280 [--cookie <name=value>] [--timeout-ms 20000] \
//     [--menu-path /]
//
// `--width`（単数）も受ける。1 つの幅だけを見たいときの綴りである。
//
// 標準出力: 観測結果 1 個の JSON（`runs` が幅ごとの観測を持つ）
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
 * @returns {{browser: string, base: string, paths: string[], widths: number[], cookie: string | null, timeoutMs: number, menuPath: string | null}} 読み取った設定
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
  for (const required of ['browser', 'base', 'paths']) {
    if (values[required] === undefined) {
      throw new Error(`--${required} は必須です`);
    }
  }
  // `--widths` を正とし、`--width`（単数）も受ける。**どちらも無いのは誤りである**
  // ——既定値を作ると、幅を渡し忘れた呼び出しが黙って 1 段だけを見て緑になる。
  const rawWidths = values['widths'] ?? values['width'];
  if (rawWidths === undefined) {
    throw new Error('--widths は必須です');
  }
  const widths = rawWidths
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => Number(value));
  if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width <= 0)) {
    throw new Error(`--widths の値が不正です: ${rawWidths}`);
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
    widths,
    cookie: values['cookie'] ?? null,
    timeoutMs,
    menuPath: values['menu-path'] ?? null,
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
  // **面の中の文字の塊**（#763）。面（\`.gf-block\`）の直下——行に分けた面（\`.gf-block-rows\`）なら行の直下——に
  // ある文字の塊ごとに、親の内側の右端から塊の右端までの空きを返す。**直下だけを見る**のは、面の中の格子や
  // フォームの中の塊は、面ではなくその列の幅で組まれるためである。**親が横並びの flex や格子のときは見ない**——
  // 文とボタンを 1 行に並べる帯（作品ページの下書きの帯 \`.gf-draft-banner\` など）は、右の空きが並べ方の結果である。
  // **縦並びの flex は見る**。面そのものがフォーム（\`<form class="gf-block">\`。\`@section forms\` の縦並び）の画面が多い。
  const blockText = [];
  const TEXT = new Set(['H2', 'H3', 'P', 'UL', 'OL', 'DL', 'DETAILS', 'BLOCKQUOTE']);
  const describe = (element) => element.tagName.toLowerCase()
    + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).join('.') : '');
  for (const block of document.querySelectorAll('.gf-block')) {
    const parents = block.classList.contains('gf-block-rows') ? [...block.children] : [block];
    for (const parent of parents) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      const flows = ['block', 'flow-root', 'list-item'].includes(style.display)
        || (['flex', 'inline-flex'].includes(style.display) && style.flexDirection.startsWith('column') && style.alignItems !== 'flex-start' && style.alignItems !== 'start');
      if (box.width === 0 || !flows) {
        continue;
      }
      const innerRight = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      for (const child of parent.children) {
        const childBox = child.getBoundingClientRect();
        if (!TEXT.has(child.tagName) || childBox.width === 0) {
          continue;
        }
        blockText.push({ element: describe(child), inside: describe(parent), gap: Math.round(innerRight - childBox.right) });
      }
    }
  }
  // **入力欄の幅**（#763）。上限は入力欄が持つ（\`@section forms\`）。見えている欄だけを数える。
  // **CSS の対象と同じ集合を数える**（\`text\` / \`email\` / \`textarea\`。PR #765 の Copilot の指摘）。
  const inputs = [...document.querySelectorAll("input[type='text'], input[type='email'], textarea")]
    .map((element) => ({ element: describe(element) + (element.name ? '[name=' + element.name + ']' : ''), width: Math.round(element.getBoundingClientRect().width) }))
    .filter((input) => input.width > 0);
  // **1 カラムの画面の置き方**（#764。生成画面）。器（\`body\` の内側）・パンくず・1 カラム・チャットの区画・会話のログ・
  // 指示文の欄の端を返す。**1 カラムが無い画面では null**（判定は呼ぶ側が経路で決める）。
  const edges = (element) => {
    if (element === null) {
      return null;
    }
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      innerRight: Math.round(box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)),
    };
  };
  const bodyStyle = getComputedStyle(document.body);
  const bodyBox = document.body.getBoundingClientRect();
  const column = document.querySelector('div.gf-column') === null ? null : {
    shellLeft: Math.round(bodyBox.left + parseFloat(bodyStyle.paddingLeft)),
    shellRight: Math.round(bodyBox.right - parseFloat(bodyStyle.paddingRight)),
    breadcrumb: edges(document.querySelector('nav.gf-breadcrumb.gf-column')),
    column: edges(document.querySelector('div.gf-column')),
    chat: edges(document.querySelector('.gf-chat')),
    log: edges(document.querySelector('.gf-chat-log')),
    field: edges(document.querySelector('.gf-generate-form textarea')),
    form: edges(document.querySelector('form.gf-generate-form')),
  };
  return {
    innerWidth: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    widest,
    widestRight: Math.round(right),
    title: document.title,
    blockText,
    inputs,
    column,
  };
})()`;

/**
 * アカウントのメニューの状態（`src/html.ts` の `accountMenu`）。
 *
 * **中身が描かれているかは、ログアウトのボタンの `checkVisibility()` で見る。箱の大きさでは
 * 見ない**——Chromium は閉じた `<details>` の中身を `content-visibility: hidden` で隠すので、
 * **閉じていても箱は幅と高さを持つ**（実測。箱で見ると「読み込んだ直後から開いている」と
 * 誤って赤くなった）。開いたときは、中身の枠（`.gf-account-menu-list`）が**端末の幅の
 * 内側にあること**を返す（判定は `scripts/check-page-width.sh`）。
 */
const MENU_STATE_EXPRESSION = `(() => {
  const menu = document.querySelector('header.gf-header details.gf-account-menu');
  if (menu === null) {
    return { present: false };
  }
  const list = menu.querySelector('.gf-account-menu-list');
  const logout = menu.querySelector('form[method="post"] button');
  const listBox = list === null ? null : list.getBoundingClientRect();
  return {
    present: true,
    open: menu.open,
    logoutRendered: logout !== null && logout.checkVisibility(),
    listLeft: listBox === null ? null : Math.floor(listBox.left),
    listRight: listBox === null ? null : Math.ceil(listBox.right),
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
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
  // **主フレームの応答だけを拾う**（#622）。`Network.responseReceived` の `type === 'Document'` は
  // **iframe の文書でも発火する。** 作品ページは公開後にゲームを iframe で埋め込むので（仕様 3.9.4）、
  // 絞らないと**最後に届いたサンドボックスの `/g/<id>/` が最終 URL として残り**、判定側の
  // 「要求したパスと最終パスが一致するか」が必ず外れる——**画面は正しく出ているのに
  // 「別の画面へ移動しました」で落ちる。**
  //
  // **主フレームの id は `Page.getFrameTree` から、遷移の前に 1 度だけ取る。** `Page.navigate` の
  // 戻りを使わないのは、あれが「遷移を始めた」時点で返るためで、**主文書の `Network.responseReceived`
  // はそれより先に届きうる**——その窓では id がまだ無く、絞り込みが効かない。id は対象（タブ）の
  // 中で遷移をまたいで変わらないので、先に取れば窓が生まれない。
  const mainFrameId = (await cdp.send('Page.getFrameTree', {}, sessionId))?.frameTree?.frame?.id ?? null;
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
      // **主フレーム以外（埋め込んだゲームの iframe）は見ない**（上の説明）。
      if (mainFrameId !== null && frame.params.frameId !== mainFrameId) {
        return;
      }
      status = frame.params.response.status;
      responseUrl = frame.params.response.url;
    }
  });

  /**
   * 1 画面を開き、`load` と `readyState` の両方が揃うまで待つ。
   *
   * @param {string} url 開く URL
   * @returns {Promise<boolean>} 期限内に読み込みが終わったか
   */
  async function navigate(url) {
    status = null;
    responseUrl = null;
    loadFired = false;
    await cdp.send('Page.navigate', { url }, sessionId);

    // まず `load` を待ち、そのうえで `readyState` を確かめる。**片方だけにしない**
    // ——`load` は前の文書では発火せず、`readyState` は「解析まで終わったか」を
    // 別の角度から見る。両方が揃ってから観測する。
    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() < deadline) {
      if (loadFired) {
        const result = await cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId,
        );
        if (result.result?.value === 'complete') {
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }

  /**
   * いまの画面のアカウントのメニューの状態を読む。
   *
   * **読むのは DevTools の評価であって、ページのスクリプトではない。**
   * `Emulation.setScriptExecutionDisabled` が止めるのはページが持つスクリプトで、
   * `Runtime.evaluate` はその外から読める（止めたまま読めることは実測で確かめた）。
   *
   * @returns {Promise<any>} {@link MENU_STATE_EXPRESSION} の値
   */
  async function readMenu() {
    const state = await cdp.send(
      'Runtime.evaluate',
      { expression: MENU_STATE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    return state.result.value;
  }

  /**
   * `<summary>` にキーボードの焦点を置き、キーを 1 回押して離す。
   *
   * **焦点は `DOM.focus` で置く**（ページのスクリプトを使わない）。押すのは Enter で、
   * `<summary>` は押されると自分の `<details>` を開閉する（ブラウザの既定の振る舞い）。
   *
   * @param {number} nodeId `<summary>` の DOM ノード
   */
  async function pressEnterOn(nodeId) {
    await cdp.send('DOM.focus', { nodeId }, sessionId);
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId);
  }

  /**
   * `<summary>` の真ん中をポインタで 1 回押す。
   *
   * @param {number} nodeId `<summary>` の DOM ノード
   */
  async function clickOn(nodeId) {
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId }, sessionId);
    const [x1, y1, , , x3, y3] = model.content;
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type, x, y, button: 'left', clickCount: 1 },
        sessionId,
      );
    }
  }

  /**
   * JavaScript を止めた状態で、アカウントのメニューを開閉して観測する（#372）。
   *
   * 順に「読み込んだ直後（閉じている）→ Enter で開く → Enter で閉じる → クリックで開く」を
   * 観測し、開いたときは**読み上げに渡る名前と開閉の状態**も読む。
   *
   * @param {string} url 開く URL
   * @returns {Promise<any>} 観測値
   */
  async function probeMenu(url) {
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
    try {
      const loaded = await navigate(url);
      const scriptsDisabled = (
        await cdp.send(
          'Runtime.evaluate',
          // `<noscript>` の中身は、スクリプトが止まっているときだけ要素として解析される。
          // **止めたつもりで動いていた**を観測値で塞ぐ。
          {
            expression: `(() => { const n = document.createElement('div'); n.innerHTML = '<noscript><p></p></noscript>'; return n.querySelector('noscript p') !== null; })()`,
            returnByValue: true,
          },
          sessionId,
        )
      ).result.value;
      const initial = await readMenu();
      if (!loaded || initial.present !== true) {
        return { url, loaded, scriptsDisabled, initial };
      }
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId);
      const { nodeId } = await cdp.send(
        'DOM.querySelector',
        { nodeId: root.nodeId, selector: 'header.gf-header details.gf-account-menu > summary' },
        sessionId,
      );

      await pressEnterOn(nodeId);
      const openedByKey = await readMenu();
      const { nodes } = await cdp.send(
        'Accessibility.getPartialAXTree',
        { nodeId, fetchRelatives: false },
        sessionId,
      );
      const summaryAx = nodes.find((node) => node.ignored !== true) ?? null;
      const accessible = {
        role: summaryAx?.role?.value ?? null,
        name: summaryAx?.name?.value ?? null,
        expanded:
          summaryAx?.properties?.find((property) => property.name === 'expanded')?.value?.value ??
          null,
      };

      await pressEnterOn(nodeId);
      const closedByKey = await readMenu();

      await clickOn(nodeId);
      const openedByClick = await readMenu();

      return {
        url,
        loaded,
        scriptsDisabled,
        initial,
        openedByKey,
        accessible,
        closedByKey,
        openedByClick,
      };
    } finally {
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }, sessionId);
    }
  }

  // **幅を外側の輪にする。** `Emulation.setDeviceMetricsOverride` は 1 幅につき 1 回で
  // 済み、内側の輪は #282 のときと同じ「経路を順に開く」形のまま変わらない。
  const runs = [];
  for (const width of args.widths) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 800, deviceScaleFactor: 1, mobile: width < 700 },
      sessionId,
    );

    const observations = [];
    for (const path of args.paths) {
      const url = `${args.base}${path}`;
      const loaded = await navigate(url);

      const state = await cdp.send(
        'Runtime.evaluate',
        { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
        sessionId,
      );

      observations.push({ path, url, loaded, status, responseUrl, ...state.result.value });
    }

    const menu = args.menuPath === null ? null : await probeMenu(`${args.base}${args.menuPath}`);
    runs.push({ width, observations, menu });
  }

  cdp.socket.close();
  console.log(JSON.stringify({ widths: args.widths, runs }, null, 2));
} catch (error) {
  console.error(`[page-width-probe] ${String(error)}`);
  process.exitCode = 1;
} finally {
  if (child !== null) {
    child.kill('SIGTERM');
  }
  rmSync(userDataDir, { recursive: true, force: true });
}
