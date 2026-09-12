/**
 * 審査キューの画面と、`queued` ↔ `cleared` の切り替え（仕様 2.4.3 / 8.4 / #361）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * この画面が admin のトップである
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **2.3.1 の admin の表の 1 行目がこれである。** M10-2 が置いた「空の 1 枚」を
 * 置き換えた——**目次だけの画面を挟まない**（運営が管理画面を開く理由は、ほぼ
 * 審査キューを見ることである。8.4 が「閾値到達で審査キューへ投入」と定めた先が、
 * いままで端末の SQL しか無かった）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2 つの節を並べる（往復できることが画面から見える）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`queued` と `cleared` を同じ画面に並べる。** `queued` だけを出すと、
 * **戻す操作（`cleared` → `queued`）を画面から起動できない**——「往復できる」と
 * 決めた 2.4.3 が、実装では片道になる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 3 つ目の節: 改名のあとに通報が付いた `cleared`（#367）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **#366 が開けた経路を、画面の側でも塞ぐ。** 「穏当な題名で公開 → 通報 → `cleared`
 * → 改名」のあとに付いた通報は、`queued` だけを引く一覧には出ない。
 * `scripts/report-queue.sh` は既にそれを出しており、**画面だけが古い**状態だった。
 *
 * **条件を書き写さない。** 正本は `src/reports.ts` の {@link REVIEW_RENAMED_SQL} 1 か所で、
 * この画面もスクリプトもそれを借りる（スクリプトはソースから取り出す）。**`games` の
 * 別名は `g` 固定**なので、この画面の SQL も `g` で書き、**外側で `r` を使わない**
 * （相関副問い合わせの `r` と取り違えるため。あちらの但し書き）。
 *
 * **`cleared` の節とは分ける。** 同じ `cleared` だが、**運営にとっての意味が違う**
 * ——`cleared` の節は「見終わった作品」で、こちらは「見たあとで名前が変わり、
 * また通報が付いた作品」である。**同じ節に混ぜると区別が付かない**（#367 の受け入れ）。
 * 行は片方にしか出さない（`cleared` の節は `not REVIEW_RENAMED_SQL` で引く）——
 * 両方に出すと、同じ作品に同じ操作のフォームが 2 つ並ぶ。
 *
 * **操作は増やさない**（#367 の scope.out）。この節の行が持つのは `cleared` の行と同じ
 * 「審査待ちへ戻す」だけである。「見たので一覧から外す」操作は無い——下記の穴を参照。
 *
 * **既知の穴（この画面では塞がない）。** `renameGame` は `cleared` を `NULL` へ戻すので、
 * 改名のあとの通報は**まず `queued` へ入る**（閾値は 1 人）。それを運営が `cleared` に
 * すると、**改名以降の通報が残っているので、この節に戻ってくる**——次に改名される
 * まで出続ける。直すなら条件そのもの（`src/reports.ts`）であり、**スクリプトと画面が
 * 同時に直る**ように 1 か所に置いてある。画面の注記はこの挙動をそのまま書く。
 *
 * **`review_state` が NULL の作品は出さない。** それは「通報の閾値に達していない」
 * 大多数の作品であり（0017）、**審査の対象ではない。** 運営が手で止める操作も
 * 置いていない（投入するのは通報の側である。8.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 中身はここに出さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **題名と作者名までで、通報の理由も本文も出さない**（`scripts/report-queue.sh` が
 * 同じ判断をしている——「中身は作品ページで見てください」）。作品そのものは
 * **app ホストの作品ページで開く**ので、行ごとに絶対 URL のリンクを置く。
 *
 * **`games.status` を 1 ビットも動かさない**（0017 / 8.4）。この画面が動かすのは
 * `review_state` だけで、**共有済みの URL は切れない。**
 */
import { PUBLISHED_STATUS } from '../games.js';
import { escapeHtml } from '../html.js';
import { formatJstMinutes, toIsoTimestamp } from '../jst.js';
import { workPagePath } from '../paths.js';
import {
  REVIEW_CLEARED,
  REVIEW_QUEUED,
  REVIEW_RENAMED_SQL,
  TITLE_CHANGES_TABLE,
} from '../reports.js';
import type { ReviewState } from '../reports.js';
import type { Route } from '../routes.js';
import { html } from '../routes.js';
import {
  ADMIN_GAME_ID_FIELD,
  ADMIN_HOME_PATH,
  ADMIN_NEXT_FIELD,
  ADMIN_REASON_FIELD,
  ADMIN_REVIEW_API_PATH,
} from '../admin-paths.js';
import { ADMIN_LIST_LIMIT, oppositeReviewState, setReviewState, validateReason } from './actions.js';
import { readAdminForm } from './form.js';
import { adminNotFound } from './guard.js';
import { ADMIN_OUTCOME_QUERY, redirectWithOutcome, renderOutcomeNotice, isSucceeded } from './outcome.js';
import { adminFooter, adminHead } from './shell.js';

