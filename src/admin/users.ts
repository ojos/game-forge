/**
 * 利用者の一覧と、BAN の付け外し（仕様 2.4.3 / 7.3 / #361）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BAN は露出を止めない（7.3 / #330 の決定）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **止まるのはセッションである。** `resolveSessionUser` が `banned_at` を見て拒否するので
 * （`src/session-user.ts`）、**ログインだけでなく、ログインを要する操作がすべて止まる**
 * ——生成（`src/generate.ts`）・公開・推敲・いいね・招待コードの発行
 * （`src/invite-issuance.ts`）・登録情報の変更。**BAN は費用 DoS への防波堤である**
 * （7.3）ので、止まる範囲がここまで及ぶのは意図どおりである。
 *
 * **止まらないのは露出である。** その人の公開済みの作品は、一覧からもトップからも
 * 作者ページからも消えない。
 *
 * **それは仕様である。** 7.3 は BAN を「費用 DoS への防波堤」として置いており、
 * **作品の可否は審査（`review_state`）と取り下げ（`status`）が決める。** 混ぜると、
 * 「アカウントを止める」が「公開済みの作品を全部消す」になり、**戻せない側の操作に
 * 化ける**（BAN は戻せる操作として 2.4.3 が画面に置いたものである）。
 *
 * **画面にそう書く。** 書かないと、運営は「BAN したのに作品が出ている」を不具合だと
 * 読む。`test/admin-actions.test.ts` が、BAN の直後に公開一覧を引いて作品が残って
 * いることを確かめる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 置かない操作
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **運営フラグ（`is_operator`）の付け外しと、管理者を増やすことは置かない**
 * （2.4.2 / 2.4.3）。前者は表示だけの列で急ぐ操作ではなく、**後者は乗っ取られたときに
 * 権限を配る道具になる。** 引き続き D1 への直接 UPDATE で行う（`docs/admin-host.md`）。
 *
 * **自分自身を BAN する操作も置かない。** 通ってしまうと**自分が二度と入れなくなる**
 * ——解除には D1 の直接 UPDATE が要る（画面へ入れないため）。**判定は画面の側に置く**
 * （`src/admin/actions.ts` の `setUserBan` は対象を選ばない。あちらへ足すと、
 * 「誰を BAN できるか」の決定が 2 か所に分かれる）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * メールアドレスを出さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **出す理由が無いものを出さない**（`src/html.ts` の「要らない値を運ぶと、全画面の
 * 外枠がそれを出せる場所になる」と同じ向き。M10-2 の空の管理画面も、同じ理由で利用者の
 * 値を 1 つも出さなかった）。誰であるかは表示名と id で足り、**アドレスで引く必要がある
 * 場面は端末の SQL にしかない**（`docs/admin-host.md` の `is_admin` の立て方）。
 */
import { escapeHtml } from '../html.js';
import { formatJstMinutes, toIsoTimestamp } from '../jst.js';
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import {
  ADMIN_BAN_API_PATH,
  ADMIN_NEXT_FIELD,
  ADMIN_REASON_FIELD,
  ADMIN_USERS_PATH,
  ADMIN_USER_ID_FIELD,
} from '../admin-paths.js';
import { ADMIN_LIST_LIMIT, setUserBan, validateReason } from './actions.js';
import { readAdminForm } from './form.js';
import { adminNotFound } from './guard.js';
import {
  ADMIN_OUTCOME_QUERY,
  isSucceeded,
  redirectWithOutcome,
  renderOutcomeNotice,
} from './outcome.js';
import { adminFooter, adminHead } from './shell.js';

/**
 * BAN の向きを表すフォームの値（**正本**）。
 *
 * **「切り替える」ではなく「どちらにしたいか」を送る**（`src/admin-paths.ts` の
 * `ADMIN_NEXT_FIELD`）。画面を開いたまま別の管理者が動かしていた場合に、
 * **送った側が意図しない向きへ倒れない。**
 */
export const BAN_NEXT_BANNED = 'banned';

/** BAN を外す向き（{@link BAN_NEXT_BANNED} の対）。 */
export const BAN_NEXT_ACTIVE = 'active';

