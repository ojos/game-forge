/**
 * 削除申請の一覧と、採った措置の記録（仕様 2.4.3 / 8.4 / #406。M10-4）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 申請は主張であって、認定ではない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **申請が来ても作品は 1 ビットも動かない**（`src/takedown.ts` の冒頭）。この画面は
 * **人が読んで決めた措置を記録する口**であり、措置を自動で選ばない。
 *
 * **申請者が名乗った氏名・連絡先・本文は、検証していない値である**（0018）。画面でも
 * そう分かるように「未検証」と書き、**連絡先をリンクにしない**——`mailto:` や URL に
 * すると、未検証の値を「押せば届く宛先」として扱うことになる（5.6 が `x_handle` について
 * 「未検証の自称値をリンク化しない」と書いたのと同じ線）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 画面が実行する措置と、しない措置（2.4.3）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * | 措置 | この画面がすること |
 * |---|---|
 * | `removed` | **記録だけ。** 取り下げ（`games.status = 'removed'`）は画面に置かない（戻せない） |
 * | `restricted` | 記録し、**作品を審査キューへ入れる**（`queued`。戻せる操作） |
 * | `rejected` | 記録だけ。作品は動かさない |
 *
 * **`removed` を記録したあと、作品がまだ公開中なら行に書く。** 取り下げは D1 の手作業
 * （`docs/takedown.md` の 4 章）で、**記録と実行の間に抜けができうる**——画面が黙っていると、
 * 記録を見た人は取り下げ済みだと読む。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1 度記録した措置は上書きしない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **措置済みの行にはフォームを出さない**（0018 / `docs/takedown.md`）。本文を手で作って
 * 送っても、`recordTakedownAction`（`src/admin/actions.ts`）が何も書かずに断る。
 */
import { escapeHtml } from '../html.js';
import { formatJstMinutes, toIsoTimestamp } from '../jst.js';
import { PUBLISHED_STATUS, REMOVED_STATUS } from '../games.js';
import { workPagePath } from '../paths.js';
import { REVIEW_QUEUED } from '../reports.js';
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import type { TakedownAction } from '../takedown.js';
import { TAKEDOWN_ACTIONS } from '../takedown.js';
import {
  ADMIN_REASON_FIELD,
  ADMIN_TAKEDOWNS_PATH,
  ADMIN_TAKEDOWN_ACTION_FIELD,
  ADMIN_TAKEDOWN_API_PATH,
  ADMIN_TAKEDOWN_ID_FIELD,
} from '../admin-paths.js';
import { ADMIN_LIST_LIMIT, recordTakedownAction, validateReason } from './actions.js';
import type { AdminOutcome } from './outcome.js';
import { readAdminForm } from './form.js';
import { adminNotFound } from './guard.js';
import { takedownAnchorId } from './history.js';
import {
  ADMIN_OUTCOME_QUERY,
  isSucceeded,
  redirectWithOutcome,
  renderOutcomeNotice,
} from './outcome.js';
import { adminFooter, adminHead } from './shell.js';

/**
 * 措置ごとの、フォームの選択肢の文言。
 *
 * **型が 3 つすべてを要求する**（`Record<TakedownAction, …>`）。措置を足した日に、ここを
 * 書かないまま画面が出ることは無い。
 */
const ACTION_CHOICES: Readonly<Record<TakedownAction, { readonly label: string; readonly note: string }>> = {
  removed: {
    label: '削除（申請を認める）',
    note: '記録だけです。作品の取り下げは D1 の手作業で行います（docs/takedown.md の 4 章）。',
  },
  restricted: {
    label: '新規露出の停止',
    note: '作品を審査キューへ入れます。公開一覧とトップから外れ、作品ページは開けるままです。審査キューから戻せます。',
  },
  rejected: {
    label: '認めない',
    note: '作品は動かしません。認めなかったことも記録に残します。',
  },
};

/** 一覧の 1 行（引いた列）。 */
interface TakedownRow {
  readonly id: string;
  readonly game_id: string;
  readonly claimant_name: string;
  readonly claimant_contact: string;
  readonly body: string;
  readonly received_at: number;
  readonly handled_at: number | null;
  readonly action: string | null;
  readonly note: string | null;
  /** 作品が実在すれば、その題名（**利用者が書いた値**）。 */
  readonly game_title: string | null;
  readonly game_status: string | null;
  readonly game_review_state: string | null;
  /** 措置を記録した管理者（`admin_actions` の最後の行）。**画面より前の記録には無い。** */
  readonly actor_id: string | null;
  readonly actor_name: string | null;
}

