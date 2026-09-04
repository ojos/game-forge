/**
 * 複数のモジュールが参照する経路のパス。
 *
 * 経路のパスは、原則としてそれを提供するモジュールが持つ（`src/auth/google.ts` の
 * `LOGIN_PATH` など）。**このファイルに置くのは「提供する側と、そこへ送り返す側が
 * 別モジュールになるもの」だけ**である。
 *
 * `SIGNUP_PATH` がそれにあたる。画面を提供するのは `src/signup.ts` だが、認証の
 * コールバック（`src/auth/google.ts`）は登録できなかった利用者をここへ戻す。片方が
 * もう片方から import すると、`src/signup.ts` が `startInvitedLogin` を使う向きと
 * 合わせて循環参照になる。値だけを持つ葉のモジュールへ逃がすと、どちらの向きにも
 * 依存が生まれない。
 */

/**
 * 公開トップ（8.1 / #266）。
 *
 * 画面を提供するのは `src/home.ts` だが、全画面共通のヘッダ（`src/html.ts` の
 * `siteHead`）がここへ送り返す。`src/html.ts` は**誰からも借りられる葉**であり、
 * `src/home.ts` はその `siteHead` を使うため、直接 import すると循環参照になる。
 * `SIGNUP_PATH` と同じ理由でこちらへ置く（`src/home.ts` は再輸出するだけ）。
 */
export const HOME_PATH = '/';

/**
 * 作品ページの接頭辞（5.4 / #290）。
 *
 * **`/works/` にした。** サンドボックス側の `/g/`（公開）と `/p/`（プレビュー）と
 * 綴りを分けてある。ログや問い合わせで取り違えないことを優先した
 * （`src/games.ts` の `createPreviewKey` が UUID を避けたのと同じ判断）。
 *
 * 末尾の `/` は前方一致の規約である（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 *
 * # なぜ `src/work-page.ts` から移したのか（#290）
 *
 * **オーケストレータ Lambda の束に、作品ページの実装が丸ごと入っていた。**
 * `src/generate.ts` と `src/mail/generation-notice.ts` が `workPagePath` を
 * 使うためだけに `src/work-page.ts` を import し、そこから `siteFooter` /
 * `siteHead` を通じて画面 4 本が束へ引き込まれていた。
 *
 * その結果、**画面だけを触っても Lambda の `CodeSha256` が変わり**、#241 の関門が
 * 本番配備を止めた（#266 と #283 で 2 回）。パスの綴りは値だけの葉に置き、
 * 画面の実装から切り離す。**この規約の適用例としても素直である**——提供する側
 * （作品ページ）と、そこへ送り返す側（生成・メール）が別モジュールになっている。
 */
export const WORK_PAGE_PREFIX = '/works/';

/**
 * 作品ページのパスを組み立てる。
 *
 * **綴りを持つのはこのモジュールだけである。** 生成の経路（`src/generate.ts`）も
 * 生成画面（`src/generate-page.ts`）もここから取る。3 か所に `/works/` と書くと、
 * 変えたときに片方だけが古くなる。
 *
 * @param gameId 作品 id
 * @returns アプリ用ホスト上の絶対パス
 */
export function workPagePath(gameId: string): string {
  return `${WORK_PAGE_PREFIX}${gameId}`;
}

/** 登録画面（招待コードの入力）。 */
export const SIGNUP_PATH = '/signup';

/** 待機リスト登録後の受け皿（POST-redirect-GET の GET 側）。 */
export const WAITLIST_THANKS_PATH = '/signup/waitlist/thanks';

/**
 * 待機リストへの登録（API）。
 *
 * `/api/*` は確定22 で正とした綴りである。M1 の時点では 9.3 が「API を `/api/*` に
 * 置くなら Pages Functions を使う。ここは M2-1 の実装時に確定する」としていたため
 * `/waitlist` に置いていた（#63）。確定22 でその制約が解けたので寄せた。
 *
 * 登録フォームの `action` と経路の登録が同じ値を指すよう、定数を 1 か所に置く。
 */
export const WAITLIST_PATH = '/api/waitlist';

/**
 * 招待を発行する画面（8.1 / #91）。
 *
 * 画面を提供するのは `src/invite-issuance.ts` だが、公開トップ（`src/home.ts`）が
 * ここへ送る。一方で発行の画面は「トップへ戻る」導線として `HOME_PATH` を参照するため、
 * どちらかがもう片方から import すると循環参照になる。`SIGNUP_PATH` と同じ理由で、
 * 値だけを持つこのモジュールへ逃がす。
 *
 * API 側のパス（`/api/invites`）はここに置かない。参照するのは発行の経路を提供する
 * モジュールだけで、上の条件に当たらない。
 */
export const INVITES_PATH = '/invites';

/**
 * 生成画面（5.2-1 / #128）。
 *
 * 画面を提供するのは `src/generate-page.ts` だが、公開トップ（`src/home.ts`）が
 * ここへ送る。一方で生成画面は「トップへ戻る」導線として `HOME_PATH` を参照するため、
 * どちらかがもう片方から import すると循環参照になる。`INVITES_PATH` と同じ理由で、
 * 値だけを持つこのモジュールへ逃がす。
 *
 * API 側のパス（`/api/generate`）はここに置かない。正は `src/generate.ts` の
 * `GENERATE_PATH` で、画面はそこから import する（上の条件に当たらない）。
 */
export const GENERATE_PAGE_PATH = '/generate';

