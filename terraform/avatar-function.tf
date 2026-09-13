/**
 * アイコンの再エンコード関数（5.10 / 7.2 / #380）。
 *
 * 利用者が上げた画像（PNG / JPEG / WebP）を**中央で正方形に切り抜き、256px の WebP に作り直して、
 * メタデータ（Exif の位置情報を含む）を落とす。** Worker から**同期で**呼ばれ、変換した画像を応答で
 * 返す（`src/avatar-client.ts`）。本体は `lambda/avatar-encode/`（sharp）。
 *
 * ## なぜ Lambda なのか
 *
 * **Worker の CPU 時間（無料枠 10 ms）では画像を復号できない**（`src/avatar-client.ts` の冒頭）。
 * AWS には既に OGP 撮影関数（`terraform/ogp-function.tf`）が居り、**呼び出しの資格情報も IAM も
 * 配備手順もその形が出来ている。** 足すのはこの関数 1 つと、許可 1 つである。
 *
 * ## `ogp-function.tf` と同じ形にした（違いは 3 つ）
 *
 * | | OGP 撮影 | アイコン |
 * |---|---|---|
 * | 配り方 | コンテナイメージ（chromium が 250 MB を超える） | **zip**（sharp と libvips で展開後 20 MB 前後） |
 * | 呼ばれ方 | 非同期（`Event`）。結果はコールバック | **同期（`RequestResponse`）。結果は応答** |
 * | 非同期呼び出しの構成 | 再試行 1・有効期限 300 秒 | **宣言しない**（同期呼び出しは基盤が再試行しない） |
 *
 * **同じところ**: 既存の .tf を 1 行も触らない（許可はこのファイルに置く）・**R2 の資格情報を渡さない**
 * （変換した画像は応答で Worker へ戻り、R2 バインディングを持つ Worker が書く）・実行ロールはログを
 * 書くことだけ・ロググループを先に作る・x86_64。
 *
 * ## コードは宣言が持たない
 *
 * `filename` と `source_code_hash` を `ignore_changes` に入れ、器は仮のコード
 * （`terraform/lambda/avatar-placeholder/`）で作る。**配るのは利用者の端末である**
 * （`scripts/deploy-avatar.sh`。`terraform/orchestrator.tf` と同じ形）。
 *
 * ## 出力の大きさと上限は宣言が持つ
 *
 * 環境変数で渡し、**ペイロードで受け取らない**（ペイロードを差し替えられる者に、巨大な出力を
 * 作らせない）。**Worker にも同じ値の写しがある**（`src/avatar-paths.ts` の `AVATAR_OUTPUT_SIZE`、
 * `src/avatar-image.ts` の上限）。突き合わせは `scripts/check-avatar-copies.sh` が行う。
 */

locals {
  /**
   * 関数名。**この値の正本はここである。**
   *
   * `wrangler.toml` の `AVATAR_FUNCTION_NAME`（3 か所）はこの写しで、突き合わせは
   * `scripts/check-avatar-copies.sh` が行う。
   */
  avatar_function_name = "game-forge-avatar"

  /**
   * メモリ（MB）。
   *
   * **1,024 MB。** 受け付ける上限の 4096 × 4096 の画像は、復号すると RGBA で 64 MB になる。libvips は
   * 縮小しながら読む（JPEG は復号の段で縮める）ので実際はもっと小さいが、**画素の爆弾を上限いっぱいで
   * 送られても落ちない幅**を取る。Lambda では vCPU もメモリに比例するので、変換の待ち時間も短くなる。
   *
   * **これは見積もりであって実測ではない。** 本番の最初の設定で CloudWatch の `Max Memory Used` を見て
   * 決め直すこと。1 回の変換は 1 秒未満の見込みで、1,024 MB × 1 秒 ≒ 0.002 円である。
   */
  avatar_function_memory_mb = 1024

  /**
   * タイムアウト（秒）。
   *
   * **15 秒。** 内訳はコールドスタート（zip の展開と sharp の読み込みで 1〜2 秒）と変換（1 秒未満）。
   * **Worker は応答を待っている**ので、長く取りすぎると、壊れた日に利用者の画面が長く止まる。
   */
  avatar_function_timeout_seconds = 15

  /**
   * 予約同時実行数。
   *
   * **2。** 設定は 1 人 60 秒に 1 回まで（`src/avatar.ts` の `AVATAR_CHANGE_INTERVAL_SECONDS`）で、
   * 参加者は 50 人が上限である（8.1）。**上限側の意味のほうが大きい**——4.3 の費用ガードは Bedrock しか
   * 見ておらず、この関数の暴走はどの層にも捕まらない（`ogp-function.tf` と同じ理由）。
   *
   * **アカウントの同時実行総枠に注意すること。** 予約を付けると未予約の残りが最低値（10）を割っては
   * ならず、#103 ではそれで `InvalidParameterValueException` が出た。**apply が同じ例外で落ちたら
   * ここを `null` にすること**（外している間の上限はアカウント総枠になる）。
   */
  avatar_function_reserved_concurrency = 2

  /**
   * 出力する画像の一辺（px）。**Worker の `AVATAR_OUTPUT_SIZE`（`src/avatar-paths.ts`）と同じ値。**
   *
   * Worker は受け取った画像がこの大きさの正方形であることを確かめてから R2 へ書く（`src/avatar.ts` の
   * `isDeliverableAvatar`）。ずれると、すべての設定が「保存できませんでした」になる。
   */
  avatar_output_size = 256

  /** 受け付ける入力の最大バイト数。**Worker の `AVATAR_MAX_BYTES`（`src/avatar-image.ts`）と同じ値。** */
  avatar_max_input_bytes = 4194304

  /** 入力の幅と高さの上限（px）。**Worker の `AVATAR_MAX_DIMENSION`（`src/avatar-image.ts`）と同じ値。** */
  avatar_max_input_dimension = 4096

  /**
   * WebP の品質（1〜100）。
   *
   * **80。** 256 × 256 の写真で 20〜40 KB に収まり、1.75rem（28px 前後）で表示する範囲では劣化が見えない。
   * Worker は出力を 256 KiB で打ち切る（`src/avatar.ts` の `AVATAR_MAX_OUTPUT_BYTES`）。
   */
  avatar_webp_quality = 80

  /** 実行ロールへ与える動作の一覧。**ログを書くことだけである**（R2 も SSM も KMS も要らない）。 */
  avatar_role_actions = [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]

  /** 呼び出し側（`game-forge-build-invoker`）へ足す許可。 */
  avatar_invoke_actions   = ["lambda:InvokeFunction"]
  avatar_invoke_resources = [aws_lambda_function.avatar.arn]

  avatar_function_tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    # IAM / タグの値に使える文字は限られる（terraform/build-invoker.tf の実測）。
    Purpose = "Re-encode user avatar images and strip metadata - spec 5.10 / issue 380"
  }
}