/** 審査キューに並べる 1 行（引いた列）。 */
interface ReviewRow {
  readonly id: string;
  readonly title: string;
  readonly published_at: number | null;
  readonly author_name: string | null;
  /** 最後の改名の時刻（UNIX 秒）。**改名の節だけが引く**（ほかの節では常に null）。 */
  readonly renamed_at: number | null;
}

/** 節の識別子。**フォームの要素 id に入る**ので、節ごとに違う綴りである。 */
type ReviewSectionKey = 'queued' | 'renamed' | 'cleared';

/** 節ごとの条件・札と、押したときに向かう先。 */
interface ReviewSection {
  readonly key: ReviewSectionKey;
  /** この節の行が**いま**持っている審査状態（ボタンはその反対へ向かう）。 */
  readonly state: ReviewState;
  /**
   * where 句の断片（**`games` の別名は `g`**）。
   *
   * **定数だけから組み立てる。** 利用者の入力は 1 文字も入らないので、束縛にしない
   * （`src/reports.ts` の `reviewVisibleSql` が断片を文字列で渡しているのと同じ扱い）。
   */
  readonly where: string;
  /** 行に最後の改名の時刻を出すか。 */
  readonly showsRename: boolean;
  /**
   * 条件が `title_changes` を読むか（`REVIEW_RENAMED_SQL` を含むか）。
   *
   * **読めないときに読み直す節を決める**（{@link readSections}）。`0027` が未適用の D1 で
   * 落ちるのはこれが真の節である。
   */
  readonly readsRenames: boolean;
  /** 行の頭に付ける札（`queued` の行と見分けるため）。付けない節は null。 */
  readonly badge: string | null;
  readonly heading: string;
  readonly empty: string;
  readonly note: string;
  readonly button: string;
}

/**
 * 3 つの節の条件と文言。
 *
 * **`Record` ではなく配列で持つ。** 画面に並べる順序そのものを表しているためである
 * （審査待ちが先。運営が最初に見るものが上にある。**改名の節は `cleared` より上**
 * ——こちらは「まだ見ていない可能性がある」作品である）。
 */
const SECTIONS: readonly ReviewSection[] = [
  {
    key: 'queued',
    state: REVIEW_QUEUED,
    where: `g.review_state = '${REVIEW_QUEUED}'`,
    showsRename: false,
    readsRenames: false,
    badge: null,
    heading: '審査待ち',
    empty: 'いま審査待ちの作品はありません。',
    note: '新規露出が止まっています（一覧とトップに出ません）。共有済みの URL は生きています。',
    button: '問題なしにする（新規露出を戻す）',
  },
  {
    key: 'renamed',
    state: REVIEW_CLEARED,
    // **条件の正本はここではない**（`src/reports.ts`。このファイルの冒頭）。
    where: REVIEW_RENAMED_SQL,
    showsRename: true,
    readsRenames: true,
    badge: '改名後に通報あり',
    heading: '問題なしとしたあと、改名されて通報が付いた作品',
    empty: 'いま該当する作品はありません。',
    note:
      '一度「問題なし」とした作品のうち、作者が題名を変え、その改名以降に通報が付いたものです。' +
      '露出は止まっていません。改名後の題名を作品ページで確かめ、止めるべきなら審査待ちへ戻してください。' +
      '審査待ちへ戻してから再び問題なしにしても、次に改名されるまではこの節に残ります。',
    button: '審査待ちへ戻す（新規露出を止める）',
  },
  {
    key: 'cleared',
    state: REVIEW_CLEARED,
    // **改名の節に出す行を除く**（同じ作品にフォームを 2 つ並べない）。
    where: `g.review_state = '${REVIEW_CLEARED}' and not ${REVIEW_RENAMED_SQL}`,
    showsRename: false,
    readsRenames: true,
    badge: null,
    heading: '問題なしとした作品',
    empty: 'まだ 1 件もありません。',
    note:
      '露出は戻っています。再び閾値に達してもキューへは戻りません（通報の側では戻せない状態です）。' +
      '改名のあとに通報が付いた作品は、上の節に出します。',
    button: '審査待ちへ戻す（新規露出を止める）',
  },
];

