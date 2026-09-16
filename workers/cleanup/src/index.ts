/**
 * `game-forge-cleanup` の入口（#518 / M15-3。土台は #586 / M15-3a）。
 *
 * **この Worker の仕事は 2 つだけである。**
 *
 * 1. Durable Object {@link WithdrawalHub} を載せる（**Pages は DO のクラスを自分で持てない**。
 *    `docs/likes.md` と同じ事情）
 * 2. **cron（5 分ごと）で DO を起こす**（`workers/cleanup/wrangler.toml` の `[triggers]`）
 *
 * # `fetch` は何も受け取らない
 *
 * **公開の入口を持たせない**（`workers_dev = false`・`preview_urls = false`・ルートなし。
 * `scripts/check-cleanup-worker.sh` が宣言を機械で見る）。それでも既定の輸出に `fetch` を
 * 置くのは、`workers/likes/src/index.ts` と同じ理由——DO と `scheduled` だけを輸出する Worker を
 * 配備が受け付けるかを公式の記述で確かめられなかったためで、**中身は要求を読まずに 404 を
 * 返すだけ**である。
 *
 * **ここで利用者 id や作品 id を受け取る口を作らないこと。** この Worker は R2 のバケット全体を
 * 消せる資格情報を持つ。誰を消すかを決めるのは D1 の状態だけでなければならない。
 *
 * # cron が止まっても、退会は失われない
 *
 * 状態の正本は D1（`users` の 3 列と `games.purged_at`）である。cron が数回抜けても、
 * 次に起きた回が同じ候補を拾い直す。**運営が進み具合を見る手段は
 * `scripts/withdrawal-status.sh`**（読み取りだけ）。
 */
import { WITHDRAWAL_HUB_INSTANCE } from './hub.js';
import type { CleanupEnv } from './hub.js';

export { WithdrawalHub } from './hub.js';

export default {
  /**
   * 何も受け付けない。
   *
   * @returns 常に 404
   */
  fetch(): Response {
    return new Response('Not Found', { status: 404 });
  },

  /**
   * cron（5 分ごと）で DO を起こす。
   *
   * **待たない形にしない。** `scheduled` の戻り値を待たせておくと、起こし損ねたことが
   * ログに出る（起こせなければ cron の実行が失敗として記録される）。
   *
   * @param _controller cron の実行情報（使わない）
   * @param env バインディング
   */
  async scheduled(_controller: ScheduledController, env: CleanupEnv): Promise<void> {
    const id = env.WITHDRAWAL_HUB.idFromName(WITHDRAWAL_HUB_INSTANCE);
    await env.WITHDRAWAL_HUB.get(id).wake();
  },
} satisfies ExportedHandler<CleanupEnv>;
