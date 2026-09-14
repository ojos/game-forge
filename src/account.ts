/**
 * 登録情報の画面（`/account` と `/account/details` と `/account/mail`）と、表示名の変更
 * （`POST /api/account/display-name`）・自己紹介と外部リンクの保存（`POST /api/account/profile`）・
 * メール配信の設定の保存（`POST /api/account/mail`）・アイコンの設定と外すこと
 * （`POST /api/account/avatar` / `POST /api/account/avatar/remove`。#380。部品は `src/avatar.ts`）。
 * **仕様 5.9 の実体であり、5.10 の自己紹介と外部リンクの口であり、5.11 のメール配信設定の口である**
 * （#341 / M9-6 / #379 / M12-11 / #384 / M12-16）。
 * 自己紹介と外部リンクの形の検査と書き込みは `src/profile.ts` が持つ。
 *
 * ## なぜ表示名を変えられるようにするのか
 *
 * 表示名は v1.50 で**未ログインの閲覧者にも見える値**になった（作品ページ・作品カード・
 * 作者ページ。2.3）。それまではログインのたびに Google の表示名で上書きしており
 * （`src/auth/google.ts`）、**本名を公開の画面に出したくない人に、避ける手段が無かった。**
 *
 * 変えた名前がログインで戻らないことは `users.display_name_set_at` が担う
 * （`migrations/0022_users_display_name_set_at.sql`。NULL なら Google に追随する）。
 * **この画面はその列を埋める唯一の経路である。**
 *
 * ## なりすましは名前で見分けない
 *
 * **変えられるようにすると、誰でも「運営」と名乗れる。** 名前の文字列で運営を判定する
 * 実装は壊れるので、運営であることは #334 の運営フラグ（名前の隣の印）で見分ける（5.9）。
 * **この経路は名前の中身を 1 語も検査しない**（語の一覧を持たない。利用者の決定
 * 「制限は最小限」）。不適切な名前は運営が D1 を直接 UPDATE して戻す（BAN と同じ運用）。
 *
 * ## 保存時の制約は XSS を防がない
 *
 * **`<script>` も `"` も 30 文字に収まる。** ここで弾くのは長さと制御文字（文字の向きを
 * 変える書式文字を含む。{@link validateDisplayName}）だけで、HTML に効く文字は通す（通さない理由が無い——「<」を名前に含めたい人はいる）。
 * **表示名を HTML へ出す場所は、すべて `escapeHtml` を通すこと**（作品ページ・作品カード・
 * 作者ページ・この画面）。確かめているのは `test/display-name-escape.test.ts` である。
 *
 * ## メールアドレスは本人にだけ出す
 *
 * **この画面は利用者を引数に取らない。** 誰の登録情報を出すかはセッションだけで決まり、
 * URL にも本文にも他人を指す口が無い。`/account?user=...` のような口を足さないこと
 * （足した瞬間に、他人のメールアドレスを引ける画面になる）。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）で、他サイトからの
 * POST には**そもそも cookie が乗らない**。`src/publish.ts` / `src/invite-issuance.ts` と
 * 同じ理由でトークンを足していない。**cookie の属性を緩めるなら、その時点でここも
 * 見直すこと。**
 *
 * ## JavaScript を要求しない
 *
 * 素の `<form method="post">` と POST-redirect-GET だけで組む（9.3）。結果は
 * `/account` の query（固定の分類名だけ）で運び、**入力した名前そのものは URL に載せない**
 * （載せると、断られた名前が履歴やログに残り、画面へ反射する口にもなる）。
 *
 * ## ログアウトは、もうこの画面の本文に無い（#362 → #372 / 2.3.7）
 *
 * #362 はログアウトをこの画面の末尾に置いた。**当時のヘッダのナビは `<a href>` しか
 * 作らず**、GET を受けないログアウト（`<img src="/auth/logout">` を踏ませるだけで他人を
 * ログアウトさせられる）の `<form method="post">` を収める場所が、ログイン必須の
 * この画面しか無かったためである。
 *
 * **v1.57 で 2.3.7 がそれを覆し、#372 がヘッダのアカウントのメニュー（`<details>`）へ
 * 移した**（`src/html.ts` の `accountMenu`）。**POST でしか受けない理由は 1 つも
 * 変わっておらず、変わったのは置き場所だけである。** この画面にもヘッダは出るので、
 * ログアウトへの導線は失われていない。**2 つ置かない**——同じ操作のボタンが 1 画面に
 * 2 つ並ぶと、どちらが正かを読む人に考えさせる。
 *
 * ## タブはパスで分ける（#379 / 5.10）
 *
 * **`/account` はプロフィールのタブ**（表示名・自己紹介・外部リンク）、**`/account/details` は
 * アカウントのタブ**（メールアドレス・登録日）である。並びと名前は `src/account-paths.ts` の
 * `ACCOUNT_TABS` が持つ。**表示名をプロフィールの側に置く**——作者ページに出る値をまとめ、
 * 本人にしか出ない値（メールアドレス）を別のタブへ分けた。
 *
 * **タブを足す人がすること**は 3 つである（メール配信のタブ。#384 / 5.11 がこの手順で足した）。
 *
 *   1. `src/account-paths.ts` にパスを足し、`ACCOUNT_TABS` へ 1 行足す
 *   2. この経路表（{@link createAccountRoutes}）へ GET の画面を 1 本足す（`resolveSessionUser` を
 *      通し、未ログインなら {@link loginRequiredRedirect} へ送る）
 *   3. 画面は {@link accountShell} で組む（見出し・タブ・ヘッダの状態を揃える）
 *
 * `ACCOUNT_TABS` の行き先がすべて経路表の画面であることは `test/account.test.ts` が照合する。
 * パスで分けてあるので、**外枠の検査と幅の検査には何も書き足さずに乗る。**
 *
 * ## 自己紹介と外部リンクは、断ったときに入力を失わせない（#379）
 *
 * **表示名の口は、断ると `/account?reason=` へ送り直す**（入力した名前は URL に載せない。上）。
 * **自己紹介の口は、形の検査や 8.3 で断ったとき、その場で画面を組み直して返す**
 * （{@link handleProfileChange}）。500 文字の文章と 3 本の URL を、1 語が表に当たっただけで
 * 全部打ち直させないためである。**送られた値は本文へ `escapeHtml` を通して戻すだけで、
 * URL にもログにも載せない**——表示名が query を避けた理由（履歴・ログ・反射）はこの形でも
 * 守られる。
 *
 * ## メール配信のタブ（#384 / 5.11）
 *
 * **改造通知を受け取るかどうかを 1 つ選び、設定にかかわらず送る種別を並べる。**
 *
 * - **既定は受け取る**（`users.fork_notice_muted_at` が NULL）。既存の利用者の挙動を変えない
 * - **止められない種別の一覧は `src/mail/kinds.ts` から出す**（画面に書き写さない。種別を足した日に
 *   画面だけが古くならない）
 * - **この画面は設定を書くだけで、送らない判定は送信の口（`src/mail/fork-notice.ts`）が持つ**
 *   ——判定を 2 か所に持たない（5.11）
 * - **書き込みは WHERE で絞る**（{@link changeForkNoticePreference}）。同じ値の入れ直しは 0 行で、
 *   **受け取る設定へ戻すのは、止めてから {@link FORK_NOTICE_UNMUTE_INTERVAL_SECONDS} 秒以上
 *   空いたときだけ**（3.6。1 列で連打を絞る形。マイグレーションの fork_notice_mute の本文）
 * - **素のフォームと POST-redirect-GET で組む**（JavaScript を要求しない。結果は `/account/mail` の
 *   query に固定の分類名だけで運ぶ）
 */
