/**
 * オーケストレータ Lambda の宣言（仕様 3.3 の再配置 / 4.3 / 7.1 / 9.2。#160）。
 *
 * ## 何のためにあるか
 *
 * 生成は 90.9 秒（1.2.38）かかる。**Cloudflare の `ctx.waitUntil()` は応答送信または
 * クライアント切断から 30 秒で打ち切られる**ため、Worker の中では走り切れない。
 * Pages Functions は queue consumer になれず、Durable Object を定義できず、Workflows の
 * binding も持たないので、**Cloudflare 側で解くには例外なく 2 つ目のデプロイ単位が
 * 要る。** 既にある AWS へ寄せたのが A 案である（2026-08-29 の決定）。
 *
 * ## この宣言が持つ範囲
 *
 * | 対象 | 持ち主 |
 * |---|---|
 * | オーケストレータ関数・実行ロール・ロググループ | **この宣言** |
 * | 非同期呼び出しの構成（リトライ 0 / 有効期限 / OnFailure） | **この宣言** |
 * | 失敗の受け皿（SQS） | **この宣言** |
 * | 関数のコード | **この宣言は持たない**（下記。`docs/orchestrator.md`） |
 * | ビルド関数・ECR | `terraform/build-function.tf` |
 * | エッジから呼ぶための IAM ユーザー | `terraform/build-invoker.tf` |
 * | 費用ガードの層 2 / 層 3 | `terraform/bedrock-guard.tf` |
 *
 * ## Bedrock を呼ぶのはこのロールである（#160 の積極的な理由）
 *
 * 9.2 は「長命キーが要るのは Workers が動く本番だけ」とし、Pages のシークレットには
 * **2 組**の長命アクセスキーがあった（`BEDROCK_AWS_*` と `BUILD_AWS_*`）。Workers は
 * AWS の外で動くため IAM ロールを引き受けられないからである。
 *
 * **この関数は AWS の中で動くので、ロールを引き受けられる。** Bedrock の呼び出しが
 * 実行ロールに乗ったことで、`BEDROCK_AWS_*` はエッジから削除できる。4.3 が最も
 * 恐れる「枠を焼ける資格情報」が、いちばん露出の大きい場所から消える。
 *
 * **費用ガードの停止対象も、同時にこのロールへ移した**（`terraform/bedrock-guard.tf`）。
 * 移し忘れると、4.3 の層 2 / 層 3 が発火しても**実際に Bedrock を呼んでいる
 * プリンシパルには何も起きない。** 許可の移動と停止の移動は必ず対で行う。
 *
 * ## ビルド関数は無改造である（7.1）
 *
 * オーケストレータは**生成コードを一度もコンパイルしない。** ビルドは今までどおり
 * `game-forge-build` を同期で呼ぶだけである。**あの関数へ Bedrock の鍵を足さない**の
 * は、あそこが攻撃者が制御しうるコードをコンパイルする唯一の場所であり、7.1 の許容が
 * 「そこから得られるのは R2 の書き込みだけ」という前提の実測に支えられているためで
 * ある。鍵を足すと、`go build` の RCE で得られるものが LLM の枠と作品行の書き換えまで
 * 広がる。
 *
 * ## Control Tower 配下であることの留意
 *
 * このアカウントは Control Tower の member であり、SCP が IAM / Lambda / SQS の一部
 * 操作を拒否しうる。**apply が AccessDenied で落ちたときは、権限不足ではなく SCP を
 * 先に疑うこと**（`terraform/build-function.tf` と同じ注記）。
 */

