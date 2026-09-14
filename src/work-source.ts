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
import { MAX_SOURCE_BYTES } from './source-size.js';

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
  /** ソース本文、または読めなかった理由。 */
  readonly source: WorkSourceContent;
}

/**
 * ソースの中身（#383）。**読めなかった理由を畳まない**——一時的に読めない（もう一度開けば
 * 読めるかもしれない）ことと、上限を超えていて何度開いても読めないことでは、利用者への
 * 案内が変わる（`src/source-store.ts` の「上限超を『読めなかった』と同じ扱いにしない」）。
 *
 * - `missing` … R2 に実体が無い・空・キーが NULL・R2 の障害。**やり直す価値がある**
 * - `too-large` … 5.3 の上限を超えている。**何度やっても表示できない**
 */
export type WorkSourceContent =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large' };

/**
 * 文字の向きを変える書式文字（Unicode の `Bidi_Control`。#383）。
 *
 * **判定の組は `src/profile.ts` の `DIRECTION_CHARACTER` と同じ `\p{Bidi_Control}` である**
 * （あちらは自己紹介で弾く。こちらは表示のときに見える形へ置き換える）。組が揃っていることは
 * `test/work-source.test.ts` が、`validateBio` が弾く文字の組と突き合わせて確かめる
 * （import しないのは、あちらの非公開の定数だから）。
 */
const DIRECTION_CONTROL = /\p{Bidi_Control}/gu;

/**
 * エスケープ済みのソースの中の `Bidi_Control` を、見える印（`⟨U+202E⟩`）に置き換える（#383）。
 *
 * # なぜ要るのか
 *
 * 生成されたソースの文字列やコメントに `U+202E`（右から左への上書き）などが入ると、**画面に
 * 見えている並びと、コンパイラが読む並びが食い違う**（いわゆる Trojan Source）。閲覧は
 * 「どんなコードか」を読むための画面なので、**見えない文字で読み違えさせない。**
 *
 * # 表示のときだけ置き換える
 *
 * **R2 の生のソース（フォークで渡るもの）は変えない。** ここは画面の文字列だけを作る。
 *
 * # `escapeHtml` の後に置き換える
 *
 * **入力はエスケープ済みの文字列である。** 印は固定の ASCII と `⟨⟩` と `<span>` だけで、
 * 生成物由来の文字を 1 つも含まない。先に置き換えると、印の `<span>` がエスケープされて
 * `&lt;span` になる。`Bidi_Control` は `escapeHtml` が触る 5 文字に含まれないので、
 * エスケープの後でも同じ位置に残っている。
 *
 * @param escaped `escapeHtml` を通したソース
 * @returns 印に置き換えた HTML
 */
export function markDirectionControls(escaped: string): string {
  return escaped.replace(DIRECTION_CONTROL, (character) => {
    const code = `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    return `<span class="gf-source-bidi" title="文字の向きを変える制御文字 ${code}">⟨${code}⟩</span>`;
  });
}

/** 上限（5.3）を KB で言う。**値を書き写さない**（`MAX_SOURCE_BYTES` から作る）。 */
const MAX_SOURCE_KB = Math.floor(MAX_SOURCE_BYTES / 1024);

/** 一時的に読めなかったときの文言。テストが同じ綴りを見るために export している。 */
export const SOURCE_MISSING_NOTICE =
  'この作品のソースコードを、いま読み出せませんでした。時間をおいてもう一度お試しください。';

/**
 * 上限を超えていて表示できないときの文言。**再試行を促さない**（何度開いても同じである）。
 * テストが同じ綴りを見るために export している。
 */
export const SOURCE_TOO_LARGE_NOTICE =
  `この作品のソースコードは、表示できる大きさ（${MAX_SOURCE_KB}KB）を超えているため表示できません。`;

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
  // **「作品ページへ戻る」は小さい副のボタン**（移動なので `<a>`。仕様 2.5.5 / #473）。この画面に主のボタンは無い。
  const back = `<p><a class="gf-button gf-button-secondary gf-button-sm" href="${workPagePath(view.gameId)}">作品ページへ戻る</a></p>`;
  // **読めなかったときも 404 にしない。** 作品は公開済みで、ソースを出してよいことまでは
  // 決まっている——404 の「見つかりません」は「URL が違う」と読める（`src/work-page.ts` の
  // `removedSection` が取り下げた作品を 404 にしないのと同じ理由）。
  //
  // **`<pre>` はキーボードで横に送れるようにする**（`tabindex="0"`）。中身がはみ出して横に
  // スクロールする領域は、焦点を持てないとマウスやタッチでしか読めない。焦点が入ったときに
  // 何の領域かが読み上げで分かるよう、名前を付ける（`aria-label`）。
  const body =
    view.source.kind === 'missing'
      ? `<p>${SOURCE_MISSING_NOTICE}</p>`
      : view.source.kind === 'too-large'
        ? `<p>${SOURCE_TOO_LARGE_NOTICE}</p>`
        : `<p class="gf-source-note">この作品を作ったときに生成された Go のソースコードです。
   「このゲームをフォークする」と、このソースをもとに新しい作品が作られます。</p>
<pre class="gf-source" tabindex="0" aria-label="ソースコード"><code>${markDirectionControls(escapeHtml(view.source.text))}</code></pre>`;
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
 * 公開済みの作品のソースを R2 から読む。**読めなければ理由を返す。**
 *
 * **上限は既定（5.3 の 64KB）のまま使う。** 公開済みの作品のソースは上限の内側にある
 * （上限を超えたフォークは整理のあとも超えれば断られる。確定18 の条件 3）。超えていたら
 * `too-large` を返す——**切り詰めて見せない**（`src/source-store.ts` の規約）。
 *
 * @param env バインディングと環境変数
 * @param sourceKey R2 のキー（**呼ぶ側が {@link PUBLISHED_SOURCE_SQL} で資格を確かめたもの**）
 * @returns ソース本文、または読めなかった理由
 */
async function readPublishedSource(env: Env, sourceKey: string): Promise<WorkSourceContent> {
  try {
    const result = await readStoredSource(env, sourceKey);
    if (!result.ok) {
      // **キーをログへ出さない**（内部の識別子）。理由は固定語彙なので出してよい。
      console.error(`[work-source] ソースを読めませんでした: ${result.reason}`);
      return result.reason === 'source-too-large' ? { kind: 'too-large' } : { kind: 'missing' };
    }
    return { kind: 'ok', text: result.source };
  } catch (error) {
    // R2 の障害。**画面ごと落とさない**——作品ページへ戻る道は残す。
    console.error(
      `[work-source] R2 からソースを読む途中で失敗しました: ${
        error instanceof Error ? error.name : 'unknown'
      }`,
    );
    return { kind: 'missing' };
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

  // **キーが NULL の公開作品は、一時的に読めないものとして扱う**（不変条件に寄りかからない。
  // {@link PUBLISHED_SOURCE_SQL}）。
  const source: WorkSourceContent =
    row.source_key === null ? { kind: 'missing' } : await readPublishedSource(env, row.source_key);
  return html(renderWorkSourcePage({ gameId, title: row.title, source }, viewer));
}

/** ソースの閲覧の経路（`GET /source/<game_id>`）。 */
export const workSourceRoutes: readonly Route[] = [
  { method: 'GET', path: WORK_SOURCE_PREFIX, match: 'prefix', handler: showWorkSource },
];