import {
  ACCOUNT_DETAILS_PATH,
  ACCOUNT_DISPLAY_NAME_PATH,
  ACCOUNT_MAIL_API_PATH,
  ACCOUNT_MAIL_PATH,
  ACCOUNT_PATH,
  ACCOUNT_TABS,
  DISPLAY_NAME_FIELD,
  FORK_NOTICE_FIELD,
  FORK_NOTICE_MUTE,
  FORK_NOTICE_RECEIVE,
} from './account-paths.js';
import { loginRequiredRedirect } from './auth/google.js';
import type { AvatarFormView, AvatarRejection } from './avatar.js';
import {
  AVATAR_REASON_MESSAGES,
  acquireAvatarLock,
  avatarUploadRejection,
  convertAvatar,
  readAvatarUpload,
  releaseAvatarLock,
  removeAvatar,
  renderAvatarForm,
  saveAvatar,
} from './avatar.js';
import type { EncodeAvatar } from './avatar-client.js';
import { encodeAvatarOnLambda } from './avatar-client.js';
import { ACCOUNT_AVATAR_PATH, ACCOUNT_AVATAR_REMOVE_PATH, avatarUrl, sandboxOriginOf } from './avatar-paths.js';
import { displayNameHistoryInsert } from './display-name-changes.js';
import { escapeHtml, headerAvatarUrl, siteHead, siteViewerAt } from './html.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import { siteFooter } from './legal.js';
import { FORK_NOTICE_KIND_LABEL, MAIL_KINDS, unmutableUserMailKinds } from './mail/kinds.js';
import type { ProfileFormView, ProfileRejection } from './profile.js';
import {
  PROFILE_REASON_MESSAGES,
  changeProfile,
  parseStoredProfileLinks,
  renderProfileForm,
  validateProfile,
} from './profile.js';
import { ACCOUNT_PROFILE_PATH, BIO_FIELD, PROFILE_LINK_FIELD } from './profile-paths.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { authorPagePath } from './users-page-paths.js';

/**
 * 表示名の最大の長さ（**コードポイントで数える**。5.9）。
 *
 * **UTF-16 の長さ（`String#length`）で数えない。** 絵文字や一部の漢字はサロゲート対で
 * 2 と数えられ、見た目の 15 文字で「30 文字を超えています」と言うことになる。
 * コードポイントなら「1 文字」の感覚に近く、どの言語でも同じ規則で数えられる。
 * **書記素（見た目の 1 文字）までは数えない**——肌の色を付けた絵文字などは 2 以上に
 * 数えるが、それを数えるには `Intl.Segmenter` が要り、ランタイムの ICU の版で
 * 数え方が変わりうる（`src/jst.ts` が `Intl` を避けたのと同じ理由）。
 */
export const DISPLAY_NAME_MAX_LENGTH = 30;

/**
 * 表示名を変えてから、次の変更を受け付けるまでの秒数（5.9 / 3.6）。
 *
 * **連打で D1 の書き込みを増やさないための間隔である。** 書き込みの無料枠は読み取りより
 * 桁で小さく、**枯れると D1 全体が止まる**（3.6。生成もログインも止まる）。
 * 1 回の変更は `users` の 1 行と、名前が変わったときは履歴（`display_name_changes`。#405）の
 * 1 行と索引の 1 行で、最大 3 行の書き込みである。60 秒に 1 回なら 1 人が 1 日張り付いても
 * 4,320 行に収まる（無料枠 10 万行/日 の 4.3%。履歴を足す前は 1,440 行・1.4% だった）。
 */
export const DISPLAY_NAME_CHANGE_INTERVAL_SECONDS = 60;

/**
 * 受け付ける本文の最大バイト数。
 *
 * **4 KiB。** 載るのは表示名 1 つで、30 文字が 4 バイト文字でもパーセント符号化後
 * 360 バイト余りである。**それより大きく取るのは、長すぎる名前を打った人に
 * 413 ではなく「30 文字までです」を返すため**である（超えた分は `too-long` として扱う。
 * {@link readDisplayName}）。上限そのものは、本文を際限なく読まないために置く。
 */
const MAX_BODY_BYTES = 4096;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * 表示名に含めてはいけない文字。
 *
 * - **`\p{Cc}`（制御文字）。** 改行（LF / CR）・タブ・NUL・DEL・C1 制御文字（NEL を含む）。
 *   改行の禁止は、名前を載せる改造通知メールの本文で行を割らせないためでもある（5.9）
 * - **`\p{Zl}` / `\p{Zp}`（U+2028 行区切り / U+2029 段落区切り）。** Unicode 上の
 *   改行であり、表示する側によっては行を割る。**5.9 の「改行を含む」をコードポイントの
 *   分類ではなく意味で読んだ**（制御文字の分類には入らないが、禁じたい性質は同じ）
 *
 * **語は見ない**（5.9「語の検査はしない」）。HTML に効く文字（`<` `"` など）も通す
 * ——防ぐのは出力側のエスケープである（冒頭の「保存時の制約は XSS を防がない」）。
 */
const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 表示名に含めてはいけない、**文字の向きを変える書式文字**（#341 の取り込みで決めた）。
 *
 * Unicode の `Bidi_Control` 特性を持つ 12 個である。
 *
 * | コードポイント | 名前 |
 * |---|---|
 * | U+061C | ALM（アラビア文字の印。右→左） |
 * | U+200E / U+200F | LRM / RLM（左→右・右→左の印） |
 * | U+202A〜U+202E | LRE / RLE / PDF / LRO / RLO（埋め込みと上書き） |
 * | U+2066〜U+2069 | LRI / RLI / FSI / PDI（分離） |
 *
 * ## なぜ弾くのか
 *
 * **名前の後ろに並ぶものの見え方を崩せる。** たとえば名前の末尾に RLO（U+202E）を
 * 置くと、同じ段落で後ろに続く文字が右から左へ並び替わる——作品カードでは名前の直後に
 * 公開日時が並び（`src/work-card.ts`）、作品ページでは運営の印（#334）が名前の隣に付く。
 * **印で運営を見分ける（5.9「なりすましは名前で見分けない」）以上、名前の側から印の
 * 見え方を動かせてはいけない。** しかも どれも目に見えず、日本語の名前で使う正当な理由が無い。
 *
 * 5.9 の「制御文字を含まない」の趣旨の範囲として扱う（Unicode の分類では `\p{Cf}`
 * 書式文字で、`\p{Cc}` には入らない）。**語の検査ではない**——見ているのは文字の働き
 * だけで、名前の意味には触れない。
 *
 * ## 12 個を書き並べず、特性で引く
 *
 * 取り込みの指示は U+200E〜U+2069 の 11 個だった。**第二意見のレビューで U+061C（ALM）の
 * 漏れを指摘された**——RLM と同じ働きを持つのに、General Punctuation の外にあるので
 * 範囲の書き並べから落ちていた。**書き並べると同じ漏れ方をもう一度しうる**ので、
 * Unicode が「向きを制御する文字」として定める特性（`Bidi_Control`）そのものを使う。
 * 将来の Unicode で向きを制御する文字が足されても、ランタイムの Unicode データに従って
 * 追随する（書き並べた範囲は追随しない）。
 *
 * ## `\p{Cf}` を丸ごと弾かない
 *
 * `\p{Cf}` にはゼロ幅接合子（U+200D。絵文字の合成に要る）や異体字の選択に関わるものも
 * 入る。**弾くのは「向きを変える」働きを持つものに限る**（ゼロ幅空白 U+200B などへは
 * 広げない。取り込みの判断）。
 *
 * **前後の空白を除いても消えない。** これらは `String#trim` の対象（空白・行終端）では
 * ないので、末尾に置かれたものも検査に掛かる。
 */
const DIRECTION_FORMATTING_CHARACTER = /\p{Bidi_Control}/u;

/** 表示名を受け付けなかった理由。 */
export type DisplayNameRejection = 'empty' | 'too-long' | 'control-char';

/** 表示名の検査の結果。 */
export type DisplayNameValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: DisplayNameRejection };

