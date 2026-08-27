/**
 * ビルド関数と ECR リポジトリの宣言（確定24 / 仕様 3.3 / 3.8 / 7.1 / 9.3。#103）。
 *
 * 確定24 はビルドの実行環境を **AWS Lambda（コンテナイメージ）** に決めた。決め手は
 * 費用ではなく**宣言的管理**である。VPS は手で立てて手で patch するペットサーバになり、
 * shared-ai-rules 4 章「恒久的な状態変更は宣言側を通す」と相性が悪い。本ファイルは
 * その決定の実体であり、**「宣言側を通す」の側を実際に成立させるもの**である。
 *
 * ## このファイルが持つ範囲
 *
 * | 対象 | 持ち主 |
 * |---|---|
 * | ECR リポジトリとライフサイクル | このファイル |
 * | ビルド関数（メモリ / タイムアウト / エフェメラルストレージ / 予約同時実行数） | このファイル |
 * | 実行ロールとロググループ | このファイル |
 * | **関数に載っているイメージ** | **このファイルは持たない**（CI が更新する。下記） |
 * | **R2 の資格情報の値** | **このファイルは持たない**（下記。docs/build-function.md） |
 * | Actions から ECR / Lambda を触るための OIDC ロール | terraform/github-oidc.tf |
 * | ハンドラの実装 | docker/isolated-build/handler/ |
 *
 * ## VPC を作らない（確定24 / v1.11）
 *
 * **VPC・サブネット・SG のいずれも宣言しない。意図的な不在である。** v1.9 は egress を
 * 「NAT ゲートウェイの無い VPC サブネット」で塞ぐつもりだったが、**塞げない**ことが
 * 分かった（VPC の Route 53 Resolver は再帰解決を行い、AWS 明文でセキュリティグループ
 * でも NACL でも遮断できない）。そのうえ VPC は封じ込めを 3 か所で悪化させる
 * （DNS の持ち出しチャネル / 実行ロールに付く EC2 権限が関数のコードにも暗黙に
 * 付与される / **14 日アイドルで ENI が回収され最初の呼び出しが必ず失敗する**）。
 * **部分的な遮断のために確実に発生する 3 つの悪化を買うのは釣り合わない**（7.1）。
 *
 * ここに vpc_config を足すことは、その 3 つを買い直すことである。
 *
 * ## Control Tower 配下であることの留意
 *
 * このアカウントは Control Tower の member であり、SCP が Lambda / ECR / IAM の一部
 * 操作を拒否しうる。**apply が AccessDenied で落ちたときは、権限不足ではなく SCP を
 * 先に疑うこと**（terraform/bedrock-guard.tf と同じ注記）。
 */

