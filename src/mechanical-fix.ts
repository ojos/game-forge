/**
 * ビルド失敗に対する機械修正（4.2 の 1 段目 / #129）。
 *
 * 4.2 は「リトライは 2 段構成にする」と定める。**このモジュールは 1 段目、すなわち
 * 費用ゼロの段である。**
 *
 * 1. **機械修正**（費用ゼロ）— 未使用 import の除去   ← ここ
 * 2. **LLM 再生成**（費用が発生）— `src/build-retry.ts`（#20）
 *
 * **回す場所は `src/generate.ts` のループで、ビルドが `kind='build'` で落ちた直後**
 * である（4.2 の #20 注記が挿入位置として記していた場所）。このモジュールが持つのは
 * **ソースの書き換えだけ**で、再ビルドも、次の試行へ回すかどうかの判断も持たない。
 *
 * ## 除去だけを実装する（2026-08-28 決定 / #129）
 *
 * 4.2 は 1 段目として「未使用 import の除去、**不足 import の補完**」の 2 つを挙げるが、
 * **実測（#7）が支持しているのは除去だけである**（除去だけで成功が 1/6 → 3/6）。
 *
 * 補完は「この識別子はどのパッケージに属するか」を推定することになり、**許可パッケージの
 * 識別子表**を持つ必要がある。表は必ず古びるうえ、**古びても黙って効かなくなるだけで
 * 気づけない**（shared-ai-rules 12 章が「一覧の複製」を機械照合で担保せよと定めるのは
 * これが理由である。ここでは照合相手になる出力が存在しない）。**実測が出てから別途
 * 検討する。** 除去のほうは Go が `imported and not used` と明示するので推定が要らない。
 *
 * ## 台帳もクォータも触らない（確定25）
 *
 * **費用ゼロの段なので `generations` に行を作らない。** 日次クォータが数える単位は
 * 台帳の行数（＝費用の出る LLM 呼び出し回数）なので、行を作らないことがそのまま
 * 「数えない」ことになる（`src/quota.ts`）。**行を作ると、費用ゼロの段が確定25 の
 * 10 回の枠を食う。**
 *
 * ## ログへ出すのは数値と固定の分類名だけである（8.3 / #133）
 *
 * 入力（Go の診断）も出力（生成ソース）も、**8.3 の検査を通っていない文字列**である。
 * Go の診断は生成コードの行と識別子を引用するため、`BuildRejected` が `message` へ
 * 入れないのと同じ理由で、**ここから文字列を外へ出さない。**
 *
 * **#129 は「何も出さない」を選んだ。** 数値なら安全だが、**読む先がまだ無かった**
 * ためである（「使われない段を先に作らない」）。**#133 で読む先（4.2 の #133 注記）を
 * 決めたので、安全な分だけを開ける。** 1 巡につき 1 行、
 * **{@link MECHANICAL_FIX_OUTCOMES} の分類名と件数だけ**を出す（{@link logPass}）。
 * **緩めたのは範囲であって判断ではない。**
 *
 * **出さないものは #129 のときと同じである。**
 *
 * - **Go の診断。** 生成コードの行と識別子を引用する。
 * - **import のパス。** 5.2-5 の許可一覧（`src/go-import-allowlist.ts`）の範囲内とはいえ
 *   **生成物由来**であり、プロンプトの影響を受ける。「何を消したか」は診断の内容に近い。
 *   **件数で足りる。**
 * - **生成ソースとプロンプト。**
 *
 * **これを呼びかけで担保しない**（shared-ai-rules 12 章）。{@link logPass} が受け取れるのは
 * **固定語彙と数値だけ**で、生成物由来の文字列は**型として渡せない。**
 *
 * **段の診断情報は段自身が出す。** 何が安全かを知っているのはこのモジュールであって、
 * 例外を受けるだけの経路層ではない（`src/generate.ts` の `describeGenerateError`）。
 *
 * ## 除去は位置で行う（文字列置換ではない）
 *
 * `src/go-imports.ts` が import 節を**字句として**読めるので、その位置をそのまま使う。
 * 診断の行・桁が指す位置に、**診断が引用しているのと同じ import が実際にあること**を
 * 確かめてから消す。パス一致だけで消すと、同じパスを別名で 2 回 import した
 * ソース（`s1 "strings"` と `s2 "strings"`）で**使われているほうを消す。**
 *
 * ## 実測で閉じてある（2026-08-28 / Go 1.26.5 / `GOOS=js GOARCH=wasm`）
 *
 * 本物の `go build` の診断をこの関数へ通し、**出力が実際にコンパイルを通ること**まで
 * 確かめた（ビルド関数のイメージと同じ `golang:1.26.5`）。
 *
 * | 入力 | 結果 |
 * |---|---|
 * | 括弧形に素・別名・ドット・空白識別子が混在（未使用 4 件） | 1 巡で通過。`_ "embed"` は残る（診断されない） |
 * | 単一形（`import "errors"`） | 1 巡で通過（宣言ごと消える） |
 * | `import ("errors"; "math")` | 1 巡で通過（セミコロンごと消える） |
 * | 同じパスを別名で 2 回、片方だけ使用 | 1 巡で通過（**使っているほうが残る**） |
 * | 行末コメント付き | 1 巡で通過（コメントだけが残る。正当な Go） |
 * | 未使用 12 件（診断が 10 件で打ち切られる） | **2 巡**で通過（{@link MAX_MECHANICAL_FIX_PASSES} の根拠） |
 */
