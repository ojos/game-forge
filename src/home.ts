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
import { HOME_PATH } from './paths.js';
// 引く側（#329 / M9-3）。**トップの問い合わせをここへ書かない**（あちらの冒頭が理由）。
import type { HomeFeedData, HomeSection } from './home-feed.js';
import { homeSections, loadHomeFeed } from './home-feed.js';
// **カードは共通部品を借りる**（仕様 2.3.6。一覧・トップ・作者ページ・いいねした作品が同じ 1 枚を使う。
// 項目を足したり減らしたりするのは `src/work-card.ts` の仕事で、ここではない）。
import { renderWorkCards } from './work-card.js';
import { sandboxOriginOf } from './avatar-paths.js';
// お知らせの節（#375 / M12-7）。**記事は静的な定義で、D1 を 1 行も読まない**（`src/news.ts`）。
import type { NewsArticle } from './news-articles.js';
import { NEWS_ARTICLES } from './news-articles.js';
import { renderHomeNewsSection } from './news.js';

/**
 * 公開トップのパス。
 *
 * **正本は `src/paths.ts` である**（#266 でヘッダを足したときに移した。理由はあちら）。
 * ここから再輸出するのは、既に `src/home.ts` から読んでいる箇所を動かさないためで、
 * 値を二重に持っているわけではない。
 */
export { HOME_PATH };

/**
 * 「いまの状態」の告知（仕様 2.3.3 の #435 注記 / #471）。**トップのヘッダの直下に 1 つだけ置く。**
 *
 * ## 1 か所の定数に置く
 *
 * **クローズドβが終わったら外す前提の文面である**（2.3.3 の注記「外すことを前提に、告知は 1 か所の静的な定義に置く」）。
 * 外すときに消すのはこの定数と、{@link renderHomePage} の 1 行だけで済む。
 *
 * - **冒頭の半文が、トップでサイトの正体を示すただ 1 つの文である**——ロゴの「Game Forge」だけでは何をするサイトか
 *   伝わらない（#435 の intake で利用者が選んだ）。サイト説明の全文と、生成の待ち時間・下書きの説明は FAQ の先頭の
 *   2 項目へ移した（`src/faq.ts`。2.3.3 の注記の表「外す文面の行き先」）
 * - **ログインの状態によらず出す。** クローズドβのあいだ、参加者にとってもサービスの状態の告知として正しい
 * - **D1 を読まない。** 作品の節を引けなくても告知は出る（{@link homeFeed}）
 *
 * **利用者の入力を含まない固定文である**（HTML としてそのまま本文へ入れる）。
 */
export const CLOSED_BETA_NOTICE =
  'プロンプト 1 行から 2D ゲームを作れるサービスです。現在は<strong>招待制のクローズドβ</strong>で、' +
  '遊ぶことと URL の共有に招待は要りませんが、<strong>生成は招待コードをお持ちの方に限ります。</strong>';

/**
 * 節 1 つを組み立てる。
 *
 * **見出しと節を `<section>` で結ぶ。** カードの `<ul>` が 4 つ縦に並ぶので、
 * 読み上げで「どの見出しの下のリストか」が分かる必要がある（`aria-labelledby`）。
 * `id` は節の識別子から作るので、節を足しても綴りを考え直さずに済む。
 *
 * ## 見出しの行: 左に見出し、右に「もっと見る」（仕様 2.5.3 / #471）
 *
 * **「もっと見る」は小さい副のボタンにする**（仕様 2.5.5 の表が「もっと見る」を名指しする。移動なので `<a>`）。
 * **HTML の順は 見出し → ボタン で、見た目の順と Tab の順も同じ**である（`order` で入れ替えない）。
 * 右端に寄せるのは `.gf-home-head` の `justify-content` で、並びは変えない。
 *
 * **「もっと見る」の行き先は `worksListPath` が持つ**（`src/home-feed.ts` が組み立てて
 * 渡す）。ここは文言だけを決める。**見える文字は「もっと見る」に留め、軸の名前は
 * `aria-label` に入れる**——同じ文字のリンクが 3 本並ぶので、リンクだけを抜き出して
 * 読む（読み上げのリンク一覧）ときに区別が付かなくなる。見えている側は同じ行の見出しで
 * 区別が付いており、そこへ軸名を重ねると 1 行が長くなって 390px で折れる
 * （`scripts/check-page-width.sh` が見ている回帰の側）。
 *
 * @param section 節
 * @param avatarOrigin アイコンを配るサンドボックス用ホストのオリジン（#380）
 * @returns HTML
 */
