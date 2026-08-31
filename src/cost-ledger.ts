/**
 * 費用台帳（3.3-4 / 4.1 / 4.2 / 4.3 / 5.1 / #22）。
 *
 * **すべての LLM 呼び出しの `usage` を、使ったモデルの単価で円換算し、成功・失敗・
 * リトライを問わず `generations` へ 1 行ずつ記録する。** 4.3 の月次上限は「推定値では
 * なく実測累計で判定する」と定めており、この台帳がその累計の唯一の出所である。
 *
 * ## 単価はここに書かない
 *
 * **単価表は `src/generation-models.ts` の `GENERATION_MODELS` 1 か所である。**
 * ここへ写すと、仕様書 4.1・登録簿・台帳の 3 か所になり、更新のたびに 2 か所が
 * 静かに古くなる（shared-ai-rules 12 章）。仕様書と登録簿の照合は
 * `test/generation-models.test.ts` が持ち、**台帳が登録簿の値をそのまま使っていること**は
 * `test/cost-ledger.test.ts` が単価を変異させて確かめる。
 *
 * ## 過少計上を作らない
 *
 * 換算に迷いが出る場合（単価表に無い次元にトークンが載っていた、登録簿に無いモデルで
 * 生成された）は、**必ず高い側へ倒す。** 過大計上は 4.3 の上限が早く発火するだけだが、
 * 過少計上は上限をすり抜けさせる。層 3（Budgets）の判定基準が
 * 「発火したら台帳のずれ」である以上、ずれる向きは選べる方を選ぶ。
 *
 * ## 記録するのは「呼び出しが返ったこと」であって「作品ができたこと」ではない
 *
 * 3.3 の順序は「クォータ判定 → 生成 → **費用計上** → ビルド → 行の作成」で、費用計上は
 * ビルドより前にある。**生成が成功してビルドが失敗しても課金は発生している**（4.3）。
 * したがってこのモジュールは `games` 行の成否を知らないし、待たない。
 */
import type {
  GenerationResult,
  GenerationUsage,
  ModelPricing,
} from './generation-models.js';
import { GENERATION_MODELS, findGenerationModel, ledgerEffortOf } from './generation-models.js';
// **リトライの上限は借りる。** 同じ数（3）を A/B の集計へ書き写すと、5.2-7 の上限を
// 動かした日に集計だけが古い値で「依頼の切り分けが怪しい」を判定する
// （shared-ai-rules 12 章）。
import { MAX_GENERATION_ATTEMPTS } from './build-retry.js';

/**
 * 円換算に使う為替レート（円/ドル）。**4.2 の 150 円/ドルを正とする（#22 で決定）。**
 *
 * 仕様書は 2 つの値を持っていた。**4.2 が LLM の換算に 150 円/ドル、4.6 が Lambda と
 * ECR の見積もりに 155 円/$ である。** 台帳が使うのは前者である。
 *
 * - **4.3 の枠が 150 円/ドルの上に建っている。** 日次クォータ 12 回は
 *   「333 円/日 ÷ 11.9 円/本」から逆算され、その 11.9 円は 4.2 の実測を 150 円/ドルで
 *   換算した値である。台帳だけ別のレートにすると、**枠を決めた値と枠を判定する値が
 *   ずれ**、4.3 の「層 3 が発火したら台帳のずれ」という判定基準が成立しなくなる。
 * - **差は 3.3% で、層 3 のバッファに収まる。** 層 3 は 85 USD（130 円/ドルでも
 *   約 11,050 円）で、**層 1 より先に発火してはいけない**という向きに置かれている。
 *   1 万円は 150 円/ドルで 66.7 USD なので、実勢が 155 でも 160 でも層 1 が先に出る。
 * - **4.6 の 155 円/$ は LLM の換算経路に入らない。** あちらは AWS の他費用（Lambda の
 *   GB 秒、ECR の保管、NAT の比較）の見積もりで、台帳が触る数字ではない。
 *
 * **レートを動かすときは、4.2 の実測値・4.3 の逆算・この定数を同時に動かすこと。**
 * 片方だけを動かすと枠と判定がずれる。仕様書側の値との一致は
 * `test/cost-ledger.test.ts` が機械照合する。
 */
export const USD_JPY_RATE = 150;

/**
 * 仕様書がレートを宣言している文の形（テストが照合に使う）。
 *
 * **「為替（レート）は N 円/ドル」の形だけを対象にする。** 4.3 の「85 USD は
 * 130 円/ドルでも約 11,050 円」は**意図的に別の値**（層 3 が層 1 より先に発火しない
 * ことを示す円高側の確認）であり、換算レートの宣言ではない。ここまで拾うと、正しい
 * 記述で赤が出る。
 *
 * **見出しの「為替レートは 150 円/ドルを正とする」も拾う。** 仕様書側で同じ数値が
 * 増えたぶんだけ、片方だけ古くなる経路も増えるためである。
 */
export const EXCHANGE_RATE_PATTERN = /為替(?:レート)?は\s*([0-9]+(?:\.[0-9]+)?)\s*円\/ドル/gu;

/** `usage` のうち、モデルによって課金次元を持たない 2 つ（4.1）。 */
export type CacheDimension = 'cacheRead' | 'cacheWrite';

/**
 * 換算のときに見つけた異常。**記録は止めない**（4.3 は全件記録を要求する）。
 *
 * - `missing-priced-dimension`: そのモデルは単価を持つのに、`usage` の項目が欠けていた。
 *   **0 トークンとして計上する。** 記録しない選択肢は無く、キャッシュの 2 次元は
 *   入出力より 1〜2 桁安いため、欠測を 0 と見た過少計上の上限は小さい。
 *   4.5 は「`cacheReadInputTokens` がゼロのまま推移する」ことを異常検知の材料に挙げて
 *   いるので、値としてではなく**異常として**残す。
 * - `unpriced-tokens`: そのモデルは単価を持たないのに、`usage` にトークンが載っていた。
 *   **単価表が現実に追いついていない。** 登録簿の最大単価で計上する（過少計上を作らない）。
 * - `unknown-model`: 登録簿に無いモデルで生成された。同上の理由で最大単価を使う。
 */
