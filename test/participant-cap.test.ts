import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVITES_API_PATH, inviteRoutes } from '../src/invite-issuance.js';
import {
  PARTICIPANT_CAP,
  PARTICIPANT_WHERE_SQL,
  countParticipants,
  participantCapReached,
} from '../src/participant-cap.js';
import { INVITES_PATH, SIGNUP_PATH } from '../src/paths.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 参加者の人数の上限（8.1 / #397。M11-3）。
 *
 * **人数を正確に作るために、`test/invite-issuance.test.ts` と分けた。** あちらは利用者を
 * テストごとに足していくので、同じファイルで「ちょうど 49 人」を作ると他のテストの人数に
 * 左右される。ここでは各テストの前に `users` を空にしてから作る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-participant-cap-1';

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  // **このファイルの人数を毎回 0 から作る。** `invites` は `users` を参照するので先に消す。
  await env.DB.batch([env.DB.prepare('delete from invites'), env.DB.prepare('delete from users')]);
});

/**
 * 利用者を `count` 人まとめて作る。
 *
 * @param count 人数
 * @param options BAN 済みにするか
 * @returns 作った利用者の id
 */
async function seedUsers(
  count: number,
  options: { banned?: boolean; withdrawing?: boolean; withdrawn?: boolean } = {},
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => `cap-${crypto.randomUUID()}`);
  // **退会は 2 段ある**（#518）。掴んだだけの行（`withdrawal_started_at` のみ）と、確定した行
  // （`withdrawn_at` も入る）の両方を作れるようにする。CHECK が順序を縛るので、確定した行には
  // 必ず掴んだ時刻も入れる（`migrations/0045_user_withdrawal.sql`）。
  const startedAt = options.withdrawing === true || options.withdrawn === true ? 2 : null;
  const withdrawnAt = options.withdrawn === true ? 3 : null;
  if (ids.length > 0) {
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          `insert into users (id, google_sub, email, display_name, created_at, banned_at,
                              withdrawal_started_at, withdrawn_at)
           values (?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(
          id,
          `sub-${id}`,
          `${id}@example.com`,
          id,
          options.banned === true ? 1 : null,
          startedAt,
          withdrawnAt,
        ),
      ),
    );
  }
  return ids;
}

/**
 * セッション cookie を組み立てる（失効時刻は実時刻から取る）。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 経路へリクエストを送る。
 *
 * @param path パス
 * @param options メソッド・cookie・`Accept`
 * @returns レスポンス
 */
async function call(
  path: string,
  options: { method?: 'GET' | 'POST'; cookie: string; accept?: string },
): Promise<Response> {
  const headers: Record<string, string> = { cookie: options.cookie };
  if (options.accept !== undefined) {
    headers['accept'] = options.accept;
  }
  return await dispatch(
    inviteRoutes,
    new Request(`${APP_ORIGIN}${path}`, { method: options.method ?? 'GET', headers }),
    testEnv(),
  );
}

/**
 * `invites` の全行数を数える。
 *
 * @returns 行数
 */
async function countAllInvites(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as total from invites').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

describe('参加者の数え方', () => {
  it('BAN 済みを数えない（#397 acceptance 2）', async () => {
    await seedUsers(3);
    await seedUsers(2, { banned: true });
    expect(await countParticipants(env.DB)).toBe(3);
  });

  it('BAN 済みが何人いても、BAN されていない人数が上限未満なら達していない', async () => {
    await seedUsers(PARTICIPANT_CAP - 1);
    await seedUsers(5, { banned: true });
    expect(await participantCapReached(env.DB)).toBe(false);
  });

  it('退会した利用者を数えない（#518 / M15-3。掴んだだけの行も数えない）', async () => {
    // **BAN と同じ理由である**——行を消さずに列を立てるので、数えると退会した人数だけ
    // 上限が実質的に下がり、その席は誰も座れないまま埋まり続ける。
    await seedUsers(3);
    await seedUsers(2, { withdrawn: true });
    await seedUsers(1, { withdrawing: true });
    expect(await countParticipants(env.DB)).toBe(3);
  });

  it('退会した人が何人いても、残りが上限未満なら達していない', async () => {
    await seedUsers(PARTICIPANT_CAP - 1);
    await seedUsers(5, { withdrawn: true });
    expect(await participantCapReached(env.DB)).toBe(false);
  });

  it('条件の綴りは 1 行の単一引用符つきリテラルで、シェルから取り出せる形である', () => {
    // `scripts/invite-stock.sh` が `sed` で取り出す。改行や単一引用符が入ると取り出せない。
    expect(PARTICIPANT_WHERE_SQL).not.toContain('\n');
    expect(PARTICIPANT_WHERE_SQL).not.toContain("'");
  });
});

describe('49 人で発行でき、50 人で断られる（#397 acceptance 1）', () => {
  it('49 人のときは発行でき、行が 1 本増える', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP - 1);
    const cookie = await sessionCookie(me!);

    const response = await call(INVITES_API_PATH, { method: 'POST', cookie });
    expect(response.status).toBe(201);
    expect(await countAllInvites()).toBe(1);
  });

  it('50 人のときは 409 の participant-cap で断り、行を作らない', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP);
    const cookie = await sessionCookie(me!);

    const response = await call(INVITES_API_PATH, { method: 'POST', cookie });
    expect(response.status).toBe(409);
    // 待っても解けないので `Retry-After` を付けない。
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await response.json()).toEqual({ error: 'participant-cap', cap: PARTICIPANT_CAP });
    expect(await countAllInvites()).toBe(0);
  });

  it('50 人のうち 1 人が BAN されていれば発行できる', async () => {
    const [me, banned] = await seedUsers(PARTICIPANT_CAP);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(banned!).run();
    const cookie = await sessionCookie(me!);

    expect((await call(INVITES_API_PATH, { method: 'POST', cookie })).status).toBe(201);
  });

  it('画面からの発行は理由付きで戻す', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP);
    const response = await call(INVITES_API_PATH, {
      method: 'POST',
      cookie: await sessionCookie(me!),
      accept: 'text/html',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${INVITES_PATH}?reason=participant-cap`);
    expect(await countAllInvites()).toBe(0);
  });
});

