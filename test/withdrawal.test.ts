import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { AVATAR_LOCK_SECONDS, acquireAvatarLock } from '../src/avatar.js';
import { avatarHistoryKey, avatarObjectKey } from '../src/avatar-paths.js';
import { HANDLES_TABLE } from '../src/handle.js';
import {
  WITHDRAWAL_ALREADY,
  WITHDRAWN,
  WITHDRAWN_DISPLAY_NAME,
  WITHDRAWAL_LOCK_TOKEN_PREFIX,
  WITHDRAWN_GOOGLE_SUB_PREFIX,
  avatarHistoryPrefixOf,
  withdrawUser,
} from '../src/withdrawal.js';
import { applySchema } from './helpers/schema.js';

/**
 * 退会の、押した要求の中で済ませる処理（`src/withdrawal.ts` / #586 / M15-3a）。
 *
 * **#518 の acceptance 3・4 を、口が無いうちに機械判定する。**
 *
 * 3. 退会した行の `google_sub` / `email` / `display_name` / `bio` / `profile_links` に元の値が
 *    残らず、変更履歴の表に行が無い。**運営の措置がある利用者では履歴が残る**
 * 4. `generations` の行数と費用が退会の前後で変わらず、`prompt` が空になる
 *
 * あわせて、**アイコンが R2 から消えること**・**ハンドル名が 90 日の予約へ移ること**・
 * **公開中の作品が取り下がり、親の被改造数が数え直されること**・**待機リストが消えること**・
 * **断る条件**・**冪等性**を見る。
 */

beforeAll(async () => {
  await applySchema();
});

const NOW = 1_800_000_000;

/** 用意する利用者の下準備。 */
interface SeedUser {
  readonly isAdmin?: boolean;
  readonly bannedAt?: number | null;
  readonly avatarSha256?: string | null;
  readonly avatarLockAt?: number | null;
}

/**
 * 利用者を 1 人用意する（表示名・自己紹介・リンク・メール設定を埋めておく）。
 *
 * @param seed 下準備
 * @returns 利用者の id と、元のメールアドレス
 */
async function seedUser(seed: SeedUser = {}): Promise<{ id: string; email: string }> {
  const id = `wd-${crypto.randomUUID()}`;
  const email = `${id}@example.com`;
  await env.DB.prepare(
    `insert into users
       (id, google_sub, email, display_name, x_handle, created_at, banned_at, is_admin,
        bio, profile_links, profile_set_at, display_name_set_at,
        avatar_sha256, avatar_set_at, avatar_lock_token, avatar_lock_at, fork_notice_muted_at)
     values (?, ?, ?, '本名っぽい表示名', 'x_name', 100, ?, ?, '自己紹介', ?, 150, 150, ?, 150, ?, ?, 160)`,
  )
    .bind(
      id,
      `sub-${id}`,
      email,
      seed.bannedAt ?? null,
      seed.isAdmin === true ? 1 : 0,
      JSON.stringify(['https://example.com/me']),
      seed.avatarSha256 ?? null,
      seed.avatarLockAt === undefined || seed.avatarLockAt === null ? null : 'other-token',
      seed.avatarLockAt ?? null,
    )
    .run();
  return { id, email };
}

/**
 * 作品行を 1 つ作る。
 *
 * @param authorId 作者
 * @param overrides 状態
 * @returns 作品 id
 */
async function seedGame(
  authorId: string,
  overrides: {
    status?: 'draft' | 'published' | 'removed';
    generationState?: 'pending' | 'running' | 'ready' | 'failed';
    parentId?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, parent_id, status, title, go_version, created_at,
                        published_at, generation_state)
     values (?, ?, ?, ?, '題名', 'go1.27.0', 100, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.parentId ?? null,
      overrides.status ?? 'draft',
      (overrides.status ?? 'draft') === 'published' ? 200 : null,
      overrides.generationState ?? 'ready',
    )
    .run();
  return id;
}