locals {
  # 関数名はロググループ名にも入る（/aws/lambda/<name> が固定の綴り）。2 か所へ書くと
  # 片方だけ変えたときにログが別の場所へ出るので、1 か所から導く（bedrock-guard.tf と同じ）。
  build_function_name = "game-forge-build"

  # ECR のリポジトリ名。ワークフロー（.github/workflows/deploy-compiler.yml）は
  # この値を terraform output から取る。**綴りをワークフローへ書き写さない。**
  build_repository_name = "game-forge/isolated-build"

  /**
   * メモリとタイムアウト（3.8 がそのまま正本）。
   *
   * **3,538 MB は「2 vCPU 相当」を買うための値である。** Lambda の vCPU はメモリに
   * 比例し、7.1 が当初書いていた `--cpus=1` 相当では実測 11.3 秒で 10 秒に収まらない。
   * 3,538 MB で実測 5.3 秒（#76）。**512 MB では 2 vCPU を得られない**ため、
   * ローカルの `--memory=512m` はここでは採らない。
   *
   * **ただし 3,538 は宣言できない。このアカウントの Lambda メモリ上限が 3,008 MB
   * だからである**（#103 の初回 apply で判明。`CreateFunction` が
   * `'MemorySize' value failed to satisfy constraint: Member must have value less
   * than or equal to 3008` で 400 を返す）。10,240 MB まで使える既定のアカウントと、
   * 3,008 MB で据え置かれるアカウントがあり、後者だった。
   *
   * **この上限は Service Quotas から引き上げられない。** `service-quotas
   * list-service-quotas --service-code lambda` にメモリの項目自体が無く
   * （`L-548AE339` は `NoSuchResourceException`）、経路は AWS Support のケースに
   * なる。上の 3,538 は「2 vCPU ちょうど」を狙った値なので、3,008 は
   * 3008/1769 = **1.70 vCPU 相当**であり、2 vCPU に対して約 15% 遅くなる。
   *
   * **それでも 3,008 で進める。** 10 秒の前提を確定させるのは Lambda 上の実測で
   * あり、実測には関数が存在する必要がある。ローカルの 5.4 秒を 1.70/2.00 で割り
   * 戻すと約 6.4 秒で、10 秒には収まる見込みである。実測がこれを裏切ったときに
   * 初めて Support のケースを起こす（引き上げの待ち時間を、要否が判る前に払わない）。
   */
  build_function_memory_mb       = 3008
  build_function_timeout_seconds = 10

  /**
   * エフェメラルストレージ（`/tmp`）。
   *
   * **本番で書き込めるのはここだけである。** ローカルの 3 領域（tmpfs `/tmp` 512m /
   * tmpfs `/work` 256m / volume `/cache`）が 1 つへ潰れる（7.1 の「受け入れた劣化」
   * 2 点目）。したがって、テンプレートの複製・GOCACHE・GOTMPDIR・未圧縮 wasm・
   * 圧縮後の成果物がすべてここへ載る。
   *
   * **実測は 1 回のビルドで 103 MB である**（#103。Ebitengine のサンプル。内訳は
   * テンプレートの複製 21 MB ＋ GOCACHE ＋ 未圧縮 wasm 11 MB ＋ .br 2 MB）。
   * 最小値の 512 MB でも足りるが、**1,024 MB を選ぶ。**
   *
   * 512 MB を超える分の課金は $0.0000000309/GB-秒 で、月 500 ビルド × 5.4 秒の
   * 想定では **月 $0.00004**（4.6 の関数の変動費 ¥24 に対して桁が 4 つ小さい）。
   * **実質ゼロで 10 倍の余裕が買えるなら買う。** ここが足りないと `go build` は
   * `no space left on device` で落ち、原因がビルドエラーと区別しづらい。
   *
   * **ハンドラが毎回 `/tmp` を空にする**ので、呼び出しをまたいで積み上がることは無い。
   */
  build_function_ephemeral_storage_mb = 1024

  /**
   * 予約同時実行数（3.8 の「Worker Pool による並列数制限」の Lambda での対応物）。
   *
   * **予約は上限であると同時に下限でもある。** この関数は最大 5 並列までしか走らず、
   * 同時に、他の関数がアカウントの同時実行枠を食い尽くしても 5 は確保される。
   *
   * 5 にした理由は 2 つある。
   *
   *   - **招待制クローズドβの規模で足りる。** 3.3-5 は同期呼び出しで、1 人の利用者は
   *     同時に 1 本しかビルドを待たない。数十人の母数で 5 本同時が埋まる場面は稀である。
   *   - **暴走の上限を金額で押さえられる。** 4.3 の費用ガードは Bedrock しか見ておらず、
   *     **ビルド関数の暴走はどの層にも捕まらない。** 5 並列 × 3,538 MB を 1 時間
   *     回し続けても約 $1 で、月次上限（4.3）に対して無視できる大きさに収まる。
   *     ここを未設定（＝アカウント既定の 1,000）にすると、この性質が消える。
   */
  build_function_reserved_concurrency = 5

  /**
   * brotli の品質（3.3-6 / 3.4-1）。**実測に基づいて q11 から下げた値である。**
   *
   * 7.1 の「実測なし」の表は brotli q11 の圧縮時間を未検証のまま残していた。
   * #103 で測ったところ、**3.8 の 10 秒に収まらない**ことが分かった。
   *
   * | 品質 | ビルド | 圧縮 | **合計** | 圧縮後 | 3.8 の 10 秒 |
   * |---|---|---|---|---|---|
   * | q11 | 4,785 ms | **12,148 ms** | **16,960 ms** | 1,985,786 B | **収まらない** |
   * | q10 | 4,770 ms | 6,425 ms | **11,219 ms** | 2,091,967 B | **収まらない** |
   * | **q9** | 4,797 ms | **539 ms** | **5,359 ms** | 2,282,839 B | **収まる** |
   *
   * 対象は Ebitengine のサンプル（未圧縮 11,404,411 B）。lgwin=24。**このイメージを
   * 本番と同じ CPU / メモリ配分（`--cpus=2 --memory=3538m`）で回した実測**であり、
   * ビルド側が 3.8 の 5.3 秒とほぼ一致することが、測定の較正になっている。
   * q11 の 1,985,786 B は #76 が記録した 1,987,011 B とほぼ同値で、
   * **7.1 が「未実測」としていたのがこの q11 の 12.1 秒である。**
   *
   * **q9 と q10 の間に段差がある。** brotli は q10 以上で後方参照の探索を
   * 総当たりに近い方式へ切り替えるため、時間が 1 桁変わる。**q9 が買う代償は
   * 圧縮後サイズの +14.6%（+291 KB）だけ**で、3.4 が定める「圧縮後 2〜3MB」の
   * 範囲に収まり続ける。
   *
   * **この値は関数の環境変数として渡す。** ハンドラは既定値を持たない
   * （docker/isolated-build/handler/main.go）。どの品質で配っているかを、
   * タイムアウトと同じ場所で読めるようにするためである。
   */
  build_brotli_quality = 9

  /**
   * R2 の資格情報を置く SSM Parameter Store のパラメータ名。
   *
   * **値そのものはこの宣言が持たない**（下の「R2 の資格情報」）。ここが持つのは
   * 「どこを見に行くか」だけで、これは秘密ではない。
   */
  r2_credentials_parameter_name = "/game-forge/prod/r2-credentials"

  /**
   * 実行ロールへ与える動作の一覧。
   *
   * **ポリシー文書と output の両方がこの 1 つの定義から作られる。** 外部層の検査
   * （scripts/acceptance-remote.sh）は「最小限であること」をここから取った期待値と
   * 突き合わせる。検査へ動作名を書き写すと、宣言へ 1 つ足したときに検査だけが
   * 古い一覧を見続ける（共通規範 12 章。terraform/bedrock.tf の
   * local.bedrock_invoke_actions と同じ形）。
   */
  build_role_log_actions = [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]
  build_role_ssm_actions = ["ssm:GetParameter"]
  build_role_kms_actions = ["kms:Decrypt"]
  build_role_actions = sort(concat(
    local.build_role_log_actions,
    local.build_role_ssm_actions,
    local.build_role_kms_actions,
  ))

  build_function_tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Build Go/Ebitengine wasm in isolation - spec 3.8 and 7.1 / issue 103"
  }
}

