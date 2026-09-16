import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import {
  ACCOUNT_DETAILS_PATH,
  ACCOUNT_WITHDRAWN_PATH,
  ACCOUNT_WITHDRAW_API_PATH,
  ACCOUNT_WITHDRAW_PATH,
} from '../src/account-paths.js';
import { WITHDRAWAL_REFUSALS } from '../src/account-withdrawal.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { HANDLES_TABLE, HANDLE_RESERVATION_DAYS } from '../src/handle.js';
import { handlePagePath } from '../src/handle-paths.js';
import { HOME_PATH } from '../src/paths.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SESSION_COOKIE, buildSessionCookie, signSession } from '../src/session.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { WITHDRAWN_DISPLAY_NAME } from '../src/withdrawal.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 退会の口と画面（`src/account-withdrawal.ts` / #518 / M15-3）。
 *
 * **#518 の acceptance 2 と 7 を機械判定する。**
 *
 * 2. 退会すると、同じ cookie での書き込みが断られる（**書き込みの口を経路表から回す**）。
 *    ヘッダが未ログインになり、`/users/<id>` と `/@handle` が 404 になる
 * 7. 生成中・リフォージ中の作品があると退会を断る（**行が 1 列も変わらない**）。
 *    管理者には退会の口が出ない
 *
 * acceptance 3〜6（匿名化・台帳・ハンドル名・後続の処理）は `test/withdrawal.test.ts` /
 * `test/withdrawal-handle.test.ts` / `test/withdrawal-purge.test.ts` が持つ（土台の #586）。
 * 同じ Google アカウントで戻ると招待が要ることは `test/auth-google.test.ts` が持つ。
 *
 * # 「断られる」を経路表から回す
 *
 * **口の一覧をここへ書き並べない**（`.ai-playbook/shared-ai-rules.md` 12 章）。書き並べると、
 * 書き込みの口を 1 本足した日から検査だけが古い一覧を見続ける。**一覧を持つのは例外の側**で、
 * 下の {@link OPEN_POST_PATHS} に理由つきで並べる——**口を足すと自動で検査に入り、例外を足す
 * ときだけ説明を求められる**（失敗の向きを閉じる側へ倒す）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-withdrawal-routes-1';

/** 固定の時刻（UNIX 秒）。**過去の値を作るためだけに使う。** */
const NOW = 1_700_000_000;

/**
 * 「少し前」の時刻（UNIX 秒）。
 *
 * **固定の未来の時刻を掴みの時刻に使わない。** `migrations/0045_user_withdrawal.sql` の CHECK は
 * `withdrawn_at >= withdrawal_started_at` を縛るので、未来の値で掴んでおくと、口が実時刻で
 * 確定するときに CHECK へ当たって落ちる。
 *
 * @returns 10 分前の UNIX 秒
 */
function recentlyStarted(): number {
  return Math.floor(Date.now() / 1000) - 600;
}

/**
 * セッションを見ない POST の口（**例外の一覧**）。
 *
 * ここに並ぶのは「退会した利用者の cookie で叩いても断られないのが正しい」口だけである。
 *
 * - `/api/takedown` … 権利者の窓口。**ログインを要求しない**（`src/legal.ts`）
 * - `/signup` / `/api/waitlist` … 登録と待機リスト。未ログインの人が叩く
 * - `/auth/logout` … cookie を消すだけ。**秘密の設定にも D1 にも依存させない**（`src/auth/google.ts`）
 * - `/api/plays` … プレイ数。利用者と結び付けない（`src/plays.ts`）
 * - `/api/generate/callback` / `/api/ogp/callback` … オーケストレータからのコールバック。
 *   セッションではなく作品ごとのトークンで受ける
 * - `/api/account/withdraw` … **退会の口そのもの。** 段2・段3 の手前で落ちた退会を、同じ cookie で
 *   押し直せるようにする（`src/withdrawal.ts` の `resolveWithdrawalSession`）
 */