# ── ログと IAM ───────────────────────────────────────────────────────────────

/**
 * ロググループ。**関数より先に作る**（`depends_on`。無期限保持のロググループを Lambda に作らせない）。
 */
resource "aws_cloudwatch_log_group" "avatar" {
  name              = "/aws/lambda/${local.avatar_function_name}"
  retention_in_days = 14

  tags = local.avatar_function_tags
}

data "aws_iam_policy_document" "avatar_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

/** 実行ロールの許可。**自分のログを書くことだけである。** */
data "aws_iam_policy_document" "avatar" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions   = local.avatar_role_actions
    resources = ["${aws_cloudwatch_log_group.avatar.arn}:*"]
  }
}

resource "aws_iam_role" "avatar" {
  name               = local.avatar_function_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.avatar_assume.json

  tags = local.avatar_function_tags
}

resource "aws_iam_role_policy" "avatar" {
  name   = "avatar-function"
  role   = aws_iam_role.avatar.id
  policy = data.aws_iam_policy_document.avatar.json
}

# ── 関数 ─────────────────────────────────────────────────────────────────────

/**
 * 器を作るためだけの仮のコード（`terraform/orchestrator.tf` の `orchestrator_placeholder` と同じ形）。
 * 出力先の `terraform/build/` は `.gitignore` で追跡から外している。
 */
data "archive_file" "avatar_placeholder" {
  type        = "zip"
  source_file = "${path.module}/lambda/avatar-placeholder/index.mjs"
  output_path = "${path.module}/build/avatar-placeholder.zip"
}

/**
 * 再エンコード関数の本体。
 *
 * ## 環境変数に秘密は無い
 *
 * 出力の大きさ・入力の上限・品質だけである。**この関数はどこへも認証しない**——受け取った画像を
 * 変換して返すだけで、R2 にも D1 にも触れない。
 */
resource "aws_lambda_function" "avatar" {
  function_name = local.avatar_function_name
  role          = aws_iam_role.avatar.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  # **x86_64 を明示する。** `scripts/deploy-avatar.sh` は sharp の x64 版を入れて zip を作る。
  # `terraform/ogp-function.tf` / `terraform/orchestrator.tf` と揃えて、軸を 1 つ増やさない。
  architectures = ["x86_64"]

  memory_size = local.avatar_function_memory_mb
  timeout     = local.avatar_function_timeout_seconds

  reserved_concurrent_executions = local.avatar_function_reserved_concurrency

  filename         = data.archive_file.avatar_placeholder.output_path
  source_code_hash = data.archive_file.avatar_placeholder.output_base64sha256

  environment {
    variables = {
      # 出力の一辺。写しは `src/avatar-paths.ts`。
      AVATAR_SIZE = tostring(local.avatar_output_size)
      # 入力の上限。写しは `src/avatar-image.ts`。
      MAX_INPUT_BYTES     = tostring(local.avatar_max_input_bytes)
      MAX_INPUT_DIMENSION = tostring(local.avatar_max_input_dimension)
      # WebP の品質。
      WEBP_QUALITY = tostring(local.avatar_webp_quality)
    }
  }

  lifecycle {
    # 上の「コードは宣言が持たない」を参照。
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [
    aws_cloudwatch_log_group.avatar,
    aws_iam_role_policy.avatar,
  ]

  tags = local.avatar_function_tags
}

# ── 呼び出しの許可 ───────────────────────────────────────────────────────────

/**
 * エッジ（Cloudflare Pages Functions）から、この関数を呼ぶ許可。
 *
 * **`terraform/build-invoker.tf` を触らずに足す**（`ogp-function.tf` の `ogp_invoke` と同じ形）。動作 1 つ・
 * 対象 1 つだけ。**鍵は増えない**——使うのは既存の `BUILD_AWS_*` である。外部層の検査
 * （`scripts/acceptance-remote.sh` の `check_build_invoker_permissions`）は、このポリシーを宣言から
 * 自動で導く（名指しを足さない）。
 */
data "aws_iam_policy_document" "avatar_invoke" {
  statement {
    sid    = "InvokeAvatarFunction"
    effect = "Allow"

    actions   = local.avatar_invoke_actions
    resources = local.avatar_invoke_resources
  }
}

resource "aws_iam_user_policy" "avatar_invoke" {
  name   = "avatar-invoke"
  user   = aws_iam_user.build_invoker.name
  policy = data.aws_iam_policy_document.avatar_invoke.json
}
