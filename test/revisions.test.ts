import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
  publishGame,
} from '../src/games.js';
import type { GenerateRequest } from '../src/generate.js';
import { REVISIONS_PER_GAME } from '../src/quota.js';
import {
  appendRevision,
  claimRevisionJob,
  claimRevisionSlot,
  completeRevision,
  failRevision,
  listRevisions,
  restoreRevision,
  revisionStatus,
} from '../src/revisions.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/** 作者を 1 人作る。**利用者ごとに分ける**——`revise_count` は作品ごとなので混ざらない。 */
async function createUser(id: string): Promise<string> {
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 0)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

const REQUEST: GenerateRequest = { prompt: '玉を避けるゲーム' };

/**
 * 完成した作品を 1 件作り、初回の版（`seq = 1`）まで積む。
 *
 * **本番でこの 2 段を踏むのは `src/generate-callback.ts` である。** ここでは
 * 版の表とジョブの表だけを見たいので、その 2 段を畳んでいる。
 *
 * @param userId 作者
 * @param goVersion 初回のビルドに使った Go の版（版ごとに変えて見分ける）
 * @returns 作品 id
 */
async function createReadyGame(userId: string, goVersion = 'go1.27.0'): Promise<string> {
  const pending = await createPendingGame(env, userId, REQUEST);
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  const built = fakeBuildOutcome({ goVersion, sourceSha256: `sha-${pending.id}` });
  await completeGame(env, pending.id, built);
  const row = await env.DB.prepare(
    `select go_version, source_key, wasm_key from games where id = ?`,
  )
    .bind(pending.id)
    .first<{ go_version: string; source_key: string; wasm_key: string }>();
  await appendRevision(
    env,
    pending.id,
    { goVersion: row!.go_version, sourceKey: row!.source_key, wasmKey: row!.wasm_key },
    null,
  );
  return pending.id;
}

describe('版の積み方（5.7）', () => {
  it('初回の生成が seq = 1 を積み、prompt は null になる', async () => {
    const userId = await createUser('rev-seq');
    const gameId = await createReadyGame(userId);

    const revisions = await listRevisions(env, gameId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.seq).toBe(1);
    // **null が正常である。** 初回のプロンプトは確定27 により版から引けない
    // （`migrations/0009_game_revisions.sql`）。
    expect(revisions[0]!.prompt).toBeNull();
    expect(revisions[0]!.current).toBe(true);
  });

  it('seq は表の中で採られ、新しい順に返る', async () => {
    const userId = await createUser('rev-order');
    const gameId = await createReadyGame(userId);

    await appendRevision(
      env,
      gameId,
      { goVersion: 'go1.27.0', sourceKey: 'builds/a/source.go', wasmKey: 'builds/a/game.wasm.br' },
      '玉を速く',
    );

    const revisions = await listRevisions(env, gameId);
    expect(revisions.map((revision) => revision.seq)).toEqual([2, 1]);
    expect(revisions[0]!.prompt).toBe('玉を速く');
  });
});

