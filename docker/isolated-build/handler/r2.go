package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// R2 への書き戻し（3.3-6 / 3.4-1 / 確定26）。
//
// # 認証情報はこの関数だけが持つ
//
// 3.3 は「**R2 の認証情報はビルド側のみが保持する。ブラウザにも Workers にも渡さない**」
// と定める。実体は SSM Parameter Store の SecureString で、**関数へ渡るのはパラメータ名
// だけ**である（`terraform/build-function.tf` の `R2_CREDENTIALS_PARAMETER`。値を宣言
// しない理由は 3.8 と `docs/build-function.md`）。
//
// **読んだ値をログへ出さない。** ここのエラーはすべて「何が起きたか」だけを持ち、
// 応答本文もパラメータの中身も含めない。CloudWatch は 14 日残る。
//
// # 生成コードをコンパイルする子プロセスへ渡さない
//
// 読んだ資格情報は**この関数のメモリの中だけ**にある。環境変数へ置かない
// （`build.go` の compileWasm は `os.Environ()` を子へ渡す）。7.1 の受け入れ条件
// 「認証情報がコンテナへ渡らない」は、この 2 つ（環境へ置かない / 子の環境から
// AWS_ を落とす）で成立している。
//
// # 読むのは呼び出しのたびである
//
// **初期化時に読んで使い回さない。** `docs/build-function.md` は「ローテーションに
// 関数の再配備は要らない（読むのは実行時）」と書いており、初期化で固めるとその
// 前提が崩れる。費用と時間の面でも、ビルド 1 回が約 21 秒（3.8）に対して SSM の
// 1 往復は無視できる。

