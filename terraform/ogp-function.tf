/**
 * OGP 撮影関数（5.4 / 11.2 / #26）。
 *
 * 公開された作品の `/g/<game_id>/` を headless chromium で開き、**初回フレームの静止画を
 * 1 枚** 撮って、アプリ用ホストのコールバックへ PNG として送り返す。
 *
 * ## なぜ Cloudflare ではなく AWS なのか（利用者の決定）
 *
 * Cloudflare Browser Rendering は **Workers の有料プラン（$5/月）を要求する。**
 * 3.2 の「Workers は無料枠」と 4.6 の「実質ゼロ」の両方を崩すため採らない。
 * 5.5 が Cloudflare Email Sending を退けて Resend を採ったのと**同じ理由・同じ結論**である。
 *
 * AWS には既にビルド関数（`terraform/build-function.tf`）とオーケストレータ
 * （`terraform/orchestrator.tf`）が居り、**呼び出しの資格情報も IAM も配備手順も
 * その形が出来ている。** 足すのはこの関数 1 つと、許可 1 つである。
 *
 * ## 既存の 2 つの .tf を 1 行も触らない
 *
 * 呼び出し側の IAM ユーザー（`aws_iam_user.build_invoker`）は
 * `terraform/build-invoker.tf` が宣言しているが、**そこへ許可を書き足さない。**
 * インラインポリシーは 1 人の IAM ユーザーに複数付けられるので、**この関数のための
 * 許可は、この関数の宣言と同じファイルに置く**（下の `aws_iam_user_policy.ogp_invoke`）。
 * 関数を消すときに、消す対象がこのファイルだけで閉じる。
 *
 * ## R2 の資格情報を渡さない
 *
 * ビルド関数は SSM 経由で R2 の鍵を受け取り、自分で R2 へ書く。**この関数には渡さない。**
 * 撮れた PNG はコールバックの本文として Worker へ戻り、**R2 バインディングを持つ
 * Worker が書く**（`src/ogp.ts`）。1 枚 100 KB 前後の画像のために、新しい場所へ
 * 恒久的な R2 の書き込み権限を置かない。
 *
 * したがって実行ロールが持つのは**自分のログを書く許可だけ**である。
 *
 * ## 撮る先と送り先は宣言が持つ
 *
 * `SANDBOX_BASE_URL` と `CALLBACK_BASE_URL` を**環境変数として渡す。**
 * ペイロードで受け取らないのは、`terraform/orchestrator.tf` が `CALLBACK_BASE_URL` に
 * ついて書いたものと同じ理由——**呼び出しのペイロードを差し替えられる者に、撮る先と
 * 送り先を決めさせない。** 載せる形は、この関数を「任意の URL を撮って任意の宛先へ
 * 送る道具」に変える。
 *
 * どちらも `local.app_host` / `local.sandbox_host`（`terraform/dns.tf`）から作るので、
 * `wrangler.toml` の宣言とずれない。
 */

