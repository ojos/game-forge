/**
 * 作者のいまのハンドル名を、一覧と作品ページの SQL で引く断片（#381 / 5.10）。
 *
 * # なぜ断片を 1 つにするのか
 *
 * **`PublicWork` を組み立てる経路は 5 つある**（`src/games.ts` の一覧 2 本・`src/home-feed.ts` の公式サンプル・
 * `src/liked-works.ts`・`src/work-search.ts`）に、作品ページ（`src/work-page.ts`）を加えた 6 か所が作者名の
 * リンクを出す。**条件（`released_at is null`）を 6 か所へ書き写すと、1 か所だけが予約中の旧ハンドル名を
 * 引く形で壊れる**（その作品カードだけが、90 日後に 404 になるリンクを出す）。
 *
 * # 結合ではなく相関副問い合わせにする
 *
 * **`left join` を足すと、既存の一覧の計画に表が 1 つ増える。** 副問い合わせなら、引く行が決まった後に
 * 1 行ずつ部分索引（`handles_user_current_idx`）を引くだけで、`games` と `users` の読み方は変わらない
 * （部分索引が別の問い合わせの計画を奪う件。`docs/handoff.md` 4 章）。**引くのは頁に載る件数ぶんだけ**である。
 *
 * # なぜ `src/handle.ts` に置かないのか
 *
 * **`src/games.ts` はオーケストレータ Lambda の束に入る**（`src/users-page-paths.ts` の冒頭）。ここは import を
 * 持たない関数 1 つにして、束が使わなければ落ちる形に保つ。
 */

/** ハンドル名の表（`migrations/` の user_handles。`src/handle.ts` の `HANDLES_TABLE` と同じ綴り）。 */
const HANDLES = 'handles';

/**
 * 作者のいまのハンドル名を選ぶ列の式（`... as author_handle`）。
 *
 * **材料は呼び出し側が書いた列名だけで、利用者の入力を入れないこと**（束縛値ではなく SQL の綴りになる）。
 *
 * @param authorIdColumn 作者の利用者 id の列（例: `g.author_id`）
 * @returns 選ぶ列の式（別名 `author_handle` 付き）
 */
export function authorHandleColumnSql(authorIdColumn: string): string {
  return `(select hh.handle from ${HANDLES} hh where hh.user_id = ${authorIdColumn} and hh.released_at is null) as author_handle`;
}
