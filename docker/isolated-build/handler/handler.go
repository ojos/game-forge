package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Event は Workers から渡される入力（3.3-5）。
//
// **呼び出し側は #19（M2-5）が実装する。** ここが持つのは器の側の契約だけである。
type Event struct {
	// Source は生成された Go のソース 1 ファイル分。
	Source string `json:"source"`
}

// Artifact は成果物 1 つ分の申告。
type Artifact struct {
	Bytes           int64  `json:"bytes"`
	SHA256          string `json:"sha256"`
	ContentEncoding string `json:"contentEncoding,omitempty"`
	// Data は base64（改行なし）。**R2 へ書かない構成のときだけ載る**（3.3-6 が
	// 成立して以降、本番では返らない。`Result.Storage` の注記）。
	// 未圧縮 wasm は 8〜12 MB（3.4）あり、Lambda の同期応答 6 MB を超えるため、
	// 載せるとしても圧縮後の成果物だけである。
	Data string `json:"data,omitempty"`
}

// Result は呼び出し元へ返す結果（3.3-7）。
//
// # OK=false は関数の障害ではない
//
// 生成されたコードがコンパイルを通らないことは**平常の結果**である。Runtime API の
// エラー経路（/invocation/{id}/error）へ流すと、呼び出し側からは関数の故障と
// 区別できず、3.8 の degrade 判定（「ビルド依頼の失敗」で発火する）が誤爆する。
// **利用者のコードの問題は 200 応答の中の ok=false で返す。**
type Result struct {
	OK bool `json:"ok"`
	// Stage は ok=false のときにどこで止まったか。"request" / "build" / "compress"。
	Stage   string `json:"stage,omitempty"`
	Message string `json:"message,omitempty"`

	// GoVersion は 3.5 の `wasm_exec.js` 出し分けのために games.go_version へ入る値。
	GoVersion string `json:"goVersion,omitempty"`

	Wasm       *Artifact `json:"wasm,omitempty"`
	Compressed *Artifact `json:"compressed,omitempty"`

	// Storage は R2 へ書いたオブジェクトのキー（3.3-6 / 3.3-7）。
	//
	// **これが本来の運び方である。** 器の段階では `Compressed.Data` に本体を載せて
	// いたが、3.3-6 は「ビルド関数が R2 へ直接書く」と定めている。書いたときは
	// **本体を返さず、キーだけを返す**（呼び出し側は `games` 行と索引へ写す）。
	//
	// 書かない構成（`R2_UPLOAD=skip`。ローカルの封じ込め検査だけが使う）のときだけ
	// nil になり、代わりに `Compressed.Data` が入る。**両方が空になることは無い。**
	Storage *StoredArtifacts `json:"storage,omitempty"`

	// Timings は 3.8 のタイムアウト（10 秒）に対する内訳。**どの段が食っているかを
	// 呼び出し側とログの両方から読めるようにする。** brotli の品質を変える判断は
	// この値でしか行えない。
	Timings Timings `json:"timings"`
}

// Timings は各段の所要時間（ミリ秒）。
type Timings struct {
	ResetMs    int64 `json:"resetMs"`
	PrepareMs  int64 `json:"prepareMs"`
	BuildMs    int64 `json:"buildMs"`
	CompressMs int64 `json:"compressMs"`
	// UploadMs は R2 への書き戻し（3.3-6。SSM の 1 往復と PUT 2 本）。
	// **書かない構成では 0 になる。**
	UploadMs int64 `json:"uploadMs"`
	TotalMs  int64 `json:"totalMs"`
}

