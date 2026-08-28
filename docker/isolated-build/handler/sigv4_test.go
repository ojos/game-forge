package main

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// AWS が公表している SigV4 の計算例（`AKIDEXAMPLE` の ListUsers）で照合する。
//
// **自分の出力を期待値にしない。** 署名の実装は「動いているように見えて 403 が返る」
// 形で壊れる。期待値を自分の出力から取ると、壊れた実装がそのまま緑になる。
// ここに置いた 3 つの値（正規リクエスト・署名鍵・署名）は AWS のドキュメント
// （Signature Version 4 の計算例）と、**別実装である `aws4fetch`（Workers 側が使う
// もの）の出力**の両方に一致することを確かめてある。
const (
	exampleAccessKeyID = "AKIDEXAMPLE"
	// テスト用の固定値である。**実在の資格情報ではない**（AWS が公表している例）。
	exampleSecretKey  = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	exampleSignature  = "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
	exampleSigningKey = "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
)

func TestSignRequestMatchesAWSExample(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", nil)
	if err != nil {
		t.Fatalf("リクエストを作れません: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")

	at := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	cred := awsCredentials{AccessKeyID: exampleAccessKeyID, SecretAccessKey: exampleSecretKey}
	if err := signRequest(req, cred, "us-east-1", "iam", emptyPayloadSHA256, at); err != nil {
		t.Fatalf("署名できません: %v", err)
	}

	auth := req.Header.Get("Authorization")
	want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
		"SignedHeaders=content-type;host;x-amz-date, Signature=" + exampleSignature
	if auth != want {
		t.Fatalf("Authorization が公表値と一致しません\n  得: %s\n  期: %s", auth, want)
	}
	if got := req.Header.Get("X-Amz-Date"); got != "20150830T123600Z" {
		t.Fatalf("X-Amz-Date が %q です", got)
	}
	// **JSON プロトコルの API へ本文ハッシュのヘッダを送らない**（S3 だけが要求する）。
	if got := req.Header.Get("X-Amz-Content-Sha256"); got != "" {
		t.Fatalf("X-Amz-Content-Sha256 を送っています: %q", got)
	}
}

func TestSigningKeyMatchesAWSExample(t *testing.T) {
	got := hashOfBytes(signingKey(exampleSecretKey, "20150830", "us-east-1", "iam"))
	if got != exampleSigningKey {
		t.Fatalf("署名鍵が公表値と一致しません\n  得: %s\n  期: %s", got, exampleSigningKey)
	}
}

// 一時資格情報のときだけ `X-Amz-Security-Token` を送り、**署名対象にも入る**こと。
//
// 落とすと、AWS は署名の再計算に使えるがヘッダが無い（あるいはその逆）状態になり、
// 403 になる。**署名対象へ入っていることまで見る。**
func TestSignRequestIncludesSessionToken(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://ssm.ap-northeast-1.amazonaws.com/", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("リクエストを作れません: %v", err)
	}
	cred := awsCredentials{
		AccessKeyID:     exampleAccessKeyID,
		SecretAccessKey: exampleSecretKey,
		SessionToken:    "session-token-value",
	}
	if err := signRequest(req, cred, "ap-northeast-1", "ssm", hashHex([]byte("{}")), time.Now()); err != nil {
		t.Fatalf("署名できません: %v", err)
	}
	if req.Header.Get("X-Amz-Security-Token") != "session-token-value" {
		t.Fatal("X-Amz-Security-Token を送っていません")
	}
	if !strings.Contains(req.Header.Get("Authorization"), "x-amz-security-token") {
		t.Fatalf("SignedHeaders に x-amz-security-token がありません: %s", req.Header.Get("Authorization"))
	}
}

// 資格情報が空のまま署名しない（403 を「権限不足」と読み違えないため）。
func TestSignRequestRejectsEmptyCredentials(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	if err != nil {
		t.Fatalf("リクエストを作れません: %v", err)
	}
	if err := signRequest(req, awsCredentials{}, "us-east-1", "s3", emptyPayloadSHA256, time.Now()); err == nil {
		t.Fatal("資格情報が空でも署名してしまいました")
	}
}

func TestCanonicalQuerySortsAndFillsEquals(t *testing.T) {
	if got := canonicalQuery("b=2&a&c=3"); got != "a=&b=2&c=3" {
		t.Fatalf("クエリの正規化が違います: %q", got)
	}
	if got := canonicalQuery(""); got != "" {
		t.Fatalf("空のクエリは空のままであるべきです: %q", got)
	}
}

// 空の本文のハッシュを定数で持っているので、計算値と一致することを見る。
func TestEmptyPayloadSHA256Constant(t *testing.T) {
	if got := hashHex(nil); got != emptyPayloadSHA256 {
		t.Fatalf("空本文のハッシュ定数が違います: %s", got)
	}
}

// hashOfBytes はバイト列を 16 進表現にする（テスト用）。
//
// @param data 対象
// @returns 小文字 16 進
func hashOfBytes(data []byte) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, len(data)*2)
	for _, b := range data {
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return string(out)
}
