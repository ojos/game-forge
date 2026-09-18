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
 * なってはいけない。** 絞り込みは SQL の `where author_id = ?` に置き（#152 のときは `src/games.ts` の
 * `listAuthoredGames`、#666 からは `src/my-works-query.ts` の `listMyWorks`）、この画面は**絞り込み済みのものを描くだけ**にしてある。
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
 * > **#666 注記。** 一括操作（公開・下書きへ戻す・削除）の口を置いた。押しても消えず、確認画面を経て 1 件ずつの口と
 * > 同じ関数を通る（`src/works-bulk.ts`）。
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
 * ## YouTube Studio 型の表にした（#666。2026-09-18）
 *
 * **1 作品 1 行の表にし、作品ごとの状態と数（プレイ・いいね・フォークされた数）と公開日を一覧で見比べられるようにした。**
 * 列は 選択・紹介用の画像・作品名とタグ・状態・日付・プレイ・いいね・フォークされた数 の 8 つで、YouTube Studio の
 * 「チャンネルのコンテンツ」から借りたのは**配置だけ**である（色・枠線・影は仕様 2.5 のまま。無彩色で、面の色で区切る）。
 *
 * - **状態で絞り込み（`?state=`）、30 件ずつ頁を送る**（`?page=`）。行の問い合わせは `src/my-works-query.ts` が持つ
 *   （`src/games.ts` はオーケストレータの束に入るので触らない）
 * - **統計は表の上の横 1 行の帯に詰め、注記は折りたたむ**（`src/my-works-stats.ts`）
 * - **選んだ作品をまとめて公開・下書きへ戻す・削除できる。** 表は素の GET のフォームで、押すと確認画面
 *   （`src/works-bulk.ts`）へ移る。**ここでは何も書き換えない**
 * - **狭い段ではカード表示にする。** 表の要素のまま、狭い段の既定を「1 行 = 1 枚のカード」にし、段 2（768px〜）で
 *   表に戻す（`public/assets/app.css` の `@section shell` の「#666:」の塊。幅の `@media` はそこにしか置かない）
 *
 * **各行の行き先はエディットページ（`/works/<id>/edit`）である**（#664 が変えた行き先を、表でも保つ。#666 の scope.in「各行はエディットページへ移る」）。
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
import type { GenerationState } from './games.js';
import { UNTITLED_TITLE } from './games.js';
// 残枠は生成画面と同じ経路で引き、同じ文言で出す（2.3.13「数え方を 2 か所に持たない」/ #382）。
import { availabilityNotice, resolveAvailability } from './generate-page.js';
import type { MyWorksStats } from './my-works-stats.js';
import { loadMyWorksStats, renderMyWorksStats } from './my-works-stats.js';
import type { MyWorkRow, MyWorksFilter } from './my-works-query.js';
import { MY_WORKS_FILTERS, MY_WORKS_FILTER_PARAM, listMyWorks, toMyWorksFilter } from './my-works-query.js';
import { loginRequiredRedirect } from './auth/google.js';
import { GENERATE_PAGE_PATH } from './paths.js';
import { OGP_IMAGE_HEIGHT, OGP_IMAGE_WIDTH, ogpImagePath } from './ogp.js';
// **「いいねした作品」への導線はここに置く**（2.3.7 / 5.8 / #340）。v1.57 でヘッダの
// アカウントのメニューにも入った（#372）が、メニューは閉じているので本文の導線は残す。
// 綴りは値だけの葉から取る（`src/liked-works-paths.ts`。あちらの冒頭が置き場の理由）。
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import { knownWorkTags } from './work-card.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from './works-paths.js';
import {
  MY_WORKS_BULK_PATH,
  WORKS_BULK_ACTION_FIELD,
  WORKS_BULK_GAME_ID_FIELD,
} from './works-bulk-paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
// `escapeHtml` の正本は `src/signup.ts` である（`src/work-page.ts` もそこから取っている）。
import { escapeHtml, headerAvatarUrl, siteHead, siteViewerAt } from './html.js';
import { looksStalled } from './work-page.js';
// **各行はエディットページへ移る**（#664。綴りは Lambda が import しない葉から取る）。
import { workEditPath } from './work-edit-paths.js';

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
 * **30 件**（#666）。YouTube Studio の「チャンネルのコンテンツ」の既定の件数に揃えた。**一括操作で一度に選べる件数の
 * 上限も同じ値である**（`src/works-bulk.ts` の `MAX_BULK_WORKS`）——選べるのは 1 頁に並んだ作品だけなので、
 * 上限を 1 頁の件数より大きくしても意味が無く、小さくすると「全部選んで押したら断られる」になる。
 *
 * > **#666 注記（2026-09-18）。20 件から 30 件へ変えた。** #552 は作品をさがす・いいねした作品と同じ 20 件にし、
 * > 「利用者が画面ごとに 1 頁の件数を覚えなくて済む」を理由にしていた。表にして 1 行が低くなり、1 画面に並ぶ件数が
 * > カードの画面と揃わなくなったので、Studio の値を採った（2026-09-18 の会話で決めた）。
 *
 * **値をあちらから借りない**（`src/liked-works.ts` の `LIKED_WORKS_PER_PAGE` と同じ判断）。
 */
