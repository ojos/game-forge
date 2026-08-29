# Workers からビルド関数を呼ぶ（3.3-5..7 / 3.8 / #19）

- 対象: #19（M2-5）
- 位置づけ: **関数の器は `docs/build-function.md`（#103）が持つ。** この文書が持つのは
  **呼び出し側**、すなわち認証・待ち時間・失敗の区別・ビルド結果キャッシュである。
- 実装: `src/build-client.ts`（呼び出し）/ `src/build-cache.ts`（キャッシュ）/
  `migrations/0002_build_cache.sql`（索引）

---

## 1. 分担

| 対象 | 持ち主 |
|---|---|
| ECR / Lambda 関数の宣言・入口・配備 | **#103**（`terraform/build-function.tf` / `docker/isolated-build/`） |
| **Workers からの呼び出し・認証・キャッシュ・失敗の区別** | **本文書（#19）** |
| 呼び出しに使う IAM ユーザーとポリシーの宣言 | **#115**（`terraform/build-invoker.tf`） |
| その鍵の発行・投入・ローテーション（宣言では持てない） | **本文書 3 章（#115）** |
| R2 への書き込みと `games` 行の作成（3.3-6 / 3.3-8） | **#21**（`docker/isolated-build/handler/r2.go` / `src/games.ts`。**実装済み**） |
| コンパイル失敗時の自動リトライ | **#20** |
| `src/generate.ts` の `build` / `createGame` への結線 | **#21 で完了**（`defaultPipeline`） |

---

## 2. 呼び出しの経路

```
Workers ──SigV4(lambda)──> POST https://lambda.<region>.amazonaws.com
                                 /2015-03-31/functions/<name>/invocations
                           X-Amz-Invocation-Type: RequestResponse
                           {"source": "package main\n…"}
```

- **同期呼び出し**（3.3-5）。応答は Lambda の同期上限 6 MB に収まる
  （q9 の実測 2,282,980 bytes。1.2.21）。
- **署名対象サービスは `lambda`。** Bedrock（署名名 `bedrock` / ホスト名
  `bedrock-runtime`）と違い、ホスト名と署名名は一致する。
- **`aws4fetch` の `sign` だけを使い、送信は自分で行う。** `AwsClient.fetch` は
  5xx / 429 を自前で再試行するが、**ビルドの再送は Lambda の課金時間の再発生**であり、
  3.3 の順序では費用計上（3.3-4）が既に済んでいる。再試行の判断は #20 が持つ
  （`src/bedrock.ts` と同じ方針）。

---

## 3. 資格情報

| 名前 | 置き場所 |
|---|---|
| `BUILD_AWS_REGION` / `BUILD_AWS_ACCESS_KEY_ID` / `BUILD_AWS_SECRET_ACCESS_KEY` | `.dev.vars` / Pages のシークレット |
| `BUILD_AWS_SESSION_TOKEN` | 同上。**SSO の一時資格情報を使うときだけ** |
| `BUILD_FUNCTION_NAME` | **`wrangler.toml` の `[vars]`**（秘密ではなく構成） |

**Bedrock 用（`BEDROCK_AWS_*`）と分けている。** 理由は 2 つある。

1. 用途が違うものには違う名前を付ける（`.dev.vars.example` の `BEDROCK_` 接頭辞と同じ方針）。
2. **権限が違う。** `terraform/bedrock.tf` の IAM ユーザーは `bedrock:InvokeModel` と
   `bedrock:InvokeModelWithResponseStream` だけを許しており、`lambda:InvokeFunction` を
   通せない。**最小権限を保つなら principal ごと分かれる。**

### プリンシパル（#115 で宣言した）

