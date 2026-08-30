/**
 * 推敲の操作（`POST /api/revise` と `POST /api/revise/restore`）。
 * **5.7 の「自作の未公開作品をプロンプトで手直ししてから公開できる」の実体である**
 * （#192 / M4.5-2 / 確定28）。
 *
 * ## この経路が無かったあいだ何が起きていたか
 *
 * 5.4 は作者を唯一のフィルタに据えたのに、渡してあったのは「公開する / しない」の
 * 2 値だけだった。**落とすしかないフィルタは、運が悪ければ何も通さない。**
 * フォーク（5.3）でも代用できない——あれは**公開済みの作品**を親に取るので、
 * 自作を直すために先に公開することになり、5.4 が防ごうとした順序そのものになる。
 *
 * ## 4 つのことを同時に守る
 *
 * | 守るもの | どこで守るか |
 * |---|---|
 * | 作者本人・`draft`・完成済みだけ | `claimRevisionSlot` の SQL 条件（`src/revisions.ts`） |
 * | 1 作品あたりの上限（5.7） | 同 `revise_count < ?` |
 * | 同時に走る推敲は 1 本 | `game_revision_jobs.game_id` が主キー |
 * | 日次クォータ（確定25） | {@link handleRevise} が `checkGenerationQuota` を**先に**呼ぶ |
 *
 * **枠の判定を 2 つとも通さなければ走らない。** 日次は「1 人・1 日」、推敲上限は
 * 「1 作品・生涯」で軸が違い、**どちらか一方では止められない**（`src/quota.ts`）。
 *
 * ## 順序: 日次 → 推敲の枠 → ソースの取得 → 起動
 *
 * **日次を先に見る。** 3.3-2 が「上限の判定は生成より先」と定めているのと同じで、
 * 断られる要求のために R2 を引かない。**推敲の枠を取ってから R2 を引く**のは、
 * 枠の取得が「他人の作品ではない」ことまで確かめるからである——**確かめる前に
 * `source_key` を読むと、他人の作品のキーを引く経路ができる。**
 *
 * ## 失敗したら枠を返さない
 *
 * ソースが取れない・起動に失敗した場合、`revise_count` は増えたままにする。
 * **戻すと、失敗を繰り返すことで上限を無限に迂回できる。** 代わりにジョブ行を
 * `failed` にして、作者には理由を出す（`src/revisions.ts` の `failRevision`）。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1）で、他サイトからの POST には
 * そもそも cookie が乗らない。`src/publish.ts` と同じ理由でトークンを足していない。
 */
import { LOGIN_PATH } from './auth/google.js';
import type { GenerationJob, GenerationPipeline } from './generate.js';
import { defaultPipeline, MAX_PROMPT_LENGTH } from './generate.js';
import { createJobToken, hashJobToken } from './games.js';
import {
  REVISE_GAME_ID_FIELD,
  REVISE_PATH,
  REVISE_PROMPT_FIELD,
  REVISE_SEQ_FIELD,
  RESTORE_PATH,
} from './paths.js';
import { checkGenerationQuota, describeQuotaRejection, QUOTA_EXCEEDED_STATUS } from './quota.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { claimRevisionSlot, failRevision, restoreRevision } from './revisions.js';
import { resolveSessionUser } from './session-user.js';
import { MAX_SOURCE_BYTES } from './system-prompt.js';
import { workPagePath } from './work-page.js';

/**
 * 受け付ける本文の最大バイト数。
 *
 * プロンプト（2,000 文字＝ UTF-8 最大 8 KB）と UUID 1 つが載る。
 * `src/publish.ts` の 1 KiB では足りず、`src/generate-callback.ts` の 16 KiB は
 * 生成物が載るための値である。**載るものに合わせる。**
 */
const MAX_BODY_BYTES = 12 * 1024;

/** `games.id` の綴り（`crypto.randomUUID()` が返す形。`src/publish.ts` と同じ）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * 303 See Other を返す（`src/publish.ts` と同じ形）。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 要求がブラウザのナビゲーションかを判定する（`src/publish.ts` と同じ判定）。
 *
 * @param request 受信したリクエスト
 * @returns HTML を返すべきなら true
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * 断りの画面を返す。
 *
 * **作品ページへ 303 で戻さない。** 戻すと、断られたことが URL にもステータスにも
 * 残らず、利用者は「押したのに何も起きなかった」としか読めない（`src/publish.ts`）。
 *
 * @param heading 見出し
 * @param body 本文
 * @param status ステータスコード
 * @returns レスポンス
 */
