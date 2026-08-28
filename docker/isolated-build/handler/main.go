// build-handler — ビルド関数（確定24 / 3.8）の入口。
//
// # 2 つの動作モード
//
// | モード | 入口 | 使う場所 |
// |---|---|---|
// | Lambda | Lambda Runtime API のループ | **本番**（AWS_LAMBDA_RUNTIME_API があるとき） |
// | oneshot | 1 回だけ処理して終わる | scripts/check-isolated-build.sh・手元の確認 |
//
// **ハンドラの本体（handler.go）はどちらでも同じである。** 検査が本番と違うコードを
// 通ると、検査が緑でも本番が壊れている状態を作れてしまう。分岐は入出力の運び方だけに
// 留める。
//
// # oneshot が標準入出力で成果物を運ばない理由（実測）
//
// v1.11 までの docker/isolated-build/entrypoint.sh は「標準入力＝ソース /
// 標準出力＝base64」の契約だった。**この経路は devcontainer 上で確定で壊れる。**
// 標準入力を EOF まで読んだあと 2 秒でも走り続けると、**標準出力も標準エラーも
// まるごと失われ、終了コードだけが 0 で返る**（docker 28.5.1 / docker-outside-of-docker。
// 2026-08-27 実測。`sh -c 'cat >/dev/null; sleep 2; echo hello'` で再現する）。
// 旧 entrypoint.sh の注記が「無音で落ちる」と書いていたのはこれで、
// **暖機では回避できない。**
//
// したがって oneshot は、入力を**ファイルか環境変数**で受け、結果を**ファイル**へ書く。
// 呼び出し側は書かれたファイルを取り出す（docker cp）。標準出力は診断だけに使う。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// runtimeAPIVersion は Lambda Runtime API のパス接頭辞。
	runtimeAPIVersion = "2018-06-01"

	// deadlineMargin は Lambda の deadline より手前で自分の処理を打ち切る余裕。
	//
	// **プラットフォームに殺されると応答を返せない。** 呼び出し側からは無言の
	// タイムアウトになり、どの段で時間切れになったかが残らない。手前で切って
	// Timings 付きのエラーを返すほうが、3.8 の 10 秒が妥当かを判断できる。
	deadlineMargin = 500 * time.Millisecond
)

func main() {
	log.SetFlags(0)

	var (
		oneshot   = flag.Bool("oneshot", false, "1 回だけ処理して終了する（検査・手元の確認用）")
		eventFile = flag.String("event-file", "", "oneshot: イベント JSON のパス（省略時は環境変数 EVENT_JSON）")
		outFile   = flag.String("out-file", "", "oneshot: 結果 JSON の書き出し先")
	)
	flag.Parse()

	scratchRoot := envOr("BUILD_SCRATCH_ROOT", DefaultScratchRoot)
	templateDir := envOr("BUILD_TEMPLATE_DIR", "/src")

	quality, err := brotliQualityFromEnv()
	if err != nil {
		fail(*oneshot, err)
		return
	}

	// 3.3-6 の書き戻し先。**未設定は「書かない」ではなく構成の誤りである**
	// （r2SettingsFromEnv の注記）。BROTLI_QUALITY と同じく、宣言に無い状態で
	// 動き出さない。
	r2, err := r2SettingsFromEnv()
	if err != nil {
		fail(*oneshot, err)
		return
	}

	// **nil のまま渡すのは「書かない」を明示したときだけ**である。
	var upload func(context.Context, uploadRequest) (*StoredArtifacts, error)
	if r2 != nil {
		upload = newR2Client(*r2).upload
	}

	h := NewHandler(scratchRoot, templateDir, quality, upload)

	if *oneshot || os.Getenv("AWS_LAMBDA_RUNTIME_API") == "" {
		if err := runOneshot(h, *eventFile, *outFile); err != nil {
			log.Fatalf("[build] %v", err)
		}
		return
	}

	runLambda(h)
}

