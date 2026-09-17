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
 * # 方向の操作の形: 十字とスティック（#528 / #530 / M14-10）
 *
 * {@link padPlanOf} は、キーの全集合に加えて**押し続けて読むキーの集合**（`source_input_keys.held_codes`。M14-9）から、
 * **最初に出す形**（仕様 3.9.6 の「最初の形を推定する規則」1〜6）と、**切り替えたときの形**の両方を決める。
 * 画面には両方の形を HTML で置き、スクリプトは推定か覚えた形のどちらかを見せるだけである（`src/work-play.ts`）。
 * {@link readHeldCodes} は D1 の値を許可表で絞り、**NULL・壊れた JSON・配列でない値は「版 1」（null）**として返す。
 *
 * # 同じ働きの方向をボタンに出さない（#543 / M14-11）
 *
 * {@link padPlanOf} は、さらに**同じ条件式で読むキーの組**（`source_input_keys.alias_groups`。規則の版 3）を受け取り、規則 5 で右のボタンに
 * 回す方向のうち、**方向のボタンより前の順位（Space・KeyZ・KeyX。{@link LEADING_BUTTONS} の方向のボタンより前）でボタンに出るキーと同じ組にある方向を出さない**。
 * {@link readAliasGroups} は D1 の値を許可表で絞り、**NULL・壊れた JSON・配列でない値は「未記録」（null）**として返す（今の規則 5 のまま方向を回す）。
 * **推定がスティックの作品を十字にしたときの十字からも、同じ判定に当たる方向を外す**（#549 / M14-12。推定が十字の作品の十字は変えない）。
 *
 * スティックの方向の決め方は、ブラウザで動かす関数の本文 {@link STICK_KEYS_SOURCE} を 1 つだけ持つ（スクリプトへ埋め込み、
 * 単体テストは同じ本文を評価して確かめる。写しを 2 つ作らない）。
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

/**
 * 並べる順（Space → KeyZ → KeyX → 方向のボタン → Enter → その他 → Escape）。**Escape は最後**（3.9.6 の 2 と、#528 の規則 5）。
 *
 * 方向のボタン（スティックで出すときに押し続けない軸の方向を回したもの）は KeyX の後・Enter の前で、↑ → ↓ → ← → の順。
 * 十字で出すときは方向のボタンが無いので、#494 の並べる順（Space → KeyZ → KeyX → Enter → その他 → Escape）のままである。
 */
const LEADING_BUTTONS: readonly string[] = ['Space', 'KeyZ', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];

