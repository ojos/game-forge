import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_OPEN_PATHS, createAdminRoutes, handleAdminRequest } from '../src/admin/routes.js';
import { adminNotFound, resolveAdminUser } from '../src/admin/guard.js';
import { ADMIN_HOME_PATH } from '../src/admin-paths.js';
import { CALLBACK_PATH, LOGIN_PATH, LOGOUT_PATH } from '../src/auth/google.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 管理画面の認可と、**守る経路の境界**（2.4.2 / #356）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 境界（この issue が決めたこと）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **OAuth の 3 経路は未ログインで通し、それ以外は 404。** 正本は
 * `src/admin/routes.ts` の `ADMIN_OPEN_PATHS` で、このファイルはそれを**経路表と
 * 突き合わせる**。3 方向から見る。
 *
 *   1. 開いていない経路は、未ログインで 404 になる（**包み忘れを捕まえる**）
 *   2. 開いている経路は、本当に経路表へ登録されている（**腐った例外を捕まえる**）
 *   3. 開いている経路は、未ログインで 404 にならない（**ログインへ到達できる**）
 *
 * **1 が M10-3 のための仕掛けである。** 審査キューや BAN の経路を足した人が
 * `requireAdmin` で包み忘れたら、**その経路を名指しせずに**赤くなる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ 404 の「形」まで見るのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **ステータスだけ揃えても、本文やヘッダが違えば区別できる。** 存在する画面の 404 と
 * 存在しない経路の 404 が別物なら、**403 を返しているのと情報量は同じ**である
 * （2.4.2 が 403 を退けた理由がそのまま戻ってくる）。**実際に両方を叩いて
 * 突き合わせる**——記述で守ると写しが腐る。
 */

const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SECRET = 'test-secret-value-for-admin-guard-checks-1';

/**
 * 秘密を明示した env を作る。
 *
 * **`{ ...env }` で作らない。** `.dev.vars` を置いた開発者の手元では本物の
 * `SESSION_SECRET` や `GOOGLE_CLIENT_*` が入り、**手元に `.dev.vars` があるかどうかで
 * テストの結果が変わる**（`test/auth-google.test.ts` の `bareEnv` が実測した事故）。
 * 必要なバインディングだけを明示して組み立てる。
 *
 * **OAuth の 2 つも入れる。** 無いと `missingSecrets` が 503 を返し、境界の検査が
 * 「ログインへ到達できるか」ではなく「設定があるか」を見ることになる。
 *
 * @param overrides 差し替える値
 * @returns ハンドラへ渡す env
 */
function testEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    APP_HOST: env.APP_HOST,
    ADMIN_HOST: env.ADMIN_HOST,
    SANDBOX_HOST: env.SANDBOX_HOST,
    DB: env.DB,
    BUCKET: env.BUCKET,
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret-value',
    ...overrides,
  } as unknown as Env;
}

/** 仕込んだ利用者の id（`is_admin` の値ごとに 1 人）。 */
const users = {
  admin: '',
  plain: '',
  bannedAdmin: '',
};

/**
 * 署名付きセッション cookie の `name=value` を作る。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダへ載せる文字列
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

beforeAll(async () => {
  await applySchema();

  const insert = async (label: string): Promise<string> => {
    const id = `${label}-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `insert into users (id, google_sub, email, display_name, created_at)
       values (?, ?, ?, ?, ?)`,
    )
      .bind(id, `sub-${id}`, `${id}@example.test`, label, Math.floor(Date.now() / 1000))
      .run();
    return id;
  };

  users.admin = await insert('admin');
  users.plain = await insert('plain');
  users.bannedAdmin = await insert('banned-admin');

  // **`is_admin` は直接 UPDATE で立てる**（2.4.2。画面から増やす経路は作らない）。
  // 本番の手順（`docs/admin-host.md`）と同じ形をテストでも使う。
  await env.DB.prepare('update users set is_admin = 1 where id in (?, ?)')
    .bind(users.admin, users.bannedAdmin)
    .run();
  await env.DB.prepare('update users set banned_at = ? where id = ?')
    .bind(Math.floor(Date.now() / 1000), users.bannedAdmin)
    .run();
});

/**
 * admin ホストへ 1 要求を投げる。
 *
 * @param path パス
 * @param cookie 送る cookie（省略すると未ログイン）
 * @param method HTTP メソッド
 * @returns ステータス・本文・content-type・遷移先
 */
