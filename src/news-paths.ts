/**
 * 運営からのお知らせの綴り（2.3.1 / #375）。
 *
 * ## なぜ値だけの葉に置くのか
 *
 * **外枠（`src/html.ts`）がお知らせの一覧の綴りを要る。** 記事の画面（`/news/<id>`）の
 * パンくずは、親として一覧（`/news`）を出す（2.3.10）。画面のモジュール（`src/news.ts`）は
 * `siteHead` を呼ぶので、**外枠がそこから借りると必ず循環参照になる**（`src/html.ts` の冒頭が
 * 名指しで禁じている）。`src/legal-paths.ts` / `src/account-paths.ts` と同じ形である。
 *
 * ## `src/paths.ts` に置かない
 *
 * **あちらはオーケストレータ Lambda の束に入る**（#328 / #336）。お知らせの綴りは Lambda が
 * 1 度も読まないので、置けば束の `CodeSha256` だけが変わって本番の配備が止まる。
 * このファイルを import するのは `src/html.ts` と `src/news.ts` だけで、どちらも束に入らない。
 */

/** お知らせの一覧のパス。 */
export const NEWS_PATH = '/news';

/**
 * 記事 1 本のパスを組み立てる。
 *
 * **記事の id は `src/news-articles.ts` の静的な定義にしか無い**ので、ここへ来る値は
 * 利用者の入力ではない。綴りの形（英小文字・数字・`-`）は `test/news.test.ts` が全記事で見る。
 *
 * @param id 記事の id
 * @returns 記事のパス
 */
export function newsArticlePath(id: string): string {
  return `${NEWS_PATH}/${id}`;
}
