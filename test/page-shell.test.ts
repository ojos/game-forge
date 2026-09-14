import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH, LOGOUT_PATH } from '../src/auth/google.js';
import { DRAFT_STATUS } from '../src/games.js';
import {
  APP_CSS_PATH,
  BREADCRUMB_PARENTS,
  LOGO_DIR,
  LOGO_HEIGHT,
  LOGO_SCALES,
  LOGO_WIDTH,
  breadcrumbLabelOf,
  siteLogo,
} from '../src/html.js';
import { TAKEDOWN_PATH, TERMS_PATH } from '../src/legal.js';
import { FAQ_PATH, PRIVACY_PATH } from '../src/legal-paths.js';
import { LIKED_WORKS_PATH } from '../src/liked-works-paths.js';
import { OGP_IMAGE_HEIGHT, OGP_IMAGE_WIDTH } from '../src/ogp.js';
import { NON_PAGE_PATHS, ancestorPathsOf, ssrPagePaths } from '../src/page-paths.js';
import { NEWS_PATH } from '../src/news-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH, INVITES_PATH, SIGNUP_PATH } from '../src/paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { HANDLE_PAGE_PREFIX } from '../src/handle-paths.js';
import { AUTHOR_PAGE_PREFIX } from '../src/users-page-paths.js';
import { WORK_PAGE_PREFIX } from '../src/work-page.js';
import { MAX_SEARCH_LENGTH, WORK_SEARCH_FIELD } from '../src/work-search.js';
import { WORK_SOURCE_PREFIX } from '../src/work-source.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 全 SSR 画面に共通する外枠の検査（#282）。
 *
 * # なぜ経路表から導くのか
 *
 * **画面の一覧をここへ書き写さない。** 書き写すと、画面を 1 枚足した日から
 * 「検査が見ている一覧」と「実際に配られている画面」が静かにずれる
 * （`.ai-playbook/shared-ai-rules.md` 12 章）。この検査が捕まえたいのは
 * まさに「足した画面が外枠に乗っていない」ことなので、一覧を写した時点で
 * 目的を失う。`createAppRoutes` が返す経路表そのものを歩く。
 *
 * # なぜ「末尾」ではなく「フッタより後ろに本文が無い」なのか
 *
 * `/generate` はフッタのあとに `<script>` を置く（`src/generate-page.ts`）。
 * 「文字列の末尾がフッタであること」を条件にすると、**正しい画面が赤くなる。**
 * 一方 #282 で見つかった `/signup` の不具合は「フッタのあとに `<h2>` が 2 節続く」で、
 * 見たいのは**本文が後ろに残っていないこと**である。`<script>` と空白・コメントだけを
 * 許し、それ以外のタグが 1 つでも現れたら赤にする。
 *
 * # 飛ばした経路を黙って緑にしない
 *
 * HTML を返さない GET 経路（ログイン開始のリダイレクト等）は検査できない。
 * **その集合を明示して突き合わせる。** 一覧を持つのは画面の側ではなく例外の側で、
 * 画面を足したときは自動で検査対象に入り、HTML を返さない経路を足したときだけ
 * 赤くなって説明を求められる（失敗の向きを閉じる側へ倒す）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-page-shell-checks-1';

/** 共通フッタの目印（`src/legal.ts` の `siteFooter`）。 */
const FOOTER_MARK = '<footer class="gf-footer">';

/** 見た目の土台への参照（`src/html.ts` の `siteHead`）。 */
const CSS_LINK_MARK = `<link rel="stylesheet" href="${APP_CSS_PATH}">`;

/** viewport の `meta`。 */
const VIEWPORT_MARK = '<meta name="viewport"';

/** 共通ヘッダの目印（`src/html.ts` の `siteHeader`）。 */
const HEADER_MARK = '<header class="gf-header">';

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

let cookie = '';
let gameId = '';
let publishedGameId = '';
/** 作品を持つ作者のハンドル名（`/@` へ補う。#381。作者ページの本体はこの綴りで開く）。 */
let authorHandle = '';
/**
 * `/users/` へ補う利用者 id（#381）。**ハンドル名を決めていない利用者である**——決めている利用者の
 * `/users/<id>` は `/@handle` へ 301 で送るので、200 の画面の本体を見られない。
 */
let plainAuthorId = '';

beforeAll(async () => {
  await applySchema();

  const userId = `shell-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.test`, '外枠検査', Math.floor(Date.now() / 1000))
    .run();

  // **作者にハンドル名を決めておく**（#381）。テストファイルをまたいで表を共有するので、綴りに乱数を入れる。
  authorHandle = `shell_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await env.DB.prepare('insert into handles (handle, user_id, claimed_at) values (?, ?, 1)')
    .bind(authorHandle, userId)
    .run();
  plainAuthorId = `shell-plain-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(plainAuthorId, `sub-${plainAuthorId}`, `${plainAuthorId}@example.test`, '外枠検査（ハンドル名なし）', 1)
    .run();

  gameId = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
     values (?, ?, ?, ?, '', ?, 'ready')`,
  )
    .bind(gameId, userId, DRAFT_STATUS, '外枠検査の作品', Math.floor(Date.now() / 1000))
    .run();

  // **公開済みの作品も仕込む。** OGP の `meta` は公開済みのときだけ出るので、
  // draft だけで順序を見ると**検査が空振りしたまま緑になる**（`src/work-page.ts` の
  // `ogpMeta`）。飛ばしたことに気づけない検査を置かない。
  publishedGameId = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, published_at,
                        generation_state, preview_key)
     values (?, ?, 'published', ?, '', ?, ?, 'ready', ?)`,
  )
    .bind(
      publishedGameId,
      userId,
      '外枠検査の公開作品',
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000),
      'shell-check-preview',
    )
    .run();

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  cookie = buildSessionCookie(token, 3600).split(';')[0]!;
});

/**
 * 前方一致の経路に補う id（接頭辞ごと）。
 *
 * **接頭辞ごとに違う表の id が要る**（#330 / PR #350 の Copilot code review の指摘）。
 * `/users/` へ作品の id を補うと**作者ページの 404 の画面しか見ない**ので、外枠の検査も
 * 幅の検査も**画面の本体を 1 度も開かないまま緑になる。**
 *
 * **綴りは定数から取る**（`WORK_PAGE_PREFIX` / `AUTHOR_PAGE_PREFIX`）。書き写すと、
 * 綴りを変えた日に検査だけが古い接頭辞を見続ける。
 *
 * **同じ規則を `scripts/lib/dev-fixture.sh` の `dev_fixture_paths` も持つ**（あちらは
 * シェルなのでこのモジュールを import できない）。**片方だけが古くなることは
 * {@link getPaths} が塞ぐ**——知らない接頭辞が来たら落ちる。
 *
 * @returns 接頭辞 → 補う id
 */
