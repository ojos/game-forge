/**
 * コンパイル失敗時の自動リトライ（5.2-7 / 4.3 / #20）。
 *
 * 5.2-7 は「**コンパイル失敗時はエラー出力を LLM に返して自動リトライ（最大2回）。**
 * 各試行の費用を台帳に計上する」と定める。このモジュールが持つのは、その **判断と
 * 材料の整形**だけである。回す場所（ループ）は 3.3 の順序を持つ `src/generate.ts` に
 * あり、費用の計上は `src/cost-ledger.ts` が持つ。
 *
 * ## 何をリトライ対象にするか（#20 の決定）
 *
 * **`BuildFailure` の `kind === 'build'` だけを引き金にする。** つまり
 * {@link BuildRejected}（生成コードがコンパイルを通らなかった）だけである。
 *
 * | 種別 | 実体 | リトライ | 理由 |
 * |---|---|---|---|
 * | `build` | `BuildRejected` | **する** | 5.2-7 そのもの。診断があり、次の試行が変わる根拠になる |
 * | `config` | `BuildNotConfigured` | しない | 環境の不備で**決定的に**落ちる。回せば 1 リクエストで 3 回課金して必ず失敗する |
 * | `timeout` | `BuildTimedOut` | **しない**（ただし下記） | 診断が無いので、LLM へ返せる材料が 1 文字も無い |
 * | `function` | `BuildFunctionFailed` / `BuildResponseUnreadable` | しない | 同上。とくに 429（スロットリング）を再生成で叩き直すと滞留を増やす |
 *
 * ## `timeout` の扱いは #164 で半分だけ変わった
 *
 * 1.2.33 は `timeout` を外す根拠を 2 つ並べていた。**片方は死に、片方は生きている。**
 *
 *   - **「やり直しても関数側の事情は変わらない」は死んだ。** これはタイムアウトが
 *     10 秒固定で「絶対に間に合わない」を意味していた頃の判断である。いまの
 *     時間切れは「21〜24 秒の分布が壁を超えた」ことで、**同じソースを投げ直せば
 *     通る見込みが十分にある**（#164）。
 *   - **「診断が無い」は生きている。** LLM へ返す材料はいまも 1 文字も無い。
 *     材料の無い再生成は**約 16 円と日次枠 1 回を賭けるだけ**である。
 *
 * **したがって、やり直すのはビルドだけにした。** 呼び直しは
 * `src/build-client.ts` の `invokeBuildFunction` が持ち（同じソースで 1 回だけ）、
 * **費用は Lambda の 1 呼び出し（約 0.35 円）、台帳の行は作らず、日次クォータも
 * 減らない。** 4.2 の 1 段目（機械修正）と同じ層に置いた、と読むのが正しい。
 *
 * **この表は変えない。** {@link retriableBuildFailure} が見ているのは「**LLM を
 * 呼び直してよいか**」であって、「ビルドをやり直してよいか」ではない。混ぜると、
 * 費用ゼロの段と 16 円の段が同じ引き金を共有することになる。
 *
 * **`GeneratedSourceRejected`（5.2-5 の許可外 import）は対象外である。** 5.2-5 が
 * 「違反は再生成に回さず拒否」と定めており、混ぜると禁止パッケージを使いたがる
 * プロンプトが 1 回のリクエストで 3 回の生成を起こせる（`src/source-inspection.ts` の
 * モジュール冒頭）。**引き金を「ビルド段の失敗」に限っているので、検査段の例外は
 * ループを素通りして経路層まで上がる。**
 *
 * **`stopReason === 'max_tokens'` それ自体も引き金にしない。** 切れたソースは 5.2-5 の
 * 検査で `unparsable` として落ちるので、上の規則により 422 のまま返る（#17 の申し送りに
 * 対する答え）。理由は 2 つある。
 *
 * 1. **返せる診断が無い。** 5.2-7 の形は「エラー出力を LLM に返して」であり、
 *    出力上限で切れたことに対応する診断はどこにも無い。
 * 2. **1 回あたりが最も高い失敗である。** `max_tokens` は出力枠を使い切った応答で、
 *    Sonnet 4.6 なら 16,000 トークン（実測の通常値 4,171 の約 3.8 倍）である。
 *    3 試行に回すと 1 リクエストで通常の約 11 倍を燃やす。4.3 の「判断に迷う側は
 *    必ず高い側へ倒す」は費用について**安全な側**へ倒すことなので、ここでは回さない。
 *
 * **`unparsable` を引き金にしないことも決定である。** `unparsable` は切れたソース
 * 以外にも、コードフェンスや前置きの付いた出力で出る。`src/source-inspection.ts` は
 * 「整形はプロンプト側の責務」として救わない方針を採っており、こちらから再生成で
 * 救うと同じ迂回路を裏口から開けることになる。
 *
 * **切れたソースがたまたま検査を通った場合は、通常どおりリトライされる。** そのときは
 * ビルドが診断付きで落ちるので、上の 1 も 2 も当たらない（材料があり、失敗の形は
 * 普通のコンパイル失敗と同じ）。**`stopReason` を見て特別扱いする分岐を置かない**のは、
 * そのためである。
 *
 * ## 診断は `message` ではなく `diagnostics` にある
 *
 * `BuildRejected` は Go の診断を `message` に入れない（生成コードの行を引用するため)。
 * **読むのは {@link BuildRejected.diagnostics} である。** 同じ理由で、このモジュールが
 * 作る文字列も**ログへ出さない。** 出してよいのは種別と試行回数だけで、それは
 * {@link describeBuildFailure} が持つ。
 *
 * ## もう 1 つの段（4.2 の「リトライは 2 段構成にする」）
 *
 * 4.2 は「1. 機械修正（費用ゼロ）/ 2. LLM 再生成（費用が発生）」の 2 段を書いている。
 * **このモジュールが持つのは 2 だけである**（#20 の scope.in が 2 だけを挙げていた）。
 *
 * **1 は #129 が `src/mechanical-fix.ts` として実装した。** 未使用 import の除去だけで、
 * 4.2 が併記する「不足 import の補完」は範囲外である（実測が支持していない。#129）。
 * 置き場所は #20 が記していたとおり **`src/generate.ts` のループの中、ビルドが
 * `kind='build'` で落ちた直後**で、費用ゼロの段なので**台帳の行を作らず、日次クォータにも
 * 数えない**（確定25）。**1 で直らなかったものが 2、すなわちこのモジュールへ回る。**
 */
