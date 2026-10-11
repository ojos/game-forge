/**
 * 試用モード（`/trial`。#977）——運営が印を付けた試用者が、説明と同意 → 録画の準備 → 自由に触る →
 * 声で振り返り → 短いアンケートを、サイトの中で終える画面と口。
 *
 * ## 誰に見せるか
 *
 * **印のある、ログイン中の利用者だけ**（`trial_participants` に行がある。`src/trial-store.ts`）。画面（GET）は、
 * 未ログイン・印の無い利用者・BAN や退会の行に**同じ 404 の画面**を返す（どれなのかを区別させない）。ログインへ
 * 送らない——送ると、印の無い人にも「ログインすれば何かある」ことが読める。
 *
 * **口（POST）だけは、セッションが無ければログインへ送る**（ほかの書き込みの口と同じ。退会・BAN した cookie を
 * 受け付けないことを `test/withdrawal-routes.test.ts` が経路表から回して見る）。ログイン中で印が無ければ 404 である。
 *
 * **スマホでは「PC で開いてください」を出す**（ブラウザでの画面の取り込みがスマホのブラウザに無い）。判定は
 * User-Agent だけで、iPad の「デスクトップ用サイト」のように PC を名乗る端末は通る（{@link isMobileUserAgent}）。
 * 404 の判定を先に置くので、印の無い人には PC かどうかに関わらず 404 である。
 *
 * ## 段はサーバーが持つ
 *
 * 画面（GET）は**いまの段の画面を出すだけで、何も書かない**。段を進める口（`POST /api/trial/step`）は「どの段の
 * 画面から押したか」だけを受け取り、**進む先はその次の段に限る**（条件付き UPDATE。`advanceTrialStage`）。
 * 古い画面から押されたら何も書かずに `/trial` へ戻し、いまの段の画面を出し直す。
 *
 * **同意の前には何も書かない。** 同意しない人は画面を閉じるだけで、口を呼ばない。
 *
 * ## 録画（#978）の継ぎ目
 *
 * 録画そのもの（画面と声の取り込み・受け口）は #978 が足す。いまは {@link renderRecordingStage} が「録画の段を
 * 飛ばす」旨を出し、{@link recordingStopNotice} が空を返す。#978 はこの 2 つを差し替える（段と列は変えない）。
 *
 * ## CSRF と JavaScript
 *
 * 素の `<form method="post">` で送る（`src/account.ts` と同じ。JavaScript を要求しない）。CSRF はセッション cookie の
 * `SameSite=Lax` が受ける。
 */
import { LOGIN_PATH } from './auth/google.js';
import { siteFooter } from './legal.js';
import type { SiteViewer } from './html.js';
import { READING_CLASS, escapeHtml, headerAvatarUrl, resolveSiteViewer, siteHead, siteViewerAt } from './html.js';
import { HOME_PATH } from './paths.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './service-contact.js';
import { resolveSessionUser } from './session-user.js';
import {
  TRIAL_CONSENT_AGREE,
  TRIAL_CONSENT_FIELD,
  TRIAL_FROM_FIELD,
  TRIAL_PATH,
  TRIAL_STEP_API_PATH,
  TRIAL_SURVEY_AI_FIELD,
  TRIAL_SURVEY_API_PATH,
  TRIAL_SURVEY_BROWSER_FIELD,
  TRIAL_SURVEY_MISSED_FIELD,
} from './trial-paths.js';
import type { TrialParticipantRow, TrialQuestionStage, TrialStage } from './trial-store.js';
import {
  TRIAL_QUESTION_STAGES,
  TRIAL_SURVEY_LIMITS,
  advanceTrialStage,
  completeTrialSurvey,
  findTrialParticipant,
  isTrialStage,
  validateTrialSurvey,
} from './trial-store.js';
import { TRIAL_CONSENT_HTML, TRIAL_CONSENT_VERSION, TRIAL_INTRO_HTML, TRIAL_QUESTIONS } from './trial-text.js';

/** 受け付けるフォームの形式。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * 本文の上限（バイト）。アンケートの 3 項目の上限（合わせて 3,100 文字）が、URL エンコードで最大 1 文字 12 バイト
 * （4 バイトの文字の `%XX` × 4）になっても収まる大きさ。
 */
