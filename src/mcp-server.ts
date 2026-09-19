/**
 * MCP サーバー本体（#696 PR② / M19-1。仕様 5.15）。**部品（`@cloudflare/workers-oauth-provider`）がトークンを検証した後の
 * `/mcp` の処理である**（`src/oauth-provider.ts` の `apiHandler`）。
 *
 * ## 形
 *
 * ```text
 * POST /mcp ─ 部品（Bearer の検証・audience）─→ handleMcpRequest
 *   1. Origin（DNS rebinding）            … 403
 *   2. POST だけ（GET / DELETE は 405）    … 405
 *   3. 利用者が今も操作してよいか（BAN・退会）… 401 `invalid_token`
 *   4. 呼び出しの上限（鍵 `mcp:<利用者>`）   … 429
 *   5. 道具の scope（本文の method と道具の名前、`Mcp-Method` / `Mcp-Name`）… 403 `insufficient_scope`
 *   6. MCP の SDK（`@modelcontextprotocol/server` の `createMcpHandler`。ステートレス）
 * ```
 *
 * **MCP の SDK を直に使い、Agents SDK は経由しない**（確定36。束の大きさ）。SDK の `createMcpHandler` は 1 つの口で
 * **2026-07-28 版（要求ごとの `_meta` の封筒）と、旧版（2025-06-18 / 2025-11-25。`initialize` を送る形）の両方に応答する**
 * （旧版は `legacy: 'stateless'`。要求ごとに新しいサーバーを作って答え、セッションを持たない）。Durable Objects は使わない。
 * 応答は JSON（`responseMode: 'json'`）で、SSE の購読（`subscriptions/listen`）は受けない（`maxSubscriptions: 0`）。
 *
 * ## 道具（仕様 5.15 の表）
 *
 * | 道具 | 呼ぶもの | scope |
 * |---|---|---|
 * | `list_my_works` | `myWorksListResult`（`src/works-api.ts`） | `works:read` |
 * | `get_my_work` | `myWorkResult(…, 'detail')` | `works:read` |
 * | `get_my_work_source` | `myWorkResult(…, 'source')` | `works:read` |
 * | `get_me` | `loadMe`（`src/users-api.ts`） | `works:read` |
 * | `start_generation` | `parseGenerateRequest` の規則 → `startGeneration`（`src/generate.ts`） | `works:generate` |
 * | `start_revision` | `validateReviseInput` → `startRevision`（`src/revise.ts`） | `works:generate` |
 *
 * **道具は既存の関数を利用者の id で直接呼ぶ。** アプリの `/api/*` へ HTTP で呼び直さない（token passthrough を作らない）。
 * 結果は既存の口と同じ JSON を 1 つのテキストに入れ、失敗（ステータス 400 以上に当たるもの）は `isError: true` で、
 * **既存の口と同じ分類名**（`not-found`・`invalid-offset`・`daily-quota`・`monthly-limit`・`generation-in-flight` など）を返す。
 * 違うのは 1 か所だけで、生成・推敲の開始の `statusUrl`（`/api/me/works/<id>`。MCP のトークンでは読めない）の代わりに、
 * 状況を読む道具（`get_my_work`）と引数を `status` に載せる。
 *
 * **道具の題と説明（利用者の AI の画面に出る）は、画面と同じ語「リフォージ」を使う**（#513 の用語。道具の名前
 * `start_revision` は仕様 5.15 の表のまま）。
 *
 * ## scope の判定を SDK の手前（HTTP の層）に置く
 *
 * 足りなければ **HTTP の 403 と `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`** を返す（MCP の仕様の
 * 段階的な認可。クライアントはこれを見て、足りない scope で認可をやり直す）。SDK の中（道具の中）で判定すると、
 * 応答は HTTP 200 の中の道具のエラーになり、クライアントが認可をやり直す合図にならない。**本文は JSON-RPC なので、
 * SDK に渡す前に読めば method と道具の名前が分かる**（2026-07-28 版は同じ値を `Mcp-Method` / `Mcp-Name` ヘッダにも載せる。
 * どちらかが書く道具を指していれば断る）。道具の中でも同じ判定をもう 1 度する（層を 1 つに頼らない）。
 *
 * **`tools/list` は scope に関わらず 6 本とも出す。** 持っている scope の道具だけを出すと、読むだけの接続の AI は
 * 生成の道具があることを知らず、呼ばないので 403 も起きず、利用者が「生成を許す」へつなぎ直す合図（段階的な認可）が
 * 生まれない。道具の説明に要る scope を書き、呼ばれたら 403 で知らせる。
 *
 * ## オーケストレータの束に入らない
 *
 * このモジュールと、ここから呼ぶために関数を切り出した `src/works-api.ts`・`src/users-api.ts`・`src/revise.ts` は、
 * どれもオーケストレータ Lambda の束に入らない（`scripts/orchestrator-bundle-changed.sh`）。`src/generate.ts` は
 * 変えずに、既存の輸出（`parseGenerateRequest`・`startGeneration`・例外の型）だけを使う。
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { allowApiCall, API_RATE_LIMIT, RATE_LIMITED_BODY } from './api-rate-limit.js';
import type { GenerationPipeline } from './generate.js';
import { defaultPipeline, GenerationInFlight, parseGenerateRequest, QuotaExceeded, startGeneration } from './generate.js';
import { MY_WORKS_FILTERS } from './my-works-query.js';
import { normalizeHost } from './origins.js';
import { MCP_PATH, PROTECTED_RESOURCE_METADATA_PATH, SCOPE_WORKS_GENERATE, SCOPE_WORKS_READ } from './oauth-paths.js';
import { isOAuthUserActive } from './oauth-user.js';
import { workPagePath } from './paths.js';
import { describeQuotaRejection, IN_FLIGHT_REASON } from './quota.js';
import { revisionRefusalBody, startRevision, validateReviseInput } from './revise.js';
import { readLimitedText } from './routes.js';
import { loadMe } from './users-api.js';
import { workEditPath } from './work-edit-paths.js';
import { MY_WORKS_API_MAX_OFFSET, MY_WORKS_API_PAGE_SIZE, myWorkResult, myWorksListResult } from './works-api.js';

/** 道具の名前。 */
export const MCP_TOOL_NAMES = [
  'list_my_works',
  'get_my_work',
  'get_my_work_source',
  'get_me',
  'start_generation',
  'start_revision',
] as const;

