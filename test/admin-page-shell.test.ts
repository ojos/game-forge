import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_OPEN_ROUTES, createAdminRoutes, handleAdminRequest } from '../src/admin/routes.js';
import { ADMIN_FOOTER_MARK, ADMIN_HEADER_MARK } from '../src/admin/shell.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { APP_CSS_PATH } from '../src/html.js';
import { TAKEDOWN_PATH, TERMS_PATH } from '../src/legal.js';
import { handleAppRequest } from '../src/app.js';
import { NON_PAGE_PATHS, ssrPagePaths } from '../src/page-paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 管理画面の外枠の検査（2.4.5 / #356）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ `test/page-shell.test.ts` へ足さないのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **外枠が別物だからである**（2.4.1 が「ヘッダ・フッタは利用者向けと別でよい」と定めた）。
 * あちらが照合しているのは 2.3.7 のナビ——「作品をさがす」「つくる」「自分の作品」と、
 * 2 区画のフッタ——で、**admin ホストにその行き先は 1 本も無い。** 同じ検査へ混ぜると、
 * **admin が app のナビを持つことを要求される**ことになり、2.4 の constraints と
 * 正面から矛盾する。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * それでも「同じ網」である（2.4.5）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **画面の一覧をここへ書き写さない。** 導出は `src/page-paths.ts` の `ssrPagePaths` を
 * そのまま使い（ホストを知らない関数である）、**admin の経路表を渡すだけ**にする。
 * M10-3 が審査キューの画面を足したら、**この検査は自動でその画面を見る。**
 *
 * 2.4.5 が「乗せない選択を採らない理由」に挙げているのは、**#282 が捕まえたい失敗
 * （足した画面が外枠に乗らない）は運営しか見ない画面でこそ起きやすい**ことである。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 3 つ目（幅 390px の実ブラウザ検査）は #398 で乗った
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`scripts/check-page-width.sh` は admin の画面も 3 幅で開く。** 一覧は `/__dev/pages` の
 * `adminPaths` から受け取り（下の「/__dev/pages が admin の一覧を返す」がその口を固定する）、
 * 仕込む利用者に `is_admin = 1` を立て、**admin では 404 を通さない**（404 は権限が効いて
 * いないことの現れで、#330 が踏んだ「本体を 1 度も開かずに緑」の形になる）。
 */

const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SECRET = 'test-secret-value-for-admin-page-shell-1';

/** 管理者の cookie（`beforeAll` で作る）。 */
let cookie = '';

/**
 * 秘密を差し替えた env。
 *
 * @returns ハンドラへ渡す env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as unknown as Env;
}

beforeAll(async () => {
  await applySchema();

  const userId = `admin-shell-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.test`, '外枠検査の管理者', 1)
    .run();
  await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(userId).run();

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  cookie = buildSessionCookie(token, 3600).split(';')[0]!;
});

/**
 * 検査対象の画面パスを、admin の経路表から導く。
 *
 * **前方一致の経路には id を補う必要がある**が、**admin にはまだ 1 本も無い。**
 * `test/page-shell.test.ts` の `prefixIds` と同じ規律で、**知らない接頭辞が来たら落とす**
 * ——M10-3 が `/users/<user_id>` のような経路を足したとき、黙って裸の接頭辞を開いて
 * 404 だけを見る形にしない。
 *
 * @returns パスの配列
 */
function getPaths(): string[] {
  return ssrPagePaths(createAdminRoutes()).map((path) => {
    if (!path.endsWith('/') || path === '/') {
      return path;
    }
    throw new Error(
      `admin の前方一致の経路 ${path} に補う id が決まっていません。` +
        'test/admin-page-shell.test.ts の getPaths へ足してください' +
        '（裸の接頭辞を開くと、404 の画面だけを見て緑になります）。',
    );
  });
}

/**
 * 1 経路を管理者として開く。
 *
 * @param path パス
 * @returns 本文・content-type・ステータス
 */
async function open(path: string): Promise<{ body: string; type: string; status: number }> {
  const response = await handleAdminRequest(
    new Request(`${ADMIN_ORIGIN}${path}`, { headers: { cookie } }),
    testEnv(),
  );
  return {
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
    status: response.status,
  };
}

