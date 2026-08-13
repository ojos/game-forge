/**
 * Google OAuth のログイン開始・コールバック・ログアウト（8.1 / #12 T4）。
 *
 * ログイン手段は Google OAuth のみ（8.1）。X API の料金・ポリシー変更リスクを
 * 認証基盤という土台に持ち込まないための決定であり、ここへ別の手段を足さない。
 *
 * cookie の署名・検証そのものは `src/session.ts`（T2）が持つ。このモジュールは
 * 「認可コードを受け取り、`users` 行を作り、署名付きセッション cookie を発行する」
 * ところだけを担当する。
 *
 * **サーバ側に一時ストアを置かない。** `state` と PKCE の `code_verifier` は
 * 短命の署名付き cookie に載せる。D1 の書き込み無料枠は読み取りより桁で小さく（3.6）、
 * ログインのたびに行を書いて消す形は真っ先に枯れる。cookie に載せても、署名で改竄を
 * 検知でき、有効期限で寿命を切れるため、ストアが要る理由がない。
 *
 * **招待コードとの結線はここに持ち込まない。** `users.invited_by` は #14（T7）が
 * 埋める。8.1 の登録フロー（招待コードの検証が先、Google OAuth が後）は、招待側の
 * 経路が確定してから組む。ここで先取りすると、並行して進む #13 の完了を待つことになる。
 */
import type { Route } from '../routes.js';
import { json } from '../routes.js';
import { buildSessionCookie, clearSessionCookie, signSession } from '../session.js';
import { normalizeInviteCode } from '../invite-code.js';
import { SIGNUP_PATH } from '../paths.js';
import type { InviteRejection } from '../invites.js';
import { consumeInvite } from '../invites.js';

/** 認可エンドポイント（ここへ利用者をリダイレクトする）。 */
const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** トークンエンドポイント（認可コードを ID トークンへ交換する）。 */
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * ID トークンの `iss` として受け付ける値。
 *
 * Google は歴史的に 2 つの表記を返す。片方だけを許すと、ある日もう片方が返った
 * 瞬間に全ログインが落ちる。逆に検査を省くと、他人が発行したトークンを
 * 受け入れる余地が残る。
 */
const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** 要求するスコープ。`openid` は ID トークンを、残り 2 つは email と表示名を得るために要る。 */
const GOOGLE_SCOPE = 'openid email profile';

/** ログイン開始の経路。 */
export const LOGIN_PATH = '/auth/google/start';

/** Google からの戻り先。Google Cloud コンソールへ登録する URI もこのパスになる。 */
export const CALLBACK_PATH = '/auth/google/callback';

/** ログアウトの経路。**GET を受けない**（`<img>` で他人をログアウトさせられるため）。 */
export const LOGOUT_PATH = '/auth/logout';

/**
 * `state` と `code_verifier` を載せる一時 cookie の名前。
 *
 * セッション cookie と同じく `__Host-` 接頭辞を使う（7.2 必須要件 2）。この cookie は
 * セッションではないが、サンドボックス用ホストから上書きできてしまうと、攻撃者が
 * 自分の `state` を仕込んでコールバックを通せる（ログイン CSRF）。接頭辞は
 * その経路を塞ぐ。
 */
export const OAUTH_COOKIE = '__Host-gf_oauth';

/**
 * 一時 cookie の寿命（秒）。
 *
 * 利用者が Google の同意画面で迷う時間を見込んで 10 分。長くすると、盗まれた
 * `code_verifier` が使える窓が広がる。短くすると正規の利用者が失敗する。
 */
const OAUTH_COOKIE_MAX_AGE = 600;

/**
 * セッション cookie の寿命（秒）。
 *
 * **サーバ側にセッションストアを置かない以上、発行済みトークンを失効させる手段が
 * 無い。** 寿命だけが唯一の制御なので、長すぎる値にしない。7 日は、毎日使う人が
 * 再ログインを求められない下限として選んだ。
 */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * 一時 cookie の署名に混ぜる用途識別子。
 *
 * セッション cookie と同じ `SESSION_SECRET` で署名するため、片方のトークンを
 * もう片方として通されないよう、署名対象の先頭へ用途を書く。形式が違う（セッションは
 * 2 要素、こちらは 4 要素）ので実際には混同しにくいが、鍵を共有する以上、
 * 分離は署名側で明示しておく。
 */
const OAUTH_STATE_DOMAIN = 'gf-oauth-state.v2';

/**
 * 招待コードを持たないことを表す、一時 cookie 上の印。
 *
 * 空文字にしない。`a..b` のように区切りが連続する形は、要素数の数え方を実装ごとに
 * ぶれさせる。招待コードの文字集合（Crockford Base32）に `-` は含まれないため、
 * 正規形のコードと取り違えられない。
 */
const NO_INVITE_MARK = '-';

