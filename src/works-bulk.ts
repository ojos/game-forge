/**
 * 「あなたの作品」の一括操作の経路（#666）——確認画面（`GET /works/mine/bulk`）と実行の口（`POST /api/works/bulk`）。
 *
 * ## 流れ
 *
 * 1. 一覧の表（`src/my-works.ts`）で作品を選び、「公開する」「下書きに戻す」「削除する」のどれかを押す。**表は素の
 *    GET のフォームなので、押しても何も書き換わらない**——移る先がこの確認画面である
 * 2. 確認画面は、対象にする作品と、対象から外す作品（名前と理由）と、押すと起きることを並べる
 *    （`src/works-bulk-page.ts`）。送るフォームには対象にする作品だけを入れる
 * 3. 実行の口は、**1 件ずつの口と同じ関数を 1 件ずつ呼ぶ**（公開は `runPublish`、下書きへ戻すは `unpublishGame`、
 *    削除は `deleteAuthoredGame`）。一部だけ断られたら、どの作品かを名前付きで示す
 *
 * ## 1 件ずつの口の検査を弱めない（#666 の constraints）
 *
 * | 検査 | 1 件ずつの口 | ここ |
 * |---|---|---|
 * | ログイン | `resolveSessionUser`（未ログインはログインへ） | 同じ |
 * | 作者本人か | 各関数の SQL（`author_id = ?`）・削除は `deleteAuthoredGame` | **同じ関数を通す** |
 * | いまの状態（生成中・公開中…） | 各関数の SQL | **同じ関数を通す**（その前に {@link bulkBlockOf} でも外す。緩める向きには働かない） |
 * | CSRF | セッション cookie の `SameSite=Lax`（`src/publish.ts` の冒頭） | 同じ（POST だけが書き換える。確認画面の GET は何も書かない） |
 * | 本文の形 | 媒体型を絞り、大きさを縛り、id の綴りを見る | 同じ（id を {@link MAX_BULK_WORKS} 件まで） |
 *
 * ## 往復に分ける（Workers Free の D1 の枠）
 *
 * **D1 は 1 呼び出しあたり 50 文まで**である（仕様 3.6）。削除は 1 件で 14〜15 文を使うので、30 件を 1 回では消せない。
 * そこで**数件ずつ処理しては、307 で同じ口へ送り直す**（{@link BULK_STEP_SIZES}）。
 *
 * - **307 は本文と POST をそのまま保つ**（303 と違い GET に変えない）。ブラウザは確かめずに送り直すので、利用者は
 *   1 回押すだけである。JavaScript も要らない（9.3）
 * - **URL の問い合わせに、どこまで進んだか（`step`）と、成功した件数（`done`）と、断られた作品（`ng=<番号>.<理由>`）を
 *   載せる。** 本文は選んだ作品の並びのまま変わらないので、番号で作品を指せる。**URL の値は検算してから使う**
 *   （{@link readProgress}）——書き換えても、成功の件数と失敗の理由の表示が変わるだけで、どの作品が書き換わるかは
 *   変わらない（書き換えるかどうかを決めるのは、毎回の往復で掛け直す判定と 1 件ずつの関数である）
 * - **最後の往復だけが結果の画面を返す**
 *
 * **往復の数は、ブラウザがたどれるリダイレクトの数に収める**（30 件の削除で 15 往復・リダイレクト 14 回。Safari の上限 16 回）。
 */
