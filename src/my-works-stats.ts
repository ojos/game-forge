/**
 * 「あなたの作品」（`/works/mine`）の統計カード（2.3.13 / M12-14 / #382）。
 *
 * **自分の作品の状況が 1 画面で分かる**ことが goal である。AivisHub のダッシュボードが持つ
 * 統計カードに寄せ、このサービスの数へ置き換えた（アップロード済み → 作品数、合計
 * ダウンロード数 → 合計改造された数）。
 *
 * ## 読み取りは集計 1 回である（2.3.3 の条件 1）
 *
 * **カードの数だけ問い合わせを出さない。** 6 つの数を 1 本の `select` で引く
 * （{@link myWorksStatsSql}）。作者で絞るのは既存の索引
 * `games_author_id_created_at_idx`（`migrations/0008`。`author_id, created_at DESC, id DESC`）で、
 * **新しい索引もマイグレーションも足していない。**
 *
 * **読む行数は自分の作品数に比例する。** `count` / `sum` は索引で作者に絞っても、その作者の
 * 作品行を 1 件ずつ読む。**公開作品の総数（母数）には比例しない**——これが #382 の訂正で
 * 読み替えた基準であり、`migrations/0024` が作者別のいいね合計で受け入れたのと同じ形である
 * （5.8「利用者の側に非正規化列を足さない」を覆さない）。`test/my-works.test.ts` が
 * 実行計画で「作者で絞った SEARCH であり、表の SCAN ではない」ことを確かめる。
 *
 * ## 何を数えるか
 *
 * - **`removed` は数えない。** 一覧（`src/games.ts` の `listAuthoredGames`）が出さない
 *   作品を数に含めると、**カードの作品数と一覧の行数が合わない。**
 * - **`draft` は数えるが、公開の数とは分けて出す**（#382 の constraints）。ここは本人だけの
 *   画面で、一覧に `draft` を出さない規律（2.3.6）とは別の話である。**生成中・生成に失敗した
 *   作品も `draft` である**——一覧にも出ている行なので、作品数 = 公開中 + 下書き が成り立つ。
 * - **公開中は `status = 'published'` である。** 8.4 の審査で新規露出を止めた作品も含める。
 *   作者から見て「公開の操作を済ませた作品」の数であり、露出の状態は作品ページが 1 件ずつ
 *   知らせる（作品ごとの内訳は #382 の scope.out）。
 * - **合計いいね数・合計改造された数・合計プレイ数は D1 の非正規化列を読み、DO を呼ばない**
 *   （`games.like_count` / `games.fork_count` / `games.play_count`。いいねとプレイ数は最大 5 分
 *   遅れる。5.8 / #377）。
 *
 * ## 合計プレイ数（#377）
 *
 * **6 枚目に「合計プレイ数」を置いた**（2.3.13。`games.play_count` の合計。DO から 5 分おきに
 * 写した数で、最大 5 分遅れる）。#382 の時点では列が無く、「遊ばれていない」と「数えていない」を
 * 区別できないのでカードごと出していなかった。
 *
 * **数え始める前の起動は含まない**（埋め戻せない。`migrations/` の `games_play_count`）。
 * 0 が「数え始めてから遊ばれていない」の意味になるよう、**数え始めた時期を書き添える**
 * （{@link PLAYS_SINCE_NOTE}）。
 *
 * 足した場所は #382 が残した 3 つ——{@link MyWorksStats} の数、{@link myWorksStatsSql} の
 * `coalesce(sum(play_count), 0)`、{@link STAT_CARDS} の 1 行——と、但し書き 1 つである。
 */
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS } from './games.js';
import { escapeHtml } from './html.js';

/** 統計カードに出す数。**どれも 0 以上の整数である**（{@link loadMyWorksStats} が保証する）。 */
export interface MyWorksStats {
  /** 作品数（`removed` を除く全部）。 */
  readonly works: number;
  /** 公開中（`status = 'published'`）。 */
  readonly published: number;
  /** 下書き（`status = 'draft'`。生成中・生成に失敗した作品を含む）。 */
  readonly drafts: number;
  /** 合計改造された数（`fork_count` の合計）。 */
  readonly forks: number;
  /** 合計いいね数（`like_count` の合計。最大 5 分遅れる）。 */
  readonly likes: number;
  /** 合計プレイ数（`play_count` の合計。最大 5 分遅れる。数え始める前の起動は含まない。#377）。 */
  readonly plays: number;
}

/** 作品が 1 本も無い利用者の統計。 */
export const EMPTY_MY_WORKS_STATS: MyWorksStats = {
  works: 0,
  published: 0,
  drafts: 0,
  forks: 0,
  likes: 0,
  plays: 0,
};

/**
 * カードの並びと見出し。**並びは AivisHub のダッシュボードに揃えた**（2.3.13 の列挙順）。
 *
 * 表として持つのは、**カードを足すときに描画を触らせない**ためである（#377 はここへ 1 行足しただけ）。
 */
export const STAT_CARDS: readonly { readonly key: keyof MyWorksStats; readonly label: string }[] = [
  { key: 'works', label: '作品数' },
  { key: 'published', label: '公開中' },
  { key: 'drafts', label: '下書き' },
  { key: 'forks', label: '合計改造された数' },
  { key: 'likes', label: '合計いいね数' },
  { key: 'plays', label: '合計プレイ数' },
];

