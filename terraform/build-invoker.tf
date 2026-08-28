/**
 * Workers（Cloudflare Pages Functions）がビルド関数を呼ぶためのプリンシパル
 * （仕様 3.3-5 / 4.1 / 9.2 / 確定24。#115）。
 *
 * **器（関数・ECR・実行ロール）は terraform/build-function.tf が持つ。** ここが持つのは
 * **呼び出し側**の principal である。文書側の分担（docs/build-function.md が器、
 * docs/build-invocation.md が呼び出し側）と同じ線で分けてある。
 *
 * ## この宣言が持つ範囲
 *
 * | 対象 | 持ち主 |
 * |---|---|
 * | Workers から呼ぶための IAM ユーザーとポリシー | この宣言 |
 * | アクセスキーの実体 | **この宣言は持たない**（下記。docs/build-invocation.md） |
 * | ビルド関数・ECR・実行ロール・ロググループ | terraform/build-function.tf |
 * | Bedrock を呼ぶための IAM ユーザー | terraform/bedrock.tf |
 *
 * ## Bedrock 用と分ける理由
 *
 * **権限が違う。** `terraform/bedrock.tf` の `game-forge-bedrock-invoker` は
 * `bedrock:InvokeModel` 系だけを許しており、`lambda:InvokeFunction` を通せない。
 * 1 つのユーザーへ両方を持たせれば鍵は 1 本で済むが、**そのとき鍵 1 本の漏洩で
 * 生成とビルドの両方が同時に開く。** 最小権限を保つなら principal ごと分かれる
 * （docs/build-invocation.md 3 章 / .dev.vars.example の `BUILD_` 接頭辞）。
 *
 * 秘密の名前も `BEDROCK_AWS_*` と `BUILD_AWS_*` に分かれている（正本は
 * `src/build-client.ts` の `BUILD_SECRET_NAMES`）。**principal を 1 つにすると、
 * 名前だけが分かれていて実体が同じ、という一番読み違えやすい形になる。**
 *
 * ## IAM ロールではなくユーザーにする理由
 *
 * **Workers が AWS の外で動くためである**（仕様 4.1 / 9.2）。ロールを引き受ける経路
 * （インスタンスプロファイル、IRSA、OIDC フェデレーション）がどれも使えず、長命の
 * アクセスキーを Pages のシークレットへ置くことになる。`terraform/bedrock.tf` の
 * `bedrock_invoker` と同じ制約で、同じ形にしてある。
 *
 * **長命キーの唯一の対処はローテーションである。** 手順は
 * docs/build-invocation.md 3 章が持つ。
 *
 * ## アクセスキーを宣言しない理由
 *
 * `aws_iam_access_key` は生成した秘密鍵を **tfstate へ平文で書く。** tfstate は
 * `.gitignore` で追跡から外しているが、ディスク上は平文である。`providers.tf` が
 * 「資格情報を Terraform 変数として受け取ると tfstate や plan ファイルへ平文で落ちる
 * 経路ができる」として避けているのと同じ経路を、出力側に作ることになる。R2 の資格情報を
 * `aws_ssm_parameter` で宣言しない理由（docs/build-function.md）とも同じである。
 *
 * **「宣言していないこと」そのものが要件なので、機械で押さえる。**
 * `scripts/acceptance-remote.sh` の `build invoker permissions are minimal` が、
 * tfstate に `aws_iam_access_key` が 1 件も無いことを見る。
 *
 * ## Control Tower 配下であることの留意
 *
 * このアカウントは Control Tower の member であり、SCP が IAM の一部操作を拒否しうる。
 * **apply が AccessDenied で落ちたときは、権限不足ではなく SCP を先に疑うこと**
 * （terraform/bedrock-guard.tf / terraform/build-function.tf と同じ注記）。
 */

locals {
  /**
   * ビルド関数を呼ぶために要る動作。
   *
   * **許可（下記のポリシー）と外部層の検査の期待値（outputs.tf 経由）が、この 1 つの
   * 定義から作られる。** 2 か所へ書き写すと、宣言を変えたときに検査だけが古い期待値を
   * 見続ける（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
   *
   * **`lambda:*` を与えない。** それは `UpdateFunctionCode` を含み、**攻撃者が
   * 制御しうるコードをコンパイルする関数**（7.1）の中身を鍵 1 本で差し替えられる、
   * ということである。配備は OIDC のロール（terraform/github-oidc.tf）が持つ。
   */
  build_invoke_actions = [
    "lambda:InvokeFunction",
  ]

  /**
   * 許す対象。**`*` にしない**（仕様 9.2。このアカウントには他の関数も置きうる）。
   *
   * ARN は文字列で組み立てず関数を参照する。組み立てると、関数名やリージョンを
   * 変えたときにポリシーだけが古い ARN を指す。`build-function.tf` の ECR
   * リポジトリポリシーが文字列で組み立てているのは循環参照を避けるためで、
   * ここにはその制約が無い。
   *
   * **バージョン・エイリアスの ARN（`...:function:name:qualifier`）は含まない。**
   * 呼び出し側（src/build-client.ts）は修飾なしの関数名で呼ぶ。修飾付きを許すと、
   * 公開済みの古いバージョンを名指しで叩ける経路が増える。
   */
  build_invoke_resources = [
    aws_lambda_function.build.arn,
  ]
}

resource "aws_iam_user" "build_invoker" {
  name = "game-forge-build-invoker"
  path = "/service/"

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    # IAM のタグ値は [\p{L}\p{Z}\p{N}_.:/=+\-@] しか使えない。全角括弧と # は
    # この集合に無く、ValidationError になる（terraform/bedrock.tf の実測）。
    Purpose = "Invoke the build function from Cloudflare Pages Functions - spec 3.3-5 and 4.1 / issue 115"
  }
}

/**
 * 呼び出しに要る最小の権限（docs/build-invocation.md 3 章のポリシーそのもの）。
 *
 * 動作 1 つ・対象 1 つだけである。ログの読み取り（`logs:FilterLogEvents`）も
 * 関数の情報取得（`lambda:GetFunction`）も与えない。**Workers は呼ぶだけで、
 * 失敗の手掛かりは応答の `x-amzn-RequestId` から辿る**（docs/build-invocation.md 5 章）。
 */
data "aws_iam_policy_document" "build_invoke" {
  statement {
    sid    = "InvokeBuildFunction"
    effect = "Allow"

    actions   = local.build_invoke_actions
    resources = local.build_invoke_resources
  }
}

resource "aws_iam_user_policy" "build_invoke" {
  name   = "build-invoke"
  user   = aws_iam_user.build_invoker.name
  policy = data.aws_iam_policy_document.build_invoke.json
}