locals {
  /**
   * 関数名。**`wrangler.toml` の `ORCHESTRATOR_FUNCTION_NAME` がこの写しを持つ。**
   * 宣言を変えたら追随させること（`docs/orchestrator.md`）。
   */
  orchestrator_function_name = "game-forge-orchestrator"

  /**
   * メモリ（MB）。
   *
   * **待ち時間が支配的な関数である。** 91 秒のうちほとんどは Bedrock と
   * ビルド関数の応答待ちで、CPU はほぼ使わない。512 MB で 120 秒動いても
   * 60 GB 秒（約 0.1 円）にとどまり、1 生成あたり約 16 円に対して無視できる。
   *
   * **ビルド関数（3008 MB）と混同しないこと。** あちらは `go build` が回る。
   */
  orchestrator_memory_mb = 512

  /**
   * 見積もりの前提: 生成 1 回にかかる秒数。
   *
   * **実測 90.9 秒（1.2.38）を切り上げた値である。** 短縮は #25 が持つ。
   *
   * **これは平均であって上限ではない。** Bedrock の呼び出しに打ち切りは無く
   * （`src/bedrock.ts`）、上振れはこの下の余裕（`orchestrator_budget_margin_seconds`）
   * が吸収する。**それでも 3 試行ぶんが式に効くので、前提として 1 か所に置く。**
   */
  orchestrator_generation_seconds = 91

  /**
   * 見積もりの余裕（秒）。**最悪ケースの式に現れない時間の置き場所である。**
   *
   *   - Lambda の初期化（コールドスタート）
   *   - コールバック 4 種（`claim` / `cache-lookup` / `ledger` / `finish`）の往復。
   *     ビルドが最悪まで回る依頼では `cache-lookup` だけで 9 往復する
   *   - **生成の上振れ**（上記。91 秒は平均である）
   *
   * **式の値と足して `orchestrator_timeout_seconds` 以下であることを
   * `scripts/check-orchestrator-retry.sh` が機械で見る。**
   */
  orchestrator_budget_margin_seconds = 60

  /**
   * タイムアウト（秒）。**14 分。**
   *
   * # 最悪ケースの式（#174 で引き直した）
   *
   * **数値をここに書かない。** 式の入力はすべて別の場所にあり、合計は
   * `scripts/check-orchestrator-retry.sh` が読み取って計算する。**ここに合計を
   * 書き写すと、入力が変わったときに宣言だけが古い数字のまま緑になる**
   * （それが #174 で起きたことである。shared-ai-rules 12 章）。
   *
   * ```
   * 最悪ケース = 試行回数 × 生成の秒数
   *            + ( 試行回数 × ( 1 + 機械修正の巡回数 ) + 呼び直しの枠 ) × ビルド 1 回の待ち上限
   * ```
   *
   * | 記号 | 正本 |
   * |---|---|
   * | 試行回数 | `src/build-retry.ts` の `MAX_GENERATION_ATTEMPTS`（5.2-7） |
   * | 生成の秒数 | 上の `orchestrator_generation_seconds` |
   * | 機械修正の巡回数 | `src/mechanical-fix.ts` の `MAX_MECHANICAL_FIX_PASSES`（4.2 の 1 段目） |
   * | 呼び直しの枠 | `src/build-client.ts` の `MAX_BUILD_INVOCATIONS_ON_TIMEOUT` − 1（#164 / 1 依頼あたり） |
   * | ビルド 1 回の待ち上限 | `src/build-client.ts` の `BUILD_INVOKE_TIMEOUT_MS`（＝ ビルド関数のタイムアウト ＋ 5 秒） |
   *
   * **1 試行あたりのビルドは 1 ＋ 機械修正の巡回数である**（`src/generate.ts` の
   * `repairAndRebuild`）。#174 以前の見積もりはこれを 2 回と置いていたが、
   * 実際は最初のビルドに加えて**巡回のたびにもう 1 回ずつ**走る。
   *
   * **キャッシュヒット（3.8）は式に現れない。** ヒットすれば関数を呼ばないので、
   * 短くなる方向にしか効かない。最悪ケースは全ミスである。
   *
   * # なぜ 600 秒では足りなかったか
   *
   * **上の式のとおりに数えると、#164 の呼び直しを 1 ビルドごとに許した実装では
   * 1 依頼あたり最大 18 回ビルド関数を呼びうる。** どの値を選んでも Lambda の上限
   * （15 分）に収まらない。**timeout を伸ばして解ける範囲ではなかったので、上流を
   * 絞った**——呼び直しの枠を「1 ビルドあたり」から**「1 依頼あたり」**へ直した
   * （#174。`src/build-client.ts` の `BuildTimeoutBudget`）。これで 1 依頼あたりの
   * 呼び出しは、上の式の `試行回数 ×（1 ＋ 巡回数）＋ 枠` に収まる。
   *
   * **試行回数（3）と機械修正の巡回数（2）は動かさない。** 前者は 5.2-7 の
   * 品質そのもので、減らすと**毎回の生成の成功率**が下がる。後者は費用ゼロで
   * 約 16 円の再生成を避ける段で、2 巡は実測（未使用 12 件 / 診断は 10 件で打ち切り）
   * から出ている。**削ると利用者に見える側が悪くなる。**
   *
   * # なぜ 840 秒か
   *
   * 上下から挟まれている。
   *
   *   - **下**: 最悪ケース ＋ `orchestrator_budget_margin_seconds`。
   *     **溢れると `finish` コールバックが飛ばず、作品行が `running` のまま残る**
   *     （利用者から見ると「終わらない生成」）。**途中で殺されるより、自分で
   *     失敗として終わるほうが良い。**
   *   - **上**: Lambda の実行時間の上限（900 秒）と、`src/work-page.ts` の
   *     `STALE_AFTER_SECONDS`（900 秒）。画面が「中断した可能性」と言い始める前に、
   *     関数は必ず生きているか死んでいるかのどちらかになっている。逆順にすると、
   *     まだ走っている生成を画面が中断と呼ぶ。
   *
   * **伸ばした分の費用は出ない。** Lambda は実行した時間で課金する（`timeout` は
   * 上限であって予約ではない）。伸びるのは「本当に詰まった依頼を殺すまでの時間」
   * だけで、その依頼はどちらにせよ 900 秒で「中断した可能性」と表示される。
   *
   * **3 つの不等式はすべて `scripts/check-orchestrator-retry.sh` が見る。**
   */
  orchestrator_timeout_seconds = 840

  /**
   * 予約同時実行数。
   *
   * **上限としても、下限としても効く。** 上限としては「同時に走る生成の本数」を
   * 決め、4.3 の層 4（Bedrock のレートクォータ引き下げ）を持てない分をここで補う。
   * 下限としては、他の関数のバーストでオーケストレータが枯渇しないことを保証する。
   *
   * **3 にしたのは、ビルド関数の予約（5）を超えないためである。** 1 本のジョブが
   * 同時に使うビルドのスロットは 1 つなので、3 本まで走らせても余る。日次枠は
   * 1 人 12 回（`src/quota.ts` の `DAILY_QUOTA_PER_USER`）で、招待制の規模では
   * 3 本の同時実行が詰まる状況はまだ来ない。
   */
  orchestrator_reserved_concurrency = 3

  /**
   * **基盤のリトライは 0 である。**
   *
   * 5.2-7（`src/build-retry.ts` の `MAX_GENERATION_ATTEMPTS`）が既にビルド診断を
   * 織り込む賢い再試行を最大 3 回持っている。**掛け算にすると、1 回の送信から
   * 最大 9 回・約 144 円・日次枠 9 個が出る。**
   *
   * 既定は 2 なので、**書き忘れると掛け算になる。** 書いてあることを
   * `scripts/check-orchestrator-retry.sh` が機械で押さえる（呼びかけでは守らない。
   * shared-ai-rules 12 章）。
   */
  orchestrator_maximum_retry_attempts = 0

  /**
   * イベントの有効期限（秒）。
   *
   * **既定は 21,600 秒（6 時間）で、これは長すぎる。** スロットルや障害でキューに
   * 残ったイベントが 6 時間後に走ると、利用者はとっくにその生成を忘れており、
   * それでも約 16 円と日次枠 1 個が出る。
   *
   * 300 秒にしたのは、**画面が「中断した可能性」と言い始めるまで（900 秒）に
   * 実行が始まっているか、始まらないと決まっているか**のどちらかにするためである。
   * 期限切れは OnFailure destination へ出るので、黙って消えることはない。
   *
   * 最小値は 60 秒。それより短くはできない。
   */
  orchestrator_maximum_event_age_seconds = 300

  /** 失敗の受け皿（SQS）の名前。 */
  orchestrator_failure_queue_name = "game-forge-orchestrator-failures"

  /**
   * 失敗の受け皿の保持期間（秒）。**14 日**（SQS の上限でもある）。
   *
   * 3.7 が未公開の成果物を 14 日で捨てるのと同じ幅に揃えてある。調査対象の作品行が
   * 消えたあとにメッセージだけ残っても、突き合わせる相手がいない。
   */
  orchestrator_failure_queue_retention_seconds = 1209600

  /**
   * 実行ロールに与える動作。**外部層の検査の期待値でもある**（outputs.tf 経由）。
   *
   * **`local.bedrock_invoke_actions` を書き写さない**（`terraform/bedrock.tf`）。
   * 許可と、費用ガードが付ける Deny は同じ定義から作られる必要がある
   * （shared-ai-rules 12 章）。
   */
  orchestrator_role_log_actions = [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]

  orchestrator_role_actions = sort(concat(
    local.bedrock_invoke_actions,
    ["lambda:InvokeFunction"],
    ["sqs:SendMessage"],
    local.orchestrator_role_log_actions,
  ))

  orchestrator_tags = {
    Project   = "game-forge"
    ManagedBy = "terraform"
    Purpose   = "Run the 91 second generation outside the edge - spec 3.3 / issue 160"
  }
}

