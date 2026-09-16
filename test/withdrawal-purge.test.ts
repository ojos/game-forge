import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as RpcDurableObject } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { avatarObjectKey } from '../src/avatar-paths.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import {
  D1_QUERY_LIMIT,
  GAMES_PER_STEP,
  PROGRESS_DELAY_MS,
  WITHDRAWAL_TAKEOVER_SECONDS,
  runWithdrawalPurgeStep,
} from '../src/withdrawal-purge.js';
import { avatarHistoryPrefixOf, withdrawUser } from '../src/withdrawal.js';
import type { CleanupEnv, WithdrawalHub } from '../workers/cleanup/src/hub.js';
import { MemoryPurgeBackoff, WITHDRAWAL_HUB_INSTANCE } from '../workers/cleanup/src/hub.js';
import cleanupWorker from '../workers/cleanup/src/index.js';
import { countingEnv } from './helpers/d1-counting.js';
import { applySchema } from './helpers/schema.js';

/**
 * 退会の後続の処理（`src/withdrawal-purge.ts` と `workers/cleanup/` / #586 / M15-3a）。
 *
 * **#518 の acceptance 6 を、口が無いうちに機械判定する。**
 *
 * > 後続の処理が、作品 60 件の利用者について、途中で止めて再開しても全件を #516 の規則で
 * > 消し終える
 *
 * あわせて次を見る。
 *
 * - **1 回のアラームで走る D1 の文が {@link D1_QUERY_LIMIT} 未満**（Workers Free の枠。仕様 3.6）
 * - **{@link GAMES_PER_STEP} 件ずつ**しか取らない（枠を使い切らない）
 * - 始めて {@link WITHDRAWAL_TAKEOVER_SECONDS} たった処理中の要求を**代わりに打つ**
 * - **完了の印（`withdrawal_completed_at`）は、R2 の接頭辞が空だと確かめてから**立つ
 * - 失敗した作品は待ちに入り、**残りの削除を止めない**
 * - **DO のアラームが `runWithdrawalPurgeStep` を呼び、次のアラームを立てる**
 * - **cron（`scheduled`）が DO を起こす**
 */

beforeAll(async () => {
  await applySchema();
});

// **実際の時計より前の時刻を使う。** DO のアラームは `runWithdrawalPurgeStep` を既定の
// 現在時刻で呼ぶので、下準備の `withdrawn_at` が未来だと `0045` の CHECK
// （完了は確定より前にならない）に当たる。
const NOW = 1_700_000_000;

/**
 * Proxy から元のオブジェクトへ束ねた値を返す。
 *
 * **R2 のメソッドは `this` を見る**（ネイティブの実装）。`Reflect.get` の戻り値をそのまま
 * 呼ぶと `this` が Proxy になり、`Illegal invocation` で落ちる。
 *
 * @param target 元のオブジェクト
 * @param property 読む名前
 * @param receiver Proxy
 * @returns 束ねた関数、または元の値
 */
function bound(target: object, property: string | symbol, receiver: unknown): unknown {
  const value = Reflect.get(target, property, receiver) as unknown;
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `wdp-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '退会する人')
    .run();
  return id;
}

/**
 * 作品行を 1 つ作る（**成果物のキーと版を持たせる**——本番の完成の経路と同じ形）。
 *
 * @param authorId 作者
 * @param status 状態
 * @returns 作品 id
 */
async function seedGame(authorId: string, status: 'draft' | 'published' = 'draft'): Promise<string> {
  const id = crypto.randomUUID();
  const sourceKey = `builds/${id}.go`;
  const wasmKey = `builds/${id}.wasm.br`;
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, source_key, wasm_key,
                        created_at, published_at, generation_state)
     values (?, ?, ?, '題名', 'go1.27.0', ?, ?, 100, ?, 'ready')`,
  )
    .bind(id, authorId, status, sourceKey, wasmKey, status === 'published' ? 200 : null)
    .run();
  await env.DB.prepare(
    `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
     values (?, 1, ?, ?, 'go1.27.0', null, 100)`,
  )
    .bind(id, sourceKey, wasmKey)
    .run();
  await env.BUCKET.put(sourceKey, 'package main');
  await env.BUCKET.put(wasmKey, 'wasm');
  return id;
}

/**
 * その利用者の、中身を消していない作品の数。
 *
 * @param userId 利用者
 * @returns 件数
 */
