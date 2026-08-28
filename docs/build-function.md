# ビルド関数（AWS Lambda）の運用手順

仕様書の 3.3 / 3.8 / 7.1 / 9.3 と確定24 が定めた**ビルド実行環境**の、宣言では持てない
部分を扱います。宣言は `terraform/build-function.tf` と `terraform/github-oidc.tf`、
実装は `docker/isolated-build/` にあります。

**このファイルが持つのは「宣言に持たせられない範囲」だけです。** 宣言できることは
宣言側にあります（`docs/bedrock-access.md` と同じ形）。

## 構成

| 対象 | 実体 |
|---|---|
| 関数 | `game-forge-build`（`package_type = "Image"`。メモリ **3,008 MB** / タイムアウト **30 秒** / 予約同時実行数 **5**） |
| イメージ | ECR の `game-forge/isolated-build`。`golang:1.26.5` を基にした約 1.6 GB |
| 入口 | `docker/isolated-build/handler/`（Lambda Runtime API を自前で回す。依存 0 件） |
| 配備 | `.github/workflows/deploy-compiler.yml`（OIDC。長命の鍵を持たない） |
| ログ | `/aws/lambda/game-forge-build`（14 日保持。**生成ソースも成果物も出しません**） |

**メモリが 3,008 MB なのはアカウントの上限です。** 仕様は 3,538 MB（2 vCPU ちょうど）を
指していましたが、`CreateFunction` が
`'MemorySize' value failed to satisfy constraint: Member must have value less than or equal to 3008`
で 400 を返します。Lambda のメモリ上限は 10,240 MB のアカウントと 3,008 MB のアカウントが
あり、これは後者です。**Service Quotas には項目自体が無く**（`L-548AE339` は
`NoSuchResourceException`）、引き上げは AWS Support のケースになります。3,008 MB は
**1.70 vCPU 相当**です（仕様 1.2.22 / #103）。

**タイムアウトが 25 秒なのは、Lambda 上の実測が 21.1 秒だからです。** 仕様 3.8 は当初
10 秒でしたが、**手元の 6,396 ms は Lambda の代理になりませんでした**（3.3 倍）。

| 段 | Lambda（3,008 MB） | 手元（`--memory=3008m --cpus=1.7`） |
|---|---|---|
| build | 18,562 ms | 5,842 ms |
| compress (q9) | 2,373 ms | 524 ms |
| **合計** | **21,086 ms** | 6,396 ms |

**build は vCPU 数にほぼ完全に反比例します**（1,769 MB で 30,788 ms / 2,048 MB で
26,955 ms / 3,008 MB で 18,562 ms）。**10 秒に収めるには約 7,200 MB 以上**が要り、
10,240 MB なら 7.7 秒の見込みです。**compress は 2,400 ms でほぼ一定**（brotli は
単一スレッドなので vCPU を増やしても縮みません）。

**コールドスタートの `Init Duration` は 475 ms**で、1.65 GB のイメージでも無視できます。
**ただし別の遅れがあります。** コールドの 1 回目は `buildMs` 自体が 2 秒伸び
（20,654 ms 対 18,551 ms）、合計 **23,685 ms** になります。ページキャッシュが冷えている
ためで、**タイムアウトが 30 秒なのはこの幅を見込んでのことです**（25 秒では余裕が
1.3 秒しかありませんでした）。

**予約同時実行数がないのは、このアカウントでは設定できないからです**（下の「引き上げの申請」）。

**VPC には入れません。** 確定24 が v1.11 で VPC を外した理由は 7.1 にあります。
`vpc_config` を足すことは、DNS の持ち出しチャネル・実行ロールへの EC2 権限・
14 日アイドルでの初回失敗という 3 つの悪化を買い直すことです。

## 呼び出しの契約

**呼び出し側（Workers）は `docs/build-invocation.md` が持ちます**（#19。認証・待ち時間・
失敗の区別・ビルド結果キャッシュ）。ここが持つのは器の側の契約だけです。

**呼ぶ権限も向こう側です。** `lambda:InvokeFunction` をこの関数の ARN 1 つに限った
IAM ユーザー（`game-forge-build-invoker`）は `terraform/build-invoker.tf` が宣言し、
その鍵の発行・投入・ローテーションは `docs/build-invocation.md` 3 章が持ちます（#115）。
**ここ（実行ロール）とは別物です。** 実行ロールは関数が AWS を触るための権限で、
向こうは関数を呼ぶための権限です。

入力（Workers 側の実装は #19 が持ちます）:

```json
{ "source": "package main\n\nfunc main() { ... }\n" }
```

出力:

