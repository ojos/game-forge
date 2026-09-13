import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as RpcDurableObject } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_STATUS } from '../src/games.js';
import { MAX_GAMES_PER_SYNC, SYNC_INTERVAL_MS } from '../workers/likes/src/hub.js';
import { PlayHub, UPDATE_PLAY_COUNT_SQL } from '../workers/likes/src/play-hub.js';
import { applySchema } from './helpers/schema.js';

/**
 * プレイ数の正本（`workers/likes/src/play-hub.ts`。#377）。**DO の中から確かめる。**
 *
 * - 計上は D1 へ書かず、同期のあと `play_count` が DO の累計と一致する（**加算ではなく上書き**）
 * - 1 回に写すのは 40 件までで、写し残しは次の回に写る（`LikeHub` と共有したコードが効いている）
 * - 計上 1 回の DO への書き込み行数（3.6 の見積もりの根拠）
 *
 * **DO はテストごとに別の名前で作る**（`test/likes-hub.test.ts` と同じ理由）。
 */

beforeAll(async () => {
  await applySchema();
});

/**
 * テスト専用の DO を作る。
 *
 * @returns stub
 */
function freshHub(): DurableObjectStub<PlayHub> {
  return (env.PLAY_HUB as unknown as DurableObjectNamespace<PlayHub>).getByName(
    `test-${crypto.randomUUID()}`,
  );
}

/**
 * `runInDurableObject` を `PlayHub` の型で使う（型を当て直すだけ。`test/likes-hub.test.ts` と同じ）。
 *
 * @param stub DO
 * @param callback DO の中で走らせる処理
 * @returns 処理の戻り値
 */
