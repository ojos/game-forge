import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_RATE_LIMIT, API_RATE_LIMITER_UNAVAILABLE, RATE_LIMITED_BODY } from '../src/api-rate-limit.js';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import {
  DRAFT_STATUS,
  PUBLISHED_STATUS,
  REMOVED_STATUS,
  toPublicWorkSort,
  toTaggedWorkSort,
} from '../src/games.js';
import { cachedRows, listCacheKey, purgeListCache } from '../src/list-cache.js';
import { workPagePath } from '../src/paths.js';
import { handleListPublicWorks, PUBLIC_WORKS_API_SCOPE } from '../src/public-works-api.js';
import { PUBLIC_WORKS_API_PATH } from '../src/public-works-api-paths.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { CONTENT_SIGNAL } from '../src/robots.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { parseWorkSearch, WORK_SEARCH_FIELD } from '../src/work-search.js';
import { WORK_TAG_FIELD } from '../src/work-tags.js';
import {
  PUBLIC_WORKS_PATH,
  WORKS_PER_PAGE,
  toPageNumber,
  toWorkTagFilter,
  worksSearchCacheKey,
} from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * 公開作品の一覧を機械が読める口（#699 / M19-2 / 仕様 5.13）。
 *
 * **#699 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. 未ログインは 401
 * 2. `/works` と同じ作品が同じ順で返る（**画面の HTML と突き合わせる**。関数を直接比べると、同じ関数を
 *    2 回呼んだだけになる）
 * 3. 審査で止めた作品と下書きが出ない
 * 4. `authorId` が作者の id と一致する
 * 5. 指示文とソースのキーが応答に含まれない
 * 6. 上限を超えると断る（と、数える側を呼べなければ通す）
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-public-works-api';

