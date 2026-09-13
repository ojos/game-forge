import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_DIAGNOSTIC_CATEGORIES,
  logBuildDiagnostics,
  summarizeBuildDiagnostics,
} from '../src/build-diagnostics.js';
import type { BuildDiagnosticCategory, BuildDiagnosticsSummary } from '../src/build-diagnostics.js';
import { BuildRejected } from '../src/build-client.js';
import { BuildRetriesExhausted, MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { runJobInline, startGeneration } from '../src/generate.js';
import type { GenerationPipeline } from '../src/generate.js';
import type { GenerationResult } from '../src/generation-models.js';
import { DEFAULT_GENERATION_MODEL_KEY, findGenerationModel } from '../src/generation-models.js';
import { MECHANICAL_FIX_OUTCOMES } from '../src/mechanical-fix.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { isAllowedBuildDiagnosticsLine, readBuildDiagnosticsLines } from './helpers/build-diagnostics-log.js';
import { captureLogs } from './helpers/capture-logs.js';
import { applySchema } from './helpers/schema.js';

/**
 * **実物の診断である**（2026-09-13。ビルド関数のイメージ `game-forge/isolated-build` を手元で
 * 組んだものと同じ Go 1.27.0・`GOOS=js GOARCH=wasm`・`-mod=vendor`・ネットワーク無しで、
 * 誤りを並べたソースを `go build -ldflags="-s -w"` に通した出力）。関数は標準出力と標準エラーを
 * 結合して返すので、見出しの行と、タブで始まる続きの行も込みで写してある。
 *
 * **手で書き写していない。** 出力のファイルから文字列定数へ機械的に変換した。
 */
const REAL_DIAGNOSTICS = {
  /** 型の誤りを 10 件以上並べたもの（10 件で打ち切られる）。 */
  mixed: `# gameforge.local/sandbox
./main.go:5:2: "os" imported and not used
./main.go:6:2: "strings" imported as str and not used
./main.go:17:8: cannot use n (variable of type int) as float64 value in assignment
./main.go:18:2: declared and not used: unused
./main.go:19:4: g.Speed undefined (type *Game has no field or method Speed)
./main.go:20:13: too many arguments in call to doThing
\thave (number, number)
\twant (int)
./main.go:21:10: assignment mismatch: 2 variables but single returns 1 value
./main.go:23:9: undefined: undefinedFunc
./main.go:33:6: invalid operation: f + i (mismatched types float64 and int)
./main.go:37:17: cannot use &Game{} (value of type *Game) as ebiten.Game value in argument to ebiten.RunGame: *Game does not implement ebiten.Game (missing method Layout)
./main.go:6:2: too many errors`,
  /** 宣言の誤り。 */
  declarations: `# gameforge.local/sandbox
./main.go:14:1: missing return
./main.go:18:4: no new variables on left side of :=
./main.go:20:14: cannot use "s" (untyped string constant) as int value in variable declaration
./main.go:23:14: cannot use h (variable of type float64) as int value in variable declaration
./main.go:25:16: cannot use 1.5 (untyped float constant) as int value in constant declaration (truncated)
./main.go:28:6: g redeclared in this block
\t./main.go:16:6: other declaration of g
./main.go:31:17: cannot use &Game{} (value of type *Game) as ebiten.Game value in argument to ebiten.RunGame: *Game does not implement ebiten.Game (missing method Layout)`,
  /** 構文の誤り（型検査の前で止まるので 1 件だけ出る）。 */
  syntax: `# gameforge.local/sandbox
./main.go:7:28: syntax error: unexpected newline in argument list; possibly missing comma or )`,
  /** 未使用の変数を 12 個（10 件で打ち切られる）。 */
  truncated: `# gameforge.local/sandbox
./main.go:4:2: declared and not used: a1
./main.go:5:2: declared and not used: a2
./main.go:6:2: declared and not used: a3
./main.go:7:2: declared and not used: a4
./main.go:8:2: declared and not used: a5
./main.go:9:2: declared and not used: a6
./main.go:10:2: declared and not used: a7
./main.go:11:2: declared and not used: a8
./main.go:12:2: declared and not used: a9
./main.go:13:2: declared and not used: a10
./main.go:13:2: too many errors`,
  /** Ebitengine の API の取り違え。 */
  api: `# gameforge.local/sandbox
./main.go:14:5: non-boolean condition in if statement
./main.go:16:2: g.x (variable of type int) is not used
./main.go:21:41: not enough arguments in call to vector.DrawFilledRect
\thave (*ebiten.Image, number, number, number, number)
\twant (*ebiten.Image, float32, float32, float32, float32, color.Color, bool)
./main.go:23:32: cannot use w (variable of type int) as float32 value in argument to vector.DrawFilledRect
./main.go:24:15: cannot use float32(1) (constant 1 of type float32) as float64 value in argument to math.Min
./main.go:25:9: screen.DrawRect undefined (type *ebiten.Image has no field or method DrawRect)
./main.go:26:13: undefined: ebiten.KeyFoo
./main.go:27:13: undefined: ebiten.NewImageFromFile`,
  /** メソッドの重複と、どこにも当たらない誤り。 */
  misc: `# gameforge.local/sandbox
./main.go:10:16: method Game.Update already declared at ./main.go:7:16
./main.go:14:4: s.Push undefined (type []int has no field or method Push)
./main.go:15:7: invalid operation: "a" * 2 (mismatched types untyped string and untyped int)
./main.go:20:2: continue is not in a loop
./main.go:22:2: cannot assign to struct field m["a"].v in map`,
  /** vendor に無いパッケージ（見出しが無く、`./` も付かない）。 */
  vendor: `main.go:3:8: cannot find module providing package github.com/hajimehoshi/ebiten/v2/ebitenutil: import lookup disabled by -mod=vendor`,
} as const;

/**
 * 分類ごとの件数を、0 件を省いた形で書く。
 *
 * @param nonZero 0 でない分類とその件数
 * @returns すべての分類を持つ件数
 */
function countsOf(
  nonZero: Partial<Record<BuildDiagnosticCategory, number>>,
): Record<BuildDiagnosticCategory, number> {
  return Object.fromEntries(
    BUILD_DIAGNOSTIC_CATEGORIES.map((category) => [category, nonZero[category] ?? 0]),
  ) as Record<BuildDiagnosticCategory, number>;
}

/**
 * 診断の中の「誤り 1 件」の行を、分類とは独立に数える。
 *
 * **実装の数え方を写さない。** 見出しでも続きの行でも打ち切りの印でもない、位置を持つ行を
 * 素朴に数えるだけにして、実装の合計と突き合わせる。
 *
 * @param diagnostics 診断
 * @returns 行の数
 */
function positionedLineCount(diagnostics: string): number {
  return diagnostics
    .split('\n')
    .filter((line) => /^\S+:\d+:\d+: /u.test(line) && !line.endsWith(': too many errors')).length;
}

describe('実物の診断を分類する（Go 1.27.0）', () => {
  it('型の誤りを並べた診断を、分類ごとに数える', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.mixed))).toEqual({
      stage: 'build',
      counts: countsOf({
        'unused-import': 2,
        'type-mismatch': 2,
        'unused-variable': 1,
        'missing-field-or-method': 1,
        'argument-count': 1,
        'assignment-count': 1,
        'undefined-name': 1,
        // `cannot use ... does not implement` は type-mismatch ではなくこちら（並びの順）。
        'not-implemented': 1,
      }),
      total: 10,
      truncated: true,
      unpositioned: 0,
    });
  });

  it('宣言の誤りを数える', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.declarations))).toEqual({
      stage: 'build',
      counts: countsOf({
        'missing-return': 1,
        redeclared: 2,
        'type-mismatch': 3,
        'not-implemented': 1,
      }),
      // `other declaration of g` の続きの行は数えない。
      total: 7,
      truncated: false,
      unpositioned: 0,
    });
  });

  it('構文の誤りを数える', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.syntax)).counts).toEqual(
      countsOf({ syntax: 1 }),
    );
  });

  it('打ち切りの印は件数に入れず、打ち切られたことだけを写す', () => {
    const summary = summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.truncated));
    expect(summary.counts).toEqual(countsOf({ 'unused-variable': 10 }));
    expect(summary.total).toBe(10);
    expect(summary.truncated).toBe(true);
  });

  it('API の取り違えを、修飾された名前とそうでない名前に分ける', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.api))).toEqual({
      stage: 'build',
      counts: countsOf({
        other: 2,
        'argument-count': 1,
        'type-mismatch': 2,
        'missing-field-or-method': 1,
        'undefined-package-member': 2,
      }),
      total: 8,
      truncated: false,
      unpositioned: 0,
    });
  });

  it('どこにも当たらない誤りは other に入る', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.misc)).counts).toEqual(
      countsOf({
        redeclared: 1,
        'missing-field-or-method': 1,
        'type-mismatch': 1,
        other: 2,
      }),
    );
  });

  it('見出しと `./` が無くても 1 件と数える', () => {
    const summary = summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.vendor));
    expect(summary.counts).toEqual(countsOf({ other: 1 }));
    expect(summary.unpositioned).toBe(0);
  });

  it('どの実物の診断でも、件数の合計が誤りの行の数と一致する', () => {
    for (const [name, diagnostics] of Object.entries(REAL_DIAGNOSTICS)) {
      const summary = summarizeBuildDiagnostics(new BuildRejected('build', diagnostics));
      const sum = Object.values(summary.counts).reduce((total, count) => total + count, 0);
      expect({ name, sum, total: summary.total }).toEqual({
        name,
        sum: positionedLineCount(diagnostics),
        total: positionedLineCount(diagnostics),
      });
    }
  });

  it('どの分類にも、それに当たる実物の 1 行がある', () => {
    // **実測に無い分類を先回りで作らない**（`src/mechanical-fix.ts` の「古い綴りは受けない」と
    // 同じ理由。当たっているかを確かめる手段が無いまま規則だけが残る）。
    const seen = new Set<string>();
    for (const diagnostics of Object.values(REAL_DIAGNOSTICS)) {
      const { counts } = summarizeBuildDiagnostics(new BuildRejected('build', diagnostics));
      for (const [category, count] of Object.entries(counts)) {
        if (count > 0) {
          seen.add(category);
        }
      }
    }
    expect([...seen].sort()).toEqual([...BUILD_DIAGNOSTIC_CATEGORIES].sort());
  });
});

