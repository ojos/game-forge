/**
 * チャットの会話の保存（#695 / M18-2。仕様 5.16「会話の保存——30 日で消える」）。
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
 * 往復ごとに行を作ると、1 回のチャットで D1 の書き込みが往復の数だけ増える（索引込み。3.6）。
 * **会話は 1 度に全部を読み、全部を書き直す**ので、行を分けても読み書きの単位は変わらない。
 * **書き込みは 1 往復につき表の 1 行と索引の 1 行**で頭打ちになる。
 *
 * ## 保存済みの行へ追記する（#742）
 *
 * **画面が送ってくるのは直近の窓だけである**（`src/chat-payload.ts` の `CHAT_MAX_SEND_MESSAGES`）。
 * 以前のように「受け取った会話 ＋ 返答」で上書きすると、**窓から落ちた往復が保存から消え、次に開いたとき
 * 復元されない。** そこで口（`src/chat.ts`）は**保存済みの行を読み（{@link readChatConversation}）、
 * 新しい 1 往復を足して書き戻す**（{@link appendChatTurn}）。**読み取りが 1 往復に 1 回増える**が、
 * 縛っているのは 1 日のトークンの蓋（1 人およそ 9〜17 往復）で、閲覧ごとの流入ではない（3.6）。
 *
 * **保存の上限（{@link CHAT_MAX_STORED_MESSAGES}）は送る上限とは別の値である。** 超えたら最古の往復から
 * 落とす——**断らない**（断ると、送れるようになった後で保存が行き止まりになる）。
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
import type { ChatTarget } from './chat-target.js';
import { CHAT_MAX_STORED_MESSAGES } from './chat-payload.js';

/**
 * 会話を残す日数（仕様 5.16。利用者の決定）。
 *
 * **「最後に使ってから」である**（`updated_at`）。チャットを続けている会話は消えない。
 *
 * 仕様書側の記載との一致は `test/chat-ui.test.ts` が {@link CHAT_RETENTION_PATTERN} で
 * 機械照合する（`/privacy` の文言もこの定数から作る——**書いた日数と実際に消える日数が
 * 食い違わない**ようにするため。`src/avatar.ts` が保存日数を 1 か所に置いているのと同じ形）。
 */
export const CHAT_RETENTION_DAYS = 30;

/**
 * 仕様書と `/privacy` が保存期間を宣言している文の形（テストが照合に使う）。
 *
 * **語の間の空白と改行を許す。** 仕様書は本文を折り返して書くので、**「最後に」と「使ってから」が
 * 行をまたぐ**ことがある——実際に 5.16 がそうなっており、**折り返しを許さない形では宣言を拾えず、
 * 版の履歴にあった別の文（MCP の接続の 30 日）を拾って通っていた**（#718 で気づいた）。
 * **同じ値だったので誰も気づかなかった。**
 */
export const CHAT_RETENTION_PATTERN = /最後に\s*使ってから\s*\*{0,2}([0-9]+)\s*日/gu;

/**
 * 「いちばん新しい会話」の並び（**順序の正本**。#740）。
 *
 * **同点を id で解く。** `updated_at` は秒なので**同じ値は起こる**——そこで並びを
 * `updated_at` だけにすると、**どちらが復元されるかは SQLite の気分で決まる**（同値の順序は
 * 未定義である）。復元する行が揺れると、**作者が書いた会話が消えたように見える。**
 *
 * **`migrations/0052_chat_one_per_work.sql` は、この規則で「残す 1 本」を選んだ。**
 * あの移行は**1 度しか走らない実行体**で、適用した時点の規則をそのまま固めたものである
 * ——だから規則の正本はこちら（実行時）に置き、**移行の側は正本を名指しする。**
 * **向きが揃っていることは `test/chat.test.ts` が移行の本文と機械照合する**
 * （`.ai-playbook/shared-ai-rules.md` 12 章。ずれると、**移行が「作者の見ている行」を
 * 消して「見ていない行」を残す**）。
 *
 * **`id desc`**＝**id の大きいほうを新しいとみなす**（移行の `newer.id > ...` と同じ向き）。
 */
export const LATEST_CHAT_ORDER = 'updated_at desc, id desc';

/** 保存されている会話。 */
export interface StoredChatConversation {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
  readonly updatedAt: number;
}

