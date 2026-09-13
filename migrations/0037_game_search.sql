-- キーワード検索の索引（#378 / M12-10 / 仕様 2.3.3・2.3.5・2.3.8）。
--
-- ## 何を持つか
--
-- **公開作品の題名と説明を、FTS5（`tokenize = 'trigram'`）で引く。** 引く側は `src/work-search.ts`。
--
-- - **`LIKE` を使わない**（2.3.5）。`like '%…%'` は結果ではなく母数を読む（#370 の本番の実測で、
--   結果 0 件でも `rows_read` が公開件数だった）。D1 の読み取り枠はアカウント共通で、尽きると
--   ログインも生成も止まる
-- - **trigram にする。** 既定の tokenizer（unicode61）は、空白で区切られない日本語を丸ごと
--   1 トークンにし、「ゲーム」で「ブロック崩しゲーム」が当たらない（#370）
-- - **trigram は 3 文字未満の語を索引しない。** 「宇宙」のような 2 文字の語は `match` で黙って
--   外れるので、引く側が語の長さで引き方を分ける（#378 の利用者の決定 1・2。`src/work-search.ts`）
--
-- ## 暗黙の `rowid` に繋がない（#378 の利用者の決定 3）
--
-- **`games` は `id TEXT PRIMARY KEY` で、`INTEGER PRIMARY KEY` を持たない。** 外部コンテンツの FTS5 表
-- （`content = 'games'`）は `games` の暗黙の `rowid` で本体を指すが、暗黙の `rowid` は表の作り直しや
-- `VACUUM` で変わりうる。変わると**索引と本体がずれ、落ちずに検索結果だけが壊れる**（handoff 1 章）。
--
-- **対応表 `game_search_docs` を置き、FTS5 表の `rowid` にはその `doc_id` を明示して入れる。**
-- `doc_id` は `INTEGER PRIMARY KEY`（`rowid` の別名で、表の作り直しでも値が保たれる）、`game_id` は
-- `UNIQUE`（1 作品 1 文書）。**FTS5 表は外部コンテンツにしない**（題名と説明の写しを持つ。公開作品の
-- 題名 40 文字と説明の分だけで、小さい）。`games.id` を FTS5 表の `UNINDEXED` 列に持つ形は採らない
-- ——`match` で拾った行から `games` を引くたびに、FTS5 の本文の表を読むことになる。
--
-- **外部キーを張らない。** `games` の行を消すとき、消す文の終わりで外部キーが検査され、下の削除の
-- トリガとの順序に依存する。`games` を物理削除するのは下書きの掃除だけで（5.3 / 3.7）、下書きは
-- そもそも索引に入らない。
--
-- ## 入れるのは可視の作品だけ（トリガで同期する）
--
-- **可視 = `status = 'published'` かつ審査で新規露出を止めていない**（`src/reports.ts` の
-- `reviewVisibleSql()` と同じ綴り。一覧の部分索引と同じ条件）。**引く側も `games` と結合して同じ条件を
-- もう一度掛ける**（二重に守る。索引がずれても、消したはずの作品は出ない）。
--
-- **トリガは 3 本**（SQLite の `CREATE TRIGGER` はイベントを 1 種類しか持てない）。
--
-- - **`games_search_ai`（insert）**: 可視の行が入ったら文書を足す
-- - **`games_search_au`（update）**: **`status` / `review_state` / `title` / `description` の更新にだけ
--   発火する**（`UPDATE OF`）。`like_count` / `play_count` の 5 分おきの同期、タグの付け直し、撮影や
--   生成の状態の更新では発火しない（書き込みの無料枠を、検索の索引の書き直しで食わない）。さらに
--   `WHEN` で、4 列のどれかの**値が実際に変わった**ときだけに絞る。本体は「古い文書を消し、可視なら
--   入れ直す」の 1 通りだけにした（公開・取り下げ・審査で止める・戻す・改名・説明の変更のどれも
--   同じ文で済み、場合分けを持たない）
-- - **`games_search_ad`（delete）**: 文書を消す
--
-- **拾う書き込みの経路**（どれもアプリの側では索引に触れない）: 公開（`publishGame`）/ 取り下げ
-- （`removeGame`）/ 改名（`renameGame`）/ 説明（`describeGame`）/ 通報で審査へ（`src/reports.ts` の
-- `queued`）/ 運営の審査と削除申請（`src/admin/actions.ts`）/ **運営が D1 を直接 UPDATE する取り下げ**。
--
-- ## 初期投入
--
-- **トリガを作ってから投入する。** 投入の後にトリガを作ると、その間に公開された作品が索引から漏れる。
-- 先に作ると、その間に公開された作品はトリガが入れるので、投入の側は**入っていないものだけを入れる**
-- （`INSERT OR IGNORE` と `NOT IN`）。
--
-- ## ずれたときの作り直し（全削除して再投入）
--
-- 索引のずれは、件数の照合と FTS5 の整合性検査で見つける。
--
--   select (select count(*) from game_search_docs) as docs,
--          (select count(*) from game_search_fts) as fts,
--          (select count(*) from games
--            where status = 'published' and (review_state is null or review_state = 'cleared')) as visible;
--   insert into game_search_fts(game_search_fts) values ('integrity-check');
--
-- 3 つの数が揃わなければ、**次の 4 文を 1 回の実行（`--file` 1 本）で流す**。トリガは残したままでよい
-- （流している間に届いた更新は、トリガが古い文書を消して入れ直すので、最後に投入と同じ状態になる）。
--
--   delete from game_search_fts;
--   delete from game_search_docs;
--   insert into game_search_docs (game_id)
--     select id from games
--      where status = 'published' and (review_state is null or review_state = 'cleared')
--      order by published_at, id;
--   insert into game_search_fts (rowid, title, description)
--     select d.doc_id, g.title, g.description from game_search_docs d join games g on g.id = d.game_id;
--
-- ## 落とすとき（順序に意味がある）
--
-- **トリガを先に、表を後に落とす。** 表を先に落とすと、トリガが残ったまま消えた表を指し、
-- **`games` への書き込み（公開・取り下げ・改名）がすべて失敗する。**
--
--   drop trigger games_search_ai;
--   drop trigger games_search_au;
--   drop trigger games_search_ad;
--   drop table game_search_fts;
--   drop table game_search_docs;
--
-- ## 費用
--
-- **読み取り**: 3 文字以上の語は、該当した件数に比例する（該当しない公開作品の数には比例しない）。
-- 2 文字以下の語だけの検索は、この索引を使わず公開一覧の索引を読む（公開作品の数に比例する。
-- **公開 500 本で見直す**——2.3.8）。
-- **書き込み**: 公開・取り下げ・審査・改名・説明の変更 1 回につき、対応表の 1〜2 行と FTS5 の内部の表の
-- 数行。**いいね・プレイ数の同期は 1 行も足さない**（上の `UPDATE OF`）。
--
-- ## 既存の実行計画への影響
--
-- **`games` に索引を足していない**（足したのは別表と、その `UNIQUE` の自動索引だけ）ので、`games` を
-- 引く既存の問い合わせの計画は変わらない（同点の索引で後から作ったものが選ばれる問題は、`games` の
-- 索引どうしの話である。`migrations/` の `games_play_count`）。`test/schema-author-page.test.ts` などの
-- 既存の実行計画の検査で確かめた。

