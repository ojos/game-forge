/**
 * アイコン画像（#380 / M12-12 / 仕様 5.10・3.7・7.2・2.3.8）の、受け取り・保存・外す・履歴。
 *
 * 画面と口の結線は `src/account.ts`、先頭のバイトの判定は `src/avatar-image.ts`、再エンコードの
 * 呼び出しは `src/avatar-client.ts`、配信は `src/avatar-delivery.ts`、綴りは `src/avatar-paths.ts` が
 * 持つ。**ここは D1 の 1 行と R2 の 2 つのキーと、利用者が送った 1 枚の間に立つ部品だけを持つ。**
 * `src/account.ts` を import しない（あちらがここを import する）。
 *
 * ## 流れ（1 回の設定）
 *
 * ```text
 * 1. 本文を上限つきで読む（4 MiB ＋ フォームの見出し）          … 超えたら断る（黙って縮めない）
 * 2. 先頭のバイトで形式・アニメーション・寸法を判定する           … src/avatar-image.ts
 * 3. 間隔（60 秒）を先に見る                                     … 断る要求で Lambda を呼ばない
 * 4. Lambda で中央を正方形に切り抜き、256px の WebP にする        … メタデータ（Exif）はここで落ちる
 * 5. 出力をもう一度確かめる（WebP・256 × 256・大きさの上限）       … 関数が壊れた日に変なものを配らない
 * 6. R2: 現行の画像を avatars/history/ へ写す → 現行のキーを上書き
 * 7. D1: 履歴を 1 行積み、users の 2 列を書く（1 つの batch・同じ WHERE）
 *    → 当たらなかった・落ちたら、6 の上書きを戻す
 * ```
 *
 * ## 差し替え前の画像は 30 日だけ残す（利用者の決定）
 *
 * **消すのは R2 のライフサイクル規則である**（`terraform/r2-lifecycle.tf` の `avatars/history/` だけを
 * 対象にした削除規則）。**アプリは期限切れの画像を探しに行かない**——`games` を引かなくても安全だと
 * 構造的に言える接頭辞（写ししか置かない）なので、3.7 の削除規約 3 に反しない。
 *
 * **履歴の行は残る。** 30 日を過ぎた行は、画像を R2 に探しに行かずに「保存期間を過ぎて消えた」と
 * 扱う（{@link avatarHistoryImageState}）。
 *
 * **退会・運営の削除では期限を待たない。** 退会の機能はまだ無いので、運営の端末手順で現行と履歴の
 * 両方を消す（`docs/takedown.md`）。**BAN と自動では連動させない**（戻せる操作に、戻せない副作用を
 * 付けない。利用者の決定）。
 *
 * ## 順序: R2 を先に書き、D1 が当たらなければ戻す
 *
 * **D1 に履歴の無い画像の差し替えを作らない**（#405 の申し送り——通報の時点の画像を後から復元できる
 * ことが履歴の目的である）。D1 を先に書くと、R2 の上書きが落ちたときに「履歴は新しい画像を指すのに、
 * 配っているのは古い画像」になる。**R2 を先に書き、D1 の batch が当たらなければ（間隔・並行した
 * 変更・D1 の失敗）現行のキーを元に戻す。**
 *
 * - **戻すのは、現行のキーがまだ自分の書いた版のときだけ**（`etag` で確かめる）。二重送信の片方が
 *   先に勝っていれば、その画像を古い画像で上書きしない
 * - **履歴へ写した画像は戻さない。** どこからも指されない写しが 1 つ残るだけで、30 日で消える
 *
 * ## 自動検査は入れない（5.10 の実装注記）
 *
 * **招待制・参加者 50 人の段階では、運営の端末手順（`docs/takedown.md`）で足りると判断した。**
 * 一般公開の前に見直す（契機は仕様 5.10）。
 */
import type { AvatarEncodeRejection, EncodeAvatar } from './avatar-client.js';
import { AvatarEncodeFailed, AvatarNotConfigured } from './avatar-client.js';
import type { AvatarImageRejection } from './avatar-image.js';
import { AVATAR_MAX_BYTES, AVATAR_MAX_DIMENSION, inspectAvatarImage } from './avatar-image.js';
import {
  ACCOUNT_AVATAR_PATH,
  ACCOUNT_AVATAR_REMOVE_PATH,
  AVATAR_FILE_FIELD,
  AVATAR_MEDIA_TYPE,
  AVATAR_OUTPUT_SIZE,
  avatarHistoryKey,
  avatarObjectKey,
} from './avatar-paths.js';
import { avatarImage } from './html.js';