import { LOGIN_PATH, loginRequiredRedirect } from './auth/google.js';
import type { PublishOutcome, UnpublishOutcome } from './games.js';
import { unpublishGame, workTagsOf } from './games.js';
import { headerAvatarUrl, siteViewerAt } from './html.js';
import type { NotifyForkPublished } from './publish.js';
import { runPublish } from './publish.js';
import { notifyForkPublished } from './mail/fork-notice.js';
import type { StartOgpCapture } from './ogp-client.js';
import { startOgpCaptureOnLambda } from './ogp-client.js';
import type { Route } from './routes.js';
import { html, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import type { AuthoredDeletionOutcome } from './work-delete.js';
import { deleteAuthoredGame } from './work-delete.js';
import { knownWorkTags } from './work-card.js';
import type { BulkExcludedWork, BulkListedWork } from './works-bulk-page.js';
import {
  renderBulkConfirmation,
  renderBulkNothingSelected,
  renderBulkRefusal,
  renderBulkResult,
} from './works-bulk-page.js';
import type { BulkAction, BulkReason, BulkTargetRow } from './works-bulk-rules.js';
import {
  BULK_STEP_SIZES,
  MAX_BULK_WORKS,
  bulkBlockOf,
  bulkTargetsSql,
  toBulkAction,
  toBulkReason,
} from './works-bulk-rules.js';
import {
  MY_WORKS_BULK_PATH,
  WORKS_BULK_ACTION_FIELD,
  WORKS_BULK_API_PATH,
  WORKS_BULK_GAME_ID_FIELD,
} from './works-bulk-paths.js';
import { MY_WORKS_PATH } from './works-paths.js';

/** `games.id` の綴り（`crypto.randomUUID()` が返す形。`src/publish.ts` と同じ）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * 実行の本文の上限（**4 KiB**）。載るのは操作の種類と、id が {@link MAX_BULK_WORKS} 件
 * （`&game_id=` ＋ 36 文字 ＝ 45 バイト × 30 ＝ 1,350 バイト）である。
 */
const MAX_BODY_BYTES = 4096;

/** 往復の段を運ぶ問い合わせの名前。 */
export const BULK_STEP_PARAM = 'step';
/** 成功した件数を運ぶ問い合わせの名前。 */
export const BULK_DONE_PARAM = 'done';
/** 断られた作品（`<番号>.<理由>`）を運ぶ問い合わせの名前。 */
export const BULK_FAILED_PARAM = 'ng';

/** 選んだ作品の読み取りの結果。 */
type SelectionResult =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly heading: string; readonly body: string };

/**
 * 選んだ作品の id を検査する（確認画面と実行の口が同じ規則を通す）。
 *
 * - **重ねて選ばれた id は 1 つにまとめる**（選んだ順は保つ）
 * - **綴りの違う id が 1 つでもあれば断る**（黙って捨てると、選んだのに対象に出ない作品ができる）
 * - **{@link MAX_BULK_WORKS} 件を超えたら断る**（何もしない。一部だけ処理しない）
 *
 * @param raw 項目の値の並び
 * @returns id の並び、または断りの文言
 */
export function readSelection(raw: readonly string[]): SelectionResult {
  const ids = [...new Set(raw)];
  if (ids.some((id) => !GAME_ID_PATTERN.test(id))) {
    return { ok: false, heading: '作品を選び直してください', body: '選んだ作品の指定が正しくありません。「あなたの作品」を開き直して、選び直してください。' };
  }
  if (ids.length > MAX_BULK_WORKS) {
    return {
      ok: false,
      heading: `一度に選べるのは ${MAX_BULK_WORKS} 件までです`,
      body: `${ids.length} 件が選ばれています。${MAX_BULK_WORKS} 件までに減らしてから、もう一度お試しください（まだ何も変えていません）。`,
    };
  }
  return { ok: true, ids };
}

/**
 * 対象の行を引く（1 文）。**作者の一致は画面側の判定（{@link bulkBlockOf}）が見る**（`bulkTargetsSql` の注記）。
 *
 * @param env バインディングと環境変数
 * @param ids 作品 id（1 件以上）
 * @returns id から行への対応
 */
async function loadTargets(env: Env, ids: readonly string[]): Promise<ReadonlyMap<string, BulkTargetRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const result = await env.DB.prepare(bulkTargetsSql(ids.length))
    .bind(...ids)
    .all<BulkTargetRow>();
  return new Map(result.results.map((row) => [row.id, row]));
}

