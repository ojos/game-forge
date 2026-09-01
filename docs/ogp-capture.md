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

`migrations/0009_games_ogp.sql` が `games` へ 3 列足し、`migrations/0012_games_ogp_started_at.sql`
が**撮影を始めた時刻**を 1 列足す（#235。10 章）。**デプロイでは走らない。**

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

**忘れると、公開の UPDATE ではなく撮影の UPDATE（`ogp_state`）が
「no such column」で落ちる。** **0012 を忘れても同じ形で落ちる**——`ogp_started_at` を書くのは
`ogp_state` と同じ 1 本の UPDATE だからである（#235。`src/ogp.ts` の `claimOgpCapture`）。
**しかも公開そのものは成立したうえで応答が 500 になる**（`games` の行は `published` に
なっている）。この節の見出しのとおりで、**0009 と 0012 は 1 組として適用すること。** 0002〜0005 を忘れて 16.75 円を捨てた前例がある
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
- `ogp_state='capturing'` のまま … 撮影が返ってきていない。**900 秒を過ぎていれば中断である**（10 章）
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
| ~~**`CAPTURE_TIMEOUT_MS` 20,000 ms**~~ | **30,000 ms へ改めた**（2026-09-01。#219。根拠は 9 章）。公開時の実測は 7.9〜16.9 秒で、**最悪 16,907 ms のとき、天井 20,000 ms に残る余裕は 3,093 ms（天井の 15%）しか無かった。** 同じ作品が 7.1〜16.9 秒でぶれるので、**ぶれ 1 回分に足りない。** Lambda の 60 秒より内側なのは変わらない |
| 合図のあとの待ち時間 1,500 ms | **足りていた**（`docker/ogp-shot/index.mjs` の `FIRST_FRAME_SETTLE_MS`）。1 枚目に「読み込み中」は写らなかった。撮れた画像が黒い・白いなら、まずここを疑う |
| 撮る大きさ・待ち時間の受け渡し | 関数は環境変数だけを見る（既定値を持たない）。**宣言が欠けると起動時に落ちる**ので、`terraform apply` の前に `bash scripts/check-ogp-copies.sh` を通すこと |
| `@sparticuz/chromium` / `puppeteer-core` の版 | **`docker/ogp-shot/package.json` の宣言のままで解決できた**（2026-08-31。`npm install` は無改変で通った） |
| WebGL | `chromium.setGraphicsMode = true` を明示している。**切れていると真っ黒な画像が「成功」として撮れる。** 1 枚目は正しく描画された（雲・ブロック・自機まで写っている） |
| ~~`capturing` のまま残った行の撮り直し~~ | **入った**（#235。10 章）。作者が作品ページから撮り直せる。検出は `bash scripts/ogp-stale-report.sh`。**手作業の UPDATE はもう要らない** |
| `failed` で終わった行の撮り直し | **経路が無い。** #235 が扱ったのは `capturing` のまま残った行だけである。`failed` は「撮ろうとして撮れなかった」ことが分かっている状態で、**同じ作品をもう一度撮れば同じ結果になりうる**（原因が作品側にあるなら、回数を重ねても変わらない）。踏んでから決める |
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

**`CAPTURE_TIMEOUT_MS` は 2026-09-01 に 30,000 ms へ決めた**（#219。導出は下の
「決めた値」）。**この表はそのあとも足し続ける**——値を動かしたら実測を取り直すのが 1 組で
あり、天井の妥当性はこの表からしか言えない。

**1 枚では決められなかった。**「典型なのか外れ値なのか」が分からず、実際に**1 枚目だけが
突出していた**（そして 2 回目以降で再現しなかった）。

読み方: CloudWatch の `REPORT` 行を読む。**`Duration` は `Init Duration` を含まない**ので、
内側の締め切り（`CAPTURE_TIMEOUT_MS`）と直接比べられるのは `Duration` のほうである。

```bash
aws logs filter-log-events \
  --profile game-forge-prod \
  --region ap-northeast-1 \
  --log-group-name /aws/lambda/game-forge-ogp \
  --filter-pattern 'REPORT' --output text --query 'events[].message'
```

**「余裕」は天井を基準にした割合である**（`scripts/build-time-report.sh` の `NEAR_RATIO` と
同じ数え方。天井に対して何割残っているか）。

