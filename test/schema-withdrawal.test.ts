import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { WITHDRAWAL_LOCK_TOKEN_PREFIX } from '../src/withdrawal.js';
import { applySchema } from './helpers/schema.js';

/**
 * 退会の土台のスキーマ（`migrations/0045_user_withdrawal.sql` / #586 / M15-3a）。
 *
 * **宣言そのものを見る。** 列・CHECK・部分索引・トリガは、アプリのコードからは見えない層に
 * あり、**落としても大半のテストは緑のまま通る**（`src/withdrawal.ts` は列があるものとして
 * 書いてある）。ここが唯一、マイグレーションの中身を機械で確かめる場所である。
 *
 * 1. 3 列がある
 * 2. 順序の CHECK が効く（`withdrawn_at` は掴む前に立たない・`withdrawal_completed_at` は
 *    確定する前に立たない・時刻が戻らない）
 * 3. 部分索引があり、**後続の処理の問い合わせがそれを使う**（`EXPLAIN QUERY PLAN`）
 * 4. トリガ 3 本が、退会を始めた作者の作品と推敲を**例外を投げずに 0 行**にする
 * 5. UPSERT（`claimRevisionSlot` の形）の INSERT が飛ばされたとき、`DO UPDATE` へ進まない
 * 6. 退会していない作者には 1 つも当たらない
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人作る。
 *
 * @param overrides 退会の 3 列（省略すると NULL）
 * @returns 利用者の id
 */
async function seedUser(overrides: {
  startedAt?: number | null;
  withdrawnAt?: number | null;
  completedAt?: number | null;
} = {}): Promise<string> {
  const id = `wd-schema-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users
       (id, google_sub, email, display_name, created_at,
        withdrawal_started_at, withdrawn_at, withdrawal_completed_at)
     values (?, ?, ?, '利用者', 1, ?, ?, ?)`,
  )
    .bind(
      id,
      `sub-${id}`,
      `${id}@example.com`,
      overrides.startedAt ?? null,
      overrides.withdrawnAt ?? null,
      overrides.completedAt ?? null,
    )
    .run();
  return id;
}

/**
 * 作品行を 1 つ作る（`insert into games` を直に打つ——**トリガが効く経路そのもの**）。
 *
 * @param authorId 作者
 * @returns 挿入で報告された行数
 */
async function insertGame(authorId: string): Promise<number> {
  const result = await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
     values (?, ?, 'draft', '題名', 'go1.27.0', 100, 'pending')`,
  )
    .bind(crypto.randomUUID(), authorId)
    .run();
  return result.meta.changes ?? 0;
}

describe('0045 が退会の 3 列と順序の CHECK を足す', () => {
  it('3 列が読める（既定は NULL）', async () => {
    const id = await seedUser();
    const row = await env.DB.prepare(
      'select withdrawal_started_at, withdrawn_at, withdrawal_completed_at from users where id = ?',
    )
      .bind(id)
      .first<Record<string, number | null>>();
    expect(row).toEqual({
      withdrawal_started_at: null,
      withdrawn_at: null,
      withdrawal_completed_at: null,
    });
  });

  it('掴む前に withdrawn_at は立たない', async () => {
    const id = await seedUser();
    await expect(
      env.DB.prepare('update users set withdrawn_at = 200 where id = ?').bind(id).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('確定する前に withdrawal_completed_at は立たない', async () => {
    const id = await seedUser({ startedAt: 100 });
    await expect(
      env.DB.prepare('update users set withdrawal_completed_at = 200 where id = ?').bind(id).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('時刻が戻らない（確定が掴んだ時刻より前にならない）', async () => {
    const id = await seedUser({ startedAt: 500 });
    await expect(
      env.DB.prepare('update users set withdrawn_at = 499 where id = ?').bind(id).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('順に立てるぶんには通る', async () => {
    const id = await seedUser();
    await env.DB.prepare('update users set withdrawal_started_at = 100 where id = ?').bind(id).run();
    await env.DB.prepare('update users set withdrawn_at = 100 where id = ?').bind(id).run();
    await env.DB.prepare('update users set withdrawal_completed_at = 300 where id = ?').bind(id).run();
    const row = await env.DB.prepare('select withdrawal_completed_at from users where id = ?')
      .bind(id)
      .first<{ withdrawal_completed_at: number }>();
    expect(row?.withdrawal_completed_at).toBe(300);
  });
});

describe('0045 の部分索引を、後続の処理の問い合わせが使う', () => {
  it('users_withdrawal_pending_idx がある', async () => {
    const row = await env.DB.prepare(
      "select name from sqlite_master where type = 'index' and name = 'users_withdrawal_pending_idx'",
    ).first<{ name: string }>();
    expect(row?.name).toBe('users_withdrawal_pending_idx');
  });

  it('終わっていない退会を引く問い合わせが、全走査にならない', async () => {
    // `src/withdrawal-purge.ts` の `hasUnfinishedWithdrawal` と同じ綴り。
    const { results } = await env.DB.prepare(
      `explain query plan
       select id from users
        where withdrawal_started_at is not null and withdrawal_completed_at is null
        limit 1`,
    ).all<{ detail: string }>();
    const detail = results.map((row) => row.detail).join('\n');
    // **部分索引そのものを走らせる形が正しい**（`SCAN users USING INDEX
    // users_withdrawal_pending_idx`）。索引には「掴んだが完了していない行」しか入っていないので、
    // 平常時に読む行は 0 である。**素の表の全走査（`SCAN users` で終わる行）にならないこと**を見る。
    expect(detail).toContain('users_withdrawal_pending_idx');
    expect(detail).not.toMatch(/SCAN users(?! USING)/u);
  });
});

