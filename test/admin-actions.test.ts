import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_TARGET_KINDS,
  ADMIN_LIST_LIMIT,
  ADMIN_REASON_MAX_LENGTH,
  listAdminActions,
  oppositeReviewState,
  setReviewState,
  setUserBan,
  validateReason,
} from '../src/admin/actions.js';
import { PUBLISHED_STATUS, listPublishedGames } from '../src/games.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import { applySchema } from './helpers/schema.js';

/**
 * 運営の操作と履歴（`admin_actions`。仕様 2.4.3 / 2.4.4 / #361。M10-3）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * この検査群が守っている 4 つの不変条件
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   1. **操作すると履歴が 1 行増える**（履歴の無い操作を作らない）
 *   2. **履歴の追記に失敗したら操作も入らない**（1 つの batch。**巻き戻る**）
 *   3. **理由が空の操作を受け付けない**（口と表の両方で。2.4.4）
 *   4. **`queued` ↔ `cleared` と BAN は往復できる**（2.4.3 の「戻せる操作だけ」）
 *
 * **2 は「操作したことにして履歴だけ落とす」形を塞ぐ。** これが破れると、記録に穴が
 * 開いても**記録を読んでも分からない**（穴は「書かれていない行」として現れる）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BAN は露出を止めない（7.3 / #330）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **BAN した人の作品が公開一覧から消えないことを、実際に一覧を引いて確かめる。**
 * 記述で守ると、`listPublishedGames` に `banned_at is null` を足した日に**誰も
 * 気づかない**（作品が減るだけで、エラーは 1 つも出ない）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 綴りの一覧は書き写さない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `migrations/0026_admin_actions.sql` の CHECK と `src/admin/actions.ts` の定数は
 * **同じ 4 つ（と 2 つ）でなければならない。** ここでは**マイグレーションの SQL から
 * 取り出して突き合わせる**（`.ai-playbook/shared-ai-rules.md` 12 章。
 * `test/schema-admin.test.ts` が 0025 の ALTER を取り出しているのと同じ形）。
 */

/** 仕込む利用者（管理者・作者・BAN の対象）。 */
const users = { admin: '', author: '', target: '' };

/**
 * `users` を 1 行入れる。
 *
 * @param label 名前の目印
 * @returns 利用者の id
 */
async function insertUser(label: string): Promise<string> {
  const id = `${label}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, label, Math.floor(Date.now() / 1000))
    .run();
  return id;
}

/**
 * 公開済みの作品を 1 本入れる。
 *
 * @param authorId 作者
 * @param reviewState 審査状態
 * @returns 作品の id
 */
async function insertGame(authorId: string, reviewState: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', 1, 0, 0, 'ready', ?)`,
  )
    .bind(id, authorId, PUBLISHED_STATUS, '審査の対象', reviewState)
    .run();
  return id;
}

/**
 * 作品の審査状態を読む。
 *
 * @param gameId 作品の id
 * @returns 審査状態
 */
async function reviewStateOf(gameId: string): Promise<string | null> {
  const row = await env.DB.prepare('select review_state from games where id = ?')
    .bind(gameId)
    .first<{ review_state: string | null }>();
  return row?.review_state ?? null;
}

/**
 * BAN の時刻を読む。
 *
 * @param userId 利用者の id
 * @returns `banned_at`
 */
async function bannedAtOf(userId: string): Promise<number | null> {
  const row = await env.DB.prepare('select banned_at from users where id = ?')
    .bind(userId)
    .first<{ banned_at: number | null }>();
  return row?.banned_at ?? null;
}

/**
 * 履歴の行数を数える。
 *
 * @returns 行数
 */
async function historyCount(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from admin_actions').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applySchema();
  users.admin = await insertUser('admin');
  users.author = await insertUser('author');
  users.target = await insertUser('target');
  await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(users.admin).run();
});

