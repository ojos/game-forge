/**
 * GitHub 上の恒久的な状態の宣言。
 *
 * 対象は 3 つ。
 *   1. リポジトリ本体            github_repository.this
 *   2. 既定ブランチの保護        github_branch_protection.default
 *   3. Actions のリポジトリ変数  github_actions_variable.allowed_author_emails
 *
 * UI や gh コマンドでの直接変更は行わない（共通規範「外部サービスの状態管理」）。
 * やむを得ず手動変更した場合は、この宣言へ後追いで反映する。
 */

/**
 * リポジトリ本体。
 *
 * auto_init = true で初期コミットを作る。空リポジトリのままだと既定ブランチが存在せず、
 * ブランチ保護や Actions の初期状態を実体として確認できないため。
 */
resource "github_repository" "this" {
  name        = var.repository_name
  description = var.repository_description
  visibility  = "public"

  auto_init = true

  has_issues   = true
  has_projects = false
  has_wiki     = false

  # squash マージのみを許可する。履歴を 1 PR 1 コミットへ揃え、
  # 共通規範のコミットメッセージ規約（Why / How を本文へ書く）を成立させやすくする。
  allow_merge_commit = false
  allow_squash_merge = true
  allow_rebase_merge = false

  # マージ済みブランチを残さない。手元と remote の差を追う手間を減らす。
  delete_branch_on_merge = true

  # vulnerability_alerts / has_downloads は宣言しない。プロバイダ側で deprecated であり、
  # public リポジトリでは Dependabot alerts が既定で有効なため、宣言しても実状態を
  # 変えないまま非推奨属性を抱えることになる。

  lifecycle {
    # リポジトリの破棄は宣言の変更ミスで起きても取り返しがつかない。
    # 意図した削除は、この行を外す明示的な変更を伴わせる。
    prevent_destroy = true
  }
}

/**
 * 既定ブランチ名の固定。
 *
 * auto_init が作る初期ブランチ名は、アカウント側の「新規リポジトリの既定ブランチ名」
 * 設定に従うため、宣言だけでは決まらない。rename = true にすると、既に希望の名前なら
 * 何もせず、違う名前なら改名する。どちらの初期状態からでも同じ結果へ収束させるための
 * 指定であって、改名を目的にしたものではない。
 */
resource "github_branch_default" "default" {
  repository = github_repository.this.name
  branch     = var.default_branch
  rename     = true
}

/**
 * 既定ブランチの保護。
 *
 * enforce_admins は有効にしない。1 人開発では所有者が唯一の管理者であり、
 * 保護を管理者へも適用すると、CI の不調時に自分自身で復旧できなくなる。
 */
resource "github_branch_protection" "default" {
  repository_id = github_repository.this.node_id
  pattern       = var.default_branch

  # 保護対象のブランチ名が確定してから保護を掛ける。逆順だと、改名前の名前に対して
  # 保護規則だけが先に存在する時間ができる。
  depends_on = [github_branch_default.default]

  enforce_admins = false

  # 履歴の書き換えとブランチ削除は禁止する。ここは緩めない。
  allows_force_pushes = false
  allows_deletions    = false

  required_status_checks {
    # strict（マージ前に最新化を強制）は有効にしない。
    #
    # 並列 PR が互いの変更を見ないまま緑になる問題は、verify.yml が push(main) でも
    # 走ることで統合後に検出する設計になっている（verify.yml の on: push 注記）。
    # 同じ問題へ二重に対策すると、マージのたびに再実行を強いるだけになる。
    strict   = false
    contexts = var.required_status_checks
  }

  required_pull_request_reviews {
    # 承認は必須にしない（0 件）。このブロックが存在すること自体が
    # 「直接 push を禁止し PR を経由させる」効果を持つ。
    # 1 人開発では自分の PR を自分で承認できないため、1 件以上にすると恒久的に
    # マージ不能になる。
    required_approving_review_count = 0

    # 新しい push で既存の承認を無効化する。承認 0 件運用では実質無害だが、
    # 将来 1 件以上へ引き上げたときに既定で安全側になる。
    dismiss_stale_reviews = true
  }
}

/**
 * Actions のリポジトリ変数 ALLOWED_AUTHOR_EMAILS。
 *
 * identity-guard.yml と verify.yml が参照する。Secrets ではなく変数を使うのは、
 * 値が機密ではなく、かつ照合結果をログで読めるようにするため。
 */
resource "github_actions_variable" "allowed_author_emails" {
  repository    = github_repository.this.name
  variable_name = "ALLOWED_AUTHOR_EMAILS"
  value         = var.allowed_author_emails
}