// Handler は 1 つの関数インスタンスが持つ設定。
//
// 値はすべて外から与える。**既定値をハンドラのロジックへ焼き込まない**のは、
// 「どの品質で圧縮しているか」「どこを掃除しているか」を宣言（Terraform）と
// 検査（scripts/acceptance-remote.sh）から読めるようにするためである。
type Handler struct {
	// ScratchRoot は毎回掃除する領域。本番では /tmp。
	ScratchRoot string
	// TemplateDir は vendor 済みテンプレートの焼き込み先（イメージ内・読み取り専用）。
	TemplateDir string
	// BrotliQuality は 3.4-1 の事前圧縮の品質。
	BrotliQuality int
	// DiagnosticLimit はビルド診断を切り詰める長さ。
	DiagnosticLimit int

	// Upload は成果物を R2 へ書き戻す段（3.3-6）。
	//
	// **nil は「書かない」を意味する。** そう読ませてよいのは、`R2_UPLOAD=skip` が
	// 明示されたときだけである（`r2SettingsFromEnv`）。環境変数が落ちた事故で nil に
	// なる経路は main 側で塞いである。**ここで nil を「まだ実装していない」と読んで
	// 黙って成功にしない**（3.3-6 が成立していない状態を 200 で返すと、呼び出し側は
	// `games` 行を作れないのに理由が分からない）。
	//
	// 差し替え可能にしてあるのは、**単体テストが実 R2 を要求しないため**である
	// （`src/bedrock.ts` / `src/build-client.ts` と同じ継ぎ目の置き方）。
	Upload func(ctx context.Context, req uploadRequest) (*StoredArtifacts, error)

	// compile / compress は差し替え可能にしてある。**テストのためだけではない。**
	// 掃除がハンドラの先頭で走ることを、後段を落としたうえで確かめられる形にする
	// のが目的である（7.1 は掃除を「テスト可能な単位」にすることを受け入れの条件に
	// している）。nil のときは実物を使う。
	compile  func(ctx context.Context, workDir, outPath string) ([]byte, error)
	compress func(ctx context.Context, quality int, srcPath, dstPath string) ([]byte, error)
}

// NewHandler は本番の設定でハンドラを作る。
//
// @param scratchRoot 毎回掃除する領域
// @param templateDir vendor 済みテンプレートの位置
// @param quality brotli の品質
// @param upload R2 への書き戻し（nil は「書かない」。判断は main が持つ）
// @returns ハンドラ
func NewHandler(
	scratchRoot, templateDir string,
	quality int,
	upload func(ctx context.Context, req uploadRequest) (*StoredArtifacts, error),
) *Handler {
	return &Handler{
		ScratchRoot:     scratchRoot,
		TemplateDir:     templateDir,
		BrotliQuality:   quality,
		DiagnosticLimit: 8192,
		Upload:          upload,
	}
}

func (h *Handler) compileFn() func(context.Context, string, string) ([]byte, error) {
	if h.compile != nil {
		return h.compile
	}
	return compileWasm
}

func (h *Handler) compressFn() func(context.Context, int, string, string) ([]byte, error) {
	if h.compress != nil {
		return h.compress
	}
	return compressBrotli
}

