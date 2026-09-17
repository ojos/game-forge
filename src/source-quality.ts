/**
 * 生成されたゲームの質を測る指標（#605）。
 *
 * **このモジュールは純粋関数だけを置く。** D1 も R2 も触らない——保存は
 * `src/source-quality-metrics.ts`、完成の経路への結線は
 * `src/source-quality-routes.ts` が持つ（`src/input-keys.ts` と
 * `src/source-input-keys.ts` の分け方に合わせた）。
 *
 * ## 何のための数字か
 *
 * **これ自体は質を上げない。** #597 は基準線を取ったのに前後比較をしていないので、
 * 「生成物の質が上がった」と言えないまま終わっている。**この指標は、以後の
 * プロンプト変更の効果を費用ゼロで測れるようにするためにある**——ソースは既に
 * R2 にあり、利用者が普通に生成するたびに評価データが貯まる。
 *
 * ## 代理指標であることを忘れない
 *
 * **ここにあるのは「ゲームが面白いか」ではなく、その代理でしかない。**
 * 「クリアの語が画面に出ている」は「クリアできる」の証拠ではない（語だけ出して
 * 到達できない作品を排除できない）。**この数字を目的関数にして自動最適化すると、
 * 指標をハックする方向へ進む**——「クリアの語を必ず出す」だけを覚えて中身が
 * 伴わない、という形である。仕様 6.1 にもこの但し書きを書いた。
 *
 * 本当に効く信号は、いいね・プレイ数・フォーク率という人の反応のほうだが、
 * **1 日 10 生成の規模では動かない。** この指標は、人が読む前に「見るべき生成」を
 * 絞り込むためのものと位置づける。
 *
 * ## 字句解析を自前で持たない
 *
 * **`src/go-imports.ts` の `scanTokens` を使う。** 正規表現でソースを直接なぞると、
 * **コメントの中の `color.RGBA{...}` を数えてしまう。** あちらの字句解析は空白と
 * コメントを落とすので、数えるべきものだけが残る。字句解析をもう 1 つ書けば、
 * 二重管理になる（shared-ai-rules 12 章）。
 */
import type { GoToken } from './go-imports.js';
import { scanTokens } from './go-imports.js';

/**
 * 指標の抽出規則の版（#605）。
 *
 * **規則を変えたら上げる。** 上げると `src/source-quality-metrics.ts` の埋め直しが
 * 古い行を拾い直す。**語の一覧（{@link WIN_WORDS} / {@link LOSE_WORDS}）を変えるのも
 * 規則の変更である**——同じソースに対する答えが変わるため。
 */
export const SOURCE_QUALITY_RULE_VERSION = 1;

/**
 * 勝ち・クリアを表す語。
 *
 * **一覧は必ず取りこぼす。** #597 の最初の一覧は「かち」を持っていたが「かった」を
 * 持たず、10 本中 1 本（ケロケロ舌合戦の `かった！`）を見落として「勝ちは 4/10」と
 * 出した（正しくは 5/10）。**この指標は下限であって上限ではない。**
 *
 * **漢字を入れない。** 生成物が画面へ出す文字はひらがな・カタカナ・英数字・記号に
 * 限られる（フォントに漢字が無い。仕様 6.1）。漢字の語を入れても当たらない。
 */
export const WIN_WORDS: readonly string[] = [
  'クリア',
  'CLEAR',
  'かった',
  'カッタ',
  'かち',
  'しょうり',
  'ショウリ',
  'WIN',
  'ゴール',
  'GOAL',
  'こうりゃく',
  'たっせい',
  'せいこう',
  'おめでとう',
  'ステージ',
];

/**
 * 負け・ゲームオーバーを表す語。
 *
 * 一覧が取りこぼすことについては {@link WIN_WORDS} と同じ。
 */
export const LOSE_WORDS: readonly string[] = [
  'ゲームオーバー',
  'GAME OVER',
  'GAMEOVER',
  'まけ',
  'マケ',
  'LOSE',
  'しっぱい',
  'やられた',
  'おわり',
];

