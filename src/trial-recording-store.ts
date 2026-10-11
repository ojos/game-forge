/**
 * 試用の録画（#978）の決めごとと、D1 の目録（`trial_recordings`。`migrations/0054_trial_recordings.sql`）の読み書き。
 *
 * **このモジュールは画面も R2 も知らない。** 上限・形式の判定・ブラウザの判定・断片の鍵の綴りと、D1 の
 * 読み書きだけを持つ。口（R2 へ書く・管理画面へ返す）は `src/trial-recording.ts`、ブラウザで動く部分は
 * `src/trial-recorder-script.ts` が持つ。後片付けの Worker が {@link sweepExpiredTrialRecordings} を読むので
 * （`src/trial-store.ts` 経由）、HTML や経路表を import しない。
 *
 * ## 上限
 *
 * 断片は 5 秒ごと（{@link TRIAL_RECORDING_CHUNK_MS}）。1 本は 60 分まで（{@link TRIAL_RECORDING_MAX_SECONDS}）。
 * 大きさは 1 回・1 本・1 人の 3 段で縛る。**ブラウザに渡す目安の速さ（映像 1.5 Mbps・声 64 kbps）なら、
 * 5 秒で約 1 MB・60 分で約 700 MB**で、上限はその 2〜3 倍に置いた（Safari が目安を守らないことがあるため）。
 */
import type { TrialStage } from './trial-store.js';

/** 断片を切り出す間隔（ミリ秒）。MediaRecorder の `start(timeslice)` に渡す。 */
export const TRIAL_RECORDING_CHUNK_MS = 5_000;

/** 1 本の録画の長さの上限（秒）。ブラウザはここで録画を止め、口は次の 2 つで縛る。 */
export const TRIAL_RECORDING_MAX_SECONDS = 60 * 60;

/**
 * 1 本で受け取る断片の数の上限。
 *
 * 60 分 ÷ 5 秒 = 720 に、止めたときの最後の断片と、ブラウザの切り出しの揺れの分を足した。
 */
export const TRIAL_RECORDING_MAX_CHUNKS = (TRIAL_RECORDING_MAX_SECONDS * 1000) / TRIAL_RECORDING_CHUNK_MS + 24;

/**
 * 録画を始めてから断片を受け取る時間の上限（秒）。60 分に、送り直しの猶予（15 分）を足した。
 *
 * **猶予を過ぎて届いた断片は断る**（通信が長く切れていた分は失う）。始めた時刻から数えるので、
 * 止まらないままの録画が何時間も書き続けることはない。
 */
export const TRIAL_RECORDING_ACCEPT_SECONDS = TRIAL_RECORDING_MAX_SECONDS + 15 * 60;

/** 断片 1 つの大きさの上限（バイト。8 MiB）。 */
export const TRIAL_RECORDING_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** 1 本の録画の大きさの上限（バイト。2 GiB）。 */
export const TRIAL_RECORDING_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** 1 人の録画の大きさの合計の上限（バイト。4 GiB）。 */
export const TRIAL_RECORDING_MAX_PARTICIPANT_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * 1 人が始められる録画の本数の上限。
 *
 * 共有を止めて録り直す・ページを読み込み直すと 1 本増える。10 本あれば足り、それ以上は誤った繰り返しである。
 */
export const TRIAL_RECORDING_MAX_PER_PARTICIPANT = 10;

/** ブラウザに渡す映像の目安の速さ（bps）。 */
export const TRIAL_RECORDING_VIDEO_BPS = 1_500_000;

/** ブラウザに渡す声の目安の速さ（bps）。 */
export const TRIAL_RECORDING_AUDIO_BPS = 64_000;

/**
 * 管理画面の口が 1 回で返す断片の数。
 *
 * **R2 を読む回数を 1 回の呼び出しの上限（サブリクエスト 50）の下に収める**——権限の確認と目録の読みで
 * D1 を数回使うので、断片は 40 にした。管理画面のスクリプトが部分を順に取り、ブラウザの中で 1 本につなぐ。
 */
export const TRIAL_RECORDING_PART_CHUNKS = 40;

