/**
 * 審査キューの画面と、`queued` ↔ `cleared` の切り替え（仕様 2.4.3 / 8.4 / #361）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * この画面が admin のトップである
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **2.3.1 の admin の表の 1 行目がこれである。** M10-2 が置いた「空の 1 枚」を
 * 置き換えた——**目次だけの画面を挟まない**（運営が管理画面を開く理由は、ほぼ
 * 審査キューを見ることである。8.4 が「閾値到達で審査キューへ投入」と定めた先が、
 * いままで端末の SQL しか無かった）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2 つの節を並べる（往復できることが画面から見える）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`queued` と `cleared` を同じ画面に並べる。** `queued` だけを出すと、
 * **戻す操作（`cleared` → `queued`）を画面から起動できない**——「往復できる」と
 * 決めた 2.4.3 が、実装では片道になる。
 *
 * **`review_state` が NULL の作品は出さない。** それは「通報の閾値に達していない」
 * 大多数の作品であり（0017）、**審査の対象ではない。** 運営が手で止める操作も
 * 置いていない（投入するのは通報の側である。8.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 中身はここに出さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **題名と作者名までで、通報の理由も本文も出さない**（`scripts/report-queue.sh` が
 * 同じ判断をしている——「中身は作品ページで見てください」）。作品そのものは
 * **app ホストの作品ページで開く**ので、行ごとに絶対 URL のリンクを置く。
 *
 * **`games.status` を 1 ビットも動かさない**（0017 / 8.4）。この画面が動かすのは
 * `review_state` だけで、**共有済みの URL は切れない。**
 */
import { escapeHtml } from '../html.js';
import { formatJstMinutes, toIsoTimestamp } from '../jst.js';
import { workPagePath } from '../paths.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../reports.js';
import type { ReviewState } from '../reports.js';
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import {
  ADMIN_GAME_ID_FIELD,
  ADMIN_HOME_PATH,
  ADMIN_NEXT_FIELD,
  ADMIN_REASON_FIELD,
  ADMIN_REVIEW_API_PATH,
} from '../admin-paths.js';
import { ADMIN_LIST_LIMIT, oppositeReviewState, setReviewState, validateReason } from './actions.js';
import { readAdminForm } from './form.js';
import { adminNotFound } from './guard.js';
import { ADMIN_OUTCOME_QUERY, redirectWithOutcome, renderOutcomeNotice, isSucceeded } from './outcome.js';
import { adminFooter, adminHead } from './shell.js';

/** 審査キューに並べる 1 行（引いた列）。 */
interface ReviewRow {
  readonly id: string;
  readonly title: string;
  readonly published_at: number | null;
  readonly author_name: string | null;
}

/**
 * ある審査状態の作品を引く。
 *
 * **件数を固定する**（{@link ADMIN_LIST_LIMIT}。2.3.3 の条件 1 と同じ考え方）。
 * 母数（公開作品の総数）が増えても、この画面の読み取りは増えない。
 *
 * **索引を張っていない**（0017 が「全走査で足りる規模でしか呼ばれない」と書いた
 * とおり。運用が数日に 1 度開く画面である）。**張る契機は、公開作品が数千本になった
 * ときである**——`limit` は走査を止めないので、そのときは `review_state` の部分索引が要る。
 *
 * **`users` は表示名 1 列のために結合する**（行ごと持ってこない。`email` は
 * 管理画面にも出さない）。
 *
 * @param env バインディングと環境変数
 * @param state 引く審査状態
 * @param limit 取得件数の上限
 * @returns 作品の行（新しい順）
 */
async function listByReviewState(
  env: Env,
  state: ReviewState,
  limit: number = ADMIN_LIST_LIMIT,
): Promise<readonly ReviewRow[]> {
  // **並びは公開の新しい順である。** 通報の時刻で並べるには `reports` を集計する
  // 必要があり（`scripts/report-queue.sh` はそうしている）、**画面 1 枚のために
  // 読み取りを増やす理由が無い**——平常時のキューは数件である。
  const result = await env.DB.prepare(
    `select g.id, g.title, g.published_at, u.display_name as author_name
       from games g
       left join users u on u.id = g.author_id
      where g.review_state = ?
      order by g.published_at desc, g.id desc
      limit ?`,
  )
    .bind(state, limit)
    .all<ReviewRow>();
  return result.results;
}

/** 節ごとの札と、押したときに向かう先。 */
interface ReviewSection {
  readonly state: ReviewState;
  readonly heading: string;
  readonly empty: string;
  readonly note: string;
  readonly button: string;
}

/**
 * 2 つの節の文言。
 *
 * **`Record` ではなく配列で持つ。** 画面に並べる順序そのものを表しているためである
 * （審査待ちが先。運営が最初に見るものが上にある）。
 */
