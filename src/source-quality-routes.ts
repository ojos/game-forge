/**
 * 完成のコールバックの後ろで、生成物の質を測る段を足す（#605）。
 *
 * **保存の本体は `src/source-quality-metrics.ts` にある。** ここは経路表を包むだけで、
 * `src/source-input-keys-routes.ts` と同じ形である。
 *
 * ## なぜ `handleCallback` の中に書かないのか
 *
 * **`src/generate-callback.ts` はオーケストレータの束に入る。** 中へ書くと束が変わり、
 * `bash scripts/deploy-orchestrator.sh` で配り直すまで **main の deploy が全部止まる**
 * （#241 の関門）。**経路表を包む側はエッジだけで閉じる**ので、束は 1 バイトも変わらない。
 *
 * ## なぜ入力キーの包みと 1 つにまとめないのか
 *
 * **契機は同じでも、版と表と寿命が違う。** `src/input-keys.ts` の
 * `INPUT_KEYS_RULE_VERSION` と `src/source-quality.ts` の `SOURCE_QUALITY_RULE_VERSION`
 * は別々に上がり、埋め戻しの対象も別々に決まる。1 つの包みにまとめると、**片方の
 * 例外がもう片方の記録を巻き込む**（どちらも「完成を失敗にしない」ために例外を握るので、
 * 握り方まで共有することになる）。**包みを重ねるほうを採る**——`src/app.ts` で
 * 2 つの包みを重ね、それぞれが自分の記録だけに責任を持つ。
 */
import { GENERATE_CALLBACK_PATH, parseCallbackRequest } from './generate-callback.js';
import type { Route } from './routes.js';
import { SOURCE_QUALITY_LOG_TAG, recordSourceQuality } from './source-quality-metrics.js';
import { errorNameOf } from './source-input-keys.js';

/**
 * 完成のコールバックの経路に、質の測定を足す。
 *
 * @param routes 包む経路表
 * @returns 包んだ経路表
 */
export function withSourceQualityRecording(routes: readonly Route[]): readonly Route[] {
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
        await measureAfterFinish(copy, response, env);
        return response;
      },
    };
  });
}

/**
 * 完成が受け入れられたときだけ測る。
 *
 * @param request 複製した要求
 * @param response 元の経路が返した応答
 * @param env 実行環境
 */
async function measureAfterFinish(request: Request, response: Response, env: Env): Promise<void> {
  try {
    if (response.status !== 200) {
      return;
    }
    const parsed = await parseCallbackRequest(request);
    if (!parsed.ok || parsed.request.kind !== 'finish' || !('artifacts' in parsed.request)) {
      return;
    }
    const body: unknown = await response.clone().json();
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { accepted?: unknown }).accepted !== true
    ) {
      return;
    }
    await recordSourceQuality(env, parsed.request.artifacts.sourceKey);
  } catch (error) {
    console.error(`${SOURCE_QUALITY_LOG_TAG} callback-failed ${errorNameOf(error)}`);
  }
}
