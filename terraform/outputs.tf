/**
 * 出力値。
 *
 * 外部層の受け入れ検証（scripts/acceptance-remote.sh）は、対象リポジトリの識別子を
 * ここから取得する。検査スクリプト側へ所有者名やリポジトリ名を書き写すと、宣言を
 * 変えたときに検査だけが古い対象を見続ける（共通規範 12 章「一覧の複製」）。
 */

output "repository_full_name" {
  description = "owner/repo 形式のリポジトリ識別子。"
  value       = github_repository.this.full_name
}

output "repository_html_url" {
  description = "リポジトリの Web URL。"
  value       = github_repository.this.html_url
}

output "repository_clone_url_https" {
  description = "HTTPS の clone URL。git remote add に使う。"
  value       = github_repository.this.http_clone_url
}

output "default_branch" {
  description = "保護対象の既定ブランチ名。"
  value       = github_branch_default.default.branch
}

output "repository_visibility" {
  description = "リポジトリの可視性。外部層の検査が実状態と突き合わせる。"
  value       = github_repository.this.visibility
}

output "allowed_author_emails" {
  description = "Actions 変数 ALLOWED_AUTHOR_EMAILS の宣言値。外部層の検査が実状態と突き合わせる。"
  value       = github_actions_variable.allowed_author_emails.value
}

output "required_status_checks" {
  description = "既定ブランチのマージに必須としているステータスチェック名。外部層の検査が実状態と突き合わせる。"
  value       = tolist(github_branch_protection.default.required_status_checks[0].contexts)
}

output "dns_zone_name" {
  description = "Route53 で管理する DNS ゾーン名。外部層の検査が実状態と突き合わせる。"
  value       = aws_route53_zone.game_forge.name
}

output "dns_zone_id" {
  description = "Route53 ホストゾーン ID。外部層の検査が実状態の取得に使う。"
  value       = aws_route53_zone.game_forge.zone_id
}

output "dns_zone_name_servers" {
  description = <<-EOT
    委譲元（さくらの ojos.jp ゾーン）へ登録する NS レコードの値。

    さくら側の登録は手動だが、登録すべき値をここへ書き写さずに宣言から取れるように
    しておく（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
  EOT
  value       = aws_route53_zone.game_forge.name_servers
}

output "gcp_project_id" {
  description = "GCP プロジェクト ID。OAuth クライアントの発行先。外部層の検査が実状態と突き合わせる。"
  value       = google_project.game_forge.project_id
}

output "gcp_project_number" {
  description = "GCP プロジェクト番号。コンソールの URL や API の一部が ID ではなくこちらを要求する。"
  value       = google_project.game_forge.number
}
