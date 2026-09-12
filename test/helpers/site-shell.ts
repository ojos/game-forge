/**
 * 画面の HTML から、全画面に共通する外枠を取り除く道具（#372）。
 *
 * **外枠が本文と同じ語を持つようになった。** #372 でヘッダにアカウントのメニュー
 * （「いいねした作品」「ログアウト」の `<form>`）が、ヘッダの直後にパンくず（トップへの
 * `<a href="/">` と、いまの画面の名前＝作品名）が入った。**本文について「〜を出さない」
 * 「1 度だけ出す」を見ていた検査は、外枠の語に当たって赤くなる**——しかも本文は正しい。
 *
 * 外枠そのものは `test/page-shell.test.ts` が経路表から導いて全画面で見ているので、
 * **画面ごとの検査は本文だけを見る。** 同じことを 2 か所で見ると、片方だけが古くなる。
 *
 * **取り除くのは外枠の 3 つだけである**（`src/html.ts` の `siteHeader` / `siteBreadcrumb`
 * と `src/legal.ts` の `siteFooter`）。`<script>` はフッタの後ろに置く画面があるが
 * （`src/generate-page.ts`）、あれは本文の一部なので残す。
 */

/**
 * 外枠（ヘッダ・パンくず・フッタ）を取り除いた本文を返す。
 *
 * @param html 画面の HTML
 * @returns 外枠を取り除いた HTML
 */
export function pageBodyOf(html: string): string {
  return html
    .replace(/<header class="gf-header">[\s\S]*?<\/header>/u, '')
    .replace(/<nav class="gf-breadcrumb"[\s\S]*?<\/nav>/u, '')
    .replace(/<footer class="gf-footer">[\s\S]*?<\/footer>/u, '');
}
