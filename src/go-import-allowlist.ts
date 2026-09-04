/**
 * 生成された Go ソースで使ってよいパッケージの一覧（6.1 / 7.1 / #17）。
 *
 * **この配列が唯一の正である。** 6.1 は「許可パッケージのホワイトリストを明示し、
 * AST 検査（7.1）と一致させる」と定めるが、明示する先はシステムプロンプト（M2-2）と
 * 仕様書 6.1 の 2 か所あり、検査（`src/go-imports.ts`）を含めれば 3 か所になる。
 * **同じ一覧を 3 か所へ書き写すと必ずずれる**ので、ここを正としてプロンプトの一節を
 * 生成し（`renderAllowlistSection`）、仕様書との一致はテストで機械照合する
 * （shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
 *
 * ## 選定の根拠
 *
 * 6.1 の制約から必要なものだけを入れる。**足すのは、それを要する生成物が実際に
 * 書けないと分かった時点でよい。** 逆向き（先に広く許して後で絞る）は、既に生成された
 * 作品が動かなくなるため取り返しがつかない。
 *
 * ## 文字描画を許すことは決着済み（確定23 / #72）
 *
 * かつて 6.1 は「描画は `vector` パッケージによる図形描画、またはコード内の算術ピクセル
 * 描画に**限定する**」とし、8.3 は「`text` 描画で差別語を画面に出すことは容易であり」と
 * 述べて**文字描画が可能である前提で出力側モデレーションを設計していた。** #17 / #69 の
 * 時点ではこの食い違いが未決で、暫定的に 8.3 の前提を採って文字描画と埋め込みフォントを
 * 許可していた。
 *
 * **#72 で「文字描画を許す」と決着し、6.1 の「限定する」が改められた。** 根拠は、
 * 4.2 のトークンと成功率の実測がすべて文字描画ありで取られていること、サイズを対照した
 * 実測が存在しないこと（両方を含む隔離ビルドで brotli 後 1,987,011 bytes。3.4 の目標
 * 3MB に対し余裕がある。#76）、そして禁じてもコード内の算術ピクセル描画で任意のグリフを
 * 描けるため 8.3 の穴が塞がらないことである。
 *
 * **この決着で一覧は変わらない。** `text/v2` と `basicfont` はそのまま残る。決着したのは
 * 仕様書側の文言であり、ここを直す必要が生じたわけではない。
 *
 * ## 一覧はテンプレート自身のパッケージも載せる（#285）
 *
 * **この一覧が縛るのは「生成されたソースが何を import してよいか」であって、
 * import 先がどこから来るかではない。** `gameforge.local/sandbox/jpfont`（日本語の
 * 埋め込みフォント）は隔離ビルドのテンプレート自身のパッケージで、外部モジュールでは
 * ない。生成コードから見れば `basicfont` と同じ「import して使うもの」なので、
 * ここへ載せなければ AST 検査が落とす。
 *
 * **ただし vendor の扱いだけが違う。** `go mod vendor` はモジュール自身のパッケージを
 * 集めないため、`vendor-deps.go` へ書いてはいけない。この違いは
 * {@link requiresVendoring} が持つ。
 *
 * なお `text/v2` は許可するだけでは足りない。`text.NewGoXFace(basicfont.Face7x13)` を
 * はさむ必要があり、これを書かないとモデルは旧 `text`（v1）の書き方を出して 6 本中 6 本が
 * コンパイルに失敗する（#7 の実測。6.1「制約を並べるだけでは足りない」）。使い方は
 * システムプロンプト側（M2-2）の責務で、この一覧の責務ではない。
 */

/** 許可する 1 パッケージ。 */
export interface AllowedImport {
  /** import パス。 */
  readonly path: string;
  /** なぜ要るか。仕様書とプロンプトの両方へ出す。 */
  readonly reason: string;
}

/**
 * 許可するパッケージ。
 *
 * ここに無いものはすべて拒否する（`src/go-imports.ts`）。とくに `os` / `os/exec` /
 * `net` / `syscall` / `unsafe` / `embed` は、7.1 のコンテナが塞いでいる経路へ
 * 到達しようとする典型なので、**明示的に許可しない**ことに意味がある。
 */