// r2Credentials は SSM の SecureString に入っている JSON（`docs/build-function.md`）。
//
// **ログへ出さない。** 型そのものが機密である。
type r2Credentials struct {
	AccountID       string `json:"accountId"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	Bucket          string `json:"bucket"`
}

// missingFields は欠けている項目の**名前だけ**を返す。
//
// **値は返さない。** 投入し直すのに要るのは名前で、値ではない。
//
// @returns 欠けている項目名（揃っていれば空）
func (c r2Credentials) missingFields() []string {
	var missing []string
	for _, field := range []struct {
		name  string
		value string
	}{
		{"accountId", c.AccountID},
		{"accessKeyId", c.AccessKeyID},
		{"secretAccessKey", c.SecretAccessKey},
		{"bucket", c.Bucket},
	} {
		if strings.TrimSpace(field.value) == "" {
			missing = append(missing, field.name)
		}
	}
	return missing
}

// StoredArtifacts は R2 へ書いたオブジェクトのキー（3.3-7 が呼び出し側へ返す）。
//
// **`games` 行（3.3-8）とビルド結果キャッシュの索引（3.8）は、この 2 本をそのまま
// 写す。** 呼び出し側がキーを組み立て直す経路を作らない（綴りが 2 か所に分かれる）。
type StoredArtifacts struct {
	SourceKey string `json:"sourceKey"`
	WasmKey   string `json:"wasmKey"`
}

// uploadRequest は 1 回の書き戻しで R2 へ置くもの。
type uploadRequest struct {
	// Source は生成された Go ソース（`source.go` として置く。5.3 がフォークに要求する）。
	Source []byte
	// Compressed は brotli 圧縮済みの wasm（`.wasm.br`）。
	Compressed []byte
	// GoVersion はビルドに使った Go の版（3.5）。**`.wasm.br` のキーに入る**（下記）。
	GoVersion string
}

// r2Settings は「どこへ資格情報を取りに行くか」。**値そのものは持たない。**
type r2Settings struct {
	// parameterName は SSM のパラメータ名（環境変数 R2_CREDENTIALS_PARAMETER）。
	parameterName string
	// region は SSM を呼ぶリージョン（Lambda が与える AWS_REGION）。
	region string
}

// r2UploadSkipValue は「この実行では R2 へ書かない」ことを明示する値。
//
// **既定ではない。** 未設定は「書かない」ではなく**構成の誤り**として扱う（下記）。
const r2UploadSkipValue = "skip"

// r2SettingsFromEnv は書き戻しの構成を環境変数から読む。
//
// # 未設定を「書かない」と読み替えない
//
// **`R2_CREDENTIALS_PARAMETER` が無いときに黙って成果物を返して成功にしない。**
// そうすると、宣言（`terraform/build-function.tf`）から環境変数が落ちた日に、
// 関数は 200 を返し続けたまま R2 には何も入らない。呼び出し側は `games` 行を作れず、
// **どこが壊れたのかは「キーが返らない」という消極的な症状でしか現れない。**
// `BROTLI_QUALITY` が既定値を持たないのと同じ理由である（main.go）。
//
// # それでもローカルの検査は R2 へ書けない
//
// `scripts/check-isolated-build.sh` は `--network=none` で動かすため、SSM にも R2 にも
// 到達できない。**そこで「書かない」を明示的に宣言させる**（`R2_UPLOAD=skip`）。
// 明示なので、宣言から環境変数が落ちた事故とは区別が付く。
//
// **両方を同時に指定したら失敗させる。** どちらが勝つかを暗黙の優先順位で決めると、
// 本番へ `R2_UPLOAD=skip` が紛れ込んだときに「書かないほうが勝つ」経路ができる。
//
// @returns 書き戻しの構成（書かない場合は nil）と、構成が矛盾していればエラー
func r2SettingsFromEnv() (*r2Settings, error) {
	parameter := strings.TrimSpace(os.Getenv("R2_CREDENTIALS_PARAMETER"))
	skip := strings.TrimSpace(os.Getenv("R2_UPLOAD"))

	switch {
	case parameter != "" && skip == "":
		region := strings.TrimSpace(os.Getenv("AWS_REGION"))
		if region == "" {
			region = strings.TrimSpace(os.Getenv("AWS_DEFAULT_REGION"))
		}
		if region == "" {
			return nil, errors.New("AWS_REGION が設定されていません（SSM を呼ぶリージョンが決まりません）")
		}
		return &r2Settings{parameterName: parameter, region: region}, nil
	case parameter == "" && skip == r2UploadSkipValue:
		return nil, nil
	case parameter == "" && skip == "":
		return nil, errors.New(
			"R2_CREDENTIALS_PARAMETER が設定されていません（terraform/build-function.tf が宣言します）。" +
				"R2 へ書かずに動かすなら R2_UPLOAD=skip を明示してください")
	case parameter != "" && skip != "":
		return nil, fmt.Errorf(
			"R2_CREDENTIALS_PARAMETER と R2_UPLOAD=%s の両方が指定されています（どちらか一方にしてください）", skip)
	default:
		return nil, fmt.Errorf("R2_UPLOAD の値が不正です: %q（%q だけを受け付けます）", skip, r2UploadSkipValue)
	}
}

// r2Client は SSM から資格情報を読み、R2 へ書く。
//
// **`http.Client` を外から差し替えられる。** テストは `httptest` のサーバを向ける。
// 実 R2 を叩くテストを書くと、受け入れ条件に課金と外部認証が混ざる
// （`src/bedrock.ts` と `src/build-client.ts` が採った継ぎ目と同じ考え方）。
type r2Client struct {
	settings r2Settings
	http     *http.Client
	// endpoints はテストが宛先を差し替えるための関数。nil なら本番の綴りを使う。
	ssmEndpoint func() string
	r2Endpoint  func(accountID string) string
	// now は署名時刻。nil なら time.Now。
	now func() time.Time
}

// r2HTTPTimeout は 1 往復の上限。
//
// **関数のタイムアウト（30 秒）より短くする。** ここで待ち続けると、打ち切るのは
// プラットフォームになり、`timings` も理由も残らない（main.go の deadlineMargin と
// 同じ考え方）。ビルドが終わったあとの残り時間で SSM 1 往復と PUT 2 本を行う。
const r2HTTPTimeout = 15 * time.Second

// newR2Client は本番の設定でクライアントを作る。
//
// @param settings 書き戻しの構成
// @returns クライアント
func newR2Client(settings r2Settings) *r2Client {
	return &r2Client{settings: settings, http: &http.Client{Timeout: r2HTTPTimeout}}
}

// timeNow は署名時刻を返す。
//
// @returns 現在時刻
func (c *r2Client) timeNow() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// upload は成果物 2 つを R2 へ書き、書いたキーを返す（3.3-6）。
//
// # 書く順序は `source.go` → `.wasm.br`
//
// 途中で落ちたときに残るのは `source.go` だけになる。**逆順にすると `.wasm.br` だけが
// 残る。** ビルド結果キャッシュのヒット判定は 2 つとも実在することを求めるので
// （`src/build-cache.ts`）、どちらの順でも索引は作られないが、**5.3 が永続を求めて
// いるのは `source.go` のほう**である。残るなら意味のあるほうを残す。
//
// @param ctx コンテキスト
// @param req 置くもの
// @returns 書いたキー
func (c *r2Client) upload(ctx context.Context, req uploadRequest) (*StoredArtifacts, error) {
	keys := artifactKeys(req.Source, req.GoVersion)

	// **ビルドが終わってから取りに行く。** ビルドが失敗する呼び出しでは資格情報を
	// 読まない（読む必要がないうえ、攻撃者由来のコードをコンパイルしているあいだ
	// 資格情報がメモリに載っている時間を短くできる）。
	cred, err := c.fetchCredentials(ctx)
	if err != nil {
		return nil, err
	}

	// 3.4-1 が R2 のオブジェクトメタデータへ求めるのは `.wasm.br` の 2 ヘッダである。
	// `source.go` は配信物ではなく、5.3 のフォークが読む永続物なので圧縮しない。
	if err := c.putObject(ctx, cred, keys.SourceKey, "text/plain; charset=utf-8", "", req.Source); err != nil {
		return nil, err
	}
	if err := c.putObject(ctx, cred, keys.WasmKey, wasmContentType, wasmContentEncoding, req.Compressed); err != nil {
		return nil, err
	}
	return &keys, nil
}

const (
	// wasmContentType は 3.4-2 が**必須**とする値。`instantiateStreaming` は MIME type を
	// 検証し、一致しなければストリーミング経路に入らない。
	wasmContentType = "application/wasm"
	// wasmContentEncoding は 3.4-1 が求める値。**Result の Artifact も同じ綴りを返す**
	// （handler.go）。片方だけ変えると、索引と実物がずれる。
	wasmContentEncoding = "br"
)

// fetchCredentials は SSM の SecureString を読む（`ssm:GetParameter` / `WithDecryption`）。
//
// **署名鍵は Lambda の実行ロールが環境変数へ置く一時資格情報である。** 実行ロールに
// このパラメータ 1 つ分の `ssm:GetParameter` と、その KMS 鍵の `kms:Decrypt` だけが
// 付いている（`terraform/build-function.tf`）。
//
// @param ctx コンテキスト
// @returns 資格情報
func (c *r2Client) fetchCredentials(ctx context.Context) (r2Credentials, error) {
	var cred r2Credentials

	signer := awsCredentials{
		AccessKeyID:     os.Getenv("AWS_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
		SessionToken:    os.Getenv("AWS_SESSION_TOKEN"),
	}
	if !signer.valid() {
		// **403 を待たずにここで落とす。** 実行ロールの資格情報が環境に無い状態は
		// 「権限が足りない」ではなく「実行環境が想定と違う」である。
		return cred, errors.New("実行環境に AWS の資格情報がありません（SSM を呼べません）")
	}

	body, err := json.Marshal(map[string]any{
		"Name":           c.settings.parameterName,
		"WithDecryption": true,
	})
	if err != nil {
		return cred, fmt.Errorf("SSM への要求を組み立てられません: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ssmURL(), bytes.NewReader(body))
	if err != nil {
		return cred, fmt.Errorf("SSM への要求を組み立てられません: %w", err)
	}
	// JSON プロトコル（AWS JSON 1.1）。**操作名はヘッダで渡す。**
	request.Header.Set("Content-Type", "application/x-amz-json-1.1")
	request.Header.Set("X-Amz-Target", "AmazonSSM.GetParameter")

	if err := signRequest(request, signer, c.settings.region, "ssm", hashHex(body), c.timeNow()); err != nil {
		return cred, err
	}

	response, err := c.httpClient().Do(request)
	if err != nil {
		// **エラーの本文を包まない。** URL には何も秘密が無いが、ここは資格情報を
		// 扱う経路なので、外から来た文字列をそのまま連ねない方針で通す。
		return cred, fmt.Errorf("SSM を呼べませんでした: %s", describeTransportError(err))
	}
	defer response.Body.Close()

	if response.StatusCode/100 != 2 {
		// **本文を読まない。** 種別はヘッダから取れる（`src/build-client.ts` と同じ方針）。
		errorType := response.Header.Get("x-amzn-errortype")
		if errorType == "" {
			errorType = "種別不明"
		}
		return cred, fmt.Errorf("SSM が %s を返しました（%s。パラメータ名と実行ロールの権限を確認してください）",
			response.Status, strings.SplitN(errorType, ":", 2)[0])
	}

	// **応答の大きさに上限を置く。** 資格情報の JSON は 1 KB 未満である。
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return cred, fmt.Errorf("SSM の応答を読めませんでした: %s", describeTransportError(err))
	}

	var envelope struct {
		Parameter struct {
			Value string `json:"Value"`
			Type  string `json:"Type"`
		} `json:"Parameter"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		// **本文を出さない。** 復号済みの値が入っている応答である。
		return cred, errors.New("SSM の応答を JSON として読めませんでした")
	}
	if envelope.Parameter.Value == "" {
		return cred, errors.New("SSM のパラメータに値がありません")
	}
	if err := json.Unmarshal([]byte(envelope.Parameter.Value), &cred); err != nil {
		// **値そのものを出さない。** 綴りの誤りは投入手順（docs/build-function.md）で直す。
		return cred, errors.New("R2 の資格情報を JSON として読めませんでした（docs/build-function.md の投入手順を確認してください）")
	}
	if missing := cred.missingFields(); len(missing) > 0 {
		return r2Credentials{}, fmt.Errorf("R2 の資格情報に項目が足りません: %s", strings.Join(missing, ", "))
	}
	return cred, nil
}

