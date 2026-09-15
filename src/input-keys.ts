/**
 * 作品が読むキーを、ソースから拾う（仕様 3.9.5 / #493 / M14-4）。
 *
 * **純粋関数だけを置く。** D1 も R2 も触らない——保存は `src/source-input-keys.ts`、
 * 既存作品への埋め戻しは `scripts/input-keys-backfill.mjs` が持ち、どちらもここを呼ぶ。
 * **抽出の規則を 2 か所に書かない**（埋め戻しとエッジで拾い方がずれると、同じソースに違う行ができる）。
 *
 * # 規則（`rule_version = 4`。正本は仕様 3.9.5 と 3.9.6 の「方向の操作の形」の「保存」と「同じ働きの方向をボタンに出さない」）
 *
 * **読むキーの全集合（`codes`。版 1 から変わらない）:**
 *
 * 1. 本文から `\bebiten\.Key([A-Za-z0-9]+)\b` に当たる名前をすべて拾う
 * 2. Ebitengine v2.9.9 のキーの表で `KeyboardEvent.code` へ写す。**表に無い名前は捨てる**
 *    （`ebiten.KeyName(` の `Name`、`KeyMax` など）
 * 3. 重複を除き、`code` の昇順の配列にする。1 つも読まなければ空配列
 *
 * **押し続けて読むキー（`held_codes`。版 2 で足した。#528 / #529）:**
 *
 * 1. `ebiten.IsKeyPressed(ebiten.Key<名前>)` と `inpututil.KeyPressDuration(ebiten.Key<名前>)` の
 *    **引数にキーの識別子を直接書いたもの**だけを拾う（仕様 3.9.6 の「H の拾い方」）
 * 2. 名前は上と同じ表で `code` へ写し、表に無い名前は捨てる
 * 3. 重複を除き、`code` の昇順の配列にする。**`codes` の部分集合になる**
 *
 * 変数を渡す読み方（`ebiten.IsKeyPressed(k)`）は拾わない。その軸は押し続けない扱い（十字の側）になる。
 * `inpututil.IsKeyJustPressed` は押した瞬間の読み方で、ここでは拾わない（`codes` には入る）。
 *
 * **同じ条件式で読むキーの組（`alias_groups`。版 3 で足した。#543）:**
 *
 * 1. `inpututil.IsKeyJustPressed(ebiten.Key<名前>)`（引数の書き方は H と同じ）を **`||` だけで並べた 1 つの続き**
 *    （`||` の前後の空白・改行を含む）を 1 つの組とする。`&&` や別の関数が挟まれば、そこで組が切れる
 * 2. 組の中の名前は上と同じ表で `code` へ写し（別名は同じ `code` に寄る）、表に無い名前は捨て、重複を除いて昇順にする
 * 3. **キーが 2 つ以上の組だけを残し**、組の配列も重複を除いて並びを決める（組どうしは要素を先頭から比べた昇順）
 *
 * **作品の論理解像度（`layout_width` / `layout_height`。版 4 で足した。#514。仕様 3.9.4 の「作品のおすすめの向きで開き、あとで入れ替えられる」）:**
 *
 * 1. `Layout` メソッドがちょうど 1 つあり、その本体に `return` がちょうど 1 つあって、返す値がちょうど 2 つである
 * 2. 2 つの値がどちらも「整数のリテラル」か「パッケージの `const` / `var` でちょうど 1 回だけ整数のリテラルに束縛された名前」である
 *    （まとめた宣言 `SW, SH = 320, 240`・型つき `screenW int = 320`・`const ( … )` のまとまりを含む）
 * 3. それ以外（式・関数呼び出し・複数回の宣言や代入・引数・`Layout` の中で同じ名前を使う）は拾わない（null。解像度が分からない扱い）
 *
 * **宣言の単位で解く**（名前の最初の `=` を正規表現で拾う形は、まとめた宣言で別の値を取り違える。仕様 3.9.4）。コメントと文字列の中は見ない。
 *
 * **表は手で書かない。** `src/ebiten-keys.generated.ts` は Ebitengine のソースから生成し、
 * `scripts/ebiten-keys-table.mjs --check` が照合する（shared-ai-rules 12 章）。
 * 非推奨の別名（`KeyUp` → `ArrowUp`、`Key0` → `Digit0`）も、左右の区別の無い名前を左へ寄せる規則
 * （`KeyShift` → `ShiftLeft`）も、生成の側が持つ。
 *
 * # 規則が拾わないもの（仕様 3.9.5 で受け入れた）
 *
 * `ebiten` 以外の名前で import したソース、`AppendPressedKeys` のような列挙できない読み方。
 * コメントや文字列の中の `ebiten.Key*` は拾う（構文解析を持ち込まない）。
 */
