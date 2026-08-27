/**
 * 生成に使うシステムプロンプトの本文と、キャッシュブレークポイントの配置（6.1 / 4.5 / #16）。
 *
 * **このモジュールが持つのは「何を書くか」と「どこで区切るか」だけである。**
 * Bedrock への接続・署名・モデル選択は `src/bedrock.ts` と `src/generation-models.ts`
 * が持つ（#83）。`SystemPromptResolver` として渡すことで、本文を差し替えても
 * トランスポートに触らずに済む。
 *
 * ## 本文の構成（この順に並べる）
 *
 * 1. **役割と出力形式** — 何を出すか。整形の指示を最初に置く。
 * 2. **満たすべき構造** — `ebiten.Game` の厳格実装（6.1）。
 * 3. **禁止事項** — 外部ファイルロード / `fmt` / `reflect` / cgo / `//go:` 指示（6.1）。
 * 4. **許可パッケージ** — `renderAllowlistSection()` の出力をそのまま埋める。
 * 5. **許可 API の使い方** — #7 の実測で必須と分かった部分（下記）。
 * 6. **著作権と命名** — 6.2 の命名規制。
 * 7. **出力前の自己点検** — 上の各節を短い確認項目へ畳んだもの。
 *
 * 順序には理由がある。**出力形式を最初に、自己点検を最後に置く。** 生成物の 1 文字目が
 * `package main` でないと後段（`src/go-imports.ts` の `scanImports`）がそもそも読めず、
 * 「制約は守れているのに拒否される」失敗になる。整形の指示は、守られなかったときの
 * 損害が最も大きいので端に置いて埋没させない。
 *
 * ## 「制約を並べるだけでは足りない」（6.1 / #7 / #72）
 *
 * 5 節（許可 API の使い方）は装飾ではなく**必須**である。#7 の実測では、6.1 の制約と
 * 許可リストだけを与えた版で DeepSeek v3.2 が **6 本中 6 本コンパイルに失敗し、全部が
 * 同じ箇所（`text/v2` と `basicfont` の接続）で落ちた。** 一覧は 2 つを並べているが、
 * 両者は直接つながらず `text.NewGoXFace()` の橋渡しが要る。使い方を書き足したところ、
 * この原因の失敗は 0 本になった。**確定23 で文字描画を許した以上、この節を落とす選択肢は
 * 無い。**
 *
 * 5 節に書く API の形は、可能な範囲で **`docker/isolated-build/sample/ebitengine.go`
 * （隔離ビルドで実際にコンパイルが通っているサンプル）と機械照合する**
 * （`test/system-prompt.test.ts`）。プロンプトが存在しない API を教えると、4.2 が
 * 記録した Claude の失敗（存在しない API の捏造）を**こちらから作り出す**ことになる。
 *
 * ## モデルごとに出し分けない（決定と理由）
 *
 * 6.1 は「システムプロンプトはモデルごとに持つ（確定5）」と書いていたが、**現時点では
 * 全モデルへ同じ本文を出す。** 理由は 4 つで、仕様書 6.1 にも記録した。
 *
 * 1. **4.2 の実測は同一プロンプトで取られている。** 成功率（5/6 対 1/6）も単価も、
 *    プロンプトを揃えた条件での差である。出し分けると以後の比較が「モデルの差」ではなく
 *    「プロンプト＋モデルの差」になり、#25 の A/B が基準線を失う。
 * 2. **DeepSeek の支配的な失敗（未使用 import）は、既に共通プロンプトへ書いた状態で
 *    起きている。** #7 の v2 版は「未使用 import 禁止」を含んでいて、なお 6 本中 2 本が
 *    未使用 import だけで落ちた。**文言の追加で消えなかった失敗**なので、モデル別の
 *    文言を足す根拠にならない。ここは #20 の機械修正が担う（1/6 → 3/6）。
 * 3. **Claude の失敗（存在しない API の捏造）に効く文言は測っていない。** 未測定の差分を
 *    入れると、キャッシュのプレフィックスが 2 本に割れる（4.5）うえ、効いたかどうかを
 *    確かめる手段が無い。捏造対策は 5 節（実在する API の明示）として**共通側**へ入れた。
 * 4. **出し分けは制約文の 2 本目を作ることであり、複製になる**（shared-ai-rules 12 章）。
 *
 * **継ぎ目は残す。** `SystemPromptResolver` は引数にモデルを取り、この関数もそれを
 * 受ける。出し分けが要るとわかった日に、型も呼び出し側も変えずに分岐できる。
 * **分岐を入れるときは、それを正当化する実測を併せて残すこと。**
 *
 * ## キャッシュブレークポイントは末尾に 1 つだけ（4.5 / 4.1）
 *
 * `cachePoint` は「ここまでが共有プレフィックス」を意味する区切りである。本文は全生成で
 * 共有され、動的値を一切含まないので、**全体が 1 つのプレフィックスになる。** したがって
 * 区切りは末尾に 1 つで足りる。途中にも置かない理由は 2 つある。
 *
 * - **最小キャッシュ長がある**（4.5: Sonnet で 1,024 トークン）。本文全体でも 2,000
 *   トークン程度なので、途中で割ると片側が最小長を下回り、その区切りは無効になる。
 * - **区切りごとにキャッシュ書き込み（5 分 TTL で 1.25 倍）が発生する。** 増やす利得が
 *   無い以上、増やさない。
 *
 * 親ソース（フォーク）用の 2 つ目の区切りは `messages` の先頭に置く（4.5）。**`system`
 * 側には置かない。** 親ごとに変わる値であり、ここへ混ぜるとシステムプロンプトの
 * キャッシュが親ごとに割れる。
 *
 * **キャッシュ次元を持たないモデル（DeepSeek）への配慮はここでは行わない。**
 * `toConverseSystem`（`src/bedrock.ts`）が落とす。配置を決める側がモデルごとの可否を
 * 知らずに済む形は #83 が用意した継ぎ目である。
 *
 * ## 動的値を一切含めない（4.5 / 6.1）
 *
 * タイムスタンプ・UUID・利用者 ID をプロンプトへ入れると、プレフィックスが毎回変わって
 * キャッシュが常時ミスし、4.5 の設計が空になる。**この禁止は呼びかけではなく機械で
 * 確かめる**（`test/system-prompt.test.ts` が、`Date` と `crypto.randomUUID` を
 * 呼べなくした状態で組み立てられることと、2 回の出力が一致することを見る）。
 *
 * **本文を変えるとキャッシュは作り直しになる。** 1 回分の書き込み（1.25 倍）で済むが、
 * 頻繁に変えると常時ミスと同じになる。文言の調整はまとめて行うこと。
 */
