/**
 * 自作の作品を機械が読める口（#694 / M18-1。仕様 5.12）。
 *
 * 内蔵チャット（#695 / M18-2）と MCP（#696 / M19-1）の**共通の土台**である（仕様 12 章 #9 / #10）。
 * 画面（作品ページ・エディットページ・「あなたの作品」）が HTML で出している状況と中身を、
 * JSON で読めるようにする。**書き込みの口は足さない**——生成と推敲の開始は既存の
 * `/api/generate`・`/api/revise` が JSON を受けて 202 を返しており、応答に
 * この口の URL（`statusUrl`）を載せるだけにした（`src/generate.ts` / `src/revise.ts`）。
 *
 * | 口 | 返すもの |
 * |---|---|
 * | `GET /api/me/works` | 自作の一覧（「あなたの作品」と同じ行・同じ絞り込み） |
 * | `GET /api/me/works/<id>` | 1 件の詳細と状況（生成・推敲・版の一覧・指示文） |
 * | `GET /api/me/works/<id>/source` | 自作のソース（下書きも読める） |
 *
 * ## 自作だけを返す
 *
 * **他人の作品・無い id・形の違う id・取り下げた作品・削除中の作品は、すべて同じ 404
 * （`{"error":"not-found"}`）にする。** 区別できる応答を返すと、他人の下書きの id が
 * 生きているかを外から確かめられる。判定は SQL の `author_id = ?` にあり、読んだ後で
 * 比べる形にしない（読んだ行を返し忘れる余地を作らない）。
 *
 * **指示文を返すのはこの口だけである**（1.2.54 の「伏せるもの」は作者本人には伏せない）。
 * 公開面・ソース閲覧・作者ページは今までどおり指示文を出さない。
 *
 * ## 認証
 *
 * {@link resolveApiCaller} を通す（M19 で MCP のトークンを差し込む場所）。未認証は 401。
 *
 * ## 書き込まない
 *
 * **GET だけで、行を書き換えない。** 止まった生成を `failed` にする掃除は cron
 * （`src/stale-generation-sweep.ts`）の仕事で、ここは作品ページと同じく「止まっているかも
 * しれない」を `stalled` として返すだけである。
 */
import { resolveApiCaller } from './api-caller.js';
import { REMOVED_STATUS } from './games.js';
import { failureMessageOf } from './generation-failure.js';
import { listMyWorks, MY_WORKS_FILTER_PARAM, toMyWorksFilter } from './my-works-query.js';
import { workPagePath } from './paths.js';
import { listRevisions, revisionStatus } from './revisions.js';
import { json, type Route } from './routes.js';
import { readStoredSource } from './source-store.js';
import { workEditPath } from './work-edit-paths.js';
import { looksStalled } from './work-page.js';
import {
  MY_WORK_API_PREFIX,
  MY_WORK_SOURCE_SUFFIX,
  MY_WORKS_API_PATH,
  myWorkApiPath,
  myWorkSourceApiPath,
} from './works-api-paths.js';

/** 一覧の 1 ページの件数（「あなたの作品」の画面と同じ）。 */
export const MY_WORKS_API_PAGE_SIZE = 30;

/** 一覧の読み飛ばし件数の引数名。 */
export const MY_WORKS_API_OFFSET_PARAM = 'offset';

/**
 * 読み飛ばし件数の上限。**D1 の `OFFSET` は読み飛ばした行も読み取りとして数える**（3.6）ので、
 * 際限なく深いページを引かせない。1 人の作品数がここを超えることは、日次枠（確定25）から見て
 * 当面ない。
 */
export const MY_WORKS_API_MAX_OFFSET = 3000;

/** 作品 id の綴り（UUID）。形の違う id では D1 を 1 行も読まない（`src/work-source.ts` と同じ）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 自作でない・無い・読めない作品に返す本文。**理由を分けない。** */
const NOT_FOUND = { error: 'not-found' } as const;

/**
 * 自作の 1 行を引く SQL。**`author_id` の条件がこの口の門番である。**
 *
 * 取り下げ（`removed`。運営の措置・退会・削除の tombstone）と削除中（`deletion_started_at`）は
 * 引かない——作品ページが作者本人にも出さないものを、ここで出さない。
 */
const OWN_WORK_SQL = `select id, title, status, parent_id, generation_state, generation_error,
       created_at, generation_started_at, published_at, prompt, source_key
  from games
 where id = ? and author_id = ? and status <> ? and deletion_started_at is null`;

