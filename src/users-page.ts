/**
 * 作者ページ（`/users/<user_id>`）。**作品から作者へ辿れるようにする 1 枚である**
 * （仕様 2.3.1 / 2.3.6 / 5.8 / #330 / M9-4）。
 *
 * ## なぜ要るのか
 *
 * 作品ページは作者名を出しているが（5.6 の原作者クレジット）、**そこから「この人の
 * 他の作品」へ行く道が無かった。** 2.3 のループは「発見」から始まり、作者は発見の
 * 入口の 1 つである。
 *
 * ## 出すのは 3 つだけである
 *
 * | 項目 | 出典 |
 * |---|---|
 * | 表示名 | `users.display_name`（5.9 で利用者が決められる値になった） |
 * | 被いいね数 | **その人の公開作品の `like_count` の合計**（5.8。D1 で導く） |
 * | 公開作品 | 共通の作品カード（`src/work-card.ts`。仕様 2.3.6） |
 *
 * ## 出してはいけないものが 2 つある
 *
 * **`users` は公開を前提にしていない表である**（0001）。**引く列を明示して、行ごと
 * 渡さない。**
 *
 * - **`users.email`。** 認証に使う値で、画面に出す理由が 1 つも無い（本人にだけ出す
 *   場所は `/account` である。5.9）
 * - **`users.invited_by`。** 8.1 が「コミュニティの初期構造をそのまま資産にする」として
 *   持っている列で、**公開すると招待の連鎖が外から辿れる**（2.3.6 の「出さないもの」）
 *
 * **`x_handle` も出さない。** 5.6 が「未検証の自称値であるため、MVP ではリンク化せず
 * 表示のみ」と定めているが、**この画面は表示もしない**——出す先は作品ページであり
 * （5.6 は作品ページと OGP について書いている）、**issue #330 の scope.out が
 * 「`x_handle` のリンク化」を外している。** 表示だけを足すなら別の issue で決める。
 *
 * **担保は「選ばない」ことである。** 選んでいない列は、画面の側で書き間違えても
 * 漏れようがない（#152 の絞り込みと同じ規律）。
 *
 * ## 絞り込みは引く時点で行う
 *
 * `draft` と、8.4 の審査で新規露出を止めた作品を**SQL の where で落とす**（5.4 の
 * 「公開操作で初めて URL が有効になる」の抜け道を作らない）。**画面側で `filter`
 * しない**——書き忘れても「それらしく」動くためである（#152）。
 *
 * **被いいね数も同じ条件で合計する。** 合計だけが `draft` を数えると、**取り下げた
 * 作品や下書きのいいねが数字に残り、作品を数え直しても合わない**（5.8 の受け入れが
 * 名指ししている穴）。条件は 1 つの断片（`src/reports.ts` の `reviewVisibleSql`）から
 * 借りる。
 *
 * ## BAN 済みの利用者をどう扱うか——**404 にしない**（issue #330 が決める / 7.3 / 8.4）
 *
 * `users.banned_at` は行を消さずに BAN を表す（0001 / 7.3）。**この画面は BAN を見ない。**
 * 表示名も公開作品も被いいね数も、BAN の前と同じに出す。根拠は 4 つある。
 *
 * 1. **BAN が止めるのは生成と招待である**（7.3。「生成の敷居値は招待コード必須であり…
 *    BAN 時は招待した側の招待枠も止める」）。**露出を止める手段ではない。** 公開済みの
 *    作品の露出を止めるのは 8.4 が持ち、**単位は利用者ではなく作品**である
 *    （`games.status='removed'` と `review_state`）。どちらも既にこの画面に効いている
 * 2. **404 にすると、押せるが 404 へ行くリンクを作ることになる。** BAN された作者の
 *    作品は一覧・トップ・作品ページに今までどおり並び（`src/games.ts` の
 *    `listPublishedGames` が同じ判断をしている）、**そのカードの作者名がこの画面を
 *    指す。** 4.4 と 2.2 が「押せるが何も起きないもの」を出さないと定めている
 * 3. **404 にしても何も隠せない。** 表示名は作品カードと作品ページに出ており、公開作品は
 *    一覧から辿れる。**この画面を閉じても、同じ 3 つの値が別の 3 枚から読める**
 *    ——隠せていないものを隠したことにしない
 * 4. **1 つの操作に 2 つの意味を持たせない。** BAN は運営が D1 を 1 本 UPDATE する操作で
 *    ある（7.3 / `docs/usage-report.md`）。そこへ「作者ページも閉じる」を足すと、
 *    **費用 DoS を止めるための操作が、露出の判断まで兼ねる**ことになる
 *
 * **したがって、BAN した利用者の作品を露出から外したい場合の手順は 8.4 である**
 * ——作品ごとに `games.status = 'removed'` へ落とす（あるいは審査で止める）。
 * **この画面は、その判断の結果をそのまま映す。**
 *
 * **いいねの側の扱いと矛盾しない。** 5.8 は「**BAN した利用者のいいねは数えない**」と
 * 定めるが、あれは**押した側**の話である（同期が `users.banned_at` を読み、BAN された
 * 人が押した分を `games.like_count` から外す）。ここが出すのは**押された側**の合計で、
 * 材料は既に BAN を反映済みの `games.like_count` である——**この画面が BAN を見ないこと
 * が、二重に差し引く実装を防いでいる。**
 *
 * ## 運営の印（`.gf-operator`）は出さない（#334 / `docs/operator-account.md`）
 *
 * **見出しの作者名にも、カードの作者名にも出さない。** 根拠は 3 つある。
 *
 * 1. **`docs/operator-account.md` が既にそう書いている。** 1 章の表は「一覧・トップ・
 *    作者ページのカード」を「出ない（#334 の範囲外。出したくなったら別 issue）」とし、
 *    5 章は「**見分けられるのは作品ページだけです**」と書いている。**出すとこの 2 か所が
 *    同時に誤りになり、#330 の範囲外の文書を書き換えることになる**
 * 2. **印が要るのは「この作品を信じるか」を決める場所である。** それは拡散の着地点
 *    （作品ページ）で、**この画面からはカード 1 枚でそこへ着く。** 作者ページは
 *    「誰の作品か」を既に知っている人が開く画面である
 * 3. **#334 が決めた範囲を、別の issue が黙って広げない。** 出したくなったら別 issue で
 *    決め、`docs/operator-account.md` の表と同時に変える（あの文書自身がそう書いている）
 *
 * **なりすましは防げていないが、これは #330 で増えた穴ではない。** 表示名は誰でも
 * 「運営」にできる（5.9）ので、この画面の見出しに「運営」と出ている人が運営とは限らない
 * ——**同じことは既に作品カードで起きている**（`docs/operator-account.md` 5 章の
 * 「残る限界」）。
 *
 * ## 読み取りの形（仕様 2.3.3 の条件 1〜3）
 *
 * 1. **1 頁の件数を固定する。** 一覧と同じ {@link WORKS_PER_PAGE} 件・上限
 *    {@link MAX_PAGE} 頁（値と根拠を 2 か所に持たないため `src/works-list.ts` から借りる）。
 *    **被いいね数だけは、その作者の公開作品の数に比例する**——仕様 5.8 が明示的に選んだ
 *    形である（利用者の側に非正規化列を足さない）。**母数には比例しない**
 * 2. **索引を張る。** `migrations/0024_games_author_published_idx.sql`（部分索引。審査の
 *    可視条件を含む）
 * 3. **Cache API を前段に置く。** 載せるのは HTML ではなく引いた行だけである
 *    （`src/list-cache.ts`）
 *
 * **表示名はキャッシュに載せない。** 引くのは主キー 1 行で、いちばん安い読み取りである
 * 一方、**5.9 の表示名の変更が 60 秒遅れて見えるのは、変えた本人にとって「変わって
 * いない」と読める。** 存在しない利用者の判定（404）も同じ 1 行で済む。
 */
