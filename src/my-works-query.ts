/**
 * 「あなたの作品」の表（#666）が引く行と、状態での絞り込み。
 *
 * ## なぜ `src/games.ts` の `listAuthoredGames` を使わないのか
 *
 * 表は作品ごとの数（プレイ・いいね・フォークされた数）と公開日・タグ・紹介用の画像の有無を出し、状態で
 * 絞り込む。**`listAuthoredGames` に列と条件を足すと、`src/games.ts` の変更になる**——あのモジュールは
 * オーケストレータ Lambda の束に入っており、束の出力が変わると main の deploy が止まる
 * （`scripts/orchestrator-bundle-changed.sh`）。**Lambda が import しないここへ、別の問い合わせとして置く。**
 * `listAuthoredGames` は変えていない（作者で絞る規律と、`removed` を出さない規律はここでも同じ形で守る）。
 *
 * ## 他人の作品を 1 行も出さない
 *
 * 絞り込みは SQL の `where author_id = ?` に置く（`src/my-works.ts` の冒頭と同じ規律）。**状態の絞り込みも
 * SQL に置く**——画面側で `filter` すると、頁送りの件数（30 件ずつ）と頁の中身がずれる。
 *
 * ## 索引
 *
 * 作者で絞るのは `games_author_id_created_at_idx`（`author_id, created_at DESC, id DESC`）で、並びも同じ列である。
 * 状態の条件は索引で作者の行を辿りながら掛けるので、**新しい索引もマイグレーションも足していない**
 * （`test/my-works.test.ts` が実行計画で「作者で絞った SEARCH で、一時 B-tree を作らない」ことを確かめる）。
 * **読む行数は作者の作品数に比例する**（統計の集計と同じ基準。2.3.13 の実装注記）。
 */
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS, workTagsOf } from './games.js';

/**
 * 状態での絞り込み（#666）。**表の「状態」の列と同じ 4 つに「すべて」を足したもの。**
 *
 * - `published` … 公開中（`status = 'published'`）
 * - `draft` … 下書き（`status = 'draft'` で、生成が済んだもの）
 * - `generating` … 生成中（`generation_state` が `pending` / `running`）
 * - `failed` … 生成に失敗した（`generation_state = 'failed'`）
 *
 * **4 つは互いに重ならない**（表の 1 行は 4 つのどれか 1 つの札を持つ）。統計の「下書き」
 * （`status = 'draft'` の全部。生成中と失敗を含む）とは数え方が違う——統計は公開の操作を済ませたかを
 * 数え、こちらは「いまこの作品に何ができるか」で分ける（下書きは公開と削除ができ、生成中はどちらもできない）。
 */
export const MY_WORKS_FILTERS = ['all', 'published', 'draft', 'generating', 'failed'] as const;

/** 絞り込みの値。 */
export type MyWorksFilter = (typeof MY_WORKS_FILTERS)[number];

/** `?state=` の名前。 */
export const MY_WORKS_FILTER_PARAM = 'state';

/**
 * `?state=` を絞り込みへ落とす。**読めない値は「すべて」にする**（手で書き換えた URL で 400 を返さない。
 * 頁番号の読み方と同じ考え方である。`src/my-works.ts` の `toMyWorksPageNumber`）。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 絞り込み
 */
export function toMyWorksFilter(value: string | null): MyWorksFilter {
  return (MY_WORKS_FILTERS as readonly string[]).includes(value ?? '') ? (value as MyWorksFilter) : 'all';
}

/**
 * 絞り込みごとの SQL の条件（束縛を持たない固定の文字列）。**状態の綴りは `src/games.ts` の定数から組む**
 * ——値は定数で、利用者の入力は入らない。
 */
const FILTER_CONDITIONS: Readonly<Record<MyWorksFilter, string>> = {
  all: `status <> '${REMOVED_STATUS}'`,
  published: `status = '${PUBLISHED_STATUS}'`,
  draft: `status = '${DRAFT_STATUS}' and generation_state = 'ready'`,
  generating: `status = '${DRAFT_STATUS}' and generation_state in ('pending', 'running')`,
  failed: `status = '${DRAFT_STATUS}' and generation_state = 'failed'`,
};

