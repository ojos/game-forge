import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { onRequest } from '../functions/[[path]].js';

/**
 * Pages Functions の入口（`functions/[[path]].ts`）を直接確かめる。
 *
 * 他のテストは `SELF.fetch` か `dispatch` を通しており、**この薄いラッパだけが
 * 検証から漏れる**。付け替えの本体はここなので、経路が実際にワーカーへ届くことを
 * 1 か所で押さえておく。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;

/**
 * Pages Functions が渡す context を、このラッパが使う範囲だけ組み立てる。
 *
 * `onRequest` は `request` と `env` しか読まないため、他の項目は型を満たすための
 * 最小限に留める。全項目を埋めると、使っていないものが変わるたびにテストが壊れる。
 *
 * @param request 受信したリクエスト
 * @returns context
 */
function pagesContext(request: Request): Parameters<typeof onRequest>[0] {
  // `waitUntil` と `passThroughOnException` は、入口がワーカーの `ExecutionContext` を組み立てるのに読む（#696）。
  return {
    request,
    env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as Parameters<typeof onRequest>[0];
}

describe('Pages Functions の入口（#71）', () => {
  it('アプリ用ホストをアプリ側へ渡す', async () => {
    // `/` は #89 で公開トップ（src/home.ts）になった。アプリ側にしか無い見出しで判定する。
    const response = await onRequest(pagesContext(new Request(`${APP_ORIGIN}/`)));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1 class="gf-header-title">');
  });

  it('サンドボックス用ホストをサンドボックス側へ渡す', async () => {
    // Host による出し分け（7.2 の別オリジン）が Pages Functions 越しでも効くこと。
    //
    // **`/` は 404 になる。** #28 でサンドボックス用ホストは `/p/<preview_key>/` と
    // `/g/<game_id>/` しか持たなくなった。見たいのは「サンドボックス側へ渡ったか」
    // なので、あちらにしか無い CSP `sandbox` ヘッダで判定する（アプリ側の 404 と
    // 未知ホストの 404 はどちらも CSP を持たない）。
    const response = await onRequest(pagesContext(new Request(`${SANDBOX_ORIGIN}/`)));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  });

  it('管理画面用ホストを admin 側へ渡す（#356 / 2.4.1）', async () => {
    // **カスタムドメインは 3 本になる**（`docs/admin-host.md`）。この薄いラッパが
    // Host をそのまま渡していないと、**本番で admin ホストだけが未知のホストになる**
    // ——ローカルの `SELF.fetch` は通るので、ここを見ないと配備まで気づけない。
    //
    // 未ログインなので 404 だが、**未知のホストの 404 とは本文が違う。**
    const response = await onRequest(pagesContext(new Request(`${ADMIN_ORIGIN}/`)));
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain('unknown host');
    expect(JSON.parse(body)).toEqual({ error: 'not found', path: '/' });
  });

  it('未知のホストを 404 にする', async () => {
    const response = await onRequest(pagesContext(new Request('https://example.com/')));
    expect(response.status).toBe(404);
  });

  it('バインディングがワーカーまで届く', async () => {
    // context.env をそのまま渡せていないと、D1 / R2 を使う経路がここで落ちる。
    const response = await onRequest(pagesContext(new Request(`${APP_ORIGIN}/__dev/health`)));
    const body = (await response.json()) as { d1: { ok: boolean }; r2: { ok: boolean } };
    expect(body.d1.ok).toBe(true);
    expect(body.r2.ok).toBe(true);
  });

  it('MCP の認可の部品へ ctx を渡す（#696。渡さないと部品が ctx.props へ代入できず 500 になる）', async () => {
    // **トークンの無い `/mcp` は 401 と `WWW-Authenticate`**（部品が返す）。ここが 500 なら、入口が ctx を渡していない。
    const response = await onRequest(pagesContext(new Request(`${APP_ORIGIN}/mcp`, { method: 'POST' })));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('MCP の認可の口はアプリ用ホストだけに載る（sandbox と admin には無い。#696）', async () => {
    for (const origin of [SANDBOX_ORIGIN, ADMIN_ORIGIN]) {
      const response = await onRequest(
        pagesContext(new Request(`${origin}/.well-known/oauth-authorization-server`)),
      );
      expect(response.status, origin).toBe(404);
    }
    const app = await onRequest(pagesContext(new Request(`${APP_ORIGIN}/.well-known/oauth-authorization-server`)));
    expect(app.status).toBe(200);
  });
});
