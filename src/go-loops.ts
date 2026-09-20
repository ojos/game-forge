/**
 * 終了条件を持たない繰り返しの検査（6.1 / 7.2 / #730）。
 *
 * ## なぜ import と指示の隣に、もう 1 つ軸が要るのか
 *
 * 7.2 の封じ込めは「**外へ出られないこと**」を強く保証している（`default-src 'none'`、
 * `connect-src` はその作品の `.wasm` 1 本のみ、不透明オリジン、cookie なし）。したがって
 * 情報送出もマイニングも DDoS 踏み台も成立しない——いずれも**任意の宛先**を要する。
 * **残るのは、外へ何も送らずにその場で CPU を回す形だけ**である。
 *
 * **その形を止めている層が 1 枚も無かった。** 7.1 のビルドの封じ込めはビルドが終わった
 * 時点で役目を終え（7.2「7.1 と 7.2 の分担」）、**30 秒のビルド上限は実行時には効かない。**
 * 6.1 の許可パッケージ一覧も**終わらないループには 1 つも関係しない**——`for {}` は
 * import を 1 つも要らない。生成後の検査が見ていたのはサイズ・import・指示・NG 語だけで、
 * **1 フレームの中で何が起きるかを見ている場所が無かった。**
 *
 * **暴走した作品はタブごと固まる**（7.2 の実測。同一サイトの sandboxed iframe は
 * OOPIF にならないので、作品は親ページと同じ主スレッドに乗る）。**ページの中に回復手段が
 * 無く、遊ぶ人はタブを閉じるしかない。**
 *
 * ## 有限のループは通す（利用者の決定）
 *
 * **毎フレームの描画で画素・敵・弾を回すループは正当な書き方である。** 反復回数の上界を
 * 見積もって落とす形は採らない——**変数を使った上限は静的には見積もれず**、正当な作品を
 * 落とすと利用者の生成枠を 1 つ奪う（違反は再生成に回さず拒否する。5.2-5）。
 *
 * **ここが落とすのは「終了条件を持たないこと」が字句から読み取れるものだけ**である。
 * 判定は {@link UNBOUNDED_LOOP_FORMS} の 2 つの形に閉じており、**迷ったら通す。**
 * これは `src/go-imports.ts` の「判定に迷ったら拒否する」と**向きが逆である**。
 * 理由は守っている対象が違うためで、あちらは 7.1 のビルドホスト（破れると任意コード実行）、
 * こちらは遊ぶ人の端末の CPU（破れるとタブが固まる。**送出はできない**）である。
 * **通り抜けた形は 7.2 の「受け入れた劣化」に書く。**
 *
 * ## 字句解析を 2 つ持たない
 *
 * 走査は `scanTokens`（`src/go-imports.ts`）を借りる。**コメントと文字列リテラルの中の
 * `for` を拾わないこと**がこの検査の要点で、それを正しく行う実装は既にあの 1 つだけである
 * （shared-ai-rules 12 章）。**Go のパーサは使えない**——この検査はエッジ（Workers）でも
 * 走るため、`go/parser` を持つのはビルド実行環境だけである（`src/go-imports.ts` 冒頭）。
 *
 * ## 同期の純粋関数のままにする
 *
 * `Env` を受け取らない。エッジ（`src/generate.ts`）とオーケストレータ
 * （`src/orchestrator/pipeline.ts`）が**同じ関数を借りる**形を崩さないためで、
 * ここが環境を要求し始めると、実行環境によって検査が違う状態を作れるようになる。
 */
import type { GoToken } from './go-imports.js';
import { scanTokens } from './go-imports.js';

/**
 * 終了条件を持たない繰り返しがあった（6.1 / #730）。
 *
 * **`not-allowed`（許可外の import）とも `directive-not-allowed`（禁止指示）とも別の
 * 理由にする。** 3 つは見ている軸が違い、**利用者が次に何を直せばよいかも違う**
 * （一覧から外す / 指示を消す / 繰り返しに終わり方を足す）。
 */
export type UnboundedLoopRejection = 'unbounded-loop';

/** 拒否の理由（{@link UnboundedLoopRejection} の唯一の値）。 */
export const UNBOUNDED_LOOP_REJECTION: UnboundedLoopRejection = 'unbounded-loop';

/** 拒否する繰り返しの形 1 つ。 */
export interface UnboundedLoopForm {
  /**
   * 形の名前。**拒否の応答へそのまま出る**ので、生成物由来の文字列を含めない
   * （`src/source-inspection.ts` の `offending` の規律）。
   */
  readonly name: string;
  /** なぜ拒否するか。仕様書 6.1 へ出す。 */
  readonly reason: string;
}