import { EBITEN_KEY_CODES, EBITEN_KEY_CODE_LIST } from './ebiten-keys.generated.js';

/**
 * 抽出の規則の版。**規則を変えたら上げる**——保存した行のうち古い版のものが、
 * 完成の経路と埋め戻しで拾い直される（`source_input_keys.rule_version`）。
 *
 * - 1: 読むキーの全集合（`codes`）だけ（#493）。この版の行は `held_codes` が NULL である
 * - 2: 押し続けて読むキー（`held_codes`）を足した（#529。`migrations/0042_source_input_keys_held_codes.sql`）
 * - 3: 同じ条件式で読むキーの組（`alias_groups`）を足した（#543。`migrations/0043_source_input_keys_alias_groups.sql`）。
 *   版 2 以下の行は `alias_groups` が NULL である
 * - 4: 作品の論理解像度（`layout_width` / `layout_height`）を足した（#514。`migrations/0044_source_input_keys_layout.sql`）。
 *   版 3 以下の行は 2 つの列が NULL である（版 4 の行の NULL は「拾えなかった」）
 */
export const INPUT_KEYS_RULE_VERSION = 4;

/**
 * 許可表: キーの表が写す `code` の集合（仕様 3.9.7）。
 *
 * **ローダーへ埋める定数は、ここから組み立てる**（M14-5）。写しを 2 つ作らない。
 * 生成物の配列をそのまま渡す（ここで `new Set` を作らない——呼ぶ側が要る形に直す）。
 */
export const INPUT_KEY_CODES: readonly string[] = EBITEN_KEY_CODE_LIST;

/**
 * `ebiten.Key<名前>` の `<名前>` を `code` へ写す。表に無ければ null。
 *
 * **`Object.hasOwn` で引く。** `ebiten.Keyconstructor` のような綴りでも、
 * `Object.prototype` の値を `code` として返さない。
 *
 * @param name `Key` の後ろの名前（例: `Space`、`Up`）
 * @returns `KeyboardEvent.code`、または null
 */
export function ebitenKeyCode(name: string): string | null {
  return Object.hasOwn(EBITEN_KEY_CODES, name) ? (EBITEN_KEY_CODES[name] ?? null) : null;
}

/**
 * ソースが読むキーの `code` を拾う（仕様 3.9.5 の規則）。
 *
 * @param source Go のソース本文
 * @returns 重複を除いた `code` の昇順の配列（読まなければ空配列）
 */
export function extractInputKeyCodes(source: string): string[] {
  const codes = new Set<string>();
  // **正規表現を関数の中で作る。** `g` の付いた正規表現は `lastIndex` を持つので、
  // モジュールの値として共有すると、呼び出しの間で状態が漏れる。
  for (const match of source.matchAll(/\bebiten\.Key([A-Za-z0-9]+)\b/g)) {
    const code = ebitenKeyCode(match[1] ?? '');
    if (code !== null) {
      codes.add(code);
    }
  }
  return sortedCodes(codes);
}

