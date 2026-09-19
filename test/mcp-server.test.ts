import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGenerateRoutes } from '../src/generate.js';
import { claimGenerationJob, completeGame, createPendingGame, hashJobToken } from '../src/games.js';
import { MCP_MAX_BODY_BYTES, MCP_TOOL_NAMES, MCP_TOOL_SCOPES, requiredScopeOf } from '../src/mcp-server.js';
import { OAUTH_SCOPE_LABELS, SCOPE_WORKS_GENERATE, SCOPE_WORKS_READ } from '../src/oauth-paths.js';
import { workPagePath } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER } from '../src/quota.js';
import { appendRevision } from '../src/revisions.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { workEditPath } from '../src/work-edit-paths.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { APP_ORIGIN, OAUTH_FLOW_SECRET, callWorker, connectMcp, seedOAuthUser } from './helpers/oauth-flow.js';
import { applySchema } from './helpers/schema.js';

/**
 * MCP サーバー本体（#696 PR② / 仕様 5.15）。
 *
 * **要求はすべて本番と同じ入口（`src/index.ts` の既定の輸出）から通す**——DCR → 同意 → token → `/mcp`。
 * 生成・推敲の開始も既定の pipeline（`defaultPipeline`）のまま通し、**オーケストレータ Lambda への非同期呼び出しだけを
 * 大域の `fetch` の差し替えで受け止める**（{@link stubLambda}。Lambda は呼ばない）。受け止めた本文で、既存の経路
 * （枠の判定 → 行の作成 → 起動）を通ったことを確かめる。
 */

const SOURCE = 'package main\n\nfunc main() {}\n';

/** 生成の起動に要る値（偽物）。`src/orchestrator/start-job.ts` が署名に使うだけで、外へは出ない。 */
const LAMBDA_ENV = {
  BUILD_AWS_REGION: 'ap-northeast-1',
  BUILD_AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  BUILD_AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ORCHESTRATOR_FUNCTION_NAME: 'game-forge-orchestrator-test',
} as const;

beforeAll(async () => {
  await applySchema();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * オーケストレータ Lambda への非同期呼び出しを受け止める（大域の `fetch` を差し替える。それ以外の宛先は通さない）。
 *
 * @returns 受け止めた本文
 */
function stubLambda(): { readonly payloads: Record<string, unknown>[] } {
  const payloads: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'lambda.ap-northeast-1.amazonaws.com') {
      throw new Error(`テストが知らない宛先へ fetch しようとしました: ${url.hostname}`);
    }
    expect(request.headers.get('x-amz-invocation-type')).toBe('Event');
    payloads.push((await request.json()) as Record<string, unknown>);
    return new Response(null, { status: 202 });
  });
  return { payloads };
}

/** `/mcp` への 1 回の要求の結果。 */
interface RawResult {
  readonly status: number;
  readonly headers: Headers;
  readonly message: { result?: unknown; error?: unknown } | null;
  readonly body: string;
}

/**
 * JSON-RPC の本文を `/mcp` へ送る（クライアントの SDK を通さない形。旧版の要求を 1 つずつ組んで見る）。
 *
 * 応答が SSE（旧版の既定）なら、最初の `data:` 行を読む。
 *
 * @param accessToken アクセストークン
 * @param body 本文
 * @param options ヘッダ・メソッド・env の差し替え
 * @param options.headers 追加のヘッダ
 * @param options.method メソッド
 * @param options.env env の差し替え
 * @returns ステータスと本文
 */