describe('推敲の枠（5.7 / 確定28）', () => {
  it('作者本人の draft なら枠を取れ、revise_count が 1 増える', async () => {
    const userId = await createUser('rev-claim');
    const gameId = await createReadyGame(userId);

    expect(await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-1')).toBe(true);

    const status = await revisionStatus(env, gameId);
    expect(status.used).toBe(1);
    expect(status.remaining).toBe(REVISIONS_PER_GAME - 1);
    expect(status.running).toBe(true);
  });

  it('作者以外は枠を取れず、revise_count も動かない', async () => {
    const userId = await createUser('rev-owner');
    const other = await createUser('rev-other');
    const gameId = await createReadyGame(userId);

    expect(await claimRevisionSlot(env, gameId, other, '乗っ取り', 'hash-2')).toBe(false);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });

  it('公開済みの作品は推敲できない（5.7 の対象は draft だけ）', async () => {
    const userId = await createUser('rev-published');
    const gameId = await createReadyGame(userId);
    expect((await publishGame(env, gameId, userId)).ok).toBe(true);

    expect(await claimRevisionSlot(env, gameId, userId, '直したい', 'hash-3')).toBe(false);
    expect((await revisionStatus(env, gameId)).used).toBe(0);
  });

  it('走っている推敲があれば 2 本目は断られ、枠も減らない', async () => {
    const userId = await createUser('rev-busy');
    const gameId = await createReadyGame(userId);

    expect(await claimRevisionSlot(env, gameId, userId, '1 本目', 'hash-4a')).toBe(true);
    expect(await claimRevisionSlot(env, gameId, userId, '2 本目', 'hash-4b')).toBe(false);

    // **1 だけ増えていること**が、空振りした要求が枠を食っていない証拠である。
    expect((await revisionStatus(env, gameId)).used).toBe(1);
  });

  it('上限に達すると断られる。失敗した推敲も回数に数える', async () => {
    const userId = await createUser('rev-limit');
    const gameId = await createReadyGame(userId);

    for (let attempt = 1; attempt <= REVISIONS_PER_GAME; attempt += 1) {
      expect(await claimRevisionSlot(env, gameId, userId, `${attempt} 回目`, `hash-5-${attempt}`)).toBe(
        true,
      );
      // **失敗させる。** 版は 1 つも積まれないが、枠は戻らない（0009）。
      expect(await failRevision(env, gameId, 'build-failed')).toBe(true);
    }

    expect(await claimRevisionSlot(env, gameId, userId, '4 回目', 'hash-5-over')).toBe(false);

    const status = await revisionStatus(env, gameId);
    expect(status.used).toBe(REVISIONS_PER_GAME);
    expect(status.remaining).toBe(0);
    expect(status.failed).toBe('build-failed');
    expect(await listRevisions(env, gameId)).toHaveLength(1);
  });
});

describe('推敲の完成と失敗', () => {
  it('完成すると成果物が差し替わり、版が積まれ、preview_key が変わる', async () => {
    const userId = await createUser('rev-complete');
    const gameId = await createReadyGame(userId);
    const before = await env.DB.prepare(`select preview_key from games where id = ?`)
      .bind(gameId)
      .first<{ preview_key: string }>();

    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-6');
    expect(await claimRevisionJob(env, gameId, 'hash-6')).toBe(true);
    expect(
      await completeRevision(env, gameId, 'hash-6', {
        goVersion: 'go1.27.0',
        sourceKey: 'builds/next/source.go',
        wasmKey: 'builds/next/game.wasm.br',
      }),
    ).toBe(true);

    const after = await env.DB.prepare(
      `select preview_key, source_key, generation_state, status from games where id = ?`,
    )
      .bind(gameId)
      .first<{ preview_key: string; source_key: string; generation_state: string; status: string }>();

    expect(after!.source_key).toBe('builds/next/source.go');
    expect(after!.preview_key).not.toBe(before!.preview_key);
    // **推敲は `games` の状態機械を触らない**（0009）。
    expect(after!.generation_state).toBe('ready');
    expect(after!.status).toBe('draft');

    const revisions = await listRevisions(env, gameId);
    expect(revisions.map((revision) => revision.seq)).toEqual([2, 1]);
    expect(revisions[0]!.prompt).toBe('玉を速く');
    expect(revisions[0]!.current).toBe(true);

    // ジョブ行は消えているので、次の推敲を始められる。
    expect((await revisionStatus(env, gameId)).running).toBe(false);
  });

  it('失敗しても作品は無傷のまま（5.3 の整理パスと同じ扱い）', async () => {
    const userId = await createUser('rev-fail');
    const gameId = await createReadyGame(userId);
    const before = await env.DB.prepare(
      `select preview_key, source_key, generation_state from games where id = ?`,
    )
      .bind(gameId)
      .first<{ preview_key: string; source_key: string; generation_state: string }>();

    await claimRevisionSlot(env, gameId, userId, '壊れる修正', 'hash-7');
    await claimRevisionJob(env, gameId, 'hash-7');
    expect(await failRevision(env, gameId, 'build-failed')).toBe(true);

    const after = await env.DB.prepare(
      `select preview_key, source_key, generation_state from games where id = ?`,
    )
      .bind(gameId)
      .first<{ preview_key: string; source_key: string; generation_state: string }>();

    expect(after).toEqual(before);
    expect(await listRevisions(env, gameId)).toHaveLength(1);
  });

  it('握られていないトークンでは完成させられない', async () => {
    const userId = await createUser('rev-token');
    const gameId = await createReadyGame(userId);
    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-8');

    // `claimRevisionJob` を通していない（pending のまま）。
    expect(
      await completeRevision(env, gameId, 'hash-8', {
        goVersion: 'go1.27.0',
        sourceKey: 'builds/x/source.go',
        wasmKey: 'builds/x/game.wasm.br',
      }),
    ).toBe(false);
    expect(await listRevisions(env, gameId)).toHaveLength(1);
  });
});

describe('版へ戻す（5.7）', () => {
  it('戻すと成果物が版のものになり、枠は減らない', async () => {
    const userId = await createUser('rev-restore');
    const gameId = await createReadyGame(userId, 'go1.26.9');
    const original = await env.DB.prepare(`select source_key from games where id = ?`)
      .bind(gameId)
      .first<{ source_key: string }>();

    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-9');
    await claimRevisionJob(env, gameId, 'hash-9');
    await completeRevision(env, gameId, 'hash-9', {
      goVersion: 'go1.27.0',
      sourceKey: 'builds/next/source.go',
      wasmKey: 'builds/next/game.wasm.br',
    });
    const usedBefore = (await revisionStatus(env, gameId)).used;

    expect(await restoreRevision(env, gameId, userId, 1)).toBe('restored');

    const after = await env.DB.prepare(`select source_key, go_version from games where id = ?`)
      .bind(gameId)
      .first<{ source_key: string; go_version: string }>();
    expect(after!.source_key).toBe(original!.source_key);
    expect(after!.go_version).toBe('go1.26.9');

    // **LLM を呼ばないので枠は動かない**（4.2 の 1 段目と同じ層）。
    expect((await revisionStatus(env, gameId)).used).toBe(usedBefore);
    // **版は 1 つも消えない。** 戻したあとにまた新しい版へ戻せる。
    expect(await listRevisions(env, gameId)).toHaveLength(2);
  });

  it('戻した先が current になる', async () => {
    const userId = await createUser('rev-current');
    const gameId = await createReadyGame(userId);
    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-10');
    await claimRevisionJob(env, gameId, 'hash-10');
    await completeRevision(env, gameId, 'hash-10', {
      goVersion: 'go1.27.0',
      sourceKey: 'builds/next/source.go',
      wasmKey: 'builds/next/game.wasm.br',
    });
    await restoreRevision(env, gameId, userId, 1);

    const revisions = await listRevisions(env, gameId);
    expect(revisions.find((revision) => revision.seq === 1)!.current).toBe(true);
    expect(revisions.find((revision) => revision.seq === 2)!.current).toBe(false);
  });

  it('作者以外は戻せない', async () => {
    const userId = await createUser('rev-restore-owner');
    const other = await createUser('rev-restore-other');
    const gameId = await createReadyGame(userId);

    expect(await restoreRevision(env, gameId, other, 1)).toBe('not-found');
  });

  it('推敲が走っている最中は戻せない（90 秒後に黙って上書きされるため）', async () => {
    const userId = await createUser('rev-restore-busy');
    const gameId = await createReadyGame(userId);
    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-11');

    expect(await restoreRevision(env, gameId, userId, 1)).toBe('busy');
  });

  it('存在しない版へは戻せない', async () => {
    const userId = await createUser('rev-restore-missing');
    const gameId = await createReadyGame(userId);

    expect(await restoreRevision(env, gameId, userId, 99)).toBe('not-found');
  });
});
