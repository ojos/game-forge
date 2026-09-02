import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerationPipeline } from '../src/generate.js';
import {
  PipelineStepNotImplemented,
  defaultPipeline,
  runJobInline,
  startGeneration,
} from '../src/generate.js';
import type { DeniedTerm } from '../src/denied-terms.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import type { GenerationResult } from '../src/generation-models.js';
import { inspectGoImports } from '../src/go-imports.js';
import {
  GeneratedSourceRejected,
  MAX_REPORTED_OFFENDING,
  MAX_REPORTED_OFFENDING_LENGTH,
  SOURCE_REJECTED_ERROR,
  SOURCE_REJECTED_STATUS,
  createSourceInspector,
  describeSourceRejection,
  inspectGeneratedSource,
} from '../src/source-inspection.js';
import { MAX_SOURCE_BYTES } from '../src/source-size.js';
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

/**
 * ちょうど指定バイト数の、検査を通る Go ソースを作る。
 *
 * **`package main` から始める。** 先頭が違うと `scanImports` が `unparsable` で
 * 落ち、サイズ検査を見るつもりのテストが別の理由で緑になる。
 *
 * @param bytes 作りたいバイト数
 * @returns Go のソース
 */
function sourceOfBytes(bytes: number): string {
  const head = source('');
  const padding = bytes - new TextEncoder().encode(head).length;
  if (padding < 0) {
    throw new Error('雛形より小さいソースは作れません');
  }
  return head + 'x'.repeat(padding);
}