import type { GenerationResult } from './generation-models.js';
import { BuildFailure, BuildRejected } from './build-client.js';
import { MAX_SOURCE_BYTES } from './system-prompt.js';

/**
 * 1 リクエストで許す LLM 呼び出しの最大回数（5.2-7 の「初回＋2」）。
 *
 * **仕様書は再試行の回数（2）で、この定数は試行の総数（3）である。** 数え方が違う
 * ものを同じ数字にすると、どちらの意味で書かれた 3 なのかが読めなくなる。
 * 仕様書 5.2-7 の「最大2回」との一致は `test/generate.test.ts` が機械照合する
 * （shared-ai-rules 12 章）。
 */
export const MAX_GENERATION_ATTEMPTS = 3;

/**
 * 再投入する診断の最大バイト数。
 *
 * **関数側の 8 KiB とは別の上限である。** あちらは関数が応答へ載せる量の契約で、
 * こちらは**こちらのプロンプトが膨らまないための上限**である。関数側の契約が変われば
 * こちらの入力トークンが黙って増えるので、自分の側でも縛る。
 *
 * 頭から取るのは、Go が診断をファイル順に出し、最初の 10 件で打ち切るためである。
 * 根本原因は先頭側にあり、末尾は先頭のエラーから派生した二次被害であることが多い。
 */
export const MAX_RETRY_DIAGNOSTICS_BYTES = 4 * 1024;