describe('形に合わない入力', () => {
  it('関数が切り詰めた末尾や、位置を持たない行は unpositioned に数える', () => {
    // 末尾の文言は `docker/isolated-build/handler/build.go` の `trimDiagnostics` が足すもの。
    // **文言そのものには依存しない**（形に合わない行として数えるだけ）。
    const diagnostics = `${REAL_DIAGNOSTICS.syntax}\n./main.go:9:\n… (診断を切り詰めました)`;
    const summary = summarizeBuildDiagnostics(new BuildRejected('build', diagnostics));
    expect(summary.total).toBe(1);
    expect(summary.unpositioned).toBe(2);
  });

  it('空の診断は 0 件である', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('build', ''))).toEqual({
      stage: 'build',
      counts: countsOf({}),
      total: 0,
      truncated: false,
      unpositioned: 0,
    });
  });

  it('知らない段の名前は unknown へ落とす（関数から来た文字列をそのまま出さない）', () => {
    expect(summarizeBuildDiagnostics(new BuildRejected('request', '')).stage).toBe('request');
    expect(summarizeBuildDiagnostics(new BuildRejected('compress', '')).stage).toBe('compress');
    expect(summarizeBuildDiagnostics(new BuildRejected('main.go', '')).stage).toBe('unknown');
  });
});