/** 保存する画像の一辺（px。正本は `src/avatar-paths.ts`）。 */
export { AVATAR_OUTPUT_SIZE };

/**
 * 変換した画像の最大バイト数（**256 KiB**）。
 *
 * 256 × 256 の WebP は写真でも 20〜40 KB に収まる。**上限は関数が壊れた日に、R2 と配信へ大きな
 * ものを流さないために置く**（`src/ogp.ts` の `MAX_OGP_IMAGE_BYTES` と同じ考え方）。
 */
export const AVATAR_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * 設定か外すかをしてから、次の変更を受け付けるまでの秒数（3.6）。
 *
 * **表示名・自己紹介と同じ値である。** 1 回の設定は Lambda の呼び出し 1 回・R2 の書き込み 2 回・
 * D1 の 3 行（`users` と履歴と索引）を伴う。
 */
export const AVATAR_CHANGE_INTERVAL_SECONDS = 60;

/**
 * 差し替え前の画像を残す日数（**30 日**。利用者の決定）。
 *
 * **消すのは R2 のライフサイクル規則である**（`terraform/r2-lifecycle.tf` の
 * `avatar_history_retention_days`）。**ここはその写し**で、`/privacy` の文言と
 * {@link avatarHistoryImageState} が読む。突き合わせは `scripts/check-avatar-copies.sh` が行う。
 */
export const AVATAR_HISTORY_RETENTION_DAYS = 30;

/** アイコンの変更の履歴を持つ表（`migrations/` の user_avatars）。 */
export const AVATAR_CHANGES_TABLE = 'avatar_changes';

/**
 * 設定画面で告げる、切り抜きの断り（利用者の決定「黙って縮めない扱いにする」）。
 *
 * **上限の内側の画像は断らずに切り抜いて縮める。** 縦長・横長の画像の端が落ちることを、上げる前に
 * 言っておく。
 */
export const AVATAR_CROP_NOTICE = '中央を正方形に切り抜いて表示します。';

/** 30 日を過ぎた履歴の行について出す文言。 */
export const AVATAR_HISTORY_EXPIRED_NOTICE = '画像は保存期間を過ぎて消えました。';

/**
 * 受け付ける本文の最大バイト数（ファイルの上限 ＋ フォームの見出しの分）。
 *
 * **これを超えたら、中身を読まずに「大きすぎる」と断る**（残りの転送を切る。`src/routes.ts` の
 * `readLimitedText` と同じ形）。
 */
const MAX_AVATAR_BODY_BYTES = AVATAR_MAX_BYTES + 64 * 1024;

/** 素の HTML フォームがファイルを送るときの `Content-Type`。 */
const MULTIPART_MEDIA_TYPE = 'multipart/form-data';

/**
 * アイコンの設定・外すことを受け付けなかった理由（`/account?reason=` に載る綴り）。
 *
 * **綴りは `avatar-` で始める**——表示名・自己紹介の理由と同じ query に載るので、取り違えない。
 */
export type AvatarRejection =
  | AvatarImageRejection
  | 'avatar-missing'
  | 'avatar-too-large'
  | 'avatar-invalid-request'
  | 'avatar-too-soon'
  | 'avatar-failed';

