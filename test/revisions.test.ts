import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
  publishGame,
  STALE_AFTER_SECONDS,
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

describe('版が記録されていない作品の推敲（#202）', () => {
  /**
   * #192 より前に完成した作品を再現する。**版を 1 つも持たない `ready` の行**である。
   *
   * @param userId 作者
   * @returns 作品 id と、そのときの成果物
   */
  async function createLegacyGame(
    userId: string,
  ): Promise<{ gameId: string; artifacts: { goVersion: string; sourceKey: string; wasmKey: string } }> {
    const pending = await createPendingGame(env, userId, REQUEST);
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
    await completeGame(
      env,
      pending.id,
      fakeBuildOutcome({ goVersion: 'go1.26.5', sourceSha256: `legacy-${pending.id}` }),
    );
    const row = await env.DB.prepare(
      `select go_version, source_key, wasm_key from games where id = ?`,
    )
      .bind(pending.id)
      .first<{ go_version: string; source_key: string; wasm_key: string }>();
    // **`appendRevision` を呼ばない。** これが #192 より前の行の状態である。
    expect(await listRevisions(env, pending.id)).toHaveLength(0);
    return {
      gameId: pending.id,
      artifacts: {
        goVersion: row!.go_version,
        sourceKey: row!.source_key,
        wasmKey: row!.wasm_key,
      },
    };
  }

  it('推敲を始めると、いまの成果物が seq = 1 として積まれる', async () => {
    const userId = await createUser('rev-legacy');
    const { gameId, artifacts } = await createLegacyGame(userId);

    expect(await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-legacy-1')).toBe(true);

    const revisions = await listRevisions(env, gameId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.seq).toBe(1);
    // 初回のプロンプトは版から引けない（確定27 / 0009）。
    expect(revisions[0]!.prompt).toBeNull();
    expect(revisions[0]!.current).toBe(true);

    const row = await env.DB.prepare(
      `select source_key, wasm_key, go_version from game_revisions where game_id = ? and seq = 1`,
    )
      .bind(gameId)
      .first<{ source_key: string; wasm_key: string; go_version: string }>();
    expect(row).toEqual({
      source_key: artifacts.sourceKey,
      wasm_key: artifacts.wasmKey,
      go_version: artifacts.goVersion,
    });
  });

  it('その推敲の結果は seq = 2 に入り、元の版へ戻せる', async () => {
    const userId = await createUser('rev-legacy-complete');
    const { gameId, artifacts } = await createLegacyGame(userId);
    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-legacy-2');
    await claimRevisionJob(env, gameId, 'hash-legacy-2');
    await completeRevision(env, gameId, 'hash-legacy-2', {
      goVersion: 'go1.27.0',
      sourceKey: 'builds/after/source.go',
      wasmKey: 'builds/after/game.wasm.br',
    });

    const revisions = await listRevisions(env, gameId);
    expect(revisions.map((revision) => revision.seq)).toEqual([2, 1]);
    expect(revisions[0]!.prompt).toBe('玉を速く');

    // **これが #202 の本題である。** 元の版へ戻せなければ、5.7 の約束が果たされない。
    expect(await restoreRevision(env, gameId, userId, 1)).toBe('restored');
    const row = await env.DB.prepare(`select source_key, go_version from games where id = ?`)
      .bind(gameId)
      .first<{ source_key: string; go_version: string }>();
    expect(row!.source_key).toBe(artifacts.sourceKey);
    expect(row!.go_version).toBe(artifacts.goVersion);
  });

  it('版が既にある作品では、余分な seq を積まない', async () => {
    const userId = await createUser('rev-legacy-noop');
    const gameId = await createReadyGame(userId);

    await claimRevisionSlot(env, gameId, userId, '玉を速く', 'hash-legacy-3');

    // 初回の 1 件だけ。**保険が二重に積まないこと。**
    expect(await listRevisions(env, gameId)).toHaveLength(1);
  });

  it('枠を取れなかった要求では、版を積まない', async () => {
    const userId = await createUser('rev-legacy-refused');
    const other = await createUser('rev-legacy-stranger');
    const { gameId } = await createLegacyGame(userId);

    // 他人の要求。**断られた要求で版だけが積まれる経路を作らない。**
    expect(await claimRevisionSlot(env, gameId, other, '乗っ取り', 'hash-legacy-4')).toBe(false);
    expect(await listRevisions(env, gameId)).toHaveLength(0);

    // 公開済みも同じ。
    expect((await publishGame(env, gameId, userId)).ok).toBe(true);
    expect(await claimRevisionSlot(env, gameId, userId, '直したい', 'hash-legacy-5')).toBe(false);
    expect(await listRevisions(env, gameId)).toHaveLength(0);
  });
});

describe('止まったまま残った推敲ジョブ（#480）', () => {
  /**
   * 同じ作品に、指定の時刻に始まった推敲ジョブを 1 本残す（**経路の関数で、時刻だけを与える**）。
   *
   * @param userId 作者
   * @param gameId 作品
   * @param since ジョブの作成（running なら開始も）の時刻
   * @param state 残す状態
   * @returns 残したジョブのトークンのハッシュ
   */
  async function leaveRevisionJob(
    userId: string,
    gameId: string,
    since: number,
    state: 'pending' | 'running',
  ): Promise<string> {
    const hash = `left-${gameId}-${state}-${since}`;
    expect(await claimRevisionSlot(env, gameId, userId, '止まった手直し', hash, since)).toBe(true);
    if (state === 'running') {
      expect(await claimRevisionJob(env, gameId, hash, since)).toBe(true);
    }
    return hash;
  }

  /**
   * 推敲を 1 回完成させ、版を 2 つにする（戻す先を作る）。
   *
   * @param userId 作者
   * @param suffix 利用者ごとに一意な接尾辞
   * @returns 作品 id
   */
  async function createGameWithTwoRevisions(userId: string, suffix: string): Promise<string> {
    const gameId = await createReadyGame(userId, 'go1.26.9');
    const hash = `done-${suffix}`;
    expect(await claimRevisionSlot(env, gameId, userId, '玉を速く', hash)).toBe(true);
    expect(await claimRevisionJob(env, gameId, hash)).toBe(true);
    expect(
      await completeRevision(env, gameId, hash, {
        goVersion: 'go1.27.0',
        sourceKey: `builds/${suffix}/source.go`,
        wasmKey: `builds/${suffix}/game.wasm.br`,
      }),
    ).toBe(true);
    return gameId;
  }

  /**
   * 作品の成果物 3 点と `preview_key` を読む（戻す操作が動かす列のすべて）。
   *
   * @param gameId 作品 id
   * @returns 列の値
   */
  async function gameArtifactsOf(
    gameId: string,
  ): Promise<{ go_version: string; source_key: string; wasm_key: string; preview_key: string }> {
    const row = await env.DB.prepare(
      'select go_version, source_key, wasm_key, preview_key from games where id = ?',
    )
      .bind(gameId)
      .first<{ go_version: string; source_key: string; wasm_key: string; preview_key: string }>();
    expect(row).not.toBeNull();
    return row!;
  }

  /**
   * 開始からの経過秒と、そのとき「走っている」と見なすか。
   *
   * **境界は #455 と同じである**（開始から `STALE_AFTER_SECONDS` 未満が進行中。ちょうどで外れる）。
   * 値は `src/games.ts` から読み、書き写さない。
   */
  const BOUNDARY: readonly { readonly elapsed: number; readonly running: boolean }[] = [
    { elapsed: STALE_AFTER_SECONDS - 60, running: true },
    { elapsed: STALE_AFTER_SECONDS - 1, running: true },
    { elapsed: STALE_AFTER_SECONDS, running: false },
    { elapsed: STALE_AFTER_SECONDS + 1, running: false },
  ];

  for (const state of ['pending', 'running'] as const) {
    it(`revisionStatus: ${state} のジョブは開始から区切り未満だけ running、ちょうど区切りから stalled になる`, async () => {
      const userId = await createUser(`rev-stalled-status-${state}`);
      const gameId = await createReadyGame(userId);
      const since = 3_000_000;
      await leaveRevisionJob(userId, gameId, since, state);

      for (const { elapsed, running } of BOUNDARY) {
        const status = await revisionStatus(env, gameId, since + elapsed);
        expect({ elapsed, running: status.running, stalled: status.stalled }).toEqual({
          elapsed,
          running,
          stalled: !running,
        });
        // 止まった推敲は失敗ではない（分類名を持たない）。枠の数え方も変わらない。
        expect(status.failed).toBeNull();
        expect(status.used).toBe(1);
        expect(status.remaining).toBe(REVISIONS_PER_GAME - 1);
      }

      // **読むだけで行を書き換えない**（掃除は #480 の scope.out。作品ページは GET で呼ぶ）。
      const row = await env.DB.prepare(
        'select state, error from game_revision_jobs where game_id = ?',
      )
        .bind(gameId)
        .first<{ state: string; error: string | null }>();
      expect(row).toEqual({ state, error: null });
    });

    it(`restoreRevision: ${state} のジョブは区切り未満なら busy、ちょうど区切りからは戻せる`, async () => {
      for (const { elapsed, running } of BOUNDARY) {
        const suffix = `rev-stalled-restore-${state}-${elapsed}`;
        const userId = await createUser(suffix);
        const gameId = await createGameWithTwoRevisions(userId, suffix);
        const since = 3_000_000;
        const hash = await leaveRevisionJob(userId, gameId, since, state);
        const before = await gameArtifactsOf(gameId);

        const outcome = await restoreRevision(env, gameId, userId, 1, since + elapsed);
        expect({ elapsed, outcome }).toEqual({ elapsed, outcome: running ? 'busy' : 'restored' });

        const after = await gameArtifactsOf(gameId);
        // 断ったなら成果物は推敲後（seq = 2）のまま、通ったなら最初の版（seq = 1）。
        expect(after.go_version).toBe(running ? 'go1.27.0' : 'go1.26.9');
        if (running) {
          // **断ったときは `preview_key` も含めて 1 列も動かない**——戻す `update` 自体が
          // 0 行である（事前の select は無い。PR #485 のレビュー）。
          expect(after).toEqual(before);
        }

        // **止まった行は書き換えない**（掃除は scope.out）。次の推敲の UPSERT が引き取る。
        const job = await env.DB.prepare(
          'select state, job_token_hash from game_revision_jobs where game_id = ?',
        )
          .bind(gameId)
          .first<{ state: string; job_token_hash: string }>();
        expect(job).toEqual({ state, job_token_hash: hash });
      }
    });
  }

  for (const state of ['pending', 'running'] as const) {
    it(`止まった ${state} の行を次の推敲が引き取ったあとの「版に戻す」は、戻す文そのものが 0 行で busy になる（PR #485 のレビュー）`, async () => {
      const suffix = `rev-stalled-takeover-${state}`;
      const userId = await createUser(suffix);
      const gameId = await createGameWithTwoRevisions(userId, suffix);
      const since = 3_000_000;
      await leaveRevisionJob(userId, gameId, since, state);
      const now = since + STALE_AFTER_SECONDS + 5;

      // 止まった行は戻す理由にならない…はずの時刻に、**先に**推敲の要求が行を引き取る。
      // これがレビューで指摘された「確かめてから書く」の隙間に入る順序である。
      expect(await claimRevisionSlot(env, gameId, userId, '引き取った手直し', `taken-${suffix}`, now)).toBe(
        true,
      );
      const before = await gameArtifactsOf(gameId);

      // 同じ時刻の「版に戻す」。引き取られた行は区切りの内側の `pending` なので、断る。
      expect(await restoreRevision(env, gameId, userId, 1, now)).toBe('busy');
      // **成果物も `preview_key` も動かない。** 戻した結果が推敲の完成で上書きされる形を作らない。
      expect(await gameArtifactsOf(gameId)).toEqual(before);
    });
  }

  it('走っている推敲があっても、他人の要求では何も書かない（分類は busy のまま）', async () => {
    const suffix = 'rev-live-stranger';
    const userId = await createUser(suffix);
    const other = await createUser(`${suffix}-other`);
    const gameId = await createGameWithTwoRevisions(userId, suffix);
    const since = 3_000_000;
    await leaveRevisionJob(userId, gameId, since, 'running');
    const before = await gameArtifactsOf(gameId);

    // **分類は main と同じく busy**（以前は作者を見る前に busy を返していた）。書き込みは 0 行。
    expect(await restoreRevision(env, gameId, other, 1, since + 1)).toBe('busy');
    expect(await gameArtifactsOf(gameId)).toEqual(before);
    // 区切りを過ぎても、他人の要求は見つからない扱いのまま。
    expect(await restoreRevision(env, gameId, other, 1, since + STALE_AFTER_SECONDS)).toBe('not-found');
    expect(await gameArtifactsOf(gameId)).toEqual(before);
  });

  it('失敗したジョブは stalled にならない（失敗の表示のまま）', async () => {
    const userId = await createUser('rev-stalled-failed');
    const gameId = await createReadyGame(userId);
    const since = 3_000_000;
    await leaveRevisionJob(userId, gameId, since, 'running');
    expect(await failRevision(env, gameId, 'build-failed')).toBe(true);

    const status = await revisionStatus(env, gameId, since + STALE_AFTER_SECONDS * 10);
    expect(status).toMatchObject({ running: false, stalled: false, failed: 'build-failed' });
  });
});
