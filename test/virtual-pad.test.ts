import { describe, expect, it } from 'vitest';
import { INPUT_KEY_CODES } from '../src/input-keys.js';
import { PAD_BUTTON_LIMIT, padKeyLabel, padLayoutOf, readInputKeyCodes } from '../src/virtual-pad.js';

/**
 * 仮想パッドの表示規則（仕様 3.9.6 / #494 / M14-5）と、D1 の値の読み方（許可表で絞る）。
 *
 * **振る舞い（タッチがキーとして作品へ届く・同時押し・閉じると離す）は、実ブラウザの検査の層 8**
 * （`scripts/check-sandbox-browser.sh` / `scripts/virtual-pad-verdict.mjs`）が見る。
 */

/**
 * パッドの中身を、比べやすい形（十字は `位置:code`、ボタンは `code`）にする。
 *
 * @param codes キーの集合
 * @returns 十字とボタン
 */
function shapeOf(codes: readonly string[]): { dpad: string[]; buttons: string[] } {
  const layout = padLayoutOf(codes);
  return {
    dpad: layout.dpad.map((key) => `${key.direction}:${key.code}`),
    buttons: layout.buttons.map((key) => key.code),
  };
}

describe('表示規則（仕様 3.9.6）', () => {
  it.each([
    {
      name: '矢印があれば、読む矢印だけを十字に出し、WASD はボタンにも出さない',
      codes: ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'KeyA', 'KeyD', 'KeyS', 'KeyW', 'Space'],
      dpad: ['up:ArrowUp', 'left:ArrowLeft', 'right:ArrowRight', 'down:ArrowDown'],
      buttons: ['Space'],
    },
    {
      name: '読む矢印だけ（左右だけの作品は上下を出さない）',
      codes: ['ArrowLeft', 'ArrowRight', 'Space'],
      dpad: ['left:ArrowLeft', 'right:ArrowRight'],
      buttons: ['Space'],
    },
    {
      name: '矢印が無く WASD があれば、WASD を十字の同じ位置に出し、WASD の code を送る',
      codes: ['KeyA', 'KeyD', 'KeyW', 'KeyZ'],
      dpad: ['up:KeyW', 'left:KeyA', 'right:KeyD'],
      buttons: ['KeyZ'],
    },
    {
      name: '矢印が 1 つでもあれば、WASD は十字にもボタンにも出ない',
      codes: ['ArrowUp', 'KeyA', 'KeyD'],
      dpad: ['up:ArrowUp'],
      buttons: [],
    },
    {
      name: 'Space があれば Enter を除く',
      codes: ['Enter', 'Space'],
      dpad: [],
      buttons: ['Space'],
    },
    {
      name: 'Space が無ければ Enter を出す',
      codes: ['Enter', 'Escape'],
      dpad: [],
      buttons: ['Enter', 'Escape'],
    },
    {
      name: '並べる順は Space → KeyZ → KeyX → Enter → その他（code の昇順）→ Escape',
      codes: ['Escape', 'KeyR', 'KeyX', 'KeyZ'],
      dpad: [],
      buttons: ['KeyZ', 'KeyX', 'KeyR', 'Escape'],
    },
    {
      name: 'Space が無いときの Enter は KeyX の後、その他の前',
      codes: ['Enter', 'KeyJ', 'KeyX'],
      dpad: [],
      buttons: ['KeyX', 'Enter', 'KeyJ'],
    },
    {
      name: '左右の組は左だけを残す',
      codes: ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'],
      dpad: [],
      buttons: ['ControlLeft', 'ShiftLeft'],
    },
    {
      name: '右だけなら右を出す（組になっていない）',
      codes: ['ShiftRight'],
      dpad: [],
      buttons: ['ShiftRight'],
    },
    {
      name: '[ と ] は左右の組ではない（別のキー）',
      codes: ['BracketLeft', 'BracketRight'],
      dpad: [],
      buttons: ['BracketLeft', 'BracketRight'],
    },
    {
      // 仕様 3.9.6 の 2: 公開済みの 32 本に当てると、上限の 4 で落ちるのは 1 本の KeyK だけだった。その形の代表例。
      name: '上限は 4 つ。公開済みの 32 本で上限に当たった形（KeyK だけが落ちる）',
      codes: ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter', 'KeyJ', 'KeyK', 'KeyX', 'KeyZ', 'Space'],
      dpad: ['up:ArrowUp', 'left:ArrowLeft', 'right:ArrowRight', 'down:ArrowDown'],
      buttons: ['Space', 'KeyZ', 'KeyX', 'KeyJ'],
    },
    {
      // 仕様 3.9.6 の 2: 方向もボタンも出ないのはマウスだけの 1 本（モグラぽん）。
      name: 'キーを読まない作品（モグラぽん）は何も出ない',
      codes: [],
      dpad: [],
      buttons: [],
    },
    {
      name: '許可表に無い値は出さない（呼ぶ側が絞っていなくても）',
      codes: ['constructor', 'KeyQQ', '"><script>', 'Space'],
      dpad: [],
      buttons: ['Space'],
    },
  ])('$name', ({ codes, dpad, buttons }) => {
    expect(shapeOf(codes)).toEqual({ dpad, buttons });
  });

  it('ボタンは最大 4 つ', () => {
    expect(PAD_BUTTON_LIMIT).toBe(4);
    expect(padLayoutOf(INPUT_KEY_CODES).buttons).toHaveLength(PAD_BUTTON_LIMIT);
  });

  it('十字のボタンは読み上げの名前（左・上・右・下）と矢印の文字を持ち、ボタンは読み上げの名前を持たない', () => {
    const layout = padLayoutOf(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'KeyZ']);
    expect(layout.dpad.map((key) => [key.label, key.ariaLabel])).toEqual([
      ['↑', '上'],
      ['←', '左'],
      ['→', '右'],
      ['↓', '下'],
    ]);
    // WASD を十字に出したときも、方向のボタンとして同じ文字と名前を持つ。
    expect(padLayoutOf(['KeyA']).dpad).toEqual([{ code: 'KeyA', direction: 'left', label: '←', ariaLabel: '左' }]);
    expect(layout.buttons).toEqual([{ code: 'KeyZ', label: 'Z', ariaLabel: null }]);
  });
});

