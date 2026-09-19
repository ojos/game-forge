/**
 * Cloudflare Pages Functions の入口（確定22 / #71）。
 *
 * **ここは薄いままにする。** 経路の実装は `src/` が持ち、このファイルは Pages の
 * 呼び出し規約（`onRequest(context)`）を、ワーカーの規約（`fetch(request, env)`）へ
 * 橋渡しするだけである。ロジックを足すと、テストが通っている `src/` の外に検証されない
 * 分岐ができる。
 *
 * `[[path]]` は catch-all である。**どの要求がここへ来るかは `public/_routes.json` が
 * 決める**（#266）。catch-all なので、`_routes.json` が無いと `/*` がすべてここへ来て、
 * `public/` に実体がある資材まで飲み込む（実測。`docs/pages-deploy.md`）。いまは
 * `/assets/*` だけを `exclude` してあり、それ以外はすべてワーカーへ渡る。
 *
 * それとは別に、**経路と同じパスへ静的ファイルを置くとその経路が隠れる**
 * （`index.html` を置くと `/` が隠れることは実測済み）。`test/page-shell.test.ts` が
 * `_routes.json` の `exclude` と、経路との衝突の両方を機械検査する。
 *
 * Workers ではなく Pages を使う理由は 9.3 の確定22 にある。ゾーンが Route53 にある
 * 以上（確定17）、Workers のカスタムドメインは張れない。
 */
import worker from '../src/index.js';

/**
 * Pages の context から、ワーカーの `ExecutionContext` を組み立てる（#696）。
 *
 * **Pages は `ExecutionContext` を渡さない**（`onRequest` の引数は context 1 つ）。MCP の認可の部品
 * （`src/oauth-provider.ts`）はトークンを検証した後に `ctx.props` へ利用者の情報を代入するので、
 * ctx が無いと 500 になる（仕様 5.15 の試作の実測）。
 *
 * - `waitUntil` と `passThroughOnException` は Pages の context のものを結び付けて渡す
 * - **`props` は書き換えられる空のオブジェクト**にする（部品が代入する。凍ったオブジェクトや
 *   getter だけの値にすると、代入が黙って消えるか例外になる）
 *
 * @param context Pages の context
 * @returns 実行文脈
 */
function executionContextOf(context: EventContext<Env, string, unknown>): ExecutionContext {
  return {
    waitUntil: context.waitUntil.bind(context),
    passThroughOnException: context.passThroughOnException.bind(context),
    props: {},
  } as unknown as ExecutionContext;
}

export const onRequest: PagesFunction<Env> = (context) =>
  worker.fetch(context.request, context.env, executionContextOf(context));
