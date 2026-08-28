package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// AWS Signature Version 4 の署名（3.3-6）。
//
// # なぜ自分で書くのか
//
// このモジュールは**依存パッケージを 1 つも持たない**（go.mod の注記）。aws-sdk-go-v2 を
// 入れれば署名も SSM も S3 も済むが、**攻撃者が制御しうるコードをコンパイルする環境**
// （7.1）へ持ち込む攻撃面が増える。SigV4 は HMAC-SHA256 と文字列連結だけで組み立て
// られる仕様で、標準ライブラリで足りる。
//
// **署名は 2 か所で使う。** どちらも同じ関数を通す。
//
//   - **SSM GetParameter**（service=`ssm` / region=Lambda のリージョン）。署名鍵は
//     Lambda の実行ロールが環境変数へ置く一時資格情報である。
//   - **R2 の PutObject**（service=`s3` / region=`auto`）。署名鍵は SSM から読んだ
//     Cloudflare の R2 トークンである。
//
// **資格情報を 1 つも文字列化してログへ出さない。** この型の値は `%v` で出さないこと。
//
// 参照: AWS「Create a signed AWS API request」（SigV4 の 4 手順）。

// awsCredentials は SigV4 の署名に使う資格情報。
//
// **ログへ出さない。** `String()` を実装しないのは、実装すると「出してよいもの」に
// 見えるためである。出す必要がない。
type awsCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	// SessionToken は一時資格情報のときだけ入る（Lambda の実行ロールは必ず持つ。
	// R2 のトークンは持たない）。空なら `X-Amz-Security-Token` を送らない。
	SessionToken string
}

// valid は署名に足りているかを返す。
//
// **空の資格情報で署名して 403 を受け取る経路を作らない。** 403 は「権限が足りない」
// と読めてしまい、実際の原因（環境変数が無い）へ辿り着けない。
//
// @returns 署名に足りていれば true
func (c awsCredentials) valid() bool {
	return c.AccessKeyID != "" && c.SecretAccessKey != ""
}

const (
	// sigv4Algorithm は署名アルゴリズムの綴り（Authorization ヘッダと署名文字列に現れる）。
	sigv4Algorithm = "AWS4-HMAC-SHA256"
	// sigv4TimeFormat は `X-Amz-Date` の書式（ISO 8601 basic の UTC）。
	sigv4TimeFormat = "20060102T150405Z"
	// sigv4DateFormat は資格情報スコープに現れる日付。
	sigv4DateFormat = "20060102"
	// emptyPayloadSHA256 は空の本文の SHA-256（GET / DELETE で使う定数）。
	emptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

// signRequest は req へ SigV4 の署名を足す（`Authorization` ヘッダを付ける）。
//
// **本文のハッシュは呼び出し側が渡す。** ここで `req.Body` を読むと、読み切った
// ボディを巻き戻す責務がこの関数に生まれる。`.wasm.br` は 2 MB あり、二重に持ちたく
// ない。呼び出し側は元のバイト列を持っているので、そちらで一度だけ計算する。
//
// **署名対象のヘッダは「送るヘッダ全部」＋ `host` である。** 一部だけを署名する形に
// すると、署名していないヘッダ（`Content-Encoding` など）を経路上で書き換えられても
// 署名が通る。3.4-1 が要求するメタデータをまさにヘッダで渡すため、ここは全部署名する。
//
// @param req 署名するリクエスト（`Host` が埋まっていること）
// @param cred 署名に使う資格情報
// @param region 署名に使うリージョン（R2 は `auto`）
// @param service 署名に使うサービス名（`ssm` / `s3`）
// @param payloadSHA256 本文の SHA-256（小文字 16 進）
// @param now 署名時刻
// @returns 署名できなければエラー
func signRequest(
	req *http.Request,
	cred awsCredentials,
	region, service, payloadSHA256 string,
	now time.Time,
) error {
	if !cred.valid() {
		return fmt.Errorf("%s の署名に使う資格情報がありません", service)
	}
	if req.URL == nil {
		return fmt.Errorf("%s の署名対象に URL がありません", service)
	}

	utc := now.UTC()
	amzDate := utc.Format(sigv4TimeFormat)
	scopeDate := utc.Format(sigv4DateFormat)

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	req.Host = host

	req.Header.Set("X-Amz-Date", amzDate)
	// **`X-Amz-Content-Sha256` はここで付けない。** S3（R2）は本文ハッシュのヘッダを
	// 要求するが、SSM のような JSON プロトコルの API は要求しない。ここで一律に付けると
	// 送るヘッダが増え、**AWS 公表の署名テストベクタと SignedHeaders が食い違う**
	// （検証できない実装になる）。要る側（putObject）が自分で付ける。
	if cred.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", cred.SessionToken)
	}

	signedHeaders, canonicalHeaders := canonicalizeHeaders(req.Header, host)

	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL.EscapedPath()),
		canonicalQuery(req.URL.RawQuery),
		canonicalHeaders,
		signedHeaders,
		payloadSHA256,
	}, "\n")

	scope := strings.Join([]string{scopeDate, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		sigv4Algorithm,
		amzDate,
		scope,
		hashHex([]byte(canonicalRequest)),
	}, "\n")

	signature := hex.EncodeToString(hmacSHA256(
		signingKey(cred.SecretAccessKey, scopeDate, region, service),
		[]byte(stringToSign),
	))

	req.Header.Set("Authorization", fmt.Sprintf(
		"%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		sigv4Algorithm, cred.AccessKeyID, scope, signedHeaders, signature,
	))
	return nil
}