async function open(
  path: string,
  cookie?: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; body: string; type: string; location: string }> {
  const response = await handleAdminRequest(
    new Request(`${ADMIN_ORIGIN}${path}`, {
      method,
      headers: cookie === undefined ? {} : { cookie },
    }),
    testEnv(),
  );
  return {
    status: response.status,
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
    location: response.headers.get('location') ?? '',
  };
}

describe('守る経路の境界（2.4.2 / #356）', () => {
  it('未ログインで通すのは OAuth の 3 経路だけである（綴りは実装の定数から取る）', () => {
    // **一覧をここへ書き並べない。** `src/auth/google.ts` の定数と突き合わせるので、
    // ログインのパスを変えれば必ずどちらかが赤くなる。
    expect([...ADMIN_OPEN_PATHS].sort()).toEqual(
      [LOGIN_PATH, CALLBACK_PATH, LOGOUT_PATH].sort(),
    );
  });

  it('開いていると宣言した経路は、本当に経路表へ登録されている', () => {
    // 逆向き。**例外一覧だけが生き残った状態を緑にしない**（消えた経路を「開いている」と
    // 言い続ける形）。
    const registered = createAdminRoutes().map((route) => route.path);
    for (const path of ADMIN_OPEN_PATHS) {
      expect(registered, `${path} が admin の経路表に無い`).toContain(path);
    }
  });

  it('開いていない経路は、すべて未ログインで 404 になる（経路表を歩く）', async () => {
    // **これが M10-3 のための仕掛けである。** 審査キューや BAN の経路を足した人が
    // `requireAdmin` で包み忘れたら、名指しせずに赤くなる。
    const guarded = createAdminRoutes().filter(
      (route) => !ADMIN_OPEN_PATHS.includes(route.path),
    );
    // **1 本も無い状態を緑にしない**（包まれた経路が消えても通る形を置かない）。
    expect(guarded.length, '包まれた経路が 1 本も無い（検査が空振りする）').toBeGreaterThan(0);

    for (const route of guarded) {
      const { status, body } = await open(route.path, undefined, route.method);
      expect(status, `${route.method} ${route.path} が未ログインで 404 ではない`).toBe(404);
      // **画面の中身が漏れていないこと**まで見る（404 なのに本文が出ている形を塞ぐ）。
      expect(body, `${route.path} の 404 に本文が混ざっている`).not.toContain('<h1>');
    }
  });

  it('開いている経路は、未ログインでも 404 にならない（ログインへ到達できる）', async () => {
    // **ここを 404 にすると、誰も管理画面へ入れない。** cookie は `__Host-` で
    // `Domain` を持てず、app のセッションは admin へ届かない（2.4.1）。
    for (const route of createAdminRoutes()) {
      if (!ADMIN_OPEN_PATHS.includes(route.path)) {
        continue;
      }
      const { status } = await open(route.path, undefined, route.method);
      expect(status, `${route.method} ${route.path} が未ログインで 404 になった`).not.toBe(404);
    }
  });

  it('OAuth の開始は、未ログインで Google へ送る', async () => {
    const { status, location } = await open(LOGIN_PATH, undefined, 'GET');
    expect(status).toBe(303);
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    // **戻り先が admin ホストである。** `env.APP_HOST` から組んでいたら app へ戻り、
    // cookie が届かない（`src/auth/google.ts` の `redirectUri`）。
    expect(location).toContain(
      encodeURIComponent(`https://${env.ADMIN_HOST}${CALLBACK_PATH}`),
    );
  });

  it('OAuth のコールバックは、未ログインで 404 にならない（400 で理由を返す）', async () => {
    // 一時 cookie が無い状態なので 400 になる。**見たいのは「404 で塞がれていない」こと**
    // で、コールバックの中身は `test/auth-google.test.ts` が見ている。
    const { status } = await open(CALLBACK_PATH, undefined, 'GET');
    expect(status).toBe(400);
  });

  it('ログアウトは未ログインでも通り、その先の管理画面は 404 である', async () => {
    // admin のセッションは独立しているので、**ここでしか終わらせられない**。
    const { status, location } = await open(LOGOUT_PATH, undefined, 'POST');
    expect(status).toBe(303);
    expect(location).toBe('/');
    // 送られた先は 404（もう管理者ではない）。**正しい挙動である。**
    expect((await open('/')).status).toBe(404);
  });
});

