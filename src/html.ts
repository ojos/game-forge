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
 * `src/works-paths.ts` / `src/account-paths.ts` / `src/avatar-paths.ts` / `src/liked-works-paths.ts` /
 * `src/legal-paths.ts` / `src/news-paths.ts` / `src/paths.ts` / `src/page-paths.ts` / `src/session.ts` と
 * **`src/auth/google.ts` の `LOGIN_PATH` / `LOGOUT_PATH`** を読む。**どれもここへ戻ってこない**
 * ——`src/auth/google.ts` が辿るのは経路表・セッション・招待だけで、画面を 1 枚も
 * import しない（確かめずに足さないこと。上の循環参照はそれで生まれた）。
 *
 * **検索窓の綴り（#378）は `src/work-search.ts` から読む。** あちらが辿るのは `src/games.ts` と
 * `src/reports.ts` だけで、どちらもここへ戻らない（esbuild の metafile で確かめた。2026-09-13）。
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
import { AVATAR_OUTPUT_SIZE, avatarUrl, sandboxOriginOf } from './avatar-paths.js';
import { LOGIN_PATH, LOGOUT_PATH } from './auth/google.js';
import { TAKEDOWN_PATH } from './legal-paths.js';
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import type { NewsArticle } from './news-articles.js';
import { NEWS_ARTICLES } from './news-articles.js';
import { NEWS_PATH } from './news-paths.js';
import { ancestorPathsOf } from './page-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH, INVITES_PATH, SIGNUP_PATH } from './paths.js';
import { readSessionCookie, verifySession } from './session.js';
import { MAX_SEARCH_LENGTH, WORK_SEARCH_FIELD } from './work-search.js';
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
 * ロゴの画像を置くディレクトリ（#440）。
 *
 * **正本は `brand/logo/lockup-horizontal/` で、ここにあるのはその写しである**（`docs/logo.md`）。
 * Pages が配るのは `public/` の下だけなので、正本を直接は参照できない。写しが正本と
 * 一致していることは `scripts/check-logo-copies.sh` が見る——**ロゴを書き出し直して
 * 写し忘れると、サイトだけが古いロゴのまま黙って残る。**
 */
export const LOGO_DIR = '/assets/logo';

/**
 * ロゴを描く倍率（#440）。**1 倍で表示し、2 倍と 4 倍は高密度の画面のための画像である。**
 *
 * **ドットのロゴは整数倍でしか拡大・縮小しない**（`docs/logo.md` 3 章）。表示の大きさを
 * 1 倍（{@link LOGO_WIDTH} × {@link LOGO_HEIGHT}）に固定し、画面の画素密度に合う画像を
 * `srcset` でブラウザに選ばせる。**画素密度が整数でない端末（1.5 倍など）では、選ばれた
 * 画像が縮小されてドットの幅が揃わない**——これは保証しない（#440 の constraints）。
 *
 * **3 倍の画像は持たない**（書き出しの一覧 `tools/logobake/variants.mjs` に無い）。3 倍の
 * 端末は 4 倍の画像を縮小して描く。
 */
export const LOGO_SCALES = [1, 2, 4] as const;

/** ロゴを 1 倍で描いたときの寸法（px）。`scripts/check-logo-copies.sh` が 1 倍の画像の実寸と照合する。 */
export const LOGO_WIDTH = 122;
export const LOGO_HEIGHT = 31;

/**
 * 置く地の明るさごとの `srcset`。
 *
 * @param bg 置く地の明るさ（`docs/logo.md` 3 章の `for-light-bg` / `for-dark-bg`）
 * @returns `srcset` の値
 */
function logoSrcset(bg: 'light' | 'dark'): string {
  return LOGO_SCALES.map((scale) => `${LOGO_DIR}/lockup-horizontal-x${scale}-for-${bg}-bg.png ${scale}x`).join(', ');
}