/**
 * 拒否する繰り返しの形（6.1 / #730）。
 *
 * **2 つに閉じている。** どちらも「条件が無いか、条件が定数 true である」ことが
 * **字句だけで読み取れる**形で、遊びの入力にも状態にも依存しない。
 *
 * **`for i := 0; i < n; i++` も `for cond` も `for range` も、この表に無い。**
 * 反復の回数は変数に依存し、静的には決まらない（モジュール冒頭「有限のループは通す」）。
 */
export const UNBOUNDED_LOOP_FORMS: readonly UnboundedLoopForm[] = [
  {
    name: 'for {}',
    reason: '条件が無い。1 フレームの中で主スレッドを明け渡さないまま回り続ける',
  },
  {
    name: 'for true {}',
    reason: '条件が定数 true（`true` / `!false` / それらを括弧で囲んだ形）。上と同じ結果になる',
  },
];

/**
 * 繰り返しの条件として読む字句の上限。
 *
 * **実際の条件はこれよりはるかに短い**（`for i := 0; i < len(g.enemies); i++` で 15 字句
 * 程度）。上限を置くのは、`for` だけが並んだソースで探索が毎回終端まで走るのを防ぐため
 * である。超えたものは「分からない」＝**通す**（この検査の既定の向き）。
 */
const MAX_LOOP_HEADER_TOKENS = 256;

/** 仕様書 6.1 のこの表を切り出すときの見出し。仕様書側を変えたらこちらも変える。 */
export const UNBOUNDED_LOOP_SECTION_HEADING = '#### 終了条件を持たない繰り返し';

/**
 * 繰り返しの本体に現れたとき、**制御を返しうる**とみなす字句。
 *
 * **ここに 1 つでも現れたら通す。** 現れた場所が入れ子の `switch` の中でも、別の
 * 繰り返しの中でも区別しない——区別するには本文の構文解析が要り、**間違えたときの
 * 損害は「正当な作品の生成枠を 1 つ奪う」側にある**（モジュール冒頭）。
 *
 * - `break` / `return` / `goto`: 繰り返しを出る経路そのもの
 * - `panic`: 遊びは壊れるが、フレームは返る（回り続けない）
 * - `select`: チャネルの待ちで**止まる**形。これは CPU を回す形ではない
 *   （この票が止めるのは「主スレッドを明け渡さないまま回り続ける」形である）。
 *   受信の `<-` も同じ理由で数えるが、**綴りだけでは比較と見分けられない**ので
 *   {@link isChannelReceive} が位置まで見る
 */
const CONTROL_RETURNING_KEYWORDS: readonly string[] = ['break', 'return', 'goto', 'panic', 'select'];

/**
 * Go の予約語。**識別子と区別するためだけに持つ。**
 *
 * 使うのは {@link endsOperand} で、「直前の字句が値の終わりか」を判定する。
 * `case <-ch:` の `case` は識別子の綴りをしているが**値ではない**ので、
 * これを値の終わりと読むと受信を比較と読み違える。
 */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);

/**
 * ソース全体から、終了条件を持たない繰り返しを探す（#730）。
 *
 * **読み取れないソースは空を返す。** 読めないこと自体は `inspectGoImports` が
 * `unparsable` として先に落とす（`src/source-inspection.ts` の呼び出し順）。ここで
 * 別の理由を作ると、**同じ 1 つの事実に 2 つの拒否理由が生まれる。**
 *
 * @param source Go のソースコード
 * @returns 見つかった形の名前（重複なし、ソース中の出現順）
 */
export function findUnboundedLoops(source: string): readonly string[] {
  const scanned = scanTokens(source);
  if (!scanned.ok) {
    return [];
  }

  const { tokens } = scanned;
  // **本体は数え直さない**（PR #734 の Copilot の指摘）。繰り返しごとに本体を端まで
  // 走ると、入れ子が深いソースで走査が二乗になる。**この検査はエッジ（Workers）でも
  // 走る**ので、生成物の書き方 1 つで CPU 時間が跳ねる形を持たない。前処理を
  // 1 パスずつ置き、判定は添字の引き算にする。
  const closingBrace = mapClosingBraces(tokens);
  const exitCounts = countControlReturningTokens(tokens);
  const found: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // **`for` は Go の予約語なので、識別子としては現れない。** 変数名にも
    // フィールド名にも使えないため、ここで拾うのは必ず繰り返しの先頭である。
    if (token.kind !== 'ident' || token.value !== 'for') {
      continue;
    }

    const header = readLoopHeader(tokens, index + 1);
    if (header === null) {
      // 本体の `{` が来ないまま終端した、あるいは条件が長すぎる。
      // **読み取れていないので、何も言わない。**
      continue;
    }

    const form = classifyCondition(tokens.slice(index + 1, header.braceIndex));
    if (form === null) {
      continue;
    }

    // **ここまでで「条件が無いか、定数 true」である。** 本体に制御を返す経路が
    // あれば通す（終了条件を持っている）。**閉じ括弧が無いときは終端までを本体と
    // みなす**（読み取れていないソースで拒否を増やさない）。
    const bodyEnd = closingBrace.get(header.braceIndex) ?? tokens.length;
    if (exitCounts[bodyEnd]! - exitCounts[header.braceIndex]! > 0) {
      continue;
    }

    if (!found.includes(form)) {
      found.push(form);
    }
  }

  return found;
}

