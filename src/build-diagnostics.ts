/**
 * ビルドで落ちた試行の診断を、固定の分類名と件数に落としてログへ出す（4.2 / #443）。
 *
 * # なぜ要るのか
 *
 * **生成が `build-failed` で終わったとき、原因を追う手段が 1 つも無かった。**
 * 2026-09-14 の作品 `91de0745`（横スクロールのシューティング）は 2 回とも `stage=build`
 * で落ちたが、オーケストレータのログにもビルド関数のログにも手掛かりが無く、失敗した
 * ソースも保存されないため、**どの種類の誤りで落ちたのかすら分からなかった。**
 * 機械修正の行（`src/mechanical-fix.ts`）が教えるのは「未使用 import が何件あったか」
 * だけで、それ以外の失敗は `no-unused-imports` の 1 語に潰れる。
 *
 * # 出すのは分類名と件数だけである（8.3 / #129 / #133）
 *
 * **Go の診断は生成コードの行と識別子を引用する。** 8.3 の検査を通っていない文字列なので、
 * #129 は何も出さず、#133 は件数と固定の分類名に限って開けた。**このモジュールも同じ線の
 * 内側にいる。** 出さないものは #133 と同じである。
 *
 * - **Go の診断。** 識別子（`vector.DrawFilledRoundRect`）、型、ファイル名、行・桁。
 * - **import のパス。**
 * - **生成ソースとプロンプト。**
 *
 * **これを呼びかけで担保しない**（shared-ai-rules 12 章）。{@link logBuildDiagnostics} が
 * 受け取れるのは試行番号と {@link BuildDiagnosticsSummary}（件数・真偽値・固定語彙）だけで、
 * **生成物由来の文字列は型として渡せない。** 出す直前に項目を 1 つずつ入れ直すので、
 * 呼び出し側が器に余分な項目を足しても外へは出ない。
 *
 * # 分類は診断の文面で決める（実測。Go 1.27.0 / `GOOS=js GOARCH=wasm` / 2026-09-13）
 *
 * ビルド関数のイメージ（`docker/isolated-build/Dockerfile` の `ARG GO_VERSION`）と同じ版で、
 * LLM が書きそうな誤りを並べたソースを `go build` に通して文面を採った。
 * **{@link BUILD_DIAGNOSTIC_CATEGORIES} の各分類に、その実物の 1 行がある**
 * （`test/build-diagnostics.test.ts` が同じ文面を入力にする）。
 *
 * **文面の解釈は先頭一致・部分一致の最小限に留める。** 版が上がって文言が変われば、
 * その行は `other` に落ちるだけで、件数の合計は変わらない（数え漏れにはならない）。
 *
 * # 何を 1 件と数えるか
 *
 * **`<ファイル>:<行>:<桁>: <本文>` の形の行が 1 件である。** 次は数えない。
 *
 * - パッケージの見出し（`# gameforge.local/sandbox`）
 * - タブで始まる続きの行（引数の `have` / `want`、`other declaration of g`）
 * - `too many errors`（位置を持つが誤りではない。**打ち切りの印**として
 *   {@link BuildDiagnosticsSummary.truncated} に写す。`go build` は 10 件で打ち切る）
 *
 * **形に合わない行は {@link BuildDiagnosticsSummary.unpositioned} に数える。** 関数が 8 KiB で
 * 切り詰めたときの末尾（`docker/isolated-build/handler/build.go` の `trimDiagnostics`）や、
 * `go` コマンド自身のエラーがここへ来る。**0 でなければ、診断が Go の型検査の形をしていない**
 * と読める。
 */
import type { BuildRejected } from './build-client.js';

/**
 * 診断 1 件の分類（この配列が正本）。**判定は並びの順に行い、最初に当たったものを採る。**
 *
 * **ログへ出してよい分類名はここに並ぶものだけである**（8.3 / #443）。仕様書 4.2 の #443 の
 * 表が同じ一覧を持つので、`test/build-diagnostics.test.ts` が機械照合する
 * （shared-ai-rules 12 章）。
 *
 * **`not-implemented` は `type-mismatch` より前に置く。** 実物の文面は
 * `cannot use &Game{} (value of type *Game) as ebiten.Game value in argument to ...: *Game does
 * not implement ebiten.Game (missing method Layout)` で、`cannot use` でも当たるためである。
 * 同じ理由で `missing-field-or-method` も `not-implemented` の後に置く（`missing method` を含む）。
 */
