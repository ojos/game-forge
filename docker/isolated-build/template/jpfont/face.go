// Package jpfont は、DotGothic16 を 16×16 のビットマップへ焼いた日本語フォントを
// golang.org/x/image/font の font.Face として提供する（#285）。
//
// 使い方（生成コードから見える形はこれだけである）:
//
//	face := text.NewGoXFace(jpfont.Face16)
//	text.Draw(screen, "こんにちは", face, op)
//
// text.NewGoXFace は `func NewGoXFace(face font.Face) *GoXFace` で、
// **golang.org/x/image/font のインターフェース**を受ける。basicfont.Face に限定されない。
//
// # なぜ basicfont.Face を使わないか
//
// **半角と全角で送り幅が違うからである。** basicfont.Face は Advance / Width / Height /
// Ascent / Descent / Left をすべて **Face 単位**で持ち、Range は Low / High / Offset しか
// 持たない。公式ドキュメントも「a basic font face's glyphs all have the same metrics」と
// 書いている。**送り幅をグリフ単位で返す口が無い**ので、このフォントは表せない
// （#285 の 2026-09-04 のコメントで確認済み）。
//
// 全部を全角 16 幅に揃えれば basicfont.Face でも表せるが、**ASCII まで 16px 幅になり
// 1 行に入る文字数が半分になる**ため採らない。
//
// # 収録範囲と、収録外の文字の扱い
//
// ASCII / 半角カタカナ ＋ JIS X 0208 の非漢字部（1〜8 区）。**漢字は入っていない。**
//
// **収録外の文字には、代替の升目（枠に×）を描いて全角ぶんの送り幅を取る。**
// font.Face の慣習どおり ok=false を返すと、text/v2 の GoXFace は**そのグリフを
// 描かず、送り幅も 0 にして詰めて進む**——つまり漢字混じりの文字列は、画面から
// 黙って消える。**作者には原因が分からない。**
//
// **プロンプトを防御と数えない**（仕様）以上、「漢字を使わない」と書いたうえで
// それが守られなかったときに、**作者が画面を見て気づき、修正で直せる**状態にする。
// 消えるより、出ているほうがよい。
//
// 代替の形は **12×12 の枠に対角線 2 本（×）** で、glyphs_gen.go には入れず
// notdefRows() がコードで組み立てる（フォントに □ があるかどうかに依存しない）。
// **実在する □（U+25A1）と紛れない形にしてある**——あちらは 14 ドット幅・行 0〜13 で
// 対角線を持たない。同じ見た目にすると、作者が「自分が □ と書いた」と誤解する。
//
// **目に見えない文字（制御・空白・書式）だけは従来どおり ok=false を返す。**
// 改行やノーブレークスペースに代替を描くと、見えない文字のところに枠が並ぶ。
//
// # データの持ち方
//
// グリフは glyphs_gen.go が 1 グリフ 32 バイト（16 行 × 16 ビット）の文字列定数で持つ。
// **font.Face は image.Image のマスクを返す約束**なので、初回の Glyph 呼び出しで
// image.Alpha へ展開する（basicfont.Face が Mask をあらかじめ持っているのと同じ形）。
// バイナリへ焼くのは詰めた 22KB のほうで、展開した 177KB は実行時のヒープにしか無い。
package jpfont

import (
	"image"
	"sync"
	"unicode"

	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
)

// Face16 は 16×16 に焼いた DotGothic16 の font.Face。
//
// **サイズを選ぶ口を持たない。** アウトラインではなくビットマップなので、16 以外を
// 指定できること自体が「ドットが滲む」経路になる（#285 の「焼く形にした理由」）。
var Face16 font.Face = &bitmapFace{}

// bitmapFace は font.Face の実装（Close / Glyph / GlyphBounds / GlyphAdvance /
// Kern / Metrics の 6 メソッド）。
type bitmapFace struct {
	once sync.Once
	mask *image.Alpha
}

// Close は font.Face の実装。持っているのは焼いたビットマップだけで、
// 解放するものが無い。
func (f *bitmapFace) Close() error { return nil }

