/**
 * 費用ガードの層 2（暴走検知）と層 3（会計層）の宣言（仕様 4.3 / #82）。
 *
 * 4.3 は月次上限を**四層**で担保すると定めている。本ファイルが持つのは外側の 2 層である。
 *
 * | 層 | 実体 | 捕まえるもの | 持ち主 |
 * |---|---|---|---|
 * | 1. アプリ層 | D1 の費用台帳＋月次 1 万円判定 | 主。80% 警告・残枠 UI・degrade | アプリ（#84） |
 * | 2. **暴走検知** | CloudWatch アラーム → SNS → Lambda | **ループバグによる暴走**（5〜10 分） | **このファイル** |
 * | 3. **会計層** | AWS Budgets Actions（月次予算） | **台帳が静かにずれた緩やかな超過**（数時間） | **このファイル** |
 * | 4. 補助 | Bedrock のレートクォータ引き下げ | ピーク燃焼率の抑制 | **持てない**（下記） |
 *
 * **2 と 3 は役割が違い、1 つの機構では両方を捕まえられない。** 2 は速いが総額を知らず、
 * 3 は総額を知っているが遅い。どちらかを省くと、片方の壊れ方が素通りする。
 *
 * ## 層 4 を宣言しない理由
 *
 * Service Quotas は**増加要求の API しか持たない**。引き下げは宣言できず、そもそも
 * 要求できるかも未確認である（4.3 の注記）。**層 4 が無くても設計が成立する**ように、
 * 層 2 のしきい値は現行クォータのままで上振れが収まる値になっている（下記）。
 * DeepSeek のクォータは 1 つも調整できない（実測。4.3 の表）。
 *
 * ## 停止の実体は「明示的 Deny の付与」である
 *
 * 停止は Deny ポリシーの**アタッチ**で行う（4.3 / v1.7）。**v1.6 までの 4.3 は
 * 「ポリシーを剥がす」と書いていたが、剥奪では成立しないことがこの実装で分かり、
 * 仕様側を改めた。** 求められているのは呼び出しが止まることであり、特定の API を
 * 呼ぶことではない。剥奪を採らなかった理由は 2 つある。
 *
 *   1. **剥がすと宣言と喧嘩する。** 許可は aws_iam_user_policy.bedrock_invoke として
 *      Terraform が持っている。ガードがそれを消すと plan に差分が出て、**誰かが
 *      無関係な変更（DNS など）を apply した拍子に、原因を調べる前に許可が戻る。**
 *      4.3 の「復旧は手動とする」に反する。アタッチは宣言集合の外側にあるので、
 *      apply では剥がれない。
 *   2. **層 3 は Deny の付与しかできない。** AWS Budgets の APPLY_IAM_POLICY は
 *      指定ポリシーを**付ける**動作しか持たない。層 2 を「剥がす」にすると発火した
 *      層ごとに復旧手順が変わる。揃えれば復旧は常に「Deny を detach する」1 つで済む。
 *
 * 明示的 Deny は同一アカウント内の Allow を必ず上書きするため、効果は剥奪と同じである。
 *
 * ## 復旧は宣言に持たせない
 *
 * **自動で戻す経路をどこにも作らない。** Lambda に detach の実装は無く、実行ロールにも
 * iam:DetachUserPolicy を与えていない。復旧手順は docs/bedrock-access.md が持つ。
 * 4.3 が「暴走の原因を調べる前に自動で戻すと、同じ暴走を繰り返す」としているため。
 *
 * ## Control Tower 配下であることの留意
 *
 * このアカウントは Control Tower の member であり、SCP が IAM / Budgets / Lambda の
 * 一部操作を拒否しうる。**apply が AccessDenied で落ちたときは、権限不足ではなく
 * SCP を先に疑うこと**（docs/bedrock-access.md）。
 */

