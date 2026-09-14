import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_STATUS, PUBLISHED_STATUS } from '../src/games.js';
import {
  HOME_CACHE_KEY,
  HOME_SECTION_LIMIT,
  HOME_SORT_TITLES,
  MAX_OPERATOR_ACCOUNTS,
  homeSections,
  listOfficialSamples,
  loadHomeFeed,
  officialSamplesSql,
  operatorIdsSql,
} from '../src/home-feed.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { purgeListCache } from '../src/list-cache.js';
import { handleAppRequest } from '../src/app.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * トップ 4 節の引き方（#329 / M9-3 / 仕様 2.3.3）。
 *
 * **issue #329 の acceptance のうち、読み取りに関わるものをここで押さえる。**
 *
 * 1. **読み取りが「各節 8 件＋審査中の公開作品の数」で頭打ちになり、公開作品の総数に
 *    比例しない**（2.3.3 の v1.51 注記）。**実際の `rows_read` を数えて確かめる**
 *    ——SQL を読んで「上限が付いているから大丈夫」と判断する形では、索引が選ばれ
 *    なかった日に気づけない
 * 2. **公式サンプルの選び方**（運営フラグ。`src/home-feed.ts` が理由を持つ）
 * 3. **いいねが 1 件も無いときに、いいねの節を出さない**
 * 4. **作品が 0 本でも壊れない**
 *
 * **実行計画（`EXPLAIN QUERY PLAN`）はここに置かない。** `0023` の 2 本の部分索引が
 * 実際に使われることは `test/schema-official-samples.test.ts` が見る——**同じ期待値を
 * 2 か所に置くと、片方だけが古くなる。**
 *
 * **Cache API を毎回捨ててから測る。** `caches.default` はテストの間で共有されるので、
 * 捨てないと前のテストが仕込んだ行を読む（`test/works-list.test.ts` と同じ扱い）。
 */

beforeAll(async () => {
  await applySchema();
});

/** `created_at` / `published_at` を払い出す種。**必ず「いままでで最も新しい」値を返す。** */
let stampSeq = 9_500_000_000;

/**
 * 次の時刻を返す。
 *
 * `games` は他のテストとも共有されるため、固定値で仕込むと**先に走ったテストの行が
 * 1 頁目を埋めた瞬間に、あとのテストが自分の行を見失う**（`test/works-list.test.ts` の
 * `nextPublishedAt` と同じ理由）。
 *
 * @returns UNIX 秒（呼ぶたびに 1 秒ずつ新しくなる）
 */
function nextStamp(): number {
  stampSeq += 1;
  return stampSeq;
}

/**
 * 利用者を 1 人用意する。
 *
 * @param options `is_operator` を立てるか
 * @returns 利用者の id
 */
