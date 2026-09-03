-- 入力側モデレーションで遮断したことを残す（8.2 / #37）。
--
-- ## なぜ表が要るのか
--
-- **閾値を下げる判断に要る。** 8.2 の初期強度（暴力 LOW / 他 MEDIUM / プロンプト攻撃
-- HIGH）は当てずっぽうではないが、実測ではない。**誤検出かどうかは本文を見ないと
-- 判定できず**、本文が無ければ「暴力で 20 件落ちた」までしか分からない。
-- 閾値を下げる判断が、利用者からの苦情待ちになる。
--
-- **#41（送信防止措置の記録）の材料でもある。** 追記のみの形で保存する。
--
-- ## `generations` へ入れない
--
-- **枠は `generations` の行数で数える**（確定25）。遮断した要求の行を入れると
-- **遮断が生成枠を消費する**——#37 の acceptance が明示的に禁じているものである。
--
-- ## `games` にも残る
--
-- 遮断された要求は `games.generation_error = 'prompt-blocked'` として残る
-- （`src/games.ts` の `GENERATION_ERROR_CODES`）。**この表はそれと重複しない**
-- ——あちらは「この作品がどうなったか」で、こちらは「何が引っ掛かったか」である。
-- 画面がカテゴリ名を出すときだけ、こちらを 1 行引く。
--
-- ## 本文を入れる（決定と理由）
--
-- **有害な入力そのものを永続化する。** intake で決めた（2026-09-03）。受け入れられた
-- プロンプトは既に `generations.prompt` へ平文で入っており、扱うデータの種類は増えない。
-- **保持は 90 日**とし、超えた行を消す経路を `scripts/moderation-prune.sh` が持つ。
--
-- ## 索引を張らない
--
-- 索引は 1 行の insert につき 1 行の書き込みを足す（3.6）。**平常時この表はほとんど
-- 増えない**（遮断は例外的な出来事である）。90 日の削除は全走査で足り、画面が引くのは
-- `game_id` の 1 行だけである。**「将来使うかもしれない」で足さない**（0001 の方針）。

CREATE TABLE moderation_blocks (
  id TEXT PRIMARY KEY,
  -- 遮断された要求の作品行。**外部キーを張る**——`games` 側は残る（tombstone では
  -- なく失敗として残る）ので、宙に浮かない。
  game_id TEXT NOT NULL REFERENCES games(id),
  -- 誰の要求か。**BAN（M6-4）が `google_sub` 単位なので、そちらとは別軸である。**
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Guardrail が返したカテゴリ名を並べたもの。**区切り文字の正本は
  -- `src/input-moderation.ts` の `MODERATION_CATEGORY_SEPARATOR` である**（値をここへ
  -- 書き写さない。確定24 と同じ規約）。
  categories TEXT NOT NULL,
  -- 遮断された本文。**90 日で消す**（上記）。
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
