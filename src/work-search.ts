/**
 * 公開作品のキーワード検索（#378 / M12-10 / 仕様 2.3.5）。
 *
 * **画面は持たない。** 検索語の解釈と、索引を引く SQL と、行をカードの入力へ落とすことだけを持つ。
 * 結果は公開一覧（`/works`）が `?q=` で描く（`src/works-list.ts`。issue の scope.in「`/works` の
 * 絞り込みと同居させる」）。ヘッダの検索窓（`src/html.ts`）もここから綴りを借りる。
 *
 * ## 索引の形（`migrations/` の `game_search`）
 *
 * - **`game_search_fts`**: `tokenize = 'trigram'` の通常の FTS5 表（題名と説明）。**既定の tokenizer
 *   では日本語の部分語が引けない**（#370 の実測。「ブロック崩しゲーム」が丸ごと 1 トークンになる）
 * - **`game_search_docs`**: `doc_id INTEGER PRIMARY KEY` と `game_id TEXT UNIQUE` の対応表。FTS 表の
 *   `rowid` には、**この表の `doc_id` を明示して入れる**。`games` の暗黙の `rowid` には繋がない
 *   （`games` は `id TEXT PRIMARY KEY` で、暗黙の `rowid` は表の作り直しで変わりうる。ずれると
 *   **落ちずに結果だけが壊れる**——handoff 1 章 / #378 の利用者の決定 3）
 * - **入っているのは可視の作品だけ**で、`games` のトリガが同期する（insert / delete と、
 *   `status` / `review_state` / `title` / `description` の更新だけ。`like_count` などの同期では発火しない）
 *
 * ## 引く時点でも可視条件を掛ける（二重に守る）
 *
 * **索引に入っていることを、公開していることの根拠にしない。** 索引は写しであり、手で直した日や
 * トリガを落とした日にずれうる。**ずれたときの壊れ方は「消したはずの作品が検索に残る」**
 * （issue の constraints）なので、`games` と結合して `status = ?` と `reviewVisibleSql('g')` を
 * もう一度掛ける（#152 の規律「絞り込みは引く時点で行う」）。**どちらか片方を外すと、
 * `test/work-search.test.ts` の別々の検査が赤くなる。**
 *
 * ## 語の長さで引き方が 2 つに分かれる（#378 の利用者の決定 1・2）
 *
 * **trigram は 3 文字未満の語を索引しない**（「宇宙」は `match` で 0 件になり、**黙って外れる**）。
 *
 * | 検索語 | 引き方 | 読む行 |
 * |---|---|---|
 * | 3 文字以上の語が 1 つでもある | その語を FTS5 の `match` で引き、2 文字以下の語は結合した行で `instr` で絞る | **該当した件数に比例**（該当しない公開作品の数には比例しない） |
 * | 2 文字以下の語だけ | 公開一覧の索引（`status, published_at`）を新しい順に読み、`instr` で絞る | **公開作品の数に比例**（**公開 500 本までは許す**。仕様 2.3.8） |
 * | 1 文字の語だけ | **引かない**（断る） | 0 |
 *
 * **並びは新着順に固定する**（決定 4）。`match` で拾った行を `published_at` で並べ直すための
 * 一時 B-tree は、**該当した件数ぶんだけ**である。
 *
 * ## 検索語を SQL へ入れない・ログへ出さない
 *
 * - **語は束縛で渡す。** SQL の文字列を組み立てる材料は、語の**数**とタグの有無だけである
 * - **FTS5 の問い合わせ構文にも入れない。** 語ごとに `"` を二重にしてフレーズとして囲むので、
 *   `OR` / `NOT` / `*` / `:` / `(` を打っても演算子にならない（{@link ftsMatchExpression}）
 * - **ログに出さない。** D1 の失敗の文言には FTS5 の問い合わせの断片が入りうるので、失敗は
 *   固定の文言へ置き換えて投げ直す（{@link listSearchedGames}）
 *
 * ## このモジュールが import してよいもの
 *
 * **`src/html.ts` がここを読む**（検索窓の綴り）。したがって、**画面のモジュールと `src/html.ts` を
 * import しないこと**——循環参照になる（`src/html.ts` の冒頭）。いま読んでいる `src/games.ts` と
 * `src/reports.ts` はどちらも `src/html.ts` へ戻らない（esbuild の metafile で確かめた）。
 */
