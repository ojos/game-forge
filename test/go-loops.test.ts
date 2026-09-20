/**
 * 終了条件を持たない繰り返しの検査（6.1 / 7.2 / `src/go-loops.ts` / #730）。
 *
 * **このテストが守っているのは 2 つの向きである。**
 *
 * 1. **落とすべき形を落とすこと**（`for {}` / `for true {}`）。
 * 2. **正当な作品を 1 つも落とさないこと。** 違反は再生成に回さず拒否するので
 *    （5.2-5）、**誤検知はそのまま利用者の生成枠を 1 つ奪う。** 毎フレームの描画で
 *    画素・敵・弾を回すループは正当な書き方である（利用者の決定）。
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  UNBOUNDED_LOOP_FORMS,
  UNBOUNDED_LOOP_REJECTION,
  UNBOUNDED_LOOP_SECTION_HEADING,
  findUnboundedLoops,
} from '../src/go-loops.js';

/** 条件が無い形の名前（表の 1 行目）。 */
const FORM_NO_CONDITION = UNBOUNDED_LOOP_FORMS[0]!.name;

/** 条件が定数 true の形の名前（表の 2 行目）。 */
const FORM_CONSTANT_TRUE = UNBOUNDED_LOOP_FORMS[1]!.name;

/**
 * 関数の本体を 1 つ持つ Go のソースを組み立てる。
 *
 * **`Update` の中に置く。** #730 が止めたいのは「1 フレームの中で制御を返さない」形で、
 * 置き場所が分かる形にしておくとテストの意図が読める。
 *
 * @param body `Update` の本体
 * @returns Go のソース
 */
function update(body: string): string {
  return `package main

import "github.com/hajimehoshi/ebiten/v2"

type Game struct{ frame int }

func (g *Game) Update() error {
${body}
	return nil
}

func (g *Game) Draw(screen *ebiten.Image) {}
`;
}

describe('落とす形（acceptance 1）', () => {
  it('`for {}` を落とす', () => {
    expect(findUnboundedLoops(update('\tfor {\n\t}'))).toEqual([FORM_NO_CONDITION]);
  });

  it('`for true {}` を落とす', () => {
    expect(findUnboundedLoops(update('\tfor true {\n\t}'))).toEqual([FORM_CONSTANT_TRUE]);
  });

  it('括弧と否定で包んだ定数 true も落とす', () => {
    // `for (true)` / `for !false` / `for !!true` はどれも定数 true である。
    // **畳むのはこの 4 つの綴りだけ**（`src/go-loops.ts` の `evaluateConstantBool`）。
    for (const condition of ['(true)', '((true))', '!false', '!!true', '!(false)']) {
      expect(findUnboundedLoops(update(`\tfor ${condition} {\n\t}`)), condition).toEqual([
        FORM_CONSTANT_TRUE,
      ]);
    }
  });

  it('中身のある本体でも落とす（空の本体だけを見ていない）', () => {
    const body = '\tfor {\n\t\tg.frame++\n\t\tg.frame *= 2\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([FORM_NO_CONDITION]);
  });

  it('入れ子の内側にあっても落とす', () => {
    const body = '\tfor i := 0; i < 10; i++ {\n\t\tfor {\n\t\t\tg.frame++\n\t\t}\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([FORM_NO_CONDITION]);
  });

  it('比較と単項マイナスを、チャネルの受信と読み違えない（PR #734 の指摘）', () => {
    // **`x < -y` は `<` と `-` の 2 字句である。** 並びだけで受信とみなすと、
    // **出る経路も待ちも持たない `for {}` が通り抜ける。**
    const body = '\tfor {\n\t\tif g.frame < -g.limit {\n\t\t\tg.frame++\n\t\t}\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([FORM_NO_CONDITION]);
  });

  it('数値リテラルの左辺でも読み違えない（第二意見の指摘。実測で否定）', () => {
    // **`scanTokens` は数字を 1 文字ずつ返す**（`10` は `other:1` と `other:0`）。
    // したがって `<` の直前は必ず 1 文字の数字で、`endsOperand` が値の終わりと読む。
    // 第二意見は「2 桁以上の数値リテラルで受信と誤判定する」と報告したが、
    // **字句を実測すると成り立たない。** 浮動小数点と 16 進も同じ形で確かめる。
    for (const left of ['10', '100', '3.14', '0x1F']) {
      const body = `\tfor {\n\t\tif ${left} < -g.limit {\n\t\t\tg.frame++\n\t\t}\n\t}`;
      expect(findUnboundedLoops(update(body)), left).toEqual([FORM_NO_CONDITION]);
    }
  });

  it('送信だけで待つ形は数えない（比較と区別が付かない側は通さない）', () => {
    // 綴りの上で `ch <- v` と `x < -y` は見分けられない。**見分けられない側を
    // 「待っている」と読むと、比較を書いただけの `for {}` が通り抜ける。**
    const body = '\tfor {\n\t\tg.ch <- 1\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([FORM_NO_CONDITION]);
  });

  it('同じ形が何度出ても 1 回だけ返す（出現順）', () => {
    const body = '\tfor true {\n\t}\n\tfor {\n\t}\n\tfor true {\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([FORM_CONSTANT_TRUE, FORM_NO_CONDITION]);
  });
});

