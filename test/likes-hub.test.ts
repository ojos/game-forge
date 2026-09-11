import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as RpcDurableObject } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_STATUS } from '../src/games.js';
import likesWorker from '../workers/likes/src/index.js';
import {
  DAILY_OPERATION_LIMIT,
  LikeHub,
  MAX_GAMES_PER_SYNC,
  SYNC_INTERVAL_MS,
  jstDayKey,
} from '../workers/likes/src/hub.js';
import { applySchema } from './helpers/schema.js';

/**
 * いいねの正本（`workers/likes/src/hub.ts`。#339 / 5.8）。**DO の中から確かめる。**
 *
 * #339 の acceptance のうち、DO が持つものを機械判定できる形へ落とす。
 *
 * - 二重に押しても数が 1 のまま
 * - 101 回目の操作が断られ、**DO に書き込まれない**（SQLite が数えた書き込み行数で見る）
 * - 同期のあと `like_count` が DO の実数と一致する（**加算ではなく上書き**）
 * - BAN した利用者のいいねが同期後に数から外れる（解除すれば戻る）
 *
 * **DO はテストごとに別の名前で作る。** 窓口は 1 個（`LIKE_HUB_NAME`）に集めるが、
 * ここで確かめたいのは DO そのものの振る舞いで、他のテストの行が混ざると数が読めない。
 */

beforeAll(async () => {
  await applySchema();
});

/** 固定の時刻（2026-09-11 12:00:00 JST）。日付の境界を読みやすくするために使う。 */
const NOON_JST = Date.UTC(2026, 8, 11, 3, 0, 0) / 1000;

/**
 * テスト専用の DO を作る。
 *
 * @returns stub
 */
function freshHub(): DurableObjectStub<LikeHub> {
  return (env.LIKE_HUB as unknown as DurableObjectNamespace<LikeHub>).getByName(
    `test-${crypto.randomUUID()}`,
  );
}

/**
 * `runInDurableObject` を `LikeHub` の型で使う。
 *
 * **型を当て直すだけである。** `cloudflare:test` の型は、DO の env がテストの env
 * （`Cloudflare.Env`）と同じ形であることを求めるが、`LikeHub` の env は likes Worker の
 * バインディング（`LikesEnv`）である。実行時の振る舞いは変わらない。
 *
 * @param stub DO
 * @param callback DO の中で走らせる処理
 * @returns 処理の戻り値
 */
async function inHub<R>(
  stub: DurableObjectStub<LikeHub>,
  callback: (instance: LikeHub, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
  return await runInDurableObject<RpcDurableObject, R>(
    stub as unknown as DurableObjectStub<RpcDurableObject>,
    (instance, state) => callback(instance as unknown as LikeHub, state),
  );
}

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `hub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, 'いいねの人')
    .run();
  return id;
}

/**
 * 公開済みの作品を 1 件用意する。
 *
 * @param authorId 作者
 * @returns 作品の id
 */
async function seedGame(authorId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state,
                        published_at)
     values (?, ?, ?, '同期の題', '', 1, 'ready', 1)`,
  )
    .bind(id, authorId, PUBLISHED_STATUS)
    .run();
  return id;
}

/**
 * D1 の `like_count` を読む。
 *
 * @param gameId 作品
 * @returns 数
 */
async function d1LikeCount(gameId: string): Promise<number> {
  const row = await env.DB.prepare('select like_count from games where id = ?')
    .bind(gameId)
    .first<{ like_count: number }>();
  return row!.like_count;
}

/**
 * BAN の状態を D1 で切り替える（運用と同じ UPDATE 1 本。7.3）。
 *
 * @param userId 利用者
 * @param banned BAN するなら true
 */
async function setBanned(userId: string, banned: boolean): Promise<void> {
  await env.DB.prepare('update users set banned_at = ? where id = ?')
    .bind(banned ? 1 : null, userId)
    .run();
}

/**
 * DO の中で操作を 1 回行い、**SQLite が数えた書き込み行数**と一緒に返す。
 *
 * `ctx.storage.sql.exec` を包み、返ったカーソルの `rowsWritten` を足し上げる。
 * **表の中身を前後で比べるだけでは足りない**——書いてから同じ値へ戻す実装（上限を
 * 超えたら 1 を足して、すぐ引く、など）は中身の比較を通るが、DO の書き込みの枠は減る。
 *
 * @param stub DO
 * @param run インスタンスに対して行う操作
 * @returns 操作の戻り値と、書き込み行数
 */
