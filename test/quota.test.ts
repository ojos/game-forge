import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAILY_QUOTA_PATTERN,
  DAILY_QUOTA_PER_USER,
  DAILY_QUOTA_REASON,
  MONTHLY_COST_LIMIT_JPY,
  MONTHLY_LIMIT_PATTERN,
  MONTHLY_LIMIT_REASON,
  MONTHLY_WARNING_RATIO,
  QUOTA_EXCEEDED_STATUS,
  QUOTA_REJECTION_REASONS,
  UNCLASSIFIED_QUOTA_CODE,
  WARNING_THRESHOLD_PATTERN,
  checkGenerationQuota,
  dailyCallCount,
  describeQuotaRejection,
  isQuotaRejectionReason,
  jstDayRange,
  monthlyCostWarning,
  monthlyCostWarningOf,
} from '../src/quota.js';
import { jstMonthRange, recordGeneration } from '../src/cost-ledger.js';
import {
  defaultPipeline,
  notImplementedPipeline,
  runJobInline,
  startGeneration,
  QuotaExceeded,
} from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import type { GenerationResult } from '../src/generation-models.js';
import type { QuotaExceededBody } from '../src/quota.js';
import { applySchema } from './helpers/schema.js';

/** 判定の基準時刻。2020-05-15 12:00 JST（= 03:00 UTC）。 */
const AT = Date.UTC(2020, 4, 15, 3) / 1000;

/** 1 日（秒）。 */
const DAY = 24 * 60 * 60;

/**
 * 利用者を 1 人用意する（`generations.user_id` は `users` を参照する）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `quota-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 台帳へ行を直接置く。
 *
 * **`recordGeneration` を使わないのは金額のためだけである。** 月次上限（1 万円）へ
 * 到達させるには実測どおりの生成が約 1,000 回要る（4.2 の 9.9 円/生成）。判定側が
 * 見るのは `user_id` / `created_at` / `cost_jpy` の 3 列だけなので、そこを直接置く。
 * **台帳の書き手と読み手の単位が一致していること**は、下の「台帳へ実際に記録した
 * 行が枠を消費する」が `recordGeneration` そのもので確かめる。
 *
 * @param userId 利用者の id
 * @param at 記録時刻（UNIX 秒）
 * @param costJpy 円換算の費用
 * @returns なし
 */
