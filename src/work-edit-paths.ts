/**
 * エディットページ（`/works/<game_id>/edit`。#664）のパス。
 *
 * # なぜ `src/paths.ts` に置かないのか
 *
 * **あちらはオーケストレータ Lambda の束に入る**（`src/works-paths.ts` の冒頭。#266 / #283 / #328）。
 * 束は使われていない輸出を落とすが、**別の定数を参照する式（テンプレートリテラル）は副作用が無いと示せず残る。**
 * Lambda が一度も読まない値のために `CodeSha256` が変わり、#241 の関門が Worker の配備を止める。
 * **画面だけが読む綴りは、Lambda が import しないモジュールへ置く**（`src/works-paths.ts` と同じ規約）。
 *
 * このファイルを import するのは画面と、画面へ送り返す経路（生成画面・フォーク・リフォージ・公開・
 * 「あなたの作品」・作品ページ・エディットページ）、**それに生成の完了メール（`src/mail/generation-notice.ts`）**である。
 *
 * **生成の完了メールだけは Lambda の束に入る**（#672。作者がメールのリンクからエディットページへ直接着くため）。
 * したがって**このファイルを変えると束の `CodeSha256` が変わり、配り直すまで main の deploy が止まる。**
 * 値だけの葉に保ち、画面の実装をここへ引き込まない（`src/paths.ts` の冒頭と同じ規約）。触ったら PR 前に
 * `scripts/orchestrator-bundle-changed.sh` で束が変わるかを確かめる。
 *
 * # なぜ値だけの葉に置くのか
 *
 * **エディットページを提供する側（`src/work-edit.ts`）と、そこへ送り返す側が別モジュールだから**である。
 * 送り返す側（`src/publish.ts` / `src/fork.ts` / `src/revise.ts`）の一部は、エディットページが
 * フォームの `action` として綴りを借りる相手でもあり、互いに import すると循環参照になる。
 */
import { workPagePath } from './paths.js';

/**
 * 作品ページのパスの後ろに付ける、エディットページの接尾辞（#664）。
 *
 * **経路表に別の経路を足さない。** 作品ページは前方一致（`/works/`）で登録されており、id を挟む綴りは
 * その経路がそのまま受け取る（`src/routes.ts`）。削除の確認画面（`src/work-delete.ts` の `WORK_DELETE_SUFFIX`）と
 * 同じく、前方一致の入口（`src/work-page.ts` の `createWorkPageRoutes`）が末尾で振り分ける。
 *
 * **完全一致の経路（`/works/mine`・`/works/liked`）は飲み込まない。** 経路表は完全一致を先に見る
 * （`src/routes.ts` の `dispatch`）。`/works/mine/edit` は前方一致に来るが、`mine` は作品 id の綴りに
 * 合わないので作品ページと同じ 404 になる。
 */
export const WORK_EDIT_SUFFIX = '/edit';

/**
 * エディットページのパスを組み立てる（#664）。
 *
 * @param gameId 作品 id
 * @returns アプリ用ホスト上の絶対パス
 */
export function workEditPath(gameId: string): string {
  return `${workPagePath(gameId)}${WORK_EDIT_SUFFIX}`;
}
