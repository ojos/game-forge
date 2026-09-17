/**
 * 生成物の質の指標の**保存と結線**（#605 / `src/source-quality-metrics.ts` /
 * `src/source-quality-routes.ts`）。
 *
 * **純粋関数のテスト（`test/source-quality.test.ts`）だけでは足りない**
 * （PR #607 の Copilot の指摘）。指標を計算できても、**書き手が黙って止まれば 1 行も
 * 貯まらないまま、純粋関数のテストは緑のままである。** ここでは D1 と R2 を実際に
 * 触って、書けること・書かないこと・壊れても完成を失敗にしないことを見る。
 *
 * 形は `test/source-input-keys.test.ts` に合わせた（同じ契機・同じ規律の表なので、
 * 見る観点も揃えておくほうが、どちらかにだけ穴が空いたときに気づける）。
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallbackNotifiers } from '../src/generate-callback.js';
import { GENERATE_CALLBACK_PATH, createGenerateCallbackRoutes } from '../src/generate-callback.js';
import { createPendingGame } from '../src/games.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { SOURCE_QUALITY_RULE_VERSION } from '../src/source-quality.js';
import { recordSourceQuality } from '../src/source-quality-metrics.js';
import { withSourceQualityRecording } from '../src/source-quality-routes.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

/** 勝ちと負けの語・色・スプライト・状態を全部持つソース。 */
const RICH_SOURCE = `package main

const (
	stateTitle = iota
	statePlaying
	stateOver
)

var sprite = ebiten.NewImage(8, 8)

func draw() {
	_ = color.RGBA{0x11, 0x22, 0x33, 0xff}
	_ = color.RGBA{0x44, 0x55, 0x66, 0xff}
	_ = "クリア！"
	_ = "ゲームオーバー"
}
`;

/** 何も持たないソース。 */
const PLAIN_SOURCE = 'package main\n\nfunc main() {}\n';

/** 記録するだけの通知（本物のメールを送らない）。 */
const notifiers: CallbackNotifiers = {
  monthlyCostWarning: async () => 'not-configured',
  generationFinished: async () => 'not-configured',
};

/** 包んだコールバックの経路。 */
const wrappedRoutes: readonly Route[] = withSourceQualityRecording(
  createGenerateCallbackRoutes(notifiers),
);

/** アプリのホスト（`test/source-input-keys.test.ts` と同じ取り方）。 */
const APP_ORIGIN = `https://${env.APP_HOST}`;

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
  const id = `sq-user-${unique()}`;
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
  const built = fakeBuildOutcome({
    sourceSha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
  });
  if (source !== null) {
    await env.BUCKET.put(built.keys.sourceKey, source);
  }
  return built.keys;
}

/**
 * コールバックを送る。
 *
 * @param body 本文
 * @returns 応答
 */