/** 一覧に並べる 1 行（引いた列）。 */
interface UserRow {
  readonly id: string;
  readonly display_name: string;
  readonly created_at: number;
  readonly banned_at: number | null;
  readonly is_admin: number;
  /** 運営フラグ（0021）。**表示だけの列で、権限を与えない**（2.4.2）。行の頭のチップにだけ使う（#475）。 */
  readonly is_operator: number;
}

/**
 * 利用者を新しい順に引く。
 *
 * **件数を固定する**（{@link ADMIN_LIST_LIMIT}。2.3.3 の条件 1 と同じ考え方）。
 * 参加者は**全体で 50 人が上限**である（8.1 / #355）ので、いまはこの 1 画面に全員が
 * 載る。**上限を超えて増えたときに頁送りを設計する**（`src/admin/actions.ts` の
 * `ADMIN_LIST_LIMIT`）。
 *
 * **索引を張っていない。** `users` を新しい順に 50 件引くだけで、母数は 50 人である。
 *
 * @param env バインディングと環境変数
 * @param limit 取得件数の上限
 * @returns 利用者の行（新しい順）
 */
async function listUsers(env: Env, limit: number = ADMIN_LIST_LIMIT): Promise<readonly UserRow[]> {
  const result = await env.DB.prepare(
    `select id, display_name, created_at, banned_at, is_admin, is_operator
       from users
      order by created_at desc, id desc
      limit ?`,
  )
    .bind(limit)
    .all<UserRow>();
  return result.results;
}

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値（表示名・id）は `escapeHtml` を通す。** 表示名は利用者が自分で
 * 決められる値である（5.9。`src/account.ts` は「保存時の制約は XSS を防がない」と
 * 書いており、**防ぐのは出力側のエスケープである**）。
 *
 * ## 見た目の部品（仕様 2.5 / #475）
 *
 * - **1 件を 1 つのブロックにし、名前の横に状態のチップを並べる**（管理者・運営・BAN 中）。**BAN 中だけを
 *   `.gf-chip-emphasis` にする**——いま止めている利用者を一覧で見落とさないため。**赤くしない**（赤はエラーの
 *   意味だけ。2.5.2）。BAN していない行に「通常」の札は付けない（チップが無いことが通常である）
 * - **BAN する・解除するのボタンはどちらも副にする**（`.gf-button-secondary`）。取り返しの付きにくい操作でも
 *   主にも赤にもしない（2.5.10 の第 4 版の決定）
 *
 * @param row 利用者の行
 * @param actorId 操作している管理者（自分自身には BAN の口を出さない）
 * @returns HTML
 */
function renderUser(row: UserRow, actorId: string): string {
  const id = escapeHtml(row.id);
  const iso = toIsoTimestamp(row.created_at);
  const created =
    iso === '' ? '不明' : `<time datetime="${iso}">${escapeHtml(formatJstMinutes(row.created_at))}</time>`;
  const banned = row.banned_at !== null;
  const chips = [
    row.is_admin === 1 ? '<span class="gf-chip">管理者</span>' : '',
    row.is_operator === 1 ? '<span class="gf-chip">運営</span>' : '',
    banned ? '<span class="gf-chip gf-chip-emphasis">BAN 中</span>' : '',
  ].filter((chip) => chip !== '');

  // **自分自身には出さない**（このファイルの冒頭）。**押せない理由を書く**
  // ——ボタンだけ消すと、運営は「なぜこの行だけ違うのか」を読めない。
  const form =
    row.id === actorId
      ? '<p class="gf-admin-meta">いま操作しているアカウントです（自分自身は BAN できません）。</p>'
      : `<form method="post" action="${ADMIN_BAN_API_PATH}">
    <input type="hidden" name="${ADMIN_USER_ID_FIELD}" value="${id}">
    <input type="hidden" name="${ADMIN_NEXT_FIELD}" value="${banned ? BAN_NEXT_ACTIVE : BAN_NEXT_BANNED}">
    <label for="reason-${id}">理由（必須。履歴に残ります）</label>
    <div class="gf-admin-submit">
      <input id="reason-${id}" name="${ADMIN_REASON_FIELD}" type="text" required>
      <button type="submit" class="gf-button gf-button-secondary">${banned ? 'BAN を解除する' : 'BAN する（ログインを要する操作を止める）'}</button>
    </div>
  </form>`;

  return `<li class="gf-block gf-admin-row">
  <p class="gf-admin-row-head"><span class="gf-admin-row-title">${escapeHtml(row.display_name)}</span>${chips.map((chip) => ` ${chip}`).join('')}</p>
  <p class="gf-admin-meta">登録: ${created} ／ <code>${id}</code></p>
  ${form}
</li>`;
}

