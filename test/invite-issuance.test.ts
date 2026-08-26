import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import {
  INVITES_API_PATH,
  INVITE_QUOTA,
  inviteRoutes,
} from '../src/invite-issuance.js';
import { formatInviteCode, normalizeInviteCode } from '../src/invite-code.js';
import { consumeInvite, lookupInvite } from '../src/invites.js';
import { INVITES_PATH } from '../src/paths.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 招待の発行経路（#91）。
 *
 * **受け入れ条件のうち、ローカルで機械判定できるものをここで押さえる。** 本番 D1 の
 * ブートストラップ行の除去は一度きりのデータ操作で、機械検証は事後の問い合わせによる
 * （#91 constraints）ため、この層では扱わない。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-invite-issuance-1';

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * id を毎回ランダムにするのは、単体実行とファイル全体の実行で既存行の有無が変わらない
 * ようにするため（`test/invites.test.ts` と同じ理由）。
 *
 * @param options BAN 状態
 * @returns 利用者の id
 */
async function seedUser(options: { banned?: boolean } = {}): Promise<string> {
  const id = `inv-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at, banned_at) values (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id, options.banned === true ? 1 : null)
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * 失効時刻は**実時刻から取る**。固定値にすると、その時刻を過ぎた日から落ちる時限式の
 * テストになる（`test/generate.test.ts` のレビュー指摘と同じ）。
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
  options: { method?: 'GET' | 'POST'; cookie?: string; accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) {
    headers['cookie'] = options.cookie;
  }
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
 * 「発行されていないこと」を、応答ではなく**行が増えていないこと**で確かめるために使う。
 *
 * @returns 行数
 */
async function countAllInvites(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as total from invites').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

/**
 * 招待を 1 本発行して、そのコードを返す。
 *
 * @param cookie セッション cookie
 * @returns 正規形の招待コード
 */
async function issueOne(cookie: string): Promise<string> {
  const response = await call(INVITES_API_PATH, { method: 'POST', cookie });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { code: string };
  return body.code;
}

beforeAll(async () => {
  await applySchema();
});

describe('未ログインの発行要求を拒否する（#91 acceptance 3）', () => {
  it('cookie が無い POST は 401 で、`invites` に行が増えない', async () => {
    const before = await countAllInvites();
    const response = await call(INVITES_API_PATH, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(await countAllInvites()).toBe(before);
  });

  it('画面からの POST も行を作らずログインへ送る', async () => {
    // 素の `<form method="post">` から来た場合。JSON の 401 を返すと本文がそのまま
    // 表示されるため、応答の形は変わるが**行を作らない**ことは同じである。
    const before = await countAllInvites();
    const response = await call(INVITES_API_PATH, { method: 'POST', accept: 'text/html' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(await countAllInvites()).toBe(before);
  });

  it('署名が通らない cookie は 401', async () => {
    const response = await call(INVITES_API_PATH, {
      method: 'POST',
      cookie: `${SESSION_COOKIE}=forged.token`,
    });
    expect(response.status).toBe(401);
  });

  it('別の鍵で署名した cookie は 401', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { userId: 'someone', issuedAt, expiresAt: issuedAt + 3600 },
      'another-secret-value-of-sufficient-length',
    );
    const response = await call(INVITES_API_PATH, {
      method: 'POST',
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    expect(response.status).toBe(401);
  });

  it('BAN された利用者は発行できない', async () => {
    // セッションの寿命は 7 日で失効させる手段が無いため、署名だけを信じると
    // BAN（7.3）が最大 7 日効かない。
    const banned = await seedUser({ banned: true });
    const before = await countAllInvites();
    const response = await call(INVITES_API_PATH, {
      method: 'POST',
      cookie: await sessionCookie(banned),
    });

    expect(response.status).toBe(401);
    expect(await countAllInvites()).toBe(before);
  });

  it('未ログインでは一覧も画面も見せない', async () => {
    expect((await call(INVITES_API_PATH)).status).toBe(401);

    const page = await call(INVITES_PATH, { accept: 'text/html' });
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(LOGIN_PATH);
  });
});

describe('ログイン済み利用者が招待を発行できる（#91 acceptance 1）', () => {
  it('POST が 201 でコードを返し、その行が引ける', async () => {
    const userId = await seedUser();
    const cookie = await sessionCookie(userId);
    const response = await call(INVITES_API_PATH, { method: 'POST', cookie });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; quota: number; remaining: number };
    expect(body.quota).toBe(INVITE_QUOTA);
    expect(body.remaining).toBe(INVITE_QUOTA - 1);

    // 返すのは正規形だけ（表示用の区切りは表示側が足す）。
    expect(normalizeInviteCode(body.code)).toBe(body.code);

    const stored = await lookupInvite(env.DB, body.code);
    expect(stored).toEqual({
      code: body.code,
      issuedBy: userId,
      usedBy: null,
      usedAt: null,
      expiresAt: null,
    });
  });

  it('画面からの発行は 303 で一覧へ戻す（POST-redirect-GET）', async () => {
    // 発行の結果を同じ URL に描くと、再読み込みで再送信の確認が出て枠を空撃ちする。
    const cookie = await sessionCookie(await seedUser());
    const response = await call(INVITES_API_PATH, { method: 'POST', cookie, accept: 'text/html' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(INVITES_PATH);
  });
});

describe('招待枠は 1 人 3 本（#91 acceptance 2）', () => {
  it('4 本目が quota-exhausted で断られ、行は 3 本のまま', async () => {
    const userId = await seedUser();
    const cookie = await sessionCookie(userId);
    for (let issued = 0; issued < INVITE_QUOTA; issued += 1) {
      expect((await call(INVITES_API_PATH, { method: 'POST', cookie })).status).toBe(201);
    }

    const extra = await call(INVITES_API_PATH, { method: 'POST', cookie });
    // 429 ではなく 409。招待枠は総数の上限で、待っても戻らない。
    expect(extra.status).toBe(409);
    expect(await extra.json()).toEqual({
      error: 'quota-exhausted',
      quota: INVITE_QUOTA,
      remaining: 0,
    });

    const mine = await env.DB.prepare('select count(*) as total from invites where issued_by = ?')
      .bind(userId)
      .first<{ total: number }>();
    expect(mine?.total).toBe(INVITE_QUOTA);
  });

  it('同時に送っても上限を超えない', async () => {
    // `issueInvite` が件数の判定を INSERT の `WHERE` へ畳んでいることに依存している。
    // 経路側で「数えてから入れる」形に書き直すと、ここで 4 本入る。
    const userId = await seedUser();
    const cookie = await sessionCookie(userId);
    const responses = await Promise.all(
      Array.from({ length: INVITE_QUOTA + 1 }, () =>
        call(INVITES_API_PATH, { method: 'POST', cookie }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(INVITE_QUOTA);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
  });

  it('使い切った後の画面からの発行は理由付きで戻す', async () => {
    const cookie = await sessionCookie(await seedUser());
    for (let issued = 0; issued < INVITE_QUOTA; issued += 1) {
      await call(INVITES_API_PATH, { method: 'POST', cookie });
    }

    const response = await call(INVITES_API_PATH, { method: 'POST', cookie, accept: 'text/html' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${INVITES_PATH}?reason=quota-exhausted`);
  });
});

