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
 * **いまはどれも素の文字列リテラルと配列なので束から落ちるはずだが、「落ちるはず」に
 * 賭けない**——`src/works-paths.ts` は式にしたために束に残り、本番配備を止めた（#328）。
 * 置き場を分けておけば、ここの値を式に変えた日にも Lambda は動かない。
 */

/**
 * 登録情報の画面（2.3.1。ログイン必須）。**プロフィールのタブである**（#379 / 5.10）。
 *
 * 表示名の変更フォーム（5.9）と、自己紹介と外部リンクのフォーム（5.10）を出す。
 * **ヘッダのアカウントのメニューが指す先であり、タブの既定である**——#379 より前から
 * 共有されている `/account` の URL を、そのまま「登録情報を開く」の意味で使い続ける。
 */
export const ACCOUNT_PATH = '/account';

/**
 * 登録情報の画面の、アカウントのタブ（#379 / 5.10。ログイン必須）。
 *
 * メールアドレスと登録日を出す（5.9 で `/account` にあったもの。**本人にだけ出す**）。
 *
 * **`/account` の下に置く。** パンくずの階層は URL から導くので（`src/page-paths.ts` の
 * `ancestorPathsOf`）、ここを開くと「トップ › 登録情報 › アカウント」になる。**タブを
 * query（`/account?tab=`）で分けない**——パスで分ければ、タブごとに経路表の画面になり、
 * 外枠の検査（`test/page-shell.test.ts`）と幅の検査（`scripts/check-page-width.sh`）へ
 * 何も書き足さずに乗る。query で分けると、2 枚目以降のタブはどちらの検査からも見えない。
 */
export const ACCOUNT_DETAILS_PATH = '/account/details';

/** 登録情報の画面のタブ 1 つ。 */
export interface AccountTab {
  /** タブの行き先（経路表の GET の画面）。 */
  readonly path: string;
  /** タブの名前。 */
  readonly label: string;
}

/**
 * 登録情報の画面のタブ（#379 / 5.10。並び順どおりに出す）。
 *
 * **タブを足すときは、ここへ 1 行と、`src/account.ts` の経路表へ GET の画面を 1 本足す**
 * （メール配信のタブは #384 / 5.11 が足す）。行き先がすべて経路表の画面であることは
 * `test/account.test.ts` が照合するので、片方だけを足すと赤くなる。
 */
export const ACCOUNT_TABS: readonly AccountTab[] = [
  { path: ACCOUNT_PATH, label: 'プロフィール' },
  { path: ACCOUNT_DETAILS_PATH, label: 'アカウント' },
];

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
