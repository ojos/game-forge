import { describe, expect, it } from 'vitest';
import {
  BUILD_FAILED_ERROR,
  BUILD_FAILED_STATUS,
  BuildRetriesExhausted,
  MAX_GENERATION_ATTEMPTS,
  MAX_RETRY_DIAGNOSTICS_BYTES,
  truncateBytes,
  buildRetryContext,
  composeRetryPrompt,
  describeBuildFailure,
  retriableBuildFailure,
  withBuildDiagnostics,
} from '../src/build-retry.js';
import type { BuildRetryContext } from '../src/build-retry.js';
import {
  BuildFunctionFailed,
  BuildNotConfigured,
  BuildRejected,
  BuildResponseUnreadable,
  BuildTimedOut,
} from '../src/build-client.js';
import type { BuildFailure, BuildFailureKind } from '../src/build-client.js';
import { GeneratedSourceRejected } from '../src/source-inspection.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import type { GenerationResult } from '../src/generation-models.js';
import { MAX_SOURCE_BYTES } from '../src/system-prompt.js';

/**
 * 生成結果の雛形。
 *
 * @param source Go ソース
 * @returns 生成結果
 */
function generation(source: string): GenerationResult {
  return {
    modelKey: DEFAULT_GENERATION_MODEL_KEY,
    modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
    source,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    },
    stopReason: 'end_turn',
  };
}

/**
 * リトライの材料の雛形。
 *
 * @param overrides 差し替える項目
 * @returns 材料
 */
function context(overrides: Partial<BuildRetryContext> = {}): BuildRetryContext {
  return {
    failedAttempt: 1,
    stage: 'build',
    diagnostics: './main.go:12:2: undefined: ebiten.RunGameX',
    previousSource: 'package main\n\nfunc main() {}\n',
    ...overrides,
  };
}

describe('何をリトライ対象にするか（5.2-7 / #20 の決定）', () => {
  /**
   * 失敗の種別ごとの代表例。
   *
   * **`Record<BuildFailureKind, …>` にしてある。** `src/build-client.ts` が種別を
   * 増やしたとき、ここが**コンパイルで落ちる。** 増えた種別を黙ってリトライ対象に
   * したり、黙って対象外にしたりすると、どちらも費用の向きに効く判断が
   * 誰にも見えないまま入る（shared-ai-rules 12 章の「一覧の複製は機械照合で担保する」）。
   */
  const byKind: Record<BuildFailureKind, BuildFailure> = {
    build: new BuildRejected('build', './main.go:1:1: syntax error'),
    config: new BuildNotConfigured(['BUILD_AWS_ACCESS_KEY_ID']),
    timeout: new BuildTimedOut('function', 'req-1'),
    function: new BuildFunctionFailed(429, 'TooManyRequestsException', null, 'req-1'),
  };

  it('コンパイル失敗（kind=build）だけをリトライ対象にする', () => {
    for (const [kind, failure] of Object.entries(byKind)) {
      const retriable = retriableBuildFailure(failure);
      if (kind === 'build') {
        expect(retriable, kind).toBeInstanceOf(BuildRejected);
      } else {
        // **回すと必ず 3 回課金して失敗する。** `config` は環境の不備で決定的に
        // 落ち、`timeout` と `function` は関数側の事情なので生成をやり直しても
        // 変わらない（3.8 の degrade の対象）。
        expect(retriable, kind).toBeNull();
      }
    }
  });

  it('応答が読めなかった失敗（kind=function）は対象外である', () => {
    // `readBuildResult` は `stage` の無い `ok:false` をこれにする。診断の無い
    // ビルド失敗を再生成へ回さないための分岐であり、こちら側でも対象外にする。
    expect(retriableBuildFailure(new BuildResponseUnreadable('stage'))).toBeNull();
  });

  it('5.2-5 の拒否（許可外 import）は対象外である', () => {
    // 混ぜると、禁止パッケージを使いたがるプロンプトが 1 リクエストで 3 回の生成を
    // 起こせる（4.3 の枠が緩む）。
    expect(retriableBuildFailure(new GeneratedSourceRejected('not-allowed', ['os/exec']))).toBeNull();
  });

  it('ビルド段以外の例外は対象外である', () => {
    for (const value of [new Error('boom'), 'build failed', null, undefined, { kind: 'build' }]) {
      expect(retriableBuildFailure(value), String(value)).toBeNull();
    }
  });
});