beforeEach(async () => {
  // **各検査を「履歴が何行増えたか」で見る**ので、毎回空にしてから始める。
  // **アプリはこの delete を持たない**（追記のみ。`src/admin/actions.ts`）——
  // 消せるのは D1 の資格情報を持つ側だけで、それがこの機構の限界そのものである
  // （`migrations/0026_admin_actions.sql` の「保証できるのは画面と口までである」）。
  await env.DB.prepare('delete from admin_actions').run();
  await env.DB.prepare('update users set banned_at = null where id = ?').bind(users.target).run();
});

describe('0026 の形（仕様 2.4.4）', () => {
  /** `pragma table_info` の 1 行。 */
  interface ColumnInfo {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
  }

  it('admin_actions に 7 列あり、id 以外はすべて NOT NULL である', async () => {
    // **NULL を許す列を置かない。** 「誰が」「いつ」「何を」「何に」「なぜ」の
    // どれが欠けても、記録として使えない（2.4.4 が理由を必須にしたのと同じ理由）。
    //
    // **`id` だけは `notnull` が 0 と出る。** SQLite の `TEXT PRIMARY KEY` は歴史的な
    // 経緯で NULL を許すためで、**0001 以来すべての表が同じ形**である（`users` /
    // `games` / `takedown_requests`）。ここだけ `NOT NULL` を足して形を変えない
    // ——値は `crypto.randomUUID()` が必ず入れる（`src/admin/actions.ts`）。
    const columns = await env.DB.prepare('pragma table_info(admin_actions)').all<ColumnInfo>();
    const byName = new Map(columns.results.map((row) => [row.name, row]));
    for (const name of ['actor_id', 'created_at', 'action', 'target_kind', 'target_id', 'reason']) {
      expect(byName.get(name), `admin_actions.${name}`).toBeDefined();
      expect(byName.get(name)!.notnull, `admin_actions.${name} の NOT NULL`).toBe(1);
    }
    expect(byName.get('id')?.pk, 'admin_actions.id が主キーではない').toBe(1);
    expect(byName.get('created_at')!.type).toBe('INTEGER');
  });

  it('CHECK の綴りが src/admin/actions.ts の定数と一致する（写しを腐らせない）', () => {
    // **マイグレーションの SQL から取り出して突き合わせる。** 期待値をここへ書き並べると、
    // **同じ写しが 3 つ目に増える**だけで、ずれは捕まらない。
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0026_'));
    expect(migration, '0026 のマイグレーション').toBeDefined();
    const sql = migration!.queries.join('\n');

    /**
     * `<column> IN ('a', 'b')` の綴りを取り出す。
     *
     * @param column 列名
     * @returns 綴りの配列（出現順）
     */
    const valuesOf = (column: string): string[] => {
      const matched = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 'iu').exec(sql);
      expect(matched, `0026 に ${column} の CHECK が無い`).not.toBeNull();
      return [...matched![1]!.matchAll(/'([^']+)'/gu)].map((hit) => hit[1]!);
    };

    expect(valuesOf('action').sort()).toEqual([...ADMIN_ACTIONS].sort());
    expect(valuesOf('target_kind').sort()).toEqual([...ADMIN_ACTION_TARGET_KINDS].sort());
  });

  it('取り下げ（removed）の綴りが無く、書こうとしても入らない（2.4.3）', async () => {
    // **戻せない操作を画面に置かないという決定を、表の側でも守る。**
    expect([...ADMIN_ACTIONS]).not.toContain('game-removed');
    await expect(
      env.DB.prepare(
        `insert into admin_actions
           (id, actor_id, created_at, action, target_kind, target_id, reason)
         values (?, ?, 1, 'game-removed', 'game', 'g', '理由')`,
      )
        .bind(crypto.randomUUID(), users.admin)
        .run(),
    ).rejects.toThrow();
  });

  it('理由が空の行は表の側でも入らない（口と表の両方で守る。2.4.4）', async () => {
    await expect(
      env.DB.prepare(
        `insert into admin_actions
           (id, actor_id, created_at, action, target_kind, target_id, reason)
         values (?, ?, 1, 'user-banned', 'user', ?, '   ')`,
      )
        .bind(crypto.randomUUID(), users.admin, users.target)
        .run(),
    ).rejects.toThrow();
  });
});

