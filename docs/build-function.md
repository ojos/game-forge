# ビルド関数（AWS Lambda）の運用手順

仕様書の 3.3 / 3.8 / 7.1 / 9.3 と確定24 が定めた**ビルド実行環境**の、宣言では持てない
部分を扱います。宣言は `terraform/build-function.tf` と `terraform/github-oidc.tf`、
実装は `docker/isolated-build/` にあります。

**このファイルが持つのは「宣言に持たせられない範囲」だけです。** 宣言できることは
宣言側にあります（`docs/bedrock-access.md` と同じ形）。

## 構成

| 対象 | 実体 |
|---|---|
| 関数 | `game-forge-build`（`package_type = "Image"`。メモリ **3,008 MB** / タイムアウト **45 秒** / 予約同時実行数 **5**） |
| イメージ | ECR の `game-forge/isolated-build`。`golang:<ピン留めした版>` を基にした約 1.6 GB。**版の正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION`**（確定12。更新の契機と根拠は確定12、手順は仕様書 3.5） |
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

**タイムアウトは 45 秒です。** 仕様 3.8 は当初 10 秒でしたが、**手元の 6,396 ms は
Lambda の代理になりませんでした**（3.3 倍）。25 秒 → 30 秒 → 45 秒と 3 回引き上げて
います。**値の導出は `terraform/build-function.tf` の
`build_function_timeout_seconds` が持ちます**（ここへ書き写しません）。

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
ためで、25 秒では余裕が 1.3 秒しかありませんでした。

**30 秒でも足りず、2026-08-29 に本番で利用者が踏みました**（#164。29,528 ms で
時間切れ。**7.94 円と日次枠 1 回が成果物なしで消えています**）。CloudWatch に残る
12 回の記録は 23.9 / 21.1 / 34.5 / 33.3 / 30.4 / 29.8 / 23.7 / 21.2 / 24.4 / 21.6 /
23.3 / 29.5 秒で、**中央値 24.2 秒に対して最悪値が 34.5 秒**です。**45 秒は
「最悪値 34.5 秒の 1.3 倍」と「中央値 24.2 秒の 1.8 倍」の両方を満たす最小の
5 の倍数**で、上限はオーケストレータの実行時間が与えます（#174 で式を引き直しました。
**数値はここに書きません**——正本は `terraform/orchestrator.tf` の宣言と、それを
機械照合する `scripts/check-orchestrator-retry.sh` です）。

**関数側の時間切れは、同じソースで 1 回だけ呼び直します**（#164。
`src/build-client.ts` の `invokeBuildFunction`）。**枠は 1 依頼につき 1 回**です
（#174。ビルドごとではありません）。**LLM は呼び直しません**——
時間切れには診断が無く、材料の無い再生成に約 16 円と日次枠 1 回を賭けることに
なるためです。呼び直しの費用は Lambda の 1 呼び出しだけで、**費用台帳の行も
日次クォータも増えません。**

**予約同時実行数は 5 です。** 一時は設定できませんでした（アカウントの同時実行総枠が
10 しかなく、予約を付けると残りが最低値 10 を割るため）。**2026-08-28 に引き上げが通り、
宣言どおりの 5 に戻っています**（総枠 1,000。仕様 1.2.25）。

**VPC には入れません。** 確定24 が v1.11 で VPC を外した理由は 7.1 にあります。
`vpc_config` を足すことは、DNS の持ち出しチャネル・実行ロールへの EC2 権限・
14 日アイドルでの初回失敗という 3 つの悪化を買い直すことです。

## 呼び出しの契約

**呼び出し側（Workers）は `docs/build-invocation.md` が持ちます**（#19。認証・待ち時間・
失敗の区別・ビルド結果キャッシュ）。ここが持つのは器の側の契約だけです。

**#160 で呼び出し元が変わりました。** この関数を呼ぶのは**オーケストレータ Lambda の
実行ロール**（`game-forge-orchestrator`）で、宣言は `terraform/orchestrator.tf` に
あります。生成の本体（3.3-3..8）が Worker の外へ移ったためで、**関数そのものは
1 バイトも変えていません**（下記）。

エッジの IAM ユーザー（`game-forge-build-invoker`）は残っていますが、許されている対象は
**オーケストレータ 1 つだけ**になりました（`terraform/build-invoker.tf`）。
**エッジの鍵でこの関数を直接叩く経路は閉じています。**

**ここ（実行ロール）とは別物です。** 実行ロールは関数が AWS を触るための権限で、
向こうは関数を呼ぶための権限です。

### この関数を無改造のままにした理由（7.1）

**ここは攻撃者が制御しうるコードをコンパイルする唯一の場所です。** 7.1 が現在の構成を
許容しているのは、「`go build` の RCE で攻撃者が得るものは R2 の書き込みだけ」という
前提の実測に支えられています。

オーケストレータを作るとき、生成（Bedrock）をこの関数へ足せば関数が 1 つで済みました。
**採りませんでした。** 足すと、同じ RCE で得られるものが **LLM の枠（日次・月次）と
作品行の書き換え**まで広がります。**オーケストレータは生成コードを一度もコンパイル
しません**（`src/orchestrator/pipeline.ts`）。

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
  "compressed": { "bytes": 2282839, "sha256": "…", "contentEncoding": "br" },
  "storage":    { "sourceKey": "builds/<sha256>/source.go",
                  "wasmKey":   "builds/<sha256>/go1.26.5/game.wasm.br" },
  "timings":    { "resetMs": 0, "prepareMs": 20, "buildMs": 4797, "compressMs": 539,
                  "uploadMs": 310, "totalMs": 5359 }
}
```

