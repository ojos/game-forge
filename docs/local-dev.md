# ローカル開発環境の手順書

- 対象: M0.5-3（issue #51）
- 位置づけ: **クラウド環境は本番のみ。画面・API・D1・R2 の開発はローカルで完結する**（確定20 / 仕様書 9.1）。
  **生成・ビルド・OGP 画像の撮影・アイコンの変換は本番の Lambda が相手で、ローカルだけでは確かめられない。**
  とくに生成はローカルから通しで回せない（5.1 の C 段。確定20 の ※ 注記と 9.1 の #534 注記）。
  この文書だけを見て、クリーンな環境から同じ状態を再現できることを目標とする。

---

## 1. 前提

| 要件 | 版（検証時） | 備考 |
|---|---|---|
| Node.js | 22 以上（実測 24.18.1） | `package.json` の `engines` で宣言 |
| Docker | Server 28.5.1 | 隔離ビルドに使う。devcontainer は docker-outside-of-docker |
| Go | **版は問わない**（実測 go1.26.5） | **ピン留めへ揃える必要はありません。** go 自身が `go.mod` を読んで切り替えます。**初回はネットワークが要ります**（5.11） |
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

**LLM は Amazon Bedrock を叩く（確定19 / 仕様書 4.1）。ただし #160 以降、Bedrock を呼ぶのは
本番のオーケストレータ Lambda の中であり、ローカルの `wrangler pages dev` を含むエッジは Bedrock を呼ばない。**

- 生成の入口（`/api/generate`。フォーク・推敲も同じ）がエッジで行うのは、クォータの判定・`games` 行の作成・
  ジョブの投げ込みまでである。既定の投げ込み（`startJob`）は `src/orchestrator/start-job.ts` の
  `startJobOnLambda` で、Bedrock を呼ぶ段（`generateSource`）はオーケストレータの中で走る
  （`src/generate.ts` の `defaultPipeline`、`src/orchestrator/pipeline.ts`）。入力側モデレーション
  （Guardrails）もオーケストレータ側にある（`src/input-moderation.ts` の冒頭）。
- **したがって `BEDROCK_AWS_*` の 4 本を `.dev.vars` に入れても、ローカルの生成は通らない。**
  ローカルの Worker がこの 4 本を読む経路が無いためである。投げ込みに要るのは `BUILD_AWS_*` のほうで、
  **それを入れると本番の Lambda が動く。** 何が起きるかは 5.1 の C 段に書いた。
- 4 本のキーが雛形に残っているのは、コード側の口（`src/bedrock.ts` の `BEDROCK_SECRET_NAMES`）として
  残っているためである。オーケストレータは実行ロールの一時資格情報をこの名前へ写して使う
  （`src/orchestrator/handler.ts`）。空のままでも `npm run dev` は起動し、`npm test` も通る。
- **`BEDROCK_AWS_*` には、どのアカウントの資格情報も書き写す必要が無い。** ローカルにこの 4 本を読む経路が無いためである。
  以前ここにあった転記の手順はローカルのエッジが Bedrock を叩く前提（#160 より前）で書かれており、仕様 9.1 の
  「開発の LLM は Dev アカウント」とも違うアカウントを指していた。#534 で仕様 9.1 / 9.2 を実態に合わせた——
  **エッジは Bedrock を呼ばず、ローカルからは生成を通しで回せない**（9.1）。**Dev アカウントの Bedrock はいま使っておらず、
  開発が本番の枠を使うことも無い**（9.2。構成は変えていない）。

**AWS の一時資格情報を `.dev.vars` へ転記する形**（`BUILD_AWS_*` を入れるとき）。
**呼ぶ相手は本番の Lambda なので、プロファイルは本番の `game-forge-prod` である**（Dev アカウントに Lambda は無い。
[build-invocation.md](build-invocation.md)「ローカルで叩くとき」、`.dev.vars.example` の `BUILD_AWS_*` の項）。
（`BEDROCK_AWS_*` のほうは、上のとおり書き写す必要が無い。）

**export しただけでは効かない。** `aws configure export-credentials` が出すのは `AWS_*` という
別の名前で、しかも Worker が読むのはシェルの環境変数ではなく `.dev.vars` というファイルである。**値を転記する。**

```bash
eval "$(AWS_PROFILE=game-forge-prod aws configure export-credentials --format env)"
printf 'BUILD_AWS_REGION=%s\nBUILD_AWS_ACCESS_KEY_ID=%s\nBUILD_AWS_SECRET_ACCESS_KEY=%s\nBUILD_AWS_SESSION_TOKEN=%s\n' \
  ap-northeast-1 "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN"
```

出力で `.dev.vars` の該当 4 行を置き換える。**SSO の資格情報は数時間で失効する**ので、
`AccessDenied` や `401` が出たら `aws sso login` からやり直して転記し直す。**`BUILD_AWS_*` を入れる前に
5.1 の C 段を読むこと**（呼ぶ相手は本番の Lambda である）。

**Anthropic のキーは使わない。** v0.9 までの `ANTHROPIC_API_KEY` は v1.0（#80）で廃止した。
`BEDROCK_AWS_*` に `AWS_` の接頭辞を付けていないのは、Terraform 用の資格情報と混ざらない
ようにするため（`.dev.vars.example` のコメント）。