import type { PublicWork } from './games.js';
import { PUBLISHED_STATUS, workTagsOf } from './games.js';
import { reviewVisibleSql } from './reports.js';
import type { WorkTagId } from './work-tags.js';

/**
 * 検索語のクエリの名前（`/works?q=…`）。
 *
 * **ヘッダの検索窓の `name` と、一覧の URL の組み立てが同じ 1 つを使う。**
 */
export const WORK_SEARCH_FIELD = 'q';

/**
 * 語の数の上限。
 *
 * **5 語。** 語ごとに `instr` か FTS5 のフレーズが 1 つ増える。上限が無いと、1 回の検索で
 * 行ごとに評価する条件をいくらでも積める。
 */
export const MAX_SEARCH_TERMS = 5;

/**
 * 検索語の長さの上限（語を 1 つの空白でつないだ後の文字数。コードポイントで数える）。
 *
 * **40 文字。** 作品の題名の上限（`src/games.ts` の `MAX_TITLE_LENGTH`）と同じで、題名を丸ごと
 * 貼り付けても収まる。
 */
export const MAX_SEARCH_LENGTH = 40;

/**
 * FTS5 の索引で引ける語の最短の長さ（**trigram の 3**）。
 *
 * これより短い語は `match` で黙って外れる（#370）。
 */
export const INDEXED_TERM_MIN_LENGTH = 3;

/**
 * 空白で区切る前の入力の長さの上限（UTF-16 の単位）。
 *
 * **区切る前に切る。** 空白を大量に挟んだ入力を分割して数えてから断るのでは、断るまでに
 * 入力の長さに比例した仕事をする。{@link MAX_SEARCH_LENGTH} の 4 倍を超えたら、語を数えずに断る。
 */
const MAX_RAW_SEARCH_LENGTH = MAX_SEARCH_LENGTH * 4;

/** 検索を断った理由。 */
export type SearchRejection = 'too-short' | 'too-many-terms' | 'too-long';

/** 受け付けた検索。 */
export interface AcceptedSearch {
  readonly kind: 'accepted';
  /** 語を 1 つの空白でつないだもの（重複を除いた後。最初に現れた綴りを残す）。URL・見出し・検索窓に使う。 */
  readonly text: string;
  /**
   * キャッシュの鍵に使う綴り（{@link text} の英字を小文字に揃えたもの）。
   *
   * **検索は英字の大文字小文字を区別しない**ので、`Puzzle` と `puzzle` の結果は同じである。
   * 鍵を分けると、同じ結果が 2 本溜まる。**揃えるのは ASCII の英字だけ**——2 文字以下の語を絞る
   * `lower()` が ASCII しか揃えないので、それ以外を揃えると結果の違う検索が同じ鍵に載る。
   */
  readonly key: string;
  /** FTS5 で引く語（{@link INDEXED_TERM_MIN_LENGTH} 文字以上）。 */
  readonly indexedTerms: readonly string[];
  /** 結合した行で絞る語（2 文字以下）。 */
  readonly shortTerms: readonly string[];
}

/** 断った検索。**D1 を 1 回も引かない。** */
export interface RejectedSearch {
  readonly kind: 'rejected';
  /** 入力を空白で整えたもの（検索窓へ戻して、打ち直せるようにする）。 */
  readonly text: string;
  readonly reason: SearchRejection;
}

/** 検索語の解釈の結果。`none` は検索しない（`?q=` が無いか、空白だけ）。 */
export type WorkSearch = { readonly kind: 'none' } | AcceptedSearch | RejectedSearch;

/**
 * 文字数をコードポイントで数える（サロゲートペアの絵文字を 2 文字と数えない）。
 *
 * @param value 文字列
 * @returns 文字数
 */
function characterCount(value: string): number {
  return [...value].length;
}

