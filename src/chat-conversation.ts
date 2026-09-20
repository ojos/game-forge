/**
 * 相談の会話の保存（#695 / M18-2。仕様 5.16「会話の保存——30 日で消える」）。
 *
 * ## 30 日で消える短命の保存である
 *
 * **利用者の決定**（保存しない案と、期限を置かずに保存する案は採らなかった）。消す約束は 4 つで、
 * **`games.prompt`（`0047`）と同じ形**にしてある。
 *
 * | 約束 | どこが守るか |
 * |---|---|
 * | **作者本人にしか返さない** | この モジュールの SQL がすべて `user_id` で絞る |
 * | **最後に使ってから 30 日で消える** | `game-forge-cleanup` の cron（`sweepExpiredChatConversations`） |
 * | **作者が自分で消せる** | `POST /api/chat/conversation/delete`（`src/chat-paths.ts` の `CHAT_CONVERSATION_DELETE_PATH`。`src/chat.ts` の `handleDeleteChatConversation`） |
 * | **退会の段3 で消える** | `src/withdrawal.ts` の確定の batch |
 *
 * ## 1 会話 1 行である
 *
 * 往復ごとに行を作ると、1 回の相談で D1 の書き込みが往復の数だけ増える（索引込み。3.6）。
 * **会話は 1 度に全部を読み、全部を書き直す**（LLM へ毎回まとめて送るため）ので、行を分けても
 * 読み書きの単位は変わらない。**書き込みは 1 往復につき表の 1 行と索引の 1 行**で頭打ちになる。
 *
 * ## 復元するのは最新の 1 本だけである
 *
 * **「いちばん新しい会話」を復元する**（`/generate` を開き直したとき）。会話の一覧も、会話を
 * 選び直す画面も作らない——**#695 の goal は「指示文を練って生成へ渡す」**ことで、
 * 過去の会話を読み返す機能はその外側である（入れるなら別の票）。
 *
 * **古い会話は残る**（消すのは 30 日の掃除と、本人の削除と、退会である）。**新しい会話を始めると
 * 行が 1 本増える**が、復元されるのは最後の 1 本だけである。
 */
import type { ChatMessage } from './chat-payload.js';
import { CHAT_MAX_MESSAGES } from './chat-payload.js';

/**
 * 会話を残す日数（仕様 5.16。利用者の決定）。
 *
 * **「最後に使ってから」である**（`updated_at`）。相談を続けている会話は消えない。
 *
 * 仕様書側の記載との一致は `test/chat-ui.test.ts` が {@link CHAT_RETENTION_PATTERN} で
 * 機械照合する（`/privacy` の文言もこの定数から作る——**書いた日数と実際に消える日数が
 * 食い違わない**ようにするため。`src/avatar.ts` が保存日数を 1 か所に置いているのと同じ形）。
 */
export const CHAT_RETENTION_DAYS = 30;

/** 仕様書と `/privacy` が保存期間を宣言している文の形（テストが照合に使う）。 */
export const CHAT_RETENTION_PATTERN = /最後に使ってから ?\*{0,2}([0-9]+) ?日/gu;

/** 保存されている会話。 */
export interface StoredChatConversation {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
  readonly updatedAt: number;
}

/**
 * 保存された JSON を読む。**壊れていたら null にする。**
 *
 * **例外にしない。** 読めない行は「無かった」として扱い、画面は空の相談から始まる——
 * 会話が壊れていることを理由に、相談そのものを使えなくしない。
 *
 * @param raw `chat_conversations.messages` の値
 * @returns 発話の列、または null
 */
export function parseStoredMessages(raw: unknown): readonly ChatMessage[] | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_MAX_MESSAGES) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    // **役割は交互で、先頭は `user` である**（`src/chat.ts` が受けるときと同じ規則）。
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    if (record['role'] !== expected || typeof record['text'] !== 'string' || record['text'] === '') {
      return null;
    }
    messages.push({ role: expected, text: record['text'] });
  }
  return messages;
}