async function remainingGames(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'select count(*) as n from games where author_id = ? and purged_at is null',
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 退会の 3 列を読む。
 *
 * @param userId 利用者
 * @returns 3 列
 */
async function withdrawalRow(userId: string): Promise<Record<string, number | null> | null> {
  return await env.DB.prepare(
    'select withdrawal_started_at, withdrawn_at, withdrawal_completed_at from users where id = ?',
  )
    .bind(userId)
    .first<Record<string, number | null>>();
}

describe('作品 60 件を、途中で止めて再開しても全件消し終える', () => {
  it('アラームを繰り返すだけで完了の印まで立ち、1 回あたりの D1 の文が枠に収まる', async () => {
    const userId = await seedUser();
    // **60 件**（#518 の acceptance 6）。1 件は公開中にして、取り下げの打ち直しも通す。
    const ids: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      ids.push(await seedGame(userId, index === 0 ? 'published' : 'draft'));
    }
    await env.BUCKET.put(avatarObjectKey(userId), 'icon');

    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });
    expect(await remainingGames(userId)).toBe(60);

    const backoff = new MemoryPurgeBackoff();
    let rounds = 0;
    let maxStatements = 0;
    let maxMeasured = 0;
    const startedAt = Date.now();
    while (rounds < 200) {
      rounds += 1;
      const counted = countingEnv(env);
      const result = await runWithdrawalPurgeStep(counted.env, backoff, NOW + rounds);
      const measured = counted.count();
      maxStatements = Math.max(maxStatements, result.statements);
      maxMeasured = Math.max(maxMeasured, measured);
      // **見積もりが実測を下回らない**（下回ると、枠を超える回が出うる）。
      expect(result.statements).toBeGreaterThanOrEqual(measured);
      // **実測が枠に収まる**（Workers Free は D1 の 1 呼び出し 50 クエリ）。
      expect(measured).toBeLessThan(D1_QUERY_LIMIT);
      // **1 回で取るのは GAMES_PER_STEP 件まで。**
      expect(result.deleted).toBeLessThanOrEqual(GAMES_PER_STEP);
      if (result.nextDelayMs === null) {
        break;
      }
    }
    const elapsedMs = Date.now() - startedAt;

    expect(await remainingGames(userId)).toBe(0);
    const row = await withdrawalRow(userId);
    expect(row?.withdrawal_completed_at).not.toBeNull();

    // **60 件を 2 件ずつなので 30 回 + 完了の 1 回 + 打ち止めの 1 回**。上限は余裕を見た値。
    expect(rounds).toBeLessThanOrEqual(40);
    // アイコンも R2 から消えている。
    expect(await env.BUCKET.head(avatarObjectKey(userId))).toBeNull();
    const listed = await env.BUCKET.list({ prefix: avatarHistoryPrefixOf(userId) });
    expect(listed.objects).toHaveLength(0);

    // **実測を PR に書くための数字**（テスト環境の値であって、本番の CPU 時間ではない）。
    console.info(
      `[withdrawal-purge] 60 件を ${rounds} 回で消し終えた。` +
        `1 回あたりの D1 の文は最大 ${maxMeasured}（見積もり ${maxStatements}）、` +
        `全 ${rounds} 回の所要は ${elapsedMs} ms（1 回あたり約 ${Math.round(elapsedMs / rounds)} ms）。`,
    );
  });
});

