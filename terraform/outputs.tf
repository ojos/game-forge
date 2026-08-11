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
