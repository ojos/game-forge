-- MCP の認可（#696 / 仕様 5.15）の、1 日あたりの回数の上限を数える表。
--
-- ## なぜ要るのか
--
-- 認可の部品（`@cloudflare/workers-oauth-provider`）は KV（`OAUTH_KV`）に書く。**KV の無料枠は書き込みと list が
-- それぞれ 1 日 1,000 回で、アカウント全体で共有する**（3.6 の D1 と同じく、枯れると全員が止まる）。次の口は、
-- 1 回ごとに KV を書くか list する。
--
--   - `/register`（DCR）… **ログイン不要**。1 回で書き込み 1。約 1,000 回で全員の同意・code の交換・refresh が止まる
--   - `/account/apps`（一覧と解除）… ログインした 1 人が叩ける。1 回で list 1。約 1,000 回で全員の同意（部品が必ず list する）と
--     退会の完了の段が止まる
--   - `/authorize` の承諾 … ログインした 1 人が繰り返せる。1 回で書き込み 1 と list 1
--
-- Workers Rate Limiting（5.13 の `ApiRateLimiter`）は 10 秒か 60 秒の窓しか持てず、**1 日の総量を縛れない**
-- （60 秒 60 回でも 1 日 86,400 回）。そこで 1 日の総量をこの表で数え、上限に達したら KV に触る前に断る。
--
-- ## 形
--
-- `bucket` は「口の名前」か「口の名前:利用者の id」（**IP アドレスは入れない**——プライバシーポリシーの
-- 「IP アドレスを自らのデータベースへ保存していません」を守る）。`day` は UTC の日（UNIX 秒 ÷ 86400）。
-- 1 回ごとに `count` を 1 つ上げ、**上げる文そのものが上限を見る**（`on conflict … where count < 上限`）。
-- 変わった行が 0 なら上限に達している。**読んでから書く形にしない**（同時の要求が 2 つとも通る窓を作らない）。
--
-- **2 日より前の行は、数える要求が同じ batch で消す**（`src/oauth-guard.ts`）。表は常に 2 日分しか持たない。
-- 書き込みは数える 1 回につき 1 行（主キーだけで索引を足さない）。D1 の書き込みの枠（1 日 10 万行）に対して小さい。
CREATE TABLE oauth_daily_usage (
  bucket TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, day)
);