describe('admin の画面一覧の導出（2.4.5）', () => {
  it('導出が画面を 1 枚以上返す（空振りしない）', () => {
    // **`app` の側は 5 枚より多いことを見ている**（`test/page-shell.test.ts`）。admin は
    // まだ 1 枚なので、下限はそこに置く。**0 枚を緑にしない**——導出が壊れると、
    // 以下の検査はすべて「問題なし」を返す。
    expect(getPaths().length).toBeGreaterThan(0);
  });

  it('OAuth の経路は画面として導かれない（例外一覧を両ホストで共有している）', () => {
    // `src/page-paths.ts` の `NON_PAGE_PATHS` は app のために書かれたが、**admin も
    // 同じ 2 経路を持つ**。片方のホストにしか効かない例外を作っていないことを見る。
    const paths = getPaths();
    // **GET の分だけを見る。** ログアウトは POST なので、GET の導出には最初から入らない
    // （`ADMIN_OPEN_ROUTES` はメソッドとパスの組を持つ。#359）。
    const openGets = ADMIN_OPEN_ROUTES.filter((open_) => open_.method === 'GET');
    expect(openGets.length, '開いている GET が 1 つも無い（検査が空振りする）').toBeGreaterThan(0);
    for (const { path } of openGets) {
      expect(NON_PAGE_PATHS, `${path} が例外一覧に無い`).toContain(path);
      expect(paths, `${path} が画面として導かれている`).not.toContain(path);
    }
  });

  it('画面として導いた経路は、すべて HTML を返す', async () => {
    // 導出が拾いすぎていないことの確認。ここが緑なら、以下の検査が「HTML でないので
    // 飛ばした」経路を 1 本も持たない。
    const notHtml: string[] = [];
    for (const path of getPaths()) {
      const { type } = await open(path);
      if (!type.includes('text/html')) {
        notHtml.push(path);
      }
    }
    expect(notHtml).toEqual([]);
  });

  it('/__dev/pages が admin の一覧を返し、ここの導出と一致する（幅の検査が受け取る口。#398）', async () => {
    // **`scripts/check-page-width.sh` はこの口から admin の画面を受け取る**（シェルから
    // 経路表は読めない）。口が admin の一覧を返さなくなると、幅の検査は admin を 1 枚も
    // 開かなくなる——あちらも空を落とすが、**どの層で壊れたかをここで先に言う。**
    const response = await handleAppRequest(
      new Request(`https://${env.APP_HOST}/__dev/pages`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    const { paths, adminPaths } = (await response.json()) as {
      paths: string[];
      adminPaths: string[];
    };
    expect(adminPaths).toEqual(getPaths());
    // **app の一覧を admin として返していない**ことも見る（取り違えても件数だけなら通る）。
    expect(paths).not.toEqual(adminPaths);
  });

  it('画面は 404 ではなく本体を開いている', async () => {
    // **404 も外枠を通しうる。** 本体を開いていないまま「乗っている」と言えないように、
    // ステータスまで見る（#330 / PR #350 が踏んだ形）。
    for (const path of getPaths()) {
      expect((await open(path)).status, `${path}`).toBe(200);
    }
  });
});

describe('admin の全画面の外枠（2.4.5 / #266 と同じ 3 項目）', () => {
  it('どの画面にも admin のヘッダが 1 つある', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(ADMIN_HEADER_MARK).length - 1, `${path} のヘッダの数`).toBe(1);
    }
  });

  it('どの画面にも admin のフッタが 1 つある', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(ADMIN_FOOTER_MARK).length - 1, `${path} のフッタの数`).toBe(1);
    }
  });

  it('どの画面も見た目の土台を 1 本だけ参照している', async () => {
    // **`app.css` を共有する**（`src/admin/shell.ts` の「それでも見た目の土台は共有する」）。
    // 狭い端末で崩れないことの根拠（`max-width` / `overflow-wrap`）があの 1 枚にあり、
    // admin 用に写すと片方だけが腐る。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(`href="${APP_CSS_PATH}"`).length - 1, `${path} の app.css`).toBe(1);
    }
  });

  it('どの画面にも viewport の meta が 1 つある', async () => {
    // #266 の acceptance 3。**狭い端末での表示が成り立つ前提そのものである。**
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split('<meta name="viewport"').length - 1, `${path} の viewport`).toBe(1);
    }
  });

  it('どの画面も noindex である（管理画面が検索結果に出ない）', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body, `${path} の robots`).toContain('<meta name="robots" content="noindex">');
    }
  });

  it('どの画面の題名にも「管理」が入る（タブで見分けられる）', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      const title = /<title>([\s\S]*?)<\/title>/u.exec(body)?.[1] ?? '';
      expect(title, `${path} の title`).toContain('管理');
    }
  });

  it('フッタより後ろに本文が残っていない', async () => {
    // #282 が捕まえた失敗（フッタのあとに節が続く）を admin 側でも見る。
    for (const path of getPaths()) {
      const { body } = await open(path);
      const closing = '</footer>';
      const end = body.lastIndexOf(closing);
      expect(end, `${path} に </footer> が無い`).toBeGreaterThan(-1);
      const rest = body
        .slice(end + closing.length)
        .replaceAll(/<script\b[\s\S]*?<\/script>/gu, '')
        .replaceAll(/<!--[\s\S]*?-->/gu, '')
        .trim();
      expect(rest, `${path} のフッタより後ろに残った本文`).toBe('');
    }
  });

  it('meta が本文（ヘッダ）より前にある', async () => {
    // `<meta>` は本文が始まる前に無ければならない。ヘッダ（`<header>`）は本文である。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.indexOf('<meta name="robots"'), `${path}`).toBeLessThan(
        body.indexOf(ADMIN_HEADER_MARK),
      );
    }
  });
});