```json
{
  "ok": true,
  "goVersion": "go1.26.5",
  "wasm":       { "bytes": 11404411, "sha256": "…" },
  "compressed": { "bytes": 2282839, "sha256": "…", "contentEncoding": "br", "data": "<base64>" },
  "timings":    { "resetMs": 0, "prepareMs": 20, "buildMs": 4797, "compressMs": 539, "totalMs": 5359 }
}
```

- **生成コードがコンパイルを通らないことは、関数の障害ではありません。**
  `{"ok": false, "stage": "build", "message": "<go の診断>"}` が 200 で返ります。
  Runtime API のエラー経路へ流すと、3.8 の degrade 判定（「ビルド依頼の失敗」で
  発火する）が利用者のコードの誤りで誤爆します。
- **未圧縮 wasm の本体は返しません。** 8〜12 MB あり、Lambda の同期応答 6 MB を
  超えます。返るのはバイト数と sha256 だけです。
- `compressed.data` は器の段階の暫定です。**R2 への書き込み（3.3-6）は #21 が持ちます。**

## R2 の資格情報

**値は Terraform が持ちません。** SSM Parameter Store の SecureString
`/game-forge/prod/r2-credentials` に置き、関数は名前だけを環境変数で受け取ります。

**なぜ宣言しないのか。** `aws_ssm_parameter` を宣言すると、Terraform は refresh の
たびに**復号済みの値を tfstate へ書き込みます。** `lifecycle { ignore_changes = [value] }`
は差分を無視するだけで、state への取り込みは止まりません。これは
`terraform/bedrock.tf` と `terraform/build-invoker.tf` が `aws_iam_access_key` を
宣言しない理由と**同じ経路**です。

宣言が持つのは次の 3 つです。

- パラメータの**名前**（`local.r2_credentials_parameter_name`）
- 実行ロールがそれを**読める**こと（`ssm:GetParameter` を 1 つの ARN に限定）
- 実行ロールがそれを**復号できる**こと（`kms:Decrypt`。`kms:ViaService` と
  `kms:EncryptionContext:PARAMETER_ARN` の 2 条件でこのパラメータだけに絞る）

### 投入

R2 のトークンは Cloudflare のダッシュボード（R2 > API > Manage API tokens）で
発行します。1 つの JSON にまとめて 1 回で書きます。**分けて書くと、片方だけ
更新された状態が生まれます。**

```bash
export AWS_PROFILE=game-forge-prod

# 値はシェルの履歴へ残さない。ヒアドキュメントを直接パイプで渡す。
aws ssm put-parameter \
  --name "$(terraform -chdir=terraform output -raw r2_credentials_parameter_name)" \
  --type SecureString \
  --overwrite \
  --value "$(cat <<'JSON'
{
  "accountId": "…",
  "accessKeyId": "…",
  "secretAccessKey": "…",
  "bucket": "…"
}
JSON
)"
```

### ローテーション

同じコマンドを `--overwrite` 付きでもう一度実行します。関数の再配備は要りません
（読むのは実行時です）。Cloudflare 側の旧トークンは、新しい値が入ったことを
確認してから失効させます。

### 確認

**値は読みません。** 型と存在だけを見ます。

```bash
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Values=/game-forge/prod/r2-credentials" \
  --query 'Parameters[0].[Name,Type,LastModifiedDate]' --output table
```

`scripts/acceptance-remote.sh` の `r2 credentials are outside the declaration` が
同じことを機械で確かめ、あわせて **tfstate に `aws_ssm_parameter` が 1 件も無い**
ことも見ます。

## 初回の構築

**イメージの無い ECR に対しては関数を作れません。** 順序が要ります。

