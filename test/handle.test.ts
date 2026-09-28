import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../src/admin/routes.js';
import { appReservedHandles, createAppRoutes } from '../src/app.js';
import {
  HANDLE_CHANGES_TABLE,
  HANDLE_RENAME_INTERVAL_SECONDS,
  HANDLE_RESERVATION_SECONDS,
  HAND_WRITTEN_RESERVED_HANDLES,
  changeHandle,
  currentHandleOf,
  reservedHandlesOf,
  validateHandle,
} from '../src/handle.js';
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from '../src/handle-paths.js';
import type { Route } from '../src/routes.js';
import { json } from '../src/routes.js';
import { SANDBOX_PATH_PREFIXES } from '../src/sandbox.js';
import { applySchema } from './helpers/schema.js';

/**
 * ハンドル名の検査・予約語・保存（#381 / M12-13 / 仕様 5.10）。
 *
 * **#381 の acceptance のうち、ここが持つもの。**
 *
 * 1. **予約語がハンドル名にできない。予約語の一覧が経路表から導かれている**（経路を 1 本足すと予約語に入る）
 * 2. **大文字小文字違いで衝突する**
 * 3. **改名後に他人が旧ハンドルをすぐ取れない**（**変異で確認**——`src/handle.ts` の `changeHandle` の
 *    「期限の切れた予約を消す」条件を「予約を誰でも消せる」へ緩めると、下の「90 日以内は取れない」が赤くなる）
 *
 * `/users/<id>` → `/@handle` のリダイレクトは `test/users-page.test.ts`、画面は `test/account-handle.test.ts`、
 * 表の形は `test/schema-handles.test.ts` が見る。
 */

beforeAll(async () => {
  await applySchema();
});

