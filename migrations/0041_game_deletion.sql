-- 作品を消す土台（仕様 3.7 / 5.1 / 5.3 / #516 / M15-1）。
--
-- **作品 1 件を「行ごと消す」か「行を残して中身だけ消す」かを決めて実行する関数**
-- （`src/game-deletion.ts`）が要る 2 つの列と、被参照判定（確定26 の規約 1）が版の表を
-- 引くための 2 本の索引を足す。**呼び出し元（作者の削除 #517・退会 #518）はまだ無い。**
--
--
-- ## `deletion_started_at`: 削除を掴んだ時刻
--
-- **削除は R2 を消してから D1 を確定する**（3.7 の規約 2 と同じ向き。D1 を先に確定すると、
-- R2 を消す前に落ちたときに「どのキーを消すはずだったか」を知る行が残らない）。R2 と D1 の
-- あいだは数百ミリ秒あき、そのあいだに公開・推敲・改名・版の復元が走ると、**消しかけの成果物を
-- 指す公開作品**や、**確定の直前に積まれた履歴**ができる。
--
-- そこで**削除の開始を条件付き UPDATE 1 本で掴み**、それらの経路の SQL に
-- `deletion_started_at is null` を足して 0 行にする（`claimGenerationJob` と同じ「存在検査と
-- 排他を 1 往復で行う」形）。**NULL が「掴まれていない」**で、既存の行の埋め戻しは要らない
-- （この列を書く経路は今まで無かった）。
--
-- **真偽値にしない。** 途中で落ちた削除を運用が見つけるとき、いつ掴んだかが要る。
--
--
-- ## `purged_at`: 中身を消した印
--
-- 子（フォーク）か運営の記録がある作品は、**行を残して中身だけを消す**（5.3 の tombstone を
-- 一段進めたもの）。`status = 'removed'` だけでは、作者が取り下げただけの tombstone
-- （成果物への参照を残す。5.3）と区別できない。**同じ呼び出しを 2 回打ったときに 2 回目が
-- 何もしないで同じ結果を返す**（冪等）ための判定にも、この列を使う。
--
-- **NULL が「中身を消していない」**で、既存の行の埋め戻しは要らない。
--
--
-- ## `game_revisions` の `source_key` / `wasm_key` に索引を張る
--
-- **版は R2 オブジェクトの参照者である**（5.7 / 確定28 / 0009 の「M5-4 のゴミ掃除はこの表も
-- 引かなければならない」）。被参照判定（`src/build-cache.ts` の `planArtifactDeletion`）が
-- 版の表を引くようになったので、0004 が `games` に張ったのと同じ 2 本を版の表にも張る。
-- 張らないと、候補のキー 1 つごとに版の表を全走査する（候補のキーは 1 作品の版の数の 2 倍ある）。
--
-- **2 本に分ける理由は 0004 と同じ**（2 つのキーの寿命が別。片方だけだと残った側の判定が
-- 全走査に戻る）。**部分索引にしない理由も 0004 と同じ**（問い合わせの綴りが索引の条件に
-- 暗黙に結合する）。**しかも `game_revisions` の 2 列は NOT NULL** なので、部分にする利得も無い。
--
-- **`games` に索引を足していない**ので、`games` を引く既存の問い合わせの計画は動かない
-- （handoff 4 章の「部分索引が別の問い合わせの計画を奪う」は同じ表の索引どうしの話である）。
-- 版の表を主キーで引く既存の問い合わせ（`listRevisions` / `restoreRevision` / 推敲の枠の取得）は
-- `game_id` の等値から入るので、キーの索引とは競合しない。
--
-- **3.6 の書き込み枠への影響。** 版の insert 1 行につき索引の書き込みが 2 行増える。版は
-- 完成のたびに 1 行（月数百〜千行）で、無料枠 10 万行/日 に対して桁で下にある。
--
--
-- ## 掴まれた作品と消えた作品には、版を積まない（BEFORE INSERT トリガ）
--
-- **完成の処理は 1 文ではない。** 生成の完成（`src/generate-callback.ts` の finish）は
-- `completeGameWithArtifacts` で `generation_state = 'ready'` にしたあと、**別の文で**索引を書き、
-- さらに `appendRevision` で `seq = 1` の版を積む。**その隙間に削除が掴んで R2 と D1 を確定すると**、
-- 中身を消した行に消えたキーを指す版が積まれるか、行ごと消えた後なら `game_revisions` の外部キーで
-- `appendRevision` が投げる（コールバックが 500 になる）。
--
-- **コールバックと `appendRevision` の SQL は変えない**（オーケストレータの束に入る。変えれば
-- `CodeSha256` が変わり、配り直すまで main の配備が止まる）。**D1 の側で塞ぐ**——`games` に
-- 掴まれていない行が無ければ、`RAISE(IGNORE)` でその 1 行の挿入を黙って飛ばす。
--
-- - **`IGNORE` にする（`ABORT` にしない）。** 投げるとコールバックが 500 になり、行ごと消えた後の
--   現状と変わらない。飛ばされた挿入は 0 行で、文そのものは成功する
-- - **BEFORE なので外部キーの検査より先に効く**（行ごと消えた後でも投げない）
-- - **本体は `SELECT` だけで何も書かない**ので、`meta.changes` を膨らませない（0037 のトリガとは違う）。
--   版の挿入の行数を読む判定はアプリに無い（`appendRevision` は結果を読まない。推敲の枠の取得は
--   ジョブ行の文の結果を読む）
-- - **推敲の完成（`completeRevision`）は当たらない。** 削除は進行中の推敲のジョブがある行を掴まない
--
-- **索引（`build_cache`）の側は塞がない。** 同じ隙間で、消えたキーを指す索引の行が後から書かれうるが、
-- ヒットの判定（`src/build-cache.ts` の `readBuildCache`）が R2 の実在を確かめて行を落とすので、
-- 次の同一ソースの生成で自己修復する（その生成は再ビルドになるだけで、壊れた作品は生まれない）。
CREATE TRIGGER game_revisions_skip_deleting_game
BEFORE INSERT ON game_revisions
WHEN NOT EXISTS (SELECT 1 FROM games WHERE id = NEW.game_id AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(IGNORE);
END;

--
-- ## 連番が 0041 である理由
--
-- 着手時に空いている最小の番号である（origin/main `52f28ea` の `migrations/` の最大が `0040`）。

ALTER TABLE games ADD COLUMN deletion_started_at INTEGER;

ALTER TABLE games ADD COLUMN purged_at INTEGER;

-- 「このキーを持つ他の作品の版はあるか」を引く（`src/build-cache.ts` の
-- `planArtifactDeletion` / `countArtifactReferences`）。
CREATE INDEX game_revisions_source_key_idx ON game_revisions(source_key);
CREATE INDEX game_revisions_wasm_key_idx ON game_revisions(wasm_key);
