/**
 * 「自分がいいねした作品」（`/works/liked`）。**本人だけが見られる**（仕様 5.8 / 2.3.1 /
 * M9-8 / #340）。
 *
 * ## なぜ本人だけなのか
 *
 * 5.8 は「**誰が押したかは公開しない**」と決めている。数は作品と作者に公開するが、
 * **その内訳は出さない。** この画面はその決定の中で唯一の出口であり、**出口が 1 つで
 * あることそのものが決定の実装**である。だから未ログインならログインへ送り、他人の
 * 一覧を引く経路は持たない（`user_id` を URL で受け取らない——**受け取れる形にした
 * 瞬間に、決定は「引数を渡さない運用」に落ちる**）。
 *
 * ## 正本は Durable Objects にあり、絞り込みは D1 で行う
 *
 * ```text
 * ブラウザ → この画面 ─ src/likes.ts（窓口）─ LikeHub.likedGames() → 押した順の id
 *                     └ D1 で引き直す ─ 公開済み・審査で止めていない作品だけ
 * ```
 *
 * **いいねの正本は D1 に無い**（5.8。D1 は日次の書き込み上限を超えるとアカウント全体が
 * 止まる。3.6）。だから「押した順」は DO しか知らず、「いま公開されているか」は D1 しか
 * 知らない。**2 つを結ぶのがこの画面の仕事である。**
 *
 * ## 絞り込みは引く時点で行う（#152 の規律）
 *
 * **DO が返した id を D1 で引き直し、`status = 'published'` と 8.4 の審査の可視条件を
 * `where` に置く**（{@link LIKED_WORKS_SQL}）。画面側で `filter` する形は #152 が
 * `/works` について退けたものと同じで、**書き忘れても「それらしく」動く**
 * （公開作品は正しく出る）。5.4 の「「公開」操作で初めて URL が有効になる」を、
 * この一覧が抜け道にしてはいけない。
 *
 * **押したあとに公開をやめた作品は、いいねの行としては残っている。** DO の行は消さない
 * ——公開し直せば一覧へ戻るし、**消す実装は「取り消した」と区別が付かない**（数が
 * 変わってしまう）。
 *
 * ## 1 頁が 20 件に満たないことがある
 *
 * **上の絞り込みの当然の帰結である**（5.8 が明記している）。DO から 20 件の id を受けて
 * も、そのうち公開をやめた作品は並ばない。**それを隠さない**——「次の 20 件」は
 * **DO が返した id の数**で決めるので、**空に近い頁を経由して次の頁へ進める。**
 * 件数を揃えるために DO を何度も引く形は採らない（1 頁の表示で DO の呼び出しが
 * 何回になるか決まらなくなる。5.8 は「1 回だけ問い合わせる」を基調にしている）。
 *
 * ## JavaScript もスタイルシートも要求しない
 *
 * MVP の画面は SSR の素の HTML に留める（9.3）。カードは公開一覧と**同じ 1 つの部品**を
 * 使う（`src/work-card.ts`。仕様 2.3.6）。
 */
