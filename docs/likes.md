# いいね（Durable Objects）の運用手順

いいねの正本を D1 の外（Durable Objects）に置いた経路（仕様 5.8 / #339）と、同じ Worker に
載せたプレイ数（#377。下の「プレイ数（#377）」）の、配備と確認の手順。

**コードの正本は `workers/likes/`（Worker `game-forge-likes` と DO `LikeHub` / `PlayHub`）と
`src/likes.ts` / `src/plays.ts`（Pages 側の窓口）** で、**宣言の正本は `workers/likes/wrangler.toml` と、
ルートの `wrangler.toml` の `LIKE_HUB` / `PLAY_HUB`** である。この文書が持つのは、宣言で表せない手順
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
| DO（#377） | `PlayHub`（**SQLite 版**。全作品のプレイ数を 1 個に集める。DO のマイグレーションはタグ `v2`） | `workers/likes/src/play-hub.ts` |
| DO の中の表 | `likes`（利用者 × 作品）/ `daily_ops`（1 人 1 日の操作回数）/ `dirty_games`（同期待ち）/ `banned_users`（同期が最後に見た BAN） | 同上（起動時に `create table if not exists`） |
| 同期 | アラーム（5 分ごと）→ D1 の `games.like_count` を**実数で上書き** | 同上 |
| D1 の列と索引 | `games.like_count` / `games_status_like_count_idx`（部分索引）/ `users_banned_idx`（部分索引） | `migrations/0020_games_like_count.sql` |
| 窓口 | `POST /api/like` / `POST /api/like/cancel` | `src/likes.ts`（綴りは `src/like-paths.ts`） |
| 窓口（#377） | `POST /api/plays`（作品ページのスクリプトだけが叩く）→ 同期で `games.play_count` | `src/plays.ts` / `migrations/` の `games_play_count` |
| 配備 | `scripts/deploy-likes.sh`（マージ後は deploy ジョブが **Pages より先に**叩く） | `.github/workflows/verify.yml` |
| 宣言の検査 | `scripts/check-likes-worker.sh`（`scripts/acceptance.sh` から呼ぶ） | — |
| 上限の入口（#699） | RPC の入口 `ApiRateLimiter`（`WorkerEntrypoint` の `allow(key)`）と Workers Rate Limiting `API_RATE_LIMIT`（**60 秒あたり 60 回**）。Pages は Service binding `API_RATE_LIMITER` で呼ぶ | `workers/likes/src/api-rate-limiter.ts` / Pages 側の窓口は `src/api-rate-limit.ts`（仕様 5.13） |

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
リクエストの枠（Workers Free で 1 日 10 万）を減らす。**枠が尽きても止まるのはいいねとプレイ数だけ**
（DO の無料枠はアカウント共通で、プレイ数も同じ枠を使う。#377）で、D1（生成・ログイン）は巻き込まれない。

**置き直すなら**: `game-forge-likes` に `WorkerEntrypoint` の RPC 入口を足し、Pages から
Service binding で呼んで、そこで Rate Limiting を数えてから DO を呼ぶ。Service binding は
公開の入口ではないが、呼び出しの段が 1 つ増え、**Workers Free で Rate Limiting が使えるかを
先に確かめる必要がある**（配備が落ちるかどうかで分かる）。

> **#699 注記（2026-09-19）。この形を、いいねではなく機械が読める口の上限のために先に置いた。**
> `game-forge-likes` が Workers Rate Limiting（`[[ratelimits]]` の `API_RATE_LIMIT`。60 秒あたり 60 回）と
> RPC の入口 `ApiRateLimiter` を持ち、Pages は Service binding `API_RATE_LIMITER` で `allow(key)` を呼ぶ
> （公開作品の一覧の口 `GET /api/works`。仕様 5.13）。**いいねの窓口はまだ使っていない**——上の「受け入れている状態」は
> 変わらない。いいねに広げるなら、同じ入口に鍵の前半（口の名前）を分けて呼べばよい。

