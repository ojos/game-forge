/**
 * 費用 80% の警告を運用者へ送る（4.3 / #148）。
 *
 * ## 利用者へは出さない
 *
 * **80% はサービス全体の月次費用に対する進捗であり、個々の利用者の行動では変わらない。**
 * 見せても利用者にできることが無く、4.4 が無くそうとしている「押しても動かないボタン」と
 * 同じ性質の情報になる。**受け取るべきは運用者で、経路はメールである**（#148 の決定）。
 *
 * 画面へ出ていないことは検査で担保する（`test/cost-alert.test.ts`）。呼びかけで
 * 守らない（shared-ai-rules 12 章）。
 *
 * ## 費用を数え直さない
 *
 * 判定は `src/quota.ts` の {@link monthlyCostWarning} が持ち、集計は
 * `src/cost-ledger.ts` の `monthlyCostTotals` が持つ（#22）。**このモジュールは
 * どちらも作り直さない。** 同じ「当月とは何か」が 2 か所にあると片方だけが古くなる
 * （#24 が残枠で踏んだのと同じ問題）。
 *
 * ## 重複送信の抑止
 *
 * **超えている間は生成のたびにこの判定へ入る。** 抑止が無ければ、80% を超えた月は
 * 残りの生成回数だけ通知が出て、Resend の 100 通/日を食う（`src/mail/resend.ts` の
 * 見積もり表）。
 *
 * **月ごとの目印を R2 へ置き、「無いときだけ書く」で 1 通に絞る。**
 *
 * - 鍵は `notifications/monthly-cost-warning/<YYYY-MM>`（JST の暦月。`jstMonthRange`）
 * - 書き込みは条件付き（`onlyIf: { etagDoesNotMatch: '*' }`）。**既にあれば null が返る**
 * - 先に目印を取ってから送る。**取れなかった側は送らない**
 *
 * **D1 に列を足さない。** 抑止のためだけにスキーマを動かすと、本番 D1 のマイグレーション
 * （手作業。`docs/pages-deploy.md`）を 1 回増やすことになる。R2 には年齢で消す
 * ライフサイクルが無い（`terraform/r2-lifecycle.tf`）ので、置いた目印はその月のあいだ残る。
 *
 * **読み書きは 80% を超えている間だけ発生する。** 超えていなければ判定で降りるので、
 * 通常の月は R2 を 1 度も触らない。
 *
 * ## 送信そのものが失敗したとき
 *
 * **受け付けられなかった（`unreachable`）ときだけ目印を戻す。** 送り直せば通る種類の
 * 失敗なので、次の生成でもう一度試させる。**拒否（`rejected`）では戻さない**——同じ
 * 内容は何度送っても断られ、生成のたびに Resend を叩くだけになる。どちらもログには残す。
 */
import { jstMonthRange } from '../cost-ledger.js';
import type { MonthlyCostWarning } from '../quota.js';
import { MONTHLY_COST_LIMIT_JPY, MONTHLY_WARNING_RATIO, monthlyCostWarning } from '../quota.js';
import type { MailDeps, MailMessage, MailOutcome } from './resend.js';
import { defaultMailDeps, formatJpy, mailConfigOf, sendMail } from './resend.js';

/**
 * 目印を置く R2 の接頭辞。
 *
 * **成果物の接頭辞（`builds/`）と分ける。** 3.7 の掃除（M5-4）が作品の成果物を
 * 走査するとき、通知の目印を作品の残骸と取り違えないようにする。
 */
export const COST_ALERT_MARKER_PREFIX = 'notifications/monthly-cost-warning/';

/** ログに出す、この通知の固定の名前（宛先や本文の代わりに使う）。 */
const LABEL = 'monthly-cost-warning';

/**
 * この通知の結末。**呼び出し元はログと検査のためにだけ使う。**
 *
 * - `sent`: 送った（その月の 1 通目）
 * - `below-threshold`: 80% に達していない
 * - `already-sent`: その月は送信済み（目印がある）
 * - `not-configured`: 送信の設定が無い（ローカル・テスト）
 * - `send-failed`: 送信に失敗した
 */
export type CostAlertOutcome =
  | 'sent'
  | 'below-threshold'
  | 'already-sent'
  | 'not-configured'
  | 'send-failed';

/** 差し替えできる依存（{@link MailDeps} と同じ理由）。 */
export interface CostAlertDeps extends MailDeps {
  /** 送信そのもの。テストは送信の手前で止めるためにここを差し替える。 */
  readonly send: (
    env: Env,
    message: MailMessage,
    label: string,
    deps: MailDeps,
  ) => Promise<MailOutcome>;
}

/** 既定の依存（本物の送信）。 */
export const defaultCostAlertDeps: CostAlertDeps = {
  ...defaultMailDeps,
  send: sendMail,
};

/**
 * その月の目印の鍵を組み立てる。
 *
 * **暦月の切り方は台帳と同じ**（`jstMonthRange`。JST 境界。4.3 の記録規約）。
 * ここで別の切り方をすると、月初の 9 時間だけ前月の目印が効く。
 *
 * @param at 基準時刻（UNIX 秒）
 * @returns R2 の鍵
 */
