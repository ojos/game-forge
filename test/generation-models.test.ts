import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  GENERATION_MODELS,
  GENERATION_MODEL_VAR,
  PRICING_SECTION_HEADING,
  UnknownGenerationModel,
  findGenerationModel,
  inferenceProfilePrefix,
  selectGenerationModel,
  supportsPromptCaching,
} from '../src/generation-models.js';

/**
 * env を差し替える。
 *
 * `GENERATION_MODEL` は `wrangler.toml` の `[vars]` が宣言しているため、テスト用の
 * env には既に値が入っている。**上書きと削除の両方を試せる形**にしておく。
 *
 * @param model 宣言する値（`null` なら宣言そのものを消す）
 * @returns 差し替えた env
 */
function envWithModel(model: string | null): Env {
  const copy = { ...env } as unknown as Record<string, unknown>;
  if (model === null) {
    delete copy[GENERATION_MODEL_VAR];
  } else {
    copy[GENERATION_MODEL_VAR] = model;
  }
  return copy as unknown as Env;
}

describe('単価の機械照合（4.1 の表）', () => {
  /**
   * 仕様書 4.1 の単価表を読む。
   *
   * 節の切り出しは `test/go-imports.test.ts` と同じ形で、見出しから次の見出しまで。
   * 単価表はこの節の先頭にあり、後続の表（認証方式・実測）は `####` 以下にあるので
   * 混ざらない。
   *
   * セルの `**` は強調で、値の一部ではない。`—` は「この課金次元を持たない」を表す。
   *
   * @returns モデル ID と 4 つの単価
   */
  function pricingFromSpec(): {
    modelId: string;
    values: (number | null)[];
  }[] {
    const spec = env.TEST_PRODUCT_SPEC;
    const start = spec.indexOf(PRICING_SECTION_HEADING);
    expect(start, `仕様書に「${PRICING_SECTION_HEADING}」の節がありません`).toBeGreaterThan(-1);
    const rest = spec.slice(start + PRICING_SECTION_HEADING.length);
    const end = rest.search(/\n#{1,4} /u);
    const section = end === -1 ? rest : rest.slice(0, end);

    const rows: { modelId: string; values: (number | null)[] }[] = [];
    for (const line of section.split('\n')) {
      const matched = /^\|\s*\*{0,2}`([^`]+)`\*{0,2}\s*\|(.*)\|\s*$/u.exec(line);
      if (matched === null) {
        continue;
      }
      const values = matched[2]!.split('|').map((cell) => {
        const text = cell.replaceAll('*', '').trim();
        return text === '—' ? null : Number(text);
      });
      rows.push({ modelId: matched[1]!, values });
    }
    return rows;
  }

  it('仕様書 4.1 の単価がコード側と一致する', () => {
    // ずれると費用台帳（#22）の円換算が静かに狂い、4.3 の月次 1 万円が上振れする。
    // 数値を 2 か所に書く以上、機械で照合する（shared-ai-rules 12 章）。
    expect(pricingFromSpec()).toEqual(
      GENERATION_MODELS.map((model) => ({
        modelId: model.modelId,
        values: [
          model.pricing.inputUsdPerMillion,
          model.pricing.outputUsdPerMillion,
          model.pricing.cacheReadUsdPerMillion,
          model.pricing.cacheWriteUsdPerMillion,
        ],
      })),
    );
  });

  it('仕様書の表が空でない', () => {
    // 上の比較は、節が見つからず両方が空でも通ってしまう。実体があることを別に見る。
    expect(pricingFromSpec().length).toBeGreaterThan(0);
  });
});

describe('Bedrock 固有のモデル ID の差分', () => {
  it('Anthropic のモデルは推論プロファイル ID である', () => {
    // 素のモデル ID はオンデマンドで呼べず、
    // `Invocation of model ID ... with on-demand throughput isn't supported` になる（4.1）。
    // 接頭辞を落として登録した瞬間に、実呼び出しの初回で初めて分かる失敗になる。
    for (const model of GENERATION_MODELS.filter((entry) => entry.provider === 'anthropic')) {
      expect(inferenceProfilePrefix(model.modelId), model.modelId).not.toBeNull();
    }
  });

  it('提供者の接頭辞を推論プロファイルと取り違えない', () => {
    // `deepseek.` は提供者の接頭辞で、地理スコープではない。素の ID のまま東京で
    // 実生成できている（4.1 / #79）。
    expect(inferenceProfilePrefix('deepseek.v3.2')).toBeNull();
    expect(inferenceProfilePrefix('jp.anthropic.claude-sonnet-4-6')).toBe('jp.');
    expect(inferenceProfilePrefix('global.anthropic.claude-sonnet-4-6')).toBe('global.');
    expect(inferenceProfilePrefix('apac.anthropic.claude-sonnet-4-6')).toBe('apac.');
  });
});

