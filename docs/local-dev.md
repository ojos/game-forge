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

**LLM は Amazon Bedrock を叩く（確定19 / 仕様書 4.1）。** 資格情報は `BEDROCK_AWS_*` の
4 本で、空のままでも `wrangler pages dev` は起動する。

ローカルでは SSO の一時資格情報を流用できる。ただし **export しただけでは効かない。**
`aws configure export-credentials` が出すのは `AWS_*` という別の名前で、しかも Worker が
読むのはシェルの環境変数ではなく `.dev.vars` というファイルである。**値を転記する。**

```bash
eval "$(AWS_PROFILE=game-forge-prod aws configure export-credentials --format env)"
printf 'BEDROCK_AWS_REGION=%s\nBEDROCK_AWS_ACCESS_KEY_ID=%s\nBEDROCK_AWS_SECRET_ACCESS_KEY=%s\nBEDROCK_AWS_SESSION_TOKEN=%s\n' \
  ap-northeast-1 "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN"
```

出力で `.dev.vars` の該当 4 行を置き換える。**SSO の資格情報は数時間で失効する**ので、
`AccessDenied` や `401` が出たら `aws sso login` からやり直して転記し直す。

**Anthropic のキーは使わない。** v0.9 までの `ANTHROPIC_API_KEY` は v1.0（#80）で廃止した。
`BEDROCK_AWS_*` に `AWS_` の接頭辞を付けていないのは、Terraform 用の資格情報と混ざらない
ようにするため（`.dev.vars.example` のコメント）。

**Claude のモデルアクセスは #82 で有効化する。** それまで `anthropic.claude-sonnet-5` は
`AccessDeniedException` になる。`deepseek.v3.2` は agreement 不要で今すぐ叩ける。

**ログインを手元で試すには `SESSION_SECRET` と Google の OAuth クライアントが要る**
（#12 / 8.1）。値の作り方は `.dev.vars.example` のコメントに書いてある。空のままでも
`wrangler pages dev` は起動し、`/auth/google/start` と `/auth/google/callback` が 503 を
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
- `--local` 固定です。**手元の経路が触るのはローカルの D1 だけ**で、`wrangler.toml` の
  `[[d1_databases]]`（既定側）の `database_id` は `local-only-placeholder` のままです。
  `--local` 実行では参照されず、Miniflare がローカルの実体を作ります。
  - ※ **本番の D1 は 2026-08-26 に作成済みです**（`game-forge` / `d81a6f80-…`）。
    宣言は `[env.production]` と `[env.preview]` の側にあり、**適用は
    `--remote` を付けた別の操作**になります（`docs/pages-deploy.md` の「マイグレーションを
    本番 D1 へ適用する」）。**ここで `--remote` を既定にしないこと**が要点で、
    手元の試行が本番のデータへ届く経路を作らないためです。
- **テストは別経路です。** `npm test` は `vitest.config.ts` が Node 側で読んだ
  マイグレーションを `TEST_MIGRATIONS` として注入し、`test/helpers/schema.ts` の
  `applySchema()` が適用します。ここで `npm run db:migrate` を先に実行する必要は
  ありません（workerd 内にファイルシステムが無いため、値として渡すのが唯一の経路）。

### 起動

```bash
npm run dev
```

中身は `wrangler pages dev` です（確定22 / #71）。**`wrangler dev` は使えません** —
Pages 構成に対して「Workers 用のコマンドです」と言って落ちます。配備先を Pages に
した理由は [pages-deploy.md](pages-deploy.md) にあります。

- アプリ: <https://game-forge.localtest.me:8787/>
- 登録画面: <https://game-forge.localtest.me:8787/signup>
- サンドボックス: **`/` は 404 が正しい。** 配信するのは作品の URL だけです
  （下記「サンドボックス側の動作確認」）。

ポートを変えるときは `PORT=9000 npm run dev`。

