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
 * を作るときは、そこでも定数を作らずこれを import すること。
 * 静的な値なので、埋め込んでもキャッシュのプレフィックスは変わらない。
 *
 * **境界の読み方（何バイトから警告するか、ちょうどの値はどちら側か）は
 * `src/source-size.ts` が持つ**（確定18 の条件 1・24KB → 51.2KB。#33）。値と読み方は
 * 別々に変わるので、あちらはこの定数を import して割合から導く。
 *
 * ## 30KB から 64KB へ引き上げた（2026-09-04 / #284）
 *
 * **「30KB ≒ 1 万トークン」という前提が覆った。** 旧値はソース 3.07 バイト/token を
 * 前提にしていたが、`output_tokens` には thinking が乗るため**ソースのバイト数から
 * 割った値は分母を取り違えている。** R2 の `source.go` 4 本での実測は
 * **2.0 バイト/output token**（1.99〜2.07）で、64KB は約 32,768 トークンにあたる。
 *
 * **上限サイズ・`maxTokens`・時間予算の 3 つは連動する**（`src/generation-models.ts` の
 * `maxTokens` = 33,000 / `terraform/orchestrator.tf` の `orchestrator_generation_seconds`）。
 * どれか 1 つだけを動かすと、`max_tokens` での切断か、関数の時間切れのどちらかになる。
 *
 * **ビルド側は反応しない**（実測。1.8KB / 24KB / 65KB でビルド時間 8.06〜8.23 秒、
 * 65,020 バイトのソースが brotli 後 2,318,938 バイトで 3MB の内側）。
 */
