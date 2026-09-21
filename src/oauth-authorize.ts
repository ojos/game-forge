/**
 * MCP の認可の同意画面（`/authorize`。#696 / M19-1 / 仕様 5.15）。**この変更でいちばん守りが要る面である。**
 *
 * 部品（`@cloudflare/workers-oauth-provider`）は認可のエンドポイントを持たず、要求の検証（`parseAuthRequest`）と
 * 同意の完了（`completeAuthorization`）の道具だけを渡す。**誰が・どのアプリに・何を許すかを決める画面はアプリが書く。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 流れ
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. `GET /authorize?…` — 要求を検証する（クライアントの登録・戻り先の完全一致〔loopback だけはポートを問わない〕・
 *    PKCE の S256・resource）。**直せない要求は 400 の画面**（例外を 500 にしない）。戻り先が確かめられた後の誤りは、
 *    OAuth の作法どおり戻り先へ `error=` を付けて返す
 * 2. 未ログインなら、**要求を署名した一時 cookie（{@link PENDING_COOKIE}）に積み**、ログインへ送る。ログインの戻り先は
 *    固定の {@link AUTHORIZE_RESUME_PATH} だけで（`src/auth/google.ts` の `safeReturnPath` の「定数だけ・512 文字まで」を
 *    崩さない）、そこが cookie を読んで `/authorize?…` へ送り直す
 * 3. ログイン済みなら同意画面を出す——**アプリ名・戻り先のホスト名（loopback なら注記）・2 つの scope を個別に外せる
 *    チェックボックス**。枠への埋め込みを禁じる（`frame-ancestors 'none'` と `X-Frame-Options: DENY`）
 * 4. `POST /authorize?…`（同じ query）— **同意の値（{@link CONSENT_TOKEN_FIELD}）を照合してから**、承諾なら
 *    `completeAuthorization`（props は `{ userId }`、scope は選ばれたものだけ）、拒否なら `error=access_denied` で戻す。
 *    scope が 1 つも選ばれていなければ拒否として扱う
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CSRF — `SameSite=Lax` に頼らない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **sandbox と app は同一サイトなので `SameSite=Lax` が効かない**（仕様 7.2）。ほかの画面の POST は Lax で受けているが
 * （`src/account.ts` の冒頭）、同意は**第三者に自分の作品と生成の枠を渡す**操作で、押させられたときの害が桁で違う。
 * そこで、**利用者の id・認可の要求の中身（正規化したもののハッシュ）・期限（10 分）を HMAC で結んだ値**を画面に埋め、
 * POST で照合する（{@link signConsentToken}）。鍵は `SESSION_SECRET` で、**用途の識別子（{@link CONSENT_DOMAIN}）を
 * 署名対象の先頭に置いて**ほかの署名（セッション・ログインの一時 cookie）と取り違えさせない（`src/auth/google.ts` の
 * `OAUTH_STATE_DOMAIN` と同じ作法）。
 *
 * - **別の利用者の値・別の要求の値・期限切れ・改竄は、すべて 403 の同じ画面**にする
 * - **値は D1 にも KV にも書かない**（3.6。同意のたびに行を書いて消す形を作らない）。そのため厳密な「一度きり」ではなく、
 *   **同じ利用者が同じ要求で 10 分以内に押し直すと、もう 1 つ code が出る**。押し直せるのは画面を見られる本人だけで、
 *   code は PKCE の検証子を持つクライアントにしか交換できず、同じクライアントの前の許可は部品が消す（`revokeExistingGrants` の既定）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BAN・退会
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 利用者は `resolveSessionUser` で決める——**BAN と退会を始めた利用者はここで弾かれ、同意できない**
 * （未ログインと同じくログインへ送る）。
 */