const OPEN_POST_PATHS: readonly string[] = [
  '/api/takedown',
  '/signup',
  '/api/waitlist',
  '/auth/logout',
  '/api/plays',
  '/api/generate/callback',
  '/api/ogp/callback',
  ACCOUNT_WITHDRAW_API_PATH,
];

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as unknown as Env;
}

/** 本番と同じ経路表。 */
let routes: readonly Route[] = [];

beforeAll(async () => {
  await applySchema();
  routes = createAppRoutes(env);
});

/** 用意した利用者。 */
interface SeededUser {
  readonly id: string;
  readonly cookie: string;
  readonly handle: string;
}

/**
 * 利用者を 1 人用意する（ハンドル名つき）。
 *
 * @param seed 権限
 * @returns 利用者の id・cookie・ハンドル名
 */
async function seedUser(
  seed: { readonly isAdmin?: boolean; readonly isOperator?: boolean } = {},
): Promise<SeededUser> {
  const id = `wdr-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, is_admin, is_operator, bio, profile_links)
     values (?, ?, ?, '退会する人', 100, ?, ?, '自己紹介', '["https://example.com/me"]')`,
  )
    .bind(
      id,
      `sub-${id}`,
      `${id}@example.com`,
      seed.isAdmin === true ? 1 : 0,
      seed.isOperator === true ? 1 : 0,
    )
    .run();
  const handle = `wdr_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await env.DB.prepare(`insert into ${HANDLES_TABLE} (handle, user_id, claimed_at) values (?, ?, 1)`)
    .bind(handle, id)
    .run();
  return { id, cookie: await cookieFor(id), handle };
}

/**
 * 利用者のセッション cookie（`Cookie` ヘッダへ載せる形）を作る。
 *
 * **発行時刻は実時刻にする**（期限を実時刻で見るため）。
 *
 * @param userId 利用者の id
 * @returns `名前=値`
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
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
  overrides: { status?: 'draft' | 'published'; generationState?: 'pending' | 'running' | 'ready' } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, published_at, generation_state)
     values (?, ?, ?, '題名', 'go1.27.0', 100, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? 'draft',
      (overrides.status ?? 'draft') === 'published' ? 200 : null,
      overrides.generationState ?? 'ready',
    )
    .run();
  return id;
}

/**
 * 経路を叩く。
 *
 * @param method メソッド
 * @param path パス
 * @param cookie `Cookie` ヘッダの値（未ログインなら null）
 * @returns レスポンス
 */
async function call(
  method: 'GET' | 'POST',
  path: string,
  cookie: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${path}`, { method, headers, body: method === 'POST' ? '' : null }),
    testEnv(),
  );
}

/**
 * `users` の行を JSON にする（**全列**。1 列も変わっていないことを見るため）。
 *
 * @param userId 利用者の id
 * @returns 行の JSON
 */
async function rowJsonOf(userId: string): Promise<string> {
  const row = await env.DB.prepare('select * from users where id = ?').bind(userId).first();
  expect(row, `${userId} の行`).not.toBeNull();
  return JSON.stringify(row);
}

/**
 * 退会させる（口から押す）。
 *
 * @param user 利用者
 * @returns レスポンス
 */
async function withdraw(user: SeededUser): Promise<Response> {
  return await call('POST', ACCOUNT_WITHDRAW_API_PATH, user.cookie);
}

