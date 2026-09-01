# OGP 画像の撮影（5.4 / 11.2 / #26）

- 位置づけ: **公開時に初回フレームを 1 枚撮る仕組みの、配備と運用の手順。** 設計の正本は
  仕様書 5.4 / 11.2 と、各ファイルの冒頭コメントにある。ここへ複製しない。
- 対象読者: これを本番へ載せる人（**利用者の端末で叩く手順が要る**）。

---

## 1. 何が起きるか

```
[利用者] 試遊画面で「公開して共有」
    ↓ POST /api/publish                                    src/publish.ts
[Worker] games を draft → published（published_at を記録）  src/games.ts
    ↓ 撮影の権利を取る（ogp_state: null → capturing）       src/ogp.ts
    ↓ Lambda を非同期で呼ぶ（Event。応答は待たない）        src/ogp-client.ts
[利用者] 作品ページへ戻る（ここまで数百 ms）
                    ↓ 数秒
[Lambda] https://sandbox.../g/<game_id>/ を chromium で開く  docker/ogp-shot/
         ローダーの合図（#gf-status が隠れる）を待つ
         1200×630 の PNG を 1 枚撮る
    ↓ POST /api/ogp/callback（本文が PNG そのもの）
[Worker] R2 へ置く → games.ogp_key / ogp_state='ready'      src/ogp.ts
    ↓
[作品ページ] og:image が出る（/ogp/<game_id>.png）           src/work-page.ts
```

**公開の応答は撮影を待たない。** 5.4 が「1タップに畳んでフォーク連鎖の遅延を最小化する」と
定めているためで、撮影の数秒を公開の押し心地に載せない。

## 2. なぜ AWS で撮るのか

**Cloudflare Browser Rendering は Workers の有料プラン（$5/月）を要求する。** 3.2 の
「Workers は無料枠」と 4.6 の「実質ゼロ」の両方を崩すため採らない。5.5 が Cloudflare
Email Sending を退けて Resend を採ったのと**同じ理由・同じ結論**である。

AWS には既にビルド関数とオーケストレータが居り、呼び出しの資格情報（`BUILD_AWS_*`）も
IAM も配備の形も出来ている。**足したのは関数 1 つと、許可 1 つだけである。**

- 新しい鍵は 1 本も増えていない（`src/ogp-client.ts`）
- 実行ロールが持つのは**自分のログを書く許可だけ**（`terraform/ogp-function.tf`）
- **R2 の資格情報を撮影関数へ渡していない。** 撮れた PNG はコールバックで Worker へ戻り、
  R2 バインディングを持つ Worker が書く

## 3. 配備（**利用者の端末で叩く**）

**順序が要る。** ECR が空のまま `terraform apply` すると、関数の作成が「イメージが無い」で
落ちる（`image_uri` は `ignore_changes` なので、宣言側は配るイメージを知らない）。

### 3.1 ECR リポジトリを先に作る

```bash
set -a; . scripts/load-project-env.sh; set +a   # CLOUDFLARE_API_TOKEN を載せる
aws sso login --profile game-forge-prod --use-device-code

cd terraform
terraform apply -target=aws_ecr_repository.ogp_shot
```

### 3.2 イメージを作って push する

**`linux/amd64` で作ること**（関数は x86_64。Apple Silicon の既定は arm64 で、
そのまま push すると関数が `Runtime.InvalidEntrypoint` で落ちる）。

**`--provenance=false --sbom=false` と `oci-mediatypes=false` が要る。** これを落とすと
`terraform apply` が **400 で落ちる**（下記）。

```bash
cd "$(git rev-parse --show-toplevel)"   # 3.1 で terraform/ にいるので戻る

ACCOUNT_ID="$(aws sts get-caller-identity --profile game-forge-prod --query Account --output text)"
REGION=ap-northeast-1
REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/game-forge/ogp-shot"

aws ecr get-login-password --region "$REGION" --profile game-forge-prod \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

docker buildx build --platform linux/amd64 \
  --provenance=false --sbom=false \
  --output type=image,oci-mediatypes=false,push=true \
  -t "${REPO}:latest" docker/ogp-shot
```

**なぜ 3 つ要るのか**（2026-08-31 に実際に踏んだ）。

```
InvalidParameterValueException: The image manifest, config or layer media type
for the source image ... is not supported.
```

**Lambda が受け付けるのは Docker Image Manifest V2 schema2 だけ**である。ところが
`docker buildx build --push` の既定は 2 つの意味でこれを外す。