/**
 * 統計を 1 本で引く SQL。
 *
 * **検査が SQL を書き写さないために関数で出す**（`test/my-works.test.ts` が実行計画を
 * これに掛ける。`src/users-page.ts` の `likesReceivedSql` と同じ形）。
 *
 * **`sum` は 0 行で NULL を返す**ので、すべて `coalesce` で 0 へ倒す（作品 0 本の利用者）。
 * `count(*)` は 0 行でも 0 を返す。
 *
 * **`where` は一覧と同じ形にしてある**（`author_id = ? and status <> ?`）。一覧の
 * 問い合わせと同じ索引に乗る。
 *
 * @returns 束縛パラメータが 4 つ（公開 / 下書き / 作者 / 除く状態）の SELECT 文
 */
export function myWorksStatsSql(): string {
  return `select count(*) as works,
            coalesce(sum(status = ?), 0) as published,
            coalesce(sum(status = ?), 0) as drafts,
            coalesce(sum(fork_count), 0) as forks,
            coalesce(sum(like_count), 0) as likes,
            coalesce(sum(play_count), 0) as plays
       from games
      where author_id = ? and status <> ?`;
}

/**
 * {@link myWorksStatsSql} に束縛する値。
 *
 * @param authorId 作者の利用者 id
 * @returns SQL の `?` の順に並べた値
 */
export function myWorksStatsBinds(authorId: string): readonly string[] {
  return [PUBLISHED_STATUS, DRAFT_STATUS, authorId, REMOVED_STATUS];
}

/**
 * 集計の 1 列を、0 以上の整数へ倒す。
 *
 * **不変条件を画面が前提にしない**（`src/my-works.ts` の `displayTitleOf` と同じ方針）。
 * 列は `NOT NULL DEFAULT 0` だが、同期や手作業の UPDATE が負や小数を入れる経路は型では
 * 塞げない。**描く前に丸めたほうが、壊れた形の数を出すより害が小さい。**
 *
 * @param value D1 が返した値
 * @returns 0 以上の整数
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * 自分の作品の統計を引く（集計 1 回）。
 *
 * @param env バインディングと環境変数
 * @param authorId 作者の利用者 id
 * @returns 統計。**作品が 0 本でも 0 の並びを返す**
 * @throws D1 を読めなかったとき（画面側が握って「読み込めませんでした」を出す）
 */
export async function loadMyWorksStats(env: Env, authorId: string): Promise<MyWorksStats> {
  const row = await env.DB.prepare(myWorksStatsSql())
    .bind(...myWorksStatsBinds(authorId))
    .first<Record<keyof MyWorksStats, unknown>>();
  if (row === null) {
    // 集計は必ず 1 行返すので通常は来ない。来ても 0 本として描く。
    return EMPTY_MY_WORKS_STATS;
  }
  return {
    works: countOf(row.works),
    published: countOf(row.published),
    drafts: countOf(row.drafts),
    forks: countOf(row.forks),
    likes: countOf(row.likes),
    plays: countOf(row.plays),
  };
}

/** 統計を読めなかったときの文言。**「0 本」と兼ねない**（作品は失われていない）。 */
export const STATS_UNAVAILABLE_NOTICE =
  '統計をいま読み込めませんでした。作品は失われていません。時間をおいて再読み込みしてください。';

/** いいね数の遅れの但し書き（5.8。同期は数分おきである）。 */
export const LIKES_DELAY_NOTE = 'いいね数は、反映されるまで数分かかることがあります。';

/**
 * プレイ数の但し書き（#377）。**数え始めた時期と、遅れの両方を言う。**
 *
 * **数え始める前の起動は含まない**ので、「合計プレイ数 0」が「一度も遊ばれていない」と
 * 読まれないようにする（#382 がカードを出さなかった理由への応答）。時期は月の粒度で書く
 * ——配備の日が決まる前に書く文言であり、日付まで書くと配備の日とずれうる。
 */
export const PLAYS_SINCE_NOTE =
  'プレイ数は 2026 年 9 月から数えています（それより前に遊ばれた回数は含みません）。反映されるまで数分かかることがあります。';

/**
 * 統計の区画を組み立てる。
 *
 * **残枠の文言は受け取るだけで、ここでは作らない。** 生成画面と同じ経路
 * （`src/generate-page.ts` の `resolveAvailability` → `availabilityNotice`）で作ったものを
 * 呼び出し側が渡す（2.3.13「数え方を 2 か所に持たない」）。
 *
 * **数と見出しはこのモジュールが持つ整数と固定の文字列である**が、残枠の文言は他の
 * モジュールから来るので `escapeHtml` を通す（生成画面も同じく通している）。
 *
 * @param stats 統計。読めなかったときは null
 * @param quotaNotice 残枠の文言（生成画面が出すものと同じ文字列）
 * @returns `<section>` 1 つ
 */
export function renderMyWorksStats(stats: MyWorksStats | null, quotaNotice: string): string {
  const cards =
    stats === null
      ? `<p>${STATS_UNAVAILABLE_NOTICE}</p>`
      : `<dl class="gf-stats-cards">
${STAT_CARDS.map(
  ({ key, label }) =>
    `  <div class="gf-stats-card"><dt>${label}</dt><dd>${countOf(stats[key])}</dd></div>`,
).join('\n')}
</dl>
<p class="gf-stats-note">${LIKES_DELAY_NOTE}</p>
<p class="gf-stats-note">${PLAYS_SINCE_NOTE}</p>`;
  return `<section class="gf-stats" aria-labelledby="works-stats-heading">
<h2 id="works-stats-heading">統計</h2>
<p class="gf-stats-quota" id="works-quota">${escapeHtml(quotaNotice)}</p>
${cards}
</section>`;
}