locals {
  /**
   * 関数名。**この値の正本はここである。**
   *
   * `wrangler.toml` の `OGP_FUNCTION_NAME` はこの写しで、Worker が呼ぶ相手を指す
   * （`src/ogp-client.ts`）。変えたら追随させること（`docs/ogp-capture.md`）。
   */
  ogp_function_name = "game-forge-ogp"

  /** イメージを置く ECR リポジトリ名（`docker/ogp-shot/`）。 */
  ogp_repository_name = "game-forge/ogp-shot"

  /**
   * メモリ（MB）。
   *
   * **2,048 MB。** chromium は 1 タブでも数百 MB を使い、Lambda では vCPU がメモリに
   * 比例して割り当てられる（1,769 MB で 1 vCPU）。**2,048 MB は「2 vCPU に届く最小の
   * 段」ではなく、1 vCPU をわずかに超える配分**で、描画とデコードが 1 コアで詰まらない
   * 幅を取っている。
   *
   * **これは見積もりであって実測ではない。** ビルド関数のメモリは #103 で実測して
   * 決めた（3,538 MB）が、こちらは**まだ本番で 1 枚も撮っていない。** 最初の撮影で
   * CloudWatch の `Max Memory Used` を見て決め直すこと（手順は `docs/ogp-capture.md`）。
   * 1 回の撮影は数秒なので、2,048 MB × 10 秒 = 20 GB 秒（約 0.05 円）である。
   */
  ogp_function_memory_mb = 2048

  /**
   * タイムアウト（秒）。
   *
   * **60 秒。** 内訳は「コールドスタートで chromium を展開する時間 ＋ ページを開いて
   * wasm が動き出すまで ＋ 撮影 ＋ 送信」で、**支配項は 2 つ目**である。作品の `.wasm` は
   * 圧縮後 2 MB 前後あり（3.4）、これを取得して `instantiateStreaming` で起動するまでが
   * 数秒かかる。
   *
   * **関数側の待ち時間（`CAPTURE_TIMEOUT_MS`）より長く取る。** 短いと、関数が
   * 「撮れなかった」と自分で判断してコールバックを送る前に Lambda ごと切られ、
   * **`games.ogp_state` が `capturing` のまま残る**（誰も進められない行になる）。
   * 3.8 が「待ち時間の上限は関数のタイムアウトより長く取る」と書いているのと同じ形の、
   * 向きが逆の制約である。
   */
  ogp_function_timeout_seconds = 60

  /**
   * 関数の中で撮影を諦めるまでの時間（ミリ秒）。
   *
   * **30,000 ms。** 実測から決めた（#219。根拠は `docs/ogp-capture.md` 9 章）。
   * **ここで諦めた場合も、関数は必ず失敗のコールバックを送る**（`docker/ogp-shot/`）。
   * 黙って終わらせない。
   *
   * # なぜ 20,000 ms では足りないのか
   *
   * **同じ作品が 7.1〜16.9 秒でぶれる**（`ff7d397e` を 4 回測った実測）。20,000 ms は
   * 最悪実測 16,907 ms に対して **3,093 ms（15%）** しか残らず、**ぶれ 1 回分に足りない。**
   *
   * **そして 16.9 秒は外れ値ではない。** OGP は**公開時に 1 回だけ**撮るので、作者が
   * 公開前に遊んでいなければ、**その 1 回はいちばん冷えた側を引く**（不変資材は
   * `public, max-age=31536000, immutable` で配られるため、エッジに載っていなければ
   * 11 MB を R2 まで取りに行く。`src/sandbox-delivery.ts`）。
   *
   * **30,000 ms は最悪実測に対して 78% の余裕である。** 上の
   * `ogp_function_timeout_seconds`（60 秒）より内側なので、諦めたあとに失敗の
   * コールバックを送る余地も残る。
   *
   * **値を動かしたら実測を取り直すこと**（`docs/ogp-capture.md` 9 章に手順がある。
   * 公開経路を通さず関数を直接叩けば、本番の状態を動かさずに測れる）。
   */
  ogp_capture_timeout_ms = 30000

  /**
   * エフェメラルストレージ（`/tmp`）。
   *
   * **1,024 MB。** chromium の実体（約 100 MB の圧縮アーカイブ）を `/tmp` へ展開し、
   * さらにユーザーデータディレクトリを置く。既定の 512 MB でも入る見込みだが、
   * ビルド関数が同じ理由で 1,024 MB を選んでいる（「実質ゼロで 10 倍の余裕が買えるなら
   * 買う」）。足りないと chromium は起動に失敗し、原因が撮影の失敗と区別しづらい。
   */
  ogp_function_ephemeral_storage_mb = 1024

  /**
   * 予約同時実行数。
   *
   * **2。** 公開は 1 作品につき 1 回きりの操作で、日次の生成が全体で約 34 回
   * （確定25）である以上、**同時に 3 枚撮る場面は事実上無い。** 予約は上限であると
   * 同時に下限でもあるので、他の関数が枠を食い尽くしても 2 は確保される。
   *
   * **上限側の意味のほうが大きい。** 4.3 の費用ガードは Bedrock しか見ておらず、
   * この関数の暴走はどの層にも捕まらない。2 並列 × 2 GB を 1 時間回し続けても
   * 約 $0.24 で、月次上限（4.3）に対して無視できる大きさに収まる。
   *
   * **アカウントの同時実行総枠に注意すること。** 予約を付けると未予約の残りが最低値
   * （10）を割ってはならず、#103 ではそれで `InvalidParameterValueException` が出た。
   * 引き上げ（`L-B99A9384`）は適用済みだが、**apply が同じ例外で落ちたらここを `null` に
   * すること**（外している間の上限はアカウント総枠になる）。
   */
  ogp_function_reserved_concurrency = 2

  /**
   * 非同期呼び出しの再試行回数。
   *
   * **1。オーケストレータ（0）と違う値である。**
   *
   * 0 にしている `terraform/orchestrator.tf` の理由は「5.2-7 の 3 試行と掛け算になり、
   * 1 回の送信から最大 9 回・約 144 円が出る」ことだった。**こちらに掛け算の相手が無い。**
   * LLM を呼ばず、1 回の撮影は 2 GB × 数秒（約 0.05 円）である。
   *
   * **再試行が安全なのは、コールバックが使い捨てトークンで冪等だからである**
   * （`src/ogp.ts` の `completeOgpCapture`）。同じイベントが 2 回配信されても、
   * 先に届いたほうがトークンを消費し、2 通目は 404 で弾かれる。
   *
   * 1 回だけにするのは、失敗が続く相手（起動しない作品）へ何度も撮りに行かないためである。
   */
  ogp_maximum_retry_attempts = 1

  /**
   * 非同期呼び出しの有効期限（秒）。
   *
   * **300 秒。** 既定は 6 時間で、**忘れられた撮影が数時間後に走ると、そのころには
   * 作者が公開を取り下げている（8.4 で `removed`）可能性がある。** その場合 `/g/` は
   * 404 になり、撮影は失敗として終わる——無駄ではあるが害は無い。それでも、
   * **公開の直後に撮るという設計を、期限としても表しておく。**
   */
  ogp_maximum_event_age_seconds = 300

  /**
   * 撮る大きさ（px）。
   *
   * **1200 × 630。** OGP のカードとして各所が期待する比率（1.91:1）である。
   * **`src/ogp.ts` の `OGP_IMAGE_WIDTH` / `OGP_IMAGE_HEIGHT` が写しを持つ**
   * （メタタグに書く値）。突き合わせは `test/ogp.test.ts` が行う。
   */
  ogp_viewport_width  = 1200
  ogp_viewport_height = 630

  /**
   * 実行ロールへ与える動作の一覧。
   *
   * **ログを書くことだけである。** R2 も SSM も KMS も要らない（モジュール冒頭）。
   * ポリシー文書と output の両方がこの 1 つの定義から作られる
   * （`terraform/build-function.tf` の `build_role_actions` と同じ形）。
   */
  ogp_role_actions = [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]

  /** 呼び出し側（`game-forge-build-invoker`）へ足す許可。 */
  ogp_invoke_actions   = ["lambda:InvokeFunction"]
  ogp_invoke_resources = [aws_lambda_function.ogp.arn]

  ogp_function_tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    # IAM / タグの値に使える文字は限られる（terraform/build-invoker.tf の実測）。
    Purpose = "Capture the first frame of a published game for OGP - spec 5.4 and 11.2 / issue 26"
  }
}

