/**
 * 試用の録画（#978）の口——録画を始める・断片を受け取って非公開の R2 へ書く・止まったことを残す。
 * あわせて、管理画面が断片をつないで返すための読み出しを持つ（経路は `src/admin/trials.ts`）。
 *
 * ## 誰から受け取るか
 *
 * **印のある、ログイン中の、同意した試用者だけ**（`trial_participants` の行があり、段が録画の準備より後）。
 * セッションが無ければ 401、印が無ければ 404 を JSON で返す（画面ではなくスクリプトが呼ぶ口なので、
 * ログインへ送らない。`test/withdrawal-routes.test.ts` は 401 を「退会した cookie を受け付けない」と数える）。
 *
 * ## 断片の受け取り方
 *
 * 断片は `trial/<利用者>/<録画>/<連番 6 桁>`（`src/trial-recording-store.ts` の `trialRecordingChunkKey`）に、
 * **連番の順に 1 つずつ**受け取る。
 *
 *   - `seq = next_seq` … R2 へ書いてから、目録の `next_seq` を 1 つ進める（条件付き UPDATE）。**R2 を先に書く**
 *     ——目録を先に進めて R2 で落ちると、抜けた番号のまま次へ進む。**R2 へは「無いときだけ」書く**
 *     （`If-None-Match: *`）。R2 に書けて目録で落ちたときの送り直しや、同じ番号が同時に 2 度届いたときは、
 *     先に在る断片を正として目録を進め、後から届いた中身で置き換えない。
 *   - `seq < next_seq` … **受け取り済み。書かずに 200 を返す**（冪等。送り直しで同じ断片が 2 度届くのは平常の形）。
 *     **上書きしない**——受け取った断片を、後から届いた別の中身で置き換えさせない。
 *   - `seq > next_seq` … **抜けがあるので 409 で断り、次に要る番号を返す。** 抜けたまま進めると、つないだ録画が
 *     再生できない。ブラウザはその番号から送り直す。
 *
 * ## CSRF
 *
 * 本文は JSON か断片のバイト列で、`fetch` からしか送れない形にしてある。セッション cookie は `SameSite=Lax` なので、
 * 別のサイトからの POST には付かない（`src/trial.ts` の口と同じ）。
 */
import { json } from './routes.js';
import type { Route } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import {
  TRIAL_RECORDING_CHUNK_API_PATH,
  TRIAL_RECORDING_ID_PARAM,
  TRIAL_RECORDING_SEQ_PARAM,
  TRIAL_RECORDING_START_API_PATH,
  TRIAL_RECORDING_STOP_API_PATH,
} from './trial-paths.js';
import type { TrialRecordingEndReason, TrialRecordingRow } from './trial-recording-store.js';
import {
  TRIAL_RECORDING_ACCEPT_SECONDS,
  TRIAL_RECORDING_AUDIO_BPS,
  TRIAL_RECORDING_CHUNK_MS,
  TRIAL_RECORDING_END_REASONS,
  TRIAL_RECORDING_MAX_BYTES,
  TRIAL_RECORDING_MAX_CHUNK_BYTES,
  TRIAL_RECORDING_MAX_PARTICIPANT_BYTES,
  TRIAL_RECORDING_MAX_SECONDS,
  TRIAL_RECORDING_PART_CHUNKS,
  TRIAL_RECORDING_VIDEO_BPS,
  canSendTrialRecordingChunk,
  canStartTrialRecording,
  commitTrialRecordingChunk,
  createTrialRecording,
  TRIAL_RECORDING_KEY_PREFIX,
  deleteTrialRecordingRows,
  detectTrialBrowser,
  endTrialRecording,
  findTrialRecording,
  isTrialRecordingId,
  parseChunkSeq,
  parseDisplaySurface,
  parseRecordingMimeType,
  trialRecordedBytes,
  trialRecordingChunkKey,
  trialRecordingPartCount,
} from './trial-recording-store.js';
import type { TrialParticipantRow } from './trial-store.js';
import { findTrialParticipant } from './trial-store.js';