describe('上限に達したときの画面（#397 acceptance 3）', () => {
  it('発行のボタンを出さず、待機リストへの導線を出す', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP);
    const cookie = await sessionCookie(me!);

    const body = await (await call(INVITES_PATH, { cookie, accept: 'text/html' })).text();
    // 押しても必ず断られるボタンを出さない（4.4）。**枠は 3 本残っている。**
    expect(body).toContain('いま発行できるのは <strong>3 本</strong>です。');
    expect(pageBodyOf(body)).not.toContain('<form');
    expect(body).toContain(`参加者が上限（${PARTICIPANT_CAP} 人）に達したため、いまは招待を発行できません。`);
    expect(body).toContain(`<a href="${SIGNUP_PATH}">ログイン・登録の画面</a>から待機リストに登録してもらってください`);

    const listed = (await (await call(INVITES_API_PATH, { cookie })).json()) as { halt: unknown };
    expect(listed.halt).toBe('participant-cap');
  });

  it('断られて戻ってきたときに、同じ文言を 2 回並べない', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP);
    const body = await (
      await call(`${INVITES_PATH}?reason=participant-cap`, {
        cookie: await sessionCookie(me!),
        accept: 'text/html',
      })
    ).text();
    expect(body.split('いまは招待を発行できません。').length - 1).toBe(1);
  });

  it('49 人なら、ボタンを出して導線は出さない', async () => {
    const [me] = await seedUsers(PARTICIPANT_CAP - 1);
    const body = await (
      await call(INVITES_PATH, { cookie: await sessionCookie(me!), accept: 'text/html' })
    ).text();
    expect(body).toContain(`action="${INVITES_API_PATH}"`);
    expect(body).not.toContain('いまは招待を発行できません');
  });
});

describe('仕様書との機械照合（shared-ai-rules 12 章）', () => {
  it('仕様書 8.1 の人数が PARTICIPANT_CAP と一致する', () => {
    const spec = env.TEST_PRODUCT_SPEC;
    const heading = '### 8.1 認証と招待';
    const start = spec.indexOf(heading);
    expect(start, `仕様書に「${heading}」の節がありません`).toBeGreaterThan(-1);
    const rest = spec.slice(start + heading.length);
    const end = rest.search(/\n#{1,3} /u);
    const section = end === -1 ? rest : rest.slice(0, end);
    const matched = /全体で参加者 (\d+) 人に達したら、誰も発行できない/u.exec(section);
    expect(
      matched,
      '仕様書 8.1 に「全体で参加者 N 人に達したら、誰も発行できない」の記述がありません',
    ).not.toBeNull();
    expect(Number(matched![1])).toBe(PARTICIPANT_CAP);
  });
});
