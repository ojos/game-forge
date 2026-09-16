import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { planArtifactDeletion } from '../src/build-cache.js';
import { PURGED_TITLE, deleteGame } from '../src/game-deletion.js';
import {
  listAuthoredGames,
  listPublishedGames,
  publishGame,
  removeGame,
  renameGame,
} from '../src/games.js';
import { ogpObjectKey } from '../src/ogp.js';
import { recordReport } from '../src/reports.js';
import { appendRevision, claimRevisionSlot, restoreRevision } from '../src/revisions.js';
import { dispatch } from '../src/routes.js';
import { authorWorksSql } from '../src/users-page.js';
import { listSearchedGames, parseWorkSearch } from '../src/work-search.js';
import { workPagePath, workPageRoutes } from '../src/work-page.js';
import { countingEnv } from './helpers/d1-counting.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作品を消す土台（#516 / M15-1 / 仕様 3.7 / 5.3）。
 *
 * **#516 の acceptance を 1 つずつ機械判定する。**
 *
 * 1. 他の作品の**版だけ**が指しているキーを消さない（版を数えない実装に戻すと赤くなる）
 * 2. 子のいる取り下げ済みの作品は行が残り、子は `published` のまま「削除済みの作品から派生」
 * 3. 通報の付いた作品は行・`reports`・`title_changes` が残り、公開面に題名が出ない
 * 4. 子も記録も無い下書きは、`games` と参照する行が 0 件になり、共有していないキーが消える
 * 5. `published`・生成中・推敲中は断り、何も書き換わらない
 * 6. 版を 30 個持つ作品の削除で、D1 の文が 50 本未満
 * 7. 2 回呼んでも失敗せず、結果が 1 回目と同じ
 *
 * あわせて、**削除を掴んだ行に公開・改名・推敲・版の復元が 0 行になる**ことと、**R2 を消した
 * あとに D1 の確定で落ちても、打ち直せば完了する**ことを見る。
 */

beforeAll(async () => {
  await applySchema();
});

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * 利用者を 1 人用意する。
 *
 * @param label 表示名（テスト内で一意にする必要は無い）
 * @returns 利用者の id
 */