/**
 * ソースが**押し続けて読む**キーの `code` を拾う（仕様 3.9.6 の「H の拾い方」。規則の版 2）。
 *
 * **H は `ebiten.IsKeyPressed` と `inpututil.KeyPressDuration` である。** 引数にキーの識別子を直接書いたもの
 * （括弧の内側の空白・改行と、引数を複数行に書いたときに gofmt が付ける末尾のカンマは許す）だけを拾い、
 * 変数や式を渡す読み方は拾わない。
 *
 * @param source Go のソース本文
 * @returns 重複を除いた `code` の昇順の配列（押し続けて読むキーが無ければ空配列）
 */
export function extractHeldInputKeyCodes(source: string): string[] {
  const codes = new Set<string>();
  // **正規表現を関数の中で作る**（上と同じ理由。モジュールの最上位に置くと、束のモジュールから
  // import されたときに副作用のある式として残りうる——#504）。
  for (const match of source.matchAll(
    /\b(?:ebiten\.IsKeyPressed|inpututil\.KeyPressDuration)\(\s*ebiten\.Key([A-Za-z0-9]+)\s*,?\s*\)/g,
  )) {
    const code = ebitenKeyCode(match[1] ?? '');
    if (code !== null) {
      codes.add(code);
    }
  }
  return sortedCodes(codes);
}

/**
 * ソースが**同じ条件式で読むキーの組**を拾う（仕様 3.9.6 の「同じ働きの方向をボタンに出さない」の「組の拾い方」。規則の版 3）。
 *
 * `inpututil.IsKeyJustPressed(ebiten.Key…)` を `||` だけで並べた 1 つの続きを 1 つの組とする。例:
 * `inpututil.IsKeyJustPressed(ebiten.KeySpace) || inpututil.IsKeyJustPressed(ebiten.KeyUp) || inpututil.IsKeyJustPressed(ebiten.KeyW)`
 * は `["ArrowUp","KeyW","Space"]` の組になる。**`&&` や別の関数（`ebiten.IsKeyPressed` など）が挟まれば、そこで組が切れる。**
 * 引数はキーの識別子を直接書いたものだけを拾い（括弧の内側の空白・改行・末尾のカンマは許す。H の拾い方と同じ）、
 * 変数や式を渡した呼び出しは続きを切る。**続きの外側で `&&` に接する端の呼び出しは組から外す**（`&&` は `||` より強く結びつくので、
 * `ok && IsKeyJustPressed(KeyZ) || IsKeyJustPressed(KeyUp)` の Z は Up と同じ働きではない）。
 *
 * **文の区切りを見ない**（構文解析を持ち込まない。`codes` と同じく、コメントや文字列の中の呼び出しも拾う）。
 *
 * @param source Go のソース本文
 * @returns 組の配列。組の中は `code` の昇順で 2 つ以上、組は重複を除き、要素を先頭から比べた昇順（無ければ空配列）
 */
