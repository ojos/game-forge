package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// **実 R2 も実 SSM も叩かない。** `httptest` のサーバへ宛先を差し替える
// （`r2Client` の `ssmEndpoint` / `r2Endpoint`）。実物を叩く検査は外部認証と課金を
// 受け入れ条件へ持ち込む（`src/bedrock.ts` / `src/build-client.ts` と同じ方針）。

// テスト用の資格情報。**実在の値ではない。**
const (
	testAccessKeyID = "test-access-key-id"
	testSecretKey   = "test-secret-access-key"
)

// withAWSEnv は SSM を呼ぶための環境変数を用意する。
//
// @param t テスト
func withAWSEnv(t *testing.T) {
	t.Helper()
	t.Setenv("AWS_ACCESS_KEY_ID", testAccessKeyID)
	t.Setenv("AWS_SECRET_ACCESS_KEY", testSecretKey)
	t.Setenv("AWS_SESSION_TOKEN", "test-session-token")
}

// newTestR2Client は httptest のサーバを向いたクライアントを作る。
//
// @param settings 構成
// @param ssm SSM の宛先
// @param r2 R2 の宛先
// @returns クライアント
func newTestR2Client(settings r2Settings, ssm, r2 string) *r2Client {
	client := newR2Client(settings)
	client.ssmEndpoint = func() string { return ssm }
	client.r2Endpoint = func(string) string { return r2 }
	return client
}

// 資格情報の JSON（`docs/build-function.md` の投入手順が書く形）。
const testCredentialsJSON = `{"accountId":"acc","accessKeyId":"r2-key","secretAccessKey":"r2-secret","bucket":"game-forge"}`

// SSM の応答を返すサーバ。要求の中身も記録する。
func ssmServer(t *testing.T, value string, status int) (*httptest.Server, *http.Request, *[]byte) {
	t.Helper()
	var captured http.Request
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read, _ := io.ReadAll(r.Body)
		body = read
		captured = *r
		if status != http.StatusOK {
			w.Header().Set("x-amzn-errortype", "ParameterNotFound:")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"__type":"ParameterNotFound"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Parameter": map[string]any{"Name": "/game-forge/prod/r2-credentials", "Type": "SecureString", "Value": value},
		})
	}))
	t.Cleanup(server.Close)
	return server, &captured, &body
}

func TestFetchCredentialsReadsTheSecureString(t *testing.T) {
	withAWSEnv(t)
	server, captured, body := ssmServer(t, testCredentialsJSON, http.StatusOK)
	client := newTestR2Client(r2Settings{parameterName: "/game-forge/prod/r2-credentials", region: "ap-northeast-1"}, server.URL, server.URL)

	cred, err := client.fetchCredentials(context.Background())
	if err != nil {
		t.Fatalf("fetchCredentials: %v", err)
	}
	if cred.Bucket != "game-forge" || cred.AccountID != "acc" || cred.AccessKeyID != "r2-key" {
		t.Fatalf("資格情報を読めていません: bucket=%q account=%q", cred.Bucket, cred.AccountID)
	}

	if got := captured.Header.Get("X-Amz-Target"); got != "AmazonSSM.GetParameter" {
		t.Fatalf("X-Amz-Target が %q です", got)
	}
	if !strings.HasPrefix(captured.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
		t.Fatalf("SigV4 で署名していません: %q", captured.Header.Get("Authorization"))
	}
	// **復号を要求していること。** 落とすと暗号文のまま返り、JSON として読めない。
	var request map[string]any
	if err := json.Unmarshal(*body, &request); err != nil {
		t.Fatalf("要求本文が JSON ではありません: %v", err)
	}
	if request["WithDecryption"] != true {
		t.Fatalf("WithDecryption を要求していません: %v", request)
	}
	if request["Name"] != "/game-forge/prod/r2-credentials" {
		t.Fatalf("パラメータ名が違います: %v", request["Name"])
	}
}

// **読めないときに黙って先へ進まない。**
func TestFetchCredentialsFailsWhenSSMRejects(t *testing.T) {
	withAWSEnv(t)
	server, _, _ := ssmServer(t, "", http.StatusBadRequest)
	client := newTestR2Client(r2Settings{parameterName: "/missing", region: "ap-northeast-1"}, server.URL, server.URL)

	_, err := client.fetchCredentials(context.Background())
	if err == nil {
		t.Fatal("SSM が 400 を返したのに成功しました")
	}
	if !strings.Contains(err.Error(), "ParameterNotFound") {
		t.Fatalf("種別が読めません: %v", err)
	}
}