```bash
export AWS_PROFILE=game-forge-prod
export GITHUB_TOKEN="$(gh auth token)"

# 1. ECR と OIDC ロールまでを作る（関数はまだ作れない）
terraform -chdir=terraform apply -target=aws_ecr_repository.isolated_build

# 2. イメージを 1 つ push する
repo="$(terraform -chdir=terraform output -raw build_image_repository_url)"
aws ecr get-login-password | docker login --username AWS --password-stdin "${repo%%/*}"
docker build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg TARGETARCH=amd64 -t "${repo}:latest" docker/isolated-build
IMAGE="${repo}:latest" bash scripts/check-isolated-build.sh   # 配る現物を検査する
docker push "${repo}:latest"

# 3. 残り（関数・ロール・ロググループ・Actions 変数）を作る
terraform -chdir=terraform apply

# 4. R2 の資格情報を入れる（上の「投入」）

# 5. 外部層の検査を通す
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

**手順 2 の 2 つのフラグは、どちらも #103 で実際に踏んだものです。**

- **`--platform linux/amd64`。** `--build-arg TARGETARCH=amd64` が決めるのは Dockerfile 内の
  `GOARCH`、つまり**ハンドラのバイナリだけ**です。ベースイメージ `golang:1.26.5` はホストの
  アーキテクチャで引かれるため、**aarch64 の開発機では arm64 のベースに amd64 のバイナリが
  入った、どちらでも動かないイメージ**が出来ます。関数は `x86_64` で宣言してあります。
- **`--provenance=false --sbom=false`。** 既定では BuildKit が attestation を足し、push される
  のが単一のマニフェストではなく **OCI の image index**（`application/vnd.oci.image.index.v1+json`）
  になります。**Lambda はこれを受け付けません。**

  ```
  InvalidParameterValueException: The image manifest, config or layer media type
  for the source image ... is not supported.
  ```

  ECR 側の実体は `aws ecr batch-get-image --repository-name ... --image-ids imageTag=latest
  --query 'images[0].imageManifest'` で読めます。`manifests` の配列が見えたら index です。

**手順 2 は 1 回きりです。** 以降は `deploy-compiler.yml` が amd64 のランナー上で組み、
**封じ込めの検査を通してから**押します。手元のイメージは初回に関数を作るためだけの
足場であり、次の配備で置き換わります。

**手順 3 で Actions のリポジトリ変数が 4 つ設定されます**
（`AWS_REGION` / `AWS_DEPLOY_ROLE_ARN` / `BUILD_IMAGE_REPOSITORY` / `BUILD_FUNCTION_NAME`）。
それまで `deploy-compiler.yml` の配備段は skip します（イメージのビルドと封じ込めの
検査は最初から毎回走ります）。

**Control Tower の member アカウントです。** apply が `AccessDenied` で落ちたときは、
権限不足ではなく **SCP を先に疑ってください**（`docs/bedrock-access.md` と同じ注記）。

## 引き上げの申請（2 件）

**2 件とも 2026-08-27 に申請しました。同時実行数は通り、メモリ上限は審査中です。**

| 対象 | 状態 | 経路 |
|---|---|---|
| Lambda の同時実行数 10 → **1,000** | **完了**（2026-08-28。ケース `178783057000696` は `CASE_CLOSED`）。予約同時実行数 5 を戻し済み | Service Quotas |
| Lambda の関数メモリ上限 3,008 MB → **10,240 MB** | **審査中。** 3.8 のタイムアウトを 10 秒へ戻すために要る（約 7,200 MB 以上で 10 秒に収まる） | AWS Support のコンソール |

**通ったかどうかは、宣言ではなく実際の値で確かめます。**

```bash
# 同時実行数
aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions'   # 10 -> 1000

# メモリ上限は照会できる項目が無いので、実地に試すのが唯一の判定になる
aws lambda update-function-configuration --function-name game-forge-build --memory-size 10240
# 通れば緩和済み。ValidationException なら審査中。**必ず 3008 へ戻すこと。**
```

### 同時実行数（Service Quotas）

```bash
aws service-quotas request-service-quota-increase \
  --service-code lambda --quota-code L-B99A9384 --desired-value 1000

# 状態を見る
aws service-quotas list-requested-service-quota-change-history-by-quota \
  --service-code lambda --quota-code L-B99A9384 \
  --query 'RequestedQuotas[0].{Status:Status,Desired:DesiredValue,Case:CaseId}'
```

**要求値を既定（1,000）より小さくできません。** `--desired-value 100` は
`You must provide a quota value greater than the default quota value of 1000.0`
で弾かれます。**適用値が 10 でも、基準になるのは既定のほうです。** 必要なのは 15
（予約 5 ＋ 未予約の最低値 10）ですが、その値では申請できないので既定へ戻す形になります。

> **#103 の途中で「Service Quotas からは申請できない」と書いたのは誤りでした。**
> 弾かれたのは要求値が既定より小さかったためで、経路が無いからではありません。

### 関数メモリ上限（Support のコンソール）

**こちらは本当に Service Quotas に項目がありません。** 適用値の一覧
（`list-service-quotas`）にも既定の一覧（`list-aws-default-service-quotas`）にも無く、
`L-548AE339` は `NoSuchResourceException` を返します。`Max allocated MicroVM memory`
（`L-CD1C0CC4`）は Lambda Managed Instances 用の別物です。

そして `aws support` は有料プラン必須で、このアカウントは Basic です
（`describe-severity-levels` が `SubscriptionRequiredException`）。
**コンソールからの起票が唯一の経路です。**

1. <https://support.console.aws.amazon.com/support/home#/case/create> を開く
2. 種別に **「サービス制限の引き上げ」**（Service limit increase）を選ぶ
3. 制限タイプに **Lambda**、リージョンは **アジアパシフィック (東京) / ap-northeast-1**
4. 本文には**実測を添える**と早い

   - 関数メモリ上限 3,008 MB → 10,240 MB。3,008 MB でのビルド実測が 21.1 秒、
     必要な予算は 10 秒。build は vCPU 数に反比例し、10,240 MB で 7.7 秒の見込み

### 通ったあとにやること

**2 件は独立して効きます。片方だけ通ったら、その分だけ先に戻せます。**

| 通ったもの | 宣言（`terraform/build-function.tf`） |
|---|---|
| メモリ上限 | `build_function_memory_mb` 3008 → **10240**、`build_function_timeout_seconds` 25 → **10** |
| 同時実行数 | `build_function_reserved_concurrency` `null` → **5** |

```bash
terraform -chdir=terraform apply
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

