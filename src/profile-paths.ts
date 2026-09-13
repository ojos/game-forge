/**
 * プロフィール（自己紹介と外部リンク。#379 / 仕様 5.10）の口と、フォームの項目名。
 *
 * **値だけの葉に置く**（`src/account-paths.ts` の冒頭と同じ理由）。画面（フォームを書く側。
 * `src/account.ts`）と口（読む側。同じく `src/account.ts`）と検査（`test/profile.test.ts`）が
 * 同じ綴りを使う。**片方に書き写すと、変えた日に「送ったのに空として保存される」形で壊れる**
 * （動作は 303 のままなので気づきにくい）。
 */

/**
 * 自己紹介と外部リンクの保存（API）。
 *
 * **1 つの口で両方を受ける**（1 つのフォームで送る。変更の間隔も 1 つ。`src/profile.ts`）。
 * **画面のパスと分ける**のは表示名（`ACCOUNT_DISPLAY_NAME_PATH`）と同じ判断で、`/api/` は
 * `src/page-paths.ts` が画面の検査から接頭辞で外す。
 */
export const ACCOUNT_PROFILE_PATH = '/api/account/profile';

/** フォームの項目名（自己紹介）。 */
export const BIO_FIELD = 'bio';

/**
 * フォームの項目名（外部リンク）。
 *
 * **同じ名前の入力欄を本数ぶん並べる**（`URLSearchParams#getAll` で読む）。`link1` / `link2` の
 * ように番号を綴りへ入れると、本数の上限を変えた日に画面と口の両方を書き換えることになる。
 */
export const PROFILE_LINK_FIELD = 'link';