// 項目が欠けた資格情報を「読めた」ことにしない。**名前だけを報告する。**
func TestFetchCredentialsRejectsIncompleteValue(t *testing.T) {
	withAWSEnv(t)
	server, _, _ := ssmServer(t, `{"accountId":"acc","accessKeyId":"r2-key"}`, http.StatusOK)
	client := newTestR2Client(r2Settings{parameterName: "/p", region: "ap-northeast-1"}, server.URL, server.URL)

	_, err := client.fetchCredentials(context.Background())
	if err == nil {
		t.Fatal("項目が欠けているのに成功しました")
	}
	for _, want := range []string{"secretAccessKey", "bucket"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("欠けている項目名が出ていません: %v", err)
		}
	}
	// **値は出さない。**
	if strings.Contains(err.Error(), "r2-key") {
		t.Fatalf("エラーへ値が漏れています: %v", err)
	}
}

// 実行環境に AWS の資格情報が無ければ、署名せずに落とす。
func TestFetchCredentialsFailsWithoutExecutionRoleCredentials(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	client := newTestR2Client(r2Settings{parameterName: "/p", region: "ap-northeast-1"}, "http://127.0.0.1:1", "http://127.0.0.1:1")

	if _, err := client.fetchCredentials(context.Background()); err == nil {
		t.Fatal("資格情報が無いのに SSM を呼びました")
	}
}

// 3.4-1: 書いたオブジェクトに **`Content-Type` と `Content-Encoding` の両方**が付く。
//
// **どちらか一方だけでは受け入れ条件を満たさない。** `Content-Type` を落とすと
// `instantiateStreaming` がストリーミング経路へ入らず、`Content-Encoding` を落とすと
// ブラウザが brotli を展開しない。
func TestUploadPutsBothHeadersOnTheWasmObject(t *testing.T) {
	withAWSEnv(t)

	type put struct {
		path            string
		contentType     string
		contentEncoding string
		body            string
		payloadHash     string
		authorization   string
	}
	var puts []put

	r2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		puts = append(puts, put{
			path:            r.URL.Path,
			contentType:     r.Header.Get("Content-Type"),
			contentEncoding: r.Header.Get("Content-Encoding"),
			body:            string(body),
			payloadHash:     r.Header.Get("X-Amz-Content-Sha256"),
			authorization:   r.Header.Get("Authorization"),
		})
		if r.Method != http.MethodPut {
			t.Errorf("PUT ではありません: %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(r2.Close)

	ssm, _, _ := ssmServer(t, testCredentialsJSON, http.StatusOK)
	client := newTestR2Client(r2Settings{parameterName: "/p", region: "ap-northeast-1"}, ssm.URL, r2.URL)

	stored, err := client.upload(context.Background(), uploadRequest{
		Source:     []byte("package main\n"),
		Compressed: []byte("brotli-bytes"),
		GoVersion:  "go1.26.5",
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}

	if len(puts) != 2 {
		t.Fatalf("PUT が 2 本ではありません: %d", len(puts))
	}
	// 順序: source.go → .wasm.br（途中で落ちたときに残るのは 5.3 が要る側）。
	if !strings.HasSuffix(puts[0].path, "/source.go") {
		t.Fatalf("1 本目が source.go ではありません: %s", puts[0].path)
	}
	if puts[0].contentEncoding != "" {
		t.Fatalf("source.go に Content-Encoding が付いています: %q", puts[0].contentEncoding)
	}
	if puts[0].body != "package main\n" {
		t.Fatalf("source.go の中身が違います: %q", puts[0].body)
	}

	wasm := puts[1]
	if wasm.contentType != "application/wasm" {
		t.Fatalf("Content-Type が application/wasm ではありません: %q", wasm.contentType)
	}
	if wasm.contentEncoding != "br" {
		t.Fatalf("Content-Encoding が br ではありません: %q", wasm.contentEncoding)
	}
	if wasm.body != "brotli-bytes" {
		t.Fatalf(".wasm.br の中身が違います: %q", wasm.body)
	}
	if wasm.payloadHash != hashHex([]byte("brotli-bytes")) {
		t.Fatalf("本文ハッシュのヘッダが一致しません: %q", wasm.payloadHash)
	}
	// **3.4-1 のメタデータは署名対象に入る**（経路上で書き換えられない）。
	if !strings.Contains(wasm.authorization, "content-encoding") ||
		!strings.Contains(wasm.authorization, "content-type") {
		t.Fatalf("Content-Type / Content-Encoding が署名対象に入っていません: %s", wasm.authorization)
	}
	// R2 の署名スコープは region=auto / service=s3。
	if !strings.Contains(wasm.authorization, "/auto/s3/aws4_request") {
		t.Fatalf("署名スコープが auto/s3 ではありません: %s", wasm.authorization)
	}

	// キーはバケット名の下に現れる（`/<bucket>/<key>`）。
	if !strings.HasPrefix(wasm.path, "/game-forge/builds/") {
		t.Fatalf("バケットとキーの綴りが違います: %s", wasm.path)
	}
	if stored.WasmKey == "" || !strings.HasSuffix(wasm.path, stored.WasmKey) {
		t.Fatalf("返したキーと書いた先が食い違います: %q / %q", stored.WasmKey, wasm.path)
	}
}

// R2 が失敗を返したら、書けたことにしない。
func TestUploadFailsWhenR2Rejects(t *testing.T) {
	withAWSEnv(t)
	r2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("<Error><Code>AccessDenied</Code></Error>"))
	}))
	t.Cleanup(r2.Close)
	ssm, _, _ := ssmServer(t, testCredentialsJSON, http.StatusOK)
	client := newTestR2Client(r2Settings{parameterName: "/p", region: "ap-northeast-1"}, ssm.URL, r2.URL)

	_, err := client.upload(context.Background(), uploadRequest{
		Source: []byte("x"), Compressed: []byte("y"), GoVersion: "go1.26.5",
	})
	if err == nil {
		t.Fatal("R2 が 403 を返したのに成功しました")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("状態コードが残っていません: %v", err)
	}
	// **応答本文をそのまま連ねない。**
	if strings.Contains(err.Error(), "<Error>") {
		t.Fatalf("応答本文がエラーへ混ざっています: %v", err)
	}
}