describe('生成後のサイズ検査（5.3 / 6.1 / 確定18 の条件 3 / M5-2 / #33）', () => {
  it('上限ちょうどは通る（境界で切りすぎない）', () => {
    const exact = sourceOfBytes(MAX_SOURCE_BYTES);
    expect(new TextEncoder().encode(exact).length).toBe(MAX_SOURCE_BYTES);
    expect(() => inspectGeneratedSource(generated(exact))).not.toThrow();
  });

  it('上限の 1 バイト上は拒否する', () => {
    // **これがフォーク連鎖の肥大化を止める関門である**（#33 の goal）。ここが無いと、
    // 上限超のソースが R2 へ入り、次にフォークや推敲をした瞬間に行き止まりになる。
    const rejected = rejectionOf(sourceOfBytes(MAX_SOURCE_BYTES + 1));
    expect(rejected.reason).toBe('source-too-large');
  });

  it('バイト数で測る（日本語のコメントを 3 分の 1 に見誤らない）', () => {
    // 文字数で数えると、日本語のコメントが多いソースが上限の 3 倍まで通る。
    const head = source('');
    const comments = 'あ'.repeat(MAX_SOURCE_BYTES / 3);
    const goSource = head + comments;
    expect([...goSource].length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(rejectionOf(goSource).reason).toBe('source-too-large');
  });

  it('引用できる断片を載せない', () => {
    // 上限はソース全体の性質で、引用できる断片が無い。**生成物由来の文字列を
    // 応答とログへ持ち出さない**（このモジュールが件数と長さに上限を掛けている理由）。
    const rejected = rejectionOf(sourceOfBytes(MAX_SOURCE_BYTES + 1));
    expect(rejected.offending).toEqual([]);
    expect(describeSourceRejection(rejected).offending).toEqual([]);
  });

  it('許可外 import より先に落とす', () => {
    // どちらにも違反しているソースでは、**先に落とせるほうで落とす。** 上限超は
    // 字句解析を回す前に分かる。
    const head = source('import "os/exec"');
    const padded = head + 'x'.repeat(MAX_SOURCE_BYTES + 1 - new TextEncoder().encode(head).length);
    expect(rejectionOf(padded).reason).toBe('source-too-large');
    // 上限内なら、いままでどおり import の理由で落ちる。
    expect(rejectionOf(head).reason).toBe('not-allowed');
  });

  it('経路層へは 422 として出る（既存の拒否と同じ扱い）', () => {
    const body = describeSourceRejection(rejectionOf(sourceOfBytes(MAX_SOURCE_BYTES + 1)));
    expect(body.error).toBe(SOURCE_REJECTED_ERROR);
    expect(body.reason).toBe('source-too-large');
    expect(SOURCE_REJECTED_STATUS).toBe(422);
  });
});

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
      offending: ['os/exec'],
    });
  });

  it('リクエストの誤りでもサーバの故障でもない状態で返す', () => {
    // 400 は「リクエストが壊れている」で、この段まで来たリクエストは検証を通っている。
    // 500 でもない（段は設計どおり働いた）。429 とも別で、枠は既に消費済みである。
    expect(SOURCE_REJECTED_STATUS).toBe(422);
  });

  it('件数に上限を掛け、切り詰めたことを示す', () => {
    const paths = ['os', 'net', 'net/http', 'syscall', 'unsafe', 'embed', 'plugin', 'fmt', 'reflect', 'time', 'bufio', 'bytes', 'io'];
    expect(paths.length).toBeGreaterThan(MAX_REPORTED_OFFENDING);
    const rejected = rejectionOf(
      source(`import (\n${paths.map((path) => `\t"${path}"`).join('\n')}\n)`),
    );
    // 例外そのものは全件を持つ（呼び出し側が必要なら全部見られる）。
    expect(rejected.offending).toEqual(paths);
    // 外へ出す形では上限を掛ける。
    const body = describeSourceRejection(rejected);
    expect(body.offending).toHaveLength(MAX_REPORTED_OFFENDING + 1);
    expect(body.offending.at(-1)).toContain(`他 ${paths.length - MAX_REPORTED_OFFENDING} 件`);
  });

  it('長すぎるパスを切り詰める', () => {
    // import パスは生成物であり、長さはこちらで決まらない。
    const long = 'x'.repeat(MAX_REPORTED_OFFENDING_LENGTH * 3);
    const body = describeSourceRejection(rejectionOf(source(`import "${long}"`)));
    expect(body.offending).toHaveLength(1);
    expect([...body.offending[0]!]).toHaveLength(MAX_REPORTED_OFFENDING_LENGTH + 1);
    expect(body.offending[0]!.endsWith('…')).toBe(true);
  });

  it('上限ちょうどのパスは切り詰めない', () => {
    const exact = 'y'.repeat(MAX_REPORTED_OFFENDING_LENGTH);
    const body = describeSourceRejection(rejectionOf(source(`import "${exact}"`)));
    expect(body.offending).toEqual([exact]);
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


/**
 * `text` 描画で文字列を出す Go のソースを組み立てる（8.3 / 確定23 / #38）。
 *
 * **8.3 が想定しているのはこの経路そのものである。** 6.1 が `text/v2` と `basicfont` を
 * 許しているため（確定23 / #72）、生成物は画面へ任意の文字列を出せる。
 *
 * @param literal 描画する Go の文字列リテラル（引用符を含む）
 * @returns Go のソース
 */
function drawingSource(literal: string): string {
  return `package main

import (
\t"github.com/hajimehoshi/ebiten/v2"
\t"github.com/hajimehoshi/ebiten/v2/text/v2"
\t"golang.org/x/image/font/basicfont"
)

type Game struct{}

func (g *Game) Draw(screen *ebiten.Image) {
\tface := text.NewGoXFace(basicfont.Face7x13)
\ttext.Draw(screen, ${literal}, face, nil)
}
`;
}

/**
 * 規則ではなく**結線**を試すためのダミーの表。
 *
 * **実在の差別語をこのファイルへ書かない**（`test/output-moderation.test.ts` と同じ方針）。
 * 既定の表が実際に効いていることは、下で表から語を引いて確かめる。
 */
const DUMMY_TERMS: readonly DeniedTerm[] = [
  { term: 'ダミー禁止語', match: 'substring', category: 'discriminatory' },
];

describe('NG ワードを描画するソースを拒否する（8.3 / #38）', () => {
  it('差別語を text 描画するソースが検出される（acceptance）', () => {
    // **語をこのファイルへ書き写さない。** 既定の表から引いて組み立てる。
    // これで「テストに実在の差別語を書かない」ことと「既定の表が本当に効いている
    // ことを確かめる」ことが両立する。
    //
    // **件数を先に見る。** 表が空だと for が 1 度も回らず、**何も確かめないまま緑**に
    // なる（引き継ぎ 4 章「確かめていない検査は赤より悪い」）。表を空にする変異で
    // このテストが赤になることを実際に確かめてある。
    expect(DENIED_TERMS.length).toBeGreaterThan(0);
    for (const term of DENIED_TERMS) {
      const rejected = rejectionOf(drawingSource(`"${term.term}"`));
      expect(rejected.reason).toBe('denied-term');
      expect(rejected.offending).toEqual([term.category]);
    }
  });

  it('表に無い語しか出さないソースは通る', () => {
    expect(() =>
      inspectGeneratedSource(generated(drawingSource('"SCORE: 100"'))),
    ).not.toThrow();
  });

  it('表を注入した検査段でも同じ形で拒否する', () => {
    const inspect = createSourceInspector(DUMMY_TERMS);
    let rejected: GeneratedSourceRejected | null = null;
    try {
      inspect(generated(drawingSource('"ダミー禁止語"')));
    } catch (error) {
      rejected = error as GeneratedSourceRejected;
    }
    expect(rejected).toBeInstanceOf(GeneratedSourceRejected);
    // **理由まで見る。** 拒否されたことだけを見ると、読み取りに失敗して落ちた
    // （`unparsable`）場合も緑になる。
    expect(rejected!.reason).toBe('denied-term');
    // 注入した表に無い語は通る。**既定の表を見に行っていない**ことの確認でもある。
    expect(() => inspect(generated(drawingSource('"SCORE"')))).not.toThrow();
  });

  it('拒否した語そのものは応答にもログにも出さない', () => {
    // 8.3 の #133 注記は「固定語彙は生成物由来ではない」とするので、語を出しても
    // 規約違反ではない。それでも出さないのは、**422 の応答が表を 1 語ずつ引き出せる
    // 口になる**ためである（当てては消し、を繰り返せば一覧が復元できる）。
    const inspect = createSourceInspector(DUMMY_TERMS);
    let rejected: GeneratedSourceRejected | null = null;
    try {
      inspect(generated(drawingSource('"これはダミー禁止語です"')));
    } catch (error) {
      rejected = error as GeneratedSourceRejected;
    }
    expect(rejected).not.toBeNull();
    expect(rejected!.message).not.toContain('ダミー禁止語');
    const body = describeSourceRejection(rejected!);
    expect(body).toEqual({
      error: SOURCE_REJECTED_ERROR,
      reason: 'denied-term',
      offending: ['discriminatory'],
    });
  });

  it('5.2-5 の違反のほうを理由にする', () => {
    // 両方に違反しているソースでは、**先に安全側の理由**を返す。import と指示は
    // 7.1 のコンテナに対する多層防御の層で、8.3 は表示物の話である。
    const inspect = createSourceInspector(DUMMY_TERMS);
    let rejected: GeneratedSourceRejected | null = null;
    try {
      inspect(
        generated(`package main

import "os/exec"

const label = "ダミー禁止語"
`),
      );
    } catch (error) {
      rejected = error as GeneratedSourceRejected;
    }
    expect(rejected!.reason).toBe('not-allowed');
  });

  it('エッジとオーケストレータが同じ検査段を借りている', () => {
    // **実行環境によって表が違う状態を作らない。** 表をコード側へ置いた理由
    // （`src/denied-terms.ts` 冒頭）は、この同一性が成り立っていて初めて意味を持つ。
    expect(defaultPipeline.inspectSource).toBe(inspectGeneratedSource);
  });
});
