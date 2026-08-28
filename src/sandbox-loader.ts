/**
 * サンドボックス用ホストが返すローダー文書を組み立てる（3.4 / #28）。
 *
 * この文書がやることは 2 つだけである。
 *
 *   1. `wasm_exec.js` を読む
 *   2. `WebAssembly.instantiateStreaming` で `.wasm` を起動する（3.4-2）
 *
 * # UGC 由来の文字列を 1 つも入れない
 *
 * タイトル・作者名・親作品名のいずれも入れない。**3.4-5 が求める「文脈の提示」は
 * 親ページ（アプリ用ホスト）の責務である**。ここは iframe の中身であり、親が既に
 * その情報を表示している。
 *
 * これは体裁の話ではなく安全側の決定である。CSP は `script-src 'unsafe-inline'` を
 * 許しており（起動スクリプトのため。`src/sandbox-csp.ts`）、この文書に UGC 由来の
 * 文字列を入れると**エスケープ漏れが即座にスクリプト実行になる。** 入れなければ、
 * その経路が最初から存在しない。
 */

/** ローダーが読む 2 つの資材のパス。**同一ホスト上の絶対パス**で渡す。 */
export interface LoaderAssetPaths {
  /** `wasm_exec.js` のパス（例: `/p/<key>/wasm_exec.js`）。 */
  readonly wasmExecPath: string;
  /** `.wasm` のパス（例: `/p/<key>/game.wasm`）。 */
  readonly wasmPath: string;
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
 * # `instantiateStreaming` を使う
 *
 * 3.4-2 が要求する。ストリーミングの取りこぼしを機構で塞ぐところ（フォールバック経路を
 * 持たせないこと・2 つのヘッダを配信側で保証すること）は M4-4（#29）の範囲である。
 *
 * @param paths ローダーが読む資材のパス
 * @returns HTML 文書
 */
export function loaderHtml(paths: LoaderAssetPaths): string {
  // パスは呼び出し側が検証済みの識別子（16 進 32 桁か UUID）からしか組み立たないが、
  // 埋め込みの安全は**埋め込む側**で閉じる。属性は HTML エスケープ、スクリプトは
  // JSON リテラルとして書き出す。
  const wasmExecAttribute = escapeHtml(paths.wasmExecPath);
  const wasmLiteral = JSON.stringify(paths.wasmPath);

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
</style>
<div id="gf-status">読み込み中</div>
<script src="${wasmExecAttribute}"></script>
<script>
(function () {
  var status = document.getElementById('gf-status');
  function fail(reason) {
    status.hidden = false;
    status.textContent = '起動できませんでした: ' + reason;
  }

  var go = new Go();
  WebAssembly.instantiateStreaming(fetch(${wasmLiteral}), go.importObject)
    .then(function (result) {
      status.hidden = true;
      return go.run(result.instance);
    })
    .catch(function (error) {
      // ここに到達するのは、取得の失敗・MIME type 不一致・wasm の不正のいずれか。
      // **握り潰さない。** 黙って白画面になると取り違えに気づけない。
      fail(String(error));
    });
})();
</script>
`;
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
