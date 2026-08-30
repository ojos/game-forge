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

`wasm_exec.js` の実体は **`scripts/put-wasm-exec.sh` が置きます**（#139）。3.5 の更新手順 5
「イメージからこのファイルを取り出して配信側へ配置する」を機械にした 1 本です。
**手で `wrangler r2 object put` を叩く形はやめました**（理由は下記）。

```bash
bash scripts/put-wasm-exec.sh              # 要る版すべてをローカル R2 へ置く
bash scripts/check-wasm-exec-objects.sh    # 在ることを検査する（WASM_EXEC_PASS）
```

- **置く版を自分で数えなくてよい。** `scripts/wasm-exec-versions.sh` が
  `docker/isolated-build/Dockerfile` の `ARG GO_VERSION`（これから作られる作品の版）と、
  D1 の `games.go_version`（すでにある作品の版）から導きます。**版の一覧を書き写す場所を
  作りません。**
- 既定は `--local` です。**本番へ書くのは `--remote` を明示したときだけ**で、逆にすると
  手元の試行が本番の共有資材を上書きする経路が既定になります。本番の手順は
  [pages-deploy.md](pages-deploy.md) の「`wasm_exec.js` を本番 R2 へ置く」にあります。
- 置いた内容は `wrangler pages dev` を再起動しなくても次の要求から反映されます。

**手元の Go から版を導いてはいけません。** ここには以前 `go env GOVERSION` と
`$(go env GOROOT)/lib/wasm/wasm_exec.js` を使う手順が書いてありましたが、それは
**3.5 が防ごうとしている取り違えそのもの**です。手元のツールチェインはビルドイメージと
無関係に更新されるため、版のずれた `wasm_exec.js` を正しい名前のキーへ置けてしまいます。
配信側は見つからなければ別の版へ落とさず 500 にしますが、**中身だけが違う版のときは
200 で配ってしまい、実行時に壊れます**（いちばん原因が読めない失敗）。
`scripts/put-wasm-exec.sh` は取り出し元のイメージ自身に `go env GOVERSION` を申告させ、
要求した版と一致しなければ**置かずに落とします。**

**実測（2026-08-29 / #139）: `go1.26.5` と `go1.26.7` の `wasm_exec.js` はバイト単位で
同一でした**（sha256 `0c949f4996f9a896…`。ホスト側 arm64 のイメージでも、Lambda と同じ
amd64 のイメージでも同じ値）。**だからといって片方をもう片方のキーへ複製してよいことには
なりません。** 次の版で中身が変わったとき、変わったことに気づく機構が無くなります。

---

## 4. 検証

| コマンド | 何を確かめるか | 所要 | 前提 |
|---|---|---|---|
| `bash scripts/verify.sh` | ローカル層の受け入れ条件すべて（機密検査・テスト・型・型定義の照合） | 数秒 | なし |
| `npm run check:origins` | 別オリジン・同一サイト・`__Host-`・CSP を**実際に起動して**確認 | 約 20 秒 | なし |
| `npm run check:isolated-build` | 7.1 の封じ込め下で隔離ビルドが通ること ＋ **Ebitengine が vendor から解決できること** | **約 1〜2 分**（Ebitengine のサンプルビルドを含む。キャッシュが冷えていればさらに数分） | Docker（イメージのビルドにネットワーク。**実行時は `--network=none`**） |
| `bash scripts/check-wasm-exec-objects.sh` | 配信が要求する `wasm_exec.js` が R2 に在ること（3.5 / #139） | 数秒 | ローカル D1 に `games` 行があること |
| `bash scripts/check-sandbox-browser.sh` | **実ブラウザで**プレイ経路が通ること（#180 / #181。不透明オリジン → 自分の wasm の取得 → 起動） | 約 1 分 | Go・Node 22 以降・**Chromium の実行ファイル**（下記） |
| `GF_SKIP_BROWSER=1 bash scripts/check-sandbox-browser.sh` | 上の**層 0 だけ**（配信された `.wasm` が二重圧縮でないこと。#181） | 約 30 秒 | Go・Node 22 以降（**ブラウザ不要**） |
| `bash scripts/check-sandbox-cors.sh` | **配備済みの実物**が ACAO を返すこと（#180）と、`.wasm` が二重圧縮でないこと（#181） | 数秒 | ネットワーク（公開 URL への GET。認証は不要） |

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