export function extractAliasGroups(source: string): string[][] {
  // **正規表現を関数の中で組み立てる**（上と同じ理由。束のモジュールの最上位に副作用のある式を置かない）。
  const call = String.raw`\binpututil\.IsKeyJustPressed\(\s*ebiten\.Key([A-Za-z0-9]+)\s*,?\s*\)`;
  const run = new RegExp(`${call}(?:\\s*\\|\\|\\s*${call})+`, 'g');
  const groups = new Map<string, string[]>();
  /** 空白とコメントの位置の印（組が 1 つでも見つかったときだけ作る）。 */
  let gaps: Uint8Array | undefined;
  for (const match of source.matchAll(run)) {
    const names = [...match[0].matchAll(new RegExp(call, 'g'))].map((inner) => inner[1] ?? '');
    // **`&&` は `||` より強く結びつく**（Go の演算子の優先順位）。続きの外側で `&&` に接する呼び出しは、
    // `a && IsKeyJustPressed(KeyZ) || IsKeyJustPressed(KeyUp)` の Z のように `&&` の片側で、ほかのキーと同じ働きではないので組から外す。
    // **`&&` との間の空白とコメント（ブロックコメント・行コメント）を越えて見る**（`ok && /* 接地 */ IsKeyJustPressed(KeyZ) || …` でも Z を外す。
    // PR #546 の Copilot の指摘）。コメントかどうかは、ソースを前から 1 回だけ字句として読んだ印（{@link gapMaskOf}）で決める——
    // 後ろ向きに `*/` や `//` を探すと、行コメントや文字列の中の `*/`・`//`、コメントの中の `/*` で誤る（loop-gate の第二意見の指摘）。
    // ソースからコメントを消した写しは作らず、端の前後の位置が空白かコメントかだけを引く。
    gaps ??= gapMaskOf(source);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    let before = start - 1;
    while (before >= 0 && gaps[before] === 1) {
      before -= 1;
    }
    if (before >= 1 && source[before] === '&' && source[before - 1] === '&' && gaps[before - 1] === 0) {
      names.shift();
    }
    let after = end;
    while (after < source.length && gaps[after] === 1) {
      after += 1;
    }
    if (source.startsWith('&&', after) && gaps[after] === 0 && gaps[after + 1] === 0) {
      names.pop();
    }
    const codes = new Set<string>();
    for (const name of names) {
      const code = ebitenKeyCode(name);
      if (code !== null) {
        codes.add(code);
      }
    }
    if (codes.size >= 2) {
      const group = sortedCodes(codes);
      groups.set(JSON.stringify(group), group);
    }
  }
  return [...groups.values()].sort(compareGroups);
}

/** 作品の論理解像度（`Layout` が返す幅と高さ。仕様 3.9.4）。 */
export interface LayoutSize {
  readonly width: number;
  readonly height: number;
}

/**
 * ソースの `Layout` が返す論理解像度を拾う（仕様 3.9.4 の「論理解像度の拾い方」。規則の版 4）。
 *
 * **拾うのは次のすべてが成り立つときだけで、1 つでも崩れたら null（解像度が分からない）を返す。**
 *
 * 1. パッケージの最上位に `func (<受け手>) Layout(` がちょうど 1 つある
 * 2. その本体に `return` がちょうど 1 つあり、返す値が `,` で区切ってちょうど 2 つである
 * 3. 2 つの値がどちらも、10 進の整数のリテラル（正の値）か、次を満たす名前である
 *    - パッケージの `const` / `var` の宣言で、**ちょうど 1 回だけ**、10 進の整数のリテラルに束縛されている
 *      （まとめた宣言 `SW, SH = 320, 240` は位置で対応させる。型は無いか整数の型だけ。`const ( … )` の値を省いた行
 *      （前の式の繰り返し）と、値の無い `var` は「リテラルでない束縛」として数える）
 *    - どの関数の中でも代入されていない（`SW = …`・`SW += …`・`SW++`。同じ名前の局所変数への代入も、区別せず代入と数える）
 *    - `Layout` の受け手・引数・本体（`return` の文の外）に同じ名前が出てこない（局所の宣言で隠される形を拾わない）
 *
 * **宣言の単位で解く。** 名前の直後の最初の `=` を正規表現で拾うと、`SW, SH = 480, 270` の `SH` を 480 と取り違える（仕様 3.9.4 の実例）。
 * ここは宣言を `=` の左右に分け、左の名前の並びと右の値の並びを位置で対応させる。**コメントと文字列の中は見ない**
 * （{@link maskCommentsAndStrings} で消した写しの上で読む）。構文解析は持ち込まず、式を評価しない。
 *
 * @param source Go のソース本文
 * @returns 幅と高さ、または null
 */
