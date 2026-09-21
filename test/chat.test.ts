import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_RATE_LIMIT, RATE_LIMITED_BODY } from '../src/api-rate-limit.js';
import { createAppRoutes } from '../src/app.js';
import {
  CHAT_API_PATH,
  CHAT_CONVERSATION_DELETE_PATH,
  CHAT_RATE_LIMIT_SCOPE,
} from '../src/chat-paths.js';
import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_MAX_SEND_MESSAGES,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_MAX_TOTAL_MESSAGE_LENGTH,
  CHAT_PAYLOAD_VERSION,
  CHAT_RULE_TURNS,
  chatCharacters,
  chatSendWindow,
  renderWorkContext,
  withChatRule,
  type ChatMessage,
  type ChatRequestPayload,
  type ChatResponsePayload,
} from '../src/chat-payload.js';
import { ChatBusy } from '../src/chat-client.js';
import { saveChatRule } from '../src/chat-rule.js';
import {
  CHAT_DAILY_COST_LIMIT_JPY,
  CHAT_DAILY_COST_PATTERN,
  CHAT_DAILY_TOKENS_REASON,
  CHAT_MONTHLY_COST_LIMIT_JPY,
  CHAT_MONTHLY_LIMIT_PATTERN,
  CHAT_MONTHLY_LIMIT_REASON,
  chatQuotaStatus,
  chatRemainingPercent,
  chatWorkContextCharacters,
  estimateChatCostJpy,
} from '../src/chat-quota.js';
import { renderChatPromptText } from '../src/chat-prompt.js';
import { DEFAULT_GENERATION_MODEL_KEY, findGenerationModel } from '../src/generation-models.js';
import { handleChat, handleDeleteChatConversation, worstNextChatCharacters } from '../src/chat.js';
import {
  LATEST_CHAT_ORDER,
  attachChatConversationsToWork,
  latestChatConversation,
} from '../src/chat-conversation.js';
import { CHAT_KIND, GENERATION_KIND, USD_JPY_RATE } from '../src/cost-ledger.js';
import { currentDeclarationsIn, dailyCallCount, MONTHLY_LIMIT_REASON } from '../src/quota.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { NEW_CHAT_TARGET } from '../src/chat-target.js';
import { applySchema } from './helpers/schema.js';

/**
 * 生成の前のチャット（#695 / M18-2 / 仕様 5.16）の土台。
 *
 * **#695 の acceptance のうち、この PR が担う 2 つを機械判定できる形へ落とす。**
 *
 * 1. **往復の枠を超えると止まる**（1 人 1 日の額・チャットの当月の取り分・4.3 の月次）
 * 2. **他人の作品の指示が文脈に入らない**
 *
 * あわせて、この PR が新しく作った線を見る。
 *
 * - **確定25 の日次 10 回を、チャットが 1 回も減らさない**（`kind` で数え分ける）
 * - 台帳へ `kind = 'chat'` の行が 1 行だけ積まれる
 * - **Guardrail で止めた回は台帳の行を作らない**
 * - 仕様書の値とコードの定数が一致する
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-chat-endpoint';

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  // **台帳は月次でサービス全体を合算する**（4.3）。前の it が積んだ行が残っていると、
  // 次の it が「チャットの当月の取り分に達している」状態から始まる。**仕込みを持ち越さない。**
  await env.DB.prepare('delete from generations').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/**
 * 利用者を 1 人作る。
 *
 * @returns 利用者の id
 */
async function createUser(): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '作者')
    .run();
  return id;
}

/**
 * 作品を 1 件入れる。
 *
 * @param authorId 作者
 * @param prompt 最初の指示文
 * @returns 作品 id
 */
async function seedGame(authorId: string, prompt: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state, prompt)
     values (?, ?, 'draft', ?, '', 1, 'ready', ?)`,
  )
    .bind(id, authorId, '題名', prompt)
    .run();
  return id;
}

/**
 * 台帳へ 1 行入れる。
 *
 * @param userId 利用者
 * @param kind 種別
 * @param overrides トークンと費用と時刻
 */
async function seedLedger(
  userId: string,
  kind: string,
  overrides: { readonly tokens?: number; readonly costJpy?: number; readonly at?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model, effort,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at, prompt_version, kind)
     values (?, null, ?, '', 'sonnet-4-6', null, ?, 0, 0, 0, ?, 1, ?, 1, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      overrides.tokens ?? 0,
      overrides.costJpy ?? 0,
      overrides.at ?? NOW,
      kind,
    )
    .run();
}

/** 判定の基準時刻（JST の同じ日・同じ月に収まる固定値）。 */
const NOW = 1_790_000_000;

/**
 * 署名済みの cookie を作る。
 *
 * @param userId 利用者
 * @returns cookie の値
 */
async function sessionCookie(userId: string): Promise<string> {
  // **セッションの期限は実時間で見られる**（`resolveSessionUser`）。枠の判定に渡す
  // {@link NOW} とは別物なので、ここで固定値を使わない。
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * チャットの口を叩く。
 *
 * @param userId 呼び出し元（null なら未ログイン）
 * @param body 本文
 * @param ask チャットを呼ぶ段の差し替え
 * @returns 応答
 */
async function post(
  userId: string | null,
  body: unknown,
  ask?: (env: Env, payload: ChatRequestPayload) => Promise<ChatResponsePayload>,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId !== null) {
    headers['cookie'] = await sessionCookie(userId);
  }
  const request = new Request(`${APP_ORIGIN}${CHAT_API_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return await handleChat(request, testEnv(), { now: NOW, ...(ask === undefined ? {} : { ask }) });
}

/** 返答を 1 つ返す段。**呼ばれた引数を控える。** */
function stubAsk(usage: { readonly inputTokens: number; readonly outputTokens: number }): {
  readonly ask: (env: Env, payload: ChatRequestPayload) => Promise<ChatResponsePayload>;
  readonly calls: ChatRequestPayload[];
} {
  const calls: ChatRequestPayload[] = [];
  return {
    calls,
    ask: async (_env, payload) => {
      calls.push(payload);
      return {
        ok: true,
        text: '【指示文】赤い玉を避けるゲーム',
        modelKey: 'sonnet-4-6',
        promptVersion: 1,
        stopReason: 'end_turn',
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      };
    },
  };
}