/**
 * ロゴの画像（横組み。#440 / `docs/logo.md`）。ヘッダ・フッタ・管理画面のヘッダが共有する。
 *
 * ## 明暗は `<picture>` で切り替える
 *
 * **暗い地に `for-light-bg` を置くと、金床と文字が消える**（`docs/logo.md` 3 章）。サイトの
 * 明暗は `prefers-color-scheme` だけで切り替わる（`app.css` の `@section tokens`。画面に切り替えの
 * 操作は無い）ので、**同じ条件の `<source media>` で画像を選べば、地と画像が必ず揃う。**
 * JavaScript を使わない（#266）。
 *
 * ## 読み上げには「Game Forge」を渡す
 *
 * **リンクの名前は画像の `alt` から付く。** 文字のロゴだった頃の「Game Forge」と同じ名前に
 * しておく——読み上げの利用者から見ると、#440 の前と後で何も変わらない。
 *
 * ## アンバーはロゴの中だけの例外である
 *
 * **火花のアンバー（`#F59E0B`）は、「色を持つのは作品だけ」（`app.css` の冒頭）の例外である**
 * （#440 の intake で利用者が選んだ）。**例外はこの画像の中に閉じる**——アンバーを CSS の
 * トークンにしない。トークンにすると、ボタンやリンクへ広がる入口ができる。
 *
 * @returns HTML（`<picture>`。リンクで包むのは呼ぶ側）
 */
export function siteLogo(): string {
  return `<picture class="gf-logo"><source media="(prefers-color-scheme: dark)" srcset="${logoSrcset('dark')}"><img src="${LOGO_DIR}/lockup-horizontal-x1-for-light-bg.png" srcset="${logoSrcset('light')}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Game Forge"></picture>`;
}

/**
 * 外枠の出し分けに要る、いま見ている人と、いま開いている画面（2.3.7 / 2.3.10 / #331 / #372）。
 *
 * **持つのは 3 つだけである。** ヘッダが変えるのは「ログイン」とアカウントのメニューの
 * 入れ替えと、メニューのアバターの画像だけで、表示名は要らない。**要らない値を運ぶと、全画面の外枠が
 * それを出せる場所になる**（`src/work-card.ts` が「D1 の値を HTML へ入れる場所は 2 つに
 * 限られる」と書いている前提を、外枠の側から崩さないため）。
 *
 * ## `avatarUrl` を足した理由（#380）
 *
 * **ヘッダのアバターに、本人のアイコンを出す。** 運ぶのは**画像の URL だけ**で、利用者の id を
 * そのまま外枠へ渡さない（URL の中には入る。本人の画面にしか出ない）。**D1 は読まない**——URL は
 * 署名の中の利用者の id とサンドボックス用ホストだけで決まる（`src/avatar-paths.ts`。R2 のキーを
 * 利用者ごとに固定した理由）。**設定していない利用者でも URL は出る**。画像が無ければ配信は**透明な
 * 1px の画像**を返し、下の既定の図形が見える（`src/avatar-delivery.ts`。404 にすると、Chromium は
 * `alt=""` でも壊れた画像の印を描く——実ブラウザで確かめた）。
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
  /**
   * ヘッダのアバターに差し込む画像の URL（ログイン済みのときだけ。版を付けない。`src/avatar-paths.ts`）。
   *
   * **null なら既定の図形だけを出す**（未ログイン・URL を組み立てられない利用者の id）。
   */
  readonly avatarUrl: string | null;
}

/**
 * 状態が既に分かっている画面の `viewer` を作る。
 *
 * **`resolveSessionUser` を通った経路はこれを使う**（`src/my-works.ts` など）。
 * あちらは既に署名を検証しているので、外枠のためにもう一度 HMAC を回す理由が無い。
 * そうでない画面は {@link resolveSiteViewer} を使う。
 *
 * **`avatarUrl` を必須の引数にする**（#380）。ログイン済みの画面を足す人が渡し忘れると、その画面だけ
 * ヘッダのアバターが既定の図形に戻る——**型で止める**（`path` を必須にしたのと同じ判断）。
 * 組み立ては {@link headerAvatarUrl} を使う。
 *
 * @param path いま開いている画面のパス（{@link SiteViewer.path}）
 * @param signedIn 署名の通ったセッションを持っているか
 * @param avatar ヘッダのアバターの画像の URL（未ログインなら null）
 * @returns 外枠の出し分けに使う状態
 */
export function siteViewerAt(path: string, signedIn: boolean, avatar: string | null): SiteViewer {
  return { signedIn, path, avatarUrl: signedIn ? avatar : null };
}