**この出力例は Go 1.26.5 時点の記録です。** `goVersion` と `wasmKey` の版は、同じ例の
`timings` の実測値と組になっています。**上の構成表と違って `ARG GO_VERSION` への参照へ
置き換えていないのは、置き換え損ねているからではありません。** 版だけを書き換えると、
**取り直していない実測値に新しい版の名前が付く**ためです（仕様書 3.5 の更新手順 7
「実測の記録は書き換えない」）。**Go を上げてもここは揃えません。**

- **生成コードがコンパイルを通らないことは、関数の障害ではありません。**
  `{"ok": false, "stage": "build", "message": "<go の診断>"}` が 200 で返ります。
  Runtime API のエラー経路へ流すと、3.8 の degrade 判定（「ビルド依頼の失敗」で
  発火する）が利用者のコードの誤りで誤爆します。
- **未圧縮 wasm の本体は返しません。** 8〜12 MB あり、Lambda の同期応答 6 MB を
  超えます。返るのはバイト数と sha256 だけです。
- **`.wasm.br` の本体も返しません（#21 で 3.3-6 が成立しました）。** 関数が R2 へ
  書き、返るのは `storage` のキーだけです。**`compressed.data` が入るのは
  `R2_UPLOAD=skip` で動かしたときだけ**で、それはローカルの封じ込め検査
  （`scripts/check-isolated-build.sh`。`--network=none` なので R2 へ届きません）専用です。

  > **旧記述（#21 より前）。** ここには「`compressed.data` は器の段階の暫定です。
  > **R2 への書き込み（3.3-6）は #21 が持ちます。**」と書いていました。**旧記述は
  > この注記に残します。**

- **R2 へ書けなかった呼び出しは `ok=false` になりません。** 利用者のコードは正しく
  ビルドできているので、**関数の障害**として返します（Runtime API のエラー経路）。
  呼び出し側は `BuildFunctionFailed` として受け取り、3.8 の degrade 判定に乗ります。
  **`ok=true` で成果物の無いキーを返す経路は作りません**（`games` 行だけができて
  404 を返す作品が生まれます）。

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

### 関数側の扱い（#21 / `docker/isolated-build/handler/r2.go`）

- **読むのは呼び出しのたびです。** 初期化で固めません（上の「ローテーション」が
  「再配備は要らない」と書いている前提を保つため）。ビルド 1 回が約 21 秒なのに対し、
  SSM の 1 往復は無視できます。
- **読むのはビルドと圧縮が終わったあとです。** ビルドが失敗する呼び出しでは読みません。
  攻撃者由来のコードをコンパイルしているあいだ、資格情報がメモリに載っている時間を
  短くします。