/**
 * ある節の作品を引く文を組み立てる。
 *
 * **件数を固定する**（{@link ADMIN_LIST_LIMIT}。2.3.3 の条件 1 と同じ考え方）。
 * 母数（公開作品の総数）が増えても、この画面の読み取りは増えない。**節ごとに**固定する
 * ので、1 枚の画面の上限は節の数 × 50 行である。
 *
 * **索引を張っていない**（0017 が「全走査で足りる規模でしか呼ばれない」と書いた
 * とおり。運用が数日に 1 度開く画面である）。**張る契機は、公開作品が数千本になった
 * ときである**——`limit` は走査を止めないので、そのときは `review_state` の部分索引が要る。
 * 改名の条件の相関副問い合わせは `cleared` の行ごとに走るが、`reports` と
 * `title_changes` はどちらも `game_id` を先頭に持つ索引がある（0017 の
 * `reports_game_reporter_uq` / 0027 の `title_changes_game_changed_idx`）。
 *
 * **公開中の作品だけを並べる**（PR #364 のレビューで足した条件）。`removeGame` は
 * `status` だけを動かして `review_state` を残すので（`src/games.ts`）、**審査待ちのまま
 * 作者が取り下げた作品**がありうる。並べると、**戻らない露出について「新規露出を戻す」
 * ボタンを出す**ことになる（2.4.3 は取り下げを画面へ置かないと決めている）。
 *
 * **`users` は表示名 1 列のために結合する**（行ごと持ってこない。`email` は
 * 管理画面にも出さない）。
 *
 * **改名の時刻は、出す節でだけ引く。** ほかの節まで `title_changes` を読むと、
 * `0027` が未適用の D1 で**審査待ちの節まで読めなくなる**（下記 {@link readSections}）。
 * **旧題名・新題名は引かない**——出すのは時刻だけで、題名はいまの 1 つを出す
 * （`scripts/report-queue.sh` が `last_rename` で同じ線を引いている）。
 *
 * @param env バインディングと環境変数
 * @param section 節の定義
 * @param limit 取得件数の上限
 * @returns 準備済みの文（行は新しい順）
 */
function sectionStatement(
  env: Env,
  section: ReviewSection,
  limit: number = ADMIN_LIST_LIMIT,
): D1PreparedStatement {
  // **別名は `tc` にする。** `REVIEW_RENAMED_SQL` の中の `c` と同じ綴りでも SQL の上は
  // 衝突しないが、読む人が「どちらの `c` か」を追わずに済むようにする。
  const renamedAt = section.showsRename
    ? `(select max(tc.changed_at) from ${TITLE_CHANGES_TABLE} tc where tc.game_id = g.id)`
    : 'null';
  // **並びは公開の新しい順である。** 通報の時刻で並べるには `reports` を集計する
  // 必要があり（`scripts/report-queue.sh` はそうしている）、**画面 1 枚のために
  // 読み取りを増やす理由が無い**——平常時のキューは数件である。
  return env.DB.prepare(
    `select g.id, g.title, g.published_at, u.display_name as author_name,
            ${renamedAt} as renamed_at
       from games g
       left join users u on u.id = g.author_id
      where ${section.where} and g.status = ?
      order by g.published_at desc, g.id desc
      limit ?`,
  ).bind(PUBLISHED_STATUS, limit);
}

/** 1 つの節を読んだ結果。**読めなかったことを 0 行と区別する。** */
type SectionRead =
  | { readonly ok: true; readonly rows: readonly ReviewRow[] }
  | { readonly ok: false };