/**
 * 1 本のソースから測った指標。
 *
 * **真偽値と数だけにする。** 語そのものや識別子を持たせない——生成物由来の文字列を
 * D1 とログへ持ち出すことになる（`src/source-inspection.ts` が `offending` に上限を
 * 掛けているのと同じ理由）。
 */
export interface SourceQualityMetrics {
  /**
   * 勝ち・クリアを表す語を画面へ出しているか。
   *
   * **終端の状態があることの代理である。** #597 の基準線では、公式サンプル 10 本の
   * うちこれが真だったのは 5 本で、残りは負けるまで続くだけだった。
   */
  readonly hasWinText: boolean;
  /** 負け・ゲームオーバーを表す語を画面へ出しているか。 */
  readonly hasLoseText: boolean;
  /**
   * `color.RGBA{...}` の種類数（同じ並びは 1 つに数える）。
   *
   * 見た目の豊かさの粗い代理。#597 の基準線では 14〜39 だった。
   */
  readonly colorCount: number;
  /**
   * `ebiten.NewImage` の呼び出し回数。
   *
   * **スプライトを使っているかの代理である。** #597 の基準線では 10 本とも 0 で、
   * 全作品が毎フレーム `vector` で図形を直接描いていた（プロンプトが書き方を
   * 教えていなかったため。仕様 6.1「ゲームとして成り立たせる」）。
   */
  readonly spriteCount: number;
  /**
   * `iota` を含む `const (...)` の組で宣言された名前の数（最大の組）。
   *
   * **画面の状態を分けているかの代理である。** 0 は「そういう組が無い」。
   * 終端の状態を持たない作品は、終わる条件へ達しても描画が変わらない。
   *
   * **#605 の scope.in は「終端へ遷移する代入の有無」も挙げていたが、実装しない**
   * （PR #607 の Copilot が、票と実装の食い違いとして指摘した。**指摘のとおりなので
   * ここに理由を残す**）。**どの状態が「終端」かを、コードの形からは決められない。**
   * 名前で決めれば `stateOver` と綴った作品しか当たらず、位置で決めれば（組の最後、など）
   * 並べ方の癖を測ることになる。**勝ち・負けの語のほうが、同じことを直接に見ている**
   * ——終わったことを遊ぶ人へ伝えているかどうかである。
   */
  readonly stateCount: number;
}

/** {@link measureSourceQuality} の結果。 */
export type SourceQualityMeasurement =
  | { readonly ok: true; readonly metrics: SourceQualityMetrics }
  | { readonly ok: false; readonly reason: 'unparsable' };

/**
 * ソース 1 本を測る。
 *
 * **読み取れなければ落とす。** 閉じない文字列などで字句解析が通らないソースに対して
 * 「語は見つからなかった」を返すと、**測れなかったことと、悪い生成であることが
 * 区別できなくなる**（`inspectStringLiterals` の「読めなければ落とす」と同じ）。
 *
 * @param source Go のソースコード
 * @returns 指標、または読み取れなかった理由
 */
export function measureSourceQuality(source: string): SourceQualityMeasurement {
  const scanned = scanTokens(source);
  if (!scanned.ok) {
    return { ok: false, reason: 'unparsable' };
  }
  const { text, tokens } = scanned;

  return {
    ok: true,
    metrics: {
      hasWinText: containsAnyWord(tokens, WIN_WORDS),
      hasLoseText: containsAnyWord(tokens, LOSE_WORDS),
      colorCount: countDistinctColors(text, tokens),
      spriteCount: countCalls(tokens, 'ebiten', 'NewImage'),
      stateCount: largestIotaBlockSize(text, tokens),
    },
  };
}

