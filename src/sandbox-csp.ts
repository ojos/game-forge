/**
 * サンドボックス用ホストの Content-Security-Policy を組み立てる（7.2 / #28）。
 *
 * **この 1 ファイルが、7.2 の必須要件 1 と `connect-src` の到達範囲を決めている。**
 * 配信の都合（`src/sandbox-delivery.ts`）と混ぜないために分けてある。緩めるなら、
 * 緩めた事実と理由はここに残る。
 */

/**
 * このポリシーが許す取得先。**null は「その種類の取得を一切許さない」を意味する。**
 *
 * URL は**絶対 URL**（`https://host/path` の形）で渡す。理由は下の
 * `sandboxCsp` の「なぜ `'self'` が使えないのか」を参照。
 */
export interface SandboxCspSources {
  /** `wasm_exec.js` の絶対 URL。文書以外のレスポンスでは null。 */
  readonly scriptUrl: string | null;
  /** `game.wasm` の絶対 URL。`instantiateStreaming` の `fetch` 先。文書以外では null。 */
  readonly connectUrl: string | null;
  /** この文書を iframe に入れてよい親のオリジン（アプリ用ホスト）。 */
  readonly frameAncestorOrigin: string | null;
}

/**
 * 配信レスポンスに付ける CSP を組み立てる。
 *
 * # 変えていないこと（7.2 の必須要件 1）
 *
 * `sandbox allow-scripts` は据え置く。iframe の `sandbox` 属性と違い、**ドキュメント
 * 自身が不透明オリジンになる**ため、サンドボックス URL へ直接アクセスされた場合でも
 * cookie を持たず、リクエストは `Origin: null` の cross-site 扱いになる。
 * **`allow-same-origin` は決して足さない。**
 *
 * # 緩めたこと: `connect-src 'none'` → 配信元 URL の 1 点列挙
 *
 * **これは意図的な緩和であり、7.2 の記述との差分である。** 黙って緩めると、次に読む人が
 * 「7.2 を満たしている」と誤読するため、ここに理由と範囲を残す。
 *
 * ## なぜ緩めざるを得ないのか
 *
 * 3.4-2 は `WebAssembly.instantiateStreaming` の使用を求める。`instantiateStreaming` は
 * `Response`（＝ `fetch` の結果）を受け取る API であり、**その `fetch` は `connect-src` の
 * 管轄に入る。** `connect-src 'none'` のままでは wasm を取得できない。
 *
 * 迂回できないかを検討したが、いずれも成立しない。
 *
 * - **wasm を HTML へ data: URL で埋め込む。** `fetch('data:...')` も `connect-src` の
 *   管轄で、しかも base64 で 4/3 に膨らみ、ストリーミングでもなくなる（3.4-2 が
 *   避けたい非ストリーミング経路そのもの）。
 * - **`fetch` をやめて `WebAssembly.instantiate(ArrayBuffer)` にする。** バイト列を得る
 *   手段が結局 `fetch` か `XMLHttpRequest` で、どちらも `connect-src` の管轄。
 *   3.4-2 が禁じた非ストリーミング経路にもなる。
 * - **`<link rel="preload" as="fetch">` で先に取る。** これも `connect-src`。
 *
 * ## なぜ `'self'` が使えないのか
 *
 * `sandbox allow-scripts` を付けた文書は**不透明オリジン**になる。`'self'` は文書自身の
 * オリジンと突き合わせる指定なので、**不透明オリジンでは何にも一致しない。**
 * ホストを明示列挙するのが唯一の解になる。
 *
 * ## どこまで緩めたか
 *
 * **ホスト全体ではなく、その作品が使う 1 つの URL だけを許す。** CSP のソース式は
 * パスまで書ける（末尾が `/` でなければ完全一致）。すなわち
 * `connect-src https://sandbox.example/p/<key>/game.wasm` は、**同じホストの別の作品の
 * wasm へも、配信経路の他のパスへも一致しない。**
 *
 * ## 何が失われたか（7.2 の分担表への影響）
 *
 * 7.2 は「`connect-src 'none'` を緩める場合、7.1 と 7.2 の分担を先に見直すこと」と
 * 書いている。見直した結果は次のとおりである。
 *
 * - **失われたのは「外へ一切出られない」という性質である。** `syscall/js` のホスト面へ
 *   到達できる生成物（7.1 の `//go:wasmimport` の穴）は、この 1 点の許可を使える。
 * - **失われていないもの。** (1) 許可先は自分自身の `.wasm` 1 本だけで、**第三者への
 *   送出経路にならない**（情報送出・マイニングのプール接続・DDoS 踏み台は、いずれも
 *   任意の宛先を要する）。(2) 不透明オリジンのままなので資格情報は載らない。
 *   (3) `default-src 'none'` により、他の取得手段（`img-src` の URL、`form-action`、
 *   `base-uri`）は閉じたままである。
 * - **残る穴。** 許可された 1 本の URL へ何度でも繰り返し取得できる。R2 のエグレスは
 *   無料（3.1）だが、Workers のリクエスト数は消費する。**これは受け入れた劣化である。**
 *   塞ぐには配信側でレート制限が要り、#28 の範囲を超える。
 *
 * # `script-src` も同じ理由で列挙する
 *
 * `wasm_exec.js` は外部スクリプトであり、不透明オリジンでは `'self'` が一致しない。
 * 同じくパスまで含めた 1 点で許す。`'unsafe-inline'` はローダーの起動スクリプト
 * （`src/sandbox-loader.ts`）のために要る。**この文書に UGC 由来の文字列は 1 つも
 * 入れていない**ため（タイトルも作者名も入れない。3.4-5 の文脈提示は親ページの責務）、
 * `'unsafe-inline'` が UGC の混入経路にならない。
 *
 * # `img-src` から `'self'` を落とした
 *
 * 上と同じ理由で不透明オリジンでは一致せず、**書いてあるのに効かない指定**だった。
 * 誤読の元なので落とす。Ebitengine の描画は canvas / WebGL であり、画像要素を使わない。
 *
 * # `frame-ancestors` を足した
 *
 * `default-src` は `frame-ancestors` を代行しない（fetch ディレクティブではない）ため、
 * 書かなければ誰でも埋め込める。親アプリだけに絞る。**トップレベルの直接アクセスは
 * 妨げない**ので、URL を踏むコア体験（3.4-6）には影響しない。
 *
 * @param sources 許す取得先（null はその種類を許さない）
 * @returns `Content-Security-Policy` ヘッダの値
 */