# ── ECR ─────────────────────────────────────────────────────────────────────

/**
 * ビルド関数のイメージを置くリポジトリ。
 *
 * **タグは可変にする。** 9.3 は「配備の対象はイメージのダイジェストである」と定めるが、
 * それは**どのダイジェストが載っているかを追えること**の要求であって、タグを固定する
 * 要求ではない。ワークフローは `latest` と commit SHA の 2 つを打ち、関数へは
 * **ダイジェストで**渡す。IMMUTABLE にすると `latest` の打ち直しができなくなる。
 *
 * scan_on_push を有効にするのは、ベースイメージが `golang:1.26.5` に固定されており
 * （確定12 / 3.5）、**放っておくと古くなる**ためである。3.5 の更新手順を回す契機を
 * 人の記憶に置かない。
 */
resource "aws_ecr_repository" "isolated_build" {
  name                 = local.build_repository_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  # 中身の入ったリポジトリを取り違えて消さない。意図した削除は、この設定を外す
  # 明示的な変更を伴わせる（terraform/README.md の prevent_destroy と同じ考え方）。
  force_delete = false

  tags = local.build_function_tags
}

/**
 * 古いイメージを捨てる。
 *
 * **1 イメージが 1.51 GB ある**（3.8 の実測）。ECR は $0.10/GB-月 なので、
 * 溜めると保存料が 4.6 の試算（関数の変動費 月約 ¥24）を上回る。
 *
 * 残す本数を 5 にしたのは、**切り戻し先が要る**ためである。9.3 は関数のイメージを
 * ダイジェストで辿れるようにすると定めており、直前の版が消えていると辿れても戻せない。
 *
 * **untagged を先に消す。** `latest` を打ち直すと、前の `latest` は SHA タグだけが
 * 残る（＝tagged のまま）ので、untagged になるのは打ち直しで参照を失った層である。
 */
