/**
 * 利用者の MCP の許可（grant）を読む・消す（#696 / 仕様 5.15）。**Pages と cleanup の Worker の両方から呼ぶ。**
 *
 * - Pages: 「接続中のアプリ」のタブの一覧と解除（`src/account-apps.ts`）、退会の口（`src/account-withdrawal.ts`）
 * - cleanup の Worker: 退会の完了の段（`src/withdrawal-purge.ts`）。**押した要求が許可を消せなかった退会や、cron が代わりに
 *   確定させた退会でも、完了の印を立てる前に必ず消す**ためである
 *
 * **このモジュールは Pages の経路表・部品の設定（`src/oauth-provider.ts`）に依存しない。** cleanup の Worker は KV の
 * `OAUTH_KV` だけを持ち、アプリのホスト名も D1 の画面の部品も持たない。部品の道具（`getOAuthApi`）は、一覧と解除に要らない
 * 設定（resource・scope・寿命）を省いた最小の設定で組む——**KV の鍵の形（`grant:<利用者の id>:…`）をこちらで書き写さない**
 * （部品の版を上げたときに、ここだけが古い形を消しに行く形を作らない）。
 */
import type { GrantSummary, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { AUTHORIZE_PATH, MCP_PATH, TOKEN_PATH } from './oauth-paths.js';

/** KV の list 1 回で読む許可の数（KV の list の既定の上限と同じ）。 */
export const GRANT_PAGE_SIZE = 100;

/**
 * 一覧で追うページの上限（**50 ページ＝ 5,000 件**）。
 *
 * **cursor は最後まで追う**が、無限には追わない——1 回の要求の KV の読み取り（list 1 回と、許可 1 件ごとの get）の枠を
 * 食い潰さないための上限である。1 人の許可がここまで溜まる形は想定しない（DCR のクライアントは接続のたびに登録し直すが、
 * 同じクライアントの前の許可は部品が消す）。**打ち切ったら呼ぶ側に知らせる**（{@link GrantListing} の `truncated`）。
 */
export const MAX_GRANT_PAGES = 50;

/** 一覧の結果。 */
export interface GrantListing {
  readonly items: readonly GrantSummary[];
  /** {@link MAX_GRANT_PAGES} で打ち切ったか（まだ続きがある）。 */
  readonly truncated: boolean;
}

/**
 * 一覧と解除だけに使う部品の道具を組む。
 *
 * @param kv `OAUTH_KV`
 * @returns 部品の道具
 */
export function grantHelpers(kv: KVNamespace): OAuthHelpers {
  const notUsed = { fetch: () => new Response(null, { status: 404 }) };
  return getOAuthApi(
    {
      apiRoute: MCP_PATH,
      apiHandler: notUsed,
      defaultHandler: notUsed,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
    },
    { OAUTH_KV: kv },
  );
}

/**
 * 利用者の許可を、cursor を追って読む（{@link MAX_GRANT_PAGES} まで）。
 *
 * @param helpers 部品の道具
 * @param userId 利用者の id
 * @param stopWhen 見つけたら読むのをやめる条件（無ければ最後まで読む）
 * @returns 許可と、打ち切ったか
 */
export async function listAllUserGrants(
  helpers: OAuthHelpers,
  userId: string,
  stopWhen?: (grant: GrantSummary) => boolean,
): Promise<GrantListing> {
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_GRANT_PAGES; page += 1) {
    const result = await helpers.listUserGrants(userId, {
      limit: GRANT_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...result.items);
    if (stopWhen !== undefined && result.items.some(stopWhen)) {
      return { items, truncated: false };
    }
    cursor = result.cursor;
    if (cursor === undefined) {
      return { items, truncated: false };
    }
  }
  return { items, truncated: true };
}

/**
 * 利用者の許可をすべて消す（その許可から出たアクセストークンとリフレッシュトークンも、部品の `revokeGrant` が消す）。
 *
 * **一覧を 1 周してから消す**——消しながら cursor で送ると、KV の list の結果がずれうる。上限（{@link MAX_GRANT_PAGES}）で
 * 打ち切った場合は、消した後にもう 1 周する（消した分だけ一覧が縮むので、残りが先頭へ来る）。
 *
 * @param kv `OAUTH_KV`
 * @param userId 利用者の id
 * @returns 消した許可の数
 */
export async function revokeAllUserGrants(kv: KVNamespace, userId: string): Promise<number> {
  const helpers = grantHelpers(kv);
  let revoked = 0;
  for (;;) {
    const listing = await listAllUserGrants(helpers, userId);
    for (const grant of listing.items) {
      await helpers.revokeGrant(grant.id, userId);
      revoked += 1;
    }
    if (!listing.truncated || listing.items.length === 0) {
      return revoked;
    }
  }
}

/**
 * 利用者の許可が 1 件も残っていないかを確かめる（list 1 回）。
 *
 * @param kv `OAUTH_KV`
 * @param userId 利用者の id
 * @returns 残っていなければ true
 */
export async function userGrantsGone(kv: KVNamespace, userId: string): Promise<boolean> {
  const page = await grantHelpers(kv).listUserGrants(userId, { limit: 1 });
  return page.items.length === 0 && page.cursor === undefined;
}
