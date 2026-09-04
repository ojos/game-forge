// fontbake — DotGothic16 を 16×16 のビットマップへ焼き、Go ソースとして出力する（#285）。
//
// ## 位置づけ: 開発時に 1 回だけ走らせる工程である
//
// **イメージのビルドには含めない。** 出力した Go ソース
// （docker/isolated-build/template/jpfont/glyphs_gen.go）をコミットし、隔離ビルドは
// それを読むだけにする。こうすると **subset ツールのような新しい依存をイメージへ
// 持ち込まない**（#285 の「なぜ焼く工程を Go で書くか」）。
//
// ## TTF はリポジトリへ入れない
//
// TTF は 2,069,236 バイトある。リポジトリが持つのは **URL と SHA-256 だけ**で、
// 実行時に取得して検証する。取得元は fontworks-fonts/DotGothic16 の**タグ**であって
// ブランチではない（master を指すと、同じコマンドが別の日に別の物を焼く）。
//
// ## 使い方
//
//	cd tools/fontbake && go run .              # 取得して焼く
//	cd tools/fontbake && go run . -ttf FILE     # 取得済みの TTF を使う
//	cd tools/fontbake && go run . -out -        # 標準出力へ出す
//
// **リポジトリの直下に go.mod は無い**（ここは独立したモジュールである）。
// そのため `go run ./tools/fontbake` は動かず、このディレクトリへ移ってから起動する。
// -out の既定値もそれに合わせた相対パスにしてある。
//
// -ttf を与えても **SHA-256 の検証は省かない。** 検証を省ける経路があると、
// 「同じ URL・同じチェックサムから同じ Go ソースが出る」という受け入れ条件が
// 手元のファイル 1 つで破れる。
//
// ## 収録範囲（機械的に定義する）
//
//   - ASCII                     U+0020..U+007E
//   - JIS X 0201 の半角カタカナ  U+FF61..U+FF9F
//   - JIS X 0208 の非漢字部       1〜8 区（EUC-JP の 2 バイトを x/text で復号して得る）
//
// **漢字は入れない**（#285 の scope.out）。区点から Unicode への対応表をこのファイルへ
// 書き写さないのは、書き写した表が正本になってしまうためで、
// golang.org/x/text/encoding/japanese の復号器に引かせる。**未割り当ての区点は
// 復号が失敗するので、そのまま「入れない」判定になる。**
//
// これに加えて、**上で得た符号位置と同じグリフを指す符号位置**も収録する（withAliases）。
// 区点から Unicode への対応は実装によって 2 通りあり、波ダッシュのように
// **文章で使われるほうが漏れる**ためである。理由と、拾わない場合の壊れ方は
// withAliases の注記にある。
//
// ## ラスタライズ: なぜ「16px でそのまま焼く」だけでは済まないか
//
// DotGothic16 のアウトラインは **16 ドットの格子にきれいに乗っていない。**
// unitsPerEm は 1000 で、1 ドットは 62.5 単位になるが、座標は整数なので乗り切らない。
// 実測（2026-09-04）では、16ppem で素直にラスタライズすると 617 画素中 573 画素が
// 中間調になった。**そのまま閾値を掛けると、線の太さが 1px と 2px の間で暴れる。**
//
// 採ったのは次の形である。
//
//  1. **16 倍ではなく 8 倍の超解像でラスタライズし**、各ドットの被覆率を整数で数える。
//  2. **標本格子の副画素オフセット (ox, oy) を全数探索し**、被覆率が 0.25〜0.75 に
//     入る（＝どちらへ丸めても間違いに見える）ドットの総数が最小になる位置を選ぶ。
//  3. その位置で被覆率 50% 以上のドットを立てる。
//
// 探索は **全グリフを一括で見る。** グリフごとに最適な位置を選ぶと、隣り合う文字の
// 間で 1px の段差が出る（同じ「あ」の横線が行によって上下する）。
//
// **この探索は整数演算だけで行う。** 浮動小数の総和は加算順序で結果が動きうるため、
// 「同じ入力から同じ出力」を保証したい場所には置かない。
//
// ### 承知のうえで受け入れた限界: 罫線は隙間なく繋がらない
//
// **このフォントは 2 つの格子を混ぜて持っている**（2026-09-04 に実測）。
//
//   - かな・カナ・記号・ASCII は **em ボックスの格子**に乗る。em は 1000 単位で、
//     ベースラインから上が 914 単位（14.62 ドット）、下が 86 単位（1.38 ドット）。
//     **ベースラインの整数格子から 0.62 ドットずれている。** oy=3（0.375 ドット）が
//     最良なのはこれが理由で、探索は font の設計格子を当てているにすぎない。
//   - **罫線（8 区）だけはベースラインの整数格子に乗る。** U+2502 の墨は
//     ベースライン基準で −14.07〜+1.91 ドット、U+2500 は横に 0〜16 ドットちょうど。
//
// **2 つの格子は 0.62 ドット離れているので、どちらへ合わせても片方が崩れる。**
// 全体で選ぶと（692 対 32 なので）em ボックス側に倒れ、罫線は次のようになる。
//
//   - 横罫線が 2 ドット太くなる（1.17 ドットの線が 2 行にまたがる）。
//   - 縦罫線が升目の下端 1 ドットに届かず、**行を重ねると 1 ドットの隙間が空く。**
//     墨が 16.0 ドットあっても格子から 0.55 ドットずれているので、
//     16 升へ収める置き方が存在しない（閾値の取り方を変えても解けない）。
//   - ox=2 では U+2500 が右端 1 ドットに届かず、**横にも 1 ドットの継ぎ目が出る。**
//
// **枠を描くなら罫線ではなく vector（StrokeRect / DrawFilledRect）を使う**のが、
// このフォントに対する正しい使い方である。罫線だけ別のオフセットで焼く形は採らない
// ——「この区だけ特別扱いする」根拠が font 側に無く、例外を増やし続けることになる。
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
	"golang.org/x/text/encoding/japanese"
)