async function seedUser(options: { readonly operator?: boolean } = {}): Promise<string> {
  const id = `feed-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, is_operator)
     values (?, ?, ?, ?, 1, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, `作者 ${id}`, options.operator === true ? 1 : 0)
    .run();
  return id;
}

/**
 * `games` の行を 1 件入れる。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作った作品の id
 */
async function seedGame(
  authorId: string,
  overrides: {
    readonly status?: string;
    readonly title?: string;
    readonly createdAt?: number;
    readonly publishedAt?: number | null;
    readonly forkCount?: number;
    readonly likeCount?: number;
    readonly reviewState?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const stamp = nextStamp();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', ?, 'ready', ?, ?, ?, 'ready', ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.createdAt ?? stamp,
      overrides.publishedAt === undefined ? stamp : overrides.publishedAt,
      overrides.forkCount ?? 0,
      overrides.likeCount ?? 0,
      overrides.reviewState ?? null,
    )
    .run();
  return id;
}

/**
 * このファイルが立てた運営の印を、すべて外す。
 *
 * **`MAX_OPERATOR_ACCOUNTS` の上限があるので、印は溜めたままにできない。** テストの
 * 保存領域はこのファイルの中で積み上がるため、前のテストが立てた印が上限を埋めると、
 * **あとのテストが自分で立てた印を見失う**（実際にそれで赤くなった）。
 *
 * **`feed-` の接頭辞を持つ行だけを触る。** 他のテストファイルも `is_operator` を立てる
 * （`test/work-page.test.ts`）ので、全件を 0 に戻すとそちらを壊しうる。
 */
async function clearOperators(): Promise<void> {
  await env.DB.prepare("update users set is_operator = 0 where id like 'feed-%'").run();
}

/**
 * D1 が読んだ行数を数える env を作る。
 *
 * **`meta.rows_read` をそのまま合計する。** 「上限を渡しているか」を SQL の文字列で
 * 確かめる形にはしない——索引が選ばれなくなれば、`limit` はそのままでも読む行数は
 * 母数に比例する（2.3.3 の条件 2 が守ろうとしているのはまさにそこである）。
 *
 * @returns 差し替えた env と、読んだ行数を返す関数
 */
function countingEnv(): { readonly env: Env; readonly rowsRead: () => number } {
  let total = 0;

  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') {
          return value;
        }
        if (property === 'bind') {
          return (...args: unknown[]) =>
            wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (property === 'all' || property === 'raw' || property === 'run') {
          return async (...args: unknown[]) => {
            const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            )) as { readonly meta?: { readonly rows_read?: number } };
            total += result?.meta?.rows_read ?? 0;
            return result;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });

  const db = new Proxy(env.DB, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'prepare') {
        return (query: string) =>
          wrapStatement((value as (q: string) => D1PreparedStatement).call(target, query));
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return { env: { ...env, DB: db } as unknown as Env, rowsRead: () => total };
}

/**
 * キャッシュを捨ててから 4 節を引く。
 *
 * @param target 使う env
 * @returns 引いたデータ
 */
async function freshFeed(target: Env = env): Promise<Awaited<ReturnType<typeof loadHomeFeed>>> {
  await purgeListCache(HOME_CACHE_KEY);
  return await loadHomeFeed(target);
}

describe('読み取りの上限（仕様 2.3.3 の条件 1 / v1.51 注記）', () => {
  it('公開作品を 6 倍にしても、トップ 1 回が読む行数が増えない', async () => {
    const author = await seedUser();
    const operator = await seedUser({ operator: true });
    for (let count = 0; count < 2; count += 1) {
      await seedGame(operator, { title: '公式サンプル' });
    }
    // 各節が埋まるだけの母数を先に作る（8 件に届いていないと「上限で止まった」ことを
    // 測れない）。**いいねとフォークの数をばらす**——`liked` / `forked` の索引の上を
    // 実際に並べ替えさせるため。
    for (let count = 0; count < 12; count += 1) {
      await seedGame(author, { forkCount: count, likeCount: count });
    }

    const before = countingEnv();
    await freshFeed(before.env);
    const baseline = before.rowsRead();
    // **0 行で緑にならないようにする。** 数えていなければ増えていないのも当然である。
    expect(baseline).toBeGreaterThan(0);

    // 母数を 6 倍にする。**節の上限が効いていれば読み取りは 1 行も増えない。**
    for (let count = 0; count < 60; count += 1) {
      await seedGame(author, { forkCount: count, likeCount: count });
    }

    const after = countingEnv();
    await freshFeed(after.env);
    expect(after.rowsRead(), `母数 14 件で ${baseline} 行 → 74 件で ${after.rowsRead()} 行`).toBe(
      baseline,
    );
  });

  it('増えるのは審査中の件数の分だけである（2.3.3 の v1.51 注記）', async () => {
    // **注記が言っている 2 つ目の項が実在することを測る。** `0019` の 2 本は審査の
    // 可視条件を含まないので、並びの上位に審査中の作品が挟まるとその数だけ余分に読む。
    // **比例するのは審査中の件数であって、公開作品の総数ではない**（上のテスト）。
    const author = await seedUser();
    for (let count = 0; count < HOME_SECTION_LIMIT; count += 1) {
      await seedGame(author);
    }

    const before = countingEnv();
    await freshFeed(before.env);
    const baseline = before.rowsRead();

    // **並びの先頭側へ挟む**（払い出しが常に「いままでで最も新しい」値を返す）。
    const queued = 6;
    for (let count = 0; count < queued; count += 1) {
      await seedGame(author, { reviewState: REVIEW_QUEUED, forkCount: 10_000, likeCount: 10_000 });
    }

    const after = countingEnv();
    const feed = await freshFeed(after.env);
    const delta = after.rowsRead() - baseline;

    // 審査中の作品は 1 件も出ない（引く時点で除いている。8.4）。
    expect(feed.recent.length).toBe(HOME_SECTION_LIMIT);
    expect(delta, `審査中 ${queued} 件で ${delta} 行増えた`).toBeGreaterThan(0);
    // **上限は「件数の定数倍」である。** 定数は実測から置いた天井で、意味を持つのは
    // 「件数に対して定数倍で収まる」ことだけである（母数への比例が無いこと）。
    expect(delta, `審査中 ${queued} 件で ${delta} 行増えた`).toBeLessThanOrEqual(queued * 8);
  });

  it('運営の下書きと審査中の行を増やしても、読み取りが増えない（0023 の部分索引）', async () => {
    // **`0008` の `games_author_id_created_at_idx` では足りないことの検査である。**
    // あちらは公開状態も審査の可視条件も含まないので、運営の下書きと審査で止めた作品が
    // `author_id` の下に並び、**8 件を集めるまでに挟まった数だけ余分に読む。**
    // `0023` の部分索引は節が引く条件そのもので絞るので、**1 行も増えない。**
    // **測るのは公式サンプルの節だけである。** 4 節まとめて測ると、審査中の作品が
    // 新着の索引（`0019` は審査の可視条件を含まない）へ挟まった分が混ざり、
    // **どちらの索引の話なのか分からなくなる**（実際にそれで 40 行増えて赤くなった。
    // あちらは 2.3.3 の v1.51 注記が認めている項で、別のテストが測っている）。
    await clearOperators();
    const operator = await seedUser({ operator: true });
    for (let count = 0; count < HOME_SECTION_LIMIT; count += 1) {
      await seedGame(operator, { title: '公式サンプル' });
    }

    const before = countingEnv();
    await listOfficialSamples(before.env);
    const baseline = before.rowsRead();
    expect(baseline).toBeGreaterThan(0);

    // **並びの上位へ挟む**（払い出しが常に「いままでで最も新しい」値を返す）。
    for (let count = 0; count < 40; count += 1) {
      await seedGame(operator, { status: DRAFT_STATUS });
      await seedGame(operator, { reviewState: REVIEW_QUEUED });
    }

    const after = countingEnv();
    const works = await listOfficialSamples(after.env);
    expect(works.length).toBe(HOME_SECTION_LIMIT);
    expect(
      after.rowsRead(),
      `下書き 40 件・審査中 40 件を足す前 ${baseline} 行 → 後 ${after.rowsRead()} 行`,
    ).toBe(baseline);
  });

  it('枠が埋まったら、次の運営アカウントには問い合わせない', async () => {
    // **捨てるために読む行を 1 行も出さない**（PR #349 の Copilot code review の指摘）。
    // 毎回 8 件を要求して最後に切る形だと、2 つ目のアカウントからも 8 件読んでしまう。
    await clearOperators();
    const first = await seedUser({ operator: true });
    const second = await seedUser({ operator: true });
    // **`users.id` の昇順が「運営アカウントの順」である**（`operatorIdsSql`）。
    // 先に来るほうへ枠を埋めるだけの作品を入れる。
    const [filler, starved] = first < second ? [first, second] : [second, first];
    for (let count = 0; count < HOME_SECTION_LIMIT; count += 1) {
      await seedGame(filler);
    }
    const hidden = await seedGame(starved);

    let asked = 0;
    const watched = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property === 'prepare') {
            return (query: string) => {
              if (query.includes('g.author_id = ?')) {
                asked += 1;
              }
              return (value as (q: string) => D1PreparedStatement).call(target, query);
            };
          }
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    } as unknown as Env;

    const works = await listOfficialSamples(watched);
    expect(works.length).toBe(HOME_SECTION_LIMIT);
    expect(works.map((work) => work.id)).not.toContain(hidden);
    expect(asked, '公式サンプルの問い合わせの本数').toBe(1);
  });

  it('先のアカウントが埋めきれないとき、後のアカウントへ渡すのは残り枠だけである', async () => {
    // **上のテストだけでは足りない**（1 つ目で埋まる場合しか見ていないので、各アカウントへ
    // 毎回 8 件を要求する実装でも緑になる。実際に変異 N4 が素通りした）。
    // **先のアカウントが 3 件しか持たない状況を作る**——残り枠を渡していなければ、
    // 後のアカウントから 8 件読んで **合計 11 件**になる。
    await clearOperators();
    const one = await seedUser({ operator: true });
    const other = await seedUser({ operator: true });
    const [shortAccount, richAccount] = one < other ? [one, other] : [other, one];

    const short = 3;
    for (let count = 0; count < short; count += 1) {
      await seedGame(shortAccount);
    }
    for (let count = 0; count < HOME_SECTION_LIMIT + 2; count += 1) {
      await seedGame(richAccount);
    }

    const counting = countingEnv();
    const works = await listOfficialSamples(counting.env);
    // **枠を 1 件も超えない。**
    expect(works.length).toBe(HOME_SECTION_LIMIT);
    // 先のアカウントの 3 件が全部入り、残り 5 件が後のアカウントから来ている。
    expect(works.slice(0, short).every((work) => work.authorName !== null)).toBe(true);
    // 読み取りも枠ぶんで止まっている（作品 8 行 ＋ 作者名の引き当て ＋ アカウントの一覧）。
    expect(
      counting.rowsRead(),
      `公式サンプルの読み取り ${counting.rowsRead()} 行`,
    ).toBeLessThanOrEqual(HOME_SECTION_LIMIT * 2 + MAX_OPERATOR_ACCOUNTS);
  });

  it('1 節が引くのは 8 件までである', async () => {
    const author = await seedUser();
    for (let count = 0; count < HOME_SECTION_LIMIT + 5; count += 1) {
      await seedGame(author, { forkCount: count + 1, likeCount: count + 1 });
    }

    const feed = await freshFeed();
    expect(feed.recent.length).toBe(HOME_SECTION_LIMIT);
    expect(feed.forked.length).toBe(HOME_SECTION_LIMIT);
    expect(feed.liked.length).toBe(HOME_SECTION_LIMIT);
    expect(feed.official.length).toBeLessThanOrEqual(HOME_SECTION_LIMIT);
  });

  it('運営アカウントを引く本数に上限がある', () => {
    // 印を取り違えて何十人にも立てた日に、この節だけが人数に比例して伸びる形にしない。
    expect(operatorIdsSql()).toContain('limit ?');
    expect(MAX_OPERATOR_ACCOUNTS).toBeGreaterThan(1);
    expect(MAX_OPERATOR_ACCOUNTS).toBeLessThanOrEqual(8);
  });
});

describe('公式サンプルの選び方（#329 が決めた: 運営フラグ）', () => {
  it('運営が公開した作品だけが入る', async () => {
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const ordinary = await seedUser();
    const official = await seedGame(operator);
    const theirs = await seedGame(ordinary);

    const works = await listOfficialSamples(env);
    const ids = works.map((work) => work.id);
    expect(ids).toContain(official);
    expect(ids).not.toContain(theirs);
  });

  it('運営の draft と、審査で止めた作品は入らない', async () => {
    // **絞り込みは引く時点で行う**（5.4 / 8.4。#152 の規律）。運営だからといって
    // `draft` の URL が漏れてよいわけではない。
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const draft = await seedGame(operator, { status: DRAFT_STATUS });
    const queued = await seedGame(operator, { reviewState: REVIEW_QUEUED });
    const visible = await seedGame(operator);

    const ids = (await listOfficialSamples(env)).map((work) => work.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(queued);
  });

  it('運営アカウントが 2 つあると、どちらの作品も入る', async () => {
    // 1 に決め打ちすると、2 つ目が立った日に片方の作品が黙って消える。
    await clearOperators();
    const first = await seedUser({ operator: true });
    const second = await seedUser({ operator: true });
    const fromFirst = await seedGame(first);
    const fromSecond = await seedGame(second);

    const ids = (await listOfficialSamples(env, HOME_SECTION_LIMIT)).map((work) => work.id);
    expect(ids).toContain(fromFirst);
    expect(ids).toContain(fromSecond);
  });

  it('並びは「運営アカウントの順 → その中で生成の新しい順」である', async () => {
    // **意図した振る舞いをここで固定する**（PR #349 の Copilot code review の 1 件目）。
    // 全体を生成日時で並べ直さないので、**先のアカウントの古い作品が、後のアカウントの
    // 新しい作品より前に出る。** 並べ直すと全アカウントぶんを読んでから切ることになり、
    // 読み取りの上限が `MAX_OPERATOR_ACCOUNTS` 倍に増える（`src/home-feed.ts`）。
    await clearOperators();
    const a = await seedUser({ operator: true });
    const b = await seedUser({ operator: true });
    // 「運営アカウントの順」は `users.id` の昇順である（`operatorIdsSql` の `order by id`）。
    const [firstAccount, secondAccount] = a < b ? [a, b] : [b, a];

    // **先のアカウントに「古い」作品、後のアカウントに「新しい」作品を入れる**
    // （払い出しは呼ぶたびに新しくなるので、順に入れればこの関係になる）。
    const olderOfFirst = await seedGame(firstAccount, { title: '先のアカウントの古い作品' });
    const newerOfSecond = await seedGame(secondAccount, { title: '後のアカウントの新しい作品' });

    const ids = (await listOfficialSamples(env)).map((work) => work.id);
    expect(ids).toContain(olderOfFirst);
    expect(ids).toContain(newerOfSecond);
    // **生成日時では後のほうが新しいのに、先のアカウントのほうが前に出る。**
    expect(ids.indexOf(olderOfFirst)).toBeLessThan(ids.indexOf(newerOfSecond));

    // 1 つのアカウントの中では、生成の新しい順である。
    const newerOfFirst = await seedGame(firstAccount, { title: '先のアカウントの新しい作品' });
    const inside = (await listOfficialSamples(env)).map((work) => work.id);
    expect(inside.indexOf(newerOfFirst)).toBeLessThan(inside.indexOf(olderOfFirst));
  });

  it('運営アカウントの順が、実行のたびに変わらない', () => {
    // 節に並ぶ順がアカウントの順で決まるので、**その順が不定であってはいけない。**
    expect(operatorIdsSql()).toContain('order by id');
  });

  it('公式サンプルが足りなくても、他の作者で埋めない', async () => {
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const ordinary = await seedUser();
    await seedGame(operator);
    for (let count = 0; count < 10; count += 1) {
      await seedGame(ordinary);
    }

    const works = await listOfficialSamples(env);
    expect(works.length).toBeLessThan(HOME_SECTION_LIMIT);
  });

  it('選び方は列であって、名前でも id の写しでもない', () => {
    // 5.9「なりすましは名前で見分けない」。表示名で選ぶ実装は、表示名を変えられる
    // ようになった時点で誰でも「運営」と名乗れる（`migrations/0021_users_operator.sql`）。
    // **本番の `users.id` をコードへ書き写さない**ことも、ここで固定する。
    expect(operatorIdsSql()).toContain('is_operator = 1');
    expect(operatorIdsSql()).not.toContain('display_name');
    expect(officialSamplesSql()).toContain('g.author_id = ?');
  });
});

describe('節の出し入れ（issue #329 の constraints）', () => {
  it('作品が 0 本なら節を 1 つも出さない', () => {
    expect(homeSections({ official: [], recent: [], forked: [], liked: [] })).toEqual([]);
  });

  it('いいねが 1 件も無いと、いいねの節が出ない', async () => {
    const author = await seedUser();
    for (let count = 0; count < 3; count += 1) {
      await seedGame(author, { likeCount: 0, forkCount: 1 });
    }

    const feed = await freshFeed();
    // 母数には `liked` の行がある（`like_count = 0` の作品は並ぶ）。**節を出すかどうかは
    // 先頭の 1 件で決める**——`like_count desc` なので先頭が 0 なら全部 0 である。
    expect(feed.liked.length).toBeGreaterThan(0);
    const keys = homeSections({ ...feed, liked: feed.liked.map((w) => ({ ...w, likeCount: 0 })) }).map(
      (section) => section.key,
    );
    expect(keys).not.toContain('liked');
    expect(keys).toContain('recent');
  });

  it('いいねが 1 件でもあれば、いいねの節が出る', async () => {
    const author = await seedUser();
    // **他のテストが仕込んだ行に押し出されない数にする**（保存領域はこのファイルの中で
    // 積み上がる）。確かめたいのは「1 件でもあれば節が出る」ことで、順位ではない。
    const liked = await seedGame(author, { likeCount: 1_000_000 });

    const feed = await freshFeed();
    const sections = homeSections(feed);
    const section = sections.find((candidate) => candidate.key === 'liked');
    expect(section, 'いいねの節').toBeDefined();
    expect(section!.title).toBe(HOME_SORT_TITLES.liked);
    expect(section!.works.map((work) => work.id)).toContain(liked);
  });

  it('プレイ数の節は置かない（#377。トップは 4 節のまま）', () => {
    const work = {
      id: 'x',
      title: 't',
      authorName: null,
      publishedAt: 1,
      forkCount: 0,
      likeCount: 3,
      playCount: 1_000,
      hasParent: false,
      hasShot: false,
    } as const;
    const sections = homeSections({ official: [work], recent: [work], forked: [work], liked: [work] });
    expect(sections.map((section) => section.key)).not.toContain('played');
    expect(sections).toHaveLength(4);
  });

  it('「もっと見る」は軸ごとの一覧へ送り、公式サンプルには置かない', () => {
    const work = {
      id: 'x',
      title: 't',
      authorName: null,
      publishedAt: 1,
      forkCount: 0,
      likeCount: 3,
      hasParent: false,
      hasShot: false,
    } as const;
    const sections = homeSections({
      official: [work],
      recent: [work],
      forked: [work],
      liked: [work],
    });

    expect(sections.map((section) => section.key)).toEqual([
      'official',
      'recent',
      'forked',
      'liked',
    ]);
    // 公式サンプルを絞る軸は `/works` に無い（2.3.4 の 3 軸はどれも絞らない）。
    // **行き先が実在しないリンクを置かない**（2.3.7 / 4.4）。
    expect(sections[0]!.moreHref).toBeNull();
    expect(sections[1]!.moreHref).toContain('sort=recent');
    expect(sections[2]!.moreHref).toContain('sort=forked');
    expect(sections[3]!.moreHref).toContain('sort=liked');
  });

  it('いいねの数が欠けた保存物でも落ちない（5.8 の v1.52）', () => {
    // `src/list-cache.ts` は鍵に行の形の版を持たない。列を足した配備の直後 60 秒は、
    // その列を持たない行が返りうる。**型が必須であることは実行時の保証ではない。**
    const broken = {
      id: 'x',
      title: 't',
      authorName: null,
      publishedAt: 1,
      forkCount: 0,
      hasParent: false,
      hasShot: false,
    } as unknown as Parameters<typeof homeSections>[0]['liked'][number];
    const sections = homeSections({ official: [], recent: [], forked: [], liked: [broken] });
    expect(sections.map((section) => section.key)).toEqual([]);
  });
});

describe('Cache API の前段（仕様 2.3.3 の条件 3）', () => {
  it('2 回目は D1 を引き直さず、捨てれば引き直す', async () => {
    const author = await seedUser();
    const before = await seedGame(author);
    await purgeListCache(HOME_CACHE_KEY);

    const first = await loadHomeFeed(env);
    expect(first.recent.map((work) => work.id)).toContain(before);

    const after = await seedGame(author);
    const counting = countingEnv();
    const cached = await loadHomeFeed(counting.env);
    // **キャッシュから返っていれば D1 を 1 行も読まない。**
    expect(counting.rowsRead()).toBe(0);
    expect(cached.recent.map((work) => work.id)).not.toContain(after);

    expect(await purgeListCache(HOME_CACHE_KEY)).toBe(true);
    const fresh = await loadHomeFeed(env);
    expect(fresh.recent.map((work) => work.id)).toContain(after);
  });

  it('鍵が一覧と別である', () => {
    // 一覧の 1 頁目は 21 件引いている（`src/works-list.ts` が 1 件多く引く）。
    // 同じ鍵に載せると件数の違う行が混ざる。
    expect(HOME_CACHE_KEY).toContain('/home?');
    expect(HOME_CACHE_KEY).toContain(`limit=${HOME_SECTION_LIMIT}`);
  });
});

describe('公式サンプルの作者名も作者ページへのリンクになる（#330 / PR #350）', () => {
  it('`officialSamplesSql` が `author_id` を選び、節が `authorId` を運ぶ', async () => {
    // **この節だけが `src/games.ts` の `listPublishedGames` を通らない。** 選び忘れると、
    // **公式サンプルの節だけ作者名がリンクにならない**（他の 3 節はリンクになる）。
    // 画面は正しく出るので、引く側で機械判定する（PR #350 の Copilot の指摘）。
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const sample = await seedGame(operator, { title: '公式サンプル' });

    const feed = await freshFeed();
    const found = feed.official.find((work) => work.id === sample);
    expect(found, '公式サンプルの節に仕込んだ作品が無い').toBeDefined();
    expect(found!.authorId).toBe(operator);
    // 綴りの側も見る（選ばなくなったら赤くなる）。
    expect(officialSamplesSql()).toContain('g.author_id');
  });

  it('トップの画面まで通してもリンクになっている（公式サンプルの節の中で見る）', async () => {
    // **引く側だけでは足りない。** カードが `authorId` を無視する形へ変わったら、ここで落ちる。
    //
    // **本文全体を探してはいけない。** 運営の公開作品は新着の節にも並び、そちらは
    // `listPublishedGames`（`author_id` を選んでいる）を通るので、**全体を探すと
    // 公式サンプルの節が選び忘れていても緑になる**（この it を書いた時点で実際に
    // そうなっていた）。**節の中だけを切り出して見る。**
    await clearOperators();
    const operator = await seedUser({ operator: true });
    await seedGame(operator, { title: '公式サンプル（画面）' });

    await purgeListCache(HOME_CACHE_KEY);
    const body = await (await handleAppRequest(new Request(`https://${env.APP_HOST}/`), env)).text();

    // 公式サンプルの節（`src/home.ts` が `gf-home-<key>` の見出し id で結ぶ）を切り出す。
    const start = body.indexOf('id="gf-home-official"');
    expect(start, 'トップに公式サンプルの節が無い').toBeGreaterThan(-1);
    const end = body.indexOf('</section>', start);
    expect(end, '公式サンプルの節が閉じていない').toBeGreaterThan(start);
    const section = body.slice(start, end);

    expect(section).toContain('公式サンプル（画面）');
    expect(section).toContain(`<a class="gf-card-author gf-link-quiet" href="${authorPagePath(operator)}">`);
  });
});

