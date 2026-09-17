/**
 * 生成物の質の指標（#605 / `src/source-quality.ts`）。
 *
 * **公式サンプル 10 本の基準線と同じ値を出すことが、この指標のいちばん重要な性質である。**
 * #597 の基準線は使い捨ての Go の道具（`go/parser`）で測った値なので、**実装が違う値を
 * 出すなら、以後の前後比較は違う物差しで比べることになる。** 10 本のソースは本番の R2 に
 * あってテストからは読めないが、**同じ形を作る断片**に対する期待値をここへ置き、
 * 埋め戻しの外部検証（#605 の acceptance）で本物と突き合わせる。
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  LOSE_WORDS,
  SOURCE_QUALITY_RULE_VERSION,
  WIN_WORDS,
  measureSourceQuality,
} from '../src/source-quality.js';

/** 期待値を書きやすくするための薄い包み。 */
function metrics(source: string): ReturnType<typeof measureSourceQuality> {
  return measureSourceQuality(source);
}

/** 測れたことを前提に指標を取り出す（測れなければテストを落とす）。 */
function measured(source: string) {
  const result = metrics(source);
  if (!result.ok) {
    throw new Error(`測れなかった: ${result.reason}`);
  }
  return result.metrics;
}

describe('勝ち負けの語', () => {
  it('勝ちの語を画面へ出していれば真になる', () => {
    expect(measured('package main\nvar s = "クリア！"\n').hasWinText).toBe(true);
    expect(measured('package main\nvar s = "かった！"\n').hasWinText).toBe(true);
  });

  it('「かった」を取りこぼさない（#597 で 1 本見落とした形）', () => {
    // **最初の一覧は「かち」を持っていたが「かった」を持たず**、ケロケロ舌合戦の
    // `かった！` を見落として「勝ちは 4/10」と出した（正しくは 5/10）。
    expect(WIN_WORDS).toContain('かった');
    expect(measured('package main\nvar s = "かった！"\n').hasWinText).toBe(true);
  });

  it('負けの語だけの作品は、勝ちが偽・負けが真になる', () => {
    const m = measured('package main\nvar s = "ゲームオーバー"\n');
    expect(m.hasWinText).toBe(false);
    expect(m.hasLoseText).toBe(true);
  });

  it('コメントの中の語は数えない', () => {
    // **字句解析を使う理由そのものである。** 正規表現でソースを直接なぞると当たる。
    expect(measured('package main\n// クリア のことは、まだ書いていない\n').hasWinText).toBe(false);
  });

  it('大文字小文字を問わない', () => {
    expect(measured('package main\nvar s = "game over"\n').hasLoseText).toBe(true);
    expect(LOSE_WORDS).toContain('GAME OVER');
  });
});

describe('色の数', () => {
  it('同じ色を 2 か所に書いても 1 つに数える', () => {
    const source = `package main
var a = color.RGBA{0x11, 0x22, 0x33, 0xff}
var b = color.RGBA{0x11, 0x22, 0x33, 0xff}
var c = color.RGBA{0x44, 0x55, 0x66, 0xff}
`;
    expect(measured(source).colorCount).toBe(2);
  });

  it('関数の戻り値の型を色として数えない（#605 で実際に踏んだ）', () => {
    // **ケロケロ舌合戦で 18 色を 19 と数えた形である。** `) color.RGBA {` の `{` は
    // 関数の本体であって、色のリテラルではない。
    const source = `package main
func clrAlpha(c color.RGBA, a uint8) color.RGBA {
	c.A = a
	return c
}
`;
    expect(measured(source).colorCount).toBe(0);
  });

  it('パレット（map の要素の型）の中の色を数える', () => {
    // **プロンプトが新しく教えている書き方そのものである**（仕様 6.1 のスプライト）。
    // 数えないと、**新しい書き方を採った作品ほど色が少なく見える**という逆立ちが起きる。
    const source = `package main
var artPalette = map[byte]color.RGBA{
	'1': {0xff, 0xcc, 0x44, 0xff},
	'2': {0x22, 0x22, 0x33, 0xff},
}
`;
    expect(measured(source).colorCount).toBe(2);
  });

  it('スライスのリテラルの中の色も数える', () => {
    const source = `package main
var palette = []color.RGBA{
	{0x11, 0x11, 0x11, 0xff},
	{0x22, 0x22, 0x22, 0xff},
	{0x33, 0x33, 0x33, 0xff},
}
`;
    expect(measured(source).colorCount).toBe(3);
  });

  it('スライスを返す関数の本体を容れ物と取り違えない', () => {
    // `func f() []color.RGBA {` も直前が `]` になる。**`[` の手前が `)` なら戻り値の型である。**
    const source = `package main
func palette() []color.RGBA {
	if ok {
		return nil
	}
	return nil
}
`;
    expect(measured(source).colorCount).toBe(0);
  });
});