/** 録画を始める口・止まったことを伝える口の本文の上限（バイト）。 */
const MAX_JSON_BYTES = 2_000;

/** 口が返す断りの理由。 */
export type TrialRecordingRejection =
  | 'unauthenticated'
  | 'not-found'
  | 'stage'
  | 'invalid-request'
  | 'unsupported-format'
  | 'too-many-recordings'
  | 'recording-not-found'
  | 'gap'
  | 'too-long'
  | 'chunk-too-large'
  | 'recording-too-large'
  | 'empty-chunk'
  | 'storage-failed';

/**
 * 断りの応答を作る。
 *
 * @param reason 理由
 * @param status HTTP ステータス
 * @param extra 足す値
 * @returns レスポンス
 */
function reject(reason: TrialRecordingRejection, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: reason, ...extra }, status);
}

/** 試用者を解決した結果。 */
type RecordingAccess =
  | { readonly ok: true; readonly userId: string; readonly row: TrialParticipantRow }
  | { readonly ok: false; readonly response: Response };

/**
 * 要求から、同意した試用者を解決する（セッションが無ければ 401、印が無ければ 404）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 試用者、またはそのまま返す応答
 */
async function resolveRecordingAccess(request: Request, env: Env): Promise<RecordingAccess> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return { ok: false, response: reject('unauthenticated', 401) };
  }
  const row = await findTrialParticipant(env.DB, session.userId);
  if (row === null) {
    return { ok: false, response: reject('not-found', 404) };
  }
  // 段が録画の準備より後なら同意している（同意の段からは、同意の版を書かないと進めない。src/trial-store.ts）。
  // **版が無い行は同意していない**として扱う（運営が SQL で段だけを動かした行を通さない）。
  if (row.consent_version === null || row.consented_at === null) {
    return { ok: false, response: reject('stage', 409) };
  }
  return { ok: true, userId: session.userId, row };
}

/**
 * JSON の本文を読む（上限つき。読めなければ null）。
 *
 * @param request 受信したリクエスト
 * @returns 値
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return null;
  }
  const bytes = await readLimitedBytes(request, MAX_JSON_BYTES);
  if (!bytes.ok) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** バイト列の読み出し結果。 */
type BytesReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'body-too-large' | 'unreadable-body' };

/**
 * 本文を、上限を超えたら打ち切りながらバイト列として読む（`src/routes.ts` の `readLimitedText` のバイト版）。
 *
 * **`Content-Length` が上限を超えていれば読まずに断る**（8 MiB を超える本文を受け取りきってから断らない）。
 * ヘッダが無い・偽っている本文は、読みながら数えて切る。
 *
 * @param request 受信したリクエスト
 * @param limit 受け付ける最大バイト数
 * @returns バイト列、または理由
 */
