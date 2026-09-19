/**
 * MCP のトークンで呼ばれたときに、トークンの利用者が「今も操作してよいか」を確かめる（#696 / 仕様 5.15）。
 *
 * **トークンの検証（部品。`@cloudflare/workers-oauth-provider`）が答えられるのは「このトークンが発行済みで、
 * 期限内で、この口あてか」まで**である。BAN（7.3）と退会（#518）はトークンを消さずに効かせる決定なので
 * （BAN は戻せる操作。仕様 5.15「トークン」）、**使うたびに D1 の行を見る**。
 *
 * ## 条件は `src/session-user.ts` の `resolveSessionUser` と同じである
 *
 * 行が在る・`banned_at is null`・`withdrawal_started_at is null`（退会を始めた行も拒む）。**2 か所に持つ理由**は、
 * `src/session-user.ts` がオーケストレータの束に入っていることである（`scripts/orchestrator-bundle-changed.sh`）。
 * あちらから D1 の判定だけを切り出すと束の中身が変わり、配り直しまで本番の配備が止まる。そこで束に入らない
 * このモジュールに置き、**2 つの判定が同じ行に同じ答えを返すことを `test/oauth-user.test.ts` が照合する**
 * （片方だけに条件を足すと赤くなる）。退会の列の綴りは `src/withdrawal-sql.ts` の `NOT_WITHDRAWN_SQL` を使う。
 *
 * ## 失敗の理由を返さない
 *
 * 呼ぶ側（MCP の口）が返せるのは 401 だけで、理由を分けて返すと任意の id が生きているかを外から確かめる
 * 手がかりになる（`resolveSessionUser` と同じ判断）。
 */
import { NOT_WITHDRAWN_SQL } from './withdrawal-sql.js';

/**
 * トークンの props に載せた利用者の id が、今も操作してよい利用者かを確かめる。
 *
 * @param db D1
 * @param userId トークンの props の `userId`（型は信用しない）
 * @returns 操作してよければ true（行が無い・BAN・退会を始めた・id の形が違うなら false）
 */
export async function isOAuthUserActive(db: D1Database, userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || userId === '') {
    return false;
  }
  const row = await db
    .prepare(`select 1 as ok from users where id = ? and banned_at is null and ${NOT_WITHDRAWN_SQL}`)
    .bind(userId)
    .first<{ ok: number }>();
  if (row === null) {
    // 理由（不在・BAN・退会）はログにも分けない。id も出さない。
    console.error('[oauth-user] トークンの利用者を受け付けませんでした');
    return false;
  }
  return true;
}