describe('権限が無い要求は 404（2.4.2。403 を使わない）', () => {
  it('is_admin = 1 の利用者は管理画面を開ける', async () => {
    const { status, body, type } = await open(ADMIN_HOME_PATH, await cookieFor(users.admin));
    expect(status).toBe(200);
    expect(type).toContain('text/html');
    expect(body).toContain('<h1>管理</h1>');
  });

  it('is_admin = 0 の利用者は 404 になる', async () => {
    const { status, body } = await open(ADMIN_HOME_PATH, await cookieFor(users.plain));
    expect(status).toBe(404);
    expect(body).not.toContain('<h1>管理</h1>');
  });

  it('未ログインは 404 になる', async () => {
    const { status, body } = await open(ADMIN_HOME_PATH);
    expect(status).toBe(404);
    expect(body).not.toContain('<h1>管理</h1>');
  });

  it('BAN された管理者は 404 になる（認証の判定を写していないことの確認）', async () => {
    // **BAN の判定は `resolveSessionUser` が持つ**（`src/session-user.ts`）。
    // ここが自前で `users` を 1 行読む形に書き換わると、この検査が赤くなる
    // ——**認可のために認証を写した瞬間に気づける。**
    const { status } = await open(ADMIN_HOME_PATH, await cookieFor(users.bannedAdmin));
    expect(status).toBe(404);
  });

  it('署名が通らない cookie は 404 になる（別の鍵で署名したセッション）', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const forged = await signSession(
      { userId: users.admin, issuedAt, expiresAt: issuedAt + 3600 },
      'test-secret-value-for-admin-guard-OTHER-1',
    );
    const cookie = buildSessionCookie(forged, 3600).split(';')[0]!;
    expect((await open(ADMIN_HOME_PATH, cookie)).status).toBe(404);
  });

  it('403 を 1 度も返さない（画面の存在を教えない）', async () => {
    // 2.4.2 の「403 は画面の存在を教える」を機構で押さえる。**拒否のすべてが 404**
    // であることを、権限の無い 3 つの状態について確かめる。
    for (const cookie of [undefined, await cookieFor(users.plain), await cookieFor(users.bannedAdmin)]) {
      const { status } = await open(ADMIN_HOME_PATH, cookie);
      expect(status).not.toBe(403);
      expect(status).toBe(404);
    }
  });

  it('署名鍵が壊れていても 500 にせず 404 へ倒す（fail-closed）', async () => {
    // `verifySession` は `SESSION_SECRET` が短いと投げる（`src/session.ts` の `importKey`）。
    // **500 は「壊れているが在る」ことを教える。** 遮断側へ倒す（8.2 と同じ向き）。
    const response = await handleAdminRequest(
      new Request(`${ADMIN_ORIGIN}${ADMIN_HOME_PATH}`, {
        headers: { cookie: await cookieFor(users.admin) },
      }),
      testEnv({ SESSION_SECRET: 'too-short' }),
    );
    expect(response.status).toBe(404);
  });

  it('D1 が読めなくても 500 にせず 404 へ倒す（fail-closed）', async () => {
    // 認可を確かめられないことは、認可があることではない。
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          first: async (): Promise<never> => {
            throw new Error('D1 is down');
          },
        }),
      }),
    } as unknown as D1Database;
    const resolution = await resolveAdminUser(
      new Request(`${ADMIN_ORIGIN}${ADMIN_HOME_PATH}`, {
        headers: { cookie: await cookieFor(users.admin) },
      }),
      testEnv({ DB: failingDb }),
    );
    expect(resolution.ok).toBe(false);
  });
});