/**
 * ログの検査で使うプロンプト。**出ていれば必ず見つかる印**を入れる。
 */
const LOGGED_PROMPT = 'ユニークな呪文-4431 が出るシューティング';

/** 生成の段が返すソース（**ログに現れてはいけない識別子**を含む）。 */
const LOGGED_SOURCE = `package main

import "github.com/hajimehoshi/ebiten/v2"

func uniqueJellyfishCapsule() {}

func main() {
\t_ = ebiten.RunGame
}
`;

/**
 * **ログに現れてはいけない断片**（#443 の acceptance）。いずれも 8.3 の検査を通っていない、
 * 生成物由来の文字列である。
 */
const FORBIDDEN_IN_LOG: readonly string[] = [
  // Go の診断（識別子・型・ファイル名）
  'main.go',
  'undefinedFunc',
  'Speed',
  'ebiten.Game',
  'float64',
  'imported and not used',
  'too many errors',
  // import のパス
  'github.com/hajimehoshi/ebiten/v2',
  '"os"',
  // 生成コード
  'package main',
  'uniqueJellyfishCapsule',
  // プロンプト
  LOGGED_PROMPT,
];

/**
 * 捕まえたログに現れてしまった断片を返す。
 *
 * @param lines 捕まえたログ
 * @returns 現れた断片（無ければ空）
 */
