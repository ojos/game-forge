/**
 * 登録情報の画面の、接続中のアプリのタブ（`/account/apps`）と、接続の解除（`POST /api/account/apps/revoke`）。
 * #696 / M19-1 / 仕様 5.15「接続の解除」。
 *
 * - **並べるのは本人の許可だけ**（部品の `listUserGrants` は KV の鍵 `grant:<利用者の id>:` で絞る）。アプリ名・許可した範囲・
 *   接続した日時を出す。アプリ名は同意のときに許可へ写した値（`src/oauth-provider.ts` の `OAuthGrantMetadata`）
 * - **解除は本人の許可だけ**。部品の `revokeGrant(許可の id, 利用者の id)` は鍵を `grant:<利用者の id>:<許可の id>` で組むので、
 *   他人の許可の id を送られても他人の鍵には届かない。そのうえで、**本人の一覧に無い id は断る**（黙って成功にしない）
 * - 解除すると、その許可から出たアクセストークンとリフレッシュトークンもすべて無効になる（部品）
 *
 * **CSRF はほかの登録情報の POST と同じくセッション cookie の `SameSite=Lax` が受ける**（`src/account.ts` の冒頭）。
 * 押させられても起きるのは「自分の接続が切れる」ことだけで、同意画面（`src/oauth-authorize.ts`）とは害の向きが違う。
 * 素のフォームと POST-redirect-GET で組む（JavaScript を要求しない）。
 */
import type { GrantSummary } from '@cloudflare/workers-oauth-provider';
import { accountShell } from './account.js';
import { ACCOUNT_APPS_PATH, ACCOUNT_APPS_REVOKE_API_PATH, GRANT_ID_FIELD } from './account-paths.js';
import { loginRequiredRedirect } from './auth/google.js';
import { escapeHtml, headerAvatarUrl } from './html.js';
import { formatJstMinutes } from './jst.js';
import { oauthHelpers } from './oauth-provider.js';
import { OAUTH_SCOPE_LABELS } from './oauth-paths.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';

/** 1 人あたりに並べる許可の上限（部品の list の 1 回分。1 人がこれを超えて接続する形は想定しない）。 */
const MAX_LISTED_GRANTS = 100;

/** 解除の本文の上限（バイト）。 */
const MAX_BODY_BYTES = 1024;

/** 許可の id の形（部品は英数字と `-` `_` の 16 文字で作る。余裕を持たせて 64 文字まで。`:` は通さない）。 */
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 結果の分類（`/account/apps?reason=`）。 */
export type AccountAppsReason = 'invalid-request' | 'not-found' | 'failed';

/** 分類ごとの文言。 */
const REASON_MESSAGES: Readonly<Record<AccountAppsReason, string>> = {
  'invalid-request': '接続を解除できませんでした。もう一度お試しください。',
  'not-found': 'その接続は見つかりませんでした（すでに解除されたか、期限が切れています）。',
  failed: '接続を解除できませんでした。しばらくしてからお試しください。',
};

/** 画面に出す 1 件。 */
export interface ConnectedApp {
  readonly grantId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly connectedAt: number;
}

/** 画面に要る値。 */
export interface AccountAppsView {
  readonly apps: readonly ConnectedApp[];
  readonly notice: { readonly kind: 'error'; readonly message: string } | { readonly kind: 'revoked' } | null;
  readonly headerAvatar: string | null;
}

/**
 * 許可の一覧の 1 件を、画面に出す形にする。
 *
 * **アプリ名はアプリ自身が名乗った値である**（`escapeHtml` は描く側で通す）。名前が無ければクライアントの id を出す。
 *
 * @param grant 部品の許可の要約
 * @returns 画面に出す 1 件
 */
function connectedAppOf(grant: GrantSummary): ConnectedApp {
  const metadata = grant.metadata as { clientName?: unknown } | null | undefined;
  const name = typeof metadata?.clientName === 'string' && metadata.clientName.trim() !== '' ? metadata.clientName : grant.clientId;
  return { grantId: grant.id, name, scopes: [...grant.scope], connectedAt: grant.createdAt };
}

/**
 * 接続中のアプリのタブを組み立てる。
 *
 * @param view 画面に要る値
 * @returns HTML
 */
