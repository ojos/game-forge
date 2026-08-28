package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本ファイルが固定するのは **「掃除がハンドラの先頭で走る」という順序そのもの**である
// （7.1 の「受け入れた劣化」3 点目）。単体の掃除が正しくても、呼ばれる位置が
// 1 行下がれば封じ込めの穴になる。順序は grep ではなく振る舞いで押さえる。

// newTestHandler は go build も brotli も呼ばないハンドラを作る。
//
// **実物を呼ばないのは、掃除の順序を確かめるのに要らないからである。** 実物を通す
// 検査は scripts/check-isolated-build.sh がイメージごと回す。
func newTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()

	scratch := t.TempDir()
	template := t.TempDir()
	mustWrite(t, filepath.Join(template, "go.mod"), "module gameforge.local/sandbox\n")
	mustWrite(t, filepath.Join(template, "vendor", "modules.txt"), "# vendored\n")

	// **書き戻しを持たないハンドラである**（`R2_UPLOAD=skip` に相当）。R2 へ書く経路の
	// 検査は下の `TestHandleUploads…` が受け持つ。
	h := NewHandler(scratch, template, 9, nil)
	return h, scratch
}

// newUploadingTestHandler は R2 への書き戻しを差し替えたハンドラを作る。
//
// **実 R2 を叩かない。** 叩けば外部認証と課金が受け入れ条件に混ざる
// （`src/build-client.ts` が `fetch` を継ぎ目にしたのと同じ理由）。
//
// @param t テスト
// @param upload 差し替える書き戻し
// @returns ハンドラ
func newUploadingTestHandler(
	t *testing.T,
	upload func(context.Context, uploadRequest) (*StoredArtifacts, error),
) *Handler {
	t.Helper()
	h, _ := newTestHandler(t)
	h.Upload = upload
	h.compile = func(_ context.Context, _, outPath string) ([]byte, error) {
		mustWrite(t, outPath, "\x00asm the wasm")
		return nil, nil
	}
	h.compress = func(_ context.Context, _ int, _, dstPath string) ([]byte, error) {
		mustWrite(t, dstPath, "compressed")
		return nil, nil
	}
	return h
}

// 入力が壊れていても掃除は走る。
//
// **これが素通りすると、壊れた入力を投げ続けるだけで残骸を残せる。**
func TestHandleCleansScratchBeforeValidatingTheEvent(t *testing.T) {
	h, scratch := newTestHandler(t)
	marker := filepath.Join(scratch, "residue-from-previous-invocation")
	mustWrite(t, marker, "leftover")

	res, err := h.Handle(context.Background(), Event{Source: ""})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if res.OK || res.Stage != "request" {
		t.Fatalf("空のソースが request 段の失敗になっていません: %+v", res)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("入力検査より前に掃除が走っていません: %v", err)
	}
}

// ビルドが失敗しても掃除は走る（先頭で走っているのだから当然だが、順序が
// 入れ替わったときにここが落ちる）。
func TestHandleCleansScratchEvenWhenTheBuildFails(t *testing.T) {
	h, scratch := newTestHandler(t)
	h.compile = func(_ context.Context, _, _ string) ([]byte, error) {
		return []byte("./main.go:3:1: syntax error"), errors.New("exit status 1")
	}
	marker := filepath.Join(scratch, "residue")
	mustWrite(t, marker, "leftover")

	res, err := h.Handle(context.Background(), Event{Source: "package main\n"})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("掃除が走っていません: %v", err)
	}
	if res.OK || res.Stage != "build" {
		t.Fatalf("ビルド失敗が build 段として返っていません: %+v", res)
	}
	if !strings.Contains(res.Message, "syntax error") {
		t.Fatalf("診断が返っていません: %q", res.Message)
	}
	// **ビルド失敗は関数の障害ではない。** error を返すと 3.8 の degrade 判定が誤爆する。
}

