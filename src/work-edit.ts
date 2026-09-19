/**
 * エディットページ（`/works/<game_id>/edit`。#664 / レイアウト改修 1/3）。
 *
 * ## なぜ作品ページから分けたのか
 *
 * 作品ページ（`/works/<id>`）は、見る人が作者かどうかと作品の状態で表示を切り替える 1 ページだった。**そのため作者は、
 * 作者以外に見えている画面を確かめられなかった。** YouTube が視聴ページ（`watch`）と Studio の「動画の詳細」を
 * 別ページにしているのに倣い、**作者の編集用の画面を別の URL へ切り出した**（2026-09-18 の利用者の決定）。
 * 作品ページは作者にも作者以外と同じ画面を出し、作者に足すのは「編集する」の 1 行だけである（`src/work-page.ts`）。
 *
 * ## 置くもの
 *
 * - **右上の「保存」「変更を元に戻す」**——作品名・説明・タグ・公開設定を 1 つのフォームでまとめて送る
 *   （`src/work-save.ts`）。**確認は公開設定を変えたときだけ出す。** 「変更を元に戻す」は素の `type="reset"` で、
 *   送る前の入力を開いたときの値へ戻す（JavaScript を要求しない）
 * - **左に作品名・説明・タグ、右にゲームのプレビュー・試遊 URL／共有 URL・公開設定**（Studio の「動画の詳細」の配置）。
 *   段 3（1080px〜）でだけ横に並び、狭い段では縦に積む（器の `.gf-split-edit`。`public/assets/app.css` の `@section shell`）
 * - **生成中・失敗・取り下げ済みの表示、リフォージ、版の履歴、削除、作者向けの注意書き**（遮断された分類・権利の開示・
 *   撮影の中断）——作品ページから移した。描画の部品は `src/work-page.ts` のものをそのまま借りる（同じ判定の値で描く）
 * - **Studio の左端のアイコン列は置かない。** 「作品ページで見る」「あなたの作品へ戻る」のリンクで代わりにする
 *
 * ## 作者以外は、作品ページへ 303 で送り返す（#690）
 *
 * **作者以外・未ログインがこの URL を開いたら、作品ページ（`/works/<id>`）へ 303 で送り返す**（#690。2026-09-19 の
 * 利用者の決定）。作品が有る・無い・未公開のどれでも同じ 303 で、送り返した先が 200 か 404 かを決める。
 *
 * - **URL を変えずに作品ページと同じ応答を返すのをやめた**（#664 / PR #671 の決め。下の旧記述）。#673 の本番確認で、
 *   完成した下書きの `/edit` を作者以外が開くと、作品ページの状態表示（「できました／まだ公開されていません」）が
 *   `/edit` の URL のまま出た。**編集の URL に作品ページの画面が出るのは、それだけで誤った情報である。**
 * - **エディットページがあることは漏らさない**（#664 の意図は保つ）。作者以外への応答は、作品の有無と状態に
 *   関わらず 303 の 1 通りで、送り先の `/works/<id>` を開いたときと同じものを見る。**作品が無い id でも送る**
 *   （ここで 404 を返すと、「有る id は 303、無い id は 404」の差から存在が読める）。
 * - **一時的な送り返し（303）にする。** 301 にすると、後でログインした作者のブラウザにも送り返しが残る。
 * - **ログインへ送ることはしない**（作者かどうかはログインしないと分からない。送り返した先の見出しからログインできる）。
 * - 送り返した先で未公開の状態を言い分けないのは作品ページの側である（`src/work-page.ts` の `sectionFor`。#690）。
 *
 * 旧記述（#664。#690 で改めた）: **作者以外・未ログインがこの URL を開いたら、作品ページ（`/works/<id>`）を開いたときと
 * 同じ応答を返す**（#664 の constraints）。とくに下書きは、**エディットページがあることも漏らさない**——404 にすると
 * 「作品ページは 200、エディットページは 404」の差から何かが読めるので、そもそも差を作らない。ログインへ送ることも
 * しない（送ると、未ログインの人にだけ別の応答になる）。
 *
 * ## JavaScript を要求しない
 *
 * 作品ページと同じ方針である（`src/work-page.ts` の冒頭）。フォームは素の `<form method="post">`、ボタンがフォームの
 * 外（右上）にあるのは `form` 属性で結ぶ。プレビューの埋め込みだけはスクリプトが作るが、JavaScript を切っても
 * `<noscript>` の中の埋め込みで遊べる（`src/work-play.ts`）。
 */