/**
 * R2 のライフサイクルが、期限を過ぎてから実際に消すまでの遅れ（日。最大でおよそ 1 日）。
 *
 * **バケットの規則は 90 日からこの日数を引いて置き**（terraform/trial-recordings.tf。同意の文面の 90 日を超えない）、
 * **目録はこの日数を足して消す**（{@link sweepExpiredTrialRecordings}。目録を断片より後まで残し、頼まれて消すときに
 * 管理画面が録画を見つけられるようにする）。
 */
export const TRIAL_RECORDING_LIFECYCLE_LAG_DAYS = 1;

/** 断片を置く鍵の接頭辞。 */
export const TRIAL_RECORDING_KEY_PREFIX = 'trial/';

/** 録画に対応するブラウザ。 */
export const TRIAL_BROWSERS = ['chrome', 'edge', 'safari', 'firefox'] as const;

/** 録画に対応するブラウザ。 */
export type TrialBrowser = (typeof TRIAL_BROWSERS)[number];

/** 録画をつないだときの入れ物。 */
export type TrialRecordingContainer = 'webm' | 'mp4';

/** 取り込んだ面（`MediaTrackSettings.displaySurface`）。 */
export type TrialDisplaySurface = 'browser' | 'window' | 'monitor';

/** 録画が止まった理由。 */
export const TRIAL_RECORDING_END_REASONS = ['finished', 'share-ended', 'time-limit', 'error'] as const;

/** 録画が止まった理由。 */
export type TrialRecordingEndReason = (typeof TRIAL_RECORDING_END_REASONS)[number];

/**
 * User-Agent から、録画に対応するブラウザを判定する。
 *
 * **4 つ（Chrome・Edge・Safari・Firefox）以外は null**——Opera・Samsung Internet・Yandex・Vivaldi など、
 * Chromium を土台にしていても名乗りを足しているものは外す（試していない）。Brave は Chrome と同じ名乗りなので
 * Chrome に入る。**ここで通っても、録画の機能があるかはブラウザの中で確かめる**（`src/trial-recorder-script.ts`）。
 *
 * @param userAgent `User-Agent` ヘッダの値
 * @returns ブラウザ（対応しなければ null）
 */
export function detectTrialBrowser(userAgent: string | null): TrialBrowser | null {
  if (userAgent === null || userAgent === '') {
    return null;
  }
  if (/\b(?:OPR|Opera|SamsungBrowser|YaBrowser|Vivaldi|UCBrowser|Whale|SeaMonkey)\//u.test(userAgent)) {
    return null;
  }
  if (/\bEdg\//u.test(userAgent)) {
    return 'edge';
  }
  if (/\bFirefox\//u.test(userAgent)) {
    return 'firefox';
  }
  if (/\b(?:Chrome|Chromium)\//u.test(userAgent)) {
    return 'chrome';
  }
  if (/\bVersion\/[\d.]+.*\bSafari\//u.test(userAgent)) {
    return 'safari';
  }
  return null;
}

/**
 * 録画の形式の候補（先頭ほど優先）。ブラウザは `MediaRecorder.isTypeSupported` で最初に通ったものを使う。
 *
 * **Safari は MP4 を先にする**——Safari 18.4 からは WebM も録れるが、それより前の Safari と同じ形で残すほうが
 * 確かめた形（MP4 の断片を順につなぐ）から外れない。ほかは WebM を先にする。
 *
 * @param browser ブラウザ
 * @returns 候補
 */
export function recordingMimeCandidates(browser: TrialBrowser): readonly string[] {
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mp4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  return browser === 'safari' ? [...mp4, ...webm] : [...webm, ...mp4];
}

/**
 * 候補のうち、ブラウザが録れる最初の形式を選ぶ（ブラウザの中の選び方と同じ。テストのための写しではなく、
 * ブラウザの中のスクリプトがこの関数の結果と同じになることを実ブラウザの検査が見る）。
 *
 * @param candidates 候補（{@link recordingMimeCandidates}）
 * @param isSupported 録れるかを返す関数（ブラウザでは `MediaRecorder.isTypeSupported`）
 * @returns 形式（どれも録れなければ null）
 */
