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
 * ヘッダのナビとパンくず（2.3.7 / 2.3.10）は行き先の綴りを要るので、このモジュールは
 * `src/works-paths.ts` / `src/account-paths.ts` / `src/liked-works-paths.ts` /
 * `src/legal-paths.ts` / `src/news-paths.ts` / `src/paths.ts` / `src/page-paths.ts` / `src/session.ts` と
 * **`src/auth/google.ts` の `LOGIN_PATH` / `LOGOUT_PATH`** を読む。**どれもここへ戻ってこない**
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

import { ACCOUNT_PATH } from './account-paths.js';
import { LOGIN_PATH, LOGOUT_PATH } from './auth/google.js';
import { TAKEDOWN_PATH } from './legal-paths.js';
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import type { NewsArticle } from './news-articles.js';
import { NEWS_ARTICLES } from './news-articles.js';
import { NEWS_PATH } from './news-paths.js';
import { ancestorPathsOf } from './page-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH, SIGNUP_PATH } from './paths.js';
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
 * 外枠の出し分けに要る、いま見ている人と、いま開いている画面（2.3.7 / 2.3.10 / #331 / #372）。
 *
 * **持つのは 2 つだけである。** ヘッダが変えるのは「ログイン」とアカウントのメニューの
 * 入れ替えだけで、利用者 id も表示名も要らない。**要らない値を運ぶと、全画面の外枠が
 * それを出せる場所になる**（`src/work-card.ts` が「D1 の値を HTML へ入れる場所は 2 つに
 * 限られる」と書いている前提を、外枠の側から崩さないため）。
 *
 * ## `path` を足した理由（#372）
 *
 * **パンくずは外枠の 1 か所で組む**（2.3.10）ので、外枠が「いまどの画面か」を知る必要が
 * できた。**画面（GET）は既に `viewer` を必ず渡している**（{@link SiteHeadOptions}）ので、
 * そこへ同乗させれば**画面を足す人に新しい義務が 1 つも増えない**——
 * {@link resolveSiteViewer} を使う画面は 1 行も変えずにパンくずへ乗る。**型で必須にして
 * あるので、渡し忘れはコンパイルで止まる。**
 *
 * **`path` は HTML へ出さない。** 使うのは親の名前の表を引く鍵としてだけで、パンくずに
 * 出る綴りはすべて表（{@link BREADCRUMB_PARENTS}）の定数である。要求の URL をそのまま
 * 属性へ入れる経路を作らない。
 */
export interface SiteViewer {
  /** 署名の通ったセッションを持っているか。 */
  readonly signedIn: boolean;
  /**
   * いま開いている画面のパス（`URL#pathname`）。
   *
   * **前方一致の経路なら接頭辞（`/works/`）でもよい。** パンくずが見るのは親だけで、
   * 親は末尾を削って導く（`src/page-paths.ts` の `ancestorPathsOf`）ので、同じ親になる。
   */
  readonly path: string;
}

/**
 * 状態が既に分かっている画面の `viewer` を作る。
 *
 * **`resolveSessionUser` を通った経路はこれを使う**（`src/my-works.ts` など）。
 * あちらは既に署名を検証しているので、外枠のためにもう一度 HMAC を回す理由が無い。
 * そうでない画面は {@link resolveSiteViewer} を使う。
 *
 * @param path いま開いている画面のパス（{@link SiteViewer.path}）
 * @param signedIn 署名の通ったセッションを持っているか
 * @returns 外枠の出し分けに使う状態
 */
export function siteViewerAt(path: string, signedIn: boolean): SiteViewer {
  return { signedIn, path };
}

/**
 * 要求から、外枠の出し分けに要る状態だけを求める（2.3.7 / 2.3.10 / 2.3.3 の条件 3）。
 *
 * ## なぜ `resolveSessionUser` を使わないのか
 *
 * あちらは **D1 を 1 行読む**（BAN と利用者の不在まで見る。`src/session-user.ts`）。
 * ここが欲しいのは「ヘッダにどちらの項目を出すか」だけで、**判断の重さが違う。**
 *
 * - **`src/legal.ts` は D1 に触らないモジュールである**（あのファイルの冒頭）。
 *   外枠のためにそこへ D1 を持ち込むと、規約と削除申請の画面が D1 の可用性に
 *   ぶら下がる——**権利者向けの窓口は、いちばん落としてはいけない画面である。**
 * - **BAN を素通りさせても漏れない。** ヘッダが出すのは本人だけの画面への**リンク**と
 *   ログアウトの**フォーム**で、リンクの先は `resolveSessionUser` が改めて見る（BAN された
 *   利用者はログインへ送られる）。**出し分けを間に受けて認可を省く経路は 1 本も無い。**
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
 * @returns 外枠の出し分けに使う状態
 */
