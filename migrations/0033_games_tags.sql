-- 作品のタグ（仕様 2.3.5 / 2.3.6 / 5.4 / #376）。
--
-- ## 何を持つか
--
-- **作者が公開時に、固定の語彙（`src/work-tags.ts` の 8 個）から 0〜3 個を選ぶ。** 自動分類では
-- ないので生成のたびの費用は無い（2.3.5）。公開した後も作者が付け直せる（#376 の利用者の決定）。
--
-- ## 形: `games` に枠を 3 つ持つ（別表にしない）
--
-- **絞り込みの並びの軸（`published_at` / `fork_count`）が `games` の行にある**ので、タグを
-- 別表 `game_tags(game_id, tag)` に置くと、「タグ = ? を新しい順に 20 件」を索引だけで引くには
-- **並びの列を別表へ写す**ことになる。`fork_count` は子の公開・取り下げのたびに数え直す列で
-- （`src/games.ts` の `refreshParentForkCount`）、写しを持てばその書き込みが別表へも伸びる。
-- 写さなければ、別表の索引で拾った行を `games` と突き合わせてから並べ替える形になり、
-- **一時 B-tree と「タグの付いた作品の総数に比例する読み取り」が戻る**（2.3.3 の条件 2）。
--
-- **枠を 3 つにしたのは、上限が 3 個に決まっているからである**（2.3.5）。上限を上げる日は
-- 枠と索引を足す（その日に別表へ移すかを改めて決める）。
--
-- ## 枠の規則はアプリが守る（CHECK を張らない）
--
-- **tag1 から詰める・同じ作品の中で重複しない**（`src/games.ts` の `validateWorkTags` が語彙の
-- 順に並べ直してから詰める）。**重複しないことは絞り込みの正しさそのもの**である——一覧は
-- 3 つの枠を `UNION ALL` で束ねるので、同じタグが 2 つの枠にあると同じ作品が 2 度並ぶ。
-- **守るのは書く口（公開と付け直し）の 2 か所だけ**で、どちらも同じ関数を通り、
-- `test/work-tags.test.ts` が見る。
--
-- **語彙を CHECK で縛らない**（#376 の決定）。語彙を 1 つ足すたびに、SQLite では **`games` の
-- 作り直し**が要る（列の CHECK を後から変える `ALTER` が無い）。`games` は最も大きく、最も多くの
-- 経路が読む表であり、語彙の見直しのためにそれを作り直す形にしない（0028 が説明の長さに
-- CHECK を張らなかったのと同じ判断）。**語彙に無い値が入っても、どの画面にも出ない**
-- （カードも作品ページも、語彙に無い識別子を読み飛ばす）。
--
-- ## NULL 可・既定値なし（「タグ無し」を許す）
--
-- **既存の作品はすべて NULL で始まる**（ALTER の既定）。**公開の入力を必須にしない**
-- （#376 の constraints。必須にすると既存の下書きが公開できなくなる）ので、新しく公開される
-- 作品もタグ無しでありうる。**絞り込まない一覧は枠を見ない**ので、タグ無しの作品が一覧から
-- 消えることは無い。絞り込むとタグの付いた作品だけが出ることは、画面に書く
-- （`src/works-list.ts`）。
--
-- **空文字を「無い」の表し方にしない**（0028 の説明とは逆の判断）。部分索引の条件
-- `tagN IS NOT NULL` が、タグの無い作品を索引の外へ出す——**タグ無しの公開は索引の書き込みを
-- 1 行も増やさない。**
--
-- ## `tags_set_at`（付け直しの間隔を 1 本の WHERE で見る）
--
-- **付け直しは作品ごとに 60 秒に 1 回まで**（`src/games.ts` の `WORK_TAGS_CHANGE_INTERVAL_SECONDS`。
-- 説明の変更（0028 の `description_set_at`）と同じ形・同じ値）。**説明より書き込みが重い**
-- ——下の 6 本の索引のうち、付け直し 1 回で最大 6 本ぶんの項目が抜けて入り直す。NULL は
-- 「公開してから 1 度も付け直していない」である（**公開の時点では書かない**。公開した直後に
-- 付け間違いに気づいた作者を 60 秒待たせない）。
--
-- **変更履歴の表は持たない**（#376 の利用者の決定）。語彙が固定で、利用者の自由文が 1 文字も
-- 入らないので、#405 型の「通報された時点の値」を復元する必要が無い（審査が見る題名・説明と
-- 性質が違う）。**同じ理由で審査状態（`review_state`）も戻さない**——付け直しは
-- `renameGame` / `describeGame` の `reviewStateAfterAuthorEditSql` を通らない。
--
-- ## 索引: 枠 3 × 並びの軸 2 = 6 本の部分索引
--
-- **絞り込み中の並べ替えは「新着」と「改造された数」だけ**（#376 の利用者の決定）。
-- `liked`（`like_count`）と `played` を載せないのは、**5 分おきの同期が書く列**だからである
-- ——載せれば、同期 1 回で変わった作品 1 本につき索引の書き込みが最大 3 行増える（3.6 の
-- 見積もり「変わった作品 1 本につき 2 行」が崩れる）。4 軸すべてを索引で保証すると、最悪で
-- 書き込みの無料枠（10 万行/日）を超える見積もりになった（#376 の決定の理由）。
--
-- **一覧は 3 つの枠を `UNION ALL` で束ね、枠ごとにこの索引を順に読んで併合する**
-- （`src/games.ts` の `taggedGamesSql`）。どの枠も並びの列順が `order by` そのものなので、
-- 一時 B-tree も全表走査も出ない。**`EXPLAIN QUERY PLAN` は `test/works-list.test.ts` が本番と
-- 同じ `bind` で見る。**
--
-- **条件は `src/reports.ts` の `reviewVisibleSql()` が返す文字列と同じ綴りにしてある。**
-- SQLite は問い合わせの条件が索引の条件を含むと示せたときだけ部分索引を使うので、綴りが
-- ずれると黙って使われなくなる（0020 / 0023 / 0024 と同じ規律）。`status = 'published'` の
-- 値は束縛で渡すが、SQLite は束縛した値を部分索引の条件と照合する（2.3.3 の v1.52 追記）。
-- **`test/schema-tags.test.ts` がこの一致を機械で見る。**
--
-- **`tagN IS NOT NULL` を条件に置く。** 問い合わせの `tagN = ?` はそれを含意する
-- （SQLite の部分索引の規則: `=` の比較は `IS NOT NULL` を満たす）ので、索引の選択は変わらず、
-- タグの無い公開作品が索引に 1 行も載らない。
--
-- ## 費用（書き込み）
--
-- | 契機 | 増える書き込み |
-- |---|---|
-- | タグ無しで公開 | 0 行 |
-- | タグ k 個で公開 | 2k 行（枠 k 本 × 軸 2 本） |
-- | 付け直し | 最大 12 行（抜ける 6 ＋ 入る 6。60 秒に 1 回まで） |
-- | 子の公開・取り下げで親の `fork_count` が動く | 親のタグ k 個につき 2k 行（`fork_count` の索引の項目が抜けて入り直す） |
-- | いいねの同期 | **0 行**（`like_count` を載せていない） |
--
-- 公開は月数十件の規模で（3.7 / 確定25）、無料枠 10 万行/日 に対して無視できる。
--
-- ## 埋め戻しはここでしない
--
-- **本番の作品の id をマイグレーションに書かない**（写しは必ず腐り、手元とテストの D1 には
-- その行が無い）。既存の公開作品のうち運営の作品だけを、配備の後に利用者の端末から埋める
-- （手順と SQL は #376 の PR 本文）。他の作品は作者が作品ページから付ける。
--
-- ## 配備との順序
--
-- **このマイグレーションを当ててから Worker を出すこと。** 一覧・トップ・作者ページ・作品ページの
-- 問い合わせが `tag1` / `tag2` / `tag3` を選ぶので、列の無い本番に Worker が出ると、それらの画面が
-- すべて落ちる（`scripts/check-migrations-applied.sh` の冒頭の事故と同じ形）。

