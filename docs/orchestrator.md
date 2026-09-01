# オーケストレータ（AWS Lambda）の運用手順

生成の実行体を Worker の外へ出した経路（仕様 3.3 の再配置 / #160）の、配備と確認の手順。

**器（関数・実行ロール・非同期呼び出しの構成・失敗の受け皿）の正本は
`terraform/orchestrator.tf`** で、**コードの正本は `src/orchestrator/`** である。
この文書が持つのは、宣言で表せない手順——鍵の始末、配備の順序、確認のしかた——だけである。

## なぜ 2 つ目のデプロイ単位が要るのか

**`ctx.waitUntil()` は応答送信またはクライアント切断から 30 秒で打ち切られ、未解決の
Promise はキャンセルされる**（Cloudflare の明文。実測で確認）。生成は 90.9 秒（1.2.38）で
収まらない。

**Pages Functions は queue consumer になれず、Durable Object を定義できず、Workflows の
binding も持たない。** Cloudflare 側で解くには例外なく 2 つ目のデプロイ単位が要る。
既にある AWS へ寄せたのが A 案である（2026-08-29 の決定）。

仕様 1.2.27 の「Cloudflare の待ち時間に上限は無い」は `As long as the client remains
connected` という**条件付きの記述**で、応答後には適用されない。

**ローカルの `wrangler pages dev` はこの上限をかけない。** 150 秒のジョブが完走することを
実測しており、**この経路をローカルだけで検証すると偽の緑が出る。**

## 構成

| 対象 | 実体 | 持ち主 |
|---|---|---|
| オーケストレータ関数 | `game-forge-orchestrator`（Node 22 / x86_64 / 512 MB / 840 秒） | `terraform/orchestrator.tf` |
| 実行ロール | `game-forge-orchestrator`（Bedrock ＋ ビルド関数 ＋ ログ ＋ SQS） | `terraform/orchestrator.tf` |
| 非同期呼び出しの構成 | リトライ 0 / 有効期限 300 秒 / OnFailure → SQS | `terraform/orchestrator.tf` |
| 失敗の受け皿 | SQS `game-forge-orchestrator-failures`（14 日・SSE） | `terraform/orchestrator.tf` |
| 関数のコード | `dist/orchestrator.zip`（束ねた ESM 1 ファイル） | `scripts/bundle-orchestrator.sh` |
| 投げる側 | `defaultPipeline.startJob`（`src/orchestrator/start-job.ts`） | エッジ |
| 受け取る側 | `/api/generate/callback` の 4 種別（`src/generate-callback.ts`） | エッジ |

## 1 回のジョブに何が起きるか

```
利用者 → POST /api/generate（Worker）
          ├ 3.3-2  クォータ判定（D1）        ← 判定はここ 1 か所（4.3）
          ├ 3.3-2.5 games 行と使い捨てトークンを作る
          └ 3.3-2.6 Lambda を Event で 1 回叩いて 202 を返す  ← ここで応答が返る

オーケストレータ（Lambda）
          ├ claim          ← **最初の動作。false なら Bedrock を呼ばずに降りる**
          ├ 3.3-3 生成（Bedrock。実行ロールの資格情報）
          ├ 3.3-4 ledger   ← **届くまで再送**（費用ゼロ）
          ├ 5.2-5 許可パッケージ検査（Worker と同じコード）
          ├ 3.3-5..7 cache-lookup → ビルド関数（同期呼び出し）
          └ 3.3-8 finish   ← ready / failed。**届くまで再送**
```

**利用者が結果を受け取る経路は、応答ではなく作品ページである。** `/works/<id>` は
最初から存在し、`src/work-page.ts` が 5 秒ごとに自動更新する。

## 重複配信は設定では防げない

**Lambda の非同期呼び出しのキューは結果整合で、AWS 自身が「関数がエラーを返さなくても
同じイベントを複数回受け取りうる」と明記している。** スロットル時は既定で 6 時間キューに
残り、逆にイベントが送られずに削除されることもある。

**「LLM を 1 回だけ呼ぶ」は D1 の条件付き UPDATE（`claim`）だけが担保する**
（`src/games.ts` の `claimGenerationJob`）。オーケストレータの最初の動作が `claim` で、
`false` が返ったら Bedrock を呼ばずに降りる。`test/orchestrator.test.ts` が、同じ
イベントを 2 回処理して Bedrock の呼び出しが 1 回に留まることを確かめている。