describe('アラーム 1 回の中身', () => {
  it('公開中のまま残った作品を取り下げ直し、親の被改造数も数え直す', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const parent = await seedGame(other, 'published');
    const child = await seedGame(userId, 'draft');
    await env.DB.prepare('update games set parent_id = ? where id = ?').bind(parent, child).run();

    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });
    // **確定の直後に公開が通った**状態を手で作る（#518 のログインの停止が入るまで残る窓）。
    await env.DB.prepare('update games set status = ?, published_at = 300 where id = ?')
      .bind(PUBLISHED_STATUS, child)
      .run();
    await env.DB.prepare('update games set fork_count = 1 where id = ?').bind(parent).run();

    await runWithdrawalPurgeStep(env, new MemoryPurgeBackoff(), NOW + 1);

    // **同じ回で取り下げてから消す**（取り下げた作品は、そのまま候補になる）ので、
    // 行が残っていれば `removed`、消えていれば行そのものが無い。**公開中でないこと**を見る。
    const row = await env.DB.prepare('select status from games where id = ?')
      .bind(child)
      .first<{ status: string }>();
    expect(row?.status ?? 'deleted').not.toBe(PUBLISHED_STATUS);
    const parentRow = await env.DB.prepare('select fork_count from games where id = ?')
      .bind(parent)
      .first<{ fork_count: number }>();
    expect(parentRow?.fork_count).toBe(0);
  });

  it('始めて 10 分たった処理中の要求を、代わりに打つ', async () => {
    const userId = await seedUser();
    // 段1 だけが済んで落ちた状態（掴んだが確定していない）。
    await env.DB.prepare('update users set withdrawal_started_at = ? where id = ?')
      .bind(NOW, userId)
      .run();

    // **10 分に足りないうちは触らない。**
    const early = await runWithdrawalPurgeStep(env, new MemoryPurgeBackoff(), NOW + 60);
    expect(early.tookOver).toBe(0);
    expect((await withdrawalRow(userId))?.withdrawn_at).toBeNull();

    // **10 分たてば代打する。**
    const late = await runWithdrawalPurgeStep(
      env,
      new MemoryPurgeBackoff(),
      NOW + WITHDRAWAL_TAKEOVER_SECONDS,
    );
    expect(late.tookOver).toBe(1);
    expect(late.nextDelayMs).toBe(PROGRESS_DELAY_MS);
    const row = await withdrawalRow(userId);
    expect(row?.withdrawal_started_at).toBe(NOW);
    expect(row?.withdrawn_at).toBe(NOW + WITHDRAWAL_TAKEOVER_SECONDS);
  });

  it('終わっていない退会が 1 件も無ければ、次のアラームを立てない', async () => {
    // **同じ D1 を他のテストと共有している**ので、まず残っている退会を全部さばく。
    const backoff = new MemoryPurgeBackoff();
    let result = await runWithdrawalPurgeStep(env, backoff, NOW + 10_000);
    let rounds = 0;
    while (result.nextDelayMs !== null && rounds < 200) {
      rounds += 1;
      result = await runWithdrawalPurgeStep(env, backoff, NOW + 10_000 + rounds);
    }
    expect(result).toMatchObject({ tookOver: 0, deleted: 0, completed: 0, nextDelayMs: null });
    // **平常時の重さ**——5 分ごとに走るので、ここが軽いことに意味がある。
    expect(result.statements).toBeLessThanOrEqual(6);
  });

  it('失敗した作品は待ちに入り、残りの削除を止めない', async () => {
    const userId = await seedUser();
    const doomed = await seedGame(userId);
    const healthy = await seedGame(userId);
    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });

    // **1 件目の R2 の削除だけを落とす。**
    let failed = false;
    const brittle: CleanupEnv['BUCKET'] = new Proxy(env.BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') {
          return async (keys: string | string[]): Promise<void> => {
            const list = Array.isArray(keys) ? keys : [keys];
            if (!failed && list.some((key) => key.includes(doomed))) {
              failed = true;
              throw new Error('R2 が落ちました');
            }
            await target.delete(keys);
          };
        }
        return bound(target, property, receiver);
      },
    });

    const backoff = new MemoryPurgeBackoff();
    await runWithdrawalPurgeStep({ DB: env.DB, BUCKET: brittle }, backoff, NOW + 1);
    expect(failed).toBe(true);
    // 待ちに入ったので、次の回は取らない。
    expect(backoff.ready(doomed, NOW + 2)).toBe(false);

    // **健全なほうは消える**（1 本の壊れた作品が残りを止めない）。
    let rounds = 0;
    while (rounds < 10 && (await remainingGames(userId)) > 1) {
      rounds += 1;
      await runWithdrawalPurgeStep(env, backoff, NOW + 1 + rounds);
    }
    const healthyRow = await env.DB.prepare('select purged_at from games where id = ?')
      .bind(healthy)
      .first<{ purged_at: number | null }>();
    expect(healthyRow).toBeNull();
    // 待ちが明ければ、壊れたほうも消える。
    await runWithdrawalPurgeStep(env, backoff, NOW + 100_000);
    expect(await remainingGames(userId)).toBe(0);
  });

  it('アイコンが R2 に残っているあいだは、完了の印を立てない', async () => {
    const userId = await seedUser();
    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });
    // 確定のあとに、写しが 1 枚戻ってきた状態を作る（**消えたはずのものが残っている**）。
    await env.BUCKET.put(`${avatarHistoryPrefixOf(userId)}stuck.webp`, 'stuck');

    const stubborn: CleanupEnv['BUCKET'] = new Proxy(env.BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') {
          // 消せないバケット（ライフサイクルや権限の不調を模す）。
          return async (): Promise<void> => {};
        }
        return bound(target, property, receiver);
      },
    });

    const result = await runWithdrawalPurgeStep({ DB: env.DB, BUCKET: stubborn }, new MemoryPurgeBackoff(), NOW + 1);
    expect(result.completed).toBe(0);
    expect((await withdrawalRow(userId))?.withdrawal_completed_at).toBeNull();

    // 消せるようになれば、次の回で立つ。
    await runWithdrawalPurgeStep(env, new MemoryPurgeBackoff(), NOW + 2);
    expect((await withdrawalRow(userId))?.withdrawal_completed_at).toBe(NOW + 2);
  });
});