import { DESCRIPTION_CHANGE_INTERVAL_SECONDS, MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, WORK_TAGS_CHANGE_INTERVAL_SECONDS, workTagsOf } from './games.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { workPagePath } from './paths.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import type { Route } from './routes.js';
import { knownWorkTags } from './work-card.js';
import { MAX_WORK_TAGS } from './work-tags.js';
import { playEmbed, playEntry } from './work-play.js';
import {
  DRAFT_PLAY_PANEL,
  REFRESH_SECONDS,
  createWorkPageRoutes,
  deleteSection,
  ipNoticeSection,
  keyLegendSection,
  loadWorkView,
  recaptureSection,
  reviseSection,
  revisionList,
  sectionFor,
  seeOther,
  settingsBlock,
  tagChoices,
  workNameOf,
} from './work-page.js';
import type { WorkPageView } from './work-page.js';
import {
  WORK_SAVE_DESCRIPTION_FIELD,
  WORK_SAVE_GAME_ID_FIELD,
  WORK_SAVE_PATH,
  WORK_SAVE_TITLE_FIELD,
  WORK_SAVE_VISIBILITY_FIELD,
} from './work-save.js';
import { MY_WORKS_PATH } from './works-paths.js';

/**
 * 副のボタンと主のボタン（仕様 2.5.5）。**主は「保存」の 1 つだけ**である。
 *
 * **同じファイルに文字列の定数として持つ**（`test/button-parts.test.ts` は、`<button>` のクラスを同じファイルの定数まで
 * 解いて部品のクラスを確かめる。`src/work-page.ts` と同じ値である）。
 */
const SECONDARY_BUTTON = 'gf-button gf-button-secondary';
const PRIMARY_BUTTON = 'gf-button gf-button-primary';

/**
 * まとめて保存するフォームの `id`。**右上のボタンと、右の公開設定の入力が `form` 属性でこれを指す。**
 *
 * **綴りを 1 か所に持つ**（書き写すと、片方だけを直した日に押しても何も送らないボタンになる。4.4）。
 */
export const WORK_EDIT_FORM_ID = 'work-edit-form';

/** パンくずの「あなたの作品」の名前（`src/my-works.ts` の見出しと同じ語）。 */
export const MY_WORKS_BREADCRUMB_LABEL = 'あなたの作品';

/** エディットページの入力（#664）。 */
export interface WorkEditView {
  /** 作品の状態と作者だけの口（`src/work-page.ts` の `loadWorkView` を `edit` で組み立てたもの）。 */
  readonly work: WorkPageView;
  /** 作品 id。 */
  readonly gameId: string;
  /** いまの作品名（`games.title`）。 */
  readonly title: string;
  /**
   * いまの説明（`games.description`。無ければ空文字）。
   *
   * **下書きでも入れる**——公開をやめて下書きへ戻した作品は説明を持っている（5.4 の #636）。作品ページの
   * `WorkPageView.description` は公開後の画面に出すものなので、下書きでは null になる。
   */
  readonly description: string;
  /** いまのタグ（語彙にあるものだけ）。 */
  readonly tags: readonly string[];
}

/**
 * エディットページの HTML を組み立てる（#664）。
 *
 * **`escapeHtml` を通すのは利用者の入力（作品名・説明）である。** 他はこのモジュールと `src/work-page.ts` が持つ
 * 固定の文字列か、形を確かめた id と URL である。
 *
 * @param view 表示に必要な値
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderWorkEditPage(view: WorkEditView, viewer: SiteViewer): string {
  const work = view.work;
  // **生成中・リフォージ中だけ自動更新する**（作品ページと同じ条件。`src/work-page.ts` の `renderWorkPage`）。
  const refresh =
    work.state === 'working' || work.state === 'stalled' || work.revisionRunning
      ? `\n<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
      : '';
  const editable = work.state === 'ready' && !work.removed;
  return `${siteHead({
    title: `${workNameOf(work)} の編集 - Game Forge`,
    // **エディットページは検索に出さない**（作者だけの画面である）。
    noindex: true,
    beforeTitle: refresh,
    viewer,
    // **パンくずは「トップ › あなたの作品 › ○○ の編集」にする**（2026-09-18 の利用者の決定。PR #671）。URL から導くと
    // 公開作品の一覧（`/works`）の下に出るが、作者がたどってきたのは「あなたの作品」である。
    breadcrumbParents: [{ path: MY_WORKS_PATH, label: MY_WORKS_BREADCRUMB_LABEL }],
  })}
<div class="gf-edit-bar">
<h1>作品の編集</h1>${editable ? editActions() : ''}
</div>
${editLinks(view, editable)}${ipNoticeSection(work)}${editable ? editorSection(view) : sectionFor(work)}
${siteFooter()}`;
}

/**
 * 右上の「変更を元に戻す」と「保存」（#664）。**フォームの外に置き、`form` 属性で結ぶ**（Studio と同じ右上の位置）。
 *
 * **主のボタンは「保存」だけである**（仕様 2.5.5「1 画面に 1 つまで」）。「変更を元に戻す」は `type="reset"` で、
 * 送る前の入力を開いたときの値へ戻す——**保存した値を戻すものではない**（戻すなら版の履歴か、値を書き直して保存する）。
 *
 * @returns HTML
 */