import type { GenerationModel, SystemBlock } from './generation-models.js';
import { renderAllowlistSection } from './go-import-allowlist.js';

/**
 * 生成ソースの上限バイト数（確定18 / 5.3）。
 *
 * **プロンプトへ数値を書き写さず、この定数から埋める。** 5.3 の上限を実際に検査する段
 * （超過時の整理パス）を作るときは、そこでも定数を作らずこれを import すること。
 * 静的な値なので、埋め込んでもキャッシュのプレフィックスは変わらない。
 */
export const MAX_SOURCE_BYTES = 30 * 1024;

/**
 * 1 節: 役割と出力形式。
 *
 * **コードフェンスの禁止を最優先で書く。** `scanImports`（`src/go-imports.ts`）は
 * `package` 句を見つけられない入力を `unparsable` として拒否するため、前置きや
 * フェンスが 1 行付くだけで、中身が完璧でも生成が丸ごと無駄になる。
 */
const ROLE_AND_OUTPUT = `あなたは Go と Ebitengine でブラウザゲームを書く実装者です。利用者の指示を読み、単一ファイルの Go プログラムを出力します。

出力の決まり:
- 出力は Go のソースコードそのものだけにします。前置き・説明・後書きを書きません。
- マークダウンのコードフェンス（バッククオート 3 つの囲み）を付けません。最初の行は package main です。
- ファイルは 1 つだけです。複数ファイルへ分けません。
- ソース全体を ${MAX_SOURCE_BYTES} バイト以内に収めます。`;

