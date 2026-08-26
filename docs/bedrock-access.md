# Bedrock のモデルアクセスと資格情報

- 対象: #82（M2-13）
- 位置づけ: **宣言できる範囲は `terraform/bedrock.tf` が持ち、宣言できない範囲だけをこの文書が持つ。**
  この文書だけを見て、同じ外部状態を再現できることを目標とする。

---

## 1. 宣言と手作業の線引き

| 対象 | 持ち主 | 理由 |
|---|---|---|
| モデルアクセス（agreement の承諾） | `terraform/bedrock.tf` | 宣言できる |
| IAM ユーザーとポリシー | `terraform/bedrock.tf` | 宣言できる |
| 費用ガードの層 2（暴走検知）と層 3（Budgets） | `terraform/bedrock-guard.tf` | 宣言できる |
| **アクセスキーの実体** | **この文書（手作業）** | 宣言すると tfstate へ平文で落ちる |
| **鍵のローテーション** | **この文書（手作業）** | 上と同じ。鍵に触る操作はすべて宣言の外 |
| use case の申請 | **この文書（手作業）** | Console のフォームで、Anthropic 側の審査を伴う |
| **費用ガードの層 4（レートクォータの引き下げ）** | **この文書（未実施）** | **Service Quotas に引き下げの API が無い**（5 章） |
| **ガード発火後の復旧** | **この文書（手作業）** | **意図して自動化しない**（仕様 4.3。5 章） |

**対象は Dev / Prod の 2 アカウントである**（仕様 9.2 / 確定21）。`terraform/bedrock.tf` が
両方の agreement を宣言する。IAM ユーザーを置くのは Prod だけで、Dev では SSO の一時
資格情報を使う。

### アクセスキーを宣言しない理由

`aws_iam_access_key` は生成した秘密鍵を **tfstate へ平文で書く。** tfstate は
`.gitignore` で追跡から外しているが、ディスク上は平文である。`terraform/providers.tf` が
「資格情報を Terraform 変数として受け取ると tfstate や plan ファイルへ平文で落ちる経路が
できる」として避けているのと同じ経路を、出力側に作ることになる。

**ロールではなくユーザーである理由。** Cloudflare Pages Functions は AWS の外で動くため、
IAM ロールを引き受ける経路（インスタンスプロファイル、IRSA、OIDC フェデレーション）が
どれも使えない。長命キーになるのは構成上の帰結であり、選好ではない（仕様 4.1）。

---

## 2. アクセス開通の順序

**確認は実際に呼び出すのが確実である。** 状態 API は当てにならない（後述）。

```bash
aws bedrock-runtime converse --region ap-northeast-1 \
  --model-id jp.anthropic.claude-sonnet-4-6 \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":8}'
```

| 症状 | 意味 |
|---|---|
| `usage` が返る | 使える |
| `Invocation of model ID ... with on-demand throughput isn't supported` | **推論プロファイル ID（`jp.` / `global.` / `apac.`）を使う** |
| `<model> is not available for this account` | **そのモデルがアカウントに開放されていない** |

### agreement は呼び出しの条件ではない

**#82 の作業中にここを取り違えた。** `agreementAvailability: NOT_AVAILABLE` を呼び出し
不可の原因と診断して Sonnet 5 の agreement を承諾したが、**承諾しても呼び出せず、逆に
agreement 未承諾の Sonnet 4.6 は動いた。**

| モデル | agreement | 呼び出し |
|---|---|---|
| `jp.anthropic.claude-sonnet-4-6` | 未承諾 | **動く** |
| `claude-sonnet-5` | **承諾済み** | 不可 |

**`get-foundation-model-availability` が 3 つとも `AVAILABLE` を返していても、呼び出しは
拒否されうる。** 状態 API を根拠に「使える」と判断しないこと。

use case の申請とアカウント検証は通過しているが、**4.7 以降の世代がアカウントに開放されて
いない**（仕様 1.2.9）。エラーが案内する `contact AWS Sales` の経路を通るかは未定。

### use case の申請内容（構築時）

Console の「Submit use case details for Anthropic」で提出する。**アカウントごと、または
組織の管理アカウントで 1 回。**

