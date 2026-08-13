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
      // 本番で `functions/[[path]].ts` が呼ぶのと同じモジュールをここでも指す。
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
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
    exclude: [...defaultExclude, '**/.claude/worktrees/**'],
  },
});
