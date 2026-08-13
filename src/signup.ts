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
import { html } from './routes.js';
import type { AuthDependencies } from './auth/google.js';
import { startInvitedLogin } from './auth/google.js';
import { normalizeInviteCode } from './invite-code.js';
import { checkInvite } from './invites.js';
import { SIGNUP_PATH, WAITLIST_THANKS_PATH } from './paths.js';
import { countWaitlist, coarsenWaitlistCount } from './waitlist.js';

/** フォームの `Content-Type`。素の `<form method="post">` はこれで送る。 */
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** 受け付けるリクエスト本文の最大バイト数（`src/waitlist.ts` と同じ考え方）。 */
const MAX_BODY_BYTES = 1024;

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
};

/** 既定の文言。未知の `reason` を受けたときに使う。 */
const DEFAULT_REASON_MESSAGE = 'この招待コードは使えません。';

/**
 * 登録画面を組み立てる。
 *
 * @param message 画面上部に出すエラー文言（無ければ null）
 * @param waitingCount 待機リストの登録数（丸め済み）。0 のときは出さない
 * @returns HTML
 */
function signupPage(message: string | null, waitingCount: number): string {
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
<form method="post" action="/waitlist">
  <label for="email">メールアドレス</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <input type="hidden" name="source" value="signup">
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
  const reason = new URL(request.url).searchParams.get('reason');
  const message = reason === null ? null : (REASON_MESSAGES[reason] ?? DEFAULT_REASON_MESSAGE);
  const waitingCount = coarsenWaitlistCount(await countWaitlist(env.DB));
  return html(signupPage(message, waitingCount), reason === null ? 200 : 400);
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
  return html(signupPage(REASON_MESSAGES[reason] ?? DEFAULT_REASON_MESSAGE, waitingCount), 400);
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

  const body = await readBoundedText(request);
  if (body === null) {
    return null;
  }

  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(body);
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
 * 本文を上限つきで読む。
 *
 * 上限を置かないと、本文を読み切るまでメモリを積む形になる。
 *
 * @param request 受信したリクエスト
 * @returns 本文、または上限を超えた場合は null
 */
async function readBoundedText(request: Request): Promise<string | null> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return null;
  }
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
