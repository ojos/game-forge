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
  description = <<-EOT
    GCP プロジェクト ID。OAuth クライアントの発行先。

    他の output と違い、外部層の検査（scripts/acceptance-remote.sh）はこれを見ていない。
    同意画面と OAuth クライアントが API から列挙できず、プロジェクト単体を照合しても
    検証したいこと（クライアントが正しく発行されているか）に届かないためである
    （docs/gcp-oauth-setup.md 7 章）。用途は手順書とコマンドが参照する識別子。
  EOT
  value       = google_project.game_forge.project_id
}

output "gcp_project_number" {
  description = "GCP プロジェクト番号。コンソールの URL や API の一部が ID ではなくこちらを要求する。"
  value       = google_project.game_forge.number
}

output "app_host" {
  description = <<-EOT
    アプリ用ホスト名（#89）。

    wrangler.toml の [env.production.vars] APP_HOST と同じ値でなければならない。
    外部層の検査（scripts/acceptance-remote.sh）が両者を突き合わせる。
  EOT
  value       = aws_route53_record.app.name
}

output "sandbox_host" {
  description = "サンドボックス用ホスト名（#89）。SANDBOX_HOST と突き合わせる。"
  value       = aws_route53_record.sandbox.name
}

output "pages_hostname" {
  description = "カスタムドメインの CNAME の向き先（<project>.pages.dev）。外部層の検査が実状態と突き合わせる。"
  value       = local.pages_hostname
}

/**
 * 費用ガード（仕様 4.3 の層 2 / 層 3。#82）の照合値。
 *
 * 外部層の検査（scripts/acceptance-remote.sh）は、しきい値も対象名もここから取る。
 * 検査スクリプトへ 300000 や 85 を書き写すと、宣言を変えたときに検査だけが古い
 * 期待値を見続ける（共通規範 12 章「一覧の複製は機械照合で担保する」）。
 */

output "bedrock_invoker_user_name" {
  description = "Workers から Bedrock を呼ぶ IAM ユーザー名。ガードが停止用の Deny を付ける対象でもある。"
  value       = aws_iam_user.bedrock_invoker.name
}

output "bedrock_invoke_actions" {
  description = <<-EOT
    生成に許可している Bedrock の動作。**外部層の検査が「最小限であること」を
    突き合わせる期待値である**（#82 の受け入れ条件）。

    停止用の Deny ポリシーも同じ定義から作られる（terraform/bedrock.tf の
    local.bedrock_invoke_actions）。
  EOT
  value       = local.bedrock_invoke_actions
}

output "bedrock_halt_policy_arn" {
  description = "層 2 / 層 3 が発火時に付ける明示的 Deny ポリシーの ARN。平常時はどのユーザーにも付いていないことが正しい。"
  value       = aws_iam_policy.bedrock_halt.arn
}

output "bedrock_burst_alarm_name" {
  description = "層 2 の CloudWatch アラーム名。"
  value       = aws_cloudwatch_metric_alarm.bedrock_token_burst.alarm_name
}

output "bedrock_burst_threshold_tokens" {
  description = "層 2 のしきい値（トークン数 / 期間）。仕様 4.3 が正本。"
  value       = local.bedrock_burst_threshold_tokens
}

output "bedrock_burst_period_seconds" {
  description = "層 2 の評価期間（秒）。仕様 4.3 が正本。"
  value       = local.bedrock_burst_period_seconds
}

output "bedrock_burst_namespace" {
  description = "層 2 が見る CloudWatch の名前空間。"
  value       = local.bedrock_burst_namespace
}

output "bedrock_burst_metric_names" {
  description = <<-EOT
    層 2 が合算しているメトリクス名。

    **宣言したアラームそのものから導いている**（リテラルを並べていない）。検査へ
    メトリクス名を書き写すと、宣言側で 1 本足したときに検査だけが古い 2 本を
    見続ける（共通規範 12 章）。
  EOT
  value = [
    for q in aws_cloudwatch_metric_alarm.bedrock_token_burst.metric_query :
    q.metric[0].metric_name if length(q.metric) > 0
  ]
}

output "bedrock_guard_topic_arn" {
  description = "層 2 のアラームが Publish する SNS トピック。アラームの通知先が宣言どおりかを検査が突き合わせる。"
  value       = aws_sns_topic.bedrock_guard.arn
}

output "bedrock_guard_function_name" {
  description = "層 2 でポリシーを付ける Lambda 関数名。"
  value       = aws_lambda_function.bedrock_guard.function_name
}