const MAX_BODY_BYTES = 40_000;

/** 画面の `<title>`。 */
const TRIAL_TITLE = 'Game Forge の試用 - Game Forge';

/**
 * User-Agent がスマホ・タブレットのブラウザを名乗っているか。
 *
 * **Android はタブレットも含めて断る**（Android の Chrome にも画面の取り込みが無い）。iPad の
 * 「デスクトップ用サイト」は Mac を名乗るので通る——そこで録画が始められないことは #978 の画面が受ける。
 *
 * @param userAgent `User-Agent` ヘッダの値
 * @returns スマホ・タブレットなら true
 */
export function isMobileUserAgent(userAgent: string | null): boolean {
  if (userAgent === null) {
    return false;
  }
  return /\b(?:iPhone|iPod|iPad|Android|Mobile)\b/iu.test(userAgent);
}

/**
 * 404 の画面（未ログイン・印の無い利用者。**理由を区別しない**）。
 *
 * @param viewer いま見ている人の状態
 * @returns レスポンス
 */
function notFound(viewer: SiteViewer): Response {
  return html(
    `${siteHead({ title: 'ページが見つかりません - Game Forge', noindex: true, viewer })}
<h1>ページが見つかりません</h1>
<p>URL が正しいかご確認ください。</p>
<p><a href="${HOME_PATH}">トップへ戻る</a></p>
${siteFooter()}`,
    404,
  );
}

/**
 * 試用の画面の外枠（読み物の器）。
 *
 * @param viewer いま見ている人の状態
 * @param body 本文
 * @returns HTML
 */
function trialPage(viewer: SiteViewer, body: string): string {
  return `${siteHead({ title: TRIAL_TITLE, noindex: true, viewer, reading: true })}
<div class="${READING_CLASS}">
<h1>Game Forge の試用</h1>
${body}
</div>
${siteFooter()}`;
}

/**
 * 段を 1 つ進めるボタン（フォーム）。
 *
 * @param from いまの段
 * @param label ボタンの札
 * @param extra フォームへ足す項目（既にエスケープ済みの HTML）
 * @returns HTML
 */
function stepForm(from: TrialStage, label: string, extra = ''): string {
  return `<form method="post" action="${TRIAL_STEP_API_PATH}">
  <input type="hidden" name="${TRIAL_FROM_FIELD}" value="${from}">${extra}
  <button type="submit" class="gf-button gf-button-primary">${label}</button>
</form>`;
}

/**
 * 段 1: 説明と同意。
 *
 * **「同意しない」の口を置かない**——押した事実も記録しないので、閉じるだけでよい。
 *
 * @returns 本文
 */
function renderConsentStage(): string {
  return `<section class="gf-block gf-block-rows" aria-label="説明">
<div>
${TRIAL_INTRO_HTML}
</div>
</section>
<section class="gf-block gf-block-rows" aria-label="録画と記録の扱い">
<div>
<h2>録画と記録の扱いについて</h2>
${TRIAL_CONSENT_HTML}
</div>
</section>
<p>同意していただける場合は、下のボタンを押してください。<strong>同意しない場合は、このページを閉じてください。何も記録しません。</strong></p>
${stepForm('consent', '同意して始める', `\n  <input type="hidden" name="${TRIAL_CONSENT_FIELD}" value="${TRIAL_CONSENT_AGREE}">`)}`;
}

/**
 * 段 2: 録画の準備（**#978 が差し替える継ぎ目**）。
 *
 * いまは録画の機能が無いので、録画の段を飛ばす旨だけを出す。
 *
 * @returns 本文
 */
export function renderRecordingStage(): string {
  return `<section class="gf-block gf-block-rows" aria-label="録画の準備">
<div>
<h2>録画の準備</h2>
<p>録画の機能はまだ準備中です。<strong>今回は録画をせずに進みます。</strong></p>
</div>
</section>
${stepForm('recording', '次へ')}`;
}

/**
 * 段 3: Game Forge を新しいタブで開いて、自由に触る。
 *
 * @returns 本文
 */