function prefixIds(): Record<string, string> {
  // **ソースの閲覧（#383）は公開済みの作品の id を補う。** draft の id では 404 しか見られない。
  return {
    [WORK_PAGE_PREFIX]: gameId,
    [AUTHOR_PAGE_PREFIX]: plainAuthorId,
    // **ハンドル名の作者ページ（#381）は 1 セグメントの経路である**（`src/routes.ts` の `segment`）。
    [HANDLE_PAGE_PREFIX]: authorHandle,
    [WORK_SOURCE_PREFIX]: publishedGameId,
  };
}

/**
 * 検査対象の画面パスを、経路表から導いて実際に開ける形へ落とす。
 *
 * 導出そのものは `src/page-paths.ts` が持つ。**ここで条件を書き直さない**——
 * 実ブラウザ側の検査（`scripts/check-page-width.sh`）と同じ一覧を見る必要がある。
 *
 * **知らない前方一致の経路が来たら落とす。** 画面を 1 枚足した人に「何を補うか」を
 * 決めさせる形にする——黙って裸の接頭辞を開くと、**その画面は 404 だけを見られて
 * 緑になる**（#330 の前が実際にそうなっていた）。`src/page-paths.ts` が
 * 「一覧を持つのは画面ではなく例外の側である」と書いているのと同じ向きである。
 *
 * @returns パスの配列
 */
function getPaths(): string[] {
  const ids = prefixIds();
  const routes = createAppRoutes(testEnv());
  // **続きを補う経路は、経路表の `match` から決める**（前方一致と、1 セグメントの経路。#381）。
  // `/@` は `/` で終わらないので、綴りの末尾だけを見ると裸のまま開いて 404 を見る。
  const openEnded = new Set(
    routes.filter((route) => route.match === 'prefix' || route.match === 'segment').map((route) => route.path),
  );
  return ssrPagePaths(routes).map((path) => {
    if (!openEnded.has(path)) {
      return path;
    }
    const id = ids[path];
    if (id === undefined) {
      throw new Error(
        `前方一致の経路 ${path} に補う id が決まっていません。` +
          `test/page-shell.test.ts の prefixIds と scripts/lib/dev-fixture.sh の` +
          ` dev_fixture_paths の両方へ足してください。`,
      );
    }
    return `${path}${id}`;
  });
}

/**
 * 1 経路を開いて、本文と content-type を返す。
 *
 * @param path パス
 * @param sessionCookie 送る cookie（空文字なら未ログインとして開く）
 * @returns 応答の本文・content-type・ステータス・遷移先
 */
