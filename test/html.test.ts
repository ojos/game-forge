import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH, LOGOUT_PATH } from '../src/auth/google.js';
import {
  BREADCRUMB_PARENTS,
  HEADER_SEARCH_INPUT_IDS,
  breadcrumbLabelOf,
  resolveSiteViewer,
  siteHead,
  siteViewerAt,
} from '../src/html.js';
import { LIKED_WORKS_PATH } from '../src/liked-works-paths.js';
import { ancestorPathsOf } from '../src/page-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH, INVITES_PATH } from '../src/paths.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from '../src/works-paths.js';

/**
 * ヘッダの出し分けの判定（2.3.7 / #331）。
 *
 * # なぜ経路を通さないのか
 *
 * **全画面にナビが出ることは `test/page-shell.test.ts` が経路表から導いて見る。**
 * ここで見るのは、あの検査では作れない状態である——**`SESSION_SECRET` が壊れている**
 * ときに画面が落ちないこと、**cookie が無いときに鍵へ触らない**こと。どちらも
 * 「外枠が原因で本文まで消える」形を塞ぐための性質で、経路の側からは再現できない。
 */

const SECRET = 'test-secret-value-for-site-viewer-checks-1';

/** {@link requestWith} が開くパス。`resolveSiteViewer` はこれを `path` に写す。 */
const REQUEST_PATH = '/terms';

/** 未ログインとして解決されたときの状態。 */
const SIGNED_OUT = siteViewerAt(REQUEST_PATH, false, null);

/** ログイン済みとして解決されたときの状態。 */
const SIGNED_IN = siteViewerAt(REQUEST_PATH, true, null);

/**
 * 有効なセッション cookie を作る。
 *
 * @param secret 署名に使う秘密鍵
 * @returns `Cookie` ヘッダへ入れる値
 */
async function validCookie(secret: string = SECRET): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId: 'viewer-1', issuedAt, expiresAt: issuedAt + 3600 }, secret);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * cookie を付けた（付けない）要求を作る。
 *
 * @param cookie `Cookie` ヘッダの値（null なら付けない）
 * @returns 要求
 */
function requestWith(cookie: string | null): Request {
  // **query を付けておく。** `path` は `URL#pathname` で、query を含まない（パンくずの
  // 親を引く鍵にするので、`?page=2` の有無で親が変わってはいけない）。
  return new Request(`https://${env.APP_HOST}${REQUEST_PATH}?q=1`, {
    headers: cookie === null ? {} : { cookie },
  });
}

/**
 * 秘密鍵だけを差し替えた env。
 *
 * @param secret `SESSION_SECRET` の値
 * @returns 差し替えた env
 */
function envWithSecret(secret: string): Env {
  return { ...env, SESSION_SECRET: secret };
}

describe('ヘッダの出し分けに使う状態（resolveSiteViewer）', () => {
  it('cookie が無ければ未ログインで、秘密鍵に触らない', async () => {
    // **鍵が壊れていても落ちない**ことで「触っていない」を示す。`SESSION_SECRET` が
    // 空のまま `verifySession` を呼ぶと投げる（`src/session.ts` の `importKey`）ので、
    // ここが通ることは鍵の import が走っていないことの証拠である。
    expect(await resolveSiteViewer(requestWith(null), envWithSecret(''))).toEqual(
      SIGNED_OUT,
    );
  });

  it('署名の通った cookie ならログイン済みになる', async () => {
    expect(
      await resolveSiteViewer(requestWith(await validCookie()), envWithSecret(SECRET)),
    ).toEqual(SIGNED_IN);
  });

  it('別の鍵で署名された cookie は未ログインとして扱う', async () => {
    const other = await validCookie('another-secret-value-for-site-viewer-1');
    expect(await resolveSiteViewer(requestWith(other), envWithSecret(SECRET))).toEqual(
      SIGNED_OUT,
    );
  });

  it('期限切れの cookie は未ログインとして扱う', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 7200;
    const token = await signSession({ userId: 'viewer-1', issuedAt, expiresAt: issuedAt + 60 }, SECRET);
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;
    expect(await resolveSiteViewer(requestWith(cookie), envWithSecret(SECRET))).toEqual(
      SIGNED_OUT,
    );
  });

  it('秘密鍵の設定が壊れていても投げない（画面ごと 500 にしない）', async () => {
    // **外枠が原因で本文まで消える形を作らない**（`src/html.ts` の理由）。
    // ヘッダの 1 行のために、規約や削除依頼の画面が 500 になってはいけない。
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    try {
      const viewer = await resolveSiteViewer(requestWith(await validCookie()), envWithSecret(''));
      expect(viewer).toEqual(SIGNED_OUT);
    } finally {
      spy.mockRestore();
    }
    // **黙らせない。** 未ログインへ倒したことは記録する。
    expect(logged.join('\n')).toContain('ヘッダの出し分け');
  });
});