/**
 * 表の行を引く SQL（束縛 3 つ: 作者・件数・読み飛ばし）。
 *
 * **検査が SQL を書き写さないために関数で出す**（`test/my-works.test.ts` が実行計画をこれに掛ける。
 * `src/my-works-stats.ts` の `myWorksStatsSql` と同じ形）。並べ替えの 2 列目に `id` を置くのは、
 * 同じ秒に作られた 2 件の順序を決めるためである（`listAuthoredGames` と同じ理由）。
 *
 * @param filter 絞り込み
 * @returns SELECT 文
 */
export function myWorksSql(filter: MyWorksFilter): string {
  return `select id, title, status, generation_state, created_at, generation_started_at, published_at,
            play_count, like_count, fork_count, tag1, tag2, tag3, ogp_state
       from games
      where author_id = ? and ${FILTER_CONDITIONS[filter]}
      order by created_at desc, id desc
      limit ? offset ?`;
}

/** 表の 1 行（`src/my-works.ts` が描く）。 */
export interface MyWorkRow {
  /** `games.id`。 */
  readonly id: string;
  /** 題名（UGC）。 */
  readonly title: string;
  /** 公開状態（D1 の綴りのまま）。 */
  readonly status: string;
  /** 生成の進行状態（D1 の綴りのまま）。 */
  readonly generationState: string;
  /** 行を作った時刻（UNIX 秒）。 */
  readonly createdAt: number;
  /** ジョブが走り始めた時刻（UNIX 秒）。 */
  readonly startedAt: number | null;
  /** 初めて公開した時刻（UNIX 秒）。公開したことが無ければ null。 */
  readonly publishedAt: number | null;
  /** プレイ数（D1 へ写した値。最大 5 分遅れる）。 */
  readonly playCount: number;
  /** いいね数（同上）。 */
  readonly likeCount: number;
  /** フォークされた数（公開された子の数）。 */
  readonly forkCount: number;
  /** タグの識別子（語彙には照らしていない。描く側が `knownWorkTags` で照らす）。 */
  readonly tags: readonly string[];
  /**
   * 紹介用の画像を出せるか。**配信の条件と同じにする**（`src/ogp.ts` の `serveOgpImage` は
   * `status = 'published' and ogp_state = 'ready'` で引く）——条件がずれると、表が 404 の画像を指す。
   */
  readonly hasShot: boolean;
}

/**
 * 集計の列を 0 以上の整数へ倒す（不変条件を画面が前提にしない。`src/my-works-stats.ts` の `countOf` と同じ扱い）。
 *
 * @param value D1 が返した値
 * @returns 0 以上の整数
 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * 表の行を引く。
 *
 * @param env バインディングと環境変数
 * @param authorId 作者の利用者 id
 * @param filter 絞り込み
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数）
 * @returns 新しい順の行
 * @throws `limit` / `offset` が 0 以上の整数でない場合（SQLite は `LIMIT -1` を無制限と読む。`listAuthoredGames` と同じ検査）
 */
export async function listMyWorks(
  env: Env,
  authorId: string,
  filter: MyWorksFilter,
  limit: number,
  offset: number,
): Promise<readonly MyWorkRow[]> {
  for (const [what, value] of [['取得件数', limit], ['読み飛ばし件数', offset]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`一覧の${what}が不正です: ${value}`);
    }
  }
  const result = await env.DB.prepare(myWorksSql(filter))
    .bind(authorId, limit, offset)
    .all<{
      id: string;
      title: string;
      status: string;
      generation_state: string;
      created_at: number;
      generation_started_at: number | null;
      published_at: number | null;
      play_count: unknown;
      like_count: unknown;
      fork_count: unknown;
      tag1: string | null;
      tag2: string | null;
      tag3: string | null;
      ogp_state: string | null;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    generationState: row.generation_state,
    createdAt: row.created_at,
    startedAt: row.generation_started_at,
    publishedAt: row.published_at,
    playCount: countOf(row.play_count),
    likeCount: countOf(row.like_count),
    forkCount: countOf(row.fork_count),
    tags: workTagsOf(row),
    hasShot: row.status === PUBLISHED_STATUS && row.ogp_state === 'ready',
  }));
}