## 実行時間は最悪ケースから決める

**タイムアウトは 840 秒（14 分）です。** 決め方は「余裕をみて丸めた」ではなく、
**1 依頼が最悪どこまで伸びるかを式で置き、その式を機械で照合する**形です（#174）。

```
最悪ケース = 試行回数 × 生成の秒数
           + ( 試行回数 × ( 1 + 機械修正の巡回数 ) + 呼び直しの枠 ) × ビルド 1 回の待ち上限
```

| 記号 | 正本 |
|---|---|
| 試行回数 | `src/build-retry.ts` の `MAX_GENERATION_ATTEMPTS`（5.2-7） |
| 生成の秒数 | `terraform/orchestrator.tf` の `orchestrator_generation_seconds`（実測 90.9 秒の切り上げ） |
| 機械修正の巡回数 | `src/mechanical-fix.ts` の `MAX_MECHANICAL_FIX_PASSES`（4.2 の 1 段目） |
| 呼び直しの枠 | `src/build-client.ts` の `MAX_BUILD_INVOCATIONS_ON_TIMEOUT` − 1（#164。**1 依頼あたり**） |
| ビルド 1 回の待ち上限 | `src/build-client.ts` の `BUILD_INVOKE_TIMEOUT_MS`（ビルド関数のタイムアウト ＋ 5 秒） |

**いまの値をここへ書き写しません。** 検査を回すと合計と内訳が出ます。

```
$ bash scripts/check-orchestrator-retry.sh
[orchestrator-retry] 見積もり: 生成 3×91 秒 ＋ ビルド 10×50 秒 = 773 秒（＋余裕 60 秒 → 833 秒 / timeout 840 秒）
ORCHESTRATOR_RETRY_PASS
```

**1 試行あたりのビルドは 1 ＋ 機械修正の巡回数です**（`src/generate.ts` の
`repairAndRebuild`）。**キャッシュヒット（3.8）は現れません**——ヒットすれば関数を
呼ばないので、短くなる方向にしか効きません。

**合計をどこにも書き写しません。** `scripts/check-orchestrator-retry.sh` が入力を
実装から読み、自分で計算して 3 つの不等式を見ます。

1. 最悪ケース ＋ 余裕（`orchestrator_budget_margin_seconds`）≤ タイムアウト
2. タイムアウト < `src/work-page.ts` の `STALE_AFTER_SECONDS`（900 秒）
3. タイムアウト ≤ Lambda の実行時間の上限（900 秒）

**溢れると壊れ方が悪いので、1 を機械で見ます。** 関数が時間切れで殺されると
`finish` が飛ばず、**作品行は `running` のまま残ります**（費用は出ています）。
利用者から見ると「生成中の表示が終わらない作品」です。

### #174 以前は何がずれていたか

宣言のコメントは最悪ケースを「3 試行 ×（生成 91 秒 ＋ ビルド最大 T × 2）」と
置いていましたが、**実際は 1 試行あたりビルドが 3 回走り**（4.2 の機械修正が
`MAX_MECHANICAL_FIX_PASSES` 回まで再ビルドする）、さらに #164 の呼び直しが
**ビルド 1 回ごとに**掛かっていました。**1 依頼で最大 18 回、どのタイムアウトを
選んでも Lambda の 15 分に収まりません。**

そこで **timeout を伸ばすだけでなく、上流も絞りました。** 呼び直しの枠を
「1 ビルドあたり」から**「1 依頼あたり」**へ直しています（`BuildTimeoutBudget`）。
**#164 自身の根拠が「1 回の依頼で 3 回焼くと見積もりが崩れる」であり、単位が
依頼だったのに実装がビルド単位だった**、というずれです。

**試行回数（3）と機械修正の巡回数（2）は動かしていません。** 前者を減らすと
毎回の生成の成功率が下がり、後者を減らすと費用ゼロで直せた失敗に約 16 円を払う
ことになります。**利用者に見える側を削らずに済む順に絞りました。**

## 基盤のリトライは 0 である

5.2-7（`src/build-retry.ts` の `MAX_GENERATION_ATTEMPTS`）が既にビルド診断を織り込む
賢い再試行を最大 3 回持っている。**`MaximumRetryAttempts` の既定は 2 で、掛け算にすると
1 回の送信から最大 9 回・約 144 円・日次枠 9 個が出る。**

**書き忘れを 2 層で押さえる。**