**以前ここにあった「Claude のモデルアクセスは #82 で有効化する。それまで `anthropic.claude-sonnet-5` は
`AccessDeniedException` になる」は削った。** #82 は 2026-08-26 に閉じており、挙げていたモデル ID も
いまの登録簿（`src/generation-models.ts`。Claude は `jp.anthropic.claude-sonnet-4-6`）と違う。
そもそもローカルから Bedrock を呼ばないので、モデルアクセスの状態はローカルの手順に関わらない。
モデルアクセスの確かめ方は [bedrock-access.md の「2. アクセス開通の順序」](bedrock-access.md#2-アクセス開通の順序) にある。
同文書の 3〜4 章（Pages への鍵の投入とローテーション）は、見出しのとおり「#160 より前の手順（戻すときだけ）」として残してあり、
今は本番でもローカルでも実行しない（#570 で同文書を今の構成に合わせた。エッジに残る `BUILD_AWS_*` の鍵の発行とローテーションは
[build-invocation.md](build-invocation.md) 3 章）。

> **#570 注記（2026-09-15）。** 上の一文は「**同文書の 3〜4 章（Pages への鍵の投入とローテーション）は #160 より前の手順で、
> ローカルの手順としては使わない。**」だった。同文書の側が #160 以降に合わせて書き直されたので締めた。**旧記述はこの注記に残す。**

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

1. `.dev.vars` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` と
   `SESSION_SECRET`（32 文字以上の乱数。`openssl rand -base64 48` など）を入れる。
   **Google の 2 つは、開発用のプロジェクト `ojos-game-forge-dev` のクライアント `game-forge-dev` の値にする**
   （[gcp-oauth-setup.md](gcp-oauth-setup.md) の 1.1 と 5.2。#479）。
   - **本番のクライアント（`ojos-game-forge` の `game-forge-prod`）の値を入れない。** 2026-09-14 から本番の
     クライアントにはローカル用のリダイレクト URI が無いので、Google の画面が `redirect_uri_mismatch` で止まる
     （アプリのログには何も出ない）。`client_id` の先頭が開発用のプロジェクト番号 `558074593204` であることで見分けられる
   - **ログインできるのは Workspace `ojos.jp` のアカウントだけ。** 開発用の同意画面は「内部」である
2. **ローカルの D1 のマイグレーションを最新にしておく**（上の「D1 スキーマの適用」の `npm run db:migrate`）。
   **遅れていると、Google の認証を通ったあとのコールバックが `{"error":"internal error"}`（500）になる。**
   コールバックは D1 の利用者の行を引いて作るので、足りない表や列があると例外になり、
   `src/auth/google.ts` は応答に中身を出さず `internal error` だけを返す（原因は `npm run dev` の端末のログに出る）。**Google の設定の誤りに見えるが、原因は手元の D1 である。**
   2026-09-14 には 21 本（`0019`〜`0039`）遅れていて、これを踏んだ（#479）。`npm run db:migrate:list` で未適用が
   無いことを確かめる。
3. **招待コードを 1 枚用意する。** 8.1 の「生成は招待コード保有者のみ」を機構にしているため、
   招待の無い新規アカウントは作られない（`/signup` へ戻される）。

   ```bash
   npx wrangler d1 execute DB --local --command \
     "insert into invites (code, issued_by) values ('SMKETEST0001', '<既存の users.id>')"
   ```

   **コードは 12 文字の Crockford Base32 で、`I` `L` `O` `U` を含められない**（`src/invite-code.ts` の
   `INVITE_CODE_LENGTH` と `INVITE_CODE_ALPHABET`）。含めたときの起き方は 2 通りある（`normalizeInviteCode`）。
   - **`I` `L` `O` は数字へ寄る**（`CONFUSABLES` で `I`・`L` → `1`、`O` → `0`）。入力は別のコードとして照合されるので、
     `I` `L` `O` を含む綴りで保存した行には、画面からは決して一致しない
   - **`U` は写像に無く、不正な入力として受け付けられない**（`null` を返す）
   **12 文字でないコードは画面で受け付けられない**——2026-09-14 には、手元の D1 に古い試験用の行（`UNUSED01` など、
   8 文字で `U` を含む）が残っていて使えなかった（#479）。行を足すときは、上の `SMKETEST0001` のように 12 文字で、
   文字集合の中の文字だけにする。
4. <https://game-forge.localtest.me:8787/signup> でコードを入れる。検証を通ると Google の同意画面へ進む。

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
| `bash scripts/check-page-width.sh` | 全 SSR 画面が**3 段すべての幅**（390 / 768 / 1280px）に収まり、横スクロールが出ないこと（#282 / #371 / 2.3.9）。**あわせてヘッダのアカウントのメニューを JavaScript を止めて開閉し、開いた中身も収まること・読み上げに名前と開閉の状態が渡ることを見る**（#372 / 2.3.7）。**文字の塊が親の幅で組まれていること（右に空きが無いこと）、入力欄がフォームの内側いっぱいであること、入力欄のあるフォームの送信ボタンが行の右端にあることも見る**（#763 / #767 / 2.3.9 / 2.5.5） | **約 12 秒** | Node 22 以降・**Chromium の実行ファイル**（下記） |

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

- **ハンドラの単体テスト**（`/tmp` の掃除の単位。**手元の Go が古くても回ります**——5.11）
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
4. `wrangler pages dev` を HTTPS で起動し、Chromium で `/p/<key>/` と作品ページ（`/works/<id>`）を開く

見るのは次の層で、**どこで落ちたかが分かる形**になっています。

| 層 | 見るもの | 落ちたときの意味 |
|---|---|---|
| **0** | 配信された `.wasm` の本文が正しいこと（応答の `Content-Encoding` を見て読み方を分ける。下記） | 二重に brotli 圧縮されている（#181）など。**ブラウザ不要の層**で、`GF_SKIP_BROWSER=1` でここだけ回せます |
| 1 | 文書が**不透明オリジン**であること（`self.origin === "null"`、`localStorage` が投げる） | 7.2 必須要件 1 が効いていない。**この状態の緑は無意味です** |
| 2 | `.wasm` の取得が CORS で破棄されないこと | #180 そのもの |
| 3 | wasm が起動し Go が実際に走ること | プレイ経路が通っていない |
| 4 | 作品ページに埋め込んだ状態でも 1 と 3 が成り立つこと（#30） | `frame-ancestors` か iframe の `sandbox` で止まっている |
| 5 | 音のワークレットのモジュールを `blob:` から読めること（直接・埋め込みの両方。#306） | `script-src` に `blob:` が無いなど |
| 6 | CDP の `Input.dispatchTouchEvent` で送った指 1 本のタッチが、マウスを読む検査用の作品の canvas に `mousemove → mousedown → mousemove → mouseup` として届くこと（直接・埋め込みの両方。#491 / 仕様 3.9.3） | ローダーのタップ→マウス変換が効いていない。判定は `scripts/tap-mouse-verdict.mjs` |
| 7 | **タッチ端末の作品ページ**（CDP でタッチをエミュレートし、`pointer: coarse` になったことも読む）が、タップの前にサンドボックス用ホストへ要求を出さず、口のタップで全画面の覆いが開いて iframe から起動の合図が届き、「閉じる」・戻る操作・iframe の 2 回目の `load`・全画面の解除で閉じて iframe が消えること。計上（`POST /api/plays`）は 2 回開いても 1 回。**デスクトップ**（開いた時点で同じ属性の iframe）と **JavaScript を止めた形**（`<noscript>` の iframe）も見る（#502 / 仕様 3.9.4）。`GF_TAP_SHOT_DIR` を渡すと口と覆い（390×844 / 844×390）を撮る | タッチ端末で開いた時点に読み込んでいる、閉じる手段が効かない、属性の出どころが割れた、など。判定は `scripts/tap-to-fullscreen-verdict.mjs` |
| 8 | **キーで操作する作品の仮想パッド**（`source_input_keys` にキーの集合を入れた公開済みの作品をタッチ端末の形で開き、覆いを開く）で、CDP の `Input.dispatchTouchEvent` によるパッドへのタッチが検査用の作品の canvas に keydown / keyup として届くこと・同時押し（左を押したまま Space）・許可外のキー名と親以外（同じオリジンの別の iframe・直接開いたローダーの自己送信）からのメッセージを捨てること・デスクトップでは出ないこと・押したまま閉じると keyup が届くこと・キーの集合が空の作品では出ないこと（#494 / 仕様 3.9.6 / 3.9.7）。**公開前の作品（draft で `preview_key` のある行）を作者のセッション cookie を載せて開いても、「遊ぶ」で覆いが開き（iframe は `/p/`）、パッドのキーが届き、計上しないこと・デスクトップでは口のパネルが隠れて iframe が入ること**（#575。作者のセッションの秘密は検査の中で作って dev サーバへ `--binding` で渡す）。`GF_PAD_SHOT_DIR` を渡すとパッドの出た覆い（390×844 / 844×390）を撮る | パッドの送信か、ローダーの受け手の検査（source / origin / 許可表）が効いていない、など。判定は `scripts/virtual-pad-verdict.mjs` |
| 10 | **作品のおすすめの向き**（論理解像度 `layout_width` / `layout_height` を入れた横長・縦長・正方形の作品と、解像度の無い作品をタッチ端末の形で開き、覆いを開く）で、全画面に入った後で `screen.orientation.lock()` がおすすめの向きで呼ばれ、固定できたときだけ上の行に「縦向きにする / 横向きにする」が出て、押すと入れ替わって `localStorage` に覚え、覚えた向きで開き直し、「閉じる」と全画面の解除で `unlock()` が呼ばれること。固定を拒む・API が無い端末では、向きが合わないときだけ案内が出て、回すと消えること。正方形と解像度の無い作品では何もしないこと。縦持ち 390px で上の行がはみ出さないこと（#514 / 仕様 3.9.4）。**ヘッドレスの Chromium は端末の向きを持たないので、`lock` / `unlock` は呼ばれ方を記録する差し替えにする**（ページのスクリプトは本物）。`GF_ORIENTATION_SHOT_DIR` を渡すと覆いを撮る | 固定の成否でボタンと案内を出し分けていない、閉じても固定が残る、向きの判定が逆、など。判定は `scripts/orientation-verdict.mjs` |

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

### 画面を撮る（`bash scripts/shoot-pages.sh`）

**見た目は、見ないと分からない。** #282 の 2 件（フッタが `/signup` の中ほどにあった /
`/takedown` がスマホで縮んだ）も、M8-2 で CTA をボタンにした失敗も、**撮った 1 枚目で
分かったもの**である——どれも `curl` も型検査も 1,400 件超のテストも通り抜けている。

```bash
bash scripts/shoot-pages.sh
# [shoot] 対象 10 経路 / 幅 390,1280 / 出力先 dist/shots
#   /                     390×951   200 css=1
#   ...
# [shoot] 20 枚を dist/shots へ書きました。
# SHOT_PASS
```

**走っているサーバは要らない。** 使い捨ての `.wrangler` state を作り、D1 を仕込み、
署名付きセッションを発行し、dev サーバを立ててから撮る（`scripts/lib/dev-fixture.sh`）。
**手元の state は汚さない。**

**経路の一覧は書き写していない。** `/__dev/pages` から受け取る（正本は
`src/page-paths.ts` の導出）。画面を 1 枚足せば、次の実行から勝手に入る。

| 変えたいもの | 環境変数 | 既定 |
|---|---|---|
| 出力先 | `GF_SHOT_DIR` | `dist/shots`（**追跡除外**） |
| 幅 | `GF_SHOT_WIDTHS` | `390,1280` |
| ポート | `GF_SHOT_PORT` | `8796` |

**これは検査ではない。** 見た目の良し悪しは機械が決めない。合否を返すのは
`bash scripts/check-page-width.sh`（幅が端末に収まっているか）だけである。

**あちらは 3 段すべての幅で回る**（既定 `390,768,1280`。2.3.9 / #371）。幅を変えるには
`GF_PAGE_WIDTHS=360,900 bash scripts/check-page-width.sh` のように渡す。**段と幅の対応**
（CSS の `@media` が定める段を、検査の幅がすべて覆っているか）は `bash scripts/verify.sh`
の中で `scripts/check-app-css.sh` が機械照合する——**ブラウザが要らない側だけを単一入口へ
載せてある。**

**ブラウザの実行ファイルが要る。** 入手手順は `scripts/check-page-width.sh` の冒頭に
書いてある（`npx playwright install chromium-headless-shell`）。見つからなければ
**赤で落ちる**——「道具が無いので飛ばした」を成功にしない。

## 5. 既知の制約と注意

### 5.1 ローカルと本番で同じもの・違うもの・ローカルから動かないもの・確かめられないもの（#533）

**ある機能をローカルで確かめてよいか、本番でしか確かめられないか、ローカルから触ると本番の資源が動くかを、
次の 4 段で判断する。** 各行に根拠の文書かコードの場所を添える。

| 段 | 意味 | ローカルで確かめてよいか |
|---|---|---|
| A | 本番とほぼ同じもの | よい |
| B | 形は同じでも、中身や条件が違うもの | よい。ただし違いを踏まえて読む |
| C | ローカルからは動かない、または本番の資源に触れるもの | **触る前にこの段を読む** |
| D | ローカルでは確かめられないもの | できない（本番で確かめる） |

#### A. 本番とほぼ同じもの

| 項目 | 同じである根拠 |
|---|---|
| 画面と API の実行環境 | ローカルも本番も workerd で動く（仕様 9.1 の表。`wrangler pages dev`。3 章「起動」） |
| D1 のスキーマ | 同じ `migrations/` を、ローカルは `--local`、本番は `--remote` で当てる（3 章「D1 スキーマの適用」、[pages-deploy.md](pages-deploy.md)）。**当て忘れると同じにならない**（3 章「ログインを試す」の 2） |
| 3 ホストの「別オリジンで同一サイト」の関係 | アプリ・サンドボックス・管理画面の 3 ホストを `Host` ヘッダで出し分ける（`wrangler.toml` の `[vars]`、`src/index.ts`）。`npm run check:origins` が実際に起動して確かめる（4 章） |
| `__Host-` 付きの署名付きセッション | 同じコードが発行・検証する（`src/session.ts` の `SESSION_COOKIE`）。HTTPS が要るのは 3 章「なぜ HTTPS が要るか」 |
| サンドボックスの CSP / CORS / wasm の配信 | 同じコードが返す（`src/sandbox-csp.ts`、`src/sandbox-delivery.ts` の `ALLOW_ORIGIN`）。実ブラウザでは `bash scripts/check-sandbox-browser.sh`（4 章、5.8〜5.10） |

#### B. 形は同じでも、中身や条件が違うもの

| 項目 | ローカル | 本番 | 根拠 |
|---|---|---|---|
| ホストの関係 | `sandbox.` と `admin.` が、アプリ用ホスト `game-forge.localtest.me` の**子** | `app.` `sandbox.` `admin.` が `game-forge.ojos.jp` の下で**兄弟** | `wrangler.toml` の `[vars]` と `[env.production.vars]`、仕様 9.1 の v1.4 注記（別オリジンかつ同一サイトという関係は同じ） |
| 証明書 | 自己署名（`scripts/dev-certs.sh`。ブラウザは初回に警告を出す） | 公的な証明書 | 3 章「起動」 |
| Google のログイン | 開発用のクライアント `game-forge-dev`。**ログインできるのは Workspace `ojos.jp` のアカウントだけ**（同意画面が「内部」） | 本番のクライアント `game-forge-prod` | 3 章「ログインを試す」の 1、[gcp-oauth-setup.md](gcp-oauth-setup.md) の 1.1 と 5.2 |
| D1 / R2 の実体と上限 | Miniflare のローカル SQLite / R2（`.wrangler/state`）。**書き込みの無料枠のような上限が無く**、R2 のライフサイクルも無い | Cloudflare の D1 / R2 | `wrangler.toml` の `[[d1_databases]]`（`local-only-placeholder`）、仕様 9.1 の表 |
| データ | **空である。** 最初の利用者・招待コード・作品の行は自分で入れる。`wasm_exec.js` も `scripts/put-wasm-exec.sh` で置く | 本番の利用者と作品がある | 3 章「ログインを試す」の 3、「サンドボックス側の動作確認」の 2・3 |
| 30 秒の打ち切り | **`ctx.waitUntil()` を 30 秒で打ち切らない。** 長い処理がローカルでだけ完走し、偽の緑が出る | 応答後 30 秒で打ち切る | [orchestrator.md](orchestrator.md)「なぜ 2 つ目のデプロイ単位が要るのか」 |
| Durable Object（いいね・プレイ数）の結線 | `wrangler pages dev` だけでは `game-forge-likes` が居ないため、**`/works/liked` は常に「読み込めませんでした」と静かに degrade する。** 中身を見るには likes Worker を別に立てる | `game-forge-likes` を先に配った状態で結線される | [likes.md](likes.md)「`/works/liked`」の末尾と「ローカルで動かす」、`wrangler.toml` の `LIKE_HUB` / `PLAY_HUB` |
| 隔離ビルド | ローカルの Docker（`--network=none` など）。**ローカルのほうが本番より守りが強い** | AWS Lambda。egress の遮断が無い | 仕様 9.1 の #76 注記（v1.11 で改訂）、4 章の `npm run check:isolated-build` |
| `/__dev/*` | 登録される（`DEV_ROUTES = "enabled"`） | 登録されない（`disabled`） | `wrangler.toml` の `DEV_ROUTES`、`src/app.ts` の `devRoutesEnabled` |

#### C. ローカルからは動かない、または本番の資源に触れるもの

**ここに挙げた機能の呼ぶ相手は、本番にしか無い。** Dev アカウントに Lambda は無く、関数名はローカルにも本番と同じ値が
置いてある（`wrangler.toml` の `ORCHESTRATOR_FUNCTION_NAME` などの注記、仕様 9.2）。Lambda を呼ぶ資格情報は `BUILD_AWS_*` で、
入れるのは本番のプロファイルのものである（2 章「シークレットの置き場所」）。以下は**コードと terraform を読んで確かめたもの**で、
本番の Lambda が起動して費用が出うるため、ローカルから通しては動かしていない。**生成が Bedrock を呼ばないことだけは、
本番で確かめた**（2026-09-15。#534 のコメント。表の下の 5）。

| 機能 | 資格情報・キーが空のとき | 入れたとき | 根拠 |
|---|---|---|---|
| **生成**（新規・フォーク・推敲） | 投げ込みの手前で `OrchestratorNotConfigured` になり、新規生成の作品行は `failed`（`internal`）で閉じる | **本番の Lambda が起動する。ただし `claim` で降り、本番の Bedrock は呼ばれない**（本番で確かめた。2026-09-15、#534 のコメント。表の下の 5）。**結果は本番の URL へ返り、ローカルの D1 に戻らない。** 詳しくは表の下 | `src/generate.ts` の `defaultPipeline` と `startGeneration`、`src/orchestrator/start-job.ts` の `startJobOnLambda` / `missingOrchestratorSecrets`、`terraform/orchestrator.tf` の `aws_lambda_function.orchestrator`（`CALLBACK_BASE_URL`）、`src/fork.ts` / `src/revise.ts` の `pipeline.startJob` |
| **ビルド** | ローカルのエッジからは呼ばない | 同左。ビルドは生成の中で、本番のオーケストレータが `game-forge-build` を呼ぶ。**ローカルから触る経路は生成の行と同じ**である | `src/generate.ts` の `defaultPipeline`（`build: createLambdaBuild()` は同期実装 `runJobInline` のときだけ使われ、既定の `startJob` では通らない。`src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS = false`）、`src/orchestrator/pipeline.ts` の `invokeBuildFunction` |
| **OGP 画像の撮影**（公開時・撮り直し） | 呼ぶ手前で止まる（`skipped`。公開は成立し、`games.ogp_state` は変わらない） | 本番の `game-forge-ogp` が非同期で動く。撮る先は**本番の**サンドボックスの `/g/<ローカルの作品 id>/`、結果の送り先は**本番の** `/api/ogp/callback` で、**ローカルの D1 に戻らない**（ローカルの行は `ogp_state = 'capturing'` のまま） | `src/ogp.ts` の `runCapture` / `claimOgpCapture`、`src/ogp-client.ts` の `missingOgpSecrets`、`terraform/ogp-function.tf` の `aws_lambda_function`（`SANDBOX_BASE_URL` / `CALLBACK_BASE_URL`）、`docker/ogp-shot/index.mjs` の `capture` / `sendCallback` |
| **アイコンの再エンコード** | 呼ぶ手前で止まる（`AvatarNotConfigured`。画面は「保存できませんでした」） | 本番の `game-forge-avatar` が**同期で**動く。変換した画像は応答で戻り、**ローカルの** Worker がローカルの R2 / D1 へ書く（この機能だけは手元で完結する。動くのは本番の関数である） | `src/avatar-client.ts` の `createAvatarEncode`（`SYNC_INVOCATION_TYPE`）、`src/avatar.ts` の `convertAvatar`、`terraform/avatar-function.tf` |
| **メール** | 送信の手前で止まる（`not-configured`。ローカルとテストの正常な状態） | **`RESEND_API_KEY` と `MAIL_FROM` を入れれば本当に送られる。** ローカルから送信に至るのは、改造の公開通知（宛先はローカル D1 の元の作者の `users.email`）と、削除依頼の通知（`OPERATOR_EMAIL` も要る）。生成の完了通知と費用 80% の警告はコールバックから出るので、ローカルの Worker からは出ない | `src/mail/resend.ts` の `mailConfigOf` / `sendMail`（`RESEND_ENDPOINT`）、`src/publish.ts` の `notifyForkPublished`、`src/takedown.ts`、`src/generate-callback.ts`。値を入れたまま `npm test` を回すと `test/mail.test.ts` が落とす |

**生成の行の中身**（`BUILD_AWS_*` を入れて、ローカルの画面から生成を押したとき）。

1. ローカルの Worker がクォータを判定し、**ローカルの D1** に作品行を `pending` で作る（`startGeneration`）。
2. **本番の Lambda `game-forge-orchestrator` へ非同期でジョブを投げる**（`startJobOnLambda`。202 が返れば投げ込みは成功）。
   ここで本番の Lambda が起動し、費用が出る。
3. オーケストレータの宛先 `CALLBACK_BASE_URL` は `https://${local.app_host}`、つまり**本番の URL に固定されている**。
   ペイロードでは変えられない（`terraform/orchestrator.tf`、`src/orchestrator/payload.ts`）。
   **結果は本番の URL へ返り、ローカルの D1 には戻らない。**
4. ローカルの作品行は `pending` のまま残る。画面は生成中のまま進まず、15 分（`src/games.ts` の `STALE_AFTER_SECONDS`）
   経つまで、同じ利用者の次の生成・フォーク・推敲を受け付けない（`inFlightGuardSql`）。
5. **Bedrock までは進まない。本番で確かめた**（2026-09-15。#534 のコメント）。
   ローカルの `startJobOnLambda` と同じ形の payload（乱数の `gameId` と `jobToken`）を本番の `game-forge-orchestrator` へ 1 回投げると、
   ログは `[orchestrator] duplicate delivery, standing down`、所要は約 1 秒で、同じ時間帯の `AWS/Bedrock` の Invocations は 0 だった。
   コードの上の理由は次のとおりである。オーケストレータの最初の動作は、本番の URL への `claim` である（`src/orchestrator/pipeline.ts` の `runJobViaCallbacks`）。
   `claim` は**本番の D1** で作品行を `pending` → `running` に進める条件付き UPDATE で（`src/generate-callback.ts`、
   `src/games.ts` の `claimGenerationJob`）、本番の D1 にはローカルの作品行が無いので `claimed: false` になり、
   Bedrock を呼ばずに降りる（`src/orchestrator/handler.ts` の `claimed-elsewhere`）。**それでも本番の Lambda の起動と、
   本番へのコールバックの 1 往復は起きる。** 本番の D1 に同じ id とトークンの行があれば Bedrock まで進むが、
   id は乱数でトークンはハッシュで照合するので、コードの上ではその経路は無い。
   **したがってローカルからは生成を通しで回せず、開発の生成が本番の Bedrock の枠を使うことも無い**（仕様 9.1 / 9.2 の #534 注記）。

#### D. ローカルでは確かめられないもの

**仕様 9.1 の「ローカルで検証できないもの」の表を正本とする。** ここに一覧も件数も書き写さない
（書き写すと 9.1 の行が増えた日に片方が古くなる。以前の 5.1 は 9.1 を写した 5 点のままで、確定24 で増えた
「本番の封じ込め構成」の行が抜けていた）。
いずれもクローズドβで踏むことを受け入れている。

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

### 5.11 開発環境の Go はピン留めと揃っていない。**揃えないと決めた**（M0.5-7 / #185）

```text
手元の go（リポジトリのルートで測ると）:                    go1.26.5
docker/isolated-build/handler の中で実際に走る go:          go1.27.0   ← go が自分で切り替える
```

ピン留めの値の正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION` です。
`.devcontainer/devcontainer.json` は `"ghcr.io/devcontainers/features/go:1"` と
**メジャーだけ**を指定していて、ピン留めとは結び付いていません。**それでよい、というのが
#185 の判断です。**

#### 結論: devcontainer は揃えない。揃えるのは go 自身にやらせる

理由は 3 つあります。

1. **写しを増やさない。** `devcontainer.json` へ版を書けば、#141 が潰して回っている
   「必ず古くなる写し」が 1 つ増えます。しかも JSON なので、正本から導く式を素直に
   書けません（`ARG GO_VERSION` を参照する構文がありません）。
2. **再構築が要らない。** feature 側で版を固定すると、**Go を上げるたびに全員が
   devcontainer を再構築する**運用になります。再構築は安くありません。
3. **そもそも揃っている必要がありません。** go は `go.mod` の `go` ディレクティブを読み、
   手元の go がそれより古ければ**その版のツールチェインへ自分で切り替えます**
   （`GOTOOLCHAIN=auto`。既定）。そして `docker/isolated-build/handler/go.mod` と
   `docker/isolated-build/template/go.mod` の `go` ディレクティブがピン留めと一致することは
   **`scripts/check-go-version-copies.sh` が機械照合しています。**
   **つまり「正本から導く経路」は、新しく作らなくても既に 1 本通っています。**

#### 「手元ではハンドラの単体テストが回らない」は、環境のずれではなく**検査の測り方**でした

`scripts/check-isolated-build.sh` は以前、**リポジトリのルートで** `go env GOVERSION` を
引いて「ホストの Go が足りない」と判定し、さらに `GOTOOLCHAIN=local` を強制して
`go test` を回していました。**前者は切り替えを見ておらず、後者は切り替えを止めています。**

- **外で引いた版は「切り替え前」のものです。** #180 の作業中に
  `scripts/check-sandbox-browser.sh` が `wasm_exec.js` の版で踏んだのと**同じ取り違え**で、
  3.5 が「いちばん原因が読めない失敗」と呼ぶ形そのものです。
  **`go env` はモジュールの中で引くこと。**
- **`GOTOOLCHAIN=local` はビルドイメージ側の要求です**（攻撃者が制御しうる `go.mod` に
  ツールチェインを取りに行かせない。CVE-2023-39320 の系統）。ここでコンパイルするのは
  **このリポジトリのハンドラ**であって投稿されたコードではないので、同じ要求は
  当てはまりません。

直したあとの実測（2026-08-30 / この devcontainer / 手元の go は go1.26.5）:
`go test ./...` は go1.27.0 として **0.33 秒**で通りました。**この skip は最初から
不要でした。**

#### 開発環境で `GOTOOLCHAIN=local` を設定しないこと

設定すると上の切り替えが止まり、**ハンドラの単体テストと `scripts/check-sandbox-browser.sh`
が両方とも手元で回らなくなります。** 「ずれが即座に赤になる」ことを狙う手ではありますが、
赤くなるのは**ピン留めと無関係な「手元の go の版」**であり、直す手段が devcontainer の
再構築しかありません。**採りません。**

#### それでも飛ばされるとき

切り替えが成立しない環境（オフラインの初回、`GOTOOLCHAIN=local` を設定済み、go が無い）
では、`scripts/check-isolated-build.sh` はハンドラの単体テストを**落とさずに飛ばします**
（ホストの環境という、このイメージと無関係な理由で赤を出さないため。#108）。
**飛ばしたことの帰結は出力に書きます。**

以下は**実測の記録**です（2026-08-30 / この devcontainer で `GOTOOLCHAIN=local` を
設定して実際に踏んだときの出力。**測った時点の版のまま残します**——3.5 の更新手順 7）。

```text
[isolated-build] .. ハンドラの単体テストをここでは回しません: モジュールの中での実効ツールチェインが go1.26.5 で、docker/isolated-build/handler/go.mod が要求する 1.27.0 に届きません（GOTOOLCHAIN=local で切り替えが止められているか、ネットワークがありません）
[isolated-build] ..   帰結: **手元の検査がこの 1 本ぶん減ります**（/tmp の掃除の単位）。担保はイメージのビルド側にだけ残ります（同じテストを、ピン留めした版で走らせます）。
[isolated-build] ..   帰結: 同じ理由で `scripts/check-sandbox-browser.sh` も初回にネットワークを要します（ピン留めした版のツールチェインを取りに行くため）。
[isolated-build] ..   経緯と直しかた: docs/local-dev.md 5.11（#185）
```

**担保が消えるわけではありません。** イメージのビルドが同じテストを、ピン留めした版で
走らせます（`docker/isolated-build/Dockerfile`）。失われるのは**気づく時刻の早さ**だけです。

#### 初回はネットワークが要ります

ツールチェインの取得のためです（`go env GOMODCACHE` の下、
`golang.org/toolchain@v0.0.1-go<版>.<OS>-<ARCH>` に載ります）。一度取れば以後は
オフラインでも回りますが、**devcontainer を再構築すると消えます**（このキャッシュは
`.devcontainer/compose.yaml` のボリュームに載せていません）。

---

## 6. この段階で作っていないもの

M1 以降が所有する。ここで先に作らない。

| 対象 | 所有する issue |
|---|---|
| Next.js / React のフロント | 未起票。確定22 で配置先は Pages Functions に決まったが、MVP の画面は SSR HTML で足りているため、必要になった時点で起票する |
| 本番のビルド実行環境への配備の実行（イメージの GHCR への push までは M2-4 で済んでいる） | **確定24 で配備先は AWS Lambda（ECR へ push ＋ 関数更新）に決まった**（仕様書 9.3）。実際の構築は M2-9 の範囲外で、関数と ECR / VPC の宣言が要る。v1.8 までは「VPS への自動デプロイの実行 / M2-5 の前提となる VPS が要る」 |
| ビルドの同時実行制御・タイムアウト・結果キャッシュ | M2-5 |
| 本番の D1 / R2 と Pages プロジェクトの宣言 | 未決。手順は [pages-deploy.md](pages-deploy.md) にあるが、Terraform で宣言するかが決まっていない |

---

## 7. dev01 に副開発環境を立てる（#802）

**Mac を持ち歩いている間も作業が進むように、dev01 に同じ devcontainer を立てる。** 全面移設ではなく分業である
（#802 の本文）。Mac は `acceptance.sh` の反復・terraform・本番の確認を持ち、dev01 は
`npm run check:isolated-build`（amd64 ネイティブ）・長い調査・CI とレビューの待ち・持ち歩き中の作業を持つ。

**dev01 に置かないもの**: `terraform/terraform.tfvars` と `CLOUDFLARE_API_TOKEN`（terraform は Mac から回す）。
本番への書き込みコマンドも dev01 からは打たない。

dev01 への入り方（`ssh dev01-ssh.ojos.jp`。Cloudflare Tunnel と Access）は [local-llm-tunnel.md](local-llm-tunnel.md) にある。
以下の 7.1〜7.3 は **dev01 のホスト**で、7.4 以降は **dev01 の上のコンテナの中**で行う。

### 7.1 Docker Engine を入れる（ホスト）

**Docker Desktop ではなく Docker Engine を入れる。** VM を挟まず、14Gi のメモリをそのまま使うためである。
手順は Docker の公式の apt リポジトリによる導入である。

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

`usermod` の後は**ログインし直す**（グループはログインのときに決まる）。入り直したら
`docker run --rm hello-world` が sudo なしで通ることを確かめる。**docker グループは root と同等の権限を持つ**
ので、足すのは自分のユーザーだけにする。

### 7.2 clone する（ホスト）

```bash
git clone https://github.com/ojos/game-forge.git ~/game-forge
```

**以下は `~/game-forge` に置いた前提で書く。** コンテナの中では置き場所に依らず `/workspaces/game-forge` になるが、
7.7 の attach はホストの clone の絶対パス（`devcontainer.local_folder` のラベル）でコンテナを探すので、
別の場所に置いたときは 7.7 の `$HOME/game-forge` をそのパスへ読み替える。

### 7.3 ホストの宣言を置く（ホスト）

**dev01 の利用者は uid=1001（`ido`）で、ベースイメージの vscode は 1000 である。** Docker Desktop for Mac は
ファイル共有層が所有者を写すのでずれが表に出ないが、**ネイティブ Linux の Docker は数値の UID をそのまま通す**ため、
付け替えなければコンテナからワークスペースへ書き込めない。

**付け替えは devcontainer CLI が行う**（`devcontainer.json` の `"updateRemoteUserUID": true`。#879）。CLI が Linux で
動くとき（Remote-SSH で dev01 に入って開く）は、compose 方式でもコンテナを作るたびに `-uid` 付きのイメージを作り、
vscode を開いた利用者の UID/GID（1001）へ付け替える。macOS では CLI が既定で飛ばすので、Mac は 1000 のまま変わらない。
**ここで UID を渡す必要は無い。**

- 2026-10-02 に dev01 で実測した（#879 のコメント）。以前は #802 の「compose 方式には効かない」という前提で
  `.devcontainer/Dockerfile` と `remap-vscode-user.sh` がビルド引数（`DEVCONTAINER_UID` / `DEVCONTAINER_GID`）で
  付け替えていたが、前提が成り立たず機構が二重になっていたので外した。**既存の `.devcontainer/.env` に残った
  `DEVCONTAINER_UID` / `DEVCONTAINER_GID` は、もう何にも読まれない**（消してよい）。
- **代償**: CLI の段は features の後に走り、`$HOME` しか chown しない。features が置いた `/go`・`/usr/local/go`・
  `/usr/local/share/nvm` の所有者は 1000（`ls -l` で `UNKNOWN`）のまま残る。どれも setgid のグループ書き込み可で、
  vscode は `golang` / `nvm` のグループに入っているので、`npm i -g` も `go install` も通る（実測）。所有者の表示が
  `UNKNOWN` なのはこのためで、異常ではない。

置くのはホストの宣言だけで、**`.devcontainer/.env`（追跡外。`.gitignore` の `.env` が効く）**に書く。

```bash
cd ~/game-forge
printf 'DEVCONTAINER_HOST=dev01\n' > .devcontainer/.env
docker compose -f .devcontainer/compose.yaml config | grep DEVCONTAINER_HOST   # DEVCONTAINER_HOST: dev01 であること
```

- **`.devcontainer/.env` に書く理由**: compose は、compose ファイルの在るディレクトリの `.env` を既定で読む
  （起動したときのカレントディレクトリに依らない。docker compose v5.5.1 で実測）。devcontainer CLI（0.88.0 を読んだ）は
  `--env-file` を `dockerComposeFile` が空の配列のときにしか渡さないので、この構成では compose の既定が効く。
  **シェルの環境変数に export しても効く**（こちらが `.env` より優先される）が、ssh の非対話のコマンドや
  systemd からの起動では読まれないことがあるので、ファイルに置く。
- **`DEVCONTAINER_HOST=dev01`** は、`scripts/install-cloudflared.sh` に「このコンテナのホストは dev01 自身である」と
  伝える宣言である。値が `dev01` のとき、あのスクリプトは cloudflared の導入も `~/.ssh/config` への入口の追記もしない
  （dev01 から dev01 へトンネルを回って入る**自己参照の入口**を作らないため。判定を自動にしなかった理由はスクリプトの末尾）。
  書き忘れは 7.4 の `grep -c 'Host dev01' ~/.ssh/config` が 0 にならないことで分かる。

### 7.4 コンテナを立てて入る

VS Code で Remote-SSH で `dev01-ssh.ojos.jp` に入り、`~/game-forge` を開いて「Reopen in Container」を選ぶ。
`postCreateCommand` の出力に `[install-cloudflared] DEVCONTAINER_HOST=dev01: …` の行が出ていれば、7.3 の宣言が届いている。

入ったら、コンテナの中で確かめる。

```bash
id                                   # uid=1001(vscode) gid=1001(vscode)
touch .dev01-write-probe && rm .dev01-write-probe && echo WRITE_OK
docker ps >/dev/null && echo DOCKER_OK   # docker グループがコンテナから通っていること
grep -c 'Host dev01' ~/.ssh/config 2>/dev/null || true   # 0 か、ファイルが無いこと
cat /proc/self/attr/current          # unconfined（docker-default (enforce) なら compose.yaml の security_opt が効いていない）
bwrap --ro-bind / / true && echo BWRAP_OK   # codex の read-only のサンドボックスが動くこと（#874）
```

**codex の第二意見が差分を読めることも、作り直した後に 1 回確かめる**（#874）。dev01 の Docker は AppArmor の
`docker-default` をコンテナに当て、その `deny mount` で codex の bwrap が止まる。`compose.yaml` の
`security_opt: apparmor=unconfined` で外してある（理由と代償は compose.yaml の注記）。

```bash
codex sandbox -c sandbox_mode='"read-only"' -- sh -c 'git log -1 --oneline; touch .codex-probe'
# git log が出て、touch が Read-only file system で失敗すること（書き込みは止まり、読み取りは通る）
```

続けて、**第二意見そのものが差分を読むこと**を見る（上のコマンドはサンドボックスを確かめるだけで、第二意見は回していない）。

```bash
bash scripts/second-opinion-review.sh --engine codex --range HEAD~1..HEAD
# 「run 1/1: LGTM」か「findings」の行が出て、指摘があれば HEAD の差分の中身（ファイルと行）を名指ししていること。
# 「差分を読めなかったと答えました」で終わるなら、codex はまだ差分を読めていない
```

2026-10-02 に dev01 で作り直した後、4 つとも期待どおりだった（`unconfined` / `BWRAP_OK` / 書き込みだけ `Read-only file system` /
第二意見が `docs/local-dev.md` の行を名指しした回答。#874 のコメント）。`/proc` の mount は要らなかった。
もし `/proc` の mount で失敗する版の codex が来たら、AppArmor を外すだけでは足りない（`systempaths=unconfined` まで要るかは、
代償が大きいので改めて判断する）。**読めないまま答えた回は #873 のゲートが GATE_FAIL で止める**ので、
緑のまま通ることはない。そのあいだは `--engine antigravity` で回す。

**`devcontainer.json` は `shutdownAction: stopCompose` だが、Remote-SSH 越しに開いた dev01 の窓は、閉じてもコンテナを止めなかった**
（2026-10-01 に 2 回。窓を閉じた後も `docker events` に stop / die が出ず、tmux も残った。Dev Containers 0.469.0。
窓を閉じると先に SSH の接続が切れ、停止が dev01 まで届かないためと見ている）。**止まる前提では組まないが、止まらない前提にも頼らない**——
拡張の版や閉じ方で変わりうるので、止まっても 7.9 のユニットが 30 秒後に戻す形にしてある。
**VS Code は導入とログイン（7.5・7.6）に使い、持ち歩き中の作業は 7.7 の形（ssh から `docker start` と `docker exec` で
tmux に入る）で回す。**

### 7.5 `.env` と `npm ci`（コンテナの中）

リポジトリ直下の `.env`（開発ツール向け。`GH_TOKEN`、`SECOND_OPINION_ENGINE` など）は、**Mac の `.env` から
手で写す**（リポジトリを経由させない）。キーの一覧は `.env.example` にある。

- **`GH_TOKEN` は Mac の値を写さず、dev01 用の PAT を別に発行して置く**（#869）。Mac 用の PAT は terraform と
  外部層のために管理者の権限まで持つので、**dev01 には持ち込まない。** 発行の手順と dev01 の権限の組（管理者・変数は
  No access）は `.github/project-ai-rules.md`「GitHub 認証（gh）だけを例外にする理由」の表にある（Mac も PAT に
  揃えた。#869 のコメントで scope を変えた）。置いたら、**新しいシェルを開くか `set -a; . scripts/load-project-env.sh; set +a`
  で読み込み直してから**（`.env` を読むのは on-attach とシェルの起動時だけで、開いているシェルには反映されない）、
  `gh auth status` が `(GH_TOKEN)` と出て、`gh api user --jq .login` が `ojos` を返すことを確かめる。
- **`gh auth login` を打たない。** `.env` の `GH_TOKEN` が優先されるのでログインの結果は使われず、それでも
  OAuth トークンが 1 本発行され、上限に達していれば**他の環境のトークンを 1 本失効させる**
  （同じ節）。on-attach も、gh が使えないときは `gh auth login` ではなく `GH_TOKEN` を案内する。
- **`CLOUDFLARE_API_TOKEN` は写さない**（terraform は Mac から回す）。

```bash
npm ci                       # node_modules は実体で置く（symlink にしない）
bash scripts/verify.sh       # VERIFY_PASS
npm run check:isolated-build # amd64 ネイティブ。エミュレーションなし
```

最初の `verify` が `EBITEN_KEYS_FAIL` で止まったら、rebuild の直後と同じ扱いである（Go のモジュールキャッシュが空。
`docs/handoff.md` 3 章の rebuild の項）。

### 7.6 第二意見の CLI に対話でログインする（コンテナの中）

`bash scripts/loop-gate.sh` は第二意見の CLI を呼ぶので、使うエンジン（`.env` の `SECOND_OPINION_ENGINE`。既定の運用は codex）へ
**1 度だけ対話でログインする。** 資格情報は named volume（`codex-storage` / `gemini-storage`）に載るので、コンテナを作り直しても残る。

```bash
codex login          # codex のとき
agy                  # antigravity のとき（起動して Google アカウントでログイン）
bash scripts/post-rebuild-check.sh   # 道具と volume のマウントを一覧で確かめる
```

**ログインは VS Code の端末から行う。** どちらもブラウザでの認証の後に `localhost` へ戻ってくる形で、VS Code は
コンテナのその口を手元のブラウザへ自動で転送する。ssh と `docker exec` だけで入っている端末からは、戻り先へ届かない。

### 7.7 tmux に常駐させて attach する

**作業は tmux の中で走らせる。** ssh が切れても（鞄に入れても）エージェントは止まらない。

コンテナの中で（VS Code の端末でも、下の ssh からでも同じ）:

```bash
tmux new -A -s main   # 無ければ作り、在れば入る
# 抜けるときは Ctrl-b d（tmux は動き続ける）
```

手元（Mac）から、VS Code を開かずに直接入る（Mac の `~/.ssh/config` にあるのは `Host dev01-ssh.ojos.jp` なので、
その名前で入る。[local-llm-tunnel.md](local-llm-tunnel.md) の「手元の Mac 側の手順」）:

```bash
ssh -t dev01-ssh.ojos.jp '
  id="$(docker ps -aq --filter label=com.docker.compose.service=app --filter label=devcontainer.local_folder=$HOME/game-forge)"
  [ -n "$id" ] || { echo "コンテナがありません。7.4 で一度立ててください" >&2; exit 1; }
  docker start "$id" >/dev/null
  docker exec -it -u vscode -w /workspaces/game-forge "$id" tmux new -A -s main'
```

- `docker ps -a` の絞り込みは、devcontainer が付けるラベル（`devcontainer.local_folder`。ホストの clone の絶対パス）と
  compose のサービス名で行う。**止まっているコンテナも拾い、`docker start` で起こしてから入る**
  （VS Code の窓を閉じて止まった後でも、この 1 行で戻れる。動いているコンテナへの `docker start` は何もしない）。
- **tmux のセッションはコンテナと一緒に消える。** コンテナを作り直す・止める（ユニットの `docker kill` の試験や、
  stopCompose が届いた場合を含む）と、中の作業も止まる。自動で戻す仕組み（systemd）とスマホからの入口は 7.9 にある。

### 7.8 確かめること（#802 の acceptance との対応）

| acceptance | 確かめ方 | 誰が |
|---|---|---|
| dev01 の devcontainer で VERIFY_PASS | 7.5 の `bash scripts/verify.sh` | 利用者（dev01） |
| dev01 で `check:isolated-build` が通る | 7.5 の `npm run check:isolated-build` | 利用者（dev01） |
| ワークスペースへ書き込める | 7.4 の `WRITE_OK` | 利用者（dev01） |
| Mac で作り直しても VERIFY_PASS | Mac で Rebuild Container の後に `bash scripts/verify.sh`（macOS では CLI が付け替えを飛ばすので 1000 のまま） | 利用者（Mac） |
| dev01 で自己参照の入口を書かない | 7.4 の `grep -c 'Host dev01' ~/.ssh/config` が 0 | 利用者（dev01）。分岐そのものは `scripts/check-devcontainer-dev01.sh` が毎回見る |
| dev01 で `terraform plan` が必須変数の不足で落ちる | `terraform -chdir=terraform init && terraform -chdir=terraform plan -input=false` が `No value for required variable` で止まる（tfvars を置いていないので fail-closed。2026-10-01 は 12 件）。**`init` は `terraform/.terraform.lock.hcl` に linux_amd64 の `h1:` を足して作業ツリーを汚す。先に `git diff --quiet -- terraform/.terraform.lock.hcl` で変更が無いことを確かめ、確かめた後に `git checkout -- terraform/.terraform.lock.hcl` で戻す**（先に変更があれば戻さない。それごと消えるため） | 利用者（dev01） |

**ホストの宣言が届くこと・`updateRemoteUserUID` を外していないこと・ベースの固定・
install-cloudflared.sh の分岐は、`scripts/check-devcontainer-dev01.sh`（`scripts/acceptance.sh` から回る）が
機械で見る。** CLI の実際の付け替えと、実機での書き込みはそこでは見ない（7.4 の `id` と `WRITE_OK`）。

### 7.9 スマホから起こし・入り・再認証する（#849）

**Mac が手元に無いとき、Android（Termux）のショートカットのタップだけで、dev01 の devcontainer を起こし、
tmux に入り、AWS を再認証できるようにする。** 道具（`dev`）とユニット（`dev-up@.service`）は、
**devcontainer-bootstrap（DCB）のリリースに同梱された上流の版**（#923 で寄せた。dev01 に置く版は tools/devhost/README.md の
「上流の版を上げる」の `TAG=` の行が正本）を使い、このリポジトリには置かない。
上流は特定のクラウドへの認証を組み込まないので、AWS SSO に入るところだけを game-forge の薄い追加
`dev-auth-aws`（[tools/devhost/](../tools/devhost/README.md)。`scripts/check-devhost.sh` が自己試験を回す）として残している。
導入の一般の手順・stopCompose の扱いの比較・鍵の作り方と失効のさせ方は DCB のアーカイブの `devhost/README.md` が正本で、
上流の版を上げる手順・game-forge 版からの移行の記録・上流へ寄せて失ったもの（`dev ls` の AWS の列）は tools/devhost/README.md にある。
ここには、このリポジトリと dev01 の値で埋めた形と、復旧の手順だけを書く。

**自動で戻すのはコンテナまで。** tmux と Claude はタップで手で起こす。電源・OS（①）と、cloudflared と sshd（②）は
この節の範囲外である（#800 / #801 と [local-llm-tunnel.md](local-llm-tunnel.md)）。

#### ホスト（dev01）で 1 度だけ

上流の README の「外部の機械への導入」（tools/devhost/README.md の `TAG=` の版のアーカイブから、マニフェストのハッシュで照合して取り出す）を、
次の設定ファイルで行う。続けて、薄い追加 `dev-auth-aws` を tools/devhost/README.md の「薄い追加を置く・更新する」のとおりに置く。

```bash
mkdir -p ~/.config/dev
printf 'game-forge %s/game-forge\n' "$HOME" > ~/.config/dev/projects       # 上流の dev の設定（AWS のキーは書かない。上流は知らないキーで止まる）
printf 'game-forge %s/game-forge ojos\n' "$HOME" > ~/.config/dev/aws-sso   # dev-auth-aws の設定（名前 パス SSO のセッション名）
~/.local/bin/dev ls
systemctl --user enable --now dev-up@game-forge.service
```

- `dev-auth-aws` は、**コンテナの中の `~/.aws/config`**（`aws-storage` のボリューム）に
  `[sso-session ojos]` と `game-forge-dev` のプロファイルがあることを前提にする。無ければ Mac の `~/.aws/config` を写す
  （鍵やトークンは含まない。SSO のトークンはコンテナごとのボリュームに載り、共有しない）。
  **写すのは `[sso-session ojos]` と `[profile game-forge-dev]` の 2 節だけにする**（dev01 から本番に書き込まないので、
  `game-forge-prod` の名前を置かない）。
- **`sso_start_url` は新しいドメインの `https://ssoins-77588ce356c120e7.portal.ap-northeast-1.app.aws` にする。**
  旧ドメインの `https://d-956797eff8.awsapps.com/start` のままだと、デバイスコードの画面で Google の認証を済ませた後に
  「問題が発生しました」で止まる（2026-10-01 に Pixel 8 と Mac の両方で再現。先にアクセスポータルへ新ドメインでサインインして
  おくと通るのは、そのセッションが残っているため）。新ドメインにすると、事前のサインインなしで `gf-auth-aws` が通った。
- **作り直しは `dev rebuild game-forge`** で行う（v0.17.0 から。ユニットの停止と起こし直しまでする）。
  VS Code の Rebuild Container で作り直すときは、**先に `systemctl --user stop dev-up@game-forge.service`**、終わったら `start` する
  （上流の README の「VS Code の窓を閉じたときの停止」）。

#### スマホ（Termux）で 1 度だけ

Termux と Termux:Widget を**同じ入手元（F-Droid か GitHub）**から入れ、上流の README の「端末専用の鍵」で鍵を作って
dev01 の `authorized_keys` に足す（鍵の名前は下では `id_ed25519_phone` とする）。そのうえで:

```bash
cat >> ~/.ssh/config <<'CONF'
Host dev01
  User ido
  HostName dev01-ssh.ojos.jp
  ProxyCommand cloudflared access ssh --hostname %h
  IdentityFile ~/.ssh/id_ed25519_phone
  IdentitiesOnly yes
  ServerAliveInterval 30
CONF
mkdir -p ~/.shortcuts && chmod 700 ~/.shortcuts
for b in "gf-attach:dev attach game-forge" "gf-up:dev up game-forge" "gf-auth-aws:dev-auth-aws game-forge" "dev-ls:dev ls"; do
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec ssh -t dev01 .local/bin/%s\n' "${b#*:}" > ~/.shortcuts/"${b%%:*}"
done
chmod +x ~/.shortcuts/*
ssh dev01 .local/bin/dev ls     # 最初の 1 回は Access の URL が出る。長押しで開いて認証する
```

- **`User ido` を落とさない。** 無いと Termux のユーザー名（`u0_a465` のような値）で入ろうとして
  `Permission denied (publickey)` になる（2026-10-01 に実際に踏んだ。鍵の失効と同じ表示なので取り違えやすい）。
- **Termux に「他のアプリの上に重ねて表示」の許可が要る**（Android の設定 → アプリ → Termux）。
  無いと、ウィジェットのボタンを押したときに許可を求める表示が出て進まない。
- ボタンの画面は、ssh が終わると Termux:Widget が閉じる。出力を読みたいときは Termux を開いて同じ `ssh -t dev01 …` を打つ。

ホーム画面に Termux:Widget を置くと、`gf-attach` / `gf-up` / `gf-auth-aws` / `dev-ls` の 4 つのボタンになる。
`gf-doctor` / `gf-rebuild` のボタンを足すかどうかは利用者が決める（足し方と、`gf-rebuild` の誤タップで作業が消えることは
tools/devhost/README.md の「スマホのボタンに doctor / rebuild を足す」）。

#### 復旧の手順（どの層が落ちたら、どのボタンを押すか）

| 症状 | 層 | 押すもの |
|---|---|---|
| どのボタンも応答せず、ssh がタイムアウトする | ① 電源・OS / ② 入口 | **範囲外。** スマホからは戻せない。帰宅後に dev01 の電源と `systemctl status cloudflared ssh` を見る |
| URL が出て止まる | Access の認証切れ | URL を長押しで開いて認証する。そのまま続く |
| `Permission denied (publickey)` | 鍵 | 鍵の行が `authorized_keys` に無い（失効させた・足し忘れ）。Mac から足し直す |
| `dev-ls` の CONTAINER が `exited` / `none` | ③ devcontainer | 30 秒待って `dev-ls`。戻らなければ `gf-up` |
| `gf-up` が失敗する | ③ | `ssh -t dev01 journalctl --user -u dev-up@game-forge -n 30` で理由を読む |
| `dev-ls` の CONTAINER は running なのに `gf-attach` が入れない | ③' devcontainer | Termux で `ssh -t dev01 .local/bin/dev doctor game-forge`（足していれば `gf-doctor`）。FAIL なら `dev rebuild game-forge`（中の作業は消える） |
| `dev-ls` の TMUX が `none` | ④ tmux | `gf-attach`（無ければ作って入る）。Claude はその中で手で起こす |
| AWS の CLI が `Token has expired` で落ちる（`dev-ls` には AWS の列が無い。#923 で上流へ寄せて失った） | ⑤ 認証 | `gf-auth-aws`。出た URL をブラウザで開き、コードを承認する。切れているかだけを見るなら、`gf-attach` の中で `aws sts get-caller-identity --profile game-forge-dev` |
| GCP（24 時間）が切れた | ⑤ 認証 | `gf-attach` の中で `gcloud auth login --no-launch-browser`（薄い追加は AWS だけを持つ） |

#### 確かめること（#849 の acceptance との対応）

| acceptance | 確かめ方 | 誰が |
|---|---|---|
| 道具に非対話の試験があり、変異で赤になる | 上流の版は上流の自己試験。薄い追加は `bash scripts/check-devhost.sh`（`scripts/acceptance.sh` から回る） | 機械 |
| 道具とユニットに固有の名前・パスが無い | 上流の版は上流の検査。薄い追加は同上（`tools/devhost/` のスクリプトの中身とファイル名の綴り。#923 から README は見ない） | 機械 |
| 再起動の後、手を触れずにコンテナが立ち上がる | `sudo reboot` の後、`dev-ls` の CONTAINER が running | 利用者（dev01） |
| `docker kill` で落とすとユニットが戻す | `docker kill <ID>` の 30 秒後に `dev-ls` が running | 利用者（dev01） |
| Termux のタップで attach・up・auth aws を 1 回ずつ通す | 3 つのボタン（auth はデバイスコードをスマホのブラウザで承認）。#923 で上流の版と `dev-auth-aws` に替えた後も、同じボタンで通す | 利用者（Pixel 8） |
| 鍵の行を消すと入れなくなる | 上流の README の「失効させる」の後、ボタンが `Permission denied (publickey)` | 利用者（dev01 と Pixel 8） |
| `bash scripts/verify.sh` が VERIFY_PASS | 手元と CI | 機械 |

---

## 8. DCB と規範への追従（#938）

`.devcontainer/`・`scripts/` の一部・`.github/workflows/` の 3 本（`verify.yml`・`identity-guard.yml`・`second-opinion-gate.yml`）・`.claude/`・`.ai-playbook/**`・入口ファイル（`CLAUDE.md`・`AGENTS.md`・`.github/copilot-instructions.md`）は、devcontainer-bootstrap（DCB）が生成するファイルです。**生成時の入力（引数）と、ファイルごとのハッシュは `.devcontainer/ORIGIN` が記録しています**（#938 で初めて置きました。v0.17.0・規範 ai-playbook v0.8.1）。次からは、引数なしの `bootstrap.sh --upgrade` で、記録から同じ入力を再現して追従できます。

**どのファイルを雛形どおりにし、どの差分を残しているかは `.github/project-ai-rules.md`「雛形からの逸脱」が正本です。** 追従のたびに、表に無い差分を雛形へ戻し、表にある差分だけを残します。

### 8.1 手順

1. **専用の worktree とブランチで行います**（`origin/main` から切り、`npm ci` で `node_modules` の実体を置く。`.github/project-ai-rules.md`「作業ツリーの分離」）。
2. **新しい版を、マニフェストのハッシュで照合してから展開します。** 展開先は作業ツリーの外の空のディレクトリにします。

   ```bash
   TAG=v0.17.0   # 追従先の版
   mkdir -p ~/dcb-"$TAG" && cd ~/dcb-"$TAG"
   BASE="https://github.com/ojos/devcontainer-bootstrap/releases/download/${TAG}"
   curl -sSL "${BASE}/RELEASE-MANIFEST.json" -o RELEASE-MANIFEST.json
   curl -sSL "${BASE}/PACKAGE_ARCHIVE.tar.gz" -o PACKAGE_ARCHIVE.tar.gz
   want="$(jq -r '.checksums["PACKAGE_ARCHIVE.tar.gz"]' RELEASE-MANIFEST.json)"
   got="$(openssl dgst -sha256 -r PACKAGE_ARCHIVE.tar.gz | cut -d' ' -f1)"
   [ -n "$want" ] && [ "$want" = "$got" ] && echo HASH_OK   # HASH_OK が出なければ先へ進まない
   mkdir -p x && tar -xzf PACKAGE_ARCHIVE.tar.gz -C x
   ```

3. **計画を見ます。** 作業ツリーの根で、引数なしの `--upgrade --dry-run` を打ちます（何も書きません）。規範の版を上げるときだけ `--playbook-version <tag>` を渡します（渡したものだけが記録を上書きします）。

   ```bash
   bash ~/dcb-"$TAG"/x/bootstrap.sh --upgrade --dry-run
   ```

4. **取り込みます。** 終了コード 0 なら全件を適用済み、2 なら `.dcb-new` が残っています（想定どおり。逸脱を残したファイルと、プロジェクトが所有するファイルには毎回置かれます）。

   ```bash
   bash ~/dcb-"$TAG"/x/bootstrap.sh --upgrade
   find . -name '*.dcb-new' -not -path './node_modules/*'
   ```

5. **`.dcb-new` を 1 本ずつ片付けます。**
   - **DCB が所有するファイル**: `.dcb-new` を正として置き換え、「雛形からの逸脱」の表にある差分だけを戻します。表に無い差分を戻すなら、表へ行を足す（理由と基準つき）ところまでを同じ PR で行います。
   - **プロジェクトが所有するファイル**（`scripts/acceptance.sh`・`scripts/acceptance-remote.sh`・`scripts/check-no-secrets.sh`・`.github/project-ai-rules.md`）: 中身を残し、雛形で増えた項目があれば書き足します。
   - **`.devcontainer/` の 2 本**: #938 の時点では取り込んでいません（表の最後の行）。取り込むときは別の票で、コンテナの作り直しまで確かめます。
   - 済んだら `.dcb-new` を消します。雛形に寄せて game-forge 固有の検査（`scripts/acceptance.sh` が呼ぶ `scripts/check-*.sh` など）が落ちたら、検査の側（プロジェクトの所有）で直します。

6. **手を入れたファイルを取り込み済みとして記録します。** 表にあるファイルと、プロジェクトが所有するファイルを渡します（`.dcb-new` が残っていると止まります）。

   ```bash
   bash ~/dcb-"$TAG"/x/bootstrap.sh --accept \
     scripts/acceptance.sh scripts/acceptance-remote.sh scripts/check-no-secrets.sh \
     .github/project-ai-rules.md .github/workflows/verify.yml .env.example scripts/on-attach.sh \
     .claude/agents/implementer.md .claude/agents/explorer.md \
     .devcontainer/compose.yaml .devcontainer/devcontainer.json
   ```

7. **確かめます。** 3 つとも満たしてから PR にします。

   ```bash
   bash ~/dcb-"$TAG"/x/doctor.sh                     # FAIL も WARN も出ない
   bash ~/dcb-"$TAG"/x/bootstrap.sh --upgrade --dry-run   # keep / .dcb-new / create が 1 件も出ない
   bash scripts/loop-gate.sh                          # GATE_PASS
   ```

8. **`.github/workflows/deploy.yml` を変えたときは、マージ後の最初の `main` の push で配備を見届けます。** `workflow_run` のワークフローは既定ブランチの定義で動くので、PR の CI では 1 度も走りません（`docs/pages-deploy.md`「自動配備」）。

### 8.2 注意

- **`--accept` した後でさらに手を入れると、`doctor.sh` は再び FAIL を出します。** 表にあるファイルを直したら、`--accept` し直します。
- **dev01 の devhost（`tools/devhost/`・ホストのユニット）は、この手順の対象外です。** 版を上げるときは 7 章の手順で、別に行います。
- 雛形そのものを変えたいとき（上流の ojos/ai-packages-dev / ojos/ai-playbook への提案）は、このリポジトリでは扱いません。ここで行うのは、逸脱の表に行を足すところまでです。
