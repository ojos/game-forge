/**
 * 相談の関数（#695 / M18-2。仕様 5.16「置き場所——エッジは Bedrock を呼べない」）。
 *
 * 作者が生成の前に AI と会話して指示文を練るとき、**Bedrock の `Converse` を呼び、8.2 の
 * Guardrail を掛ける実行体**である。エッジから**同期で**呼ばれ、返答と `usage` を応答で返す
 * （`src/chat-client.ts`）。本体は `src/chat/handler.ts`。
 *
 * ## なぜ関数を 1 つ足すのか
 *
 * **エッジ（Cloudflare Pages Functions）は Bedrock を呼べない。** `BEDROCK_AWS_*` は #160 / #570 で
 * Pages のシークレットから消してあり、Bedrock を呼ぶのは **AWS の中で実行ロールを引き受けられる
 * 実行体だけ**である（仕様 4.1）。
 *
 * **オーケストレータに相乗りさせなかった**（利用者の決定。5.16）。相乗りすると**相談のコードを
 * 触るたびにオーケストレータの束が変わり、配り直すまで main の配備が全部止まる**
 * （`scripts/orchestrator-bundle-changed.sh` が起動する関門）。相談は画面に近い機能で、
 * 生成の経路より直す頻度が高い。
 *
 * ## `avatar-function.tf` と同じ形にした（違いは 3 つ）
 *
 * | | アイコン変換 | 相談 |
 * |---|---|---|
 * | 実行ロールの許可 | ログだけ | **ログ＋Bedrock**（`local.bedrock_invoke_actions` を共有） |
 * | 配る中身 | `lambda/avatar-encode/`（sharp を含む zip） | **`scripts/bundle-chat.sh` が esbuild で束ねた zip**（オーケストレータと同じ形） |
 * | 環境変数 | 出力の大きさ・品質 | **Guardrail の id と版**（`terraform/moderation.tf`） |
 *
 * **同じところ**: 既存の .tf を 1 行も触らない（許可はこのファイルに置く）・同期呼び出しなので
 * 非同期呼び出しの構成を宣言しない・実行ロールはログと Bedrock だけ・ロググループを先に作る・x86_64。
 *
 * ## D1 も R2 も触れない
 *
 * **台帳を書くのはエッジである**（`src/chat.ts`）。会話も枠も D1 にあるが、この関数は
 * Cloudflare の資格情報を持たない——オーケストレータが持たないのと同じ理由（7.3 / 9.2 / #150）。
 *
 * ## コードは宣言が持たない
 *
 * `filename` と `source_code_hash` を `ignore_changes` に入れ、器は仮のコード
 * （`terraform/lambda/chat-placeholder/`）で作る。**配るのは利用者の端末である**
 * （`scripts/deploy-chat.sh`。`terraform/orchestrator.tf` と同じ形）。
 */

locals {
  /**
   * 関数名。**この値の正本はここである。**
   *
   * `wrangler.toml` の `CHAT_FUNCTION_NAME`（3 か所）はこの写しで、突き合わせは
   * `scripts/check-chat-copies.sh` が行う。
   */
  chat_function_name = "game-forge-chat"

  /**
   * メモリ（MB）。
   *
   * **512 MB。** この関数がするのは JSON を組み立てて HTTPS を 2 回叩くこと（Guardrail と
   * `Converse`）だけで、画像も Wasm も扱わない。**待ち時間が支配的**なので、メモリを増やしても
   * 速くならない。オーケストレータ（生成の 80 秒を待つ）より小さくてよい。
   *
   * **これは見積もりであって実測ではない。** 本番の CloudWatch の `Max Memory Used` を見て
   * 決め直すこと（`avatar-function.tf` と同じ但し書き）。
   */
  chat_function_memory_mb = 512

  /**
   * タイムアウト（秒）。
   *
   * **30 秒。** 相談の返答は出力 1,500 トークンが上限（`src/chat-payload.ts` の
   * `CHAT_MAX_OUTPUT_TOKENS`）で、実測前の見込みは数秒である。**エッジは応答を待っている**ので、
   * 長く取りすぎると、壊れた日に利用者の画面が長く止まる。
   */
  chat_function_timeout_seconds = 30

  /**
   * 予約同時実行数。
   *
   * **2。** 相談は 1 人 60 秒 60 回の上限の内側で呼ばれ（`src/chat-paths.ts` の
   * `CHAT_RATE_LIMIT_SCOPE`）、参加者は 50 人が上限である（8.1）。**上限側の意味のほうが大きい**
   * ——4.3 の費用ガードは月次の累計で効くので、**暴走した瞬間を止めるのはここである。**
   *
   * **アカウントの同時実行総枠に注意すること。** 予約を付けると未予約の残りが最低値（10）を
   * 割ってはならず、#103 ではそれで `InvalidParameterValueException` が出た。**apply が同じ例外で
   * 落ちたらここを `null` にすること**（`avatar-function.tf` と同じ）。
   */
  chat_function_reserved_concurrency = 2

  /** 実行ロールへ与えるログの動作。**`CreateLogGroup` は与えない**（宣言済みの 1 本に書くだけ）。 */
  chat_role_log_actions = [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]

  /** 呼び出し側（`game-forge-build-invoker`）へ足す許可。 */
  chat_invoke_actions   = ["lambda:InvokeFunction"]
  chat_invoke_resources = [aws_lambda_function.chat.arn]

  chat_function_tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    # IAM / タグの値に使える文字は限られる（terraform/build-invoker.tf の実測）。
    Purpose = "Draft generation prompts with the author before generating - spec 5.16 / issue 695"
  }
}

