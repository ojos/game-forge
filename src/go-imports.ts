/**
 * 生成された Go ソースの import 検査（5.2-5 / 7.1 / 6.1 / #17）。
 *
 * ## なぜ「AST」ではなく import 宣言の構文解析なのか
 *
 * issue の題は「AST によるホワイトリスト検査」だが、**Workers のランタイムに Go の
 * パーサは無い**。`go/parser` を持つのはビルド実行環境（確定24 で Lambda）だけで、そこへ渡す前に
 * 弾くのがこの検査の役目である（5.2 は生成の直後、ビルドの手前に置いている）。
 *
 * そこで、Go の文法のうち**この検査に必要な範囲だけ**を解析する。Go は import 宣言を
 * `package` 句の直後・他のすべての宣言より前に置くことを言語仕様で要求するため、
 * 「先頭から package 句と import 宣言だけを読む」ことに意味があり、本文の構文を
 * 解釈する必要がない。**この範囲に限れば完全な解析ができる。**
 *
 * ## 判定に迷ったら拒否する
 *
 * 読み取れない構文に出会ったら、通さずに落とす。ここを「解析できなかったので通す」に
 * すると、解析器が知らない書き方が**そのまま迂回路**になる。生成物は攻撃者が制御
 * しうるコードであり（7.1）、この検査は 7.1 のコンテナ封じ込めに対する多層防御の
 * 外側の層なので、緩い側へ倒す理由がない。
 *
 * ## この検査だけに頼らない
 *
 * 一次の防御は 7.1 のコンテナ（`--network=none` / `--read-only` / 非 root）である。
 * ここを通ったソースが安全になるわけではない。**ビルドサーバ側で `go/parser` による
 * 検査を重ねること**を M2-5 で検討する価値がある（本物のパーサが使える唯一の場所）。
 *
 * ## import を見ても分からないことがある（#100）
 *
 * **`//go:wasmimport` は import 文を 1 つも書かずにホスト関数へ結び付ける。**
 * import しか見ない検査は、これを**原理的に**検出できない。実装の欠陥ではなく、
 * 手段の限界である（実測は `src/go-import-allowlist.ts` の `GO_DIRECTIVE_DENYLIST`）。
 * そこで `findDeniedDirectives` を足し、**import とは別の軸**で同じソースを見る。
 *
 * **この 2 つを足しても「生成物が何を呼べるか」は決まらない。** それを最終的に
 * 決めているのは 7.2（別オリジン ＋ CSP `sandbox` ＋ `connect-src`）である。
 * ここは 7.2 の手前に置く上流の層であって、7.2 の代わりではない（仕様書 7.1 / 7.2）。
 */
import { GO_DIRECTIVE_DENYLIST, GO_IMPORT_ALLOWLIST } from './go-import-allowlist.js';

/** ソースを受け付けられなかった理由。 */
export type ImportRejection =
  | 'empty-source'
  | 'no-package-clause'
  | 'unparsable'
  | 'not-allowed'
  | 'directive-not-allowed';

/** 検査の結果。 */
export type ImportInspection =
  | { readonly ok: true; readonly imports: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: ImportRejection;
      /**
       * `not-allowed` のとき、許可されていない import パス。
       * `directive-not-allowed` のとき、書かれていた禁止指示の名前（`go:wasmimport` 等）。
       */
      readonly offending?: readonly string[];
    };

/** 字句。import 宣言を読むのに要る種類だけを持つ。 */
interface Token {
  readonly kind: 'ident' | 'string' | 'punct' | 'other';
  readonly value: string;
}

/**
 * 生成されたソースを検査する。
 *
 * 2 つの軸で見る。**import 文**（許可パッケージの一覧）と、**コンパイラ指示**
 * （`//go:wasmimport` 等の拒否一覧）である。後者は前者では原理的に見えない
 * （#100。冒頭の「import を見ても分からないことがある」）。
 *
 * @param source Go のソースコード
 * @returns 検査結果
 */