import { CimdFetchError, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { ACCOUNT_APPS_PATH } from './account-paths.js';
import { loginRequiredRedirect } from './auth/google.js';
import { escapeHtml, headerAvatarUrl, resolveSiteViewer, siteHead, siteViewerAt } from './html.js';
import type { SiteViewer } from './html.js';
import { siteFooter } from './legal.js';
import type { OAuthGrantMetadata } from './oauth-provider.js';
import { oauthHelpers } from './oauth-provider.js';
import { guardConsent } from './oauth-guard.js';
import {
  AUTHORIZE_PATH,
  AUTHORIZE_RESUME_PATH,
  OAUTH_SCOPES,
  OAUTH_SCOPE_LABELS,
  PENDING_AUTHORIZATION_COOKIE,
  PENDING_AUTHORIZATION_MAX_AGE_SECONDS,
} from './oauth-paths.js';
import type { Route } from './routes.js';
import { readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';

/** 一時 cookie の名前（値の正本は `src/oauth-paths.ts`。プライバシーポリシーも同じ値を読む）。 */
export const PENDING_COOKIE = PENDING_AUTHORIZATION_COOKIE;

/** 一時 cookie の寿命（秒）。 */
export const PENDING_MAX_AGE_SECONDS = PENDING_AUTHORIZATION_MAX_AGE_SECONDS;

/** 同意の値の寿命（秒）。**10 分**。 */
export const CONSENT_TTL_SECONDS = 600;

/**
 * 一時 cookie に積める query の最大長（文字数）。
 *
 * cookie 全体の上限は 4KB 程度で、超えるとブラウザが黙って捨てる。CIMD の client_id（URL）と戻り先・PKCE の値を
 * 合わせても 1KB 台に収まる。**超える要求は積まずに断る**（途中で黙って切ると、別の要求になる）。
 */
const MAX_PENDING_QUERY_LENGTH = 2048;

/** 一時 cookie の署名に混ぜる用途識別子（**要素を変えたら版を上げる**。`src/auth/google.ts` と同じ作法）。 */
const PENDING_DOMAIN = 'gf-mcp-authz-pending.v1';

/** 同意の値の署名に混ぜる用途識別子。 */
const CONSENT_DOMAIN = 'gf-mcp-consent.v1';

/** フォームの項目名（同意の値）。 */
export const CONSENT_TOKEN_FIELD = 'consent_token';

/** フォームの項目名（選んだ scope。チェックボックスなので、外した scope は項目ごと送られない）。 */
export const CONSENT_SCOPE_FIELD = 'scope';

/** フォームの項目名（押したボタン）。値は {@link DECISION_APPROVE} か {@link DECISION_DENY}。 */
export const CONSENT_DECISION_FIELD = 'decision';

/** 押したボタン（許可する）。 */
export const DECISION_APPROVE = 'approve';

/** 押したボタン（許可しない）。 */
export const DECISION_DENY = 'deny';

/** 同意の POST の本文の上限（バイト）。項目は 4 つほどで、1KB も要らない。 */
const MAX_CONSENT_BODY_BYTES = 4096;

/** 素のフォームの本文の型。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * 同意画面と、その断りの画面に付けるヘッダ。
 *
 * - **枠への埋め込みを禁じる**（`frame-ancestors 'none'` と、古いブラウザ向けの `X-Frame-Options: DENY`）。
 *   同意のボタンを透明な枠に重ねて押させる形（clickjacking）を塞ぐ。アプリのホストには今この指定が無いので、
 *   この画面の応答にだけ付ける（仕様 5.15）
 * - **Referer を出さない**。画面の URL は認可の要求（`state` や PKCE の値）を持つ
 */
const CONSENT_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** 断りの画面の中身。 */
interface ConsentRefusal {
  readonly status: number;
  readonly heading: string;
  readonly body: string;
}

/** 要求を受け付けられないとき（形の誤り・知らないクライアント・戻り先の不一致・CIMD の文書が読めない）。 */
const INVALID_REQUEST: ConsentRefusal = {
  status: 400,
  heading: '接続の要求を受け付けられませんでした',
  body: '接続の要求が正しくないか、期限が切れています。お使いの AI アプリから、接続をやり直してください。',
};

/** 同意の値が照合できないとき（期限切れ・改竄・別の利用者・別の要求）。 */
const CONSENT_MISMATCH: ConsentRefusal = {
  status: 403,
  heading: '許可を確かめられませんでした',
  body: '確認の画面の期限が切れたか、別の画面から送られました。お使いの AI アプリから、接続をやり直してください。',
};

/** 同意の回数の上限（`src/oauth-guard.ts`。KV の無料枠を 1 人で使い切らせない）。 */
const CONSENT_RATE_LIMITED: ConsentRefusal = {
  status: 429,
  heading: '接続の回数が多すぎます',
  body: '今日はこれ以上アプリを接続できません。明日以降にお試しください。',
};

/** 部品の保存先が読めないなど、こちらの不調。 */
const SERVER_FAILURE: ConsentRefusal = {
  status: 500,
  heading: '接続を処理できませんでした',
  body: 'しばらくしてから、お使いの AI アプリで接続をやり直してください。',
};

/**
 * 同意画面に出すクライアントの情報。
 */
export interface ConsentView {
  /** アプリ名（**アプリ自身が名乗った名前**）。 */
  readonly clientName: string;
  /** CIMD のクライアントなら、情報の置き場所のホスト名（`claude.ai` など）。DCR なら null。 */
  readonly clientHost: string | null;
  /** 戻り先の表示（ホスト名。http(s) 以外なら scheme も付ける）。 */
  readonly redirectLabel: string;
  /** 戻り先が loopback（このコンピュータの中）か。 */
  readonly loopback: boolean;
  /** 同意画面に出す scope（{@link OAUTH_SCOPES} の並び）。 */
  readonly scopes: readonly string[];
  /** 画面に埋める同意の値。 */
  readonly consentToken: string;
  /** フォームの送り先（`/authorize?<元の query>`）。 */
  readonly action: string;
  /** ヘッダの出し分け。 */
  readonly viewer: SiteViewer;
}

/**
 * 同意画面を組み立てる。
 *
 * **クライアントから来る値（アプリ名・ホスト名）は、すべて `escapeHtml` を通す。** DCR のアプリ名は誰でも好きに名乗れる。
 * そのことも画面に書く（「アプリが名乗った名前です」）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderConsentPage(view: ConsentView): string {
  const scopeRows = view.scopes
    .map((scope) => {
      const label = OAUTH_SCOPE_LABELS[scope];
      const id = `gf-consent-scope-${scope.replace(/[^a-z]/gu, '-')}`;
      return `  <li><label for="${id}"><input id="${id}" type="checkbox" name="${CONSENT_SCOPE_FIELD}" value="${escapeHtml(scope)}" checked> <strong>${escapeHtml(label?.name ?? scope)}</strong></label><br>${escapeHtml(label?.note ?? '')}</li>`;
    })
    .join('\n');
  const origin =
    view.clientHost === null
      ? ''
      : `\n  <li>アプリの情報の置き場所: <strong>${escapeHtml(view.clientHost)}</strong></li>`;
  // **CIMD でないクライアント（DCR）は、名前も戻り先も誰でも好きに登録できる**（情報の置き場所というよりどころが無い）。
  // 第三者のページから `/authorize?<別のクライアント>` へ送られると、ログインの後に心当たりの無い同意画面が出うる
  // （#696 のセキュリティレビューの要確認 1。押さなければ害は無い）。
  const unverified =
    view.clientHost === null ? '<br>このアプリは、Game Forge が確認していないアプリです。' : '';
  const loopbackNote = view.loopback
    ? '\n  <li>この戻り先は<strong>このコンピュータの中</strong>です（Claude Code のように、手元で動くアプリが受け取ります）。</li>'
    : '';
  return `${siteHead({ title: 'アプリの接続の確認 - Game Forge', noindex: true, viewer: view.viewer })}
<h1>アプリの接続の確認</h1>
<section class="gf-block gf-block-rows" aria-label="接続するアプリ">
<div>
<p><strong>${escapeHtml(view.clientName)}</strong> が、あなたの Game Forge のアカウントへの接続を求めています。</p>
<p class="error" role="alert"><strong>このアプリの接続を自分で始めていなければ、許可しないでください。</strong>${unverified}</p>
<ul>
  <li>アプリ名は、アプリ自身が名乗った名前です。心当たりのないアプリなら、許可しないでください。</li>${origin}
  <li>許可した後の戻り先: <strong>${escapeHtml(view.redirectLabel)}</strong></li>${loopbackNote}
</ul>
</div>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="${CONSENT_TOKEN_FIELD}" value="${escapeHtml(view.consentToken)}">
<fieldset>
<legend>許可する範囲（外した範囲は許可しません）</legend>
<ul>
${scopeRows}
</ul>
</fieldset>
<p>許可は、設定の<a href="${ACCOUNT_APPS_PATH}">接続中のアプリ</a>からいつでも解除できます。許可は、最後に使ってから 30 日で切れます。使い続けていても、許可した日から 1 年で切れます。切れた後は、もう一度この画面で許可が必要です。</p>
<button type="submit" name="${CONSENT_DECISION_FIELD}" value="${DECISION_APPROVE}" class="gf-button gf-button-primary">許可する</button>
<button type="submit" name="${CONSENT_DECISION_FIELD}" value="${DECISION_DENY}" class="gf-button gf-button-secondary">許可しない</button>
</form>
</section>
${siteFooter()}`;
}

/**
 * 断りの画面を組み立てる。
 *
 * @param refusal 断りの中身
 * @param viewer ヘッダの出し分け
 * @returns HTML
 */
export function renderConsentRefusal(refusal: ConsentRefusal, viewer: SiteViewer): string {
  return `${siteHead({ title: `${refusal.heading} - Game Forge`, noindex: true, viewer })}
<h1>${escapeHtml(refusal.heading)}</h1>
<p class="gf-block">${escapeHtml(refusal.body)}</p>
${siteFooter()}`;
}

/**
 * 要求を持たずに `/authorize` を開いたときの説明の画面。
 *
 * @param viewer ヘッダの出し分け
 * @returns HTML
 */
export function renderAuthorizeLanding(viewer: SiteViewer): string {
  return `${siteHead({ title: 'AI アプリとの接続 - Game Forge', noindex: true, viewer })}
<h1>AI アプリとの接続</h1>
<p class="gf-block">この画面は、Claude などの AI アプリから Game Forge へ接続するときに、アプリが開きます。接続は、お使いの AI アプリの設定から始めてください。接続したアプリは、設定の<a href="${ACCOUNT_APPS_PATH}">接続中のアプリ</a>で確かめ、解除できます。</p>
${siteFooter()}`;
}

/**
 * 同意画面の系統の HTML 応答（{@link CONSENT_HEADERS} を付ける）。
 *
 * @param body HTML
 * @param status ステータス
 * @returns レスポンス
 */
function consentHtml(body: string, status: number): Response {
  return new Response(body, { status, headers: { ...CONSENT_HEADERS } });
}

/**
 * 断りの画面を返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param refusal 断りの中身
 * @returns レスポンス
 */
async function refuse(request: Request, env: Env, refusal: ConsentRefusal): Promise<Response> {
  return consentHtml(renderConsentRefusal(refusal, await resolveSiteViewer(request, env)), refusal.status);
}

/**
 * 303 の応答を組み立てる。
 *
 * @param location 遷移先
 * @param cookies 付ける `Set-Cookie`
 * @returns レスポンス
 */
function seeOther(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

/**
 * 戻り先へ OAuth の誤り（`error=`）を付けて返す（RFC 6749 4.1.2.1。`iss` は RFC 9207）。
 *
 * **戻り先が部品によって確かめられた後にだけ呼ぶ**（確かめる前の戻り先へ送ると、オープンリダイレクトになる）。
 *
 * @param redirectUri 確かめ済みの戻り先
 * @param code 誤りの種類
 * @param state クライアントの `state`
 * @param issuer 認可サーバーの issuer
 * @returns 303
 */
function redirectWithError(
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string | undefined,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', code);
  if (state !== undefined && state !== '') {
    url.searchParams.set('state', state);
  }
  if (issuer !== undefined && issuer !== '') {
    url.searchParams.set('iss', issuer);
  }
  return seeOther(url.toString());
}

/** 要求の検証の結果。 */
type ParsedAuthRequest =
  | { readonly ok: true; readonly request: AuthRequest }
  | { readonly ok: false; readonly response: Response };

/**
 * 認可の要求を検証する（部品の `parseAuthRequest`）。**例外を 500 にしない。**
 *
 * - 戻り先が確かめられた後の誤り（PKCE・resource・response_type）→ 戻り先へ `error=`
 * - 戻り先が確かめられない誤り（client_id が無い・知らない・戻り先の不一致）と、CIMD の文書が読めない → 400 の画面
 * - それ以外の例外（KV の不調など）→ 500 の画面（ログに種類だけ残す）
 *
 * @param helpers 部品の操作
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 検証の結果
 */
async function parseAuthorization(
  helpers: OAuthHelpers,
  request: Request,
  env: Env,
): Promise<ParsedAuthRequest> {
  try {
    return { ok: true, request: await helpers.parseAuthRequest(request) };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      console.error(`[oauth-authorize] 認可の要求を断りました: ${error.code}`);
      if (error.redirectUri !== undefined) {
        return { ok: false, response: redirectWithError(error.redirectUri, error.code, error.state, error.issuer) };
      }
      return { ok: false, response: await refuse(request, env, INVALID_REQUEST) };
    }
    if (error instanceof CimdFetchError) {
      console.error(`[oauth-authorize] CIMD の文書を読めませんでした: ${error.reason}`);
      return { ok: false, response: await refuse(request, env, INVALID_REQUEST) };
    }
    console.error(
      `[oauth-authorize] 認可の要求を検証できませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return { ok: false, response: await refuse(request, env, SERVER_FAILURE) };
  }
}

/**
 * 同意画面に出す scope を決める。
 *
 * - 要求に scope が無ければ、許せる scope をすべて出す（クライアントは保護されたリソースのメタデータの
 *   `scopes_supported` を見て、scope を付けずに来ることがある）
 * - 要求に scope があれば、そのうち**許せるものだけ**を出す（知らない scope は黙って落とす——OAuth は要求より狭い
 *   許可を認めており、発行するトークンの `scope` にどれを許したかが載る）
 * - 要求の scope が 1 つも許せなければ空（呼ぶ側が `invalid_scope` で返す）
 *
 * @param requested 要求の scope
 * @returns 同意画面に出す scope（{@link OAUTH_SCOPES} の並び）
 */
export function offeredScopes(requested: readonly string[]): string[] {
  if (requested.length === 0) {
    return [...OAUTH_SCOPES];
  }
  return OAUTH_SCOPES.filter((scope) => requested.includes(scope));
}

/**
 * 認可の要求を、同意の値の署名に使う 1 本の文字列にする。
 *
 * **部品が検証した値だけ**を並べる（URL の生の query ではなく、解いた結果）。並びは固定で、JSON の配列にして区切りの
 * 取り違えを起こさない。
 *
 * @param request 検証済みの要求
 * @returns 正規化した文字列
 */
function canonicalAuthRequest(request: AuthRequest): string {
  const resource =
    request.resource === undefined ? '' : Array.isArray(request.resource) ? request.resource.join('\n') : request.resource;
  return JSON.stringify([
    request.responseType,
    request.clientId,
    request.redirectUri,
    [...request.scope].join(' '),
    request.state,
    request.codeChallenge ?? '',
    request.codeChallengeMethod ?? '',
    resource,
    request.issuer ?? '',
  ]);
}

/** HMAC の鍵のキャッシュ。 */
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * `SESSION_SECRET` から HMAC-SHA256 の鍵を取り出す。
 *
 * **空・32 文字未満の秘密を受けない**（`src/session.ts` と `src/auth/google.ts` の `importKey` と同じ条件）。
 *
 * @param secret `SESSION_SECRET`
 * @returns 鍵
 * @throws 秘密が未設定・短すぎる場合
 */
async function importKey(secret: unknown): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('SESSION_SECRET が未設定です。同意の値に署名できません。');
  }
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET が短すぎます（32 文字以上が必要です）。');
  }
  let pending = keyCache.get(secret);
  if (pending === undefined) {
    pending = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, pending);
  }
  return await pending;
}

/**
 * 用途つきで署名する。
 *
 * @param secret `SESSION_SECRET`
 * @param domain 用途の識別子
 * @param body 署名する本文
 * @returns base64url の署名
 */
async function sign(secret: unknown, domain: string, body: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await importKey(secret), new TextEncoder().encode(`${domain}:${body}`));
  return encodeBase64Url(new Uint8Array(signature));
}

/**
 * 用途つきの署名を確かめる（比較は `crypto.subtle.verify` に委ねる。時間の差で漏らさない）。
 *
 * @param secret `SESSION_SECRET`
 * @param domain 用途の識別子
 * @param body 署名した本文
 * @param signatureText base64url の署名
 * @returns 合えば true
 */
async function verify(secret: unknown, domain: string, body: string, signatureText: string): Promise<boolean> {
  const signature = decodeBase64Url(signatureText);
  if (signature === null) {
    return false;
  }
  return await crypto.subtle.verify('HMAC', await importKey(secret), signature, new TextEncoder().encode(`${domain}:${body}`));
}

/**
 * 同意の値の本文（利用者の id・期限・要求のハッシュ）。
 *
 * @param userId 利用者の id
 * @param expiresAt 期限（UNIX 秒）
 * @param request 検証済みの要求
 * @returns 本文
 */
async function consentBody(userId: string, expiresAt: number, request: AuthRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalAuthRequest(request)));
  return JSON.stringify([userId, expiresAt, encodeBase64Url(new Uint8Array(digest))]);
}

/**
 * 同意の値を作る（`<期限>.<署名>`）。**利用者の id・認可の要求・期限を 1 つの HMAC で結ぶ。**
 *
 * @param secret `SESSION_SECRET`
 * @param userId 利用者の id
 * @param request 検証済みの要求
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 同意の値
 */
export async function signConsentToken(
  secret: unknown,
  userId: string,
  request: AuthRequest,
  nowSeconds: number,
): Promise<string> {
  const expiresAt = nowSeconds + CONSENT_TTL_SECONDS;
  return `${expiresAt}.${await sign(secret, CONSENT_DOMAIN, await consentBody(userId, expiresAt, request))}`;
}

/**
 * 同意の値を照合する。
 *
 * **期限は「過ぎていない」だけでなく「寿命より先でない」も見る**（こちらが作らない形の値を受けない）。
 *
 * @param secret `SESSION_SECRET`
 * @param token 送られた値
 * @param userId いまのセッションの利用者の id
 * @param request 検証済みの要求（POST の URL の query を部品が解いたもの）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 合えば true
 */
export async function verifyConsentToken(
  secret: unknown,
  token: string,
  userId: string,
  request: AuthRequest,
  nowSeconds: number,
): Promise<boolean> {
  const match = /^([0-9]{1,15})\.([A-Za-z0-9_-]+)$/u.exec(token);
  if (match === null) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + CONSENT_TTL_SECONDS) {
    return false;
  }
  return await verify(secret, CONSENT_DOMAIN, await consentBody(userId, expiresAt, request), match[2]!);
}

/**
 * 一時 cookie に積む値を作る（`<期限>.<base64url(query)>.<署名>`）。
 *
 * @param secret `SESSION_SECRET`
 * @param query 認可の要求の query（`?` を除く）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns cookie の値
 */
export async function signPendingAuthorization(secret: unknown, query: string, nowSeconds: number): Promise<string> {
  const body = `${nowSeconds + PENDING_MAX_AGE_SECONDS}.${encodeBase64Url(new TextEncoder().encode(query))}`;
  return `${body}.${await sign(secret, PENDING_DOMAIN, body)}`;
}

/**
 * 一時 cookie の値を確かめて、積んだ query を取り出す。
 *
 * @param secret `SESSION_SECRET`
 * @param value cookie の値
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns query。読めない・期限切れ・署名が合わないなら null
 */
export async function verifyPendingAuthorization(
  secret: unknown,
  value: string,
  nowSeconds: number,
): Promise<string | null> {
  const match = /^([0-9]{1,15})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(value);
  if (match === null) {
    return null;
  }
  const expiresAt = Number(match[1]);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + PENDING_MAX_AGE_SECONDS) {
    return null;
  }
  if (!(await verify(secret, PENDING_DOMAIN, `${match[1]}.${match[2]}`, match[3]!))) {
    return null;
  }
  const bytes = decodeBase64Url(match[2]!);
  if (bytes === null) {
    return null;
  }
  try {
    const query = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return query.length <= MAX_PENDING_QUERY_LENGTH ? query : null;
  } catch {
    return null;
  }
}

/**
 * 一時 cookie の `Set-Cookie` の値（`__Host-` の受理条件をすべて満たす形）。
 *
 * @param value 署名済みの値
 * @returns `Set-Cookie`
 */
function buildPendingCookie(value: string): string {
  return [`${PENDING_COOKIE}=${value}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', `Max-Age=${PENDING_MAX_AGE_SECONDS}`].join(
    '; ',
  );
}

/**
 * 一時 cookie を消す `Set-Cookie` の値。
 *
 * @returns `Set-Cookie`
 */
function clearPendingCookie(): string {
  return [`${PENDING_COOKIE}=`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'].join('; ');
}

/**
 * `Cookie` ヘッダから 1 つの cookie の値を取り出す。
 *
 * @param header `Cookie` ヘッダ
 * @param name 名前
 * @returns 値（無ければ null）
 */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) {
    return null;
  }
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    const separator = trimmed.indexOf('=');
    if (separator !== -1 && trimmed.slice(0, separator) === name) {
      const value = trimmed.slice(separator + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * 未ログインの利用者を、要求を積んでログインへ送る。
 *
 * ログインの戻り先は**定数の {@link AUTHORIZE_RESUME_PATH} だけ**（`loginRequiredRedirect` へ渡すのは画面の定数だけ、という
 * `src/auth/google.ts` の約束を守る）。要求（query）は別の一時 cookie に積む。積めない（長すぎる・署名できない）ときは
 * 積まずにログインへ送る——戻った先で「要求が見つからない」画面になる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns ログインへの 303
 */
async function sendToLogin(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  const response = await loginRequiredRedirect(env, AUTHORIZE_RESUME_PATH);
  const query = new URL(request.url).search.replace(/^\?/u, '');
  if (query === '' || query.length > MAX_PENDING_QUERY_LENGTH) {
    return response;
  }
  try {
    response.headers.append('set-cookie', buildPendingCookie(await signPendingAuthorization(env.SESSION_SECRET, query, nowSeconds)));
  } catch (error) {
    console.error(
      `[oauth-authorize] 認可の要求を積めませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
  return response;
}

/**
 * 戻り先を同意画面に出す形にする。
 *
 * @param redirectUri 確かめ済みの戻り先
 * @returns 表示と、loopback かどうか
 */
export function describeRedirect(redirectUri: string): { readonly label: string; readonly loopback: boolean } {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { label: redirectUri, loopback: false };
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (host === 'localhost' || host === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/u.test(host));
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return { label: url.hostname, loopback };
  }
  // アプリ独自の scheme（`cursor://` など）。ホストが空のこともあるので scheme ごと出す。
  return { label: `${url.protocol}${url.host === '' ? '' : `//${url.host}`}`, loopback: false };
}

/**
 * クライアントの名前と、CIMD なら情報の置き場所のホスト名を決める。
 *
 * @param helpers 部品の操作
 * @param clientId クライアントの id
 * @returns 名前と置き場所
 */
async function describeClient(
  helpers: OAuthHelpers,
  clientId: string,
): Promise<{ readonly name: string; readonly host: string | null }> {
  const client = await helpers.lookupClient(clientId);
  let host: string | null = null;
  if (/^https:\/\//u.test(clientId)) {
    try {
      host = new URL(clientId).hostname;
    } catch {
      host = null;
    }
  }
  const named = client?.clientName?.trim() ?? '';
  return { name: named !== '' ? named.slice(0, 100) : (host ?? '名前のないアプリ'), host };
}

/**
 * `GET /authorize` — 同意画面を出す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function showConsent(request: Request, env: Env, now: () => number): Promise<Response> {
  if (new URL(request.url).search === '') {
    // **要求を持たずに開かれた**（URL を直接開いた・ブックマーク）。誤りではないので、何の画面かを 200 で説明する。
    return consentHtml(renderAuthorizeLanding(await resolveSiteViewer(request, env)), 200);
  }
  const origin = new URL(request.url).origin;
  const helpers = oauthHelpers(env, origin);
  const parsed = await parseAuthorization(helpers, request, env);
  if (!parsed.ok) {
    return parsed.response;
  }
  const authRequest = parsed.request;
  const scopes = offeredScopes(authRequest.scope);
  if (scopes.length === 0) {
    return redirectWithError(authRequest.redirectUri, 'invalid_scope', authRequest.state, authRequest.issuer);
  }

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await sendToLogin(request, env, now());
  }
  if (session.userId.includes(':')) {
    // 部品はトークンを `<利用者の id>:<許可の id>:<秘密>` の形で作る。`:` を含む id は、形を崩す。
    console.error('[oauth-authorize] 利用者の id が部品の形に合いません');
    return await refuse(request, env, SERVER_FAILURE);
  }

  try {
    const client = await describeClient(helpers, authRequest.clientId);
    const redirect = describeRedirect(authRequest.redirectUri);
    const url = new URL(request.url);
    return consentHtml(
      renderConsentPage({
        clientName: client.name,
        clientHost: client.host,
        redirectLabel: redirect.label,
        loopback: redirect.loopback,
        scopes,
        consentToken: await signConsentToken(env.SESSION_SECRET, session.userId, authRequest, now()),
        action: `${AUTHORIZE_PATH}${url.search}`,
        viewer: siteViewerAt(AUTHORIZE_PATH, true, headerAvatarUrl(request, env, session.userId)),
      }),
      200,
    );
  } catch (error) {
    console.error(`[oauth-authorize] 同意画面を組めませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return await refuse(request, env, SERVER_FAILURE);
  }
}

/**
 * `POST /authorize` — 同意（承諾・拒否）を受ける。
 *
 * **セッションを先に見る**（未ログイン・BAN・退会はログインへ）。その後に本文を読み、要求を検証し、同意の値を照合する。
 * **照合の前には何も書かない。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleConsent(request: Request, env: Env, now: () => number): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await sendToLogin(request, env, now());
  }

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return await refuse(request, env, INVALID_REQUEST);
  }
  const read = await readLimitedText(request, MAX_CONSENT_BODY_BYTES);
  if (!read.ok) {
    return await refuse(request, env, INVALID_REQUEST);
  }
  const form = new URLSearchParams(read.text);

  const origin = new URL(request.url).origin;
  const helpers = oauthHelpers(env, origin);
  const parsed = await parseAuthorization(helpers, request, env);
  if (!parsed.ok) {
    return parsed.response;
  }
  const authRequest = parsed.request;

  const tokens = form.getAll(CONSENT_TOKEN_FIELD);
  let verified = false;
  try {
    verified =
      tokens.length === 1 &&
      (await verifyConsentToken(env.SESSION_SECRET, tokens[0]!, session.userId, authRequest, now()));
  } catch (error) {
    console.error(`[oauth-authorize] 同意の値を照合できませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return await refuse(request, env, SERVER_FAILURE);
  }
  if (!verified) {
    console.error('[oauth-authorize] 同意の値が合いませんでした');
    return await refuse(request, env, CONSENT_MISMATCH);
  }

  const decisions = form.getAll(CONSENT_DECISION_FIELD);
  const decision = decisions.length === 1 ? decisions[0] : undefined;
  if (decision !== DECISION_APPROVE && decision !== DECISION_DENY) {
    return await refuse(request, env, INVALID_REQUEST);
  }
  const offered = offeredScopes(authRequest.scope);
  const chosen = offered.filter((scope) => form.getAll(CONSENT_SCOPE_FIELD).includes(scope));
  if (decision === DECISION_DENY || chosen.length === 0) {
    // **scope を 1 つも選ばなかったら拒否として扱う**（空の許可を作らない）。
    return redirectWithError(authRequest.redirectUri, 'access_denied', authRequest.state, authRequest.issuer);
  }

  const verdict = await guardConsent(env, session.userId, now());
  if (verdict !== 'allowed') {
    return await refuse(request, env, verdict === 'rate-limited' ? CONSENT_RATE_LIMITED : SERVER_FAILURE);
  }

  try {
    const client = await describeClient(helpers, authRequest.clientId);
    const metadata: OAuthGrantMetadata = {
      clientName: client.name,
      redirectHost: describeRedirect(authRequest.redirectUri).label,
    };
    const { redirectTo } = await helpers.completeAuthorization({
      request: authRequest,
      userId: session.userId,
      metadata,
      scope: chosen,
      props: { userId: session.userId },
    });
    return seeOther(redirectTo);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      console.error(`[oauth-authorize] 許可を完了できませんでした: ${error.code}`);
      return await refuse(request, env, INVALID_REQUEST);
    }
    console.error(`[oauth-authorize] 許可を完了できませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return await refuse(request, env, SERVER_FAILURE);
  }
}

/**
 * `GET /authorize/resume` — ログインから戻った利用者の要求を、一時 cookie から受け直す。
 *
 * **画面ではない**（必ず 303 を返す。`src/page-paths.ts` の `NON_PAGE_PATHS`）。cookie が読めれば `/authorize?<積んだ query>`
 * へ、読めなければ `/authorize?expired=1`（client_id の無い要求）へ送り、そこが 400 の「接続の要求を受け付けられませんでした」
 * （正しくないか、期限が切れています）を出す。
 * どちらでも一時 cookie は消す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns 303
 */
async function resumeAuthorization(request: Request, env: Env, now: () => number): Promise<Response> {
  const value = readCookie(request.headers.get('cookie'), PENDING_COOKIE);
  let query: string | null = null;
  if (value !== null) {
    try {
      query = await verifyPendingAuthorization(env.SESSION_SECRET, value, now());
    } catch (error) {
      console.error(`[oauth-authorize] 積んだ要求を読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
  return seeOther(query === null || query === '' ? `${AUTHORIZE_PATH}?expired=1` : `${AUTHORIZE_PATH}?${query}`, [
    clearPendingCookie(),
  ]);
}

/**
 * 同意画面の経路を組み立てる（時刻を差し替えられるのはここだけ。`src/account.ts` の `createAccountRoutes` と同じ形）。
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createAuthorizeRoutes(options: { readonly now?: () => number } = {}): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return [
    { method: 'GET', path: AUTHORIZE_PATH, handler: (request, env) => showConsent(request, env, now) },
    { method: 'POST', path: AUTHORIZE_PATH, handler: (request, env) => handleConsent(request, env, now) },
    { method: 'GET', path: AUTHORIZE_RESUME_PATH, handler: (request, env) => resumeAuthorization(request, env, now) },
  ];
}

/** アプリの経路表へ連結する同意画面の経路（#696）。 */
export const authorizeRoutes: readonly Route[] = createAuthorizeRoutes();

/**
 * バイト列を base64url（パディングなし）にする。
 *
 * @param bytes バイト列
 * @returns base64url
 */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * base64url を解く。
 *
 * @param text base64url
 * @returns バイト列（解けなければ null）
 */
function decodeBase64Url(text: string): Uint8Array | null {
  if (text === '' || !/^[A-Za-z0-9_-]+$/u.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
