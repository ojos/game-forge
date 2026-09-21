/**
 * `game-forge-cleanup` の入口（#518 / M15-3。土台は #586 / M15-3a）。
 *
 * **この Worker の仕事は 3 つだけである。**
 *
 * 1. Durable Object {@link WithdrawalHub} を載せる（**Pages は DO のクラスを自分で持てない**。
 *    `docs/likes.md` と同じ事情）
 * 2. **cron（5 分ごと）で DO を起こす**（`workers/cleanup/wrangler.toml` の `[triggers]`）
 * 3. **同じ cron で、止まったまま残った生成・推敲の行を `failed` に畳む**（#681。
 *    `src/stale-generation-sweep.ts`。D1 の条件付き UPDATE 2 本だけで、R2 には触らない）
 * 4. **同じ cron で、最後に使ってから 30 日を過ぎたチャットの会話を消す**（#695 / 仕様 5.16。
 *    `src/chat-conversation.ts`。D1 の DELETE 1 本だけ。`/privacy` に書いた保存期間を守るのは
 *    この 1 本である）
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
import { sweepExpiredChatConversations } from '../../../src/chat-conversation.js';
import { sweepStaleGenerations } from '../../../src/stale-generation-sweep.js';
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
   * cron（5 分ごと）で DO を起こし、止まった生成・推敲の行を畳む（#681）。
   *
   * **待たない形にしない。** `scheduled` の戻り値を待たせておくと、起こし損ねたことが
   * ログに出る（起こせなければ cron の実行が失敗として記録される）。
   *
   * **2 つは互いを止めない。** 片方が投げても、もう片方は最後まで走らせてから投げ直す
   * （退会の後続の処理と、止まった行の掃除は無関係である）。
   *
   * **時刻は cron の予定時刻から取る**（`scheduledTime`）。テストが区切りの内外を時刻で作れる。
   *
   * @param controller cron の実行情報（`scheduledTime` だけを読む）
   * @param env バインディング
   */
  async scheduled(controller: ScheduledController, env: CleanupEnv): Promise<void> {
    const id = env.WITHDRAWAL_HUB.idFromName(WITHDRAWAL_HUB_INSTANCE);
    const at = Math.floor(controller.scheduledTime / 1000);
    // **3 つは互いを止めない**（下の投げ直しの順序が担保する）。チャットの会話の掃除は
    // 退会の後続の処理とも、止まった行の畳みとも無関係である。
    const [woken, swept, chats] = await Promise.allSettled([
      env.WITHDRAWAL_HUB.get(id).wake(),
      sweepStaleGenerations(env, at),
      sweepExpiredChatConversations(env.DB, at),
    ]);
    if (swept.status === 'fulfilled' && (swept.value.games > 0 || swept.value.revisionJobs > 0)) {
      // **畳んだときだけ出す**（平常時は 0 件で何も出さない。`wrangler tail` で見る）。
      console.log(
        `stale-generation-sweep: games=${swept.value.games} revision_jobs=${swept.value.revisionJobs}`,
      );
    }
    if (chats.status === 'fulfilled' && chats.value > 0) {
      // **消したときだけ出す**（平常時は 0 件）。**利用者の id も本文も出さない**（1.2.54）。
      console.log(`chat-conversation-sweep: deleted=${chats.value}`);
    }
    if (woken.status === 'rejected') {
      throw woken.reason;
    }
    if (swept.status === 'rejected') {
      throw swept.reason;
    }
    if (chats.status === 'rejected') {
      throw chats.reason;
    }
  },
} satisfies ExportedHandler<CleanupEnv>;