/**
 * 2 節: 満たすべき構造（6.1 の「`ebiten.Game` の厳格な実装」）。
 *
 * `main` の形をそのまま示すのは、`ebiten.RunGame` が終了時に `ebiten.Termination` を
 * 返す仕様を知らないと、正常終了が `panic` になるためである。**この形は隔離ビルドの
 * サンプルで実際にコンパイルが通っている。**
 */
const REQUIRED_STRUCTURE = `満たすべき構造:
- 1 つの構造体に ebiten.Game を厳格に実装します。次の 3 つを必ず揃えます。
	func (g *Game) Update() error
	func (g *Game) Draw(screen *ebiten.Image)
	func (g *Game) Layout(outsideWidth, outsideHeight int) (int, int)
- Layout は固定の論理解像度を返します（例: return 320, 240）。引数から計算しません。
- main は次の形にします。

	func main() {
		g := &Game{}
		ebiten.SetWindowSize(640, 480)
		if err := ebiten.RunGame(g); err != nil && !errors.Is(err, ebiten.Termination) {
			panic(err)
		}
	}

- ゲームを終わらせるときは Update から ebiten.Termination をそのまま返します。errors.New で包みません。
- 遊べる状態にします。操作でき、得点か勝敗があり、初期化だけで終わらないこと。`;

/**
 * 3 節: 禁止事項（6.1）。
 *
 * ## `//go:` 指示を禁じる判断（#100 / 必ず守る制約）
 *
 * **禁じる。** `//go:wasmimport` は import 文を持たずにホスト関数を呼べる経路で、
 * `src/go-imports.ts` のホワイトリスト検査は import 文しか見ないため**構造的に検出
 * できない。** 検査を足すのは #100 の範囲だが、それが入るまでの間、生成物がこの経路を
 * 使うと「通ったのに後から落ちる」作品が生まれる。書くコストは 1 行で、失うものが無い。
 *
 * **ただしこれを防御と数えない。** プロンプトは攻撃者に対して何も保証しない（利用者は
 * プロンプトを書く側であり、システムプロンプトを無視するよう指示できる）。ここに書くのは
 * **善意の生成物がうっかり踏むのを避けるため**であって、#100 の検査を不要にするもの
 * ではない。
 */
const PROHIBITIONS = `禁止:
- 外部ファイルとネットワークからの読み込みを全面的に禁止します。画像・音声・フォントのファイルを読みません（ebitenutil.NewImageFromURL、os.Open、http.Get、embed など）。素材はコードの中で作ります。
- fmt と reflect を使いません（Wasm のバイナリサイズを削るため）。数値から文字列へは strconv を使います（strconv.Itoa / strconv.FormatFloat）。
- println と print を使いません。
- cgo を使いません（import "C" を書きません）。
- //go: で始まるコンパイラ指示を書きません。とくに //go:wasmimport と //go:linkname は禁止です。これらは import を経由せずに外部の関数へ結び付ける経路で、下の許可パッケージの一覧では表現できません。
- 時間を time で測りません。経過時間はフレーム数で数えます（Update は毎秒 60 回呼ばれます）。`;

/**
 * 4 節: 許可パッケージ。
 *
 * **一覧を書き写さない。** `renderAllowlistSection()` の出力をそのまま埋める
 * （`src/go-import-allowlist.ts` が正本）。プロンプト側へ手書きすると、AST 検査
 * （`src/go-imports.ts`）とずれた瞬間に「プロンプトは許すが検査は落とす」パッケージが
 * 生まれ、生成が理由の分からない失敗を繰り返す（shared-ai-rules 12 章）。
 *
 * 続く 3 行は一覧の複製ではなく、**一覧の読み方**である。とくに `text/v2` は import パスの
 * 末尾とパッケージ名が食い違い（パス末尾は `v2`、パッケージ名は `text`）、#72 の実測では
 * 6 本中 1 本が**旧 v1 のパスを import して許可外**になっている。
 */
