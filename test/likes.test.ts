import { env, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as RpcDurableObject } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { DRAFT_STATUS, PUBLISHED_STATUS } from '../src/games.js';
import {
  LIKE_CANCEL_GAME_ID_FIELD,
  LIKE_CANCEL_PATH,
  LIKE_GAME_ID_FIELD,
  LIKE_PATH,
} from '../src/like-paths.js';
import {
  DAILY_LIMIT_MESSAGE,
  LIKE_HUB_NAME,
  NOT_PRESSABLE_MESSAGE,
  readLikeViewerState,
} from '../src/likes.js';
import { workPagePath } from '../src/paths.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import { findDuplicateRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { DAILY_OPERATION_LIMIT, jstDayKey } from '../workers/likes/src/hub.js';
import type { LikeHub } from '../workers/likes/src/hub.js';
import { applySchema } from './helpers/schema.js';

/**
 * いいねの窓口（`src/likes.ts`。#339 / 5.8）。**経路表を通して叩く。**
 *
 * #339 の acceptance のうち、窓口が持つものを機械判定できる形へ落とす。
 *
 * - 二重に押しても数が 1 のまま
 * - 101 回目の操作が 429 で断られ、DO に書き込まれない
 * - 押せない作品の 4 種（存在しない・`draft`・自作・審査で止めた）がすべて同じ 404 になり、
 *   何も書かれない
 * - **付与・取り消しの経路で D1 への書き込みが 0 件**
 *
 * # D1 への書き込みをどう数えるか
 *
 * **env の `DB` を記録つきの写しに差し替えて、窓口が発行した SQL をすべて取る**
 * （{@link recordingDb}）。書き込みの文（`insert` / `update` / `delete` / `replace` など）が
 * 1 本も無いこと、`batch` / `exec` を 1 度も呼ばないこと、`run` / `all` が返す
 * `rows_written` の合計が 0 であることを見る。**加えて作品の行そのものを前後で比べる**——
 * DO の側は別の `DB`（テストでは差し替えていない本物）を持つので、DO が付与の途中で
 * D1 へ書いた場合は記録に出ない。行の比較がそれを捕まえる。
 *
 * # DO への書き込みをどう見るか
 *
 * **DO の表をまるごと写して前後で比べる**（{@link dumpHub}）。窓口の手前（セッション・
 * 本文・押せる作品か）で断った要求は DO に届かないので、表は 1 行も変わらない。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-like-endpoints';

/** 書き込みの文の先頭（`with` で始まる書き込みも見逃さないよう、語で探す）。 */
const WRITE_STATEMENT = /\b(insert|update|delete|replace|create|drop|alter)\b/iu;

/** 窓口が D1 に対して行ったこと。 */
interface D1Record {
  /** `prepare` に渡された SQL。 */
  readonly statements: string[];
  /** `run` / `all` が返した `rows_written` の合計。 */
  rowsWritten: number;
  /** `batch` / `exec` / `dump` を呼んだ回数（窓口は 1 度も呼ばないはず）。 */
  bulkCalls: number;
}

/**
 * 記録つきの D1 を作る。
 *
 * @param db 本物の D1
 * @returns 差し替える D1 と、記録
 */
function recordingDb(db: D1Database): { db: D1Database; record: D1Record } {
  const record: D1Record = { statements: [], rowsWritten: 0, bulkCalls: 0 };

  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === 'run' || property === 'all') {
          return async () => {
            const result = await target[property]();
            record.rowsWritten += result.meta.rows_written ?? 0;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          record.statements.push(query);
          return wrapStatement(target.prepare(query));
        };
      }
      if (property === 'batch' || property === 'exec' || property === 'dump') {
        record.bulkCalls += 1;
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, record };
}

/**
 * 記録が「D1 へ 1 行も書いていない」ことを確かめる。
 *
 * @param record 記録
 */
function expectNoD1Writes(record: D1Record): void {
  expect(record.statements.length, '窓口が D1 を 1 度も読んでいない（検査が空振りしている）').toBeGreaterThan(0);
  expect(record.statements.filter((sql) => WRITE_STATEMENT.test(sql))).toEqual([]);
  expect(record.bulkCalls).toBe(0);
  expect(record.rowsWritten).toBe(0);
}

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * @param label 表示名
 * @returns 利用者の id
 */
