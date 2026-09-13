/**
 * 作品のソースコードの閲覧（`/source/<game_id>`。仕様 2.3.12 / #383）。
 *
 * ## このサービスでの「ダウンロード」
 *
 * **公開済みの作品の Go ソースは、既に R2 にあってフォークの材料として使われている**（5.3）。
 * 閲覧させる経路だけが無かった。この画面がその経路である。**ソースは生成物のまま出す**
 * （#383 の決定 1）——生成されたコードのコメントや文字列に、入力プロンプトの言い換えが
 * 写り得ることは、承知のうえで採っている（その代償は仕様 2.3.12 に書いた）。
 *
 * ## 作品ページとは別の経路にした
 *
 * **`/works/<id>` の中に置かない。** 64KB のソースを作品ページへ畳んで持たせると、拡散の
 * 着地点（5.4）を開くたびに R2 を読むことになる（3.6 の読み取りがそのまま費用になる）。
 * 別の前方一致の経路にすると、**経路表から外枠と幅の検査に自動で乗る**
 * （`src/page-paths.ts`）。`/works/<id>/source` にしないのは、**経路表の前方一致は固定の
 * 接頭辞しか持てない**（`src/routes.ts`）ためで、id を挟む綴りは `/works/` の作品ページの
 * 経路がそのまま受け取り、id の綴りの検査で 404 にしている——そこへ分岐を足すと、
 * 作品ページの入口の判定に 2 つ目の画面が混ざる。
 *
 * ## 誰に何を返すか
 *
 * | 作品 | 応答 |
 * |---|---|
 * | 公開済み・審査で新規露出を止めていない | **ソース**（読めなければ、読めなかったことを言う 200） |
 * | `draft` / `removed` / 審査で止めた / 存在しない / id の綴りが違う | **404。理由を分けない** |
 *
 * **絞り込みは R2 のキーを引く SQL で行う**（{@link PUBLISHED_SOURCE_SQL}）。キーを引いてから
 * 画面の側で `status` を見る形にすると、**未公開の作品の R2 キーを引ける経路**が 1 行の
 * 書き間違いで開く（`src/source-store.ts` の `readStoredSource` の注意書き）。理由を分けないのは、
 * 任意の id が実在するか・審査で止まっているかを外から確かめる手がかりにしないためである
 * （`src/work-page.ts` の `notFound` と同じ考え方）。
 *
 * ## 出さないもの（2.3.12 の表）
 *
 * - **システムプロンプト（6.1）・入力プロンプト**（`generations.prompt` / `game_revisions.prompt`）
 *   ——この画面はどちらの表も読まない。**読まなければ、書き間違えても漏れようがない**
 * - **内部の識別子**（R2 のキー・ビルドのジョブ ID・モデルの ARN）——キーは SQL で引いて
 *   R2 へ渡すだけで、画面へ渡す型（{@link WorkSourceView}）に置き場所が無い
 *
 * ## JavaScript を要求しない
 *
 * ソースは `<pre>` に `escapeHtml` を通して入れるだけである。色付け（シンタックス
 * ハイライト）は置かない——JS か大きな CSS が要り、作品ページと同じ「JS を要求しない」を崩す。
 */
import { PUBLISHED_STATUS } from './games.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { workPagePath } from './paths.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { readStoredSource } from './source-store.js';

/**
 * ソースの閲覧の接頭辞（2.3.1 / 2.3.12 / #383）。
 *
 * **末尾の `/` は前方一致の規約である**（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 *
 * **`src/paths.ts` に置かない。** あちらはオーケストレータ Lambda の束に入る葉で、
 * 画面だけが読む綴りを足すと束の `CodeSha256` が変わりうる（`src/paths.ts` の冒頭）。
 * この綴りを読むのは作品ページ（リンク）とこのモジュール（経路）だけである。
 */
export const WORK_SOURCE_PREFIX = '/source/';

/**
 * ソースの閲覧のパスを組み立てる。
 *
 * @param gameId 作品 id
 * @returns パス
 */
export function workSourcePath(gameId: string): string {
  return `${WORK_SOURCE_PREFIX}${gameId}`;
}

/** 作品 id の綴り（UUID）。形の違う id では D1 を 1 行も読まない。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * ソースを出してよい作品の R2 キーと題名を引く SQL（2.3.12 / #383）。
 *
 * **資格の条件はこの 1 本だけが持つ**——公開済み（`status = 'published'`）で、8.4 の審査で
 * 新規露出を止めていない（`reviewVisibleSql`。一覧が借りている断片そのもの）。**`removed` と
 * `draft` は `status = ?` で落ちる。** 当たらない作品の R2 キーは、この経路では 1 度も
 * メモリに載らない。
 *
 * **`source_key` が NULL の行も返す。** 公開済みなら通常は必ず入っている（公開できるのは
 * `generation_state = 'ready'` の作品だけ。5.4）が、**不変条件に寄りかからない**——無ければ
 * 「読めなかった」として扱う（`src/fork.ts` の `readParentSource` と同じ）。
 *
 * **変異の当て先である**（`test/work-source.test.ts` の冒頭の記録）。
 */
const PUBLISHED_SOURCE_SQL = `select title, source_key
       from games
      where id = ? and status = ? and ${reviewVisibleSql()}`;

/** {@link PUBLISHED_SOURCE_SQL} の 1 行。 */
interface PublishedSourceRow {
  readonly title: string;
  readonly source_key: string | null;
}

