/**
 * 通報された時点の題名・説明・作者の表示名を、変更の履歴から復元する（8.4 / 2.4.3 / #405）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ要るのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **審査キューで通報を開いても、通報された時点の中身が分からなかった。** 作者が題名や説明、
 * 表示名を変えていれば、運営に見えるのは変えたあとの値だけで、**改名で言い逃れた作品を
 * #404 がキューへ戻しても、運営は穏当な題名を見て「問題なし」にするしかない。**
 *
 * **公開後に変わりうるのは、作品の題名と説明、作者の表示名の 3 つである**（中身のソース・
 * Wasm は公開後に変わらない。5.7）。**通報ごとの写しは持たず**、3 つの変更の履歴
 * （`title_changes` 0027 / `description_changes` 0028 / `display_name_changes` 0030）から
 * 通報の時刻の値を復元する（issue #405 の決定）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 復元の規則は 1 つで、3 つの値に同じように掛ける（{@link restoreValueAt}）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 通報の時刻を T として、
 *
 *   1. **T 以前で最後の変更の「新しい値」**
 *   2. 無ければ **T より後で最初の変更の「古い値」**
 *   3. 変更が 1 件も無ければ **いまの値**
 *
 * **履歴の 3 つの表は同じ形である**（`id` / 対象の id / 古い値 / 新しい値 / `changed_at`）。
 * SQL は表の名前と列の名前だけを差し替えて同じ文を組み（{@link historyNeighborsSql}）、
 * 値の選び方は {@link restoreValueAt} だけが持つ。**題名・説明・表示名で規則を書き分けない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 同じ秒は、どちらかに倒さずに両方を出す
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **時刻は UNIX 秒で、通報と変更が同じ秒に起きると前後が分からない。** 規則の 1 は同じ秒の
 * 変更を「通報より前」として扱うが、それを黙って出すと、**実際には通報の時点で見えていた
 * 値を「変更の後の値」で上書きして見せる**ことがありうる（逆に倒しても同じ）。
 *
 * そこで、**T と同じ秒の変更があるときは「その秒の変更の前の値」と「後の値」の両方を出し、
 * 同じ秒に変更があったと示す**（{@link RestoredValue} の `same-second`）。前の値は
 * 「T より前で最後の変更の新しい値、無ければ T 以後で最初の変更の古い値、無ければいまの値」
 * ——規則の 1 と 2 の境界を 1 秒ずらしただけで、**同じ規則である。**
 *
 * 審査キューの条件（`src/reports.ts` の `REVIEW_REPORTED_AFTER_CLEAR_SQL`）は同じ秒を
 * 「拾う側」へ倒しているが、あちらは**出すかどうか**を決める条件で、多く出す代償が小さい。
 * こちらは**証拠として見せる値そのもの**なので、倒した側が誤っていたときの代償が大きい。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 履歴が無い時点について、いまの値を当時の値として出さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **規則の 3（いまの値）は「その時点以降の変更が、すべて履歴に残っている」ときにだけ正しい。**
 *
 *   - **題名は正しい。** `update games set title` は `renameGame`（#366）にしか無く、それが
 *     書く `title_changes` は #366 と同時に入った（本番へは 0027 をマージの前に当てた。
 *     `docs/admin-host.md` の Ⓕ）。**それより前に題名を変える経路は無かった**——題名が入るのは
 *     行を作る瞬間だけだった（5.1 の #366 注記）。推敲（5.7）もフォークも既存の行の題名を触らない
 *   - **説明も正しい。** `games.description` は 0028 が `DEFAULT ''` で足した列で、書くのは
 *     `describeGame`（#388）だけであり、`description_changes` と 1 つの batch で書く。**0028 より
 *     前の説明は、すべての作品で空だった**
 *   - **表示名は正しくない。** 0022 以降は `/account` で、それ以前からログインのたびに Google の
 *     名前で変わっていた。**履歴を書き始めたのは 0030 からである**
 *
 * **表示名は、履歴を書き始めた時刻（`display_name_history_start`。0030 が適用の時刻を書く）
 * 以前の通報では「記録がありません」とする**（{@link RestoredValue} の `unrecorded`）。
 * **同じ秒は「記録が無い」側へ倒す**——その秒のうちに、適用の前に古いコードが名前を
 * 変えていたかは区別できない。判定の基準に「その利用者の最初の履歴」「表全体の最初の履歴」
 * 「固定の時刻」を採らなかった理由は `migrations/0030_display_name_changes.sql` にある。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 読み取りは通報の数に比例させない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **1 つの節につき 1 本の文で、その節に並ぶ作品の通報をまとめて引く**（{@link reportEvidenceSql}）。
 * 審査キューの画面は節ごとの一覧の文と一緒に 1 つの `D1.batch` で送るので、**文の本数は
 * 通報が何件あっても変わらない**（`test/admin-screens.test.ts` が、通報の数を変えて本数を
 * 突き合わせる）。1 件の通報に掛かる副問い合わせは、どれも `(対象の id, changed_at)` の
 * 索引の範囲の端を読むだけである。
 *
 * **1 作品に出す通報は新しい順に {@link REPORT_EVIDENCE_PER_GAME} 件まで**にする（節の件数を
 * 50 に固定しているのと同じ考え方で、画面 1 枚の大きさを通報の数に比例させない）。
 * 残りの件数は出す。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ここに置かないもの
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **通報の理由**（審査キューは中身を作品ページで見る。`src/admin/review.ts` の冒頭）
 * - **通報した人**（通報者を運営の画面に並べる理由が無い）
 * - **HTML**（`src/admin/review.ts` が組む。時刻の出し方をあちらと揃えるため）
 */