function editActions(): string {
  return `
<div class="gf-edit-actions">
  <button type="reset" form="${WORK_EDIT_FORM_ID}" class="${SECONDARY_BUTTON}">変更を元に戻す</button>
  <button type="submit" form="${WORK_EDIT_FORM_ID}" class="${PRIMARY_BUTTON}">保存</button>
</div>`;
}

/**
 * 「作品ページで見る」「あなたの作品へ戻る」（#664。Studio の左端のアイコン列の代わり）。
 *
 * **作品ページへのリンクは、できあがった作品にだけ出す。** 生成中・失敗・取り下げ済みの作品を作者が作品ページで開くと
 * ここへ戻される（`src/work-page.ts` の `showWorkPage`）ので、押しても同じ画面に戻るリンクを出さない（4.4）。
 *
 * @param view 表示に必要な値
 * @param editable 編集できる状態か（できあがっていて、取り下げていない）
 * @returns HTML
 */
function editLinks(view: WorkEditView, editable: boolean): string {
  const page = editable
    ? `<a class="gf-link-quiet" href="${workPagePath(view.gameId)}">作品ページで見る</a>`
    : '';
  return `<p class="gf-edit-links">${page}<a class="gf-link-quiet" href="${MY_WORKS_PATH}">あなたの作品へ戻る</a></p>
`;
}

/**
 * できあがった作品の編集画面（#664）。
 *
 * **左に作品名・説明・タグ（まとめて保存するフォーム）、右にプレビュー・URL・公開設定を置く。** その下に、
 * 作者だけの設定（撮り直し・リフォージ・版・削除）を 1 つのブロックの行で並べる（作品ページの #474 の形のまま）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function editorSection(view: WorkEditView): string {
  const work = view.work;
  return `<div class="gf-split-edit">
${detailsForm(view)}
<div class="gf-edit-side">
${previewBlock(work)}${urlBlock(work)}
${visibilityField(work)}
</div>
</div>${settingsBlock([recaptureSection(work), reviseSection(work), revisionList(work), deleteSection(work)])}`;
}

/**
 * 作品名・説明・タグのフォーム（#664。まとめて保存する口へ送る）。
 *
 * - **`maxlength` を付けない**（HTML はUTF-16 の長さで数え、こちらの規則はコードポイントで数える。#366 / #388 と同じ）。
 *   作品名は超えた分を切り詰め、説明は超えたら断る——押す前に文言で知らせる
 * - **説明とタグは下書きのままでも保存できる**（#673。まとめて保存する口が `allowDraft` を渡す）。下書きでは、
 *   **保存しても作者にしか見えず、公開したときにそのまま出る**ことを先に言う（説明の欄の「誰でも読めます」は
 *   公開後の話なので、下書きでは言い換える）
 * - **`cols` を付けない**（狭い端末で layout viewport を広げる。#282）
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function detailsForm(view: WorkEditView): string {
  const published = view.work.published;
  const draftNote = published
    ? ''
    : `
  <p class="gf-edit-hint"><strong>下書きのあいだは、説明とタグはあなたにだけ見えます。</strong>公開すると、保存しておいた説明とタグがそのまま作品ページと作品をさがす画面に出ます。</p>`;
  const readers = published
    ? '<strong>作品ページを開いた人なら誰でも読めます。</strong>'
    : '<strong>公開すると、作品ページを開いた人なら誰でも読めます。</strong>';
  return `<form id="${WORK_EDIT_FORM_ID}" class="gf-edit-main gf-block" method="post" action="${WORK_SAVE_PATH}">
  <input type="hidden" name="${WORK_SAVE_GAME_ID_FIELD}" value="${view.gameId}">
  <div class="gf-edit-field">
    <label for="work-title">作品名</label>
    <input id="work-title" name="${WORK_SAVE_TITLE_FIELD}" type="text" value="${escapeHtml(view.title)}" required>
    <p class="gf-edit-hint">${MAX_TITLE_LENGTH} 文字を超えた分は切り詰めます。変わるのは名前だけで、作品の中身は変わりません。</p>
  </div>
  <div class="gf-edit-field">
    <label for="work-description">説明</label>
    <textarea id="work-description" name="${WORK_SAVE_DESCRIPTION_FIELD}" rows="8">${escapeHtml(view.description)}</textarea>
    <p class="gf-edit-hint">遊び方や、使った素材・原作のクレジットなどを書けます。${readers}${MAX_DESCRIPTION_LENGTH} 文字まで。改行はそのまま出ます（リンクや太字などの書式は使えません）。変更は ${DESCRIPTION_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。</p>
  </div>
  <div class="gf-edit-field">
${tagChoices('edit-tag', view.tags)}
    <p class="gf-edit-hint">作品をさがす画面で、選んだタグから絞り込まれるようになります。${MAX_WORK_TAGS} 個まで選べます。変更は ${WORK_TAGS_CHANGE_INTERVAL_SECONDS} 秒に 1 回までです。</p>
  </div>${draftNote}
</form>`;
}

/**
 * 公開済みの作品のプレビューの「遊ぶ」の口に置く、固定の文言のパネル（#664）。**タッチ端末でだけ見せる**
 * （`.gf-work-draft-play`。デスクトップはすぐ下に埋め込みがある）。下書きの側は {@link DRAFT_PLAY_PANEL} を使う。
 */