describe('自分が発行した招待を自分では使えない（#91 acceptance 4）', () => {
  it('発行者本人の消費が self-use で断られる', async () => {
    // `consumeInvite` の既存条件（`issued_by <> ?`）が、経路から発行したコードにも
    // 効いていることを見る。効かないと `users.invited_by` が自分を指し、系統に
    // 長さ 1 の閉路ができる。
    const userId = await seedUser();
    const code = await issueOne(await sessionCookie(userId));

    expect(await consumeInvite(env.DB, code, userId)).toEqual({ ok: false, reason: 'self-use' });
  });
});

describe('自分が発行した招待の一覧と残枠', () => {
  it('自分の招待だけを、残枠とあわせて返す', async () => {
    const mine = await seedUser();
    const other = await seedUser();
    const myCode = await issueOne(await sessionCookie(mine));
    await issueOne(await sessionCookie(other));

    const response = await call(INVITES_API_PATH, { cookie: await sessionCookie(mine) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      quota: INVITE_QUOTA,
      issued: 1,
      remaining: INVITE_QUOTA - 1,
      invites: [{ code: myCode, state: '未使用', usedAt: null, expiresAt: null }],
    });
  });

  it('他人の `users.id` を返さない', async () => {
    // 使われたかどうかだけを返す。系統の表示は 5.5 が別に持つ。
    const issuer = await seedUser();
    const guest = await seedUser();
    const code = await issueOne(await sessionCookie(issuer));
    expect((await consumeInvite(env.DB, code, guest)).ok).toBe(true);

    const response = await call(INVITES_API_PATH, { cookie: await sessionCookie(issuer) });
    const text = await response.text();
    expect(text).not.toContain(guest);
    expect(text).toContain('使用済み');
  });
});