import { DESCRIPTION_CHANGES_TABLE } from '../games.js';
import {
  DISPLAY_NAME_CHANGES_TABLE,
  DISPLAY_NAME_HISTORY_START_TABLE,
} from '../display-name-changes.js';
import { TITLE_CHANGES_TABLE } from '../reports.js';

/**
 * 1 作品について出す通報の件数の上限（新しい順）。
 *
 * **5 件。** 通報は同じ人が同じ作品へ 1 度しかできず（`reports_game_reporter_uq`）、閾値は
 * 1 人である（`src/reports.ts`）。**クローズドβの規模で 1 作品に 5 人を超える通報が付くのは、
 * それ自体が目立つ出来事**で、残りの件数は画面に出す。
 */
export const REPORT_EVIDENCE_PER_GAME = 5;

/**
 * 変更の履歴を持つ表の形（3 つとも同じ形である）。
 *
 * **綴りはすべて定数で、利用者の入力は 1 文字も入らない**（SQL へそのまま差し込む）。
 */
export interface HistorySource {
  /** 表の名前。 */
  readonly table: string;
  /** 対象の id の列（`game_id` / `user_id`）。 */
  readonly keyColumn: string;
  /** 変える前の値の列。 */
  readonly oldColumn: string;
  /** 変えた後の値の列。 */
  readonly newColumn: string;
}

/** 題名の履歴（`migrations/0027_title_changes.sql`）。 */
export const TITLE_HISTORY: HistorySource = {
  table: TITLE_CHANGES_TABLE,
  keyColumn: 'game_id',
  oldColumn: 'old_title',
  newColumn: 'new_title',
};

/** 説明の履歴（`migrations/0028_game_descriptions.sql`）。 */
export const DESCRIPTION_HISTORY: HistorySource = {
  table: DESCRIPTION_CHANGES_TABLE,
  keyColumn: 'game_id',
  oldColumn: 'old_description',
  newColumn: 'new_description',
};

/** 表示名の履歴（`migrations/0030_display_name_changes.sql`）。 */
export const DISPLAY_NAME_HISTORY: HistorySource = {
  table: DISPLAY_NAME_CHANGES_TABLE,
  keyColumn: 'user_id',
  oldColumn: 'old_display_name',
  newColumn: 'new_display_name',
};