// putObject は S3 互換 API でオブジェクトを 1 つ置く。
//
// **`Content-Type` と `Content-Encoding` は署名対象に入る**（signRequest は送るヘッダを
// すべて署名する）。経路上で書き換えられれば署名が壊れるので、3.4-1 が要求する
// メタデータは「送った値がそのまま保存される」ことが担保される。
//
// **再試行しない。** 失敗は関数の障害として呼び出し側へ返り、3.8 の degrade 判定
// （「ビルド依頼の失敗」で発火する）が見たい事象そのものになる。ここで黙って
// 隠すと、R2 側の不調が誰にも見えないまま生成だけが失敗し続ける。
//
// @param ctx コンテキスト
// @param cred R2 の資格情報
// @param key オブジェクトキー
// @param contentType `Content-Type`
// @param contentEncoding `Content-Encoding`（空なら付けない）
// @param body 本体
// @returns 書けなければエラー
func (c *r2Client) putObject(
	ctx context.Context,
	cred r2Credentials,
	key, contentType, contentEncoding string,
	body []byte,
) error {
	endpoint := c.r2URL(cred.AccountID)
	target, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("R2 のエンドポイントを組み立てられません: %w", err)
	}
	// **`Path` へ入れて `EscapedPath` に任せる。** 自分で連結した文字列を `RawPath` へ
	// 入れると、署名側と送信側で符号化がずれうる。
	target.Path = "/" + cred.Bucket + "/" + key

	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("R2 への要求を組み立てられません: %w", err)
	}
	payloadHash := hashHex(body)
	request.Header.Set("Content-Type", contentType)
	if contentEncoding != "" {
		request.Header.Set("Content-Encoding", contentEncoding)
	}
	// S3 互換 API は本文ハッシュのヘッダを要求する（署名にも同じ値が入る）。
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	request.ContentLength = int64(len(body))

	// **リージョンは `auto`。** R2 は単一のグローバル名前空間で、署名スコープにだけ
	// 現れる（Cloudflare の S3 互換 API の規約）。
	if err := signRequest(request, awsCredentials{
		AccessKeyID:     cred.AccessKeyID,
		SecretAccessKey: cred.SecretAccessKey,
	}, "auto", "s3", payloadHash, c.timeNow()); err != nil {
		return err
	}

	response, err := c.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("R2 へ書けませんでした（%s）: %s", key, describeTransportError(err))
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8*1024))
		_ = response.Body.Close()
	}()

	if response.StatusCode/100 != 2 {
		// **本文を出さない。** 綴りの手掛かりは状態コードと `cf-ray` で足りる。
		return fmt.Errorf("R2 が %s を返しました（key=%s / cf-ray=%s）",
			response.Status, key, response.Header.Get("cf-ray"))
	}
	return nil
}