| 層 | 実行体 | 見るもの |
|---|---|---|
| ローカル | `scripts/check-orchestrator-retry.sh`（`scripts/acceptance.sh` が呼ぶ） | **宣言** |
| 外部 | `scripts/acceptance-remote.sh` の `orchestrator async invoke config matches` | **実状態** |

## 配備

### 前提: 認証

```bash
aws sso login --sso-session ojos          # 失効していたら（--use-device-code が要ることがある）
export AWS_PROFILE=game-forge-prod
set -a; source scripts/load-project-env.sh; set +a   # CLOUDFLARE_API_TOKEN 等
```

**`export AWS_PROFILE` を飛ばさないこと。** `aws sso login --profile ...` は**ログインするだけ**で、
以後の `aws` には効かない。既定のプロファイルに `region` が無いと `NoRegion` で落ちる。

**前提だけを先に見られる**（AWS へも本番へも触れない。#243）。

```bash
bash scripts/deploy-orchestrator.sh --check-prerequisites
# [deploy-orchestrator] 前提 OK（profile=game-forge-prod / region=ap-northeast-1）
```

欠けていれば、**欠けている前提を名指しして 2 で落ちる。**

```
[deploy-orchestrator] region を解決できません（NoRegion になります）。
[deploy-orchestrator] 対処: export AWS_REGION=<リージョン>、または
[deploy-orchestrator]       ~/.aws/config のプロファイルへ region を書く
[deploy-orchestrator] **AWS へは 1 度も触れていません。** 前提が欠けています。
```

> **2026-09-01 に踏んだ。** 本番の生成が止まっている最中（#241 の復旧）に `AWS_PROFILE` を
> export し忘れ、`NoRegion` になった。**当時の文言は「認証と器の作成を確認してください」**で、
> **認証も器も済んでいた**——当たっていない原因を指していた（#243）。

### この切り替えは生成経路を数分止める

**手順 2 から 5 のあいだ、生成は失敗する。** 理由は 2 つある。

- 手順 2 で Bedrock の鍵を無効にする。**まだ同期版の Worker が本番に居る**ため、その
  あいだ生成は「設定不足」で落ちる。
- 手順 3 でエッジの `lambda:InvokeFunction` の対象がビルド関数からオーケストレータへ
  移る。同期版の Worker はビルド関数を直接叩けなくなる。

**作品の閲覧・プレイ・一覧は影響を受けない**（D1 と R2 だけを読む経路である）。
利用者の少ない時間帯に通すこと。

### 1. 手元で束ねられることを確かめる

```bash
bash scripts/bundle-orchestrator.sh
```

`BUNDLE_PASS` と `CodeSha256` が出れば良い。`scripts/acceptance.sh` も同じことを
毎回行う（**テストは workerd の上で走るが、配備先は Node 22 である**）。

### 2. 消えるユーザーの鍵と権限を外す（初回のみ）

**`aws_iam_access_key` を宣言していないため、Terraform はこの鍵を知らない。**
残したまま apply すると、ユーザーの削除が `DeleteConflict` で落ちる。

```bash
# 何が付いているかを見る
aws iam list-access-keys       --user-name game-forge-bedrock-invoker
aws iam list-user-policies     --user-name game-forge-bedrock-invoker
aws iam list-attached-user-policies --user-name game-forge-bedrock-invoker

# 鍵を消す（AccessKeyId は上の出力から）
aws iam delete-access-key --user-name game-forge-bedrock-invoker --access-key-id <AccessKeyId>

# インラインポリシーを消す
aws iam delete-user-policy --user-name game-forge-bedrock-invoker --policy-name bedrock-invoke
```

**ここから生成が止まる。**

### 3. 器を作る

```bash
terraform -chdir=terraform apply
```

作られるもの: オーケストレータ関数（仮のコード）・実行ロール・ロググループ・
SQS の受け皿・非同期呼び出しの構成。あわせて、費用ガードの停止対象が
IAM ユーザーからこのロールへ移り、エッジの `lambda:InvokeFunction` の対象が
オーケストレータへ移り、`game-forge-bedrock-invoker` が削除される。

### 4. 本物のコードを載せる

```bash
bash scripts/deploy-orchestrator.sh
```

**通すまで、投げられたジョブはすべて失敗の受け皿へ落ちる**（仮のコードは常に例外を
投げる。`terraform/lambda/orchestrator-placeholder/index.mjs`）。