export type CostAnomaly =
  | { readonly kind: 'missing-priced-dimension'; readonly dimension: CacheDimension }
  | {
      readonly kind: 'unpriced-tokens';
      readonly dimension: CacheDimension;
      readonly tokens: number;
    }
  | { readonly kind: 'unknown-model'; readonly modelKey: string };

/** 円換算の内訳。次元ごとに分けて持つのは、4.5 のキャッシュの効きを見るため。 */
export interface CostBreakdown {
  readonly inputJpy: number;
  readonly outputJpy: number;
  readonly cacheReadJpy: number;
  readonly cacheWriteJpy: number;
  /** 4 次元の合計。`generations.cost_jpy` へ入る値。 */
  readonly totalJpy: number;
  /** 換算のときに見つけた異常（無ければ空）。 */
  readonly anomalies: readonly CostAnomaly[];
}

/**
 * トークン数を円へ換算する。
 *
 * @param tokens トークン数
 * @param usdPerMillion 100 万トークンあたりのドル単価
 * @returns 円
 */
function toJpy(tokens: number, usdPerMillion: number): number {
  return (tokens * usdPerMillion * USD_JPY_RATE) / 1_000_000;
}

/**
 * 登録簿の最大単価（$/100 万トークン）。
 *
 * **単価が分からない次元・モデルに当てる上限値である。** 分からない分を 0 で通すと
 * 4.3 の上限が静かにすり抜けるので、**知っている中で最も高い単価**を当てて、
 * 異常として報告する。
 *
 * @returns 登録簿に現れるすべての単価の最大値
 */
function highestKnownUsdPerMillion(): number {
  const prices = GENERATION_MODELS.flatMap((model) => [
    model.pricing.inputUsdPerMillion,
    model.pricing.outputUsdPerMillion,
    model.pricing.cacheReadUsdPerMillion,
    model.pricing.cacheWriteUsdPerMillion,
  ]).filter((price): price is number => price !== null);
  return Math.max(...prices);
}

/**
 * キャッシュ 1 次元を換算する。
 *
 * 単価（`null` = そのモデルは課金次元を持たない）と `usage`（`null` = 項目が返らなかった）
 * の 4 通りを、{@link CostAnomaly} の方針どおりに処理する。
 *
 * @param dimension どの次元か
 * @param tokens `usage` の値（欠けていれば `null`）
 * @param usdPerMillion 単価（課金次元を持たなければ `null`）
 * @param anomalies 見つけた異常の追記先
 * @returns 円
 */
function convertCacheDimension(
  dimension: CacheDimension,
  tokens: number | null,
  usdPerMillion: number | null,
  anomalies: CostAnomaly[],
): number {
  if (tokens === null) {
    if (usdPerMillion !== null) {
      // 単価を持つモデルなのに項目が返らなかった。0 として計上し、異常として残す。
      anomalies.push({ kind: 'missing-priced-dimension', dimension });
    }
    // 単価も値も無い（DeepSeek のキャッシュ 2 次元）。**正常である。**
    return 0;
  }
  if (usdPerMillion === null) {
    if (tokens > 0) {
      anomalies.push({ kind: 'unpriced-tokens', dimension, tokens });
      return toJpy(tokens, highestKnownUsdPerMillion());
    }
    // 課金次元を持たないモデルが 0 を返しただけ。請求する対象が無い。
    return 0;
  }
  return toJpy(tokens, usdPerMillion);
}

/**
 * `usage` をモデル別単価で円換算する。
 *
 * **単価は引数のモデルからしか読まない。** ここに数値を書かないことが、単価表を
 * 1 か所に保つということである。
 *
 * @param pricing 使ったモデルの単価（`GENERATION_MODELS` の要素が持つもの）
 * @param usage 4.1 の `usage` 4 種（欠けた項目は `null`）
 * @param anomalies 見つけた異常の追記先（呼び出し側が既に積んだものを引き継ぐ）
 * @returns 次元ごとの円と合計
 */
export function convertUsageToJpy(
  pricing: ModelPricing,
  usage: GenerationUsage,
  anomalies: CostAnomaly[] = [],
): CostBreakdown {
  const inputJpy = toJpy(usage.inputTokens, pricing.inputUsdPerMillion);
  const outputJpy = toJpy(usage.outputTokens, pricing.outputUsdPerMillion);
  const cacheReadJpy = convertCacheDimension(
    'cacheRead',
    usage.cacheReadInputTokens,
    pricing.cacheReadUsdPerMillion,
    anomalies,
  );
  const cacheWriteJpy = convertCacheDimension(
    'cacheWrite',
    usage.cacheWriteInputTokens,
    pricing.cacheWriteUsdPerMillion,
    anomalies,
  );
  return {
    inputJpy,
    outputJpy,
    cacheReadJpy,
    cacheWriteJpy,
    totalJpy: inputJpy + outputJpy + cacheReadJpy + cacheWriteJpy,
    anomalies,
  };
}

/**
 * 生成結果を円換算する。**登録簿に無いモデルでも落とさない。**
 *
 * 型（`GenerationModelKey`）が未知の鍵を弾くため、通常この経路は通らない。それでも
 * 0 円へ落とさないのは、**唯一起こりうる経路が「登録簿から要素を消したのに、その
 * モデルで生成した」であり、それはまさに台帳が静かにずれる事故**だからである。
 *
 * @param generated 生成結果（どのモデルで生成したかを必ず含む）
 * @returns 次元ごとの円と合計
 */
export function costOfGeneration(generated: GenerationResult): CostBreakdown {
  const anomalies: CostAnomaly[] = [];
  const model = findGenerationModel(generated.modelKey);
  if (model === null) {
    const fallback = highestKnownUsdPerMillion();
    anomalies.push({ kind: 'unknown-model', modelKey: generated.modelKey });
    return convertUsageToJpy(
      {
        inputUsdPerMillion: fallback,
        outputUsdPerMillion: fallback,
        cacheReadUsdPerMillion: fallback,
        cacheWriteUsdPerMillion: fallback,
      },
      generated.usage,
      anomalies,
    );
  }
  if (model.modelId !== generated.modelId) {
    // 鍵と実際に送った ID が食い違う。単価は鍵側で引いているため、換算は続けてよい。
    // 推論プロファイルの取り違え（4.1）が後から追えるように記録だけ残す。
    console.warn(
      `[cost-ledger] モデル ID が登録簿と一致しません: key=${model.key} sent=${generated.modelId}`,
    );
  }
  return convertUsageToJpy(model.pricing, generated.usage, anomalies);
}

