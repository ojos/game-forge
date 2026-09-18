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
 * - **どこまで進んだかは、毎往復 D1 の今の状態から導く**（{@link handleBulk}）。URL が運ぶのは、試して断られた作品の
 *   番号と理由（`ng=<番号>.<理由>`）だけで、**成功の件数は運ばない**——結果の画面の成功は D1 の状態から数える
 *   （PR #669 の Copilot code review。以前は `step` と `done` を運び、書き換えると先頭を飛ばしたまま全件成功と出せた）
 * - **最後の往復だけが結果の画面を返す**
 *
 * **往復の数は、ブラウザがたどれるリダイレクトの数に収める**（30 件の削除で 15 往復・リダイレクト 14 回。Safari の上限 16 回）。
 */
import { LOGIN_PATH, loginRequiredRedirect } from './auth/google.js';
import type { PublishOutcome, UnpublishOutcome } from './games.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, unpublishGame, workTagsOf } from './games.js';
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

/**
 * 続きの往復であることを示す問い合わせの名前（値は `1`）。**最初の往復（確認画面のフォーム）は持たない。**
 *
 * 最初の往復だけが「もう目的の状態になっている作品」を `already-*` として控える（確認画面を経ずに送られた id を、
 * この呼び出しが書き換えた作品として数えないため）。
 */
export const BULK_CONTINUE_PARAM = 'cont';

/** 試して断られた作品（`<番号>.<理由>`）を運ぶ問い合わせの名前。 */
export const BULK_FAILED_PARAM = 'ng';

/**
 * 試して断られた作品を URL から読む（読めない・重なる・範囲の外なら null）。
 *
 * **ここが運ぶのは「断られた作品と理由」だけである。** 何件成功したかは運ばない——成功は毎回 D1 の今の状態から
 * 数える（{@link reachedTarget}。PR #669 の Copilot code review。以前は `step` と `done` を運び、書き換えると先頭を
 * 飛ばしたまま「全件成功」を出せた）。この値を書き換えてできるのは、まだ試していない作品を「断られた」扱いにして
 * 飛ばすこと（書き換えは起きず、結果の画面に失敗として出る）と、断られた理由の表示を変えることだけである。
 *
 * @param url 要求の URL
 * @param count 選んだ件数
 * @returns 番号から理由への対応。読めなければ null
 */
export function readFailures(url: URL, count: number): ReadonlyMap<number, BulkReason> | null {
  const failed = new Map<number, BulkReason>();
  for (const entry of url.searchParams.getAll(BULK_FAILED_PARAM)) {
    const match = /^(0|[1-9][0-9]{0,2})\.([a-z-]+)$/u.exec(entry);
    const index = match === null ? -1 : Number(match[1]);
    const reason = match === null ? null : toBulkReason(match[2]!);
    if (index < 0 || index >= count || reason === null || failed.has(index)) {
      return null;
    }
    failed.set(index, reason);
  }
  return failed;
}

/**
 * 次の往復の URL を組み立てる。
 *
 * @param failed 試して断られた作品
 * @returns 実行の口のパス（問い合わせ付き）
 */
export function nextStepPath(failed: ReadonlyMap<number, BulkReason>): string {
  const params = new URLSearchParams();
  params.set(BULK_CONTINUE_PARAM, '1');
  for (const [index, reason] of [...failed].sort(([a], [b]) => a - b)) {
    params.append(BULK_FAILED_PARAM, `${index}.${reason}`);
  }
  return `${WORKS_BULK_API_PATH}?${params.toString()}`;
}

/**
 * 作品が操作の目的の状態にあるかを、**D1 の今の行から**決める（成功を数える唯一の根拠）。
 *
 * - 公開: 作者本人の行が `published`
 * - 下書きへ戻す: 作者本人の行が `draft`
 * - 削除: 行が無い、または作者本人の行の中身を消してある（`purged`）
 *
 * **削除の「行が無い」は、行の無い id を混ぜた場合と区別できない。** 最初の往復で行の無い id を `not-found` として
 * 控えるので、確認画面から送った要求では起きない（URL の控えを消した場合にだけ、行の無い id が成功に数えられる）。
 *
 * @param action 操作
 * @param row いまの行（無ければ null）
 * @param userId 操作している利用者
 * @returns 目的の状態にあれば true
 */
export function reachedTarget(action: BulkAction, row: BulkTargetRow | null, userId: string): boolean {
  if (row === null) {
    return action === 'delete';
  }
  if (row.author_id !== userId) {
    return false;
  }
  switch (action) {
    case 'publish':
      return row.status === PUBLISHED_STATUS;
    case 'unpublish':
      return row.status === DRAFT_STATUS;
    case 'delete':
      return row.purged === 1;
  }
}

/** もう目的の状態にある作品を、最初の往復で控えるときの理由。 */
const ALREADY: Readonly<Record<BulkAction, BulkReason>> = {
  publish: 'already-published',
  unpublish: 'already-draft',
  delete: 'purged',
};

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
export interface BulkDependencies {
  readonly start: StartOgpCapture;
  readonly notify: NotifyForkPublished;
}

/**
 * 1 件を処理する。**1 件ずつの口と同じ関数を呼ぶ**（冒頭の表）。
 *
 * **タグは語彙に照らさずにそのまま渡す**（PR #669 の Copilot code review）。語彙に無いタグを黙って落とすと、1 件ずつの
 * 公開の口（`unknown-tag` で断る）より緩くなり、作者の付けたタグが消える。断りは `tags` として名前付きで示す。
 *
 * @param env バインディングと環境変数
 * @param action 操作
 * @param row いまの行
 * @param userId 操作している利用者
 * @param deps 撮影と通知の段
 * @returns 断られた理由。成功なら null
 * @throws 1 件ずつの関数が投げた例外（呼ぶ側が行を読み直して分ける）
 */