/**
 * `{` の位置から、対応する `}` の位置への対応表を 1 パスで作る。
 *
 * **字句として数えるので、コメントと文字列の中の括弧は数えない**（`scanTokens` が
 * 落としている）。**対応が取れない `{` は表に入らない**——呼び出し側が終端までを
 * 本体とみなす。
 *
 * @param tokens 字句の列
 * @returns `{` の位置 → 対応する `}` の位置
 */
function mapClosingBraces(tokens: readonly GoToken[]): ReadonlyMap<number, number> {
  const closing = new Map<number, number>();
  const open: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index]!.value;
    if (value === '{') {
      open.push(index);
      continue;
    }
    if (value === '}') {
      const start = open.pop();
      if (start !== undefined) {
        closing.set(start, index);
      }
    }
  }
  return closing;
}

/**
 * 「制御を返しうる字句」の累積個数を 1 パスで数える。
 *
 * 返すのは長さ `tokens.length + 1` の配列で、`counts[i]` は `tokens[0..i)` に現れた
 * 個数である。**範囲の判定は引き算 1 回で済む。**
 *
 * @param tokens 字句の列
 * @returns 累積個数
 */
function countControlReturningTokens(tokens: readonly GoToken[]): readonly number[] {
  const counts: number[] = new Array<number>(tokens.length + 1);
  counts[0] = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const isExit =
      (token.kind === 'ident' && CONTROL_RETURNING_KEYWORDS.includes(token.value)) ||
      isChannelReceive(tokens, index);
    counts[index + 1] = counts[index]! + (isExit ? 1 : 0);
  }
  return counts;
}

/**
 * 繰り返しの先頭から、本体を開く `{` の位置を探す。
 *
 * **括弧と角括弧の入れ子を数える。** `for _, v := range map[string]int{…}` のように
 * 条件の側に `{` が現れる形があるため、素朴に最初の `{` を採ると本体を取り違える。
 * ただし**その形はどちらにせよ {@link classifyCondition} が「分からない」を返す**ので、
 * ここで取り違えても拒否には至らない（通す側へ倒れる）。
 *
 * **読む長さに上限を置く**（{@link MAX_LOOP_HEADER_TOKENS}）。`for` を並べただけの
 * ソースでは、どの `for` からも `{` が遠く、**探索が毎回終端まで走る。** 実際の条件は
 * 短いので、超えたものは「分からない」として**通す側へ倒す。**
 *
 * @param tokens 字句の列
 * @param start `for` の次の位置
 * @returns 本体を開く `{` の位置。見つからなければ（上限を超えたときも）null
 */
function readLoopHeader(
  tokens: readonly GoToken[],
  start: number,
): { readonly braceIndex: number } | null {
  let depth = 0;
  const limit = Math.min(tokens.length, start + MAX_LOOP_HEADER_TOKENS);
  for (let index = start; index < limit; index += 1) {
    const token = tokens[index]!;
    if (token.value === '(' || token.value === '[') {
      depth += 1;
      continue;
    }
    if (token.value === ')' || token.value === ']') {
      depth -= 1;
      continue;
    }
    if (token.value === '{' && depth === 0) {
      return { braceIndex: index };
    }
  }
  return null;
}

/**
 * 繰り返しの条件が「無い」か「定数 true」かを判定する。
 *
 * **判定できるのは {@link UNBOUNDED_LOOP_FORMS} の 2 つだけで、それ以外はすべて
 * null（＝通す）である。** `1 == 1` のように定数どうしを比べた形も、
 * `ok := true` を経由した形も**通る**——**通した形は 7.2 の「受け入れた劣化」に書く。**
 *
 * @param condition `for` と本体の `{` のあいだの字句
 * @returns 当てはまった形の名前、当てはまらなければ null
 */