function renderExploreStage(): string {
  return `<section class="gf-block gf-block-rows" aria-label="自由に触る">
<div>
<h2>自由に触ってください</h2>
<p>下のボタンで Game Forge を新しいタブで開き、自由に触ってください。20〜30 分くらいが目安です。思ったことは声に出してください。</p>
<p>触り終えたら、このタブに戻って「触り終えた」を押してください。</p>
<p><a class="gf-button gf-button-secondary" href="${HOME_PATH}" target="_blank" rel="noopener">Game Forge を新しいタブで開く</a></p>
</div>
</section>
${stepForm('explore', '触り終えた')}`;
}

/**
 * 段 4: 振り返りの問いを 1 つ出す。
 *
 * @param stage 問いの段
 * @returns 本文
 */
function renderQuestionStage(stage: TrialQuestionStage): string {
  const index = TRIAL_QUESTION_STAGES.indexOf(stage);
  const last = index === TRIAL_QUESTION_STAGES.length - 1;
  return `<section class="gf-block gf-block-rows" aria-label="振り返り">
<div>
<h2>振り返り（${index + 1} / ${TRIAL_QUESTION_STAGES.length}）</h2>
<p>次の質問に、<strong>声で</strong>答えてください。答え終えたら「${last ? '答え終えた' : '次の質問へ'}」を押してください。</p>
<p><strong>${TRIAL_QUESTIONS[index]!}</strong></p>
</div>
</section>
${stepForm(stage, last ? '答え終えた' : '次の質問へ')}`;
}

/**
 * 録画を止める案内（**#978 が差し替える継ぎ目**。いまは録画が無いので空）。
 *
 * @returns HTML
 */
export function recordingStopNotice(): string {
  return '';
}

/** アンケートの画面へ戻す値と、断りの文。 */
interface SurveyFormState {
  readonly browser: string;
  readonly aiExperience: string;
  readonly missed: string;
  readonly error: string | null;
}

/** 空のアンケート。 */
const EMPTY_SURVEY: SurveyFormState = { browser: '', aiExperience: '', missed: '', error: null };

/**
 * 段 5: 録画を止めて、短いアンケート。
 *
 * @param state 入力済みの値と断りの文（初めて開いたときは空）
 * @returns 本文
 */
function renderSurveyStage(state: SurveyFormState): string {
  const error =
    state.error === null ? '' : `<p class="gf-block" role="alert">${escapeHtml(state.error)}</p>\n`;
  return `${recordingStopNotice()}<section class="gf-block gf-block-rows" aria-label="アンケート">
<div>
<h2>最後に、短いアンケート</h2>
<p>文字で答えてください。</p>
</div>
</section>
${error}<form method="post" action="${TRIAL_SURVEY_API_PATH}">
  <label for="trial-browser">使ったブラウザ（例: Chrome、Safari、Edge）</label>
  <input id="trial-browser" name="${TRIAL_SURVEY_BROWSER_FIELD}" type="text" required maxlength="${TRIAL_SURVEY_LIMITS.browser}" value="${escapeHtml(state.browser)}">
  <label for="trial-ai">AI でゲームや何かを作った経験（例: ChatGPT で何度か作った・作ったことはない）</label>
  <textarea id="trial-ai" name="${TRIAL_SURVEY_AI_FIELD}" required maxlength="${TRIAL_SURVEY_LIMITS.aiExperience}">${escapeHtml(state.aiExperience)}</textarea>
  <label for="trial-missed">声で言い損ねたこと（任意）</label>
  <textarea id="trial-missed" name="${TRIAL_SURVEY_MISSED_FIELD}" maxlength="${TRIAL_SURVEY_LIMITS.missed}">${escapeHtml(state.missed)}</textarea>
  <button type="submit" class="gf-button gf-button-primary">送る</button>
</form>`;
}

/**
 * 終わりの画面。
 *
 * @returns 本文
 */
function renderDoneStage(): string {
  return `<section class="gf-block gf-block-rows" aria-label="試用の終わり">
<div>
<h2>ありがとうございました</h2>
<p>試用はこれで終わりです。ご協力ありがとうございました。</p>
<p>記録の削除を頼みたいときは、<a href="${CONTACT_MAILTO}">${CONTACT_EMAIL}</a> までご連絡ください。</p>
<p><a href="${HOME_PATH}">トップへ戻る</a></p>
</div>
</section>`;
}

