# Cloudflare Pages への配備手順

- 位置づけ: 確定22（アプリと API は Pages Functions）を実際に配備するための手順書。
- 対象: `app.game-forge.ojos.jp`（アプリ）と `sandbox.game-forge.ojos.jp`（UGC）。
- **この文書は手順であって、実行の記録ではない。** 実際の配備は外部状態の変更なので、
  行った時点で `terraform/` か本文書に結果を残すこと。
- **日常の配備は自動である（#95）。** `main` へマージすると GitHub Actions が本番へ
  配備します。**この文書の「配備」の章が扱う手作業は、初回の構築と緊急時の手段**であって、
  変更を本番へ届ける通常の経路ではありません。自動配備の実体と、その供給元
  （GitHub Secrets）の登録手順は「自動配備」の章にあります。

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
仕様書 4.1）。

```bash
# 生成機能を有効にする時点で（#83）
npx wrangler pages secret put BEDROCK_AWS_REGION --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY --project-name game-forge
```

**値の出どころは `docs/bedrock-access.md` です**（#82）。役割はこう分かれます。

| 何 | 正本 |
|---|---|
| **どのシークレットを、どのプロジェクトへ入れるか**（上のコマンド） | この文書 |
| **鍵の発行**（`aws iam create-access-key`）と**ローテーション手順** | `docs/bedrock-access.md` 3〜4 章 |
| IAM ユーザーと権限、費用ガード | `terraform/bedrock.tf` / `terraform/bedrock-guard.tf` |

**投入の前に `terraform apply` が済んでいる必要があります。** 鍵を発行する相手
（`game-forge-bedrock-invoker`）も、費用ガードの層 2 / 層 3 も、宣言側が作ります。
**ガードが無いまま生成を開けないこと**が要点です（仕様書 4.3 は月次上限を必須実装と
しており、アプリ層だけでは不足するとしています）。

**そのとき `compatibility_flags = ["nodejs_compat"]` が必要になります**（#79 の実測）。
これが無いと `@anthropic-ai/bedrock-sdk` が要求する `assert` / `stream` が解決できず
ビルドが落ちます。**いまは何も import していないため不要**で、先に足しません。

### 6. デプロイ（初回と緊急時のみ）

**日常の配備はこれではありません。** `main` へのマージで GitHub Actions が配備します
（次章）。手で打つのは、**まだワークフローが無い初回**と、**ワークフローが使えない
緊急時**（Cloudflare 側の障害、Secrets の失効、Actions の停止）に限ります。

```bash
set -a; source scripts/load-project-env.sh; set +a
npx wrangler pages deploy --project-name game-forge --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=format:%s)"
```

`--branch main` を明示します。省くと wrangler が git のブランチ名を推測し、
**production_branch と一致しなければ preview として配備される**ためです。

**`--commit-hash` / `--commit-message` は手で打つときも省かないこと。** 省くと
Cloudflare 側に「どのコミットが本番に居るか」が残らず、配備ずれの検知（次章）が
`本番の配備にコミットハッシュが記録されていません` で落ちます。**`main` の HEAD
以外を配備しない**こと。手元の作業ツリーが汚れていると `commit_dirty` が立ち、
やはり検知に掛かります。

## 自動配備（日常の経路。#95）

**`main` へマージすると、GitHub Actions が本番へ配備します。** 実体は
`.github/workflows/verify.yml` の `deploy` ジョブで、実行するのは次の 1 本です。

```bash
npx wrangler pages deploy --project-name game-forge --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=format:%s)"
```

- **`verify` が緑のときにしか走りません。** 同じ実行の中で `needs: verify` の後段に
  置いています。**条件式ではなく依存関係**なので、書き忘れで素通りする形になりません
  （`workflow_run` で別ワークフローにしなかった理由は当該ジョブのコメントにあります）。
- **契機は `push`（`main`）だけです。** PR では起動しません。fork からの PR は
  そもそも `push` を起こせないため、構造的に届きません。
- **Pages のシークレット（`SESSION_SECRET` 等）は触りません。** ワークフローに
  `pages secret put` はありません。値の投入は上の「5. シークレットを入れる」（人手）が
  持ち続けます。`wrangler pages deploy` は既存のシークレットを上書きしません。
- **`--commit-hash` / `--commit-message` を必ず渡します。** これが Cloudflare 側の
  配備一覧に載り、次の「配備ずれの検知」が読む値になります。

### 配備ずれの検知

**自動化しても「配備が失敗したまま気づかない」は残ります。** #95 で問題だったのは
配備し忘れそのものより、**すべてのゲートが緑のまま本番だけが古かったこと**でした。
外部層の受け入れ検証に検査を 1 件置いています。

```bash
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
#   production deployment matches main HEAD
```

**見るのは「配備されたか」ではなく「一致しているか」**です。本番がいま配っている配備
（Cloudflare の `canonical_deployment`）のコミットハッシュと、GitHub 上の `main` の
HEAD を突き合わせます。**配備一覧の先頭ではなく `canonical_deployment` を見る**のは、
先頭は「最後に作られた配備」であり、それが失敗していれば本番はもっと古いものを配り
続けているからです。

