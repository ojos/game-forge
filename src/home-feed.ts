/**
 * トップ（`/`）に並べる 4 節の問い合わせ（仕様 2.3.1 / 2.3.3 / #329 / M9-3）。
 *
 * ## なぜ `src/home.ts` と分けるのか
 *
 * トップは **D1 を読む画面になった**（2.3.3）。読み取りの形——件数の上限・索引・
 * Cache API の前段——は**機械で確かめたい対象**であり、画面の組み立てと同じファイルに
 * 混ぜると、検査が HTML を経由してしか触れなくなる。`src/works-list.ts` が引く側を
 * `src/games.ts` に置いているのと同じ分け方である（**SQL を検査から書き写さない**ために、
 * SQL を返す関数を輸出する。`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * ## 3 節は一覧と同じ引き方を借りる
 *
 * 新着・改造された数の順・いいねの多い順は、`src/games.ts` の `listPublishedGames` を
 * **件数 {@link HOME_SECTION_LIMIT} で呼ぶだけ**である。トップ用に SQL を書き起こさない
 * ——そうすると「引く時点で絞る」（`draft` と審査中を除く。5.4 / 8.4）の綴りが 2 本になり、
 * 片方だけが古くなる。**索引も一覧と同じものが効く**（`0019` の 2 本と `0020` の部分索引）。
 *
 * ## 公式サンプルだけは、ここが引く
 *
 * 選び方と、その選び方が読み取りの上限を壊さない形は {@link officialSamplesSql} にある。
 *
 * ## いいねの数は D1 の写しを読む（DO を呼ばない）
 *
 * トップは未ログインの閲覧が大半で、閲覧数で Durable Objects の枠を減らさない（5.8）。
 * 並べ替えも節を出すかどうかの判定も、`games.like_count`（5 分おきに写した数）で行う。
 */
import type { PublicWork, PublicWorkSort } from './games.js';
import { PUBLISHED_STATUS, listPublishedGames, workTagsOf } from './games.js';
import { authorHandleColumnSql } from './handle-sql.js';
import { cachedRows, listCacheKey } from './list-cache.js';
import { reviewVisibleSql } from './reports.js';
import { worksListPath } from './works-list.js';

/**
 * 1 節に並べる件数。
 *
 * **8 件。** 仕様 2.3.3 の条件 1（件数を固定する）の実体で、**節の数 4 とあわせて
 * 「トップ 1 回で 32 行」という見積もりの根拠**になっている（2.3.3 の表）。
 * 一覧の 20 件（`src/works-list.ts` の `WORKS_PER_PAGE`）より少ないのは、1 画面に
 * 4 節が縦に並ぶためである。
 */
export const HOME_SECTION_LIMIT = 8;

/**
 * 公式サンプルの作者として見に行く運営アカウントの上限。
 *
 * **4 人。** 運営アカウントは 1 つだけ立てる運用である（`docs/operator-account.md`。
 * 「運営用の Google アカウントを 1 つ用意し」）。それでも 1 に決め打ちしないのは、
 * **2 つ目が立った日に、片方の作品が黙って消える**形にしたくないためである。
 * 逆に上限を置かないと、印を取り違えて何十人にも立てた日に、この節の読み取りだけが
 * 人数に比例して伸びる（2.3.3 の条件 1）。**「1 ではないが、増えない」**を数で置く。
 */
export const MAX_OPERATOR_ACCOUNTS = 4;

/**
 * 公式サンプルの作者を引く SQL。
 *
 * **専用の部分索引で引く**（`migrations/0023_official_samples_idx.sql` の
 * `users_operator_idx`）。索引が無いと、運営の行を見つけるまで `users` を走査する
 * ——**`limit` は走査を止めない**ので、1 人しか居なければ最後まで読み、**読む行数が
 * 利用者数に比例する**（PR #349 の Copilot code review の指摘）。
 *
 * `0021` は「この列で絞り込む経路は無い」として索引を張らなかったが、**#329 がその経路を
 * 作った。** 前例は `0020` の `users_banned_idx` で、同じ理由・同じ形である。
 *
 * **`order by id` を付ける。** 節に並ぶ順が「運営アカウントの順」で決まるため
 * （{@link listOfficialSamples}）、その順が**実行のたびに変わってはいけない。**
 * 索引が `id` 順に並んでいるので、並べ替えの費用は 1 行も増えない。
 *
 * @returns 束縛パラメータが 1 つ（limit）の SELECT 文
 */