### `bash scripts/check-sandbox-browser.sh` が確かめること

**プレイ経路を実ブラウザで通します。** 代理検査では捕まらない種類の不具合があるため
（#180。下の 5.8）、この 1 本だけは本物のブラウザで見ます。

その場で本物の材料を作ります（ダミーのバイト列を置きません）。

1. `GOOS=js GOARCH=wasm` で**本物の Go の wasm** をビルドし、brotli で圧縮して R2 へ置く
2. **ビルドに使ったツールチェイン**に同梱の `wasm_exec.js` を `runtime/<版>/` へ置く（3.5 の版一致）
3. `games` 行を 1 つ作る（**使い捨ての `--persist-to` へ。手元の `.wrangler/state` は汚しません**）
4. `wrangler pages dev` を HTTPS で起動し、Chromium で `/p/<key>/` を開く

見るのは 3 層で、**どこで落ちたかが分かる形**になっています。

| 層 | 見るもの | 落ちたときの意味 |
|---|---|---|
| **0** | 配信された `.wasm` の本文が正しいこと（応答の `Content-Encoding` を見て読み方を分ける。下記） | 二重に brotli 圧縮されている（#181）など。**ブラウザ不要の層**で、`GF_SKIP_BROWSER=1` でここだけ回せます |
| 1 | 文書が**不透明オリジン**であること（`self.origin === "null"`、`localStorage` が投げる） | 7.2 必須要件 1 が効いていない。**この状態の緑は無意味です** |
| 2 | `.wasm` の取得が CORS で破棄されないこと | #180 そのもの |
| 3 | wasm が起動し Go が実際に走ること | プレイ経路が通っていない |

**層 0 の判定は `scripts/wasm-body-verdict.mjs` が持ちます**（`check-sandbox-cors.sh` と
**同じ判定体**を使います）。**応答の `Content-Encoding` を見ずに判定してはいけません** —
理由は 5.10 にあります。

**層 0 は単体テストで代替できません**（実測）。`SELF.fetch`（vitest の workers pool）は
内部サブリクエストで **HTTP のエンコード境界を通らない**ため、`encodeBody` の指定に
関係なく R2 のバイト列がそのまま返ります。**#180 と同じ形の盲点です。**

**依存は 1 つも足していません。** Playwright も Puppeteer も使わず、Chromium を直接
起動して CDP を素で話します（`scripts/sandbox-browser-probe.mjs`。Node 22 以降の
組み込み `WebSocket` を使う）。要るのは**ブラウザの実行ファイル 1 つ**だけです。

**Go の版はここに書き写しません。** 生成する `go.mod` の `go` ディレクティブは
`docker/isolated-build/template/go.mod` から読みます（正本は `Dockerfile` の
`ARG GO_VERSION`。#101 / #141）。**読めなければ落ちます——既定値へ倒れません。**
手元の Go がピン留めより古ければ go がツールチェインを切り替えるため、**初回は
ネットワークが要ります。** `wasm_exec.js` と `go_version` は、**切り替え後の**
実効ツールチェインから引きます（外で引くと 3.5 の版ずれをこの検査自身が踏みます）。

```bash
# この devcontainer で実測した入手手順
npm i playwright-core && npx playwright install chromium-headless-shell
sudo npx playwright install-deps chromium-headless-shell   # システムパッケージ

GF_BROWSER_BIN="$(node -e "console.log(require('playwright-core').chromium.executablePath())")" \
  bash scripts/check-sandbox-browser.sh
```

