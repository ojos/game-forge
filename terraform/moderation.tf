/**
 * 入力側モデレーションの宣言（仕様 8.2 / #37）。
 *
 * **`terraform/bedrock-guard.tf` とは別物である。** あちらは費用ガード（4.3 の層 2 と
 * 層 3）で、名前が似ているだけで守っているものが違う。**こちらが守るのは中身**である。
 *
 * ## なぜ宣言で持つのか
 *
 * Guardrail は Prod アカウントの恒久的な外部状態である。共通規範 4 章「恒久的な状態変更は
 * 宣言側を通す」に従う。**コンソールで作ると、閾値を誰がいつ動かしたかが追えない**
 * ——8.2 の初期強度は「ゲームという題材上、暴力だけ他と性質が違う」という判断の産物で、
 * 判断の履歴ごと消える。確定17（DNS）と確定24（ビルド関数）が同じ理由で宣言を選んでいる。
 *
 * ## 値の正本はここである
 *
 * **仕様書 8.2 の表は初期値の意図であって現行値の申告ではない**（確定24 がビルド関数の
 * タイムアウトで採ったのと同じ規約）。現行値はこのファイルにしか無い。**仕様書へ
 * 書き写さないこと。**
 *
 * ## 適用はオーケストレータ側である
 *
 * エッジ（Cloudflare Pages）には Bedrock の資格情報が無い。`BEDROCK_AWS_*` は #160 で
 * Pages のシークレットから削除済みで、エッジで判定するには長命のアクセスキーを戻すことに
 * なる。**Lambda なら IAM ロールで済む。** 許可は `terraform/orchestrator.tf` が持ち、
 * 動作の定義は `terraform/bedrock.tf` の `local.bedrock_invoke_actions` にある
 * （**費用ガードの Deny も同じ定義から作られるので、停止したときはこちらも止まる**）。
 *
 * ## 出力側モデレーションと二重化しない
 *
 * 8.3 の NG ワード検査（`src/denied-terms.ts`）と 6.2 の IP 名の検出
 * （`src/ip-terms.ts`）は**アプリ側が持つ**。Guardrail の `word_policy_config` と
 * `topic_policy_config` は宣言しない。**同じ語彙が 2 か所にあると、片方だけが古くなる。**
 */

locals {
  /**
   * コンテンツフィルタの初期強度（8.2）。
   *
   * **暴力だけ他と性質が違う。** シューティング・格闘・ゾンビものは 2D ゲームの
   * 定番題材で、標準の強度だと正当な題材が構造的に落ちる。**誤検出した利用者は
   * 生成枠を消費しない**（枠は `generations` の行数で数え、遮断はその手前で起きる）が、
   * 作りたいものが作れないことに変わりはない。
   *
   * **プロンプト攻撃だけ高い。** この LLM はシステムプロンプトで import 制限（6.1）と
   * 命名規制（6.2）を掛けており、**そこを外されると検査の前提が崩れる。**
   *
   * 入力側だけに掛ける（`input_strength` のみ）。**出力は 8.3 が持つ**——生成物は
   * Go のソースであって自然文ではなく、コンテンツフィルタの想定外である。
   */
  moderation_filters = {
    VIOLENCE      = "LOW"
    HATE          = "MEDIUM"
    INSULTS       = "MEDIUM"
    SEXUAL        = "MEDIUM"
    MISCONDUCT    = "MEDIUM"
    PROMPT_ATTACK = "HIGH"
  }

  moderation_guardrail_name = "game-forge-input-moderation"
}

/**
 * 入力側モデレーションの Guardrail 本体。
 *
 * ## 遮断時のメッセージをここに書かない
 *
 * `blocked_input_messaging` は **Guardrail 自身が返す文言**だが、**利用者へ出るのは
 * これではない。** 8.2 は「カテゴリ名までを返し、検出箇所・スコア・閾値は返さない」と
 * 定めており、その組み立てはアプリ側（`src/input-moderation.ts`）が持つ。ここは
 * **API が必須にしているので置くだけ**で、画面へは出ない。値を変えても表示は変わらない。
 *
 * ## バージョンを固定しない
 *
 * `aws_bedrock_guardrail_version` を宣言し、**オーケストレータはそのバージョンを使う。**
 * `DRAFT` を使うと、宣言を書き換えた瞬間に本番の挙動が変わる——**apply と配備が同じ
 * 瞬間になる**ということで、`terraform/orchestrator.tf` が「コードは宣言が持たない」で
 * 避けているものと同じ形になる。
 */
resource "aws_bedrock_guardrail" "input_moderation" {
  name                      = local.moderation_guardrail_name
  description               = "仕様 8.2 の入力側モデレーション。適用はオーケストレータ Lambda。"
  blocked_input_messaging   = "この内容では生成できません。"
  blocked_outputs_messaging = "この内容では生成できません。"

  content_policy_config {
    dynamic "filters_config" {
      for_each = local.moderation_filters

      content {
        type = filters_config.key
        # **入力側だけに掛ける**（上記）。出力は 8.3 が持つ。
        input_strength = filters_config.value
        # `PROMPT_ATTACK` は出力側の強度を受け付けない（AWS の制約）。NONE で揃える。
        output_strength = "NONE"
      }
    }
  }
}

/**
 * オーケストレータが使うバージョン。
 *
 * **`DRAFT` を呼ばせない**（上記）。宣言を書き換えると新しいバージョンが作られ、
 * `terraform apply` を通ったものだけが本番へ出る。
 */
resource "aws_bedrock_guardrail_version" "input_moderation" {
  guardrail_arn = aws_bedrock_guardrail.input_moderation.guardrail_arn
  description   = "terraform apply が作る版。オーケストレータはこれを使う。"

  lifecycle {
    # 中身を変えたら新しい版を作ってから古い版を捨てる（呼び出し中の版を先に消さない）。
    create_before_destroy = true
  }
}

output "moderation_guardrail_id" {
  description = <<-EOT
    入力側モデレーションの Guardrail id（8.2 / #37）。

    オーケストレータの環境変数へ渡る。**外部層の検査がここから期待値を取る**ので、
    id を別の場所へ書き写さない。
  EOT
  value       = aws_bedrock_guardrail.input_moderation.guardrail_id
}

output "moderation_guardrail_version" {
  description = "オーケストレータが使う Guardrail のバージョン（DRAFT ではない）。"
  value       = aws_bedrock_guardrail_version.input_moderation.version
}
