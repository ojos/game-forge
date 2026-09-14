/**
 * サンドボックス用ホストが返すローダー文書を組み立てる（3.4 / 3.5 / #29）。
 *
 * この文書がやることは 3 つだけである。
 *
 *   1. `go_version` に対応する `wasm_exec.js` を読む（3.5）
 *   2. `WebAssembly.instantiateStreaming` で `.wasm` を起動する（3.4-2）
 *   3. タップをマウスの操作として canvas へ渡す（3.9.3 / #491。{@link TAP_TO_MOUSE_SCRIPT}）
 *
 * # UGC 由来の文字列を 1 つも入れない
 *
 * タイトル・作者名・親作品名のいずれも入れない。**3.4-5 が求める「文脈の提示」は
 * 親ページ（アプリ用ホスト）の責務である**。ここは iframe の中身であり、親が既に
 * その情報を表示している（`src/work-page.ts` の `loadingScreen`。#30 で実装した）。
 *
 * これは体裁の話ではなく安全側の決定である。CSP は `script-src 'unsafe-inline'` を
 * 許しており（起動スクリプトのため。`src/sandbox-csp.ts`）、この文書に UGC 由来の
 * 文字列を入れると**エスケープ漏れが即座にスクリプト実行になる。** 入れなければ、
 * その経路が最初から存在しない。
 */

/**
 * ローダーが Wasm を起動した直後に、親（作品ページ）へ送る合図（#377）。
 *
 * **中身はこの固定の文字列 1 つだけである。** 作品 id も時刻も載せない——受け手
 * （`src/plays.ts` の作品ページのスクリプト）は、どの作品のページかを自分で知っている。
 * 送り手の文書では UGC（Wasm）が動くので、**合図の中身を信じる形にしない**（受け手が
 * 信じるのは「自分の iframe から届いたこと」だけである）。
 */
export const LOADER_STARTED_MESSAGE = 'gf-loader-started';

/**
 * タップをマウスの操作として canvas へ渡すスクリプト（仕様 3.9.3 / #491。M14-2）。
 *
 * # なぜ要るのか
 *
 * **Ebitengine はブラウザで `touchstart` の `preventDefault` を呼ぶ**ので、ブラウザは互換の
 * マウスイベントを作らない。マウスを読む作品（`CursorPosition` / `IsMouseButton*`）は、
 * タッチ端末ではタップに反応しない（仕様 3.9.1）。Ebitengine はマウスを canvas の
 * リスナーで受けて `button` と `clientX` / `clientY` だけを読み、`isTrusted` を見ないので、
 * **ここで合成したイベントで補える。**
 *
 * # 何をするか（仕様 3.9.3 の表のとおり）
 *
 * - `document` に `touchstart` / `touchmove` / `touchend` / `touchcancel` を**捕捉段・passive** で付ける。
 *   **`preventDefault` も `stopPropagation` も呼ばない**——Ebitengine の canvas のリスナーは、
 *   これまでどおり本物のタッチを受ける。
 * - **指が 1 本も触れていない状態で始まった `touchstart` の最初の指だけ**を追う（マルチタッチは扱わない）。
 * - その指について、canvas へ `mousemove` → `mousedown`（始まり）/ `mousemove`（動き）/
 *   `mouseup`（離れた・取り消された。最後の座標で）を送る。左ボタン、座標は指の値そのまま。
 * - **canvas がまだ無いとき（起動前）は送らない。** 起動前の座標は Ebitengine が捨てる。
 *
 * # 起動の経路と分けて置く
 *
 * **起動スクリプト（`instantiateStreaming` の経路。#180 / #181）とは別の `<script>` にする。**
 * 2 度壊れた経路の中へ入力の処理を混ぜない。起動の成否にも依らない（canvas が無ければ何もしない）。
 *
 * # 固定の文字列である
 *
 * **埋め込む値を 1 つも持たない**（テンプレートの差し込みが無い）。したがって UGC 由来の文字列が
 * 入る経路は、この定数には最初から存在しない。CSP の `script-src 'unsafe-inline'` は
 * 起動スクリプトのために既にあり、**許可集合を 1 要素も広げていない**（仕様 3.9.8）。
 *
 * デスクトップの操作は変わらない。マウスとペンではタッチイベントが発火しないためである。
 */