describe('siteHead のヘッダ', () => {
  it('viewer を渡さない画面はナビを出さない（未ログインとして描かない）', () => {
    // **POST の結果を返す画面（`src/publish.ts` など）はログイン済みの利用者しか
    // 踏まない。** 未ログイン用のナビを既定にすると、操作が成功した画面に「ログイン」が
    // 出る。**間違ったことを言うより、言わないほうを既定にする。**
    const head = siteHead({ title: '公開しました - Game Forge' });
    expect(head).toContain('<header class="gf-header">');
    expect(head).not.toContain('gf-header-nav');
    expect(head).not.toContain(`href="${LOGIN_PATH}"`);
    expect(head).not.toContain(`href="${MY_WORKS_PATH}"`);
    expect(head).not.toContain(`href="${ACCOUNT_PATH}"`);
  });

  it('渡せばその状態のナビを出す', () => {
    const anonymous = siteHead({ title: 'x', viewer: SIGNED_OUT });
    expect(anonymous).toContain(`href="${LOGIN_PATH}"`);
    expect(anonymous).not.toContain(`href="${MY_WORKS_PATH}"`);

    const signedIn = siteHead({ title: 'x', viewer: SIGNED_IN });
    expect(signedIn).toContain(`href="${MY_WORKS_PATH}"`);
    expect(signedIn).toContain(`href="${ACCOUNT_PATH}"`);
    expect(signedIn).not.toContain(`href="${LOGIN_PATH}"`);
  });

  it('ナビは小さいボタンの部品で、「つくる」だけが副、ほかは控えめである（仕様 2.5.5 / 2.5.6 / #469）', () => {
    // **主（`.gf-button-primary`）をヘッダに置かない**——全画面に出るので、1 画面に 1 つの枠を使い切る（2.5.5）。
    for (const viewer of [SIGNED_OUT, SIGNED_IN]) {
      const header = headerOf(siteHead({ title: 'x', viewer }));
      expect(header).toContain(
        `<a class="gf-button gf-button-tertiary gf-button-sm" href="${PUBLIC_WORKS_PATH}">作品をさがす</a>`,
      );
      expect(header).toContain(
        `<a class="gf-button gf-button-secondary gf-button-sm" href="${GENERATE_PAGE_PATH}">つくる</a>`,
      );
      expect(header).toContain('<button class="gf-button gf-button-secondary gf-button-sm" type="submit">検索</button>');
      expect(header).not.toContain('gf-button-primary');
      // 「検索」は広い段用と狭い段用の 2 か所にある（同時に見えるのは片方。下の describe）。
      expect(header.match(/gf-button-secondary/gu), '副は「つくる」と 2 か所の「検索」だけ').toHaveLength(3);
    }
    // **「ログイン」は控えめで、行き先は Google の認証のまま**（M13-8 へ持ち越し。#469 の scope.out）。
    expect(headerOf(siteHead({ title: 'x', viewer: SIGNED_OUT }))).toContain(
      `<a class="gf-button gf-button-tertiary gf-button-sm gf-header-login" href="${LOGIN_PATH}">ログイン</a>`,
    );
  });

  it('トップだけ、ヘッダのロゴを <h1> で包む（仕様 2.5.6 / #469）', () => {
    const logoLink = /<a class="gf-header-logo" href="\/">[\s\S]*?<\/a>/u;
    for (const signedIn of [true, false]) {
      const top = headerOf(siteHead({ title: 'Game Forge', viewer: siteViewerAt(HOME_PATH, signedIn, null) }));
      expect(top.match(/<h1\b/gu), 'トップのヘッダの <h1> の数').toHaveLength(1);
      const h1 = /<h1 class="gf-header-title">([\s\S]*?)<\/h1>/u.exec(top)?.[1] ?? '';
      expect(h1, '<h1> の中身がロゴのリンクそのものである').toMatch(new RegExp(`^${logoLink.source}$`, 'u'));
      // **見出しの名前は画像の alt から付く。** 文字を別に持たない。
      expect(h1.replaceAll(/<[^>]+>/gu, '').trim()).toBe('');
      expect(h1).toContain('alt="Game Forge"');

      const other = headerOf(siteHead({ title: '登録情報 - Game Forge', viewer: siteViewerAt(ACCOUNT_PATH, signedIn, null) }));
      expect(other, 'トップ以外のヘッダに <h1> がある').not.toMatch(/<h1\b/u);
      expect(other).toMatch(logoLink);
    }
    // **`viewer` を省いた画面（POST の結果）はトップではない。**
    expect(siteHead({ title: 'Game Forge' })).not.toMatch(/<h1\b/u);
  });

  it('ヘッダは OGP の meta より後ろに出る（本文が始まる前に meta を置く）', () => {
    // **`extraHead` はヘッダより前**という `siteHead` の規約は、ナビを足しても変わらない。
    const head = siteHead({
      title: 'x',
      extraHead: '\n<meta property="og:title" content="x">',
      viewer: SIGNED_OUT,
    });
    expect(head.indexOf('<meta property="og:title"')).toBeLessThan(
      head.indexOf('<header class="gf-header">'),
    );
  });
});

