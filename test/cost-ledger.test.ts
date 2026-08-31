import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_JOB_SPAN_SECONDS,
  EXCHANGE_RATE_PATTERN,
  USD_JPY_RATE,
  convertUsageToJpy,
  costOfGeneration,
  effortExperimentTotals,
  isUsableGeneration,
  jstMonthRange,
  monthlyCostTotals,
  recordGeneration,
} from '../src/cost-ledger.js';
import type {
  EffortExperimentGroup,
  EffortExperimentReport,
} from '../src/cost-ledger.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  EFFORT_AB_ARMS,
  EFFORT_AB_MODEL_KEYS,
  EFFORT_NOT_SENT,
  GENERATION_MODELS,
  findGenerationModel,
} from '../src/generation-models.js';
import type {
  GenerationEffort,
  GenerationModelKey,
  GenerationResult,
  GenerationUsage,
  ModelPricing,
} from '../src/generation-models.js';
import {
  defaultPipeline,
  notImplementedPipeline,
  runJobInline,
  startGeneration,
} from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import { GeneratedSourceRejected } from '../src/source-inspection.js';
import { applySchema } from './helpers/schema.js';

/**
 * 生成結果を組み立てる。
 *
 * @param modelKey 使ったモデルの鍵
 * @param usage `usage` 4 種（省略した項目は 0 / null）
 * @param overrides `source` と `stopReason` の差し替え
 * @returns 生成結果
 */
function generationOf(
  modelKey: GenerationModelKey,
  usage: Partial<GenerationUsage> = {},
  overrides: Partial<Pick<GenerationResult, 'source' | 'stopReason'>> = {},
): GenerationResult {
  return {
    modelKey,
    modelId: findGenerationModel(modelKey)!.modelId,
    source: overrides.source ?? 'package main\n\nfunc main() {}\n',
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
    },
    stopReason: overrides.stopReason ?? 'end_turn',
  };
}

/**
 * 利用者を 1 人用意する（`generations.user_id` は `users` を参照する）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `cost-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/** `generations` の 1 行（読み出し用）。 */
interface LedgerRow {
  id: string;
  game_id: string | null;
  user_id: string;
  prompt: string;
  model: string;
  effort: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_jpy: number;
  succeeded: number;
  created_at: number;
}

/**
 * ある利用者の台帳の行を、書いた順に読む。
 *
 * @param userId 利用者の id
 * @returns 行の配列
 */
async function rowsOf(userId: string): Promise<LedgerRow[]> {
  const result = await env.DB.prepare(
    'select * from generations where user_id = ? order by rowid',
  )
    .bind(userId)
    .all<LedgerRow>();
  return result.results;
}

beforeAll(async () => {
  await applySchema();
});

describe('為替レートの機械照合（4.2 / #22）', () => {
  /**
   * 仕様書が宣言している換算レートをすべて拾う。
   *
   * 「為替（レート）は N 円/ドル」の形だけを対象にする。4.3 の「85 USD は 130 円/ドルでも
   * 約 11,050 円」は**意図的に別の値**（層 3 が層 1 より先に発火しないことの確認）であり、
   * 換算レートの宣言ではない。
   *
   * @param spec 仕様書の本文
   * @returns 見つかったレートの配列
   */
  function ratesIn(spec: string): number[] {
    return [...spec.matchAll(EXCHANGE_RATE_PATTERN)].map((matched) => Number(matched[1]));
  }

  it('仕様書の宣言とコード側の定数が一致する', () => {
    // 同じ数値が仕様書とコードの 2 か所にある以上、機械で照合する
    // （shared-ai-rules 12 章）。ずれると 4.3 の月次上限が静かに狂う。
    const rates = ratesIn(env.TEST_PRODUCT_SPEC);
    // 4.2 の宣言文と、その決定を記録した節の見出しの 2 か所以上を拾えていること。
    expect(rates.length).toBeGreaterThan(1);
    for (const rate of rates) {
      expect(rate).toBe(USD_JPY_RATE);
    }
  });

  it('仕様書側を変異させると照合が破れる', () => {
    // **この検査が効いていることを確かめる。** 上のテストは、正規表現が何も拾わない
    // 状態でも「すべて一致」で通ってしまう（`length` の検査はその一部しか塞がない）。
    // 仕様書の値を 1 つ変えた写しを作り、検出できることを見る。
    const doctored = env.TEST_PRODUCT_SPEC.replace(
      '**為替は 150 円/ドルで換算する。**',
      '**為替は 155 円/ドルで換算する。**',
    );
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(ratesIn(doctored)).toContain(155);
    expect(ratesIn(doctored).every((rate) => rate === USD_JPY_RATE)).toBe(false);
  });

  it('層 3 の円高側バッファ（130 円/ドル）を換算レートと取り違えない', () => {
    // 4.3 は「85 USD は 130 円/ドルでも約 11,050 円」と書いている。これは換算レートでは
    // なく、層 3 が層 1 より先に発火しないことの確認である。拾ってしまうと、正しい
    // 記述で赤が出る。
    expect(env.TEST_PRODUCT_SPEC).toContain('130 円/ドル');
    expect(ratesIn(env.TEST_PRODUCT_SPEC)).not.toContain(130);
  });
});

