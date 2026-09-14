/**
 * 仮想パッドに出すキーを決める（仕様 3.9.6 / #494 / M14-5）。**純粋関数だけを置く。**
 *
 * # 何を決めるか
 *
 * 作品のソースが読むキーの全集合（`source_input_keys.codes`。仕様 3.9.5）から、**ページ側の規則で**
 * 十字とボタン（最大 4 つ）を決める。**保存するのは全集合で、どれをボタンにするかは保存しない**
 * ——規則を変えても埋め戻しが要らないようにするためである（3.9.5）。
 *
 * # D1 の値を信じ切らない
 *
 * {@link readInputKeyCodes} は、D1 から読んだ JSON を**許可表（`INPUT_KEY_CODES`）で絞ってから**返す。
 * 行が無い・`source_key` が NULL（tombstone）・JSON が壊れている・配列でない、はどれも空として扱い、
 * **パッドを出さない**（例外を作品ページへ漏らさない）。許可表に無い値は捨てる——ボタンの `data-code` と
 * ローダーの受け手（`src/sandbox-loader.ts`）へ届く値は、どちらも許可表の中にしか無い。
 *
 * # 文字は `code` ごとの固定の文字列
 *
 * {@link padKeyLabel} は許可表の値だけから決まる文字列を返す（**UGC 由来の文字列を使わない**。3.9.6 の 3）。
 *
 * # モジュールの最上位に副作用のある式を置かない
 *
 * `new Set(...)` や `new RegExp(...)` は関数の中で作る。最上位に置くと、esbuild がそれを副作用のある文として残し、
 * このモジュールを import する束の出力が変わりうる（`src/source-input-keys.ts` の `isStoredSourceKey` の注記。PR #504）。
 */
import { INPUT_KEY_CODES } from './input-keys.js';

/** 十字の位置。 */
export type PadDirection = 'up' | 'down' | 'left' | 'right';

/** パッドのキー 1 つ。 */
export interface PadKey {
  /** 送る `KeyboardEvent.code`（許可表の値）。 */
  readonly code: string;
  /** ボタンに出す文字（固定の文字列）。 */
  readonly label: string;
  /** 読み上げの名前。十字のボタンは「左」「上」など、文字を縮めたボタンは正式な名前（`code`）。無ければ null。 */
  readonly ariaLabel: string | null;
}

/** 十字のキー 1 つ（位置つき）。 */
export interface PadDirectionKey extends PadKey {
  /** 十字の中の位置。 */
  readonly direction: PadDirection;
}

/** パッドの中身。**どちらも空なら、パッドを出さない**（3.9.6 の「出す条件」）。 */
export interface PadLayout {
  /** 十字（上・左・右・下の順）。 */
  readonly dpad: readonly PadDirectionKey[];
  /** ボタン（並べる順。最大 {@link PAD_BUTTON_LIMIT} 個）。 */
  readonly buttons: readonly PadKey[];
}

/** ボタンの上限（3.9.6 の 2）。 */
export const PAD_BUTTON_LIMIT = 4;

/** 十字に並べる順（HTML の順。見た目の位置は `public/assets/app.css` の `@section work` が持つ）。 */
const DIRECTION_ORDER: readonly PadDirection[] = ['up', 'left', 'right', 'down'];

/** 方向ごとの矢印の `code`・WASD の `code`・文字・読み上げの名前（3.9.6 の 1 と 3）。 */
const DIRECTIONS: Readonly<Record<PadDirection, { arrow: string; wasd: string; label: string; ariaLabel: string }>> = {
  up: { arrow: 'ArrowUp', wasd: 'KeyW', label: '↑', ariaLabel: '上' },
  left: { arrow: 'ArrowLeft', wasd: 'KeyA', label: '←', ariaLabel: '左' },
  right: { arrow: 'ArrowRight', wasd: 'KeyD', label: '→', ariaLabel: '右' },
  down: { arrow: 'ArrowDown', wasd: 'KeyS', label: '↓', ariaLabel: '下' },
};

/** 並べる順の先頭（Space → KeyZ → KeyX → Enter）。**Escape は最後**（3.9.6 の 2）。 */
const LEADING_BUTTONS: readonly string[] = ['Space', 'KeyZ', 'KeyX', 'Enter'];

