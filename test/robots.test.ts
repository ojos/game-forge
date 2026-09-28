import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdminRoutes, ADMIN_OPEN_ROUTES } from '../src/admin/routes.js';
import { createAppRoutes } from '../src/app.js';
import { NON_PAGE_PATHS } from '../src/page-paths.js';
import { GENERATE_PAGE_PATH } from '../src/paths.js';
import {
  AI_TRAINING_CRAWLERS,
  APP_DISALLOW_PATHS,
  CONTENT_SIGNAL,
  ROBOTS_PATH,
  ROBOTS_TAG_HEADER,
  ROBOTS_TAG_NOINDEX,
} from '../src/robots.js';
import { directiveOf, isAllowed, parseRobotsTxt, productTokenOf } from './helpers/robots-txt.js';
import { applySchema } from './helpers/schema.js';

/**
 * クローラへの意思表示（`/robots.txt` と `X-Robots-Tag`。#594）。
 *
 * **文字列の一致では見ない。** `robots.txt` はグループの集まりで、どの行が効くかは
 * グループの構造で決まる（`test/helpers/robots-txt.ts`）。ここが見るのは
 * 「**このクローラはこのパスを取りに来てよいか**」である。
 */

// 作品の配信は D1 を引く（無い作品でも引きに行く）。表が無いと 500 になり、
// 見たいヘッダの手前で落ちる。
beforeAll(async () => {
  await applySchema();
});

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;

/**
 * 検索・回答用のクローラ（**弾いてはいけない相手**）。
 *
 * **`src/robots.ts` はこの一覧を持たない。** 実装が持つのは拒否する相手だけで、ここは
 * 「許すと決めたのに塞いでいないか」を外から確かめるための一覧である。**実装から導けない**
 * ——導けてしまうと、実装が間違ったときに検査も同じだけ間違う。
 *
 * OGP クローラを含めるのは仕様 5.4 のためである（弾くと共有時にカードが描かれない）。
 */
const SEARCH_AND_ANSWER_CRAWLERS = [
  'Googlebot',
  'Bingbot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Applebot',
  'Twitterbot',
  'facebookexternalhit',
  'Slackbot-LinkExpanding',
];

/**
 * `robots.txt` を取りに行く。
 *
 * @param origin ホストのオリジン
 * @returns 状態・`Content-Type`・本文
 */
