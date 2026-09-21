/**
 * チャットの口（#695 / M18-2。仕様 5.16）。**`POST /api/chat` の 1 往復。**
 *
 * ## この口が持つ順序
 *
 * **止める側を先に置く。** どの段も、通った先で初めて次の費用が出る。
 *
 * 1. **呼び出し元を決める**（`resolveApiCaller`。5.12 と同じ 1 か所。未ログイン・BAN・退会は 401）
 * 2. **呼び出しの上限**（5.13 のいいねの Worker の入口を、`chat` の鍵で使い回す。1 人 60 秒 60 回）
 * 3. **本文の検証**（形・長さ・発話の交互）
 * 4. **チャットの枠**（`src/chat-quota.ts`。4.3 の月次 → チャットの当月の取り分 → 1 人 1 日のトークン）
 * 5. **作者自身の作品を引く**（`myWorkResult`。**自作かどうかの判定はあちらの `author_id`**）
 * 6. **送る窓へ切る**（#742。`chatSendWindow`。直近 3 往復 ＋ 新しい 1 通。ルールの文字数を先に空ける）
 * 7. **Lambda を同期で呼ぶ**（`src/chat-client.ts`。8.2 の Guardrail は関数の中で掛かる）
 * 8. **台帳へ 1 行積む**（`kind = 'chat'`。**書くのはエッジ**）
 * 9. **保存済みの行へ 1 往復を足す**（#742。`appendChatTurn`。窓から落ちた往復も保存と復元に残す）
 *
 * ## 送る量と、送れる回数を分ける（#742）
 *
 * **以前は受け取った会話をそのまま送り、20 通を超えたら断っていた。** 画面は履歴の全部を載せるので、
 * **「1 回の要求に載せてよい量」が「その会話で送れる回数」に化け**、10 往復（ルールがあれば 9 往復）で
 * そのチャットは二度と送れなくなった。**いまは断らずに窓へ切る**——受け取る数の天井は保存の上限
 * （60 通）で、送るのは直近の 7 通だけである。
 *
 * ## 文脈はこちらで組み立てる
 *
 * **利用者の端末から届いた作品の中身を、そのまま文脈にしない。** 届くのは作品の id だけで、
 * 題名・最初の指示文・ソースは**呼び出し元の id で絞って**こちらが引く。**これが
 * 「他の作者の作品を情報源にしない」（5.16）の実装そのものである**——他人の id を送られても
 * `myWorkResult` が 404 を返す。
 *
 * ## ソースは求められたときだけ
 *
 * **`includeSource` を送っただけでは載らない**——載せるのは、作者がその会話で明示的に
 * 求めたときである（5.16 / 利用者の決定）。口から見れば「画面がその意思を伝えてきたとき」で、
 * **既定は載せない。** 64 KiB のソースは 1 往復を約 19,200 トークン（1 日分の 3 分の 2）にする。
 *
 * ## 遮断の記録は残さない
 *
 * 8.2 の `moderation_blocks` は **`game_id` が NOT NULL で `games` を参照する**
 * （`migrations/0016_moderation_blocks.sql`）。**チャットには作品が無い。** 列を緩めるには表の
 * 作り直しが要り、しかも**あの表は 8.4 の削除の判定が作品ごとに引くもの**である。
 * **チャットの遮断は記録せず、カテゴリを作者へ返して言い直してもらう**——遮断された本文を
 * 保存しないので、`/privacy` の約束が増えることもない。
 */
import { allowApiCall } from './api-rate-limit.js';
import { resolveApiCaller } from './api-caller.js';
import {
  CHAT_API_PATH,
  CHAT_CONVERSATION_DELETE_PATH,
  CHAT_RATE_LIMIT_SCOPE,
} from './chat-paths.js';
import {
  appendChatTurn,
  deleteChatConversations,
  readChatConversation,
  saveChatConversation,
} from './chat-conversation.js';
import { createAskChat, ChatBusy, ChatNotConfigured, type AskChat } from './chat-client.js';
import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_MAX_TOTAL_MESSAGE_LENGTH,
  CHAT_PAYLOAD_VERSION,
  chatCharacters,
  chatSendWindow,
  withChatRule,
  type ChatMessage,
  type ChatWorkContext,
} from './chat-payload.js';
import { readChatRule } from './chat-rule.js';
import type { ChatTarget } from './chat-target.js';
import {
  chatTargetFromBody,
  loadForkChatContext,
  loadReviseChatContext,
} from './chat-target.js';
import { readParentSource } from './fork.js';
import {
  CHAT_DAILY_TOKENS_REASON,
  CHAT_MONTHLY_LIMIT_REASON,
  chatQuotaStatus,
  estimateChatTokens,
} from './chat-quota.js';
import { CHAT_KIND, recordGeneration } from './cost-ledger.js';
import type { GenerationModelKey } from './generation-models.js';
import { findGenerationModel } from './generation-models.js';
import { RATE_LIMITED_BODY, API_RATE_LIMIT } from './api-rate-limit.js';
import { MONTHLY_LIMIT_REASON } from './quota.js';
import { json, type Route } from './routes.js';
import { myWorkResult } from './works-api.js';