/** {@link OWN_WORK_SQL} の 1 行。 */
interface OwnWorkRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly parent_id: string | null;
  readonly generation_state: string;
  readonly generation_error: string | null;
  readonly created_at: number;
  readonly generation_started_at: number | null;
  readonly published_at: number | null;
  readonly prompt: string | null;
  readonly source_key: string | null;
}

/**
 * 生成の状況（詳細と一覧で同じ形）。
 *
 * `state` は D1 の綴りのまま（`pending` / `running` / `ready` / `failed`）。`stalled` は
 * 生成中で、かつ止まっている可能性が高いか（作品ページの `looksStalled` と同じ境界）。
 */
interface GenerationView {
  readonly state: string;
  readonly stalled: boolean;
}

/**
 * 生成の状況を組み立てる。
 *
 * @param state D1 の `generation_state`
 * @param createdAt 行を作った時刻
 * @param startedAt ジョブが走り始めた時刻
 * @param now 判定時刻（UNIX 秒）
 * @returns 状況
 */
function generationViewOf(
  state: string,
  createdAt: number,
  startedAt: number | null,
  now: number,
): GenerationView {
  const inFlight = state === 'pending' || state === 'running';
  return { state, stalled: inFlight && looksStalled({ createdAt, startedAt }, now) };
}

/**
 * 呼び出し元を解決し、未認証なら 401 を返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 利用者の id、または 401 の応答
 */
async function callerOrUnauthorized(request: Request, env: Env): Promise<string | Response> {
  const caller = await resolveApiCaller(request, env);
  return caller.ok ? caller.userId : json({ error: 'unauthorized' }, 401);
}

/**
 * 読み飛ばし件数を読む。**形の違う値は 400 にする**（黙って 0 に倒すと、呼び出し側が
 * 同じページを延々と引き直す）。
 *
 * @param value クエリの値
 * @returns 0 以上の整数、または null（不正）
 */
function parseOffset(value: string | null): number | null {
  if (value === null || value === '') {
    return 0;
  }
  if (!/^\d{1,5}$/u.test(value)) {
    return null;
  }
  const offset = Number(value);
  return offset <= MY_WORKS_API_MAX_OFFSET ? offset : null;
}

/**
 * 次のページの読み飛ばし件数を決める。
 *
 * **上限を超える位置は返さない**（返しても {@link parseOffset} が 400 で断り、たどり切れない。
 * PR #698 の Copilot の指摘）。上限の先に行があっても、この口では送らない。
 *
 * @param fetched 引いた行数（1 ページ＋1 行まで）
 * @param offset このページの読み飛ばし件数
 * @returns 次の読み飛ばし件数、または null（次が無い・上限を超える）
 */
export function nextOffsetOf(fetched: number, offset: number): number | null {
  const next = offset + MY_WORKS_API_PAGE_SIZE;
  return fetched > MY_WORKS_API_PAGE_SIZE && next <= MY_WORKS_API_MAX_OFFSET ? next : null;
}

/**
 * `GET /api/me/works` — 自作の一覧。
 *
 * 絞り込み（`state`）は「あなたの作品」の画面と同じ語彙で、知らない値は `all` に倒す
 * （`toMyWorksFilter`）。**1 行多く引いて、次のページがあるかを決める**（件数を別に数えない）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 一覧
 */
export async function handleListMyWorks(request: Request, env: Env): Promise<Response> {
  const caller = await callerOrUnauthorized(request, env);
  if (caller instanceof Response) {
    return caller;
  }
  const url = new URL(request.url);
  const offset = parseOffset(url.searchParams.get(MY_WORKS_API_OFFSET_PARAM));
  if (offset === null) {
    return json({ error: 'invalid-offset' }, 400);
  }
  const filter = toMyWorksFilter(url.searchParams.get(MY_WORKS_FILTER_PARAM));
  const rows = await listMyWorks(env, caller, filter, MY_WORKS_API_PAGE_SIZE + 1, offset);
  const now = Math.floor(Date.now() / 1000);
  const page = rows.slice(0, MY_WORKS_API_PAGE_SIZE);
  return json({
    filter,
    works: page.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      generation: generationViewOf(row.generationState, row.createdAt, row.startedAt, now),
      createdAt: row.createdAt,
      publishedAt: row.publishedAt,
      url: myWorkApiPath(row.id),
    })),
    nextOffset: nextOffsetOf(rows.length, offset),
  });
}