> **2026-08-29 の失敗。** 初回の配備で、この段が
> `aws: [ERROR]: Unknown options: false` で落ちた。**`--publish false` と書いていた**
> ためである（AWS CLI の真偽値フラグは値を取らない）。`terraform apply` は成功して
> いたので、**関数は仮のコードのまま存在し、エッジだけが非同期版になった**
> ——本物のコードが載るまで、生成が戻らない状態が続いた。
>
> **この綴りは機械で照合するようになった**（`scripts/check-aws-cli-usage.sh`。
> `scripts/acceptance.sh` が呼ぶ）。**実行せずに分かるのは引数の形までである**
> ——権限・関数の存在・関数の状態は、下記「まだ決まっていないこと」のとおり
> 本番でしか分からない。

### 5. Pages を配備し直す

新しい `ORCHESTRATOR_FUNCTION_NAME`（`wrangler.toml` の `[vars]`）と、非同期版の
`startJob` が載る。**日常の経路は main への push による自動配備である**（#95 /
`docs/pages-deploy.md`）。手で打つなら:

```bash
npx wrangler pages deploy --project-name game-forge --branch main \
  --commit-hash "$(git rev-parse HEAD)"
```

**ここで生成が戻る。**

### 6. エッジから Bedrock の資格情報を消す

**#160 の積極的な理由がこれである**（仕様 9.2 / 4.3）。

```bash
npx wrangler pages secret delete BEDROCK_AWS_REGION            --project-name game-forge
npx wrangler pages secret delete BEDROCK_AWS_ACCESS_KEY_ID     --project-name game-forge
npx wrangler pages secret delete BEDROCK_AWS_SECRET_ACCESS_KEY --project-name game-forge
```

`BEDROCK_AWS_SESSION_TOKEN` は本番に登録していない（`docs/pages-deploy.md`）。
残っていないことは外部層の検査が見る（`edge no longer holds bedrock credentials`）。

**`BUILD_AWS_*` は残す。** エッジに残る長命キーはこの 1 組だけで、できるのは
「オーケストレータへジョブを 1 回投げること」だけになった。

### 7. 外部層の検査を通す

```bash
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

この 6 本が緑になっていること。

```
bedrock invoker permissions are minimal          実行ロールの許可が宣言どおり
edge no longer holds bedrock credentials         Pages と IAM の両方から消えている
orchestrator configuration matches               メモリ・タイムアウト・同時実行数・宛先
orchestrator async invoke config matches         **リトライ 0**・有効期限・OnFailure
orchestrator failure queue exists and is empty   受け皿が実在し、溜まっていない
orchestrator code matches the local bundle       本番のコードが手元と同じ
```

### 8. 実地の確認（1 回 約 16 円）

**ここまでの検査は 1 円も使わない。** 実際に完走することは、これを 1 回だけ通して見る。

```bash
# 作品ページの URL は応答の Location から取れる。**タブを閉じてよい。**
# 生成が終わるころ（90〜120 秒後）にもう一度開き、ready になっていることを見る。
```

あわせて次を確認する。

```bash
# ログに生成ソース・プロンプト・ジョブトークンが出ていないこと
aws logs tail /aws/lambda/game-forge-orchestrator --since 10m

# 受け皿が空のままであること
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name game-forge-orchestrator-failures --query QueueUrl --output text)" \
  --attribute-names ApproximateNumberOfMessages
