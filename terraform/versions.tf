/**
 * Terraform 本体とプロバイダのバージョン制約。
 *
 * バージョンを固定するのは、同じ宣言を誰の環境から適用しても同じ結果になる状態
 * （共通規範「外部サービスの状態管理」の冪等・再現可能）を保つため。
 * .terraform.lock.hcl は追跡対象に含める（.gitignore で意図的に除外していない）。
 */
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }

  # backend は宣言しない。既定の local backend（terraform/terraform.tfstate）を使う。
  #
  # tfstate は機密を平文で保持するため .gitignore の Terraform 節で追跡から外している。
  #
  # リモート backend へは移行しない方針（2026-08-11 決定）。適用者が単一で、state を
  # 共有する必要が無いため。複数人・複数環境から適用するようになった時点で再検討する。
}