/**
 * いまの段の本文を組み立てる。
 *
 * @param stage いまの段
 * @param survey アンケートの段で戻す値
 * @returns 本文
 */
export function renderTrialStage(stage: TrialStage, survey: SurveyFormState = EMPTY_SURVEY): string {
  switch (stage) {
    case 'consent':
      return renderConsentStage();
    case 'recording':
      return renderRecordingStage();
    case 'explore':
      return renderExploreStage();
    case 'q1':
    case 'q2':
    case 'q3':
    case 'q4':
    case 'q5':
      return renderQuestionStage(stage);
    case 'survey':
      return renderSurveyStage(survey);
    case 'done':
      return renderDoneStage();
  }
}

/**
 * スマホで開いたときの本文。
 *
 * @returns 本文
 */
function renderMobileNotice(): string {
  return `<section class="gf-block gf-block-rows" aria-label="PC で開いてください">
<div>
<h2>PC で開いてください</h2>
<p>この試用は PC のブラウザでだけ行えます。お手数ですが、PC で同じページ（${escapeHtml(TRIAL_PATH)}）を開いてください。</p>
</div>
</section>`;
}

/**
 * ログインへ送る 303。
 *
 * @returns レスポンス
 */
function seeOtherToLogin(): Response {
  return new Response(null, { status: 303, headers: { location: LOGIN_PATH, 'cache-control': 'no-store' } });
}

/** 試用者を解決した結果。 */
type TrialAccess =
  | { readonly ok: true; readonly userId: string; readonly row: TrialParticipantRow; readonly viewer: SiteViewer }
  | { readonly ok: false; readonly response: Response };

/**
 * 要求から試用者を解決する（未ログイン・印が無ければ 404。スマホなら「PC で開いてください」）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 試用者、またはそのまま返す応答
 */
async function resolveTrialAccess(request: Request, env: Env): Promise<TrialAccess> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // **口（POST）はログインへ送る**——ほかの書き込みの口と同じ扱いで、退会・BAN した cookie を受け付けないことを
    // `test/withdrawal-routes.test.ts` が経路表から回して見る。**画面（GET）は 404**（ログインすれば何かあることを
    // 読ませない）。口の綴りは経路表から誰でも読めるので、口がログインを求めても漏れるものは増えない。
    if (request.method === 'POST') {
      return { ok: false, response: seeOtherToLogin() };
    }
    return { ok: false, response: notFound(await resolveSiteViewer(request, env)) };
  }
  const viewer = siteViewerAt(TRIAL_PATH, true, headerAvatarUrl(request, env, session.userId));
  const row = await findTrialParticipant(env.DB, session.userId);
  if (row === null) {
    return { ok: false, response: notFound(viewer) };
  }
  if (isMobileUserAgent(request.headers.get('user-agent'))) {
    return { ok: false, response: html(trialPage(viewer, renderMobileNotice())) };
  }
  return { ok: true, userId: session.userId, row, viewer };
}

/**
 * 試用の画面（`GET /trial`）。**何も書かない。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showTrial(request: Request, env: Env): Promise<Response> {
  const access = await resolveTrialAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  return html(trialPage(access.viewer, renderTrialStage(access.row.stage)));
}

/**
 * `/trial` へ戻す 303。
 *
 * @returns レスポンス
 */
function backToTrial(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: TRIAL_PATH, 'cache-control': 'no-store' },
  });
}

/** フォームの読み取り結果。 */
type TrialFormRead =
  | { readonly ok: true; readonly fields: URLSearchParams }
  | { readonly ok: false; readonly reason: 'invalid-request' | 'body-too-large' };

/**
 * フォームの本文を読む。
 *
 * @param request 受信したリクエスト
 * @returns 項目、または理由
 */
async function readTrialForm(request: Request): Promise<TrialFormRead> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return { ok: false, reason: 'invalid-request' };
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return { ok: false, reason: read.reason === 'body-too-large' ? 'body-too-large' : 'invalid-request' };
  }
  return { ok: true, fields: new URLSearchParams(read.text) };
}

