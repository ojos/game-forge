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

// 合成した矩形波（#286）。**`io` も `bytes` も import しない**——PCM は `[]byte` へ
// 自分で並べ、`NewPlayerF32FromBytes` へ渡すだけなので、どちらの型も要らない。
// **これがビルドで確かめたいことの 1 つである**（許可リストへ `io` を足していないので、
// 足さずに音が鳴らせることは実際にコンパイルして初めて分かる）。
//
// **32bit float で作る**（`NewPlayerF32FromBytes` に合わせる）。ebiten は「新しいコードは
// `NewPlayerF32` が望ましい。将来は内部で 32bit float だけを扱う」と明記しており、
// int16 版を教えると、それが外れた日に**既に生成された作品のフォークが壊れる**
// （フォークは親ソースを現物のイメージで再コンパイルする）。
//
// `math.Float32bits` でリトルエンディアンへ並べる。**`encoding/binary` も `unsafe` も
// 許可リストに無いので、この経路しかない**——それが実際に書けることを、配る現物の
// イメージで確かめる。
//
// **初期化時に 1 度だけ作り、鳴らすたびに player を作る形は #567 で入れた。** #301 までは
// 終わらない音源（自前の `Read` を持つ型）を player 1 つで流し続け、音源の位置を戻して
// 鳴らし直していた。oto v3.4.0 は音源を 0.5 秒ぶん先に読んで溜めるので、その形では
// **溜まった無音が流れ終わるまで効果音が約 0.5 秒遅れた。** 理由の全体は
// `src/system-prompt.ts` の #567 の節にある。
func squareWave(freq, vol float64, samples int) []byte {
	pcm := make([]byte, samples*8)
	step := freq / float64(sampleRate)
	phase := 0.0
	for i := 0; i < len(pcm); i += 8 {
		level := float32(vol)
		if math.Mod(phase, 1) >= 0.5 {
			level = -level
		}
		bits := math.Float32bits(level)
		pcm[i] = byte(bits)
		pcm[i+1] = byte(bits >> 8)
		pcm[i+2] = byte(bits >> 16)
		pcm[i+3] = byte(bits >> 24)
		pcm[i+4] = pcm[i]
		pcm[i+5] = pcm[i+1]
		pcm[i+6] = pcm[i+2]
		pcm[i+7] = pcm[i+3]
		phase += step
	}
	return pcm
}

type Game struct {
	x, y         float64
	score        int
	face         *text.GoXFace
	jpFace       *text.GoXFace
	audioContext *audio.Context
	shot         []byte
}

func (g *Game) Update() error {
	if inpututil.IsKeyJustPressed(ebiten.KeyEscape) {
		return ebiten.Termination
	}
	// **最初の入力より前に鳴らさない**（#286）。ブラウザは利用者の操作より前に音を
	// 鳴らさず、OGP は初回フレームを撮るだけなので、ここに依存する進行を書かない。
	//
	// **鳴らすたびに player を作る**（#567）。新しい player は溜まりが空の状態から
	// 始まるので、入力から遅れずに鳴る。**`Rewind` は呼ばない**（#301。自前の `Read` を
	// 持つ音源では panic する）ので、同じキーを何度押しても固まらない。
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) && g.audioContext.IsReady() {
		player := g.audioContext.NewPlayerF32FromBytes(g.shot)
		player.Play()
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
	shot := squareWave(440, 0.2, sampleRate/10)
	g := &Game{
		face:         text.NewGoXFace(basicfont.Face7x13),
		jpFace:       text.NewGoXFace(jpfont.Face16),
		audioContext: audioContext,
		shot:         shot,
	}
	ebiten.SetWindowSize(640, 480)
	if err := ebiten.RunGame(g); err != nil && !errors.Is(err, ebiten.Termination) {
		panic(err)
	}
}