# ── 失敗の受け皿（OnFailure destination） ──────────────────────────────────

/**
 * 非同期呼び出しが失敗したときの行き先。
 *
 * ## なぜ要るのか
 *
 * **リトライを 0 にした以上、1 回目の失敗がそのまま終わりである。** 行き先を宣言
 * しないと、Lambda はイベントを**黙って捨てる。** 利用者から見れば「押したのに
 * 何も起きない」で、こちらから見れば何も残らない。
 *
 * ## SNS ではなく SQS にした理由
 *
 * SNS のメール購読は購読者本人の確認クリックを要し、宣言しても確認が済むまで
 * 届かない（`terraform/variables.tf` の `budget_notification_email` が Budgets で
 * SNS を挟まなかったのと同じ理由）。**「宣言は緑なのに通知だけ来ない」状態を
 * 作らない。** SQS なら、溜まっていること自体を外部層の検査が読める
 * （`scripts/acceptance-remote.sh` の `orchestrator failure queue is empty`）。
 *
 * ## 中身にジョブトークンが載る
 *
 * OnFailure destination が受け取るのは失敗の記録で、そこには `requestPayload`
 * ——すなわち平文のジョブトークン——が含まれる。**承知のうえで受け入れる。**
 *
 *   - トークンにできるのは**その 1 行を進めること**だけで、寿命は 1 ジョブである
 *     （`src/generate-callback.ts`）。
 *   - 失敗したジョブの行は 3.7 の掃除（未公開のまま 14 日）で消え、そのとき
 *     トークンも意味を失う。保持期間を同じ 14 日に揃えてあるのはそのためである。
 *   - キューは SSE（SQS 管理鍵）で保存時に暗号化する。
 *
 * **代わりに載せずに済ませる形は無い。** 失敗したイベントを再送・調査するには、
 * どのジョブだったかが要る。
 */
