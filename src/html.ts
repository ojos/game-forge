/**
 * 画面を組み立てるときの小さな道具。
 *
 * ## なぜ独立したモジュールなのか
 *
 * `escapeHtml` は `src/signup.ts` が持っていたが、**`src/legal.ts` が借りた時点で
 * 循環参照になった**——`legal` は `signup` の `escapeHtml` を読み、`signup` は
 * `legal` の `siteFooter` を読む（Copilot の指摘。2026-09-04）。
 *
 * **いまは動く。** どちらもトップレベルで相手を呼んでいないためだが、
 * **テンプレートを定数へ畳んだ日に、初期化前の参照で落ちる。** 落ち方が分かりにくい
 * ので、**借りられる側を独立させて向きを一方向にする。**
 *
 * ## ここが import してよいのは、葉と「戻らない側」だけである（#331）
 *
 * ヘッダのナビ（2.3.7）は行き先の綴りを要るので、このモジュールは
 * `src/works-paths.ts` / `src/account-paths.ts` / `src/paths.ts` / `src/session.ts` と
 * **`src/auth/google.ts` の `LOGIN_PATH`** を読む。**どれもここへ戻ってこない**
 * ——`src/auth/google.ts` が辿るのは経路表・セッション・招待だけで、画面を 1 枚も
 * import しない（確かめずに足さないこと。上の循環参照はそれで生まれた）。
 *
 * **画面のモジュールからは綴りを借りない。** 画面は `siteHead` を呼ぶので、必ず
 * 循環参照になる。綴りは値だけの葉に置く（`src/account-paths.ts` の冒頭が、この
 * issue を名指しでそう書いている）。
 *
 * ## このモジュールは Lambda の束に入らない
 *
 * `scripts/check-orchestrator-bundle.sh` が `siteHead` の宣言を探して押さえている。
 * **ここへ import を足しても束は太らない**が、**逆向き**——オーケストレータが読む
 * モジュールがここを import する形——は本番配備を止める（#266 / #283 / #336）。
 */

/**
 * HTML の特殊文字を実体参照へ置き換える。
 *
 * **属性値にも本文にも使える形にする。** `"` と `'` まで含めるのは、属性を
 * 引用符で囲む書き方が混ざったときに片方だけ安全になる状態を作らないためである。
 *
 * @param value 元の文字列
 * @returns 置き換えた文字列
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

import { LOGIN_PATH } from './auth/google.js';
import { ACCOUNT_PATH } from './account-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH } from './paths.js';
import { readSessionCookie, verifySession } from './session.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from './works-paths.js';

/**
 * 見た目の土台となる 1 枚の CSS のパス（9.3 / #266）。
 *
 * **`public/` から静的に配る。** Worker も D1 も CPU も通らない。
 *
 * **ただし、静的に配られるのは `public/_routes.json` の `exclude` に入っているからである。**
 * `functions/[[path]].ts` は catch-all なので、`exclude` が無いと Pages は `/*` をすべて
 * Functions へ流し、実体があっても 404 になる（実測。`docs/pages-deploy.md`）。
 * このパスが `exclude` に含まれることは `test/page-shell.test.ts` が機械検査する。
 *
 * **各ページへ `<style>` を差し込む案は採らない。** すべてのページ応答に
 * `cache-control: no-store` が付いており（`src/routes.ts` の `html()`）、CSS 本文が
 * ページを開くたび丸ごと再送される。`no-store` は保存そのものを禁じるため、
 * 再検証で 304 に落とすこともできない。
 *
 * このパスが経路表のどの `path` とも衝突しないことは `test/page-shell.test.ts` が見る。
 */
export const APP_CSS_PATH = '/assets/app.css';

/**
 * ヘッダの出し分けに要る、いま見ている人の状態（2.3.7 / #331）。
 *
 * **持つのは 1 ビットだけである。** ヘッダが変えるのは「ログイン」と「自分の作品・
 * 登録情報」の入れ替えだけで、利用者 id も表示名も要らない。**要らない値を運ぶと、
 * 全画面の外枠がそれを出せる場所になる**（`src/work-card.ts` が「D1 の値を HTML へ
 * 入れる場所は 2 つに限られる」と書いている前提を、外枠の側から崩さないため）。
 */
