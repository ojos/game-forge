/**
 * 生成リクエストの入口とオーケストレーションの骨組み（3.3 / 5.2 / #15）。
 *
 * このモジュールが確定させるのは **順序と境界**であって、生成そのものではない。
 * 3.3 は書き込み経路の順序を「クォータ判定 → 生成 → 費用計上 → ビルド → 行の作成」と
 * 定めており、この順序を守ることが 4.3 の費用上限と 7.1 の封じ込めの前提になっている。
 * 各段の中身は別の issue が持つため、ここでは**差し替え可能な継ぎ目（seam）**として
 * 宣言し、未実装の段は 501 で落とす。
 *
 * 順序を先に固定しておく理由は、後から段を足すときに順序を議論し直さないためである。
 * 例えば費用の計上（3.3-4）はビルドより前にあり、これは**生成が成功してもビルドが
 * 失敗しても課金は発生している**という事実に対応する。順序が緩いと、失敗経路で計上を
 * 飛ばす実装が自然に見えてしまい、4.3 の「リトライ分も必ず計上する」が崩れる。
 *
 * **#83 で 3.3-3（生成）が埋まった。** 実装は `src/bedrock.ts`（Bedrock の `Converse`）と
 * `src/generation-models.ts`（モデル選択）にあり、このモジュールは順序と境界だけを持つ
 * 立場を変えていない。**#22 で 3.3-4（費用計上）も埋まった**（`src/cost-ledger.ts`）。
 * **#23 で 3.3-2（クォータ判定）も埋まった**（`src/quota.ts`）。
 * **#21 で 3.3-6（R2 への書き戻し）と 3.3-8（`games` 行の作成）が埋まり、
 * 全段が実装済みになった**（`docker/isolated-build/handler/r2.go` と `src/games.ts`）。
 * `notImplementedPipeline` は**残す**。段を差し替えるときの土台であり、
 * 「空実装を成功にしない」という性質はこの先も要る。
 *
 * **5.2 との差分**: 5.2 は 3.3 に無い「入力の安全性検査（8.1）」をクォータ判定の
 * 手前に置く。これは M6-1 の範囲なので、この骨組みには段を作らず、挿入位置だけを
 * `runGenerationPipeline` のコメントに記す（使われない段を先に作らない）。
 *
 * **#129 で 4.2 のリトライ 1 段目（費用ゼロの機械修正）が入った。** ループの中、
 * ビルドが `kind='build'` で落ちた直後に `repairAndRebuild` がある。**段
 * （`GenerationPipeline`）を増やしていない**のは、これが 3.3 の順序に現れる段では
 * なく、**既にある段（`build`）をもう一度呼ぶだけ**だからである。差し替えたいものは
 * すべて既存の段の中にあり、増やすと「呼ばないと成立しない段」がもう 1 つ生まれる。
 *
 * **#160 で 3.3-2.6（`startJob`）が非同期実装へ差し替わった。** 生成の本体
 * （`runGenerationJob`）は 1 行も変えずに、**そのままオーケストレータ Lambda の中で
 * 走る**（`src/orchestrator/`）。このモジュールが「順序と境界だけを持つ」形にして
 * あったことが、そこで効いている——移したのは実行体であって、順序ではない。
 */
import type { Route, RouteHandler } from './routes.js';
import { json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import type { GenerationResult, SystemPromptResolver } from './generation-models.js';
import { createBedrockGenerateSource } from './bedrock.js';
import { PromptBlocked } from './input-moderation.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  GeneratedSourceRejected,
  SOURCE_REJECTED_STATUS,
  describeSourceRejection,
  inspectGeneratedSource,
} from './source-inspection.js';
import type { BuildOutcome } from './build-client.js';
import { BuildFailure, createLambdaBuild } from './build-client.js';
import { isBuildPathFailure } from './build-health.js';
import type { GenerationErrorCode } from './games.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  failGame,
  hashJobToken,
} from './games.js';
import { workPagePath } from './paths.js';
import { recordGenerationCost } from './cost-ledger.js';
import { QUOTA_EXCEEDED_STATUS, checkGenerationQuota, describeQuotaRejection } from './quota.js';
import type { MonthlyCostWarning } from './quota.js';
import type { BuildRetryContext } from './build-retry.js';
import {
  BUILD_FAILED_STATUS,
  BuildRetriesExhausted,
  MAX_GENERATION_ATTEMPTS,
  buildRetryContext,
  describeBuildFailure,
  retriableBuildFailure,
  withBuildDiagnostics,
} from './build-retry.js';
import type { BuildRejected } from './build-client.js';
import { MAX_MECHANICAL_FIX_PASSES, removeUnusedImports } from './mechanical-fix.js';
import { startJobOnLambda } from './orchestrator/start-job.js';
import {
  TIDY_ATTEMPTS,
  composeTidyPrompt,
  isTidyPass,
  measureSourceBytes,
} from './source-size.js';

/** 生成エンドポイントのパス。 */
export const GENERATE_PATH = '/api/generate';

/**
 * 受け付けるプロンプトの最大文字数。
 *
 * 仕様書に明文がないため、ここで決めて根拠を残す。**費用 DoS の入り口を絞るための
 * 値**であり（7.3）、体験上の制約として置いているのではない。自然文でゲームを説明する
 * には 2,000 文字あれば足りる一方、入力トークンは 4.2 が「支配項は出力トークン」と
 * するとおり単価が低く、この長さなら 1 生成あたりの費用に実質的な影響を与えない。
 *
 * M0-4 が 1 生成あたりのコストを実測したら、その結果で見直してよい。**コードの
 * 1 か所にあるので、見直しは定数の変更で済む。**
 */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * 受け付けるリクエスト本文の最大バイト数。
 *
 * プロンプトの上限（2,000 文字）を UTF-8 の最大 4 バイト/文字で見積もっても 8 KiB で、
 * JSON の空白と他の項目を含めて 16 KiB あれば余る。**文字数の検査より手前に置く**
 * ため、本文を読み切る前に打ち切れる。
 */
const MAX_BODY_BYTES = 16 * 1024;

/** 受け付ける `Content-Type`。この経路は fetch から叩かれる API であり、画面ではない。 */
const JSON_MEDIA_TYPE = 'application/json';

/** リクエストを受け付けられなかった理由。 */
export type GenerateRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'malformed-json'
  | 'missing-prompt'
  | 'prompt-too-long'
  | 'unknown-field';

