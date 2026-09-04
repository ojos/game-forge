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
 * - **月次 2 万円はサービス全体の総額**である（4.3 / #284 で 1 万円から改訂）。
 *   利用者で絞らない。
 * - **日次 10 回は 1 人あたりの上振れの蓋**である（確定25 / #284 で 12 回から改訂）。
 *   合計しても月次上限を保証しない（招待者 30 人が毎日 10 回使えば 1 日 ¥6,723 で、
 *   **3 日で 2 万円に届く**——上限額を倍にしても、この関係は変わっていない）。
 *   **総額を止めるのは月次判定であり、両方を同じレバーで担わせない。**
 *
 * ## 累計はここで数え直さない
 *
 * **月次累計の集計は `src/cost-ledger.ts` の `monthlyCostTotals` が持つ**（#22）。
 * ここが持つのは**しきい値と、超過したときにどうするか**だけである。集計をこちらへ
 * 写すと、同じ「当月とは何か」の定義が 2 か所になり、片方だけが古くなる
 * （shared-ai-rules 12 章）。
 *
 * ## 警告は返すところまで（送るのはここではない）
 *
 * 4.3 は「80% で警告、100% で生成停止」と定める。**この層が持つのは判定だけで、
 * 誰にどう届けるかは持たない。**
 *
 * **宛先は運用者であり、利用者の画面には出さない**（#148 の決定）。80% は
 * サービス全体の月次費用に対する進捗で、個々の利用者の行動では変わらない。見せても
 * 利用者にできることが無く、4.4 が無くそうとしている「押しても動かないボタン」と
 * 同じ性質の情報になる。**送信の実装は `src/mail/cost-alert.ts`** で、この層からは
 * {@link monthlyCostWarning} を読むだけである（**費用を数え直さない**）。
 */
import { monthlyCostTotals } from './cost-ledger.js';

/**
 * 月次上限（円）。**4.3 の「上限額: 2万円/月」**（確定6 / #284 で改訂）。
 *
 * 仕様書側の記載との一致は `test/quota.test.ts` が {@link MONTHLY_LIMIT_PATTERN} で
 * 機械照合する。同じ数値が仕様書とコードの 2 か所にある以上、呼びかけでは守れない。
 *
 * ## 1 万円から 2 万円へ引き上げた（2026-09-04 / #284）
 *
 * **枠を決めた単価が実測の 2.3 分の 1 だった。** 4.3 の逆算は 4.2 の試算値 ¥9.9 で
 * 引かれていたが、**本番 33 件の実測では既定群 20 件の平均が ¥22.41**（直近 10 件は
 * ¥26.75）である。加えて #284 で上限を 64KB へ上げるため、**出力トークンに比例する
 * 費用はさらに上がる**（64KB が定着したときの単価は ¥75 の見込み）。
 *
 * **1 万円のままだと、日次枠より先に月次で止まる日が現実になる。** 上限額を上げるのは
 * 「使ってよい額を増やす」判断であって、4.3 の四層の構造は変えていない。
 */
export const MONTHLY_COST_LIMIT_JPY = 20_000;

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
 *
 * ## 12 回から 10 回へ減らした（2026-09-04 / #284）
 *
 * **枠は増えた月次上限（2 万円）と実測単価（¥22.41）から引き直した。**
 *
 *   20,000 ÷ 30 日 ＝ ¥667/日 ÷ ¥22.41 ＝ 約 29.7 回/日 ÷ 3 人 ＝ 9.9 → 切り上げ **10**
 *
 * **上限額を倍にしたのに枠が減るのは、旧値の分母（¥9.9）が実測の 2.3 分の 1
 * だったからである。**
 *
 * **「成功換算」で説明しない**（旧記述は 12 を「12 × 5/6 ＝ 10 本ちょうど」と説明して
 * いた）。理由は 2 つある。①**10 では成り立たない**（10 × 5/6 ＝ 8.3 本）。
 * ②**{@link MAX_GENERATION_ATTEMPTS} を 2 にしたので 5/6 という係数自体が動く**
 * ——あれは 3 試行を前提に測られた初回成功率であり、試行数を変えれば別の値になる。
 * **切り上げの理由は「9.9 は回数として使えない」ことだけで足りる。**
 *
 * **この 10 回は現在の実費 ¥22.41 からの逆算であって、64KB が定着したときの単価
 * ¥75 とは整合しない。** そのとき先に当たるのは月次上限（2 万円）のほうである
 * （{@link MONTHLY_COST_LIMIT_JPY}）。**日次枠は 1 人あたりの上振れの蓋であって、
 * 総額の蓋ではない**——その分担は変えていない。
 */
