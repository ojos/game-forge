/**
 * 登録情報の画面の、ハンドル名のタブ（`/account/handle`）と、ハンドル名の保存
 * （`POST /api/account/handle`）。**仕様 5.10 のハンドル名の口である**（#381 / M12-13）。
 *
 * 検査と書き込みは `src/handle.ts`、作者ページ（`/@handle`）は `src/users-page.ts` が持つ。
 *
 * ## 予約語は経路表から導き、`src/app.ts` から受け取る
 *
 * **このモジュールは経路表を import しない**（経路表はこのモジュールの経路を含むので、import すると
 * 循環参照になる）。予約語は {@link AccountHandleRouteOptions.reservedHandles} で受け取り、
 * **保存の口が呼ばれたときにだけ導く**（画面を開くたびに経路表を 2 枚組み立てない）。
 *
 * ## 変える前に、変えると何が起きるかを告げる（利用者の決定。#381 のコメント）
 *
 * **「旧い URL は 90 日間、新しいハンドルへ転送されます」を画面に出す。** 転送するということは、
 * **旧いハンドル名と新しいハンドル名が同じ人だと外から分かる**ということで、本人がそれを知らずに
 * 改名すると困る場合がある（名前を変えて前の活動と切り離したい人）。30 日に 1 回・90 日の予約・
 * 予約中は本人だけが戻れること・`/users/<id>` の URL は生き続けることも同じ場所に並べる。
 *
 * ## 素のフォームと POST-redirect-GET（JavaScript を要求しない。9.3）
 *
 * 結果は `/account/handle` の query に**固定の分類名だけ**で運び、**入力したハンドル名は URL に載せない**
 * （`src/account.ts` の表示名と同じ理由——断られた値が履歴やログに残り、画面へ反射する口になる）。
 * ハンドル名は 20 文字までなので、断られたときに打ち直す手間は小さい。
 *
 * ## CSRF について
 *
 * `src/account.ts` と同じ（セッション cookie は `SameSite=Lax` で、他サイトからの POST に cookie が乗らない）。
 */
import { ACCOUNT_HANDLE_API_PATH, ACCOUNT_HANDLE_PATH, HANDLE_FIELD } from './account-paths.js';
import { accountShell } from './account.js';
import { loginRequiredRedirect } from './auth/google.js';
import type { CurrentHandle, HandleRejection } from './handle.js';
import {
  HANDLE_RENAME_INTERVAL_DAYS,
  HANDLE_RENAME_INTERVAL_SECONDS,
  HANDLE_RESERVATION_DAYS,
  changeHandle,
  currentHandleOf,
  validateHandle,
} from './handle.js';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, handlePagePath } from './handle-paths.js';
import { escapeHtml, headerAvatarUrl } from './html.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { authorPagePath } from './users-page-paths.js';

/**
 * 改名の画面で告げる転送の文言（利用者の決定。#381 のコメント）。**綴りを 1 か所に置き、テストが照合する。**
 */
export const HANDLE_REDIRECT_NOTICE = `旧い URL は ${HANDLE_RESERVATION_DAYS} 日間、新しいハンドルへ転送されます`;

/**
 * 受け付ける本文の最大バイト数。**1 KiB。** 載るのはハンドル名 1 つ（20 文字）で、それより長い入力は
 * 長さの検査で断るために読み切れる大きさを取る。超えたら `handle-length` として扱う。
 */
const MAX_BODY_BYTES = 1024;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** 保存の結果として `/account/handle` へ運ぶ分類。**query に載るのはこの綴りだけである。** */
export type AccountHandleReason =
  | HandleRejection
  | 'handle-taken'
  | 'handle-too-soon'
  | 'handle-invalid-request'
  | 'handle-failed';

/** 分類ごとの文言。 */
const REASON_MESSAGES: Readonly<Record<AccountHandleReason, string>> = {
  'handle-empty': 'ハンドル名を入力してください。',
  'handle-invalid': 'ハンドル名に使えるのは、半角の英字・数字・アンダースコア（_）だけです。',
  'handle-length': `ハンドル名は ${HANDLE_MIN_LENGTH} 文字以上 ${HANDLE_MAX_LENGTH} 文字以下です。`,
  'handle-reserved': 'このハンドル名は、サイトの URL や運営と紛らわしいため使えません。',
  // **他人が使っているのか、予約中なのかを分けて言わない**——分けると、改名した人の旧いハンドル名を
  // 外から数えられる（転送で既に分かることではあるが、口を増やさない）。
  'handle-taken': `このハンドル名は、ほかの人が使っているか、改名から ${HANDLE_RESERVATION_DAYS} 日のあいだ予約されています。別の名前をお試しください。`,
  // **待てば通ることと、いつ通るかを言う**（日時は画面の本文に出る）。
  'handle-too-soon': `ハンドル名の変更は ${HANDLE_RENAME_INTERVAL_DAYS} 日に 1 回までです。次に変更できる日時は下に出ています。`,
  'handle-invalid-request': '要求の形が正しくありません。画面を開き直してからもう一度お試しください。',
  'handle-failed': 'ハンドル名を保存できませんでした。時間をおいてもう一度お試しください。',
};