/**
 * 表示名を検査し、保存する形（前後の空白を除いたもの）へ落とす（5.9）。
 *
 * **判定は前後の空白を除いた後の値に対して行う。** 保存するのもその値なので、
 * 末尾に紛れ込んだ改行（コピーした文字列によくある）は除かれて通る。**真ん中の
 * 改行は除けない**ので断る。空白の判定は `String#trim` に任せる（全角空白 U+3000 も
 * 除く。**全角空白だけの名前は「空白だけ」として断る**）。
 *
 * **重複は検査しない**（5.9。作者は `/users/<user_id>` で区別できる）。
 *
 * @param raw フォームから受け取った値
 * @returns 保存する値、または断る理由
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
  const value = raw.trim();
  if (value === '') {
    return { ok: false, reason: 'empty' };
  }
  // 向きを変える書式文字も同じ理由名で返す（5.9 の「制御文字」の趣旨の範囲。上の定数）。
  if (FORBIDDEN_CHARACTER.test(value) || DIRECTION_FORMATTING_CHARACTER.test(value)) {
    return { ok: false, reason: 'control-char' };
  }
  // スプレッドは文字列をコードポイントごとに分ける（サロゲート対を 1 つに数える）。
  if ([...value].length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  return { ok: true, value };
}

/** 表示名の書き込みの結果。 */
export type DisplayNameChange = { readonly ok: true } | { readonly ok: false; readonly reason: 'too-soon' };

/**
 * 表示名を書き込む。**前回の変更から {@link DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} 秒以上
 * 空いているときだけ書く**（5.9 / 3.6）。
 *
 * ## 断った要求は書き込まない
 *
 * **間隔の判定を `WHERE` に置く。** 条件に当たらなければ 0 行の更新で終わり、D1 には
 * 何も書かれない（書き込み行数 0）。`set display_name = case when ... end` の形で
 * 「値を変えずに書く」と、**断ったつもりでも毎回 1 行書くことになり、連打を止める
 * 意味が無くなる。** 先に `SELECT` で時刻を読んでから決める形も採らない——読みと書きの
 * 間に同じ利用者の要求がもう 1 本入ると、両方が「空いている」と読んで 2 行書く。
 *
 * 同じ名前を入れ直す要求も書く。**それが「Google の名前に追随するのをやめる」唯一の
 * 方法である**（今の名前のまま `display_name_set_at` を埋める）。5.9 が「Google の名前に
 * 戻す」ボタンを持たないのと対になっている。**ただし履歴は積まない**（名前は変わっていない。
 * 下記）。
 *
 * ## 名前が変わったら、履歴を同じ batch で 1 行積む（#405）
 *
 * **通報された作者が名前を変えると、なりすましの証拠が消える。** 審査キューが通報の時点の
 * 名前を復元できるよう、`display_name_changes`（`migrations/0030`）へ旧い名前と新しい名前を
 * 積む。**履歴と UPDATE は 1 つの `D1.batch` で、条件の綴りを共有する**
 * （`src/display-name-changes.ts`）——**間隔で断った要求では履歴も 0 行になり**、履歴の
 * insert が落ちれば名前も変わらない（`test/account.test.ts` が両方を見る）。
 *
 * **BAN の検査はここに無い。** 呼び出し側（{@link handleDisplayNameChange}）が
 * `resolveSessionUser` を通した後にしか呼ばない。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @param name 検査済みの表示名（{@link validateDisplayName} の `value`）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いたか、間隔が足りずに断ったか
 */
export async function changeDisplayName(
  db: D1Database,
  userId: string,
  name: string,
  nowSeconds: number,
): Promise<DisplayNameChange> {
  // **条件の綴りを 1 つにする**（`src/games.ts` の `renameGame` と同じ理由）。履歴の文と
  // UPDATE が同じ条件を見るので、**間隔で断った要求では履歴も 0 行になる**（#405）。
  const conditions = 'id = ? and (display_name_set_at is null or display_name_set_at <= ?)';
  const bindings = [userId, nowSeconds - DISPLAY_NAME_CHANGE_INTERVAL_SECONDS] as const;

  const results = await db.batch([
    // **履歴を先に積む**（旧い名前は UPDATE の前の行からしか取れない。名前が変わらない
    // 入れ直しでは積まない。`src/display-name-changes.ts`）。
    displayNameHistoryInsert(db, {
      where: conditions,
      bindings,
      newName: name,
      changedAt: nowSeconds,
    }),
    db
      .prepare(`update users set display_name = ?, display_name_set_at = ? where ${conditions}`)
      .bind(name, nowSeconds, ...bindings),
  ]);

  // **添字で読む**（`noUncheckedIndexedAccess`。`src/games.ts` の `renameGame` と同じ形）。
  const historyRows = results[0]?.meta.changes ?? 0;
  const updatedRows = results[1]?.meta.changes ?? 0;
  if (historyRows > 0 && updatedRows === 0) {
    // **構造上ありえない**（履歴の条件は UPDATE の条件を含み、同じ batch で同じ行を見る）。
    // 出るとすれば D1 の batch の意味が変わったときで、それは気づきたい。
    console.error('[account] 名前を変えていないのに表示名の履歴が入りました（batch の意味が変わっています）');
  }
  // 0 行なら間隔が足りない。**利用者が居ない場合も 0 行になる**が、直前に
  // `resolveSessionUser` が行の存在を確かめているので、ここで区別しない。
  return updatedRows > 0 ? { ok: true } : { ok: false, reason: 'too-soon' };
}

/**
 * 変更の結果として `/account` へ運ぶ分類。
 *
 * **query に載るのはこの綴りだけである。** 画面はこれを表（{@link REASON_MESSAGES}）で
 * 固定の文言へ引き直し、**値そのものは出力へ通さない**（`src/invite-issuance.ts` と
 * 同じ方針。未知の値を通すと反射型の差し込みになる）。
 */
export type AccountReason =
  | DisplayNameRejection
  | 'too-soon'
  | 'invalid-request'
  | 'failed'
  | ProfileRejection
  | AvatarRejection;

/**
 * 分類ごとの文言。
 *
 * **ステータスを分岐の式で書かない**（`src/publish.ts` の `BODY_REFUSALS` と同じ理由）。
 */