import { LOGIN_PATH } from './auth/google.js';
import type { PublicWork } from './games.js';
import { PUBLISHED_STATUS } from './games.js';
import { siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import { listLikedGameIds } from './likes.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { renderWorkCards } from './work-card.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from './works-paths.js';

/**
 * 「自分がいいねした作品」のパス。
 *
 * **正本は `src/liked-works-paths.ts` である**（導線を出す `src/my-works.ts` と持ち合うと
 * 循環参照になる。`src/paths.ts` に置かない理由は Lambda の束に入るからで、あちらの冒頭）。
 * ここから再輸出するのは `src/works-list.ts` / `src/my-works.ts` と同じ扱いである。
 */
export { LIKED_WORKS_PATH };

/**
 * 1 頁に並べる件数。
 *
 * **20 件**（仕様 5.8 の「20 件ずつ」）。公開一覧の `WORKS_PER_PAGE` と同じ値だが、
 * **あちらから借りない**——`src/works-list.ts` は M9 の別の項目が触るファイルで、
 * 値を借りると「一覧の件数を変えたらいいねの一覧も変わる」という結び付きが生まれる。
 * 仕様が別々に 20 と定めているものは、別々に持つ。
 */
export const LIKED_WORKS_PER_PAGE = 20;

/**
 * 頁数の上限。
 *
 * **`OFFSET` は読み飛ばした行を数える**（`src/works-list.ts` の `MAX_PAGE` と同じ理由）。
 * 上限が無いと `?page=999999` の 1 本で DO の単一スレッドを長く占有できる——**1 個の DO に
 * 全員のいいねが集まっている**（5.8 の B1）ので、公開一覧より効きが強い。
 *
 * **25 頁（＝500 件）。** 1 人が押せるのは 1 日 100 操作まで（5.8）なので、500 件は
 * 5 日ぶんの上限にあたる。**ここに当たる利用者が出たら頁送りではなく続きの鍵で辿る形
 * （keyset）へ変える時期である**（`src/works-list.ts` が同じことを書いている）。
 */
export const MAX_LIKED_PAGE = 25;

/**
 * `?page=` の名前。**公開一覧と同じ綴りにする**（利用者が頁の綴りを画面ごとに覚えない）。
 */
export const LIKED_PAGE_PARAM = 'page';

/**
 * DO が返した id を D1 で引き直す SQL（**引く時点で絞る**。#152 / 5.8）。
 *
 * **関数として出しているのは、検査が同じ SQL を書き写さないようにするためである**
 * （`src/games.ts` の `publishedGamesSql` と同じ扱い。`.ai-playbook/shared-ai-rules.md`
 * 12 章）。`test/liked-works.test.ts` はここが返す文字列をそのまま見る。
 *
 * **`in (...)` の `?` の数は id の件数から作る。** 文字列を組み立てるが、**材料は件数
 * （整数）だけ**で、id そのものは束縛パラメータとして渡す。件数は
 * {@link LIKED_WORKS_PER_PAGE} + 1 で上限が付いており、利用者の入力が SQL の文へ届く
 * 経路が無い。
 *
 * **`users` からは表示名 1 列だけを選ぶ**（`email` と `invited_by` は公開しない。
 * 仕様 2.3.6。選ばなければ画面の側で書き間違えても漏れようがない）。
 *
 * **並べ替えを SQL に書かない。** 順序の正本は DO（押した順）であり、D1 は
 * `published_at` しか持たない。**押した順を D1 で作り直すことはできない**ので、
 * 引いた行を呼び出し側が id の順へ並べ替える（{@link listLikedWorks}）。
 * **これは絞り込みではないので、#152 の規律に反しない。**
 *
 * @param count 引く id の件数（1 以上）
 * @returns 束縛パラメータが `count + 1` 個（id … / status）の SELECT 文
 */
export function likedWorksSql(count: number): string {
  const placeholders = new Array<string>(count).fill('?').join(', ');
  return `select g.id, g.title, g.published_at, g.fork_count, g.like_count, g.parent_id,
            g.ogp_state, u.display_name as author_name
       from games g
       left join users u on u.id = g.author_id
      where g.id in (${placeholders}) and g.status = ? and ${reviewVisibleSql('g')}`;
}

/**
 * いいねした作品を引く（DO → D1 の 2 段）。
 *
 * **DO は 1 回、D1 は 1 回**（id が 0 件なら D1 は 0 回）。件数を揃えるために引き直さない
 * （このモジュール冒頭の「1 頁が 20 件に満たないことがある」）。
 *
 * **DO へ届かなければ `unavailable` を立てて返す**（`src/likes.ts` の「読み取りが届かなくても、
 * 画面ごと落とさない」）。**空の一覧と区別する**——「まだ押していない」と「読めなかった」を
 * 同じ表示にすると、画面が嘘をつく。
 *
 * @param env バインディングと環境変数
 * @param userId **セッションで確かめた**利用者 id
 * @param page 頁番号（1 始まり）
 * @returns 並べる作品（押した新しい順）と、次の頁があるか、読めたか
 */
export async function listLikedWorks(
  env: Env,
  userId: string,
  page: number,
): Promise<{ works: readonly PublicWork[]; hasNext: boolean; unavailable: boolean }> {
  // **上限より 1 件多く引く。** 「ちょうど 20 件あった」と「次の頁がある」は引いた件数
  // だけでは区別できず、区別せずに「次へ」を出すと**空の頁へ送る**ことになる
  // （`src/works-list.ts` / `src/my-works.ts` と同じ理由）。
  //
  // **数えるのは DO が返した id である。** 絞り込みで落ちた分を「次が無い」と読むと、
  // 公開をやめた作品を 20 件続けて押した利用者の 2 頁目が消える。
  const ids = await listLikedGameIds(
    env,
    userId,
    LIKED_WORKS_PER_PAGE + 1,
    (page - 1) * LIKED_WORKS_PER_PAGE,
  );
  if (ids === null) {
    // **DO へ届かなかった。** D1 を引かずに返す——引く材料（id）が無い。
    return { works: [], hasNext: false, unavailable: true };
  }
  const hasNext = ids.length > LIKED_WORKS_PER_PAGE && page < MAX_LIKED_PAGE;
  const wanted = ids.slice(0, LIKED_WORKS_PER_PAGE);
  if (wanted.length === 0) {
    return { works: [], hasNext: false, unavailable: false };
  }

  const result = await env.DB.prepare(likedWorksSql(wanted.length))
    .bind(...wanted, PUBLISHED_STATUS)
    .all<{
      id: string;
      title: string;
      published_at: number | null;
      fork_count: number;
      like_count: number;
      parent_id: string | null;
      ogp_state: string | null;
      author_name: string | null;
    }>();

  const rows = new Map(result.results.map((row) => [row.id, row]));
  // **DO の順序へ並べ替える。** `in (...)` は順序を約束しない（SQLite は索引の都合で
  // 返す）。**押した順は DO だけが知っている**ので、id の並びを正として引いた行を拾う。
  // 引けなかった id（公開をやめた・審査で止めた・行が消えた）はここで落ちる。
  const works: PublicWork[] = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (row === undefined) {
      continue;
    }
    works.push({
      id: row.id,
      title: row.title,
      authorName: row.author_name,
      publishedAt: row.published_at,
      forkCount: row.fork_count,
      likeCount: row.like_count,
      hasParent: row.parent_id !== null,
      hasShot: row.ogp_state === 'ready',
    });
  }
  return { works, hasNext, unavailable: false };
}

