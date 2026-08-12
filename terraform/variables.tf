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

variable "dns_zone_name" {
  description = <<-EOT
    Route53 で管理する DNS ゾーン名（確定16 / 確定17）。

    さくらのドメイン（ojos.jp）からこのゾーンへ NS 委譲する。さくら側の NS 登録だけは
    API が無いため手動だが、委譲後の恒久的な状態は Route53 側＝この宣言が持つ。
  EOT
  type        = string
  default     = "game-forge.ojos.jp"
}