// 実行環境の再利用を模した検査。1 回目の作業ディレクトリが 2 回目には残っていない。
func TestHandleWipesThePreviousInvocationDirectory(t *testing.T) {
	h, scratch := newTestHandler(t)
	h.compile = func(_ context.Context, workDir, outPath string) ([]byte, error) {
		mustWrite(t, outPath, "\x00asm fake")
		// go build が残しがちな中間物を模す。
		mustMkdir(t, filepath.Join(workDir, "gocache", "ab"))
		return nil, nil
	}
	h.compress = func(_ context.Context, _ int, srcPath, dstPath string) ([]byte, error) {
		body, err := os.ReadFile(srcPath)
		if err != nil {
			return nil, err
		}
		mustWrite(t, dstPath, "br:"+string(body))
		return nil, nil
	}

	if _, err := h.Handle(context.Background(), Event{Source: "package main\n"}); err != nil {
		t.Fatalf("1 回目: %v", err)
	}
	first, err := os.ReadDir(scratch)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("1 回目のあとに作業ディレクトリが 1 つだけ残っていません: %v", names(first))
	}

	if _, err := h.Handle(context.Background(), Event{Source: "package main\n"}); err != nil {
		t.Fatalf("2 回目: %v", err)
	}
	second, err := os.ReadDir(scratch)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(second) != 1 {
		t.Fatalf("2 回目のあとに %d 件あります（前回分が残っています）: %v", len(second), names(second))
	}
	if second[0].Name() == first[0].Name() {
		t.Fatalf("2 回目が前回と同じディレクトリを使っています: %s", second[0].Name())
	}
}

func TestHandleReturnsTheCompressedArtifact(t *testing.T) {
	h, _ := newTestHandler(t)
	h.compile = func(_ context.Context, _, outPath string) ([]byte, error) {
		mustWrite(t, outPath, "\x00asm the wasm")
		return nil, nil
	}
	h.compress = func(_ context.Context, quality int, _, dstPath string) ([]byte, error) {
		if quality != 9 {
			t.Fatalf("宣言された品質が渡っていません: %d", quality)
		}
		mustWrite(t, dstPath, "compressed")
		return nil, nil
	}

	res, err := h.Handle(context.Background(), Event{Source: "package main\n"})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !res.OK {
		t.Fatalf("成功していません: %+v", res)
	}
	if res.Compressed == nil || res.Compressed.ContentEncoding != "br" {
		t.Fatalf("Content-Encoding が br になっていません: %+v", res.Compressed)
	}
	decoded, err := base64.StdEncoding.DecodeString(res.Compressed.Data)
	if err != nil {
		t.Fatalf("base64 として復号できません: %v", err)
	}
	if string(decoded) != "compressed" {
		t.Fatalf("成果物が一致しません: %q", decoded)
	}
	if res.Compressed.Bytes != int64(len("compressed")) {
		t.Fatalf("申告バイト数が一致しません: %d", res.Compressed.Bytes)
	}
	// **未圧縮 wasm の中身は返さない**（8〜12 MB あり、同期応答の 6 MB を超える）。
	if res.Wasm == nil || res.Wasm.Data != "" {
		t.Fatalf("未圧縮 wasm の本体を返しています: %+v", res.Wasm)
	}
	if res.GoVersion == "" {
		t.Fatalf("goVersion が空です（3.5 の wasm_exec.js 出し分けに要る）")
	}
}

// 3.3-6: 書き戻す構成では、キーが返り、**本体は返らない。**
func TestHandleUploadsAndReturnsKeys(t *testing.T) {
	var seen uploadRequest
	h := newUploadingTestHandler(t, func(_ context.Context, req uploadRequest) (*StoredArtifacts, error) {
		seen = req
		keys := artifactKeys(req.Source, req.GoVersion)
		return &keys, nil
	})

	const source = "package main\n\nfunc main() {}\n"
	res, err := h.Handle(context.Background(), Event{Source: source})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !res.OK {
		t.Fatalf("成功していません: %+v", res)
	}
	if string(seen.Source) != source {
		t.Fatalf("R2 へ渡したソースが違います: %q", seen.Source)
	}
	if string(seen.Compressed) != "compressed" {
		t.Fatalf("R2 へ渡した .wasm.br が違います: %q", seen.Compressed)
	}
	if seen.GoVersion != res.GoVersion {
		t.Fatalf("R2 へ渡した Go の版が結果と食い違います: %q / %q", seen.GoVersion, res.GoVersion)
	}
	if res.Storage == nil || res.Storage.SourceKey == "" || res.Storage.WasmKey == "" {
		t.Fatalf("書いたキーが返っていません: %+v", res.Storage)
	}
	// **本体は返さない**（3.3-6 の完成形。R2 に在るものを応答へ二重に載せない）。
	if res.Compressed.Data != "" {
		t.Fatalf("R2 へ書いたのに本体も返しています（%d 文字）", len(res.Compressed.Data))
	}
	// 3.4-1 のメタデータは書き戻しの有無に関わらず申告する。
	if res.Compressed.ContentEncoding != wasmContentEncoding {
		t.Fatalf("Content-Encoding が %q です", res.Compressed.ContentEncoding)
	}
}

