import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import type { PublicWork } from '../src/games.js';
import { PUBLISHED_STATUS, listPublishedGames, listTaggedGames, publishedGamesSql } from '../src/games.js';
import { changeHandle } from '../src/handle.js';
import { handlePagePath } from '../src/handle-paths.js';
import { listOfficialSamples, operatorIdsSql } from '../src/home-feed.js';
import { listLikedWorks } from '../src/liked-works.js';
import { changeLike } from '../src/likes.js';
import { authorPagePath, authorPagePathFor } from '../src/users-page-paths.js';
import { renderWorkCard } from '../src/work-card.js';
import { workPagePath } from '../src/work-page.js';
import { listSearchedGames, parseWorkSearch } from '../src/work-search.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者名のリンクを `/@handle` へ向ける（#381 / 仕様 5.10 / 2.3.6）。
 *
 * **`PublicWork` を組み立てる経路をすべて見る**——一覧（絞り込まない・タグで絞る）・トップの公式サンプル・
 * いいねした作品・検索・作者ページ（`test/handle-page.test.ts`）、それに作品ページ。**1 つでも漏れると、
 * その面の作者名だけが `/users/<id>` を指す**（301 で着くので壊れては見えない——だから行き先の綴りで見る）。
 */

beforeAll(async () => {
  await applySchema();
});

/** 固定の時刻（UNIX 秒）。 */
const NOW = 1_970_000_000;

/** 公開時刻（**新着順の先頭へ来るよう、他のテストより新しくする**）。 */
let publishedAtSeq = 9_950_000_000;

/**
 * 作者と、ハンドル名と、公開作品 1 本を用意する。
 *
 * @param handle 作者のハンドル名（決めないなら null）
 * @returns 作者の id と作品の id
 */
async function seed(handle: string | null): Promise<{ userId: string; gameId: string }> {
  const userId = `links-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(userId, `sub-${userId}`, `${userId}@example.test`, 'リンクの作者')
    .run();
  if (handle !== null) {
    expect((await changeHandle(env.DB, userId, handle, NOW)).ok).toBe(true);
  }
  const gameId = crypto.randomUUID();
  publishedAtSeq += 1;
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state, published_at,
                        ogp_state, tag1)
     values (?, ?, ?, ?, '', 1, 'ready', ?, 'ready', 'puzzle')`,
  )
    .bind(gameId, userId, PUBLISHED_STATUS, `作者リンク検査の流星群${gameId.slice(0, 8)}`, publishedAtSeq)
    .run();
  return { userId, gameId };
}

/**
 * 衝突しないハンドル名を作る。
 *
 * @returns ハンドル名
 */
function uniqueHandle(): string {
  return `link${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 運営アカウントの一覧だけを差し替えた env（公式サンプルの節を、`is_operator` を立てずに引くため）。
 *
 * **`users.is_operator` は立てない**——表はテストファイルをまたいで共有され、トップの節を見る別のテストの
 * 前提（運営アカウントの数と順）を崩す。
 *
 * @param operatorId 運営アカウントとして返す利用者 id
 * @returns 差し替えた env
 */
function envWithOperator(operatorId: string): Env {
  const db = new Proxy(env.DB, {
    get(target, property, receiver) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (sql: string): D1PreparedStatement => {
        if (sql !== operatorIdsSql()) {
          return target.prepare(sql);
        }
        // 呼び出し側が件数の上限を束縛するので、束縛を差し替えた文を返す。
        const statement = target.prepare('select ? as id');
        return new Proxy(statement, {
          get(inner, name, innerReceiver) {
            if (name === 'bind') {
              return () => inner.bind(operatorId);
            }
            const value = Reflect.get(inner, name, innerReceiver) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
          },
        });
      };
    },
  });
  return { ...env, DB: db };
}

describe('PublicWork を組み立てる経路は、作者のいまのハンドル名を運ぶ', () => {
  it('絞り込まない一覧・タグで絞る一覧・公式サンプル・いいねした作品', async () => {
    const handle = uniqueHandle();
    const { userId, gameId } = await seed(handle);
    const find = (works: readonly PublicWork[]): PublicWork | undefined => works.find((work) => work.id === gameId);

    expect(find(await listPublishedGames(env, 'recent', 5))?.authorHandle).toBe(handle);
    expect(find(await listTaggedGames(env, 'puzzle', 'recent', 5))?.authorHandle).toBe(handle);
    expect(find(await listOfficialSamples(envWithOperator(userId)))?.authorHandle).toBe(handle);

    const liker = `links-liker-${crypto.randomUUID()}`;
    await env.DB.prepare(
      'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
    )
      .bind(liker, `sub-${liker}`, `${liker}@example.test`, 'いいねした人')
      .run();
    expect(await changeLike(env, 'like', liker, gameId, NOW)).toBe('liked');
    expect(find((await listLikedWorks(env, liker, 1)).works)?.authorHandle).toBe(handle);
  });

  it('検索の結果も、作者のいまのハンドル名を持つ', async () => {
    const handle = uniqueHandle();
    const { gameId } = await seed(handle);
    const search = parseWorkSearch(`流星群${gameId.slice(0, 8)}`);
    expect(search.kind).toBe('accepted');
    if (search.kind !== 'accepted') {
      return;
    }
    const works = await listSearchedGames(env, search, null, 20, 0);
    expect(works.find((work) => work.id === gameId)?.authorHandle).toBe(handle);
  });

  it('ハンドル名を決めていない作者は null（`/users/<id>` へリンクする）', async () => {
    const { gameId } = await seed(null);
    const rows = await env.DB.prepare(publishedGamesSql('recent'))
      .bind(PUBLISHED_STATUS, 5, 0)
      .all<{ id: string; author_handle: string | null }>();
    expect(rows.results.find((row) => row.id === gameId)?.author_handle).toBeNull();
  });
});

describe('作品カードの作者名のリンク', () => {
  /** カードの入力。 */
  const base: PublicWork = {
    id: '00000000-0000-4000-8000-000000000381',
    title: '題名',
    authorName: '作者',
    authorId: 'user-381',
    publishedAt: 1,
    forkCount: 0,
    likeCount: 0,
    hasParent: false,
    hasShot: false,
  };

  it('ハンドル名があれば `/@handle`、無い・欠けている・形が崩れていれば `/users/<id>`', () => {
    expect(renderWorkCard({ ...base, authorHandle: 'someone' })).toContain(
      `<a class="gf-card-author gf-link-quiet" href="${handlePagePath('someone')}">`,
    );
    for (const broken of [null, undefined, '', 'Upper', 'a"b', 42, '../x']) {
      const card = renderWorkCard({ ...base, authorHandle: broken as unknown as string | null });
      expect(card, String(broken)).toContain(`<a class="gf-card-author gf-link-quiet" href="${authorPagePath('user-381')}">`);
    }
    expect(authorPagePathFor('user-381', 'someone')).toBe('/@someone');
  });
});

describe('作品ページの作者名のリンク', () => {
  it('公開済みの作品ページは、作者のハンドル名があれば `/@handle` を指す', async () => {
    const handle = uniqueHandle();
    const { userId, gameId } = await seed(handle);
    const response = await handleAppRequest(
      new Request(`https://${env.APP_HOST}${workPagePath(gameId)}`),
      env,
    );
    const body = await response.text();
    expect(body).toContain(`<a class="gf-author-link" href="${handlePagePath(handle)}">`);
    expect(body).not.toContain(`href="${authorPagePath(userId)}"`);
  });
});