const PUBLISHED_PLAY_PANEL = '<p class="gf-shot gf-shot-pending">作者のプレビューです。ここで遊んでもプレイ数には数えません。</p>';

/**
 * ゲームのプレビュー（#664。Studio の右上の動画の位置）。
 *
 * **作品ページと同じ遊び方にする**（#575 / 仕様 3.9.4）。デスクトップはこの枠の中に埋め込み、タッチ端末は「遊ぶ」で
 * 全画面の覆い・仮想パッド・向き。**公開済みでも計上のスクリプトは置かない**——作者の試遊をプレイ数に数えない
 * （数えるのは作品ページの `/g/` の iframe だけ。#377）。
 *
 * **リフォージの実行中は埋め込まず、リンクだけにする**（画面が {@link REFRESH_SECONDS} 秒ごとに再読み込みされ、
 * 埋め込んだゲームも覆いもそのたびに落ちる。#575 と同じ判断）。
 *
 * @param work 作品の値
 * @returns HTML
 */
function previewBlock(work: WorkPageView): string {
  if (work.playUrl === null) {
    return `<section class="gf-edit-preview" aria-label="プレビュー">
<p class="gf-block">作品は完成していますが、遊ぶための URL を組み立てられませんでした。</p>
</section>`;
  }
  if (work.revisionRunning) {
    return `<section class="gf-edit-preview" aria-label="プレビュー">
<p class="gf-block"><a href="${work.playUrl}">いまの版を遊ぶ</a>（リフォージが終わると、この場所で遊べるようになります）</p>
</section>`;
  }
  return `<section class="gf-edit-preview" aria-label="プレビュー">
<div class="gf-work-draft-play">
${playEntry(work.published ? PUBLISHED_PLAY_PANEL : DRAFT_PLAY_PANEL, true)}
</div>
${playEmbed(work.playUrl, work.workId, work.inputKeyCodes, work.inputHeldCodes, work.inputAliasGroups, work.playOrientation)}${keyLegendSection(work)}
</section>`;
}

/**
 * 試遊 URL（下書き）か共有 URL（公開）（#664）。
 *
 * **試遊 URL は作者本人にだけ出す**（`preview_key` は unlisted 配信の唯一の資格情報。5.4）。公開後は配る URL を
 * 作品ページの 1 本にする（5.4 の「配る URL は 1 本でよい」）。
 *
 * @param work 作品の値
 * @returns HTML（出す URL が無ければ空文字）
 */
function urlBlock(work: WorkPageView): string {
  if (work.published) {
    return work.shareUrl === null
      ? ''
      : `
<div class="gf-work-share">
<p class="gf-work-share-label">共有する URL</p>
<p class="gf-block gf-work-share-url"><code>${work.shareUrl}</code></p>
</div>`;
  }
  return work.playUrl === null
    ? ''
    : `
<div class="gf-work-share">
<p class="gf-work-share-label">試遊 URL（あなただけが知っている URL です）</p>
<p class="gf-block gf-work-share-url"><code>${work.playUrl}</code></p>
<p class="gf-edit-hint">この URL を人に渡すと、公開する前に遊んでもらえます。</p>
</div>`;
}