/**
 * この生成が使えるソースを返したか（`generations.succeeded`）。
 *
 * **`end_turn` だけを成功とする。** `max_tokens` で切れたソースはコンパイルできず
 * （`src/generation-models.ts`）、`content_filtered` や `guardrail_intervened` も
 * 本文が欠ける。いずれも**課金は発生している**ため、記録しないのではなく
 * 「失敗として記録する」。
 *
 * **ビルドの成否はここに入らない。** 3.3 の順序で費用計上はビルドより前にあり、
 * この時点でビルド結果は存在しない。ビルドまで通ったかどうかは `games` 行の側で分かる。
 *
 * @param generated 生成結果
 * @returns 使えるソースなら true
 */
export function isUsableGeneration(generated: GenerationResult): boolean {
  return generated.stopReason === 'end_turn';
}

/** 台帳へ 1 行書いた結果。 */
export interface LedgerRecord {
  /** `generations.id`。 */
  readonly id: string;
  /** 円換算の内訳。 */
  readonly cost: CostBreakdown;
  /** `generations.succeeded` に入った値。 */
  readonly succeeded: boolean;
  /**
   * 実際に行が増えたか（#150）。
   *
   * **冪等な書き込み（{@link RecordGenerationOptions.id} を渡した場合）でだけ
   * `false` になりうる。** 同じ id が既にある＝再送を受け取ったという意味で、
   * **異常ではない。** 通常の呼び出しでは id を新しく引くので常に `true` になる。
   */
  readonly written: boolean;
}

/** {@link recordGeneration} の任意の指定（#150）。 */
export interface RecordGenerationOptions {
  /**
   * `generations.id` を呼び出し側が決める（冪等な再送のため）。
   *
   * **生成の本体が Worker の外へ出ると、台帳の書き込みはコールバックになる**（#150）。
   * **LLM を呼んだあとにそのコールバックが落ち続けると、課金は出ているのに
   * `generations` の行が無い状態になり**、4.3 の「リトライ分も必ず計上する」が崩れて
   * 日次枠も減らない（確定25 は枠を行数で数える）。利用者には得だが、**費用ガードの
   * 前提が壊れる。**
   *
   * **コールバックの再送は LLM を呼ばないので費用ゼロである。** したがって呼ぶ側は
   * 届くまで再送してよく、こちら側は何度受け取っても 1 行でなければならない。
   * 呼ぶ側が LLM 呼び出しごとに 1 つ採番した id をここへ渡すと、2 通目以降は
   * `on conflict(id) do nothing` で落ちる。
   *
   * **`insert or ignore` にしない。** あれは主キー以外の制約違反（`user_id` の
   * 外部キーなど）まで黙って飲み込む。**衝突させたいのは id だけ**なので、
   * 競合の対象を明示する upsert の形にする。
   */
  readonly id?: string;
}

/**
 * 生成 1 回分を台帳へ記録する。
 *
 * **1 回の LLM 呼び出しにつき 1 行である。** リトライ（5.2-7 / #20）は呼び出しの回数だけ
 * この関数を呼ぶ。行をまとめたり上書きしたりしない（4.3「リトライ分も必ず計上する」）。
 *
 * **`game_id` は入れない。これは決定であって、未実装ではない**（確定27 / 5.1 / #124）。
 * 作品行の作成は 3.3-8 で、この時点では存在しない。**読む側が現れるまで結び付けない**と
 * 決めた（仕様書を通して `generations.game_id` を読む機能が 1 つも無く、リトライ
 * （5.2-7 / #20）で 1 作品に複数行が対応するため、当てずっぽうに 1 行を選ぶと誤った
 * 費用帰属を作る）。
 *
 * **列は残す**（`migrations/0001_init.sql`。NULL 許容）。消費者が現れたときに選ぶ 2 案
 * （3.3 の先頭で相関 id を採る / この関数が返す id を 3.3-8 まで運んで UPDATE する）と
 * その得失は 5.1 にある。**この関数は既に行の id を返しており**（{@link LedgerRecord}）、
 * 後者を採るならこの関数は変えなくてよい。
 *
 * @param env バインディングと環境変数
 * @param entry 記録する内容
 * @param now 記録時刻（UNIX 秒。既定は現在時刻）
 * @param options 冪等な書き込みのための指定（#150）
 * @returns 書いた行の id と円換算の内訳
 */
