/**
 * 生成パイプラインの検査段（3.3 の `inspectSource`）へ差し込む適合層
 * （5.2-5 / 7.1 / 8.3 / #17 / #38）。
 *
 * 検査そのものは `src/go-imports.ts`（5.2-5 の import と指示）と
 * `src/output-moderation.ts`（8.3 の文字列リテラル）が持つ。このモジュールが持つのは
 * **継ぎ目の形**だけで、次の 3 つを担う。
 *
 * 1. `GenerationResult`（生成の段の出力）から Go ソースを取り出して検査へ渡す。
 * 2. 検査が落ちたら**拒否として例外を投げる**。`PipelineStepNotImplemented` を投げない。
 * 3. 拒否の理由と**何が引っかかったか**を、呼び出し側が読める形で運ぶ。
 *
 * ## 2 つの検査を 1 つの段に束ねる（#38）
 *
 * 8.3 の出力側モデレーションを別の段にしていない。**`GenerationPipeline` の段を増やすと、
 * エッジとオーケストレータの 2 か所で結線が要り、片方だけ結線されていない状態を作れる**
 * （`src/orchestrator/pipeline.ts` の表がそれを 1 行で見せている）。5.2-5 と 8.3 は
 * どちらも「生成物を見て、通すか拒否するか」であり、**拒否の扱いも同じ**（再生成に
 * 回さない。下記）なので、段の数を増やす理由がない。
 *
 * ## なぜ検査器と別のファイルなのか
 *
 * `inspectGoImports` は文字列を受けて結果を返す純粋な関数で、パイプラインの型も
 * `GenerationResult` も知らない。そこへ `src/generate.ts` の都合を持ち込むと、検査器の
 * テストが生成の型に依存し始める。**検査（何が許されるか）と結線（どこで呼ばれ、
 * 落ちたら何が起きるか）は別々に変わる**ので、変わる理由ごとにファイルを分ける。
 *
 * ## 拒否の種類を列挙しない
 *
 * `ImportRejection` を `switch` で網羅したり、こちら側で別の enum へ写したりしない。
 * **検査器が返した理由をそのまま運ぶ。** 検査器（#100）が新しい拒否理由を足したとき、
 * ここを直さなくても素通りする形にしておくためである。写し替えを挟むと、足された理由が
 * こちら側の既定値へ丸められ、**新しい拒否が「理由不明の拒否」として現れる。**
 *
 * ## 再生成に回さない（5.2-5 / 8.3）
 *
 * 5.2-5 は「違反は再生成に回さず拒否」と定める。したがってここは例外を投げるだけで、
 * リトライも、緩和した再検査も行わない。**8.3 の NG ワードも同じ扱いにする**（#38）。
 * 理由は 5.2-5 と同じで、**再生成に回すと、差別語を出したがるプロンプトが 1 回の枠で
 * 複数回の生成を起こせる**（4.3 の上限が緩む）。しかも表に当たったソースを引き直しても、
 * 同じプロンプトからは同じ語が出やすい——**費用だけが増えて結果が変わらない。**
 *
 * 5.2-7 の自動リトライ（#20）が対象にするのは**コンパイル失敗**であって、ホワイトリスト
 * 違反ではない。混ぜると、禁止パッケージを使いたがるプロンプトが 1 回の枠で複数回の
 * 生成を起こせる（4.3 の上限が緩む）。
 *
 * ## 整形に寛容にしない
 *
 * ` ```go ` で囲まれた出力や前置きの文を、ここで剥がして検査し直すことはしない。
 * 6.1 は本文の 1 節目（役割と出力形式）に「1 文字目が `package main` であること」を
 * 置いており、**整形はプロンプト側の責務として設計されている。** ここで救うと、
 * `scanImports` の「判定に迷ったら拒否する」方針に対する迂回路を、適合層の側から
 * 開けることになる（剥がし方の解釈がひとつ増えるため）。読めない出力は
 * `unparsable` / `no-package-clause` として落ちてよい。
 *
 * なお `stopReason === 'max_tokens'` で切れたソースもここで落ちるが、それは
 * ホワイトリスト違反ではない。**種類は理由として区別できる形で運ぶ**ので、
 * リトライの可否（#20）はこの例外を受けた側が判断できる。
 */