/**
 * ある時刻 T の前後で、いちばん近い変更の値（{@link restoreValueAt} の入力）。
 *
 * **履歴の値の列はどれも NOT NULL である**（0027 / 0028 / 0030）ので、**null は「その向きに
 * 変更が無い」ことだけを表す**（空文字の説明と取り違えない）。
 */
export interface HistoryNeighbors {
  /** T 以前（**T と同じ秒を含む**）で最後の変更の、新しい値。 */
  readonly newAtOrBefore: string | null;
  /** T より後（**T と同じ秒を含まない**）で最初の変更の、古い値。 */
  readonly oldAfter: string | null;
  /** T より前（**T と同じ秒を含まない**）で最後の変更の、新しい値。 */
  readonly newBefore: string | null;
  /** T 以後（**T と同じ秒を含む**）で最初の変更の、古い値。 */
  readonly oldAtOrAfter: string | null;
  /** T と同じ秒に変更があるか。 */
  readonly sameSecond: boolean;
}

/** 通報の時点の値。 */
export type RestoredValue =
  /** 通報の時点の値が 1 つに決まる。 */
  | { readonly kind: 'known'; readonly value: string }
  /**
   * 通報と同じ秒に変更があり、前後が分からない。**`before` はその秒の変更の前の値、
   * `after` は後の値**（同じ秒に何度変わっても、その秒の最初の前と最後の後である）。
   */
  | { readonly kind: 'same-second'; readonly before: string; readonly after: string }
  /** その時点の変更の記録が無い（表示名の履歴を書き始める前の通報）。 */
  | { readonly kind: 'unrecorded' };

/**
 * 時刻 T の値を復元する（**規則の正本**。このファイルの冒頭）。
 *
 * @param neighbors T の前後でいちばん近い変更の値
 * @param current いまの値
 * @param recorded T 以降の変更がすべて履歴に残っているか（偽なら `unrecorded`）
 * @returns T の時点の値
 */
export function restoreValueAt(
  neighbors: HistoryNeighbors,
  current: string,
  recorded: boolean,
): RestoredValue {
  if (!recorded) {
    return { kind: 'unrecorded' };
  }
  // 規則の 1 → 2 → 3。**`??` で繋ぐ**——空文字（説明なし）は値であって「無い」ではない。
  const after = neighbors.newAtOrBefore ?? neighbors.oldAfter ?? current;
  if (!neighbors.sameSecond) {
    return { kind: 'known', value: after };
  }
  // 同じ規則を、境界を 1 秒手前へずらして掛ける（同じ秒の変更を「通報より後」として扱う）。
  const before = neighbors.newBefore ?? neighbors.oldAtOrAfter ?? current;
  return { kind: 'same-second', before, after };
}

/**
 * 通報の時点の表示名を、記録があると言える時点か（**同じ秒は記録が無い側へ倒す**）。
 *
 * @param reportedAt 通報の時刻（UNIX 秒）
 * @param recordedSince 表示名の履歴を書き始めた時刻（行が無ければ null）
 * @returns 記録があると言えれば true
 */
export function displayNameRecordedAt(reportedAt: number, recordedSince: number | null): boolean {
  // **行が無いときは記録が無いとみなす**（誰かが消した・適用が壊れた。誤った値を出す側へ倒さない）。
  return recordedSince !== null && reportedAt > recordedSince;
}

/**
 * ある履歴について、時刻 T の前後でいちばん近い変更の値を引く列を組み立てる。
 *
 * **4 つの端と「同じ秒」の有無を、そのまま列にする**（選ぶのは {@link restoreValueAt}）。
 * 同じ秒に複数の変更があるときは **`rowid` で書いた順を決める**（`src/admin/actions.ts` の
 * `listAdminActions` と同じ理由——id は乱数で、書いた順と関係が無い）。どれも
 * `(対象の id, changed_at)` の索引の範囲の端を読むだけで済む。
 *
 * **別名は `hc` で、副問い合わせの中に閉じている**（外側の別名と重ねない）。
 *
 * @param source 履歴の表の形
 * @param keyExpr 対象の id を表す外側の式（例: `rp.game_id`）
 * @param atExpr 時刻 T を表す外側の式（例: `rp.created_at`）
 * @param prefix 列の別名の接頭辞（`title` → `title_new_at_or_before` など）
 * @returns select の列の並び
 */
