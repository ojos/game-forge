/**
 * 法務の画面の綴り（利用規約・削除申請。5.6 / 8.4 / #41）。
 *
 * ## なぜ値だけの葉に置くのか（#372）
 *
 * **外枠（`src/html.ts`）が削除申請の綴りを要るようになった。** 受付完了の画面
 * （`/takedown/thanks`）のパンくずは、親として削除申請の画面（`/takedown`）を出す
 * （2.3.10）。ところが綴りの正本だった `src/legal.ts` は `siteHead` を呼ぶ画面なので、
 * **外枠がそこから借りると必ず循環参照になる**（`src/html.ts` の冒頭が名指しで禁じている）。
 *
 * `src/account-paths.ts` / `src/works-paths.ts` / `src/liked-works-paths.ts` と同じ形で、
 * **値だけをここへ移し、`src/legal.ts` は再輸出する**（既存の import はそのまま動く）。
 *
 * **法務の画面を足すとき（#373 のプライバシーポリシー・よくある質問など）も、綴りは
 * ここへ置くこと。** フッタ（`src/legal.ts` の `siteFooter`）から借りるだけなら画面の
 * モジュールでも足りるが、**その画面が子を持った日にパンくずの親として外枠が借りに来る。**
 */

/** 利用規約のパス。 */
export const TERMS_PATH = '/terms';

/** 削除申請フォームのパス。 */
export const TAKEDOWN_PATH = '/takedown';

/** 削除申請を受け付けたあとの行き先。 */
export const TAKEDOWN_THANKS_PATH = '/takedown/thanks';

/** プライバシーポリシーのパス（2.3.1 v1.57 / #373）。 */
export const PRIVACY_PATH = '/privacy';

/** よくある質問のパス（2.3.1 v1.57 / #373）。 */
export const FAQ_PATH = '/faq';