locals {
  /**
   * 層 2 のしきい値と期間（4.3「層 2 の設定」がそのまま正本）。
   *
   * 5 分間で 30 万トークン。Claude なら約 57 生成、DeepSeek なら約 98 生成にあたる。
   * 招待制で数十人という規模では**正常な利用で到達しない**一方、発火時点の損害は
   * 600 円程度に収まる。数字をここに 1 か所だけ置き、アラームと output の両方が
   * これを参照する（検査へ書き写さないため）。
   */
  bedrock_burst_threshold_tokens = 300000
  bedrock_burst_period_seconds   = 300

  # メトリクスの名前空間。アラームの 2 つの metric ブロックと output が同じ値を見る。
  # 外部層の検査は、実物のアラームがこの名前空間を見ているかを突き合わせる。
  bedrock_burst_namespace = "AWS/Bedrock"

  /**
   * 層 3 の月次予算（4.3「層 3 の設定」）。
   *
   * prod 85 USD / dev 10 USD。85 USD は**アプリ層の 1 万円より先に発火してはいけない**
   * という制約から来ている。130 円/ドルでも約 11,050 円で 1 万円を上回る（円高側に
   * 振れても余裕が残る向きに取ってある）。
   *
   * dev が別枠なのは、開発の実験を本番の枠に混ぜると 4.3 の判定基準が壊れるためである
   * （仕様 9.2 / 確定21）。dev は人が SSO の一時資格情報で手で叩く場所なので、
   * 予算は事故の上限としてのみ置く。
   */
  bedrock_budget_prod_usd = "85"
  bedrock_budget_dev_usd  = "10"

  # 80% で通知のみ、100% で停止（Deny の付与。4.3）。しきい値をリソースへ直接書くと、prod と dev で
  # 片方だけずれても宣言からは気づけない。外部層の検査もここを output 経由で読む。
  bedrock_budget_warn_percent = 80
  bedrock_budget_halt_percent = 100

  /**
   * 予算の開始月。
   *
   * **省略できない。** 省くと provider が「apply した月の 1 日」を既定にするため、
   * 宣言の意味が適用時刻に依存し、いつ適用したかで結果が変わる（冪等でなくなる）。
   * 月次予算なので、開始月そのものは過去の任意の月でよい。
   */
  bedrock_budget_period_start = "2026-08-01_00:00"

  # 関数名はロググループ名にも入る（/aws/lambda/<name> が固定の綴り）。2 か所へ
  # 書くと片方だけ変えたときにログが別の場所へ出るので、1 か所から導く。
  bedrock_guard_function_name = "game-forge-bedrock-guard"
}

# 予算 API はアカウント ID を要求し、外部層の検査も対象アカウントを output から取る。
# 変数（var.aws_account_id_prod）ではなく実際に接続したアカウントを引くのは、
# 「宣言が意図したアカウント」ではなく「実際に作られた場所」を検査へ渡すためである。
data "aws_caller_identity" "prod" {}

data "aws_caller_identity" "dev" {
  provider = aws.dev
}

/**
 * 停止用の明示的 Deny ポリシー。**層 2 と層 3 が共有する唯一の停止手段である。**
 *
 * 否定する動作は local.bedrock_invoke_actions、すなわち**許可ポリシーと同じ定義**を
 * 使う（bedrock.tf）。ここへ動作名を書き写すと、許可へ 1 つ足したときに Deny 側が
 * 古いままになり、**ガードが発火しても足した動作だけが素通りする。**
 *
 * アタッチ先は宣言しない。付けるのは発火したガードであり、外して回るのは人間である。
 * 平常時のこのポリシーは「どのユーザーにも付いていない状態」が正しい。
 */
data "aws_iam_policy_document" "bedrock_halt" {
  statement {
    sid       = "DenyGenerationInvocations"
    effect    = "Deny"
    actions   = local.bedrock_invoke_actions
    resources = ["*"]
  }
}