/**
 * 公開の操作（5.4 / #26）。
 *
 * 経路を提供するのは `src/publish.ts` だが、**試遊画面（`src/work-page.ts`）が
 * 「公開して共有」のフォームの `action` として同じ綴りを要る。** 一方で
 * `src/publish.ts` は公開後の戻り先として `src/work-page.ts` の `workPagePath` を
 * 使うため、どちらかがもう片方から import すると循環参照になる。
 * `SIGNUP_PATH` / `INVITES_PATH` と同じ理由で、値だけを持つこのモジュールへ逃がす。
 */
export const PUBLISH_PATH = '/api/publish';

/**
 * 公開の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。
 *
 * {@link PUBLISH_PATH} と同じ理由でここに置く。**フォームを書く側と、それを読む側が
 * 別モジュールである**以上、綴りの正本も片方の中には置けない。
 */
export const PUBLISH_GAME_ID_FIELD = 'game_id';

/**
 * 中断したままの OGP 撮影を撮り直す操作（5.4 / #235）。
 *
 * 経路を提供するのは `src/ogp-recapture.ts` だが、**作品ページ（`src/work-page.ts`）が
 * 「撮り直す」のフォームの `action` として同じ綴りを要る。** 一方で
 * `src/ogp-recapture.ts` は押したあとの戻り先として `workPagePath` を使うため、
 * どちらかがもう片方から import すると循環参照になる。`PUBLISH_PATH` と同じ理由で
 * ここへ逃がす。
 *
 * **`/api/ogp/callback` と同じパスに畳まない。** あちらは撮影関数が結果を持ってくる
 * 口で、認証は使い捨てトークンである。こちらは**人が押す口**で、認証はセッションと
 * 作者の一致である。**認証の相手が違う 2 つを、本文の形で見分けない**
 * （`RESTORE_PATH` を `REVISE_PATH` から分けたのと同じ理由）。
 */
export const OGP_RECAPTURE_PATH = '/api/ogp/recapture';

/**
 * 撮り直しの対象を指す項目名（フォームの `name` と JSON の鍵の両方）。
 *
 * 値は `PUBLISH_GAME_ID_FIELD` と同じ綴りだが、**別の定数にする**（`REVISE_GAME_ID_FIELD`
 * と同じ扱い）。フォームを書く側と読む側が別モジュールである以上、綴りの正本も
 * 片方の中には置けず、**別の経路の綴りに相乗りさせると、あちらを変えた日にこちらが
 * 黙って壊れる。**
 */
export const OGP_RECAPTURE_GAME_ID_FIELD = 'game_id';

/**
 * 推敲の操作（5.7 / #192）。
 *
 * 経路を提供するのは `src/revise.ts` だが、**作品ページ（`src/work-page.ts`）が
 * 推敲のフォームの `action` として同じ綴りを要る。** 一方で `src/revise.ts` は
 * 推敲を始めたあとの戻り先として `workPagePath` を使うため、どちらかがもう片方から
 * import すると循環参照になる。`PUBLISH_PATH` と同じ理由でここへ逃がす。
 */
export const REVISE_PATH = '/api/revise';

/**
 * 「この版に戻す」（5.7）。
 *
 * **`/api/revise` と同じパスに畳まない。** 畳むと、経路表ではなくハンドラが本文の
 * 項目の有無で「手直しか復元か」を見分けることになる。**費用が出る操作と出ない操作を、
 * 本文の推測で分けない**（前者は 1 回 約 16 円、後者は 0 円である）。
 */
export const RESTORE_PATH = '/api/revise/restore';

/** 推敲の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const REVISE_GAME_ID_FIELD = 'game_id';

/** 差分プロンプトの項目名。 */
export const REVISE_PROMPT_FIELD = 'prompt';

/** 戻したい版の番号の項目名。 */
export const REVISE_SEQ_FIELD = 'seq';

/**
 * フォークの操作（5.3 / #32）。
 *
 * 経路を提供するのは `src/fork.ts` だが、**作品ページ（`src/work-page.ts`）が
 * 「このゲームを改造する」のフォームの `action` として同じ綴りを要る。** 一方で
 * `src/fork.ts` は生まれた子の作品ページへ送り返すために `workPagePath` を使うため、
 * どちらかがもう片方から import すると循環参照になる。`REVISE_PATH` と同じ理由で
 * ここへ逃がす。
 *
 * **`/api/revise` と同じパスに畳まない。** 5.7 の表のとおり、推敲は同じ作品行を
 * 置き換え、フォークは**新しい作品行**を作って `parent_id` を張る。**結果が違う操作を、
 * 本文の項目の有無で見分けない**（`RESTORE_PATH` を分けたのと同じ理由）。
 */
export const FORK_PATH = '/api/fork';

/**
 * フォークの**親**を指す項目名（フォームの `name` と JSON の鍵の両方）。
 *
 * **`game_id` ではなく `parent_id` と綴る**（{@link REVISE_GAME_ID_FIELD} と別の値に
 * する）。推敲の `game_id` は「置き換える対象そのもの」だが、こちらが指すのは
 * **これから作る作品の親**であって、要求が作る作品ではない。同じ綴りにすると、
 * 推敲のフォームを写して作ったフォークのフォームが**動いてしまう**——動いたうえで、
 * 読む側の意味だけが食い違う。
 */
export const FORK_PARENT_ID_FIELD = 'parent_id';

/** 差分プロンプトの項目名（5.3「親のソースコード＋差分プロンプト」）。 */
export const FORK_PROMPT_FIELD = 'prompt';
