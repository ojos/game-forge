-- ハンドル名（`/@handle`）と、その変更の履歴（5.10 / 2.3.1 / #381 / M12-13）。
--
-- ## 1 つの表で「いま使っている」と「改名のあと予約している」を持つ（`handles`）
--
-- **主キーはハンドル名そのもの**である。1 行が「このハンドル名は、この利用者のもの」を表し、
--
--   - `released_at` が NULL … **いま使っている**ハンドル名（利用者ごとに高々 1 つ。下の部分索引）
--   - `released_at` が値を持つ … **改名で手放した**ハンドル名。**手放してから 90 日は本人以外が取れない**
--     （利用者の決定。`src/handle.ts` の `HANDLE_RESERVATION_SECONDS`）。期限を過ぎた行は、次に誰かが
--     そのハンドル名を取るときに消す
--
-- **現役と予約中を同じ主キーで一意にする。** 表を 2 つに分ける（`users.handle` と予約の表）と、
-- 「現役の表には無いが予約の表にはある」ハンドル名を 2 か所で見なければならず、**同じ名前を 2 人が
-- 同時に取りに来たときに、片方の表だけを見た書き込みが両方通る**。1 つの主キーなら、
-- 後から来た INSERT が一意制約で落ち、batch ごと巻き戻る（`src/handle.ts` の `changeHandle`）。
--
-- **大文字小文字を区別しない**のは、保存する前に小文字へ落とすことで行う（`Foo` と `foo` を同じ行にする）。
-- CHECK が小文字の ASCII・数字・`_` の 3〜20 文字だけを許すので、端末から大文字を入れた行も入らない
-- （`GLOB` は大文字小文字を区別する）。
--
-- ### `users` に列を足さない
--
-- **一覧の SQL は `games` から `users` を主キーで引いている**（`left join users u on u.id = g.author_id`）。
-- ハンドル名は相関副問い合わせで `handles` の部分索引から 1 行引く（`src/handle-sql.ts`）。
-- **`users` へ列も索引も足さない**——部分索引を足すと、見積もりが同点の別の問い合わせの計画を奪うことがある
-- （`docs/handoff.md` 4 章。0036 の張り直し）。**この表の索引は `handles` の上にしか無い**ので、
-- `games` と `users` を引く問い合わせの計画は変わらない。
--
-- ## 変更の履歴を追記だけで持つ（`handle_changes`。#405 の申し送り）
--
-- **形は `display_name_changes`（0030）と同じ**（`old_*` / `new_*` / `changed_at`）。
--
--   - `old_handle` … 変える前のハンドル名。**初めて決めたときは NULL**
--   - `new_handle` … 変えた後のハンドル名
--
-- - **更新と 1 つの `D1.batch` で書き、履歴を先に置く**（旧い値は更新の前の行からしか取れない）。
--   **履歴の WHERE は更新の WHERE と同じ綴り**にしてあり、**間隔で断った変更では履歴も 0 行になる。**
--   ハンドル名が他人のものだった（一意制約で落ちた）ときは batch ごと巻き戻り、履歴も残らない
-- - **更新も削除もしない**（アプリにこの表を UPDATE / DELETE する経路を作らない）
--
-- ### 「書き始めた時刻」の表は持たない（0030 と違う）
--
-- **この migration が、値の表と履歴の表を同時に作る。** 表ができる前にハンドル名は存在せず、
-- `handles` を書く経路はアプリの 1 か所だけで、そこは必ず履歴を同じ batch で積む（0032 / 0038 と同じ理由）。
--
-- ## 利用者と同じ寿命
--
-- **`users` の行を消すときは、この 2 表の行を先に消す**（外部キー）。**`on delete cascade` は書かない**
-- （0027 / 0030 と同じ。発火しない宣言は「消えるはず」という誤読だけを残す）。
--
-- ## CHECK
--
-- - **ハンドル名は小文字の ASCII・数字・`_` の 3〜20 文字**（`src/handle-paths.ts` の `HANDLE_PATTERN` と同じ規則。
--   `test/schema-handles.test.ts` が同じ入力で突き合わせる）。**全角・ゼロ幅・文字の向きを変える書式文字は
--   許可リストの外なので、構造的に入らない**
-- - **時刻は 0 より大きい**（0027 / 0030 と同じ理由）。**手放した時刻は取った時刻より前にならない**
--
-- ## 索引
--
-- - **`handles_user_current_idx`（部分・一意）** … 「利用者ごとにいま使っているハンドル名は高々 1 つ」を
--   表の側でも保証し、一覧の相関副問い合わせ（`user_id = ? and released_at is null`）がこれを引く
-- - **`handle_changes_user_changed_idx`** … 「その利用者の、ある時刻の前後で最も近い変更」を範囲の端で
--   引けるようにする（0027 / 0028 / 0030 と同じ並び）
--
-- **書き込みの増分**（3.6）は、変更 1 回につき高々 9 行（予約の切れた行の削除・履歴と索引・手放す更新と
-- 部分索引・取る INSERT と主キーと部分索引）で、**改名は 30 日に 1 回まで**なので無視できる。
-- 断った変更は 1 行も書かない。
--
-- ## 連番について
--
-- **コードとテストと文書にはこの番号を書かない**（ファイル名だけが番号を持つ。並行する作業が
-- マージの順で振り直すことがある。`docs/handoff.md` 4 章）。

CREATE TABLE handles (
  -- ハンドル名（小文字）。**主キーなので、現役と予約中を合わせて同じ名前は 1 行しか無い。**
  handle TEXT PRIMARY KEY
    CHECK (length(handle) BETWEEN 3 AND 20 AND handle NOT GLOB '*[^a-z0-9_]*'),
  -- このハンドル名を持つ（または改名で手放して予約している）利用者。
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 取った時刻（UNIX 秒）。**改名の間隔（30 日）はいま使っている行のこの値で判定する。**
  claimed_at INTEGER NOT NULL CHECK (claimed_at > 0),
  -- 改名で手放した時刻（UNIX 秒）。**NULL がいま使っている行。**
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= claimed_at)
);

-- 利用者ごとに、いま使っているハンドル名は高々 1 つ（上記）。
CREATE UNIQUE INDEX handles_user_current_idx ON handles (user_id) WHERE released_at IS NULL;

CREATE TABLE handle_changes (
  id TEXT PRIMARY KEY,
  -- 変えた利用者。**実在する利用者しか入らない**（書く経路は利用者の行を確かめてから書く）。
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 変える前のハンドル名（初めて決めたときは NULL）。
  old_handle TEXT
    CHECK (old_handle IS NULL OR (length(old_handle) BETWEEN 3 AND 20 AND old_handle NOT GLOB '*[^a-z0-9_]*')),
  -- 変えた後のハンドル名。
  new_handle TEXT NOT NULL
    CHECK (length(new_handle) BETWEEN 3 AND 20 AND new_handle NOT GLOB '*[^a-z0-9_]*'),
  -- 変えた時刻（UNIX 秒）。**0 以下は入らない**（上記）。
  changed_at INTEGER NOT NULL CHECK (changed_at > 0)
);

-- 「その利用者の、ある時刻の前後で最も近い変更」を引くための索引（0027 / 0028 / 0030 と同じ並び）。
CREATE INDEX handle_changes_user_changed_idx ON handle_changes (user_id, changed_at);