export const TAP_TO_MOUSE_SCRIPT = `(function () {
  // 追っている指の identifier。null は「追っていない」。
  var trackedId = null;
  // 最後に見た指の座標。mouseup はこの座標で送る。
  var lastX = 0;
  var lastY = 0;

  function findTracked(touches) {
    for (var i = 0; i < touches.length; i++) {
      if (touches[i].identifier === trackedId) {
        return touches[i];
      }
    }
    return null;
  }

  // canvas は Ebitengine が起動時に作る。無ければ（起動前は）何も送らない。
  function sendMouse(type, buttons) {
    var canvas = document.querySelector('canvas');
    if (canvas === null) {
      return;
    }
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: buttons,
      clientX: lastX,
      clientY: lastY
    }));
  }

  function onStart(event) {
    // 指が 1 本も触れていなかったときだけ始める（touches には今触れた指も含まれる）。
    // それ以外は、追っている指があるか、後から足された指なので無視する。
    if (event.touches.length !== event.changedTouches.length) {
      return;
    }
    var touch = event.changedTouches[0];
    trackedId = touch.identifier;
    lastX = touch.clientX;
    lastY = touch.clientY;
    // 押す前にそこへ動いている、という本物のマウスの順序に合わせる。
    sendMouse('mousemove', 1);
    sendMouse('mousedown', 1);
  }

  function onMove(event) {
    if (trackedId === null) {
      return;
    }
    var touch = findTracked(event.changedTouches);
    if (touch === null) {
      return;
    }
    lastX = touch.clientX;
    lastY = touch.clientY;
    sendMouse('mousemove', 1);
  }

  function onEnd(event) {
    if (trackedId === null || findTracked(event.changedTouches) === null) {
      return;
    }
    trackedId = null;
    sendMouse('mouseup', 0);
  }

  // 捕捉段・passive。既定の動作も伝播も止めない（Ebitengine の canvas は本物のタッチを受け続ける）。
  // テストがこの綴りの不在を見るので、止める API の名前をこのスクリプトに書かない。
  var options = { capture: true, passive: true };
  document.addEventListener('touchstart', onStart, options);
  document.addEventListener('touchmove', onMove, options);
  document.addEventListener('touchend', onEnd, options);
  document.addEventListener('touchcancel', onEnd, options);
})();`;

/** ローダーが読む 2 つの資材のパスと、合図の送り先。 */
export interface LoaderAssetPaths {
  /** `wasm_exec.js` のパス（例: `/p/<key>/wasm_exec.js`）。**同一ホスト上の絶対パス**で渡す。 */
  readonly wasmExecPath: string;
  /** `.wasm` のパス（例: `/p/<key>/game.wasm`）。**同一ホスト上の絶対パス**で渡す。 */
  readonly wasmPath: string;
  /**
   * 親アプリのオリジン（例: `https://game-forge.ojos.jp`）。起動の合図
   * （{@link LOADER_STARTED_MESSAGE}）を `postMessage` で送る先に使う（#377）。
   *
   * **配信側が知っている値を渡す**（`src/sandbox-delivery.ts` の `responseContextOf`。
   * `frame-ancestors` と同じ値）。**UGC 由来ではない。**
   */
  readonly parentOrigin: string;
}