/** 未知の分類を受けたときの文言。 */
const DEFAULT_REASON_MESSAGE = 'ハンドル名を保存できませんでした。';

/** 保存できたことを示す query の名前（`/account/handle?saved=1`）。 */
const SAVED_QUERY = 'saved';

/** ハンドル名のタブを組み立てるのに必要なものだけを集めた入力。 */
export interface AccountHandleView {
  /** 利用者の id（ハンドル名が無いときの作者ページのリンクに使う）。 */
  readonly userId: string;
  /** いま使っているハンドル名（無ければ null）。 */
  readonly current: CurrentHandle | null;
  /** 現在時刻（UNIX 秒。次に変えられる日時を出すかの判定に使う）。 */
  readonly now: number;
  /** 上部に出す知らせ（無ければ null）。 */
  readonly notice: { readonly kind: 'error'; readonly message: string } | { readonly kind: 'saved' } | null;
  /** ヘッダのアバターの画像の URL（#380）。 */
  readonly headerAvatar: string | null;
}

/**
 * ハンドル名のタブ（`/account/handle`）を組み立てる（#381 / 5.10）。
 *
 * **ハンドル名は形の検査を通った値しか保存されない**（小文字の ASCII 英字・数字・`_`）が、画面へ出す値は
 * すべて `escapeHtml` を通す（出どころが変わっても安全側が既定になる）。
 *
 * **`maxlength` を付けない。** 長さは送信後に 1 つの規則で断る（`src/account.ts` の表示名と同じ扱い）。
 *
 * **フォームは面のブロックで、保存のボタンは副**（仕様 2.5.4 / 2.5.5 / #473。登録情報のタブは主を置かない）。保存の知らせもブロックである。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAccountHandlePage(view: AccountHandleView): string {
  const notice =
    view.notice === null
      ? ''
      : view.notice.kind === 'saved'
        ? '<p class="gf-block" role="status">ハンドル名を保存しました。</p>'
        : `<p class="error" role="alert">${escapeHtml(view.notice.message)}</p>`;

  const current = view.current;
  const summary =
    current === null
      ? `<p>ハンドル名はまだ決めていません。決めると、作者ページの URL が <code>/@ハンドル名</code> になります。決めなくても、いまの<a href="${escapeHtml(authorPagePath(view.userId))}">作者ページ</a>はそのまま使えます。</p>`
      : `<p>いまのハンドル名は <strong>@${escapeHtml(current.handle)}</strong> です（作者ページ: <a href="${escapeHtml(handlePagePath(current.handle))}">${escapeHtml(handlePagePath(current.handle))}</a>）。</p>`;

  const nextChangeAt = current === null ? null : current.claimedAt + HANDLE_RENAME_INTERVAL_SECONDS;
  const waiting =
    nextChangeAt !== null && nextChangeAt > view.now
      ? `<p class="gf-account-handle-wait">次にハンドル名を変更できるのは <time datetime="${toIsoTimestamp(nextChangeAt)}">${formatJstMinutes(nextChangeAt)}</time> 以降です。</p>`
      : '';

  return accountShell({
    path: ACCOUNT_HANDLE_PATH,
    title: 'ハンドル名 - Game Forge',
    headerAvatar: view.headerAvatar,
    body: `${notice}
${summary}
${waiting}
<form class="gf-block" method="post" action="${ACCOUNT_HANDLE_API_PATH}">
  <label for="handle">ハンドル名</label>
  <input id="handle" name="${HANDLE_FIELD}" type="text" autocomplete="username" autocapitalize="none"
         spellcheck="false" value="${escapeHtml(current?.handle ?? '')}" required>
  <p>半角の英字・数字・アンダースコア（_）で ${HANDLE_MIN_LENGTH}〜${HANDLE_MAX_LENGTH} 文字。大文字は小文字として保存します（Foo と foo は同じハンドル名です）。</p>
  <button type="submit" class="gf-button gf-button-secondary">${current === null ? 'ハンドル名を決める' : 'ハンドル名を変更する'}</button>
</form>
<h2>変更する前にお読みください</h2>
<ul class="gf-account-handle-rules">
  <li>ハンドル名の変更は ${HANDLE_RENAME_INTERVAL_DAYS} 日に 1 回までです。</li>
  <li><strong>${HANDLE_REDIRECT_NOTICE}。</strong>そのため、旧いハンドル名と新しいハンドル名が同じ人のものだと、ほかの人にも分かります。</li>
  <li>変更してから ${HANDLE_RESERVATION_DAYS} 日のあいだ、旧いハンドル名はほかの人が使えません。この間なら、あなたは旧いハンドル名に戻せます（戻すのも 1 回の変更として数えます）。${HANDLE_RESERVATION_DAYS} 日を過ぎると、ほかの人が使えるようになり、旧い URL は転送されなくなります。</li>
  <li><code>/users/</code> で始まる作者ページの URL は、ハンドル名を決めても変えても使えます（いまのハンドル名の作者ページへ転送します）。</li>
</ul>`,
  });
}

/**
 * 303 See Other を返す（`src/account.ts` の `seeOther` と同じ理由）。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 分類から画面に出す文言を選ぶ。
 *
 * @param reason query から受け取った分類
 * @returns 画面に出す文言
 */
