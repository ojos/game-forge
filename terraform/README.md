# terraform

GitHub 上の恒久的な状態を宣言的に管理します（`.ai-playbook/shared-ai-rules.md` 4 章「外部サービスの状態管理」）。

UI や `gh` コマンドでの直接変更は、恒久的な状態変更の手段にしません。`gh` は状態確認と一時的な調査に留めます。

## 管理対象

| 対象 | リソース | 定義 |
|---|---|---|
| リポジトリ本体 | `github_repository.this` | `main.tf` |
| 既定ブランチ名の固定 | `github_branch_default.default` | `main.tf` |
| 既定ブランチの保護 | `github_branch_protection.default` | `main.tf` |
| Actions 変数 `ALLOWED_AUTHOR_EMAILS` | `github_actions_variable.allowed_author_emails` | `main.tf` |
| ビルドイメージの ECR リポジトリ | `aws_ecr_repository.isolated_build` ほか | `build-function.tf` |
| ビルド関数（確定24 / 3.8） | `aws_lambda_function.build`、実行ロール、ロググループ | `build-function.tf` |
| 配備に要る Actions 変数 4 つ | `github_actions_variable.aws_region` ほか | `build-function.tf` |
| ビルド関数を呼ぶプリンシパル（3.3-5 / 4.1 / 9.2） | `aws_iam_user.build_invoker`、`aws_iam_user_policy.build_invoke` | `build-invoker.tf` |
| Bedrock を呼ぶプリンシパルとモデルアクセス（確定19 / 4.1） | `aws_iam_user.bedrock_invoker`、`aws_bedrock_foundation_model_agreement.generation` | `bedrock.tf` |
| 費用ガードの層 2 / 層 3（4.3） | `aws_cloudwatch_metric_alarm.bedrock_token_burst` ほか | `bedrock-guard.tf` |
| GitHub Actions の OIDC 連携（9.3） | `aws_iam_openid_connect_provider.github`、`aws_iam_role.deploy_compiler` | `github-oidc.tf` |
| R2 のライフサイクル（3.7 / 確定13 / 確定26） | `cloudflare_r2_bucket_lifecycle.artifacts` | `r2-lifecycle.tf` |

管理対象外:

- Actions の Secrets の値（`COPILOT_REVIEW_TOKEN` 等）。値が tfstate へ平文で残るため宣言しません。必要になった時点で GitHub 側へ直接設定します。
- **ビルド関数に載っているイメージ**（`image_uri`）。配るのは CI です（9.3）。宣言側が固定の URI を持つと、配備のたびに `plan` へ差分が出ます。`lifecycle { ignore_changes = [image_uri] }` で宣言の外に置いています。
- **Workers 用 IAM ユーザーのアクセスキー**（`game-forge-bedrock-invoker` / `game-forge-build-invoker`）。`aws_iam_access_key` を宣言すると、生成された秘密鍵が **tfstate へ平文で書き込まれます**。宣言が持つのはユーザーと権限だけで、鍵の発行・投入・ローテーションは `docs/bedrock-access.md` 3〜4 章と `docs/build-invocation.md` 3 章が持ちます。**「宣言していないこと」自体は `scripts/acceptance-remote.sh` が tfstate を見て機械で押さえます。**
- **R2 の資格情報**（SSM Parameter Store の SecureString）。`aws_ssm_parameter` を宣言すると、Terraform が refresh のたびに**復号済みの値を tfstate へ書き込みます**（`aws_iam_access_key` を宣言しない理由と同じ経路）。宣言が持つのは名前と読み取り権限だけで、値の投入とローテーションは `docs/build-function.md` が持ちます。
- **R2 バケットそのもの**（`game-forge`）と D1 / Pages プロジェクト。`wrangler` で作成済みで（`docs/pages-deploy.md` の実施記録）、宣言化するかは未決です。`r2-lifecycle.tf` は**バケットのライフサイクルだけ**を宣言します（#31）。`cloudflare_r2_bucket` を宣言すると既存バケットの作成を試みて失敗します。
- **未公開成果物の 14 日削除**。3.7（確定13）が求める掃除ですが、**R2 のライフサイクルでは実現できません。** ライフサイクルは `games` を引けず、確定26 のとおりオブジェクトは作品をまたいで共有されるため、年齢だけで消すと公開済みの作品が壊れます（3.7 の削除規約 3）。判定は M5-4 のゴミ掃除が持ちます。理由の全文は `r2-lifecycle.tf` の冒頭にあります。
- リモート state backend。ローカル state（`terraform/terraform.tfstate`）を使い続けます（2026-08-11 決定）。適用者が単一で state を共有する必要が無いためで、複数人・複数環境から適用するようになった時点で再検討します。