/**
 * 確認画面を開く（`GET /works/mine/bulk`）。
 *
 * **何も書き換えない。** 未ログインならログインへ送り、戻り先は「あなたの作品」にする（選んだ作品は URL にしか
 * 無く、ログインの往復は問い合わせを運ばない。2.3.11）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showBulkConfirmation(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return await loginRequiredRedirect(env, MY_WORKS_PATH);
  }
  const viewer = siteViewerAt(MY_WORKS_BULK_PATH, true, headerAvatarUrl(request, env, session.userId));
  const params = new URL(request.url).searchParams;
  const selection = readSelection(params.getAll(WORKS_BULK_GAME_ID_FIELD));
  if (!selection.ok) {
    return html(renderBulkRefusal(selection.heading, selection.body, viewer), 400);
  }
  if (selection.ids.length === 0) {
    return html(renderBulkNothingSelected(viewer));
  }
  const action = toBulkAction(params.get(WORKS_BULK_ACTION_FIELD));
  if (action === null) {
    return html(
      renderBulkRefusal('操作を選び直してください', '操作の種類が正しくありません。「あなたの作品」を開き直して、もう一度お試しください。', viewer),
      400,
    );
  }

  const rows = await loadTargets(env, selection.ids);
  const targets: BulkListedWork[] = [];
  const excluded: BulkExcludedWork[] = [];
  let notFound = 0;
  for (const id of selection.ids) {
    const row = rows.get(id) ?? null;
    const reason = bulkBlockOf(action, row, session.userId);
    if (reason === 'not-found' || row === null) {
      notFound += 1;
    } else if (reason === null) {
      targets.push({ id, title: row.title });
    } else {
      excluded.push({ id, title: row.title, reason });
    }
  }
  return html(renderBulkConfirmation({ action, targets, excluded, notFound }, viewer));
}

/** 往復の進み具合（URL の問い合わせから読んだもの）。 */
export interface BulkProgress {
  /** 何往復目か（0 始まり）。 */
  readonly step: number;
  /** これまでに成功した件数。 */
  readonly done: number;
  /** これまでに断られた作品（選んだ並びの番号と理由）。 */
  readonly failed: ReadonlyMap<number, BulkReason>;
}

/**
 * URL の問い合わせから進み具合を読み、**検算する**（読めない・辻褄が合わないなら null）。
 *
 * - `step` は 0 以上で、その往復の先頭が選んだ件数より手前にある
 * - `done` と断られた数の和が、これまでに処理した件数（`step × 1 往復の件数`）に一致する
 * - 断られた作品の番号は、これまでに処理した範囲の中にあり、重ならない
 *
 * **最初の往復は問い合わせを持たない**（確認画面のフォームは素の `action` で送る）。
 *
 * @param url 要求の URL
 * @param action 操作
 * @param count 選んだ件数
 * @returns 進み具合。読めなければ null
 */
export function readProgress(url: URL, action: BulkAction, count: number): BulkProgress | null {
  const params = url.searchParams;
  const rawStep = params.get(BULK_STEP_PARAM);
  if (rawStep === null) {
    return params.has(BULK_DONE_PARAM) || params.has(BULK_FAILED_PARAM)
      ? null
      : { step: 0, done: 0, failed: new Map() };
  }
  const size = BULK_STEP_SIZES[action];
  const step = /^(0|[1-9][0-9]{0,2})$/u.test(rawStep) ? Number(rawStep) : -1;
  const processed = step * size;
  if (step < 1 || processed >= count) {
    return null;
  }
  const rawDone = params.get(BULK_DONE_PARAM) ?? '';
  const done = /^(0|[1-9][0-9]{0,2})$/u.test(rawDone) ? Number(rawDone) : -1;
  if (done < 0) {
    return null;
  }
  const failed = new Map<number, BulkReason>();
  for (const entry of params.getAll(BULK_FAILED_PARAM)) {
    const match = /^(0|[1-9][0-9]{0,2})\.([a-z-]+)$/u.exec(entry);
    const index = match === null ? -1 : Number(match[1]);
    const reason = match === null ? null : toBulkReason(match[2]!);
    if (index < 0 || index >= processed || reason === null || failed.has(index)) {
      return null;
    }
    failed.set(index, reason);
  }
  return done + failed.size === processed ? { step, done, failed } : null;
}

/**
 * 次の往復の URL を組み立てる。
 *
 * @param progress 次の往復の進み具合
 * @returns 実行の口のパス（問い合わせ付き）
 */
