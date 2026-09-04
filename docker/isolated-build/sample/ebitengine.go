// 隔離ビルドの検査に使う Ebitengine のサンプル（M2-4 / #18）。
//
// **許可パッケージ（`src/go-import-allowlist.ts`）のうち、標準ライブラリ以外を
// すべて import する。** vendor 焼き込みが実際に効いているかは、これを
// `--network=none` でビルドして初めて分かる。標準ライブラリだけのサンプルでは、
// vendor が空でも成功してしまう。
//
// **`gameforge.local/sandbox/jpfont` は外部モジュールではない**（テンプレート自身の
// パッケージで、vendor に入らない。#285）。それでもここへ入れるのは理由が違う——
// あれは**イメージへ焼き込んだテンプレートの一部**であり、Dockerfile の `COPY template/`
// が取りこぼしていれば `--network=none` のビルドで初めて分かる。**焼き込んだものが
// 実際にコンパイルできることを、配る現物のイメージで確かめる**という点は同じである。
//
// **`github.com/hajimehoshi/ebiten/v2/audio` は外部モジュールである**（#286）。
// ebiten 本体の依存には無いものを 1 つ引き込む（`github.com/ebitengine/oto/v3`）ため、
// **vendor の焼き込みが実際に効いているかは、これを `--network=none` でビルドして初めて
// 分かる。**
//
// ゲームとして面白い必要はない。**各パッケージの代表的な API を 1 つずつ触る**ことだけが
// 目的で、リンカに落とされずに実際に連結されることを保証する。
//
// **basicfont の使用はここから外さない。** `test/system-prompt.test.ts` が
// 「5 節が教える API の形は、隔離ビルドで実際にコンパイルが通ったサンプルと一致する」
// を機械照合しており、`text.NewGoXFace(basicfont.Face7x13)` はその照合対象である。
// 日本語のフォントは**足す**のであって、置き換えるのではない（#285 の scope.out に
// 「basicfont の削除」がある。既存作品のフォークが壊れる）。

package main

import (
	"errors"
	"image/color"
	"math"
	"strconv"

	"gameforge.local/sandbox/jpfont"
	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/audio"
	"github.com/hajimehoshi/ebiten/v2/inpututil"
	"github.com/hajimehoshi/ebiten/v2/text/v2"
	"github.com/hajimehoshi/ebiten/v2/vector"
	"golang.org/x/image/font/basicfont"
)

const sampleRate = 48000

// 合成した矩形波（#286）。**`io` を import しない**——`Read` を生やすだけなら `io` の型は
// 要らず、終わりの無いストリームなので `io.EOF` も返さない。**これがビルドで確かめたい
// ことの 1 つである**（許可リストへ `io` を足していないので、足さずに音が鳴らせることは
// 実際にコンパイルして初めて分かる）。
//
// **32bit float で作る**（`NewPlayerF32` に合わせる）。ebiten は「新しいコードは
// `NewPlayerF32` が望ましい。将来は内部で 32bit float だけを扱う」と明記しており、
// int16 版を教えると、それが外れた日に**既に生成された作品のフォークが壊れる**
// （フォークは親ソースを現物のイメージで再コンパイルする）。
//
// `math.Float32bits` でリトルエンディアンへ並べる。**`encoding/binary` も `unsafe` も
// 許可リストに無いので、この経路しかない**——それが実際に書けることを、配る現物の
// イメージで確かめる。
type tone struct {
	freq  float64
	vol   float64
	phase float64
}

func (t *tone) Read(buf []byte) (int, error) {
	n := len(buf) / 8 * 8
	step := t.freq / float64(sampleRate)
	for i := 0; i < n; i += 8 {
		level := float32(t.vol)
		if math.Mod(t.phase, 1) >= 0.5 {
			level = -level
		}
		bits := math.Float32bits(level)
		buf[i] = byte(bits)
		buf[i+1] = byte(bits >> 8)
		buf[i+2] = byte(bits >> 16)
		buf[i+3] = byte(bits >> 24)
		buf[i+4] = buf[i]
		buf[i+5] = buf[i+1]
		buf[i+6] = buf[i+2]
		buf[i+7] = buf[i+3]
		t.phase += step
	}
	return n, nil
}

type Game struct {
	x, y         float64
	score        int
	face         *text.GoXFace
	jpFace       *text.GoXFace
	audioContext *audio.Context
	player       *audio.Player
}

func (g *Game) Update() error {
	if inpututil.IsKeyJustPressed(ebiten.KeyEscape) {
		return ebiten.Termination
	}
	// **最初の入力より前に鳴らさない**（#286）。ブラウザは利用者の操作より前に音を
	// 鳴らさず、OGP は初回フレームを撮るだけなので、ここに依存する進行を書かない。
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) && g.audioContext.IsReady() {
		g.player.Play()
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

	// 日本語のフォント（#285）。半角と全角で送り幅が違うので、**両方を含む文字列**を
	// 描いて自前の font.Face 実装を実際に通す。
	//
	// **収録外の文字（漢字）も 1 つ混ぜる。** 代替の升目（枠に×）を組み立てる経路まで
	// 含めて、配る現物のイメージでコンパイルと連結を確かめる。
	jp := &text.DrawOptions{}
	jp.GeoM.Translate(8, 24)
	text.Draw(screen, "スコア "+strconv.Itoa(g.score)+" てん 漢", g.jpFace, jp)
}

func (g *Game) Layout(int, int) (int, int) { return 320, 240 }

func main() {
	audioContext := audio.NewContext(sampleRate)
	player, err := audioContext.NewPlayerF32(&tone{freq: 440, vol: 0.2})
	if err != nil {
		panic(err)
	}
	g := &Game{
		face:         text.NewGoXFace(basicfont.Face7x13),
		jpFace:       text.NewGoXFace(jpfont.Face16),
		audioContext: audioContext,
		player:       player,
	}
	ebiten.SetWindowSize(640, 480)
	if err := ebiten.RunGame(g); err != nil && !errors.Is(err, ebiten.Termination) {
		panic(err)
	}
}
