# 手元の機械（dev01）へ通す Cloudflare Tunnel

- 位置づけ: **M22-2（#792）** の手順書。**手順であって、実行の記録ではない。**
  外部状態を変えたら、その時点の結果を末尾の「実施の記録」へ残すこと。
- 対象: 機械 **`dev01`**（手元の Ubuntu）と、そこに開く 2 つの口。
- 宣言の正本は `terraform/tunnel-dev01.tf` と `terraform/zero-trust.tf` である。
  **ここへ宣言を書き写さない**——この文書が持つのは「どの順で何を叩くか」と
  「機構で代替できない手作業」だけである。

---

## 何が立つのか

**`dev01` はポートを 1 つも開けない。** 機械の中から Cloudflare へ外向きに繋ぎ、
その 1 本のトンネルの上に 2 つの口を載せる。どちらの口も、Cloudflare Access を
通らなければ `dev01` まで届かない。

| 公開ホスト名 | 向き先（dev01 の中） | 通れるのは | 認可の宣言 |
|---|---|---|---|
| `llm.ojos.jp` | `http://localhost:11434`（Ollama） | **game-forge のエッジ**（サービストークン） | `cloudflare_zero_trust_access_policy.llm_service_token` |
| `ssh.dev01.ojos.jp` | `ssh://localhost:22`（sshd） | **名指しした運営**（Google Workspace） | `cloudflare_zero_trust_access_policy.dev01_ssh_operator` |

| 要素 | 値 / 置き場 |
|---|---|
| トンネル | `terraform/tunnel-dev01.tf` の `cloudflare_zero_trust_tunnel_cloudflared.dev01`（**遠隔管理**。ingress の正本は宣言） |
| DNS | 同ファイルの `cloudflare_dns_record.llm` / `.dev01_ssh`（**どちらもプロキシ有り**） |
| チームドメイン・ID プロバイダ | `terraform/zero-trust.tf`（アカウント全体。機械には属さない） |
| 外部層の検査 | `scripts/acceptance-remote.sh` の `check_dev01_tunnel` / `check_tunnel_dns_records` / `check_tunnel_access_applications` |
| 接続トークン | `terraform output -raw dev01_tunnel_token`（**機密**。リポジトリのどこにも書き写さない） |

**名前の規則**（#792 の決定）。**製品の口には機械名を入れない**（`llm.ojos.jp`）——機械を
替えても呼ぶ側を書き換えずに済ませるため。**機械の口は機械ごとの部分木に置く**
（`ssh.dev01.ojos.jp`）——2 台目は `ssh.dev02.ojos.jp`、同じ機械に口を足すときは
`<口>.dev01.ojos.jp` として同じ木へ下げる。

---

## 一度きりの手作業（宣言化できない 3 つ）

**この 3 つが済むまで apply は通らない。** 順番に意味がある。

### Ⓐ API トークンへ権限を足す

2026-09-23 の実測で、いまのトークンは `cfd_tunnel` / `access/apps` /
`access/service_tokens` を読めるが、**`access/organizations` が 403** を返す。
これはチームドメインと ID プロバイダを作る権限グループそのものである。

ダッシュボードの My Profile > API Tokens で、`.env` の `CLOUDFLARE_API_TOKEN` に
あたるトークンを編集し、アカウント権限へ次を足す。

| 権限 | 種別 | 何に要るか |
|---|---|---|
| Access: Organizations, Identity Providers, and Groups | Edit | チームドメイン、Google の ID プロバイダ |
| Access: Apps and Policies | Edit | 2 つの口のアプリとポリシー、サービストークン |
| Cloudflare Tunnel | Edit | トンネルと ingress |
| Zone > DNS | Edit | 公開ホスト名の CNAME 2 本（`ojos.jp` のゾーン。既にある） |

**読めても書けるとは限らない。** 読み取りの 200 は、この表の Edit があることを
意味しない。不足していれば apply が 403 で落ちる。

### Ⓑ チームドメインを取り込む

**チームドメインは既にある。** 2026-09-23 の実測（Ⓐ の権限を足した直後）で
`auth_domain = ojos-jp.cloudflareaccess.com`、作成 `2026-09-23T07:44:27Z`。
**チーム名は `ojos-jp`** で、`terraform.tfvars` の `cloudflare_zero_trust_team_name`
に置く。

宣言は新規作成ではなく取り込みになる。**apply の前に行うこと。**

```bash
terraform -chdir=terraform import cloudflare_zero_trust_organization.ojos "$CLOUDFLARE_ACCOUNT_ID"
```

取り込むと差分が 2 つ出る。**どちらも意図したものである**（`terraform/zero-trust.tf`）。

| 属性 | 実際 | 宣言 |
|---|---|---|
| `name` | `aged-recipe-19e0.cloudflareaccess.com`（Cloudflare の自動命名） | `ojos` |
| `session_duration` | 未設定 | `24h` |

**チーム名は変えられないものとして扱う**——変えると Access のログイン URL と、Ⓒ の
リダイレクト URI、ingress の `team_name` が一斉にずれる。