| 項目 | 値 |
|---|---|
| Company name | OJOS |
| Company website URL | `https://github.com/ojos/` |
| Industry | Gaming |
| Intended users | External users |
| Use cases | 下記 |

```
Game Forge lets users describe a small 2D game in natural language. We use Claude to
generate Go source built on the Ebitengine library, compile it to WebAssembly in an
isolated container, and serve it from a sandboxed origin to play in a browser. Users
can fork and remix published games. Claude does code generation only and receives no
personal data. Invite-only closed beta, roughly 12-17 generations per day, with a hard
monthly spend cap, input/output moderation and a Go import allowlist.
```

**個人情報と知的財産を書かない**（フォームの注意書き）。

---

## 3. アクセスキーの発行

`terraform apply` で IAM ユーザーが出来た後に行う。

```bash
export AWS_PROFILE=game-forge-prod
aws iam create-access-key --user-name game-forge-bedrock-invoker
```

出力の `AccessKeyId` と `SecretAccessKey` を Pages のシークレットへ入れる。
**`SecretAccessKey` は発行時にしか表示されない。**

```bash
npx wrangler pages secret put BEDROCK_AWS_REGION --project-name game-forge          # ap-northeast-1
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY --project-name game-forge
```

**`--project-name` を必ず付ける。** 省くと wrangler が対話で選ばせにいくため、
非対話の手順として成立しない。名前と並びは `docs/pages-deploy.md` 5 章と同じで、
**投入の手順はあちらが正本、鍵の発行とローテーションはこの文書が正本**である。

**投入するのは `terraform apply` が済んだ後である。** 生成機能を開く時点（#83）で
`docs/pages-deploy.md` 5 章から呼ばれる。

**`BEDROCK_AWS_SESSION_TOKEN` は本番では登録しない。** 一時資格情報はローカル開発で SSO を
使うときだけのものである（`docs/local-dev.md`）。

**値をリポジトリへ書かない。** `.dev.vars` は追跡除外済みで、`scripts/check-no-secrets.sh` が
毎回検査する。

---

## 4. ローテーション手順

**この手順が必要なのは、Workers が AWS の外で動くからである。** IAM ロールを引き受ける
経路が無く、長命のアクセスキーを Pages のシークレットへ置くしかない（1 章）。
**長命キーの唯一の対処がローテーションである**ため、手順が無いことは構成上の欠陥になる。

### いつ回すか

| 契機 | 期限 |
|---|---|
| **漏洩の疑い**（ログ・issue・PR・チャットへ値が出た、端末を紛失した） | **即時。** 先に無効化してから調べる |
| 定期 | **90 日ごと** |
| 鍵に触れた人が離れた | その時点 |

**定期を 90 日にした理由。** 招待制の閉じたベータで、鍵は 1 本・保管先は Pages の
シークレット 1 か所しかない。これより短くすると、回すこと自体が事故（更新漏れによる
生成停止）の主因になる。**「回さない」より「回しすぎて壊す」ほうが起きやすい規模である。**

最終使用日は下記で読める。**長く使われていない鍵は、消してよいのではなく「なぜ使われて
いないのか」を先に確かめる**（片方が本番、片方が誰かの手元、という状態を見落とさない）。

### 手順

**IAM ユーザーは同時に 2 本までアクセスキーを持てる。** これを使って無停止で入れ替える。

```bash
export AWS_PROFILE=game-forge-prod
USER=game-forge-bedrock-invoker

# 1. 新しいキーを作る（この時点で 2 本になる）
aws iam create-access-key --user-name "$USER"

# 2. Pages のシークレットを新しい値へ更新し、デプロイして疎通を確認する
npx wrangler pages secret put BEDROCK_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BEDROCK_AWS_SECRET_ACCESS_KEY --project-name game-forge
npx wrangler pages deploy --project-name game-forge --branch main

# 3. 古いキーを **まず無効化する**（削除ではない。切り戻せる状態を残す）
aws iam update-access-key --user-name "$USER" \
  --access-key-id <OLD_KEY_ID> --status Inactive

# 4. 一定期間なにも壊れないことを確認してから削除する
aws iam delete-access-key --user-name "$USER" --access-key-id <OLD_KEY_ID>
```