/** 検証を通ったリクエスト。 */
export interface GenerateRequest {
  /** 利用者が入力した自然文プロンプト。前後の空白は落としてある。 */
  readonly prompt: string;
  /**
   * 元にするソース（推敲は 5.7、フォークは 5.3）。**新規生成では持たない。**
   *
   * **`prompt` と分けて持つ。** 連結して 1 本の文字列にすると、(a) 4.5 のキャッシュ
   * 区切りをソースの直後へ置けなくなり、(b) 費用台帳へ残すのが「利用者のプロンプト」
   * ではなく組み替えた側になる（5.2-7 の #20 注記が禁じている形）。**台帳は
   * `prompt` だけを見ればよい**という性質を、この分割が守っている。
   */
  readonly baseSource?: string;
}

/** リクエスト本文の解析結果。 */
export type GenerateParseResult =
  | { readonly ok: true; readonly request: GenerateRequest }
  | { readonly ok: false; readonly reason: GenerateRejection };

/**
 * 日次クォータと月次上限の判定結果（3.3-2 / 4.3）。
 *
 * **警告は「許可」に付く。** 4.3 は「80% で警告、100% で生成停止」と定めており、
 * 警告が立っている間はまだ生成できる。拒否と警告を同じ 1 つの値にすると、経路層が
 * 「拒否だが通してよい」を判断する場所になる（`src/quota.ts`）。
 *
 * **`warning` を任意にしている。** 判定の実装（#23）は月次が 80% 未満なら付けない。
 * 表示するのは 4.4 / #24（M3-3）の範囲で、この型はそこへ値を渡す口だけを持つ。
 */
export type QuotaDecision =
  | { readonly allowed: true; readonly warning?: MonthlyCostWarning }
  | {
      readonly allowed: false;
      readonly reason: string;
      /**
       * 枠が戻る時刻（UNIX 秒）。**日次で止まったときだけ意味を持つ**（4.4 / #132）。
       *
       * 4.4 は日次の枠切れに「翌日の再開時刻」を求める。段（`src/quota.ts`）は
       * 判定の中で境界を計算しているので、**経路層が同じ境界をもう一度計算しない**
       * ように、判定結果に乗せて受け取る（shared-ai-rules 12 章）。
       *
       * **任意にしてある。** 段は差し替えられるので、時刻を持たない実装もある。
       * 無ければ応答へ載せない（`describeQuotaRejection`）。
       */
      readonly resetsAt?: number;
    };

/** 生成の各段。**未実装の段は例外を投げる**（黙って成功しない）。 */
export interface GenerationPipeline {
  /**
   * 3.3-2: 日次クォータと月次上限を判定する（#23 が `src/quota.ts` で実装した）。
   *
   * **この段だけが「LLM を呼ぶ前に止める」ことができる。** 4.3 の層 2 / 層 3 は
   * どちらも遅れを持つ検知なので、ここを通したものは必ず課金され得る。
   */
  readonly checkQuota: (env: Env, userId: string) => Promise<QuotaDecision>;
  /**
   * 3.3-3: Go ソースを生成し、`usage` を得る（#83 が Bedrock で実装した）。
   *
   * **戻り値の型が「どのモデルで生成したか」を必須にしている**（`GenerationResult`）。
   * #22 の費用台帳がモデル別単価で円換算するため、後段が推測で埋められない。型で
   * 要求しておけば、モデルを落とした実装はコンパイルが通らない。
   *
   * **`retry` は 2 回目以降の試行にだけ入る**（5.2-7 / #20）。直前の試行のソースと
   * Go の診断を持ち、生成の段はそれを入力へ織り込む。**任意にしてあるので、
   * リトライを知らない実装（`(env, request) => …`）もそのまま代入できる。**
   * ただしその実装は診断を捨てるため、既定の経路は `withBuildDiagnostics` で
   * 包んである（`src/build-retry.ts`）。
   */
  readonly generateSource: (
    env: Env,
    request: GenerateRequest,
    retry?: BuildRetryContext,
  ) => Promise<GenerationResult>;
  /**
   * 3.3-4: 費用を台帳へ加算する。**成功・失敗・リトライを問わず全件**（M3-1）。
   *
   * **リクエストを受け取る。** 5.1 の `generations` 行は `prompt` を必須にしており、
   * 生成結果（`GenerationResult`）からは復元できない。ここで渡さないと、台帳側が
   * 空文字で埋めるか、経路のどこかにプロンプトを持ち回る別の口を作ることになる。
   */
  readonly recordCost: (
    env: Env,
    userId: string,
    request: GenerateRequest,
    generated: GenerationResult,
  ) => Promise<void>;
  /** 5.2-5: AST でパッケージのホワイトリストを検査する（M2-3）。 */
  readonly inspectSource: (generated: GenerationResult) => void;
  /**
   * 3.3-5..7: Lambda でビルドし、そのまま R2 へ書き戻す（確定24 / M2-5 / M2-7）。
   *
   * **戻り値を `unknown` にしていない。** 骨組みの段階では次の段の持ち物が決まって
   * いなかったが、**#21 で両端が埋まった**。3.3-8 が要るのは R2 のキーと Go の版で、
   * どちらも `BuildOutcome` が**キャッシュヒットの有無に関わらず**持つ。型で結んで
   * おけば、キーを返さない実装はコンパイルが通らない。
   */
  readonly build: (env: Env, generated: GenerationResult) => Promise<BuildOutcome>;
  /**
   * 3.3-8: 先に作ってあった `games` 行を完成させる（M2-7 / #150）。
   *
   * **#150 で「行を作る」から「行を完成させる」へ変わった。** 行はクォータ判定の
   * 直後に `createPendingGame` が作っており、この段が入れるのは成果物の側
   * （`go_version` / `source_key` / `wasm_key` / `preview_key`）である。
   *
   * **リクエストを受け取らない。** 仮のタイトルは行を作る時点で決まっているので、
   * ここまでプロンプトを持ち回る理由が無くなった。
   */
  readonly completeGame: (env: Env, gameId: string, built: BuildOutcome) => Promise<boolean>;
  /**
   * 3.3-2.6: ジョブを起動する（#150）。**A 案の差し替え点である。**
   *
   * **この段だけが「応答を返す前に待つかどうか」を決める。** 既定は #160 で
   * {@link startJobOnLambda}（オーケストレータ Lambda へ非同期呼び出しを 1 回投げて
   * 即座に戻る）へ差し替わった。**同期実装（{@link runJobInline}）は残してある**
   * ——順序だけを見るテストが借りており、非同期版と対になる名前として、どちらが
   * 結線されているかを `src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS` と
   * 照合できる形が要る。
   *
   * **段を 1 つ増やしたのは、増やさないと差し替えられないからである。**
   * `src/generate.ts` は「順序と境界だけを持つ」立場を保ってきたが、ここは
   * まさに境界（Worker の中か外か）であり、既存のどの段の中にも無い。
   *
   * **失敗したら投げる。** 同期実装では、投げた例外がそのまま経路層の分岐へ届き、
   * #150 以前と同じ応答になる。非同期実装では「投げ込めなかった」ことだけを投げる
   * （生成そのものの失敗は `games` 行へ記録され、応答には現れない）。
   */
  readonly startJob: (env: Env, job: GenerationJob, pipeline: GenerationPipeline) => Promise<void>;
  /**
   * 8.3: 失敗した作品行を閉じる（#160）。**任意である。**
   *
   * **段にしたのは、オーケストレータが D1 を持たないからである**（#160 / A 案）。
   * あちらの `failGame` は `finish` コールバックで、`src/games.ts` の実装をそのまま
   * 呼べない。ここが段になっていないと、`runGenerationJob` の catch だけが
   * Lambda から D1 のバインディングを要求することになる。
   *
   * **任意にしてあるのは、既定が正しいからである。** 省いた実装は
   * {@link failGame}（D1 へ直接）で動く。必須にすると、順序だけを見ている既存の
   * テストが**この段の実装を書かされる**——見たいものと関係のない写しが増える
   * （`generateSource` の `retry` を任意にしているのと同じ判断）。
   *
   * **戻り値は捨ててよい。** false は「その行はもう `pending` / `running` では
   * ない」という意味で、**先に確定した状態を上書きしないのが正しい**
   * （`src/games.ts`）。
   *
   * # 4 つ目の引数は 3.8 の degrade の信号である（#140）
   *
   * **`errorCode` では代われない。** `internal` の定義は「設定不足・関数障害・想定外の
   * 例外」で、**D1 の不調もビルド関数の障害も同じ 1 語に落ちる**（`src/games.ts` の
   * `GENERATION_ERROR_CODES`）。#140 の acceptance は「D1 の不調では出ない」ことを
   * 区別して確かめよと定めており、**区別できる語彙が無い以上、別の口が要る。**
   * 分類そのものは `src/build-health.ts` の `isBuildPathFailure` が 1 か所で持つ。
   *
   * **任意にしてあるのは、既定の実装（`src/games.ts` の `failGame`）が 3 引数だから
   * である。** あちらは読まない——読ませるには `games` へ書く列を増やすことになるが、
   * 信号は作品の属性ではない（`migrations/0010_build_health.sql`）。**同期実装
   * （{@link runJobInline}）へ結線を戻すときは、この信号を書く経路も一緒に戻すこと。**
   * 戻っていないことは `test/generate.test.ts` が `startJob` の結線で見る。
   */
  readonly failGame?: (
    env: Env,
    gameId: string,
    errorCode: GenerationErrorCode,
    /** ビルド依頼そのものが失敗したか（3.8 の degrade の発火信号。#140）。 */
    buildPathFailed?: boolean,
  ) => Promise<boolean>;
}

