import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  countArtifactReferences,
  deleteUnreferencedArtifacts,
  forgetBuildCache,
  planArtifactDeletion,
  readBuildCache,
  recordBuildCache,
  sourceCacheKey,
  toHex,
} from '../src/build-cache.js';
import type { BuildCacheRecord } from '../src/build-cache.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/**
 * 索引 1 行分の雛形を作る。
 *
 * テストごとに固有のハッシュを渡して自己完結させる（`test/schema.test.ts` と同じ方針）。
 *
 * @param sourceSha256 キャッシュ鍵
 * @param overrides 差し替える項目
 * @returns 記録する内容
 */
function record(sourceSha256: string, overrides: Partial<BuildCacheRecord> = {}): BuildCacheRecord {
  return {
    sourceSha256,
    goVersion: 'go1.26.5',
    sourceKey: `sources/${sourceSha256}.go`,
    wasmKey: `wasm/${sourceSha256}.wasm.br`,
    wasmBytes: 11_404_411,
    wasmSha256: 'a'.repeat(64),
    compressedBytes: 2_282_980,
    compressedSha256: 'b'.repeat(64),
    contentEncoding: 'br',
    ...overrides,
  };
}

/**
 * 索引が指す 2 つのオブジェクトを R2 へ置く。
 *
 * @param entry 記録した内容
 */
async function putArtifacts(entry: BuildCacheRecord): Promise<void> {
  await env.BUCKET.put(entry.wasmKey, 'compressed-wasm');
  await env.BUCKET.put(entry.sourceKey, 'package main');
}

describe('キャッシュ鍵（3.8「生成ソースのコンテンツハッシュ」）', () => {
  it('UTF-8 のバイト列に対する SHA-256 を小文字 16 進で返す', async () => {
    expect(await sourceCacheKey('package main\n')).toBe(
      'df1d036cbbf3df46e2045071e082245ece204c7f53ecf0a4e022bff9bb228f47',
    );
  });

  it('1 文字の違いで別の鍵になる', async () => {
    expect(await sourceCacheKey('package main\n')).not.toBe(await sourceCacheKey('package main '));
  });

  it('16 進への変換が 0 を詰める', () => {
    // 0x0a を "a" と書くと長さが変わり、ハッシュの比較が静かに壊れる。
    expect(toHex(new Uint8Array([0x00, 0x0a, 0xff]))).toBe('000aff');
  });
});