const REASON_MESSAGES: Readonly<Record<AccountReason, string>> = {
  empty: '表示名を入力してください（空白だけの名前は使えません）。',
  'too-long': `表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字までです。`,
  // 向きを変える書式文字は目に見えないので、**「見えない文字」と言わないと利用者は
  // 何を消せばよいか分からない**（コピーした名前に紛れていることがある）。
  'control-char':
    '表示名に改行やタブなどの制御文字、文字の向きを変える目に見えない記号は使えません。',
  // **待てば通ることを言う。** 「変更できませんでした」だけだと、利用者は壊れていると
  // 読んで押し続ける——それは間隔を置いた理由（書き込みを増やさない）と逆向きである。
  'too-soon': `表示名の変更は ${DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  'invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  failed: '表示名を変更できませんでした。時間をおいてもう一度お試しください。',
  // 自己紹介と外部リンクの理由（#379）。**綴りは表示名の理由と重ならない**（`bio-` / `link-` /
  // `profile-` の接頭辞）ので、同じ query の名前へ載せても取り違えない。
  ...PROFILE_REASON_MESSAGES,
  // アイコンの理由（#380）。**綴りは `avatar-` で始まる**ので、上の理由と取り違えない。
  ...AVATAR_REASON_MESSAGES,
};

/** 未知の分類を受けたときの文言。 */
const DEFAULT_REASON_MESSAGE = '表示名を変更できませんでした。';

/**
 * 変更できたことを示す query の名前（`/account?saved=1`）。
 *
 * **成功と失敗を同じ `reason` に混ぜない。** 失敗の画面は 400 で返す
 * （{@link showAccount}）ので、同じ名前に載せると成功まで 400 になる。
 */
const SAVED_QUERY = 'saved';

/**
 * 自己紹介と外部リンクを保存できたことを示す値（`/account?saved=profile`。#379）。
 *
 * **表示名の `saved=1` と値で分ける。** 同じ値にすると、自己紹介を保存した人に
 * 「表示名を変更しました」と出る。
 */
const SAVED_PROFILE_VALUE = 'profile';

/** アイコンを設定できたことを示す値（`/account?saved=avatar`。#380）。 */
const SAVED_AVATAR_VALUE = 'avatar';

/** アイコンを外せたことを示す値（`/account?saved=avatar-removed`。#380）。 */
const SAVED_AVATAR_REMOVED_VALUE = 'avatar-removed';

/**
 * 分類から画面に出す文言を選ぶ。
 *
 * @param reason query から受け取った分類
 * @returns 画面に出す文言
 */
function reasonMessage(reason: string): string {
  return Object.hasOwn(REASON_MESSAGES, reason)
    ? REASON_MESSAGES[reason as AccountReason]
    : DEFAULT_REASON_MESSAGE;
}

/** 画面の上部に出す知らせ。 */
export type AccountNotice =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'saved' }
  | { readonly kind: 'saved-profile' }
  | { readonly kind: 'saved-avatar' }
  | { readonly kind: 'removed-avatar' };

/** プロフィールのタブ（`/account`）を組み立てるのに必要なものだけを集めた入力。 */
export interface AccountView {
  /** 利用者の id（自分の作者ページへのリンクに使う）。 */
  readonly userId: string;
  /** 表示名（`users.display_name`）。**利用者の入力であり、エスケープして出す。** */
  readonly displayName: string;
  /** 表示名を決めた時刻（`users.display_name_set_at`）。NULL なら Google に追随している。 */
  readonly displayNameSetAt: number | null;
  /** 自己紹介と外部リンクのフォームに入れる値（#379）。 */
  readonly profile: ProfileFormView;
  /** アイコンのフォームに入れる値（#380）。 */
  readonly avatar: AvatarFormView;
  /** ヘッダのアバターの画像の URL（`src/html.ts` の `headerAvatarUrl`。#380）。 */
  readonly headerAvatar: string | null;
  /** 上部に出す知らせ（無ければ null）。 */
  readonly notice: AccountNotice | null;
}

/** アカウントのタブ（`/account/details`）を組み立てるのに必要なものだけを集めた入力。 */
export interface AccountDetailsView {
  /** メールアドレス（`users.email`）。**本人にだけ出す。** */
  readonly email: string;
  /** 登録した時刻（`users.created_at`。UNIX 秒）。 */
  readonly createdAt: number;
  /** ヘッダのアバターの画像の URL（#380）。 */
  readonly headerAvatar: string | null;
}

/**
 * 登録日を日本時間の `YYYY-MM-DD` にする。
 *
 * **仕様 2.3.1 / 5.9 は「登録日」と言っている**ので、時刻までは出さない。表記の正本は
 * `src/jst.ts` の `formatJstMinutes` で、その先頭 10 文字（日付部分）を取る。
 * 読めない値では空文字が返り、ここも空になる。
 *
 * @param epochSeconds UNIX 秒
 * @returns 日付（読めない値なら空文字）
 */
function formatJstDate(epochSeconds: number): string {
  return formatJstMinutes(epochSeconds).slice(0, 10);
}

/**
 * 登録情報の画面の外枠（見出しとタブ）を組み立てる（#379）。
 *
 * **タブの画面はすべてこれを通す**（冒頭の「タブはパスで分ける」）。**`noindex` を付ける。**
 * 本人にしか出ない画面である（`src/my-works.ts` と同じ扱い）。**ログイン済みとして組む**
 * （2.3.7 / #331）。ログアウトはヘッダのアカウントのメニューが持つ（冒頭。#372）。
 *
 * **タブは `<nav>` のリンクで、`role="tablist"` にしない。** 押すと別の URL の画面へ移る
 * 普通のリンクであり、WAI-ARIA のタブ（同じ画面の中で中身を切り替える部品）とは振る舞いが
 * 違う。**いま開いているタブには `aria-current="page"` を付けてリンクにしない**
 * （パンくずの末尾と同じ扱い。自分自身へのリンクを置かない）。
 *
 * **見た目はタブの部品（`.gf-tabs`。仕様 2.5.5「タブ」）**で、いま開いているタブに下線 2px と太字が付く（#473）。並べ替えの
 * タブ（`src/works-list.ts`）と同じ見た目である。
 *
 * @param options 画面のパス・`<title>`・本文
 * @returns HTML
 */
export function accountShell(options: {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  /** ヘッダのアバターの画像の URL（#380。**必須にする**——タブを足す人が渡し忘れない）。 */
  readonly headerAvatar: string | null;
}): string {
  const tabs = ACCOUNT_TABS.map((tab) =>
    tab.path === options.path
      ? `<li><span aria-current="page">${escapeHtml(tab.label)}</span></li>`
      : `<li><a href="${escapeHtml(tab.path)}">${escapeHtml(tab.label)}</a></li>`,
  ).join('\n  ');
  return `${siteHead({
    title: options.title,
    noindex: true,
    viewer: siteViewerAt(options.path, true, options.headerAvatar),
  })}
<h1>登録情報</h1>
<nav class="gf-account-tabs" aria-label="登録情報の項目">
<ul class="gf-tabs">
  ${tabs}
</ul>
</nav>
${options.body}
${siteFooter()}`;
}

/**
 * 登録情報の画面（プロフィールのタブ。`/account`）を組み立てる。
 *
 * **D1 から来る値（表示名・自己紹介・リンク）は、すべて `escapeHtml` を通す。** 表示名は
 * 属性値（`value="..."`）へ入るので、`"` を含む名前が属性を閉じて要素を差し込む形になりうる。
 * `escapeHtml` は `"` と `'` まで置き換える（`src/html.ts`）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAccountPage(view: AccountView): string {
  const notice =
    view.notice === null
      ? ''
      : view.notice.kind === 'saved'
        ? '<p class="gf-block" role="status">表示名を変更しました。</p>'
        : view.notice.kind === 'saved-profile'
          ? '<p class="gf-block" role="status">自己紹介と外部リンクを保存しました。</p>'
          : view.notice.kind === 'saved-avatar'
            ? '<p class="gf-block" role="status">アイコンを設定しました。</p>'
            : view.notice.kind === 'removed-avatar'
              ? '<p class="gf-block" role="status">アイコンを外しました。</p>'
              : // 文言は表から選んだ固定文字列だが、`escapeHtml` を通しておく
            // （`src/invite-issuance.ts` と同じ理由。出どころが変わっても安全側が既定になる）。
            `<p class="error" role="alert">${escapeHtml(view.notice.message)}</p>`;

  // **追随しているかどうかを言う。** 変えない限りログインのたびに Google の名前へ
  // 合わせる、という振る舞いは画面の外からは見えない。決めた後は「戻らない」ことを言う
  // （5.9 は「Google の名前に戻す」ボタンを持たない。戻したければ同じ名前を入れる）。
  const following =
    view.displayNameSetAt === null
      ? '<p>いまは Google アカウントの名前をそのまま使っています。ここで変更するまでは、ログインのたびに Google 側の名前に合わせます。</p>'
      : '<p>この名前はあなたが決めたものです。ログインしても Google アカウントの名前には戻りません。</p>';

  // **表示名・アイコン・自己紹介と外部リンクを、1 つずつ面のブロックにする**（仕様 2.5.4 / #473。承認したモックアップ Version 6）。
  // **保存のボタンはすべて副で、この画面に主を置かない**（#473 の scope.in。フォームが 3 つ並ぶ画面で、どれか 1 つだけを
  // 「いちばんしてほしいこと」にしない）。**変更の完了の知らせもブロック**である。ブロックの並べ方（広い段で 2 列）は
  // app.css の `@section account` の `.gf-account-blocks` が持ち、**並びは HTML の順**（表示名 → アイコン → 自己紹介）のまま。
  //
  // **表示名の欄の上に見出し（`<h2>`）を置かない。** 表示名の欄は `<label>` が名前を持っており、
  // 上に同じ語の見出しを置くと「表示名 / 表示名」と 2 度並ぶ（撮影で確かめた）。
  //
  // **`maxlength` を付けない。** HTML の `maxlength` は UTF-16 の長さで数えるので、
  // こちらの規則（コードポイントで 30）と食い違い、絵文字を含む名前が 30 文字に
  // 届く前に打てなくなる。長さは送信後に 1 つの規則で断る（{@link validateDisplayName}）。
  return accountShell({
    path: ACCOUNT_PATH,
    title: '登録情報 - Game Forge',
    headerAvatar: view.headerAvatar,
    body: `${notice}
<div class="gf-account-blocks">
<div class="gf-block gf-account-block">
<form method="post" action="${ACCOUNT_DISPLAY_NAME_PATH}">
  <label for="display-name">表示名</label>
  <input id="display-name" name="${DISPLAY_NAME_FIELD}" type="text" autocomplete="nickname"
         value="${escapeHtml(view.displayName)}" required>
  <p>前後の空白を除いて ${DISPLAY_NAME_MAX_LENGTH} 文字まで。改行は使えません。ほかの人と同じ名前でもかまいません。</p>
  <button type="submit" class="gf-button gf-button-secondary">表示名を変更する</button>
</form>
${following}
<p>表示名は作品ページや作品の一覧に出て、ログインしていない人にも見えます。</p>
</div>
<section class="gf-block gf-account-block" aria-labelledby="account-avatar-heading">
${renderAvatarForm(view.avatar)}
</section>
<section class="gf-block gf-account-block" aria-labelledby="account-profile-heading">
${renderProfileForm(view.profile)}
</section>
</div>
<p class="gf-account-author"><a class="gf-button gf-button-secondary gf-button-sm" href="${escapeHtml(authorPagePath(view.userId))}">自分の作者ページを見る</a></p>`,
  });
}

/**
 * 登録情報の画面（アカウントのタブ。`/account/details`）を組み立てる（#379）。
 *
 * **D1 から来る値はメールアドレスで、`escapeHtml` を通す。** 中身は #379 より前に `/account` の
 * 末尾にあったものを移しただけである。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAccountDetailsPage(view: AccountDetailsView): string {
  // **読めない日時では `<time>` ごと落とす**（`src/my-works.ts` と同じ扱い。`datetime=""` は不正）。
  const iso = toIsoTimestamp(view.createdAt);
  const created = iso === '' ? '不明' : `<time datetime="${iso}">${formatJstDate(view.createdAt)}</time>`;
  return accountShell({
    path: ACCOUNT_DETAILS_PATH,
    title: 'アカウント - Game Forge',
    headerAvatar: view.headerAvatar,
    body: `<dl class="gf-account">
  <dt>メールアドレス</dt>
  <dd>${escapeHtml(view.email)}</dd>
  <dt>登録日</dt>
  <dd>${created}</dd>
</dl>
<p>メールアドレスはあなたにだけ表示しています。ほかの人には見えません。</p>
<p>ログインには Google アカウントを使っています。メールアドレスは、ログインのたびに Google アカウントのものに合わせます。</p>`,
  });
}

/**
 * 303 See Other を返す。
 *
 * 302 ではなく 303 を使う理由は `src/invite-issuance.ts` と同じで、302 は POST を
 * POST のまま追う余地がある。**変更の再送は間隔の判定に当たって断られる**ので実害は
 * 小さいが、断られた知らせが出て利用者を混乱させる。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/** 登録情報の画面（プロフィールのタブ）が読む `users` の列。 */
interface AccountRow {
  readonly display_name: string;
  readonly display_name_set_at: number | null;
  readonly bio: string;
  readonly profile_links: string;
  readonly avatar_sha256: string | null;
  readonly avatar_set_at: number | null;
}

/**
 * プロフィールのタブに要る本人の行を引く。
 *
 * **引くのは本人の行だけである**（`where id = ?` にセッションの id を束縛する）。
 * **メールアドレスを選ばない**——この画面には出さない（アカウントのタブが引く）。
 *
 * @param env バインディングと環境変数
 * @param userId セッションの利用者 id
 * @returns 行（無ければ null）
 */
async function loadAccountRow(env: Env, userId: string): Promise<AccountRow | null> {
  return await env.DB.prepare(
    'select display_name, display_name_set_at, bio, profile_links, avatar_sha256, avatar_set_at from users where id = ?',
  )
    .bind(userId)
    .first<AccountRow>();
}

/**
 * 登録情報の画面に出すアイコンの値（版つきの URL）を組み立てる（#380）。
 *
 * **版を付ける**——設定した直後の画面は新しい `avatar_set_at` を持つので、ブラウザの古いキャッシュに
 * 当たらない（`src/avatar-delivery.ts`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @param row アカウントの行
 * @returns フォームに入れる値
 */
function avatarFormViewOf(request: Request, env: Env, userId: string, row: AccountRow): AvatarFormView {
  if (row.avatar_sha256 === null || row.avatar_set_at === null) {
    return { url: null };
  }
  return { url: avatarUrl(sandboxOriginOf(request, env.SANDBOX_HOST), userId, row.avatar_set_at) };
}

/**
 * 登録情報の画面（プロフィールのタブ）を返す。
 *
 * **未ログインならログインへ送る**（`src/my-works.ts` の `showMyWorks` と同じ扱い）。
 * 401 を返しても、画面を開いた利用者にできることは結局ログインである。
 *
 * **引くのは本人の行だけである**（`where id = ?` にセッションの id を束縛する）。
 * メールアドレスを本人以外に出さないことは、この 1 行が担っている。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showAccount(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // ログイン後はこの画面へ戻す（2.3.11 / #374）。戻り先は署名付きの一時 cookie が
    // 運ぶ（query では受けない）。
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }

  const row = await loadAccountRow(env, session.userId);
  if (row === null) {
    // 解決の直後に行が消えた（手動の削除など）。`resolveSessionUser` が居ないと
    // 答えたときと同じ扱いにする。
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }

  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  const saved = params.get(SAVED_QUERY);
  const notice: AccountNotice | null =
    reason !== null
      ? { kind: 'error', message: reasonMessage(reason) }
      : saved === SAVED_PROFILE_VALUE
        ? { kind: 'saved-profile' }
        : saved === SAVED_AVATAR_VALUE
          ? { kind: 'saved-avatar' }
          : saved === SAVED_AVATAR_REMOVED_VALUE
            ? { kind: 'removed-avatar' }
            : saved !== null
              ? { kind: 'saved' }
              : null;

  return html(
    renderAccountPage({
      userId: session.userId,
      displayName: row.display_name,
      displayNameSetAt: row.display_name_set_at,
      // **表示の直前の検査を通したリンクだけを欄へ入れる**（`src/profile.ts`）。
      profile: { bio: row.bio ?? '', links: parseStoredProfileLinks(row.profile_links) },
      avatar: avatarFormViewOf(request, env, session.userId, row),
      headerAvatar: headerAvatarUrl(request, env, session.userId),
      notice,
    }),
    // 失敗の後始末で開かれた画面には、失敗のステータスを付ける（`src/invite-issuance.ts`
    // の `GET /invites?reason=` と同じ扱い）。成功したかのようにログへ残さない。
    reason === null ? 200 : 400,
  );
}

/** 本文から取り出した表示名。 */
type DisplayNameInput =
  | { readonly ok: true; readonly raw: string }
  | { readonly ok: false; readonly reason: 'too-long' | 'invalid-request' };

/**
 * 本文から表示名を取り出す。
 *
 * **受けるのは素のフォームだけである。** この口を叩くのは `/account` のフォームだけで、
 * `fetch` から呼ぶ画面は無い（`src/publish.ts` が JSON も受けるのは、作品ページの
 * スクリプトが呼ぶためである）。**呼ぶ側が無い形式のために解析の経路を増やさない。**
 *
 * 項目が無い本文は空の名前として扱う（`empty` で断られる）。
 *
 * @param request 受信したリクエスト
 * @returns 表示名（未検査）、または理由
 */
async function readDisplayName(request: Request): Promise<DisplayNameInput> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return { ok: false, reason: 'invalid-request' };
  }

  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    // **大きすぎる本文は「長すぎる名前」として返す。** 載るのは名前 1 つだけなので、
    // 上限を超えるのは長い名前を打った場合である（{@link MAX_BODY_BYTES}）。
    return { ok: false, reason: read.reason === 'body-too-large' ? 'too-long' : 'invalid-request' };
  }
  return { ok: true, raw: new URLSearchParams(read.text).get(DISPLAY_NAME_FIELD) ?? '' };
}