export interface SiteViewer {
  /** 署名の通ったセッションを持っているか。 */
  readonly signedIn: boolean;
}

/**
 * ログイン済みとしてヘッダを組む。
 *
 * **`resolveSessionUser` を通った経路はこれを渡す**（`src/my-works.ts` など）。
 * あちらは既に署名を検証しているので、外枠のためにもう一度 HMAC を回す理由が無い。
 */
export const VIEWER_SIGNED_IN: SiteViewer = { signedIn: true };

/** 未ログインとしてヘッダを組む。 */
export const VIEWER_SIGNED_OUT: SiteViewer = { signedIn: false };

/**
 * 要求から、ヘッダの出し分けに要る状態だけを求める（2.3.7 / 2.3.3 の条件 3）。
 *
 * ## なぜ `resolveSessionUser` を使わないのか
 *
 * あちらは **D1 を 1 行読む**（BAN と利用者の不在まで見る。`src/session-user.ts`）。
 * ここが欲しいのは「ヘッダにどちらの項目を出すか」だけで、**判断の重さが違う。**
 *
 * - **`src/legal.ts` は D1 に触らないモジュールである**（あのファイルの冒頭）。
 *   外枠のためにそこへ D1 を持ち込むと、規約と削除申請の画面が D1 の可用性に
 *   ぶら下がる——**権利者向けの窓口は、いちばん落としてはいけない画面である。**
 * - **BAN を素通りさせても漏れない。** ヘッダが出すのは `/works/mine` と `/account`
 *   への**リンク**で、その先は `resolveSessionUser` が改めて見る（BAN された利用者は
 *   ログインへ送られる）。**出し分けを間に受けて認可を省く経路は 1 本も無い。**
 *
 * ## 投げない
 *
 * `verifySession` は `SESSION_SECRET` が未設定・短いときに投げる（`src/session.ts`）。
 * **外枠が原因で画面ごと 500 になる形を作らない**——それはヘッダの 1 行のために
 * 本文まで消すことである。落とさず未ログインへ倒し、事実はログへ残す。
 *
 * **cookie が無ければ秘密鍵に触らない。** 未ログインの閲覧（共有 URL を踏んだ大半）で
 * 鍵の import が 1 度も走らない形にしておく。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns ヘッダの出し分けに使う状態
 */