/**
 * 費用台帳の行を 1 つ積む。
 *
 * @param userId 利用者
 * @param gameId 作品（null 可）
 * @param costJpy 費用
 * @returns 台帳の行 id
 */
async function seedGeneration(userId: string, gameId: string | null, costJpy: number): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at)
     values (?, ?, ?, '個人が特定できそうな指示文', 'sonnet-4-6', 10, 20, 0, 0, ?, 1, 300)`,
  )
    .bind(id, gameId, userId, costJpy)
    .run();
  return id;
}

/**
 * 利用者の行をそのまま読む。
 *
 * @param userId 利用者
 * @returns 行（無ければ null）
 */
async function readUser(userId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('select * from users where id = ?')
    .bind(userId)
    .first<Record<string, unknown>>();
}

/**
 * 表の行数を数える。
 *
 * @param table 表の名前（**テストが書いたリテラルだけ**を渡す）
 * @param userId 利用者
 * @returns 行数
 */
async function countFor(table: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table} where user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('退会すると、個人を識別できる値が残らない', () => {
  it('匿名化・履歴の削除・ハンドルの予約・台帳・取り下げが 1 回で済む', async () => {
    const { id, email } = await seedUser({ avatarSha256: 'a'.repeat(64) });

    // ハンドル名と、履歴を 4 表ぶん積んでおく。
    await env.DB.prepare(
      `insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values ('oldname', ?, 200)`,
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      `insert into handle_changes (id, user_id, old_handle, new_handle, changed_at)
       values (?, ?, null, 'oldname', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();
    await env.DB.prepare(
      `insert into display_name_changes (id, user_id, old_display_name, new_display_name, changed_at)
       values (?, ?, '前の名前', '本名っぽい表示名', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();
    await env.DB.prepare(
      `insert into profile_changes (id, user_id, old_bio, new_bio, old_links, new_links, changed_at)
       values (?, ?, '', '自己紹介', '[]', '[]', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();
    await env.DB.prepare(
      `insert into avatar_changes (id, user_id, old_sha256, new_sha256, history_key, changed_at)
       values (?, ?, null, ?, null, 200)`,
    )
      .bind(crypto.randomUUID(), id, 'a'.repeat(64))
      .run();

    // 待機リストに同じメールアドレスの行があり、別の人の行もある。
    await env.DB.prepare("insert into waitlist (id, email, source, created_at) values (?, ?, 'x', 100)")
      .bind(crypto.randomUUID(), email)
      .run();
    await env.DB.prepare("insert into waitlist (id, email, source, created_at) values (?, ?, 'x', 100)")
      .bind(crypto.randomUUID(), 'someone-else@example.com')
      .run();

    // R2 にアイコンの現行と写しを 2 枚置く。
    await env.BUCKET.put(avatarObjectKey(id), 'current');
    await env.BUCKET.put(avatarHistoryKey(id, 150, 'b'.repeat(64), 'op-1'), 'old-1');
    await env.BUCKET.put(avatarHistoryKey(id, 160, 'c'.repeat(64), 'op-2'), 'old-2');

    // 作品（公開中の子を 1 本、別の作者の親に付ける）と台帳。
    const other = await seedUser();
    const parent = await seedGame(other.id, { status: 'published' });
    const own = await seedGame(id, { status: 'published', parentId: parent });
    await env.DB.prepare('update games set fork_count = 1 where id = ?').bind(parent).run();
    // 最初の指示文（#694 / `0047`）。他人の作品の指示文は消さないこと。
    await env.DB.prepare('update games set prompt = ? where id in (?, ?)').bind('最初の指示', own, parent).run();
    const ledgerA = await seedGeneration(id, null, 22.5);
    const ledgerB = await seedGeneration(id, null, 7.25);

    const outcome = await withdrawUser(env, id, NOW);
    expect(outcome).toEqual({ ok: true, result: WITHDRAWN });

    // ── acceptance 3: 元の値が残らない ──────────────────────────────────
    const row = await readUser(id);
    expect(row).not.toBeNull();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('本名っぽい表示名');
    expect(serialized).not.toContain('自己紹介');
    expect(serialized).not.toContain('x_name');
    expect(serialized).not.toContain('example.com/me');
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(`sub-${id}`);
    expect(row?.google_sub).toBe(`${WITHDRAWN_GOOGLE_SUB_PREFIX}${id}`);
    expect(row?.email).toBe('');
    expect(row?.display_name).toBe(WITHDRAWN_DISPLAY_NAME);
    expect(row?.bio).toBe('');
    expect(row?.profile_links).toBe('[]');
    expect(row?.x_handle).toBeNull();
    expect(row?.avatar_sha256).toBeNull();
    expect(row?.avatar_lock_token).toBeNull();
    expect(row?.fork_notice_muted_at).toBeNull();
    // **残すもの**（招待の行と波及の計算を変えない）。
    expect(row?.created_at).toBe(100);
    expect(row?.withdrawn_at).toBe(NOW);
    expect(row?.withdrawal_started_at).toBe(NOW);
    expect(row?.withdrawal_completed_at).toBeNull();

    // 記録が無いので、履歴の 4 表は 0 行。
    expect(await countFor('display_name_changes', id)).toBe(0);
    expect(await countFor('profile_changes', id)).toBe(0);
    expect(await countFor('avatar_changes', id)).toBe(0);
    expect(await countFor('handle_changes', id)).toBe(0);

    // ── acceptance 4: 台帳の行数と費用は変わらず、指示文だけが空 ──────────
    const { results: ledger } = await env.DB.prepare(
      'select id, cost_jpy, created_at, prompt from generations where user_id = ? order by id',
    )
      .bind(id)
      .all<{ id: string; cost_jpy: number; created_at: number; prompt: string }>();
    expect(ledger).toHaveLength(2);
    expect(ledger.map((entry) => [entry.id, entry.cost_jpy, entry.created_at]).sort()).toEqual(
      [
        [ledgerA, 22.5, 300],
        [ledgerB, 7.25, 300],
      ].sort(),
    );
    expect(ledger.every((entry) => entry.prompt === '')).toBe(true);
    // 作品の行に残した最初の指示文も、この時点で消える（#694）。他人の作品は触らない。
    const prompts = await env.DB.prepare('select id, prompt from games where id in (?, ?)')
      .bind(own, parent)
      .all<{ id: string; prompt: string | null }>();
    expect(Object.fromEntries(prompts.results.map((row) => [row.id, row.prompt]))).toEqual({
      [own]: null,
      [parent]: '最初の指示',
    });

    // ── ハンドル名は 90 日の予約へ ────────────────────────────────────
    const handle = await env.DB.prepare(
      `select released_at from ${HANDLES_TABLE} where handle = 'oldname'`,
    ).first<{ released_at: number | null }>();
    expect(handle?.released_at).toBe(NOW);

    // ── アイコンは R2 から消える ─────────────────────────────────────
    expect(await env.BUCKET.head(avatarObjectKey(id))).toBeNull();
    const listed = await env.BUCKET.list({ prefix: avatarHistoryPrefixOf(id) });
    expect(listed.objects).toHaveLength(0);

    // ── 公開中の作品は取り下がり、親の被改造数が数え直される ──────────
    const published = await env.DB.prepare(
      "select count(*) as n from games where author_id = ? and status = 'published'",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(published?.n).toBe(0);
    const parentRow = await env.DB.prepare('select fork_count from games where id = ?')
      .bind(parent)
      .first<{ fork_count: number }>();
    expect(parentRow?.fork_count).toBe(0);

    // ── 待機リストは本人の行だけが消える ────────────────────────────
    const waitlist = await env.DB.prepare('select count(*) as n from waitlist where email = ?')
      .bind(email)
      .first<{ n: number }>();
    expect(waitlist?.n).toBe(0);
    const others = await env.DB.prepare(
      "select count(*) as n from waitlist where email = 'someone-else@example.com'",
    ).first<{ n: number }>();
    expect(others?.n).toBe(1);
  });

  it('2 回目の呼び出しは何も書かず、同じ結果を返す（冪等）', async () => {
    const { id } = await seedUser();
    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });
    const first = await readUser(id);
    expect(await withdrawUser(env, id, NOW + 1000)).toEqual({ ok: true, result: WITHDRAWAL_ALREADY });
    expect(await readUser(id)).toEqual(first);
  });
});