/** 認証で必要になる秘密の名前。不足を報告するときは**名前だけ**を出す（値は決して出さない）。 */
const REQUIRED_SECRETS = ['SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

/** ID トークンから取り出した利用者の同一性。 */
export interface GoogleIdentity {
  /** Google のアカウント識別子。`users.google_sub` に対応し、同一性の判定はこれで行う。 */
  readonly sub: string;
  readonly email: string;
  readonly displayName: string;
}

/** トークンエンドポイントへ渡す値。 */
export interface TokenExchangeParams {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** 交換の結果。失敗を例外にせず値で返す（呼び出し側が握り潰しにくい）。 */
export type TokenExchangeResult =
  | { readonly ok: true; readonly idToken: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 認可コードを ID トークンへ交換する関数。
 *
 * **テストから差し替えるための継ぎ目（seam）。** ここを固定の実装にすると、
 * コールバックの単体テストが Google への実 HTTP を要求することになり、
 * ネットワークの可用性が受け入れ条件へ混ざる（loop-workflow.md の
 * 「受け入れ条件の二層」でローカル層に置けなくなる）。
 */
export type TokenExchange = (params: TokenExchangeParams) => Promise<TokenExchangeResult>;

/** 経路が使う外部依存。テストはここを差し替えて時刻と乱数を固定する。 */
export interface AuthDependencies {
  /** 認可コードの交換。既定は Google のトークンエンドポイントへの POST。 */
  readonly exchange: TokenExchange;
  /** 現在時刻（UNIX 秒）。 */
  readonly now: () => number;
  /** `state` と `code_verifier` に使う推測困難な文字列。 */
  readonly randomToken: () => string;
}

/** ID トークンを受け付けなかった理由。ログに残すためのもので、クライアントへは返さない。 */
export type IdTokenRejection =
  | 'malformed'
  | 'bad-payload'
  | 'bad-issuer'
  | 'bad-audience'
  | 'expired'
  | 'no-subject'
  | 'no-email'
  | 'unverified-email';

/** ID トークンの検証結果。 */
export type IdTokenVerification =
  | { readonly ok: true; readonly identity: GoogleIdentity }
  | { readonly ok: false; readonly reason: IdTokenRejection };

/**
 * コールバックでの利用者の解決結果。
 *
 * 失敗の理由は**分類だけ**を持つ。登録画面が文言を出し分けるのに要るのはここまでで、
 * どのコードがどう駄目だったかを URL に載せると、そのまま総当たりの手がかりになる。
 */
export type UserResolution =
  | { readonly ok: true; readonly id: string; readonly banned: boolean }
  | { readonly ok: false; readonly reason: 'invite-required' | 'retry' | InviteRejection };

/** 一時 cookie に載せる値。 */
interface OAuthState {
  readonly state: string;
  readonly codeVerifier: string;
  /** 失効時刻（UNIX 秒）。この時刻を過ぎたものは検証で落ちる。 */
  readonly expiresAt: number;
  /**
   * 検証済みの招待コード（正規形）。既存利用者のログインでは null。
   *
   * 8.1 は登録フローを「招待コードの検証が先、Google OAuth が後」と定めるため、
   * **検証した事実を OAuth の往復の向こう側まで運ぶ必要がある。** 別の cookie を
   * 立てず、この cookie へ相乗りさせる。寿命・署名・破棄の契機が 1 つで済み、
   * 「state は生きているが招待コードだけ失効している」という状態が作れない。
   *
   * サーバ側に「検証待ち」の行を作らない理由は、D1 の書き込み枠が読み取りより
   * 桁で小さいこと（3.6）と、登録を試みるだけで書き込みが発生する経路を
   * 外部へ晒さないこと（7.3）の両方による。
   */
  readonly inviteCode: string | null;
}

/**
 * 認可コードを Google のトークンエンドポイントで交換する（既定の seam 実装）。
 *
 * 失敗しても投げない。ネットワーク障害と「Google が拒否した」を同じ経路で扱い、
 * 呼び出し側が 1 か所で扱えるようにする。**応答本文をそのままログへ出さない**
 * （client_secret は送信するだけで応答には現れないが、応答には ID トークンが
 * 含まれるため、丸ごと出すと利用者の識別子がログへ落ちる）。
 *
 * @param params 交換に必要な値
 * @returns ID トークン、または失敗の理由
 */
export async function exchangeCodeWithGoogle(
  params: TokenExchangeParams,
): Promise<TokenExchangeResult> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        // PKCE の検証子。認可要求で送った challenge と対応することを Google 側が確かめる。
        code_verifier: params.codeVerifier,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        redirect_uri: params.redirectUri,
      }).toString(),
    });
  } catch (error) {
    console.error('[auth] トークンエンドポイントへ到達できませんでした', error);
    return { ok: false, reason: 'network' };
  }

  if (!response.ok) {
    console.error('[auth] トークンエンドポイントが失敗を返しました', response.status);
    return { ok: false, reason: `status ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.error('[auth] トークンエンドポイントの応答を JSON として読めませんでした', error);
    return { ok: false, reason: 'unparsable' };
  }

  const idToken = (body as Record<string, unknown> | null)?.['id_token'];
  if (typeof idToken !== 'string' || idToken === '') {
    console.error('[auth] トークンエンドポイントの応答に id_token がありません');
    return { ok: false, reason: 'no-id-token' };
  }
  return { ok: true, idToken };
}

/**
 * 認証の経路を組み立てる。
 *
 * 依存を引数で受けるのは、コールバックのテストを**ネットワークなしで**書けるように
 * するため。既定値を使えば本番の振る舞いになり、テストは必要な依存だけを差し替える。
 *
 * @param overrides 差し替える依存（省略した項目は既定を使う）
 * @returns 経路表へ連結する `Route[]`
 */
export function createAuthRoutes(overrides: Partial<AuthDependencies> = {}): readonly Route[] {
  const deps = resolveAuthDependencies(overrides);

  return [
    { method: 'GET', path: LOGIN_PATH, handler: (request, env) => startLogin(request, env, deps) },
    {
      method: 'GET',
      path: CALLBACK_PATH,
      handler: (request, env) => handleCallback(request, env, deps),
    },
    // ログアウトを GET にしない。GET なら `<img src="/auth/logout">` を踏ませるだけで
    // 他人をログアウトさせられる（実害は小さいが、状態を変える要求を GET に置かない）。
    { method: 'POST', path: LOGOUT_PATH, handler: () => handleLogout() },
  ];
}

/**
 * アプリの経路表へ連結する認証の経路（既定の依存）。
 */
export const authRoutes: readonly Route[] = createAuthRoutes();

/**
 * 差し替えられた依存へ既定値を補う。
 *
 * @param overrides 差し替える依存
 * @returns すべての項目が埋まった依存
 */
function resolveAuthDependencies(overrides: Partial<AuthDependencies>): AuthDependencies {
  return {
    exchange: exchangeCodeWithGoogle,
    now: () => Math.floor(Date.now() / 1000),
    randomToken: generateRandomToken,
    ...overrides,
  };
}

/**
 * 検証済みの招待コードを携えてログインを開始する。
 *
 * 登録画面（#14 の T7）から呼ぶ。**招待コードの検証は呼び出し側の責務**で、ここは
 * 「検証済みである」という前提を OAuth の往復へ運ぶだけを受け持つ。未検証の値を
 * 渡すと、コールバックで消費に失敗して登録が中断する（アカウントは作られない）。
 *
 * `LOGIN_PATH` の経路と実装を共有するのは、認可要求の組み立て（PKCE・state・
 * リダイレクト先）が 2 か所に分かれると、片方だけ直る事故が起きるためである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param inviteCode 検証済みの招待コード（正規形）
 * @param overrides 差し替える依存（テスト用）
 * @returns Google の認可エンドポイントへのリダイレクト
 */
export async function startInvitedLogin(
  request: Request,
  env: Env,
  inviteCode: string,
  overrides: Partial<AuthDependencies> = {},
): Promise<Response> {
  return await startLogin(request, env, resolveAuthDependencies(overrides), inviteCode);
}

/**
 * ログインを開始する。
 *
 * `state`（CSRF 対策）と `code_verifier`（PKCE）を作り、署名付きの一時 cookie に
 * 載せてから Google の同意画面へ送る。cookie に載せた `code_verifier` は
 * コールバックで Google へ提示する。**認可コードを横取りされても、verifier を
 * 持たない側は交換できない**というのが PKCE の効き方である。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param deps 外部依存
 * @returns Google の認可エンドポイントへのリダイレクト
 */
async function startLogin(
  request: Request,
  env: Env,
  deps: AuthDependencies,
  inviteCode: string | null = null,
): Promise<Response> {
  const missing = missingSecrets(env);
  if (missing.length > 0) {
    return notConfigured(missing);
  }

  try {
    const state = deps.randomToken();
    const codeVerifier = deps.randomToken();
    const expiresAt = deps.now() + OAUTH_COOKIE_MAX_AGE;
    const cookie = await signOAuthState(
      { state, codeVerifier, expiresAt, inviteCode },
      env.SESSION_SECRET,
    );

    const authorize = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
    authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', redirectUri(request));
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', GOOGLE_SCOPE);
    authorize.searchParams.set('state', state);
    // PKCE は S256 のみ。`plain` は verifier をそのまま送るため、認可要求を
    // 覗ける相手には何の保護にもならない。
    authorize.searchParams.set('code_challenge', await createPkceChallenge(codeVerifier));
    authorize.searchParams.set('code_challenge_method', 'S256');

    return redirect(authorize.toString(), [buildOAuthCookie(cookie)]);
  } catch (error) {
    console.error('[auth] ログインの開始に失敗しました', error);
    return json({ error: 'internal error' }, 500);
  }
}

/**
 * Google からのコールバックを処理する。
 *
 * 順序に意味がある。**先に `state` を照合し、通ってからコードを交換する。**
 * 逆にすると、攻撃者が仕込んだコードでトークンエンドポイントを叩かされる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param deps 外部依存
 * @returns セッション cookie を伴うリダイレクト、または失敗のレスポンス
 */
async function handleCallback(
  request: Request,
  env: Env,
  deps: AuthDependencies,
): Promise<Response> {
  const missing = missingSecrets(env);
  if (missing.length > 0) {
    return notConfigured(missing);
  }

  // 一時 cookie はどの経路を通っても 1 回で使い切る。成功しても失敗しても消す
  // （残すと、期限内に同じ `state` で何度でも試せる）。
  const discardOAuthCookie = clearOAuthCookie();

  try {
    const url = new URL(request.url);

    // 利用者が同意しなかった場合など、Google はエラーを query で返す。ここを
    // 見落とすと「code が無い」という別の理由で落ち、原因が読めなくなる。
    const denied = url.searchParams.get('error');
    if (denied !== null) {
      return withCookies(json({ error: 'oauth denied', reason: denied }, 400), [
        discardOAuthCookie,
      ]);
    }

    const cookie = readCookie(request.headers.get('cookie'), OAUTH_COOKIE);
    if (cookie === null) {
      return withCookies(json({ error: 'oauth state missing' }, 400), [discardOAuthCookie]);
    }
    const verified = await verifyOAuthState(cookie, env.SESSION_SECRET, deps.now());
    if (verified === null) {
      // 理由をクライアントへ返さない。改竄・期限切れ・別ブラウザのどれであっても、
      // 利用者にできることは「もう一度ログインする」だけである。
      console.error('[auth] 一時 cookie の検証に失敗しました');
      return withCookies(json({ error: 'oauth state invalid' }, 400), [discardOAuthCookie]);
    }

    const state = url.searchParams.get('state');
    if (state === null || state !== verified.state) {
      // ここが CSRF の入口。攻撃者のコードを利用者のブラウザで交換させられると、
      // 利用者が攻撃者のアカウントでログインした状態になる。
      console.error('[auth] state が一致しません');
      return withCookies(json({ error: 'oauth state mismatch' }, 400), [discardOAuthCookie]);
    }

    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      return withCookies(json({ error: 'oauth code missing' }, 400), [discardOAuthCookie]);
    }

    const exchanged = await deps.exchange({
      code,
      codeVerifier: verified.codeVerifier,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUri(request),
    });
    if (!exchanged.ok) {
      console.error('[auth] 認可コードの交換に失敗しました', exchanged.reason);
      return withCookies(json({ error: 'oauth exchange failed' }, 502), [discardOAuthCookie]);
    }

    const identity = parseGoogleIdToken(exchanged.idToken, env.GOOGLE_CLIENT_ID, deps.now());
    if (!identity.ok) {
      console.error('[auth] ID トークンを受け付けませんでした', identity.reason);
      return withCookies(json({ error: 'oauth identity invalid' }, 401), [discardOAuthCookie]);
    }

    const user = await resolveUser(env.DB, identity.identity, verified.inviteCode, deps.now());
    if (!user.ok) {
      // 招待が無い / 使えない場合はアカウントを作らないまま登録画面へ戻す。理由を
      // query に載せるのは、登録画面が文言を出し分けるため（値ではなく分類のみ）。
      return redirect(`${SIGNUP_PATH}?reason=${user.reason}`, [discardOAuthCookie]);
    }
    if (user.banned) {
      // BAN は google_sub 単位（7.3）。行を消さないため、ここで毎回はじく。
      console.error('[auth] BAN された利用者のログインを拒否しました');
      return withCookies(json({ error: 'account suspended' }, 403), [discardOAuthCookie]);
    }

    const issuedAt = deps.now();
    const token = await signSession(
      { userId: user.id, issuedAt, expiresAt: issuedAt + SESSION_MAX_AGE },
      env.SESSION_SECRET,
    );
    return redirect('/', [buildSessionCookie(token, SESSION_MAX_AGE), discardOAuthCookie]);
  } catch (error) {
    console.error('[auth] コールバックの処理に失敗しました', error);
    return withCookies(json({ error: 'internal error' }, 500), [discardOAuthCookie]);
  }
}

/**
 * ログアウトする。
 *
 * **秘密の設定に依存させない。** 署名鍵が無い環境でもログアウトだけは必ず成立
 * させたい（cookie を消すのに鍵は要らない）。ここで `missingSecrets` を見ると、
 * 設定を壊した瞬間にログアウト不能になる。
 *
 * @returns セッション cookie を破棄するリダイレクト
 */
function handleLogout(): Response {
  return redirect('/', [clearSessionCookie()]);
}

/**
 * ログインしてきた利用者を解決する。既存なら引き当て、新規なら招待を消費して作る。
 *
 * **ここが 8.1 の「生成は招待コード保有者のみ」を機構にしている箇所である。**
 * 招待の検証は登録画面（`POST /signup`）が先に行うが、そこを通らずコールバックへ
 * 直接来る経路（`GET /auth/google/start` からの素のログイン）が常にあるため、
 * *アカウントを作る側*でも招待の有無を条件にする。画面側の検査だけに頼ると、
 * 画面を経由しない要求で登録できてしまう。
 *
 * @param db D1 バインディング
 * @param identity ID トークンから取り出した同一性
 * @param inviteCode 一時 cookie が運んできた検証済みの招待コード（無ければ null）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 解決結果
 */
async function resolveUser(
  db: D1Database,
  identity: GoogleIdentity,
  inviteCode: string | null,
  nowSeconds: number,
): Promise<UserResolution> {
  const existing = await refreshExistingUser(db, identity);
  if (existing !== null) {
    // 既存利用者は招待を消費しない。再ログインのたびに枠が減ると、招待が
    // 「1 人を呼ぶ権利」ではなく「1 回ログインする権利」になってしまう。
    return { ok: true, id: existing.id, banned: existing.banned };
  }

  if (inviteCode === null) {
    return { ok: false, reason: 'invite-required' };
  }

  // 招待の消費は `users` 行が存在してからでないと `invited_by` を書けない（#13 の
  // `consumeInvite` は `users` を条件付き UPDATE する）。そのため
  // 「作る → 消費する → 失敗したら作った行を消す」という補償の形を採る。
  //
  // 逆順（消費してから作る）にすると、作成が落ちたときに**誰も使っていない
  // 使用済みの招待**が残る。招待は希少な資源で、人手で戻すしかない。こちらの
  // 順序なら、残骸は「今この瞬間に作られたばかりで、まだ何も紐づいていない
  // `users` 行」だけであり、安全に消せる。
  const created = await createUser(db, identity, nowSeconds);
  if (created === null) {
    // 引き当てと作成の間に、同じ `google_sub` の登録が別のリクエストで進んでいる。
    //
    // **その行を引き当てて成功として返さない。** 先行するリクエストは、まだ招待を
    // 消費できるかどうかが決まっておらず、失敗すれば下の補償で自分が作った行を消す。
    // こちらが先にその行を掴んでセッションを発行すると、直後に消えた `users.id` を
    // 指すセッションが残る。招待も消費されないまま登録が済んだことになる。
    //
    // やり直しを促すほうを採る。**こちらの招待は消費していない**ので何も失われず、
    // 再試行の時点では先行の成否が確定している（成功なら既存として引き当たり、
    // 失敗なら行が無いので新規に作れる）。同時登録は同じ人がタブを 2 つ開いた場合に
    // 起きるもので、稀であり、やり直しで必ず解ける。
    console.error('[auth] 同じ google_sub の登録が競合したため、やり直しを求めました');
    return { ok: false, reason: 'retry' };
  }

  const consumed = await consumeInvite(db, inviteCode, created.id, nowSeconds);
  if (!consumed.ok) {
    await db.prepare('delete from users where id = ?').bind(created.id).run();
    console.error('[auth] 招待を消費できなかったため作成した利用者を取り消しました');
    return { ok: false, reason: consumed.reason };
  }

  return { ok: true, id: created.id, banned: false };
}

/**
 * 既存の `users` 行を引き当て、Google 側で変わりうる項目を更新する。
 *
 * 更新も同じ 1 文で行う。`SELECT` してから `UPDATE` する形にすると、同じ利用者の
 * 同時ログインで読み取りと書き込みが交錯する。同一性の判定は `google_sub` なので、
 * email と表示名を更新しても別人になることはない。
 *
 * @param db D1 バインディング
 * @param identity ID トークンから取り出した同一性
 * @returns 既存行、または存在しなければ null
 */
async function refreshExistingUser(
  db: D1Database,
  identity: GoogleIdentity,
): Promise<{ readonly id: string; readonly banned: boolean } | null> {
  const row = await db
    .prepare(
      `update users set email = ?, display_name = ?
       where google_sub = ?
       returning id, banned_at`,
    )
    .bind(identity.email, identity.displayName, identity.sub)
    .first<{ id: string; banned_at: number | null }>();

  return row === null ? null : { id: row.id, banned: row.banned_at !== null };
}

/**
 * `users` 行を作る。既に同じ `google_sub` があれば作らない。
 *
 * **`ON CONFLICT DO NOTHING` を付けて、競合を例外にしない。** 引き当てと作成の間に
 * 同じ利用者の別のログインが完了すると、素の `INSERT` は UNIQUE 制約違反で投げ、
 * コールバックが 500 になる。同時ログインは利用者の操作として普通に起こる（タブを
 * 2 つ開くなど）ので、障害として扱わない。衝突したかどうかは、`RETURNING` が行を
 * 返したかで分かる（`DO NOTHING` は衝突時に行を返さない）。
 *
 * `invited_by` は書かない。招待者の記録は #13 の `consumeInvite` が、招待を
 * 使用済みにできた場合にだけ行う（2 か所で書くと食い違う）。
 *
 * @param db D1 バインディング
 * @param identity ID トークンから取り出した同一性
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 作成した利用者の id。既に存在して作らなかった場合は null
 */
async function createUser(
  db: D1Database,
  identity: GoogleIdentity,
  nowSeconds: number,
): Promise<{ readonly id: string } | null> {
  const row = await db
    .prepare(
      `insert into users (id, google_sub, email, display_name, created_at)
       values (?, ?, ?, ?, ?)
       on conflict(google_sub) do nothing
       returning id`,
    )
    .bind(crypto.randomUUID(), identity.sub, identity.email, identity.displayName, nowSeconds)
    .first<{ id: string }>();

  return row === null ? null : { id: row.id };
}

/**
 * ID トークン（JWT）の中身を取り出して検証する。
 *
 * **署名は検証しない。** ID トークンは、こちらが TLS で直接叩いたトークン
 * エンドポイントの応答としてのみ受け取る（`TokenExchange` がその境界）。OIDC Core
 * 3.1.3.7 も、この経路で受け取ったトークンについては署名検証を省いてよいとしている。
 * 署名を検証しようとすると Google の JWKS を取りに行くことになり、鍵の更新と
 * ネットワーク障害を認証の経路へ持ち込む。**その代わり、トークンを別経路から
 * 受け取る実装をここへ足さないこと**（足すなら署名検証が必須になる）。
 *
 * @param idToken トークンエンドポイントが返した ID トークン
 * @param clientId 自分のクライアント ID（`aud` の照合に使う）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 同一性、または受け付けなかった理由
 */
export function parseGoogleIdToken(
  idToken: string,
  clientId: string,
  nowSeconds: number,
): IdTokenVerification {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') {
    return { ok: false, reason: 'malformed' };
  }
  const decoded = decodeBase64Url(parts[1]);
  if (decoded === null) {
    return { ok: false, reason: 'malformed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'bad-payload' };
  }
  const claims = parsed as Record<string, unknown>;

  const issuer = claims['iss'];
  if (typeof issuer !== 'string' || !GOOGLE_ISSUERS.includes(issuer)) {
    return { ok: false, reason: 'bad-issuer' };
  }
  // `aud` が自分のクライアント ID でないトークンは、別のアプリ向けに発行されたもの。
  // 受け入れると、そのアプリの利用者としてこちらへログインできてしまう。
  if (claims['aud'] !== clientId) {
    return { ok: false, reason: 'bad-audience' };
  }
  // 失効時刻ちょうどを失効として扱う（`isInviteExpired` / `verifySession` と揃える）。
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub === '') {
    return { ok: false, reason: 'no-subject' };
  }
  const email = claims['email'];
  if (typeof email !== 'string' || email === '') {
    return { ok: false, reason: 'no-email' };
  }
  // 未検証の email を受け入れない。同一性の判定は `google_sub` なので乗っ取りには
  // 直結しないが、`users.email` は #14 の招待や 5.5 の通知が宛先として使う。他人の
  // アドレスを名乗れる状態にしない。
  if (claims['email_verified'] !== true) {
    return { ok: false, reason: 'unverified-email' };
  }

  const name = claims['name'];
  // `display_name` は NOT NULL（5.1）。`name` は scope や設定によって欠けうるため、
  // 欠けたときの既定を決めておく（email のローカル部）。
  const displayName =
    typeof name === 'string' && name.trim() !== '' ? name : (email.split('@')[0] ?? email);

  return { ok: true, identity: { sub, email, displayName } };
}

/**
 * 一時 cookie の値を組み立てて署名する。
 *
 * 形式は `<state>.<code_verifier>.<失効時刻>.<base64url(HMAC)>`。JSON を base64url
 * する `src/session.ts` と形は違うが、**署名の考え方は同じ**（本文の文字列そのものへ
 * HMAC-SHA256 を掛け、照合は `crypto.subtle.verify` に委ねる）。ここで JSON を
 * 使わないのは、載せる 3 つの値がいずれも base64url 文字と数字だけで構成され、
 * 符号化を挟む理由が無いため。
 *
 * `src/session.ts` の `signSession` を使い回せないのは、あちらのペイロードが
 * `userId` / `issuedAt` / `expiresAt` に固定されているためで、`src/session.ts` は
 * T2 の所有物なので広げない。
 *
 * @param value 載せる値
 * @param secret 署名の秘密鍵（`SESSION_SECRET`）
 * @returns cookie に載せる文字列
 */
async function signOAuthState(value: OAuthState, secret: string): Promise<string> {
  const body = `${value.state}.${value.codeVerifier}.${value.expiresAt}.${
    value.inviteCode ?? NO_INVITE_MARK
  }`;
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${OAUTH_STATE_DOMAIN}:${body}`),
  );
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * 一時 cookie を検証して中身を取り出す。
 *
 * @param cookie cookie から取り出した値
 * @param secret 署名の秘密鍵
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 中身、または検証できない場合は null
 */
