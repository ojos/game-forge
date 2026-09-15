import { describe, expect, it } from 'vitest';
import { INPUT_KEY_CODES } from '../src/input-keys.js';
import type { PadStick } from '../src/virtual-pad.js';
import {
  PAD_BUTTON_LIMIT,
  PAD_LABEL_MAX_LENGTH,
  PAD_STICK_DEAD_ZONE_RATIO,
  PAD_STICK_RADIUS_PX,
  STICK_KEYS_SOURCE,
  padKeyAriaLabel,
  padKeyLabel,
  padLayoutOf,
  padPlanOf,
  readHeldCodes,
  readInputKeyCodes,
} from '../src/virtual-pad.js';

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
    expect(padKeyLabel('AltRight')).toBe('Alt');
    expect(padKeyLabel('MetaLeft')).toBe('Meta');
    expect(padKeyLabel('Numpad1')).toBe('Num1');
    expect(padKeyLabel('NumpadMultiply')).toBe('Num*');
    expect(padKeyLabel('F12')).toBe('F12');
  });

  it(`許可表のすべての code に、空でなく ${PAD_LABEL_MAX_LENGTH} 文字以下の文字がある（許可表から回す。PR #524 の Copilot の指摘）`, () => {
    expect(PAD_LABEL_MAX_LENGTH).toBe(5);
    const tooLong: string[] = [];
    for (const code of INPUT_KEY_CODES) {
      const label = padKeyLabel(code);
      expect(label, code).not.toBe('');
      expect(label, code).not.toMatch(/[<>&"]/u);
      if ([...label].length > PAD_LABEL_MAX_LENGTH) {
        tooLong.push(`${code} → ${label}`);
      }
    }
    expect(tooLong, '表（src/virtual-pad.ts の FIXED_LABELS）に短い文字を書く').toEqual([]);
  });

  it('文字を縮めたキーは、読み上げの名前に正式な名前（code）を持つ', () => {
    expect(padKeyAriaLabel('NumpadMultiply')).toBe('NumpadMultiply');
    expect(padKeyAriaLabel('Escape')).toBe('Escape');
    expect(padKeyAriaLabel('ShiftLeft')).toBe('ShiftLeft');
    expect(padKeyAriaLabel('BracketLeft')).toBe('BracketLeft');
    // 文字が code と同じもの・英字と数字のキーは持たない。
    expect(padKeyAriaLabel('Space')).toBeNull();
    expect(padKeyAriaLabel('F1')).toBeNull();
    expect(padKeyAriaLabel('KeyZ')).toBeNull();
    expect(padKeyAriaLabel('Digit1')).toBeNull();
    for (const code of INPUT_KEY_CODES) {
      if (padKeyLabel(code).length < code.length && !/^(Key|Digit|Arrow)/u.test(code)) {
        expect(padKeyAriaLabel(code), code).toBe(code);
      }
    }
    expect(padLayoutOf(['NumpadMultiply']).buttons).toEqual([{ code: 'NumpadMultiply', label: 'Num*', ariaLabel: 'NumpadMultiply' }]);
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

/**
 * パッドの計画を、比べやすい形にする（ボタンは `code` か `code(形)`）。
 *
 * @param codes キーの集合
 * @param held 押し続けて読むキーの集合（版 1 は null）
 * @returns 推定した形・十字・スティック・形ごとのボタン
 */
function planOf(codes: readonly string[], held: readonly string[] | null) {
  const plan = padPlanOf(codes, held);
  const buttonsIn = (shape: 'stick' | 'dpad'): string[] =>
    plan.buttons.filter((key) => key.only === null || key.only === shape).map((key) => key.code);
  return {
    estimated: plan.estimated,
    dpad: plan.dpad.map((key) => key.code),
    stick: plan.stick,
    stickButtons: buttonsIn('stick'),
    dpadButtons: buttonsIn('dpad'),
  };
}

/** 受け付ける方向（書きやすくする）。 */
function stick(up: string | null, down: string | null, left: string | null, right: string | null): PadStick {
  return { up, down, left, right };
}

const ARROWS = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'];
const LR = ['ArrowLeft', 'ArrowRight'];
const UD = ['ArrowDown', 'ArrowUp'];

describe('最初の形を推定する規則（仕様 3.9.6 の #528 の規則 1〜6）', () => {
  it.each([
    {
      // 表「横だけのスティック 17 本」の代表: ←→ H・↑ J（↑ はジャンプ）。
      name: 'ピヨピヨジャンプ（←→ H・↑ J）: 横だけのスティックで、↑ は右のボタン（Space・↑）',
      codes: [...LR, 'ArrowUp', 'Space'],
      held: LR,
      estimated: 'stick',
      stick: stick(null, null, 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'ArrowUp'],
      dpadButtons: ['Space'],
    },
    {
      name: 'パドル（←→ だけ H）: 横だけのスティック（Space）',
      codes: [...LR, 'Space'],
      held: LR,
      estimated: 'stick',
      stick: stick(null, null, 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space'],
      dpadButtons: ['Space'],
    },
    {
      name: 'ケロケロ舌合戦（←→ H・↑↓ J）: 横だけのスティック（Space・Z・↑・↓）',
      codes: [...ARROWS, 'KeyZ', 'Space'],
      held: LR,
      estimated: 'stick',
      stick: stick(null, null, 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'KeyZ', 'ArrowUp', 'ArrowDown'],
      dpadButtons: ['Space', 'KeyZ'],
    },
    {
      name: '縦シューティング（4 方向とも H）: 8 方向のスティック（Space・Z）',
      codes: [...ARROWS, 'KeyZ', 'Space'],
      held: ARROWS,
      estimated: 'stick',
      stick: stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'KeyZ'],
      dpadButtons: ['Space', 'KeyZ'],
    },
    {
      // 上限の 4 で落ちるボタン: 紙ヒコーキの K（今と同じ）。
      name: '紙ヒコーキ（4 方向とも H）: 8 方向のスティックで、上限の 4 で K が落ちる（Space・Z・X・J）',
      codes: [...ARROWS, 'Enter', 'KeyJ', 'KeyK', 'KeyX', 'KeyZ', 'Space'],
      held: ARROWS,
      estimated: 'stick',
      stick: stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'KeyZ', 'KeyX', 'KeyJ'],
      dpadButtons: ['Space', 'KeyZ', 'KeyX', 'KeyJ'],
    },
    {
      name: 'ネズミのカギ（同じ方向キーを H と J の両方で読む）: H を優先して 8 方向のスティック（Space）',
      codes: [...ARROWS, 'Space'],
      held: ARROWS,
      estimated: 'stick',
      stick: stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space'],
      dpadButtons: ['Space'],
    },
    {
      name: 'ラケット（↑↓ だけ H）: 縦だけのスティック（Space・Esc）',
      codes: [...UD, 'Escape', 'Space'],
      held: UD,
      estimated: 'stick',
      stick: stick('ArrowUp', 'ArrowDown', null, null),
      stickButtons: ['Space', 'Escape'],
      dpadButtons: ['Space', 'Escape'],
    },
    {
      name: '迷路（4 方向とも J）: 十字（Space）。十字にするときは方向のボタンを回さない',
      codes: [...ARROWS, 'Space'],
      held: [],
      estimated: 'dpad',
      stick: stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space'],
      dpadButtons: ['Space'],
    },
    {
      name: 'ネコくずし（4 方向とも J）: 十字（Space・R・Esc）',
      codes: [...ARROWS, 'Escape', 'KeyR', 'Space'],
      held: ['Space'],
      estimated: 'dpad',
      stick: stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'KeyR', 'Escape'],
      dpadButtons: ['Space', 'KeyR', 'Escape'],
    },
    {
      name: 'ゴエモン風（↑↓ だけ J）: 十字。スティックにすると読む軸（縦）だけを受け付ける',
      codes: [...UD, 'KeyZ', 'Space'],
      held: [],
      estimated: 'dpad',
      stick: stick('ArrowUp', 'ArrowDown', null, null),
      stickButtons: ['Space', 'KeyZ'],
      dpadButtons: ['Space', 'KeyZ'],
    },
    {
      name: 'モグラぽん（方向キーを読まない）: 方向の操作を出さない',
      codes: [],
      held: [],
      estimated: null,
      stick: null,
      stickButtons: [],
      dpadButtons: [],
    },
    {
      name: '方向キーを読まずボタンだけの作品: 方向の操作を出さず、ボタンは形によらない',
      codes: ['KeyZ', 'Space'],
      held: ['Space'],
      estimated: null,
      stick: null,
      stickButtons: ['Space', 'KeyZ'],
      dpadButtons: ['Space', 'KeyZ'],
    },
    {
      // 上限の 4 で新しく落ちるボタン: 3 段ジャンプの作品の Shift（↑ がボタンの枠を 1 つ使うようになったため）。
      name: '3 段ジャンプ（←→ H・↑ J・Space・Z・X・Shift）: スティックでは ↑ が枠を使い Shift が落ちる。十字では Shift が出る',
      codes: [...LR, 'ArrowUp', 'KeyX', 'KeyZ', 'ShiftLeft', 'Space'],
      held: LR,
      estimated: 'stick',
      stick: stick(null, null, 'ArrowLeft', 'ArrowRight'),
      stickButtons: ['Space', 'KeyZ', 'KeyX', 'ArrowUp'],
      dpadButtons: ['Space', 'KeyZ', 'KeyX', 'ShiftLeft'],
    },
    {
      name: 'WASD の作品（A・D を H、W を J）: 横だけのスティックで WASD の code を送り、W は右のボタン',
      codes: ['KeyA', 'KeyD', 'KeyW', 'Space'],
      held: ['KeyA', 'KeyD'],
      estimated: 'stick',
      stick: stick(null, null, 'KeyA', 'KeyD'),
      stickButtons: ['Space', 'KeyW'],
      dpadButtons: ['Space'],
    },
  ])('$name', ({ codes, held, estimated, stick: expectedStick, stickButtons, dpadButtons }) => {
    const plan = planOf(codes, held);
    expect(plan.estimated).toBe(estimated);
    expect(plan.stick).toEqual(expectedStick);
    expect(plan.stickButtons).toEqual(stickButtons);
    expect(plan.dpadButtons).toEqual(dpadButtons);
    // 十字の中身は、どの作品でも表示規則（#494）のとおり。
    expect(plan.dpad).toEqual(padLayoutOf(codes).dpad.map((key) => key.code));
    expect(plan.dpadButtons).toEqual(padLayoutOf(codes).buttons.map((key) => key.code));
  });

  it('規則 5（押し続けない軸の方向を右のボタンへ回す）は、スティックで出すときだけ当たる', () => {
    // ←→ H・↑ J なら ↑ はボタンに回る。
    expect(planOf([...LR, 'ArrowUp'], LR).stickButtons).toEqual(['ArrowUp']);
    // 押し続ける軸が無い（十字）なら、十字に ↑ を出し、ボタンには回さない。スティックにしても回さない。
    const dpad = planOf([...LR, 'ArrowUp'], []);
    expect(dpad.estimated).toBe('dpad');
    expect(dpad.dpad).toEqual(['ArrowUp', 'ArrowLeft', 'ArrowRight']);
    expect(dpad.dpadButtons).toEqual([]);
    expect(dpad.stickButtons).toEqual([]);
    expect(dpad.stick).toEqual(stick('ArrowUp', null, 'ArrowLeft', 'ArrowRight'));
    // 方向のボタンは十字のキーと同じ文字と読み上げの名前を持ち、スティックの形でだけ出す。
    expect(padPlanOf([...LR, 'ArrowUp'], LR).buttons).toEqual([{ code: 'ArrowUp', label: '↑', ariaLabel: '上', only: 'stick' }]);
  });

  it('規則 6: 版 1 の行（held が null）は十字で出す。スティックにしたときは読む軸をすべて受け付ける', () => {
    const plan = planOf([...ARROWS, 'KeyZ', 'Space'], null);
    expect(plan.estimated).toBe('dpad');
    expect(plan.dpad).toEqual(['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown']);
    expect(plan.stick).toEqual(stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'));
    expect(plan.dpadButtons).toEqual(['Space', 'KeyZ']);
    expect(plan.stickButtons).toEqual(['Space', 'KeyZ']);
    // 行が無い作品は、呼ぶ側が codes を空にする（readInputKeyCodes(null)）ので、何も出ない。
    expect(padPlanOf(readInputKeyCodes(null), readHeldCodes(null))).toEqual({ estimated: null, dpad: [], stick: null, buttons: [] });
  });

  it('押し続けて読むキーは、読むキーの集合の中と許可表の中だけを見る', () => {
    // codes に無い held（壊れた行）は押し続ける軸にしない。
    expect(planOf(['ArrowUp', 'Space'], ['ArrowLeft']).estimated).toBe('dpad');
    // 矢印を読む作品では、WASD を H で読んでも矢印の軸は押し続けない扱い（送るのは矢印なので）。
    expect(planOf(['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'], ['KeyA', 'KeyD']).estimated).toBe('dpad');
    expect(planOf(['constructor', 'ArrowLeft'], ['constructor', 'ArrowLeft']).stick).toEqual(stick(null, null, 'ArrowLeft', null));
  });

  it('ボタンの和は、それぞれの形の並べる順を崩さない', () => {
    const plan = padPlanOf([...LR, 'ArrowUp', 'KeyX', 'KeyZ', 'ShiftLeft', 'Space'], LR);
    expect(plan.buttons.map((key) => `${key.code}:${String(key.only)}`)).toEqual([
      'Space:null',
      'KeyZ:null',
      'KeyX:null',
      'ArrowUp:stick',
      'ShiftLeft:dpad',
    ]);
  });
});

describe('押し続けて読むキーの読み方（D1 の値を信じ切らない。#530）', () => {
  it('NULL・文字列でない・壊れた JSON・配列でない値は null（版 1。十字で出す）', () => {
    expect(readHeldCodes(null)).toBeNull();
    expect(readHeldCodes(undefined)).toBeNull();
    expect(readHeldCodes(42)).toBeNull();
    expect(readHeldCodes('not json')).toBeNull();
    expect(readHeldCodes('{"0":"ArrowLeft"}')).toBeNull();
    expect(readHeldCodes('"ArrowLeft"')).toBeNull();
    expect(readHeldCodes('null')).toBeNull();
  });

  it('[] は「押し続けて読むキーは無い」で null と区別し、配列は許可表で絞って昇順にする', () => {
    expect(readHeldCodes('[]')).toEqual([]);
    expect(readHeldCodes(JSON.stringify(['ArrowRight', 'constructor', '__proto__', 1, null, 'ArrowLeft', 'ArrowRight']))).toEqual([
      'ArrowLeft',
      'ArrowRight',
    ]);
  });
});

describe('スティックの方向の決め方（仕様 3.9.6 の「方向の決め方」。ブラウザで動かす本文そのものを評価する）', () => {
  type StickKeysOf = (dx: number, dy: number, radius: number, deadZoneRatio: number, keys: PadStick) => string[];
  // **スクリプトに埋め込むのと同じ本文を評価する**（写しを作らない）。
  const stickKeysOf = new Function(`return (${STICK_KEYS_SOURCE});`)() as StickKeysOf;
  const both = stick('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight');
  const horizontal = stick(null, null, 'ArrowLeft', 'ArrowRight');
  const vertical = stick('ArrowUp', 'ArrowDown', null, null);
  const radius = PAD_STICK_RADIUS_PX;
  const dead = PAD_STICK_RADIUS_PX * PAD_STICK_DEAD_ZONE_RATIO;
  /** 角度（度。0 が右、時計回り＝画面の下向きが正）と距離から、押すキー。 */
  const at = (keys: PadStick, degrees: number, distance: number): string[] => {
    const radians = (degrees * Math.PI) / 180;
    return stickKeysOf(Math.cos(radians) * distance, Math.sin(radians) * distance, radius, PAD_STICK_DEAD_ZONE_RATIO, keys);
  };

  it('半径は 56px、遊びは半径の 30%（仕様の値）', () => {
    expect(PAD_STICK_RADIUS_PX).toBe(56);
    expect(PAD_STICK_DEAD_ZONE_RATIO).toBe(0.3);
  });

  it('両方の軸: 8 等分（45° ずつ）で、斜めの扇では 2 つのキーを押す', () => {
    const distance = radius * 0.8;
    expect(at(both, 0, distance)).toEqual(['ArrowRight']);
    expect(at(both, 45, distance)).toEqual(['ArrowDown', 'ArrowRight']);
    expect(at(both, 90, distance)).toEqual(['ArrowDown']);
    expect(at(both, 135, distance)).toEqual(['ArrowDown', 'ArrowLeft']);
    expect(at(both, 180, distance)).toEqual(['ArrowLeft']);
    expect(at(both, -135, distance)).toEqual(['ArrowUp', 'ArrowLeft']);
    expect(at(both, -90, distance)).toEqual(['ArrowUp']);
    expect(at(both, -45, distance)).toEqual(['ArrowUp', 'ArrowRight']);
    // 扇の境目（22.5°）の手前と先。
    expect(at(both, 22, distance)).toEqual(['ArrowRight']);
    expect(at(both, 23, distance)).toEqual(['ArrowDown', 'ArrowRight']);
    expect(at(both, -67, distance)).toEqual(['ArrowUp', 'ArrowRight']);
    expect(at(both, -68, distance)).toEqual(['ArrowUp']);
    // 円の外まで倒しても同じ（つまみは縁で止まるが、方向は角度で決まる）。
    expect(at(both, -45, radius * 3)).toEqual(['ArrowUp', 'ArrowRight']);
  });

  it('遊びの中（中心から半径の 30% まで）は何も押さない', () => {
    expect(stickKeysOf(0, 0, radius, PAD_STICK_DEAD_ZONE_RATIO, both)).toEqual([]);
    expect(at(both, 0, dead)).toEqual([]);
    expect(at(both, -45, dead - 1)).toEqual([]);
    expect(at(both, 0, dead + 1)).toEqual(['ArrowRight']);
  });

  it('横だけ: 横の成分だけで決め、上下に倒しても ↑↓ を押さない', () => {
    expect(at(horizontal, 0, radius)).toEqual(['ArrowRight']);
    expect(at(horizontal, 180, radius)).toEqual(['ArrowLeft']);
    expect(at(horizontal, -90, radius)).toEqual([]);
    expect(at(horizontal, 90, radius)).toEqual([]);
    // 斜めは横の成分が遊びを超えていれば、その向きのキーだけ。
    expect(at(horizontal, -45, radius)).toEqual(['ArrowRight']);
    expect(at(horizontal, -80, radius)).toEqual([]);
    expect(stickKeysOf(dead + 1, -200, radius, PAD_STICK_DEAD_ZONE_RATIO, horizontal)).toEqual(['ArrowRight']);
    expect(stickKeysOf(-dead, 0, radius, PAD_STICK_DEAD_ZONE_RATIO, horizontal)).toEqual([]);
  });

  it('縦だけ: 縦の成分だけで決め、左右に倒しても ←→ を押さない', () => {
    expect(at(vertical, -90, radius)).toEqual(['ArrowUp']);
    expect(at(vertical, 90, radius)).toEqual(['ArrowDown']);
    expect(at(vertical, 0, radius)).toEqual([]);
    expect(at(vertical, 180, radius)).toEqual([]);
  });

  it('受け付けない方向（読まない方向）は押さない', () => {
    const rightOnly = stick(null, null, null, 'ArrowRight');
    expect(at(rightOnly, 180, radius)).toEqual([]);
    expect(at(rightOnly, 0, radius)).toEqual(['ArrowRight']);
    const noDown = stick('KeyW', null, 'KeyA', 'KeyD');
    expect(at(noDown, 135, radius)).toEqual(['KeyA']);
    expect(at(noDown, -135, radius)).toEqual(['KeyW', 'KeyA']);
  });
});