export const MY_WORKS_PER_PAGE = 30;

/**
 * 頁数の上限。
 *
 * **`OFFSET` は読み飛ばした行も数える**（`src/works-list.ts` の `MAX_PAGE` と同じ理由）。
 * 上限が無いと `?page=999999` の 1 本で、作者の索引の上を長く走らせられる。
 *
 * **50 頁（＝1,500 件）。** **1 人の生成は 1 日 10 回まで**（確定25）なので、1,500 件は毎日使い切って
 * 150 日分にあたる。**ここに当たる利用者が出たら、頁送りではなく続きの鍵で辿る形（keyset）へ変える時期である**
 * （`src/works-list.ts` が同じことを書いている）。
 */
export const MAX_MY_WORKS_PAGE = 50;

/**
 * `?page=` の名前。**作品をさがす・いいねした作品と同じ綴りにする**（利用者が頁の綴りを
 * 画面ごとに覚えない）。
 */
export const MY_WORKS_PAGE_PARAM = 'page';

/**
 * `?page=` として読める綴り。**1 から始まる 10 進の数字だけ**（先頭の 0・符号・小数点・指数・空白を含まない）。
 */
const PAGE_NUMBER_PATTERN = /^[1-9][0-9]*$/u;

/**
 * `?page=` を頁番号へ落とす（#552）。
 *
 * **落とすのであって、失敗させない。** 手で書き換えた URL が 400 を返すより、1 頁目が出るほうがよい
 * （ここは `src/works-list.ts` の `toPageNumber` と同じ考え方である）。
 *
 * **文字列全体が 10 進の正の整数の綴り（{@link PAGE_NUMBER_PATTERN}）のときだけ数に直す**（PR #560 の Copilot code review）。
 * `Number.parseInt` は先頭の数字だけを読むので、`2abc`・`2.5`・`2e3`・` 2` が 2 頁目になってしまう。
 * **読み方はここが作品をさがす（`parseInt` のまま）と違う。** 前後の空白も数でない綴りとして 1 頁目にする。
 *
 * **`02` のような先頭の 0 も 1 頁目にする。** 頁の綴りは 1 通り（{@link myWorksPath} が作る `?page=2`）で、
 * 先頭の 0 を許すために正規表現と正規化を足すより、「作らない綴りは読めない値」とまとめるほうが単純である。
 *
 * **上限（{@link MAX_MY_WORKS_PAGE}）を超える値も 1 頁目にする**（#552 の acceptance）。
 * ここも作品をさがす（上限の頁へ寄せる）と違う。この一覧の上限は「そこまで作品を
 * 持つ利用者がまだいない」値であり、上限を超えた番号は手で書き換えた URL と見なして、
 * 読めない値と同じく先頭へ戻す。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 1 以上 {@link MAX_MY_WORKS_PAGE} 以下の整数
 */
