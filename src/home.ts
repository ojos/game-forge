/**
 * 公開トップ（`/`）。**本番で最初に見られる 1 枚**であり、招待制クローズドβの
 * 入口を示すことだけを担う（1 章 / 確定7 / 8.1）。
 *
 * ## なぜ独立したモジュールにするのか
 *
 * `/` は M0.5-3 の時点で開発用の索引ページだった（`src/app.ts` の `devRoutes`）。
 * 本番の配備（#89）でそれが公開トップになる事故を、**同じ配列の中で出し分ける**形で
 * 塞ぐと、`/` の登録が 2 つになって `findDuplicateRoutes` の検出対象になる。
 * 公開トップを独立させ、開発用の索引を `/__dev/` へ寄せると、
 * **「`/` は常に公開トップ、`/__dev/*` は開発時のみ」**という 1 つの規則で済む。
 *
 * ## D1 を読む（#329 / M9-3。2.3.3 が覆した決定）
 *
 * **かつてここには「D1 を読まない」と書いてあった。** 根拠は 3.6 の無料枠で、
 * 「1 アクセスごとに D1 の読み取りが増える形は無料枠の圧迫に直結する」としていた。
 * **仕様 2.3.3 がこの決定を覆し、#329 がコードを追いつかせた**（あの記述は「いまの
 * コードが何をしているか」の説明として正しかったので、**読むようになるまで書き換えない**
 * と 2.3.3 が定めていた）。
 *
 * 覆した根拠は 3 つである。
 *
 * 1. **3.6 が名指しで警告しているのは書き込み側である**（「プレイ回数やスタンプ評価を
 *    都度書くと即座に枯れる」）。同じ節が**「タイムラインの読み取りは Cache API を前段に
 *    置く」**と書いており、**一覧の読み取りは 3.6 自身が前提として認めている**
 * 2. **実数で 3〜4 桁の余裕がある。** 1 回が読むのは 32 行＋索引で、無料枠 500 万行/日 は
 *    **1 日 7〜15 万ページビュー相当**である（2.3.3 の表）
 * 3. **解禁の本体は 3 条件のほうである**——件数の固定・索引・Cache API の前段。
 *    3 つとも `src/home-feed.ts` にある
 *
 * **ハブ型のトップは作品の行を読まないと 1 枚も描けない**（2.3.1）。読まない形を保つ
 * ことは、**発見の面を 1 枚も持たない**ことと同じだった。
 *
 * ### それでも待機リストの件数はここへ出さない
 *
 * **これは「D1 を読まない」から導いていた結論ではない。** 件数は**登録するかどうかの
 * 判断に効く数字**であり、効く場所は `/signup` である（`src/signup.ts`）。読めるように
 * なったからといって、判断に効かない場所へ数字を増やさない。
 *
 * ## JavaScript もスタイルシートも要求しない
 *
 * MVP の画面は SSR の素の HTML に留める（9.3 / #89 の scope.out）。Next.js / React へ
 * 寄せる判断は M2-1 以降が持ち、ここで先取りすると捨てる量が増える。
 */