function leakedFragments(lines: readonly string[]): string[] {
  const joined = lines.join('\n');
  return FORBIDDEN_IN_LOG.filter((fragment) => joined.includes(fragment));
}

/**
 * 生成経路に出てよい行か（機械修正の行か、ビルド診断の行）。
 *
 * **機械修正の行は分類名だけを確かめる。** 形の厳密な検査は `test/mechanical-fix.test.ts` が持つ。
 *
 * @param line ログ 1 行
 * @returns 許された形なら true
 */
function isAllowedGenerationLogLine(line: string): boolean {
  const mechanical =
    /^\[mechanical-fix\] (?<outcome>[a-z-]+) \{"diagnosed":\d+,"located":\d+,"removed":\d+\}$/u.exec(line);
  const outcome = mechanical?.groups?.['outcome'];
  if (outcome !== undefined) {
    return (MECHANICAL_FIX_OUTCOMES as readonly string[]).includes(outcome);
  }
  return isAllowedBuildDiagnosticsLine(line);
}

/**
 * 生成結果の雛形。
 *
 * @returns 生成結果
 */
function generation(): GenerationResult {
  return {
    modelKey: DEFAULT_GENERATION_MODEL_KEY,
    modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
    source: LOGGED_SOURCE,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: null, cacheWriteInputTokens: null },
    stopReason: 'end_turn',
  };
}

/**
 * ビルド段だけを差し替えたパイプライン。**実物の Bedrock も Lambda も呼ばない。**
 *
 * @param build ビルド段（呼ばれた回数を受け取る。1 始まり）
 * @returns パイプライン
 */
function pipelineWith(build: (call: number) => ReturnType<typeof fakeBuildOutcome>): GenerationPipeline {
  let calls = 0;
  return {
    checkQuota: async () => ({ allowed: true }),
    generateSource: async () => generation(),
    recordCost: async () => {},
    inspectSource: () => {},
    build: async () => {
      calls += 1;
      return build(calls);
    },
    completeGame: async () => true,
    startJob: runJobInline,
  };
}

beforeAll(async () => {
  await applySchema();
  for (const id of ['diag-user-exhausted', 'diag-user-recovered', 'diag-user-repaired']) {
    await env.DB.prepare(
      `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
       values (?, ?, ?, ?, 1, null)`,
    )
      .bind(id, `sub-${id}`, `${id}@example.com`, id)
      .run();
  }
});

afterAll(async () => {
  await env.DB.prepare("delete from generations where user_id like 'diag-user-%'").run();
});