describe('ボタンの文字は code ごとの固定の文字列（仕様 3.9.6 の 3）', () => {
  it('仕様に挙げた例', () => {
    expect(padKeyLabel('Space')).toBe('Space');
    expect(padKeyLabel('Enter')).toBe('Enter');
    expect(padKeyLabel('Escape')).toBe('Esc');
    expect(padKeyLabel('ShiftLeft')).toBe('Shift');
    expect(padKeyLabel('KeyZ')).toBe('Z');
    expect(padKeyLabel('ArrowLeft')).toBe('←');
    expect(padKeyLabel('Digit1')).toBe('1');
    expect(padKeyLabel('ControlLeft')).toBe('Ctrl');
  });

  it('許可表のすべての code に、空でなく HTML の特別な文字を含まない文字がある', () => {
    for (const code of INPUT_KEY_CODES) {
      const label = padKeyLabel(code);
      expect(label, code).not.toBe('');
      expect(label, code).not.toMatch(/[<>&"']/u);
    }
  });
});

describe('D1 の値を許可表で絞って読む（仕様 3.9.5 / 3.9.7）', () => {
  it('行が無い（null）・壊れた JSON・配列でない値は空', () => {
    expect(readInputKeyCodes(null)).toEqual([]);
    expect(readInputKeyCodes(undefined)).toEqual([]);
    expect(readInputKeyCodes(42)).toEqual([]);
    expect(readInputKeyCodes('not json')).toEqual([]);
    expect(readInputKeyCodes('{"0":"Space"}')).toEqual([]);
    expect(readInputKeyCodes('"Space"')).toEqual([]);
    expect(readInputKeyCodes('null')).toEqual([]);
    expect(readInputKeyCodes('[]')).toEqual([]);
  });

  it('許可表の外の値と文字列でない値を捨て、重複を除いて code の昇順にする', () => {
    expect(readInputKeyCodes(JSON.stringify(['Space', 'constructor', '__proto__', 'KeyQQ', 1, null, ['Enter'], 'ArrowLeft', 'Space']))).toEqual([
      'ArrowLeft',
      'Space',
    ]);
  });

  it('許可表は抽出の側の表そのものである（写しを作らない）', () => {
    expect(readInputKeyCodes(JSON.stringify(INPUT_KEY_CODES))).toEqual([...INPUT_KEY_CODES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