describe('運営の記録がある利用者は、履歴を残す', () => {
  it('運営の措置があれば 4 表が残り、匿名化したことも積まれる', async () => {
    const { id } = await seedUser({ avatarSha256: 'd'.repeat(64) });
    const admin = await seedUser({ isAdmin: true });
    await env.DB.prepare(
      `insert into display_name_changes (id, user_id, old_display_name, new_display_name, changed_at)
       values (?, ?, '前の名前', '本名っぽい表示名', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();
    await env.DB.prepare(
      `insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason)
       values (?, ?, 200, 'user-banned', 'user', ?, '規約違反')`,
    )
      .bind(crypto.randomUUID(), admin.id, id)
      .run();

    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });

    // **元の履歴が残る**（1 行）うえに、**消したことが 1 行積まれる**（合計 2 行）。
    const { results } = await env.DB.prepare(
      'select old_display_name, new_display_name from display_name_changes where user_id = ? order by changed_at',
    )
      .bind(id)
      .all<{ old_display_name: string; new_display_name: string }>();
    expect(results).toEqual([
      { old_display_name: '前の名前', new_display_name: '本名っぽい表示名' },
      { old_display_name: '本名っぽい表示名', new_display_name: WITHDRAWN_DISPLAY_NAME },
    ]);
    // プロフィールとアイコンも同じ扱い。
    expect(await countFor('profile_changes', id)).toBe(1);
    expect(await countFor('avatar_changes', id)).toBe(1);
    const avatar = await env.DB.prepare(
      'select old_sha256, new_sha256, history_key from avatar_changes where user_id = ?',
    )
      .bind(id)
      .first<{ old_sha256: string; new_sha256: string | null; history_key: string | null }>();
    // **`history_key` は NULL**（写しは段2 で消してあり、指す先が無い）。
    expect(avatar).toEqual({ old_sha256: 'd'.repeat(64), new_sha256: null, history_key: null });
  });

  it('自分の作品への通報があれば残る', async () => {
    const { id } = await seedUser();
    const reporter = await seedUser();
    const gameId = await seedGame(id, { status: 'published' });
    await env.DB.prepare(
      "insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, '通報', 200)",
    )
      .bind(crypto.randomUUID(), gameId, reporter.id)
      .run();
    await env.DB.prepare(
      `insert into handle_changes (id, user_id, old_handle, new_handle, changed_at)
       values (?, ?, null, 'kept', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();

    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });
    expect(await countFor('handle_changes', id)).toBe(1);
  });

  it('自分の作品への削除依頼があれば残る', async () => {
    const { id } = await seedUser();
    const gameId = await seedGame(id, { status: 'published' });
    await env.DB.prepare(
      `insert into takedown_requests (id, game_id, claimant_name, claimant_contact, body, received_at)
       values (?, ?, '権利者', 'mail@example.com', '本文', 200)`,
    )
      .bind(crypto.randomUUID(), gameId)
      .run();
    await env.DB.prepare(
      `insert into handle_changes (id, user_id, old_handle, new_handle, changed_at)
       values (?, ?, null, 'kept2', 200)`,
    )
      .bind(crypto.randomUUID(), id)
      .run();

    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });
    expect(await countFor('handle_changes', id)).toBe(1);
  });
});

