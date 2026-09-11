/**
 * 登録情報の画面（`/account`）と、表示名の変更（`POST /api/account/display-name`）。
 * **仕様 5.9 の実体である**（#341 / M9-6）。
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
 * **`<script>` も `"` も 30 文字に収まる。** ここで弾くのは長さと制御文字だけで、
 * HTML に効く文字は通す（通さない理由が無い——「<」を名前に含めたい人はいる）。
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
 */
import { ACCOUNT_DISPLAY_NAME_PATH, ACCOUNT_PATH, DISPLAY_NAME_FIELD } from './account-paths.js';
import { LOGIN_PATH } from './auth/google.js';
import { escapeHtml, siteHead } from './html.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import { siteFooter } from './legal.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';

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
 * 1 回の変更は 1 行の書き込みで、60 秒に 1 回なら 1 人が 1 日張り付いても 1,440 行に
 * 収まる（無料枠 10 万行/日 の 1.4%）。
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
  if (FORBIDDEN_CHARACTER.test(value)) {
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
 * 戻す」ボタンを持たないのと対になっている。
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
  const result = await db
    .prepare(
      `update users
          set display_name = ?, display_name_set_at = ?
        where id = ?
          and (display_name_set_at is null or display_name_set_at <= ?)`,
    )
    .bind(name, nowSeconds, userId, nowSeconds - DISPLAY_NAME_CHANGE_INTERVAL_SECONDS)
    .run();
  // 0 行なら間隔が足りない。**利用者が居ない場合も 0 行になる**が、直前に
  // `resolveSessionUser` が行の存在を確かめているので、ここで区別しない。
  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'too-soon' };
}

/**
 * 変更の結果として `/account` へ運ぶ分類。
 *
 * **query に載るのはこの綴りだけである。** 画面はこれを表（{@link REASON_MESSAGES}）で
 * 固定の文言へ引き直し、**値そのものは出力へ通さない**（`src/invite-issuance.ts` と
 * 同じ方針。未知の値を通すと反射型の差し込みになる）。
 */
export type AccountReason = DisplayNameRejection | 'too-soon' | 'invalid-request' | 'failed';

/**
 * 分類ごとの文言。
 *
 * **ステータスを分岐の式で書かない**（`src/publish.ts` の `BODY_REFUSALS` と同じ理由）。
 */
