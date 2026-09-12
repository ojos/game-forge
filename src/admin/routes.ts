/**
 * 管理画面ホスト（`admin.game-forge.ojos.jp`）の経路表（2.4 / #356）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 守る経路の境界（この issue が決めたこと）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **admin ホストでも OAuth の 3 経路は未ログインで通す。** ほかのすべては
 * `requireAdmin` で包み、権限が無ければ **404**（2.4.2。403 は画面の存在を教える）。
 *
 * | 経路 | 未ログイン | `is_admin = 0` | `is_admin = 1` |
 * |---|---|---|---|
 * | `GET /auth/google/start` | **通す**（Google へ 303） | 通す | 通す |
 * | `GET /auth/google/callback` | **通す**（セッションを発行） | 通す | 通す |
 * | `POST /auth/logout` | **通す**（cookie を消す） | 通す | 通す |
 * | `GET /`（管理画面） | 404 | 404 | 200 |
 * | 上記以外 | 404 | 404 | 404 |
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
import type { Route } from '../routes.js';
import { dispatch } from '../routes.js';
import { adminHomeRoutes } from './home.js';

/**
 * 未ログインで通す経路（**境界の正本**）。
 *
 * **綴りを書き写さない。** `src/auth/google.ts` の定数から組み立てる——写すと、
 * ログインのパスを変えた日に**境界だけが古い綴りを見続ける**（開いているつもりの経路が
 * 閉じ、閉じているつもりの経路が開く）。
 *
 * この一覧は `test/admin-guard.test.ts` が 3 方向から使う。
 *
 *   1. ここに無い経路は、未ログインで **404 になる**（包み忘れを捕まえる）
 *   2. ここに在る経路は、**本当に経路表へ登録されている**（腐った例外を捕まえる）
 *   3. ここに在る経路は、未ログインで **404 にならない**（ログインへ到達できる）
 */
export const ADMIN_OPEN_PATHS: readonly string[] = [LOGIN_PATH, CALLBACK_PATH, LOGOUT_PATH];

/**
 * 管理画面ホストの経路表を組み立てる。
 *
 * **`env` を取らない。** `src/app.ts` が関数なのは `devRoutes` を本番で落とすためだが、
 * **admin ホストに診断経路を置かない**ので、env を見る理由が無い。関数にしてあるのは
 * 認証の依存を差し替えられるようにするためである（下記）。
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
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  return await dispatch(createAdminRoutes(), request, env);
}