/** 断った理由ごとの文言（`src/account.ts` の文言の表へ連結する）。 */
export const AVATAR_REASON_MESSAGES: Readonly<Record<AvatarRejection, string>> = {
  'avatar-svg': 'SVG の画像はアイコンに使えません。PNG・JPEG・WebP の画像を選んでください。',
  'avatar-gif': 'GIF の画像はアイコンに使えません。PNG・JPEG・WebP の画像を選んでください。',
  'avatar-unsupported': 'アイコンに使えるのは PNG・JPEG・WebP の画像だけです。',
  'avatar-animated': '動く画像（アニメーション PNG・アニメーション WebP）はアイコンに使えません。',
  'avatar-too-large-dimensions': `アイコンの画像は、幅と高さがそれぞれ ${AVATAR_MAX_DIMENSION} ピクセルまでです。`,
  'avatar-broken': 'アイコンの画像を読み取れませんでした。壊れていないか確かめて、もう一度お試しください。',
  'avatar-missing': 'アイコンにする画像のファイルを選んでください。',
  'avatar-too-large': `アイコンの画像は ${AVATAR_MAX_BYTES / (1024 * 1024)} MB までです。`,
  'avatar-invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  // **待てば通ることを言う**（表示名の `too-soon` と同じ理由）。
  'avatar-too-soon': `アイコンの変更は ${AVATAR_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  'avatar-failed': 'アイコンを保存できませんでした。時間をおいてもう一度お試しください。',
};

/** 関数が断った理由を、利用者へ返す理由へ引き直す表。 */
const ENCODE_REJECTION_REASONS: Readonly<Record<AvatarEncodeRejection, AvatarImageRejection>> = {
  unsupported: 'avatar-unsupported',
  animated: 'avatar-animated',
  'too-large': 'avatar-too-large-dimensions',
  broken: 'avatar-broken',
};

/** 送られた画像の読み取りの結果。 */
export type AvatarUploadRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: AvatarRejection };

/**
 * `multipart/form-data` の本文から、アイコンのファイルを上限つきで取り出す。
 *
 * **判定の順**: 形式（`Content-Type`）→ 本文の大きさ → 項目 → ファイルの大きさ。**本文の大きさを
 * 解析の前に見る**——解析はファイル全体をメモリへ載せる。
 *
 * @param request 受信したリクエスト
 * @returns ファイルの中身、または断る理由
 */
export async function readAvatarUpload(request: Request): Promise<AvatarUploadRead> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0]!.trim().toLowerCase() !== MULTIPART_MEDIA_TYPE) {
    return { ok: false, reason: 'avatar-invalid-request' };
  }
  const body = await readLimitedBytes(request, MAX_AVATAR_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, reason: body.tooLarge ? 'avatar-too-large' : 'avatar-invalid-request' };
  }
  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { ok: false, reason: 'avatar-invalid-request' };
  }
  const entries = form.getAll(AVATAR_FILE_FIELD);
  if (entries.length !== 1) {
    // **0 件は選んでいない、2 件以上は手で組んだ要求である**（画面の入力欄は 1 つ）。
    return { ok: false, reason: entries.length === 0 ? 'avatar-missing' : 'avatar-invalid-request' };
  }
  const entry = entries[0]!;
  if (typeof entry === 'string') {
    return { ok: false, reason: 'avatar-invalid-request' };
  }
  if (entry.size === 0) {
    // ファイルを選ばずに送ると、名前の無い 0 バイトのファイルが届く。
    return { ok: false, reason: 'avatar-missing' };
  }
  if (entry.size > AVATAR_MAX_BYTES) {
    return { ok: false, reason: 'avatar-too-large' };
  }
  return { ok: true, bytes: new Uint8Array(await entry.arrayBuffer()) };
}

/**
 * 送られた画像の一次判定（大きさと、先頭のバイト）。
 *
 * @param bytes ファイルの中身
 * @returns 断る理由（受け付けるなら null）
 */
export function avatarUploadRejection(bytes: Uint8Array): AvatarRejection | null {
  if (bytes.length === 0) {
    return 'avatar-missing';
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    return 'avatar-too-large';
  }
  const inspected = inspectAvatarImage(bytes);
  return inspected.ok ? null : inspected.reason;
}

/**
 * 変換した画像が、配ってよい形か（WebP・{@link AVATAR_OUTPUT_SIZE} の正方形・大きさの上限）。
 *
 * **関数を信じ切らない。** 関数が壊れた日・古い版が載っている日に、変換していない画像や大きな
 * 画像を R2 へ入れない。
 *
 * @param webp 変換した画像
 * @returns 配ってよければ true
 */
export function isDeliverableAvatar(webp: Uint8Array): boolean {
  if (webp.length === 0 || webp.length > AVATAR_MAX_OUTPUT_BYTES) {
    return false;
  }
  const inspected = inspectAvatarImage(webp);
  return (
    inspected.ok &&
    inspected.format === 'webp' &&
    inspected.width === AVATAR_OUTPUT_SIZE &&
    inspected.height === AVATAR_OUTPUT_SIZE
  );
}

/** 送られた画像を変換した結果。 */
export type AvatarConversion =
  | { readonly ok: true; readonly webp: Uint8Array }
  | { readonly ok: false; readonly reason: AvatarRejection };

/**
 * 一次判定を通った画像を、関数で変換する（失敗は理由へ畳む）。
 *
 * @param env バインディングと環境変数
 * @param bytes ファイルの中身（{@link avatarUploadRejection} を通ったもの）
 * @param encode 変換の段
 * @returns 変換した画像、または断る理由
 */
export async function convertAvatar(env: Env, bytes: Uint8Array, encode: EncodeAvatar): Promise<AvatarConversion> {
  try {
    const encoded = await encode(env, bytes);
    if (!encoded.ok) {
      return { ok: false, reason: ENCODE_REJECTION_REASONS[encoded.reason] };
    }
    if (!isDeliverableAvatar(encoded.webp)) {
      console.error(`[avatar] 変換した画像が配ってよい形ではありません（${encoded.webp.length} バイト）`);
      return { ok: false, reason: 'avatar-failed' };
    }
    return { ok: true, webp: encoded.webp };
  } catch (error) {
    if (error instanceof AvatarNotConfigured || error instanceof AvatarEncodeFailed) {
      // **画像はログに出さない。** 名前と状態だけ（`src/avatar-client.ts`）。
      console.error(`[avatar] ${error.message}${error instanceof AvatarEncodeFailed ? ` (${error.detail ?? '-'})` : ''}`);
    } else {
      console.error(`[avatar] 変換に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    return { ok: false, reason: 'avatar-failed' };
  }
}