手で確かめるなら次のとおりです。

```bash
set -a; source scripts/load-project-env.sh; set +a
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/game-forge" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq -r '.result.canonical_deployment.deployment_trigger.metadata | "\(.commit_hash) dirty=\(.commit_dirty)"'
git ls-remote origin refs/heads/main
```

不一致だったときは、まず `deploy` ジョブの実行を見ます。

```bash
gh run list --workflow verify.yml --branch main --limit 5
```

### GitHub Secrets への登録

**ランナーには `.env` がありません。** ワークフローにとっての供給元は GitHub Secrets
だけです。次の 2 つを登録します（`wrangler` が直接読む名前で、`.env` と同じ値です）。

```bash
# 値を履歴やプロセス一覧へ残さないよう、.env から読んで標準入力で渡す
set -a; source scripts/load-project-env.sh; set +a
printf '%s' "$CLOUDFLARE_API_TOKEN"  | gh secret set CLOUDFLARE_API_TOKEN  --repo ojos/game-forge
printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo ojos/game-forge

gh secret list --repo ojos/game-forge    # 名前と更新日時だけが読める（値は読めない）
```

**再発行したときは 2 か所とも差し替えます。** ダッシュボードの My Profile → API Tokens
で Roll し、`.env` を更新し、上のコマンドで Secrets も更新します。**片方だけ替えると、
手元は通るのに CI だけが失効した状態**になります。そのときは `deploy` ジョブが赤くなり、
放置すれば上の配備ずれ検知が拾います（どちらも黙って緑にはなりません）。

### なぜトークンの保管先が `.env` と GitHub の 2 か所になるのか

`.github/project-ai-rules.md` は **「トークンをファイルへ書き写さず、ツール自身の
ログイン状態に持たせる」を原則**とし、gh（`GH_TOKEN`）と wrangler
（`CLOUDFLARE_API_TOKEN`）を例外としています。**GitHub Secrets への登録は 3 つ目の
例外**にあたるため、他の 2 つと同じ密度で理由を残します。

- **理由**: GitHub Actions のランナーは、この devcontainer のログイン状態も `.env` も
  持ちません。ワークフローが Cloudflare の API を呼ぶ以上、資格情報の供給元がランナー側に
  要ります。そして **Cloudflare の API トークンには、GitHub の OIDC を受けて短命の
  資格情報を発行する経路がありません**（AWS の `configure-aws-credentials` にあたるものが
  無い）。**長命のトークンを置く以外の選択肢が無い**、というのが例外の根拠です。
  これは仕様 4.1 が Bedrock の資格情報について「Workers は AWS の外で動くため IAM ロールを
  引き受けられず、長命キーを置く」としているのと同じ形の妥協です。
- **増えるのは保管先であって、トークンの本数ではありません。** 同じ 1 本を 2 か所へ
  置きます。**CI 専用に別のトークンを発行して分けない**のは、**期限が API から読めない**
  （上記「前提: 認証」）ためです。管理対象を 2 本に増やすと、切れたことに気づけない口が
  2 つになります。片方だけを失効させたい理由ができた時点で分ければ足ります。
- **権限は増やしません。** 上の 3 スコープ（Pages / D1 / R2 の Edit）のままです。配備に
  必要なのは Pages だけですが、`.env` と同じ 1 本を使うため組は変わりません。
- **fork からの PR に Secrets は渡りません**（GitHub の仕様）。`deploy` ジョブは
  `push`（`main`）契機なので、**PR の内容から値を引き出す経路がそもそもありません**。
  ワークフローはトークンを表示せず、GitHub はログ中の Secrets をマスクします。
- **失効・期限切れ時**: 上の「再発行したときは 2 か所とも差し替えます」に従います。

### Terraform で宣言するか（`github_actions_secret`）

**採りません。** `terraform/main.tf` は GitHub のリポジトリ・ブランチ保護・Actions
変数（`github_actions_variable.allowed_author_emails`）を宣言しており、Secrets も
`github_actions_secret` で宣言する形は作れます。採らない理由は 3 つです。

1. **値が tfstate へ平文で落ちます。** `github_actions_secret` は送信時に暗号化しますが、
   受け取る属性（`plaintext_value`）は state に保存されます。これは
   `terraform/bedrock.tf` が **`aws_iam_access_key` を宣言しない理由**（「生成した秘密鍵を
   tfstate へ平文で書く。tfstate は追跡外だがディスク上は平文である」）と**同じ経路**です。
   `providers.tf` が「資格情報を Terraform 変数として受け取ると tfstate や plan ファイルへ
   平文で落ちる経路ができる」として避けているのも同じ判断で、**この論法はここにそのまま
   当てはまります。**
2. **宣言できるのは名前だけで、効くかどうかは宣言できません。** 値が正しいか・失効して
   いないかは `terraform plan` では分かりません。それを担保するのは `deploy` ジョブの成否と、
   上の配備ずれ検知です。**宣言を増やしても、この 2 つの代わりにはなりません。**