**`terraform/build-invoker.tf` が `game-forge-build-invoker` という IAM ユーザーを
宣言する。** 与えているのは `lambda:InvokeFunction` 1 つを、ビルド関数の ARN 1 つに
限った権限だけである。**`Resource` を `*` にしない**（このアカウントには他の関数も
置きうる。9.2。`lambda:InvokeFunction` on `*` は「アカウント内の全部の関数を呼べる鍵」
である）。

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "arn:aws:lambda:ap-northeast-1:<account-id>:function:game-forge-build"
  }]
}
```

**`lambda:*` を与えない。** それは `UpdateFunctionCode` を含み、**攻撃者が制御しうる
コードをコンパイルする関数**（7.1）の中身を、この鍵 1 本で差し替えられるということで
ある。配備の権限は OIDC のロール（`terraform/github-oidc.tf`）が別に持つ。

**最小権限であることは `scripts/acceptance-remote.sh` の
`build invoker permissions are minimal` が機械で見る。** 動作の集合・対象の ARN・
管理ポリシーが付いていないこと・**tfstate に `aws_iam_access_key` が 1 件も無いこと**
の 4 つで、期待値は `terraform output` から取る（検査へ書き写さない）。

> **#19 時点の記述（#115 で解消）。** 上の節はもともと「**まだ宣言されていない（申し送り）**」
> という見出しで、「本 issue は `terraform/` を触っていない。したがって次の 2 つは未了で
> ある ─ `lambda:InvokeFunction` を**この関数の ARN だけ**に許す IAM ユーザーとポリシーの
> 宣言／そのユーザーのアクセスキーの発行（**宣言しない。** `aws_iam_access_key` は
> tfstate へ平文で落ちるため。`docs/bedrock-access.md` 1 章と同じ理由で手作業）」と
> 書いていた。**旧記述はこの注記に残す。** 前者は #115 で宣言した。**後者は今も手作業で
> あり、そちらは解消していない**（下の「鍵の発行と投入」）。

**鍵を入れるまでの間、この経路は設定不足として呼び出しの手前で落ちる**
（`BuildNotConfigured`。値ではなく**名前だけ**を報告する）。

### 鍵の発行と投入（#115。**宣言では持てない範囲**）

**`aws_iam_access_key` を宣言しない。** 生成された秘密鍵が **tfstate へ平文で
書き込まれる**ためで、R2 の資格情報を `aws_ssm_parameter` で宣言しない理由
（`docs/build-function.md`）とも、`terraform/bedrock.tf` が Bedrock 用の鍵を宣言しない
理由とも同じ経路である。**したがって鍵の発行だけは手作業になる。**

**先に `terraform apply` を済ませること。** 鍵を発行する相手（IAM ユーザー）を作るのは
宣言側である。

```bash
export AWS_PROFILE=game-forge-prod

# ユーザー名は宣言から取る。ここへ綴りを書き写さない。
aws iam create-access-key \
  --user-name "$(terraform -chdir=terraform output -raw build_invoker_user_name)"
```

出力の `AccessKeyId` と `SecretAccessKey` を使う。**`SecretAccessKey` は発行時にしか
表示されない。**

**本番（Cloudflare Pages のシークレット）へ入れる。**

```bash
npx wrangler pages secret put BUILD_AWS_REGION --project-name game-forge          # ap-northeast-1
npx wrangler pages secret put BUILD_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BUILD_AWS_SECRET_ACCESS_KEY --project-name game-forge
```

- **名前の正本は `src/build-client.ts` の `BUILD_SECRET_NAMES` である。** ここは写しなので、
  あちらを変えたらこちらも直す。
- **`--project-name` を必ず付ける。** 省くと wrangler が対話で選ばせにいくため、
  非対話の手順として成立しない。
- **`BUILD_AWS_SESSION_TOKEN` は本番では登録しない。** 一時資格情報はローカルで SSO を
  使うときだけのものである（下の「ローカルで叩くとき」）。
- **`BUILD_FUNCTION_NAME` はシークレットではない。** `wrangler.toml` の `[vars]` が
  環境ごとに宣言するので、配備すればそのまま効く。
- **値をリポジトリへ書かない。** `scripts/check-no-secrets.sh` が毎回検査するが、検査に
  頼る前に、鍵の値が出るのは `create-access-key` の出力と `wrangler` の入力だけに保つ。

> **申し送り。** `docs/pages-deploy.md` 5 章が「どのシークレットをどのプロジェクトへ
> 入れるか」の正本だが、#115 の所有範囲外のため `BUILD_AWS_*` の行をあちらへ足して
> いない。**生成経路を実際に開くとき（#22 / `src/generate.ts` への結線）に、あちらへも
> 同じ 3 行を追記すること。**

**ローカル（`.dev.vars`）へ入れる。** 長命キーを手元へ置く必要は無い。ローカルは SSO の
一時資格情報で足りる（下の「ローカルで叩くとき」）。雛形は `.dev.vars.example` にある。

### ローテーション

**この手順が必要なのは、Workers が AWS の外で動くからである。** IAM ロールを引き受ける
経路が無く、長命のアクセスキーを Pages のシークレットへ置くしかない（4.1）。
**長命キーの唯一の対処がローテーションである。**

契機と間隔は `docs/bedrock-access.md` 4 章と同じにする（**漏洩の疑いは即時**、定期は
**90 日**、鍵に触れた人が離れたらその時点）。**鍵が 2 本ある以上、片方だけ回して
もう片方を忘れる形が最も起こりやすい。同じ間隔・同じ手順にしておくのはそのためである。**

```bash
export AWS_PROFILE=game-forge-prod
USER="$(terraform -chdir=terraform output -raw build_invoker_user_name)"