function classifyCondition(condition: readonly GoToken[]): string | null {
  if (condition.length === 0) {
    return UNBOUNDED_LOOP_FORMS[0]!.name;
  }
  return evaluateConstantBool(condition) === true ? UNBOUNDED_LOOP_FORMS[1]!.name : null;
}

/**
 * 字句の列を定数の真偽値として読む。**読めなければ null を返す。**
 *
 * 読むのは `true` / `false` / `!` / 括弧の 4 つだけである。**演算子を足さない**——
 * `&&` や `==` まで畳み始めると、定数の畳み込みを自前で持つことになり、**間違えた
 * ぶんが正当な作品の拒否**になって現れる（モジュール冒頭）。
 *
 * **再帰にしない**（PR #734 の Copilot の指摘）。`!` と括弧は生成物が好きなだけ
 * 重ねられるので、再帰で剥がすと**深さが生成物の綴り次第**になる。外側から順に
 * 剥がす反復にして、深さを持たない形にする。
 *
 * @param tokens 条件の字句
 * @returns 定数として読めた真偽値、読めなければ null
 */
function evaluateConstantBool(tokens: readonly GoToken[]): boolean | null {
  let start = 0;
  let end = tokens.length;
  let negations = 0;

  for (;;) {
    if (start >= end) {
      return null;
    }
    if (tokens[start]!.value === '!') {
      negations += 1;
      start += 1;
      continue;
    }
    // 括弧は、**末尾が閉じ括弧である形だけ**を剥がす（`(true) && x` は剥がさない。
    // 剥がすと `true && x` になり、定数として読めてしまう）。
    if (tokens[start]!.value === '(' && tokens[end - 1]!.value === ')') {
      start += 1;
      end -= 1;
      continue;
    }
    break;
  }

  if (end - start !== 1) {
    return null;
  }
  const token = tokens[start]!;
  if (token.kind !== 'ident') {
    return null;
  }
  const literal = token.value === 'true' ? true : token.value === 'false' ? false : null;
  if (literal === null) {
    return null;
  }
  return negations % 2 === 0 ? literal : !literal;
}

/**
 * その位置がチャネルの**受信**（`<-ch`）かどうか。
 *
 * **`<` と `-` が並んでいても受信とは限らない**（PR #734 の Copilot の指摘）。
 * `if x < -y` は**比較と単項マイナス**で、`scanTokens` はこれも `<` と `-` の 2 字句
 * として返す。並びだけで数えると、**出る経路も待ちも持たない `for {}` が
 * 「チャネルを待っている」として通り抜ける。**
 *
 * **受信は前置である。** したがって、直前の字句が「値の終わり」でないときだけ
 * 受信とみなす（`<-ch` / `= <-ch` / `case <-ch`）。
 *
 * **送信（`ch <- v`）は数えない。** 綴りの上では `x < -y` と区別が付かず、
 * **区別できない側は通さない**（数えれば、比較を書いただけの `for {}` が通り抜ける）。
 * 送信だけで待つ繰り返しは拒否されるが、その形は**仕様 7.2 に書いた受け入れの逆側**
 * ——**主スレッドを返さないことに変わりはない。**
 *
 * @param tokens 字句の列
 * @param index `<` があるとされる位置
 * @returns 受信なら true
 */
function isChannelReceive(tokens: readonly GoToken[], index: number): boolean {
  if (tokens[index]!.value !== '<' || tokens[index + 1]?.value !== '-') {
    return false;
  }
  const previous = tokens[index - 1];
  return previous === undefined || !endsOperand(previous);
}

/**
 * その字句が「値の終わり」かどうか（`<` が比較として置かれうる位置か）。
 *
 * 値の終わりになるのは、**識別子（予約語を除く）・文字列・ルーン・数字・閉じ括弧**
 * である。`case` や `return` は識別子の綴りをしているが値ではない（{@link GO_KEYWORDS}）。
 *
 * **数字は 1 文字で見て足りる。** `scanTokens` は数値リテラルをまとめず 1 文字ずつ返す
 * （`10` は `other:1` と `other:0`）ので、`<` の直前は必ず 1 文字の数字になる。
 * PR #734 の第二意見は「2 桁以上の数値リテラルで受信と誤判定する」と報告したが、
 * **字句を実測すると成り立たなかった**（`test/go-loops.test.ts` に回帰として置いた）。
 *
 * @param token 直前の字句
 * @returns 値の終わりなら true
 */
function endsOperand(token: GoToken): boolean {
  if (token.kind === 'ident') {
    return !GO_KEYWORDS.has(token.value);
  }
  if (token.kind === 'string' || token.kind === 'rune') {
    return true;
  }
  return token.value === ')' || token.value === ']' || token.value === '}' || /^[0-9]$/u.test(token.value);
}