/**
 * 表示名を変更する。**終わったら必ず `/account` へ戻す**（5.9。POST-redirect-GET）。
 *
 * 断った理由は `/account?reason=...` で運ぶ。**断った要求は書き込まない**——検査で
 * 断ったものは D1 に触れず、間隔で断ったものは 0 行の更新で終わる
 * （{@link changeDisplayName}）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleDisplayNameChange(
  request: Request,
  env: Env,
  now: () => number,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // ログイン後はこの画面へ戻す（2.3.11 / #374）。戻り先は署名付きの一時 cookie が
    // 運ぶ（query では受けない）。
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }

  const input = await readDisplayName(request);
  if (!input.ok) {
    return seeOther(`${ACCOUNT_PATH}?reason=${input.reason}`);
  }

  const validated = validateDisplayName(input.raw);
  if (!validated.ok) {
    return seeOther(`${ACCOUNT_PATH}?reason=${validated.reason}`);
  }

  try {
    const changed = await changeDisplayName(env.DB, session.userId, validated.value, now());
    return seeOther(
      changed.ok ? `${ACCOUNT_PATH}?${SAVED_QUERY}=1` : `${ACCOUNT_PATH}?reason=${changed.reason}`,
    );
  } catch (error) {
    // D1 の失敗（接続不良など）。「間隔が足りない」と混同しないよう別の分類にする。
    // **名前はログに出さない**（利用者の入力であり、ここで残す理由が無い）。
    console.error(
      `[account] 表示名の変更に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return seeOther(`${ACCOUNT_PATH}?reason=failed`);
  }
}

/**
 * 登録情報の画面（アカウントのタブ）を返す（#379）。
 *
 * **引くのは本人の行だけである**（{@link showAccount} と同じ。メールアドレスを本人以外に
 * 出さないことは、この 1 行が担っている）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showAccountDetails(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_DETAILS_PATH);
  }
  const row = await env.DB.prepare('select email, created_at from users where id = ?')
    .bind(session.userId)
    .first<{ email: string; created_at: number }>();
  if (row === null) {
    return await loginRequiredRedirect(env, ACCOUNT_DETAILS_PATH);
  }
  return html(
    renderAccountDetailsPage({
      email: row.email,
      createdAt: row.created_at,
      headerAvatar: headerAvatarUrl(request, env, session.userId),
    }),
  );
}

/**
 * 自己紹介と外部リンクの本文の最大バイト数（#379）。
 *
 * **16 KiB。** 載るのは自己紹介（500 文字）とリンク 3 本（1 本 500 文字）で、4 バイト文字を
 * パーセント符号化すると 1 文字 12 バイトになる（自己紹介だけで 6,000 バイト）。上限そのものは
 * 本文を際限なく読まないために置く。**超えたら `profile-too-large` で断る**（どの欄が長いかは
 * 読まないと分からない）。
 */
