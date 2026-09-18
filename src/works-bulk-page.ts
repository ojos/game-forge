/**
 * 「あなたの作品」の一括操作（#666）の画面——確認画面・結果の画面・断りの画面。
 *
 * **このモジュールは HTML を組むだけである**（D1 も判定も持たない。判定は `src/works-bulk-rules.ts`、経路は
 * `src/works-bulk.ts`）。
 *
 * ## 確認の中身を、1 件ずつのときから省かない（#666 の constraints）
 *
 * | 操作 | 1 件ずつのときの確認 | ここで出すもの |
 * |---|---|---|
 * | 公開 | 公開フォームの「ソースも誰でも読めるようになる」（`src/work-page.ts` の `PUBLISH_SOURCE_NOTICE`） | **同じ文をそのまま**と、公開をやめても元に戻らないこと |
 * | 下書きへ戻す | 作品ページの「公開をやめる」の説明（試遊 URL が作り直される・画像は撮り直す・フォークは残る） | 同じ事柄を、選んだ作品を主語にして |
 * | 削除 | 削除の確認画面（`src/work-delete.ts`） | **同じ関数の文**（`deletionConsequences`） |
 *
 * ## 対象から外す作品を、名前付きで見せる
 *
 * **押す前に、どの作品が外れるかと、その理由を並べる**（#666 の acceptance「対象外の作品を混ぜると、その作品を
 * 名前付きで示して除外する」）。**他人の作品と、行の無い作品は名前を出さない**——件数だけを言う（`not-found`。
 * 名前を出すと、任意の id の題名を読める口になる）。
 *
 * ## ボタン
 *
 * **確認画面には主のボタンを置かない**（`src/work-delete.ts` の確認画面と同じ判断——いちばんしてほしいことは
 * 「押す」ではなく「読んで決める」である）。実行は副のボタン、やめるのは一覧へ戻る `<a>`。
 */
import { escapeHtml, siteHead } from './html.js';
import type { SiteViewer } from './html.js';
import { siteFooter } from './legal.js';
import { deletionConsequences } from './work-delete.js';
import { PUBLISH_SOURCE_NOTICE } from './work-page.js';
import type { BulkAction, BulkReason } from './works-bulk-rules.js';
import { BULK_REASON_TEXTS, MAX_BULK_WORKS } from './works-bulk-rules.js';
import { MY_WORKS_PATH } from './works-paths.js';
import { WORKS_BULK_ACTION_FIELD, WORKS_BULK_API_PATH, WORKS_BULK_GAME_ID_FIELD } from './works-bulk-paths.js';

/** 操作ごとの言い回し。 */
const ACTION_WORDS: Readonly<
  Record<BulkAction, { readonly verb: string; readonly title: string; readonly done: string }>
> = {
  publish: { verb: '公開する', title: '選んだ作品を公開しますか', done: '公開しました' },
  unpublish: { verb: '下書きに戻す', title: '選んだ作品を下書きに戻しますか', done: '下書きに戻しました' },
  delete: { verb: '削除する', title: '選んだ作品を削除しますか', done: '削除しました' },
};

/** 確認画面・結果の画面に並べる 1 件。 */
export interface BulkListedWork {
  /** 作品 id。 */
  readonly id: string;
  /** 題名（UGC。**作者本人の作品のときだけ渡す**）。 */
  readonly title: string;
}

/** 対象から外す（または実行で断られた）1 件。 */
export interface BulkExcludedWork extends BulkListedWork {
  /** 理由（`not-found` は来ない。件数だけで {@link BulkPageView.notFound} へ数える）。 */
  readonly reason: Exclude<BulkReason, 'not-found'>;
}

/** 確認画面の入力。 */
export interface BulkConfirmView {
  /** 操作。 */
  readonly action: BulkAction;
  /** 対象にする作品（選んだ順）。 */
  readonly targets: readonly BulkListedWork[];
  /** 対象から外す作品（選んだ順）。 */
  readonly excluded: readonly BulkExcludedWork[];
  /** 見つからない作品の数（他人の作品・行の無い作品。名前は出さない）。 */
  readonly notFound: number;
}

/**
 * 操作ごとの「押すと起きること」（#666 の constraints。冒頭の表）。
 *
 * @param action 操作
 * @returns HTML（`<div>` の並び）
 */
