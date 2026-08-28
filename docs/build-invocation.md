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
| R2 への書き込みと `games` 行の作成（3.3-6 / 3.3-8） | **#21** |
| コンパイル失敗時の自動リトライ | **#20** |
| `src/generate.ts` の `build` への結線 | **後続の単独 PR**（#17 と同じ 4 行を触るため） |

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

## 3. 資格情報（**未宣言。後続作業がある**）

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

### まだ宣言されていない（申し送り）

**本 issue は `terraform/` を触っていない。** したがって次の 2 つは未了である。

- `lambda:InvokeFunction` を**この関数の ARN だけ**に許す IAM ユーザーとポリシーの宣言。
- そのユーザーのアクセスキーの発行（**宣言しない。** `aws_iam_access_key` は
  tfstate へ平文で落ちるため。`docs/bedrock-access.md` 1 章と同じ理由で手作業）。

必要なポリシーは次のとおり。**`Resource` を `*` にしない**（このアカウントには他の
関数も置きうる。9.2）。

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

**それまでの間、この経路は設定不足として呼び出しの手前で落ちる**
（`BuildNotConfigured`。値ではなく**名前だけ**を報告する）。

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
- **Workers 側の上限は関数のタイムアウトより長くする**（`BUILD_INVOKE_TIMEOUT_MS` は
  30 + 5 = 35 秒）。短くすると先に諦めるのは呼び出し側になり、
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
- **索引を書くのは #21 である。** ビルド直後にここで書くと、まだ R2 に無い
  オブジェクトを指す索引ができる。`recordBuildCache` を、書き込みのあとで呼ぶ。

```
build(env, generated)
  ├ sourceCacheKey(source)
  ├ readBuildCache ─ hit ──> 関数を呼ばずに索引の内容を返す（cached: true）
  │                └ miss ─┐
  └────────────────────────┴> invokeBuildFunction ──> cached: false（本体つき）
                                                       ↑ このあと #21 が R2 へ書き、
                                                         recordBuildCache を呼ぶ
```

### 未解決の懸念（3.7 / M5-4 へ申し送り）

- **R2 のオブジェクトが作品をまたいで共有される。** ヒットとは「同じソースなら同じ
  成果物を指す」ことなので、複数の `games` 行が同一のオブジェクトを指しうる。
  3.7 のライフサイクルと M5-4 のゴミ掃除は「作品 1 件 = オブジェクト 1 組」を前提に
  書かれており、**参照している作品が残っているうちに消しうる。** 上の実在確認は
  新規生成を守るが、**既に公開済みの作品が壊れることは防げない。**
- **鍵に Go の版を混ぜていない**（3.8 の文言どおり）。Go を更新してもヒットは続き、
  その作品は古い版の成果物と `go_version` を受け取る。索引が版を持ち回るので
  **配信は壊れない**（3.5 の出し分けはそのまま効く）が、3.5 の
  「以後の新規ビルドのみ新バージョンになる」と読み方が割れうる。

---

## 7. 写しの追随

**次の 2 つは他所の宣言の写しである。** 変えたらこちらも直す。

| 値 | 正本 | 写し |
|---|---|---|
| 関数名 `game-forge-build` | `terraform/build-function.tf` の `local.build_function_name` | `wrangler.toml` の `BUILD_FUNCTION_NAME`（3 環境） |
| タイムアウト 30 秒 | 同 `local.build_function_timeout_seconds` | `src/build-client.ts` の `BUILD_FUNCTION_TIMEOUT_SECONDS` |

**機械照合を置いていない。** 照合するには Terraform の宣言を読む必要があり、
ローカル層（ネットワークも外部認証も要さない層）の検査としては
`terraform/*.tf` のテキスト解析になる。**ずれても安全側に倒れる**値であること
（関数名が違えば `ResourceNotFoundException` で即座に露見し、タイムアウトが短すぎれば
`BuildTimedOut('worker')` として degrade に乗る）から、いまは表で足りるとした。
どちらかが**黙って**壊れる形になったら、そのときに検査を置く。
