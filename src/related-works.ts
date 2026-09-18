/**
 * 作品ページの右カラムに出す関連作品（#665 / レイアウト改修 2/3）。
 *
 * ## 何を並べるか
 *
 * **フォーク元 → フォーク先 → 同じタグの公開作品**の順に並べる（#665 の決定。YouTube の視聴ページの右カラムの関連動画の
 * 位置）。閲覧履歴などを使った推薦は置かない（#665 の scope.out）。
 *
 * ## 出すのは公開済みの作品だけである
 *
 * **下書き・取り下げ済みは出さない**（#665 の constraints）。**8.4 の審査で新規露出を止めた作品も出さない**——関連作品は
 * 新規露出の面である（トップ・公開一覧と同じ条件。`src/reports.ts` の `reviewVisibleSql`）。条件は引く時点の SQL に置き、
 * 画面では絞り直さない。
 *
 * ## 読み取りを 1 往復に畳む
 *
 * 3 本の問い合わせ（親・子・同じタグ）は **`D1.batch` で 1 往復**にする。どれも索引で引く:
 *
 * | 問い合わせ | 索引 |
 * |---|---|
 * | フォーク元 | 主キー（`games.id`） |
 * | フォーク先 | `games_parent_id_idx`（`migrations/0001`） |
 * | 同じタグ | タグの枠ごとの部分索引 `games_tag{1,2,3}_published_at_idx`（`migrations/0033_games_tags.sql`）を、タグ × 枠ごとの
 *   文で新しい順に `LIMIT` まで読み、束ねて並べ直す |
 *
 * **索引は足していない**（マイグレーションは無い）。同じタグの問い合わせが部分索引を使うことは `test/related-works.test.ts` が
 * `EXPLAIN QUERY PLAN` で確かめる。**部分索引の条件（`status = 'published'` と審査の式）は束縛値にせず、索引の定義と同じ綴りの
 * 定数で書く**——SQLite は束縛値からは部分索引の条件を導けない。
 */
import { PUBLISHED_STATUS } from './games.js';
import { reviewVisibleSql } from './reports.js';

/** 関連の種類。並びの順でもある。 */
export type RelatedRelation = 'parent' | 'fork' | 'tag';

/** 関連作品 1 件。 */
export interface RelatedWork {
  /** 作品 id（`games.id`。公開識別子）。 */
  readonly id: string;
  /** 題名（**UGC**。描く側が `escapeHtml` を通す）。 */
  readonly title: string;
  /** 作者の表示名（**UGC**）。引けなければ null。 */
  readonly authorName: string | null;
  /** OGP 画像を撮り終えているか（撮れていなければ固定の文言のパネルを出す）。 */
  readonly hasImage: boolean;
  /** この作品から見た関係。 */
  readonly relation: RelatedRelation;
}

/** フォーク先を何件まで並べるか。 */
export const RELATED_FORKS_LIMIT = 5;

/** 同じタグの作品を何件まで並べるか。 */
export const RELATED_TAG_LIMIT = 8;

/** 行の形。 */
interface RelatedRow {
  readonly id: string;
  readonly title: string;
  readonly author_name: string | null;
  readonly ogp_state: string | null;
}

/** 選ぶ列（3 本で同じ形）。 */
const COLUMNS = `g.id, g.title, a.display_name as author_name, g.ogp_state`;

/** タグの枠（`games.tag1` / `tag2` / `tag3`）。 */
const TAG_SLOTS = ['tag1', 'tag2', 'tag3'] as const;

/**
 * 同じタグの作品を、**タグの枠 1 つぶん**引く SQL（{@link listRelatedWorks}）。タグの数 × 枠 3 つの文を batch で並べる。
 *
 * **1 本の `union` に畳まない。** D1 は複合 SELECT の項の数を小さく絞っており、タグ 2 つ（6 項）で
 * `too many terms in compound SELECT` になった（2026-09-18 の実測）。
 *
 * **条件は索引の定義（`migrations/0033_games_tags.sql`）と同じ綴りのまま持つ**（冒頭の「読み取りを 1 往復に畳む」）。
 *
 * @param slot タグの枠
 * @returns SQL（束縛値はタグ・除く id・件数）
 */
export function sameTagSql(slot: (typeof TAG_SLOTS)[number]): string {
  return `select ${COLUMNS}, g.published_at
       from games g left join users a on a.id = g.author_id
      where g.${slot} = ? and g.status = '${PUBLISHED_STATUS}' and ${reviewVisibleSql('g')} and g.id <> ?
      order by g.published_at desc, g.id desc
      limit ?`;
}

/**
 * 関連作品を引く（#665）。
 *
 * @param env バインディングと環境変数
 * @param gameId この作品の id
 * @param parentId この作品の親（`games.parent_id`。オリジナルなら null）
 * @param tags この作品のタグ（語彙で絞った識別子）
 * @returns フォーク元 → フォーク先 → 同じタグの順。同じ作品は 2 度出さない
 */
export async function listRelatedWorks(
  env: Env,
  gameId: string,
  parentId: string | null,
  tags: readonly string[],
): Promise<readonly RelatedWork[]> {
  const visible = reviewVisibleSql('g');
  const statements: D1PreparedStatement[] = [];
  const parentAt = parentId === null ? -1 : statements.length;
  if (parentId !== null) {
    statements.push(
      env.DB.prepare(
        `select ${COLUMNS} from games g left join users a on a.id = g.author_id
          where g.id = ? and g.status = ? and ${visible}`,
      ).bind(parentId, PUBLISHED_STATUS),
    );
  }
  const forksAt = statements.length;
  statements.push(
    env.DB.prepare(
      `select ${COLUMNS} from games g left join users a on a.id = g.author_id
        where g.parent_id = ? and g.status = ? and ${visible}
        order by g.published_at desc, g.id desc limit ?`,
    ).bind(gameId, PUBLISHED_STATUS, RELATED_FORKS_LIMIT),
  );
  const shownTags = tags.slice(0, 3);
  // **同じタグの側は、親と子の件数ぶん多めに引く**（重なった作品を後で落としても、件数が減らないように）。
  const want = RELATED_TAG_LIMIT + RELATED_FORKS_LIMIT + 1;
  const tagsFrom = statements.length;
  for (const tag of shownTags) {
    for (const slot of TAG_SLOTS) {
      statements.push(env.DB.prepare(sameTagSql(slot)).bind(tag, gameId, want));
    }
  }

  const results = await env.DB.batch<RelatedRow & { published_at?: number | null }>(statements);
  const rowsAt = (at: number): readonly RelatedRow[] => (at < 0 ? [] : (results[at]?.results ?? []));
  // 枠ごとの結果を束ね、新しい順に並べ直す（同じ作品が 2 つの枠に当たっても、下の `seen` が 1 度だけにする）。
  const tagRows = results
    .slice(tagsFrom)
    .flatMap((result) => result.results ?? [])
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const seen = new Set<string>([gameId]);
  const related: RelatedWork[] = [];
  const add = (rows: readonly RelatedRow[], relation: RelatedRelation, limit: number): void => {
    let added = 0;
    for (const row of rows) {
      if (added >= limit || seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      related.push({
        id: row.id,
        title: row.title,
        authorName: row.author_name,
        hasImage: row.ogp_state === 'ready',
        relation,
      });
      added += 1;
    }
  };
  add(rowsAt(parentAt), 'parent', 1);
  add(rowsAt(forksAt), 'fork', RELATED_FORKS_LIMIT);
  add(tagRows, 'tag', RELATED_TAG_LIMIT);
  return related;
}