# ── ECR ─────────────────────────────────────────────────────────────────────

/**
 * 撮影関数のイメージを置くリポジトリ。
 *
 * **zip では配れない。** chromium の実体は展開後 250 MB を優に超え、zip パッケージの
 * 上限（展開後 250 MB）に収まらない。コンテナイメージなら 10 GB まで置ける。
 * **これが「関数のサイズ上限で成立しない」を回避している唯一の点**なので、
 * `package_type` を zip へ戻さないこと。
 *
 * タグを可変にするのは `terraform/build-function.tf` と同じ理由である
 * （`latest` を打ち直せなくなる）。
 */
resource "aws_ecr_repository" "ogp_shot" {
  name                 = local.ogp_repository_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  force_delete = false

  tags = local.ogp_function_tags
}

/**
 * 古いイメージを溜めない。
 *
 * chromium 入りのイメージは 400 MB を超える。ECR の無料枠は 500 MB/月なので、
 * **溜めると無料枠を出る**（4.6 の「実質ゼロ」が崩れる）。ビルド関数のリポジトリより
 * 保持数を絞り、直近 3 つだけを残す。
 */
resource "aws_ecr_lifecycle_policy" "ogp_shot" {
  repository = aws_ecr_repository.ogp_shot.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 3 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 3
        }
        action = { type = "expire" }
      },
    ]
  })
}