// canonicalizeHeaders は署名対象のヘッダ一覧と正規化した本体を返す。
//
// **`host` は Header に入っていない**（Go は `Request.Host` で持つ）ため、ここで足す。
// 足さないと SignedHeaders から落ち、AWS 側の再計算と一致しない。
//
// @param header 送信するヘッダ
// @param host `Host` の値
// @returns 署名対象ヘッダ名（`;` 区切り・昇順）と、正規化したヘッダ本体
func canonicalizeHeaders(header http.Header, host string) (string, string) {
	values := map[string]string{"host": strings.TrimSpace(host)}
	for name, list := range header {
		lower := strings.ToLower(name)
		if lower == "authorization" {
			// 署名そのものは署名対象に含めない。
			continue
		}
		trimmed := make([]string, 0, len(list))
		for _, value := range list {
			// **連続する空白を 1 つへ潰す**のが SigV4 の規約である。
			trimmed = append(trimmed, strings.Join(strings.Fields(value), " "))
		}
		values[lower] = strings.Join(trimmed, ",")
	}

	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)

	var canonical strings.Builder
	for _, name := range names {
		canonical.WriteString(name)
		canonical.WriteString(":")
		canonical.WriteString(values[name])
		canonical.WriteString("\n")
	}
	return strings.Join(names, ";"), canonical.String()
}

// canonicalURI は正規化したパスを返す。
//
// **`net/url` の `EscapedPath` をそのまま使う。** ここで再度エンコードすると、
// 既にエンコード済みの `%` が `%25` になる（二重符号化）。本プロダクトが作るキーは
// `builds/<16 進>/…` と ASCII だけなので差は出ないが、**綴りが変わったときに黙って
// 壊れる**形にはしない。
//
// @param escapedPath URL のパス（符号化済み）
// @returns 正規化したパス
func canonicalURI(escapedPath string) string {
	if escapedPath == "" {
		return "/"
	}
	return escapedPath
}

// canonicalQuery はクエリ文字列を正規化する（名前で昇順、`=` 必須）。
//
// **`url.Values.Encode()` を使わない。** あれは値を再符号化するため、既に符号化済みの
// 生のクエリを渡すと二重符号化になる。ここは「並べ替えと `=` の補完」だけを行う。
//
// @param rawQuery 生のクエリ文字列
// @returns 正規化したクエリ文字列
func canonicalQuery(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	parts := strings.Split(rawQuery, "&")
	pairs := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		if !strings.Contains(part, "=") {
			part += "="
		}
		pairs = append(pairs, part)
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

// signingKey は日付・リージョン・サービスで派生させた署名鍵を返す。
//
// @param secret シークレットアクセスキー
// @param scopeDate 資格情報スコープの日付（`YYYYMMDD`）
// @param region リージョン
// @param service サービス名
// @returns 署名鍵
func signingKey(secret, scopeDate, region, service string) []byte {
	key := hmacSHA256([]byte("AWS4"+secret), []byte(scopeDate))
	key = hmacSHA256(key, []byte(region))
	key = hmacSHA256(key, []byte(service))
	return hmacSHA256(key, []byte("aws4_request"))
}

// hmacSHA256 は HMAC-SHA256 を計算する。
//
// @param key 鍵
// @param data 対象
// @returns MAC
func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// hashHex は SHA-256 の小文字 16 進表現を返す。
//
// @param data 対象
// @returns SHA-256（小文字 16 進）
func hashHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
