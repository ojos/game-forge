# Cloudflare Pages への配備手順

- 位置づけ: 確定22（アプリと API は Pages Functions）を実際に配備するための手順書。
- 対象: `app.game-forge.ojos.jp`（アプリ）と `sandbox.game-forge.ojos.jp`（UGC）。
- **この文書は手順であって、実行の記録ではない。** 実際の配備は外部状態の変更なので、
  行った時点で `terraform/` か本文書に結果を残すこと。

## なぜ Workers ではなく Pages か

`game-forge.ojos.jp` のゾーンは確定17 に従って **AWS Route53 へ NS 委譲済み**で、
Cloudflare 上にありません。

- **Workers のカスタムドメインは、ゾーンが Cloudflare 上にあることを要求します。** 使えません。
- **Pages のカスタムドメインは、サブドメインであれば外部 DNS のまま CNAME 1 本で足ります。**

ゾーンを Cloudflare へ戻す案は採りません。確定17 の委譲と 9.2 の AWS アカウント設計を
巻き戻すことになり、DNS を Terraform で宣言的に管理する目的（さくらに DNS の API が
無いことへの対処）を捨てることになるためです。

## なぜアプリ用ホストが `app.` 付きなのか（#89）

**「サブドメインであれば」が効きます。** 委譲したホストゾーンの名前が
`game-forge.ojos.jp` である以上、`game-forge.ojos.jp` は**そのゾーンの apex** です。

- **Route53 は apex に CNAME を作れません。** apex には SOA と NS が必ず在り、
  CNAME は他のレコードと同居できないためです。
- **Route53 の ALIAS も使えません。** ALIAS が指せるのは CloudFront / ELB などの
  AWS リソースと同一ゾーン内のレコードだけで、`*.pages.dev` は指せません。
- **Cloudflare Pages 側も、外部 DNS のままの apex を対象外としています。**
  apex へ配備するならドメインごと Cloudflare のゾーンにしてネームサーバを向けよ、と
  文書が明記しています。
- **`game-forge.ojos.jp` だけを Cloudflare のゾーンにする案**（サブドメイン単独ゾーン）は、
  親が外部 DNS の場合 **Business / Enterprise プラン限定**です。

ラベルを 1 つ足すと、ゾーンも委譲もそのままで CNAME 1 本で張れます。採らなかった案と
その理由は仕様書 1.2.11 にあります。**`game-forge.ojos.jp` そのものは空いたまま**で、
後日 `ojos.jp` ごと移送する判断をしたときに当初の綴りへ戻せます。

**7.2 の要件は変わりません。** `app.` と `sandbox.` は兄弟になりますが、登録可能ドメインは
どちらも `ojos.jp` のままです。兄弟でも `Domain=game-forge.ojos.jp` の cookie は相手へ
届くため、`__Host-` 接頭辞と CSP `sandbox` ヘッダの必要性はそのままです。

## 構成

```
functions/[[path]].ts   Pages Functions の入口。src/index.ts の default export を呼ぶだけ
public/                 出力ディレクトリ。空（.gitkeep のみ）
wrangler.toml           pages_build_output_dir とバインディングの宣言
```

**`public/` に静的ファイルを置かないこと。** Pages は静的ファイルを Functions より先に
解決するため、`index.html` を置くと `/` の経路が隠れます（実測で確認）。画面はすべて
Worker が生成します。

## 前提: 認証

`wrangler` は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数から直接読みます。
値は `.env`（追跡外）に置き、`scripts/load-project-env.sh` 経由で読み込みます。

```bash
set -a; source scripts/load-project-env.sh; set +a
npx wrangler whoami
```

**`wrangler login` は使えません。** OAuth のコールバックをブラウザで受けるため、
ブラウザの無い devcontainer では完結しません（AWS SSO の `--use-device-code` や
gcloud の `--no-launch-browser` にあたる逃げ道が wrangler にはありません）。
トークンを `.env` へ書き写すのは、この事情による例外です（`.env.example` の該当項参照）。

必要な権限は次の 3 つで足ります。ダッシュボードの My Profile → API Tokens で発行します。

| スコープ | 権限 |
|---|---|
| Account / Cloudflare Pages | Edit |
| Account / D1 | Edit |
| Account / Workers R2 Storage | Edit |

**トークンの期限は API から読めません。** `GET /user/tokens/verify` は `active` かどうかしか
返さず（`expires_on` は null で返る）、`GET /user/tokens` は「API Tokens Read」権限が無い
このトークンでは 9109 で拒否されます。**期限の確認はダッシュボードでのみ可能**です。

## 配備

### 0. R2 をダッシュボードで有効化する（初回のみ）