describe('診断の再投入（5.2-7 の「エラー出力を LLM に返して」）', () => {
  it('利用者のプロンプトを残したまま、直前のソースと診断を添える', () => {
    const composed = composeRetryPrompt('弾を避けるゲーム', context());
    expect(composed).toContain('弾を避けるゲーム');
    expect(composed).toContain('package main');
    expect(composed).toContain('undefined: ebiten.RunGameX');
  });

  it('利用者のプロンプトを置き換えない', () => {
    // 差し替えると、コンパイルが直っても別のゲームができる。
    const composed = composeRetryPrompt('弾を避けるゲーム', context());
    expect(composed.startsWith('弾を避けるゲーム')).toBe(true);
  });

  it('何回目の試行で落ちたかを伝える', () => {
    expect(composeRetryPrompt('ゲーム', context({ failedAttempt: 2 }))).toContain('2 回目');
  });

  it('診断が空なら、その節ごと落とす', () => {
    // 関数は診断を持たずに落ちる段を持つ（`BuildRejected` は空の診断を許す）。
    // 空の見出しを置くと「診断はここにある」と読める形で何も無い状態になる。
    const composed = composeRetryPrompt('ゲーム', context({ diagnostics: '' }));
    expect(composed).not.toContain('コンパイラの出力');
    // 材料が減っても、前回のソースと「落ちたこと」は伝える（引き直しには意味がある）。
    expect(composed).toContain('package main');
    expect(composed).toContain('コンパイルできませんでした');
  });

  it('前回のソースを 6.1 の上限で切り詰める', () => {
    const huge = `package main\n${'// あ\n'.repeat(20_000)}`;
    expect(new TextEncoder().encode(huge).byteLength).toBeGreaterThan(MAX_SOURCE_BYTES * 2);

    const composed = composeRetryPrompt('ゲーム', context({ previousSource: huge }));
    // プロンプト全体でも、切り詰めた本文＋定型文の分しか増えない。
    expect(new TextEncoder().encode(composed).byteLength).toBeLessThan(MAX_SOURCE_BYTES + 2_000);
    // 黙って削らない。切れていることが読めないと、モデルは切れた行を直そうとする。
    expect(composed).toContain('省略');
  });

  it('診断を自分の側の上限で切り詰める', () => {
    // 関数側の 8 KiB は関数の契約で、こちらの入力トークンの上限ではない。
    const huge = 'x'.repeat(MAX_RETRY_DIAGNOSTICS_BYTES * 3);
    const composed = composeRetryPrompt('ゲーム', context({ diagnostics: huge }));
    expect(composed).not.toContain(huge);
    expect(composed.length).toBeLessThan(MAX_RETRY_DIAGNOSTICS_BYTES * 2);
  });

  it('リトライは request の中身を保つ（prompt だけ差し替える）', async () => {
    // **レビュー指摘（#20）の回帰。** 新しい object を作っていたため、あとで
    // `GenerateRequest` へ項目が増えるとリトライ経路だけが黙って落とす形だった。
    // 「初回とリトライで渡すものが違う」こと自体が罠なので、構造として消す。
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withBuildDiagnostics(async (_env, request) => {
      seen.push(request as unknown as Record<string, unknown>);
      return generation('package main\n');
    });

    const request = { prompt: 'ゲーム', locale: 'ja' } as unknown as { readonly prompt: string };
    await wrapped({} as Env, request);
    await wrapped({} as Env, request, context());

    expect(seen).toHaveLength(2);
    // 初回はそのまま。
    expect(seen[0]).toEqual(request);
    // リトライは prompt だけが変わり、他は残る。
    expect(seen[1]!['locale']).toBe('ja');
    expect(seen[1]!['prompt']).not.toBe('ゲーム');
  });

  it('注記を含めて上限に収まる', () => {
    // **レビュー指摘（#20）の回帰。** 注記を上限の外側で足していたため、返り値が
    // maxBytes を超えていた。上限を置いた目的はプロンプトの肥大化を抑えること
    // （入力トークンはそのまま費用である。4.1）なので、超える経路があると目的を
    // 果たさない。
    for (const limit of [16, 64, 256, 1_024, MAX_RETRY_DIAGNOSTICS_BYTES]) {
      const out = truncateBytes('x'.repeat(limit * 4), limit);
      expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(limit);
    }
  });

  it('上限が注記より小さければ注記自身を切る', () => {
    // 注記だけで 40 バイト超あるので、上限がそれ未満なら注記も切らないと超える。
    // **読みやすさより超えないことを優先する**（上限は費用の上限である。4.1）。
    const out = truncateBytes('x'.repeat(1_000), 8);
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(8);
    expect(out).not.toContain('x');
    // 途中で切っても U+FFFD を作らない。
    expect(out).not.toContain('\uFFFD');
  });

  it('多バイト文字の途中で切らない', () => {
    // 途中で切ると復号で U+FFFD が出て、モデルには「そういう文字が書いてある」と見える。
    const composed = composeRetryPrompt('ゲーム', context({ diagnostics: 'あ'.repeat(5_000) }));
    expect(composed).not.toContain('�');
  });

  it('失敗した試行と生成結果から材料を組み立てる', () => {
    const generated = generation('package main\n');
    const built = buildRetryContext(2, new BuildRejected('build', '診断'), generated);
    expect(built).toEqual({
      failedAttempt: 2,
      stage: 'build',
      diagnostics: '診断',
      previousSource: 'package main\n',
    });
  });
});