export function extractLayoutSize(source: string): LayoutSize | null {
  const code = maskCommentsAndStrings(source);
  const depths = braceDepthsOf(code);
  // **正規表現を関数の中で作る**（上の関数と同じ理由。束のモジュールの最上位に副作用のある式を置かない）。
  const heads = [...code.matchAll(/\bfunc\s*\(([^()]*)\)\s*Layout\s*\(/gu)].filter((head) => depths[head.index] === 0);
  if (heads.length !== 1) {
    return null;
  }
  const head = heads[0]!;
  const paramsOpen = head.index + head[0].length - 1;
  const paramsClose = closingOf(code, paramsOpen, '(', ')');
  if (paramsClose === -1) {
    return null;
  }
  const bodyOpen = code.indexOf('{', paramsClose);
  if (bodyOpen === -1) {
    return null;
  }
  const bodyClose = closingOf(code, bodyOpen, '{', '}');
  if (bodyClose === -1) {
    return null;
  }
  const body = code.slice(bodyOpen + 1, bodyClose);
  const returns = [...body.matchAll(/\breturn\b/gu)];
  if (returns.length !== 1) {
    return null;
  }
  const returnAt = returns[0]!.index;
  const valuesStart = returnAt + 'return'.length;
  const valuesEnd = statementEndOf(body, valuesStart, true);
  const values = splitTopLevel(body.slice(valuesStart, valuesEnd), ',').map((value) => value.trim());
  if (values.length !== 2) {
    return null;
  }
  // `Layout` の受け手・引数・結果の並び・本体のうち、`return` の文の外（局所の宣言で名前が隠される形を拾わない）。
  const outsideReturn = [head[1] ?? '', code.slice(paramsOpen, bodyOpen), body.slice(0, returnAt), body.slice(valuesEnd)].join('\n');
  let bindings: Map<string, PackageBinding> | undefined;
  const resolved = values.map((value): number | null => {
    const literal = decimalLiteralOf(value);
    if (literal !== null) {
      return literal;
    }
    if (!isIdentifier(value) || value === '_' || mentions(outsideReturn, value)) {
      return null;
    }
    bindings ??= packageBindingsOf(code, depths);
    const binding = bindings.get(value);
    if (binding === undefined || binding.count !== 1 || binding.value === null || assignedInFunctions(code, depths, value)) {
      return null;
    }
    return binding.value;
  });
  const width = resolved[0] ?? null;
  const height = resolved[1] ?? null;
  return width === null || height === null ? null : { width, height };
}

/** パッケージの `const` / `var` の名前 1 つの束縛（{@link packageBindingsOf}）。 */
interface PackageBinding {
  /** 宣言に現れた回数。 */
  readonly count: number;
  /** 束縛が 10 進の整数のリテラルならその値、そうでなければ null（2 回以上現れた名前では意味を持たない）。 */
  readonly value: number | null;
}

/**
 * 位置ごとの `{` の深さ（その位置の字を読む前に、閉じていない `{` の数）を作る。
 *
 * @param code {@link maskCommentsAndStrings} の写し
 * @returns 位置ごとの深さ（長さは `code.length`）
 */
function braceDepthsOf(code: string): Int32Array {
  const depths = new Int32Array(code.length);
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    depths[index] = depth;
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}' && depth > 0) {
      depth -= 1;
    }
  }
  return depths;
}

/**
 * 開き括弧に対応する閉じ括弧の位置を返す（無ければ -1）。
 *
 * @param code {@link maskCommentsAndStrings} の写し
 * @param open 開き括弧の位置
 * @param opener 開き括弧の字
 * @param closer 閉じ括弧の字
 * @returns 閉じ括弧の位置、または -1
 */
function closingOf(code: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === opener) {
      depth += 1;
    } else if (code[index] === closer) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * 行末で Go が文の区切り（セミコロン）を入れるか（言語仕様の「Semicolons」の規則を、行の最後の字で近似する）。
 *
 * 最後の字が識別子・数・引用符（文字列やルーンの終わり）・`)`・`]`・`}` か、最後の 2 字が `++` / `--` なら入れる。
 *
 * @param line 文の始まりから行末までの写し
 * @param emptyEnds 空白しか無いときに区切りとみなすか
 * @returns 区切りを入れるか
 */