/** 並べる順の最後。 */
const TRAILING_BUTTON = 'Escape';

/**
 * 左右の組（`ShiftLeft` / `ShiftRight` など）の名前の部分。**左だけを残す**（3.9.6 の 2）。
 *
 * **修飾キーの 4 つだけ**である。`BracketLeft` / `BracketRight` は `[` と `]` の別のキーで、組ではない。
 */
const SIDED_MODIFIERS: readonly string[] = ['Shift', 'Control', 'Alt', 'Meta'];

/**
 * ボタンの文字の長さの上限（文字数）。**縦持ちの 2 列（幅 390px）で、キーの幅からはみ出さない長さ**にする（PR #524 の Copilot の指摘）。
 * 許可表のすべての `code` がこの長さに収まることは `test/virtual-pad.test.ts` が許可表から回して見る。
 */
export const PAD_LABEL_MAX_LENGTH = 5;

/**
 * `code` ごとの固定の短い文字（**下の規則で決まらないものをすべて書く**）。
 *
 * 規則で決まるのは `Key*`（英字 1 字）・`Digit*`（数字）・`F*`（そのまま）・`Numpad0`〜`Numpad9`（`Num0` の形）・矢印（←↑→↓）。
 * 許可表（`INPUT_KEY_CODES`）にそれ以外の `code` が増えたら、ここに書かないと単体テストが落ちる（`code` そのものは長さの上限を超えうる）。
 */
const FIXED_LABELS: Readonly<Record<string, string>> = {
  AltLeft: 'Alt',
  AltRight: 'Alt',
  Backquote: '`',
  Backslash: '\\',
  Backspace: 'BS',
  BracketLeft: '[',
  BracketRight: ']',
  CapsLock: 'Caps',
  Comma: ',',
  ContextMenu: 'Menu',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  Delete: 'Del',
  End: 'End',
  Enter: 'Enter',
  Equal: '=',
  Escape: 'Esc',
  Home: 'Home',
  Insert: 'Ins',
  IntlBackslash: '\\',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  Minus: '-',
  NumLock: 'NumLk',
  NumpadAdd: 'Num+',
  NumpadDecimal: 'Num.',
  NumpadDivide: 'Num/',
  NumpadEnter: 'NumEn',
  NumpadEqual: 'Num=',
  NumpadMultiply: 'Num*',
  NumpadSubtract: 'Num-',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
  Pause: 'Pause',
  Period: '.',
  PrintScreen: 'PrtSc',
  Quote: "'",
  ScrollLock: 'ScrLk',
  Semicolon: ';',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
};

/**
 * D1 から読んだ `source_input_keys.codes` を、許可表で絞ったキーの集合にする（仕様 3.9.5 / 3.9.7）。
 *
 * - **行が無い・NULL・文字列でない・JSON が壊れている・配列でない → 空**
 * - 配列の要素のうち、**許可表にある文字列だけ**を残す（重複は除く）
 *
 * @param raw 問い合わせの列の値（`left join` が空振りすれば null）
 * @returns 許可表の中の `code` の昇順の配列
 */
