-- チャットを 1 作品 1 本にする（#740 / M21-4。仕様 5.16「会話の粒度——1 作品 1 本」）。
--
-- ## この移行が置く前提
--
-- **これ以降、新規のチャットは「生成する」を押した時点で作品へ付け替わる**
-- （`target_kind = 'new'` → `'revise'` ＋ 作品 id。`src/chat-conversation.ts` の
-- `attachChatConversationsToWork`）。**付け替えは、その人の `'new'` の会話を全部動かす**
-- ——1 本だけを選ぶ形にすると、**残った古い行が次に `/generate` を開いたときに復元され、
-- 「必ず空になる」が崩れる。**
--
-- **ところが、この変更より前の行は 1 人に何本もありうる。** 画面が復元するのは
-- **いちばん新しい 1 本だけ**（5.16「復元するのは最新の 1 本だけである」）で、それより古い
-- `'new'` の行は**作者からは 1 度も見えないまま**残っていた。そのまま付け替えると、
-- **作者が見ていない会話まで、できたての作品にぶら下がる。**
--
-- ## だから、付け替えが始まる前に 1 本へ畳む
--
-- **消すのは「画面に 1 度も出ない `'new'` の行」だけである。** 残すのは各利用者の
-- いちばん新しい 1 本で、**作者が見ている会話は 1 行も消えない。**
--
-- **`/privacy` の 4 つの約束はどれも破らない**（本人しか読めない / 最後に使ってから 30 日で
-- 消える / 本人が消せる / 退会の段3 で消える）。**早く消える向きの変更**であり、保存を
-- 延ばす向きではない。対象は**もともと 30 日で消える短命の記録**である。
--
-- **`'revise'` と `'fork'` の会話は 1 行も触らない**（#727 で既に作品ごとに分かれている）。
--
-- 同じ時刻の行が複数あるときは id の大きいほうを新しいとみなす（順序を一意にするためで、
-- `updated_at` が同じ行が実在するかどうかとは関係がない）。
DELETE FROM chat_conversations
 WHERE target_kind = 'new'
   AND EXISTS (
     SELECT 1
       FROM chat_conversations AS newer
      WHERE newer.user_id = chat_conversations.user_id
        AND newer.target_kind = 'new'
        AND (newer.updated_at > chat_conversations.updated_at
             OR (newer.updated_at = chat_conversations.updated_at
                 AND newer.id > chat_conversations.id))
   );