describe('Durable Object と cron の結線', () => {
  /**
   * `runInDurableObject` を `WithdrawalHub` の型で使う（`test/likes-hub.test.ts` と同じ形）。
   *
   * @param stub DO
   * @param callback DO の中で走らせる処理
   * @returns 処理の戻り値
   */
  async function inHub<R>(
    stub: DurableObjectStub<WithdrawalHub>,
    callback: (instance: WithdrawalHub, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R> {
    return await runInDurableObject<RpcDurableObject, R>(
      stub as unknown as DurableObjectStub<RpcDurableObject>,
      (instance, state) => callback(instance as unknown as WithdrawalHub, state),
    );
  }

  /**
   * テスト専用の DO を作る。
   *
   * @param name インスタンス名
   * @returns stub
   */
  function hub(name: string): DurableObjectStub<WithdrawalHub> {
    return (env.WITHDRAWAL_HUB as unknown as DurableObjectNamespace<WithdrawalHub>).getByName(name);
  }

  it('wake() がアラームを立てる（cron から呼ばれる口）', async () => {
    const stub = hub(`test-${crypto.randomUUID()}`);
    // **同じ DO の実行の中で読む。** 外から読むと、`Date.now()` に立てたアラームが
    // 読む前に発火しうる（入力ゲートの中なら発火しない）。
    const alarm = await inHub(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.wake();
      return await state.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
  });

  it('アラームが作品を消し、進んだら次のアラームを立てる', async () => {
    const userId = await seedUser();
    await seedGame(userId);
    await seedGame(userId);
    await seedGame(userId);
    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });

    const stub = hub(`test-${crypto.randomUUID()}`);
    // **先の時刻に立てておく**（`runDurableObjectAlarm` は時刻を問わず走らせる）。
    await inHub(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub as unknown as DurableObjectStub<RpcDurableObject>)).toBe(
      true,
    );
    // **進んだことだけを見る。** 次のアラームは 1 秒後なので、読むまでに自分で走りうる
    // （それが正しい振る舞いである）。何件残っているかを固定しない。
    expect(await remainingGames(userId)).toBeLessThan(3);

    // 繰り返せば最後まで消える。
    let rounds = 0;
    while (rounds < 10 && (await remainingGames(userId)) > 0) {
      rounds += 1;
      await inHub(stub, async (_instance, state) => {
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await runDurableObjectAlarm(stub as unknown as DurableObjectStub<RpcDurableObject>);
    }
    expect(await remainingGames(userId)).toBe(0);
  });

  it('アラームの中身が進んだら、同じ実行の中で次のアラームを立てる', async () => {
    const userId = await seedUser();
    await seedGame(userId);
    await seedGame(userId);
    await seedGame(userId);
    expect(await withdrawUser(env, userId, NOW)).toEqual({ ok: true, result: 'withdrawn' });

    const stub = hub(`test-${crypto.randomUUID()}`);
    // **1 回の DO の実行の中で、`alarm()` を呼んでから読む**（入力ゲートの中なので、
    // 立てたアラームが読む前に発火しない）。
    const { remaining, next } = await inHub(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
      return {
        remaining: await remainingGames(userId),
        next: await state.storage.getAlarm(),
      };
    });
    expect(remaining).toBe(3 - GAMES_PER_STEP);
    expect(next).not.toBeNull();
    expect(next! - Date.now()).toBeLessThanOrEqual(PROGRESS_DELAY_MS);
  });

  it('cron（scheduled）がインスタンス「withdrawal」を起こす', async () => {
    // **結線だけを見る。** 本物の DO を起こすと、`wake()` が立てたアラームが読む前に
    // 発火して、何を確かめているのか分からなくなる。
    const woken: string[] = [];
    const fakeEnv = {
      WITHDRAWAL_HUB: {
        idFromName: (name: string): unknown => ({ name }),
        get: (id: { name: string }): { wake: () => Promise<void> } => ({
          wake: async (): Promise<void> => {
            woken.push(id.name);
          },
        }),
      },
    } as unknown as CleanupEnv;

    // **引数は 2 つ**（`scheduled` は `ExecutionContext` を宣言していない——使わないものを
    // 受け取らない）。本番の実行時に 3 つ渡ってくるぶんには害が無い。
    await cleanupWorker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry: () => {} },
      fakeEnv,
    );
    expect(woken).toEqual([WITHDRAWAL_HUB_INSTANCE]);
  });

  it('fetch は 404 しか返さない（公開の入口を作らない）', async () => {
    const response = cleanupWorker.fetch();
    expect(response.status).toBe(404);
  });
});
