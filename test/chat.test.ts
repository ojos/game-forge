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
  CHAT_MAX_SEND_MESSAGES,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_MAX_TOTAL_MESSAGE_LENGTH,
  CHAT_PAYLOAD_VERSION,
  type ChatMessage,
  type ChatRequestPayload,
  type ChatResponsePayload,
} from '../src/chat-payload.js';
import { ChatBusy } from '../src/chat-client.js';
import { saveChatRule } from '../src/chat-rule.js';
import {
  CHAT_DAILY_TOKENS_REASON,
  CHAT_DAILY_TOKEN_LIMIT,
  CHAT_DAILY_TOKEN_PATTERN,
  CHAT_MONTHLY_COST_LIMIT_JPY,
  CHAT_MONTHLY_LIMIT_PATTERN,
  CHAT_MONTHLY_LIMIT_REASON,
  chatQuotaStatus,
  estimateChatTokens,
} from '../src/chat-quota.js';
import { handleChat, handleDeleteChatConversation } from '../src/chat.js';
import {
  LATEST_CHAT_ORDER,
  attachChatConversationsToWork,
  latestChatConversation,
} from '../src/chat-conversation.js';
import { CHAT_KIND, GENERATION_KIND } from '../src/cost-ledger.js';
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
 * 1. **往復の枠を超えると止まる**（1 人 1 日のトークン・チャットの当月の取り分・4.3 の月次）
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
      // **窓の 7 通がどれも 2,000 文字**（14,000 文字。上限 12,000 を 1 段はみ出す。わざとである）。
      const per = CHAT_MAX_MESSAGE_LENGTH;
      const messages = Array.from({ length: CHAT_MAX_SEND_MESSAGES }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `${index}`.padEnd(per, 'あ'),
      }));
      expect(CHAT_MAX_SEND_MESSAGES * per).toBeGreaterThan(CHAT_MAX_TOTAL_MESSAGE_LENGTH);
      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages }, stub.ask);
      expect(response.status).toBe(200);
      // **最古の 1 往復だけが落ちる**（5 × 2,000 ＝ 10,000 で収まる）。
      expect(stub.calls[0]!.messages).toHaveLength(CHAT_MAX_SEND_MESSAGES - 2);
      expect(stub.calls[0]!.messages[0]!.text.startsWith('2')).toBe(true);
    });
  });

  describe('枠（5.16）', () => {
    it('1 人 1 日のトークンを使い切ると断る（生成の枠は減らさない）', async () => {
      const userId = await createUser();
      await seedLedger(userId, CHAT_KIND, { tokens: CHAT_DAILY_TOKEN_LIMIT });

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

    it('生成の行は、チャットの 1 日のトークンを減らさない', async () => {
      const userId = await createUser();
      await seedLedger(userId, GENERATION_KIND, { tokens: CHAT_DAILY_TOKEN_LIMIT * 2 });

      const status = await chatQuotaStatus(testEnv(), userId, NOW);
      expect(status).toEqual({
        kind: 'available',
        remainingTokens: CHAT_DAILY_TOKEN_LIMIT,
        resetsAt: expect.any(Number),
      });
    });

    it('チャットの行は、確定25 の日次 10 回を 1 回も減らさない', async () => {
      const userId = await createUser();
      for (let index = 0; index < 5; index += 1) {
        await seedLedger(userId, CHAT_KIND, { tokens: 100 });
      }
      await seedLedger(userId, GENERATION_KIND, { tokens: 100 });

      const daily = await dailyCallCount(testEnv(), userId, NOW);
      expect(daily.calls).toBe(1);
    });
  });

  describe('1 往復が蓋を超えないこと（PR #712 の Copilot の指摘）', () => {
    it('見積もりが残りを超える要求は、呼ぶ前に断る', async () => {
      const userId = await createUser();
      // 残りを、短い 1 往復の見積もりより少しだけ小さくする。
      const estimate = estimateChatTokens({ messageCharacters: 12, sourceBytes: 0 });
      await seedLedger(userId, CHAT_KIND, { tokens: CHAT_DAILY_TOKEN_LIMIT - estimate + 1 });

      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages: [{ role: 'user', text: 'あ'.repeat(12) }] }, stub.ask);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        error: CHAT_DAILY_TOKENS_REASON,
        estimatedTokens: estimate,
      });
      // **呼んでいない**ので、課金も台帳の行も出ない。
      expect(stub.calls).toHaveLength(0);
    });

    it('見積もりが残りに収まれば通る（境目）', async () => {
      const userId = await createUser();
      const estimate = estimateChatTokens({ messageCharacters: 12, sourceBytes: 0 });
      await seedLedger(userId, CHAT_KIND, { tokens: CHAT_DAILY_TOKEN_LIMIT - estimate });

      const stub = stubAsk({ inputTokens: 1, outputTokens: 1 });
      const response = await post(userId, { messages: [{ role: 'user', text: 'あ'.repeat(12) }] }, stub.ask);
      expect(response.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
    });

    it('ソースを渡す往復は、単独で 1 日の蓋を超えうる（だから呼ぶ前に数える）', () => {
      // **この値がこの直しの理由である。** 64 KiB のソースを載せた最大の往復は、
      // 残りが満額でも 1 日の蓋を超える。
      const worst = estimateChatTokens({
        messageCharacters: CHAT_MAX_TOTAL_MESSAGE_LENGTH,
        sourceBytes: 64 * 1024,
      });
      expect(worst).toBeGreaterThan(CHAT_DAILY_TOKEN_LIMIT);
    });

    it('見積もりはソースを載せたときだけ増える', () => {
      const without = estimateChatTokens({ messageCharacters: 100, sourceBytes: 0 });
      const with_ = estimateChatTokens({ messageCharacters: 100, sourceBytes: 3_000 });
      expect(with_ - without).toBe(1_000);
    });
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

      const body = (await response.json()) as { remainingTokens: number };
      expect(body.remainingTokens).toBe(CHAT_DAILY_TOKEN_LIMIT - 3_200);
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
      await seedLedger(userId, CHAT_KIND, { tokens: CHAT_DAILY_TOKEN_LIMIT });
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
     * **画面のスクリプトと同じ規則で切る**（表示している履歴の全部から、直近の窓だけを送る。
     * `src/chat-section.ts` の windowOf）。**履歴は画面の側で全部持ち続ける**——窓から落ちた往復も
     * 画面には残っている、という状態をそのまま作る。
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
        let start = shown.length - CHAT_MAX_SEND_MESSAGES;
        if (start < 0) {
          start = 0;
        }
        if (start % 2 === 1) {
          start += 1;
        }
        const response = await post(
          userId,
          { messages: shown.slice(start), ...(conversationId === null ? {} : { conversationId }) },
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

    it('30 往復しても、送る本文は常に 7 通以下・末尾が user・役割が交互で、11 往復目以降も送れる', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      const { statuses } = await converse(userId, 30, stub.ask);

      // **行き止まりが無い**——以前は 11 往復目で画面が送信そのものを止めていた。
      expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));
      expect(stub.calls).toHaveLength(30);
      for (const call of stub.calls) {
        expect(call.messages.length).toBeLessThanOrEqual(CHAT_MAX_SEND_MESSAGES);
        expect(call.messages[call.messages.length - 1]!.role).toBe('user');
        call.messages.forEach((message, index) => {
          expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant');
        });
      }
      // **窓は直近 3 往復 ＋ 新しい 1 通である。**
      expect(stub.calls[29]!.messages.map((message) => message.text)).toEqual([
        '質問27',
        '【指示文】質問27への返答',
        '質問28',
        '【指示文】質問28への返答',
        '質問29',
        '【指示文】質問29への返答',
        '質問30',
      ]);
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
        expect(call.messages.length).toBeLessThanOrEqual(CHAT_MAX_SEND_MESSAGES);
      }
    });

    it('開いたままの古い画面が履歴の全部を送ってきても、窓へ切って送る（断らない）', async () => {
      const userId = await createUser();
      const stub = numberedAsk();
      const messages = Array.from({ length: 19 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `発話${index}`,
      }));
      const response = await post(userId, { messages }, stub.ask);
      expect(response.status).toBe(200);
      expect(stub.calls[0]!.messages).toHaveLength(CHAT_MAX_SEND_MESSAGES);
      expect(stub.calls[0]!.messages[0]!.text).toBe('発話12');
      // **保存は受け取った全部 ＋ 返答**（続きの行が無いので、受け取った会話から作る）。
      const restored = await latestChatConversation(testEnv(), userId, NEW_CHAT_TARGET);
      expect(restored?.messages).toHaveLength(20);
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

    it('1 人 1 日のトークンが仕様書と一致する', () => {
      const found = [...spec.matchAll(CHAT_DAILY_TOKEN_PATTERN)].map((match) =>
        Number(match[1]!.replace(/,/gu, '')),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const value of found) {
        expect(value).toBe(CHAT_DAILY_TOKEN_LIMIT);
      }
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
