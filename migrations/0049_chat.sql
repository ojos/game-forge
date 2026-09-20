-- 生成の前の相談（#695 / M18-2 / 確定37。仕様 5.16）の、台帳の種別と会話の置き場所。
--
-- ## なぜ台帳に列が要るのか
--
-- **相談 1 往復も「費用の出る LLM 呼び出し 1 回」なので、4.3 の記録規約どおり `generations` に 1 行を積む**
-- （行をまとめない・`cost_jpy` を丸めない・`model` は登録簿の鍵）。**ところが確定25 の日次 10 回は、
-- まさにこの表の行数で数えている**（`src/quota.ts` の `dailyCalls`）。列を足さずに相談の行を積むと、
-- **相談するほど生成枠が減る**——5.16 が「確定25 の日次 10 回は 1 回も減らさない」と決めたのと逆になる。
--
-- **逆に、相談を別の表へ分けると 4.3 の月次 2 万円が相談を数えなくなる。** 5.16 は「月次の判定は今までどおり
-- 全部を合算する（総額には相談も効く）」と決めているので、**同じ表に積んだうえで種別で数え分ける**のが、
-- 2 つの決定を同時に満たす唯一の形である。
--
-- ## 既定を `'generation'` にする（NULL にしない）
--
-- **この列より前の行は、すべて生成の呼び出しである**（相談は存在しなかった）。`0047` の `games.prompt` が
-- NULL を「残していない」として使えたのは、遡って埋められない値だったからである。**こちらは遡って埋まる**
-- ので、「分からない」を表す 3 つ目の状態を作らない。日次枠の SQL が `kind = 'generation'` で絞るとき、
-- NULL 許容だと `is null or = 'generation'` という条件が要り、**書き忘れた側が黙って枠をすり抜ける。**
--
-- ## 索引を足さない
--
-- 相談の枠が引くのは次の 2 本で、どちらも既存の索引で足りる（3.6。索引の更新も書き込み 1 行である）。
--
--   - 1 人 1 日のトークン … `generations(user_id, created_at)`（`0005`）で人と日に絞り、`kind` は残りを弾くだけ
--   - 相談の当月累計の費用 … `generations(created_at)`（`0003`）で月に絞り、同上
--
-- 相談の行は 1 人 1 日およそ 9 行が上限（5.16 の 30,000 トークン）なので、絞った後に残る行は数十行である。
ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'generation'
  CHECK (kind IN ('generation', 'chat'));

-- 相談の会話（仕様 5.16「会話の保存——30 日で消える」）。
--
-- ## 読むのは作者本人だけで、消す約束を 4 つ効かせる
--
--   - **本人にしか返さない**（`user_id` で絞る。1.2.54 の「利用者が入力したプロンプトは伏せる」は本人には当てない）
--   - **最後に使ってから 30 日で消える**（`game-forge-cleanup` の cron が `updated_at` で引く）
--   - **作者が自分で消せる**
--   - **退会の段3 で消える**（`src/withdrawal.ts`。台帳の `prompt` を空にするのと同じ文の並び）
--
-- ## 本文は 1 行の JSON で持つ
--
-- 往復ごとに行を作ると、1 回の相談で D1 の書き込みが往復の数だけ増える（索引込み）。**会話は 1 度に全部を
-- 読み、全部を書き直す**（LLM へ毎回まとめて送るため）ので、行を分けても読み書きの単位は変わらない。
-- 1 会話 1 行にすれば、書き込みは 1 往復につき表の 1 行と索引の 1 行だけで頭打ちになる（3.6）。
--
-- **大きさは口が縛る**（`src/chat.ts` の上限）。列側の制約にしないのは、上限を変えるたびにマイグレーションが
-- 要るためで、`games.prompt` が 2,000 文字を列で縛っていないのと同じ形である。
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 往復の列（JSON）。形の正本は `src/chat-message.ts` の `ChatMessage` である。
  messages TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 本人の「いちばん新しい会話」を引く（画面が開いたときの復元）。
CREATE INDEX chat_conversations_user_idx ON chat_conversations(user_id, updated_at DESC);

-- 掃除の cron が「最後に使ってから 30 日を過ぎた会話」を引く（作者をまたいで走査する）。
CREATE INDEX chat_conversations_updated_idx ON chat_conversations(updated_at);