/** 道具の名前の型。 */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * 道具ごとに要る scope（仕様 5.15 の表）。**HTTP の層（{@link requiredScopeOf}）と道具の中の両方がこれを読む。**
 */
export const MCP_TOOL_SCOPES: Readonly<Record<McpToolName, string>> = {
  list_my_works: SCOPE_WORKS_READ,
  get_my_work: SCOPE_WORKS_READ,
  get_my_work_source: SCOPE_WORKS_READ,
  get_me: SCOPE_WORKS_READ,
  start_generation: SCOPE_WORKS_GENERATE,
  start_revision: SCOPE_WORKS_GENERATE,
};

/**
 * `/mcp` の本文の上限（バイト）。**64 KiB**。道具の引数でいちばん大きいのは生成と推敲の指示文（2,000 文字＝
 * UTF-8 で最大 8 KB）で、JSON-RPC の封筒と 2026-07-28 版の `_meta`（クライアントの能力と情報）を足しても余る。
 */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

/** サーバーの名乗り（`initialize` / `server/discover` の `serverInfo`）。 */
const SERVER_INFO = { name: 'game-forge', title: 'Game Forge', version: '1.0.0' } as const;

/** トークンの props（`src/oauth-provider.ts` の `OAuthTokenProps`。型は信用しない）。 */
interface McpTokenProps {
  readonly userId?: unknown;
  readonly scope?: unknown;
}

/** 道具が使う、要求ごとの値。 */
interface McpCallContext {
  readonly env: Env;
  readonly request: Request;
  readonly userId: string;
  readonly scopes: ReadonlySet<string>;
  readonly pipeline: GenerationPipeline;
}