describe('404 が「経路が無い」ときと区別できない（2.4.2）', () => {
  /**
   * 2 つの応答を、比較できる形へ落とす。
   *
   * **ヘッダまで見る。** 本文が同じでも `content-type` や `cache-control` が違えば
   * 区別できてしまう。
   *
   * @param response レスポンス
   * @returns 突き合わせる値
   */
  async function shapeOf(response: Response): Promise<unknown> {
    return {
      status: response.status,
      body: await response.text(),
      headers: [...response.headers].sort(),
    };
  }

  it('権限の無い管理画面と、存在しない経路の 404 が同じ形である', async () => {
    // **同じパスで比べられない**（一方は登録されている経路、他方は無い経路である）。
    // そこで**「存在しない経路 `/x`」と「権限の無い `/x` 相当」を同じパスで作る**
    // ——`adminNotFound` は権限が無いときに返すもので、`dispatch` は未登録のときに
    // 返すものである。同じ要求から両方を作って突き合わせる。
    const request = new Request(`${ADMIN_ORIGIN}/definitely-not-an-admin-route`);
    const fromDispatch = await dispatch([], request.clone(), testEnv());
    const fromGuard = adminNotFound(request.clone());

    expect(await shapeOf(fromGuard)).toEqual(await shapeOf(fromDispatch));
  });

  it('実際に叩いた 2 つの 404 が、パス以外で区別できない', async () => {
    // 上は関数どうしの照合なので、**経路表を通した実物でも見る。**
    const unauthorized = await open(ADMIN_HOME_PATH);
    const missing = await open('/definitely-not-an-admin-route');

    expect(unauthorized.status).toBe(missing.status);
    expect(unauthorized.type).toBe(missing.type);
    // 本文はパスだけが違う。**その 1 か所を揃えれば一致する**ことを見る
    // （「not found」以外の語が混ざっていたら落ちる）。
    expect(JSON.parse(unauthorized.body)).toEqual({
      error: 'not found',
      path: ADMIN_HOME_PATH,
    });
    expect(JSON.parse(missing.body)).toEqual({
      error: 'not found',
      path: '/definitely-not-an-admin-route',
    });
  });
});

describe('既存の利用者の振る舞いが変わらない（#356 acceptance 5）', () => {
  it('is_admin を指定せずに作った利用者は、admin ホストで 404 のままである', async () => {
    // **`0025` を当てただけで誰かが管理者になっていないこと。** 列の既定は
    // `test/schema-admin.test.ts` が見るが、**それが認可の結果に現れることは
    // ここでしか見られない。**
    const id = `untouched-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `insert into users (id, google_sub, email, display_name, created_at)
       values (?, ?, ?, ?, ?)`,
    )
      .bind(id, `sub-${id}`, `${id}@example.test`, '既存の利用者', Math.floor(Date.now() / 1000))
      .run();

    const row = await env.DB.prepare('select is_admin from users where id = ?')
      .bind(id)
      .first<{ is_admin: number }>();
    expect(row?.is_admin).toBe(0);
    expect((await open(ADMIN_HOME_PATH, await cookieFor(id))).status).toBe(404);
  });
});