async function rawMcp(
  accessToken: string,
  body: unknown,
  options: { readonly headers?: Record<string, string>; readonly method?: string; readonly env?: Record<string, unknown> } = {},
): Promise<RawResult> {
  const method = options.method ?? 'POST';
  const response = await callWorker(
    new Request(`${APP_ORIGIN}/mcp`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...options.headers,
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
    options.env ?? {},
  );
  const text = await response.text();
  const data = text.startsWith('event:') || text.startsWith('data:')
    ? (/^data: (.*)$/mu.exec(text)?.[1] ?? '')
    : text;
  let message: RawResult['message'] = null;
  try {
    message = JSON.parse(data) as RawResult['message'];
  } catch {
    message = null;
  }
  return { status: response.status, headers: response.headers, message, body: text };
}

/**
 * 旧版（2025-06-18）の形で道具を呼ぶ（`initialize` の後の要求と同じヘッダ）。
 *
 * @param accessToken アクセストークン
 * @param name 道具
 * @param args 引数
 * @param envOverrides env の差し替え
 * @returns 生の結果
 */
async function legacyCall(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  envOverrides: Record<string, unknown> = {},
): Promise<RawResult> {
  return await rawMcp(
    accessToken,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    { headers: { 'mcp-protocol-version': '2025-06-18' }, env: envOverrides },
  );
}

/** 道具の結果（テキスト 1 つに JSON を入れた形）を読んだもの。 */
interface ToolOutcome {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
}

/**
 * 道具の結果を読む。
 *
 * @param raw 生の結果
 * @returns 失敗かと本文
 */
function toolOutcome(raw: RawResult): ToolOutcome {
  expect(raw.status, raw.body).toBe(200);
  const result = raw.message?.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  expect(result?.content?.[0]?.type, raw.body).toBe('text');
  return { isError: result?.isError === true, body: JSON.parse(result!.content![0]!.text) as Record<string, unknown> };
}

/**
 * MCP のクライアントの SDK（`@modelcontextprotocol/client`）で接続する。
 *
 * @param accessToken アクセストークン
 * @param era 旧版（`initialize`。クライアントの既定の 2025-11-25）か、2026-07-28 版（`server/discover` で交渉して固定）か
 * @param envOverrides env の差し替え
 * @returns クライアントと、送った要求の記録
 */
async function sdkClient(
  accessToken: string,
  era: 'legacy' | 'modern',
  envOverrides: Record<string, unknown> = {},
): Promise<{ readonly client: Client; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetchThroughWorker = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.headers.set('authorization', `Bearer ${accessToken}`);
    sent.push(`${request.method} ${request.headers.get('mcp-protocol-version') ?? '-'}`);
    return await callWorker(request, envOverrides);
  };
  const client = new Client(
    { name: 'game-forge-test', version: '0.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${APP_ORIGIN}/mcp`), { fetch: fetchThroughWorker }));
  return { client, sent };
}

/**
 * SDK の道具の結果を読む。
 *
 * @param result `callTool` の戻り値
 * @returns 失敗かと本文
 */
function sdkOutcome(result: unknown): ToolOutcome {
  const typed = result as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: typed.isError === true, body: JSON.parse(typed.content[0]!.text) as Record<string, unknown> };
}

/**
 * 完成した作品を 1 件作る（R2 にソース、1 版目つき。`test/works-api.test.ts` と同じ作り方）。
 *
 * @param userId 作者
 * @param prompt 最初の指示文
 * @returns 作品 id
 */
async function createReadyGame(userId: string, prompt = '玉を避けるゲーム'): Promise<string> {
  const pending = await createPendingGame(env, userId, { prompt });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-${pending.id}` }));
  const row = await env.DB.prepare('select go_version, source_key, wasm_key from games where id = ?')
    .bind(pending.id)
    .first<{ go_version: string; source_key: string; wasm_key: string }>();
  await env.BUCKET.put(row!.source_key, SOURCE);
  await appendRevision(env, pending.id, { goVersion: row!.go_version, sourceKey: row!.source_key, wasmKey: row!.wasm_key }, null);
  return pending.id;
}

/**
 * 日次枠を使い切った状態にする（確定25。数えるのは台帳の行）。
 *
 * @param userId 利用者
 */
async function exhaustDailyQuota(userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
    await env.DB.prepare(
      `insert into generations
         (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at)
       values (?, null, ?, 'p', 'sonnet-4-6', 0, 0, 0, 0, 0, 1, ?)`,
    )
      .bind(crypto.randomUUID(), userId, now)
      .run();
  }
}

describe('旧版と 2026-07-28 版の両方のクライアント（接続 → tools/list → 道具）', () => {
  it('クライアントの SDK: 旧版（initialize）と 2026-07-28 版（server/discover）の両方で 6 本が見え、道具を呼べる', async () => {
    const user = await seedOAuthUser();
    const gameId = await createReadyGame(user.id, '赤い玉を避けるゲーム');
    const { accessToken } = await connectMcp(user.cookie);
    for (const era of ['legacy', 'modern'] as const) {
      const { client, sent } = await sdkClient(accessToken, era);
      // 交渉した版（旧版はクライアントの既定の 2025-11-25、新版は 2026-07-28）が要求のヘッダに載っている。
      expect(sent.at(-1), era).toBe(era === 'modern' ? 'POST 2026-07-28' : 'GET 2025-11-25');
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name), era).toEqual([...MCP_TOOL_NAMES]);
      const me = sdkOutcome(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(me.isError, era).toBe(false);
      expect(me.body, era).toMatchObject({ id: user.id, quota: { state: 'available', remaining: DAILY_QUOTA_PER_USER } });
      const list = sdkOutcome(await client.callTool({ name: 'list_my_works', arguments: {} }));
      expect(list.body['works'], era).toEqual([expect.objectContaining({ id: gameId })]);
      const detail = sdkOutcome(await client.callTool({ name: 'get_my_work', arguments: { id: gameId } }));
      expect(detail.body, era).toMatchObject({ id: gameId, prompt: '赤い玉を避けるゲーム', generation: { state: 'ready' } });
      const source = sdkOutcome(await client.callTool({ name: 'get_my_work_source', arguments: { id: gameId } }));
      expect(source.body, era).toEqual({ id: gameId, source: SOURCE });
      await client.close();
    }
  });

  it('生の要求: 2025-06-18 の initialize に同じ版で答え、続く tools/list と tools/call に応じる（セッションを持たない）', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const init = await rawMcp(accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(init.message?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'game-forge' },
      capabilities: { tools: {} },
    });
    const list = await rawMcp(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      headers: { 'mcp-protocol-version': '2025-06-18' },
    });
    expect(list.status).toBe(200);
    expect(((list.message?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    const me = toolOutcome(await legacyCall(accessToken, 'get_me', {}));
    expect(me.body).toMatchObject({ id: user.id });
  });

  it('道具の注釈と scope の案内は仕様 5.15 の表のとおり。戻せない操作の道具は無い', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const { client } = await sdkClient(accessToken, 'modern');
    const { tools } = await client.listTools();
    await client.close();
    for (const tool of tools) {
      const scope = MCP_TOOL_SCOPES[tool.name as keyof typeof MCP_TOOL_SCOPES];
      expect(tool.description, tool.name).toContain(`scope: ${scope}`);
      if (scope === SCOPE_WORKS_READ) {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true });
      } else {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: false, destructiveHint: false });
      }
    }
    // 利用者の AI の画面に出る題と説明、同意画面の scope の名前は、画面と同じ語（リフォージ）を使う（#513）。
    for (const tool of tools) {
      expect(oldOperationNamesIn(`${tool.title ?? ''} ${tool.description ?? ''}`), tool.name).toEqual([]);
    }
    for (const label of Object.values(OAUTH_SCOPE_LABELS)) {
      expect(oldOperationNamesIn(`${label.name} ${label.note}`)).toEqual([]);
    }
    // 公開・削除・退会・他の作者の作品を読む道具は出さない（仕様 5.15「出さない道具」）。
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/publish|delete|remove|withdraw|user/u);
    }
  });

  it('GET と DELETE は 405（ステートレスなのでサーバーからの流れもセッションの終了も無い）', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    for (const method of ['GET', 'DELETE']) {
      const response = await rawMcp(accessToken, null, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
    }
  });
});

describe('scope（403 insufficient_scope）', () => {
  it('works:read だけのトークン: tools/list は 6 本とも出し、読む道具は通り、生成と推敲は HTTP の 403', async () => {
    const user = await seedOAuthUser();
    const { accessToken, scope } = await connectMcp(user.cookie, [SCOPE_WORKS_READ]);
    expect(scope).toBe(SCOPE_WORKS_READ);
    const list = await rawMcp(accessToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(((list.message?.result as { tools: unknown[] }).tools)).toHaveLength(6);
    expect(toolOutcome(await legacyCall(accessToken, 'get_me', {})).isError).toBe(false);

    const lambda = stubLambda();
    for (const [name, args] of [
      ['start_generation', { prompt: '青い玉' }],
      ['start_revision', { id: crypto.randomUUID(), prompt: '速く' }],
    ] as const) {
      const refused = await legacyCall(accessToken, name, args, LAMBDA_ENV);
      expect(refused.status, name).toBe(403);
      const challenge = refused.headers.get('www-authenticate') ?? '';
      expect(challenge, name).toContain('Bearer error="insufficient_scope"');
      expect(challenge, name).toContain(`scope="${SCOPE_WORKS_GENERATE}"`);
      expect(challenge, name).toContain(`resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
      expect(JSON.parse(refused.body), name).toEqual({ error: 'insufficient_scope', scope: SCOPE_WORKS_GENERATE });
    }
    // SDK の手前で断ったので、行も起動も無い。
    expect(lambda.payloads).toEqual([]);
    const rows = await env.DB.prepare('select count(*) as n from games where author_id = ?').bind(user.id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('2026-07-28 版のクライアントも、生成の道具で 403 を受け取る（ヘッダ Mcp-Method / Mcp-Name と本文の両方で判定）', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie, [SCOPE_WORKS_READ]);
    const { client } = await sdkClient(accessToken, 'modern');
    await expect(client.callTool({ name: 'start_generation', arguments: { prompt: '青い玉' } })).rejects.toThrow(/Insufficient scope: required "works:generate"/u);
    await client.close();
  });

  it('works:generate だけのトークンは、読む道具で 403（scope="works:read"）', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie, [SCOPE_WORKS_GENERATE]);
    const refused = await legacyCall(accessToken, 'get_me', {});
    expect(refused.status).toBe(403);
    expect(refused.headers.get('www-authenticate')).toContain(`scope="${SCOPE_WORKS_READ}"`);
  });

  it('判定の材料: 本文（単体・配列）とヘッダのどちらかが書く道具を指せば要る。知らない道具と他の method は何も要らない', () => {
    const none = new Headers();
    const call = (name: unknown): unknown => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
    expect(requiredScopeOf(JSON.stringify(call('start_generation')), none)).toEqual([SCOPE_WORKS_GENERATE]);
    expect(requiredScopeOf(JSON.stringify([call('get_me'), call('start_revision')]), none)).toEqual([
      SCOPE_WORKS_READ,
      SCOPE_WORKS_GENERATE,
    ]);
    // 本文は読む道具・ヘッダは書く道具（食い違い）→ 書く道具の scope も要る。
    expect(
      requiredScopeOf(JSON.stringify(call('get_me')), new Headers({ 'mcp-method': 'tools/call', 'mcp-name': 'start_generation' })),
    ).toEqual([SCOPE_WORKS_GENERATE, SCOPE_WORKS_READ]);
    expect(requiredScopeOf(JSON.stringify(call('no_such_tool')), none)).toEqual([]);
    expect(requiredScopeOf(JSON.stringify(call('constructor')), none)).toEqual([]);
    expect(requiredScopeOf(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), none)).toEqual([]);
    expect(requiredScopeOf('{not json', none)).toEqual([]);
  });
});

