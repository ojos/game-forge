/**
 * 試用者の一覧（`/trials`。#977）——試用者ごとの段の時刻・同意・アンケートの答えを読む。
 *
 * **読むだけの画面である。** 印を付ける・記録を消すのは D1 への直接の SQL で行う（`docs/user-trial.md`）。
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
import { html } from '../routes.js';
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

/**
 * 1 人ぶんを組み立てる。**D1 から来る値（表示名・id・答え）はすべてエスケープする。**
 *
 * @param row 試用者の行
 * @returns HTML
 */
function renderParticipant(row: TrialParticipantListRow): string {
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
</li>`;
}

/**
 * 試用者の一覧を返す。
 *
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showTrials(env: Env): Promise<Response> {
  const rows = await listTrialParticipants(env.DB, ADMIN_LIST_LIMIT);
  return html(`${adminHead('試用')}
<h1>試用</h1>
<div class="gf-block gf-admin-intro">
<p>印を付けた試用者ごとに、各段に入った時刻（日本時間・秒まで）・同意・アンケートの答えを出します。振り返りの時刻は、その質問を画面に出した時刻です。</p>
<p>印を付ける・記録を消すのは、この画面ではなく D1 への SQL で行います。記録は同意した日（同意していなければ印を付けた日）から ${TRIAL_RETENTION_DAYS} 日で自動的に消えます。</p>
</div>
<h2>印を付けた新しい順（${rows.length} 件）</h2>
${
  rows.length === 0
    ? '<p class="gf-admin-note">試用者がいません。</p>'
    : `<ul class="gf-admin-list">
${rows.map(renderParticipant).join('\n')}
</ul>`
}
${adminFooter()}`);
}

/**
 * 試用者の一覧の経路。
 *
 * @returns 経路
 */
export function adminTrialsRoutes(): readonly Route[] {
  return [{ method: 'GET', path: ADMIN_TRIALS_PATH, handler: (_request, env) => showTrials(env) }];
}