async function verifyOAuthState(
  cookie: string,
  secret: string,
  nowSeconds: number,
): Promise<OAuthState | null> {
  const parts = cookie.split('.');
  const [state, codeVerifier, expiresText, inviteText, signatureText] = parts;
  if (
    parts.length !== 5 ||
    state === undefined ||
    codeVerifier === undefined ||
    expiresText === undefined ||
    inviteText === undefined ||
    signatureText === undefined
  ) {
    return null;
  }
  // 形を先に確かめる。`state` と `code_verifier` はこちらが生成した base64url 文字列
  // なので、それ以外の文字が入っているものは検証するまでもなく偽物である。
  if (!isBase64Url(state) || !isBase64Url(codeVerifier) || !/^[0-9]{1,15}$/.test(expiresText)) {
    return null;
  }
  // 招待コードは正規形そのものであることを要求する。署名が通っていても形は信用しない
  // （この値は後段で `consumeInvite` へ渡り、DB を引く鍵になる）。
  const inviteCode = inviteText === NO_INVITE_MARK ? null : normalizeInviteCode(inviteText);
  if (inviteText !== NO_INVITE_MARK && inviteCode !== inviteText) {
    return null;
  }
  const signature = decodeBase64Url(signatureText);
  if (signature === null) {
    return null;
  }

  const body = `${state}.${codeVerifier}.${expiresText}.${inviteText}`;
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(`${OAUTH_STATE_DOMAIN}:${body}`),
  );
  if (!valid) {
    return null;
  }

  const expiresAt = Number(expiresText);
  if (expiresAt <= nowSeconds) {
    return null;
  }
  return { state, codeVerifier, expiresAt, inviteCode };
}