import type { GoImportDeclaration, GoImportSpec } from './go-imports.js';
import { scanImportSpecs } from './go-imports.js';

/**
 * `go build` が 1 回の実行で出す診断の上限（**実測。Go 1.26.5 / 2026-08-28**）。
 *
 * 12 個の未使用 import を持つソースは、**10 件を報告して `too many errors` で打ち切った。**
 * つまり 1 回の機械修正では、11 件目以降が残る。
 */
export const GO_DIAGNOSTIC_ERROR_LIMIT = 10;

/**
 * 1 試行あたりに機械修正を試す回数。
 *
 * **1 では足りない。** 未使用 import が 12 件あるソースは、実測で **2 巡**して初めて
 * 通った（1 巡目で 10 件、2 巡目で残り 2 件）。診断が
 * {@link GO_DIAGNOSTIC_ERROR_LIMIT} 件で打ち切られるためである。
 *
 * **2 で足りる根拠。** ビルドへ届く import の**パス**は 5.2-5 の検査を通ったもの、
 * すなわち許可一覧（`src/go-import-allowlist.ts`）の中身に限られる。1 巡で
 * 10 件消せるので、**`2 × 10 ≧ 許可一覧の件数`** である限り、異なるパスだけで
 * 並べられた未使用 import は 2 巡で消し切れる。この不等式は
 * `test/mechanical-fix.test.ts` が機械照合する（shared-ai-rules 12 章。一覧が
 * 20 件を超えたら、この定数も動かす必要がある）。
 *
 * **同じパスを別名で何度も import すれば、この上限は超えられる。** そのときは
 * 残りが 2 段目（LLM 再生成）へ回るだけで、壊れた結果にはならない。
 *
 * **回数を無制限にしない。** 1 巡ごとにビルド関数の呼び出しが 1 回増える。費用は
 * LLM に比べれば小さいが（4.6）、3.8 の実測で 1 回あたり 20 秒台であり、待ち時間は
 * そのまま利用者の体験になる。
 */
export const MAX_MECHANICAL_FIX_PASSES = 2;

/**
 * 診断 1 行から読み取った「使われていない import」。
 *
 * 位置は Go の流儀で **1 始まり**、桁は**バイト数**である（`go/token` の `Position`）。
 */
export interface UnusedImport {
  /** 行番号（1 始まり）。 */
  readonly line: number;
  /** 桁（1 始まり、バイト数）。 */
  readonly column: number;
  /** 診断が引用している import パス。 */
  readonly path: string;
  /** 診断が別名を名指ししていればその名前（`imported as str and not used`）。 */
  readonly alias: string | null;
}