/**
 * 自作の 1 行を引く。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id（形は確かめ済み）
 * @param userId 呼び出し元
 * @returns 行、または null（自作でない・無い・取り下げ・削除中）
 */
async function loadOwnWork(env: Env, gameId: string, userId: string): Promise<OwnWorkRow | null> {
  return await env.DB.prepare(OWN_WORK_SQL).bind(gameId, userId, REMOVED_STATUS).first<OwnWorkRow>();
}

/**
 * `GET /api/me/works/<id>` — 1 件の詳細と状況。
 *
 * @param env バインディングと環境変数
 * @param row 自作の行
 * @returns 詳細
 */
async function workDetail(env: Env, row: OwnWorkRow): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const [revision, versions] = await Promise.all([revisionStatus(env, row.id, now), listRevisions(env, row.id)]);
  const failed = row.generation_state === 'failed';
  return json({
    id: row.id,
    title: row.title,
    status: row.status,
    parentId: row.parent_id,
    // 最初の指示文（`0047`）。**この列より前の作品と、入力の検査で止めた作品は null**。
    prompt: row.prompt,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    generation: {
      ...generationViewOf(row.generation_state, row.created_at, row.generation_started_at, now),
      error: failed ? row.generation_error : null,
      message: failed ? failureMessageOf(row.generation_error) : null,
    },
    revision: {
      used: revision.used,
      running: revision.running,
      stalled: revision.stalled,
      error: revision.failed,
      message: revision.failed === null ? null : failureMessageOf(revision.failed),
    },
    // 新しい順。**`seq = 1` の `prompt` は常に null**（最初の指示文は上の `prompt` にある）。
    versions,
    links: {
      page: workPagePath(row.id),
      edit: workEditPath(row.id),
      source: myWorkSourceApiPath(row.id),
    },
  });
}

/**
 * `GET /api/me/works/<id>/source` — 自作のソース。
 *
 * **下書きも読める**（公開作品しか返さない `/source/<id>` とは別の口である）。認可は
 * {@link loadOwnWork} が済ませてから R2 を読む（`readStoredSource` は認可をしない）。
 *
 * @param env バインディングと環境変数
 * @param row 自作の行
 * @returns ソース
 */
async function workSource(env: Env, row: OwnWorkRow): Promise<Response> {
  if (row.source_key === null) {
    // 生成中・失敗した作品。**無いことは 404 にしない**（作品はある）。
    return json({ error: 'source-not-ready' }, 409);
  }
  let stored: Awaited<ReturnType<typeof readStoredSource>>;
  try {
    stored = await readStoredSource(env, row.source_key);
  } catch (error) {
    // R2 の障害。**ワーカー全体の 500 に落とさず、口の分類で返す**（`src/work-source.ts` の
    // `readPublishedSource` と同じ扱い。PR #698 の Copilot の指摘）。キーはログへ出さない。
    console.error(
      `[works-api] R2 からソースを読む途中で失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return json({ error: 'source-missing' }, 500);
  }
  if (!stored.ok) {
    return stored.reason === 'source-too-large'
      ? json({ error: 'source-too-large' }, 409)
      : json({ error: 'source-missing' }, 500);
  }
  return json({ id: row.id, source: stored.source });
}

/**
 * `GET /api/me/works/<id>` と `GET /api/me/works/<id>/source` の振り分け。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 応答
 */
export async function handleMyWork(request: Request, env: Env): Promise<Response> {
  const caller = await callerOrUnauthorized(request, env);
  if (caller instanceof Response) {
    return caller;
  }
  const rest = new URL(request.url).pathname.slice(MY_WORK_API_PREFIX.length);
  const wantsSource = rest.endsWith(MY_WORK_SOURCE_SUFFIX);
  const gameId = wantsSource ? rest.slice(0, -MY_WORK_SOURCE_SUFFIX.length) : rest;
  if (!GAME_ID_PATTERN.test(gameId)) {
    return json(NOT_FOUND, 404);
  }
  const row = await loadOwnWork(env, gameId, caller);
  if (row === null) {
    return json(NOT_FOUND, 404);
  }
  return wantsSource ? await workSource(env, row) : await workDetail(env, row);
}

/** 自作の作品を機械が読める口の経路。 */
export const worksApiRoutes: readonly Route[] = [
  { method: 'GET', path: MY_WORKS_API_PATH, handler: handleListMyWorks },
  { method: 'GET', path: MY_WORK_API_PREFIX, match: 'prefix', handler: handleMyWork },
];