/** 本文の形が違うときの分類名（5.12 / 5.13 と同じ綴りの作法）。 */
const INVALID_REQUEST = { error: 'invalid-request' } as const;

/** 未ログイン・BAN・退会（5.12 と同じ）。 */
const UNAUTHORIZED = { error: 'unauthorized' } as const;

/** 呼び出せなかった・関数が落ちた。 */
const INTERNAL = { error: 'internal' } as const;

/** 混み合っている（同時実行の枠。`src/chat-client.ts` の `ChatBusy`）。 */
const BUSY = { error: 'busy' } as const;

/** 受け取った本文（検証済み）。 */
interface ChatRequestBody {
  readonly messages: readonly ChatMessage[];
  /**
   * チャットの対象（#727 / 確定38）。**新しく作るチャットでは `kind` が `'new'`** である。
   *
   * **`workId` を置き換えたものである**——以前は「自分の作品を 1 つ選ぶ」だけだったが、
   * **リフォージ（自分の未公開の作品）とフォーク（他人の公開作品）で見せる範囲が違う**ので、
   * **何のためのチャットかを種別で持つ。**
   */
  readonly target: ChatTarget;
  readonly includeSource: boolean;
  /** 続きを書き込む会話の id（新しく始めるなら null）。 */
  readonly conversationId: string | null;
}

/**
 * 本文を検証する。
 *
 * **Lambda 側でも同じことを確かめる**（`src/chat/handler.ts` の `parseChatPayload`）。
 * 二重に見えるが、**送り側と受け側は別々に配られる**——片方だけが新しい形を知っている窓で、
 * 検査の無い側が素通しにならないようにする。
 *
 * @param value JSON を解析した値
 * @returns 検証済みの本文、または null
 */
export function parseChatRequest(value: unknown): ChatRequestBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messages = record['messages'];
  // **天井は保存の上限である**（送る窓ではない。#742）。**窓より長い会話は断らずに切る**
  // （{@link handleChat}）——**開いたままの古い画面は、履歴の全部を送ってくる。**
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > CHAT_MAX_STORED_MESSAGES) {
    return null;
  }
  // **末尾は利用者の発話である**（交互なので、長さが奇数であることと同じ意味になる）。
  if (messages.length % 2 === 0) {
    return null;
  }
  const parsed: ChatMessage[] = [];
  for (const [index, raw] of messages.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const message = raw as Record<string, unknown>;
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    const text = message['text'];
    if (message['role'] !== expected || typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (trimmed === '' || [...trimmed].length > CHAT_MAX_MESSAGE_LENGTH) {
      return null;
    }
    parsed.push({ role: expected, text: trimmed });
  }
  // **合計の文字数はここでは断らない**（#742）。窓へ切るときに最古の往復を落として収める
  // ——**ここで断ると、それがそのまま行き止まりになる**（以前の 400 がそうだった）。

  // **対象は種別と id の組で受ける**（#727）。**形が違えば断る**——黙って「新しく作る」へ
  // 倒すと、作者は「フォークのつもりで話していたのに、何も知らない相手が返してくる」ことになる。
  const target = chatTargetFromBody(record['targetKind'], record['targetId']);
  if (target === null) {
    return null;
  }
  const includeSource = record['includeSource'];
  if (includeSource !== undefined && typeof includeSource !== 'boolean') {
    return null;
  }
  const conversationId = record['conversationId'];
  if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') {
    return null;
  }
  return {
    messages: parsed,
    target,
    includeSource: includeSource === true,
    conversationId: typeof conversationId === 'string' ? conversationId : null,
  };
}