export async function recordGeneration(
  env: Env,
  entry: {
    readonly userId: string;
    readonly prompt: string;
    readonly generated: GenerationResult;
  },
  now: number = Math.floor(Date.now() / 1000),
  options: RecordGenerationOptions = {},
): Promise<LedgerRecord> {
  const cost = costOfGeneration(entry.generated);
  const succeeded = isUsableGeneration(entry.generated);
  // 呼び出し側が id を決めていれば、それを使って再送を吸収する（{@link RecordGenerationOptions}）。
  const id = options.id ?? crypto.randomUUID();
  const conflictClause = options.id === undefined ? '' : '\n     on conflict(id) do nothing';

  for (const anomaly of cost.anomalies) {
    // **プロンプトも生成物も出さない。** 出してよいのはモデルと次元の名前だけである
    // （`src/generate.ts` の `describeGenerateError` と同じ方針）。
    console.error(`[cost-ledger] ${anomaly.kind}: ${JSON.stringify(anomaly)}`);
  }

  // **実際に送った `effort` を行へ焼き付ける**（#25 / `migrations/0011_generations_effort.sql`）。
  //
  // **登録簿から引く。** 群は登録簿の要素（`sonnet-4-6-high` など）として表しており、
  // その鍵は `generations.model` へ入る値と同じものが**本番のコールバック経路まで
  // 運ばれている**（`src/generate-callback.ts` の `parseLedger` が
  // `findGenerationModel` で検証する）。したがって、この 1 行で本番の行にも値が入る。
  //
  // **登録簿に無い鍵のときは `null` にする。** その場合は何を送ったのか分からず、
  // `'none'`（送っていない）と断定できない。**分からないものを断定しない**のは、
  // 費用を最大単価へ倒す（下の `costOfGeneration`）のと同じ向きの判断である。
  const model = findGenerationModel(entry.generated.modelKey);
  const effort = model === null ? null : ledgerEffortOf(model);

  const result = await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model, effort,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${conflictClause}`,
  )
    .bind(
      id,
      entry.userId,
      entry.prompt,
      // **鍵を入れる。** 単価を引くのはこちらで、モデル ID は登録簿から引ける
      // （`GENERATION_MODELS`）。ID を入れると、単価を引くたびに ID → 鍵の対応表が
      // もう 1 つ要る。
      entry.generated.modelKey,
      effort,
      entry.generated.usage.inputTokens,
      entry.generated.usage.outputTokens,
      // **列は NOT NULL である**（5.1 / `migrations/0001_init.sql`）。欠けた項目は 0 で
      // 埋めるが、「0 トークンだった」と「そもそも課金次元が無い」の区別は失わない。
      // どちらであるかは `model` 列と単価表から引けるためで、区別のためだけに
      // スキーマを変えない。
      entry.generated.usage.cacheWriteInputTokens ?? 0,
      entry.generated.usage.cacheReadInputTokens ?? 0,
      cost.totalJpy,
      succeeded ? 1 : 0,
      now,
    )
    .run();

  return { id, cost, succeeded, written: (result.meta.changes ?? 0) > 0 };
}

/**
 * 3.3-4 の段（`GenerationPipeline['recordCost']`）の実装。
 *
 * **行の id を返さないのは確定27（5.1）による。** `game_id` を結び付けないと決めている
 * 以上、id を段の戻り値へ通す理由がいまは無い。結び付ける消費者が現れたら、5.1 の
 * 「成功した 1 行だけ結ぶ」案がこの戻り値を使う（{@link recordGeneration} は返している）。
 *
 * @param env バインディングと環境変数
 * @param userId 生成した利用者
 * @param request 検証済みのリクエスト（`prompt` を台帳へ残す。5.1）
 * @param generated 生成結果
 */
export async function recordGenerationCost(
  env: Env,
  userId: string,
  request: { readonly prompt: string },
  generated: GenerationResult,
): Promise<void> {
  await recordGeneration(env, { userId, prompt: request.prompt, generated });
}

/** JST の UTC からの差（秒）。日本は夏時間を持たないため固定でよい。 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/** 月次累計の集計結果（4.3 層 1）。 */
export interface MonthlyCostTotals {
  /** JST の暦年。 */
  readonly year: number;
  /** JST の暦月（1〜12）。 */
  readonly month: number;
  /** 集計範囲の下端（UNIX 秒。この値を含む）。 */
  readonly fromSeconds: number;
  /** 集計範囲の上端（UNIX 秒。この値を**含まない**）。 */
  readonly toSeconds: number;
  /** 円換算の累計。行が 1 つも無ければ 0。 */
  readonly costJpy: number;
  /** 記録された生成回数（成否を問わない）。 */
  readonly generations: number;
}

/**
 * ある時刻が属する JST の暦月の範囲を返す。
 *
 * **月の境界も JST に揃える。** 4.3 の日次クォータが JST 0 時を境界としており、
 * 月次だけ UTC にすると**月初の 9 時間が前月に入る。** 4.4 が利用者へ見せる
 * 「今月の生成は終了しました」が、利用者の暦と 9 時間ずれることになる。
 *
 * @param at 基準時刻（UNIX 秒）
 * @returns 年・月と、半開区間 `[fromSeconds, toSeconds)`
 */
export function jstMonthRange(at: number): {
  readonly year: number;
  readonly month: number;
  readonly fromSeconds: number;
  readonly toSeconds: number;
} {
  // JST の壁時計を UTC のまま読むために、先に 9 時間ぶん進めてから UTC で解釈する。
  const jstWallClock = new Date((at + JST_OFFSET_SECONDS) * 1000);
  const year = jstWallClock.getUTCFullYear();
  const month = jstWallClock.getUTCMonth() + 1;
  const fromSeconds = Date.UTC(year, month - 1, 1) / 1000 - JST_OFFSET_SECONDS;
  const toSeconds = Date.UTC(year, month, 1) / 1000 - JST_OFFSET_SECONDS;
  return { year, month, fromSeconds, toSeconds };
}

/**
 * 当月（JST）の費用累計を集計する（4.3 層 1 の判定が使う値）。
 *
 * **利用者で絞らない。** 4.3 の月次 1 万円は**サービス全体**の上限である。1 人あたりの
 * 蓋は日次クォータ 12 回（確定25）で、そちらは #23 が持つ。
 *
 * **判定はここでしない。** しきい値（1 万円・80% 警告）と停止は 3.3-2 の段（#23）の
 * 責務で、このモジュールは累計を返すところまでを持つ。
 *
 * @param env バインディングと環境変数
 * @param at 基準時刻（UNIX 秒。既定は現在時刻）
 * @returns 集計範囲と累計
 */
export async function monthlyCostTotals(
  env: Env,
  at: number = Math.floor(Date.now() / 1000),
): Promise<MonthlyCostTotals> {
  const range = jstMonthRange(at);
  // **`sum` は行が無いと NULL を返す。** `coalesce` を SQL 側で被せる。JS 側で
  // `?? 0` にすると、`sum` が NULL を返す経路と列が NULL の経路が同じ形になる。
  const row = await env.DB.prepare(
    `select coalesce(sum(cost_jpy), 0) as cost_jpy, count(*) as generations
       from generations
      where created_at >= ? and created_at < ?`,
  )
    .bind(range.fromSeconds, range.toSeconds)
    .first<{ cost_jpy: number; generations: number }>();

  return {
    ...range,
    costJpy: row?.cost_jpy ?? 0,
    generations: row?.generations ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * `effort` の A/B 計測（4.2 / M3-4 / #25）
 * ------------------------------------------------------------------ */

/**
 * 「元ソースが `messages` に載っている」と判定する未キャッシュ入力トークンの上限。
 *
 * **推敲・フォークと新規生成を混ぜないための境目である。** 1.2.43 は
 * 「推敲（19.5〜25.0 円）と新規生成（約 16 円）は別の値」と定めており、混ぜると
 * `effort` の効果より大きな差がそこから入る。
 *
 * **綴りやプロンプトの中身ではなく、経路の構造から判定する。** 推敲・フォークは
 * 「前置き＋元ソース」を `messages` の先頭に置き、**その直後に `cachePoint` を置く**
 * （`src/bedrock.ts` の `baseSourceContent` / 4.5）。キャッシュへ入ったトークンは
 * `usage.inputTokens` に現れないため、**未キャッシュ入力は差分プロンプトだけ**になる。
 *
 * | | 未キャッシュ入力の実測 | 出典 |
 * |---|---|---|
 * | 推敲 | **20 / 20 / 37 / 35** | 1.2.43（4 回） |
 * | 新規生成 | **1,092（平均）/ 1,215〜1,444** | 4.2 |
 *
 * **1.5 桁離れている。** 200 はその谷の底で、どちらの側へも 5 倍以上の余裕がある。
 *
 * **この判定が成立しないモデルがある。** DeepSeek はキャッシュの課金次元を持たない
 * ため（4.1）、元ソースがそのまま未キャッシュ入力に乗る。**A/B の対象は Claude
 * だけである**（`effort` は Claude のみの概念。4.2）ので実験の集計では問題に
 * ならないが、他のモデルの行をこの境目で分類しないこと。
 *
 * **確かめられる形にしてある。** {@link EffortExperimentGroup} は群ごとに未キャッシュ
 * 入力の最小・最大を返す。分類が崩れていれば、その 2 つの値が谷をまたいで見える。
 */
export const BASE_SOURCE_INPUT_TOKEN_CEILING = 200;

/**
 * 出力トークンの層の境界（既定）。
 *
 * **交絡を分離するための層である**（{@link effortExperimentTotals}）。
 * 4.2 の新規生成の実測（平均 4,171）と本番の実測（6,411 / 6,833 / 6,447）、
 * 1.2.43 の推敲（6,731〜9,036）がまたがる範囲を 3 つに切る。
 */
export const OUTPUT_TOKEN_STRATA: readonly number[] = [4_000, 8_000];

/**
 * 1 依頼の行が広がってよい時間の幅（秒）。
 *
 * **依頼の境目を推定していることを、読む人に見せるための閾値である**（下記）。
 * 1 回の生成は約 107 秒、リトライは最大 3 試行（5.2-7）なので、1 依頼の行は
 * 数分に収まる。**30 分に散らばった同一プロンプトの行は、別々の依頼である。**
 */
export const AMBIGUOUS_JOB_SPAN_SECONDS = 30 * 60;

/** 出力トークンで層別した 1 層。 */
export interface EffortOutputStratum {
  /** 層の下端（この値を含む）。 */
  readonly fromOutputTokens: number;
  /** 層の上端（この値を**含まない**）。最上位の層は `null`。 */
  readonly toOutputTokens: number | null;
  /** この層に入った LLM 呼び出しの回数。 */
  readonly calls: number;
  /** この層の実コスト（円）。 */
  readonly costJpy: number;
  /** この層の出力トークンの合計。 */
  readonly outputTokens: number;
  /** 1 呼び出しあたりの実コスト（円）。呼び出しが無ければ `null`。 */
  readonly costJpyPerCall: number | null;
}

/** A/B の 1 群（モデルの鍵 × `effort` × 元ソースの有無）。 */
export interface EffortExperimentGroup {
  /** `generations.model`（＝登録簿の鍵）。 */
  readonly modelKey: string;
  /**
   * `generations.effort`。
   *
   * `'none'` は「**送らなかった**」（登録簿の `effort: null`）。
   *
   * **`null` には意味が 2 つある。混ぜないこと。**
   *
   * | 出どころ | 意味 | 見分けかた |
   * |---|---|---|
   * | 0011 より前に入った行 | **記録していない** | 窓を `migrations/0011_generations_effort.sql` の適用より後に取れば、そもそも入らない |
   * | 登録簿に無い鍵で生成された行 | **何を送ったか分からない** | {@link modelKey} を `findGenerationModel` に引くと `null` が返る |
   *
   * **2 つ目を「実験より前の古い行」として読み飛ばさないこと。** `recordGeneration` は
   * 登録簿に無い鍵のとき `'none'` と断定せず `null` を書く（送っていないとは限らない
   * ため。費用を最大単価へ倒すのと同じ向きの判断である）。**それは実験期間中の設定
   * ミスでありうる**——`GENERATION_MODEL` の綴りを変えた、登録簿から要素を消した、
   * といった、**A/B でいちばん見たい行**である。
   *
   * したがって `effort` が `null` の群を見つけたら、**まず {@link modelKey} を登録簿へ
   * 引くこと。** 引けなければ 2 つ目で、窓の中で起きた事故である。
   */
  readonly effort: string | null;
  /** 元ソースが `messages` に載っていたか（＝推敲・フォーク。{@link BASE_SOURCE_INPUT_TOKEN_CEILING}）。 */
  readonly withBaseSource: boolean;
  /** 依頼の数（＝同じプロンプトの行のまとまりの数。下記の但し書きを読むこと）。 */
  readonly jobs: number;
  /** LLM 呼び出しの回数（＝台帳の行数。リトライを含む。確定25）。 */
  readonly calls: number;
  /**
   * **1 回目の LLM 呼び出しだけで終わった依頼の数。**
   *
   * **これが「初回コンパイル成功率」の分子である。** 2 回目の行があるということは、
   * 1 回目の生成が（費用ゼロの機械修正を経ても）ビルドを通らなかったということで、
   * それ以外にリトライが起きる経路は無い（`src/generate.ts` の `runGenerationJob` は
   * `kind='build'` の失敗だけを再生成へ回す）。
   *
   * **上界である。** 5.2-5 の即拒否（許可外パッケージ）はリトライされず 1 行で
   * 終わるため、その依頼もここに数えられる。差は
   * {@link EffortExperimentReport.games} の `byError` にある `source-rejected` の件数で
   * 引ける（窓の中では群が 1 つに固定されているため）。
   *
   * **`stopReason` が `end_turn` でなかった呼び出しは数えない**（`max_tokens` で
   * 切れたソースはコンパイルできない。{@link isUsableGeneration}）。
   */
  readonly firstCallCompleted: number;
  /** {@link EffortExperimentGroup.firstCallCompleted} / {@link EffortExperimentGroup.jobs}。依頼が無ければ `null`。 */
  readonly firstCallCompletionRate: number | null;
  /** 実コスト（円。4.3 の累計と同じ値の部分和）。 */
  readonly costJpy: number;
  /** 1 依頼あたりの実コスト（円）。 */
  readonly costJpyPerJob: number | null;
  /** 1 本の「初回で終わった依頼」あたりの実コスト（円）。**4.2 の「1 本の成功あたり」に対応する。** */
  readonly costJpyPerFirstCallCompletion: number | null;
  /** 出力トークンの合計。 */
  readonly outputTokens: number;
  /** 1 呼び出しあたりの出力トークン。 */
  readonly outputTokensPerCall: number | null;
  /** 出力 1,000 トークンあたりの実コスト（円）。**交絡の正規化である。** */
  readonly costJpyPerKiloOutputToken: number | null;
  /** `end_turn` で終わらなかった呼び出しの回数（`max_tokens` の疑い）。 */
  readonly unusableCalls: number;
  /** 未キャッシュ入力トークンの最小（分類が崩れていないかの確認用）。 */
  readonly minInputTokens: number;
  /** 未キャッシュ入力トークンの最大（同上）。 */
  readonly maxInputTokens: number;
  /**
   * **依頼の切り分けが怪しいまとまりの数。**
   *
   * 同じプロンプトの行が 5.2-7 の上限（3 試行）を超えている、または
   * {@link AMBIGUOUS_JOB_SPAN_SECONDS} より広い時間に散らばっている。
   * **0 でなければ、同じお題を 1 群で 2 回以上使っている**（下記の但し書き）。
   */
  readonly ambiguousJobs: number;
  /** 出力トークンで層別した内訳。 */
  readonly strata: readonly EffortOutputStratum[];
}

/** {@link effortExperimentTotals} の結果。 */
export interface EffortExperimentReport {
  /** 集計範囲の下端（UNIX 秒。この値を含む）。 */
  readonly fromSeconds: number;
  /** 集計範囲の上端（UNIX 秒。この値を**含まない**）。 */
  readonly toSeconds: number;
  /** 元ソースの有無を分けた境目（{@link BASE_SOURCE_INPUT_TOKEN_CEILING}）。 */
  readonly baseSourceInputTokenCeiling: number;
  /** 出力トークンの層の境界。 */
  readonly outputTokenStrata: readonly number[];
  /** 群ごとの集計。 */
  readonly groups: readonly EffortExperimentGroup[];
  /**
   * 同じ窓の `games` 行の内訳。
   *
   * **台帳と作品行は結び付いていない**（確定27 / 5.1。`generations.game_id` は NULL
   * である）。それでも並べて返すのは、**窓の中では群が 1 つに固定されている**ためで、
   * これだけで {@link EffortExperimentGroup.firstCallCompleted} の上界を実数へ寄せられる。
   */
  readonly games: {
    /** 窓の中で作られた作品行の数。 */
    readonly total: number;
    /** `generation_state` ごとの件数。 */
    readonly byState: Readonly<Record<string, number>>;
    /** `generation_error` ごとの件数（NULL は含めない）。 */
    readonly byError: Readonly<Record<string, number>>;
  };
}

/** {@link effortExperimentTotals} の指定。 */
export interface EffortExperimentOptions {
  /** 集計範囲の下端（UNIX 秒。この値を含む）。 */
  readonly fromSeconds: number;
  /** 集計範囲の上端（UNIX 秒。この値を**含まない**）。 */
  readonly toSeconds: number;
  /** 元ソースの有無を分ける境目。既定は {@link BASE_SOURCE_INPUT_TOKEN_CEILING}。 */
  readonly baseSourceInputTokenCeiling?: number;
  /**
   * 出力トークンの層の境界（昇順）。既定は {@link OUTPUT_TOKEN_STRATA}。
   *
   * **空配列は「層別しない」**（全呼び出しが `[0, 上限なし)` の 1 層になる）。
   */
  readonly outputTokenStrata?: readonly number[];
}

/** 依頼（同じ利用者・同じプロンプトの行のまとまり）1 つぶんの集計。 */
interface JobRow {
  model: string;
  effort: string | null;
  has_base_source: number;
  calls: number;
  usable_calls: number;
  cost_jpy: number;
  output_tokens: number;
  min_input_tokens: number;
  max_input_tokens: number;
  first_at: number;
  last_at: number;
}

/** 層別の 1 行。 */
interface StratumRow {
  model: string;
  effort: string | null;
  has_base_source: number;
  stratum: number;
  calls: number;
  cost_jpy: number;
  output_tokens: number;
}

/**
 * 群を一意に指す鍵（`Map` 用）。
 *
 * @param row 群の 3 項目を持つ行
 * @returns 鍵
 */
function groupKeyOf(row: {
  model: string;
  effort: string | null;
  has_base_source: number;
}): string {
  return `${row.model} ${row.effort ?? 'null'} ${row.has_base_source}`;
}

/**
 * 割り算。分母が 0 なら `null`（0 で埋めない）。
 *
 * **0 を返さない。** 「測ったら 0 だった」と「測る対象が無かった」を、A/B の
 * 比較表の上で見分けられなくするため。
 *
 * @param numerator 分子
 * @param denominator 分母
 * @returns 商、または null
 */
function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * 出力トークンの層を選ぶ `case` 式を組み立てる。
 *
 * **境界は束縛する**（文字列へ埋め込まない）。数値だけなので埋め込んでも安全だが、
 * 「SQL を文字列連結で作ってよい」という前例をこの経路に作らない。埋め込むのは
 * 層の番号（配列の添字）だけである。
 *
 * **境界が空なら定数の `0` を返す。** `case` は `when` を 1 つも持てないため、
 * 素朴に組み立てると `case  else 0 end` という**構文エラー**になる（走らせて確かめた:
 * SQLite は `near "else": syntax error` を返す）。
 *
 * **空配列は「層別せず、全部を 1 つとして見たい」という正当な指定である。** 集計を
 * 読む人が最初に試す形でもある。そこで構文エラーになるのは、意味のある結果が
 * 返らないより悪い。
 *
 * 定数 `0` を返すと、後段の辻褄も合う。層は 1 つだけになり、
 * `row.stratum === 0` なので下端は 0、`row.stratum === boundaries.length`（0 === 0）
 * なので上端は `null`——**`[0, 上限なし)` の 1 層**、つまり層別しないことそのものである。
 * 束縛する値も `...boundaries` が空へ展開されるので、`?` の数と一致する。
 *
 * @param boundaries 層の境界（昇順）。空なら層別しない
 * @returns `case` 式（境界が空なら定数 `0`）
 */
function stratumExpression(boundaries: readonly number[]): string {
  if (boundaries.length === 0) {
    return '0';
  }
  const whens = boundaries.map((_, index) => `when output_tokens < ? then ${index}`).join(' ');
  return `case ${whens} else ${boundaries.length} end`;
}

/**
 * `effort` の A/B を集計する（#25 の受け入れ条件 1）。
 *
 * **両群の実コストと初回コンパイル成功率を、1 回の呼び出しで返す。**
 *
 * ## 交絡（出力トークン）をどう分離しているか
 *
 * 1.2.43 の実測は、**推敲 4 回の費用が出力トークンにほぼ比例した**ことを示している
 * （出力 6,731 → 9,036 で 20.17 → 20.77 円、書き込みが乗った回だけ 25.02 円）。
 * `effort` は thinking を増やし、**thinking は出力として課金される**（4.2）。
 * したがって **`effort` の効果と出力長の差は、費用の上で同じ形をしている。**
 * 総額だけを比べると、**出力が伸びたことを `effort` の効果と読んでしまう。**
 *
 * この関数は 3 つの見方を同時に返して、両者を分けられるようにする。
 *
 * | 見方 | 返す値 | 何が分かるか |
 * |---|---|---|
 * | **正規化** | `costJpyPerKiloOutputToken` | 出力 1,000 トークンあたりの円。**ここに差が残れば、出力長では説明できない差**である（キャッシュの効き方や入力の違い） |
 * | **層別** | `strata` | 同じ出力トークン帯どうしで費用を比べる。**帯を固定すれば出力長の差は消える** |
 * | **分解** | `outputTokensPerCall` | 出力長そのものの差。**`effort` の効果の大半はここに出る**（thinking の量） |
 *
 * **正規化だけでは足りない。** `effort` の効果が丸ごと出力長を通して出るなら、
 * 正規化した値は両群でほぼ同じになる——それは「差が無い」ではなく
 * **「差はすべて出力長として現れた」**という意味である。3 つを並べて初めて読める。
 *
 * **単価が同じであることは登録簿が保証している。** A/B の 2 群は同じ実体から
 * 展開されており（`src/generation-models.ts`）、単価・モデル ID・出力上限が同じである。
 * ここが違えば、上のどの見方も成立しない。
 *
 * ## 推敲と新規生成を混ぜない
 *
 * 群は `withBaseSource` でも分かれる（{@link BASE_SOURCE_INPUT_TOKEN_CEILING}）。
 * **1.2.43 が「推敲と新規生成は別の値」と定めている**ためで、混ぜると `effort` より
 * 大きな差がそこから入る。
 *
 * ## 依頼の切り分けについての但し書き
 *
 * **台帳は作品行と結び付いていない**（確定27 / 5.1）。そのため「どの行が同じ依頼の
 * リトライか」は、**同じ利用者の同じプロンプト**であることから引くしかない
 * （`src/generate.ts` はリトライでも**元のプロンプト**を台帳へ渡す）。
 *
 * **したがって A/B は「1 群につき、お題の文面をすべて別にする」ことを前提にする。**
 * 4.2 の実測（同じ 6 本のお題を両モデルへ）と同じ形である。群が違えば `model` で
 * 分かれるので、**同じお題を両群へ使うのは正しい。**
 *
 * **前提が崩れたら見えるようにしてある。** 同じプロンプトの行が 3 試行を超える、
 * または 30 分より広く散らばっていれば `ambiguousJobs` が立つ。
 * **0 でない集計を、そのまま結論に使わないこと。**
 *
 * ## 窓は必須である
 *
 * `effort` 列は `migrations/0011_generations_effort.sql` で足したもので、**それより
 * 前の行は `NULL`（記録していない）である。** 窓を適用より後に取れば、その行は
 * 1 つも入らない。既定値を用意して窓を省けるようにすると、**古い行を対照群として
 * 数える集計**が簡単に書けてしまう。
 *
 * @param env バインディングと環境変数
 * @param options 集計範囲と層の指定
 * @returns 群ごとの集計と、同じ窓の作品行の内訳
 */
export async function effortExperimentTotals(
  env: Env,
  options: EffortExperimentOptions,
): Promise<EffortExperimentReport> {
  const { fromSeconds, toSeconds } = options;
  const ceiling = options.baseSourceInputTokenCeiling ?? BASE_SOURCE_INPUT_TOKEN_CEILING;
  const boundaries = options.outputTokenStrata ?? OUTPUT_TOKEN_STRATA;

  // 1 依頼 ＝「同じモデル・同じ effort・同じ元ソースの有無・同じ利用者・同じ
  // プロンプト」の行のまとまり（上の但し書き）。**`prompt` を選択しない**——
  // 返す必要が無く、5.1 の入力そのものを集計結果へ載せない（8.2 のモデレーション
  // 対象の文字列を、保管場所も寿命も違う場所へ出さない）。
  const jobs = await env.DB.prepare(
    `select
        model,
        effort,
        case when input_tokens <= ? then 1 else 0 end as has_base_source,
        count(*) as calls,
        sum(case when succeeded = 1 then 1 else 0 end) as usable_calls,
        sum(cost_jpy) as cost_jpy,
        sum(output_tokens) as output_tokens,
        min(input_tokens) as min_input_tokens,
        max(input_tokens) as max_input_tokens,
        min(created_at) as first_at,
        max(created_at) as last_at
       from generations
      where created_at >= ? and created_at < ?
      group by model, effort, has_base_source, user_id, prompt`,
  )
    .bind(ceiling, fromSeconds, toSeconds)
    .all<JobRow>();

  const strata = await env.DB.prepare(
    `select
        model,
        effort,
        case when input_tokens <= ? then 1 else 0 end as has_base_source,
        ${stratumExpression(boundaries)} as stratum,
        count(*) as calls,
        sum(cost_jpy) as cost_jpy,
        sum(output_tokens) as output_tokens
       from generations
      where created_at >= ? and created_at < ?
      group by model, effort, has_base_source, stratum`,
  )
    .bind(ceiling, ...boundaries, fromSeconds, toSeconds)
    .all<StratumRow>();

  // **作品行は別に数える。** 台帳と結び付いていないので join できない（確定27）。
  const gameRows = await env.DB.prepare(
    `select generation_state, generation_error, count(*) as games
       from games
      where created_at >= ? and created_at < ?
      group by generation_state, generation_error`,
  )
    .bind(fromSeconds, toSeconds)
    .all<{ generation_state: string; generation_error: string | null; games: number }>();

  const accumulated = new Map<string, EffortExperimentGroup>();
  for (const row of jobs.results) {
    const key = groupKeyOf(row);
    const previous: EffortExperimentGroup = accumulated.get(key) ?? {
      modelKey: row.model,
      effort: row.effort,
      withBaseSource: row.has_base_source === 1,
      jobs: 0,
      calls: 0,
      firstCallCompleted: 0,
      firstCallCompletionRate: null,
      costJpy: 0,
      costJpyPerJob: null,
      costJpyPerFirstCallCompletion: null,
      outputTokens: 0,
      outputTokensPerCall: null,
      costJpyPerKiloOutputToken: null,
      unusableCalls: 0,
      minInputTokens: row.min_input_tokens,
      maxInputTokens: row.max_input_tokens,
      ambiguousJobs: 0,
      strata: [],
    };

    // **1 回目だけで終わった依頼。** 行が 1 つで、しかもその 1 回が `end_turn` で
    // 終わっている（`max_tokens` で切れたソースはコンパイルできない）。
    const completedOnFirstCall = row.calls === 1 && row.usable_calls === 1;
    const ambiguous =
      row.calls > MAX_GENERATION_ATTEMPTS ||
      row.last_at - row.first_at > AMBIGUOUS_JOB_SPAN_SECONDS;

    accumulated.set(key, {
      ...previous,
      jobs: previous.jobs + 1,
      calls: previous.calls + row.calls,
      firstCallCompleted: previous.firstCallCompleted + (completedOnFirstCall ? 1 : 0),
      costJpy: previous.costJpy + row.cost_jpy,
      outputTokens: previous.outputTokens + row.output_tokens,
      unusableCalls: previous.unusableCalls + (row.calls - row.usable_calls),
      minInputTokens: Math.min(previous.minInputTokens, row.min_input_tokens),
      maxInputTokens: Math.max(previous.maxInputTokens, row.max_input_tokens),
      ambiguousJobs: previous.ambiguousJobs + (ambiguous ? 1 : 0),
    });
  }

  const strataByGroup = new Map<string, EffortOutputStratum[]>();
  for (const row of strata.results) {
    const key = groupKeyOf(row);
    const list = strataByGroup.get(key) ?? [];
    list.push({
      fromOutputTokens: row.stratum === 0 ? 0 : boundaries[row.stratum - 1]!,
      toOutputTokens: row.stratum === boundaries.length ? null : boundaries[row.stratum]!,
      calls: row.calls,
      costJpy: row.cost_jpy,
      outputTokens: row.output_tokens,
      costJpyPerCall: ratioOrNull(row.cost_jpy, row.calls),
    });
    strataByGroup.set(key, list);
  }

  const groups = [...accumulated.entries()].map(([key, group]) => ({
    ...group,
    firstCallCompletionRate: ratioOrNull(group.firstCallCompleted, group.jobs),
    costJpyPerJob: ratioOrNull(group.costJpy, group.jobs),
    costJpyPerFirstCallCompletion: ratioOrNull(group.costJpy, group.firstCallCompleted),
    outputTokensPerCall: ratioOrNull(group.outputTokens, group.calls),
    costJpyPerKiloOutputToken: ratioOrNull(group.costJpy * 1_000, group.outputTokens),
    strata: (strataByGroup.get(key) ?? []).sort(
      (left, right) => left.fromOutputTokens - right.fromOutputTokens,
    ),
  }));

  const byState: Record<string, number> = {};
  const byError: Record<string, number> = {};
  let total = 0;
  for (const row of gameRows.results) {
    total += row.games;
    byState[row.generation_state] = (byState[row.generation_state] ?? 0) + row.games;
    if (row.generation_error !== null) {
      byError[row.generation_error] = (byError[row.generation_error] ?? 0) + row.games;
    }
  }

  return {
    fromSeconds,
    toSeconds,
    baseSourceInputTokenCeiling: ceiling,
    outputTokenStrata: boundaries,
    groups: groups.sort(
      (left, right) =>
        left.modelKey.localeCompare(right.modelKey) ||
        (left.effort ?? '').localeCompare(right.effort ?? '') ||
        Number(left.withBaseSource) - Number(right.withBaseSource),
    ),
    games: { total, byState, byError },
  };
}