function reasonMessage(reason: string): string {
  return Object.hasOwn(REASON_MESSAGES, reason)
    ? REASON_MESSAGES[reason as AccountHandleReason]
    : DEFAULT_REASON_MESSAGE;
}

/**
 * ハンドル名のタブを返す。**未ログインならログインへ送る。引くのは本人の行だけである。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function showAccountHandle(request: Request, env: Env, now: () => number): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_HANDLE_PATH);
  }
  const current = await currentHandleOf(env.DB, session.userId);

  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  const notice: AccountHandleView['notice'] =
    reason !== null
      ? { kind: 'error', message: reasonMessage(reason) }
      : params.get(SAVED_QUERY) !== null
        ? { kind: 'saved' }
        : null;

  return html(
    renderAccountHandlePage({
      userId: session.userId,
      current,
      now: now(),
      notice,
      headerAvatar: headerAvatarUrl(request, env, session.userId),
    }),
    reason === null ? 200 : 400,
  );
}

/**
 * ハンドル名を保存する（`POST /api/account/handle`）。**終わったら必ず `/account/handle` へ戻す。**
 *
 * **断った要求は書き込まない**——形と予約語で断ったものは D1 に触れず、間隔と主キーで断ったものは
 * 1 行も残らない（`src/handle.ts` の `changeHandle`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param options 予約語と時刻
 * @returns レスポンス
 */
async function handleAccountHandleChange(
  request: Request,
  env: Env,
  options: Required<AccountHandleRouteOptions>,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_HANDLE_PATH);
  }

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return seeOther(`${ACCOUNT_HANDLE_PATH}?reason=handle-invalid-request`);
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return seeOther(
      `${ACCOUNT_HANDLE_PATH}?reason=${read.reason === 'body-too-large' ? 'handle-length' : 'handle-invalid-request'}`,
    );
  }
  // **値がちょうど 1 つのときだけ受け付ける**（`src/account.ts` のメール配信と同じ判断）。
  const values = new URLSearchParams(read.text).getAll(HANDLE_FIELD);
  if (values.length > 1) {
    return seeOther(`${ACCOUNT_HANDLE_PATH}?reason=handle-invalid-request`);
  }

  const validated = validateHandle(values[0] ?? '', options.reservedHandles());
  if (!validated.ok) {
    return seeOther(`${ACCOUNT_HANDLE_PATH}?reason=${validated.reason}`);
  }

  try {
    const changed = await changeHandle(env.DB, session.userId, validated.value, options.now());
    return seeOther(
      changed.ok ? `${ACCOUNT_HANDLE_PATH}?${SAVED_QUERY}=1` : `${ACCOUNT_HANDLE_PATH}?reason=${changed.reason}`,
    );
  } catch (error) {
    // D1 の失敗。**ハンドル名はログに出さない**（利用者の入力であり、ここで残す理由が無い）。
    console.error(
      `[account-handle] ハンドル名の保存に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return seeOther(`${ACCOUNT_HANDLE_PATH}?reason=handle-failed`);
  }
}

/** {@link createAccountHandleRoutes} に渡す値。 */
export interface AccountHandleRouteOptions {
  /**
   * 予約語を返す関数（`src/app.ts` が経路表から導いて渡す。`src/handle.ts` の `reservedHandlesOf`）。
   *
   * **必須にする。** 既定値（空の集合）を置くと、渡し忘れた経路表で予約語が黙って効かなくなる。
   */
  readonly reservedHandles: () => ReadonlySet<string>;
  /** 現在時刻（UNIX 秒）。既定は `Date.now()` から。テストが 30 日・90 日の境界を固定するために使う。 */
  readonly now?: () => number;
}

/**
 * ハンドル名のタブの経路を組み立てる（#381）。
 *
 * **GET の画面は `src/account-paths.ts` の `ACCOUNT_TABS` の行き先である**（`test/account.test.ts` が照合する）。
 *
 * @param options 予約語と時刻
 * @returns 経路表
 */
export function createAccountHandleRoutes(options: AccountHandleRouteOptions): readonly Route[] {
  const resolved: Required<AccountHandleRouteOptions> = {
    reservedHandles: options.reservedHandles,
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
  };
  return [
    { method: 'GET', path: ACCOUNT_HANDLE_PATH, handler: (request, env) => showAccountHandle(request, env, resolved.now) },
    {
      method: 'POST',
      path: ACCOUNT_HANDLE_API_PATH,
      handler: (request, env) => handleAccountHandleChange(request, env, resolved),
    },
  ];
}