describe('既知の usage の円換算（#22 acceptance 3）', () => {
  it('4.2 の実測（Sonnet 4.6）が約 9.9 円になる', () => {
    // 4.2 の「1 生成あたり 約 9.9 円」は入力 1,092 / 出力 4,171 の平均から出ている。
    // **仕様書の数字を、台帳の実装で再現できることを固定する。**
    const cost = costOfGeneration(
      generationOf('sonnet-4-6', { inputTokens: 1_092, outputTokens: 4_171 }),
    );
    expect(cost.inputJpy).toBeCloseTo((1_092 * 3 * 150) / 1_000_000, 10);
    expect(cost.outputJpy).toBeCloseTo((4_171 * 15 * 150) / 1_000_000, 10);
    expect(cost.totalJpy).toBeCloseTo(9.87615, 5);
    expect(Math.round(cost.totalJpy * 10) / 10).toBe(9.9);
  });

  it('4.2 の実測（DeepSeek v3.2）が約 0.8 円になる', () => {
    const cost = costOfGeneration(
      generationOf('deepseek-v3-2', { inputTokens: 911, outputTokens: 2_159 }),
    );
    expect(cost.totalJpy).toBeCloseTo(0.820068, 6);
    expect(Math.round(cost.totalJpy * 10) / 10).toBe(0.8);
  });

  it('100 万トークンちょうどが単価×為替になる', () => {
    // 端数の無い入力で、換算式そのものを固定する。
    const cost = costOfGeneration(generationOf('sonnet-4-6', { inputTokens: 1_000_000 }));
    expect(cost.inputJpy).toBe(3 * USD_JPY_RATE);
    expect(cost.totalJpy).toBe(450);
  });

  it('キャッシュ読みが単価どおりに乗る', () => {
    // 4.1 の実測（2 回目の呼び出しで `cacheReadInputTokens` が 4,841）。
    const cost = costOfGeneration(
      generationOf('sonnet-4-6', {
        inputTokens: 100,
        cacheReadInputTokens: 4_841,
        cacheWriteInputTokens: 0,
      }),
    );
    expect(cost.cacheReadJpy).toBeCloseTo((4_841 * 0.3 * 150) / 1_000_000, 10);
    expect(cost.anomalies).toEqual([]);
  });
});

describe('複数モデルの単価（#22 acceptance 4）', () => {
  it('同じ usage でもモデルごとに違う額になる', () => {
    const usage = { inputTokens: 1_000, outputTokens: 2_000 };
    const sonnet = costOfGeneration(generationOf('sonnet-4-6', usage));
    const deepseek = costOfGeneration(generationOf('deepseek-v3-2', usage));

    expect(sonnet.totalJpy).toBeCloseTo(((1_000 * 3 + 2_000 * 15) * 150) / 1_000_000, 10);
    expect(deepseek.totalJpy).toBeCloseTo(((1_000 * 0.74 + 2_000 * 2.22) * 150) / 1_000_000, 10);
    expect(sonnet.totalJpy).toBeGreaterThan(deepseek.totalJpy);
  });

  it('登録簿のすべてのモデルが換算できる', () => {
    // モデルを 1 つ足したときに、台帳側の追随を忘れていれば 0 円になる。
    for (const model of GENERATION_MODELS) {
      const cost = costOfGeneration(
        generationOf(model.key, {
          inputTokens: 1_000,
          outputTokens: 1_000,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        }),
      );
      expect(cost.totalJpy, model.key).toBeGreaterThan(0);
      expect(cost.anomalies, model.key).toEqual([]);
    }
  });

  it('単価を変異させると換算結果が変わる（単価表が 1 か所である証拠）', () => {
    // **この検査が本 issue の acceptance「単価表の定義箇所が 1 か所である」の実質である。**
    // 台帳が単価を写し持っていれば、登録簿を変えても結果は変わらない。
    const model = findGenerationModel('sonnet-4-6')!;
    const original = model.pricing;
    const generated = generationOf('sonnet-4-6', { inputTokens: 1_000, outputTokens: 2_000 });
    const before = costOfGeneration(generated);
    try {
      (model as { pricing: ModelPricing }).pricing = {
        ...original,
        outputUsdPerMillion: original.outputUsdPerMillion * 2,
      };
      const after = costOfGeneration(generated);
      expect(after.outputJpy).toBeCloseTo(before.outputJpy * 2, 10);
      expect(after.inputJpy).toBeCloseTo(before.inputJpy, 10);
      expect(after.totalJpy).not.toBeCloseTo(before.totalJpy, 6);
    } finally {
      (model as { pricing: ModelPricing }).pricing = original;
    }
    // 戻したことを確かめる。ここが崩れると、後続のテストが理由不明で落ちる。
    expect(costOfGeneration(generated).totalJpy).toBeCloseTo(before.totalJpy, 10);
  });
});

