/**
 * 入力変数。
 *
 * 機密は含めない。GitHub のトークンは環境変数 GITHUB_TOKEN で渡す（providers.tf 参照）。
 * 値の指定は terraform.tfvars（.gitignore で追跡除外）または TF_VAR_ 環境変数で行う。
 */

variable "github_owner" {
  description = "リポジトリの所有者（ユーザー名または Organization 名）。"
  type        = string
  default     = "ojos"

  validation {
    condition     = length(var.github_owner) > 0
    error_message = "github_owner を空にはできません。"
  }
}

variable "repository_name" {
  description = "作成するリポジトリ名。"
  type        = string
  default     = "game-forge"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.repository_name))
    error_message = "repository_name には英数字と . _ - のみを使用できます。"
  }
}

variable "repository_description" {
  description = "リポジトリの説明文。"
  type        = string
  default     = "AI エージェント運用ルールとレビュー機構を備えた開発リポジトリ"
}

variable "default_branch" {
  description = "既定ブランチ名。ブランチ保護の対象パターンにも使う。"
  type        = string
  default     = "main"
}

variable "required_status_checks" {
  description = <<-EOT
    既定ブランチのマージに必須とするステータスチェック名（ワークフローのジョブ名）。

    review-gate は意図的に含めない。.github/workflows/review-gate.yml が
    「required check にはしない」と定めているため（レビュー機構側の遅延や障害で
    マージが止まる副作用を避ける）。
  EOT
  type        = list(string)
  default     = ["verify", "verify-commit-identity"]
}

variable "allowed_author_emails" {
  description = <<-EOT
    Actions 変数 ALLOWED_AUTHOR_EMAILS の値。カンマ区切りで複数指定できる。

    .github/workflows/identity-guard.yml と verify.yml が参照し、コミット author の
    email を照合する。固有の email をワークフローへ焼き込まないための変数。
    機密ではないが、リポジトリ固有の値なので既定値は置かない。
  EOT
  type        = string

  validation {
    condition     = length(trimspace(var.allowed_author_emails)) > 0
    error_message = "allowed_author_emails を空にはできません。ワークフローの照合が全件不一致になります。"
  }
}

variable "aws_region" {
  description = <<-EOT
    AWS プロバイダのリージョン。

    Route53 はグローバルサービスだがプロバイダはリージョンを要求する。SSO の
    設定（~/.aws/config）と揃えておくと、CLI から手で確認するときに食い違わない。
  EOT
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_account_id_prod" {
  description = <<-EOT
    本番 AWS アカウント（game-forge-prod）のアカウント ID。

    provider "aws" の allowed_account_ids に渡し、別アカウントのプロファイルで
    この宣言を適用しようとしたときに apply を失敗させる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、宣言へ
    直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。既定値は置かない。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id_prod))
    error_message = "aws_account_id_prod は 12 桁の数字である必要があります。"
  }
}

variable "aws_account_id_dev" {
  description = <<-EOT
    開発 AWS アカウント（game-forge-dev）のアカウント ID。

    provider "aws.dev" の allowed_account_ids に渡す。用途は Bedrock の
    開発用の枠だけである（#82 / #81）。

    aws_account_id_prod と同じ理由で宣言へ直接書かず terraform.tfvars から受ける。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id_dev))
    error_message = "aws_account_id_dev は 12 桁の数字である必要があります。"
  }
}

variable "aws_profile_dev" {
  description = <<-EOT
    開発 AWS アカウントへ接続する SSO プロファイル名。

    **これは資格情報ではなく選択子である。** 実体は ~/.aws/config と SSO の
    キャッシュにあり、この宣言には秘密が入らない。providers.tf が避けているのは
    「資格情報を変数で受けて tfstate や plan へ平文で落とすこと」であって、
    どのプロファイルを使うかの表明ではない。

    prod 側は従来どおり環境変数 AWS_PROFILE で選ぶ。ここだけ明示するのは、
    1 回の apply で 2 つのアカウントを触るため、環境変数では両方を選べないからである。
  EOT
  type        = string
  default     = "game-forge-dev"
}

variable "dns_zone_name" {
  description = <<-EOT
    Route53 で管理する DNS ゾーン名（確定16 / 確定17）。

    さくらのドメイン（ojos.jp）からこのゾーンへ NS 委譲する。さくら側の NS 登録だけは
    API が無いため手動だが、委譲後の恒久的な状態は Route53 側＝この宣言が持つ。
  EOT
  type        = string
  default     = "game-forge.ojos.jp"
}

variable "gcp_org_id" {
  description = <<-EOT
    GCP 組織（ojos.jp）の ID。数字のみ。

    google_project の org_id に渡し、作成するプロジェクトを組織配下へ置く。組織を
    指定しないプロジェクトは所有者個人に紐づき、退職・アカウント削除で失われる。

    機密ではないが、このリポジトリは公開であり公開する必要も無いため、aws_account_id_prod
    と同じ扱いで宣言へ直接書かず terraform.tfvars（*.tfvars は追跡外）から受ける。

    確認方法: gcloud organizations list
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.gcp_org_id))
    error_message = "gcp_org_id は数字のみである必要があります（組織名ではなく ID）。"
  }
}

variable "gcp_project_id" {
  description = <<-EOT
    GCP プロジェクト ID。全世界で一意、かつ作成後は変更できない。

    変更して apply すると、既存プロジェクトの改名ではなく別プロジェクトの新規作成に
    なる。配下の OAuth クライアントは移動しないため、実機のログインが壊れる。
  EOT
  type        = string
  default     = "ojos-game-forge"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.gcp_project_id))
    error_message = "gcp_project_id は小文字英字で始まり、小文字英数字とハイフンのみ、6〜30 文字である必要があります。"
  }
}

variable "gcp_project_name" {
  description = "GCP プロジェクトの表示名。ID と違い後から変更できる。"
  type        = string
  default     = "game-forge"
}

variable "cloudflare_pages_project" {
  description = <<-EOT
    Cloudflare Pages のプロジェクト名（#89）。

    Pages プロジェクトそのものは Terraform の管理対象ではない（wrangler で作る。
    docs/pages-deploy.md）。ここで受けるのは、カスタムドメインが要求する CNAME の
    向き先 "<project>.pages.dev" を組み立てるための識別子だけである。

    機密ではない。値を変えるとアプリの向き先が変わるため、既定値を置いて宣言の中で
    完結させる（tfvars を書き忘れた環境が、黙って別の向き先を作らないようにする）。
  EOT
  type        = string
  default     = "game-forge"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.cloudflare_pages_project))
    error_message = "cloudflare_pages_project には英小文字・数字・ハイフンのみを使用できます。"
  }
}

variable "budget_notification_email" {
  description = <<-EOT
    費用ガードの層 3（AWS Budgets）が通知を送る宛先（#82 / 仕様 4.3）。

    **AWS Budgets Actions は subscriber を必須項目としている**ため、省略できない。
    80% の警告も 100% の停止（Deny の付与）も、この 1 か所へ届く。

    **機密ではないが宣言へ直接書かない。** aws_account_id_prod と同じ理由で、
    このリポジトリは公開であり、個人のメールアドレスを公開する必要が無いため。
    値は terraform.tfvars（*.tfvars は追跡外）に置く。既定値は置かない。

    **SNS を挟まない理由。** SNS のメール購読は購読者本人の確認クリックを要し、
    宣言しても確認が済むまで届かない。「宣言は緑なのに通知だけ来ない」状態を作らない
    ため、Budgets が直接メールを送る経路にしてある。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.budget_notification_email))
    error_message = "budget_notification_email はメールアドレスの形式である必要があります。"
  }
}
