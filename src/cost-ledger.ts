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
import { GENERATION_MODELS, findGenerationModel } from './generation-models.js';

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

  const result = await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${conflictClause}`,
  )
    .bind(
      id,
      entry.userId,
      entry.prompt,
      // **鍵を入れる。** 単価を引くのはこちらで、モデル ID は登録簿から引ける
      // （`GENERATION_MODELS`）。ID を入れると、単価を引くたびに ID → 鍵の対応表が
      // もう 1 つ要る。
      entry.generated.modelKey,
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