async function measureWrites<T>(
  stub: DurableObjectStub<LikeHub>,
  run: (instance: LikeHub) => Promise<T>,
): Promise<{ value: T; rowsWritten: number; statements: number }> {
  return await inHub(stub, async (instance, state) => {
    const sql = state.storage.sql;
    const original = sql.exec.bind(sql);
    const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    Object.defineProperty(sql, 'exec', {
      configurable: true,
      writable: true,
      value: (query: string, ...bindings: unknown[]) => {
        const cursor = original(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      },
    });
    try {
      const value = await run(instance);
      // `rowsWritten` はカーソルを読み切ってから確定する。
      const rowsWritten = cursors.reduce((sum, cursor) => {
        cursor.toArray();
        return sum + cursor.rowsWritten;
      }, 0);
      return { value, rowsWritten, statements: cursors.length };
    } finally {
      Reflect.deleteProperty(sql, 'exec');
    }
  });
}

describe('付与・取り消し（5.8）', () => {
  it('二重に押しても数は 1 のまま。2 回目は 1 行も書かない', async () => {
    const hub = freshHub();
    const user = await seedUser();
    const game = crypto.randomUUID();

    expect(await hub.like(user, game, NOON_JST)).toEqual({ outcome: 'liked' });
    const second = await measureWrites(hub, (instance) => instance.like(user, game, NOON_JST));

    expect(second.value).toEqual({ outcome: 'unchanged' });
    expect(second.statements, '計測が空振りしている').toBeGreaterThan(0);
    expect(second.rowsWritten).toBe(0);
    expect(await hub.viewerState(user, game)).toEqual({ liked: true, count: 1 });
  });

  it('状態を変えた付与は書き込みとして数えられる（計測が効いていることの確認）', async () => {
    const hub = freshHub();
    const first = await measureWrites(hub, (instance) =>
      instance.like('someone', crypto.randomUUID(), NOON_JST),
    );
    expect(first.value).toEqual({ outcome: 'liked' });
    // いいねの行＋作品の索引＋今日の操作回数＋同期待ちの印（3.6 の表の根拠）。
    expect(first.rowsWritten).toBeGreaterThanOrEqual(3);
  });

  it('押していない作品の取り消しは何もしない', async () => {
    const hub = freshHub();
    const result = await measureWrites(hub, (instance) =>
      instance.unlike('nobody', crypto.randomUUID(), NOON_JST),
    );
    expect(result.value).toEqual({ outcome: 'unchanged' });
    expect(result.rowsWritten).toBe(0);
  });
});

describe('1 人 1 日 100 操作（5.8）', () => {
  it('101 回目の操作は断られ、DO に 1 行も書き込まれない', async () => {
    const hub = freshHub();
    const user = 'heavy-user';
    const game = crypto.randomUUID();

    // **付与と取り消しの合計で数える。** 交互に 100 回。
    for (let count = 0; count < DAILY_OPERATION_LIMIT; count += 1) {
      const result =
        count % 2 === 0
          ? await hub.like(user, game, NOON_JST + count)
          : await hub.unlike(user, game, NOON_JST + count);
      expect(result.outcome, `${count + 1} 回目`).not.toBe('limited');
    }

    const refused = await measureWrites(hub, (instance) =>
      instance.like(user, game, NOON_JST + DAILY_OPERATION_LIMIT),
    );

    expect(refused.value).toEqual({ outcome: 'limited' });
    expect(refused.statements, '計測が空振りしている').toBeGreaterThan(0);
    expect(refused.rowsWritten, '101 回目で DO に書いた').toBe(0);
    expect(await hub.viewerState(user, game)).toEqual({ liked: false, count: 0 });

    // 別の作品でも同じ（上限は利用者ごと・作品をまたいで数える）。
    expect((await hub.like(user, crypto.randomUUID(), NOON_JST + 200)).outcome).toBe('limited');
    // 他の利用者は影響を受けない。
    expect((await hub.like('someone-else', game, NOON_JST + 200)).outcome).toBe('liked');
  });

  it('JST の 0 時で数え直す', async () => {
    const hub = freshHub();
    const user = 'boundary-user';
    // 2026-09-11 23:59:59 JST と、その 1 秒後（翌日 0 時）。
    const lastSecond = Date.UTC(2026, 8, 11, 14, 59, 59) / 1000;
    expect(jstDayKey(lastSecond)).toBe('2026-09-11');
    expect(jstDayKey(lastSecond + 1)).toBe('2026-09-12');

    for (let count = 0; count < DAILY_OPERATION_LIMIT; count += 1) {
      await hub.like(user, `game-${count}`, lastSecond);
    }
    expect((await hub.like(user, 'one-more', lastSecond)).outcome).toBe('limited');
    expect((await hub.like(user, 'one-more', lastSecond + 1)).outcome).toBe('liked');
  });
});

describe('D1 への同期（5.8）', () => {
  it('付与ではまだ D1 を書かず、同期のあと like_count が DO の実数と一致する', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const game = await seedGame(author);
    const fans = [await seedUser(), await seedUser(), await seedUser()];
    for (const fan of fans) {
      await hub.like(fan, game, NOON_JST);
    }
    await hub.unlike(fans[2]!, game, NOON_JST);

    // **付与・取り消しは D1 へ書かない。** 数はアラームが来るまで 0 のまま。
    expect(await d1LikeCount(game)).toBe(0);
    // 付与したら同期が予約されている。
    const alarm = await inHub(hub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(SYNC_INTERVAL_MS);

    expect(await runDurableObjectAlarm(hub)).toBe(true);

    expect(await d1LikeCount(game)).toBe(2);
    expect((await hub.viewerState(fans[0]!, game)).count).toBe(2);
    // いいねが残っている間は次の同期を予約し直す。
    const next = await inHub(hub, (_instance, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it('加算ではなく上書きにする（D1 の値がずれていても実数へ戻る）', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const game = await seedGame(author);
    // **取り残し**を作る: D1 だけが大きな値を持っている。
    await env.DB.prepare('update games set like_count = 999 where id = ?').bind(game).run();

    await hub.like(await seedUser(), game, NOON_JST);
    await hub.sync(NOON_JST);

    expect(await d1LikeCount(game)).toBe(1);
  });

  it('数が変わった作品だけを書く', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const touched = await seedGame(author);
    const untouched = await seedGame(author);
    const fan = await seedUser();
    await hub.like(fan, untouched, NOON_JST);
    await hub.sync(NOON_JST);
    expect(await d1LikeCount(untouched)).toBe(1);

    // **同期済みの作品を D1 の側で書き換えておく。** 変わっていない作品へ書き直しに
    // 行くなら、この値は 1 へ戻される。
    await env.DB.prepare('update games set like_count = 42 where id = ?').bind(untouched).run();
    await hub.like(fan, touched, NOON_JST);
    const report = await hub.sync(NOON_JST);

    expect(report).toEqual({ synced: 1, deferred: 0 });
    expect(await d1LikeCount(touched)).toBe(1);
    expect(await d1LikeCount(untouched)).toBe(42);
  });

  it(`1 回に写すのは ${MAX_GAMES_PER_SYNC} 件までで、残りは次の回に写る`, async () => {
    const hub = freshHub();
    const author = await seedUser();
    const games: string[] = [];
    for (let count = 0; count < MAX_GAMES_PER_SYNC + 1; count += 1) {
      const game = await seedGame(author);
      games.push(game);
      await hub.like(`fan-${count}`, game, NOON_JST);
    }

    expect(await hub.sync(NOON_JST)).toEqual({ synced: MAX_GAMES_PER_SYNC, deferred: 1 });
    expect(await hub.sync(NOON_JST)).toEqual({ synced: 1, deferred: 0 });
    for (const game of games) {
      expect(await d1LikeCount(game), game).toBe(1);
    }
    // 写し終えたら、同じ回をもう一度走らせても何も書かない。
    expect(await hub.sync(NOON_JST)).toEqual({ synced: 0, deferred: 0 });
  });

  it('前日以前の操作回数は同期で消える', async () => {
    const hub = freshHub();
    await hub.like('yesterday-user', crypto.randomUUID(), NOON_JST);
    const nextDay = NOON_JST + 24 * 60 * 60;

    await hub.sync(nextDay);

    const rows = await inHub(hub, (_instance, state) =>
      state.storage.sql.exec('select * from daily_ops').toArray(),
    );
    expect(rows).toEqual([]);
  });
});

describe('BAN した利用者のいいね（5.8）', () => {
  it('同期のあと数から外れ、解除すれば戻る（いいねの行は消さない）', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const game = await seedGame(author);
    const good = await seedUser();
    const bad = await seedUser();
    await hub.like(good, game, NOON_JST);
    await hub.like(bad, game, NOON_JST);
    await hub.sync(NOON_JST);
    expect(await d1LikeCount(game)).toBe(2);

    // **運用は D1 の UPDATE 1 本だけ**（7.3）。DO へは何も知らせない。
    await setBanned(bad, true);
    // いいねの操作が 1 つも無くても、同期が BAN の差分を拾って数え直す。
    const banned = await hub.sync(NOON_JST);

    expect(banned.synced).toBe(1);
    expect(await d1LikeCount(game)).toBe(1);
    expect((await hub.viewerState(good, game)).count).toBe(1);
    // 本人から見ても「押している」ことは変わらない（行は残っている）。
    expect((await hub.viewerState(bad, game)).liked).toBe(true);

    await setBanned(bad, false);
    await hub.sync(NOON_JST);
    expect(await d1LikeCount(game)).toBe(2);
  });

  it('BAN の状態が変わらなければ、その利用者の作品を数え直しに行かない', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const game = await seedGame(author);
    const bad = await seedUser();
    await hub.like(bad, game, NOON_JST);
    await setBanned(bad, true);
    await hub.sync(NOON_JST);
    expect(await d1LikeCount(game)).toBe(0);

    // BAN されたまま次の回が来ても、書くものは無い。
    expect(await hub.sync(NOON_JST)).toEqual({ synced: 0, deferred: 0 });
    await setBanned(bad, false);
  });
});

describe('公開の入口が無い（5.8）', () => {
  it('Worker の fetch は要求を読まずに 404 を返す', async () => {
    const response = await likesWorker.fetch();
    expect(response.status).toBe(404);
  });
});
