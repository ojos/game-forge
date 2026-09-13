/**
 * 作者ページ（`/users/<user_id>` と `/@handle`）。**作品から作者へ辿れるようにする 1 枚である**
 * （仕様 2.3.1 / 2.3.6 / 5.8 / 5.10 / #330 / M9-4 / #381 / M12-13）。
 *
 * ## `/@handle` と `/users/<user_id>`（#381 / 5.10）
 *
 * **ハンドル名を決めた作者の作者ページは `/@handle` である。** `/users/<user_id>` は死なせない
 * （共有されている可能性がある）。
 *
 * | 要求 | 応答 |
 * |---|---|
 * | `/users/<user_id>`（ハンドル名あり） | **301** で `/@handle` へ（`cache-control: no-store`） |
 * | `/users/<user_id>`（ハンドル名なし） | いままでどおり作者ページ（**ハンドル名を強制しない・自動で作らない**） |
 * | `/@handle`（いま使っている） | 作者ページ |
 * | `/@旧ハンドル`（改名から 90 日以内） | **302** で `/@新ハンドル` へ（`cache-control: no-store`） |
 * | `/@旧ハンドル`（90 日を過ぎた）・知らない名前 | 404 |
 * | `/@Handle`（大文字を含む） | **301** で小文字の綴りへ（大文字小文字違いは同じハンドル名。5.10） |
 *
 * **`/users/<id>` → `/@handle` を 301 にし、`no-store` を付ける。** 301 は「この URL の正しい綴りは
 * 移った」を検索エンジンと共有先に伝える（2.3.1 の「恒久的なリダイレクト」）。**ただし行き先は改名で
 * 変わる**ので、ブラウザに 301 を覚えさせない——覚えさせると、改名の後もブラウザが古い `/@handle` へ
 * 送り続け、90 日を過ぎた日に 404 になる。
 *
 * **`/@旧` → `/@新` は 302 にする。** この転送は **90 日で終わる期限付きのもの**で、しかも**その間に
 * 本人がまた改名しうる**（30 日に 1 回）。「恒久的に移った」とは言えないものを 301 と言うと、検索エンジンと
 * キャッシュに誤った事実を覚えさせる。`no-store` も付ける（期限を過ぎた転送を残さない）。
 *
 * **転送先は、旧ハンドルの持ち主が「いま」使っているハンドル名である**——改名を重ねても、旧い綴りから
 * 直接いまの綴りへ 1 回で着く（転送を鎖にしない）。
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
import type { AuthorProfileView } from './author-profile.js';
import { renderAuthorProfile } from './author-profile.js';
import type { PublicWork } from './games.js';
import { PUBLISHED_STATUS } from './games.js';
import type { SiteViewer } from './html.js';
import { avatarUrl, sandboxOriginOf } from './avatar-paths.js';
import { avatarImage, escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { cachedRows, listCacheKey } from './list-cache.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { HANDLE_RESERVATION_SECONDS, HANDLES_TABLE } from './handle.js';
import { HANDLE_PAGE_PREFIX, handlePagePath, isStoredHandle } from './handle-paths.js';
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
  // **タグの枠を選ぶのはカードに出すためである**（#376。`publishedGamesSql` と揃える）。
  return `select g.id, g.title, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
            g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3
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
  /** 利用者 id。 */
  readonly userId: string;
  /**
   * この画面のパス（頁送りのリンクに入る。#381）。**`/@handle` で開いた画面の頁送りは `/@handle?page=` へ送る。**
   *
   * **省略可にする**（描画を直接呼ぶテストが、ハンドル名に関係しない検査で値を用意しなくて済む）。
   * 省いたら `/users/<user_id>` である。
   */
  readonly pagePath?: string;
  /** 並べる作品（既に {@link WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly PublicWork[];
  /** 被いいね数。 */
  readonly likesReceived: number;
  /** 頁番号（1 始まり）。 */
  readonly page: number;
  /** 次の頁があるか。 */
  readonly hasNext: boolean;
  /** 自己紹介と外部リンク（#379。描画は `src/author-profile.ts`。無ければ出さない）。 */
  readonly profile?: AuthorProfileView;
  /**
   * 作者のアイコンの URL（版つき。設定していなければ null。#380）。**見出しの直前に出す。**
   *
   * **省略可にする**（`profile` と同じ。描画を直接呼ぶテストが、アイコンに関係しない検査で値を
   * 用意しなくて済む）。
   */
  readonly avatarUrl?: string | null;
  /** カードのアイコンの URL を組み立てるサンドボックス用ホストのオリジン（#380。無ければカードに画像を出さない）。 */
  readonly avatarOrigin?: string | null;
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
  const base = view.pagePath ?? authorPagePath(view.userId);
  const to = (page: number): string => `${escapeHtml(base)}?page=${page}`;
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
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderAuthorPage(view: AuthorPageView, viewer: SiteViewer): string {
  const name = escapeHtml(view.displayName);
  const cards = renderWorkCards(view.works, view.avatarOrigin ?? null);
  // **空のときに「この作者の作品」の見出しだけを残さない**（`src/home.ts` の規律。
  // 出来ていないものを出来ているように見せない）。
  const body = cards === '' ? `<p>${NO_WORKS_NOTICE}</p>` : cards;

  return `${siteHead({
    title: `${view.displayName} の作品 - Game Forge`,
    viewer,
    extraHead:
      '\n<meta name="description" content="Game Forge の作者ページ。この作者が公開したブラウザ2Dゲームが並びます。">',
  })}
${authorAvatar(view.avatarUrl ?? null)}<h1>${name}</h1>
${likesLine(view.likesReceived)}
${renderAuthorProfile(view.profile)}
${body}
${renderPager(view)}
<p class="gf-author-back"><a href="${PUBLIC_WORKS_PATH}">ほかの作品をさがす</a></p>
${siteFooter()}`;
}