/** 1 往復ぶんの本文。 */
const ONE_TURN = { messages: [{ role: 'user', text: '避けるゲームを作りたい' }] };

describe('チャットの口（仕様 5.16）', () => {
  it('経路が重複せず、前方一致の綴りも壊れていない', () => {
    const routes = createAppRoutes(testEnv());
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
    expect(routes.some((route) => route.method === 'POST' && route.path === CHAT_API_PATH)).toBe(true);
  });

  it('未ログインは 401', async () => {
    const response = await post(null, ONE_TURN);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('呼び出しの上限を超えたら 429（鍵は口ごと）', async () => {
    const userId = await createUser();
    const limiter = { allow: vi.fn(async () => false) };
    const request = new Request(`${APP_ORIGIN}${CHAT_API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await sessionCookie(userId) },
      body: JSON.stringify(ONE_TURN),
    });
    const response = await handleChat(
      request,
      { ...testEnv(), API_RATE_LIMITER: limiter } as unknown as Env,
      { now: NOW },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(RATE_LIMITED_BODY);
    expect(response.headers.get('retry-after')).toBe(String(API_RATE_LIMIT.periodSeconds));
    expect(limiter.allow).toHaveBeenCalledWith(`${CHAT_RATE_LIMIT_SCOPE}:${userId}`);
  });

  describe('本文の検証', () => {
    it.each([
      ['発話が無い', { messages: [] }],
      ['末尾が assistant', { messages: [{ role: 'user', text: 'あ' }, { role: 'assistant', text: 'い' }] }],
      ['役割が交互でない', { messages: [{ role: 'user', text: 'あ' }, { role: 'user', text: 'い' }, { role: 'user', text: 'う' }] }],
      ['空白だけの発話', { messages: [{ role: 'user', text: '   ' }] }],
      [
        '1 通が長すぎる',
        { messages: [{ role: 'user', text: 'あ'.repeat(CHAT_MAX_MESSAGE_LENGTH + 1) }] },
      ],
      [
        '発話が保存の上限を超える',
        {
          messages: Array.from({ length: CHAT_MAX_STORED_MESSAGES + 1 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            text: 'あ',
          })),
        },
      ],
    ])('%s は 400', async (_label, body) => {
      const userId = await createUser();
      const response = await post(userId, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid-request' });
    });

    it('合計が長くても 400 にしない——最古の往復を落として、上限に収めてから送る（#742）', async () => {
      const userId = await createUser();
      // **7 通がどれも 2,000 文字**（14,000 文字。通数は上限以内だが、文字数の上限 12,000 を 1 段はみ出す）。
      const per = CHAT_MAX_MESSAGE_LENGTH;
      const count = 7;
      const messages = Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `${index}`.padEnd(per, 'あ'),
      }));
      expect(count).toBeLessThan(CHAT_MAX_SEND_MESSAGES);
      expect(count * per).toBeGreaterThan(CHAT_MAX_TOTAL_MESSAGE_LENGTH);
      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages }, stub.ask);
      expect(response.status).toBe(200);
      // **最古の 1 往復だけが落ちる**（5 × 2,000 ＝ 10,000 で収まる）。
      expect(stub.calls[0]!.messages).toHaveLength(count - 2);
      expect(stub.calls[0]!.messages[0]!.text.startsWith('2')).toBe(true);
    });
  });

  describe('枠（5.16）', () => {
    it('1 人 1 日の額（cost_jpy の合計）が ¥20 に達すると chat-daily-tokens で断る（生成の枠は減らさない）', async () => {
      const userId = await createUser();
      // **2 行に分けて積む**（1 日の合計で見ていることを確かめる）。
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY / 2 });
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY / 2 });

      const response = await post(userId, ONE_TURN);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: CHAT_DAILY_TOKENS_REASON });

      // **確定25 の日次枠は 1 回も減っていない。**
      const daily = await dailyCallCount(testEnv(), userId, NOW);
      expect(daily.calls).toBe(0);
    });

    it('チャットの当月の取り分に達すると断る（生成の枠は減らさない）', async () => {
      const userId = await createUser();
      const other = await createUser();
      // **全員ぶんの累計**である（別の利用者のチャットでも当たる）。
      await seedLedger(other, CHAT_KIND, { costJpy: CHAT_MONTHLY_COST_LIMIT_JPY });

      const response = await post(userId, ONE_TURN);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: CHAT_MONTHLY_LIMIT_REASON });

      const daily = await dailyCallCount(testEnv(), userId, NOW);
      expect(daily.calls).toBe(0);
    });

    it('4.3 の月次 2 万円で止まっているときは、チャットも断る', async () => {
      const userId = await createUser();
      await seedLedger(userId, GENERATION_KIND, { costJpy: 20_000 });

      const status = await chatQuotaStatus(testEnv(), userId, NOW);
      expect(status.kind).toBe(MONTHLY_LIMIT_REASON);

      const response = await post(userId, ONE_TURN);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: MONTHLY_LIMIT_REASON });
    });

    it('生成の行は、チャットの 1 日の額を減らさない', async () => {
      const userId = await createUser();
      await seedLedger(userId, GENERATION_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY * 2 });

      const status = await chatQuotaStatus(testEnv(), userId, NOW);
      expect(status).toEqual({
        kind: 'available',
        remainingJpy: CHAT_DAILY_COST_LIMIT_JPY,
        resetsAt: expect.any(Number),
      });
    });

    it('トークンの数ではなく額で数える（キャッシュ読みが多い行は、トークンが多くても枠をほとんど減らさない）', async () => {
      const userId = await createUser();
      // #751 までの数え方（4 項目の重みなし合計・1 日 30,000）なら、これだけで尽きていた。
      await seedLedger(userId, CHAT_KIND, { tokens: 30_000, costJpy: 1 });

      const status = await chatQuotaStatus(testEnv(), userId, NOW);
      expect(status).toEqual({
        kind: 'available',
        remainingJpy: CHAT_DAILY_COST_LIMIT_JPY - 1,
        resetsAt: expect.any(Number),
      });
    });

    it('前の日（JST）の額は数えない', async () => {
      const userId = await createUser();
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY, at: NOW - 86_400 });

      const status = await chatQuotaStatus(testEnv(), userId, NOW);
      expect(status.kind).toBe('available');
    });

    it('1 日の額 × 3 人 × 30 日が、チャットの当月の取り分の内側にある（5.16 の逆算）', () => {
      // **定数は素の数値で書き、関係はここで照合する**（#742。式で書くと束が変わった）。
      expect(CHAT_DAILY_COST_LIMIT_JPY).toBe(20);
      expect(CHAT_DAILY_COST_LIMIT_JPY * 3 * 30).toBe(1_800);
      expect(CHAT_DAILY_COST_LIMIT_JPY * 3 * 30).toBeLessThanOrEqual(CHAT_MONTHLY_COST_LIMIT_JPY);
    });

    it('残りの割合は切り捨てて 0〜100 に収める', () => {
      expect(chatRemainingPercent(CHAT_DAILY_COST_LIMIT_JPY)).toBe(100);
      expect(chatRemainingPercent(CHAT_DAILY_COST_LIMIT_JPY * 2)).toBe(100);
      expect(chatRemainingPercent(CHAT_DAILY_COST_LIMIT_JPY / 2)).toBe(50);
      // 多く見せない（19.99 / 20 は 99.95% → 99%）。
      expect(chatRemainingPercent(CHAT_DAILY_COST_LIMIT_JPY - 0.01)).toBe(99);
      expect(chatRemainingPercent(0)).toBe(0);
      expect(chatRemainingPercent(-3)).toBe(0);
    });

    it('チャットの行は、確定25 の日次 10 回を 1 回も減らさない', async () => {
      const userId = await createUser();
      for (let index = 0; index < 5; index += 1) {
        await seedLedger(userId, CHAT_KIND, { tokens: 100, costJpy: 0.1 });
      }
      await seedLedger(userId, GENERATION_KIND, { tokens: 100, costJpy: 0.1 });

      const daily = await dailyCallCount(testEnv(), userId, NOW);
      expect(daily.calls).toBe(1);
    });
  });

  describe('1 往復が蓋を超えないこと（PR #712 の Copilot の指摘。#751 で円へ移した）', () => {
    it('見積もりが残りを超える要求は、呼ぶ前に断る（見積もりの額は返さない）', async () => {
      const userId = await createUser();
      // 残りを、短い 1 往復の見積もりより少しだけ小さくする。
      const estimate = estimateChatCostJpy({ messageCharacters: 12, workCharacters: 0, sourceBytes: 0 });
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY - estimate + 0.01 });

      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages: [{ role: 'user', text: 'あ'.repeat(12) }] }, stub.ask);
      expect(response.status).toBe(429);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: CHAT_DAILY_TOKENS_REASON, resetsAt: expect.any(Number) });
      // **呼んでいない**ので、課金も台帳の行も出ない。
      expect(stub.calls).toHaveLength(0);
    });

    it('見積もりが残りに収まれば通る（境目）', async () => {
      const userId = await createUser();
      const estimate = estimateChatCostJpy({ messageCharacters: 12, workCharacters: 0, sourceBytes: 0 });
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY - estimate - 0.001 });

      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages: [{ role: 'user', text: 'あ'.repeat(12) }] }, stub.ask);
      expect(response.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
    });

    it('見積もりは高い側へ倒す（キャッシュが効かない入力単価の高いほう＋出力の上限）', () => {
      const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
      const prompt = [...renderChatPromptText()].length;
      const inputUsd = Math.max(model.pricing.inputUsdPerMillion, model.pricing.cacheWriteUsdPerMillion ?? 0);
      const expected =
        (((prompt + 100) * inputUsd + CHAT_MAX_OUTPUT_TOKENS * model.pricing.outputUsdPerMillion) / 1_000_000) *
        USD_JPY_RATE;
      expect(estimateChatCostJpy({ messageCharacters: 100, workCharacters: 0, sourceBytes: 0 })).toBeCloseTo(expected, 9);
      // **キャッシュ読みの単価では数えない**（それより必ず高い）。
      const cached =
        (((prompt + 100) * (model.pricing.cacheReadUsdPerMillion ?? 0) +
          CHAT_MAX_OUTPUT_TOKENS * model.pricing.outputUsdPerMillion) /
          1_000_000) *
        USD_JPY_RATE;
      expect(estimateChatCostJpy({ messageCharacters: 100, workCharacters: 0, sourceBytes: 0 })).toBeGreaterThan(cached);
      // **入力単価そのものより低くならない**（キャッシュ書き込みは入力の 1.25 倍）。
      expect(inputUsd).toBeGreaterThanOrEqual(model.pricing.inputUsdPerMillion);
    });

    it('作品の文脈（前置き・題名・最初の指示文）も見積もりに入る（PR #753 の Copilot の指摘）', async () => {
      // **以前は会話とソースだけを数え、`renderWorkContext` が最初の発話へ足す文脈を数えていなかった**
      // （#751 の前の `estimateChatTokens` からの穴）。残りを「文脈抜きの見積もり」ちょうどにすると、
      // 直す前は通り、直した後は断る。
      const userId = await createUser();
      const own = await seedGame(userId, '指'.repeat(CHAT_MAX_MESSAGE_LENGTH));
      const withoutContext = estimateChatCostJpy({ messageCharacters: 12, workCharacters: 0, sourceBytes: 0 });
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY - withoutContext - 0.001 });

      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(
        userId,
        { messages: [{ role: 'user', text: 'あ'.repeat(12) }], targetKind: 'revise', targetId: own },
        stub.ask,
      );
      expect(response.status).toBe(429);
      expect(stub.calls).toHaveLength(0);

      // 同じ残りでも、作品を選ばなければ通る（差は文脈の分だけである）。
      const other = await createUser();
      await seedLedger(other, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY - withoutContext - 0.001 });
      const plain = await post(other, { messages: [{ role: 'user', text: 'あ'.repeat(12) }] }, stub.ask);
      expect(plain.status).toBe(200);
    });

    it('文脈の文字数は Lambda が置く文章から数え、ソースの本体だけを二重に数えない', () => {
      const work = {
        title: '題名',
        prompt: null,
        description: '説'.repeat(300),
        tags: ['action', 'puzzle'],
        source: 'package main\n'.repeat(100),
      };
      const rendered = [...renderWorkContext(work)].length;
      const counted = chatWorkContextCharacters(work);
      // ソースの本体だけが抜けている（囲みの見出しと ``` の行は残る）。
      expect(rendered - counted).toBe([...work.source].length);
      expect(counted).toBeGreaterThan(300);
      expect(chatWorkContextCharacters(null)).toBe(0);
      // 見積もりは文脈の分だけ増える。
      const base = { messageCharacters: 100, sourceBytes: 0 };
      const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
      const inputUsd = Math.max(model.pricing.inputUsdPerMillion, model.pricing.cacheWriteUsdPerMillion ?? 0);
      expect(
        estimateChatCostJpy({ ...base, workCharacters: counted }) - estimateChatCostJpy({ ...base, workCharacters: 0 }),
      ).toBeCloseTo(((counted * inputUsd) / 1_000_000) * USD_JPY_RATE, 9);
    });

    it('ソースを渡す最大の往復は、単独で 1 日の蓋を超えうる（だから呼ぶ前に数える）', () => {
      // **この値がこの直しの理由である。** 64 KiB のソースを載せた最大の往復は、
      // 残りが満額でも 1 日の蓋を超える。
      const worst = estimateChatCostJpy({
        messageCharacters: CHAT_MAX_TOTAL_MESSAGE_LENGTH,
        workCharacters: 0,
        sourceBytes: 64 * 1024,
      });
      expect(worst).toBeGreaterThan(CHAT_DAILY_COST_LIMIT_JPY);
    });

    it('見積もりはソースを載せたときだけ増える', () => {
      const without = estimateChatCostJpy({ messageCharacters: 100, workCharacters: 0, sourceBytes: 0 });
      const with_ = estimateChatCostJpy({ messageCharacters: 100, workCharacters: 0, sourceBytes: 3_000 });
      const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
      const inputUsd = Math.max(model.pricing.inputUsdPerMillion, model.pricing.cacheWriteUsdPerMillion ?? 0);
      expect(with_ - without).toBeCloseTo(((1_000 * inputUsd) / 1_000_000) * USD_JPY_RATE, 9);
    });
  });

  describe('「今日の残り」は次の 1 回を送れる分である（#751。利用者の決定）', () => {
    /**
     * 次の発話を 1〜2,000 字のすべての長さで作り、エッジと同じ規則で切って見積もった額の最大。
     *
     * @param sent 前の往復で送った会話（末尾は user）
     * @param reply 返答
     * @param rule ルール
     * @returns 見積もりの最大（円）
     */
    function worstEstimateByBruteForce(sent: readonly ChatMessage[], reply: string, rule: string): number {
      const ruleMessages = rule === '' ? 0 : CHAT_RULE_TURNS;
      const ruleCharacters = chatCharacters(withChatRule(rule, []));
      let worst = 0;
      for (let length = 1; length <= CHAT_MAX_MESSAGE_LENGTH; length += 1) {
        const next = chatSendWindow(
          [...sent, { role: 'assistant', text: reply }, { role: 'user', text: 'い'.repeat(length) }],
          { reservedCharacters: ruleCharacters, reservedMessages: ruleMessages },
        );
        const characters = next.reduce((total, message) => total + [...message.text].length, 0) + ruleCharacters;
        worst = Math.max(worst, estimateChatCostJpy({ messageCharacters: characters, workCharacters: 0, sourceBytes: 0 }));
      }
      return worst;
    }

    it('次の発話の最大の長さが、いつも最大の送信になるとは限らない（だから候補を全部数える）', () => {
      // 11,000 字の会話 ＋ 返答 400 字。2,000 字の発話は最古の往復を落とさせるが、600 字なら全部載る。
      const sent: ChatMessage[] = [
        { role: 'user', text: 'あ'.repeat(1_500) },
        { role: 'assistant', text: 'あ'.repeat(2_000) },
        { role: 'user', text: 'あ'.repeat(2_000) },
        { role: 'assistant', text: 'あ'.repeat(2_000) },
        { role: 'user', text: 'あ'.repeat(2_000) },
        { role: 'assistant', text: 'あ'.repeat(1_000) },
        { role: 'user', text: 'あ'.repeat(500) },
      ];
      const reply = 'い'.repeat(400);
      const naive = chatSendWindow([...sent, { role: 'assistant', text: reply }, { role: 'user', text: 'う'.repeat(2_000) }]);
      const naiveCharacters = naive.reduce((total, message) => total + [...message.text].length, 0);
      expect(worstNextChatCharacters(sent, reply, '')).toBeGreaterThan(naiveCharacters);
      expect(worstNextChatCharacters(sent, reply, '')).toBeLessThanOrEqual(CHAT_MAX_TOTAL_MESSAGE_LENGTH);
    });

    it('表示が 0% より大きい間は、次に送る発話が 2,000 字以内のどの長さでも、見積もりで断られない', async () => {
      // **会話の長さ・ルールの有無・使った額を変えて、表示と断る条件を突き合わせる。**
      const conversations: { readonly messages: ChatMessage[]; readonly rule: string }[] = [
        { messages: [{ role: 'user', text: '短い' }], rule: '' },
        {
          messages: [
            { role: 'user', text: 'あ'.repeat(1_500) },
            { role: 'assistant', text: 'あ'.repeat(2_000) },
            { role: 'user', text: 'あ'.repeat(2_000) },
            { role: 'assistant', text: 'あ'.repeat(2_000) },
            { role: 'user', text: 'あ'.repeat(2_000) },
            { role: 'assistant', text: 'あ'.repeat(1_000) },
            { role: 'user', text: 'あ'.repeat(500) },
          ],
          rule: '',
        },
        {
          messages: [
            { role: 'user', text: 'あ'.repeat(2_000) },
            { role: 'assistant', text: 'あ'.repeat(2_000) },
            { role: 'user', text: 'あ'.repeat(1_200) },
          ],
          rule: 'る'.repeat(500),
        },
      ];
      const reply = '【指示文】赤い玉を避けるゲーム';
      let positives = 0;
      let zeros = 0;
      for (const conversation of conversations) {
        for (const spent of [0, 4, 8, 10, 12, 14, 15, 16]) {
          const userId = await createUser();
          if (conversation.rule !== '') {
            expect(await saveChatRule(env.DB, userId, conversation.rule)).toBe(true);
          }
          if (spent > 0) {
            await seedLedger(userId, CHAT_KIND, { costJpy: spent });
          }
          // **使う額が 0 の返答**なので、次の要求の残りは今回の判定のときと同じである。
          const stub = stubAsk({ inputTokens: 0, outputTokens: 0 });
          const response = await post(userId, { messages: conversation.messages }, stub.ask);
          if (response.status !== 200) {
            continue;
          }
          const body = (await response.json()) as { remainingPercent: number };
          const worst = worstEstimateByBruteForce(stub.calls[0]!.messages, reply, conversation.rule);
          const remaining = CHAT_DAILY_COST_LIMIT_JPY - spent;
          if (body.remainingPercent > 0) {
            positives += 1;
            // **どの長さでも、見積もりが残りに収まる**（＝断られない）。
            expect(worst).toBeLessThanOrEqual(remaining);
            // 実際に最大の長さで送っても通る。
            const next = await post(
              userId,
              {
                messages: [
                  ...stub.calls[0]!.messages,
                  { role: 'assistant', text: reply },
                  { role: 'user', text: 'い'.repeat(CHAT_MAX_MESSAGE_LENGTH) },
                ],
              },
              stubAsk({ inputTokens: 0, outputTokens: 0 }).ask,
            );
            expect(next.status).toBe(200);
          } else {
            zeros += 1;
          }
        }
      }
      // どちらの側も実際に通っている（片側だけを見て緑にならない）。
      expect(positives).toBeGreaterThan(0);
      expect(zeros).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('文脈（5.16「見せる情報」）', () => {
    it('他人の作品の id を送っても、指示文は文脈に入らない', async () => {
      const userId = await createUser();
      const stranger = await createUser();
      const strangerGame = await seedGame(stranger, '他人の指示文-ひみつ');

      const stub = stubAsk({ inputTokens: 100, outputTokens: 10 });
      const response = await post(
        userId,
        { ...ONE_TURN, targetKind: 'revise', targetId: strangerGame, includeSource: true },
        stub.ask,
      );
      expect(response.status).toBe(200);

      expect(stub.calls).toHaveLength(1);
      // **文脈そのものが付かない**（`myWorkResult` が 404 を返すため）。
      expect(stub.calls[0]!.work).toBeUndefined();
      expect(JSON.stringify(stub.calls[0])).not.toContain('ひみつ');
    });

    it('自作の作品なら、題名と最初の指示文が文脈に入る（ソースは求めたときだけ）', async () => {
      const userId = await createUser();
      const own = await seedGame(userId, '自分の指示文');

      const stub = stubAsk({ inputTokens: 100, outputTokens: 10 });
      const response = await post(
        userId,
        { ...ONE_TURN, targetKind: 'revise', targetId: own },
        stub.ask,
      );
      expect(response.status).toBe(200);
      // **リフォージのチャットでは、説明とタグは載らない**（最初の指示文が読めるため。#727）。
      expect(stub.calls[0]!.work).toEqual({
        title: '題名',
        prompt: '自分の指示文',
        description: null,
        tags: [],
        source: null,
      });
    });

    it('作品を選ばなければ、文脈は付かない', async () => {
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 100, outputTokens: 10 });
      await post(userId, ONE_TURN, stub.ask);
      expect(stub.calls[0]!.work).toBeUndefined();
      expect(stub.calls[0]!.version).toBe(CHAT_PAYLOAD_VERSION);
    });
  });

  describe('台帳（4.3 の記録規約）', () => {
    it('1 往復につき 1 行を `chat` として積む', async () => {
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 2_800, outputTokens: 400 });
      const response = await post(userId, ONE_TURN, stub.ask);
      expect(response.status).toBe(200);

      const rows = await env.DB.prepare(
        'select kind, input_tokens, output_tokens, cost_jpy, prompt from generations where user_id = ?',
      )
        .bind(userId)
        .all<{ kind: string; input_tokens: number; output_tokens: number; cost_jpy: number; prompt: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]!.kind).toBe(CHAT_KIND);
      expect(rows.results[0]!.input_tokens).toBe(2_800);
      expect(rows.results[0]!.output_tokens).toBe(400);
      // **会話の本文は台帳に残さない**（残す場所は `chat_conversations`。5.16）。
      expect(rows.results[0]!.prompt).toBe('');
      // 4.1 の単価（入力 $3 / 出力 $15）と 150 円/ドルから、2,800 × 3 + 400 × 15 = 14,400 → 2.16 円。
      expect(rows.results[0]!.cost_jpy).toBeCloseTo(2.16, 6);

      // **返すのは残りの割合だけ**（円もトークンも画面に出さない。#751）。**次の 1 回を送れる分**
      // ——2.16 円を使った後の残り 17.84 円から、さらに次の 1 往復の見積もりを引く。
      const body = (await response.json()) as Record<string, unknown>;
      const next = estimateChatCostJpy({
        messageCharacters: worstNextChatCharacters(ONE_TURN.messages as ChatMessage[], '【指示文】赤い玉を避けるゲーム', ''),
        workCharacters: 0,
        sourceBytes: 0,
      });
      expect(body['remainingPercent']).toBe(chatRemainingPercent(CHAT_DAILY_COST_LIMIT_JPY - 2.16 - next));
      // 朝いちばんでも 100% にはならない（次の 1 往復の分を先に引いている）。
      expect(body['remainingPercent']).toBeLessThan(89);
      expect(body).not.toHaveProperty('remainingTokens');
    });

    it('Guardrail で止めた回は、台帳の行を作らない', async () => {
      const userId = await createUser();
      const response = await post(userId, ONE_TURN, async () => ({
        ok: false,
        error: 'prompt-blocked',
        categories: ['VIOLENCE'],
      }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'prompt-blocked', categories: ['VIOLENCE'] });

      const rows = await env.DB.prepare('select count(*) as n from generations where user_id = ?')
        .bind(userId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });
  });

  describe('会話の保存（5.16）', () => {
    it('1 往復のあと、会話が保存されて id が返る', async () => {
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 10, outputTokens: 5 });
      const response = await post(userId, ONE_TURN, stub.ask);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { conversationId: string | null };
      expect(typeof body.conversationId).toBe('string');

      const stored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(stored?.id).toBe(body.conversationId);
      // **返答まで含めて保存する**（次の往復でそのまま送れる形）。
      expect(stored?.messages).toEqual([
        { role: 'user', text: '避けるゲームを作りたい' },
        { role: 'assistant', text: '【指示文】赤い玉を避けるゲーム' },
      ]);
    });

    it('続きの id を渡すと、同じ会話に積む', async () => {
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 10, outputTokens: 5 });
      const first = (await (await post(userId, ONE_TURN, stub.ask)).json()) as {
        conversationId: string;
      };
      await post(
        userId,
        {
          messages: [
            { role: 'user', text: '避けるゲームを作りたい' },
            { role: 'assistant', text: '【指示文】赤い玉を避けるゲーム' },
            { role: 'user', text: 'もっと短く' },
          ],
          conversationId: first.conversationId,
        },
        stub.ask,
      );

      const rows = await env.DB.prepare('select count(*) as n from chat_conversations where user_id = ?')
        .bind(userId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
      const stored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(stored?.messages).toHaveLength(4);
    });

    it('付け替えの後に古い対象で保存しても、「新しく作る」行は増えない（#740）', async () => {
      // **付け替えで行の対象が動いた後、古い画面が `('new', null)` のまま同じ id を送る。**
      // 上書きの条件に対象が入っていると、**当たらずに `insert` へ落ちて `'new'` の行が
      // 作り直され**、次に `/generate` を開いたときにそれが復元される。
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 10, outputTokens: 5 });
      const first = (await (await post(userId, ONE_TURN, stub.ask)).json()) as {
        conversationId: string;
      };
      await attachChatConversationsToWork(testEnv(), userId, 'attached-game-1');

      await post(
        userId,
        {
          messages: [
            { role: 'user', text: '避けるゲームを作りたい' },
            { role: 'assistant', text: '【指示文】赤い玉を避けるゲーム' },
            { role: 'user', text: 'もっと短く' },
          ],
          conversationId: first.conversationId,
        },
        stub.ask,
      );

      const rows = await env.DB.prepare(
        'select count(*) as n from chat_conversations where user_id = ?',
      )
        .bind(userId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
      // **次に `/generate` を開くと空のままである。**
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).toBeNull();
      // **続きは、その作品のチャットとして積まれる。**
      const stored = await latestChatConversation(testEnv(), userId, {
        kind: 'revise',
        id: 'attached-game-1',
      });
      expect(stored?.id).toBe(first.conversationId);
      expect(stored?.messages).toHaveLength(4);
    });

    it('移行の「いちばん新しい 1 本」の決め方が、実行時の並びと同じ向きである（#740）', () => {
      // **規則が 2 か所にある**（実行時の並びと、1 度だけ走る移行の SQL）。**向きがずれると、
      // 移行が「作者の見ている行」を消して「見ていない行」を残す**（`.ai-playbook/
      // shared-ai-rules.md` 12 章。正本は `LATEST_CHAT_ORDER` で、移行はその適用結果である）。
      const migration = env.TEST_CHAT_ONE_PER_WORK_MIGRATION;
      expect(LATEST_CHAT_ORDER).toMatch(/\bupdated_at\s+desc\b/u);
      expect(LATEST_CHAT_ORDER).toMatch(/\bid\s+desc\b/u);
      // 移行が残すのは `(updated_at, id)` が大きい行である（`desc` の先頭と同じ）。
      expect(migration).toMatch(/newer\.updated_at\s*>\s*chat_conversations\.updated_at/u);
      expect(migration).toMatch(/newer\.id\s*>\s*chat_conversations\.id/u);
      expect(migration).not.toMatch(/newer\.updated_at\s*</u);
      expect(migration).not.toMatch(/newer\.id\s*</u);
    });

    it('断られた往復は保存しない（枠切れ）', async () => {
      const userId = await createUser();
      await seedLedger(userId, CHAT_KIND, { costJpy: CHAT_DAILY_COST_LIMIT_JPY });
      await post(userId, ONE_TURN);
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).toBeNull();
    });

    it('本人が消せる（未ログインは 401）', async () => {
      const userId = await createUser();
      const stub = stubAsk({ inputTokens: 10, outputTokens: 5 });
      await post(userId, ONE_TURN, stub.ask);
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).not.toBeNull();

      const anonymous = await handleDeleteChatConversation(
        new Request(`${APP_ORIGIN}${CHAT_CONVERSATION_DELETE_PATH}`, { method: 'POST' }),
        testEnv(),
      );
      expect(anonymous.status).toBe(401);
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).not.toBeNull();

      const deleted = await handleDeleteChatConversation(
        new Request(`${APP_ORIGIN}${CHAT_CONVERSATION_DELETE_PATH}`, {
          method: 'POST',
          headers: { cookie: await sessionCookie(userId) },
        }),
        testEnv(),
      );
      expect(deleted.status).toBe(200);
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).toBeNull();
    });
  });

  describe('行き止まりが無いこと（#742。本番で利用者が 10 往復で踏んだ）', () => {
    /**
     * 画面と同じ手順で、1 往復ずつ送る。
     *
     * **画面のスクリプトと同じ規則で切る**（表示している履歴の全部から、上限を超えたときだけ最古の往復を
     * 落として送る。`src/chat-section.ts` の windowOf は `chatSendWindow` と同じ結果を返す——`test/chat-ui.test.ts`
     * が突き合わせる）。**履歴は画面の側で全部持ち続ける**——送らなかった往復も画面には残っている、という
     * 状態をそのまま作る。
     *
     * @param userId 利用者
     * @param turns 往復の数
     * @param ask チャットを呼ぶ段
     * @returns 各往復の状態と、最後の会話の id
     */
    async function converse(
      userId: string,
      turns: number,
      ask: (env: Env, payload: ChatRequestPayload) => Promise<ChatResponsePayload>,
    ): Promise<{ statuses: number[]; conversationId: string | null; shown: ChatMessage[] }> {
      const shown: ChatMessage[] = [];
      const statuses: number[] = [];
      let conversationId: string | null = null;
      for (let turn = 1; turn <= turns; turn += 1) {
        shown.push({ role: 'user', text: `質問${turn}` });
        const response = await post(
          userId,
          { messages: chatSendWindow(shown), ...(conversationId === null ? {} : { conversationId }) },
          ask,
        );
        statuses.push(response.status);
        const body = (await response.json()) as { text?: string; conversationId?: string | null };
        if (response.status !== 200) {
          shown.pop();
          continue;
        }
        shown.push({ role: 'assistant', text: body.text ?? '' });
        conversationId = body.conversationId ?? conversationId;
      }
      return { statuses, conversationId, shown };
    }

    /** 返答に往復の番号を入れる段（どの往復の返答が保存されたかを読めるようにする）。 */
    function numberedAsk(): {
      readonly ask: (env: Env, payload: ChatRequestPayload) => Promise<ChatResponsePayload>;
      readonly calls: ChatRequestPayload[];
    } {
      const calls: ChatRequestPayload[] = [];
      return {
        calls,
        ask: async (_env, payload) => {
          calls.push(payload);
          const latest = payload.messages[payload.messages.length - 1]!.text;
          return {
            ok: true,
            text: `【指示文】${latest}への返答`,
            modelKey: 'sonnet-4-6',
            promptVersion: 3,
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
          };
        },
      };
    }

    it('30 往復しても、送る本文は常に上限（実効 19 通）以下・末尾が user・役割が交互で、11 往復目以降も送れる', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      const { statuses } = await converse(userId, 30, stub.ask);

      // **行き止まりが無い**——以前は 11 往復目で画面が送信そのものを止めていた。
      expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));
      expect(stub.calls).toHaveLength(30);
      for (const call of stub.calls) {
        // **#742 ではここが「7 通以下」だった。** #749 で上限を超えたときだけ落とすへ戻したので、上限以下を見る。
        expect(call.messages.length).toBeLessThanOrEqual(CHAT_MAX_SEND_MESSAGES - 1);
        expect(call.messages[call.messages.length - 1]!.role).toBe('user');
        call.messages.forEach((message, index) => {
          expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant');
        });
      }
      // **上限を超えた後は、最古の往復から落として 19 通を送る**（30 往復目は 質問21 から）。
      const last = stub.calls[29]!.messages.map((message) => message.text);
      expect(last).toHaveLength(CHAT_MAX_SEND_MESSAGES - 1);
      expect(last[0]).toBe('質問21');
      expect(last[last.length - 1]).toBe('質問30');
    });

    it('上限以内の会話は、1 通も落とさずに送る（#749。#742 の窓では 4 往復目から落ち、決まったことを聞き直した）', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      await converse(userId, 11, stub.ask);
      // **10 往復目（19 通）までは会話の全部が届く。** 最初に決めたこと（質問1）も毎回見えている。
      for (let turn = 1; turn <= 10; turn += 1) {
        const texts = stub.calls[turn - 1]!.messages.map((message) => message.text);
        expect(texts).toHaveLength(turn * 2 - 1);
        expect(texts[0]).toBe('質問1');
      }
      // **11 往復目（21 通）で初めて、最古の 1 往復だけが落ちる。**
      const eleventh = stub.calls[10]!.messages.map((message) => message.text);
      expect(eleventh).toHaveLength(CHAT_MAX_SEND_MESSAGES - 1);
      expect(eleventh[0]).toBe('質問2');
    });

    it('窓から落ちた往復も、保存と復元に残る（保存の上限 60 通まで。超えたら最古の往復から落とす）', async () => {
      const userId = await createUser();
      const stub = numberedAsk();

      // **11 往復（22 通）——以前の上限 20 通を超える。** 以前は保存の読み取りも 20 通で
      // 断っていたので、ここで復元が null になり、会話が丸ごと消えたように見えた。
      const first = await converse(userId, 11, stub.ask);
      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(restored?.id).toBe(first.conversationId);
      expect(restored?.messages).toHaveLength(22);
      expect(restored?.messages).toEqual(first.shown);
      expect(restored?.messages[0]).toEqual({ role: 'user', text: '質問1' });
    });

    it('保存は 30 往復で頭打ちになり、最古の往復から落ちる（断らない）', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      const { statuses } = await converse(userId, 31, stub.ask);
      expect(statuses.every((status) => status === 200)).toBe(true);

      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(restored?.messages).toHaveLength(CHAT_MAX_STORED_MESSAGES);
      // **1 往復目が落ち、2 往復目から始まる**（先頭は user のまま）。
      expect(restored?.messages[0]).toEqual({ role: 'user', text: '質問2' });
      expect(restored?.messages[CHAT_MAX_STORED_MESSAGES - 1]).toEqual({
        role: 'assistant',
        text: '【指示文】質問31への返答',
      });
    });

    it('ルールを設定していても、10 往復目以降も送れる（以前は 9 往復で 400）', async () => {
      const userId = await createUser();
      expect(await saveChatRule(env.DB, userId, '短く答えてください')).toBe(true);
      const stub = numberedAsk();
      const { statuses } = await converse(userId, 12, stub.ask);
      expect(statuses).toEqual(Array.from({ length: 12 }, () => 200));
      for (const call of stub.calls) {
        expect(call.rule).toBe('短く答えてください');
        // **ルールの 2 通を空けて切る**（ルールを足しても上限 20 通に収まる。#728）。
        expect(call.messages.length).toBeLessThanOrEqual(CHAT_MAX_SEND_MESSAGES - 1 - CHAT_RULE_TURNS);
      }
    });

    it('上限より長い会話が届いても、最古の往復を落として送る（断らない）', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      const messages = Array.from({ length: 25 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `発話${index}`,
      }));
      const response = await post(userId, { messages }, stub.ask);
      expect(response.status).toBe(200);
      expect(stub.calls[0]!.messages).toHaveLength(CHAT_MAX_SEND_MESSAGES - 1);
      expect(stub.calls[0]!.messages[0]!.text).toBe('発話6');
      // **保存は受け取った全部 ＋ 返答**（続きの行が無いので、受け取った会話から作る）。
      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(restored?.messages).toHaveLength(26);
    });

    it('同じ会話へ 2 つの保存が重なっても、両方の往復が残る（PR #746 の Copilot の指摘）', async () => {
      // **別タブ・別端末から同じ会話へ同時に送る。** 「読んでから丸ごと書き戻す」形だと、両方が
      // 同じ N 通を読み、**後から書いた側が先の 1 往復を消す。**
      const userId = await createUser();
      const first = numberedAsk();
      const opened = await converse(userId, 2, first.ask);
      expect(opened.conversationId).not.toBeNull();

      // **2 つの返答を同時に返す**（読み取りと書き込みを重ねるため）。
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waiting = 0;
      const ask = async (_env: Env, payload: ChatRequestPayload): Promise<ChatResponsePayload> => {
        waiting += 1;
        if (waiting === 2) {
          release();
        }
        await gate;
        const latest = payload.messages[payload.messages.length - 1]!.text;
        return {
          ok: true,
          text: `【指示文】${latest}への返答`,
          modelKey: 'sonnet-4-6',
          promptVersion: 3,
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
        };
      };
      const [tabA, tabB] = await Promise.all(
        ['タブA', 'タブB'].map((text) =>
          post(
            userId,
            { messages: [...opened.shown, { role: 'user', text }], conversationId: opened.conversationId },
            ask,
          ),
        ),
      );
      expect([tabA!.status, tabB!.status]).toEqual([200, 200]);

      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      // **壊れていない**（交互が崩れると `parseStoredMessages` が null にし、会話が消えたように見える）。
      expect(restored).not.toBeNull();
      expect(restored!.messages).toHaveLength(8);
      restored!.messages.forEach((message, index) => {
        expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant');
      });
      const texts = restored!.messages.map((message) => message.text);
      expect(texts.slice(0, 4)).toEqual(opened.shown.map((message) => message.text));
      expect(texts).toContain('タブA');
      expect(texts).toContain('タブB');
      expect(texts).toContain('【指示文】タブAへの返答');
      expect(texts).toContain('【指示文】タブBへの返答');
    });

    it('続きの行が壊れていたら、受け取った会話から保存し直す（交互は崩れない）', async () => {
      const userId = await createUser();
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'insert into chat_conversations (id, user_id, messages, created_at, updated_at) values (?, ?, ?, 1, 1)',
      )
        .bind(id, userId, '[{"role":"user","text":"奇数"}]')
        .run();
      const stub = numberedAsk();
      const response = await post(
        userId,
        {
          messages: [
            { role: 'user', text: '質問1' },
            { role: 'assistant', text: '返答1' },
            { role: 'user', text: '質問2' },
          ],
          conversationId: id,
        },
        stub.ask,
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { conversationId: string }).conversationId).toBe(id);
      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(restored?.messages.map((message) => message.text)).toEqual([
        '質問1',
        '返答1',
        '質問2',
        '【指示文】質問2への返答',
      ]);
    });

    it('混雑（ChatBusy）では投げ直さない——1 回だけ呼んで 503 を返し、保存もしない', async () => {
      const userId = await createUser();
      let calls = 0;
      const response = await post(userId, ONE_TURN, async () => {
        calls += 1;
        throw new ChatBusy();
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'busy' });
      expect(calls).toBe(1);
      expect(await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET)).toBeNull();
    });
  });

  describe('仕様書との照合（shared-ai-rules 12 章）', () => {
    const spec = currentDeclarationsIn(env.TEST_PRODUCT_SPEC);

    it('1 人 1 日の額が仕様書（5.16）と一致する', () => {
      // **5.16 の節の中だけを見る**（`CHAT_DAILY_COST_PATTERN` の注記。4.3 に別の話の「1 人 1 日 ¥…」がある）。
      const from = spec.indexOf('\n### 5.16 ');
      const to = spec.indexOf('\n## 6. ');
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const section = spec.slice(from, to);
      const found = [...section.matchAll(CHAT_DAILY_COST_PATTERN)].map((match) =>
        Number(match[1]!.replace(/,/gu, '')),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const value of found) {
        expect(value).toBe(CHAT_DAILY_COST_LIMIT_JPY);
      }
    });

    it('1 日 30,000 トークンの枠が、現行の決定として残っていない（#751。取り消し線の経緯は除く）', () => {
      // **取り消し線（`~~…~~`）の中・1 章・版の履歴は経緯である**（`currentDeclarationsIn` が落とす）。
      // 残りの本文に、1 日の枠をトークンで宣言する文が 1 つも無いこと。
      const live = spec;
      expect(live).not.toMatch(/1 ?(?:人 ?)?1 ?日 ?\*{0,2}30,?000 ?\*{0,2}トークン/u);
      expect(live).not.toMatch(/30,000 トークン/u);
    });

    it('チャットの当月の取り分が仕様書と一致する', () => {
      const found = [...spec.matchAll(CHAT_MONTHLY_LIMIT_PATTERN)].map((match) =>
        Number(match[1]!.replace(/,/gu, '')),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const value of found) {
        expect(value).toBe(CHAT_MONTHLY_COST_LIMIT_JPY);
      }
    });
  });
});
