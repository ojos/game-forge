/**
 * 「あなたの作品」一覧（`/works`）。**URL を控えていなくても自分の作品へ戻れる道である**
 * （5.5 / #152）。
 *
 * ## なぜこの画面が要るのか
 *
 * #150 は送信した瞬間に作品の恒久的な URL（`/works/<id>`）を返すようにした。**しかし
 * URL だけでは足りない。** 控え損ねる経路が普通にある——タブごと閉じた、別の端末で
 * 見たい、しばらく経ってから思い出した。**91 秒待った成果物へ戻る道が URL 1 本しか
 * ないのは細すぎる。** これは #150 が「失うものが無い」と言えるための最後の 1 本である。
 *
 * ## 置き場所を `/works` にした理由
 *
 * **公開トップ（`/`）には置けない。** この一覧はログインした本人にしか出せず、
 * **本人にしか出せないものを、URL 拡散の着地点に混ぜない。**
 *
 * > **#328 注記。** 起票時（#152）はここに「`src/home.ts` は「D1 を読まない」ことを
 * > 設計として選んでいる」という根拠も並べていた。**その根拠のほうは 2.3.3 で解けている**
 * > （トップは条件付きで D1 を読む）。**置けない理由は上の 1 点に絞られた。**
 *
 * 専用ページとして、**作品ページ（`/works/<id>`）と同じ接頭辞の下**に置く。
 *
 * - 綴りの正本を増やさない（{@link MY_WORKS_PATH} の正本は `src/works-paths.ts` である）。
 *
 * **#328 で `/works` から `/works/mine` へ移した。** 起票時（#152）は「`/works` を
 * 「みんなの作品」の索引にする案は採らない。11.2 が MVP の対象外としており、
 * 入るあてのないものに一等地を空けておく理由が無い」と書いていた。**その「入るあて」が
 * 来た**（仕様 2.3。11.2 の「タイムライン」は取り消していない——置いたのは個人向けに
 * 並ぶタイムラインではなく、全員に同じものが出るカタログである）。
 *
 * ## 他人の作品を 1 行も出さない
 *
 * 5.4 は「「公開」操作で初めて URL が有効になる」と定める。**一覧がその抜け道に
 * なってはいけない。** 絞り込みは SQL の `where author_id = ?` に置き（`src/games.ts` の
 * {@link listAuthoredGames}）、この画面は**絞り込み済みのものを描くだけ**にしてある。
 * 画面側で `filter` する形にすると、書き忘れても自分の作品は正しく出るので**動作では
 * 気づけない。**
 *
 * ## 「もうすぐ消える」を出さない（#152 で決めた）
 *
 * 3.7 / 確定13 は「未公開のまま 14 日で自動削除」と定める。**それでも残り日数は出さない。**
 * 理由は 2 つある（#152 の時点では 3 つ書いていた。うち 2 つ（行の扱いが未定・全件が未公開）は成り立たなくなったので外した——下の #517 注記）。
 *
 * 1. **いま 14 日の自動削除は動いていない。** `terraform/r2-lifecycle.tf` は「年齢で消すルールは
 *    このバケットに置けない」と結論している（確定26。R2 のライフサイクルは `games` を
 *    引けないため、共有されうる成果物を年齢だけで消すと公開済みの作品が壊れる）。
 *    **`games` を引いて消す定期実行の置き場所は、まだ無い**（仕様 3.7 の #516 注記）。**動いていない削除の残り日数を
 *    出すのは、出来ていないものを出来ているように書くことである**（`src/home.ts` /
 *    `src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS` と同じ規範）。
 * 2. **期限の主張をこちらがしないまま、判断に要る事実だけを渡す。** 一覧の仕事は作品を見つけさせることで
 *    あって、急かすことではない。
 *
 * **代わりに生成日時を全行に出す。** これは今日も自動削除のあとも変わらず真であり、
 * 「これは 12 日前のものだ」を利用者が自分で読める。
 *
 * 出す条件が整うのは、14 日の自動削除が実際に走るようになったときである。**そのときこのモジュールへ
 * 残り日数を足す**（`createdAt` は既に出ている）。
 *
 * > **#517 注記（2026-09-15）。古くなった記述を直した。** #152 の時点では、上の理由に次の 2 つを書いていた。
 * > **どちらも今は成り立たない。**
 * >
 * > - 「掃除が消すのは R2 のオブジェクトで、`games` の行をどうするかは #35 がまだ決めていない」——**作品 1 件を
 * >   消すときに行を残すか消すかは #516 が決めた**（仕様 5.3 の「中身を消した tombstone」。子か運営の記録が
 * >   あれば行を残して中身を消し、どちらも無ければ行ごと消す）
 * > - 「いまは全件が未公開である（公開の操作は M4-1 / #26 が持ち、未実装）」——**公開・取り下げ（#26 / #35）は
 * >   実装済み**である
 * >
 * > また、**作者は下書きと取り下げた作品を、作品ページから削除できるようになった**（#517。確認画面は
 * > `src/work-delete.ts`、経路は `src/work-page.ts`）。**この一覧には削除の口を置かない**（#517 の scope.out）。
 * > **一覧の問い合わせは変えていない**——`listAuthoredGames` は `status <> 'removed'` で引くので、取り下げた作品も、
 * > 行を残して中身を消した作品も出ず、行ごと消した作品はそもそも引けない。
 *
 * ## 統計と、今日の残り生成回数を置く（2.3.13 / #382）
 *
 * 一覧の上に、自分の作品の統計カードと「本日の残り生成枠 N回」を出す。**集計と描画は
 * `src/my-works-stats.ts` が持ち、残枠は生成画面と同じ経路から引く**
 * （`src/generate-page.ts` の `resolveAvailability`）。**利用者ごとの枠は 1 人 1 日 10 回の
 * 日次枠で、JST の 0 時に戻る**（4.4 / 確定25）。#382 の起票時は「今月の残量」と書いていたが、
 * **1 人あたりの月次の回数という値は仕様に無い**（同 issue の訂正）。
 *
 * ## JavaScript を要求しない
 *
 * > **#517 注記。** #152 の時点の見出しは「JavaScript もスタイルシートも要求しない」だった。**スタイルシートは
 * > M8（#266）から全画面が `siteHead` で読む**ので、見出しから外した（JavaScript を要求しないことは変わらない）。
 *
 * MVP の画面は SSR の素の HTML に留める（9.3）。自動更新（`<meta http-equiv="refresh">`）も
 * 付けない。**生成中の作品を見張る画面は作品ページ（`/works/<id>`）が既に持っており**、
 * こちらまで再読み込みを続けると、開きっぱなしのタブが D1 の読み取りを増やし続ける。
 */