export function bulkConsequences(action: BulkAction): string {
  switch (action) {
    case 'publish':
      return `<div>
<h3>公開すると</h3>
<ul>
  <li>URL を知っている人なら誰でも遊べるようになり、「作品をさがす」やタグの一覧にも並びます。</li>
  <li>${PUBLISH_SOURCE_NOTICE}</li>
  <li>紹介用の画像を撮影します（数分かかります）。</li>
  <li><strong>タグは、いま付いているタグのまま公開します</strong>（まとめてタグを付けることはできません。付け直すのは作品ページからです）。</li>
</ul>
</div>
<div>
<h3>公開をやめても元に戻らないこと</h3>
<ul>
  <li><strong>公開しているあいだにフォークされた作品は、あとで公開をやめても残ります。</strong></li>
  <li>公開日は、最初に公開した日のまま変わりません。</li>
  <li>公開しているあいだに読まれたソースコードや、遊んだ人の手元に残ったものは取り消せません。</li>
</ul>
</div>`;
    case 'unpublish':
      return `<div>
<h3>下書きに戻すと</h3>
<ul>
  <li>共有した URL からは遊べなくなり、「あなたの作品」の一覧には下書きとして並びます。下書きに戻した作品は、作り直したり、公開し直したり、削除したりできます。</li>
  <li><strong>試遊用の URL は新しいものに変わります</strong>（前の URL を知っている人は遊べなくなります）。</li>
  <li><strong>紹介用の画像は、次に公開したときに撮り直します。</strong></li>
</ul>
</div>
<div>
<h3>下書きに戻しても変わらないこと</h3>
<ul>
  <li><strong>選んだ作品をフォークした作品は、そのまま公開されたままです</strong>（連鎖して消えることはありません）。</li>
  <li>付いているタグと公開日は消えません（公開し直すと、最初に公開した日のまま並びます）。</li>
</ul>
</div>`;
    case 'delete':
      return deletionConsequences('選んだ作品');
  }
}

/**
 * 作品の名前の並び。**題名は UGC なので `escapeHtml` を通す。**
 *
 * @param works 作品
 * @returns `<ul>`
 */
function nameList(works: readonly BulkListedWork[]): string {
  return `<ul class="gf-works-bulk-list">
${works.map((work) => `  <li><strong>${escapeHtml(work.title)}</strong></li>`).join('\n')}
</ul>`;
}

/**
 * 外す作品の並び（名前と理由）。見つからない作品は名前を出さずに件数で言う（冒頭）。
 *
 * @param excluded 外す作品
 * @param notFound 見つからない作品の数
 * @returns `<ul>`（無ければ空文字）
 */
function excludedList(excluded: readonly BulkExcludedWork[], notFound: number): string {
  const items = excluded.map(
    (work) => `  <li><strong>${escapeHtml(work.title)}</strong> — ${BULK_REASON_TEXTS[work.reason]}</li>`,
  );
  if (notFound > 0) {
    items.push(`  <li>見つからない作品 ${notFound} 件 — ${BULK_REASON_TEXTS['not-found']}</li>`);
  }
  return items.length === 0 ? '' : `<ul class="gf-works-bulk-list">\n${items.join('\n')}\n</ul>`;
}

/**
 * 一覧へ戻る導線。
 *
 * @param label 文言
 * @returns HTML
 */
function backLink(label: string): string {
  return `<p><a href="${MY_WORKS_PATH}">${label}</a></p>`;
}

/**
 * 確認画面（`GET /works/mine/bulk`）の HTML。
 *
 * **送るフォームには、対象にする作品だけを入れる**（外す作品の id は載せない）。実行の口も同じ判定をもう一度掛け、
 * 最後は 1 件ずつの口と同じ関数が断る（`src/works-bulk-rules.ts` の冒頭）。
 *
 * @param view 表示に要る値
 * @param viewer いま見ている人の状態
 * @returns HTML
 */
export function renderBulkConfirmation(view: BulkConfirmView, viewer: SiteViewer): string {
  const words = ACTION_WORDS[view.action];
  const excludedCount = view.excluded.length + view.notFound;
  const excludedSection =
    excludedCount === 0
      ? ''
      : `<h2>対象から外す作品（${excludedCount} 件）</h2>
<p>次の作品は${words.verb}ことができないため、対象から外します。</p>
${excludedList(view.excluded, view.notFound)}`;

  if (view.targets.length === 0) {
    return `${siteHead({ title: `${words.title} - Game Forge`, noindex: true, viewer })}
<h1>${words.verb}ことができる作品がありません</h1>
${excludedSection}
${backLink('「あなたの作品」へ戻る')}
${siteFooter()}`;
  }

  const hidden = view.targets
    .map((work) => `  <input type="hidden" name="${WORKS_BULK_GAME_ID_FIELD}" value="${work.id}">`)
    .join('\n');
  return `${siteHead({ title: `${words.title} - Game Forge`, noindex: true, viewer })}
<h1>${words.title}</h1>
<h2>対象の作品（${view.targets.length} 件）</h2>
${nameList(view.targets)}
${excludedSection}
<section class="gf-block gf-block-rows gf-work-settings" aria-label="${words.verb}前の確認">
${bulkConsequences(view.action)}
<div>
<form method="post" action="${WORKS_BULK_API_PATH}">
  <input type="hidden" name="${WORKS_BULK_ACTION_FIELD}" value="${view.action}">
${hidden}
  <button type="submit" class="gf-button gf-button-secondary">${view.targets.length} 件を${words.verb}</button>
</form>
${backLink(`${words.verb}のをやめて「あなたの作品」へ戻る`)}
</div>
</section>
${siteFooter()}`;
}

