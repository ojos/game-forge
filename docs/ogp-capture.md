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

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --profile game-forge-prod --query Account --output text)"
REGION=ap-northeast-1
REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/game-forge/ogp-shot"

aws ecr get-login-password --region "$REGION" --profile game-forge-prod \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

docker buildx build --platform linux/amd64 -t "${REPO}:latest" --push docker/ogp-shot
```

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

関数名・撮る大きさ・コールバックの綴り・**ローダーの合図の id**・待ち時間の 5 組を
突き合わせる。とくに合図の id がずれると**撮影が必ず時間切れになる**（合図が永遠に
来ない）が、その症状からこの原因へは辿りにくい。

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
| **本番で 1 枚も撮っていない** | イメージのビルドも push も apply も未実施 |
| メモリ 2,048 MB / タイムアウト 60 秒 | **見積もりであって実測ではない。** 最初の撮影で `Max Memory Used` と `Duration` を見て決め直す |
| 合図のあとの待ち時間 1,500 ms | 同上（`docker/ogp-shot/index.mjs` の `FIRST_FRAME_SETTLE_MS`）。撮れた画像が黒い・白いなら、まずここを疑う |
| `@sparticuz/chromium` / `puppeteer-core` の版 | **未検証。** `npm install` が解決できなければ実在する版へ直す。通った版はここへ記録する |
| WebGL | `chromium.setGraphicsMode = true` を明示している。**切れていると真っ黒な画像が「成功」として撮れる** |
| `capturing` のまま残った行の撮り直し | **経路が無い。** 関数ごと落ちた場合（OOM・タイムアウト）はコールバックが飛ばない。D1 に痕跡は残るが、進める手段は手作業の UPDATE だけである |
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