/**
 * 英字（ASCII）だけを小文字にする。
 *
 * **`String#toLowerCase` を使わない。** あちらは全角英字なども揃えるが、2 文字以下の語を絞る SQLite の
 * `lower()` は ASCII しか揃えない。揃え方を検索の側と合わせる。
 *
 * @param value 文字列
 * @returns ASCII の英大文字を小文字にした文字列
 */
function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/**
 * 長さの上限で切る。**サロゲートペアの途中で切らない。**
 *
 * `String#slice` は UTF-16 の単位で切るので、境界に絵文字が跨ると上位サロゲートが 1 つだけ残る。
 * **孤立したサロゲートは `encodeURIComponent` が `URIError` を投げる**——断った検索の語はタグの
 * リンクへ載るので、画面が 500 になる（PR #432 の Copilot の指摘）。末尾に残った上位サロゲートを落とす。
 *
 * @param value 文字列
 * @param limit UTF-16 の単位での上限
 * @returns 上限以内で、末尾に孤立した上位サロゲートを持たない文字列
 */
function truncateUtf16(value: string, limit: number): string {
  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `?q=` を検索語へ落とす。
 *
 * - **空白（全角の空白を含む）で区切り、すべての語を含む作品を引く**（AND）
 * - **同じ語は 1 つにまとめる**（数の上限と、キャッシュの鍵を揃えるため）。**英字の大文字小文字だけが
 *   違う語も同じ語とみなす**（検索が区別しないので、別の語として上限を食わせない。最初の綴りを残す）
 * - **大文字と小文字を区別しない**（trigram の既定。2 文字以下の語も `lower` で揃える。ASCII のみ）
 * - **全角と半角は揃えない。** 保存している題名を正規化していないので、揃えると当たらなくなる
 *
 * **失敗させない**（400 にしない）。断るときは理由を返し、画面が文言を出す。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 解釈の結果
 */
export function parseWorkSearch(value: string | null): WorkSearch {
  const raw = (value ?? '').trim();
  if (raw === '') {
    return { kind: 'none' };
  }
  if (raw.length > MAX_RAW_SEARCH_LENGTH) {
    return { kind: 'rejected', text: truncateUtf16(raw, MAX_RAW_SEARCH_LENGTH), reason: 'too-long' };
  }
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of raw.split(/\s+/u)) {
    const folded = foldAsciiCase(term);
    if (term !== '' && !seen.has(folded)) {
      seen.add(folded);
      terms.push(term);
    }
  }
  const text = terms.join(' ');
  if (characterCount(text) > MAX_SEARCH_LENGTH) {
    return { kind: 'rejected', text, reason: 'too-long' };
  }
  if (terms.length > MAX_SEARCH_TERMS) {
    return { kind: 'rejected', text, reason: 'too-many-terms' };
  }
  // **1 文字の語だけの検索は断る**（決定 2）。1 文字の語が 2 文字以上の語と並んでいれば、
  // 後から絞る条件として受け付ける（読む行は、並んだ語の引き方で決まる）。
  if (terms.every((term) => characterCount(term) < 2)) {
    return { kind: 'rejected', text, reason: 'too-short' };
  }
  return {
    kind: 'accepted',
    text,
    key: foldAsciiCase(text),
    indexedTerms: terms.filter((term) => characterCount(term) >= INDEXED_TERM_MIN_LENGTH),
    shortTerms: terms.filter((term) => characterCount(term) < INDEXED_TERM_MIN_LENGTH),
  };
}

/**
 * FTS5 の `match` へ渡す式を組み立てる。
 *
 * **語ごとに `"` で囲み、中の `"` を二重にする**（FTS5 の文字列の規則）。囲んだ語はフレーズで
 * あり、`OR` / `NOT` / `NEAR` / `*` / `^` / 列の指定（`title:`）のどれとしても解釈されない。
 * **フレーズを空白でつなぐと AND になる**（FTS5 の暗黙の AND）。フレーズは列をまたがないが、
 * 語どうしは別の列で当たってよい（題名に 1 語、説明に 1 語）。
 *
 * **これは SQL の文字列ではない。** 組み立てた式は束縛で渡す。
 *
 * @param terms {@link INDEXED_TERM_MIN_LENGTH} 文字以上の語（1 つ以上）
 * @returns `match` の右辺に束縛する式
 */