/**
 * 見出しの直前に出す作者のアイコン（#380）。
 *
 * **`<h1>` の中に入れない**——見出しの文字（作者名）を、画像の有無で変えない（`<h1>` の文字を
 * 照合する検査と、読み上げの見出しの一覧をそのままにする）。**設定していなければ何も出さない**
 * （既定の図形を全作者に並べない。見た目は #433 の規約が決まるまで、既存のアバターの寸法のまま）。
 *
 * @param url アイコンの URL（無ければ null）
 * @returns HTML（無ければ空文字）
 */
function authorAvatar(url: string | null): string {
  if (url === null) {
    return '';
  }
  return `<p class="gf-author-avatar"><span class="gf-avatar" aria-hidden="true">${avatarImage(url)}</span></p>\n`;
}

/**
 * 見つからなかったときの応答。
 *
 * **404 の本文で理由を分けない。** 「そんな利用者は居ない」と「id の綴りが長すぎる」を
 * 区別して返す理由が無く、区別すると id の総当たりに手掛かりを渡す。
 *
 * **ヘッダは出す。** 404 は行き止まりなので、**ここから出る道が要る**（2.3.7）。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns レスポンス
 */
function notFound(viewer: SiteViewer): Response {
  return html(
    `${siteHead({ title: '作者が見つかりません - Game Forge', noindex: true, viewer })}
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
 * **選ぶのは `display_name` と、公開する自己紹介・外部リンク（`bio` / `profile_links`。#379）
 * だけである。** `email` と `invited_by` を選ばない（モジュール冒頭。選ばなければ漏れようがない）。**`banned_at` も選ばない**——見ない
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
  // **ヘッダの出し分けだけを先に決める**（2.3.7 / #331）。**本文はログイン状態で
  // 変わらない**——作者ページは誰にでも同じものが出る（`src/home.ts` と同じ扱い）。
  // **D1 は読まない**（`resolveSiteViewer` は署名だけを見る）ので、404 の経路でも 1 行も
  // 増えない。
  const viewer = await resolveSiteViewer(request, env);
  const userId = userIdFromPath(url.pathname);
  if (userId === null) {
    return notFound(viewer);
  }

  // 自己紹介と外部リンク（#379）も同じ 1 行から引く（キャッシュに載せない理由は表示名と同じ）。
  // アイコン（#380）も同じ 1 行から引く。**版は `avatar_sha256` が無ければ使わない**（外した後も進む）。
  // **いま使っているハンドル名（#381）も同じ 1 回で引く**（部分索引の 1 行。あれば `/@handle` へ 301）。
  const user = await env.DB.prepare(
    `select display_name, bio, profile_links, avatar_sha256, avatar_set_at,
            (select h.handle from ${HANDLES_TABLE} h where h.user_id = users.id and h.released_at is null) as handle
       from users where id = ?`,
  )
    .bind(userId)
    .first<AuthorUserRow & { handle: string | null }>();
  if (user === null) {
    return notFound(viewer);
  }
  if (isStoredHandle(user.handle)) {
    // **301 に `no-store` を付ける**（モジュール冒頭の表）。**query（頁）を持ち越す。**
    return redirectTo(`${handlePagePath(user.handle)}${url.search}`, 301);
  }
  return await renderAuthorResponse(request, env, viewer, userId, user, null);
}

/** 作者ページの描画に要る `users` の列（**公開してよい列だけ**。モジュール冒頭）。 */
interface AuthorUserRow {
  readonly display_name: string | null;
  readonly bio: string | null;
  readonly profile_links: string | null;
  readonly avatar_sha256: string | null;
  readonly avatar_set_at: number | null;
}

/**
 * 転送の応答を返す（`cache-control: no-store`。モジュール冒頭の表）。
 *
 * @param location 転送先（アプリ用ホスト上の絶対パス）
 * @param status 301 か 302
 * @returns レスポンス
 */
function redirectTo(location: string, status: 301 | 302): Response {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * パスからハンドル名を取り出す（`/@handle` の `handle`。**大文字小文字はそのまま**）。
 *
 * **パーセント符号を戻さない。** ハンドル名の文字（ASCII の英字・数字・`_`）は符号化されないので、
 * `%` を含む綴りはハンドル名ではない（404）。
 *
 * @param pathname 要求されたパス
 * @returns ハンドル名の綴り（形を満たさなければ null）
 */
export function handleFromPath(pathname: string): string | null {
  const raw = pathname.slice(HANDLE_PAGE_PREFIX.length);
  return isStoredHandle(raw.toLowerCase()) && /^[A-Za-z0-9_]+$/u.test(raw) ? raw : null;
}

/**
 * ハンドル名の作者ページを表示する（`/@handle`。#381 / 5.10）。
 *
 * **1 回の問い合わせで、ハンドル名の行・持ち主の `users` の列・持ち主がいま使っているハンドル名を引く。**
 * 行が無ければ 404、いま使っている行なら作者ページ、手放してから 90 日以内なら持ち主のいまのハンドル名へ
 * 302、それより古ければ 404（モジュール冒頭の表）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function showHandlePage(request: Request, env: Env, now: () => number): Promise<Response> {
  const url = new URL(request.url);
  const viewer = await resolveSiteViewer(request, env);
  const raw = handleFromPath(url.pathname);
  if (raw === null) {
    return notFound(viewer);
  }
  const handle = raw.toLowerCase();
  if (raw !== handle) {
    return redirectTo(`${handlePagePath(handle)}${url.search}`, 301);
  }

  const row = await env.DB.prepare(
    `select h.user_id, h.released_at,
            u.display_name, u.bio, u.profile_links, u.avatar_sha256, u.avatar_set_at,
            (select c.handle from ${HANDLES_TABLE} c where c.user_id = h.user_id and c.released_at is null)
              as current_handle
       from ${HANDLES_TABLE} h
       join users u on u.id = h.user_id
      where h.handle = ?`,
  )
    .bind(handle)
    .first<AuthorUserRow & { user_id: string; released_at: number | null; current_handle: string | null }>();
  if (row === null) {
    return notFound(viewer);
  }
  if (row.released_at === null) {
    return await renderAuthorResponse(request, env, viewer, row.user_id, row, handle);
  }
  if (row.released_at > now() - HANDLE_RESERVATION_SECONDS) {
    // **持ち主のいまのハンドル名へ直接送る**（転送を鎖にしない）。いまのハンドル名が無い行は構造上
    // 作られない（手放すのは別の名前を取る batch の中だけ）が、無ければ `/users/<id>` へ倒す。
    const location = isStoredHandle(row.current_handle)
      ? handlePagePath(row.current_handle)
      : authorPagePath(row.user_id);
    return redirectTo(`${location}${url.search}`, 302);
  }
  return notFound(viewer);
}

/**
 * 作者ページの本体を組み立てて返す（`/users/<user_id>` と `/@handle` が共有する）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param viewer いま見ている人の状態
 * @param userId 作者の利用者 id
 * @param user 作者の `users` の列
 * @param handle 作者のいまのハンドル名（`/@handle` で開いたとき。無ければ null）
 * @returns レスポンス
 */
async function renderAuthorResponse(
  request: Request,
  env: Env,
  viewer: SiteViewer,
  userId: string,
  user: AuthorUserRow,
  handle: string | null,
): Promise<Response> {
  // **頁送りとカードの作者名のリンクは、この画面の綴りに揃える**（`/@handle` で開いたら `/@handle`）。
  const pagePath = handle === null ? authorPagePath(userId) : handlePagePath(handle);
  const url = new URL(request.url);
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
        play_count: number;
        parent_id: string | null;
        ogp_state: string | null;
        author_id: string | null;
        tag1: string | null;
        tag2: string | null;
        tag3: string | null;
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
        playCount: row.play_count,
        hasParent: row.parent_id !== null,
        hasShot: row.ogp_state === 'ready',
        // タグ（#376）。語彙に照らして描くのはカードの側である（`src/work-card.ts` の
        // `knownWorkTags`）。**読み方は `src/games.ts` の `workTagsOf` と同じ**（枠の順に、NULL を
        // 除く）だが、ここでは import を足さない——このファイルの冒頭は並行して別の issue
        // （#379）が触っており、共有する区画を作品の SQL と写しの箇所だけに閉じるためである。
        tags: [row.tag1, row.tag2, row.tag3].filter((tag): tag is string => tag !== null),
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
  const avatarVersion = user.avatar_sha256 === null ? null : user.avatar_set_at;
  const avatarOrigin = sandboxOriginOf(request, env.SANDBOX_HOST);
  return html(
    renderAuthorPage(
      {
        displayName: name ?? UNKNOWN_AUTHOR_HEADING,
        userId,
        pagePath,
        // **カードの名前を毎回差し替える**（{@link AuthorWorksData}）。並ぶのは 1 人の
        // 作者の作品だけなので、全件に同じ名前を入れてよい。
        //
        // **引けなければ null を渡す。** カードは自分の既定値（`UNKNOWN_AUTHOR`）へ倒し、
        // **リンクにもしない**（`src/work-card.ts` の `cardAuthorId` が `authorName` が
        // null の行をリンクにしない）。空文字がリンクになる形を作らない。
        //
        // **アイコンの版も同じく毎回差し替える**（#380。キャッシュの 60 秒の間に差し替えた画像を
        // 古い版で出さない）。
        works: works
          .slice(0, WORKS_PER_PAGE)
          .map((work) => ({ ...work, authorName: name, authorAvatarSetAt: avatarVersion, authorHandle: handle })),
        likesReceived: data.likesReceived ?? 0,
        page,
        hasNext: works.length > WORKS_PER_PAGE && page < MAX_PAGE,
        profile: { bio: user.bio, links: user.profile_links },
        avatarUrl: avatarVersion === null ? null : avatarUrl(avatarOrigin, userId, avatarVersion),
        avatarOrigin,
      },
      viewer,
    ),
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

/** {@link createUsersPageRoutes} に渡す差し替え。 */
export interface UsersPageRouteOptions {
  /** 現在時刻（UNIX 秒）。既定は `Date.now()` から。テストが 90 日の境界を固定するために使う。 */
  readonly now?: () => number;
}

/**
 * 作者ページの経路（#330 / M9-4 / #381）。
 *
 * `src/app.ts` の経路表へ連結する。
 *
 * - **`/users/` は前方一致で登録する**（`<user_id>` を拾う。`src/routes.ts` は完全一致を前方一致より
 *   先に見るので、将来 `/users/mine` のような固定の経路を足しても飲み込まれない）
 * - **`/@` は 1 セグメントの経路で登録する**（`src/routes.ts` の `RouteMatch` の `segment`。`/@foo/bar` には
 *   一致しない）
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createUsersPageRoutes(options: UsersPageRouteOptions = {}): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return [
    { method: 'GET', path: AUTHOR_PAGE_PREFIX, match: 'prefix', handler: showAuthorPage },
    {
      method: 'GET',
      path: HANDLE_PAGE_PREFIX,
      match: 'segment',
      handler: (request, env) => showHandlePage(request, env, now),
    },
  ];
}

/** アプリの経路表へ連結する作者ページの経路。 */
export const usersPageRoutes: readonly Route[] = createUsersPageRoutes();
