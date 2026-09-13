/**
 * サンドボックス用ホストでアイコン画像を配る（`GET /avatars/<user_id>.webp`。#380 / 仕様 7.2・2.3.8）。
 *
 * ## なぜサンドボックス用ホストなのか
 *
 * **利用者が上げた内容を、アプリのオリジンで配らない**（5.10 / 7.2）。形式の判定と再エンコードを
 * すり抜けた 1 枚があっても、それが解釈されるのはセッションの cookie を持たない別のオリジンである。
 * **アプリ用ホストの経路表（`src/app.ts`）にはこの経路を登録しない**（`test/avatar.test.ts` が
 * アプリ用ホストで 404 になることを見る）。**外部状態の変更は要らない**——サンドボックス用ホストは
 * 既に本番に立っている。
 *
 * ## 応答の規律（`/g/` の資材と同じ方針）
 *
 * - **CSP は `src/sandbox-csp.ts` のものを付ける**（`sandbox allow-scripts` / `default-src 'none'`。
 *   画像を文書として直接開かれても、スクリプトは不透明オリジンに閉じ、どこへも取得できない）
 * - **`Content-Type` を固定する**（`image/webp`。R2 に何が入っていても推測させない）と `nosniff`
 * - **cookie を読まず、発行しない**（7.2 必須要件 3）
 * - **D1 を読まない**——R2 の 1 キーだけで決まる（ヘッダのアバターが全画面から来るので、画面の
 *   数だけ D1 を読む形にしない）
 *
 * ## キャッシュ（仕様 2.3.8。Pages Functions の要求数を増やさない）
 *
 * | 要求 | `cache-control` | 理由 |
 * |---|---|---|
 * | `?v=<avatar_set_at>` が R2 の版と一致 | `public, max-age=31536000, immutable` | **URL が変わらない限り中身が変わらない**（設定のたびに `avatar_set_at` が進む） |
 * | `?v=` が無い（ヘッダ）・一致しない | `public, no-cache` と `ETag` | 版を知らない要求に長いキャッシュを付けると、差し替えが見えない。**再検証は 304 で本文を送らない** |
 * | 無い（id の綴りは正しい） | **透明な 1px の画像を 200 で**、`public, no-cache` と固定の `ETag` | 下の「無いアイコンに 404 を返さない」 |
 * | id の綴りが違う | `no-store` の 404 | 画像の URL ではない |
 *
 * ## 無いアイコンに 404 を返さない
 *
 * **ヘッダのアバターは、設定していない利用者にも同じ URL で画像を求める**（D1 を読まないので、設定の
 * 有無を知らない。`src/html.ts`）。404 を返すと、**Chromium は `alt=""` の `<img>` にも壊れた画像の印を
 * 描く**（実ブラウザで確かめた）。**透明な 1px の WebP を返せば、下の既定の図形（CSS の円）がそのまま
 * 見える。** 付けた直後に古い透明な画像が残らないよう、これも再検証（`no-cache`）にする——`ETag` が
 * 本物の画像の値に替わるので、次の要求で 200 と本物が返る。
 *
 * **版の一致は R2 のメタデータ（`setAt`）で確かめる**（`src/avatar.ts` が書く）。一致しない `?v=`
 * （古いカードのキャッシュ・手で作った URL）に `immutable` を付けると、**その URL に今の画像が
 * 1 年張り付く**。一致しないときは再検証に倒す。
 */
import {
  AVATAR_FILE_SUFFIX,
  AVATAR_MEDIA_TYPE,
  AVATAR_PATH_PREFIX,
  AVATAR_USER_ID_PATTERN,
  AVATAR_VERSION_QUERY,
  avatarObjectKey,
} from './avatar-paths.js';
import { sandboxCsp } from './sandbox-csp.js';

/** この経路が受け付けるメソッド（`src/sandbox-delivery.ts` と同じ）。 */
const ALLOWED_METHODS = ['GET', 'HEAD'] as const;

/** 版の一致した要求に付けるキャッシュ（`/g/` の不変資材と同じ値）。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** 版を知らない要求に付けるキャッシュ（毎回の再検証）。 */
const REVALIDATE_CACHE = 'public, no-cache';