export function renderAccountAppsPage(view: AccountAppsView): string {
  const notice =
    view.notice === null
      ? ''
      : view.notice.kind === 'revoked'
        ? '<p class="gf-block" role="status">接続を解除しました。</p>'
        : `<p class="error" role="alert">${escapeHtml(view.notice.message)}</p>`;
  const rows =
    view.apps.length === 0
      ? '<p>接続中のアプリはありません。</p>'
      : `<ul class="gf-block gf-block-rows gf-connected-apps">
${view.apps
  .map(
    (app) => `  <li>
    <h2>${escapeHtml(app.name)}</h2>
    <p>許可した範囲: ${escapeHtml(app.scopes.map((scope) => OAUTH_SCOPE_LABELS[scope]?.name ?? scope).join('・'))}</p>
    <p>接続した日時: ${escapeHtml(formatJstMinutes(app.connectedAt))}</p>
    <form method="post" action="${ACCOUNT_APPS_REVOKE_API_PATH}">
      <input type="hidden" name="${GRANT_ID_FIELD}" value="${escapeHtml(app.grantId)}">
      <button type="submit" class="gf-button gf-button-secondary">接続を解除</button>
    </form>
  </li>`,
  )
  .join('\n')}
</ul>`;
  return accountShell({
    path: ACCOUNT_APPS_PATH,
    title: '接続中のアプリ - Game Forge',
    headerAvatar: view.headerAvatar,
    body: `${notice}
<p>Claude などの AI アプリから、あなたの作品を読んだり生成を始めたりできるように許可した接続の一覧です。解除すると、そのアプリはあなたのアカウントを使えなくなります。許可は 30 日で切れます。</p>
${rows}`,
  });
}

/**
 * 利用者の許可を読む。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @returns 許可（新しい順）
 */
async function loadConnectedApps(request: Request, env: Env, userId: string): Promise<ConnectedApp[]> {
  const page = await oauthHelpers(env, new URL(request.url).origin).listUserGrants(userId, { limit: MAX_LISTED_GRANTS });
  return page.items.map(connectedAppOf).sort((a, b) => b.connectedAt - a.connectedAt);
}

/**
 * `GET /account/apps`。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showAccountApps(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_APPS_PATH);
  }
  const params = new URL(request.url).searchParams;
  const reason = params.get('reason');
  let notice: AccountAppsView['notice'] =
    reason !== null
      ? {
          kind: 'error',
          message: Object.hasOwn(REASON_MESSAGES, reason)
            ? REASON_MESSAGES[reason as AccountAppsReason]
            : REASON_MESSAGES['invalid-request'],
        }
      : params.get('revoked') !== null
        ? { kind: 'revoked' }
        : null;
  let apps: ConnectedApp[] = [];
  try {
    apps = await loadConnectedApps(request, env, session.userId);
  } catch (error) {
    // **KV が読めなくても画面は出す**（一覧が空だと読める形にはしない。知らせを出す）。
    console.error(`[account-apps] 接続の一覧を読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    notice = { kind: 'error', message: '接続の一覧を読めませんでした。しばらくしてからお試しください。' };
  }
  return html(
    renderAccountAppsPage({ apps, notice, headerAvatar: headerAvatarUrl(request, env, session.userId) }),
    reason === null ? 200 : 400,
  );
}

/**
 * 303 の応答。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * `POST /api/account/apps/revoke` — 接続を解除する。**終わったら必ず `/account/apps` へ戻す。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, ACCOUNT_APPS_PATH);
  }
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return seeOther(`${ACCOUNT_APPS_PATH}?reason=invalid-request`);
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return seeOther(`${ACCOUNT_APPS_PATH}?reason=invalid-request`);
  }
  const values = new URLSearchParams(read.text).getAll(GRANT_ID_FIELD);
  const grantId = values.length === 1 ? values[0]! : '';
  if (!GRANT_ID_PATTERN.test(grantId)) {
    return seeOther(`${ACCOUNT_APPS_PATH}?reason=invalid-request`);
  }
  try {
    const helpers = oauthHelpers(env, new URL(request.url).origin);
    // **本人の一覧に在る id だけを消す**（鍵は利用者の id で絞られるので他人の許可には届かないが、
    // 無い id を「解除しました」と言わない）。
    const page = await helpers.listUserGrants(session.userId, { limit: MAX_LISTED_GRANTS });
    if (!page.items.some((grant) => grant.id === grantId)) {
      return seeOther(`${ACCOUNT_APPS_PATH}?reason=not-found`);
    }
    await helpers.revokeGrant(grantId, session.userId);
    return seeOther(`${ACCOUNT_APPS_PATH}?revoked=1`);
  } catch (error) {
    console.error(`[account-apps] 接続を解除できませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return seeOther(`${ACCOUNT_APPS_PATH}?reason=failed`);
  }
}

/** アプリの経路表へ連結する、接続中のアプリのタブの経路（#696）。 */
export const accountAppsRoutes: readonly Route[] = [
  { method: 'GET', path: ACCOUNT_APPS_PATH, handler: showAccountApps },
  { method: 'POST', path: ACCOUNT_APPS_REVOKE_API_PATH, handler: handleRevoke },
];