**`scripts/verify.sh` には含めていません。** ローカル層の契約は「ネットワークも外部認証も
要さない検査」で（`.github/project-ai-rules.md`「受け入れ検証の二層」）、この検査は
ブラウザの入手にネットワークとシステムパッケージを要するためです。**一方で「入って
いなければ黙って飛ばす」形にもしていません**——飛ばして緑を出すのが #180 の通り抜けかた
そのものなので、前提が満たされなければ**赤で落ちます。** 起動の契機は
`src/sandbox-*.ts` を触ったときです。

> **この検査が実際に #181 を見つけました。** #180（CORS）を直した直後、層 3 は
> `CompileError: expected magic word 00 61 73 6d, found 9b df d6 1d` で赤のままでした。
> **`.wasm` が二重に brotli 圧縮されて配信されていた**のが原因です（5.9）。
> ヘッダは全部正しく curl の 200 も正しく見えるため、代理検査では見つかりません。

---

## 5. 既知の制約と注意

### 5.1 ローカルで検証できないもの（仕様書 9.1）

R2 ライフサイクルルール / D1 書き込み無料枠の枯渇 / OGP のクローラ検証 /
Resend の SPF・DKIM 到達性 / 実ドメインでの CSP・cookie 挙動。
いずれもクローズドβで踏むことを受け入れる。

> **R2 ライフサイクルについて（#31）。** ローカル R2（Miniflare）はライフサイクルを
> 持たないため、**手元で挙動を再現することはいまも出来ない。** ただし
> **宣言と実状態が一致しているかは機械で確かめられる**ようになった。宣言は
> `terraform/r2-lifecycle.tf`、照合は `bash scripts/check-r2-lifecycle.sh`（外部層。
> Cloudflare の API トークンが要る）。とくに**年齢だけで消すルールが 1 つも無いこと**を
> 見ている。理由は 3.7 の削除規約 3（R2 のライフサイクルは `games` を引けないため、
> 共有されうるオブジェクトを載せると公開済みの作品が壊れる。確定26）。

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

### 5.8 不透明オリジンからの自己資材の取得には CORS が要る（M4-13 / #180）

**7.2 必須要件 1 の帰結です。緩和ではありません。**

`sandbox allow-scripts`（`allow-same-origin` なし）を付けた文書は**不透明オリジン**に
なります。7.2 はそれを意図しています。ただしその帰結として、**自分自身のホストへの
`fetch` すらクロスオリジン要求になります**——文書のオリジンが `null` なので、「同一
オリジン」が成立しないためです。

```text
文書のオリジン: null（不透明）
fetch の宛先:   https://sandbox…/p/<key>/game.wasm   ← 同じホストなのに
→ ブラウザは Origin: null を付けた CORS 要求として送る
→ 応答に Access-Control-Allow-Origin が無ければ、ブラウザが応答を破棄する
→ 画面には「起動できませんでした: TypeError: Failed to fetch」だけが出る
```

**これが本番で起きていました**（#180）。`wasm_exec.js` が動いていたのは `<script src>`
で読まれていたためで、**クラシックスクリプトの読み込みは CORS の対象外です。落ちるのは
`fetch` だけでした。**

配信は `Access-Control-Allow-Origin: *` をすべての応答へ一律に付けます。**値を `*` に
した根拠、`null` を採らなかった理由、そしてこれが 7.2 を緩めない理由**は、
`src/sandbox-delivery.ts` の `ALLOW_ORIGIN` に書いてあります。要点だけ再掲します。

- **`connect-src` は 1 本の URL のままです**（5.4 のとおり）。7.2 が塞いでいるのは
  「生成物が**外へ**出ていくこと」で、**ACAO は宛先の集合に 1 要素も足しません。**
  ACAO が言うのは「この応答を、要求した不透明オリジンの文書へ渡してよい」だけです。