describe('呼ぶたびの確認（BAN・退会・上限）', () => {
  it('BAN・退会を始めた利用者のトークンは 401（invalid_token）', async () => {
    for (const column of ['banned_at', 'withdrawal_started_at'] as const) {
      const user = await seedOAuthUser();
      const { accessToken } = await connectMcp(user.cookie);
      await env.DB.prepare(`update users set ${column} = ? where id = ?`).bind(Math.floor(Date.now() / 1000) - 10, user.id).run();
      const refused = await legacyCall(accessToken, 'get_me', {});
      expect(refused.status, column).toBe(401);
      expect(refused.headers.get('www-authenticate'), column).toContain('error="invalid_token"');
    }
  });

  it('上限を超えたら 429 と Retry-After。鍵は mcp:<利用者の id>。入口が呼べなければ通す', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const keys: string[] = [];
    const denying = { API_RATE_LIMITER: { allow: async (key: string) => (keys.push(key), false) } };
    const refused = await legacyCall(accessToken, 'get_me', {}, denying);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(JSON.parse(refused.body)).toEqual({ error: 'rate-limited' });
    expect(keys).toEqual([`mcp:${user.id}`]);
    const broken = {
      API_RATE_LIMITER: {
        allow: async () => {
          throw new Error('unavailable');
        },
      },
    };
    expect((await legacyCall(accessToken, 'get_me', {}, broken)).status).toBe(200);
  });

  it('Origin がアプリのホスト以外なら 403', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const refused = await rawMcp(accessToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      headers: { origin: 'https://evil.example' },
    });
    expect(refused.status).toBe(403);
  });
});