import type { DeniedTerm } from './denied-terms.js';
import { DENIED_TERMS } from './denied-terms.js';
import { classifySourceBytes, measureSourceBytes } from './source-size.js';
import type { GenerationResult } from './generation-models.js';
import type { ImportRejection } from './go-imports.js';
import { inspectGoImports } from './go-imports.js';
import type { DeniedTermRejection } from './output-moderation.js';
import { inspectStringLiterals } from './output-moderation.js';

/**
 * 生成されたソースを受け付けなかった理由。
 *
 * **2 つの検査の理由を合わせた形である。** 5.2-5 の import / 指示（`ImportRejection`）と、
 * 8.3 の文字列リテラル（`DeniedTermRejection`）で、**どちらも「再生成に回さず拒否」**
 * という同じ扱いになる（下記「再生成に回さない」）。理由の側は混ぜず、どちらの検査が
 * 落としたかが読み取れる形で運ぶ。
 */
export type SourceRejection = ImportRejection | DeniedTermRejection | SourceSizeRejection;

/**
 * 生成物がソースの上限（`MAX_SOURCE_BYTES`）を超えていた（5.3 / 6.1 / 確定18 / M5-2 / #33）。
 *
 * **`src/source-store.ts` が返す `source-too-large` と綴りを揃えてある。** あちらは
 * 「R2 から読んだ元ソースが大きすぎる」、こちらは「いま生成された出力が大きすぎる」で、
 * **測っている対象は違うが上限は同じ 1 つ**（`MAX_SOURCE_BYTES`）である。
 */
export type SourceSizeRejection = 'source-too-large';

/**
 * 拒否を伝えるときに載せる import パスの最大件数。
 *
 * import パスは**生成物の一部**であり、プロンプトの影響を受ける。応答にもログにも
 * 出る値なので、件数と長さの両方に上限を置く。診断に要るのは「何が引っかかったか」で
 * あって全件ではない。
 */
export const MAX_REPORTED_OFFENDING = 10;

/** 拒否を伝えるときの 1 パスあたりの最大文字数。超えた分は切り詰める。 */
export const MAX_REPORTED_OFFENDING_LENGTH = 120;

/**
 * 経路層が拒否へ写す HTTP ステータス。
 *
 * **422 とする。** 400 は「リクエストが壊れている」であり、ここで落ちたリクエストは
 * 検証を通っている（`parseGenerateRequest` は成功している）。500 でもない。段は
 * 設計どおりに動いており、**生成物が受け付けられなかった**という結果そのものが応答である。
 * 429（クォータ超過）とも別で、枠は消費済みである（3.3-4 の費用計上はこの段より前にある）。
 */
export const SOURCE_REJECTED_STATUS = 422;

/** 拒否を伝える応答の `error` の値。 */
export const SOURCE_REJECTED_ERROR = 'source-rejected';

/**
 * 生成されたソースを受け付けなかった。
 *
 * **`PipelineStepNotImplemented` と区別する。** あちらは「段が無い」、こちらは
 * 「段が働いて落とした」であり、経路層の応答（501 と 422）も、運用時に見るべき場所も違う。
 *
 * `reason` は検査器が返した理由をそのまま持つ。ここで別の型へ写さないのは、
 * 検査器が理由を足したときに写し替えの側が古くなるためである（モジュール冒頭）。
 *
 * **`offending` に載るものは理由で変わる。** `not-allowed` なら import パス、
 * `directive-not-allowed` なら指示の名前、`denied-term`（8.3）なら**語の分類**である。
 * どれも上限を掛けたうえで応答へ出る。**`denied-term` で当たった語そのものは載せない**
 * （`src/denied-terms.ts` の `category` の注記。応答が表を引き出す口になる）。
 */