- **環境変数へ置きません。** `go build` の子プロセスへ `os.Environ()` が渡るためです。
  あわせて、**その子プロセスの環境から `AWS_*`（実行ロールの資格情報）を落とします**。
  実行ロールの鍵は R2 の鍵ではありませんが、**渡せば R2 の鍵を取りに行けます。**
- **`R2_CREDENTIALS_PARAMETER` が無ければ関数は起動しません。** `BROTLI_QUALITY` と
  同じ扱いです（宣言に無い状態で動き出さない）。**未設定を「書かない」と読み替えると、
  宣言から環境変数が落ちた日に 200 を返し続けたまま R2 には何も入りません。**
  R2 へ書かずに動かすとき（ローカルの封じ込め検査）は `R2_UPLOAD=skip` を明示します。
  **両方を指定したら起動しません**（暗黙の優先順位を作らないため）。
- **値を読めなかった・R2 へ書けなかった呼び出しは、関数の障害として失敗します。**
  エラーには状態コードと種別だけを残し、**応答本文もパラメータの値も出しません。**

### オブジェクトのキー（3.3-6 の命名。確定26）

```
builds/<生成ソースの SHA-256>/source.go
builds/<生成ソースの SHA-256>/<Go の版>/game.wasm.br
```

- **作品 id を含めません。** 確定26 は「R2 のオブジェクトは作品をまたいで共有される」を
  正としており、**キャッシュヒット時は関数を呼ばない**ので、作品ごとのキーは作れません。
  内容だけから決めることで、同じソースは必ず同じキーになります。
- ハッシュは `src/build-cache.ts` の `sourceCacheKey`（UTF-8 の SHA-256）と同じ値です。
- **`.wasm.br` にだけ Go の版を入れます。** 同じソースでも版が変われば wasm は別物で、
  版を入れないと**再ビルドが既存の作品のオブジェクトを別の版の中身で上書きします**
  （その作品の `go_version` は古いままなので、3.5 の出し分けが壊れます）。
- **`builds/` にライフサイクルルールを置きません**（3.7 の規約 3）。年齢だけで消す
  ルールは `games` を引けないため、共有されうるオブジェクトを載せられません。
- `.wasm.br` には `Content-Type: application/wasm` と `Content-Encoding: br` の**両方**を
  付けます（3.4-1 / 3.4-2）。**どちらも署名対象のヘッダ**なので、経路上で書き換えられれば
  署名が壊れます。`source.go` は配信物ではないので圧縮も `Content-Encoding` もありません。

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
  `GOARCH`、つまり**ハンドラのバイナリだけ**です。ベースイメージ（`golang:` にピン留めした版。
  正本は `ARG GO_VERSION`）はホストのアーキテクチャで引かれるため、**aarch64 の開発機では
  arm64 のベースに amd64 のバイナリが入った、どちらでも動かないイメージ**が出来ます。
  関数は `x86_64` で宣言してあります。
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
| Lambda の関数メモリ上限 3,008 MB → **10,240 MB** | **審査中。** ビルドを 21.1 秒から 7.7 秒へ縮めるために要る（約 7,200 MB 以上で 10 秒に収まる） | AWS Support のコンソール |

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
| メモリ上限 | `build_function_memory_mb` 3008 → **10240**、`build_function_timeout_seconds` 45 → **20** |
| 同時実行数 | `build_function_reserved_concurrency` `null` → **5** |

```bash
terraform -chdir=terraform apply
VERIFY_ACCEPTANCE=scripts/acceptance-remote.sh bash scripts/verify.sh
```

**タイムアウトを 10 秒へは戻しません。20 秒です**（#164）。10,240 MB でも
ビルド 7.7 秒 ＋ compress 2.4 秒 ＝ 約 10.1 秒で、コールドの上振れ（+2 秒）を見れば
実効 12 秒になります。**10 秒は最初から余裕がありません。** 45 秒を決めたときの規則
（中央値の 1.8 倍）を当てると 12 × 1.8 = 21.6 秒で、20 秒がその下限にほぼ一致します。

**それでも下げること自体は必要です。** 10,240 MB では時間切れ 1 回が
10.24 GB × 45 秒 = 461 GB 秒（約 1.19 円）になり、いまの 10 倍を焼きます。
**メモリを上げる apply と、タイムアウトを下げる apply を分けないでください。**

