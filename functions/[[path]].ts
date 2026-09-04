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

export const onRequest: PagesFunction<Env> = (context) =>
  worker.fetch(context.request, context.env);
