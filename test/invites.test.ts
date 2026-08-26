import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatInviteCode, generateInviteCode } from '../src/invite-code.js';
import {
  checkInvite,
  consumeInvite,
  countIssuedInvites,
  issueInvite,
  listIssuedInvites,
  lookupInvite,
  remainingInviteQuota,
} from '../src/invites.js';
import { applySchema } from './helpers/schema.js';

const NOW = 1_770_000_000;

beforeAll(async () => {
  await applySchema();
});

/**
 * テスト用の利用者を 1 行作る。
 *
 * id と `google_sub` を毎回ランダムにするのは、各テストを自己完結させるため。
 * 固定の接尾辞を配ると、単体実行（`vitest run -t ...`）とファイル全体の実行で
 * 既存行の有無が変わり、`google_sub` の一意制約で落ちる組み合わせが生まれる。
 *
 * @returns 作成した利用者の id
 */
async function insertUser(): Promise<string> {
  const id = `u-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * 招待を 1 行、状態を指定して作る。
 *
 * `issueInvite` は枠の判定を伴い、失効時刻も呼び出し側が決めるため、期限や発行者を
 * 細かく作り分けたいテストはこちらを使う。コードは毎回生成するので、テスト間で
 * 同じ行を取り合うことがない。
 *
 * @param issuedBy 発行者の `users.id`
 * @param expiresAt 失効時刻（UNIX 秒）。無期限なら null
 * @returns 正規形の招待コード
 */
async function insertInvite(issuedBy: string, expiresAt: number | null = null): Promise<string> {
  const code = generateInviteCode();
  await env.DB.prepare('insert into invites (code, issued_by, expires_at) values (?, ?, ?)')
    .bind(code, issuedBy, expiresAt)
    .run();
  return code;
}

/**
 * 招待の行をそのまま読む（実装の写像を通さずに検査するため）。
 *
 * @param code 正規形の招待コード
 * @returns 行、または null
 */
async function rawInvite(
  code: string,
): Promise<{ used_by: string | null; used_at: number | null } | null> {
  return await env.DB.prepare('select used_by, used_at from invites where code = ?')
    .bind(code)
    .first<{ used_by: string | null; used_at: number | null }>();
}

/**
 * 利用者の `invited_by` を読む。
 *
 * @param userId `users.id`
 * @returns 招待者の id、または null
 */
async function invitedBy(userId: string): Promise<string | null> {
  const row = await env.DB.prepare('select invited_by from users where id = ?')
    .bind(userId)
    .first<{ invited_by: string | null }>();
  return row?.invited_by ?? null;
}

describe('招待の発行と招待枠の残数（#13 scope.in）', () => {
  it('発行したコードが正規形で保存され、引き直せる', async () => {
    const issuer = await insertUser();
    const issued = await issueInvite(env.DB, issuer, 5);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }

    const found = await lookupInvite(env.DB, issued.invite.code);
    expect(found).toEqual({
      code: issued.invite.code,
      issuedBy: issuer,
      usedBy: null,
      usedAt: null,
      expiresAt: null,
    });
  });

  it('失効時刻を指定して発行できる', async () => {
    const issuer = await insertUser();
    const issued = await issueInvite(env.DB, issuer, 1, NOW + 3600);
    expect(issued.ok && issued.invite.expiresAt).toBe(NOW + 3600);

    const found = await lookupInvite(env.DB, issued.ok ? issued.invite.code : '');
    expect(found?.expiresAt).toBe(NOW + 3600);
  });

  it('招待枠を超える発行を断る', async () => {
    const issuer = await insertUser();
    expect((await issueInvite(env.DB, issuer, 2)).ok).toBe(true);
    expect((await issueInvite(env.DB, issuer, 2)).ok).toBe(true);

    const third = await issueInvite(env.DB, issuer, 2);
    expect(third).toEqual({ ok: false, reason: 'quota-exhausted' });
    expect(await countIssuedInvites(env.DB, issuer)).toBe(2);
  });

  it('招待枠 0 では 1 枚も発行できない', async () => {
    const issuer = await insertUser();
    expect(await issueInvite(env.DB, issuer, 0)).toEqual({ ok: false, reason: 'quota-exhausted' });
  });

  it('残数が発行者ごとに独立している', async () => {
    // `invites_issued_by_idx` が数えるのは発行者ごとの件数。ここが混ざると、
    // 誰か 1 人が発行しただけで全員の枠が減る。
    const issuer = await insertUser();
    const other = await insertUser();
    await issueInvite(env.DB, other, 3);
    await issueInvite(env.DB, other, 3);

    expect(await countIssuedInvites(env.DB, issuer)).toBe(0);
    expect(await remainingInviteQuota(env.DB, issuer, 3)).toBe(3);
    expect(await remainingInviteQuota(env.DB, other, 3)).toBe(1);
  });

  it('使用済みになった枠は戻らない', async () => {
    // 招待枠は「同時に持てる未使用の枚数」ではなく「何人を呼べるか」。戻る設計に
    // すると、コードを配り直すだけで無制限に呼べる。
    const issuer = await insertUser();
    const guest = await insertUser();
    const issued = await issueInvite(env.DB, issuer, 1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }

    expect((await consumeInvite(env.DB, issued.invite.code, guest, NOW)).ok).toBe(true);
    expect(await remainingInviteQuota(env.DB, issuer, 1)).toBe(0);
    expect(await issueInvite(env.DB, issuer, 1)).toEqual({ ok: false, reason: 'quota-exhausted' });
  });

  it('残数が負にならない', async () => {
    // 上限を後から下げる運用（7.3 の BAN 時の枠停止など）で、既発行が上限を超える。
    const issuer = await insertUser();
    await issueInvite(env.DB, issuer, 3);
    await issueInvite(env.DB, issuer, 3);
    expect(await remainingInviteQuota(env.DB, issuer, 1)).toBe(0);
  });

  it('招待枠の上限が不正なら例外にする', async () => {
    // 「枠が尽きた」として扱わない。設定の誤りが利用者向けの文言として出ると、
    // 原因の分からない枯渇になって調べようがない。
    const issuer = await insertUser();
    for (const invalid of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(issueInvite(env.DB, issuer, invalid), String(invalid)).rejects.toThrow();
      await expect(remainingInviteQuota(env.DB, issuer, invalid), String(invalid)).rejects.toThrow();
    }
  });

  it('実在しない発行者では発行できない', async () => {
    // `issued_by` の外部キー。招待の系統（8.1）が存在しない人から始まらないようにする。
    await expect(issueInvite(env.DB, 'u-no-such-user', 1)).rejects.toThrow();
  });
});

describe('招待の照合（正規形だけで行う）', () => {
  it('表示用の区切りと小文字で引ける', async () => {
    const issuer = await insertUser();
    const code = await insertInvite(issuer);

    expect((await lookupInvite(env.DB, formatInviteCode(code)))?.code).toBe(code);
    expect((await lookupInvite(env.DB, code.toLowerCase()))?.code).toBe(code);
  });

  it('形式が不正な入力では DB を引かずに null を返す', async () => {
    expect(await lookupInvite(env.DB, 'not-a-code')).toBeNull();
  });

  it('存在しないコードでは null を返す', async () => {
    expect(await lookupInvite(env.DB, generateInviteCode())).toBeNull();
  });
});

describe('事前チェック（8.1 の「検証を先、OAuth を後」）', () => {
  it('未使用で期限内のコードを受け付ける', async () => {
    const issuer = await insertUser();
    const code = await insertInvite(issuer, NOW + 1);
    const checked = await checkInvite(env.DB, code, NOW);
    expect(checked.ok && checked.invite.issuedBy).toBe(issuer);
  });

  it('理由を区別して断る', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const used = await insertInvite(issuer);
    await consumeInvite(env.DB, used, guest, NOW);
    const expired = await insertInvite(issuer, NOW);

    expect(await checkInvite(env.DB, 'not-a-code', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await checkInvite(env.DB, generateInviteCode(), NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(await checkInvite(env.DB, used, NOW)).toEqual({ ok: false, reason: 'used' });
    expect(await checkInvite(env.DB, expired, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('消費しない', async () => {
    // ここで使用済みにすると、OAuth を中断した利用者のコードが焼き切れる。
    const issuer = await insertUser();
    const code = await insertInvite(issuer);
    await checkInvite(env.DB, code, NOW);
    expect((await rawInvite(code))?.used_by).toBeNull();
  });
});

describe('招待の消費（#13 acceptance 1・3）', () => {
  it('used_by と used_at を記録する', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer);

    const consumed = await consumeInvite(env.DB, code, guest, NOW);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) {
      return;
    }
    expect(consumed.invite.usedBy).toBe(guest);
    expect(consumed.invite.usedAt).toBe(NOW);
    expect(await rawInvite(code)).toEqual({ used_by: guest, used_at: NOW });
  });

  it('users.invited_by を記録する', async () => {
    // 8.1 の「誰が誰を呼んだか」。招待の使用済み化と同じ経路で書くので、
    // 「使用済みなのに招待者が記録されていない」行が経路ごとに増えない。
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer);

    const consumed = await consumeInvite(env.DB, code, guest, NOW);
    expect(consumed.ok && consumed.invitedByRecorded).toBe(true);
    expect(await invitedBy(guest)).toBe(issuer);
  });

  it('既に招待者がいる利用者の invited_by を上書きしない', async () => {
    // 招待者は「最初に誰が呼んだか」。使うたびに書き換わる値にすると、8.1 の
    // 構造が可変になる。招待自体は使用済みになる（枠は消費される）。
    const first = await insertUser();
    const second = await insertUser();
    const guest = await insertUser();
    await consumeInvite(env.DB, await insertInvite(first), guest, NOW);

    const later = await insertInvite(second);
    const consumed = await consumeInvite(env.DB, later, guest, NOW);
    expect(consumed.ok && consumed.invitedByRecorded).toBe(false);
    expect(await invitedBy(guest)).toBe(first);
    expect((await rawInvite(later))?.used_by).toBe(guest);
  });

  it('表示用の区切りと小文字でも消費できる', async () => {
    // 正規形へ揃えてから触らないと、同じコードが別行に見えて二重使用の判定が破れる。
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer);

    const consumed = await consumeInvite(env.DB, formatInviteCode(code).toLowerCase(), guest, NOW);
    expect(consumed.ok && consumed.invite.code).toBe(code);
  });

  it('同一コードの二重使用を拒否する', async () => {
    const issuer = await insertUser();
    const first = await insertUser();
    const second = await insertUser();
    const code = await insertInvite(issuer);

    expect((await consumeInvite(env.DB, code, first, NOW)).ok).toBe(true);
    expect(await consumeInvite(env.DB, code, second, NOW)).toEqual({ ok: false, reason: 'used' });

    // 断ったのに行が書き換わっていないこと（used_by が後勝ちで上書きされない）。
    expect(await rawInvite(code)).toEqual({ used_by: first, used_at: NOW });
    expect(await invitedBy(second)).toBeNull();
  });

  it('同じ利用者が同じコードを 2 回使うこともできない', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer);

    expect((await consumeInvite(env.DB, code, guest, NOW)).ok).toBe(true);
    expect(await consumeInvite(env.DB, code, guest, NOW)).toEqual({ ok: false, reason: 'used' });
  });

  it('並行した 2 回の消費のうち 1 回だけが成功する', async () => {
    // 二重使用の排除は条件付き UPDATE の影響行数だけで決めている。`SELECT` で
    // 未使用を確かめてから `UPDATE` する形だと、ここで両方が成功する（D1 に
    // 対話的トランザクションが無いため、確認と更新の間に割り込める）。
    const issuer = await insertUser();
    const first = await insertUser();
    const second = await insertUser();
    const code = await insertInvite(issuer);

    const results = await Promise.all([
      consumeInvite(env.DB, code, first, NOW),
      consumeInvite(env.DB, code, second, NOW),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'used' }]);

    // 勝った側だけが `invited_by` を持つ。片方だけが成功したことを、招待の行と
    // 利用者の行の両方で確かめる。
    const winner = (await rawInvite(code))?.used_by;
    expect([first, second]).toContain(winner);
    const invitedByFirst = await invitedBy(first);
    const invitedBySecond = await invitedBy(second);
    expect([invitedByFirst, invitedBySecond].filter((value) => value !== null)).toEqual([issuer]);
  });
});

describe('期限切れの拒否（#13 acceptance 2）', () => {
  it('期限を過ぎたコードを拒否する', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer, NOW - 1);

    expect(await consumeInvite(env.DB, code, guest, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect((await rawInvite(code))?.used_by).toBeNull();
  });

  it('expires_at ちょうどを期限切れとする', async () => {
    // 境界規約は「失効時刻を含めて失効」。SQL 側の条件（`expires_at > ?`）と
    // `isInviteExpired` の境界が食い違うと、事前チェックが通るのに消費だけが
    // 落ちる 1 秒が生まれる。
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer, NOW);

    expect(await consumeInvite(env.DB, code, guest, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(await checkInvite(env.DB, code, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('期限の 1 秒前は使える', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer, NOW + 1);

    expect((await consumeInvite(env.DB, code, guest, NOW)).ok).toBe(true);
  });

  it('expires_at が null なら無期限として使える', async () => {
    // 5.1 は NULL を許す。一律に期限切れとすると無期限の招待が使えなくなる。
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer, null);

    expect((await consumeInvite(env.DB, code, guest, NOW)).ok).toBe(true);
  });
});

describe('消費を断るその他の理由', () => {
  it('形式が不正な入力を malformed として断る', async () => {
    const guest = await insertUser();
    expect(await consumeInvite(env.DB, 'not-a-code', guest, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('存在しないコードを unknown として断る', async () => {
    const guest = await insertUser();
    expect(await consumeInvite(env.DB, generateInviteCode(), guest, NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('自分で発行したコードを自分で使えない', async () => {
    // `users.invited_by` が自分自身を指すと、招待の系統に長さ 1 の閉路ができる。
    const issuer = await insertUser();
    const code = await insertInvite(issuer);

    expect(await consumeInvite(env.DB, code, issuer, NOW)).toEqual({
      ok: false,
      reason: 'self-use',
    });
    expect((await rawInvite(code))?.used_by).toBeNull();
    expect(await invitedBy(issuer)).toBeNull();
  });

  it('実在しない利用者では例外になり、招待は消費されない', async () => {
    // `used_by` の外部キーが 1 本目で落ちる。招待を焼いてから利用者の作成に
    // 失敗する順序にはならない（8.1 の登録フローは利用者を先に作る）。
    const issuer = await insertUser();
    const code = await insertInvite(issuer);

    await expect(consumeInvite(env.DB, code, 'u-no-such-user', NOW)).rejects.toThrow();
    expect((await rawInvite(code))?.used_by).toBeNull();
  });
});

describe('発行者向けの一覧（#91）', () => {
  it('自分が発行した招待だけを返す', async () => {
    const issuer = await insertUser();
    const other = await insertUser();
    const mine = [await insertInvite(issuer), await insertInvite(issuer)];
    await insertInvite(other);

    const listed = await listIssuedInvites(env.DB, issuer);
    expect(listed.map((invite) => invite.code).sort()).toEqual([...mine].sort());
  });

  it('コード順に並ぶ', async () => {
    // `invites` に作成時刻の列が無いため、順序を指定しないと再読み込みのたびに
    // 並びが変わりうる（5.1）。
    const issuer = await insertUser();
    await insertInvite(issuer);
    await insertInvite(issuer);
    await insertInvite(issuer);

    const codes = (await listIssuedInvites(env.DB, issuer)).map((invite) => invite.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('使用済みの招待も、使用者と使用時刻を持って返る', async () => {
    const issuer = await insertUser();
    const guest = await insertUser();
    const code = await insertInvite(issuer);
    expect((await consumeInvite(env.DB, code, guest, NOW)).ok).toBe(true);

    expect(await listIssuedInvites(env.DB, issuer)).toEqual([
      { code, issuedBy: issuer, usedBy: guest, usedAt: NOW, expiresAt: null },
    ]);
  });

  it('1 本も発行していなければ空を返す', async () => {
    expect(await listIssuedInvites(env.DB, await insertUser())).toEqual([]);
  });
});