```

## 以降の配備

コードだけを直したとき:

```bash
bash scripts/deploy-orchestrator.sh
```

**宣言（`terraform/orchestrator.tf`）に差分は出ない。** `filename` と
`source_code_hash` を `ignore_changes` に入れてあるためで、`terraform/build-function.tf`
の `image_uri` と同じ形である（受け入れ条件の「plan が差分なし」が、配備が正常に
動いているときにこそ落ちる、という状態を作らない）。

**`src/` の共有部分（`src/bedrock.ts` / `src/build-client.ts` / `src/go-imports.ts` など）を
直したときも、この配備が要る。** エッジと同じコードが 2 か所で動いているため、
Pages の配備だけでは片方しか新しくならない。

## 失敗の受け皿に何かが入っていたら

**入っていること自体が「完走しなかったジョブがある」という意味である。**
オーケストレータは、結末を `games` 行へ書けたかぎり例外を投げない
（`src/orchestrator/handler.ts` の表）。したがってここに落ちているのは次のどれかである。

| 例外 | 意味 | 作品行 | やること |
|---|---|---|---|
| `OutcomeNotRecorded` | `claim` または `finish` が届かなかった | **未確定**（下記） | Worker 側の障害を疑う。行は 3.7 の掃除で消える |
| `LedgerNotRecorded` | `ledger` が届かなかった | 閉じている | **課金は出ているのに日次枠が減っていない。** `generations` へ手で 1 行入れるか、超過を受け入れるかを決める |
| `OrchestratorPayloadRejected` | ペイロードが契約に合わない | `pending` のまま | 版の食い違い。エッジと Lambda の配備のずれを疑う |
| `OrchestratorEnvIncomplete` | 環境変数が足りない | `pending` のまま | `terraform apply` が通っているか |
| （メッセージなし） | 有効期限切れ・スロットル | `pending` のまま | 予約同時実行数を見直す |

**`OutcomeNotRecorded` は、止まった位置を教えません。** 表しているのは「結末が
記録されていない」ことだけで、どの状態で止まったかは**どのコールバックが届かなかったか**で
変わります。**例外のメッセージは状態を断定しません**（断定が外れると最初に見る場所を
間違えるため）。**作品行を引いて確かめてください。**

| 作品行 | 届かなかったもの | 費用 |
|---|---|---|
| `pending` | `claim` | **出ていない**（LLM を 1 回も呼んでいない） |
| `running` | `finish` | **出ている**（台帳には残っている） |

```bash
QUEUE="$(aws sqs get-queue-url --queue-name game-forge-orchestrator-failures --query QueueUrl --output text)"
aws sqs receive-message --queue-url "$QUEUE" --max-number-of-messages 10 \
  --query 'Messages[].Body' --output text | jq -r '.requestContext.condition, .responsePayload.errorType'
```

**再送はしない。** ペイロードには平文のジョブトークンが載っており、行がまだ
`pending` なら投げ直せば動くが、**「なぜ落ちたか」を調べる前に動かすと同じことが起きる**
（費用ガードの復旧を自動化しないのと同じ判断。仕様 4.3）。利用者にもう一度押して
もらうほうが安い。

## 元へ戻すとき

`defaultPipeline.startJob` を `runJobInline` へ戻せば同期実行に帰る。**ただし 1 行では
戻らない。**

1. `src/generate.ts` の `startJob` を `runJobInline` へ
2. `src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS` を `true` へ
   （**忘れるとテストが落ちる。** `test/work-page.test.ts` が両者を照合している）
3. Pages のシークレットへ `BEDROCK_AWS_*` を入れ直す
4. `terraform/build-invoker.tf` の `build_invoke_resources` をビルド関数へ戻し、
   Bedrock を呼ぶプリンシパルと費用ガードの停止対象も戻す

**3 と 4 を忘れると、同期実行に戻したのに Bedrock もビルド関数も呼べない。**
そして戻した状態では、**91 秒の生成は 30 秒で打ち切られる**（この文書の冒頭）。

## まだ決まっていないこと

- **待ち時間そのものは縮んでいない。** 90.9 秒は変わらず、変わったのは「待つ場所」
  である。短縮は #25 と、Lambda のメモリ引き上げ（審査中。`docs/build-function.md`）が持つ。
- **ローカルでこの経路を通しで確かめられない。** Dev アカウントに Lambda は無く
  （9.2 / 確定20）、`wrangler pages dev` から投げると本番の関数が動く。
  ローカルで確かめられるのは、束ねられること・Node で読み込めること・
  4 種別のコールバックと `claim` の振る舞い（`test/orchestrator.test.ts`）までである。
- **配備そのものも、本番でしか確かめられない。** `scripts/deploy-orchestrator.sh` が
  実際に成功するかは**認証・IAM の権限・関数の存在と状態**に依存し、そのどれも
  ローカルには無い。**機械で見られるのは引数の形だけである**
  （`scripts/check-aws-cli-usage.sh`。操作・オプション・待機子が実在すること、
  真偽値フラグに値を渡していないこと）。**次にこの層へ手を入れる人は、「ローカルが
  緑でも初回は本番で落ちうる」前提で構えること。**
- **`aws lambda update-function-code` には `--dry-run` がある。** 資格情報のある環境
  なら、**載せずに**呼び出しの可否（権限と引数）を確かめられる。認証を要するので
  ローカル層には置けず、置くなら外部層（`scripts/acceptance-remote.sh`）である。
  **まだ置いていない。**
