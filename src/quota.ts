/**
 * 日次クォータと月次上限の判定（3.3-2 / 4.3 層 1 / 確定25 / #23）。
 *
 * **3.3 の順序で、生成（3.3-3）の手前に置かれる唯一の費用ガードである。** 4.3 は上限を
 * 四層で担保するが、層 2（CloudWatch）と層 3（Budgets）は遅れを持つ検知であり、
 * **「LLM を呼ぶ前に止める」ことができるのはこの層だけ**である。したがってこの判定を
 * 通過しないかぎり Bedrock は呼ばれない、という関係を壊さないこと。
 *
 * ## 2 つの上限は役割が違う
 *
 * - **月次 1 万円はサービス全体の総額**である（4.3）。利用者で絞らない。
 * - **日次 12 回は 1 人あたりの上振れの蓋**である（確定25）。合計しても月次上限を保証
 *   しない（招待者 30 人が毎日 12 回使えば 3 日で 1 万円に届く）。**総額を止めるのは
 *   月次判定であり、両方を同じレバーで担わせない。**
 *
 * ## 累計はここで数え直さない
 *
 * **月次累計の集計は `src/cost-ledger.ts` の `monthlyCostTotals` が持つ**（#22）。
 * ここが持つのは**しきい値と、超過したときにどうするか**だけである。集計をこちらへ
 * 写すと、同じ「当月とは何か」の定義が 2 か所になり、片方だけが古くなる
 * （shared-ai-rules 12 章）。
 *
 * ## 警告は返すところまで
 *
 * 4.3 は「80% で警告、100% で生成停止」と定めるが、**警告を画面へ出すのは 4.4 の範囲
 * （#24 / M3-3）である。** この層は判定結果に警告を載せて返すところまでを持つ。
 * 使われない段を先に作らないため、通知や表示の口はここに作らない。
 */
import { monthlyCostTotals } from './cost-ledger.js';

/**
 * 月次上限（円）。**4.3 の「上限額: 1万円/月」**（確定6）。
 *
 * 仕様書側の記載との一致は `test/quota.test.ts` が {@link MONTHLY_LIMIT_PATTERN} で
 * 機械照合する。同じ数値が仕様書とコードの 2 か所にある以上、呼びかけでは守れない。
 */
export const MONTHLY_COST_LIMIT_JPY = 10_000;

/**
 * 警告を出す割合。**4.3 の「80% で警告、100% で生成停止」**。
 *
 * 停止側（100%）は {@link MONTHLY_COST_LIMIT_JPY} そのものなので定数を分けない。
 */
export const MONTHLY_WARNING_RATIO = 0.8;

/**
 * 1 利用者・1 暦日あたりの生成回数（確定25）。
 *
 * **数える単位は「費用の出る LLM 呼び出し回数」である。** 台帳（`generations`）は
 * その単位で 1 行を作る（4.3 の記録規約）ので、**行数を数えることが仕様どおりに
 * 数えることになる。** リトライによる再生成は行が増えるので数に入り、費用ゼロの
 * 機械修正（4.2）は行を作らないので数えない。
 */
export const DAILY_QUOTA_PER_USER = 12;

/**
 * JST の UTC からの差（秒）。日本は夏時間を持たないため固定でよい。
 *
 * **`src/cost-ledger.ts` も同じ値を持つ。** 物理定数（UTC+9）であって方針の値では
 * ないため写しを持つことを許すが、**境界の切り方がずれていないことは機械で確かめる**
 * （`test/quota.test.ts` が「月の境界は日の境界でもある」を照合する）。
 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/** 仕様書が月次上限を宣言している文の形（テストが照合に使う）。 */
export const MONTHLY_LIMIT_PATTERN = /上限(?:額)?[:：\s]*([0-9]+)\s*万円/gu;

/** 仕様書が日次クォータを宣言している文の形（テストが照合に使う）。 */
export const DAILY_QUOTA_PATTERN =
  /1 ?(?:人|利用者)(?:あたり)?[・ ]?・?1 ?(?:日|暦日)(?:あたり)? ?\*{0,2}([0-9]+) ?回/gu;

/** 仕様書が警告と停止のしきい値を宣言している文の形（テストが照合に使う）。 */
export const WARNING_THRESHOLD_PATTERN = /\*\*([0-9]+)% で警告、([0-9]+)% で生成停止/gu;

/**
 * 拒否の理由。**利用者への文言ではない。**
 *
 * 経路層は 4.4 に従って 429 と共通の文言を返す（`src/generate.ts`）。この値は
 * どちらの上限で止まったかを後段とログが区別するためのもので、**日次と月次では
 * 復帰の条件が違う**（前者は翌日 0 時、後者は翌月）ため、1 つにまとめない。
 */
export type QuotaRejectionReason = 'daily-quota' | 'monthly-limit';

/**
 * 月次上限の 80% に到達したことを表す警告（4.3 / 4.4）。
 *
 * **表示は #24（M3-3）の範囲である。** ここは判定結果として返すだけで、通知も
 * 画面も持たない。
 */
export interface MonthlyCostWarning {
  readonly kind: 'monthly-cost';
  /** 当月（JST）の累計（円）。 */
  readonly costJpy: number;
  /** 上限（円）。 */
  readonly limitJpy: number;
  /** 上限に対する割合。{@link MONTHLY_WARNING_RATIO} 以上のときだけこの警告が立つ。 */
  readonly ratio: number;
}

/**
 * ある時刻が属する JST の暦日の範囲を返す。
 *
 * **境界は JST の 0 時とする**（確定25）。UTC 0 時にすると日本時間の午前 9 時に枠が
 * 戻り、4.4 が示す「翌日の再開時刻」が利用者の「明日」と一致しない。月次側も JST で
 * 切っている（4.3 の記録規約 / `src/cost-ledger.ts`）ので、日と月で基準が割れることもない。
 *
 * @param at 基準時刻（UNIX 秒）
 * @returns 半開区間 `[fromSeconds, toSeconds)`
 */