export const GO_IMPORT_ALLOWLIST: readonly AllowedImport[] = [
  {
    path: 'github.com/hajimehoshi/ebiten/v2',
    reason: 'ebiten.Game の実装とゲームループ（6.1）',
  },
  {
    path: 'github.com/hajimehoshi/ebiten/v2/vector',
    reason: '図形描画。6.1 が描画手段として名指ししている',
  },
  {
    path: 'github.com/hajimehoshi/ebiten/v2/inpututil',
    reason: 'キーやボタンの押下・離上の検出。ebiten 本体だけでは前フレームとの差分が取れない',
  },
  {
    path: 'github.com/hajimehoshi/ebiten/v2/text/v2',
    reason: 'スコアなどの文字描画。8.3 が文字描画を前提に出力側モデレーションを設計している',
  },
  {
    path: 'golang.org/x/image/font/basicfont',
    reason: '文字描画に使う埋め込みフォント。外部ファイルを読まない（6.1 の全面禁止に抵触しない）',
  },
  {
    path: 'gameforge.local/sandbox/jpfont',
    reason:
      '日本語の文字描画に使う埋め込みフォント。ASCII と半角カナ ＋ JIS X 0208 の非漢字部を 16×16 のドットで持つ（漢字は無い）',
  },
  {
    path: 'image/color',
    reason: '描画色の指定。vector の描画 API が color.Color を受け取る',
  },
  {
    path: 'math',
    reason: '座標と当たり判定の計算',
  },
  {
    path: 'math/rand',
    reason: '敵の出現や乱数を使うゲーム性',
  },
  {
    path: 'strconv',
    reason: '数値から文字列への変換。6.1 が fmt を禁じているため、これが無いとスコアを表示できない',
  },
  {
    path: 'errors',
    reason: 'ebiten.Game.Update がゲーム終了を errors で返す（ebiten.Termination の判定）',
  },
];

/**
 * 隔離ビルドのテンプレートのモジュールパス（`docker/isolated-build/template/go.mod` の
 * `module` 行）。
 *
 * **この一覧には 3 種類が混ざっている。** 標準ライブラリ（`math` など）、外部モジュール
 * （`github.com/...` / `golang.org/x/...`）、そして**テンプレート自身のパッケージ**
 * （`gameforge.local/sandbox/jpfont`。#285）である。3 つは「どこから来るか」が違い、
 * とくに **vendor へ焼き込む必要があるかどうか**が違う（{@link requiresVendoring}）。
 *
 * 値を `go.mod` から読めないので、ここへ書き写している。**ずれても静かには壊れない**
 * ——テンプレート自身のパッケージが外部扱いへ落ちれば `vendor-deps.go` との照合が赤に
 * なり、逆にここを実在しないモジュール名にすれば、`jpfont` が外部扱いになって同じ照合が
 * 赤になる（`test/go-imports.test.ts`）。
 */
export const TEMPLATE_MODULE_PATH = 'gameforge.local/sandbox';

/**
 * 標準ライブラリでない import パスか。
 *
 * Go の判定と同じ規則で見る——**先頭セグメントにドットを含むものが標準ライブラリの外**
 * である（`math/rand` は含まず、`golang.org/x/image/font/basicfont` は含む）。
 *
 * @param path import パス
 * @returns 標準ライブラリでなければ true
 */
export function isExternalModulePath(path: string): boolean {
  return path.split('/')[0]!.includes('.');
}

/**
 * テンプレート自身（`gameforge.local/sandbox`）のパッケージか。
 *
 * 先頭一致ではなく**セグメント境界で見る。** `gameforge.local/sandboxfoo/x` のような
 * 別モジュールを取り違えると、vendor へ焼き込むべきものが黙って対象から外れる。
 *
 * @param path import パス
 * @returns テンプレート自身のパッケージなら true
 */
export function isTemplatePackage(path: string): boolean {
  return path === TEMPLATE_MODULE_PATH || path.startsWith(`${TEMPLATE_MODULE_PATH}/`);
}

/**
 * vendor へ焼き込む必要がある import パスか（`docker/isolated-build/template/vendor-deps.go`）。
 *
 * **「標準ライブラリでない」だけでは足りない。** `go mod vendor` が集めるのは
 * **依存モジュール**であって、モジュール自身のパッケージは vendor へ入らない。
 * `gameforge.local/sandbox/jpfont` はテンプレート自身の一部（#285）なので、
 * 外部モジュールと同じ扱いにすると「vendor 宣言に書いたのに vendor されない」
 * という、宣言と実体が食い違う状態になる。
 *
 * **緩めた側へ倒していない。** 判定から外れるのは
 * {@link TEMPLATE_MODULE_PATH} の下にあるものだけで、未知のホスト名は今までどおり
 * 「焼き込みが要る」と判定される（許可リストへ架空の外部パッケージを足せば、
 * `vendor-deps.go` との照合が赤になる）。
 *
 * @param path import パス
 * @returns vendor へ焼き込む必要があれば true
 */
export function requiresVendoring(path: string): boolean {
  return isExternalModulePath(path) && !isTemplatePackage(path);
}

/** 仕様書 6.1 の一覧を切り出すときの見出し。仕様書側を変えたらこちらも変える。 */
export const ALLOWLIST_SECTION_HEADING = '#### 許可パッケージのホワイトリスト';

