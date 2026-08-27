package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 7.1 の「受け入れた劣化」3 点目は、掃除が**テスト可能な単位**であることを、
// 使い捨ての保証を手放す理由の一部として挙げている。本ファイルがその単位である。

func TestResetScratchRemovesEverything(t *testing.T) {
	root := t.TempDir()

	mustWrite(t, filepath.Join(root, "game.wasm"), "artifact")
	mustWrite(t, filepath.Join(root, ".hidden"), "dotfile")
	mustMkdir(t, filepath.Join(root, "inv-1", "gocache", "ab"))
	mustWrite(t, filepath.Join(root, "inv-1", "gocache", "ab", "entry"), "cached")
	mustWrite(t, filepath.Join(root, "inv-1", "main.go"), "package main")

	if err := ResetScratch(root); err != nil {
		t.Fatalf("ResetScratch: %v", err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("掃除後に %d 件残っています: %v", len(entries), names(entries))
	}
}

func TestResetScratchKeepsRootItself(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "a"), "x")

	if err := ResetScratch(root); err != nil {
		t.Fatalf("ResetScratch: %v", err)
	}

	// **root 自身を消してはいけない。** 本番の root は /tmp であり、Lambda の
	// エフェメラルストレージのマウント点そのものである。
	info, err := os.Stat(root)
	if err != nil {
		t.Fatalf("root が消えています: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("root がディレクトリではなくなっています")
	}
}

func TestResetScratchCreatesMissingRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-yet")

	if err := ResetScratch(root); err != nil {
		t.Fatalf("ResetScratch: %v", err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("root が作られていません: %v", err)
	}
}

// **リンク先を巻き込まない。** /tmp の中に外を指すリンクが残っていても、
// 掃除が消すのはリンクそのものだけである。
func TestResetScratchDoesNotFollowSymlinks(t *testing.T) {
	outside := t.TempDir()
	victim := filepath.Join(outside, "keep-me")
	mustWrite(t, victim, "important")

	root := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("シンボリックリンクを作成できません: %v", err)
	}

	if err := ResetScratch(root); err != nil {
		t.Fatalf("ResetScratch: %v", err)
	}

	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("リンクが消えていません: %v", err)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("リンク先を巻き込んで消しています: %v", err)
	}
}

// go build は中間ディレクトリを書き込み不可のまま残すことがある。
// **そこで掃除が止まると、以降の呼び出しがすべて残骸の上で走る。**
func TestResetScratchRemovesUnwritableDirectories(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root では権限による失敗を再現できない")
	}

	root := t.TempDir()
	locked := filepath.Join(root, "inv-1", "gocache")
	mustMkdir(t, locked)
	mustWrite(t, filepath.Join(locked, "entry"), "cached")
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	if err := ResetScratch(root); err != nil {
		t.Fatalf("ResetScratch: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("書き込み不可のディレクトリが残っています: %v", names(entries))
	}
}

func TestNewInvocationDirIsUniqueAndPrivate(t *testing.T) {
	root := t.TempDir()

	first, err := NewInvocationDir(root)
	if err != nil {
		t.Fatalf("NewInvocationDir: %v", err)
	}
	second, err := NewInvocationDir(root)
	if err != nil {
		t.Fatalf("NewInvocationDir: %v", err)
	}
	if first == second {
		t.Fatalf("呼び出しごとに一意になっていません: %s", first)
	}

	info, err := os.Stat(first)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Fatalf("作業ディレクトリが他者へ開いています: %o", mode)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
}

func names(entries []os.DirEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}