const MAX_PROFILE_BODY_BYTES = 16 * 1024;

/**
 * 断った自己紹介と外部リンクを、送られた値を入れたままの画面で返す（#379。冒頭）。
 *
 * @param request 受信したリクエスト（アイコンの URL のスキームとポートを借りる。#380）
 * @param env バインディングと環境変数
 * @param userId セッションの利用者 id
 * @param reason 断った理由
 * @param submitted 送られた値（欄へ戻す）
 * @param status 返すステータス
 * @returns レスポンス
 */
async function profileRefusal(
  request: Request,
  env: Env,
  userId: string,
  reason: ProfileRejection,
  submitted: ProfileFormView,
  status: number,
): Promise<Response> {
  const row = await loadAccountRow(env, userId);
  if (row === null) {
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }
  return html(
    renderAccountPage({
      userId,
      displayName: row.display_name,
      displayNameSetAt: row.display_name_set_at,
      profile: submitted,
      avatar: avatarFormViewOf(request, env, userId, row),
      headerAvatar: headerAvatarUrl(request, env, userId),
      notice: { kind: 'error', message: reasonMessage(reason) },
    }),
    status,
  );
}

/**
 * 自己紹介と外部リンクを保存する（`POST /api/account/profile`。#379 / 5.10）。
 *
 * - **保存できたら `/account?saved=profile` へ戻す**（POST-redirect-GET）
 * - **形の検査・8.3・間隔で断ったら、送られた値を入れた画面をその場で返す**（冒頭）。
 *   間隔は 429、それ以外は 400
 * - **本文を読めない（形式が違う・大きすぎる）ときは `/account?reason=` へ送る**——戻す値が無い
 *
 * **断った要求は書き込まない**——検査で断ったものは D1 に触れず、間隔で断ったものは 0 行の
 * 更新で終わる（`src/profile.ts` の `changeProfile`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleProfileChange(
  request: Request,
  env: Env,
  now: () => number,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }

  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return seeOther(`${ACCOUNT_PATH}?reason=invalid-request`);
  }
  const read = await readLimitedText(request, MAX_PROFILE_BODY_BYTES);
  if (!read.ok) {
    return seeOther(
      `${ACCOUNT_PATH}?reason=${read.reason === 'body-too-large' ? 'profile-too-large' : 'invalid-request'}`,
    );
  }
  const params = new URLSearchParams(read.text);
  const rawBio = params.get(BIO_FIELD) ?? '';
  const rawLinks = params.getAll(PROFILE_LINK_FIELD);
  // 欄へ戻す値。空の欄を詰め、画面の欄の数だけにする（手で組んだ 4 本目以降は戻さない）。
  const submitted: ProfileFormView = {
    bio: rawBio,
    links: rawLinks.map((link) => link.trim()).filter((link) => link !== ''),
  };

  const validated = validateProfile(rawBio, rawLinks);
  if (!validated.ok) {
    return await profileRefusal(request, env, session.userId, validated.reason, submitted, 400);
  }

  try {
    const changed = await changeProfile(env.DB, session.userId, validated.profile, now());
    if (changed.ok) {
      return seeOther(`${ACCOUNT_PATH}?${SAVED_QUERY}=${SAVED_PROFILE_VALUE}`);
    }
    return await profileRefusal(
      request,
      env,
      session.userId,
      changed.reason,
      submitted,
      changed.reason === 'profile-too-soon' ? 429 : 400,
    );
  } catch (error) {
    // D1 の失敗。**入力はログに出さない**（利用者の入力であり、ここで残す理由が無い）。
    console.error(
      `[account] 自己紹介と外部リンクの保存に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return seeOther(`${ACCOUNT_PATH}?reason=profile-failed`);
  }
}

/**
 * 改造通知を受け取らない設定にしてから、受け取る設定へ戻せるようになるまでの秒数（#384 / 3.6）。
 *
 * **連打で D1 の書き込みを増やさないための間隔である**（表示名の
 * {@link DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} と同じ理由）。**1 列（止めた時刻）で絞るので、
 * 間隔を置けるのは戻す側だけである**——止める・戻すの 1 往復が 60 秒に 1 回へ絞られ、1 人が
 * 1 日張り付いても 2,880 行に収まる（無料枠 10 万行/日 の 2.9%）。
 */
export const FORK_NOTICE_UNMUTE_INTERVAL_SECONDS = 60;

/** メール配信の設定の書き込みの結果。 */
export type ForkNoticePreferenceChange =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'too-soon' };