/**
 * 3 つの節を読む。**同じ時点の状態から読み、失敗しても画面ごと落とさない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1 つの batch で読む（PR #392 の Copilot レビュー）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **節ごとに別々に読むと、節ごとに違う時点の状態になる。** 読み取りの間に別の管理者が
 * 作品を `queued` ↔ `cleared` へ動かすと、**同じ作品が 2 つの節に、向きの違う
 * ボタン付きで並ぶ**——「行は片方にしか出さない」が破れる。`D1.batch` は 1 つの
 * トランザクションなので、3 本の SELECT が同じ状態を見る。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 読めなければ、`title_changes` に依らない節だけを読み直す
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **#367 で読む表が 1 つ増えた**（`title_changes`。`migrations/0027`）。本番の D1 へ
 * `0027` を適用し忘れると、改名の条件を含む 2 つの節が「no such table」で落ち、
 * batch ごと落ちる。例外をそのまま上へ投げると**審査待ちの節まで見えなくなる**
 * ——#367 が足したものの失敗で、#361 から動いていた一覧を巻き添えにしない。
 *
 * **読み直すのは {@link ReviewSection.readsRenames} が偽の節（審査待ち）だけ**で、
 * ほかの節は「読めなかった」とする。**1 節だけなので、時点のずれによる重複は
 * 起こりえない。**
 *
 * **0 行として描かない。** 「該当なし」と「読めていない」を区別できなくなる
 * （`scripts/report-queue.sh` が終了コード 1 と 2 を分けているのと同じ線）。
 *
 * @param env バインディングと環境変数
 * @returns 節ごとの結果（{@link SECTIONS} と同じ順）
 */
async function readSections(env: Env): Promise<readonly SectionRead[]> {
  try {
    const results = await env.DB.batch<ReviewRow>(
      SECTIONS.map((section) => sectionStatement(env, section)),
    );
    return SECTIONS.map((_, index) => {
      const result = results[index];
      return result === undefined ? { ok: false } : { ok: true, rows: result.results };
    });
  } catch (error) {
    console.error('[admin] 審査キューを読めませんでした。審査待ちの節だけを読み直します', error);
  }

  return await Promise.all(
    SECTIONS.map(async (section): Promise<SectionRead> => {
      if (section.readsRenames) {
        return { ok: false };
      }
      try {
        return { ok: true, rows: (await sectionStatement(env, section).all<ReviewRow>()).results };
      } catch (error) {
        console.error(`[admin] 審査キューの節（${section.key}）も読めませんでした`, error);
        return { ok: false };
      }
    }),
  );
}

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値は題名と作者名と id の 3 つで、すべて `escapeHtml` を通す**
 * （`src/work-card.ts` の規律。題名は利用者が名乗った値である）。時刻は数値から
 * 組み立てる。
 *
 * **理由の欄に `size` を付けない**（`test/admin-page-shell.test.ts` が見ている。
 * `size` / `cols` は layout viewport を広げ、狭い端末で崩れる原因になる。#282）。
 *
 * **理由の欄の id に節の識別子を入れる。** 状態（`cleared`）で作ると、改名の節と
 * `cleared` の節が同じ綴りを持ちうる——`label` の `for` が別の行の入力を指す。
 *
 * @param row 作品の行
 * @param section 節の定義
 * @param appHost app ホストの綴り（作品ページのリンクに使う）
 * @returns HTML
 */
function renderRow(row: ReviewRow, section: ReviewSection, appHost: string): string {
  const id = escapeHtml(row.id);
  // **作品ページは app ホストにある。** 絶対 URL で組み立てる——admin ホストの
  // 相対リンクにすると 404 へ送ることになる（4.4 / 2.2 が禁じている形）。
  const workUrl = `https://${escapeHtml(appHost)}${escapeHtml(workPagePath(row.id))}`;
  const reasonId = `reason-${section.key}-${id}`;
  // **札は文字で出す**（色だけで区別しない。明暗どちらのテーマでも、読み上げでも同じに届く）。
  const badge =
    section.badge === null ? '' : `\n  <p class="gf-admin-badge">${escapeHtml(section.badge)}</p>`;
  const renamed = section.showsRename ? ` ／ 最終改名: ${timeOrDash(row.renamed_at)}` : '';

  return `<li class="gf-admin-row">${badge}
  <p class="gf-admin-row-title"><a href="${workUrl}">${escapeHtml(row.title)}</a></p>
  <p class="gf-admin-meta">作者: ${escapeHtml(row.author_name ?? '（不明）')} ／ 公開: ${timeOrDash(row.published_at, '未公開')}${renamed}<br>
     <code>${id}</code></p>
  <form method="post" action="${ADMIN_REVIEW_API_PATH}">
    <input type="hidden" name="${ADMIN_GAME_ID_FIELD}" value="${id}">
    <input type="hidden" name="${ADMIN_NEXT_FIELD}" value="${oppositeReviewState(section.state)}">
    <label for="${reasonId}">理由（必須。履歴に残ります）</label>
    <input id="${reasonId}" name="${ADMIN_REASON_FIELD}" type="text" required>
    <button type="submit">${escapeHtml(section.button)}</button>
  </form>
</li>`;
}