async function post(body: unknown): Promise<Response> {
  return await dispatch(
    wrappedRoutes,
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
async function rowOf(sourceKey: string): Promise<{
  has_win_text: number;
  has_lose_text: number;
  color_count: number;
  sprite_count: number;
  state_count: number;
  rule_version: number;
  extracted_at: number;
} | null> {
  return await env.DB.prepare(
    `select has_win_text, has_lose_text, color_count, sprite_count, state_count, rule_version, extracted_at
       from source_quality_metrics where source_key = ?`,
  )
    .bind(sourceKey)
    .first();
}

beforeAll(async () => {
  await applySchema();
});

describe('recordSourceQuality（保存の共有の関数）', () => {
  it('ソースを読んで測り、5 つの指標と規則の版を書く', async () => {
    const keys = await putSource(RICH_SOURCE);
    expect(await recordSourceQuality(env, keys.sourceKey, 1_800_000_000)).toBe('recorded');
    expect(await rowOf(keys.sourceKey)).toEqual({
      has_win_text: 1,
      has_lose_text: 1,
      color_count: 2,
      sprite_count: 1,
      state_count: 3,
      rule_version: SOURCE_QUALITY_RULE_VERSION,
      extracted_at: 1_800_000_000,
    });
  });

  it('何も持たないソースは 0 の行になる（行が無いことと区別する）', async () => {
    const keys = await putSource(PLAIN_SOURCE);
    expect(await recordSourceQuality(env, keys.sourceKey)).toBe('recorded');
    expect(await rowOf(keys.sourceKey)).toMatchObject({
      has_win_text: 0,
      has_lose_text: 0,
      color_count: 0,
      sprite_count: 0,
      state_count: 0,
    });
  });

  it('今の版の行があれば R2 を読まない', async () => {
    const keys = await putSource(RICH_SOURCE);
    await recordSourceQuality(env, keys.sourceKey, 1_800_000_000);
    // **R2 から消しても 'present' になる**＝読みに行っていない。
    await env.BUCKET.delete(keys.sourceKey);
    expect(await recordSourceQuality(env, keys.sourceKey, 1_800_000_999)).toBe('present');
    expect((await rowOf(keys.sourceKey))?.extracted_at).toBe(1_800_000_000);
  });

  it('古い版の行は測り直す', async () => {
    const keys = await putSource(RICH_SOURCE);
    await env.DB.prepare(
      `insert into source_quality_metrics
         (source_key, has_win_text, has_lose_text, color_count, sprite_count, state_count, rule_version, extracted_at)
       values (?, 0, 0, 0, 0, 0, 0, 1)`,
    )
      .bind(keys.sourceKey)
      .run();
    expect(await recordSourceQuality(env, keys.sourceKey, 1_800_000_500)).toBe('recorded');
    expect(await rowOf(keys.sourceKey)).toMatchObject({
      has_win_text: 1,
      rule_version: SOURCE_QUALITY_RULE_VERSION,
      extracted_at: 1_800_000_500,
    });
  });

  it('古い版で書こうとしても、新しい版の行を踏み潰さない', async () => {
    const keys = await putSource(RICH_SOURCE);
    await env.DB.prepare(
      `insert into source_quality_metrics
         (source_key, has_win_text, has_lose_text, color_count, sprite_count, state_count, rule_version, extracted_at)
       values (?, 1, 1, 9, 9, 9, ?, 1)`,
    )
      .bind(keys.sourceKey, SOURCE_QUALITY_RULE_VERSION + 1)
      .run();
    expect(await recordSourceQuality(env, keys.sourceKey)).toBe('present');
    expect((await rowOf(keys.sourceKey))?.color_count).toBe(9);
  });

  it('R2 に無いソースは書かない', async () => {
    const keys = await putSource(null);
    expect(await recordSourceQuality(env, keys.sourceKey)).toBe('source-unreadable');
    expect(await rowOf(keys.sourceKey)).toBeNull();
  });

  it('字句解析が通らないソースは、0 の行を書かずに落とす', async () => {
    // **測れなかったことと、悪い生成であることを区別する。** 0 の行を書くと、
    // 「勝ちの語が無い作品」と同じに見える。
    const keys = await putSource('package main\nvar s = "閉じていない\n');
    expect(await recordSourceQuality(env, keys.sourceKey)).toBe('unparsable');
    expect(await rowOf(keys.sourceKey)).toBeNull();
  });

  it('形の合わないキーは R2 も D1 も触らない', async () => {
    expect(await recordSourceQuality(env, 'builds/not-a-sha/source.go')).toBe('invalid-source-key');
  });
});

describe('完成のコールバックで測る', () => {
  /**
   * 生成中の作品を 1 件、コールバックで完成させる。
   *
   * @param source 完成させるソース
   * @returns 成果物のキー
   */
  async function finish(source: string): Promise<{ sourceKey: string; wasmKey: string }> {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(source);
    await post({ gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    const response = await post({
      gameId: pending.id,
      jobToken: pending.jobToken,
      kind: 'finish',
      artifacts: {
        goVersion: 'go1.26.5',
        sourceKey: keys.sourceKey,
        wasmKey: keys.wasmKey,
        cacheRecord: null,
      },
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    return keys;
  }

  it('受け入れられた完成のあとで行が積まれる', async () => {
    const keys = await finish(RICH_SOURCE);
    expect(await rowOf(keys.sourceKey)).toMatchObject({
      has_win_text: 1,
      state_count: 3,
      rule_version: SOURCE_QUALITY_RULE_VERSION,
    });
  });

  it('受け入れられなかったコールバック（掴みの合図が違う）では書かない', async () => {
    // **`accepted` を見る**（`src/source-quality-routes.ts`）。合図が合わない要求は
    // 200 すら返らないので、R2 にソースがあっても行は積まれない。
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const keys = await putSource(RICH_SOURCE);
    await post({ gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    const response = await post({
      gameId: pending.id,
      jobToken: 'a'.repeat(64),
      kind: 'finish',
      artifacts: {
        goVersion: 'go1.26.5',
        sourceKey: keys.sourceKey,
        wasmKey: keys.wasmKey,
        cacheRecord: null,
      },
    });
    // **受け入れなかった要求も 200 で返る**（`src/generate-callback.ts`）。したがって
    // 状態番号では足りず、本文の `accepted` を見る必要がある。
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: false });
    expect(await rowOf(keys.sourceKey)).toBeNull();
  });

  it('完成ではないコールバック（claim）では書かない', async () => {
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const before = await env.DB.prepare(
      'select count(*) as n from source_quality_metrics',
    ).first<{ n: number }>();
    const response = await post({ gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    expect(response.status).toBe(200);
    const after = await env.DB.prepare(
      'select count(*) as n from source_quality_metrics',
    ).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('測れなくても完成は成功のままである', async () => {
    // **R2 に置かないので測れない。それでもコールバックは受け入れる**
    // （`src/source-quality-metrics.ts` の「完成を失敗にしない」）。
    const userId = await seedUser();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const missing = await putSource(null);
    await post({ gameId: pending.id, jobToken: pending.jobToken, kind: 'claim' });
    const response = await post({
      gameId: pending.id,
      jobToken: pending.jobToken,
      kind: 'finish',
      artifacts: {
        goVersion: 'go1.26.5',
        sourceKey: missing.sourceKey,
        wasmKey: missing.wasmKey,
        cacheRecord: null,
      },
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    expect(await rowOf(missing.sourceKey)).toBeNull();
  });
});
