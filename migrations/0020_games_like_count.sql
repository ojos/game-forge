-- いいねの数（#339 / M9-7 / 仕様 5.8・2.3.3・2.3.4）。
--
-- ## D1 に置くのは数の写しだけである
--
-- **いいねの正本は Durable Objects にある**（`workers/likes/`。仕様 5.8）。D1 は日次の
-- 書き込み上限を超えるとアカウント全体のクエリがすべて失敗し（3.6）、いいねの付け外しを
-- ここへ書くと連打だけで生成もログインも止められる。**付与・取り消しは D1 へ書かない。**
-- この列は DO のアラームが 5 分おきに、数が変わった作品だけを実数で上書きする
-- （`workers/likes/src/hub.ts` の `UPDATE_LIKE_COUNT_SQL`）。**写しなので、ずれたら
-- DO の側が正しい**（5.1）。
--
-- `NOT NULL DEFAULT 0` にするのは、既存の行（まだ 1 度も同期されていない作品）が
-- 「いいね 0」として一覧に並べるためである。NULL を許すと、並べ替えで NULL がどこへ
-- 行くかを読み手が知っている必要が生まれる。

ALTER TABLE games ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

-- いいねの多い順（`sort=liked`。2.3.4）。同数のときは新しい順に落とし、最後に `id` で
-- 同値の順序を決める（0019 の 2 本と同じ列順・同じ理由）。
--
-- ## 部分索引にする（2.3.3 の v1.51 注記）
--
-- **0019 の 2 本は審査の可視条件を含まない。** 並びの上位に審査中の作品が挟まると、
-- 索引をその数だけ余分に読む。**この索引は、一覧が引く条件そのもの**
-- （`status = 'published'` と、8.4 の審査で新規露出を止めていないこと）**で絞る。**
-- 条件は `src/reports.ts` の `reviewVisibleSql()` が返す文字列と**同じ綴り**にしてある。
-- SQLite は問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使うので、
-- 綴りがずれると黙って使われなくなる。**`test/schema-likes.test.ts` がこの一致を、
-- `test/works-list.test.ts` が実行計画（`EXPLAIN QUERY PLAN`）を機械で確かめる。**
--
-- 0019 が「`status = ?` は束縛で渡すので部分索引が使われる保証がない」として部分索引を
-- 避けた点は、**実測で覆った**（SQLite は束縛した値を部分索引の条件と照合し、値が
-- 変われば文を作り直す。上の実行計画の検査が、束縛で渡す実際の SQL で通っている）。
--
-- `status` を先頭列に残すのは、仕様（2.3.3 / issue #339）が定めた列の形に揃えるため
-- である。部分索引の条件で既に 1 値へ絞っているので、並びには効かないが害も無い。
--
-- ## 費用
--
-- 同期が `like_count` を書くと、表の行と、この索引の行（公開中・露出中の作品なら）の
-- 2 行になる（3.6 の表の「変わった作品 1 本につき 2 行」）。
CREATE INDEX games_status_like_count_idx
  ON games(status, like_count DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND (review_state is null or review_state = 'cleared');

-- BAN された利用者だけを載せる部分索引（5.8 の同期）。
--
-- 同期は 5 分ごとに `select id from users where banned_at is not null` を引き、BAN の状態が
-- 変わった利用者の押した作品だけを数え直す（`workers/likes/src/hub.ts` の
-- `BANNED_USERS_SQL`）。**索引が無いと、1 日 288 回の読み取りがそれぞれ利用者の総数に
-- 比例する。** この索引の上なら、読むのは BAN された人数だけである。
--
-- 書き込みが増えるのは BAN したとき（`banned_at` を埋めたとき）だけで、BAN は運営が
-- D1 を直接 UPDATE する稀な操作である（7.3）。
CREATE INDEX users_banned_idx ON users(id) WHERE banned_at IS NOT NULL;