/**
 * `/mcp` の要求を処理する（部品がトークンを検証した後にだけ呼ばれる）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param ctx 実行文脈（`ctx.props` にトークンの props が載っている）
 * @param pipeline 生成の各段（既定は `defaultPipeline`。起動はオーケストレータ Lambda への非同期呼び出し）
 * @returns レスポンス
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pipeline: GenerationPipeline = defaultPipeline,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAllowedMcpOrigin(request.headers.get('origin'), env)) {
    return jsonResponse({ error: 'forbidden-origin' }, 403);
  }
  // **ステートレスなので、GET（サーバーからの SSE の流れ）と DELETE（セッションの終了）は無い**（仕様の 405）。
  // 利用者の確認（D1）より先に断る。
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  }
  const props = (ctx as unknown as { props?: McpTokenProps }).props;
  if (!(await isOAuthUserActive(env.DB, props?.userId))) {
    return jsonResponse({ error: 'invalid_token' }, 401, {
      'www-authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(url)}"`,
    });
  }
  const userId = props!.userId as string;
  // 5.13 のいいねの Worker の入口を、MCP の鍵で使い回す（1 人 60 秒 60 回。呼べなければ通す）。
  if (!(await allowApiCall(env, 'mcp', userId))) {
    return jsonResponse(RATE_LIMITED_BODY, 429, { 'retry-after': String(API_RATE_LIMIT.periodSeconds) });
  }

  const read = await readLimitedText(request, MCP_MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === 'body-too-large'
      ? jsonResponse({ error: 'body-too-large' }, 413)
      : jsonResponse({ error: 'unreadable-body' }, 400);
  }
  const scopes = scopesOf(props?.scope);
  const required = requiredScopeOf(read.text, request.headers);
  const missing = required.find((scope) => !scopes.has(scope));
  if (missing !== undefined) {
    return insufficientScope(url, missing);
  }

  const call: McpCallContext = { env, request, userId, scopes, pipeline };
  const handler = createMcpHandler(() => buildServer(call, url.origin), {
    legacy: 'stateless',
    responseMode: 'json',
    maxSubscriptions: 0,
    keepAliveMs: 0,
    onerror: (error) => {
      // 中身（引数・プロンプト）は出さない。種類だけ。
      console.error(`[mcp] ${error.name}`);
    },
  });
  // 読んだ本文で要求を作り直して SDK へ渡す（元の要求の本文は読み切っている）。
  const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: read.text });
  return await handler.fetch(forwarded);
}

/**
 * 保護されたリソースのメタデータの URL（`/mcp` 付きの形。部品の 401 と同じ値）。
 *
 * @param url 要求の URL
 * @returns URL
 */
function resourceMetadataUrl(url: URL): string {
  return `${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`;
}

/**
 * scope が足りないときの 403（MCP の仕様の段階的な認可の形）。
 *
 * @param url 要求の URL
 * @param scope 足りない scope
 * @returns レスポンス
 */
function insufficientScope(url: URL, scope: string): Response {
  return jsonResponse({ error: 'insufficient_scope', scope }, 403, {
    'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadataUrl(url)}", error_description="This tool requires the ${scope} scope"`,
  });
}

/**
 * トークンの props の scope を集合にする。**形が違えば空**（何も許さない側に倒す）。
 *
 * @param value props の `scope`
 * @returns scope の集合
 */
function scopesOf(value: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : []);
}

/**
 * 要求が呼ぶ道具に要る scope を集める（SDK の手前で判定するため）。
 *
 * **見るのは 2 か所**——本文の JSON-RPC（`method: "tools/call"` と `params.name`。配列で来ても 1 つずつ見る）と、
 * 2026-07-28 版のヘッダ（`Mcp-Method` / `Mcp-Name`）。SDK が道具を選ぶのは本文なので本文が本体で、ヘッダは
 * 本文と食い違う要求（SDK が断る）でも書く道具を指していれば断るための保険である。読めない本文と知らない道具は
 * ここでは何も要らないとし、SDK の誤りの応答に任せる。
 *
 * @param text 本文
 * @param headers 要求のヘッダ
 * @returns 要る scope（重複あり）
 */
