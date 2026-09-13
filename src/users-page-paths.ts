/**
 * 作者ページの経路のパス（#330 / 仕様 2.3.1）。
 *
 * 置く基準は `src/works-paths.ts` と同じである（提供する側と、そこへ送り返す側が
 * 別モジュールになるもの）。
 *
 * # なぜ `src/paths.ts` へ置かないのか
 *
 * **`src/paths.ts` はオーケストレータ Lambda の束に入る**（#336 / `src/paths.ts` の冒頭）。
 * 束は使われていない輸出を落とすが、**落とせるのは副作用が無いと示せる値だけ**であり、
 * 別の定数を参照する式（テンプレートリテラルやメソッド呼び出し）は残る。Lambda が
 * 一度も読まない値のために `CodeSha256` が変わり、#241 の関門が Worker の配備を止める
 * ——**同じ形の停止は 3 回起きている**（#266 / #283 / #336）。
 *
 * このモジュールを import するのは `src/users-page.ts`（提供する側）と、
 * `src/work-card.ts` / `src/work-page.ts`（作者名から送り返す側）だけで、
 * **どれも束に入らない**（`scripts/check-orchestrator-bundle.sh` が機械で押さえている
 * ——束に `siteHead` を宣言するモジュールが入れば赤くなる）。
 *
 * # なぜ値だけの葉なのか
 *
 * 画面を提供するのは `src/users-page.ts` で、そこへ送り返すのは作品カード
 * （`src/work-card.ts`）と作品ページ（`src/work-page.ts`）である。**作者ページの側は
 * カードを並べるために `src/work-card.ts` を import する**ので、綴りをどちらかの
 * 画面モジュールに置くと循環参照になる（`src/works-paths.ts` が `PUBLIC_WORKS_PATH` と
 * `MY_WORKS_PATH` について書いているのと同じ形）。
 */
import { handlePagePath, isStoredHandle } from './handle-paths.js';

/**
 * 作者ページの接頭辞（2.3.1 / #330）。
 *
 * **`/users/` にした。** 仕様 2.3.1 のサイトマップが `/users/<user_id>` と定めており、
 * 綴りの正本はあの表である。
 *
 * 末尾の `/` は前方一致の規約である（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 * **`/user/` にしない**——作品が `/works/`（複数形）なので、語形を揃える。
 */
export const AUTHOR_PAGE_PREFIX = '/users/';

/**
 * 作者ページのパスを組み立てる。
 *
 * **`encodeURIComponent` を通す。** `users.id` は `crypto.randomUUID()` の出力である
 * （`src/auth/google.ts`）が、**この関数が受け取る値がそうであることは、型の上でも
 * 実行時にも保証されていない。** 組み立てた値は `href` 属性へそのまま入るので、
 * `"` を 1 文字含むだけで属性を閉じられる。**呼ぶ側の注意ではなく、組み立てる側で
 * 閉じる**（`src/work-card.ts` が「D1 の値を HTML へ入れる場所は題名と作者名の 2 つに
 * 限られる」と書いている前提を、ここで壊さないため）。
 *
 * 受け取り側（`src/users-page.ts`）は `decodeURIComponent` で戻す。
 *
 * @param userId 利用者 id（`users.id`）
 * @returns アプリ用ホスト上の絶対パス
 */
export function authorPagePath(userId: string): string {
  return `${AUTHOR_PAGE_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * 作者ページへのリンクの行き先を決める（#381 / 5.10）。**ハンドル名があれば `/@handle`、無ければ
 * `/users/<user_id>`。**
 *
 * **作者名のリンクを出す場所（作品カード・作品ページ）は、すべてこれを通す。** 片方だけが `/@handle` を
 * 知っていると、同じ作者への導線が画面によって違う URL になる（どちらも開けるが、共有される綴りが割れる）。
 *
 * **ハンドル名は実行時の値を見る**（{@link isStoredHandle}）。一覧の行は Cache API を通った JSON で、
 * 配備の直後の最大 60 秒はハンドル名の列を選んでいなかった頃の行が返りうる（`src/games.ts` の
 * `PublicWork.authorId` と同じ窓）。**欠けていても形が崩れていても `/users/<user_id>` へ倒す**——
 * そちらはハンドル名があれば `/@handle` へ 301 で送るので、行き先は同じ画面になる。
 *
 * @param userId 利用者 id（`users.id`）
 * @param handle いま使っているハンドル名（無ければ null。実行時には何が来てもよい）
 * @returns アプリ用ホスト上の絶対パス
 */
export function authorPagePathFor(userId: string, handle: unknown): string {
  return isStoredHandle(handle) ? handlePagePath(handle) : authorPagePath(userId);
}
