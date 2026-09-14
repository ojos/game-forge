import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import {
  GENERATE_CALLBACK_PATH,
  createGenerateCallbackRoutes,
  generateCallbackRoutes,
} from '../src/generate-callback.js';
import type { CallbackNotifiers } from '../src/generate-callback.js';
import type { GenerationPipeline } from '../src/generate.js';
import { GenerationNotCompletable, notImplementedPipeline, runJobInline } from '../src/generate.js';
import {
  completeGame,
  createForkedGame,
  createJobToken,
  createPendingGame,
  hashJobToken,
} from '../src/games.js';
import { DEFAULT_GENERATION_MODEL_KEY, findGenerationModel } from '../src/generation-models.js';
import { INPUT_KEYS_RULE_VERSION } from '../src/input-keys.js';
import { claimRevisionSlot, restoreRevision } from '../src/revisions.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import {
  SOURCE_INPUT_KEYS_LOG_TAG,
  SOURCE_INPUT_KEYS_TARGETS_SQL,
  UPSERT_SOURCE_INPUT_KEYS_SQL,
  errorNameOf,
  recordSourceInputKeys,
} from '../src/source-input-keys.js';
import { withSourceInputKeyRecording } from '../src/source-input-keys-routes.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { captureLogs } from './helpers/capture-logs.js';
import { isAllowedSourceInputKeysLine } from './helpers/source-input-keys-log.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;

/** 矢印と Space を読むソース。 */
const ARROWS_SOURCE = `package main

import "github.com/hajimehoshi/ebiten/v2"

func (g *Game) Update() error {
	if ebiten.IsKeyPressed(ebiten.KeyLeft) || ebiten.IsKeyPressed(ebiten.KeyA) {
		g.x--
	}
	if ebiten.IsKeyPressed(ebiten.KeySpace) {
		g.fire()
	}
	return nil
}
`;

/** Z と Escape を読むソース。 */
const BUTTONS_SOURCE = `package main

import "github.com/hajimehoshi/ebiten/v2"

func (g *Game) Update() error {
	_ = ebiten.IsKeyPressed(ebiten.KeyZ) || ebiten.IsKeyPressed(ebiten.KeyEscape)
	return nil
}
`;

/** 記録するだけの通知。**本物のメールを送らない**（`test/generate-callback.test.ts` と同じ理由）。 */
const notifiers: CallbackNotifiers = {
  monthlyCostWarning: async () => 'not-configured',
  generationFinished: async () => 'not-configured',
};

/** 包んだコールバックの経路（通知だけを差し替えた、本番と同じ組み立て）。 */
const wrappedRoutes: readonly Route[] = withSourceInputKeyRecording(createGenerateCallbackRoutes(notifiers));

let counter = 0;

/**
 * テスト内で一意な接尾辞を返す。
 *
 * @returns 接尾辞
 */