export function requiredScopeOf(text: string, headers: Headers): string[] {
  const names: unknown[] = [];
  if ((headers.get('mcp-method') ?? '').trim() === 'tools/call') {
    names.push((headers.get('mcp-name') ?? '').trim());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof message !== 'object' || message === null) {
      continue;
    }
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method === 'tools/call' && typeof params === 'object' && params !== null) {
      names.push((params as { name?: unknown }).name);
    }
  }
  return names.flatMap((name) =>
    typeof name === 'string' && Object.hasOwn(MCP_TOOL_SCOPES, name) ? [MCP_TOOL_SCOPES[name as McpToolName]] : [],
  );
}

/**
 * 道具の結果を組み立てる。**本文は既存の口の JSON のまま**、1 つのテキストに入れる。
 *
 * @param status 既存の口なら返すステータス（400 以上は失敗）
 * @param body 本文
 * @returns 道具の結果
 */
function toolResult(status: number, body: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    ...(status >= 400 ? { isError: true } : {}),
  };
}

/**
 * 道具の中の scope の判定（HTTP の層で断っているので、ここへ来るのは層の取りこぼしだけ。{@link guarded} が呼ぶ）。
 *
 * @param call 要求ごとの値
 * @param tool 道具
 * @returns 足りなければ失敗の結果、足りていれば null
 */
function scopeRefusal(call: McpCallContext, tool: McpToolName): CallToolResult | null {
  const scope = MCP_TOOL_SCOPES[tool];
  return call.scopes.has(scope) ? null : toolResult(403, { error: 'insufficient_scope', scope });
}

/**
 * 道具の中身を包む——**scope をもう 1 度確かめ、投げた例外を `internal error` の結果にする。**
 *
 * SDK は道具が投げた例外の `message` を結果の本文に入れて返す。D1 や R2 の失敗の文言を利用者の AI へ流さないように、
 * ここで受けて、口と同じ分類名（`src/index.ts` の 500 の本文 `internal error`）に落とす。ログには例外の種類だけを出す。
 *
 * @param call 要求ごとの値
 * @param tool 道具
 * @param run 中身
 * @returns SDK に渡す道具の処理
 */
function guarded<Args>(
  call: McpCallContext,
  tool: McpToolName,
  run: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    const refused = scopeRefusal(call, tool);
    if (refused !== null) {
      return refused;
    }
    try {
      return await run(args);
    } catch (error) {
      console.error(`[mcp] ${tool} の処理に失敗しました: ${error instanceof Error ? error.name : typeof error}`);
      return toolResult(500, { error: 'internal error' });
    }
  };
}

/**
 * 生成・推敲を始めた後に返す、状況の読み方（既存の口の `statusUrl` の代わり）。
 *
 * @param gameId 作品 id
 * @returns 道具と引数
 */
function statusTool(gameId: string): { readonly tool: 'get_my_work'; readonly arguments: { readonly id: string } } {
  return { tool: 'get_my_work', arguments: { id: gameId } };
}

/**
 * サーバー（道具 6 本）を組む。**要求ごとに作る**（SDK の `createMcpHandler` が要求ごとに呼ぶ。状態を持たない）。
 *
 * @param call 要求ごとの値
 * @param origin アプリのホストの origin（結果の中のパスの起点として案内する）
 * @returns サーバー
 */