export const DAILY_QUOTA_PER_USER = 10;

/**
 * 1 作品あたりの推敲回数の上限（5.7 / 確定28）。
 *
 * **{@link DAILY_QUOTA_PER_USER} とは軸が違う。** あちらは 1 人・1 日で、こちらは
 * 1 作品・生涯である。**両方を満たさなければ推敲できない**——日次枠が残っていても
 * その作品の上限に達していれば断り、逆も同じ。
 *
 * **なぜ日次枠の共有だけでは足りないのか。** 5.7 のとおり、共有だけだと**1 人が
 * 1 本へ日次枠のすべて（10 回）を注ぎ込める。** 4.3 の逆算では全体で 1 日 約 29.7 回
 * であり（4.4 の注記）、
 * そこが 1 日に生まれる作品数の天井である。推敲が天井を食う量に蓋が無いと、
 * 10.1 が測ろうとしているフォークの母集団そのものが痩せる。
 *
 * **数えるのは推敲という行為であって、版の数ではない。** 失敗した推敲は版を積まない
 * が費用は出ている（1 回 約 16 円）。版で数えると失敗がただでやり直せる。確定25 が
 * 「リトライは含む」としているのと同じ線で、`games.revise_count` が回数を持つ
 * （`migrations/0009_game_revisions.sql`）。
 *
 * **暫定値である。** 5.7 は「10.2 の『1 作品あたりの推敲回数』で観測して見直す」と
 * 定めており、**推敲が作品数を圧迫していないかを調整できる唯一のつまみ**がこれである。
 */
export const REVISIONS_PER_GAME = 3;

/**
 * JST の UTC からの差（秒）。日本は夏時間を持たないため固定でよい。
 *
 * **`src/cost-ledger.ts` も同じ値を持つ。** 物理定数（UTC+9）であって方針の値では
 * ないため写しを持つことを許すが、**境界の切り方がずれていないことは機械で確かめる**
 * （`test/quota.test.ts` が「月の境界は日の境界でもある」を照合する）。
 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/**
 * 仕様書のうち、**現行値を宣言している部分**だけを取り出す（テストが照合に使う）。
 *
 * # なぜ要るのか（#284）
 *
 * しきい値の照合パターン（{@link MONTHLY_LIMIT_PATTERN} など）は本文を端から走査し、
 * **拾ったすべてが定数と一致することを求める。** ところがこの仕様書は
 * **「覆った前提は覆ったと分かる形で残す」** 方針で書かれており、**過去の値が本文に
 * 残り続ける。** 両者をそのままぶつけると、**値を変えた日に「過去の記録」が照合を
 * 落とす**——そして落ちたときにいちばん安い直しかたは、**記録の文面を書き換えて
 * パターンから逃がすこと**になる。
 *
 * **それは向きが逆である。** 照合は「仕様書とコードの現行値がずれていないこと」を
 * 見る機構であって、**過去の記録を消させるための機構ではない。** #284 で実際に
 * 1.2.19（「日次クォータを 1 人 1 日 12 回と決めた」）の文面を言い回しごと変えて
 * 逃がしかけた。**逃がした形は、次に誰かが同じ書き方をしたときに黙って壊れる**
 * （なぜその言い回しなのかが本文からは読めない）。
 *
 * **そこで、逃がす対象を文面ではなく「範囲」で表す。** 除くのは次の 2 つだけで、
 * どちらも**この仕様書が既に使っている表記上の約束**である。
 *
 * 1. **1 章（エグゼクティブサマリー）。** 中身は `1.2.x` の版ごとの変更記録で、
 *    **構造的に「過去の状態の記録」しか入らない**（見出しがすべて
 *    「vX.Y からの主要な変更」である）。現行値の宣言は 4.3 / 4.4 / 12 章にある。
 * 2. **取り消し線（`~~…~~`）で囲まれた部分。** この仕様書は覆った記述をこの形で
 *    残す（4.3 の逆算、確定6、確定25 などが実際にそうしている）。**書き手が
 *    「これはもう現行ではない」と明示した部分**なので、照合の対象から外してよい。
 *
 * **どちらも「書き換えれば通る」ではなく「印を付ければ外れる」形である。** 次に
 * 同じ状況へ来た人は、記録を消すのではなく**取り消し線を引く**——それがこの
 * 仕様書の作法そのものなので、追加で覚えることが無い。
 *
 * **範囲を広げすぎていないことは `test/quota.test.ts` が確かめる**（現行の宣言を
 * 誤った値へ変異させたら、ちゃんと落ちること）。
 *
 * @param spec 仕様書の本文
 * @returns 現行値を宣言している部分だけを残した本文
 */