function insertsSemicolon(line: string, emptyEnds: boolean): boolean {
  const trimmed = line.trimEnd();
  if (trimmed === '') {
    return emptyEnds;
  }
  if (trimmed.endsWith('++') || trimmed.endsWith('--')) {
    return true;
  }
  const last = trimmed[trimmed.length - 1]!;
  return last === STRING_FILLER || /[\p{L}\p{Nd}_)\]}"'`]/u.test(last);
}

/**
 * `from` から始まる文の終わり（`;`・括弧の外の閉じ括弧・区切りの入る改行の位置。無ければ末尾）を返す。
 *
 * @param code {@link maskCommentsAndStrings} の写し（の一部）
 * @param from 文の中身の始まり
 * @param emptyEnds 中身が空のまま改行に来たら終わりとみなすか（`return` の直後の改行は文を終える）
 * @returns 終わりの位置
 */
function statementEndOf(code: string, from: number, emptyEnds: boolean): number {
  let depth = 0;
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    } else if (depth === 0 && char === ';') {
      return index;
    } else if (depth === 0 && char === '\n' && insertsSemicolon(code.slice(from, index), emptyEnds)) {
      return index;
    }
  }
  return code.length;
}

/**
 * 括弧の外にある区切りの字で分ける。
 *
 * @param text 写しの一部
 * @param separator 区切りの字
 * @returns 分けた並び（区切りが無ければ 1 つ）
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (depth === 0 && char === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * 10 進の整数のリテラル（正の値で、安全に扱える整数）なら値を返す。
 *
 * @param text 値の写し（前後の空白を除いたもの）
 * @returns 値、または null
 */
function decimalLiteralOf(text: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Go の識別子の形か。
 *
 * @param text 写しの一部
 * @returns 識別子なら true
 */
function isIdentifier(text: string): boolean {
  return /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(text);
}

/**
 * 写しの中に、その名前が（セレクタ `x.name` の右側でなく）単独の識別子として出てくるか。
 *
 * @param code 写しの一部
 * @param name 識別子（{@link isIdentifier} を満たすもの。正規表現の特別な字を含まない）
 * @returns 出てくるなら true
 */
function mentions(code: string, name: string): boolean {
  return new RegExp(`(?<![.\\p{L}\\p{Nd}_])${name}(?![\\p{L}\\p{Nd}_])`, 'u').test(code);
}

/**
 * パッケージの最上位の `const` / `var` の宣言から、名前ごとの束縛を集める。
 *
 * **関数の本体と複合リテラルの中（`{` の内側）は見ない。** `const ( … )` / `var ( … )` のまとまりは文（Go が区切りを入れる改行と `;`）ごとに、
 * まとまりでない宣言は文の終わりまでを 1 つの宣言として読む。宣言は括弧の外の最初の `=` で左右に分ける——**宣言の左側（名前の並びと型）は
 * `=` を含まない**ので、最初の `=` が束縛の `=` である。
 *
 * @param code {@link maskCommentsAndStrings} の写し
 * @param depths {@link braceDepthsOf} の深さ
 * @returns 名前ごとの束縛
 */
function packageBindingsOf(code: string, depths: Int32Array): Map<string, PackageBinding> {
  // `{` の内側と `{` `}` そのものを空白にした写し（改行は残す）。
  const topChars: string[] = [];
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    topChars.push(char === '\n' ? '\n' : depths[index] === 0 && char !== '{' ? char : ' ');
  }
  const top = topChars.join('');
  const bindings = new Map<string, PackageBinding>();
  const record = (spec: string): void => {
    const equals = splitTopLevel(spec, '=')[0]!.length;
    const hasValues = equals < spec.length;
    const left = splitTopLevel(spec.slice(0, equals), ',').map((part) => part.trim());
    const lastPart = left[left.length - 1] ?? '';
    const lastName = /^[\p{L}_][\p{L}\p{Nd}_]*/u.exec(lastPart)?.[0] ?? '';
    const type = lastPart.slice(lastName.length).trim();
    const names = [...left.slice(0, -1), lastName];
    if (!names.every(isIdentifier)) {
      return;
    }
    const values = hasValues ? splitTopLevel(spec.slice(equals + 1), ',').map((value) => value.trim()) : [];
    const typeIsInteger = type === '' || /^(?:u?int(?:8|16|32|64)?|uintptr|byte|rune)$/u.test(type);
    names.forEach((name, position) => {
      if (name === '_') {
        return;
      }
      // 値の無い `const` の行は前の式の繰り返し、値の無い `var` はゼロ値——どちらも「リテラルでない束縛」になる。
      const value = hasValues && values.length === names.length && typeIsInteger ? decimalLiteralOf(values[position] ?? '') : null;
      bindings.set(name, { count: (bindings.get(name)?.count ?? 0) + 1, value });
    });
  };
  for (const keyword of top.matchAll(/\b(?:const|var)\b/gu)) {
    let at = keyword.index + keyword[0].length;
    while (at < top.length && /\s/u.test(top[at]!)) {
      at += 1;
    }
    if (top[at] === '(') {
      const close = closingOf(top, at, '(', ')');
      const group = top.slice(at + 1, close === -1 ? top.length : close);
      let from = 0;
      while (from < group.length) {
        const end = statementEndOf(group, from, false);
        const spec = group.slice(from, end).trim();
        if (spec !== '') {
          record(spec);
        }
        from = end + 1;
      }
    } else {
      record(top.slice(at, statementEndOf(top, at, false)).trim());
    }
  }
  return bindings;
}