function renderSection(section: HomeSection, avatarOrigin: string | null): string {
  const headingId = `gf-home-${section.key}`;
  const more =
    section.moreHref === null
      ? ''
      : `\n<a class="gf-button gf-button-secondary gf-button-sm gf-home-more" href="${section.moreHref}"` +
        ` aria-label="${section.title}をもっと見る">もっと見る</a>`;
  return `
<section class="gf-home-section" aria-labelledby="${headingId}">
<div class="gf-home-head">
<h2 id="${headingId}">${section.title}</h2>${more}
</div>
${renderWorkCards(section.works, avatarOrigin)}
</section>`;
}

/**
 * 公開トップの HTML。
 *
 * ## 並び（仕様 2.3.3 の #435 注記）
 *
 * **ヘッダ → 「いまの状態」の告知 → 作品の 4 節 → お知らせの節 → フッタ** である。
 *
 * - **告知はブロック（`.gf-block`）1 つ**で、器の幅いっぱいに面を置く（仕様 2.5.3。短い文を並べる画面は
 *   ブロックの幅いっぱい）。文面は {@link CLOSED_BETA_NOTICE}
 * - **作品の節を告知のすぐ後に置く。** M8-2 は拡散の着地点 3 枚について「作品が画面上で最も目立つ位置と
 *   大きさ」を求めており、トップはその 1 枚である。告知は 1 ブロックに留め、作品を画面の下へ押し出さない
 * - **お知らせの節は作品の節の後ろ**（#375）。記事が 0 本なら節ごと出ない（`src/news.ts` の `renderHomeNewsSection`）
 *
 * ## 外したもの（#471。行き先は仕様 2.3.3 の #435 注記の表）
 *
 * **冒頭のサイト説明・「いまの状態」の生成の説明・「はじめる」・「参加している方へ」を外した。** 無くなる情報は作っていない。
 *
 * - サイト説明の全文と、生成の待ち時間・下書き・公開の説明 → **FAQ の先頭の 2 項目**（`src/faq.ts`）。
 *   **待ち時間の数字の書き写しもここから消えた**——#128 以来 `TYPICAL_WAIT_TEXT`（`src/generate-page.ts`）の写しを
 *   持ち、循環参照を避けるために import できなかったが、FAQ は正本から差し込む
 * - 「はじめる」の作品をさがす・ゲームを生成する → **ヘッダの「作品をさがす」「つくる」**（全画面の外枠）
 * - 「はじめる」の登録・待機リスト・ログイン → **ヘッダの「ログイン」**（行き先を `/signup` へ集めるのは M13-8 / #472）
 * - 「参加している方へ」のあなたの作品・招待コードの発行 → **アカウントのメニュー**（#469 で足した）
 *
 * @param sections 並べる節（空の節は既に落としてある。`src/home-feed.ts`）
 * @param news お知らせの記事（新しい順。静的な定義なので D1 は読まない）
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @param avatarOrigin カードのアイコンを配るサンドボックス用ホストのオリジン（#380）
 * @returns HTML
 */
function renderHomePage(
  sections: readonly HomeSection[],
  news: readonly NewsArticle[],
  viewer: SiteViewer,
  avatarOrigin: string | null,
): string {
  return `${siteHead({
    title: 'Game Forge',
    viewer,
    extraHead:
      '\n<meta name="description" content="プロンプト1行で生まれるブラウザ2Dゲームと、フォーク型 UGC コミュニティ。招待制クローズドβ。">',
  })}
<div class="gf-block gf-home-notice">
<p>${CLOSED_BETA_NOTICE}</p>
</div>
${sections.map((section) => renderSection(section, avatarOrigin)).join('\n')}
${renderHomeNewsSection(news)}
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
 * 冒頭）。ここが 500 を返すと、**「いまの状態」の告知もお知らせも、まるごと消える。**
 * 告知とお知らせは D1 を 1 行も要らないのに、作品の節を引けなかったことに引きずられて
 * 一緒に落ちる形になる（#471 で案内を告知 1 つに絞った。仕様 2.3.3 の #435 注記「案内と登録の導線」は「告知」と読み替える）。
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
  return html(
    renderHomePage(
      homeSections(await homeFeed(env)),
      NEWS_ARTICLES,
      viewer,
      // カードの作者のアイコン（#380）。**本文はログイン状態で変わらない**（オリジンは宣言と要求だけで決まる）。
      sandboxOriginOf(request, env.SANDBOX_HOST),
    ),
  );
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