describe('生成経路のログ（#443 の acceptance）', () => {
  it('ビルドで落ちた試行ごとに 1 行、試行番号つきで出る', async () => {
    const pipeline = pipelineWith(() => {
      throw new BuildRejected('build', REAL_DIAGNOSTICS.mixed);
    });

    const { lines } = await captureLogs(async () => {
      await expect(
        startGeneration(env, 'diag-user-exhausted', { prompt: LOGGED_PROMPT }, pipeline),
      ).rejects.toBeInstanceOf(BuildRetriesExhausted);
    });

    const logged = readBuildDiagnosticsLines(lines);
    expect(logged.map((line) => line.attempt)).toEqual(
      Array.from({ length: MAX_GENERATION_ATTEMPTS }, (_, index) => index + 1),
    );
    for (const line of logged) {
      expect(line).toEqual({
        attempt: line.attempt,
        stage: 'build',
        total: 10,
        truncated: true,
        unpositioned: 0,
        counts: summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.mixed)).counts,
      });
    }
  });

  it('2 回目で通った生成では、落ちた 1 回目の分だけが出る', async () => {
    const pipeline = pipelineWith((call) => {
      if (call === 1) {
        throw new BuildRejected('build', REAL_DIAGNOSTICS.api);
      }
      return fakeBuildOutcome();
    });

    const { lines } = await captureLogs(() =>
      startGeneration(env, 'diag-user-recovered', { prompt: LOGGED_PROMPT }, pipeline),
    );

    const logged = readBuildDiagnosticsLines(lines);
    expect(logged.map((line) => [line.attempt, line.total])).toEqual([[1, 8]]);
  });

  it('機械修正の後のビルドがまた落ちても、行は LLM の試行 1 回につき 1 行である', async () => {
    // 1 回目: 未使用 import で落ちる → 機械修正が消して再ビルド → 別の誤りで落ちる → 2 回目の生成へ。
    // **数えるのは LLM の出力そのものに対する診断**なので、再ビルドの分は行を増やさない。
    const unused = `# gameforge.local/sandbox\n./main.go:3:8: "github.com/hajimehoshi/ebiten/v2" imported and not used`;
    const pipeline = pipelineWith((call) => {
      if (call === 1) {
        throw new BuildRejected('build', unused);
      }
      if (call === 2) {
        throw new BuildRejected('build', REAL_DIAGNOSTICS.syntax);
      }
      return fakeBuildOutcome();
    });

    const { lines } = await captureLogs(() =>
      startGeneration(env, 'diag-user-repaired', { prompt: LOGGED_PROMPT }, pipeline),
    );

    const logged = readBuildDiagnosticsLines(lines);
    expect(logged.length).toBe(1);
    expect(logged[0]!.counts['unused-import']).toBe(1);
  });

  it('診断・識別子・import のパス・ソース・プロンプトがログに現れない', async () => {
    const pipeline = pipelineWith(() => {
      throw new BuildRejected('build', REAL_DIAGNOSTICS.mixed);
    });

    const { lines } = await captureLogs(async () => {
      await expect(
        startGeneration(env, 'diag-user-exhausted', { prompt: LOGGED_PROMPT }, pipeline),
      ).rejects.toBeInstanceOf(BuildRetriesExhausted);
    });

    expect(readBuildDiagnosticsLines(lines).length).toBe(MAX_GENERATION_ATTEMPTS);
    // 1. 許した形にしか合致しない。
    for (const line of lines) {
      expect(isAllowedGenerationLogLine(line)).toBe(true);
    }
    // 2. 禁じた断片が 1 つも無い（1 の裏側から、もう一度見る）。
    expect(leakedFragments(lines)).toEqual([]);
  });
});

