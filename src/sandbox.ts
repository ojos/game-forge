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
 */
import { deliverSandboxRequest } from './sandbox-delivery.js';

/**
 * サンドボックス用ホストへのリクエストに対するレスポンスを返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 配信レスポンス（CSP `sandbox` ヘッダ付き）
 */
export async function handleSandboxRequest(request: Request, env: Env): Promise<Response> {
  return await deliverSandboxRequest(request, env);
}
