/**
 * 「この利用者はまだ退会していない」を表す SQL の条件（`users` の列。束縛なし）。
 *
 * # なぜ import を持たない葉に置くのか
 *
 * **`src/handle-sql.ts` と同じ形である。** 綴りを要るのは `src/account.ts`（表示名・メール配信）・
 * `src/profile.ts`（自己紹介と外部リンク）・`src/handle.ts`（ハンドル名）・`src/withdrawal.ts`
 * （退会の本体）で、**このうち `src/withdrawal.ts` は R2 と `src/avatar.ts` と `src/games.ts` を
 * 引き連れている。** 葉のモジュール（`src/handle.ts` は import を 2 つしか持たない）から
 * それを import すると、SQL の綴り 1 つのために依存の網が広がる。
 *
 * **ここは import を 1 つも持たない。** 文字列を 1 つ持つだけなので、束に入るファイルから
 * 読んでも `CodeSha256` に効かない（`src/handle-sql.ts` の冒頭と同じ理由）。
 *
 * # なぜ書き込みの側にも要るのか（#518 の PR #589 の Copilot の指摘）
 *
 * **`resolveSessionUser`（`src/session-user.ts`）の判定は、要求の入口で 1 回きりである。**
 * 入口を通った後に別のタブで退会が確定すると、**通過済みの要求は匿名化した行を書き換えられる**
 * ——`changeDisplayName` / `changeProfile` / `changeHandle` / メール配信の設定は、どれも
 * `id`（と間隔）だけを WHERE に持っていた。退会で消した表示名・自己紹介・外部リンクが戻り、
 * 消したはずの変更の履歴が 1 行積まれる。
 *
 * **入口を直列化するのではなく、それぞれの WHERE に条件を足して塞ぐ**（`src/games.ts` の
 * `renameGame` と同じ規律——断る判定を読みと書きの間に置かず、WHERE に置く）。
 * **本体の UPDATE と履歴の INSERT の両方に効かせること**——片方だけだと、値は戻らないのに
 * 履歴の行だけが積まれる（退会で消したはずの表が 1 行だけ復活する）。
 *
 * **生成とリフォージは、`migrations/0045_user_withdrawal.sql` のトリガが D1 の側で塞ぐ**
 * （束に入る SQL を変えずに済ませるため）。ここで塞ぐのは、トリガの対象でない `users` の列と、
 * その変更の履歴である。
 *
 * **判定は `withdrawal_started_at`**（`withdrawn_at` ではない）。掴んだ時点で止める
 * （掴みから確定までの数百ミリ秒も書かせない）。
 */

/**
 * 「退会していない」を表す WHERE の断片（**別名なしの `users` の列**。束縛なし）。
 *
 * `and` で繋いで使う。**別名を付けた `users` を引く文では使えない**（付けるなら、その文の側で
 * 綴りを組み立てること）。一致は `test/withdrawal-routes.test.ts` が機械照合する。
 */
export const NOT_WITHDRAWN_SQL = 'withdrawal_started_at is null';