resource "aws_ecr_lifecycle_policy" "isolated_build" {
  repository = aws_ecr_repository.isolated_build.name

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
        description  = "Keep the 5 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = { type = "expire" }
      },
    ]
  })
}

/**
 * Lambda がイメージを取得できるようにする。
 *
 * **同一アカウントでも明示する。** コンソールから関数を作ると AWS がこのポリシーを
 * 裏で付けるが、宣言から作る経路にはその補助が無い。付いていないと
 * `CreateFunction` が `The provided source image ... is not accessible` で落ちる。
 *
 * **source_arn でこの関数 1 つに絞る。** ARN はリソース参照ではなく文字列で組み立てる。
 * 参照にすると「リポジトリポリシー → 関数 → リポジトリ」の循環になる。
 */
data "aws_iam_policy_document" "isolated_build_ecr" {
  statement {
    sid    = "AllowLambdaToPullTheBuildImage"
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
      values   = ["arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.prod.account_id}:function:${local.build_function_name}"]
    }
  }
}

resource "aws_ecr_repository_policy" "isolated_build" {
  repository = aws_ecr_repository.isolated_build.name
  policy     = data.aws_iam_policy_document.isolated_build_ecr.json
}

# ── ロググループ ────────────────────────────────────────────────────────────

/**
 * ビルド関数のログ出力先。
 *
 * 宣言する理由は bedrock-guard.tf と同じである。**保持期間を決めるため**（Lambda が
 * 自動で作るロググループは無期限保持）と、**実行ロールへ logs:CreateLogGroup を
 * 与えずに済むため**（作成権限を渡さなければ、関数が書ける先はこの 1 本に限られる）。
 *
 * 14 日にしたのは、失敗したビルドの調査が数日のうちに終わるためである。3.7 が
 * 未公開成果物を 14 日で捨てるのと同じ幅に揃えてある（調査対象の成果物が消えたあとに
 * ログだけ残っても、突き合わせる相手がいない）。
 *
 * **ログに生成ソースも成果物も出さない**（ハンドラの logResult）。攻撃者が制御しうる
 * 入力（7.1）を、保持期間のあいだ残る場所へ複製する理由が無い。
 */
resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/lambda/${local.build_function_name}"
  retention_in_days = 14

  tags = local.build_function_tags
}