const REASON_MESSAGES: Readonly<Record<AccountReason, string>> = {
  empty: '表示名を入力してください（空白だけの名前は使えません）。',
  'too-long': `表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字までです。`,
  'control-char': '表示名に改行やタブなどの制御文字は使えません。',
  // **待てば通ることを言う。** 「変更できませんでした」だけだと、利用者は壊れていると
  // 読んで押し続ける——それは間隔を置いた理由（書き込みを増やさない）と逆向きである。
  'too-soon': `表示名の変更は ${DISPLAY_NAME_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。少し待ってからもう一度お試しください。`,
  'invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  failed: '表示名を変更できませんでした。時間をおいてもう一度お試しください。',
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
  | { readonly kind: 'saved' };

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface AccountView {
  /** 表示名（`users.display_name`）。**利用者の入力であり、エスケープして出す。** */
  readonly displayName: string;
  /** メールアドレス（`users.email`）。**本人にだけ出す。** */
  readonly email: string;
  /** 登録した時刻（`users.created_at`。UNIX 秒）。 */
  readonly createdAt: number;
  /** 表示名を決めた時刻（`users.display_name_set_at`）。NULL なら Google に追随している。 */
  readonly displayNameSetAt: number | null;
  /** 上部に出す知らせ（無ければ null）。 */
  readonly notice: AccountNotice | null;
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
 * 登録情報の画面を組み立てる。
 *
 * **D1 から来る値は表示名とメールアドレスの 2 つで、どちらも `escapeHtml` を通す。**
 * 表示名は属性値（`value="..."`）へ入るので、`"` を含む名前が属性を閉じて要素を
 * 差し込む形になりうる。`escapeHtml` は `"` と `'` まで置き換える（`src/html.ts`）。
 *
 * **`noindex` を付ける。** 本人にしか出ない画面である（`src/my-works.ts` と同じ扱い）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAccountPage(view: AccountView): string {
  const notice =
    view.notice === null
      ? ''
      : view.notice.kind === 'saved'
        ? '<p class="gf-notice" role="status">表示名を変更しました。</p>'
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

  // **読めない日時では `<time>` ごと落とす**（`src/my-works.ts` と同じ扱い。`datetime=""` は不正）。
  const iso = toIsoTimestamp(view.createdAt);
  const created = iso === '' ? '不明' : `<time datetime="${iso}">${formatJstDate(view.createdAt)}</time>`;

  // **見出し（`<h2>`）で区切らない。** 表示名の欄は `<label>` が名前を持っており、上に
  // 同じ語の見出しを置くと「表示名 / 表示名」と 2 度並ぶ（撮影で確かめた）。
  //
  // **`maxlength` を付けない。** HTML の `maxlength` は UTF-16 の長さで数えるので、
  // こちらの規則（コードポイントで 30）と食い違い、絵文字を含む名前が 30 文字に
  // 届く前に打てなくなる。長さは送信後に 1 つの規則で断る（{@link validateDisplayName}）。
  return `${siteHead({ title: '登録情報 - Game Forge', noindex: true })}
<h1>登録情報</h1>
${notice}
<form method="post" action="${ACCOUNT_DISPLAY_NAME_PATH}">
  <label for="display-name">表示名</label>
  <input id="display-name" name="${DISPLAY_NAME_FIELD}" type="text" autocomplete="nickname"
         value="${escapeHtml(view.displayName)}" required>
  <p>前後の空白を除いて ${DISPLAY_NAME_MAX_LENGTH} 文字まで。改行は使えません。ほかの人と同じ名前でもかまいません。</p>
  <button type="submit">表示名を変更する</button>
</form>
${following}
<p>表示名は作品ページや作品の一覧に出て、ログインしていない人にも見えます。</p>
<dl class="gf-account">
  <dt>メールアドレス</dt>
  <dd>${escapeHtml(view.email)}</dd>
  <dt>登録日</dt>
  <dd>${created}</dd>
</dl>
<p>メールアドレスはあなたにだけ表示しています。ほかの人には見えません。</p>
${siteFooter()}`;
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

/** 登録情報の画面が読む `users` の列。 */
interface AccountRow {
  readonly display_name: string;
  readonly email: string;
  readonly created_at: number;
  readonly display_name_set_at: number | null;
}

/**
 * 登録情報の画面を返す。
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
    return seeOther(LOGIN_PATH);
  }

  const row = await env.DB.prepare(
    'select display_name, email, created_at, display_name_set_at from users where id = ?',
  )
    .bind(session.userId)
    .first<AccountRow>();
  if (row === null) {
    // 解決の直後に行が消えた（手動の削除など）。`resolveSessionUser` が居ないと
    // 答えたときと同じ扱いにする。
    return seeOther(LOGIN_PATH);
  }

  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  const notice: AccountNotice | null =
    reason !== null
      ? { kind: 'error', message: reasonMessage(reason) }
      : params.get(SAVED_QUERY) !== null
        ? { kind: 'saved' }
        : null;

  return html(
    renderAccountPage({
      displayName: row.display_name,
      email: row.email,
      createdAt: row.created_at,
      displayNameSetAt: row.display_name_set_at,
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
    return seeOther(LOGIN_PATH);
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

/** {@link createAccountRoutes} に渡す差し替え。 */
export interface AccountRouteOptions {
  /** 現在時刻（UNIX 秒）。既定は `Date.now()` から。テストが 60 秒の境界を固定するために使う。 */
  readonly now?: () => number;
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
  return [
    { method: 'GET', path: ACCOUNT_PATH, handler: showAccount },
    {
      method: 'POST',
      path: ACCOUNT_DISPLAY_NAME_PATH,
      handler: (request, env) => handleDisplayNameChange(request, env, now),
    },
  ];
}

/** アプリの経路表へ連結する登録情報の経路（#341）。 */
export const accountRoutes: readonly Route[] = createAccountRoutes();