# 1. 新しいキーを作る（IAM ユーザーは同時に 2 本まで持てる。無停止で入れ替えられる）
aws iam create-access-key --user-name "$USER"

# 2. Pages のシークレットを新しい値へ更新し、配備して疎通を確認する
npx wrangler pages secret put BUILD_AWS_ACCESS_KEY_ID --project-name game-forge
npx wrangler pages secret put BUILD_AWS_SECRET_ACCESS_KEY --project-name game-forge
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
aws iam list-access-keys --user-name "$USER"
aws iam get-access-key-last-used --access-key-id <KEY_ID>
```

**有効な鍵が 1 本も無い状態は、外部層の検査が warn として出す**（落としはしない。
未発行は「宣言と外部状態の乖離」ではなく手順の途中であるため）。

### ローカルで叩くとき

9.2 のとおり **Dev アカウントに Lambda は無い。** ローカルからこの経路を通すには
本番アカウントの資格情報が要る（`AWS_PROFILE=game-forge-prod` の SSO を `.dev.vars` へ
転記する。手順は `.dev.vars.example` の Bedrock の項と同じ）。**これは確定20 が
受け入れた「本番構成をローカルで検証できない」の一部である。**

---

## 4. 待ち時間（1.2.24 の申し送りへの回答）

> **あわせて、#19（Workers → Lambda の同期呼び出し）で Cloudflare 側の待ち時間の
> 制約と突き合わせること。3.3-5 は同期呼び出しと定めており、30 秒はその上限に近い。**（1.2.24）

**結論: 同期のまま維持できる。Cloudflare 側に 30 秒を妨げる制約は無い。**
「30 秒はその上限に近い」という前提のほうが成り立たなかった。

### 調べたこと（出典はすべて developers.cloudflare.com）

| 論点 | 実際 | 出典 |
|---|---|---|
| Worker のリクエスト実時間 | **上限なし。** 「クライアントが接続している限り、Worker は処理・subrequest・応答のストリーミングを続けられる」 | [Workers limits # Duration](https://developers.cloudflare.com/workers/platform/limits/) |
| 個々の `fetch` subrequest | **時間の上限なし。** 「There is no set time limit on individual subrequests」。`fetch` の API 文書にもタイムアウトの記述が無い | [Workers limits # Subrequests](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU 時間 | Paid は既定 30 秒（`limits.cpu_ms` で最大 5 分）。**ネットワーク待ちは算入されない** | [Workers limits # CPU time](https://developers.cloudflare.com/workers/platform/limits/) |
| 524（Proxy Read Timeout） | **125 秒**（100 秒ではない）。ただしこれは **Cloudflare のプロキシがオリジンに対して持つもの**で、Worker の外向き subrequest の話ではない | [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) / [Connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) |
| Pages Functions | **Workers と同じ実行時制限**。`pages/functions/limits/` というページは無く、`limits` の設定も Workers と同じ | [Pages limits # Functions](https://developers.cloudflare.com/pages/platform/limits/) |
| `waitUntil` | 応答返却後 **30 秒**まで。**これはリクエスト全体の上限ではない** | [Context (ctx) # waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) |

### したがって

- **30 秒待つこと自体は CPU 時間を 1 ms も使わない。** 上限に効くのは Worker が
  実際に計算した時間だけである。
- **呼び出し側の上限は関数のタイムアウトより長くする**（`BUILD_INVOKE_TIMEOUT_MS` は
  45 + 5 = 50 秒。#164 で 30 + 5 から動いた）。短くすると先に諦めるのは呼び出し側になり、
  1. 関数はそのまま走り続けて課金され（4.6）、
  2. 返るのは中身の無い中断で、**どの段が時間を食ったかが残らない**（関数の `timings` も
     AWS の `Task timed out` も届かない）。
- 残る現実的な上限は **Cloudflare の外**にある。
  - **利用者のブラウザ（および間のプロキシ）のタイムアウト。** 30 秒は通常問題に
    ならないが、体験としては「無反応で 30 秒」である（4.4 / 2.2 の範囲）。
  - **Workers ランタイムの更新。** 更新時に in-flight のリクエストへ与えられる猶予が
    30 秒で、それを超えると打ち切られる。Cloudflare 自身が「長時間のリクエストと
    更新が重なる必要があるので極めて起こりにくい」としているが、**ゼロではない。**
    実測 21〜24 秒はこの 30 秒の内側にある。

> **#164 注記（2026-08-29）。この節の 2 点は、本番ではもう効かない。**
> **#160 以降、本番でビルド関数を呼ぶのはオーケストレータ Lambda（600 秒）であって
> Workers ではない**（利用者は作品ページで待つ）。ブラウザのタイムアウトも
> ランタイム更新の 30 秒猶予も、そちらの経路には無い。
>
> **効き続けるのは、Workers から同期で回す経路のほうである**（`src/generate.ts` の
> `createLambdaBuild`。ローカルと、オーケストレータを構成していない環境）。
> **タイムアウトを 45 秒へ広げ、時間切れ時に 1 回呼び直すようにしたので、
> この経路の最悪の待ちは約 95 秒になった。** 上の「30 秒の内側」はもう成り立たない。
>
> **95 秒であって 100 秒ではない**（`50 秒 × 2` にはならない）。呼び直すのは
> `BuildTimedOut` の `where === 'function'`、すなわち**関数側が理由付きで返した
> とき**だけである。そのとき 1 回目は関数のタイムアウト（45 秒）で返っており、
> 呼び出し側の上限（50 秒）まで待ってはいない。**50 秒まで待つのは `where='worker'`
> のときだけで、そちらは呼び直さない**（関数がまだ走っている可能性があるため）。
> したがって最悪は「関数側で 45 秒 ＋ 2 回目が応答を返さず 50 秒」の **45 + 50 = 95 秒**
> である。
>
> **本番の経路ではないことを承知のうえで受け入れる**——直すなら経路を非同期へ
> 寄せる話であって、タイムアウトを短く戻す話ではない。

### 非同期へ変えるとしたら（**本 issue では変えない**）

仕様を変える判断は本 issue の範囲外なので、材料だけを残す。

| 選択肢 | 効果 | 代償 |
|---|---|---|
| **同期のまま**（現状） | 3.3 の 8 段をそのまま保てる。実装が最も小さい | 利用者が最大 30 秒待つ。ブラウザ側のタイムアウトとランタイム更新の猶予に晒される |
| 同期のまま**短縮** | 待ちが減る | **メモリ上限の引き上げ（3,008 → 10,240 MB）待ち。** `docs/build-function.md` の申請が通れば 7.7 秒の見込みで、**実装を変えずに縮む** |
| Queues へ退避 | consumer の実時間 15 分。リトライが組み込み | 3.3 の順序が非同期になり、`games` 行の作成タイミングと 5.2 の画面遷移（確定4）を作り直す |
| Workflows へ退避 | step ごとの実時間が無制限。状態が永続化される | 同上に加えて依存が増える |

**推すのは「同期のまま、引き上げが通ったら短縮」である。** 非同期化は Cloudflare 側の
制約から要求されているものではなく、買うのは「30 秒待たせない体験」だけで、
代償として 3.3 の順序と確定4 の画面遷移を作り直すことになる。

---

## 5. 失敗の区別（3.8 の degrade / #20）

| 種別 | 型（`kind`） | 何が起きたか | 受け取る側 |
|---|---|---|---|
| ビルド失敗 | `BuildRejected`（`build`） | 生成コードがコンパイルを通らない。応答は **200 の `ok:false`** | **#20（自動リトライ）** |
| タイムアウト | `BuildTimedOut`（`timeout`） | 関数（`where='function'`）または Workers 側（`'worker'`）が打ち切った | 3.8 の degrade |
| 関数のエラー | `BuildFunctionFailed`（`function`） | 呼び出せない・スロットリング・関数が障害として失敗 | 3.8 の degrade |
| 応答が読めない | `BuildResponseUnreadable`（`function`） | 形が違う、成果物が申告と食い違う | 3.8 の degrade |
| 設定不足 | `BuildNotConfigured`（`config`） | 秘密や宛先が無い。**呼び出しの手前で落ちる** | 運用 |

- **ビルド失敗を関数の障害と混ぜない。** 関数側も同じ線引きをしている
  （`docker/isolated-build/handler/handler.go`: 利用者のコードの問題は 200 の `ok:false`）。
  混ぜると 3.8 の degrade（「ビルド依頼の失敗」で発火）が、利用者のコードの誤りで誤爆する。
- **逆に時間切れは `ok:false` で返らない**ことも関数側が保証している。
- タイムアウトの判定は 2 つの綴りに頼る（`Task timed out` / `context deadline exceeded`）。
  **外しても安全側に倒れる**（`BuildFunctionFailed` になり、degrade の扱いは同じ）。
- 例外は **`errorMessage` を持たない。** 失敗本文には brotli の標準エラーなど外から来た
  文字列が混ざりうるため（`src/bedrock.ts` の `BedrockCallFailed` と同じ理由）。
  代わりに **`x-amzn-RequestId` を持つ。** CloudWatch の該当ログへ辿る手掛かりになる。
- `BuildRejected` の Go 診断は `message` ではなく **`diagnostics`** に入る。
  **ログへ出さないこと**（8.3 の検査を通っていない文字列が生成コードの行を引用する）。

---

## 6. ビルド結果キャッシュ

**置き場は 3.8 が決めている。関数の外、すなわち R2 の既存オブジェクトと D1 の索引である。**
`/tmp` は実行環境ごとに分かれ、7.1 の掃除で毎回消えるため使えない。

- 鍵は **生成ソース（UTF-8）の SHA-256**（3.8 の「生成ソースのコンテンツハッシュ」）。
- 索引は `build_cache`（`migrations/0002_build_cache.sql`）。**成果物は持たない。**
  持つのは R2 のキー・Go の版・サイズとハッシュだけである。
- **ヒットの判定に R2 の実在確認（`head` 2 回）を含める。** 3.7（確定13）の
  「14 日間未公開なら自動削除」により、**索引だけが残る状態は平常に起こる。**
  消えていればミスとして扱い、索引の行も落とす。
- **索引を書くのは #21 である**（`src/games.ts` の `createDraftGame`）。ビルド直後に
  ここで書くと、**R2 へ書けたかどうかを知らないまま**索引ができる。関数の応答が
  キー（`storage`）を返した時点で成果物は R2 に在るので、そこから先で書く。
  **`games` 行を先に作り、そのあとで `recordBuildCache` を呼ぶ**（順序の理由は下記）。

```
build(env, generated)
  ├ sourceCacheKey(source)
  ├ readBuildCache ─ hit ──> 関数を呼ばずに索引の内容を返す（cached: true / entry）
  │                └ miss ─┐
  └────────────────────────┴> invokeBuildFunction ──> cached: false / keys
                                          ↑ 関数が R2 へ書き終えてから返る（3.3-6）
                                            このあと #21 が `games` 行を作り、
                                            そのあとで recordBuildCache を呼ぶ