describe('admin の外枠が app の行き先を持たない（2.4 の constraints / 4.4）', () => {
  /** app ホストにしか無い行き先（**提供側の定数から取る**）。 */
  const APP_ONLY = [PUBLIC_WORKS_PATH, MY_WORKS_PATH, ACCOUNT_PATH, TERMS_PATH, TAKEDOWN_PATH];

  it('どの画面のヘッダにも app の行き先が無い', async () => {
    // **置けば押しても 404 になるリンクになる**（4.4 / 2.2 が禁じている形）。
    for (const path of getPaths()) {
      const { body } = await open(path);
      const header = /<header class="gf-admin-header">[\s\S]*?<\/header>/u.exec(body)?.[0] ?? '';
      expect(header, `${path} にヘッダが無い`).not.toBe('');
      for (const link of APP_ONLY) {
        expect(header, `${path} のヘッダに ${link} がある`).not.toContain(`href="${link}"`);
      }
    }
  });

  it('どの画面のフッタにも app の行き先が無い', async () => {
    // **利用者向けの 2 区画（サービス / 法務）を持ち込まない。** #41 の「全ページの
    // フッターから削除申請へ到達できる」は**利用者向けの画面についての要求**である。
    for (const path of getPaths()) {
      const { body } = await open(path);
      const footer = /<footer class="gf-admin-footer">[\s\S]*?<\/footer>/u.exec(body)?.[0] ?? '';
      expect(footer, `${path} にフッタが無い`).not.toBe('');
      for (const link of APP_ONLY) {
        expect(footer, `${path} のフッタに ${link} がある`).not.toContain(`href="${link}"`);
      }
    }
  });

  it('利用者向けのヘッダ・フッタの目印が 1 つも出ない', async () => {
    // クラス名で見る。**外枠を取り違えて `siteHead` / `siteFooter` を呼んだ日に赤くなる**
    // ——呼んでも画面は出るので、動作では気づけない。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body, `${path}`).not.toContain('<header class="gf-header">');
      expect(body, `${path}`).not.toContain('<footer class="gf-footer">');
    }
  });

  it('ログインの導線を admin の画面に出さない', async () => {
    // **この画面はログイン済みの管理者しか開けない**（未ログインは 404）。
    // 「ログイン」を出すことに意味が無く、出ていたら出し分けの取り違えである。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body, `${path}`).not.toContain(`href="${LOGIN_PATH}"`);
    }
  });
});

describe('狭い端末で崩れる書き方をしていない（幅 390px の代理検査）', () => {
  // **実ブラウザの検査（`scripts/check-page-width.sh`）に admin は乗っていない**
  // （このファイルの冒頭）。**代理検査は本物の代わりにならない**——#282 の 2 件目は
  // 機械的な代理検査を全部すり抜けた。ここで見るのは、**そのとき原因になった 1 つの
  // 書き方**だけである（`size` / `cols` 属性が layout viewport を広げる）。
  it('input の size / textarea の cols を使っていない', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body, `${path} に size 属性がある`).not.toMatch(/<input[^>]*\ssize=/iu);
      expect(body, `${path} に cols 属性がある`).not.toMatch(/<textarea[^>]*\scols=/iu);
    }
  });
});
