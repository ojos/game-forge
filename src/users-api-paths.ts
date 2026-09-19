/**
 * ユーザー情報を機械が読める口の綴り（#700 / M19-3。仕様 5.14）。
 *
 * **値だけの葉に置く**（`src/works-api-paths.ts` と同じ形）。口の本体（`src/users-api.ts`）は作者ページの
 * モジュールと残枠の判定を読むので、綴りだけが要る側（公開作品の一覧の口が `authorId` からこの口を
 * 指すとき。#699）に、それらを連れて来させない。
 */

/** 自分の情報（`GET`）。**完全一致である**（`/api/me/works` とは別の口）。 */
export const ME_API_PATH = '/api/me';

/**
 * 作者の公開プロフィールの接頭辞。**末尾の `/` は前方一致の規約である**（`src/routes.ts` の
 * `findMalformedPrefixRoutes`）。
 */
export const USER_API_PREFIX = '/api/users/';

/**
 * 作者の公開プロフィールの口のパス。
 *
 * **id をパーセント符号化する**（作者ページの id は UUID に決め打ちしていない。`src/users-page.ts` の
 * `MAX_USER_ID_LENGTH`）。
 *
 * @param userId 利用者 id
 * @returns パス
 */
export function userApiPath(userId: string): string {
  return `${USER_API_PREFIX}${encodeURIComponent(userId)}`;
}