export const BUILD_DIAGNOSTIC_CATEGORIES = [
  /** `syntax error: unexpected newline in argument list; possibly missing comma or )` */
  'syntax',
  /** `*Game does not implement ebiten.Game (missing method Layout)` */
  'not-implemented',
  /** `screen.DrawRect undefined (type *ebiten.Image has no field or method DrawRect)` */
  'missing-field-or-method',
  /** `undefined: ebiten.KeyFoo`（**パッケージ名で修飾された名前**。API の捏造はここへ来る） */
  'undefined-package-member',
  /** `undefined: undefinedFunc`（修飾の無い名前） */
  'undefined-name',
  /** `cannot use w (variable of type int) as float32 value in argument to ...` / `(mismatched types float64 and int)` */
  'type-mismatch',
  /** `not enough arguments in call to vector.DrawFilledRect` / `too many arguments in call to doThing` */
  'argument-count',
  /** `assignment mismatch: 2 variables but single returns 1 value` */
  'assignment-count',
  /** `declared and not used: unused` */
  'unused-variable',
  /** `"os" imported and not used`（**機械修正が消す対象**。`src/mechanical-fix.ts`） */
  'unused-import',
  /** `g redeclared in this block` / `method Game.Update already declared at ...` / `no new variables on left side of :=` */
  'redeclared',
  /** `missing return` */
  'missing-return',
  /** 上のどれにも当たらなかった（`non-boolean condition in if statement` など）。 */
  'other',
] as const;

/** 診断 1 件の分類（{@link BUILD_DIAGNOSTIC_CATEGORIES} の要素）。 */
export type BuildDiagnosticCategory = (typeof BUILD_DIAGNOSTIC_CATEGORIES)[number];

/**
 * ビルド関数が止まった段の固定語彙（`docker/isolated-build/handler/handler.go` の `Stage`）。
 *
 * **関数から来た値をそのまま出さない。** 関数は自前の実装だが、応答本文を経由した文字列で
 * あることは変わらない。知っている 3 語以外は `unknown` へ落とす。
 */
export const BUILD_STAGES = ['request', 'build', 'compress', 'unknown'] as const;

/** ビルド関数が止まった段（{@link BUILD_STAGES} の要素）。 */
export type BuildStage = (typeof BUILD_STAGES)[number];

/**
 * 1 回のビルドの診断を数えたもの。**件数・真偽値・固定語彙だけで、生成物由来の文字列を含まない。**
 */
export interface BuildDiagnosticsSummary {
  /** ビルド関数が止まった段。 */
  readonly stage: BuildStage;
  /** 分類ごとの件数。**すべての分類を必ず持つ**（0 件も書く）。 */
  readonly counts: Readonly<Record<BuildDiagnosticCategory, number>>;
  /** 数えた件数の合計（＝ `<ファイル>:<行>:<桁>: <本文>` の形の行の数。打ち切りの印を除く）。 */
  readonly total: number;
  /** `go build` が `too many errors` で打ち切ったか。**true なら、これより多くの誤りがある。** */
  readonly truncated: boolean;
  /** 見出し・続きの行・空行のどれでもなく、位置の形にも合わなかった行の数。 */
  readonly unpositioned: number;
}

/** `<ファイル>:<行>:<桁>: <本文>`。ファイルは `./main.go` とも `main.go` とも出る（実測）。 */
const POSITIONED_LINE = /^[^\s:]+:\d+:\d+: (?<message>.*)$/u;

/** パッケージの見出し（`# gameforge.local/sandbox`）。 */
const PACKAGE_HEADER = /^# \S+$/u;

/**
 * 本文から分類を決める規則。`other` は規則を持たない（どれにも当たらなかったときの行き先）。
 *
 * **判定の順はこの表ではなく {@link BUILD_DIAGNOSTIC_CATEGORIES} の並びが持つ。** 表を
 * 分類名で引く形にしてあるので、並びを 2 か所に書かない。分類を足して規則を書き忘れると
 * 型検査が落ちる。
 */