resource "aws_iam_policy" "bedrock_halt" {
  name = "game-forge-bedrock-halt"
  path = "/service/"
  # IAM の description は ASCII で書く。タグ値ほど厳しくはないが、bedrock.tf の
  # Purpose タグと同じ理由（AWS 側の文字集合の制約に振り回されない）で揃える。
  # なぜこの形なのかは上のコメントに置く。
  description = "Explicit deny attached by the cost guard - spec 4.3 layers 2 and 3 / issue 82"
  policy      = data.aws_iam_policy_document.bedrock_halt.json

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Halt Bedrock invocation when a cost guard fires - spec 4.3"
  }
}

# ── 層 2: 暴走検知（CloudWatch → SNS → Lambda） ─────────────────────────────

/**
 * Lambda のログ出力先。
 *
 * 宣言しておくのは 2 つの理由による。**保持期間を決めるため**（Lambda が自動で作る
 * ロググループは無期限保持で、費用ガードのログが費用を生む）。そして**実行ロールへ
 * logs:CreateLogGroup を与えずに済むため**である。作成権限を渡さなければ、
 * 関数が書ける先はこの 1 本に限られる。
 *
 * 30 日にしたのは、発火の事後調査が数日〜数週間のうちに終わる想定による。
 */
resource "aws_cloudwatch_log_group" "bedrock_guard" {
  name              = "/aws/lambda/${local.bedrock_guard_function_name}"
  retention_in_days = 30

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
  }
}

data "aws_iam_policy_document" "bedrock_guard_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

/**
 * Lambda の実行ロール。**iam:AttachUserPolicy だけを、対象を絞って与える。**
 *
 * bedrock.tf のプリンシパルと同じ考え方である。IAM の広い権限を渡すと、ガードの
 * 実行ロールが乗っ取られたときに費用ガードそのものを外せてしまう。
 *
 * 条件で締めているのは 2 つ。
 *
 *   - **付けられる相手**は resources で game-forge-bedrock-invoker の 1 人だけ。
 *   - **付けられるポリシー**は iam:PolicyARN 条件で Deny ポリシー 1 本だけ。
 *     これが無いと AdministratorAccess を付ける権限になる（AttachUserPolicy は
 *     「どのポリシーを付けるか」を resources では絞れないため、条件キーで絞る）。
 *
 * **detach は与えない。** 復旧を自動化しないという 4.3 の決定を、運用の約束ではなく
 * 権限で担保する（shared-ai-rules.md 12 章「機構が結果そのものを生む」）。
 */
data "aws_iam_policy_document" "bedrock_guard" {
  statement {
    sid       = "AttachHaltPolicyToInvoker"
    effect    = "Allow"
    actions   = ["iam:AttachUserPolicy"]
    resources = [aws_iam_user.bedrock_invoker.arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.bedrock_halt.arn]
    }
  }

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # CreateLogGroup は与えない（ロググループは上で宣言済み）。書ける先を 1 本に固定する。
    resources = ["${aws_cloudwatch_log_group.bedrock_guard.arn}:*"]
  }
}

resource "aws_iam_role" "bedrock_guard" {
  name               = "game-forge-bedrock-guard"
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.bedrock_guard_assume.json

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Execution role for the spec 4.3 layer 2 guard function"
  }
}

resource "aws_iam_role_policy" "bedrock_guard" {
  name   = "attach-halt-policy"
  role   = aws_iam_role.bedrock_guard.id
  policy = data.aws_iam_policy_document.bedrock_guard.json
}

/**
 * 関数本体の zip。
 *
 * ソースは terraform/lambda/bedrock-guard/index.py に**平文のまま**置く。zip を
 * リポジトリへコミットしない理由は、中身が読めない成果物を追跡すると、宣言と
 * 実物がずれても差分に現れないためである。zip は apply のたびに生成する。
 *
 * 出力先の terraform/build/ は .gitignore で追跡から外している。
 *
 * **依存ライブラリは無い。** boto3 は Lambda の Python ランタイムに同梱されており、
 * パッケージングの手順（pip install -t）を運用へ持ち込まずに済む。
 */