## 一覧のキャッシュに、古い形の行が残る（#340 への申し送り）

**`games.like_count` を足したので、一覧の行の形が変わった。** 一覧は Cache API に D1 から
引いた行を載せており（`src/list-cache.ts`。鍵は並べ替え軸と頁だけで、**行の形の版を含まない**。
TTL は 60 秒）、**配備の直後、最大 60 秒は `likeCount` を持たない古い行が返りうる。**

**いまは害が無い**——`liked` の並べ替えは SQL 側で効いており、`likeCount` を画面に出していない。
**作品カードに数を出す #340 が、欠けている場合の扱いを決めること**（`work.likeCount ?? 0` で
0 として描く、あるいは `src/list-cache.ts` の鍵へ行の形の版を入れて、形を変えた配備で
キャッシュを捨てる）。**型（`PublicWork.likeCount` は必須）は実行時の保証ではない。**

### 決着（#340 / 2026-09-12）: 0 に倒す

**欠けている `likeCount` は 0 として扱う**（＝数を出さない）。読み方は `src/work-card.ts` の
`cardLikeCount` が 1 か所で持ち、**`undefined` だけでなく `null`・文字列・`NaN`・負の値も
すべて 0 へ倒す**（キャッシュを経由する値は JSON なので、「読めるが形が違う」は通る）。
作品ページの側は `src/work-page.ts` の `storedLikeCount` が同じ扱いをする。

根拠は 3 つある。

1. **0 は「数を出さない」と同義である**（2.3.6）。倒した先の見た目が「まだいいねが無い
   作品」と一致し、**誤った数を 1 つも出さない。** `いいね undefined` を描く形にしない
2. **窓は 60 秒で自然に閉じる。** いいねの数は既に最大 5 分遅れると仕様が決めており
   （5.8）、**60 秒だけ数が出ないことはその許された遅れの内側にある**
3. **鍵に行の形の版を入れる案は採らなかった。** `src/list-cache.ts` はトップ・一覧・
   作者ページが共有する層で、**配備のたびに全ての一覧の保存物を捨てる**ことになる。
   60 秒で消える欠落を直すために、恒久的に読み取りを増やす取引は合わない（3.6）

**確かめ方は `?? 0` を見るだけにしていない。** `test/work-card.test.ts` が**本番と同じ
`cachedRows` で**`likeCount` を持たない行をキャッシュへ入れ、一覧を開いて「数が出ない・
`undefined` も `NaN` も本文に無い」ことと、**捨てれば D1 から引き直して数が出る**ことを
対で見る（仕込みが効いていることを先に確かめてから、出ていないことを見る）。

**配備の直後に「いいねの数が出ていない」と報告が来たら、まず 60 秒待って再読み込みする。**
それで出るなら、この窓であって不具合ではない。

## `/works/liked`（#340）

**本人だけが見られる**（5.8「誰が押したかは公開しない」の唯一の出口）。`src/liked-works.ts`。

```text
ブラウザ → /works/liked ─ src/likes.ts（窓口）─ LikeHub.likedGames() → 押した順の id
                        └ D1 で引き直す ─ 公開済み・審査で止めていない作品だけ
```

- **DO は 1 回、D1 は 1 回**（id が 0 件なら D1 は 0 回）。`likedGames` は**読むだけで
  1 行も書かない**ので、日次の操作回数（1 人 1 日 100 操作）を減らさない——**押しすぎた
  日でも自分の一覧は見られる**
- **索引を 1 本足した**（`likes_user_recent_idx = (user_id, created_at desc, game_id desc)`）。
  主キー `(user_id, game_id)` は 1 人の行までは辿れるが **`order by created_at desc` を
  作れない**ので、索引が無いと**開くたびにその人の履歴全体を並べ替える**（日次の上限は
  溜まった履歴の量を縛らない。DO は 1 個の共有なので単一スレッドを占有する）。
  **書き込みが 1 行増える**——実測で**付与 1 回あたり 5 行 → 6 行**。あわせて、
  **起票時の「4 行」が 1 行少なかったことも分かった**（`dirty_games` への `insert` が
  rowid 表の行と `game_id` の自動索引で 2 行書く）。**3.6 の「約 4 行」は「約 6 行」へ動く**