// **R2 へ書けなかったら成功にしない**（3.3-6 / 3.3-8）。
//
// ここが `ok=true` になると、呼び出し側は成果物の無いキーで `games` 行を作り、
// **404 を返す作品**が生まれる。`ok=false` でもいけない（利用者のコードは通っており、
// #20 が手掛かりの無い再生成を起こす）。**関数の障害として返す。**
func TestHandleFailsWhenTheUploadFails(t *testing.T) {
	h := newUploadingTestHandler(t, func(context.Context, uploadRequest) (*StoredArtifacts, error) {
		return nil, errors.New("SSM が 400 を返しました")
	})

	res, err := h.Handle(context.Background(), Event{Source: "package main\n"})
	if err == nil {
		t.Fatalf("R2 へ書けなかったのに成功しました: %+v", res)
	}
	if res != nil {
		t.Fatalf("障害なのに結果を返しています: %+v", res)
	}
}

// キーを返さない書き戻しを「成功」として通さない。
func TestHandleFailsWhenTheUploadReturnsNoKeys(t *testing.T) {
	h := newUploadingTestHandler(t, func(context.Context, uploadRequest) (*StoredArtifacts, error) {
		return &StoredArtifacts{}, nil
	})

	if _, err := h.Handle(context.Background(), Event{Source: "package main\n"}); err == nil {
		t.Fatal("キーが空でも成功しました")
	}
}

// 書き戻しに渡す前にビルドが失敗したら、**R2 へは触らない**（資格情報も読まない）。
func TestHandleDoesNotUploadWhenTheBuildFails(t *testing.T) {
	called := false
	h := newUploadingTestHandler(t, func(context.Context, uploadRequest) (*StoredArtifacts, error) {
		called = true
		return &StoredArtifacts{SourceKey: "s", WasmKey: "w"}, nil
	})
	h.compile = func(context.Context, string, string) ([]byte, error) {
		return []byte("./main.go:3:1: syntax error"), errors.New("exit status 1")
	}

	res, err := h.Handle(context.Background(), Event{Source: "package main\n"})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if res.OK {
		t.Fatal("ビルドが失敗したのに成功しています")
	}
	if called {
		t.Fatal("ビルドが失敗したのに R2 を触りました")
	}
}

// テンプレートは作業ディレクトリへ複製され、生成コードはそこへ置かれる（7.1 の前提 1）。
func TestHandleCopiesTheTemplateAndPlacesTheSource(t *testing.T) {
	h, scratch := newTestHandler(t)
	var seen string
	h.compile = func(_ context.Context, workDir, outPath string) ([]byte, error) {
		body, err := os.ReadFile(filepath.Join(workDir, "main.go"))
		if err != nil {
			return nil, err
		}
		seen = string(body)
		if _, err := os.Stat(filepath.Join(workDir, "vendor", "modules.txt")); err != nil {
			return nil, err
		}
		mustWrite(t, outPath, "\x00asm")
		return nil, nil
	}
	h.compress = func(_ context.Context, _ int, _, dstPath string) ([]byte, error) {
		mustWrite(t, dstPath, "br")
		return nil, nil
	}

	const source = "package main\n\nfunc main() {}\n"
	if _, err := h.Handle(context.Background(), Event{Source: source}); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if seen != source {
		t.Fatalf("生成コードが作業ディレクトリへ置かれていません: %q", seen)
	}
	// テンプレート側（イメージ内）は触られていない。
	if _, err := os.Stat(filepath.Join(h.TemplateDir, "main.go")); !os.IsNotExist(err) {
		t.Fatalf("テンプレートへ生成コードを書き込んでいます: %v", err)
	}
	if _, err := os.Stat(scratch); err != nil {
		t.Fatalf("作業領域が消えています: %v", err)
	}
}