/** アイコンの書き込みの結果。 */
export type AvatarChange =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'avatar-too-soon' | 'avatar-failed' };

/** `users` から読むアイコンの 2 列。 */
export interface AvatarRow {
  /** いまの画像の SHA-256（無ければ null）。 */
  readonly avatar_sha256: string | null;
  /** 最後に設定した・外した時刻（無ければ null）。 */
  readonly avatar_set_at: number | null;
}

/**
 * 利用者のアイコンの 2 列を読む。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @returns 2 列（行が無ければ null）
 */
export async function loadAvatarRow(db: D1Database, userId: string): Promise<AvatarRow | null> {
  return await db
    .prepare('select avatar_sha256, avatar_set_at from users where id = ?')
    .bind(userId)
    .first<AvatarRow>();
}

/**
 * 間隔が空いているか（{@link AVATAR_CHANGE_INTERVAL_SECONDS}）。
 *
 * **ここは早めに断るための読みで、判定の正本は batch の WHERE である**（読みと書きの間に 2 本目が
 * 入っても、WHERE が片方を 0 行にする）。
 *
 * @param row いまの 2 列
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 空いていれば true
 */
export function avatarIntervalElapsed(row: AvatarRow, nowSeconds: number): boolean {
  return row.avatar_set_at === null || row.avatar_set_at <= nowSeconds - AVATAR_CHANGE_INTERVAL_SECONDS;
}

/**
 * 変換した画像をアイコンとして保存する（R2 の写しと上書き → D1 の batch。戻しを含む）。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @param webp 変換した画像（{@link isDeliverableAvatar} を通ったもの）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いたか、断ったか
 */
export async function saveAvatar(
  env: Env,
  userId: string,
  webp: Uint8Array,
  nowSeconds: number,
): Promise<AvatarChange> {
  const sha256 = await sha256Hex(webp);
  const row = await loadAvatarRow(env.DB, userId);
  if (row === null) {
    return { ok: false, reason: 'avatar-failed' };
  }
  if (row.avatar_sha256 === sha256) {
    // **同じ画像の上げ直しは成功にし、書かない**（二度押し。履歴も積まない）。
    return { ok: true, changed: false };
  }
  if (!avatarIntervalElapsed(row, nowSeconds)) {
    return { ok: false, reason: 'avatar-too-soon' };
  }

  const key = avatarObjectKey(userId);
  const previous = await moveCurrentToHistory(env.BUCKET, userId, row, nowSeconds);
  const written = await env.BUCKET.put(key, webp, {
    httpMetadata: { contentType: AVATAR_MEDIA_TYPE },
    // **配信が `?v=` と突き合わせる時刻**（`src/avatar-delivery.ts`）。D1 を読まずに版の一致を確かめる。
    customMetadata: { setAt: String(nowSeconds), sha256 },
  });
  return await commitOrRestore(env, key, written.etag, previous, {
    userId,
    oldSha256: row.avatar_sha256,
    newSha256: sha256,
    historyKey: previous?.historyKey ?? null,
    nowSeconds,
  });
}