import type { SiteViewer } from './html.js';
import { resolveSiteViewer, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { LOGIN_PATH } from './auth/google.js';
import { GENERATE_PAGE_PATH, HOME_PATH, INVITES_PATH, SIGNUP_PATH } from './paths.js';
// **一覧の綴りをここへ書き写さない。** 正本は `src/my-works.ts` で、そこは
// `WORK_PAGE_PREFIX` から導いている。逆向きの import にならない（あちらは `/` への
// 導線をリテラルで持つ）ので、`src/paths.ts` へ逃がす必要も無い。
import { MY_WORKS_PATH } from './my-works.js';
// 公開一覧の綴りも正本から借りる（#328。同じ理由で書き写さない）。
import { PUBLIC_WORKS_PATH } from './works-list.js';
// 引く側（#329 / M9-3）。**トップの問い合わせをここへ書かない**（あちらの冒頭が理由）。
import type { HomeFeedData, HomeSection } from './home-feed.js';
import { homeSections, loadHomeFeed } from './home-feed.js';
// **カードは共通部品を借りる**（仕様 2.3.6。一覧・トップ・作者ページが同じ 1 枚を使う。
// 項目を足したり減らしたりするのは `src/work-card.ts` の仕事で、ここではない）。
import { renderWorkCards } from './work-card.js';

/**
 * 公開トップのパス。
 *
 * **正本は `src/paths.ts` である**（#266 でヘッダを足したときに移した。理由はあちら）。
 * ここから再輸出するのは、既に `src/home.ts` から読んでいる箇所を動かさないためで、
 * 値を二重に持っているわけではない。
 */
export { HOME_PATH };

/**
 * 節 1 つを組み立てる。
 *
 * **見出しと節を `<section>` で結ぶ。** カードの `<ul>` が 4 つ縦に並ぶので、
 * 読み上げで「どの見出しの下のリストか」が分かる必要がある（`aria-labelledby`）。
 * `id` は節の識別子から作るので、節を足しても綴りを考え直さずに済む。
 *
 * **「もっと見る」の行き先は `worksListPath` が持つ**（`src/home-feed.ts` が組み立てて
 * 渡す）。ここは文言だけを決める。**見える文字は「もっと見る」に留め、軸の名前は
 * `aria-label` に入れる**——同じ文字のリンクが 3 本並ぶので、リンクだけを抜き出して
 * 読む（読み上げのリンク一覧）ときに区別が付かなくなる。見えている側は直上の見出しで
 * 区別が付いており、そこへ軸名を重ねると 1 行が長くなって 390px で折れる
 * （`scripts/check-page-width.sh` が見ている回帰の側）。
 *
 * @param section 節
 * @returns HTML
 */
function renderSection(section: HomeSection): string {
  const headingId = `gf-home-${section.key}`;
  const more =
    section.moreHref === null
      ? ''
      : `\n<p class="gf-home-more"><a href="${section.moreHref}"` +
        ` aria-label="${section.title}をもっと見る">もっと見る</a></p>`;
  return `
<section class="gf-home-section" aria-labelledby="${headingId}">
<h2 id="${headingId}">${section.title}</h2>
${renderWorkCards(section.works)}${more}
</section>`;
}

/**
 * 公開トップの HTML。
 *
 * **まだ出来ていないものを出来ているように書かない。** #89 の時点では生成機能
 * （`/api/generate`）が骨組みだけで、#83 / #16 が未完了だったため、ここは
 * 「生成機能はまだ公開していません」と書いていた。**#128 でその記述を落とした。**
 * 3.3 の全段が実装され本番で開通しており、`/generate`（`src/generate-page.ts`）から
 * 実際に生成できる。**書き換えたのは事実が変わったからで、方針は変えていない**
 * （出来ていないもの——試遊・公開・フォークの画面——は、いまも書かない）。
 *
 * **待ち時間をここに書く。** 押した先で何分も待つことを、押す前に知らせておく（1.2.27）。
 *
 * **数字の根拠は生成画面と同じである。** 本番で 1 回通した実測はリクエスト全体で
 * **90.9 秒**（2026-08-28。うちビルドが 21.6 秒で、残りは生成側）。#128 の時点で
 * ここが書いていた「20〜30 秒」は**ビルド単体の実測**（3.8）であり、生成側を含む
 * 待ち時間ではなかった。**実測は n=1 なので、幅を持たせた言い方に留める。**
 *
 * **文言の正本は `src/generate-page.ts` の `TYPICAL_WAIT_TEXT` で、ここは書き写しである。**
 * import しないのは、あちらが `HOME_PATH` をここから取っており、逆向きの import を
 * 足すと循環参照になるためである（`src/paths.ts` の冒頭が避けているものと同じ形）。
 * **書き写した以上、一致は機械照合で担保する**（`test/generate-page.test.ts` の公開
 * トップの検査。shared-ai-rules 12 章）。同じ待ち時間の説明が利用者から見て 2 つある
 * 状態を、呼びかけではなく検査で塞ぐ。
 *
 * **「あなたの作品」（#152）への導線も同じ理由でここに置く。** ログインの着地点は `/` で
 * あり、**URL を控え損ねた利用者が最初に戻ってくる場所もここ**である。導線が無ければ、
 * 一覧は「その URL を知っている人だけが使える一覧」になり、#152 が解こうとしている問題を
 * そのまま繰り返す。
 *
 * 招待の発行（#91）への導線をここに置くのは、**ログイン後の着地点が `/` だから**である
 * （`src/auth/google.ts` のコールバックは `/` へ戻す）。導線が無いと、実装した経路へ
 * ブラウザから辿り着けない。未ログインにも見えるリンクになるが、押した先で
 * ログインへ送られるだけで、**そのリンクを出すために D1 は読まない。**
 *
 * **招待枠の本数をここに書かない。** 書けば `INVITE_QUOTA`（`src/invite-issuance.ts`）の
 * 写しになり、変えたときに片方だけが古くなる。本数は発行の画面が出す。
 *
 * **作品の節を、案内の文より先に置く。** M8-2 は拡散の着地点 3 枚について「作品が
 * 画面上で最も目立つ位置と大きさ」を求めており、トップはその 1 枚である。
 * 案内（いまの状態 / はじめる / 参加している方へ）の文言は #128 から動かしていない
 * ——**位置を変えただけで、書いてあることは変えていない。**
 *
 * @param sections 並べる節（空の節は既に落としてある。`src/home-feed.ts`）
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function renderHomePage(sections: readonly HomeSection[], viewer: SiteViewer): string {
  return `${siteHead({
    title: 'Game Forge',
    viewer,
    extraHead:
      '\n<meta name="description" content="プロンプト1行で生まれるブラウザ2Dゲームと、フォーク型 UGC コミュニティ。招待制クローズドβ。">',
  })}
<h1>Game Forge</h1>
<p>プロンプト 1 行から、ブラウザで遊べる 2D ゲームが生まれます。
   気に入った作品は<strong>改造（フォーク）</strong>して、自分の 1 本として公開できます。</p>
${sections.map(renderSection).join('\n')}

<h2>いまの状態</h2>
<p><strong>招待制のクローズドβを準備しています。</strong>
   遊ぶことと URL の共有に招待は要りませんが、<strong>生成は招待コードをお持ちの方に限ります。</strong></p>
<p>登録がお済みの方は<a href="${GENERATE_PAGE_PATH}">ゲームを生成できます</a>。
   <strong>生成には通常 1〜2 分かかります。</strong>
   試遊と公開の画面はまだ準備中で、生成した作品は下書きとして保存されます。</p>

<h2>はじめる</h2>
<ul>
  <li><a href="${PUBLIC_WORKS_PATH}">公開されている作品をさがす</a>（登録は要りません）</li>
  <li><a class="gf-cta" href="${GENERATE_PAGE_PATH}">ゲームを生成する</a>（招待コードでの登録が必要です）</li>
  <li><a href="${SIGNUP_PATH}">招待コードで登録する</a></li>
  <li><a href="${SIGNUP_PATH}">招待コードをお持ちでない方（待機リストに登録する）</a></li>
  <li><a href="${LOGIN_PATH}">すでにアカウントをお持ちの方（Google でログイン）</a></li>
</ul>

<h2>参加している方へ</h2>
<p><a href="${MY_WORKS_PATH}">あなたの作品</a>（生成中のものも含みます。ログインが必要です）</p>
<p><a href="${INVITES_PATH}">招待コードを発行する</a>（ログインが必要です）</p>
${siteFooter()}
`;
}

/** 節が 1 つも無いトップ。 */
const EMPTY_FEED: HomeFeedData = { official: [], recent: [], forked: [], liked: [] };

/**
 * 4 節を引く。**引けなくても、トップは出す。**
 *
 * ## なぜここで握りつぶすのか
 *
 * **トップは本番で最初に見られる 1 枚であり、URL 拡散の着地点でもある**（このファイルの
 * 冒頭）。ここが 500 を返すと、**サービスの説明も登録の導線も、まるごと消える。**
 * 案内と導線は D1 を 1 行も要らないのに、作品の節を引けなかったことに引きずられて
 * 一緒に落ちる形になる。
 *
 * **`src/list-cache.ts` が握りつぶしている理由と同じ形である**——「この層が無くても
 * 一覧は正しく出る」。ここでは「作品の節が無くてもトップは意味を持つ」であり、
 * **issue #329 が「作品が 0 本のときに壊れない」と定めた状態そのもの**に落ちる
 * （節ごと出ない）。
 *
 * ## 4.3 の「判定できなかったときは止まる側へ倒す」とは性質が違う
 *
 * あちらが握りつぶしを禁じているのは、**握りつぶすと上限や可視性が静かに開く**
 * 場所である（日次枠・審査・公開状態）。ここで失敗しても**開くものが 1 つも無い**
 * ——`draft` も審査中の作品も、引けなければ並ばないだけである。
 *
 * **黙らせない。** 失敗はログへ残す（本番で「節が出ない」を見たときに、0 本なのか
 * 引けていないのかを切り分ける手がかりが要る）。
 *
 * @param env バインディングと環境変数
 * @returns 4 節ぶんの作品。引けなければ空
 */
async function homeFeed(env: Env): Promise<HomeFeedData> {
  try {
    return await loadHomeFeed(env);
  } catch (error) {
    console.error('[home] 作品の節を引けませんでした', error);
    return EMPTY_FEED;
  }
}

/**
 * 公開トップを表示する。
 *
 * **引くのは `src/home-feed.ts` で、ここは組み立てるだけである。** 読み取りの上限・索引・
 * Cache API の前段（2.3.3 の 3 条件）はあちらが持つ。
 *
 * **キャッシュが無くても、D1 が空でも、D1 が落ちていても 200 を返す**（{@link homeFeed}）。
 *
 * @param request 受信したリクエスト（**本文は出し分けない。**下記）
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showHome(request: Request, env: Env): Promise<Response> {
  // **本文はログイン状態で出し分けない。** 全員に同じものが出るカタログである（2.3.3）。
  // **出し分かれるのはヘッダだけ**で、判定と描画は `src/html.ts` が持つ（2.3.7 / #331）。
  // ここがするのは**そのリクエストの状態を外枠へ渡すこと**だけである。
  //
  // **キャッシュに載るのはこの下で引く行だけ**である（`src/list-cache.ts`）——
  // ヘッダが出し分かる以上、HTML を共有キャッシュへ載せてはいけない（2.3.3 の条件 3）。
  const viewer = await resolveSiteViewer(request, env);
  return html(renderHomePage(homeSections(await homeFeed(env)), viewer));
}

/**
 * 公開トップの経路。
 *
 * `src/app.ts` の経路表へ連結する。ここに `/__dev/*` を混ぜないこと（本番で遮断する
 * 単位が `devRoutes` なので、混ざると遮断の対象から漏れる）。
 */
export const homeRoutes: readonly Route[] = [
  { method: 'GET', path: HOME_PATH, handler: showHome },
];
