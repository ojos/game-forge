import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GO_DIAGNOSTIC_ERROR_LIMIT,
  MAX_MECHANICAL_FIX_PASSES,
  MECHANICAL_FIX_OUTCOMES,
  offsetOfPosition,
  parseUnusedImports,
  removeUnusedImports,
} from '../src/mechanical-fix.js';
import { GO_IMPORT_ALLOWLIST } from '../src/go-import-allowlist.js';
import { scanImportSpecs, scanImports } from '../src/go-imports.js';
import { BuildNotConfigured, BuildRejected } from '../src/build-client.js';
import type { BuildOutcome } from '../src/build-client.js';
import { BuildRetriesExhausted, MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import type { BuildRetryContext } from '../src/build-retry.js';
import { runJobInline, startGeneration } from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import type { GenerationResult } from '../src/generation-models.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import { recordGenerationCost } from '../src/cost-ledger.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

/**
 * 未使用 import を 1 つだけ持つソース。
 *
 * `"errors"` が使われていない。行番号は 4、桁は 2（字下げのタブが 1 バイト）である。
 */
const UNUSED_IMPORT_SOURCE = `package main

import (
\t"errors"
\t"github.com/hajimehoshi/ebiten/v2"
)

func main() {
\t_ = ebiten.RunGame
}
`;

/** {@link UNUSED_IMPORT_SOURCE} から `"errors"` の行だけが消えた形。 */
const REPAIRED_SOURCE = `package main

import (
\t"github.com/hajimehoshi/ebiten/v2"
)

func main() {
\t_ = ebiten.RunGame
}
`;

/**
 * {@link UNUSED_IMPORT_SOURCE} に対する Go の診断。
 *
 * **実測の形である**（Go 1.26.5 / `docker/isolated-build/Dockerfile` の `golang:1.26.5`
 * と同じ版。`GOOS=js GOARCH=wasm` でも同じ文言）。関数側は `go build` の標準出力と
 * 標準エラーを結合して返すので、先頭のパッケージ見出しの行も込みで写す。
 */
const UNUSED_IMPORT_DIAGNOSTICS = `# gameforge/game
./main.go:4:2: "errors" imported and not used`;

/** 機械修正では直らない失敗（存在しない API の捏造。4.2 の実測にある形）。 */
const SEMANTIC_DIAGNOSTICS = `# gameforge/game
./main.go:9:2: undefined: vector.DrawFilledRoundRect`;

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `mech-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 生成結果の雛形。
 *
 * @param source Go ソース
 * @returns 生成結果
 */
function generationOf(source: string): GenerationResult {
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

/** 観測用のパイプラインが記録するもの。 */
interface Observed {
  /** 呼ばれた段の並び。 */
  readonly calls: string[];
  /** `build` へ渡ったソース（呼ばれた順）。 */
  readonly builtSources: string[];
  /** `generateSource` が受け取ったリトライの材料（呼ばれた順）。 */
  readonly retries: (BuildRetryContext | undefined)[];
}

/**
 * ビルド段だけを差し替えられるパイプラインを作る。
 *
 * **実物の Bedrock も実物の Lambda も呼ばない**（呼べば課金される）。生成もビルドも
 * 差し替え可能な継ぎ目（seam）で止める。
 *
 * @param source 生成の段が返すソース
 * @param build ビルド段（渡されたソースを見て成否を決める）
 * @returns 観測用の記録と、パイプライン
 */
function pipelineOf(
  source: string,
  build: (generated: GenerationResult) => BuildOutcome,
): { observed: Observed; pipeline: GenerationPipeline } {
  const observed: Observed = { calls: [], builtSources: [], retries: [] };
  return {
    observed,
    pipeline: {
      checkQuota: async () => {
        observed.calls.push('checkQuota');
        return { allowed: true };
      },
      generateSource: async (_env, _request, retry) => {
        observed.calls.push('generateSource');
        observed.retries.push(retry);
        return generationOf(source);
      },
      recordCost: async () => {
        observed.calls.push('recordCost');
      },
      inspectSource: () => {
        observed.calls.push('inspectSource');
      },
      build: async (_env, generated) => {
        observed.calls.push('build');
        observed.builtSources.push(generated.source);
        return build(generated);
      },
      completeGame: async () => {
        observed.calls.push('completeGame');
        return true;
      },
      // **`startJob` は同期実行に固定する**（#150）。この一群のテストが見ているのは
      // 3.3 の**順序**であって、ジョブをどこで走らせるかではない。既定
      // （`defaultPipeline`）と同じ実装を借りるので、写しにもならない。
      startJob: runJobInline,
    },
  };
}

/**
 * 「未使用 import が残っていればコンパイルに失敗する」ビルド段。
 *
 * 診断は**固定の実測文字列**を返す。位置の計算をこちら側でやり直すと、検証したい
 * 位置合わせをテストが自前で再現することになる。
 *
 * @param unusedPath 使われていない import パス
 * @param diagnostics 落ちるときに返す診断
 * @returns ビルド段
 */
function compilerThatRejects(
  unusedPath: string,
  diagnostics: string,
): (generated: GenerationResult) => BuildOutcome {
  return (generated) => {
    const scanned = scanImports(generated.source);
    if (!scanned.ok || scanned.imports.includes(unusedPath)) {
      throw new BuildRejected('build', diagnostics);
    }
    return fakeBuildOutcome();
  };
}

/**
 * Go の診断を実測の形で組み立てる（**10 件で打ち切るところまで写す**）。
 *
 * 未使用 import が 11 件以上あるソースを扱う検査でだけ使う。ここでしか使わないのは、
 * 位置の計算を写した実装であり、**固定の実測文字列で確かめられる検査ではそちらを使う**
 * ためである。
 *
 * @param source Go ソース
 * @param used 使われている import パス
 * @returns 診断
 */
function emulateGoDiagnostics(source: string, used: readonly string[]): string {
  const scanned = scanImportSpecs(source);
  if (!scanned.ok) {
    throw new Error('テストの前提が壊れています（ソースを読めません）');
  }
  const lines: string[] = ['# gameforge/game'];
  for (const declaration of scanned.declarations) {
    for (const spec of declaration.specs) {
      if (used.includes(spec.path) || spec.alias === '_') {
        continue;
      }
      if (lines.length > GO_DIAGNOSTIC_ERROR_LIMIT) {
        lines.push('./main.go:1:1: too many errors');
        return lines.join('\n');
      }
      const before = scanned.text.slice(0, spec.start);
      const line = before.split('\n').length;
      const column =
        new TextEncoder().encode(before.slice(before.lastIndexOf('\n') + 1)).byteLength + 1;
      const alias = spec.alias !== null && spec.alias !== '.' ? ` as ${spec.alias}` : '';
      lines.push(`./main.go:${line}:${column}: "${spec.path}" imported${alias} and not used`);
    }
  }
  return lines.join('\n');
}

/**
 * 台帳の行を読む。
 *
 * @param userId 利用者の id
 * @returns 記録された行（古い順）
 */
async function ledgerRows(userId: string): Promise<{ prompt: string; succeeded: number }[]> {
  const rows = await env.DB.prepare(
    'select prompt, succeeded from generations where user_id = ? order by rowid',
  )
    .bind(userId)
    .all<{ prompt: string; succeeded: number }>();
  return rows.results;
}

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
    'mech-user-config',
    'mech-user-fixed',
    'mech-user-handoff',
    'mech-user-inspect',
    'mech-user-log-exhausted',
    'mech-user-mutated',
    'mech-user-observed',
    'mech-user-semantic',
    'mech-user-many',
    'mech-user-log-safe',
  ]);
});

afterAll(async () => {
  // **このファイルが置いた行だけを消す。** 月次上限（4.3 層 1）はサービス全体の累計で
  // 判定するので、実物の台帳へ書いた行を残すと他の経路の判定に効く。
  await env.DB.prepare("delete from generations where user_id like 'mech-user-%'").run();
});

describe('診断から未使用 import を読む（実測の形。Go 1.26.5）', () => {
  it('3 つの形をすべて読む', () => {
    // 実測（2026-08-28。`golang:1.26.5` と同じ版）。素の import・別名付き・ドット。
    const diagnostics = [
      '# probe',
      './main.go:5:2: "os" imported and not used',
      './main.go:6:2: "strings" imported as str and not used',
      './main.go:7:2: "math" imported and not used',
    ].join('\n');

    expect(parseUnusedImports(diagnostics)).toEqual([
      { line: 5, column: 2, path: 'os', alias: null },
      { line: 6, column: 2, path: 'strings', alias: 'str' },
      { line: 7, column: 2, path: 'math', alias: null },
    ]);
  });

  it('未使用 import 以外の診断を拾わない', () => {
    const diagnostics = [
      '# probe',
      './main.go:12:2: undefined: ebiten.RunGameX',
      './main.go:13:2: too many errors',
      'go: downloading example.com/x v1.0.0',
    ].join('\n');
    expect(parseUnusedImports(diagnostics)).toEqual([]);
  });

  it('モジュールルート以外のファイルの診断を拾わない', () => {
    // 生成コードは作業ディレクトリ直下に書かれる。別ファイルの行・桁をこちらの
    // ソースへ当てると、無関係な import を消しうる。
    const diagnostics = './vendor/example.com/x/y.go:5:2: "os" imported and not used';
    expect(parseUnusedImports(diagnostics)).toEqual([]);
  });

  it('`./` が付いていなくても読む', () => {
    expect(parseUnusedImports('main.go:5:2: "os" imported and not used')).toEqual([
      { line: 5, column: 2, path: 'os', alias: null },
    ]);
  });
});

describe('未使用 import を除去する（4.2 の 1 段目）', () => {
  it('括弧形から 1 件だけ消し、ほかは 1 文字も変えない', () => {
    const result = removeUnusedImports(UNUSED_IMPORT_SOURCE, UNUSED_IMPORT_DIAGNOSTICS);
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(result.source).toBe(REPAIRED_SOURCE);
    expect(result.removed).toEqual(['errors']);
  });

  it('単一形（`import "errors"`）は宣言ごと消す', () => {
    // ImportSpec だけを消すと `import` が単独で残り、構文エラーになる。
    const source = 'package main\n\nimport "errors"\n\nfunc main() {}\n';
    const result = removeUnusedImports(source, './main.go:3:8: "errors" imported and not used');
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    // 行ごと消えるので空行が 1 つ増えて見えるが、**空行を詰める整形はしない**
    // （この関数がするのは import の除去だけである）。
    expect(result.source).toBe('package main\n\n\nfunc main() {}\n');
    expect(scanImports(result.source)).toEqual({ ok: true, imports: [] });
  });

  it('同じパスを別名で 2 回 import したら、診断された側だけを消す', () => {
    // **位置で消していることの証拠である。** パス一致だけで消すと、使われている
    // ほうまで消える（実測: Go は使われていない側だけを別名付きで報告する）。
    const source = `package main

import (
\ts1 "strconv"
\ts2 "strconv"
)

func main() {
\t_ = s1.Itoa
}
`;
    const result = removeUnusedImports(
      source,
      './main.go:5:2: "strconv" imported as s2 and not used',
    );
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(result.source).toContain('s1 "strconv"');
    expect(result.source).not.toContain('s2 "strconv"');
  });

  it('位置が合っていてもパスが違えば消さない', () => {
    // 別のファイルの診断が偶然この位置に当たった場合にあたる。**迷ったら触らない。**
    const result = removeUnusedImports(
      UNUSED_IMPORT_SOURCE,
      './main.go:4:2: "math" imported and not used',
    );
    expect(result).toEqual({ changed: false, reason: 'not-located' });
  });

  it('パスが合っていても位置が違えば消さない', () => {
    const result = removeUnusedImports(
      UNUSED_IMPORT_SOURCE,
      './main.go:5:2: "errors" imported and not used',
    );
    expect(result).toEqual({ changed: false, reason: 'not-located' });
  });

  it('別名の食い違いを消さない', () => {
    const source = 'package main\n\nimport (\n\ts1 "strconv"\n)\n';
    const result = removeUnusedImports(
      source,
      './main.go:4:2: "strconv" imported as s2 and not used',
    );
    expect(result).toEqual({ changed: false, reason: 'not-located' });
  });

  it('明示的なセミコロンで区切られていても壊さない', () => {
    // `import ("errors"; "math")` から `"errors"` だけを抜くと `(; "math")` になり、
    // `missing import path` で落ちる（実測）。直後のセミコロンごと消す。
    const source = 'package main\n\nimport ("errors"; "math")\n';
    const result = removeUnusedImports(source, './main.go:3:9: "errors" imported and not used');
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(result.source).not.toContain(';');
    expect(scanImports(result.source)).toEqual({ ok: true, imports: ['math'] });
  });

  it('すべて未使用なら空の括弧が残る（正当な Go である）', () => {
    // 実測: `import ()` も、コメントだけが残った括弧もコンパイルできる。宣言ごと
    // 消す分岐を持たないほうが、消し過ぎる余地が無い。
    const source = 'package main\n\nimport (\n\t"errors"\n\t"math"\n)\n\nfunc main() {}\n';
    const result = removeUnusedImports(
      source,
      ['./main.go:4:2: "errors" imported and not used', './main.go:5:2: "math" imported and not used'].join(
        '\n',
      ),
    );
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(result.source).toBe('package main\n\nimport (\n)\n\nfunc main() {}\n');
    expect(scanImports(result.source)).toEqual({ ok: true, imports: [] });
  });

  it('行末コメントは残す（宣言だけを消す）', () => {
    // コメントが残るのは正当な Go である。中身を解釈して消す判断はここでは行わない。
    const source = 'package main\n\nimport (\n\t"errors" // あとで使う\n\t"math"\n)\n';
    const result = removeUnusedImports(source, './main.go:4:2: "errors" imported and not used');
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(result.source).toContain('// あとで使う');
    expect(scanImports(result.source)).toEqual({ ok: true, imports: ['math'] });
  });

  it('文字列リテラルの中の import は消さない', () => {
    // 生成コードは診断そっくりの文字列を含みうる。**消す位置は字句解析が決める。**
    const source = `package main

import (
\t"errors"
\t"strconv"
)

func main() {
\tconst help = \`import (
\t"errors"
)\`
\t_ = help
\t_ = strconv.Itoa
}
`;
    const result = removeUnusedImports(source, './main.go:4:2: "errors" imported and not used');
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    // 生文字列の中の import 節はそのまま残る。
    expect(result.source).toContain('const help = `import (\n\t"errors"\n)`');
    expect(scanImports(result.source)).toEqual({ ok: true, imports: ['strconv'] });
  });

  it('診断に未使用 import が無ければ何もしない', () => {
    expect(removeUnusedImports(UNUSED_IMPORT_SOURCE, SEMANTIC_DIAGNOSTICS)).toEqual({
      changed: false,
      reason: 'no-unused-imports',
    });
  });

  it('読めないソースには触らない', () => {
    const result = removeUnusedImports(
      'import "errors"',
      './main.go:1:8: "errors" imported and not used',
    );
    expect(result).toEqual({ changed: false, reason: 'unreadable-source' });
  });

  it('除去の結果は必ず読み直して確かめる', () => {
    // 出力を読み直して「消した分だけ減った」ことを確認してから返す。壊れた出力は
    // `changed: false` になり、2 段目へ回る（最悪でも「何もしなかった」に着地する）。
    const result = removeUnusedImports(UNUSED_IMPORT_SOURCE, UNUSED_IMPORT_DIAGNOSTICS);
    expect(result.changed).toBe(true);
    if (!result.changed) {
      return;
    }
    expect(scanImports(result.source)).toEqual({
      ok: true,
      imports: ['github.com/hajimehoshi/ebiten/v2'],
    });
  });
});