describe('落とさない形（acceptance 2。誤検知は生成枠を 1 つ奪う）', () => {
  it('毎フレーム有限回まわす形を落とさない', () => {
    // **画素・敵・弾のループ**。どれも正当な書き方である（利用者の決定）。
    const bodies = [
      '\tfor i := 0; i < len(g.enemies); i++ {\n\t\tg.enemies[i].x++\n\t}',
      '\tfor _, b := range g.bullets {\n\t\tb.y--\n\t}',
      '\tfor y := 0; y < 16; y++ {\n\t\tfor x := 0; x < 16; x++ {\n\t\t\tg.img.Set(x, y, g.palette[0])\n\t\t}\n\t}',
      '\tfor i := 0; i < len(pcm); i += 8 {\n\t\tpcm[i] = 0\n\t}',
      '\tfor g.frame < 60 {\n\t\tg.frame++\n\t}',
      '\tfor i := range g.cells {\n\t\tg.cells[i] = 0\n\t}',
    ];
    for (const body of bodies) {
      expect(findUnboundedLoops(update(body)), body).toEqual([]);
    }
  });

  it('条件が変数なら落とさない（定数 true と読まない）', () => {
    const body = '\trunning := true\n\tfor running {\n\t\trunning = g.frame < 10\n\t\tg.frame++\n\t}';
    expect(findUnboundedLoops(update(body))).toEqual([]);
  });

  it('本体に出る経路があれば落とさない', () => {
    // **区別しない側へ倒してある**（`src/go-loops.ts`）。`break` が入れ子の `switch` の
    // 中にしか無い形まで落とすには本文の構文解析が要り、間違えたぶんは正当な作品の
    // 拒否になって現れる。**通り抜ける形は仕様 7.2 に列挙した。**
    for (const exit of ['break', 'return nil', 'goto done', 'panic("x")', 'select {}']) {
      const body = `\tfor {\n\t\tg.frame++\n\t\t${exit}\n\t}`;
      expect(findUnboundedLoops(update(body)), exit).toEqual([]);
    }
  });

  it('チャネルの受信で止まる形は落とさない', () => {
    // **止まる形であって、回り続ける形ではない**（この票が止めるのは主スレッドを
    // 明け渡さないまま回る形である）。
    for (const body of ['\tfor {\n\t\t<-g.ch\n\t}', '\tfor {\n\t\tv := <-g.ch\n\t\tg.frame = v\n\t}']) {
      expect(findUnboundedLoops(update(body)), body).toEqual([]);
    }
  });

  it('コメントと文字列リテラルの中の `for {}` を拾わない', () => {
    // **字句解析を借りている理由そのものである**（正規表現で探すとここで誤検知する）。
    const body = '\t// for {} と書いた昔の版\n\tg.label = "for {}"\n\t/* for true {} */';
    expect(findUnboundedLoops(update(body))).toEqual([]);
  });

  it('読み取れないソースでは何も言わない', () => {
    // 読めないこと自体は `inspectGoImports` が `unparsable` として先に落とす。
    // ここで別の理由を作ると、同じ 1 つの事実に 2 つの拒否理由が生まれる。
    expect(findUnboundedLoops('package main\nvar s = "閉じていない\nfor {\n}\n')).toEqual([]);
  });
});