/** WASD を方向のボタンに回したときの並べる順（矢印と同じ位置）。 */
const WASD_BUTTON_RANK: Readonly<Record<string, string>> = { KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight' };

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
 * ボタンを並べる順の鍵（小さいほど先）。Space → KeyZ → KeyX → 方向のボタン（↑ → ↓ → ← →）→ Enter → その他 → Escape。
 *
 * @param code `KeyboardEvent.code`
 * @returns 順位（その他は同じ値で、`code` の昇順で並べる）
 */
function buttonRank(code: string): number {
  const leading = LEADING_BUTTONS.indexOf(Object.hasOwn(WASD_BUTTON_RANK, code) ? WASD_BUTTON_RANK[code]! : code);
  if (leading !== -1) {
    return leading;
  }
  return code === TRAILING_BUTTON ? LEADING_BUTTONS.length + 1 : LEADING_BUTTONS.length;
}

/**
 * 許可表で絞ったキーの集合（呼ぶ側が絞っていなくても、許可表に無い値はどこにも出さない）。
 *
 * @param codes キーの集合
 * @returns 許可表の中の集合
 */
function allowedSetOf(codes: readonly string[]): Set<string> {
  const allowed = new Set(INPUT_KEY_CODES);
  return new Set(codes.filter((code) => allowed.has(code)));
}

/**
 * 方向ごとに、作品が読む方向キーの `code`（読まなければ null）。**矢印を 1 つでも読めば矢印、読まなければ WASD**
 * （表示規則の 1 と、#528 の規則 1）。
 *
 * @param set 許可表で絞ったキーの集合
 * @returns 方向ごとの `code`
 */
function directionCodesOf(set: ReadonlySet<string>): Readonly<Record<PadDirection, string | null>> {
  const arrows = DIRECTION_ORDER.some((direction) => set.has(DIRECTIONS[direction].arrow));
  const codeOf = (direction: PadDirection): string | null => {
    const code = arrows ? DIRECTIONS[direction].arrow : DIRECTIONS[direction].wasd;
    return set.has(code) ? code : null;
  };
  return { up: codeOf('up'), down: codeOf('down'), left: codeOf('left'), right: codeOf('right') };
}

/**
 * 方向のキー 1 つ（十字のキー・方向のボタン）。文字は ←↑→↓、読み上げの名前は「上」など。
 *
 * @param direction 方向
 * @param code 送る `code`
 * @returns キー
 */
function directionKeyOf(direction: PadDirection, code: string): PadDirectionKey {
  const { label, ariaLabel } = DIRECTIONS[direction];
  return { code, label, ariaLabel, direction };
}

/**
 * ボタンを決める（表示規則の 2 と、#528 の規則 5）。
 *
 * **方向以外のキーを残す**（{@link buttonsOf} と {@link keyLegendOf} が共有する）。方向キー（矢印と WASD）を
 * すべて除き、Space を含めば Enter を除き（3.9.1: Enter を読む 19 本すべてで同じ働き）、左右の組は左だけを残す。
 *
 * **2 か所へ書き写さない。** 片方だけに規則を足すと、パッドには出ないキーが案内には出る、といった食い違いが
 * 黙って生まれる（`normalizeTitle` を生成側と改名側で共有しているのと同じ判断）。
 *
 * @param set 許可表で絞ったキーの集合
 * @returns 方向以外のキー（並べ替えはしない）
 */
function nonDirectionCodesOf(set: ReadonlySet<string>): Set<string> {
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
  return remaining;
}

/**
 * ボタンに出すキーを決める（仕様 3.9.6 の 2）。
 *
 * 方向キー（矢印と WASD）をすべて除いた残りに、`directionButtons`（スティックで出すときに回した方向）を足し、
 * Space を含めば Enter を除き、左右の組は左だけを残し、並べる順の先頭から {@link PAD_BUTTON_LIMIT} 個を出す。
 *
 * @param set 許可表で絞ったキーの集合
 * @param directionButtons ボタンに回す方向のキー
 * @returns ボタン
 */
function buttonsOf(set: ReadonlySet<string>, directionButtons: readonly PadDirectionKey[]): PadKey[] {
  const remaining = nonDirectionCodesOf(set);
  const directionByCode = new Map(directionButtons.map((key) => [key.code, key]));
  return [...remaining, ...directionByCode.keys()]
    .sort((a, b) => buttonRank(a) - buttonRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PAD_BUTTON_LIMIT)
    .map((code) => {
      const direction = directionByCode.get(code);
      // 方向のボタンは十字のキーと同じ文字と読み上げの名前を持つ（位置は持たない）。
      return direction === undefined
        ? { code, label: padKeyLabel(code), ariaLabel: padKeyAriaLabel(code) }
        : { code, label: direction.label, ariaLabel: direction.ariaLabel };
    });
}

/**
 * キーの集合から、パッドの中身を決める（仕様 3.9.6 の表示規則。**十字で出すときの中身**）。
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
  const set = allowedSetOf(codes);
  const codesByDirection = directionCodesOf(set);
  const dpad: PadDirectionKey[] = [];
  for (const direction of DIRECTION_ORDER) {
    const code = codesByDirection[direction];
    if (code !== null) {
      dpad.push(directionKeyOf(direction, code));
    }
  }
  return { dpad, buttons: buttonsOf(set, []) };
}

/**
 * デスクトップの操作の案内の中身（仕様 3.9.11 / M16-1 / #599）。
 *
 * **どちらも空なら、案内を出さない**（{@link PadLayout} の「出す条件」と同じ判断。「操作: なし」を全作品に並べない）。
 */
export interface KeyLegend {
  /** 方向（十字と同じ順＝上・左・右・下）。 */
  readonly directions: readonly PadDirectionKey[];
  /** 方向以外のキー（並べる順。**上限は無い**）。 */
  readonly buttons: readonly PadKey[];
}

/**
 * キーの集合から、デスクトップの操作の案内の中身を決める（仕様 3.9.11 / M16-1 / #599）。
 *
 * # パッドの規則を流用し、2 か所だけ変える
 *
 * 方向の決め方（{@link directionCodesOf}）も、方向以外の絞り方（{@link nonDirectionCodesOf}）も、並べる順
 * （{@link buttonRank}）も、文字（{@link padKeyLabel}）も**パッドと同じものを呼ぶ。** 違うのは次の 2 つだけである。
 *
 * - **{@link PAD_BUTTON_LIMIT} の 4 を掛けない。** あれは覆いの中の置き場所に収まる数で、**案内は 1 行の文字**である。
 *   4 で切ると、5 つ目以降を読む作品で「押しても効かないキーがある」ではなく「**効くキーが案内に無い**」が起きる
 * - **読み上げの名前を持たせない。** {@link padKeyAriaLabel} が要るのは押せる `<button>` の名前としてで、案内の札は
 *   押せない（`<span class="gf-chip">`。仕様 2.5.5 の「チップ: 押せない札」）
 *
 * # 方向の順は十字と同じである
 *
 * {@link DIRECTION_ORDER}（上・左・右・下）をそのまま使う。**案内のための順を別に持たない**——十字を見ている
 * タッチ端末の利用者と、案内を読むデスクトップの利用者が、違う並びの同じキーを見ることになる。
 *
 * # 許可表で絞ってから決める
 *
 * 呼ぶ側が絞っていなくても、許可表に無い値はどこにも出ない（{@link padLayoutOf} と同じ）。
 *
 * @param codes キーの集合
 * @returns 案内の中身（**どちらも空なら案内を出さない**）
 */
export function keyLegendOf(codes: readonly string[]): KeyLegend {
  const set = allowedSetOf(codes);
  const codesByDirection = directionCodesOf(set);
  const directions: PadDirectionKey[] = [];
  for (const direction of DIRECTION_ORDER) {
    const code = codesByDirection[direction];
    if (code !== null) {
      directions.push(directionKeyOf(direction, code));
    }
  }
  const buttons = [...nonDirectionCodesOf(set)]
    .sort((a, b) => buttonRank(a) - buttonRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((code) => ({ code, label: padKeyLabel(code), ariaLabel: null }));
  return { directions, buttons };
}

/** 方向の操作の形（仕様 3.9.6 の #528）。 */
export type PadShape = 'stick' | 'dpad';

/** 形の名前（HTML の属性と `localStorage` の値に使う綴り）。 */
export const PAD_SHAPES: readonly PadShape[] = ['stick', 'dpad'];

/**
 * スティックが受け付ける方向ごとの `code`（**受け付けない方向は null**）。
 *
 * **横の軸（左・右）がどちらも null なら、スティックは横の成分を捨てる**（縦も同じ）。軸の制限はこの値だけが持つ
 * （{@link STICK_KEYS_SOURCE}）。
 */
export interface PadStick {
  readonly up: string | null;
  readonly down: string | null;
  readonly left: string | null;
  readonly right: string | null;
}

/** ボタン 1 つと、それを出す形（両方の形で出すなら null）。 */
export interface PadPlanButton extends PadKey {
  /** このボタンを出す形。**null なら、どちらの形でも出す。** */
  readonly only: PadShape | null;
}

/**
 * 作品のパッドの計画（最初の形と、2 つの形それぞれの中身）。
 *
 * **方向の操作が無い作品（`estimated` が null）は、切り替えを出さない**（ボタンだけ、または何も出さない）。
 */
export interface PadPlan {
  /** 推定した最初の形（仕様 3.9.6 の規則 1〜6）。方向キーを読まなければ null。 */
  readonly estimated: PadShape | null;
  /** 十字で出すときの十字（表示規則の 1。推定がスティックなら、押し続けない軸の同じ働きの方向を外したもの。#549）。 */
  readonly dpad: readonly PadDirectionKey[];
  /** スティックで出すときに受け付ける方向。方向キーを読まなければ null。 */
  readonly stick: PadStick | null;
  /**
   * ボタン（2 つの形の和。並べる順）。**それぞれの形で出すボタンは、`only` がその形か null のものを、この順に並べたもの**である
   * ——2 つの形のボタンは同じ並べる順の先頭 {@link PAD_BUTTON_LIMIT} 個なので、和を同じ順に並べても各形の順は崩れない。
   */
  readonly buttons: readonly PadPlanButton[];
}

/**
 * キーの集合と、押し続けて読むキーの集合から、パッドの計画を決める（仕様 3.9.6 の「方向の操作の形」。#528 の規則 1〜6）。
 *
 * 1. **方向キー**は矢印を 1 つでも読めば矢印、読まなければ WASD
 * 2. **横の軸・縦の軸それぞれ、その軸のキー（1 の方向キー）を 1 つでも H で読めば「押し続ける軸」**（J でも読むときも H を優先）
 * 3. **押し続ける軸が 1 本でもあればスティック、無ければ十字。** 方向キーを読まなければ方向の操作を出さない
 * 4. スティックが受け付けるのは押し続ける軸だけ（両方なら 8 方向。決め方は {@link STICK_KEYS_SOURCE}）
 * 5. **スティックで出すときに限り**、押し続けない軸の方向（読むもの）を右のボタンに回す
 * 6. **`heldCodes` が null（版 1 の行）なら十字**（`codes` から表示規則のとおり）。行が無い作品は、呼ぶ側が `codes` を空にするので何も出ない
 *
 * **同じ働きの方向をボタンに出さない（#543）:** 規則 5 で方向のボタンを並べる前に、その方向の `code` を含む組（`aliasGroups`）に、
 * 方向のボタンより前の順位のキー（Space・KeyZ・KeyX）のうち**ボタンに出るキー**があれば、その方向を出さない。組の相手がボタンに出ない
 * （読まない・上限で落ちる）ときは出す。`aliasGroups` が null（版 2 以下の行・壊れた値）なら今の規則 5 のままである。
 * 推定が十字の作品の十字と、推定が十字の作品をスティックにしたときの中身は変えない（どちらも方向のボタンを持たない）。
 *
 * **推定がスティックの作品を十字にしたときも、同じ働きの方向を十字に出さない（#549 / M14-12）:** 押し続けない軸の方向のうち、
 * 上と同じ判定（組の相手が Space・KeyZ・KeyX でボタンに出る）に当たる方向を十字から外す。**押し続ける軸の方向は外さない**
 * （スティックで受け付ける方向で、組の相手は判定しない）。推定が十字の作品（ネコくずし・迷路。4 方向と Space を `||` で並べた大きな組を
 * 持つ）には当てない——当てると十字が消えて操作できなくなるためで、範囲は利用者が 3 案から選んだ。
 *
 * **切り替えたときの形**（手動の切り替え）:
 *
 * - **推定がスティックなら**、スティックの中身は推定のまま（受け付ける軸と方向のボタン）で、十字の中身は表示規則の 1 のとおり
 *   （ただし上の #549 で、押し続けない軸の同じ働きの方向を外す）
 * - **推定が十字なら**、スティックにしたときは作品が読む軸（押し続けるかは問わない）をすべてスティックが受け付け、方向のボタンは出さない
 *
 * 前者は、推定の形へ戻したときに最初と同じ中身に戻すためである（「覚えた形がスティック」を「推定が十字の作品をスティックにした」と
 * 同じ扱いにすると、スティックと十字を往復しただけで ↑ のボタンが消え、最初の形へ二度と戻れない）。
 *
 * @param codes キーの集合（`source_input_keys.codes`）
 * @param heldCodes 押し続けて読むキーの集合（`source_input_keys.held_codes`。版 1 の行は null）
 * @param aliasGroups 同じ条件式で読むキーの組（`source_input_keys.alias_groups`。版 2 以下の行は null。既定は null）
 * @returns パッドの計画
 */
export function padPlanOf(
  codes: readonly string[],
  heldCodes: readonly string[] | null,
  aliasGroups: readonly (readonly string[])[] | null = null,
): PadPlan {
  const set = allowedSetOf(codes);
  const dpadLayout = padLayoutOf([...set]);
  const codesByDirection = directionCodesOf(set);
  const readsDirection = DIRECTION_ORDER.some((direction) => codesByDirection[direction] !== null);
  if (!readsDirection) {
    return { estimated: null, dpad: [], stick: null, buttons: dpadLayout.buttons.map((key) => ({ ...key, only: null })) };
  }

  // 規則 2: 押し続けて読むキーは、読むキーの集合の中だけを見る（`held_codes` は `codes` の部分集合のはずだが、信じ切らない）。
  const held = heldCodes === null ? null : new Set(heldCodes.filter((code) => set.has(code)));
  const heldAxis = (a: PadDirection, b: PadDirection): boolean => {
    if (held === null) {
      return false;
    }
    const first = codesByDirection[a];
    const second = codesByDirection[b];
    return (first !== null && held.has(first)) || (second !== null && held.has(second));
  };
  const horizontalHeld = heldAxis('left', 'right');
  const verticalHeld = heldAxis('up', 'down');
  const onHeldAxis = (direction: PadDirection): boolean => (direction === 'left' || direction === 'right' ? horizontalHeld : verticalHeld);
  // 規則 3 と 6（版 1 の行は held が null で、どちらの軸も押し続けない扱い＝十字）。
  const estimated: PadShape = horizontalHeld || verticalHeld ? 'stick' : 'dpad';

  let stick: PadStick;
  let directionButtons: PadDirectionKey[] = [];
  let dpad: readonly PadDirectionKey[] = dpadLayout.dpad;
  if (estimated === 'stick') {
    // 規則 4: 押し続ける軸だけを受け付ける。
    stick = {
      up: verticalHeld ? codesByDirection.up : null,
      down: verticalHeld ? codesByDirection.down : null,
      left: horizontalHeld ? codesByDirection.left : null,
      right: horizontalHeld ? codesByDirection.right : null,
    };
    // 規則 5: 押し続けない軸の方向（読むもの）を右のボタンへ回す。
    // #543: ただし、方向のボタンより前の順位でボタンに出るキーと同じ組にある方向は回さない。前の順位のボタンは方向のボタンを
    // 足しても押し出されないので、方向のボタンを足す前のボタン（十字の形のボタンと同じ）から決める。
    // 順位の表は 1 つだけ持つ（{@link LEADING_BUTTONS} の方向のボタンより前＝Space・KeyZ・KeyX。写しを作らない）。
    const beforeDirections = LEADING_BUTTONS.slice(0, LEADING_BUTTONS.indexOf(DIRECTIONS.up.arrow));
    const shownLeading = new Set(dpadLayout.buttons.map((key) => key.code).filter((code) => beforeDirections.includes(code)));
    const sameAsShownButton = (code: string): boolean =>
      aliasGroups !== null && aliasGroups.some((group) => group.includes(code) && group.some((other) => shownLeading.has(other)));
    for (const direction of DIRECTION_ORDER) {
      const code = codesByDirection[direction];
      if (code !== null && !onHeldAxis(direction) && !sameAsShownButton(code)) {
        directionButtons.push(directionKeyOf(direction, code));
      }
    }
    // #549: 十字にしたときも、押し続けない軸の方向のうち同じ働きのもの（上の判定に当たるもの）を十字に出さない。
    // 十字の形のボタンは方向のボタンを足す前のボタンと同じなので、「ボタンに出る」の判定をそのまま使える。
    dpad = dpadLayout.dpad.filter((key) => onHeldAxis(key.direction) || !sameAsShownButton(key.code));
  } else {
    // 推定が十字の作品をスティックにしたとき: 読む軸をすべて受け付け、方向のボタンは出さない。
    stick = { ...codesByDirection };
    directionButtons = [];
  }

  const stickButtons = buttonsOf(set, directionButtons);
  const dpadButtons = dpadLayout.buttons;
  const inStick = new Set(stickButtons.map((key) => key.code));
  const inDpad = new Set(dpadButtons.map((key) => key.code));
  const merged = new Map<string, PadKey>();
  for (const key of [...stickButtons, ...dpadButtons]) {
    if (!merged.has(key.code)) {
      merged.set(key.code, key);
    }
  }
  const buttons = [...merged.values()]
    .sort((a, b) => buttonRank(a.code) - buttonRank(b.code) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((key): PadPlanButton => {
      const only: PadShape | null = inStick.has(key.code) && inDpad.has(key.code) ? null : inStick.has(key.code) ? 'stick' : 'dpad';
      return { ...key, only };
    });

  return { estimated, dpad, stick, buttons };
}

/**
 * D1 から読んだ `source_input_keys.held_codes` を、許可表で絞った集合にする（仕様 3.9.6 の #528 の「保存」）。
 *
 * - **NULL（版 1 の行・行が無い）・文字列でない・JSON が壊れている・配列でない → null**（「読み方がまだ無い」。規則 6 で十字）
 * - 配列なら、**許可表にある文字列だけ**を残す（重複は除き、`code` の昇順）。`[]` は「押し続けて読むキーは無い」で、null と区別する
 *
 * @param raw 問い合わせの列の値
 * @returns 許可表の中の `code` の昇順の配列、または null
 */
export function readHeldCodes(raw: unknown): string[] | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  // 許可表で絞る処理は、全集合の読み方と同じもの（写しを作らない）。
  return readInputKeyCodes(JSON.stringify(parsed));
}

/**
 * D1 から読んだ `source_input_keys.alias_groups` を、許可表で絞った組の配列にする（仕様 3.9.6 の #543 の「保存」と「ページの規則」）。
 *
 * - **NULL（版 2 以下の行・行が無い）・文字列でない・JSON が壊れている・配列でない → null**（「組がまだ記録されていない」。今の規則 5 のまま）
 * - 配列なら、**配列である要素だけ**を組として読み、組の中は**許可表にある文字列だけ**を残す（重複は除き、`code` の昇順）。
 *   キーが 2 つ以上残った組だけを返す。`[]` は「同じ条件式で読むキーの組は無い」で、null と区別する
 *
 * @param raw 問い合わせの列の値
 * @returns 組の配列、または null
 */
export function readAliasGroups(raw: unknown): string[][] | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const groups: string[][] = [];
  for (const value of parsed) {
    if (!Array.isArray(value)) {
      continue;
    }
    // 許可表で絞る処理は、全集合の読み方と同じもの（写しを作らない）。
    const group = readInputKeyCodes(JSON.stringify(value));
    if (group.length >= 2) {
      groups.push(group);
    }
  }
  return groups;
}

/**
 * スティックの円の半径（CSS ピクセル。仕様 3.9.6 の「大きさと遊び」）。つまみはこの縁で止まる。
 */
export const PAD_STICK_RADIUS_PX = 56;

/** スティックの遊び（半径に対する割合。中心からこの距離までは、どのキーも押さない）。 */
export const PAD_STICK_DEAD_ZONE_RATIO = 0.3;

/**
 * スティックの倒し方から、押しているキーの集合を決める関数の**本文**（ブラウザでそのまま動く JavaScript の関数式）。
 *
 * `function (dx, dy, radius, deadZoneRatio, keys)`:
 *
 * - `dx` / `dy`: 触れた位置（中心）から指までのずれ（CSS ピクセル。`dy` は下向きが正）
 * - `keys`: {@link PadStick} と同じ形（受け付けない方向は null）
 * - 返す値: 押している `code` の配列（上 → 下 → 左 → 右の順、重複なし）
 *
 * 決め方（仕様 3.9.6 の「方向の決め方」）:
 *
 * - **両方の軸を受け付けるとき**: 中心からの距離が遊び（`radius * deadZoneRatio`）以下なら何も押さない。超えたら角度を 8 等分（45° ずつ）し、
 *   斜めの扇では 2 つのキーを押す
 * - **1 本の軸だけのとき**: その軸の成分だけで決め、もう一方の軸の成分は捨てる（成分が遊びを超えたら、その向きのキー）
 * - **受け付けない方向（null）は押さない**
 *
 * **写しを作らない。** スクリプト（`src/work-play.ts`）はこの本文を埋め込み、単体テスト（`test/virtual-pad.test.ts`）は同じ本文を
 * 評価して確かめる。スクリプトはビルド工程を通らずブラウザへ届くので、素朴な書き方（`var` と関数式）に寄せる。
 */
export const STICK_KEYS_SOURCE = `function (dx, dy, radius, deadZoneRatio, keys) {
    var dead = radius * deadZoneRatio;
    var horizontal = keys.left !== null || keys.right !== null;
    var vertical = keys.up !== null || keys.down !== null;
    var up = false;
    var down = false;
    var left = false;
    var right = false;
    if (horizontal && vertical) {
      if (dx * dx + dy * dy > dead * dead) {
        // 角度を 45° ずつ 8 等分する。0 が右で、画面の y は下向きなので時計回りに 1 が右下・2 が下…7 が右上。
        var sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
        right = sector === 7 || sector === 0 || sector === 1;
        down = sector === 1 || sector === 2 || sector === 3;
        left = sector === 3 || sector === 4 || sector === 5;
        up = sector === 5 || sector === 6 || sector === 7;
      }
    } else if (horizontal) {
      left = dx < -dead;
      right = dx > dead;
    } else if (vertical) {
      up = dy < -dead;
      down = dy > dead;
    }
    var pressed = [];
    if (up && keys.up !== null) { pressed.push(keys.up); }
    if (down && keys.down !== null) { pressed.push(keys.down); }
    if (left && keys.left !== null) { pressed.push(keys.left); }
    if (right && keys.right !== null) { pressed.push(keys.right); }
    return pressed;
  }`;