/**
 * `?page=` を頁番号へ落とす。
 *
 * **落とすのであって、失敗させない**（`src/works-list.ts` の `toPageNumber` と同じ扱い）。
 * 手で書き換えた URL が 400 を返すより、1 頁目が出るほうがよい。
 *
 * @param value クエリの値（未指定なら null）
 * @returns 1 以上 {@link MAX_LIKED_PAGE} 以下の整数
 */
export function toLikedPageNumber(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, MAX_LIKED_PAGE);
}

/**
 * この一覧の URL を組み立てる。
 *
 * @param page 頁番号
 * @returns アプリ用ホスト上の絶対パス
 */
export function likedWorksPath(page: number): string {
  return page <= 1 ? LIKED_WORKS_PATH : `${LIKED_WORKS_PATH}?${LIKED_PAGE_PARAM}=${page}`;
}

/** 画面を組み立てるのに必要なものだけを集めた入力。 */
export interface LikedWorksView {
  /** 並べる作品（押した新しい順。既に {@link LIKED_WORKS_PER_PAGE} 件へ切ってある）。 */
  readonly works: readonly PublicWork[];
  /** 頁番号（1 始まり）。 */
  readonly page: number;
  /** 次の頁があるか。 */
  readonly hasNext: boolean;
  /**
   * いいねの正本（DO）へ届かなかったか（`src/likes.ts` の「読み取りが届かなくても、
   * 画面ごと落とさない」）。
   *
   * **`works` が空であることと兼ねない。** 「まだ 1 件も押していない」と「読めなかった」は
   * 言うべきことが正反対である——前者は「作品をさがす」へ誘い、後者は**何も言い切らずに
   * やり直しを促す。** 兼ねると、DO が落ちている間、画面が「まだいいねがありません」と
   * 嘘をつく（`src/home.ts` の「出来ていないものを出来ているように書かない」の裏返し）。
   */
  readonly unavailable: boolean;
}

