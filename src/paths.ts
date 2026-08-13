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