/**
 * 関数の中（`{` の内側）で、その名前に代入しているか（`name = …`・`a, name = …`・`name += …`・`name++`）。
 *
 * **局所変数か、パッケージの変数かは区別しない**（区別には有効範囲の解析が要る。代入があれば「分からない」に倒す）。
 *
 * @param code {@link maskCommentsAndStrings} の写し
 * @param depths {@link braceDepthsOf} の深さ
 * @param name 識別子（{@link isIdentifier} を満たすもの）
 * @returns 代入していれば true
 */
function assignedInFunctions(code: string, depths: Int32Array, name: string): boolean {
  for (const step of code.matchAll(new RegExp(`(?<![.\\p{L}\\p{Nd}_])${name}\\s*(?:\\+\\+|--)`, 'gu'))) {
    if ((depths[step.index] ?? 0) > 0) {
      return true;
    }
  }
  const target = new RegExp(`(?:^|[\\s(])${name}$`, 'u');
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] !== '=' || depths[index] === 0) {
      continue;
    }
    if (code[index + 1] === '=') {
      // `==`（比較）。
      index += 1;
      continue;
    }
    const before = code[index - 1] ?? '';
    // `!=`・`:=`（宣言）・`<=`・`>=`（比較。`<<=` / `>>=` は代入）は代入として見ない。
    if (before === '!' || before === ':' || ((before === '<' || before === '>') && code[index - 2] !== before)) {
      continue;
    }
    let operator = index;
    while (operator > 0 && '+-*/%&|^<>'.includes(code[operator - 1]!)) {
      operator -= 1;
    }
    let start = operator;
    while (start > 0 && !'\n;{}'.includes(code[start - 1]!)) {
      start -= 1;
    }
    const left = code.slice(start, operator);
    // 関数の中の `var name = …` / `const name = …` は局所の宣言で、パッケージの名前への代入ではない（局所の `var ( … )` の中の行は代入と区別できず、代入に数える）。
    if (/^\s*(?:var|const)\b/u.test(left)) {
      continue;
    }
    if (splitTopLevel(left, ',').some((part) => target.test(part.trim()))) {
      return true;
    }
  }
  return false;
}

