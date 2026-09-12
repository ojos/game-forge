import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_STATUS } from '../src/games.js';
import {
  MAX_OPERATOR_ACCOUNTS,
  officialSamplesSql,
  operatorIdsSql,
} from '../src/home-feed.js';
import { reviewVisibleSql } from '../src/reports.js';
import { applySchema } from './helpers/schema.js';

/**
 * `migrations/0023_official_samples_idx.sql`（#329 / M9-3 / 仕様 2.3.1・2.3.3）。
 *
 * **索引があることより、索引が実際に使われることを見る**（`test/schema-likes.test.ts` と
 * 同じ形）。この 2 本が使われなくなったときの壊れ方は、**結果が正しいまま読み取りだけが
 * 増える**ことである——
 *
 * - `users_operator_idx` が外れると、運営の行を見つけるまで `users` を走査する
 *   （読み取りが利用者数に比例する）
 * - `games_official_samples_idx` が外れると `0008` の索引へ落ち、**運営の下書きと審査中の
 *   作品を余分に読む**（`0008` は公開状態と審査の条件を含まない）
 *
 * **どちらも画面は正しく出る。** だから機械で見る必要がある。
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

describe('運営アカウントの部分索引（users_operator_idx）', () => {
  it('`is_operator = 1` の条件つきで、`id` だけを載せている', async () => {
    const sql = await indexSql('users_operator_idx');
    expect(sql).not.toBeNull();
    expect(sql).toContain('is_operator = 1');
    expect(sql).toContain('users(id)');
  });

  it('運営アカウントを引く問い合わせが `users` の全走査にならない', async () => {
    const detail = await planOf(operatorIdsSql(), [MAX_OPERATOR_ACCOUNTS]);
    expect(detail, detail).toContain('users_operator_idx');
    // 索引を使わない `SCAN users` が出たら全走査である（`SCAN ... USING ...` は索引の上を
    // 順に読む正しい形なので除く。`test/schema-likes.test.ts` の BAN の検査と同じ綴り）。
    expect(detail, detail).not.toMatch(/SCAN users(?! USING)/u);
    // **並べ替えのための一時 B-tree が出たら、`order by id` が索引に乗っていない。**
    expect(detail, detail).not.toContain('USE TEMP B-TREE');
  });
});

describe('公式サンプルの部分索引（games_official_samples_idx）', () => {
  it('審査の可視条件を reviewVisibleSql と同じ綴りで持つ', async () => {
    // **綴りの一致を見る。** 意味が同じでも綴りが違えば、SQLite が「含む」と示せずに
    // 部分索引を使わないことがある（`0020` が同じ理由で同じ検査を持っている）。
    const sql = await indexSql('games_official_samples_idx');
    expect(sql).not.toBeNull();
    expect(sql).toContain(reviewVisibleSql());
    expect(sql).toContain("status = 'published'");
    // 列順は `officialSamplesSql` の `order by` に揃っている。**`published_at` ではない**
    // （理由は `src/home-feed.ts`。一時 B-tree が入り、LIMIT の前に全件読むことになる）。
    expect(sql).toContain('(author_id, created_at DESC, id DESC)');
  });

  it('公式サンプルを引く問い合わせがこの索引を使う', async () => {
    // **本番と同じ束縛で掛ける。** `status` は値を束縛して渡すので、束縛した値が部分索引の
    // 条件と照合されることまでここで確かめる（2.3.3 の v1.52 追記が実測で確かめた性質）。
    const detail = await planOf(officialSamplesSql(), ['だれか', PUBLISHED_STATUS, 8]);
    expect(detail, detail).toContain('games_official_samples_idx');
    expect(detail, detail).not.toContain('USE TEMP B-TREE');
    expect(detail, detail).not.toMatch(/SCAN g(?! USING)/u);
  });

  it('`draft` を引くときはこの索引が使われない', async () => {
    // **部分索引の条件が本当に効いていることの対照実験。** `0020` の v1.52 追記が
    // 「`'published'` では使い、`'draft'` では使わない」と実測した性質そのものである。
    // これが緑でないと、上の検査は「たまたま名前が出ていた」だけでも通る。
    const detail = await planOf(officialSamplesSql(), ['だれか', 'draft', 8]);
    expect(detail, detail).not.toContain('games_official_samples_idx');
  });
});