/**
 * 文字列リテラルのどれかが、一覧の語を含むか。
 *
 * **エスケープは展開しない。** 生成物が画面へ出す日本語はソースへそのまま書かれる
 * （仕様 6.1 の文字描画）ので、`\u3042` のようなエスケープで書かれた語は当たらない。**当たらない
 * ことを取りこぼしとして受け入れる**——展開する側を持つと `src/output-moderation.ts`
 * の正規化と二重になり、あちらは 8.3 の判定に使われている。
 *
 * @param tokens 字句の列
 * @param words 探す語の一覧
 * @returns 1 つでも含むなら true
 */
function containsAnyWord(tokens: readonly GoToken[], words: readonly string[]): boolean {
  for (const token of tokens) {
    if (token.kind !== 'string') {
      continue;
    }
    const upper = token.value.toUpperCase();
    if (words.some((word) => upper.includes(word.toUpperCase()))) {
      return true;
    }
  }
  return false;
}

/**
 * `<pkg>.<name>(` の形の呼び出しを数える。
 *
 * **開き括弧まで見る。** 見ないと、`ebiten.NewImage` を値として渡しただけの箇所や、
 * 別の意味で同じ綴りが並んだ箇所まで数えることになる。
 *
 * @param tokens 字句の列
 * @param pkg パッケージ名
 * @param name 関数名
 * @returns 呼び出しの回数
 */
function countCalls(tokens: readonly GoToken[], pkg: string, name: string): number {
  let count = 0;
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind === 'ident' &&
      tokens[i]!.value === pkg &&
      tokens[i + 1]!.value === '.' &&
      tokens[i + 2]!.kind === 'ident' &&
      tokens[i + 2]!.value === name &&
      tokens[i + 3]!.value === '('
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * `color.RGBA{...}` の種類数を数える。
 *
 * **`color.RGBA` の後ろの `{` が、必ず色のリテラルだとは限らない。** 実測で 2 つの形に
 * 当たった（#605。基準線の 10 本へ当てて見つけた）。
 *
 * ```go
 * func clrAlpha(c color.RGBA, a uint8) color.RGBA {   // ← 関数の本体。色ではない
 * var artPalette = map[byte]color.RGBA{               // ← 要素の型。中の {…} が色
 * 	'1': {0xff, 0xcc, 0x44, 0xff},
 * }
 * ```
 *
 * **1 つ目を数えると、関数の本体がまるごと 1 色になる**（ケロケロ舌合戦で実際に起きて、
 * 18 色を 19 と数えた）。**2 つ目を数えないと、パレットの色が 1 つも数えられない**——
 * これは**プロンプトが新しく教えている書き方そのもの**なので（仕様 6.1 のスプライト）、
 * 取りこぼすと**新しい書き方を採った作品ほど色が少なく見える**という逆立ちが起きる。
 *
 * 見分け方は直前の字句で決める。
 *
 * - 直前が `)` … 関数の戻り値の型。数えない
 * - 直前が `]` … 要素の型（`map[…]` か `[]`）。**ただし `func f() []color.RGBA {` も
 *   この形になる**ので、対応する `[` の手前が `)` なら関数の戻り値として数えない。
 *   それ以外は容れ物のリテラルとみなし、**中の深さ 1 の `{…}` を 1 色ずつ**数える
 * - それ以外 … 色のリテラルそのもの。`{…}` 全体で 1 色
 *
 * **中身は原文の綴りで比べる。** 字句へ分解して組み立て直すと、空白の有無まで揃って
 * しまう。**原文の空白だけを畳んで比べる**ことで、「同じ色を 2 か所に書いた」を 1 つに
 * 数えつつ、書き方の違う 2 色を別のものとして数える。
 *
 * @param text BOM を落としたソース
 * @param tokens 字句の列
 * @returns 重複を除いた色の数
 */
function countDistinctColors(text: string, tokens: readonly GoToken[]): number {
  const seen = new Set<string>();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokens[i]!.kind !== 'ident' ||
      tokens[i]!.value !== 'color' ||
      tokens[i + 1]!.value !== '.' ||
      tokens[i + 2]!.kind !== 'ident' ||
      tokens[i + 2]!.value !== 'RGBA' ||
      tokens[i + 3]!.value !== '{'
    ) {
      continue;
    }
    const shape = literalShapeAt(tokens, i);
    if (shape === 'signature') {
      continue;
    }
    const close = matchingBrace(tokens, i + 3);
    if (close === -1) {
      continue;
    }
    if (shape === 'direct') {
      seen.add(spanKey(text, tokens[i + 3]!.start, tokens[close]!.end));
      continue;
    }
    for (const [open, end] of innerBraceGroups(tokens, i + 3, close)) {
      seen.add(spanKey(text, tokens[open]!.start, tokens[end]!.end));
    }
  }
  return seen.size;
}

