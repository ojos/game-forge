-- 相談の対象（#727 / M20-3 / 確定38。仕様 5.16「対象——画面は 1 つ、対象は引数」）。
--
-- ## なぜ会話を対象ごとに分けるのか
--
-- **相談は「新しく作る」「自分の下書きを直す」「他人の作品をフォークする」の 3 つを受けるようになった。**
-- 会話を 1 人 1 本のままにすると、**フォークの相談の続きに、前に新規で話した内容がぶら下がる**
-- ——AI はそれを同じ話の続きとして読む。**対象が変われば、話も変わる。**
--
-- ## 既定を `'new'` にする（NULL にしない）
--
-- **この列より前の行は、すべて「新しく作る」相談である**（対象は存在しなかった）。`0049` の
-- `generations.kind` と同じ判断で、**遡って埋まる値に「分からない」を表す 3 つ目の状態を作らない。**
-- NULL 許容だと、引く側が `is null or = 'new'` を書き忘れた日に**別の対象の会話が混ざる。**
--
-- ## `target_id` は参照制約を張らない
--
-- **フォーク元は他人の作品で、その作者が消せる**（8.4 の措置・退会・作者の削除）。制約を張ると、
-- **他人の作品が消えた瞬間に、こちらの会話の削除まで巻き込まれる**か、削除そのものが止まる。
-- **会話は 30 日で消える短命の記録**（5.16）なので、**指す先が消えても困らない形にしておく。**
ALTER TABLE chat_conversations ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'new';
ALTER TABLE chat_conversations ADD COLUMN target_id TEXT;

-- 本人の「この対象のいちばん新しい会話」を引く（画面が開いたときの復元）。
-- **`chat_conversations_user_idx` は残す**——退会（段3）と掃除は対象を問わずに引く。
CREATE INDEX chat_conversations_target_idx
  ON chat_conversations(user_id, target_kind, target_id, updated_at DESC);