// 確定26: キーは**内容だけ**から決まる（作品 id を含まない）。
//
// 含めると、キャッシュヒット時（関数を呼ばない）に同じキーを作れず、
// 「作品をまたいだ共有」が壊れる。
func TestArtifactKeysAreContentAddressed(t *testing.T) {
	source := []byte("package main\n\nfunc main() {}\n")
	first := artifactKeys(source, "go1.26.5")
	second := artifactKeys(source, "go1.26.5")
	if first != second {
		t.Fatalf("同じソースで違うキーになりました: %+v / %+v", first, second)
	}

	// 鍵は `src/build-cache.ts` の `sourceCacheKey`（UTF-8 の SHA-256）と同じ値である。
	digest := hashHex(source)
	if first.SourceKey != "builds/"+digest+"/source.go" {
		t.Fatalf("source.go のキーが違います: %s", first.SourceKey)
	}
	if first.WasmKey != "builds/"+digest+"/go1.26.5/game.wasm.br" {
		t.Fatalf(".wasm.br のキーが違います: %s", first.WasmKey)
	}

	other := artifactKeys([]byte("package main\n"), "go1.26.5")
	if other.SourceKey == first.SourceKey || other.WasmKey == first.WasmKey {
		t.Fatal("違うソースが同じキーになりました")
	}
}

// 3.5: Go の版が変われば `.wasm.br` のキーも変わる。
//
// **同じにすると、Go を更新したあとの再ビルドが、既存の作品が指しているオブジェクトを
// 別の版の中身で上書きする**（その作品の `go_version` は古いままなので、版の合わない
// `wasm_exec.js` で配信され、黙って壊れる）。`source.go` は版に依存しない。
func TestArtifactKeysSeparateGoVersionsForWasmOnly(t *testing.T) {
	source := []byte("package main\n")
	old := artifactKeys(source, "go1.26.5")
	next := artifactKeys(source, "go1.27.0")

	if old.WasmKey == next.WasmKey {
		t.Fatalf("Go の版が違うのに .wasm.br のキーが同じです: %s", old.WasmKey)
	}
	if old.SourceKey != next.SourceKey {
		t.Fatalf("source.go のキーが版で分かれています: %s / %s", old.SourceKey, next.SourceKey)
	}
}