export function toMyWorksPageNumber(value: string | null): number {
  if (value === null || !PAGE_NUMBER_PATTERN.test(value)) {
    return 1;
  }
  const parsed = Number(value);
  // 綴りが正しくても桁が多すぎる値（`99999999999999999999`）は安全な整数にならない。上限を超える値と同じく 1 頁目。
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MY_WORKS_PAGE) {
    return 1;
  }
  return parsed;
}

/**
 * この一覧の URL を組み立てる。
 *
 * **1 頁目には `?page=` を付けず、「すべて」には `?state=` を付けない**（`src/liked-works.ts` の `likedWorksPath` と
 * 同じ扱い）。1 頁目の「すべて」の URL が 2 通りにならず、見出しやヘッダの導線（`MY_WORKS_PATH`）と同じ綴りになる。
 * **頁を送っても絞り込みを保つ**（#666 の acceptance「絞り込みとページ送りを組み合わせても件数が合う」）。
 *
 * @param page 頁番号
 * @param filter 絞り込み（既定は「すべて」）
 * @returns アプリ用ホスト上の絶対パス
 */
export function myWorksPath(page: number, filter: MyWorksFilter = 'all'): string {
  const params: string[] = [];
  if (filter !== 'all') {
    params.push(`${MY_WORKS_FILTER_PARAM}=${filter}`);
  }
  if (page > 1) {
    params.push(`${MY_WORKS_PAGE_PARAM}=${page}`);
  }
  return params.length === 0 ? MY_WORKS_PATH : `${MY_WORKS_PATH}?${params.join('&')}`;
}

/**
 * 生成の状態の短い名前（#152 / #473）。
 *
 * **`src/work-page.ts` の文言を再利用しない。** あちらは 1 件だけを見ている人に向けた
 * 説明文（「生成が終わるまで、このタブを開いたままにしてください」）で、こちらは
 * **複数行を見比べるための札**である。
 *
 * 一方、**「止まっているかもしれない」の判定そのものは共有する**（`looksStalled`）。
 * あれは表示の文言ではなく閾値の判断であり、2 か所に置くとずれる。
 */
const STATE_LABELS = {
  working: '生成中',
  // **札は短い語だけにする**（PR #669 のレイアウトの指摘）。「時間がかかっています」は札の外に小さく添える（{@link STALLED_NOTE}）。
  stalled: '生成中',
  ready: 'できました',
  failed: '失敗',
  unknown: '状態を読み取れません',
} as const;

/** 一覧の行に出す生成の状態。 */
type RowState = keyof typeof STATE_LABELS;

/** 長く動いていない生成の札の外に添える補足（#666。札は「生成中」のまま）。 */
export const STALLED_NOTE = '時間がかかっています';

/**
 * 公開状態の札の文言（#641）。**`removed` は無い**（この一覧は引かない）。
 */
const PUBLICATION_LABELS = {
  published: '公開中',
  draft: '下書き',
} as const;

/**
 * `games.status` を札の文言へ落とす（#641）。
 *
 * **D1 の綴りをそのまま画面へ出さない。** CHECK があるので `draft` / `published` 以外は通常入らないが、
 * **知らない値を「公開中」と言い切らない**——公開していないものを公開中と出すほうが、何も出さないより害が大きい
 * （5.4 は公開を作者の意思表示として扱う）。**知らない値では札を出さない。**
 *
 * @param status D1 の `games.status`
 * @returns 札の文言。出さないなら null
 */
export function publicationLabelOf(status: string): string | null {
  return status === 'published' || status === 'draft' ? PUBLICATION_LABELS[status] : null;
}

/**
 * `generation_state` を行の生成の状態へ落とす。
 *
 * **D1 の綴りをそのまま表示の分岐に使わない**（`src/work-page.ts` と同じ方針）。
 * **「生成中」と言い続けるより、分からないと言うほうがよい。**
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

/** 表の「状態」の列の札（#666）。 */
export interface StateChip {
  /** 札の文言。 */
  readonly label: string;
  /** 地を塗るか（まだ動いている行だけ。仕様 2.5.5 / #473）。 */
  readonly emphasis: boolean;
  /** 札の外に小さく添える補足（長く動いていない生成だけ。無ければ null）。 */
  readonly note: string | null;
}