/**
 * 段を 1 つ進める（`POST /api/trial/step`）。
 *
 * **古い画面から押されたら、何も書かずに `/trial` へ戻す**（いまの段の画面が出る）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleStep(request: Request, env: Env, now: () => number): Promise<Response> {
  const access = await resolveTrialAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  const form = await readTrialForm(request);
  if (!form.ok) {
    return backToTrial();
  }
  const from = form.fields.get(TRIAL_FROM_FIELD) ?? '';
  if (!isTrialStage(from) || from !== access.row.stage) {
    return backToTrial();
  }
  if (from === 'consent' && form.fields.get(TRIAL_CONSENT_FIELD) !== TRIAL_CONSENT_AGREE) {
    return backToTrial();
  }
  try {
    await advanceTrialStage(env.DB, access.userId, from, now(), {
      consentVersion: from === 'consent' ? TRIAL_CONSENT_VERSION : undefined,
    });
  } catch (error) {
    // **利用者の値はログに出さない。** 打ち直せば同じ段から進む。
    console.error(`[trial] 段を進められませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return html(
      trialPage(access.viewer, '<p class="gf-block" role="alert">記録できませんでした。少し待ってから、もう一度押してください。</p>'),
      500,
    );
  }
  return backToTrial();
}

/** アンケートの断りの文。 */
const SURVEY_ERRORS = {
  'too-long': `長すぎる答えがあります。ブラウザは ${TRIAL_SURVEY_LIMITS.browser} 文字、AI の経験は ${TRIAL_SURVEY_LIMITS.aiExperience} 文字、言い損ねたことは ${TRIAL_SURVEY_LIMITS.missed} 文字までです。`,
  empty: 'ブラウザと AI の経験は、どちらも答えてください。',
} as const;

/**
 * アンケートを送る（`POST /api/trial/survey`）。**アンケートの段でだけ受け付ける。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleSurvey(request: Request, env: Env, now: () => number): Promise<Response> {
  const access = await resolveTrialAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  if (access.row.stage !== 'survey') {
    return backToTrial();
  }
  const form = await readTrialForm(request);
  if (!form.ok) {
    if (form.reason === 'body-too-large') {
      return html(
        trialPage(access.viewer, renderSurveyStage({ ...EMPTY_SURVEY, error: SURVEY_ERRORS['too-long'] })),
        400,
      );
    }
    return backToTrial();
  }
  const raw = {
    browser: form.fields.get(TRIAL_SURVEY_BROWSER_FIELD) ?? '',
    aiExperience: form.fields.get(TRIAL_SURVEY_AI_FIELD) ?? '',
    missed: form.fields.get(TRIAL_SURVEY_MISSED_FIELD) ?? '',
  };
  const validated = validateTrialSurvey(raw);
  if (!validated.ok) {
    return html(
      trialPage(access.viewer, renderSurveyStage({ ...raw, error: SURVEY_ERRORS[validated.reason] })),
      400,
    );
  }
  try {
    await completeTrialSurvey(env.DB, access.userId, validated.answers, now());
  } catch (error) {
    console.error(`[trial] アンケートを記録できませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return html(
      trialPage(
        access.viewer,
        renderSurveyStage({ ...raw, error: '記録できませんでした。少し待ってから、もう一度送ってください。' }),
      ),
      500,
    );
  }
  return backToTrial();
}

/**
 * 試用の経路を組み立てる（時刻を差し替えられるのはここだけ）。
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createTrialRoutes(options: { readonly now?: () => number } = {}): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return [
    { method: 'GET', path: TRIAL_PATH, handler: showTrial },
    { method: 'POST', path: TRIAL_STEP_API_PATH, handler: (request, env) => handleStep(request, env, now) },
    { method: 'POST', path: TRIAL_SURVEY_API_PATH, handler: (request, env) => handleSurvey(request, env, now) },
  ];
}

/** アプリの経路表へ連結する試用の経路（#977）。 */
export const trialRoutes: readonly Route[] = createTrialRoutes();