| 公開 (UTC) | 作品 | `Duration` | 旧天井 20,000 ms への余裕 | `Init Duration` | `Max Memory Used` | 備考 |
|---|---|---|---|---|---|---|
| 2026-08-31 14:11 | `ff7d397e` | **16,907 ms** | 3,093 ms（15%） | 2,425 ms | 689 MB | 1 枚目。**この wasm を初めて配信した回でもある** |
| 2026-08-31 14:19 | `03af7a90` | 10,159 ms | 9,841 ms（49%） | 816 ms | 695 MB | `ff7d397e` の子（火の玉） |
| 2026-08-31 14:22 | `1fde2625` | **7,850 ms** | 12,150 ms（61%） | ウォーム | 695 MB | `03af7a90` の子（3 段ジャンプ） |
| 2026-08-31 21:30 | `0b34dd8a` | 10,261 ms | 9,739 ms（49%） | 712 ms | 688 MB | 系統の外 |
| 2026-08-31 23:13 | `135b0c6a` | 10,261 ms | 9,739 ms（49%） | 696 ms | 692 MB | 生成の 95 秒後に公開 |
| 2026-09-01 03:34 | `ff7d397e` | 11,534 ms | — | 666 ms | 685 MB | **同じ作品の 2 回目**（以降は公開経路ではなく関数を直接叩いた） |
| 2026-09-01 04:10 | `ff7d397e` | 9,508 ms | — | 845 ms | 637 MB | 連続 1 回目 |
| 2026-09-01 04:10 | `ff7d397e` | **7,064 ms** | — | ウォーム | 637 MB | 連続 2 回目（7 秒後） |
| 2026-09-01 04:45 | `03af7a90` | 9,414 ms | — | 774 ms | 689 MB | 画像 16.6 KB |
| 2026-09-01 04:45 | `1fde2625` | 7,088 ms | — | ウォーム | 689 MB | 画像 16.6 KB |
| 2026-09-01 04:45 | `0b34dd8a` | 7,260 ms | — | ウォーム | 689 MB | 画像 **35.9 KB** |
| 2026-09-01 04:45 | `135b0c6a` | 7,941 ms | — | ウォーム | 689 MB | 画像 22.8 KB |

**余裕の欄は公開時の 5 枚にだけ書いてある。** 直接叩いた回は撮影の条件（温度）が違うので、
天井に対する余裕として並べない。

**画像の複雑さは効いていない。** 15.3〜35.9 KB に対して所要は 7.1〜9.4 秒で、相関が無い。

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

#### 仮説（**まだ確かめていない**）: 配信キャッシュの温度

`src/sandbox-delivery.ts` の `cacheControlFor` は、不変資材（wasm）へ
**`public, max-age=31536000, immutable`** を付ける。**その作品の wasm がエッジに載って
いなければ、11 MB を R2 まで取りに行く。**

実測の並びは、これと整合する。

| 作品 | 生成 → 公開 | `Duration` |
|---|---|---|
| `ff7d397e` | **3 日空いた** | **16,907 ms** |
| `03af7a90` | 5 分後 | 10,159 ms |
| `1fde2625` | 2 分後 | 7,850 ms |

**確かめた（2026-09-01）。** 同じ作品を続けて叩き、**コンテナ温度という対抗仮説を消した。**

| 回 | `Duration` | `Init` |
|---|---|---|
| 1（08-31 の公開時） | **16,907 ms** | 2,425 ms（コールド） |
| 2 | 11,534 ms | 666 ms（**コールド**） |
| 3 | 9,508 ms | 845 ms（**コールド**） |
| 4（3 の 7 秒後） | **7,064 ms** | ウォーム |

**`Init` が付いた 3 回だけを並べても 16,907 → 11,534 → 9,508 と下がり続ける。**
`Duration` は `Init Duration` を含まないので、**コンテナの温まりでは説明できない。**
3 回とも別コンテナなのに下がる以上、**呼び出しをまたいで共有されている何か**が効いている。

**それでも証明ではない。** 時間帯やネットワークのぶれは残る。**言えるのは「コンテナ温度
ではない」ところまで**である。

**この仮説が正しい場合、16.9 秒は外れ値ではなくなる。** OGP は**公開時に 1 回だけ**撮る。
**作者が公開前に遊んでいなければ、その 1 回はいつも冷えた側を引く**——つまり
**起こりうる通常の場合**である。天井をどちらに合わせるかが変わる。

#### 決めた値: `CAPTURE_TIMEOUT_MS = 30000`（2026-09-01。#219）

**割合はすべて天井を基準にする**（`scripts/build-time-report.sh` の `NEAR_RATIO` と同じ）。

