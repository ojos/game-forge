/**
 * 機械が読める口の呼び出しの上限（#699 / M19-2。仕様 5.13）。**`env.API_RATE_LIMITER` を読むのはこのファイルだけ**
 * である（`scripts/check-likes-worker.sh` が見る）。
 *
 * # 形
 *
 * ```text
 * 口（src/public-works-api.ts）→ ここ ─ Service binding（RPC）─→ ApiRateLimiter（別 Worker game-forge-likes）
 *                                                                    └ Workers Rate Limiting（60 秒あたり 60 回）
 * ```
 *
 * **Pages は Rate Limiting のバインディングを持てない**（`src/likes.ts` の「連打の防波堤を置いていない」）。
 * だから数えるのは `game-forge-likes` で、ここはそれを呼ぶだけである（利用者の決定 2026-09-19）。
 * 値（60 秒あたり 60 回）の正本は `workers/likes/wrangler.toml` の `[[ratelimits]]` にある。
 *
 * # 呼べなかったときは通す（fail-open）
 *
 * **上限の目的は D1 の読み取りの急増を抑えることである**（3.6。とくに 2 文字以下の検索は公開作品を
 * 全部なめる。2.3.8）。**読むだけの口で、しかも返すのは `/works` の HTML で誰でも見られる情報である。**
 * 数える側（いいねの Worker）の障害で一覧の口まで止めると、守りたいものより失うもののほうが大きい。
 *
 * **握りつぶすが黙らない**——通したことをログに残す（`src/likes.ts` の `LIKES_UNAVAILABLE_REASON` と
 * 同じ考え方）。鍵（利用者の id）はログに出さない。
 *
 * # `src/api-caller.ts` に置かない理由
 *
 * あちらは生成（`src/generate.ts`）から読まれ、**オーケストレータ Lambda の束に入る。** Lambda には
 * このバインディングが無く、束が変わると配り直すまで main の配備が止まる。上限は口の側で呼ぶ。
 */
import type { ApiRateLimiter } from '../workers/likes/src/api-rate-limiter.js';

/** 上限を超えたときの本文（仕様 5.13 の失敗の応答）。 */
export const RATE_LIMITED_BODY = { error: 'rate-limited' } as const;

/**
 * 上限の値（**60 秒あたり 60 回**）。**判定には使わない**——数えるのは向こうの宣言である。
 *
 * 仕様と宣言（`workers/likes/wrangler.toml`）と、この値の一致は `scripts/check-likes-worker.sh` が見る。
 * ここに置くのは、テストと 429 の応答の `Retry-After` が同じ値を読むためである。
 */
export const API_RATE_LIMIT = { limit: 60, periodSeconds: 60 } as const;

/** 呼べなかったときにログへ残す理由（鍵は出さない）。 */
export const API_RATE_LIMITER_UNAVAILABLE = '[api-rate-limit] 上限の入口を呼べなかったので通しました';

/**
 * 1 回分を数え、上限の内側かを返す。
 *
 * **鍵は「口の名前:利用者の id」にする。** 口ごとに数え分けておけば、あとで口を足しても
 * 別の口の呼び出しが枠を食い合わない。
 *
 * @param env バインディングと環境変数
 * @param scope 口の名前（`works` など。鍵の前半）
 * @param userId 呼び出し元（`resolveApiCaller` で確かめた id）
 * @returns 上限の内側なら true。**入口を呼べなかったときも true**（fail-open）
 */
export async function allowApiCall(env: Env, scope: string, userId: string): Promise<boolean> {
  try {
    // 生成物（`worker-configuration.d.ts`）は向こうの入口の型を知らない（`Service /* entrypoint … */`）ので、
    // ここで型を与える（いいねの DO の束縛を `src/likes.ts` が扱うのと同じ形）。
    const limiter = env.API_RATE_LIMITER as unknown as Service<ApiRateLimiter>;
    return await limiter.allow(`${scope}:${userId}`);
  } catch (error) {
    console.warn(`${API_RATE_LIMITER_UNAVAILABLE}（${error instanceof Error ? error.name : typeof error}）`);
    return true;
  }
}
