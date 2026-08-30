/**
 * 登録画面と、招待コードの検証を先に置くフロー（8.1 / 2.2-4 / 10.2）。
 *
 * 8.1 は登録フローを **「招待コードの検証が先、Google OAuth が後」** と定める。
 * 逆にすると、無効なコードしか持たない利用者にログインだけさせて弾くことになる。
 * この画面がその順序を作る入口で、コードが通らないかぎり認可要求を組み立てない。
 *
 * **画面側の検査だけを頼りにしていない。** `GET /auth/google/start` から素の
 * ログインへ入る経路は常にあるため、*アカウントを作る側*（`src/auth/google.ts` の
 * `resolveUser`）でも招待の有無を条件にしている。片方だけでは、画面を経由しない
 * 要求で登録できてしまう。
 *
 * ## 画面を Worker から返す理由
 *
 * 9.3 は「API を `/api/*` に置くなら Pages Functions を使う。ここは M2-1 の実装時に
 * 確定する」としている。M1 で Next.js / Pages の雛形を置くと、その判断を先取りして
 * 手戻りになる。素の HTML を返す形なら、後からどちらへ寄せても捨てる量が小さい。
 *
 * ## JavaScript を要求しない
 *
 * フォームは素の `<form method="post">` で、送信は `application/x-www-form-urlencoded`
 * になる。登録は「招待制のクローズドβに入る」ための唯一の入口であり、ここだけは
 * 実行環境の都合で塞がらないようにしておく。
 */
import type { Route, RouteHandler } from './routes.js';
import { html, readLimitedText } from './routes.js';
import type { AuthDependencies } from './auth/google.js';
import { startInvitedLogin } from './auth/google.js';
import { normalizeInviteCode } from './invite-code.js';
import { checkInvite } from './invites.js';
import { SIGNUP_PATH, WAITLIST_PATH, WAITLIST_THANKS_PATH } from './paths.js';
import type { WaitlistSource } from './waitlist.js';
import { WAITLIST_SOURCES, countWaitlist, coarsenWaitlistCount } from './waitlist.js';

/** フォームの `Content-Type`。素の `<form method="post">` はこれで送る。 */
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** 受け付けるリクエスト本文の最大バイト数（`src/waitlist.ts` と同じ考え方）。 */
const MAX_BODY_BYTES = 1024;

/**
 * どの導線からこの画面へ来たかを伝える query の名前（10.2 / 2.2-4 / #30）。
 *
 * **`source` にしない。** 待機リストのフォームが送る項目名と同じ綴りにすると、
 * 「query から来た値」と「フォームが送る値」が同じ名前で 2 つの層に現れ、片方だけを
 * 検証している状態が読めなくなる。**この画面が受け取るのはヒントであり、記録される
 * 値ではない**（記録するのは `src/waitlist.ts` が本文から読んだほう）。
 */
const SIGNUP_FROM_PARAM = 'from';

/**
 * 導線が分からないときに使う値。
 *
 * **既定を `signup` にする。** この画面のフォームは元々この値を送っていた（#63）。
 * 未知の綴りを既定へ倒すのは `REASON_MESSAGES` と同じ考え方で、**query から来た文字列を
 * そのまま HTML へ出さない**ことの一部である。
 */
const DEFAULT_WAITLIST_SOURCE: WaitlistSource = 'signup';

/**
 * この画面へ送るときの URL を組み立てる（2.2-4）。
 *
 * **綴りを持つのはこのモジュールだけである**（`src/work-page.ts` の `workPagePath` と
 * 同じ方針）。作品ページの「改造する」はここから取る。引数の型が
 * {@link WaitlistSource} なので、**綴りを間違えると型検査が落ちる。**
 *
 * @param source 導線
 * @returns アプリ用ホスト上の絶対パス（query 付き）
 */
export function signupPathFrom(source: WaitlistSource): string {
  return `${SIGNUP_PATH}?${SIGNUP_FROM_PARAM}=${encodeURIComponent(source)}`;
}

/**
 * query の値を導線として解釈する。
 *
 * **閉じた集合の中でだけ受け取る**（`src/waitlist.ts` の `WAITLIST_SOURCES`）。
 * 自由な文字列を hidden 項目へ書き戻すと、そこが反射型の差し込み口になる。
 * 集合に無い綴りは既定へ倒す（拒否しない——登録を落とす理由が無い）。
 *
 * @param value query から取り出した値（無ければ null）
 * @returns 導線
 */
function waitlistSourceOf(value: string | null): WaitlistSource {
  if (value !== null && (WAITLIST_SOURCES as readonly string[]).includes(value)) {
    return value as WaitlistSource;
  }
  return DEFAULT_WAITLIST_SOURCE;
}

/**
 * 「改造する」から来た人にだけ出す前置き（2.2-4）。
 *
 * 2.2-4 は未招待の利用者について「**待機リストへの登録導線に変換する**」と定める。
 * 変換先が「登録画面」としか言わない画面だと、押した操作と着地点がつながらない。
 * **押した操作の側から説明する。**
 *
 * @param source 導線
 * @returns HTML（対象外の導線なら空文字）
 */