import { siteFooter } from './legal.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import type { AuthoredGame, GenerationState } from './games.js';
import { UNTITLED_TITLE, listAuthoredGames } from './games.js';
// 残枠は生成画面と同じ経路で引き、同じ文言で出す（2.3.13「数え方を 2 か所に持たない」/ #382）。
import { availabilityNotice, resolveAvailability } from './generate-page.js';
import type { MyWorksStats } from './my-works-stats.js';
import { loadMyWorksStats, renderMyWorksStats } from './my-works-stats.js';
import { loginRequiredRedirect } from './auth/google.js';
import { GENERATE_PAGE_PATH } from './paths.js';
// **「いいねした作品」への導線はここに置く**（2.3.7 / 5.8 / #340）。v1.57 でヘッダの
// アカウントのメニューにも入った（#372）が、メニューは閉じているので本文の導線は残す。
// 綴りは値だけの葉から取る（`src/liked-works-paths.ts`。あちらの冒頭が置き場の理由）。
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from './works-paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/work-page.ts` もそこから取っている）。
import { escapeHtml, headerAvatarUrl, siteHead, siteViewerAt } from './html.js';
import { looksStalled, workPagePath } from './work-page.js';

/**
 * 「あなたの作品」のパス（`/works/mine`）。
 *
 * **#328 で `/works` から移した。** `/works` は公開作品の一覧になった（仕様 2.3.2）。
 * **#152 の「末尾を削れば一覧に着く」は失われていない**——着く先が、共有 URL を踏んだ
 * 未ログインの閲覧者にとって意味のある行き先になった。
 *
 * **正本は `src/works-paths.ts` である**（公開一覧の側が移設の案内でこの綴りを出すため、
 * 値を持ち合うと循環参照になる。`src/paths.ts` に置かない理由は、Lambda の束に入る
 * からである——#336。あちらの冒頭）。ここから再輸出するのは、既にこのモジュールから
 * 読んでいる箇所を動かさないためである。
 */
export { MY_WORKS_PATH };

