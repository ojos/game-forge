/**
 * 試用者の一覧（`/trials`。#977）——試用者ごとの段の時刻・同意・アンケートの答えを読む。
 *
 * **ほぼ読むだけの画面である。** 印を付ける・記録を消すのは D1 への直接の SQL で行う（`docs/user-trial.md`）。
 * **例外は録画を消す口だけ**（#978）——録画の断片は R2 にあり、SQL では消せない。試用者に頼まれたときに、
 * 試用者 1 人の録画をすべて消す（{@link ADMIN_TRIAL_RECORDINGS_DELETE_PATH}）。**印を消す前に押す**（印を先に
 * 消した録画も「印の無い試用者の録画」として並べ、消せるようにしてある）。
 *
 * **録画（#978）は、断片をつないだ 1 本として落とせる。** 口（{@link ADMIN_TRIAL_RECORDING_PATH}）は断片を
 * 40 個ずつつないだ「部分」を返し、この画面のスクリプトが部分を順に取ってブラウザの中で 1 本につなぐ
 * （1 回の呼び出しで R2 を読める回数に上限があるため。`src/trial-recording-store.ts` の `TRIAL_RECORDING_PART_CHUNKS`）。
 * 運営は数人の試用者のために口を足すより、手順で足りる（`is_operator` の付け外しを画面に置かないのと同じ向き。
 * `src/admin/users.ts`）。
 *
 * **時刻は秒まで出す。** 振り返りの各問を出した時刻は、録画と突き合わせるために残している（#977）。分で
 * 丸めると、同じ分の中の 2 問を見分けられない。
 *
 * **権限はここで確かめない**（`src/admin/routes.ts` の `handleAdminRequest` が守る。既定は「閉」）。
 */
import { ADMIN_TRIALS_PATH } from '../admin-paths.js';
import { escapeHtml } from '../html.js';
import { toIsoTimestamp } from '../jst.js';
import type { Route } from '../routes.js';
import { html, readLimitedText } from '../routes.js';
import {
  ADMIN_TRIAL_RECORDINGS_DELETE_PATH,
  ADMIN_TRIAL_RECORDING_PATH,
  TRIAL_RECORDING_DELETED_QUERY,
  TRIAL_RECORDING_DELETE_CONFIRM_FIELD,
  TRIAL_RECORDING_DELETE_CONFIRM_VALUE,
  TRIAL_RECORDING_ID_PARAM,
  TRIAL_RECORDING_PART_PARAM,
  TRIAL_RECORDING_USER_FIELD,
} from '../trial-paths.js';
import { deleteTrialRecordingsOf, streamTrialRecordingPart } from '../trial-recording.js';
import type { TrialRecordingEndReason, TrialRecordingRow } from '../trial-recording-store.js';
import {
  findTrialRecordingById,
  isTrialRecordingId,
  listOrphanTrialRecordings,
  listTrialRecordings,
  trialRecordingPartCount,
} from '../trial-recording-store.js';
import type { TrialParticipantListRow, TrialStage } from '../trial-store.js';
import { TRIAL_RETENTION_DAYS, listTrialParticipants } from '../trial-store.js';
import { ADMIN_LIST_LIMIT } from './actions.js';
import { adminFooter, adminHead } from './shell.js';

/** 段の札（管理画面の表示だけに使う）。 */
const STAGE_LABELS: Readonly<Record<TrialStage, string>> = {
  consent: '同意の前',
  recording: '録画の準備',
  explore: '自由に触っている',
  q1: '振り返り 1',
  q2: '振り返り 2',
  q3: '振り返り 3',
  q4: '振り返り 4',
  q5: '振り返り 5',
  survey: 'アンケート',
  done: '完了',
};

/** 日本時間の時差（秒）。 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/**
 * UNIX 秒を日本時間の `YYYY-MM-DD HH:MM:SS` にする（`src/jst.ts` の `formatJstMinutes` の秒まで版）。
 *
 * @param epochSeconds UNIX 秒
 * @returns 日本時間の表記（読めない値なら空文字）
 */