export const MAX_SOURCE_BYTES = 64 * 1024;

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
- ソース全体を ${MAX_SOURCE_BYTES} バイト以内に収めます。
- 元のソースを渡されたときも、この上限は変わりません。指示された変更を加えたうえで、全体をこのバイト数に収めます。上限に近いときは、重なっている処理を 1 つにまとめ、使っていない変数と関数を削ってから足します。それでも収まらないなら、足す機能のほうを減らします。`;

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
 *
 * ### #100 の完了後の訂正（2026-08-28）
 *
 * 上の記述は 2 点で古い。**旧記述はそのまま残す**（判断の経緯として意味があるため）。
 *
 * 1. **`//go:linkname` は「構造的に検出できない」側ではなかった。** Go が
 *    `//go:linkname only allowed in Go files that import "unsafe"` で拒否するため、
 *    **必ず `import "unsafe"` を伴い、それはホワイトリスト検査が既に落とす**（#100 の実測）。
 *    構造的に検出できないのは `//go:wasmimport` と `//go:wasmexport` のほうである。
 * 2. **「検査を足すのは #100 の範囲」は解消した。** `findDeniedDirectives`
 *    （`src/go-imports.ts`）が `//go:wasmimport` / `//go:wasmexport` を字句解析で拒否する。
 *
 * **下の禁止文（`PROHIBITIONS`）は変えない。** 2 つを並べて禁じること自体は正しく
 * （書かせない意味はある）、**プロンプトの文面を変えると生成の挙動が変わり、
 * 仕様書 6.1 が記録している文面とも食い違う。** 不正確なのは理由付けの一節だけで、
 * 指示そのものは有効である。
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
 * ## フォントを 1 つに絞る理由（#285）
 *
 * **日本語の埋め込みフォント（`jpfont`）を入れた結果、一覧にフォントが 2 つ並んだ。**
 * ここでは `jpfont.Face16` だけを教える。理由は 3 つある。
 *
 * 1. **`jpfont` は英数字も持つ。** ASCII を含めて焼いてあるので、日本語を出すゲームで
 *    フォントを 2 つ抱える理由が無い。混ぜると行の高さが 16px と 13px で食い違う。
 * 2. **`basicfont` は一覧から外せない。** 外すと既存作品のフォークで親ソースの import が
 *    拒否され、フォークが壊れる（#285 の scope.out）。**一覧に残すことと、新しい生成物へ
 *    使わせることは別である。** 一覧は `renderAllowlistSection()` が機械的に出すので、
 *    「一覧にあるが使わない」ことは**この節で明示するしかない**（黙っていると、モデルは
 *    学習データで見慣れた `basicfont` を選ぶ）。
 * 3. **収録範囲の限界を、使い方と同じ場所に書く必要がある。** 漢字は入っておらず、
 *    収録外は代替の升目（枠に×）になる。罫線は 16 升へ収まらないので枠は `vector` で
 *    描かせる（実測は `tools/fontbake/main.go` にある）。**どちらも「許可された API の
 *    使い方」であって、禁止事項の節（3 節）に置くと使い方から離れる。**
 *
 * **プロンプトは防御ではない**（3 節の注記と同じ）。「漢字を使わない」が守られなかった
 * ときは代替の升目が画面へ出て、作者が見て気づける——`jpfont` 側がそう作ってある。
 *
 * ## 音の使い方をここへ書く理由（#286）
 *
 * **一覧に `audio` を足しただけでは、モデルは音を鳴らせない。** 学習データで見慣れた
 * 書き方は `audio/vorbis` や `audio/wav` でファイルを読む形であり、**そのデコーダは
 * 一覧に無い**（外部アセットの持ち込み経路になるため。`src/go-import-allowlist.ts`）。
 * 何も書かなければ、モデルは一覧に無いデコーダを import して拒否されるか、音を諦める。
 * 6.1「制約を並べるだけでは足りない」が `text/v2` について言っていることが、そのまま
 * ここにも当てはまる。
 *
 * 書くのは 5 つである。
 *
 * 1. **`audio.NewContext` は初期化時に 1 度だけ。** 2 度目は `panic` する
 *    （ebiten の実装。プロセスに 1 つしか持てない）。**毎フレーム作る形は
 *    `text.NewGoXFace` で既に踏んでいる失敗**なので、同じ注意を音にも置く。
 * 2. **`NewPlayerF32` を使い、`NewPlayer`（16 ビット整数版）は教えない。** ebiten
 *    自身が「新しいコードは `NewPlayerF32` が望ましい。将来は内部で 32bit float だけを
 *    扱う」と明記している。**「後から外すのは危険」（`src/go-import-allowlist.ts` の
 *    方針）は API の選択にも効く**——int16 版を教えて、それが将来外れると、**既に
 *    生成された作品のフォークが壊れる**（フォークは親ソースを現物のイメージで
 *    再コンパイルする）。**一覧はパッケージ単位なので、どちらを教えても許可の広さは
 *    変わらない。** 変わるのは寿命だけである。
 * 3. **`NewPlayerF32` へ渡すのは自前の `Read` を持つ型である。** ここが合成のみという
 *    制約の実体で、**ファイルを開く余地が構造的に無い。**
 * 4. **PCM の形（32 ビット浮動小数点・リトルエンディアン・2 チャンネル）。** 書かないと
 *    雑音になる。**雑音は「動くが壊れている」ので、コンパイルの成否では捕まらない。**
 *    バイトへ並べる手段も書く——`encoding/binary` も `unsafe` も一覧に無いので、
 *    **`math.Float32bits` しか経路が無い。**
 * 5. **最初の入力より前に音へ依存しない。** ブラウザはクリックやキー押下より前に
 *    音を鳴らさない（`IsReady` の doc が明記している）。**これは行儀の話ではない**
 *    ——OGP は headless chromium で初回フレームを撮るので、音が鳴るまで進まない
 *    ゲームは 1 枚も撮れない（5.4 / #26）。
 *
 * **音の長さや音量を「制限」として書かない**（#286 の scope.out）。6.1 はプロンプトを
 * 防御と数えないので、書いても守られたことにならない。**書いてよいのは使い方だけ**で、
 * 内容を止める役は 8.4 の通報が負う（8.3 は音に対して検査対象を持たない。仕様 8.3）。
 *
 * ## 鳴らし直す形をここへ足した理由（#301）
 *
 * **#286 の配備後、本番の生成物がスペースキー 2 回で固まった。** 生成物は
 * `player.Rewind()` を呼んでいた。ebiten v2.9.9 で `Rewind()` は `SetPosition(0)` で、
 * その先は `timeStream.Seek` の
 * `panic("audio: the source must be io.Seeker when seeking but not")`
 * （`audio/player.go:474`）である。**`NewPlayerF32` は渡された音源が `io.Seeker` かを
 * 見て `seekable` を決める**（`audio/audio.go:383`）ので、上の 3 が言う「自前の `Read`
 * を持つ型」は必ず `seekable == false` になる。**合成のみと決めた時点で、`Rewind` /
 * `SetPosition` / 旧 `Seek` は使えない。** wasm の panic はキャンバスごと止まる。
 *
 * **1 度目は通り、2 度目で落ちる。** `SetPosition` は `offset == 0 && p.player == nil`
 * を早期に返すため、最初の 1 回（まだ `Play()` していない状態）は panic しない。
 * **「音が鳴る作品を 1 本作って 1 回試す」受け入れでは見つからない**——本番の実測が
 * 2 回目で固まったのはこの構造である。
 *
 * **音源へ `io.Seeker` を実装させる案は採らない**（#301 の scope.out）。`Rewind` は
 * 通るようになるが、教える API が増え、`io` の import が要る（#286 で「不要」を
 * 実測して外したばかりである。`docker/isolated-build/sample/ebitengine.go` の注記）。
 *
 * **禁止だけを書かない。** 「`Rewind` を使うな」だけを足すと、モデルは別の壊れ方
 * （鳴らすたびに `NewPlayerF32` で作り直す、など）へ流れる。**正しい形を先に示し、
 * 禁止をその理由として添える**——本番の生成物は「音源が持つ位置を自分で戻す」正しい
 * 形を既に書けていて、余分な 1 行で死んでいた。**サンプルの `tone` に長さ（`pos`）と
 * `restart()` を足したのはこのためである。** 終わりの無い矩形波のままでは「鳴らし直す」
 * が観測できず、教える形とビルドで通した形を機械照合できない
 * （`test/system-prompt.test.ts`）。
 *
 * ## float32 と int を混ぜないことを書く理由
 *
 * #7 の失敗のうち 2 本は int / float64 の混在だった。`vector` の座標は float32、
 * `text` の測定値は float64、`ebiten.CursorPosition` は int と、型が節ごとに違う。
 */
