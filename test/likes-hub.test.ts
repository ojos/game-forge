import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as RpcDurableObject } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_STATUS } from '../src/games.js';
import likesWorker from '../workers/likes/src/index.js';
import {
  DAILY_OPERATION_LIMIT,
  LikeHub,
  MAX_GAMES_PER_SYNC,
  MAX_LIKED_GAMES_PER_CALL,
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

  it('同期の最中に変わり続ける作品が先頭に居座らず、後ろの作品が有限回で写る', async () => {
    // **飢餓の検査**（Copilot code review の指摘。PR #346）。印は付けた順（rowid の順）に
    // 40 件ずつ写す。**D1 の batch を待つ間に数が変わった作品**の印を古い rowid のまま
    // 残すと、変わり続ける作品が 40 件以上あるとき、後ろの作品が 1 度も写らない。
    //
    // 「最中に変わる」を決定的に作るため、DO の env の `DB.batch` を包み、batch の手前で
    // 先頭の 40 件へ別の利用者のいいねを 1 つずつ足す（本番では、batch を待つ間に
    // 届いた付与がこれにあたる）。
    const hub = freshHub();
    const author = await seedUser();
    const churners: string[] = [];
    for (let count = 0; count < MAX_GAMES_PER_SYNC; count += 1) {
      const game = await seedGame(author);
      churners.push(game);
      await hub.like(`seed-${count}`, game, NOON_JST);
    }
    // **最後に印を付けた作品**。先頭の 40 件が居座れば、これが写らない。
    const waiting = await seedGame(author);
    await hub.like('seed-last', waiting, NOON_JST);

    const syncWhileChurning = async (round: number): Promise<void> => {
      await inHub(hub, async (instance) => {
        const original = Reflect.get(instance, 'env') as { DB: D1Database };
        const churningDb = new Proxy(original.DB, {
          get(target, property) {
            if (property === 'batch') {
              return async (statements: D1PreparedStatement[]) => {
                for (const [index, game] of churners.entries()) {
                  await instance.like(`churn-${round}-${index}`, game, NOON_JST);
                }
                return await target.batch(statements);
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        Reflect.set(instance, 'env', { ...original, DB: churningDb });
        try {
          await instance.sync(NOON_JST);
        } finally {
          Reflect.set(instance, 'env', original);
        }
      });
    };

    // 先頭が同期のたびに変わり続けても、**3 回のうちに**待っていた作品が写る
    // （付け直せば 2 回目に先頭へ来る）。
    let rounds = 0;
    while ((await d1LikeCount(waiting)) !== 1 && rounds < 3) {
      rounds += 1;
      await syncWhileChurning(rounds);
    }
    expect(await d1LikeCount(waiting), `${rounds} 回の同期で写らなかった`).toBe(1);
    // **割り込みが実際に起きていたこと**（包みが空振りしていれば、この検査は何も見ていない）。
    expect((await hub.viewerState('anyone', churners[0]!)).count).toBe(1 + rounds);

    // 変わり続けた作品も、割り込みが止めば実数に収まる（取り残しが無い）。
    while ((await hub.sync(NOON_JST)).synced > 0) {
      // 印が尽きるまで回す。
    }
    for (const game of churners) {
      expect(await d1LikeCount(game), game).toBe((await hub.viewerState('anyone', game)).count);
    }
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

describe('押した作品の一覧（5.8 / M9-8 / #340）', () => {
  it('押した新しい順に返し、取り消した作品は消える', async () => {
    const hub = freshHub();
    const user = await seedUser();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const third = crypto.randomUUID();

    await hub.like(user, first, NOON_JST);
    await hub.like(user, second, NOON_JST + 1);
    await hub.like(user, third, NOON_JST + 2);

    expect(await hub.likedGames(user, 10, 0)).toEqual([third, second, first]);

    await hub.unlike(user, second, NOON_JST + 3);
    expect(await hub.likedGames(user, 10, 0)).toEqual([third, first]);
  });

  it('同じ秒に押した作品の順序も決まっている（頁をめくって取りこぼさない）', async () => {
    const hub = freshHub();
    const user = await seedUser();
    // **同じ `created_at` の行を作る。** 末尾の `game_id desc` が無いと、SQLite が
    // 返す順序に頼ることになり、頁の境目で同じ作品が 2 度出たり 1 度も出なかったりする。
    const ids = ['aaa', 'bbb', 'ccc'].map((prefix) => `${prefix}-${crypto.randomUUID()}`);
    for (const id of ids) {
      await hub.like(user, id, NOON_JST);
    }
    const expected = [...ids].sort().reverse();
    expect(await hub.likedGames(user, 10, 0)).toEqual(expected);
    // 1 件ずつめくっても、全件がちょうど 1 度ずつ出る。
    const paged: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 1) {
      paged.push(...(await hub.likedGames(user, 1, offset)));
    }
    expect(paged).toEqual(expected);
  });

  it('他人のいいねを 1 件も返さない', async () => {
    const hub = freshHub();
    const me = await seedUser();
    const other = await seedUser();
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();

    await hub.like(me, mine, NOON_JST);
    await hub.like(other, theirs, NOON_JST + 1);

    expect(await hub.likedGames(me, 10, 0)).toEqual([mine]);
    expect(await hub.likedGames(other, 10, 0)).toEqual([theirs]);
    // 1 件も押していない利用者には空の配列（例外にしない）。
    expect(await hub.likedGames(await seedUser(), 10, 0)).toEqual([]);
  });

  it('限度と読み飛ばしが効く', async () => {
    const hub = freshHub();
    const user = await seedUser();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      await hub.like(user, id, NOON_JST + index);
    }
    const newestFirst = [...ids].reverse();

    expect(await hub.likedGames(user, 2, 0)).toEqual(newestFirst.slice(0, 2));
    expect(await hub.likedGames(user, 2, 2)).toEqual(newestFirst.slice(2, 4));
    expect(await hub.likedGames(user, 2, 4)).toEqual(newestFirst.slice(4, 5));
    // 範囲の外は空（例外にしない。画面は空の頁を描ける）。
    expect(await hub.likedGames(user, 2, 99)).toEqual([]);
    expect(await hub.likedGames(user, 0, 0)).toEqual([]);
  });

  it('1 行も書かない（日次の操作回数にも同期待ちの印にも触れない）', async () => {
    const hub = freshHub();
    const user = await seedUser();
    const game = crypto.randomUUID();
    await hub.like(user, game, NOON_JST);

    const before = await inHub(hub, (_instance, state) => ({
      ops: state.storage.sql
        .exec('select * from daily_ops')
        .toArray()
        .map((row) => JSON.stringify(row))
        .sort(),
      dirty: state.storage.sql
        .exec('select * from dirty_games')
        .toArray()
        .map((row) => JSON.stringify(row))
        .sort(),
    }));

    const measured = await measureWrites(hub, (instance) => instance.likedGames(user, 20, 0));

    expect(measured.value).toEqual([game]);
    // **SQLite が数えた書き込み行数で見る。** 表の中身を比べるだけでは、書いてから
    // 同じ値へ戻す実装を通してしまう（このファイルの `measureWrites` の冒頭）。
    expect(measured.rowsWritten, '一覧を引くだけで DO へ書いている').toBe(0);
    expect(
      await inHub(hub, (_instance, state) => ({
        ops: state.storage.sql
          .exec('select * from daily_ops')
          .toArray()
          .map((row) => JSON.stringify(row))
          .sort(),
        dirty: state.storage.sql
          .exec('select * from dirty_games')
          .toArray()
          .map((row) => JSON.stringify(row))
          .sort(),
      })),
    ).toEqual(before);
  });

  it('日次の上限に達していても引ける（読み取りは数えない）', async () => {
    const hub = freshHub();
    const user = await seedUser();
    const ids: string[] = [];
    // 上限ぴったりまで、状態が変わる操作を行う（付与だけで DAILY_OPERATION_LIMIT 回）。
    for (let index = 0; index < DAILY_OPERATION_LIMIT; index += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      expect((await hub.like(user, id, NOON_JST + index)).outcome).toBe('liked');
    }
    // 次の付与は断られる（上限に達している）。
    expect((await hub.like(user, crypto.randomUUID(), NOON_JST)).outcome).toBe('limited');
    // **それでも一覧は引ける。** 読むだけの口が上限に巻き込まれると、押しすぎた日に
    // 自分の一覧が見えなくなる。
    expect(await hub.likedGames(user, 20, 0)).toHaveLength(20);
  });

  it('BAN された利用者でも、本人の一覧は空にならない（数から外すのは他人向けである）', async () => {
    const hub = freshHub();
    const author = await seedUser();
    const game = await seedGame(author);
    const bad = await seedUser();
    await hub.like(bad, game, NOON_JST);
    await setBanned(bad, true);
    await hub.sync(NOON_JST);

    // 他人に見せる数からは外れる（#339 が決めたこと）。
    expect(await d1LikeCount(game)).toBe(0);
    // **本人の一覧には残る。** いいねの行は消していない（解除すれば数にも戻る）。
    expect(await hub.likedGames(bad, 20, 0)).toEqual([game]);
    await setBanned(bad, false);
  });

  it('引数の形が不正なら例外にする（LIMIT -1 を無制限にしない）', async () => {
    const hub = freshHub();
    const user = await seedUser();
    await hub.like(user, crypto.randomUUID(), NOON_JST);

    // **DO の中で呼ぶ**（RPC 越しに投げさせない）。stub からの拒否は workerd の RPC 層を
    // 通り、`rejects` で受けても未処理の拒否として別に報告される（このファイルの他の
    // 検査が RPC で呼んでいるのは、投げない経路だけである）。
    //
    // **SQLite は `LIMIT -1` を「無制限」と解釈する。** 負の値で上限が消えないこと。
    // 防御の上限（1 個の DO に全員のいいねが集まっている）も見る。
    const rejected = await inHub(hub, async (instance) => {
      const thrown: string[] = [];
      const cases: readonly [string, () => Promise<unknown>][] = [
        ['limit が負', () => instance.likedGames(user, -1, 0)],
        ['offset が負', () => instance.likedGames(user, 0, -1)],
        ['limit が整数でない', () => instance.likedGames(user, 1.5, 0)],
        ['limit が上限超え', () => instance.likedGames(user, MAX_LIKED_GAMES_PER_CALL + 1, 0)],
        ['userId が空', () => instance.likedGames('', 1, 0)],
      ];
      for (const [label, call] of cases) {
        try {
          await call();
        } catch {
          thrown.push(label);
        }
      }
      return thrown;
    });

    expect(rejected).toEqual([
      'limit が負',
      'offset が負',
      'limit が整数でない',
      'limit が上限超え',
      'userId が空',
    ]);
    // **通る側も見る**（全部投げる実装で緑にならないように）。
    expect(await hub.likedGames(user, MAX_LIKED_GAMES_PER_CALL, 0)).toHaveLength(1);
  });
});