- `null` は不透明オリジン限定に**見えるだけ**です。他サイトの sandboxed iframe も
  `data:` URL も `Origin: null` を名乗るため、`*` に対して防げる相手が増えません。
- プレビュー URL の唯一の資格情報は `preview_key` です。この経路は cookie を発行しない
  ため（7.2 必須要件 3）、**CORS が守っていた「被害者の資格情報つきの読み取り」が
  そもそも存在しません。**

#### なぜ代理検査で捕まらなかったか

**CSP を読む検査は「CSP が許しているか」しか見ていません。** 「CSP は許しているが
CORS が別の理由で塞ぐ」という組み合わせは、原理的に捕まりません。**curl も同じ穴を
持ちます**（curl は CORS を評価しない）。

そのため検査を 2 本足しました。**片方はもう片方の代わりになりません。**

| 検査 | 見るもの | 見ないもの |
|---|---|---|
| `scripts/check-sandbox-cors.sh` | **配備済みの実物**に ACAO が付いていること | ブラウザが実際に読めるか（curl は CORS を評価しない） |
| `scripts/check-sandbox-browser.sh` | **実ブラウザ**で不透明オリジンから取得して起動できること | 配備先の状態（ローカルの dev サーバを見る） |

### 5.9 R2 のバイト列は既に圧縮済みである（M4-14 / #181）

**`.wasm` の配信では `encodeBody: 'manual'` が要ります。** 無いと**二重に brotli 圧縮
されて配信されます。**

R2 に入っている `.wasm.br` は、ビルド関数が**ちょうど 1 回**圧縮して PUT したものです
（3.4-1 / #21。[build-function.md](build-function.md)）。R2 はそれを復号しないので、
`object.body` は**既にエンコード済みの本文**です。

ところが `Response` の既定は `encodeBody: 'automatic'` で、これは「本文は未エンコード
なので、宣言された `Content-Encoding` に従ってランタイムが圧縮せよ」という意味に
なります。結果、**既に圧縮済みのバイト列がもう一度圧縮されます。**

ブラウザは宣言どおり**1 回だけ**展開するので、手元に残るのは brotli ストリームです。

```text
CompileError: WebAssembly.instantiateStreaming():
  expected magic word 00 61 73 6d, found 9b df d6 1d @+0
```

`9b df d6 1d` は wasm ではなく **brotli の先頭バイト**です。

#### なぜ気づけないのか

**ヘッダは全部正しいままです。** `Content-Type: application/wasm` も
`Content-Encoding: br` も宣言どおりに付き、`curl -i` は 200 を返し、本文の大きさも
「圧縮された wasm」として妥当に見えます。**`Content-Encoding` を正しく付けているのに
二重になる**という形なので、ヘッダを何度確かめても原因に辿り着きません。

本番の実測（#181）:

```text
配信      2,229,376 バイト（先頭 a5 ff 7f 09）
  1 回展開 2,313,735 バイト（先頭 9f c8 89 b0 ← まだ brotli）
  2 回展開 11,569,609 バイト（先頭 00 61 73 6d ← \0asm）★
```

**1 回展開してもまだ brotli であることを見て初めて分かります。** これが機械検査の形
（層 0 / `check-sandbox-cors.sh`）になっています。**ただしその判定には続きがあります** — 5.10。

#### `wasm_exec.js` は同じ形ではない

同じく R2 のバイト列を本文にしますが、**`Content-Encoding` を宣言しません**（R2 に置く
`wasm_exec.js` は非圧縮）。二重圧縮は「**エンコード済みの本文**に `Content-Encoding` を
宣言した」ときにだけ起きるので、こちらには成立する余地がありません。**同じ形に見える
2 つを、同じ扱いにしないこと。** 理由は `src/sandbox-delivery.ts` の
`wasmExecResponse` に書いてあります。

