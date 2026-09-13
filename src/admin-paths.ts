/**
 * 運営の管理画面（`admin.game-forge.ojos.jp`）のパスの綴り（2.4 / #356）。
 *
 * # なぜ `src/paths.ts` へ足さないのか
 *
 * **あれはオーケストレータ Lambda の束に入る**（#336 / `docs/handoff.md` 3 章）。
 * 値が式になる綴りをあそこへ足すと、Lambda が 1 バイトも読まなくても `CodeSha256` が
 * 変わり、**#241 の関門がマージ後の配備を止める。** 同じ形の停止が 3 回起きている。
 *
 * **admin の綴りは Lambda と何の関係も無い**ので、最初から別の葉へ置く
 * （`src/works-paths.ts` / `src/account-paths.ts` と同じ形）。
 *
 * # なぜ値だけのモジュールなのか
 *
 * 画面のモジュール（`src/admin/review.ts`）へ綴りを置くと、外枠（`src/admin/shell.ts`）が
 * ヘッダの行き先のために画面を import することになり、画面が外枠を呼ぶ向きと合わせて
 * **循環参照になる**（`src/html.ts` の冒頭が、まさにその事故の記録である）。
 * 綴りは値だけの葉に置く。
 */

/**
 * 管理画面のトップ＝**審査キュー**（2.3.1 の admin の表の 1 行目 / 2.4.3）。
 *
 * **M10-3（#361）が中身を載せた。** M10-2 の時点では空の 1 枚で、その頃この注記は
 * 「審査キューをここへ載せるのは M10-3」と書いていた。**載せたので、書き換えてある。**
 *
 * **`/` である。** 管理画面のホストは admin 専用なので、トップをそのまま使える。
 * `/admin/` のような接頭辞を付けると、ホストで分けた意味が薄れる（同じ綴りが
 * 「どのホストの `/admin/`」かでぶれる）。**2.3.1 の表も admin の `/` を審査キューと
 * している**ので、ここに別の入口（目次だけの画面）を挟まない。
 */
export const ADMIN_HOME_PATH = '/';

/**
 * 利用者の一覧と BAN の付け外し（2.3.1 の admin の表 / 2.4.3）。
 *
 * **app ホストの `/users/<user_id>`（作者ページ）とは別のホストの別の綴りである。**
 * あちらは前方一致の経路で、こちらは完全一致である。同じ綴りを避ける理由が無い
 * ——**ホストで分けた意味は、まさにこれが衝突しないことにある。**
 */
export const ADMIN_USERS_PATH = '/users';

/**
 * 操作の履歴（2.4.4。**追記のみ**）。
 *
 * **画面から読めるようにする**ことを 2.4.4 が求めている（「端末からしか読めない記録は、
 * 急ぐ場面で使われない」）。
 */
export const ADMIN_ACTIONS_PATH = '/actions';

/**
 * 審査状態を切り替える口（`queued` ↔ `cleared`）。
 *
 * **画面のパスと分ける**（`src/account-paths.ts` の `ACCOUNT_DISPLAY_NAME_PATH` と同じ
 * 判断。HTML を返す画面と、書き込みを受ける口を同じパスへ同居させない）。`/api/*` は
 * 確定22 で正とした綴りで、`src/page-paths.ts` が画面の検査から接頭辞で外す
 * ——**POST は元から画面として導かれない**が、綴りの側でも意図を示しておく。
 *
 * **`/` に POST を足さない形にもなっている。** 足すと、権限のある管理者への `POST /` が
 * 405 ではなく 200 を返すようになり、`test/admin-guard.test.ts` が
 * 「通してよい相手には正しい HTTP の意味を返す」ことを確かめている足場が消える。
 */
export const ADMIN_REVIEW_API_PATH = '/api/review';

/**
 * BAN を付け外しする口（`users.banned_at`）。
 *
 * 置き場の理由は {@link ADMIN_REVIEW_API_PATH} と同じである。
 */
export const ADMIN_BAN_API_PATH = '/api/ban';

/** 削除依頼の一覧と、措置の記録（#406。仕様 2.3.1 の admin の表の綴り）。 */
export const ADMIN_TAKEDOWNS_PATH = '/takedowns';

/** 削除依頼に措置を記録する口（#406）。 */
export const ADMIN_TAKEDOWN_API_PATH = '/api/takedown';

/** 措置を記録する削除依頼の id（`takedown_requests.id`）。 */
export const ADMIN_TAKEDOWN_ID_FIELD = 'takedown_id';

/**
 * 採った措置（`src/takedown.ts` の `TAKEDOWN_ACTIONS` のどれか）。
 *
 * **`ADMIN_NEXT_FIELD` を使い回さない。** あちらは「往復のどちらにしたいか」で、措置は
 * 往復ではない（1 度記録したら上書きしない）。同じ名前で違う意味を運ばない。
 */
export const ADMIN_TAKEDOWN_ACTION_FIELD = 'takedown_action';

/**
 * フォームの項目名（対象の作品）。
 *
 * **画面（フォームを書く側）と口（読む側）が同じ綴りを使う。** 片方へ書き写すと、
 * 変えた日に「送ったのに対象が空として断られる」形で壊れる（`src/account-paths.ts` の
 * `DISPLAY_NAME_FIELD` と同じ理由）。
 */
export const ADMIN_GAME_ID_FIELD = 'game_id';

/** フォームの項目名（対象の利用者）。 */
export const ADMIN_USER_ID_FIELD = 'user_id';

/**
 * フォームの項目名（**理由**。2.4.4 が必須と定めた値）。
 *
 * 審査の切り替えと BAN の付け外しで**同じ綴りを使う**。項目の意味が同じだからである
 * （どちらも `admin_actions.reason` へそのまま入る）。
 */
export const ADMIN_REASON_FIELD = 'reason';

/**
 * フォームの項目名（**次の状態**）。
 *
 * **項目名は 2 つの口で同じだが、受け付ける語彙は違う。** 審査は `queued` / `cleared`
 * （`src/reports.ts` の綴り）、BAN は `banned` / `active`（`src/admin/users.ts` の綴り）
 * である。**どちらの口も、自分の語彙に無い値を既定へ落とさずに断る。**
 *
 * **「いまどちらか」ではなく「どちらにしたいか」を送る。** 画面を開いたまま別の管理者が
 * 動かした場合に、「切り替える」だけの要求だと**送った側が意図しない向きへ倒れる。**
 */
export const ADMIN_NEXT_FIELD = 'next';
