/**
 * 出力側モデレーション（8.3 / #38）。**生成コードの文字列リテラルを NG ワードで見る。**
 *
 * ## なぜこの検査が要るのか（確定23 と結びついている）
 *
 * #72 で**生成物に文字描画を許した**（`text/v2` ＋ `basicfont`）。したがって生成物は
 * 画面へ任意の文字列を出せる。**入力側（8.2）はプロンプトしか見ないので、モデルが
 * 自分で書いた語は通る。** ここが出力側の唯一の関門である。
 *
 * 文字描画を禁じればこの検査が要らなくなる、という関係にはない。6.1 は**算術ピクセル
 * 描画**も明示的に許しており、座標計算だけで任意のグリフが描ける（確定23 の根拠 3）。
 *
 * ## 何を捕まえないかを先に書く（8.3 が自ら認めている限界）
 *
 * - **算術ピクセル描画。** 文字列リテラルが 1 つも残らない。
 * - **実行時の組み立て。** `strconv` やコードポイントの配列から作った文字列。
 * - **綴りの崩し。** 語の間に記号を挟む、似た字形へ置き換える、など。
 * - **同義語。** 表に無い語（`src/denied-terms.ts`「表は網羅ではない」）。
 *
 * **8.3 が通ったことをもって「差別的な表示が無い」とは主張しない。** 残りを捕まえる
 * のは 8.4 の通報と審査キューである。ここは安い検査で大半を捕まえる層に徹する。
 *
 * ## パーサを増やさない
 *
 * 文字列リテラルの抽出は `src/go-imports.ts` の {@link scanStringLiterals} が行う。
 * **M2-3 の字句解析をそのまま最後まで走らせたもの**であって、この issue で新しい走査器を
 * 足してはいない（issue #38 の acceptance「検査が M2-3 と同一の AST パースを共有している」）。
 * 走査を 2 つ持つと、片方だけが新しい書き方に対応する状態が生まれる。
 *
 * ## 表はここに書かない
 *
 * 語は `src/denied-terms.ts` にあり、このファイルには 1 語も無い。管理方法とその
 * 理由（コードへ直書きし、しかし注入もできる形にする）はあちらの冒頭にある。
 */
import type { DeniedTerm, DeniedTermCategory } from './denied-terms.js';
import { DENIED_TERMS } from './denied-terms.js';
import { scanStringLiterals } from './go-imports.js';

/** 拒否の理由。**`ImportRejection` とは別の軸である**（5.2-5 ではなく 8.3）。 */
export type DeniedTermRejection = 'denied-term';

/** 拒否の理由（値）。文字列リテラルを 2 か所へ書き写さないために定数で持つ。 */
export const DENIED_TERM_REJECTION: DeniedTermRejection = 'denied-term';

/** 検査の結果。 */
export type StringLiteralInspection =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: DeniedTermRejection | 'unparsable';
      /**
       * 当たった語の**分類**（重複なし、表の順）。
       *
       * **語そのものは載せない**（`src/denied-terms.ts` の `category` の注記）。
       * `unparsable` のときは空。
       */
      readonly categories: readonly DeniedTermCategory[];
    };

/**
 * 突き合わせから落とす不可視文字。
 *
 * NFKC はこれらを落とさない。**間に 1 文字挟むだけで検査を抜けられる**ので、
 * 正規化のあとで消す。ゼロ幅（U+200B〜U+200D）、方向制御（U+200E〜U+200F /
 * U+202A〜U+202E / U+2066〜U+2069）、word joiner（U+2060）、BOM（U+FEFF）。
 *
 * **ソースへ生の文字として書かない**（読み手にも差分にも見えないため。
 * `src/go-imports.ts` の BOM の扱いと同じ）。
 */
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

/**
 * 正規表現で特別な意味を持つ文字を打ち消す。
 *
 * 表の語は人が書くので、いつか記号入りの語が入る。**打ち消さないと、その日に
 * 正規表現が壊れるか、意図しない範囲に当たる。**
 *
 * @param value 打ち消す文字列
 * @returns 打ち消した文字列
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 突き合わせのために文字列を正規化する。
 *
 * **表の語にも、ソースから拾った文字列にも、同じ関数を掛ける。** 片側にだけ掛けると、
 * 表に全角で書いた語が半角の入力に当たらない、といったずれが黙って生まれる。
 *
 * 掛けるのは次の 3 つである。
 *
 * 1. **エスケープの展開**（生文字列でないときだけ）。Go の `"\u30ad"` は「キ」であり、
 *    展開しないと**綴りをエスケープで書くだけで抜けられる。**
 * 2. **NFKC 正規化。** 全角英字（`ｎｉｇｇｅｒ`）や半角カナを畳む。
 * 3. **小文字化と不可視文字の除去。**
 *
 * @param value リテラルの綴り（引用符の中身）
 * @param raw 生文字列（`` ` `` で囲んだ形）か。**エスケープを展開してよいかが変わる**
 * @returns 正規化した文字列
 */
export function normalizeForMatching(value: string, raw: boolean): string {
  const decoded = raw ? value : decodeGoEscapes(value);
  return decoded.normalize('NFKC').toLowerCase().replace(INVISIBLE_CHARACTERS, '');
}