/**
 * 対象に応じて、チャットの文脈を読む（#727 / 確定38）。
 *
 * **見せてよい範囲は対象で変わる。**
 *
 * - **リフォージ**: 自分の作品（`author_id` で絞る）。題名と最初の指示文、ソースは求められたときだけ
 * - **フォーク**: 他人の公開作品。題名・説明・タグ、ソースは求められたときだけ。**最初の指示文は出さない**
 * - **新しく作る**: 文脈は無い
 *
 * **判定はここで書かない。** リフォージは `myWorkResult`、フォークは `status = 'published'` を見る
 * 既存の問い合わせを `src/chat-target.ts` が通す。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @param target チャットの対象
 * @param includeSource ソースも載せるか
 * @returns 文脈（対象が無い・読めないなら null）
 */
async function loadChatContext(
  env: Env,
  userId: string,
  target: ChatTarget,
  includeSource: boolean,
): Promise<ChatWorkContext | null> {
  if (target.kind === 'new') {
    return null;
  }
  if (target.kind === 'revise') {
    return await loadReviseChatContext(env, userId, target.id, includeSource);
  }
  // **フォーク元のソースは、フォークが読むのと同じ段を通す**（`src/fork.ts` の `readParentSource`）
  // ——**大きさの上限も、鍵の引き方も 1 か所に置く。**
  return await loadForkChatContext(env.DB, target.id, includeSource, async () => {
    const read = await readParentSource(env, target.id);
    return read.ok ? read.source : null;
  });
}

/** 差し替えられる依存（テストの継ぎ目）。 */
export interface ChatHandlerDependencies {
  /** チャットを呼ぶ段。 */
  readonly ask?: AskChat;
  /** 判定と記録に使う時刻（UNIX 秒）。 */
  readonly now?: number;
}

/**
 * `POST /api/chat` — チャットの 1 往復。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param deps 差し替えられる依存
 * @returns 応答
 */