**R2 は一度ダッシュボードで有効化しないと API から使えません。** 未有効の状態で
`wrangler r2 bucket create` を実行すると、次のエラーで落ちます。

```
code: 10042  You must sign up for R2 before you can use it
```

`https://dash.cloudflare.com/<account_id>/r2` を開き、有効化してから先へ進みます。
**この 1 回だけはダッシュボード操作が唯一の経路**で、宣言化できません。

### 1. プロジェクトを作る（初回のみ）

```bash
npx wrangler pages project create game-forge --production-branch main
```

### 2. D1 と R2 を作る（初回のみ）

```bash
npx wrangler d1 create game-forge
npx wrangler r2 bucket create game-forge
```

`d1 create` が出力する `database_id` を `wrangler.toml` の
`[[env.production.d1_databases]]` と `[[env.preview.d1_databases]]` へ書きます。

### 3. `wrangler.toml` の本番値

**Pages が受け付ける名前付き環境は `preview` と `production` の 2 つだけ**です。
`wrangler pages deploy` は、配備先ブランチが `production_branch` と一致するかで
どちらを読むかを決めます。

**`vars` / `d1_databases` / `r2_buckets` は環境へ引き継がれません。**
名前付き環境で省くと、トップレベル（＝ローカル向けの値）が使われるのではなく
**バインディング自体が消えます**（`wrangler types` が `DB?: D1Database` と省略可能に
変わることで確認できます）。両方の環境で必ず明示してください。

とくに **`DEV_ROUTES` を書き忘れると診断経路が本番で開いたままになります。**
`src/app.ts` の `devRoutesEnabled` は値が `enabled` に一致したときだけ有効にするため、
宣言し忘れた環境は閉じる側へ倒れますが、**閉じると決めたことを宣言に残す**ため
`disabled` を明示します。この 3 つは `test/origins.test.ts` が `wrangler.toml` を
読んで検査します。

### 4. マイグレーションを本番 D1 へ適用する

```bash
npx wrangler d1 migrations list DB --remote --env production
npx wrangler d1 migrations apply DB --remote --env production
```

冪等性は D1 側の `d1_migrations` テーブルが担保します（`migrations/0001_init.sql` の冒頭）。

### 5. シークレットを入れる

`.dev.vars` に置いているものと同じ名前で、Pages のシークレットとして登録します。

```bash
npx wrangler pages secret put SESSION_SECRET --project-name game-forge
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name game-forge
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name game-forge
```

**`SESSION_SECRET` はローカルの値を使い回さないこと。** 32 文字以上のランダム値を
本番用に新しく作ります。

**Bedrock の資格情報（`BEDROCK_AWS_*`）は、いまは登録しません。** 生成機能は
`/api/generate` が骨組みのみで、#83 / #16 が未完了のためです（#89 scope.out）。
生成を有効にする時点で次を足します。**`BEDROCK_AWS_SESSION_TOKEN` は本番では
登録しません**（一時資格情報はローカル開発で SSO を使うときだけのもので、本番には
長命キーを置きます。Workers は AWS の外で動くため IAM ロールを引き受けられません。
仕様書 4.1）。**鍵のローテーション手順は #82 が持ちます。**

```bash
# 生成機能を有効にする時点で（#83）
npx wrangler pages secret put BEDROCK_AWS_REGION --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY --project-name game-forge
```

**そのとき `compatibility_flags = ["nodejs_compat"]` が必要になります**（#79 の実測）。
これが無いと `@anthropic-ai/bedrock-sdk` が要求する `assert` / `stream` が解決できず
ビルドが落ちます。**いまは何も import していないため不要**で、先に足しません。

### 6. デプロイ

```bash
npx wrangler pages deploy --project-name game-forge --branch main
```

`--branch main` を明示します。省くと wrangler が git のブランチ名を推測し、
**production_branch と一致しなければ preview として配備される**ためです。

## カスタムドメイン

**Cloudflare 側と Route53 側の両方に作業があります。** 片方だけでは張れません。

### Cloudflare 側

**`wrangler` にカスタムドメインのコマンドはありません**（4.121 で確認。`wrangler pages`
のサブコマンドは `dev` / `functions` / `project` / `deployment` / `deploy` / `secret` /
`download` の 7 つだけです）。API を直接叩きます。

```bash
set -a; source scripts/load-project-env.sh; set +a
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/game-forge/domains"

for H in app.game-forge.ojos.jp sandbox.game-forge.ojos.jp; do
  curl -s -X POST "$API" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"$H\"}"
done

curl -s "$API" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"   # 状態の確認
```