export async function resolveSiteViewer(request: Request, env: Env): Promise<SiteViewer> {
  const path = new URL(request.url).pathname;
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) {
    return siteViewerAt(path, false);
  }
  try {
    const verified = await verifySession(token, env.SESSION_SECRET);
    return siteViewerAt(path, verified.ok);
  } catch (error) {
    // 鍵の設定そのものが壊れている。**黙らせない**が、画面は返す。
    console.error(
      `[html] ヘッダの出し分けでセッションを検証できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return siteViewerAt(path, false);
  }
}

/**
 * ヘッダ・フッタ・パンくずに置く 1 項目。
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
 * ログイン済みのときだけ出る、アカウントのメニューの中身（2.3.7 v1.57 / #372）。
 *
 * **ログアウトはここに入れない**——あれはリンクではなく POST のフォームで、
 * {@link accountMenu} が別に組む（`NavItem` へ POST を持ち込まない）。
 *
 * ## いいねした作品をここへ入れた（v1.57 で 2.3.7 を覆した）
 *
 * v1.56 までは「本人だけの画面が 2 枚並ぶので、**ヘッダの項目を増やさない**」として
 * 外していた。**ドロップダウンの中身は、ヘッダの項目ではない**——増えるのは畳まれた
 * 中身で、閉じているヘッダの幅は 1 項目（アバター）ぶんのままである。「あなたの作品」の
 * 本文にある導線（`src/my-works.ts`）はそのまま残す。
 */
const ACCOUNT_MENU_ITEMS: readonly NavItem[] = [
  { path: MY_WORKS_PATH, label: '自分の作品' },
  { path: LIKED_WORKS_PATH, label: 'いいねした作品' },
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
 * アカウントのメニュー（アバター＋ドロップダウン。2.3.7 v1.57 / #372）。
 *
 * ## JavaScript を要求しない（`<details>` / `<summary>`）
 *
 * **開閉はブラウザが持つ。** `<summary>` はそれ自体がキーボードで辿れ、Enter / Space で
 * 開閉し、支援技術には「展開できるもの」とその開閉の状態が伝わる（`aria-expanded` を
 * 手で書く必要が無い）。**JavaScript を切った環境でも同じに動く**——ここに `onclick` も
 * `hidden` も置かないこと。実ブラウザで JavaScript を止めて開閉できることは
 * `scripts/check-page-width.sh` が 3 幅すべてで見る。
 *
 * **閉じるのは `<summary>` をもう一度押したときだけである。** 外側を押しても Esc でも
 * 閉じない（それには JavaScript が要る）。app.css の制約「JavaScript を増やさない」を
 * 優先した。
 *
 * ## ログアウトを POST のフォームで収める（v1.57 で 2.3.7 を覆した）
 *
 * **ログアウトが POST でしか受けない理由は変わっていない**——GET なら
 * `<img src="/auth/logout">` を踏ませるだけで他人をログアウトさせられる
 * （`src/auth/google.ts` の経路表）。**変わったのは置き場所だけである**（#362 までは
 * `/account` の本文が持っていた）。
 *
 * **CSRF はトークンで守らない。** セッション cookie は `SameSite=Lax`（8.1 /
 * `src/session.ts`）で、他サイトからの POST には cookie が乗らない。`/account` に
 * 置いていたとき（#362）と同じ根拠が、置き場所を変えてもそのまま当てはまる。
 * **cookie の属性を緩めるなら、その時点でここも見直すこと。**
 *
 * ## アバターは既定の図形である
 *
 * **画像を受け取る経路が、まだ無い**（M12-12 / #380 が作る）。いまは CSS の円で、
 * 読み上げには「アカウントのメニュー」という名前だけを渡す（図形は `aria-hidden`）。
 *
 * @returns HTML
 */
function accountMenu(): string {
  const items = ACCOUNT_MENU_ITEMS.map(
    (item) => `<li><a href="${item.path}">${escapeHtml(item.label)}</a></li>`,
  ).join('\n        ');
  return `<details class="gf-account-menu">
      <summary><span class="gf-avatar" aria-hidden="true"></span><span class="gf-account-menu-name">アカウントのメニュー</span></summary>
      <ul class="gf-account-menu-list">
        ${items}
        <li><form method="post" action="${LOGOUT_PATH}"><button type="submit">ログアウト</button></form></li>
      </ul>
    </details>`;
}

/**
 * 全画面の先頭に出すヘッダ（#266。#331 でナビを、#372 でアカウントのメニューを入れた）。
 *
 * ここが要るのは、**共有された URL から `/works/<id>` へ直接来た人**である。
 * その画面の `<h1>` は作品の題名で、いま見ているのが何のサイトかを示すものが
 * どこにも無かった。主 KPI（フォーク率）の入口なので、そこを空けておかない。
 *
 * ## 実在する行き先だけで組む（2.3.7）
 *
 * **項目を増やすときは、まず仕様 2.3.7 を変える。** ここは 2.3.7 の写しであって
 * 正本ではない。とくに**行き先の無いリンクを置かない**（4.4 / 2.2 の「押せないボタンや
 * 押しても何も起きないボタンは出さない」）。ヘッダ・フッタ・パンくずのリンクが
 * すべて経路表の画面を指すことは `test/page-shell.test.ts` が全画面で見る。
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
  // **アカウントのメニューはナビの末尾に置く。** 広い段では器がナビを右へ寄せる
  // （app.css の `@section shell` の段 2）ので、末尾がそのまま右上になる。
  const tail = viewer.signedIn ? accountMenu() : navLinks(HEADER_SIGNED_OUT_ITEMS);
  return `
<header class="gf-header">${logo}
  <nav class="gf-header-nav" aria-label="サイト内の主な行き先">
    ${navLinks(HEADER_COMMON_ITEMS)}
    ${tail}
  </nav>
</header>`;
}

/** パンくずの起点（2.3.10）。**全画面の親なので、表に入れず常に先頭へ置く。** */
const BREADCRUMB_HOME: NavItem = { path: HOME_PATH, label: 'トップ' };

/**
 * お知らせの一覧をパンくずの親に入れるか（#375）。
 *
 * **記事が 0 本なら入れない。** そのとき `src/news.ts` の `createNewsRoutes` は一覧の経路を
 * 登録しない（空の一覧を置かない）ので、ここに残すと**行き先の無い親**になる（2.3.7）。
 * 経路と同じ条件をここでも見る。
 *
 * **記事の定義（`src/news-articles.ts`）は import を持たない葉なので、ここから読んでも
 * 循環しない**（画面の `src/news.ts` からは借りない。冒頭の理由）。
 *
 * @param articles お知らせの記事
 * @returns 親の項目（0 本なら空）
 */
export function newsBreadcrumbParents(articles: readonly NewsArticle[]): readonly NavItem[] {
  return articles.length === 0 ? [] : [{ path: NEWS_PATH, label: 'お知らせ' }];
}

/**
 * パンくずの親になる画面と、そのときの名前（2.3.10 / #372）。
 *
 * ## 一覧を持つのは、親になる画面の側だけである
 *
 * **階層は URL から導く**（`src/page-paths.ts` の `ancestorPathsOf`）。ここに並べるのは
 * **子を持つ画面**だけで、葉の画面（`/account` / `/generate` / 作品ページ…）は 1 行も
 * 書かずにパンくずへ乗る——いま開いている画面の名前は `<title>` から取る
 * （{@link breadcrumbLabelOf}）。**画面を足した人が書き足すのは、その画面が別の画面の
 * 親になったときだけ**である（`src/page-paths.ts` の `NON_PAGE_PATHS` と同じ、
 * 「例外の側が一覧を持つ」向き）。
 *
 * ## 表が腐らないことは機械で見る（`.ai-playbook/shared-ai-rules.md` 12 章）
 *
 * `test/page-shell.test.ts` が経路表から導いて 3 つを突き合わせる。
 *
 * 1. **画面である親が 1 つも漏れていない**（経路表の画面を末尾から削って出来た画面が、
 *    すべてここにある）——漏れると、その親はパンくずから黙って消える
 * 2. **ここの行き先がすべて画面である**——行き先の無いリンクを出さない（2.3.7）
 * 3. **ここの名前が、その画面を開いたときの末尾の名前と一致する**——親として見た名前と
 *    自分自身として見た名前がずれない
 *
 * **`/users` が無いのは漏れではない。** 作者ページ（`/users/<id>`）を削った `/users` は
 * 経路表に無いので、パンくずは「トップ › 〇〇 の作品」になる。
 */
export const BREADCRUMB_PARENTS: readonly NavItem[] = [
  { path: PUBLIC_WORKS_PATH, label: '作品をさがす' },
  { path: SIGNUP_PATH, label: 'Game Forge に登録する' },
  { path: TAKEDOWN_PATH, label: '削除申請' },
  ...newsBreadcrumbParents(NEWS_ARTICLES),
];

/** 全画面の `<title>` の末尾に付く、サービス名の区切り。 */
const TITLE_SUFFIX = ' - Game Forge';

/**
 * `<title>` から、パンくずの末尾に出す名前を取り出す（2.3.10 / #372）。
 *
 * **画面の名前を別に持たない。** 全画面が `siteHead` へ `title` を必ず渡しており、
 * 作品ページなら作品名、作者ページなら作者名がそこに入っている。**パンくずのためだけに
 * 2 つ目の名前を渡させると、画面を足す人の義務が増え、しかも `<title>` とずれうる。**
 *
 * 末尾のサービス名（` - Game Forge`）だけを落とす。付いていない題（`招待を発行する`）は
 * そのまま使う。
 *
 * @param title `siteHead` に渡された `title`（エスケープ前）
 * @returns パンくずの末尾の名前（エスケープ前）
 */
export function breadcrumbLabelOf(title: string): string {
  return title.endsWith(TITLE_SUFFIX) && title.length > TITLE_SUFFIX.length
    ? title.slice(0, -TITLE_SUFFIX.length)
    : title;
}

/**
 * パンくず（2.3.10 / #372）。
 *
 * ## ヘッダの直後に 1 か所だけ置く
 *
 * **画面ごとに書かない。** `siteHead` を通る画面は、黙ってこれに乗る。
 *
 * - **トップには出さない**（親が無い）
 * - **`viewer` を省いた画面（POST の結果）には出さない**——ナビを出さないのと同じ理由で、
 *   「いまどこに居るか」を言えない画面では言わない（{@link siteHeader}）
 * - **末尾（いま開いている画面）はリンクにしない。** `aria-current="page"` を付けた
 *   文字として出す。自分自身へのリンクは押しても何も起きない（4.4 / 2.2）
 * - **区切りの記号は CSS が出す**（app.css の `@section breadcrumb`）。HTML に置くと
 *   読み上げが項目ごとに記号を読む
 *
 * **構造化データ（JSON-LD の `BreadcrumbList`）は置かない**（#372 の scope.out）。
 *
 * @param viewer いま見ている人と画面
 * @param title `siteHead` に渡された `title`
 * @returns HTML（出さないときは空文字）
 */
function siteBreadcrumb(viewer: SiteViewer | undefined, title: string): string {
  if (viewer === undefined || viewer.path === HOME_PATH) {
    return '';
  }
  const parents = ancestorPathsOf(viewer.path)
    .map((path) => BREADCRUMB_PARENTS.find((item) => item.path === path))
    .filter((item): item is NavItem => item !== undefined);
  const links = [BREADCRUMB_HOME, ...parents]
    .map((item) => `<li><a href="${item.path}">${escapeHtml(item.label)}</a></li>`)
    .join('\n    ');
  return `
<nav class="gf-breadcrumb" aria-label="パンくずリスト">
  <ol>
    ${links}
    <li><span aria-current="page">${escapeHtml(breadcrumbLabelOf(title))}</span></li>
  </ol>
</nav>`;
}

/**
 * フッタの区画（2.3.7）。
 *
 * **`src/legal.ts` の `siteFooter` が使う。** ここに置くのは、ヘッダの
 * {@link HEADER_COMMON_ITEMS} と同じ「サービス」の 2 項目を**2 度書かない**ためである。
 */
export const FOOTER_SERVICE_ITEMS: readonly NavItem[] = HEADER_COMMON_ITEMS;

/**
 * フッタの 1 区画を組み立てる。
 *
 * **項目が 1 つも無い区画は、見出しごと出さない**（#372）。空の区画を置くことは
 * 「出来ていないものを出来ているように書く」ことである（2.3.7 / `src/home.ts`）。
 * これで、行き先がまだ無い区画（お問い合わせ。#373 が行き先を作る）を**枠だけ先に
 * 置いておける**——項目を足した日に、見出しと一緒に現れる。
 *
 * @param heading 区画の見出し
 * @param items 並べる項目
 * @returns HTML（項目が無ければ空文字）
 */
export function footerSection(heading: string, items: readonly NavItem[]): string {
  if (items.length === 0) {
    return '';
  }
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
  /**
   * `<title>` の中身。**エスケープはこの関数が行う**（呼び出し側で二重に掛けない）。
   *
   * **パンくずの末尾の名前にもなる**（{@link breadcrumbLabelOf}）。
   */
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
   * いま見ている人と、いま開いている画面（2.3.7 のヘッダの出し分けと、2.3.10 のパンくず）。
   *
   * **画面（GET）は必ず渡す。** 省くとナビもパンくずも出ない（{@link siteHeader}）。
   * `resolveSessionUser` を通った経路は {@link siteViewerAt} を、そうでない画面は
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
 * ヘッダ・アカウントのメニュー・パンくず（#372）も、ここを通る画面には黙って乗る。
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
 * @returns `<!doctype html>` から始まる文書の頭と、共通ヘッダとパンくず
 */
export function siteHead(options: SiteHeadOptions): string {
  const robots = options.noindex === true ? '\n<meta name="robots" content="noindex">' : '';
  const beforeTitle = options.beforeTitle ?? '';
  const extraHead = options.extraHead ?? '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${APP_CSS_PATH}">${beforeTitle}${robots}
<title>${escapeHtml(options.title)}</title>${extraHead}${siteHeader(options.viewer)}${siteBreadcrumb(
    options.viewer,
    options.title,
  )}`;
}