describe('生成の段を包む継ぎ目（withBuildDiagnostics）', () => {
  it('初回はプロンプトをそのまま渡す', async () => {
    const seen: string[] = [];
    const wrapped = withBuildDiagnostics(async (_env, request) => {
      seen.push(request.prompt);
      return generation('package main\n');
    });
    await wrapped({} as Env, { prompt: '弾を避けるゲーム' });
    expect(seen).toEqual(['弾を避けるゲーム']);
  });

  it('2 回目以降は診断を織り込んだプロンプトを渡す', async () => {
    const seen: string[] = [];
    const wrapped = withBuildDiagnostics(async (_env, request) => {
      seen.push(request.prompt);
      return generation('package main\n');
    });
    await wrapped({} as Env, { prompt: '弾を避けるゲーム' }, context());
    expect(seen[0]).toContain('弾を避けるゲーム');
    expect(seen[0]).toContain('undefined: ebiten.RunGameX');
  });

  it('包む層を外すと診断が届かない（この層が効いていることの確認）', async () => {
    // **変異検査。** 包まずに直接呼ぶと、材料を渡す口そのものが無く、リトライは
    // 診断を捨てた引き直しになる。届いている文字列がこの層の産物であることを、
    // 包まない場合と突き合わせて確かめる。
    const seen: string[] = [];
    const inner = async (_env: Env, request: { readonly prompt: string }) => {
      seen.push(request.prompt);
      return generation('package main\n');
    };
    await inner({} as Env, { prompt: '弾を避けるゲーム' });
    await withBuildDiagnostics(inner)({} as Env, { prompt: '弾を避けるゲーム' }, context());
    expect(seen[0]).not.toContain('undefined: ebiten.RunGameX');
    expect(seen[1]).toContain('undefined: ebiten.RunGameX');
  });
});

describe('上限に達したときの応答（#20 scope.in 4）', () => {
  const exhausted = new BuildRetriesExhausted(MAX_GENERATION_ATTEMPTS, 'build');

  it('422 で返す', () => {
    // 400 でも 500 でも 429 でもない理由は `src/build-retry.ts` に書いてある。
    expect(BUILD_FAILED_STATUS).toBe(422);
  });

  it('試行回数と利用者向けの文言を返す', () => {
    const described = describeBuildFailure(exhausted);
    expect(described.error).toBe(BUILD_FAILED_ERROR);
    expect(described.attempts).toBe(MAX_GENERATION_ATTEMPTS);
    expect(described.message).toContain(`${MAX_GENERATION_ATTEMPTS} 回`);
  });

  it('消費した枠の回数を伝える', () => {
    // 1 リクエストが枠を 1 回分しか使わないと読める文言にすると、残枠の表示
    // （4.4 / #24）が 3 減る理由が利用者から見て消える。
    expect(describeBuildFailure(exhausted).message).toContain('生成枠');
  });

  it('診断も段の名前も外へ出さない', () => {
    // Go の診断は生成コードの行を引用する。応答にもログにも出さない。
    const body = JSON.stringify(describeBuildFailure(new BuildRetriesExhausted(3, 'compress')));
    expect(body).not.toContain('compress');
    expect(exhausted.message).not.toContain('診断');
  });
});