async function seedLedgerRow(userId: string, at: number, costJpy = 0): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, ?, 1, ?)`,
  )
    .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, costJpy, at)
    .run();
}

/**
 * 同じ利用者・同じ時刻の行を n 件置く。
 *
 * @param userId 利用者の id
 * @param count 件数
 * @param at 記録時刻（UNIX 秒）
 * @returns なし
 */
async function seedCalls(userId: string, count: number, at: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedLedgerRow(userId, at);
  }
}

beforeAll(async () => {
  await applySchema();
});

afterEach(async () => {
  // **月次上限はサービス全体の累計で判定する。** テスト間で行が残ると、前のテストが
  // 積んだ 1 万円が次のテストの判定に効く（実際に落ちた）。**このファイルが作った行
  // だけを消す。** `generations` を丸ごと空にすると、他のテストファイルと storage を
  // 共有していた場合にそちらを壊す。
  await env.DB.prepare("delete from generations where user_id like 'quota-user-%'").run();
});

describe('しきい値の機械照合（4.3 / 確定25）', () => {
  /**
   * 仕様書から数値を拾う。
   *
   * @param pattern 拾う形
   * @param spec 仕様書の本文
   * @returns 見つかった数値の配列（1 件の一致につき最初の捕獲群）
   */
  function valuesIn(pattern: RegExp, spec: string): number[] {
    return [...spec.matchAll(pattern)].map((matched) => Number(matched[1]));
  }

  it('月次上限の宣言とコード側の定数が一致する', () => {
    // 同じ数値が仕様書とコードの 2 か所にある以上、機械で照合する
    // （shared-ai-rules 12 章）。ずれると 4.3 の停止位置が静かに動く。
    const values = valuesIn(MONTHLY_LIMIT_PATTERN, env.TEST_PRODUCT_SPEC);
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      expect(value * 10_000).toBe(MONTHLY_COST_LIMIT_JPY);
    }
  });

  it('日次クォータの宣言とコード側の定数が一致する', () => {
    const values = valuesIn(DAILY_QUOTA_PATTERN, env.TEST_PRODUCT_SPEC);
    // 4.3 の本文・見出し・4.4・確定25 の表など複数箇所に書かれている。
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      expect(value).toBe(DAILY_QUOTA_PER_USER);
    }
  });

  it('警告と停止のしきい値の宣言と定数が一致する', () => {
    const matched = [...env.TEST_PRODUCT_SPEC.matchAll(WARNING_THRESHOLD_PATTERN)];
    expect(matched.length).toBeGreaterThan(0);
    for (const one of matched) {
      expect(Number(one[1]) / 100).toBe(MONTHLY_WARNING_RATIO);
      // 停止は 100%、すなわち上限そのものである（定数を分けていない）。
      expect(Number(one[2]) / 100).toBe(1);
    }
  });

  it('仕様書側を変異させると照合が破れる', () => {
    // **この検査が効いていることを確かめる。** 上の 3 件は、正規表現が何も拾わない
    // 状態でも「すべて一致」で通りうる（`length` の検査はその一部しか塞がない）。
    const doctoredLimit = env.TEST_PRODUCT_SPEC.replace(
      '**上限額: 1万円/月。**',
      '**上限額: 2万円/月。**',
    );
    expect(doctoredLimit).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(valuesIn(MONTHLY_LIMIT_PATTERN, doctoredLimit)).toContain(2);

    const doctoredQuota = env.TEST_PRODUCT_SPEC.replace(
      '1 利用者・1 暦日あたり **12 回**',
      '1 利用者・1 暦日あたり **20 回**',
    );
    expect(doctoredQuota).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(valuesIn(DAILY_QUOTA_PATTERN, doctoredQuota)).toContain(20);
  });
});

describe('日の境界は JST の 0 時（確定25）', () => {
  it('JST の 0 時から 24 時間を切る', () => {
    // 2020-05-15 00:00 JST = 2020-05-14 15:00 UTC。
    const day = jstDayRange(AT);
    expect(new Date(day.fromSeconds * 1000).toISOString()).toBe('2020-05-14T15:00:00.000Z');
    expect(day.toSeconds - day.fromSeconds).toBe(DAY);
  });

  it('UTC で切らない（日本時間の朝 9 時に枠が戻らない）', () => {
    // 2020-05-15 15:30 UTC は JST では既に 2020-05-16 の 0 時 30 分である。
    // UTC で切る実装だと、この時刻の枠は 5/15 の枠と同じものになる。
    const utcSameDay = jstDayRange(Date.UTC(2020, 4, 15, 15, 30) / 1000);
    expect(new Date(utcSameDay.fromSeconds * 1000).toISOString()).toBe(
      '2020-05-15T15:00:00.000Z',
    );
    expect(utcSameDay.fromSeconds).not.toBe(jstDayRange(Date.UTC(2020, 4, 15, 3) / 1000).fromSeconds);
  });

  it('月の境界は日の境界でもある（台帳側とずれていない）', () => {
    // **日と月で基準がずれていないことを機械で見る。** 時差の定数は
    // `src/quota.ts` と `src/cost-ledger.ts` の 2 か所にあるため、片方だけ動かした
    // ときにここが落ちる。
    for (const month of [0, 1, 2, 6, 11]) {
      const monthRange = jstMonthRange(Date.UTC(2024, month, 15) / 1000);
      expect(jstDayRange(monthRange.fromSeconds).fromSeconds).toBe(monthRange.fromSeconds);
      expect(jstDayRange(monthRange.toSeconds).fromSeconds).toBe(monthRange.toSeconds);
    }
  });
});

describe('日次判定用のインデックス（migrations/0005）', () => {
  it('`generations(user_id, created_at)` がこの順で張られている', async () => {
    // **列の順が効きを決める。** `user_id` の等値で絞ってから `created_at` の範囲を
    // 取るので、逆順だと 0003 の `(created_at)` とほぼ同じ効きしか持たない
    // （当日の全利用者の行を読んでから捨てる）。D1 は読み取りも従量である（3.6）。
    const info = await env.DB.prepare('select * from pragma_index_info(?)')
      .bind('generations_user_id_created_at_idx')
      .all<{ name: string }>();
    expect(info.results.map((row) => row.name)).toEqual(['user_id', 'created_at']);
  });
});

describe('日次クォータ（確定25 / acceptance 3）', () => {
  it('枠の残りがあれば許可する', async () => {
    const userId = await seedUser('daily-under');
    await seedCalls(userId, DAILY_QUOTA_PER_USER - 1, AT);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({ allowed: true });
  });

  it('枠を使い切ると拒否する', async () => {
    // **12 回目までは通り、13 回目を止める。** 判定は生成の手前にあるので、
    // 「既に 12 回ぶんの行がある」状態が使い切りである。
    const userId = await seedUser('daily-full');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'daily-quota',
      resetsAt: jstDayRange(AT).toSeconds,
    });
  });

  it('翌日には枠が戻る（acceptance 3）', async () => {
    // **同じ行のまま、時刻だけを翌日にする。** 行を消して確かめると「消したから
    // 通った」だけになり、境界で戻ることの証拠にならない。
    const userId = await seedUser('daily-reset');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'daily-quota',
      resetsAt: jstDayRange(AT).toSeconds,
    });

    const nextDay = jstDayRange(AT).toSeconds;
    expect(await checkGenerationQuota(env, userId, nextDay)).toEqual({ allowed: true });
    expect((await dailyCallCount(env, userId, nextDay)).calls).toBe(0);
  });

  it('拒否は翌日の再開時刻を伴う（4.4 / #132）', async () => {
    // 4.4 は「本日の枠は終了しました」と**翌日の再開時刻**を示すことを求める。
    // 判定はすでに境界を計算しているので、**同じ境界を経路層や画面で計算し直さない**
    // ように、拒否そのものへ乗せて返す（shared-ai-rules 12 章）。
    const userId = await seedUser('daily-resets-at');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    const decision = await checkGenerationQuota(env, userId, AT);
    // **型でも日次に絞る。** 月次の拒否は再開時刻を持たない（4.4 が求めていない）。
    const resetsAt =
      !decision.allowed && decision.reason === DAILY_QUOTA_REASON ? decision.resetsAt : 0;

    // 2020-05-16 00:00 JST = 2020-05-15 15:00 UTC。**判定時刻より後の、翌日の 0 時**。
    expect(new Date(resetsAt * 1000).toISOString()).toBe('2020-05-15T15:00:00.000Z');
    expect(resetsAt).toBeGreaterThan(AT);
    expect(resetsAt - jstDayRange(AT).fromSeconds).toBe(DAY);
  });

  it('境界は JST の 0 時であって UTC の 0 時ではない', () => {
    // **この検査が時差の変異を捕まえる。** 枠が戻る時刻を UTC 0 時にすると、
    // 下の 2 つの期待が同時に破れる。
    const day = jstDayRange(AT);
    // 5/15 23:59:59 JST は当日の枠。
    expect(jstDayRange(day.toSeconds - 1).fromSeconds).toBe(day.fromSeconds);
    // 5/16 00:00:00 JST（= 5/15 15:00 UTC）は翌日の枠。
    expect(jstDayRange(day.toSeconds).fromSeconds).toBe(day.toSeconds);
  });

  it('前日と翌日の行は当日の枠を消費しない', async () => {
    const userId = await seedUser('daily-neighbours');
    const day = jstDayRange(AT);
    // 当日の最初の 1 秒と最後の 1 秒は数える。
    await seedLedgerRow(userId, day.fromSeconds);
    await seedLedgerRow(userId, day.toSeconds - 1);
    // 前日の最終秒と翌日の先頭は数えない。
    await seedLedgerRow(userId, day.fromSeconds - 1);
    await seedLedgerRow(userId, day.toSeconds);
    expect((await dailyCallCount(env, userId, AT)).calls).toBe(2);
  });

  it('他人の生成は自分の枠を消費しない', async () => {
    // 日次クォータは 1 人あたりの蓋である（4.3）。
    const mine = await seedUser('daily-mine');
    const theirs = await seedUser('daily-theirs');
    await seedCalls(theirs, DAILY_QUOTA_PER_USER, AT);
    expect((await dailyCallCount(env, mine, AT)).calls).toBe(0);
    expect(await checkGenerationQuota(env, mine, AT)).toEqual({ allowed: true });
  });

  it('台帳へ実際に記録した行が枠を消費する（数える単位が一致している）', async () => {
    // **`recordGeneration` そのもので確かめる。** 台帳が 1 呼び出しにつき 1 行を作り、
    // 枠がその行を数える、という単位の一致がここで初めて閉じる（確定25）。
    const userId = await seedUser('daily-ledger');
    const generated: GenerationResult = {
      modelKey: DEFAULT_GENERATION_MODEL_KEY,
      modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
      source: 'package main',
      usage: {
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
      },
      stopReason: 'end_turn',
    };
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await recordGeneration(env, { userId, prompt: 'ゲーム', generated }, AT);
    }
    expect((await dailyCallCount(env, userId, AT)).calls).toBe(DAILY_QUOTA_PER_USER);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'daily-quota',
      resetsAt: jstDayRange(AT).toSeconds,
    });
  });

  it('失敗した呼び出しも枠を消費する', async () => {
    // 4.3 は成否を問わず全件を記録する。**失敗にも課金は発生している**ので、
    // 成功だけを数えると失敗を繰り返すだけで枠が減らない経路ができる。
    const userId = await seedUser('daily-failed');
    const failed: GenerationResult = {
      modelKey: DEFAULT_GENERATION_MODEL_KEY,
      modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
      source: 'package main',
      usage: {
        inputTokens: 1_000,
        outputTokens: 16_000,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
      },
      stopReason: 'max_tokens',
    };
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await recordGeneration(env, { userId, prompt: 'ゲーム', generated: failed }, AT);
    }
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'daily-quota',
      resetsAt: jstDayRange(AT).toSeconds,
    });
  });
});

describe('月次上限（4.3 層 1）', () => {
  it('上限ちょうどで止まる', async () => {
    const userId = await seedUser('monthly-at-limit');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'monthly-limit',
    });
  });

  it('上限の 1 銭手前では止まらない', async () => {
    // **上限値そのものを固定する検査である。** 定数を動かすと、この 2 件のどちらかが落ちる。
    const userId = await seedUser('monthly-below-limit');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY - 0.01);
    const decision = await checkGenerationQuota(env, userId, AT);
    expect(decision.allowed).toBe(true);
  });

  it('サービス全体の累計で止まる（他人の費用でも止まる）', async () => {
    // 4.3 の 1 万円は全体の上限である。1 人あたりの蓋は日次クォータのほうが持つ。
    const spender = await seedUser('monthly-spender');
    const newcomer = await seedUser('monthly-newcomer');
    await seedLedgerRow(spender, AT, MONTHLY_COST_LIMIT_JPY);
    // 生成が 1 度も無い利用者でも止まる。
    expect((await dailyCallCount(env, newcomer, AT)).calls).toBe(0);
    expect(await checkGenerationQuota(env, newcomer, AT)).toEqual({
      allowed: false,
      reason: 'monthly-limit',
    });
  });

  it('翌月には戻る', async () => {
    const userId = await seedUser('monthly-reset');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    const nextMonth = jstMonthRange(AT).toSeconds;
    expect(await checkGenerationQuota(env, userId, nextMonth)).toEqual({ allowed: true });
  });

  /**
   * `prepare` に渡った SQL を記録する D1 を持つ env を作る。
   *
   * **読み取りの回数そのものを見るために要る。** 「日次を読まない」は結果の値には
   * 現れないので、値の検査では捕まらない。
   *
   * @returns 記録された SQL と、差し替えた env
   */
  function countingEnv(): { readonly queries: string[]; readonly env: Env } {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return env.DB.prepare(query);
      },
    } as unknown as D1Database;
    return { queries, env: { ...env, DB: db } };
  }

  it('月次で止まったときは日次を読まない（#122 のレビュー指摘 1）', async () => {
    // **D1 は読み取りも従量である**（3.6）。サービス全体が停止している間は生成の
    // たびにこの段へ入るので、**止まっている間ほど無駄な読み取りが積み上がる。**
    const userId = await seedUser('monthly-short-circuit');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    const counting = countingEnv();

    expect(await checkGenerationQuota(counting.env, userId, AT)).toEqual({
      allowed: false,
      reason: 'monthly-limit',
    });
    expect(counting.queries).toHaveLength(1);
    expect(counting.queries[0]).toContain('sum(cost_jpy)');
    expect(counting.queries.join('\n')).not.toContain('user_id = ?');
  });

  it('月次を通ったときは日次も読む', async () => {
    // **片側だけを見ない。** 「日次を読まない」だけを固定すると、日次を一切読まない
    // 実装（＝確定25 が効かない）でも通る。
    const userId = await seedUser('monthly-then-daily');
    const counting = countingEnv();

    expect(await checkGenerationQuota(counting.env, userId, AT)).toEqual({ allowed: true });
    expect(counting.queries).toHaveLength(2);
    expect(counting.queries[1]).toContain('user_id = ?');
  });

  it('月次を日次より先に判定する', async () => {
    // 全体が止まっているときに「本日の枠は残っています」と読める理由を返さない。
    // 4.4 の文言（「今月の生成は終了しました」）と食い違う。
    const userId = await seedUser('monthly-first');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'monthly-limit',
    });
  });
});

describe('80% 到達時の警告（4.3 / acceptance 2）', () => {
  it('80% で警告フラグが立つ', async () => {
    const userId = await seedUser('warn-at-80');
    const cost = MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO;
    await seedLedgerRow(userId, AT, cost);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: true,
      warning: {
        kind: 'monthly-cost',
        costJpy: cost,
        limitJpy: MONTHLY_COST_LIMIT_JPY,
        ratio: MONTHLY_WARNING_RATIO,
      },
    });
  });

  it('80% の手前では立たない', async () => {
    // しきい値そのものを固定する。0.8 を動かすと、この検査か上の検査が落ちる。
    const userId = await seedUser('warn-below-80');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO - 0.01);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({ allowed: true });
  });

  it('警告は停止ではない（上限までは生成できる）', async () => {
    // 4.3 は「80% で警告、100% で生成停止」である。警告で止めると枠の 2 割を捨てる。
    const userId = await seedUser('warn-not-stop');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY - 1);
    const decision = await checkGenerationQuota(env, userId, AT);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true ? decision.warning?.kind : null).toBe('monthly-cost');
  });

  it('上限に達したら警告ではなく拒否になる', async () => {
    const userId = await seedUser('warn-then-stop');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    const decision = await checkGenerationQuota(env, userId, AT);
    expect(decision.allowed).toBe(false);
    // **警告は「許可」に付く。** 拒否の値に警告が混ざると、経路層が
    // 「拒否だが通してよい」を判断する場所になる。
    expect('warning' in decision).toBe(false);
  });

  it('日次で拒否されるときも判定は月次の状態を見ている', async () => {
    // 日次で止まった利用者にも月次の警告は成立するが、**返すのは拒否だけ**である。
    // 表示は 4.4 / #24 の範囲で、この層は「使われない段を先に作らない」。
    const userId = await seedUser('warn-daily-denied');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO);
    expect(await checkGenerationQuota(env, userId, AT)).toEqual({
      allowed: false,
      reason: 'daily-quota',
      resetsAt: jstDayRange(AT).toSeconds,
    });
  });
});

describe('429 の応答へ落とす形（4.4 / #132）', () => {
  /**
   * 応答の並びが互いに区別できるか（分類名がすべて違うか）。
   *
   * **判定を関数に出しているのは、変異させて確かめるためである。** 分類を潰した
   * 応答を与えれば false になることを、同じテストの中で見せる。
   *
   * @param bodies 応答本文の並び
   * @returns すべて区別できれば true
   */
  function distinguishable(bodies: readonly QuotaExceededBody[]): boolean {
    return new Set(bodies.map((body) => body.error)).size === bodies.length;
  }

  it('拒否は 429 で返す', () => {
    expect(QUOTA_EXCEEDED_STATUS).toBe(429);
  });

  it('日次は分類名と再開時刻を載せる', () => {
    const resetsAt = jstDayRange(AT).toSeconds;
    expect(describeQuotaRejection(DAILY_QUOTA_REASON, resetsAt)).toEqual({
      error: DAILY_QUOTA_REASON,
      resetsAt,
    });
  });

  it('月次は分類名だけを載せる', () => {
    // 4.4 が月次に求めているのは「プレイと共有は継続できる」旨であって、再開時刻では
    // ない（復帰は翌月）。**日次と同じ項目名で返すと、受け手が両者を同じものとして
    // 扱う口ができる。**
    expect(describeQuotaRejection(MONTHLY_LIMIT_REASON, jstDayRange(AT).toSeconds)).toEqual({
      error: MONTHLY_LIMIT_REASON,
    });
  });

  it('日次と月次が同じ応答にならない', () => {
    // **区別できることが #132 の本体である。**
    expect(
      distinguishable([
        describeQuotaRejection(DAILY_QUOTA_REASON, jstDayRange(AT).toSeconds),
        describeQuotaRejection(MONTHLY_LIMIT_REASON),
      ]),
    ).toBe(true);
    // **変異検査。** 分類を潰して 1 種類へ戻した応答を与えると、この判定は false に
    // なる（＝上の検査は「区別できていること」を実際に見ている）。
    expect(
      distinguishable([
        { error: UNCLASSIFIED_QUOTA_CODE },
        { error: UNCLASSIFIED_QUOTA_CODE, resetsAt: jstDayRange(AT).toSeconds },
      ]),
    ).toBe(false);
  });

  it('段が返した文字列をそのまま載せない（8.3）', () => {
    // 段は差し替えられる（`GenerationPipeline['checkQuota']`）。**応答に出てよいのは
    // 時刻と固定の分類名だけ**なので、知らない理由は 1 つの値へ倒す。
    const hostile = [
      '<img src=x onerror=alert(1)>',
      'daily',
      '__proto__',
      'constructor',
      './main.go:12:2: undefined: foo',
    ];
    for (const value of hostile) {
      expect(describeQuotaRejection(value, jstDayRange(AT).toSeconds), value).toEqual({
        error: UNCLASSIFIED_QUOTA_CODE,
      });
    }
  });

  it('契約を満たす時刻はそのまま載る', () => {
    // 実装が返すのは日の境界（UNIX 秒の整数）である。**絞りが厳しすぎて正しい値まで
    // 落ちないこと**を、片側だけでなく両側で固定する。
    const resetsAt = jstDayRange(AT).toSeconds;
    expect(Number.isSafeInteger(resetsAt)).toBe(true);
    expect(describeQuotaRejection(DAILY_QUOTA_REASON, resetsAt)).toEqual({
      error: DAILY_QUOTA_REASON,
      resetsAt,
    });
  });

  it('契約を満たさない時刻は載せない（PR #135 のレビュー指摘）', () => {
    // **分類名と同じ扱いである。** 段は差し替えられるので、`resetsAt` も「段が返した
    // 値」でしかない。分類名を一覧で絞りながら数値を素通しすると、同じ原則が片方だけ
    // 抜ける。契約は「枠が戻る時刻を表す UNIX 秒の整数」なので、下はすべて載せない。
    //
    // **推測で直さない**（丸めたり現在時刻で埋めたりすると、利用者へ嘘の時刻を見せる）。
    expect(describeQuotaRejection(DAILY_QUOTA_REASON)).toEqual({ error: DAILY_QUOTA_REASON });
    const broken = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      // 時刻として意味を成さない（0 は 1970-01-01、負は それ以前）。
      0,
      -1,
      -jstDayRange(AT).toSeconds,
      // 秒でない（ミリ秒を渡した実装や、割り算を丸め忘れた実装）。
      1.5,
      jstDayRange(AT).toSeconds + 0.001,
      // 桁あふれ。JSON へ出しても元の値へ戻らない。
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
    ];
    for (const value of broken) {
      expect(describeQuotaRejection(DAILY_QUOTA_REASON, value), String(value)).toEqual({
        error: DAILY_QUOTA_REASON,
      });
    }
  });

  it('分類名の一覧と判定が一致する', () => {
    // 一覧は画面の文言表が網羅の検査に使う（`test/generate-page.test.ts`）。
    expect([...QUOTA_REJECTION_REASONS]).toEqual([DAILY_QUOTA_REASON, MONTHLY_LIMIT_REASON]);
    for (const reason of QUOTA_REJECTION_REASONS) {
      expect(isQuotaRejectionReason(reason), reason).toBe(true);
      expect(describeQuotaRejection(reason).error, reason).toBe(reason);
    }
    // 倒し先そのものは分類名ではない（表の `429:` へ落ちる値である）。
    expect(isQuotaRejectionReason(UNCLASSIFIED_QUOTA_CODE)).toBe(false);
  });
});

describe('3.3-2 への結線（acceptance 1）', () => {
  it('既定のパイプラインのクォータ判定が未実装の段ではない', () => {
    // **同一性で見る。** 「501 を投げないこと」で見ると、未実装の段を別の例外へ
    // 変えただけの実装でも通る。
    expect(defaultPipeline.checkQuota).not.toBe(notImplementedPipeline.checkQuota);
    expect(defaultPipeline.checkQuota).toBe(checkGenerationQuota);
  });

  /**
   * 生成の段が呼ばれたかどうかを記録するパイプラインを作る。
   *
   * **クォータ判定は既定の実装をそのまま借りる。** 写しを検査しても結線の証拠に
   * ならない。
   *
   * @returns 呼び出し記録とパイプライン
   */
  function pipelineWatchingGeneration(): {
    readonly called: { generateSource: boolean };
    readonly pipeline: GenerationPipeline;
  } {
    const called = { generateSource: false };
    return {
      called,
      pipeline: {
        ...notImplementedPipeline,
        startJob: runJobInline,
        checkQuota: defaultPipeline.checkQuota,
        generateSource: async () => {
          called.generateSource = true;
          throw new Error('ここへ到達してはいけない');
        },
      },
    };
  }

  // **時計を止める。** `startGeneration` は `checkQuota(env, userId)` を 2 引数で
  // 呼ぶため、判定時刻は既定値（現在時刻）になる。行を「現在時刻」で置くと、**挿入と
  // 判定の間に JST の日または月の境界を跨いだ瞬間に、置いた行が集計の外へ出る**
  // （#122 のレビュー指摘 2 / 3）。翌日・翌月にも行を置いて塞ぐこともできるが、
  // それは「跨いでも当たるように行を増やす」対処であって、跨がないようにする対処では
  // ない。**時刻そのものを固定して、境界を跨ぐ経路を消す。**
  //
  // `toFake` を `Date` だけに絞るのは、`setTimeout` まで差し替えると D1 の I/O が
  // 進まなくなるためである。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('月次上限を超えていたら LLM 呼び出しに到達しない', async () => {
    const userId = await seedUser('wired-monthly');
    const { called, pipeline } = pipelineWatchingGeneration();

    // 判定時刻は固定した現在時刻（= AT）である。行も同じ時刻へ置く。
    expect(Math.floor(Date.now() / 1000)).toBe(AT);
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);
    await expect(
      startGeneration(env, userId, { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(called.generateSource).toBe(false);
  });

  it('日次クォータを超えていたら LLM 呼び出しに到達しない', async () => {
    const userId = await seedUser('wired-daily');
    await seedCalls(userId, DAILY_QUOTA_PER_USER, AT);
    const { called, pipeline } = pipelineWatchingGeneration();

    await expect(
      startGeneration(env, userId, { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(called.generateSource).toBe(false);
  });

  it('枠が残っていれば生成の段まで進む', async () => {
    // **拒否が「常に拒否」でないことを確かめる。** 片側だけを見ると、判定を
    // 「常に false を返す」実装に変えても上の 2 件が通る。
    const userId = await seedUser('wired-allowed');
    const { called, pipeline } = pipelineWatchingGeneration();
    await expect(
      startGeneration(env, userId, { prompt: 'ゲーム' }, pipeline),
    ).rejects.not.toBeInstanceOf(QuotaExceeded);
    expect(called.generateSource).toBe(true);
  });
});

describe('80% 警告を通知側が読む口（#148）', () => {
  it('しきい値の判定は 1 か所にある（画面も通知も同じ関数から得る）', async () => {
    const userId = await seedUser('warn-shared');
    const cost = MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO + 1;
    await seedLedgerRow(userId, AT, cost);

    const decision = await checkGenerationQuota(env, userId, AT);
    const forNotice = await monthlyCostWarning(env, AT);
    // 判定（3.3-2）と通知（#148）が同じ警告を見ていること。**別々に数え直さない。**
    expect(forNotice).toEqual(decision.allowed === true ? decision.warning : null);
    expect(forNotice).toEqual(monthlyCostWarningOf(cost));
  });

  it.each([
    ['手前では立たない', MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO - 0.01, false],
    ['ちょうどで立つ', MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO, true],
    ['上限でも立つ', MONTHLY_COST_LIMIT_JPY, true],
  ])('%s', (_label, cost, expected) => {
    // **上限（100%）でも警告そのものは立つ。** 生成を止めるかどうかは別の判定である
    // （`generationQuotaStatus` が停止の枝で警告を返さないのは、止まっている利用者へ
    // 見せないためであって、警告が消えるからではない）。
    expect(monthlyCostWarningOf(cost) !== null).toBe(expected);
  });

  it('通知側の判定も利用者で絞らない（月次はサービス全体）', async () => {
    // 4.3 の月次 1 万円はサービス全体の上限である。別々の利用者の行が合算される。
    const a = await seedUser('warn-total-a');
    const b = await seedUser('warn-total-b');
    await seedLedgerRow(a, AT, MONTHLY_COST_LIMIT_JPY * 0.5);
    await seedLedgerRow(b, AT, MONTHLY_COST_LIMIT_JPY * 0.31);
    expect((await monthlyCostWarning(env, AT))?.kind).toBe('monthly-cost');
  });

  it('当月の外の行は数えない（境界は JST）', async () => {
    const userId = await seedUser('warn-month-edge');
    // 当月（5 月）の開始の 1 秒前＝ 4 月分。
    await seedLedgerRow(userId, jstMonthRange(AT).fromSeconds - 1, MONTHLY_COST_LIMIT_JPY);
    expect(await monthlyCostWarning(env, AT)).toBeNull();
  });
});