**手順 3 と 4 を分ける理由。** 削除は取り消せない。無効化なら `--status Active` で
すぐ戻せる。切り戻せない操作を、確認より前に置かない。

現在のキーの一覧と最終使用日:

```bash
aws iam list-access-keys --user-name game-forge-bedrock-invoker
aws iam get-access-key-last-used --access-key-id <KEY_ID>
```

**ローテーションは費用ガードの復旧手段ではない**（5 章）。Deny ポリシーはユーザーに
付いており、鍵に付いているのではない。新しいキーを作っても止まったままである。

**値をここへ書き写さない。** `scripts/check-no-secrets.sh` が毎回検査するが、検査に
頼る前に、鍵の値が出るのは `create-access-key` の出力と `wrangler` の入力だけに保つ。

---

## 5. 費用ガード（層 2 / 層 3）

機構と値は仕様 4.3（#81）が正本である。**宣言の実体は `terraform/bedrock-guard.tf`**
にあり、この章はそこから漏れる部分（宣言できない層 4、発火時の読み方、復旧手順）を持つ。

| 層 | 実体 | 値 | 持ち主 |
|---|---|---|---|
| 1. アプリ層 | D1 の費用台帳＋月次 1 万円判定 | 80% 警告 / 100% 停止 | アプリ（#84） |
| 2. 暴走検知 | CloudWatch アラーム → SNS → Lambda | `InputTokenCount` ＋ `OutputTokenCount` が **300 秒で 30 万トークン** | `terraform/bedrock-guard.tf` |
| 3. 会計層 | AWS Budgets（＋ Budget Action） | prod **85 USD/月**（80% 通知 / 100% 停止）、dev **10 USD/月**（通知のみ） | `terraform/bedrock-guard.tf` |
| 4. 補助 | Bedrock のレートクォータ引き下げ | — | **無し**（下記） |

### 停止の実体は「明示的 Deny の付与」である

停止は **Deny ポリシー（`game-forge-bedrock-halt`）を `game-forge-bedrock-invoker` へ
アタッチする**形で行う（仕様 4.3 / v1.7）。**v1.6 までの 4.3 は「ポリシーを剥がす」と
書いていたが、剥奪では成立しないことが #82 の実装で分かり、仕様側を改めた。**
求められているのは呼び出しが止まることであって、特定の API を呼ぶことではない。

1. **剥がすと宣言と喧嘩する。** 許可は Terraform が `aws_iam_user_policy` として
   持っている。ガードがそれを消すと `terraform plan` に差分が出て、**誰かが無関係な
   変更（DNS など）を apply した拍子に、原因を調べる前に許可が戻る。** 4.3 の
   「復旧は手動とする」に反する。アタッチは宣言集合の外側なので apply では剥がれない。
2. **層 3 は Deny の付与しかできない。** AWS Budgets の `APPLY_IAM_POLICY` は指定
   ポリシーを**付ける**動作しか持たない。層 2 を「剥がす」にすると、発火した層ごとに
   復旧手順が変わる。揃えれば復旧は常に「Deny を detach する」1 つで済む。

明示的 Deny は同一アカウント内の Allow を必ず上書きするため、効果は剥奪と同じである。

### 層 4 を宣言できない理由

**Service Quotas は増加要求の API しか持たない。** 引き下げは宣言できず、そもそも
要求が通るかも未確認である。**層 4 が無くても設計は成立する**ように、層 2 のしきい値は
現行クォータのまま上振れが収まる値になっている（4.3）。**DeepSeek のクォータは 1 つも
調整できない**（実測）。

現時点で層 4 は**無いものとして運用する。** 引き下げを試みるなら Console の
Service Quotas から要求することになるが、その時点で結果をこの章へ追記すること。

### 発火したら何が起きるか

**発火は「止まった」だけでは終わらない。どちらの層が撃ったかが、そのままバグの
種類を指している**（4.3 の判定基準）。