/**
 * 公開設定（#664。まとめて保存するフォームへ `form` 属性で結ぶ）。
 *
 * **選べるのは下書きと公開の 2 つである**（`removed` は運営の措置と退会の専用状態で、作者は選べない。5.4 の #636）。
 * **変えて保存すると確認の画面が出る**ことを、押す前に書く（`src/work-save.ts`）。
 *
 * @param work 作品の値
 * @returns HTML
 */
function visibilityField(work: WorkPageView): string {
  const draft = work.published ? '' : ' checked';
  const published = work.published ? ' checked' : '';
  return `<fieldset class="gf-edit-visibility gf-block">
  <legend>公開設定</legend>
  <label for="visibility-draft"><input id="visibility-draft" type="radio" name="${WORK_SAVE_VISIBILITY_FIELD}" value="draft" form="${WORK_EDIT_FORM_ID}"${draft}> 下書き</label>
  <p class="gf-edit-hint">あなたにだけ見えます。試遊 URL を渡した人は遊べます。</p>
  <label for="visibility-published"><input id="visibility-published" type="radio" name="${WORK_SAVE_VISIBILITY_FIELD}" value="published" form="${WORK_EDIT_FORM_ID}"${published}> 公開</label>
  <p class="gf-edit-hint">誰でも見られます。ソースコードも読めるようになり、ほかの人がフォークできます。</p>
  <p class="gf-edit-hint">公開設定を変えて保存すると、確認の画面が出ます。</p>
</fieldset>`;
}

/**
 * ログインしている作者本人が見ているかを、作品の `author_id` 1 列とセッションだけで確かめる（#664 / PR #671）。
 *
 * **未ログインなら D1 を 1 行も読まない**（セッションの cookie が無ければ `resolveSessionUser` は D1 に行かない）。
 * 作品が無いときも false を返す（作者以外と同じく作品ページへ送り返し、送り先が 404 を返す。#690）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id（綴りは入口が確かめてある）
 * @returns 作者本人なら true
 */
async function isAuthor(request: Request, env: Env, gameId: string): Promise<boolean> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return false;
  }
  const row = await env.DB.prepare('select author_id from games where id = ?')
    .bind(gameId)
    .first<{ author_id: string }>();
  return row !== null && row.author_id === session.userId;
}

/**
 * エディットページを開く（`GET /works/<id>/edit`。#664）。
 *
 * **作者本人でなければ、作品ページ（`/works/<id>`）へ 303 で送り返す**（#690。このモジュールの冒頭）。作品が無い id
 * でも同じく送る（送り先が 404 を返す）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param gameId 作品 id（綴りは入口が確かめてある）
 * @returns レスポンス
 */
export async function showWorkEditPage(request: Request, env: Env, gameId: string): Promise<Response> {
  // **作者かどうかを軽い 1 文で先に確かめる**（PR #671 の Copilot の指摘）。`edit` の読み込みは通報の状態・いいね（DO）・
  // フォークの近傍・生成枠まで引くので、作者以外に先に走らせると、作品ページの処理がもう一度同じものを読み、他人や
  // クローラーが開くたびに D1 と DO の読みが倍になる。**作者でなければ重い読み込みをせずに作品ページへ送り返す**（#690）。
  if (!(await isAuthor(request, env, gameId))) {
    return seeOther(workPagePath(gameId));
  }
  const loaded = await loadWorkView(request, env, gameId, 'edit');
  if (loaded.kind === 'not-found' || !loaded.owner) {
    // 2 つの読み取りの間に作者が変わることは無い（`author_id` は作成後に変わらない）が、含意に寄りかからない。
    // **作者以外と同じ 303 にする**（#690。ここだけ別の応答にすると、作者以外への応答が 1 通りでなくなる）。
    return seeOther(workPagePath(gameId));
  }
  return html(
    renderWorkEditPage(
      {
        work: loaded.view,
        gameId,
        title: loaded.row.title,
        description: loaded.row.description ?? '',
        tags: knownWorkTags(workTagsOf(loaded.row)).map((tag) => tag.id),
      },
      loaded.viewer,
    ),
  );
}

/**
 * 作品ページ・エディットページ・削除の確認画面と、作品に対する POST の口（#150 / #517 / #664）。
 *
 * **アプリの経路表（`src/app.ts`）はこれを連結する**（`src/work-page.ts` の `workPageRoutes` ではない。あちらは
 * エディットページを持たない形で、単体テストのために残してある）。
 */
export const workRoutes: readonly Route[] = createWorkPageRoutes(showWorkEditPage);
