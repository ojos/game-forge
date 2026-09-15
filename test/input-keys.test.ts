import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  EBITEN_KEY_CODES,
  EBITEN_KEY_CODE_LIST,
  EBITEN_MODULE_VERSION,
} from '../src/ebiten-keys.generated.js';
import {
  INPUT_KEYS_RULE_VERSION,
  INPUT_KEY_CODES,
  ebitenKeyCode,
  extractAliasGroups,
  extractHeldInputKeyCodes,
  extractInputKeyCodes,
  extractLayoutSize,
} from '../src/input-keys.js';

describe('抽出の規則（仕様 3.9.5 / #493）', () => {
  it('ebiten.Key* を code へ写し、重複を除いて昇順に並べる', () => {
    const source = `package main

import (
	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/inpututil"
)

func (g *Game) Update() error {
	if ebiten.IsKeyPressed(ebiten.KeyArrowLeft) || ebiten.IsKeyPressed(ebiten.KeyA) {
		g.x--
	}
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyEnter) {
		g.jump()
	}
	if ebiten.IsKeyPressed(ebiten.KeyA) {
		g.x--
	}
	return nil
}
`;
    expect(extractInputKeyCodes(source)).toEqual(['ArrowLeft', 'Enter', 'KeyA', 'Space']);
  });

  it('非推奨の別名を写す（KeyUp / KeyDown / KeyLeft / KeyRight と Key0〜Key9）', () => {
    expect(
      extractInputKeyCodes('ebiten.KeyUp ebiten.KeyDown ebiten.KeyLeft ebiten.KeyRight'),
    ).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(extractInputKeyCodes(`ebiten.Key${digit}`)).toEqual([`Digit${digit}`]);
    }
    // 別名と正式名を両方書いても 1 つにまとまる。
    expect(extractInputKeyCodes('ebiten.KeyUp ebiten.KeyArrowUp')).toEqual(['ArrowUp']);
  });

  it('左右の区別の無い KeyShift / KeyControl / KeyAlt / KeyMeta は左へ写す', () => {
    expect(ebitenKeyCode('Shift')).toBe('ShiftLeft');
    expect(ebitenKeyCode('Control')).toBe('ControlLeft');
    expect(ebitenKeyCode('Alt')).toBe('AltLeft');
    expect(ebitenKeyCode('Meta')).toBe('MetaLeft');
    // 左右を名指ししたものは、そのまま写す。
    expect(ebitenKeyCode('ShiftRight')).toBe('ShiftRight');
  });

  it('表に無い名前は捨てる（KeyName の Name、KeyMax）', () => {
    expect(
      extractInputKeyCodes('name := ebiten.KeyName(ebiten.KeyZ); _ = ebiten.KeyMax; _ = ebiten.KeyNope'),
    ).toEqual(['KeyZ']);
  });

  it('Object.prototype の名前を code として返さない', () => {
    expect(ebitenKeyCode('constructor')).toBeNull();
    expect(ebitenKeyCode('toString')).toBeNull();
    expect(extractInputKeyCodes('ebiten.Keyconstructor ebiten.KeyhasOwnProperty')).toEqual([]);
  });

  it('キーを読まなければ空配列', () => {
    expect(extractInputKeyCodes('package main\n\nfunc main() { ebiten.RunGame(g) }\n')).toEqual([]);
    expect(extractInputKeyCodes('')).toEqual([]);
  });

  it('ebiten 以外の名前で import したソースは拾わない（受け入れた限界）', () => {
    expect(extractInputKeyCodes('e.IsKeyPressed(e.KeySpace)')).toEqual([]);
    // 語の境界: 前に文字が続く識別子は ebiten ではない。
    expect(extractInputKeyCodes('myebiten.KeySpace')).toEqual([]);
  });

  it('名前の後ろに識別子の文字が続けば、途中で切って拾わない', () => {
    expect(extractInputKeyCodes('ebiten.KeyA_b ebiten.KeySpacebar')).toEqual([]);
  });

  it('コメントや文字列の中の ebiten.Key* も拾う（受け入れた限界）', () => {
    expect(extractInputKeyCodes('// ebiten.KeyX で撃つ\nlabel := "ebiten.KeyZ"')).toEqual(['KeyX', 'KeyZ']);
  });

  it('何度呼んでも同じ結果になる（正規表現の状態が漏れない）', () => {
    const source = 'ebiten.KeySpace ebiten.KeyEscape';
    expect(extractInputKeyCodes(source)).toEqual(['Escape', 'Space']);
    expect(extractInputKeyCodes(source)).toEqual(['Escape', 'Space']);
  });
});

