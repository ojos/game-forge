/**
 * アイコン画像（#380 / M12-12 / 仕様 5.10・7.2・2.3.8）の綴り——口・フォームの項目名・R2 のキー・配信の URL。
 *
 * **値だけの葉に置く**（`src/account-paths.ts` / `src/profile-paths.ts` と同じ理由）。読むのは
 * 画面（`src/account.ts`）・外枠（`src/html.ts`）・カード（`src/work-card.ts`）・作者ページ
 * （`src/users-page.ts`）・配信（`src/avatar-delivery.ts`）・保存（`src/avatar.ts`）で、**どれもここへ
 * 戻ってこない。** `src/html.ts` が import するので、**ここは何も import しない。**
 *
 * ## 画像はサンドボックス用ホストから配る（7.2）
 *
 * **アプリ用ホストから配らない。** 利用者が上げた内容をアプリと同じオリジンで配ると、形式の判定を
 * すり抜けた 1 枚がアプリのオリジンで解釈される余地を残す（5.10）。サンドボックス用ホストは
 * **利用者の作ったものを別のオリジンで配る**ためにある（`/g/` の作品と同じ考え方）。したがって
 * **画像の URL は必ず絶対 URL である**——スキームとポートは要求から借り、ホストだけを
 * `SANDBOX_HOST` に差し替える（`src/work-page.ts` の `publishedUrl` と同じ組み立て方）。
 *
 * ## R2 のキーは利用者ごとに 1 つに固定する
 *
 * `avatars/<user_id>.webp`。**ヘッダのアバターは画像の版を D1 から引かずに描く**
 * （`src/html.ts` の `headerAvatarUrl` は要求と id だけを見る）ので、URL が利用者の id だけで
 * 決まる必要がある。**未ログインの閲覧では D1 を 1 行も読まない**——`resolveSiteViewer` が
 * D1 を読むのは署名の通った cookie を持つ要求だけで（#518 で退会を見るようになった）、
 * その性質を `test/news.test.ts` / `test/privacy.test.ts` が D1 を壊して確かめている。
 *
 * **差し替え前の画像は `avatars/history/` へ写す。** この接頭辞にだけ R2 のライフサイクル規則
 * （30 日で削除）を置く（`terraform/r2-lifecycle.tf`）。**`avatars/<user_id>.webp` と
 * `avatars/history/...` は接頭辞の上で重ならない**——利用者の id は UUID（16 進とハイフン）で、
 * `history/` の綴りにならない（{@link AVATAR_USER_ID_PATTERN}）。
 */

/** アイコンの保存（API）。**フォームは `multipart/form-data` で送る**（ファイルを載せるため）。 */
export const ACCOUNT_AVATAR_PATH = '/api/account/avatar';

/** アイコンを外す（API）。**画像を載せないので、口を分ける**（本文の形が違う）。 */
export const ACCOUNT_AVATAR_REMOVE_PATH = '/api/account/avatar/remove';

/** フォームの項目名（アイコンのファイル）。 */
export const AVATAR_FILE_FIELD = 'avatar';

/** サンドボックス用ホストで画像を配るパスの接頭辞（末尾の `/` は前方一致の規約）。 */
export const AVATAR_PATH_PREFIX = '/avatars/';

/**
 * 保存する画像の一辺（px）。**中央を正方形に切り抜き、この大きさに縮める**（利用者の決定）。
 *
 * **ここ（値だけの葉）に置く**のは、`src/html.ts` の `<img>` の `width` / `height` にも使うため
 * （`src/avatar.ts` は `src/html.ts` を import するので、あちらに置くと循環する）。**関数側にも
 * この値がある**が、あちらは `terraform/avatar-function.tf` の環境変数から受け取る。突き合わせは
 * `scripts/check-avatar-copies.sh` が行う。
 */
export const AVATAR_OUTPUT_SIZE = 256;

/** 画像の拡張子。**再エンコードの出力は WebP だけである**（`lambda/avatar-encode/`）。 */
export const AVATAR_FILE_SUFFIX = '.webp';

/** 配る画像の `Content-Type`（**固定する**。受け取った形式に合わせない）。 */
export const AVATAR_MEDIA_TYPE = 'image/webp';

/** URL の版を載せる query の名前（`?v=<avatar_set_at>`。仕様 2.3.8）。 */
export const AVATAR_VERSION_QUERY = 'v';

/** 現行の画像の R2 のキーの接頭辞。 */
export const AVATAR_OBJECT_PREFIX = 'avatars/';

