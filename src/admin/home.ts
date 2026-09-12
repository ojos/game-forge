/**
 * 管理画面のトップ（2.4 / #356）。
 *
 * # 空の画面である
 *
 * **審査キュー・BAN・削除申請・履歴はまだ無い**（M10-3 / M10-4）。ここが置くのは
 * **「入れたこと」が分かる 1 枚**だけである。
 *
 * **空の一覧を置かない。** 「審査キュー（0 件）」と出すと、機構が在って中身が無いのか、
 * 機構そのものが無いのかを読む側が区別できない——**それは「出来ていないものを出来て
 * いるように書く」ことである**（`src/home.ts` が既に持っている規律。2.3.1 が
 * 「お知らせ」を置かない理由も同じ）。**何が無いかを、無いと書く。**
 *
 * # 利用者の値を 1 つも出さない
 *
 * **表示名も件数も出さない。** `is_admin` の判定で利用者を 1 行引いているので出せるが、
 * **出す理由が無いものを出さない**——`src/html.ts` が「要らない値を運ぶと、全画面の
 * 外枠がそれを出せる場所になる」と書いているのと同じ向きである。この画面が言うべきなのは
 * 「あなたはここへ入れた」であって「あなたは誰か」ではない。
 *
 * そのため**この画面に D1 から来た文字列は 1 つも無い。** M10-3 が一覧を置くときは
 * `escapeHtml` が必要になる（`src/work-card.ts` の規律）。
 */
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import { ADMIN_HOME_PATH } from '../admin-paths.js';
import { requireAdmin } from './guard.js';
import { adminFooter, adminHead } from './shell.js';

/**
 * 管理画面のトップを組み立てる。
 *
 * @returns HTML のレスポンス
 */
function renderAdminHome(): Response {
  return html(`${adminHead('管理')}
<h1>管理</h1>

<p>この画面を開けているなら、<code>users.is_admin = 1</code> が立っていて、
   admin ホストのセッションが成立しています（仕様 2.4.1 / 2.4.2）。</p>

<h2>まだ無いもの</h2>

<p>操作の画面は、これから足します。<strong>いまここには 1 つもありません。</strong></p>

<ul>
  <li>審査キューの一覧と、新規露出の停止・解除（M10-3）</li>
  <li>利用者の一覧と BAN の付け外し（M10-3）</li>
  <li>削除申請の一覧と、採った措置の記録（M10-4）</li>
  <li>操作の履歴（M10-3。<code>admin_actions</code> は追記のみ。仕様 2.4.4）</li>
</ul>

<h2>画面に置かないと決めた操作（仕様 2.4.3）</h2>

<p>次の 3 つは、この先も画面に置きません。<strong>作品の取り下げは戻せない操作であり</strong>
   （公開 URL が死ぬ）、残る 2 つは急ぐ操作ではないか、乗っ取られたときに権限を配る
   道具になります。引き続き D1 への直接 <code>UPDATE</code> で行います。</p>

<ul>
  <li>作品の取り下げ（<code>games.status = 'removed'</code>）</li>
  <li>運営フラグ（<code>users.is_operator</code>）の付け外し</li>
  <li>管理者を増やすこと（<code>users.is_admin</code>。仕様 2.4.2）</li>
</ul>
${adminFooter()}`);
}

/**
 * 管理画面のトップの経路。
 *
 * **`requireAdmin` で包む**（`src/admin/guard.ts`）。包み忘れた経路が無いことは
 * `test/admin-guard.test.ts` が admin の経路表を歩いて確かめる。
 */
export const adminHomeRoutes: readonly Route[] = [
  { method: 'GET', path: ADMIN_HOME_PATH, handler: requireAdmin(() => renderAdminHome()) },
];