describe('理由の検査（2.4.4。理由が空の操作を受け付けない）', () => {
  it('空・空白だけ・全角空白だけを断る', () => {
    for (const raw of ['', '   ', '\n', '　']) {
      const result = validateReason(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      expect(result.ok ? '' : result.reason).toBe('reason-empty');
    }
  });

  it('前後の空白を落として保存する形を返す', () => {
    const result = validateReason('  通報を確認した  ');
    expect(result).toEqual({ ok: true, value: '通報を確認した' });
  });

  it('長すぎる理由を断る（コードポイントで数える）', () => {
    // **サロゲート対を 1 と数える。** `String#length` で数えると、絵文字を含む理由が
    // 上限の半分で断られる（`src/account.ts` と同じ規律）。
    const justFit = '🙂'.repeat(ADMIN_REASON_MAX_LENGTH);
    expect(validateReason(justFit).ok).toBe(true);
    const tooLong = '🙂'.repeat(ADMIN_REASON_MAX_LENGTH + 1);
    expect(validateReason(tooLong)).toEqual({ ok: false, reason: 'reason-too-long' });
  });
});

describe('操作と履歴が 1 つの batch で入る（2.4.4）', () => {
  it('審査状態を切り替えると履歴が 1 行増える', async () => {
    const gameId = await insertGame(users.author, REVIEW_QUEUED);
    const before = await historyCount();

    const outcome = await setReviewState(env, {
      gameId,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: '通報を見たが問題なし',
      now: 1_700_000_000,
    });

    expect(outcome).toEqual({ ok: true, changed: true });
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);
    expect(await historyCount()).toBe(before + 1);

    const [entry] = await listAdminActions(env);
    expect(entry).toMatchObject({
      actorId: users.admin,
      action: 'review-cleared',
      targetKind: 'game',
      targetId: gameId,
      reason: '通報を見たが問題なし',
      createdAt: 1_700_000_000,
    });
    // **実行者の名前は結合して取る**（履歴の画面がそれを出す）。
    expect(entry!.actorName).toBe('admin');
  });

  it('BAN を付けると履歴が 1 行増える', async () => {
    const before = await historyCount();
    const outcome = await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '規約違反の通報を確認した',
      now: 1_700_000_100,
    });

    expect(outcome).toEqual({ ok: true, changed: true });
    expect(await bannedAtOf(users.target)).toBe(1_700_000_100);
    expect(await historyCount()).toBe(before + 1);
    expect((await listAdminActions(env))[0]).toMatchObject({
      action: 'user-banned',
      targetKind: 'user',
      targetId: users.target,
    });
  });

  it('履歴の追記が失敗したら操作も入らない（1 つの batch で巻き戻る）', async () => {
    // **`admin_actions` の CHECK を落として確かめる。** 理由の検査は口の側
    // （`validateReason`）にあるので、**書き込みの関数を直接叩くとここまで届く**
    // （`src/admin/actions.ts` の `runWithHistory` が、なぜ理由を再検査しないかを
    // 書いている）。**2 回に分けて書く実装へ戻すと、この検査が赤くなる。**
    const gameId = await insertGame(users.author, REVIEW_QUEUED);
    const before = await historyCount();

    const outcome = await setReviewState(env, {
      gameId,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: '',
      now: 1_700_000_200,
    });

    expect(outcome).toEqual({ ok: false, reason: 'write-failed' });
    // **操作が入っていない。** ここが `cleared` なら、履歴の無い操作が本番で起こりうる。
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);
    expect(await historyCount()).toBe(before);
  });

  it('BAN でも同じように巻き戻る', async () => {
    const before = await historyCount();
    const outcome = await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '   ',
      now: 1_700_000_300,
    });

    expect(outcome).toEqual({ ok: false, reason: 'write-failed' });
    expect(await bannedAtOf(users.target)).toBeNull();
    expect(await historyCount()).toBe(before);
  });

  it('対象が無い操作は、状態も履歴も 1 行も残さない', async () => {
    // **逆向き（操作していないのに履歴が残る）も塞ぐ**（`src/admin/actions.ts` の
    // 「逆向きも塞ぐ」）。id の打ち間違いで記録だけが積まれると、**履歴が実際の
    // 出来事と食い違う。**
    const before = await historyCount();
    const outcome = await setReviewState(env, {
      gameId: 'no-such-game',
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: '打ち間違い',
    });

    expect(outcome).toEqual({ ok: false, reason: 'not-applicable' });
    expect(await historyCount()).toBe(before);
  });

  it('まだ審査していない作品（review_state が NULL）は対象にならない', async () => {
    // 8.4 は「閾値到達で審査キューへ投入」と定めており、**投入するのは通報の側である。**
    const gameId = await insertGame(users.author, null);
    const outcome = await setReviewState(env, {
      gameId,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: 'キューに無いものを触ろうとした',
    });

    expect(outcome).toEqual({ ok: false, reason: 'not-applicable' });
    expect(await reviewStateOf(gameId)).toBeNull();
    expect(await historyCount()).toBe(0);
  });

  it('既にその状態なら、状態は動かないが操作は履歴に残る', async () => {
    // **`changed: false` は失敗ではない**（`src/admin/actions.ts` の「代わりに
    // 引き受けたこと」）。運営は確かにその操作を行っており、2.4.4 は「取り消しも
    // 1 行として積む」と定めている。
    const gameId = await insertGame(users.author, REVIEW_CLEARED);
    const outcome = await setReviewState(env, {
      gameId,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: '二重に押した',
    });

    expect(outcome).toEqual({ ok: true, changed: false });
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);
    expect(await historyCount()).toBe(1);
  });
});