// Metrics は font.Face の実装。**すべて升目そのものの値である**（ascent と descent の
// 和が升目の高さに一致する）。焼いた時点で 16px 固定なので、実測した値をそのまま返す。
func (f *bitmapFace) Metrics() font.Metrics {
	return font.Metrics{
		Height:     fixed.I(cellHeight),
		Ascent:     fixed.I(ascentPx),
		Descent:    fixed.I(descentPx),
		XHeight:    fixed.I(xHeightPx),
		CapHeight:  fixed.I(capHeightPx),
		CaretSlope: image.Point{X: 0, Y: 1},
	}
}

// Kern は font.Face の実装。**カーニングは持たない。** 焼いたのは等幅（半角 8 / 全角 16）の
// ビットマップで、字間を詰める前提の字形ではない。
func (f *bitmapFace) Kern(r0, r1 rune) fixed.Int26_6 { return 0 }

// GlyphAdvance は font.Face の実装。**グリフごとに違う**（半角 8 / 全角 16）。
func (f *bitmapFace) GlyphAdvance(r rune) (fixed.Int26_6, bool) {
	i, ok := lookup(r)
	if !ok {
		return 0, false
	}
	return advanceOf(i), true
}

// GlyphBounds は font.Face の実装。
//
// **墨の範囲ではなく升目の範囲を返す。** 升目は 16×16 に固定で、外へはみ出す墨は無い
// （焼く工程が検出して報告する）。text/v2 の GoXFace はこの矩形の大きさで
// グリフ画像を確保し、Min の位置へ置く——升目より広く返しても、余った所は透明のまま
// 描かれるだけで、見た目は変わらない。
func (f *bitmapFace) GlyphBounds(r rune) (fixed.Rectangle26_6, fixed.Int26_6, bool) {
	i, ok := lookup(r)
	if !ok {
		return fixed.Rectangle26_6{}, 0, false
	}
	return fixed.R(0, -ascentPx, cellWidth, cellHeight-ascentPx), advanceOf(i), true
}

// Glyph は font.Face の実装。
//
// dot（ベースライン上のペン位置）を整数へ丸めてから升目を置く。**丸め方は
// basicfont.Face と同じ** `int(dot.X+32)>>6`（四捨五入。負でも切り捨て方向が
// 揃うよう算術シフトを使う）。ここがずれると、同じ文字列が x 座標によって
// 1px 動いて見える。
func (f *bitmapFace) Glyph(dot fixed.Point26_6, r rune) (
	dr image.Rectangle, mask image.Image, maskp image.Point, advance fixed.Int26_6, ok bool,
) {
	i, ok := lookup(r)
	if !ok {
		return image.Rectangle{}, nil, image.Point{}, 0, false
	}
	x := int(dot.X+32) >> 6
	y := int(dot.Y+32) >> 6
	dr = image.Rectangle{
		Min: image.Point{X: x, Y: y - ascentPx},
		Max: image.Point{X: x + cellWidth, Y: y - ascentPx + cellHeight},
	}
	return dr, f.maskImage(), image.Point{Y: i * cellHeight}, advanceOf(i), true
}

// maskImage は、詰めた glyphBits を image.Alpha へ展開して返す（初回だけ）。
//
// 全グリフを縦に並べた 1 枚にする。**Glyph が返したマスクは、呼び出し側が
// 使い終わるまで生きていなければならない**ので、呼び出しごとに使い回す 1 枚では
// 足りない（text/v2 の GoXFace はグリフ画像をキャッシュする）。
func (f *bitmapFace) maskImage() *image.Alpha {
	f.once.Do(func() {
		// **升目を 1 つ多く取る。** 最後の 1 枚が収録外の文字へ描く代替（notdefIndex）で、
		// glyphs_gen.go には無く、ここで組み立てる。
		n := len(runeList)
		m := &image.Alpha{
			Pix:    make([]uint8, cellWidth*cellHeight*(n+1)),
			Stride: cellWidth,
			Rect:   image.Rect(0, 0, cellWidth, cellHeight*(n+1)),
		}
		paint := func(i, row int, bits uint16) {
			base := (i*cellHeight + row) * cellWidth
			for col := 0; col < cellWidth; col++ {
				if bits&(1<<uint(cellWidth-1-col)) != 0 {
					m.Pix[base+col] = 0xff
				}
			}
		}
		for i := 0; i < n; i++ {
			for row := 0; row < cellHeight; row++ {
				off := (i*cellHeight + row) * 2
				paint(i, row, uint16(glyphBits[off])<<8|uint16(glyphBits[off+1]))
			}
		}
		for row, bits := range notdefRows() {
			paint(n, row, bits)
		}
		f.mask = m
	})
	return f.mask
}