/**
 * 機械修正 1 巡の結末を表す**固定の語彙**（この配列が正本）。
 *
 * **ログへ出してよい文字列はここに並ぶものだけである**（8.3 / #133）。**実装が持つ語で
 * あって生成物由来ではない**ため、8.3 の検査を通っていない文字列には当たらない。
 *
 * **仕様書 4.2 の #133 注記が同じ一覧を表として持つ**ので、`test/mechanical-fix.test.ts`
 * が機械照合する（shared-ai-rules 12 章）。語を足す・改名すると、文書が追随するまで
 * 検査が赤になる。
 */
export const MECHANICAL_FIX_OUTCOMES = [
  /** 未使用 import を実際に除去した。 */
  'removed',
  /** 診断に「未使用 import」が 1 件も無い。**通常の失敗はここへ来る。** */
  'no-unused-imports',
  /** import 節を読めなかった（`src/go-imports.ts` の判定）。 */
  'unreadable-source',
  /** 診断の位置に、診断が引用しているのと同じ import が無かった。 */
  'not-located',
  /** 除去後のソースを読み直したら、期待した import 構成になっていなかった。 */
  'verification-failed',
] as const;

/** 機械修正 1 巡の結末（{@link MECHANICAL_FIX_OUTCOMES} の要素）。 */
export type MechanicalFixOutcome = (typeof MECHANICAL_FIX_OUTCOMES)[number];

/** 機械修正を行わなかった理由。**利用者への文言ではない**（外へ出さない）。 */
export type MechanicalFixSkip = Exclude<MechanicalFixOutcome, 'removed'>;

/** 機械修正の結果。 */
export type MechanicalFixResult =
  | {
      readonly changed: true;
      /** 除去後のソース。 */
      readonly source: string;
      /**
       * 除去した import パス（ソース中の出現順）。
       *
       * **ログへ出さないこと**（生成物由来である。#133 で開けたのは**件数**までで、
       * パスそのものは出さない。{@link logPass}）。
       */
      readonly removed: readonly string[];
    }
  | { readonly changed: false; readonly reason: MechanicalFixSkip };

/**
 * 1 巡で数えたもの。**すべて件数であり、生成物由来の文字列を 1 つも含まない。**
 */
interface MechanicalFixCounts {
  /** 診断から読み取れた「未使用 import」の件数。 */
  readonly diagnosed: number;
  /** そのうち、ソース上の同じ位置に同じ import を見つけられた件数。 */
  readonly located: number;
  /** 実際に除去した件数（除去に至らなかった巡では 0）。 */
  readonly removed: number;
}

/**
 * 1 巡の結果を 1 行だけログへ出す（4.2 / 8.3 / #133）。
 *
 * **引数の型がそのまま安全性の根拠である。** 受け取れるのは
 * {@link MECHANICAL_FIX_OUTCOMES} の固定語彙と件数だけで、**生成ソース・Go の診断・
 * import のパス・プロンプトは型として渡せない。** 「気をつけて出す」ではなく、
 * 出せない形にしてある（shared-ai-rules 12 章 / 1.2.34 の「構造で塞ぐ」）。
 *
 * **出力の形もここで閉じる。** 数えた値を持ち回った器をそのまま文字列にするのではなく、
 * **3 つの数だけを持つ器へ入れ直してから**書き出すので、呼び出し側が余分な項目を
 * 持っていても外へは出ない。
 *
 * 読み方（何を見れば「効いている」と言えるか）は**仕様書 4.2 の #133 注記**にある。
 *
 * @param outcome 1 巡の結末
 * @param counts 数えたもの
 */
function logPass(outcome: MechanicalFixOutcome, counts: MechanicalFixCounts): void {
  const numbers = {
    diagnosed: counts.diagnosed,
    located: counts.located,
    removed: counts.removed,
  };
  console.info(`[mechanical-fix] ${outcome} ${JSON.stringify(numbers)}`);
}

/**
 * 行わなかったことをログへ出してから、理由を返す。
 *
 * @param reason 行わなかった理由
 * @param counts そこまでに数えたもの（除去は 0 件である）
 * @returns 呼び出し側がそのまま返せる結果
 */
