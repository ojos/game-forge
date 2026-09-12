import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_STATUS, PUBLISHED_STATUS } from '../src/games.js';
import { reviewVisibleSql } from '../src/reports.js';
import { authorWorksSql, likesReceivedSql } from '../src/users-page.js';
import { WORKS_PER_PAGE } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * `migrations/0024_games_author_published_idx.sql`（#330 / M9-4 / 仕様 2.3.1・2.3.3・5.8）。
 *
 * **索引があることより、索引が実際に使われることを見る**（`test/schema-likes.test.ts` /
 * `test/schema-official-samples.test.ts` と同じ形）。この索引が使われなくなったときの
 * 壊れ方は、**結果が正しいまま読み取りだけが増える**ことである——
 *
 * - `0008` の `games_author_id_created_at_idx` へ落ちると、作者の下書きと審査で止まった
 *   作品を余分に読む（あちらは公開状態と審査の条件を含まない）
 * - `0023` の `games_official_samples_idx` へ落ちると、並べ替えのための一時 B-tree が
 *   入り、**LIMIT を掛ける前にその作者の公開作品を全件読む**（列順が `created_at`）
 *
 * **どちらも画面は正しく出る。** だから機械で見る必要がある。
 *
 * **`test/schema.test.ts` は触っていない**（あちらは 5.1 の 5 テーブルの形を見る）。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * 索引の定義文をカタログから引く。
 *
 * @param name 索引の名前
 * @returns `create index` の文。無ければ null
 */
async function indexSql(name: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "select sql from sqlite_master where type = 'index' and name = ?",
  )
    .bind(name)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
}

/**
 * 実行計画を 1 行の文字列にする。
 *
 * **検査が SQL を書き写さない。** 実装が返す文字列をそのまま掛ける
 * （`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * @param sql 実行する文
 * @param binds 束縛する値
 * @returns `EXPLAIN QUERY PLAN` の detail を連ねたもの
 */
async function planOf(sql: string, binds: readonly unknown[]): Promise<string> {
  const plan = await env.DB.prepare(`explain query plan ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(' | ');
}

/** 作者ページが引くときの束縛（一覧）。 */
const WORKS_BINDS = ['だれか', PUBLISHED_STATUS, WORKS_PER_PAGE + 1, 0] as const;

describe('作者ページの部分索引（games_author_published_at_idx）', () => {
  it('審査の可視条件を reviewVisibleSql と同じ綴りで持つ', async () => {
    // **綴りの一致を見る。** 意味が同じでも綴りが違えば、SQLite が「含む」と示せずに
    // 部分索引を使わないことがある（`0020` / `0023` が同じ理由で同じ検査を持っている）。
    const sql = await indexSql('games_author_published_at_idx');
    expect(sql).not.toBeNull();
    expect(sql).toContain(reviewVisibleSql());
    expect(sql).toContain("status = 'published'");
    // 列順は `authorWorksSql` の `order by` に揃っている。**`created_at` ではない**
    // （理由は 0024。カードが出すのは `published_at` なので、並びの軸を揃える）。
    expect(sql).toContain('(author_id, published_at DESC, id DESC)');
  });

  it('`like_count` を索引へ載せていない（同期の書き込みを増やさない）', async () => {
    // **0024 が明示した取引である。** 載せれば被いいね数が covering index で済むが、
    // `like_count` は 5 分おきの同期が書く列で（0020）、載せた分だけ書き込みが増える。
    // **5 分おきの書き込みと、作者ページを開いたときの読み取りを交換しない。**
    const sql = await indexSql('games_author_published_at_idx');
    expect(sql).not.toBeNull();
    // 部分索引の条件に `like_count` は出ないので、出たら列として載っている。
    expect(sql).not.toContain('like_count');
  });

  it('公開作品を 1 頁ぶん引く問い合わせがこの索引を使う', async () => {
    // **本番と同じ束縛で掛ける。** `status` は値を束縛して渡すので、束縛した値が部分索引の
    // 条件と照合されることまでここで確かめる（仕様 2.3.3 の v1.52 追記が実測で確かめた性質）。
    const detail = await planOf(authorWorksSql(), WORKS_BINDS);
    expect(detail, detail).toContain('games_author_published_at_idx');
    // **一時 B-tree が出たら、索引の列順が並びと合っていない**（＝ LIMIT の前に
    // その作者の公開作品を全件読んでいる）。
    expect(detail, detail).not.toContain('USE TEMP B-TREE');
    // **索引を使わない `SCAN g` が出たら全表走査である**（`SCAN g USING ...` は索引の上を
    // 順に読む正しい形なので除く）。
    expect(detail, detail).not.toMatch(/SCAN g(?! USING)/u);
  });

  it('被いいね数の合計もこの索引を使う（作者の作品だけを読む）', async () => {
    // **`games` を全走査して合計しない。** 5.8 は「作者 1 人の作品数に比例する読み取りで、
    // `(author_id, …)` の索引が効く」と書いている。**効いていなければ、合計は公開作品の
    // 総数に比例する**（2.3.3 の条件 1 が崩れる）。
    const detail = await planOf(likesReceivedSql(), ['だれか', PUBLISHED_STATUS]);
    expect(detail, detail).toContain('games_author_published_at_idx');
    expect(detail, detail).not.toMatch(/SCAN g(?! USING)/u);
  });

  it('`draft` を引くときはこの索引が使われない', async () => {
    // **部分索引の条件が本当に効いていることの対照実験**（`0020` の v1.52 追記が
    // 「`'published'` では使い、`'draft'` では使わない」と実測した性質そのもの）。
    // これが緑でないと、上の 2 つは「たまたま名前が出ていた」だけでも通る。
    const detail = await planOf(authorWorksSql(), ['だれか', DRAFT_STATUS, 21, 0]);
    expect(detail, detail).not.toContain('games_author_published_at_idx');
  });

  it('0023 の索引（created_at 順）へは落ちていない', async () => {
    // **同じ部分条件・同じ先頭列で列順だけが違う索引が隣にある。** そちらが選ばれると
    // 一時 B-tree が入るので上の検査で落ちるが、**どちらが選ばれたかを名前でも
    // 固定しておく**（落ち方の説明が「並びが遅い」ではなく「別の索引を見ている」に
    // なるようにする）。
    const detail = await planOf(authorWorksSql(), WORKS_BINDS);
    expect(detail, detail).not.toContain('games_official_samples_idx');
  });
});
