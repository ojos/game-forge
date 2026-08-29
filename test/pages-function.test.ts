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
  return { request, env, params: {}, data: {} } as unknown as Parameters<typeof onRequest>[0];
}

describe('Pages Functions の入口（#71）', () => {
  it('アプリ用ホストをアプリ側へ渡す', async () => {
    // `/` は #89 で公開トップ（src/home.ts）になった。アプリ側にしか無い見出しで判定する。
    const response = await onRequest(pagesContext(new Request(`${APP_ORIGIN}/`)));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Game Forge</h1>');
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
});