初回は `scripts/dev-certs.sh` が自己署名証明書を `certs/` に作る（冪等。既存の
証明書が有効で必要な SAN を含んでいれば作り直さない）。**自己署名なのでブラウザは
初回に警告を出す。** `curl` からは `--cacert certs/dev.crt` で検証できる。

### ログインを試す

1. `.dev.vars` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（[gcp-oauth-setup.md](gcp-oauth-setup.md)）と
   `SESSION_SECRET`（32 文字以上の乱数。`openssl rand -base64 48` など）を入れる。
2. **招待コードを 1 枚用意する。** 8.1 の「生成は招待コード保有者のみ」を機構にしているため、
   招待の無い新規アカウントは作られない（`/signup` へ戻される）。

   ```bash
   npx wrangler d1 execute DB --local --command \
     "insert into invites (code, issued_by) values ('SMKETEST0001', '<既存の users.id>')"
   ```

   **コードの文字集合は Crockford Base32 で、`I` `L` `O` `U` を含められない**（`src/invite-code.ts`）。
   含むと正規化で別の文字へ寄り、入力したコードが保存した行に一致しない。
3. <https://game-forge.localtest.me:8787/signup> でコードを入れる。検証を通ると Google の同意画面へ進む。

最初の 1 人だけは招待の発行元が存在しないため、`users` 行を直接入れて起点にする。

### なぜ HTTPS が要るか

`__Host-` 接頭辞の cookie は 7.2 の必須要件（2 点目）だが、ブラウザは `Secure` 属性の
ついた cookie だけを受理し、`Secure` は安全なコンテキストを要求する。
`http://localhost` は例外的に安全なコンテキストとして扱われるが、
**`*.localtest.me` は該当しない。** 同一サイトの再現に `localtest.me` を使う以上、
証明書は避けて通れない。

### 経路の構成

```
functions/[[path]].ts   Pages Functions の入口。src/index.ts の default export を呼ぶだけ
public/                 出力ディレクトリ。空（.gitkeep のみ）
src/index.ts            Host ヘッダでアプリ側とサンドボックス側を出し分ける
src/routes.ts           経路表。各機能が Route[] を持ち寄る
```

**`public/` に静的ファイルを置かないこと。** Pages は静的ファイルを Functions より先に
解決するため、`index.html` を置くと `/` の経路が隠れます。画面はすべて Worker が
生成します。

API のパスは `/api/*` を正とします（確定22）。`scripts/acceptance.sh` が、旧綴りの
`/waitlist` が `src/` と `test/` に残っていないことを毎回検査します。

### なぜ 1 プロセスで 2 つのホストなのか

オリジンはスキーム・**ホスト**・ポートで決まる。同じポートでもホスト名が違えば
別オリジンになる。7.2 が要求するのは別オリジンであって別ポートではない。
`src/index.ts` が `Host` ヘッダで出し分ける。

### 動作確認

アプリ用ホスト（`https://game-forge.localtest.me:8787`）で叩きます。

| URL | 返すもの |
|---|---|
| `/__dev/health` | D1 / R2 の疎通と、ホスト名の関係の判定 |
| `/__dev/session` | `__Host-gf_dev_session` cookie を発行 |
| `/__dev/cookies` | 届いた cookie の**名前だけ**（値は返さない） |

### サンドボックス側の動作確認

**`/` は 404 を返します。これが正しい状態です。** M4-3（#28）でサンドボックス用ホストは
実際の配信を持つようになり、**作品を指す 2 つの接頭辞（`/p/` と `/g/`）の下だけ**を
配信するようになりました。M0.5-3 の頃にあった「sandbox origin」のプレースホルダ画面は
もうありません。