async function inHub<R>(
  stub: DurableObjectStub<PlayHub>,
  callback: (instance: PlayHub, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
  return await runInDurableObject<RpcDurableObject, R>(
    stub as unknown as DurableObjectStub<RpcDurableObject>,
    (instance, state) => callback(instance as unknown as PlayHub, state),
  );
}

/**
 * 公開済みの作品を 1 件用意する（作者も作る）。
 *
 * @returns 作品の id
 */
async function seedGame(): Promise<string> {
  const authorId = `play-hub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(authorId, `sub-${authorId}`, `${authorId}@example.com`, 'プレイ数の人')
    .run();
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
 * D1 の `play_count` を読む。
 *
 * @param gameId 作品
 * @returns 数
 */
async function d1PlayCount(gameId: string): Promise<number> {
  const row = await env.DB.prepare('select play_count from games where id = ?')
    .bind(gameId)
    .first<{ play_count: number }>();
  return row!.play_count;
}

/**
 * DO の中で操作を 1 回行い、**SQLite が数えた書き込み行数**と一緒に返す
 * （`test/likes-hub.test.ts` の `measureWrites` と同じ形）。
 *
 * @param stub DO
 * @param run インスタンスに対して行う操作
 * @returns 操作の戻り値と、書き込み行数
 */
async function measureWrites<T>(
  stub: DurableObjectStub<PlayHub>,
  run: (instance: PlayHub) => Promise<T>,
): Promise<{ value: T; rowsWritten: number }> {
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
      const rowsWritten = cursors.reduce((sum, cursor) => {
        cursor.toArray();
        return sum + cursor.rowsWritten;
      }, 0);
      return { value, rowsWritten };
    } finally {
      Reflect.deleteProperty(sql, 'exec');
    }
  });
}

describe('計上（#377）', () => {
  it('届いた分を 1 ずつ足し、作品ごとに分けて数える', async () => {
    const hub = freshHub();
    const game = crypto.randomUUID();
    const other = crypto.randomUUID();

    expect(await hub.record(game)).toBe(1);
    expect(await hub.record(game)).toBe(2);
    expect(await hub.record(other)).toBe(1);

    expect(await hub.playCount(game)).toBe(2);
    expect(await hub.playCount(other)).toBe(1);
    expect(await hub.playCount(crypto.randomUUID())).toBe(0);
  });

  it('id の形が不正なら例外にする（防御の最後の段）', async () => {
    const hub = freshHub();
    await expect(inHub(hub, (instance) => instance.record(''))).rejects.toThrow(TypeError);
    await expect(inHub(hub, (instance) => instance.record('x'.repeat(129)))).rejects.toThrow(
      TypeError,
    );
  });

  it('計上 1 回の書き込みは、印が無い作品で 3 行、印がある作品で 1 行である（3.6 の見積もりの根拠）', async () => {
    const hub = freshHub();
    const game = crypto.randomUUID();

    // 内訳は累計の行（`without rowid` なので 1 行）＋同期待ちの印（rowid 表の行と自動索引で 2 行）。
    const first = await measureWrites(hub, (instance) => instance.record(game));
    expect(first.value).toBe(1);
    expect(first.rowsWritten, 'DO への書き込み行数が変わった').toBe(3);

    // **印が既にあれば `insert or ignore` は何も書かない。** 同期までの間の計上は 1 行ずつである。
    const second = await measureWrites(hub, (instance) => instance.record(game));
    expect(second.value).toBe(2);
    expect(second.rowsWritten, 'DO への書き込み行数が変わった').toBe(1);
  });
});

describe('D1 への同期（#377。`LikeHub` と共有する）', () => {
  it('計上ではまだ D1 を書かず、同期のあと play_count が DO の累計と一致する', async () => {
    const hub = freshHub();
    const game = await seedGame();
    for (let count = 0; count < 3; count += 1) {
      await hub.record(game);
    }

    // **計上は D1 へ書かない**（3.6）。数はアラームが来るまで 0 のまま。
    expect(await d1PlayCount(game)).toBe(0);
    const alarm = await inHub(hub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(SYNC_INTERVAL_MS);

    expect(await runDurableObjectAlarm(hub)).toBe(true);

    expect(await d1PlayCount(game)).toBe(3);
    // **写し残しが無ければ次を予約しない**（いいねと違い、BAN の差分を見る理由が無い）。
    const next = await inHub(hub, (_instance, state) => state.storage.getAlarm());
    expect(next).toBeNull();
  });

  it('加算ではなく上書きにする（D1 の値がずれていても累計へ戻る）', async () => {
    const hub = freshHub();
    const game = await seedGame();
    await env.DB.prepare('update games set play_count = 999 where id = ?').bind(game).run();

    await hub.record(game);
    await hub.sync();

    expect(await d1PlayCount(game)).toBe(1);
  });

  it('数が変わった作品だけを書く', async () => {
    const hub = freshHub();
    const touched = await seedGame();
    const untouched = await seedGame();
    await hub.record(untouched);
    await hub.sync();
    expect(await d1PlayCount(untouched)).toBe(1);

    await env.DB.prepare('update games set play_count = 42 where id = ?').bind(untouched).run();
    await hub.record(touched);
    const report = await hub.sync();

    expect(report).toEqual({ synced: 1, deferred: 0 });
    expect(await d1PlayCount(touched)).toBe(1);
    expect(await d1PlayCount(untouched)).toBe(42);
  });

  it(`1 回に写すのは ${MAX_GAMES_PER_SYNC} 件までで、残りは次の回に写る`, async () => {
    const hub = freshHub();
    const games: string[] = [];
    for (let count = 0; count < MAX_GAMES_PER_SYNC + 1; count += 1) {
      const game = await seedGame();
      games.push(game);
      await hub.record(game);
    }

    expect(await hub.sync()).toEqual({ synced: MAX_GAMES_PER_SYNC, deferred: 1 });
    // 写し残しがあるうちは、アラームが次を予約する。
    expect(await runDurableObjectAlarm(hub)).toBe(true);
    for (const game of games) {
      expect(await d1PlayCount(game), game).toBe(1);
    }
    expect(await hub.sync()).toEqual({ synced: 0, deferred: 0 });
  });

  it('写している間に数えた分を取り残さない（印を末尾へ付け直す）', async () => {
    // **D1 の batch を待つ間に届いた計上**を決定的に作る（`test/likes-hub.test.ts` の飢餓の検査と
    // 同じ包み方）。共有した `writeCountSync` が、プレイ数でも印を付け直すことを見る。
    const hub = freshHub();
    const game = await seedGame();
    await hub.record(game);

    await inHub(hub, async (instance) => {
      const original = Reflect.get(instance, 'env') as { DB: D1Database };
      const interruptingDb = new Proxy(original.DB, {
        get(target, property) {
          if (property === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              await instance.record(game);
              return await target.batch(statements);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Reflect.set(instance, 'env', { ...original, DB: interruptingDb });
      try {
        expect(await instance.sync()).toEqual({ synced: 1, deferred: 0 });
      } finally {
        Reflect.set(instance, 'env', original);
      }
    });

    // 写したのは割り込み前の 1 で、割り込んだ 1 回ぶんの印が残っている。
    expect(await d1PlayCount(game)).toBe(1);
    expect(await hub.sync()).toEqual({ synced: 1, deferred: 0 });
    expect(await d1PlayCount(game)).toBe(2);
  });

  it('同期の SQL は値が同じなら書かない形である', () => {
    // **同じ値で UPDATE しても、D1 は行と索引を書いたものとして数える**（3.6）。
    expect(UPDATE_PLAY_COUNT_SQL).toBe(
      'update games set play_count = ? where id = ? and play_count <> ?',
    );
  });
});