async function seedUser(label: string): Promise<string> {
  const id = `like-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, label)
    .run();
  return id;
}

/**
 * 作品を 1 件用意する。
 *
 * @param authorId 作者
 * @param overrides 状態の指定
 * @returns 作品の id
 */
async function seedGame(
  authorId: string,
  overrides: { readonly status?: string; readonly reviewState?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state,
                        published_at, review_state)
     values (?, ?, ?, 'いいねの題', '', 1, 'ready', 1, ?)`,
  )
    .bind(id, authorId, overrides.status ?? PUBLISHED_STATUS, overrides.reviewState ?? null)
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * @param userId 利用者
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/** 口ごとの違い。 */
const ENDPOINTS = {
  like: { path: LIKE_PATH, field: LIKE_GAME_ID_FIELD },
  cancel: { path: LIKE_CANCEL_PATH, field: LIKE_CANCEL_GAME_ID_FIELD },
} as const;

/** 送り方の指定。 */
interface SendOptions {
  /** ログインしている利用者（省略すると未ログイン）。 */
  readonly userId?: string;
  /** 本文をそのまま指定する（省略すると `game_id` だけのフォーム）。 */
  readonly body?: string;
  /** `Accept`。既定は HTML。 */
  readonly accept?: string;
  /** `Content-Type`。既定はフォーム。 */
  readonly contentType?: string;
}

/**
 * 口を叩く。**経路表を通す**（`src/app.ts` への登録漏れも捕まえる）。
 *
 * @param endpoint どちらの口か
 * @param gameId 作品
 * @param options 送り方
 * @returns レスポンスと、D1 の記録
 */
async function send(
  endpoint: keyof typeof ENDPOINTS,
  gameId: string,
  options: SendOptions = {},
): Promise<{ response: Response; record: D1Record }> {
  const { path, field } = ENDPOINTS[endpoint];
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
    accept: options.accept ?? 'text/html',
  };
  if (options.userId !== undefined) {
    headers.cookie = await sessionCookie(options.userId);
  }
  const { db, record } = recordingDb(env.DB);
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: options.body ?? new URLSearchParams({ [field]: gameId }).toString(),
    }),
    { ...env, DB: db, SESSION_SECRET: SECRET } as Env,
  );
  return { response, record };
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

/** 窓口が使う DO（B1 なので 1 個）。 */
function hub(): DurableObjectStub<LikeHub> {
  return (env.LIKE_HUB as unknown as DurableObjectNamespace<LikeHub>).getByName(LIKE_HUB_NAME);
}

/**
 * DO の表をまるごと写す。**前後で比べて「DO に書かれていない」を確かめる。**
 *
 * @returns 表ごとの全行
 */
async function dumpHub(): Promise<Record<string, unknown[]>> {
  return await inHub(hub(), (_instance, state) => {
    const dump: Record<string, unknown[]> = {};
    for (const table of ['likes', 'daily_ops', 'dirty_games', 'banned_users']) {
      // 並びを SQL に頼らず、行を文字列にして並べる（表ごとに列の数が違う）。
      dump[table] = state.storage.sql
        .exec(`select * from ${table}`)
        .toArray()
        .map((row) => JSON.stringify(row))
        .sort();
    }
    return dump;
  });
}

/**
 * 作品の行をまるごと写す（D1 の側に何も書かれていないことを見る）。
 *
 * @param gameId 作品
 * @returns 行
 */
async function gameRow(gameId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('select * from games where id = ?').bind(gameId).first();
}

/**
 * ある利用者の今日の操作回数を DO から読む。
 *
 * @param userId 利用者
 * @returns 回数
 */
async function opsToday(userId: string): Promise<number> {
  const day = jstDayKey(Math.floor(Date.now() / 1000));
  return await inHub(hub(), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ ops: number }>('select ops from daily_ops where user_id = ? and day = ?', userId, day)
      .toArray()[0];
    return row?.ops ?? 0;
  });
}

/**
 * 上限まで実際の操作で送るテストの時間上限（#512）。
 *
 * 付与と取り消しを {@link DAILY_OPERATION_LIMIT} 回往復する。負荷の下では既定の 5 秒を
 * 超えた（並列のレーンと CI の verify で観測）ので、余裕を持たせる。**全体の上限は変えない。**
 */
const LIMIT_BY_REAL_OPERATIONS_TIMEOUT_MS = 60_000;

