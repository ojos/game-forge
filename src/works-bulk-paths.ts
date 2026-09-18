/**
 * 「あなたの作品」の一括操作（#666）の綴り。**値だけを持つ葉である。**
 *
 * **`src/paths.ts` に置かない。** あちらはオーケストレータ Lambda の束に入り、値が 1 つ増えても
 * `CodeSha256` が変わって main の deploy が止まる（`src/works-paths.ts` の冒頭。#266 / #283 / #328）。
 * **`src/works-paths.ts` にも足さない**——エディットページ（#664）の綴りを足す別のレーンと同じ行を
 * 触らないためである（どちらも値だけの葉なので、分けても読む側の手間は増えない）。
 */
import { MY_WORKS_PATH } from './works-paths.js';

/**
 * 一括操作の確認画面（`GET`）。**「あなたの作品」の子に置く**（パンくずが「あなたの作品」へ戻れる。
 * `src/html.ts` の `BREADCRUMB_PARENTS`）。
 *
 * **完全一致の経路である。** 作品ページは `/works/` の前方一致で登録されているが、経路表は完全一致を
 * 先に見る（`src/routes.ts`）ので、`/works/mine/bulk` が作品 id として読まれることは無い。
 */
export const MY_WORKS_BULK_PATH = `${MY_WORKS_PATH}/bulk`;

/**
 * 一括操作を実行する口（`POST`）。**`/api/` の下に置く**（画面の経路から外れ、`/__dev/pages` の
 * 導出にも乗らない。`src/page-paths.ts` の `NON_PAGE_PREFIXES`）。
 */
export const WORKS_BULK_API_PATH = '/api/works/bulk';

/** 操作の種類を運ぶ項目名（確認画面のクエリと、実行の本文の両方）。 */
export const WORKS_BULK_ACTION_FIELD = 'action';

/**
 * 対象の作品 id を運ぶ項目名（同じ名前を繰り返す）。**1 件ずつの口（`game_id`）と同じ綴りにする**
 * （`src/work-delete.ts` の `WORK_DELETE_GAME_ID_FIELD`・`src/paths.ts` の `PUBLISH_GAME_ID_FIELD`）。
 */
export const WORKS_BULK_GAME_ID_FIELD = 'game_id';