export function operatorIdsSql(): string {
  return 'select id from users where is_operator = 1 order by id limit ?';
}

/**
 * 公式サンプルを引く SQL（作者 1 人ぶん）。
 *
 * # 公式サンプルの選び方は「運営が公開した作品」である（#329 が決めた）
 *
 * issue #329 は `games` に印を持つか `author_id` で引くかを未決のまま残した。
 * **`users.is_operator = 1`**（`migrations/0021_users_operator.sql` の運営フラグ）
 * **が公開した作品**とする。理由は 4 つある。
 *
 * 1. **同じ事実を 2 か所に持たない。** 「これは運営のものである」は 0021 が既に持っている。
 *    `games` に印を足すと、サンプルを 1 本足すたびに 2 か所を揃える運用になる
 * 2. **マイグレーションが要らない。** 印を足す案は `games` への列追加（＝本番への手作業。
 *    `docs/handoff.md` 3 章）を伴う。運営フラグは**既に本番へ適用済み**である（0021）
 * 3. **`author_id` の値をコードへ書き写さない。** 0021 が「導出しない理由」で挙げている
 *    とおり、**本番の行の値を写すと写しは必ず腐る。** 選び方を列に委ねれば、写しは生まれない
 * 4. **運用が増えない。** 運営アカウントで公開すれば、その作品は自動でこの節へ入る
 *
 * **0021 の「表示だけの列であり、権限・日次枠・審査の免除には使わない」は崩していない。**
 * ここで足したのは「どれを並べるか」という表示の判断だけである。
 *
 * # 並びは「生成の新しい順」である（公開日時の順ではない）
 *
 * **これは見た目の好みではなく、読み取りの上限が決めている。** `order by g.published_at desc`
 * にすると、SQLite は並べ替えのための一時 B-tree を作り、**LIMIT を掛ける前に運営の公開作品を
 * 全件読む**（実測。`test/home-feed.test.ts` が実行計画で固定している）。
 * `created_at desc, id desc` は専用の部分索引
 * （`migrations/0023_official_samples_idx.sql` の `games_official_samples_idx`）の列順その
 * ものなので、**索引を順に 8 行読んで止まる。**
 *
 * **公式サンプルは運営が選んだ固定の集合である**（#43 の 10 本）。並びの軸が「生成」か
 * 「公開」かは利用者の判断に効かないので、**上限が固い側を採る。**
 *
 * # 部分索引で引く（0008 の索引では足りない）
 *
 * `0008` の `games_author_id_created_at_idx` でも並びは合うが、**あちらは審査と公開状態の
 * 条件を含まない。** 運営の下書きと、審査で止められた作品が `author_id` の下に並ぶので、
 * **8 件を集めるまでに挟まった数だけ余分に読む。** 運営アカウントは #43 のサンプルを作る
 * 過程で下書きを溜める側であり、その数は 0〜数件には収まらない。`0023` は節が引く条件
 * そのもの（`status = 'published'` と `reviewVisibleSql`）で絞る（`0020` と同じ判断）。
 *
 * # 索引の名前をここへ書かない
 *
 * `indexed by` で名指しすると、索引を張り替えた日に**トップが 500 になる。**
 * 名指ししなくても上の列順で索引が選ばれることは実行計画で確かめてあり、
 * **選ばれなくなったら検査が赤くなる**（名指しは「赤くなる」を「落ちる」に変えるだけである）。
 *
 * @returns 束縛パラメータが 3 つ（author_id / status / limit）の SELECT 文
 */
