-- 試用の参加者（#977。docs/strategy.md 4 章の 1 の試用を、サイトの中の /trial で終える）。
--
-- ## 1 行が「試用者の印」である
--
-- **行があることが印である**（運営が D1 で 1 行入れる。手順は docs/user-trial.md）。印の無い利用者には
-- /trial を 404 にする（`src/trial.ts`）。**#975（自作リプレイ）の記録の印もこの行に揃える**ので、
-- 表の名前を「試用者」に寄せ、/trial の流れに固有の名前にしない。
--
-- ## 同意の前は、印の 2 列しか持たない
--
-- 運営が入れた時点で埋まるのは `user_id` と `marked_at` だけで、`stage` は既定の `'consent'` である。
-- **同意しなければ、この行は 1 列も書き換わらない**（同意しない人は画面を閉じるだけで、口を呼ばない）。
--
-- ## 段は 1 列で持ち、移り目の時刻を段ごとの列に残す
--
-- **段を飛ばせないことをサーバー側で見る**——段の移り目は「`stage = 今の段` のときだけ次の段へ」の
-- 条件付き UPDATE 1 文で書く（`src/trial-store.ts`）。行を段ごとに分けると、飛ばしの判定に読みが 1 回要る。
-- 1 人あたりの書き込みは、同意・録画の準備・触り終えた・5 問・アンケートの 9 文で、3.6 の上限に触れない。
--
-- 時刻の列は、**その段に入った（その画面を出した）時刻**である。振り返りの各問の時刻（`q1_at`〜`q5_at`）は
-- 録画と突き合わせるために残す。
--
-- ## アンケートの長さは口が縛る
--
-- 列側の制約にしないのは `chat_conversations`（0049）と同じで、上限を変えるたびにマイグレーションが
-- 要らないようにするためである（`src/trial-store.ts` の `TRIAL_SURVEY_LIMITS`）。
--
-- ## 90 日で消える
--
-- `game-forge-cleanup` の cron が、同意した日（同意していなければ印を付けた日）から 90 日を過ぎた行を消す
-- （`sweepExpiredTrialRecords`）。行は数人ぶんしか無いので、索引は足さない。
CREATE TABLE trial_participants (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  marked_at INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'consent'
    CHECK (stage IN ('consent', 'recording', 'explore', 'q1', 'q2', 'q3', 'q4', 'q5', 'survey', 'done')),
  -- 同意した文面の版（`src/trial-text.ts` の `TRIAL_CONSENT_VERSION`）と、同意した時刻（= 録画の準備に入った時刻）。
  consent_version TEXT,
  consented_at INTEGER,
  -- 「Game Forge を新しいタブで開く」の段に入った時刻。
  explore_at INTEGER,
  -- 振り返りの各問を出した時刻（q1_at は「触り終えた」を押した時刻でもある）。
  q1_at INTEGER,
  q2_at INTEGER,
  q3_at INTEGER,
  q4_at INTEGER,
  q5_at INTEGER,
  -- 5 問を答え終えて、アンケートに入った時刻。
  survey_at INTEGER,
  -- アンケートを送った時刻。
  completed_at INTEGER,
  -- アンケートの答え（ブラウザ・AI でものを作った経験・声で言い損ねたこと）。
  survey_browser TEXT,
  survey_ai_experience TEXT,
  survey_missed TEXT
);
