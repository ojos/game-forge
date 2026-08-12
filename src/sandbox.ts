/**
 * サンドボックス用ホスト（本番: `sandbox.game-forge.ojos.jp`）のレスポンスを組み立てる。
 *
 * M0.5-3 の時点では実際の `.wasm.br` はまだ無い。ここで確定させるのは
 * **ヘッダの形**であり、7.2 が必須要件として挙げた 3 点のうち、配信側が担う
 * 1 点目（CSP `sandbox` ヘッダ）をローカルで検証できるようにすることが目的である。
 */

/**
 * ユーザー生成コンテンツの配信レスポンスに付ける Content-Security-Policy。
 *
 * `sandbox allow-scripts` が要件の中核である（7.2）。iframe の `sandbox` 属性と違い、
 * **ドキュメント自身が不透明オリジンになる**ため、サンドボックス URL へ直接
 * アクセスされた場合でも cookie を持たず、リクエストは `Origin: null` の
 * cross-site 扱いになる。`allow-same-origin` は決して足さない。
 *
 * 既知の未解決点（M4-3 で解消する）:
 *   7.2 は `connect-src 'none'` まで絞ることを求める一方、3.4 は
 *   `WebAssembly.instantiateStreaming` の使用を求める。`instantiateStreaming` は
 *   `fetch` 経由で `.wasm.br` を取得するため、その取得は `connect-src` の管轄に入る。
 *   さらに `sandbox allow-scripts`（`allow-same-origin` なし）で不透明オリジンに
 *   なるため、`connect-src 'self'` も一致しない。実際に wasm を配信する M4-3 では、
 *   配信元ホストを明示列挙するなどの解決が要る。
 *   **M0.5-3 のこのページは wasm を読まないため、7.2 の記述どおり `'none'` のまま
 *   置く。**ここで先に緩めると、緩めた事実が誰にも引き継がれない。
 */
export const SANDBOX_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const PLACEHOLDER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Game Forge sandbox (local dev)</title>
<h1>sandbox origin</h1>
<p>M0.5-3 のローカル開発環境の疎通確認用プレースホルダです。実際の .wasm.br 配信は M4-3 で実装します。</p>
<pre id="cookie"></pre>
<script>
  // 不透明オリジンでは document.cookie は常に空になる。CSP sandbox が効いていることを
  // 目視でも確かめられるようにしておく。
  document.getElementById('cookie').textContent =
    'document.cookie = ' + JSON.stringify(document.cookie);
</script>
`;

/**
 * サンドボックス用ホストへのリクエストに対するレスポンスを返す。
 *
 * **cookie を一切設定しない。** 7.2 の 3 点目（`Domain=ojos.jp` の cookie を
 * どこにも置かない）に照らし、この経路が cookie を発行する余地を最初から作らない。
 *
 * @returns CSP `sandbox` ヘッダ付きのプレースホルダ HTML
 */
export function handleSandboxRequest(): Response {
  return new Response(PLACEHOLDER_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SANDBOX_CSP,
      // UGC は常に個別ファイルであり、CDN キャッシュはヒットしない前提（3.4-6）。
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