/** 拒否する 1 つのコンパイラ指示。 */
export interface DeniedDirective {
  /** 指示の名前。`//` を除いた形（例: `go:wasmimport`）。 */
  readonly name: string;
  /** なぜ拒否するか。仕様書 6.1 へ出す。 */
  readonly reason: string;
}

/**
 * 拒否するコンパイラ指示（6.1 / 7.1 / #100）。
 *
 * **上の許可パッケージ一覧は「import 文で何を参照してよいか」しか決めていない。**
 * `//go:wasmimport` は **import 文を 1 つも書かずにホスト関数へ結び付ける**ため、
 * import を見る検査では原理的に検出できない。**これは `inspectGoImports` の
 * 実装上の欠陥ではなく、import 検査という手段の限界である。** そこで、同じソースに
 * 対して**別の軸**（コンパイラ指示）で 1 枚重ねる。
 *
 * ## 実測（2026-08-28 / Go 1.26.5 / #100）
 *
 * - `//go:wasmimport gojs syscall/js.valueCall` だけを書いた **import 文 0 個**の
 *   ソースが `GOOS=js GOARCH=wasm` でビルドでき、生成 wasm のインポート節に
 *   `gojs / syscall/js.valueCall` が実際に現れた（指示なしの対照では `runtime.*` の
 *   8 件しか現れないので、**この 2 件は指示だけが増やしている**）。
 * - その wasm は `WebAssembly.validate` を通り、Go 同梱の `wasm_exec.js` で走らせると
 *   **スタックトレースが `main.main → main.valueGet → syscall/js.valueGet`
 *   （`wasm_exec.js` の実装）まで到達した。** `wasm_exec.js` の import object は
 *   `gojs` に `syscall/js.*` を丸ごと並べているため、**到達できるのは
 *   `syscall/js` のホスト面すべてである。**
 * - 同じソースを `inspectGoImports` に掛けると `{"ok":true,"imports":[]}` を返した
 *   （対照の `import "os/exec"` は `not-allowed`）。
 *
 * ## `//go:linkname` をここへ入れない理由（実測で分かれた）
 *
 * **`//go:linkname` は迂回路ではない。** Go が
 * `//go:linkname only allowed in Go files that import "unsafe"` で拒否するため、
 * **必ず `import "unsafe"` を伴い、それは上の許可一覧が既に落とす**
 * （実測: `{"ok":false,"reason":"not-allowed","offending":["unsafe"]}`）。
 * **同じ「import を経由しない結び付け」に見えて、検出可能性がまったく違う。**
 * ここは「ホワイトリストで表現できないもの」だけを持つ。
 *
 * ## `//go:build` を入れない理由
 *
 * ビルド制約は正当な Go であり、ホスト関数への到達とは無関係である。**指示という
 * 見た目でまとめて落とすと、落とす理由を説明できない拒否が増える**（拒否は再生成に
 * 回さず即失敗させる設計なので、誤検出はそのまま利用者の 1 回分を捨てる）。
 */
export const GO_DIRECTIVE_DENYLIST: readonly DeniedDirective[] = [
  {
    name: 'go:wasmimport',
    reason: 'import 文を書かずにホスト関数を呼べる。許可パッケージ一覧では表現できない（#100 の実測）',
  },
  {
    name: 'go:wasmexport',
    reason: '生成物の関数をホストへ露出させる。同じく import 文に現れない（#100 の実測）',
  },
];

/** 仕様書 6.1 の禁止指示の表を切り出すときの見出し。仕様書側を変えたらこちらも変える。 */
export const DIRECTIVE_DENYLIST_SECTION_HEADING = '#### 禁止するコンパイラ指示';

/**
 * システムプロンプトへ埋め込む一節を組み立てる。
 *
 * **M2-2 はこの関数の出力を使うこと。** プロンプトへ一覧を手書きすると、ここと
 * ずれた瞬間に「プロンプトは許すが検査は落とす」パッケージが生まれ、生成が理由の
 * 分からない失敗を繰り返す。
 *
 * 出力に動的な値を含めない。6.1 が定めるとおり、システムプロンプトは prompt caching の
 * 共有プレフィックスであり（4.5）、呼び出しごとに変わる値が入るとキャッシュが効かない。
 *
 * @returns プロンプトへ埋め込む文字列
 */
export function renderAllowlistSection(): string {
  const lines = GO_IMPORT_ALLOWLIST.map((entry) => `- ${entry.path} — ${entry.reason}`);
  return [
    '使用してよいパッケージは次のものだけです。これ以外を import したコードは拒否されます。',
    ...lines,
  ].join('\n');
}