async function applyOne(
  env: Env,
  action: BulkAction,
  row: BulkTargetRow,
  userId: string,
  deps: BulkDependencies,
): Promise<BulkReason | null> {
  switch (action) {
    case 'publish': {
      const { outcome } = await runPublish(env, row.id, userId, workTagsOf(row), deps.start, deps.notify);
      return publishReasonOf(outcome);
    }
    case 'unpublish':
      return unpublishReasonOf(await unpublishGame(env, row.id, userId));
    case 'delete':
      return deleteReasonOf(await deleteAuthoredGame(env, row.id, userId));
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
 * # 1 往復の流れ
 *
 * 1. 選んだ作品の行を**すべて** 1 文で読み直す（30 件まで）
 * 2. 各作品を 3 つに分ける——**済み**（D1 が目的の状態。{@link reachedTarget}）・**断られた**（URL の控え、または
 *    いまの状態で {@link bulkBlockOf} が外す）・**残り**。最初の往復だけは、もう目的の状態にある作品を `already-*` として控える
 * 3. 残りの先頭から {@link BULK_STEP_SIZES} 件だけを 1 件ずつの関数で処理する。断られたら控えに足す
 * 4. 残りがあれば 307 で次の往復へ。無ければ結果の画面を返す——**成功の件数は D1 の状態から数える**
 *
 * **往復の数は、処理する作品が毎回必ず減るので `ceil(30 / 1 往復の件数)` で止まる。**
 *
 * # 例外が出た作品（PR #669 の Copilot code review）
 *
 * 公開・下書きへ戻すは、行を書き換えてから後の処理（撮影の起動・通知・親の数え直し）をする。後の処理が投げたとき、
 * 行はもう目的の状態にある。**行を読み直して分ける**——目的の状態なら `post-error`（済み。結果の画面で「後の処理に
 * 失敗した」と別に示す）、そうでなければ `error`。
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
  const url = new URL(request.url);
  const first = !url.searchParams.has(BULK_CONTINUE_PARAM);
  const recorded = readFailures(url, ids.length);
  if (recorded === null) {
    return html(renderBulkRefusal('まとめて操作できません', '途中までの進み具合を読み取れませんでした。「あなたの作品」を開き直して、結果を確かめてください。'), 400);
  }

  const userId = session.userId;
  const rows = new Map(await loadTargets(env, ids));
  const failed = new Map(recorded);
  const pending: number[] = [];
  for (const [index, id] of ids.entries()) {
    if (failed.has(index)) {
      continue;
    }
    const row = rows.get(id) ?? null;
    if (reachedTarget(action, row, userId)) {
      // **最初の往復で行が無いのは、消したのではなく最初から無い**（削除の「済み」と区別する。{@link reachedTarget}）。
      if (first) {
        failed.set(index, row === null ? 'not-found' : ALREADY[action]);
      }
      continue;
    }
    const blocked = bulkBlockOf(action, row, userId);
    if (blocked !== null) {
      failed.set(index, blocked);
      continue;
    }
    pending.push(index);
  }

  const size = BULK_STEP_SIZES[action];
  for (const index of pending.slice(0, size)) {
    const row = rows.get(ids[index]!)!;
    try {
      const reason = await applyOne(env, action, row, userId, deps);
      if (reason !== null) {
        failed.set(index, reason);
      } else {
        // 済み。結果の画面は D1 の状態から数えるので、ここでは行の写しを目的の状態へ進めるだけである。
        rows.set(row.id, action === 'delete' ? { ...row, purged: 1 } : { ...row, status: action === 'publish' ? PUBLISHED_STATUS : DRAFT_STATUS });
      }
    } catch (error) {
      console.error(
        `[works-bulk] ${action} に失敗しました（${row.id}）: ${error instanceof Error ? error.name : typeof error}`,
      );
      const reread = (await loadTargets(env, [row.id])).get(row.id) ?? null;
      if (action === 'delete' && reread === null) {
        rows.delete(row.id);
      } else if (reread !== null) {
        rows.set(row.id, reread);
      }
      failed.set(index, reachedTarget(action, reread, userId) ? 'post-error' : 'error');
    }
  }

  if (pending.length > size) {
    return temporaryRedirect(nextStepPath(failed));
  }

  // **最後の往復だけが結果を描く。成功は D1 の状態から数える**（URL は成功の数を運ばない）。
  let done = 0;
  const failedWorks: BulkExcludedWork[] = [];
  const afterErrors: BulkListedWork[] = [];
  let notFound = 0;
  for (const [index, id] of ids.entries()) {
    const reason = failed.get(index);
    const row = rows.get(id) ?? null;
    if (reason === 'post-error' && reachedTarget(action, row, userId)) {
      done += 1;
      if (row !== null) {
        afterErrors.push({ id, title: row.title });
      }
      continue;
    }
    if (reason === undefined && reachedTarget(action, row, userId)) {
      done += 1;
      continue;
    }
    const shown = reason ?? bulkBlockOf(action, row, userId) ?? 'error';
    if (shown === 'not-found' || row === null || row.author_id !== userId) {
      notFound += 1;
    } else {
      failedWorks.push({ id, title: row.title, reason: shown === 'post-error' ? 'error' : shown });
    }
  }
  return html(renderBulkResult({ action, done, failed: failedWorks, notFound, afterErrors }));
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
