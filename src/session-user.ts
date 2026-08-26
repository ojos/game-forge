/**
 * 署名付き cookie から「いま操作してよい利用者」を解決する（8.1 / 7.3）。
 *
 * `src/session.ts` は **D1 にも経路表にも依存しない**署名の層で、そこが答えられるのは
 * 「このトークンが自分の鍵で署名され、まだ期限内か」までである。書き込みを伴う経路が
 * 知りたいのはその先、**その利用者が今も操作してよいか**であり、判定には D1 が要る。
 * 層が違うので `src/session.ts` へは足さず、こちらへ置く。
 *
 * ## 署名だけを信じない理由
 *
 * セッションの寿命は 7 日（`src/auth/google.ts` の `SESSION_MAX_AGE`）で、サーバ側に
 * 失効の手段が無い。署名の検証だけで通すと BAN（7.3）が最大 7 日効かず、消された
 * 利用者の id を指すセッションもそのまま通る。読み取りの単価は書き込みの 1/1000 で
 * （3.6）、対象は生成や招待の発行といった 1 日に数回の操作なので、ここで 1 回引いても
 * 無料枠に響かない。
 *
 * ## なぜ 1 か所に置くか
 *
 * この判定は**認証そのもの**であり、経路ごとに写すと、片方だけ BAN の検査が抜ける形の
 * 差分が生まれても動作では気づけない（どちらも「ログインできている」ように見える）。
 * 生成（`src/generate.ts`）と招待の発行（`src/invite-issuance.ts`）が同じ関数を呼ぶ形に
 * しておけば、条件を足すときの追随箇所が 1 つで済む。
 */
import { readSessionCookie, verifySession } from './session.js';

/**
 * 解決の結果。
 *
 * **失敗の理由を持たない。** 改竄・期限切れ・BAN・利用者の不在のどれであっても、
 * 呼び出し側が返せるのは 401 だけであり、区別できる応答を返すと、任意の id が
 * 生きているかを外から確かめられる手がかりになる。理由はログにだけ残す。
 */
export type SessionUserResolution =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false };

/**
 * セッション cookie から利用者を解決する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 利用者の id、または拒否
 * @throws `SESSION_SECRET` が未設定・短すぎる場合（`src/session.ts` の `importKey`）
 */
export async function resolveSessionUser(
  request: Request,
  env: Env,
): Promise<SessionUserResolution> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) {
    return { ok: false };
  }

  const verified = await verifySession(token, env.SESSION_SECRET);
  if (!verified.ok) {
    // 理由は返さない。改竄・期限切れ・鍵違いのどれであっても、利用者にできることは
    // 「もう一度ログインする」だけである。
    console.error(`[session] セッションを受け付けませんでした: ${verified.reason}`);
    return { ok: false };
  }

  const row = await env.DB.prepare('select banned_at from users where id = ?')
    .bind(verified.payload.userId)
    .first<{ banned_at: number | null }>();
  if (row === null) {
    // 署名は通るが利用者が居ない。招待の消費に失敗して取り消された行（#14 T7 の補償）や、
    // 手動で消した行のセッションがこれにあたる。
    console.error('[session] セッションが指す利用者が存在しません');
    return { ok: false };
  }
  if (row.banned_at !== null) {
    console.error('[session] BAN された利用者の要求を拒否しました');
    return { ok: false };
  }

  return { ok: true, userId: verified.payload.userId };
}