ALTER TABLE games ADD COLUMN tag1 TEXT;
ALTER TABLE games ADD COLUMN tag2 TEXT;
ALTER TABLE games ADD COLUMN tag3 TEXT;

-- 作者が最後にタグを付け直した時刻（UNIX 秒。0001 の方針）。NULL なら公開してから 1 度も付け直していない。
ALTER TABLE games ADD COLUMN tags_set_at INTEGER;

-- 枠 1: 新着（`sort=recent`）と改造された数（`sort=forked`）。列順は絞り込まない一覧の索引
-- （0019）と同じ——同値の順序を最後の `id` で決める。
CREATE INDEX games_tag1_published_at_idx
  ON games(tag1, published_at DESC, id DESC)
  WHERE status = 'published' AND tag1 IS NOT NULL AND (review_state is null or review_state = 'cleared');

CREATE INDEX games_tag1_fork_count_idx
  ON games(tag1, fork_count DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND tag1 IS NOT NULL AND (review_state is null or review_state = 'cleared');

-- 枠 2。
CREATE INDEX games_tag2_published_at_idx
  ON games(tag2, published_at DESC, id DESC)
  WHERE status = 'published' AND tag2 IS NOT NULL AND (review_state is null or review_state = 'cleared');

CREATE INDEX games_tag2_fork_count_idx
  ON games(tag2, fork_count DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND tag2 IS NOT NULL AND (review_state is null or review_state = 'cleared');

-- 枠 3。
CREATE INDEX games_tag3_published_at_idx
  ON games(tag3, published_at DESC, id DESC)
  WHERE status = 'published' AND tag3 IS NOT NULL AND (review_state is null or review_state = 'cleared');

CREATE INDEX games_tag3_fork_count_idx
  ON games(tag3, fork_count DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND tag3 IS NOT NULL AND (review_state is null or review_state = 'cleared');