export function costAlertMarkerKey(at: number): string {
  const { year, month } = jstMonthRange(at);
  return `${COST_ALERT_MARKER_PREFIX}${year}-${`${month}`.padStart(2, '0')}`;
}

/**
 * 運用者へ送る本文を組み立てる。
 *
 * **利用者を特定する値を入れない。** 月次はサービス全体の累計であり
 * （`src/quota.ts` の {@link MonthlyCostWarning}）、誰の生成で超えたかは通知の目的
 * （＝上限へ近づいていることを知る）に要らない。
 *
 * **宛先はここに書かない**（設定として持つ。`src/env.d.ts` の `OPERATOR_EMAIL`）。
 *
 * @param warning 80% 警告
 * @param at 判定時刻（UNIX 秒）
 * @returns 件名と本文
 */
export function costAlertMessage(
  warning: MonthlyCostWarning,
  at: number,
): { readonly subject: string; readonly text: string } {
  const { year, month } = jstMonthRange(at);
  const percent = (warning.ratio * 100).toFixed(1);
  const threshold = Math.round(MONTHLY_WARNING_RATIO * 100);
  return {
    subject: `[Game Forge] 月次費用が上限の ${threshold}% を超えました`,
    text: [
      `サービス全体の月次費用が、上限の ${threshold}% を超えました。`,
      '',
      `対象月: ${year}-${`${month}`.padStart(2, '0')}（JST）`,
      `累計: ${formatJpy(warning.costJpy)} 円`,
      `上限: ${formatJpy(warning.limitJpy)} 円`,
      `到達率: ${percent}%`,
      '',
      `上限（${formatJpy(MONTHLY_COST_LIMIT_JPY)} 円）に達すると、新規の生成は自動的に停止します。`,
      'プレイと共有は停止しません。',
      '',
      'この通知は 1 か月につき 1 通です。',
    ].join('\n'),
  };
}

/**
 * その月の目印を取る（無いときだけ書く）。
 *
 * **条件付き書き込みで取る。** 「読んで、無ければ書く」の形にすると、2 つのコールバックが
 * ほぼ同時に来たときに両方が「無い」を読み、2 通送る。
 *
 * @param env バインディングと環境変数
 * @param key 目印の鍵
 * @param body 目印に残す内容
 * @returns 取れたら true
 */
async function claimMarker(env: Env, key: string, body: string): Promise<boolean> {
  const written = await env.BUCKET.put(key, body, { onlyIf: { etagDoesNotMatch: '*' } });
  return written !== null;
}

/**
 * 80% 警告を運用者へ通知する（月に 1 通）。
 *
 * **投げない。** 呼び出し元は台帳の記録を終えたあとの経路（`src/generate-callback.ts`）で、
 * 通知の失敗で台帳の記録をやり直させる理由が無い。集計や R2 が落ちた場合も分類として返す。
 *
 * @param env バインディングと環境変数
 * @param at 判定時刻（UNIX 秒。既定は現在時刻）
 * @param deps 差し替えできる依存（既定は本物の送信）
 * @returns この呼び出しの結末
 */
export async function notifyMonthlyCostWarning(
  env: Env,
  at: number = Math.floor(Date.now() / 1000),
  deps: CostAlertDeps = defaultCostAlertDeps,
): Promise<CostAlertOutcome> {
  const to = (env.OPERATOR_EMAIL ?? '').trim();
  // **設定の検査を先に置く。** 未設定の環境（ローカル・テスト）で D1 と R2 を
  // 触らないようにするためで、判定の順序としても「送れないなら数えない」が安い。
  if (to === '' || mailConfigOf(env) === null) {
    return 'not-configured';
  }

  try {
    const warning = await monthlyCostWarning(env, at);
    if (warning === null) {
      return 'below-threshold';
    }

    const key = costAlertMarkerKey(at);
    const claimed = await claimMarker(
      env,
      key,
      // **目印の中身は、あとから経緯を読むためだけのものである。** 判定には使わない
      // （使うと、目印の形を変えたときに抑止が壊れる）。
      JSON.stringify({ sentAt: at, costJpy: warning.costJpy, ratio: warning.ratio }),
    );
    if (!claimed) {
      return 'already-sent';
    }

    const message = costAlertMessage(warning, at);
    const outcome = await deps.send(env, { to, ...message }, LABEL, deps);
    if (outcome.sent) {
      return 'sent';
    }

    if (outcome.reason === 'unreachable') {
      // 受け付けられていない。**目印を戻して、次の生成でもう一度試させる**（モジュール冒頭）。
      await env.BUCKET.delete(key);
    }
    return 'send-failed';
  } catch (error) {
    // **例外の種類だけを出す。** 集計にも R2 にも利用者の入力は入らないが、
    // 例外の本文をそのまま流す経路をここに作らない（`src/quota.ts` と同じ方針）。
    console.error(
      `[cost-alert] 80% 警告の通知に失敗しました: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return 'send-failed';
  }
}
