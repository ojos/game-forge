import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SOURCE_BYTES,
  SYSTEM_PROMPT_SECTIONS,
  buildSystemPrompt,
  renderSystemPromptText,
} from '../src/system-prompt.js';
import { GO_IMPORT_ALLOWLIST, renderAllowlistSection } from '../src/go-import-allowlist.js';
import { GENERATION_MODELS } from '../src/generation-models.js';
import type { GenerationModel, SystemBlock } from '../src/generation-models.js';

/** 既定のモデル（本文はモデルで変えないので、どれで組み立てても同じはず）。 */
const anyModel: GenerationModel = GENERATION_MODELS[0]!;

/**
 * ブロック列からテキストだけを連結する。
 *
 * @param blocks 組み立てたブロック列
 * @returns 連結した本文
 */
function textOf(blocks: readonly SystemBlock[]): string {
  return blocks
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n\n')
    .trim();
}

describe('本文の構成（6.1）', () => {
  it('7 つの節をこの順で並べる', () => {
    // 順序には理由がある。出力形式を最初に、自己点検を最後に置く（`src/system-prompt.ts`）。
    // 節を足したり並べ替えたりするとキャッシュが作り直しになるので、意図しない変更を
    // ここで止める。
    const expected = [
      'あなたは Go と Ebitengine で',
      '満たすべき構造:',
      '禁止:',
      '使用してよいパッケージは次のものだけです',
      '許可された API の使い方',
      '著作権と命名:',
      '出力する前に自分で確かめること:',
    ];
    expect(SYSTEM_PROMPT_SECTIONS).toHaveLength(expected.length);
    expected.forEach((prefix, index) => {
      expect(SYSTEM_PROMPT_SECTIONS[index]!.startsWith(prefix), prefix).toBe(true);
    });
  });

  it('6.1 の制約がすべて本文に現れる', () => {
    const text = renderSystemPromptText();
    // 6.1 の箇条書きに対応する。文言そのものではなく、**制約が落ちていないこと**を見る。
    expect(text).toContain('ebiten.Game を厳格に実装');
    expect(text).toContain('func (g *Game) Update() error');
    expect(text).toContain('func (g *Game) Draw(screen *ebiten.Image)');
    expect(text).toContain('func (g *Game) Layout(outsideWidth, outsideHeight int) (int, int)');
    expect(text).toContain('外部ファイルとネットワークからの読み込みを全面的に禁止');
    expect(text).toContain('fmt と reflect を使いません');
    expect(text).toContain(`${MAX_SOURCE_BYTES} バイト以内`);
  });

  it('ソースの上限を書き写さず定数から埋める（確定18 / 5.3）', () => {
    // 数字を手書きすると、5.3 の上限を実際に検査する段を作った日にずれる。
    expect(MAX_SOURCE_BYTES).toBe(30 * 1024);
    expect(renderSystemPromptText()).toContain(String(MAX_SOURCE_BYTES));
  });

  it('import を経由しない経路を禁じている（#100）', () => {
    // ホワイトリスト検査（`src/go-imports.ts`）は import 文しか見ないため、
    // `//go:wasmimport` は構造的に検出できない。**プロンプトは防御ではない**が、
    // 善意の生成物がうっかり踏む経路は塞げる。検査そのものは #100 が持つ。
    const text = renderSystemPromptText();
    expect(text).toContain('//go:wasmimport');
    expect(text).toContain('//go:linkname');
    expect(text).toContain('import "C" を書きません');
  });

  it('コードフェンスと前置きを禁じている', () => {
    // `scanImports` は package 句を見つけられない入力を拒否する。フェンスが 1 行付く
    // だけで、中身が正しくても生成が丸ごと無駄になる。
    const text = renderSystemPromptText();
    expect(text).toContain('コードフェンス');
    expect(text).toContain('最初の行は package main です');
  });
});

describe('許可パッケージは正本から導出する（acceptance 2）', () => {
  it('`renderAllowlistSection()` の出力をそのまま含む', () => {
    // **書き写していないことの根拠。** 一節を丸ごと含んでいれば、`GO_IMPORT_ALLOWLIST`
    // を書き換えた瞬間に本文も追随する。手書きの一覧はこの検査を通せない。
    expect(renderSystemPromptText()).toContain(renderAllowlistSection());
  });

  it('一覧の各行が本文にちょうど 1 回だけ現れる', () => {
    // 2 回現れたら、どこかに 2 つ目の（追随しない）一覧がある。
    const text = renderSystemPromptText();
    for (const entry of GO_IMPORT_ALLOWLIST) {
      const line = `- ${entry.path} — ${entry.reason}`;
      expect(text.split(line).length - 1, entry.path).toBe(1);
    }
  });

  it('旧 text（v1）を import させない（#72 の実測）', () => {
    // #7 の 6 本のうち 1 本が v1 のパスを import して許可外になった。パス末尾（v2）と
    // パッケージ名（text）が食い違うことが原因なので、その 1 点を明示する。
    expect(renderSystemPromptText()).toContain(
      '旧 github.com/hajimehoshi/ebiten/v2/text（v1）は一覧に無く',
    );
  });
});