/**
 * Go のソースの `Update` の本体を包む。
 *
 * @param body `Update` の本体
 * @returns ソース
 */
function game(body: string): string {
  return `package main

import (
	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/inpututil"
)

func (g *Game) Update() error {
${body}
	return nil
}
`;
}

describe('押し続けて読むキーの抽出（仕様 3.9.6 の「H の拾い方」/ #529）', () => {
  it('←→ H・↑ J（横スクロール。↑ はジャンプ）: 横の矢印だけを拾う', () => {
    const source = game(`
	if ebiten.IsKeyPressed(ebiten.KeyArrowLeft) {
		g.x--
	}
	if ebiten.IsKeyPressed(ebiten.KeyArrowRight) {
		g.x++
	}
	if inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) || inpututil.IsKeyJustPressed(ebiten.KeySpace) {
		g.jump()
	}`);
    expect(extractHeldInputKeyCodes(source)).toEqual(['ArrowLeft', 'ArrowRight']);
    expect(extractInputKeyCodes(source)).toEqual(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space']);
  });

  it('4 方向とも J（迷路）: 押し続けて読むキーは無い', () => {
    const source = game(`
	switch {
	case inpututil.IsKeyJustPressed(ebiten.KeyArrowUp):
		g.move(0, -1)
	case inpututil.IsKeyJustPressed(ebiten.KeyArrowDown):
		g.move(0, 1)
	case inpututil.IsKeyJustPressed(ebiten.KeyArrowLeft):
		g.move(-1, 0)
	case inpututil.IsKeyJustPressed(ebiten.KeyArrowRight):
		g.move(1, 0)
	}`);
    expect(extractHeldInputKeyCodes(source)).toEqual([]);
    expect(extractInputKeyCodes(source)).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
  });

  it('4 方向とも H（縦シューティング）: WASD の別名も矢印と同じ表で写す', () => {
    const source = game(`
	if ebiten.IsKeyPressed(ebiten.KeyUp) || ebiten.IsKeyPressed(ebiten.KeyW) {
		g.y--
	}
	if ebiten.IsKeyPressed(ebiten.KeyDown) || ebiten.IsKeyPressed(ebiten.KeyS) {
		g.y++
	}
	if ebiten.IsKeyPressed(ebiten.KeyLeft) || ebiten.IsKeyPressed(ebiten.KeyA) {
		g.x--
	}
	if ebiten.IsKeyPressed(ebiten.KeyRight) || ebiten.IsKeyPressed(ebiten.KeyD) {
		g.x++
	}`);
    expect(extractHeldInputKeyCodes(source)).toEqual([
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'KeyA',
      'KeyD',
      'KeyS',
      'KeyW',
    ]);
  });

  it('同じ方向キーを H と J の両方で読む（タイトルの選択と移動）: H として拾う', () => {
    const source = game(`
	if g.title {
		if inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) {
			g.cursor--
		}
		return nil
	}
	if ebiten.IsKeyPressed(ebiten.KeyArrowUp) {
		g.y--
	}`);
    expect(extractHeldInputKeyCodes(source)).toEqual(['ArrowUp']);
  });

  it('inpututil.KeyPressDuration も H として拾う', () => {
    const source = game(`
	if inpututil.KeyPressDuration(ebiten.KeySpace) > 30 {
		g.charge()
	}`);
    expect(extractHeldInputKeyCodes(source)).toEqual(['Space']);
  });

  it('IsKeyJustPressed と IsKeyJustReleased は拾わない', () => {
    expect(
      extractHeldInputKeyCodes('inpututil.IsKeyJustPressed(ebiten.KeyZ) || inpututil.IsKeyJustReleased(ebiten.KeyX)'),
    ).toEqual([]);
  });

  it('変数や式を渡す読み方は拾わない（その軸は押し続けない扱い）', () => {
    const source = game(`
	keys := []ebiten.Key{ebiten.KeyArrowLeft, ebiten.KeyArrowRight}
	for _, k := range keys {
		if ebiten.IsKeyPressed(k) {
			g.move(k)
		}
	}
	_ = ebiten.IsKeyPressed(g.keys[ebiten.KeyArrowUp])
	_ = ebiten.IsKeyPressed(ebiten.KeyArrowDown + 1)`);
    expect(extractHeldInputKeyCodes(source)).toEqual([]);
    // 読むキーの全集合には入る（版 1 からの規則）。
    expect(extractInputKeyCodes(source)).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
  });

  it('括弧の内側の空白・改行・末尾のカンマは許し、表に無い名前と ebiten 以外の名前は捨てる', () => {
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed( ebiten.KeyZ )')).toEqual(['KeyZ']);
    // 引数を複数行に書くと gofmt は末尾にカンマを付ける。
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed(\n\t\tebiten.KeyX,\n\t)')).toEqual(['KeyX']);
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed(ebiten.KeyX, ebiten.KeyY)')).toEqual([]);
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed(\n\t\tebiten.KeyX\n\t)')).toEqual(['KeyX']);
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed(ebiten.KeyMax)')).toEqual([]);
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressed(ebiten.Keyconstructor)')).toEqual([]);
    expect(extractHeldInputKeyCodes('e.IsKeyPressed(e.KeySpace)')).toEqual([]);
    expect(extractHeldInputKeyCodes('myebiten.IsKeyPressed(ebiten.KeySpace)')).toEqual([]);
    expect(extractHeldInputKeyCodes('ebiten.IsKeyPressedX(ebiten.KeySpace)')).toEqual([]);
  });

  it('押し続けて読むキーは、読むキーの全集合の部分集合で、重複を除いて昇順に並ぶ', () => {
    const source = game(`
	_ = ebiten.IsKeyPressed(ebiten.KeySpace) || ebiten.IsKeyPressed(ebiten.KeyA)
	_ = ebiten.IsKeyPressed(ebiten.KeySpace) || inpututil.KeyPressDuration(ebiten.KeyA) > 0
	_ = inpututil.IsKeyJustPressed(ebiten.KeyEnter)`);
    const held = extractHeldInputKeyCodes(source);
    expect(held).toEqual(['KeyA', 'Space']);
    const all = new Set(extractInputKeyCodes(source));
    expect(held.every((code) => all.has(code))).toBe(true);
    expect(extractHeldInputKeyCodes(source)).toEqual(held);
  });
});

describe('同じ条件式で読むキーの組の抽出（仕様 3.9.6 の「同じ働きの方向をボタンに出さない」/ #543）', () => {
  it('ピヨピヨジャンプ型（Space || Up || W で跳ぶ）: 別名を code に寄せ、昇順の 1 組にする', () => {
    const source = game(`
	if ebiten.IsKeyPressed(ebiten.KeyArrowLeft) {
		g.x--
	}
	if ebiten.IsKeyPressed(ebiten.KeyArrowRight) {
		g.x++
	}
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeyW) {
		g.jump()
	}`);
    expect(extractAliasGroups(source)).toEqual([['ArrowUp', 'KeyW', 'Space']]);
  });

  it('ストーリーと目的型（Z || Up で進む）: Z と ↑ の組', () => {
    const source = game(`
	if inpututil.IsKeyJustPressed(ebiten.KeyZ) || inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) {
		g.next()
	}
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) {
		g.fire()
	}`);
    expect(extractAliasGroups(source)).toEqual([['ArrowUp', 'KeyZ']]);
  });

  it('ケロケロ舌合戦型（Up || W と Down || S が Space と別の条件式）: Space を含まない 2 組', () => {
    const source = game(`
	if inpututil.IsKeyJustPressed(ebiten.KeyDown) || inpututil.IsKeyJustPressed(ebiten.KeyS) {
		g.lane = 1
	}
	if inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeyW) {
		g.lane = 0
	}
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) {
		g.tongue()
	}
	if inpututil.IsKeyJustPressed(ebiten.KeyZ) {
		g.guard()
	}`);
    // 組の並びは、要素を先頭から比べた昇順（ソースの出てくる順によらない）。
    expect(extractAliasGroups(source)).toEqual([
      ['ArrowDown', 'KeyS'],
      ['ArrowUp', 'KeyW'],
    ]);
  });

  it('&& や別の関数で組が切れる', () => {
    // 別の関数（IsKeyPressed）が挟まると、その前後は別の続き。
    expect(
      extractAliasGroups(
        'inpututil.IsKeyJustPressed(ebiten.KeySpace) || ebiten.IsKeyPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeyW)',
      ),
    ).toEqual([]);
    // && の両側は同じ働きではない（&& は || より強く結びつく）。&& に接する端の呼び出しは組から外す。
    expect(extractAliasGroups('inpututil.IsKeyJustPressed(ebiten.KeySpace) && inpututil.IsKeyJustPressed(ebiten.KeyUp)')).toEqual([]);
    expect(
      extractAliasGroups(
        'g.onGround && inpututil.IsKeyJustPressed(ebiten.KeyZ) || inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeySpace)',
      ),
    ).toEqual([['ArrowUp', 'Space']]);
    expect(
      extractAliasGroups(
        'inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyUp) && g.onGround',
      ),
    ).toEqual([]);
    // 括弧で囲んだ || の続きは、外側の && に接していても 1 組（括弧の内側は同じ働き）。
    expect(
      extractAliasGroups('g.onGround && (inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyUp))'),
    ).toEqual([['ArrowUp', 'Space']]);
    // 条件式が別なら別の組（文の区切りをまたいで続かない）。
    expect(
      extractAliasGroups('_ = inpututil.IsKeyJustPressed(ebiten.KeySpace)\n_ = inpututil.IsKeyJustPressed(ebiten.KeyUp)'),
    ).toEqual([]);
  });

  it('&& と端の呼び出しの間にコメントがあっても、&& に接する端のキーを組から外す（PR #546 の Copilot の指摘）', () => {
    const z = 'inpututil.IsKeyJustPressed(ebiten.KeyZ)';
    const up = 'inpututil.IsKeyJustPressed(ebiten.KeyUp)';
    const space = 'inpututil.IsKeyJustPressed(ebiten.KeySpace)';
    // 前側: ブロックコメント・行コメントと改行・両方を重ねた形。
    expect(extractAliasGroups(`ok && /* grounded */ ${z} || ${up} || ${space}`)).toEqual([['ArrowUp', 'Space']]);
    expect(extractAliasGroups(`if ok && // grounded\n\t\t${z} || ${up} || ${space} {`)).toEqual([['ArrowUp', 'Space']]);
    expect(extractAliasGroups(`ok && /* a */ // b\n /* c */\n${z} || ${up} || ${space}`)).toEqual([['ArrowUp', 'Space']]);
    // 後ろ側: 呼び出しの後のブロックコメント・行コメントと改行を越えた &&。
    expect(extractAliasGroups(`${space} || ${up} || ${z} /* grounded */ && ok`)).toEqual([['ArrowUp', 'Space']]);
    expect(extractAliasGroups(`${space} || ${up} || ${z} // grounded\n\t&& ok`)).toEqual([['ArrowUp', 'Space']]);
    // コメントの中の && は && ではない（前側の行コメントを取り除いた残りで見る）。
    expect(extractAliasGroups(`ok // a &&\n${up} || ${space}`)).toEqual([['ArrowUp', 'Space']]);
    // 文字列の中の // は行コメントではない（その後ろの && を消さない）。
    expect(extractAliasGroups(`_ = "https://example.com" == url && ${z} || ${up}`)).toEqual([]);
    // 行コメントの中の */ をブロックコメントの終わりと見ない（間のコードを飛ばして && に接すると誤らない。loop-gate の第二意見の指摘）。
    expect(extractAliasGroups(`ok && /* grounded */\nfoo := 1 // */\n${z} || ${up} || ${space}`)).toEqual([['ArrowUp', 'KeyZ', 'Space']]);
    expect(extractAliasGroups(`ok && // */\n${z} || ${up} || ${space}`)).toEqual([['ArrowUp', 'Space']]);
    // ブロックコメントの中の /* で、コメントの先頭を取り違えない。
    expect(extractAliasGroups(`ok && /* see /*.go */ ${z} || ${up} || ${space}`)).toEqual([['ArrowUp', 'Space']]);
    // 文字列・生文字列の中の /* や */ はコメントを始めも終えもしない。
    expect(extractAliasGroups(`x := "/*" && ${z} || ${up}`)).toEqual([]);
    expect(extractAliasGroups('y := `*/`\n' + `${z} || ${up}`)).toEqual([['ArrowUp', 'KeyZ']]);
    // || の続きの間のコメントは、今どおり組が切れる（方向はボタンに残る側）。
    expect(extractAliasGroups(`${space} || /* jump */ ${up}`)).toEqual([]);
  });

  it('複数行に書いた条件式（|| の前後の改行・括弧の内側の空白と末尾のカンマ）も 1 組', () => {
    const source = game(`
	if inpututil.IsKeyJustPressed(ebiten.KeySpace) ||
		inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) ||
		inpututil.IsKeyJustPressed(
			ebiten.KeyX,
		) {
		g.jump()
	}`);
    expect(extractAliasGroups(source)).toEqual([['ArrowUp', 'KeyX', 'Space']]);
  });

  it('キーが 1 つしか残らない組は捨て、同じ組は 1 つにまとめ、表に無い名前と変数を渡す読み方は拾わない', () => {
    // 別名と正式名は同じ code（1 つ）なので組にならない。
    expect(extractAliasGroups('inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeyArrowUp)')).toEqual([]);
    // 表に無い名前は捨てる（残りが 1 つなら組にならない）。
    expect(extractAliasGroups('inpututil.IsKeyJustPressed(ebiten.KeyMax) || inpututil.IsKeyJustPressed(ebiten.KeySpace)')).toEqual([]);
    // 変数を渡す読み方で続きが切れる。
    expect(extractAliasGroups('inpututil.IsKeyJustPressed(k) || inpututil.IsKeyJustPressed(ebiten.KeySpace)')).toEqual([]);
    // ebiten 以外の名前・語の途中から始まる名前は拾わない。
    expect(extractAliasGroups('myinpututil.IsKeyJustPressed(ebiten.KeyZ) || myinpututil.IsKeyJustPressed(ebiten.KeyX)')).toEqual([]);
    // 同じ組が 2 か所にあっても 1 つ。先頭が同じなら短い組が先。
    const source = game(`
	_ = inpututil.IsKeyJustPressed(ebiten.KeyW) || inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeySpace)
	_ = inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) || inpututil.IsKeyJustPressed(ebiten.KeyW)
	_ = inpututil.IsKeyJustPressed(ebiten.KeyArrowUp) || inpututil.IsKeyJustPressed(ebiten.KeyW)`);
    expect(extractAliasGroups(source)).toEqual([
      ['ArrowUp', 'KeyW'],
      ['ArrowUp', 'KeyW', 'Space'],
    ]);
    // 何度呼んでも同じ（正規表現の状態が漏れない）。組の中の code はすべて読むキーの全集合にある。
    expect(extractAliasGroups(source)).toEqual(extractAliasGroups(source));
    const all = new Set(extractInputKeyCodes(source));
    expect(extractAliasGroups(source).flat().every((code) => all.has(code))).toBe(true);
  });

  it('組を読まないソースは空配列', () => {
    expect(extractAliasGroups('')).toEqual([]);
    expect(extractAliasGroups(game('\t_ = inpututil.IsKeyJustPressed(ebiten.KeySpace)'))).toEqual([]);
  });
});

describe('作品の論理解像度の抽出（仕様 3.9.4 の「論理解像度の拾い方」/ #514。規則の版 4）', () => {
  /**
   * パッケージの宣言と Layout の本体から、ソースを組み立てる。
   *
   * @param declarations パッケージの最上位に置く宣言
   * @param layout `Layout` の本体
   * @param rest ほかの関数
   * @returns ソース
   */
  function program(declarations: string, layout: string, rest = ''): string {
    return `package main

import "github.com/hajimehoshi/ebiten/v2"

${declarations}

type Game struct{ w, h int }

func (g *Game) Update() error { return nil }

func (g *Game) Draw(screen *ebiten.Image) {}

func (g *Game) Layout(outsideWidth, outsideHeight int) (int, int) {
${layout}
}
${rest}
func main() {
	ebiten.RunGame(&Game{})
}
`;
  }

  it('整数のリテラルを 2 つ返す Layout を拾う（1 行に書いた形も）', () => {
    expect(extractLayoutSize(program('', '\treturn 320, 240'))).toEqual({ width: 320, height: 240 });
    const oneLine = 'package main\n\nfunc (g *Game) Layout(ow, oh int) (int, int) { return 480, 640 }\n';
    expect(extractLayoutSize(oneLine)).toEqual({ width: 480, height: 640 });
  });

  it('パッケージの const の名前を返す Layout を拾う（別々の宣言・const のまとまり・型つき）', () => {
    expect(extractLayoutSize(program('const screenW = 320\nconst screenH = 480', '\treturn screenW, screenH'))).toEqual({ width: 320, height: 480 });
    expect(
      extractLayoutSize(program('const (\n\tscreenW = 480\n\tscreenH = 360\n\tgravity = 0.4\n)', '\treturn screenW, screenH')),
    ).toEqual({ width: 480, height: 360 });
    expect(extractLayoutSize(program('const (\n\tscreenW int = 480\n\tscreenH int = 320\n)', '\treturn screenW, screenH'))).toEqual({
      width: 480,
      height: 320,
    });
    expect(extractLayoutSize(program('var screenW, screenH int = 320, 240', '\treturn screenW, screenH'))).toEqual({ width: 320, height: 240 });
  });

  it('まとめた宣言は位置で対応させる（えらべるサカナを 480×480、ネズミのカギを 320×320 と取り違えた実例）', () => {
    // えらべるサカナ（公開済み）: const のまとまりの中の `SW, SH = 480, 270`。名前の最初の `=` を拾うと SH が 480 になる。
    const sakana = program('const (\n\tSW, SH     = 480, 270\n\tMaxFish    = 8\n)', '\treturn SW, SH');
    expect(extractLayoutSize(sakana)).toEqual({ width: 480, height: 270 });
    // ネズミのカギ（公開済み）: `SW, SH = 320, 240` と、それを使う式の宣言。関数の中に同じ綴りの小文字の局所変数もある。
    const nezumi = program(
      'const (\n\tTILE     = 16\n\tSW, SH   = 320, 240\n\tCOLS      = SW / TILE\n\tROWS      = SH / TILE\n)',
      '\treturn SW, SH',
      '\nfunc (g *Game) score() {\n\tsw, _ := measure()\n\t_ = sw\n}\n',
    );
    expect(extractLayoutSize(nezumi)).toEqual({ width: 320, height: 240 });
    // 左右の数が合わない（多値を返す呼び出しで束縛する var）は拾わない。
    expect(extractLayoutSize(program('var SW, SH = size()', '\treturn SW, SH'))).toBeNull();
  });

  it('式・関数呼び出し・整数でない型・値の省略（iota の繰り返し）で束縛した名前は拾わない', () => {
    expect(extractLayoutSize(program('const (\n\tscreenW = 160 * 2\n\tscreenH = 240\n)', '\treturn screenW, screenH'))).toBeNull();
    expect(extractLayoutSize(program('var screenW = width()\nconst screenH = 240', '\treturn screenW, screenH'))).toBeNull();
    expect(extractLayoutSize(program('const screenW float64 = 320\nconst screenH = 240', '\treturn screenW, screenH'))).toBeNull();
    expect(extractLayoutSize(program('const (\n\tscreenH = 240\n\tscreenW\n)', '\treturn screenW, screenH'))).toBeNull();
    expect(extractLayoutSize(program('var screenW int\nconst screenH = 240', '\treturn screenW, screenH'))).toBeNull();
    // 10 進の正の整数のリテラルだけを拾う（16 進・0・文字列は拾わない）。
    expect(extractLayoutSize(program('', '\treturn 0x140, 240'))).toBeNull();
    expect(extractLayoutSize(program('', '\treturn 0, 240'))).toBeNull();
    expect(extractLayoutSize(program('const screenW = "320"\nconst screenH = 240', '\treturn screenW, screenH'))).toBeNull();
  });

  it('Layout の中の式・呼び出し・変換・引数を返すものは拾わない', () => {
    expect(extractLayoutSize(program('const screenW = 320', '\treturn screenW * 2, 240'))).toBeNull();
    expect(extractLayoutSize(program('', '\treturn int(320), 240'))).toBeNull();
    expect(extractLayoutSize(program('', '\treturn outsideWidth, outsideHeight'))).toBeNull();
    expect(extractLayoutSize(program('', '\treturn g.w, g.h'))).toBeNull();
    expect(extractLayoutSize(program('', '\treturn 320'))).toBeNull();
  });

  it('同じ名前を 2 回宣言した・関数の中で代入した・Layout の中で同じ名前を使うなら拾わない', () => {
    expect(extractLayoutSize(program('const screenW = 320\nconst screenH = 240\nvar screenW = 480', '\treturn screenW, screenH'))).toBeNull();
    expect(
      extractLayoutSize(program('var screenW = 320\nvar screenH = 240', '\treturn screenW, screenH', '\nfunc init() {\n\tscreenW = 480\n}\n')),
    ).toBeNull();
    expect(
      extractLayoutSize(program('var screenW, screenH = 320, 240', '\treturn screenW, screenH', '\nfunc grow() {\n\tscreenW, screenH = 480, 360\n}\n')),
    ).toBeNull();
    expect(extractLayoutSize(program('var screenW = 320\nvar screenH = 240', '\treturn screenW, screenH', '\nfunc grow() {\n\tscreenH += 10\n}\n'))).toBeNull();
    expect(extractLayoutSize(program('var screenW = 320\nvar screenH = 240', '\treturn screenW, screenH', '\nfunc grow() {\n\tscreenH++\n}\n'))).toBeNull();
    // Layout の中で局所の宣言に隠される。
    expect(extractLayoutSize(program('const screenW = 320\nconst screenH = 240', '\tscreenW := outsideWidth\n\treturn screenW, screenH'))).toBeNull();
    // 比較・宣言（:=）・セレクタは代入に数えない。
    const reads = '\nfunc (g *Game) check() {\n\tif g.w == screenW || g.h != screenH || g.w <= screenW {\n\t\tw := screenW\n\t\tg.screenW = w\n\t}\n}\n';
    expect(extractLayoutSize(program('const screenW = 320\nconst screenH = 240', '\treturn screenW, screenH', reads))).toEqual({ width: 320, height: 240 });
  });

  it('return が 2 つある・Layout が 2 つある・Layout が無いなら拾わない', () => {
    expect(extractLayoutSize(program('', '\tif outsideWidth < outsideHeight {\n\t\treturn 240, 320\n\t}\n\treturn 320, 240'))).toBeNull();
    const twice = `${program('', '\treturn 320, 240')}\ntype Other struct{}\n\nfunc (o Other) Layout(w, h int) (int, int) { return 320, 240 }\n`;
    expect(extractLayoutSize(twice)).toBeNull();
    expect(extractLayoutSize('package main\n\nfunc main() {}\n')).toBeNull();
    expect(extractLayoutSize('')).toBeNull();
    // LayoutF（浮動小数の版）は Layout ではない。
    expect(extractLayoutSize('package main\n\nfunc (g *Game) LayoutF(w, h float64) (float64, float64) { return 320, 240 }\n')).toBeNull();
  });

  it('コメントと文字列の中の return・宣言・Layout は見ない', () => {
    const commented = program(
      '// const screenW = 999\n/* var screenH = 999 */\nconst screenW = 320\nconst screenH = 240\nconst title = "screenW = 1; return 1, 1"',
      '\t// return 640, 480\n\t/* if wide { return 1, 1 } */\n\treturn screenW, screenH // return 2, 2',
      '\n// func (g *Game) Layout(w, h int) (int, int) { return 1, 1 }\nvar help = `\nfunc (g *Game) Layout(w, h int) (int, int) {\n\treturn 2, 2\n}\n`\n',
    );
    expect(extractLayoutSize(commented)).toEqual({ width: 320, height: 240 });
  });

  it('関数の本体と複合リテラルの中の宣言は、パッケージの宣言に数えない', () => {
    const local = program(
      'const screenW = 320\nconst screenH = 240\nvar palette = []int{\n\t1, 2,\n}',
      '\treturn screenW, screenH',
      '\nfunc (g *Game) reset() {\n\tconst screenW = 640\n\tvar screenH = 480\n\t_ = screenH\n}\n',
    );
    expect(extractLayoutSize(local)).toEqual({ width: 320, height: 240 });
  });
});

describe('キーの表と許可表（仕様 3.9.5 / 3.9.7）', () => {
  it('許可表は、キーの表が写す code の集合と同じである', () => {
    const values = [...new Set(Object.values(EBITEN_KEY_CODES))].sort();
    expect([...INPUT_KEY_CODES]).toEqual(values);
    expect(INPUT_KEY_CODES).toBe(EBITEN_KEY_CODE_LIST);
  });

  it('抽出が返す code は、すべて許可表にある', () => {
    const everything = Object.keys(EBITEN_KEY_CODES)
      .map((name) => `ebiten.Key${name}`)
      .join('\n');
    const codes = extractInputKeyCodes(everything);
    expect(codes).toEqual([...INPUT_KEY_CODES]);
  });

  it('表を生成した Ebitengine の版が、隔離ビルドの go.mod の版と一致する', () => {
    // **中身の照合は `scripts/ebiten-keys-table.mjs --check` が持つ**（Ebitengine のソースが要る）。
    // ここは CI でも必ず走る側で、版を上げて表を作り直し忘れた状態を落とす。
    const match = /^\s*github\.com\/hajimehoshi\/ebiten\/v2\s+(v\S+)/m.exec(env.TEST_TEMPLATE_GO_MOD);
    expect(match?.[1]).toBe(EBITEN_MODULE_VERSION);
  });

  it('規則の版が仕様の版と一致する（3.9.5 の見出しの版 1 と、#529 / #543 / #514 の実装注記が上げた版）', () => {
    const match = /\*\*抽出の規則（`rule_version = (\d+)`）:\*\*/.exec(env.TEST_PRODUCT_SPEC);
    expect(match).not.toBeNull();
    // **見出しは版 1 の規則を書いたまま残す**（#528 注記が「M14-9 で置き換わる」と書き、仕様の版を上げないため）。
    // 今の版は、見出しの版と、実装注記の「規則の版を `rule_version = N` に上げた」の最大である。
    const raised = [...env.TEST_PRODUCT_SPEC.matchAll(/規則の版を `rule_version = (\d+)` に上げた/g)].map((m) => Number(m[1]));
    expect(Math.max(Number(match?.[1]), ...raised)).toBe(INPUT_KEYS_RULE_VERSION);
  });
});