export function historyNeighborsSql(
  source: HistorySource,
  keyExpr: string,
  atExpr: string,
  prefix: string,
): string {
  const scope = `from ${source.table} hc where hc.${source.keyColumn} = ${keyExpr}`;
  const edge = (column: string, compare: string, direction: 'asc' | 'desc'): string =>
    `(select hc.${column} ${scope} and hc.changed_at ${compare} ${atExpr}` +
    ` order by hc.changed_at ${direction}, hc.rowid ${direction} limit 1)`;
  return [
    `${edge(source.newColumn, '<=', 'desc')} as ${prefix}_new_at_or_before`,
    `${edge(source.oldColumn, '>', 'asc')} as ${prefix}_old_after`,
    `${edge(source.newColumn, '<', 'desc')} as ${prefix}_new_before`,
    `${edge(source.oldColumn, '>=', 'asc')} as ${prefix}_old_at_or_after`,
    `exists (select 1 ${scope} and hc.changed_at = ${atExpr}) as ${prefix}_same_second`,
  ].join(',\n            ');
}

/**
 * 節に並ぶ作品の通報と、通報の時点の値を復元する材料を引く文（**1 つの節につき 1 本**）。
 *
 * **対象の作品は、節の一覧の文と同じ条件・同じ並び・同じ件数で選ぶ**（`scopeSql`。
 * `src/admin/review.ts` が同じ断片から両方を組む）。**同じ batch で送る**ので、一覧に並んだ
 * 作品と、ここで通報を引いた作品は同じ時点の状態から決まる。
 *
 * **通報は作品ごとに新しい順に {@link REPORT_EVIDENCE_PER_GAME} 件まで**（窓関数で番号を振る）。
 * 件数の合計も同じ窓で数える。
 *
 * **別名は `rp` / `x` / `eg` / `eu` / `hc` にする。** `scopeSql` の中には
 * `REVIEW_REPORTED_AFTER_CLEAR_SQL`（`g` / `r` / `a`）が入りうるので、外側で同じ綴りを
 * 別の意味に使わない（`src/reports.ts` の但し書き）。
 *
 * 束縛の順: `scopeSql` の束縛 → 1 作品あたりの件数。
 *
 * @param scopeSql 作品の id を 1 列だけ返す SELECT（`games` の別名は `g`）
 * @returns 文
 */
export function reportEvidenceSql(scopeSql: string): string {
  return `select rp.id as report_id, rp.game_id, rp.created_at as reported_at,
            rp.total as report_count,
            eg.title as title_now, eg.description as description_now,
            eu.display_name as name_now,
            (select s.started_at from ${DISPLAY_NAME_HISTORY_START_TABLE} s where s.id = 1)
              as name_recorded_since,
            ${historyNeighborsSql(TITLE_HISTORY, 'rp.game_id', 'rp.created_at', 'title')},
            ${historyNeighborsSql(DESCRIPTION_HISTORY, 'rp.game_id', 'rp.created_at', 'description')},
            ${historyNeighborsSql(DISPLAY_NAME_HISTORY, 'eg.author_id', 'rp.created_at', 'name')}
       from (select x.id, x.game_id, x.created_at,
                    row_number() over (partition by x.game_id
                                           order by x.created_at desc, x.rowid desc) as position,
                    count(*) over (partition by x.game_id) as total
               from reports x
              where x.game_id in (${scopeSql})) rp
       join games eg on eg.id = rp.game_id
       left join users eu on eu.id = eg.author_id
      where rp.position <= ?
      order by rp.game_id, rp.position`;
}

