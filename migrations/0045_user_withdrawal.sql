-- 利用者が自分で退会する土台（仕様 3.7 / 5.1 / 5.10 / #518 / M15-3。土台は #586 / M15-3a）。
--
-- **退会の状態を持つ 3 列**と、**後続の処理が対象を切るための部分索引 1 本**と、
-- **退会を始めた利用者の新しい作品・推敲を D1 の側で塞ぐトリガ 3 本**を足す。
-- **利用者から見える動きは 1 つも変わらない**——この列を書く経路は、後続の処理
-- （`src/withdrawal-purge.ts`）から呼ぶ `src/withdrawal.ts` だけで、**利用者が押せる口は
-- まだ無い**（口・画面・ログインの停止・法務文書は #518 が書く）。
--
--
-- ## なぜ 3 列なのか（1 列の状態や真偽値にしない）
--
-- 退会は**押した要求の中で終わらない**。要求の中でできるのは「掴む → アイコンを R2 から
-- 消す → 匿名化と取り下げを 1 つの batch で確定する」までで、**作品の削除は 1 件 14 文** かかる
-- （`src/game-deletion.ts`）。作品が 60 本ある利用者では D1 の 1 呼び出しの枠（50 クエリ）に
-- まったく収まらないので、残りは 5 分ごとに起きる Worker（`game-forge-cleanup`）が消す。
-- **3 つの時刻は、その 3 つの段がどこまで進んだかである。**
--
-- | 列 | 意味 | NULL の意味 |
-- |---|---|---|
-- | `withdrawal_started_at` | 退会を掴んだ時刻（**退会処理中**）。**立った時点で、この利用者の新しい作品と推敲が止まる**（下のトリガ） | 退会していない |
-- | `withdrawn_at` | 押した要求の中の処理が確定した時刻（**退会済み**。匿名化・履歴・ハンドル・台帳・一括の取り下げが済んでいる） | 要求の中の処理が済んでいない |
-- | `withdrawal_completed_at` | 後続の処理が作品を全件消し、**アイコンの接頭辞が R2 で空だと確かめた**時刻 | 後続が済んでいない |
--
-- **真偽値にしない**（`0041` の `deletion_started_at` と同じ）。途中で止まった退会を運用が
-- 見つけるとき（`scripts/withdrawal-status.sh`）、**いつ始まったかが要る**——後続の処理は
-- 「始めて 10 分たった処理中の要求」を代わりに打ち直すので、その判定そのものが時刻を読む。
--
-- **3 本目を列にする理由は 2 つある。**
--
-- 1. **後続の処理が見る利用者を部分索引で切れる**（下の `users_withdrawal_pending_idx`）。
--    5 分ごとに `users` を全走査させない
-- 2. **「R2 の接頭辞が空だった」ことは D1 から導けない。** アイコンの写しは
--    `avatars/history/<user_id>/` の一覧そのもので、**D1 に記録の無い写しもありうる**
--    （`avatar_changes.history_key` は追記の記録で、R2 の実態ではない）。確かめた事実は
--    確かめた側が書き残すしかない
--
--
-- ## 列どうしの順序を CHECK で縛る
--
-- 3 つの時刻は**必ずこの順に立つ**。逆順や飛び越しは、どこかの経路が段を飛ばした証拠であって、
-- 「そういう状態もある」ではない。**壊れた順序を D1 が受け取らないようにする。**
--
-- **他の列を参照する CHECK を `ADD COLUMN` で足せることは、ローカルの D1 で確かめた**
-- （2026-09-16。`alter table t add column c integer check (c is null or a is not null)` が通り、
-- `a` が NULL の行に `c` を入れる INSERT が `SQLITE_CONSTRAINT_CHECK` で落ちた）。
-- SQLite が `ADD COLUMN` で拒むのは PRIMARY KEY / UNIQUE / 既定値が非決定的なもの /
-- 既定値の無い NOT NULL であり、CHECK はそこに入らない。
--
-- **既存の行の埋め戻しは要らない**（3 列とも NULL が「まだ」を表し、この列を書く経路は
-- いままで無かった）。
--
--
-- ## 退会を始めた利用者の新しい作品と推敲を、D1 の側で塞ぐ（トリガ 3 本）
--
-- 退会は**掴んでから確定するまでのあいだに数百ミリ秒ある**。そのあいだに同じ利用者の別のタブが
-- 生成やリフォージを始めると、**一括の取り下げが数え終えた後に新しい作品が生まれる**——
-- 退会済みの利用者の作品が公開面に残り、後続の処理は自分が数えた候補にそれを含めない。
--
-- **塞ぐ場所をアプリの SQL にしない。** 作品を作る `insertPendingGame`（`src/games.ts`）と
-- 推敲の枠を取る `claimRevisionSlot`（`src/revisions.ts`）は、**どちらもオーケストレータ
-- Lambda の束に入る**。条件を 1 つ足すだけで `CodeSha256` が変わり、**配り直すまで main の
-- 配備が全部止まる**（`docs/handoff.md` 4 章）。`0041` が版の挿入に対して採ったのと同じ形で、
-- **D1 の側にトリガを置いて、その 1 行の挿入を黙って飛ばす。**
--
-- - **`IGNORE` にする（`ABORT` にしない）。** 投げると、退会と同時に押した生成が 500 になる。
--   飛ばされた挿入は 0 行で、文そのものは成功する——`insertPendingGame` は 0 行を「進行中の
--   要求がある」と同じ扱い（409）で返すので、**呼び出し元は既にこの形を知っている**
-- - **本体は `SELECT RAISE(IGNORE)` だけで、何も書かない**（`0041` と同じ。`meta.changes` を
--   膨らませない。`0037` の検索の索引のトリガとは違う）
-- - **BEFORE なので外部キーの検査より先に効く**
--
-- **`game_revision_jobs` には INSERT と UPDATE の 2 本を置く。** `claimRevisionSlot` は
-- `insert ... on conflict(game_id) do update set ... state = 'pending'` の UPSERT で枠を取るので、
-- 「まだ枠が無い」と「前の枠を取り直す」の 2 経路がある。
--
-- **UPSERT の INSERT の側が `RAISE(IGNORE)` になったとき、DO UPDATE へ進まないことは
-- ローカルの D1 で確かめた**（2026-09-16）。行が無い場合は 0 行のまま何も起きず、
-- **行がある場合も `do update` は走らなかった**（`state` が元の値のまま残った）。
-- BEFORE INSERT のトリガは一意制約の検査より先に効き、`RAISE(IGNORE)` はその行の挿入を
-- 丸ごと飛ばすので、**衝突そのものが起きない**ためである。それでも UPDATE の側を置くのは、
-- UPSERT 以外の経路（将来、ジョブの状態を直接戻す文）が同じ穴を開けないようにするためで、
-- **`NEW.state = 'pending'` のときだけ**当てる（`running` への遷移や失敗の記録は止めない
-- ——走っているジョブを宙に浮かせると、費用台帳のコールバックが行き先を失う）。
--
--
-- ## 既存の問い合わせへの影響
--
-- - **部分索引は `users` に初めて張るものではない**（`users_banned_idx`（0020）・
--   `users_operator_idx`（0021）が既にある）。列も条件も重ならないので、既存の問い合わせの
--   計画は動かない（`docs/handoff.md` 4 章の「部分索引が別の問い合わせの計画を奪う」は、
--   同じ問い合わせが選びうる索引どうしの話である）
-- - **参加者の数え方（`PARTICIPANT_WHERE_SQL`）は、この土台では変えない。** 変えるのは #518
--   （変えると `test/participant-cap.test.ts` と `scripts/invite-stock.sh` の両方が追随する）
-- - **`BANNED_USERS_SQL`・招待枠の残高・`inviteQuotaHalted` は変えない**
--
--
-- ## 連番が 0045 である理由
--
-- 着手時に空いている最小の番号である（origin/main `11bdb2f` の `migrations/` の最大が `0044`）。