CREATE TABLE game_search_docs (
  doc_id INTEGER PRIMARY KEY,
  game_id TEXT NOT NULL UNIQUE
);

CREATE VIRTUAL TABLE game_search_fts USING fts5(title, description, tokenize = 'trigram');

-- 条件の綴りは `reviewVisibleSql('new')` と同じ（`test/schema-search.test.ts` が照合する）。
CREATE TRIGGER games_search_ai AFTER INSERT ON games
WHEN new.status = 'published' AND (new.review_state is null or new.review_state = 'cleared')
BEGIN
  INSERT INTO game_search_docs (game_id) VALUES (new.id);
  INSERT INTO game_search_fts (rowid, title, description)
    SELECT doc_id, new.title, new.description FROM game_search_docs WHERE game_id = new.id;
END;

CREATE TRIGGER games_search_au AFTER UPDATE OF status, review_state, title, description ON games
WHEN old.status IS NOT new.status
  OR old.review_state IS NOT new.review_state
  OR old.title IS NOT new.title
  OR old.description IS NOT new.description
BEGIN
  DELETE FROM game_search_fts
   WHERE rowid = (SELECT doc_id FROM game_search_docs WHERE game_id = old.id);
  DELETE FROM game_search_docs WHERE game_id = old.id;
  INSERT INTO game_search_docs (game_id)
    SELECT new.id
     WHERE new.status = 'published' AND (new.review_state is null or new.review_state = 'cleared');
  INSERT INTO game_search_fts (rowid, title, description)
    SELECT doc_id, new.title, new.description FROM game_search_docs WHERE game_id = new.id;
END;

CREATE TRIGGER games_search_ad AFTER DELETE ON games
BEGIN
  DELETE FROM game_search_fts
   WHERE rowid = (SELECT doc_id FROM game_search_docs WHERE game_id = old.id);
  DELETE FROM game_search_docs WHERE game_id = old.id;
END;

INSERT OR IGNORE INTO game_search_docs (game_id)
  SELECT id FROM games
   WHERE status = 'published' AND (review_state is null or review_state = 'cleared')
   ORDER BY published_at, id;

INSERT INTO game_search_fts (rowid, title, description)
  SELECT d.doc_id, g.title, g.description
    FROM game_search_docs d
    JOIN games g ON g.id = d.game_id
   WHERE d.doc_id NOT IN (SELECT rowid FROM game_search_fts);