export function readInputKeyCodes(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const allowed = new Set(INPUT_KEY_CODES);
  const codes = new Set<string>();
  for (const value of parsed) {
    if (typeof value === 'string' && allowed.has(value)) {
      codes.add(value);
    }
  }
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * ボタンに出す文字（`code` ごとの固定の短い文字列。仕様 3.9.6 の 3）。**{@link PAD_LABEL_MAX_LENGTH} 文字以下。**
 *
 * `KeyZ` → `Z`、`Digit1` → `1`、`Numpad1` → `Num1`、`ShiftLeft` → `Shift`、`Escape` → `Esc`、`NumpadMultiply` → `Num*`。
 * 表にも規則にも無い `code` は `code` そのもの（許可表の外の値で、`padLayoutOf` がボタンにしない）。
 *
 * @param code `KeyboardEvent.code`
 * @returns 文字
 */
export function padKeyLabel(code: string): string {
  const fixed = Object.hasOwn(FIXED_LABELS, code) ? FIXED_LABELS[code] : undefined;
  if (fixed !== undefined) {
    return fixed;
  }
  for (const direction of DIRECTION_ORDER) {
    if (DIRECTIONS[direction].arrow === code) {
      return DIRECTIONS[direction].label;
    }
  }
  if (/^Key[A-Z]$/u.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/u.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad[0-9]$/u.test(code)) {
    return `Num${code.slice(6)}`;
  }
  // `F1`〜`F24` はそのまま（3 文字以下）。
  return code;
}

/**
 * ボタンの読み上げの名前。**文字を縮めたキーは、正式な名前（`code`）を持たせる**（`Esc` → `Escape`、`Num*` → `NumpadMultiply`）。
 *
 * 文字が `code` と同じもの（`Space` / `F1`）と、英字・数字のキー（`Z` / `1`。読み上げでもそのまま分かる）は持たない。
 *
 * @param code `KeyboardEvent.code`
 * @returns 読み上げの名前（持たなければ null）
 */
export function padKeyAriaLabel(code: string): string | null {
  if (padKeyLabel(code) === code || /^(Key[A-Z]|Digit[0-9])$/u.test(code)) {
    return null;
  }
  return code;
}

/**
 * ボタンを並べる順の鍵（小さいほど先）。Space → KeyZ → KeyX → Enter → その他 → Escape。
 *
 * @param code `KeyboardEvent.code`
 * @returns 順位（その他は同じ値で、`code` の昇順で並べる）
 */
function buttonRank(code: string): number {
  const leading = LEADING_BUTTONS.indexOf(code);
  if (leading !== -1) {
    return leading;
  }
  return code === TRAILING_BUTTON ? LEADING_BUTTONS.length + 1 : LEADING_BUTTONS.length;
}

/**
 * キーの集合から、パッドの中身を決める（仕様 3.9.6 の表示規則）。
 *
 * 1. **十字**: 矢印を 1 つでも含めば、含む矢印だけ。**このとき WASD はボタンにも出さない。**
 *    矢印を含まず WASD を含めば、含むものを十字の同じ位置に出し、WASD の `code` を送る
 * 2. **ボタン**: 十字に使ったキーと、除いた WASD を除いた残りから。Space を含めば Enter を除き、左右の組は左だけを残し、
 *    Space → KeyZ → KeyX → Enter → その他（`code` の昇順）→ Escape の順で先頭から {@link PAD_BUTTON_LIMIT} 個
 * 3. **文字**: {@link padKeyLabel}。十字のボタンは読み上げの名前を持つ
 *
 * **許可表で絞ってから決める**（呼ぶ側が絞っていなくても、許可表に無い値はどこにも出さない）。
 *
 * @param codes キーの集合
 * @returns パッドの中身
 */
export function padLayoutOf(codes: readonly string[]): PadLayout {
  const allowed = new Set(INPUT_KEY_CODES);
  const set = new Set(codes.filter((code) => allowed.has(code)));

  const arrows = DIRECTION_ORDER.some((direction) => set.has(DIRECTIONS[direction].arrow));
  const dpad: PadDirectionKey[] = [];
  for (const direction of DIRECTION_ORDER) {
    const { arrow, wasd, label, ariaLabel } = DIRECTIONS[direction];
    const code = arrows ? arrow : wasd;
    if (set.has(code)) {
      dpad.push({ code, label, ariaLabel, direction });
    }
  }

  // 十字に使ったキーと、WASD（矢印があるときは除く。無いときは十字に使った）を除く。
  const remaining = new Set(set);
  for (const direction of DIRECTION_ORDER) {
    remaining.delete(DIRECTIONS[direction].arrow);
    remaining.delete(DIRECTIONS[direction].wasd);
  }
  if (remaining.has('Space')) {
    remaining.delete('Enter');
  }
  for (const modifier of SIDED_MODIFIERS) {
    if (remaining.has(`${modifier}Left`)) {
      remaining.delete(`${modifier}Right`);
    }
  }

  const buttons = [...remaining]
    .sort((a, b) => buttonRank(a) - buttonRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PAD_BUTTON_LIMIT)
    .map((code) => ({ code, label: padKeyLabel(code), ariaLabel: padKeyAriaLabel(code) }));

  return { dpad, buttons };
}
