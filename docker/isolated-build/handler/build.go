package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// copyTree は src の**中身**を dst へ複製する（7.1 の前提 1 の本番版）。
//
// 7.1 は「vendor 済みテンプレートは /src に焼き込み、エントリポイントで作業ディレクトリへ
// コピーする」と定める。ローカルではコピー先が tmpfs の /work、**本番では /tmp 配下**に
// なる（7.1 の対応表）。イメージ内のテンプレートは読み取り専用のまま残る。
//
// **通常ファイルとディレクトリだけを複製する。** テンプレートに symlink やデバイスが
// 現れたら、複製せずに失敗させる。イメージの中身が想定と違うことに気づかず、
// リンク先を巻き込んだツリーでビルドを始めないため。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)

		switch {
		case d.IsDir():
			// テンプレートのモードではなく 0700 で作る。複製先は呼び出し専用の
			// 領域であり、他者へ開ける理由が無い。
			return os.MkdirAll(target, 0o700)
		case d.Type().IsRegular():
			return copyFile(path, target)
		default:
			return fmt.Errorf("テンプレートに通常ファイルでない要素があります: %s (%s)", rel, d.Type())
		}
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// compileWasm は workDir を module ルートとして `go build` を回す。
//
// **フラグは 3.4-3 の `-ldflags="-s -w"` をそのまま使う。** 環境変数はイメージの ENV
// （CGO_ENABLED=0 / GOFLAGS=-mod=vendor / GOTOOLCHAIN=local / GOOS=js / GOARCH=wasm）を
// 引き継ぎ、**書き込み先だけを呼び出しごとの領域へ寄せる**（7.1 の対応表。本番で
// 書けるのは /tmp だけである）。
//
// 戻り値の第 1 引数は go の出力（標準出力と標準エラーの結合）である。**ビルドが
// 失敗すること自体は関数の障害ではない**（生成されたコードが通らないだけである）ため、
// 呼び出し側はこれを利用者向けの診断として扱う。
func compileWasm(ctx context.Context, workDir, outPath string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "go", "build", "-ldflags=-s -w", "-o", outPath, ".")
	cmd.Dir = workDir
	cmd.Env = append(environWithoutCredentials(),
		"GOCACHE="+filepath.Join(workDir, "gocache"),
		"GOMODCACHE="+filepath.Join(workDir, "gomodcache"),
		"GOTMPDIR="+filepath.Join(workDir, "gotmp"),
		// ルートファイルシステムが読み取り専用なので HOME を書ける場所へ逃がす。
		// 既定の /root は本番でも書けない。
		"HOME="+workDir,
	)
	for _, dir := range []string{"gocache", "gomodcache", "gotmp"} {
		if err := os.MkdirAll(filepath.Join(workDir, dir), 0o700); err != nil {
			return nil, err
		}
	}
	return cmd.CombinedOutput()
}

// compressBrotli は brotli(1) で圧縮する（3.3-6 / 3.4-1）。
//
// # なぜ Go のライブラリではなく外部コマンドか
//
// 標準ライブラリに brotli は無い。純 Go の移植（andybalholm/brotli）はあるが、
//
//   - このモジュールは**依存を 1 つも持たない**方針である（go.mod の注記）。
//   - **q11 は本プロダクトで最も重い処理**であり、参照実装（C）より遅い実装を
//     選ぶ余地が無い（下の quality の注記）。
//
// # 品質は宣言から受け取る
//
// 既定値をコードへ焼き込まない。**どの品質で配っているかは Terraform の宣言が持つ**
// （terraform/build-function.tf の BROTLI_QUALITY）。3.8 のタイムアウトに収まるかは品質で
// 決まるため、タイムアウトと同じ場所で読めるようにしてある。
func compressBrotli(ctx context.Context, quality int, srcPath, dstPath string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "brotli",
		fmt.Sprintf("--quality=%d", quality),
		// 窓を 24 bit（16 MB）まで開ける。未圧縮 wasm は 8〜12 MB（3.4）で、
		// 既定の 22 bit（4 MB）では全体を 1 窓に収められない。実測で
		// 1,991,404 バイト（lgwin=24）と 2,014,179 バイト（lgwin=22）の差が出た。
		"--lgwin=24",
		"--output="+dstPath,
		srcPath,
	)
	return cmd.CombinedOutput()
}

// environWithoutCredentials は、AWS の資格情報を落とした環境変数一覧を返す。
//
// # なぜ落とすのか（3.3-6 の受け入れ条件）
//
// 3.3 は「**R2 の認証情報はビルド側のみが保持する。ブラウザにもコンテナにも渡らない**」
// と定める。R2 の資格情報は環境変数へ置いていない（`r2.go` の注記）ので、そちらは
// 構造として渡らない。**残るのは Lambda が実行ロールのために置く `AWS_*` である。**
// これは R2 の鍵ではないが、`ssm:GetParameter` と `kms:Decrypt` を持つ資格情報であり、
// **渡せば R2 の資格情報を取りに行ける。**
//
// `go build` は生成コードを実行しない（CGO_ENABLED=0 で cgo も無く、`//go:generate` も
// 走らない）ため、いま漏れる経路が分かっているわけではない。**それでも渡さない。**
// 7.1 の封じ込めは「経路を数え上げて塞ぐ」ではなく「持たせない」で立てている。
//
// **`AWS_LAMBDA_` は残す。** 実行環境の識別（関数名・メモリ量など）であって資格情報
// ではなく、落とすと Lambda の他の仕組みが読めなくなりうる。落とすのは資格情報と、
// それを名乗る 3 つに限る。
//
// @returns 資格情報を除いた環境変数一覧
func environWithoutCredentials() []string {
	blocked := map[string]bool{
		"AWS_ACCESS_KEY_ID":     true,
		"AWS_SECRET_ACCESS_KEY": true,
		"AWS_SESSION_TOKEN":     true,
		// 古い綴り（SDK が受け付ける別名）も落とす。
		"AWS_SECURITY_TOKEN": true,
		// 資格情報そのものではないが、取りに行く先である。
		"AWS_CONTAINER_CREDENTIALS_FULL_URI":     true,
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": true,
		"AWS_CONTAINER_AUTHORIZATION_TOKEN":      true,
		// R2 の資格情報の在り処。値ではないが、渡す理由が無い。
		"R2_CREDENTIALS_PARAMETER": true,
	}

	source := os.Environ()
	out := make([]string, 0, len(source))
	for _, entry := range source {
		name, _, found := strings.Cut(entry, "=")
		if found && blocked[name] {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// digestFile はファイルのバイト数と sha256 を返す。
//
// **呼び出し側へ渡すのは値そのものではなく、この 2 つである。** 経路のどこかで
// 切り詰めが起きたときに、終了コードではなくこの照合で気づけるようにする
// （ローカルの docker attach では実際に無音の切り詰めが起きる。
// scripts/check-isolated-build.sh の注記）。
func digestFile(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

// trimDiagnostics は外部コマンドの出力を、呼び出し側へ返せる大きさへ切り詰める。
//
// **ビルドエラーの本文は利用者へ見せる価値があるが、全文は要らない。** 生成コードが
// 大きく崩れると go は数百行を吐く。Lambda の同期応答は 6 MB 上限（#76）であり、
// 成果物と同じ応答へ載せる以上、診断側に上限を持たせる。
func trimDiagnostics(out []byte, limit int) string {
	s := strings.TrimRight(string(out), "\n")
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "\n… (診断を切り詰めました)"
}