export function jstDayRange(at: number): {
  readonly fromSeconds: number;
  readonly toSeconds: number;
} {
  // JST の壁時計を UTC のまま読むために、先に 9 時間ぶん進めてから UTC で解釈する。
  const jstWallClock = new Date((at + JST_OFFSET_SECONDS) * 1000);
  const midnightUtc =
    Date.UTC(
      jstWallClock.getUTCFullYear(),
      jstWallClock.getUTCMonth(),
      jstWallClock.getUTCDate(),
    ) / 1000;
  const fromSeconds = midnightUtc - JST_OFFSET_SECONDS;
  return { fromSeconds, toSeconds: fromSeconds + 24 * 60 * 60 };
}

/**
 * ある利用者が、その暦日（JST）に費やした LLM 呼び出しの回数を数える。
 *
 * **成否を問わない。** 4.3 が「成功・失敗・リトライを問わず全件」記録すると定めて
 * いるのは、**失敗した呼び出しにも課金が発生している**からで、枠を数えるときだけ
 * 成功に限ると、失敗を繰り返すだけで枠が減らない経路ができる。
 *
 * @param env バインディングと環境変数
 * @param userId 数える利用者
 * @param at 基準時刻（UNIX 秒）
 * @returns 当日（JST）の呼び出し回数と、枠が戻る時刻
 */
export async function dailyCallCount(
  env: Env,
  userId: string,
  at: number,
): Promise<{ readonly calls: number; readonly resetsAt: number }> {
  const day = jstDayRange(at);
  // 索引は `generations(user_id, created_at)`（`migrations/0005_*`）。
  const row = await env.DB.prepare(
    `select count(*) as calls
       from generations
      where user_id = ? and created_at >= ? and created_at < ?`,
  )
    .bind(userId, day.fromSeconds, day.toSeconds)
    .first<{ calls: number }>();
  return { calls: row?.calls ?? 0, resetsAt: day.toSeconds };
}

/** 3.3-2 の判定結果。`src/generate.ts` の `QuotaDecision` と同じ形である。 */
export type QuotaCheckResult =
  | { readonly allowed: true; readonly warning?: MonthlyCostWarning }
  | { readonly allowed: false; readonly reason: QuotaRejectionReason };

/**
 * 判定に要る集計を 1 つ読む。**例外を握りつぶさない。**
 *
 * D1 の読み取りが失敗したときに「判定できなかったので許可する」を選ぶと、4.3 の上限が
 * D1 の不調で静かに開く。ログを残して投げ直し、経路層に 500 を返させる（＝生成は
 * 行われない）。**迷ったら止まる側へ倒す**のは、台帳が「迷ったら高い側へ倒す」のと
 * 同じ理由である。
 *
 * @param read 集計を引く処理
 * @returns 集計の結果
 */
async function readForDecision<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    // **利用者のプロンプトも生成物もここには無い。** 出すのは例外の種類だけにする
    // （`src/generate.ts` の `describeGenerateError` と同じ方針）。
    console.error(
      `[quota] 判定に必要な集計を取得できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    throw error;
  }
}

/**
 * 3.3-2 の段（`GenerationPipeline['checkQuota']`）の実装。
 *
 * **月次を先に見る。** 月次上限はサービス全体の停止で、日次クォータは 1 人あたりの
 * 蓋である。全体が止まっているときに「あなたの本日の枠は残っています」と読める理由を
 * 返しても意味がなく、4.4 の文言（「今月の生成は終了しました」）とも合わない。
 *
 * **月次で止まったら日次は読まない**（#122 のレビュー指摘）。**D1 は読み取りも従量
 * である**（3.6）。サービス全体が停止している間は生成が来るたびにこの段へ入るので、
 * **止まっている間ほど無駄な読み取りが積み上がる。** 「先に判定する」は「先に読む」
 * ではない。
 *
 * @param env バインディングと環境変数
 * @param userId 生成しようとしている利用者
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 判定結果。許可のときは 80% 警告を伴うことがある
 */
export async function checkGenerationQuota(
  env: Env,
  userId: string,
  at: number = Math.floor(Date.now() / 1000),
): Promise<QuotaCheckResult> {
  // **月次はサービス全体。** 集計の実体は #22 の台帳が持つ。
  const monthly = await readForDecision(() => monthlyCostTotals(env, at));

  if (monthly.costJpy >= MONTHLY_COST_LIMIT_JPY) {
    // 4.3「100% で生成停止」。停止するのは生成だけで、プレイと拡散は続く（4.4 / 3.8）。
    // **ここで返る経路は D1 を 1 回しか読まない。**
    return { allowed: false, reason: 'monthly-limit' };
  }

  // **日次は 1 人。** 月次を通ったときだけ読む。
  const daily = await readForDecision(() => dailyCallCount(env, userId, at));

  if (daily.calls >= DAILY_QUOTA_PER_USER) {
    // 確定25。**枠は JST の 0 時に戻る。** 12 回目までは通し、13 回目を止める。
    return { allowed: false, reason: 'daily-quota' };
  }

  const ratio = monthly.costJpy / MONTHLY_COST_LIMIT_JPY;
  if (ratio >= MONTHLY_WARNING_RATIO) {
    return {
      allowed: true,
      warning: {
        kind: 'monthly-cost',
        costJpy: monthly.costJpy,
        limitJpy: MONTHLY_COST_LIMIT_JPY,
        ratio,
      },
    };
  }
  return { allowed: true };
}