const ALLOWED_PACKAGES = `${renderAllowlistSection()}

- import したパッケージは必ず使います。使わないものは import しません（Go は未使用 import をコンパイルエラーにします）。
- github.com/hajimehoshi/ebiten/v2/text/v2 のパッケージ名は text です。旧 github.com/hajimehoshi/ebiten/v2/text（v1）は一覧に無く、import すると拒否されます。
- 一覧に無いものが必要になったら、その案を諦めて一覧の中だけで書き直します。import を増やして解決しません。`;

/**
 * 5 節: 許可 API の使い方（#7 / #72 の実測。**必須**）。
 *
 * ## なぜ「一覧」ではなく「使い方」まで書くのか
 *
 * 6.1「制約を並べるだけでは足りない」に対応する。一覧を示すだけでは、モデルは学習データ中の
 * 古い用例（`text` v1）を出す。#7 の実測で 6 本中 6 本が同じ箇所で落ち、下の 3 行を
 * 書き足して 0 本になった。
 *
 * ## vector を「使ってよい 4 つ」に絞る理由
 *
 * 4.2 が記録した Sonnet 4.6 の唯一の失敗は `vector.DrawFilledRoundRect` という**存在しない
 * API の捏造**である。`vector` には実際には他にも API があるので「これしか無い」とは
 * 書かない（嘘になる）。**こちらが使わせる範囲として絞る**書き方にして、捏造の余地を
 * 減らす。
 *
 * ## float32 と int を混ぜないことを書く理由
 *
 * #7 の失敗のうち 2 本は int / float64 の混在だった。`vector` の座標は float32、
 * `text` の測定値は float64、`ebiten.CursorPosition` は int と、型が節ごとに違う。
 */
const API_USAGE = `許可された API の使い方（このとおりに書いてください。古い書き方ではコンパイルが通りません）:

フォントと文字描画:

	face := text.NewGoXFace(basicfont.Face7x13)
	op := &text.DrawOptions{}
	op.GeoM.Translate(8, 8)
	op.ColorScale.ScaleWithColor(color.White)
	text.Draw(screen, "SCORE "+strconv.Itoa(g.score), face, op)
	w, h := text.Measure("SCORE", face, 0)

- basicfont.Face7x13 を text.Face や text.GoTextFace として直接渡すことはできません。必ず text.NewGoXFace ではさみます。
- text.Draw の引数は 4 つです。座標と色は op で与えます。
- text.Measure の戻り値は 2 つ（幅と高さ、float64）です。
- face は毎フレーム作らず、初期化時に 1 度だけ作って構造体へ持たせます。

図形描画（vector で使うのは次の 4 つだけにします。丸角矩形のような便利関数を思い付いても使いません）:

	vector.DrawFilledRect(screen, x, y, w, h, color.RGBA{0x33, 0xcc, 0x99, 0xff}, true)
	vector.DrawFilledCircle(screen, cx, cy, r, clr, true)
	vector.StrokeLine(screen, x0, y0, x1, y1, width, clr, true)
	vector.StrokeRect(screen, x, y, w, h, width, clr, true)

- 座標・サイズ・線幅はすべて float32 です。最後の引数はアンチエイリアスの有無です。
- ゲームの状態を float64 で持つなら float32(g.x) と明示的に変換します。Go は int と float64 と float32 を暗黙に混ぜません。

入力:

	if inpututil.IsKeyJustPressed(ebiten.KeySpace) { }
	if ebiten.IsKeyPressed(ebiten.KeyLeft) { }
	if inpututil.IsMouseButtonJustPressed(ebiten.MouseButtonLeft) { }
	mx, my := ebiten.CursorPosition()

- 押した瞬間は inpututil、押している間は ebiten です。ebiten だけでは前フレームとの差分が取れません。
- ebiten.CursorPosition の戻り値は int です。

乱数と計時:

	rand.Intn(10)
	rand.Float64()
	g.tick++

- rand.Seed は呼びません（現行の Go では何もしません）。
- 経過時間はフレーム数で数えます（60 フレーム = 1 秒）。`;