/**
 * ある利用者の今日の操作回数を DO に置く（下準備）。
 *
 * **日付の鍵は本体と同じ {@link jstDayKey} で作り、表は {@link opsToday} / {@link dumpHub} と
 * 同じく DO の `daily_ops` を直接読み書きする。** 上限の値は書き写さず、呼ぶ側が
 * {@link DAILY_OPERATION_LIMIT} を渡す。置いた値は {@link opsToday} で読み戻して確かめる
 * （書き込みが空振りしたまま、別の理由の 429 で緑にならないように）。
 *
 * @param userId 利用者
 * @param ops 置く回数
 */
async function seedOpsToday(userId: string, ops: number): Promise<void> {
  const day = jstDayKey(Math.floor(Date.now() / 1000));
  await inHub(hub(), (_instance, state) => {
    state.storage.sql.exec(
      `insert into daily_ops (user_id, day, ops) values (?, ?, ?)
         on conflict (user_id, day) do update set ops = excluded.ops`,
      userId,
      day,
      ops,
    );
  });
  expect(await opsToday(userId), '下準備の回数が DO に入っていない').toBe(ops);
}

describe('経路の登録（5.8）', () => {
  it('付与と取り消しが別の口として登録されている', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    const posts = routes.filter((route) => route.method === 'POST').map((route) => route.path);
    expect(posts).toContain(LIKE_PATH);
    expect(posts).toContain(LIKE_CANCEL_PATH);
    // **1 つの口に畳まない**（5.8）。
    expect(LIKE_PATH).not.toBe(LIKE_CANCEL_PATH);
  });
});