describe('自作だけを読む', () => {
  it('他人の作品・無い id・形の違う id は、読む道具でどれも同じ not-found', async () => {
    const owner = await seedOAuthUser();
    const othersGame = await createReadyGame(owner.id);
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    for (const tool of ['get_my_work', 'get_my_work_source'] as const) {
      for (const id of [othersGame, crypto.randomUUID(), 'not-a-uuid']) {
        const outcome = toolOutcome(await legacyCall(accessToken, tool, { id }));
        expect(outcome, `${tool} ${id}`).toEqual({ isError: true, body: { error: 'not-found' } });
      }
    }
    // 他人の作品は一覧にも出ない。
    const list = toolOutcome(await legacyCall(accessToken, 'list_my_works', {}));
    expect(list.body['works']).toEqual([]);
  });

  it('一覧の offset は口と同じ規則（小数・負・上限超えは invalid-offset）。state は口と同じ語彙', async () => {
    const user = await seedOAuthUser();
    await createReadyGame(user.id);
    const { accessToken } = await connectMcp(user.cookie);
    for (const offset of [1.5, -1, 3001]) {
      expect(toolOutcome(await legacyCall(accessToken, 'list_my_works', { offset })), String(offset)).toEqual({
        isError: true,
        body: { error: 'invalid-offset' },
      });
    }
    const drafts = toolOutcome(await legacyCall(accessToken, 'list_my_works', { state: 'draft', offset: 0 }));
    expect(drafts.body).toMatchObject({ filter: 'draft', nextOffset: null });
    const unknown = toolOutcome(await legacyCall(accessToken, 'list_my_works', { state: 'nonsense' }));
    expect(unknown.body['filter']).toBe('all');
  });
});