function skipped(
  reason: MechanicalFixSkip,
  counts: Omit<MechanicalFixCounts, 'removed'>,
): MechanicalFixResult {
  logPass(reason, { diagnosed: counts.diagnosed, located: counts.located, removed: 0 });
  return { changed: false, reason };
}

/**
 * 「未使用 import」の診断 1 行の形（**実測。Go 1.26.5 / 2026-08-28**）。
 *
 * ビルド関数のイメージは `golang:1.26.5`（`docker/isolated-build/Dockerfile`）で、
 * 実測はそれと同じ版で採った。`GOOS=js GOARCH=wasm` でも同じ文言である。
 *
 * ```
 * ./main.go:5:2: "os" imported and not used
 * ./main.go:6:2: "strings" imported as str and not used
 * ./main.go:7:2: "math" imported and not used      ← import . "math"
 * ```
 *
 * **`_ "embed"`（空白識別子）はそもそも診断されない**ので、除去の対象にならない。
 *
 * **古い綴り（`imported and not used: "os"`）は受けない。** 実測で出ない形を先回りで
 * 受けると、当たっているかどうかを確かめる手段が無いまま分岐だけが残る。版が上がって
 * 文言が変われば、この段は「何も直せない」に落ちる（2 段目へ回るだけで、誤って
 * 消すことはない）。
 */
const UNUSED_IMPORT_PATTERN =
  /^(?<file>[^\s:]+):(?<line>\d+):(?<column>\d+): "(?<path>[^"]*)" imported(?: as (?<alias>[^\s"]+))? and not used/u;

/**
 * Go の診断から「使われていない import」を拾う。
 *
 * **対象はモジュールルートのファイルの診断だけである。** 生成コードは作業ディレクトリ
 * 直下へ書かれ（`docker/isolated-build/handler/handler.go` が `main.go` を置く）、
 * `vendor/` 配下など**別のファイルの行・桁**をこちらのソースへ当てると、無関係な
 * import を消す。名前そのもの（`main.go`）で絞らないのは、書き出し先の名前が変わった
 * ときに**黙って効かなくなる**ためで、区切り文字の有無なら「ルートのファイルか」という
 * 意味のまま残る。ルートに置かれるもう 1 つのファイル（テンプレートの `vendor-deps.go`）は
 * 定義上コンパイルが通るので、未使用 import の診断を出さない。
 *
 * **それでも位置だけは信用しない。** 実際に消してよいかは
 * {@link removeUnusedImports} が「その位置に同じ import があるか」で確かめる。
 *
 * @param diagnostics Go の診断（`BuildRejected.diagnostics`）
 * @returns 読み取れた未使用 import（診断中の出現順）
 */
