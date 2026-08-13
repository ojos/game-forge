# ローカル開発環境の手順書

- 対象: M0.5-3（issue #51）
- 位置づけ: **クラウド環境は本番のみ。開発はローカルで完結する**（確定20 / 仕様書 9.1）。
  この文書だけを見て、クリーンな環境から同じ状態を再現できることを目標とする。

---

## 1. 前提

| 要件 | 版（検証時） | 備考 |
|---|---|---|
| Node.js | 22 以上（実測 24.18.1） | `package.json` の `engines` で宣言 |
| Docker | Server 28.5.1 | 隔離ビルドに使う。devcontainer は docker-outside-of-docker |
| OpenSSL | 3.0.13 | ローカル HTTPS の自己署名証明書に使う |
| 名前解決 | `*.localtest.me` が 127.0.0.1 に解決すること | 公開 DNS が返す。オフライン時は 5 章 |

devcontainer を使う場合、これらはすべて用意済みである。

---

## 2. セットアップ

```bash
npm ci
```

`npm ci` の `prepare` が `worker-configuration.d.ts`（`wrangler.toml` から生成する
バインディングの型定義）を作る。14,000 行超の生成物なので追跡していない
（共通規範「再生成できる大容量の生成物はコミットしない」）。

### `npm ci` で install script の警告が出る場合

npm 11 は依存パッケージの install script を既定で実行しない。`esbuild` と `workerd` は
バイナリの配置に install script を使うため、許可が要る。許可は
`package.json` の `allowScripts` に**バージョン付きで**記録済みであり、追跡対象に入っている。

```json
"allowScripts": {
  "esbuild@0.28.1": true,
  "workerd@1.20260804.1": true
}
```

バージョンを上げたときは再度の許可が要る（`npm approve-scripts esbuild workerd`）。
これは手間ではなく安全装置として扱う。ピン留めを外すと、更新のたびに未検証の
install script が黙って走る経路ができる。

### シークレットの置き場所

アプリケーションが読む値は **`.dev.vars`** に置く。`.env` ではない。

```bash
cp .dev.vars.example .dev.vars
```

- `.env` は**このリポジトリの開発ツール**向け（`gh` の `GH_TOKEN`、第二意見の
  `GEMINI_API_KEY` など）。アプリケーションが読むものではない。
- **wrangler は既定でリポジトリ直下の `.env` をシークレットとして Worker へ流し込む**
  （`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` の既定が `true`）。この経路は
  `package.json` の各 script と `scripts/dev-server.sh` で明示的に止めてある。
  止めないと `GH_TOKEN` がアプリのコードから読める状態になり、`wrangler deploy` では
  本番の secret としてアップロードされうる。
- 止め忘れは `npm test` が落として知らせる（`test/worker.test.ts` の
  「env のキーが wrangler.toml と `.dev.vars.example` の宣言だけで構成される」）。
  この検査が許容するのは、`wrangler.toml` の `[vars]` / バインディングと、
  **`.dev.vars.example` に書かれている名前**だけ。許容する一覧はテストへ書き写さず、
  雛形そのものを読んで判定する（雛形に鍵を足せば自動で追随し、`.env` 側のキーは
  雛形に無いため従来どおり落ちる）。

`.dev.vars` は `.gitignore` で除外済みで、除外が効いていることは
`scripts/acceptance.sh` が毎回検査する。

**Dev 組織の API キーは 2026-08-12 時点でまだ発行できない。** M0.5-1（#49）で
Claude Platform on AWS のサインアップが AWS 側の理由で完了していないため。
`ANTHROPIC_API_KEY` は空のままでよく、`wrangler dev` は起動する。

**ログインを手元で試すには `SESSION_SECRET` と Google の OAuth クライアントが要る**
（#12 / 8.1）。値の作り方は `.dev.vars.example` のコメントに書いてある。空のままでも
`wrangler dev` は起動し、`/auth/google/start` と `/auth/google/callback` が 503 を
返すだけになる（設定が無いときに認証を素通しさせないため）。ログアウト
（`POST /auth/logout`）は cookie を消すだけなので、設定が無くても動く。

---

## 3. 起動

### D1 スキーマの適用

初回と、`migrations/` を更新したときに実行します。

```bash
npm run db:migrate        # migrations/ をローカル D1 へ適用
npm run db:migrate:list   # 未適用のマイグレーションを確認
```

- **冪等です。** 適用済みの一覧は D1 側の `d1_migrations` テーブルに記録され、
  2 回目以降は `No migrations to apply!` を返します。SQL 側に `IF NOT EXISTS` を
  書いていないのは、途中で中断したマイグレーションの再実行を「成功」として
  通さないためです（`migrations/0001_init.sql` の冒頭）。