import type { PublicWork } from './games.js';
import { PUBLISHED_STATUS } from './games.js';
import { escapeHtml, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { cachedRows, listCacheKey } from './list-cache.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { AUTHOR_PAGE_PREFIX, authorPagePath } from './users-page-paths.js';
import { renderWorkCards } from './work-card.js';
import { MAX_PAGE, PUBLIC_WORKS_PATH, WORKS_PER_PAGE, toPageNumber } from './works-list.js';

export { AUTHOR_PAGE_PREFIX, authorPagePath };

/**
 * 経路として受け付ける `user_id` の最大長。
 *
 * **`users.id` は `crypto.randomUUID()` の出力（36 文字）である**（`src/auth/google.ts`）。
 * それより長い値を受け付ける必要は無いが、**UUID の形で決め打ちもしない**——テストと
 * 運用で接頭辞付きの id を作っている経路があり、**形の検査を厳しくすると「実在する
 * 利用者の作者ページが 404 になる」**という壊れ方をする（作品 id とは事情が違う。
 * あちらは生成の経路だけが作るので `GAME_ID_PATTERN` で締められる）。
 *
 * **64 文字。** 縛るのは長さだけで、目的は 2 つある——`cachedRows` の鍵が利用者の
 * 入力で好きなだけ伸びないこと、`/users/` の下に長い綴りを並べた要求が D1 まで
 * 届かないこと（**引く前に落とすほうが安い**。`src/work-page.ts` と同じ方針）。
 */
export const MAX_USER_ID_LENGTH = 64;

/**
 * その人の公開作品を 1 頁ぶん引く SQL（仕様 2.3.6 / 2.3.3）。
 *
 * **関数として輸出しているのは、実行計画を検査できるようにするためである**
 * （`src/games.ts` の `publishedGamesSql` と同じ理由。検査が SQL を書き写すと、片方だけが
 * 古くなる。`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * # `users` を結合しない（PR #350 の Copilot code review の指摘）
 *
 * `publishedGamesSql` は作者名のために `users` を結合するが、**ここはしない。** 並ぶのは
 * 1 人の作者の作品だけなので、**名前は既に分かっている**（`showAuthorPage` が主キーで
 * 1 行引いている）。
 *
 * **結合すると害がある。** 引いた行は Cache API に 60 秒載るので、**表示名を変えた直後は
 * 見出しだけが新しく、カードは古い名前のまま**になる（同じ画面が 1 つの名前について
 * 2 つのことを言う）。カードの名前は、キャッシュを通らない側の値で**毎回差し替える**
 * ——{@link AuthorWorksData} と `showAuthorPage` を参照。
 *
 * **キャッシュを捨てる形は採らない。** `src/list-cache.ts` はトップ・一覧・作者ページが
 * 共有する層で、作者ページ 1 枚のために読み取りを増やす取引は合わない（3.6 /
 * `src/work-card.ts` の `cardLikeCount` が同じ対案を退けている）。
 *
 * **結合を落とすと、古い名前が保存物に入る余地がそもそも無い**——差し替えの前に、
 * 間違えようのない形にしてある。
 *
 * **並びは公開日時の新しい順である。** `created_at` ではない理由は
 * `migrations/0024_games_author_published_idx.sql` にある（カードが出すのは
 * `published_at` で、並びが別の軸だと**画面に見えている日時の順に並んでいない一覧**に
 * なる）。末尾の `id desc` は同値の行の順序を決めるためで、索引の列順もこれに合わせてある。
 *
 * **索引の名前をここへ書かない**（`indexed by` で名指ししない）。名指しすると、索引を
 * 張り替えた日に**作者ページが 500 になる**。選ばれることは実行計画で確かめてあり、
 * 選ばれなくなったら検査が赤くなる（`src/home-feed.ts` と同じ判断）。
 *
 * @returns 束縛パラメータが 4 つ（author_id / status / limit / offset）の SELECT 文
 */
export function authorWorksSql(): string {
  return `select g.id, g.title, g.published_at, g.fork_count, g.like_count, g.parent_id,
            g.ogp_state, g.author_id
       from games g
      where g.author_id = ? and g.status = ? and ${reviewVisibleSql('g')}
      order by g.published_at desc, g.id desc
      limit ? offset ?`;
}

/**
 * 被いいね数を引く SQL（仕様 5.8）。
 *
 * **D1 で導く。** 利用者の側に非正規化列を足さない——5.8 の決定であり、理由も書かれて
 * いる（「作者 1 人の作品数に比例する読み取りで、`(author_id, …)` の索引が効く」）。
 *
 * **`authorWorksSql` と同じ条件で絞る。** `draft` と、8.4 の審査で新規露出を止めた作品を
 * 合計へ入れない（issue #330 / #335 の受け入れ条件）。**条件は `reviewVisibleSql` から
 * 借りており、書き写していない**ので、露出の条件が変わったときに合計だけが古くなる
 * 余地が無い。
 *
 * **`coalesce` で 0 に倒す。** 1 行も無ければ `sum` は NULL を返し、画面が
 * 「いいね null」を描く余地ができる（`src/games.ts` の `like_count` が
 * `NOT NULL DEFAULT 0` である理由と同じ——**NULL がどこへ行くかを読み手が知って
 * いる必要を作らない**）。
 *
 * **`games.like_count` は DO から写した数である**（5.8）。**最大 5 分遅れる**し、
 * **BAN された利用者が押した分は既に差し引かれている**（同期が `users.banned_at` を
 * 読む）。ここで BAN を見ないのは、二重に差し引かないためでもある。
 *
 * @returns 束縛パラメータが 2 つ（author_id / status）の SELECT 文
 */
export function likesReceivedSql(): string {
  return `select coalesce(sum(g.like_count), 0) as likes
       from games g
      where g.author_id = ? and g.status = ? and ${reviewVisibleSql('g')}`;
}

/** Cache API へ載せる、作者ページ 1 頁ぶんのデータ。 */
export interface AuthorWorksData {
  /**
   * 並べる作品（{@link WORKS_PER_PAGE} 件より 1 件多く入りうる）。
   *
   * **`authorName` は常に null である。** 名前はキャッシュに載せず、`showAuthorPage` が
   * 毎回引いている `users` の行から差し替える（{@link authorWorksSql} の「`users` を
   * 結合しない」）。**保存物に名前が入らないので、60 秒古い名前がカードに出る経路が
   * 無い。**
   */
  readonly works: readonly PublicWork[];
  /** 被いいね数（その人の公開作品の `like_count` の合計）。 */
  readonly likesReceived: number;
}

/**
 * 作者ページのキャッシュの鍵。
 *
 * **一覧（`works`）やトップ（`home`）と別の名前にする。** 同じ鍵に載せると件数も
 * 絞り方も違う行が混ざる（`src/home-feed.ts` の `HOME_CACHE_KEY` が同じ理由で名前を
 * 分けている）。
 *
 * **鍵に頁を入れる。** 被いいね数は頁に依らない値だが、**頁ごとの鍵へ同居させる。**
 * 別の鍵に分けると、1 枚の画面が 2 つの時刻のスナップショットで組まれ、**「カードを
 * 数えても合計と合わない」を説明できる時間が 2 倍になる**（`src/home-feed.ts` が
 * 4 節を 1 本の鍵に載せたのと同じ判断）。
 *
 * @param userId 利用者 id
 * @param page 頁番号
 * @returns 鍵に使う URL
 */
export function authorCacheKey(userId: string, page: number): string {
  return listCacheKey('author', { id: userId, page });
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface AuthorPageView {
  /** 表示名（`users.display_name`）。**UGC 由来なので画面側で escape する。** */
  readonly displayName: string;
  /** 利用者 id（頁送りのリンクに入る）。 */
  readonly userId: string;
  /** 並べる作品（既に {@link WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly PublicWork[];
  /** 被いいね数。 */
  readonly likesReceived: number;
  /** 頁番号（1 始まり）。 */
  readonly page: number;
  /** 次の頁があるか。 */
  readonly hasNext: boolean;
}

/** 作品が 1 件も無いときの文言。 */
export const NO_WORKS_NOTICE = 'まだ公開された作品がありません。';

/**
 * 表示名が引けなかったときの見出し。
 *
 * **`src/work-card.ts` の `UNKNOWN_AUTHOR`（「不明」）を借りない。** あちらは行の中に
 * 「不明」と並ぶ形で、ここは `<h1>` である——**見出しが「不明」だけの画面は、壊れて
 * いるようにしか見えない。** 役割が違うので綴りを分ける（借りると、片方に合わせて
 * もう片方が不自然になる）。
 *
 * **`display_name` は `NOT NULL` である**（0001）ので、通常この綴りは画面に出ない。
 * それでも持つのは、**不変条件を画面が前提にしない**ためである（`src/my-works.ts` と
 * 同じ方針。空欄の `<h1>` を出すくらいなら、分からないと言うほうがよい）。
 */
export const UNKNOWN_AUTHOR_HEADING = '名前のない作者';

/**
 * 被いいね数の札。
 *
 * **0 でも出す。** 仕様 2.3.6 はカードの「いいねの数」を「0 のときは出さない」と
 * 定めているが、**あれは行の中に並ぶ項目の話である**（全行に「いいね 0」が並ぶ一覧は
 * 区別を何も運ばない）。**この画面で被いいね数は、2.3.1 が出すと定めた 2 つの値のうちの
 * 1 つである。** 0 のときに消すと、**「まだ誰にも押されていない」と「数が出ていない」の
 * 区別が付かない**（`src/work-card.ts` の `cardLikeCount` が「誤った数を 1 つも出さない」
 * ために倒した先と、役割が逆である）。
 *
 * @param count 被いいね数
 * @returns HTML
 */
function likesLine(count: number): string {
  // **最大 5 分遅れることを画面で言わない。** 5.8 が許した遅れであり、遅れの断り書きを
  // 全画面へ並べると、そちらのほうが目立つ（一覧も作品ページも言っていない）。
  return `<p class="gf-author-likes">受け取ったいいね ${count}</p>`;
}

/**
 * 頁送りを組み立てる。
 *
 * **無限スクロールを置かない**（仕様 2.3.3）。JavaScript も増やさない（9.3）。
 * 綴りは `src/works-list.ts` の頁送りと同じ形にしてある。
 *
 * @param view 表示に必要な値
 * @returns HTML。前も次も無ければ空文字
 */
function renderPager(view: AuthorPageView): string {
  const links: string[] = [];
  const to = (page: number): string => `${authorPagePath(view.userId)}?page=${page}`;
  if (view.page > 1) {
    links.push(`<a href="${to(view.page - 1)}">前の ${WORKS_PER_PAGE} 件</a>`);
  }
  if (view.hasNext) {
    links.push(`<a href="${to(view.page + 1)}">次の ${WORKS_PER_PAGE} 件</a>`);
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join(' ')}</nav>`;
}

/**
 * 作者ページの HTML を組み立てる。
 *
 * **`noindex` を付けない。** ここは誰にでも見せる発見の面であり（2.3.1 の「ログイン: 不要」）、
 * `src/my-works.ts` や未公開の作品ページとは性質が違う（`src/works-list.ts` と同じ判断）。
 *
 * **表示名を `<h1>` と `<title>` の両方へ出す。** どちらも `escapeHtml` を通る
 * （`<title>` は `siteHead` が中で通す。二重に掛けない）。**保存時の制約は XSS を
 * 防がない**——5.9 が弾くのは長さと制御文字だけで、`<script>` も `"` も 30 文字に
 * 収まる。`test/display-name-escape.test.ts` がこの画面を 1 件見ている。
 *
 * **説明文（`meta description`）に表示名を入れない。** 入れても検索のための語が増える
 * だけで、**UGC を属性値へ入れる場所が 1 か所増える。** 増やす利得が無い。
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderAuthorPage(view: AuthorPageView): string {
  const name = escapeHtml(view.displayName);
  const cards = renderWorkCards(view.works);
  // **空のときに「この作者の作品」の見出しだけを残さない**（`src/home.ts` の規律。
  // 出来ていないものを出来ているように見せない）。
  const body = cards === '' ? `<p>${NO_WORKS_NOTICE}</p>` : cards;

  return `${siteHead({
    title: `${view.displayName} の作品 - Game Forge`,
    extraHead:
      '\n<meta name="description" content="Game Forge の作者ページ。この作者が公開したブラウザ2Dゲームが並びます。">',
  })}
<h1>${name}</h1>
${likesLine(view.likesReceived)}
${body}
${renderPager(view)}
<p class="gf-author-back"><a href="${PUBLIC_WORKS_PATH}">ほかの作品をさがす</a></p>
${siteFooter()}`;
}

/**
 * 見つからなかったときの応答。
 *
 * **404 の本文で理由を分けない。** 「そんな利用者は居ない」と「id の綴りが長すぎる」を
 * 区別して返す理由が無く、区別すると id の総当たりに手掛かりを渡す。
 *
 * @returns レスポンス
 */
function notFound(): Response {
  return html(
    `${siteHead({ title: '作者が見つかりません - Game Forge', noindex: true })}
<h1>作者が見つかりません</h1>
<p>URL が正しいかご確認ください。</p>
<p><a href="${PUBLIC_WORKS_PATH}">公開されている作品をさがす</a></p>
${siteFooter()}`,
    404,
  );
}

/**
 * パスから `user_id` を取り出す。
 *
 * **`decodeURIComponent` が投げうる。** 壊れたパーセント符号（`/users/%`）は
 * `URIError` になるので、**404 へ倒す**（500 にしない——利用者が URL を書き換えた
 * だけの要求である）。
 *
 * **`/` を含む続きは受け付けない。** `/users/a/b` は作者ページではない。前方一致の
 * 経路は続きを全部拾うので、ここで落とす。
 *
 * @param pathname 要求されたパス
 * @returns 利用者 id。取り出せなければ null
 */
export function userIdFromPath(pathname: string): string | null {
  const raw = pathname.slice(AUTHOR_PAGE_PREFIX.length);
  if (raw === '' || raw.includes('/') || raw.length > MAX_USER_ID_LENGTH * 3) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === '' || decoded.includes('/') || decoded.length > MAX_USER_ID_LENGTH) {
    return null;
  }
  return decoded;
}

/**
 * 作者ページを表示する。
 *
 * **表示名を先に、キャッシュを通さず引く。** 理由は 3 つある。
 *
 * 1. **存在しない利用者を 404 にする判定がこの 1 行である**（issue #330 の受け入れ）。
 *    主キーの 1 行読み取りで、いちばん安い
 * 2. **5.9 の表示名の変更が 60 秒遅れない。** 変えた本人が自分の作者ページを開いて
 *    古い名前を見るのは、「変わっていない」と読める
 * 3. **キャッシュに存在しない利用者の結果を溜めない。** 実在しない id の要求を
 *    キャッシュしても D1 の読み取りは 1 行も減らない（鍵が毎回違う）
 *
 * **選ぶのは `display_name` 1 列だけである。** `email` と `invited_by` を選ばない
 * （モジュール冒頭。選ばなければ漏れようがない）。**`banned_at` も選ばない**——見ない
 * と決めた値を引くと、次に読む人が「見るつもりだったのでは」と読む。
 *
 * **上限より 1 件多く引く。** 「ちょうど 20 件あった」と「次の頁がある」は引いた件数だけ
 * では区別できず、区別せずに「次へ」を出すと**空の頁へ送る**（`src/works-list.ts` と
 * 同じ形）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showAuthorPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = userIdFromPath(url.pathname);
  if (userId === null) {
    return notFound();
  }

  const user = await env.DB.prepare('select display_name from users where id = ?')
    .bind(userId)
    .first<{ display_name: string | null }>();
  if (user === null) {
    return notFound();
  }

  const page = toPageNumber(url.searchParams.get('page'));
  const offset = (page - 1) * WORKS_PER_PAGE;

  const data = await cachedRows<AuthorWorksData>(authorCacheKey(userId, page), async () => {
    // **直列に引く。** `Promise.all` で並べても D1 の読み取り行数は変わらず、
    // 同時実行数だけが増える（`src/home-feed.ts` と同じ判断）。前段にキャッシュが
    // あるので、ここが走るのは 60 秒に 1 回である。
    const rows = await env.DB.prepare(authorWorksSql())
      .bind(userId, PUBLISHED_STATUS, WORKS_PER_PAGE + 1, offset)
      .all<{
        id: string;
        title: string;
        published_at: number | null;
        fork_count: number;
        like_count: number;
        parent_id: string | null;
        ogp_state: string | null;
        author_id: string | null;
      }>();
    const counted = await env.DB.prepare(likesReceivedSql())
      .bind(userId, PUBLISHED_STATUS)
      .first<{ likes: number }>();

    return {
      works: rows.results.map((row) => ({
        id: row.id,
        title: row.title,
        // **名前はキャッシュに載せない**（{@link AuthorWorksData}）。描画の直前に、
        // 毎回引いている `users` の行から差し替える。
        authorName: null,
        authorId: row.author_id,
        publishedAt: row.published_at,
        forkCount: row.fork_count,
        likeCount: row.like_count,
        hasParent: row.parent_id !== null,
        hasShot: row.ogp_state === 'ready',
      })),
      // `coalesce` が 0 に倒しているが、**キャッシュを経由する値は JSON である**ので
      // 数でないものが入りうる（`src/work-card.ts` の `cardLikeCount` と同じ備え）。
      likesReceived: typeof counted?.likes === 'number' ? counted.likes : 0,
    };
  });

  const works = data.works ?? [];
  // **名前は 1 か所で決める。** 見出しとカードが別々に倒し方を持つと、**同じ画面が
  // 1 つの名前について 2 つのことを言う**（PR #350 の Copilot code review の指摘。
  // 空の表示名で、見出しは既定値・カードは空文字のリンクになっていた）。
  const name = displayNameOf(user.display_name);
  return html(
    renderAuthorPage({
      displayName: name ?? UNKNOWN_AUTHOR_HEADING,
      userId,
      // **カードの名前を毎回差し替える**（{@link AuthorWorksData}）。並ぶのは 1 人の
      // 作者の作品だけなので、全件に同じ名前を入れてよい。
      //
      // **引けなければ null を渡す。** カードは自分の既定値（`UNKNOWN_AUTHOR`）へ倒し、
      // **リンクにもしない**（`src/work-card.ts` の `cardAuthorId` が `authorName` が
      // null の行をリンクにしない）。空文字がリンクになる形を作らない。
      works: works.slice(0, WORKS_PER_PAGE).map((work) => ({ ...work, authorName: name })),
      likesReceived: data.likesReceived ?? 0,
      page,
      hasNext: works.length > WORKS_PER_PAGE && page < MAX_PAGE,
    }),
  );
}

/**
 * `users.display_name` を、画面に出してよい名前へ落とす。
 *
 * **`display_name` は `NOT NULL` である**（0001）が、**不変条件を画面が前提にしない**
 * （`src/my-works.ts` と同じ方針）。空白だけの値も「無い」側へ倒す——空欄の `<h1>` と、
 * 空文字のリンクを作らない。
 *
 * **倒し先をここで決めない。** 見出しは {@link UNKNOWN_AUTHOR_HEADING}、カードは
 * `src/work-card.ts` の `UNKNOWN_AUTHOR` で、**同じ「無い」に対して画面ごとに違う文言が
 * 要る**（`<h1>` に「不明」だけが出る画面は壊れて見える）。ここが返すのは「引けたか」の
 * 1 ビットである。
 *
 * @param value `users.display_name`
 * @returns 出してよい名前。引けなければ null
 */
function displayNameOf(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/**
 * 作者ページの経路（#330 / M9-4）。
 *
 * `src/app.ts` の経路表へ連結する。**前方一致で登録する**（`/users/<user_id>` の
 * `<user_id>` を拾う。`src/routes.ts` は完全一致を前方一致より先に見るので、将来
 * `/users/mine` のような固定の経路を足しても飲み込まれない）。
 */
export const usersPageRoutes: readonly Route[] = [
  { method: 'GET', path: AUTHOR_PAGE_PREFIX, match: 'prefix', handler: showAuthorPage },
];