3. **`ALLOWED_AUTHOR_EMAILS` を宣言しているのは、あれが機密でないからです。** 同じ理由で
   `CLOUDFLARE_ACCOUNT_ID` だけなら変数として宣言できますが、**2 つの供給元を別々の
   仕組みに分けると、片方だけを更新した状態が生まれます。** 2 つとも Secrets へ揃えます。

**この判断は「宣言側で管理しない」ことを意味しません。** 名前・用途・登録手順・再発行
経路をこの文書が持ち、実際に効いているかを外部層の検査が見ます。宣言できない範囲を文書が
持つ形は、`docs/gcp-oauth-setup.md`（OAuth クライアント）と `docs/bedrock-access.md`
（アクセスキー）と同じです。

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

**本番の配備コミットが `main` の HEAD と一致していることも同じ検証が見ます**（#95。
`production deployment matches main HEAD`）。**「すべてのゲートが緑なのに本番だけが
古い」を拾う唯一の検査**です。詳しくは上の「配備ずれの検知」を見てください。

**Bedrock の権限と費用ガードも同じ検証が見ます**（#82）。とくに
`bedrock invoker permissions are minimal` は、**費用ガードが発火したまま復旧していない
状態**でも失敗します（停止用の Deny ポリシーが付いたままになるため）。配備の赤ではなく
**生成が止められている**合図なので、`docs/bedrock-access.md` 5 章の復旧手順を見てください。

## 実施の記録（2026-08-26 / #89）

**この節だけが実行の記録である。** 上の手順を実際に通した結果を残す
（本文書の冒頭のとおり、手順と記録は別物として扱う）。

| 対象 | 値 |
|---|---|
| Pages プロジェクト | `game-forge`（`production_branch` = `main`） |
| D1 | `game-forge` / `d81a6f80-7d08-4908-b311-2418bacda050` / リージョン APAC |
| R2 バケット | `game-forge` |
| マイグレーション | `0001_init.sql` 適用済み（`users` `games` `generations` `invites` `reports` `waitlist`） |
| シークレット | `SESSION_SECRET`（本番用に新規生成）/ `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。production スコープ |
| カスタムドメイン | `app.game-forge.ojos.jp` / `sandbox.game-forge.ojos.jp` ともに `active` |
| Route53 | CNAME 2 本を `terraform apply` で作成（作成 2 / 変更 0 / 削除 0） |
| Google OAuth | `https://app.game-forge.ojos.jp/auth/google/callback` を Console へ追加済み |

**R2 の事前有効化は不要だった**（このアカウントでは #82 の作業で有効化済みだったため、
`r2 bucket create` がそのまま通った）。上の 0 章は、未有効のアカウントで再現する場合に要る。

**カスタムドメインは登録から `active` まで約 7 分かかった**（15 秒間隔で 29 回ポーリング。
Route53 の CNAME を作ってから 28 回目で `sandbox`、29 回目で `app` が `active` へ変わった）。
`pending` のまま数分続くのは正常である。

### 配備後の実測

| 受け入れ条件 | 実測 |
|---|---|
| `/` が開発用ページではない | 200 / `<h1>Game Forge</h1>`。`__dev` の文字列は 0 件 |
| `/__dev/*` が 404 | `/__dev/` `/__dev/health` `/__dev/session` `/__dev/cookies` すべて 404、`set-cookie` 0 件 |
| `/signup` が表示される | 200 |
| 招待コードなしの登録が塞がれている | 不正コードで 400、`Location` 0 件（OAuth 要求を組み立てない）、`set-cookie` 0 件 |
| 待機リストが本番 D1 へ入る | `{"registered":true}` → D1 に行を確認。**検証用の行は削除済み** |
| サンドボックスの CSP | `sandbox allow-scripts` あり / `allow-same-origin` なし / `set-cookie` 0 件 |
| `terraform plan` | 差分なし（`-detailed-exitcode` が 0） |

OAuth の開始経路も通っている。`/auth/google/start` が 303 で
`redirect_uri=https://app.game-forge.ojos.jp/auth/google/callback` を組み立て、
`__Host-gf_oauth` を発行し、Google 側は `redirect_uri_mismatch` を出さずサインイン画面へ
到達した。

## まだ決まっていないこと

- **本番の D1 / R2 を Terraform で宣言するか**、`wrangler` で作るか。現状 `terraform/` は
  GitHub と AWS と GCP を見ており、Cloudflare のリソースは `wrangler` で作っています。
- **Pages プロジェクトそのものを Terraform で宣言するか。** shared-ai-rules 4 章は
  「UI やアドホックな CLI での直接作成・変更を、恒久的な状態変更の手段にしない」と
  定めており、上の手順のうち `wrangler ... create` と `domain add` は本来その対象です。
  **R2 の初回有効化だけは、宣言化しても解決しません**（API そのものが有効化前は使えない）。
- **GitHub Secrets を Terraform で宣言するかは決着済みです**（#95。採らない。上の
  「Terraform で宣言するか」参照）。ここへ残す未決事項ではありません。