export function ftsMatchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

/**
 * 一覧と同じ列（`src/games.ts` の `publishedGamesSql` が選ぶ列）。
 *
 * **`src/games.ts` はオーケストレータの束に入っている**ので、列の一覧を共有する形へ書き換えずに
 * 写した。**写しなので、ずれたら `test/work-search.test.ts` が赤くなる**（`publishedGamesSql` の
 * 選ぶ列と照合する。`.ai-playbook/shared-ai-rules.md` 12 章）。
 */
const SEARCH_COLUMNS = `g.id, g.title, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
            g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3, u.display_name as author_name,
            case when u.avatar_sha256 is null then null else u.avatar_set_at end as author_avatar_set_at`;

/** 束縛する値。 */
type Bind = string | number;

/** 実行する文と、束縛する値の組。 */
export interface SearchStatement {
  readonly sql: string;
  readonly binds: readonly Bind[];
}

/**
 * 検索の問い合わせを組み立てる。
 *
 * **実行計画を検査できるように、文と束縛値の組を返す**（`test/work-search.test.ts` が、本番と
 * 同じ束縛値で `EXPLAIN QUERY PLAN` を掛ける）。
 *
 * # 3 文字以上の語があるとき
 *
 * `game_search_fts` を `match` で引き、`game_search_docs` を主キー（`doc_id`）で、`games` を主キーで
 * 引く。**`games` の索引を並びの順に読む計画にはならない**（`match` の候補から始まる）。並べ直しの
 * 一時 B-tree は該当した件数ぶんである。
 *
 * # 2 文字以下の語だけのとき
 *
 * **FTS5 を使わない。** 公開一覧と同じ索引（`status, published_at`）を新しい順に読み、行ごとに
 * `instr` で絞る——**`LIMIT` に届くまで読む**ので、よく当たる語ほど早く止まり、当たらない語ほど
 * 公開作品の数に近づく。**trigram の表を `like` で引く形は採らない**——`EXPLAIN` の字面は `L0` で
 * 索引らしく見えるが、2 文字では全件を読む（#370 の実測。44 倍差）うえ、並べ直しの一時 B-tree が増える。
 *
 * # タグで絞るとき
 *
 * **並べ替えは新着に固定なので、タグの枠ごとの索引（`games_tags`）は使わない。** 候補を読んだ後に
 * `(tag1 = ? or tag2 = ? or tag3 = ?)` で絞る。3 文字以上の語があれば読むのは該当した件数ぶん、
 * 無ければ公開作品の数ぶん（上の表と同じ）で、タグで増えも減りもしない。
 *
 * @param search 受け付けた検索
 * @param tag 絞り込むタグ（絞り込まないなら null）
 * @param limit 引く最大件数
 * @param offset 読み飛ばす件数
 * @returns 文と束縛値
 */
export function searchWorksStatement(
  search: AcceptedSearch,
  tag: WorkTagId | null,
  limit: number,
  offset: number,
): SearchStatement {
  const conditions: string[] = [];
  const binds: Bind[] = [];
  let from = `games g
       left join users u on u.id = g.author_id`;

  if (search.indexedTerms.length > 0) {
    from = `game_search_fts f
       join game_search_docs d on d.doc_id = f.rowid
       join games g on g.id = d.game_id
       left join users u on u.id = g.author_id`;
    conditions.push('game_search_fts match ?');
    binds.push(ftsMatchExpression(search.indexedTerms));
  }

  // **引く時点の可視条件**（冒頭の「二重に守る」）。索引に入っていても、ここで落ちれば出ない。
  conditions.push(`g.status = ? and ${reviewVisibleSql('g')}`);
  binds.push(PUBLISHED_STATUS);

  if (tag !== null) {
    conditions.push('(g.tag1 = ? or g.tag2 = ? or g.tag3 = ?)');
    binds.push(tag, tag, tag);
  }

  for (const term of search.shortTerms) {
    conditions.push('(instr(lower(g.title), lower(?)) > 0 or instr(lower(g.description), lower(?)) > 0)');
    binds.push(term, term);
  }

  binds.push(limit, offset);
  return {
    sql: `select ${SEARCH_COLUMNS}
       from ${from}
      where ${conditions.join('\n        and ')}
      order by g.published_at desc, g.id desc
      limit ? offset ?`,
    binds,
  };
}