export function sandboxCsp(sources: SandboxCspSources): string {
  const directives = [
    // 7.2 必須要件 1。**この行は動かさない。**
    'sandbox allow-scripts',
    "default-src 'none'",
    scriptSrc(sources.scriptUrl),
    connectSrc(sources.connectUrl),
    // 不透明オリジンでは `'self'` が一致しないため書かない（上記）。
    'img-src data:',
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    frameAncestors(sources.frameAncestorOrigin),
  ];
  return directives.join('; ');
}

/**
 * `script-src` を組み立てる。
 *
 * `'wasm-unsafe-eval'` は wasm のコンパイルに要る（これが無いと
 * `WebAssembly.instantiateStreaming` 自体が CSP で落ちる）。**`'unsafe-eval'` ではない。**
 * 前者は wasm のコンパイルだけを許し、JavaScript の `eval` は許さない。
 *
 * @param scriptUrl 許す外部スクリプトの絶対 URL（無ければ null）
 * @returns `script-src` ディレクティブ
 */
function scriptSrc(scriptUrl: string | null): string {
  const sources = ["'unsafe-inline'", "'wasm-unsafe-eval'"];
  if (scriptUrl !== null) {
    sources.push(scriptUrl);
  }
  return `script-src ${sources.join(' ')}`;
}

/**
 * `connect-src` を組み立てる。
 *
 * **既定は `'none'` である。** 文書以外のレスポンス（wasm 本体・スクリプト・エラー）では
 * 許可する先が無いため、7.2 の記述どおりに閉じる。緩むのは、実際に wasm を読む文書を
 * 返すときだけである。
 *
 * @param connectUrl 許す取得先の絶対 URL（無ければ null）
 * @returns `connect-src` ディレクティブ
 */
function connectSrc(connectUrl: string | null): string {
  return connectUrl === null ? "connect-src 'none'" : `connect-src ${connectUrl}`;
}

/**
 * `frame-ancestors` を組み立てる。
 *
 * @param origin 埋め込みを許す親のオリジン（無ければ null）
 * @returns `frame-ancestors` ディレクティブ
 */
function frameAncestors(origin: string | null): string {
  return origin === null ? "frame-ancestors 'none'" : `frame-ancestors ${origin}`;
}