/**
 * 1 回の生成ジョブを指すもの（#150）。
 *
 * **オーケストレータ Lambda へ渡すペイロードでもある。** 非同期呼び出しの上限は
 * 256 KB で、`prompt` は最大 2,000 文字なので余裕がある。
 *
 * **`jobToken` は平文である。** D1 にはハッシュしか無い（`src/games.ts`）。
 * この値が存在するのは、この構造体と呼び出しのペイロードの中だけである。
 */
export interface GenerationJob {
  /** 作品 id。作品ページ（`/works/<id>`）の URL に入る。 */
  readonly gameId: string;
  /** このジョブだけを完成・失敗させられる使い捨てのトークン（平文）。 */
  readonly jobToken: string;
  /** 生成する利用者。 */
  readonly userId: string;
  /** 検証済みのリクエスト。 */
  readonly request: GenerateRequest;
}

/**
 * 未実装の段であることを表す例外。
 *
 * 経路層はこれを 501 へ写す。段ごとに名前を持たせるのは、骨組みだけを動かしたときに
 * **どこまで進んだか**が応答から読めるようにするため。
 */
export class PipelineStepNotImplemented extends Error {
  constructor(readonly step: string) {
    super(`生成パイプラインの段が未実装です: ${step}`);
    this.name = 'PipelineStepNotImplemented';
  }
}

/**
 * 既定のパイプライン。**すべての段が未実装**で、順序だけが決まっている。
 *
 * 空の実装を「成功」にしない。成功にすると、段を実装し忘れたまま経路が 200 を返し、
 * 生成できていないのに `games` 行が作られたように見える経路ができる。
 */
export const notImplementedPipeline: GenerationPipeline = {
  checkQuota: () => {
    throw new PipelineStepNotImplemented('checkQuota');
  },
  generateSource: () => {
    throw new PipelineStepNotImplemented('generateSource');
  },
  recordCost: () => {
    throw new PipelineStepNotImplemented('recordCost');
  },
  inspectSource: () => {
    throw new PipelineStepNotImplemented('inspectSource');
  },
  build: () => {
    throw new PipelineStepNotImplemented('build');
  },
  completeGame: () => {
    throw new PipelineStepNotImplemented('completeGame');
  },
  startJob: () => {
    throw new PipelineStepNotImplemented('startJob');
  },
};

/**
 * システムプロンプトが未実装であることを表す解決関数（#16）。
 *
 * **本 issue はプロンプト本文を持たない。** トランスポート（#83）とプロンプト本文（#16）
 * の分担がそこで切れている。空の文字列を返して「成功」にしないのは、
 * `notImplementedPipeline` が空実装を成功にしないのと同じ理由で、**制約の書かれていない
 * プロンプトで生成すると、課金だけが発生してコンパイルできないソースが返る**ためである。
 *
 * #16 はこの関数を差し替えるだけでよい。モデルを引数に取るのは、6.1 が
 * 「システムプロンプトはモデルごとに持つ（確定5）」と定めるためである。
 */
export const notImplementedSystemPrompt: SystemPromptResolver = (model) => {
  throw new PipelineStepNotImplemented(`systemPrompt:${model.key}`);
};