/**
 * 保存された JSON を読む。**壊れていたら null にする。**
 *
 * **例外にしない。** 読めない行は「無かった」として扱い、画面は空のチャットから始まる——
 * 会話が壊れていることを理由に、チャットそのものを使えなくしない。
 *
 * **数の天井は保存の上限（{@link CHAT_MAX_STORED_MESSAGES}）である**（#742）。**送る上限を当てては
 * いけない**——ここは「壊れていたら無かったことにする」枝なので、送る上限（以前の 20 通）を当てると、
 * **それを超えた会話は復元が null になり、会話が丸ごと消えたように見える。**
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
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_MAX_STORED_MESSAGES) {
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
 * その利用者の、**この対象の**いちばん新しい会話を読む（#727 / 確定38）。
 *
 * **対象ごとに分ける。** 分けないと、**フォークのチャットの続きに、前に新規で話した内容が
 * ぶら下がる**——AI はそれを同じ話の続きとして読む。
 *
 * 索引は `chat_conversations(user_id, target_kind, target_id, updated_at desc)`
 * （`migrations/0051_chat_target.sql`）。**`target_id` は NULL と値を分けて比べる**
 * ——SQL の `=` は NULL に当たらないので、新しく作るチャットは `is null` で引く。
 *
 * **並びは {@link LATEST_CHAT_ORDER} に固定する**（#740 PR の Copilot の指摘）。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @param target チャットの対象
 * @returns 会話、または null（1 本も無い・壊れている）
 */