/**
 * 作品が選ばれていないときの画面（`GET /works/mine/bulk` を選択なしで開いたとき）。**200 で返す**——選ばずに
 * 押したのは操作の誤りではなく、一覧へ戻って選べば済む（断りの 4xx にしない）。
 *
 * @param viewer いま見ている人の状態
 * @returns HTML
 */
export function renderBulkNothingSelected(viewer: SiteViewer): string {
  return `${siteHead({ title: 'まとめて操作する作品を選んでください - Game Forge', noindex: true, viewer })}
<h1>まとめて操作する作品を選んでください</h1>
<p class="gf-block">作品が選ばれていません。「あなたの作品」の表で作品を選んでから、「公開する」「下書きに戻す」「削除する」のどれかを押してください（一度に ${MAX_BULK_WORKS} 件まで選べます）。</p>
${backLink('「あなたの作品」へ戻る')}
${siteFooter()}`;
}

/** 結果の画面の入力。 */
export interface BulkResultView {
  /** 操作。 */
  readonly action: BulkAction;
  /** 成功した件数。 */
  readonly done: number;
  /** 断られた作品（名前付き。選んだ順）。 */
  readonly failed: readonly BulkExcludedWork[];
  /** 見つからなかった作品の数（名前は出さない）。 */
  readonly notFound: number;
  /** 操作はできたが、後の処理（撮影・通知など）で例外が出た作品（成功の件数に含まれる）。 */
  readonly afterErrors: readonly BulkListedWork[];
}

/**
 * 結果の画面（`POST /api/works/bulk` の最後の往復）の HTML。
 *
 * **一部だけ失敗したら、どの作品が失敗したかを名前付きで示す**（#666 の constraints）。**成功の件数は実行の口が D1 の
 * 状態から数えたもの**である（`src/works-bulk.ts` の `handleBulk`）。POST の結果なので
 * ヘッダのナビとパンくずは出さない（`viewer` を渡さない。`src/html.ts` の `siteHeader`）。
 *
 * @param view 表示に要る値
 * @returns HTML
 */
export function renderBulkResult(view: BulkResultView): string {
  const words = ACTION_WORDS[view.action];
  const failedCount = view.failed.length + view.notFound;
  const heading =
    failedCount === 0
      ? `${view.done} 件を${words.done}`
      : view.done === 0
        ? `${words.verb}ことができませんでした`
        : `${view.done} 件を${words.done}（${failedCount} 件はできませんでした）`;
  const failedSection =
    failedCount === 0
      ? ''
      : `<h2>${words.verb}ことができなかった作品（${failedCount} 件）</h2>
${excludedList(view.failed, view.notFound)}`;
  const afterSection =
    view.afterErrors.length === 0
      ? ''
      : `<h2>後の処理に失敗した作品（${view.afterErrors.length} 件）</h2>
<p>${BULK_REASON_TEXTS['post-error']}作品ページを開いて確かめてください。</p>
${nameList(view.afterErrors)}`;
  return `${siteHead({ title: `${heading} - Game Forge`, noindex: true })}
<h1>${heading}</h1>
${failedSection}${afterSection}
<p><a class="gf-button gf-button-secondary" href="${MY_WORKS_PATH}">「あなたの作品」へ戻る</a></p>
${siteFooter()}`;
}

/**
 * 断りの画面（形の誤り・件数の上限）。
 *
 * @param heading 見出し
 * @param body 本文
 * @param viewer いま見ている人の状態（POST の断りでは省く）
 * @returns HTML
 */
export function renderBulkRefusal(heading: string, body: string, viewer?: SiteViewer): string {
  return `${siteHead({ title: `${heading} - Game Forge`, noindex: true, viewer })}
<h1>${heading}</h1>
<p class="gf-block">${body}</p>
${backLink('「あなたの作品」へ戻る')}
${siteFooter()}`;
}
