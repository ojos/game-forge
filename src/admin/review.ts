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
 * 3 つ目の節: 問題なしとしたあとに通報が付いた `cleared`（#367 / #394）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`cleared` は終端なので、そのあとに付いた通報は `queued` だけを引く一覧に出ない。**
 * #367 は「改名のあとに通報が付いた作品」としてこの節を足し、**#394 で「最後に問題なしに
 * した時刻以降に通報が付いた作品」へ一般化した**（改名はその 1 つの場合である。理由は
 * `src/reports.ts` の {@link REVIEW_REPORTED_AFTER_CLEAR_SQL}）。
 *
 * **条件を書き写さない。** 正本は `src/reports.ts` の {@link REVIEW_REPORTED_AFTER_CLEAR_SQL}
 * 1 か所で、この画面もスクリプトもそれを借りる（スクリプトはソースから取り出す）。
 * **`games` の別名は `g` 固定**なので、この画面の SQL も `g` で書き、**外側で `r` / `a` を
 * 使わない**（相関副問い合わせの `r` / `a` と取り違えるため。あちらの但し書き）。
 *
 * **`cleared` の節とは分ける。** 同じ `cleared` だが、**運営にとっての意味が違う**
 * ——`cleared` の節は「見終わった作品」で、こちらは「見たあとで、また通報が付いた
 * 作品」である。**同じ節に混ぜると区別が付かない**（#367 の受け入れ）。
 * 行は片方にしか出さない（`cleared` の節は `not REVIEW_REPORTED_AFTER_CLEAR_SQL` で引く）
 * ——両方に出すと、同じ作品に同じ操作のフォームが 2 つ並ぶ。
 *
 * **操作は増やさない**（#367 / #394 の scope.out）。この節の行が持つのは `cleared` の行と
 * 同じ「審査待ちへ戻す」だけである。**見終えたら「審査待ちへ戻す」→「問題なしにする」で
 * 節から外れる**——問題なしにした時刻が新しい基準になるので、それより前の通報では
 * 当たらない（#367 のときは、次に改名されるまで出続けていた。#394 で塞いだ）。
 *
 * **履歴の無い `cleared`（#361 より前に端末で問題なしにした作品）は、通報があればこの節に
 * 出す**（黙って落とさない。理由は `src/reports.ts`）。上の往復で 1 度通せば外れる。
 *
 * **最終改名の時刻は、条件ではなく手がかりとして出す。** 改名は「問題なしとした時点から
 * 作品が変わった」主な場合であり、運営が作品ページで何を確かめるかが変わる。
 *
 * **`review_state` が NULL の作品は出さない。** それは「通報の閾値に達していない」
 * 大多数の作品であり（0017）、**審査の対象ではない。** 運営が手で止める操作も
 * 置いていない（投入するのは通報の側である。8.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 中身はここに出さない。ただし、通報された時点の題名・説明・作者名は出す（#405）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **通報の理由と作品の中身（遊べる形）は出さない**（`scripts/report-queue.sh` が
 * 同じ判断をしている——「中身は作品ページで見てください」）。作品そのものは
 * **app ホストの作品ページで開く**ので、行ごとに絶対 URL のリンクを置く。
 *
 * **通報ごとに、通報された時点の題名・説明・作者の表示名を、いまの値と並べて出す**（#405）。
 * 作品ページが見せるのは**いまの**値だけで、作者が改名や説明の書き換え、名前の変更で
 * 言い逃れていても運営には分からない——#404 が作品をキューへ戻しても、判断の材料が
 * 無かった。**復元の規則と、同じ秒・記録の無い時点の扱いは `src/admin/report-evidence.ts`
 * にある。** どれも利用者が書いた値なので、すべて `escapeHtml` を通す。
 *
 * **読み取りは節ごとに 1 本足すだけで、通報の数に比例しない**（一覧の 3 本と合わせて
 * 6 本を 1 つの batch で送る。{@link readQueue}）。
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
  REVIEW_REPORTED_AFTER_CLEAR_SQL,
  TITLE_CHANGES_TABLE,
} from '../reports.js';
import {
  REPORT_EVIDENCE_PER_GAME,
  differsFromNow,
  reportEvidenceSql,
  toReportEvidence,
} from './report-evidence.js';
import type { ReportEvidence, ReportEvidenceRow, RestoredValue } from './report-evidence.js';
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
  /** 最後の改名の時刻（UNIX 秒）。**問題なしのあとに通報が付いた節だけが引く**（ほかの節では常に null）。 */
  readonly renamed_at: number | null;
}