// brotliQualityFromEnv は圧縮品質を環境変数から読む。
//
// **既定値を持たない。** 未設定を「11 だろう」と補うと、宣言（Terraform）を見ずに
// 品質が決まる経路ができる。3.8 の 10 秒に収まるかは品質で決まるので、
// **宣言に無い状態で動き出さないほうが安全**である。
func brotliQualityFromEnv() (int, error) {
	raw := strings.TrimSpace(os.Getenv("BROTLI_QUALITY"))
	if raw == "" {
		return 0, errors.New("BROTLI_QUALITY が設定されていません（terraform/build-function.tf が宣言します）")
	}
	q, err := strconv.Atoi(raw)
	if err != nil || q < 0 || q > 11 {
		return 0, fmt.Errorf("BROTLI_QUALITY の値が不正です: %q（0〜11）", raw)
	}
	return q, nil
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// fail は初期化の失敗を、モードに応じた形で報告して終わる。
func fail(oneshot bool, err error) {
	if !oneshot && os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		// Lambda は初期化エラー専用の経路を持つ。ここへ出さないと、実行環境が
		// 起動しなかった理由が呼び出し側にもログにも残らない。
		postInitError(err)
	}
	log.Fatalf("[build] %v", err)
}

// ── oneshot ─────────────────────────────────────────────────────────────────

func runOneshot(h *Handler, eventFile, outFile string) error {
	raw, err := readEvent(eventFile)
	if err != nil {
		return err
	}

	var ev Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		return fmt.Errorf("イベントを JSON として読めません: %w", err)
	}

	res, err := h.Handle(context.Background(), ev)
	if err != nil {
		return err
	}

	encoded, err := json.Marshal(res)
	if err != nil {
		return err
	}
	if outFile == "" {
		return errors.New("--out-file を指定してください（標準出力では成果物を運ばない。冒頭の注記）")
	}
	if err := os.WriteFile(outFile, encoded, 0o600); err != nil {
		return fmt.Errorf("結果を書き出せません: %w", err)
	}

	// 診断だけを標準出力へ出す。**成果物は載せない。**
	logResult(res)
	return nil
}

// readEvent は oneshot の入力を、ファイル → 環境変数 → 標準入力の順に探す。
//
// 環境変数を受けるのは、検査側が docker へファイルを渡す手段を持たないためである
// （本番の /tmp は tmpfs で、起動前に置いたものはマウントに隠れる）。
func readEvent(eventFile string) ([]byte, error) {
	if eventFile != "" {
		return os.ReadFile(eventFile)
	}
	if v := os.Getenv("EVENT_JSON"); v != "" {
		return []byte(v), nil
	}
	return io.ReadAll(os.Stdin)
}

// logResult は結果の要約を出す。
//
// **生成されたソースも成果物も出さない。** ログは CloudWatch へ渡り、保持期間の
// あいだ残る。攻撃者が制御しうる入力（7.1）をそこへ複製する理由が無い。
//
// **R2 のキーは出す。** キーは生成ソースのハッシュから決まる公開可能な綴りで
// （`artifactKeys`）、資格情報でもソースでもない。**書けたかどうかを後から確かめる
// 唯一の手掛かり**なので、ここに残す。
func logResult(res *Result) {
	if res.OK {
		stored := "skip"
		if res.Storage != nil {
			stored = res.Storage.WasmKey
		}
		log.Printf("[build] ok wasm=%dB/%s br=%dB/%s r2=%s reset=%dms build=%dms compress=%dms upload=%dms total=%dms",
			res.Wasm.Bytes, res.Wasm.SHA256[:12], res.Compressed.Bytes, res.Compressed.SHA256[:12], stored,
			res.Timings.ResetMs, res.Timings.BuildMs, res.Timings.CompressMs, res.Timings.UploadMs,
			res.Timings.TotalMs)
		return
	}
	log.Printf("[build] ng stage=%s total=%dms", res.Stage, res.Timings.TotalMs)
}

// ── Lambda Runtime API ──────────────────────────────────────────────────────