# ── ログと IAM ───────────────────────────────────────────────────────────────

/**
 * ロググループ。**関数より先に作る**（`depends_on`。無期限保持のロググループを Lambda に作らせない）。
 */
resource "aws_cloudwatch_log_group" "chat" {
  name              = "/aws/lambda/${local.chat_function_name}"
  retention_in_days = 14

  tags = local.chat_function_tags
}

data "aws_iam_policy_document" "chat_assume" {
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
 * 相談の実行ロール。**与えるのは 2 つだけである。**
 *
 *   1. 宣言済みのロググループ 1 本への書き込み（`CreateLogGroup` は与えない）
 *   2. Bedrock の呼び出しと Guardrail の適用（許可の定義は `terraform/bedrock.tf` と共有）
 *
 * **ビルド関数を呼べない。** オーケストレータの実行ロールと違い、相談はビルドを起動しない
 * （`src/chat/handler.ts` が `BUILD_AWS_*` を写さないのと同じ線）。
 *
 * **D1 も R2 も触れない**（冒頭）。
 */
data "aws_iam_policy_document" "chat" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions   = local.chat_role_log_actions
    resources = ["${aws_cloudwatch_log_group.chat.arn}:*"]
  }

  /**
   * 相談の呼び出しと、8.2 の Guardrail の適用。
   *
   * **定義を `terraform/bedrock.tf` と共有する。** 動作の一覧をここへ書き写すと、
   * **Bedrock の API が増えた日に、生成だけが追随して相談が置いていかれる**（あるいはその逆）。
   * `resources` を全モデルに開いている理由もあちらと同じである（確定5 の複数モデル構成）。
   */
  statement {
    sid    = "InvokeChatModel"
    effect = "Allow"

    actions   = local.bedrock_invoke_actions
    resources = ["*"]
  }
}

resource "aws_iam_role" "chat" {
  name               = local.chat_function_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.chat_assume.json

  tags = merge(local.chat_function_tags, {
    Purpose = "Execution role for the chat function - spec 5.16 / issue 695"
  })
}

resource "aws_iam_role_policy" "chat" {
  name   = "chat"
  role   = aws_iam_role.chat.id
  policy = data.aws_iam_policy_document.chat.json
}

# ── 関数本体 ────────────────────────────────────────────────────────────────

/**
 * 器を作るためだけの仮のコード（冒頭「コードは宣言が持たない」）。
 */
data "archive_file" "chat_placeholder" {
  type        = "zip"
  source_file = "${path.module}/lambda/chat-placeholder/index.mjs"
  output_path = "${path.module}/build/chat-placeholder.zip"
}

resource "aws_lambda_function" "chat" {
  function_name = local.chat_function_name
  role          = aws_iam_role.chat.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  # **x86_64 を明示する**（`terraform/orchestrator.tf` と同じ判断で揃える）。
  architectures = ["x86_64"]

  memory_size = local.chat_function_memory_mb
  timeout     = local.chat_function_timeout_seconds

  reserved_concurrent_executions = local.chat_function_reserved_concurrency

  filename         = data.archive_file.chat_placeholder.output_path
  source_code_hash = data.archive_file.chat_placeholder.output_base64sha256

  environment {
    variables = {
      # 入力側モデレーション（8.2 / #37）。**id も版も宣言から渡す**——ハンドラ側で
      # 組み立てると、apply していない版を呼びうる（`terraform/orchestrator.tf` と同じ）。
      # **渡らなかったときは fail-closed で遮断する**ので、抜けた状態が「素通り」にはならない。
      MODERATION_GUARDRAIL_ID      = aws_bedrock_guardrail.input_moderation.guardrail_id
      MODERATION_GUARDRAIL_VERSION = aws_bedrock_guardrail_version.input_moderation.version
    }
  }

  lifecycle {
    # 上の「コードは宣言が持たない」を参照。
    ignore_changes = [filename, source_code_hash]
  }

  # ロググループより先に関数が動くと、Lambda が無期限保持のロググループを自分で作り、
  # 宣言側の retention_in_days が効かない状態になる。
  depends_on = [
    aws_cloudwatch_log_group.chat,
    aws_iam_role_policy.chat,
  ]

  tags = local.chat_function_tags
}

# ── 呼び出しの許可 ───────────────────────────────────────────────────────────

/**
 * エッジ（Cloudflare Pages Functions）から、この関数を呼ぶ許可。
 *
 * **`terraform/build-invoker.tf` を触らずに足す**（`avatar-function.tf` の `avatar_invoke` と
 * 同じ形）。動作 1 つ・対象 1 つだけ。**鍵は増えない**——使うのは既存の `BUILD_AWS_*` である。
 */
data "aws_iam_policy_document" "chat_invoke" {
  statement {
    sid    = "InvokeChatFunction"
    effect = "Allow"

    actions   = local.chat_invoke_actions
    resources = local.chat_invoke_resources
  }
}

resource "aws_iam_user_policy" "chat_invoke" {
  name   = "chat-invoke"
  user   = aws_iam_user.build_invoker.name
  policy = data.aws_iam_policy_document.chat_invoke.json
}