/**
 * 1 頁に並べる件数。
 *
 * **20 件**（#552）。作品をさがす（`src/works-list.ts` の `WORKS_PER_PAGE`）・いいねした作品と
 * 同じ件数で、利用者が画面ごとに「1 頁に何件か」を覚えなくて済む。
 *
 * > **#552 注記（2026-09-15）。50 件で切る扱いをやめた。** #152 の時点では `MAX_LISTED_WORKS`
 * > （50 件）まで並べて超えた分を落とし、「新しい 50 件までを表示しています」とだけ出していた。
 * > 頁送りは「実際に超える利用者が出てから決める」としていた。**#459 の実機確認で、31 件の
 * > 作品を持つ利用者が「作品の一覧にページングが必要」とメモした**——超える前に、1 頁に並ぶ
 * > 件数そのものが読みにくかった。そこで、作品をさがすと同じ形の頁送りに置き換えた。
 *
 * **値をあちらから借りない**（`src/liked-works.ts` の `LIKED_WORKS_PER_PAGE` と同じ判断）。
 * 借りると「作品をさがすの件数を変えたら、この一覧も変わる」という結び付きが生まれる。
 */
export const MY_WORKS_PER_PAGE = 20;

/**
 * 頁数の上限。
 *
 * **`OFFSET` は読み飛ばした行も数える**（`src/works-list.ts` の `MAX_PAGE` と同じ理由）。
 * 上限が無いと `?page=999999` の 1 本で、作者の索引の上を長く走らせられる。
 *
 * **50 頁（＝1,000 件）。** 作品をさがすと同じ値である。**1 人の生成は 1 日 10 回まで**
 * （確定25）なので、1,000 件は毎日使い切って 100 日分にあたる。**ここに当たる利用者が
 * 出たら、頁送りではなく続きの鍵で辿る形（keyset）へ変える時期である**
 * （`src/works-list.ts` が同じことを書いている）。
 */
export const MAX_MY_WORKS_PAGE = 50;

/**
 * `?page=` の名前。**作品をさがす・いいねした作品と同じ綴りにする**（利用者が頁の綴りを
 * 画面ごとに覚えない）。
 */
export const MY_WORKS_PAGE_PARAM = 'page';

/**
 * `?page=` を頁番号へ落とす（#552）。
 *
 * **落とすのであって、失敗させない**（`src/works-list.ts` の `toPageNumber` と同じ扱い）。
 * 手で書き換えた URL が 400 を返すより、1 頁目が出るほうがよい。
 *
 * **上限（{@link MAX_MY_WORKS_PAGE}）を超える値も 1 頁目にする**（#552 の acceptance）。
 * ここは作品をさがす（上限の頁へ寄せる）と違う。この一覧の上限は「そこまで作品を
 * 持つ利用者がまだいない」値であり、上限を超えた番号は手で書き換えた URL と見なして、
 * 読めない値と同じく先頭へ戻す。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 1 以上 {@link MAX_MY_WORKS_PAGE} 以下の整数
 */
export function toMyWorksPageNumber(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MY_WORKS_PAGE) {
    return 1;
  }
  return parsed;
}

/**
 * この一覧の URL を組み立てる。
 *
 * **1 頁目には `?page=` を付けない**（`src/liked-works.ts` の `likedWorksPath` と同じ扱い）。
 * 1 頁目の URL が 2 通りにならず、見出しやヘッダの導線（`MY_WORKS_PATH`）と同じ綴りになる。
 *
 * @param page 頁番号
 * @returns アプリ用ホスト上の絶対パス
 */
export function myWorksPath(page: number): string {
  return page <= 1 ? MY_WORKS_PATH : `${MY_WORKS_PATH}?${MY_WORKS_PAGE_PARAM}=${page}`;
}

/**
 * 一覧に出す状態の短い名前。
 *
 * **`src/work-page.ts` の文言を再利用しない。** あちらは 1 件だけを見ている人に向けた
 * 説明文（「生成が終わるまで、このタブを開いたままにしてください」）で、こちらは
 * **複数行を見比べるための札**である。長さも役割も違うものを共有すると、どちらかに
 * 合わない文言を両方が我慢することになる（work-page が generate-page の文言を
 * 再利用しなかったのと同じ判断）。
 *
 * 一方、**「止まっているかもしれない」の判定そのものは共有する**（`looksStalled`）。
 * あれは表示の文言ではなく閾値の判断であり、2 か所に置くとずれる。
 */
const STATE_LABELS = {
  working: '生成中',
  stalled: '生成中（時間がかかっています）',
  ready: 'できました',
  failed: '生成できませんでした',
  unknown: '状態を読み取れません',
} as const;