function unique(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `sik-user-${unique()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * R2 にソースを置き、そのキーを返す。
 *
 * @param source 本文（null なら置かない＝読めないソース）
 * @returns 成果物のキー
 */
async function putSource(source: string | null): Promise<{ sourceKey: string; wasmKey: string }> {
  const built = fakeBuildOutcome({ sourceSha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0') });
  if (source !== null) {
    await env.BUCKET.put(built.keys.sourceKey, source);
  }
  return built.keys;
}

/**
 * `finish`（成功）の本文。
 *
 * @param keys 成果物のキー
 * @returns `artifacts`
 */
function artifacts(keys: { sourceKey: string; wasmKey: string }): Record<string, unknown> {
  return { goVersion: 'go1.26.5', sourceKey: keys.sourceKey, wasmKey: keys.wasmKey, cacheRecord: null };
}

/**
 * コールバックを送る。
 *
 * @param routes 経路表
 * @param body 本文
 * @returns 応答
 */
async function post(routes: readonly Route[], body: unknown): Promise<Response> {
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/**
 * 保存された行を読む。
 *
 * @param sourceKey ソースのキー
 * @returns 行（無ければ null）
 */
async function rowOf(
  sourceKey: string,
): Promise<{ codes: string[]; rule_version: number; extracted_at: number } | null> {
  const row = await env.DB.prepare(
    'select codes, rule_version, extracted_at from source_input_keys where source_key = ?',
  )
    .bind(sourceKey)
    .first<{ codes: string; rule_version: number; extracted_at: number }>();
  return row === null ? null : { ...row, codes: JSON.parse(row.codes) as string[] };
}

/**
 * 表の行数を数える。
 *
 * @returns 行数
 */
async function rowCount(): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from source_input_keys').first<{ n: number }>();
  return row!.n;
}

/**
 * 生成中の作品を 1 件、コールバックで完成させる（行が積まれるのを待つ土台）。
 *
 * @param source 完成させるソース
 * @returns 作者・作品 id・成果物のキー
 */
async function seedReady(
  source: string,
): Promise<{ userId: string; id: string; keys: { sourceKey: string; wasmKey: string } }> {
  const userId = await seedUser();
  const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
  const keys = await putSource(source);
  await post(wrappedRoutes, { gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
  const response = await post(wrappedRoutes, {
    gameId: pending.id,
    jobToken: pending.jobToken,
    kind: 'finish',
    artifacts: artifacts(keys),
  });
  expect(await response.json()).toEqual({ accepted: true, finished: true });
  return { userId, id: pending.id, keys };
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(() => {
  counter += 1;
});

describe('recordSourceInputKeys（保存の共有の関数。仕様 3.9.5）', () => {
  it('ソースを読んで拾い、code の JSON 配列と規則の版を書く', async () => {
    const keys = await putSource(ARROWS_SOURCE);
    expect(await recordSourceInputKeys(env, keys.sourceKey, 1_800_000_000)).toBe('recorded');
    expect(await rowOf(keys.sourceKey)).toEqual({
      codes: ['ArrowLeft', 'KeyA', 'Space'],
      rule_version: INPUT_KEYS_RULE_VERSION,
      extracted_at: 1_800_000_000,
    });
  });

  it('キーを読まないソースは [] の行になる（行が無いことと区別する）', async () => {
    const keys = await putSource('package main\n\nfunc main() {}\n');
    expect(await recordSourceInputKeys(env, keys.sourceKey)).toBe('recorded');
    expect((await rowOf(keys.sourceKey))?.codes).toEqual([]);
  });

  it('今の版の行があれば R2 を読まない', async () => {
    const keys = await putSource(ARROWS_SOURCE);
    await recordSourceInputKeys(env, keys.sourceKey, 1_800_000_000);
    // **R2 から消しても 'present' になる**＝読みに行っていない。
    await env.BUCKET.delete(keys.sourceKey);
    expect(await recordSourceInputKeys(env, keys.sourceKey, 1_800_000_999)).toBe('present');
    expect((await rowOf(keys.sourceKey))?.extracted_at).toBe(1_800_000_000);
  });

  it('古い版の行は拾い直して上書きする', async () => {
    const keys = await putSource(BUTTONS_SOURCE);
    await env.DB.prepare(
      'insert into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, ?, ?)',
    )
      .bind(keys.sourceKey, '["Stale"]', INPUT_KEYS_RULE_VERSION - 1, 1)
      .run();
    expect(await recordSourceInputKeys(env, keys.sourceKey, 1_800_000_000)).toBe('recorded');
    expect(await rowOf(keys.sourceKey)).toEqual({
      codes: ['Escape', 'KeyZ'],
      rule_version: INPUT_KEYS_RULE_VERSION,
      extracted_at: 1_800_000_000,
    });
  });

  it('ソースが読めなければ行を書かず、固定のタグでログに残す（例外を投げない）', async () => {
    const keys = await putSource(null);
    const { value, lines } = await captureLogs(() => recordSourceInputKeys(env, keys.sourceKey));
    expect(value).toBe('source-unreadable');
    expect(await rowOf(keys.sourceKey)).toBeNull();
    expect(lines.some((line) => line.startsWith(`${SOURCE_INPUT_KEYS_LOG_TAG} `))).toBe(true);
  });

  it('D1 が例外を投げても外へ出さない', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 is down');
        },
      } as unknown as D1Database,
    };
    const { value, lines } = await captureLogs(() => recordSourceInputKeys(broken, 'builds/x/source.go'));
    expect(value).toBe('failed');
    expect(lines.some((line) => line.startsWith(`${SOURCE_INPUT_KEYS_LOG_TAG} `))).toBe(true);
    // 例外の文面（SQL の断片が載りうる）をログへ出さない。
    expect(lines.some((line) => line.includes('D1 is down'))).toBe(false);
  });
});

describe('保存の 1 文（新しい版だけが上書きする）', () => {
  it('同じ版の 2 回目は何も変えない', async () => {
    const key = `builds/upsert-${unique()}/source.go`;
    const write = async (codes: string, version: number, at: number): Promise<void> => {
      await env.DB.prepare(UPSERT_SOURCE_INPUT_KEYS_SQL).bind(key, codes, version, at).run();
    };
    await write('["KeyA"]', 1, 100);
    await write('["KeyB"]', 1, 200);
    expect(await rowOf(key)).toEqual({ codes: ['KeyA'], rule_version: 1, extracted_at: 100 });
    await write('["KeyC"]', 2, 300);
    expect(await rowOf(key)).toEqual({ codes: ['KeyC'], rule_version: 2, extracted_at: 300 });
    // 古い版は新しい版を上書きしない。
    await write('["KeyD"]', 1, 400);
    expect(await rowOf(key)).toEqual({ codes: ['KeyC'], rule_version: 2, extracted_at: 300 });
  });
});

describe('完成のコールバックで拾う（仕様 3.9.5 の「拾う箇所」の 1）', () => {
  it('生成: 完成と同時に行ができる', async () => {
    const { keys } = await seedReady(ARROWS_SOURCE);
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['ArrowLeft', 'KeyA', 'Space']);
  });

  it('フォーク: 子の完成で、子のソースの行ができる', async () => {
    const parent = await seedReady(ARROWS_SOURCE);
    const forkerId = await seedUser();
    const child = await createForkedGame(env, forkerId, { prompt: '改造' }, parent.id);
    const keys = await putSource(BUTTONS_SOURCE);
    await post(wrappedRoutes, { gameId: child.id, jobToken: child.jobToken, kind: 'claim' });
    const response = await post(wrappedRoutes, {
      gameId: child.id,
      jobToken: child.jobToken,
      kind: 'finish',
      artifacts: artifacts(keys),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);
  });

  it('推敲: 差し替えたソースの行ができる。「版に戻す」は何も書かない', async () => {
    const { userId, id, keys: firstKeys } = await seedReady(ARROWS_SOURCE);
    const reviseToken = createJobToken();
    expect(await claimRevisionSlot(env, id, userId, '玉を速く', await hashJobToken(reviseToken))).toBe(true);
    const revisedKeys = await putSource(BUTTONS_SOURCE);
    await post(wrappedRoutes, { gameId: id, jobToken: reviseToken, kind: 'claim' });
    const response = await post(wrappedRoutes, {
      gameId: id,
      jobToken: reviseToken,
      kind: 'finish',
      artifacts: artifacts(revisedKeys),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    expect((await rowOf(revisedKeys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);

    const before = await rowCount();
    expect(await restoreRevision(env, id, userId, 1)).toBe('restored');
    const current = await env.DB.prepare('select source_key from games where id = ?')
      .bind(id)
      .first<{ source_key: string }>();
    expect(current?.source_key).toBe(firstKeys.sourceKey);
    // 戻した先のソースの行は、最初の完成のときの行がそのまま使える。
    expect(await rowCount()).toBe(before);
    expect((await rowOf(firstKeys.sourceKey))?.codes).toEqual(['ArrowLeft', 'KeyA', 'Space']);
  });

  it('戻り値が false の finish（重複配信）でも、行が無ければ拾う', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(ARROWS_SOURCE);
    // **claim していない**ので、`completeGameWithArtifacts` は 0 行更新（false）になる。
    // トークンは一致しているので受け付けられる（`accepted: true`）。
    const response = await post(wrappedRoutes, {
      gameId: pending.id,
      jobToken: pending.jobToken,
      kind: 'finish',
      artifacts: artifacts(keys),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: false });
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['ArrowLeft', 'KeyA', 'Space']);
  });

  it('推敲でも、戻り値が false の finish で拾う', async () => {
    const { userId, id } = await seedReady(ARROWS_SOURCE);
    const reviseToken = createJobToken();
    expect(await claimRevisionSlot(env, id, userId, '敵を増やす', await hashJobToken(reviseToken))).toBe(true);
    const keys = await putSource(BUTTONS_SOURCE);
    // claim していない推敲のジョブ（`pending`）は `completeRevision` が false を返す。
    const response = await post(wrappedRoutes, {
      gameId: id,
      jobToken: reviseToken,
      kind: 'finish',
      artifacts: artifacts(keys),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: false });
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);
  });

  it('トークンが一致しない finish では R2 を読まず、行も書かない', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(ARROWS_SOURCE);
    const response = await post(wrappedRoutes, {
      gameId: pending.id,
      jobToken: createJobToken(),
      kind: 'finish',
      artifacts: artifacts(keys),
    });
    expect(await response.json()).toEqual({ accepted: false });
    expect(await rowOf(keys.sourceKey)).toBeNull();
  });

  it('失敗の finish では何もしない', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const before = await rowCount();
    await post(wrappedRoutes, { gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    const response = await post(wrappedRoutes, {
      gameId: pending.id,
      jobToken: pending.jobToken,
      kind: 'finish',
      errorCode: 'build-failed',
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    expect(await rowCount()).toBe(before);
  });

  it('拾うのに失敗しても、完成は失敗にならない（応答も変わらない）', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(null);
    await post(wrappedRoutes, { gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    const { value: response, lines } = await captureLogs(() =>
      post(wrappedRoutes, {
        gameId: pending.id,
        jobToken: pending.jobToken,
        kind: 'finish',
        artifacts: artifacts(keys),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    const state = await env.DB.prepare('select generation_state from games where id = ?')
      .bind(pending.id)
      .first<{ generation_state: string }>();
    expect(state?.generation_state).toBe('ready');
    expect(await rowOf(keys.sourceKey)).toBeNull();
    expect(lines.some((line) => line.startsWith(`${SOURCE_INPUT_KEYS_LOG_TAG} `))).toBe(true);
  });

  it('アプリの経路表は、完成のコールバックを包んだものを使っている', async () => {
    const appRoute = createAppRoutes(env).find(
      (route) => route.method === 'POST' && route.path === GENERATE_CALLBACK_PATH,
    );
    expect(appRoute).toBeDefined();
    expect(appRoute!.handler).not.toBe(generateCallbackRoutes[0]!.handler);

    // **振る舞いでも確かめる。** 完成の通知が出ない形（claim していない＝finished: false）で送り、
    // 本物の経路表から行ができることを見る（通知を差し替えられないので、メールの出る形は使わない）。
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(BUTTONS_SOURCE);
    const response = await post(createAppRoutes(env), {
      gameId: pending.id,
      jobToken: pending.jobToken,
      kind: 'finish',
      artifacts: artifacts(keys),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: false });
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);
  });
});

describe('同期実行の完成で拾う（仕様 3.9.5 の「拾う箇所」の 2）', () => {
  /**
   * 指定のソースを「ビルドした」ことにする段。
   *
   * @param keys 成果物のキー
   * @param complete `completeGame` の実装
   * @returns 段
   */
  function pipelineFor(
    keys: { sourceKey: string; wasmKey: string },
    complete: GenerationPipeline['completeGame'] = completeGame,
  ): GenerationPipeline {
    return {
      ...notImplementedPipeline,
      generateSource: async () => ({
        modelKey: DEFAULT_GENERATION_MODEL_KEY,
        modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
        source: 'package main',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: null, cacheWriteInputTokens: null },
        stopReason: 'end_turn',
      }),
      recordCost: async () => {},
      inspectSource: () => {},
      build: async () => fakeBuildOutcome({ keys }),
      completeGame: complete,
      startJob: runJobInline,
    };
  }

  it('生成: completeGame のあとで行ができる', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(ARROWS_SOURCE);
    await runJobInline(
      env,
      { gameId: pending.id, jobToken: pending.jobToken, userId, request: { prompt: 'ゲーム' } },
      pipelineFor(keys),
    );
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['ArrowLeft', 'KeyA', 'Space']);
  });

  it('フォーク: 子の completeGame のあとで行ができる', async () => {
    const parent = await seedReady(ARROWS_SOURCE);
    const forkerId = await seedUser();
    const child = await createForkedGame(env, forkerId, { prompt: '改造' }, parent.id);
    const keys = await putSource(BUTTONS_SOURCE);
    await runJobInline(
      env,
      { gameId: child.id, jobToken: child.jobToken, userId: forkerId, request: { prompt: '改造' } },
      pipelineFor(keys),
    );
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);
  });

  it('completeGame が false でも拾い、false はそのまま例外になる', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(BUTTONS_SOURCE);
    await expect(
      runJobInline(
        env,
        { gameId: pending.id, jobToken: pending.jobToken, userId, request: { prompt: 'ゲーム' } },
        pipelineFor(keys, async () => false),
      ),
    ).rejects.toBeInstanceOf(GenerationNotCompletable);
    expect((await rowOf(keys.sourceKey))?.codes).toEqual(['Escape', 'KeyZ']);
  });

  it('拾うのに失敗しても、完成は失敗にならない', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(null);
    await captureLogs(() =>
      runJobInline(
        env,
        { gameId: pending.id, jobToken: pending.jobToken, userId, request: { prompt: 'ゲーム' } },
        pipelineFor(keys),
      ),
    );
    const state = await env.DB.prepare('select generation_state from games where id = ?')
      .bind(pending.id)
      .first<{ generation_state: string }>();
    expect(state?.generation_state).toBe('ready');
    expect(await rowOf(keys.sourceKey)).toBeNull();
  });
});

describe('埋め戻しの対象（仕様 3.9.5「既存作品への埋め戻し」）', () => {
  /**
   * 対象の一覧を読む。
   *
   * @returns 対象の `source_key`
   */
  async function targets(): Promise<string[]> {
    const result = await env.DB.prepare(SOURCE_INPUT_KEYS_TARGETS_SQL)
      .bind(INPUT_KEYS_RULE_VERSION)
      .all<{ source_key: string }>();
    return result.results.map((row) => row.source_key);
  }

  it('行の無いソースと古い版のソースを出し、tombstone（source_key が NULL）は出さない', async () => {
    const { userId, id, keys: currentKeys } = await seedReady(ARROWS_SOURCE);
    // 版の表にだけ残るソース（推敲の前の版）。
    const oldKeys = { sourceKey: `builds/old-${unique()}/source.go`, wasmKey: `builds/old-${unique()}/g.wasm.br` };
    await env.DB.prepare(
      `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
       values (?, 99, ?, ?, 'go1.26.5', null, 1)`,
    )
      .bind(id, oldKeys.sourceKey, oldKeys.wasmKey)
      .run();
    // 古い版の行を持つソース。
    const staleKey = `builds/stale-${unique()}/source.go`;
    const staleGame = await createPendingGame(env, userId, { prompt: '古い' });
    await env.DB.prepare('update games set source_key = ? where id = ?').bind(staleKey, staleGame.id).run();
    await env.DB.prepare(
      'insert into source_input_keys (source_key, codes, rule_version, extracted_at) values (?, ?, ?, 1)',
    )
      .bind(staleKey, '[]', INPUT_KEYS_RULE_VERSION - 1)
      .run();
    // tombstone（source_key が NULL）。
    const tombstone = await createPendingGame(env, userId, { prompt: '取り下げ' });
    await env.DB.prepare('update games set source_key = null where id = ?').bind(tombstone.id).run();

    const listed = await targets();
    expect(listed).toContain(oldKeys.sourceKey);
    expect(listed).toContain(staleKey);
    // 完成のコールバックで拾い済みのソースは出ない。
    expect(listed).not.toContain(currentKeys.sourceKey);
    expect(listed.every((key) => typeof key === 'string' && key !== '')).toBe(true);
    // 同じソースは 1 回だけ出る（和集合）。
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('対象をすべて拾うと、2 回目の対象は読めないソースだけになる（冪等）', async () => {
    const readable = await putSource(BUTTONS_SOURCE);
    const userId = await seedUser();
    const game = await createPendingGame(env, userId, { prompt: '埋め戻し' });
    await env.DB.prepare('update games set source_key = ? where id = ?').bind(readable.sourceKey, game.id).run();

    const first = await targets();
    expect(first).toContain(readable.sourceKey);
    const outcomes = await captureLogs(async () => {
      const results: string[] = [];
      for (const key of first) {
        results.push(await recordSourceInputKeys(env, key));
      }
      return results;
    });
    expect(outcomes.value).not.toContain('failed');

    const second = await targets();
    expect(second).not.toContain(readable.sourceKey);
    // 残るのは R2 に無いソースだけで、それを拾い直しても行は増えない。
    const before = await rowCount();
    await captureLogs(async () => {
      for (const key of second) {
        expect(await recordSourceInputKeys(env, key)).toBe('source-unreadable');
      }
    });
    expect(await rowCount()).toBe(before);
  });
});

describe('ログの行の形（仕様 3.9.5 の「固定のタグ」）', () => {
  it('読めなかった行・失敗した行は許した形に合い、文面や本文を含む行は合わない', async () => {
    const hashKey = `builds/${'d'.repeat(64)}/source.go`;
    const { lines } = await captureLogs(() => recordSourceInputKeys(env, hashKey));
    expect(lines).toEqual([`${SOURCE_INPUT_KEYS_LOG_TAG} source-unreadable source-missing ${hashKey}`]);
    expect(isAllowedSourceInputKeysLine(lines[0]!)).toBe(true);

    const broken = {
      ...env,
      DB: { prepare: () => { throw new TypeError('select * from secrets'); } } as unknown as D1Database,
    };
    const failed = await captureLogs(() => recordSourceInputKeys(broken, hashKey));
    expect(failed.lines).toEqual([`${SOURCE_INPUT_KEYS_LOG_TAG} failed TypeError ${hashKey}`]);
    expect(isAllowedSourceInputKeysLine(failed.lines[0]!)).toBe(true);

    expect(isAllowedSourceInputKeysLine(`${SOURCE_INPUT_KEYS_LOG_TAG} failed select * from ${hashKey}`)).toBe(false);
    expect(isAllowedSourceInputKeysLine(`${SOURCE_INPUT_KEYS_LOG_TAG} source-unreadable package main`)).toBe(false);
  });

  it('例外のクラス名に英字以外が混じれば unknown にする', () => {
    const odd = new Error('x');
    odd.name = 'Bad Name: select';
    expect(errorNameOf(odd)).toBe('unknown');
    expect(errorNameOf('not an error')).toBe('unknown');
    expect(errorNameOf(new RangeError('x'))).toBe('RangeError');
  });
});
