/**
 * 登録情報（`/account`）に関わる綴り（#341 / 仕様 5.9）。
 *
 * # なぜ値だけの葉に置くのか
 *
 * **後から全画面共通のヘッダ（`src/html.ts` の `siteHead`）がここへ送り返す**（#331。
 * 仕様 2.3.7「ログインしていれば 自分の作品 と 登録情報」）。`src/account.ts` は画面を
 * 組むために `siteHead` を import するので、ヘッダが `src/account.ts` から綴りを借りると
 * **循環参照になる**（`src/paths.ts` の `HOME_PATH` と同じ理由）。
 *
 * # なぜ `src/paths.ts` に置かないのか
 *
 * **あちらはオーケストレータ Lambda の束に入る**（#336。`src/paths.ts` の冒頭）。
 * ここに置く値は画面と API の経路だけが読むもので、Lambda は一度も読まない。
 * **いまは 3 つとも素の文字列リテラルなので束から落ちるはずだが、「落ちるはず」に
 * 賭けない**——`src/works-paths.ts` は式にしたために束に残り、本番配備を止めた（#328）。
 * 置き場を分けておけば、ここの値を式に変えた日にも Lambda は動かない。
 */

/**
 * 登録情報の画面（2.3.1。ログイン必須）。
 *
 * 表示名の変更フォームと、メールアドレス・登録日を出す（5.9）。
 */
export const ACCOUNT_PATH = '/account';

/**
 * 表示名の変更（API。5.9）。
 *
 * **画面のパスと分ける。** `src/invite-issuance.ts` の `INVITES_API_PATH` と同じ判断で、
 * HTML を返す画面と、書き込みを受ける口を同じパスへ同居させない。`/api/*` は
 * 確定22 で正とした綴りであり、`src/page-paths.ts` が画面の検査から接頭辞で外す。
 */
export const ACCOUNT_DISPLAY_NAME_PATH = '/api/account/display-name';

/**
 * フォームの項目名（表示名）。
 *
 * 画面（フォームを書く側）と API（読む側）が同じ綴りを使う。**片方に書き写すと、
 * 変えた日に「送ったのに空として断られる」形で壊れる**（動作は 303 のままなので
 * 気づきにくい）。
 */
export const DISPLAY_NAME_FIELD = 'display_name';