describe('許可 API の使い方（6.1「制約を並べるだけでは足りない」/ #7 / #72）', () => {
  it('text/v2 の 3 点を書いている', () => {
    // この 3 行が無いと DeepSeek は 6 本中 6 本落ちた（#72 のコメント）。
    const text = renderSystemPromptText();
    expect(text).toContain('text.NewGoXFace(basicfont.Face7x13)');
    expect(text).toContain('text.Draw の引数は 4 つです');
    expect(text).toContain('text.Measure の戻り値は 2 つ');
  });

  it('教える API は隔離ビルドで実際にコンパイルが通った形と一致する', () => {
    // **存在しない API を教えないことの機械照合。** 4.2 が記録した Claude の失敗は
    // 存在しない API の捏造（`vector.DrawFilledRoundRect`）であり、プロンプトが同じ
    //ことをすれば全生成が同じ失敗をする。`docker/isolated-build/sample/ebitengine.go`
    // は `--network=none` の隔離ビルドで実際に通っているサンプルなので、そこに現れる
    // 形だけを照合の対象にする。
    //
    // **照合できない行が残る**（このサンプルが触っていない API）。
    // `text.Measure` / `op.ColorScale.ScaleWithColor` / `vector.DrawFilledCircle` /
    // `vector.StrokeLine` / `vector.StrokeRect` / `inpututil.IsMouseButtonJustPressed` /
    // `ebiten.CursorPosition` / `rand.*` は、根拠が #7・#72 の実測と Ebitengine の
    // 公開 API であってこのサンプルではない。サンプル側を増やすのは #18 の範囲。
    const sample = env.TEST_BUILD_SAMPLE;
    const text = renderSystemPromptText();
    for (const fragment of [
      'text.NewGoXFace(basicfont.Face7x13)',
      'op := &text.DrawOptions{}',
      'op.GeoM.Translate(',
      'text.Draw(screen, "SCORE "+strconv.Itoa(',
      'vector.DrawFilledRect(screen, ',
      'inpututil.IsKeyJustPressed(ebiten.Key',
      'ebiten.IsKeyPressed(ebiten.Key',
      'ebiten.SetWindowSize(640, 480)',
      'ebiten.RunGame(g); err != nil && !errors.Is(err, ebiten.Termination)',
      'func (g *Game) Update() error',
      'func (g *Game) Draw(screen *ebiten.Image)',
    ]) {
      expect(text, `プロンプトに無い: ${fragment}`).toContain(fragment);
      expect(sample, `サンプルで検証されていない: ${fragment}`).toContain(fragment);
    }
  });

  it('型の混在への注意を書いている（#7 の失敗 01 / 02）', () => {
    const text = renderSystemPromptText();
    expect(text).toContain('float32');
    expect(text).toContain('暗黙に混ぜません');
  });

  it('未使用 import を禁じている（DeepSeek の支配的な失敗）', () => {
    // **これを書いても消えなかった**（#7 の v2 版で 6 本中 2 本）。それでも外さないのは、
    // 書かない版（v1）との比較が無い以上、外す根拠も無いためである。救済は #20。
    expect(renderSystemPromptText()).toContain('使わないものは import しません');
  });

  it('時間をフレーム数で数えさせる（time は許可されていない）', () => {
    expect(renderSystemPromptText()).toContain('フレーム数で数えます');
  });
});