output "bedrock_budget_prod_name" {
  description = "層 3 の本番予算名。"
  value       = aws_budgets_budget.prod_monthly.name
}

output "bedrock_budget_prod_limit_usd" {
  description = "層 3 の本番月次予算（USD）。仕様 4.3 が正本。"
  value       = aws_budgets_budget.prod_monthly.limit_amount
}

output "bedrock_budget_dev_name" {
  description = "層 3 の開発予算名。"
  value       = aws_budgets_budget.dev_monthly.name
}

output "bedrock_budget_warn_percent" {
  description = "層 3 が通知のみを出すしきい値（%）。仕様 4.3 が正本。"
  value       = local.bedrock_budget_warn_percent
}

output "bedrock_budget_halt_percent" {
  description = "層 3 が停止（Deny の付与）へ移るしきい値（%）。仕様 4.3 が正本。"
  value       = local.bedrock_budget_halt_percent
}

output "bedrock_budget_dev_limit_usd" {
  description = "層 3 の開発月次予算（USD）。仕様 4.3 が正本。"
  value       = aws_budgets_budget.dev_monthly.limit_amount
}

output "aws_account_id_prod" {
  description = <<-EOT
    実際に接続した本番アカウントの ID。

    **変数（var.aws_account_id_prod）ではなく実測値である。** 検査へ渡したいのは
    「宣言が意図したアカウント」ではなく「実際に作られた場所」だからである。
    AWS Budgets の API はアカウント ID を引数に要求する。
  EOT
  value       = data.aws_caller_identity.prod.account_id
}

output "aws_account_id_dev" {
  description = "実際に接続した開発アカウントの ID。層 3 の dev 予算を検査が引くのに使う。"
  value       = data.aws_caller_identity.dev.account_id
}

output "aws_profile_dev" {
  description = <<-EOT
    開発アカウントへ接続する SSO プロファイル名。

    外部層の検査は既定で本番のプロファイルを使うため、dev 予算を引くときだけ
    これを渡す。**資格情報ではなく選択子である**（variables.tf の同名変数を参照）。
  EOT
  value       = var.aws_profile_dev
}

/**
 * ビルド関数と ECR（確定24 / 仕様 3.8 / 7.1 / 9.3。#103）の照合値。
 *
 * 外部層の検査（scripts/acceptance-remote.sh）と .github/workflows/deploy-compiler.yml は、
 * 対象の識別子も期待値もここから取る。3538 や 10 を検査やワークフローへ書き写すと、
 * 宣言を変えたときにそちらだけが古い値を見続ける（共通規範 12 章）。
 */

output "build_function_name" {
  description = "ビルド関数の名前。CI の update-function-code と外部層の検査が対象にする。"
  value       = aws_lambda_function.build.function_name
}

output "build_function_arn" {
  description = "ビルド関数の ARN。Workers 側（#19）が呼ぶ先でもある。"
  value       = aws_lambda_function.build.arn
}

output "build_function_memory_mb" {
  description = "宣言したメモリ（MB）。2 vCPU 相当を買うための値で、仕様 3.8 が正本。"
  value       = aws_lambda_function.build.memory_size
}

output "build_function_timeout_seconds" {
  description = "宣言したタイムアウト（秒）。仕様 3.8 が正本。"
  value       = aws_lambda_function.build.timeout
}

output "build_function_ephemeral_storage_mb" {
  description = "宣言したエフェメラルストレージ（MB）。本番で書き込める唯一の領域の大きさ（7.1）。"
  value       = aws_lambda_function.build.ephemeral_storage[0].size
}

output "build_function_reserved_concurrency" {
  description = "宣言した予約同時実行数。仕様 3.8 の「Worker Pool による並列数制限」の対応物。"
  value       = aws_lambda_function.build.reserved_concurrent_executions
}

output "build_function_architecture" {
  description = "宣言した命令セット。イメージ側と食い違うと関数は起動しない。"
  value       = aws_lambda_function.build.architectures[0]
}

output "build_function_package_type" {
  description = "パッケージ形式。確定24 はコンテナイメージと定めている。"
  value       = aws_lambda_function.build.package_type
}

output "build_brotli_quality" {
  description = <<-EOT
    関数へ渡している brotli の品質（3.3-6 / 3.4-1）。

    **q11 では 3.8 の 10 秒に収まらないことを #103 で実測した**（合計 16.96 秒）。
    実測表は terraform/build-function.tf の local.build_brotli_quality にある。
  EOT
  value       = aws_lambda_function.build.environment[0].variables["BROTLI_QUALITY"]
}

