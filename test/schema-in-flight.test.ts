/**
 * 進行中の要求を引く条件が、全走査にならないこと（#455）。
 *
 * **判定は生成・フォーク・推敲の要求のたびに 1 回走る**（`src/games.ts` の
 * `inFlightGuardSql`）。**既存の索引で足りるのでマイグレーションは足していない。**
 * それが今後も成り立つことを、**実装が返す条件そのものの実行計画**で見る（索引の存在の
 * 検査は、索引を使えない形に条件を書き換えても通る。`test/my-works.test.ts` と同じ考え方）。
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { inFlightGuardBindings, inFlightGuardSql } from '../src/games.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/**
 * 実行計画を 1 行の文字列にする（`test/schema-official-samples.test.ts` と同じ形）。
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

describe('進行中の判定の実行計画', () => {
  it('`games` も `game_revision_jobs` も全走査せず、利用者の索引から入る', async () => {
    // **実装が返す条件をそのまま掛ける**（書き写さない）。
    const detail = await planOf(
      `select case when ${inFlightGuardSql()} then 0 else 1 end as busy`,
      inFlightGuardBindings('user-plan', 1_000_000),
    );
    // **マイグレーションを足していない理由がこれである**（#455）。どちらの副問い合わせも
    // `games(author_id, …)`（0008）で利用者の作品に絞ってから、推敲ジョブは主キー
    // （`game_id`）で突き合わせる。**読む行数は利用者 1 人の作品数で頭打ちになり**、
    // 全体の行数には比例しない。
    expect(detail, detail).toMatch(/SEARCH inflight_g USING (?:COVERING )?INDEX \S+ \(author_id=\?\)/u);
    expect(detail, detail).toMatch(
      /SEARCH inflight_owner USING (?:COVERING )?INDEX \S+ \(author_id=\?\)/u,
    );
    expect(detail, detail).toMatch(/SEARCH inflight_j USING (?:COVERING )?INDEX \S+ \(game_id=\?\)/u);
    // 索引を使わない `SCAN <別名>` が出たら全走査である（`SCAN ... USING ...` は索引の上を
    // 順に読む形なので除く）。
    expect(detail, detail).not.toMatch(/SCAN inflight_(?:g|j|owner)(?! USING)/u);
  });
});
