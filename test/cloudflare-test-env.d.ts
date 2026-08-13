import type { D1Migration } from '@cloudflare/vitest-pool-workers';

/**
 * テスト実行時にだけ存在するバインディングの型。
 *
 * `worker-configuration.d.ts` は `wrangler types` の生成物で、`wrangler.toml` の
 * 宣言だけを映す。テストランナーが注入する値をあちらへ書くと、次の生成で消えるうえ、
 * `scripts/check-worker-types.sh` の照合（宣言と生成物の一致）も壊れる。
 * 宣言のマージでこちら側から足す。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** `vitest.config.ts` が Node 側で読み込んだマイグレーション。 */
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