export function nextStepPath(progress: BulkProgress): string {
  const params = new URLSearchParams();
  params.set(BULK_STEP_PARAM, String(progress.step));
  params.set(BULK_DONE_PARAM, String(progress.done));
  for (const [index, reason] of [...progress.failed].sort(([a], [b]) => a - b)) {
    params.append(BULK_FAILED_PARAM, `${index}.${reason}`);
  }
  return `${WORKS_BULK_API_PATH}?${params.toString()}`;
}

/**
 * 公開の結果を理由へ落とす（成功なら null）。
 *
 * @param outcome 公開の結果
 * @returns 理由。成功なら null
 */
function publishReasonOf(outcome: PublishOutcome): BulkReason | null {
  if (outcome.ok) {
    return null;
  }
  switch (outcome.reason) {
    case 'not-found':
      return 'not-found';
    case 'not-ready':
      return 'generating';
    case 'removed':
      return 'removed';
    case 'too-many-tags':
    case 'unknown-tag':
      return 'tags';
  }
}

/**
 * 下書きへ戻した結果を理由へ落とす（成功なら null）。
 *
 * @param outcome 結果
 * @returns 理由。成功なら null
 */
function unpublishReasonOf(outcome: UnpublishOutcome): BulkReason | null {
  if (outcome.ok) {
    return null;
  }
  return outcome.reason === 'not-found' ? 'not-found' : 'removed';
}

/**
 * 削除の結果を理由へ落とす（成功なら null）。
 *
 * @param outcome 結果
 * @returns 理由。成功なら null
 */
function deleteReasonOf(outcome: AuthoredDeletionOutcome): BulkReason | null {
  return outcome.ok ? null : outcome.reason;
}

/** 実行の段（テストが撮影と通知を差し替える）。 */
interface BulkDependencies {
  readonly start: StartOgpCapture;
  readonly notify: NotifyForkPublished;
}

/**
 * 1 件を処理する。**1 件ずつの口と同じ関数を呼ぶ**（冒頭の表）。
 *
 * **例外はこの 1 件の失敗にして、残りを続ける**（R2 の一時的な失敗などで、選んだ全部を巻き添えにしない）。
 * ログには例外の種類と作品 id だけを出す（題名は出さない）。
 *
 * @param env バインディングと環境変数
 * @param action 操作
 * @param row いまの行（無ければ null）
 * @param gameId 作品 id
 * @param userId 操作している利用者
 * @param deps 撮影と通知の段
 * @returns 断られた理由。成功なら null
 */
async function applyOne(
  env: Env,
  action: BulkAction,
  row: BulkTargetRow | null,
  gameId: string,
  userId: string,
  deps: BulkDependencies,
): Promise<BulkReason | null> {
  // **表示の条件で先に外す**（確認画面のあとで状態が動いた作品・手で足された id）。緩める向きには働かない
  // ——外さなかった作品も、下の関数が同じ条件でもう一度断る。
  const blocked = bulkBlockOf(action, row, userId);
  if (blocked !== null || row === null) {
    return blocked ?? 'not-found';
  }
  try {
    switch (action) {
      case 'publish': {
        // **いま付いているタグのまま公開する**（タグの一括設定は #666 の scope.out）。語彙に無い値は落とす
        // ——`publishGame` は語彙に無い値を断るので、渡すと公開そのものが止まる。
        const tags = knownWorkTags(workTagsOf(row)).map((tag) => tag.id);
        const { outcome } = await runPublish(env, gameId, userId, tags, deps.start, deps.notify);
        return publishReasonOf(outcome);
      }
      case 'unpublish':
        return unpublishReasonOf(await unpublishGame(env, gameId, userId));
      case 'delete':
        return deleteReasonOf(await deleteAuthoredGame(env, gameId, userId));
    }
  } catch (error) {
    console.error(
      `[works-bulk] ${action} に失敗しました（${gameId}）: ${error instanceof Error ? error.name : typeof error}`,
    );
    return 'error';
  }
}

/**
 * 307 Temporary Redirect を返す（**本文と POST を保ったまま**次の往復へ送る）。
 *
 * @param location 次の往復の URL
 * @returns レスポンス
 */