async function seedUser(label: string): Promise<string> {
  const id = `del-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, label)
    .run();
  return id;
}

/** 作品行の下準備。 */
interface SeedGame {
  readonly authorId: string;
  readonly status?: 'draft' | 'published' | 'removed';
  readonly generationState?: 'pending' | 'running' | 'ready' | 'failed';
  readonly parentId?: string | null;
  readonly title?: string;
  /** 成果物のキーの接頭辞（`<prefix>.go` / `<prefix>.wasm.br`）。null ならキーを持たない。 */
  readonly keys?: string | null;
}

/**
 * 作品行を 1 つ作る（**`games` の現行版を `seq = 1` として版にも積む**——本番の完成の経路と同じ）。
 *
 * @param seed 下準備
 * @returns 作品 id と、現行版のキー
 */
async function seedGame(
  seed: SeedGame,
): Promise<{ id: string; sourceKey: string | null; wasmKey: string | null }> {
  const id = crypto.randomUUID();
  const prefix = seed.keys === undefined ? `builds/${id}` : seed.keys;
  const sourceKey = prefix === null ? null : `${prefix}.go`;
  const wasmKey = prefix === null ? null : `${prefix}.wasm.br`;
  const status = seed.status ?? 'draft';
  const state = seed.generationState ?? 'ready';
  await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key, created_at,
        published_at, preview_key, generation_state, ogp_key, ogp_state)
     values (?, ?, ?, ?, ?, 'go1.27.0', ?, ?, 100, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      seed.authorId,
      seed.parentId ?? null,
      status,
      seed.title ?? `題名-${id.slice(0, 8)}`,
      sourceKey,
      wasmKey,
      status === 'draft' ? null : 200,
      state === 'ready' ? crypto.randomUUID() : null,
      state,
      status === 'draft' ? null : ogpObjectKey(id),
      status === 'draft' ? null : 'ready',
    )
    .run();
  if (sourceKey !== null && wasmKey !== null && state === 'ready') {
    await addRevision(id, 1, sourceKey, wasmKey);
    await putObjects(sourceKey, wasmKey);
  }
  return { id, sourceKey, wasmKey };
}

/**
 * 版を 1 つ積む。
 *
 * @param gameId 作品 id
 * @param seq 版の番号
 * @param sourceKey source のキー
 * @param wasmKey wasm のキー
 */
async function addRevision(
  gameId: string,
  seq: number,
  sourceKey: string,
  wasmKey: string,
): Promise<void> {
  await env.DB.prepare(
    `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
     values (?, ?, ?, ?, 'go1.27.0', ?, ?)`,
  )
    .bind(gameId, seq, sourceKey, wasmKey, seq === 1 ? null : `推敲 ${seq}`, 100 + seq)
    .run();
}

/**
 * R2 にオブジェクトを置く。
 *
 * @param keys 置くキー
 */
async function putObjects(...keys: string[]): Promise<void> {
  for (const key of keys) {
    await env.BUCKET.put(key, `body of ${key}`);
  }
}

/**
 * R2 にオブジェクトが在るか。
 *
 * @param key キー
 * @returns 在れば true
 */
async function exists(key: string): Promise<boolean> {
  return (await env.BUCKET.head(key)) !== null;
}

/**
 * ある作品を指す行を、表ごとに数える（**仕様 3.7 の規約 4 が消す表**と、記録の表）。
 *
 * @param gameId 作品 id
 * @returns 表名 → 行数
 */
async function countRows(gameId: string): Promise<Record<string, number>> {
  const tables = [
    'games:id',
    'game_revisions:game_id',
    'game_revision_jobs:game_id',
    'title_changes:game_id',
    'description_changes:game_id',
    'fork_notices:game_id',
    'reports:game_id',
  ];
  const counts: Record<string, number> = {};
  for (const entry of tables) {
    const [table, column] = entry.split(':') as [string, string];
    const row = await env.DB.prepare(`select count(*) as n from ${table} where ${column} = ?`)
      .bind(gameId)
      .first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

/**
 * 作品行を丸ごと読む（「何も書き換わっていない」を比べるため）。
 *
 * @param gameId 作品 id
 * @returns 行（無ければ null）
 */
async function readGame(gameId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('select * from games where id = ?')
    .bind(gameId)
    .first<Record<string, unknown>>();
}


/**
 * 最初の `batch` だけを落とす `Env` を作る（**R2 を消したあと、D1 の確定で落ちた**状態を作る）。
 *
 * @param base 元の `Env`
 * @returns 差し替えた `Env`
 */
function failFirstBatch(base: Env): Env {
  let failed = false;
  const db = new Proxy(base.DB, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return (list: D1PreparedStatement[]): Promise<D1Result[]> => {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('D1 が落ちた（テストの差し込み）'));
          }
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...base, DB: db } as Env;
}

/**
 * 作品ページを未ログインで開き、本文を返す。
 *
 * @param gameId 作品 id
 * @returns HTML
 */
async function openWorkPage(gameId: string): Promise<string> {
  const response = await dispatch(
    workPageRoutes,
    new Request(`${APP_ORIGIN}${workPagePath(gameId)}`),
    env,
  );
  expect(response.status).toBe(200);
  return await response.text();
}

describe('被参照判定に版を含める（#516 の acceptance 1）', () => {
  it('他の作品の版だけが指しているキーを、削除が消さない', async () => {
    const author = await seedUser('版の共有');
    // A は下書き。現行版（seq 1）のキーを、B の古い版だけが指している。
    const a = await seedGame({ authorId: author });
    // A は推敲した版（seq 2。A だけのキー）も持つ。
    const ownSource = `builds/own-rev-${a.id}.go`;
    const ownWasm = `builds/own-rev-${a.id}.wasm.br`;
    await addRevision(a.id, 2, ownSource, ownWasm);
    await putObjects(ownSource, ownWasm);

    // B は公開中。**`games` の現行版は別のキーで、古い版（seq 2）だけが A の現行版と同じキーを
    // 指す**（同じソースの推敲がキャッシュに当たった形。確定26）。B の作者が「版に戻す」を押すと
    // このキーが配信に戻る。**`games` にこのキーを持つ行は A しか無い。**
    const b = await seedGame({ authorId: author, status: 'published' });
    await addRevision(b.id, 2, a.sourceKey!, a.wasmKey!);
    const holders = await env.DB.prepare(
      'select count(*) as n from games where id <> ? and (source_key = ? or wasm_key = ?)',
    )
      .bind(a.id, a.sourceKey, a.wasmKey)
      .first<{ n: number }>();
    expect(holders?.n).toBe(0);

    expect(await deleteGame(env, a.id)).toEqual({ ok: true, result: 'deleted' });

    // **B の版が指すキーは残る。** 版を数えない実装（`games` だけを数える）では消える。
    expect(await exists(a.sourceKey!)).toBe(true);
    expect(await exists(a.wasmKey!)).toBe(true);
    // A だけが指していた版のキーは消える（候補は全版から集める）。
    expect(await exists(ownSource)).toBe(false);
    expect(await exists(ownWasm)).toBe(false);
  });

  it('判定の候補には、対象の作品の全版のキーが入る', async () => {
    const author = await seedUser('候補');
    const game = await seedGame({ authorId: author });
    await addRevision(game.id, 2, `builds/cand2-${game.id}.go`, `builds/cand2-${game.id}.wasm.br`);
    await addRevision(game.id, 3, `builds/cand3-${game.id}.go`, `builds/cand3-${game.id}.wasm.br`);

    const plan = await planArtifactDeletion(env, game.id);
    // **並びは `games` の source → wasm → 版の番号順**（seq 1 は `games` と同じキーなので 1 回だけ）。
    expect(plan.deletable).toEqual([
      game.sourceKey,
      game.wasmKey,
      `builds/cand2-${game.id}.go`,
      `builds/cand2-${game.id}.wasm.br`,
      `builds/cand3-${game.id}.go`,
      `builds/cand3-${game.id}.wasm.br`,
    ]);
    expect(plan.retained).toEqual([]);
  });
});

describe('子のいる作品は行を残す（#516 の acceptance 2）', () => {
  it('取り下げ済みの親を消すと行が残り、子は published のまま「削除済みの作品から派生」が出る', async () => {
    const author = await seedUser('親の作者');
    const forker = await seedUser('改造した人');
    const parent = await seedGame({ authorId: author, status: 'published', title: '消える親の題名' });
    const child = await seedGame({ authorId: forker, status: 'published', parentId: parent.id });
    await renameGame(env, parent.id, author, '消える親の新しい題名', 300);
    expect(await removeGame(env, parent.id, author)).toEqual({ ok: true, firstTime: true });

    expect(await deleteGame(env, parent.id, 400)).toEqual({ ok: true, result: 'purged' });

    const row = await readGame(parent.id);
    expect(row).not.toBeNull();
    expect(row!['status']).toBe('removed');
    expect(row!['purged_at']).toBe(400);
    expect(row!['title']).toBe(PURGED_TITLE);
    expect(row!['source_key']).toBeNull();
    expect(row!['wasm_key']).toBeNull();
    expect(row!['preview_key']).toBeNull();
    expect(row!['ogp_key']).toBeNull();
    // **子がいるだけなら、履歴も消す**（記録が無い）。版も消す。
    expect(await countRows(parent.id)).toMatchObject({
      games: 1,
      game_revisions: 0,
      title_changes: 0,
    });
    // R2 の親の成果物と OGP 画像は消えている（子は別のキー）。
    expect(await exists(parent.sourceKey!)).toBe(false);
    expect(await exists(ogpObjectKey(parent.id))).toBe(false);

    // **子は 1 文字も動いていない。**
    const childRow = await readGame(child.id);
    expect(childRow!['status']).toBe('published');
    expect(childRow!['parent_id']).toBe(parent.id);
    expect(await exists(child.wasmKey!)).toBe(true);

    const childPage = await openWorkPage(child.id);
    expect(childPage).toContain('元ゲーム: 削除済みの作品から派生');
    expect(childPage).not.toContain('消える親の');
  });
});

describe('運営の記録がある作品は行と記録を残す（#516 の acceptance 3）', () => {
  it('通報の付いた作品を消すと、行・reports・title_changes が残り、公開面に題名が出ない', async () => {
    const author = await seedUser('通報された作者');
    const reporter = await seedUser('通報した人');
    const game = await seedGame({ authorId: author, status: 'published', title: '宇宙ねこの冒険' });
    expect((await renameGame(env, game.id, author, '宇宙ねこの大冒険', 300)).ok).toBe(true);

    // 公開中は検索に当たる（下の「当たらない」が検索の不具合で緑になっていないことの確認）。
    const search = parseWorkSearch('宇宙ねこ');
    if (search.kind !== 'accepted') throw new Error('検索語を受け付けなかった');
    expect((await listSearchedGames(env, search, null, 1_000, 0)).map((w) => w.id)).toContain(game.id);

    expect((await recordReport(env, game.id, reporter, '不適切', 350)).ok).toBe(true);
    expect((await removeGame(env, game.id, author)).ok).toBe(true);

    expect(await deleteGame(env, game.id, 400)).toEqual({ ok: true, result: 'purged' });

    const counts = await countRows(game.id);
    expect(counts).toMatchObject({ games: 1, reports: 1, game_revisions: 0 });
    // **改名の履歴は残り、消したことも 1 行積まれる**（通報の時点の題名を履歴から復元できる）。
    expect(counts['title_changes']).toBe(2);
    const last = await env.DB.prepare(
      'select old_title, new_title, changed_at from title_changes where game_id = ? order by changed_at desc limit 1',
    )
      .bind(game.id)
      .first<{ old_title: string; new_title: string; changed_at: number }>();
    expect(last).toEqual({ old_title: '宇宙ねこの大冒険', new_title: PURGED_TITLE, changed_at: 400 });

    // 公開面: 作品ページ（取り下げ済みの表示）・一覧・検索・作者ページ・あなたの作品。
    const page = await openWorkPage(game.id);
    expect(page).toContain('この作品は取り下げられました');
    expect(page).not.toContain('宇宙ねこ');
    const listed = await listPublishedGames(env, 'recent', 1_000, 0);
    expect(listed.map((work) => work.id)).not.toContain(game.id);
    expect(listed.map((work) => work.title)).not.toContain('宇宙ねこの大冒険');
    expect((await listSearchedGames(env, search, null, 1_000, 0)).map((w) => w.id)).not.toContain(
      game.id,
    );
    const authorPage = await env.DB.prepare(authorWorksSql())
      .bind(author, 'published', 1_000, 0)
      .all<{ id: string }>();
    expect(authorPage.results.map((row) => row.id)).not.toContain(game.id);
    expect((await listAuthoredGames(env, author, 1_000)).map((work) => work.id)).not.toContain(
      game.id,
    );
  });

  it.each(['takedown_requests', 'admin_actions', 'moderation_blocks'] as const)('%s の行があれば、下書きでも行を残す', async (table) => {
    const author = await seedUser(`記録 ${table}`);
    const game = await seedGame({ authorId: author, generationState: 'failed', keys: null });
    const recordId = crypto.randomUUID();
    if (table === 'takedown_requests') {
      await env.DB.prepare(
        'insert into takedown_requests (id, game_id, claimant_name, claimant_contact, body, received_at) values (?, ?, ?, ?, ?, 1)',
      )
        .bind(recordId, game.id, '権利者', 'a@example.com', '本文')
        .run();
    } else if (table === 'admin_actions') {
      await env.DB.prepare(
        "insert into admin_actions (id, actor_id, created_at, action, target_kind, target_id, reason) values (?, ?, 1, 'review-queued', 'game', ?, '確認')",
      )
        .bind(recordId, author, game.id)
        .run();
    } else {
      await env.DB.prepare(
        "insert into moderation_blocks (id, game_id, user_id, categories, prompt, created_at) values (?, ?, ?, 'x', 'p', 1)",
      )
        .bind(recordId, game.id, author)
        .run();
    }

    expect(await deleteGame(env, game.id, 500)).toEqual({ ok: true, result: 'purged' });
    const record = await env.DB.prepare(`select count(*) as n from ${table} where id = ?`)
      .bind(recordId)
      .first<{ n: number }>();
    expect(record?.n).toBe(1);
    expect((await readGame(game.id))!['purged_at']).toBe(500);
  });
});

describe('子も記録も無い下書きは行ごと消す（#516 の acceptance 4）', () => {
  it('games と参照する行が 0 件になり、他の作品と共有していない R2 のキーが消える', async () => {
    const author = await seedUser('下書きの作者');
    const other = await seedUser('別の作者');
    const game = await seedGame({ authorId: author });
    // 推敲した版 2（A だけのキー）と、版 3（別の公開作品と共有しているキー）。
    const ownSource = `builds/own-${game.id}.go`;
    const ownWasm = `builds/own-${game.id}.wasm.br`;
    await addRevision(game.id, 2, ownSource, ownWasm);
    await putObjects(ownSource, ownWasm);
    const shared = await seedGame({ authorId: other, status: 'published' });
    await addRevision(game.id, 3, shared.sourceKey!, shared.wasmKey!);
    // 参照する側の表を一通り埋める。
    await renameGame(env, game.id, author, '下書きの新しい題名', 300);
    await env.DB.prepare(
      "insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at) values (?, 'h', 'p', 'failed', 'build-failed', 1, 1)",
    )
      .bind(game.id)
      .run();
    await env.DB.prepare(
      "insert into description_changes (id, game_id, old_description, new_description, changed_at) values (?, ?, '', '説明', 1)",
    )
      .bind(crypto.randomUUID(), game.id)
      .run();
    await env.DB.prepare(
      "insert into fork_notices (game_id, claimed_at, outcome) values (?, 1, 'claimed')",
    )
      .bind(game.id)
      .run();
    await putObjects(ogpObjectKey(game.id));

    expect(await deleteGame(env, game.id)).toEqual({ ok: true, result: 'deleted' });

    expect(await countRows(game.id)).toEqual({
      games: 0,
      game_revisions: 0,
      game_revision_jobs: 0,
      title_changes: 0,
      description_changes: 0,
      fork_notices: 0,
      reports: 0,
    });
    expect(await exists(game.sourceKey!)).toBe(false);
    expect(await exists(game.wasmKey!)).toBe(false);
    expect(await exists(ownSource)).toBe(false);
    expect(await exists(ownWasm)).toBe(false);
    expect(await exists(ogpObjectKey(game.id))).toBe(false);
    // **共有しているキーは残る**（公開中の別の作品が指している）。
    expect(await exists(shared.sourceKey!)).toBe(true);
    expect(await exists(shared.wasmKey!)).toBe(true);
  });
});

describe('進行中・公開中は断り、何も書き換えない（#516 の acceptance 5）', () => {
  /**
   * 断られたことと、何も書き換わっていないことを確かめる。
   *
   * @param gameId 作品 id
   * @param keys 残っているはずの R2 のキー
   * @param reason 期待する理由
   */
  async function expectRejected(
    gameId: string,
    keys: readonly string[],
    reason: string,
  ): Promise<void> {
    const before = await readGame(gameId);
    const rowsBefore = await countRows(gameId);

    expect(await deleteGame(env, gameId, 900)).toEqual({ ok: false, reason });

    expect(await readGame(gameId)).toEqual(before);
    expect(await countRows(gameId)).toEqual(rowsBefore);
    expect((await readGame(gameId))!['deletion_started_at']).toBeNull();
    for (const key of keys) {
      expect(await exists(key), key).toBe(true);
    }
  }

  it('published は断る', async () => {
    const author = await seedUser('公開中');
    const game = await seedGame({ authorId: author, status: 'published' });
    await putObjects(ogpObjectKey(game.id));
    await expectRejected(game.id, [game.sourceKey!, game.wasmKey!, ogpObjectKey(game.id)], 'published');
  });

  it.each(['pending', 'running'] as const)('生成中（%s）は断る', async (state) => {
    const author = await seedUser(`生成中 ${state}`);
    const game = await seedGame({ authorId: author, generationState: state, keys: null });
    await expectRejected(game.id, [], 'generating');
  });

  it.each(['pending', 'running'] as const)('推敲のジョブが %s なら断る', async (state) => {
    const author = await seedUser(`推敲中 ${state}`);
    const game = await seedGame({ authorId: author });
    await env.DB.prepare(
      'insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at) values (?, ?, ?, ?, null, null, 1)',
    )
      .bind(game.id, 'h', '推敲', state)
      .run();
    await expectRejected(game.id, [game.sourceKey!, game.wasmKey!], 'revising');
  });
});

describe('版が多い作品も 1 回で終える（#516 の acceptance 6）', () => {
  it('版を 30 個持つ作品の削除で、D1 の文が 50 本未満である', async () => {
    const author = await seedUser('版が多い');
    const game = await seedGame({ authorId: author });
    for (let seq = 2; seq <= 30; seq += 1) {
      const prefix = `builds/many-${game.id}-${seq}`;
      await addRevision(game.id, seq, `${prefix}.go`, `${prefix}.wasm.br`);
      await putObjects(`${prefix}.go`, `${prefix}.wasm.br`);
      // 版ごとに索引の行もある（本番の完成の経路が書く）。
      await env.DB.prepare(
        `insert into build_cache (source_sha256, go_version, source_key, wasm_key, wasm_bytes, wasm_sha256,
                                  compressed_bytes, compressed_sha256, content_encoding, created_at)
         values (?, 'go1.27.0', ?, ?, 1, 'a', 1, 'b', 'br', 1)`,
      )
        .bind(`many-${game.id}-${seq}`, `${prefix}.go`, `${prefix}.wasm.br`)
        .run();
    }
    const counted = countingEnv(env);

    expect(await deleteGame(counted.env, game.id)).toEqual({ ok: true, result: 'deleted' });

    // 実測は 14 本（掴む 1・R2 の判定 4・確定の batch 9）。**版の数に比例しない。**
    expect(counted.count()).toBeLessThan(50);
    expect(counted.count()).toBe(14);
    expect(await exists(`builds/many-${game.id}-30.wasm.br`)).toBe(false);
    const index = await env.DB.prepare('select count(*) as n from build_cache where source_sha256 like ?')
      .bind(`many-${game.id}-%`)
      .first<{ n: number }>();
    expect(index?.n).toBe(0);
  });
});

describe('冪等である（#516 の acceptance 7）', () => {
  it('行ごと消した作品に 2 回呼んでも失敗せず、結果が同じ', async () => {
    const author = await seedUser('二度押し 消す');
    const game = await seedGame({ authorId: author });
    const first = await deleteGame(env, game.id);
    const second = await deleteGame(env, game.id);
    expect(first).toEqual({ ok: true, result: 'deleted' });
    expect(second).toEqual(first);
    expect(await countRows(game.id)).toMatchObject({ games: 0 });
  });

  it('中身を消した作品に 2 回呼んでも失敗せず、結果が同じで、何も書き換えない', async () => {
    const author = await seedUser('二度押し 残す');
    const parent = await seedGame({ authorId: author, status: 'removed' });
    await seedGame({ authorId: author, status: 'published', parentId: parent.id });
    const first = await deleteGame(env, parent.id, 600);
    const afterFirst = await readGame(parent.id);
    const second = await deleteGame(env, parent.id, 700);
    expect(first).toEqual({ ok: true, result: 'purged' });
    expect(second).toEqual(first);
    // 2 回目は時刻も書き換えない。
    expect(await readGame(parent.id)).toEqual(afterFirst);
  });

  it('R2 を消したあと D1 の確定で落ちても、打ち直せば完了する', async () => {
    const author = await seedUser('途中で落ちる');
    const game = await seedGame({ authorId: author });

    await expect(deleteGame(failFirstBatch(env), game.id, 800)).rejects.toThrow('D1 が落ちた');
    // R2 は消えているが、行と版は残っている（どのキーを消すはずだったかを知る行が残る）。
    expect(await exists(game.wasmKey!)).toBe(false);
    expect(await countRows(game.id)).toMatchObject({ games: 1, game_revisions: 1 });
    expect((await readGame(game.id))!['deletion_started_at']).toBe(800);

    expect(await deleteGame(env, game.id, 900)).toEqual({ ok: true, result: 'deleted' });
    expect(await countRows(game.id)).toMatchObject({ games: 0, game_revisions: 0 });
  });
});

describe('削除を掴んだ行は、公開・改名・推敲・版の復元が 0 行になる', () => {
  /**
   * 削除を掴んだまま D1 の確定で落ちた下書きを作る（R2 は消えている）。
   *
   * @returns 作者と作品
   */
  async function claimedDraft(): Promise<{ author: string; gameId: string }> {
    const author = await seedUser('掴まれた下書き');
    const game = await seedGame({ authorId: author });
    await addRevision(game.id, 2, `builds/claimed-${game.id}.go`, `builds/claimed-${game.id}.wasm.br`);
    await expect(deleteGame(failFirstBatch(env), game.id, 800)).rejects.toThrow();
    return { author, gameId: game.id };
  }

  it('公開できない', async () => {
    const { author, gameId } = await claimedDraft();
    expect(await publishGame(env, gameId, author, 1_000)).toEqual({ ok: false, reason: 'not-found' });
    expect((await readGame(gameId))!['status']).toBe('draft');
  });

  it('改名できない（履歴も積まれない）', async () => {
    const { author, gameId } = await claimedDraft();
    expect(await renameGame(env, gameId, author, '掴まれたあとの題名', 1_000)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect((await countRows(gameId))['title_changes']).toBe(0);
  });

  it('推敲の枠を取れない（ジョブも版も積まれない）', async () => {
    const { author, gameId } = await claimedDraft();
    expect(await claimRevisionSlot(env, gameId, author, '直して', 'token-hash', 1_000)).toBe(false);
    expect(await countRows(gameId)).toMatchObject({ game_revision_jobs: 0, game_revisions: 2 });
  });

  it('完成の処理が遅れて版を積もうとしても、版は積まれず投げない（0041 のトリガ。PR #523 のレビュー）', async () => {
    const { gameId } = await claimedDraft();
    const artifacts = {
      goVersion: 'go1.27.0',
      sourceKey: `builds/late-${gameId}.go`,
      wasmKey: `builds/late-${gameId}.wasm.br`,
    };
    await expect(appendRevision(env, gameId, artifacts, null, 1_000)).resolves.toBeUndefined();
    expect((await countRows(gameId))['game_revisions']).toBe(2);

    // 打ち直して行ごと消えた後も、外部キーで投げない（コールバックを 500 にしない）。
    expect(await deleteGame(env, gameId, 1_100)).toEqual({ ok: true, result: 'deleted' });
    await expect(appendRevision(env, gameId, artifacts, null, 1_200)).resolves.toBeUndefined();
    expect((await countRows(gameId))['game_revisions']).toBe(0);
  });

  it('掴まれていない作品には、版はこれまでどおり積まれる（トリガが広すぎないこと）', async () => {
    const author = await seedUser('トリガの対照');
    const game = await seedGame({ authorId: author });
    await appendRevision(
      env,
      game.id,
      { goVersion: 'go1.27.0', sourceKey: `builds/next-${game.id}.go`, wasmKey: `builds/next-${game.id}.wasm.br` },
      '推敲',
      1_000,
    );
    expect((await countRows(game.id))['game_revisions']).toBe(2);
  });

  it('版に戻せない', async () => {
    const { author, gameId } = await claimedDraft();
    const before = await readGame(gameId);
    expect(await restoreRevision(env, gameId, author, 2, 1_000)).toBe('not-found');
    expect(await readGame(gameId)).toEqual(before);
  });
});