/**
 * アイコンを外す（R2 の写しと削除 → D1 の batch。戻しを含む）。
 *
 * **外した画像も 30 日だけ残す**（差し替えと同じ扱い。`/privacy`）。期限を待たずに消すのは
 * 運営の端末手順である（`docs/takedown.md`）。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いたか、断ったか
 */
export async function removeAvatar(env: Env, userId: string, nowSeconds: number): Promise<AvatarChange> {
  const row = await loadAvatarRow(env.DB, userId);
  if (row === null) {
    return { ok: false, reason: 'avatar-failed' };
  }
  if (row.avatar_sha256 === null) {
    // **外していない画像は無い。** 二度押しを成功にする。
    return { ok: true, changed: false };
  }
  if (!avatarIntervalElapsed(row, nowSeconds)) {
    return { ok: false, reason: 'avatar-too-soon' };
  }

  const key = avatarObjectKey(userId);
  const previous = await moveCurrentToHistory(env.BUCKET, userId, row, nowSeconds);
  await env.BUCKET.delete(key);
  return await commitOrRestore(env, key, null, previous, {
    userId,
    oldSha256: row.avatar_sha256,
    newSha256: null,
    historyKey: previous?.historyKey ?? null,
    nowSeconds,
  });
}

/** 上書き（削除）する前の現行の画像。戻すときに使う。 */
interface PreviousAvatar {
  readonly bytes: Uint8Array;
  readonly customMetadata: Record<string, string>;
  /** 写した先のキー。 */
  readonly historyKey: string;
}

/**
 * 現行の画像を `avatars/history/` へ写す（現行のキーは消さない）。
 *
 * @param bucket R2 バインディング
 * @param userId 利用者の id
 * @param row いまの 2 列
 * @param nowSeconds 差し替える時刻
 * @returns 写した画像（無ければ null）
 */
