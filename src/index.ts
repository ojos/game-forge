/**
 * Workers のエントリポイント。
 *
 * `Host` ヘッダで**3 つの**ホストを出し分ける——アプリ用・サンドボックス用・
 * 運営の管理画面（2.4.1 / #356）。1 つの `wrangler dev` プロセスで全部を提供できるのは、
 * オリジンがスキーム・**ホスト**・ポートで決まるためで、同じポートでもホスト名が違えば
 * 別オリジンになる（7.2 が要求するのは別オリジンであって別ポートではない）。
 *
 * **ホストごとに経路表が別である。** `app` の表（`src/app.ts`）に admin の経路を混ぜず、
 * admin の表（`src/admin/routes.ts`）に `app` の経路を混ぜない。2.4 の制約
 * （どちらのホストでも相手の経路が出ないこと）を、**登録の順序ではなく構造で**満たす。
 */
import { normalizeHost } from './origins.js';
import { handleAdminRequest } from './admin/routes.js';
import { handleAppRequest } from './app.js';
import { handleSandboxRequest } from './sandbox.js';
import { handleOAuthProviderRequest, isOAuthProviderPath } from './oauth-provider.js';

/**
 * 振り分けに使うホスト名を、宣言から読んで正規化する。
 *
 * **未設定と空文字を「一致しないホスト」へ倒す。** `wrangler.toml` は 3 環境すべてで
 * 宣言しているが、**型が `string` であることは実行時に値があることの根拠ではない**
 * （`src/env.d.ts` の冒頭）。素で `normalizeHost(undefined)` を呼ぶと `.trim()` で投げ、
 * **宣言を 1 つ書き忘れただけで全ホストの全要求が 500 になる。**
 *
 * 空を返せば、その名前のホストは**誰にも一致しない**（`Host` ヘッダが空の要求は
 * ここへ届かない）。つまり**そのホストだけが 404 になり、残りは動く。** 事故の範囲を
 * 宣言し忘れたホストの中へ閉じ込める。
 *
 * @param host 宣言された値（未設定でも呼べる）
 * @returns 比較に使える正規化済みホスト名（未設定・空なら空文字）
 */
function configuredHost(host: string | undefined): string {
  return host === undefined ? '' : normalizeHost(host);
}

export default {
  /**
   * 受信したリクエストを Host ヘッダで振り分ける。
   *
   * **`ctx` を受ける**（#696）。MCP の認可の部品（`src/oauth-provider.ts`）がトークンを検証した後に
   * `ctx.props` へ利用者の情報を置くためで、無いと部品が 500 を返す（仕様 5.15 の試作の実測）。
   * Pages には `ExecutionContext` が無いので、入口（`functions/[[path]].ts`）が組み立てて渡す。
   *
   * @param request 受信したリクエスト
   * @param env バインディングと環境変数
   * @param ctx 実行文脈
   * @returns レスポンス
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const host = normalizeHost(new URL(request.url).hostname);
      const appHost = configuredHost(env.APP_HOST);
      const sandboxHost = configuredHost(env.SANDBOX_HOST);
      const adminHost = configuredHost(env.ADMIN_HOST);

      if (host === sandboxHost) {
        // `request` と `env` の両方を渡す。#28 で本物の配信が入り、**どの作品を返すかは
        // URL（どのキーか）と D1 / R2（その作品が配信してよいものか）を見なければ
        // 決まらなくなった**ため。M0.5-3 の頃は引数が無かった。
        return await handleSandboxRequest(request, env);
      }
      // 運営の管理画面（2.4.1）。**`app` より先に見る必要は無いが、後にも置けない**
      // ——3 つのホスト名は互いに違うので、順序で結果は変わらない。読む順を宣言の
      // 並び（`wrangler.toml` の `[vars]`）に揃えているだけである。
      if (host === adminHost) {
        return await handleAdminRequest(request, env);
      }
      if (host === appHost) {
        // MCP の認可（#696 / 仕様 5.15）。**部品が持つ口だけを部品へ渡し、残りは今までどおり経路表へ**
        // （同意画面 `/authorize` と「接続中のアプリ」のタブは経路表の側にある）。**アプリのホストだけ**に載せ、
        // sandbox と admin の枝は部品を呼ばない。
        if (isOAuthProviderPath(new URL(request.url).pathname)) {
          return await handleOAuthProviderRequest(request, env, ctx);
        }
        return await handleAppRequest(request, env);
      }

      // 未知のホストは通さない。ここを既定でアプリ側へ流すと、サンドボックス用
      // ホストの綴りを間違えたまま「アプリが返っているので動いている」と読めてしまい、
      // 別オリジンの検証が黙って成立しなくなる。
      //
      // **admin も同じ扱いである。** 綴りを間違えた admin ホストがアプリ側を返すと、
      // 「管理画面のはずが利用者の画面だった」ことに気づけないまま配備が終わる。
      return new Response(
        JSON.stringify(
          {
            error: 'unknown host',
            received: host,
            expected: { app: appHost, sandbox: sandboxHost, admin: adminHost },
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