/**
 * 表の「状態」の列の札を決める（#666）。**公開中／下書き／生成中／失敗 の 4 つのどれか 1 つ**にする。
 *
 * #641 までは「生成の状態」と「公開状態」の 2 枚の札を並べていた（2 つは直交するので 1 枚に畳まない、と書いていた）。
 * **表では 1 枚にする。** 公開できるのは生成が済んだ作品だけ（`publishGame` の `generation_state = 'ready'`）なので、
 * 生成中・失敗の行は必ず下書きで、**生成が済んだ行だけが公開中か下書きかに分かれる**——4 つは重ならない。
 * 絞り込み（`src/my-works-query.ts` の `MY_WORKS_FILTERS`）も同じ 4 つで分ける。
 *
 * - 生成が済んで、公開状態が読めない（CHECK が入れさせない値）→ 「できました」。**公開中とも下書きとも言わない**（#641）
 * - 生成の状態が読めない → 「状態を読み取れません」
 *
 * @param work 行
 * @param now 現在時刻（UNIX 秒）
 * @returns 札
 */
export function stateChipOf(
  work: Pick<MyWorkRow, 'status' | 'generationState' | 'createdAt' | 'startedAt'>,
  now: number,
): StateChip {
  const stalled = looksStalled({ createdAt: work.createdAt, startedAt: work.startedAt }, now);
  const state = rowStateOf(work.generationState, stalled);
  if (state === 'ready') {
    return { label: publicationLabelOf(work.status) ?? STATE_LABELS.ready, emphasis: false, note: null };
  }
  return {
    label: STATE_LABELS[state],
    emphasis: state === 'working' || state === 'stalled',
    note: state === 'stalled' ? STALLED_NOTE : null,
  };
}

/**
 * 行に出すタイトルを決める。
 *
 * `games.title` は `NOT NULL` で、生成の経路は必ず非空の仮タイトルを入れる
 * （`src/games.ts` の `draftTitleFromPrompt`）。**それでも空を扱えるようにしておく**のは、
 * 別の経路で作られた行や、この不変条件より前に作られた行が無地の行になるのを
 * 防ぐためである（**不変条件を画面が前提にしない**。`src/work-page.ts` と同じ方針）。
 *
 * @param title D1 の `title`
 * @returns 画面に出すタイトル（空にならない）
 */
export function displayTitleOf(title: string): string {
  return title.trim() === '' ? UNTITLED_TITLE : title;
}

/**
 * 紹介用の画像が無いときに、画像の枠に出す短い文言（#666）。**色の付いた絵を作らない**——プラットフォーム側は
 * 無彩色である（仕様 2.5.2）。面の色の枠に、なぜ画像が無いかを 1 語で書く。
 *
 * - 下書きは撮っていない（撮影は公開したときに起こす。5.4 の「OGP 画像の生成は公開時まで遅延する」）→「公開前」
 * - 公開中で撮影の最中（`ogp_state = 'capturing'`）→「撮影中」。撮影に失敗した・始まっていない作品は「画像なし」
 *   （PR #669 の Copilot code review。以前は失敗も「撮影中」と出していた）
 *
 * @param work 行
 * @param chip 状態の札
 * @returns 文言
 */
function shotPlaceholderOf(work: MyWorkRow, chip: StateChip): string {
  if (work.status === 'published') {
    return work.ogpState === 'capturing' ? '撮影中' : '画像なし';
  }
  if (chip.label === PUBLICATION_LABELS.draft) {
    return '公開前';
  }
  return chip.emphasis ? '生成中' : '画像なし';
}