data "archive_file" "bedrock_guard" {
  type        = "zip"
  source_file = "${path.module}/lambda/bedrock-guard/index.py"
  output_path = "${path.module}/build/bedrock-guard.zip"
}

/**
 * 層 2 の実行部。詳しい理由は index.py の docstring にある。
 *
 * timeout を 30 秒にしているのは、やることが IAM の API 1 回だからである。既定の
 * 3 秒でも足りるはずだが、**費用ガードがタイムアウトで止め損なう**のが最悪なので、
 * 余裕を取る。ここを長くしても平常時は 1 度も動かないため費用に効かない。
 */
resource "aws_lambda_function" "bedrock_guard" {
  function_name = local.bedrock_guard_function_name
  role          = aws_iam_role.bedrock_guard.arn
  handler       = "index.handler"
  runtime       = "python3.13"
  timeout       = 30
  memory_size   = 128

  filename = data.archive_file.bedrock_guard.output_path
  # ソースを直したときに再配備させる。これが無いと index.py の変更が apply されない。
  source_code_hash = data.archive_file.bedrock_guard.output_base64sha256

  environment {
    variables = {
      # 対象と手段をコードへ焼き込まない。**関数は「誰に何を付けるか」を知らず、
      # 宣言だけが知っている。** 名前を変えたときにコード側が古いままになる経路を作らない。
      TARGET_USER_NAME = aws_iam_user.bedrock_invoker.name
      HALT_POLICY_ARN  = aws_iam_policy.bedrock_halt.arn
    }
  }

  # ロググループより先に関数が動くと、Lambda が無期限保持のロググループを自分で作り、
  # 宣言側の retention_in_days が効かない状態になる。
  depends_on = [
    aws_cloudwatch_log_group.bedrock_guard,
    aws_iam_role_policy.bedrock_guard,
  ]

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Spec 4.3 layer 2 - revoke Bedrock invocation on a token burst"
  }
}

/**
 * アラームと関数の間の SNS トピック。
 *
 * **CloudWatch アラームは Lambda を直接呼べない**（alarm_actions が受け付けるのは
 * SNS / EC2 / Auto Scaling / SSM の各アクションだけである）。ここに SNS を挟むのは
 * 設計上の選択ではなく、CloudWatch の制約である。
 *
 * KMS の暗号化は付けていない。流れるのはアラームの状態遷移だけで、機密を含まない。
 */
resource "aws_sns_topic" "bedrock_guard" {
  name = "game-forge-bedrock-guard"

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Spec 4.3 layer 2 - alarm to guard function"
  }
}

/**
 * トピックへ Publish できる相手を、このアラーム 1 つに限る。
 *
 * 既定のトピックポリシーはアカウント内のプリンシパルを広く許すが、CloudWatch は
 * サービスプリンシパルとして Publish するため、**明示しないと届かない可能性がある。**
 * 明示するついでに SourceArn で 1 本に絞る。トピックへ Publish できる = ガードを
 * 撃てる、であり、撃てる相手は少ないほどよい。
 */
data "aws_iam_policy_document" "bedrock_guard_topic" {
  statement {
    sid       = "AllowCloudWatchAlarmPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.bedrock_guard.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_metric_alarm.bedrock_token_burst.arn]
    }
  }
}

resource "aws_sns_topic_policy" "bedrock_guard" {
  arn    = aws_sns_topic.bedrock_guard.arn
  policy = data.aws_iam_policy_document.bedrock_guard_topic.json
}

resource "aws_sns_topic_subscription" "bedrock_guard" {
  topic_arn = aws_sns_topic.bedrock_guard.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.bedrock_guard.arn
}