**メモリを上げたら、実際の所要時間を Lambda 上で測り直してください。** 7.7 秒は
外挿であり、実測ではありません。手順は「実測のとり方」のとおりです。**測り直した
値で 20 秒の余裕を確かめ、足りなければ 20 秒のほうを動かします**（規則は
`terraform/build-function.tf`）。

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
aws lambda update-function-configuration --function-name game-forge-build --timeout 45
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

3.5 の手順に従います。**版の正本は `docker/isolated-build/Dockerfile` の `ARG GO_VERSION`**
で、`FROM` の行はその値から組み立てられるため触りません（#101）。`ARG GO_VERSION` と
`docker/isolated-build/template/go.mod` / `docker/isolated-build/handler/go.mod` の
`go` ディレクティブが揃っていないと、イメージのビルドが落ちます（`GOTOOLCHAIN=local` を
入れてあるため。**黙って新しいツールチェインを取りに行くよりよい**）。

### `wasm_exec.js` を新しい版のぶんだけ足す（3.5 手順 5 / #139）

**イメージを作り直しただけでは終わりません。** 配信側は `games.go_version` から
`runtime/<版>/wasm_exec.js` を引き、**置かれていない版へ別の版を配らず 500 にします**
（`src/sandbox-delivery.ts`）。すなわち**この段を忘れると、新しくビルドした作品だけが
プレイできなくなります。**

**#101 が「3 点のうちこの段だけは機械が見ていない」と書いたのがここです。** いまは
3 本のスクリプトが持ちます。**どれも版の一覧を書き写しません。**

| スクリプト | 役割 |
|---|---|
| `scripts/wasm-exec-versions.sh` | **要る版の正本。** `ARG GO_VERSION`（これから作る版）と D1 の `games.go_version`（すでにある版）から導く |
| `scripts/put-wasm-exec.sh` | イメージから `docker cp` で取り出し、R2 の `runtime/<版>/wasm_exec.js` へ置く |
| `scripts/check-wasm-exec-objects.sh` | 要る版が R2 に在ることを検査する（終了コードと `WASM_EXEC_PASS`） |

```bash
bash scripts/check-wasm-exec-objects.sh --remote   # 足りない版が名指しで出る
bash scripts/put-wasm-exec.sh --remote             # 足りない版を置く（**本番 R2 へ書きます**）
bash scripts/check-wasm-exec-objects.sh --remote   # 緑を確認する
```

- **既存の版のものは消しません**（3.5）。過去の作品は `go_version` に従って旧版の
  `wasm_exec.js` で配信され続けます。
- **取り出しは `docker cp` です。** `docker run ... cat` の標準出力には載せません
  （出力はまるごと失われることがあり、しかも終了コードは 0 のまま。上の「手元で動かす」）。
- **版はイメージ自身に申告させます。** タグを信じず、コンテナ内の `go env GOVERSION` を
  ファイルへ書いて取り出し、要求した版と照合します。一致しなければ置きません。
- 取り出し元は既定で `golang:<版>`（Dockerfile の `FROM` と同じイメージ）です。
  `wasm_exec.js` は Go の配布物そのもので、隔離ビルドイメージが積む層は触らないため、
  1.51 GB のイメージを作らずに済みます。`--image` で明示すればそちらからも取れます。

## brotli の品質

**q11 は 3.8 の 10 秒に収まりません。** 実測（当時の想定配分 2 vCPU / 3,538 MB。**実際の本番は上記のとおり 3,008 MB＝1.70 vCPU で、下の数字より遅くなります**）:

| 品質 | ビルド | 圧縮 | 合計 | 圧縮後 |
|---|---|---|---|---|
| q11 | 4,785 ms | 12,148 ms | **16,960 ms** | 1,985,786 B |
| q10 | 4,770 ms | 6,425 ms | **11,219 ms** | 2,091,967 B |
| **q9** | 4,797 ms | 539 ms | **5,359 ms** | 2,282,839 B |

現在の宣言は **q9** です（`terraform/build-function.tf` の `local.build_brotli_quality`）。
変えるときは宣言を変えてください。**関数もローカルの検査も、そこから値を読みます。**