function temporaryRedirect(location: string): Response {
  return new Response(null, { status: 307, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 実行の口（`POST /api/works/bulk`）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param deps 撮影と通知の段
 * @returns レスポンス
 */
async function handleBulk(request: Request, env: Env, deps: BulkDependencies): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return new Response(null, { status: 303, headers: { location: LOGIN_PATH, 'cache-control': 'no-store' } });
  }

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return html(renderBulkRefusal('まとめて操作できません', '要求の形式に対応していません。'), 415);
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === 'body-too-large'
      ? html(renderBulkRefusal('まとめて操作できません', '要求が大きすぎます。'), 413)
      : html(renderBulkRefusal('まとめて操作できません', '要求を最後まで受け取れませんでした。もう一度お試しください。'), 400);
  }
  const form = new URLSearchParams(read.text);
  const action = toBulkAction(form.get(WORKS_BULK_ACTION_FIELD));
  const selection = readSelection(form.getAll(WORKS_BULK_GAME_ID_FIELD));
  if (!selection.ok) {
    return html(renderBulkRefusal(selection.heading, selection.body), 400);
  }
  if (action === null || selection.ids.length === 0) {
    return html(renderBulkRefusal('まとめて操作できません', '操作の種類か、選んだ作品が正しくありません。「あなたの作品」を開き直して、もう一度お試しください。'), 400);
  }
  const ids = selection.ids;
  const progress = readProgress(new URL(request.url), action, ids.length);
  if (progress === null) {
    return html(renderBulkRefusal('まとめて操作できません', '途中までの進み具合を読み取れませんでした。「あなたの作品」を開き直して、結果を確かめてください。'), 400);
  }

  // **この往復の分だけを処理する**（冒頭「往復に分ける」）。行は 1 文でまとめて引く。
  const size = BULK_STEP_SIZES[action];
  const from = progress.step * size;
  const slice = ids.slice(from, from + size);
  const rows = await loadTargets(env, slice);
  let done = progress.done;
  const failed = new Map(progress.failed);
  for (const [offset, id] of slice.entries()) {
    const reason = await applyOne(env, action, rows.get(id) ?? null, id, session.userId, deps);
    if (reason === null) {
      done += 1;
    } else {
      failed.set(from + offset, reason);
    }
  }

  if (from + size < ids.length) {
    return temporaryRedirect(nextStepPath({ step: progress.step + 1, done, failed }));
  }

  // **最後の往復だけが結果を描く。** 断られた作品の名前は、作者本人の行だけから引く（`not-found` は名前を出さない）。
  const failedIds = [...failed.keys()].sort((a, b) => a - b).map((index) => ids[index]!);
  const names = await loadTargets(env, failedIds);
  const failedWorks: BulkExcludedWork[] = [];
  let notFound = 0;
  for (const index of [...failed.keys()].sort((a, b) => a - b)) {
    const reason = failed.get(index)!;
    const row = names.get(ids[index]!) ?? null;
    if (reason === 'not-found' || row === null || row.author_id !== session.userId) {
      notFound += 1;
    } else {
      failedWorks.push({ id: row.id, title: row.title, reason });
    }
  }
  return html(renderBulkResult({ action, done, failed: failedWorks, notFound }));
}

/**
 * 一括操作の経路を組み立てる（撮影と通知の段を差し替えられるのはここだけ。`src/publish.ts` の
 * `createPublishRoutes` と同じ形）。
 *
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @param notify 改造の通知を送る段（既定は本物の送信）
 * @returns 経路表
 */
export function createWorksBulkRoutes(
  start: StartOgpCapture = startOgpCaptureOnLambda,
  notify: NotifyForkPublished = notifyForkPublished,
): readonly Route[] {
  return [
    { method: 'GET', path: MY_WORKS_BULK_PATH, handler: showBulkConfirmation },
    {
      method: 'POST',
      path: WORKS_BULK_API_PATH,
      handler: (request, env) => handleBulk(request, env, { start, notify }),
    },
  ];
}

/** アプリの経路表へ連結する一括操作の経路。 */
export const worksBulkRoutes: readonly Route[] = createWorksBulkRoutes();
