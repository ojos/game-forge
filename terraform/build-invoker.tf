/**
 * エッジ（Cloudflare Pages Functions）が AWS Lambda を呼ぶための唯一のプリンシパル
 * （仕様 3.3-2.6 / 3.3-5 / 4.1 / 9.2 / 確定24。#115。#160 で対象が移った）。
 *
 * **エッジに残る長命キー（`BUILD_AWS_*`）は 1 組だけで、この IAM ユーザーのものである。**
 * このユーザーが呼べるのは次の 3 関数で、どれも `lambda:InvokeFunction` 1 つを関数 1 つに
 * 限った権限である（docs/build-invocation.md 3 章「プリンシパル」）。
 *
 * | インラインポリシー | 許す対象 | 宣言の場所 |
 * |---|---|---|
 * | `build-invoke` | `game-forge-orchestrator` | **このファイル**（下記） |
 * | `ogp-invoke` | `game-forge-ogp` | terraform/ogp-function.tf |
 * | `avatar-invoke` | `game-forge-avatar` | terraform/avatar-function.tf |
 *
 * **ビルド関数への許可は無い。** ビルド関数を呼ぶのはオーケストレータの実行ロールである
 * （terraform/orchestrator.tf）。器（関数・ECR・実行ロール）は terraform/build-function.tf が
 * 持ち、ここが持つのは**エッジ側の principal** である。文書側の分担（docs/build-function.md が
 * 器、docs/build-invocation.md が呼び出し側）と同じ線で分けてある。
 *
 * ## この宣言が持つ範囲
 *
 * | 対象 | 持ち主 |
 * |---|---|
 * | エッジが Lambda を呼ぶための IAM ユーザー | この宣言 |
 * | オーケストレータの呼び出しを許すポリシー（`build-invoke`） | この宣言 |
 * | OGP / アイコン変換の呼び出しを許すポリシー | 各関数の宣言（上表。関数を消すときに 1 ファイルで閉じるため） |
 * | アクセスキーの実体 | **この宣言は持たない**（下記。docs/build-invocation.md 3 章） |
 * | ビルド関数・ECR・実行ロール・ロググループ | terraform/build-function.tf |
 * | オーケストレータ（#160 で呼び出しの対象になった） | terraform/orchestrator.tf |
 * | Bedrock を呼ぶ権限（#160 で実行ロールへ移った） | terraform/orchestrator.tf |
 *
 * ## Bedrock 用と分けていた理由（#160 で片方が消えた）
 *
 * v1 では `terraform/bedrock.tf` に `game-forge-bedrock-invoker` という別のユーザーが
 * あった。**権限が違い**、1 つのユーザーへ両方を持たせると**鍵 1 本の漏洩で生成と
 * ビルドの両方が同時に開く**ためである（docs/build-invocation.md 3 章）。
 *
 * **#160 で Bedrock 側のユーザーが消えた。** 生成の実行体が AWS の中へ移り、実行ロールで
 * 呼べるようになったからである。エッジに残る長命キーは `BUILD_AWS_*` の 1 組だけで、
 * その 1 組にできるのは「オーケストレータへジョブを 1 回投げること」だけになった。
 * **漏れたときに開くものが、生成とビルドから「ジョブの投入」へ狭まっている。**
 *
 * ## IAM ロールではなくユーザーにする理由
 *
 * **エッジ（Cloudflare Pages Functions）が AWS の外で動くためである**（仕様 4.1 / 9.2）。
 * ロールを引き受ける経路（インスタンスプロファイル、IRSA、OIDC フェデレーション）が
 * どれも使えず、長命のアクセスキーを Pages のシークレットへ置くことになる。
 * **長命キーになるのは構成上の帰結であり、選好ではない**（docs/build-invocation.md 3 章）。
 *
 * **#160 より前は、`terraform/bedrock.tf` の `bedrock_invoker` が同じ制約で同じ形だった。**
 * 今はあちらが消えて、この形はエッジに 1 つだけである。
 *
 * **長命キーの唯一の対処はローテーションである。** 手順は
 * docs/build-invocation.md 3 章「ローテーション」が持つ。
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
   * エッジからオーケストレータを呼ぶために要る動作（#160 より前はビルド関数だった。
   * 名前を `build_invoke_*` のままにしている理由は下の resources のコメントにある）。
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
   * 呼び出し側（src/orchestrator/start-job.ts）は修飾なしの関数名で呼ぶ。修飾付きを
   * 許すと、公開済みの古いバージョンを名指しで叩ける経路が増える。
   *
   * ## #160 で対象がオーケストレータへ移った
   *
   * **エッジはもうビルド関数を直接呼ばない。** 生成の本体（3.3-3..8）がオーケストレータ
   * Lambda の中で走るようになり、ビルド関数を呼ぶのは**あちらの実行ロール**である
   * （terraform/orchestrator.tf）。エッジに残った仕事は「ジョブを 1 回投げること」だけで、
   * 要る許可は lambda:InvokeFunction 1 つのまま、**対象だけが移った。**
   *
   * **鍵を増やしていない。** #160 の積極的な理由は「エッジから長命の AWS 資格情報が
   * 1 組減る」ことである（9.2）。3 組目を作るとその理由が消えるので、BUILD_AWS_* を
   * そのまま使う（src/orchestrator/start-job.ts に、改名しない理由がある）。
   *
   * **ビルド関数への許可を残さない。** 残すと、エッジの鍵 1 本で「攻撃者が制御しうる
   * コードをコンパイルする関数」（7.1）を直接叩ける経路が残る。使わない許可は外す。
   */
  build_invoke_resources = [
    aws_lambda_function.orchestrator.arn,
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
    Purpose = "Invoke the orchestrator / OGP / avatar functions from Cloudflare Pages Functions - spec 3.3-2.6 and 4.1 / issue 115 and 160"
  }
}

/**
 * オーケストレータの呼び出しに要る最小の権限（docs/build-invocation.md 3 章
 * 「プリンシパル」に貼ってあるポリシーそのもの。3 本のうちの 1 本目）。
 *
 * 動作 1 つ・対象 1 つだけである。ログの読み取り（`logs:FilterLogEvents`）も
 * 関数の情報取得（`lambda:GetFunction`）も与えない。**エッジは呼ぶだけで、
 * 失敗の手掛かりは応答の `x-amzn-RequestId` から辿る**（docs/build-invocation.md 5 章）。
 */
data "aws_iam_policy_document" "build_invoke" {
  statement {
    # sid とポリシー名（build-invoke）は #160 より前の綴りのままである。**改名しない。**
    # 実際の対象はオーケストレータで、綴りが指すのは「AWS Lambda を呼ぶ側」である
    # （BUILD_AWS_* を改名しない理由と同じ。src/orchestrator/start-job.ts）。
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