**組み込みのワンタイム PIN が 1 件ある**（`type: cloudflare`。同じ実測）。これは
設定した ID プロバイダではなく Cloudflare 内蔵のもので、宣言の対象にしない。
**SSH の口はこれを受け付けない**（`allowed_idps` を Google だけに絞っている）。

### Ⓒ Google の OAuth クライアントを作る

**運用向けの GCP プロジェクト（`ojos-ops`）に作る**（2026-09-23 の決定。#792）。
既存の 2 つ（`ojos-game-forge` / `ojos-game-forge-dev`）に置かない理由は
`terraform/gcp.tf` の `google_project.ojos_ops` の注記にある——あちらが持つのは
「アプリを使う人のログイン」、こちらは「運営が機械へ入るための認証」で、
**同意画面はプロジェクトのものが出る**ため用途と見え方がずれる。

プロジェクトそのものは宣言が作る（上の「適用」を 1 回通すと出来る）。
**同意画面とクライアントは Console での手作業**である（API で作れない。既存の 2 つと同じ事情。
[gcp-oauth-setup.md](gcp-oauth-setup.md) 5.3）。

| 項目 | 値 |
|---|---|
| プロジェクト | `ojos-ops`（`terraform output gcp_ops_project_id`） |
| 同意画面の対象 | **内部**（Internal）。`ojos.jp` のアカウントだけが通る |
| アプリケーションの種類 | ウェブ アプリケーション |
| 名前 | `zero-trust-access` |
| 承認済みのリダイレクト URI | `https://ojos-jp.cloudflareaccess.com/cdn-cgi/access/callback` |
| 承認済みの JavaScript 生成元 | 空 |

**リダイレクト URI はチーム名から決まる**ので、プロジェクトを移しても変わらない。
**後からクライアントを別のプロジェクトへ移すのは、tfvars の 2 行の差し替えで済む。**

発行された ID とシークレットを `terraform.tfvars`（追跡外）へ置く。

```hcl
cloudflare_zero_trust_team_name = "ojos-jp"
zero_trust_google_client_id     = "<ojos-ops のプロジェクト番号>-....apps.googleusercontent.com"
zero_trust_google_client_secret = "GOCSPX-..."
zero_trust_operator_emails      = ["..@ojos.jp"]
```

**`client_id` の先頭のプロジェクト番号が、正しいプロジェクトで発行した確認になる**
（`terraform output gcp_ops_project_number` と突き合わせる。6 章と同じ使い方）。

apply の後に、登録したリダイレクト URI を output と照合する。

```bash
terraform -chdir=terraform output zero_trust_google_redirect_url
```

---

## 適用

**プライマリのツリーから回す。** state と `*.tfvars` は追跡外で、プライマリにしか無い
（worktree から回すと空の state を相手にして、全リソースを作る差分が出る）。
この作業の枝は #775 の上にあるので、**プライマリを一時的にこの枝へ出し、終わったら
`main` へ戻す。**

```bash
set -a; source scripts/load-project-env.sh; set +a
export AWS_PROFILE=game-forge-prod          # 失効していたら aws sso login --sso-session ojos
gcloud auth application-default print-access-token >/dev/null   # ADC の生存確認
```

**`plan` は全体として止まる。** プロバイダのどれか 1 つが認証に失敗すると、他の差分も
出ない（`terraform/providers.tf` の注記）。Cloudflare の資格情報を載せ忘れると、
エラーは無関係なリソースを名指しする。

### 適用は 2 段階になる（鶏と卵）

**Ⓒ の OAuth クライアントは、入れ物のプロジェクトが無いと作れない。** そのプロジェクトを
作るのはこの宣言である。したがって 1 回で通らない。

**段 1: 入れ物だけ作る。**

```bash
# tfvars には Ⓒ の値がまだ無いので、形だけ通る仮置きを入れておく
#   zero_trust_google_client_id     = "000000000000-placeholder.apps.googleusercontent.com"
#   zero_trust_google_client_secret = "placeholder"
terraform -chdir=terraform apply -target=google_project.ojos_ops
```

**`-target` を使うのはここだけである。** 仮置きの値のまま全体を apply すると、
**壊れた ID プロバイダが実際に作られる**（Cloudflare は client_id の正しさを検証しない）。
`-target` は仮置きを「宣言には在るが実体を作らない」状態に留めるために使う。

**段 2: Ⓒ の値を入れて全体を apply する。**

```bash
terraform -chdir=terraform import cloudflare_zero_trust_organization.ojos "$CLOUDFLARE_ACCOUNT_ID"   # Ⓑ。まだなら
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

終わったらプライマリを `main` へ戻す。

---

## dev01 側の手順（Ubuntu）

### 1. Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama --version
curl -s http://localhost:11434/api/tags      # 機械の中からは引ける
```

**`OLLAMA_HOST` を `0.0.0.0` にしない。** 既定の `127.0.0.1:11434` のままにする。
外へ出す口はトンネルが持つのであって、Ollama に持たせない。**ここを広げると、
この構成の眼目（ポートを 1 つも開けない）が消える。**

