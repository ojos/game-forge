import { defaultExclude, defineConfig } from 'vitest/config';
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
      // エントリを明示する。**Pages の構成には `main` が無い**（`functions/` を
      // wrangler が束ねる）ため、`SELF.fetch` を使うテストが
      // 「service bindings to the current worker requires main」で落ちる（実測）。
      //
      // **既定の輸出は、本番で `functions/[[path]].ts` が呼ぶのと同じモジュール
      // （`src/index.ts`）である。** `workers/likes/test-entry.ts` はそれをそのまま
      // 再輸出し、いいねの DO（`LikeHub`）を横に並べるだけである（#339。理由は同ファイルの
      // 冒頭——本番では別スクリプトだが、Miniflare では 2 本目を TypeScript のまま
      // 動かせず、`runInDurableObject` も自分自身の DO にしか使えない）。
      main: './workers/likes/test-entry.ts',
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // `wrangler.toml` の `LIKE_HUB` は `script_name = "game-forge-likes"`（別スクリプト）を
        // 指す。テストではそれを**自分自身の SQLite 版 DO** へ差し替える（#339）。
        // `useSQLite` を落とすと `ctx.storage.sql` が使えず、本番（`new_sqlite_classes`）と
        // 違う保存形式で走ることになる。
        // `PLAY_HUB`（プレイ数。#377）も同じ理由で同じ差し替えをする。
        //
        // `WITHDRAWAL_HUB`（退会の後続の処理。#586 / `workers/cleanup/`）は事情が違う。
        // **本番では Pages がこの DO を指さない**——起こすのは同じ Worker の cron だけで、
        // ルートの `wrangler.toml` に宣言は無い（`scripts/check-cleanup-worker.sh` が
        // 「無いこと」を機械で確かめる）。それでもここへ置くのは、**アラームの結線
        // （`runDurableObjectAlarm`）を中から確かめられるのが自分自身の DO だけ**だからである。
        // 宣言に無いバインディングがテストの env に現れるので、`test/worker.test.ts` の
        // 「env のキーが宣言と一致する」検査の除外一覧にも名前を足してある。
        durableObjects: {
          LIKE_HUB: { className: 'LikeHub', useSQLite: true },
          PLAY_HUB: { className: 'PlayHub', useSQLite: true },
          WITHDRAWAL_HUB: { className: 'WithdrawalHub', useSQLite: true },
        },
        // 機械が読める口の上限（#699）。`wrangler.toml` の `API_RATE_LIMITER` は別スクリプト
        // （`game-forge-likes`）の名前付きの入口を指す。テストでは**自分自身の同じ入口**へ差し替える
        // （`name` に Pages の名前を書くと、プールが自分自身へ読み替える）。入口のクラスは
        // `workers/likes/test-entry.ts` が並べて輸出している。**Service binding の RPC で呼ぶ経路そのもの**
        // はここで通る——失うのは「別スクリプトを指す結線」の検証だけである（`LIKE_HUB` と同じ）。
        serviceBindings: {
          API_RATE_LIMITER: { name: 'game-forge', entrypoint: 'ApiRateLimiter' },
        },
        // 入口が読む Rate Limiting（本番では `workers/likes/wrangler.toml` の `[[ratelimits]]`）。**Pages の宣言には
        // 無い**ので、テストの env に現れる宣言外の名前として `test/worker.test.ts` の除外一覧に足してある。
        // 値は宣言と同じにする（`test/public-works-api.test.ts` が宣言から読んで照合する）。
        ratelimits: {
          API_RATE_LIMIT: { namespace_id: '699', simple: { limit: 60, period: 60 } },
        },
        bindings: { TEST_MIGRATIONS: migrations },
        // `.dev.vars.example` の中身をテキストとして渡す。
        //
        // test/worker.test.ts の「env のキーが宣言と一致する」検査は、`.dev.vars` を
        // 置いた開発者の環境ではアプリ向けの秘密が env に現れるため、そのままでは
        // 落ちる。文書化された秘密名だけを許容したいが、その一覧をテスト側へ書き写すと
        // 「文書が実装の一覧を書き写している」構造そのものになり、
        // `.dev.vars.example` に鍵を足した日から静かにずれる
        // （shared-ai-rules.md 12 章）。雛形そのものを渡し、テスト側で名前を
        // 取り出せば、複製は生まれない。
        //
        // `bindings` ではなく `textBlobBindings` を使うのは、ファイルの読み込みを
        // miniflare 側へ任せるため。この設定ファイルは tsc の検査対象で、
        // `@types/node` が入っていないため `node:fs` を import すると型検査が落ちる。
        textBlobBindings: {
          TEST_DEV_VARS_EXAMPLE: '.dev.vars.example',
          // 仕様書 6.1 の許可パッケージ一覧を、コード側の一覧と機械照合するために渡す
          // （#17 / shared-ai-rules 12 章）。一覧をテストへ書き写すと、照合したい
          // 二重管理そのものをテスト側で作り直すことになる。
          TEST_PRODUCT_SPEC: 'docs/product-spec.md',
          // 隔離ビルドの vendor 焼き込み対象と、それを実際にビルドする検査用サンプル。
          // どちらも許可パッケージ一覧の複製にあたるため機械照合する（#18）。
          TEST_VENDOR_DEPS: 'docker/isolated-build/template/vendor-deps.go',
          TEST_BUILD_SAMPLE: 'docker/isolated-build/sample/ebitengine.go',
          // テンプレートのモジュール宣言。`src/go-import-allowlist.ts` の
          // `TEMPLATE_MODULE_PATH` はこの `module` 行の写しなので機械照合する
          // （#285 / #298）。写しであることが記述にしか無いと、ずれたときに
          // 「なぜ vendor 照合が赤いのか」からしか辿れない。
          TEST_TEMPLATE_GO_MOD: 'docker/isolated-build/template/go.mod',
          // 本番のホスト名と DEV_ROUTES の宣言を、テストから宣言そのものとして読むために
          // 渡す（#89 / test/origins.test.ts）。期待値をテストへ書き写すと、宣言を
          // 変えたときにテストだけが古い値を見続ける。
          TEST_WRANGLER_TOML: 'wrangler.toml',
          // 見た目の土台。作品枠の縦横比が `src/ogp.ts` の定数の写しになるため、
          // その一致をテストから照合する（#266）。CSS は定数を読めない。
          TEST_APP_CSS: 'public/assets/app.css',
          // どの要求が Functions へ行くかを決める宣言。app.css が exclude から
          // 外れると、実体があっても 404 になる（#266 で実測）。機械照合する。
          TEST_ROUTES_JSON: 'public/_routes.json',
          // オーケストレータの非同期呼び出しの宣言（`maximum_event_age` と `timeout`）。止まった生成を
          // 畳む区切り（`src/stale-generation-sweep.ts`）が、コールバックの届きうる時間の外側にあることを
          // 照合する（#681）。値をテストへ書き写すと、terraform を変えた日にテストだけが古い値を見続ける。
          TEST_ORCHESTRATOR_TF: 'terraform/orchestrator.tf',
          // いいねの Worker の宣言（#699）。上の `ratelimits` の値が本番の `[[ratelimits]]` と同じであることを照合する。
          TEST_LIKES_WRANGLER_TOML: 'workers/likes/wrangler.toml',
        },
      },
    }),
  ],
  test: {
    /**
     * 並列実装用の作業ツリー（`.claude/worktrees/`）を探索対象から外す。
     *
     * 中身はリポジトリ全体のチェックアウトそのもので、他レーンの作業中ブランチが
     * 入っている。除外しないと vitest がそれらのテストまで拾い、しかも
     * `configPath: './wrangler.toml'` の解決はこの設定ファイルの位置が基準なので、
     * **他ブランチのテストがルートの `wrangler.toml` と `migrations/` で走る**。
     * 他レーンが足したテーブルやバインディングは当然ルートに無いため、そのレーンの
     * 作業が正しくても落ちる。
     *
     * 結果として `scripts/verify.sh`（ループの接地信号）が、検証対象の変更とは
     * 無関係な理由で赤になる。接地信号は迂回できないことに意味があるので、
     * 偽陽性を出す経路は塞ぐ（shared-ai-rules.md 12 章）。
     *
     * 既定の除外を捨てないよう defaultExclude を展開してから足す。
     */
    //
    // **`lambda/` も外す**（#380）。中身は AWS Lambda（Node）のコードとそのテストで、sharp（ネイティブの
    // ライブラリ）を import するので workerd では動かない。`scripts/acceptance.sh` が `node --test` で回す。
    exclude: [...defaultExclude, '**/.claude/worktrees/**', 'lambda/**'],
  },
});