# SNS から関数を呼ぶ許可。source_arn を付けないと「どの SNS トピックからでも呼べる」
# 関数になる。ガードを撃てる経路を 1 本に保つ。
resource "aws_lambda_permission" "bedrock_guard_sns" {
  statement_id  = "AllowExecutionFromGuardTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bedrock_guard.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.bedrock_guard.arn
}

/**
 * 層 2 のアラーム本体（4.3「層 2 の設定」）。
 *
 * **メトリクスは AWS/Bedrock の InputTokenCount と OutputTokenCount の合算で、
 * 全モデルを合わせて見る。** dimensions を指定しないのはそのためである。モデルごとに
 * 分けると、複数モデルが同時に暴走したときに 1 本ずつはしきい値へ届かず、合計では
 * 大きく超えている、という取り逃がしが起きる。4.3 の上振れ見積もり（1 分あたり
 * 約 181 円）は Claude と DeepSeek が**同時に**暴走した場合の値である。
 *
 * **式は素の加算にしてある。** FILL で欠測を 0 埋めする書き方もあるが、Bedrock は
 * 1 回の呼び出しで入力・出力の両方を必ず出すため、片方だけ欠ける状況が無い。
 * 検証しづらい関数を費用ガードの中心に置かない。
 *
 * datapoints_to_alarm = 1 / evaluation_periods = 1 は「300 秒 1 データポイントで
 * 発火」である（4.3）。複数期間を待つ設計にすると、その分だけ上振れが増える。
 *
 * treat_missing_data = "notBreaching": 生成が 1 度も走らない期間はメトリクスが
 * 出ない。**欠測を「異常」と読むと、平常時に発火してアプリを止める。** 費用ガードは
 * 迷ったら止める側へ倒すのが原則だが、それは「呼び出しが起きている」ことが前提で、
 * 呼び出しが無い期間に燃える費用は無い。
 */
resource "aws_cloudwatch_metric_alarm" "bedrock_token_burst" {
  alarm_name        = "game-forge-bedrock-token-burst"
  alarm_description = "Spec 4.3 layer 2 - Bedrock token burst. Revokes invocation permission."

  comparison_operator = "GreaterThanThreshold"
  threshold           = local.bedrock_burst_threshold_tokens
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  actions_enabled = true
  alarm_actions   = [aws_sns_topic.bedrock_guard.arn]

  metric_query {
    id          = "total_tokens"
    label       = "InputTokenCount + OutputTokenCount (all models)"
    expression  = "input_tokens + output_tokens"
    return_data = true
  }

  metric_query {
    id = "input_tokens"

    metric {
      namespace   = local.bedrock_burst_namespace
      metric_name = "InputTokenCount"
      period      = local.bedrock_burst_period_seconds
      stat        = "Sum"
    }
  }

  metric_query {
    id = "output_tokens"

    metric {
      namespace   = local.bedrock_burst_namespace
      metric_name = "OutputTokenCount"
      period      = local.bedrock_burst_period_seconds
      stat        = "Sum"
    }
  }

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
  }
}

# ── 層 3: 会計層（AWS Budgets Actions） ─────────────────────────────────────

data "aws_iam_policy_document" "budget_action_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    # 混乱した代理（confused deputy）を塞ぐ。この条件が無いと、他アカウントの
    # Budgets からこのロールを引き受けられる形になる。
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.prod.account_id]
    }
  }
}

/**
 * Budgets が発火時に引き受けるロール。**層 2 の Lambda ロールと同じ権限に揃える。**
 *
 * 同じ Deny ポリシーを同じユーザーへ付けるだけなので、権限も同じでよい。ここを
 * 広く取ると、遅い層のために強い権限を常設することになる。
 */
data "aws_iam_policy_document" "budget_action" {
  statement {
    sid       = "AttachHaltPolicyToInvoker"
    effect    = "Allow"
    actions   = ["iam:AttachUserPolicy"]
    resources = [aws_iam_user.bedrock_invoker.arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.bedrock_halt.arn]
    }
  }
}