/**
 * 利用者の一覧を返す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param adminUserId 操作している管理者
 * @returns レスポンス
 */
async function showUsers(
  request: Request,
  env: Env,
  adminUserId: string | null,
): Promise<Response> {
  const rows = await listUsers(env);
  const outcome = new URL(request.url).searchParams.get(ADMIN_OUTCOME_QUERY);

  return html(
    `${adminHead('利用者')}
<h1>利用者</h1>
${renderOutcomeNotice(outcome)}
<div class="gf-block gf-admin-intro">
<p><strong>BAN するとログインが通らなくなり、生成・公開・いいね・招待コードの発行など、ログインを要する操作がすべて止まります。</strong>止まらないのは露出です——その人の公開済みの作品は、一覧にも作品ページにも残ります（仕様 7.3）。作品を止めるのは審査キューの操作です。</p>
<p>運営フラグ（<code>is_operator</code>）の付け外しと、管理者を増やすことは、この画面に置いていません（仕様 2.4.2 / 2.4.3）。</p>
</div>
<h2>新しい順（${rows.length} 件）</h2>
${
  rows.length === 0
    ? '<p class="gf-admin-note">利用者がいません。</p>'
    : `<ul class="gf-admin-list">
${rows.map((row) => renderUser(row, adminUserId ?? '')).join('\n')}
</ul>`
}
${adminFooter()}`,
    outcome === null || isSucceeded(outcome) ? 200 : 400,
  );
}

/**
 * BAN を付け外しする（`POST /api/ban`）。
 *
 * 実行者の受け取り方と fail-closed の理由は `src/admin/review.ts` の
 * `handleReviewChange` と同じである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param adminUserId 実行者（権限の判定済み）
 * @returns レスポンス
 */
async function handleBanChange(
  request: Request,
  env: Env,
  adminUserId: string | null,
): Promise<Response> {
  if (adminUserId === null) {
    console.error('[admin] 実行者が分からない要求を BAN の口で受けました');
    return adminNotFound(request);
  }

  const form = await readAdminForm(request);
  if (!form.ok) {
    return redirectWithOutcome(ADMIN_USERS_PATH, form.reason);
  }

  const userId = form.fields.get(ADMIN_USER_ID_FIELD) ?? '';
  // **自分自身は断る**（このファイルの冒頭。画面にボタンが無くても、本文は手で作れる）。
  if (userId === '' || userId === adminUserId) {
    return redirectWithOutcome(ADMIN_USERS_PATH, 'invalid-target');
  }

  const next = form.fields.get(ADMIN_NEXT_FIELD) ?? '';
  if (next !== BAN_NEXT_BANNED && next !== BAN_NEXT_ACTIVE) {
    return redirectWithOutcome(ADMIN_USERS_PATH, 'invalid-target');
  }

  const reason = validateReason(form.fields.get(ADMIN_REASON_FIELD) ?? '');
  if (!reason.ok) {
    return redirectWithOutcome(ADMIN_USERS_PATH, reason.reason);
  }

  const outcome = await setUserBan(env, {
    userId,
    banned: next === BAN_NEXT_BANNED,
    actorId: adminUserId,
    reason: reason.value,
  });

  return redirectWithOutcome(
    ADMIN_USERS_PATH,
    outcome.ok ? (outcome.changed ? 'applied' : 'unchanged') : outcome.reason,
  );
}

/**
 * 利用者の一覧の経路。
 *
 * **ここで権限を確かめない**（`src/admin/review.ts` と同じ。守るのは
 * `handleAdminRequest` で、**既定は「閉」**である）。
 *
 * @param adminUserId 実行者（権限の判定済み）
 * @returns 経路
 */
export function adminUsersRoutes(adminUserId: string | null): readonly Route[] {
  return [
    {
      method: 'GET',
      path: ADMIN_USERS_PATH,
      handler: (request, env) => showUsers(request, env, adminUserId),
    },
    {
      method: 'POST',
      path: ADMIN_BAN_API_PATH,
      handler: (request, env) => handleBanChange(request, env, adminUserId),
    },
  ];
}
