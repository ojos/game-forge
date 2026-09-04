import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { DRAFT_STATUS } from '../src/games.js';
import { APP_CSS_PATH } from '../src/html.js';
import { OGP_IMAGE_HEIGHT, OGP_IMAGE_WIDTH } from '../src/ogp.js';
import { NON_PAGE_PATHS, ssrPagePaths } from '../src/page-paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { WORK_PAGE_PREFIX } from '../src/work-page.js';
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

beforeAll(async () => {
  await applySchema();

  const userId = `shell-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.test`, '外枠検査', Math.floor(Date.now() / 1000))
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
 * 検査対象の画面パスを、経路表から導いて実際に開ける形へ落とす。
 *
 * 導出そのものは `src/page-paths.ts` が持つ。**ここで条件を書き直さない**——
 * 実ブラウザ側の検査（`scripts/check-page-width.sh`）と同じ一覧を見る必要がある。
 *
 * @returns パスの配列
 */
function getPaths(): string[] {
  return ssrPagePaths(createAppRoutes(testEnv())).map((path) =>
    path === WORK_PAGE_PREFIX ? `${WORK_PAGE_PREFIX}${gameId}` : path,
  );
}

/**
 * 1 経路を開いて、本文と content-type を返す。
 *
 * @param path パス
 * @returns 応答の本文と content-type
 */
async function open(path: string): Promise<{ body: string; type: string }> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${path}`, { headers: { cookie } }),
    testEnv(),
  );
  return {
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
  };
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
    // **見るのは作品枠の 2 つだけである。** `aspect-ratio` の出現をすべて縛ると、
    // 作品と無関係な用途で 1 つ足した日に落ちる。写しを腐らせない目的は変わらない。
    const expected = `aspect-ratio: ${OGP_IMAGE_WIDTH} / ${OGP_IMAGE_HEIGHT};`;
    for (const selector of ['.gf-shot', '.gf-frame']) {
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