/**
 * 紹介用の画像の枠。**配信できるときだけ `<img>` にする**（`hasShot` の条件は配信と同じ。`src/my-works-query.ts`）。
 *
 * @param work 行
 * @param chip 状態の札
 * @returns HTML
 */
function renderShot(work: MyWorkRow, chip: StateChip): string {
  if (!work.hasShot) {
    return `<span class="gf-works-shot gf-works-shot-pending">${shotPlaceholderOf(work, chip)}</span>`;
  }
  return (
    `<img class="gf-works-shot" src="${ogpImagePath(work.id)}"` +
    ` width="${OGP_IMAGE_WIDTH}" height="${OGP_IMAGE_HEIGHT}" alt="" loading="lazy">`
  );
}

/**
 * 日付の列（#666）。**公開したことがある作品は公開日、無い作品は生成日**を、どちらかが分かる語を添えて出す
 * （Studio の「公開日」「アップロード日」の出し分け）。
 *
 * **下書きへ戻した作品も公開日を出す**——`published_at` は最初に公開した時刻で、下書きへ戻しても消えない
 * （`src/games.ts` の `publishGame` の #637 注記）。**語は「公開日」ではなく「初公開日」にする**（いま公開中だと読ませない）。
 *
 * **語は「〜日」で終える**（PR #669 のレイアウトの指摘）。「公開」の 2 文字だと、同じ行の状態の札「公開中」と
 * 2 通りの綴りに見えた。
 *
 * **読めない日時では `<time>` ごと落とす。** `datetime=""` は仕様上不正である（#152 のときと同じ扱い）。
 *
 * @param work 行
 * @returns HTML（読めなければ空文字）
 */
function renderDate(work: MyWorkRow): string {
  const [label, at] =
    work.publishedAt !== null
      ? [work.status === 'published' ? '公開日' : '初公開日', work.publishedAt]
      : ['生成日', work.createdAt];
  const iso = toIsoTimestamp(at);
  if (iso === '') {
    return '';
  }
  return `<span class="gf-works-date-label">${label}</span> <time datetime="${iso}">${formatJstMinutes(at)}</time>`;
}

/** 数の列（見出しの文言と、行の値の取り出し方）。**狭い段のカードでは見出しを値の前に添える**（`data-label`）。 */
const COUNT_COLUMNS: readonly {
  readonly label: string;
  /**
   * 表の見出しとカードの数の上に出す短い語（1 行に収める。PR #669 のレイアウトの指摘で「フォークされた数」が
   * 見出しで 4 行に折り返していた）。**正式名（`label`）は見出しの `title` と `aria-label` で補う。**
   */
  readonly short: string;
  readonly value: (work: MyWorkRow) => number;
}[] = [
  { label: 'プレイ', short: 'プレイ', value: (work) => work.playCount },
  { label: 'いいね', short: 'いいね', value: (work) => work.likeCount },
  { label: 'フォークされた数', short: 'フォーク', value: (work) => work.forkCount },
];

/**
 * 表の 1 行を組み立てる（#666）。
 *
 * **`escapeHtml` を通すのはタイトルだけである。** 他はこのモジュールが持つ固定の文字列・語彙のラベル・整数か、
 * `games.id`（`crypto.randomUUID()` の出力）である。**選択のチェックボックスの名前にも題名が入る**
 * （`aria-label`。属性の中なので同じく通す）。
 *
 * **行き先はエディットページである**（#664。冒頭）。
 *
 * @param work 行
 * @param now 現在時刻（UNIX 秒）
 * @returns `<tr>` 1 つ
 */