/**
 * 既定のパイプライン。**3.3 の全段が実装済み**である（クォータ判定 3.3-2 / 生成 3.3-3 /
 * 費用計上 3.3-4 / 検査 5.2-5 / ビルドと R2 への書き戻し 3.3-5..7 / `games` 行 3.3-8）。
 *
 * `notImplementedPipeline` を土台に、実装済みの段だけを差し替える。
 * **順序は変えない。** 3.3 は「クォータ判定 → 生成 → 費用計上 → ビルド → 行の作成」である。
 *
 * **#23 で 3.3-2（クォータ判定）が埋まった。** これで **費用を止める段が、費用の出る段より
 * 先に開いた状態**になる。逆順で開けないのは設計であって手順ではない: クォータ判定が
 * 未実装のまま生成だけを結線すると、4.3 の上限が 1 つも効かないまま Bedrock を呼べる
 * 経路ができる。**判定を外すとその状態へ戻る**ため、結線されていること自体を
 * `test/quota.test.ts` が同一性で確かめる。
 *
 * **費用計上（3.3-4）を先に開けても費用は出ない。** この段は D1 へ書くだけで、
 * Bedrock を呼ぶのはその手前の 3.3-3 である。順序が「クォータ判定 → 生成 → 費用計上」
 * である以上、**台帳だけが先に動くことはない。**
 *
 * **ビルドは `createLambdaBuild()` で作る。** 呼び出しに必要な資格情報が環境に無い場合、
 * この段は `BuildNotConfigured`（`kind='config'`）で落ちる。**#115 が IAM の principal を
 * 宣言するまでは、その状態が正常である。**
 *
 * **`createGame`（3.3-8）を結線したことで、経路全体が 202 を返せるようになった。**
 * この段だけを外すと、成果物は R2 に入り費用も計上されたのに作品が残らない状態に
 * なる（3.3 の最後の段は「起きたことを記録する」段である）。結線されていること自体を
 * `test/games.test.ts` が同一性で確かめる（`test/quota.test.ts` と同じ形）。
 */
/**
 * 生成の段（3.3-3）を、整理パスの指示を織り込める形へ包む（確定18 / 5.3 / #33）。
 *
 * **`withBuildDiagnostics`（`src/build-retry.ts`）と同じ形の継ぎ目である。**
 * トランスポート（`src/bedrock.ts`）は整理の存在を知らないままでよく、包む側が
 * プロンプトを組み替える。**両方を掛けるときは、こちらを内側に置く**——整理の指示は
 * 常に最後（transport の直前）に載るほうが、リトライの有無で文面が変わらない。
 *
 * **台帳へは組み替える前のプロンプトが残る**（`recordCost` はループ側が元のリクエストで
 * 呼ぶ）。組み替えた側を渡すと `generations.prompt`（5.1）に整理の指示文が入り、
 * **利用者が書いていない文字列が利用者の入力として残る。**
 *
 * @param generate 包む生成の段
 * @returns 整理パスの指示を織り込む生成の段
 */
export function withTidyInstruction(
  generate: (
    env: Env,
    request: { readonly prompt: string; readonly baseSource?: string },
  ) => Promise<GenerationResult>,
): (
  env: Env,
  request: { readonly prompt: string; readonly baseSource?: string },
) => Promise<GenerationResult> {
  return async (env, request) => {
    if (!isTidyPass(request)) {
      return await generate(env, request);
    }
    // **`request` を広げて `prompt` だけ差し替える**（`withBuildDiagnostics` と同じ）。
    // 新しく作ると、`GenerateRequest` へ項目が増えた日に整理パスだけが黙って落とす。
    return await generate(env, {
      ...request,
      prompt: composeTidyPrompt(request.prompt, measureSourceBytes(request.baseSource ?? '')),
    });
  };
}

export const defaultPipeline: GenerationPipeline = {
  ...notImplementedPipeline,
  checkQuota: checkGenerationQuota,
  // **リトライの材料を織り込む層で包む**（5.2-7 / #20）。トランスポート
  // （`src/bedrock.ts`）は診断の存在を知らないままでよく、包む側がプロンプトを
  // 組み替える。**包まないと、リトライは診断を捨てた引き直しになる。**
  generateSource: withBuildDiagnostics(
    withTidyInstruction(createBedrockGenerateSource({ systemPrompt: buildSystemPrompt })),
  ),
  recordCost: recordGenerationCost,
  inspectSource: inspectGeneratedSource,
  build: createLambdaBuild(),
  completeGame,
  failGame,
  // **既定は非同期呼び出しである**（#160）。応答は `games` 行を作った直後に返り、
  // 生成の 90.9 秒はオーケストレータ Lambda の中で走る。**これで #150 の
  // 「タブを閉じてよい」が本当になった。**
  //
  // **同期実装（`runJobInline`）は消していない。** 順序だけを見るテストが借りており、
  // 対になる名前があることで「いまどちらが結線されているか」を機械照合できる
  // （`test/work-page.test.ts` が `GENERATION_IS_SYNCHRONOUS` と突き合わせる）。
  //
  // **戻すときは 1 行で戻せる**が、戻すとエッジに Bedrock の資格情報が要る。
  // #160 でそれはシークレットから削除したので、**戻すのは宣言と手順の話になる**
  // （`docs/orchestrator.md`）。
  startJob: startJobOnLambda,
};

/**
 * リクエスト本文を解析して検証する。
 *
 * **この関数は例外を投げない。** 壊れた JSON、`Content-Type` 違い、巨大な本文は
 * すべて理由付きの失敗として返す（`src/waitlist.ts` と同じ方針）。
 *
 * 未知の項目を拒否するのは、`prompt` の綴り違いが「空のプロンプトで生成した」形で
 * 通るのを防ぐため。生成は課金を伴うので、曖昧な入力を推測で受け取らない。
 *
 * @param request 受信したリクエスト
 * @returns 解析結果
 */
export async function parseGenerateRequest(request: Request): Promise<GenerateParseResult> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, reason: body.reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed-json' };
  }

  const fields = parsed as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key !== 'prompt') {
      return { ok: false, reason: 'unknown-field' };
    }
  }

  const prompt = fields['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, reason: 'missing-prompt' };
  }
  // 文字数で数える。バイト数で数えると、同じ内容でも日本語のプロンプトだけが
  // 短く切られる（UTF-8 で 3 バイト/文字）。
  const trimmed = prompt.trim();
  if ([...trimmed].length > MAX_PROMPT_LENGTH) {
    return { ok: false, reason: 'prompt-too-long' };
  }

  return { ok: true, request: { prompt: trimmed } };
}