describe('キャッシュブレークポイントの配置（4.5 / 4.1）', () => {
  it('末尾にちょうど 1 つだけ置く', () => {
    const blocks = buildSystemPrompt(anyModel);
    const cachePoints = blocks.filter((block) => 'cachePoint' in block);
    expect(cachePoints).toHaveLength(1);
    expect(blocks.at(-1)).toEqual({ cachePoint: true });
  });

  it('区切りの前に本文がある', () => {
    // 指す先の無い `cachePoint` は `Converse` に拒否される（`toConverseSystem`）。
    const blocks = buildSystemPrompt(anyModel);
    expect(blocks.slice(0, -1).every((block) => 'text' in block)).toBe(true);
    expect(blocks.length).toBe(SYSTEM_PROMPT_SECTIONS.length + 1);
  });

  it('本文が最小キャッシュ長（4.5 の 1,024 トークン）を上回る見込みである', () => {
    // **これは概算であって実測ではない。** 4.5 の最小キャッシュ長を下回ると、区切りを
    // 置いてもキャッシュは作られず、置いたこと自体が静かに無効になる。実測（#7）では
    // 入力が Claude 1,092 / DeepSeek 911 トークンで、**当時のプロンプトは最小長すれすれ
    // だった**。ここでは ASCII を 4 文字 = 1 トークン、非 ASCII を 2 文字 = 1 トークンと
    // いう**保守的に少なく見積もる**換算で下限を取る。真の確認は実呼び出しで
    // `cacheWriteInputTokens` / `cacheReadInputTokens` を見るまでできない。
    const chars = [...renderSystemPromptText()];
    const ascii = chars.filter((char) => char.codePointAt(0)! < 128).length;
    const estimated = Math.floor(ascii / 4 + (chars.length - ascii) / 2);
    expect(estimated).toBeGreaterThan(1024);
  });
});

describe('モデルごとに出し分けない（決定）', () => {
  it('登録簿のどのモデルでも同じブロック列を返す', () => {
    // **理由は `src/system-prompt.ts` の冒頭と仕様書 6.1 に書いた。** 出し分けを
    // 入れる日には、それを正当化する実測を併せて残すこと。このテストはその決定を
    // 固定するためのもので、分岐を入れるときは意図的に書き換える。
    const first = buildSystemPrompt(GENERATION_MODELS[0]!);
    for (const model of GENERATION_MODELS) {
      expect(buildSystemPrompt(model), model.key).toEqual(first);
    }
  });

  it('登録簿に 2 モデル以上あることを前提にしている', () => {
    // 1 モデルしか無ければ上のテストは何も見ていない（確定5 は複数構成）。
    expect(GENERATION_MODELS.length).toBeGreaterThan(1);
  });
});

describe('動的値を含めない（acceptance 1 / 4.5）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('何度組み立てても同じものになる', () => {
    expect(buildSystemPrompt(anyModel)).toEqual(buildSystemPrompt(anyModel));
    expect(renderSystemPromptText()).toBe(renderSystemPromptText());
  });

  it('タイムスタンプ・UUID・利用者 ID らしき文字列が無い', () => {
    const text = renderSystemPromptText();
    // 日付（ISO 8601 / スラッシュ区切り）、UNIX 時刻のような長い数字列、UUID。
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}/u);
    expect(text).not.toMatch(/\d{10,}/u);
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
    );
    // `new Date().toString()` は ISO 形式ではないので上の 3 つで捕まらない。
    expect(text).not.toMatch(/GMT|UTC/u);
  });

  it('モジュールの読み込み時にも時刻・乱数・UUID を読まない', async () => {
    // **呼び出し時だけを見ても足りない。** 動的値がモジュールの初期化時（定数の
    // 組み立て）に混ざると、何度呼んでも同じ値が返るため上の 2 つのテストを素通りする。
    // 時刻と乱数の口へ番兵を仕込んだうえでモジュールを読み直し、番兵が本文へ現れない
    // ことを見る。
    const sentinelNumber = 1919191919191;
    const sentinelUuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
    vi.stubGlobal('Date', {
      ...Date,
      now: () => sentinelNumber,
      toString: () => sentinelUuid,
    });
    vi.stubGlobal('crypto', { ...crypto, randomUUID: () => sentinelUuid });
    vi.stubGlobal('Math', { ...Math, random: () => 0.191919191919 });
    vi.resetModules();

    const reloaded = (await import('../src/system-prompt.js')) as {
      renderSystemPromptText: () => string;
    };
    const text = reloaded.renderSystemPromptText();
    expect(text).not.toContain(String(sentinelNumber));
    expect(text).not.toContain(sentinelUuid);
    expect(text).not.toContain('0.191919');
    // 読み直した本文が元と一致すること自体も見る（読み込みのたびに変わる値が無い）。
    expect(text).toBe(renderSystemPromptText());
  });
});

describe('ブロック列の形', () => {
  it('連結すると本文になる', () => {
    expect(textOf(buildSystemPrompt(anyModel))).toBe(renderSystemPromptText());
  });

  it('空のブロックを含まない', () => {
    // 空文字の `text` ブロックは `Converse` に拒否される。
    for (const block of buildSystemPrompt(anyModel)) {
      if ('text' in block) {
        expect(block.text.trim()).not.toBe('');
      }
    }
  });
});