describe('付与・取り消し（5.8）', () => {
  it('付与すると作品ページへ戻り、D1 へは 1 行も書かない', async () => {
    const author = await seedUser('作者');
    const fan = await seedUser('押す人');
    const game = await seedGame(author);
    const before = await gameRow(game);

    const { response, record } = await send('like', game, { userId: fan });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(workPagePath(game));
    expectNoD1Writes(record);
    // **DO も付与の途中で D1 へ書いていない**（同期はアラームだけが行う）。
    expect(await gameRow(game)).toEqual(before);
    expect(await readLikeViewerState(env, fan, game)).toEqual({ liked: true, count: 1 });
  });

  it('二重に押しても数は 1 のまま（冪等。回数も数えない）', async () => {
    const author = await seedUser('作者');
    const fan = await seedUser('二度押す人');
    const game = await seedGame(author);

    const first = await send('like', game, { userId: fan });
    const second = await send('like', game, { userId: fan });

    expect(first.response.status).toBe(303);
    // 冪等な口では 2 回目は失敗ではない。同じ場所へ戻す。
    expect(second.response.status).toBe(303);
    expect(await readLikeViewerState(env, fan, game)).toEqual({ liked: true, count: 1 });
    // **状態が変わらない操作は日次の上限にも数えない**（書かないと決めた操作のために書かない）。
    expect(await opsToday(fan)).toBe(1);
  });

  it('取り消すと数が戻り、D1 へは 1 行も書かない。二重の取り消しも冪等', async () => {
    const author = await seedUser('作者');
    const fan = await seedUser('取り消す人');
    const game = await seedGame(author);
    await send('like', game, { userId: fan });
    const before = await gameRow(game);

    const cancel = await send('cancel', game, { userId: fan });
    const again = await send('cancel', game, { userId: fan });

    expect(cancel.response.status).toBe(303);
    expect(cancel.response.headers.get('location')).toBe(workPagePath(game));
    expect(again.response.status).toBe(303);
    expectNoD1Writes(cancel.record);
    expectNoD1Writes(again.record);
    expect(await gameRow(game)).toEqual(before);
    expect(await readLikeViewerState(env, fan, game)).toEqual({ liked: false, count: 0 });
    expect(await opsToday(fan)).toBe(2);
  });

  it('他人が押した数は合算される', async () => {
    const author = await seedUser('作者');
    const game = await seedGame(author);
    const fans = [await seedUser('1 人目'), await seedUser('2 人目'), await seedUser('3 人目')];
    for (const fan of fans) {
      await send('like', game, { userId: fan });
    }
    expect(await readLikeViewerState(env, fans[0]!, game)).toEqual({ liked: true, count: 3 });
  });

  it('fetch からの呼び出しには JSON で返す', async () => {
    const author = await seedUser('作者');
    const fan = await seedUser('JSON の人');
    const game = await seedGame(author);

    const { response } = await send('like', game, {
      userId: fan,
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify({ [LIKE_GAME_ID_FIELD]: game }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ like: 'liked' });
  });
});

describe('押せない作品（5.8）', () => {
  it('存在しない・draft・自作・審査で止めた、の 4 種が同じ 404 になり、何も書かれない', async () => {
    const author = await seedUser('作者');
    const cases: Record<string, { readonly userId: string; readonly gameId: string }> = {
      存在しない: { userId: author, gameId: crypto.randomUUID() },
      draft: { userId: await seedUser('draft を押す人'), gameId: await seedGame(author, { status: DRAFT_STATUS }) },
      自作: { userId: author, gameId: await seedGame(author) },
      審査で止めた: {
        userId: await seedUser('審査中を押す人'),
        gameId: await seedGame(author, { reviewState: REVIEW_QUEUED }),
      },
    };

    const bodies = new Set<string>();
    for (const [label, { userId, gameId }] of Object.entries(cases)) {
      for (const endpoint of ['like', 'cancel'] as const) {
        const hubBefore = await dumpHub();
        const rowBefore = await gameRow(gameId);

        const { response, record } = await send(endpoint, gameId, { userId });

        expect(response.status, `${label} / ${endpoint}`).toBe(404);
        const body = await response.text();
        expect(body, `${label} / ${endpoint}`).toContain(NOT_PRESSABLE_MESSAGE);
        bodies.add(body);
        expectNoD1Writes(record);
        expect(await gameRow(gameId), `${label} / ${endpoint}`).toEqual(rowBefore);
        expect(await dumpHub(), `${label} / ${endpoint}: DO に書かれた`).toEqual(hubBefore);
      }
    }
    // **理由を区別しない**——本文が 1 種類しか無い（draft の存在を外へ漏らさない。5.4）。
    expect(bodies.size).toBe(1);
  });

  it('審査で「問題なし」とした作品には押せる', async () => {
    // 審査の条件を「審査の列が空のときだけ」と取り違えていないこと（`reviewVisibleSql`）。
    const author = await seedUser('作者');
    const fan = await seedUser('押す人');
    const game = await seedGame(author, { reviewState: REVIEW_CLEARED });
    expect((await send('like', game, { userId: fan })).response.status).toBe(303);
  });
});

describe('断るときは何も書かない（5.8）', () => {
  it('未ログインはログインへ送り、D1 にも DO にも書かない', async () => {
    const author = await seedUser('作者');
    const game = await seedGame(author);
    const hubBefore = await dumpHub();

    const html = await send('like', game);
    const api = await send('cancel', game, { accept: 'application/json' });

    expect(html.response.status).toBe(303);
    expect(html.response.headers.get('location')).toBe(LOGIN_PATH);
    expect(api.response.status).toBe(401);
    // 未ログインでは session の cookie が無いので D1 を 1 度も読まない。書き込みの文も無い。
    expect(html.record.statements.filter((sql) => WRITE_STATEMENT.test(sql))).toEqual([]);
    expect(await dumpHub()).toEqual(hubBefore);
  });

  it('game_id が無い・形が不正は 400 で、DO に書かない', async () => {
    const fan = await seedUser('形の不正');
    const hubBefore = await dumpHub();

    const missing = await send('like', 'unused', { userId: fan, body: '' });
    const malformed = await send('cancel', 'unused', {
      userId: fan,
      body: new URLSearchParams({ [LIKE_CANCEL_GAME_ID_FIELD]: 'not-a-uuid' }).toString(),
    });
    // **項目名は口ごとに別の定数である。** 付与の口へ別の名前で送れば、無いのと同じ。
    const wrongField = await send('like', 'unused', {
      userId: fan,
      body: new URLSearchParams({ gameId: crypto.randomUUID() }).toString(),
    });

    expect(missing.response.status).toBe(400);
    expect(malformed.response.status).toBe(400);
    expect(wrongField.response.status).toBe(400);
    for (const { record } of [missing, malformed, wrongField]) {
      expect(record.statements.filter((sql) => WRITE_STATEMENT.test(sql))).toEqual([]);
      expect(record.rowsWritten).toBe(0);
    }
    expect(await dumpHub()).toEqual(hubBefore);
  });

  /**
   * **上限まで実際の操作で送るのは、このテストだけにする**（#512）。
   *
   * 1 往復は速いが 100 往復を積むので、並列のレーンや CI で負荷が高いと vitest の既定の
   * 時間上限（5 秒）を超えて落ちていた。**実際に 100 回送ることは保証として残し**、
   * このテストにだけ個別の上限（{@link LIMIT_BY_REAL_OPERATIONS_TIMEOUT_MS}）を設ける。
   * ほかのテストで上限の状態が要るときは {@link seedOpsToday} で下準備する。
   */
  it(
    '101 回目の操作は 429 で断られ、DO に書き込まれない',
    { timeout: LIMIT_BY_REAL_OPERATIONS_TIMEOUT_MS },
    async () => {
      const author = await seedUser('作者');
      const fan = await seedUser('押し続ける人');
      const game = await seedGame(author);

      // 付与と取り消しを交互に 100 回（**合計で数える**。5.8）。
      for (let count = 0; count < DAILY_OPERATION_LIMIT; count += 1) {
        const { response } = await send(count % 2 === 0 ? 'like' : 'cancel', game, { userId: fan });
        expect(response.status, `${count + 1} 回目`).toBe(303);
      }
      expect(await opsToday(fan)).toBe(DAILY_OPERATION_LIMIT);
      const hubBefore = await dumpHub();

      const { response, record } = await send('like', game, { userId: fan });

      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).toContain(DAILY_LIMIT_MESSAGE);
      // 戻り先は作品ページ（上限の案内を読んでから戻れる）。
      expect(body).toContain(workPagePath(game));
      expectNoD1Writes(record);
      expect(await dumpHub(), '101 回目で DO に書かれた').toEqual(hubBefore);
      expect(await readLikeViewerState(env, fan, game)).toEqual({ liked: false, count: 0 });
    },
  );
});

