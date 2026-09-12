/**
 * 管理画面ホスト（`admin.game-forge.ojos.jp`）の経路表（2.4 / #356）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 守る経路の境界（この issue が決めたこと）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **admin ホストで未ログインのまま通すのは OAuth の 3 つだけ。** ほかのすべての要求は
 * **メソッドの照合より前に** {@link resolveAdminUser} を通し、権限が無ければ **404**
 * （2.4.2。403 は画面の存在を教える）。
 *
 * | 要求 | 未ログイン | `is_admin = 0` | `is_admin = 1` |
 * |---|---|---|---|
 * | `GET /auth/google/start` | **通す**（Google へ 303） | 通す | 通す |
 * | `GET /auth/google/callback` | **通す**（セッションを発行） | 通す | 通す |
 * | `POST /auth/logout` | **通す**（cookie を消す） | 通す | 通す |
 * | `GET /`（管理画面） | 404 | 404 | 200 |
 * | **上記以外のすべて**（`POST /` や `GET /auth/logout` を含む） | 404 | 404 | 経路表が決める |
 *
 * **開いているのは「パス」ではなく「メソッドとパスの組」である**（{@link ADMIN_OPEN_ROUTES}）。
 * これが #359 の Copilot の指摘で直した点で、経緯は下記「なぜ経路ごとに包まないのか」。
 *
 * **なぜ OAuth を通すのか。** そこまで 404 にすると**ログインへ到達できない。**
 * セッション cookie は `__Host-` 接頭辞で `Domain` 属性を持てないため（7.2 必須要件 2 /
 * `src/session.ts`）、**app ホストのセッションは admin ホストへ届かない。** admin 側で
 * 独立にログインする以外の道が無く、そのログインの入口を閉じると**誰も入れない画面**に
 * なる。
 *
 * **なぜログアウトも通すのか。** admin のセッションは独立しているので、**ここでしか
 * 終わらせられない。** `handleLogout` は D1 も秘密も読まず（`src/auth/google.ts`）、
 * cookie を消して `/` へ送るだけである。**ログアウト直後の `/` は 404 になる**
 * ——正しい（もう管理者ではない）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ経路ごとに包まないのか（#359 の Copilot の指摘で直した）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **最初は経路ごとに `requireAdmin(handler)` で包んでいた。それは破れていた。**
 *
 * `src/routes.ts` の `dispatch` は、**パスが一致した集合の中でメソッドを照合し、
 * 合わなければ 405 と `Allow` を返す。** その判定は**ハンドラを呼ぶ前**に起きるので、
 * **包みはメソッド違いの要求を 1 つも見られない。**
 *
 *   - 未ログインの `POST /` → **405 + `Allow: GET, HEAD`**（「`/` に GET の経路がある」）
 *   - 未ログインの `GET /auth/logout` → **405 + `Allow: POST`**
 *
 * **405 は 403 と同じ情報を漏らす。** 「その呼び方は違う」と答えることは「そこに経路が
 * ある」と答えることであり、2.4.2 が 403 を退けた理由がそのまま戻ってくる。
 *
 * **したがって判定を経路表の手前へ移した**（{@link handleAdminRequest}）。副産物として
 * **失敗の向きが閉じる側になった。**
 *
 *   - 包む形は **既定が「開」** だった——包み忘れた経路が黙って開く（検査で塞いでいた）
 *   - いまは **既定が「閉」** である——{@link ADMIN_OPEN_ROUTES} に無い要求は、
 *     **経路表に在るかどうかに関わらず** 404 になる
 *
 * **M10-3 が経路を足しても、何もしなければ守られる。** 開けたいときだけ、
 * {@link ADMIN_OPEN_ROUTES} へ 1 行足して理由を書くことになる
 * （`src/page-paths.ts` の「一覧を持つのは画面ではなく例外の側である」と同じ向き）。
 *
 * **405 が消えるわけではない。** 権限のある管理者が `POST /` を叩けば 405 が返る
 * ——**通してよい相手に対しては、正しい HTTP の意味を返す。** 隠すのは
 * 「入れない相手から見た経路の存在」だけである。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 引き受けた代償
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **admin ホストに OAuth の口があることは、外から分かる。** `/auth/google/start` が
 * Google へ 303 を返すので、「このホストは Google でログインする何かである」ことまでは
 * 読める。**404 で隠せるのは画面の側だけである。**
 *
 * **これは受け入れる。** 隠すには「ログインの入口も 404 にする」しかなく、それは
 * 上のとおり画面ごと使えなくすることである。**漏れるのは「ログインの口がある」ことまで**
 * で、画面の綴りも、管理者が誰かも、機能が何かも漏れない。
 *
 * **未登録の Google アカウントでログインを試すと `/signup?reason=invite-required` へ
 * 送られる**（`src/auth/google.ts` の `resolveUser`）。admin ホストに `/signup` は無い
 * ので **404 になる。** 遷移先の綴りが 1 つ漏れるが、それは `app` ホストで誰でも開ける
 * 画面である。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `src/app.ts` と混ぜない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **あれは `app` ホストの経路表である。** 混ぜると 2.4 の制約
 * （`app` ホストで admin の経路が出ない / admin ホストで `app` の経路が出ない）が
 * **登録の順序と綴りの偶然に依存する**ようになる。表を 2 つに分け、`src/index.ts` が
 * ホストで振り分ける形なら、**構造そのものが制約を満たす。**
 * その 2 方向は `test/admin-host.test.ts` が実際に叩いて確かめる。
 */
