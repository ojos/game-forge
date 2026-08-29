import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerationPipeline } from '../src/generate.js';
import {
  PipelineStepNotImplemented,
  runJobInline,
  startGeneration,
} from '../src/generate.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import type { GenerationResult } from '../src/generation-models.js';
import { inspectGoImports } from '../src/go-imports.js';
import {
  GeneratedSourceRejected,
  MAX_REPORTED_IMPORTS,
  MAX_REPORTED_IMPORT_LENGTH,
  SOURCE_REJECTED_ERROR,
  SOURCE_REJECTED_STATUS,
  describeSourceRejection,
  inspectGeneratedSource,
} from '../src/source-inspection.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

/**
 * この一群のテストが `startGeneration` へ渡す利用者を、実在する行として用意する。
 *
 * **#150 で必要になった。** 生成の経路はクォータ判定の直後に `games` 行を作るように
 * なり（3.3-2.5）、`games.author_id` は `users(id)` への外部キーである。以前は
 * 作品行がパイプラインの最後でしか作られず、しかもその段はテスト側の差し替えで
 * 潰していたため、利用者が実在しなくても通っていた。
 *
 * **`insert or ignore` にしてある。** 同じ id を複数のテストが使うので、2 回目以降は
 * 何もしない。
 *
 * @param ids 用意する利用者の id
 */
async function seedPipelineUsers(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await env.DB.prepare(
      `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
       values (?, ?, ?, ?, 1, null)`,
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, id)
      .run();
  }
}

beforeAll(async () => {
  await applySchema();
  await seedPipelineUsers([
    'user-1',
  ]);
});


/**
 * 生成の段（3.3-3）の出力を組み立てる。
 *
 * **モデルは登録簿から引く。** 値を書き写すと、登録簿の既定が変わった日にここだけが
 * 古い ID を持つ。
 *
 * @param source 生成された Go ソース
 * @returns 生成結果
 */