describe('ログの検査が効いていることの確認（変異検査）', () => {
  /** 本物の行（対照）。 */
  async function realLine(): Promise<string> {
    const { lines } = await captureLogs(() =>
      logBuildDiagnostics(1, summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.mixed))),
    );
    expect(lines.length).toBe(1);
    return lines[0]!;
  }

  it('本物の行は検査を通る（対照）', async () => {
    const line = await realLine();
    expect(isAllowedBuildDiagnosticsLine(line)).toBe(true);
    expect(leakedFragments([line])).toEqual([]);
  });

  it('識別子を足した行は通らない', async () => {
    const doctored = (await realLine()).replace('}}', '},"names":["undefinedFunc"]}');
    expect(isAllowedBuildDiagnosticsLine(doctored)).toBe(false);
    expect(leakedFragments([doctored])).toContain('undefinedFunc');
  });

  it('分類名でない語を件数の鍵にした行は通らない', async () => {
    const doctored = (await realLine()).replace('"other":', '"main.go":');
    expect(isAllowedBuildDiagnosticsLine(doctored)).toBe(false);
  });

  it('段に知らない語を入れた行は通らない', async () => {
    const doctored = (await realLine()).replace('"stage":"build"', '"stage":"float64"');
    expect(isAllowedBuildDiagnosticsLine(doctored)).toBe(false);
  });

  it('器に余分な項目を足して渡しても、外へは出ない', async () => {
    // **型を迂回した呼び出し**を作り、入れ直しが効いていることを見る。
    const summary = summarizeBuildDiagnostics(new BuildRejected('build', REAL_DIAGNOSTICS.mixed));
    const smuggled = {
      ...summary,
      diagnostics: REAL_DIAGNOSTICS.mixed,
      stage: 'main.go' as unknown as BuildDiagnosticsSummary['stage'],
      counts: { ...summary.counts, [LOGGED_PROMPT]: 1 },
    } as BuildDiagnosticsSummary;

    const { lines } = await captureLogs(() => logBuildDiagnostics(1, smuggled));

    expect(lines.length).toBe(1);
    expect(isAllowedBuildDiagnosticsLine(lines[0]!)).toBe(true);
    expect(leakedFragments(lines)).toEqual([]);
  });
});

describe('分類名の機械照合（shared-ai-rules 12 章）', () => {
  /** 仕様書 4.2 の #443 の表が始まる目印。 */
  const CATEGORY_TABLE_ANCHOR = `**ビルド診断の分類名は次の ${BUILD_DIAGNOSTIC_CATEGORIES.length} 個で、これがすべてである。**`;

  /**
   * 仕様書の表から分類名を拾う。目印の直後にある最初の表だけを見る。
   *
   * @param spec 仕様書の本文
   * @param anchor 表の目印
   * @returns 表に並んでいる分類名（記載順）
   */
  function categoryNamesIn(spec: string, anchor: string): string[] {
    const at = spec.indexOf(anchor);
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

  it('仕様書の表と実装の語彙が、並びまで一致する', () => {
    // **並びは判定の順である**ので、表も同じ順で読めなければならない。
    expect(categoryNamesIn(env.TEST_PRODUCT_SPEC, CATEGORY_TABLE_ANCHOR)).toEqual([
      ...BUILD_DIAGNOSTIC_CATEGORIES,
    ]);
  });

  it('仕様書側を変異させると照合が破れる（この検査が効いていることの確認）', () => {
    const doctored = env.TEST_PRODUCT_SPEC.replace('| `missing-return` |', '| `missing-returnn` |');
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(categoryNamesIn(doctored, CATEGORY_TABLE_ANCHOR)).not.toEqual([...BUILD_DIAGNOSTIC_CATEGORIES]);
  });

  it('分類を 1 つ足すと、件数の目印ごと見つからなくなる（空振りで通らない）', () => {
    const grown = `**ビルド診断の分類名は次の ${BUILD_DIAGNOSTIC_CATEGORIES.length + 1} 個で、これがすべてである。**`;
    expect(categoryNamesIn(env.TEST_PRODUCT_SPEC, grown)).toEqual([]);
  });
});