/**
 * {@link reportEvidenceSql} の 1 行。
 *
 * **前後の変更の列（`title_new_at_or_before` など）は名前で引く**（{@link historyNeighborsSql} が
 * 接頭辞から組むので、ここで 15 列を書き写さない）。
 */
export interface ReportEvidenceRow {
  readonly [column: string]: unknown;
  readonly report_id: string;
  readonly game_id: string;
  readonly reported_at: number;
  readonly report_count: number;
  readonly title_now: string;
  readonly description_now: string;
  /** 作者の行が無ければ null（外部キーがあるので、平常は起こらない）。 */
  readonly name_now: string | null;
  readonly name_recorded_since: number | null;
}

/** 通報 1 件と、その時点の 3 つの値。 */
export interface ReportEvidence {
  readonly reportId: string;
  readonly gameId: string;
  readonly reportedAt: number;
  /** この作品の通報の総数（画面に出さなかった分を含む）。 */
  readonly reportCount: number;
  readonly title: { readonly atReport: RestoredValue; readonly now: string };
  readonly description: { readonly atReport: RestoredValue; readonly now: string };
  /** **いまの表示名が引けなければ null**（その場合、通報の時点の値も `unrecorded`）。 */
  readonly authorName: { readonly atReport: RestoredValue; readonly now: string | null };
}

/**
 * 行から 1 つの値の {@link HistoryNeighbors} を取り出す。
 *
 * @param row 行
 * @param prefix 列の別名の接頭辞
 * @returns 前後の変更の値
 */
function neighborsOf(row: ReportEvidenceRow, prefix: string): HistoryNeighbors {
  const text = (name: string): string | null => {
    const value = row[`${prefix}_${name}`];
    return typeof value === 'string' ? value : null;
  };
  return {
    newAtOrBefore: text('new_at_or_before'),
    oldAfter: text('old_after'),
    newBefore: text('new_before'),
    oldAtOrAfter: text('old_at_or_after'),
    // SQLite の `exists` は 0 / 1 の整数で返る。
    sameSecond: Number(row[`${prefix}_same_second`]) === 1,
  };
}

/**
 * {@link reportEvidenceSql} の行を、画面が使う形へ直す（**値の選び方は {@link restoreValueAt}**）。
 *
 * @param row 行
 * @returns 通報 1 件と、その時点の値
 */
export function toReportEvidence(row: ReportEvidenceRow): ReportEvidence {
  const nameNow = row.name_now;
  return {
    reportId: row.report_id,
    gameId: row.game_id,
    reportedAt: row.reported_at,
    reportCount: row.report_count,
    title: {
      atReport: restoreValueAt(neighborsOf(row, 'title'), row.title_now, true),
      now: row.title_now,
    },
    description: {
      atReport: restoreValueAt(neighborsOf(row, 'description'), row.description_now, true),
      now: row.description_now,
    },
    authorName: {
      atReport: restoreValueAt(
        neighborsOf(row, 'name'),
        nameNow ?? '',
        // **いまの値が引けないなら、いまの値へ倒す規則の 3 が使えない**ので、記録が無い扱いにする。
        nameNow !== null && displayNameRecordedAt(row.reported_at, row.name_recorded_since),
      ),
      now: nameNow,
    },
  };
}

/**
 * 通報の時点の値が、いまの値と違うか（画面の「変わっています」の判定）。
 *
 * **同じ秒のときは、前後のどちらかがいまと違えば「違う」**とする（どちらだった可能性もある）。
 * 記録が無いときは判定しない（null）。
 *
 * @param value 通報の時点の値
 * @param now いまの値
 * @returns 違えば true、同じなら false、判定できなければ null
 */
export function differsFromNow(value: RestoredValue, now: string | null): boolean | null {
  if (value.kind === 'unrecorded' || now === null) {
    return null;
  }
  if (value.kind === 'known') {
    return value.value !== now;
  }
  return value.before !== now || value.after !== now;
}