const (
	// 取得元。**ブランチではなくタグを指す**（上の注記）。
	fontURL = "https://raw.githubusercontent.com/fontworks-fonts/DotGothic16/Version1.101/fonts/ttf/DotGothic16-Regular.ttf"
	// fontURL が返すバイト列の SHA-256。ここが一致しなければ焼かない。
	fontSHA256 = "155da8f318553c11d9dffc2affbc7c2114c6a46f9740bcf639ed5568af92be71"

	// 1 グリフの升目。16×16 に固定する（#285。サイズの指定余地を無くすために焼く）。
	cellW = 16
	cellH = 16

	// 超解像の倍率。8 倍だと 1 ドットが 64 標本になり、被覆率を 1/64 刻みで数えられる。
	super = 8
	// 升目の外へ出た墨を検出するために取る余白（ドット単位）。
	margin = 4
)

func main() {
	ttfPath := flag.String("ttf", "", "取得済みの TTF を使う（SHA-256 の検証は省かない）")
	outPath := flag.String("out", "../../docker/isolated-build/template/jpfont/glyphs_gen.go", "出力先の Go ソース")
	flag.Parse()

	if err := run(*ttfPath, *outPath); err != nil {
		fmt.Fprintln(os.Stderr, "fontbake:", err)
		os.Exit(1)
	}
}

