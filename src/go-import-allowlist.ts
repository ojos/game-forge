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
 * ## 6.1 と 8.3 の食い違いについて
 *
 * 6.1 は「描画は `vector` パッケージによる図形描画、またはコード内の算術ピクセル描画に
 * **限定する**」とする。一方 8.3 は「`text` 描画で差別語を画面に出すことは容易であり」と
 * 述べ、**文字描画が可能である前提で出力側モデレーションを設計している。** 両立しない。
 *
 * ここでは 8.3 の前提を採り、ebitengine の文字描画と埋め込みフォントを許可している。
 * スコアや残機の表示に文字が要る以上、禁止すると 8.3 のモデレーション自体が
 * 空振りになるためである。**この判断は仕様書の食い違いを解消するものではない。**
 * 6.1 の文言を直すか、文字描画を落として 8.3 を書き換えるかは、別途決める必要がある。
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

/** 仕様書 6.1 の一覧を切り出すときの見出し。仕様書側を変えたらこちらも変える。 */
export const ALLOWLIST_SECTION_HEADING = '#### 許可パッケージのホワイトリスト';

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