export async function resolveSiteViewer(request: Request, env: Env): Promise<SiteViewer> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) {
    return VIEWER_SIGNED_OUT;
  }
  try {
    const verified = await verifySession(token, env.SESSION_SECRET);
    return verified.ok ? VIEWER_SIGNED_IN : VIEWER_SIGNED_OUT;
  } catch (error) {
    // 鍵の設定そのものが壊れている。**黙らせない**が、画面は返す。
    console.error(
      `[html] ヘッダの出し分けでセッションを検証できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return VIEWER_SIGNED_OUT;
  }
}

/**
 * ヘッダとフッタに置く 1 項目。
 *
 * **綴りは持たない。** パスは各モジュールの定数から取る（`MY_WORKS_PATH` など）。
 * ここに文字列を書くと、経路を変えた日にヘッダだけが古い行き先を指す。
 */
export interface NavItem {
  readonly path: string;
  readonly label: string;
}

/**
 * ログイン状態によらずヘッダに出る項目（2.3.7）。
 *
 * **`/generate` は未ログインでも出す。** 行き先は実在し、未ログインで開けば登録と
 * ログインの導線が出る（`src/generate-page.ts` の `signedOutSection`）。4.4 / 2.2 が
 * 禁じているのは**押しても何も起きない**ボタンで、これはそれに当たらない。
 */
const HEADER_COMMON_ITEMS: readonly NavItem[] = [
  { path: PUBLIC_WORKS_PATH, label: '作品をさがす' },
  { path: GENERATE_PAGE_PATH, label: 'つくる' },
];

/**
 * ログイン済みのときだけ出る項目（2.3.7 / 5.9）。
 *
 * **自分のいいね一覧（`/works/liked`）を足さないこと。** 2.3.7 が明示して外している
 * ——本人だけの画面が 2 枚並ぶので、ヘッダの項目を増やさない。導線は「自分の作品」の
 * 画面が持つ（`src/my-works.ts`）。**この規律は `test/page-shell.test.ts` が全画面で
 * 機械照合する**（呼びかけでは守れない）。
 */
const HEADER_SIGNED_IN_ITEMS: readonly NavItem[] = [
  { path: MY_WORKS_PATH, label: '自分の作品' },
  { path: ACCOUNT_PATH, label: '登録情報' },
];

/** 未ログインのときだけ出る項目（2.3.7）。 */
const HEADER_SIGNED_OUT_ITEMS: readonly NavItem[] = [{ path: LOGIN_PATH, label: 'ログイン' }];

/**
 * 項目をリンクの列へ落とす。
 *
 * **`label` も `escapeHtml` を通す。** いまはこのファイルが持つ固定文字列だが、
 * 出どころが変わったときに安全側が既定になっている形にしておく
 * （`src/invite-issuance.ts` と同じ理由）。
 *
 * @param items 並べる項目
 * @returns HTML
 */
function navLinks(items: readonly NavItem[]): string {
  return items
    .map((item) => `<a href="${item.path}">${escapeHtml(item.label)}</a>`)
    .join('\n    ');
}

/**
 * 全画面の先頭に出すヘッダ（#266。#331 でナビを入れた）。
 *
 * ここが要るのは、**共有された URL から `/works/<id>` へ直接来た人**である。
 * その画面の `<h1>` は作品の題名で、いま見ているのが何のサイトかを示すものが
 * どこにも無かった。主 KPI（フォーク率）の入口なので、そこを空けておかない。
 *
 * ## 実在する行き先だけで組む（2.3.7）
 *
 * **項目を増やすときは、まず仕様 2.3.7 を変える。** ここは 2.3.7 の写しであって
 * 正本ではない。とくに**行き先の無いリンクを置かない**（4.4 / 2.2 の「押せないボタンや
 * 押しても何も起きないボタンは出さない」）。
 *
 * ## ログイン状態で出し分かれることは、キャッシュの単位そのものである
 *
 * **この 1 行が、HTML を共有キャッシュへ載せられない理由である**（2.3.3 の条件 3）。
 * 未ログインの閲覧で組んだ HTML がログイン済みの利用者へ配られてはいけない。
 * **キャッシュに載せるのは D1 から引いた行だけ**にする（`src/list-cache.ts`）。
 * `src/routes.ts` の `html()` が `cache-control: no-store` を固定で付けているのも
 * 同じ結論を別の側から支えている。
 *
 * ## `viewer` を省いたときはナビを出さない
 *
 * **未ログインとして描かない。** 省くのは POST の結果を返す画面（`src/publish.ts` /
 * `src/fork.ts` / `src/revise.ts` / `src/likes.ts` / `src/ogp-recapture.ts`）で、
 * **そこはログイン済みの利用者しか踏まない**——未ログイン用のナビを出すと
 * 「ログイン」が出たまま操作が成功していることになる。**間違ったことを言うより、
 * 言わないほうを既定にする。**
 *
 * 画面（GET）の側で省き忘れることは `test/page-shell.test.ts` が塞ぐ——経路表から
 * 導いた全画面について、両方の状態でナビを照合する。
 *
 * @param viewer いま見ている人の状態（省略するとナビを出さない）
 * @returns HTML
 */
function siteHeader(viewer: SiteViewer | undefined): string {
  const logo = `<a class="gf-header-logo" href="${HOME_PATH}">Game Forge</a>`;
  if (viewer === undefined) {
    return `\n<header class="gf-header">${logo}</header>`;
  }
  const items = [
    ...HEADER_COMMON_ITEMS,
    ...(viewer.signedIn ? HEADER_SIGNED_IN_ITEMS : HEADER_SIGNED_OUT_ITEMS),
  ];
  return `
<header class="gf-header">${logo}
  <nav class="gf-header-nav" aria-label="サイト内の主な行き先">
    ${navLinks(items)}
  </nav>
</header>`;
}

/**
 * フッタの区画（2.3.7）。
 *
 * **2 区画だけである。** AivisHub は 5 区画（サービス / 法務 / 会社情報 / SNS /
 * お問い合わせ）を持つが、**残り 3 つは行き先が実在しない。** 無い区画は置かない
 * ——空の区画を置くことは「出来ていないものを出来ているように書く」ことである
 * （`src/home.ts` が既に持っている規律）。
 *
 * **`src/legal.ts` の `siteFooter` が使う。** ここに置くのは、ヘッダの
 * {@link HEADER_COMMON_ITEMS} と同じ「サービス」の 2 項目を**2 度書かない**ためである。
 */
export const FOOTER_SERVICE_ITEMS: readonly NavItem[] = HEADER_COMMON_ITEMS;

/**
 * フッタの 1 区画を組み立てる。
 *
 * @param heading 区画の見出し
 * @param items 並べる項目
 * @returns HTML
 */
export function footerSection(heading: string, items: readonly NavItem[]): string {
  const list = items
    .map((item) => `      <li><a href="${item.path}">${escapeHtml(item.label)}</a></li>`)
    .join('\n');
  return `  <div class="gf-footer-group">
    <h2 class="gf-footer-heading">${escapeHtml(heading)}</h2>
    <ul>
${list}
    </ul>
  </div>`;
}

/** {@link siteHead} に渡す設定。 */
export interface SiteHeadOptions {
  /** `<title>` の中身。**エスケープはこの関数が行う**（呼び出し側で二重に掛けない）。 */
  readonly title: string;
  /** 検索避けが要る画面なら true。 */
  readonly noindex?: boolean;
  /** `<title>` のあとへ足す HTML（OGP の `meta` など）。既にエスケープ済みで渡す。 */
  readonly extraHead?: string;
  /**
   * `<title>` より前へ足す HTML（`http-equiv` の再読み込みなど）。
   *
   * 入るのは `<link rel="stylesheet">` の直後で、**`<meta charset>` より前へは置けない**
   * （下の「`charset` を最初に置く」）。
   */
  readonly beforeTitle?: string;
  /**
   * いま見ている人の状態（2.3.7 のヘッダの出し分け）。
   *
   * **画面（GET）は必ず渡す。** 省くとナビが出ない（{@link siteHeader}）。
   * `resolveSessionUser` を通った経路は {@link VIEWER_SIGNED_IN} を、そうでない画面は
   * {@link resolveSiteViewer} の戻り値を渡す。
   */
  readonly viewer?: SiteViewer;
}

/**
 * 全画面に共通する文書の頭を組み立てる（#266）。
 *
 * ## なぜ 1 か所に置くか
 *
 * `siteFooter` と同じ理由である。**各ページで組み立てると、画面を 1 枚足したときに
 * 書き漏らす。** 実際 #282 では、全画面へ足したはずのフッタが 1 枚だけ違う位置に
 * 付いていた。ここを通す形にしておけば、**新しい画面は黙って土台に乗る。**
 *
 * 乗り損ねたことは `test/page-shell.test.ts` が経路表から導いて検出するが、
 * **検査は最後の砦であって一次の対策ではない。** 書き漏らしようがない形を先に作る。
 *
 * ## `charset` を最初に置く
 *
 * `<meta charset>` は文書の先頭 1024 バイト以内になければならない。`extraHead` を
 * 前へ回せる形にすると、呼び出し側の都合でそこが崩れうるので、**足せるのは
 * `charset` より後ろだけ**にしてある。
 *
 * ## `extraHead` はヘッダより前に出す
 *
 * `<meta>` は本文が始まる前に無ければならない。ヘッダ（`<header>`）は本文なので、
 * **必ず `extraHead` の後ろへ置く。** 逆にすると OGP の `meta` が本文へ落ち、
 * 共有時に読まれなくなる。
 *
 * @param options 設定
 * @returns `<!doctype html>` から始まる文書の頭と、共通ヘッダ
 */
export function siteHead(options: SiteHeadOptions): string {
  const robots = options.noindex === true ? '\n<meta name="robots" content="noindex">' : '';
  const beforeTitle = options.beforeTitle ?? '';
  const extraHead = options.extraHead ?? '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${APP_CSS_PATH}">${beforeTitle}${robots}
<title>${escapeHtml(options.title)}</title>${extraHead}${siteHeader(options.viewer)}`;
}