/**
 * ローダー文書を組み立てる。
 *
 * # 相対パスではなく絶対パスを埋める理由
 *
 * `/p/<key>` と `/p/<key>/` のどちらでも同じ文書を返す（`src/sandbox-delivery.ts`）。
 * 相対パスを書くと、末尾スラッシュの有無で解決先が変わり、片方だけが動く。
 * リダイレクトで揃える手もあるが、**サンドボックス経路でリダイレクトを増やしたくない**
 * （CSP のパス一致はリダイレクトを跨ぐと無効化されるため、`connect-src` を 1 点へ
 * 絞った意味が薄れる。`src/sandbox-csp.ts`）。絶対パスなら、どちらの綴りでも同じ 1 本を指す。
 *
 * # `instantiateStreaming` がフォールバック経路へ落ちない
 *
 * 3.4-2 の受け入れ条件である。**非ストリーミングの代替を 1 行も書かない。**
 * `wasm_exec.js` の同梱例や巷のテンプレートは
 * `if (!WebAssembly.instantiateStreaming) { ... arrayBuffer ... }` を書いていることが
 * 多く、これがあると、ヘッダを 1 つ落としただけで**黙って非ストリーミングになる。**
 * 落ちたことに誰も気づけないのが最大の問題なので、代替を用意せず**失敗として見せる。**
 *
 * 下の `typeof ... !== 'function'` は代替ではなく、その逆である。使えないと分かった
 * 時点で理由を表示して止める（フォールバックは「別の方法で成功させてしまう」）。
 *
 * # ロード進捗（#30 / 3.4-5）
 *
 * **段階を出す。割合は出さない。** ここに出せるのは実際に区別できる状態だけで、
 * 「資材の読み込み中」と「ゲーム本体の取得・コンパイル中（2〜3MB。待ち時間の大半）」の
 * 2 つがそれにあたる。
 *
 * **割合（%）を出さない理由は 2 つある。**
 *
 * 1. **分母が取れない。** `.wasm` は brotli 事前圧縮で配信され（3.4-1）、`fetch` は
 *    経路上で透過的に展開する。`Content-Length` は**圧縮後**の長さで、`body` から
 *    流れてくるのは**展開後**のバイト列である。突き合わせた割合は必ず狂う。
 *    **#180 / #181 は「経路が透過的に展開しうる」ことを勘定に入れ損ねた事故**であり、
 *    同じ勘定違いをもう一度画面へ出すことになる。
 * 2. **数えるには本文を挟む必要がある。** `fetch` の応答を包み直して
 *    `instantiateStreaming` へ渡す形になる。**そこは 2 度壊れた経路である**（#180 / #181）。
 *    割合の表示は、その経路へ手を入れる理由として釣り合わない。
 *
 * `<progress>` は値を持たない（不確定）。**知らないことを知らないと言う形**であり、
 * 進んでいないのに進んで見える棒よりも正確である。
 *
 * # 起動の合図を親へ送る（#377 / 仕様 2.3.5）
 *
 * **プレイ数は「Wasm が実際に起動したとき」に数える**（issue #377 の constraints）。起動を
 * 知っているのはこの文書だけなので、`instantiateStreaming` が解決して `#gf-status` を隠し、
 * **`go.run` を呼んだ後**に、**親へ {@link LOADER_STARTED_MESSAGE} を 1 回だけ送る**（`go.run` が
 * 同期的に投げたら送らない。PR #425 の Copilot の指摘）。 数える
 * のは受け取った作品ページの側である（`src/plays.ts`）。
 *
 * - **親が居ないときは送らない**（`window.parent === window`）。**OGP の撮影
 *   （`docker/ogp-shot`）は `/g/<id>/` をトップレベルで開く**ので、合図は出ず、受け手の
 *   スクリプトもそもそも存在しない——**撮影は仕組みの上で数えられない。**
 * - **送り先のオリジンを `'*'` にしない。** 親アプリのオリジン（{@link LoaderAssetPaths.parentOrigin}）
 *   だけへ送る。`frame-ancestors` が同じオリジンに絞っているので通常は他に届かないが、
 *   二重に閉じる。
 * - **この文書は外へ通信しない**（`connect-src` はその作品の `.wasm` 1 本のまま。
 *   `postMessage` は CSP の管轄ではなく、許可集合を 1 要素も広げていない）。
 *
 * @param paths ローダーが読む資材のパス
 * @returns HTML 文書
 */