# ── 実行ロール ──────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "build_assume" {
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
 * ビルド関数の実行ロール。**与えるのは 2 つだけである。**
 *
 *   1. 宣言済みのロググループ 1 本への書き込み（CreateLogGroup は与えない）
 *   2. R2 の資格情報 1 つの読み取りと、その復号
 *
 * **この関数は攻撃者が制御しうるコードをコンパイルする**（7.1）。ロールに付いた権限は
 * 実質そのコードの権限だと考えて絞る。AWS 自身、VPC を使う関数について
 * 「実行ロールの EC2 権限は関数のコードにも暗黙に付与される」と明文で書いており、
 * **VPC を採らなかった理由の 1 つがそれである**（確定24 / v1.11）。
 *
 * **AWSLambdaBasicExecutionRole は付けない。** あれは `logs:CreateLogGroup` を含み、
 * 書ける先を `*` に広げる。上の 1 と噛み合わない。
 *
 * ECR の取得権限は**実行ロールには要らない**。イメージを引くのは Lambda サービス側で、
 * 許可はリポジトリポリシー（上）が与える。
 */
data "aws_iam_policy_document" "build" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions   = local.build_role_log_actions
    resources = ["${aws_cloudwatch_log_group.build.arn}:*"]
  }

  statement {
    sid       = "ReadR2Credentials"
    effect    = "Allow"
    actions   = local.build_role_ssm_actions
    resources = [local.r2_credentials_parameter_arn]
  }

  /**
   * SecureString の復号。
   *
   * **鍵を ARN で名指ししない。** `alias/aws/ssm`（AWS 管理鍵）は、そのアカウントで
   * 最初の SecureString が作られるまで存在しない。data ソースで引くと、
   * **まだ何も置いていないアカウントでは plan の段階で落ちる。**
   *
   * 代わりに 2 つの条件で絞る。SSM 経由であること（kms:ViaService）と、
   * **暗号化コンテキストがこのパラメータであること**（kms:EncryptionContext:PARAMETER_ARN）。
   * 後者があるため、鍵側を `key/*` にしてもこのパラメータ以外は復号できない。
   */
  statement {
    sid       = "DecryptR2Credentials"
    effect    = "Allow"
    actions   = local.build_role_kms_actions
    resources = ["arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.prod.account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.r2_credentials_parameter_arn]
    }
  }
}

locals {
  # パラメータ名は先頭が "/" なので、ARN の組み立てで区切りを重ねない。
  r2_credentials_parameter_arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.prod.account_id}:parameter${local.r2_credentials_parameter_name}"
}

resource "aws_iam_role" "build" {
  name               = local.build_function_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.build_assume.json

  tags = merge(local.build_function_tags, {
    Purpose = "Execution role for the build function - spec 3.8 / issue 103"
  })
}

resource "aws_iam_role_policy" "build" {
  name   = "build-function"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}

# ── 関数本体 ────────────────────────────────────────────────────────────────

/**
 * ビルド関数（3.3-5 / 3.3-6 / 3.8）。
 *
 * ## イメージは宣言が持たない
 *
 * `image_uri` を ignore_changes に入れてある。**配るのは CI である**
 * （.github/workflows/deploy-compiler.yml が `update-function-code --image-uri` を
 * 叩く。9.3）。宣言側が固定の URI を持つと、**配備のたびに terraform plan へ差分が
 * 出る。** 受け入れ条件の「plan が差分なし」が、配備が正常に動いているときにこそ
 * 落ちることになり、乖離の検知として役に立たなくなる。
 *
 * ここが持つのは**初回作成時の値**だけである。9.3 の「どのイメージが載っているか」は、
 * 宣言ではなく外部層の検査（scripts/acceptance-remote.sh）が ECR のダイジェストと
 * 突き合わせて担保する。
 *
 * ## 適用の順序
 *
 * **イメージが 1 つも無い ECR に対しては、この関数を作れない。** 初回だけは
 * 「ECR を作る → イメージを push する → 関数を作る」の順になる（docs/build-function.md）。
 *
 * ## R2 の資格情報
 *
 * 環境変数として渡すのは**パラメータ名だけ**で、値は渡さない。関数が起動時に
 * SSM から読む（実装は #21）。理由は下の output と docs/build-function.md にある。
 *
 * ## architectures
 *
 * x86_64 を明示する。**イメージのアーキテクチャと一致していないと関数は起動しない。**
 * ワークフローが走るのは `ubuntu-latest`（x86_64）なので、既定に頼らずここで固定して
 * おく。arm64（Graviton）は 20% 安いが、**ビルド時間の実測がまだ無い**（7.1 の
 * 「実測なし」）。速度が要件（10 秒）に直結する以上、未実測の側へは寄せない。
 */