export async function latestChatConversation(
  env: Env,
  userId: string,
  target: ChatTarget,
): Promise<StoredChatConversation | null> {
  const row = await env.DB.prepare(
    `select id, messages, updated_at
       from chat_conversations
      where user_id = ? and target_kind = ?
        and target_id is ?
      order by ${LATEST_CHAT_ORDER}
      limit 1`,
  )
    .bind(userId, target.kind, target.id)
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
 * 続きを書き込む会話を、id で読む（#742。**保存済みの行へ追記する**ため）。
 *
 * **`(id, user_id)` で当てる**——上書き（{@link saveChatConversation}）と同じ条件である。**対象は条件に
 * 入れない**（付け替えの後も、同じ id の行は同じ会話である。#740）。他人の id・消えた id・無い id は
 * null になり、口は「受け取った会話」から保存し直す（上書きが 0 行なら新しく作る、と同じ向き）。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @param conversationId 会話の id
 * @returns 会話、または null（無い・自分のものでない・壊れている）
 */
export async function readChatConversation(
  env: Env,
  userId: string,
  conversationId: string,
): Promise<StoredChatConversation | null> {
  const row = await env.DB.prepare(
    'select id, messages, updated_at from chat_conversations where id = ? and user_id = ?',
  )
    .bind(conversationId, userId)
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
 * 保存済みの会話へ、新しい 1 往復を足す（#742）。**保存の上限を超えたら、最古の往復から落とす。**
 *
 * **往復（2 通）単位で落とす**ので、先頭が `user` で役割が交互、という不変条件
 * （{@link parseStoredMessages} が読むときに確かめる）は崩れない。
 *
 * **前提は「保存済みの会話が `assistant` で終わっている（偶数の長さ）」こと**である。保存する形は
 * いつも「受け取った会話（末尾が `user`）＋返答」なので偶数になる。**奇数なら追記できない**ので、
 * 呼ぶ側が受け取った会話から保存し直す。
 *
 * @param stored 保存済みの会話（偶数の長さ。無ければ空）
 * @param user 新しい利用者の発話
 * @param assistant その返答
 * @param limit 保存する発話の上限（既定 {@link CHAT_MAX_STORED_MESSAGES}）
 * @returns 保存する発話の列
 */
export function appendChatTurn(
  stored: readonly ChatMessage[],
  user: ChatMessage,
  assistant: ChatMessage,
  limit: number = CHAT_MAX_STORED_MESSAGES,
): readonly ChatMessage[] {
  const next = [...stored, user, assistant];
  let start = 0;
  while (next.length - start > limit && next.length - start > 2) {
    start += 2;
  }
  return start === 0 ? next : next.slice(start);
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
 * ## 上書きの条件から対象を外した（#740 PR の Copilot の指摘）
 *
 * **#727 は `target_kind` / `target_id` も条件に入れていたが、外した。** 付け替え（#740。
 * {@link attachChatConversationsToWork}）で行の対象が `('revise', 作品 id)` へ動いた後、
 * **古い画面が `('new', null)` のまま同じ id を送ると、条件に当たらず `insert` へ落ちて
 * `'new'` の行が作り直される**——それが次の `/generate` で復元され、**「必ず空」が崩れる。**
 *
 * **`id` は主キーなので、同一性の判定に対象は要らない。** #727 が守りたかったのは
 * **「他人の会話を書き換えられないこと」**で、それは `user_id` が担保している（この関数が
 * 触れるのは**自分の会話だけ**である）。**対象は上書きしない**ので、**行は自分が属する対象に
 * 留まったまま、続きの発話だけが載る**——付け替えの後は、そのまま作品のチャットの続きになる。
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @param conversationId 上書きする会話の id（新しく始めるなら null）
 * @param target チャットの対象（**新しく作るときにだけ使う。上書きの条件には入れない**）
 * @param messages 保存する発話の列
 * @param now 時刻（UNIX 秒）
 * @returns 保存した会話の id
 */
export async function saveChatConversation(
  env: Env,
  userId: string,
  conversationId: string | null,
  target: ChatTarget,
  messages: readonly ChatMessage[],
  now: number,
): Promise<string> {
  const body = JSON.stringify(messages);
  if (conversationId !== null) {
    // **当てるのは `(id, user_id)` だけである**（#740 PR の Copilot の指摘。上の注記）。
    // **対象は条件にも代入にも入れない**——入れると、付け替えの後に古い対象を送ってきた
    // 画面が `'new'` の行を作り直す。
    const updated = await env.DB.prepare(
      `update chat_conversations set messages = ?, updated_at = ?
        where id = ? and user_id = ?`,
    )
      .bind(body, now, conversationId, userId)
      .run();
    if ((updated.meta.changes ?? 0) > 0) {
      return conversationId;
    }
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into chat_conversations (id, user_id, messages, target_kind, target_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, body, target.kind, target.id, now, now)
    .run();
  return id;
}

/**
 * その利用者の会話をすべて消す（本人の操作）。
 *
 * **1 本ではなく全部を消す。** 画面が復元するのは最後の 1 本だが、**「消す」と押した人が
 * 期待するのは「チャットの記録が残らないこと」**である。1 本だけ消して古い行が残ると、
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

/**
 * 受け付けた生成へ、その人の「新しく作る」チャットを付け替える（#740 / 仕様 5.16「会話の粒度——1 作品 1 本」）。
 *
 * **チャットは 1 作品 1 本である。** 新しく作るチャットには、まだ紐づく作品が無い——
 * **作品は生成してはじめてできる**ので、**閉じる契機は「生成が受け付けられた時点」以外に
 * 置き場所が無い**（利用者の決定）。以後その作品のチャットは、リフォージのチャットとして続く。
 *
 * ## その人の `'new'` の会話を全部動かす
 *
 * **1 本だけを選ばない。** 復元されるのはいちばん新しい 1 本だが、**古い行が残っていると、
 * 次に `/generate` を開いたときにそれが復元される**——「必ず空になる」が崩れる。
 * **`migrations/0052` が、この変更より前からある古い行を 1 本へ畳んである**ので、
 * 実際に動くのは作者が見ていた 1 本である。**畳んだ後に増える経路（同じ人が 2 枚のタブで
 * 別々に始める）でも、この文なら取り残しが出ない。**
 *
 * ## 断られた生成では呼ばない
 *
 * 枠切れ・進行中・入力の検査で断られた要求は**作品を作らない**ので、紐づけ先が無い
 * （`src/generate.ts` の `startGeneration` は、受け付けた後にだけこれを呼ぶ）。
 *
 * ## `updated_at` は動かさない
 *
 * 30 日の期限は**「最後に使ってから」**である（`/privacy` の約束）。付け替えは作者の発話では
 * ないので、ここで触ると**書いていないのに保存が延びる。**
 *
 * @param env バインディングと環境変数
 * @param userId 生成した利用者
 * @param gameId できた作品の id
 * @returns 付け替えた行数
 */
export async function attachChatConversationsToWork(
  env: Env,
  userId: string,
  gameId: string,
): Promise<number> {
  const result = await env.DB.prepare(
    `update chat_conversations
        set target_kind = 'revise', target_id = ?
      where user_id = ? and target_kind = 'new'`,
  )
    .bind(gameId, userId)
    .run();
  return result.meta.changes ?? 0;
}
