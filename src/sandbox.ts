/**
 * サンドボックス用ホスト（本番: `sandbox.game-forge.ojos.jp`）の入口。
 *
 * **このファイルは入口だけを持つ。** 配信の中身は `src/sandbox-delivery.ts`、
 * CSP は `src/sandbox-csp.ts`、ローダー文書は `src/sandbox-loader.ts` が持つ。
 *
 * # M0.5-3 から M4-3 で変わったこと
 *
 * M0.5-3 の時点では、ここは**ヘッダの形だけ**を確定させるプレースホルダを返していた
 * （実際の `.wasm.br` がまだ無かったため）。#28 で本物の配信が入り、次の 2 点が変わった。
 *
 * - `request` と `env` を受け取るようになった。**どの作品を配信するか**は URL とデータ
 *   ベースを見なければ決まらない。呼び出し側（`src/index.ts`）も合わせて直してある。
 * - CSP が定数から**レスポンスごとの組み立て**へ変わった。`connect-src` に許す URL が
 *   作品ごとに違うためで、その理由と 7.2 との差分は `src/sandbox-csp.ts` にある。
 *   **`connect-src 'none'` は緩めた。** 緩めた事実をこの位置にも残しておく。
 *
 * # 変わっていないこと
 *
 * - CSP `sandbox allow-scripts`（7.2 必須要件 1）を全レスポンスに付ける。
 * - **`allow-same-origin` を決して付けない。**
 * - **cookie を一切設定しない**（7.2 必須要件 3。この経路に cookie を発行する口が無い）。
 *
 * # アイコン画像もここから配る（#380 / 仕様 7.2 の実装注記）
 *
 * `/avatars/<user_id>.webp` は利用者が上げた画像で、**アプリのオリジンで配らない**
 * （`src/avatar-delivery.ts`）。**作品の配信（`/p/` / `/g/`）とは接頭辞で分ける**——あちらの
 * URL の解釈（`parseSandboxPath`）に画像の綴りを混ぜない。
 */
import { AVATAR_PATH_PREFIX } from './avatar-paths.js';
import { deliverAvatar, isAvatarPath } from './avatar-delivery.js';
import { ROBOTS_PATH, sandboxRobotsResponse } from './robots.js';
import { SANDBOX_DELIVERY_PREFIXES, deliverSandboxRequest } from './sandbox-delivery.js';

/**
 * サンドボックス用ホストが受ける接頭辞のすべて（作品の配信 `/p/` `/g/` と、アイコン `/avatars/`）。
 *
 * **ハンドル名の予約語を導くために輸出する**（#381 / 5.10。`src/app.ts` が `src/handle.ts` の
 * `reservedHandlesOf` へ渡す）。**接頭辞を足すときは、この配列へも足すこと**（下の振り分けと同じ場所に
 * 置いてあるので、足した人の目に入る）。
 */
export const SANDBOX_PATH_PREFIXES: readonly string[] = [...SANDBOX_DELIVERY_PREFIXES, AVATAR_PATH_PREFIX];

/**
 * サンドボックス用ホストへのリクエストに対するレスポンスを返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 配信レスポンス（CSP `sandbox` ヘッダ付き）
 */
export async function handleSandboxRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  // クローラへの意思表示（#594）。**配信の振り分けより先に見る**——`parseSandboxPath` は
  // `/p/` `/g/` で始まらない綴りを 404 にするので、後ろに置くと届かない。
  if (pathname === ROBOTS_PATH) {
    return sandboxRobotsResponse(request);
  }
  if (isAvatarPath(pathname)) {
    return await deliverAvatar(request, env);
  }
  return await deliverSandboxRequest(request, env);
}