- **絞り込みは D1 の `where` で行う**（#152 の規律）。**したがって 1 頁が 20 件に満たない
  ことがある。** 欠けている頁には画面が断りを出す（`HIDDEN_NOTICE`）。**件数を揃えるため
  に DO を引き直さない**——1 頁の表示で DO の呼び出しが何回になるか決まらなくなる
- **押した順は DO だけが知っている。** D1 は `published_at` しか持たないので、引いた行を
  id の並びへ並べ替えて出す（`in (...)` は順序を約束しない）
- **BAN された利用者でも、本人の一覧は空にならない。** 数から外すのは他人に見せる数
  （`countFor`）だけで、いいねの行は消していない
- **Cache API を前段に置かない。** 載せてよいのは全員に同じものが出るデータだけである
  （2.3.3）。**鍵に利用者 id を入れる形も採らない**——共有キャッシュへ個人の一覧を置くのは、
  5.8 の「誰が押したかは公開しない」に対して取りたくない risk である
- **頁数の上限は 25 頁（500 件）。** 公開一覧の 50 頁より小さい——`OFFSET` を大きくした
  URL 1 本で**1 個の DO の単一スレッドを長く占有**できるため（5.8 の B1）。DO 側にも
  1 回あたりの上限がある（`MAX_LIKED_GAMES_PER_CALL = 100`）

**配備の順序は変わらない**（likes Worker → Pages）。`likedGames` はクラスを増やさないので
**DO のマイグレーションは要らない**（索引 `likes_user_recent_idx` はコンストラクタの
`create index if not exists` が起動のたびに作るので、既存の行を持つ DO でも壊れない）。

**Pages を先に配ると、まだ `likedGames` を持たない DO を呼ぶ。** そのとき起きるのは
**500 ではない**——窓口が読み取りの失敗を `null` へ倒すので（`src/likes.ts` の
「読み取りが届かなくても、画面ごと落とさない」）、

- **`/works/liked` は 200 で**「いまこの一覧を読み込めませんでした。いいねは失われて
  いません。」と出す（頁送りも出さない）
- **作品ページも 200 のまま**で、D1 の `games.like_count` を出し、**いいねのボタンを
  出さない**（押しても届かないので 4.4）
- **ログには出る**（`[likes] いいねを読めませんでした`）。**画面が静かに degrade するので、
  配備の順序が狂ったことは画面を見ても気づけない**——気づく手段はログである

**それでも順序の要件は残る。** degrade は「いいねが使えない」状態であって、正しい状態では
ない（利用者から見れば機能が消えている）。`.github/workflows/verify.yml` の段の並びが順序を
担保しており、`scripts/check-likes-worker.sh` の 5 番がそれを機械で見る。

**ローカルでも同じ degrade が起きる。** `wrangler pages dev` だけでは `game-forge-likes` が
dev registry に居ないため、`/works/liked` は常に「読み込めませんでした」になる
（`scripts/check-page-width.sh` が通るのはこの degrade した頁である）。**中身の入った一覧を
ローカルで見るには、`npx wrangler dev --config workers/likes/wrangler.toml` を別に走らせる。**

## プレイ数（#377）

**プレイ数は、いいねと同じ Worker の別クラス `PlayHub` に載る**（#377 の利用者の決定。仕様 3.6 の
実装注記）。**共有しているのは Worker と「同期待ちの印から D1 へ写す」コード**（`workers/likes/src/hub.ts`
の `planCountSync` / `writeCountSync` / `ensureSyncAlarm` / `runSyncAlarm`）で、口・記録の形・連打の
畳み方は別に設計した（理由の全文は `src/plays.ts` の冒頭）。