describe('引数の形の誤り（道具に届く前に SDK が断る）', () => {
  it('start_generation / start_revision: 欠けた・型の違う・余分なキーの引数は、分類名ではなく SDK の「Input validation error」の失敗。行も起動も作らない', async () => {
    const user = await seedOAuthUser();
    const gameId = await createReadyGame(user.id);
    const { accessToken } = await connectMcp(user.cookie);
    const lambda = stubLambda();
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['start_generation', {}],
      ['start_generation', { prompt: 5 }],
      ['start_generation', { prompt: '青い玉', extra: true }],
      ['start_revision', {}],
      ['start_revision', { id: 1, prompt: '速く' }],
      ['start_revision', { id: gameId, prompt: '速く', extra: true }],
    ];
    for (const [name, args] of cases) {
      const label = `${name} ${JSON.stringify(args)}`;
      const raw = await legacyCall(accessToken, name, args, LAMBDA_ENV);
      // **JSON-RPC の invalid params ではなく、HTTP 200 の中の道具の失敗**（SDK 2.0.0 の実測。仕様 5.15 の PR② の注記）。
      expect(raw.status, label).toBe(200);
      expect(raw.message?.error, label).toBeUndefined();
      const result = raw.message?.result as { isError?: boolean; content: { type: string; text: string }[] };
      expect(result.isError, label).toBe(true);
      expect(result.content[0]!.text, label).toMatch(new RegExp(`^Input validation error: Invalid arguments for tool ${name}`, 'u'));
      if ('extra' in args) {
        // 余分なキーは落とさずに断る（`z.strictObject`）。
        expect(result.content[0]!.text, label).toContain('Unrecognized key');
      }
    }
    // 2026-07-28 版のクライアントでも同じ形（道具の失敗として返り、例外にならない）。
    const { client } = await sdkClient(accessToken, 'modern', LAMBDA_ENV);
    const modern = (await client.callTool({ name: 'start_generation', arguments: { prompt: '青い玉', extra: true } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await client.close();
    expect(modern.isError).toBe(true);
    expect(modern.content[0]!.text).toContain('Unrecognized key');

    expect(lambda.payloads).toEqual([]);
    const rows = await env.DB.prepare('select count(*) as n from games where author_id = ?').bind(user.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const jobs = await env.DB.prepare('select count(*) as n from game_revision_jobs where game_id = ?').bind(gameId).first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });
});

describe('本文の上限（64 KiB）', () => {
  /**
   * 空白で詰めて、ちょうど `bytes` バイトの `tools/list` の本文を作る。
   *
   * @param bytes バイト数
   * @returns 本文
   */
  function paddedToolsList(bytes: number): string {
    const core = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return `${' '.repeat(bytes - core.length)}${core}`;
  }

  /**
   * 生の本文を `/mcp` へ送る。
   *
   * @param accessToken アクセストークン
   * @param body 本文
   * @param headers 追加のヘッダ
   * @returns 応答
   */
  async function postRaw(accessToken: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return await callWorker(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body,
      }),
    );
  }

  it('ちょうど上限は通り、1 バイト超えると 413。判定は読んだバイト数で、Content-Length の申告だけが大きくても断らない', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const exact = paddedToolsList(MCP_MAX_BODY_BYTES);
    expect(new TextEncoder().encode(exact).byteLength).toBe(MCP_MAX_BODY_BYTES);
    const ok = await postRaw(accessToken, exact);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('"start_generation"');

    const over = await postRaw(accessToken, paddedToolsList(MCP_MAX_BODY_BYTES + 1));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'body-too-large' });

    // `Content-Length` は見ない（実際に読んだ量で切る。`readLimitedText`）。申告だけ大きい小さな本文は通る。
    const declared = await postRaw(accessToken, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      'content-length': String(MCP_MAX_BODY_BYTES * 10),
    });
    expect(declared.status).toBe(200);
  });
});