// Handle は 1 回の呼び出しを処理する。
//
// # 掃除が最初に来ることが仕様である
//
// **1 行目が ResetScratch であることに意味がある。** 7.1 の「受け入れた劣化」3 点目は、
// `docker run --rm` が機構として与えていた使い捨てを、**この掃除で代替する**と定めた。
// AWS は「エラー後のリセットでも /tmp は消えない」と明文で書いているため、
// 前回が落ちた実行環境でも残骸はそのまま残っている。したがって掃除は、
// 入力の検査よりも前、**何を渡されたかを見るより前**に走らなければならない。
// 入力が壊れているときに早期に返す実装にすると、**壊れた入力を投げ続けるだけで
// 掃除を素通りさせられる。**
//
// 掃除に失敗したら、その場で止める（ResetScratch の注記）。
//
// 戻り値の error は**関数の障害**を表す。利用者のコードの問題は Result.OK=false で返す。
func (h *Handler) Handle(ctx context.Context, ev Event) (*Result, error) {
	started := time.Now()

	if err := ResetScratch(h.ScratchRoot); err != nil {
		return nil, err
	}
	resetDone := time.Now()

	res := &Result{GoVersion: runtime.Version()}
	fill := func(end time.Time) *Result {
		res.Timings.TotalMs = end.Sub(started).Milliseconds()
		return res
	}

	res.Timings.ResetMs = resetDone.Sub(started).Milliseconds()

	if ev.Source == "" {
		res.OK = false
		res.Stage = "request"
		res.Message = "source が空です。ビルドする Go ソースを渡してください。"
		return fill(time.Now()), nil
	}

	workDir, err := NewInvocationDir(h.ScratchRoot)
	if err != nil {
		return nil, err
	}

	if err := copyTree(h.TemplateDir, workDir); err != nil {
		return nil, fmt.Errorf("テンプレートを複製できません: %w", err)
	}
	// **生成コードはテンプレート側に焼き込まない。** /src に main.go を置くと、
	// 入力が空のときに「前回のテンプレートがビルドされて成功した」と読める状態を作る。
	if err := os.WriteFile(filepath.Join(workDir, "main.go"), []byte(ev.Source), 0o600); err != nil {
		return nil, fmt.Errorf("ソースを書き出せません: %w", err)
	}
	prepareDone := time.Now()
	res.Timings.PrepareMs = prepareDone.Sub(resetDone).Milliseconds()

	wasmPath := filepath.Join(workDir, "game.wasm")
	out, buildErr := h.compileFn()(ctx, workDir, wasmPath)
	buildDone := time.Now()
	res.Timings.BuildMs = buildDone.Sub(prepareDone).Milliseconds()

	if buildErr != nil {
		// **時間切れは利用者のコードの誤りではない。** ok=false で返すと、呼び出し側は
		// 「このコードはコンパイルできない」と読み、3.8 の degrade 判定
		// （ビルド依頼の失敗で発火する）が沈黙する。関数の障害として返す。
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ビルドが時間内に終わりませんでした（%d ms 経過。3.8 のタイムアウトは 10 秒）: %w",
				time.Since(started).Milliseconds(), ctx.Err())
		}
		res.OK = false
		res.Stage = "build"
		res.Message = trimDiagnostics(out, h.DiagnosticLimit)
		if res.Message == "" {
			res.Message = buildErr.Error()
		}
		return fill(time.Now()), nil
	}

	wasmBytes, wasmSum, err := digestFile(wasmPath)
	if err != nil {
		return nil, fmt.Errorf("成果物を読めません: %w", err)
	}
	if wasmBytes == 0 {
		// go build は 0 で終わったのに成果物が無い、という状態を成功として返さない。
		res.OK = false
		res.Stage = "build"
		res.Message = "成果物が生成されませんでした。"
		return fill(time.Now()), nil
	}
	res.Wasm = &Artifact{Bytes: wasmBytes, SHA256: wasmSum}

	brPath := wasmPath + ".br"
	if out, err := h.compressFn()(ctx, h.BrotliQuality, wasmPath, brPath); err != nil {
		// 圧縮の失敗は利用者のコードのせいではない。**関数の障害として返す。**
		return nil, fmt.Errorf("brotli 圧縮に失敗しました: %w: %s", err, trimDiagnostics(out, h.DiagnosticLimit))
	}
	compressDone := time.Now()
	res.Timings.CompressMs = compressDone.Sub(buildDone).Milliseconds()

	brBytes, brSum, err := digestFile(brPath)
	if err != nil {
		return nil, fmt.Errorf("圧縮後の成果物を読めません: %w", err)
	}
	raw, err := os.ReadFile(brPath)
	if err != nil {
		return nil, fmt.Errorf("圧縮後の成果物を読めません: %w", err)
	}

	res.Compressed = &Artifact{
		Bytes:  brBytes,
		SHA256: brSum,
		// 3.4-1 が R2 のオブジェクトメタデータへ求める値そのもの。**書き込み側
		// （putObject）も同じ定数を使う。** 綴りを 2 か所で選び直さない。
		ContentEncoding: wasmContentEncoding,
	}

	// 3.3-6: R2 へ書き戻す。
	//
	// **ここで失敗したら関数の障害として返す。** 利用者のコードは正しくビルドできて
	// いるので `ok=false` にはしない（#20 が診断の無い再生成を起こす）。**成果物が
	// R2 に無いまま 200 を返すこともしない**（呼び出し側は `games` 行を作り、
	// 404 を返す作品が生まれる）。
	if h.Upload != nil {
		uploadStarted := time.Now()
		stored, err := h.Upload(ctx, uploadRequest{
			Source:     []byte(ev.Source),
			Compressed: raw,
			GoVersion:  res.GoVersion,
		})
		res.Timings.UploadMs = time.Since(uploadStarted).Milliseconds()
		if err != nil {
			return nil, fmt.Errorf("成果物を R2 へ書き戻せませんでした: %w", err)
		}
		if stored == nil || stored.SourceKey == "" || stored.WasmKey == "" {
			// 書けたと言いながらキーが無い状態を通さない。呼び出し側は
			// このキーでしか `games` 行を作れない（3.3-8）。
			return nil, fmt.Errorf("R2 へ書いたキーを取得できませんでした")
		}
		res.Storage = stored
	} else {
		// **書かない構成でだけ本体を返す**（ローカルの封じ込め検査が申告と
		// 突き合わせるため。scripts/check-isolated-build.sh）。本番では返らない。
		res.Compressed.Data = base64.StdEncoding.EncodeToString(raw)
	}

	res.OK = true
	return fill(time.Now()), nil
}