**メモリを上げたら、10 秒に収まることを Lambda 上で測り直してください。** 7.7 秒は
外挿であり、実測ではありません。手順は「実測のとり方」のとおりです。

仕様書の 3.8 / 3.3-5 / 確定24 / 4.6 にも注記が要ります（1.2.23 と対になる形で）。

## 実測のとり方

**手元の数字は Lambda の代理になりません**（3.3 倍の開きがあります）。予算の判定は
必ず関数の上で取ります。

```bash
export AWS_PROFILE=game-forge-prod
jq -Rs '{source: .}' < docker/isolated-build/sample/ebitengine.go > /tmp/event.json

aws lambda invoke --function-name game-forge-build \
  --cli-binary-format raw-in-base64-out --payload file:///tmp/event.json \
  --log-type Tail --query 'LogResult' --output text /tmp/resp.json | base64 -d | grep REPORT

jq '.timings' /tmp/resp.json    # resetMs / prepareMs / buildMs / compressMs / totalMs
```

**1 回目は捨ててください**（`Init Duration` が乗ります）。**予算を超えると
`timings` は返りません**。ハンドラが内部期限で先に落ち、`errorMessage` だけが返るためです。
所要時間を知りたいときは、先にタイムアウトを広げてから測ります。

```bash
aws lambda update-function-configuration --function-name game-forge-build --timeout 120
aws lambda wait function-updated --function-name game-forge-build
# …測る…
aws lambda update-function-configuration --function-name game-forge-build --timeout 25
```

**測り終えたら宣言値へ戻すこと。** 戻し忘れは `terraform plan` と
`scripts/acceptance-remote.sh` の両方が検出します。

## 以降の配備

`main` への push（`docker/isolated-build/**` を含むもの）と `workflow_dispatch` が
契機です。ワークフローは ECR へ push し、**ダイジェストで** `update-function-code` を
呼び、載ったことを読み返して確認します（9.3）。

手で配り直す場合は上の手順 2 と、

```bash
digest="$(aws ecr describe-images --repository-name "$(terraform -chdir=terraform output -raw build_image_repository_name)" \
  --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text)"
aws lambda update-function-code \
  --function-name "$(terraform -chdir=terraform output -raw build_function_name)" \
  --image-uri "${repo}@${digest}"
```

## 手元で動かす

Lambda を経由せず、同じイメージ・同じハンドラを `docker run` で叩けます。
**ただしこれは本番構成の検証ではありません**（`scripts/check-isolated-build.sh` の
冒頭の表）。

```bash
bash scripts/check-isolated-build.sh
```

**成果物を標準出力で受け取らないでください。** docker の attach 経由の出力は、
標準入力が EOF に達したあと数秒走り続けると**まるごと失われます**（終了コードは 0 の
まま。docker 28.5.1 / docker-outside-of-docker で確定的に再現）。検査スクリプトは
名前付きボリュームと `docker cp` で取り出しています。

## Go を更新するとき

3.5 の手順に従います。`docker/isolated-build/Dockerfile` の `FROM` と
`docker/isolated-build/handler/go.mod` の `go` ディレクティブ、
`docker/isolated-build/template/go.mod` の 3 か所を同じ版に揃えてください。
`GOTOOLCHAIN=local` を入れてあるため、揃っていないとイメージのビルドが落ちます
（**黙って新しいツールチェインを取りに行くよりよい**）。

## brotli の品質

**q11 は 3.8 の 10 秒に収まりません。** 実測（当時の想定配分 2 vCPU / 3,538 MB。**実際の本番は上記のとおり 3,008 MB＝1.70 vCPU で、下の数字より遅くなります**）:

| 品質 | ビルド | 圧縮 | 合計 | 圧縮後 |
|---|---|---|---|---|
| q11 | 4,785 ms | 12,148 ms | **16,960 ms** | 1,985,786 B |
| q10 | 4,770 ms | 6,425 ms | **11,219 ms** | 2,091,967 B |
| **q9** | 4,797 ms | 539 ms | **5,359 ms** | 2,282,839 B |

現在の宣言は **q9** です（`terraform/build-function.tf` の `local.build_brotli_quality`）。
変えるときは宣言を変えてください。**関数もローカルの検査も、そこから値を読みます。**
