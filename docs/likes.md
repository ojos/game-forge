# いいね（Durable Objects）の運用手順

いいねの正本を D1 の外（Durable Objects）に置いた経路（仕様 5.8 / #339）の、配備と確認の手順。

**コードの正本は `workers/likes/`（Worker `game-forge-likes` と DO `LikeHub`）と
`src/likes.ts`（Pages 側の窓口）** で、**宣言の正本は `workers/likes/wrangler.toml` と、
ルートの `wrangler.toml` の `LIKE_HUB`** である。この文書が持つのは、宣言で表せない手順
——初回の配備、権限、確認のしかた——だけである。

## なぜ 2 つ目の Cloudflare のデプロイ単位が要るのか

**D1 は日次の書き込み上限（10 万行）を超えると、アカウント全体のクエリがすべて失敗する**
（仕様 3.6）。いいねの付け外しを D1 に書くと、連打だけで生成もログインも止められる。
正本を D1 と別の枠（Durable Objects）に置き、D1 へは 5 分おきに数だけを写す。

**Pages は Durable Objects のクラスを自分で持てない**（公式の記述）。クラスは別の Worker
`game-forge-likes` に置き、Pages はバインディング（`script_name = "game-forge-likes"`）で
直接呼ぶ。

## 構成

| 対象 | 実体 | 持ち主 |
|---|---|---|
| Worker | `game-forge-likes`（**公開の入口なし**: `workers_dev = false` / `preview_urls = false` / ルートなし） | `workers/likes/wrangler.toml` |
| DO | `LikeHub`（**SQLite 版**。全員のいいねを 1 個に集める。B1） | `workers/likes/src/hub.ts` |
| DO の中の表 | `likes`（利用者 × 作品）/ `daily_ops`（1 人 1 日の操作回数）/ `dirty_games`（同期待ち）/ `banned_users`（同期が最後に見た BAN） | 同上（起動時に `create table if not exists`） |
| 同期 | アラーム（5 分ごと）→ D1 の `games.like_count` を**実数で上書き** | 同上 |
| D1 の列と索引 | `games.like_count` / `games_status_like_count_idx`（部分索引）/ `users_banned_idx`（部分索引） | `migrations/0020_games_like_count.sql` |
| 窓口 | `POST /api/like` / `POST /api/like/cancel` | `src/likes.ts`（綴りは `src/like-paths.ts`） |
| 配備 | `scripts/deploy-likes.sh`（マージ後は deploy ジョブが **Pages より先に**叩く） | `.github/workflows/verify.yml` |
| 宣言の検査 | `scripts/check-likes-worker.sh`（`scripts/acceptance.sh` から呼ぶ） | — |

## 1 回のいいねに何が起きるか

```
利用者 → POST /api/like（Pages）
          ├ セッションを確かめる（D1 を読む。BAN はここで落ちる）
          ├ 本文の game_id を確かめる（形が不正なら 400）
          ├ 押せる作品か（D1 を読む。公開・自作でない・審査で止めていない。違えば 404）
          └ LikeHub.like(userId, gameId, at)  ← binding で直接（RPC）
               ├ 既に押している → 何もしない（書かない・数えない）
               ├ 今日（JST）100 操作に達している → 断る（書かない）→ 429
               └ いいねの行・今日の回数・同期待ちの印を書く（1 つのトランザクション）
          → 作品ページへ 303

LikeHub のアラーム（5 分ごと）
          ├ D1 から BAN されている利用者を読む（users_banned_idx）
          ├ BAN の状態が変わった利用者の押した作品に、同期待ちの印を付ける
          ├ 印の付いた作品を 40 件まで、実数（BAN の分を除く）で games.like_count へ上書き
          └ 写したあとも実数が変わっていなければ印を消す
```

**付与・取り消しは D1 へ 1 行も書かない。** D1 への書き込みは同期だけで、「変わった作品
1 本につき 2 行」（表の行＋部分索引）である（仕様 3.6 の表）。

## 初回の配備（利用者の端末で行う）

**エージェントの実行環境は本番への書き込みを拒否する**ので、以下は利用者が叩く。
**順序に意味がある。** 3（likes Worker）と 4（マージ＝Pages の配備）を逆にすると、Pages が
存在しないスクリプトを指す（4 は deploy ジョブが 3 と同じ段を先に走らせるので、機構でも守られる）。

### 1. API トークンに権限を足す

いまのトークン（`.env` と GitHub Secrets の同じ 1 本。`docs/pages-deploy.md`）は
Pages / D1 / R2 の Edit しか持たない。**Worker を配るには次を足す。**

| スコープ | 権限 |
|---|---|
| Account / Workers Scripts | Edit |

ダッシュボードの My Profile → API Tokens で既存のトークンを編集する（値は変わらない）。
**再発行した場合は、`.env` と GitHub Secrets の 2 か所とも差し替える**（`docs/pages-deploy.md`）。

### 2. マイグレーション 0020 を本番に当てる