describe('確認画面（GET /account/withdraw）', () => {
  it('消えるもの・残るもの・戻せないこと・新しい招待が要ることを、押す前に書く', async () => {
    const user = await seedUser();
    const response = await call('GET', ACCOUNT_WITHDRAW_PATH, user.cookie);
    expect(response.status).toBe(200);
    const body = pageBodyOf(await response.text());

    expect(body).toContain('退会すると消えるもの');
    expect(body).toContain('退会しても残るもの');
    expect(body).toContain('元に戻せません');
    expect(body).toContain('新しい招待コードが必要です');
    // **表示名の代わりの値は定数から取る**（画面へ書き写さない。`src/withdrawal.ts`）。
    expect(body).toContain(WITHDRAWN_DISPLAY_NAME);
    // **ハンドル名の予約の日数も定数から取る。**
    expect(body).toContain(`${HANDLE_RESERVATION_DAYS} 日`);
    // 消せないもの（#518 の constraints）。
    expect(body).toContain('最大 1 年');
    // 断る条件を先に書く。
    expect(body).toContain('生成中・リフォージ中の作品があるあいだは退会できません');
    // フォームは素の POST で、この口へ送る。
    expect(body).toContain(`<form method="post" action="${ACCOUNT_WITHDRAW_API_PATH}">`);
  });

  it('退会のボタンは副で、この画面に主のボタンを置かない（仕様 2.5.5 / #473）', async () => {
    const user = await seedUser();
    const body = pageBodyOf(await (await call('GET', ACCOUNT_WITHDRAW_PATH, user.cookie)).text());
    expect(body).toContain('class="gf-button gf-button-secondary">退会する</button>');
    expect(body, '破壊的な操作を主のボタンにしない').not.toContain('gf-button-primary');
  });

  it('未ログインならログインへ送る', async () => {
    const response = await call('GET', ACCOUNT_WITHDRAW_PATH, null);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });
});

describe('完了画面（GET /account/withdrawn）', () => {
  it('未ログインで開ける（退会の応答が cookie を消した後に開く画面である）', async () => {
    const response = await call('GET', ACCOUNT_WITHDRAWN_PATH, null);
    expect(response.status).toBe(200);
    const body = pageBodyOf(await response.text());
    expect(body).toContain('退会の手続きが終わりました');
    // **誰の状態も名乗らない。**
    expect(body).not.toContain('あなたは退会しました');
  });
});

describe('管理者と運営フラグ（#518 の constraints / J7）', () => {
  it('管理者には確認画面も口も出さない（GET も POST も 404 で、行は 1 列も変わらない）', async () => {
    const admin = await seedUser({ isAdmin: true });
    const before = await rowJsonOf(admin.id);

    const page = await call('GET', ACCOUNT_WITHDRAW_PATH, admin.cookie);
    expect(page.status).toBe(WITHDRAWAL_REFUSALS.admin.status);
    expect(WITHDRAWAL_REFUSALS.admin.status).toBe(404);

    const posted = await withdraw(admin);
    expect(posted.status).toBe(404);
    // **理由を名乗らない**（綴りを知らない人が受け取る応答と同じ形にする）。
    expect(pageBodyOf(await posted.text())).not.toContain('管理者');
    expect(await rowJsonOf(admin.id)).toBe(before);
  });

  it('管理者の登録情報には退会の導線が出ない', async () => {
    const admin = await seedUser({ isAdmin: true });
    const body = pageBodyOf(await (await call('GET', ACCOUNT_DETAILS_PATH, admin.cookie)).text());
    expect(body).not.toContain(ACCOUNT_WITHDRAW_PATH);
  });

  it('運営フラグの利用者には導線を出さないが、退会そのものは断らない（J7）', async () => {
    const operator = await seedUser({ isOperator: true });
    const details = pageBodyOf(await (await call('GET', ACCOUNT_DETAILS_PATH, operator.cookie)).text());
    expect(details, '導線は出さない').not.toContain(ACCOUNT_WITHDRAW_PATH);

    // **口は開いている**（運営が自分の意思で退会できなくならないように）。
    expect((await call('GET', ACCOUNT_WITHDRAW_PATH, operator.cookie)).status).toBe(200);
    expect((await withdraw(operator)).status).toBe(303);
  });

  it('ふつうの利用者の登録情報には退会の導線が出る', async () => {
    const user = await seedUser();
    const body = pageBodyOf(await (await call('GET', ACCOUNT_DETAILS_PATH, user.cookie)).text());
    expect(body).toContain(ACCOUNT_WITHDRAW_PATH);
  });
});