async function open(
  path: string,
  sessionCookie: string = cookie,
): Promise<{ body: string; type: string; status: number; location: string }> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${path}`, {
      headers: sessionCookie === '' ? {} : { cookie: sessionCookie },
    }),
    testEnv(),
  );
  return {
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
    status: response.status,
    location: response.headers.get('location') ?? '',
  };
}

/** 未ログインとして開くときに渡す cookie。 */
const NO_COOKIE = '';

/**
 * HTML からヘッダの区画だけを取り出す。
 *
 * **本文を巻き込まない。** ヘッダに置かないと決めたものが**本文には在る**画面が
 * 実際にある（「あなたの作品」は `/works/liked` への導線を本文に持つ。2.3.7）。
 * 全文で照合すると、その画面が正しいのに赤くなる。
 *
 * @param body HTML
 * @returns `<header>` の中身（見つからなければ null）
 */
function headerOf(body: string): string | null {
  return /<header class="gf-header">[\s\S]*?<\/header>/u.exec(body)?.[0] ?? null;
}

/**
 * ヘッダの中から、アカウントのメニュー（`<details>`）だけを取り出す（#372）。
 *
 * @param header {@link headerOf} の戻り値
 * @returns `<details>` の中身（無ければ null）
 */
function accountMenuOf(header: string): string | null {
  return /<details class="gf-account-menu">[\s\S]*?<\/details>/u.exec(header)?.[0] ?? null;
}

/**
 * HTML からパンくずの区画だけを取り出す（#372）。
 *
 * @param body HTML
 * @returns パンくずの中身（無ければ null）
 */
function breadcrumbOf(body: string): string | null {
  return /<nav class="gf-breadcrumb"[\s\S]*?<\/nav>/u.exec(body)?.[0] ?? null;
}

/**
 * HTML の中の、ログアウトへ送るフォームの開始タグを数えるために拾う。
 *
 * **`<form>` の開始タグを見る。** `/auth/logout` という文字列があることだけを見ると、
 * 押せない場所（説明文やコメント）にあっても緑になる（#362 の検査と同じ理由）。
 *
 * @param body HTML
 * @returns ログアウトへ送る `<form>` の開始タグ
 */
function logoutFormsOf(body: string): string[] {
  return (body.match(/<form[^>]*>/gu) ?? []).filter((tag) =>
    tag.includes(`action="${LOGOUT_PATH}"`),
  );
}

/**
 * HTML の断片から `href` の値をすべて拾う。
 *
 * @param fragment HTML の断片
 * @returns `href` の値
 */
function hrefsOf(fragment: string): string[] {
  return [...fragment.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]!);
}

/**
 * HTML からフッタの区画だけを取り出す。
 *
 * @param body HTML
 * @returns `<footer>` の中身（見つからなければ null）
 */
function footerOf(body: string): string | null {
  return /<footer class="gf-footer">[\s\S]*?<\/footer>/u.exec(body)?.[0] ?? null;
}

/**
 * CSS から、あるセレクタを含む規則の本体をすべて取り出す。
 *
 * **完全な CSS パーサを書かない。** 見たいのは 1 つの宣言の写しが腐っていないかで、
 * `app.css` は入れ子を持たない素の CSS 1 枚である（#266 の constraints）。
 *
 * **1 つ目で打ち切らない。** 同じセレクタが複数の規則に現れる（`.gf-frame` は
 * `.gf-context, .gf-frame` と単独の規則の両方に出る）ので、打ち切ると宣言を
 * 持たない側だけを見て落ちる。
 *
 * @param css CSS の全文
 * @param selector 探すセレクタ
 * @returns `{ ... }` の中身の配列
 */
function ruleBlocksOf(css: string, selector: string): string[] {
  const blocks: string[] = [];
  for (let from = 0; ; ) {
    const at = css.indexOf(selector, from);
    if (at < 0) {
      return blocks;
    }
    from = at + selector.length;
    // `.gf-shot` が `.gf-shot-pending` に当たらないようにする。
    if (/[\w-]/u.test(css[from] ?? '')) {
      continue;
    }
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    if (open < 0 || close < 0) {
      return blocks;
    }
    blocks.push(css.slice(open + 1, close));
    from = close;
  }
}

/**
 * HTML の末尾から `<script>` ブロック・コメント・空白を取り除く。
 *
 * @param tail フッタより後ろの HTML
 * @returns 残り
 */
function stripAllowedTail(tail: string): string {
  return tail
    .replaceAll(/<script\b[\s\S]*?<\/script>/gu, '')
    .replaceAll(/<!--[\s\S]*?-->/gu, '')
    .trim();
}

describe('全 SSR 画面の外枠', () => {
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

  it('画面でないと宣言した経路は、本当に HTML を返さない', async () => {
    // 逆向き。例外一覧へ画面を紛れ込ませて検査から逃がす経路を塞ぐ。
    for (const path of NON_PAGE_PATHS) {
      const { type } = await open(path === '/ogp/' ? '/ogp/none' : path);
      expect(type, `${path} の content-type`).not.toContain('text/html');
    }
  });

  it('検査対象の画面が 1 枚も無い、という状態にはならない', () => {
    expect(getPaths().length).toBeGreaterThan(5);
  });

  it('前方一致の経路は、404 ではなく画面の本体を開いている（#330 / PR #350）', async () => {
    // **これが無いと、以下の検査は 404 の画面だけを見て緑になれる。** 404 も `siteHead`
    // を通るので、外枠（フッタ・CSS・viewport）はすべて揃っている——**足した画面の本体を
    // 1 度も開かないまま「乗っている」と言える。** #330 の前は `/users/` が実際にそう
    // なっていた（裸の接頭辞を開いていた）。
    const paths = getPaths().filter((path) =>
      Object.keys(prefixIds()).some((prefix) => path.startsWith(prefix) && path.length > prefix.length),
    );
    // 前方一致の経路が 1 本も無い状態を緑にしない（`prefixIds` が空になっても通る形を置かない）。
    expect(Object.keys(prefixIds()).length).toBeGreaterThan(1);

    for (const prefix of Object.keys(prefixIds())) {
      const path = paths.find((candidate) => candidate.startsWith(prefix));
      expect(path, `${prefix} に補った経路が一覧に無い`).toBeDefined();
      const response = await handleAppRequest(
        new Request(`${APP_ORIGIN}${path!}`, { headers: { cookie } }),
        testEnv(),
      );
      expect(response.status, `${path!} が 404 です（id が正しい表のものか確認）`).toBe(200);
    }

    // **作者ページは、作者の名前を出す本体であること**まで見る（200 を返す別の画面に
    // すり替わっても落ちるようにする）。
    const authorBody = (await open(`${HANDLE_PAGE_PREFIX}${authorHandle}`)).body;
    expect(authorBody).toContain('<h1>外枠検査</h1>');
    // 公開済みの作品を仕込んであるので、カードも並ぶ（作者ページの主役である）。
    expect(authorBody).toContain(publishedGameId);
  });

  it('どの画面にも共通フッタが 1 つある', async () => {
    for (const path of getPaths()) {
      const { body, type } = await open(path);
      if (!type.includes('text/html')) {
        continue;
      }
      expect(body.split(FOOTER_MARK).length - 1, `${path} のフッタの数`).toBe(1);
    }
  });

  it('どの画面も見た目の土台を 1 本だけ参照している', async () => {
    // #266 の acceptance 1。**1 本ずつ**を見るので、二重に足した場合も赤くなる。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(CSS_LINK_MARK).length - 1, `${path} の app.css への link`).toBe(1);
    }
  });

  it('どの画面にも共通ヘッダが 1 つある', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(HEADER_MARK).length - 1, `${path} のヘッダの数`).toBe(1);
    }
  });

  it('どの画面のヘッダにもトップへのリンクとして、フッタにも画像として、ロゴが 1 つずつある（#440）', async () => {
    for (const path of getPaths()) {
      const { body } = await open(path);
      const header = headerOf(body);
      const footer = footerOf(body);
      expect(header, `${path} のヘッダ`).not.toBeNull();
      expect(footer, `${path} のフッタ`).not.toBeNull();
      expect(header!.split(siteLogo()).length - 1, `${path} のヘッダのロゴ`).toBe(1);
      expect(footer!.split(siteLogo()).length - 1, `${path} のフッタのロゴ`).toBe(1);
      expect(header, `${path} のヘッダのロゴはトップへのリンク`).toContain(
        `<a class="gf-header-logo" href="${HOME_PATH}">${siteLogo()}</a>`,
      );
      // **フッタのロゴはリンクにしない**（`src/legal.ts` の `siteFooter`「トップへを持たない」）。
      expect(footer, `${path} のフッタのロゴは画像だけ`).toContain(`<div class="gf-footer-logo">${siteLogo()}</div>`);
      expect(footer, `${path} のフッタにトップへのリンクが無い`).not.toContain(`href="${HOME_PATH}"`);
    }
  });

  it('ロゴの画像は明暗で切り替わり、読み上げに「Game Forge」を渡す（#440）', () => {
    const logo = siteLogo();
    expect(logo).toContain('<source media="(prefers-color-scheme: dark)"');
    expect(logo).toContain('alt="Game Forge"');
    expect(logo).toContain(`width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}"`);
    for (const scale of LOGO_SCALES) {
      expect(logo, `${scale} 倍の明るい地の画像`).toContain(`${LOGO_DIR}/lockup-horizontal-x${scale}-for-light-bg.png ${scale}x`);
      expect(logo, `${scale} 倍の暗い地の画像`).toContain(`${LOGO_DIR}/lockup-horizontal-x${scale}-for-dark-bg.png ${scale}x`);
    }
    // 暗い地の画像は <source> にだけ、明るい地の画像は <img> にだけある（取り違えるとロゴが消える）。
    const source = /<source[^>]*>/u.exec(logo)![0];
    const img = /<img[^>]*>/u.exec(logo)![0];
    expect(source).not.toContain('for-light-bg');
    expect(img).not.toContain('for-dark-bg');
  });

  it('ロゴの画像のパスが、経路表のどの path とも衝突しない（#440）', () => {
    // 見た目の土台（app.css）と同じ理由で見る——衝突すると Pages が静的ファイルを先に返し、経路が黙って消える。
    for (const scale of LOGO_SCALES) {
      for (const bg of ['light', 'dark'] as const) {
        const asset = `${LOGO_DIR}/lockup-horizontal-x${scale}-for-${bg}-bg.png`;
        for (const route of createAppRoutes(testEnv())) {
          if (route.match === 'prefix') {
            expect(asset.startsWith(route.path), `${asset} が prefix 経路 ${route.path} に飲み込まれます`).toBe(false);
          } else {
            expect(route.path, `経路とロゴの画像のパスが同じです: ${asset}`).not.toBe(asset);
          }
        }
      }
    }
  });

  it('共通ヘッダが OGP の meta より後ろにある', async () => {
    // **`<meta>` は本文が始まる前に無ければならない。** ヘッダは本文なので、
    // 順序が入れ替わると OGP の meta が本文へ落ち、共有時に読まれなくなる。
    const { body } = await open(`${WORK_PAGE_PREFIX}${publishedGameId}`);
    const ogp = body.indexOf('<meta property="og:');
    // **条件で飛ばさない。** OGP が出ない画面を渡していたら、この行が赤くなる。
    expect(ogp, 'この画面が OGP の meta を出していません（検査が空振りします）').toBeGreaterThan(-1);
    expect(ogp, 'og: の meta がヘッダより後ろにあります').toBeLessThan(body.indexOf(HEADER_MARK));
  });

  it('どの画面にも viewport の meta が 1 つある', async () => {
    // #266 の acceptance 3。狭い端末での表示が成り立つ前提そのものである。
    for (const path of getPaths()) {
      const { body } = await open(path);
      expect(body.split(VIEWPORT_MARK).length - 1, `${path} の viewport meta`).toBe(1);
    }
  });

  it('見た目の土台のパスが、経路表のどの path とも衝突しない', () => {
    // #266 の acceptance 2。**衝突すると Pages が静的ファイルを先に返すため、
    // 経路が黙って消える**（`functions/[[path]].ts` の冒頭。`index.html` を置くと
    // `/` が隠れることは実測済み）。`exact` と `prefix` の両方を見る。
    for (const route of createAppRoutes(testEnv())) {
      if (route.match === 'prefix') {
        expect(
          APP_CSS_PATH.startsWith(route.path),
          `${APP_CSS_PATH} が prefix 経路 ${route.path} に飲み込まれます`,
        ).toBe(false);
      } else {
        expect(route.path, '経路と app.css のパスが同じです').not.toBe(APP_CSS_PATH);
      }
    }
  });

  it('作品枠の縦横比が、撮影の大きさと揃っている', () => {
    // CSS からは `src/ogp.ts` の定数を読めないので、app.css の中の数値は写しになる。
    // **写しは必ず腐る**ので、ここで機械照合する（shared-ai-rules.md 12 章）。
    // 揃っていないと、読み込みが終わった瞬間に版面が飛ぶ（#30）。
    //
    // **見るのは作品を写す 3 つだけである。** `aspect-ratio` の出現をすべて縛ると、
    // 作品と無関係な用途で 1 つ足した日に落ちる。写しを腐らせない目的は変わらない。
    // **`.gf-card-shot` は #328 で増えた**（一覧・トップ・作者ページが共有するカードの
    // 画像。揃っていないと画像が届いた瞬間に格子全体が飛ぶ）。
    const expected = `aspect-ratio: ${OGP_IMAGE_WIDTH} / ${OGP_IMAGE_HEIGHT};`;
    for (const selector of ['.gf-shot', '.gf-frame', '.gf-card-shot']) {
      const blocks = ruleBlocksOf(env.TEST_APP_CSS, selector);
      expect(blocks.length, `app.css に ${selector} の規則が見つかりません`).toBeGreaterThan(0);
      expect(
        blocks.some((block) => block.includes(expected)),
        `${selector} のどの規則にも ${expected} がありません`,
      ).toBe(true);
    }
  });

  it('見た目の土台が Functions ではなく静的に配られる宣言になっている', () => {
    // **`functions/[[path]].ts` は catch-all である。** `exclude` から外れると、
    // `public/` に実体があっても Pages は Functions へ流し、404 になる（#266 で実測）。
    // **経路表との衝突を見るだけでは、この回帰は捕まらない。**
    const routes = JSON.parse(env.TEST_ROUTES_JSON) as {
      include?: string[];
      exclude?: string[];
    };
    const excluded = (routes.exclude ?? []).some((pattern) =>
      pattern.endsWith('*')
        ? APP_CSS_PATH.startsWith(pattern.slice(0, -1))
        : pattern === APP_CSS_PATH,
    );
    expect(excluded, `${APP_CSS_PATH} が _routes.json の exclude に入っていません`).toBe(true);
  });

  it('フッタより後ろに本文が残っていない', async () => {
    for (const path of getPaths()) {
      const { body, type } = await open(path);
      if (!type.includes('text/html')) {
        continue;
      }
      const closing = '</footer>';
      const end = body.lastIndexOf(closing);
      expect(end, `${path} に </footer> が無い`).toBeGreaterThan(-1);
      const rest = stripAllowedTail(body.slice(end + closing.length));
      expect(rest, `${path} のフッタより後ろに残った本文`).toBe('');
    }
  });
});