### 2. cloudflared

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

接続トークンは、適用した端末で取り出す。

```bash
terraform -chdir=terraform output -raw dev01_tunnel_token
```

**このトークンは機密である。** 持っている者は、このトンネルのコネクタとして名乗り出られる。
**画面に出す以外の経路を作らない**（ファイルへ落として共有しない。リポジトリへ書き写さない）。

```bash
sudo cloudflared service install <TOKEN>
systemctl status cloudflared
```

**トークンはコマンドラインに現れる。** `ps` とシェルの履歴に残るので、入れ終えたら
履歴から消すこと（`history -d`。`/etc/cloudflared/` に root 所有で保存される）。

### 3. sshd

```bash
sudo apt-get install -y openssh-server
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**ルータのポート転送は設定しない。** 22 番を外へ出す必要はなく、出せばトンネルと
Access を迂回する経路ができる。**Access は「唯一の入口」であるときにだけ意味を持つ。**

---

## 手元の Mac 側の手順

`ssh` そのものは**コンテナの中からではなく Mac から**行う（ブラウザでの認証を挟むため）。

```bash
brew install cloudflared
```

`~/.ssh/config` へ足す。

```
Host ssh.dev01.ojos.jp
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  User <dev01 のユーザー名>
  IdentityFile ~/.ssh/id_ed25519
```

最初の接続でブラウザが開き、Google（`ojos.jp`）の認証を 1 回通る。以後は
`~/.cloudflared/` のトークンが効く（セッションは 24 時間。`session_duration`）。

```bash
ssh ssh.dev01.ojos.jp
```

---

## 確かめ方

### 外部層（機械が見る）

```bash
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

3 つの検査が入っている。**落ちたときに取るべき行動が違うので分けてある。**

| 検査 | 落ちたら疑うもの |
|---|---|
| `dev01 tunnel is healthy and ingress matches` | **dev01 側**。cloudflared が止まっている（宣言の乖離ではない） |
| `tunnel dns records are proxied to the tunnel` | 宣言とゾーンの乖離。apply のやり直し |
| `tunnel access applications match` | **認可の乖離。トンネルも DNS も緑のまま、口だけが開く** |

### 実 HTTP（人が 1 回見る）

```bash
# サービストークン無し → 通らないこと
curl -s -o /dev/null -w '%{http_code}\n' https://llm.ojos.jp/api/tags

# サービストークン有り → Ollama の答えが返ること
curl -s https://llm.ojos.jp/api/tags \
  -H "CF-Access-Client-Id: $(terraform -chdir=terraform output -raw llm_service_token_client_id)" \
  -H "CF-Access-Client-Secret: $(terraform -chdir=terraform output -raw llm_service_token_client_secret)"
```

**値をコマンドへ埋め込まず、実行時に読む**（#380 の前例。埋めた値は古くなる）。

---

## 運用

### 止める / 再開する

```bash
sudo systemctl stop cloudflared      # 2 つの口が同時に閉じる
sudo systemctl start cloudflared
```

**1 本にまとめた代償がここに出る。** チャットを止めずに SSH 側だけ触りたくなったら、
下の「2 本へ分ける」を行う。

### 2 本へ分ける（無停止）

1. 2 本目のトンネル（B）を宣言して apply。**この時点では誰も B を向いていない。**
2. dev01 で 2 つ目の `cloudflared` を B のトークンで常駐させる（A は動いたまま）。
3. `ssh.dev01.ojos.jp` の CNAME の向き先を B の id へ変える（宣言の 1 行）。
4. A の ingress から SSH の規則を外す。

**チャットの口は一度も触らない。** SSH の口も、公開側の答え（Cloudflare の anycast IP）が
変わらないのでクライアントの TTL 待ちが無い。確立済みの SSH セッションが 1 回切れることはある。

### トークンを作り直す

- **トンネルの接続トークン**: `cloudflare_zero_trust_tunnel_cloudflared.dev01` の
  `tunnel_secret` を宣言して変えるか、リソースを作り直す。**作り直すと id が変わり、
  DNS の向き先も変わる**（宣言が追随するので apply 1 回で済む）。
- **サービストークン**: `client_secret_version` を上げる。**新しい secret は作成時にしか
  返らない**ので、Pages のシークレットへ写すまでを 1 回の作業にする。

---

## まだ決まっていないこと

- **チャットを Ollama へつなぐこと**（M22-3）。**#752 の計測（〜2026-09-28 16:25 JST）の後**。
  この文書の範囲は「口が開いて認可が効く」ところまでで、エッジの向き先は変えていない。
- **`llm.ojos.jp` を `llm.game-forge.ojos.jp` へ寄せること**。#775 の段 C2 の後（別 issue）。
  **寄せる時点で利用者はいない**（M22-3 より前に行う）。
- **GitHub Actions のセルフホステッドランナー**。同じ機械に載る予定だが別件。
  載せるときの口は、必要なら `<口>.dev01.ojos.jp` として同じ木へ下げる。

---

## 実施の記録

| 日付 | 行ったこと | 結果 |
|---|---|---|
| | | |