追加した直後の状態は `initializing`（DNS 検証待ち）です。CNAME が引けるようになると
`active` へ変わり、証明書が発行されます。**先に DNS を作っても構いません**が、
どちらか片方だけでは `active` になりません。

### Route53 側（Terraform）

**レコードは `terraform/dns.tf` が宣言します。ダッシュボードや `aws` コマンドで
手で作らないこと**（確定17 が Route53 へ委譲した目的がそもそもこれです）。

```bash
export AWS_PROFILE=game-forge-prod
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

宣言されるのは、ホストゾーン `game-forge.ojos.jp` の中の CNAME 2 本です。

| 名前 | 型 | 値 |
|---|---|---|
| `app.game-forge.ojos.jp` | CNAME | `game-forge.pages.dev` |
| `sandbox.game-forge.ojos.jp` | CNAME | `game-forge.pages.dev` |

ホスト名はゾーン名から導き（`local.app_host`）、向き先は
`var.cloudflare_pages_project` から組み立てます。完全修飾名を書き写さないのは、
ゾーン名を変えたときに片方だけが古い名前を指さないようにするためです。

### サンドボックス用ホストを同じプロジェクトに載せてよい理由

7.2 が要求するのは**別オリジンであること**で、別プロジェクトであることではありません。
`src/index.ts` が `Host` ヘッダで出し分け、サンドボックス側には CSP `sandbox` ヘッダを
付け、cookie を一切設定しません。この構造はローカルでも
`npm run check:origins` が毎回検証しています。

**`app.game-forge.ojos.jp` と `sandbox.game-forge.ojos.jp` は同一サイト**（eTLD+1 が
どちらも `ojos.jp`）である点に注意してください。だからこそセッション cookie に
`__Host-` 接頭辞が必須です（7.2 必須要件 2）。

## Google OAuth のリダイレクト URI（Console 手作業）

**本番のコールバック先を Google Cloud Console へ登録しないとログインできません。**
OAuth クライアントは API から操作できないため、ここだけは手作業です
（docs/gcp-oauth-setup.md 1 章）。

<https://console.cloud.google.com/auth/clients?project=ojos-game-forge>

既存のクライアントの「承認済みのリダイレクト URI」へ次を**追加**します
（ローカル用の既存 URI は消さないこと）。

```
https://app.game-forge.ojos.jp/auth/google/callback
```

**サンドボックス側は登録しません。** あちらは cookie も認証も持ちません（7.2）。

**テストユーザーの登録も要ります。** 同意画面は Testing のまま運用するため、
招待した相手のメールアドレスを Console のテストユーザーへ手登録しないと、
Google のログイン画面にすら到達できません（仕様書 8.1「Google OAuth を Testing の
まま運用する」）。**招待はアプリ側の招待コードと Google 側の登録で二重になります。**

## 確認

配備後に最低限これを見ます。

```bash
curl -sI https://app.game-forge.ojos.jp/ | head -1
curl -s  https://app.game-forge.ojos.jp/ | head -5
curl -s  https://app.game-forge.ojos.jp/signup | head -5
curl -sI https://app.game-forge.ojos.jp/__dev/health | head -1     # 404 であること
curl -sI https://sandbox.game-forge.ojos.jp/ | grep -i content-security-policy
```

- **`/` が公開トップであること**（開発用の索引は `/__dev/` へ移した。#89）。
- **`/__dev/*` が 404 であること。** `DEV_ROUTES` の宣言が効いているかの実測です。
- サンドボックス側に `sandbox allow-scripts` が付き、`allow-same-origin` が**付いていない**
  ことを必ず確認してください（7.2 必須要件 1）。

宣言と実状態の照合は外部層の受け入れ検証が行います。

```bash
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

`terraform plan` の差分なしに加えて、**CNAME 2 本が宣言どおりの向き先で実在すること**と、
**`wrangler.toml` の本番ホストが DNS の宣言と一致すること**を見ます。後者を機械照合に
しているのは、片方だけを変えると「DNS は張れているのに Worker が `unknown host` で
404 を返す」という、どちらを見ても正しく見える壊れ方をするためです。

## まだ決まっていないこと

- **本番の D1 / R2 を Terraform で宣言するか**、`wrangler` で作るか。現状 `terraform/` は
  GitHub と AWS と GCP を見ており、Cloudflare のリソースは `wrangler` で作っています。
- **Pages プロジェクトそのものを Terraform で宣言するか。** shared-ai-rules 4 章は
  「UI やアドホックな CLI での直接作成・変更を、恒久的な状態変更の手段にしない」と
  定めており、上の手順のうち `wrangler ... create` と `domain add` は本来その対象です。
  **R2 の初回有効化だけは、宣言化しても解決しません**（API そのものが有効化前は使えない）。