export async function handleChat(
  request: Request,
  env: Env,
  deps: ChatHandlerDependencies = {},
): Promise<Response> {
  const caller = await resolveApiCaller(request, env);
  if (!caller.ok) {
    return json(UNAUTHORIZED, 401);
  }
  const userId = caller.userId;

  if (!(await allowApiCall(env, CHAT_RATE_LIMIT_SCOPE, userId))) {
    return json(RATE_LIMITED_BODY, 429, { 'retry-after': String(API_RATE_LIMIT.periodSeconds) });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(INVALID_REQUEST, 400);
  }
  const parsed = parseChatRequest(body);
  if (parsed === null) {
    return json(INVALID_REQUEST, 400);
  }

  const now = deps.now ?? Math.floor(Date.now() / 1000);
  let quota: Awaited<ReturnType<typeof chatQuotaStatus>>;
  try {
    quota = await chatQuotaStatus(env, userId, now);
  } catch {
    // **集計を読めなかったら断る**（`src/quota.ts` の `readForDecision` と同じ向き。
    // 「判定できなかったので通す」を選ぶと、上限が D1 の不調で静かに開く）。
    return json(INTERNAL, 500);
  }
  if (quota.kind === CHAT_DAILY_TOKENS_REASON) {
    return json({ error: quota.kind, resetsAt: quota.resetsAt }, 429);
  }
  if (quota.kind === CHAT_MONTHLY_LIMIT_REASON || quota.kind === MONTHLY_LIMIT_REASON) {
    return json({ error: quota.kind }, 429);
  }

  const work = await loadChatContext(env, userId, parsed.target, parsed.includeSource);

  // **作者ごとのルール**（#728 / 確定38）。**展開するのは Lambda である**（`withChatRule`）
  // ——8.2 の Guardrail はあちらにあり、**ここで会話へ混ぜて送ると、ルールが検査を 1 度も
  // 通らないまま Bedrock へ届く。** ここで渡すのは値だけで、置く場所は契約
  // （`src/chat-payload.ts`）が決める。
  //
  // **保存する会話にも入らない**（下の `appendChatTurn` は利用者の発話と返答だけを足す）
  // ——入ると、画面の履歴に作者が消せない往復が 2 つ増える。
  const rule = await readChatRule(env.DB, userId);

  // **送る窓へ切る**（#742。`chatSendWindow`）。**ルールの文字数を先に空ける**——ルールは
  // Lambda が同じ要求の先頭へ足す（`withChatRule`）。**数える形も同じ関数から作る**
  // （前置きと受け答えを書き写さない）。
  //
  // **発話の数では、もうあふれない。** 窓は 7 通で、ルールの 2 通を足しても 9 通である
  // （以前は上限ちょうどの会話がルールで 2 通あふれ、ここで 400 を返していた。#728）。
  //
  // **最新の 1 通だけにしても収まらないときだけ断る**——いまの上限（1 通 2,000・合計 12,000・
  // ルール 500）では起こらないが、値が動いた日に「黙って上限を超えて送る」側へ倒れないようにする。
  const ruleCharacters = chatCharacters(withChatRule(rule, []));
  const window = chatSendWindow(parsed.messages, { reservedCharacters: ruleCharacters });
  const messageCharacters = chatCharacters(window);
  if (messageCharacters + ruleCharacters > CHAT_MAX_TOTAL_MESSAGE_LENGTH) {
    return json({ error: 'invalid-request' }, 400);
  }

  // **この 1 往復が蓋を超えないことを、呼ぶ前に確かめる**（`src/chat-quota.ts` の
  // `estimateChatTokens`）。**文脈を引いた後に置く**——ソースを載せるかどうかで見積もりが
  // 5 倍以上変わるので、載せると決まってから数える。
  //
  // **これが無いと、残りが 1 トークンでも満額の往復が通る**（ソースを渡す往復は最大
  // 36,588 トークンで、1 日の蓋 30,000 を単独で超える）。**断り方は枠切れと同じ**である
  // ——利用者にできること（ソースを外す／翌日に回す）が同じで、`resetsAt` も同じ値である。
  //
  // **ルールも数える。** 1 往復ごとに文脈へ乗るので、数えないと**蓋を超える往復が通る。**
  const estimated = estimateChatTokens({
    messageCharacters: messageCharacters + ruleCharacters,
    sourceBytes: work?.source === null || work?.source === undefined ? 0 : new TextEncoder().encode(work.source).length,
  });
  if (estimated > quota.remainingTokens) {
    return json(
      { error: CHAT_DAILY_TOKENS_REASON, resetsAt: quota.resetsAt, estimatedTokens: estimated },
      429,
    );
  }

  const ask = deps.ask ?? createAskChat();
  let answer: Awaited<ReturnType<AskChat>>;
  try {
    answer = await ask(env, {
      version: CHAT_PAYLOAD_VERSION,
      messages: window,
      ...(rule === '' ? {} : { rule }),
      ...(work === null ? {} : { work }),
    });
  } catch (error) {
    if (error instanceof ChatBusy) {
      return json(BUSY, 503, { 'retry-after': '5' });
    }
    // **会話の本文は出さない**（1.2.54）。出すのは例外の種類だけである。
    console.error(
      `[chat] チャットを呼べませんでした: ${
        error instanceof ChatNotConfigured ? error.message : error instanceof Error ? error.name : 'unknown'
      }`,
    );
    return json(INTERNAL, 500);
  }

  if (!answer.ok) {
    if (answer.error === 'prompt-blocked') {
      // **8.2 の分類名をそのまま返す**（生成の口と同じ綴り。画面の文言も共有できる）。
      // **記録は残さない**（モジュール冒頭「遮断の記録は残さない」）。
      return json({ error: answer.error, categories: answer.categories ?? [] }, 422);
    }
    return json(INTERNAL, 500);
  }

  // **台帳へ 1 行積む**（4.3 の記録規約。1 回の LLM 呼び出しにつき 1 行）。
  //
  // **`prompt` には会話の本文を入れない。** 台帳の `prompt` は生成の指示文を残す列で、
  // `/privacy` と 5.1 の約束はその単位で書かれている。チャットの本文の置き場所は
  // `chat_conversations`（30 日で消える。5.16）であって、消えない台帳ではない。
  //
  // **登録簿に無い鍵でも記録する**（4.3「登録簿に無いモデルで生成された場合も、同じ理由で
  // 登録簿の最大単価を当てて記録する」）。**断って行を作らないほうが害が大きい**——課金は
  // 既に出ており、行が無ければ 1 日のトークンにも当月の取り分にも入らない。**鍵が登録簿から
  // 外れた状態は異常なので、ログには残す**（`recordGeneration` も `unknown-model` を出す）。
  if (findGenerationModel(answer.modelKey) === null) {
    console.error(`[chat] 登録簿に無い鍵で返ってきました: ${answer.modelKey}`);
  }
  const ledgerRecord = await recordGeneration(
    env,
    {
      userId,
      prompt: '',
      generated: {
        modelKey: answer.modelKey as GenerationModelKey,
        // **台帳はモデル ID を列に持たない**（引くのは鍵である。4.3 の記録規約）。
        // 登録簿から引けないときは鍵をそのまま置く——値が使われないことより、
        // 「引けなかった」が読める形のほうがよい。
        modelId: findGenerationModel(answer.modelKey)?.modelId ?? answer.modelKey,
        // **チャットの返答は台帳に残さない**（残す場所は `chat_conversations`。5.16）。
        source: '',
        // **切れた返答は成功にしない**（4.3。行は作る——課金は出ている）。
        stopReason: answer.stopReason,
        usage: {
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          cacheReadInputTokens: answer.usage.cacheReadInputTokens,
          cacheWriteInputTokens: answer.usage.cacheWriteInputTokens,
        },
      },
      promptVersion: answer.promptVersion,
      kind: CHAT_KIND,
    },
    now,
  );

  // **会話を保存する**（5.16。30 日で消える短命の保存）。**台帳の行を積んだ後に置く**
  // ——保存に失敗しても課金は既に出ており、**枠が減らないほうが害が大きい。**
  //
  // **保存の失敗で往復ごと失敗にしない。** 返答は既に手元にあり、利用者にとっては
  // 「返ってきたのに消えた」ほうが悪い。**復元できないことはログに残す。**
  //
  // **保存済みの行へ追記する**（#742。`appendChatTurn`）。**送ったのは窓だけ**なので、受け取った
  // 会話で上書きすると、窓から落ちた往復が保存から消える。**読めなかったら書かない**（下の catch）
  // ——読み取りの失敗で窓だけを書き戻すと、それまでの会話を自分で切り詰めることになる。
  // 続きの行が無い（新しい会話・他人の id・消えた id）か、追記できない形（奇数の長さ）なら、
  // 受け取った会話から保存する（以前と同じ形）。
  let conversationId: string | null = null;
  try {
    const stored =
      parsed.conversationId === null
        ? null
        : await readChatConversation(env, userId, parsed.conversationId);
    const latestUser = parsed.messages[parsed.messages.length - 1]!;
    const base =
      stored !== null && stored.messages.length % 2 === 0
        ? stored.messages
        : parsed.messages.slice(0, -1);
    conversationId = await saveChatConversation(
      env,
      userId,
      parsed.conversationId,
      parsed.target,
      appendChatTurn(base, latestUser, { role: 'assistant', text: answer.text }),
      now,
    );
  } catch (error) {
    console.warn(
      `[chat] 会話を保存できませんでした（返答は返します）: ${
        error instanceof Error ? error.name : 'unknown'
      }`,
    );
  }

  const spent =
    answer.usage.inputTokens +
    answer.usage.outputTokens +
    (answer.usage.cacheReadInputTokens ?? 0) +
    (answer.usage.cacheWriteInputTokens ?? 0);
  return json({
    text: answer.text,
    conversationId,
    // **残りは判定のときの値から引く**（数え直さない）。**負にはしない**——1 回の往復が
    // 残りを超えることはありうる（4.3 の「判定を通った要求が、判定後に使う」上振れと同じ形）。
    remainingTokens: Math.max(0, quota.remainingTokens - spent),
    resetsAt: quota.resetsAt,
    costJpy: ledgerRecord.cost.totalJpy,
  });
}

/**
 * `POST /api/chat/conversation/delete` — 保存した会話を消す（5.16「作者が自分で消せる」）。
 *
 * **その人の会話をすべて消す**（`deleteChatConversations`）。**0 件でも 200 を返す**
 * ——「消すものが無かった」と「消した」を区別できる応答にしない（5.12 と同じ線）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 応答
 */
export async function handleDeleteChatConversation(request: Request, env: Env): Promise<Response> {
  const caller = await resolveApiCaller(request, env);
  if (!caller.ok) {
    return json(UNAUTHORIZED, 401);
  }
  if (!(await allowApiCall(env, CHAT_RATE_LIMIT_SCOPE, caller.userId))) {
    return json(RATE_LIMITED_BODY, 429, { 'retry-after': String(API_RATE_LIMIT.periodSeconds) });
  }
  await deleteChatConversations(env, caller.userId);
  return json({ ok: true });
}

/** チャットの口の経路。 */
export const chatRoutes: readonly Route[] = [
  { method: 'POST', path: CHAT_API_PATH, handler: (request, env) => handleChat(request, env) },
  { method: 'POST', path: CHAT_CONVERSATION_DELETE_PATH, handler: handleDeleteChatConversation },
];