function buildServer(call: McpCallContext, origin: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: [
      'Game Forge は、自然文の指示から遊べるブラウザゲームを作るサービスです。この接続では、あなた（利用者）の作品の読み取りと、生成・リフォージの開始ができます。',
      '生成とリフォージ（公開前の自分の作品の作り直し）は始めるだけで、完成まで 80 秒以上かかります。start_generation / start_revision の結果の status にある get_my_work で、generation.state（新規）や revision.running（リフォージ）を、間を空けて確かめてください。',
      `結果に含まれるパス（/works/… など）は ${origin} からの相対です。/api/ で始まるパスはこの接続のトークンでは読めないので、対応する道具を使ってください。`,
      '公開・削除・退会の操作はこの接続ではできません（作品ページから行います）。',
    ].join('\n'),
  });
  const readOnly = { readOnlyHint: true } as const;
  const starts = { readOnlyHint: false, destructiveHint: false } as const;

  server.registerTool(
    'list_my_works',
    {
      title: '自分の作品の一覧',
      description: `自分の作品を新しい順に ${MY_WORKS_API_PAGE_SIZE} 件ずつ返します（下書き・生成中・失敗も含む）。次のページは結果の nextOffset を offset に渡します。scope: ${SCOPE_WORKS_READ}`,
      inputSchema: z.strictObject({
        state: z
          .string()
          .optional()
          .describe(`絞り込み（${MY_WORKS_FILTERS.join(' / ')}。知らない値は all）`),
        offset: z.number().optional().describe(`読み飛ばす件数（0 以上 ${MY_WORKS_API_MAX_OFFSET} 以下の整数）`),
      }),
      annotations: readOnly,
    },
    guarded(call, 'list_my_works', async ({ state, offset }: { state?: string; offset?: number }) => {
      // **口の query と同じ規則で読む**（数を文字列にして、口と同じ検査を通す。小数・負・上限超えは invalid-offset）。
      const result = await myWorksListResult(call.env, call.userId, {
        state: state ?? null,
        offset: offset === undefined ? null : String(offset),
      });
      return toolResult(result.status, result.body);
    }),
  );

  server.registerTool(
    'get_my_work',
    {
      title: '自分の作品の詳細と状況',
      description: `自分の作品 1 件の詳細を返します——生成の状況（generation.state が pending / running なら生成中、ready なら完成、failed なら失敗）・リフォージの状況（revision.running）・版の一覧・最初の指示文。自分の作品でない id は not-found です。scope: ${SCOPE_WORKS_READ}`,
      inputSchema: z.strictObject({ id: z.string().describe('作品 id（UUID）') }),
      annotations: readOnly,
    },
    guarded(call, 'get_my_work', async ({ id }: { id: string }) => {
      const result = await myWorkResult(call.env, call.userId, id, 'detail');
      return toolResult(result.status, result.body);
    }),
  );

  server.registerTool(
    'get_my_work_source',
    {
      title: '自分の作品のソース',
      description: `自分の作品 1 件の Go のソースを返します（下書きも読めます）。生成中・失敗した作品は source-not-ready です。scope: ${SCOPE_WORKS_READ}`,
      inputSchema: z.strictObject({ id: z.string().describe('作品 id（UUID）') }),
      annotations: readOnly,
    },
    guarded(call, 'get_my_work_source', async ({ id }: { id: string }) => {
      const result = await myWorkResult(call.env, call.userId, id, 'source');
      return toolResult(result.status, result.body);
    }),
  );

  server.registerTool(
    'get_me',
    {
      title: '自分の情報と残りの生成枠',
      description: `自分の公開プロフィールと、今日の残りの生成枠（quota.remaining。生成とリフォージが 1 回ずつ使います）を返します。scope: ${SCOPE_WORKS_READ}`,
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    guarded(call, 'get_me', async () => {
      const me = await loadMe(call.request, call.env, call.userId);
      // 呼び出し元の確認の後に退会を掴んだ（競合）。`/api/me` と同じく未認証の扱い。
      return me === null ? toolResult(401, { error: 'unauthorized' }) : toolResult(200, me);
    }),
  );

  server.registerTool(
    'start_generation',
    {
      title: '新しい作品の生成を始める',
      description: `自然文の指示（2,000 文字まで）から新しいゲームの生成を始め、作品 id をすぐ返します。完成まで 80 秒以上かかるので、結果の status にある get_my_work で状況を確かめてください。1 日の生成枠を 1 回使います（1 回あたり約 21 円の費用がかかります）。枠切れは daily-quota / monthly-limit、進行中の生成・リフォージがあれば generation-in-flight です。scope: ${SCOPE_WORKS_GENERATE}`,
      inputSchema: z.strictObject({ prompt: z.string().describe('作りたいゲームの説明（自然文。2,000 文字まで）') }),
      annotations: starts,
    },
    guarded(call, 'start_generation', async ({ prompt }: { prompt: string }) => await startGenerationTool(call, prompt)),
  );

  server.registerTool(
    'start_revision',
    {
      title: '作品のリフォージを始める',
      description: `公開前の自分の作品を、どう直すかの指示（2,000 文字まで）で作り直し始めます。完成まで 80 秒以上かかるので、結果の status にある get_my_work の revision.running で確かめてください。1 日の生成枠を 1 回使います。公開済み・他人の作品・リフォージ中は not revisable、枠切れは daily-quota / monthly-limit、進行中の生成・リフォージがあれば generation-in-flight です。scope: ${SCOPE_WORKS_GENERATE}`,
      inputSchema: z.strictObject({
        id: z.string().describe('作品 id（UUID）'),
        prompt: z.string().describe('どう直すか（自然文。2,000 文字まで）'),
      }),
      annotations: starts,
    },
    guarded(call, 'start_revision', async ({ id, prompt }: { id: string; prompt: string }) => {
      const input = validateReviseInput(id, prompt);
      if (input === null) {
        // `/api/revise` と同じ分類名（id の形・空・長すぎるを分けない）。
        return toolResult(400, { error: 'invalid request' });
      }
      const outcome = await startRevision(call.env, call.userId, input, call.pipeline);
      if (!outcome.ok) {
        const { status, body } = revisionRefusalBody(outcome);
        return toolResult(status, body);
      }
      return toolResult(202, { gameId: outcome.gameId, url: workEditPath(outcome.gameId), status: statusTool(outcome.gameId) });
    }),
  );

  return server;
}