export function officialSamplesSql(): string {
  // 選ぶ列は `src/games.ts` の `publishedGamesSql` と揃える（同じ `PublicWork` へ落とす）。
  // **`users` を行ごと持ってこない**——`display_name` 1 列だけである（仕様 2.3.6。
  // `email` と `invited_by` がカードへ届く経路を作らない）。
  //
  // 並べ替えに使う `created_at` は選ばない。**運営アカウントをまたいで並べ直さない**
  // （{@link listOfficialSamples} が、アカウントごとの結果を前から詰めるだけである）。
  //
  // **`g.author_id` を選ぶのは作者ページへのリンクのためである**（#330。選ばないと
  // この節だけ作者名がリンクにならない）。`users` から選ぶ列は増えていない。
  //
  // **タグの枠を選ぶのはカードに出すためである**（#376。`publishedGamesSql` と揃える）。
  //
  // **`g.play_count` を選ぶのはカードに出すためである**（#377。`publishedGamesSql` と揃える）。
  return `select g.id, g.title, g.published_at, g.fork_count, g.like_count, g.play_count, g.parent_id,
            g.ogp_state, g.author_id, g.tag1, g.tag2, g.tag3, u.display_name as author_name,
            case when u.avatar_sha256 is null then null else u.avatar_set_at end as author_avatar_set_at,
            ${authorHandleColumnSql('g.author_id')}
       from games g
       left join users u on u.id = g.author_id
      where g.author_id = ? and g.status = ? and ${reviewVisibleSql('g')}
      order by g.created_at desc, g.id desc
      limit ?`;
}

/** `officialSamplesSql` が返す行の形。 */
interface OfficialSampleRow {
  readonly id: string;
  readonly title: string;
  readonly published_at: number | null;
  readonly fork_count: number;
  readonly like_count: number;
  readonly play_count: number;
  readonly parent_id: string | null;
  readonly ogp_state: string | null;
  readonly author_id: string | null;
  readonly tag1: string | null;
  readonly tag2: string | null;
  readonly tag3: string | null;
  readonly author_name: string | null;
  readonly author_avatar_set_at: number | null;
  readonly author_handle: string | null;
}

/**
 * 行を作品カードの入力へ落とす。
 *
 * @param row D1 の行
 * @returns 作品カードの入力
 */
function toPublicWork(row: OfficialSampleRow): PublicWork {
  return {
    id: row.id,
    title: row.title,
    authorName: row.author_name,
    // 作者ページへのリンク（#330）。**欠けている行はリンクにならない**だけである
    // （`src/work-card.ts` の `cardAuthorId`）。
    authorId: row.author_id,
    authorAvatarSetAt: row.author_avatar_set_at,
    // いまのハンドル名（#381）。あれば作者名のリンクが `/@handle` になる。
    authorHandle: row.author_handle,
    publishedAt: row.published_at,
    forkCount: row.fork_count,
    likeCount: row.like_count,
    playCount: row.play_count,
    hasParent: row.parent_id !== null,
    hasShot: row.ogp_state === 'ready',
    // タグ（#376）。語彙に照らして描くのはカードの側である（`src/work-card.ts` の `knownWorkTags`）。
    tags: workTagsOf(row),
  };
}

/**
 * 公式サンプルを引く。
 *
 * # 並びは「運営アカウントの順に、それぞれの中で生成の新しい順」である
 *
 * **全体を生成日時で並べ直さない。** 並べ直すには**全アカウントぶんを読んでから**
 * 切ることになり、読み取りの上限が {@link MAX_OPERATOR_ACCOUNTS} 倍に増える
 * （1 本の SQL に畳んで `author_id in (…)` と書いた場合も同じで、そちらは
 * 一時 B-tree が入る。どちらも実測で確かめた）。
 *
 * **代償はこうである**——運営アカウントが 2 つあるとき、**先のアカウントの古い作品が、
 * 後のアカウントの新しい作品より前に出る。** 意図した振る舞いであり、
 * `test/home-feed.test.ts` が明示的に固定している。
 *
 * **払える代償である。** 公式サンプルは運営が選んだ固定の集合（#43 の 10 本）で、
 * **運用上は 1 アカウントで完結する**（`docs/operator-account.md`）。アカウントが 1 つなら
 * 「運営アカウントの順」は何も意味を持たず、節の中は素直に生成の新しい順になる。
 * 「運営アカウントの順」そのものは `users.id` の昇順である（{@link operatorIdsSql}）
 * ——意味のある順ではないが、**実行のたびに変わらない。**
 *
 * # 残り枠だけを渡す
 *
 * **各アカウントに毎回 8 件を要求して最後に切る形にしない**（PR #349 の Copilot code review
 * の指摘）。1 つ目で 8 件埋まれば 2 つ目は 1 行も引かないし、6 件で埋まれば次に頼むのは
 * 2 件である。**捨てるために読む行が 1 行も出ない。**
 *
 * # 問い合わせの本数
 *
 * 運営アカウントは 1 つだけ立てる運用なので、**実際に出るのは 2 本**（アカウントの一覧
 * ＋ その 1 人ぶん）である。最悪でも 1 + {@link MAX_OPERATOR_ACCOUNTS} 本で、D1 の
 * 1 呼び出しあたり 50 クエリ（5.8）の中に収まる。
 *
 * **足りない分を他の作者で埋めない。** 8 件に届かなければ届かないまま出す
 * （公式サンプルの節に公式でないものを混ぜたら、節の意味が消える）。
 *
 * @param env バインディングと環境変数
 * @param limit 引く最大件数
 * @returns 公式サンプル（運営アカウントの順、その中で生成の新しい順）
 */