// httpClient は使う HTTP クライアントを返す。
//
// @returns クライアント
func (c *r2Client) httpClient() *http.Client {
	if c.http != nil {
		return c.http
	}
	return &http.Client{Timeout: r2HTTPTimeout}
}

// ssmURL は SSM のエンドポイントを返す。
//
// @returns エンドポイント
func (c *r2Client) ssmURL() string {
	if c.ssmEndpoint != nil {
		return c.ssmEndpoint()
	}
	return fmt.Sprintf("https://ssm.%s.amazonaws.com/", c.settings.region)
}

// r2URL は R2 のエンドポイントを返す。
//
// @param accountID Cloudflare のアカウント ID
// @returns エンドポイント
func (c *r2Client) r2URL(accountID string) string {
	if c.r2Endpoint != nil {
		return c.r2Endpoint(accountID)
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com/", accountID)
}

// describeTransportError は通信の失敗を、ログへ出してよい 1 行へ落とす。
//
// **宛先も資格情報も出さない。** `*url.Error` は URL を `Error()` に含めるため、
// そのまま出すとエンドポイントとクエリが残る。ここは資格情報を扱う経路なので、
// 「どの層で落ちたか」だけにする（`src/build-client.ts` の `describeSendError` と
// 同じ方針）。
//
// @param err 受け取ったエラー
// @returns 出してよい 1 行
func describeTransportError(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		switch {
		case urlErr.Timeout():
			return "時間内に応答がありませんでした"
		case errors.Is(urlErr.Err, context.Canceled) || errors.Is(urlErr.Err, context.DeadlineExceeded):
			return "呼び出しが打ち切られました"
		default:
			return fmt.Sprintf("%T", urlErr.Err)
		}
	}
	return fmt.Sprintf("%T", err)
}

