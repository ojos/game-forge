/**
 * 管理画面の外枠（2.4.1 / 2.4.5 / #356）。
 *
 * # なぜ利用者向けの外枠を使わないのか
 *
 * **2.4.1 が「ヘッダ・フッタは利用者向けと別でよい」と定めている。** 別にする理由は
 * 見た目の好みではなく 2 つある。
 *
 *   - **利用者向けのヘッダは `app` ホストの行き先で組まれている**（2.3.7 の
 *     「作品をさがす」「つくる」「自分の作品」）。**admin ホストにその経路は 1 本も
 *     無い**ので、置けば**押しても 404 になるリンク**になる（4.4 / 2.2 が禁じている形）。
 *   - **運営が「いまどちらのホストを見ているか」を取り違えないようにする。** 同じ
 *     ヘッダを出すと、BAN を押す画面と作品を見る画面が同じ見た目になる。
 *
 * # それでも見た目の土台（`app.css`）は共有する
 *
 * **`public/assets/admin.css` を足さない。** #266 の `app.css` が持っているのは
 * トークン（色・余白・文字）と `body` の版面で、**狭い端末で崩れないことの根拠は
 * そこにある**（`max-width` / `overflow-wrap` / `-webkit-text-size-adjust`）。
 * admin 用に別の 1 枚を作ると、**その値の写しができ、片方だけが腐る**
 * （`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * **admin 固有の規則が要るようになったら、そのとき `public/assets/admin.css` を足す。**
 * いまの管理画面は空で、装飾すべき中身が無い——**「将来使うかもしれない」で足さない**
 * （`migrations/0001_init.sql` の方針）。M10-3 が審査キューの表を置くときが、その契機に
 * あたる。
 *
 * # 検査は利用者向けの画面と同じ網に乗せる（2.4.5）
 *
 * 導出は `src/page-paths.ts` の `ssrPagePaths` をそのまま使い（あれは経路表を受け取る
 * 関数で、ホストを知らない）、外枠の検査は `test/admin-page-shell.test.ts` が
 * **admin の経路表を歩いて**行う。**一覧をどこにも書き写さない。**
 */
import { APP_CSS_PATH, escapeHtml } from '../html.js';
import { ADMIN_HOME_PATH } from '../admin-paths.js';

/**
 * 管理画面の題名の接尾辞。
 *
 * **どの画面のタブにも「管理」と出る。** 運営が利用者向けの画面と並べて開いたときに、
 * タブの一覧で見分けられるようにするため（ホストは見えないことが多い）。
 *
 * **輸出しない。** 検査（`test/admin-page-shell.test.ts`）はこの定数ではなく「管理」の
 * 文字そのものを見る——**実装の定数と比べると、同じ値どうしの照合になって必ず緑になる**
 * （`test/page-shell.test.ts` が綴りの出どころについて書いているのと同じ理由）。
 */
const ADMIN_TITLE_SUFFIX = ' — Game Forge 管理';

/** 管理画面のヘッダの目印（検査が掴む。利用者向けの `gf-header` とは別にする）。 */
export const ADMIN_HEADER_MARK = '<header class="gf-admin-header">';

/** 管理画面のフッタの目印。 */
export const ADMIN_FOOTER_MARK = '<footer class="gf-admin-footer">';

/**
 * 管理画面の文書の頭とヘッダを組み立てる。
 *
 * **`noindex` を必ず付ける。** 管理画面は検索結果に出てよいものではない。
 * 引数にしないのは、**出し分ける理由が 1 つも無い**からである（付け忘れる余地を作らない）。
 *
 * @param title `<title>` の中身（接尾辞はこの関数が足す）
 * @returns `<!doctype html>` から始まる文書の頭と、管理画面のヘッダ
 */
export function adminHead(title: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${APP_CSS_PATH}">
<meta name="robots" content="noindex">
<title>${escapeHtml(title + ADMIN_TITLE_SUFFIX)}</title>
<header class="gf-admin-header"><a href="${ADMIN_HOME_PATH}">Game Forge 管理</a></header>`;
}

/**
 * 管理画面のフッタ。
 *
 * **利用者向けのフッタ（`src/legal.ts` の `siteFooter`）を呼ばない。** あれは規約と
 * 削除申請への窓口で、**どちらも `app` ホストにしか無い**（置けば 404 へのリンクになる）。
 * #41 の「削除申請フォームが全ページのフッターから到達できる」は**利用者向けの画面に
 * ついての要求**であり、運営しか見ない画面がその窓口を持つ意味は無い。
 *
 * **ログイン状態で出し分けない。** そもそも管理画面はログイン済みの管理者しか開けない
 * （`src/admin/guard.ts`）。
 *
 * **まだ無い機構を書かない。** 操作の履歴（`admin_actions`。2.4.4）は M10-3 が作る。
 * 「履歴は追記で残ります」と今書くと、**残っていない記録を残っていると読ませる**
 * （`src/home.ts` の規律）。
 *
 * @returns HTML
 */
export function adminFooter(): string {
  return `
<hr>
<footer class="gf-admin-footer">
  <small>運営専用の画面です（仕様 2.4）。</small>
</footer>`;
}