export async function listOfficialSamples(
  env: Env,
  limit: number = HOME_SECTION_LIMIT,
): Promise<readonly PublicWork[]> {
  const operators = await env.DB.prepare(operatorIdsSql())
    .bind(MAX_OPERATOR_ACCOUNTS)
    .all<{ id: string }>();

  const works: PublicWork[] = [];
  for (const operator of operators.results) {
    const remaining = limit - works.length;
    // **埋まったら、次のアカウントには問い合わせない。**
    if (remaining <= 0) {
      break;
    }
    const rows = await env.DB.prepare(officialSamplesSql())
      .bind(operator.id, PUBLISHED_STATUS, remaining)
      .all<OfficialSampleRow>();
    works.push(...rows.results.map(toPublicWork));
  }
  return works;
}

/** Cache API へ載せる、トップ 1 枚ぶんのデータ。 */
export interface HomeFeedData {
  /** 公式サンプル（運営が公開した作品）。 */
  readonly official: readonly PublicWork[];
  /** 新着。 */
  readonly recent: readonly PublicWork[];
  /** 改造された数の順。 */
  readonly forked: readonly PublicWork[];
  /** いいねの多い順。 */
  readonly liked: readonly PublicWork[];
}

/**
 * トップのキャッシュの鍵。
 *
 * **一覧（`works`）と別の名前にする。** 一覧の 1 頁目は 21 件引いており
 * （`src/works-list.ts` が「上限より 1 件多く引く」）、**同じ鍵に載せると
 * 件数の違う行が混ざる。**
 *
 * 鍵に件数を入れるのは、{@link HOME_SECTION_LIMIT} を変えた瞬間に**古い件数の
 * 保存物を読まない**ためである（TTL の 60 秒だけ、節が 8 件でなくなる）。
 */
export const HOME_CACHE_KEY = listCacheKey('home', { limit: HOME_SECTION_LIMIT });

/**
 * トップ 1 枚ぶんのデータを引く（Cache API の前段つき。仕様 2.3.3 の条件 3）。
 *
 * **載せるのは HTML ではなくデータである。** 理由は `src/list-cache.ts` の冒頭にある
 * （ヘッダがログイン状態で出し分かれる／`html()` が `no-store` を固定で付ける）。
 *
 * **4 節を 1 本の鍵に載せる。** 節ごとに鍵を分けても読み取りは減らず、
 * **節が増えるたびに「どれかだけ古い」組み合わせが増える**（4 節が別々の時刻の
 * スナップショットになる）。トップは 1 枚の画面なので、1 枚ぶんをまとめて持つ。
 *
 * @param env バインディングと環境変数
 * @returns 4 節ぶんの作品
 */
export async function loadHomeFeed(env: Env): Promise<HomeFeedData> {
  return await cachedRows<HomeFeedData>(HOME_CACHE_KEY, async () => {
    // **直列に引く。** `Promise.all` で並べても D1 の読み取り行数は変わらず、
    // 同時実行数だけが増える（Workers の 1 リクエストあたりのサブリクエスト上限を
    // 余分に使う）。前段にキャッシュがあるので、ここが走るのは 60 秒に 1 回である。
    const official = await listOfficialSamples(env, HOME_SECTION_LIMIT);
    const recent = await listPublishedGames(env, 'recent', HOME_SECTION_LIMIT);
    const forked = await listPublishedGames(env, 'forked', HOME_SECTION_LIMIT);
    const liked = await listPublishedGames(env, 'liked', HOME_SECTION_LIMIT);
    return { official, recent, forked, liked };
  });
}

/**
 * いいねの数を読む。
 *
 * **欠けていたら 0 として読む。** 仕様 5.8（v1.52）が指している穴である——
 * `src/list-cache.ts` は鍵に行の形の版を持たないので、`like_count` を足した配備の
 * 直後 60 秒は、**その列を持たない行がキャッシュから返りうる。** 型が必須であることは
 * 実行時の保証ではない。
 *
 * @param work 作品
 * @returns いいねの数（欠けていれば 0）
 */