```

**`games` 行を索引より先に作る。** 確定26 の削除規約は「索引を先に落とす → `games` を
数え直す → 消す」の順で走るため、索引だけが先にある窓では、掃除が「参照ゼロ」と
数えた直後に行ができてしまう。先に行があれば、掃除の数え直しがそれを見つける
（3.7 の「残る隙間を隠さない」は消えないが、**広げないほうの順序を選ぶ**）。

### 共有された成果物の削除規約（#116 / 確定26 で決着）

**R2 のオブジェクトは作品をまたいで共有される。** ヒットとは「同じソースなら同じ
成果物を指す」ことなので、複数の `games` 行が同一のオブジェクトを指しうる。
**確定26 は共有を正とし、削除する側に被参照チェックを課した**（規約は仕様書 3.7、
帰結は 3.4-7、比較した 3 案と費用も 3.7）。

> **v1.21 までの本節の記述（申し送り。決着済み）。** ここには「3.7 のライフサイクルと
> M5-4 のゴミ掃除は『作品 1 件 = オブジェクト 1 組』を前提に書かれており、**参照している
> 作品が残っているうちに消しうる**。上の実在確認は新規生成を守るが、**既に公開済みの
> 作品が壊れることは防げない**」と書いていた。**旧記述はこの注記に残す。**

- **削除側は `planArtifactDeletion` / `deleteUnreferencedArtifacts` を通す**
  （`src/build-cache.ts`）。消してよいのは、**その作品以外が参照していないキーだけ**である。
  `status` では絞らない（`removed` の tombstone も 5.3 が残すと決めた `source.go` の
  参照者である）。索引は `migrations/0004_games_artifact_key_idx.sql`。
- **索引（`build_cache`）を先に落としてから数え直して消す。** 逆順だと、消した直後の
  生成がまだヒットし、消えたオブジェクトを指す `games` 行が作られる。
- **数え直して「消さない」に決め直したら、落とした索引を戻す**（PR #121 のレビュー指摘）。
  放置すると成果物は残るのに再ビルドが 1 回増える（約 21 秒）。**戻すのは、消したキーを
  1 つも含まない索引で、かつ戻す直前に R2 に実在するものだけである。**
- **年齢だけで消すライフサイクルルールに、共有されうるオブジェクトを載せない。**
  R2 のライフサイクルは `games` を引けない（確定13 の判定の置き場は M5-4 へ移った。3.7）。
- **M5-4 のゴミ掃除そのものは未着手である。** ここで揃えたのは前提と規約だけで、
  `games` 行の tombstone 化と掃除の起動は M5-4 が持つ。

### 未解決の懸念（3.5 へ申し送り）

- **鍵に Go の版を混ぜていない**（3.8 の文言どおり）。Go を更新してもヒットは続き、
  その作品は古い版の成果物と `go_version` を受け取る。索引が版を持ち回るので
  **配信は壊れない**（3.5 の出し分けはそのまま効く）が、3.5 の
  「以後の新規ビルドのみ新バージョンになる」と読み方が割れうる。

  > **#21 の追記（2026-08-28）。上書きの危険だけは消えた。** 3.3-6 のキーは
  > `.wasm.br` にだけ Go の版を含める（`builds/<sha256>/<goVersion>/game.wasm.br`）。
  > **鍵（`build_cache.source_sha256`）は変えていない**ので上の申し送りはそのまま
  > 残るが、**索引が落ちたあとに同じソースを新しい Go で再ビルドしても、既存の作品が
  > 指しているオブジェクトを別の版の中身で上書きすることはない**（書き先が別のキーに
  > なる）。版をキーに入れなかった場合、その上書きは `go_version` が古いままの作品を
  > 黙って壊す（版の合わない `wasm_exec.js` で配信される）。

---

## 7. 写しの追随

**次の 2 つは他所の宣言の写しである。** 変えたらこちらも直す。

| 値 | 正本 | 写し |
|---|---|---|
| 関数名 `game-forge-build` | `terraform/build-function.tf` の `local.build_function_name` | `wrangler.toml` の `BUILD_FUNCTION_NAME`（3 環境） |
| タイムアウト 45 秒 | 同 `local.build_function_timeout_seconds` | `src/build-client.ts` の `BUILD_FUNCTION_TIMEOUT_SECONDS` |
| シークレット名 `BUILD_AWS_*` | `src/build-client.ts` の `BUILD_SECRET_NAMES` | 本文書 3 章の `wrangler pages secret put` / `.dev.vars.example` |
| IAM ユーザー名 `game-forge-build-invoker` | `terraform/build-invoker.tf` | 本文書 3 章（**コマンドは `terraform output` から取るので、綴りの写しは散文だけ**） |

**機械照合を置いていない。** 照合するには Terraform の宣言を読む必要があり、
ローカル層（ネットワークも外部認証も要さない層）の検査としては
`terraform/*.tf` のテキスト解析になる。**ずれても安全側に倒れる**値であること
（関数名が違えば `ResourceNotFoundException` で即座に露見し、タイムアウトが短すぎれば
`BuildTimedOut('worker')` として degrade に乗る）から、いまは表で足りるとした。
どちらかが**黙って**壊れる形になったら、そのときに検査を置く。
