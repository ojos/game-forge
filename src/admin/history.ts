/**
 * 操作の履歴の画面（`/actions`。仕様 2.4.4 / #361）。
 *
 * # なぜ画面から読めるようにするのか
 *
 * **2.4.4 が「画面から読めるようにする」と定めている**——「端末からしか読めない記録は、
 * 急ぐ場面で使われない」。削除申請への回答を書くときに、**その場で「誰がいつ何を理由に
 * 行ったか」を引けることが、理由を必須にした意味である。**
 *
 * # 読むだけの画面である
 *
 * **この画面には操作が 1 つも無い。** 履歴は追記のみで（2.4.4）、**取り消しも 1 行として
 * 積む**——前の行を書き換えない。したがって「この行を消す」「直す」というボタンは
 * 置かない。
 *
 * **保証できるのは画面と口までである。** 端末から
 * `wrangler d1 execute DB --remote --command "delete from admin_actions"` を打てば消える
 * ——**資格情報を持つ人（＝運営自身）に対しては、この表は改竄できる。** その資格情報は
 * `users.is_admin` を立てられるものと同じであり（0025）、**この機構より上位にある。**
 * 限界の全文は `migrations/0026_admin_actions.sql` と `docs/admin-host.md` の「限界」に
 * ある。**画面にも 1 行書く**（読む人が「改竄できない記録」と誤解しないため）。
 */
import { escapeHtml } from '../html.js';
import { formatJstMinutes, toIsoTimestamp } from '../jst.js';
import { workPagePath } from '../paths.js';
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import { ADMIN_ACTIONS_PATH } from '../admin-paths.js';
import type { AdminActionEntry, AdminActionName } from './actions.js';
import { ADMIN_LIST_LIMIT, listAdminActions } from './actions.js';
import { adminFooter, adminHead } from './shell.js';

/**
 * 操作の札。
 *
 * **`Record` にしてあるので、操作を足して札を書き忘れると型の検査で落ちる**
 * （`src/works-list.ts` の `SORT_LABELS` と同じ形）。**綴りの正本は
 * `src/admin/actions.ts` の `ADMIN_ACTIONS` である**——ここは表示の言い換えだけを持つ。
 */
const ACTION_LABELS: Readonly<Record<AdminActionName, string>> = {
  'review-queued': '審査待ちにした（新規露出を止めた）',
  'review-cleared': '問題なしにした（新規露出を戻した）',
  'user-banned': 'BAN した（ログインを止めた）',
  'user-unbanned': 'BAN を解除した',
};

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値（実行者名・対象 id・理由）は、すべて `escapeHtml` を通す。**
 * **理由は運営が書いた自由記述である**——書いた本人しか読まない値であっても、
 * 出力側でエスケープする（`src/account.ts` の「保存時の制約は XSS を防がない」）。
 *
 * @param entry 履歴の 1 行
 * @param appHost app ホストの綴り（作品ページのリンクに使う）
 * @returns HTML
 */
function renderEntry(entry: AdminActionEntry, appHost: string): string {
  const iso = toIsoTimestamp(entry.createdAt);
  const when =
    iso === ''
      ? '不明'
      : `<time datetime="${iso}">${escapeHtml(formatJstMinutes(entry.createdAt))}</time>`;
  const targetId = escapeHtml(entry.targetId);
  // **作品は app ホストの作品ページへ送る**（`src/admin/review.ts` と同じ理由で
  // 絶対 URL にする）。利用者は送り先が無い——**admin に利用者の個別画面は無く**、
  // app の作者ページは公開作品しか出さないので、id をそのまま出す。
  const target =
    entry.targetType === 'game'
      ? `作品 <a href="https://${escapeHtml(appHost)}${escapeHtml(workPagePath(entry.targetId))}"><code>${targetId}</code></a>`
      : `利用者 <code>${targetId}</code>`;

  return `<li class="gf-admin-row">
  <p class="gf-admin-row-title">${when}　${escapeHtml(ACTION_LABELS[entry.action])}</p>
  <p class="gf-admin-meta">実行: ${escapeHtml(entry.actorName ?? '（不明）')} ／ 対象: ${target}</p>
  <p class="gf-admin-reason">理由: ${escapeHtml(entry.reason)}</p>
</li>`;
}

/**
 * 履歴の画面を返す。
 *
 * **件数を固定する**（`ADMIN_LIST_LIMIT`。2.3.3 の条件 1 と同じ考え方）。
 * **件数を画面に書く**——`ADMIN_LIST_LIMIT` 件ちょうどのときに「続きがあるかもしれない」
 * ことが読めなければ、**全部だと誤読させる。**
 *
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showHistory(env: Env): Promise<Response> {
  const entries = await listAdminActions(env);

  return html(`${adminHead('操作の履歴')}
<h1>操作の履歴</h1>
<p>新しい順に最大 ${ADMIN_LIST_LIMIT} 件を出します（仕様 2.4.4）。<strong>この一覧は追記のみで、
   画面からも口からも書き換えられません。</strong>ただし D1 の資格情報を持つ端末からは
   書き換えられます——保証できるのは画面と口までです（<code>docs/admin-host.md</code> の
   「限界」）。</p>
${
  entries.length === 0
    ? '<p>まだ 1 件もありません。</p>'
    : `<ul class="gf-admin-list">
${entries.map((entry) => renderEntry(entry, env.APP_HOST)).join('\n')}
</ul>`
}
${adminFooter()}`);
}

/**
 * 履歴の経路。
 *
 * **GET だけである**（読むだけの画面。上記）。
 *
 * @returns 経路
 */
export function adminHistoryRoutes(): readonly Route[] {
  return [{ method: 'GET', path: ADMIN_ACTIONS_PATH, handler: (_request, env) => showHistory(env) }];
}