describe('索引の読み書き（3.8「関数の外に置く」）', () => {
  it('記録した内容をそのまま読み戻せる', async () => {
    const entry = record('1'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry, 1_700_000_000);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup.hit).toBe(true);
    if (!lookup.hit) return;
    expect(lookup.entry).toEqual({ ...entry, createdAt: 1_700_000_000 });
  });

  it('索引に無い鍵はミスになる', async () => {
    const lookup = await readBuildCache(env, '2'.repeat(64));
    expect(lookup).toEqual({ hit: false, reason: 'not-indexed' });
  });

  it('同じ鍵の再記録が古い行を置き換える', async () => {
    const first = record('3'.repeat(64));
    await putArtifacts(first);
    await recordBuildCache(env, first);

    const second = record('3'.repeat(64), { goVersion: 'go1.27.0' });
    await recordBuildCache(env, second);

    const lookup = await readBuildCache(env, first.sourceSha256);
    expect(lookup.hit).toBe(true);
    if (!lookup.hit) return;
    expect(lookup.entry.goVersion).toBe('go1.27.0');

    const rows = await env.DB.prepare('select count(*) as n from build_cache where source_sha256 = ?')
      .bind(first.sourceSha256)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe('成果物が消えている場合（3.7 のライフサイクル / 確定13）', () => {
  it('`.wasm.br` が無ければミスにし、索引の行も落とす', async () => {
    // 14 日間未公開なら自動削除される（確定13）。**索引だけが残る状態は平常である。**
    const entry = record('4'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await env.BUCKET.delete(entry.wasmKey);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup).toEqual({ hit: false, reason: 'artifact-missing' });

    // 次の生成で同じ 2 回の head を繰り返さないよう、行そのものを落としている。
    const row = await env.DB.prepare('select count(*) as n from build_cache where source_sha256 = ?')
      .bind(entry.sourceSha256)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('`source.go` だけが無くてもミスにする', async () => {
    // フォーク（5.3）は source が無ければ再現できない。片方だけでヒットにすると、
    // 「遊べるがフォークできない」作品が生まれる。
    const entry = record('5'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await env.BUCKET.delete(entry.sourceKey);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup).toEqual({ hit: false, reason: 'artifact-missing' });
  });
});

describe('索引の削除', () => {
  it('落とした鍵はミスになる', async () => {
    const entry = record('6'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await forgetBuildCache(env, entry.sourceSha256);

    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'not-indexed',
    });
  });
});

/**
 * テスト用の利用者を 1 行作る（`games.author_id` の外部キーを満たすため）。
 *
 * テストごとに固有の接尾辞を渡して自己完結させる（`test/schema.test.ts` と同じ方針）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作成した利用者の id
 */
async function insertUser(suffix: string): Promise<string> {
  const id = `u-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${suffix}`, `${suffix}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 作品を 1 行作る。
 *
 * キャッシュヒットで作られた作品は、**別の作品と同じキーを持つ**（3.8 / 確定26）ため、
 * キーは呼び出し側が明示的に渡す。tombstone（5.3）を表せるよう NULL も受ける。
 *
 * @param id 作品 id
 * @param authorId 作者
 * @param keys R2 のキー
 * @param status 作品の状態
 */
async function insertGame(
  id: string,
  authorId: string,
  keys: { sourceKey: string | null; wasmKey: string | null },
  status: 'draft' | 'published' | 'removed' = 'draft',
): Promise<void> {
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, source_key, wasm_key, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(id, authorId, status, `T-${id}`, 'go1.26.5', keys.sourceKey, keys.wasmKey)
    .run();
}

/**
 * R2 にオブジェクトが在るか。
 *
 * @param key R2 のキー
 * @returns 在れば true
 */
async function exists(key: string): Promise<boolean> {
  return (await env.BUCKET.head(key)) !== null;
}

/**
 * D1 の文が 1 つ走り終わるたびにフックを呼ぶ `Env` を作る。
 *
 * `deleteUnreferencedArtifacts` の「索引を落とす → 数え直す」のあいだに並行して起きる
 * 出来事（キャッシュヒットの生成が新しい参照を作る）を、**決定的に**再現するために使う。
 * 実際の並行実行では起きる順序が固定できず、検査が不安定になる。
 *
 * @param afterStatement 文が走り終わったあとに呼ぶフック（走った SQL を受け取る）
 * @returns 差し替えた `DB` を持つ `Env`
 */
function hookedEnv(afterStatement: (sql: string) => Promise<void>): Env {

  /**
   * 文を包み、非同期の実行が終わったところでフックを呼ぶ。
   *
   * @param sql 実行する SQL
   * @param statement 包む対象
   * @returns 包んだ文
   */
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (property === 'bind') return wrap(sql, result as D1PreparedStatement);
          if (result instanceof Promise) {
            return result.then(async (resolved) => {
              await afterStatement(sql);
              return resolved;
            });
          }
          return result;
        };
      },
    });

  const db = new Proxy(env.DB, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver);
      return (sql: string): D1PreparedStatement => wrap(sql, target.prepare(sql));
    },
  });

  return { ...env, DB: db } as Env;
}

/**
 * `head` の呼び出しを記録する `BUCKET` に差し替えた `Env` を作る。
 *
 * 「実在確認まで進まずに戻さないと決めた」ことを、**呼ばれなかった往復**として観測する
 * ために使う（3.7 は Class B のオペレーションも従量だと書いている）。
 *
 * @param base 差し替える元の `Env`
 * @param heads 呼ばれた `head` のキーを記録する配列
 * @returns 差し替えた `BUCKET` を持つ `Env`
 */
function countingHeads(base: Env, heads: string[]): Env {
  const bucket = new Proxy(base.BUCKET, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property !== 'head') return (value as (...a: unknown[]) => unknown).bind(target);
      return (key: string): Promise<R2Object | null> => {
        heads.push(key);
        return target.head(key);
      };
    },
  });
  return { ...base, BUCKET: bucket } as Env;
}

describe('共有された成果物の削除（確定26 / 3.4-7 / 3.7 / #116）', () => {
  it('公開済みの作品が参照している成果物は、別の作品を削除しても消えない', async () => {
    // **本 issue の acceptance そのもの。** 作品 A と B は同一ソースから生まれ
    // （フォークは同一ソースからの派生を作る経路である。1.3 / 5.3）、キャッシュヒットに
    // よって同じ R2 オブジェクトを指している。B は公開済みである。
    const entry = record('7'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('shared-published');
    const keys = { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey };
    await insertGame('g-shared-a', author, keys, 'draft');
    await insertGame('g-shared-b', author, keys, 'published');

    const plan = await deleteUnreferencedArtifacts(env, 'g-shared-a');

    expect(plan.deletable).toEqual([]);
    expect(plan.retained).toEqual([
      { key: entry.sourceKey, referencedBy: 1 },
      { key: entry.wasmKey, referencedBy: 1 },
    ]);

    // B はそのまま遊べる（3.4 の配信は `games` 行が持つキーを引くだけである）。
    expect(await exists(entry.wasmKey)).toBe(true);
    expect(await exists(entry.sourceKey)).toBe(true);

    // 索引にも触っていない。消していない以上、落とす理由が無い。
    expect((await readBuildCache(env, entry.sourceSha256)).hit).toBe(true);
  });

  it('規約を守らずに消すと公開済みの作品が壊れる（上の検査が効いていることの確認）', async () => {
    // **変異検査。** 上のテストは「消えていないこと」を主張するが、そもそも消える経路が
    // 無ければ何を書いても緑になる。**被参照チェックを通さない削除**（確定26 以前の
    // 「作品 1 件 = オブジェクト 1 組」を前提にした素朴な掃除）を同じ状況で実行し、
    // 公開済みの作品が実際に壊れることを見る。
    const entry = record('8'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('naive-delete');
    const keys = { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey };
    await insertGame('g-naive-a', author, keys, 'draft');
    await insertGame('g-naive-b', author, keys, 'published');

    // 素朴な掃除: A の行が持つキーを、参照を見ずにそのまま消す。
    const a = await env.DB.prepare('select source_key, wasm_key from games where id = ?')
      .bind('g-naive-a')
      .first<{ source_key: string; wasm_key: string }>();
    await env.BUCKET.delete(a!.wasm_key);
    await env.BUCKET.delete(a!.source_key);

    // 公開済みの B が指す先が消えている。**これが確定26 が防ぐ事象である。**
    const b = await env.DB.prepare('select wasm_key from games where id = ?')
      .bind('g-naive-b')
      .first<{ wasm_key: string }>();
    expect(await exists(b!.wasm_key)).toBe(false);

    // 索引の実在確認（#19）はこの状態をミスへ落とすが、それは新規生成を守るだけで、
    // 既に公開されている B は壊れたままである。
    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'artifact-missing',
    });
  });

  it('参照している作品が自分だけなら消し、索引も落とす', async () => {
    const entry = record('9'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('sole-ref');
    await insertGame('g-sole', author, { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey });

    const plan = await deleteUnreferencedArtifacts(env, 'g-sole');

    expect(plan.deletable).toEqual([entry.sourceKey, entry.wasmKey]);
    expect(plan.retained).toEqual([]);
    expect(await exists(entry.wasmKey)).toBe(false);
    expect(await exists(entry.sourceKey)).toBe(false);

    // **索引を落としている（規約 2）。** 残すと、直後の生成が消えかけのオブジェクトへ
    // ヒットし、`games` 行だけが新しく作られる経路が開く。`artifact-missing` ではなく
    // `not-indexed` が返ることが、行そのものを落とした証拠である。
    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'not-indexed',
    });
  });

  it('tombstone（`removed`）の作品も参照として数える', async () => {
    // 5.3 は「親の削除は物理削除せず tombstone 化し、子は残す」と定め、フォークの再現には
    // `source.go` が要る。`status` で絞ると、tombstone だけが参照している source を
    // 消してしまう。**2 つのキーの寿命が別である**ことも、ここで同時に確かめる。
    const entry = record('a'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('tombstone-ref');
    await insertGame(
      'g-tomb-a',
      author,
      { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey },
      'draft',
    );
    // wasm は既に落とされ、source だけが残っている tombstone。
    await insertGame('g-tomb-b', author, { sourceKey: entry.sourceKey, wasmKey: null }, 'removed');

    const plan = await deleteUnreferencedArtifacts(env, 'g-tomb-a');

    expect(plan.retained).toEqual([{ key: entry.sourceKey, referencedBy: 1 }]);
    expect(plan.deletable).toEqual([entry.wasmKey]);
    expect(await exists(entry.sourceKey)).toBe(true);
    expect(await exists(entry.wasmKey)).toBe(false);
  });

  it('削除する作品自身を参照に数えない', async () => {
    // 自己除外（`id <> ?`）が効いていることを、除外しない数え方と対照して確かめる。
    // 外すと自分の行が常に 1 件当たり、**どの成果物も永久に消せなくなる。**
    const entry = record('b'.repeat(64));
    const author = await insertUser('self-ref');
    await insertGame('g-self', author, { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey });

    expect(await countArtifactReferences(env, entry.wasmKey, 'g-self')).toBe(0);

    const including = await env.DB.prepare(
      'select count(*) as n from games where source_key = ? or wasm_key = ?',
    )
      .bind(entry.wasmKey, entry.wasmKey)
      .first<{ n: number }>();
    expect(including?.n).toBe(1);
  });

  it('キーを持たない作品は参照者にならない', async () => {
    // tombstone 化で両方のキーが NULL になった行（5.1）。`where source_key = ?` は
    // NULL に当たらないが、空文字なら当たりうるため、キーの側でも空を弾いている。
    const entry = record('c'.repeat(64));
    await putArtifacts(entry);

    const author = await insertUser('null-keys');
    await insertGame('g-null-a', author, { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey });
    await insertGame('g-null-b', author, { sourceKey: null, wasmKey: null }, 'removed');

    expect(await countArtifactReferences(env, entry.wasmKey, 'g-null-a')).toBe(0);

    const plan = await planArtifactDeletion(env, 'g-null-b');
    expect(plan).toEqual({ gameId: 'g-null-b', deletable: [], retained: [] });
  });

  it('作品行が無ければ何も消さない', async () => {
    // 既に消えている行に対して、キーを推測して消しに行かない。
    const plan = await planArtifactDeletion(env, 'g-does-not-exist');
    expect(plan).toEqual({ gameId: 'g-does-not-exist', deletable: [], retained: [] });
  });

  it('数え直しで残すことになったら、落とした索引を戻す（PR #121 の指摘）', async () => {
    // 索引を落としてから数え直すまでのあいだに、並行したキャッシュヒットの生成が
    // 参照を作る場合。**成果物は残るのに索引だけが失われる**と、以後の同一ソースの生成が
    // 要らないビルドを 1 回する（約 21 秒。3.8）。規約 2 の順序は保ったまま、消さないと
    // 決めたときに限って戻す。
    const entry = record('d'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry, 1_700_000_042);

    const author = await insertUser('restore-index');
    await insertGame('g-restore-a', author, {
      sourceKey: entry.sourceKey,
      wasmKey: entry.wasmKey,
    });

    // 索引を落とす文が走った直後に、同じ成果物を指す公開済みの作品が現れる。
    // 索引を落とす文はキーの数だけ走る。**再現したいのは 1 度だけ起きた出来事**なので、
    // 最初の 1 回に限る。
    let raced1 = false;
    const raced = hookedEnv(async (sql) => {
      if (raced1 || !sql.startsWith('delete from build_cache')) return;
      raced1 = true;
      await insertGame(
        'g-restore-b',
        author,
        { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey },
        'published',
      );
    });

    const plan = await deleteUnreferencedArtifacts(raced, 'g-restore-a');

    expect(plan.deletable).toEqual([]);
    expect(await exists(entry.wasmKey)).toBe(true);
    expect(await exists(entry.sourceKey)).toBe(true);

    // **索引が戻っている。** `createdAt` も元の値のままであること（戻した行だけが
    // 若返ると、索引の年齢を見る掃除から静かに外れる）。
    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup.hit).toBe(true);
    if (!lookup.hit) return;
    expect(lookup.entry).toEqual({ ...entry, createdAt: 1_700_000_042 });
  });

  it('消したキーを指す索引は戻さない（片方だけ残ったとき）', async () => {
    // 戻す条件を「残すと決めたキーがあること」にすると、**壊れた組を指す索引**を自分で
    // 作り直すことになる。索引の行は source と wasm の両方を指すため、片方でも消えていれば
    // 戻さない。
    const entry = record('e'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('restore-partial');
    await insertGame('g-partial-a', author, {
      sourceKey: entry.sourceKey,
      wasmKey: entry.wasmKey,
    });

    // 並行して現れるのは、source だけを指す tombstone（5.3）。wasm は誰も参照しない。
    const heads: string[] = [];
    let raced2 = false;
    const raced = countingHeads(
      hookedEnv(async (sql) => {
        if (raced2 || !sql.startsWith('delete from build_cache')) return;
        raced2 = true;
        await insertGame(
          'g-partial-b',
          author,
          { sourceKey: entry.sourceKey, wasmKey: null },
          'removed',
        );
      }),
      heads,
    );

    const plan = await deleteUnreferencedArtifacts(raced, 'g-partial-a');

    expect(plan.deletable).toEqual([entry.wasmKey]);
    expect(await exists(entry.sourceKey)).toBe(true);
    expect(await exists(entry.wasmKey)).toBe(false);

    // **実在確認まで進んでいない。** 消したキーを指す索引は、R2 へ問い合わせるまでもなく
    // 戻さないと決まる。head は 3.7 の Class B に数えられる往復であり、要らない往復を
    // しないこと自体が、この早期の打ち切りが効いている証拠になる。
    expect(heads).toEqual([]);
    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'not-indexed',
    });
  });

  it('戻す直前に成果物が消えていたら戻さない', async () => {
    // 別の掃除が並行して消していた場合。実在を確かめずに戻すと、**消えたオブジェクトを
    // 指す索引を自分で作り直す**ことになり、規約 2 で塞いだ経路が復活する。
    const entry = record('f'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);

    const author = await insertUser('restore-vanished');
    await insertGame('g-vanish-a', author, {
      sourceKey: entry.sourceKey,
      wasmKey: entry.wasmKey,
    });

    let raced3 = false;
    const raced = hookedEnv(async (sql) => {
      if (raced3 || !sql.startsWith('delete from build_cache')) return;
      raced3 = true;
      // 参照は増えるが、成果物のほうは別の経路で既に消えている。
      await insertGame(
        'g-vanish-b',
        author,
        { sourceKey: entry.sourceKey, wasmKey: entry.wasmKey },
        'published',
      );
      await env.BUCKET.delete(entry.wasmKey);
      await env.BUCKET.delete(entry.sourceKey);
    });

    const plan = await deleteUnreferencedArtifacts(raced, 'g-vanish-a');

    expect(plan.deletable).toEqual([]);
    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'not-indexed',
    });
  });

  it('被参照チェックが使う索引が張られている（0004）', async () => {
    // 3.6 は「読み取りも従量である」と書いており、被参照チェックは削除のたびに走る。
    // 索引が無いと `games` の全走査になり、フォークで行が伸びるほど読み取り行数も伸びる。
    const result = await env.DB.prepare('select name from sqlite_master where type = ?')
      .bind('index')
      .all<{ name: string }>();
    const names = result.results.map((row) => row.name);
    expect(names).toContain('games_source_key_idx');
    expect(names).toContain('games_wasm_key_idx');
  });
});