export function formatJstSeconds(epochSeconds: number): string {
  const date = new Date((epochSeconds + JST_OFFSET_SECONDS) * 1000);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * 時刻を `<time>` で出す（無ければ「—」）。
 *
 * @param epochSeconds UNIX 秒（無ければ null）
 * @returns HTML
 */
function timeCell(epochSeconds: number | null): string {
  if (epochSeconds === null) {
    return '—';
  }
  const iso = toIsoTimestamp(epochSeconds);
  const text = formatJstSeconds(epochSeconds);
  return iso === '' || text === '' ? '不明' : `<time datetime="${iso}">${escapeHtml(text)}</time>`;
}

/**
 * アンケートの答えを出す（エスケープし、改行を残す）。
 *
 * @param value 答え（無ければ null）
 * @returns HTML
 */
function answerCell(value: string | null): string {
  if (value === null || value === '') {
    return '—';
  }
  return escapeHtml(value).replaceAll('\n', '<br>');
}

/** 録画が止まった理由の札。 */
const END_REASON_LABELS: Readonly<Record<TrialRecordingEndReason, string>> = {
  finished: 'アンケートへ進んで止めた',
  'share-ended': '試用者が共有を止めた',
  'time-limit': '60 分に達して止めた',
  error: 'ブラウザの録画が止まった・送れなかった',
};

/**
 * 録画 1 本ぶんを組み立てる。**D1 から来る値（形式・ブラウザ・面）はすべてエスケープする。**
 *
 * @param recording 録画の目録の行
 * @returns HTML
 */
function renderRecording(recording: TrialRecordingRow): string {
  const megabytes = (recording.total_bytes / (1024 * 1024)).toFixed(1);
  const ended =
    recording.ended_at === null
      ? '止まった知らせは届いていない'
      : `${timeCell(recording.ended_at)}（${recording.end_reason === null ? '理由なし' : END_REASON_LABELS[recording.end_reason]}）`;
  const parts = trialRecordingPartCount(recording.next_seq);
  const download =
    parts === 0
      ? '<span class="gf-admin-note">断片が 1 つも届いていません。</span>'
      : `<button type="button" class="gf-button gf-button-secondary" data-trial-download="${escapeHtml(recording.id)}" data-parts="${parts}" data-container="${recording.container}">録画を落とす（${recording.container === 'mp4' ? 'MP4' : 'WebM'}）</button> <span data-trial-download-status></span>`;
  return `    <li data-trial-recording="${escapeHtml(recording.id)}">
      <p>始めた: ${timeCell(recording.started_at)} ／ 断片 ${recording.next_seq} 個・${megabytes} MB ／ 止まった: ${ended}</p>
      <p class="gf-admin-meta">形式: <code>${escapeHtml(recording.mime_type)}</code> ／ ブラウザ: ${escapeHtml(recording.browser ?? '不明')} ／ 取り込んだ面: ${escapeHtml(recording.display_surface ?? '不明')} ／ <code>${escapeHtml(recording.id)}</code></p>
      <p>${download}</p>
    </li>`;
}

/**
 * 1 人ぶんの録画をすべて消すフォーム（試用者に頼まれたとき）。
 *
 * **取り消せないので、確かめのチェックを要る項目にする**（押し間違いで消さない）。
 *
 * @param userId 利用者の id
 * @returns HTML
 */
function renderDeleteForm(userId: string): string {
  const id = escapeHtml(userId);
  return `<form method="post" action="${ADMIN_TRIAL_RECORDINGS_DELETE_PATH}">
    <input type="hidden" name="${TRIAL_RECORDING_USER_FIELD}" value="${id}">
    <label><input type="checkbox" name="${TRIAL_RECORDING_DELETE_CONFIRM_FIELD}" value="${TRIAL_RECORDING_DELETE_CONFIRM_VALUE}" required> 試用者に頼まれたので、この人の録画をすべて消す（取り消せません）</label>
    <button type="submit" class="gf-button gf-button-secondary">この人の録画をすべて消す</button>
  </form>`;
}

/**
 * 1 人ぶんの録画の一覧。
 *
 * @param userId 利用者の id
 * @param recordings 録画の目録の行（始めた順）
 * @returns HTML
 */
function renderRecordings(userId: string, recordings: readonly TrialRecordingRow[]): string {
  if (recordings.length === 0) {
    return '<p>録画: —</p>';
  }
  return `<p>録画（${recordings.length} 本。始めた時刻は振り返りの時刻と同じ時計で、録画の頭にあたる）:</p>
  <ul>
${recordings.map(renderRecording).join('\n')}
  </ul>
  ${renderDeleteForm(userId)}`;
}

/**
 * 印の無い（印を先に消した）試用者の録画。
 *
 * @param orphans 利用者の id → 録画
 * @returns HTML（無ければ空）
 */
function renderOrphans(orphans: ReadonlyMap<string, readonly TrialRecordingRow[]>): string {
  if (orphans.size === 0) {
    return '';
  }
  const items = [...orphans.entries()].map(
    ([userId, recordings]) => `<li class="gf-block gf-admin-row">
  <p class="gf-admin-meta"><code>${escapeHtml(userId)}</code></p>
  ${renderRecordings(userId, recordings)}
</li>`,
  );
  return `<h2>印の無い試用者の録画（${orphans.size} 人）</h2>
<p class="gf-admin-note">印（試用の記録）を先に消した試用者の録画です。録画は置いてから ${TRIAL_RETENTION_DAYS} 日で消えますが、頼まれて消すときはここから消してください。</p>
<ul class="gf-admin-list">
${items.join('\n')}
</ul>`;
}

/**
 * 録画を消した結果の知らせ。
 *
 * @param raw 問い合わせの値
 * @returns HTML（無ければ空）
 */
function renderDeletedNotice(raw: string | null): string {
  if (raw === null) {
    return '';
  }
  if (/^\d+$/u.test(raw)) {
    return `<p class="gf-block" role="status">録画を ${Number(raw)} 本消しました。</p>`;
  }
  return '<p class="gf-block" role="alert">録画を消せませんでした（確かめのチェックが無いか、試用者が分かりません）。</p>';
}

/**
 * 1 人ぶんを組み立てる。**D1 から来る値（表示名・id・答え）はすべてエスケープする。**
 *
 * @param row 試用者の行
 * @param recordings その試用者の録画（始めた順）
 * @returns HTML
 */
function renderParticipant(row: TrialParticipantListRow, recordings: readonly TrialRecordingRow[]): string {
  const chip =
    row.stage === 'done'
      ? `<span class="gf-chip">${STAGE_LABELS[row.stage]}</span>`
      : `<span class="gf-chip gf-chip-emphasis">${STAGE_LABELS[row.stage]}</span>`;
  const times: readonly (readonly [string, number | null])[] = [
    ['印を付けた', row.marked_at],
    ['同意した（録画の準備へ）', row.consented_at],
    ['自由に触る', row.explore_at],
    ['振り返り 1（触り終えた）', row.q1_at],
    ['振り返り 2', row.q2_at],
    ['振り返り 3', row.q3_at],
    ['振り返り 4', row.q4_at],
    ['振り返り 5', row.q5_at],
    ['アンケート', row.survey_at],
    ['完了', row.completed_at],
  ];
  return `<li class="gf-block gf-admin-row">
  <p class="gf-admin-row-head"><span class="gf-admin-row-title">${escapeHtml(row.display_name)}</span> ${chip}</p>
  <p class="gf-admin-meta"><code>${escapeHtml(row.user_id)}</code> ／ 同意の文面の版: ${row.consent_version === null ? '—' : escapeHtml(row.consent_version)}</p>
  <ul>
${times.map(([label, at]) => `    <li>${label}: ${timeCell(at)}</li>`).join('\n')}
  </ul>
  <p>ブラウザ: ${answerCell(row.survey_browser)}</p>
  <p>AI の経験: ${answerCell(row.survey_ai_experience)}</p>
  <p>言い損ねたこと: ${answerCell(row.survey_missed)}</p>
  ${renderRecordings(row.user_id, recordings)}
</li>`;
}

/**
 * 試用者の一覧を返す。
 *
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showTrials(request: Request, env: Env): Promise<Response> {
  const rows = await listTrialParticipants(env.DB, ADMIN_LIST_LIMIT);
  const recordings = await listTrialRecordings(
    env.DB,
    rows.map((row) => row.user_id),
  );
  const orphans = await listOrphanTrialRecordings(env.DB, ADMIN_LIST_LIMIT);
  const deleted = new URL(request.url).searchParams.get(TRIAL_RECORDING_DELETED_QUERY);
  return html(`${adminHead('試用')}
<h1>試用</h1>
${renderDeletedNotice(deleted)}
<div class="gf-block gf-admin-intro">
<p>印を付けた試用者ごとに、各段に入った時刻（日本時間・秒まで）・同意・アンケートの答えを出します。振り返りの時刻は、その質問を画面に出した時刻です。</p>
<p>印を付ける・記録を消すのは、この画面ではなく D1 への SQL で行います。記録は同意した日（同意していなければ印を付けた日）から ${TRIAL_RETENTION_DAYS} 日で自動的に消えます。</p>
<p>録画は「録画を落とす」で、断片をつないだ 1 本（WebM か MP4）として保存できます。録画は置いてから ${TRIAL_RETENTION_DAYS} 日で消えます。試用者に頼まれて消すときは、<strong>印を消す前に</strong>「この人の録画をすべて消す」を押してください（録画は SQL では消せません）。</p>
</div>
<h2>印を付けた新しい順（${rows.length} 件）</h2>
${
  rows.length === 0
    ? '<p class="gf-admin-note">試用者がいません。</p>'
    : `<ul class="gf-admin-list">
${rows.map((row) => renderParticipant(row, recordings.get(row.user_id) ?? [])).join('\n')}
</ul>`
}
${renderOrphans(orphans)}
<script>${DOWNLOAD_SCRIPT}</script>
${adminFooter()}`);
}

/**
 * 録画を落とすスクリプト。部分を順に取り、ブラウザの中で 1 本につないで保存させる。
 *
 * **つないだ 1 本はリンク（`data-trial-download-url`）としても残す**——ブラウザが自動の保存を止めたときに押せるように。
 */
const DOWNLOAD_SCRIPT = `
(function () {
  'use strict';
  document.addEventListener('click', async function (event) {
    var button = event.target instanceof Element ? event.target.closest('[data-trial-download]') : null;
    if (!button) { return; }
    var id = button.getAttribute('data-trial-download');
    var parts = Number(button.getAttribute('data-parts'));
    var container = button.getAttribute('data-container') === 'mp4' ? 'mp4' : 'webm';
    var status = button.parentElement.querySelector('[data-trial-download-status]');
    button.disabled = true;
    var blobs = [];
    try {
      for (var part = 0; part < parts; part += 1) {
        status.textContent = '取得しています（' + (part + 1) + ' / ' + parts + '）…';
        var response = await fetch('${ADMIN_TRIAL_RECORDING_PATH}?${TRIAL_RECORDING_ID_PARAM}=' + encodeURIComponent(id)
          + '&${TRIAL_RECORDING_PART_PARAM}=' + part, { credentials: 'same-origin' });
        if (!response.ok) { throw new Error('HTTP ' + response.status); }
        blobs.push(await response.blob());
      }
    } catch (error) {
      status.textContent = '取得できませんでした（' + String(error && error.message ? error.message : error) + '）。';
      button.disabled = false;
      return;
    }
    var file = new Blob(blobs, { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
    var url = URL.createObjectURL(file);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'trial-' + id + '.' + container;
    link.textContent = '保存する（' + (file.size / (1024 * 1024)).toFixed(1) + ' MB）';
    link.setAttribute('data-trial-download-url', url);
    status.textContent = '';
    status.appendChild(link);
    button.disabled = false;
    link.click();
  });
})();
`;

/**
 * 録画の部分を返す（`GET /api/trials/recording?recording=<id>&part=<n>`）。
 *
 * 返すのは断片を連番の順につないだバイト列で、**部分を 0 から順に並べると 1 本の録画になる**。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function downloadRecordingPart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get(TRIAL_RECORDING_ID_PARAM) ?? '';
  const rawPart = url.searchParams.get(TRIAL_RECORDING_PART_PARAM) ?? '';
  if (!isTrialRecordingId(id) || !/^(?:0|[1-9]\d{0,4})$/u.test(rawPart)) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const recording = await findTrialRecordingById(env.DB, id);
  const stream = recording === null ? null : streamTrialRecordingPart(env, recording, Number(rawPart));
  if (recording === null || stream === null) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-trial-recording-parts': String(trialRecordingPartCount(recording.next_seq)),
    },
  });
}

/**
 * 試用者 1 人の録画をすべて消す（`POST /api/trials/recordings/delete`）。終わったら一覧へ 303 で戻す。
 *
 * **権限はここで確かめない**（`handleAdminRequest` が守る。下の経路の注記）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function deleteRecordings(request: Request, env: Env): Promise<Response> {
  const back = (value: string): Response =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${ADMIN_TRIALS_PATH}?${TRIAL_RECORDING_DELETED_QUERY}=${value}`,
        'cache-control': 'no-store',
      },
    });
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return back('invalid');
  }
  const read = await readLimitedText(request, 2_000);
  if (!read.ok) {
    return back('invalid');
  }
  const fields = new URLSearchParams(read.text);
  const userId = fields.get(TRIAL_RECORDING_USER_FIELD) ?? '';
  if (
    userId === '' ||
    userId.length > 200 ||
    fields.get(TRIAL_RECORDING_DELETE_CONFIRM_FIELD) !== TRIAL_RECORDING_DELETE_CONFIRM_VALUE
  ) {
    return back('invalid');
  }
  try {
    const result = await deleteTrialRecordingsOf(env, userId);
    // **利用者の id はログに出さない。** 数だけを残す。
    console.log(`[admin] trial-recordings-deleted: recordings=${result.recordings} keys=${result.keys}`);
    return back(String(result.recordings));
  } catch (error) {
    console.error(`[admin] 録画を消せませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
    return back('invalid');
  }
}

/**
 * 試用者の一覧の経路。
 *
 * @returns 経路
 */
export function adminTrialsRoutes(): readonly Route[] {
  return [
    { method: 'GET', path: ADMIN_TRIALS_PATH, handler: (request, env) => showTrials(request, env) },
    // 録画の部分（#978）。`/api/` の下なので画面の検査の対象外（`src/page-paths.ts`）。
    { method: 'GET', path: ADMIN_TRIAL_RECORDING_PATH, handler: downloadRecordingPart },
    // 録画を消す口（#978）。**この画面で唯一の書き込み**（モジュール冒頭）。権限は `handleAdminRequest` が
    // 経路表を引く前に確かめる（既定は「閉」。未ログイン・admin 以外は経路に届かず 404）。
    { method: 'POST', path: ADMIN_TRIAL_RECORDINGS_DELETE_PATH, handler: deleteRecordings },
  ];
}