/**
 * 「1 頁が 20 件に満たないことがある」ことの断り書き（5.8）。
 *
 * **出すのは、実際に欠けている頁だけである。** 全頁に同じ注記を並べると、区別を何も
 * 運ばない（`src/my-works.ts` が全行に同じ警告を並べないと決めたのと同じ）。
 *
 * **「公開をやめた作品」と「審査で止めた作品」を書き分けない。** どちらであるかを本人へ
 * 伝えると、8.4 の審査の状態が外から読めてしまう（`src/likes.ts` の
 * `NOT_PRESSABLE_MESSAGE` が理由を区別しないのと同じ判断）。
 */
export const HIDDEN_NOTICE =
  'いいねした作品のうち、公開されていないものはこの一覧に出ません。';

/**
 * いいねの正本（DO）へ届かなかったときの文言（`src/likes.ts` の「読み取りが届かなくても、
 * 画面ごと落とさない」）。
 *
 * **「いいねを取り消した」とも「まだ押していない」とも言わない。** 分かっているのは
 * 「いまは読めない」ことだけである。**いいねそのものは失われていない**（正本は DO に
 * 残っている）ことを言い、やり直しを促す。
 *
 * **応答は 200 である。** 画面として正しいことを言えているので、読み手にとっては
 * エラー頁ではない（`src/work-page.ts` が状態を読めないときに 200 で
 * 「状態を読み取れませんでした」と出すのと同じ扱い）。**サーバ側の失敗はログに出る**
 * （`LIKES_UNAVAILABLE_REASON`）。
 */
export const UNAVAILABLE_MESSAGE =
  'いまこの一覧を読み込めませんでした。いいねは失われていません。時間をおいてもう一度お試しください。';

/**
 * 頁送りを組み立てる。
 *
 * **無限スクロールを置かない**（仕様 2.3.3）。JavaScript も増やさない（9.3）。
 * 押しても何も起きない導線を出さない（4.4。次が無ければ「次へ」を出さない）。
 *
 * @param view 表示に必要な値
 * @returns HTML。前も次も無ければ空文字
 */