describe('usage の項目が欠けた場合の扱い（4.3 の記録規約）', () => {
  it('課金次元を持たないモデルで項目が返らないのは正常である', () => {
    // DeepSeek はキャッシュの 2 項目を返さない（4.1。API ではなくモデルの性質）。
    const cost = costOfGeneration(
      generationOf('deepseek-v3-2', { inputTokens: 100, outputTokens: 100 }),
    );
    expect(cost.cacheReadJpy).toBe(0);
    expect(cost.cacheWriteJpy).toBe(0);
    expect(cost.anomalies).toEqual([]);
  });

  it('単価を持つモデルで項目が欠けたら 0 として計上し、異常として残す', () => {
    // 記録しない選択肢は無い（4.3 は全件記録を要求する）。値としてではなく異常として
    // 残すのは、4.5 が「ゼロのまま推移する」ことを異常検知の材料にしているため。
    const cost = costOfGeneration(generationOf('sonnet-4-6', { inputTokens: 100 }));
    expect(cost.cacheReadJpy).toBe(0);
    expect(cost.anomalies).toEqual([
      { kind: 'missing-priced-dimension', dimension: 'cacheRead' },
      { kind: 'missing-priced-dimension', dimension: 'cacheWrite' },
    ]);
  });

  it('単価の無い次元にトークンが載っていたら最大単価で計上する', () => {
    // 単価表が現実に追いついていない状態。0 で通すと 4.3 の上限をすり抜ける。
    const cost = costOfGeneration(
      generationOf('deepseek-v3-2', { inputTokens: 0, cacheReadInputTokens: 1_000_000 }),
    );
    const highest = Math.max(
      ...GENERATION_MODELS.flatMap((model) => [
        model.pricing.inputUsdPerMillion,
        model.pricing.outputUsdPerMillion,
      ]),
    );
    expect(cost.cacheReadJpy).toBe(highest * USD_JPY_RATE);
    expect(cost.anomalies).toEqual([
      { kind: 'unpriced-tokens', dimension: 'cacheRead', tokens: 1_000_000 },
    ]);
    // **DeepSeek 自身の単価で計上していないこと。** そちらで割ると過少計上になる。
    expect(cost.cacheReadJpy).toBeGreaterThan(
      findGenerationModel('deepseek-v3-2')!.pricing.outputUsdPerMillion * USD_JPY_RATE,
    );
  });

  it('単価の無い次元に 0 が返るだけなら異常ではない', () => {
    const cost = costOfGeneration(
      generationOf('deepseek-v3-2', { cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }),
    );
    expect(cost.totalJpy).toBe(0);
    expect(cost.anomalies).toEqual([]);
  });

  it('登録簿に無いモデルは最大単価で計上し、0 円にしない', () => {
    // 型が弾くため通常は起こらないが、**唯一起こりうる経路が「登録簿から要素を消した
    // のに、そのモデルで生成した」**であり、それはまさに台帳が静かにずれる事故である。
    const generated = {
      ...generationOf(DEFAULT_GENERATION_MODEL_KEY, {
        inputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      }),
      modelKey: 'sonnet-9' as GenerationModelKey,
    };
    const cost = costOfGeneration(generated);
    expect(cost.totalJpy).toBeGreaterThan(0);
    expect(cost.anomalies).toEqual([{ kind: 'unknown-model', modelKey: 'sonnet-9' }]);
    const sonnet = costOfGeneration(
      generationOf('sonnet-4-6', { inputTokens: 1_000_000 }),
    );
    expect(cost.totalJpy).toBeGreaterThanOrEqual(sonnet.totalJpy);
  });

  it('単価だけを渡す換算は、渡した単価しか見ない', () => {
    const pricing: ModelPricing = {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: null,
      cacheWriteUsdPerMillion: null,
    };
    const usage: GenerationUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    };
    expect(convertUsageToJpy(pricing, usage).totalJpy).toBe(11 * USD_JPY_RATE);
  });
});

describe('台帳への記録（#22 acceptance 1 / 5）', () => {
  it('成功した生成が 1 行記録され、モデルが残る', async () => {
    const userId = await seedUser('recorded');
    const generated = generationOf('sonnet-4-6', { inputTokens: 1_092, outputTokens: 4_171 });
    const record = await recordGeneration(env, { userId, prompt: 'シューティング', generated });

    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(record.id);
    // **生成に使ったモデルが台帳に記録されている**（acceptance 5）。単価を引く鍵である。
    expect(row.model).toBe('sonnet-4-6');
    expect(row.prompt).toBe('シューティング');
    expect(row.input_tokens).toBe(1_092);
    expect(row.output_tokens).toBe(4_171);
    expect(row.cost_jpy).toBeCloseTo(9.87615, 5);
    expect(row.succeeded).toBe(1);
    // 作品行はまだ無い（3.3-8 で作られる）。
    expect(row.game_id).toBeNull();
  });

  it('モデルごとに違う額が記録される（#22 acceptance 4）', async () => {
    const userId = await seedUser('per-model');
    for (const key of ['sonnet-4-6', 'deepseek-v3-2'] as const) {
      await recordGeneration(env, {
        userId,
        prompt: 'ゲーム',
        generated: generationOf(key, { inputTokens: 1_000, outputTokens: 2_000 }),
      });
    }
    const rows = await rowsOf(userId);
    expect(rows.map((row) => row.model)).toEqual(['sonnet-4-6', 'deepseek-v3-2']);
    expect(rows[0]!.cost_jpy).toBeGreaterThan(rows[1]!.cost_jpy);
    expect(rows[0]!.cost_jpy).toBeCloseTo(((1_000 * 3 + 2_000 * 15) * 150) / 1_000_000, 10);
    expect(rows[1]!.cost_jpy).toBeCloseTo(((1_000 * 0.74 + 2_000 * 2.22) * 150) / 1_000_000, 10);
  });

  it('max_tokens で切れた生成も記録され、失敗として残る（#22 acceptance 1）', async () => {
    // 切れたソースはコンパイルできないが、**課金は発生している。**
    const userId = await seedUser('truncated');
    const generated = generationOf(
      'sonnet-4-6',
      { inputTokens: 1_000, outputTokens: 16_000 },
      { stopReason: 'max_tokens' },
    );
    expect(isUsableGeneration(generated)).toBe(false);
    await recordGeneration(env, { userId, prompt: 'ゲーム', generated });

    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(0);
    expect(rows[0]!.cost_jpy).toBeGreaterThan(0);
  });

  it('欠けたキャッシュ項目は 0 として保存される（列は NOT NULL）', async () => {
    const userId = await seedUser('null-cache');
    await recordGeneration(env, {
      userId,
      prompt: 'ゲーム',
      generated: generationOf('deepseek-v3-2', { inputTokens: 10, outputTokens: 20 }),
    });
    const row = (await rowsOf(userId))[0]!;
    expect(row.cache_creation_input_tokens).toBe(0);
    expect(row.cache_read_input_tokens).toBe(0);
    // 「0 トークンだった」と「課金次元が無い」の区別は `model` 列と単価表から引ける。
    expect(findGenerationModel(row.model)!.pricing.cacheReadUsdPerMillion).toBeNull();
  });

  it('キャッシュの 2 列を取り違えない', async () => {
    // `cache_creation_input_tokens` が書き、`cache_read_input_tokens` が読みである。
    // 入れ替えても合計額は変わらないため、額の検査では捕まらない。
    const userId = await seedUser('cache-columns');
    await recordGeneration(env, {
      userId,
      prompt: 'ゲーム',
      generated: generationOf('sonnet-4-6', {
        cacheReadInputTokens: 111,
        cacheWriteInputTokens: 222,
      }),
    });
    const row = (await rowsOf(userId))[0]!;
    expect(row.cache_read_input_tokens).toBe(111);
    expect(row.cache_creation_input_tokens).toBe(222);
  });
});

