-- 削除申請に採った措置を、操作の履歴へ残せるようにする（8.4 / 2.4.3 / 2.4.4 / #406。M10-4）。
--
-- **`admin_actions` を作り直し、CHECK へ措置 3 つと対象の種類 1 つを足す。** 行・rowid・
-- 索引（`0029`）はそのまま移す。
--
--
-- ## なぜ作り直すのか
--
-- 8.4 は「**採った措置は `admin_actions` に追記で残す**」と定めている。ところが 0026 の CHECK は
-- `action` を 4 つ（審査の往復と BAN の付け外し）、`target_kind` を `game` / `user` に縛っており、
-- **削除申請の措置は 1 行も入らない。** SQLite は CHECK を後から変えられないので、
-- **表を作り直すしかない**（SQLite の表の再構築の手順。<https://www.sqlite.org/lang_altertable.html>）。
--
-- **別の表を足す形は採らない**（#406 の intake で決めた）。履歴が 2 か所に分かれると、
-- 2.4.4 の「画面から読めるようにする」が 2 つの表を合わせて読むことになり、
-- **0026 の「綴りを表でも縛る」も 2 つの表で別々に守ることになる。**
--
-- **`takedown_requests` に実行者の列を足す形も採らない。** 0018 は措置の列
-- （`handled_at` / `action` / `note`）を持つが「誰が」を持たず、足しても 8.4 の
-- 「`admin_actions` に残す」は満たさない。**措置の記録は `takedown_requests`、誰がいつ
-- 何を理由にしたかは `admin_actions`** と役割を分け、**1 つの batch で両方へ書く**
-- （`src/admin/actions.ts` の `recordTakedownAction`）。
--
--
-- ## 0007 が避けた作り直しを、ここで採ってよい理由
--
-- 0007 は `games.status` の CHECK を広げるための作り直しを「採らない」と決めた。
-- あちらは **`games`**——自己参照（`parent_id`）を持ち、`reports` / `game_revisions` /
-- `title_changes` など 8 つの表から外部キーで参照される。作り直しの途中で参照が壊れる
-- 危険が大きかった。
--
-- **`admin_actions` はその逆である。**
--
--   - **自己参照が無い**
--   - **どの表からも参照されない**（参照するのは `actor_id → users(id)` の 1 本だけ）
--   - **行は運営が画面を押した回数しか無い**（0026。本番でも数十行）
--
-- `DROP TABLE` はこの表の行を消すだけで、**ほかの表の行には 1 つも触れない。**
--
--
-- ## rowid を写す
--
-- **`INSERT ... SELECT` で rowid を明示して移す。** 履歴の画面（`listAdminActions`）は
-- **同じ秒の並びを `rowid desc` で決めている**（0026 の「索引を張らない」と
-- `src/admin/actions.ts`）。rowid を写さないと、**新しい表での rowid は SELECT が返した順に
-- 振り直され**、その順は SQL の意味として保証されない——同じ秒に積んだ 2 行の前後が
-- 入れ替わりうる。
--
--
-- ## 索引を張り直す
--
-- **`DROP TABLE` はその表の索引も消す。** `0029` の `admin_actions_target_idx` を同じ列の順で
-- 張り直す。**張り忘れても条件の意味は変わらず、どの検査も緑のまま通る**（0029 の「適用し
-- 忘れても壊れない」）——読み取りが `cleared` の作品数の 2 乗へ戻るだけである。そこで
-- `test/admin-actions-rebuild.test.ts` が、作り直した後に索引があることを見る。
--
-- **#394 / #404 / #405 の読み取りはこの索引と `review-cleared` / `game` の綴りを使う**
-- （`src/reports.ts` の `REVIEW_REPORTED_AFTER_CLEAR_SQL`。`scripts/report-queue.sh` が同じ
-- 定数を awk で取り出す）。**既存の綴りは 1 つも変えない。**
--
--
-- ## 足す綴り
--
-- **`action`: `takedown-removed` / `takedown-restricted` / `takedown-rejected`。** 措置の綴りの
-- 正本は `src/takedown.ts` の `TAKEDOWN_ACTIONS` で、履歴の綴りは `src/admin/actions.ts` の
-- `ADMIN_ACTIONS` がそこから導く。**CHECK との一致は `test/admin-actions.test.ts` が、
-- 適用済みの表の定義（`sqlite_master`）から取り出して機械照合する。**
--
-- **`takedown-removed` は「削除の措置を記録した」であって、作品を取り下げたことではない。**
-- 取り下げ（`games.status = 'removed'`）は画面に置かない操作のまま（2.4.3）で、**0026 が
-- 足さないと決めた `game-removed` はここでも足さない。**
--
-- **`target_kind`: `takedown`。** `target_id` は `takedown_requests.id` である
-- （0026 の「外部キーは実行者にだけ張る」のとおり、ここにも外部キーを張らない）。
--
--
-- ## 本番への適用
--
-- **マージの前に適用する**（0026 と同じ）。適用前の表へ新しい Worker が `takedown-*` を書くと、
-- **CHECK で batch ごと落ち、措置が 1 件も記録できない。** 逆に、適用後も古い Worker は
-- 既存の 4 つの綴りしか書かないので、**先に適用して壊れるものは無い。**
--
--
-- ## 連番が 0031 である理由
--
-- `0030` は #405（`display_name_changes`）が使用済みで、`docs/handoff.md` の台帳が「次の空きは
-- 0031（M11-2 #396 / M10-4 #406 が取り合う）」としていた。**着手時に並行セッションへ宣言して
-- 取った**（`migrations/` を数えて max+1 を取っていない——0009 の衝突はそれで起きた）。

CREATE TABLE admin_actions_new (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  -- 何をしたか。**綴りの正本は `src/admin/actions.ts` の `ADMIN_ACTIONS`。**
  action TEXT NOT NULL CHECK (
    action IN (
      'review-queued', 'review-cleared', 'user-banned', 'user-unbanned',
      'takedown-removed', 'takedown-restricted', 'takedown-rejected'
    )
  ),
  -- 対象の種類。**`target_id` の行き先がどの表かを、この列だけが知っている**（0026）。
  target_kind TEXT NOT NULL CHECK (target_kind IN ('game', 'user', 'takedown')),
  target_id TEXT NOT NULL,
  -- 判断の理由（**必須**。2.4.4）。
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0)
);

INSERT INTO admin_actions_new (rowid, id, actor_id, created_at, action, target_kind, target_id, reason)
  SELECT rowid, id, actor_id, created_at, action, target_kind, target_id, reason
    FROM admin_actions;

DROP TABLE admin_actions;

ALTER TABLE admin_actions_new RENAME TO admin_actions;

CREATE INDEX admin_actions_target_idx
  ON admin_actions (target_kind, target_id, action, created_at);
