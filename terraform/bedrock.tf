/**
 * Amazon Bedrock の宣言（確定19 / 9.2 / #82）。
 *
 * v1.0 で LLM の接続先を Bedrock にしたため、モデルアクセスと呼び出し用の権限が
 * Prod アカウントの恒久的な外部状態になる。共通規範「外部サービスの状態管理」は
 * UI やアドホックな CLI での直接作成を恒久的な変更手段にしないことを求めるので、
 * ここで宣言する。
 *
 * ## この宣言が持つ範囲
 *
 * | 対象 | 持ち主 |
 * |---|---|
 * | モデルアクセス（agreement の承諾） | この宣言 |
 * | Workers から呼ぶための IAM ユーザーとポリシー | この宣言 |
 * | アクセスキーの実体 | **この宣言は持たない**（下記） |
 * | 費用ガードの層 2（暴走検知）と層 3（Budgets） | **terraform/bedrock-guard.tf**（#82） |
 * | Bedrock のレートクォータ引き下げ（層 4） | **この宣言は持たない**（Service Quotas に引き下げ API が無い） |
 *
 * ## アクセスキーを宣言しない理由
 *
 * aws_iam_access_key は生成した秘密鍵を **tfstate へ平文で書く。** tfstate は
 * .gitignore で追跡から外しているが、ディスク上は平文である。providers.tf が
 * 「資格情報を Terraform 変数として受け取ると tfstate や plan ファイルへ平文で
 * 落ちる経路ができる」として避けているのと同じ経路を、出力側に作ることになる。
 *
 * キーの発行とローテーションは docs/bedrock-access.md が持つ。宣言できない範囲だけを
 * 文書が持つ形は docs/gcp-oauth-setup.md と同じである。
 *
 * ## DeepSeek を宣言していない理由
 *
 * deepseek.v3.2 は agreement を要求しない（`Agreement not supported for this model`）。
 * 宣言する対象そのものが無く、Prod では既に呼び出せることを実測で確認している。
 */

locals {
  # agreement を承諾しておくモデル。**呼び出しの条件ではない**（上記）。
  # 現在は Sonnet 5 が開放されたときに備えた分だけである。
  bedrock_agreement_models = toset([
    "anthropic.claude-sonnet-5",
  ])

  /**
   * 生成に要る Bedrock の動作。**許可（下記）と停止用の Deny（bedrock-guard.tf）の
   * 両方が、この 1 つの定義から作られる。**
   *
   * 2 か所へ書き写すと、許可へ動作を足したときに Deny 側が古いままになり、
   * **費用ガードが発火しても足した動作だけが素通りする**（共通規範 12 章
   * 「一覧の複製は機械照合で担保する」。ここは複製しないことで担保する）。
   *
   * 外部層の検査（scripts/acceptance-remote.sh）も、期待値をここから
   * output 経由で取る。
   */
  bedrock_invoke_actions = [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Converse",
    "bedrock:ConverseStream",
  ]
}

/**
 * 承諾する offer を引く。
 *
 * offer_token をハードコードしないための経路である。トークンは不透明な文字列で、
 * 宣言へ書き写すと発行し直されたときに追随できない。
 */
data "aws_bedrock_foundation_model_agreement_offers" "generation" {
  for_each = local.bedrock_agreement_models

  model_id = each.value
}

/**
 * モデルアクセス（agreement）の承諾。
 *
 * **これは呼び出しの条件ではない**（実測で判明。仕様 1.2.9）。agreement 未承諾の
 * jp.anthropic.claude-sonnet-4-6 は動き、承諾済みの claude-sonnet-5 は動かない。
 * 呼び出しの可否を決めるのは、そのモデルがアカウントに開放されているかである。
 *
 * **それでも残す理由。** 承諾済みの状態は無害で、費用も発生しない。Sonnet 5 が開放された
 * 時点で前提が揃っている方が早い。取り消すと再承諾に 1 分強かかるだけで、得るものが無い。
 *
 * **生成に使うモデル（確定5 の Sonnet 4.6 と DeepSeek）は、どちらも agreement を
 * 必要としない。** ここにあるのは Sonnet 5 の分だけである。
 */