/**
 * 3.3-2 → 3.3-2.6: 生成を受け付け、**作品の身元を確定させて返す**（#150）。
 *
 * **この関数が返った時点で、恒久的な URL が存在する。** 送信した瞬間に URL が
 * 手に入れば、タブを閉じてよくなり「復帰」という概念自体が要らなくなる、という
 * のが #150 の狙いである。
 *
 * 順序は 3.3 のままである。
 *
 *   1. **3.3-2 クォータ判定**（4.3 の「上限の判定は 3.3-2 の 1 か所で行う」）
 *   2. **3.3-2.5 作品行の作成**（`pending`。id とジョブトークンがここで決まる）
 *   3. **3.3-2.6 ジョブの起動**（差し替え可能な段）
 *
 * **行を先に作ることは「クォータ判定より前に書く」ことではない。** 判定は依然として
 * 最初にあり、超過した要求は行を 1 つも作らない。**枠の数え方も変わらない**
 * ——日次枠は `generations` の行数で数える（確定25）。
 *
 * M6-1（入力側モデレーション）は 5.2 が定める位置、すなわち `checkQuota` の**手前**へ
 * 入れる。生成前に弾くことに意味があるので、費用の発生する段より後ろへ置かないこと。
 *
 * @param env バインディングと環境変数
 * @param userId 生成する利用者
 * @param request 検証済みのリクエスト
 * @param pipeline 差し替え可能な各段
 * @returns 作成した作品の id
 */
export async function startGeneration(
  env: Env,
  userId: string,
  request: GenerateRequest,
  pipeline: GenerationPipeline,
): Promise<{ readonly id: string }> {
  // 3.3-2: 超過なら即座に拒否する。生成より先に判定することが 4.3 の前提。
  // **行を作る前でもある**ので、断られた要求は D1 に何も残さない。
  const quota = await pipeline.checkQuota(env, userId);
  if (!quota.allowed) {
    throw new QuotaExceeded(quota.reason, quota.resetsAt);
  }

  // 3.3-2.5: ここで id と URL が決まる。**LLM はまだ 1 回も呼んでいない。**
  const pending = await createPendingGame(env, userId, request);
  const job: GenerationJob = {
    gameId: pending.id,
    jobToken: pending.jobToken,
    userId,
    request,
  };

  // 3.3-2.6: ジョブの起動。既定は同期実行なので、ここで生成の全段が走る。
  try {
    await pipeline.startJob(env, job, pipeline);
  } catch (error) {
    // **行を放置しない。** 同期実装では `runGenerationJob` が既に分類名を書いている
    // ので、この呼び出しは何も更新しない（`failGame` は `pending` / `running` からしか
    // 遷移しない）。**上書きされないことが、ここで安全に呼べる理由である。**
    // 非同期実装では「投げ込めなかった」ときにここだけが行を閉じる。
    await failGame(env, pending.id, 'internal');
    throw error;
  }

  return { id: pending.id };
}

/**
 * ジョブを Worker の中で同期に走らせる（{@link GenerationPipeline.startJob} の既定）。
 *
 * **#150 の時点ではこれが既定である。** 応答は生成が終わってから返るので、
 * **本番の待ち時間も応答も現状のまま**である。#150 がこの PR で変えたのは
 * 「作品行と URL が最初から存在する」ことだけで、待ち時間を消すのは
 * オーケストレータ Lambda（別 issue）の仕事になる。
 *
 * **`claim` をここで行う。** 非同期実装では Lambda がコールバックで同じことをする
 * （`src/generate-callback.ts` の `claim`）。**どちらの経路でも状態遷移が同じ**に
 * なるよう、起動する側が握る、という形に揃えてある。
 *
 * @param env バインディングと環境変数
 * @param job 起動するジョブ
 * @param pipeline 差し替え可能な各段
 */
export async function runJobInline(
  env: Env,
  job: GenerationJob,
  pipeline: GenerationPipeline,
): Promise<void> {
  const claimed = await claimGenerationJob(env, job.gameId, await hashJobToken(job.jobToken));
  if (!claimed) {
    // 同期実行では起こらない（作った直後に握るため）。**それでも黙って先へ進まない。**
    // ここを素通りさせる実装にすると、非同期へ差し替えたときに二重実行の関門が
    // 「あるように見えて効いていない」状態になる。
    throw new GenerationJobNotClaimable(job.gameId);
  }
  await runGenerationJob(env, job, pipeline);
}

/**
 * 3.3-3..8 を、5.2-7 のリトライの単位で回す。
 *
 * 段の中身は持たない。**ここが持つのは順序と、段の間で何が渡るかだけ**である。
 *
 * **この関数がオーケストレータ Lambda へそのまま移る部分である**（#150 / A 案）。
 * 移す先を Node.js にすると決めたのは、5.2-5 の import ホワイトリスト
 * （`src/go-imports.ts`）を書き写さずに済むためで、あれは #17 が仕様書と機械照合して
 * いるセキュリティ層である。**複製を作らない。**
 *
 * # 結果は必ず `games` 行へ書く
 *
 * 成功なら `completeGame`、失敗なら `failGame`。**例外はそのあとで投げ直す。**
 * 同期実装ではその例外が経路層の分岐へ届き、#150 以前と同じ応答になる。
 * 非同期実装では呼び出し元（Lambda）がログへ落とすだけでよい——利用者が結果を
 * 受け取る経路は、応答ではなく**作品ページ**になっているためである。
 *
 * @param env バインディングと環境変数
 * @param job 走らせるジョブ（`claim` 済みであること）
 * @param pipeline 差し替え可能な各段
 */
