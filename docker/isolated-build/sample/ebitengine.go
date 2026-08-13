// 隔離ビルドの検査に使う Ebitengine のサンプル（M2-4 / #18）。
//
// **許可パッケージ（`src/go-import-allowlist.ts`）のうち、標準ライブラリ以外の
// 5 つをすべて import する。** vendor 焼き込みが実際に効いているかは、これを
// `--network=none` でビルドして初めて分かる。標準ライブラリだけのサンプルでは、
// vendor が空でも成功してしまう。
//
// ゲームとして面白い必要はない。**各パッケージの代表的な API を 1 つずつ触る**ことだけが
// 目的で、リンカに落とされずに実際に連結されることを保証する。

package main

import (
	"errors"
	"image/color"
	"math"
	"strconv"

	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/inpututil"
	"github.com/hajimehoshi/ebiten/v2/text/v2"
	"github.com/hajimehoshi/ebiten/v2/vector"
	"golang.org/x/image/font/basicfont"
)

type Game struct {
	x, y  float64
	score int
	face  *text.GoXFace
}

func (g *Game) Update() error {
	if inpututil.IsKeyJustPressed(ebiten.KeyEscape) {
		return ebiten.Termination
	}
	if ebiten.IsKeyPressed(ebiten.KeyRight) {
		g.x += 2
		g.score++
	}
	g.y = 120 + 40*math.Sin(g.x/30)
	if g.x > 320 {
		g.x = 0
	}
	return nil
}

func (g *Game) Draw(screen *ebiten.Image) {
	vector.DrawFilledRect(screen, float32(g.x), float32(g.y), 16, 16, color.RGBA{0x33, 0xcc, 0x99, 0xff}, true)
	op := &text.DrawOptions{}
	op.GeoM.Translate(8, 8)
	text.Draw(screen, "SCORE "+strconv.Itoa(g.score), g.face, op)
}

func (g *Game) Layout(int, int) (int, int) { return 320, 240 }

func main() {
	g := &Game{face: text.NewGoXFace(basicfont.Face7x13)}
	ebiten.SetWindowSize(640, 480)
	if err := ebiten.RunGame(g); err != nil && !errors.Is(err, ebiten.Termination) {
		panic(err)
	}
}
