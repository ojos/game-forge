-- アイコン画像（5.10 / 3.7 / 7.2 / #380 / M12-12）と、その変更の履歴。
--
-- ## 列を 2 つ足す（画像そのものは R2 に置く）
--
--   - `avatar_sha256` … いま使っているアイコン（再エンコードした後の WebP）の SHA-256（16 進 64 桁）。
--     **NULL が「設定していない」**（既定の図形を出す）
--   - `avatar_set_at` … アイコンを最後に設定した・外した時刻（UNIX 秒）。NULL は「1 度も触っていない」
--
-- **画像の在り処（R2 のキー）は列に持たない。** 利用者ごとに 1 つに固定する
-- （`avatars/<user_id>.webp`。`src/avatar-paths.ts`）。**ヘッダのアバターは D1 を読まずに
-- 描く**（`src/html.ts` の `resolveSiteViewer` は署名しか見ない）ので、キーは利用者の id だけから
-- 決まる必要がある。
--
-- ### `avatar_set_at` を 2 つの用途に使う
--
-- 1. **画像の URL の版**（`?v=<avatar_set_at>`。仕様 2.3.8）。`avatar_sha256` が NULL でない行に
--    ついてだけ意味を持つ（一覧の SQL は `case` で NULL へ倒して選ぶ）
-- 2. **変更の間隔**（60 秒。表示名・自己紹介と同じ形で WHERE に置く）。**外したときも進める**
--    ——外して付け直す連打を、付け替えの連打と同じ間隔で絞る（1 回の設定は Lambda の呼び出し
--    1 回と R2 の書き込み 2 回を伴う）
--
-- ## 変更の履歴を追記だけで持つ（`avatar_changes`。#405 の申し送り）
--
-- **形は `display_name_changes`（0030）・`profile_changes` と同じ**（`old_*` / `new_*` / `changed_at`）。
--
--   - `old_sha256` / `new_sha256` … 変える前と後の画像の SHA-256。**NULL は「無い」**（初めて付けた・外した）
--   - `history_key` … **変える前の画像を移した R2 のキー**（`avatars/history/...`）。変える前の画像が
--     無かったとき、および運営が端末で消したとき（画像を残さない）は NULL
--   - `changed_at` … 変えた時刻
--
-- **画像そのものは D1 に置かない。** 差し替え前の画像は R2 の `avatars/history/` へ写し、
-- **R2 のライフサイクル規則が 30 日で消す**（`terraform/r2-lifecycle.tf`。利用者の決定）。
-- **履歴の行は消えない**——30 日を過ぎた行は「画像は保存期間を過ぎて消えました」と扱う
-- （`src/avatar.ts` の `avatarHistoryImageState`。判定は `changed_at` と保存期間だけで決まり、
-- R2 を引かない）。SHA-256 は残るので、同じ画像が再び上げられたことは後からでも分かる。
--
-- - **更新と 1 つの `D1.batch` で書き、履歴を先に置く**（旧い値は UPDATE の前の行からしか取れない）。
--   **履歴の WHERE は UPDATE の WHERE と同じ綴り**にしてあり、**間隔で断った変更では履歴も 0 行になる。**
--   履歴の insert が落ちれば batch ごと巻き戻り、アイコンも変わらない
-- - **更新も削除もしない**（アプリにこの表を UPDATE / DELETE する経路を作らない）
--
-- ### 「書き始めた時刻」の表は持たない（0030 と違う）
--
-- **この migration が、値の列と履歴の表を同時に作る。** 列ができる前にアイコンは存在せず、列を書く
-- 経路はアプリの 1 か所だけで、そこは必ず履歴を同じ batch で積む（`profile_changes` と同じ理由）。
--
-- ### 運営が端末で消すとき（`docs/takedown.md`）
--
-- **その UPDATE は履歴を書かない。** 手順は **R2 から現行と履歴の画像を消す → 列を空にする → 直った行に
-- ついてだけ履歴を 1 行積む**（`history_key` は NULL。画像を残さないため）。端末からの複数の文が
-- 1 つのトランザクションになることを前提にしない（0026 / 0030 と同じ但し書き）。
--
-- ## 利用者と同じ寿命
--
-- **`users` の行を消すときは、この表の行を先に消す**（外部キー）。**`on delete cascade` は書かない**
-- （0027 / 0030 と同じ）。
--
-- ## `id` を主キーにする・索引を張る
--
-- 0030 と同じ理由である（同じ秒の 2 度目が一意制約で落ちると batch ごと巻き戻る／「その利用者の、
-- ある時刻の前後で最も近い変更」を範囲の端で引けるようにする）。**書き込みの増分は、変更 1 回に
-- つき `users` の 1 行と、履歴と索引の 2 行**（3.6。60 秒に 1 回）。
--
-- **`users` へ索引を足さない。** 一覧は `games` から `users` を主キーで引いており（`left join users u
-- on u.id = g.author_id`）、選ぶ列が増えても計画は変わらない。**部分索引を足すと、見積もりが同点の
-- 別の問い合わせの計画を奪うことがある**（`docs/handoff.md` 4 章。0036 の張り直し）ので、要らない
-- 索引を張らない。
--
-- ## CHECK は 3 つ
--
-- - **`changed_at` は 0 より大きい**（0027 / 0030 と同じ理由）
-- - **SHA-256 は 16 進 64 桁**（NULL か、`length = 64`）。**表示の URL には使わない**が、運営が
--   端末で書いた値の綴りを揃えておく
--
-- ## 連番について
--
-- **コードとテストと文書にはこの番号を書かない**（ファイル名だけが番号を持つ。並行する作業が
-- マージの順で振り直すことがある。`docs/handoff.md` 4 章）。

ALTER TABLE users ADD COLUMN avatar_sha256 TEXT CHECK (avatar_sha256 IS NULL OR length(avatar_sha256) = 64);
ALTER TABLE users ADD COLUMN avatar_set_at INTEGER;

CREATE TABLE avatar_changes (
  id TEXT PRIMARY KEY,
  -- 変えた利用者。**実在する利用者しか入らない**（書く経路は `users` を引いて書く）。
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 変える前と後の画像の SHA-256（NULL は「無い」）。
  old_sha256 TEXT CHECK (old_sha256 IS NULL OR length(old_sha256) = 64),
  new_sha256 TEXT CHECK (new_sha256 IS NULL OR length(new_sha256) = 64),
  -- 変える前の画像を移した R2 のキー（無ければ NULL）。**30 日で R2 から消える**（上記）。
  history_key TEXT,
  -- 変えた時刻（UNIX 秒）。**0 以下は入らない**（上記）。
  changed_at INTEGER NOT NULL CHECK (changed_at > 0)
);

-- 「その利用者の、ある時刻の前後で最も近い変更」を引くための索引（0027 / 0028 / 0030 と同じ並び）。
CREATE INDEX avatar_changes_user_changed_idx ON avatar_changes (user_id, changed_at);