export function currentDeclarationsIn(spec: string): string {
  // 1 章（版ごとの変更記録）を落とす。**次の `## ` 見出しまで**で、見つからなければ
  // 何も落とさない（構成が変わったことに気づけるよう、黙って全部を捨てない）。
  const chapterOne = spec.indexOf('\n## 1. ');
  const chapterTwo = spec.indexOf('\n## 2. ');
  const withoutHistory =
    chapterOne >= 0 && chapterTwo > chapterOne
      ? spec.slice(0, chapterOne) + spec.slice(chapterTwo)
      : spec;
  // 取り消し線で囲まれた部分を落とす（複数行にまたがる span も対象にする）。
  return withoutHistory.replace(/~~[\s\S]*?~~/gu, '');
}

/** 仕様書が月次上限を宣言している文の形（テストが照合に使う）。 */
export const MONTHLY_LIMIT_PATTERN = /上限(?:額)?[:：\s]*([0-9]+)\s*万円/gu;

/** 仕様書が日次クォータを宣言している文の形（テストが照合に使う）。 */
export const DAILY_QUOTA_PATTERN =
  /1 ?(?:人|利用者)(?:あたり)?[・ ]?・?1 ?(?:日|暦日)(?:あたり)? ?\*{0,2}([0-9]+) ?回/gu;

/**
 * 仕様書が 1 作品あたりの推敲上限を宣言している文の形（テストが照合に使う）。
 *
 * **{@link DAILY_QUOTA_PATTERN} と重ならない形にしてある。** あちらは「1 人・1 日」を
 * 要求するので「1 作品あたり」には当たらない。2 つの上限が同じ正規表現に拾われると、
 * 片方の値を変えたときにもう片方の照合が黙って通る。
 */
export const REVISIONS_PER_GAME_PATTERN =
  /1 ?作品(?:あたり)?の推敲は ?\*{0,2}([0-9]+) ?回まで/gu;

/** 仕様書が警告と停止のしきい値を宣言している文の形（テストが照合に使う）。 */
export const WARNING_THRESHOLD_PATTERN = /\*\*([0-9]+)% で警告、([0-9]+)% で生成停止/gu;

/**
 * 4.4 の「本日の残り生成枠 N回」を組み立てる。
 *
 * **数える単位は「費用の出る LLM 呼び出し回数」である**（確定25 / `src/quota.ts` の
 * `DAILY_QUOTA_PER_USER`）。成功した作品の本数ではないので、失敗した試行でも減る。
 * その理由は 422 の文言が言う（{@link GENERATE_MESSAGES}）。
 *
 * @param remaining 本日の残り回数
 * @returns 画面へ出す文言
 */
