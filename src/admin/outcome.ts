/**
 * 操作の結果を画面へ運ぶ知らせ（#361）。
 *
 * # なぜ 1 か所に集めるのか
 *
 * **審査キュー（`src/admin/review.ts`）と利用者の一覧（`src/admin/users.ts`）が、
 * 同じ分類を使う。** 理由が空・対象が見つからない・書けなかった、はどちらの操作でも
 * 同じ意味である。**画面ごとに文言の表を持つと、片方だけが古くなる**
 * （`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * # query に載せるのは固定の綴りだけである
 *
 * **利用者の入力（理由の本文・対象の id）を query へ載せない**（`src/account.ts` /
 * `src/invite-issuance.ts` と同じ方針）。載せると、**断られた値が履歴やログに残り、
 * 画面へ反射する口にもなる。** 画面はこの表で固定の文言へ引き直す。
 *
 * **未知の値を通さない。** 手で `?outcome=<script>` と書き換えられても、
 * {@link outcomeMessage} は表に無い値を既定の文言へ落とす。
 */
import { escapeHtml } from '../html.js';
import type { ReasonRejection } from './actions.js';

/**
 * 結果を運ぶ query の名前（`/?outcome=applied`）。
 *
 * **成功と失敗を 1 つの名前に集める。** `src/account.ts` は成功を別の名前
 * （`?saved=1`）にしているが、あちらは「保存した」の 1 種類しか無い。こちらは
 * **「切り替えた」と「既にその状態だった」を区別して伝える**ので、分類の側に
 * 成功も入れるほうが表が 1 つで済む。
 */
export const ADMIN_OUTCOME_QUERY = 'outcome';

/** 操作の結果の分類。 */
export type AdminOutcome =
  | 'applied'
  | 'unchanged'
  | 'not-applicable'
  | 'write-failed'
  | 'invalid-request'
  | 'invalid-target'
  | ReasonRejection;

/**
 * 成功として扱う分類。
 *
 * **`unchanged` も成功である。** 状態は動いていないが、**操作は受け付けて履歴に
 * 残っている**（`src/admin/actions.ts` の「代わりに引き受けたこと」）。
 * 失敗のステータス（400）で返すと、**残っている記録を失敗として読ませる。**
 */
const SUCCEEDED: readonly AdminOutcome[] = ['applied', 'unchanged'];

/**
 * 分類ごとの文言。
 *
 * **`Record` にしてあるので、分類を足して文言を書き忘れると型の検査で落ちる**
 * （`src/account.ts` の `REASON_MESSAGES` と同じ形）。
 */
const OUTCOME_MESSAGES: Readonly<Record<AdminOutcome, string>> = {
  applied: '操作しました。履歴に 1 行残っています。',
  // **何が起きたかを言う。** 「失敗しました」と書くと、運営は押し直す——
  // **押し直しても同じ結果になる**（既にその状態である）。
  unchanged:
    '対象は既にその状態でした。状態は動いていませんが、操作は履歴に残っています。',
  'not-applicable':
    '対象が見つからないか、この操作の対象になる状態ではありません。一覧を開き直してください。',
  'write-failed': '書き込めませんでした。時間をおいてもう一度お試しください。',
  'invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  'invalid-target': '対象を指定してください。一覧のボタンから操作してください。',
  // **必須であることと、なぜ必須かを言う**（2.4.4。削除申請への回答に使う）。
  'reason-empty': '理由を入力してください。理由の無い操作は受け付けません（仕様 2.4.4）。',
  'reason-too-long': '理由が長すぎます。500 文字までで入力してください。',
};

/** 未知の分類を受けたときの文言。 */
const DEFAULT_OUTCOME_MESSAGE = '操作の結果を確認できませんでした。一覧を開き直してください。';

/**
 * query の値が既知の分類かを判定する。
 *
 * @param value query から受け取った値
 * @returns 既知なら true
 */
function isKnownOutcome(value: string): value is AdminOutcome {
  return Object.hasOwn(OUTCOME_MESSAGES, value);
}

/**
 * 分類から画面に出す文言を選ぶ。
 *
 * @param value query から受け取った値（未知の値でもよい）
 * @returns 画面に出す文言
 */
export function outcomeMessage(value: string): string {
  return isKnownOutcome(value) ? OUTCOME_MESSAGES[value] : DEFAULT_OUTCOME_MESSAGE;
}

/**
 * その分類が成功かどうか。
 *
 * **未知の値は失敗として扱う**（分からないものを成功にしない）。
 *
 * @param value query から受け取った値
 * @returns 成功なら true
 */
export function isSucceeded(value: string): boolean {
  return isKnownOutcome(value) && SUCCEEDED.includes(value);
}

/**
 * 画面の上部に出す知らせを組み立てる。
 *
 * **文言は表から選んだ固定文字列だが、`escapeHtml` を通す**（`src/account.ts` と
 * 同じ理由——出どころが変わっても安全側が既定になる）。エスケープを呼び出し側へ
 * 任せない——**画面が 3 枚あると、呼び忘れる場所が 3 つできる。**
 *
 * @param value query から受け取った値（null なら知らせを出さない）
 * @returns HTML（知らせが無ければ空文字）
 */
export function renderOutcomeNotice(value: string | null): string {
  if (value === null) {
    return '';
  }
  const message = escapeHtml(outcomeMessage(value));
  return isSucceeded(value)
    ? `<p class="gf-notice" role="status">${message}</p>`
    : `<p class="error" role="alert">${message}</p>`;
}

/**
 * 結果を運ぶ遷移先を組み立てる。
 *
 * @param path 戻り先の画面
 * @param outcome 結果の分類
 * @returns `?outcome=` 付きのパス
 */
export function outcomeLocation(path: string, outcome: AdminOutcome): string {
  return `${path}?${ADMIN_OUTCOME_QUERY}=${outcome}`;
}

/**
 * 操作の後に一覧へ戻す（POST-redirect-GET。9.3）。
 *
 * **303 を使う**（302 ではない）。302 は POST を POST のまま追う余地があり、
 * **再送が同じ操作をもう 1 度積む**——履歴は追記のみなので、**積んだ行は消せない**
 * （`src/account.ts` / `src/invite-issuance.ts` が 303 を選んだ理由が、ここでは
 * いっそう強い）。
 *
 * **`cache-control: no-store` を付ける**（`src/routes.ts` の `json` / `html` と同じ既定）。
 *
 * @param path 戻り先の画面
 * @param outcome 結果の分類
 * @returns 303 のレスポンス
 */
export function redirectWithOutcome(path: string, outcome: AdminOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: { location: outcomeLocation(path, outcome), 'cache-control': 'no-store' },
  });
}
