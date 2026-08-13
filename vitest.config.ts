import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

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

/**
 * マイグレーションの SQL を Node 側で読み、テスト用のバインディングとして渡す。
 *
 * workerd 内にはファイルシステムが無いため、テスト側から `migrations/` を直接読めない。
 * ここで読んで値として渡すのが唯一の経路になる。適用そのものは
 * `test/helpers/schema.ts` が `applyD1Migrations` で行う。
 *
 * この値は `wrangler.toml` の宣言ではなく**テストランナーが注入する**ものなので、
 * `test/worker.test.ts` の「env のキーが宣言と一致する」検査では除外している。
 */
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
});