| 天井 | 最悪実測 16,907 ms のときに残る余裕 | 天井に対する割合 |
|---|---|---|
| 旧 20,000 ms | 3,093 ms | **15%** |
| **新 30,000 ms** | 13,093 ms | **44%** |

**20,000 ms の 3,093 ms は、同じ作品のぶれ（最大 9,843 ms）1 回分に足りない。**
30,000 ms は `ogp_function_timeout_seconds`（60 秒）より内側なので、諦めたあとに失敗の
コールバックを送る余地も残る。

| | |
|---|---|
| 公開時の 5 枚 | 7,850 / 10,159 / 10,261 / 10,261 / **16,907 ms** |
| 同じ作品（`ff7d397e`）を 4 回 | **7,064〜16,907 ms**（2.4 倍） |
| 決めた天井 | **30,000 ms**（最悪実測の 1.78 倍） |

**16.9 秒を外れ値として捨てていない。** 下記のとおり、公開時の撮影はいちばん冷えた側を
引きうるからである。

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

---

## 10. 中断したままの撮影を回収する（#235）

### 10.1 何が残るのか

**撮影関数は、自分で諦めたときは必ず失敗のコールバックを送る**（`docker/ogp-shot/index.mjs`
が `png === null` のとき `{"error":"capture-failed"}` を送り、受け側の `failOgpCapture` が
`failed` へ落とす）。**したがって `capturing` のまま残るのは、送る余地が無かった場合だけ**である。

- Lambda のタイムアウト（60 秒）で切られた
- メモリ不足などでプロセスごと死んだ
- コールバックの送信中に切られた

**この 3 つでは D1 に痕跡が残らない。** 経過時間だけが手掛かりになる。

**2026-09-02 の時点で、本番ではまだ 1 件も出ていない**（公開 5 枚はすべて `ready`。9 章）。
**踏む前に直した形である。**

### 10.2 検出（読み取りのみ）

```bash
bash scripts/ogp-stale-report.sh              # OGP_STALE_NONE / OGP_STALE_FOUND
bash scripts/ogp-stale-report.sh --format json
```

終了コードは **0 = 無い / 1 = 有る / 2 = 判定できなかった**（未認証・道具が無い）。
**1 と 2 を混ぜない**——「中断が有った」と「調べられなかった」は別である。

閾値（900 秒）と起点の式は **`src/ogp.ts` から取り出している**（書き写していない）。
定数を改名すると `bash scripts/check-ogp-copies.sh` が赤くなる。

### 10.3 撮り直し（**作者が押す。手作業の UPDATE はしない**）

**口は作品ページにある。** 中断していると、作者にだけ「スクリーンショットを撮り直す」が出る
（`POST /api/ogp/recapture`。`src/ogp-recapture.ts`）。

```
作品ページ →「スクリーンショットを撮り直す」→ 掴み直す → Lambda → コールバック → ready
```

- **二度撮りの関門は緩めていない。** 公開の経路が通るのはいまも `ogp_state is null` の行
  だけで、撮り直しは**互いに排他なもう 1 本の UPDATE**（`capturing` かつ期限切れ）である
- **掴み直すとトークンが差し替わる。** 遅れて届いた 1 通目のコールバックは 404 で弾かれ、
  **R2 も書かれない**（照合は `BUCKET.put` より前にある）
- **連打しても走るのは 900 秒に 1 回**（掴んだ時点で起点の時刻が動く）
- **生成の枠は使わない**（LLM を呼ばないので台帳に行が増えない。1 枚 約 0.1 円）

### 10.4 なぜ「自動で回収」ではないのか

| 案 | 採らなかった理由 |
|---|---|
| 定期実行（cron）で掃除する | **Pages に `scheduled` は無い**（確定22。このプロジェクトは Workers ではなく Pages である）。口を置く場所そのものが無い |
| 作品ページを開いたら回収する | **GET が状態を書き換える形にしない**（`src/work-page.ts` の `STALE_AFTER_SECONDS`）。ページを開いた人が行を壊せる |
| 運用スクリプトから本番 D1 を直接 UPDATE | **関門の SQL が `src/ogp.ts` の外にもう 1 本できる。** #26 が「撮影の権利は 1 本の UPDATE を通った者だけが得る」と決めた形が崩れる |

**9 章の「撮り直さずに測る」は、いまも撮り直しの手段ではない。** ダミートークンでの直接呼び出しは
コールバックが 404 で弾かれ、画像は保存されない。**あれは「測る」経路である。**