describe('スプライトの利用', () => {
  it('ebiten.NewImage の呼び出しを数える', () => {
    const source = `package main
func newSprite() *ebiten.Image {
	img := ebiten.NewImage(8, 8)
	return img
}
var other = ebiten.NewImage(4, 4)
`;
    expect(measured(source).spriteCount).toBe(2);
  });

  it('呼び出していなければ 0 になる（#597 の基準線は 10 本とも 0 だった）', () => {
    expect(measured('package main\nvar x = ebiten.Termination\n').spriteCount).toBe(0);
  });

  it('開き括弧が無い綴りは数えない', () => {
    expect(measured('package main\nvar f = ebiten.NewImage\n').spriteCount).toBe(0);
  });
});

describe('画面の状態', () => {
  it('iota の組の名前を数える', () => {
    const source = `package main
const (
	stateTitle = iota
	statePlaying
	stateOver
)
`;
    expect(measured(source).stateCount).toBe(3);
  });

  it('iota を含まない組は数えない', () => {
    const source = `package main
const (
	sw = 320
	sh = 240
)
`;
    expect(measured(source).stateCount).toBe(0);
  });

  it('行をまたぐ定数式の続きを、別の状態として数えない（PR #607 の Copilot の指摘）', () => {
    // **行の先頭の識別子をそのまま数えると、`offset` を 3 つ目の状態として数えてしまう。**
    const source = `package main
const (
	stateA = iota +
		offset
	stateB
)
`;
    expect(measured(source).stateCount).toBe(2);
  });

  it('括弧やカンマで終わる行の続きも数えない', () => {
    const source = `package main
const (
	stateA = iota + len([]int{
		1, 2,
	})
	stateB
)
`;
    expect(measured(source).stateCount).toBe(2);
  });

  it('組が 2 つあれば大きいほうを採る', () => {
    const source = `package main
const (
	a = iota
	b
)
const (
	c = iota
	d
	e
	f
)
`;
    expect(measured(source).stateCount).toBe(4);
  });
});

describe('読み取れないソース', () => {
  it('閉じない文字列は落とす（0 として書かない）', () => {
    // **測れなかったことと、悪い生成であることを区別する。**
    const result = metrics('package main\nvar s = "閉じていない\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unparsable');
    }
  });
});

describe('隔離ビルドのサンプル', () => {
  it('プロンプトが教えている書き方を、指標が拾える', () => {
    // **`docker/isolated-build/sample/ebitengine.go` は実際にコンパイルが通るサンプルであり、
    // #597 でスプライトと画面の状態を足した。** 指標がそれを拾えなければ、**プロンプトが
    // 教えたとおりに書いた作品を「教えたことをしていない」と測ることになる。**
    // **`textBlobBindings` で渡ってくる**（`vitest.config.ts`）。テストは workerd の中で
    // 動くのでファイルシステムを読めない。`test/system-prompt.test.ts` と同じ入口を使う。
    const sample = env.TEST_BUILD_SAMPLE;
    const m = measured(sample);
    expect(m.spriteCount).toBeGreaterThan(0);
    expect(m.stateCount).toBe(3);
    expect(m.hasWinText).toBe(true);
    expect(m.hasLoseText).toBe(true);
    // **正確な数で見る**（PR #607 の Copilot の指摘）。`>` で見ると、パレットの 2 色を
    // 取りこぼしても、ほかの色だけで条件を満たしてしまう。サンプルの色は
    // パレットの 2 色（`0xffcc44ff` / `0x222233ff`）と、背景の面と、スプライトの
    // 色替えで、合わせて 4 色である。
    expect(m.colorCount).toBe(4);
  });
});

describe('規則の版', () => {
  it('1 以上の整数である', () => {
    // **規則を変えたら上げる。** 上げると埋め戻しが古い行を拾い直す。
    expect(Number.isInteger(SOURCE_QUALITY_RULE_VERSION)).toBe(true);
    expect(SOURCE_QUALITY_RULE_VERSION).toBeGreaterThanOrEqual(1);
  });
});
