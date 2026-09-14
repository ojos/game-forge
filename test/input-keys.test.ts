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

  it('規則の版が仕様 3.9.5 の見出しの版と一致する', () => {
    const match = /\*\*抽出の規則（`rule_version = (\d+)`）:\*\*/.exec(env.TEST_PRODUCT_SPEC);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(INPUT_KEYS_RULE_VERSION);
  });
});
