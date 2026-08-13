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