resource "aws_bedrock_foundation_model_agreement" "generation" {
  for_each = local.bedrock_agreement_models

  model_id    = each.value
  offer_token = data.aws_bedrock_foundation_model_agreement_offers.generation[each.key].offers[0].offer_token

  lifecycle {
    # **offer_token は読むたびに変わる。** データソースが返すのは「この offer を承諾する
    # ための一度きりの資格情報」で、同じ offer に対しても呼び出しごとに別の値が発行される
    # （実測）。無視しないと plan が毎回 replace を出し、承諾済みの agreement を破棄して
    # 作り直す差分が残り続ける。#82 の受け入れ条件「terraform plan が差分なし」を
    # 満たせなくなる。
    #
    # 承諾が済んだ後の状態を決めるのは model_id であって token ではない。**token の
    # 変化は外部状態の変化を意味しない**ので、無視してよい。offer そのものを差し替える
    # 必要が出たときは、リソースを destroy して作り直す。
    ignore_changes = [offer_token]
  }
}

/**
 * Workers（Cloudflare Pages Functions）から Bedrock を呼ぶためのプリンシパル。
 *
 * IAM ロールではなくユーザーにするのは、**Workers が AWS の外で動くため**である。
 * ロールを引き受ける経路（インスタンスプロファイル、IRSA、OIDC フェデレーション）が
 * どれも使えず、長命のアクセスキーを Pages のシークレットへ置くことになる
 * （仕様 4.1）。これは直販の API キー 1 本より鍵管理として劣化しており、
 * ローテーション手順で受ける（docs/bedrock-access.md）。
 */
resource "aws_iam_user" "bedrock_invoker" {
  name = "game-forge-bedrock-invoker"
  path = "/service/"

  tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    # IAM のタグ値は [\p{L}\p{Z}\p{N}_.:/=+\-@] しか使えない。全角括弧と # は
    # この集合に無く、ValidationError になる（実測）。理由の詳細は上のコメントに置く。
    Purpose = "Invoke Bedrock from Cloudflare Pages Functions - spec 4.1 / issue 82"
  }
}

/**
 * 呼び出しに要る最小の権限。
 *
 * bedrock:* を与えない。モデルアクセスの変更（agreement の承諾・解除）やクォータの
 * 変更まで許すと、アプリの鍵が漏れたときに費用ガードそのものを外せてしまう。
 *
 * resource を全モデルに開いているのは、確定5 が複数モデル構成であり、モデルを
 * 足すたびにポリシーを直す運用にすると追随漏れが起きるためである。**費用の上限は
 * ここではなく 4.3 の機構で担保する**（#81）。
 */
data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid    = "InvokeGenerationModels"
    effect = "Allow"

    actions = local.bedrock_invoke_actions

    resources = ["*"]
  }
}

resource "aws_iam_user_policy" "bedrock_invoke" {
  name   = "bedrock-invoke"
  user   = aws_iam_user.bedrock_invoker.name
  policy = data.aws_iam_policy_document.bedrock_invoke.json
}

/**
 * 開発アカウント側の Bedrock（#82）。
 *
 * prod と同じ agreement を承諾する。**開発の実験を本番の枠に混ぜないため**であり、
 * 仕様 4.3 が「混ぜると判定基準が壊れる」としている要件に対応する。
 *
 * IAM ユーザーは置かない。開発では SSO の一時資格情報を `.dev.vars` へ転記して使う
 * （docs/local-dev.md）。長命キーが要るのは Workers が動く本番だけである。
 *
 * **アカウントで分ける根拠は 9.2 / 確定21（v1.1）にある。** Bedrock のクォータは
 * アカウント単位でしか割れず、4.3 の最外周で即時に効く唯一の層がそこにある。
 */
data "aws_bedrock_foundation_model_agreement_offers" "generation_dev" {
  provider = aws.dev
  for_each = local.bedrock_agreement_models

  model_id = each.value
}

resource "aws_bedrock_foundation_model_agreement" "generation_dev" {
  provider = aws.dev
  for_each = local.bedrock_agreement_models

  model_id    = each.value
  offer_token = data.aws_bedrock_foundation_model_agreement_offers.generation_dev[each.key].offers[0].offer_token

  lifecycle {
    # prod 側と同じ理由。offer_token は読むたびに変わる。
    ignore_changes = [offer_token]
  }
}