// 開発版のツールチェイン（`devel go1.27-abc123`）でもキーが壊れない。
func TestSanitizeKeySegment(t *testing.T) {
	if got := sanitizeKeySegment("devel go1.27-abc123 cl/1"); strings.ContainsAny(got, " /") {
		t.Fatalf("キーに使えない文字が残っています: %q", got)
	}
	if got := sanitizeKeySegment("///"); got != "unknown" {
		t.Fatalf("空になる値が unknown へ落ちていません: %q", got)
	}
	if got := sanitizeKeySegment("go1.26.5"); got != "go1.26.5" {
		t.Fatalf("通常の版が変わっています: %q", got)
	}
}

// 構成の読み取り。**未設定を「書かない」と読み替えない**（3.3-6）。
func TestR2SettingsFromEnv(t *testing.T) {
	t.Run("宣言があれば書く", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "/game-forge/prod/r2-credentials")
		t.Setenv("R2_UPLOAD", "")
		t.Setenv("AWS_REGION", "ap-northeast-1")
		settings, err := r2SettingsFromEnv()
		if err != nil {
			t.Fatalf("r2SettingsFromEnv: %v", err)
		}
		if settings == nil || settings.parameterName != "/game-forge/prod/r2-credentials" {
			t.Fatalf("構成を読めていません: %+v", settings)
		}
		if settings.region != "ap-northeast-1" {
			t.Fatalf("リージョンを読めていません: %q", settings.region)
		}
	})

	t.Run("未設定は失敗する", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "")
		t.Setenv("R2_UPLOAD", "")
		if _, err := r2SettingsFromEnv(); err == nil {
			t.Fatal("未設定が「書かない」として通りました（黙って成功する経路）")
		}
	})

	t.Run("明示した skip だけが書かない", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "")
		t.Setenv("R2_UPLOAD", "skip")
		settings, err := r2SettingsFromEnv()
		if err != nil {
			t.Fatalf("r2SettingsFromEnv: %v", err)
		}
		if settings != nil {
			t.Fatalf("skip なのに構成が返りました: %+v", settings)
		}
	})

	t.Run("両方の指定は失敗する", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "/p")
		t.Setenv("R2_UPLOAD", "skip")
		t.Setenv("AWS_REGION", "ap-northeast-1")
		if _, err := r2SettingsFromEnv(); err == nil {
			t.Fatal("矛盾した構成が通りました")
		}
	})

	t.Run("知らない値は失敗する", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "")
		t.Setenv("R2_UPLOAD", "yes")
		if _, err := r2SettingsFromEnv(); err == nil {
			t.Fatal("知らない値が通りました")
		}
	})

	t.Run("リージョンが無ければ失敗する", func(t *testing.T) {
		t.Setenv("R2_CREDENTIALS_PARAMETER", "/p")
		t.Setenv("R2_UPLOAD", "")
		t.Setenv("AWS_REGION", "")
		t.Setenv("AWS_DEFAULT_REGION", "")
		if _, err := r2SettingsFromEnv(); err == nil {
			t.Fatal("リージョン無しで署名しに行こうとしました")
		}
	})
}

// 7.1 / 3.3-6: **生成コードをコンパイルする子プロセスへ資格情報を渡さない。**
func TestEnvironWithoutCredentials(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", testAccessKeyID)
	t.Setenv("AWS_SECRET_ACCESS_KEY", testSecretKey)
	t.Setenv("AWS_SESSION_TOKEN", "test-session-token")
	t.Setenv("R2_CREDENTIALS_PARAMETER", "/game-forge/prod/r2-credentials")
	t.Setenv("AWS_LAMBDA_FUNCTION_NAME", "game-forge-build")
	t.Setenv("GOTOOLCHAIN", "local")

	joined := strings.Join(environWithoutCredentials(), "\n")
	for _, blocked := range []string{
		"AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=", "AWS_SESSION_TOKEN=", "R2_CREDENTIALS_PARAMETER=",
	} {
		if strings.Contains(joined, blocked) {
			t.Fatalf("子プロセスへ %s を渡しています", blocked)
		}
	}
	// **落とすのは資格情報だけである。** 実行環境の識別やツールチェインの固定まで
	// 落とすと、ビルドそのものが本番と違う条件で走る。
	for _, kept := range []string{"AWS_LAMBDA_FUNCTION_NAME=game-forge-build", "GOTOOLCHAIN=local"} {
		if !strings.Contains(joined, kept) {
			t.Fatalf("落としてはいけない %s が消えています", kept)
		}
	}
}