- `--local` 固定です。リモートの D1 はまだ作っていません（`wrangler.toml` の
  `database_id` は placeholder）。
- **テストは別経路です。** `npm test` は `vitest.config.ts` が Node 側で読んだ
  マイグレーションを `TEST_MIGRATIONS` として注入し、`test/helpers/schema.ts` の
  `applySchema()` が適用します。ここで `npm run db:migrate` を先に実行する必要は
  ありません（workerd 内にファイルシステムが無いため、値として渡すのが唯一の経路）。

### 起動

```bash
npm run dev
```

- アプリ: <https://game-forge.localtest.me:8787/>
- サンドボックス: <https://sandbox.game-forge.localtest.me:8787/>

ポートを変えるときは `PORT=9000 npm run dev`。

初回は `scripts/dev-certs.sh` が自己署名証明書を `certs/` に作る（冪等。既存の
証明書が有効で必要な SAN を含んでいれば作り直さない）。**自己署名なのでブラウザは
初回に警告を出す。** `curl` からは `--cacert certs/dev.crt` で検証できる。

### なぜ HTTPS が要るか

`__Host-` 接頭辞の cookie は 7.2 の必須要件（2 点目）だが、ブラウザは `Secure` 属性の
ついた cookie だけを受理し、`Secure` は安全なコンテキストを要求する。
`http://localhost` は例外的に安全なコンテキストとして扱われるが、
**`*.localtest.me` は該当しない。** 同一サイトの再現に `localtest.me` を使う以上、
証明書は避けて通れない。

### なぜ 1 プロセスで 2 つのホストなのか

オリジンはスキーム・**ホスト**・ポートで決まる。同じポートでもホスト名が違えば
別オリジンになる。7.2 が要求するのは別オリジンであって別ポートではない。
`src/index.ts` が `Host` ヘッダで出し分ける。

### 動作確認

| URL | 返すもの |
|---|---|
| `/__dev/health` | D1 / R2 の疎通と、ホスト名の関係の判定 |
| `/__dev/session` | `__Host-gf_dev_session` cookie を発行 |
| `/__dev/cookies` | 届いた cookie の**名前だけ**（値は返さない） |

---

## 4. 検証

| コマンド | 何を確かめるか | 所要 | 前提 |
|---|---|---|---|
| `bash scripts/verify.sh` | ローカル層の受け入れ条件すべて（機密検査・テスト・型・型定義の照合） | 数秒 | なし |
| `npm run check:origins` | 別オリジン・同一サイト・`__Host-`・CSP を**実際に起動して**確認 | 約 20 秒 | なし |
| `npm run check:isolated-build` | 7.1 の封じ込め下で隔離ビルドが通ること | 約 6 秒（`golang:1.26.5` 取得済みの場合）。未取得なら取得時間が乗る | Docker（`golang:1.26.5` の取得にネットワーク） |

`npm run check:origins` と `npm run check:isolated-build` は `scripts/verify.sh` には
含めない。前者は約 20 秒かかり反復の信号としては重く、後者は Docker とイメージ取得を
要するためである（`.github/project-ai-rules.md`「受け入れ検証の二層」）。

### `npm run check:origins` が確かめること

自己署名証明書で `wrangler dev` を起動し、自分で止める。起動済みのサーバへ相乗りしない
（相乗りすると、古いコードのまま緑になる経路ができる）。

- 両ホストが解決し、**別オリジン**かつ**同一サイト**であること
- 証明書が両ホストを検証できること（`-k` では通さない。SAN 不足を見逃すため）
- `__Host-` cookie を**クライアントが実際に受理する**こと
- その cookie が**サンドボックス用ホストへは送られない**こと ← 7.2 の眼目
- サンドボックス側が `CSP: sandbox allow-scripts` を返し、`allow-same-origin` を含まず、
  cookie を一切設定しないこと

### `npm run check:isolated-build` が確かめること

7.1 が「選択肢ではなく前提条件」と書いた制約のもとで `go build` が通ること。加えて、
**制約が実際に効いていること自体**を個別に確かめる。ビルドが成功しただけでは、
`--network=none` が外れていても気づけないためである。

- 封じ込め下でビルドが成功し、成果物が wasm であること
- 実行ユーザーが uid 65534 であること
- 経路表が空で `eth` 系インターフェイスが無いこと（`--network=none`）
- **root でも**ルートファイルシステムへ書けないこと（`--read-only`）
- `/tmp`・`/work`・`/cache` の 3 か所は書けること
- vendor が `/src` に焼かれ `/work` へ複製されていること（7.1 の前提 1）
- 壊れたソースが**失敗すること**

---

## 5. 既知の制約と注意