function refusal(heading: string, body: string, status: number): Response {
  return html(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} - Game Forge</title>
<h1>${heading}</h1>
<p>${body}</p>
<p><a href="/">トップへ</a></p>`,
    status,
  );
}

/** 推敲を断る理由ごとの、ステータスと文言。 */
const REFUSALS: Readonly<
  Record<'not-revisable' | 'source-missing' | 'start-failed', { status: number; heading: string; body: string }>
> = {
  // **他人の作品・存在しない作品・公開済み・生成中・上限超過・推敲中を区別しない。**
  // 区別すると、任意の id が存在するかを外から確かめられる手がかりになる
  // （`src/generate-callback.ts` と同じ考え方）。**作者から見た区別は画面が出す**
  // ——作品ページは残り回数も走っているジョブも表示できる（M4.5-3）。
  'not-revisable': {
    status: 409,
    heading: 'いま推敲できません',
    body: '公開前の自分の作品を、上限の回数まで手直しできます。前の手直しが終わるまでお待ちください。',
  },
  'source-missing': {
    status: 500,
    heading: '元のソースを読み出せませんでした',
    body: '時間をおいて、もう一度お試しください。',
  },
  'start-failed': {
    status: 500,
    heading: '手直しを始められませんでした',
    body: '時間をおいて、もう一度お試しください。',
  },
};

/** 本文から読み取った推敲の要求。 */
interface ReviseInput {
  readonly gameId: string;
  readonly prompt: string;
}

/**
 * 本文を読む。**フォームと JSON の両方を受ける**（`src/publish.ts` と同じ）。
 *
 * @param request 受信したリクエスト
 * @returns 読み取れた要求、または null
 */
async function parseReviseInput(request: Request): Promise<ReviseInput | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return null;
  }
  const body = read.text;

  let gameId: string | null = null;
  let prompt: string | null = null;
  if (contentType.includes(FORM_MEDIA_TYPE)) {
    const form = new URLSearchParams(body);
    gameId = form.get(REVISE_GAME_ID_FIELD);
    prompt = form.get(REVISE_PROMPT_FIELD);
  } else if (contentType.includes(JSON_MEDIA_TYPE)) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      gameId = typeof record[REVISE_GAME_ID_FIELD] === 'string' ? (record[REVISE_GAME_ID_FIELD] as string) : null;
      prompt = typeof record[REVISE_PROMPT_FIELD] === 'string' ? (record[REVISE_PROMPT_FIELD] as string) : null;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (gameId === null || !GAME_ID_PATTERN.test(gameId)) {
    return null;
  }
  // **`prompt` の上限は新規生成と同じ**（`MAX_PROMPT_LENGTH`）。差分プロンプトだから
  // といって別の値を置くと、同じ性質の入力に 2 つの上限ができる。
  const trimmed = (prompt ?? '').trim();
  if (trimmed === '' || [...trimmed].length > MAX_PROMPT_LENGTH) {
    return null;
  }
  return { gameId, prompt: trimmed };
}

/**
 * 元にするソースを R2 から読む（5.7 / 確定26）。
 *
 * **30KB を超えていたら断る**（確定18 / 5.3）。超過時に LLM へ整理させる経路は
 * M5-2（#33）が持つ。**ここで黙って切り詰めない**——切れた Go のソースを渡すと、
 * コンパイルが必ず落ちて枠だけが消える。
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のキー
 * @returns ソース、読めなければ null
 */
async function readBaseSource(env: Env, sourceKey: string): Promise<string | null> {
  const object = await env.BUCKET.get(sourceKey);
  if (object === null) {
    return null;
  }
  const source = await object.text();
  if (source === '' || new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return null;
  }
  return source;
}

/**
 * 推敲の要求を処理する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param pipeline 差し替え可能な各段（起動だけを使う）
 * @returns レスポンス
 */
async function handleRevise(
  request: Request,
  env: Env,
  pipeline: GenerationPipeline,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return wantsHtml(request) ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const input = await parseReviseInput(request);
  if (input === null) {
    return wantsHtml(request)
      ? refusal('入力を読み取れませんでした', 'どう直したいかを入力してから送信してください。', 400)
      : json({ error: 'invalid request' }, 400);
  }

  // 3.3-2 と同じ順序。**断られる要求のために R2 を引かない。**
  const quota = await checkGenerationQuota(env, session.userId);
  if (!quota.allowed) {
    const body = describeQuotaRejection(
      quota.reason,
      'resetsAt' in quota ? quota.resetsAt : undefined,
    );
    return wantsHtml(request)
      ? refusal('生成枠を使い切りました', '枠が戻ってから、もう一度お試しください。', QUOTA_EXCEEDED_STATUS)
      : json(body, QUOTA_EXCEEDED_STATUS);
  }

  // **ここが 5.7 の対象条件と上限を同時に確かめる唯一の関門である**（`src/revisions.ts`）。
  const jobToken = createJobToken();
  const claimed = await claimRevisionSlot(
    env,
    input.gameId,
    session.userId,
    input.prompt,
    await hashJobToken(jobToken),
  );
  if (!claimed) {
    const refused = REFUSALS['not-revisable'];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: 'not revisable' }, refused.status);
  }

  // 枠を取れた＝作者本人の `draft` である。**ここで初めて `source_key` を読む。**
  const row = await env.DB.prepare('select source_key from games where id = ?')
    .bind(input.gameId)
    .first<{ source_key: string | null }>();
  const baseSource =
    row?.source_key == null ? null : await readBaseSource(env, row.source_key);
  if (baseSource === null) {
    // **枠は返さない**（モジュール冒頭）。失敗はジョブ行に残し、作者へ理由を出す。
    await failRevision(env, input.gameId, 'internal');
    const refused = REFUSALS['source-missing'];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: 'source unavailable' }, refused.status);
  }

  const job: GenerationJob = {
    gameId: input.gameId,
    jobToken,
    userId: session.userId,
    request: { prompt: input.prompt, baseSource },
  };

  try {
    await pipeline.startJob(env, job, pipeline);
  } catch (error) {
    console.error(`[revise] ジョブを起動できませんでした: ${error instanceof Error ? error.name : typeof error}`);
    await failRevision(env, input.gameId, 'internal');
    const refused = REFUSALS['start-failed'];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: 'start failed' }, refused.status);
  }

  // **作品ページへ戻す。** 5.7 の「押したら作り直しが始まり、完成したら差し替わる」
  // の着地点はそこで、待つのは利用者ではない（3.3 の非同期経路。#150）。
  return wantsHtml(request)
    ? seeOther(workPagePath(input.gameId))
    : json({ gameId: input.gameId, url: workPagePath(input.gameId) }, 202);
}

/**
 * 「この版に戻す」を処理する（5.7）。
 *
 * **LLM を呼ばない。** 費用台帳の行を作らず、日次クォータも推敲の回数も動かさない
 * ので、`checkGenerationQuota` をここでは呼ばない（4.2 の 1 段目と同じ層）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleRestore(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return wantsHtml(request) ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const contentType = request.headers.get('content-type') ?? '';
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  const body = read.ok ? read.text : null;
  if (body === null || !contentType.includes(FORM_MEDIA_TYPE)) {
    return wantsHtml(request)
      ? refusal('入力を読み取れませんでした', 'もう一度お試しください。', 400)
      : json({ error: 'invalid request' }, 400);
  }
  const form = new URLSearchParams(body);
  const gameId = form.get(REVISE_GAME_ID_FIELD) ?? '';
  const seq = Number(form.get(REVISE_SEQ_FIELD));
  if (!GAME_ID_PATTERN.test(gameId) || !Number.isInteger(seq) || seq < 1) {
    return wantsHtml(request)
      ? refusal('入力を読み取れませんでした', 'もう一度お試しください。', 400)
      : json({ error: 'invalid request' }, 400);
  }

  const outcome = await restoreRevision(env, gameId, session.userId, seq);
  if (outcome === 'restored') {
    return wantsHtml(request)
      ? seeOther(workPagePath(gameId))
      : json({ restored: true, url: workPagePath(gameId) }, 200);
  }
  // **走っている推敲があるあいだは断る**（`src/revisions.ts`）。戻しても 90 秒後に
  // 黙って上書きされるので、「戻せない」ほうがまだよい。
  const heading = outcome === 'busy' ? 'いま戻せません' : 'その版が見つかりません';
  const detail =
    outcome === 'busy'
      ? '手直しが終わってから、もう一度お試しください。'
      : 'URL が正しいかご確認ください。';
  return wantsHtml(request)
    ? refusal(heading, detail, outcome === 'busy' ? 409 : 404)
    : json({ error: outcome }, outcome === 'busy' ? 409 : 404);
}

/**
 * 推敲の経路を組み立てる。
 *
 * **`pipeline` を差し替えられるのはここだけである**（`src/generate.ts` の
 * `createGenerateRoutes` と同じ形）。既定にすると単体テストが Lambda への実呼び出しを
 * 要求し、**1 回 約 16 円が受け入れ条件に混ざる。**
 *
 * @param pipeline 差し替える各段（既定は `defaultPipeline`）
 * @returns 経路表へ連結する `Route[]`
 */
export function createReviseRoutes(
  pipeline: GenerationPipeline = defaultPipeline,
): readonly Route[] {
  return [
    { method: 'POST', path: REVISE_PATH, handler: (request, env) => handleRevise(request, env, pipeline) },
    { method: 'POST', path: RESTORE_PATH, handler: handleRestore },
  ];
}

/** アプリの経路表へ連結する推敲の経路（既定の依存）。 */
export const reviseRoutes: readonly Route[] = createReviseRoutes();