describe('上限に達したときの案内（5.8 / M9-8 / #340）', () => {
  it('文言が仕様 5.8 の言い回しと一致している', () => {
    // **仕様の文言をコードへ書き写さない**（`.ai-playbook/shared-ai-rules.md` 12 章。
    // `test/generate-page.test.ts` が 4.4 の文言について同じことをしている）。
    // 仕様側を直したらここが落ち、コード側を直したらここが落ちる。
    const spec = env.TEST_PRODUCT_SPEC;
    const quoted = [...spec.matchAll(/\*\*上限に達したとき:?\*\*\s*「([^」]+)」/gu)].map(
      (match) => match[1]!,
    );
    expect(quoted, '仕様 5.8 の「上限に達したとき」の文言が 1 つ見つからない').toHaveLength(1);
    // 仕様は鍵括弧の中に句点を書かない。**コード側の句点だけを外して比べる。**
    expect(DAILY_LIMIT_MESSAGE.replace(/。$/u, '')).toBe(quoted[0]);
  });

  it('断りの画面に作品ページへ戻る導線が出る（HTML のときだけ）', async () => {
    const author = await seedUser('作者');
    const fan = await seedUser('上限まで押す人');
    const game = await seedGame(author);

    // **上限まで実際に送ることは「101 回目の操作は 429 で断られ…」が保証する。** ここは
    // 画面の導線だけを見るので、DO の回数を上限に置いてから押す（#512。100 往復を積むと
    // 負荷の下で既定の時間上限を超える）。回数の置き方が本体の数え方（日付の鍵・表・上限）と
    // 食い違えば、次の 1 回は 429 にならずここで落ちる。
    await seedOpsToday(fan, DAILY_OPERATION_LIMIT);

    const asHtml = await send('like', game, { userId: fan });
    expect(asHtml.response.status, '下準備した回数を本体が上限と数えていない').toBe(429);
    const body = await asHtml.response.text();
    expect(body).toContain(DAILY_LIMIT_MESSAGE);
    // **戻り先はリンクで出す**（303 で戻すと断られたことが URL にもステータスにも
    // 残らない。`src/likes.ts` の `refusal`）。
    expect(body).toContain(`<a href="${workPagePath(game)}">`);

    // `fetch` で送った側には画面を返さない（8.3。応答本文の文字列を表示面へ持ち込まない）。
    const asJson = await send('like', game, { userId: fan, accept: 'application/json' });
    expect(asJson.response.status).toBe(429);
    expect(await asJson.response.json()).toEqual({ error: 'daily-limit' });
    // 断った 2 回は数えない（下準備の値のまま）。
    expect(await opsToday(fan)).toBe(DAILY_OPERATION_LIMIT);
  });
});