async function readLimitedBytes(request: Request, limit: number): Promise<BytesReadResult> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, reason: 'body-too-large' };
  }
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false, reason: 'body-too-large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    // **本文はログへ出さない**（録画の中身である）。
    console.error(`[trial-recording] 本文を読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return { ok: false, reason: 'unreadable-body' };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

/**
 * 断片を、その鍵がまだ無いときだけ R2 へ書く（`If-None-Match: *`）。
 *
 * **条件つきの書き込みが例外になっても、条件なしで書き直さない**——同じ番号が同時に 2 度届いていると、先に
 * 書かれた断片を置き換えうる。例外は呼ぶ側で 500 になり、ブラウザが同じ番号を送り直す。
 *
 * @param env バインディングと環境変数
 * @param key 鍵
 * @param bytes 中身
 * @param container 入れ物
 * @returns 書いたオブジェクト（既に在って書かなかったら null）
 */
async function putChunkIfAbsent(
  env: Env,
  key: string,
  bytes: Uint8Array,
  container: TrialRecordingRow['container'],
): Promise<R2Object | null> {
  return await env.TRIAL_RECORDINGS.put(key, bytes, {
    httpMetadata: { contentType: container === 'mp4' ? 'video/mp4' : 'video/webm' },
    onlyIf: new Headers({ 'if-none-match': '*' }),
  });
}

/**
 * 録画を始める（`POST /api/trial/recording/start`）。
 *
 * 本文: `{ "mimeType": "video/webm;codecs=vp9,opus", "displaySurface": "browser" }`。
 * 応答: `201 { ok: true, recordingId, chunkMs, maxSeconds, maxChunkBytes, videoBitsPerSecond, audioBitsPerSecond }`。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleStart(request: Request, env: Env, now: () => number): Promise<Response> {
  const access = await resolveRecordingAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  if (!canStartTrialRecording(access.row.stage)) {
    return reject('stage', 409, { stage: access.row.stage });
  }
  const body = await readJsonBody(request);
  if (body === null) {
    return reject('invalid-request', 400);
  }
  const format = parseRecordingMimeType(body['mimeType']);
  if (format === null) {
    return reject('unsupported-format', 400);
  }
  const recordingId = crypto.randomUUID();
  try {
    const created = await createTrialRecording(env.DB, {
      id: recordingId,
      userId: access.userId,
      startedAt: now(),
      mimeType: format.mimeType,
      container: format.container,
      browser: detectTrialBrowser(request.headers.get('user-agent')),
      displaySurface: parseDisplaySurface(body['displaySurface']),
    });
    if (!created) {
      return reject('too-many-recordings', 409);
    }
  } catch (error) {
    console.error(`[trial-recording] 録画を始められませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return reject('storage-failed', 500);
  }
  return json(
    {
      ok: true,
      recordingId,
      chunkMs: TRIAL_RECORDING_CHUNK_MS,
      maxSeconds: TRIAL_RECORDING_MAX_SECONDS,
      maxChunkBytes: TRIAL_RECORDING_MAX_CHUNK_BYTES,
      videoBitsPerSecond: TRIAL_RECORDING_VIDEO_BPS,
      audioBitsPerSecond: TRIAL_RECORDING_AUDIO_BPS,
    },
    201,
  );
}

