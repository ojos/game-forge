/**
 * いいねの口の綴り（5.8 / #339）。
 *
 * # なぜ `src/paths.ts` に置かないのか
 *
 * **`src/paths.ts` はオーケストレータ Lambda の束に入る**（#336）。束に残った値が
 * 1 つ増えるだけで Lambda の `CodeSha256` が変わり、#241 の関門が本番配備を止める
 * （同じ形の停止を 3 回踏んでいる。`src/works-paths.ts` の冒頭）。**いいねの綴りは
 * Lambda が一度も読まない**ので、Lambda が import しないこの葉へ置く。
 *
 * # なぜ `src/likes.ts` に置かないのか
 *
 * **口を提供する側（`src/likes.ts`）と、フォームを出す側（作品ページ。M9-8）が別
 * モジュールになる。** 作品ページが窓口の実装ごと import すると、画面の束に DO の
 * 呼び出しが入り、「Pages 側がいいねを読み書きするのは `src/likes.ts` だけ」（5.8）の
 * 境目が import の上で読めなくなる。綴りだけを値の葉に出す。
 *
 * **値はすべてリテラルにする**（別の定数を参照する式にしない）。この葉が将来どこかの
 * 束へ入っても、使われない値は落とせる形に保つ（`src/paths.ts` の冒頭の規約）。
 */

/**
 * いいねを付ける口（5.8）。**冪等**（既に押していれば何もしない）。
 *
 * **取り消しと 1 つの口に畳まない**（`src/paths.ts` の `RESTORE_PATH` と同じ理由——
 * 結果が違う操作を本文の推測で分けない）。
 */
export const LIKE_PATH = '/api/like';

/** いいねを取り消す口（5.8）。**冪等**（押していなければ何もしない）。 */
export const LIKE_CANCEL_PATH = '/api/like/cancel';

/**
 * {@link LIKE_PATH} の本文で作品 id を載せる項目名。
 *
 * **口ごとに別の定数にする**（5.8。`OGP_RECAPTURE_GAME_ID_FIELD` と同じ扱い）。値が
 * 同じ綴りでも、別の口の定数に相乗りさせない——片方の口の本文の形を変えた日に、
 * もう片方が黙って巻き込まれる。
 */
export const LIKE_GAME_ID_FIELD = 'game_id';

/** {@link LIKE_CANCEL_PATH} の本文で作品 id を載せる項目名（{@link LIKE_GAME_ID_FIELD} と同じ扱い）。 */
export const LIKE_CANCEL_GAME_ID_FIELD = 'game_id';