const SECTIONS: readonly ReviewSection[] = [
  {
    state: REVIEW_QUEUED,
    heading: '審査待ち',
    empty: 'いま審査待ちの作品はありません。',
    note: '新規露出が止まっています（一覧とトップに出ません）。共有済みの URL は生きています。',
    button: '問題なしにする（新規露出を戻す）',
  },
  {
    state: REVIEW_CLEARED,
    heading: '問題なしとした作品',
    empty: 'まだ 1 件もありません。',
    note: '露出は戻っています。再び閾値に達してもキューへは戻りません（通報の側では戻せない状態です）。',
    button: '審査待ちへ戻す（新規露出を止める）',
  },
];

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値は題名と作者名と id の 3 つで、すべて `escapeHtml` を通す**
 * （`src/work-card.ts` の規律。題名は利用者が名乗った値である）。
 *
 * **理由の欄に `size` を付けない**（`test/admin-page-shell.test.ts` が見ている。
 * `size` / `cols` は layout viewport を広げ、狭い端末で崩れる原因になる。#282）。
 *
 * @param row 作品の行
 * @param section 節の定義
 * @param appHost app ホストの綴り（作品ページのリンクに使う）
 * @returns HTML
 */
function renderRow(row: ReviewRow, section: ReviewSection, appHost: string): string {
  const id = escapeHtml(row.id);
  const iso = row.published_at === null ? '' : toIsoTimestamp(row.published_at);
  // **読めない日時では `<time>` ごと落とす**（`src/my-works.ts` と同じ扱い。
  // `datetime=""` は不正である）。
  const published =
    iso === ''
      ? '未公開'
      : `<time datetime="${iso}">${escapeHtml(formatJstMinutes(row.published_at!))}</time>`;
  // **作品ページは app ホストにある。** 絶対 URL で組み立てる——admin ホストの
  // 相対リンクにすると 404 へ送ることになる（4.4 / 2.2 が禁じている形）。
  const workUrl = `https://${escapeHtml(appHost)}${escapeHtml(workPagePath(row.id))}`;
  const reasonId = `reason-${section.state}-${id}`;

  return `<li class="gf-admin-row">
  <p class="gf-admin-row-title"><a href="${workUrl}">${escapeHtml(row.title)}</a></p>
  <p class="gf-admin-meta">作者: ${escapeHtml(row.author_name ?? '（不明）')} ／ 公開: ${published}<br>
     <code>${id}</code></p>
  <form method="post" action="${ADMIN_REVIEW_API_PATH}">
    <input type="hidden" name="${ADMIN_GAME_ID_FIELD}" value="${id}">
    <input type="hidden" name="${ADMIN_NEXT_FIELD}" value="${oppositeReviewState(section.state)}">
    <label for="${reasonId}">理由（必須。履歴に残ります）</label>
    <input id="${reasonId}" name="${ADMIN_REASON_FIELD}" type="text" required>
    <button type="submit">${escapeHtml(section.button)}</button>
  </form>
</li>`;
}

/**
 * 1 つの節を組み立てる。
 *
 * **空でも節ごと消さない。** 「審査待ち（0 件）」を出さない規律（`src/home.ts` が持ち、
 * M10-2 の空の管理画面がそれに従って一覧を 1 つも置かなかったもの）は、**機構が無い
 * ときの話**である。**ここは機構が在って中身が無い。** 在るものが 0 件であることは、
 * 書かなければ分からない（`scripts/report-queue.sh` が `REPORT_QUEUE_EMPTY` を出すのと
 * 同じ——**静かに 0 行にすると「審査待ちが無い」のか「読めていない」のかが区別できない**）。
 *
 * @param section 節の定義
 * @param rows 並べる行
 * @param appHost app ホストの綴り
 * @returns HTML
 */
function renderSection(
  section: ReviewSection,
  rows: readonly ReviewRow[],
  appHost: string,
): string {
  const body =
    rows.length === 0
      ? `<p>${escapeHtml(section.empty)}</p>`
      : `<ul class="gf-admin-list">
${rows.map((row) => renderRow(row, section, appHost)).join('\n')}
</ul>`;
  return `<h2>${escapeHtml(section.heading)}（${rows.length} 件）</h2>
<p>${escapeHtml(section.note)}</p>
${body}`;
}