/** 一覧の行に出す状態。 */
type RowState = keyof typeof STATE_LABELS;

/**
 * `generation_state` を一覧の行の状態へ落とす。
 *
 * **D1 の綴りをそのまま表示の分岐に使わない**（`src/work-page.ts` と同じ方針）。
 * CHECK があるので知らない値は通常入らないが、コードを戻した・進めた状況では
 * ありうる。**「生成中」と言い続けるより、分からないと言うほうがよい。**
 *
 * @param state D1 の `generation_state`
 * @param stalled 生成中で、かつ止まっている可能性が高いか
 * @returns 行の状態
 */
export function rowStateOf(state: string, stalled: boolean): RowState {
  const known: readonly GenerationState[] = ['pending', 'running', 'ready', 'failed'];
  if (!(known as readonly string[]).includes(state)) {
    return 'unknown';
  }
  if (state === 'ready') {
    return 'ready';
  }
  if (state === 'failed') {
    return 'failed';
  }
  return stalled ? 'stalled' : 'working';
}

/**
 * 行に出すタイトルを決める。
 *
 * `games.title` は `NOT NULL` で、生成の経路は必ず非空の仮タイトルを入れる
 * （`src/games.ts` の `draftTitleFromPrompt`）。**それでも空を扱えるようにしておく**のは、
 * 別の経路で作られた行や、この不変条件より前に作られた行が無地の `<li>` になるのを
 * 防ぐためである（**不変条件を画面が前提にしない**。`src/work-page.ts` と同じ方針）。
 *
 * @param title D1 の `title`
 * @returns 画面に出すタイトル（空にならない）
 */
export function displayTitleOf(title: string): string {
  return title.trim() === '' ? UNTITLED_TITLE : title;
}

/**
 * 一覧の 1 行を組み立てる。
 *
 * **`escapeHtml` を通すのはタイトルだけである。** 他はこのモジュールが持つ固定の文字列か、
 * `games.id`（`crypto.randomUUID()` の出力）である。仮タイトルはプロンプト由来の
 * 利用者入力で、**この画面が D1 の値を HTML へ入れる唯一の場所**である。
 *
 * @param work 作品 1 件
 * @param now 現在時刻（UNIX 秒）
 * @returns `<li>` 1 つ
 */