/**
 * PKCE の `code_challenge`（S256）を作る。
 *
 * @param codeVerifier 認可コードの交換時に提示する検証子
 * @returns base64url した SHA-256 ハッシュ
 */
async function createPkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * 推測困難な文字列を作る（`state` と `code_verifier` に使う）。
 *
 * `crypto.getRandomValues` を使う。`Math.random` は暗号用途の保証を持たず、
 * ここでの推測可能性は CSRF 対策と PKCE の両方を同時に無効化する。
 *
 * 32 バイト = base64url で 43 文字。PKCE の検証子に許される長さ（43〜128 文字）と
 * 文字集合（unreserved）を満たす。
 *
 * @returns base64url 文字列
 */
function generateRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/** HMAC の鍵を毎回 import し直さないための小さなキャッシュ。 */
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * 署名鍵を取り出す。
 *
 * 空・短すぎる秘密鍵を受け入れない条件は `src/session.ts` の `importKey` と同じ。
 * ここで緩めると、セッションは守られているのに一時 cookie だけ誰でも作れる、
 * という非対称な穴が空く。
 *
 * @param secret 署名の秘密鍵（`SESSION_SECRET`）
 * @returns HMAC-SHA256 の CryptoKey
 * @throws 秘密鍵が空、または短すぎる場合
 */
