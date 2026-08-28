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
 * 日次クォータ（確定25）で止まったことを表す分類名。**利用者への文言ではない。**
 *
 * 4.4 はこの状態に「本日の枠は終了しました」と**翌日の再開時刻**を求める。
 */
export const DAILY_QUOTA_REASON = 'daily-quota' as const;

/**
 * 月次上限（4.3）で止まったことを表す分類名。**利用者への文言ではない。**
 *
 * 4.4 はこの状態に「今月の生成は終了しました。プレイと共有は引き続きご利用いただけます」を
 * 求める。**日次とは別のメッセージである。** 「明日また使える」と「今月はもう使えないが
 * プレイはできる」は利用者にとって別の情報で、**混ぜると片方が必ず誤りになる。**
 */
export const MONTHLY_LIMIT_REASON = 'monthly-limit' as const;

/**
 * 拒否の理由。**利用者への文言ではない。**
 *
 * 経路層はこの値を 429 の応答へ**分類名として**載せる（`src/generate.ts` /
 * {@link describeQuotaRejection}）。**日次と月次では復帰の条件が違う**（前者は
 * 翌日 0 時、後者は翌月）ため、1 つにまとめない。
 */
export type QuotaRejectionReason = typeof DAILY_QUOTA_REASON | typeof MONTHLY_LIMIT_REASON;

/**
 * 応答へ載せてよい分類名の全体。
 *
 * **画面の文言表は、この一覧に対する網羅を機械で検査する**
 * （`test/generate-page.test.ts`）。理由を増やして文言を足し忘れると落ちる。
 */
export const QUOTA_REJECTION_REASONS: readonly QuotaRejectionReason[] = [
  DAILY_QUOTA_REASON,
  MONTHLY_LIMIT_REASON,
];

/**
 * その文字列が、応答へ載せてよい分類名か。
 *
 * **段は差し替えられる**（`src/generate.ts` の `GenerationPipeline['checkQuota']`）。
 * 差し替えた実装が返した文字列をそのまま応答へ流さないための関門である（8.3）。
 *
 * @param value 判定する文字列
 * @returns 分類名であれば true
 */
export function isQuotaRejectionReason(value: string): value is QuotaRejectionReason {
  return (QUOTA_REJECTION_REASONS as readonly string[]).includes(value);
}

/** クォータ超過を返すステータス（4.3 / 4.4。`src/generate.ts` が使う）。 */
export const QUOTA_EXCEEDED_STATUS = 429;

/**
 * 分類できなかったときに応答へ載せる値。
 *
 * **段が知らない理由を返しても、その文字列は応答へ出さない**（8.3。載せてよいのは
 * 時刻と固定の分類名だけである）。値を #132 より前の応答と同じにしてあるので、
 * 分類を持てない応答の形は変わらない。
 */
export const UNCLASSIFIED_QUOTA_CODE = 'quota exceeded';

/** 429 の応答本文（{@link describeQuotaRejection} が組み立てる）。 */
export interface QuotaExceededBody {
  /** 分類名。{@link QuotaRejectionReason} か {@link UNCLASSIFIED_QUOTA_CODE} のいずれか。 */
  readonly error: string;
  /**
   * 枠が戻る時刻（UNIX 秒）。**日次で止まったときだけ載る。**
   *
   * 4.4 の「翌日の再開時刻」である。値は {@link jstDayRange} の終端、すなわち
   * **JST の翌 0 時**（確定25）。
   */
  readonly resetsAt?: number;
}

/**
 * 拒否を 429 の応答本文へ落とす。
 *
 * **載せるのは固定の分類名と時刻だけである**（8.3）。分類名は {@link QUOTA_REJECTION_REASONS}
 * に載っている値に限り、当たらなければ {@link UNCLASSIFIED_QUOTA_CODE} へ倒す。
 *
 * **月次に再開時刻を載せない。** 4.4 が求めているのは日次に対する「翌日の再開時刻」で、
 * 月次に対しては「プレイと共有は継続できる」旨である。月次の復帰は翌月であり、
 * 同じ名前の項目で返すと、受け手が両者を同じものとして扱う口ができる。
 *
 * @param reason 段が返した拒否の理由（分類名とは限らない）
 * @param resetsAt 枠が戻る時刻（UNIX 秒。日次のときだけ意味を持つ）
 * @returns 429 の応答本文
 */
export function describeQuotaRejection(reason: string, resetsAt?: number): QuotaExceededBody {
  if (!isQuotaRejectionReason(reason)) {
    return { error: UNCLASSIFIED_QUOTA_CODE };
  }
  if (reason === DAILY_QUOTA_REASON && typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
    return { error: reason, resetsAt };
  }
  return { error: reason };
}

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

/**
 * 3.3-2 の判定結果。`src/generate.ts` の `QuotaDecision` が受けられる形である
 * （あちらは段を差し替えられるように `reason` を `string` で受ける）。
 *
 * **日次の拒否だけが `resetsAt` を持つ。** 4.4 が「翌日の再開時刻」を求めるのは
 * 日次に対してだけで、月次の復帰は翌月である。任意項目にして両方の枝へ付けると、
 * 「どちらのときに時刻があるか」が型から読めなくなる。
 */
export type QuotaCheckResult =
  | { readonly allowed: true; readonly warning?: MonthlyCostWarning }
  | {
      readonly allowed: false;
      readonly reason: typeof DAILY_QUOTA_REASON;
      /** 枠が戻る時刻（UNIX 秒）。JST の翌 0 時（{@link jstDayRange} の終端）。 */
      readonly resetsAt: number;
    }
  | { readonly allowed: false; readonly reason: typeof MONTHLY_LIMIT_REASON };

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
    //
    // **再開時刻を付けない。** 復帰は翌月で、4.4 がこの状態に求めているのは
    // 「プレイと共有は継続できる」旨である（日次の「翌日の再開時刻」ではない）。
    return { allowed: false, reason: MONTHLY_LIMIT_REASON };
  }

  // **日次は 1 人。** 月次を通ったときだけ読む。
  const daily = await readForDecision(() => dailyCallCount(env, userId, at));

  if (daily.calls >= DAILY_QUOTA_PER_USER) {
    // 確定25。**枠は JST の 0 時に戻る。** 12 回目までは通し、13 回目を止める。
    //
    // **戻る時刻をここで返す。** 4.4 は「翌日の再開時刻を示す」ことを求めており、
    // 値は日の範囲の終端としてすでに手元にある（`dailyCallCount`）。返さないと、
    // 経路層か画面が同じ境界をもう一度計算することになる（shared-ai-rules 12 章）。
    return { allowed: false, reason: DAILY_QUOTA_REASON, resetsAt: daily.resetsAt };
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
