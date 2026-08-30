/**
 * 複数のモジュールが参照する経路のパス。
 *
 * 経路のパスは、原則としてそれを提供するモジュールが持つ（`src/auth/google.ts` の
 * `LOGIN_PATH` など）。**このファイルに置くのは「提供する側と、そこへ送り返す側が
 * 別モジュールになるもの」だけ**である。
 *
 * `SIGNUP_PATH` がそれにあたる。画面を提供するのは `src/signup.ts` だが、認証の
 * コールバック（`src/auth/google.ts`）は登録できなかった利用者をここへ戻す。片方が
 * もう片方から import すると、`src/signup.ts` が `startInvitedLogin` を使う向きと
 * 合わせて循環参照になる。値だけを持つ葉のモジュールへ逃がすと、どちらの向きにも
 * 依存が生まれない。
 */

/** 登録画面（招待コードの入力）。 */
export const SIGNUP_PATH = '/signup';

/** 待機リスト登録後の受け皿（POST-redirect-GET の GET 側）。 */
export const WAITLIST_THANKS_PATH = '/signup/waitlist/thanks';

/**
 * 待機リストへの登録（API）。
 *
 * `/api/*` は確定22 で正とした綴りである。M1 の時点では 9.3 が「API を `/api/*` に
 * 置くなら Pages Functions を使う。ここは M2-1 の実装時に確定する」としていたため
 * `/waitlist` に置いていた（#63）。確定22 でその制約が解けたので寄せた。
 *
 * 登録フォームの `action` と経路の登録が同じ値を指すよう、定数を 1 か所に置く。
 */
export const WAITLIST_PATH = '/api/waitlist';

/**
 * 招待を発行する画面（8.1 / #91）。
 *
 * 画面を提供するのは `src/invite-issuance.ts` だが、公開トップ（`src/home.ts`）が
 * ここへ送る。一方で発行の画面は「トップへ戻る」導線として `HOME_PATH` を参照するため、
 * どちらかがもう片方から import すると循環参照になる。`SIGNUP_PATH` と同じ理由で、
 * 値だけを持つこのモジュールへ逃がす。
 *
 * API 側のパス（`/api/invites`）はここに置かない。参照するのは発行の経路を提供する
 * モジュールだけで、上の条件に当たらない。
 */
export const INVITES_PATH = '/invites';

/**
 * 生成画面（5.2-1 / #128）。
 *
 * 画面を提供するのは `src/generate-page.ts` だが、公開トップ（`src/home.ts`）が
 * ここへ送る。一方で生成画面は「トップへ戻る」導線として `HOME_PATH` を参照するため、
 * どちらかがもう片方から import すると循環参照になる。`INVITES_PATH` と同じ理由で、
 * 値だけを持つこのモジュールへ逃がす。
 *
 * API 側のパス（`/api/generate`）はここに置かない。正は `src/generate.ts` の
 * `GENERATE_PATH` で、画面はそこから import する（上の条件に当たらない）。
 */
export const GENERATE_PAGE_PATH = '/generate';

/**
 * 公開の操作（5.4 / #26）。
 *
 * 経路を提供するのは `src/publish.ts` だが、**試遊画面（`src/work-page.ts`）が
 * 「公開して共有」のフォームの `action` として同じ綴りを要る。** 一方で
 * `src/publish.ts` は公開後の戻り先として `src/work-page.ts` の `workPagePath` を
 * 使うため、どちらかがもう片方から import すると循環参照になる。
 * `SIGNUP_PATH` / `INVITES_PATH` と同じ理由で、値だけを持つこのモジュールへ逃がす。
 */
export const PUBLISH_PATH = '/api/publish';

/**
 * 公開の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。
 *
 * {@link PUBLISH_PATH} と同じ理由でここに置く。**フォームを書く側と、それを読む側が
 * 別モジュールである**以上、綴りの正本も片方の中には置けない。
 */
export const PUBLISH_GAME_ID_FIELD = 'game_id';

/**
 * 推敲の操作（5.7 / #192）。
 *
 * 経路を提供するのは `src/revise.ts` だが、**作品ページ（`src/work-page.ts`）が
 * 推敲のフォームの `action` として同じ綴りを要る。** 一方で `src/revise.ts` は
 * 推敲を始めたあとの戻り先として `workPagePath` を使うため、どちらかがもう片方から
 * import すると循環参照になる。`PUBLISH_PATH` と同じ理由でここへ逃がす。
 */
export const REVISE_PATH = '/api/revise';

/**
 * 「この版に戻す」（5.7）。
 *
 * **`/api/revise` と同じパスに畳まない。** 畳むと、経路表ではなくハンドラが本文の
 * 項目の有無で「手直しか復元か」を見分けることになる。**費用が出る操作と出ない操作を、
 * 本文の推測で分けない**（前者は 1 回 約 16 円、後者は 0 円である）。
 */
export const RESTORE_PATH = '/api/revise/restore';

/** 推敲の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const REVISE_GAME_ID_FIELD = 'game_id';

/** 差分プロンプトの項目名。 */
export const REVISE_PROMPT_FIELD = 'prompt';

/** 戻したい版の番号の項目名。 */
export const REVISE_SEQ_FIELD = 'seq';