export function inspectGoImports(source: string): ImportInspection {
  const scanned = scanImports(source);
  if (!scanned.ok) {
    return scanned;
  }

  // 指示の検査を import の検査より先に置く。**両方に違反しているソースでは、
  // 一覧で説明できないほうを理由として返したい。** `not-allowed` を返すと
  // 「一覧に足せば通る」と読めてしまうが、`//go:wasmimport` は一覧に足す・
  // 足さないの問題ではない。
  const directives = findDeniedDirectives(source);
  if (directives.length > 0) {
    return { ok: false, reason: 'directive-not-allowed', offending: directives };
  }

  const allowed = new Set<string>(GO_IMPORT_ALLOWLIST.map((entry) => entry.path));
  const offending = scanned.imports.filter((path) => !allowed.has(path));
  if (offending.length > 0) {
    // 違反は再生成に回さず即拒否する（5.2-5）。再生成に回すと、禁止パッケージを
    // 使いたがるプロンプトが費用を無制限に増やせる。
    return { ok: false, reason: 'not-allowed', offending };
  }
  return { ok: true, imports: scanned.imports };
}

/**
 * ソース全体から、拒否するコンパイラ指示を探す（#100）。
 *
 * ## なぜ正規表現 1 本ではないのか
 *
 * `//go:wasmimport` を単純に検索すると、**文字列リテラルの中の同じ綴りを拾う。**
 * 逆に、文字列リテラルを飛ばさずに走ると**リテラルの中の `` ` `` やクォートで
 * 位置を見失い、その先にある本物の指示を読み落とす。** とくに**ルーンリテラルの
 * 中のバッククォート**（`` '`' ``。正当な Go である）は、素朴な走査を生文字列の
 * 途中だと錯覚させ、**そこから次のバッククォートまでを丸ごと飛ばさせる。**
 * そこで、`scanImports` と同じく字句として読む。
 *
 * ## 何を指示とみなすか（実測で決めた。Go 1.26.5 / 2026-08-28）
 *
 * **行コメントの本文が指示名で始まるものだけ**を指示とみなす。
 *
 * - 行頭でも**字下げされていても効く**（どちらも wasm のインポート節に現れた）。
 *   したがって桁位置を条件にしない。
 * - `// go:wasmimport`（`//` の後ろに空白を 1 つ入れた形）と、ブロックコメントへ
 *   書いた同じ綴りは**指示にならない**（どちらも `missing function body` で
 *   ビルドが落ちる）。拒否しても実害は無いが、**落とす理由を説明できない拒否を
 *   増やさない**ほうを採る。
 *
 * @param source Go のソースコード
 * @returns 見つかった指示の名前（重複なし、ソース中の出現順）
 */
export function findDeniedDirectives(source: string): readonly string[] {
  const text = source.replace(/^\uFEFF/u, '');
  const found: string[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === '"' || char === "'") {
      // 解釈される文字列とルーンリテラル。どちらも改行をまたげないので、
      // 閉じないまま行が終わったらそこで打ち切る（読み落としを作らない）。
      index = skipUntilQuote(text, index, char);
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index);
      const body = text.slice(index + 2, lineEnd === -1 ? text.length : lineEnd);
      for (const directive of GO_DIRECTIVE_DENYLIST) {
        if (body.startsWith(directive.name) && !found.includes(directive.name)) {
          found.push(directive.name);
        }
      }
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    index += 1;
  }

  return found;
}

/**
 * 閉じ引用符（または行末）まで読み飛ばす。
 *
 * @param text ソース
 * @param start 開き引用符の位置
 * @param quote 引用符の文字（`"` または `'`）
 * @returns 読み飛ばした次の位置
 */
function skipUntilQuote(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    const current = text[index]!;
    if (current === '\\') {
      if (text[index + 1] === '\n') {
        // 行継続は Go に無い（解釈される文字列もルーンリテラルも改行をまたげない）。
        // ここで 2 文字まとめて飛ばすと**改行を越えてしまい**、次の行を
        // リテラルの続きとして読む。壊れたリテラルを 1 つ置くだけで次の行の
        // 指示を隠せることになるので、改行では必ず打ち切る。
        return index + 1;
      }
      // エスケープは 2 文字まとめて飛ばす。1 文字にすると `\"` や `\'` で終端する。
      index += 2;
      continue;
    }
    if (current === quote) {
      return index + 1;
    }
    if (current === '\n') {
      // 閉じないまま行が終わった。**次の行から読み直す。** ここで終端まで飛ばすと、
      // 壊れたリテラルを 1 つ置くだけで以降の指示を隠せる。
      return index;
    }
    index += 1;
  }
  return text.length;
}