```text
作品ページ（公開済みの作品だけ、iframe の直前に計上のスクリプト）
  └ iframe /g/<id>/ のローダー: Wasm の起動が解決した直後、親が居れば postMessage('gf-loader-started')
  ← スクリプト: 自分の iframe（event.source）からか → sessionStorage で 30 分畳む → POST /api/plays
       └ src/plays.ts: D1 を主キーで 1 行読む（公開済みか。違えば 404）→ PlayHub.record(gameId)
            └ 累計 +1・同期待ちの印（1 つのトランザクション）→ 204

PlayHub のアラーム（5 分ごと。写し残しがある間だけ）
  └ 印の付いた作品を 40 件まで、累計で games.play_count へ上書き（値が同じなら書かない）
```

- **OGP の撮影は数えられない。** 撮影は `/g/<id>/` をトップレベルで開くので、ローダーは合図を送らず、
  数えるスクリプト（作品ページ）もそこには無い
- **計上は D1 へ 1 行も書かない。** D1 への書き込みは同期だけで、「変わった作品 1 本につき 2 行」
- **DO への書き込みは計上 1 回で最大 3 行**（印が既にある作品なら 1 行。`test/play-hub.test.ts` の実測）
- **この口を直接叩く要求は畳めない**（公開済みの作品なら 1 ずつ数える）。精密なボット除外は #377 の scope.out

### 配備（初回だけ増えるもの）

**順序はいいねと同じ**（マイグレーション → likes Worker → Pages）。`.github/workflows/verify.yml` の
deploy ジョブが、未適用のマイグレーションがあれば止め、likes Worker を Pages の直前に配る。

1. **マイグレーション `games_play_count` を本番に当てる**（上の「2.」と同じ手順。列の追加（既定値 0）と
   部分索引 1 本だけで、既存の読み書きを壊さない）。**マージより前に、PR のツリーから当てる**
   ——当てないとマージ後の配備が `MIGRATIONS_PENDING` で止まる。いまの Pages は `play_count` を読まないので、
   列が先にあっても害が無い
2. **likes Worker を配る**（`bash scripts/deploy-likes.sh`。マージ後は deploy ジョブが叩く）。**DO の
   マイグレーション（タグ `v2`、`new_sqlite_classes = ["PlayHub"]`）がここで当たる。** 既存の `LikeHub`
   （タグ `v1`）の行には触れない。**トークンの権限は増えない**（Workers Scripts: Edit は #339 で足してある）
3. **Pages を配る**（マージ）。`PLAY_HUB` は `script_name = "game-forge-likes"` の `PlayHub` を指すので、
   2 より先に配ると計上の口が 503 になる（作品ページは応答を読まないので、利用者には見えない。ログに
   `[plays] プレイ数を数えられませんでした` が出る）

### 本番で「起動 → 5 分後に同期」を確かめる（#377 の acceptance。親と利用者が行う）

1. **公開済みの作品を 1 つ決め、同期前の数を読む**（読み取りなので実行環境からも叩ける）

   ```bash
   npx wrangler d1 execute DB --remote --env production \
     --command "select id, play_count from games where id = '<作品 id>'"
   ```

2. **ブラウザの新しいタブで作品ページ（`https://app.game-forge.ojos.jp/works/<作品 id>`）を開き、ゲームが
   起動するまで待つ。** DevTools の Network に `POST /api/plays` が 1 本、**204** で出ることを見る
   （出ないなら、Console で `sessionStorage.getItem('gf-play:<作品 id>')` が 30 分以内の時刻を持っていないか見る）
3. **同じタブで再読み込みしても、2 本目の `POST /api/plays` が出ない**ことを見る（30 分の窓）
4. **`https://sandbox.game-forge.ojos.jp/g/<作品 id>/` をトップレベルで開いても `POST /api/plays` が出ない**
   ことを見る（撮影と同じ開き方。ローダーは親が居ないので合図を送らない）