/**
 * 削除申請を引く。**未対応を先に、それぞれ新しい順。**
 *
 * **件数を固定する**（{@link ADMIN_LIST_LIMIT}。2.3.3 の条件 1 と同じ考え方）。削除申請は
 * 例外的な出来事で（0018 の「平常時この表はほとんど増えず」）、**未対応が 50 件を超える
 * ことを想定していない**——超えたときが頁送りを設計する契機である（`ADMIN_LIST_LIMIT`）。
 *
 * **索引を張っていない**（0018 と同じ判断）。**実行者は `admin_actions` から相関副問い合わせで
 * 引く**が、条件は `target_kind` と `target_id` の等号で `0029` の索引の先頭 2 列に当たる。
 *
 * @param env バインディングと環境変数
 * @param limit 取得件数の上限
 * @returns 申請の行
 */
async function listTakedowns(
  env: Env,
  limit: number = ADMIN_LIST_LIMIT,
): Promise<readonly TakedownRow[]> {
  const latestActor = (column: string): string =>
    `(select ${column}
        from admin_actions a
        left join users u on u.id = a.actor_id
       where a.target_kind = 'takedown' and a.target_id = t.id
       order by a.created_at desc, a.rowid desc
       limit 1)`;
  const result = await env.DB.prepare(
    `select t.id, t.game_id, t.claimant_name, t.claimant_contact, t.body, t.received_at,
            t.handled_at, t.action, t.note,
            g.title as game_title, g.status as game_status, g.review_state as game_review_state,
            ${latestActor('a.actor_id')} as actor_id,
            ${latestActor('u.display_name')} as actor_name
       from takedown_requests t
       left join games g on g.id = t.game_id
      order by (t.handled_at is not null), t.received_at desc, t.rowid desc
      limit ?`,
  )
    .bind(limit)
    .all<TakedownRow>();
  return result.results;
}

/**
 * 時刻を `<time>` で出す。
 *
 * @param epochSeconds UNIX 秒
 * @returns HTML
 */
function timeOf(epochSeconds: number): string {
  const iso = toIsoTimestamp(epochSeconds);
  return iso === ''
    ? '不明'
    : `<time datetime="${iso}">${escapeHtml(formatJstMinutes(epochSeconds))}</time>`;
}

/**
 * 措置の綴りかを確かめる。
 *
 * @param value フォームや D1 から来た値
 * @returns 措置の綴りなら true
 */
function isTakedownAction(value: string | null): value is TakedownAction {
  return value !== null && (TAKEDOWN_ACTIONS as readonly string[]).includes(value);
}

/**
 * 対象の作品の欄を組み立てる。
 *
 * **作品ページは app ホストにある**ので絶対 URL で送る（`src/admin/review.ts` と同じ）。
 * **実在しない申請も壊さずに出す**（0018）——申請に書かれた id をそのまま見せる。
 *
 * @param row 申請の行
 * @param appHost app ホスト
 * @returns HTML
 */
function renderGame(row: TakedownRow, appHost: string): string {
  const gameId = escapeHtml(row.game_id);
  if (row.game_status === null) {
    return `<p class="gf-admin-meta">対象の作品: <strong>見つかりません</strong>（申請に書かれた id: <code>${gameId}</code>）</p>`;
  }
  const workUrl = `https://${escapeHtml(appHost)}${escapeHtml(workPagePath(row.game_id))}`;
  const state =
    row.game_status === REMOVED_STATUS
      ? '取り下げ済み'
      : row.game_status !== PUBLISHED_STATUS
        ? '未公開'
        : row.game_review_state === REVIEW_QUEUED
          ? '公開中（審査待ち。新規露出は止まっています）'
          : '公開中';
  return `<p class="gf-admin-meta">対象の作品: <a href="${workUrl}">${escapeHtml(row.game_title ?? '')}</a> ／ ${state}<br>
     <code>${gameId}</code></p>`;
}

/**
 * 措置を記録するフォーム（未対応の行だけ）。
 *
 * @param row 申請の行
 * @returns HTML
 */