describe('モデルごとの設定', () => {
  it('鍵が重複しない', () => {
    const keys = GENERATION_MODELS.map((model) => model.key);
    expect([...new Set(keys)]).toEqual(keys);
  });

  it('キャッシュの可否を単価から導く', () => {
    // フラグを別に持つと、単価表を直したときに片方だけが残る。DeepSeek は
    // キャッシュの課金次元を持たない（4.1。API ではなくモデルの性質）。
    expect(supportsPromptCaching(findGenerationModel('sonnet-4-6')!)).toBe(true);
    expect(supportsPromptCaching(findGenerationModel('deepseek-v3-2')!)).toBe(false);
  });

  it('出力上限が 4.2 の実測を上回る', () => {
    // 実測（Sonnet 4.6 = 4,171 / DeepSeek = 2,159）を下回る上限を置くと、
    // 平均的な生成が `max_tokens` で切れて必ずコンパイルに失敗する。
    expect(findGenerationModel('sonnet-4-6')!.maxTokens).toBeGreaterThan(4_171);
    expect(findGenerationModel('deepseek-v3-2')!.maxTokens).toBeGreaterThan(2_159);
  });

  it('既定のモデルが登録簿にある', () => {
    expect(findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)).not.toBeNull();
  });
});

describe('モデル選択の経路（#83 acceptance 2）', () => {
  it('宣言された鍵のモデルを選ぶ', () => {
    for (const model of GENERATION_MODELS) {
      expect(selectGenerationModel(envWithModel(model.key))).toEqual(model);
    }
  });

  it('切り替えるとモデル ID が変わる', () => {
    // 「切り替えられる」ことの本体は、送り先のモデル ID が実際に変わることである。
    expect(selectGenerationModel(envWithModel('sonnet-4-6')).modelId).toBe(
      'jp.anthropic.claude-sonnet-4-6',
    );
    expect(selectGenerationModel(envWithModel('deepseek-v3-2')).modelId).toBe('deepseek.v3.2');
  });

  it('未宣言・空なら既定のモデルを選ぶ', () => {
    for (const value of [null, '', '   ']) {
      expect(selectGenerationModel(envWithModel(value)).key).toBe(DEFAULT_GENERATION_MODEL_KEY);
    }
  });

  it('未知の名前は既定へ落とさず例外にする', () => {
    // 綴り違いを既定で拾うと、A/B の片側が黙ってもう片側になり、4.2 の比較
    // （成功率と単価）が成立しない。費用の出る経路で曖昧な指定を推測で受け取らない。
    expect(() => selectGenerationModel(envWithModel('sonnet-5'))).toThrow(UnknownGenerationModel);
    expect(() => selectGenerationModel(envWithModel('Sonnet-4-6'))).toThrow(UnknownGenerationModel);
  });

  it('例外に使える鍵の一覧が入る', () => {
    // 落ちたときに宣言をどう直せばよいかが、その場で読めること。
    const error = new UnknownGenerationModel('typo');
    for (const model of GENERATION_MODELS) {
      expect(error.message).toContain(model.key);
    }
  });
});

describe('wrangler.toml の宣言（#83）', () => {
  /**
   * 指定したテーブルから `KEY = "value"` を取り出す。
   *
   * TOML の完全な解析はしない（`test/origins.test.ts` と同じ方針）。
   *
   * @param toml wrangler.toml の中身
   * @param table テーブル名（`[vars]` など）
   * @param key キー名
   * @returns 値（見つからなければ null）
   */
  function varIn(toml: string, table: string, key: string): string | null {
    // テーブルの範囲は行で切る。正規表現の `[^[]*` で切ると、**コメント中の角括弧
    // （この宣言の説明に出てくる `[vars]` など）でも打ち切られる**（実際に踏んだ）。
    const lines = toml.split('\n');
    const start = lines.indexOf(table);
    if (start === -1) {
      return null;
    }
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('[')) {
        return null;
      }
      const matched = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line);
      if (matched !== null) {
        return matched[1]!;
      }
    }
    return null;
  }

  it('全環境で生成モデルが明示されている', () => {
    // vars は名前付き環境へ引き継がれない（wrangler.toml の注記）。書き忘れた環境は
    // 既定へ寄るが、**暗黙に既定へ寄るのと、そのモデルを選んだのとは別物**である。
    for (const table of ['[vars]', '[env.production.vars]', '[env.preview.vars]']) {
      const declared = varIn(env.TEST_WRANGLER_TOML, table, GENERATION_MODEL_VAR);
      expect(declared, table).not.toBeNull();
      expect(findGenerationModel(declared!), `${table}: ${declared}`).not.toBeNull();
    }
  });
});