function fromForkSection(source: WaitlistSource): string {
  return source === 'fork-cta'
    ? `<p>改造（フォーク）できるのは招待された方だけです（8.1）。
   <strong>遊ぶことと URL の共有に招待は要りません。</strong></p>`
    : '';
}

/**
 * 画面に出す文言の対応表。
 *
 * **`reason` を画面へそのまま流さない。** この値は query から来るため、未知の値を
 * 出力へ通すと、そのまま反射型の差し込みになる。表に無いものは既定の文言へ倒す。
 *
 * 文言の粒度が分類より粗いのは意図的で、「使用済み」と「期限切れ」を出し分けても
 * 利用者にできることは変わらない一方、総当たりする側には手がかりになる。
 */
const REASON_MESSAGES: Readonly<Record<string, string>> = {
  'invite-required': '登録には招待コードが必要です。',
  malformed: '招待コードの形式が正しくありません。',
  unknown: 'この招待コードは使えません。',
  used: 'この招待コードは使えません。',
  expired: 'この招待コードは使えません。',
  'self-use': '自分で発行した招待コードは使えません。',
  // 同じアカウントの登録が同時に進んでいた場合（`resolveUser` の 'retry'）。
  // 招待は消費していないので、そのままやり直せる。
  retry: '登録が完了しませんでした。もう一度お試しください。',
  // 待機リストの登録が失敗して戻ってきた場合（`src/waitlist.ts` の no-JS 経路）。
  // 招待コードの文言を出すと、待機リストの失敗を「コードが使えない」と誤解させる。
  // 分類は `waitlist-` を接頭辞にして持ち、下の `reasonMessage` が前方一致で拾う。
  'waitlist-invalid-email': 'メールアドレスの形式が正しくありません。',
  'waitlist-failed': '待機リストへの登録に失敗しました。時間をおいて試してください。',
};

/** 待機リストの失敗を表す分類の接頭辞。 */
const WAITLIST_REASON_PREFIX = 'waitlist-';

/** 待機リストの失敗で、個別の文言を持たないものに使う文言。 */
const DEFAULT_WAITLIST_MESSAGE = '待機リストへの登録を受け付けられませんでした。';

/** 既定の文言。未知の `reason` を受けたときに使う。 */
const DEFAULT_REASON_MESSAGE = 'この招待コードは使えません。';

/**
 * 分類から画面に出す文言を選ぶ。
 *
 * **`reason` を画面へそのまま流さない。** 表に無いものは、待機リスト由来かどうかで
 * 既定を分ける。分けないと、待機リストの失敗に「招待コードは使えません」が出て、
 * 利用者が直すべき場所を誤る。
 *
 * @param reason query から受け取った分類
 * @returns 画面に出す文言
 */
function reasonMessage(reason: string): string {
  const known = REASON_MESSAGES[reason];
  if (known !== undefined) {
    return known;
  }
  return reason.startsWith(WAITLIST_REASON_PREFIX)
    ? DEFAULT_WAITLIST_MESSAGE
    : DEFAULT_REASON_MESSAGE;
}

/**
 * 登録画面を組み立てる。
 *
 * @param message 画面上部に出すエラー文言（無ければ null）
 * @param waitingCount 待機リストの登録数（丸め済み）。0 のときは出さない
 * @param source どの導線から来たか（10.2）
 * @returns HTML
 */
function signupPage(
  message: string | null,
  waitingCount: number,
  source: WaitlistSource = DEFAULT_WAITLIST_SOURCE,
): string {
  // 文言は上の対応表から選んだ固定文字列なので、埋め込んでも差し込みにならない。
  // それでも `escapeHtml` を通すのは、将来この引数の出どころが変わったときに
  // 安全側が既定になっているようにするため。
  const error =
    message === null ? '' : `<p class="error" role="alert">${escapeHtml(message)}</p>`;

  // 件数は 10 件単位に丸めた値（`src/waitlist.ts` の理由）。0 のときに「0 人待ち」と
  // 出すと、丸めの下限がそのまま「まだ誰もいない」と読めてしまうため出さない。
  const waiting =
    waitingCount > 0 ? `<p>現在 ${waitingCount} 人以上が登録して待っています。</p>` : '';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game Forge に登録する</title>
<h1>Game Forge に登録する</h1>
${error}
${fromForkSection(source)}
<h2>招待コードをお持ちの方</h2>
<form method="post" action="${SIGNUP_PATH}">
  <label for="code">招待コード</label>
  <input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters"
         spellcheck="false" placeholder="ABCD-EFGH-JKMN" required>
  <button type="submit">コードを確認して Google でログイン</button>
</form>
<p>コードを確認したあとに Google のログイン画面へ進みます。</p>

<h2>招待コードをお持ちでない方</h2>
${waiting}
<form method="post" action="${WAITLIST_PATH}">
  <label for="email">メールアドレス</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <input type="hidden" name="source" value="${source}">
  <button type="submit">待機リストに登録する</button>
</form>

<h2>すでにアカウントをお持ちの方</h2>
<p><a href="/auth/google/start">Google でログイン</a></p>`;
}

/**
 * 待機リスト登録後の受け皿。
 *
 * @returns HTML
 */
function waitlistThanksPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>待機リストに登録しました</title>
<h1>待機リストに登録しました</h1>
<p>招待枠が空いたらご連絡します。</p>
<p><a href="${SIGNUP_PATH}">登録画面へ戻る</a></p>`;
}

