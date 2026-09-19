/**
 * 機械が読める口（#694 / M18-1）で「誰が呼んでいるか」を決める 1 か所。
 *
 * ## なぜ `resolveSessionUser` を直接呼ばないのか
 *
 * **いまは同じものである。** 認証は cookie のセッションだけで、判定（署名・BAN・退会）は
 * `src/session-user.ts` の {@link resolveSessionUser} がすべて持つ。
 *
 * **それでも 1 枚挟むのは、M19（#696）で MCP のトークンを差し込む場所をここに決めておくため
 * である。** トークンを受けるようになったとき、口ごとに「cookie か、トークンか」を書き分けると、
 * 片方だけ BAN や退会の検査が抜ける差分が生まれても動作では気づけない（`src/session-user.ts` の
 * 「なぜ 1 か所に置くか」と同じ理由）。**機械が読める口は、すべてこの関数から呼び出し元を得る**
 * ——生成（`src/generate.ts`）・推敲（`src/revise.ts`）・自作の読み取り（`src/works-api.ts`）。
 *
 * **画面の経路はここを通さない。** 画面は cookie でしか動かず、トークンを受ける予定も無い。
 * 画面まで巻き込むと、M19 でトークンを足した日に、画面の POST がトークンで叩けるようになる。
 *
 * **失敗の理由は持たない**（{@link SessionUserResolution} と同じ。区別できる応答を返すと、
 * 任意の id が生きているかを外から確かめる手がかりになる）。
 */
import { resolveSessionUser, type SessionUserResolution } from './session-user.js';

/** 呼び出し元の解決の結果。 */
export type ApiCaller = SessionUserResolution;

/**
 * 機械が読める口の呼び出し元を解決する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 利用者の id、または拒否
 * @throws `SESSION_SECRET` が未設定・短すぎる場合（`src/session.ts` の `importKey`）
 */
export async function resolveApiCaller(request: Request, env: Env): Promise<ApiCaller> {
  return await resolveSessionUser(request, env);
}