/** 節の識別子。**フォームの要素 id に入る**ので、節ごとに違う綴りである。 */
type ReviewSectionKey = 'queued' | 'reported' | 'cleared';

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
   * 条件か列が、あとから足した履歴の表を読むか（`admin_actions` / `title_changes`）。
   *
   * **読めないときに読み直す節を決める**（{@link readQueue}）。`0026` / `0027` が未適用の
   * D1 で落ちるのはこれが真の節である（`REVIEW_REPORTED_AFTER_CLEAR_SQL` は
   * `admin_actions` を、最終改名の時刻は `title_changes` を読む）。
   */
  readonly readsHistory: boolean;
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
 * （審査待ちが先。運営が最初に見るものが上にある。**問題なしのあとに通報が付いた節は
 * `cleared` より上**——こちらは「まだ見ていない可能性がある」作品である）。
 */
const SECTIONS: readonly ReviewSection[] = [
  {
    key: 'queued',
    state: REVIEW_QUEUED,
    where: `g.review_state = '${REVIEW_QUEUED}'`,
    showsRename: false,
    readsHistory: false,
    badge: null,
    heading: '審査待ち',
    empty: 'いま審査待ちの作品はありません。',
    note: '新規露出が止まっています（一覧とトップに出ません）。共有済みの URL は生きています。',
    button: '問題なしにする（新規露出を戻す）',
  },
  {
    key: 'reported',
    state: REVIEW_CLEARED,
    // **条件の正本はここではない**（`src/reports.ts`。このファイルの冒頭）。
    where: REVIEW_REPORTED_AFTER_CLEAR_SQL,
    showsRename: true,
    readsHistory: true,
    badge: '問題なしのあとに通報あり',
    heading: '問題なしとしたあとに通報が付いた作品',
    empty: 'いま該当する作品はありません。',
    note:
      '「問題なし」とした作品のうち、最後に問題なしとした時刻以降に通報が付いたものです' +
      '（作者が題名を変えたあとの通報もここに出ます）。' +
      '管理画面ができる前に問題なしとした作品は、その時刻の記録が無いため、通報があればここに出ます。' +
      '露出は止まっていません。作品ページで確かめ、止めるべきなら審査待ちへ戻してください。' +
      '確かめて問題が無ければ、審査待ちへ戻してから再び問題なしにすると、この節から外れます。',
    button: '審査待ちへ戻す（新規露出を止める）',
  },
  {
    key: 'cleared',
    state: REVIEW_CLEARED,
    // **上の節に出す行を除く**（同じ作品にフォームを 2 つ並べない）。
    where: `g.review_state = '${REVIEW_CLEARED}' and not ${REVIEW_REPORTED_AFTER_CLEAR_SQL}`,
    showsRename: false,
    readsHistory: true,
    badge: null,
    heading: '問題なしとした作品',
    empty: 'まだ 1 件もありません。',
    note:
      '露出は戻っています。再び閾値に達してもキューへは戻りません（通報の側では戻せない状態です）。' +
      '問題なしとしたあとに通報が付いた作品は、上の節に出します。',
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
 * 問題なしのあとの通報を見る条件の相関副問い合わせは `cleared` の行ごとに走るが、
 * 引く表にはどれも対象の id を先頭に持つ索引がある（0017 の `reports_game_reporter_uq` /
 * 0027 の `title_changes_game_changed_idx` / 0029 の `admin_actions_target_idx`）。
 * **0029 が無いと `admin_actions` の全走査が `cleared` の行ごとに走る**（実測は 0029）。
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
 * `0027` が未適用の D1 で**審査待ちの節まで読めなくなる**（下記 {@link readQueue}）。
 * **旧題名・新題名はこの文では引かない**——ここで出すのは時刻だけで、行の見出しの題名は
 * いまの 1 つである（`scripts/report-queue.sh` が `last_rename` で同じ線を引いている）。
 * **通報の時点の題名は、通報ごとに別の文で復元して出す**（#405。{@link evidenceStatement}）。
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
  // **別名は `tc` にする。** `REVIEW_REPORTED_AFTER_CLEAR_SQL` の中の別名（`r` / `a`）と
  // 綴りを重ねず、読む人が「どちらの別名か」を追わずに済むようにする。
  const renamedAt = section.showsRename
    ? `(select max(tc.changed_at) from ${TITLE_CHANGES_TABLE} tc where tc.game_id = g.id)`
    : 'null';
  return env.DB.prepare(
    `select g.id, g.title, g.published_at, u.display_name as author_name,
            ${renamedAt} as renamed_at
       ${sectionScopeSql(section)}`,
  ).bind(PUBLISHED_STATUS, limit);
}

/**
 * 節に並べる作品を選ぶ `from` 以降（条件・並び・件数）。
 *
 * **一覧の文と、通報の時点の値を引く文（#405）が同じ断片を使う。** 2 か所に書くと、片方の
 * 並びや件数だけが変わった日に、**一覧に出ている作品の通報が引けない**（あるいは出ていない
 * 作品の通報を引く）。束縛は `status` → 件数の 2 つである。
 *
 * **並びは公開の新しい順である。** 通報の時刻で並べるには `reports` を集計する
 * 必要があり（`scripts/report-queue.sh` はそうしている）、**画面 1 枚のために
 * 読み取りを増やす理由が無い**——平常時のキューは数件である。
 *
 * @param section 節の定義
 * @returns `from games g ...` から `limit ?` まで（**`games` の別名は `g`、`users` は `u`**）
 */
function sectionScopeSql(section: ReviewSection): string {
  return `from games g
       left join users u on u.id = g.author_id
      where ${section.where} and g.status = ?
      order by g.published_at desc, g.id desc
      limit ?`;
}

/**
 * ある節に並ぶ作品の通報と、通報の時点の値を引く文（#405。**節ごとに 1 本**）。
 *
 * **作品の選び方は一覧の文と同じ断片である**（{@link sectionScopeSql}）。文の中身と規則は
 * `src/admin/report-evidence.ts`。
 *
 * @param env バインディングと環境変数
 * @param section 節の定義
 * @param limit 節の件数の上限（一覧の文と同じ値を渡す）
 * @returns 準備済みの文
 */
function evidenceStatement(
  env: Env,
  section: ReviewSection,
  limit: number = ADMIN_LIST_LIMIT,
): D1PreparedStatement {
  return env.DB.prepare(reportEvidenceSql(`select g.id ${sectionScopeSql(section)}`)).bind(
    PUBLISHED_STATUS,
    limit,
    REPORT_EVIDENCE_PER_GAME,
  );
}

/** 1 つの節を読んだ結果。**読めなかったことを 0 行と区別する。** */
type SectionRead =
  | { readonly ok: true; readonly rows: readonly ReviewRow[] }
  | { readonly ok: false };

/**
 * 1 つの節の通報の時点の値を読んだ結果（#405）。**読めなかったことを「通報が無い」と区別する。**
 *
 * `byGame` は作品の id から、その作品の通報（新しい順）を引く。
 */
type EvidenceRead =
  | { readonly ok: true; readonly byGame: ReadonlyMap<string, readonly ReportEvidence[]> }
  | { readonly ok: false };

/** 審査キューの画面が読むもの（節ごとの一覧と、節ごとの通報の時点の値）。 */
interface QueueRead {
  /** {@link SECTIONS} と同じ順。 */
  readonly sections: readonly SectionRead[];
  /** {@link SECTIONS} と同じ順。 */
  readonly evidence: readonly EvidenceRead[];
}

/** 読めなかった通報の時点の値（読み直しの経路で使う）。 */
const EVIDENCE_UNREAD: EvidenceRead = { ok: false };

/**
 * 通報の時点の値の行を、作品ごとにまとめる。
 *
 * @param rows {@link evidenceStatement} の行（作品ごとに新しい順）
 * @returns 作品の id から通報の並び
 */
function groupEvidence(rows: readonly ReportEvidenceRow[]): EvidenceRead {
  const byGame = new Map<string, ReportEvidence[]>();
  for (const row of rows) {
    const evidence = toReportEvidence(row);
    const list = byGame.get(evidence.gameId);
    if (list === undefined) {
      byGame.set(evidence.gameId, [evidence]);
    } else {
      list.push(evidence);
    }
  }
  return { ok: true, byGame };
}

/**
 * 3 つの節と、節ごとの通報の時点の値を読む。**同じ時点の状態から読み、失敗しても画面ごと落とさない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1 つの batch で読む（PR #392 の Copilot レビュー / #405）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **節ごとに別々に読むと、節ごとに違う時点の状態になる。** 読み取りの間に別の管理者が
 * 作品を `queued` ↔ `cleared` へ動かすと、**同じ作品が 2 つの節に、向きの違う
 * ボタン付きで並ぶ**——「行は片方にしか出さない」が破れる。`D1.batch` は 1 つの
 * トランザクションなので、SELECT がすべて同じ状態を見る。
 *
 * **#405 で、節ごとに通報の時点の値を引く文を 1 本ずつ足した**（3 本 + 3 本）。同じ batch に
 * 入れるので、一覧に並んだ作品と通報を引いた作品が食い違わない。**本数は通報の数に依らない**
 * （通報ごとに文を発行しない。`test/admin-screens.test.ts` が通報の数を変えて突き合わせる）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 読めなければ、読める範囲だけを読み直す
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **あとから足した表を読む文ほど、適用漏れで落ちうる**（`title_changes` / `admin_actions` /
 * `description_changes` / `display_name_changes`。`migrations/0026`〜`0030`）。1 本でも落ちると
 * batch ごと落ちるので、**段階を踏んで読み直す。**
 *
 *   1. **通報の時点の値を諦め、一覧の 3 本だけを読み直す**（#405 で足した表の適用漏れでは、
 *      #367 / #394 から動いていた一覧を巻き添えにしない）
 *   2. それも落ちれば、**{@link ReviewSection.readsHistory} が偽の節（審査待ち）だけ**を読み直す
 *      （#367 / #394 で足した表の適用漏れで、#361 から動いていた一覧を巻き添えにしない）。
 *      **1 節だけなので、時点のずれによる重複は起こりえない**
 *
 * **0 行として描かない。** 「該当なし」と「読めていない」を区別できなくなる
 * （`scripts/report-queue.sh` が終了コード 1 と 2 を分けているのと同じ線）。
 *
 * @param env バインディングと環境変数
 * @returns 節ごとの結果と、節ごとの通報の時点の値
 */
async function readQueue(env: Env): Promise<QueueRead> {
  try {
    const results = await env.DB.batch<Record<string, unknown>>([
      ...SECTIONS.map((section) => sectionStatement(env, section)),
      ...SECTIONS.map((section) => evidenceStatement(env, section)),
    ]);
    return {
      sections: SECTIONS.map((_, index): SectionRead => {
        const result = results[index];
        return result === undefined
          ? { ok: false }
          : { ok: true, rows: result.results as unknown as readonly ReviewRow[] };
      }),
      evidence: SECTIONS.map((_, index): EvidenceRead => {
        const result = results[SECTIONS.length + index];
        return result === undefined
          ? EVIDENCE_UNREAD
          : groupEvidence(result.results as unknown as readonly ReportEvidenceRow[]);
      }),
    };
  } catch (error) {
    console.error('[admin] 審査キューを読めませんでした。通報の時点の値を除いて読み直します', error);
  }

  const evidence = SECTIONS.map(() => EVIDENCE_UNREAD);
  try {
    const results = await env.DB.batch<ReviewRow>(
      SECTIONS.map((section) => sectionStatement(env, section)),
    );
    return {
      sections: SECTIONS.map((_, index): SectionRead => {
        const result = results[index];
        return result === undefined ? { ok: false } : { ok: true, rows: result.results };
      }),
      evidence,
    };
  } catch (error) {
    console.error('[admin] 審査キューの一覧も読めませんでした。審査待ちの節だけを読み直します', error);
  }

  const sections = await Promise.all(
    SECTIONS.map(async (section): Promise<SectionRead> => {
      if (section.readsHistory) {
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
  return { sections, evidence };
}

/**
 * 1 行を組み立てる。
 *
 * **D1 から来る値は題名と作者名と id の 3 つで、すべて `escapeHtml` を通す**
 * （`src/work-card.ts` の規律。題名は利用者が名乗った値である）。時刻は数値から
 * 組み立てる。**通報の時点の値（#405）も同じく `escapeHtml` を通す**（{@link renderEvidence}）。
 *
 * **理由の欄に `size` を付けない**（`test/admin-page-shell.test.ts` が見ている。
 * `size` / `cols` は layout viewport を広げ、狭い端末で崩れる原因になる。#282）。
 *
 * **理由の欄の id に節の識別子を入れる。** 状態（`cleared`）で作ると、問題なしのあとに
 * 通報が付いた節と `cleared` の節が同じ綴りを持ちうる——`label` の `for` が別の行の入力を
 * 指す。
 *
 * ## 見た目の部品（仕様 2.5 / #475）
 *
 * - **1 件を 1 つのブロックにする**（`.gf-block`。面で区切り、枠線を使わない。2.5.4）
 * - **ボタンは副にする**（`.gf-button-secondary`）。行ごとに操作があるので、**主のボタンは使わない**
 *   （「主は 1 画面に 1 つ」を保つ。2.5.10 の第 4 版の決定）
 * - **節の札はチップにする**（`.gf-chip-emphasis`。止まっていない露出に目を向けさせる印である）
 * - **題名は文章の外のリンク**（`.gf-link-quiet`。一覧の行の題名。2.5.5）
 * - **理由の入力欄とボタンは 1 つの `div` に並べる**（`.gf-admin-submit`。狭い段では折り返して縦に積む。
 *   `admin.css`）。**要素の順（ラベル → 入力欄 → ボタン）は変えていない**——DOM の順＝見た目の順＝Tab の順
 *
 * @param row 作品の行
 * @param section 節の定義
 * @param evidence この節の通報の時点の値
 * @param appHost app ホストの綴り（作品ページのリンクに使う）
 * @returns HTML
 */
function renderRow(
  row: ReviewRow,
  section: ReviewSection,
  evidence: EvidenceRead,
  appHost: string,
): string {
  const id = escapeHtml(row.id);
  // **作品ページは app ホストにある。** 絶対 URL で組み立てる——admin ホストの
  // 相対リンクにすると 404 へ送ることになる（4.4 / 2.2 が禁じている形）。
  const workUrl = `https://${escapeHtml(appHost)}${escapeHtml(workPagePath(row.id))}`;
  const reasonId = `reason-${section.key}-${id}`;
  // **札は文字で出す**（色だけで区別しない。明暗どちらのテーマでも、読み上げでも同じに届く）。
  const badge =
    section.badge === null
      ? ''
      : `\n  <p class="gf-admin-row-head"><span class="gf-chip gf-chip-emphasis">${escapeHtml(section.badge)}</span></p>`;
  const renamed = section.showsRename ? ` ／ 最終改名: ${timeOrDash(row.renamed_at)}` : '';

  return `<li class="gf-block gf-admin-row">${badge}
  <p class="gf-admin-row-title"><a class="gf-link-quiet" href="${workUrl}">${escapeHtml(row.title)}</a></p>
  <p class="gf-admin-meta">作者: ${escapeHtml(row.author_name ?? '（不明）')} ／ 公開: ${timeOrDash(row.published_at, '未公開')}${renamed}<br>
     <code>${id}</code></p>
${renderEvidence(evidence.ok ? (evidence.byGame.get(row.id) ?? []) : null)}
  <form method="post" action="${ADMIN_REVIEW_API_PATH}">
    <input type="hidden" name="${ADMIN_GAME_ID_FIELD}" value="${id}">
    <input type="hidden" name="${ADMIN_NEXT_FIELD}" value="${oppositeReviewState(section.state)}">
    <label for="${reasonId}">理由（必須。履歴に残ります）</label>
    <div class="gf-admin-submit">
      <input id="${reasonId}" name="${ADMIN_REASON_FIELD}" type="text" required>
      <button type="submit" class="gf-button gf-button-secondary">${escapeHtml(section.button)}</button>
    </div>
  </form>
</li>`;
}

/**
 * 1 作品の通報と、通報の時点の値を組み立てる（#405）。
 *
 * **通報ごとに、題名・説明・作者名の「通報の時点」と「いま」を並べる。** 変わっていれば
 * 項目の見出しに**文字で**「変わっています」と付ける（色に頼らない。節の札と同じ）。
 *
 * **読めなかったとき（null）は「読み込めませんでした」と書く**——「通報が無い」と区別する
 * （{@link readQueue}）。
 *
 * **通報があれば、ブロックの中に地の色の面で置く**（`.gf-admin-evidence`。承認したモックアップの形。#475）。
 *
 * @param reports その作品の通報（新しい順。読めなければ null）
 * @returns HTML
 */
function renderEvidence(reports: readonly ReportEvidence[] | null): string {
  if (reports === null) {
    return `  <p class="gf-admin-evidence-note error">通報の時点の題名・説明・作者名を読み込めませんでした（通報が無いという意味ではありません）。</p>`;
  }
  const first = reports[0];
  if (first === undefined) {
    return `  <p class="gf-admin-evidence-note">この作品の通報は見つかりませんでした。</p>`;
  }
  const hidden = first.reportCount - reports.length;
  const summary =
    hidden > 0
      ? `通報 ${first.reportCount} 件のうち、新しい ${reports.length} 件の時点の値です（ほかに古い通報が ${hidden} 件あります）。`
      : `通報 ${first.reportCount} 件の、それぞれの時点の値です。`;
  return `  <div class="gf-admin-evidence">
  <p class="gf-admin-evidence-note">${escapeHtml(summary)}</p>
  <ol class="gf-admin-evidence-list">
${reports.map(renderReport).join('\n')}
  </ol>
  </div>`;
}

/**
 * 通報 1 件を組み立てる（#405）。
 *
 * @param report 通報と、その時点の値
 * @returns HTML
 */
function renderReport(report: ReportEvidence): string {
  return `  <li class="gf-admin-evidence-report">
    <p class="gf-admin-evidence-when">通報: ${timeOrDash(report.reportedAt)}</p>
    <dl class="gf-admin-evidence-fields">
${renderField('題名', report.title.atReport, report.title.now)}
${renderField('説明', report.description.atReport, report.description.now)}
${renderField('作者名', report.authorName.atReport, report.authorName.now)}
    </dl>
  </li>`;
}

/**
 * 1 つの項目の「通報の時点」と「いま」を組み立てる（#405）。
 *
 * **3 つの場合を文字で言い分ける**（`src/admin/report-evidence.ts` の {@link RestoredValue}）。
 *
 *   - 値が 1 つに決まる … 「通報の時点」と「いま」を並べ、違えば「変わっています」
 *   - 通報と同じ秒に変更がある … **どちらかに倒さず**、その秒の変更の前と後を両方出し、
 *     「通報と同じ秒に変更がありました」と書く
 *   - 記録が無い … **いまの値を当時の値として出さない。** 「この時点の〜の記録はありません」
 *
 * **印はチップにする**（`.gf-chip`。仕様 2.5.5 の押せない札。#475）。**値は「通報の時点」と「いま」の 2 つの
 * 塊に分ける**（`.gf-admin-evidence-cell`）——広い段では 2 列に並び、狭い段では 1 列に積む（`admin.css`）。
 * **塊の中の行の頭には、どちらの段でも「通報の時点」「いま」を書く**——同じ秒の変更では片側に値が 2 つ入り、
 * 見出しの行 1 つでは言い分けられない。
 *
 * @param label 項目の名前（題名・説明・作者名）
 * @param atReport 通報の時点の値
 * @param now いまの値（引けなければ null）
 * @returns HTML
 */
function renderField(label: string, atReport: RestoredValue, now: string | null): string {
  const differs = differsFromNow(atReport, now);
  const mark =
    atReport.kind === 'same-second'
      ? '通報と同じ秒に変更がありました'
      : differs === null
        ? '記録がありません'
        : differs
          ? '変わっています'
          : '変わっていません';
  const lines =
    atReport.kind === 'known'
      ? [evidenceLine('通報の時点', atReport.value)]
      : atReport.kind === 'same-second'
        ? [
            evidenceLine('同じ秒の変更の前', atReport.before),
            evidenceLine('同じ秒の変更の後', atReport.after),
            `        <p class="gf-admin-evidence-note">通報と変更の前後は秒より細かく記録していないため、どちらの値だったかは分かりません。</p>`,
          ]
        : [
            `        <p><span class="gf-admin-evidence-label">通報の時点</span> <span class="gf-admin-evidence-none">この時点の${escapeHtml(label)}の記録はありません</span></p>`,
          ];
  const current =
    now === null
      ? `        <p><span class="gf-admin-evidence-label">いま</span> <span class="gf-admin-evidence-none">（不明）</span></p>`
      : evidenceLine('いま', now);
  return `      <div class="gf-admin-evidence-field">
      <dt>${escapeHtml(label)} <span class="gf-chip">${escapeHtml(mark)}</span></dt>
      <dd>
        <div class="gf-admin-evidence-cell">
${lines.join('\n')}
        </div>
        <div class="gf-admin-evidence-cell">
${current}
        </div>
      </dd>
      </div>`;
}

/**
 * 「通報の時点」「いま」などの 1 行を組み立てる（#405）。
 *
 * **値は利用者が書いたもので、必ず `escapeHtml` を通す。** 説明の改行は CSS
 * （`white-space: pre-wrap`）で保つ——`<br>` へ置き換える処理をここに持たない
 * （作品ページの段落の組み方と、運営が確かめる生の文章は別物である）。
 * **空文字は「（空）」と書く**（説明なし。空の行を「値が無い」と取り違えない）。
 *
 * @param caption 行の見出し
 * @param value 値
 * @returns HTML
 */
function evidenceLine(caption: string, value: string): string {
  const body =
    value === ''
      ? '<span class="gf-admin-evidence-none">（空）</span>'
      : `<span class="gf-admin-evidence-value">${escapeHtml(value)}</span>`;
  return `        <p><span class="gf-admin-evidence-label">${escapeHtml(caption)}</span> ${body}</p>`;
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
 * **読めなかった節は、件数の代わりにそう書く**（{@link readQueue}）。
 *
 * @param section 節の定義
 * @param read 読んだ結果
 * @param evidence この節の通報の時点の値（#405）
 * @param appHost app ホストの綴り
 * @returns HTML
 */
function renderSection(
  section: ReviewSection,
  read: SectionRead,
  evidence: EvidenceRead,
  appHost: string,
): string {
  if (!read.ok) {
    return `<h2>${escapeHtml(section.heading)}（読み込めませんでした）</h2>
<p class="error" role="alert">この節を読み込めませんでした。0 件という意味ではありません。
   マイグレーションの適用漏れ（操作の履歴 <code>admin_actions</code>・改名の履歴 <code>title_changes</code>・表示名の履歴 <code>display_name_changes</code> など）の可能性があります。</p>`;
  }
  const { rows } = read;
  const body =
    rows.length === 0
      ? `<p class="gf-admin-note">${escapeHtml(section.empty)}</p>`
      : `<ul class="gf-admin-list">
${rows.map((row) => renderRow(row, section, evidence, appHost)).join('\n')}
</ul>`;
  return `<h2>${escapeHtml(section.heading)}（${rows.length} 件）</h2>
<p class="gf-admin-note">${escapeHtml(section.note)}</p>
${body}`;
}

/**
 * 審査キューの画面を返す。
 *
 * **読み取りは節ごとに 2 本**（一覧と、並んだ作品の通報の時点の値。#405）で、
 * それぞれ件数を固定し、**6 本を 1 つの batch で送る**（{@link readQueue}）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showReviewQueue(request: Request, env: Env): Promise<Response> {
  const reads = await readQueue(env);
  const outcome = new URL(request.url).searchParams.get(ADMIN_OUTCOME_QUERY);
  // **通報の時点の値が読めなかったときも「一部を読めなかった」に数える**（#405。証拠を
  // 欠いた画面を、欠けていないかのように 200 で返さない）。
  const unreadable =
    reads.sections.some((read) => !read.ok) || reads.evidence.some((read) => !read.ok);

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
<div class="gf-block gf-admin-intro">
<p>通報が閾値に達した作品がここへ入ります（仕様 8.4）。<strong>止まるのは新規露出だけで、作品の取り下げはこの画面に置いていません</strong>（仕様 2.4.3。戻せない操作のため、引き続き D1 への直接 UPDATE で行います）。</p>
<p>どちらの操作も理由が必須で、<strong>操作と履歴は 1 つの書き込みで残ります</strong>（仕様 2.4.4）。</p>
<p>各作品の下に、<strong>通報ごとに、通報された時点の題名・説明・作者名と、いまの値を並べます</strong>（変更の履歴から復元しています。表示名の履歴を残し始める前の通報では、作者名の記録はありません）。</p>
</div>
${SECTIONS.map((section, index) =>
  renderSection(
    section,
    reads.sections[index] ?? { ok: false },
    reads.evidence[index] ?? EVIDENCE_UNREAD,
    env.APP_HOST,
  ),
).join('\n')}
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
