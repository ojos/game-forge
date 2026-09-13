/**
 * メールの種別の登録簿——**どの通知を利用者が止められ、どれを止められないか**（5.11 / #384。M12-16）。
 *
 * ## なぜ一覧を持つのか
 *
 * 5.11 は「**止められるもの**と**止められないもの**を分けて書く」と定めた。**通知の種類が
 * 増えたときに効く**——分けずに「すべての配信」1 つにすると、セキュリティの通知を止めたつもりの
 * 利用者が生まれる。**分け方を文書にだけ書くと、通知を 1 本足した日に黙って古くなる。**
 * そこで、`sendMail` へ渡す札（各モジュールの `LABEL`）ごとに、ここで分類を持つ。
 *
 * - **`sendMail` を呼ぶすべての札がここに載っていること**は、`test/mail-kinds.test.ts` が
 *   ソースを走査して照合する（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。
 *   **通知を足した人が、ここへ 1 行足さないと赤くなる**
 * - `/account` のメール配信タブ（`src/account.ts`）は、止められない種別の一覧を**ここから**出す。
 *   画面に書き写さない
 *
 * ## 値だけの葉に置く
 *
 * **ここは何も import しない。** 通知のモジュールの一部（`src/mail/generation-notice.ts` と
 * `src/mail/resend.ts`）はオーケストレータ Lambda の束に入っている（`scripts/bundle-orchestrator.sh`）。
 * **束に入るファイルからこの登録簿を import しない**——画面の都合でここを書き換えた日に
 * 束（CodeSha256）が変わり、配り直すまで main の配備が止まる（PR #401 で実測した形）。照合は
 * import ではなくテストのソース走査で行う。
 *
 * ## 止められる種別の判定は、送信の口の手前に 1 つだけ置く
 *
 * **止められる種別は改造通知（`fork-published`）だけで、その送信の口は `src/mail/fork-notice.ts` の
 * `notifyForkPublished` 1 つだけである**（5.11「送信の口が 1 か所であることを確かめ、判定をその
 * 手前へ 1 つだけ置く」）。判定は宛先を引く問い合わせの中で `users.fork_notice_muted_at` を読む。
 * **止められる種別を足すときは、その送信の口にも同じ判定を置き、`test/mail-kinds.test.ts` の
 * 期待値を書き換えること**（書き換えないと赤くなる）。
 */

/** 誰へ送る通知か。 */
export type MailAudience =
  /** 利用者本人へ送る（5.11 の設定の対象になりうる）。 */
  | 'user'
  /** 運用者へ送る（`OPERATOR_EMAIL`。**利用者の設定とは無関係**）。 */
  | 'operator';

/** メールの種別 1 つ。 */
export interface MailKind {
  /**
   * 札。**送る実体がある種別は、送信のモジュールが `sendMail` へ渡す `LABEL` と同じ綴りである**
   * （ログに出る固定の名前。`src/mail/resend.ts`）。
   */
  readonly label: string;
  /** 誰へ送るか。 */
  readonly audience: MailAudience;
  /**
   * 利用者が `/account` で止められるか。
   *
   * **運用者宛ての種別は常に false**（利用者の設定の対象ではない）。
   */
  readonly mutable: boolean;
  /**
   * いま送る実体があるか。
   *
   * **false の種別は「送る場合は設定にかかわらず送る」と約束だけしてあるもの**である
   * （5.11 の「アカウントのセキュリティに関わる通知」「重要な仕様変更の告知」。利用者の決定）。
   * **出来ていないものを出来ているように書かない**——画面にも「いまは送っていない」と出す。
   */
  readonly implemented: boolean;
  /** 画面に出す名前（利用者宛ての種別だけが使う）。 */
  readonly name: string;
  /** 画面に出す補足（利用者宛ての種別だけが使う）。 */
  readonly note: string;
}

/** 改造通知の札（`src/mail/fork-notice.ts` の `LABEL` と同じ綴り。照合はテストが持つ）。 */
export const FORK_NOTICE_KIND_LABEL = 'fork-published';

/**
 * メールの種別の一覧（画面に出す順）。
 *
 * **並びは画面の並びである**——止められる種別、止められない種別（送っているもの→約束だけの
 * もの）、運用者宛ての順。
 */
export const MAIL_KINDS: readonly MailKind[] = [
  {
    label: FORK_NOTICE_KIND_LABEL,
    audience: 'user',
    mutable: true,
    implemented: true,
    name: '改造のお知らせ',
    note: 'ほかの人があなたの作品を改造して公開したときに、1 通お知らせします。',
  },
  {
    // **利用者の決定（#384 の着手前の決定 1）。** あなたが始めた生成の結果であり、失敗したときに
    // 生成枠が減ったことを知らせる役目がある（`src/mail/generation-notice.ts` の冒頭）。
    label: 'generation-finished',
    audience: 'user',
    mutable: false,
    implemented: true,
    name: '生成の完了・失敗のお知らせ',
    note: 'あなたが始めた生成の結果です。失敗したときは、生成枠の扱いもお知らせします。',
  },
  {
    label: 'account-security',
    audience: 'user',
    mutable: false,
    implemented: false,
    name: 'アカウントのセキュリティに関わるお知らせ',
    note: 'いまは送っていません。送る場合は、設定にかかわらず送ります。',
  },
  {
    label: 'important-changes',
    audience: 'user',
    mutable: false,
    implemented: false,
    name: '重要な仕様変更のお知らせ',
    note: 'いまは送っていません。送る場合は、設定にかかわらず送ります。',
  },
  {
    label: 'monthly-cost-warning',
    audience: 'operator',
    mutable: false,
    implemented: true,
    name: '費用 80% の警告',
    note: '運用者へ送ります（src/mail/cost-alert.ts）。',
  },
  {
    label: 'takedown-notice',
    audience: 'operator',
    mutable: false,
    implemented: true,
    name: '削除申請の受付',
    note: '運用者へ送ります（src/takedown.ts）。',
  },
];

/**
 * 利用者が止められない、利用者宛ての種別（画面に出す順）。
 *
 * @returns 種別の一覧
 */
export function unmutableUserMailKinds(): readonly MailKind[] {
  return MAIL_KINDS.filter((kind) => kind.audience === 'user' && !kind.mutable);
}