export function parseUnusedImports(diagnostics: string): readonly UnusedImport[] {
  const found: UnusedImport[] = [];
  for (const rawLine of diagnostics.split('\n')) {
    const matched = UNUSED_IMPORT_PATTERN.exec(rawLine.trim());
    const groups = matched?.groups;
    if (groups === undefined) {
      continue;
    }
    const file = groups['file']!.replace(/^\.\//u, '');
    if (file.includes('/')) {
      continue;
    }
    found.push({
      line: Number(groups['line']),
      column: Number(groups['column']),
      path: groups['path']!,
      alias: groups['alias'] ?? null,
    });
  }
  return found;
}

/**
 * 未使用 import を除去したソースを返す（4.2 の 1 段目の本体）。
 *
 * **LLM を呼ばない。** 入力は直前の試行のソースと Go の診断だけで、**副作用は
 * 1 巡につき 1 行のログだけ**である（{@link logPass}。出るのは分類名と件数で、
 * 生成物由来の文字列は出ない）。
 *
 * **消せなかったときは `changed: false` を返す**（例外を投げない）。呼び出し側は
 * そのまま 2 段目（LLM 再生成）へ回せばよく、**判定に迷った分を勝手に書き換えない**のが
 * ここでの「安全な側」である（`src/go-imports.ts` の「判定に迷ったら拒否する」と
 * 向きは同じで、こちらは「迷ったら触らない」になる）。
 *
 * @param source 直前の試行が生成した Go ソース
 * @param diagnostics その試行の Go の診断
 * @returns 除去後のソース、または行わなかった理由
 */
export function removeUnusedImports(source: string, diagnostics: string): MechanicalFixResult {
  const unused = parseUnusedImports(diagnostics);
  if (unused.length === 0) {
    return skipped('no-unused-imports', { diagnosed: 0, located: 0 });
  }

  const scanned = scanImportSpecs(source);
  if (!scanned.ok) {
    return skipped('unreadable-source', { diagnosed: unused.length, located: 0 });
  }
  const { text, declarations } = scanned;

  // **消す対象を、診断の位置とパスの両方が一致したものに限る。**
  // **同じ位置を 2 度数えない**（診断が重複していても、消えるのは 1 件である）。
  const targets = new Map<number, { declaration: GoImportDeclaration; spec: GoImportSpec }>();
  for (const diagnostic of unused) {
    const offset = offsetOfPosition(text, diagnostic.line, diagnostic.column);
    if (offset === null) {
      continue;
    }
    for (const declaration of declarations) {
      for (const spec of declaration.specs) {
        if (spec.start !== offset || spec.path !== diagnostic.path) {
          continue;
        }
        // 診断が別名を名指ししているなら、それも一致していること。ドット import の
        // 診断は別名を書かない（実測）ので、書かれていないときは問わない。
        if (diagnostic.alias !== null && spec.alias !== diagnostic.alias) {
          continue;
        }
        targets.set(spec.start, { declaration, spec });
      }
    }
  }
  if (targets.size === 0) {
    // **診断は読めたのに、その位置に同じ import が無かった。** 件数が食い違うこと
    // 自体が読み取りの手掛かりなので、`diagnosed` と `located` の両方を出す。
    return skipped('not-located', { diagnosed: unused.length, located: 0 });
  }

  // **位置はすべて元のソースに対して先に決めてから、後ろから当てる。** 前から消すと
  // 2 件目以降の位置がずれる。
  const specs = [...targets.values()].map((target) => target.spec);
  const spans = [...targets.values()]
    .map((target) => removalSpan(text, target.declaration, target.spec))
    .sort((left, right) => right.start - left.start);

  let fixed = text;
  let previousStart = text.length;
  for (const span of spans) {
    if (span.end > previousStart) {
      // 重なった範囲（同じ行の宣言をまとめて行ごと消した場合など）。二重に消さない。
      continue;
    }
    fixed = fixed.slice(0, span.start) + fixed.slice(span.end);
    previousStart = span.start;
  }

  if (!verify(text, fixed, specs)) {
    return skipped('verification-failed', { diagnosed: unused.length, located: targets.size });
  }
  const removed = specs.map((spec) => spec.path);

  // **出すのは件数だけである。** `removed` は import のパスの配列（生成物由来）なので、
  // 長さだけを渡す。パスそのものは {@link logPass} へ型として渡せない。
  logPass('removed', {
    diagnosed: unused.length,
    located: targets.size,
    removed: removed.length,
  });

  // BOM は落とさずに戻す。**この関数がするのは import の除去だけ**であって、
  // ほかの違いを持ち込まない。
  const bom = source.length - text.length > 0 ? source.slice(0, source.length - text.length) : '';
  return { changed: true, source: bom + fixed, removed };
}

/**
 * 除去した結果が「元の import から、消したものだけが減った」形になっているかを確かめる。
 *
 * **自分の出力を自分で読み直す。** 位置の計算を 1 つ間違えれば、引用符の途中で切る、
 * 別の宣言を巻き込む、といった壊れ方をする。壊れたソースをビルドへ渡すと、
 * **利用者から見ると「機械修正が壊した」失敗が LLM の失敗として現れる。** ここで
 * 落としておけば、最悪でも「何もしなかった」に着地する（2 段目へ回る）。
 *
 * @param before 除去前のソース（BOM を落としたもの）
 * @param after 除去後のソース
 * @param removed 除去した ImportSpec
 * @returns 期待どおりなら true
 */
function verify(before: string, after: string, removed: readonly GoImportSpec[]): boolean {
  const scannedBefore = scanImportSpecs(before);
  const scannedAfter = scanImportSpecs(after);
  if (!scannedBefore.ok || !scannedAfter.ok) {
    return false;
  }

  const pathsOf = (scan: { readonly declarations: readonly GoImportDeclaration[] }): string[] =>
    scan.declarations.flatMap((declaration) => declaration.specs.map((spec) => spec.path));

  const expected = pathsOf(scannedBefore);
  for (const spec of removed) {
    const at = expected.indexOf(spec.path);
    if (at === -1) {
      return false;
    }
    expected.splice(at, 1);
  }
  const actual = pathsOf(scannedAfter);
  return expected.length === actual.length && [...expected].sort().join('\0') === [...actual].sort().join('\0');
}

/**
 * 消す範囲を決める。
 *
 * **単一形（`import "os"`）は宣言ごと消す。** ImportSpec だけを消すと `import` が
 * 単独で残り、構文エラーになる。
 *
 * **括弧形（`import ( … )`）は ImportSpec だけを消す。** 全部消えて `import ()` に
 * なっても、コメントだけが残っても、**どちらも正当な Go である**（実測。Go 1.26.5）。
 * 宣言ごと消す条件分岐を持たないほうが、消し過ぎる余地が無い。
 *
 * **直後のセミコロンを巻き込む。** `import ("os"; "fmt")` から `"os"` だけを抜くと
 * `import (; "fmt")` になり、`missing import path` で落ちる（実測）。改行で自動挿入
 * される側は文字として存在しないので、この処理は明示的に書かれた場合にだけ効く。
 *
 * **その行が宣言だけで占められていたら行ごと消す。** 空白だけの行を残さないため。
 * 行末コメント（`"os" // 使う予定`）が残る場合は宣言だけを消す。**コメントが残るのは
 * 正当な Go であり、コメントの中身を解釈して消す判断はここでは行わない。**
 *
 * @param text ソース（BOM を落としたもの）
 * @param declaration 対象が属する宣言
 * @param spec 対象の ImportSpec
 * @returns 消す範囲 `[start, end)`
 */
function removalSpan(
  text: string,
  declaration: GoImportDeclaration,
  spec: GoImportSpec,
): { readonly start: number; readonly end: number } {
  const start = declaration.grouped ? spec.start : declaration.start;
  let end = declaration.grouped ? spec.end : declaration.end;

  let after = end;
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) {
    after += 1;
  }
  if (text[after] === ';') {
    end = after + 1;
  }

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  if (text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '') {
    return { start: lineStart, end: newline === -1 ? lineEnd : lineEnd + 1 };
  }
  return { start, end };
}

/**
 * Go の位置（行・桁）を、文字列の添字へ直す。
 *
 * **桁はバイト数で数える**（`go/token` の `Position.Column` の定義）。文字数で数えると、
 * 日本語のコメントを含む行だけがずれる。行・桁がその行の外を指していたら null を返す
 * （**当てずっぽうで近い位置を選ばない**）。
 *
 * @param text ソース
 * @param line 行番号（1 始まり）
 * @param column 桁（1 始まり、バイト数）
 * @returns 添字、または位置が存在しなければ null
 */
export function offsetOfPosition(text: string, line: number, column: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return null;
  }

  let index = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = text.indexOf('\n', index);
    if (newline === -1) {
      return null;
    }
    index = newline + 1;
  }

  const encoder = new TextEncoder();
  let bytes = 0;
  while (bytes < column - 1) {
    if (index >= text.length || text[index] === '\n') {
      return null;
    }
    // サロゲートペアを 2 つに割らないよう、コードポイント単位で進める。
    const codePoint = String.fromCodePoint(text.codePointAt(index)!);
    bytes += encoder.encode(codePoint).byteLength;
    index += codePoint.length;
  }
  return bytes === column - 1 ? index : null;
}