| 撃った層 | 意味 | 見る場所 |
|---|---|---|
| 層 2（暴走検知） | **アプリのループバグ。** リトライの暴走、例外パスでの再入 | CloudWatch Logs `/aws/lambda/game-forge-bedrock-guard`、D1 の `generations` |
| 層 3（Budgets） | **台帳のずれ。** 計上漏れ、円換算の誤り、判定順序の誤り | Cost Explorer と D1 の費用台帳の突き合わせ |

**いずれもアプリ層のバグである。** 層 1 が正しく動いていれば、2 も 3 も発火しない。

発火の有無は外部層の受け入れ検証でも見える。Deny ポリシーが付いたままなら
`bedrock invoker permissions are minimal` が失敗する。

```bash
export AWS_PROFILE=game-forge-prod
aws iam list-attached-user-policies --user-name game-forge-bedrock-invoker
```

### 復旧手順（手動。自動化しない）

**自動で戻す経路をどこにも作っていない。** Lambda に detach の実装は無く、実行ロールにも
`iam:DetachUserPolicy` を与えていない。4.3 が「暴走の原因を調べる前に自動で戻すと、
同じ暴走を繰り返す」としているためである。

**原因を特定して直すまで、以下を実行しないこと。** 直っていない状態で戻すと、同じ
暴走がもう一度、同じ速さで走る。

```bash
export AWS_PROFILE=game-forge-prod
USER=game-forge-bedrock-invoker
HALT_ARN="$(terraform -chdir=terraform output -raw bedrock_halt_policy_arn)"

# 1. 何が付いているかを見る（付いていなければ、そもそも発火していない）
aws iam list-attached-user-policies --user-name "$USER"

# 2. 原因を調べる。層 2 なら関数のログ、層 3 なら Cost Explorer と D1 の台帳
aws logs tail /aws/lambda/game-forge-bedrock-guard --since 24h

# 3. 直してから外す
aws iam detach-user-policy --user-name "$USER" --policy-arn "$HALT_ARN"

# 4. 呼び出しが戻ったことを実測で確かめる（状態 API は当てにしない。2 章）
aws bedrock-runtime converse --region ap-northeast-1 \
  --model-id jp.anthropic.claude-sonnet-4-6 \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":8}'
```

**層 3 で撃たれた場合、外しても月内に再発する。** 予算は月次で、実績が下がらない限り
100% を超えたままだからである。月内に生成を再開するなら、**原因を直したうえで
`terraform/bedrock-guard.tf` の `bedrock_budget_prod_usd` を引き上げて apply する**か、
その月は停止したままにするかを選ぶことになる。**引き上げは仕様 4.3 の上限そのものを
動かす判断**なので、その場で決めずに記録を残すこと。

**鍵のローテーション（4 章）では復旧しない。** Deny はユーザーに付いており、鍵に
付いているのではない。新しいキーを作っても同じユーザーの権限を使うため、止まったままである。

### Control Tower（SCP）の影響

このアカウントは Control Tower の member である。**`terraform apply` が
`AccessDenied` で落ちたときは、IAM の権限不足ではなく SCP を先に疑うこと。**
SSO で引き受けているのは `AWSAdministratorAccess` なので、管理者にできない操作が
出るとすれば SCP が理由である。

```bash
aws organizations describe-organization        # 管理アカウントでのみ通る
```

member アカウントからは SCP の一覧を読めない。落ちた操作名を管理アカウント側で
確かめること。

---

## 6. まだ決まっていないこと

- **Bedrock のレートクォータを引き下げられるか**（層 4）。Service Quotas は増加要求の API
  しか持たない。引き下げられなければ層 4 は無いものとして運用する（仕様 4.3）。
- **Sonnet 5 の開放**（仕様 12 章 #2）。4.7 以降の世代がアカウントに開放されていない。
- **層 2 の発火を実地で試すか。** しきい値は 300 秒で 30 万トークンで、意図的に到達
  させると 600 円程度の実費が出る。**未発火のまま本番へ出す**か、一度撃って経路
  （アラーム → SNS → Lambda → Deny）を実測するかは決めていない。外部層の受け入れ
  検証は**経路の各段が存在すること**までは見るが、**撃ったら本当に止まること**は
  見ていない。
