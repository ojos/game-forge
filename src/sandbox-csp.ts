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
 * # 緩めたこと: `script-src` に `blob:` を足した（#306）
 *
 * **これも意図的な緩和であり、7.2 の記述との差分である。** `connect-src` のときと同じ形で、
 * 理由と範囲をここに残す。
 *
 * ## なぜ足さざるを得ないのか
 *
 * **6.1 が許した音（`ebiten/v2/audio`）は、oto を通じて AudioWorklet を使う。** oto は
 * ワークレットのモジュールを**その場で組み立てた `blob:` URL** から読み込む。ワークレットの
 * モジュール読み込みは `script-src` の管轄（Chromium は `script-src-elem` の fallback として
 * `script-src` で照合する）なので、`blob:` が無いと `addModule()` が拒否され、
 * **`AbortError` で音の初期化が丸ごと失敗する。** #306 の本番の症状はこれで、
 * **#286 が入れた音は 1 度も鳴っていなかった。**
 *
 * 迂回できないかを検討したが、いずれも成立しない。
 *
 * - **URL を列挙する。** `blob:` URL は実行時に生成される UUID で、**事前に書けない。**
 *   不透明オリジンでは接頭辞も `blob:null/` になる。
 * - **`'unsafe-inline'` で足りる。** 足りない。ワークレットは**外部モジュールの取得**であり、
 *   インライン指定は一致しない（実測。上の症状がまさにそれである）。
 * - **oto に別の経路を使わせる。** 生成物が使うのはライブラリの既定経路であり、
 *   プロンプトで書き換えさせる形は 6.1 が防御と数えない層になる。
 *
 * ## どこまで緩めたか（何が失われたか）
 *
 * - **`blob:` が指せるのは、この文書自身が `URL.createObjectURL` で作った物だけである。**
 *   スキーム全体を開けたように見えるが、**他所から持ち込める URL ではない。** 中身の出所は
 *   必ずこの文書の中で組み立てられたバイト列で、それを組み立てられるのは
 *   **既にこの文書で動いているスクリプト**である。
 * - **したがって「任意のスクリプトが動くようになった」という劣化は起きていない。**
 *   `script-src` には元々 `'unsafe-inline'` があり、**この文書ではもともと任意のスクリプトが
 *   動く。** 封じ込めを担っているのは script-src ではなく、**不透明オリジン・別ホスト・
 *   `connect-src` の 1 点許可**の側である（上記）。`blob:` はそのどれにも触れない。
 * - **失われたのは「文書に流し込めるスクリプトの綴りが 1 種類増えた」ことである。**
 *   具体的には、`blob:` を経由すると **`'unsafe-inline'` を外した将来の版でも**
 *   スクリプトを動かせる。**`'unsafe-inline'` を外す道を 1 本狭めた**という意味で、
 *   これは受け入れた劣化である。
 * - **`connect-src` は緩めていない。** `blob:` の取得は `connect-src` の管轄に入らないため、
 *   外へ出られる宛先は 1 つも増えていない。**実ブラウザで確認済み**
 *   （`scripts/check-sandbox-browser.sh` の層 5。`connect-src` をその作品の `.wasm` 1 本に
 *   絞ったまま `addModule()` が通る）。
 *
 * ## 検査は実ブラウザが持つ
 *
 * **この不具合は CSP を読む検査では原理的に捕まらない。** #180 と同じ形である
 * （`scripts/check-sandbox-browser.sh` の冒頭）。**層 5 が実ブラウザで
 * `audioWorklet.addModule(blob:)` を通す。** `blob:` を消せば赤くなる（実測）。
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
 * `blob:` は AudioWorklet のモジュール読み込みに要る（#306。理由と、緩めた範囲は
 * `sandboxCsp` の「緩めたこと: `script-src` に `blob:` を足した」）。**文書以外の
 * レスポンスにも付く**——`scriptUrl` が null のときも消さない。ワークレットを読むのは
 * 文書だけだが、**ここで分岐を増やすと「どちらの綴りが本番か」が読みにくくなる**うえ、
 * `blob:` は文書自身が作った物しか指せないため、他のレスポンスで許しても指せる先が無い。
 *
 * @param scriptUrl 許す外部スクリプトの絶対 URL（無ければ null）
 * @returns `script-src` ディレクティブ
 */
function scriptSrc(scriptUrl: string | null): string {
  const sources = ["'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:'];
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