/**
 * ヘッダとフッタのナビ（2.3.7 / #331）。
 *
 * # なぜ経路表から導くのか
 *
 * 上の外枠の検査と同じ理由である。**画面の一覧をここへ書き写さない。** #331 が置こうと
 * しているのは「どの画面からでも探す・つくる・自分の作品へ移れる」状態であり、
 * **画面を 1 枚足した日に片方だけが追随する形にしない。**
 *
 * # なぜ両方の状態を開くのか
 *
 * **ヘッダがログイン状態で出し分かれることは、HTML を共有キャッシュへ載せられない理由
 * そのものである**（仕様 2.3.3 の条件 3）。片方の状態しか見ない検査は、**出し分けが
 * 消えたことに気づけない**——消えても画面は正しく見える。
 *
 * # 綴りはそれぞれの定数から取る
 *
 * パスを文字列で書かない。`src/html.ts` から取ると**検査が実装の写しになる**（同じ
 * 値どうしを比べて必ず緑になる）ので、**画面を提供している側の定数**を読む
 * （`MY_WORKS_PATH` は `src/works-paths.ts`、`ACCOUNT_PATH` は `src/account-paths.ts`）。
 */
describe('ヘッダとフッタのナビ（2.3.7）', () => {
  /** ログイン状態によらずヘッダに出る行き先（2.3.7）。 */
  const COMMON_LINKS = [HOME_PATH, PUBLIC_WORKS_PATH, GENERATE_PAGE_PATH];

  /** 未ログインで開いた画面の分類。 */
  interface AnonymousPages {
    /** HTML を返した画面。 */
    readonly pages: readonly { readonly path: string; readonly body: string }[];
    /** ログインへ送られた画面（ログイン必須の画面。**黙って飛ばさないために数える**）。 */
    readonly toLogin: readonly string[];
  }

  /**
   * 全画面を未ログインで開き、HTML を返した画面とログインへ送られた画面に分ける。
   *
   * **飛ばした経路を黙って緑にしない**（このファイルの冒頭と同じ規律）。HTML でも
   * ログインへの 303 でもない応答が 1 本でもあれば、その場で赤くする。
   *
   * @returns 分類した結果
   */
  async function anonymousPages(): Promise<AnonymousPages> {
    const pages: { path: string; body: string }[] = [];
    const toLogin: string[] = [];
    for (const path of getPaths()) {
      const { body, type, status, location } = await open(path, NO_COOKIE);
      if (type.includes('text/html')) {
        pages.push({ path, body });
        continue;
      }
      expect(status, `${path} が HTML でもログインへの 303 でもない`).toBe(303);
      expect(location, `${path} の遷移先`).toBe(LOGIN_PATH);
      toLogin.push(path);
    }
    // **どちらの群も空にしない。** 未ログインで開ける画面が 0 なら下の検査は空振りし、
    // ログインへ送られる画面が 0 なら、この分類そのものが要らなかったことになる。
    expect(pages.length, '未ログインで開ける画面が無い（検査が空振りする）').toBeGreaterThan(5);
    expect(toLogin.length, 'ログイン必須の画面が 1 枚も無い').toBeGreaterThan(0);
    return { pages, toLogin };
  }

  it('未ログインのヘッダの「ログイン」は、ログイン・登録（/signup）へ送る（本人だけの画面へは送らない。#472）', async () => {
    const { pages } = await anonymousPages();
    for (const { path, body } of pages) {
      const header = headerOf(body);
      expect(header, `${path} にヘッダが無い`).not.toBeNull();
      // **「ログイン」は広い段用と狭い段用の 2 か所にあり、どちらも `/signup` を指す**（2.3.7 の #435 注記 / #472）。
      // Google の認証（`LOGIN_PATH`）へ直接送るリンクはヘッダに残さない——片方の置き場所だけ古い行き先のまま、を塞ぐ。
      const logins = [...header!.matchAll(/<a class="[^"]*\bgf-header-login\b[^"]*" href="([^"]*)">([^<]*)<\/a>/gu)];
      expect(
        logins.map((match) => [match[1], match[2]]),
        `${path} のヘッダの「ログイン」の行き先`,
      ).toEqual([
        [SIGNUP_PATH, 'ログイン'],
        [SIGNUP_PATH, 'ログイン'],
      ]);
      expect(header!, `${path} のヘッダが Google の認証へ直接送っている`).not.toContain(`href="${LOGIN_PATH}"`);
      // **押した先で必ずログインへ送られるリンクを、未ログインに出さない**（4.4 / 2.2）。
      expect(header!, `${path} のヘッダに本人だけの画面が出ている`).not.toContain(
        `href="${MY_WORKS_PATH}"`,
      );
      expect(header!, `${path} のヘッダに登録情報が出ている`).not.toContain(
        `href="${ACCOUNT_PATH}"`,
      );
      // **招待コードの発行もログイン済みのメニューの中だけ**（2.3.7 の #435 注記 / #469）。
      expect(header!, `${path} のヘッダに招待コードの発行が出ている`).not.toContain(
        `href="${INVITES_PATH}"`,
      );
      // **ログアウトするものが無い人に、アカウントのメニューもログアウトも出さない**（#372）。
      expect(accountMenuOf(header!), `${path} の未ログインのヘッダにメニューがある`).toBeNull();
      expect(logoutFormsOf(body), `${path} の未ログインの画面にログアウトがある`).toEqual([]);
    }
  });

  it('ログイン済みのヘッダは、アカウントのメニューに 5 つを収める（ログインは出さない。#372 / #469）', async () => {
    // **v1.57 で 2.3.7 を覆した形である。** 自分の作品・いいねした作品・登録情報・ログアウトを
    // アバターのドロップダウンへ収め、**閉じたヘッダの項目列には本人だけの画面を出さない。**
    // **#435 の注記で招待コードの発行（`/invites`）を足した**（トップの本文が唯一の入口だった）。
    for (const path of getPaths()) {
      const header = headerOf((await open(path)).body);
      expect(header, `${path} にヘッダが無い`).not.toBeNull();
      const menu = accountMenuOf(header!);
      expect(menu, `${path} のヘッダにアカウントのメニューが無い`).not.toBeNull();
      for (const [link, label] of [
        [MY_WORKS_PATH, '自分の作品'],
        [LIKED_WORKS_PATH, 'いいねした作品'],
        [INVITES_PATH, '招待コードを発行する'],
        [ACCOUNT_PATH, '登録情報'],
      ] as const) {
        expect(menu!, `${path} のメニューに「${label}」が無い`).toContain(`href="${link}">${label}</a>`);
      }
      expect(logoutFormsOf(menu!), `${path} のメニューにログアウトが無い`).toHaveLength(1);
      const outside = header!.replace(menu!, '');
      for (const link of [MY_WORKS_PATH, LIKED_WORKS_PATH, INVITES_PATH, ACCOUNT_PATH]) {
        expect(outside, `${path} のヘッダの項目列（メニューの外）に ${link} がある`).not.toContain(
          `href="${link}"`,
        );
      }
      expect(header!, `${path} のヘッダにログインが出ている`).not.toContain(
        `href="${LOGIN_PATH}"`,
      );
      expect(header!, `${path} のヘッダにログイン・登録が出ている`).not.toContain(
        `href="${SIGNUP_PATH}"`,
      );
    }
  });

  it('アカウントのメニューは JavaScript を要求しない形で、閉じた状態で配られる（#372）', async () => {
    // **開閉をブラウザ（`<details>` / `<summary>`）に持たせる。** 画面ごとに外枠が
    // 違っていないことを全画面で見る——実ブラウザで JavaScript を止めて開閉できることは
    // `scripts/check-page-width.sh` が 3 幅で見るが、あちらが開くのは 1 画面だけである。
    for (const path of getPaths()) {
      const header = headerOf((await open(path)).body)!;
      const menu = accountMenuOf(header)!;
      expect(header.split('<details').length - 1, `${path} のヘッダの <details> の数`).toBe(1);
      expect(menu, `${path} のメニューの最初の子が <summary> でない`).toMatch(
        /^<details class="gf-account-menu">\s*<summary>/u,
      );
      expect(menu, `${path} のメニューが開いた状態で配られている`).not.toMatch(
        /<details[^>]*\sopen/u,
      );
      expect(header, `${path} のヘッダに <script> がある`).not.toContain('<script');
      expect(menu, `${path} のメニューにイベント属性がある`).not.toMatch(/\son[a-z]+=/u);
      expect(menu, `${path} のメニューに hidden / inert / tabindex がある`).not.toMatch(
        /\s(hidden|inert|tabindex)[\s=>]/u,
      );
    }
  });

  it('ログイン状態によらない行き先は、全画面のヘッダにある', async () => {
    const { pages } = await anonymousPages();
    for (const { path, body } of pages) {
      for (const link of COMMON_LINKS) {
        expect(headerOf(body)!, `${path} のヘッダに ${link} が無い（未ログイン）`).toContain(
          `href="${link}"`,
        );
      }
    }
    for (const path of getPaths()) {
      const header = headerOf((await open(path)).body)!;
      for (const link of COMMON_LINKS) {
        expect(header, `${path} のヘッダに ${link} が無い（ログイン済み）`).toContain(
          `href="${link}"`,
        );
      }
    }
  });

  it('全画面のヘッダに、公開一覧へ GET で送る検索窓が置き場所ごとに 1 つずつある（ログイン状態によらない。#378 / #469）', async () => {
    // **2.3.7 v1.57 の「検索窓」**。素の GET のフォームで、JavaScript を要求しない。
    // **`size` 属性を使わない**（#282 で 390px の版面を押し広げた）。ラベルは見えないが読み上げに渡す。
    // **#469 で、広い段用（ナビの中）と狭い段用（2 行目）の 2 か所に置いた。** 見えるのは段ごとに片方だけで、
    // 見えない側は `display: none`（下の CSS の検査）。`id` は置き場所ごとに別の値である。
    const { pages } = await anonymousPages();
    const signedIn: { path: string; body: string }[] = [];
    for (const path of getPaths()) {
      signedIn.push({ path, body: (await open(path)).body });
    }
    for (const { path, body } of [...pages, ...signedIn]) {
      const header = headerOf(body)!;
      const forms = header.match(/<form class="gf-header-search"[\s\S]*?<\/form>/gu) ?? [];
      expect(forms, `${path} のヘッダの検索窓の数`).toHaveLength(2);
      for (const [form, id] of [
        [forms[0]!, 'gf-header-search-q'],
        [forms[1]!, 'gf-header-search-q-narrow'],
      ] as const) {
        expect(form, `${path} の検索窓`).toMatch(
          new RegExp(`^<form class="gf-header-search" role="search" method="get" action="${PUBLIC_WORKS_PATH}">`, 'u'),
        );
        expect(form, `${path} の検索窓の入力欄`).toContain(`name="${WORK_SEARCH_FIELD}"`);
        expect(form, `${path} の検索窓の上限`).toContain(`maxlength="${MAX_SEARCH_LENGTH}"`);
        expect(form, `${path} の検索窓のラベル`).toContain(`<label class="gf-header-search-label" for="${id}">`);
        expect(form, `${path} の検索窓の入力欄の id`).toContain(`id="${id}"`);
        expect(form, `${path} の検索窓に size 属性がある`).not.toMatch(/\ssize=/u);
        expect(form, `${path} の検索窓にイベント属性がある`).not.toMatch(/\son[a-z]+=/u);
      }
      // **広い段用はナビの中、狭い段用はナビの後ろの 2 行目にある**（HTML の順＝見た目の順）。
      const nav = /<nav class="gf-header-nav"[\s\S]*?<\/nav>/u.exec(header)?.[0] ?? '';
      expect(nav, `${path} のナビに広い段用の検索窓が無い`).toContain(forms[0]!);
      expect(nav, `${path} のナビに狭い段用の検索窓がある`).not.toContain(forms[1]!);
      expect(header.indexOf(forms[1]!), `${path} の狭い段用の検索窓がナビより前にある`).toBeGreaterThan(
        header.indexOf('</nav>'),
      );
    }
  });

  it('ヘッダは段ごとの並びを CSS で入れ替えず、段ごとに検索窓とログインの片方だけを見せる宣言を持つ（#469 / PR #486）', () => {
    // **HTML の順＝見た目の順＝Tab の順にする。** `order` で並びを入れ替えると Tab の順と見た目がずれ、
    // `display: contents` は一部の支援技術で `<nav>` のランドマークを消す（PR #486 の Copilot code review）。
    const css = env.TEST_APP_CSS;
    // 宣言だけを見る（コメントの中の説明は数えない）。
    expect(css.replaceAll(/\/\*[\s\S]*?\*\//gu, ''), 'app.css に display: contents の宣言がある').not.toMatch(
      /display:\s*contents/u,
    );
    const headerSection = css.slice(css.indexOf('@section header'), css.indexOf('@section breadcrumb'));
    const shellSection = css.slice(css.indexOf('@section shell'), css.indexOf('@section base'));
    for (const [name, section] of [
      ['header', headerSection],
      ['shell', shellSection],
    ] as const) {
      expect(section.length, `@section ${name} が見つかりません`).toBeGreaterThan(0);
      expect(section.replaceAll(/\/\*[\s\S]*?\*\//gu, ''), `@section ${name} に order がある`).not.toMatch(/\border:/u);
    }
    // 狭い段（既定）: ナビの中の広い段用を消す。広い段（@media）: 2 行目を消し、ナビの中を出す。
    expect(headerSection).toMatch(/\.gf-header-nav \.gf-header-search,\s*\.gf-header-nav \.gf-header-login\s*\{\s*display:\s*none;/u);
    const wide = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/u.exec(shellSection)?.[1] ?? '';
    expect(wide).toMatch(/\.gf-header-row2\s*\{\s*display:\s*none;/u);
    expect(wide).toMatch(/\.gf-header-nav \.gf-header-search\s*\{\s*display:\s*flex;/u);
    expect(wide).toMatch(/\.gf-header-nav \.gf-header-login\s*\{\s*display:\s*inline-flex;/u);
  });

  it('ヘッダの検索窓は、入力欄とボタンを横 1 行に並べる宣言を持つ（共通の form の縦積みを上書きする。#378）', () => {
    // **共通の `form` は `flex-direction: column`**（`@section forms`）。検索窓の規則が `row` を明示しないと、
    // 入力欄とボタンが縦に積まれる。**縦に積まれても版面には収まる**ので、幅の検査（`scripts/check-page-width.sh`）
    // では捕まらない——宣言をここで見る（PR #432 の Copilot の指摘）。
    const form = /^form\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(form?.[1], 'app.css に共通の form の規則が見つかりません').toMatch(/flex-direction:\s*column;/u);
    const search = /^\.gf-header-search\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(search, 'app.css に .gf-header-search の規則が見つかりません').not.toBeNull();
    expect(search![1]).toMatch(/display:\s*flex;/u);
    expect(search![1]).toMatch(/flex-direction:\s*row;/u);
    expect(search![1]).toMatch(/flex-wrap:\s*nowrap;/u);
  });

  it('ログアウトは全画面で POST のフォーム 1 つだけで、GET の口（href）を作らない（#372）', async () => {
    // **GET なら `<img src="/auth/logout">` を踏ませるだけで他人をログアウトさせられる**
    // （`src/auth/google.ts` の経路表）。#362 は `/account` にだけ置いていたが、#372 で
    // ヘッダへ移したので**全画面に出る。** 1 画面に 2 つ（ヘッダと本文）並べないことも見る。
    for (const path of getPaths()) {
      const { body } = await open(path);
      const forms = logoutFormsOf(body);
      expect(forms, `${path} のログアウトのフォームの数`).toHaveLength(1);
      expect(forms[0], `${path} のログアウトが POST でない`).toContain('method="post"');
      expect(body, `${path} にログアウトへの href がある`).not.toContain(`href="${LOGOUT_PATH}"`);
    }
  });

  it('ログアウトは GET を受けない（ヘッダのフォームを踏まずに状態を変えられない。#372）', async () => {
    // **フォームが POST であることだけでは足りない。** 経路が GET も受けるなら、フォームを
    // 迂回して `<img src>` 1 つでログアウトさせられる。**ログイン済みの cookie を載せて**
    // 開き、cookie を消す応答が返らないことまで見る（未ログインの GET だと、消されても
    // 気づけない）。
    for (const method of ['GET', 'HEAD']) {
      const response = await handleAppRequest(
        new Request(`${APP_ORIGIN}${LOGOUT_PATH}`, { method, headers: { cookie } }),
        testEnv(),
      );
      expect(response.status, `${method} ${LOGOUT_PATH} のステータス`).toBe(405);
      expect(response.headers.get('allow'), `${method} ${LOGOUT_PATH} の Allow`).toBe('POST');
      expect(response.headers.get('set-cookie'), `${method} ${LOGOUT_PATH} が cookie を触った`).toBeNull();
    }
    // **POST は通る**（上が「経路ごと消えた」ことで緑になっていないことの確認）。着地は
    // `/` のまま変えない（#362 / #374 が確かめた性質）。
    const posted = await handleAppRequest(
      new Request(`${APP_ORIGIN}${LOGOUT_PATH}`, { method: 'POST', headers: { cookie } }),
      testEnv(),
    );
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(HOME_PATH);
    expect(posted.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });

  it('いいねした作品は、未ログインのヘッダには出ない（ログイン済みはメニューの中だけ。2.3.7 v1.57）', async () => {
    const { pages } = await anonymousPages();
    for (const { path, body } of pages) {
      expect(headerOf(body)!, `${path} のヘッダ（未ログイン）`).not.toContain(LIKED_WORKS_PATH);
    }
  });

  it('ヘッダ・パンくず・フッタのリンクは、すべて経路表の GET 経路を指す（行き先の無いリンクを出さない）', async () => {
    // **4.4 / 2.2「押しても何も起きないリンクを出さない」を外枠の全リンクで見る。** とくに
    // フッタのお問い合わせ（#373 が行き先を作る）のように、**画面より先に項目だけを足す**
    // 変更を赤くする。行き先は画面に限らない（ログインは Google へのリダイレクトである。
    // メールの窓口は `mailto:` の形だけを見る）。
    const routes = createAppRoutes(testEnv()).filter(
      (route) => route.method === 'GET' && route.match !== 'prefix',
    );
    const known = new Set(routes.map((route) => route.path));
    const { pages } = await anonymousPages();
    const signedIn: { path: string; body: string }[] = [];
    for (const path of getPaths()) {
      signedIn.push({ path, body: (await open(path)).body });
    }
    for (const { path, body } of [...pages, ...signedIn]) {
      const shell = [headerOf(body), breadcrumbOf(body), footerOf(body)].join('\n');
      const links = hrefsOf(shell);
      expect(links.length, `${path} の外枠にリンクが無い（検査が空振りする）`).toBeGreaterThan(3);
      for (const link of links) {
        // **サイト内の行き先と、メールの行き先を分けて見る**（PR #393 の Copilot の指摘）。
        // #373 は一般の問い合わせ窓口を「メールアドレスで足りる」としており、`mailto:` は
        // 経路表に載らないが実在する行き先である。**それ以外の外部の綴り（`https:` /
        // `javascript:` など）は外枠に置かない**——置くと決めたなら、ここを先に直す。
        if (link.startsWith('mailto:')) {
          expect(link, `${path} の外枠の ${link} がメールアドレスの形でない`).toMatch(
            /^mailto:[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/u,
          );
          continue;
        }
        expect(known.has(link), `${path} の外枠のリンク ${link} が経路表の GET 経路に無い`).toBe(true);
      }
    }
  });

  it('ヘッダはログイン状態で変わる（HTML を共有キャッシュへ載せられない理由。2.3.3 の条件 3）', async () => {
    const { pages } = await anonymousPages();
    for (const { path, body } of pages) {
      const signedIn = headerOf((await open(path)).body);
      expect(headerOf(body), `${path} のヘッダがログイン状態で変わっていない`).not.toBe(signedIn);
    }
  });

  it('フッタは見出しの無い 6 項目を持ち、ヘッダと重複する行き先と置かないと決めた項目が無い（#435 / #469）', async () => {
    // **並びと文言の正本の検査は `test/legal.test.ts` が持つ。** ここは全画面に同じフッタが乗っていることを見る。
    for (const path of getPaths()) {
      const footer = footerOf((await open(path)).body);
      expect(footer, `${path} にフッタが無い`).not.toBeNull();
      const links = hrefsOf(footer!);
      expect(links, `${path} のフッタの行き先`).toEqual([
        NEWS_PATH,
        FAQ_PATH,
        TERMS_PATH,
        PRIVACY_PATH,
        links[4]!,
        TAKEDOWN_PATH,
      ]);
      expect(links[4], `${path} のフッタのお問い合わせ`).toMatch(/^mailto:/u);
      // **区画の見出しを置かない**（#331 の 3 区画を #435 が覆した）。
      expect(footer!, `${path} のフッタに見出しがある`).not.toMatch(/<h[1-6]\b/u);
      // **ヘッダにある「作品をさがす」「つくる」は置かない**（同じ行き先を 1 画面に 2 度並べない）。
      for (const absent of [PUBLIC_WORKS_PATH, GENERATE_PAGE_PATH]) {
        expect(footer!, `${path} のフッタに ${absent} がある`).not.toContain(`href="${absent}"`);
      }
      // **行き先が実在しない項目は、枠も置かない**（2.3.7 / 2.3.14。v1.57 でも #435 でも維持）。
      for (const absent of ['会社情報', 'SNS']) {
        expect(footer!, `${path} のフッタに ${absent} の区画がある`).not.toContain(absent);
      }
    }
  });

  it('トップの <h1> はちょうど 1 つでヘッダのロゴであり、トップ以外ではロゴが <h1> でない（仕様 2.5.6 / #469）', async () => {
    // **本文の `<h1>Game Forge</h1>` を消し、ロゴを `<h1>` で包むことを同じ PR で行った**——`<h1>` が 2 つ / 0 個の
    // 期間を作らないため（#469 の intake）。全画面 × ログイン両状態で見る。
    const { pages } = await anonymousPages();
    const signedIn: { path: string; body: string }[] = [];
    for (const path of getPaths()) {
      signedIn.push({ path, body: (await open(path)).body });
    }
    let topSeen = 0;
    for (const { path, body } of [...pages, ...signedIn]) {
      const header = headerOf(body)!;
      if (path === HOME_PATH) {
        topSeen += 1;
        expect(body.match(/<h1\b/gu), `${path} の <h1> の数`).toHaveLength(1);
        expect(header, `${path} のヘッダのロゴが <h1> でない`).toContain(
          `<h1 class="gf-header-title"><a class="gf-header-logo" href="${HOME_PATH}">${siteLogo()}</a></h1>`,
        );
        continue;
      }
      expect(header, `${path} のヘッダに <h1> がある`).not.toMatch(/<h1\b/u);
    }
    // **トップを 1 度も開かないまま緑にしない**（未ログインとログイン済みの 2 回）。
    expect(topSeen).toBe(2);
  });

  it('フッタはログイン状態で変わらない（出し分けはヘッダだけが持つ）', async () => {
    const { pages } = await anonymousPages();
    for (const { path, body } of pages) {
      const footer = footerOf(body);
      expect(footer, `${path} のフッタが未ログインで出ていない`).not.toBeNull();
      expect(footer, `${path} のフッタがログイン状態で変わっている`).toBe(
        footerOf((await open(path)).body),
      );
      // 本人だけの画面と、ログインの導線はフッタに置かない（2.3.7 の #435 注記の 6 項目に無い）。
      for (const absent of [MY_WORKS_PATH, ACCOUNT_PATH, LIKED_WORKS_PATH, INVITES_PATH, LOGIN_PATH, SIGNUP_PATH]) {
        expect(footer!, `${path} のフッタに ${absent} がある`).not.toContain(`href="${absent}"`);
      }
    }
  });
});

/**
 * パンくず（2.3.10 / #372）。
 *
 * # なぜ経路表から導くのか
 *
 * **パンくずの構造は、経路表の画面を URL の末尾から削って出来る**（2.3.2 / #152 が決めた
 * 階層）。ここはその導出を画面ごとに書き写さず、`ssrPagePaths` と `ancestorPathsOf` から
 * 期待値を作って全画面 × ログイン両状態で突き合わせる。**画面を 1 枚足した日も、
 * ここに書き足すものは無い**——足した画面が親になったときだけ、下の「漏れ」の検査が
 * `src/html.ts` の `BREADCRUMB_PARENTS` への 1 行を求める。
 */
describe('パンくず（2.3.10）', () => {
  /** 経路表の画面のうち、完全一致のもの（パンくずの親になりうるもの）。 */
  function exactPagePaths(): Set<string> {
    return new Set(
      ssrPagePaths(createAppRoutes(testEnv())).filter((path) => path === '/' || !path.endsWith('/')),
    );
  }

  /**
   * パンくずの項目を、リンク（親）と末尾（いまの画面）に分けて読む。
   *
   * @param crumb {@link breadcrumbOf} の戻り値
   * @returns 親の href の列と、末尾の名前（エスケープされたまま）
   */
  function readCrumb(crumb: string): { links: string[]; current: string | null } {
    return {
      links: hrefsOf(crumb),
      current: /<span aria-current="page">([\s\S]*?)<\/span>/u.exec(crumb)?.[1] ?? null,
    };
  }

  /**
   * 全画面を両方の状態で開き、HTML を返したものを集める。
   *
   * **ログインへ送られた画面（未ログインの本人専用画面）は数えて除く**——パンくずは
   * HTML の外枠なので、303 には出ようがない。黙って飛ばさないために件数を見る。
   *
   * @returns 開いた画面
   */
  async function allRendered(): Promise<{ path: string; body: string; state: string }[]> {
    const rendered: { path: string; body: string; state: string }[] = [];
    let redirected = 0;
    for (const path of getPaths()) {
      rendered.push({ path, body: (await open(path)).body, state: 'ログイン済み' });
      const anonymous = await open(path, NO_COOKIE);
      if (anonymous.type.includes('text/html')) {
        rendered.push({ path, body: anonymous.body, state: '未ログイン' });
      } else {
        redirected++;
      }
    }
    expect(redirected, 'ログイン必須の画面が 1 枚も無い（分類が空振りしている）').toBeGreaterThan(0);
    expect(rendered.length).toBeGreaterThan(getPaths().length);
    return rendered;
  }

  it('トップには出さず、それ以外のすべての画面に 1 つだけ出る', async () => {
    for (const { path, body, state } of await allRendered()) {
      const count = body.split('<nav class="gf-breadcrumb"').length - 1;
      expect(count, `${path}（${state}）のパンくずの数`).toBe(path === HOME_PATH ? 0 : 1);
    }
  });

  it('パンくずはヘッダの直後にあり、本文より前に出る', async () => {
    for (const { path, body, state } of await allRendered()) {
      if (path === HOME_PATH) {
        continue;
      }
      const after = body.slice(body.indexOf('</header>') + '</header>'.length).trimStart();
      expect(after.startsWith('<nav class="gf-breadcrumb"'), `${path}（${state}）`).toBe(true);
    }
  });

  it('親は「トップ」から始まり、URL を削って出来る画面をすべて浅い順に並べる', async () => {
    const pages = exactPagePaths();
    let withParents = 0;
    for (const { path, body, state } of await allRendered()) {
      if (path === HOME_PATH) {
        continue;
      }
      const { links } = readCrumb(breadcrumbOf(body)!);
      const expected = [HOME_PATH, ...ancestorPathsOf(path).filter((ancestor) => pages.has(ancestor))];
      expect(links, `${path}（${state}）のパンくずの親`).toEqual(expected);
      if (expected.length > 1) {
        withParents++;
      }
    }
    // **親を持つ画面が 1 枚も無いまま緑にしない**（作品ページ・自分の作品・受付完了がある）。
    expect(withParents, 'トップ以外の親を持つ画面が無い（検査が空振りする）').toBeGreaterThan(3);
  });

  it('末尾はいまの画面の名前（<title> からサービス名を落としたもの）で、リンクにしない', async () => {
    for (const { path, body, state } of await allRendered()) {
      if (path === HOME_PATH) {
        continue;
      }
      const title = /<title>([\s\S]*?)<\/title>/u.exec(body)?.[1] ?? '';
      const { current, links } = readCrumb(breadcrumbOf(body)!);
      expect(current, `${path}（${state}）のパンくずの末尾`).toBe(breadcrumbLabelOf(title));
      expect(current, `${path}（${state}）のパンくずの末尾が空`).not.toBe('');
      expect(links, `${path}（${state}）のパンくずが自分自身へリンクしている`).not.toContain(path);
    }
  });

  it('親の名前の表に、画面である親の漏れが無い（経路表から導く）', () => {
    // **表に無い親はパンくずから黙って消える。** 画面を足してそれが別の画面の親になった日に、
    // ここが赤くなって `BREADCRUMB_PARENTS` への 1 行を求める。
    const pages = exactPagePaths();
    const named = new Set(BREADCRUMB_PARENTS.map((item) => item.path));
    const missing = [...new Set(getPaths().flatMap((path) => ancestorPathsOf(path)))]
      .filter((ancestor) => pages.has(ancestor))
      .filter((ancestor) => !named.has(ancestor));
    expect(missing, 'src/html.ts の BREADCRUMB_PARENTS に名前の無い親').toEqual([]);
    // 空振りしない（親を持つ階層が経路表に実際にある）。
    expect(named.size).toBeGreaterThan(0);
  });

  it('親の名前の表の行き先はすべて画面で、名前はその画面自身の末尾の名前と一致する', async () => {
    // **表は画面の名前の写しである。** 写しは腐るので、その画面を開いたときのパンくずの
    // 末尾（= `<title>` から導いた名前）と突き合わせる（`.ai-playbook/shared-ai-rules.md` 12 章）。
    const pages = exactPagePaths();
    for (const item of BREADCRUMB_PARENTS) {
      expect(pages.has(item.path), `${item.path} は経路表の画面ではない`).toBe(true);
      const { body, type } = await open(item.path);
      expect(type, `${item.path} が HTML を返さない`).toContain('text/html');
      const { current } = readCrumb(breadcrumbOf(body)!);
      expect(current, `${item.path} の名前が表とずれている`).toBe(item.label);
    }
  });
});