resource "aws_sqs_queue" "orchestrator_failures" {
  name                      = local.orchestrator_failure_queue_name
  message_retention_seconds = local.orchestrator_failure_queue_retention_seconds

  # 保存時の暗号化。SQS 管理鍵（SSE-SQS）を使う。KMS を挟まないのは、鍵の管理を
  # 増やしても、この経路で守れるものが「14 日で消える使い捨てトークン」だけだからである。
  sqs_managed_sse_enabled = true

  tags = local.orchestrator_tags
}

# ── ロググループ ────────────────────────────────────────────────────────────

/**
 * 関数のログ出力先。
 *
 * 宣言しておくのは 2 つの理由による（`terraform/build-function.tf` と同じ）。
 * **保持期間を決めるため**（Lambda が自動で作るロググループは無期限保持）と、
 * **実行ロールへ `logs:CreateLogGroup` を与えずに済むため**である。
 *
 * **ログに生成ソースもプロンプトもジョブトークンも出さない**（`src/orchestrator/`）。
 * 出るのは作品 id と結末の分類名だけである。
 */
resource "aws_cloudwatch_log_group" "orchestrator" {
  name              = "/aws/lambda/${local.orchestrator_function_name}"
  retention_in_days = 14

  tags = local.orchestrator_tags
}