/**
 * 画面を組み立てるのに要るものだけを集めた入力。
 *
 * **R2 のキーを持たない。** 画面の側に置き場所が無ければ、書き間違えても漏れようがない
 * （2.3.12 の「内部の識別子を出さない」）。
 */
export interface WorkSourceView {
  /** 作品 id（作品ページへ戻るリンクに使う。`games.id` そのもので、公開識別子である）。 */
  readonly gameId: string;
  /** 作品の題名（UGC。公開済みなので誰にでも出す）。 */
  readonly title: string;
  /** ソース本文。読めなかったら null。 */
  readonly source: string | null;
}

/**
 * ソースの閲覧の画面を組み立てる。
 *
 * **`escapeHtml` を通すのは題名とソースである。** ソースは生成物であり、文字列リテラルに
 * `</pre><script>` が入っていても不思議はない（8.3 は NG ワードを見るだけで、HTML を見ない）。
 *
 * @param view 表示に必要な値
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderWorkSourcePage(view: WorkSourceView, viewer: SiteViewer): string {
  const back = `<p><a href="${workPagePath(view.gameId)}">作品ページへ戻る</a></p>`;
  // **読めなかったときも 404 にしない。** 作品は公開済みで、ソースを出してよいことまでは
  // 決まっている——404 の「見つかりません」は「URL が違う」と読める（`src/work-page.ts` の
  // `removedSection` が取り下げた作品を 404 にしないのと同じ理由）。
  const body =
    view.source === null
      ? `<p>この作品のソースコードを、いま読み出せませんでした。時間をおいてもう一度お試しください。</p>`
      : `<p class="gf-source-note">この作品を作ったときに生成された Go のソースコードです。
   「このゲームを改造する」と、このソースをもとに新しい作品が作られます。</p>
<pre class="gf-source"><code>${escapeHtml(view.source)}</code></pre>`;
  // **検索避けする。** 拡散の着地点は作品ページであり（5.4）、ソースの画面が検索結果で
  // 作品ページと並ぶ理由が無い。リンクは作品ページから辿れる。
  return `${siteHead({
    title: `${view.title} のソースコード - Game Forge`,
    noindex: true,
    viewer,
  })}
<h1>${escapeHtml(view.title)} のソースコード</h1>
${back}
${body}
${siteFooter()}`;
}

/**
 * ソースを出せないときの応答。**理由を分けない**（このモジュール冒頭の表）。
 *
 * @param viewer いま見ている人の状態
 * @returns レスポンス
 */
function notFound(viewer: SiteViewer): Response {
  return html(
    `${siteHead({ title: 'ソースコードが見つかりません - Game Forge', noindex: true, viewer })}
<h1>ソースコードが見つかりません</h1>
<p>URL が正しいかご確認ください。</p>
${siteFooter()}`,
    404,
  );
}

/**
 * 公開済みの作品のソースを R2 から読む。**読めなければ null。**
 *
 * **上限は既定（5.3 の 64KB）のまま使う。** 公開済みの作品のソースは上限の内側にある
 * （上限を超えたフォークは整理のあとも超えれば断られる。確定18 の条件 3）。超えていたら
 * 「読めなかった」に倒す——**切り詰めて見せない**（`src/source-store.ts` の規約）。
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のキー（**呼ぶ側が {@link PUBLISHED_SOURCE_SQL} で資格を確かめたもの**）
 * @returns ソース本文、または null
 */
async function readPublishedSource(env: Env, sourceKey: string): Promise<string | null> {
  try {
    const result = await readStoredSource(env, sourceKey);
    if (!result.ok) {
      // **キーをログへ出さない**（内部の識別子）。理由は固定語彙なので出してよい。
      console.error(`[work-source] ソースを読めませんでした: ${result.reason}`);
      return null;
    }
    return result.source;
  } catch (error) {
    // R2 の障害。**画面ごと落とさない**——作品ページへ戻る道は残す。
    console.error(
      `[work-source] R2 からソースを読む途中で失敗しました: ${
        error instanceof Error ? error.name : 'unknown'
      }`,
    );
    return null;
  }
}

/**
 * ソースの閲覧を表示する。
 *
 * **ヘッダの出し分けは署名だけで決める**（`resolveSiteViewer`）。この画面は本人かどうかで
 * 中身が変わらないので、D1 の `users` を読む理由が無い。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWorkSource(request: Request, env: Env): Promise<Response> {
  const viewer = await resolveSiteViewer(request, env);
  const gameId = new URL(request.url).pathname.slice(WORK_SOURCE_PREFIX.length);
  if (!GAME_ID_PATTERN.test(gameId)) {
    return notFound(viewer);
  }

  const row = await env.DB.prepare(PUBLISHED_SOURCE_SQL)
    .bind(gameId, PUBLISHED_STATUS)
    .first<PublishedSourceRow>();
  if (row === null) {
    return notFound(viewer);
  }

  const source = row.source_key === null ? null : await readPublishedSource(env, row.source_key);
  return html(renderWorkSourcePage({ gameId, title: row.title, source }, viewer));
}

/** ソースの閲覧の経路（`GET /source/<game_id>`）。 */
export const workSourceRoutes: readonly Route[] = [
  { method: 'GET', path: WORK_SOURCE_PREFIX, match: 'prefix', handler: showWorkSource },
];
