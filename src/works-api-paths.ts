/**
 * 自作の作品を機械が読める口の綴り（#694 / M18-1）。
 *
 * **値だけの葉に置く。** 生成（`src/generate.ts`）と推敲（`src/revise.ts`）が 202 の応答に
 * 状況の口の URL を載せるためにこの綴りを読む。`src/generate.ts` はオーケストレータ Lambda の
 * 束に入るので、口の本体（`src/works-api.ts`。作品ページのモジュールを読む）を import すると
 * 束が太る（`src/paths.ts` の冒頭）。**綴りだけをここへ分ける**（`src/work-edit-paths.ts` と同じ形）。
 */

/** 自作の一覧（`GET`）。 */
export const MY_WORKS_API_PATH = '/api/me/works';

/**
 * 1 件の口の接頭辞。**末尾の `/` は前方一致の規約である**（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 */
export const MY_WORK_API_PREFIX = `${MY_WORKS_API_PATH}/`;

/** ソースの口の末尾（`/api/me/works/<id>/source`）。 */
export const MY_WORK_SOURCE_SUFFIX = '/source';

/**
 * 1 件の詳細と状況の口のパス。
 *
 * @param gameId 作品 id
 * @returns パス
 */
export function myWorkApiPath(gameId: string): string {
  return `${MY_WORK_API_PREFIX}${gameId}`;
}

/**
 * ソースの口のパス。
 *
 * @param gameId 作品 id
 * @returns パス
 */
export function myWorkSourceApiPath(gameId: string): string {
  return `${myWorkApiPath(gameId)}${MY_WORK_SOURCE_SUFFIX}`;
}