export async function runGenerationJob(
  env: Env,
  job: GenerationJob,
  pipeline: GenerationPipeline,
): Promise<void> {
  try {
    // 3.3-3..8 を、5.2-7 のリトライの単位で回す。**回るのは生成からビルドまでで、
    // クォータ判定は外側にある**（4.3 の「上限の判定は 3.3-2 の 1 か所で行う」）。
    // 枠の消費は台帳の行数で数えるため（確定25）、**試行の回数がそのまま枠の消費**
    // である（#284 以降は最大 2 試行＝枠 2 回分）。
    //
    // **ループの上限は for の条件が持つ。** 打ち切りの判定を catch の中だけに置くと、
    // その 1 行を落としたときに**課金の出る無限ループ**になる。抜けた先で必ず
    // `BuildRetriesExhausted` を投げるので、上限を消せばテストが落ちる。
    //
    // **整理パスだけは 1 回で打ち切る**（確定18 の条件 3・4。`src/source-size.ts` の
    // `TIDY_ATTEMPTS`）。条件 4 は「整理パスがコンパイルに失敗しても自動リトライしない。
    // 元のソースへ戻して拒否する」で、理由欄は「リトライが乗ると枠を余分に消費する。
    // 失敗の連鎖を切る」である。**整理パスは通常の生成より入力も出力も大きく、
    // 1 回あたりの見積もりが 26〜41 円**（30KB 時代の見積もりであって実測ではない。
    // **上限が 64KB になった分そのぶん上がる。** 5.3 の #33 注記）なので、
    // `MAX_GENERATION_ATTEMPTS` 回に回すと 1 度の操作でその倍を失う。
    //
    // **「元のソースへ戻す」は、この経路では構造として満たされている。** 整理パスは
    // フォークからしか始まらず（`src/fork.ts`）、フォークは親を 1 バイトも書き換えない。
    // 失敗した子の行は下の catch が `failed` にするので、**半分だけ整理された成果物が
    // どこにも残らない。**
    const attempts = isTidyPass(job.request) ? TIDY_ATTEMPTS : MAX_GENERATION_ATTEMPTS;
    let retry: BuildRetryContext | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // 3.3-3: 生成。2 回目以降は直前の診断を添える（5.2-7）。
      const generated = await pipeline.generateSource(env, job.request, retry);

      // 3.3-4: 費用の計上。**生成が返った直後に、成否によらず行う。** ここより後ろの段が
      // 失敗しても課金は済んでいるため、後ろへ動かすと計上漏れになる。
      //
      // **ループの中にある。** 4.3 は「リトライ分も必ず計上する」と定めており、
      // 1 回の呼び出しにつき 1 行である（#22 の記録規約）。**渡すのは元のリクエスト**で、
      // 組み替えたプロンプトではない（`generations.prompt` は利用者の入力を持つ）。
      await pipeline.recordCost(env, job.userId, job.request, generated);

      // 5.2-5: ホワイトリスト検査。違反は再生成に回さず即拒否する。
      // **この例外はループを素通りして呼び出し元まで上がる**（#20 はビルドの失敗だけを
      // 引き金にする。`src/build-retry.ts`）。
      pipeline.inspectSource(generated);

      // 3.3-5..7: ビルドと R2 への書き戻し。#76 で 8 段へ戻った（v1.9 は 3.3-5..8 だった）。
      let built: BuildOutcome | null = null;
      try {
        built = await pipeline.build(env, generated);
      } catch (error) {
        // リトライしてよい失敗か（`kind === 'build'` だけ）。判断は 1 か所に置く。
        const rejected = retriableBuildFailure(error);
        if (rejected === null) {
          throw error;
        }

        // **4.2 の 1 段目（費用ゼロの機械修正 / #129）。** ここが挿入位置である
        // （ビルドが `kind='build'` で落ちた直後）。**LLM を呼ばず**に未使用 import を
        // 除去して再ビルドし、通ればそのまま先へ進む。**台帳の行は作らない**ので、
        // 日次クォータにも数えない（確定25。数える単位は行数である）。
        const repaired = await repairAndRebuild(env, pipeline, generated, rejected);
        if (repaired.built !== null) {
          built = repaired.built;
        } else {
          // 直らなかった。**2 段目（LLM 再生成）へそのまま回す。** 材料は機械修正の
          // 後のソースと、そのソースに対する診断である（未使用 import を消した分だけ
          // 手掛かりが減っており、残った失敗だけが見える）。
          retry = buildRetryContext(attempt, repaired.rejected, repaired.generated);
        }
      }

      // 3.3-8: `games` 行の完成（#150 で「作成」から「完成」へ変わった）。
      //
      // **この段まで来たとき、成果物は既に R2 に在る**（3.3-6 が書いた、あるいは
      // キャッシュがヒットして既存のオブジェクトを指している）。順序を入れ替えて
      // 先に `preview_key` を書くと、成果物の無い行が配信側から引けてしまう
      // （`src/games.ts` の冒頭）。
      if (built !== null) {
        // **戻り値を捨てない。** 0 行更新は「この行はもう `running` ではない」
        // という意味で、成果物を書けていない。捨てて `return` すると**ジョブが
        // 成功扱いになり、行は `running` のまま残る**——作品ページが永遠に
        // 「生成中」を出し続ける状態そのものである（下の catch のコメント参照）。
        //
        // **例外にして外側の catch へ渡す。** そこで `failGame` が走るので、
        // 利用者には「終わらない生成」ではなく「失敗した生成」として見える。
        // どちらも良くはないが、**回り続ける表示より失敗として読めるほうがよい。**
        //
        // なお行が既に `ready` / `failed` なら `failGame` も 0 行更新になり、
        // **先に確定した状態を上書きしない**（`src/games.ts`）。
        const completed = await pipeline.completeGame(env, job.gameId, built);
        if (!completed) {
          throw new GenerationNotCompletable(job.gameId);
        }
        return;
      }
    }

    // 上限まで試して通らなかった（5.2-7）。**ここへ来る経路はこれだけである**
    // （ビルドが成功すればループの中で返り、リトライ対象でない失敗は再送出される）。
    throw new BuildRetriesExhausted(attempts, retry?.stage ?? 'unknown');
  } catch (error) {
    // **失敗も必ず行へ書く。** 書かないと `running` のまま永久に残り、作品ページが
    // 「生成中」を出し続ける。利用者から見て、失敗したことすら分からない状態になる。
    //
    // **ここは戻り値を捨ててよい**（成功経路とは事情が違う）。false は「その行はもう
    // `pending` / `running` ではない」という意味で、`GenerationNotCompletable` で
    // 来たときは実際にそうなる。**先に確定した状態を上書きしないのが正しい**ので、
    // ここで再び投げると元の例外を握り潰すことにしかならない。
    //
    // **段を経由する**（#160）。オーケストレータ Lambda は D1 を持たず、`finish`
    // コールバックで同じことをする。省いた実装は `failGame`（D1 へ直接）に落ちる。
    //
    // **4 つ目の引数は 3.8 の degrade の信号である**（#140）。分類は 1 か所
    // （`src/build-health.ts`）が持つ。**ここで `instanceof` を並べ直さない。**
    const fail = pipeline.failGame ?? failGame;
    await fail(env, job.gameId, generationErrorCodeOf(error), isBuildPathFailure(error));
    throw error;
  }
}