// notdefIndex は代替の升目の添字。**収録した表の 1 つ後ろ**に置く。
const notdefIndex = len(runeList)

// lookup は符号位置から升目の添字を引く。
//
// **収録外なら代替の升目を返し、ok=true にする**（理由はこのファイルの冒頭）。
//
// **例外は「そもそも目に見えない文字」だけ**で、これは従来どおり ok=false を返す。
// 改行・タブ（制御）、ノーブレークスペース（空白）、書式指定（BOM など）に×を描くと、
// **見えない文字のところに枠が並ぶ**——原因を示すどころか、作者が書いていない物を
// 画面へ出すことになる。なお U+0020 と U+3000 は収録済みなので、ここへは来ない。
func lookup(r rune) (int, bool) {
	if i, ok := index(r); ok {
		return i, true
	}
	if unicode.IsControl(r) || unicode.IsSpace(r) || unicode.In(r, unicode.Cf) {
		return 0, false
	}
	return notdefIndex, true
}

// advanceOf は升目の添字から送り幅を返す。
//
// **代替の升目は全角ぶん（16）を取る。** 送り幅 0 で詰めると、収録外の文字が
// 混じった行だけレイアウトが崩れ、原因が読み取れなくなる。
func advanceOf(i int) fixed.Int26_6 {
	if i == notdefIndex {
		return fixed.I(cellWidth)
	}
	return fixed.I(int(advances[i]))
}

// notdefRows は代替の升目を**データではなくコードで**組み立てる。
//
// 形は **12×12 の枠に対角線 2 本（×）**。行 2〜13・列 2〜13 に置く。
//
// **実在する □（U+25A1）と紛れないことが要件である。** あちらは列 1〜14・行 0〜13 の
// 14×14 で、対角線を持たない。こちらは一回り小さく内側へ寄っており、×が入る。
// ×を選んだのは、**「その文字が無い」ことを表す印として広く使われている**からで、
// 単独の斜線（⧄）より「欠落」だと読み取りやすい。
//
// **glyphs_gen.go へ焼かないのは、フォントに □ があるかどうかへ依存させないため**である。
// 収録範囲を変えて焼き直しても、この升目は変わらない。
func notdefRows() [cellHeight]uint16 {
	const (
		top, bottom = 2, 13
		left, right = 2, 13
	)
	var rows [cellHeight]uint16
	set := func(y, x int) { rows[y] |= 1 << uint(cellWidth-1-x) }
	for x := left; x <= right; x++ {
		set(top, x)
		set(bottom, x)
	}
	for y := top; y <= bottom; y++ {
		set(y, left)
		set(y, right)
	}
	for i := 0; i < bottom-top-1; i++ {
		set(top+1+i, left+1+i)
		set(top+1+i, right-1-i)
	}
	return rows
}

// index は符号位置から glyphBits / advances の添字を引く。
// runeList は昇順なので二分探索する（**表は 692 件あり、線形に舐めると
// 1 文字ごとに走る**）。
func index(r rune) (int, bool) {
	lo, hi := 0, len(runeList)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		switch {
		case runeList[mid] < r:
			lo = mid + 1
		case runeList[mid] > r:
			hi = mid
		default:
			return mid, true
		}
	}
	return 0, false
}