output "build_function_role_name" {
  description = "ビルド関数の実行ロール名。外部層の検査が付いているポリシーを引く。"
  value       = aws_iam_role.build.name
}

output "build_function_role_actions" {
  description = <<-EOT
    実行ロールへ与えている動作。**外部層の検査が「最小限であること」を突き合わせる
    期待値である**（#103 の受け入れ条件）。

    ポリシー文書と同じ定義から作られる（terraform/build-function.tf の
    local.build_role_actions）。
  EOT
  value       = local.build_role_actions
}

output "build_function_log_group" {
  description = "ビルド関数のロググループ名。実行ロールが書ける先はこの 1 本だけである。"
  value       = aws_cloudwatch_log_group.build.name
}

output "build_image_repository_name" {
  description = "ビルドイメージを置く ECR リポジトリ名。ワークフローがここから取る。"
  value       = aws_ecr_repository.isolated_build.name
}

output "build_image_repository_url" {
  description = "ECR リポジトリの URL（<account>.dkr.ecr.<region>.amazonaws.com/<name>）。docker push の宛先。"
  value       = aws_ecr_repository.isolated_build.repository_url
}

output "r2_credentials_parameter_name" {
  description = <<-EOT
    R2 の資格情報を置く SSM Parameter Store のパラメータ名（#103 / 3.3-6）。

    **値はこの宣言が持たない。** `aws_ssm_parameter` を宣言すると、Terraform が
    refresh のたびに復号済みの値を tfstate へ書き込む（`aws_iam_access_key` を
    宣言しない理由と同じ経路である。terraform/bedrock.tf）。宣言が持つのは
    「どこを見に行くか」と「誰が読めるか」だけで、値の投入と更新は
    docs/build-function.md が持つ。

    外部層の検査は、この名前の SecureString が実在することだけを確かめる
    （**値は読まない**）。
  EOT
  value       = local.r2_credentials_parameter_name
}

output "deploy_compiler_role_arn" {
  description = <<-EOT
    GitHub Actions が OIDC で引き受けるロールの ARN（9.3）。

    .github/workflows/deploy-compiler.yml がここから取る。**ワークフローへ ARN を
    書き写さない**（アカウント ID を公開リポジトリへ置かないためでもある）。
  EOT
  value       = aws_iam_role.deploy_compiler.arn
}

output "github_deploy_subject" {
  description = <<-EOT
    配備を許す GitHub OIDC トークンの `sub`。所有者 ID とリポジトリ ID が入る綴りである
    （terraform/github-oidc.tf に経緯）。`scripts/acceptance-remote.sh` が、GitHub 側の
    `sub_claim_prefix` と照合するために読む。**検査へ綴りを書き写さないための出力である。**
  EOT
  value       = local.github_deploy_subject
}

/**
 * ビルド関数を呼ぶプリンシパル（仕様 3.3-5 / 4.1 / 9.2。#115）の照合値。
 *
 * 外部層の検査（scripts/acceptance-remote.sh）は、対象の識別子も期待値もここから取る。
 * ユーザー名や動作名を検査へ書き写すと、宣言を緩めたときに検査だけが古い期待値で
 * 緑になる（共通規範 12 章）。
 *
 * **アクセスキーの値はここにも無い。** `aws_iam_access_key` を宣言しないため、
 * そもそも Terraform が知らない（terraform/build-invoker.tf）。
 */

output "build_invoker_user_name" {
  description = "Workers からビルド関数を呼ぶ IAM ユーザー名。鍵の発行対象でもある（docs/build-invocation.md 3 章）。"
  value       = aws_iam_user.build_invoker.name
}

output "build_invoke_actions" {
  description = <<-EOT
    ビルド関数の呼び出しへ与えている動作。**外部層の検査が「最小限であること」を
    突き合わせる期待値である**（#115 の受け入れ条件）。

    ポリシー文書と同じ定義から作られる（terraform/build-invoker.tf の
    local.build_invoke_actions）。
  EOT
  value       = local.build_invoke_actions
}

output "build_invoke_resources" {
  description = <<-EOT
    呼び出しを許している対象の ARN。**`*` でないことをここで見える形にしてある**
    （仕様 9.2。このアカウントには他の関数も置きうる）。

    ポリシー文書と同じ定義から作られる（terraform/build-invoker.tf の
    local.build_invoke_resources）。
  EOT
  value       = local.build_invoke_resources
}