ALTER TABLE users ADD COLUMN withdrawal_started_at INTEGER
  CHECK (withdrawal_started_at IS NULL OR withdrawal_started_at > 0);

-- **掴む前に確定はできない。** `withdrawn_at` が立つのは、掴んだ行の batch の最後だけである。
ALTER TABLE users ADD COLUMN withdrawn_at INTEGER
  CHECK (withdrawn_at IS NULL
         OR (withdrawal_started_at IS NOT NULL AND withdrawn_at >= withdrawal_started_at));

-- **確定する前に完了はできない。** 後続の処理は `withdrawn_at` が立った利用者しか見ない。
ALTER TABLE users ADD COLUMN withdrawal_completed_at INTEGER
  CHECK (withdrawal_completed_at IS NULL
         OR (withdrawn_at IS NOT NULL AND withdrawal_completed_at >= withdrawn_at));

-- 後続の処理（`src/withdrawal-purge.ts`）が 5 分ごとに引く「終わっていない退会」。
-- **掴んだが完了していない行だけ**を持つので、平常時は 0 行である。
CREATE INDEX users_withdrawal_pending_idx ON users(id)
  WHERE withdrawal_started_at IS NOT NULL AND withdrawal_completed_at IS NULL;

-- 退会を始めた利用者の新しい作品を作らせない（`insertPendingGame` は 0 行 → 409）。
CREATE TRIGGER games_skip_withdrawn_author
BEFORE INSERT ON games
WHEN EXISTS (SELECT 1 FROM users
              WHERE id = NEW.author_id AND withdrawal_started_at IS NOT NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- 同じく、推敲の枠を取らせない（`claimRevisionSlot` の UPSERT の INSERT の側）。
CREATE TRIGGER game_revision_jobs_skip_withdrawn_author
BEFORE INSERT ON game_revision_jobs
WHEN EXISTS (SELECT 1 FROM games g
               JOIN users u ON u.id = g.author_id
              WHERE g.id = NEW.game_id AND u.withdrawal_started_at IS NOT NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- 止まった枠を `pending` へ戻す経路も塞ぐ（`running` への遷移と失敗の記録は止めない）。
CREATE TRIGGER game_revision_jobs_skip_withdrawn_author_restart
BEFORE UPDATE OF state ON game_revision_jobs
WHEN NEW.state = 'pending'
 AND EXISTS (SELECT 1 FROM games g
               JOIN users u ON u.id = g.author_id
              WHERE g.id = NEW.game_id AND u.withdrawal_started_at IS NOT NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;