// runLambda は Runtime API のループを回す。
//
// **戻らない。** 呼び出しを 1 件処理するごとに次を取りに行く。実行環境の停止は
// プラットフォームが行う。
func runLambda(h *Handler) {
	api := os.Getenv("AWS_LAMBDA_RUNTIME_API")
	// next は long poll である。**クライアントにタイムアウトを設けない。**
	// 設けると、呼び出しの無い時間が続いただけで実行環境が落ちる。
	client := &http.Client{}

	for {
		req, reqID, deadline, err := nextInvocation(client, api)
		if err != nil {
			// next 自体が取れないのは実行環境側の異常である。ループを回し続けると
			// 同じ失敗を秒間何千回も繰り返すので、少し待ってから再試行する。
			log.Printf("[build] 次の呼び出しを取得できません: %v", err)
			time.Sleep(200 * time.Millisecond)
			continue
		}

		res, handleErr := handleWithDeadline(h, req, deadline)
		if handleErr != nil {
			log.Printf("[build] 呼び出し %s が失敗しました: %v", reqID, handleErr)
			postInvocationError(client, api, reqID, handleErr)
			continue
		}
		logResult(res)
		if err := postResponse(client, api, reqID, res); err != nil {
			log.Printf("[build] 応答を返せません (%s): %v", reqID, err)
		}
	}
}

func handleWithDeadline(h *Handler, ev Event, deadline time.Time) (*Result, error) {
	ctx := context.Background()
	if !deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline.Add(-deadlineMargin))
		defer cancel()
	}
	return h.Handle(ctx, ev)
}

func nextInvocation(client *http.Client, api string) (Event, string, time.Time, error) {
	var ev Event

	resp, err := client.Get(fmt.Sprintf("http://%s/%s/runtime/invocation/next", api, runtimeAPIVersion))
	if err != nil {
		return ev, "", time.Time{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ev, "", time.Time{}, err
	}

	reqID := resp.Header.Get("Lambda-Runtime-Aws-Request-Id")
	// X-Ray の伝播。AWS SDK も自前の計測もこの環境変数を見る。
	if traceID := resp.Header.Get("Lambda-Runtime-Trace-Id"); traceID != "" {
		_ = os.Setenv("_X_AMZN_TRACE_ID", traceID)
	}

	var deadline time.Time
	if ms, err := strconv.ParseInt(resp.Header.Get("Lambda-Runtime-Deadline-Ms"), 10, 64); err == nil && ms > 0 {
		deadline = time.UnixMilli(ms)
	}

	if err := json.Unmarshal(body, &ev); err != nil {
		return ev, reqID, deadline, fmt.Errorf("イベントを JSON として読めません: %w", err)
	}
	return ev, reqID, deadline, nil
}

func postResponse(client *http.Client, api, reqID string, res *Result) error {
	encoded, err := json.Marshal(res)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://%s/%s/runtime/invocation/%s/response", api, runtimeAPIVersion, reqID)
	return postJSON(client, url, encoded)
}

func postInvocationError(client *http.Client, api, reqID string, cause error) {
	url := fmt.Sprintf("http://%s/%s/runtime/invocation/%s/error", api, runtimeAPIVersion, reqID)
	if err := postJSON(client, url, errorPayload(cause)); err != nil {
		log.Printf("[build] エラーを報告できません (%s): %v", reqID, err)
	}
}

func postInitError(cause error) {
	api := os.Getenv("AWS_LAMBDA_RUNTIME_API")
	if api == "" {
		return
	}
	url := fmt.Sprintf("http://%s/%s/runtime/init/error", api, runtimeAPIVersion)
	_ = postJSON(&http.Client{Timeout: 5 * time.Second}, url, errorPayload(cause))
}

func errorPayload(cause error) []byte {
	payload, err := json.Marshal(map[string]string{
		"errorMessage": cause.Error(),
		"errorType":    "BuildFunctionError",
	})
	if err != nil {
		return []byte(`{"errorMessage":"内部エラー","errorType":"BuildFunctionError"}`)
	}
	return payload
}

func postJSON(client *http.Client, url string, body []byte) error {
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Runtime API が %s を返しました", resp.Status)
	}
	return nil
}