describe('リトライは試行の数だけ記録される（#22 acceptance 2）', () => {
  it('3 試行で 3 行になる', async () => {
    // 5.2-7 の「各試行の費用を台帳に計上する」。行をまとめたり上書きしたりしない。
    const userId = await seedUser('retry');
    const attempts = [
      generationOf('sonnet-4-6', { inputTokens: 1_000, outputTokens: 1_000 }, {
        stopReason: 'max_tokens',
      }),
      generationOf('sonnet-4-6', { inputTokens: 1_100, outputTokens: 1_200 }, {
        stopReason: 'max_tokens',
      }),
      generationOf('sonnet-4-6', { inputTokens: 1_200, outputTokens: 1_400 }),
    ];
    for (const attempt of attempts) {
      await recordGeneration(env, { userId, prompt: 'ゲーム', generated: attempt });
    }

    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(3);
    // id が重複しない（同じ行を 3 回書き換えた実装では 1 行になる）。
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.map((row) => row.succeeded)).toEqual([0, 0, 1]);
    // 合計は 3 試行ぶんである。失敗した試行を落とすと 4.3 の累計が過少になる。
    const total = rows.reduce((sum, row) => sum + row.cost_jpy, 0);
    expect(total).toBeCloseTo(
      attempts.reduce((sum, attempt) => sum + costOfGeneration(attempt).totalJpy, 0),
      10,
    );
  });
});