/**
 * ヘッダの `<header>` 区画だけを取り出す。
 *
 * @param html `siteHead` の出力
 * @returns `<header>` の中身
 */
function headerOf(html: string): string {
  const header = /<header class="gf-header">[\s\S]*?<\/header>/u.exec(html);
  expect(header, 'ヘッダが無い（検査が空振りする）').not.toBeNull();
  return header![0];
}

describe('ヘッダの段ごとの置き場所（HTML の順＝見た目の順。#469 / PR #486 の Copilot code review）', () => {
  /**
   * ヘッダを、ナビ（`<nav>`）と狭い段の 2 行目（`.gf-header-row2`）に分ける。
   *
   * @param html `siteHead` の出力
   * @returns ナビと 2 行目の HTML
   */
  function partsOf(html: string): { nav: string; row2: string } {
    const header = headerOf(html);
    const nav = /<nav class="gf-header-nav"[^>]*>[\s\S]*?<\/nav>/u.exec(header)?.[0] ?? '';
    const row2 = /<div class="gf-header-row2">[\s\S]*?<\/div>\s*<\/header>/u.exec(header)?.[0] ?? '';
    expect(nav, 'ナビが無い').not.toBe('');
    expect(row2, '2 行目が無い').not.toBe('');
    // **2 行目はナビの後ろにある**（HTML の順＝狭い段の見た目の順）。
    expect(header.indexOf(row2)).toBeGreaterThan(header.indexOf(nav));
    return { nav, row2 };
  }

  /**
   * 検索窓のフォームを取り出す。
   *
   * @param fragment HTML の断片
   * @returns フォームの HTML
   */
  function formsOf(fragment: string): string[] {
    return fragment.match(/<form class="gf-header-search"[\s\S]*?<\/form>/gu) ?? [];
  }

  it('検索窓はナビの中（広い段用）と 2 行目（狭い段用）に 1 つずつあり、id とラベルの対応が置き場所ごとに閉じている', () => {
    for (const viewer of [SIGNED_OUT, SIGNED_IN]) {
      const html = siteHead({ title: 'x', viewer });
      const { nav, row2 } = partsOf(html);
      const wide = formsOf(nav);
      const narrow = formsOf(row2);
      expect(wide).toHaveLength(1);
      expect(narrow).toHaveLength(1);
      const idOf = (form: string): string => /<input id="([^"]+)"/u.exec(form)?.[1] ?? '';
      const forOf = (form: string): string => /<label [^>]*for="([^"]+)"/u.exec(form)?.[1] ?? '';
      expect(idOf(wide[0]!)).toBe(HEADER_SEARCH_INPUT_IDS.wide);
      expect(idOf(narrow[0]!)).toBe(HEADER_SEARCH_INPUT_IDS.narrow);
      for (const form of [wide[0]!, narrow[0]!]) {
        expect(forOf(form), 'ラベルが同じフォームの入力欄を指す').toBe(idOf(form));
        expect(form).toContain('role="search"');
      }
      // **文書全体で id が一意である**（2 か所に同じ id を置かない）。
      const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]!);
      expect(new Set(ids).size, `id が重複している: ${ids.join(', ')}`).toBe(ids.length);
    }
  });

  it('検索語は両方の窓に戻す（どちらの段で開いても語が見える）', () => {
    const html = siteHead({ title: 'x', viewer: SIGNED_OUT, searchQuery: '"宇宙"<b>' });
    const { nav, row2 } = partsOf(html);
    for (const form of [...formsOf(nav), ...formsOf(row2)]) {
      expect(form).toContain(' value="&quot;宇宙&quot;&lt;b&gt;"');
    }
  });

  it('未ログインの「ログイン」はナビの末尾（広い段用）と 2 行目の検索窓の後ろ（狭い段用）にあり、ログイン済みはアバターがナビの末尾', () => {
    const signedOut = partsOf(siteHead({ title: 'x', viewer: SIGNED_OUT }));
    for (const part of [signedOut.nav, signedOut.row2]) {
      const login = part.indexOf(`href="${LOGIN_PATH}"`);
      expect(login, 'ログインが無い').toBeGreaterThan(-1);
      expect(part, 'ログインに目印のクラスが無い').toContain(`gf-header-login" href="${LOGIN_PATH}"`);
      // **検索窓の後ろ**（HTML の順＝見た目の順）。
      expect(login).toBeGreaterThan(part.indexOf('</form>'));
    }
    expect(signedOut.nav).not.toContain('gf-account-menu');

    const signedIn = partsOf(siteHead({ title: 'x', viewer: SIGNED_IN }));
    expect(signedIn.nav.indexOf('<details class="gf-account-menu">')).toBeGreaterThan(signedIn.nav.indexOf('</form>'));
    expect(signedIn.row2).not.toContain('gf-account-menu');
    expect(signedIn.row2).not.toContain(`href="${LOGIN_PATH}"`);
    // **メニューは 1 つだけ**（段で置き場所を変えない）。
    expect(headerOf(siteHead({ title: 'x', viewer: SIGNED_IN })).split('<details').length - 1).toBe(1);
  });
});