describe('戻せる操作だけを置く（2.4.3。往復を変異で確かめる）', () => {
  it('queued ↔ cleared が往復でき、履歴が 2 行積まれる', async () => {
    const gameId = await insertGame(users.author, REVIEW_QUEUED);

    const toCleared = await setReviewState(env, {
      gameId,
      from: REVIEW_QUEUED,
      to: REVIEW_CLEARED,
      actorId: users.admin,
      reason: '見たが問題なし',
      now: 1_700_001_000,
    });
    expect(toCleared).toEqual({ ok: true, changed: true });
    expect(await reviewStateOf(gameId)).toBe(REVIEW_CLEARED);

    const backToQueued = await setReviewState(env, {
      gameId,
      from: REVIEW_CLEARED,
      to: REVIEW_QUEUED,
      actorId: users.admin,
      reason: '追加の通報があったので見直す',
      now: 1_700_001_001,
    });
    expect(backToQueued).toEqual({ ok: true, changed: true });
    // **元の値へ戻っている**（記述ではなく、実際の列の値で見る）。
    expect(await reviewStateOf(gameId)).toBe(REVIEW_QUEUED);

    // **取り消しも 1 行として積む**（前の行を書き換えない。2.4.4）。
    const entries = await listAdminActions(env);
    expect(entries.map((entry) => entry.action)).toEqual(['review-queued', 'review-cleared']);
  });

  it('BAN と解除が往復でき、履歴が 2 行積まれる', async () => {
    const banned = await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '費用 DoS の疑い',
      now: 1_700_002_000,
    });
    expect(banned).toEqual({ ok: true, changed: true });
    expect(await bannedAtOf(users.target)).toBe(1_700_002_000);

    const lifted = await setUserBan(env, {
      userId: users.target,
      banned: false,
      actorId: users.admin,
      reason: '誤認だった',
      now: 1_700_002_001,
    });
    expect(lifted).toEqual({ ok: true, changed: true });
    // **NULL へ戻る**（0001 が「行を消さない」と書いているとおり、行はそのままである）。
    expect(await bannedAtOf(users.target)).toBeNull();

    const entries = await listAdminActions(env);
    expect(entries.map((entry) => entry.action)).toEqual(['user-unbanned', 'user-banned']);
  });

  it('往復の相手を取り違えない（oppositeReviewState）', () => {
    expect(oppositeReviewState(REVIEW_QUEUED)).toBe(REVIEW_CLEARED);
    expect(oppositeReviewState(REVIEW_CLEARED)).toBe(REVIEW_QUEUED);
  });
});