/**
 * `start_generation` の中身。**`/api/generate` と同じ検査・同じ関数・同じ分類名**にする。
 *
 * - 入力の検査は `parseGenerateRequest` をそのまま通す（前後の空白・空・2,000 文字）。関数が `Request` を受けるので、
 *   口と同じ形の本文を組んで渡す（規則を書き写さない）
 * - 始めるのは `startGeneration`（日次・月次の枠 → 進行中の判定つきの行の作成 → ジョブの起動）
 * - 失敗の分類は `src/generate.ts` の `handleGenerate` と同じ（枠切れは `describeQuotaRejection`、進行中は
 *   `generation-in-flight`、それ以外は `internal error`）。**`handleGenerate` にある残りの分岐（ソースの検査・ビルドの
 *   失敗・未実装の段）は、同期でジョブを走らせたときにだけ起きる**——既定の起動（オーケストレータ Lambda への非同期呼び出し）
 *   では、それらは作品の行に記録され、ここへは届かない
 *
 * @param call 要求ごとの値
 * @param prompt 指示文（検査前）
 * @returns 道具の結果
 */
async function startGenerationTool(call: McpCallContext, prompt: string): Promise<CallToolResult> {
  const parsed = await parseGenerateRequest(
    new Request(`https://mcp.invalid${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }),
  );
  if (!parsed.ok) {
    return toolResult(400, { error: parsed.reason });
  }
  try {
    const game = await startGeneration(call.env, call.userId, parsed.request, call.pipeline);
    return toolResult(202, { gameId: game.id, url: workPagePath(game.id), status: statusTool(game.id) });
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      return toolResult(429, describeQuotaRejection(error.detail, error.resetsAt));
    }
    if (error instanceof GenerationInFlight) {
      return toolResult(409, { error: IN_FLIGHT_REASON });
    }
    console.error(`[mcp] 生成を始められませんでした: ${error instanceof Error ? error.name : typeof error}`);
    return toolResult(500, { error: 'internal error' });
  }
}

/**
 * MCP の口へ来た要求の `Origin` を許すか（DNS rebinding の対策。#696 PR① で `src/oauth-provider.ts` に置いたものを移した）。
 *
 * **許すのはアプリのホストだけ**（`APP_HOST`。ポートは問わない——ローカルは `:8787` で動く）。`Origin` が無い要求は
 * 許す（MCP のクライアントの多くはブラウザではなく、`Origin` を付けない）。読めない `Origin`（`null` を含む）は拒む。
 *
 * @param origin `Origin` ヘッダの値
 * @param env バインディングと環境変数
 * @returns 許すなら true
 */
export function isAllowedMcpOrigin(origin: string | null, env: Env): boolean {
  if (origin === null) {
    return true;
  }
  const appHost: unknown = env.APP_HOST;
  if (typeof appHost !== 'string' || appHost.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && normalizeHost(parsed.hostname) === normalizeHost(appHost);
  } catch {
    return false;
  }
}

/**
 * JSON の応答を組み立てる。
 *
 * @param body 本文
 * @param status ステータス
 * @param headers 追加のヘッダ
 * @returns レスポンス
 */
function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
