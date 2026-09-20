/**
 * 相談の口（#695 / M18-2。仕様 5.16）。**`POST /api/chat` の 1 往復。**
 *
 * ## この口が持つ順序
 *
 * **止める側を先に置く。** どの段も、通った先で初めて次の費用が出る。
 *
 * 1. **呼び出し元を決める**（`resolveApiCaller`。5.12 と同じ 1 か所。未ログイン・BAN・退会は 401）
 * 2. **呼び出しの上限**（5.13 のいいねの Worker の入口を、`chat` の鍵で使い回す。1 人 60 秒 60 回）
 * 3. **本文の検証**（形・長さ・発話の交互）
 * 4. **相談の枠**（`src/chat-quota.ts`。4.3 の月次 → 相談の当月の取り分 → 1 人 1 日のトークン）
 * 5. **作者自身の作品を引く**（`myWorkResult`。**自作かどうかの判定はあちらの `author_id`**）
 * 6. **Lambda を同期で呼ぶ**（`src/chat-client.ts`。8.2 の Guardrail は関数の中で掛かる）
 * 7. **台帳へ 1 行積む**（`kind = 'chat'`。**書くのはエッジ**）
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
 * （`migrations/0016_moderation_blocks.sql`）。**相談には作品が無い。** 列を緩めるには表の
 * 作り直しが要り、しかも**あの表は 8.4 の削除の判定が作品ごとに引くもの**である。
 * **相談の遮断は記録せず、カテゴリを作者へ返して言い直してもらう**——遮断された本文を
 * 保存しないので、`/privacy` の約束が増えることもない。
 */
import { allowApiCall } from './api-rate-limit.js';
import { resolveApiCaller } from './api-caller.js';
import { CHAT_API_PATH, CHAT_RATE_LIMIT_SCOPE } from './chat-paths.js';
import { createAskChat, ChatBusy, ChatNotConfigured, type AskChat } from './chat-client.js';
import {
  CHAT_MAX_MESSAGES,
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_TOTAL_MESSAGE_LENGTH,
  CHAT_PAYLOAD_VERSION,
  type ChatMessage,
  type ChatWorkContext,
} from './chat-payload.js';
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
  readonly workId: string | null;
  readonly includeSource: boolean;
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
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > CHAT_MAX_MESSAGES) {
    return null;
  }
  // **末尾は利用者の発話である**（交互なので、長さが奇数であることと同じ意味になる）。
  if (messages.length % 2 === 0) {
    return null;
  }
  const parsed: ChatMessage[] = [];
  let total = 0;
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
    total += [...trimmed].length;
    parsed.push({ role: expected, text: trimmed });
  }
  if (total > CHAT_MAX_TOTAL_MESSAGE_LENGTH) {
    return null;
  }

  const workId = record['workId'];
  if (workId !== undefined && workId !== null && typeof workId !== 'string') {
    return null;
  }
  const includeSource = record['includeSource'];
  if (includeSource !== undefined && typeof includeSource !== 'boolean') {
    return null;
  }
  return {
    messages: parsed,
    workId: typeof workId === 'string' ? workId : null,
    includeSource: includeSource === true,
  };
}

/**
 * 作者自身の作品を引いて、文脈にする。
 *
 * **自作かどうかの判定を書き写さない**——`myWorkResult` がそのまま `author_id` で絞る
 * （5.12）。他人の id・無い id・取り下げ・削除中は、あちらが 404 を返す。
 *
 * **引けなかったら文脈を付けずに続ける。** 相談そのものは作品が無くても成り立つので、
 * **ソースが読めない（生成中・大きすぎる）ことを理由に相談ごと断らない。**
 *
 * @param env バインディングと環境変数
 * @param userId 呼び出し元
 * @param workId 作品 id（**検証前の値**）
 * @param includeSource ソースも載せるか
 * @returns 文脈、または null
 */
export async function loadChatWorkContext(
  env: Env,
  userId: string,
  workId: string,
  includeSource: boolean,
): Promise<ChatWorkContext | null> {
  const detail = await myWorkResult(env, userId, workId, 'detail');
  if (detail.status !== 200) {
    return null;
  }
  const body = detail.body as { title?: unknown; prompt?: unknown };
  const title = typeof body.title === 'string' ? body.title : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : null;
  if (!includeSource) {
    return { title, prompt, source: null };
  }
  const source = await myWorkResult(env, userId, workId, 'source');
  if (source.status !== 200) {
    return { title, prompt, source: null };
  }
  const sourceBody = source.body as { source?: unknown };
  return {
    title,
    prompt,
    source: typeof sourceBody.source === 'string' ? sourceBody.source : null,
  };
}

/** 差し替えられる依存（テストの継ぎ目）。 */
export interface ChatHandlerDependencies {
  /** 相談を呼ぶ段。 */
  readonly ask?: AskChat;
  /** 判定と記録に使う時刻（UNIX 秒）。 */
  readonly now?: number;
}

/**
 * `POST /api/chat` — 相談の 1 往復。
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

  const work =
    parsed.workId === null
      ? null
      : await loadChatWorkContext(env, userId, parsed.workId, parsed.includeSource);

  // **この 1 往復が蓋を超えないことを、呼ぶ前に確かめる**（`src/chat-quota.ts` の
  // `estimateChatTokens`）。**文脈を引いた後に置く**——ソースを載せるかどうかで見積もりが
  // 5 倍以上変わるので、載せると決まってから数える。
  //
  // **これが無いと、残りが 1 トークンでも満額の往復が通る**（ソースを渡す往復は最大
  // 36,588 トークンで、1 日の蓋 30,000 を単独で超える）。**断り方は枠切れと同じ**である
  // ——利用者にできること（ソースを外す／翌日に回す）が同じで、`resetsAt` も同じ値である。
  const estimated = estimateChatTokens({
    messageCharacters: parsed.messages.reduce((total, message) => total + [...message.text].length, 0),
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
      messages: parsed.messages,
      ...(work === null ? {} : { work }),
    });
  } catch (error) {
    if (error instanceof ChatBusy) {
      return json(BUSY, 503, { 'retry-after': '5' });
    }
    // **会話の本文は出さない**（1.2.54）。出すのは例外の種類だけである。
    console.error(
      `[chat] 相談を呼べませんでした: ${
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
  // `/privacy` と 5.1 の約束はその単位で書かれている。相談の本文の置き場所は
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
        // **相談の返答は台帳に残さない**（残す場所は `chat_conversations`。5.16）。
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

  const spent =
    answer.usage.inputTokens +
    answer.usage.outputTokens +
    (answer.usage.cacheReadInputTokens ?? 0) +
    (answer.usage.cacheWriteInputTokens ?? 0);
  return json({
    text: answer.text,
    // **残りは判定のときの値から引く**（数え直さない）。**負にはしない**——1 回の往復が
    // 残りを超えることはありうる（4.3 の「判定を通った要求が、判定後に使う」上振れと同じ形）。
    remainingTokens: Math.max(0, quota.remainingTokens - spent),
    resetsAt: quota.resetsAt,
    costJpy: ledgerRecord.cost.totalJpy,
  });
}

/** 相談の口の経路。 */
export const chatRoutes: readonly Route[] = [
  { method: 'POST', path: CHAT_API_PATH, handler: (request, env) => handleChat(request, env) },
];