describe('BAN は露出を止めない（7.3 / #330 の決定）', () => {
  it('BAN 済みの利用者の作品が、公開一覧から消えない', async () => {
    // **実際に一覧を引く。** `listPublishedGames` に `banned_at is null` を足した日に
    // 赤くなる——**作品が減るだけで、エラーは 1 つも出ない**ので、動作では気づけない。
    const gameId = await insertGame(users.target, null);
    const before = await listPublishedGames(env, 'recent', ADMIN_LIST_LIMIT);
    expect(before.map((work) => work.id)).toContain(gameId);

    const outcome = await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '露出は止めないことの確認',
    });
    expect(outcome).toEqual({ ok: true, changed: true });

    const after = await listPublishedGames(env, 'recent', ADMIN_LIST_LIMIT);
    expect(after.map((work) => work.id), 'BAN で作品が一覧から消えた').toContain(gameId);
  });

  it('BAN は作品の審査状態にも公開状態にも触れない', async () => {
    const gameId = await insertGame(users.target, REVIEW_QUEUED);
    await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '列を触っていないことの確認',
    });

    const row = await env.DB.prepare('select status, review_state from games where id = ?')
      .bind(gameId)
      .first<{ status: string; review_state: string | null }>();
    expect(row).toEqual({ status: PUBLISHED_STATUS, review_state: REVIEW_QUEUED });
  });
});

describe('履歴の読み取り（2.4.4）', () => {
  it('新しい順に、固定件数までしか返さない（2.3.3 の条件 1 と同じ考え方）', async () => {
    // **母数が増えても読み取りが増えない**ことを、上限より多く積んで確かめる。
    const rows = ADMIN_LIST_LIMIT + 3;
    const statements = [];
    for (let index = 0; index < rows; index += 1) {
      statements.push(
        env.DB.prepare(
          `insert into admin_actions
             (id, actor_id, created_at, action, target_kind, target_id, reason)
           values (?, ?, ?, 'user-banned', 'user', ?, ?)`,
        ).bind(crypto.randomUUID(), users.admin, 1_700_100_000 + index, users.target, `理由 ${index}`),
      );
    }
    await env.DB.batch(statements);

    const entries = await listAdminActions(env);
    expect(entries.length).toBe(ADMIN_LIST_LIMIT);
    // **いちばん新しいものが先頭である。**
    expect(entries[0]!.reason).toBe(`理由 ${rows - 1}`);
  });

  it('同じ秒に積んだ 2 行は、押した順の逆で返る（id では並べない）', async () => {
    // **`id` は `crypto.randomUUID()` なので、押した順と無関係に並ぶ。** BAN の直後に
    // 解除を押すと、履歴では解除が先に見えることがあった（`src/admin/actions.ts` の
    // `listAdminActions`）。**`rowid`（insert の順）で並べていることの確認である。**
    await setUserBan(env, {
      userId: users.target,
      banned: true,
      actorId: users.admin,
      reason: '先に押した',
      now: 1_700_200_000,
    });
    await setUserBan(env, {
      userId: users.target,
      banned: false,
      actorId: users.admin,
      reason: '同じ秒に押した',
      now: 1_700_200_000,
    });

    expect((await listAdminActions(env)).map((entry) => entry.reason)).toEqual([
      '同じ秒に押した',
      '先に押した',
    ]);
  });
});