describe('0045 のトリガが、退会を始めた作者の書き込みを黙って飛ばす', () => {
  it('退会していない作者の作品は入る', async () => {
    const author = await seedUser();
    expect(await insertGame(author)).toBeGreaterThan(0);
  });

  it('退会を始めた作者の作品は、例外を投げずに 0 行になる', async () => {
    const author = await seedUser({ startedAt: 100 });
    expect(await insertGame(author)).toBe(0);
    const row = await env.DB.prepare('select count(*) as n from games where author_id = ?')
      .bind(author)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('退会を確定した作者でも同じ（withdrawal_started_at が立ったままである）', async () => {
    const author = await seedUser({ startedAt: 100, withdrawnAt: 100 });
    expect(await insertGame(author)).toBe(0);
  });

  it('推敲の枠（UPSERT）は、枠が無い作品では 0 行になる', async () => {
    const author = await seedUser();
    const gameId = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
       values (?, ?, 'draft', '題名', 'go1.27.0', 100, 'ready')`,
    )
      .bind(gameId, author)
      .run();
    await env.DB.prepare('update users set withdrawal_started_at = 100 where id = ?').bind(author).run();

    // `claimRevisionSlot`（`src/revisions.ts`）と同じ形の UPSERT。
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h', 'p', 'pending', null, null, 100)
       on conflict(game_id) do update set state = 'pending', prompt = 'p2'`,
    )
      .bind(gameId)
      .run();

    const row = await env.DB.prepare('select count(*) as n from game_revision_jobs where game_id = ?')
      .bind(gameId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('UPSERT の INSERT が飛ばされたとき、DO UPDATE へ進まない（枠がある作品）', async () => {
    const author = await seedUser();
    const gameId = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
       values (?, ?, 'draft', '題名', 'go1.27.0', 100, 'ready')`,
    )
      .bind(gameId, author)
      .run();
    // 退会する前に、失敗した枠を 1 つ残しておく。
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h', '古い指示', 'failed', 'build-failed', null, 100)`,
    )
      .bind(gameId)
      .run();
    await env.DB.prepare('update users set withdrawal_started_at = 100 where id = ?').bind(author).run();

    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h2', '新しい指示', 'pending', null, null, 200)
       on conflict(game_id) do update set state = 'pending', prompt = '新しい指示'`,
    )
      .bind(gameId)
      .run();

    const row = await env.DB.prepare('select state, prompt from game_revision_jobs where game_id = ?')
      .bind(gameId)
      .first<{ state: string; prompt: string }>();
    // **`do update` が走っていたら `pending` / 新しい指示になっている。**
    expect(row).toEqual({ state: 'failed', prompt: '古い指示' });
  });

  it('止まった枠を pending へ戻す UPDATE も飛ばされる', async () => {
    const author = await seedUser();
    const gameId = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
       values (?, ?, 'draft', '題名', 'go1.27.0', 100, 'ready')`,
    )
      .bind(gameId, author)
      .run();
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h', 'p', 'failed', 'build-failed', null, 100)`,
    )
      .bind(gameId)
      .run();
    await env.DB.prepare('update users set withdrawal_started_at = 100 where id = ?').bind(author).run();

    await env.DB.prepare("update game_revision_jobs set state = 'pending' where game_id = ?")
      .bind(gameId)
      .run();
    const blocked = await env.DB.prepare('select state from game_revision_jobs where game_id = ?')
      .bind(gameId)
      .first<{ state: string }>();
    expect(blocked?.state).toBe('failed');

    // **`running` への遷移と失敗の記録は止めない**（走っているジョブを宙に浮かせない）。
    await env.DB.prepare("update game_revision_jobs set state = 'running' where game_id = ?")
      .bind(gameId)
      .run();
    const allowed = await env.DB.prepare('select state from game_revision_jobs where game_id = ?')
      .bind(gameId)
      .first<{ state: string }>();
    expect(allowed?.state).toBe('running');
  });
});

describe('0045 のアイコンのトリガ（PR #588）', () => {
  /**
   * トリガの定義の SQL を引く。
   *
   * @param name トリガの名前
   * @returns SQL（無ければ null）
   */
  async function triggerSql(name: string): Promise<string | null> {
    const row = await env.DB.prepare(
      "select sql from sqlite_master where type = 'trigger' and name = ?",
    )
      .bind(name)
      .first<{ sql: string }>();
    return row?.sql ?? null;
  }

  it('排他のトリガが読む接頭辞が、src/withdrawal.ts の定数と一致する', async () => {
    // **写しを目で守らない**（shared-ai-rules 12 章）。SQL の綴りと定数がずれると、退会の掴み
    // そのものがトリガに飛ばされ、**退会が 1 件も進まなくなる**（どのテストも赤くならない）。
    const sql = await triggerSql('users_skip_avatar_lock_for_withdrawal');
    expect(sql).not.toBeNull();
    expect(sql).toContain(`'${WITHDRAWAL_LOCK_TOKEN_PREFIX}%'`);
  });

  it('どちらのトリガも本体は SELECT RAISE(IGNORE) だけで、表を書かない', async () => {
    for (const name of ['users_skip_avatar_lock_for_withdrawal', 'users_skip_avatar_set_for_withdrawal']) {
      const sql = await triggerSql(name);
      expect(sql, name).not.toBeNull();
      // **`BEGIN` より後ろ（本体）だけを見る。** 見出しの `BEFORE UPDATE OF …` には
      // `update ` の綴りが必ず入っているので、全文で引くと自分の宣言に当たって空振りする。
      const squashed = sql!.replace(/\s+/gu, ' ').toLowerCase();
      const body = squashed.slice(squashed.indexOf(' begin '));
      expect(body, name).toContain('select raise(ignore)');
      for (const verb of ['insert into', 'update ', 'delete from']) {
        expect(body, `${name} / ${verb}`).not.toContain(verb);
      }
    }
  });

  it('退会していない利用者の排他とアイコンは、素通りする', async () => {
    const id = await seedUser();
    await env.DB.prepare("update users set avatar_lock_token = 'plain-token' where id = ?").bind(id).run();
    await env.DB.prepare('update users set avatar_sha256 = ? where id = ?').bind('a'.repeat(64), id).run();
    const row = await env.DB.prepare('select avatar_lock_token, avatar_sha256 from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string; avatar_sha256: string }>();
    expect(row).toEqual({ avatar_lock_token: 'plain-token', avatar_sha256: 'a'.repeat(64) });
  });

  it('退会を始めた利用者では、接頭辞つきの token だけが通る', async () => {
    const id = await seedUser({ startedAt: 100 });
    await env.DB.prepare("update users set avatar_lock_token = 'plain-token' where id = ?").bind(id).run();
    const blocked = await env.DB.prepare('select avatar_lock_token from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string | null }>();
    expect(blocked?.avatar_lock_token).toBeNull();

    const own = `${WITHDRAWAL_LOCK_TOKEN_PREFIX}abc`;
    await env.DB.prepare('update users set avatar_lock_token = ? where id = ?').bind(own, id).run();
    const allowed = await env.DB.prepare('select avatar_lock_token from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string }>();
    expect(allowed?.avatar_lock_token).toBe(own);

    // **外す向き（NULL）は止めない**（段3 の 14 番目が打つ。#694 までは 13 番目）。
    await env.DB.prepare('update users set avatar_lock_token = null where id = ?').bind(id).run();
    const cleared = await env.DB.prepare('select avatar_lock_token from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string | null }>();
    expect(cleared?.avatar_lock_token).toBeNull();
  });
});