describe('生成物の綴りで壊れない（PR #734 の指摘）', () => {
  it('`!` を重ねた条件を、深さに関係なく同じ規則で畳む', () => {
    // **生成物は `!` をいくらでも重ねられる。** 再帰で剥がすと深さが綴り次第になるので、
    // 外側から順に剥がす反復にしてある（PR #734 の指摘）。
    // **偶数個なら元の値のまま、奇数個で裏返る。**
    const even = '!'.repeat(200);
    expect(findUnboundedLoops(update(`\tfor ${even}true {\n\t}`))).toEqual([FORM_CONSTANT_TRUE]);
    expect(findUnboundedLoops(update(`\tfor ${even}false {\n\t}`))).toEqual([]);
    const odd = '!'.repeat(201);
    expect(findUnboundedLoops(update(`\tfor ${odd}false {\n\t}`))).toEqual([FORM_CONSTANT_TRUE]);
    expect(findUnboundedLoops(update(`\tfor ${odd}true {\n\t}`))).toEqual([]);
  });

  it('条件が上限より長ければ、落ちずに通す', () => {
    // **落ちない**こと（例外にしない）と、**通す**ことの両方を見る。上限を超えたものは
    // 「分からない」であり、この検査の既定の向きは通す側である。
    const tooMany = '!'.repeat(5000);
    expect(findUnboundedLoops(update(`\tfor ${tooMany}true {\n\t}`))).toEqual([]);
  });

  it('入れ子が深くても本体を数え直さない（走査が二乗にならない）', () => {
    // **時間そのものは測らない**（機械の速さで揺れる）。数え直す実装では現実的な
    // 時間で終わらない大きさを通し、**結果が正しいこと**を見る。
    const depth = 2000;
    const body = `${'\tfor {\n'.repeat(depth)}\tg.frame++\n${'\t}\n'.repeat(depth)}`;
    expect(findUnboundedLoops(update(body))).toEqual([FORM_NO_CONDITION]);
  });

  it('条件が長すぎる繰り返しは通す（読む長さに上限がある）', () => {
    // 上限を超えたものは「分からない」＝通す（この検査の既定の向き）。
    const long = Array.from({ length: 300 }, (_, index) => `f${index}() &&`).join(' ');
    expect(findUnboundedLoops(update(`\tfor ${long} true {\n\t}`))).toEqual([]);
  });
});

describe('隔離ビルドのサンプル（acceptance 3）', () => {
  it('`docker/isolated-build/sample/ebitengine.go` を落とさない', () => {
    // **実際にコンパイルが通っているサンプル**であり、プロンプトが教えている書き方の
    // 現物である。これを落とすなら、教えたとおりに書いた作品を落とすということになる。
    // **`textBlobBindings` で渡ってくる**（`vitest.config.ts`）。
    expect(findUnboundedLoops(env.TEST_BUILD_SAMPLE)).toEqual([]);
  });
});

describe('仕様書 6.1 との機械照合（acceptance 4）', () => {
  /**
   * 仕様書 6.1 の表から、拒否する形の**行**を取り出す。
   *
   * 節の終わりは**見出しなら深さを問わず**とする（`#####` の小見出しを足しても、
   * 別の表を巻き込まない）。
   *
   * @returns 仕様書に書かれている形（名前と理由）
   */
  function formsFromSpec(): { readonly name: string; readonly reason: string }[] {
    const spec = env.TEST_PRODUCT_SPEC;
    const start = spec.indexOf(UNBOUNDED_LOOP_SECTION_HEADING);
    expect(start, `仕様書に「${UNBOUNDED_LOOP_SECTION_HEADING}」の節がありません`).toBeGreaterThan(
      -1,
    );
    const rest = spec.slice(start + UNBOUNDED_LOOP_SECTION_HEADING.length);
    const end = rest.search(/\n#{1,6} /u);
    const section = end === -1 ? rest : rest.slice(0, end);
    // **2 列とも取る。** 1 列目だけを比べると、**理由（2 列目）が片側だけ変わっても
    // 通る**（PR #734 の Copilot の指摘）。表はコード側が正なので、行まるごと見る。
    return [...section.matchAll(/^\| `([^`]+)` \| ([^|]+?) \|$/gmu)].map((matched) => ({
      name: matched[1]!,
      reason: matched[2]!,
    }));
  }

  it('仕様書の表がコード側と一致する（名前も理由も）', () => {
    // 一覧の複製は必ず古くなる。**片方だけ変えると赤になる**ことが、この節の狙いである。
    expect(formsFromSpec()).toEqual(
      UNBOUNDED_LOOP_FORMS.map((form) => ({ name: form.name, reason: form.reason })),
    );
  });

  it('仕様書の節が空でない', () => {
    // 上の比較は、節が見つからず両方が空でも通ってしまう。
    expect(formsFromSpec().length).toBeGreaterThan(0);
  });

  it('形の名前に重複が無い', () => {
    const names = UNBOUNDED_LOOP_FORMS.map((form) => form.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('理由が空でない（仕様書の表の 2 列目になる）', () => {
    for (const form of UNBOUNDED_LOOP_FORMS) {
      expect(form.reason.length, form.name).toBeGreaterThan(0);
    }
  });

  it('拒否の理由が 1 つの綴りに決まっている', () => {
    expect(UNBOUNDED_LOOP_REJECTION).toBe('unbounded-loop');
  });
});