describe('断る条件（何も書き換えない）', () => {
  /**
   * 断られたときに `users` の行が 1 列も変わっていないことを確かめる。
   *
   * @param userId 利用者
   * @param reason 期待する理由
   * @param now 時刻
   */
  async function expectRejected(userId: string, reason: string, now = NOW): Promise<void> {
    const before = await readUser(userId);
    expect(await withdrawUser(env, userId, now)).toEqual({ ok: false, reason });
    expect(await readUser(userId)).toEqual(before);
  }

  it('居ない利用者', async () => {
    expect(await withdrawUser(env, 'no-such-user', NOW)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('BAN されている', async () => {
    const { id } = await seedUser({ bannedAt: 500 });
    await expectRejected(id, 'banned');
  });

  it('管理者', async () => {
    const { id } = await seedUser({ isAdmin: true });
    await expectRejected(id, 'admin');
  });

  it('生成中の作品がある（区切りを過ぎていても断る）', async () => {
    const { id } = await seedUser();
    await seedGame(id, { generationState: 'running' });
    // **経過時間で区切らない**——`created_at` は 100 で、区切り（15 分）をはるかに過ぎている。
    await expectRejected(id, 'generating');
  });

  it('リフォージ中の作品がある', async () => {
    const { id } = await seedUser();
    const gameId = await seedGame(id);
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       values (?, 'h', 'p', 'running', null, 100, 100)`,
    )
      .bind(gameId)
      .run();
    await expectRejected(id, 'generating');
  });

  it('アイコンを保存中（排他が生きている）', async () => {
    const { id } = await seedUser({ avatarLockAt: NOW - 1 });
    await expectRejected(id, 'avatar-saving');
  });

  it('切れた排他は退会を止めない', async () => {
    const { id } = await seedUser({ avatarLockAt: NOW - AVATAR_LOCK_SECONDS - 1 });
    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });
  });
});

describe('打ち直し', () => {
  it('掴んだあとで生成が止まったままでも、打ち直せば確定する', async () => {
    const { id } = await seedUser();
    // **掴む前に仕込む。** 掴んだ後だと `0045` のトリガが挿入を飛ばし、1 行も入らないまま
    // 「打ち直しの経路」を通ったつもりになる（PR #588 の Copilot の指摘）。
    const running = await seedGame(id, { generationState: 'running' });
    const seeded = await env.DB.prepare("select generation_state from games where id = ?")
      .bind(running)
      .first<{ generation_state: string }>();
    expect(seeded?.generation_state).toBe('running');

    // 掴んだ状態を作る（段1 だけが済んだところで落ちた）。
    await env.DB.prepare(
      'update users set withdrawal_started_at = ?, avatar_lock_token = null, avatar_lock_at = null where id = ?',
    )
      .bind(NOW, id)
      .run();

    expect(await withdrawUser(env, id, NOW + 700)).toEqual({ ok: true, result: WITHDRAWN });
    const row = await readUser(id);
    // **掴んだ時刻は最初のまま**（`coalesce`）。
    expect(row?.withdrawal_started_at).toBe(NOW);
    expect(row?.withdrawn_at).toBe(NOW + 700);
  });

  it('段2 だけが済んだ状態から打ち直しても、アイコンを消し直して確定する', async () => {
    const { id } = await seedUser({ avatarSha256: 'e'.repeat(64) });
    await env.BUCKET.put(avatarObjectKey(id), 'current');

    expect(await withdrawUser(env, id, NOW)).toEqual({ ok: true, result: WITHDRAWN });
    expect(await env.BUCKET.head(avatarObjectKey(id))).toBeNull();
  });
});

describe('退会を始めた利用者のアイコンは、誰にも書けない（0045 のトリガ / PR #588）', () => {
  it('退会の掴みは、接頭辞つきの token で排他を取る', async () => {
    const { id } = await seedUser();
    // 掴んだところで止まった状態を作るために、段2 で落ちる R2 を渡す。
    const brokenBucket = new Proxy(env.BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') {
          return async (): Promise<void> => {
            throw new Error('R2 が落ちました');
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(withdrawUser({ DB: env.DB, BUCKET: brokenBucket }, id, NOW)).rejects.toThrow();

    const row = await env.DB.prepare('select avatar_lock_token from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string }>();
    expect(row?.avatar_lock_token?.startsWith(WITHDRAWAL_LOCK_TOKEN_PREFIX)).toBe(true);
  });

  it('退会を始めた利用者は、アイコンの排他を取れない（保存が始まらない）', async () => {
    const { id } = await seedUser();
    // 退会していないうちは取れる。
    const before = await acquireAvatarLock(env.DB, id, NOW);
    expect(before.ok).toBe(true);
    await env.DB.prepare('update users set avatar_lock_token = null, avatar_lock_at = null where id = ?')
      .bind(id)
      .run();

    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?').bind(NOW, id).run();

    // **取れない**（トリガが UPDATE を飛ばすので 0 行）。`acquireAvatarLock` は理由を読み直し、
    // 排他が無いので「間隔」として断る——**どちらにせよ R2 を 1 バイトも触らない。**
    const after = await acquireAvatarLock(env.DB, id, NOW + 10_000);
    expect(after.ok).toBe(false);
    const row = await env.DB.prepare('select avatar_lock_token from users where id = ?')
      .bind(id)
      .first<{ avatar_lock_token: string | null }>();
    expect(row?.avatar_lock_token).toBeNull();
  });

  it('退会を始めた利用者に、アイコンを持たせられない（外す向きは通る）', async () => {
    const { id } = await seedUser({ avatarSha256: 'f'.repeat(64) });
    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?').bind(NOW, id).run();

    await env.DB.prepare('update users set avatar_sha256 = ? where id = ?')
      .bind('0'.repeat(64), id)
      .run();
    const blocked = await env.DB.prepare('select avatar_sha256 from users where id = ?')
      .bind(id)
      .first<{ avatar_sha256: string }>();
    expect(blocked?.avatar_sha256).toBe('f'.repeat(64));

    // **NULL にする向きは止めない**（退会そのものがこれを打つ）。
    await env.DB.prepare('update users set avatar_sha256 = null where id = ?').bind(id).run();
    const cleared = await env.DB.prepare('select avatar_sha256 from users where id = ?')
      .bind(id)
      .first<{ avatar_sha256: string | null }>();
    expect(cleared?.avatar_sha256).toBeNull();
  });

  it('消している途中で排他を失ったら、そこで止めて確定しない', async () => {
    const { id } = await seedUser({ avatarSha256: '1'.repeat(64) });
    await env.BUCKET.put(avatarObjectKey(id), 'current');
    await env.BUCKET.put(avatarHistoryKey(id, 150, '2'.repeat(64), 'op-1'), 'old-1');

    // **現行を消した直後に、並行した打ち直しが排他を取り直した**状態を作る。
    //
    // **他人（アイコンの保存）はもう取れない**——`0045` の `users_skip_avatar_lock_for_withdrawal`
    // が、退会を始めた利用者に対する `withdrawal:` 以外の token の UPDATE を飛ばす。
    // **残るのは、同じ退会の 2 本目が入り直す場合だけ**（段1 は `coalesce` で入り直せる）で、
    // そのときに 1 本目が消し続けると、2 本目が確定した後の R2 を消しに行くことになる。
    let deletes = 0;
    const racingBucket = new Proxy(env.BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') {
          return async (keys: string | string[]): Promise<void> => {
            deletes += 1;
            await target.delete(keys);
            if (deletes === 1) {
              await env.DB.prepare('update users set avatar_lock_token = ? where id = ?')
                .bind(`${WITHDRAWAL_LOCK_TOKEN_PREFIX}another-attempt`, id)
                .run();
            }
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const outcome = await withdrawUser({ DB: env.DB, BUCKET: racingBucket }, id, NOW);
    // **確定していない**（段3 の G が当たらない）。
    expect(outcome.ok).toBe(false);
    const row = await readUser(id);
    expect(row?.withdrawn_at).toBeNull();
    // **写しは消していない**（2 回目の delete へ進む前に止めた）。
    const listed = await env.BUCKET.list({ prefix: avatarHistoryPrefixOf(id) });
    expect(listed.objects).toHaveLength(1);
  });
});