export function remainingQuotaNotice(remaining: number): string {
  // 値は `src/quota.ts` が数えた回数なので、負にも小数にもならない。**それでも
  // 描く前に整数へ倒す。** 表示は最後の砦で、上流が変わったときに壊れた形の文字列を
  // 利用者へ出すより、丸めた数を出すほうが害が小さい。
  return `本日の残り生成枠 ${Math.max(0, Math.trunc(remaining))}回`;
}

/**
 * 残枠を確認できなかったときの文言。
 *
 * **「残り 0 回」とも「まだ使えます」とも言わない。** 集計が読めなかっただけで、
 * 枠が尽きたわけではない（`src/quota.ts` の `readForDecision` は握りつぶさずに
 * 投げ直す）。**フォームは描く。** 押せば API 側が同じ判定をやり直し、断られれば
 * 429 の文言が出る。
 */
export const QUOTA_UNKNOWN_NOTICE =
  '本日の残り生成枠を確認できませんでした。生成そのものは試せますが、' +
  '枠が残っていない場合は送信後に断られます。';

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
 * 応答へ載せてよい再開時刻か。
 *
 * **分類名と同じ扱いである。** 段（`GenerationPipeline['checkQuota']`）は差し替え
 * られるので、`resetsAt` も「段が返した値」であって、契約を満たしている保証は無い。
 * 分類名を一覧で絞っているのに数値を素通しすると、**同じ原則が片方だけ抜ける。**
 *
 * 契約は「**枠が戻る時刻を表す UNIX 秒の整数**」である。したがって
 * 0 以下（時刻として意味を成さない）・小数（秒でない）・`Number.isSafeInteger` の
 * 外（桁あふれ。JSON へ出しても復元できない）は載せない。
 *
 * **推測で直さない。** 丸めたり現在時刻で埋めたりすると、利用者へ嘘の時刻を見せる
 * ことになる。**載せなくても日次の文言は変わらない**（画面が出す「翌日 0 時」は
 * 固定文字列で、枠が戻るのは常に JST の 0 時である。`src/generate-page.ts`）。
 *
 * @param value 段が返した再開時刻
 * @returns 応答へ載せてよければ true
 */
function isResetTimestamp(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 拒否を 429 の応答本文へ落とす。
 *
 * **載せるのは固定の分類名と時刻だけである**（8.3）。分類名は {@link QUOTA_REJECTION_REASONS}
 * に載っている値に限り、当たらなければ {@link UNCLASSIFIED_QUOTA_CODE} へ倒す。
 * **時刻も同じ扱いで絞る**（{@link isResetTimestamp}）。段が返す値である以上、
 * 契約を満たさない数値は載せない。
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
  if (reason === DAILY_QUOTA_REASON && isResetTimestamp(resetsAt)) {
    return { error: reason, resetsAt };
  }
  return { error: reason };
}

/**
 * 月次上限の 80% に到達したことを表す警告（4.3）。
 *
 * **受け取るのは運用者だけである**（#148）。利用者の画面には出さない（モジュール冒頭）。
 * ここは判定結果として返すだけで、送信は `src/mail/cost-alert.ts` が持つ。
 *
 * **利用者を特定する値を持たない。** 月次はサービス全体の累計で（4.3）、通知の本文へ
 * そのまま写しても 8.1 の個人情報が混ざらない形にしてある。
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
 * 当月の累計から 80% 警告を導く（4.3）。**しきい値を持つのはこの 1 か所である。**
 *
 * **累計を引かない。** 引数で受け取る。集計の実体は `src/cost-ledger.ts` の
 * `monthlyCostTotals` が持ち（#22）、同じ「当月とは何か」の定義を 2 か所に作らない
 * （shared-ai-rules 12 章）。
 *
 * **100% 側でも警告は立つ。** 80% 以上であることが条件で、上限に達したかどうかは
 * 別の判定である（{@link generationQuotaStatus} は停止の枝で警告を返さないが、それは
 * 「止まっている利用者に警告を見せない」ためであって、警告が消えるからではない）。
 *
 * @param costJpy 当月（JST）の累計（円）
 * @returns 80% 以上なら警告、そうでなければ null
 */