resource "aws_iam_role" "budget_action" {
  name               = "game-forge-budget-action"
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.budget_action_assume.json

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Execution role for the spec 4.3 layer 3 budget action"
  }
}

resource "aws_iam_role_policy" "budget_action" {
  name   = "attach-halt-policy"
  role   = aws_iam_role.budget_action.id
  policy = data.aws_iam_policy_document.budget_action.json
}

/**
 * 本番アカウントの月次予算（4.3「層 3 の設定」）。
 *
 * **サービスで絞っていない（アカウント全体を見る）。** Bedrock だけに絞る cost_filter
 * を付けたくなるが、採らなかった。Cost Explorer のサービス名を 1 文字でも取り違えると
 * **予算は黙って 0 USD を追い続け、二度と発火しない。** 費用ガードが持ってはいけない
 * 壊れ方である（4.3 は「層 2 と 3 はどちらも設定であり、設定を誤れば効かない」ことを
 * 既に受け入れた劣化として挙げている。これ以上、静かに効かなくなる経路を足さない）。
 *
 * このアカウントに Bedrock 以外で載っているのは Route53 の 1 ゾーン（約 0.5 USD/月の
 * 固定費。4.6）だけなので、アカウント合計は実質「Bedrock ＋ 0.5 USD」である。絞らない
 * ことによるずれは**早く発火する側**へ働き、為替バッファの向き（アプリ層の 1 万円より
 * 先に発火してはいけない）とも矛盾しない。84.5 USD でも 130 円/ドルで約 11,000 円ある。
 *
 * 80% は通知のみ、100% で停止（Deny の付与。下の budget_action）。
 */
resource "aws_budgets_budget" "prod_monthly" {
  name              = "game-forge-prod-monthly"
  budget_type       = "COST"
  limit_amount      = local.bedrock_budget_prod_usd
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = local.bedrock_budget_period_start

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = local.bedrock_budget_warn_percent
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}

/**
 * 100% で停止する（層 3 の実行部）。
 *
 * **approval_model = AUTOMATIC。** 承認待ちにすると、人が気づくまで止まらない。
 * 遅い層をさらに遅くする意味が無い。
 *
 * **notification_type = ACTUAL。** FORECASTED にすると予測で止まる。予測は月初の
 * 少ない実績から大きく振れるため、正常な利用で生成を止めてしまう。層 3 が捕まえたい
 * のは「台帳が静かにずれた**実際の**超過」である。
 *
 * subscriber は必須項目である（AWS の要求）。発火を人へ届ける経路でもある。
 */
resource "aws_budgets_budget_action" "prod_halt" {
  budget_name        = aws_budgets_budget.prod_monthly.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = local.bedrock_budget_halt_percent
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.bedrock_halt.arn
      users      = [aws_iam_user.bedrock_invoker.name]
    }
  }

  subscriber {
    subscription_type = "EMAIL"
    address           = var.budget_notification_email
  }
}

/**
 * 開発アカウントの月次予算（4.3「層 3 の設定」）。
 *
 * **アクションを付けない。通知だけである。** dev には長命のプリンシパルが無く
 * （IAM ユーザーを置かない。仕様 9.2）、Deny を付ける相手そのものが存在しない。開発は人が
 * SSO の一時資格情報で手で叩く場所で、アプリのループが走らない。ここでの予算は
 * **事故の上限**としてのみ置く。
 *
 * しきい値を prod と同じ 80% / 100% にしてあるのは、超過に気づく形を 2 つ持たない
 * ためである（dev だけ別の読み方をする運用は覚えていられない）。
 */
resource "aws_budgets_budget" "dev_monthly" {
  provider = aws.dev

  name              = "game-forge-dev-monthly"
  budget_type       = "COST"
  limit_amount      = local.bedrock_budget_dev_usd
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = local.bedrock_budget_period_start

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = local.bedrock_budget_warn_percent
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = local.bedrock_budget_halt_percent
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
