-- プレイ数（#377 / M12-9 / 仕様 2.3.4・2.3.5・2.3.6・3.6）。
--
-- ## D1 に置くのは数の写しだけである
--
-- **プレイ数の正本は Durable Objects にある**（`workers/likes/src/play-hub.ts`。いいねと同じ
-- Worker `game-forge-likes` の別クラス `PlayHub`）。**3.6 は「プレイ回数を都度書くと D1 の
-- 無料枠が即座に枯れる」と名指しで禁じている**——D1 は日次の書き込み上限を超えるとアカウント
-- 全体のクエリがすべて失敗する。**計上の経路は D1 へ書かない。** この列は DO のアラームが
-- 5 分おきに、数が変わった作品だけを累計で上書きする（`UPDATE_PLAY_COUNT_SQL`）。
-- **写しなので、ずれたら DO の側が正しい**（5.1。`like_count` と同じ扱い）。
--
-- `NOT NULL DEFAULT 0` にするのは `like_count`（`games_like_count`）と同じ理由である——既存の
-- 行が「プレイ 0」として並べ替えに並び、NULL がどこへ行くかを読み手が知っている必要を作らない。
-- **埋め戻さない。** この列より前の起動は 1 度も数えていない（数え始めた時点から数える。
-- `/works/mine` の統計カードがその旨を書き添える）。

ALTER TABLE games ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;

-- プレイ数の多い順（`sort=played`。2.3.4）。**`games_like_count` の部分索引とまったく同じ形**
-- にする——同数のときは新しい順に落とし、最後に `id` で同値の順序を決める。
--
-- ## 部分索引の条件は一覧の条件と同じ綴りである
--
-- 条件は `src/reports.ts` の `reviewVisibleSql()` が返す文字列と**同じ綴り**にしてある。
-- SQLite は問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使うので、綴りが
-- ずれると黙って使われなくなる。**`test/schema-plays.test.ts` がこの一致を、
-- `test/works-list.test.ts` が本番と同じ束縛値の実行計画を機械で確かめる。**
--
-- ## タグで絞り込む一覧には索引を張らない（#376 の決定）
--
-- **絞り込み中はプレイ数順を出さない**（`src/games.ts` の `TAGGED_WORK_SORTS` は変えない）。
-- 枠ごとの索引を張ると、5 分おきの同期の書き込みが枠の数だけ増える（#376 の見積もり）。
--
-- ## 費用
--
-- 同期が `play_count` を書くと、表の行と、この索引の行（公開中・露出中の作品なら）の 2 行に
-- なる（3.6 の表の「変わった作品 1 本につき 2 行」）。**1 作品が 1 日に何万回遊ばれても、
-- 同期の回数（1 日 288 回）で頭打ちになる。**
CREATE INDEX games_status_play_count_idx
  ON games(status, play_count DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND (review_state is null or review_state = 'cleared');

-- ## 作者の部分索引を張り直す（同じ定義のまま、この索引より後に作る）
--
-- **SQLite は統計（`sqlite_stat1`）が無いと、見積もりが同点の索引のうち、後から作ったものを選ぶ。**
-- D1 には統計が無い。上の索引は `games_author_published_at_idx`（`migrations/` の `games_author_published_idx`）と同じ
-- 部分索引の条件を持ち、先頭列の等号 1 つで引ける点も同じなので、**作者で絞って並べ替えない問い合わせ**
-- （`src/users-page.ts` の `likesReceivedSql`: `author_id = ? and status = ?` の合計）で同点になり、
-- **上の索引で公開作品をすべて読む計画に変わった**（`test/schema-author-page.test.ts` が捕まえた。
-- 手元の SQLite 3.53 で、作成の順を入れ替えると選ばれる索引も入れ替わることを確かめた）。
-- `games_status_like_count_idx` が作者の索引より前に作られていたので、いままでは表に出ていなかった。
--
-- **定義を 1 文字も変えずに作り直し、作者の索引を最も新しい索引に戻す。** 書き込みは公開中・露出中の
-- 作品の数だけ（索引の行）で、一度きりである。**問い合わせの側で索引を名指ししない**のは、既存の
-- 規律（`indexed by` で名指しすると、張り替えた日に画面が 500 になる）に従うためである。
DROP INDEX games_author_published_at_idx;
CREATE INDEX games_author_published_at_idx
  ON games(author_id, published_at DESC, id DESC)
  WHERE status = 'published' AND (review_state is null or review_state = 'cleared');