function renderRow(work: AuthoredGame, now: number): string {
  const stalled = looksStalled({ createdAt: work.createdAt, startedAt: work.startedAt }, now);
  const state = rowStateOf(work.generationState, stalled);
  const iso = toIsoTimestamp(work.createdAt);
  // **読めない日時では `<time>` ごと落とす。** `datetime=""` は仕様上不正であり、
  // 空の属性を出すくらいなら出さないほうがよい。行そのものは残る（作品へ辿れることが
  // この一覧の仕事で、日時はその付加情報である）。
  const created = iso === '' ? '' : ` <time datetime="${iso}">${formatJstMinutes(work.createdAt)}</time>`;
  // **状態の札はチップの部品で、まだ動いている行（生成中・時間がかかっている）だけ地を塗る**（`.gf-chip-emphasis`。仕様 2.5.5 / #473）。
  // 区別は色ではなく文言が言う（無彩色）。題名は文章の外のリンク（`.gf-link-quiet`。一覧の行の題名。2.5.5）。
  const chip = state === 'working' || state === 'stalled' ? 'gf-chip gf-chip-emphasis' : 'gf-chip';
  return (
    `  <li><a class="gf-link-quiet gf-works-title" href="${workPagePath(work.id)}">${escapeHtml(displayTitleOf(work.title))}</a>` +
    ` <span class="${chip}">${STATE_LABELS[state]}</span>${created}</li>`
  );
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface MyWorksView {
  /** 並べる作品（新しい順。既に {@link MY_WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly AuthoredGame[];
  /** 頁番号（1 始まり。{@link toMyWorksPageNumber} を通した値）。 */
  readonly page: number;
  /** 次の頁があるか。 */
  readonly hasNext: boolean;
  /** 現在時刻（UNIX 秒）。 */
  readonly now: number;
  /** 統計カードの数（2.3.13 / #382）。読めなかったときは null。 */
  readonly stats: MyWorksStats | null;
  /**
   * 残枠の文言（4.4）。**生成画面が `id="generate-quota"` に出すものと同じ文字列である**
   * （`src/generate-page.ts` の `availabilityNotice`）。
   */
  readonly quotaNotice: string;
  /** ヘッダのアバターの画像の URL（#380。`src/html.ts` の `headerAvatarUrl`）。 */
  readonly headerAvatar: string | null;
}

/**
 * 頁送りと、作品が 0 本のときの導線に当てる小さい副のボタン（仕様 2.5.5。#474）。
 * 見た目の正本は `public/assets/app.css` の `@section buttons` で、ここは当てる部品の名前だけを持つ。
 */
const SMALL_SECONDARY_BUTTON = 'gf-button gf-button-secondary gf-button-sm';

/**
 * 頁送りを組み立てる（#552）。
 *
 * **作品をさがす（`src/works-list.ts`）・いいねした作品（`src/liked-works.ts`）の頁送りと同じ形である。**
 * 小さい副のボタンにし、「次」は右端に寄せる（`.gf-pager-next`。仕様 2.5.5 / #474）——前が無い 1 頁目でも、
 * 次へ進む口の位置が頁によって動かない。**DOM の順は前 → 次のまま**（見た目の順＝Tab の順）。
 * 無限スクロールも JavaScript も足さない（9.3）。押しても何も起きない導線を出さない（次が無ければ「次」を出さない）。
 *
 * @param view 表示に必要な値
 * @returns HTML。前も次も無ければ空文字
 */
function renderPager(view: MyWorksView): string {
  const links: string[] = [];
  if (view.page > 1) {
    links.push(
      `<a class="${SMALL_SECONDARY_BUTTON}" href="${myWorksPath(view.page - 1)}">前の ${MY_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (view.hasNext) {
    links.push(
      `<a class="${SMALL_SECONDARY_BUTTON} gf-pager-next" href="${myWorksPath(view.page + 1)}">次の ${MY_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join('\n')}</nav>`;
}

/**
 * 一覧の HTML を組み立てる。
 *
 * **`noindex` を付ける。** 本人にしか出ない画面であり、検索結果に現れる意味が無い
 * （`src/work-page.ts` と同じ扱い）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderMyWorksPage(view: MyWorksView): string {
  // **作品が 0 本のときの「最初のゲームを生成する」は小さい副のボタン**（PR #505 の Copilot code review）。見出しの行の主
  // 「新しく生成する」と同じ行き先で、素のリンクのままだと主と並んで強さの違う導線が 2 つになる。作品をさがすの空の知らせの
  // 「最初の 1 本を作る」（`src/works-list.ts`）と同じ形である。
  //
  // **2 頁目以降で空なのは「まだ作品が無い」ではない**（#552。作品を消して頁が減った後の古い URL など）。
  // 「まだ作品がありません」と言うと、作品を持つ本人に画面が嘘をつく（`src/liked-works.ts` の範囲の外の頁と同じ扱い）。
  const body =
    view.works.length > 0
      ? `<ul class="gf-block gf-block-rows gf-works">
${view.works.map((work) => renderRow(work, view.now)).join('\n')}
</ul>`
      : view.page === 1
        ? `<div class="gf-block gf-my-works-empty">
<p>まだ作品がありません。</p>
<p class="gf-my-works-empty-action"><a class="${SMALL_SECONDARY_BUTTON}" href="${GENERATE_PAGE_PATH}">最初のゲームを生成する</a></p>
</div>`
        : `<p class="gf-block">この頁に並ぶ作品がありません。</p>`;

  // **ログイン済みとして組む。** この画面は未ログインでは開けない（{@link showMyWorks} が
  // ログインへ送る）ので、**外枠のためにセッションを 2 度検証しない**（2.3.7 / #331）。
  //
  // **「新しく生成する」は見出しの行の右の主のボタン（小）で、この画面の主はこの 1 つだけ**（仕様 2.5.5 / #473。承認した
  // モックアップ Version 6）。「いいねした作品」「公開されている作品をさがす」は一覧の下の副のボタン（小）である。
  // **並びは HTML の順**（見出し → 新しく生成する → 説明 → 一覧 → 頁送り → 副のボタン）で、見た目の順と Tab の順が割れない。
  // 頁送りを一覧の直後に置くのは、作品をさがす・いいねした作品と同じ位置である（#552）。
  return `${siteHead({
    title: 'あなたの作品 - Game Forge',
    noindex: true,
    viewer: siteViewerAt(MY_WORKS_PATH, true, view.headerAvatar),
  })}
<h1>あなたの作品</h1>
${renderMyWorksStats(view.stats, view.quotaNotice)}
<div class="gf-heading-row">
<h2>作品の一覧</h2>
<a class="gf-button gf-button-primary gf-button-sm" href="${GENERATE_PAGE_PATH}">新しく生成する</a>
</div>
<p>生成中のものも含めて、新しい順に並んでいます。作品名を選ぶとその作品のページへ移ります。</p>
${body}
${renderPager(view)}
<p class="gf-works-links"><a class="gf-button gf-button-secondary gf-button-sm" href="${LIKED_WORKS_PATH}">いいねした作品</a>
<a class="gf-button gf-button-secondary gf-button-sm" href="${PUBLIC_WORKS_PATH}">公開されている作品をさがす</a></p>
${siteFooter()}`;
}

/**
 * 統計を引く。**読めなかったときは null を返し、画面ごと落とさない。**
 *
 * 統計は一覧の付加情報である。**この画面の仕事は作品へ戻る道であり**（冒頭）、
 * 集計 1 本の失敗でその道まで 500 にしない（`src/generate-page.ts` の
 * `resolveAvailability` が残枠で同じ判断をしている）。**「0 本」とは兼ねない**——
 * 読めなかったことを別の文言で出す（`src/my-works-stats.ts` の `STATS_UNAVAILABLE_NOTICE`）。
 *
 * @param env バインディングと環境変数
 * @param userId 対象の利用者
 * @returns 統計。読めなかったときは null
 */
async function loadStatsOrNull(env: Env, userId: string): Promise<MyWorksStats | null> {
  try {
    return await loadMyWorksStats(env, userId);
  } catch (error) {
    // 例外の種類だけを出す（利用者の作品名はここに無いが、D1 のメッセージに SQL が載る）。
    console.error(
      `[my-works] 統計を取得できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return null;
  }
}

/**
 * 一覧を表示する。
 *
 * **未ログインならログインへ送る。** 401 の JSON を返しても、画面を開いた利用者に
 * できることは結局ログインなので、そこまでを 1 往復で済ませる
 * （`src/invite-issuance.ts` の `showInvitePage` と同じ扱い）。
 *
 * **1 頁の件数より 1 件多く引く**（#552。いまの作法のまま）。「ちょうど 20 件で終わる」と
 * 「21 件目がある」は引いた件数だけでは区別できず、区別せずに「次の 20 件」を出すと
 * **押しても空の頁へ行く導線**になる。1 行余分に読むだけで区別が付く（3.6 の読み取り
 * 単価に対して無視できる）。**統計と残枠は頁によらず同じものを引き、どの頁にも出す。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showMyWorks(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // ログイン後はこの画面へ戻す（2.3.11 / #374）。戻り先は署名付きの一時 cookie が
    // 運ぶ（query では受けない）。
    return await loginRequiredRedirect(env, MY_WORKS_PATH);
  }

  // **3 つは互いに依存しないので並べて引く。** 一覧・統計（集計 1 回）・残枠
  // （生成画面と同じ経路。`resolveAvailability` は読めなくても投げない）。
  const page = toMyWorksPageNumber(new URL(request.url).searchParams.get(MY_WORKS_PAGE_PARAM));
  const [fetched, stats, availability] = await Promise.all([
    listAuthoredGames(env, session.userId, MY_WORKS_PER_PAGE + 1, (page - 1) * MY_WORKS_PER_PAGE),
    loadStatsOrNull(env, session.userId),
    resolveAvailability(env, session.userId),
  ]);
  return html(
    renderMyWorksPage({
      works: fetched.slice(0, MY_WORKS_PER_PAGE),
      page,
      // 上限の頁では「次」を出さない（{@link MAX_MY_WORKS_PAGE}。出しても 1 頁目へ戻るだけの導線になる）。
      hasNext: fetched.length > MY_WORKS_PER_PAGE && page < MAX_MY_WORKS_PAGE,
      now: Math.floor(Date.now() / 1000),
      stats,
      quotaNotice: availabilityNotice(availability),
      headerAvatar: headerAvatarUrl(request, env, session.userId),
    }),
  );
}

/**
 * 一覧の経路（#152）。
 *
 * `src/app.ts` の経路表へ連結する。**完全一致で登録する**（作品ページの前方一致
 * `/works/` とは別の鍵になる。{@link MY_WORKS_PATH}）。
 */
export const myWorksRoutes: readonly Route[] = [
  { method: 'GET', path: MY_WORKS_PATH, handler: showMyWorks },
];