| URL | 何を返すか |
|---|---|
| `/p/<preview_key>/` | draft（作者プレビュー）のローダー文書。`preview_key` は 16 進 32 桁 |
| `/g/<game_id>/` | `status='published'` の作品のローダー文書 |
| `/p/<...>/game.wasm`、`/g/<...>/game.wasm` | R2 の `.wasm.br`（`Content-Type: application/wasm` ＋ `Content-Encoding: br`） |
| `/p/<...>/wasm_exec.js`、`/g/<...>/wasm_exec.js` | `games.go_version` に対応する `wasm_exec.js`（3.5） |
| 上記以外（`/` を含む） | 404 |

#### 1. CSP ヘッダの目視確認（作品が 1 件も無くてもできる）

**M0.5-3 がこのホストに置いた目的はこれで、いまも果たせます。** 7.2 の必須要件 1 は
「配信レスポンスに `Content-Security-Policy: sandbox allow-scripts` を付ける」ことで、
**サンドボックス用ホストはどの経路でも**これを満たします。404 でも付きます。

```bash
curl -s --cacert certs/dev.crt -D - -o /dev/null \
  https://sandbox.game-forge.localtest.me:8787/
```

```text
HTTP/1.1 404 Not Found
content-security-policy: sandbox allow-scripts; default-src 'none'; ...; connect-src 'none'; ...
x-content-type-options: nosniff
```

`allow-same-origin` が無いこと、`set-cookie` が 1 つも無いことも同時に読めます。
`npm run check:origins` はこれを自動で検査します。

#### 2. 実際に配信される URL を作る（D1 に 1 行入れる）

**ローダー文書を返すのに R2 は要りません**（`games` に行があれば 200 になる）。
生成を 1 回通すのが本筋ですが、**課金される**ので、経路の疎通だけを見るなら行を直接
入れるのが速いです。

```bash
# 作者。既に users 行があるなら飛ばす
npx wrangler d1 execute DB --local --command \
  "insert into users (id, google_sub, email, display_name, created_at)
   values ('u-local','sub-local','local@example.com','local',1)"

# 作品。preview_key は 16 進 32 桁でなければ 404 になる（綴りを検証している）
npx wrangler d1 execute DB --local --command \
  "insert into games (id, author_id, status, title, go_version, created_at, preview_key)
   values ('11111111-1111-4111-8111-111111111111','u-local','draft','ローカル確認',
           'go1.26.5',1,'0123456789abcdef0123456789abcdef')"
```

<https://sandbox.game-forge.localtest.me:8787/p/0123456789abcdef0123456789abcdef/> が
200 でローダー文書を返します。ヘッダを見ると、**`connect-src` がその作品の `.wasm`
1 本に固定されている**ことが読めます。

```text
content-security-policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' 'wasm-unsafe-eval' https://sandbox.game-forge.localtest.me:8787/p/0123.../wasm_exec.js;
  connect-src https://sandbox.game-forge.localtest.me:8787/p/0123.../game.wasm;
  img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';
  frame-ancestors https://game-forge.localtest.me:8787
```

`status` を `published` にすれば `/g/11111111-1111-4111-8111-111111111111/` でも同じ
文書が返ります（`/g/` は `published` だけ、`/p/` は `removed` 以外を返す。5.4）。

#### 3. この行だけでは**ゲームは動きません**（正常な失敗）

上の行は R2 のオブジェクトを指していないため、ローダーは資材の取得で失敗し、画面に
「起動できませんでした」と出ます。**黙って白画面にはなりません。**

| 要求 | この状態での応答 | 理由 |
|---|---|---|
| `/p/<key>/game.wasm` | 404 | `wasm_key` が NULL（tombstone と同じ扱い。5.3） |
| `/p/<key>/wasm_exec.js` | 500 | R2 に `runtime/go1.26.5/wasm_exec.js` が無い |

`wasm_exec.js` は**まだ誰も R2 へ置いていません**（3.5 の「イメージからこのファイルを
取り出して配信側へ配置する」が未実施。別 issue）。手元で先へ進めたい場合は、ローカル
R2 へ直接置けます。