/**
 * ソースの先頭から package 句と import 宣言だけを読む。
 *
 * @param source Go のソースコード
 * @returns import パスの一覧、または読み取れなかった理由
 */
export function scanImports(source: string): ImportInspection {
  // BOM は落とす。付いていても Go は受け付けるが、こちらの字句解析では識別子の
  // 先頭文字として現れて package 句を見失う。
  //
  // **不可視の文字をソースへ直接書かない。** 実際にこの行はレビューで「空文字を
  // 置換しているだけ」と読まれた。エスケープ表記なら、読み手にも差分にも見える。
  const text = source.replace(/^\uFEFF/u, '');
  if (text.trim() === '') {
    return { ok: false, reason: 'empty-source' };
  }

  const cursor = { index: 0 };
  const first = nextToken(text, cursor);
  if (first === null || first.kind !== 'ident' || first.value !== 'package') {
    return { ok: false, reason: 'no-package-clause' };
  }
  const packageName = nextToken(text, cursor);
  if (packageName === null || packageName.kind !== 'ident') {
    return { ok: false, reason: 'no-package-clause' };
  }

  const imports: string[] = [];
  for (;;) {
    const saved = cursor.index;
    const token = nextToken(text, cursor);
    if (token === null) {
      // import 宣言だけで終わるソース。Go としては本体が無いが、構文としては読めた。
      return { ok: true, imports };
    }
    if (token.kind === 'punct' && token.value === ';') {
      // 宣言の終端。Go の文法は `PackageClause ";" { ImportDecl ";" }` であり、通常は
      // 改行で自動挿入されるが、**明示的に書いても正当な Go である**
      // （`package main; import "os/exec"` はコンパイルできる）。ここで「import の
      // 並びが終わった」と判断すると、セミコロンを 1 つ挟むだけで検査を迂回できる。
      continue;
    }
    if (token.kind !== 'ident' || token.value !== 'import') {
      // import 宣言の並びが終わった。Go は import を他のすべての宣言より前に置くことを
      // 要求するため、ここから先に import は現れない。
      cursor.index = saved;
      return { ok: true, imports };
    }

    const declaration = readImportDeclaration(text, cursor);
    if (!declaration.ok) {
      return declaration;
    }
    imports.push(...declaration.imports);
  }
}

/**
 * `import` の後ろを読む。単一形と括弧でまとめた形の両方を受ける。
 *
 * @param text ソース
 * @param cursor 読み取り位置
 * @returns import パス、または読み取れなかった理由
 */
function readImportDeclaration(text: string, cursor: { index: number }): ImportInspection {
  const head = nextToken(text, cursor);
  if (head === null) {
    return { ok: false, reason: 'unparsable' };
  }

  // import "path" / import alias "path" / import _ "path" / import . "path"
  if (head.kind === 'string') {
    return { ok: true, imports: [head.value] };
  }
  if (head.kind === 'ident' || (head.kind === 'punct' && (head.value === '.' || head.value === '_'))) {
    const path = nextToken(text, cursor);
    if (path === null || path.kind !== 'string') {
      return { ok: false, reason: 'unparsable' };
    }
    return { ok: true, imports: [path.value] };
  }

  if (head.kind !== 'punct' || head.value !== '(') {
    return { ok: false, reason: 'unparsable' };
  }

  const imports: string[] = [];
  for (;;) {
    const token = nextToken(text, cursor);
    if (token === null) {
      // 閉じ括弧が来ないまま終端。読み取れていないので落とす。
      return { ok: false, reason: 'unparsable' };
    }
    if (token.kind === 'punct' && token.value === ')') {
      return { ok: true, imports };
    }
    if (token.kind === 'punct' && token.value === ';') {
      // 明示的なセミコロン。Go は改行で自動挿入するため、通常は現れない。
      continue;
    }
    if (token.kind === 'string') {
      imports.push(token.value);
      continue;
    }
    if (token.kind === 'ident' || (token.kind === 'punct' && (token.value === '.' || token.value === '_'))) {
      const path = nextToken(text, cursor);
      if (path === null || path.kind !== 'string') {
        return { ok: false, reason: 'unparsable' };
      }
      imports.push(path.value);
      continue;
    }
    return { ok: false, reason: 'unparsable' };
  }
}