describe('道具の中の失敗', () => {
  it('道具の中で投げた例外は internal error の結果にし、例外の文言を返さない', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    // 作品の表（games）を読む文だけを落とす D1（利用者の確認は通る）。
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('from games')) {
              throw new Error('D1_ERROR: secret detail from the database');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const raw = await legacyCall(accessToken, 'list_my_works', {}, { DB: failingDb });
    expect(toolOutcome(raw)).toEqual({ isError: true, body: { error: 'internal error' } });
    expect(raw.body).not.toContain('secret detail');
  });
});

describe('生成と推敲の開始（既存の経路を通る）', () => {
  it('start_generation: 既定の pipeline で行を作って Lambda を 1 回起動し、状況は get_my_work で読める', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const lambda = stubLambda();
    const started = toolOutcome(await legacyCall(accessToken, 'start_generation', { prompt: '  青い玉を集めるゲーム  ' }, LAMBDA_ENV));
    expect(started.isError).toBe(false);
    const gameId = started.body['gameId'] as string;
    expect(started.body).toEqual({
      gameId,
      url: workPagePath(gameId),
      status: { tool: 'get_my_work', arguments: { id: gameId } },
    });
    // 起動の本文（オーケストレータのペイロード）に、前後の空白を落とした指示文が載る。
    expect(lambda.payloads).toHaveLength(1);
    expect(lambda.payloads[0]).toMatchObject({ gameId, prompt: '青い玉を集めるゲーム' });
    const row = await env.DB.prepare('select author_id, generation_state, prompt from games where id = ?')
      .bind(gameId)
      .first<{ author_id: string; generation_state: string; prompt: string }>();
    expect(row).toEqual({ author_id: user.id, generation_state: 'pending', prompt: '青い玉を集めるゲーム' });
    const detail = toolOutcome(await legacyCall(accessToken, 'get_my_work', { id: gameId }));
    expect(detail.body).toMatchObject({ generation: { state: 'pending' } });

    // 進行中の生成があるうちは、2 本目を行も起動も作らずに断る（#455）。
    const busy = toolOutcome(await legacyCall(accessToken, 'start_generation', { prompt: '赤い玉' }, LAMBDA_ENV));
    expect(busy).toEqual({ isError: true, body: { error: 'generation-in-flight' } });
    expect(lambda.payloads).toHaveLength(1);
  });

  it('start_generation の入力の検査と枠切れは、/api/generate と同じ分類名', async () => {
    const user = await seedOAuthUser();
    const { accessToken } = await connectMcp(user.cookie);
    const lambda = stubLambda();
    expect(toolOutcome(await legacyCall(accessToken, 'start_generation', { prompt: '   ' }, LAMBDA_ENV))).toEqual({
      isError: true,
      body: { error: 'missing-prompt' },
    });
    expect(toolOutcome(await legacyCall(accessToken, 'start_generation', { prompt: 'あ'.repeat(2001) }, LAMBDA_ENV))).toEqual({
      isError: true,
      body: { error: 'prompt-too-long' },
    });

    await exhaustDailyQuota(user.id);
    const viaMcp = toolOutcome(await legacyCall(accessToken, 'start_generation', { prompt: '青い玉' }, LAMBDA_ENV));
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body).toMatchObject({ error: 'daily-quota' });
    // 画面の口（/api/generate）と同じ本文。
    const issuedAt = Math.floor(Date.now() / 1000);
    const session = await signSession({ userId: user.id, issuedAt, expiresAt: issuedAt + 3600 }, OAUTH_FLOW_SECRET);
    const viaApi = await dispatch(
      createGenerateRoutes(),
      new Request(`${APP_ORIGIN}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: buildSessionCookie(session, 3600).split(';')[0]! },
        body: JSON.stringify({ prompt: '青い玉' }),
      }),
      { ...env, SESSION_SECRET: OAUTH_FLOW_SECRET } as Env,
    );
    expect(viaApi.status).toBe(429);
    expect(viaMcp.body).toEqual(await viaApi.json());
    expect(lambda.payloads).toEqual([]);
  });

  it('start_revision: 自作の下書きなら既定の pipeline で起動し、他人の作品・枠切れ・入力の誤りは /api/revise と同じ分類名', async () => {
    const owner = await seedOAuthUser();
    const gameId = await createReadyGame(owner.id);
    const other = await seedOAuthUser();
    const othersGame = await createReadyGame(other.id);
    const { accessToken } = await connectMcp(owner.cookie);
    const lambda = stubLambda();

    expect(toolOutcome(await legacyCall(accessToken, 'start_revision', { id: othersGame, prompt: '速く' }, LAMBDA_ENV))).toEqual({
      isError: true,
      body: { error: 'not revisable' },
    });
    expect(toolOutcome(await legacyCall(accessToken, 'start_revision', { id: 'not-a-uuid', prompt: '速く' }, LAMBDA_ENV))).toEqual({
      isError: true,
      body: { error: 'invalid request' },
    });
    expect(lambda.payloads).toEqual([]);

    const started = toolOutcome(await legacyCall(accessToken, 'start_revision', { id: gameId, prompt: '玉を速く' }, LAMBDA_ENV));
    expect(started).toEqual({
      isError: false,
      body: { gameId, url: workEditPath(gameId), status: { tool: 'get_my_work', arguments: { id: gameId } } },
    });
    expect(lambda.payloads).toHaveLength(1);
    expect(lambda.payloads[0]).toMatchObject({ gameId, prompt: '玉を速く', baseSource: SOURCE });
    const detail = toolOutcome(await legacyCall(accessToken, 'get_my_work', { id: gameId }));
    expect(detail.body).toMatchObject({ revision: { running: true } });

    // 走っている推敲がある＝利用者に進行中の要求がある（#455）。
    const busy = toolOutcome(await legacyCall(accessToken, 'start_revision', { id: gameId, prompt: 'もっと速く' }, LAMBDA_ENV));
    expect(busy).toEqual({ isError: true, body: { error: 'generation-in-flight' } });

    const quotaUser = await seedOAuthUser();
    const quotaGame = await createReadyGame(quotaUser.id);
    const quotaToken = (await connectMcp(quotaUser.cookie)).accessToken;
    await exhaustDailyQuota(quotaUser.id);
    const refused = toolOutcome(await legacyCall(quotaToken, 'start_revision', { id: quotaGame, prompt: '速く' }, LAMBDA_ENV));
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ error: 'daily-quota' });
    expect(lambda.payloads).toHaveLength(1);
  });
});
