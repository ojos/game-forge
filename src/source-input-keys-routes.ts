/**
 * 完成のコールバックの経路を包み、作品が読むキーを拾う（仕様 3.9.5 / #493 / M14-4）。
 *
 * **保存の本体は `src/source-input-keys.ts` にある。** ここは完成のコールバック（非同期実行。本番）から
 * それを呼ぶための結線だけを持つ。
 *
 * **別のモジュールにしてあるのは、import の循環を作らないためである。** 包むには
 * `src/generate-callback.ts`（`GENERATE_CALLBACK_PATH` / `parseCallbackRequest`）が要り、あちらは
 * `src/generate.ts` を import する。`src/generate.ts` の `runJobInline` は `src/source-input-keys.ts` を
 * import するので、同じモジュールに置くと 3 つが輪になる。
 *
 * **なぜ `handleCallback` の中に書かないのか**は `src/source-input-keys.ts` の冒頭（オーケストレータの束）。
 */
import { GENERATE_CALLBACK_PATH, parseCallbackRequest } from './generate-callback.js';
import type { Route } from './routes.js';
import { SOURCE_INPUT_KEYS_LOG_TAG, errorNameOf, recordSourceInputKeys } from './source-input-keys.js';

/**
 * 完成のコールバックの後で拾うように、経路表を包む（仕様 3.9.5 の「拾う箇所」の 1）。
 *
 * **拾うのは、成果物を持つ `finish` が受け付けられた（`accepted: true`）ときだけである。**
 *
 * - `accepted: true` は、ジョブトークンが一致した（`runningJob`）ことを意味する。**トークンを持たない
 *   相手の本文にある `sourceKey` で R2 を読まない。**
 * - **`finished` は見ない**（戻り値によらず拾う）。false の重複配信でも、行が無ければ拾う。
 * - 生成・フォーク（`completeGameWithArtifacts`）と推敲（`completeRevision`）は、どちらもこの応答の形になる。
 *
 * **応答を変えない。** 拾うのは応答を組み立てたあとで、失敗しても応答はそのまま返る。
 *
 * @param routes 包む経路表（`generateCallbackRoutes` など）
 * @returns 完成のコールバックだけを包んだ経路表
 */
export function withSourceInputKeyRecording(routes: readonly Route[]): readonly Route[] {
  return routes.map((route) => {
    if (route.method !== 'POST' || route.path !== GENERATE_CALLBACK_PATH) {
      return route;
    }
    return {
      ...route,
      handler: async (request: Request, env: Env): Promise<Response> => {
        // **本文を読む前に複製する。** 元の経路が本文を読み切るので、あとからは読めない。
        const copy = request.clone();
        const response = await route.handler(request, env);
        await recordAfterFinish(copy, response, env);
        return response;
      },
    };
  });
}

/**
 * 受け付けられた `finish`（成果物あり）なら、その `sourceKey` を拾う。**例外を投げない。**
 *
 * @param request 複製した要求
 * @param response 元の経路の応答
 * @param env バインディングと環境変数
 */
async function recordAfterFinish(request: Request, response: Response, env: Env): Promise<void> {
  try {
    if (response.status !== 200) {
      return;
    }
    const parsed = await parseCallbackRequest(request);
    if (!parsed.ok || parsed.request.kind !== 'finish' || !('artifacts' in parsed.request)) {
      return;
    }
    const body: unknown = await response.clone().json();
    if (typeof body !== 'object' || body === null || (body as { accepted?: unknown }).accepted !== true) {
      return;
    }
    await recordSourceInputKeys(env, parsed.request.artifacts.sourceKey);
  } catch (error) {
    console.error(`${SOURCE_INPUT_KEYS_LOG_TAG} callback-failed ${errorNameOf(error)}`);
  }
}