/** 固定の時刻（UNIX 秒）。30 日・90 日の境界をこれを起点に動かす。 */
const NOW = 1_900_000_000;

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `handle-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, 'ハンドル検査')
    .run();
  return id;
}

/**
 * テストファイルをまたいで衝突しないハンドル名を 1 つ作る（小文字の英数字）。
 *
 * @param prefix 先頭の語（読みやすさのため）
 * @returns ハンドル名
 */
function uniqueHandle(prefix = 'h'): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 利用者の履歴の行数を数える。
 *
 * @param userId 利用者の id
 * @returns 行数
 */
async function historyCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${HANDLE_CHANGES_TABLE} where user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 利用者の `handles` の行を並べる（ハンドル名の順）。
 *
 * @param userId 利用者の id
 * @returns 行
 */
async function handleRows(
  userId: string,
): Promise<{ handle: string; claimed_at: number; released_at: number | null }[]> {
  const rows = await env.DB.prepare(
    'select handle, claimed_at, released_at from handles where user_id = ? order by handle',
  )
    .bind(userId)
    .all<{ handle: string; claimed_at: number; released_at: number | null }>();
  return rows.results;
}

describe('ハンドル名の形（5.10）', () => {
  const none: ReadonlySet<string> = new Set();

  it('小文字にして保存する（大文字小文字違いは同じハンドル名）', () => {
    expect(validateHandle('Foo_Bar9', none)).toEqual({ ok: true, value: 'foo_bar9' });
    expect(validateHandle('  @Foo  ', none)).toEqual({ ok: true, value: 'foo' });
  });

  it('長さは 3〜20 文字', () => {
    expect(validateHandle('ab', none)).toEqual({ ok: false, reason: 'handle-length' });
    expect(validateHandle('abc', none).ok).toBe(true);
    expect(validateHandle('a'.repeat(HANDLE_MAX_LENGTH), none).ok).toBe(true);
    expect(validateHandle('a'.repeat(HANDLE_MAX_LENGTH + 1), none)).toEqual({ ok: false, reason: 'handle-length' });
    expect(validateHandle('   ', none)).toEqual({ ok: false, reason: 'handle-empty' });
    expect(validateHandle('@', none)).toEqual({ ok: false, reason: 'handle-empty' });
  });

  it('紛らわしい文字（全角・ゼロ幅・向きを変える書式文字・記号）を弾く', () => {
    for (const raw of [
      'ｆｏｏ', // 全角英字
      'foo\u200bbar', // ゼロ幅空白
      'foo\u200dbar', // ゼロ幅接合子
      'foo\u202ebar', // RLO
      'foo\u061cbar', // ALM
      'foo-bar',
      'foo.bar',
      'foo bar',
      'fоo', // キリル文字の о
      'ハンドル',
      '@@foo',
    ]) {
      expect(validateHandle(raw, none), JSON.stringify(raw)).toEqual({ ok: false, reason: 'handle-invalid' });
    }
  });

  it('小文字にすると ASCII になる文字（ケルビン記号・トルコ語の \u0130）を、小文字にする前に弾く', () => {
    // **`'\u212a'.toLowerCase()` は ASCII の `k` になる。** 小文字にしてから許可リストで見る実装は、これを通す。
    expect('\u212aey'.toLowerCase()).toBe('key');
    expect(validateHandle('\u212aey', none)).toEqual({ ok: false, reason: 'handle-invalid' });
    expect(validateHandle('\u0130stanbul', none)).toEqual({ ok: false, reason: 'handle-invalid' });
  });

  it('通した値は保存の形（HANDLE_PATTERN）を必ず満たす', () => {
    for (const raw of ['Foo', 'a_b_c', '123', 'ABCDEFGHIJKLMNOPQRST']) {
      const result = validateHandle(raw, none);
      expect(result.ok, raw).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(HANDLE_PATTERN);
      }
    }
  });
});

describe('予約語は経路表から導く（#381 の acceptance 1）', () => {
  /** 予約語の出どころを、経路を差し替えられる形で組む。 */
  function sources(appRoutes: readonly Route[]): Parameters<typeof reservedHandlesOf>[0] {
    return {
      appRoutes,
      adminRoutes: createAdminRoutes(),
      sandboxPrefixes: SANDBOX_PATH_PREFIXES,
      hosts: [env.APP_HOST, env.SANDBOX_HOST, env.ADMIN_HOST],
    };
  }

  it('経路を 1 本足すと、その第 1 セグメントが予約語に入る（手書きでない）', () => {
    const base = createAppRoutes(env);
    const word = 'ranking';
    expect(reservedHandlesOf(sources(base)).has(word)).toBe(false);
    const added: readonly Route[] = [...base, { method: 'GET', path: `/${word}/weekly`, handler: () => json({}) }];
    expect(reservedHandlesOf(sources(added)).has(word)).toBe(true);
    // **足した経路で、実際にハンドル名が断られる。**
    expect(validateHandle('Ranking', reservedHandlesOf(sources(added)))).toEqual({
      ok: false,
      reason: 'handle-reserved',
    });
  });

  it('アプリ・管理画面の経路の第 1 セグメント、sandbox の接頭辞、ホストのラベルがすべて入っている', () => {
    const reserved = appReservedHandles(env);
    // **開発用の経路も含める**（環境で予約語を変えない。`__dev` は `/__dev/` から）。
    const appRoutes = createAppRoutes({ ...env, DEV_ROUTES: 'enabled' });
    for (const route of [...appRoutes, ...createAdminRoutes()]) {
      const segment = route.path.split('/')[1]?.toLowerCase() ?? '';
      if (segment !== '') {
        expect(reserved.has(segment), `${route.method} ${route.path}`).toBe(true);
      }
    }
    for (const prefix of SANDBOX_PATH_PREFIXES) {
      expect(reserved.has(prefix.split('/')[1]!), prefix).toBe(true);
    }
    expect(reserved.has('__dev')).toBe(true);
    expect(reserved.has('avatars')).toBe(true);
    expect(reserved.has('sandbox')).toBe(true);
    // 管理画面の経路（`/actions`）はアプリの経路表に無いが、予約語に入る。
    expect(reserved.has('actions')).toBe(true);
  });

  it('issue と仕様 5.10 が挙げた語が、すべてハンドル名にできない', () => {
    const reserved = appReservedHandles(env);
    for (const word of [
      'works',
      'users',
      'account',
      'generate',
      'signup',
      'invites',
      'terms',
      'takedown',
      'privacy',
      'faq',
      'api',
      'admin',
    ]) {
      expect(validateHandle(word, reserved), word).toEqual({ ok: false, reason: 'handle-reserved' });
      expect(validateHandle(word.toUpperCase(), reserved), word).toEqual({ ok: false, reason: 'handle-reserved' });
    }
  });

  it('予約語のうちハンドル名の形を満たすものは、すべて断られる', () => {
    const reserved = appReservedHandles(env);
    const shaped = [...reserved].filter((word) => HANDLE_PATTERN.test(word));
    expect(shaped.length).toBeGreaterThan(20);
    for (const word of shaped) {
      expect(validateHandle(word, reserved), word).toEqual({ ok: false, reason: 'handle-reserved' });
    }
  });

  it('手書きの予約語に、経路表から導ける語が混ざっていない（経路でない語だけを手で書く）', () => {
    const fromRoutes = [...createAppRoutes({ ...env, DEV_ROUTES: 'enabled' }), ...createAdminRoutes()]
      .map((route) => route.path.split('/')[1]?.toLowerCase())
      .concat(SANDBOX_PATH_PREFIXES.map((prefix) => prefix.split('/')[1]));
    expect(fromRoutes).toContain('works');
    for (const word of HAND_WRITTEN_RESERVED_HANDLES) {
      expect(fromRoutes, `手書きの「${word}」は経路から導ける`).not.toContain(word);
      expect(word).toMatch(HANDLE_PATTERN);
    }
  });

  it('ホストのラベルは TLD を除いて入る（本番の綴りでも）', () => {
    const reserved = reservedHandlesOf({
      appRoutes: [],
      adminRoutes: [],
      sandboxPrefixes: [],
      hosts: ['app.game-forge.ojos.jp', 'sandbox.game-forge.ojos.jp:443', undefined],
    });
    expect(reserved.has('app')).toBe(true);
    expect(reserved.has('sandbox')).toBe(true);
    expect(reserved.has('ojos')).toBe(true);
    expect(reserved.has('jp')).toBe(false);
  });
});

describe('運営と紛らわしい名前を弾く（#778）', () => {
  /** 経路から導く語を空にした集合。**接頭辞の判定が検査そのものに入っていること**を、導出と切り離して見る。 */
  const none: ReadonlySet<string> = new Set();

  it('運営のハンドル名に寄せた綴りは、経路由来の予約語が空でも断る', () => {
    for (const raw of [
      'gameforgejp', // 区切りを外した綴り
      'gameforgejp', // 運営が持っているもの
      'gameforge_jp', // 運営が改名で手放し、90 日は予約している綴り
      'gameforge2026', // 運営がプロフィールで公開している X のアカウント名
      'gameforge_news',
      'game_forgejp',
      'GameForge_JP', // 小文字にした後に判定する
      '@gameforge_official', // 先頭の @ を外した後に判定する
    ]) {
      expect(validateHandle(raw, none), raw).toEqual({ ok: false, reason: 'handle-reserved' });
    }
  });

  it('接頭辞は先頭でだけ効く（途中に含むだけの名前は通る）', () => {
    expect(validateHandle('mygameforge', none)).toEqual({ ok: true, value: 'mygameforge' });
    expect(validateHandle('i_love_gameforge', none)).toEqual({ ok: true, value: 'i_love_gameforge' });
  });

  it('ロゴの語（forge / anvil）は完全一致で断り、それを含む名前は通す', () => {
    const reserved = appReservedHandles(env);
    for (const word of ['forge', 'anvil', 'FORGE', 'Anvil']) {
      expect(validateHandle(word, reserved), word).toEqual({ ok: false, reason: 'handle-reserved' });
    }
    expect(validateHandle('forge_fan', reserved)).toEqual({ ok: true, value: 'forge_fan' });
    expect(validateHandle('anvil_works', reserved)).toEqual({ ok: true, value: 'anvil_works' });
  });

  it('保存済みのハンドル名は再検査されない（運営の gameforgejp は取り上げられない）', async () => {
    const operator = await seedUser();
    await env.DB.prepare('update users set is_operator = 1 where id = ?').bind(operator).run();
    expect(await changeHandle(env.DB, operator, 'gameforgejp', NOW)).toEqual({ ok: true, changed: true });
    expect(await currentHandleOf(env.DB, operator)).toEqual({ handle: 'gameforgejp', claimedAt: NOW });
    // **印が立っていても、画面から入れ直す経路（`src/account-handle.ts`）は検査を通る。**
    // `is_operator` を見て通す例外は作っていない（`HAND_WRITTEN_RESERVED_PREFIXES` の注記）。
    expect(validateHandle('gameforgejp', appReservedHandles(env))).toEqual({
      ok: false,
      reason: 'handle-reserved',
    });
    const row = await env.DB.prepare('select is_operator from users where id = ?').bind(operator).first();
    expect(row).toEqual({ is_operator: 1 });
  });
});

describe('ハンドル名の保存（5.10）', () => {
  it('初めて決めると、いま使っている行と履歴が 1 行ずつ入る', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('first');
    expect(await changeHandle(env.DB, userId, handle, NOW)).toEqual({ ok: true, changed: true });
    expect(await currentHandleOf(env.DB, userId)).toEqual({ handle, claimedAt: NOW });
    const history = await env.DB.prepare(
      `select old_handle, new_handle, changed_at from ${HANDLE_CHANGES_TABLE} where user_id = ?`,
    )
      .bind(userId)
      .all();
    expect(history.results).toEqual([{ old_handle: null, new_handle: handle, changed_at: NOW }]);
  });

  it('大文字小文字違いのハンドル名は、ほかの人のものと衝突する（#381 の acceptance 2）', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const handle = uniqueHandle('case');
    expect((await changeHandle(env.DB, owner, handle, NOW)).ok).toBe(true);

    const validated = validateHandle(handle.toUpperCase(), new Set());
    expect(validated).toEqual({ ok: true, value: handle });
    if (!validated.ok) {
      return;
    }
    expect(await changeHandle(env.DB, other, validated.value, NOW)).toEqual({ ok: false, reason: 'handle-taken' });
    expect(await currentHandleOf(env.DB, other)).toBeNull();
    expect(await historyCount(other)).toBe(0);
  });

  it('同じハンドル名を 2 人が同時に取りに来ても、片方だけが勝つ（主キー）', async () => {
    const handle = uniqueHandle('race');
    const racers = await Promise.all([seedUser(), seedUser(), seedUser()]);
    const results = await Promise.all(racers.map((userId) => changeHandle(env.DB, userId, handle, NOW)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'handle-taken' },
      { ok: false, reason: 'handle-taken' },
    ]);
    const owners = await env.DB.prepare('select user_id from handles where handle = ?').bind(handle).all();
    expect(owners.results).toHaveLength(1);
    // **負けた側には履歴も「手放す」更新も残らない**（batch ごと巻き戻る）。
    const histories = await Promise.all(racers.map((userId) => historyCount(userId)));
    expect(histories.reduce((sum, n) => sum + n, 0)).toBe(1);
  });

  it('負けた側の旧いハンドル名は手放されない（巻き戻る）', async () => {
    const winner = await seedUser();
    const loser = await seedUser();
    const wanted = uniqueHandle('want');
    const losersOld = uniqueHandle('old');
    expect((await changeHandle(env.DB, loser, losersOld, NOW - HANDLE_RENAME_INTERVAL_SECONDS)).ok).toBe(true);
    expect((await changeHandle(env.DB, winner, wanted, NOW)).ok).toBe(true);

    expect(await changeHandle(env.DB, loser, wanted, NOW)).toEqual({ ok: false, reason: 'handle-taken' });
    expect(await handleRows(loser)).toEqual([
      { handle: losersOld, claimed_at: NOW - HANDLE_RENAME_INTERVAL_SECONDS, released_at: null },
    ]);
    expect(await historyCount(loser)).toBe(1);
  });

  it('改名は 30 日に 1 回まで。断った変更は 1 行も書かない', async () => {
    const userId = await seedUser();
    const first = uniqueHandle('one');
    const second = uniqueHandle('two');
    expect((await changeHandle(env.DB, userId, first, NOW)).ok).toBe(true);

    const justBefore = NOW + HANDLE_RENAME_INTERVAL_SECONDS - 1;
    expect(await changeHandle(env.DB, userId, second, justBefore)).toEqual({
      ok: false,
      reason: 'handle-too-soon',
    });
    expect(await handleRows(userId)).toEqual([{ handle: first, claimed_at: NOW, released_at: null }]);
    expect(await historyCount(userId)).toBe(1);
    // **断られた名前は誰のものにもなっていない。**
    expect(await env.DB.prepare('select 1 from handles where handle = ?').bind(second).first()).toBeNull();

    const onTime = NOW + HANDLE_RENAME_INTERVAL_SECONDS;
    expect(await changeHandle(env.DB, userId, second, onTime)).toEqual({ ok: true, changed: true });
    expect(await currentHandleOf(env.DB, userId)).toEqual({ handle: second, claimedAt: onTime });
    const history = await env.DB.prepare(
      `select old_handle, new_handle from ${HANDLE_CHANGES_TABLE} where user_id = ? order by changed_at`,
    )
      .bind(userId)
      .all();
    expect(history.results).toEqual([
      { old_handle: null, new_handle: first },
      { old_handle: first, new_handle: second },
    ]);
  });

  it('同じハンドル名の入れ直しは、成功として何も書かない', async () => {
    const userId = await seedUser();
    const handle = uniqueHandle('same');
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);
    // 30 日を過ぎていても、同じ名前なら改名として数えない。
    const later = NOW + HANDLE_RENAME_INTERVAL_SECONDS * 2;
    expect(await changeHandle(env.DB, userId, handle, later)).toEqual({ ok: true, changed: false });
    expect(await handleRows(userId)).toEqual([{ handle, claimed_at: NOW, released_at: null }]);
    expect(await historyCount(userId)).toBe(1);
  });
});

describe('旧ハンドルの予約（#381 の acceptance 3。利用者の決定: 90 日＋30 日に 1 回）', () => {
  /**
   * 改名を 1 回済ませた利用者を用意する。
   *
   * @returns 利用者・旧ハンドル・新ハンドル・改名の時刻
   */
  async function renamed(): Promise<{ owner: string; oldHandle: string; newHandle: string; renamedAt: number }> {
    const owner = await seedUser();
    const oldHandle = uniqueHandle('old');
    const newHandle = uniqueHandle('new');
    const renamedAt = NOW + HANDLE_RENAME_INTERVAL_SECONDS;
    expect((await changeHandle(env.DB, owner, oldHandle, NOW)).ok).toBe(true);
    expect((await changeHandle(env.DB, owner, newHandle, renamedAt)).ok).toBe(true);
    return { owner, oldHandle, newHandle, renamedAt };
  }

  it('改名の直後から 90 日のあいだ、ほかの人は旧ハンドルを取れない', async () => {
    const { owner, oldHandle, renamedAt } = await renamed();
    const other = await seedUser();
    for (const at of [renamedAt, renamedAt + 1, renamedAt + HANDLE_RESERVATION_SECONDS - 1]) {
      expect(await changeHandle(env.DB, other, oldHandle, at), `改名の ${at - renamedAt} 秒後`).toEqual({
        ok: false,
        reason: 'handle-taken',
      });
    }
    // 予約の行は持ち主のまま残っている。
    const row = await env.DB.prepare('select user_id, released_at from handles where handle = ?')
      .bind(oldHandle)
      .first();
    expect(row).toEqual({ user_id: owner, released_at: renamedAt });
    expect(await currentHandleOf(env.DB, other)).toBeNull();
    expect(await historyCount(other)).toBe(0);
  });

  it('90 日を過ぎたら、ほかの人が旧ハンドルを取れる（予約の行は消えて持ち主が替わる）', async () => {
    const { owner, oldHandle, newHandle, renamedAt } = await renamed();
    const other = await seedUser();
    const expired = renamedAt + HANDLE_RESERVATION_SECONDS;
    expect(await changeHandle(env.DB, other, oldHandle, expired)).toEqual({ ok: true, changed: true });
    expect(await currentHandleOf(env.DB, other)).toEqual({ handle: oldHandle, claimedAt: expired });
    // 持ち主のいまのハンドル名は動かない。持ち主の予約の行だけが消えた。
    expect(await handleRows(owner)).toEqual([{ handle: newHandle, claimed_at: renamedAt, released_at: null }]);
  });

  it('本人は、予約中の旧ハンドルへ戻れる（戻るのも改名として 30 日の間隔に入る）', async () => {
    const { owner, oldHandle, newHandle, renamedAt } = await renamed();
    // 30 日の間隔の内側では戻れない。
    expect(await changeHandle(env.DB, owner, oldHandle, renamedAt + 1)).toEqual({
      ok: false,
      reason: 'handle-too-soon',
    });
    const back = renamedAt + HANDLE_RENAME_INTERVAL_SECONDS;
    expect(await changeHandle(env.DB, owner, oldHandle, back)).toEqual({ ok: true, changed: true });
    expect(await handleRows(owner)).toEqual(
      [
        { handle: oldHandle, claimed_at: back, released_at: null },
        { handle: newHandle, claimed_at: renamedAt, released_at: back },
      ].sort((a, b) => (a.handle < b.handle ? -1 : 1)),
    );
  });

  it('いま使っているのは利用者ごとに 1 つだけ（改名を重ねても）', async () => {
    const owner = await seedUser();
    let at = NOW;
    for (let i = 0; i < 4; i++) {
      expect((await changeHandle(env.DB, owner, uniqueHandle(`r${i}`), at)).ok).toBe(true);
      at += HANDLE_RENAME_INTERVAL_SECONDS;
    }
    const current = (await handleRows(owner)).filter((row) => row.released_at === null);
    expect(current).toHaveLength(1);
    expect(await historyCount(owner)).toBe(4);
  });
});