function renderPager(view: LikedWorksView): string {
  const links: string[] = [];
  if (view.page > 1) {
    links.push(
      `<a href="${likedWorksPath(view.page - 1)}">前の ${LIKED_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (view.hasNext) {
    links.push(
      `<a href="${likedWorksPath(view.page + 1)}">次の ${LIKED_WORKS_PER_PAGE} 件</a>`,
    );
  }
  if (links.length === 0) {
    return '';
  }
  return `<nav class="gf-pager" aria-label="頁送り">${links.join(' ')}</nav>`;
}

/**
 * 一覧の HTML を組み立てる。
 *
 * **`noindex` を付ける。** 本人にしか出ない画面であり、検索結果に現れる意味が無い
 * （`src/my-works.ts` と同じ扱い）。**5.8 の「誰が押したかは公開しない」は、
 * クローラに対しても守る。**
 *
 * @param view 表示に必要な値
 * @returns HTML
 */
export function renderLikedWorksPage(view: LikedWorksView): string {
  const cards = renderWorkCards(view.works);
  const body = view.unavailable
    ? // **読めなかったことを、読めたことのように書かない。** 頁送りも出さない
      // （次の頁があるかどうかも分かっていない。押しても何も起きない導線を出さない。4.4）。
      `<p>${UNAVAILABLE_MESSAGE}</p>`
    : cards === ''
      ? // **1 頁目と 2 頁目以降で言うことが違う。** 前者は「まだ押していない」、後者は
        // 「この頁には並ぶものが無い」である（絞り込みで全部落ちた頁がありうる）。
        view.page === 1
        ? `<p>まだいいねした作品がありません。</p>
<p><a href="${PUBLIC_WORKS_PATH}">公開されている作品をさがす</a></p>`
        : `<p>この頁に並ぶ作品がありません。</p>`
      : cards;

  // **欠けている頁にだけ断りを出す**（{@link someHidden}）。**1 頁目で 0 件のときは
  // 出さない**——押していないことと、押したものが隠れていることは別である。
  const hidden = someHidden(view) ? `\n<p class="gf-notice">${HIDDEN_NOTICE}</p>` : '';
  const pager = view.unavailable ? '' : renderPager(view);

  return `${siteHead({ title: 'いいねした作品 - Game Forge', noindex: true })}
<h1>いいねした作品</h1>
<p>あなたがいいねを付けた作品が、押した新しい順に並んでいます。<strong>この一覧はあなたにしか見えません。</strong></p>
<p><a href="${MY_WORKS_PATH}">あなたの作品</a></p>
${body}${hidden}
${pager}
${siteFooter()}`;
}

/**
 * この頁で、絞り込みに落ちた作品があるか。
 *
 * **「1 頁ぶん引いたのに 20 件に届かなかった」ことを、次の頁の有無から導く。**
 * 最後の頁は本来 20 件未満なので、件数だけで判定すると**毎回**断りが出る。
 * **次の頁があるのに 20 件未満なら、落ちた作品がある**（DO からは 21 件返っており、
 * 20 件ぶんの id のうちいくつかが D1 で引けなかった、ということである）。
 *
 * **「次の頁が無い最後の頁で落ちた分」は言わない。** 言うには「DO が何件返したか」を
 * 画面へ渡す必要があり、**画面が DO の件数を知る形にしたくない**（5.8 は画面が DO の形を
 * 知らないことを設計にしている）。**代わりに、落ちた分があることは一度は必ず目に入る**
 * ——落ちた作品を持つ利用者は、いずれかの頁でこの断りを見る。
 *
 * @param view 表示に必要な値
 * @returns 断りを出すなら true
 */
function someHidden(view: LikedWorksView): boolean {
  return view.hasNext && view.works.length < LIKED_WORKS_PER_PAGE;
}

/**
 * 303 See Other を返す。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 一覧を表示する。
 *
 * **未ログインならログインへ送る。** 401 の JSON を返しても、画面を開いた利用者にできる
 * ことは結局ログインなので、そこまでを 1 往復で済ませる（`src/my-works.ts` と同じ扱い）。
 *
 * **Cache API を前段に置かない**（`src/list-cache.ts` を使わない）。載せてよいのは
 * **全員に同じものが出るデータだけ**であり（仕様 2.3.3）、この一覧は利用者ごとに違う。
 * **鍵に利用者 id を入れる形も採らない**——共有キャッシュへ個人の一覧を置くのは、
 * 5.8 の「誰が押したかは公開しない」に対して取りたくない risk である。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showLikedWorks(request: Request, env: Env): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return seeOther(LOGIN_PATH);
  }

  const page = toLikedPageNumber(new URL(request.url).searchParams.get(LIKED_PAGE_PARAM));
  const { works, hasNext, unavailable } = await listLikedWorks(env, session.userId, page);
  return html(renderLikedWorksPage({ works, page, hasNext, unavailable }));
}

/**
 * 「いいねした作品」の経路（5.8 / M9-8 / #340）。
 *
 * `src/app.ts` の経路表へ連結する。**完全一致で登録する**（作品ページの前方一致
 * `/works/` とは別の鍵になる。{@link LIKED_WORKS_PATH}）。
 */
export const likedWorksRoutes: readonly Route[] = [
  { method: 'GET', path: LIKED_WORKS_PATH, handler: showLikedWorks },
];