describe('Go の位置（行・桁）を添字へ直す', () => {
  it('桁をバイト数で数える', () => {
    // 日本語のコメントを含む行で文字数と食い違う。`go/token` の Column はバイト数。
    const text = '// あ\npackage main\n';
    // 1 行目は `//` の 2 バイト＋「あ」の 3 バイトで 5 バイト。次の行の先頭は桁 1。
    expect(offsetOfPosition(text, 1, 6)).toBe(null);
    expect(offsetOfPosition(text, 2, 1)).toBe(text.indexOf('package'));
  });

  it('行や桁がソースの外なら null を返す', () => {
    const text = 'package main\n';
    expect(offsetOfPosition(text, 9, 1)).toBe(null);
    expect(offsetOfPosition(text, 1, 99)).toBe(null);
    expect(offsetOfPosition(text, 0, 1)).toBe(null);
  });
});

describe('生成ループへの結線（#129 の acceptance）', () => {
  it('未使用 import だけが原因のソースは、LLM を呼ばずにビルドを通る（acceptance 1）', async () => {
    const { observed, pipeline } = pipelineOf(
      UNUSED_IMPORT_SOURCE,
      compilerThatRejects('errors', UNUSED_IMPORT_DIAGNOSTICS),
    );

    const result = await startGeneration(env, 'mech-user-fixed', { prompt: 'ゲーム' }, pipeline);

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    // **生成は 1 回だけ。** ここが 2 以上なら、費用ゼロの段が費用の出る段を呼んでいる。
    expect(observed.calls.filter((call) => call === 'generateSource').length).toBe(1);
    // ビルドは 2 回（元のソースと、機械修正の後）。
    expect(observed.builtSources).toEqual([UNUSED_IMPORT_SOURCE, REPAIRED_SOURCE]);
    expect(observed.calls).toContain('completeGame');
  });

  it('その経路で台帳に行が増えない（acceptance 2）', async () => {
    // **台帳は実物を使う**（`src/cost-ledger.ts`）。写しを使うと、記録の単位を
    // 検証したことにならない。
    const userId = await seedUser('ledger');
    const { pipeline } = pipelineOf(
      UNUSED_IMPORT_SOURCE,
      compilerThatRejects('errors', UNUSED_IMPORT_DIAGNOSTICS),
    );

    await startGeneration(
      env,
      userId,
      { prompt: 'ゲーム' },
      { ...pipeline, recordCost: recordGenerationCost },
    );

    // 費用ゼロの段は行を作らない（確定25）。**行数がそのまま日次クォータの消費である。**
    const rows = await ledgerRows(userId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.succeeded).toBe(1);
  });

  it('機械修正のたびに計上すると acceptance 2 が破れる（この検査が効いていることの確認）', async () => {
    // **変異検査。** 「ビルドを呼ぶたびに台帳へ書く」実装（費用ゼロの段まで数える）を
    // 作り、上の検査が本当に 1 行を要求していることを確かめる。
    const userId = await seedUser('ledger-mutated');
    const { pipeline } = pipelineOf(
      UNUSED_IMPORT_SOURCE,
      compilerThatRejects('errors', UNUSED_IMPORT_DIAGNOSTICS),
    );

    await startGeneration(
      env,
      userId,
      { prompt: 'ゲーム' },
      {
        ...pipeline,
        recordCost: recordGenerationCost,
        build: async (buildEnv, generated) => {
          await recordGenerationCost(buildEnv, userId, { prompt: 'ゲーム' }, generated);
          return await pipeline.build(buildEnv, generated);
        },
      },
    );

    expect((await ledgerRows(userId)).length).toBe(3);
  });

  it('除去で直らないソースは 2 段目（LLM 再生成）へ回る（acceptance 3）', async () => {
    const { observed, pipeline } = pipelineOf(UNUSED_IMPORT_SOURCE, () => {
      throw new BuildRejected('build', SEMANTIC_DIAGNOSTICS);
    });

    await expect(
      startGeneration(env, 'mech-user-semantic', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    expect(observed.calls.filter((call) => call === 'generateSource').length).toBe(
      MAX_GENERATION_ATTEMPTS,
    );
    // **機械修正は 1 回もビルドを増やさない。** 未使用 import が診断に無いので、
    // 修正を試みる前に戻る（費用ゼロでも呼び出しは増やさない）。
    expect(observed.calls.filter((call) => call === 'build').length).toBe(MAX_GENERATION_ATTEMPTS);
  });

  it('機械修正が効かないと LLM 再生成へ回る（この検査が効いていることの確認）', async () => {
    // **変異検査。** acceptance 1 と同じソース・同じビルド段のまま、**診断の文言だけ**を
    // 機械修正が読めない形へ変える。1 段目が外れると 3 回生成して打ち切られる、
    // すなわち acceptance 1 は機械修正が効いていることに依存している。
    const { observed, pipeline } = pipelineOf(
      UNUSED_IMPORT_SOURCE,
      compilerThatRejects('errors', '# gameforge/game\n./main.go:4:2: unused import "errors"'),
    );

    await expect(
      startGeneration(env, 'mech-user-mutated', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBeInstanceOf(BuildRetriesExhausted);

    expect(observed.calls.filter((call) => call === 'generateSource').length).toBe(
      MAX_GENERATION_ATTEMPTS,
    );
  });

  it('2 段目へ渡すのは機械修正の後のソースと、その診断である', async () => {
    // 未使用 import は消えたが、別の理由でも落ちるソース。**消した後の姿を渡す。**
    // 消す前を渡すと、モデルは既に直っている失敗を直そうとする。
    const { observed, pipeline } = pipelineOf(UNUSED_IMPORT_SOURCE, (generated) => {
      const scanned = scanImports(generated.source);
      if (!scanned.ok || scanned.imports.includes('errors')) {
        throw new BuildRejected('build', UNUSED_IMPORT_DIAGNOSTICS);
      }
      throw new BuildRejected('build', SEMANTIC_DIAGNOSTICS);
    });

    await startGeneration(env, 'mech-user-handoff', { prompt: 'ゲーム' }, pipeline).catch(
      () => undefined,
    );

    expect(observed.retries[0]).toBeUndefined();
    expect(observed.retries[1]?.previousSource).toBe(REPAIRED_SOURCE);
    expect(observed.retries[1]?.diagnostics).toBe(SEMANTIC_DIAGNOSTICS);
    expect(observed.retries[1]?.failedAttempt).toBe(1);
  });

  it('機械修正の後のビルドがリトライ対象でない失敗なら、そのまま上げる', async () => {
    // 環境の不備（`kind='config'`）は回しても直らない。1 段目の中で握りつぶすと、
    // 設定不備が「コンパイル失敗」として 3 回課金される経路になる。
    const failure = new BuildNotConfigured(['BUILD_AWS_ACCESS_KEY_ID']);
    const { observed, pipeline } = pipelineOf(UNUSED_IMPORT_SOURCE, (generated) => {
      const scanned = scanImports(generated.source);
      if (!scanned.ok || scanned.imports.includes('errors')) {
        throw new BuildRejected('build', UNUSED_IMPORT_DIAGNOSTICS);
      }
      throw failure;
    });

    await expect(
      startGeneration(env, 'mech-user-config', { prompt: 'ゲーム' }, pipeline),
    ).rejects.toBe(failure);
    expect(observed.calls.filter((call) => call === 'generateSource').length).toBe(1);
  });

  it('機械修正の後も 5.2-5 の検査を通す', async () => {
    // 3.3 の「検査を通ったソースだけをビルドへ渡す」を分岐で崩さない。
    const { observed, pipeline } = pipelineOf(
      UNUSED_IMPORT_SOURCE,
      compilerThatRejects('errors', UNUSED_IMPORT_DIAGNOSTICS),
    );

    await startGeneration(env, 'mech-user-inspect', { prompt: 'ゲーム' }, pipeline);

    expect(observed.calls.filter((call) => call === 'inspectSource').length).toBe(2);
  });

  it('診断が 10 件で打ち切られても、2 巡目で消し切る', async () => {
    // 実測: 12 個の未使用 import を持つソースで、Go は 10 件を報告して
    // `too many errors` で打ち切った。1 巡では消し切れない。
    //
    // 許可一覧（10 件）に、同じパスの別名 import を 2 つ足して 12 件にする。
    // **別名を足せば許可一覧の件数を超えられる**ので、上限は一覧の件数では決まらない。
    const specs = [
      ...GO_IMPORT_ALLOWLIST.map((entry) => `\t"${entry.path}"`),
      '\ta1 "math"',
      '\ta2 "strconv"',
    ];
    expect(specs.length).toBeGreaterThan(GO_DIAGNOSTIC_ERROR_LIMIT);
    const source = `package main\n\nimport (\n${specs.join('\n')}\n)\n\nfunc main() {}\n`;

    const { observed, pipeline } = pipelineOf(source, (generated) => {
      const diagnostics = emulateGoDiagnostics(generated.source, []);
      if (parseUnusedImports(diagnostics).length > 0) {
        throw new BuildRejected('build', diagnostics);
      }
      return fakeBuildOutcome();
    });

    const result = await startGeneration(
      env,
      'mech-user-many',
      { prompt: 'ゲーム' },
      pipeline,
    );

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(observed.calls.filter((call) => call === 'generateSource').length).toBe(1);
    expect(observed.builtSources.length).toBe(1 + MAX_MECHANICAL_FIX_PASSES);
    expect(scanImports(observed.builtSources.at(-1)!)).toEqual({ ok: true, imports: [] });
  });
});

describe('繰り返し回数の根拠（shared-ai-rules 12 章の機械照合）', () => {
  it('許可一覧をすべて消し切れる回数になっている', () => {
    // ビルドへ届く import のパスは 5.2-5 を通ったものだけなので、**異なるパスの数**は
    // 許可一覧の件数で頭打ちになる。一覧が `10 × 2` を超えたら、この検査が落ちて
    // 定数の見直しを要求する（別名を足せば件数は超えられるが、そのときは残りが
    // 2 段目へ回るだけである）。
    expect(MAX_MECHANICAL_FIX_PASSES * GO_DIAGNOSTIC_ERROR_LIMIT).toBeGreaterThanOrEqual(
      GO_IMPORT_ALLOWLIST.length,
    );
  });

  it('許可一覧が 20 件を超えると照合が破れる（この検査が効いていることの確認）', () => {
    // 変異検査。一覧側を膨らませると同じ不等式が成り立たなくなる、すなわち上の検査は
    // 「一覧が増えても黙って通る」形になっていない。
    const doctored = [
      ...GO_IMPORT_ALLOWLIST,
      ...Array.from({ length: 21 }, (_value, index) => ({
        path: `example.com/pkg${index}`,
        reason: '変異検査のための架空の項目',
      })),
    ];
    expect(doctored.length).toBeGreaterThan(GO_IMPORT_ALLOWLIST.length);
    expect(MAX_MECHANICAL_FIX_PASSES * GO_DIAGNOSTIC_ERROR_LIMIT).toBeLessThan(doctored.length);
  });
});

/**
 * ログの検査で使うプロンプト。
 *
 * **偶然どこにも現れない語を入れる。** 「プロンプトがログに出ていない」を確かめるには、
 * 出ていれば必ず見つかる印が要る。
 */
const LOGGED_PROMPT = 'ユニークな呪文-9137 が出るゲーム';

/**
 * ログ 1 行の**許された形**（4.2 の #133 注記 / 8.3）。
 *
 * **許可した形だけを通す**（禁じた語を探すのではない）。禁止語を並べる形にすると、
 * 思いついた語しか塞げず、**新しい漏れ方が黙って通る。** 分類名と 3 つの件数以外が
 * 1 文字でも混じれば、この形には合致しない。
 */
const MECHANICAL_FIX_LOG_PATTERN =
  /^\[mechanical-fix\] (?<outcome>[a-z-]+) \{"diagnosed":(?<diagnosed>\d+),"located":(?<located>\d+),"removed":(?<removed>\d+)\}$/u;

/**
 * **ログに現れてはいけない断片**（#133 の acceptance）。
 *
 * 生成コード・Go の診断・import のパス・プロンプトを代表する文字列である。いずれも
 * 8.3 の検査を通っていない、**生成物由来の文字列**にあたる。
 */
const FORBIDDEN_IN_LOG: readonly string[] = [
  // import のパス（許可一覧の中身でも生成物由来である）
  'errors',
  'github.com/hajimehoshi/ebiten/v2',
  // Go の診断（生成コードの行と識別子を引用する）
  'imported and not used',
  'main.go',
  'vector.DrawFilledRoundRect',
  // 生成コード
  'package main',
  'func main',
  // プロンプト
  LOGGED_PROMPT,
];

/**
 * 1 行が、#133 で定めた形かどうか。
 *
 * @param line ログ 1 行
 * @returns 許された形なら true
 */
function isAllowedLogLine(line: string): boolean {
  const matched = MECHANICAL_FIX_LOG_PATTERN.exec(line);
  const outcome = matched?.groups?.['outcome'];
  return outcome !== undefined && (MECHANICAL_FIX_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * 捕まえたログに現れてしまった、生成物由来の断片を返す。
 *
 * @param lines 捕まえたログ
 * @returns 現れた断片（無ければ空）
 */
function leakedFragments(lines: readonly string[]): string[] {
  const joined = lines.join('\n');
  return FORBIDDEN_IN_LOG.filter((fragment) => joined.includes(fragment));
}

/**
 * 実行中の `console` への出力をすべて捕まえる。
 *
 * **5 つのメソッドを全部差し替える。** 1 つでも素通しにすると、そこへ出したものが
 * 検査の外に落ちる。文字列以外の引数も JSON にして記録するので、オブジェクトに
 * 包んで渡した文字列も捕まる。
 *
 * @param run 実行するもの
 * @returns 戻り値と、捕まえた行
 */
async function captureLogs<T>(run: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const record = (...values: unknown[]): void => {
    lines.push(
      values
        .map((value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))))
        .join(' '),
    );
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;
  try {
    const value = await run();
    return { value, lines };
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  }
}

describe('機械修正の観測（4.2 の #133 注記）', () => {
  it('除去したら、件数が 1 行だけログへ出る', async () => {
    const { lines } = await captureLogs(() =>
      removeUnusedImports(UNUSED_IMPORT_SOURCE, UNUSED_IMPORT_DIAGNOSTICS),
    );

    // **1 巡につき 1 行。** 行数がそのまま巡回数になるので、ここで増やさない。
    expect(lines).toEqual(['[mechanical-fix] removed {"diagnosed":1,"located":1,"removed":1}']);
  });

  it('空振りでも 1 行出る（この段が走ったことは分かる）', async () => {
    // 未使用 import が原因でない失敗。**通常の失敗はここへ来る**ので、
    // 「走ったが消すものが無かった」ことが読めないと空振りの比率が出せない。
    const { lines } = await captureLogs(() =>
      removeUnusedImports(UNUSED_IMPORT_SOURCE, SEMANTIC_DIAGNOSTICS),
    );

    expect(lines).toEqual([
      '[mechanical-fix] no-unused-imports {"diagnosed":0,"located":0,"removed":0}',
    ]);
  });

  it('位置が合わなければ、件数の食い違いとして読める', async () => {
    // 診断は読めたのに消せなかった。`diagnosed` と `located` の差がそのまま手掛かりになる。
    const diagnostics = '# gameforge/game\n./main.go:9:9: "errors" imported and not used';
    const { value, lines } = await captureLogs(() =>
      removeUnusedImports(UNUSED_IMPORT_SOURCE, diagnostics),
    );

    expect(value).toEqual({ changed: false, reason: 'not-located' });
    expect(lines).toEqual(['[mechanical-fix] not-located {"diagnosed":1,"located":0,"removed":0}']);
  });

  it('除去件数と巡回数がログから読める（acceptance 1）', async () => {
    // **生成経路をそのまま回す。** 巡回のループを持つのは `src/generate.ts` なので、
    // 「1 巡につき 1 行」が実際に成り立つかは経路を通さないと確かめられない。
    //
    // 未使用 12 件（診断は 10 件で打ち切られる）。1 巡目で 10 件、2 巡目で 2 件消える。
    const specs = [
      ...GO_IMPORT_ALLOWLIST.map((entry) => `\t"${entry.path}"`),
      '\ta1 "math"',
      '\ta2 "strconv"',
    ];
    const source = `package main\n\nimport (\n${specs.join('\n')}\n)\n\nfunc main() {}\n`;
    const { pipeline } = pipelineOf(source, (generated) => {
      const diagnostics = emulateGoDiagnostics(generated.source, []);
      if (parseUnusedImports(diagnostics).length > 0) {
        throw new BuildRejected('build', diagnostics);
      }
      return fakeBuildOutcome();
    });

    const { lines } = await captureLogs(() =>
      startGeneration(env, 'mech-user-observed', { prompt: LOGGED_PROMPT }, pipeline),
    );

    // **行数が巡回数である。** 2 行なら 2 巡した、と読める。
    expect(lines.length).toBe(MAX_MECHANICAL_FIX_PASSES);
    expect(lines).toEqual([
      `[mechanical-fix] removed {"diagnosed":${GO_DIAGNOSTIC_ERROR_LIMIT},"located":${GO_DIAGNOSTIC_ERROR_LIMIT},"removed":${GO_DIAGNOSTIC_ERROR_LIMIT}}`,
      '[mechanical-fix] removed {"diagnosed":2,"located":2,"removed":2}',
    ]);
    // 除去件数の合計は、ソースにあった未使用 import の数と一致する。
    const removed = lines.map((line) => Number(MECHANICAL_FIX_LOG_PATTERN.exec(line)?.groups?.['removed']));
    expect(removed.reduce((sum, count) => sum + count, 0)).toBe(specs.length);
  });

  it('生成コード・診断・import パス・プロンプトがログに現れない（acceptance 2）', async () => {
    // **経路を通して、出た**ものだけを見る。実際に除去が起きる形（＝出すものが最も
    // 多い巡）で回す。
    const { lines } = await captureLogs(() =>
      startGeneration(
        env,
        'mech-user-log-safe',
        { prompt: LOGGED_PROMPT },
        pipelineOf(UNUSED_IMPORT_SOURCE, compilerThatRejects('errors', UNUSED_IMPORT_DIAGNOSTICS))
          .pipeline,
      ),
    );

    expect(lines.length).toBeGreaterThan(0);
    // 1. 許した形にしか合致しない（分類名と 3 つの件数以外は 1 文字も出ない）。
    for (const line of lines) {
      expect(isAllowedLogLine(line)).toBe(true);
    }
    // 2. 禁じた断片が 1 つも無い（1 の裏側から、もう一度見る）。
    expect(leakedFragments(lines)).toEqual([]);
  });

  it('2 段目へ回る失敗でも、診断はログに現れない（acceptance 2）', async () => {
    // 機械修正が効かない失敗（3 試行して尽きる）。**診断が最も出やすい経路**である。
    const { pipeline } = pipelineOf(UNUSED_IMPORT_SOURCE, () => {
      throw new BuildRejected('build', SEMANTIC_DIAGNOSTICS);
    });

    const { lines } = await captureLogs(async () => {
      await expect(
        startGeneration(env, 'mech-user-log-exhausted', { prompt: LOGGED_PROMPT }, pipeline),
      ).rejects.toBeInstanceOf(BuildRetriesExhausted);
    });

    expect(lines.length).toBe(MAX_GENERATION_ATTEMPTS);
    for (const line of lines) {
      expect(isAllowedLogLine(line)).toBe(true);
    }
    expect(leakedFragments(lines)).toEqual([]);
  });

  it('import のパスを足したログは通らない（この検査が効いていることの確認）', () => {
    // **変異検査。** 「件数で足りる」を破って**何を消したか**を出した行を作り、
    // 上の 2 つの検査が実際に落とすことを見る。
    const doctored =
      '[mechanical-fix] removed {"diagnosed":1,"located":1,"removed":1,"paths":["errors"]}';

    expect(isAllowedLogLine(doctored)).toBe(false);
    expect(leakedFragments([doctored])).toContain('errors');
  });

  it('診断やプロンプトを足したログは通らない（この検査が効いていることの確認）', () => {
    const withDiagnostics = `[mechanical-fix] removed ${UNUSED_IMPORT_DIAGNOSTICS}`;
    const withPrompt = `[mechanical-fix] removed {"diagnosed":1} ${LOGGED_PROMPT}`;
    const withSource = `[mechanical-fix] removed ${UNUSED_IMPORT_SOURCE}`;

    for (const doctored of [withDiagnostics, withPrompt, withSource]) {
      expect(isAllowedLogLine(doctored)).toBe(false);
      expect(leakedFragments([doctored])).not.toEqual([]);
    }
  });

  it('実際に出ている行は、その検査を通る（変異検査の対照）', async () => {
    // **上の 3 つが「何を渡しても false」では、変異検査が空になる。** 本物の行が
    // 通ることを固定して、検査が形を見分けていることを示す。
    const { lines } = await captureLogs(() =>
      removeUnusedImports(UNUSED_IMPORT_SOURCE, UNUSED_IMPORT_DIAGNOSTICS),
    );

    expect(lines.every((line) => isAllowedLogLine(line))).toBe(true);
    expect(leakedFragments(lines)).toEqual([]);
  });

  it('分類名でない語は通らない（形だけでは足りない）', () => {
    // 形は合っているが、実装が持たない語。**固定の語彙であることまで見る。**
    expect(isAllowedLogLine('[mechanical-fix] removed {"diagnosed":1,"located":1,"removed":1}')).toBe(
      true,
    );
    expect(
      isAllowedLogLine('[mechanical-fix] errors-import {"diagnosed":1,"located":1,"removed":1}'),
    ).toBe(false);
  });
});

describe('分類名の機械照合（shared-ai-rules 12 章）', () => {
  /** 仕様書 4.2 の分類名の表が始まる目印。 */
  const OUTCOME_TABLE_ANCHOR = '**分類名は次の 5 つで、これがすべてである。**';

  /**
   * 仕様書 4.2 の表から分類名を拾う。
   *
   * 目印の直後にある最初の表だけを見る。**件数の表（`diagnosed` など）は目印より
   * 前にある**ので混ざらない。
   *
   * @param spec 仕様書の本文
   * @returns 表に並んでいる分類名（記載順）
   */
  function outcomeNamesIn(spec: string): string[] {
    const at = spec.indexOf(OUTCOME_TABLE_ANCHOR);
    if (at === -1) {
      return [];
    }
    const names: string[] = [];
    let started = false;
    for (const line of spec.slice(at).split('\n')) {
      if (!line.startsWith('|')) {
        if (started) {
          break;
        }
        continue;
      }
      started = true;
      const matched = /^\| `([a-z-]+)` \|/u.exec(line);
      if (matched !== null) {
        names.push(matched[1]!);
      }
    }
    return names;
  }

  it('仕様書の表と実装の語彙が一致する', () => {
    // 文書が実装の一覧を書き写している箇所は機械照合する（shared-ai-rules 12 章）。
    // **ログに出る語は運用者が読む語**なので、ずれると読み手だけが古い表を見続ける。
    expect(outcomeNamesIn(env.TEST_PRODUCT_SPEC)).toEqual([...MECHANICAL_FIX_OUTCOMES]);
  });

  it('仕様書が書いている件数も実装と一致する', () => {
    const declared = /\*\*分類名は次の (\d+) つで/u.exec(env.TEST_PRODUCT_SPEC);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(MECHANICAL_FIX_OUTCOMES.length);
  });

  it('仕様書側を変異させると照合が破れる（この検査が効いていることの確認）', () => {
    const doctored = env.TEST_PRODUCT_SPEC.replace('| `not-located` |', '| `not-locatedd` |');
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(outcomeNamesIn(doctored)).toContain('not-locatedd');
    expect(outcomeNamesIn(doctored)).not.toEqual([...MECHANICAL_FIX_OUTCOMES]);
  });

  it('仕様書から表ごと消しても照合が破れる（空振りで通らない）', () => {
    // **目印が見つからなければ空を返す**実装なので、「何も拾えないのに一致」に
    // ならないことを確かめる。
    const doctored = env.TEST_PRODUCT_SPEC.replace(OUTCOME_TABLE_ANCHOR, '');
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(outcomeNamesIn(doctored)).toEqual([]);
    expect(outcomeNamesIn(doctored)).not.toEqual([...MECHANICAL_FIX_OUTCOMES]);
  });
});