```bash
# 0020 を含むツリーで（マージ後なら origin/main。docs/handoff.md 3 章）
npx wrangler d1 migrations list DB --remote --env production
npx wrangler d1 migrations apply DB --remote --env production
```

**当てないとマージ後の配備が `MIGRATIONS_PENDING` で止まる**（`scripts/check-migrations-applied.sh`）。
0020 は列の追加（既定値 0）と索引 2 本だけで、既存の読み書きを壊さない。**マージ前に当ててよい**
（いまの Pages は `like_count` を読まないので、列が先にあっても害が無い）。**ただし当てたあとに
ファイル名を変えないこと**——D1 は適用済みの一覧をファイル名で持つ（docs/handoff.md 3 章の
0009 の件）。**`migrations list` で 0020 より前に未適用が無いことを先に見ること**
（0021 / 0022 は別の issue が持つ）。

### 3. likes Worker を配る

```bash
set -a; . scripts/load-project-env.sh; set +a
bash scripts/deploy-likes.sh
```

`scripts/check-likes-worker.sh` を先に通してから `wrangler deploy` する。初回は DO の
マイグレーション（`new_sqlite_classes = ["LikeHub"]`）がここで適用される。

**マージより先に叩いてよい**（Pages はまだ `LIKE_HUB` を知らないので、likes Worker が先に
あっても害が無い）。叩かずにマージしても、deploy ジョブが Pages の直前に同じスクリプトを
叩くので、**権限（1）さえ足りていれば**配られる。

### 4. マージ（deploy ジョブが likes Worker → Pages の順に配る）

deploy ジョブの段の並びは `.github/workflows/verify.yml`。**likes Worker の段が落ちると、
Pages の段は走らない。**

### 5. 本番で 1 往復通す（#339 の acceptance）

1. 他人の公開作品を 1 つ決め、ログインした状態で作品ページを開く（ボタンは M9-8 で付く。
   それまでは次のフォームを DevTools のコンソールから送る）

   ```js
   // app.game-forge.ojos.jp の作品ページで
   await fetch('/api/like', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'game_id=<作品 id>' }).then((r) => r.json());
   // → { like: 'liked' }。もう一度送ると { like: 'unchanged' }
   ```

2. **5 分待ってから** D1 の数を読む（読み取りなので実行環境からも叩ける）

   ```bash
   npx wrangler d1 execute DB --remote --env production \
     --command "select id, like_count from games where id = '<作品 id>'"
   ```

3. `/api/like/cancel` で取り消し、5 分後に 0 へ戻ることを確かめる
4. 結果を `docs/handoff.md` へ書き戻す

## 公開の入口が無いことを本番で確かめる

`scripts/check-likes-worker.sh` が見るのは宣言だけである（ダッシュボードで手で
workers.dev を有効にした場合は捕まらない）。本番の状態は次で確かめる。

```bash
# workers.dev のサブドメインが無効であること（"enabled": false）
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/game-forge-likes/subdomain"
```

**入口が開いていても、`fetch` は要求を読まずに 404 を返す**（`workers/likes/src/index.ts`）。
**利用者 id を受け取る口は RPC だけで、RPC は同じアカウントのバインディングからしか届かない。**
宣言の検査はそれでも見る——`fetch` に口を足した日に、入口が閉じていることが最後の防波堤になる。

## ローカルで動かす

### テスト（`npm test`）

`LikeHub` を Pages と同じ実行体へ読み込み、`LIKE_HUB` を自分自身の DO へ差し替える
（`vitest.config.ts` / `workers/likes/test-entry.ts`）。Miniflare は 2 本目の Worker を
TypeScript のまま動かせず、`runInDurableObject` も自分自身の DO にしか使えないためである。
**このため、テストは「別スクリプトを指す結線」を通らない。** それを通すのが次の手順である。

### 本物の結線で 1 往復する（dev registry。配備前の結線の確認）

**別々に立てた `wrangler dev`（likes Worker）と `wrangler pages dev`（Pages）は、
`script_name` で互いを見つけてつながる**（wrangler の dev registry。Pages 側の起動表示に
`env.LIKE_HUB (LikeHub, defined in game-forge-likes) ... [connected]` と出る）。

**揃えるものは 3 つある。**

| | Pages | likes Worker | 揃えないと |
|---|---|---|---|
| ポート | 8787（`scripts/dev-server.sh` の既定） | **8788**（`--port`）。検査用も **9230**（`--inspector-port`） | 同じ 8787 / 9229 を取り合って片方が立たない |
| 状態の置き場 | `.wrangler/state`（既定） | **`--persist-to .wrangler/state`**（リポジトリの直下で叩く） | D1 のファイルが別になる |
| ローカル D1 の id | `local-only-placeholder`（トップレベルの `database_id`） | **`preview_database_id = "local-only-placeholder"`**（`workers/likes/wrangler.toml`。`wrangler dev` は `database_id` より先にこれを使う） | 同期が本番の id の名前を持つ**空の** D1 へ書き、`no such table: users` で落ちる（実測） |