/**
 * 次の字句を読む。空白とコメントは読み飛ばす。
 *
 * **文字列リテラルとコメントを字句として正しく扱うことがこの関数の要点である。**
 * 正規表現で `import` を探す実装は、コメントや文字列の中の `import` を拾い、逆に
 * 本物を見落とす。
 *
 * @param text ソース
 * @param cursor 読み取り位置（呼び出しごとに進む）
 * @returns 字句、または終端なら null
 */
function nextToken(text: string, cursor: { index: number }): Token | null {
  skipTrivia(text, cursor);
  if (cursor.index >= text.length) {
    return null;
  }

  const char = text[cursor.index]!;

  // 解釈される文字列リテラル。エスケープを解釈する必要はなく、`\"` で終端しない
  // ことだけ守れば import パスとして取り出せる（パスに `\` は現れない）。
  if (char === '"') {
    let index = cursor.index + 1;
    let value = '';
    while (index < text.length) {
      const current = text[index]!;
      if (current === '\\') {
        // エスケープは 2 文字まとめて飛ばす。ここを 1 文字にすると `\"` で終端する。
        value += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (current === '"') {
        cursor.index = index + 1;
        return { kind: 'string', value };
      }
      if (current === '\n') {
        // 解釈される文字列は改行をまたげない。読み取れていないので other にする。
        break;
      }
      value += current;
      index += 1;
    }
    cursor.index = text.length;
    return { kind: 'other', value: '' };
  }

  // 生文字列リテラル。エスケープを解釈せず、改行をまたげる。
  if (char === '`') {
    const end = text.indexOf('`', cursor.index + 1);
    if (end === -1) {
      cursor.index = text.length;
      return { kind: 'other', value: '' };
    }
    const value = text.slice(cursor.index + 1, end);
    cursor.index = end + 1;
    return { kind: 'string', value };
  }

  if (isIdentifierStart(char)) {
    let index = cursor.index;
    while (index < text.length && isIdentifierPart(text[index]!)) {
      index += 1;
    }
    const value = text.slice(cursor.index, index);
    cursor.index = index;
    return { kind: 'ident', value };
  }

  if (char === '(' || char === ')' || char === ';' || char === '.') {
    cursor.index += 1;
    return { kind: 'punct', value: char };
  }

  cursor.index += 1;
  return { kind: 'other', value: char };
}

/**
 * 空白とコメントを読み飛ばす。
 *
 * @param text ソース
 * @param cursor 読み取り位置
 */
function skipTrivia(text: string, cursor: { index: number }): void {
  for (;;) {
    while (cursor.index < text.length && /\s/u.test(text[cursor.index]!)) {
      cursor.index += 1;
    }
    if (text.startsWith('//', cursor.index)) {
      const end = text.indexOf('\n', cursor.index);
      cursor.index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', cursor.index)) {
      const end = text.indexOf('*/', cursor.index + 2);
      cursor.index = end === -1 ? text.length : end + 2;
      continue;
    }
    return;
  }
}

/**
 * 識別子の先頭に使える文字かどうか。
 *
 * `_` を含めるのは、import の空白識別子（`import _ "embed"`）を識別子として読むため。
 * Go の識別子は Unicode の文字を許すので、ASCII に限定しない。
 *
 * @param char 判定する 1 文字
 * @returns 使えるなら true
 */
function isIdentifierStart(char: string): boolean {
  return char === '_' || /\p{L}/u.test(char);
}

/**
 * 識別子の 2 文字目以降に使える文字かどうか。
 *
 * @param char 判定する 1 文字
 * @returns 使えるなら true
 */
function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || /\p{Nd}/u.test(char);
}
