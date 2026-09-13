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
 * # 見た目の土台（`app.css`）は共有し、その上に `admin.css` を重ねる
 *
 * **`app.css` を外さない。** #266 のあの 1 枚が持っているのはトークン（色・余白・文字）と
 * `body` の版面で、**狭い端末で崩れないことの根拠はそこにある**
 * （`max-width` / `overflow-wrap` / `-webkit-text-size-adjust`）。**写しを作らない**
 * ——admin 用に値を写すと、片方だけが腐る（`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * **M10-3（#361）で `public/assets/admin.css` を足した。** M10-2 の時点では
 * 「admin 固有の規則が要るようになったら、そのとき足す。M10-3 が審査キューの表を置く
 * ときが、その契機にあたる」と書いてあった——**その契機が来た。** 足したのは
 * **一覧の行と、行ごとのフォームの規則だけ**である（トークンは 1 つも定義しない。
 * `admin.css` の冒頭がその境界を書いている）。
 *
 * **読み込む順は `app.css` → `admin.css` である。** 後から読むほうが強い（同じ詳細度
 * なら後勝ち）ので、**admin 側が上書きする側になる。** 逆にすると、admin の規則が
 * 土台に負ける。
 *
 * # 検査は利用者向けの画面と同じ網に乗せる（2.4.5）
 *
 * 導出は `src/page-paths.ts` の `ssrPagePaths` をそのまま使い（あれは経路表を受け取る
 * 関数で、ホストを知らない）、外枠の検査は `test/admin-page-shell.test.ts` が
 * **admin の経路表を歩いて**行う。**一覧をどこにも書き写さない。**
 */
import { APP_CSS_PATH, escapeHtml } from '../html.js';
import {
  ADMIN_ACTIONS_PATH,
  ADMIN_HOME_PATH,
  ADMIN_TAKEDOWNS_PATH,
  ADMIN_USERS_PATH,
} from '../admin-paths.js';

/**
 * 管理画面だけが読む見た目の規則（#361。M10-3 で足した）。
 *
 * **`src/html.ts` の `APP_CSS_PATH` の隣に置かない。** あちらは `app` ホストの外枠が
 * 持つ値で、**このレーンが触ってよい範囲の外**にある（#362 が同じファイルを触る）。
 * **綴りを置く場所は、それを出す外枠のそばでよい**——読む側がここ 1 か所しかない。
 *
 * このパスが経路表のどの `path` とも衝突しないことは、`app` 側と同じく
 * `src/page-paths.ts` の導出（`/assets/` は経路表に無い）で自然に守られる。
 */
export const ADMIN_CSS_PATH = '/assets/admin.css';

/**
 * ヘッダに並べる管理画面の行き先。
 *
 * **一覧をここに「書き写して」いるのではない。** 綴りの正本は `src/admin-paths.ts` で、
 * ここが持つのは**並び順と札**である。**画面を足したらここへ 1 行足す**——足し忘れても
 * 画面は動くが、**運営はその画面へ辿り着けない**（`test/admin-screens.test.ts` が、
 * 経路表から導いた画面がすべてヘッダから辿れることを機械照合する。**歩ける形でしか
 * 置かない**）。
 */
const ADMIN_NAV: readonly { readonly path: string; readonly label: string }[] = [
  { path: ADMIN_HOME_PATH, label: '審査キュー' },
  { path: ADMIN_USERS_PATH, label: '利用者' },
  { path: ADMIN_TAKEDOWNS_PATH, label: '削除申請' },
  { path: ADMIN_ACTIONS_PATH, label: '操作の履歴' },
];

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
 * **ナビを出す**（M10-3 で足した）。画面が複数あるので、**どこからでも全部の画面へ
 * 行ける**必要がある（#406 で削除申請を足して 4 枚）——`app` ホストの行き先は 1 本も混ぜない（2.4.1 / 4.4。
 * `test/admin-page-shell.test.ts` が照合する）。
 *
 * @param title `<title>` の中身（接尾辞はこの関数が足す）
 * @returns `<!doctype html>` から始まる文書の頭と、管理画面のヘッダ
 */
export function adminHead(title: string): string {
  const nav = ADMIN_NAV.map(
    (item) => `<a href="${item.path}">${escapeHtml(item.label)}</a>`,
  ).join('\n    ');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${APP_CSS_PATH}">
<link rel="stylesheet" href="${ADMIN_CSS_PATH}">
<meta name="robots" content="noindex">
<title>${escapeHtml(title + ADMIN_TITLE_SUFFIX)}</title>
<header class="gf-admin-header"><a href="${ADMIN_HOME_PATH}">Game Forge 管理</a>
  <nav class="gf-admin-nav">
    ${nav}
  </nav>
</header>`;
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
 * **ここに履歴への案内を置かない。** 操作の履歴（`admin_actions`。2.4.4）は M10-3 で
 * 出来たが、**行き先はヘッダのナビが持っている**（{@link ADMIN_NAV}）。フッタにも置くと
 * 同じ行き先が 2 か所になり、**画面を足したときの追随箇所が 2 つになる。**
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