/**
 * 断片を 1 つ受け取る（`POST /api/trial/recording/chunk?recording=<id>&seq=<n>`）。
 *
 * 応答: `200 { ok: true, nextSeq }`（受け取り済みの番号なら `duplicate: true` も付ける）。
 * 断りは `{ ok: false, error, nextSeq? }`。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleChunk(request: Request, env: Env, now: () => number): Promise<Response> {
  const access = await resolveRecordingAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  if (!canSendTrialRecordingChunk(access.row.stage)) {
    return reject('stage', 409, { stage: access.row.stage });
  }
  const url = new URL(request.url);
  const recordingId = url.searchParams.get(TRIAL_RECORDING_ID_PARAM) ?? '';
  const seq = parseChunkSeq(url.searchParams.get(TRIAL_RECORDING_SEQ_PARAM));
  if (!isTrialRecordingId(recordingId)) {
    return reject('invalid-request', 400);
  }
  const recording = await findTrialRecording(env.DB, access.userId, recordingId);
  if (recording === null) {
    return reject('recording-not-found', 404);
  }
  if (seq === null) {
    // 形の読めない番号と、上限を超えた番号（60 分を超えた）を分ける。
    const raw = url.searchParams.get(TRIAL_RECORDING_SEQ_PARAM) ?? '';
    return /^[1-9]\d*$/u.test(raw) ? reject('too-long', 409) : reject('invalid-request', 400);
  }
  if (seq < recording.next_seq) {
    return json({ ok: true, duplicate: true, nextSeq: recording.next_seq });
  }
  if (seq > recording.next_seq) {
    return reject('gap', 409, { nextSeq: recording.next_seq });
  }
  const at = now();
  if (at > recording.started_at + TRIAL_RECORDING_ACCEPT_SECONDS) {
    return reject('too-long', 409);
  }
  const read = await readLimitedBytes(request, TRIAL_RECORDING_MAX_CHUNK_BYTES);
  if (!read.ok) {
    return read.reason === 'body-too-large' ? reject('chunk-too-large', 413) : reject('invalid-request', 400);
  }
  if (read.bytes.byteLength === 0) {
    return reject('empty-chunk', 400);
  }
  if (recording.total_bytes + read.bytes.byteLength > TRIAL_RECORDING_MAX_BYTES) {
    return reject('recording-too-large', 413);
  }
  try {
    const recorded = await trialRecordedBytes(env.DB, access.userId);
    if (recorded + read.bytes.byteLength > TRIAL_RECORDING_MAX_PARTICIPANT_BYTES) {
      return reject('recording-too-large', 413);
    }
    const key = trialRecordingChunkKey(access.userId, recordingId, seq);
    // **無いときだけ書く**（`If-None-Match: *`）。同じ番号が同時に 2 度届いても、先に書いた断片を後から
    // 別の中身で置き換えさせない。在れば、在るほうを正として目録を進める（前の試みが R2 に書けて目録で
    // 落ちた・同じ番号が同時に届いた、のどちらか）。
    const written = await putChunkIfAbsent(env, key, read.bytes, recording.container);
    let size = read.bytes.byteLength;
    if (written === null) {
      const existing = await env.TRIAL_RECORDINGS.head(key);
      if (existing === null) {
        return reject('storage-failed', 500);
      }
      size = existing.size;
    }
    const committed = await commitTrialRecordingChunk(env.DB, {
      userId: access.userId,
      recordingId,
      seq,
      bytes: size,
      now: at,
    });
    if (!committed) {
      // 同じ番号が同時に 2 度届いた（片方が先に進めた）か、合計の上限に触れた。読み直して分ける。
      const again = await findTrialRecording(env.DB, access.userId, recordingId);
      if (again !== null && again.next_seq > seq) {
        return json({ ok: true, duplicate: true, nextSeq: again.next_seq });
      }
      return reject('recording-too-large', 413);
    }
  } catch (error) {
    // **鍵（利用者の id を含む）も本文もログへ出さない。**
    console.error(`[trial-recording] 断片を書けませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return reject('storage-failed', 500);
  }
  return json({ ok: true, nextSeq: seq + 1 });
}

/**
 * 録画が止まったことを残す（`POST /api/trial/recording/stop`）。
 *
 * 本文: `{ "recordingId": "...", "reason": "share-ended" }`。止まった後に届いた 2 度目の知らせは書き換えない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleStop(request: Request, env: Env, now: () => number): Promise<Response> {
  const access = await resolveRecordingAccess(request, env);
  if (!access.ok) {
    return access.response;
  }
  const body = await readJsonBody(request);
  const recordingId = body?.['recordingId'];
  const reason = body?.['reason'];
  if (
    typeof recordingId !== 'string' ||
    !isTrialRecordingId(recordingId) ||
    typeof reason !== 'string' ||
    !(TRIAL_RECORDING_END_REASONS as readonly string[]).includes(reason)
  ) {
    return reject('invalid-request', 400);
  }
  try {
    const recording = await findTrialRecording(env.DB, access.userId, recordingId);
    if (recording === null) {
      return reject('recording-not-found', 404);
    }
    await endTrialRecording(env.DB, access.userId, recordingId, reason as TrialRecordingEndReason, now());
  } catch (error) {
    console.error(`[trial-recording] 止まったことを残せませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return reject('storage-failed', 500);
  }
  return json({ ok: true });
}

/**
 * 録画の部分（断片 {@link TRIAL_RECORDING_PART_CHUNKS} 個ぶん）を、連番の順につないだ 1 本の流れにする（管理画面）。
 *
 * **WebM も MP4（MediaRecorder の断片化 MP4）も、1 回の録画の断片を頭から順につなげば再生できる**——先頭の断片が
 * 入れ物の頭（WebM の EBML と Segment、MP4 の ftyp と moov）を持ち、続きはその続きだからである
 * （`scripts/check-trial-recording-browser.sh` が Chromium の WebM をつないで再生できることを確かめる）。
 * 部分を順に取って同じ順に並べれば、1 本に戻る。
 *
 * **断片が 1 つでも欠けていたら、流れを途中で壊す**（黙って飛ばすと、つないだ録画が途中から再生できない）。
 *
 * @param env バインディングと環境変数
 * @param recording 録画の目録の行
 * @param part 部分の番号（0 から）
 * @returns 流れ（部分の番号が範囲の外なら null）
 */
