package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DefaultScratchRoot は Lambda で唯一書き込める領域（7.1 の対応表）。
//
// ローカル Docker では 3 か所（tmpfs /tmp・tmpfs /work・volume /cache）に分かれていたが、
// **本番では /tmp 1 つへ潰れる**。7.1 の「受け入れた劣化」2 点目がこれで、
// 「キャッシュだけがリクエストをまたぐ領域」という汚染の境界がここで消えている。
const DefaultScratchRoot = "/tmp"

// ResetScratch は root の**中身を全部**消す。root 自身は残す。
//
// # なぜ全部消すのか
//
// Lambda は暖まった実行環境を次の呼び出しへ再利用する。`docker run --rm` が機構として
// 与えていた「1 リクエスト 1 コンテナ使い捨て」が本番には無い（7.1 の「受け入れた劣化」
// 3 点目）。**しかも AWS は「エラー後のリセットでも /tmp は消えない」と明文で書いている**
// ため、失敗した呼び出しの残骸が次の呼び出しへそのまま渡る。
//
// 7.1 は「境界を守るのではなく、またぐ領域そのものを毎回消す」と定めた。したがって
// 消す対象は作業ディレクトリだけではなく **/tmp 全体**である。GOCACHE も GOTMPDIR も
// この下に置くので、キャッシュごと消える。**それでよい**ことは実測済みで、キャッシュの
// 有無でビルド時間はほとんど変わらない（3.8。支配項はコンパイルではなくリンク）。
//
// # 失敗したら呼び出しを止める
//
// 消せなかったときに「掃除は諦めてビルドは続ける」を選ばない。**掃除の実装バグが
// そのまま封じ込めの穴になる**（7.1）以上、掃除が成立しなかった実行環境で
// 攻撃者由来のコードをコンパイルしないほうを選ぶ。呼び出しは失敗するが、
// Lambda は失敗が続く実行環境を落とすので、次の呼び出しは新しい環境で始まる。
//
// # シンボリックリンクを辿らない
//
// os.RemoveAll はリンクそのものを消し、リンク先へは降りない。前の呼び出しが
// /tmp の中に外を指すリンクを残していても、この掃除が外側を壊すことはない。
func ResetScratch(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// 実行環境の初回など、まだ存在しないことがある。作って終わる。
			if err := os.MkdirAll(root, 0o700); err != nil {
				return fmt.Errorf("作業領域を作成できません (%s): %w", root, err)
			}
			return nil
		}
		return fmt.Errorf("作業領域を読み取れません (%s): %w", root, err)
	}

	var failures []string
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if err := os.RemoveAll(path); err == nil {
			continue
		}

		// **書き込み権の無いディレクトリが残っていると RemoveAll は落ちる。**
		// go build は中間ディレクトリを 0555 で残すことがあり、実測でここを踏む。
		// 所有者は自分なので chmod はできる。1 度だけ緩めて消し直す。
		relaxTree(path)
		if err := os.RemoveAll(path); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", entry.Name(), err))
		}
	}

	if len(failures) > 0 {
		sort.Strings(failures)
		return fmt.Errorf("作業領域を掃除できませんでした (%s): %s", root, strings.Join(failures, "; "))
	}
	return nil
}

// relaxTree は path 配下のディレクトリへ書き込み権を付け直す。
//
// **失敗は無視する。** ここは RemoveAll の再試行を成立させるための最善努力であり、
// 消せたかどうかの判定は呼び出し側の RemoveAll が行う。ここで早期に返すと、
// 1 つ緩められないディレクトリのせいで残り全部の緩和を諦めることになる。
//
// **リンクへは chmod しない。** WalkDir は Lstat で見るので、シンボリックリンクに
// 対する d.IsDir() は false になり、リンク先の権限を書き換える経路ができない。
func relaxTree(path string) {
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// 読めないディレクトリでも、緩めれば読めるようになることがある。
			// 緩めてから SkipDir せずに続ける（WalkDir は緩和後の再読み込みを
			// しないため、次の RemoveAll に任せる）。
			_ = os.Chmod(p, 0o700)
			return nil
		}
		if d.IsDir() {
			_ = os.Chmod(p, 0o700)
		}
		return nil
	})
}

// NewInvocationDir は呼び出しごとに一意な作業ディレクトリを掘る（7.1 の実装要件）。
//
// 7.1 は「**呼び出しごとに一意のディレクトリを掘り、ハンドラ先頭で掃除する**」ことを
// 実装の要件としている。掃除だけでは足りないのは、同時実行が同じ実行環境を共有する
// 場面（Lambda では起きない前提だが、機構として担保しない理由が無い）と、
// 名前の衝突で前回の残骸を掴む事故を潰すためである。
func NewInvocationDir(root string) (string, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("作業領域を作成できません (%s): %w", root, err)
	}
	dir, err := os.MkdirTemp(root, "inv-")
	if err != nil {
		return "", fmt.Errorf("呼び出し用のディレクトリを作成できません: %w", err)
	}
	return dir, nil
}