function generated(source: string): GenerationResult {
  const model = findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!;
  return {
    modelKey: model.key,
    modelId: model.modelId,
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
 * ソースを組み立てる。
 *
 * @param importBlock import 宣言の部分
 * @returns Go のソース
 */
function source(importBlock: string): string {
  return `package main

${importBlock}

type Game struct{}

func (g *Game) Update() error { return nil }
`;
}

/**
 * 検査を通し、投げられた拒否を取り出す。
 *
 * @param goSource 検査するソース
 * @returns 拒否の例外
 */
function rejectionOf(goSource: string): GeneratedSourceRejected {
  try {
    inspectGeneratedSource(generated(goSource));
  } catch (error) {
    if (error instanceof GeneratedSourceRejected) {
      return error;
    }
    throw error;
  }
  throw new Error('拒否されませんでした');
}

describe('許可外の import を拒否する（5.2-5 / #17）', () => {
  it('許可されたものだけなら何も投げない', () => {
    expect(() =>
      inspectGeneratedSource(
        generated(
          source(`import (
	"math"

	"github.com/hajimehoshi/ebiten/v2"
)`),
        ),
      ),
    ).not.toThrow();
  });

  it('os/exec を含むソースを拒否する', () => {
    const rejected = rejectionOf(source('import "os/exec"'));
    expect(rejected).toBeInstanceOf(GeneratedSourceRejected);
    expect(rejected.offending).toEqual(['os/exec']);
  });

  it('どの import が引っかかったかを呼び出し側から読める（追加 acceptance 2）', () => {
    // 拒否が「何かに引っかかった」だけでは、作者は直しようがない。
    const rejected = rejectionOf(
      source(`import (
	"math"
	"os/exec"
	"syscall"
)`),
    );
    expect(rejected.offending).toEqual(['os/exec', 'syscall']);
    // 許可されたものは違反として運ばない。
    expect(rejected.offending).not.toContain('math');
  });

  it('未実装の段の例外ではない（追加 acceptance 1）', () => {
    // 結線後に 501 が返ると「まだ作っていない」と読まれる。ここで落ちたことは
    // **段が働いた結果**なので、種類として区別できなければならない。
    const rejected = rejectionOf(source('import "os/exec"'));
    expect(rejected).not.toBeInstanceOf(PipelineStepNotImplemented);
  });
});

describe('拒否の理由は検査器のものをそのまま運ぶ（#100 への追随）', () => {
  /** 検査器が落とすソース。理由の種類はここで期待値として書かない。 */
  const rejectedSources = [
    source('import "os/exec"'),
    '',
    'func main() {}',
    'package main\n\nimport (\n\t"math"\n',
    'package main\n\nimport 123\n',
  ];

  it('検査器が返した理由と一致する', () => {
    // **理由を列挙しない。** 期待値を検査器の出力そのものから取ることで、#100 が
    // 新しい理由を足しても、このテストと適合層の両方が直さずに追随する。写し替えを
    // 挟んだ実装はここで落ちる。
    for (const goSource of rejectedSources) {
      const inspection = inspectGoImports(goSource);
      expect(inspection.ok, goSource).toBe(false);
      const rejected = rejectionOf(goSource);
      expect(rejected.reason, goSource).toBe(inspection.ok ? undefined : inspection.reason);
      expect(rejected.offending, goSource).toEqual(inspection.ok ? undefined : (inspection.offending ?? []));
    }
  });

  it('理由が 1 種類へ縮退していない', () => {
    // 上の比較は、すべてが同じ理由でも通る。**種類を区別して運べていること**を別に見る
    // （すべてを `not-allowed` へ丸める実装が通ってしまうのを防ぐ）。
    const reasons = new Set(rejectedSources.map((goSource) => rejectionOf(goSource).reason));
    expect(reasons.size).toBeGreaterThan(1);
  });

  it('違反 import を伴わない理由でも空配列を運ぶ', () => {
    // `undefined` を漏らすと、呼び出し側が毎回 `?? []` を書くことになる。
    expect(rejectionOf('func main() {}').offending).toEqual([]);
  });
});

describe('例外はソース本文を持ち出さない', () => {
  it('message にソースの中身が入らない', () => {
    // 生成物はプロンプトの影響を受ける。8.2 のモデレーション対象になる入力が、
    // `generations.prompt` とは保管場所も寿命も違うログへ流れてよい理由がない
    // （`src/generate.ts` の `describeGenerateError` と同じ方針）。
    const secret = 'この文字列は例外の message に出てはいけない';
    const rejected = rejectionOf(
      `package main

import "os/exec"

const hint = "${secret}"
`,
    );
    expect(rejected.message).not.toContain(secret);
    // 何が起きたかは残す。何も出さないと運用時に理由が読めない。
    expect(rejected.message).toContain('os/exec');
    expect(rejected.name).toBe('GeneratedSourceRejected');
  });

  it('プロンプトはそもそも渡らない', () => {
    // 適合層の引数は `GenerationResult` だけで、`GenerateRequest` を受け取らない。
    // 漏らさないための約束ではなく、渡す経路が無いことで担保する。
    expect(inspectGeneratedSource.length).toBe(1);
  });
});

describe('経路層へ出す形（追加 acceptance 2）', () => {
  it('理由と違反 import を持つ応答本文になる', () => {
    const body = describeSourceRejection(rejectionOf(source('import "os/exec"')));
    expect(body).toEqual({
      error: SOURCE_REJECTED_ERROR,
      reason: 'not-allowed',
      imports: ['os/exec'],
    });
  });

  it('リクエストの誤りでもサーバの故障でもない状態で返す', () => {
    // 400 は「リクエストが壊れている」で、この段まで来たリクエストは検証を通っている。
    // 500 でもない（段は設計どおり働いた）。429 とも別で、枠は既に消費済みである。
    expect(SOURCE_REJECTED_STATUS).toBe(422);
  });

  it('件数に上限を掛け、切り詰めたことを示す', () => {
    const paths = ['os', 'net', 'net/http', 'syscall', 'unsafe', 'embed', 'plugin', 'fmt', 'reflect', 'time', 'bufio', 'bytes', 'io'];
    expect(paths.length).toBeGreaterThan(MAX_REPORTED_IMPORTS);
    const rejected = rejectionOf(
      source(`import (\n${paths.map((path) => `\t"${path}"`).join('\n')}\n)`),
    );
    // 例外そのものは全件を持つ（呼び出し側が必要なら全部見られる）。
    expect(rejected.offending).toEqual(paths);
    // 外へ出す形では上限を掛ける。
    const body = describeSourceRejection(rejected);
    expect(body.imports).toHaveLength(MAX_REPORTED_IMPORTS + 1);
    expect(body.imports.at(-1)).toContain(`他 ${paths.length - MAX_REPORTED_IMPORTS} 件`);
  });

  it('長すぎるパスを切り詰める', () => {
    // import パスは生成物であり、長さはこちらで決まらない。
    const long = 'x'.repeat(MAX_REPORTED_IMPORT_LENGTH * 3);
    const body = describeSourceRejection(rejectionOf(source(`import "${long}"`)));
    expect(body.imports).toHaveLength(1);
    expect([...body.imports[0]!]).toHaveLength(MAX_REPORTED_IMPORT_LENGTH + 1);
    expect(body.imports[0]!.endsWith('…')).toBe(true);
  });

  it('上限ちょうどのパスは切り詰めない', () => {
    const exact = 'y'.repeat(MAX_REPORTED_IMPORT_LENGTH);
    const body = describeSourceRejection(rejectionOf(source(`import "${exact}"`)));
    expect(body.imports).toEqual([exact]);
  });
});

/**
 * 呼ばれた段を順に記録するパイプライン。検査段だけを本物に差し替える。
 *
 * @param inspectSource 差し込む検査段
 * @param goSource 生成の段が返すソース
 * @returns 呼ばれた段の記録と、組み立てたパイプライン
 */
function pipelineWith(inspectSource: GenerationPipeline['inspectSource'], goSource: string): {
  calls: string[];
  pipeline: GenerationPipeline;
} {
  const calls: string[] = [];
  return {
    calls,
    pipeline: {
      checkQuota: async () => {
        calls.push('checkQuota');
        return { allowed: true };
      },
      generateSource: async () => {
        calls.push('generateSource');
        return generated(goSource);
      },
      recordCost: async () => {
        calls.push('recordCost');
      },
      inspectSource: (result) => {
        calls.push('inspectSource');
        inspectSource(result);
      },
      build: async () => {
        calls.push('build');
        return fakeBuildOutcome();
      },
      completeGame: async () => {
        calls.push('completeGame');
        return true;
      },
      // **`startJob` は同期実行に固定する**（#150）。この一群のテストが見ているのは
      // 3.3 の**順序**であって、ジョブをどこで走らせるかではない。既定
      // （`defaultPipeline`）と同じ実装を借りるので、写しにもならない。
      startJob: runJobInline,
    },
  };
}

describe('検査段へそのまま差し込める（結線 PR の前提）', () => {
  // **`src/generate.ts` はこの issue では触らない**（#19 が同じ `defaultPipeline` へ
  // `build` を足すため）。結線は両レーンの完了後に単独の PR で行う。ここで見るのは、
  // その PR が `inspectSource: inspectGeneratedSource` の 1 行で済む形になっていること。
  const step: GenerationPipeline['inspectSource'] = inspectGeneratedSource;

  it('許可外の生成はビルドへ進まない（5.2-5 の「再生成に回さず拒否」）', async () => {
    const { calls, pipeline } = pipelineWith(step, source('import "os/exec"'));
    await expect(
      startGeneration(env, 'user-1', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(GeneratedSourceRejected);
    // 検査までは進み、その先は開かない。**生成をやり直さない**ので generateSource は 1 回。
    expect(calls).toEqual(['checkQuota', 'generateSource', 'recordCost', 'inspectSource']);
  });

  it('費用の計上は検査より前に済んでいる（3.3-4 / 4.3）', async () => {
    // 拒否しても課金は発生済みである。検査で落ちた分が台帳から漏れると、4.3 の
    // 「リトライ分も必ず計上する」が崩れる。
    const { calls, pipeline } = pipelineWith(step, source('import "syscall"'));
    await startGeneration(env, 'user-1', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );
    expect(calls.indexOf('recordCost')).toBeLessThan(calls.indexOf('inspectSource'));
  });

  it('許可されたものだけなら最後まで進む', async () => {
    const { calls, pipeline } = pipelineWith(step, source('import "math"'));
    const result = await startGeneration(env, 'user-1', { prompt: 'ゲーム' }, pipeline);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(calls).toEqual([
      'checkQuota',
      'generateSource',
      'recordCost',
      'inspectSource',
      'build',
      'completeGame',
    ]);
  });
});