```bash
# キーの版と、置くファイルの版は必ず同じにする（下記の注意）
GOV="$(go env GOVERSION)"   # 例: go1.26.5
npx wrangler r2 object put "game-forge-local/runtime/${GOV}/wasm_exec.js" \
  --file "$(go env GOROOT)/lib/wasm/wasm_exec.js" --local
```

- **`--local` を外さないこと。** 外すと本番の R2 を触ります。
- 置いた内容は `wrangler pages dev` を再起動しなくても次の要求から反映されます。
- **キーの版は `games.go_version` と一致させること。** 配信側は
  `runtime/<go_version>/wasm_exec.js` を引き、**見つからなければ別の版へ落とさず 500 に
  します**（3.5。版の違う `wasm_exec.js` は読み込みに成功して実行時に壊れるため、
  いちばん原因が読めない失敗になる）。手元の `go version` がビルドイメージ
  （`docker/isolated-build/Dockerfile` の `golang:` タグ）と違う場合、**手元の
  `wasm_exec.js` を `go1.26.5` のキーへ置かないこと。** それは 3.5 が防ごうとしている
  取り違えそのものです。

---

## 4. 検証

| コマンド | 何を確かめるか | 所要 | 前提 |
|---|---|---|---|
| `bash scripts/verify.sh` | ローカル層の受け入れ条件すべて（機密検査・テスト・型・型定義の照合） | 数秒 | なし |
| `npm run check:origins` | 別オリジン・同一サイト・`__Host-`・CSP を**実際に起動して**確認 | 約 20 秒 | なし |
| `npm run check:isolated-build` | 7.1 の封じ込め下で隔離ビルドが通ること ＋ **Ebitengine が vendor から解決できること** | **約 1〜2 分**（Ebitengine のサンプルビルドを含む。キャッシュが冷えていればさらに数分） | Docker（イメージのビルドにネットワーク。**実行時は `--network=none`**） |

`npm run check:origins` と `npm run check:isolated-build` は `scripts/verify.sh` には
含めない。前者は約 20 秒かかり反復の信号としては重く、後者は Docker とイメージ取得を
要するためである（`.github/project-ai-rules.md`「受け入れ検証の二層」）。

### `npm run check:origins` が確かめること

自己署名証明書で `wrangler pages dev` を起動し、自分で止める。起動済みのサーバへ相乗りしない
（相乗りすると、古いコードのまま緑になる経路ができる）。

- 両ホストが解決し、**別オリジン**かつ**同一サイト**であること
- 証明書が両ホストを検証できること（`-k` では通さない。SAN 不足を見逃すため）
- `__Host-` cookie を**クライアントが実際に受理する**こと
- その cookie が**サンドボックス用ホストへは送られない**こと ← 7.2 の眼目
- サンドボックス側が `CSP: sandbox allow-scripts` を返し、`allow-same-origin` を含まず、
  cookie を一切設定しないこと
  - **見ているのはヘッダだけ**なので、`/` が 404 になった #28 以降もそのまま通ります。
    サンドボックス用ホストは**どの経路でも**この 3 つを満たすことが 7.2 の要件であり、
    作品が引けたかどうかとは別の話です。

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
- **Ebitengine のサンプルが `--network=none` でビルドできること**（M2-4 / #18）

最後の 1 つが vendor 焼き込みの検証にあたります。他の検査は標準ライブラリだけの
サンプルを使うため速い代わりに、**vendor が空でも通ってしまいます**。許可パッケージの
うち外部モジュール 5 つをすべて使うサンプル（`docker/isolated-build/sample/`）を
実際にビルドして初めて、焼き込みが効いているか分かります。

一覧は 3 か所に現れます（許可パッケージ・vendor 焼き込み・検査用サンプル）。
`test/go-imports.test.ts` が機械照合するので、ずれたら落ちます。

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

