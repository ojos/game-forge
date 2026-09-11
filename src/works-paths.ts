/**
 * 作品の一覧に関わる経路のパス（#328）。
 *
 * 置く基準は `src/paths.ts` と同じである（提供する側と送り返す側が別モジュールになるもの）。
 * **それでも `src/paths.ts` に置かないのは、あちらがオーケストレータ Lambda の束に入るから**
 * である。
 *
 * # なぜ `src/paths.ts` から分けたのか
 *
 * **#328 はこの 2 つを `src/paths.ts` に置き、本番配備を止めた**（2026-09-05）。
 * `src/generate.ts` などが `workPagePath` を使うため、`src/paths.ts` は Lambda の束に入る。
 * 束は使われていない輸出を落とすが、**落とせるのは副作用が無いと示せる値だけ**である。
 * 2 つとも別の定数を参照する式（メソッド呼び出しとテンプレートリテラル）で、束に
 * 残った（#328 の束の `var PUBLIC_WORKS_PATH = WORK_PAGE_PREFIX.slice(0, -1);` と
 * `var MY_WORKS_PATH = ...` で確認した）。**Lambda が一度も読まない値のために
 * `CodeSha256` が変わり**、#241 の関門が Worker の配備を止めた。
 *
 * **同じ形の停止は 3 回目である**（#266 / #283 は `src/work-page.ts` 経由。`src/paths.ts` の
 * `WORK_PAGE_PREFIX` を参照）。**画面だけが読む綴りは、Lambda が import しないモジュールへ
 * 置く。** このファイルを import するのは `src/works-list.ts` と `src/my-works.ts` だけで、
 * どちらも Lambda の束に入らない。
 */
import { WORK_PAGE_PREFIX } from './paths.js';

/**
 * 公開作品の一覧（2.3.1 / #328）。
 *
 * **`/works` の意味を変えた。** もとは「あなたの作品」（#152）で、いまは公開作品の
 * 一覧である。`/games` を新設すると `作品 = /works/<id>` と `作品の一覧 = /games` で
 * **同じものに綴りが 2 つ**できるため、`/works` のほうを譲った（仕様 2.3.2）。
 *
 * 末尾の `/` を落とすので、経路表には**完全一致**で載る（前方一致の `/works/` とは
 * 鍵が別になる）。
 *
 * # なぜ値だけの葉に置くのか
 *
 * **画面を提供する側（`src/works-list.ts`）と、そこへ送り返す側が別モジュールだから**
 * である。送り返すのは公開トップ（`src/home.ts`）と「あなたの作品」（`src/my-works.ts`）で、
 * **後者は逆向きにも参照される**（一覧は移設の案内で `/works/mine` を出す）。
 * 値だけの葉へ置かないと循環参照になる。
 */
export const PUBLIC_WORKS_PATH = WORK_PAGE_PREFIX.slice(0, -1);

/**
 * 「あなたの作品」（5.5 / #152。#328 で `/works` から移した）。
 *
 * **完全一致で登録する。** `src/routes.ts` は完全一致を前方一致より先に見ると定め、
 * 「`/works/` の下に将来 `/works/new` のような固定の経路を足しても、前方一致の経路に
 * 飲み込まれない」と書いている。**その想定していた形が、ここで実際に来た。**
 *
 * 置き場の理由は {@link PUBLIC_WORKS_PATH} と同じである。
 */
export const MY_WORKS_PATH = `${WORK_PAGE_PREFIX}mine`;