function renderForm(row: TakedownRow): string {
  const id = escapeHtml(row.id);
  const choices = TAKEDOWN_ACTIONS.map((action) => {
    const choiceId = `action-${action}-${id}`;
    return `<p class="gf-admin-choice">
      <input id="${choiceId}" type="radio" name="${ADMIN_TAKEDOWN_ACTION_FIELD}" value="${action}" required>
      <label for="${choiceId}"><strong>${escapeHtml(ACTION_CHOICES[action].label)}</strong> — ${escapeHtml(ACTION_CHOICES[action].note)}</label>
    </p>`;
  }).join('\n    ');
  return `<form method="post" action="${ADMIN_TAKEDOWN_API_PATH}">
    <input type="hidden" name="${ADMIN_TAKEDOWN_ID_FIELD}" value="${id}">
    <fieldset class="gf-admin-choices">
    <legend>採る措置（1 度記録したら上書きしません）</legend>
    ${choices}
    </fieldset>
    <label for="reason-${id}">理由（必須。履歴に残り、申請への回答に使います）</label>
    <input id="reason-${id}" name="${ADMIN_REASON_FIELD}" type="text" required>
    <button type="submit">措置を記録する</button>
  </form>`;
}

/**
 * 記録済みの措置の欄（措置済みの行だけ）。
 *
 * @param row 申請の行（`handled_at` が入っているもの）
 * @returns HTML
 */
function renderHandled(row: TakedownRow): string {
  const action = isTakedownAction(row.action) ? row.action : null;
  const label = action === null ? `不明な綴り（${escapeHtml(row.action ?? '')}）` : escapeHtml(ACTION_CHOICES[action].label);
  // **画面より前に端末で記録した行には、実行者の履歴が無い**（`recordTakedownAction` を
  // 通っていない）。無いことを書く——空欄にすると、履歴が消えたのか最初から無いのか
  // 区別できない。
  const actor =
    row.actor_id === null
      ? '（履歴なし。この画面より前に端末で記録された措置です）'
      : `${escapeHtml(row.actor_name ?? '（不明）')} <code>${escapeHtml(row.actor_id)}</code>`;
  // **`removed` を記録したのに作品が公開中なら、手作業が残っている**（このファイルの冒頭）。
  const pending =
    action === 'removed' && row.game_status === PUBLISHED_STATUS
      ? '\n  <p class="error">作品はまだ公開中です。取り下げは D1 の手作業で行ってください（docs/takedown.md の 4 章）。</p>'
      : '';
  return `<p class="gf-admin-meta">措置: <strong>${label}</strong> ／ 記録: ${timeOf(row.handled_at ?? 0)} ／ 実行: ${actor}</p>
  <p class="gf-admin-reason">理由: ${escapeHtml(row.note ?? '')}</p>${pending}`;
}

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値はすべて `escapeHtml` を通す。** 申請の中身は非ログインの誰でも書ける値で
 * あり（`src/takedown-routes.ts`）、作品の題名は作者が書いた値である。
 *
 * @param row 申請の行
 * @param appHost app ホスト
 * @returns HTML
 */
function renderRow(row: TakedownRow, appHost: string): string {
  const handled = row.handled_at !== null;
  return `<li class="gf-admin-row" id="${escapeHtml(takedownAnchorId(row.id))}">
  <p class="gf-admin-badge">${handled ? '措置済み' : '未対応'}</p>
  <p class="gf-admin-row-title">受付: ${timeOf(row.received_at)}</p>
  ${renderGame(row, appHost)}
  <p class="gf-admin-meta">申請者（未検証）: <span class="gf-admin-unverified">${escapeHtml(row.claimant_name)}</span>
     ／ 連絡先（未検証）: <span class="gf-admin-unverified">${escapeHtml(row.claimant_contact)}</span></p>
  <p class="gf-admin-takedown-body">${escapeHtml(row.body)}</p>
  <p class="gf-admin-meta">受付 id: <code>${escapeHtml(row.id)}</code></p>
  ${handled ? renderHandled(row) : renderForm(row)}
</li>`;
}