async function moveCurrentToHistory(
  bucket: R2Bucket,
  userId: string,
  row: AvatarRow,
  nowSeconds: number,
): Promise<PreviousAvatar | null> {
  if (row.avatar_sha256 === null) {
    return null;
  }
  const object = await bucket.get(avatarObjectKey(userId));
  if (object === null) {
    // D1 は画像があると言うのに、R2 に無い（運営が R2 だけを消した途中など）。**写すものが無いので
    // 履歴のキーは NULL で積む**——無い画像を「写した」と書かない。
    console.error('[avatar] D1 が指す現行の画像が R2 にありません（履歴には写しません）');
    return null;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const historyKey = avatarHistoryKey(userId, nowSeconds, row.avatar_sha256);
  await bucket.put(historyKey, bytes, {
    httpMetadata: { contentType: AVATAR_MEDIA_TYPE },
    customMetadata: { userId, sha256: row.avatar_sha256, replacedAt: String(nowSeconds) },
  });
  return { bytes, customMetadata: object.customMetadata ?? {}, historyKey };
}

/** 履歴と `users` を書く batch に渡す値。 */
interface AvatarBatchInput {
  readonly userId: string;
  readonly oldSha256: string | null;
  readonly newSha256: string | null;
  readonly historyKey: string | null;
  readonly nowSeconds: number;
}

/**
 * D1 の batch を書き、当たらなければ（落ちたら）現行のキーを戻す。
 *
 * @param env バインディングと環境変数
 * @param key 現行のキー
 * @param writtenEtag 自分が書いた版の etag（外したときは null）
 * @param previous 写した前の画像（無ければ null）
 * @param input batch に渡す値
 * @returns 書いたか、断ったか
 * @throws D1 が落ちたとき（戻したあとに投げ直す）
 */
async function commitOrRestore(
  env: Env,
  key: string,
  writtenEtag: string | null,
  previous: PreviousAvatar | null,
  input: AvatarBatchInput,
): Promise<AvatarChange> {
  let applied: boolean;
  try {
    applied = await writeAvatarBatch(env.DB, input);
  } catch (error) {
    await restoreCurrent(env.BUCKET, key, writtenEtag, previous);
    throw error;
  }
  if (!applied) {
    // 間隔の内側に 2 本目が入った・並行した変更が先に勝った。**先に勝った側の画像を壊さない**
    // （{@link restoreCurrent}）。
    await restoreCurrent(env.BUCKET, key, writtenEtag, previous);
    return { ok: false, reason: 'avatar-too-soon' };
  }
  return { ok: true, changed: true };
}

/**
 * 履歴を 1 行積み、`users` の 2 列を書く。**1 つの `D1.batch`・同じ WHERE**（`src/profile.ts` の
 * `changeProfile` と同じ形）。
 *
 * **WHERE に「いまの画像が読んだときのままであること」を入れる**（`avatar_sha256 is ?`）。読んでから
 * 書くまでの間に並行した変更が入っていれば 0 行になり、履歴の `old_sha256` が実際の旧い画像と
 * 食い違う行を作らない。
 *
 * @param db D1 バインディング
 * @param input 書く値
 * @returns 書いたら true（間隔や並行した変更で当たらなければ false）
 */
export async function writeAvatarBatch(db: D1Database, input: AvatarBatchInput): Promise<boolean> {
  const conditions =
    'id = ? and avatar_sha256 is ? and avatar_sha256 is not ?' +
    ' and (avatar_set_at is null or avatar_set_at <= ?)';
  const bindings = [
    input.userId,
    input.oldSha256,
    input.newSha256,
    input.nowSeconds - AVATAR_CHANGE_INTERVAL_SECONDS,
  ] as const;
  const results = await db.batch([
    db
      .prepare(
        `insert into ${AVATAR_CHANGES_TABLE}
                (id, user_id, old_sha256, new_sha256, history_key, changed_at)
         select ?, id, avatar_sha256, ?, ?, ?
           from users
          where ${conditions}`,
      )
      .bind(crypto.randomUUID(), input.newSha256, input.historyKey, input.nowSeconds, ...bindings),
    db
      .prepare(`update users set avatar_sha256 = ?, avatar_set_at = ? where ${conditions}`)
      .bind(input.newSha256, input.nowSeconds, ...bindings),
  ]);
  const historyRows = results[0]?.meta.changes ?? 0;
  const updatedRows = results[1]?.meta.changes ?? 0;
  if (updatedRows > 0 && historyRows === 0) {
    // **構造上ありえない**（同じ条件・同じ batch）。出るとすれば D1 の batch の意味が変わったとき。
    console.error('[avatar] 履歴の無いアイコンの変更が入りました（batch の意味が変わっています）');
  }
  return updatedRows > 0;
}

/**
 * 現行のキーを、書く前の状態へ戻す。**現行のキーがまだ自分の書いた版のときだけ戻す。**
 *
 * @param bucket R2 バインディング
 * @param key 現行のキー
 * @param writtenEtag 自分が書いた版の etag（外したときは null＝「無いはず」）
 * @param previous 書く前の画像（無ければ null）
 */
async function restoreCurrent(
  bucket: R2Bucket,
  key: string,
  writtenEtag: string | null,
  previous: PreviousAvatar | null,
): Promise<void> {
  try {
    const head = await bucket.head(key);
    if ((head?.etag ?? null) !== writtenEtag) {
      // 誰かが先に書いた（二重送信の片方など）。その版を壊さない。
      return;
    }
    if (previous !== null) {
      await bucket.put(key, previous.bytes, {
        httpMetadata: { contentType: AVATAR_MEDIA_TYPE },
        customMetadata: previous.customMetadata,
      });
    } else if (writtenEtag !== null) {
      await bucket.delete(key);
    }
  } catch (error) {
    // **戻しの失敗は投げない**（元の失敗を覆い隠さない）。事実はログへ残す。
    console.error(`[avatar] 現行の画像を戻せませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
  }
}

/** 履歴の行が指す画像の状態。 */
export type AvatarHistoryImageState = 'none' | 'available' | 'expired';

/**
 * 履歴の行が指す画像を、いま確かめられるか（**R2 を引かずに、時刻だけで決める**）。
 *
 * - `none` … 写していない（前の画像が無かった・運営が消した）
 * - `expired` … {@link AVATAR_HISTORY_RETENTION_DAYS} 日を過ぎた——「{@link AVATAR_HISTORY_EXPIRED_NOTICE}」と扱う
 * - `available` … 期間の内側（**R2 のライフサイクルは期限の後 24 時間ほどで消すので、境目の前後の
 *   1 日は、あるはずの画像が無いこともある**。無ければ `expired` と同じ文言を出す）
 *
 * @param historyKey 行の `history_key`
 * @param changedAt 行の `changed_at`（UNIX 秒）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 状態
 */
export function avatarHistoryImageState(
  historyKey: string | null,
  changedAt: number,
  nowSeconds: number,
): AvatarHistoryImageState {
  if (historyKey === null) {
    return 'none';
  }
  return nowSeconds - changedAt >= AVATAR_HISTORY_RETENTION_DAYS * 24 * 60 * 60 ? 'expired' : 'available';
}

/**
 * バイト列の SHA-256 を 16 進で返す。
 *
 * @param bytes バイト列
 * @returns 64 桁の 16 進
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** 本文を上限つきで読んだ結果。 */
type LimitedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly tooLarge: boolean };

/**
 * 本文をバイト列のまま上限つきで読む（`src/routes.ts` の `readLimitedText` のバイト版）。
 *
 * **`src/routes.ts` を書き換えない。** あちらはオーケストレータの束に入っている
 * （`scripts/bundle-orchestrator.sh`）。画面の都合の編集が束を変えると、配り直すまで main の配備が
 * 止まる（`docs/handoff.md` 4 章）。
 *
 * @param request 受信したリクエスト
 * @param limit 上限（バイト）
 * @returns 中身、または読めなかった理由
 */
async function readLimitedBytes(request: Request, limit: number): Promise<LimitedBytes> {
  const body = request.body;
  if (body === null) {
    return { ok: true, bytes: new Uint8Array() };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch (error) {
    console.error(`[avatar] 本文を読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return { ok: false, tooLarge: false };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

/** アイコンのフォームに入れる値。 */
export interface AvatarFormView {
  /** いまのアイコンの URL（版つき。設定していなければ null）。 */
  readonly url: string | null;
}

/**
 * アイコンのフォームを組み立てる（`/account` のプロフィールのタブ）。
 *
 * **見た目は既存のアバター（`.gf-avatar`。1.75rem の正円）のまま、画像を差し込むだけにする**
 * （#433 の見た目の規約が決まるまで。利用者の決定）。
 *
 * **`accept` は選ぶ画面の絞り込みにすぎない**（守りではない。判定は送られた中身で行う）。
 *
 * @param view フォームに入れる値
 * @returns HTML
 */
export function renderAvatarForm(view: AvatarFormView): string {
  const image = avatarImage(view.url);
  const state =
    view.url === null
      ? '<p>アイコンはまだ設定していません（既定の図形を表示しています）。</p>'
      : '<p>いまのアイコンです。</p>';
  const remove =
    view.url === null
      ? ''
      : `\n<form class="gf-avatar-remove" method="post" action="${ACCOUNT_AVATAR_REMOVE_PATH}">
  <button type="submit">アイコンを外す</button>
</form>`;
  return `<h2>アイコン</h2>
<div class="gf-avatar-current"><span class="gf-avatar" aria-hidden="true">${image}</span>${state}</div>
<form class="gf-avatar-form" method="post" action="${ACCOUNT_AVATAR_PATH}" enctype="multipart/form-data">
  <label for="avatar-file">アイコンの画像</label>
  <input id="avatar-file" name="${AVATAR_FILE_FIELD}" type="file" accept="image/png,image/jpeg,image/webp" required>
  <p>PNG・JPEG・WebP の画像を ${AVATAR_MAX_BYTES / (1024 * 1024)} MB まで、幅と高さはそれぞれ ${AVATAR_MAX_DIMENSION} ピクセルまで使えます。<strong>${AVATAR_CROP_NOTICE}</strong>SVG・GIF・動く画像は使えません。</p>
  <button type="submit">アイコンを設定する</button>
</form>${remove}
<p>アイコンは作者ページ・作品の一覧・ヘッダに出て、ログインしていない人にも見えます。画像は保存するときに ${AVATAR_OUTPUT_SIZE} ピクセル四方の WebP に作り直し、撮影した場所などの情報（Exif）は残しません。差し替えたり外したりする前の画像は、通報への対応のために ${AVATAR_HISTORY_RETENTION_DAYS} 日間だけ保存してから消します（公開しません）。</p>`;
}