/**
 * 改造通知を受け取るかどうかを書き込む（#384 / 5.11）。
 *
 * ## 断った要求と、同じ値の入れ直しは書き込まない
 *
 * **判定を `WHERE` に置く**（{@link changeDisplayName} と同じ理由）。
 *
 * - **止める**: `fork_notice_muted_at is null` の行だけを書く（既に止めていれば 0 行）
 * - **戻す**: `fork_notice_muted_at <= 現在 - 60 秒` の行だけを書く（受け取っていれば NULL で
 *   当たらず 0 行、止めたばかりなら 0 行）
 *
 * **0 行だったときだけ、理由を分けるために 1 回読む。** 「戻したいのに、止めたままの行がある」なら
 * 間隔が足りない。それ以外は、望んだ状態が既にそうなっている（成功として返す）。読みと書きの間に
 * 別の要求が入っても、**書き込みの判定は WHERE が済ませてある**ので、ずれるのは知らせの文言だけである。
 *
 * **BAN の検査はここに無い。** 呼び出し側（{@link handleForkNoticePreference}）が
 * `resolveSessionUser` を通した後にしか呼ばない。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @param receive 受け取るなら true
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いた（または既にそうなっていた）か、間隔が足りずに断ったか
 */
export async function changeForkNoticePreference(
  db: D1Database,
  userId: string,
  receive: boolean,
  nowSeconds: number,
): Promise<ForkNoticePreferenceChange> {
  const result = receive
    ? await db
        .prepare(
          `update users set fork_notice_muted_at = null
            where id = ? and fork_notice_muted_at is not null and fork_notice_muted_at <= ?`,
        )
        .bind(userId, nowSeconds - FORK_NOTICE_UNMUTE_INTERVAL_SECONDS)
        .run()
    : await db
        .prepare(
          'update users set fork_notice_muted_at = ? where id = ? and fork_notice_muted_at is null',
        )
        .bind(nowSeconds, userId)
        .run();
  if ((result.meta.changes ?? 0) > 0 || !receive) {
    // 止める側の 0 行は「既に止めている」だけである（止める側に間隔は無い）。
    return { ok: true };
  }
  const row = await db
    .prepare('select fork_notice_muted_at from users where id = ?')
    .bind(userId)
    .first<{ fork_notice_muted_at: number | null }>();
  return row !== null && row.fork_notice_muted_at !== null
    ? { ok: false, reason: 'too-soon' }
    : { ok: true };
}

/**
 * メール配信のタブへ運ぶ分類（`/account/mail?reason=`）。
 *
 * **query に載るのはこの綴りだけである**（{@link AccountReason} と同じ方針。値そのものは出さない）。
 */
export type MailPreferenceReason = 'too-soon' | 'invalid-request' | 'failed';

/** 分類ごとの文言（メール配信のタブ）。 */
const MAIL_REASON_MESSAGES: Readonly<Record<MailPreferenceReason, string>> = {
  // **待てば通ることを言う**（表示名の `too-soon` と同じ理由）。
  'too-soon': `受け取らない設定にしてから ${FORK_NOTICE_UNMUTE_INTERVAL_SECONDS} 秒のあいだは、受け取る設定に戻せません。少し待ってからもう一度お試しください。`,
  'invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  failed: 'メール配信の設定を保存できませんでした。時間をおいてもう一度お試しください。',
};

/** 未知の分類を受けたときの文言（メール配信のタブ）。 */
const DEFAULT_MAIL_REASON_MESSAGE = 'メール配信の設定を保存できませんでした。';

/** メール配信のタブ（`/account/mail`）を組み立てるのに必要なものだけを集めた入力。 */
export interface AccountMailView {
  /** 改造通知を受け取るか（`users.fork_notice_muted_at` が NULL なら true）。 */
  readonly receiveForkNotice: boolean;
  /** 上部に出す知らせ（無ければ null）。 */
  readonly notice: { readonly kind: 'error'; readonly message: string } | { readonly kind: 'saved' } | null;
  /** ヘッダのアバターの画像の URL（#380）。 */
  readonly headerAvatar: string | null;
}

/**
 * 登録情報の画面（メール配信のタブ。`/account/mail`）を組み立てる（#384 / 5.11）。
 *
 * **フォームは面のブロックで、「保存する」は副のボタン**（仕様 2.5.4 / 2.5.5 / #473。登録情報のタブは主を置かない）。
 *
 * **種別の名前と補足は `src/mail/kinds.ts` から出す**（冒頭の「メール配信のタブ」）。どれも
 * コードに置いた固定の文字列だが、`escapeHtml` を通しておく（出どころが変わっても安全側が既定になる）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAccountMailPage(view: AccountMailView): string {
  const notice =
    view.notice === null
      ? ''
      : view.notice.kind === 'saved'
        ? '<p class="gf-block" role="status">メール配信の設定を保存しました。</p>'
        : `<p class="error" role="alert">${escapeHtml(view.notice.message)}</p>`;

  const forkKind = MAIL_KINDS.find((kind) => kind.label === FORK_NOTICE_KIND_LABEL);
  const forkName = forkKind?.name ?? '改造のお知らせ';
  const forkNote = forkKind?.note ?? '';
  const choice = (value: string, label: string, checked: boolean): string =>
    `<label><input type="radio" name="${FORK_NOTICE_FIELD}" value="${value}"${checked ? ' checked' : ''}> ${label}</label>`;

  const unmutable = unmutableUserMailKinds()
    .map((kind) => `  <li><strong>${escapeHtml(kind.name)}</strong>: ${escapeHtml(kind.note)}</li>`)
    .join('\n');

  return accountShell({
    path: ACCOUNT_MAIL_PATH,
    title: 'メール配信 - Game Forge',
    headerAvatar: view.headerAvatar,
    body: `${notice}
<form class="gf-block" method="post" action="${ACCOUNT_MAIL_API_PATH}">
  <fieldset class="gf-mail-choice">
    <legend>${escapeHtml(forkName)}</legend>
    <p>${escapeHtml(forkNote)}</p>
    ${choice(FORK_NOTICE_RECEIVE, '受け取る', view.receiveForkNotice)}
    ${choice(FORK_NOTICE_MUTE, '受け取らない', !view.receiveForkNotice)}
  </fieldset>
  <p>受け取らない設定にしていたあいだに公開された改造は、あとで受け取る設定に戻してもお知らせしません。</p>
  <button type="submit" class="gf-button gf-button-secondary">保存する</button>
</form>
<p>お知らせは、<a href="${ACCOUNT_DETAILS_PATH}">アカウント</a>のタブに出ているメールアドレスへ送ります。</p>
<h2>設定にかかわらず送るメール</h2>
<p>次のメールは、上の設定にかかわらず送ります。</p>
<ul class="gf-mail-kinds">
${unmutable}
</ul>`,
  });
}

/**
 * 登録情報の画面（メール配信のタブ）を返す（#384）。
 *
 * **引くのは本人の行だけである**（{@link showAccount} と同じ）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showAccountMail(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_MAIL_PATH);
  }
  const row = await env.DB.prepare('select fork_notice_muted_at from users where id = ?')
    .bind(session.userId)
    .first<{ fork_notice_muted_at: number | null }>();
  if (row === null) {
    return await loginRequiredRedirect(env, ACCOUNT_MAIL_PATH);
  }

  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  const notice: AccountMailView['notice'] =
    reason !== null
      ? {
          kind: 'error',
          message: Object.hasOwn(MAIL_REASON_MESSAGES, reason)
            ? MAIL_REASON_MESSAGES[reason as MailPreferenceReason]
            : DEFAULT_MAIL_REASON_MESSAGE,
        }
      : params.get(SAVED_QUERY) !== null
        ? { kind: 'saved' }
        : null;

  return html(
    renderAccountMailPage({
      receiveForkNotice: row.fork_notice_muted_at === null,
      notice,
      headerAvatar: headerAvatarUrl(request, env, session.userId),
    }),
    reason === null ? 200 : 400,
  );
}

/**
 * メール配信の設定を保存する（`POST /api/account/mail`。#384 / 5.11）。**終わったら必ず
 * `/account/mail` へ戻す**（POST-redirect-GET）。
 *
 * **受けるのは素のフォームで、値は「受け取る」「受け取らない」の 2 つだけである。** 項目が無い・
 * 同じ項目が重なっている・知らない値は `invalid-request` で断り、D1 に触れない（「知らない値は受け取らない」と読むと、
 * 壊れた要求で通知が黙って止まる）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleForkNoticePreference(
  request: Request,
  env: Env,
  now: () => number,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_MAIL_PATH);
  }

  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return seeOther(`${ACCOUNT_MAIL_PATH}?reason=invalid-request`);
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return seeOther(`${ACCOUNT_MAIL_PATH}?reason=invalid-request`);
  }
  // **値がちょうど 1 つのときだけ受け付ける。** `fork_notice=receive&fork_notice=mute` のように
  // 同じ項目が重なった本文は、先頭を黙って採らずに断る——画面のラジオボタンは 1 つしか送らないので、
  // 重なった要求は壊れた要求である（`src/signup.ts` / `src/waitlist.ts` と同じ判断）。
  const values = new URLSearchParams(read.text).getAll(FORK_NOTICE_FIELD);
  const value = values.length === 1 ? values[0] : undefined;
  if (value !== FORK_NOTICE_RECEIVE && value !== FORK_NOTICE_MUTE) {
    return seeOther(`${ACCOUNT_MAIL_PATH}?reason=invalid-request`);
  }

  try {
    const changed = await changeForkNoticePreference(
      env.DB,
      session.userId,
      value === FORK_NOTICE_RECEIVE,
      now(),
    );
    return seeOther(
      changed.ok
        ? `${ACCOUNT_MAIL_PATH}?${SAVED_QUERY}=1`
        : `${ACCOUNT_MAIL_PATH}?reason=${changed.reason}`,
    );
  } catch (error) {
    console.error(
      `[account] メール配信の設定の保存に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return seeOther(`${ACCOUNT_MAIL_PATH}?reason=failed`);
  }
}

/**
 * アイコンを設定する（`POST /api/account/avatar`。#380 / 5.10）。
 *
 * **断ったら `/account?reason=avatar-…` へ送り直す**（POST-redirect-GET）。自己紹介と違って
 * 画面をその場で組み直さない——ファイルの入力欄は値を戻せない（ブラウザが許さない）ので、
 * 組み直しても利用者が選び直す手間は変わらない。**画像そのものはログにも URL にも載せない。**
 *
 * **判定の順**: ログイン → 本文の形と大きさ → 先頭のバイト → 排他（間隔を含む）→ 変換 → 保存。
 * **排他を変換の前に取る**——断る要求（二度押し・間隔）で Lambda を呼ばない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @param encode 変換の段（テストから差し替える）
 * @returns レスポンス
 */