func run(ttfPath, outPath string) error {
	ttf, err := loadTTF(ttfPath)
	if err != nil {
		return err
	}

	baked, err := bake(ttf)
	if err != nil {
		return err
	}

	src := render(baked)
	if outPath == "-" {
		_, err := os.Stdout.WriteString(src)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(outPath, []byte(src), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr,
		"fontbake: %d グリフ / オフセット ox=%d oy=%d / ascent=%d / %s に %d バイト\n",
		len(baked.glyphs), baked.ox, baked.oy, baked.ascent, outPath, len(src))
	if len(baked.clipped) > 0 {
		fmt.Fprintf(os.Stderr, "fontbake: 升目の外へ出て切り落とされたグリフ %d 件: %s\n",
			len(baked.clipped), runeListString(baked.clipped))
	}
	if len(baked.missing) > 0 {
		fmt.Fprintf(os.Stderr, "fontbake: フォントに無かった符号位置 %d 件: %s\n",
			len(baked.missing), runeListString(baked.missing))
	}
	return nil
}

// loadTTF は TTF を取得し、SHA-256 を検証して返す。
func loadTTF(path string) ([]byte, error) {
	var raw []byte
	var err error
	if path != "" {
		raw, err = os.ReadFile(path)
		if err != nil {
			return nil, err
		}
	} else {
		raw, err = fetch(fontURL)
		if err != nil {
			return nil, err
		}
	}
	sum := sha256.Sum256(raw)
	got := hex.EncodeToString(sum[:])
	if got != fontSHA256 {
		return nil, fmt.Errorf("SHA-256 が一致しません\n  期待: %s\n  実際: %s", fontSHA256, got)
	}
	return raw, nil
}

func fetch(url string) ([]byte, error) {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// targetRunes は収録範囲を機械的に組み立てる（重複を除き、符号位置の昇順）。
func targetRunes() []rune {
	seen := map[rune]bool{}
	var out []rune
	add := func(r rune) {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	for r := rune(0x20); r <= 0x7e; r++ {
		add(r)
	}
	for r := rune(0xff61); r <= 0xff9f; r++ {
		add(r)
	}
	// JIS X 0208 の 1〜8 区。EUC-JP の 2 バイト（0xA0+区, 0xA0+点）を復号する。
	dec := japanese.EUCJP.NewDecoder()
	for ku := 1; ku <= 8; ku++ {
		for ten := 1; ten <= 94; ten++ {
			b, err := dec.Bytes([]byte{byte(0xa0 + ku), byte(0xa0 + ten)})
			if err != nil {
				continue // 未割り当ての区点
			}
			rs := []rune(string(b))
			if len(rs) != 1 || rs[0] == 0xfffd {
				continue
			}
			add(rs[0])
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// withAliases は、収録済みのグリフと**同じグリフ ID を指す別の符号位置**を足す。
//
// **区点から Unicode への対応は実装によって 2 通りある。** 代表例が 1-33 の波ダッシュで、
// x/text の復号器は U+FF5E を返すが、日本語の文章に現れるのは U+301C のほうが多い。
// 片方しか焼かないと、モデルが書いた「〜」が**何も描かれずに消える。**
//
// 対応表をここへ書き写すことはしない。書き写した表が正本になってしまううえ、
// 表の外の食い違いを取りこぼす。**フォントの cmap を正本にして、同じグリフを指す
// 符号位置を機械的に拾う。** 別のグリフを持つ文字（U+2212 と U+FF0D など）は
// 見た目が違うので、拾わないのが正しい。
func withAliases(f *sfnt.Font, buf *sfnt.Buffer, base []rune) []rune {
	inBase := make(map[rune]bool, len(base))
	byGlyph := map[sfnt.GlyphIndex]bool{}
	for _, r := range base {
		inBase[r] = true
		if i, err := f.GlyphIndex(buf, r); err == nil && i != 0 {
			byGlyph[i] = true
		}
	}
	out := append([]rune(nil), base...)
	// BMP を走査する。JIS X 0208 の非漢字部に対応する符号位置は BMP に収まる。
	for r := rune(0); r <= 0xffff; r++ {
		if inBase[r] {
			continue
		}
		i, err := f.GlyphIndex(buf, r)
		if err != nil || i == 0 || !byGlyph[i] {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

type glyph struct {
	r    rune
	adv  int // 送り幅（ドット）
	rows [cellH]uint16
}

type result struct {
	glyphs     []glyph
	ox, oy     int
	ascent     int
	capHeight  int
	xHeight    int
	clipped    []rune
	missing    []rune
	ambiguous  int
	unitsPerEm int
}

func bake(ttf []byte) (*result, error) {
	f, err := opentype.Parse(ttf)
	if err != nil {
		return nil, err
	}
	hi, err := opentype.NewFace(f, &opentype.FaceOptions{
		Size: cellW * super, DPI: 72, Hinting: font.HintingNone,
	})
	if err != nil {
		return nil, err
	}
	metric, err := opentype.NewFace(f, &opentype.FaceOptions{
		Size: cellW, DPI: 72, Hinting: font.HintingNone,
	})
	if err != nil {
		return nil, err
	}

	res := &result{unitsPerEm: int(f.UnitsPerEm())}
	var buf sfnt.Buffer

	// 標本の原点はベースライン。余白を取った升目 (margin*2+cellH) 行を用意し、
	// 行 margin+baseRow がベースラインの直上に来るようにして描く。
	const baseRow = cellH // 余白の中でのベースライン位置（ドット）
	canvasW := (cellW + 2*margin) * super
	canvasH := (cellH + 2*margin) * super

	type entry struct {
		r   rune
		adv int
		// 被覆の累積和（(canvasH+1) x (canvasW+1)）。矩形和を O(1) で引くために持つ。
		sat []int32
	}
	var entries []entry

	for _, r := range withAliases(f, &buf, targetRunes()) {
		idx, err := f.GlyphIndex(&buf, r)
		if err != nil || idx == 0 {
			res.missing = append(res.missing, r)
			continue
		}
		adv, ok := metric.GlyphAdvance(r)
		if !ok {
			res.missing = append(res.missing, r)
			continue
		}
		dst := image.NewAlpha(image.Rect(0, 0, canvasW, canvasH))
		d := font.Drawer{
			Dst:  dst,
			Src:  image.Opaque,
			Face: hi,
			Dot:  fixed.P(margin*super, (margin+baseRow)*super),
		}
		d.DrawString(string(r))

		sat := make([]int32, (canvasH+1)*(canvasW+1))
		for y := 0; y < canvasH; y++ {
			var rowSum int32
			for x := 0; x < canvasW; x++ {
				rowSum += int32(dst.Pix[y*dst.Stride+x])
				sat[(y+1)*(canvasW+1)+(x+1)] = sat[y*(canvasW+1)+(x+1)] + rowSum
			}
		}
		entries = append(entries, entry{r: r, adv: adv.Round(), sat: sat})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("収録対象のグリフが 1 つも取れませんでした")
	}

	sum := func(sat []int32, x, y int) int32 {
		// [x, x+super) × [y, y+super) の被覆の総和
		x0, y0, x1, y1 := x, y, x+super, y+super
		return sat[y1*(canvasW+1)+x1] - sat[y0*(canvasW+1)+x1] - sat[y1*(canvasW+1)+x0] + sat[y0*(canvasW+1)+x0]
	}
	const full = int32(super) * int32(super) * 255
	cellsX := cellW + 2*margin - 1
	cellsY := cellH + 2*margin - 1

	// 副画素オフセットの全数探索。曖昧なドット（被覆率 0.25〜0.75）が最小の位置を選ぶ。
	bestAmb, bestOx, bestOy := -1, 0, 0
	for oy := 0; oy < super; oy++ {
		for ox := 0; ox < super; ox++ {
			amb := 0
			for _, e := range entries {
				for cy := 0; cy < cellsY; cy++ {
					for cx := 0; cx < cellsX; cx++ {
						c := sum(e.sat, cx*super+ox, cy*super+oy)
						if c*4 > full && c*4 < full*3 {
							amb++
						}
					}
				}
			}
			if bestAmb < 0 || amb < bestAmb {
				bestAmb, bestOx, bestOy = amb, ox, oy
			}
		}
	}
	res.ox, res.oy, res.ambiguous = bestOx, bestOy, bestAmb

	// 選んだ位置で墨を立て、全グリフの墨の範囲から升目の縦位置（ascent）を決める。
	type inked struct {
		r    rune
		adv  int
		bits [][]bool // [cellsY][cellsX]
	}
	var all []inked
	top, bottom := cellsY, -1
	left, right := cellsX, -1
	for _, e := range entries {
		bits := make([][]bool, cellsY)
		for cy := 0; cy < cellsY; cy++ {
			bits[cy] = make([]bool, cellsX)
			for cx := 0; cx < cellsX; cx++ {
				c := sum(e.sat, cx*super+bestOx, cy*super+bestOy)
				if c*2 >= full {
					bits[cy][cx] = true
					if cy < top {
						top = cy
					}
					if cy > bottom {
						bottom = cy
					}
					if cx < left {
						left = cx
					}
					if cx > right {
						right = cx
					}
				}
			}
		}
		all = append(all, inked{r: e.r, adv: e.adv, bits: bits})
	}
	if bottom < 0 {
		return nil, fmt.Errorf("墨が 1 ドットもありません")
	}

	// 升目の左上を決める。横は原点（ペン位置）に合わせる——送り幅の起点と一致しないと
	// 文字が詰まる。縦は墨の上端に合わせ、収まらない分は下を切る。
	originX := margin
	if left < originX {
		originX = left
	}
	originY := top
	if bottom-originY >= cellH {
		// 16 行に収まらない。ベースラインを優先して上端から詰める。
		originY = bottom - cellH + 1
	}
	res.ascent = (margin + baseRow) - originY

	for _, g := range all {
		var rows [cellH]uint16
		clipped := false
		for cy := 0; cy < cellsY; cy++ {
			for cx := 0; cx < cellsX; cx++ {
				if !g.bits[cy][cx] {
					continue
				}
				y, x := cy-originY, cx-originX
				if y < 0 || y >= cellH || x < 0 || x >= cellW {
					clipped = true
					continue
				}
				rows[y] |= 1 << uint(cellW-1-x)
			}
		}
		if clipped {
			res.clipped = append(res.clipped, g.r)
		}
		res.glyphs = append(res.glyphs, glyph{r: g.r, adv: g.adv, rows: rows})
	}

	res.capHeight = inkHeight(res, 'H')
	res.xHeight = inkHeight(res, 'x')
	return res, nil
}

// inkHeight は、その文字の墨の上端がベースラインから何ドット上かを返す。
// font.Metrics の CapHeight / XHeight に焼き込む値で、焼いた結果そのものから採る。
func inkHeight(res *result, r rune) int {
	for _, g := range res.glyphs {
		if g.r != r {
			continue
		}
		for y := 0; y < cellH; y++ {
			if g.rows[y] != 0 {
				return res.ascent - y
			}
		}
	}
	return 0
}

func runeListString(rs []rune) string {
	var b strings.Builder
	for i, r := range rs {
		if i > 0 {
			b.WriteString(" ")
		}
		fmt.Fprintf(&b, "U+%04X", r)
	}
	return b.String()
}

// render は生成する Go ソースを組み立てる。
func render(res *result) string {
	var b bytes.Buffer
	fmt.Fprintf(&b, `// Code generated by tools/fontbake. DO NOT EDIT.
//
// DotGothic16 を 16×16 のビットマップへ焼いたもの（#285）。焼き方・収録範囲・
// 副画素オフセットを選ぶ理由は tools/fontbake/main.go の冒頭にある。
//
// 元データ:
//
//	%s
//	SHA-256 %s
//	unitsPerEm %d
//
// ライセンス: SIL Open Font License 1.1。
// Copyright 2020 The DotGothic16 Project Authors。
// 全文と著作権表示は third_party/dotgothic16/ にある（OFL の再配布条件）。
//
// 焼いた結果: %d グリフ / 副画素オフセット ox=%d/8 oy=%d/8 /
// 曖昧なドット %d 個 / ascent %d ドット。
package jpfont

const (
	cellWidth  = %d
	cellHeight = %d

	// ascentPx は升目の上端からベースラインまでのドット数。
	ascentPx  = %d
	descentPx = cellHeight - ascentPx

	capHeightPx = %d
	xHeightPx   = %d
)

`,
		fontURL, fontSHA256, res.unitsPerEm,
		len(res.glyphs), res.ox, res.oy, res.ambiguous, res.ascent,
		cellW, cellH, res.ascent, res.capHeight, res.xHeight)

	b.WriteString("// runeList は収録した符号位置。**昇順**で、glyphBits / advances と添字が対応する。\n")
	b.WriteString("var runeList = [...]rune{\n")
	for i, g := range res.glyphs {
		if i%8 == 0 {
			b.WriteString("\t")
		}
		fmt.Fprintf(&b, "0x%04x,", g.r)
		if i%8 == 7 || i == len(res.glyphs)-1 {
			b.WriteString("\n")
		} else {
			b.WriteString(" ")
		}
	}
	b.WriteString("}\n\n")

	b.WriteString("// advances は 1 グリフあたりの送り幅（ドット）。**半角と全角で違う。**\n")
	b.WriteString("// これが Face 単位ではなくグリフ単位であることが、basicfont.Face を使えない理由である。\n")
	b.WriteString("var advances = [...]uint8{\n")
	for i, g := range res.glyphs {
		if i%16 == 0 {
			b.WriteString("\t")
		}
		fmt.Fprintf(&b, "%d,", g.adv)
		if i%16 == 15 || i == len(res.glyphs)-1 {
			b.WriteString("\n")
		} else {
			b.WriteString(" ")
		}
	}
	b.WriteString("}\n\n")

	fmt.Fprintf(&b, "// glyphBits は 1 グリフ %d バイト（%d 行 × %d ビット、上位ビットが左）。\n",
		cellH*cellW/8, cellH, cellW)
	b.WriteString("const glyphBits = \"\" +\n")
	for i, g := range res.glyphs {
		b.WriteString("\t\"")
		for y := 0; y < cellH; y++ {
			fmt.Fprintf(&b, "\\x%02x\\x%02x", g.rows[y]>>8, g.rows[y]&0xff)
		}
		b.WriteString("\"")
		if i != len(res.glyphs)-1 {
			b.WriteString(" +")
		}
		fmt.Fprintf(&b, " // U+%04X\n", g.r)
	}
	return b.String()
}