**M2-5（ビルド API）へ引き継ぐこと: 成果物の受け渡しで終了コードだけを信用しない。**
（**実行環境は AWS Lambda に決まった**。確定24 / 仕様書 3.8。v1.8 までは「VPS ビルド API」）

### 5.3 devcontainer では bind mount が使えない

devcontainer は docker-outside-of-docker 構成で、`/workspaces/game-forge` の実体は
ホスト側の別パスにある。コンテナ内のパスを `-v` に渡しても解決しない。
隔離ビルドが標準入出力でソースと成果物をやりとりするのはこのためでもある
（本来の理由は 7.1 の「ホストのファイルシステムを攻撃者が制御しうるコードへ
差し出さない」）。**本番も同じ形になる**（確定24 で本番は AWS Lambda。イベントでソースを受け、
返り値で `.wasm.br` を返す。仕様書 3.3 / 3.8。v1.8 までは「本番の VPS も同じ形になる」）。

### 5.4 CSP の `connect-src 'none'` と wasm 配信の衝突（M4-3 / #28 で解消済み）

**旧記述（M0.5-3 時点。経緯として残す）:**

> 7.2 は `connect-src 'none'` まで絞ることを求める一方、3.4 は
> `WebAssembly.instantiateStreaming` の使用を求める。`instantiateStreaming` は `fetch`
> 経由で `.wasm.br` を取得するため、その取得は `connect-src` の管轄に入る。さらに
> `sandbox allow-scripts`（`allow-same-origin` なし）で不透明オリジンになるため、
> `connect-src 'self'` も一致しない。
>
> **M0.5-3 のプレースホルダは wasm を読まないため、7.2 の記述どおり `'none'` のまま
> 置いてある。** 実際に wasm を配信する M4-3 で、配信元ホストの明示列挙などの解決が要る。

**#28 での結論: 緩めた。** 迂回できないことを先に確かめている（data: URL への埋め込み・
非ストリーミング化・`preload` は、いずれも同じ `connect-src` の管轄に入るか 3.4-2 に
反する）。不透明オリジンで `'self'` が一致しないのも旧記述のとおりなので、**配信元を
明示列挙する以外の解が無い。**

**緩めた幅は「その作品の `.wasm` 1 本の URL」に限った。** CSP のソース式はパスまで
書けるため、`connect-src https://sandbox…/p/<key>/game.wasm` と完全一致で許している。
同じホスト上の別の作品にも、配信経路の他のパスにも一致しない。**ローダー文書だけが
緩み、`.wasm` や `wasm_exec.js` のレスポンスは `'none'` のままである。**

失われたのは「外へ一切出られない」という性質で、第三者への送出（情報送出・マイニング・
DDoS 踏み台）はいずれも任意の宛先を要するため成立しない。**残る穴は、許可された 1 本を
繰り返し取得できること**（Workers のリクエスト数を消費する）。

理由と分担の見直しは `src/sandbox-csp.ts` の冒頭にある。**緩めた事実をコードから読める
位置に置くのが完了条件だった**ので、この節はその入口として残す。

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
| Next.js / React のフロント | 未起票。確定22 で配置先は Pages Functions に決まったが、MVP の画面は SSR HTML で足りているため、必要になった時点で起票する |
| 本番のビルド実行環境への配備の実行（イメージの GHCR への push までは M2-4 で済んでいる） | **確定24 で配備先は AWS Lambda（ECR へ push ＋ 関数更新）に決まった**（仕様書 9.3）。実際の構築は M2-9 の範囲外で、関数と ECR / VPC の宣言が要る。v1.8 までは「VPS への自動デプロイの実行 / M2-5 の前提となる VPS が要る」 |
| ビルドの同時実行制御・タイムアウト・結果キャッシュ | M2-5 |
| 本番の D1 / R2 と Pages プロジェクトの宣言 | 未決。手順は [pages-deploy.md](pages-deploy.md) にあるが、Terraform で宣言するかが決まっていない |