3 つ目は宣言に入れてあり、`scripts/check-likes-worker.sh` が Pages のローカル D1 との一致を
照合する。**叩くのは次のとおり。**

```bash
# 0. ローカル D1 にマイグレーションを当てる（Pages の宣言。0020 を含む）
npm run db:migrate

# 1. 端末 1: likes Worker
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler dev \
  --config workers/likes/wrangler.toml --ip 127.0.0.1 \
  --port 8788 --inspector-port 9230 --persist-to .wrangler/state

# 2. 端末 2: Pages（.dev.vars の SESSION_SECRET を使う）
npm run dev
```

**同期は付与から 5 分後に走る**（アラーム）。ローカルでも縮めていない。

### 実際に通した記録（2026-09-11 / PR #346）

**本物の結線（Pages → `script_name = "game-forge-likes"` の DO）で、付与・取り消し・同期を
1 往復通した。** 本番・リモートには触れていない。他のセッションとポートを取り合わないよう、
このときは Pages を 8797（検査用 9239）、likes Worker を 8798（9238）で立てた。
`.dev.vars` を置いていない作業ツリーだったので、`SESSION_SECRET` は
`bash scripts/dev-server.sh --binding SESSION_SECRET=<32 文字以上>` で渡し、同じ鍵で
`src/session.ts` の `signSession` を node から呼んで cookie を作った。利用者 2 人と公開作品 1 件は
`npx wrangler d1 execute DB --local --file ...` で入れた。

| 時刻（UTC） | 操作 | 観測 |
|---|---|---|
| 10:02 | 両方を起動 | Pages の表示: `env.LIKE_HUB (LikeHub, defined in game-forge-likes)  Durable Object  local [connected]` |
| 10:03 | `POST /api/like`（cookie あり・JSON） | `200 {"like":"liked"}`。2 回目は `200 {"like":"unchanged"}`。HTML で送ると `303 → /works/<id>`。cookie なしは `401` |
| 10:08 | 最初の同期（`preview_database_id` を**置く前**） | likes Worker のログ: `[likes] 同期に失敗しました。次の回に写します: D1_ERROR: no such table: users`。likes Worker の D1 は `d81a6f80-…`（本番の id の名前を持つ空のローカル D1）を指していた |
| 10:08 | likes Worker だけ止め、`preview_database_id` を足して立て直す | 起動表示が `env.DB (local-only-placeholder)`。Pages は `[not connected]` → `[connected]` に戻った。DO の行とアラームは `.wrangler/state` に残っていた |
| 10:13 | 同期 | `[likes] 同期しました: 1 件（残り 0 件）`。Pages のローカル D1 の `like_count` が **0 → 1** |
| 10:13 | `POST /api/like/cancel` | `200 {"like":"unliked"}`、2 回目は `unchanged`。**直後の `like_count` は 1 のまま**（取り消しは D1 に書かない） |
| 10:18 | 同期 | `[likes] 同期しました: 1 件（残り 0 件）`。`like_count` が **1 → 0** |

## 連打の防波堤（Workers Rate Limiting）は置いていない

仕様 5.8 は窓口が DO を呼ぶ前に Workers Rate Limiting で連打を断るとしていたが、
**Pages Functions の宣言は Rate Limiting のバインディングを受け付けない**（公式の
「Pages Functions のバインディング」の一覧に無く、wrangler 4.121 の Pages の設定検査も
`ratelimits` を知らないキーとして落とす）。**Workers Free で使えるかも公式の記述に無い。**

**その結果として受け入れている状態**: 日次の上限を超えた要求も DO まで届き、DO の
リクエストの枠（Workers Free で 1 日 10 万）を減らす。**枠が尽きても止まるのはいいねだけ**で、
D1（生成・ログイン）は巻き込まれない。

**置き直すなら**: `game-forge-likes` に `WorkerEntrypoint` の RPC 入口を足し、Pages から
Service binding で呼んで、そこで Rate Limiting を数えてから DO を呼ぶ。Service binding は
公開の入口ではないが、呼び出しの段が 1 つ増え、**Workers Free で Rate Limiting が使えるかを
先に確かめる必要がある**（配備が落ちるかどうかで分かる）。

## 確かめられていないこと

- **Pages → 別 Worker の DO の結線は、ローカル（dev registry）でだけ通した**（上の記録）。
  本番の結線（アカウントの中の `script_name` の解決・本番の D1・DO の配置）で通るのは
  初回配備の 5 が最初である。自動テストは同じ実行体の中の DO を呼んでいる
- **Pages の preview 配備から DO を呼んだときの振る舞い**は見ていない（preview は
  `src/index.ts` のホスト検査で全経路が 404 になるので、実際には届かない）
- **DO の配置**: 最初に呼んだ場所の近くに作られる（Pages の呼び出し元＝日本の利用者の
  近く）。場所を指定していない