export function pickRecordingMimeType(
  candidates: readonly string[],
  isSupported: (mimeType: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    if (isSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 受け取った形式の判定の結果。 */
export interface ParsedRecordingMimeType {
  readonly mimeType: string;
  readonly container: TrialRecordingContainer;
}

/**
 * ブラウザが送ってきた形式を判定する（`video/webm` か `video/mp4` で始まるものだけを受け付ける）。
 *
 * **綴りの細部（codecs の書き方）はブラウザに任せる**——MediaRecorder が返す `mimeType` は、渡した文字列と
 * 違う綴り（引用符・空白・大文字）で返ることがある。入れ物だけを決め、残りは記録として残す。
 * 長さと文字を絞るのは、目録と管理画面に出す値だからである。
 *
 * @param raw 送られた値（未検査）
 * @returns 形式と入れ物（受け付けなければ null）
 */
export function parseRecordingMimeType(raw: unknown): ParsedRecordingMimeType | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const mimeType = raw.trim().toLowerCase();
  if (mimeType.length === 0 || mimeType.length > 120 || !/^[a-z0-9/;=,.+\- "]+$/u.test(mimeType)) {
    return null;
  }
  const base = mimeType.split(';')[0]!.trim();
  if (base === 'video/webm') {
    return { mimeType, container: 'webm' };
  }
  if (base === 'video/mp4') {
    return { mimeType, container: 'mp4' };
  }
  return null;
}

/**
 * 取り込んだ面を判定する（分からない値は null）。
 *
 * @param raw 送られた値（未検査）
 * @returns 面
 */
export function parseDisplaySurface(raw: unknown): TrialDisplaySurface | null {
  return raw === 'browser' || raw === 'window' || raw === 'monitor' ? raw : null;
}

/**
 * 録画の id の形（`crypto.randomUUID()` の小文字の UUID）か。
 *
 * @param value 調べる値
 * @returns 形が合えば true
 */
export function isTrialRecordingId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

/**
 * 断片の連番を読む（0 以上 {@link TRIAL_RECORDING_MAX_CHUNKS} 未満の、先頭に 0 の無い 10 進の整数だけ）。
 *
 * @param raw 問い合わせの値
 * @returns 連番（読めなければ null）
 */
export function parseChunkSeq(raw: string | null): number | null {
  if (raw === null || !/^(?:0|[1-9]\d{0,5})$/u.test(raw)) {
    return null;
  }
  const seq = Number(raw);
  return seq < TRIAL_RECORDING_MAX_CHUNKS ? seq : null;
}

/**
 * 断片を置く鍵（`trial/<利用者の id>/<録画の id>/<連番 6 桁>`）。
 *
 * **連番を 6 桁の 0 埋めにする**——R2 の一覧は鍵の辞書順で返るので、桁を揃えると一覧の順が録画の順になる。
 *
 * @param userId 利用者の id
 * @param recordingId 録画の id
 * @param seq 連番
 * @returns 鍵
 */
export function trialRecordingChunkKey(userId: string, recordingId: string, seq: number): string {
  return `${TRIAL_RECORDING_KEY_PREFIX}${userId}/${recordingId}/${String(seq).padStart(6, '0')}`;
}

/**
 * 断片の数から、管理画面の口が返す部分の数を求める。
 *
 * @param chunkCount 受け取った断片の数（`next_seq`）
 * @returns 部分の数
 */
export function trialRecordingPartCount(chunkCount: number): number {
  return Math.ceil(chunkCount / TRIAL_RECORDING_PART_CHUNKS);
}

/** 録画を始められる段（録画の準備〜振り返り 5）。 */
const START_STAGES: ReadonlySet<TrialStage> = new Set(['recording', 'explore', 'q1', 'q2', 'q3', 'q4', 'q5']);

/** 断片を受け取る段（録画の準備〜アンケート。アンケートの段では、止めた後の残りを受け取る）。 */
const CHUNK_STAGES: ReadonlySet<TrialStage> = new Set([...START_STAGES, 'survey']);

/**
 * いまの段で録画を始められるか。
 *
 * @param stage いまの段
 * @returns 始められれば true
 */
export function canStartTrialRecording(stage: TrialStage): boolean {
  return START_STAGES.has(stage);
}

/**
 * いまの段で断片を受け取るか。
 *
 * @param stage いまの段
 * @returns 受け取るなら true
 */
export function canSendTrialRecordingChunk(stage: TrialStage): boolean {
  return CHUNK_STAGES.has(stage);
}

/**
 * いまの段の画面で録画を続けるか（録画の準備〜振り返り 5。アンケートの段に入ったら止める）。
 *
 * @param stage いまの段
 * @returns 続けるなら true
 */
export function isTrialRecordingStage(stage: TrialStage): boolean {
  return START_STAGES.has(stage);
}

/** 録画の目録の行。 */
export interface TrialRecordingRow {
  readonly id: string;
  readonly user_id: string;
  readonly started_at: number;
  readonly mime_type: string;
  readonly container: TrialRecordingContainer;
  readonly browser: string | null;
  readonly display_surface: string | null;
  readonly next_seq: number;
  readonly total_bytes: number;
  readonly last_chunk_at: number | null;
  readonly ended_at: number | null;
  readonly end_reason: TrialRecordingEndReason | null;
}

/** 行を引くときの列。 */
const RECORDING_COLUMNS = `id, user_id, started_at, mime_type, container, browser, display_surface,
       next_seq, total_bytes, last_chunk_at, ended_at, end_reason`;

/** 録画を始めるときに残すもの。 */
export interface TrialRecordingStart {
  readonly id: string;
  readonly userId: string;
  readonly startedAt: number;
  readonly mimeType: string;
  readonly container: TrialRecordingContainer;
  readonly browser: TrialBrowser | null;
  readonly displaySurface: TrialDisplaySurface | null;
}

/**
 * 録画の目録に 1 行足す（**1 人の本数が上限に満たないときだけ**。条件付き INSERT 1 文）。
 *
 * @param db D1
 * @param start 残すもの
 * @returns 足したら true（上限に達していたら false）
 */
export async function createTrialRecording(db: D1Database, start: TrialRecordingStart): Promise<boolean> {
  const result = await db
    .prepare(
      `insert into trial_recordings (id, user_id, started_at, mime_type, container, browser, display_surface)
       select ?, ?, ?, ?, ?, ?, ?
        where (select count(*) from trial_recordings where user_id = ?) < ?`,
    )
    .bind(
      start.id,
      start.userId,
      start.startedAt,
      start.mimeType,
      start.container,
      start.browser,
      start.displaySurface,
      start.userId,
      TRIAL_RECORDING_MAX_PER_PARTICIPANT,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 利用者の録画を 1 本引く（**利用者と id の両方が合うときだけ**。他人の録画の id を知っていても引けない）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param recordingId 録画の id
 * @returns 行（無ければ null）
 */
export async function findTrialRecording(
  db: D1Database,
  userId: string,
  recordingId: string,
): Promise<TrialRecordingRow | null> {
  return await db
    .prepare(`select ${RECORDING_COLUMNS} from trial_recordings where id = ? and user_id = ?`)
    .bind(recordingId, userId)
    .first<TrialRecordingRow>();
}

/**
 * 録画を id だけで引く（管理画面）。
 *
 * @param db D1
 * @param recordingId 録画の id
 * @returns 行（無ければ null）
 */
export async function findTrialRecordingById(db: D1Database, recordingId: string): Promise<TrialRecordingRow | null> {
  return await db
    .prepare(`select ${RECORDING_COLUMNS} from trial_recordings where id = ?`)
    .bind(recordingId)
    .first<TrialRecordingRow>();
}

/**
 * 利用者の録画の大きさの合計（バイト）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @returns 合計
 */
export async function trialRecordedBytes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('select coalesce(sum(total_bytes), 0) as total from trial_recordings where user_id = ?')
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** 断片を受け取ったことを目録へ書くときの値。 */
export interface TrialRecordingChunkCommit {
  readonly userId: string;
  readonly recordingId: string;
  readonly seq: number;
  readonly bytes: number;
  readonly now: number;
}

/**
 * 断片を受け取ったことを目録へ書く（**`next_seq` が `seq` のときだけ 1 つ進める**。条件付き UPDATE 1 文）。
 *
 * 1 本と 1 人の大きさの上限もこの文の条件に入れる——口が先に確かめているが、2 本の録画が同時に書くと、
 * 読んでから書くまでの間に合計が上限を超えうる。
 *
 * @param db D1
 * @param commit 書く値
 * @returns 書いたら true（`next_seq` が違った・上限を超えたら false）
 */
export async function commitTrialRecordingChunk(db: D1Database, commit: TrialRecordingChunkCommit): Promise<boolean> {
  const result = await db
    .prepare(
      `update trial_recordings
          set next_seq = next_seq + 1, total_bytes = total_bytes + ?, last_chunk_at = ?
        where id = ? and user_id = ? and next_seq = ?
          and total_bytes + ? <= ?
          and (select coalesce(sum(total_bytes), 0) from trial_recordings where user_id = ?) + ? <= ?`,
    )
    .bind(
      commit.bytes,
      commit.now,
      commit.recordingId,
      commit.userId,
      commit.seq,
      commit.bytes,
      TRIAL_RECORDING_MAX_BYTES,
      commit.userId,
      commit.bytes,
      TRIAL_RECORDING_MAX_PARTICIPANT_BYTES,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 録画が止まったことを書く（**最初の 1 回だけ**。止まった後に届いた知らせは書き換えない）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param recordingId 録画の id
 * @param reason 理由
 * @param now 時刻（UNIX 秒）
 * @returns 書いたら true
 */
export async function endTrialRecording(
  db: D1Database,
  userId: string,
  recordingId: string,
  reason: TrialRecordingEndReason,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `update trial_recordings set ended_at = ?, end_reason = ?
        where id = ? and user_id = ? and ended_at is null`,
    )
    .bind(now, reason, recordingId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 試用者の録画を、始めた順に引く（管理画面）。
 *
 * @param db D1
 * @param userIds 試用者の id
 * @returns 試用者の id → 録画の行（始めた順）
 */
export async function listTrialRecordings(
  db: D1Database,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, readonly TrialRecordingRow[]>> {
  const byUser = new Map<string, TrialRecordingRow[]>();
  if (userIds.length === 0) {
    return byUser;
  }
  const placeholders = userIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `select ${RECORDING_COLUMNS} from trial_recordings
        where user_id in (${placeholders})
        order by started_at asc, id asc`,
    )
    .bind(...userIds)
    .all<TrialRecordingRow>();
  for (const row of result.results) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
}

/**
 * 試用者の印が無い（印を消した）利用者の録画を引く（管理画面。始めた順）。
 *
 * **印を先に消すと、録画は試用者の一覧から辿れなくなる**（一覧は印から引く）。断片は R2 に残るので、
 * 管理画面が別に並べて、消せるようにする。
 *
 * @param db D1
 * @param limit 取得件数の上限
 * @returns 利用者の id → 録画の行
 */
export async function listOrphanTrialRecordings(
  db: D1Database,
  limit: number,
): Promise<ReadonlyMap<string, readonly TrialRecordingRow[]>> {
  const result = await db
    .prepare(
      `select ${RECORDING_COLUMNS} from trial_recordings
        where user_id not in (select user_id from trial_participants)
        order by started_at asc, id asc
        limit ?`,
    )
    .bind(limit)
    .all<TrialRecordingRow>();
  const byUser = new Map<string, TrialRecordingRow[]>();
  for (const row of result.results) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  return byUser;
}

/**
 * 利用者の録画の目録の行をすべて消す（断片を消した後に呼ぶ）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @returns 消した行数
 */
export async function deleteTrialRecordingRows(db: D1Database, userId: string): Promise<number> {
  const result = await db.prepare('delete from trial_recordings where user_id = ?').bind(userId).run();
  return result.meta.changes ?? 0;
}

/**
 * 始めてから `retentionDays` 日＋{@link TRIAL_RECORDING_LIFECYCLE_LAG_DAYS} 日を過ぎた録画の目録を消す
 * （`src/trial-store.ts` の後片付けが呼ぶ）。
 *
 * **断片そのものは R2 のライフサイクルが、置いてから `retentionDays − 遅れ` 日で消す**（terraform/trial-recordings.tf）。
 * 断片は始めてから 60 分＋猶予のうちに置かれるので、目録は断片が消えた後に消える。
 *
 * @param db D1
 * @param now 時刻（UNIX 秒）
 * @param retentionDays 残す日数（同意の文面の日数）
 * @returns 消した行数
 */
export async function sweepExpiredTrialRecordings(db: D1Database, now: number, retentionDays: number): Promise<number> {
  const cutoff = now - (retentionDays + TRIAL_RECORDING_LIFECYCLE_LAG_DAYS) * 24 * 60 * 60;
  const result = await db.prepare('delete from trial_recordings where started_at < ?').bind(cutoff).run();
  return result.meta.changes ?? 0;
}
