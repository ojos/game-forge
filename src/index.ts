/**
 * Workers のエントリポイント。
 *
 * `Host` ヘッダでアプリ用ホストとサンドボックス用ホストを出し分ける。
 * 1 つの `wrangler dev` プロセスで両方を提供できるのは、オリジンが
 * スキーム・**ホスト**・ポートで決まるためで、同じポートでもホスト名が違えば
 * 別オリジンになる（7.2 が要求するのは別オリジンであって別ポートではない）。
 */
import { normalizeHost } from './origins.js';
import { handleAppRequest } from './app.js';
import { handleSandboxRequest } from './sandbox.js';

export default {
  /**
   * 受信したリクエストを Host ヘッダで振り分ける。
   *
   * @param request 受信したリクエスト
   * @param env バインディングと環境変数
   * @returns レスポンス
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const host = normalizeHost(new URL(request.url).hostname);
      const appHost = normalizeHost(env.APP_HOST);
      const sandboxHost = normalizeHost(env.SANDBOX_HOST);

      if (host === sandboxHost) {
        // `request` と `env` の両方を渡す。#28 で本物の配信が入り、**どの作品を返すかは
        // URL（どのキーか）と D1 / R2（その作品が配信してよいものか）を見なければ
        // 決まらなくなった**ため。M0.5-3 の頃は引数が無かった。
        return await handleSandboxRequest(request, env);
      }
      if (host === appHost) {
        return await handleAppRequest(request, env);
      }

      // 未知のホストは通さない。ここを既定でアプリ側へ流すと、サンドボックス用
      // ホストの綴りを間違えたまま「アプリが返っているので動いている」と読めてしまい、
      // 別オリジンの検証が黙って成立しなくなる。
      return new Response(
        JSON.stringify(
          {
            error: 'unknown host',
            received: host,
            expected: { app: appHost, sandbox: sandboxHost },
          },
          null,
          2,
        ),
        {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        },
      );
    } catch (error) {
      console.error('[worker] リクエストの処理に失敗しました', error);
      return new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
} satisfies ExportedHandler<Env>;