/**
 * 削除申請の一覧を返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showTakedowns(request: Request, env: Env): Promise<Response> {
  const rows = await listTakedowns(env);
  const outcome = new URL(request.url).searchParams.get(ADMIN_OUTCOME_QUERY);
  const pending = rows.filter((row) => row.handled_at === null).length;

  return html(
    `${adminHead('削除申請')}
<h1>削除申請</h1>
${renderOutcomeNotice(outcome)}
<p><strong>申請は主張であって、認定ではありません。</strong>届いただけでは作品は動きません。
   読んで判断し、採った措置を記録してください（仕様 8.4 / <code>docs/takedown.md</code>）。</p>
<p>申請者の氏名・連絡先・本文は<strong>検証していない値</strong>です。<strong>1 度記録した措置は
   上書きしません。</strong>「削除」を記録しても作品は取り下げられません——取り下げは戻せない操作なので、
   この画面に置いていません（仕様 2.4.3）。</p>
<h2>未対応を先に、新しい順（未対応 ${pending} 件 ／ 表示 ${rows.length} 件）</h2>
${
  rows.length === 0
    ? '<p>削除申請はまだありません。</p>'
    : `<ul class="gf-admin-list">
${rows.map((row) => renderRow(row, env.APP_HOST)).join('\n')}
</ul>`
}
${adminFooter()}`,
    outcome === null || isSucceeded(outcome) ? 200 : 400,
  );
}

/**
 * 措置を記録する（`POST /api/takedown`）。
 *
 * 実行者の受け取り方と fail-closed の理由は `src/admin/review.ts` の
 * `handleReviewChange` と同じである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param adminUserId 実行者（権限の判定済み）
 * @returns レスポンス
 */
async function handleTakedownAction(
  request: Request,
  env: Env,
  adminUserId: string | null,
): Promise<Response> {
  if (adminUserId === null) {
    console.error('[admin] 実行者が分からない要求を削除申請の口で受けました');
    return adminNotFound(request);
  }

  const form = await readAdminForm(request);
  if (!form.ok) {
    return redirectWithOutcome(ADMIN_TAKEDOWNS_PATH, form.reason);
  }

  const requestId = form.fields.get(ADMIN_TAKEDOWN_ID_FIELD) ?? '';
  if (requestId === '') {
    return redirectWithOutcome(ADMIN_TAKEDOWNS_PATH, 'invalid-target');
  }

  // **既知の 3 語以外を受け付けない。** 既定へ落とす形にすると、綴りを間違えた要求が
  // 別の措置として記録される（`src/admin/review.ts` の `next` と同じ規律）。
  const action = form.fields.get(ADMIN_TAKEDOWN_ACTION_FIELD) ?? null;
  if (!isTakedownAction(action)) {
    return redirectWithOutcome(ADMIN_TAKEDOWNS_PATH, 'invalid-target');
  }

  const reason = validateReason(form.fields.get(ADMIN_REASON_FIELD) ?? '');
  if (!reason.ok) {
    // **断った要求は D1 に触れない**（`src/account.ts` と同じ規律）。
    return redirectWithOutcome(ADMIN_TAKEDOWNS_PATH, reason.reason);
  }

  const recorded = await recordTakedownAction(env, {
    requestId,
    action,
    actorId: adminUserId,
    reason: reason.value,
  });

  let outcome: AdminOutcome;
  if (recorded.ok) {
    outcome = action === 'restricted' && !recorded.queued ? 'recorded-not-queued' : 'applied';
  } else {
    outcome = recorded.reason === 'not-found' ? 'not-applicable' : recorded.reason;
  }
  return redirectWithOutcome(ADMIN_TAKEDOWNS_PATH, outcome);
}

/**
 * 削除申請の経路。
 *
 * **ここで権限を確かめない**（`src/admin/review.ts` と同じ。守るのは
 * `handleAdminRequest` で、**既定は「閉」**である）。
 *
 * @param adminUserId 実行者（権限の判定済み）
 * @returns 経路
 */
export function adminTakedownRoutes(adminUserId: string | null): readonly Route[] {
  return [
    {
      method: 'GET',
      path: ADMIN_TAKEDOWNS_PATH,
      handler: (request, env) => showTakedowns(request, env),
    },
    {
      method: 'POST',
      path: ADMIN_TAKEDOWN_API_PATH,
      handler: (request, env) => handleTakedownAction(request, env, adminUserId),
    },
  ];
}
