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

output "bedrock_invoker_role_name" {
  description = <<-EOT
    Bedrock を呼ぶプリンシパルのロール名（#160）。**ガードが停止用の Deny を付ける
    対象でもある。**

    v1 はエッジの IAM ユーザー（game-forge-bedrock-invoker）だった。生成の実行体が
    AWS の中へ移り、ロールを引き受けられるようになったため、許可も停止もロール側へ
    移った（terraform/orchestrator.tf / terraform/bedrock-guard.tf）。
  EOT
  value       = aws_iam_role.orchestrator.name
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
  description = "層 2 / 層 3 が発火時に付ける明示的 Deny ポリシーの ARN。平常時はどのロールにも付いていないことが正しい（#160）。"
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

output "r2_bucket_name" {
  description = <<-EOT
    ライフサイクルを宣言している R2 バケット名。

    値は wrangler.toml の [[env.production.r2_buckets]] から読んでいる（写しを作らない）。
    外部層の検査（scripts/check-r2-lifecycle.sh）がこれを対象として実状態を引く。
  EOT
  value       = local.r2_bucket_name
}

output "r2_lifecycle_rule_ids" {
  description = <<-EOT
    宣言しているライフサイクルルールの id 一覧。

    **外部層の検査はこれと実状態を突き合わせる。** 検査スクリプト側へ id を書き写すと、
    宣言にルールを足しても検査は古い一覧を見続ける（共通規範 12 章「一覧の複製」）。
  EOT
  value       = [for rule in cloudflare_r2_bucket_lifecycle.artifacts.rules : rule.id]
}

output "r2_abort_multipart_max_age_seconds" {
  description = "未完了マルチパートアップロードを打ち切るまでの秒数。外部層の検査が実状態と突き合わせる。"
  value       = local.r2_abort_multipart_max_age_seconds
}

/**
 * オーケストレータ（3.3 の再配置。#160）の照合値。
 *
 * **外部層の検査は、しきい値も対象名もここから取る。** 検査スクリプトへ 0 や 300 を
 * 書き写すと、宣言を変えたときに検査だけが古い期待値を見続ける（共通規範 12 章
 * 「一覧の複製は機械照合で担保する」）。
 */

output "orchestrator_function_name" {
  description = "オーケストレータの関数名。wrangler.toml の ORCHESTRATOR_FUNCTION_NAME がこの写しを持つ。"
  value       = aws_lambda_function.orchestrator.function_name
}

output "orchestrator_function_arn" {
  description = "オーケストレータの ARN。エッジの IAM ユーザーが呼び出しを許されている唯一の対象である。"
  value       = aws_lambda_function.orchestrator.arn
}

output "orchestrator_role_name" {
  description = "オーケストレータの実行ロール名。Bedrock を呼ぶプリンシパルであり、費用ガードの停止対象でもある。"
  value       = aws_iam_role.orchestrator.name
}

output "orchestrator_role_actions" {
  description = <<-EOT
    実行ロールへ与えている動作。**外部層の検査が「最小限であること」を突き合わせる
    期待値である**（#160 の受け入れ条件）。

    ポリシー文書と同じ定義から作られる（terraform/orchestrator.tf の
    local.orchestrator_role_actions）。**Bedrock の分は terraform/bedrock.tf の
    local.bedrock_invoke_actions を参照しており、書き写しではない。**
  EOT
  value       = local.orchestrator_role_actions
}

output "orchestrator_log_group" {
  description = "オーケストレータのロググループ。実行ロールが書ける唯一の先である。"
  value       = aws_cloudwatch_log_group.orchestrator.name
}

output "orchestrator_memory_mb" {
  description = "オーケストレータのメモリ（MB）。外部層の検査が実状態と突き合わせる。"
  value       = local.orchestrator_memory_mb
}

output "orchestrator_timeout_seconds" {
  description = "オーケストレータのタイムアウト（秒）。src/work-page.ts の STALE_AFTER_SECONDS より短いこと。"
  value       = local.orchestrator_timeout_seconds
}

output "orchestrator_reserved_concurrency" {
  description = "オーケストレータの予約同時実行数。同時に走る生成の本数の上限である（4.3 の層 4 を持てない分をここで補う）。"
  value       = local.orchestrator_reserved_concurrency
}

output "orchestrator_maximum_retry_attempts" {
  description = <<-EOT
    非同期呼び出しの基盤リトライ回数。**0 でなければならない**（#160）。

    5.2-7 が既に最大 2 試行を持っており（#284 で 3 → 2）、掛け算にすると 1 回の
    送信から最大 6 回・約 134 円・日次枠 6 個が出る。**既定は 2 なので、書き忘れると
    掛け算になる。** ローカル層の検査（scripts/check-orchestrator-retry.sh）が
    宣言側を、外部層の検査が実状態を押さえる。
  EOT
  value       = local.orchestrator_maximum_retry_attempts
}

output "orchestrator_maximum_event_age_seconds" {
  description = "非同期イベントの有効期限（秒）。既定の 6 時間だと、忘れられた生成が課金と枠を食う。"
  value       = local.orchestrator_maximum_event_age_seconds
}

output "orchestrator_failure_queue_name" {
  description = "OnFailure destination（SQS）の名前。ここに溜まっていること自体が、完走しなかったジョブの件数である。"
  value       = aws_sqs_queue.orchestrator_failures.name
}

output "orchestrator_failure_queue_arn" {
  description = "OnFailure destination の ARN。宣言と実状態の突き合わせに使う。"
  value       = aws_sqs_queue.orchestrator_failures.arn
}

output "orchestrator_callback_base_url" {
  description = <<-EOT
    コールバックの宛先。**ペイロードではなく宣言が持つ**（呼び出しのペイロードを
    差し替えられる者がジョブトークンの送り先を変えられないようにするため。
    src/orchestrator/payload.ts）。

    値は local.app_host（terraform/dns.tf）から作るので、wrangler.toml の APP_HOST と
    ずれない。
  EOT
  value       = "https://${local.app_host}"
}

# ── OGP 撮影関数（5.4 / 11.2 / #26） ─────────────────────────────────────────

output "ogp_function_name" {
  description = <<-EOT
    OGP 撮影関数の名前。**この値の正本は terraform/ogp-function.tf の
    local.ogp_function_name である。** wrangler.toml の OGP_FUNCTION_NAME はその写しで、
    Worker が呼ぶ相手を指す（src/ogp-client.ts）。突き合わせは外部層が行う。
  EOT
  value       = aws_lambda_function.ogp.function_name
}

output "ogp_function_arn" {
  description = "OGP 撮影関数の ARN。呼び出し側の許可（ogp_invoke_resources）の対象。"
  value       = aws_lambda_function.ogp.arn
}

output "ogp_function_memory_mb" {
  description = <<-EOT
    OGP 撮影関数のメモリ（MB）。**実測ではなく見積もりである**（本番でまだ 1 枚も
    撮っていない。terraform/ogp-function.tf）。最初の撮影で CloudWatch の
    Max Memory Used を見て決め直すこと。
  EOT
  value       = aws_lambda_function.ogp.memory_size
}

output "ogp_function_timeout_seconds" {
  description = <<-EOT
    OGP 撮影関数のタイムアウト（秒）。**関数の中で諦めるまでの時間
    （ogp_capture_timeout_ms）より長くなければならない。** 短いと、失敗の
    コールバックを送る前に Lambda ごと切られ、games.ogp_state が capturing のまま残る。
  EOT
  value       = aws_lambda_function.ogp.timeout
}

output "ogp_capture_timeout_ms" {
  description = "撮影を諦めるまでの時間（ミリ秒）。関数の環境変数 CAPTURE_TIMEOUT_MS。"
  value       = local.ogp_capture_timeout_ms
}

output "ogp_function_reserved_concurrency" {
  description = <<-EOT
    予約同時実行数。**アカウントの同時実行総枠に注意すること**（#103 では未予約の
    最低値 10 を割って apply が InvalidParameterValueException で落ちた）。
  EOT
  value       = aws_lambda_function.ogp.reserved_concurrent_executions
}

output "ogp_maximum_retry_attempts" {
  description = <<-EOT
    非同期呼び出しの再試行回数。**オーケストレータ（0）と違って 1 である。**
    掛け算の相手（5.2-7 の試行。#284 以降 2）が無く、コールバックが使い捨てトークンで
    冪等なためである（terraform/ogp-function.tf）。
  EOT
  value       = aws_lambda_function_event_invoke_config.ogp.maximum_retry_attempts
}

output "ogp_maximum_event_age_seconds" {
  description = "非同期呼び出しの有効期限（秒）。既定は 6 時間で、忘れられた撮影が数時間後に走る。"
  value       = aws_lambda_function_event_invoke_config.ogp.maximum_event_age_in_seconds
}

output "ogp_function_role_name" {
  description = "OGP 撮影関数の実行ロール名。"
  value       = aws_iam_role.ogp.name
}

output "ogp_function_role_actions" {
  description = <<-EOT
    実行ロールへ与えている動作の一覧。**自分のログを書くことだけである。**
    R2 の資格情報を渡していないこと（撮れた PNG は Worker 経由で R2 へ入る。
    src/ogp.ts）を、この一覧が機械で読める形にしている。
  EOT
  value       = local.ogp_role_actions
}

output "ogp_function_log_group" {
  description = "OGP 撮影関数のロググループ。撮影の失敗はここに出る。"
  value       = aws_cloudwatch_log_group.ogp.name
}

output "ogp_image_repository_name" {
  description = "OGP 撮影関数のイメージを置く ECR リポジトリ名（docker/ogp-shot/）。"
  value       = aws_ecr_repository.ogp_shot.name
}

output "ogp_image_repository_url" {
  description = <<-EOT
    OGP 撮影関数のイメージの push 先。**最初の apply の前に 1 つ push しておくこと**
    （ECR が空のままだと関数の作成が落ちる。docs/ogp-capture.md）。
  EOT
  value       = aws_ecr_repository.ogp_shot.repository_url
}

output "ogp_invoke_actions" {
  description = "エッジからこの関数を呼ぶために足した動作。**1 つだけである。**"
  value       = local.ogp_invoke_actions
}

output "ogp_invoke_resources" {
  description = <<-EOT
    エッジからの呼び出しを許す対象。**この関数 1 つだけである。**
    許可は terraform/build-invoker.tf ではなく terraform/ogp-function.tf が持つ
    （関数を消すときに、消す対象が 1 ファイルで閉じる）。
  EOT
  value       = local.ogp_invoke_resources
}

output "ogp_capture_base_url" {
  description = <<-EOT
    撮影対象のホスト。**ペイロードではなく宣言が持つ**（呼び出しのペイロードを
    差し替えられる者に、撮る先を決めさせないため。terraform/ogp-function.tf）。
    値は local.sandbox_host（terraform/dns.tf）から作るので、wrangler.toml の
    SANDBOX_HOST とずれない。
  EOT
  value       = "https://${local.sandbox_host}"
}

output "ogp_callback_base_url" {
  description = <<-EOT
    撮れた PNG の送り先。**ペイロードではなく宣言が持つ**（orchestrator_callback_base_url
    と同じ理由）。値は local.app_host（terraform/dns.tf）から作る。
  EOT
  value       = "https://${local.app_host}"
}

output "ogp_viewport" {
  description = <<-EOT
    撮る大きさ（px）。**src/ogp.ts の OGP_IMAGE_WIDTH / OGP_IMAGE_HEIGHT が写しを持つ**
    （メタタグに書く値）。突き合わせは test/ogp.test.ts が行う。
  EOT
  value = {
    width  = local.ogp_viewport_width
    height = local.ogp_viewport_height
  }
}
