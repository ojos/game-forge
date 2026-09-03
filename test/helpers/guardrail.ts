/**
 * 入力側モデレーション（8.2 / #37）をテストから通すための道具。
 *
 * **オーケストレータのパイプラインは、モデル呼び出しの前に `ApplyGuardrail` を叩く。**
 * したがって `bedrockFetch` の stub には **2 種類の要求**が来る。片方しか答えない
 * stub を渡すと、Guardrail の応答として Converse の JSON が返り、
 * `readGuardrailBlocks` が「応答に action がありません」で落ちる——**モデレーションと
 * 関係のないテストが、モデレーションのせいで赤くなる。**
 *
 * ここが分けて答える。**素通しにはしない**——`action: 'NONE'` は
 * 「Guardrail が見て、何も引っ掛からなかった」という応答であり、
 * 「Guardrail を呼んでいない」とは別である。
 */

/** Guardrail のパスに現れる目印（`src/input-moderation.ts` の `applyGuardrailEndpoint`）。 */
const GUARDRAIL_PATH_MARK = '/guardrail/';

/**
 * Guardrail の要求だけを「引っ掛からなかった」で答え、残りは元の stub へ渡す。
 *
 * @param inner Converse などに答える元の stub
 * @returns 包んだ stub
 */
export function guardrailPass(
  inner: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname.includes(GUARDRAIL_PATH_MARK)) {
      return Response.json({ action: 'NONE' });
    }
    return await inner(request);
  };
}

/**
 * Guardrail の要求を「遮断した」で答え、残りは元の stub へ渡す。
 *
 * **元の stub は呼ばれないはずである。** 遮断はモデル呼び出しの手前で起きるので、
 * 呼ばれたらそれ自体が不具合である（テストは `calls()` が 0 であることを見る）。
 *
 * @param inner 元の stub
 * @param types 遮断されたカテゴリの鍵（Guardrail が返す綴り）
 * @returns 包んだ stub
 */
export function guardrailBlock(
  inner: (request: Request) => Promise<Response>,
  types: readonly string[] = ['VIOLENCE'],
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname.includes(GUARDRAIL_PATH_MARK)) {
      return Response.json({
        action: 'GUARDRAIL_INTERVENED',
        assessments: [
          {
            contentPolicy: {
              filters: types.map((type) => ({ type, confidence: 'HIGH', action: 'BLOCKED' })),
            },
          },
        ],
      });
    }
    return await inner(request);
  };
}

/**
 * Guardrail の id と版。**テストの env へ足す。**
 *
 * 足さないと `ModerationUnavailable` になり、**fail-closed で全部の生成が止まる**
 * （`src/input-moderation.ts`）。それは設計どおりの挙動だが、モデレーションと
 * 関係のないテストで起こしても何も分からない。
 */
export const MODERATION_TEST_ENV: Readonly<Record<string, string>> = {
  MODERATION_GUARDRAIL_ID: 'test-guardrail',
  MODERATION_GUARDRAIL_VERSION: '1',
};
