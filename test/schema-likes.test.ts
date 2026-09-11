import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { reviewVisibleSql } from '../src/reports.js';
import { BANNED_USERS_SQL } from '../workers/likes/src/hub.js';
import { applySchema } from './helpers/schema.js';

/**
 * `migrations/0020_games_like_count.sql`（#339 / 5.8）。
 *
 * **列と索引があることより、索引の条件が一覧の条件と同じ綴りであることを見る。**
 * SQLite は問い合わせの条件が部分索引の条件を含むと示せたときだけ索引を使うので、
 * `reviewVisibleSql` を書き換えた日に索引の条件だけが古いと、**黙って全表走査へ戻る**
 * （実行計画の検査は `test/works-list.test.ts` が持つ）。
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
  const row = await env.DB.prepare("select sql from sqlite_master where type = 'index' and name = ?")
    .bind(name)
    .first<{ sql: string | null }>();
  return row?.sql ?? null;
}

describe('games.like_count（5.8）', () => {
  it('既存の行は 0 から始まり、NULL を持てない', async () => {
    // **写しなので、同期される前の作品は「いいね 0」として並ぶ。** NULL を許すと、
    // 並べ替えで NULL がどこへ行くかを読み手が知っている必要が生まれる。
    const columns = await env.DB.prepare("select name, \"notnull\" as not_null, dflt_value from pragma_table_info('games')")
      .all<{ name: string; not_null: number; dflt_value: string | null }>();
    const likeCount = columns.results.find((column) => column.name === 'like_count');
    expect(likeCount).toEqual({ name: 'like_count', not_null: 1, dflt_value: '0' });
  });
});

describe('liked の部分索引（2.3.3 の v1.51 注記）', () => {
  it('審査の可視条件を reviewVisibleSql と同じ綴りで持つ', async () => {
    const sql = await indexSql('games_status_like_count_idx');
    expect(sql).not.toBeNull();
    // **綴りの一致を見る。** 意味が同じでも綴りが違えば、SQLite が「含む」と示せずに
    // 索引を使わないことがある。
    expect(sql).toContain(reviewVisibleSql());
    expect(sql).toContain("status = 'published'");
    // 列の形は issue #339 / 仕様 2.3.3 が定めたとおり。
    expect(sql).toContain('(status, like_count DESC, published_at DESC, id DESC)');
  });
});

describe('BAN の部分索引（5.8 の同期）', () => {
  it('同期が引く SQL が全表走査にならない', async () => {
    // **検査が SQL を書き写さない。** 同期が実際に使う文字列を実行計画に掛ける。
    const plan = await env.DB.prepare(`explain query plan ${BANNED_USERS_SQL}`).all<{
      detail: string;
    }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');
    expect(detail, detail).toContain('users_banned_idx');
    expect(detail, detail).not.toMatch(/SCAN users(?! USING)/u);
  });
});