export function monthlyCostWarningOf(costJpy: number): MonthlyCostWarning | null {
  const ratio = costJpy / MONTHLY_COST_LIMIT_JPY;
  if (ratio < MONTHLY_WARNING_RATIO) {
    return null;
  }
  return { kind: 'monthly-cost', costJpy, limitJpy: MONTHLY_COST_LIMIT_JPY, ratio };
}

/**
 * いま 80% 警告が立っているかを、当月の累計から判定する（4.3 / #148）。
 *
 * **通知の側（`src/mail/cost-alert.ts`）が読む口である。** 通知が独自に費用を数えると、
 * 同じ「当月とは何か」が 2 か所になり、片方だけが古くなる。**判定はここ、集計は台帳、
 * 送信は通知**という分担を崩さない。
 *
 * **日次は読まない。** 月次はサービス全体の進捗で、利用者を引数に取らない
 * （{@link generationQuotaStatus} は生成の可否を返すので日次も読むが、こちらは別物である）。
 *
 * @param env バインディングと環境変数
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 80% 以上なら警告、そうでなければ null
 * @throws 集計を読めなかったとき（{@link readForDecision} が投げ直す）
 */
export async function monthlyCostWarning(
  env: Env,
  at: number = Math.floor(Date.now() / 1000),
): Promise<MonthlyCostWarning | null> {
  const monthly = await readForDecision(() => monthlyCostTotals(env, at));
  return monthlyCostWarningOf(monthly.costJpy);
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
 * 表示のための枠の状態（4.4 / #24）。
 *
 * **{@link QuotaCheckResult} と役割が違う。** あちらは 3.3-2 の段が「通すか止めるか」を
 * 返す形で、**残りが何回あるかを持たない**（判定には要らないためである）。4.4 が求める
 * 「本日の残り生成枠 N回」の**常時表示**には、止まっていないときの残数が要る。
 *
 * **同じ集計を 2 か所で書かない。** 判定（{@link checkGenerationQuota}）はこの状態から
 * 導く。別々に数えると、画面が「残り 3 回」と出しているのに API が断る、という食い違いが
 * 起こりうる（shared-ai-rules 12 章）。
 */
export type GenerationQuotaStatus =
  | {
      readonly kind: 'available';
      /**
       * 本日（JST）の残り回数。**必ず 1 以上**である。
       *
       * 0 になった状態は「まだ生成できる」ではないので、{@link DAILY_QUOTA_REASON} の
       * 枝へ移る。残数 0 を `available` で表せる形にすると、表示側が「残り 0 回」と
       * 出しながら押せるボタンを描く経路ができる（4.4 が塞ごうとしているものである）。
       */
      readonly remaining: number;
      /** 80% 警告（4.3）。表示するかどうかは呼び出し側が決める。 */
      readonly warning?: MonthlyCostWarning;
    }
  | {
      readonly kind: typeof DAILY_QUOTA_REASON;
      /** 枠が戻る時刻（UNIX 秒）。JST の翌 0 時（{@link jstDayRange} の終端）。 */
      readonly resetsAt: number;
    }
  | { readonly kind: typeof MONTHLY_LIMIT_REASON };

/**
 * いまの枠の状態を求める（4.3 / 確定25）。**判定と表示の両方がここから読む。**
 *
 * **月次を先に見る。** 月次上限はサービス全体の停止で、日次クォータは 1 人あたりの
 * 蓋である。全体が止まっているときに「あなたの本日の枠は残っています」と読める状態を
 * 返しても意味がなく、4.4 の文言（「今月の生成は終了しました」）とも合わない。
 *
 * **月次で止まったら日次は読まない**（#122 のレビュー指摘）。**D1 は読み取りも従量
 * である**（3.6）。サービス全体が停止している間は生成のたびにこの段へ入るので、
 * **止まっている間ほど無駄な読み取りが積み上がる。** 「先に判定する」は「先に読む」
 * ではない。
 *
 * @param env バインディングと環境変数
 * @param userId 対象の利用者
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @returns 枠の状態。生成できるときは残り回数を伴う
 * @throws 集計を読めなかったとき（{@link readForDecision} が投げ直す）
 */
export async function generationQuotaStatus(
  env: Env,
  userId: string,
  at: number = Math.floor(Date.now() / 1000),
): Promise<GenerationQuotaStatus> {
  // **月次はサービス全体。** 集計の実体は #22 の台帳が持つ。
  const monthly = await readForDecision(() => monthlyCostTotals(env, at));

  if (monthly.costJpy >= MONTHLY_COST_LIMIT_JPY) {
    // 4.3「100% で生成停止」。停止するのは生成だけで、プレイと拡散は続く（4.4 / 3.8）。
    // **ここで返る経路は D1 を 1 回しか読まない。**
    //
    // **再開時刻を持たない。** 復帰は翌月で、4.4 がこの状態に求めているのは
    // 「プレイと共有は継続できる」旨である（日次の「翌日の再開時刻」ではない）。
    return { kind: MONTHLY_LIMIT_REASON };
  }

  // **日次は 1 人。** 月次を通ったときだけ読む。
  const daily = await readForDecision(() => dailyCallCount(env, userId, at));

  if (daily.calls >= DAILY_QUOTA_PER_USER) {
    // 確定25。**枠は JST の 0 時に戻る。** `DAILY_QUOTA_PER_USER` 回目までは通し、
    // その次を止める（`>=` である）。**回数をここに書き写さない**——#284 で
    // 12 → 10 へ動いたとき、書いていたらこの行が古くなっていた。
    //
    // **戻る時刻をここで返す。** 4.4 は「翌日の再開時刻を示す」ことを求めており、
    // 値は日の範囲の終端としてすでに手元にある（{@link dailyCallCount}）。返さないと、
    // 経路層か画面が同じ境界をもう一度計算することになる（shared-ai-rules 12 章）。
    return { kind: DAILY_QUOTA_REASON, resetsAt: daily.resetsAt };
  }

  // **台帳の行数から引く。** 数える単位が「費用の出る LLM 呼び出し」である以上
  // （{@link DAILY_QUOTA_PER_USER}）、残数もその単位で出る。4.4 の「残り N回」は
  // 成功した作品の本数ではない。
  const remaining = DAILY_QUOTA_PER_USER - daily.calls;
  // **しきい値の判定は {@link monthlyCostWarningOf} が持つ。** 通知（#148）も同じ
  // 関数から警告を得るので、80% の意味が画面側と通知側で割れない。
  const warning = monthlyCostWarningOf(monthly.costJpy);
  return warning === null
    ? { kind: 'available', remaining }
    : { kind: 'available', remaining, warning };
}

/**
 * 3.3-2 の段（`GenerationPipeline['checkQuota']`）の実装。
 *
 * **判定そのものは {@link generationQuotaStatus} が持つ。** ここがするのは、その状態を
 * 段の契約（{@link QuotaCheckResult}）へ写すことだけである。**集計と順序をこちらへ
 * 書き戻さない**（画面が出す残数と、API が通す・断るの判断が、別々の数え方に分かれる）。
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
  const status = await generationQuotaStatus(env, userId, at);

  if (status.kind === MONTHLY_LIMIT_REASON) {
    return { allowed: false, reason: MONTHLY_LIMIT_REASON };
  }
  if (status.kind === DAILY_QUOTA_REASON) {
    return { allowed: false, reason: DAILY_QUOTA_REASON, resetsAt: status.resetsAt };
  }
  // **警告が無いときは項目そのものを持たせない。** `warning: undefined` を付けると、
  // 「警告が無い」と「警告の値が未定義」が同じ形になる。
  return status.warning === undefined
    ? { allowed: true }
    : { allowed: true, warning: status.warning };
}
