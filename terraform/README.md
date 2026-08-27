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
| GitHub Actions の OIDC 連携（9.3） | `aws_iam_openid_connect_provider.github`、`aws_iam_role.deploy_compiler` | `github-oidc.tf` |

管理対象外:

- Actions の Secrets の値（`COPILOT_REVIEW_TOKEN` 等）。値が tfstate へ平文で残るため宣言しません。必要になった時点で GitHub 側へ直接設定します。
- **ビルド関数に載っているイメージ**（`image_uri`）。配るのは CI です（9.3）。宣言側が固定の URI を持つと、配備のたびに `plan` へ差分が出ます。`lifecycle { ignore_changes = [image_uri] }` で宣言の外に置いています。
- **R2 の資格情報**（SSM Parameter Store の SecureString）。`aws_ssm_parameter` を宣言すると、Terraform が refresh のたびに**復号済みの値を tfstate へ書き込みます**（`aws_iam_access_key` を宣言しない理由と同じ経路）。宣言が持つのは名前と読み取り権限だけで、値の投入とローテーションは `docs/build-function.md` が持ちます。
- リモート state backend。ローカル state（`terraform/terraform.tfstate`）を使い続けます（2026-08-11 決定）。適用者が単一で state を共有する必要が無いためで、複数人・複数環境から適用するようになった時点で再検討します。

## 認証

トークンをファイルへ書き写さず、環境変数で渡します。

```bash
export GITHUB_TOKEN="$(gh auth token)"
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

```bash
export GITHUB_TOKEN="$(gh auth token)"

terraform -chdir=terraform init
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

## 受け入れ検証

宣言と実際の外部状態が一致していることは、外部層の受け入れ検証で確認します（`.github/project-ai-rules.md`「外部層の受け入れ検証」）。

```bash
export GITHUB_TOKEN="$(gh auth token)"
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

この層は反復のたびに回しません。通す契機は、この配下の宣言を変更したときです。ローカル事前ゲート（`scripts/loop-gate.sh`）にも含めません。外部認証の失効やオフラインでゲート全体が止まると、実装が正しいのにループが止まるためです。

## 手動変更が発生した場合

やむを得ず GitHub 側を手で変更した場合は、後追いでこの宣言へ反映します。手動変更が正で宣言が古い、という状態を残しません。乖離は `terraform plan` の差分として検出できます。