const API_USAGE = `許可された API の使い方（このとおりに書いてください。古い書き方ではコンパイルが通りません）:

フォントと文字描画:

	face := text.NewGoXFace(jpfont.Face16)
	op := &text.DrawOptions{}
	op.GeoM.Translate(8, 8)
	op.ColorScale.ScaleWithColor(color.White)
	text.Draw(screen, "SCORE "+strconv.Itoa(g.score), face, op)
	text.Draw(screen, "スコア "+strconv.Itoa(g.score), face, op)
	w, h := text.Measure("SCORE", face, 0)

- 使うフォントは 1 つだけです。英数字もひらがな・カタカナも jpfont.Face16 で描きます。許可パッケージの一覧には basicfont もありますが、これは既存の作品のために残してあるもので、新しく書くゲームでは import しません。
- jpfont.Face16 を text.Face や text.GoTextFace として直接渡すことはできません。必ず text.NewGoXFace ではさみます。
- 漢字を使いません。画面へ出す文字は、ひらがな・カタカナ・英数字・記号だけにします。このフォントが持っているのは ASCII と半角カナ、および JIS X 0208 の非漢字部だけで、漢字は入っていません。入っていない文字は、代わりに升目（枠に×）が画面へ出ます。
- 枠や区切りを罫線の文字（─ │ ┌ ┐）で描きません。文字として並べても隙間なく繋がりません。枠の線は vector.StrokeRect、塗りつぶしは vector.DrawFilledRect で描きます。
- 文字の高さは 16 ピクセルです。送り幅は半角が 8 ピクセル、全角が 16 ピクセルで、文字ごとに変わります。並べる位置を自分で計算せず、幅が要るときは text.Measure で測ります。
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

音（波形をコードで作ります。音声ファイルは読みません）:

	const sampleRate = 48000

	type tone struct {
		freq  float64
		vol   float64
		phase float64
		pos   int
	}

	func (t *tone) restart() {
		t.phase = 0
		t.pos = 0
	}

	func (t *tone) Read(buf []byte) (int, error) {
		n := len(buf) / 8 * 8
		step := t.freq / float64(sampleRate)
		for i := 0; i < n; i += 8 {
			var level float32
			if t.pos < sampleRate/10 {
				level = float32(t.vol)
				if math.Mod(t.phase, 1) >= 0.5 {
					level = -level
				}
			}
			bits := math.Float32bits(level)
			buf[i] = byte(bits)
			buf[i+1] = byte(bits >> 8)
			buf[i+2] = byte(bits >> 16)
			buf[i+3] = byte(bits >> 24)
			buf[i+4] = buf[i]
			buf[i+5] = buf[i+1]
			buf[i+6] = buf[i+2]
			buf[i+7] = buf[i+3]
			t.phase += step
			t.pos++
		}
		return n, nil
	}

	audioContext := audio.NewContext(sampleRate)
	shot := &tone{freq: 440, vol: 0.2}
	player, err := audioContext.NewPlayerF32(shot)
	if err != nil {
		panic(err)
	}

	if inpututil.IsKeyJustPressed(ebiten.KeySpace) && audioContext.IsReady() {
		shot.restart()
		player.Play()
	}

- audio.NewContext は初期化時に 1 度だけ呼びます。2 度呼ぶとその場で落ちます。player も毎フレーム作らず、初期化時に作って構造体へ持たせます。
- 再生は NewPlayerF32 で始めます。NewPlayer（16 ビット整数版）は使いません。
- NewPlayerF32 へ渡すのは、上の tone のように Read(buf []byte) (int, error) を持つ自前の型です。音声ファイルを読み込む方法はありません（デコーダのパッケージは許可されていません）。
- 波形は math で作ります。上は矩形波（math.Mod で位相の前半と後半を切り替えたもの）です。三角波や鋸波にするなら、level の計算だけを変えます。
- 渡すのは 32 ビット浮動小数点のリトルエンディアン・2 チャンネルです。1 サンプルが 8 バイトで、左右へ同じ 4 バイトを書きます。長さは必ず 8 の倍数にします。
- level は -1.0 から 1.0 までの範囲にします。バイトへ並べるには math.Float32bits を使います（encoding/binary と unsafe は許可されていません）。
- 音の長さは音源が自分で数えます。上は 0.1 秒（sampleRate/10 サンプル）だけ鳴らし、そのあとは無音（level が 0）を書き続けます。ストリームは終わらせないので、Read が返す error は常に nil です。
- 同じ音をもう一度鳴らすときは、音源が自分で持っている位置（上の pos と phase）を 0 へ戻してから player.Play() を呼びます。上の restart がそれです。player は作り直さず、同じものを鳴らし直します。
- player.Rewind と player.SetPosition（古い名前の player.Seek も同じものです）は呼びません。コードで作った音源は io.Seeker ではないので、呼ぶとその場で panic して画面が固まります。位置を戻すのは音源の側です。
- 音を鳴らすのは、最初のキー入力かクリックのあとにします。ブラウザは利用者が操作するまで音を鳴らしません。鳴らせる状態かは audioContext.IsReady() で分かります。
- ゲームの進行を音に依存させません。音が鳴らなくても、最初のフレームから画面が動いて遊べる状態にします。

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
- 画面へ出す文字列に漢字が混ざっていない（フォントに漢字は入っていません）
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