/**
 * 直前の試行が何で落ちたか。**次の生成へ渡す材料**である。
 *
 * `previousSource` を持たせるのは、Go の診断が行番号と識別子でソースを指すためで、
 * ソースが無ければ診断だけを渡しても直せない。
 */
export interface BuildRetryContext {
  /** 何回目の試行が失敗したか（1 始まり）。 */
  readonly failedAttempt: number;
  /** 関数が止まった段（`request` / `build` / `compress`）。 */
  readonly stage: string;
  /** Go の診断。**空でありうる**（関数が診断を持たずに落ちる段がある）。 */
  readonly diagnostics: string;
  /** 直前の試行が生成したソース。 */
  readonly previousSource: string;
}

/**
 * 例外がリトライしてよいビルド失敗かを判定する。
 *
 * **方針は `kind` で決める**（モジュール冒頭の表）。`instanceof` の連鎖を書かないのは
 * `src/build-client.ts` が `kind` を用意した理由そのものである。診断を読むために
 * 型まで絞るが、**絞れなかったものはリトライしない側へ倒す。** `kind='build'` を
 * 名乗る新しい型が増えたとき、診断の形が違うかもしれないものを推測で再生成へ回すと、
 * 手掛かりの無いまま課金だけが 3 倍になる。
 *
 * @param error catch した値（型は unknown）
 * @returns リトライしてよい失敗ならその例外、そうでなければ null
 */
export function retriableBuildFailure(error: unknown): BuildRejected | null {
  if (!(error instanceof BuildFailure)) {
    return null;
  }
  if (error.kind !== 'build') {
    return null;
  }
  return error instanceof BuildRejected ? error : null;
}

/**
 * 失敗した試行から、次の試行へ渡す材料を組み立てる。
 *
 * @param failedAttempt 何回目の試行が失敗したか（1 始まり）
 * @param rejected ビルドの拒否
 * @param generated その試行の生成結果
 * @returns 次の試行へ渡す材料
 */
export function buildRetryContext(
  failedAttempt: number,
  rejected: BuildRejected,
  generated: GenerationResult,
): BuildRetryContext {
  return {
    failedAttempt,
    stage: rejected.stage,
    diagnostics: rejected.diagnostics,
    previousSource: generated.source,
  };
}

/**
 * 再投入するプロンプトを組み立てる（5.2-7 の「エラー出力を LLM に返して」）。
 *
 * **利用者のプロンプトを消さない。** 何を作るのかは初回と同じで、変わるのは
 * 「前回はこう書いて、こう落ちた」が付くことだけである。差し替えてしまうと、
 * 直っても別のゲームができる。
 *
 * **システムプロンプト（6.1）は触らない。** 4.5 のキャッシュブレークポイントは
 * `system` の末尾にあり、変えるのは `messages` 側だけなので、**リトライでも
 * プレフィックスのキャッシュはそのまま効く。**
 *
 * **診断が空なら、その節ごと落とす。** 空の見出しを置くと「診断はここにある」と
 * 読める形で何も無い状態になる。空でも再生成する価値はある（4.2 の実測では
 * 1 試行あたりの成功率そのものが高く、引き直しに意味がある）ので、材料が減った
 * ことだけを正直に伝える。
 *
 * @param prompt 利用者が入力した自然文プロンプト（初回と同じもの）
 * @param context 直前の試行が何で落ちたか
 * @returns 次の試行へ送るプロンプト
 */
export function composeRetryPrompt(prompt: string, context: BuildRetryContext): string {
  const source = truncateBytes(context.previousSource, MAX_SOURCE_BYTES);
  const diagnostics = truncateBytes(context.diagnostics, MAX_RETRY_DIAGNOSTICS_BYTES);

  const parts = [
    prompt,
    '',
    `前回の出力はコンパイルできませんでした（${context.failedAttempt} 回目の試行 / 失敗した段: ${context.stage}）。`,
    '同じ要求に対して、コンパイルの通る Go プログラムを最初から出力し直してください。',
    '出力の決まり（コードフェンスを付けない、1 行目は package main、ファイルは 1 つ）は前回と同じです。',
    '',
    '--- 前回の出力 ---',
    source,
  ];

  if (diagnostics.trim() !== '') {
    parts.push('', '--- コンパイラの出力 ---', diagnostics);
  }

  return parts.join('\n');
}