export function streamTrialRecordingPart(
  env: Env,
  recording: TrialRecordingRow,
  part: number,
): ReadableStream<Uint8Array> | null {
  if (!Number.isInteger(part) || part < 0 || part >= trialRecordingPartCount(recording.next_seq)) {
    return null;
  }
  const first = part * TRIAL_RECORDING_PART_CHUNKS;
  const last = Math.min(first + TRIAL_RECORDING_PART_CHUNKS, recording.next_seq);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const pump = async (): Promise<void> => {
    try {
      for (let seq = first; seq < last; seq += 1) {
        const object = await env.TRIAL_RECORDINGS.get(trialRecordingChunkKey(recording.user_id, recording.id, seq));
        if (object === null) {
          throw new Error(`missing chunk ${seq}`);
        }
        await object.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (error) {
      console.error(`[trial-recording] 録画の部分を返せませんでした: ${error instanceof Error ? error.message : 'unknown'}`);
      await writable.abort(error).catch(() => undefined);
    }
  };
  void pump();
  return readable;
}

/**
 * 1 回の呼び出しで読む R2 の一覧の上限（ページ数）。1 ページ 1,000 個なので 20 ページで 20,000 個——1 人の上限
 * （10 本 × 744 個）を収め、一覧と削除を合わせてもサブリクエストの上限（50）に収まる。
 */
const R2_DELETE_MAX_PAGES = 20;

/**
 * 利用者の録画をすべて消す（R2 の `trial/<利用者>/` の下をすべて消してから、目録の行を消す。管理画面）。
 *
 * **消す鍵は R2 の一覧から取る**（目録から導かない）。目録の行が先に消えた断片（後片付けの順序・目録で落ちた
 * 書き込み）も残さない。1 ページ（最大 1,000 個）ずつ一覧して、そのまま消す。**一覧を読み切れなかったら
 * 目録を消さない**（消し損ねた録画を一覧から辿れなくしない。もう一度押せば続きから消える）。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @returns 消した録画の本数と断片の数、読み切れずに残ったか
 */
export async function deleteTrialRecordingsOf(
  env: Env,
  userId: string,
): Promise<{ readonly recordings: number; readonly objects: number; readonly remaining: boolean }> {
  const prefix = `${TRIAL_RECORDING_KEY_PREFIX}${userId}/`;
  let objects = 0;
  let cursor: string | undefined;
  for (let page = 0; page < R2_DELETE_MAX_PAGES; page += 1) {
    const listed = await env.TRIAL_RECORDINGS.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await env.TRIAL_RECORDINGS.delete(listed.objects.map((object) => object.key));
      objects += listed.objects.length;
    }
    if (!listed.truncated) {
      const recordings = await deleteTrialRecordingRows(env.DB, userId);
      return { recordings, objects, remaining: false };
    }
    cursor = listed.cursor;
  }
  return { recordings: 0, objects, remaining: true };
}

/**
 * 録画の口を組み立てる（時刻を差し替えられるのはここだけ）。
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createTrialRecordingRoutes(options: { readonly now?: () => number } = {}): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return [
    { method: 'POST', path: TRIAL_RECORDING_START_API_PATH, handler: (request, env) => handleStart(request, env, now) },
    { method: 'POST', path: TRIAL_RECORDING_CHUNK_API_PATH, handler: (request, env) => handleChunk(request, env, now) },
    { method: 'POST', path: TRIAL_RECORDING_STOP_API_PATH, handler: (request, env) => handleStop(request, env, now) },
  ];
}