/**
 * その利用者の、いちばん新しい会話を読む。
 *
 * 索引は `chat_conversations(user_id, updated_at desc)`（`migrations/0049_chat.sql`）。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @returns 会話、または null（1 本も無い・壊れている）
 */
export async function latestChatConversation(
  env: Env,
  userId: string,
): Promise<StoredChatConversation | null> {
  const row = await env.DB.prepare(
    `select id, messages, updated_at
       from chat_conversations
      where user_id = ?
      order by updated_at desc
      limit 1`,
  )
    .bind(userId)
    .first<{ id: string; messages: string; updated_at: number }>();
  if (row === null) {
    return null;
  }
  const messages = parseStoredMessages(row.messages);
  if (messages === null) {
    return null;
  }
  return { id: row.id, messages, updatedAt: row.updated_at };
}

/**
 * 会話を保存する（新しく作るか、上書きする）。
 *
 * **`user_id` を条件に入れて上書きする。** id だけで更新すると、**他人の会話の id を送れば
 * その中身を差し替えられる。** 作品の口が `author_id` で絞るのと同じ線である（5.12）。
 *
 * **上書きが 0 行だったら、新しく作る。** 他人の id・消えた id・無い id はすべてこの枝へ来て、
 * **自分の新しい会話になる**——区別できる応答を返さない（5.12 の「区別できる応答は手がかりに
 * なる」と同じ判断）。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @param conversationId 上書きする会話の id（新しく始めるなら null）
 * @param messages 保存する発話の列
 * @param now 時刻（UNIX 秒）
 * @returns 保存した会話の id
 */
export async function saveChatConversation(
  env: Env,
  userId: string,
  conversationId: string | null,
  messages: readonly ChatMessage[],
  now: number,
): Promise<string> {
  const body = JSON.stringify(messages);
  if (conversationId !== null) {
    const updated = await env.DB.prepare(
      `update chat_conversations set messages = ?, updated_at = ? where id = ? and user_id = ?`,
    )
      .bind(body, now, conversationId, userId)
      .run();
    if ((updated.meta.changes ?? 0) > 0) {
      return conversationId;
    }
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into chat_conversations (id, user_id, messages, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, body, now, now)
    .run();
  return id;
}

/**
 * その利用者の会話をすべて消す（本人の操作）。
 *
 * **1 本ではなく全部を消す。** 画面が復元するのは最後の 1 本だが、**「消す」と押した人が
 * 期待するのは「相談の記録が残らないこと」**である。1 本だけ消して古い行が残ると、
 * `/privacy` の約束（本人が消せる）を満たしたことにならない。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @returns 消した行数
 */
export async function deleteChatConversations(env: Env, userId: string): Promise<number> {
  const result = await env.DB.prepare('delete from chat_conversations where user_id = ?')
    .bind(userId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * 最後に使ってから {@link CHAT_RETENTION_DAYS} 日を過ぎた会話を消す（cron）。
 *
 * **作者をまたいで走査する**ので、索引は `chat_conversations(updated_at)` を使う
 * （`migrations/0049_chat.sql`）。
 *
 * **1 回に消す件数を縛らない。** 1 人 1 日およそ 9 往復（5.16 の蓋）で、会話は 1 人 1 本ずつ
 * 増える程度である。**消す対象が桁で増える経路が無い**ので、`sweepStaleGenerations` と同じく
 * 1 文で済ませる。
 *
 * @param db D1
 * @param now 時刻（UNIX 秒）
 * @returns 消した行数
 */
export async function sweepExpiredChatConversations(db: D1Database, now: number): Promise<number> {
  const cutoff = now - CHAT_RETENTION_DAYS * 24 * 60 * 60;
  const result = await db
    .prepare('delete from chat_conversations where updated_at < ?')
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