function likeCountOf(work: PublicWork): number {
  return typeof work.likeCount === 'number' ? work.likeCount : 0;
}

/** トップに並べる 1 節。 */
export interface HomeSection {
  /** 節の識別子（`id` 属性と検査が使う）。 */
  readonly key: string;
  /** 見出し。 */
  readonly title: string;
  /** 並べる作品。 */
  readonly works: readonly PublicWork[];
  /** 「もっと見る」の行き先。無い節では null。 */
  readonly moreHref: string | null;
}

/**
 * 並べ替えの軸に対応する節の見出し。
 *
 * **綴りの正本は仕様 2.3.1 の `/` の行である**（「公式サンプル・新着・改造された数の順・
 * いいねの多い順を、各 8 件ずつ並べる」）。`src/works-list.ts` の `SORT_LABELS` は
 * 輸出されていないので借りられないが、**一致は `test/home.test.ts` が仕様の本文と
 * 機械照合する**（`TEST_PRODUCT_SPEC`。同じ手を #17 が許可パッケージ一覧で使っている）。
 *
 * `Record` にしてあるので、軸を足して見出しを書き忘れると型の検査で落ちる
 * （`src/works-list.ts` が同じ理由で `Record` にしている）。
 */
export const HOME_SORT_TITLES: Readonly<Record<PublicWorkSort, string>> = {
  recent: '新着',
  forked: '改造された数の順',
  liked: 'いいねの多い順',
  // **トップにプレイ数の節は置かない**（#377。2.3.4 の v1.57 注記「トップは 4 節のまま」）。
  // 見出しは `Record` の型を満たすためだけにあり、{@link homeSections} は使わない。
  played: 'プレイ数の多い順',
};

/** 公式サンプルの節の見出し。**正本は同じく仕様 2.3.1 である。** */
export const OFFICIAL_SECTION_TITLE = '公式サンプル';

/**
 * 4 節を組み立てる。
 *
 * # 空の節を出さない（issue #329 の constraints）
 *
 * **作品が 0 本のときに壊れないこと**は、「節ごと出さない」で満たす。見出しだけが
 * 並ぶ画面は、**出来ていないものを出来ているように見せる**（`src/home.ts` の規律）。
 *
 * # いいねが 1 件も無いときは、いいねの節を出さない
 *
 * **先頭の 1 件を見れば分かる。** `liked` は `like_count desc` で並んでいるので、
 * **先頭が 0 なら全部 0 である**（数えるための読み取りを 1 行も足さない）。
 *
 * # 「もっと見る」は、その節の並べ替えの軸へ送る
 *
 * 3 節は `/works?sort=…`（`src/works-list.ts` の `worksListPath` から組み立てる。
 * **綴りを書き写さない**）。
 *
 * **公式サンプルの節には置かない。** `/works` の 3 軸（2.3.4）はどれも公式サンプルを
 * 絞らないので、送れる先が無い。**行き先が実在しないものは置かない**
 * （2.3.7 / 4.4）。運営の作品だけの一覧が要るなら、行き先は作者ページ
 * （`/users/<id>`。M9-4 / #330）であり、**出来てから足す。**
 *
 * @param feed 引いたデータ
 * @returns 出す節だけを並べた配列（空の節は含まない）
 */
export function homeSections(feed: HomeFeedData): readonly HomeSection[] {
  const sections: HomeSection[] = [
    // `?? []` は古い形の保存物への備えである（{@link likeCountOf} と同じ理由。5.8 の v1.52）。
    { key: 'official', title: OFFICIAL_SECTION_TITLE, works: feed.official ?? [], moreHref: null },
  ];

  for (const sort of ['recent', 'forked', 'liked'] as const) {
    const works = feed[sort] ?? [];
    // **いいねが 1 件も無い節は出さない**（issue #329 / roadmap M9-3）。
    if (sort === 'liked' && (works.length === 0 || likeCountOf(works[0]!) === 0)) {
      continue;
    }
    sections.push({
      key: sort,
      title: HOME_SORT_TITLES[sort],
      works,
      moreHref: worksListPath(sort, 1),
    });
  }

  return sections.filter((section) => section.works.length > 0);
}