/**
 * `color.RGBA{` が、色のリテラルそのものか・容れ物の要素の型か・関数の戻り値の型か。
 *
 * @param tokens 字句の列
 * @param at `color` の位置
 * @returns 形
 */
function literalShapeAt(tokens: readonly GoToken[], at: number): 'direct' | 'container' | 'signature' {
  const prev = at > 0 ? tokens[at - 1]! : null;
  if (prev === null) {
    return 'direct';
  }
  if (prev.value === ')') {
    return 'signature';
  }
  if (prev.value !== ']') {
    return 'direct';
  }
  // `]` の対になる `[` を探し、その手前を見る。`map[byte]` も `[]` も `[…]` である。
  let depth = 0;
  for (let j = at - 1; j >= 0; j -= 1) {
    if (tokens[j]!.value === ']') {
      depth += 1;
      continue;
    }
    if (tokens[j]!.value !== '[') {
      continue;
    }
    depth -= 1;
    if (depth > 0) {
      continue;
    }
    // `map[…]` なら `[` の手前が `map`。そこからさらに手前を見る。
    const before = j > 0 && tokens[j - 1]!.value === 'map' ? j - 2 : j - 1;
    return before >= 0 && tokens[before]!.value === ')' ? 'signature' : 'container';
  }
  return 'container';
}

/**
 * `{` に対応する `}` の位置を返す。
 *
 * @param tokens 字句の列
 * @param open `{` の位置
 * @returns `}` の位置（対応が見つからなければ -1）
 */
function matchingBrace(tokens: readonly GoToken[], open: number): number {
  let depth = 0;
  for (let j = open; j < tokens.length; j += 1) {
    if (tokens[j]!.value === '{') {
      depth += 1;
      continue;
    }
    if (tokens[j]!.value !== '}') {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return j;
    }
  }
  return -1;
}

/**
 * `{` と `}` の間にある、深さ 1 の `{…}` の位置の組を返す。
 *
 * @param tokens 字句の列
 * @param open 外側の `{` の位置
 * @param close 外側の `}` の位置
 * @returns `[開き, 閉じ]` の配列
 */
function innerBraceGroups(
  tokens: readonly GoToken[],
  open: number,
  close: number,
): readonly (readonly [number, number])[] {
  const groups: (readonly [number, number])[] = [];
  for (let j = open + 1; j < close; j += 1) {
    if (tokens[j]!.value !== '{') {
      continue;
    }
    const end = matchingBrace(tokens, j);
    if (end === -1 || end > close) {
      break;
    }
    groups.push([j, end]);
    j = end;
  }
  return groups;
}

/**
 * 原文の範囲を、空白を畳んだ鍵にする。
 *
 * @param text BOM を落としたソース
 * @param from 開始位置
 * @param to 終了位置
 * @returns 鍵
 */
function spanKey(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/\s+/gu, '');
}

/**
 * `iota` を含む `const (...)` の組のうち、いちばん大きいものの名前の数を返す。
 *
 * **名前は「行の先頭の識別子」で数える。** Go の `const` の組で `iota` を使う形は
 *
 * ```go
 * const (
 * 	stateTitle = iota
 * 	statePlaying
 * 	stateOver
 * )
 * ```
 *
 * のように、2 行目以降が名前だけになる。**字句だけを見ると行の区切りが消える**ので、
 * 原文の改行を使って「その行で最初に現れた識別子」を 1 つ数える。
 *
 * **`iota` 自身は数えない。** 行の先頭には来ないが、`const ( iota )` のような
 * 書き方をされたときに 1 つ余分に数えるのを避ける。
 *
 * @param text BOM を落としたソース
 * @param tokens 字句の列
 * @returns 最大の組の名前の数（そういう組が無ければ 0）
 */