resource "aws_lambda_function" "build" {
  function_name = local.build_function_name
  role          = aws_iam_role.build.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.isolated_build.repository_url}:latest"
  architectures = ["x86_64"]

  memory_size = local.build_function_memory_mb
  timeout     = local.build_function_timeout_seconds

  ephemeral_storage {
    size = local.build_function_ephemeral_storage_mb
  }

  reserved_concurrent_executions = local.build_function_reserved_concurrency

  environment {
    variables = {
      # 圧縮の品質を宣言側が持つ（上の local の表）。ハンドラは既定値を持たず、
      # 未設定なら起動しない。「宣言を見ずに品質が決まる」経路を作らないため。
      BROTLI_QUALITY = tostring(local.build_brotli_quality)
      # 資格情報の**置き場所**。値ではない。
      R2_CREDENTIALS_PARAMETER = local.r2_credentials_parameter_name
    }
  }

  lifecycle {
    # 上の「イメージは宣言が持たない」を参照。
    ignore_changes = [image_uri]
  }

  # ロググループより先に関数が動くと、Lambda が無期限保持のロググループを自分で作り、
  # 宣言側の retention_in_days が効かない状態になる。
  depends_on = [
    aws_cloudwatch_log_group.build,
    aws_iam_role_policy.build,
    aws_ecr_repository_policy.isolated_build,
  ]

  tags = local.build_function_tags
}

# ── Actions から見える値 ────────────────────────────────────────────────────

/**
 * 配備に要る識別子を Actions のリポジトリ変数として置く（9.3）。
 *
 * **ワークフローは terraform output を読めない。** GitHub のランナーに tfstate は
 * 無く、置く経路を作るのは state を配ることと同じである。かといって ARN や
 * リポジトリ URL をワークフローへ直接書くと、宣言を変えたときにワークフローだけが
 * 古い対象を指し続ける（共通規範 12 章）。**宣言から Actions 変数へ流し込むことで、
 * 書き写しを 1 か所も作らずに済ませる。**
 *
 * `github_actions_variable.allowed_author_emails`（main.tf）と同じ形である。
 *
 * **Secrets ではなく Variables に置く。** どれも秘密ではない（ロール ARN は
 * 引き受け条件で守られており、知られること自体は権限にならない）。Secrets にすると
 * 値がログでマスクされ、配備の失敗を追うときに何を指していたのかが読めなくなる。
 */
resource "github_actions_variable" "aws_region" {
  repository    = github_repository.this.name
  variable_name = "AWS_REGION"
  value         = var.aws_region
}

resource "github_actions_variable" "aws_deploy_role_arn" {
  repository    = github_repository.this.name
  variable_name = "AWS_DEPLOY_ROLE_ARN"
  value         = aws_iam_role.deploy_compiler.arn
}

resource "github_actions_variable" "build_image_repository" {
  repository    = github_repository.this.name
  variable_name = "BUILD_IMAGE_REPOSITORY"
  value         = aws_ecr_repository.isolated_build.repository_url
}

resource "github_actions_variable" "build_function_name" {
  repository    = github_repository.this.name
  variable_name = "BUILD_FUNCTION_NAME"
  value         = aws_lambda_function.build.function_name
}