/**
 * 時刻を `<time>` で出す。
 *
 * **読めない日時では `<time>` ごと落とす**（`src/my-works.ts` と同じ扱い。
 * `datetime=""` は不正である）。
 *
 * @param epochSeconds UNIX 秒（無ければ null）
 * @param missing 読めないときに出す文言
 * @returns HTML
 */
function timeOrDash(epochSeconds: number | null, missing = '—'): string {
  const iso = epochSeconds === null ? '' : toIsoTimestamp(epochSeconds);
  return iso === '' || epochSeconds === null
    ? escapeHtml(missing)
    : `<time datetime="${iso}">${escapeHtml(formatJstMinutes(epochSeconds))}</time>`;
}

/**
 * 1 つの節を組み立てる。
 *
 * **空でも節ごと消さない。** 「審査待ち（0 件）」を出さない規律（`src/home.ts` が持ち、
 * M10-2 の空の管理画面がそれに従って一覧を 1 つも置かなかったもの）は、**機構が無い
 * ときの話**である。**ここは機構が在って中身が無い。** 在るものが 0 件であることは、
 * 書かなければ分からない（`scripts/report-queue.sh` が `REPORT_QUEUE_EMPTY` を出すのと
 * 同じ——**静かに 0 行にすると「審査待ちが無い」のか「読めていない」のかが区別できない**）。
 *
 * **読めなかった節は、件数の代わりにそう書く**（{@link readSections}）。
 *
 * @param section 節の定義
 * @param read 読んだ結果
 * @param appHost app ホストの綴り
 * @returns HTML
 */
function renderSection(section: ReviewSection, read: SectionRead, appHost: string): string {
  if (!read.ok) {
    return `<h2>${escapeHtml(section.heading)}（読み込めませんでした）</h2>
<p class="error" role="alert">この節を読み込めませんでした。0 件という意味ではありません。
   マイグレーションの適用漏れ（改名の履歴 <code>title_changes</code> など）の可能性があります。</p>`;
  }
  const { rows } = read;
  const body =
    rows.length === 0
      ? `<p>${escapeHtml(section.empty)}</p>`
      : `<ul class="gf-admin-list">
${rows.map((row) => renderRow(row, section, appHost)).join('\n')}
</ul>`;
  return `<h2>${escapeHtml(section.heading)}（${rows.length} 件）</h2>
<p>${escapeHtml(section.note)}</p>
${body}`;
}

/**
 * 審査キューの画面を返す。
 *
 * **読み取りは節ごとに 1 本**（審査待ち・改名のあとに通報が付いた作品・問題なし）で、
 * それぞれ件数を固定し、**3 本を 1 つの batch で送る**（{@link readSections}）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showReviewQueue(request: Request, env: Env): Promise<Response> {
  const reads = await readSections(env);
  const outcome = new URL(request.url).searchParams.get(ADMIN_OUTCOME_QUERY);
  const unreadable = reads.some((read) => !read.ok);

  // **読めなかった節があれば 500 にする。** 本文は描くが、成功したかのように
  // ログへ残さない（下の 400 と同じ考え方）。
  const status = unreadable ? 500 : outcome === null || isSucceeded(outcome) ? 200 : 400;
  // **操作の知らせは消さない。読み取りの失敗を並べて出す**（PR #392 の Copilot レビュー
  // への対応）。POST の操作と履歴は既にコミットされており、「操作しました」は事実である
  // ——消すと運営は失敗したと読んで押し直す。**食い違いは「一覧のほうが不完全である」
  // ことで、それは一覧の側の知らせとして書く。** ステータスは 500 のままにする。
  const notice = `${renderOutcomeNotice(outcome)}${
    unreadable
      ? `\n<p class="error" role="alert">一覧の一部を読み込めませんでした。下の一覧は不完全です。</p>`
      : ''
  }`;

  return html(
    `${adminHead('審査キュー')}
<h1>審査キュー</h1>
${notice}
<p>通報が閾値に達した作品がここへ入ります（仕様 8.4）。<strong>止まるのは新規露出だけで、
   作品の取り下げはこの画面に置いていません</strong>（仕様 2.4.3。戻せない操作のため、
   引き続き D1 への直接 UPDATE で行います）。</p>
<p>どちらの操作も理由が必須で、<strong>操作と履歴は 1 つの書き込みで残ります</strong>（仕様 2.4.4）。</p>
${SECTIONS.map((section, index) => renderSection(section, reads[index] ?? { ok: false }, env.APP_HOST)).join('\n')}
${adminFooter()}`,
    // **失敗の後始末で開かれた画面には、失敗のステータスを付ける**
    // （`src/account.ts` と同じ扱い。成功したかのようにログへ残さない）。
    status,
  );
}

/**
 * 審査状態を切り替える（`POST /api/review`）。
 *
 * **実行者はここで引き直さない。** 権限の判定は `handleAdminRequest`（経路表を引く
 * 手前）が 1 回だけ行い、その id を経路表の組み立てが閉じ込めて渡す
 * （`src/admin/guard.ts` の「M10-3 へ: 実行者の id が要るとき」）。**ハンドラの中で
 * `resolveAdminUser` を呼び直すと、境界が 2 か所になって、どちらが正なのか読めなくなる。**
 *
 * **`adminUserId` が無い要求は 404 へ倒す**（fail-closed）。守られた経路なので通常は
 * 起こらないが、**起こったときに「実行者不明の履歴」を積むより、断るほうがよい。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param adminUserId 実行者（権限の判定済み）
 * @returns レスポンス
 */