describe('断る条件（#518 の acceptance 7）', () => {
  it.each([
    ['生成中（pending）', 'pending'],
    ['生成中（running。区切りを過ぎても断る）', 'running'],
  ] as const)('%s の作品があると 409 で断り、行は 1 列も変わらない', async (_label, state) => {
    const user = await seedUser();
    await seedGame(user.id, { generationState: state });
    const before = await rowJsonOf(user.id);

    const response = await withdraw(user);
    expect(response.status).toBe(409);
    expect(pageBodyOf(await response.text())).toContain(WITHDRAWAL_REFUSALS.generating.heading);
    expect(await rowJsonOf(user.id)).toBe(before);
  });

  it('リフォージ中のジョブがあると 409 で断り、行は 1 列も変わらない', async () => {
    const user = await seedUser();
    const gameId = await seedGame(user.id);
    await env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, started_at, created_at)
       values (?, ?, '直して', 'running', ?, ?)`,
    )
      // **区切り（`STALE_AFTER_SECONDS`）を過ぎた行でも断る**（経過時間で区切らない。#516 / #517）。
      .bind(gameId, crypto.randomUUID(), NOW - 60 * 60 * 24, NOW - 60 * 60 * 24)
      .run();
    const before = await rowJsonOf(user.id);

    const response = await withdraw(user);
    expect(response.status).toBe(409);
    expect(await rowJsonOf(user.id)).toBe(before);
  });

  it('断りの画面は、窓口への案内を添える（#517 と揃える）', async () => {
    const user = await seedUser();
    await seedGame(user.id, { generationState: 'pending' });
    const body = pageBodyOf(await (await withdraw(user)).text());
    expect(body).toContain('よくある質問');
    expect(body).toContain('mailto:');
  });

  it('断りの理由の表は、`src/withdrawal.ts` の理由から漏れなく導いてある', () => {
    // **`not-found` と `banned` を除いた全部を持つ**（`Exclude` で導いているので、理由が
    // 増えた日に型検査が落ちる。ここは値としても空でないことを見る）。
    expect(Object.keys(WITHDRAWAL_REFUSALS).sort()).toEqual(
      ['admin', 'avatar-saving', 'busy', 'generating'].sort(),
    );
    for (const [reason, refusal] of Object.entries(WITHDRAWAL_REFUSALS)) {
      expect(refusal.heading, `${reason} の見出し`).not.toBe('');
      expect(refusal.body, `${reason} の本文`).not.toBe('');
    }
  });
});

describe('退会したら、同じ cookie でもう書き込めない（#518 の acceptance 2）', () => {
  it('退会の応答は 303 で完了画面へ送り、セッションの cookie を消す', async () => {
    const user = await seedUser();
    const response = await withdraw(user);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(ACCOUNT_WITHDRAWN_PATH);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(SESSION_COOKIE);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('もう一度押しても同じ完了画面へ送る（冪等）', async () => {
    const user = await seedUser();
    expect((await withdraw(user)).status).toBe(303);
    const again = await withdraw(user);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(ACCOUNT_WITHDRAWN_PATH);
  });

  it('書き込みの口を経路表から回し、どれもログインを求める', async () => {
    const user = await seedUser();
    expect((await withdraw(user)).status).toBe(303);

    const guarded = routes.filter(
      (route: Route) => route.method === 'POST' && !OPEN_POST_PATHS.includes(route.path),
    );
    // **空振りを緑にしない。**
    expect(guarded.length).toBeGreaterThan(5);

    for (const route of guarded) {
      const response = await call('POST', route.path, user.cookie);
      const location = response.headers.get('location');
      const rejected =
        response.status === 401 || (response.status === 303 && location === LOGIN_PATH);
      expect(rejected, `${route.path} が退会した cookie を受け付けた（${response.status} ${location ?? ''}）`).toBe(true);
    }
  });

  it('例外の一覧に、経路表に無い綴りが混ざっていない', () => {
    // **例外が古くなったことに気づけるようにする**（口の綴りが変わっても、例外だけが
    // 残ると検査が黙って緩む）。
    const posts = new Set(routes.filter((route: Route) => route.method === 'POST').map((route) => route.path));
    for (const path of OPEN_POST_PATHS) {
      expect(posts.has(path), `${path} は経路表に無い`).toBe(true);
    }
  });

  it('ヘッダが未ログインになる（別の端末に残ったセッション。acceptance 2）', async () => {
    const user = await seedUser();
    expect((await withdraw(user)).status).toBe(303);

    // **同じ cookie で、ログインを要求しない画面を開く。**
    const body = await (await call('GET', HOME_PATH, user.cookie)).text();
    const header = /<header class="gf-header">[\s\S]*?<\/header>/u.exec(body);
    expect(header, 'ヘッダが無い（検査が空振りする）').not.toBeNull();
    expect(header![0]).toContain('>ログイン</a>');
    expect(header![0]).not.toContain(`href="${ACCOUNT_DETAILS_PATH}"`);
  });

  it('本人だけの画面もログインへ送る', async () => {
    const user = await seedUser();
    expect((await withdraw(user)).status).toBe(303);
    const response = await call('GET', ACCOUNT_DETAILS_PATH, user.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('段2・段3 の手前で落ちた退会は、同じ cookie で押し直せる（段0 の例外）', async () => {
    // **`resolveSessionUser` は掴んだ行を拒む**（別のタブからの書き込みを止めるため）。
    // 退会の口だけがその例外を持つ（`resolveWithdrawalSession`）——持たないと、途中で
    // 落ちた退会が**永久に完了しない。**
    const user = await seedUser();
    const startedAt = recentlyStarted();
    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?')
      .bind(startedAt, user.id)
      .run();

    // ほかの口は、この時点でもう断る。
    expect((await call('GET', ACCOUNT_DETAILS_PATH, user.cookie)).status).toBe(303);

    // 退会の口だけは通り、確定まで進む。
    const response = await withdraw(user);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(ACCOUNT_WITHDRAWN_PATH);
    const row = await env.DB.prepare(
      'select withdrawal_started_at, withdrawn_at, display_name from users where id = ?',
    )
      .bind(user.id)
      .first<{ withdrawal_started_at: number; withdrawn_at: number | null; display_name: string }>();
    expect(row?.withdrawn_at, '確定した').not.toBeNull();
    // **最初に掴んだ時刻を残す**（後続の処理の「10 分」がこの値を読む）。
    expect(row?.withdrawal_started_at).toBe(startedAt);
    expect(row?.display_name).toBe(WITHDRAWN_DISPLAY_NAME);
  });

  it('確認画面も、掴んだだけの行では開ける（押し直しの導線を閉じない）', async () => {
    const user = await seedUser();
    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?')
      .bind(NOW, user.id)
      .run();
    expect((await call('GET', ACCOUNT_WITHDRAW_PATH, user.cookie)).status).toBe(200);
  });

  it('BAN された利用者は退会の口へ入れない（BAN の回避に使わせない）', async () => {
    const user = await seedUser();
    await env.DB.prepare('update users set banned_at = ? where id = ?').bind(NOW, user.id).run();
    const before = await rowJsonOf(user.id);

    const page = await call('GET', ACCOUNT_WITHDRAW_PATH, user.cookie);
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(LOGIN_PATH);

    const posted = await withdraw(user);
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(LOGIN_PATH);
    expect(await rowJsonOf(user.id)).toBe(before);
  });

  it('作者ページとハンドル名のページが 404 になる', async () => {
    const user = await seedUser();
    expect((await withdraw(user)).status).toBe(303);
    expect((await call('GET', authorPagePath(user.id), null)).status).toBe(404);
    expect((await call('GET', handlePagePath(user.handle), null)).status).toBe(404);
  });

  it('掴んだだけ（確定の前）でも、作者ページは 404 になる', async () => {
    const user = await seedUser();
    // 段1 だけが済んだ状態を作る（段2・段3 の手前で落ちた退会）。
    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?')
      .bind(NOW, user.id)
      .run();
    expect((await call('GET', authorPagePath(user.id), null)).status).toBe(404);
    expect((await call('GET', handlePagePath(user.handle), null)).status).toBe(404);
  });
});