/**
 * アイコンが無いときに返す、透明な 1 × 1 の WebP（可逆。34 バイト。sharp で作って中身を確かめた）。
 *
 * `test/avatar.test.ts` が、これが WebP の 1 × 1 として読めることを確かめる。
 */
const TRANSPARENT_WEBP_BASE64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

/** 透明な画像の `ETag`（本物の画像の `ETag` と衝突しない綴り）。 */
const TRANSPARENT_ETAG = '"gf-avatar-none"';

/**
 * パスがアイコンの配信を指しているか（**接頭辞だけを見る**。綴りの検査は {@link deliverAvatar}）。
 *
 * @param pathname `URL#pathname`
 * @returns アイコンの配信なら true
 */
export function isAvatarPath(pathname: string): boolean {
  return pathname.startsWith(AVATAR_PATH_PREFIX);
}

/**
 * パスから利用者の id を取り出す（綴りが合わなければ null）。
 *
 * @param pathname `URL#pathname`
 * @returns 利用者の id
 */
export function avatarUserIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(AVATAR_PATH_PREFIX) || !pathname.endsWith(AVATAR_FILE_SUFFIX)) {
    return null;
  }
  const id = pathname.slice(AVATAR_PATH_PREFIX.length, pathname.length - AVATAR_FILE_SUFFIX.length);
  return AVATAR_USER_ID_PATTERN.test(id) ? id : null;
}

/**
 * 応答の見出しを作る。
 *
 * @param extra 足す見出し
 * @returns 見出し
 */
function avatarHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    // **画像の応答にも同じ CSP を付ける**（モジュール冒頭）。取得も埋め込みも許さない。
    'content-security-policy': sandboxCsp({ scriptUrl: null, connectUrl: null, frameAncestorOrigin: null }),
    'x-content-type-options': 'nosniff',
    ...extra,
  });
}

/**
 * 画像ではない応答（404 / 405）。
 *
 * @param status HTTP の状態
 * @param message 本文
 * @param extra 足す見出し
 * @returns 応答
 */
function avatarError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, {
    status,
    headers: avatarHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }),
  });
}

/**
 * アイコンが無いときの応答（透明な 1 × 1。モジュール冒頭の「無いアイコンに 404 を返さない」）。
 *
 * @param request 受信したリクエスト
 * @returns 応答
 */
function transparentAvatar(request: Request): Response {
  const headers = avatarHeaders({
    'content-type': AVATAR_MEDIA_TYPE,
    'cache-control': REVALIDATE_CACHE,
    etag: TRANSPARENT_ETAG,
  });
  if (request.headers.get('if-none-match') === TRANSPARENT_ETAG) {
    return new Response(null, { status: 304, headers });
  }
  const binary = atob(TRANSPARENT_WEBP_BASE64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

/**
 * アイコン画像を配る。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 応答
 */
export async function deliverAvatar(request: Request, env: Env): Promise<Response> {
  if (!(ALLOWED_METHODS as readonly string[]).includes(request.method)) {
    const allow = ALLOWED_METHODS.join(', ');
    return avatarError(405, `この経路は ${allow} だけを受け付けます。`, { allow });
  }
  const url = new URL(request.url);
  const userId = avatarUserIdFromPath(url.pathname);
  if (userId === null) {
    return avatarError(404, 'アイコンが見つかりません。');
  }

  // **条件付きの取得を R2 に任せる**（`If-None-Match` が一致すれば本文の無い R2Object が返る）。
  const object = await env.BUCKET.get(avatarObjectKey(userId), { onlyIf: request.headers });
  if (object === null) {
    return transparentAvatar(request);
  }

  const version = url.searchParams.get(AVATAR_VERSION_QUERY);
  const matched = version !== null && version === object.customMetadata?.['setAt'];
  const headers = avatarHeaders({
    // **固定する**（モジュール冒頭）。R2 の httpMetadata を写さない。
    'content-type': AVATAR_MEDIA_TYPE,
    'cache-control': matched ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
    etag: object.httpEtag,
  });

  if (!('body' in object)) {
    // `onlyIf` が効いた（手元のキャッシュが最新）。
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
