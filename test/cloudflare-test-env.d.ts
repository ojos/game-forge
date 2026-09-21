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
      /**
       * 退会の後続の処理の DO（`workers/cleanup/src/hub.ts` の `WithdrawalHub`。#586）。
       *
       * **本番では Pages がこの DO を指さない**（起こすのは `game-forge-cleanup` 自身の cron で、
       * ルートの `wrangler.toml` に宣言は無い。`scripts/check-cleanup-worker.sh` が「無いこと」を
       * 確かめる）。テストでアラームの結線を中から確かめる手段が `runDurableObjectAlarm` しか
       * 無いため、`vitest.config.ts` が実行体へ差し替えたぶんだけをここで型に足す。
       */
      readonly WITHDRAWAL_HUB: DurableObjectNamespace;
      /** `vitest.config.ts` が Node 側で読み込んだマイグレーション。 */
      readonly TEST_MIGRATIONS: D1Migration[];
      /** `vitest.config.ts` が Node 側で読み込んだ `.dev.vars.example` の中身。 */
      readonly TEST_DEV_VARS_EXAMPLE: string;
      /** `vitest.config.ts` が Node 側で読み込んだ仕様書の中身。 */
      readonly TEST_PRODUCT_SPEC: string;
      /**
       * チャットの会話を 1 人 1 本へ畳む移行（`migrations/0052_chat_one_per_work.sql`）。
       *
       * 「いちばん新しい 1 本」の決め方を、実行時の `LATEST_CHAT_ORDER` と機械照合するために
       * 本文そのものを渡している（#740）。
       */
      readonly TEST_CHAT_ONE_PER_WORK_MIGRATION: string;
      /** 隔離ビルドの vendor 焼き込み対象（`docker/isolated-build/template/vendor-deps.go`）。 */
      readonly TEST_VENDOR_DEPS: string;
      /** 隔離ビルドの検査用サンプル（`docker/isolated-build/sample/ebitengine.go`）。 */
      readonly TEST_BUILD_SAMPLE: string;
      /**
       * 隔離ビルドのテンプレートのモジュール宣言（`docker/isolated-build/template/go.mod`）。
       *
       * `src/go-import-allowlist.ts` の `TEMPLATE_MODULE_PATH` は `module` 行の写しで、
       * workerd 内からはこのファイルを読めない。写しの一致を機械照合するために渡している
       * （#285 / #298）。
       */
      readonly TEST_TEMPLATE_GO_MOD: string;
      /** `wrangler.toml` の中身。本番の宣言値をテストから読むために渡している（#89）。 */
      readonly TEST_WRANGLER_TOML: string;
      /**
       * 見た目の土台（`public/assets/app.css`）の中身。
       *
       * CSS からは `src/ogp.ts` の定数を読めないため、作品枠の縦横比が写しになる。
       * その一致を機械照合するために渡している（#266）。
       */
      readonly TEST_APP_CSS: string;
      /**
       * Pages の経路振り分け宣言（`public/_routes.json`）の中身。
       *
       * `exclude` から外れたパスは、`public/` に実体があっても Functions が飲み込む
       * （#266 で実測）。その回帰を捕まえるために渡している。
       */
      readonly TEST_ROUTES_JSON: string;
      /**
       * オーケストレータの宣言（`terraform/orchestrator.tf`）の中身。
       *
       * 止まった生成を畳む区切り（`src/stale-generation-sweep.ts`）が、`maximum_event_age` ＋ `timeout` の
       * 外側にあることを照合するために渡している（#681）。
       */
      readonly TEST_ORCHESTRATOR_TF: string;
      /**
       * いいねの Worker の宣言（`workers/likes/wrangler.toml`）の中身。
       *
       * 機械が読める口の上限（`[[ratelimits]]`）が、テストで注入する値・仕様・`src/api-rate-limit.ts` の値と
       * 同じであることを照合するために渡している（#699）。
       */
      readonly TEST_LIKES_WRANGLER_TOML: string;
      /** 上限の入口が読む Rate Limiting（`vitest.config.ts` が注入する。本番では `game-forge-likes` が持つ。#699）。 */
      readonly API_RATE_LIMIT: RateLimit;
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