beforeAll(async () => {
  await applySchema();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/**
 * 利用者を 1 人作る。
 *
 * @param label 表示名
 * @param handle ハンドル名（省略すると決めていない）
 * @returns 利用者の id
 */
async function createUser(label: string, handle: string | null = null): Promise<string> {
  const id = `api-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, label)
    .run();
  if (handle !== null) {
    await env.DB.prepare('insert into handles (handle, user_id, claimed_at) values (?, ?, 1)').bind(handle, id).run();
  }
  return id;
}

/**
 * 公開時刻を払い出す。**必ず「いままでで最も新しい」値を返す**（`test/works-list.test.ts` と同じ理由。
 * 仕込んだ行が新着の 1 頁目の先頭側へ来る）。起点は `test/works-list.test.ts` より先に置く。
 */
let publishedAtSeq = 9_500_000_000;

/** @returns 次の公開時刻 */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/** 仕込みで入れる内部の値（応答に出てはいけないもの）。 */
interface Secrets {
  readonly prompt: string;
  readonly sourceKey: string;
  readonly wasmKey: string;
}

/**
 * 作品を 1 件入れる。**指示文と R2 のキーも入れる**（応答に出ないことを確かめるため）。
 *
 * @param authorId 作者
 * @param overrides 列の指定
 * @returns 作品 id と、入れた内部の値
 */
async function seedGame(
  authorId: string,
  overrides: {
    readonly status?: string;
    readonly title?: string;
    readonly description?: string;
    readonly likeCount?: number;
    readonly reviewState?: string | null;
    readonly tags?: readonly (string | null)[];
  } = {},
): Promise<{ readonly id: string; readonly secrets: Secrets }> {
  const id = crypto.randomUUID();
  const secrets: Secrets = {
    prompt: `指示文-${id}`,
    sourceKey: `games/${id}/source-secret.go`,
    wasmKey: `games/${id}/wasm-secret.wasm`,
  };
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, description, go_version, created_at, generation_state,
        published_at, fork_count, like_count, play_count, ogp_state, review_state,
        prompt, source_key, wasm_key, tag1, tag2, tag3)
     values (?, ?, ?, ?, ?, '', 1, 'ready', ?, 0, ?, 3, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.description ?? '',
      nextPublishedAt(),
      overrides.likeCount ?? 0,
      overrides.reviewState ?? null,
      secrets.prompt,
      secrets.sourceKey,
      secrets.wasmKey,
      overrides.tags?.[0] ?? null,
      overrides.tags?.[1] ?? null,
      overrides.tags?.[2] ?? null,
    )
    .run();
  return { id, secrets };
}

/** @returns セッション cookie を載せたヘッダ */
async function sessionHeaders(userId: string): Promise<Record<string, string>> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return { cookie: buildSessionCookie(token, 3600).split(';')[0]! };
}

/**
 * 画面と口が共有するキャッシュの鍵を捨てる（`src/works-list.ts` の `loadWorksListPage` と同じ鍵）。
 *
 * @param query クエリ文字列（`?` を含む。空なら既定）
 */
async function purgeFor(query: string): Promise<void> {
  const url = new URL(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}${query}`);
  const page = toPageNumber(url.searchParams.get('page'));
  const tag = toWorkTagFilter(url.searchParams.get(WORK_TAG_FIELD));
  const search = parseWorkSearch(url.searchParams.get(WORK_SEARCH_FIELD));
  if (search.kind === 'accepted') {
    await purgeListCache(worksSearchCacheKey(search.key, page, tag));
  } else if (tag === null) {
    await purgeListCache(listCacheKey('works', { sort: toPublicWorkSort(url.searchParams.get('sort')), page }));
  } else {
    const sort = toTaggedWorkSort(url.searchParams.get('sort'));
    await purgeListCache(listCacheKey('works', { sort, page, [WORK_TAG_FIELD]: tag }));
  }
}

/**
 * 口を叩く。**経路表を通す**（ハンドラを直接呼ぶと `src/app.ts` への登録漏れを見逃す）。
 *
 * @param userId 送る利用者（null なら未ログイン）
 * @param query クエリ文字列（`?` を含む。省略可）
 * @param base env（上限の入口を差し替えるとき）
 * @returns レスポンス
 */
async function callApi(userId: string | null, query = '', base: Env = testEnv()): Promise<Response> {
  const headers = userId === null ? {} : await sessionHeaders(userId);
  return await handleAppRequest(new Request(`${APP_ORIGIN}${PUBLIC_WORKS_API_PATH}${query}`, { headers }), base);
}

/**
 * `/works` の画面に並んだ作品の id を、上から順に取り出す。
 *
 * @param query クエリ文字列
 * @returns 作品 id（画面の順）
 */
async function idsOnScreen(query: string): Promise<string[]> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}${query}`, { headers: { accept: 'text/html' } }),
    testEnv(),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const ids: string[] = [];
  for (const matched of body.matchAll(/class="gf-card-link" href="\/works\/([0-9a-f-]{36})"/gu)) {
    ids.push(matched[1]!);
  }
  return ids;
}

/** 口の 1 件（テストで読む分だけ）。 */
interface Item {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly authorId: string | null;
  readonly author: { readonly displayName: string | null; readonly handle: string | null };
  readonly likeCount: number;
  readonly playCount: number;
  readonly forkCount: number;
  readonly publishedAt: number | null;
  readonly links: { readonly page: string; readonly play: string };
}

/** 口の本文。 */
interface Body {
  readonly sort: string;
  readonly tag: string | null;
  readonly q: string | null;
  readonly page: number;
  readonly works: readonly Item[];
  readonly nextPage: number | null;
}

describe('経路（#699）', () => {
  it('経路表に重複と形の崩れが無い', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
  });
});

describe('認証（#699）', () => {
  it('未ログインは 401 で、Content-Signal を付ける', async () => {
    const response = await callApi(null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers.get('content-signal')).toBe(CONTENT_SIGNAL);
  });

  it('退会を始めた利用者も 401', async () => {
    const userId = await createUser('退会中');
    await env.DB.prepare('update users set withdrawal_started_at = 1 where id = ?').bind(userId).run();
    expect((await callApi(userId)).status).toBe(401);
  });
});

describe('/works と同じものを返す（#699）', () => {
  it('並べ替え・タグ・検索・頁送りのそれぞれで、画面と同じ作品が同じ順で返る', async () => {
    const caller = await createUser('読む人');
    const author = await createUser('作者');
    // 2 文字の語は FTS を使わず、公開作品を新しい順に読んで絞る（`src/work-search.ts`）。仕込みの行に確実に当たる。
    const word = 'ψλ';
    for (let i = 0; i < WORKS_PER_PAGE + 3; i += 1) {
      await seedGame(author, {
        title: i % 2 === 0 ? `玉${word}${i}` : `玉${i}`,
        likeCount: (i * 7) % 11,
        tags: i % 3 === 0 ? ['puzzle'] : [],
      });
    }

    for (const query of [
      '',
      '?sort=liked',
      '?sort=forked&page=2',
      '?tag=puzzle',
      `?${WORK_SEARCH_FIELD}=${encodeURIComponent(word)}`,
      '?page=2',
    ]) {
      await purgeFor(query);
      const response = await callApi(caller, query);
      expect(response.status, query).toBe(200);
      const body = (await response.json()) as Body;
      // **口を先に叩き、画面は同じ鍵のキャッシュから読む。** どちらも同じ関数を通ることを、並びの一致で見る。
      expect(body.works.map((work) => work.id), query).toEqual(await idsOnScreen(query));
      expect(body.works.length, query).toBeGreaterThan(0);
    }
  });

  it('頁送りの位置と、実際に使った引数を書き戻す', async () => {
    const caller = await createUser('読む人');
    await purgeFor('?sort=unknown&tag=nope&page=1');
    const response = await callApi(caller, '?sort=unknown&tag=nope&page=1');
    const body = (await response.json()) as Body;
    // 知らない値は `/works` と同じく落とす（400 にしない）。落としたことは書き戻した値で分かる。
    expect(body).toMatchObject({ sort: 'recent', tag: null, q: null, page: 1 });
    expect(body.works.length).toBeLessThanOrEqual(WORKS_PER_PAGE);
    expect(body.nextPage === null || body.nextPage === 2).toBe(true);
  });

  it('断った検索（1 文字だけ）は 400 で、理由を返す', async () => {
    const caller = await createUser('読む人');
    const response = await callApi(caller, `?${WORK_SEARCH_FIELD}=a`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid-query', reason: 'too-short' });
  });
});

describe('出してよいものだけを返す（#699）', () => {
  it('下書き・取り下げ・審査待ちの作品は出ない', async () => {
    const caller = await createUser('読む人');
    const author = await createUser('作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS });
    const removed = await seedGame(author, { status: REMOVED_STATUS });
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED });
    const visible = await seedGame(author);

    await purgeFor('');
    const body = (await (await callApi(caller)).json()) as Body;
    const ids = body.works.map((work) => work.id);
    expect(ids).toContain(visible.id);
    for (const hidden of [draft, removed, queued]) {
      expect(ids).not.toContain(hidden.id);
    }
  });

  it('authorId・作者の表示名とハンドル名・説明・タグ・数・リンクを返す', async () => {
    const caller = await createUser('読む人');
    const handle = `h${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const author = await createUser('作者の名前', handle);
    const { id } = await seedGame(author, {
      title: '赤い玉',
      description: '玉を避ける',
      likeCount: 4,
      tags: ['puzzle', null, null],
    });

    await purgeFor('');
    const response = await callApi(caller);
    expect(response.headers.get('content-signal')).toBe(CONTENT_SIGNAL);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Body;
    const item = body.works.find((work) => work.id === id);
    expect(item).toBeDefined();
    const row = await env.DB.prepare('select published_at from games where id = ?')
      .bind(id)
      .first<{ published_at: number }>();
    expect(item).toEqual({
      id,
      title: '赤い玉',
      description: '玉を避ける',
      tags: ['puzzle'],
      authorId: author,
      author: { displayName: '作者の名前', handle },
      likeCount: 4,
      playCount: 3,
      forkCount: 0,
      publishedAt: row!.published_at,
      links: {
        page: `${APP_ORIGIN}${workPagePath(id)}`,
        play: `https://${env.SANDBOX_HOST}/g/${id}/`,
      },
    });
  });

  it('指示文・ソースと実行物のキーは、値もキーも応答に含まれない', async () => {
    const caller = await createUser('読む人');
    const author = await createUser('作者');
    const { id, secrets } = await seedGame(author);

    await purgeFor('');
    const text = await (await callApi(caller)).text();
    expect(text).toContain(id);
    for (const value of [secrets.prompt, secrets.sourceKey, secrets.wasmKey]) {
      expect(text).not.toContain(value);
    }
    const body = JSON.parse(text) as Body;
    const item = body.works.find((work) => work.id === id)!;
    // **項目の集合を固定する。** `PublicWork` に列が増えても、口へは黙って載らない。
    expect(Object.keys(item).sort()).toEqual(
      [
        'author',
        'authorId',
        'description',
        'forkCount',
        'id',
        'likeCount',
        'links',
        'playCount',
        'publishedAt',
        'tags',
        'title',
      ].sort(),
    );
    for (const key of ['prompt', 'source', 'sourceKey', 'source_key', 'wasmKey', 'wasm_key', 'previewKey']) {
      expect(text).not.toContain(`"${key}"`);
    }
  });
});