function renderRow(work: MyWorkRow, now: number): string {
  const chip = stateChipOf(work, now);
  const title = escapeHtml(displayTitleOf(work.title));
  const tags = knownWorkTags(work.tags);
  const tagLine =
    tags.length === 0
      ? ''
      : `<span class="gf-works-tags">${tags.map((tag) => `<span class="gf-chip">${tag.label}</span>`).join(' ')}</span>`;
  const counts = COUNT_COLUMNS.map(
    ({ short, value }) => `<td class="gf-works-count" role="cell" data-label="${short}">${value(work)}</td>`,
  ).join('');
  const note = chip.note === null ? '' : `<span class="gf-works-state-note">${chip.note}</span>`;
  return (
    `<tr role="row">` +
    `<td class="gf-works-select" role="cell"><input type="checkbox" name="${WORKS_BULK_GAME_ID_FIELD}" value="${work.id}" aria-label="${title} を選ぶ"></td>` +
    `<td class="gf-works-thumb" role="cell">${renderShot(work, chip)}</td>` +
    `<td class="gf-works-name" role="cell"><a class="gf-link-quiet gf-works-title" href="${workEditPath(work.id)}">${title}</a>${tagLine}</td>` +
    `<td class="gf-works-state" role="cell"><span class="${chip.emphasis ? 'gf-chip gf-chip-emphasis' : 'gf-chip'}">${chip.label}</span>${note}</td>` +
    `<td class="gf-works-date" role="cell">${renderDate(work)}</td>` +
    counts +
    `</tr>`
  );
}

/** 絞り込みのタブの文言（#666）。 */
const FILTER_LABELS: Readonly<Record<MyWorksFilter, string>> = {
  all: 'すべて',
  published: '公開中',
  draft: '下書き',
  generating: '生成中',
  failed: '失敗',
};

/**
 * 絞り込みごとの件数を、統計の集計から引く（#666。**問い合わせを増やさない**。`src/my-works-stats.ts`）。
 *
 * @param stats 統計（読めなかったときは null）
 * @param filter 絞り込み
 * @returns 件数。読めなかったときは null
 */