/**
 * 6 節: 著作権と命名（6.2）。
 *
 * **6.2 が「使わせる」と書いている規制なので、システムプロンプトに置く。** 入力側の
 * モデレーション（#37）と出力側の文字列リテラル検査（#38）は別の層で、ここはその
 * 代わりにはならない。**確定23 で文字描画を許した結果、商標がそのまま画面へ出る経路が
 * できたため、6.2 は命名規制の重みが増したと明記している。**
 */
const COPYRIGHT = `著作権と命名:
- 有名な作品名やキャラクター名を指示されたら、拒否せずに遊びの仕組みだけを取り出し、名前・見た目・固有名詞をオリジナルへ置き換えます。
- 変数名・関数名・画面へ出す文字列に、商標や作品固有の名前を使いません。player / enemy / block のような一般名詞を使います。`;

/**
 * 7 節: 出力前の自己点検。
 *
 * 上の各節を短い項目へ畳んだもの。**新しい制約をここへ足さない**（ここだけに書かれた
 * 制約ができると、上の節との二重管理になる）。
 */
const SELF_CHECK = `出力する前に自分で確かめること:
- 最初の行が package main で、説明文やコードフェンスが混ざっていない
- import が許可された一覧の中だけで、そのすべてを実際に使っている
- Update / Draw / Layout の 3 つが揃っている
- text と vector の呼び出しが上の形と一致している
- ${MAX_SOURCE_BYTES} バイト以内に収まっている`;

/**
 * システムプロンプトの本文（節ごとに分けたもの）。
 *
 * **順序に意味がある**（モジュール冒頭の説明を参照）。`readonly` の配列としてそのまま
 * 公開するのは、テストが節の並びと内容を直接見られるようにするため。
 */
export const SYSTEM_PROMPT_SECTIONS: readonly string[] = [
  ROLE_AND_OUTPUT,
  REQUIRED_STRUCTURE,
  PROHIBITIONS,
  ALLOWED_PACKAGES,
  API_USAGE,
  COPYRIGHT,
  SELF_CHECK,
];

/**
 * 本文を 1 つの文字列にしたもの（デバッグとテスト用）。
 *
 * 実際の送信は節ごとのブロックで行う（`buildSystemPrompt`）ため、この関数の出力が
 * そのまま送られるわけではない。**トークン数の見積もりと、動的値が無いことの確認**に使う。
 *
 * @returns 節を空行でつないだ本文
 */
export function renderSystemPromptText(): string {
  return SYSTEM_PROMPT_SECTIONS.join('\n\n');
}

/**
 * システムプロンプトを組み立てる（`SystemPromptResolver` の実装）。
 *
 * **末尾に `cachePoint` を 1 つだけ置く。** 理由はモジュール冒頭の
 * 「キャッシュブレークポイントは末尾に 1 つだけ」を参照。キャッシュ次元を持たない
 * モデルでは `src/bedrock.ts` が落とすので、ここではモデルを見ない。
 *
 * @param model 生成に使うモデル。**現時点では本文を変えない**（冒頭「モデルごとに
 *   出し分けない」）。6.1 が要求する継ぎ目として引数に残してある
 * @returns システムプロンプトのブロック列
 */
export const buildSystemPrompt = (model: GenerationModel): readonly SystemBlock[] => {
  // 引数を受けておきながら使わないことを明示しておく。**分岐を入れる日には、それを
  // 正当化する実測をこの位置のコメントとして残すこと。**
  void model;
  return [...SYSTEM_PROMPT_SECTIONS.map((text) => ({ text })), { cachePoint: true }];
};