describe('キャッシュに残った古い形の行（#699 / #340）', () => {
  it('いいね数・プレイ数・説明が無い（数でない）行は、画面と同じく 0 と空文字で返す', async () => {
    const caller = await createUser('読む人');
    // **一覧のキャッシュの鍵に行の形の版は無い**（`src/list-cache.ts`）。配備の直後 60 秒は、列を選んでいなかった
    // 頃の行がそのまま返る。その行を、口が引くのと同じ鍵へ直接置く（`?page=50` は他のテストの仕込みと競らない）。
    const query = '?sort=recent&page=50';
    const key = listCacheKey('works', { sort: 'recent', page: 50 });
    await purgeListCache(key);
    const id = crypto.randomUUID();
    const oldRows = [
      {
        id,
        title: '古い形',
        authorName: '作者',
        publishedAt: 1,
        forkCount: 0,
        hasParent: false,
        hasShot: false,
        // likeCount / playCount / description / authorId / authorHandle / tags を持たない（または数でない）行
        likeCount: 'x',
      },
    ];
    await cachedRows(key, async () => oldRows);
    try {
      const response = await callApi(caller, query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Body;
      expect(body.works).toHaveLength(1);
      expect(body.works[0]).toMatchObject({
        id,
        likeCount: 0,
        playCount: 0,
        description: '',
        authorId: null,
        author: { displayName: '作者', handle: null },
        tags: [],
      });
    } finally {
      await purgeListCache(key);
    }
  });
});

describe('呼び出しの上限（#699 / 5.13）', () => {
  it('利用者ごとに 60 秒あたり 60 回までで、超えたら 429', async () => {
    const heavy = await createUser('たくさん呼ぶ人');
    const other = await createUser('別の人');
    // **本物の入口（Service binding の RPC → Rate Limiting）を通して数える。** D1 を引かせないため、
    // 上限の判定の後で断られる検索（1 文字）で叩く——数えるのは判定より前である。
    //
    // **窓の境目をまたがないようにする。** Miniflare の Rate Limiting は窓を壁時計に揃えて切る
    // （`floor(now / 60 秒)`）ので、途中で境目を越えると数え直しになり、61 回目が通ってしまう。
    // 窓の残りが 10 秒を切っていれば、次の窓まで待ってから始める。
    const periodMs = API_RATE_LIMIT.periodSeconds * 1000;
    const intoWindow = Date.now() % periodMs;
    if (intoWindow > periodMs - 10_000) {
      await new Promise((resolve) => setTimeout(resolve, periodMs - intoWindow + 200));
    }
    for (let i = 0; i < API_RATE_LIMIT.limit; i += 1) {
      const response = await callApi(heavy, `?${WORK_SEARCH_FIELD}=a`);
      expect(response.status, `${i + 1} 回目`).toBe(400);
    }
    const over = await callApi(heavy, `?${WORK_SEARCH_FIELD}=a`);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual(RATE_LIMITED_BODY);
    expect(over.headers.get('retry-after')).toBe(String(API_RATE_LIMIT.periodSeconds));
    expect(over.headers.get('content-signal')).toBe(CONTENT_SIGNAL);

    // 別の利用者の枠は減っていない。
    expect((await callApi(other, `?${WORK_SEARCH_FIELD}=a`)).status).toBe(400);
  }, 30_000);

  it('上限は認証の後で数える（未ログインは枠を使わず 401）', async () => {
    const calls: string[] = [];
    const limiter = {
      allow: async (key: string) => {
        calls.push(key);
        return true;
      },
    };
    const base = { ...testEnv(), API_RATE_LIMITER: limiter } as unknown as Env;
    expect((await callApi(null, '', base)).status).toBe(401);
    expect(calls).toEqual([]);

    const userId = await createUser('読む人');
    await callApi(userId, `?${WORK_SEARCH_FIELD}=a`, base);
    // 鍵は「口の名前:利用者の id」。
    expect(calls).toEqual([`${PUBLIC_WORKS_API_SCOPE}:${userId}`]);
  });

  it('入口を呼べなかったときは通し（fail-open）、ログに残す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limiter = {
      allow: async () => {
        throw new Error('game-forge-likes に届かない');
      },
    };
    const base = { ...testEnv(), API_RATE_LIMITER: limiter } as unknown as Env;
    const userId = await createUser('読む人');
    const response = await handleListPublicWorks(
      new Request(`${APP_ORIGIN}${PUBLIC_WORKS_API_PATH}`, { headers: await sessionHeaders(userId) }),
      base,
    );
    expect(response.status).toBe(200);
    expect(warn.mock.calls.some(([message]) => String(message).startsWith(API_RATE_LIMITER_UNAVAILABLE))).toBe(true);
    // 鍵（利用者の id）はログに出さない。
    expect(warn.mock.calls.flat().join('\n')).not.toContain(userId);
  });

  it('値（60 秒あたり 60 回）が、いいねの Worker の宣言・テストの注入・仕様と一致する', () => {
    const toml = env.TEST_LIKES_WRANGLER_TOML;
    const block = /\[\[ratelimits\]\]\s*\nname = "API_RATE_LIMIT"\s*\nnamespace_id = "(\d+)"\s*\nsimple = \{ limit = (\d+), period = (\d+) \}/u.exec(
      toml,
    );
    expect(block, 'workers/likes/wrangler.toml の [[ratelimits]]').not.toBeNull();
    expect(Number(block![2])).toBe(API_RATE_LIMIT.limit);
    expect(Number(block![3])).toBe(API_RATE_LIMIT.periodSeconds);
    expect(env.TEST_PRODUCT_SPEC).toContain(
      `利用者の id ごとに **${API_RATE_LIMIT.periodSeconds} 秒あたり ${API_RATE_LIMIT.limit} 回**`,
    );
  });
});