/** 検索の問い合わせが返す行の形（一覧の行と同じ）。 */
interface SearchRow {
  readonly id: string;
  readonly title: string;
  readonly published_at: number | null;
  readonly fork_count: number;
  readonly like_count: number;
  readonly play_count: number;
  readonly parent_id: string | null;
  readonly ogp_state: string | null;
  readonly author_id: string | null;
  readonly tag1: string | null;
  readonly tag2: string | null;
  readonly tag3: string | null;
  readonly author_name: string | null;
  readonly author_avatar_set_at: number | null;
}

/**
 * 行をカードの入力へ落とす。
 *
 * **`src/games.ts` の `toPublicWork` の写しである**（あちらは輸出されておらず、束に入るファイルを
 * 触らないため）。**同じ作品を一覧と検索で引いて、同じ値になることを `test/work-search.test.ts` が見る。**
 *
 * @param row D1 の行
 * @returns 作品カードの入力
 */
function toPublicWork(row: SearchRow): PublicWork {
  return {
    id: row.id,
    title: row.title,
    authorName: row.author_name,
    authorId: row.author_id,
    authorAvatarSetAt: row.author_avatar_set_at,
    publishedAt: row.published_at,
    forkCount: row.fork_count,
    likeCount: row.like_count,
    playCount: row.play_count,
    hasParent: row.parent_id !== null,
    hasShot: row.ogp_state === 'ready',
    tags: workTagsOf(row),
  };
}

/**
 * 件数と読み飛ばしが 0 以上の整数であることを確かめる。
 *
 * @param value 値
 * @param what エラーの文言に入れる名前
 * @throws 0 以上の整数でない場合
 */
function assertCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what}は 0 以上の整数でなければなりません: ${value}`);
  }
}

/**
 * 公開作品を検索する（新着順）。
 *
 * **可視の条件は引く時点で掛ける**（{@link searchWorksStatement}）。件数の上限は呼び出し側が決める
 * （`src/works-list.ts` の `WORKS_PER_PAGE`。一覧と同じ）。
 *
 * # 失敗の文言に検索語を載せない
 *
 * **D1 の失敗はそのまま投げない。** FTS5 の構文の失敗は問い合わせの断片を文言に含み、投げた
 * 例外は `src/index.ts` がログへ出す。**検索語をログに出さない**（issue の推奨）ために、固定の
 * 文言へ置き換えて投げ直す（元の例外は `cause` にも付けない——付けるとログに一緒に出る）。
 * 分類の手がかりとして、元の例外の名前だけをログに残す。
 *
 * @param env バインディングと環境変数
 * @param search 受け付けた検索
 * @param tag 絞り込むタグ（絞り込まないなら null）
 * @param limit 引く最大件数（0 以上の整数）
 * @param offset 読み飛ばす件数（0 以上の整数）
 * @returns 新着順に並んだ、当たった公開作品
 * @throws `limit` / `offset` が 0 以上の整数でない場合と、D1 の問い合わせに失敗した場合
 */
export async function listSearchedGames(
  env: Env,
  search: AcceptedSearch,
  tag: WorkTagId | null,
  limit: number,
  offset: number,
): Promise<readonly PublicWork[]> {
  assertCount(limit, '取得件数');
  assertCount(offset, '読み飛ばし件数');
  const statement = searchWorksStatement(search, tag, limit, offset);
  try {
    const result = await env.DB.prepare(statement.sql)
      .bind(...statement.binds)
      .all<SearchRow>();
    return result.results.map(toPublicWork);
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[work-search] 検索の問い合わせに失敗しました（${name}）`);
    throw new Error('検索の問い合わせに失敗しました');
  }
}