### 5.10 経路は本文を透過的に展開しうる（#182）

**`.wasm` の本文を判定するときは、応答の `Content-Encoding` を必ず見てください。**

クライアントが `Accept-Encoding: br` を送らなければ、**エッジは brotli を展開し、
`Content-Encoding` ヘッダを外して返します。これは正しい振る舞いです。**

本番の実測（#182）:

```text
Accept-Encoding: br あり → content-encoding: br  /  2,313,735 バイト / 1 回展開で \0asm
Accept-Encoding  なし    → content-encoding なし  / 11,569,609 バイト / 既に \0asm
```

**どちらも正しい状態です。** 同じ URL が、要求の仕方で違う形の本文を返します。

#### この一点で、両方向に間違えました

- **1 回目（#181 を見逃した）。** 「`Accept-Encoding: br` の有無でサイズが違う」のを見て
  「エッジが再圧縮しているのだろう」と流した。**実際には配信側が二重に圧縮しており、
  利用者のブラウザでは起動していなかった。**
- **2 回目（#182 の偽陽性）。** 逆向きに、`Content-Encoding` が無い応答（＝経路が既に
  展開した、正しい本文）を brotli として展開しようとして失敗し、**正しい本番を
  「二重圧縮です」と報告した。**

**根は同じで、「経路が透過的に展開しうる」ことを勘定に入れていないことです。**

#### 判定表

| 宣言 | 本文 | 判定 | 意味 |
|---|---|---|---|
| `br` | 1 回展開で `\0asm` | OK | 事前圧縮した `.wasm.br` がそのまま届いている（3.4-1 の意図） |
| `br` | そのまま `\0asm` | NG | 宣言と本文の食い違い。**ブラウザは展開を試みて落ちます** |
| `br` | 2 回展開で `\0asm` | NG | **二重圧縮**（#181） |
| なし | そのまま `\0asm` | OK | 経路が既に展開している。**正しい** |
| なし | 1 回展開で `\0asm` | NG | 本文は brotli なのに宣言が無い。**ブラウザは展開しません** |
| — | どちらでも wasm にならない | NG | 別物が返っている |

**判定は `scripts/wasm-body-verdict.mjs` の 1 箇所だけが持ちます。** 呼ぶ側
（`check-sandbox-cors.sh` / `check-sandbox-browser.sh`）は判定を持ちません — **2 箇所に
書けば、片方だけ直る日が来ます**（実際に #182 の時点で、同じ誤りが 2 箇所に
複製されていました）。

**検査側は `Accept-Encoding: br` を明示して要求します**（ブラウザと同じ形にして、経路の
気まぐれで検査対象が変わらないようにするため）。**それでも返ってきた宣言で分岐します。**
`curl --compressed` は使いません — curl が展開したうえでヘッダを残すため、ヘッダと本文の
対応が崩れて判定できなくなります。

---

## 6. この段階で作っていないもの

M1 以降が所有する。ここで先に作らない。

| 対象 | 所有する issue |
|---|---|
| Next.js / React のフロント | 未起票。確定22 で配置先は Pages Functions に決まったが、MVP の画面は SSR HTML で足りているため、必要になった時点で起票する |
| 本番のビルド実行環境への配備の実行（イメージの GHCR への push までは M2-4 で済んでいる） | **確定24 で配備先は AWS Lambda（ECR へ push ＋ 関数更新）に決まった**（仕様書 9.3）。実際の構築は M2-9 の範囲外で、関数と ECR / VPC の宣言が要る。v1.8 までは「VPS への自動デプロイの実行 / M2-5 の前提となる VPS が要る」 |
| ビルドの同時実行制御・タイムアウト・結果キャッシュ | M2-5 |
| 本番の D1 / R2 と Pages プロジェクトの宣言 | 未決。手順は [pages-deploy.md](pages-deploy.md) にあるが、Terraform で宣言するかが決まっていない |