async function fetchRobots(origin: string): Promise<{ status: number; type: string | null; body: string }> {
  const res = await SELF.fetch(`${origin}${ROBOTS_PATH}`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

describe('robots.txt を読む側（このファイルの検査そのもの）', () => {
  it('クローラは自分に一致するグループだけに従う', () => {
    const robots = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /api/', '', 'User-agent: GPTBot', 'Disallow: /'].join('\n'),
    );
    // `*` のグループは GPTBot に適用されない。GPTBot 自身のグループだけが効く。
    expect(isAllowed(robots, 'GPTBot', '/')).toBe(false);
    expect(isAllowed(robots, 'GPTBot', '/api/like')).toBe(false);
    // 逆に、名指しされていないクローラは `*` のグループに従う。
    expect(isAllowed(robots, 'Googlebot', '/')).toBe(true);
    expect(isAllowed(robots, 'Googlebot', '/api/like')).toBe(false);
  });

  it('連続する User-agent は同じグループの別名になる', () => {
    const robots = parseRobotsTxt(['User-agent: A', 'User-agent: B', 'Disallow: /'].join('\n'));
    expect(isAllowed(robots, 'A', '/')).toBe(false);
    expect(isAllowed(robots, 'B', '/')).toBe(false);
    expect(isAllowed(robots, 'C', '/')).toBe(true);
  });

  it('長く一致したルールが勝ち、同じ長さなら Allow が勝つ', () => {
    const robots = parseRobotsTxt(['User-agent: *', 'Disallow: /a/', 'Allow: /a/b/'].join('\n'));
    expect(isAllowed(robots, 'X', '/a/z')).toBe(false);
    expect(isAllowed(robots, 'X', '/a/b/c')).toBe(true);
  });

  it('値の空の Disallow は何も禁じない', () => {
    const robots = parseRobotsTxt(['User-agent: *', 'Disallow:'].join('\n'));
    expect(isAllowed(robots, 'X', '/')).toBe(true);
  });

  it('実運用の綴り（GPTBot/1.0）でも、product token で照合する', () => {
    // RFC 9309 §2.2.1: クローラは自分の product token でグループを選ぶ。**版を含む識別文字列を
    // 渡されても同じ判定になること**を固定する。ここが `*` へ落ちると、拒否したはずの
    // クローラを「許可されている」と読む誤った緑になる（PR #596 の Copilot の指摘）。
    const robots = parseRobotsTxt(['User-agent: *', 'Allow: /', '', 'User-agent: GPTBot', 'Disallow: /'].join('\n'));
    expect(isAllowed(robots, 'GPTBot', '/')).toBe(false);
    expect(isAllowed(robots, 'GPTBot/1.0', '/')).toBe(false);
    expect(isAllowed(robots, 'gptbot/2.3', '/')).toBe(false);
    expect(productTokenOf('GPTBot/1.0')).toBe('GPTBot');
  });

  it('product token にならない綴りは、黙って通さずに投げる', () => {
    // **`*` のグループへ落とさない。** 落とすと「許可されている」と読めてしまい、
    // 渡す側の綴りの誤りが緑のまま埋もれる。
    const robots = parseRobotsTxt(['User-agent: *', 'Disallow: /'].join('\n'));
    // 完全な識別文字列は、先頭を採ると `Mozilla` になり、**GPTBot なのに `*` のグループで
    // 判定してしまう。** 推測せずに投げる。
    expect(() => isAllowed(robots, 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://example.test)', '/')).toThrow(
      /product token/u,
    );
    expect(() => isAllowed(robots, '名前を知らないクローラ', '/')).toThrow(/product token/u);
    expect(() => productTokenOf('')).toThrow(/product token/u);
  });

  it('コメントは読まない', () => {
    const robots = parseRobotsTxt(['# User-agent: *', '# Disallow: /', 'User-agent: *', 'Disallow: /x'].join('\n'));
    expect(isAllowed(robots, 'X', '/')).toBe(true);
    expect(isAllowed(robots, 'X', '/x')).toBe(false);
  });
});

describe('3 つのホストが、それぞれ違うことを言う', () => {
  it('どのホストも text/plain の 200 で返す', async () => {
    for (const origin of [APP_ORIGIN, SANDBOX_ORIGIN, ADMIN_ORIGIN]) {
      const { status, type, body } = await fetchRobots(origin);
      expect(status, origin).toBe(200);
      expect(type, origin).toBe('text/plain; charset=utf-8');
      expect(body.length, origin).toBeGreaterThan(0);
    }
  });

  it('3 つの中身が互いに違う（どれかの写しになっていない）', async () => {
    const [app, sandbox, admin] = await Promise.all(
      [APP_ORIGIN, SANDBOX_ORIGIN, ADMIN_ORIGIN].map(async (origin) => (await fetchRobots(origin)).body),
    );
    expect(new Set([app, sandbox, admin]).size).toBe(3);
  });

  it('サンドボックスと管理画面は、どのクローラにも全面拒否である', async () => {
    for (const origin of [SANDBOX_ORIGIN, ADMIN_ORIGIN]) {
      const robots = parseRobotsTxt((await fetchRobots(origin)).body);
      for (const agent of [...SEARCH_AND_ANSWER_CRAWLERS, ...AI_TRAINING_CRAWLERS, 'SomeUnknownBot']) {
        expect(isAllowed(robots, agent, '/'), `${origin} / ${agent}`).toBe(false);
      }
    }
  });

  it('管理画面の robots.txt は、ログインしていなくても返る', async () => {
    // **クローラはログインしない。** 既定が「閉」の admin ホストで、ここだけが開いている
    // （`src/admin/routes.ts` の `ADMIN_OPEN_ROUTES`）。cookie を 1 つも送らずに確かめる。
    const res = await SELF.fetch(`${ADMIN_ORIGIN}${ROBOTS_PATH}`);
    expect(res.status).toBe(200);
  });

  it('管理画面で開いているのは GET だけである（POST は 404 のまま）', async () => {
    const res = await SELF.fetch(`${ADMIN_ORIGIN}${ROBOTS_PATH}`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('どのホストも HEAD で返り、POST は受け付けない', async () => {
    // **サンドボックスだけが素通りしていた**（経路表を持たないので、メソッドの判定も
    // 自前で要る）。app は `dispatch` が 405 と `Allow` を返し、admin は存在を隠して 404。
    // **3 ホストの振る舞いを 1 か所で固定する**——揃っていないことに次に気づく道が無い。
    for (const origin of [APP_ORIGIN, SANDBOX_ORIGIN, ADMIN_ORIGIN]) {
      expect((await SELF.fetch(`${origin}${ROBOTS_PATH}`, { method: 'HEAD' })).status, origin).toBe(200);
    }
    for (const origin of [APP_ORIGIN, SANDBOX_ORIGIN]) {
      const res = await SELF.fetch(`${origin}${ROBOTS_PATH}`, { method: 'POST' });
      expect(res.status, origin).toBe(405);
      expect(res.headers.get('allow'), origin).toBe('GET, HEAD');
    }
  });
});

describe('app ホスト: 検索は許し、学習は拒む', () => {
  it('学習用のクローラは、トップも作品ページも取りに来られない', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    for (const agent of AI_TRAINING_CRAWLERS) {
      expect(isAllowed(robots, agent, '/'), agent).toBe(false);
      expect(isAllowed(robots, agent, '/works/some-game-id'), agent).toBe(false);
    }
  });

  it('検索用・回答用と OGP のクローラは弾かれていない', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    for (const agent of SEARCH_AND_ANSWER_CRAWLERS) {
      expect(isAllowed(robots, agent, '/'), agent).toBe(true);
      expect(isAllowed(robots, agent, '/works/some-game-id'), agent).toBe(true);
      expect(isAllowed(robots, agent, '/@handle'), agent).toBe(true);
    }
  });

  it('事業者ではなく用途で分けている（同じ事業者の検索用は通る）', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    // 学習用は拒み、同じ事業者の検索・回答用は通す。ここが崩れると ai-input=yes と矛盾する。
    for (const [training, answering] of [
      ['GPTBot', 'OAI-SearchBot'],
      ['ClaudeBot', 'Claude-User'],
      ['Google-Extended', 'Googlebot'],
      ['Applebot-Extended', 'Applebot'],
    ]) {
      expect(isAllowed(robots, training!, '/'), training).toBe(false);
      expect(isAllowed(robots, answering!, '/'), answering).toBe(true);
    }
  });

  it('Content-Signal が search=yes, ai-input=yes, ai-train=no である', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    expect(directiveOf(robots, 'content-signal')).toBe(CONTENT_SIGNAL);
    expect(CONTENT_SIGNAL).toBe('search=yes, ai-input=yes, ai-train=no');
  });

  it('Disallow した口には、検索クローラも来ない', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    for (const path of APP_DISALLOW_PATHS) {
      expect(isAllowed(robots, 'Googlebot', path), path).toBe(false);
    }
  });

  it('公開面は Disallow していない', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    // 一覧・作品・作者・お知らせ・法務。ここが塞がると、載せたいものが載らなくなる。
    for (const path of ['/', '/works', '/works/some-game-id', '/@handle', '/news', '/faq', '/terms', '/privacy']) {
      expect(isAllowed(robots, 'Googlebot', path), path).toBe(true);
    }
  });
});