export class GeneratedSourceRejected extends Error {
  /**
   * @param reason 検査器が返した理由。**そのまま運ぶ**（種類を列挙しない）
   * @param offending 引っかかったものの識別子。**理由で中身が変わる**（クラスの説明を
   *   参照。`not-allowed` なら import パス、`directive-not-allowed` なら指示の名前、
   *   `denied-term` なら語の分類）。理由によっては空
   */
  constructor(
    readonly reason: SourceRejection,
    readonly offending: readonly string[],
  ) {
    // message にはソース本文もプロンプトも入れない。**上限を掛けた識別子だけ**を
    // 載せる（理由によって import パス / 指示の名前 / 語の分類のいずれか。#216）。
    // `src/generate.ts` は段が投げた例外の message をログへ出さない方針だが、
    // 「何が安全か知っている場所で出す」のはこの段の責務なので、ここで安全な形にする。
    const listed = summarizeOffending(offending);
    super(
      listed.length === 0
        ? `生成されたソースを拒否しました: ${reason}`
        : `生成されたソースを拒否しました: ${reason}（${listed.join(', ')}）`,
    );
    this.name = 'GeneratedSourceRejected';
  }
}

/**
 * 検査段を作る（5.2-5 と 8.3 の 2 つを直列に掛ける）。
 *
 * **引数は NG ワード表だけである。** 既定は `src/denied-terms.ts` の一覧で、
 * **テストがダミー語を注入するための口**として開けてある（実在の差別語をテストへ
 * 書かずに、規則と結線の両方を試せるようにするため）。運用で表を差し替える口では
 * ない——表をコード側に置いた理由は `src/denied-terms.ts` の冒頭にある。
 *
 * @param terms 拒否する語の表
 * @returns `GenerationPipeline['inspectSource']` へ代入できる検査段
 */
export function createSourceInspector(
  terms: readonly DeniedTerm[] = DENIED_TERMS,
): (generated: GenerationResult) => void {
  return (generated: GenerationResult): void => {
    // **6.1 / 5.3 のソース上限（`MAX_SOURCE_BYTES`。生成後のサイズ検査。M5-2 / #33）。**
    //
    // **いちばん先に見る。** 上限を超えた出力は、この先の検査がどう転んでも保存できない
    // ——`src/source-store.ts` が読み出し側で断つので、**通しても次にフォークや推敲を
    // した瞬間に行き止まりになる。** 先に落とせば、字句解析と NG ワード表を上限超の
    // 文字列に対して回さずに済む。
    //
    // **再生成に回さない**（この段の例外はループを素通りする。`src/generate.ts`）。
    // これが確定18 の**条件 3**「整理は 1 回まで。整理後も上限を超えたら、そこで
    // 拒否する」の実体である——整理パスの出力がまだ超えていたら、ここで落ちて
    // **2 回目の整理は起きない。**
    //
    // **`offending` は空にする。** 5.3 の上限はソース全体の性質で、引用できる断片が
    // 無い。件数や長さを載せると、**生成物由来の文字列を応答とログへ持ち出す**
    // （このモジュールが上限を掛けている理由そのもの）。
    if (classifySourceBytes(measureSourceBytes(generated.source)) === 'over-limit') {
      throw new GeneratedSourceRejected('source-too-large', []);
    }

    // **5.2-5 を先に見る。** import と指示は 7.1 のコンテナに対する多層防御の層で、
    // 8.3 は表示物の話である。両方に違反しているソースでは、**先に安全側の理由**を
    // 返したい（`inspectGoImports` が指示を import より先に見ているのと同じ考え方）。
    const imports = inspectGoImports(generated.source);
    if (!imports.ok) {
      // 理由も違反 import も、検査器が返したものをそのまま渡す。
      throw new GeneratedSourceRejected(imports.reason, imports.offending ?? []);
    }

    // 8.3: 出力側モデレーション。**文字列リテラルの抽出は M2-3 と同じ字句解析を使う。**
    const literals = inspectStringLiterals(generated.source, terms);
    if (!literals.ok) {
      throw new GeneratedSourceRejected(literals.reason, literals.categories);
    }
  };
}

