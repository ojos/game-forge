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
  extractHeldInputKeyCodes,
  extractInputKeyCodes,
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

  it('規則の版が仕様の版と一致する（3.9.5 の見出しの版 1 と、#529 の実装注記が上げた版）', () => {
    const match = /\*\*抽出の規則（`rule_version = (\d+)`）:\*\*/.exec(env.TEST_PRODUCT_SPEC);
    expect(match).not.toBeNull();
    // **見出しは版 1 の規則を書いたまま残す**（#528 注記が「M14-9 で置き換わる」と書き、仕様の版を上げないため）。
    // 今の版は、見出しの版と、実装注記の「規則の版を `rule_version = N` に上げた」の最大である。
    const raised = [...env.TEST_PRODUCT_SPEC.matchAll(/規則の版を `rule_version = (\d+)` に上げた/g)].map((m) => Number(m[1]));
    expect(Math.max(Number(match?.[1]), ...raised)).toBe(INPUT_KEYS_RULE_VERSION);
  });
});
