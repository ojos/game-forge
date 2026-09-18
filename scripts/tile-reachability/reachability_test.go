package main

// 仕込み（testdata/）:
//
//   - v1-fdcb7cf3.go.txt / v2-6d9fc343.go.txt / v3-7e063858.go.txt — 作品 911782d6「ネズミのカギ」の 3 版。
//     本番の R2 の builds/<sha256>/source.go をそのまま写したもの（運営アカウントの生成物）。拡張子を .txt に
//     しているのは、Go の道具や検査に「このモジュールのソース」として拾わせないため（ebiten を import している）。
//   - skip-*.go.txt — 取り出せない作品。「判定しない」になることを見る。
//   - rowcol-startpos.go.txt — 取り出し方の幅を見る合成の仕込み（座標が (行, 列)、スタートが配列、init() で組む）。
//
// 期待値は issue #675 の実測の表（使い捨ての Python の判定）と同じ。座標での照合は各テストの注記。

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func check(t *testing.T, name string) Report {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	rep, err := Check(context.Background(), name, src)
	if err != nil {
		t.Fatalf("道具の不具合: %v", err)
	}
	return rep
}

func room(t *testing.T, rep Report, n int) Room {
	t.Helper()
	for _, r := range rep.Rooms {
		if r.Room == n {
			return r
		}
	}
	t.Fatalf("面 %d が無い: %+v", n, rep)
	return Room{}
}

func ints(xs ...int) []int { return xs }

// 版 1: 2・3 面に届かない。
func TestVersion1_Rooms2And3Unreachable(t *testing.T) {
	rep := check(t, "v1-fdcb7cf3.go.txt")
	if rep.Verdict != "unreachable" {
		t.Fatalf("判定 = %s（%s）, 届かない面があるはず", rep.Verdict, rep.SkipReason)
	}
	if got := rep.UnreachableRooms(); !reflect.DeepEqual(got, ints(2, 3)) {
		t.Fatalf("届かない面 = %v, want [2 3]", got)
	}
	// 2 面: カギ (14,7) には届くが、ゴール (19,7) は左 (18,7) が壁で、上下は外周の壁（囲まれている）。
	r2 := room(t, rep, 2)
	if !r2.KeyReachable || r2.ExitReachableWithKey || r2.ExitReachableIfKey {
		t.Fatalf("2 面: %+v", r2)
	}
	// 3 面: ゴール (10,14) の区画（列 8〜11 × 行 12〜13）が閉じている。加えて、カギ (9,11) は壁のマスの上
	// （walls2 に {9,11} がある。issue の表には書かれていない 2 つ目の壊れ方）。
	r3 := room(t, rep, 3)
	if r3.KeyReachable || !r3.KeyOnWall || r3.ExitReachableIfKey {
		t.Fatalf("3 面: %+v", r3)
	}
	// 1 面は遊べる（ただし扉 (9,0) はゴール (10,0) の隣の外周にあり、道を塞いでいない）。
	if r1 := room(t, rep, 1); !r1.Playable || !r1.DoorDecorative {
		t.Fatalf("1 面: %+v", r1)
	}
}

// 版 2: 届く。ただし 1・2 面の扉は道を塞がない。
func TestVersion2_ReachableWithDecorativeDoors(t *testing.T) {
	rep := check(t, "v2-6d9fc343.go.txt")
	if rep.Verdict != "reachable" {
		t.Fatalf("判定 = %s（%s） / 届かない面 %v, 全部届くはず", rep.Verdict, rep.SkipReason, rep.UnreachableRooms())
	}
	if got := rep.DecorativeDoors(); !reflect.DeepEqual(got, ints(1, 2)) {
		t.Fatalf("扉が飾りの面 = %v, want [1 2]", got)
	}
	// 3 面の扉 (9,13) はゴール (10,14) への唯一の道を塞いでいる。
	if r3 := room(t, rep, 3); r3.DoorDecorative || r3.ExitReachableClosed == nil || *r3.ExitReachableClosed {
		t.Fatalf("3 面: %+v", r3)
	}
}

// 版 3: 1 面に届かない（自機とカギが壁に閉じ込められる。カギが壁のマスの上）。
func TestVersion3_Room1Unreachable(t *testing.T) {
	rep := check(t, "v3-7e063858.go.txt")
	if rep.Verdict != "unreachable" {
		t.Fatalf("判定 = %s（%s）, 届かない面があるはず", rep.Verdict, rep.SkipReason)
	}
	if got := rep.UnreachableRooms(); !reflect.DeepEqual(got, ints(1)) {
		t.Fatalf("届かない面 = %v, want [1]", got)
	}
	// スタート (2,2) は、行 5 の横の壁と列 7 の縦の壁に囲まれた 列 1〜6 × 行 1〜4 の 24 マスから出られない。
	// カギ (5,5) は行 5 の横の壁の上。
	r1 := room(t, rep, 1)
	if r1.StartArea != 24 || !r1.KeyOnWall || r1.KeyReachable {
		t.Fatalf("1 面: %+v", r1)
	}
	if got := rep.DecorativeDoors(); len(got) != 0 {
		t.Fatalf("扉が飾りの面 = %v, 無いはず", got)
	}
}

// 地図を取り出せない作品では「判定しない」になる（推測で判定しない）。
func TestSkipWhenMapCannotBeExtracted(t *testing.T) {
	cases := []struct {
		file, reason string
	}{
		{"skip-random.go.txt", "乱数"},             // 地図を実行時に乱数で作る（issue の scope.out）
		{"skip-nomap.go.txt", "地図の配列"},           // 地図の無いゲーム
		{"skip-ebiten-builder.go.txt", "ebiten"}, // 組み立てる関数が描画に触る（手元で動かさない）
		{"skip-order.go.txt", "列か行か"},            // 座標の並びを決められない
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			rep := check(t, c.file)
			if rep.Verdict != "skipped" {
				t.Fatalf("判定 = %s, 判定しないはず: %+v", rep.Verdict, rep)
			}
			if !strings.Contains(rep.SkipReason, c.reason) {
				t.Fatalf("理由 = %q, %q を含むはず", rep.SkipReason, c.reason)
			}
			if len(rep.Rooms) != 0 {
				t.Fatalf("判定しないのに面の判定がある: %+v", rep.Rooms)
			}
		})
	}
}

// 取り出し方の幅: 座標が (行, 列) の順、スタートが配列、地図を init() で組む作品。
func TestRowColOrderAndStartArray(t *testing.T) {
	rep := check(t, "rowcol-startpos.go.txt")
	if rep.Verdict != "unreachable" {
		t.Fatalf("判定 = %s（%s）", rep.Verdict, rep.SkipReason)
	}
	r1 := room(t, rep, 1)
	if !r1.Playable || r1.DoorDecorative || r1.Key != [2]int{5, 1} || r1.Exit != [2]int{5, 4} {
		t.Fatalf("1 面: %+v", r1)
	}
	// 2 面: カギ (列 1, 行 4) が扉の向こう。扉を閉じたままではカギに届かない。
	r2 := room(t, rep, 2)
	if r2.KeyReachable || r2.KeyOnWall || !r2.ExitReachableIfKey {
		t.Fatalf("2 面: %+v", r2)
	}
}
