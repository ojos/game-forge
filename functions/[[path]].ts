/**
 * Cloudflare Pages Functions の入口（確定22 / #71）。
 *
 * **ここは薄いままにする。** 経路の実装は `src/` が持ち、このファイルは Pages の
 * 呼び出し規約（`onRequest(context)`）を、ワーカーの規約（`fetch(request, env)`）へ
 * 橋渡しするだけである。ロジックを足すと、テストが通っている `src/` の外に検証されない
 * 分岐ができる。
 *
 * `[[path]]` は catch-all で、静的ファイルに一致しなかったすべての要求がここへ来る。
 * `public/` に実体を置いていないため、実質すべての要求がワーカーへ渡る（静的ファイルは
 * Functions より先に解決されるので、置くと同じパスの経路を隠す）。
 *
 * Workers ではなく Pages を使う理由は 9.3 の確定22 にある。ゾーンが Route53 にある
 * 以上（確定17）、Workers のカスタムドメインは張れない。
 */
import worker from '../src/index.js';

export const onRequest: PagesFunction<Env> = (context) =>
  worker.fetch(context.request, context.env);