# ── 実行ロール ──────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "orchestrator_assume" {
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
 * オーケストレータの実行ロール。**与えるのは 4 つだけである。**
 *
 *   1. 宣言済みのロググループ 1 本への書き込み（`CreateLogGroup` は与えない）
 *   2. Bedrock の生成呼び出し（許可の定義は `terraform/bedrock.tf` と共有）
 *   3. **ビルド関数 1 つ**への `lambda:InvokeFunction`
 *   4. 失敗の受け皿 1 つへの `sqs:SendMessage`
 *
 * **D1 も R2 も触れない。** 作品行と台帳を進めるのは Worker のコールバック経路で、
 * Cloudflare の API トークンは AWS 側へ置かない（7.3 / 9.2 / #150）。D1 の編集権限は
 * アカウント単位で、本番を含むすべてのデータベースの読み書きと削除ができる。
 *
 * **`lambda:*` を与えない。** それは `UpdateFunctionCode` を含み、**攻撃者が制御
 * しうるコードをコンパイルする関数**（7.1）の中身を差し替えられる、ということである。
 */
data "aws_iam_policy_document" "orchestrator" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions   = local.orchestrator_role_log_actions
    resources = ["${aws_cloudwatch_log_group.orchestrator.arn}:*"]
  }

  /**
   * 生成の呼び出し（4.1）。
   *
   * **`resources` を全モデルに開いているのは `terraform/bedrock.tf` と同じ理由**で、
   * 確定5 が複数モデル構成であり、モデルを足すたびにポリシーを直す運用にすると
   * 追随漏れが起きるためである。費用の上限は 4.3 の機構が担保する。
   */
  statement {
    sid    = "InvokeGenerationModels"
    effect = "Allow"

    actions   = local.bedrock_invoke_actions
    resources = ["*"]
  }

  /**
   * ビルド関数の呼び出し（3.3-5）。
   *
   * **対象は 1 つだけ**（9.2。このアカウントには他の関数も置きうる）。ARN は文字列で
   * 組み立てず関数を参照する（`terraform/build-invoker.tf` と同じ）。
   *
   * **バージョン・エイリアスの ARN は含まない。** 呼び出し側
   * （`src/build-client.ts`）は修飾なしの関数名で呼ぶ。
   */
  statement {
    sid    = "InvokeBuildFunction"
    effect = "Allow"

    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.build.arn]
  }

  /**
   * 失敗の受け皿への送信。
   *
   * **OnFailure destination は関数の実行ロールで送る。** 与えないと、失敗したときに
   * 「destination へ送れなかった」というログだけが残り、受け皿は空のままになる。
   */
  statement {
    sid    = "SendToFailureQueue"
    effect = "Allow"

    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.orchestrator_failures.arn]
  }
}

resource "aws_iam_role" "orchestrator" {
  name               = local.orchestrator_function_name
  path               = "/service/"
  assume_role_policy = data.aws_iam_policy_document.orchestrator_assume.json

  tags = merge(local.orchestrator_tags, {
    Purpose = "Execution role for the orchestrator - spec 3.3 and 9.2 / issue 160"
  })
}

resource "aws_iam_role_policy" "orchestrator" {
  name   = "orchestrator"
  role   = aws_iam_role.orchestrator.id
  policy = data.aws_iam_policy_document.orchestrator.json
}

# ── 関数本体 ────────────────────────────────────────────────────────────────

/**
 * 器を作るためだけの仮のコード。
 *
 * 本物は `scripts/bundle-orchestrator.sh` が束ねた zip で、
 * `aws lambda update-function-code` が載せる（理由は index.mjs の冒頭と
 * `docs/orchestrator.md`）。出力先の `terraform/build/` は `.gitignore` で
 * 追跡から外している（`terraform/bedrock-guard.tf` と同じ）。
 */
data "archive_file" "orchestrator_placeholder" {
  type        = "zip"
  source_file = "${path.module}/lambda/orchestrator-placeholder/index.mjs"
  output_path = "${path.module}/build/orchestrator-placeholder.zip"
}