async function importKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('SESSION_SECRET が未設定です。一時 cookie に署名できません。');
  }
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET が短すぎます（32 文字以上が必要です）。');
  }

  const cached = keyCache.get(secret);
  if (cached !== undefined) {
    return await cached;
  }
  const pending = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, pending);
  return await pending;
}

/**
 * 設定されていない秘密の名前を返す。
 *
 * `Env` の型は `string` だが、`.dev.vars` を置いていない環境では実行時に
 * `undefined` が入る。型を信用して素通しすると、鍵が無いまま署名処理へ進み、
 * 例外の出方によっては「認証が素通り」に見える経路ができる。**値は決して返さない。**
 *
 * @param env バインディングと環境変数
 * @returns 未設定の秘密の名前（すべて揃っていれば空配列）
 */
function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((name) => {
    const value: unknown = env[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * 秘密が揃っていないときのレスポンス。
 *
 * 認証を通さずに落とす。ここで「設定が無いので素通しする」形にすると、本番の
 * 設定漏れがそのまま無認証の穴になる。
 *
 * @param missing 未設定の秘密の名前
 * @returns 503 レスポンス
 */
function notConfigured(missing: readonly string[]): Response {
  console.error('[auth] 認証に必要な設定がありません', missing.join(', '));
  return json({ error: 'auth not configured' }, 503);
}

/**
 * Google へ渡すリダイレクト URI を組み立てる。
 *
 * 認可要求と交換要求で**同じ値**でなければならない（Google が一致を検査する）ため、
 * 1 か所で組み立てる。
 *
 * ホストは `env.APP_HOST` ではなくリクエストから取る。`APP_HOST` にはポートが
 * 含まれず、ローカル開発は `https://game-forge.localtest.me:8787` で動くため、
 * 定数から組むとポートが落ちて開発時のログインだけが通らなくなる。
 * `Host` ヘッダ由来の値を使うことになるが、`src/index.ts` が未知のホストを
 * 404 で落としているため、ここへ届く時点でホスト名は `APP_HOST` に限られる。
 *
 * スキームは `https` に固定する。`__Host-` cookie が `Secure` を要求する以上、
 * http で認証を成立させる理由がない。
 *
 * @param request 受信したリクエスト
 * @returns リダイレクト URI
 */
function redirectUri(request: Request): string {
  return `https://${new URL(request.url).host}${CALLBACK_PATH}`;
}

/**
 * 一時 cookie の `Set-Cookie` 値を組み立てる。
 *
 * 属性はセッション cookie（`buildSessionCookie`）と揃える。`__Host-` の受理条件
 * （`Secure` / `Path=/` / `Domain` 属性なし）を 1 つでも欠くとブラウザは黙って捨て、
 * 「なぜか state が無い」という形でだけ表面化する。
 *
 * @param value 署名済みの値
 * @returns `Set-Cookie` ヘッダの値
 */
function buildOAuthCookie(value: string): string {
  return [
    `${OAUTH_COOKIE}=${value}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${OAUTH_COOKIE_MAX_AGE}`,
  ].join('; ');
}

/**
 * 一時 cookie を消す `Set-Cookie` 値を組み立てる。
 *
 * 属性は発行時と一致させる（`Path` が違うとブラウザは別の cookie とみなし、
 * 古いものが残る）。
 *
 * @returns `Set-Cookie` ヘッダの値
 */
function clearOAuthCookie(): string {
  return [`${OAUTH_COOKIE}=`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'].join(
    '; ',
  );
}

/**
 * `Cookie` ヘッダから指定した cookie の値を取り出す。
 *
 * `src/session.ts` の `readSessionCookie` は対象をセッション cookie 1 つに限定して
 * いるため、一時 cookie には使えない。値を返す経路を増やす以上、こちらも対象を
 * 引数で受け取った 1 つに限る。
 *
 * @param header `Cookie` ヘッダの値（未設定なら null）
 * @param name 取り出す cookie の名前
 * @returns 値、または null
 */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) {
    return null;
  }
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (trimmed.slice(0, separator) === name) {
      const value = trimmed.slice(separator + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * リダイレクトのレスポンスを組み立てる。
 *
 * 303 を使う。ログイン後の遷移先は GET で取得すべきもので、302 だとメソッドの
 * 扱いがクライアント任せになる。`cache-control: no-store` は `routes.ts` の
 * `json` と揃える（セッションを載せた応答を共有キャッシュへ載せない）。
 *
 * @param location 遷移先
 * @param cookies 付与する `Set-Cookie` の値
 * @returns 303 レスポンス
 */
function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

/**
 * 既存のレスポンスへ `Set-Cookie` を足す。
 *
 * `routes.ts` の `json` は `Record<string, string>` しか受け取れず、`set-cookie` を
 * 2 本載せられない（セッションの発行と一時 cookie の破棄は同時に起きる）。
 * `json` 側を変えると全経路の署名が変わるため、こちらで足す。
 *
 * @param response 元のレスポンス
 * @param cookies 付与する `Set-Cookie` の値
 * @returns 同じレスポンス
 */
function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

/**
 * base64url（パディングなし）かどうかを判定する。
 *
 * @param text 判定する文字列
 * @returns base64url なら true
 */
function isBase64Url(text: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(text);
}

/**
 * バイト列を base64url（パディングなし）へ変換する。
 *
 * @param bytes 変換するバイト列
 * @returns base64url 文字列
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
 * パディングを復元しないのは `atob` が WHATWG の forgiving-base64 decode に従い、
 * 長さを 4 で割った余りが 1 のときだけ失敗するため（`src/session.ts` と同じ理由）。
 * ID トークンのペイロードもここを通る。
 *
 * @param text base64url 文字列
 * @returns バイト列、または解けない場合は null
 */
function decodeBase64Url(text: string): Uint8Array | null {
  if (text === '' || !isBase64Url(text)) {
    return null;
  }
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