/**
 * 生成の段（3.3-3）を、リトライの材料を受け取れる形へ包む。
 *
 * **既存の生成の段を変えずに済ませるための継ぎ目である。** `src/bedrock.ts` の
 * `createBedrockGenerateSource` は「プロンプトを 1 つ受けて生成する」形をしており、
 * リトライは**そのプロンプトを組み替えるだけ**で成立する。包む側に置けば、
 * トランスポート（Bedrock の呼び出し方）は診断の存在を知らずに済む。
 *
 * **台帳へは組み替える前のプロンプトが残る**（`recordCost` はループ側が元の
 * リクエストで呼ぶ）。組み替えた側を渡すと、`generations.prompt`（5.1）に
 * **生成物由来の文字列と Go の診断が入る。** 8.3 の検査を通っていない文字列を
 * D1 の列へ持ち込まないため、置き換えはこの関数の中だけで閉じる。
 *
 * @param generate 包む生成の段
 * @returns リトライの材料を受け取れる生成の段
 */
export function withBuildDiagnostics(
  generate: (
    env: Env,
    request: { readonly prompt: string },
  ) => Promise<GenerationResult>,
): (
  env: Env,
  request: { readonly prompt: string },
  retry?: BuildRetryContext,
) => Promise<GenerationResult> {
  return async (env, request, retry) => {
    if (retry === undefined) {
      return await generate(env, request);
    }
    // **`request` を広げて `prompt` だけ差し替える**（レビュー指摘 / #20）。
    // 新しく作ると、あとで `GenerateRequest` へ項目が増えたときに
    // **リトライ経路だけが黙ってそれを落とす。** 初回と 2 回目以降で渡すものが
    // 変わる形そのものが罠なので、構造として消す。
    return await generate(env, { ...request, prompt: composeRetryPrompt(request.prompt, retry) });
  };
}

/**
 * リトライの上限まで試してもビルドが通らなかった（5.2-7）。
 *
 * **診断を持たない。** 例外は経路層まで上がってログにも応答にも触れるが、Go の
 * 診断は生成コードの行を引用する（`BuildRejected` が `message` へ入れないのと同じ
 * 理由）。ここが持つのは**回数と、最後に止まった段**だけである。
 */
export class BuildRetriesExhausted extends Error {
  /**
   * @param attempts 実際に行った試行の回数（＝ 課金の発生した LLM 呼び出しの回数）
   * @param lastStage 最後の試行で関数が止まった段
   */
  constructor(
    readonly attempts: number,
    readonly lastStage: string,
  ) {
    super(`ビルドに ${attempts} 回失敗しました（最後に止まった段: ${lastStage}）`);
    this.name = 'BuildRetriesExhausted';
  }
}

/**
 * 経路層が {@link BuildRetriesExhausted} を写す HTTP ステータス。
 *
 * **422 とする。** `src/source-inspection.ts` の `SOURCE_REJECTED_STATUS` と同じ理由で、
 * リクエストは検証を通っており（400 ではない）、段はすべて設計どおりに働いており
 * （500 ではない）、枠は消費済みである（429 ではない）。**生成物が受け付けられなかった**
 * という結果そのものが応答である。
 */
export const BUILD_FAILED_STATUS = 422;

/** 応答の `error` の値。 */
export const BUILD_FAILED_ERROR = 'build-failed';