/**
 * この関数だけがイメージを引ける。
 *
 * `terraform/build-function.tf` の `isolated_build_ecr` と同じ形で、`aws:sourceArn` を
 * この関数 1 つに限る。
 */
data "aws_iam_policy_document" "ogp_shot_ecr" {
  statement {
    sid    = "AllowLambdaToPullTheOgpImage"
    effect = "Allow"

    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:sourceArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.prod.account_id}:function:${local.ogp_function_name}"]
    }
  }
}

resource "aws_ecr_repository_policy" "ogp_shot" {
  repository = aws_ecr_repository.ogp_shot.name
  policy     = data.aws_iam_policy_document.ogp_shot_ecr.json
}

# ── ログと IAM ───────────────────────────────────────────────────────────────

/**
 * ロググループ。
 *
 * **関数より先に作る**（`depends_on`）。関数が先に動くと、Lambda が無期限保持の
 * ロググループを自分で作り、ここの `retention_in_days` が効かない状態になる。
 */
resource "aws_cloudwatch_log_group" "ogp" {
  name              = "/aws/lambda/${local.ogp_function_name}"
  retention_in_days = 14

  tags = local.ogp_function_tags
}

data "aws_iam_policy_document" "ogp_assume" {
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
 * 実行ロールの許可。**自分のログを書くことだけである**（モジュール冒頭）。
 */
data "aws_iam_policy_document" "ogp" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions   = local.ogp_role_actions
    resources = ["${aws_cloudwatch_log_group.ogp.arn}:*"]
  }
}

resource "aws_iam_role" "ogp" {
  name               = local.ogp_function_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.ogp_assume.json

  tags = local.ogp_function_tags
}

resource "aws_iam_role_policy" "ogp" {
  name   = "ogp-function"
  role   = aws_iam_role.ogp.id
  policy = data.aws_iam_policy_document.ogp.json
}

# ── 関数 ─────────────────────────────────────────────────────────────────────

/**
 * 撮影関数の本体。
 *
 * ## イメージは宣言が持たない
 *
 * `image_uri` を `ignore_changes` に入れてある。**配るのは利用者の端末である**
 * （`docs/ogp-capture.md`）。宣言側が特定のダイジェストを指すと、**配備のたびに
 * terraform plan へ差分が出る**（`terraform/build-function.tf` と同じ判断）。
 *
 * **したがって、最初の apply の前にイメージを 1 つ push しておくこと。**
 * ECR が空のまま apply すると、関数の作成が「イメージが無い」で落ちる。
 *
 * ## 環境変数に秘密は無い
 *
 * 撮る先・送り先・大きさ・待ち時間だけである。**この関数はどこへも認証しない**
 * ——`/g/` は公開済みの作品を誰にでも返し、コールバックの資格情報は
 * **ペイロードで渡る使い捨てトークン**である（`src/ogp.ts`）。
 */