/**
 * 生成されたソースを検査し、許可外の import（5.2-5）と NG ワード（8.3）を拒否する。
 *
 * `GenerationPipeline['inspectSource']` へそのまま代入できる形にしてある
 * （`(generated: GenerationResult) => void`）。**成功時は何も返さない。** 読み取れた
 * import の一覧は後段が使わないため、継ぎ目の戻り値を増やさない。
 *
 * **既定の NG ワード表を束ねた形である。** エッジ（`src/generate.ts`）と
 * オーケストレータ（`src/orchestrator/pipeline.ts`）がどちらもこれを借りるので、
 * **実行環境によって表が違う状態を作らない。**
 *
 * @param generated 生成の段（3.3-3）が返した結果
 * @throws {GeneratedSourceRejected} 検査が通らなかった場合
 */
export const inspectGeneratedSource: (generated: GenerationResult) => void =
  createSourceInspector();

/**
 * 拒否を、応答本文にもログにも出してよい形へ落とす。
 *
 * **経路層はこれを使う。** 例外のフィールドを経路層で直接組み立てると、上限を掛け忘れた
 * 応答が生まれる。「何を外へ出してよいか」の判断はこの段が持つ（`src/generate.ts` の
 * `describeGenerateError` が「段の診断情報は段自身が出す」としているのに対応する）。
 *
 * `reason` はそのまま出す。検査器が足した新しい理由も、ここを直さずに応答へ現れる。
 *
 * @param rejected 拒否の例外
 * @returns 応答本文にできるオブジェクト
 */
export function describeSourceRejection(rejected: GeneratedSourceRejected): {
  readonly error: string;
  readonly reason: SourceRejection;
  readonly offending: readonly string[];
} {
  return {
    error: SOURCE_REJECTED_ERROR,
    reason: rejected.reason,
    // **`imports` から `offending` へ改名した**（#216）。#38 で中身が「理由ごとの
    // 識別子」へ広がり（8.3 なら語の分類）、**名前が中身と合わなくなっていた。**
    // `imports: ["discriminatory"]` は import パスではないのに、ログや応答を見る人が
    // 「許可外の import が使われた」と読むおそれがある。
    //
    // **版は分けず、両方も出さない。** 応答本文の綴りを変えるので #38 では見送ったが、
    // 改めて消費側を調べたところ、**この項目を読んでいるのはテストだけだった**
    // （`public/` にも各ページのモジュールにも読み手がいない）。しかもこれは 422 の
    // 誤り本文であって成功時の契約ではない。**両方を出すと、誤った名前を残す口実に
    // なる。** 名前は例外側の `offending` に合わせる（あちらの綴りは変えない）。
    offending: summarizeOffending(rejected.offending),
  };
}

/**
 * 応答へ載せる識別子の一覧へ、件数と長さの上限を掛ける。
 *
 * 切り詰めたことが読み手に分かるよう、末尾に印を付ける。黙って削ると「これで全部だ」と
 * 読まれる。
 *
 * **載るものは理由で変わる**（import パス / 指示の名前 / 8.3 の語の分類）。上限の掛け方は
 * どれでも同じなので、理由ごとに分けない。**名前に `import` を含めない**のはそのためで、
 * 含めると #216 と同じ取り違えを内側で再生産する。
 *
 * @param offending 引っかかったものの識別子
 * @returns 上限を掛けた一覧
 */
function summarizeOffending(offending: readonly string[]): readonly string[] {
  const listed = offending
    .slice(0, MAX_REPORTED_OFFENDING)
    .map((identifier) =>
      [...identifier].length > MAX_REPORTED_OFFENDING_LENGTH
        ? `${[...identifier].slice(0, MAX_REPORTED_OFFENDING_LENGTH).join('')}…`
        : identifier,
    );
  const remaining = offending.length - listed.length;
  return remaining > 0 ? [...listed, `…他 ${remaining} 件`] : listed;
}