5. **5 分待ってから（最大 10 分）** 1 の SQL をもう一度打ち、**2 で数えた 1 回ぶん増えている**ことを見る
   （他の閲覧者の起動が混ざりうるので、増えていれば足りる。変わらなければ likes Worker のログ
   `[plays] 同期しました` / `[plays] 同期に失敗しました` を `npx wrangler tail game-forge-likes` で見る）
6. **本番と同じ束縛値で実行計画を取る**（#377 の acceptance の 2 つ目。`status` は `'published'`、1 頁目は
   `limit 21 offset 0`）

   ```bash
   npx wrangler d1 execute DB --remote --env production --command "explain query plan
     select g.id, g.title, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
            g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3, u.display_name as author_name
       from games g left join users u on u.id = g.author_id
      where g.status = 'published' and (g.review_state is null or g.review_state = 'cleared')
      order by g.play_count desc, g.published_at desc, g.id desc limit 21 offset 0"
   ```

   `SEARCH g USING INDEX games_status_play_count_idx (status=?)` が出て、`USE TEMP B-TREE` と `SCAN g` が
   出ないこと
7. 結果を `docs/handoff.md` へ書き戻す

### ローカルで通した記録（2026-09-13 / #377）

**本物の結線（Pages → `script_name = "game-forge-likes"` の `PlayHub`）で、計上と同期を 1 往復通した。**
本番・リモートには触れていない。状態は使い捨ての `--persist-to` に置き、Pages を 8827（検査用 9257）、
likes Worker を 8828（9258）で立てた（上の「本物の結線で 1 往復する」の手順のポートだけを変えた）。

状態は同じ `--persist-to` に `npx wrangler d1 migrations apply DB --local` で `games_play_count` まで当て、
利用者 1 人・公開作品 1 件・下書き 1 件を入れた。

| 時刻（UTC） | 操作 | 観測 |
|---|---|---|
| 05:56 | 両方を起動 | Pages の表示: `env.PLAY_HUB (PlayHub, defined in game-forge-likes)  Durable Object  local [connected]` |
| 05:57 | `POST /api/plays`（cookie なし・JSON）を公開作品へ 2 回、下書きへ 1 回 | 公開作品は `204` が 2 回。下書きは `404 {"error":"not-found"}`。**直後の `play_count` は 0 のまま**（計上は D1 に書かない） |
| 05:57 | 作品ページとローダーの文書を取得 | 作品ページに合図の文字列（`gf-loader-started`）を持つスクリプトが 1 つ。ローダーは `window.parent.postMessage("gf-loader-started", "https://game-forge.localtest.me:8827")` |
| （途中） | 同じ作業ツリーで変異の検査と rebase を行い、likes Worker が古いツリーで再読み込みされて止まった | likes Worker のログ: `Could not resolve "./play-hub.js"`。**アラームは DO の保存領域に残っていた** |
| 06:03 | likes Worker だけ立て直し、`POST /api/plays` を 3 回 | `204` が 3 回。起動と同時に期限切れのアラームが走り `[plays] 同期しました: 1 件（残り 0 件）`、`play_count` が **0 → 2**（最初の 2 回ぶん）。**写している間に届いた 3 回ぶんは印が付け直された** |
| 06:08 | 次のアラーム（5 分後） | `[plays] 同期しました: 1 件（残り 0 件）`。`play_count` が **2 → 5** |

## 機械が読める口の上限の入口（#699）

**この Worker は、DO のほかに RPC の入口 `ApiRateLimiter` を持つ**（`workers/likes/src/api-rate-limiter.ts`）。
Pages（アプリ本体）は Rate Limiting のバインディングを持てないので、数えるのはこの Worker である（仕様 5.13）。