| フラグ | 落とすと何が起きるか |
|---|---|
| `--provenance=false` / `--sbom=false` | 添付（attestation）が付き、**イメージインデックス**（`application/vnd.oci.image.index.v1+json`）になる。Lambda はマニフェストリストを受け付けない |
| `oci-mediatypes=false` | メディアタイプが `application/vnd.oci.image.manifest.v1+json` になる。Lambda は Docker V2 schema2 を要求する |

**エラー文からは buildx の既定が原因だと辿れない。** イメージの中身は正しく、形式だけが違う。

**push したら、apply の前に形式を確かめること**（1 秒）。

```bash
aws ecr describe-images --repository-name game-forge/ogp-shot --region ap-northeast-1 \
  --profile game-forge-prod \
  --query 'imageDetails[?contains(imageTags||`[]`, `latest`)].imageManifestMediaType' --output text
```

**`application/vnd.docker.distribution.manifest.v2+json`** と出れば通る。`oci` を含む値なら
apply は必ず 400 で落ちるので、フラグを付けて push し直す。

### 3.3 残りを apply する

```bash
cd terraform
terraform plan     # 差分を読む
terraform apply
```

### 3.4 イメージを差し替えるとき

`latest` を打ち直したうえで、**関数へ反映させる**（`image_uri` は `ignore_changes` なので
terraform は追随しない）。

```bash
aws lambda update-function-code \
  --function-name game-forge-ogp \
  --image-uri "${REPO}:latest" \
  --profile game-forge-prod
```

## 4. 本番 D1 のマイグレーション（**忘れると公開そのものが 500 になる**）

`migrations/0009_games_ogp.sql` が `games` へ 3 列足す。**デプロイでは走らない。**

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

**忘れると、公開の UPDATE ではなく撮影の UPDATE（`ogp_state`）が
「no such column」で落ちる。** 0002〜0005 を忘れて 16.75 円を捨てた前例がある
（docs/handoff.md 3 章）。

## 5. Worker 側に要るもの

- `wrangler.toml` の `OGP_FUNCTION_NAME`（**3 つの環境すべて**に書いてある。
  vars は名前付き環境へ引き継がれない）
- `BUILD_AWS_*`（**既にある**。オーケストレータを呼ぶのに使っている鍵をそのまま使う）

**新しい secret の登録は要らない。**

## 6. 確かめかた

### 6.1 写しの照合（ネットワーク不要・1 秒）

```bash
bash scripts/check-ogp-copies.sh   # OGP_COPIES_PASS
```

関数名・撮る大きさ・コールバックの綴り・**ローダーの合図の id**・待ち時間・
**撮影関数が要求する環境変数の名前**の 6 組を突き合わせる。とくに合図の id がずれると
**撮影が必ず時間切れになる**（合図が永遠に来ない）が、その症状からこの原因へは辿りにくい。

**撮影関数は値の写しを 1 つも持たない。** 撮る大きさも待ち時間も、宣言
（`terraform/ogp-function.tf` の `environment`）が無ければ**起動の時点で落ちる**
（`docker/ogp-shot/config.mjs`）。既定値を置くと、宣言が落ちても関数は自前の値で
走り続け、**宣言と実物がずれたまま検査が緑になる。** 上の照合は、その代わりに
「名前が両方にあること」を両方向に見る。

### 6.2 本番で 1 枚撮る

**生成をやり直す必要は無い。** 既にある完成済みの作品を 1 つ公開すればよい
（1 回 約 16〜19 円かかるのは生成であって、公開ではない）。

```bash
# 撮影の状態を見る
npx wrangler d1 execute DB --remote --env production \
  --command "select id, status, ogp_state, ogp_key from games where status = 'published' order by published_at desc limit 5"
```

- `ogp_state='ready'` … 撮れている。`https://app.game-forge.ojos.jp/ogp/<id>.png` が引ける
- `ogp_state='capturing'` のまま … 撮影が返ってきていない（下記 7 章）
- `ogp_state='failed'` … 撮影関数が「撮れなかった」と言ってきた。ログを見る

```bash
aws logs tail /aws/lambda/game-forge-ogp --since 30m --profile game-forge-prod
```

### 6.3 カードの見え方

X / Slack / Discord はそれぞれ独自にクロールする。**`https://app.game-forge.ojos.jp/works/<id>`**
を貼って確かめること（`/g/<id>/` ではない。メタタグを持つのは作品ページのほうである）。

## 7. まだ無いもの・未検証のもの

**この節を消さないこと。** 出来ていないことを出来ているように書かないための一覧である。