/**
 * アカウントのメニュー（`<details>`）だけを取り出す。
 *
 * @param html `siteHead` の出力
 * @returns `<details>` の中身（無ければ null）
 */
function accountMenuOf(html: string): string | null {
  return /<details class="gf-account-menu">[\s\S]*?<\/details>/u.exec(html)?.[0] ?? null;
}

describe('アカウントのメニュー（2.3.7 v1.57 / #372）', () => {
  const signedIn = siteHead({ title: 'x', viewer: siteViewerAt('/terms', true, null) });
  const signedOut = siteHead({ title: 'x', viewer: siteViewerAt('/terms', false, null) });

  it('ログイン済みのヘッダは、アバターのメニューに 5 つをこの並びで収める（2.3.7 の #435 注記 / #469）', () => {
    const menu = accountMenuOf(signedIn);
    expect(menu, 'アカウントのメニューが無い').not.toBeNull();
    // **ヘッダの中にある**（外枠の外へ漏れていない）。
    expect(headerOf(signedIn)).toContain(menu!);
    // **並びと文言まで見る**（自分の作品 / いいねした作品 / 招待コードを発行する / 登録情報 / ログアウト）。
    const items = [...menu!.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((match) => match[1]!.replaceAll(/<[^>]+>/gu, '').trim());
    expect(items).toEqual(['自分の作品', 'いいねした作品', '招待コードを発行する', '登録情報', 'ログアウト']);
    for (const path of [MY_WORKS_PATH, LIKED_WORKS_PATH, INVITES_PATH, ACCOUNT_PATH]) {
      expect(menu!, `メニューに ${path} が無い`).toContain(`href="${path}"`);
    }
    expect(menu!).toContain(`action="${LOGOUT_PATH}"`);
    // **本人だけの画面はメニューの外（ヘッダの項目列）へ出さない**——出すと閉じたヘッダの
    // 項目が増え、v1.57 がドロップダウンにした理由が消える。
    const outside = headerOf(signedIn).replace(menu!, '');
    for (const path of [MY_WORKS_PATH, LIKED_WORKS_PATH, INVITES_PATH, ACCOUNT_PATH]) {
      expect(outside, `${path} がメニューの外にある`).not.toContain(`href="${path}"`);
    }
  });

  it('JavaScript を要求しない形である（`<details>` / `<summary>` だけで開閉する）', () => {
    const menu = accountMenuOf(signedIn)!;
    // **開閉をブラウザに持たせる。** 最初の子が `<summary>` でないと、ブラウザは既定の
    // 「詳細」を補い、こちらの名前が読み上げに乗らない。
    expect(menu).toMatch(/^<details class="gf-account-menu">\s*<summary>/u);
    // **閉じた状態で配る。** `open` を付けると、全画面が開いたメニューで本文を覆う。
    expect(menu).not.toMatch(/<details[^>]*\sopen/u);
    // **JavaScript に頼る書き方を 1 つも持たない。** どれか 1 つでもあると、切られた環境で
    // 開かない・閉じないメニューになりうる。実ブラウザで JavaScript を止めて開閉できる
    // ことは `scripts/check-page-width.sh` が 3 幅で見る。
    expect(headerOf(signedIn)).not.toContain('<script');
    expect(menu).not.toMatch(/\son[a-z]+=/u);
    expect(menu).not.toMatch(/\s(hidden|inert|tabindex)[\s=>]/u);
  });

  it('`<summary>` は読み上げに名前を渡す（図形だけにしない）', () => {
    const summary = /<summary>([\s\S]*?)<\/summary>/u.exec(accountMenuOf(signedIn)!)?.[1] ?? '';
    // 図形は `aria-hidden` で外し、**隠していない文字**が名前になる。
    const spoken = summary
      .replaceAll(/<span[^>]*aria-hidden="true"[^>]*><\/span>/gu, '')
      .replaceAll(/<[^>]+>/gu, '')
      .trim();
    expect(spoken).toBe('アカウントのメニュー');
  });

  it('ログアウトは POST のフォームで 1 つだけ置き、GET の口（href）を作らない', () => {
    // **GET なら `<img src="/auth/logout">` を踏ませるだけで他人をログアウトさせられる**
    // （`src/auth/google.ts` の経路表）。**置き場所がメニューへ移っても、この理由は変わらない。**
    const forms = (signedIn.match(/<form[^>]*>/gu) ?? []).filter((tag) =>
      tag.includes(`action="${LOGOUT_PATH}"`),
    );
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('method="post"');
    expect(signedIn).not.toContain(`href="${LOGOUT_PATH}"`);
    expect(accountMenuOf(signedIn)!).toMatch(/<button type="submit">ログアウト<\/button>/u);
  });

  it('未ログインのヘッダにはメニューもログアウトも、招待コードの発行も無い', () => {
    expect(accountMenuOf(signedOut)).toBeNull();
    expect(signedOut).not.toContain(LOGOUT_PATH);
    expect(headerOf(signedOut)).not.toContain(`href="${INVITES_PATH}"`);
    expect(headerOf(signedOut)).toContain(`href="${LOGIN_PATH}"`);
  });
});

describe('パンくず（2.3.10 / #372）', () => {
  /**
   * パンくずの区画だけを取り出す。
   *
   * @param html `siteHead` の出力
   * @returns パンくずの中身（無ければ null）
   */
  function breadcrumbOf(html: string): string | null {
    return /<nav class="gf-breadcrumb"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? null;
  }

  it('トップには出さない', () => {
    for (const signedIn of [true, false]) {
      expect(breadcrumbOf(siteHead({ title: 'Game Forge', viewer: siteViewerAt(HOME_PATH, signedIn, null) }))).toBeNull();
    }
  });

  it('`viewer` を省いた画面（POST の結果）には出さない', () => {
    expect(breadcrumbOf(siteHead({ title: '公開しました - Game Forge' }))).toBeNull();
  });

  it('ヘッダの直後に出る（本文より前）', () => {
    const head = siteHead({ title: '登録情報 - Game Forge', viewer: siteViewerAt(ACCOUNT_PATH, true, null) });
    expect(head.indexOf('<nav class="gf-breadcrumb"')).toBeGreaterThan(head.indexOf('</header>'));
    expect(head.trimEnd().endsWith('</nav>')).toBe(true);
  });

  it('階層の無い画面は「トップ › いまの画面」になり、末尾はリンクにしない', () => {
    const crumb = breadcrumbOf(
      siteHead({ title: '登録情報 - Game Forge', viewer: siteViewerAt(ACCOUNT_PATH, true, null) }),
    )!;
    expect(crumb).toContain('aria-label="パンくずリスト"');
    const items = crumb.match(/<li>[\s\S]*?<\/li>/gu) ?? [];
    expect(items).toEqual([
      `<li><a href="${HOME_PATH}">トップ</a></li>`,
      '<li><span aria-current="page">登録情報</span></li>',
    ]);
  });

  it('親は URL の末尾を削って導き、名前は表から引く（作品ページ）', () => {
    const crumb = breadcrumbOf(
      siteHead({ title: '<b>作品</b> - Game Forge', viewer: siteViewerAt('/works/abc', false, null) }),
    )!;
    const items = crumb.match(/<li>[\s\S]*?<\/li>/gu) ?? [];
    expect(items).toEqual([
      `<li><a href="${HOME_PATH}">トップ</a></li>`,
      `<li><a href="${PUBLIC_WORKS_PATH}">作品をさがす</a></li>`,
      // **題名は利用者の入力である。** `<title>` と同じくエスケープし、二重には掛けない。
      '<li><span aria-current="page">&lt;b&gt;作品&lt;/b&gt;</span></li>',
    ]);
  });

  it('画面でない親（表に無い親）は飛ばす（作者ページの `/users`）', () => {
    const crumb = breadcrumbOf(
      siteHead({ title: '作者 の作品 - Game Forge', viewer: siteViewerAt('/users/u1', false, null) }),
    )!;
    expect(crumb.match(/<a /gu)).toHaveLength(1);
    expect(crumb).not.toContain('href="/users"');
  });

  it('要求のパスそのものは HTML へ出さない（親を引く鍵にしか使わない）', () => {
    const crumb = breadcrumbOf(
      siteHead({ title: 'x', viewer: siteViewerAt('/works/"><script>', false, null) }),
    )!;
    expect(crumb).not.toContain('<script>');
    expect(crumb).not.toContain('"><');
  });

  it('`<title>` の末尾のサービス名だけを落とす', () => {
    expect(breadcrumbLabelOf('作品をさがす - Game Forge')).toBe('作品をさがす');
    expect(breadcrumbLabelOf('招待を発行する')).toBe('招待を発行する');
    // サービス名しか無い題を空にしない。
    expect(breadcrumbLabelOf(' - Game Forge')).toBe(' - Game Forge');
    expect(breadcrumbLabelOf('Game Forge に登録する')).toBe('Game Forge に登録する');
  });

  it('親の表は、トップを含まない', () => {
    // トップは常に先頭に置く起点で、表に入れると 2 度出る。
    expect(BREADCRUMB_PARENTS.map((item) => item.path)).not.toContain(HOME_PATH);
  });
});

describe('パスから親の候補を導く（ancestorPathsOf / 2.3.10）', () => {
  it('末尾を 1 段ずつ削り、浅い順に返す（`/` は含まない）', () => {
    expect(ancestorPathsOf('/')).toEqual([]);
    expect(ancestorPathsOf('/account')).toEqual([]);
    expect(ancestorPathsOf('/works/abc')).toEqual(['/works']);
    expect(ancestorPathsOf('/signup/waitlist/thanks')).toEqual(['/signup', '/signup/waitlist']);
  });

  it('前方一致の接頭辞を渡しても、実際のパスと同じ親になる', () => {
    expect(ancestorPathsOf('/works/')).toEqual(ancestorPathsOf('/works/abc'));
  });

  it('空の段を候補にしない', () => {
    expect(ancestorPathsOf('//x')).toEqual([]);
  });
});