| 対象 | 実体 | 持ち主 |
|---|---|---|
| Rate Limiting | `API_RATE_LIMIT`（`namespace_id = "699"`・`simple = { limit = 60, period = 60 }`）。**一度配ったら `namespace_id` を変えない**（数えていた回数が捨てられる） | `workers/likes/wrangler.toml` |
| RPC の入口 | `ApiRateLimiter.allow(key)` → 上限の内側なら true | `workers/likes/src/api-rate-limiter.ts`（`src/index.ts` が輸出する） |
| Pages の結線 | Service binding `API_RATE_LIMITER`（`service = "game-forge-likes"`・`entrypoint = "ApiRateLimiter"`。トップレベル・production・preview の 3 か所） | ルートの `wrangler.toml` |
| Pages 側の窓口 | `allowApiCall`（**呼べなければ通す**＝fail-open。通したことを `[api-rate-limit]` のログに残す） | `src/api-rate-limit.ts` |

- **公開の入口は増えていない。** 名前付きの入口は Service binding からしか呼べず、`workers_dev` / `preview_urls` /
  ルートの閉じ方は変えていない。受け取るのは数える鍵だけで、DO に書く操作は無い
- **配る順序は DO と同じ**（likes Worker → Pages。`.github/workflows/verify.yml`）。宣言の一致と、束ねた Worker が
  入口を輸出していることは `scripts/check-likes-worker.sh` の 7 が見る
- **Rate Limiting が Workers の無料プランで使えるかは、公式の文書に書かれていない。** 使えなければ `scripts/deploy-likes.sh`
  が落ち、**main の deploy ジョブはいいねの Worker を Pages の直前に配るので、以後の配備がすべて止まる。**
  だから #699 はマージの前に、利用者の端末で PR のツリーから `bash scripts/deploy-likes.sh` を叩いて確かめる
- **本番で上限が効いていることの確かめ方**: ログインした状態で `GET /api/works?q=a`（D1 を引かずに 400 で返る）を
  1 分の間に 61 回以上叩き、429 `{"error":"rate-limited"}` が返ること。**数え方は緩く・結果整合**（公式の文書）なので、
  境目の回数はずれうる。429 が 1 度も返らず、ログに `[api-rate-limit] 上限の入口を呼べなかったので通しました` が出ていれば、
  結線（Pages の Service binding の `entrypoint`）が本番で効いていない

## 確かめられていないこと

- **Pages → 別 Worker の上限の入口（Service binding の RPC）は、本番でまだ通していない**（#699）。自動テストは
  同じ実行体の中の入口を Service binding の RPC で呼んでいる（`vitest.config.ts` が自分自身へ差し替える）。
  **Pages の Service binding が名前付きの入口（`entrypoint`）を本番で解決するかは、公式の Pages の文書に明記が無い**
  （「Workers と同じように宣言する」とだけある）。解決しなければ口は fail-open で通すので、上の確かめ方で見る
- **Pages → 別 Worker の DO の結線は、ローカル（dev registry）でだけ通した**（上の記録）。
  本番の結線（アカウントの中の `script_name` の解決・本番の D1・DO の配置）で通るのは
  初回配備の 5 が最初である。自動テストは同じ実行体の中の DO を呼んでいる
- **Pages の preview 配備から DO を呼んだときの振る舞い**は見ていない（preview は
  `src/index.ts` のホスト検査で全経路が 404 になるので、実際には届かない）
- **DO の配置**: 最初に呼んだ場所の近くに作られる（Pages の呼び出し元＝日本の利用者の
  近く）。場所を指定していない
- **プレイ数の合図（`postMessage`）を実ブラウザで通したのは本番の確認（上の 2〜4）が最初である**（#377）。
  自動テストは workerd の上で走り、ローダーと作品ページのスクリプトの綴り（親の判定の内側でしか送らない・
  `event.source` で自分の iframe に絞る）を見ている。ローカルの記録は口と同期までで、Wasm の起動は通していない
  （ローカルの R2 に作品の `.wasm` が無い）