/**
 * Go の解釈される文字列リテラルのエスケープを展開する。
 *
 * **完全な実装ではない。** 目的は「エスケープで綴りを隠す」経路を塞ぐことなので、
 * 文字を生む形（`\x` / `\u` / `\U` / 8 進 / 単純エスケープ）だけを扱う。
 * **読めない綴りは、その文字をそのまま残す**（例外にしない）。ここで落とすと、
 * 検査の対象でない書き間違いが 422 になる。判定に迷ったら拒否するのは
 * `src/go-imports.ts` の構文の話であって、**語の突き合わせは緩い側へ倒しても
 * 「拾えなかった」で済む**（拒否の側へ倒すと、正当なゲームが枠を失う）。
 *
 * @param value リテラルの綴り（引用符の中身）
 * @returns 展開した文字列
 */
function decodeGoEscapes(value: string): string {
  let result = '';
  let index = 0;

  while (index < value.length) {
    const char = value[index]!;
    if (char !== '\\' || index + 1 >= value.length) {
      result += char;
      index += 1;
      continue;
    }

    const next = value[index + 1]!;
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      result += simple;
      index += 2;
      continue;
    }

    // `\xHH` / `\uHHHH` / `\UHHHHHHHH`。桁数が足りなければ展開しない。
    const hexDigits = HEX_ESCAPE_DIGITS[next];
    if (hexDigits !== undefined) {
      const digits = value.slice(index + 2, index + 2 + hexDigits);
      if (digits.length === hexDigits && /^[0-9a-f]+$/iu.test(digits)) {
        const code = Number.parseInt(digits, 16);
        // 符号位置の範囲外（`\U0011FFFF` 等）は `String.fromCodePoint` が投げる。
        // **投げさせない**（不正なソースは検査の関心事ではなくビルドが落とす）。
        if (code <= 0x10ffff) {
          result += String.fromCodePoint(code);
          index += 2 + hexDigits;
          continue;
        }
      }
    }

    // `\NNN`（8 進 3 桁）。バイト値なので、そのまま符号位置として扱う。
    if (/^[0-7]$/u.test(next)) {
      const digits = value.slice(index + 1, index + 4);
      if (digits.length === 3 && /^[0-7]+$/u.test(digits)) {
        result += String.fromCodePoint(Number.parseInt(digits, 8));
        index += 4;
        continue;
      }
    }

    // 知らないエスケープ。**後ろの 1 文字をそのまま残す**（`\"` → `"`）。
    result += next;
    index += 2;
  }

  return result;
}

/** 1 文字で決まるエスケープ。 */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/** 16 進エスケープの桁数。 */
const HEX_ESCAPE_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/**
 * 生成されたソースの文字列リテラルを NG ワードで検査する（8.3）。
 *
 * @param source Go のソースコード
 * @param terms 拒否する語の表。**既定は `src/denied-terms.ts` の一覧**。
 *   テストがダミー語を注入するための引数であって、運用で差し替える口ではない
 * @returns 検査結果
 */
export function inspectStringLiterals(
  source: string,
  terms: readonly DeniedTerm[] = DENIED_TERMS,
): StringLiteralInspection {
  const scanned = scanStringLiterals(source);
  if (!scanned.ok) {
    // 閉じないリテラルで読み取れなかった。**「語は見つからなかった」を返さない**
    // （`scanStringLiterals` の「読めなければ落とす」）。
    return { ok: false, reason: 'unparsable', categories: [] };
  }

  // **表の側の下ごしらえは 1 回だけ行う。** リテラルごとに正規化と正規表現の
  // 組み立てを繰り返すと、リテラル数 × 語数の回数だけ走る。
  const prepared = terms
    .map((term) => ({ term, needle: normalizeForMatching(term.term, true) }))
    // 空の語は**すべてのリテラルに当たる**。表の書き間違いで全件拒否になるので落とす。
    .filter((entry) => entry.needle !== '')
    .map((entry) => ({
      category: entry.term.category,
      needle: entry.needle,
      // 語一致のときだけ正規表現を持つ。部分一致は `includes` で足りる。
      pattern: entry.term.match === 'word' ? wordPattern(entry.needle) : null,
    }));

  const categories: DeniedTermCategory[] = [];
  for (const literal of scanned.literals) {
    const haystack = normalizeForMatching(literal.value, literal.raw);
    if (haystack === '') {
      continue;
    }
    for (const entry of prepared) {
      if (categories.includes(entry.category)) {
        continue;
      }
      const hit =
        entry.pattern === null ? haystack.includes(entry.needle) : entry.pattern.test(haystack);
      if (hit) {
        categories.push(entry.category);
      }
    }
  }

  return categories.length === 0
    ? { ok: true }
    : { ok: false, reason: DENIED_TERM_REJECTION, categories };
}

/**
 * 語一致の正規表現を組み立てる。
 *
 * 前後が文字・数字・アンダースコアでないときだけ当たる。**`\b` を使わない**のは、
 * あれが ASCII の `[A-Za-z0-9_]` しか語の文字とみなさず、`ゲームretard` のような
 * 並びで境界が立ってしまうためである。
 *
 * @param needle 正規化した語
 * @returns 語一致の正規表現
 */
function wordPattern(needle: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeForRegExp(needle)}(?![\\p{L}\\p{N}_])`,
    'u',
  );
}