/**
 * 例外を `games.generation_error` の分類名へ落とす（8.3）。
 *
 * **既定は `internal` である。** 分類できない失敗を、たまたま近い分類へ寄せない。
 * 利用者に出る文言が変わってしまい、しかも誤りに気づく手掛かりが残らない。
 *
 * **export しているのは、オーケストレータが同じ判定を書き写さないためである**
 * （#160 / shared-ai-rules 12 章）。あちらは戻り値とログのために分類名が要るが、
 * 判定そのものは 1 か所でよい（`src/orchestrator/handler.ts`）。
 *
 * @param error catch した値（型は unknown）
 * @returns 分類名
 */
export function generationErrorCodeOf(error: unknown): GenerationErrorCode {
  // **入力側モデレーション（8.2 / #37）を最初に見る。** `ModerationUnavailable` は
  // ここに現れない——呼べなかったことは「設定不足・関数障害」であり、最後の
  // `internal` がそのまま正しい分類である（`src/input-moderation.ts` の表）。
  if (error instanceof PromptBlocked) {
    return 'prompt-blocked';
  }
  if (error instanceof GeneratedSourceRejected) {
    return 'source-rejected';
  }
  if (error instanceof BuildRetriesExhausted) {
    return 'build-failed';
  }
  // **時間切れは `internal` ではない**（#164）。`internal` は「設定不足・関数障害・
  // 想定外の例外」で、どれも直すべき不具合があると読める。時間切れは**容量の問題**
  // であり、運用者が最初に見る場所が変わる（`src/games.ts` の
  // `GENERATION_ERROR_CODES`）。**`kind` で見る**——`instanceof BuildTimedOut` でも
  // 同じだが、種別で分岐する形は `src/build-client.ts` が `kind` を用意した理由
  // そのものである。
  if (error instanceof BuildFailure && error.kind === 'timeout') {
    return 'build-timeout';
  }
  return 'internal';
}

/**
 * 成果物は揃ったのに、作品行を完成させられなかった（#150）。
 *
 * `completeGame` が 0 行更新を返した状態、すなわち**その行がもう `running` では
 * ない**ことを意味する。同じジョブが二重に走って片方が先に終えた、運用で状態を
 * 触った、といった経路が該当する。
 *
 * **成功にしない。** 成功として返すと行は `running` のまま残り、作品ページが
 * 永遠に「生成中」を出し続ける。`src/generate.ts` 冒頭の「空実装を成功にしない」
 * と同じ判断で、**書けていないことを書けたことにしない。**
 */
export class GenerationNotCompletable extends Error {
  constructor(readonly gameId: string) {
    super('作品行を完成させられませんでした（行が running ではありません）');
    this.name = 'GenerationNotCompletable';
  }
}

/**
 * ジョブを握れなかった（#150）。
 *
 * 非同期実行では**正常な結果**である（同じイベントが 2 回配信された。AWS は
 * 「関数がエラーを返さなくても同じイベントを複数回受け取りうる」と明文で書いている）。
 * その場合 Lambda 側は LLM を呼ばずに降りる。
 *
 * **同期実行では起こらない**ので、起きたら不具合である。
 */
export class GenerationJobNotClaimable extends Error {
  constructor(readonly gameId: string) {
    super('ジョブを握れませんでした（既に実行済みか、トークンが一致しません）');
    this.name = 'GenerationJobNotClaimable';
  }
}

/**
 * 機械修正の結果として、ループが次に持つもの。
 *
 * ビルドが通ったなら `built` が入り、通らなかったなら**次の試行へ渡す材料**
 * （ソースと、そのソースに対する診断）が入る。
 */
interface RepairOutcome {
  /** 機械修正の後にビルドが通ったなら成果物。通らなかった・修正できなかったなら null。 */
  readonly built: BuildOutcome | null;
  /** 最後にビルドを試したソース（修正できなければ元のまま）。 */
  readonly generated: GenerationResult;
  /** そのソースが落ちたときの拒否（`built` が非 null なら意味を持たない）。 */
  readonly rejected: BuildRejected;
}

/**
 * 4.2 の 1 段目。**未使用 import を機械的に除去して、ビルドし直す**（#129）。
 *
 * **LLM を呼ばない。費用は増えない。** 増えるのはビルド関数の呼び出しだけで、それも
 * **実際に除去できたときにしか起きない**（診断に未使用 import が無ければ、ここは
 * ビルドを 1 回も呼ばずに戻る）。
 *
 * **台帳へ書かない。** `recordCost` はループ側が LLM 呼び出しごとに 1 回呼ぶ
 * （3.3-4 / 4.3 の記録規約）。ここで呼ぶと、費用の出ていない段が確定25 の枠を食う。
 *
 * **5.2-5 の検査はやり直す。** 除去は import を減らすだけなので新しい違反は生まれない
 * はずだが、3.3 の「検査を通ったソースだけをビルドへ渡す」を分岐で崩さない。
 * 万一ここで落ちれば、それは機械修正の不具合であり、**黙ってビルドへ流すより
 * 経路層まで上げるほうがよい**（`removeUnusedImports` は自分の出力を読み直して
 * 確かめており、壊れた出力は `changed: false` になる）。
 *
 * **繰り返しは {@link MAX_MECHANICAL_FIX_PASSES} 回まで。** `go build` は 10 件で
 * 診断を打ち切るため（実測）、未使用 import が 11 件以上あると 1 回では消し切れない。
 *
 * @param env バインディングと環境変数
 * @param pipeline 差し替え可能な各段
 * @param generated 直前の試行の生成結果
 * @param rejected そのソースが落ちたときの拒否
 * @returns ループが次に持つもの
 */
async function repairAndRebuild(
  env: Env,
  pipeline: GenerationPipeline,
  generated: GenerationResult,
  rejected: BuildRejected,
): Promise<RepairOutcome> {
  let current = generated;
  let currentRejected = rejected;

  for (let pass = 1; pass <= MAX_MECHANICAL_FIX_PASSES; pass += 1) {
    const fix = removeUnusedImports(current.source, currentRejected.diagnostics);
    if (!fix.changed) {
      // 未使用 import が無い、あるいは確実に消せなかった。**触らずに返す。**
      return { built: null, generated: current, rejected: currentRejected };
    }

    // **`current` を広げて `source` だけ差し替える**（`withBuildDiagnostics` と同じ理由）。
    // 作り直すと、`GenerationResult` へ項目が増えたときにこの経路だけが黙って落とす。
    const repaired: GenerationResult = { ...current, source: fix.source };
    pipeline.inspectSource(repaired);

    try {
      return { built: await pipeline.build(env, repaired), generated: repaired, rejected: currentRejected };
    } catch (error) {
      const rejectedAgain = retriableBuildFailure(error);
      if (rejectedAgain === null) {
        // ビルド経路そのものの失敗（設定・タイムアウト・関数障害）。**再生成でも
        // 機械修正でも直らない**ので、ループの外まで上げる（`kind` での判断は
        // `src/build-retry.ts` が 1 か所で持つ）。
        throw error;
      }
      current = repaired;
      currentRejected = rejectedAgain;
    }
  }

  return { built: null, generated: current, rejected: currentRejected };
}

