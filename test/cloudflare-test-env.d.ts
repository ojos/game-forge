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
      /** `vitest.config.ts` が Node 側で読み込んだ `.dev.vars.example` の中身。 */
      readonly TEST_DEV_VARS_EXAMPLE: string;
      /** `vitest.config.ts` が Node 側で読み込んだ仕様書の中身。 */
      readonly TEST_PRODUCT_SPEC: string;
      /** 隔離ビルドの vendor 焼き込み対象（`docker/isolated-build/template/vendor-deps.go`）。 */
      readonly TEST_VENDOR_DEPS: string;
      /** 隔離ビルドの検査用サンプル（`docker/isolated-build/sample/ebitengine.go`）。 */
      readonly TEST_BUILD_SAMPLE: string;
      /** `wrangler.toml` の中身。本番の宣言値をテストから読むために渡している（#89）。 */
      readonly TEST_WRANGLER_TOML: string;
      /**
       * `.dev.vars.example` の中身（`vitest.config.ts` の `textBlobBindings`）。
       *
       * 文書化された秘密の名前を、書き写さずにテストから引くために渡している
       * （test/worker.test.ts の env キー検査）。
       */
      readonly TEST_DEV_VARS_EXAMPLE: string;
    }
  }
}

export {};