describe('Disallow の綴りが、実装から離れていない', () => {
  it('Disallow に書いた綴りは、すべて経路表に実在する', () => {
    // **綴りを間違えると、その行は何にも当たらない無効な行になる**（robots.txt は
    // 誤りを報告しない）。経路表と突き合わせて、黙って効かなくなることを塞ぐ。
    const paths = createAppRoutes(env).map((route) => route.path);
    for (const disallowed of APP_DISALLOW_PATHS) {
      const found = paths.some((path) => path === disallowed || path.startsWith(disallowed));
      expect(found, `${disallowed} で始まる経路が 1 つも無い`).toBe(true);
    }
  });

  it('Disallow に、noindex で消したい画面を混ぜていない', () => {
    // **`Disallow` するとクロールされず、`<meta name="robots">` も読まれない。**
    // 本人だけの画面は `noindex` に任せる側で、ここへ足すと索引から消せなくなる。
    // 逆に、ここに並んでよいのは機械が読む口とログインが要る操作の口だけである。
    for (const disallowed of APP_DISALLOW_PATHS) {
      expect(['/api/', '/auth/', '/account', '/works/mine', '/works/liked', '/invites']).toContain(
        disallowed,
      );
    }
  });

  it('未ログインで 200 を返す画面を Disallow していない（#795）', async () => {
    // **並ぶ資格を綴りの一覧ではなく実測で確かめる**（`src/robots.ts` の `APP_DISALLOW_PATHS`）。
    // #594 は `/generate` をここへ並べたが、**あの画面は未ログインでも 200 を返す公開ページ**で、
    // 「ログインしなければ何も返らない」に当たっていなかった（#795）。**上の綴りの一覧だけでは
    // 捕まらない**——一覧は「この 6 つのどれか」しか見ず、その口が本当に何も返さないかは見ない。
    for (const disallowed of APP_DISALLOW_PATHS) {
      // 接頭辞（`/api/`・`/auth/`）はそれ自体が開ける画面ではない。**完全一致の口だけを見る。**
      if (disallowed.endsWith('/')) {
        continue;
      }
      const res = await SELF.fetch(`${APP_ORIGIN}${disallowed}`, { redirect: 'manual' });
      expect(
        res.status,
        `${disallowed} は未ログインで ${res.status} を返す。何かを返す画面なら Disallow ではなく noindex の側である`,
      ).not.toBe(200);
    }
  });

  it('/generate はクロールを許している（未ログインでも中身を返す公開ページだから。#795）', async () => {
    const robots = parseRobotsTxt((await fetchRobots(APP_ORIGIN)).body);
    expect(isAllowed(robots, 'Googlebot', GENERATE_PAGE_PATH)).toBe(true);
    // **許していることと、実際に中身があることの両方を見る。** 片方だけだと、
    // 画面がログイン必須へ変わった日に `Disallow` を戻し忘れても緑のままになる。
    const res = await SELF.fetch(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<meta name="robots" content="noindex">');
  });

  it('robots.txt は画面の検査から外れている（text/plain であって画面ではない）', () => {
    expect(NON_PAGE_PATHS).toContain(ROBOTS_PATH);
  });

  it('admin の経路表と、未ログインで通す一覧の両方に登録されている', () => {
    expect(createAdminRoutes().some((route) => route.method === 'GET' && route.path === ROBOTS_PATH)).toBe(true);
    expect(ADMIN_OPEN_ROUTES.some((open) => open.method === 'GET' && open.path === ROBOTS_PATH)).toBe(true);
  });
});

describe('HTML 以外の応答に X-Robots-Tag を付ける', () => {
  it('アイコンの配信に付く（存在しない利用者の透明な 1px にも）', async () => {
    const res = await SELF.fetch(`${SANDBOX_ORIGIN}/avatars/00000000-0000-4000-8000-000000000000.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get(ROBOTS_TAG_HEADER)).toBe(ROBOTS_TAG_NOINDEX);
  });

  it('作品の配信に付く（見つからない場合も含め、この経路のすべての応答に）', async () => {
    // 実体のある作品はほかのテストが作る。ここは**経路が返すすべての応答に付く**ことを見る
    // ——付け忘れは「ある作品にだけ付かない」形ではなく「この経路に付かない」形で起きる。
    for (const path of ['/g/00000000-0000-4000-8000-000000000000/', '/p/0123456789abcdef0123456789abcdef/']) {
      const res = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get(ROBOTS_TAG_HEADER), path).toBe(ROBOTS_TAG_NOINDEX);
    }
  });
});