/**
 * クォータ超過（3.3-2 / 4.3）。
 *
 * **`detail` は段が返した理由をそのまま持つ。** 応答へ出るのはここではなく
 * `describeQuotaRejection`（`src/quota.ts`）が固定の分類名へ落とした値である（8.3）。
 */
export class QuotaExceeded extends Error {
  /**
   * @param detail 段が返した拒否の理由（分類名とは限らない）
   * @param resetsAt 枠が戻る時刻（UNIX 秒。日次で止まったときだけ意味を持つ）
   */
  constructor(
    readonly detail: string,
    readonly resetsAt?: number,
  ) {
    super(`生成枠を超えています: ${detail}`);
    this.name = 'QuotaExceeded';
  }
}

/**
 * 生成リクエストを処理する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param pipeline 差し替え可能な各段
 * @returns レスポンス
 */
async function handleGenerate(
  request: Request,
  env: Env,
  pipeline: GenerationPipeline,
): Promise<Response> {
  // **認証を先に見る。** 本文の検証より前に置くのは、未認証の相手に本文を読ませて
  // 解析まで行う理由が無いためで、7.3 の費用 DoS に対する入口の絞りでもある。
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return json({ error: 'unauthorized' }, 401);
  }

  const parsed = await parseGenerateRequest(request);
  if (!parsed.ok) {
    return json({ error: parsed.reason }, 400);
  }

  try {
    const game = await startGeneration(env, session.userId, parsed.request, pipeline);
    // **`url` を足した**（#150）。画面はこれを組み立て直さずに済む……のではなく、
    // **画面は id だけを読んで自分で組み立てる**（`src/generate-page.ts`）。
    // ここが `url` を返すのは、API を直接叩く側（将来の CLI など）が作品ページの
    // 綴りを知らずに済むようにするためである。**画面が応答の文字列を遷移先に
    // 使わない**という 8.3 の方針は変えていない。
    return json({ gameId: game.id, url: workPagePath(game.id) }, 202);
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      // 4.4 は停止時も「プレイと拡散は継続する」とする。止まるのは生成だけなので、
      // 認証の失敗（401）とは別の応答にする。
      //
      // **日次と月次を区別して返す**（#132）。4.4 は両者に**別々のメッセージ**を
      // 求めており（日次は翌日の再開時刻、月次はプレイと共有の継続）、**混ぜると
      // 片方が必ず誤りになる。** 応答に載るのは固定の分類名と時刻だけで、段が返した
      // 文字列をそのまま流さない（8.3）。**その線引きは `src/quota.ts` が持つ**
      // （分類名を定義している側が、応答に出してよい値も決める）。
      return json(
        describeQuotaRejection(error.detail, error.resetsAt),
        QUOTA_EXCEEDED_STATUS,
      );
    }
    if (error instanceof GeneratedSourceRejected) {
      // 5.2-5 の「違反時は再生成に回さず即拒否」。**500 にしない**（段は正常に働いた）。
      // **429 でもない**（枠は消費済み）。**400 でもない**（リクエストは検証を通っている）。
      // 拒否の理由と、引っかかったもの（import パス / 指示の名前 / 8.3 の語の分類）は
      // `describeSourceRejection` が整える。
      // **ここで文字列を組み立てない**（生成物由来の値の扱いは適合層が知っている）。
      console.error(`[generate] ${error.name}: ${error.reason}`);
      return json(describeSourceRejection(error), SOURCE_REJECTED_STATUS);
    }
    if (error instanceof BuildRetriesExhausted) {
      // 5.2-7 の上限に達した。**500 にしない**（各段は正常に働いた）。**429 でもない**
      // （枠は消費済みで、しかも 1 回ではなく試行の回数だけ消えている）。文言と
      // 出してよい項目は `describeBuildFailure` が決める（**診断は出さない**）。
      console.error(`[generate] ${error.name}: attempts=${error.attempts}`);
      return json(describeBuildFailure(error), BUILD_FAILED_STATUS);
    }
    if (error instanceof PipelineStepNotImplemented) {
      // 骨組みだけが動いている状態。どこまで進んだかを返す（段の名前は実装の内部名
      // だが、公開前の開発中に到達する応答であり、利用者向けの文言ではない）。
      console.error(`[generate] ${error.message}`);
      return json({ error: 'not implemented', step: error.step }, 501);
    }
    console.error('[generate] 生成の処理に失敗しました', describeGenerateError(error));
    return json({ error: 'internal error' }, 500);
  }
}

/**
 * 例外を、ログへ出してよい 1 行の文字列へ落とす。
 *
 * **`message` を出さない。** ここは各段が投げた例外を受ける位置であり、中身は
 * こちらで決まらない。利用者のプロンプトは 8.2 のモデレーション対象になる入力で、
 * `generations.prompt` として D1 に持つのとは保管場所も寿命も違うログへ、段の実装
 * しだいで流れてよいものではない。
 *
 * 「段はプロンプトを例外へ入れないこと」という呼びかけで担保しない
 * （shared-ai-rules 12 章）。**段の診断情報は段自身が、何が安全か知っている場所で
 * ログに出す。** ここが出すのは「どの種類の例外で落ちたか」だけでよい。
 *
 * @param error catch した値（型は unknown）
 * @returns ログに残してよい 1 行
 */
function describeGenerateError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 生成の経路を組み立てる。
 *
 * @param pipeline 差し替える各段（既定は `defaultPipeline`）
 * @returns 経路表へ連結する `Route[]`
 */
export function createGenerateRoutes(
  pipeline: GenerationPipeline = defaultPipeline,
): readonly Route[] {
  const handler: RouteHandler = (request, env) => handleGenerate(request, env, pipeline);
  return [{ method: 'POST', path: GENERATE_PATH, handler }];
}

/** アプリの経路表へ連結する生成の経路（既定の依存）。 */
export const generateRoutes: readonly Route[] = createGenerateRoutes();
