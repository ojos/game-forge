-- 試用の録画（#978）。/trial（#977）の流れの中で録った、画面と声の録画 1 本につき 1 行。
--
-- ## 中身は R2 にあり、ここには目録だけを置く
--
-- 断片は非公開のバケット（`TRIAL_RECORDINGS`。terraform/trial-recordings.tf）に
-- `trial/<利用者の id>/<録画の id>/<連番 6 桁>` で置く（`src/trial-recording.ts`）。この表が持つのは、
-- 録画を始めた時刻・形式・受け取った断片の数と大きさ・止まった理由だけである。
--
-- ## 連番は「次に受け取る番号」1 列で持つ
--
-- 断片の口は `seq = next_seq` のときだけ受け取り、R2 に書いてから `next_seq` を 1 つ進める（条件付き UPDATE 1 文）。
-- **すでに受け取った番号（`seq < next_seq`）は上書きせずに受け取ったことにする**（冪等。送り直しで同じ断片が
-- 2 度届くのは平常の形である）。**先の番号（`seq > next_seq`）は断る**——抜けたまま進めると、つないだ録画が
-- 再生できない。断片ごとに行を作らないのは、1 本（最大 60 分）で 720 行になり、合計の大きさを数えるのに
-- 読みが要るからである。
--
-- ## 録画を始めた時刻は、振り返りの各問の時刻と同じ物差しで持つ
--
-- `started_at` はサーバーの時刻（UNIX 秒）で、`trial_participants.q1_at`〜`q5_at` と同じ時計である。
-- 録画の中の時刻 = 各問の時刻 − `started_at`（秒）で突き合わせる。
--
-- ## 90 日で消える
--
-- 断片は R2 のライフサイクルが、置いてから 89 日（90 日から R2 の遅れの 1 日を引いた日数）で消す
-- （terraform/trial-recordings.tf）。この表の行は `game-forge-cleanup` の cron が、始めてから 91 日（90 日＋遅れ）を
-- 過ぎたものを消す（`src/trial-store.ts` の `sweepExpiredTrialRecords`）。**行は断片より後まで残る**——頼まれて
-- 消すとき、管理画面が行から録画を見つけられるようにするため。
CREATE TABLE trial_recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 録画を始めた時刻（サーバーの UNIX 秒。録画の頭にあたる）。
  started_at INTEGER NOT NULL,
  -- MediaRecorder に渡した形式（例 `video/webm;codecs=vp9,opus`）と、つないだときの入れ物。
  mime_type TEXT NOT NULL,
  container TEXT NOT NULL CHECK (container IN ('webm', 'mp4')),
  -- 録画に使ったブラウザ（chrome / edge / safari / firefox）と、取り込んだ面（browser / window / monitor。分からなければ NULL）。
  browser TEXT,
  display_surface TEXT,
  -- 次に受け取る断片の番号（= 受け取った断片の数）と、受け取った大きさの合計（バイト）。
  next_seq INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  -- 最後に断片を受け取った時刻。
  last_chunk_at INTEGER,
  -- 録画が止まった時刻と理由（finished = アンケートへ進んだ / share-ended = 試用者が共有を止めた /
  -- time-limit = 60 分に達した / error = ブラウザの録画が失敗した）。止まったことが届かなければ NULL のまま。
  ended_at INTEGER,
  end_reason TEXT CHECK (end_reason IN ('finished', 'share-ended', 'time-limit', 'error'))
);

-- 管理画面が試用者ごとに引き、口が 1 人あたりの本数と合計を数える。
CREATE INDEX trial_recordings_user ON trial_recordings (user_id, started_at);