export function filterCountOf(stats: MyWorksStats | null, filter: MyWorksFilter): number | null {
  if (stats === null) {
    return null;
  }
  switch (filter) {
    case 'all':
      return stats.works;
    case 'published':
      return stats.published;
    case 'draft':
      return stats.readyDrafts;
    case 'generating':
      return stats.generating;
    case 'failed':
      return stats.failed;
  }
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface MyWorksView {
  /** 並べる作品（新しい順。既に {@link MY_WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly MyWorkRow[];
  /** 頁番号（1 始まり。{@link toMyWorksPageNumber} を通した値）。 */
  readonly page: number;
  /** 絞り込み（#666）。 */
  readonly filter: MyWorksFilter;
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
 * 頁送りと、作品が 0 本のときの導線と、一括操作のボタンに当てる小さい副のボタン（仕様 2.5.5。#474）。
 * 見た目の正本は `public/assets/app.css` の `@section buttons` で、ここは当てる部品の名前だけを持つ。
 */
const SMALL_SECONDARY_BUTTON = 'gf-button gf-button-secondary gf-button-sm';

/**
 * 絞り込みを組み立てる（#666）。
 *
 * **見た目はタブ（`.gf-tabs`）である**（仕様 2.5.5「タブ: 並べ替え」と同じ——選択肢の中の現在地であって動作ではない）。
 * いまの絞り込みは `aria-current="page"` で示し、リンクにしない（押しても同じ場所へ来るリンクを出さない。
 * `src/works-list.ts` の `renderSortNav` と同じ形）。**件数を添える**（統計の集計 1 本から引く）。
 * **絞り込みを変えたら 1 頁目へ戻す**（前の絞り込みの頁番号は、別の絞り込みでは意味が無い）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderFilterNav(view: MyWorksView): string {
  const items = MY_WORKS_FILTERS.map((filter) => {
    const count = filterCountOf(view.stats, filter);
    const label = `${FILTER_LABELS[filter]}${count === null ? '' : `（${count}）`}`;
    return filter === view.filter
      ? `<li><span aria-current="page">${label}</span></li>`
      : `<li><a href="${myWorksPath(1, filter)}">${label}</a></li>`;
  });
  return `<nav class="gf-works-filter" aria-label="状態で絞り込む">
<ul class="gf-tabs">
${items.join('\n')}
</ul>
</nav>`;
}

/**
 * 頁送りを組み立てる（#552 / #666）。
 *
 * **作品をさがす（`src/works-list.ts`）・いいねした作品（`src/liked-works.ts`）の頁送りと同じ形である。**
 * 小さい副のボタンにし、「次」は右端に寄せる（`.gf-pager-next`。仕様 2.5.5 / #474）。**DOM の順は前 → 次のまま**。
 * **絞り込みを保つ**（#666）。押しても何も起きない導線を出さない（次が無ければ「次」を出さない）。
 *
 * @param view 表示に必要な値
 * @returns HTML。前も次も無ければ空文字
 */
function renderPager(view: MyWorksView): string {
  const links: string[] = [];
  if (view.page > 1) {
    links.push(
      `<a class="${SMALL_SECONDARY_BUTTON}" href="${myWorksPath(view.page - 1, view.filter)}">前の ${MY_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (view.hasNext) {
    links.push(
      `<a class="${SMALL_SECONDARY_BUTTON} gf-pager-next" href="${myWorksPath(view.page + 1, view.filter)}">次の ${MY_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join('\n')}</nav>`;
}

/**
 * いま並んでいる範囲の 1 行（#666。「全 45 件中 31〜45 件目」）。**件数は統計の集計から引く**——読めなかったときは
 * 範囲だけを出す（全体の件数を推測で書かない）。
 *
 * @param view 表示に必要な値
 * @returns 文言
 */
export function rangeLineOf(view: Pick<MyWorksView, 'works' | 'page' | 'filter' | 'stats'>): string {
  const first = (view.page - 1) * MY_WORKS_PER_PAGE + 1;
  const last = first + view.works.length - 1;
  const total = filterCountOf(view.stats, view.filter);
  return total === null ? `${first}〜${last} 件目` : `全 ${total} 件中 ${first}〜${last} 件目`;
}

/** 一括操作のボタン（#666）。**値は `src/works-bulk.ts` の `BULK_ACTIONS` と同じ綴りである**（あちらの検査が照合する）。 */
export const BULK_BUTTONS: readonly { readonly action: string; readonly label: string }[] = [
  { action: 'publish', label: '公開する' },
  { action: 'unpublish', label: '下書きに戻す' },
  { action: 'delete', label: '削除する' },
];

/**
 * 表と一括操作を組み立てる（#666）。
 *
 * # 素の GET のフォームで、確認画面へ移る
 *
 * **表全体を `<form method="get">` で包み、ボタンは `name="action"` の値で操作を運ぶ。** 押しても何も書き換わらない
 * ——移る先は確認画面（`src/works-bulk.ts`）で、書き換えるのはそこから送る POST だけである。**JavaScript を要求しない**
 * （9.3。「全部選ぶ」のチェックボックスは置かない。1 頁は 30 件で、1 つずつ選んでも手間が限られる）。
 *
 * # ボタンは副にする
 *
 * **この画面の主は「新しく生成する」の 1 つだけ**（仕様 2.5.5 / #473）。一括操作は小さい副のボタンにする
 * （削除は破壊的な操作なので主にしない。#517 の constraints と同じ）。
 *
 * # 表の見出し
 *
 * 見出しは `<th scope="col">`。狭い段では見出しの行を**見た目だけ**隠してカードにする（数の列は `data-label` の語を値の上に
 * 添える）。**表の要素に `role` を明示する**——CSS で `display` を表から格子へ替えると、ブラウザによっては表の意味が
 * 支援技術に渡らなくなるためで、`role` があれば狭い段でも各セルが見出しと結び付いたまま読まれる（PR #669 の Copilot
 * code review。以前は狭い段で `thead` を `display: none` にしており、数のセルが見出しの無い数字になっていた）。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
function renderTable(view: MyWorksView): string {
  const buttons = BULK_BUTTONS.map(
    ({ action, label }) =>
      `<button type="submit" class="${SMALL_SECONDARY_BUTTON}" name="${WORKS_BULK_ACTION_FIELD}" value="${action}">${label}</button>`,
  ).join('\n');
  return `<form class="gf-works-bulk" method="get" action="${MY_WORKS_BULK_PATH}">
<div class="gf-works-toolbar">
<p class="gf-works-range">${rangeLineOf(view)}</p>
<div class="gf-works-actions" role="group" aria-label="選んだ作品をまとめて操作する">
<span class="gf-works-actions-label">選んだ作品を</span>
${buttons}
</div>
</div>
<table class="gf-block gf-works-table" role="table">
<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader" class="gf-works-select">選択</th><th scope="col" role="columnheader" class="gf-works-thumb">画像</th><th scope="col" role="columnheader">作品</th><th scope="col" role="columnheader">状態</th><th scope="col" role="columnheader">日付</th>${COUNT_COLUMNS.map(({ label, short }) => (label === short ? `<th scope="col" role="columnheader" class="gf-works-count">${short}</th>` : `<th scope="col" role="columnheader" class="gf-works-count" title="${label}" aria-label="${label}">${short}</th>`)).join('')}</tr></thead>
<tbody role="rowgroup">
${view.works.map((work) => renderRow(work, view.now)).join('\n')}
</tbody>
</table>
</form>`;
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
  // **作品が 0 本のときの「最初のゲームを生成する」は小さい副のボタン**（PR #505 の Copilot code review）。
  //
  // **2 頁目以降で空なのは「まだ作品が無い」ではない**（#552。作品を消して頁が減った後の古い URL など）。
  // **絞り込んで空なのも「まだ作品が無い」ではない**（#666）。どちらも作品を持つ本人に画面が嘘をつかない文言にする。
  const body =
    view.works.length > 0
      ? renderTable(view)
      : view.page > 1
        ? `<p class="gf-block">この頁に並ぶ作品がありません。</p>`
        : view.filter !== 'all'
          ? `<p class="gf-block">「${FILTER_LABELS[view.filter]}」の作品はありません。</p>`
          : `<div class="gf-block gf-my-works-empty">
<p>まだ作品がありません。</p>
<p class="gf-my-works-empty-action"><a class="${SMALL_SECONDARY_BUTTON}" href="${GENERATE_PAGE_PATH}">最初のゲームを生成する</a></p>
</div>`;

  // **ログイン済みとして組む。** この画面は未ログインでは開けない（{@link showMyWorks} が
  // ログインへ送る）ので、**外枠のためにセッションを 2 度検証しない**（2.3.7 / #331）。
  //
  // **並びは HTML の順**（見出し → 統計の帯 → 見出しの行（新しく生成する）→ 説明 → 絞り込み → 表 → 頁送り → 副のボタン）で、
  // 見た目の順と Tab の順が割れない。
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
<p>公開中のものも下書きも、生成中のものも含めて、新しい順に並んでいます。作品名を選ぶとその作品の編集の画面へ移ります。作品を選んで、まとめて公開・下書きへ戻す・削除することもできます（押すと確認の画面へ移ります）。</p>
${renderFilterNav(view)}
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
 * **1 頁の件数より 1 件多く引く**（#552。いまの作法のまま）。「ちょうど 30 件で終わる」と
 * 「31 件目がある」は引いた件数だけでは区別できず、区別せずに「次の 30 件」を出すと
 * **押しても空の頁へ行く導線**になる。**統計と残枠は頁・絞り込みによらず同じものを引き、どの頁にも出す。**
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
  const params = new URL(request.url).searchParams;
  const page = toMyWorksPageNumber(params.get(MY_WORKS_PAGE_PARAM));
  const filter = toMyWorksFilter(params.get(MY_WORKS_FILTER_PARAM));
  const [fetched, stats, availability] = await Promise.all([
    listMyWorks(env, session.userId, filter, MY_WORKS_PER_PAGE + 1, (page - 1) * MY_WORKS_PER_PAGE),
    loadStatsOrNull(env, session.userId),
    resolveAvailability(env, session.userId),
  ]);
  return html(
    renderMyWorksPage({
      works: fetched.slice(0, MY_WORKS_PER_PAGE),
      page,
      filter,
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