/**
 * 上限に達したことを、応答本文にもログにも出してよい形へ落とす。
 *
 * **文言は固定である。** 生成物由来の文字列（診断・ソース・段の名前）を一切混ぜない。
 * 混ぜてよいのは**こちらが数えた回数**だけで、これは 8.3 の検査を要しない。
 *
 * **消費した枠の回数を書く。** 1 リクエストが枠を 1 回分しか使わないと読める文言に
 * すると、3 回失敗した利用者から見て残枠の表示（4.4 / #24）が 3 減る理由が消える。
 *
 * @param exhausted 上限到達の例外
 * @returns 応答本文にできるオブジェクト
 */
export function describeBuildFailure(exhausted: BuildRetriesExhausted): {
  readonly error: string;
  readonly attempts: number;
  readonly message: string;
} {
  return {
    error: BUILD_FAILED_ERROR,
    attempts: exhausted.attempts,
    message:
      `生成したコードがコンパイルできませんでした。${exhausted.attempts} 回作り直しましたが通りませんでした。` +
      `この生成で本日の生成枠を ${exhausted.attempts} 回分使いました。` +
      `作りたいものを少し簡単にするか、言い方を変えてもう一度お試しください。`,
  };
}

/**
 * UTF-8 のバイト数で切り詰める。
 *
 * **文字数ではなくバイト数で数える。** 上限の出どころ（6.1 の `MAX_SOURCE_BYTES`、
 * ビルド関数の診断 8 KiB）がどちらもバイトなので、文字数で数えると日本語のコメントを
 * 多く含むソースだけが上限の 3 倍まで通る。
 *
 * **切り詰めたことが読み手に分かるよう、末尾に印を付ける**
 * （`src/source-inspection.ts` の `summarizeImports` と同じ方針。黙って削ると
 * 「これで全部だ」と読まれ、モデルは切れた行を直そうとする）。
 *
 * **注記を含めて `maxBytes` に収まる。** レビュー指摘（#20）で、注記を上限の外側で
 * 足していたため返り値が上限を超えていた。**export しているのはテストのため**で、
 * 上限が実際に守られることは合成後のプロンプト越しでは緩くしか見えない。
 *
 * @param text 元の文字列
 * @param maxBytes 上限（UTF-8 のバイト数。**注記込みの上限**）
 * @returns 上限に収めた文字列
 */
const TRUNCATION_NOTICE = '\n…（以降は長さの上限で省略）';

/**
 * 省略の注記そのもののバイト数。**本文へ割ける分を減らすために先に引く。**
 *
 * レビュー指摘（#20）。注記を上限の外側で足していたため、**返り値が `maxBytes` を
 * 超えていた。** 上限を置いた目的はプロンプトの肥大化を抑えること（入力トークンは
 * そのまま費用である。4.1）なので、**上限を超える経路があると目的を果たさない。**
 */
const TRUNCATION_NOTICE_BYTES = new TextEncoder().encode(TRUNCATION_NOTICE).byteLength;

export function truncateBytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  // **注記の分を先に予約する。** 上限が注記より小さいときは注記自身を切る。
  // **注記を切ってでも上限を守る**のは、この関数の上限が費用の上限だからである
  // （入力トークンはそのまま費用。4.1）。読みやすさより超えないことを優先する。
  const room = maxBytes - TRUNCATION_NOTICE_BYTES;
  if (room <= 0) {
    return cutAtBoundary(new TextEncoder().encode(TRUNCATION_NOTICE), maxBytes);
  }
  return `${cutAtBoundary(encoded, room)}${TRUNCATION_NOTICE}`;
}

/**
 * UTF-8 のバイト列を、文字の途中で切らずに `limit` バイト以内へ収める。
 *
 * **継続バイト（0b10xxxxxx）の途中で切らない。** 切ると復号で U+FFFD が出て、
 * モデルには「そういう文字が書いてある」と見える。
 *
 * @param encoded UTF-8 のバイト列
 * @param limit 上限（バイト）
 * @returns 復号した文字列
 */
function cutAtBoundary(encoded: Uint8Array, limit: number): string {
  let end = Math.min(limit, encoded.byteLength);
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return new TextDecoder().decode(encoded.subarray(0, end));
}
