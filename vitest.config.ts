import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * テストは実ランタイム（workerd）上で走らせる。
 *
 * `@cloudflare/vitest-pool-workers` は `wrangler.toml` の宣言をそのまま読み、
 * D1 / R2 をローカルエミュレーションとして結線する。Node 上のモックで代替しないのは、
 * M0.5-3 が検証したいのが「アプリのロジック」ではなく「**環境が動くこと**」だからで、
 * バインディングをモックするとその検証が空になる。
 *
 * 0.21 系は Vite プラグイン（`cloudflareTest`）として組み込む形へ変わっている。
 * 旧 API の `defineWorkersConfig` / `test.poolOptions.workers` は存在しない。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
});
