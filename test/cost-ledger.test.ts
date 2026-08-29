import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXCHANGE_RATE_PATTERN,
  USD_JPY_RATE,
  convertUsageToJpy,
  costOfGeneration,
  isUsableGeneration,
  jstMonthRange,
  monthlyCostTotals,
  recordGeneration,
} from '../src/cost-ledger.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  GENERATION_MODELS,
  findGenerationModel,
} from '../src/generation-models.js';
import type {
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