## 認証

トークンをファイルへ書き写さず、環境変数で渡します。

```bash
export GITHUB_TOKEN="$(gh auth token)"
```

Cloudflare の API トークンも環境変数で渡します。値は追跡外の `.env` にあり、ローダーが環境へ移します。**`r2-lifecycle.tf` が入って以降、これは「適用する場合だけ」ではなく `plan` にも必須です**（下記「3 行目を忘れると何が起きるか」）。

```bash
set -a; source scripts/load-project-env.sh; set +a   # CLOUDFLARE_API_TOKEN を環境へ
```

必要な権限は `repo`（リポジトリの作成・設定・ブランチ保護・Actions 変数）です。`gh auth status` で現在の scope を確認できます。

`terraform destroy` によるリポジトリ削除は、`delete_repo` scope を持たないため実行できません。加えて `github_repository.this` には `prevent_destroy = true` を設定しています。意図した削除は、この設定を外す明示的な変更を伴わせます。

## 変数

初回のみ、雛形をコピーして値を設定します。`terraform.tfvars` は `.gitignore`（`*.tfvars`）で追跡から外れています。

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# allowed_author_emails を設定する
```

## 適用手順

**3 つの資格情報をこの 1 ブロックで揃えます。** どれか 1 つでも欠けると `plan` が落ちます。

```bash
export GITHUB_TOKEN="$(gh auth token)"
export AWS_PROFILE=game-forge-prod
set -a; source scripts/load-project-env.sh; set +a   # CLOUDFLARE_API_TOKEN

terraform -chdir=terraform init
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

### 3 行目を忘れると何が起きるか（2026-08-29 に踏んだ）

**`plan` が全体として落ち、他のリソースの差分検出まで止まります。**

```
Error: failed to make http request
  with cloudflare_r2_bucket_lifecycle.artifacts,
GET ".../r2/buckets/game-forge/lifecycle": 400 Bad Request
{"success":false,"errors":[{"code":9106,"message":"Missing X-Auth-Key, X-Auth-Email or Authorization headers"}]}
```

**これはプロバイダの不具合ではなく、資格情報が環境に無いだけです**（同じ宣言・同じ
state で、トークンを載せた状態と外した状態の両方を実行して確認しました。載せれば
refresh は通ります）。**9106 は「認証ヘッダが 1 つも無い」ときの応答**で、権限不足では
ありません。

読み違えやすいのは、**エラーがリソース名で名指しされる**ため「その宣言が壊れている」
ように見える点です。**`apply` は通ったのに後日の `plan` が落ちる**のも、資格情報を
載せたシェルと載せていないシェルが違うだけで説明が付きます。

**これは AWS の SSO が切れたときと同じ種類の失敗です。** `terraform` は refresh で
どれか 1 つのプロバイダが失敗すると plan 全体を止めます。だからこの層はループの
ゲートに含めません（`.github/project-ai-rules.md`「外部層を単一入口へ含めない理由」）。
`scripts/acceptance-remote.sh` は前提の確認を先に置き、**terraform を資格情報ごしに
呼ぶ**ので、この経路では踏みません。

## 受け入れ検証

宣言と実際の外部状態が一致していることは、外部層の受け入れ検証で確認します（`.github/project-ai-rules.md`「外部層の受け入れ検証」）。

```bash
export GITHUB_TOKEN="$(gh auth token)"
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

R2 のライフサイクルは専用の検査が持ちます（`scripts/acceptance-remote.sh` へ結線するまでは単体で回します）。

```bash
set -a; source scripts/load-project-env.sh; set +a
bash scripts/check-r2-lifecycle.sh   # R2_LIFECYCLE_PASS
```

この層は反復のたびに回しません。通す契機は、この配下の宣言を変更したときです。ローカル事前ゲート（`scripts/loop-gate.sh`）にも含めません。外部認証の失効やオフラインでゲート全体が止まると、実装が正しいのにループが止まるためです。

## 手動変更が発生した場合

やむを得ず GitHub 側を手で変更した場合は、後追いでこの宣言へ反映します。手動変更が正で宣言が古い、という状態を残しません。乖離は `terraform plan` の差分として検出できます。