async function handleAvatarUpload(
  request: Request,
  env: Env,
  now: () => number,
  encode: EncodeAvatar,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }
  const upload = await readAvatarUpload(request);
  if (!upload.ok) {
    return seeOther(`${ACCOUNT_PATH}?reason=${upload.reason}`);
  }
  const rejection = avatarUploadRejection(upload.bytes);
  if (rejection !== null) {
    return seeOther(`${ACCOUNT_PATH}?reason=${rejection}`);
  }

  try {
    // **変換の前に、D1 で利用者ごとの排他を取る**（`src/avatar.ts` の `acquireAvatarLock`）。二度押しの 2 本目は
    // ここで断られ、Lambda も R2 も触らない。間隔（60 秒）の判定もここに入っている。
    const locked = await acquireAvatarLock(env.DB, session.userId, now());
    if (!locked.ok) {
      return seeOther(`${ACCOUNT_PATH}?reason=${locked.reason}`);
    }
    const converted = await convertAvatar(env, upload.bytes, encode);
    if (!converted.ok) {
      // **R2 に何も書いていないので、排他を解くだけでよい**（間隔も進めない。混雑なら、すぐ上げ直せる）。
      await releaseAvatarLock(env.DB, locked.lock);
      return seeOther(`${ACCOUNT_PATH}?reason=${converted.reason}`);
    }
    // 保存は成功しても失敗しても排他を解いて戻る。
    const saved = await saveAvatar(env, locked.lock, converted.webp);
    return seeOther(
      saved.ok ? `${ACCOUNT_PATH}?${SAVED_QUERY}=${SAVED_AVATAR_VALUE}` : `${ACCOUNT_PATH}?reason=${saved.reason}`,
    );
  } catch (error) {
    // D1 / R2 の失敗。**画像はログに出さない。**
    console.error(`[account] アイコンの保存に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`);
    return seeOther(`${ACCOUNT_PATH}?reason=avatar-failed`);
  }
}

/**
 * アイコンを外す（`POST /api/account/avatar/remove`。#380）。
 *
 * **本文を読まない**（載せるものが無い）。**外した画像も 30 日だけ残す**（`src/avatar.ts`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleAvatarRemove(request: Request, env: Env, now: () => number): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_PATH);
  }
  try {
    const locked = await acquireAvatarLock(env.DB, session.userId, now());
    if (!locked.ok) {
      return seeOther(`${ACCOUNT_PATH}?reason=${locked.reason}`);
    }
    const removed = await removeAvatar(env, locked.lock);
    return seeOther(
      removed.ok
        ? `${ACCOUNT_PATH}?${SAVED_QUERY}=${SAVED_AVATAR_REMOVED_VALUE}`
        : `${ACCOUNT_PATH}?reason=${removed.reason}`,
    );
  } catch (error) {
    console.error(`[account] アイコンを外せませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return seeOther(`${ACCOUNT_PATH}?reason=avatar-failed`);
  }
}

/** {@link createAccountRoutes} に渡す差し替え。 */
export interface AccountRouteOptions {
  /** 現在時刻（UNIX 秒）。既定は `Date.now()` から。テストが 60 秒の境界を固定するために使う（表示名・プロフィール・メール配信）。 */
  readonly now?: () => number;
  /**
   * アイコンの変換の段（#380）。既定は Lambda の同期呼び出し（`src/avatar-client.ts`）。
   *
   * **テストが実 Lambda を呼ばずに、変換の結果（成功・断った・落ちた）を差し替えるために使う。**
   */
  readonly encodeAvatar?: EncodeAvatar;
}

/**
 * 登録情報の経路を組み立てる。
 *
 * **時刻を差し替えられるのはここだけである**（`src/publish.ts` の `createPublishRoutes` と
 * 同じ形）。アプリの経路表（`src/app.ts`）は既定の {@link accountRoutes} を連結するので、
 * 本番の結線は変わらない。
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createAccountRoutes(options: AccountRouteOptions = {}): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const encode = options.encodeAvatar ?? encodeAvatarOnLambda;
  return [
    { method: 'GET', path: ACCOUNT_PATH, handler: showAccount },
    { method: 'GET', path: ACCOUNT_DETAILS_PATH, handler: showAccountDetails },
    { method: 'GET', path: ACCOUNT_MAIL_PATH, handler: showAccountMail },
    {
      method: 'POST',
      path: ACCOUNT_DISPLAY_NAME_PATH,
      handler: (request, env) => handleDisplayNameChange(request, env, now),
    },
    {
      method: 'POST',
      path: ACCOUNT_PROFILE_PATH,
      handler: (request, env) => handleProfileChange(request, env, now),
    },
    {
      method: 'POST',
      path: ACCOUNT_MAIL_API_PATH,
      handler: (request, env) => handleForkNoticePreference(request, env, now),
    },
    {
      method: 'POST',
      path: ACCOUNT_AVATAR_PATH,
      handler: (request, env) => handleAvatarUpload(request, env, now, encode),
    },
    {
      method: 'POST',
      path: ACCOUNT_AVATAR_REMOVE_PATH,
      handler: (request, env) => handleAvatarRemove(request, env, now),
    },
  ];
}

/** アプリの経路表へ連結する登録情報の経路（#341 / #379 / #384 / #380）。 */
export const accountRoutes: readonly Route[] = createAccountRoutes();
