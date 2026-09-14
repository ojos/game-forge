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
 * 理由は 3 つある。
 *
 * 1. **いま削除は動いていない。** `terraform/r2-lifecycle.tf` は「年齢で消すルールは
 *    このバケットに置けない」と結論している（確定26。R2 のライフサイクルは `games` を
 *    引けないため、共有されうる成果物を年齢だけで消すと公開済みの作品が壊れる）。
 *    14 日の掃除は M5-4（#35。**未着手**）が持つ。**動いていない削除の残り日数を出すのは、
 *    出来ていないものを出来ているように書くことである**（`src/home.ts` /
 *    `src/work-page.ts` の `GENERATION_IS_SYNCHRONOUS` と同じ規範）。
 * 2. **消えるのは成果物であって、一覧の行ではない。** 掃除が消すのは R2 のオブジェクトで、
 *    `games` の行をどうするかは #35 がまだ決めていない。「あと N 日で消えます」は
 *    行が消えることを含意するが、**それが本当かどうかを今のこちらが知らない。**
 * 3. **いまは全件が未公開である**（公開の操作は M4-1 / #26 が持ち、未実装）。全行に同じ
 *    警告が並ぶ一覧は、区別を何も運ばない。**一覧の仕事は作品を見つけさせることであって、
 *    急かすことではない。**
 *
 * **代わりに生成日時を全行に出す。** これは今日も #35 のあとも変わらず真であり、
 * 「これは 12 日前のものだ」を利用者が自分で読める。**期限の主張をこちらがしないまま、
 * 期限の判断に要る事実だけを渡す**形にしてある。
 *
 * 出す条件が整うのは #35 が (a) 実際に掃除を走らせ、(b) `games` の行の扱いを決めた
 * ときである。**そのときこのモジュールへ残り日数を足す**（`createdAt` は既に出ている）。
 *
 * ## 統計と、今日の残り生成回数を置く（2.3.13 / #382）
 *
 * 一覧の上に、自分の作品の統計カードと「本日の残り生成枠 N回」を出す。**集計と描画は
 * `src/my-works-stats.ts` が持ち、残枠は生成画面と同じ経路から引く**
 * （`src/generate-page.ts` の `resolveAvailability`）。**利用者ごとの枠は 1 人 1 日 10 回の
 * 日次枠で、JST の 0 時に戻る**（4.4 / 確定25）。#382 の起票時は「今月の残量」と書いていたが、
 * **1 人あたりの月次の回数という値は仕様に無い**（同 issue の訂正）。
 *
 * ## JavaScript もスタイルシートも要求しない
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
 * 一覧に並べる最大件数。
 *
 * **50 件。** 3.6 は読み取りの単価が安いと言っているが、**一覧はページを開くたびに引く**
 * ので上限は要る。50 は次の 2 つから決めた。
 *
 * - **1 人の生成は 1 日 10 回まで**（確定25。#284 で 12 → 10）。50 件は 5 日分にあたり、
 *   「さっき作ったものが見当たらない」が起きない幅がある（**枠が減ったぶん、50 件で
 *   カバーできる日数はむしろ伸びた**）。
 * - 素の HTML で縦に並べて読める上限として、これ以上は「探す」より「たどる」画面になる。
 *
 * **超えた分は落とす。** ページ送りは作らない。作るべきかは、**実際に超える利用者が
 * 出てから**決める（超えていることは画面に出す。{@link renderMyWorksPage}）。
 */
export const MAX_LISTED_WORKS = 50;

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
  /** 並べる作品（新しい順。既に {@link MAX_LISTED_WORKS} 件へ切ってある）。 */
  readonly works: readonly AuthoredGame[];
  /** 上限を超えて作品があるか。 */
  readonly truncated: boolean;
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
 * 一覧の HTML を組み立てる。
 *
 * **`noindex` を付ける。** 本人にしか出ない画面であり、検索結果に現れる意味が無い
 * （`src/work-page.ts` と同じ扱い）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderMyWorksPage(view: MyWorksView): string {
  const body =
    view.works.length === 0
      ? `<div class="gf-block gf-my-works-empty">
<p>まだ作品がありません。</p>
<p><a href="${GENERATE_PAGE_PATH}">最初のゲームを生成する</a></p>
</div>`
      : `<ul class="gf-block gf-block-rows gf-works">
${view.works.map((work) => renderRow(work, view.now)).join('\n')}
</ul>`;

  // 上限に達したことを黙って隠さない。**「50 件ちょうど」と「51 件以上ある」を
  // 区別できる形で引いている**（`showMyWorks` が 1 件多く引く）ので、本当に
  // 溢れているときだけ出せる。
  const truncated = view.truncated
    ? `<p>新しい ${MAX_LISTED_WORKS} 件までを表示しています。</p>`
    : '';

  // **ログイン済みとして組む。** この画面は未ログインでは開けない（{@link showMyWorks} が
  // ログインへ送る）ので、**外枠のためにセッションを 2 度検証しない**（2.3.7 / #331）。
  //
  // **「新しく生成する」は見出しの行の右の主のボタン（小）で、この画面の主はこの 1 つだけ**（仕様 2.5.5 / #473。承認した
  // モックアップ Version 6）。「いいねした作品」「公開されている作品をさがす」は一覧の下の副のボタン（小）である。
  // **並びは HTML の順**（見出し → 新しく生成する → 説明 → 一覧 → 副のボタン）で、見た目の順と Tab の順が割れない。
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
${truncated}
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
 * **上限より 1 件多く引く。** 「ちょうど上限件あった」と「上限を超えている」は
 * 引いた件数だけでは区別できず、区別せずに注記を出すと**溢れていないのに溢れたと
 * 言う**ことになる。1 行余分に読むだけで区別が付く（3.6 の読み取り単価に対して
 * 無視できる）。
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
  const [fetched, stats, availability] = await Promise.all([
    listAuthoredGames(env, session.userId, MAX_LISTED_WORKS + 1),
    loadStatsOrNull(env, session.userId),
    resolveAvailability(env, session.userId),
  ]);
  return html(
    renderMyWorksPage({
      works: fetched.slice(0, MAX_LISTED_WORKS),
      truncated: fetched.length > MAX_LISTED_WORKS,
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