### 5.1 ローカルで検証できないもの（仕様書 9.1）

R2 ライフサイクルルール / D1 書き込み無料枠の枯渇 / OGP のクローラ検証 /
Resend の SPF・DKIM 到達性 / 実ドメインでの CSP・cookie 挙動。
いずれもクローズドβで踏むことを受け入れる。

### 5.2 コンテナの標準出力でバイナリを運ばない（実測）

隔離ビルドの成果物は **base64 で受け渡す**。生バイナリを使わないのは、
経路が 2 通りとも壊れることを実測で確認したためである。

| 経路 | 症状 |
|---|---|
| `docker run` の attach | **無音で落ちる。** ビルドキャッシュが空の状態で `go build` を回すと、ビルド開始前の出力は届くのに以降の標準出力・標準エラーがすべて失われた。**終了コードは 0 のまま。** `--pids-limit` / `--memory` / `--cpus` とは無関係で、全部外しても再現した |
| `docker logs` | **バイト列が壊れる。** json-file ログドライバは値を UTF-8 文字列として保持するため、1,802,361 バイトの wasm が 2,260,527 バイトになった |

対策は 2 段構えにしてある。

1. `scripts/check-isolated-build.sh` は計測前に**暖機実行**を 1 回入れる（キャッシュが
   温まっていれば再現しない）。これがないと、設定が正しいのに初回だけ赤が出る。
2. コンテナが自分でバイト数と sha256 を標準エラーへ申告し、受け取り側が照合する。
   切り詰めが起きれば必ず落ちる。

**M2-5（VPS ビルド API）へ引き継ぐこと: 成果物の受け渡しで終了コードだけを信用しない。**

### 5.3 devcontainer では bind mount が使えない

devcontainer は docker-outside-of-docker 構成で、`/workspaces/game-forge` の実体は
ホスト側の別パスにある。コンテナ内のパスを `-v` に渡しても解決しない。
隔離ビルドが標準入出力でソースと成果物をやりとりするのはこのためでもある
（本来の理由は 7.1 の「ホストのファイルシステムを攻撃者が制御しうるコードへ
差し出さない」）。本番の VPS も同じ形になる。

### 5.4 CSP の `connect-src 'none'` と wasm 配信の衝突（M4-3 で解消する）

7.2 は `connect-src 'none'` まで絞ることを求める一方、3.4 は
`WebAssembly.instantiateStreaming` の使用を求める。`instantiateStreaming` は `fetch`
経由で `.wasm.br` を取得するため、その取得は `connect-src` の管轄に入る。さらに
`sandbox allow-scripts`（`allow-same-origin` なし）で不透明オリジンになるため、
`connect-src 'self'` も一致しない。

**M0.5-3 のプレースホルダは wasm を読まないため、7.2 の記述どおり `'none'` のまま
置いてある。** 実際に wasm を配信する M4-3 で、配信元ホストの明示列挙などの解決が要る。

### 5.5 `wrangler.toml` を変えたら型を作り直す

```bash
npm run types
```

`worker-configuration.d.ts` は追跡していないが、`wrangler.toml` を変えたのに再生成
しないと、手元のファイルが古い一覧のまま型検査を通してしまう。`scripts/verify.sh` が
生成し直した結果と突き合わせ、差があれば落とす
（shared-ai-rules 12 章「一覧の複製は機械照合で担保する」）。

### 5.6 D1 は一部の組み込み関数を拒否する

疎通確認に `sqlite_version()` は使えない（`not authorized to use function: sqlite_version`）。
`src/app.ts` は `sqlite_master` の読み出しで疎通を確認している。定数の `select 1` では
SQL が通ることしか分からず、ストレージ層へ到達したかを確かめられないためでもある。

### 5.7 オフラインで作業する場合

`*.localtest.me` の解決は公開 DNS に依存する。オフラインなら `/etc/hosts` に足す。

```
127.0.0.1 game-forge.localtest.me sandbox.game-forge.localtest.me
```

`npm ci` と隔離ビルドイメージの初回取得にはネットワークが要る。

---

## 6. この段階で作っていないもの

M1 以降が所有する。ここで先に作らない。

| 対象 | 所有する issue |
|---|---|
| Next.js / Cloudflare Pages の雛形 | 未起票（9.3 が「API を Pages Functions に置くかは M2-1 で確定する」としているため、構成が決まってから） |
| Ebitengine の vendor 焼き込みと VPS への自動デプロイ | M2-4 |
| ビルドの同時実行制御・タイムアウト・結果キャッシュ | M2-5 |
| 本番向けの `wrangler.toml`（routes / custom domain / 実際の D1 database_id） | 対応する issue が来た時点 |
