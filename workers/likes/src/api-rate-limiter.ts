/**
 * 機械が読める口の呼び出しの上限を数える入口（#699 / M19-2。仕様 5.13）。
 *
 * # なぜ `game-forge-likes` に置くのか
 *
 * **アプリ本体（Pages Functions）は Rate Limiting のバインディングを持てない**（`src/likes.ts` の
 * 「連打の防波堤を置いていない」。Pages の宣言は `ratelimits` を知らないキーとして落とす）。
 * そこで**バインディングはこの Worker が持ち**、Pages は Service binding の RPC でここを呼ぶ
 * （ルートの `wrangler.toml` の `API_RATE_LIMITER`。利用者の決定 2026-09-19）。
 *
 * Worker を新しく立てずにここへ載せたのは、**Pages が既に「Pages より先に配る」順序で結線している
 * 唯一の Worker** だからである（`.github/workflows/verify.yml` の deploy ジョブ）。配る段・検査
 * （`scripts/check-likes-worker.sh`）・トークンの権限を増やさずに済む。
 *
 * # 公開の入口ではない
 *
 * **名前付きの入口（`WorkerEntrypoint`）は Service binding からしか呼べない。** `workers_dev` /
 * `preview_urls` / `routes` の閉じ方は変えていない（`workers/likes/wrangler.toml`）。受け取るのは
 * 数える鍵だけで、いいねの DO のように id を信じて書き込む操作は無い。
 *
 * # 数えるだけで、断るかは呼び出し側が決める
 *
 * 返すのは「まだ上限の内側か」だけである。**呼べなかったときに通す（fail-open）かどうかは Pages 側**
 * （`src/api-rate-limit.ts`）が決める——ここは例外を投げ返すだけにしておく。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * 上限のバインディングの名前（`workers/likes/wrangler.toml` の `[[ratelimits]]`）。
 *
 * **値（60 秒あたり 60 回）は宣言が持つ**（`simple = { limit = 60, period = 60 }`）。
 * 仕様 5.13 と宣言の一致は `scripts/check-likes-worker.sh` が見る。
 */
export interface ApiRateLimiterEnv {
  /** Workers Rate Limiting。**鍵ごとに、この Worker が動く拠点の中で数える**（緩く・結果整合）。 */
  readonly API_RATE_LIMIT: RateLimit;
}

/**
 * 機械が読める口の上限を数える RPC の入口。
 *
 * Pages からは `env.API_RATE_LIMITER.allow(key)` で呼ばれる（`src/api-rate-limit.ts` だけが呼ぶ）。
 */
export class ApiRateLimiter extends WorkerEntrypoint<ApiRateLimiterEnv> {
  /**
   * 1 回分を数え、上限の内側かを返す。
   *
   * @param key 数える鍵（Pages 側で「口の名前:利用者の id」の形にしたもの）
   * @returns 上限の内側なら true、超えていれば false
   * @throws バインディングが無い・数えられなかった場合（呼び出し側が通すかを決める）
   */
  async allow(key: string): Promise<boolean> {
    const { success } = await this.env.API_RATE_LIMIT.limit({ key });
    return success;
  }
}