const CATEGORY_RULES: Readonly<Record<Exclude<BuildDiagnosticCategory, 'other'>, RegExp>> = {
  syntax: /^syntax error: /u,
  'not-implemented': / does not implement /u,
  'missing-field-or-method': / has no field or method /u,
  'undefined-package-member': /^undefined: [^\s.]+\.[^\s.]+$/u,
  'undefined-name': /^undefined: [^\s.]+$/u,
  'type-mismatch': /^cannot use .+ as .+ value in |\(mismatched types /u,
  'argument-count': /^(?:not enough|too many) arguments in call to /u,
  'assignment-count': /^assignment mismatch: /u,
  'unused-variable': /^declared and not used: /u,
  'unused-import': /^"[^"]*" imported(?: as \S+)? and not used$/u,
  redeclared: / redeclared in this block$|^method \S+ already declared at |^no new variables on left side of :=$/u,
  'missing-return': /^missing return$/u,
};

/**
 * 診断の本文 1 つを分類する。
 *
 * @param message `<ファイル>:<行>:<桁>: ` より後ろ
 * @returns 分類
 */
function categoryOf(message: string): BuildDiagnosticCategory {
  for (const category of BUILD_DIAGNOSTIC_CATEGORIES) {
    if (category !== 'other' && CATEGORY_RULES[category].test(message)) {
      return category;
    }
  }
  return 'other';
}

/**
 * 段の名前を固定語彙へ落とす。
 *
 * @param stage `BuildRejected.stage`
 * @returns 固定語彙の段
 */
function stageOf(stage: string): BuildStage {
  return (BUILD_STAGES as readonly string[]).includes(stage) ? (stage as BuildStage) : 'unknown';
}

/**
 * ビルドの拒否を数える。**副作用は無い**（ログは {@link logBuildDiagnostics} が出す）。
 *
 * @param rejected ビルドの拒否
 * @returns 数えたもの
 */
export function summarizeBuildDiagnostics(
  rejected: Pick<BuildRejected, 'stage' | 'diagnostics'>,
): BuildDiagnosticsSummary {
  const counts = Object.fromEntries(BUILD_DIAGNOSTIC_CATEGORIES.map((category) => [category, 0])) as Record<
    BuildDiagnosticCategory,
    number
  >;
  let total = 0;
  let truncated = false;
  let unpositioned = 0;

  for (const rawLine of rejected.diagnostics.split('\n')) {
    // 続きの行はタブで始まる（実測）。**trim する前に見る。**
    if (rawLine.startsWith('\t')) {
      continue;
    }
    const line = rawLine.trim();
    if (line === '' || PACKAGE_HEADER.test(line)) {
      continue;
    }
    const message = POSITIONED_LINE.exec(line)?.groups?.['message'];
    if (message === undefined) {
      unpositioned += 1;
      continue;
    }
    if (message === 'too many errors') {
      truncated = true;
      continue;
    }
    counts[categoryOf(message)] += 1;
    total += 1;
  }

  return { stage: stageOf(rejected.stage), counts, total, truncated, unpositioned };
}

/**
 * ビルドで落ちた試行 1 回につき 1 行をログへ出す（4.2 / 8.3 / #443）。
 *
 * **引数の型がそのまま安全性の根拠である。** 受け取れるのは試行番号と、件数・真偽値・固定語彙
 * だけの器である。**出す直前に項目を 1 つずつ入れ直す**ので、器に余分な項目が足されていても
 * 外へは出ない（`src/mechanical-fix.ts` の `logPass` と同じ）。
 *
 * 読み方（どの分類が多ければ何を疑うか）は**仕様書 4.2 の #443 注記**にある。
 *
 * @param attempt 何回目の試行か（1 始まり。台帳の行と同じ単位）
 * @param summary 数えたもの
 */
export function logBuildDiagnostics(attempt: number, summary: BuildDiagnosticsSummary): void {
  const counts = Object.fromEntries(
    BUILD_DIAGNOSTIC_CATEGORIES.map((category) => [category, Number(summary.counts[category])]),
  );
  const fields = {
    attempt: Number(attempt),
    stage: stageOf(summary.stage),
    total: Number(summary.total),
    truncated: summary.truncated === true,
    unpositioned: Number(summary.unpositioned),
    counts,
  };
  console.info(`[build-diagnostics] ${JSON.stringify(fields)}`);
}