describe('3.3 の順序への結線（#22 acceptance 1）', () => {
  it('既定のパイプラインの費用計上が未実装の段ではない', () => {
    // **同一性で見る。** 「501 を投げないこと」で見ると、未実装の段を別の例外へ
    // 変えただけの実装でも通る。
    expect(defaultPipeline.recordCost).not.toBe(notImplementedPipeline.recordCost);
  });

  it('検査で拒否された生成も、既に台帳へ記録されている', async () => {
    // **3.3 の順序（費用計上 → 検査 → ビルド）そのものの検査である。** 生成が返った
    // 時点で課金は発生しているので、後段で落ちても行が残らなければならない。
    const userId = await seedUser('rejected');
    const generated = generationOf(
      'sonnet-4-6',
      { inputTokens: 1_000, outputTokens: 2_000 },
      { source: 'package main\n\nimport "os/exec"\n\nfunc main() {}\n' },
    );
    const pipeline: GenerationPipeline = {
      ...notImplementedPipeline,
      startJob: runJobInline,
      checkQuota: async () => ({ allowed: true }),
      generateSource: async () => generated,
      // **既定の実装を借りる。** 写しを検査しても結線の証拠にならない。
      recordCost: defaultPipeline.recordCost,
      inspectSource: defaultPipeline.inspectSource,
    };

    await expect(
      startGeneration(env, userId, { prompt: '許可外のゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(GeneratedSourceRejected);

    const rows = await rowsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt).toBe('許可外のゲーム');
    expect(rows[0]!.cost_jpy).toBeCloseTo(costOfGeneration(generated).totalJpy, 10);
  });
});

describe('月次累計の集計（4.3 層 1）', () => {
  it('JST の暦月で範囲を切る', () => {
    // 2020-03-01 00:00 JST = 2020-02-29 15:00 UTC。
    const march = jstMonthRange(Date.UTC(2020, 2, 15) / 1000);
    expect(march.year).toBe(2020);
    expect(march.month).toBe(3);
    expect(new Date(march.fromSeconds * 1000).toISOString()).toBe('2020-02-29T15:00:00.000Z');
    expect(new Date(march.toSeconds * 1000).toISOString()).toBe('2020-03-31T15:00:00.000Z');
  });

  it('UTC で切らない（月初の 9 時間が前月に落ちない）', () => {
    // 2020-03-01 03:00 JST は UTC ではまだ 2 月である。ここを UTC で切ると、
    // 4.4 が見せる「今月」が利用者の暦と 9 時間ずれる。
    const range = jstMonthRange(Date.UTC(2020, 1, 29, 18) / 1000);
    expect(range.month).toBe(3);
  });

  it('当月の行だけを合計する', async () => {
    // 他のテストは現在時刻で書くため、**過去の月**を使って干渉を避ける。
    const userId = await seedUser('monthly');
    const range = jstMonthRange(Date.UTC(2020, 2, 15) / 1000);
    const inMonth = generationOf('sonnet-4-6', { inputTokens: 1_000, outputTokens: 2_000 });
    const outOfMonth = generationOf('deepseek-v3-2', { inputTokens: 5_000, outputTokens: 5_000 });

    // 月初ちょうど（含む）と月末の 1 秒前（含む）。
    await recordGeneration(env, { userId, prompt: 'a', generated: inMonth }, range.fromSeconds);
    await recordGeneration(env, { userId, prompt: 'b', generated: inMonth }, range.toSeconds - 1);
    // 前月の最終秒と、翌月の先頭（どちらも含まない）。
    await recordGeneration(
      env,
      { userId, prompt: 'c', generated: outOfMonth },
      range.fromSeconds - 1,
    );
    await recordGeneration(env, { userId, prompt: 'd', generated: outOfMonth }, range.toSeconds);

    const totals = await monthlyCostTotals(env, Date.UTC(2020, 2, 15) / 1000);
    expect(totals.year).toBe(2020);
    expect(totals.month).toBe(3);
    expect(totals.generations).toBe(2);
    expect(totals.costJpy).toBeCloseTo(costOfGeneration(inMonth).totalJpy * 2, 10);
  });

  it('行が 1 つも無い月は 0 円になる', async () => {
    // `sum` は行が無いと NULL を返す。NULL が漏れると 4.3 の判定が NaN で比較される。
    const totals = await monthlyCostTotals(env, Date.UTC(2001, 0, 15) / 1000);
    expect(totals.generations).toBe(0);
    expect(totals.costJpy).toBe(0);
  });

  it('利用者で絞らない（月次上限はサービス全体である）', async () => {
    // 4.3 の 1 万円は全体の上限で、1 人あたりの蓋は日次クォータ 12 回（確定25）である。
    const at = Date.UTC(2019, 5, 10) / 1000;
    const generated = generationOf('sonnet-4-6', { inputTokens: 1_000, outputTokens: 1_000 });
    for (const suffix of ['shared-a', 'shared-b']) {
      const userId = await seedUser(suffix);
      await recordGeneration(env, { userId, prompt: 'ゲーム', generated }, at);
    }
    const totals = await monthlyCostTotals(env, at);
    expect(totals.generations).toBe(2);
    expect(totals.costJpy).toBeCloseTo(costOfGeneration(generated).totalJpy * 2, 10);
  });
});

describe('effort の割り当てと結果が台帳から追える（#25 acceptance 2）', () => {
  it('群の鍵で生成すると、model と effort の両方が残る', async () => {
    // **これが「割り当てと結果が追える」の実体である。** 群は登録簿の要素なので
    // `model` にも入るが、集計が鍵の綴りを解釈しないで済むよう `effort` を別に持つ
    // （`migrations/0011_generations_effort.sql`）。
    const userId = await seedUser('effort-recorded');
    for (const arm of EFFORT_AB_ARMS) {
      await recordGeneration(env, {
        userId,
        prompt: `お題-${arm}`,
        generated: generationOf(`sonnet-4-6-${arm}`, { inputTokens: 1_200, outputTokens: 6_000 }),
      });
    }
    const rows = await rowsOf(userId);
    expect(rows.map((row) => row.model)).toEqual(EFFORT_AB_MODEL_KEYS);
    expect(rows.map((row) => row.effort)).toEqual([...EFFORT_AB_ARMS]);
  });

  it('effort を送っていない生成は none として残る（NULL にしない）', async () => {
    // 列の NULL は「記録していない」（0011 より前の行）である。送らなかったことを
    // NULL で表すと、集計が古い行を対照群として数える。
    const userId = await seedUser('effort-none');
    await recordGeneration(env, {
      userId,
      prompt: 'お題',
      generated: generationOf('sonnet-4-6', { inputTokens: 1_200, outputTokens: 6_000 }),
    });
    expect((await rowsOf(userId))[0]!.effort).toBe(EFFORT_NOT_SENT);
  });

  it('登録簿の effort を変異させると、書かれる値が変わる（写しでない証拠）', async () => {
    // **綴りを台帳側へ写していれば、登録簿を変えても結果は変わらない。** 単価表の
    // 変異検査（上）と同じ形で、値の出どころが 1 か所であることを確かめる。
    const model = findGenerationModel('sonnet-4-6-high')!;
    const original = model.effort;
    const userId = await seedUser('effort-mutated');
    try {
      (model as { effort: GenerationEffort | null }).effort = 'low';
      await recordGeneration(env, {
        userId,
        prompt: 'お題',
        generated: generationOf('sonnet-4-6-high', { inputTokens: 1_200, outputTokens: 100 }),
      });
      expect((await rowsOf(userId))[0]!.effort).toBe('low');
    } finally {
      (model as { effort: GenerationEffort | null }).effort = original;
    }
    // 戻したことを確かめる（崩れると後続が理由不明で落ちる）。
    expect(findGenerationModel('sonnet-4-6-high')!.effort).toBe('high');
  });

  it('登録簿に無いモデルの effort は NULL にする（none と断定しない）', async () => {
    // 何を送ったのか分からない。**分からないものを「送っていない」と断定しない。**
    const userId = await seedUser('effort-unknown-model');
    await recordGeneration(env, {
      userId,
      prompt: 'お題',
      generated: {
        ...generationOf(DEFAULT_GENERATION_MODEL_KEY, { inputTokens: 10, outputTokens: 10 }),
        modelKey: 'sonnet-9' as GenerationModelKey,
      },
    });
    expect((await rowsOf(userId))[0]!.effort).toBeNull();
  });
});

describe('A/B の集計（#25 acceptance 1）', () => {
  // **テストごとに別の窓を使う。** このファイルの D1 はテスト間で持ち越されるので
  // （上の月次のテストが「過去の月」を使って干渉を避けているのと同じ事情）、窓を
  // 共有すると、前のテストが書いた行を次のテストが数えてしまう。
  const WINDOW_BASE = Date.UTC(2015, 5, 1) / 1000;
  const WINDOW_LENGTH = 24 * 60 * 60;
  let windowIndex = 0;
  let WINDOW_FROM = WINDOW_BASE;
  let WINDOW_TO = WINDOW_BASE + WINDOW_LENGTH;
  /** 集計にかける窓（前後に余白を置かない。境界そのものを見るため）。 */
  let WINDOW = { fromSeconds: WINDOW_FROM, toSeconds: WINDOW_TO };

  beforeEach(() => {
    windowIndex += 1;
    WINDOW_FROM = WINDOW_BASE + windowIndex * 7 * WINDOW_LENGTH;
    WINDOW_TO = WINDOW_FROM + WINDOW_LENGTH;
    WINDOW = { fromSeconds: WINDOW_FROM, toSeconds: WINDOW_TO };
  });

  /**
   * 新規生成 1 回ぶんの行を書く。
   *
   * **未キャッシュ入力を 1,200 にそろえてある**（4.2 の実測 1,092〜1,444 の範囲）。
   * これが `BASE_SOURCE_INPUT_TOKEN_CEILING` の上にあることが「新規生成」の判定である。
   *
   * @param userId 利用者
   * @param arm 群（`high` / `medium`）
   * @param prompt お題（1 群につき別の文面にする。依頼の切り分けがこれで決まる）
   * @param outputTokens 出力トークン
   * @param at 記録時刻
   * @param stopReason 生成が止まった理由
   */
  async function seedCall(
    userId: string,
    arm: (typeof EFFORT_AB_ARMS)[number],
    prompt: string,
    outputTokens: number,
    at: number,
    stopReason = 'end_turn',
  ): Promise<void> {
    await recordGeneration(
      env,
      {
        userId,
        prompt,
        generated: generationOf(
          `sonnet-4-6-${arm}`,
          { inputTokens: 1_200, outputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
          { stopReason },
        ),
      },
      at,
    );
  }

  /**
   * 群を 1 つ引く。
   *
   * @param report 集計結果
   * @param arm 群
   * @param withBaseSource 元ソースが載っていたか
   * @returns 群
   */
  function groupOf(
    report: EffortExperimentReport,
    arm: string,
    withBaseSource = false,
  ): EffortExperimentGroup {
    const found = report.groups.find(
      (group) => group.effort === arm && group.withBaseSource === withBaseSource,
    );
    expect(found, `${arm} / withBaseSource=${withBaseSource}`).toBeDefined();
    return found!;
  }

  /**
   * A/B を 1 回ぶん仕込む。
   *
   * - `high`: 3 依頼・出力 9,000。うち 1 依頼だけ 2 回目の呼び出しがある（初回で
   *   ビルドが通らなかった依頼）
   * - `medium`: 3 依頼・出力 6,000。すべて 1 回で終わった
   *
   * **お題の文面は 1 群の中ですべて別にしてある**（依頼の切り分けの前提。
   * `effortExperimentTotals` の但し書き）。群が違えば `model` で分かれるので、
   * 同じ文面を両群へ使うのは正しい。
   *
   * @param userId 利用者
   */
  async function seedExperiment(userId: string): Promise<void> {
    for (const [index, arm] of (['high', 'medium'] as const).entries()) {
      const outputTokens = arm === 'high' ? 9_000 : 6_000;
      for (let job = 1; job <= 3; job += 1) {
        await seedCall(userId, arm, `お題 ${job}`, outputTokens, WINDOW_FROM + index * 3_600 + job * 200);
      }
    }
    // high の 1 依頼だけ、2 回目の呼び出しがある（＝初回でコンパイルが通らなかった）。
    await seedCall(userId, 'high', 'お題 3', 9_000, WINDOW_FROM + 800);
  }

  it('両群の実コストと初回コンパイル成功率を出す', async () => {
    const userId = await seedUser('ab-core');
    await seedExperiment(userId);

    const report = await effortExperimentTotals(env, WINDOW);
    const high = groupOf(report, 'high');
    const medium = groupOf(report, 'medium');

    // 群の識別。`model` と `effort` の両方から追える。
    expect(high.modelKey).toBe('sonnet-4-6-high');
    expect(medium.modelKey).toBe('sonnet-4-6-medium');

    // **初回コンパイル成功率。** high は 3 依頼中 1 つが 2 回目を要した。
    expect(high.jobs).toBe(3);
    expect(high.calls).toBe(4);
    expect(high.firstCallCompleted).toBe(2);
    expect(high.firstCallCompletionRate).toBeCloseTo(2 / 3, 10);
    expect(medium.jobs).toBe(3);
    expect(medium.calls).toBe(3);
    expect(medium.firstCallCompletionRate).toBe(1);

    // **実コスト。** 台帳の行の合計そのものであって、試算ではない。
    const highCall = costOfGeneration(
      generationOf('sonnet-4-6-high', {
        inputTokens: 1_200,
        outputTokens: 9_000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      }),
    ).totalJpy;
    expect(high.costJpy).toBeCloseTo(highCall * 4, 8);
    expect(high.costJpyPerJob).toBeCloseTo((highCall * 4) / 3, 8);
    // 1 本の「初回で終わった依頼」あたり（4.2 の「1 本の成功あたり」に対応）。
    expect(high.costJpyPerFirstCallCompletion).toBeCloseTo((highCall * 4) / 2, 8);

    // 依頼の切り分けが怪しいまとまりは無い（お題の文面をすべて別にしてあるため）。
    expect(high.ambiguousJobs).toBe(0);
    expect(medium.ambiguousJobs).toBe(0);
    expect(high.unusableCalls).toBe(0);
  });

  it('総額の差の大半は出力長で説明できることが、正規化した値に現れる', async () => {
    // **これが交絡の分離である。** 1.2.43 の実測では費用が出力トークンにほぼ比例した。
    // 群ごとに出力長が違えば、**総額の差はほとんど出力長の差**であって `effort` の
    // 効果ではない。正規化した値（出力 1,000 トークンあたりの円）に差が残らなければ、
    // 「差はすべて出力長として現れた」と読める。
    const userId = await seedUser('ab-confound');
    await seedExperiment(userId);

    const report = await effortExperimentTotals(env, WINDOW);
    const high = groupOf(report, 'high');
    const medium = groupOf(report, 'medium');

    // 1 呼び出しあたりの出力長そのもの（分解）。**effort の効果はここに出る。**
    expect(high.outputTokensPerCall).toBeCloseTo(9_000, 8);
    expect(medium.outputTokensPerCall).toBeCloseTo(6_000, 8);

    // 総額は 1 呼び出しあたりで 1.48 倍ちがう（出力が 1.5 倍なので、ほぼそのまま）。
    const highPerCall = high.costJpy / high.calls;
    const mediumPerCall = medium.costJpy / medium.calls;
    expect(highPerCall / mediumPerCall).toBeGreaterThan(1.4);

    // **正規化すると差は 2% 未満まで縮む。** 残るのは入力ぶん（出力長に比例しない
    // 固定費）だけである。**この 2 つの数を並べて初めて、費用差を読み分けられる。**
    const ratio = high.costJpyPerKiloOutputToken! / medium.costJpyPerKiloOutputToken!;
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.0);
  });

  it('出力トークンで層別できる（同じ帯どうしで比べられる）', async () => {
    // 正規化だけでは足りない。**帯を固定すれば出力長の差は消える**ので、同じ帯に
    // 両群の呼び出しが入ったときにだけ、費用差を effort の効果として読める。
    const userId = await seedUser('ab-strata');
    await seedExperiment(userId);

    const report = await effortExperimentTotals(env, WINDOW);
    expect(report.outputTokenStrata).toEqual([4_000, 8_000]);

    // high の出力 9,000 は最上位の帯、medium の 6,000 は真ん中の帯へ入る。
    const high = groupOf(report, 'high');
    expect(high.strata).toEqual([
      {
        fromOutputTokens: 8_000,
        toOutputTokens: null,
        calls: 4,
        costJpy: high.costJpy,
        outputTokens: 36_000,
        costJpyPerCall: high.costJpy / 4,
      },
    ]);
    const medium = groupOf(report, 'medium');
    expect(medium.strata.map((stratum) => [stratum.fromOutputTokens, stratum.toOutputTokens])).toEqual(
      [[4_000, 8_000]],
    );

    // 境界は指定できる（同じ帯へそろえた比較を、後から切り直せる）。
    const recut = await effortExperimentTotals(env, { ...WINDOW, outputTokenStrata: [10_000] });
    expect(groupOf(recut, 'high').strata).toHaveLength(1);
    expect(groupOf(recut, 'high').strata[0]!.fromOutputTokens).toBe(0);
    expect(groupOf(recut, 'high').strata[0]!.toOutputTokens).toBe(10_000);
  });

  it('境界が空なら層別せず、1 層として返る（SQL の構文エラーにしない）', async () => {
    // **`case` は `when` を 1 つも持てない。** 素朴に組み立てると `case  else 0 end`
    // になり、SQLite が `near "else": syntax error` を返す。**空配列は「層別せず全部を
    // 1 つで見たい」という正当な指定**で、集計を読む人が最初に試す形でもある。
    // そこで落ちるのは、意味のある結果が返らないより悪い。
    const userId = await seedUser('ab-no-strata');
    await seedExperiment(userId);

    const report = await effortExperimentTotals(env, { ...WINDOW, outputTokenStrata: [] });
    expect(report.outputTokenStrata).toEqual([]);

    const high = groupOf(report, 'high');
    // 層は 1 つだけで、範囲は `[0, 上限なし)`——層別しないことそのものである。
    expect(high.strata).toHaveLength(1);
    expect(high.strata[0]!.fromOutputTokens).toBe(0);
    expect(high.strata[0]!.toOutputTokens).toBeNull();

    // **群の合計と一致すること。** 1 層に全部入っているので、取りこぼしがあれば割れる。
    expect(high.strata[0]!.calls).toBe(high.calls);
    expect(high.strata[0]!.outputTokens).toBe(high.outputTokens);
    expect(high.strata[0]!.costJpy).toBeCloseTo(high.costJpy, 8);

    // 既定（層が 2 つ以上）と同じ群がそろって返ること（空配列だけ別経路にしない）。
    const medium = groupOf(report, 'medium');
    expect(medium.strata).toHaveLength(1);
    expect(medium.strata[0]!.calls).toBe(medium.calls);
  });

  it('推敲（元ソースが messages に載った生成）を新規生成と混ぜない', async () => {
    // 1.2.43: 推敲は 19.5〜25.0 円、新規生成は約 16 円で**別の値**である。混ぜると
    // effort より大きな差がそこから入る。判定は経路の構造（元ソースの直後の
    // cachePoint により、未キャッシュ入力が差分プロンプトだけになる）から引く。
    const userId = await seedUser('ab-revise');
    await seedExperiment(userId);
    // 1.2.43 の 4 回目の実測（入力 35 / 読み出し 9,478 / 出力 9,036）に合わせる。
    await recordGeneration(
      env,
      {
        userId,
        prompt: '敵を速くして',
        generated: generationOf('sonnet-4-6-high', {
          inputTokens: 35,
          outputTokens: 9_036,
          cacheReadInputTokens: 9_478,
          cacheWriteInputTokens: 0,
        }),
      },
      WINDOW_FROM + 10_000,
    );

    const report = await effortExperimentTotals(env, WINDOW);
    const newGeneration = groupOf(report, 'high', false);
    const revise = groupOf(report, 'high', true);

    expect(newGeneration.calls).toBe(4);
    expect(revise.calls).toBe(1);
    // **同じ effort でも別の行として返る。** 片方だけを読めば混ざらない。
    expect(revise.costJpy).not.toBeCloseTo(newGeneration.costJpy, 6);

    // 分類が崩れていないことを、返ってきた値そのもので確かめられる（谷をまたがない）。
    expect(newGeneration.minInputTokens).toBeGreaterThan(report.baseSourceInputTokenCeiling);
    expect(revise.maxInputTokens).toBeLessThanOrEqual(report.baseSourceInputTokenCeiling);
  });

  it('依頼の切り分けが怪しいときは、そう分かる', async () => {
    // 台帳は作品行と結び付いていない（確定27）ので、依頼の境目は「同じ利用者の同じ
    // プロンプト」から引くしかない。**同じお題を 1 群で 2 回使うと前提が崩れる**ので、
    // 崩れたことが見えなければならない（黙って誤った成功率を出さない）。
    const userId = await seedUser('ab-ambiguous');
    for (let call = 0; call < 4; call += 1) {
      await seedCall(userId, 'high', '同じお題', 9_000, WINDOW_FROM + call * 100);
    }
    const report = await effortExperimentTotals(env, WINDOW);
    expect(groupOf(report, 'high').ambiguousJobs).toBe(1);

    // 時間の広がりでも立つ（3 回以内でも、別々の依頼なら数分に収まらない）。
    const spread = await seedUser('ab-spread');
    await seedCall(spread, 'medium', '同じお題', 6_000, WINDOW_FROM);
    await seedCall(spread, 'medium', '同じお題', 6_000, WINDOW_FROM + AMBIGUOUS_JOB_SPAN_SECONDS + 1);
    const spreadReport = await effortExperimentTotals(env, {
      ...WINDOW,
      fromSeconds: WINDOW_FROM,
      toSeconds: WINDOW_FROM + AMBIGUOUS_JOB_SPAN_SECONDS + 2,
    });
    expect(groupOf(spreadReport, 'medium').ambiguousJobs).toBe(1);
  });

  it('max_tokens で切れた呼び出しは初回成功に数えない', async () => {
    // 切れたソースはコンパイルできない（`isUsableGeneration`）。1 行しか無くても
    // 「初回で通った」ではない。**出力上限に張り付いた群があれば、成功率の差が
    // effort の効果ではなく天井の効果になる。**
    const userId = await seedUser('ab-truncated');
    await seedCall(userId, 'high', '切れるお題', 16_000, WINDOW_FROM + 50, 'max_tokens');
    const report = await effortExperimentTotals(env, WINDOW);
    const high = groupOf(report, 'high');
    expect(high.jobs).toBe(1);
    expect(high.firstCallCompleted).toBe(0);
    expect(high.unusableCalls).toBe(1);
  });

  it('窓の外の行を数えない（0011 より前の行を対照群にしない）', async () => {
    // `effort` 列はこのマイグレーションで足したもので、それより前の行は NULL である。
    // 窓を適用より後に取れば入らない——**その窓が効いていること**をここで見る。
    const userId = await seedUser('ab-window');
    await seedCall(userId, 'high', '窓の中', 9_000, WINDOW_FROM);
    await seedCall(userId, 'high', '窓の前', 9_000, WINDOW_FROM - 1);
    await seedCall(userId, 'high', '窓の後', 9_000, WINDOW_TO);

    const report = await effortExperimentTotals(env, WINDOW);
    expect(groupOf(report, 'high').jobs).toBe(1);
    expect(groupOf(report, 'high').calls).toBe(1);
  });

  it('同じ窓の作品行の内訳を返す（初回成功率の上界を実数へ寄せる）', async () => {
    // 5.2-5 の即拒否（許可外パッケージ）はリトライされず 1 行で終わるため、
    // `firstCallCompleted` はそれを「初回で通った」と数えてしまう。**窓の中では群が
    // 1 つに固定されている**ので、作品行の側から件数を引ける。
    const userId = await seedUser('ab-games');
    await seedCall(userId, 'high', '拒否されるお題', 9_000, WINDOW_FROM + 10);
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at,
                          generation_state, generation_error)
       values (?, ?, 'draft', 'T', 'go1.25.0', ?, 'failed', 'source-rejected')`,
    )
      .bind('ab-game-rejected', userId, WINDOW_FROM + 20)
      .run();

    const report = await effortExperimentTotals(env, WINDOW);
    expect(report.games.total).toBe(1);
    expect(report.games.byState).toEqual({ failed: 1 });
    expect(report.games.byError).toEqual({ 'source-rejected': 1 });
    // 上界と、そこから引くべき数が両方そろっている。
    expect(groupOf(report, 'high').firstCallCompleted).toBe(1);
  });
});