async function handleReviewChange(
  request: Request,
  env: Env,
  adminUserId: string | null,
): Promise<Response> {
  if (adminUserId === null) {
    console.error('[admin] 実行者が分からない要求を審査の口で受けました');
    return adminNotFound(request);
  }

  const form = await readAdminForm(request);
  if (!form.ok) {
    return redirectWithOutcome(ADMIN_HOME_PATH, form.reason);
  }

  const gameId = form.fields.get(ADMIN_GAME_ID_FIELD) ?? '';
  if (gameId === '') {
    return redirectWithOutcome(ADMIN_HOME_PATH, 'invalid-target');
  }

  // **受けるのは「どちらにしたいか」である**（`src/admin-paths.ts` の
  // `ADMIN_NEXT_FIELD`）。**既知の 2 語以外を受け付けない**——`toPublicWorkSort` のように
  // 既定へ落とす形は採らない。落とすと、**綴りを間違えた要求が反対向きの操作になる。**
  const next = form.fields.get(ADMIN_NEXT_FIELD) ?? '';
  if (next !== REVIEW_QUEUED && next !== REVIEW_CLEARED) {
    return redirectWithOutcome(ADMIN_HOME_PATH, 'invalid-target');
  }

  const reason = validateReason(form.fields.get(ADMIN_REASON_FIELD) ?? '');
  if (!reason.ok) {
    // **断った要求は D1 に触れない**（`src/account.ts` と同じ規律）。
    return redirectWithOutcome(ADMIN_HOME_PATH, reason.reason);
  }

  const outcome = await setReviewState(env, {
    gameId,
    // **いまの状態は送られてこない。** 切り替えた先の反対がそれである
    // （`oppositeReviewState`）。**画面を開いたまま別の管理者が動かしていたら、
    // UPDATE が当たらず `not-applicable` になる**——上書きしない。
    from: oppositeReviewState(next),
    to: next,
    actorId: adminUserId,
    reason: reason.value,
  });

  return redirectWithOutcome(
    ADMIN_HOME_PATH,
    outcome.ok ? (outcome.changed ? 'applied' : 'unchanged') : outcome.reason,
  );
}

/**
 * 審査キューの経路。
 *
 * **ここで権限を確かめない。** 守るのは `handleAdminRequest`（`src/admin/routes.ts`）で、
 * **経路表を引く手前**にある。**`ADMIN_OPEN_ROUTES` へ足さない限り、この 2 本は
 * 未ログインでも `is_admin = 0` でも 404 になる**（既定が「閉」である）。
 *
 * @param adminUserId 実行者（権限の判定済み。GET の画面は使わない）
 * @returns 経路
 */
export function adminReviewRoutes(adminUserId: string | null): readonly Route[] {
  return [
    { method: 'GET', path: ADMIN_HOME_PATH, handler: (request, env) => showReviewQueue(request, env) },
    {
      method: 'POST',
      path: ADMIN_REVIEW_API_PATH,
      handler: (request, env) => handleReviewChange(request, env, adminUserId),
    },
  ];
}
