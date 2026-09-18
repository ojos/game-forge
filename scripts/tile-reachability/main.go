// tile-reachability — タイル地図で面を組む作品について、スタート → カギ → ゴールに届くかを判定する（#675）。
//
// **入口は scripts/tile-reachability.sh である**（作品 id を渡すと本番の D1 / R2 から読み取りだけでソースを取る）。
// ここはソースのパスを受け取り、オフラインで判定する。
//
//	go run ./scripts/tile-reachability [--json] <source.go> [...]
//
// 利用者の決定（2026-09-18。仕様 6.1 の #675 注記）: 判定は運営の手元のスクリプトで動かす。本番のパイプラインにも
// source_quality_metrics にも入れず、**生成の失敗としては扱わない**（当面は人が見る）。
//
// 取り出し方と「判定しない」条件は extract.go の冒頭、判定は judge.go の冒頭。
//
// **生成物のコードを手元で動かす道具である。** 動かすのは地図を組み立てる関数とそれが参照する宣言だけで、
// ゲームループ・描画・main は動かさない。import は標準ライブラリの計算系（extract.go の allowedImports）に限り、
// それ以外へ届く作品は動かさずに「判定しない」とする。無限ループには時間の上限を掛けるが、メモリの上限は掛けない。
//
// 終了コード: 0 = 全部の面で届く / 1 = 届かない面がある / 2 = 使い方の誤り・道具の不具合 / 3 = 判定しない（1 本でも）
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
)

const tag = "[tile-reachability]"

// Report は 1 本のソースの判定である。
type Report struct {
	Source     string            `json:"source"`
	Verdict    string            `json:"verdict"` // reachable / unreachable / skipped
	SkipReason string            `json:"skipReason,omitempty"`
	Rooms      []Room            `json:"rooms,omitempty"`
	Names      map[string]string `json:"extractedFrom,omitempty"`
}

// Check は 1 本のソースを判定する。「判定しない」は Verdict = skipped で返し、error は道具の不具合だけに使う。
func Check(ctx context.Context, name string, src []byte) (Report, error) {
	rep := Report{Source: name}
	ex, err := Extract(ctx, src)
	if err == nil {
		rep.Names = ex.Names
		rep.Rooms, err = Judge(ex)
	}
	var skip *SkipError
	switch {
	case errors.As(err, &skip):
		rep.Verdict = "skipped"
		rep.SkipReason = skip.Reason
		rep.Rooms = nil
		return rep, nil
	case err != nil:
		return rep, err
	}
	rep.Verdict = "reachable"
	for _, r := range rep.Rooms {
		if !r.Playable {
			rep.Verdict = "unreachable"
		}
	}
	return rep, nil
}

// UnreachableRooms は届かない面の番号（1 から）を返す。
func (r Report) UnreachableRooms() []int {
	var out []int
	for _, room := range r.Rooms {
		if !room.Playable {
			out = append(out, room.Room)
		}
	}
	return out
}

// DecorativeDoors は扉が飾りの面の番号（1 から）を返す。
func (r Report) DecorativeDoors() []int {
	var out []int
	for _, room := range r.Rooms {
		if room.DoorDecorative {
			out = append(out, room.Room)
		}
	}
	return out
}

func main() {
	asJSON := flag.Bool("json", false, "判定を JSON で出す")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "使い方: go run ./scripts/tile-reachability [--json] <source.go> [...]\n")
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	ctx := context.Background()
	code := 0
	var reports []Report
	for _, path := range flag.Args() {
		src, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s %s を読めない: %v\n", tag, path, err)
			os.Exit(2)
		}
		rep, err := Check(ctx, path, src)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s %s: 道具の不具合: %v\n", tag, path, err)
			os.Exit(2)
		}
		reports = append(reports, rep)
		switch rep.Verdict {
		case "skipped":
			code = 3
		case "unreachable":
			if code == 0 {
				code = 1
			}
		}
		if *asJSON {
			continue
		}
		switch rep.Verdict {
		case "skipped":
			fmt.Printf("%s %s: 判定しない — %s\n", tag, path, rep.SkipReason)
			continue
		case "unreachable":
			fmt.Printf("%s %s: 届かない面がある（面 %v）\n", tag, path, rep.UnreachableRooms())
		default:
			fmt.Printf("%s %s: 全部の面で届く\n", tag, path)
		}
		if d := rep.DecorativeDoors(); len(d) > 0 {
			fmt.Printf("%s   扉が道を塞いでいない面: %v\n", tag, d)
		}
		for _, room := range rep.Rooms {
			fmt.Printf("%s   %s\n", tag, room.Describe())
		}
		fmt.Printf("%s   取り出し元: 地図=%s 組み立て=%s カギ=%s 扉=%s ゴール=%s スタート=%s\n", tag,
			rep.Names["map"], orDash(rep.Names["builder"]), rep.Names["key"], orDash(rep.Names["door"]), rep.Names["exit"], startSource(rep.Names))
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(reports); err != nil {
			os.Exit(2)
		}
	}
	os.Exit(code)
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func startSource(names map[string]string) string {
	if s := names["start"]; s != "" {
		return s
	}
	return "自機の位置への定数の代入（÷" + names["tileSize"] + "）"
}