| 項目 | 状態 |
|---|---|
| ~~**本番で 1 枚も撮っていない**~~ | **2026-08-31 に 4 枚撮れた**（4 回の公開で 1 枚ずつ）。1 枚目 `ff7d397e` は 1200×630 / 15,311 バイトで、初回フレームが正しく写っている。**実測は 9 章** |
| メモリ 2,048 MB / タイムアウト 60 秒 | **実測: `Max Memory Used` 688〜695 MB（34%）/ `Duration` 7,850〜16,907 ms**（コールドスタートは別。9 章）。1 枚あたり約 0.1 円。**メモリを下げないこと**——買っているのは RAM ではなく vCPU で、下げると撮影が遅くなり、下の `CAPTURE_TIMEOUT_MS` の余裕を削る |
| **`CAPTURE_TIMEOUT_MS` 20,000 ms** | **まだ決められない**（#219）。余裕は最小 3.1 秒・最大 12.2 秒で、**16,907 ms は 4 枚中の最大であって典型ではない。** 突出した 1 枚が「重い作品だから」なのか「1 枚目だから」なのかが分かれていない（9 章）。Lambda の 60 秒より内側の 20 秒が先に切る |
| 合図のあとの待ち時間 1,500 ms | **足りていた**（`docker/ogp-shot/index.mjs` の `FIRST_FRAME_SETTLE_MS`）。1 枚目に「読み込み中」は写らなかった。撮れた画像が黒い・白いなら、まずここを疑う |
| 撮る大きさ・待ち時間の受け渡し | 関数は環境変数だけを見る（既定値を持たない）。**宣言が欠けると起動時に落ちる**ので、`terraform apply` の前に `bash scripts/check-ogp-copies.sh` を通すこと |
| `@sparticuz/chromium` / `puppeteer-core` の版 | **`docker/ogp-shot/package.json` の宣言のままで解決できた**（2026-08-31。`npm install` は無改変で通った） |
| WebGL | `chromium.setGraphicsMode = true` を明示している。**切れていると真っ黒な画像が「成功」として撮れる。** 1 枚目は正しく描画された（雲・ブロック・自機まで写っている） |
| `capturing` のまま残った行の撮り直し | **経路が無い。** 関数ごと落ちた場合（OOM・タイムアウト）はコールバックが飛ばない。D1 に痕跡は残るが、進める手段は手作業の UPDATE だけである。**#219 では扱わないと決めた**（9 章の末尾に理由） |
| 公開後のタイトル変更 | 無い。題名は生成のプロンプト由来のまま公開される（5.4 は 1 タップを優先している） |
| CI からのイメージ配備 | 無い。`.github/workflows/deploy-compiler.yml` はビルド関数のイメージだけを扱う |

## 8. 費用

| 項目 | 見積もり |
|---|---|
| Lambda | 2 GB × 約 8 秒 = 16 GB 秒。**1 枚あたり約 0.04 円** |
| ECR | イメージ 400 MB 前後 × 3 世代。無料枠 500 MB/月 を**超える可能性がある**（保持数を 3 に絞ってある） |
| R2 | 1 枚 100〜400 KB。無料枠 10 GB に対して無視できる |

**生成（1 回 約 16〜19 円）に対して 3 桁小さい。** 公開のたびに 1 回だけ走り、
二度押しでは走らない（`src/ogp.ts` の関門）。

## 9. 撮影の実測（**1 枚撮るたびに 1 行足す**）

**`CAPTURE_TIMEOUT_MS` は、この表が埋まるまで決めない**（#219）。1 枚では「典型なのか
外れ値なのか」が分からず、実際に**1 枚目だけが突出していた。**

読み方: CloudWatch の `REPORT` 行を読む。**`Duration` は `Init Duration` を含まない**ので、
内側の締め切り（`CAPTURE_TIMEOUT_MS`）と直接比べられるのは `Duration` のほうである。

```bash
aws logs filter-log-events \
  --profile game-forge-prod \
  --region ap-northeast-1 \
  --log-group-name /aws/lambda/game-forge-ogp \
  --filter-pattern 'REPORT' --output text --query 'events[].message'
```

| 公開 (UTC) | 作品 | `Duration` | 20,000 ms への余裕 | `Init Duration` | `Max Memory Used` | 備考 |
|---|---|---|---|---|---|---|
| 2026-08-31 14:11 | `ff7d397e` | **16,907 ms** | 3,093 ms（15%） | 2,425 ms | 689 MB | 1 枚目。**この wasm を初めて配信した回でもある** |
| 2026-08-31 14:19 | `03af7a90` | 10,159 ms | 9,841 ms（49%） | 816 ms | 695 MB | `ff7d397e` の子（火の玉） |
| 2026-08-31 14:22 | `1fde2625` | **7,850 ms** | 12,150 ms（61%） | ウォーム | 695 MB | `03af7a90` の子（3 段ジャンプ） |
| 2026-08-31 21:30 | `0b34dd8a` | 10,261 ms | 9,739 ms（49%） | 712 ms | 688 MB | 系統の外 |
| 2026-09-01 03:34 | `ff7d397e` | **11,534 ms** | 8,466 ms（42%） | 666 ms | 685 MB | **同じ作品の 2 回目**（下記。公開経路ではなく関数を直接叩いた） |

