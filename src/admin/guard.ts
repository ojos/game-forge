/**
 * 管理画面の認可（2.4.2 / #356）。
 *
 * ここが決めるのは 1 つだけである——**この要求は `users.is_admin = 1` の利用者から
 * 来たか。** 来ていなければ **404 を返す。**
 *
 * ## なぜ 403 ではなく 404 なのか（2.4.2）
 *
 * **403 は画面の存在を教える。** 「権限が足りない」と答えることは「そこに何かある」と
 * 答えることであり、管理画面では**それ自体が漏らしてよくない情報**である。運営しか
 * 使わない画面なので、**存在を知らせて得られるものが 1 つも無い。**
 *
 * ## 404 は「経路が無い」ときと区別できてはならない
 *
 * ステータスだけ 404 に揃えても、**本文やヘッダが違えば区別できる。** 存在する画面の
 * 404 が JSON で、存在しない経路の 404 が HTML だったなら、**404 を 2 種類返している
 * のと同じ**である。{@link adminNotFound} は `src/routes.ts` の `dispatch` が未登録の
 * パスへ返すものと**同じ形**を返し、その一致は `test/admin-guard.test.ts` が
 * **実際に両方を叩いて突き合わせる**（記述で守らない——写しは必ず腐る）。
 *
 * ## 守る経路の境界（この issue が決めたこと）
 *
 * **OAuth の 3 つ（開始・コールバック・ログアウト）は未ログインで通す。** そこまで 404 に
 * すると**ログインへ到達できず、誰も管理画面へ入れない。** 境界の正本は
 * `src/admin/routes.ts` の `ADMIN_OPEN_ROUTES` で、**判定を掛ける場所は
 * `handleAdminRequest`（経路表を引く手前）である。**
 *
 * **ここに `requireAdmin` のような「経路を包む」道具を置かない。** 包む形は
 * `dispatch` のメソッド照合をすり抜け、**未ログインの `POST /` が 405 と `Allow` を
 * 返していた**（#359 の Copilot の指摘。経緯は `src/admin/routes.ts` の
 * 「なぜ経路ごとに包まないのか」）。**405 は 403 と同じものを漏らす。**
 *
 * ## 認証そのものは写さない
 *
 * BAN と利用者の不在の判定は `resolveSessionUser`（`src/session-user.ts`）が持つ。
 * **こちらへ書き写さない**——あのファイルが「経路ごとに写すと、片方だけ BAN の検査が
 * 抜ける形の差分が生まれても動作では気づけない」と書いているとおりである。
 * ここが足すのは**認可の 1 ビットだけ**で、そのために D1 をもう 1 行読む。
 *
 * **読み取りを 2 回に分けてよい理由。** 読み取りの単価は書き込みの 1/1000 で（3.6）、
 * 管理画面を開くのは 1 日に数回である。**1 回にまとめるために認証の判定を写すほうが
 * 高い**（写した側が腐る）。
 */
import { json } from '../routes.js';
import { resolveSessionUser } from '../session-user.js';

/**
 * 認可の結果。
 *
 * **失敗の理由を持たない。** 未ログイン・改竄・期限切れ・BAN・`is_admin = 0` の
 * どれであっても、呼び出し側が返せるのは 404 だけである（区別できる応答を返すと、
 * 404 が 2 種類になる。上記）。理由はログにだけ残す。
 */
export type AdminResolution =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false };

/**
 * 要求が管理者のものかを判定する。
 *
 * **投げない。** `resolveSessionUser` は `SESSION_SECRET` が未設定・短いときに投げる
 * （`src/session.ts` の `importKey`）。ここで素通しすると、**設定を壊した瞬間に
 * 管理画面が 500 を返し、「壊れているが在る」ことを教える。** 遮断側へ倒し
 * （fail-closed。8.2 の「呼べないときは遮断側へ倒す」と同じ向き）、事実はログへ残す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 管理者の id、または拒否
 */
export async function resolveAdminUser(request: Request, env: Env): Promise<AdminResolution> {
  let userId: string;
  try {
    const session = await resolveSessionUser(request, env);
    if (!session.ok) {
      // 未ログイン・改竄・期限切れ・BAN・利用者の不在。理由は `resolveSessionUser` が
      // ログへ残している。
      return { ok: false };
    }
    userId = session.userId;
  } catch (error) {
    // 署名鍵の設定そのものが壊れている。**黙らせないが、通さない。**
    console.error(
      `[admin] セッションを検証できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return { ok: false };
  }

  try {
    const row = await env.DB.prepare('select is_admin from users where id = ?')
      .bind(userId)
      .first<{ is_admin: number }>();
    // **`=== 1` で見る。** `!== 0` にすると、CHECK を外した日や別経路で入った値が
    // 権限を通す側へ倒れる（0025 の「CHECK を張る」）。**行が無い場合も通さない**
    // ——`resolveSessionUser` が引いた直後に消えた行がこれにあたる。
    if (row?.is_admin !== 1) {
      console.error('[admin] 権限の無い要求を 404 で返しました');
      return { ok: false };
    }
  } catch (error) {
    // D1 が読めない。**通さない**（認可を確かめられないことは、認可があることではない）。
    console.error('[admin] 権限を確かめられませんでした', error);
    return { ok: false };
  }

  return { ok: true, userId };
}

/**
 * 権限の無い要求へ返す 404。
 *
 * **`dispatch` が未登録のパスへ返すものと同じ形にする**（このファイルの冒頭）。
 * `src/routes.ts` の `json` を通すので、`content-type` と `cache-control: no-store` も
 * 揃う。
 *
 * @param request 受信したリクエスト
 * @returns 404 のレスポンス
 */
export function adminNotFound(request: Request): Response {
  return json({ error: 'not found', path: new URL(request.url).pathname }, 404);
}

/*
 * ## M10-3 へ: 実行者の id が要るとき
 *
 * `admin_actions`（2.4.4）は**実行者**を残す。いまの `handleAdminRequest` は
 * {@link resolveAdminUser} の戻り値を捨てている——**この画面が利用者の値を 1 つも
 * 出さないため、要る場面が無い**（`src/admin/home.ts`）。
 *
 * **要るようになったら、境界を 2 か所に増やさずに渡すこと。** 経路表を組み立てる関数へ
 * 判定済みの id を渡し、ハンドラがそれを閉じ込める形にすれば、**判定は 1 回のまま**に
 * なる（`createAdminRoutes` は既に引数を取る関数である）。**ハンドラの中で
 * `resolveAdminUser` を呼び直さないこと**——D1 を 2 回読むだけでなく、
 * 「そこでも拒否できる」形になり、**どちらが境界なのかが読めなくなる。**
 */