/**
 * オーケストレータ本体（3.3-2.6 の受け側）。
 *
 * ## コードは宣言が持たない
 *
 * `filename` と `source_code_hash` を `ignore_changes` に入れてある。**配るのは
 * 利用者の端末である**（`scripts/deploy-orchestrator.sh`）。宣言側が本物の zip を
 * 指すと、**配備のたびに terraform plan へ差分が出る。** 受け入れ条件の
 * 「plan が差分なし」が、配備が正常に動いているときにこそ落ちることになる
 * （`terraform/build-function.tf` の `image_uri` と同じ判断）。
 *
 * ## 資格情報を環境変数に書かない
 *
 * `AWS_ACCESS_KEY_ID` などは **Lambda が実行ロールから注入する。** ここで宣言すると
 * 予約名の衝突で関数の作成が失敗する。**それが正しい**——宣言に鍵が現れないことを
 * ランタイムが強制している（`src/orchestrator/handler.ts`）。
 *
 * ## `CALLBACK_BASE_URL` は宣言が持つ
 *
 * **ペイロードで受け取らない。** 呼び出しのペイロードを差し替えられる者が
 * ジョブトークンの送り先を変えられるからである（`src/orchestrator/payload.ts`）。
 * 値は `local.app_host`（`terraform/dns.tf`）から作るので、`wrangler.toml` の
 * `APP_HOST` とずれない（外部層の検査が両者を突き合わせている）。
 */
resource "aws_lambda_function" "orchestrator" {
  function_name = local.orchestrator_function_name
  role          = aws_iam_role.orchestrator.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  # **x86_64 を明示する。** arm64（Graviton）は 20% 安いが、`terraform/build-function.tf`
  # が「未実測の側へは寄せない」として x86_64 を選んでいるのと同じ判断で揃える。
  # この関数は待ち時間が支配的で、1 生成あたりの Lambda 費用は約 0.1 円である
  # （約 16 円に対して無視できる）。**節約の余地が小さい側で、軸を 1 つ増やさない。**
  architectures = ["x86_64"]

  memory_size = local.orchestrator_memory_mb
  timeout     = local.orchestrator_timeout_seconds

  reserved_concurrent_executions = local.orchestrator_reserved_concurrency

  filename         = data.archive_file.orchestrator_placeholder.output_path
  source_code_hash = data.archive_file.orchestrator_placeholder.output_base64sha256

  environment {
    variables = {
      # コールバックの宛先（上記）。
      CALLBACK_BASE_URL = "https://${local.app_host}"
      # ビルド関数の宛先。**値の正本はここではなく build-function.tf の local である。**
      BUILD_FUNCTION_NAME = aws_lambda_function.build.function_name
    }
  }

  lifecycle {
    # 上の「コードは宣言が持たない」を参照。
    ignore_changes = [filename, source_code_hash]
  }

  # ロググループより先に関数が動くと、Lambda が無期限保持のロググループを自分で作り、
  # 宣言側の retention_in_days が効かない状態になる。
  depends_on = [
    aws_cloudwatch_log_group.orchestrator,
    aws_iam_role_policy.orchestrator,
  ]

  tags = local.orchestrator_tags
}

/**
 * 非同期呼び出しの構成。**#160 でいちばん外してはいけない宣言である。**
 *
 * | 項目 | 値 | 外すと何が起きるか |
 * |---|---|---|
 * | `maximum_retry_attempts` | **0** | 既定 2 と 5.2-7 の 3 試行が掛け算になり、1 回の送信から最大 9 回・約 144 円・日次枠 9 個 |
 * | `maximum_event_age_in_seconds` | **300** | 既定 6 時間。忘れられた生成が課金と枠を食う |
 * | `on_failure` | SQS | 失敗したイベントが黙って消える |
 *
 * **重複配信はここでは防げない。** Lambda の非同期呼び出しのキューは結果整合で、
 * AWS 自身が「関数がエラーを返さなくても同じイベントを複数回受け取りうる」と明記
 * している。スロットル時は既定で 6 時間キューに残り、逆にイベントが送られずに
 * 削除されることもある。**「LLM を 1 回だけ呼ぶ」は D1 の条件付き UPDATE
 * （`claim`）が担保する**（`src/games.ts` / `src/orchestrator/pipeline.ts`）。
 * この宣言はそれを助けるだけで、代わりにはならない。
 *
 * **`on_success` は宣言しない。** 成功は `games` 行に現れており、利用者は作品ページで
 * 受け取る。もう 1 か所へ書くと、どちらが正かを決める必要が生まれる。
 */
resource "aws_lambda_function_event_invoke_config" "orchestrator" {
  function_name = aws_lambda_function.orchestrator.function_name

  maximum_retry_attempts       = local.orchestrator_maximum_retry_attempts
  maximum_event_age_in_seconds = local.orchestrator_maximum_event_age_seconds

  destination_config {
    on_failure {
      destination = aws_sqs_queue.orchestrator_failures.arn
    }
  }
}