describe('招待を発行する画面', () => {
  it('残枠と発行フォームを出す', async () => {
    const cookie = await sessionCookie(await seedUser());
    const response = await call(INVITES_PATH, { cookie, accept: 'text/html' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await response.text();
    expect(body).toContain(`action="${INVITES_API_PATH}"`);
    expect(body).toContain(`招待枠は 1 人 ${INVITE_QUOTA} 本`);
    expect(body).toContain(`残り ${INVITE_QUOTA} 本`);
  });

  it('発行済みのコードを表示用の区切り付きで並べる', async () => {
    const cookie = await sessionCookie(await seedUser());
    const code = await issueOne(cookie);

    const body = await (await call(INVITES_PATH, { cookie, accept: 'text/html' })).text();
    expect(body).toContain(formatInviteCode(code));
    expect(body).toContain('未使用');
  });

  it('使い切ったらフォームを出さない', async () => {
    // 押しても必ず断られるボタンを出すと、「壊れている」ことと「枠が無い」ことの
    // 区別がつかない。
    const cookie = await sessionCookie(await seedUser());
    for (let issued = 0; issued < INVITE_QUOTA; issued += 1) {
      await call(INVITES_API_PATH, { method: 'POST', cookie });
    }

    const body = await (await call(INVITES_PATH, { cookie, accept: 'text/html' })).text();
    expect(body).not.toContain('<form');
    expect(body).toContain('招待枠を使い切りました');
  });

  it('reason 付きの再訪に文言と 400 を返す', async () => {
    const cookie = await sessionCookie(await seedUser());
    const response = await call(`${INVITES_PATH}?reason=quota-exhausted`, {
      cookie,
      accept: 'text/html',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('招待枠を使い切りました');
  });

  it('未知の reason を画面へ流さない', async () => {
    // query から来る値をそのまま出すと反射型の差し込みになる。表に無いものは既定の
    // 文言へ倒す。
    const cookie = await sessionCookie(await seedUser());
    const response = await call(`${INVITES_PATH}?reason=%3Cscript%3Ealert(1)%3C%2Fscript%3E`, {
      cookie,
      accept: 'text/html',
    });

    const body = await response.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('招待を発行できませんでした');
  });
});

describe('仕様書との機械照合（shared-ai-rules 12 章）', () => {
  /**
   * 仕様書 8.1 から招待枠の本数を取り出す。
   *
   * 一覧や定数を文書へ書き写す以上、一致するかを機械で見る。「更新したか」ではなく
   * 「一致しているか」を見るので、空更新では通過しない。
   *
   * @returns 仕様書に書かれている本数
   */
  function quotaFromSpec(): number {
    const spec = env.TEST_PRODUCT_SPEC;
    const heading = '### 8.1 認証と招待';
    const start = spec.indexOf(heading);
    expect(start, `仕様書に「${heading}」の節がありません`).toBeGreaterThan(-1);
    const rest = spec.slice(start + heading.length);
    const end = rest.search(/\n#{1,3} /u);
    const section = end === -1 ? rest : rest.slice(0, end);
    const matched = /招待枠は 1 人 (\d+) 本/u.exec(section);
    expect(matched, '仕様書 8.1 に「招待枠は 1 人 N 本」の記述がありません').not.toBeNull();
    return Number(matched![1]);
  }

  it('仕様書 8.1 の本数が INVITE_QUOTA と一致する', () => {
    expect(quotaFromSpec()).toBe(INVITE_QUOTA);
  });
});

describe('アプリの経路表への結線', () => {
  it('本番の設定でも 3 つの経路が登録されている', () => {
    // 経路を書いても `createAppRoutes` へ連結し忘れれば、どこからも到達できない。
    // `/__dev/*` と違って本番で落とす経路ではないので、無効側の env で見る。
    const registered = createAppRoutes({ ...env, DEV_ROUTES: 'disabled' } as unknown as Env).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(registered).toContain(`GET ${INVITES_PATH}`);
    expect(registered).toContain(`GET ${INVITES_API_PATH}`);
    expect(registered).toContain(`POST ${INVITES_API_PATH}`);
  });
});
