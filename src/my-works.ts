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
 * **公開トップ（`/`）には置けない。** `src/home.ts` は「D1 を読まない」ことを設計として
 * 選び、テストで固定してある（3.6。トップは未ログインの閲覧者が最初に踏む経路で、
 * URL 拡散の着地点でもある）。一覧はログインした本人にしか出せないうえ、開くたびに
 * D1 を引く。**トップに混ぜると、その 2 つの性質が公開トップへ伝染する。**
 *
 * 専用ページとして、**作品ページ（`/works/<id>`）の親の位置**に置く。
 *
 * - **URL を 1 本でも覚えている人が、末尾を削るだけで一覧に着く。** この issue が
 *   解こうとしている問題そのものに、綴りが直接効く。
 * - 綴りの正本を増やさない（{@link MY_WORKS_PATH} は `WORK_PAGE_PREFIX` から導く）。
 *
 * `/works` を「みんなの作品」の索引にする案は採らない。他人の作品の一覧・タイムラインは
 * 11.2 が MVP の対象外としており（招待制で母数が小さく、URL 共有が主経路）、
 * **入るあてのないものに一等地を空けておく理由が無い。**
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
 * ## JavaScript もスタイルシートも要求しない
 *
 * MVP の画面は SSR の素の HTML に留める（9.3）。自動更新（`<meta http-equiv="refresh">`）も
 * 付けない。**生成中の作品を見張る画面は作品ページ（`/works/<id>`）が既に持っており**、
 * こちらまで再読み込みを続けると、開きっぱなしのタブが D1 の読み取りを増やし続ける。
 */
import { siteFooter } from './legal.js';
import type { AuthoredGame, GenerationState } from './games.js';
import { UNTITLED_TITLE, listAuthoredGames } from './games.js';
import { LOGIN_PATH } from './auth/google.js';
import { GENERATE_PAGE_PATH } from './paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/work-page.ts` もそこから取っている）。
import { escapeHtml, siteHead } from './html.js';
import { WORK_PAGE_PREFIX, looksStalled, workPagePath } from './work-page.js';

/**
 * 一覧のパス（`/works`）。
 *
 * **`WORK_PAGE_PREFIX` から導く。** `/works` と書き写すと、作品ページの綴りを変えた日に
 * **一覧だけが古い場所に残る**（`src/work-page.ts` は「綴りを持つのはこのモジュールだけ
 * である」と定めている）。一覧を作品ページの親の位置に置くという決定そのものを、
 * 導出の形で表しておく。
 *
 * 末尾の `/` を落とすので、経路表には**完全一致**で載る。前方一致の `/works/`（作品
 * ページ）とは鍵が別なので重複にならず、`dispatch` も完全一致を先に見る
 * （`src/routes.ts`）。
 */
export const MY_WORKS_PATH = WORK_PAGE_PREFIX.slice(0, -1);

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

/** JST の UTC からのずれ（秒）。日本には夏時間が無いため固定でよい。 */
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/**
 * UNIX 秒を ISO 8601 の文字列にする。**読めない値では例外を投げず null を返す。**
 *
 * # なぜ `Number.isFinite` だけでは足りないのか
 *
 * **`Date#toISOString()` は Date が範囲外のときに `RangeError` を投げる。** JavaScript の
 * Date が表せるのは ±8.64e15 ミリ秒（西暦 ±約 27 万年）までで、有限な数でもこの外に
 * 出れば `new Date(...)` は Invalid Date になり、`toISOString()` がそこで投げる。
 *
 * **投げると一覧全体が 500 になる。** `created_at` が想定外の値になった行が 1 つ
 * あるだけで、**他の作品まで見えなくなる。** #152 が作ろうとしているのは「URL を
 * 控えていなくても戻れる道」であり、1 行の異常で道ごと消える形はその性質と噛み合わない。
 * 日時は行の付加情報であって、行を出す条件ではない。
 *
 * 判定を `getTime()` の NaN で行うのは、**範囲外かどうかを桁で書き写さない**ためである
 * （境界値をこちらに複製すると、ランタイムの定義とずれても気づけない）。Date に作らせて、
 * 作れたかどうかを聞く。
 *
 * @param epochSeconds UNIX 秒
 * @param offsetSeconds 足すオフセット（秒）。既定は 0（UTC）
 * @returns ISO 8601 の文字列。読めない値なら null
 */
function isoFrom(epochSeconds: number, offsetSeconds = 0): string | null {
  if (!Number.isFinite(epochSeconds)) {
    return null;
  }
  const date = new Date((epochSeconds + offsetSeconds) * 1000);
  // Invalid Date（範囲外）はここで捕まる。`toISOString()` を呼ぶ前に落とす。
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

/**
 * UNIX 秒を日本時間の `YYYY-MM-DD HH:MM` にする。
 *
 * **`Intl` / `toLocaleString` を使わない。** ランタイムに積まれた ICU データの版で
 * 出力が変わりうるものを、テストで固定したい表示面へ持ち込まない。オフセットを足して
 * `toISOString` から切り出すほうが、**どの環境でも同じ文字列**になる。
 *
 * @param epochSeconds UNIX 秒
 * @returns 日本時間の表記（読めない値なら空文字）
 */
export function formatJstMinutes(epochSeconds: number): string {
  const iso = isoFrom(epochSeconds, JST_OFFSET_SECONDS);
  if (iso === null) {
    return '';
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * UNIX 秒を `<time datetime="...">` に入れる ISO 8601（UTC）にする。
 *
 * 表示は日本時間だが、**機械が読む属性には時差を含んだ絶対時刻を入れる。**
 *
 * @param epochSeconds UNIX 秒
 * @returns ISO 8601 の文字列（読めない値なら空文字）
 */
export function toIsoTimestamp(epochSeconds: number): string {
  return isoFrom(epochSeconds) ?? '';
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
  return (
    `  <li><a href="${workPagePath(work.id)}">${escapeHtml(displayTitleOf(work.title))}</a>` +
    ` — ${STATE_LABELS[state]}${created}</li>`
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
      ? `<p>まだ作品がありません。</p>
<p><a href="${GENERATE_PAGE_PATH}">最初のゲームを生成する</a></p>`
      : `<ul>
${view.works.map((work) => renderRow(work, view.now)).join('\n')}
</ul>`;

  // 上限に達したことを黙って隠さない。**「50 件ちょうど」と「51 件以上ある」を
  // 区別できる形で引いている**（`showMyWorks` が 1 件多く引く）ので、本当に
  // 溢れているときだけ出せる。
  const truncated = view.truncated
    ? `<p>新しい ${MAX_LISTED_WORKS} 件までを表示しています。</p>`
    : '';

  return `${siteHead({ title: 'あなたの作品 - Game Forge', noindex: true })}
<h1>あなたの作品</h1>
<p>生成中のものも含めて、新しい順に並んでいます。作品名を選ぶとその作品のページへ移ります。</p>
${body}
${truncated}
<p><a href="${GENERATE_PAGE_PATH}">新しく生成する</a></p>
${siteFooter()}`;
}

/**
 * 303 See Other を返す。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
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
    return seeOther(LOGIN_PATH);
  }

  const fetched = await listAuthoredGames(env, session.userId, MAX_LISTED_WORKS + 1);
  return html(
    renderMyWorksPage({
      works: fetched.slice(0, MAX_LISTED_WORKS),
      truncated: fetched.length > MAX_LISTED_WORKS,
      now: Math.floor(Date.now() / 1000),
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