/**
 * 登録画面を返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const showSignupPage: RouteHandler = async (request, env) => {
  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  const message = reason === null ? null : reasonMessage(reason);
  const waitingCount = coarsenWaitlistCount(await countWaitlist(env.DB));
  // **導線は画面の形を変えず、記録される値と前置きだけを変える。**
  const source = waitlistSourceOf(params.get(SIGNUP_FROM_PARAM));
  return html(signupPage(message, waitingCount, source), reason === null ? 200 : 400);
};

/**
 * 招待コードを検証し、通ったら Google の同意画面へ送る。
 *
 * **通らなかった場合、認可要求を一切組み立てない。** #14 の受け入れ条件
 * 「無効コードでは OAuth 画面に到達しない」は、ここでリダイレクトも一時 cookie も
 * 発行しないことで満たす。
 *
 * ここでの検証は `checkInvite`（読み取りのみ）で、消費はしない。消費は Google の
 * 同意を得て `users` 行ができたあと（`src/auth/google.ts` の `resolveUser`）に行う。
 * ここで消費すると、同意画面で離脱した利用者の招待が戻らなくなる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param overrides 差し替える依存（テスト用）
 * @returns レスポンス
 */
async function submitInviteCode(
  request: Request,
  env: Env,
  overrides: Partial<AuthDependencies>,
): Promise<Response> {
  const submitted = await readCodeField(request);
  if (submitted === null) {
    return await signupError(env, 'malformed');
  }

  const normalized = normalizeInviteCode(submitted);
  if (normalized === null) {
    return await signupError(env, 'malformed');
  }

  const checked = await checkInvite(env.DB, normalized);
  if (!checked.ok) {
    return await signupError(env, checked.reason);
  }

  return await startInvitedLogin(request, env, normalized, overrides);
}

/**
 * 登録画面をエラー付きで返す。
 *
 * リダイレクトではなくその場で返す。POST の結果を 303 で `GET /signup?reason=` へ
 * 逃がすと、失敗のたびに理由が URL に残り、ブラウザの履歴や共有リンクに載る。
 * 成功していないので、やり直す先も同じ画面でよい。
 *
 * @param env バインディングと環境変数
 * @param reason 失敗の分類
 * @returns レスポンス
 */
async function signupError(env: Env, reason: string): Promise<Response> {
  const waitingCount = coarsenWaitlistCount(await countWaitlist(env.DB));
  return html(signupPage(reasonMessage(reason), waitingCount), 400);
}

/**
 * フォームから `code` を取り出す。
 *
 * `Content-Type` はフォーム送信のものだけを受け付ける。この経路は画面のためのもので、
 * API として叩かれる想定が無い以上、受け口を広げる理由がない。
 *
 * @param request 受信したリクエスト
 * @returns 入力された文字列、または取り出せない場合は null
 */
async function readCodeField(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.split(';')[0]?.trim().toLowerCase().startsWith(FORM_CONTENT_TYPE)) {
    return null;
  }

  // 上限を超えた本文は**読み切らずに打ち切る**（`readLimitedText` の理由）。
  // 全量を読んでから長さを見る形は、上限を置いた意味を満たさない。
  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return null;
  }

  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(body.text);
  } catch {
    return null;
  }
  // 同じキーが複数回現れる本文は受け付けない。先頭を黙って採ると、利用者が
  // 入力していないコードで検証が通りうる（`src/waitlist.ts` と同じ判断）。
  if (fields.getAll('code').length !== 1) {
    return null;
  }
  return fields.get('code');
}

/**
 * HTML へ埋め込む文字列を無害化する。
 *
 * 属性値にも本文にも使える最小の集合を落とす。
 *
 * @param value 埋め込む文字列
 * @returns 無害化した文字列
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 登録の経路を組み立てる。
 *
 * 依存を引数で受けるのは `createAuthRoutes` と同じ理由で、招待コードが通ったあとの
 * 往復をネットワークなしでテストできるようにするため。
 *
 * @param overrides 差し替える依存（省略した項目は既定を使う）
 * @returns 経路表へ連結する `Route[]`
 */
export function createSignupRoutes(overrides: Partial<AuthDependencies> = {}): readonly Route[] {
  return [
    { method: 'GET', path: SIGNUP_PATH, handler: showSignupPage },
    {
      method: 'POST',
      path: SIGNUP_PATH,
      handler: (request, env) => submitInviteCode(request, env, overrides),
    },
    { method: 'GET', path: WAITLIST_THANKS_PATH, handler: () => html(waitlistThanksPage()) },
  ];
}

/** アプリの経路表へ連結する登録の経路（既定の依存）。 */
export const signupRoutes: readonly Route[] = createSignupRoutes();
