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
 * | 生成の呼び出し権限 | **terraform/orchestrator.tf**（#160 で実行ロールへ移った。下記） |
 * | 呼び出しに要る動作の定義（`local.bedrock_invoke_actions`） | この宣言 |
 * | 費用ガードの層 2（暴走検知）と層 3（Budgets） | **terraform/bedrock-guard.tf**（#82） |
 * | Bedrock のレートクォータ引き下げ（層 4） | **この宣言は持たない**（Service Quotas に引き下げ API が無い） |
 *
 * ## 長命キーはもう要らない（#160）
 *
 * **エッジが Bedrock を呼ばなくなったので、この用途の長命アクセスキーは無くなった。**
 * 9.2 の「長命キーが要るのは Workers が動く本番だけ」という制約は、実行体を AWS の
 * 中へ移すことで外れる。残っている鍵（`BEDROCK_AWS_*`）は削除する対象であって、
 * ローテーションする対象ではない（docs/orchestrator.md）。
 *
 * v1 の判断（aws_iam_access_key を宣言しない）は**そのまま生きている。** あれは生成した
 * 秘密鍵を tfstate へ平文で書くためで、`terraform/build-invoker.tf` の
 * `BUILD_AWS_*` にはいまも当てはまる。
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
 * Bedrock を呼ぶプリンシパルは、**エッジではなくオーケストレータの実行ロール**である
 * （#160。2026-08-29）。
 *
 * ## 何が変わったか
 *
 * v1 では `game-forge-bedrock-invoker` という IAM **ユーザー**がここにあった。Workers は
 * AWS の外で動き、ロールを引き受ける経路（インスタンスプロファイル、IRSA、OIDC
 * フェデレーション）がどれも使えないため、長命のアクセスキーを Pages のシークレットへ
 * 置くしかなかった（仕様 4.1 / 9.2）。
 *
 * **#160 で生成の実行体が AWS の中へ移り、ロールを引き受けられるようになった。**
 * 許可は `terraform/orchestrator.tf` の `aws_iam_role.orchestrator` に乗っており、
 * **エッジからは `BEDROCK_AWS_*` ごと消える。** 4.3 が最も恐れる「枠を焼ける資格情報」が、
 * いちばん露出の大きい場所から無くなった。
 *
 * ## 動作の定義はここに残す
 *
 * `local.bedrock_invoke_actions` はこのファイルが持ち続ける。**許可（orchestrator.tf）と
 * 停止用の Deny（bedrock-guard.tf）の両方が、この 1 つの定義から作られる**という構造は
 * 変わっていない（下記 local のコメント）。定義をプリンシパルと一緒に動かすと、
 * ガード側が別のファイルを参照することになり、対であることが読みにくくなる。
 *
 * ## ユーザーを消したときにやること
 *
 * **アクセスキーはこの宣言が持っていない**（上記「アクセスキーを宣言しない理由」）。
 * したがって `terraform apply` はユーザーの削除で `DeleteConflict` になる。
 * **鍵の削除と Pages シークレットの削除を先に行うこと**（docs/orchestrator.md
 * 「エッジから Bedrock の資格情報を消す」）。順序を逆にすると、鍵は無効化されて
 * いないのに宣言だけが「もう無い」と言う状態になる。
 */

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