/**
 * 差し替え前の画像を写す R2 のキーの接頭辞。
 *
 * **`terraform/r2-lifecycle.tf` の削除規則の接頭辞と同じ値でなければならない。** ずれると、
 * 差し替え前の画像が 30 日で消えない（`/privacy` に書いた保存期間が嘘になる）か、消してはいけない
 * 現行の画像が消える。**突き合わせは `scripts/check-avatar-copies.sh` が行う。**
 */
export const AVATAR_HISTORY_PREFIX = 'avatars/history/';

/**
 * 利用者の id の綴り（`crypto.randomUUID()` が返す形。`src/auth/google.ts` の登録）。
 *
 * **URL から取り出して R2 のキーへ入れる値なので、綴りを固定する。** 16 進とハイフンだけなら、
 * キーの区切り（`/`）も `history` の綴りも作れない。
 */
export const AVATAR_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 現行の画像の R2 のキー。
 *
 * @param userId 利用者の id
 * @returns `avatars/<user_id>.webp`
 */
export function avatarObjectKey(userId: string): string {
  return `${AVATAR_OBJECT_PREFIX}${userId}${AVATAR_FILE_SUFFIX}`;
}

/**
 * 差し替え前の画像を写す R2 のキー。
 *
 * **操作ごとに一意にする**（時刻・SHA-256 に加えて、操作の id を綴りに入れる）。時刻と SHA-256 だけだと、
 * 同じ秒に同じ画像を写す 2 つの操作（二度押し）が同じキーになり、**後の写しが先の写しを上書きして、
 * 履歴の行が別の操作の画像を指す**（PR #436 の Copilot レビュー）。操作の id は排他の token
 * （`src/avatar.ts` の `acquireAvatarLock`）である。
 *
 * @param userId 利用者の id
 * @param changedAt 差し替えた時刻（UNIX 秒）
 * @param sha256 差し替え前の画像の SHA-256（16 進）
 * @param operationId 操作ごとの id（UUID）
 * @returns `avatars/history/<user_id>/<changed_at>-<sha256>-<operation_id>.webp`
 */
export function avatarHistoryKey(userId: string, changedAt: number, sha256: string, operationId: string): string {
  return `${AVATAR_HISTORY_PREFIX}${userId}/${changedAt}-${sha256}-${operationId}${AVATAR_FILE_SUFFIX}`;
}

/**
 * サンドボックス用ホストのオリジン（画像の URL の前半）。
 *
 * **スキームとポートは要求から借りる**（ローカルは `https://…:8787`、本番は既定のポート）。
 *
 * @param request 受信したリクエスト
 * @param sandboxHost `env.SANDBOX_HOST`
 * @returns `https://sandbox.example[:port]`
 */
export function sandboxOriginOf(request: Request, sandboxHost: string): string {
  const url = new URL(request.url);
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol}//${sandboxHost}${port}`;
}

/**
 * 画像の URL を組み立てる。
 *
 * - **版を付ける**（`version` が数）: 一覧・作者ページ。**URL が変わらない限り中身も変わらない**ので、
 *   配信は `immutable` で長くキャッシュさせる（仕様 2.3.8。Pages Functions の要求数を増やさない）
 * - **版を付けない**（`version` が null）: ヘッダのアバター。D1 を読まないので版を知らない。
 *   配信は毎回の再検証（`no-cache` と `ETag`）にする（`src/avatar-delivery.ts`）
 *
 * **HTML の属性へそのまま入れてよい綴りしか作らない**——オリジンは宣言と要求から作り、id は
 * {@link AVATAR_USER_ID_PATTERN} を通ったものだけを受け、版は整数だけを受ける。**通らなければ null**
 * （呼び出し側は画像を出さず、既定の図形のままにする）。
 *
 * @param origin {@link sandboxOriginOf} の戻り値
 * @param userId 利用者の id
 * @param version `users.avatar_set_at`（版を付けないなら null）
 * @returns 絶対 URL（組み立てられなければ null）
 */
export function avatarUrl(origin: string, userId: string, version: number | null): string | null {
  if (!AVATAR_USER_ID_PATTERN.test(userId)) {
    return null;
  }
  const base = `${origin}${AVATAR_PATH_PREFIX}${userId}${AVATAR_FILE_SUFFIX}`;
  if (version === null) {
    return base;
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    return null;
  }
  return `${base}?${AVATAR_VERSION_QUERY}=${version}`;
}
