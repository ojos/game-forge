/**
 * `game-forge-likes` の入口（5.8 / #339）。
 *
 * **この Worker の仕事は Durable Objects `LikeHub` と `PlayHub`（プレイ数。#377）を載せる
 * ことと、機械が読める口の上限を数える RPC の入口 `ApiRateLimiter`（#699）を載せることだけである。**
 * Pages は DO のクラスを自分で持てないので、クラスをここに置き、Pages がバインディング（`script_name`）で
 * 直接呼ぶ。上限の入口は Service binding（ルートの `wrangler.toml` の `API_RATE_LIMITER`）で呼ぶ。
 *
 * # `fetch` は何も受け取らない
 *
 * **公開の入口を持たせない**（`workers_dev = false`・`preview_urls = false`・ルートなし。
 * `workers/likes/wrangler.toml`）。それでも既定の輸出に `fetch` を置くのは、DO だけを
 * 輸出する Worker を配備が受け付けるかを公式の記述で確かめられなかったからで、
 * **中身は要求を読まずに 404 を返すだけ**にしてある。**ここで利用者 id を受け取る口を
 * 作らないこと**——`LikeHub` は受け取った id を信じるので、口を 1 本足すと
 * セッションを持たない呼び出し元が id を偽装できる。
 */
export { LikeHub } from './hub.js';
export { PlayHub } from './play-hub.js';
// 機械が読める口の上限を数える RPC の入口（#699 / 仕様 5.13）。Pages が Service binding で呼ぶ。
// **名前付きの入口で、`fetch` とは別物である**——下の `fetch` が何も受け付けないことは変わらない。
export { ApiRateLimiter } from './api-rate-limiter.js';

export default {
  /**
   * 何も受け付けない。
   *
   * @returns 常に 404
   */
  fetch(): Response {
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler;