import type { AuthDependencies } from '../auth/google.js';
import { CALLBACK_PATH, LOGIN_PATH, LOGOUT_PATH, createAuthRoutes } from '../auth/google.js';
import type { Route, RouteMethod } from '../routes.js';
import { dispatch } from '../routes.js';
import { adminNotFound, resolveAdminUser } from './guard.js';
import { adminHomeRoutes } from './home.js';

/** 未ログインで通す要求の 1 つ。**メソッドまで含めて指定する**（下記）。 */
export interface AdminOpenRoute {
  readonly method: RouteMethod;
  readonly path: string;
}

/**
 * 未ログインで通す要求（**境界の正本**）。
 *
 * **パスではなくメソッドとパスの組である。** パスだけで開けると、`GET /auth/logout` の
 * ようなメソッド違いの要求まで経路表へ届き、`dispatch` が 405 と `Allow` を返す
 * （このファイルの「なぜ経路ごとに包まないのか」）。**開ける範囲は、実際に通したい
 * 呼び方 1 つに限る。**
 *
 * **綴りを書き写さない。** `src/auth/google.ts` の定数から組み立てる——写すと、
 * ログインのパスを変えた日に**境界だけが古い綴りを見続ける**（開いているつもりの経路が
 * 閉じ、閉じているつもりの経路が開く）。**メソッドも `createAuthRoutes` の登録と
 * 一致していなければならない**ので、`test/admin-guard.test.ts` が経路表と突き合わせる。
 *
 * この一覧は `test/admin-guard.test.ts` が 4 方向から使う。
 *
 *   1. ここに無い要求は、未ログインで **404 になる**（経路表に在るものも、無いものも）
 *   2. ここに在る要求は、**本当に経路表へ同じメソッドで登録されている**（腐った例外を捕まえる）
 *   3. ここに在る要求は、未ログインで **404 にならない**（ログインへ到達できる）
 *   4. ここに在る経路への**メソッド違い**は、未ログインで **404 になる**（405 を漏らさない）
 */
export const ADMIN_OPEN_ROUTES: readonly AdminOpenRoute[] = [
  { method: 'GET', path: LOGIN_PATH },
  { method: 'GET', path: CALLBACK_PATH },
  { method: 'POST', path: LOGOUT_PATH },
];

/**
 * この要求を未ログインで通してよいかを判定する。
 *
 * **`HEAD` は `GET` として見る。** `dispatch` が同じ畳み方をするため（HTTP 上 HEAD は
 * 「GET と同じヘッダを、本文なしで」返すもの）。**ここで畳まないと、判定とその後の
 * 振り分けが「この要求のメソッドは何か」について食い違う**——`HEAD /auth/google/start` が
 * 権限を要求され、通ったあとで GET の経路へ落ちる、という読みにくい形になる。
 *
 * @param request 受信したリクエスト
 * @returns 未ログインで通すなら true
 */
function isOpenRequest(request: Request): boolean {
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const path = new URL(request.url).pathname;
  return ADMIN_OPEN_ROUTES.some((open) => open.method === method && open.path === path);
}

/**
 * 管理画面ホストの経路表を組み立てる。
 *
 * **`env` を取らない。** `src/app.ts` が関数なのは `devRoutes` を本番で落とすためだが、
 * **admin ホストに診断経路を置かない**ので、env を見る理由が無い。関数にしてあるのは
 * 認証の依存を差し替えられるようにするためである（下記）。
 *
 * **この表は権限を持たない。** 守るのは {@link handleAdminRequest} で、ここは
 * 「どの呼び方にどのハンドラが対応するか」だけを持つ。
 *
 * @param authOverrides 認証の依存の差し替え（テストがコールバックをネットワークなしで
 *   通すために使う。既定は本番の振る舞い）
 * @returns 経路表
 */
export function createAdminRoutes(
  authOverrides: Partial<AuthDependencies> = {},
): readonly Route[] {
  return [
    // **OAuth の 3 経路は `app` ホストと同じ実装を使う。** `redirectUri` は
    // `env.APP_HOST` ではなく**要求のホスト**から組み立てるので（`src/auth/google.ts`）、
    // admin ホストへ来た要求は admin のコールバックへ戻る。**写しを作らない。**
    ...createAuthRoutes(authOverrides),
    ...adminHomeRoutes,
  ];
}

/**
 * 管理画面ホストへのリクエストを処理する。
 *
 * **ここが境界である。** 経路表を引く前に権限を確かめるので、**メソッドが合わない要求も、
 * 経路が存在しない要求も、同じ 404 になる**（このファイルの「なぜ経路ごとに包まないのか」）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  if (!isOpenRequest(request)) {
    const admin = await resolveAdminUser(request, env);
    if (!admin.ok) {
      return adminNotFound(request);
    }
  }
  return await dispatch(createAdminRoutes(), request, env);
}