### 2 回目を測った結果（2026-09-01）

**16,907 ms は再現しなかった。** 同じ作品・同じ構成で **11,534 ms**、差は **5,373 ms** である。

| | `ff7d397e` の `Duration` |
|---|---|
| 1 回目（08-31 14:11。公開経路） | **16,907 ms** |
| 2 回目（09-01 03:34。関数を直接叩いた） | **11,534 ms** |

**撮れた絵は同じである**（15,311 バイト → 15,462 バイト）。作品も関数の構成も変えていない。

#### 言えること / 言えないこと

- **言えること: #219 の起票時の前提「作品が重くなるほど伸びる」だけでは説明がつかない。**
  同じ作品が 5.4 秒ぶれ、しかも `ff7d397e` の**子**（機能が増えている `03af7a90` /
  `1fde2625`）のほうが速い
- **言えないこと: 5.4 秒の差の原因。** 「初回特有」と決めつけない——**2 回目の配信経路が
  温まっていた保証は無く、1 点では因果を特定できない。** 温度を変えて測り直すか、
  同じ作品を続けて 2 回叩いて差を見るのが次の手である
- **新しく分かったこと: 同じ作品でも 11.5〜16.9 秒の幅がある。** これは天井の決め方に
  直接効く——**いちばん重い作品に余裕を積むのではなく、同じ作品のぶれにも余裕が要る**

#### 天井を決めるときの線（提案。決定は #219）

**最大実測 16,907 ms に、同じ作品のぶれ（5,373 ms）を足した上を取る。** 20,000 ms は
最大実測に対して 3,093 ms（15%）しか無く、**ぶれ 1 回分に足りない。**

**実測を増やす経路**: 公開できる下書きを公開すれば 1 枚ずつ増える。**公開は生成枠を使わない**
（`generations` の行が増えないため）。

### 撮り直さずに測る（公開経路を通さない）

**撮り直しの経路は無い**（7 章）。`src/ogp.ts` の二度押しの関門が `ogp_state is null` なので、
**公開済みの作品は公開操作から再撮影されない。** 測るだけなら関数を直接叩けばよい。

```bash
aws lambda invoke \
  --function-name game-forge-ogp \
  --region ap-northeast-1 \
  --profile game-forge-prod \
  --invocation-type RequestResponse \
  --cli-read-timeout 90 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"gameId":"<作品 id>","ogpToken":"0000000000000000000000000000000000000000000000000000000000000000"}' \
  /tmp/ogp-recapture.json
```

**本番の状態は動かない。** ダミートークンのコールバックは **404 で弾かれる**——
`ogpCaptureIsPending` が `ogp_state='capturing'` を要求し、公開済みの行は `ready` だからである。
**照合は `BUCKET.put` より前に置かれている**ので（`src/ogp.ts`）、R2 も書かれない。
`completeOgpCapture` / `failOgpCapture` も `ogp_state='capturing'` が条件で、0 行更新になる。

```
{"at":"captured","gameId":"ff7d397e-…","bytes":15462}
{"at":"callback","gameId":"ff7d397e-…","ok":true,"status":404}   ← 弾かれている
```

**これは「測る」だけで「撮り直す」ものではない。** 画像は保存されないので、
`capturing` のまま残った行を進める手段にはならない（7 章）。

**実測を増やす経路**: 公開できる下書きを公開すれば 1 枚ずつ増える。**公開は生成枠を使わない**
（`generations` の行が増えないため）。

### 時間切れの後始末は #219 では扱わない（決定）

**`ogp_state='capturing'` のまま残る問題は、この issue の範囲に入れない。**

- #219 の goal は「**重い作品でも撮影が時間切れにならないようにする**」——すなわち
  `CAPTURE_TIMEOUT_MS` を実測から決めることである
- 後始末は「**時間切れが起きたあと**」の話で、7 章の「`capturing` のまま残った行の撮り直し」
  ——つまり **#26 の未実装そのもの**である
- **天井を上げても時間切れの確率は下がるだけで 0 にはならない。** 回収の経路は、値の決定とは
  独立に要る。**同じ issue に畳むと、値が決まるまで回収も止まる**
- **1 つの継ぎ目を触る 2 issue は同じレーンに畳む**（`docs/handoff.md` 4 章）が、ここは
  継ぎ目が違う（宣言の値 と 状態機械の回収経路）

**別 issue にする価値はある。** 起票は intake を通すこと。