resource "aws_lambda_function" "ogp" {
  function_name = local.ogp_function_name
  role          = aws_iam_role.ogp.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.ogp_shot.repository_url}:latest"
  # **x86_64 を明示する。** arm64 は 20% 安いが、chromium の Lambda 向け配布が
  # x86_64 を前提にしている（`docker/ogp-shot/`）。`terraform/build-function.tf` /
  # `terraform/orchestrator.tf` と揃えて、軸を 1 つ増やさない。
  architectures = ["x86_64"]

  memory_size = local.ogp_function_memory_mb
  timeout     = local.ogp_function_timeout_seconds

  ephemeral_storage {
    size = local.ogp_function_ephemeral_storage_mb
  }

  reserved_concurrent_executions = local.ogp_function_reserved_concurrency

  environment {
    variables = {
      # 撮る先。**ペイロードで受け取らない**（モジュール冒頭）。
      SANDBOX_BASE_URL = "https://${local.sandbox_host}"
      # 送り先。同上。
      CALLBACK_BASE_URL = "https://${local.app_host}"
      # 撮る大きさ。写しは `src/ogp.ts` にある（メタタグに書く値）。
      VIEWPORT_WIDTH  = tostring(local.ogp_viewport_width)
      VIEWPORT_HEIGHT = tostring(local.ogp_viewport_height)
      # 関数の中で諦めるまでの時間。**関数のタイムアウトより短い**（上の local）。
      CAPTURE_TIMEOUT_MS = tostring(local.ogp_capture_timeout_ms)
    }
  }

  lifecycle {
    # 上の「イメージは宣言が持たない」を参照。
    ignore_changes = [image_uri]
  }

  depends_on = [
    aws_cloudwatch_log_group.ogp,
    aws_iam_role_policy.ogp,
  ]

  tags = local.ogp_function_tags
}

/**
 * 非同期呼び出しの構成。
 *
 * | 項目 | 値 | 外すと何が起きるか |
 * |---|---|---|
 * | `maximum_retry_attempts` | **1** | 既定は 2。撮り直しは安いが、起動しない作品へ 3 回行く意味は無い |
 * | `maximum_event_age_in_seconds` | **300** | 既定 6 時間。忘れられた撮影が数時間後に走る |
 *
 * **`on_failure` を宣言しない。** オーケストレータ（`terraform/orchestrator.tf`）は
 * リトライを 0 にしたぶん行き先が必要だったが、こちらは**失敗が D1 に残る**——
 * 関数は諦めるときに自分で失敗のコールバックを送り（`docker/ogp-shot/`）、
 * `games.ogp_state` が `failed` になる。**行き先が既にある。**
 *
 * **関数ごと落ちた場合（OOM・タイムアウト）はコールバックが飛ばず、
 * `ogp_state` が `capturing` のまま残る。** これは黙って消えるのとは違い、
 * D1 に痕跡が残る。**撮り直しの経路はまだ無い**（この issue の範囲外。
 * `docs/ogp-capture.md`「まだ無いもの」）。
 */
resource "aws_lambda_function_event_invoke_config" "ogp" {
  function_name = aws_lambda_function.ogp.function_name

  maximum_retry_attempts       = local.ogp_maximum_retry_attempts
  maximum_event_age_in_seconds = local.ogp_maximum_event_age_seconds
}

# ── 呼び出しの許可 ───────────────────────────────────────────────────────────

/**
 * エッジ（Cloudflare Pages Functions）から、この関数を呼ぶ許可。
 *
 * **`terraform/build-invoker.tf` を触らずに足す。** インラインポリシーは 1 人の
 * IAM ユーザーに複数付けられるので、**この関数のための許可はこのファイルに置く**
 * （モジュール冒頭）。動作 1 つ・対象 1 つだけで、ログの読み取りも関数の情報取得も
 * 与えない（`build_invoke` と同じ最小権限の形）。
 *
 * **鍵は増えない。** 使うのは既存の `BUILD_AWS_*` である（`src/ogp-client.ts` に
 * 増やさない理由がある）。
 */
data "aws_iam_policy_document" "ogp_invoke" {
  statement {
    sid    = "InvokeOgpFunction"
    effect = "Allow"

    actions   = local.ogp_invoke_actions
    resources = local.ogp_invoke_resources
  }
}

resource "aws_iam_user_policy" "ogp_invoke" {
  name   = "ogp-invoke"
  user   = aws_iam_user.build_invoker.name
  policy = data.aws_iam_policy_document.ogp_invoke.json
}