// artifactKeys は成果物 2 つの R2 キーを決める（3.3-6 の命名。確定26）。
//
// # 作品 id を入れない
//
// **確定26（#116）は「R2 のオブジェクトは作品をまたいで共有される」を正とした。**
// 3.8 のビルド結果キャッシュは生成ソースのコンテンツハッシュを鍵にするため、
// **同一ソースから生まれた複数の作品が同じオブジェクトを指す。** キーに作品 id を
// 入れると、ヒット時（＝関数を呼ばない）に作れないキーが生まれ、キャッシュか
// 「作品 1 件 = オブジェクト 1 組」のどちらかが壊れる。**したがって内容だけから決める。**
//
// 鍵は**生成ソース（UTF-8）の SHA-256** で、`src/build-cache.ts` の `sourceCacheKey`
// と同じ値である。同じソースは必ず同じキーになるので、同じ内容を上書きするだけで
// あり、他の作品が指しているオブジェクトを壊さない。
//
// # `.wasm.br` にだけ Go の版を入れる
//
// **同じソースでも Go の版が変われば wasm は別物になる。** 3.5 は「過去の行は
// `go_version` に従って旧 `wasm_exec.js` で配信され続ける」と定めており、版を
// キーへ入れないと、Go を更新したあとの再ビルドが**既存の作品が指しているオブジェクトを
// 別の版の中身で上書きする。** その作品の `go_version` は古いままなので、
// 版の合わない `wasm_exec.js` で配信され、黙って壊れる。
//
// `source.go` は版に依存しない（5.3 が求めるのはソースそのもの）ので、版を入れない。
// 入れると、同じソースの複製が版の数だけ増える。
//
// # ライフサイクルルールを置かない接頭辞である
//
// 3.7 は「**年齢だけで消すライフサイクルルールに、共有されうるオブジェクトを載せない**」
// と定める（規約 3）。`builds/` はまさに共有される場所なので、ここにルールを置かない。
// 掃除は `games` を引ける側（M5-4 / `deleteUnreferencedArtifacts`）が行う。
//
// @param source 生成された Go ソース
// @param goVersion ビルドに使った Go の版
// @returns 2 つのキー
func artifactKeys(source []byte, goVersion string) StoredArtifacts {
	digest := hashHex(source)
	return StoredArtifacts{
		SourceKey: fmt.Sprintf("builds/%s/source.go", digest),
		WasmKey:   fmt.Sprintf("builds/%s/%s/game.wasm.br", digest, sanitizeKeySegment(goVersion)),
	}
}

// sanitizeKeySegment はキーの 1 区画として安全な綴りへ落とす。
//
// `runtime.Version()` は通常 `go1.26.5` を返すが、開発版のツールチェインでは
// `devel go1.27-abc123` のように**空白やスラッシュを含みうる**。そのままキーへ入れると、
// 階層が 1 つ増えたり符号化が要るキーになる。**版が読める形は保ったまま、
// 使える文字だけにする。**
//
// @param value 元の値
// @returns キーに使える綴り（空なら `unknown`）
func sanitizeKeySegment(value string) string {
	var out strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			out.WriteRune(r)
		default:
			out.WriteRune('-')
		}
	}
	trimmed := strings.Trim(out.String(), "-")
	if trimmed == "" {
		return "unknown"
	}
	return trimmed
}