/**
 * 審査キューの画面を返す。
 *
 * **読み取りは 2 本**（`queued` と `cleared`）で、それぞれ件数を固定してある。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showReviewQueue(request: Request, env: Env): Promise<Response> {
  const queued = await listByReviewState(env, REVIEW_QUEUED);
  const cleared = await listByReviewState(env, REVIEW_CLEARED);
  const outcome = new URL(request.url).searchParams.get(ADMIN_OUTCOME_QUERY);

  return html(
    `${adminHead('審査キュー')}
<h1>審査キュー</h1>
${renderOutcomeNotice(outcome)}
<p>通報が閾値に達した作品がここへ入ります（仕様 8.4）。<strong>止まるのは新規露出だけで、
   作品の取り下げはこの画面に置いていません</strong>（仕様 2.4.3。戻せない操作のため、
   引き続き D1 への直接 UPDATE で行います）。</p>
<p>どちらの操作も理由が必須で、<strong>操作と履歴は 1 つの書き込みで残ります</strong>（仕様 2.4.4）。</p>
${SECTIONS.map((section) =>
  renderSection(section, section.state === REVIEW_QUEUED ? queued : cleared, env.APP_HOST),
).join('\n')}
${adminFooter()}`,
    // **失敗の後始末で開かれた画面には、失敗のステータスを付ける**
    // （`src/account.ts` と同じ扱い。成功したかのようにログへ残さない）。
    outcome === null || isSucceeded(outcome) ? 200 : 400,
  );
}

/**
 * 審査状態を切り替える（`POST /api/review`）。
 *
 * **実行者はここで引き直さない。** 権限の判定は `handleAdminRequest`（経路表を引く
 * 手前）が 1 回だけ行い、その id を経路表の組み立てが閉じ込めて渡す
 * （`src/admin/guard.ts` の「M10-3 へ: 実行者の id が要るとき」）。**ハンドラの中で
 * `resolveAdminUser` を呼び直すと、境界が 2 か所になって、どちらが正なのか読めなくなる。**
 *
 * **`adminUserId` が無い要求は 404 へ倒す**（fail-closed）。守られた経路なので通常は
 * 起こらないが、**起こったときに「実行者不明の履歴」を積むより、断るほうがよい。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param adminUserId 実行者（権限の判定済み）
 * @returns レスポンス
 */
async function handleReviewChange(
  request: Request,
  env: Env,
  adminUserId: string | null,
): Promise<Response> {
  if (adminUserId === null) {
    console.error('[admin] 実行者が分からない要求を審査の口で受けました');
    return adminNotFound(request);
  }

  const form = await readAdminForm(request);
  if (!form.ok) {
    return redirectWithOutcome(ADMIN_HOME_PATH, form.reason);
  }

  const gameId = form.fields.get(ADMIN_GAME_ID_FIELD) ?? '';
  if (gameId === '') {
    return redirectWithOutcome(ADMIN_HOME_PATH, 'invalid-target');
  }

  // **受けるのは「どちらにしたいか」である**（`src/admin-paths.ts` の
  // `ADMIN_NEXT_FIELD`）。**既知の 2 語以外を受け付けない**——`toPublicWorkSort` のように
  // 既定へ落とす形は採らない。落とすと、**綴りを間違えた要求が反対向きの操作になる。**
  const next = form.fields.get(ADMIN_NEXT_FIELD) ?? '';
  if (next !== REVIEW_QUEUED && next !== REVIEW_CLEARED) {
    return redirectWithOutcome(ADMIN_HOME_PATH, 'invalid-target');
  }

  const reason = validateReason(form.fields.get(ADMIN_REASON_FIELD) ?? '');
  if (!reason.ok) {
    // **断った要求は D1 に触れない**（`src/account.ts` と同じ規律）。
    return redirectWithOutcome(ADMIN_HOME_PATH, reason.reason);
  }

  const outcome = await setReviewState(env, {
    gameId,
    // **いまの状態は送られてこない。** 切り替えた先の反対がそれである
    // （`oppositeReviewState`）。**画面を開いたまま別の管理者が動かしていたら、
    // UPDATE が当たらず `not-applicable` になる**——上書きしない。
    from: oppositeReviewState(next),
    to: next,
    actorId: adminUserId,
    reason: reason.value,
  });

  return redirectWithOutcome(
    ADMIN_HOME_PATH,
    outcome.ok ? (outcome.changed ? 'applied' : 'unchanged') : outcome.reason,
  );
}

/**
 * 審査キューの経路。
 *
 * **ここで権限を確かめない。** 守るのは `handleAdminRequest`（`src/admin/routes.ts`）で、
 * **経路表を引く手前**にある。**`ADMIN_OPEN_ROUTES` へ足さない限り、この 2 本は
 * 未ログインでも `is_admin = 0` でも 404 になる**（既定が「閉」である）。
 *
 * @param adminUserId 実行者（権限の判定済み。GET の画面は使わない）
 * @returns 経路
 */
export function adminReviewRoutes(adminUserId: string | null): readonly Route[] {
  return [
    { method: 'GET', path: ADMIN_HOME_PATH, handler: (request, env) => showReviewQueue(request, env) },
    {
      method: 'POST',
      path: ADMIN_REVIEW_API_PATH,
      handler: (request, env) => handleReviewChange(request, env, adminUserId),
    },
  ];
}