describe('公式サンプルのカードにもタグが出る（#376 / 仕様 2.3.6）', () => {
  it('公式サンプルの SQL がタグの枠を選び、PublicWork にタグが載る', async () => {
    // **公式サンプルは `listPublishedGames` を通らない**（このモジュールが自前で引く）。選び忘れると、
    // トップの公式サンプルの節だけカードからタグが消える。
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const official = await seedGame(operator);
    await env.DB.prepare("update games set tag1 = 'action', tag3 = 'other' where id = ?")
      .bind(official)
      .run();

    const works = await listOfficialSamples(env);
    expect(works.find((work) => work.id === official)?.tags).toEqual(['action', 'other']);
    expect(officialSamplesSql()).toContain('g.tag1, g.tag2, g.tag3');
  });

  it('トップの 3 節（一覧と同じ引き方）にもタグが載る', async () => {
    const author = await seedUser();
    const game = await seedGame(author);
    await env.DB.prepare("update games set tag1 = 'shooting' where id = ?").bind(game).run();

    await purgeListCache(HOME_CACHE_KEY);
    const feed = await loadHomeFeed(env);
    expect(feed.recent.find((work) => work.id === game)?.tags).toEqual(['shooting']);
  });
});

describe('公式サンプルのカードにもプレイ数が出る（#377 / 仕様 2.3.6）', () => {
  it('公式サンプルの SQL が play_count を選び、PublicWork にプレイ数が載る', async () => {
    // **公式サンプルは `listPublishedGames` を通らない**（選び忘れると、この節だけ数が消える）。
    await clearOperators();
    const operator = await seedUser({ operator: true });
    const official = await seedGame(operator);
    await env.DB.prepare('update games set play_count = 77 where id = ?').bind(official).run();

    const works = await listOfficialSamples(env);
    expect(works.find((work) => work.id === official)?.playCount).toBe(77);
    expect(officialSamplesSql()).toContain('g.play_count');
  });
});