/**
 * ヘッダのアバターの画像の URL を組み立てる（#380）。
 *
 * **版を付けない**（D1 を読まないので版を知らない）。配信は毎回の再検証にする
 * （`src/avatar-delivery.ts`）。**宣言が欠けていれば null**（`src/index.ts` の `configuredHost` と
 * 同じく、宣言 1 つの書き忘れで外枠ごと落とさない）。
 *
 * @param request 受信したリクエスト（スキームとポートを借りる）
 * @param env バインディングと環境変数
 * @param userId ログインしている利用者の id
 * @returns 画像の URL（組み立てられなければ null）
 */
export function headerAvatarUrl(request: Request, env: Env, userId: string): string | null {
  const host: unknown = env.SANDBOX_HOST;
  if (typeof host !== 'string' || host.trim() === '') {
    return null;
  }
  return avatarUrl(sandboxOriginOf(request, host.trim()), userId, null);
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
 *   外枠のためにそこへ D1 を持ち込むと、規約と削除依頼の画面が D1 の可用性に
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
    return siteViewerAt(path, false, null);
  }
  try {
    const verified = await verifySession(token, env.SESSION_SECRET);
    return verified.ok
      ? siteViewerAt(path, true, headerAvatarUrl(request, env, verified.payload.userId))
      : siteViewerAt(path, false, null);
  } catch (error) {
    // 鍵の設定そのものが壊れている。**黙らせない**が、画面は返す。
    console.error(
      `[html] ヘッダの出し分けでセッションを検証できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return siteViewerAt(path, false, null);
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
 * ヘッダのナビの 1 項目（#469）。**見た目の強さ（仕様 2.5.5 のボタンの段）を項目が持つ。**
 *
 * **ナビは「控えめ」、「つくる」だけ「副」**（仕様 2.5.6）。**「主」は選べない形にする**——ヘッダは全画面に
 * 出るので、主を置くと「1 画面に 1 つ」の枠を全画面で使い切り、作品ページの「改造する」とぶつかる（2.5.5）。
 */
interface HeaderNavItem extends NavItem {
  /** ボタンの段（`.gf-button-tertiary` / `.gf-button-secondary`）。 */
  readonly emphasis: 'tertiary' | 'secondary';
}

/**
 * ログイン状態によらずヘッダに出る項目（2.3.7）。
 *
 * **`/generate` は未ログインでも出す。** 行き先は実在し、未ログインで開けば登録と
 * ログインの導線が出る（`src/generate-page.ts` の `signedOutSection`）。4.4 / 2.2 が
 * 禁じているのは**押しても何も起きない**ボタンで、これはそれに当たらない。
 *
 * **フッタには置かない**（#435。全画面のヘッダにあるので、同じ行き先を 1 画面に 2 度並べない）。
 */
const HEADER_COMMON_ITEMS: readonly HeaderNavItem[] = [
  { path: PUBLIC_WORKS_PATH, label: '作品をさがす', emphasis: 'tertiary' },
  { path: GENERATE_PAGE_PATH, label: 'つくる', emphasis: 'secondary' },
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
 *
 * ## 招待コードの発行をここへ入れた（#435 / #469）
 *
 * **`/invites` の入口はトップの本文だけだった**（「参加している方へ」）。#435 がトップからその節を外すと決めたので、
 * 入口を全画面のメニューへ移す（2.3.7 の #435 注記）。並びは注記のとおり、自分の作品 / いいねした作品 /
 * 招待コードを発行する / 登録情報 / ログアウト である。
 */
const ACCOUNT_MENU_ITEMS: readonly NavItem[] = [
  { path: MY_WORKS_PATH, label: '自分の作品' },
  { path: LIKED_WORKS_PATH, label: 'いいねした作品' },
  { path: INVITES_PATH, label: '招待コードを発行する' },
  { path: ACCOUNT_PATH, label: '登録情報' },
];

/**
 * 未ログインのときだけ出る項目（2.3.7）。
 *
 * **行き先は Google の認証のまま**（#469 の scope.out）。`/signup` へ向けるのは M13-8（#472）で、
 * `/signup` の作り替えと一緒に行う——先に切り替えると、ログインしたい人が「登録する」の画面に着く期間ができる。
 */
const HEADER_SIGNED_OUT_ITEMS: readonly HeaderNavItem[] = [
  { path: LOGIN_PATH, label: 'ログイン', emphasis: 'tertiary' },
];

/**
 * ヘッダのナビの項目を、小さいボタンの見た目のリンクの列へ落とす（仕様 2.5.5 / 2.5.6 / #469）。
 *
 * **要素は `<a>` のまま**——移動なので、見た目がボタンでもボタン要素にしない（2.5.5「要素は役割で選ぶ」）。
 *
 * **`label` も `escapeHtml` を通す。** いまはこのファイルが持つ固定文字列だが、
 * 出どころが変わったときに安全側が既定になっている形にしておく
 * （`src/invite-issuance.ts` と同じ理由）。
 *
 * @param items 並べる項目
 * @param extraClass 足すクラス（狭い段で並びを変える目印。無ければ空文字）
 * @returns HTML
 */
function headerButtons(items: readonly HeaderNavItem[], extraClass = ''): string {
  return items
    .map(
      (item) =>
        `<a class="gf-button gf-button-${item.emphasis} gf-button-sm${extraClass}" href="${item.path}">${escapeHtml(item.label)}</a>`,
    )
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
 * ## アバターは既定の図形の上に、本人のアイコンを重ねる（#380）
 *
 * **既定の図形（CSS の円）はそのまま残し、その中へ画像を差し込む**（#380 の利用者の決定）。**ヘッダの円だけ
 * 32px にした**（仕様 2.5.6。ナビのボタンと高さを揃える。#469）——寸法は app.css の `@section header` が持ち、
 * カードや作者ページの円は変えていない。**アイコンを設定していなければ配信は透明な 1px の画像を
 * 返すので、図形だけが見える**——D1 を読まずに「設定していない」を表せる形である（{@link SiteViewer}）。読み上げには「アカウントのメニュー」という名前だけを渡す
 * （図形も画像も `aria-hidden` の内側）。
 *
 * @param avatar アバターの画像の URL（無ければ null）
 * @returns HTML
 */
function accountMenu(avatar: string | null): string {
  const items = ACCOUNT_MENU_ITEMS.map(
    (item) => `<li><a href="${item.path}">${escapeHtml(item.label)}</a></li>`,
  ).join('\n        ');
  return `<details class="gf-account-menu">
      <summary><span class="gf-avatar" aria-hidden="true">${avatarImage(avatar)}</span><span class="gf-account-menu-name">アカウントのメニュー</span></summary>
      <ul class="gf-account-menu-list">
        ${items}
        <li><form method="post" action="${LOGOUT_PATH}"><button type="submit">ログアウト</button></form></li>
      </ul>
    </details>`;
}

/**
 * アバターの円に差し込む画像（#380。ヘッダ・カード・作者ページ・登録情報が同じ 1 つを使う）。
 *
 * **`alt=""` にする**——名前は隣の文字（「アカウントのメニュー」・作者名）が持つ。**ただし `alt=""` は
 * 壊れた画像の印を消さない**（Chromium は大きさを持つ `<img>` が読み込めないと印を描く）。だから配信は、
 * 無いアイコンにも 404 ではなく透明な 1px の画像を返す（`src/avatar-delivery.ts`）。**URL は `escapeHtml` を通す**
 * （組み立てた綴りだが、出どころが変わっても安全側が既定になる）。**`loading="lazy"` にしない**
 * ——ヘッダは画面の最上部にあり、遅らせる理由が無い（カードは画面の下まで並ぶので遅らせる）。
 *
 * @param url 画像の URL（無ければ null）
 * @param options `lazy` … `loading="lazy"` を付けるか（既定は付けない）
 * @returns HTML（URL が無ければ空文字）
 */
export function avatarImage(url: string | null, options: { readonly lazy?: boolean } = {}): string {
  if (url === null) {
    return '';
  }
  const loading = options.lazy === true ? ' loading="lazy"' : '';
  return `<img src="${escapeHtml(url)}" width="${AVATAR_OUTPUT_SIZE}" height="${AVATAR_OUTPUT_SIZE}" alt="" decoding="async"${loading}>`;
}

/**
 * ヘッダの検索窓（2.3.7 v1.57 / #378）。
 *
 * ## 素の GET のフォームである
 *
 * **JavaScript を使わない**（9.3）。送ると `/works?q=…` を開き、公開一覧が結果を描く
 * （`src/works-list.ts`）。**`action` は公開一覧の綴りの正本から取る**（書き写さない）。
 *
 * - **ラベルは見えないが、読み上げには渡す**（`<label>` を 1px に畳む。`display: none` にしない）
 * - **`size` 属性を使わない。** 既定の幅（20 文字ぶん）に文字の大きさが掛かり、390px で版面を
 *   押し広げた（#282）。幅は CSS（`@section header`）が持つ
 * - **`maxlength` は検索語の上限と同じ**（`src/work-search.ts` の `MAX_SEARCH_LENGTH`）。越えて
 *   送られても、画面が断る（ここは打ちすぎを早めに止めるだけである）
 * - **いま検索している語を戻す**（`value`）。利用者の入力なので escape する
 * - **「検索」は小さい副のボタン**（#469。仕様 2.5.5 の部品を当てる）。要素は `<button>` のまま——送信は動作である
 *
 * ## 同じ窓を 2 か所に置き、段ごとに片方だけを見せる（#469）
 *
 * 広い段ではナビの中（「つくる」の後）、狭い段ではヘッダの 2 行目に出す（{@link siteHeader}）。**見えない側は
 * `display: none`** なので、読み上げの木にも Tab の順にも入らず、**同時に見える窓は常に 1 つ**である。**`id` と
 * `<label for>` は置き場所ごとに別の値にする**（同じ文書に同じ `id` を 2 つ置かない）。
 *
 * @param query 窓に戻す検索語（検索していなければ undefined）。**両方の窓に戻す**
 * @param inputId 入力欄の `id`（{@link HEADER_SEARCH_INPUT_IDS}）
 * @returns HTML
 */
function headerSearch(query: string | undefined, inputId: string): string {
  const value = query === undefined ? '' : ` value="${escapeHtml(query)}"`;
  return `<form class="gf-header-search" role="search" method="get" action="${PUBLIC_WORKS_PATH}">
      <label class="gf-header-search-label" for="${inputId}">作品を検索</label>
      <input id="${inputId}" type="search" name="${WORK_SEARCH_FIELD}" maxlength="${MAX_SEARCH_LENGTH}" placeholder="作品を検索"${value}>
      <button class="gf-button gf-button-secondary gf-button-sm" type="submit">検索</button>
    </form>`;
}

/**
 * ヘッダの検索窓の入力欄の `id`（置き場所ごと。#469）。
 *
 * **広い段の窓は #378 からの `gf-header-search-q` のまま**にする（公開一覧の検査が、検索語が窓に戻ることをこの
 * `id` で見ている）。狭い段の窓だけ別の値を持つ。
 */
export const HEADER_SEARCH_INPUT_IDS = {
  wide: 'gf-header-search-q',
  narrow: 'gf-header-search-q-narrow',
} as const;

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
 * ## 検索窓はナビの共通の項目の後に置く（#378）
 *
 * **2.3.7 v1.57 の並び（ロゴ / 作品をさがす / つくる / 検索窓 / ログイン）どおりである。**
 * ナビを出さない画面（`viewer` を省いた POST の結果）には置かない——ナビと同じ判断で、
 * そこはログイン済みの利用者が操作の直後に見る画面である。
 *
 * ## トップだけ、ロゴを `<h1>` で包む（仕様 2.5.6 / #469）
 *
 * **トップの `<h1>` はヘッダのロゴである**（本文の `<h1>Game Forge</h1>` は同じ PR で消した。`src/home.ts`）。
 * **トップ以外ではロゴを `<h1>` にしない**——その画面の `<h1>` は作品の題名や画面の名前である。見出しの名前は
 * 画像の `alt`（「Game Forge」）から付くので、読み上げと検索にはこれまでと同じ名前が渡る。
 *
 * **トップかどうかは `viewer.path` で決める**（パンくずを出さない判断と同じ鍵。{@link siteBreadcrumb}）。`viewer` を
 * 省いた画面（POST の結果）はトップではないので包まない。
 *
 * ## 段ごとの布置は、HTML の順で作る（#469。PR #486 の Copilot code review）
 *
 * **どの段でも、HTML の順＝見た目の順＝Tab と読み上げの順にする。** CSS の `order` で並びを入れ替えず、
 * `display: contents` も使わない（`<nav>` のランドマークが一部の支援技術から消える）。
 *
 * - **広い段（1 行）**: ロゴ →`<nav>`（作品をさがす / つくる / 検索窓 / アバター または ログイン）
 * - **狭い段（2 行）**: ロゴ →`<nav>`（作品をさがす / つくる / アバター）→ 2 行目（検索窓 / ログイン）
 *
 * **段で置き場所の変わる検索窓と「ログイン」は、両方の置き場所に書き**、見えない側を app.css の `@section shell`
 * が `display: none` にする。`display: none` の要素は読み上げの木にも Tab の順にも入らないので、どちらの段でも
 * 利用者に届くのは 1 つだけである。
 *
 * **2 行目は `<nav>` の外（ヘッダの直下）に置く。** 検索窓を 2 行目の幅いっぱい（ロゴの下から）に伸ばすには、
 * ロゴの右から始まる `<nav>` の箱の外にある必要がある——`<nav>` の中に収めると、ロゴの幅を打ち消す負の余白を
 * CSS に書くことになり、ロゴの寸法と CSS が結び付く。**代償は、狭い段の「ログイン」がナビのランドマークの外に
 * 出ること**だが、ヘッダ（`<header>` のバナー）の中には残り、検索窓は自身が `role="search"` のランドマークである。
 *
 * @param viewer いま見ている人の状態（省略するとナビを出さない）
 * @param searchQuery 検索窓に戻す語（{@link SiteHeadOptions.searchQuery}）
 * @returns HTML
 */
function siteHeader(viewer: SiteViewer | undefined, searchQuery: string | undefined): string {
  const link = `<a class="gf-header-logo" href="${HOME_PATH}">${siteLogo()}</a>`;
  const logo = viewer?.path === HOME_PATH ? `<h1 class="gf-header-title">${link}</h1>` : link;
  if (viewer === undefined) {
    return `\n<header class="gf-header">${logo}</header>`;
  }
  // **アカウントのメニューはナビの末尾に置く。** 広い段では器がナビを右へ寄せる
  // （app.css の `@section shell` の段 2）ので、末尾がそのまま右上になる。
  // **「ログイン」は広い段ではナビの末尾、狭い段では 2 行目**（上の「段ごとの布置」）。目印のクラスは両方に付ける。
  const login = viewer.signedIn ? '' : headerButtons(HEADER_SIGNED_OUT_ITEMS, ' gf-header-login');
  const tail = viewer.signedIn ? accountMenu(viewer.avatarUrl ?? null) : login;
  return `
<header class="gf-header">${logo}
  <nav class="gf-header-nav" aria-label="サイト内の主な行き先">
    ${headerButtons(HEADER_COMMON_ITEMS)}
    ${headerSearch(searchQuery, HEADER_SEARCH_INPUT_IDS.wide)}
    ${tail}
  </nav>
  <div class="gf-header-row2">
    ${headerSearch(searchQuery, HEADER_SEARCH_INPUT_IDS.narrow)}${login === '' ? '' : `\n    ${login}`}
  </div>
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
  { path: TAKEDOWN_PATH, label: '削除依頼' },
  { path: ACCOUNT_PATH, label: '登録情報' },
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
 * - **親へのリンクは「文章の外のリンク」の見せ方にする**（仕様 2.5.5 の表がパンくずを名指ししている。#469）
 *   ——下線を常には出さず、ホバーと焦点で出す。**見た目は app.css の `@section breadcrumb` が `a` に当てる**
 *   （HTML にクラスを足さない。パンくずの綴りを見ている画面ごとの検査を動かさないため）
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
  /**
   * ヘッダの検索窓に戻す語（#378）。**公開一覧が検索を描くときだけ渡す。** エスケープはこの関数が行う。
   */
  readonly searchQuery?: string;
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
<title>${escapeHtml(options.title)}</title>${extraHead}${siteHeader(options.viewer, options.searchQuery)}${siteBreadcrumb(
    options.viewer,
    options.title,
  )}`;
}