/**
 * ソースの各位置が「空白かコメント」なら 1、それ以外（コード・文字列・ルーンの中）なら 0 の印を作る（組の端が `&&` に接するかを見るため）。
 *
 * 字句の読み方は {@link maskCommentsAndStrings} の 1 つだけで、そこでコメントは空白に、文字列とルーンは空白でない字に置き換わるので、
 * **置き換えた写しの空白の位置がそのまま印になる。**
 *
 * @param source Go のソース本文
 * @returns 位置ごとの印（長さは `source.length`）
 */
function gapMaskOf(source: string): Uint8Array {
  const masked = maskCommentsAndStrings(source);
  const gaps = new Uint8Array(source.length);
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      gaps[index] = 1;
    }
  }
  return gaps;
}

/** 文字列とルーンの中身を置き換える字（空白でも、識別子・数・括弧・演算子でもない字）。 */
const STRING_FILLER = '\u0001';

/**
 * コメントを空白に、文字列とルーンの中身を {@link STRING_FILLER} に置き換えた写しを作る（長さと位置は変えない）。
 *
 * **前から 1 回だけ字句として読む。** Go の字句の規則のうち、行コメント（`//` から行末まで。改行そのものは残す）・ブロックコメント
 * （中の改行は残し、ほかは空白）・解釈される文字列（`"…"`。バックスラッシュで次の 1 字を飛ばし、行末で終わる）・生文字列（`` `…` ``。
 * 行をまたぐ）・ルーン（`'…'`）だけを見る。**引用符そのものは残す**（文字列の値はコードの 1 つの値として残り、整数のリテラルには見えない）。
 * 文字列の中の `//`・`/*`・`*\/` はコメントにならず、コメントの中の `/*` や `"` は何も始めない。構文解析は持ち込まない。
 *
 * @param source Go のソース本文
 * @returns 置き換えた写し（長さは `source.length`）
 */
function maskCommentsAndStrings(source: string): string {
  const out = source.split('');
  let index = 0;
  const fill = (from: number, to: number, keepNewlines: boolean, filler: string): void => {
    for (let at = from; at < to && at < out.length; at += 1) {
      out[at] = keepNewlines && source[at] === '\n' ? '\n' : filler;
    }
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index);
      const stop = newline === -1 ? source.length : newline;
      fill(index, stop, true, ' ');
      index = stop;
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : close + 2;
      fill(index, stop, true, ' ');
      index = stop;
    } else if (char === '"' || char === "'") {
      const open = index;
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== '\n') {
        index += source[index] === '\\' ? 2 : 1;
      }
      fill(open + 1, Math.min(index, source.length), false, STRING_FILLER);
      // 閉じる引用符を飛ばす（閉じていない文字列＝コンパイルできないソースでは、行末の改行を飛ばす）。
      index += 1;
    } else if (char === '`') {
      const close = source.indexOf('`', index + 1);
      const stop = close === -1 ? source.length : close;
      fill(index + 1, stop, false, STRING_FILLER);
      index = stop + 1;
    } else {
      index += 1;
    }
  }
  return out.join('');
}

/**
 * 組どうしの並び（要素を先頭から code unit の順で比べ、先頭が同じなら短い方が先）。
 *
 * @param a 組
 * @param b 組
 * @returns 負なら a が先
 */
function compareGroups(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/**
 * `code` の集合を昇順の配列にする。
 *
 * **昇順は code unit の順で決める**（`localeCompare` にしない）。埋め戻しの Node と
 * Worker で並びが変わらないようにするため。
 *
 * @param codes `code` の集合
 * @returns 昇順の配列
 */
function sortedCodes(codes: ReadonlySet<string>): string[] {
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