export function loaderHtml(paths: LoaderAssetPaths): string {
  // パスは呼び出し側が検証済みの識別子（16 進 32 桁か UUID）からしか組み立たないが、
  // 埋め込みの安全は**埋め込む側**で閉じる。属性は HTML エスケープ、スクリプトは
  // JSON リテラルとして書き出す。
  const wasmExecAttribute = escapeHtml(paths.wasmExecPath);
  const wasmLiteral = scriptLiteral(paths.wasmPath);
  const parentOriginLiteral = scriptLiteral(paths.parentOrigin);
  const startedLiteral = scriptLiteral(LOADER_STARTED_MESSAGE);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Game Forge</title>
<style>
  /* Ebitengine は canvas を自分で作って body へ足す。余白を消して全面に見せる。 */
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  canvas { display: block; }
  #gf-status {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #ccc; font: 14px/1.6 system-ui, sans-serif; text-align: center; padding: 1rem;
  }
  /* hidden 属性は display:none 相当だが、上の display:flex のほうが詳細度で勝つ。
     この 1 行が無いと status.hidden = true が効かず、起動後も文字が残る。 */
  #gf-status[hidden] { display: none; }
  #gf-status > div { max-width: 20rem; width: 80%; }
  #gf-progress { width: 100%; height: 0.5rem; }
  #gf-progress[hidden] { display: none; }
</style>
<div id="gf-status">
  <div>
    <p id="gf-phase">読み込み中</p>
    <progress id="gf-progress"></progress>
  </div>
</div>
<script>
${TAP_TO_MOUSE_SCRIPT}
</script>
<script src="${wasmExecAttribute}"></script>
<script>
(function () {
  var status = document.getElementById('gf-status');
  var phase = document.getElementById('gf-phase');
  var progress = document.getElementById('gf-progress');
  function fail(reason) {
    status.hidden = false;
    // **止まったことを棒でも示す。** 動く棒を残したまま失敗の文言を出すと、
    // まだ進んでいるように見える。
    progress.hidden = true;
    phase.textContent = '起動できませんでした: ' + reason;
  }

  // **フォールバックではない。** ここで代替の読み込み方へ分岐すると、3.4-2 が
  // 避けたい非ストリーミング経路が黙って成立する。使えないなら失敗として見せる。
  if (typeof WebAssembly.instantiateStreaming !== 'function') {
    fail('WebAssembly.instantiateStreaming がありません');
    return;
  }
  if (typeof Go !== 'function') {
    fail('wasm_exec.js を読み込めませんでした');
    return;
  }

  // **ここから先が待ち時間の大半である**（2〜3MB の取得とコンパイル）。
  // 上の 2 つの検査を通ったことは、資材が揃ったことを意味する。
  phase.textContent = 'ゲームを読み込んでいます';

  var go = new Go();
  WebAssembly.instantiateStreaming(fetch(${wasmLiteral}), go.importObject)
    .then(function (result) {
      status.hidden = true;
      // **先に起動する。** go.run が同期的に投げたら、合図を送らずにそのまま投げる
      // （起動していないものを数えない）。
      var running = go.run(result.instance);
      // **起動の合図（#377）。** 親が居るときだけ、親アプリのオリジンへ 1 回送る。
      // トップレベルで開かれた文書（OGP の撮影を含む）は送らない。送れなくても起動は止めない。
      if (window.parent !== window) {
        try {
          window.parent.postMessage(${startedLiteral}, ${parentOriginLiteral});
        } catch (error) {
          // 合図はプレイ数のためだけにある。**遊ぶことを妨げない。**
        }
      }
      return running;
    })
    .catch(function (error) {
      // ここに到達するのは、取得の失敗・MIME type 不一致・wasm の不正のいずれか。
      // **握り潰さない。** 黙って白画面になるとヘッダの取り違えに気づけない。
      fail(String(error));
    });
})();
</script>
`;
}

/**
 * `<script>` の中へ文字列リテラルとして埋めてよい形へ落とす。
 *
 * `JSON.stringify` だけでは `</script>` を閉じられる（`<` がそのまま残る）ので、`<` を
 * `\u003c` へ置き換える。値は配信側の固定の材料だけだが、**埋め込みの安全は埋め込む側で閉じる。**
 *
 * @param value 埋め込む文字列
 * @returns JavaScript の文字列リテラル
 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

/**
 * HTML の属性値へ埋めてよい形へ落とす。
 *
 * @param value 埋め込む文字列
 * @returns エスケープ済みの文字列
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}