function largestIotaBlockSize(text: string, tokens: readonly GoToken[]): number {
  let largest = 0;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.kind !== 'ident' || tokens[i]!.value !== 'const' || tokens[i + 1]!.value !== '(') {
      continue;
    }
    let depth = 0;
    let end = -1;
    let hasIota = false;
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (tokens[j]!.value === '(') {
        depth += 1;
        continue;
      }
      if (tokens[j]!.value === ')') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
        continue;
      }
      if (tokens[j]!.kind === 'ident' && tokens[j]!.value === 'iota') {
        hasIota = true;
      }
    }
    if (end === -1 || !hasIota) {
      continue;
    }
    largest = Math.max(largest, countLineLeadingIdents(text, tokens, i + 2, end));
  }
  return largest;
}

/**
 * 行をまたいで続く式の途中であることを示す字句。
 *
 * **この一覧に載る字句で行が終わっていたら、次の行は新しい宣言ではない。** Go は行末で
 * 文を区切るが、式が明らかに続いている位置では改行を区切りとして扱わない。
 */
const CONTINUATION_TOKENS: ReadonlySet<string> = new Set([
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '<',
  '>',
  '!',
  ',',
  '(',
  '[',
  '{',
  ':',
]);

/**
 * 字句の範囲について、**宣言の数**を返す。
 *
 * **「その行で最初に現れた識別子」をそのまま数えない**（PR #607 の Copilot の指摘）。
 * 定数の式は行をまたげるので、
 *
 * ```go
 * const (
 * 	stateA = iota +
 * 		offset
 * 	stateB
 * )
 * ```
 *
 * のように書かれると、**続きの行の `offset` を 3 つ目の状態として数えてしまう。**
 * 行が {@link CONTINUATION_TOKENS} の字句で終わっていたら、次の行は続きとみなす。
 *
 * **`iota` 自身は数えない。** 行の先頭には来ないが、`const ( iota )` のような書き方を
 * されたときに 1 つ余分に数えるのを避ける。
 *
 * @param text BOM を落としたソース
 * @param tokens 字句の列
 * @param from 範囲の先頭（含む）
 * @param to 範囲の末尾（含まない）
 * @returns 宣言の数
 */
function countLineLeadingIdents(
  text: string,
  tokens: readonly GoToken[],
  from: number,
  to: number,
): number {
  const lines = lineIndexOf(text);
  let count = 0;
  let countedLine = -1;
  for (let j = from; j < to; j += 1) {
    const token = tokens[j]!;
    if (token.kind !== 'ident' || token.value === 'iota') {
      continue;
    }
    const line = lines[token.start] ?? 0;
    if (line === countedLine) {
      continue;
    }
    // **前の字句が続きを示していたら、新しい宣言ではない。**
    const previous = j > from ? tokens[j - 1]! : null;
    if (previous !== null && CONTINUATION_TOKENS.has(previous.value)) {
      continue;
    }
    countedLine = line;
    count += 1;
  }
  return count;
}

/**
 * 位置から行番号（0 始まり）を引くための表を作る。
 *
 * **前から 1 回だけ数える。** 位置ごとに先頭から数え直すと、64KB のソースに対して
 * 二乗の走査になる。
 *
 * @param text BOM を落としたソース
 * @returns 位置 → 行番号
 */
function lineIndexOf(text: string): Uint32Array {
  const lines = new Uint32Array(text.length + 1);
  let line = 0;
  for (let i = 0; i < text.length; i += 1) {
    lines[i] = line;
    if (text[i] === '\n') {
      line += 1;
    }
  }
  lines[text.length] = line;
  return lines;
}
