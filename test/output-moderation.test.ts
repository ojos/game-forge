import { describe, expect, it } from 'vitest';
import type { DeniedTerm } from '../src/denied-terms.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import { inspectStringLiterals, normalizeForMatching } from '../src/output-moderation.js';

/**
 * 検査の規則を試すための**ダミーの表**（8.3 / #38）。
 *
 * **実在の差別語をこのファイルへ書かない。** 表の中身（`src/denied-terms.ts`）と、
 * 突き合わせの規則（`src/output-moderation.ts`）は別のファイルに分かれており、
 * 規則を試すのに実在の語は 1 つも要らない。実在の語を書き写すと、
 * **表を直した日にテストだけが古い語を持つ**という状態も作る。
 *
 * 既定の表そのものが空でないことは、下の「既定の表」の検査が別に見る。
 */
const DUMMY_TERMS: readonly DeniedTerm[] = [
  // 英字。語一致（前後が文字・数字でないときだけ当たる）。
  { term: 'zzblocked', match: 'word', category: 'discriminatory' },
  // 語の区切りが無い体系。部分一致。
  { term: 'ダミー禁止語', match: 'substring', category: 'discriminatory' },
];

/**
 * `text` 描画を含む Go のソースを組み立てる（確定23 の経路そのもの）。
 *
 * **8.3 が想定しているのはこの形である。** `text/v2` と `basicfont` は 6.1 が許可して
 * おり、生成物は画面へ任意の文字列を出せる。
 *
 * @param body `Draw` の中身に置く行
 * @returns Go のソース
 */
function drawing(body: string): string {
  return `package main

import (
	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/text/v2"
	"golang.org/x/image/font/basicfont"
)

type Game struct{}

func (g *Game) Draw(screen *ebiten.Image) {
	face := text.NewGoXFace(basicfont.Face7x13)
${body}
	_ = face
}
`;
}

/**
 * 文字列を `text.Draw` する 1 行を作る。
 *
 * @param literal Go の文字列リテラル（引用符を含む）
 * @returns Go の 1 行
 */
function draw(literal: string): string {
  return `	text.Draw(screen, ${literal}, face, nil)`;
}

/**
 * 語に当たって落ちたときの結果。
 *
 * **`ok` が false であることだけを見ない。** 読み取りに失敗した（`unparsable`）ときも
 * false になるので、**検査が語を見つけていないのに緑になる**。実際、ルーンリテラルの
 * 読み取りを外す変異で、この 2 つを区別しないテストが緑のまま通った。
 */
const DENIED = { ok: false, reason: 'denied-term', categories: ['discriminatory'] } as const;

describe('文字列リテラルの NG ワード検査（8.3 / #38）', () => {
  it('表に無い語しか出さないソースは通る', () => {
    const inspection = inspectStringLiterals(drawing(draw('"SCORE: 100"')), DUMMY_TERMS);
    expect(inspection.ok).toBe(true);
  });

  it('禁止語を text 描画するソースを検出する（acceptance）', () => {
    const inspection = inspectStringLiterals(drawing(draw('"ダミー禁止語だ"')), DUMMY_TERMS);
    expect(inspection).toEqual({ ok: false, reason: 'denied-term', categories: ['discriminatory'] });
  });

  it('当たった語そのものは返さない（表を引き出す口にしない）', () => {
    const inspection = inspectStringLiterals(drawing(draw('"ダミー禁止語だ"')), DUMMY_TERMS);
    expect(JSON.stringify(inspection)).not.toContain('ダミー禁止語');
  });

  it('コメントの中の語は拾わない', () => {
    // 画面へ出るのは文字列リテラルであってコメントではない。字句解析が
    // コメントを飛ばしていることを、ここで確かめる。
    const inspection = inspectStringLiterals(
      drawing(`	// ダミー禁止語 zzblocked\n${draw('"SCORE"')}`),
      DUMMY_TERMS,
    );
    expect(inspection.ok).toBe(true);
  });

  it('生文字列（バッククォート）の中の語も拾う', () => {
    const inspection = inspectStringLiterals(
      drawing(draw('`ダミー禁止語`')),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual(DENIED);
  });

  it('エスケープで綴った語を拾う', () => {
    // Go の `\u007A` は `z`。展開しないと、綴りをエスケープで書くだけで抜けられる。
    const inspection = inspectStringLiterals(drawing(draw('"\\u007Azblocked"')), DUMMY_TERMS);
    expect(inspection).toEqual(DENIED);
  });

  it('生文字列ではエスケープを展開しない', () => {
    // 生文字列の中の `\u007A` は 6 文字ぶんの綴りであって `z` ではない。
    // 展開してしまうと、画面に出ない語で拒否することになる。
    const inspection = inspectStringLiterals(drawing(draw('`\\u007Azblocked`')), DUMMY_TERMS);
    expect(inspection.ok).toBe(true);
  });

  it('全角と大文字を畳んで拾う', () => {
    const inspection = inspectStringLiterals(drawing(draw('"ＺＺＢＬＯＣＫＥＤ"')), DUMMY_TERMS);
    expect(inspection).toEqual(DENIED);
  });

  it('不可視文字を挟んだ語を拾う', () => {
    // U+200B（ゼロ幅スペース）を**生の文字として**含む生文字列。NFKC は落とさないので、
    // 正規化のあとで消している。消さないと、1 文字挟むだけで検査を抜けられる。
    const inspection = inspectStringLiterals(
      drawing(draw('`zz\u200Bblocked`')),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual(DENIED);
  });

  it('不可視文字をエスケープで挟んだ語も拾う', () => {
    const inspection = inspectStringLiterals(
      drawing(draw('"zz\\u200Bblocked"')),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual(DENIED);
  });

  it('語一致は無関係な語の中の綴りを拾わない', () => {
    // 誤検出は「作れたはずのゲームが作れない」であり、枠と費用が消える（4.3 / 4.2）。
    const inspection = inspectStringLiterals(drawing(draw('"unzzblockedly"')), DUMMY_TERMS);
    expect(inspection.ok).toBe(true);
  });

  it('語一致は記号で区切られた語を拾う', () => {
    const inspection = inspectStringLiterals(drawing(draw('"GAME OVER: zzblocked!"')), DUMMY_TERMS);
    expect(inspection).toEqual(DENIED);
  });

  it('部分一致は日本語の途中にある語を拾う', () => {
    const inspection = inspectStringLiterals(drawing(draw('"これはダミー禁止語です"')), DUMMY_TERMS);
    expect(inspection).toEqual(DENIED);
  });

  it('ルーンリテラルの中の引用符で走査がずれない', () => {
    // `'"'` は正当な Go である。1 文字ずつ読むと、その中の引用符から文字列が
    // 始まったことになり、**その先の文字列リテラルを丸ごと読み落とす**
    // （`findDeniedDirectives` が同じ理由でルーンを明示的に飛ばしている）。
    const inspection = inspectStringLiterals(
      drawing(`	quote := '"'\n	_ = quote\n${draw('"ダミー禁止語"')}`),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual(DENIED);
  });

  it('ルーンリテラルの中のバッククォートで走査がずれない', () => {
    const inspection = inspectStringLiterals(
      drawing("\tquote := '`'\n\t_ = quote\n" + draw('"ダミー禁止語"')),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual(DENIED);
  });

  it('閉じないリテラルは「見つからなかった」ではなく拒否になる', () => {
    // 打ち切って通すと、閉じない引用符を 1 つ置くだけで以降の文字列を隠せる。
    const inspection = inspectStringLiterals(
      drawing(`	broken := "開いたまま\n${draw('"ダミー禁止語"')}`),
      DUMMY_TERMS,
    );
    expect(inspection).toEqual({ ok: false, reason: 'unparsable', categories: [] });
  });

  it('空の語が表に紛れても全件拒否にしない', () => {
    const withEmpty: readonly DeniedTerm[] = [
      { term: '', match: 'substring', category: 'discriminatory' },
    ];
    expect(inspectStringLiterals(drawing(draw('"SCORE"')), withEmpty).ok).toBe(true);
  });

  it('正規表現で特別な意味を持つ文字を含む語を、そのまま突き合わせる', () => {
    const symbolic: readonly DeniedTerm[] = [
      { term: 'a.c', match: 'word', category: 'discriminatory' },
    ];
    // 打ち消していなければ `.` が任意の 1 文字に当たり、`abc` を拾ってしまう。
    expect(inspectStringLiterals(drawing(draw('"abc"')), symbolic).ok).toBe(true);
    expect(inspectStringLiterals(drawing(draw('"a.c"')), symbolic).ok).toBe(false);
  });
});

describe('正規化（8.3 / #38）', () => {
  it('表の語にも入力にも同じ正規化を掛けられる', () => {
    // 片側にだけ掛けると、表に全角で書いた語が半角の入力に当たらない。
    expect(normalizeForMatching('ＡＢＣ', true)).toBe(normalizeForMatching('abc', true));
  });

  it('生文字列かどうかでエスケープの扱いが変わる', () => {
    expect(normalizeForMatching('\\u3042', false)).toBe('あ');
    expect(normalizeForMatching('\\u3042', true)).toBe('\\u3042');
  });

  it('読めないエスケープは後ろの 1 文字を残す', () => {
    // ここで例外にすると、検査の対象でない書き間違いが 422 になる。
    expect(normalizeForMatching('\\q', false)).toBe('q');
    expect(normalizeForMatching('\\u00', false)).toBe('u00');
  });

  it('符号位置の範囲外でも投げない', () => {
    expect(() => normalizeForMatching('\\U0011FFFF', false)).not.toThrow();
  });
});

describe('既定の表（8.3 / #38）', () => {
  it('空ではない', () => {
    // **空の表は「検査が緑を返すのに何も見ていない」状態そのものである。**
    // 引き継ぎ 4 章「確かめていない検査は、確かめた証拠として読まれるぶん赤より悪い」。
    expect(DENIED_TERMS.length).toBeGreaterThan(0);
  });

  it('すべての語に分類が付いている', () => {
    expect(DENIED_TERMS.length).toBeGreaterThan(0);
    for (const term of DENIED_TERMS) {
      expect(term.category).toBe('discriminatory');
      expect(term.term).not.toBe('');
    }
  });

  it('正規化しても消えない語だけが並んでいる', () => {
    // 不可視文字だけの語や、正規化で空になる語は**すべてのリテラルに当たる**ため
    // `inspectStringLiterals` が捨てる。捨てられる語が表にあると、足したつもりの
    // 語が黙って効かない。
    expect(DENIED_TERMS.length).toBeGreaterThan(0);
    for (const term of DENIED_TERMS) {
      expect(normalizeForMatching(term.term, true)).not.toBe('');
    }
  });

  it('既定の表に載っている語を text 描画するソースを拒否する', () => {
    // **語をこのファイルへ書き写さない。** 表から引いて組み立てる。書き写すと、
    // 表を直した日にテストだけが古い語を持つ。
    //
    // **件数を先に見る**（空の表では for が 1 度も回らず、何も確かめずに緑になる）。
    expect(DENIED_TERMS.length).toBeGreaterThan(0);
    for (const term of DENIED_TERMS) {
      const inspection = inspectStringLiterals(drawing(draw(`"${term.term}"`)));
      expect(inspection, `表の語が当たらない: index ${DENIED_TERMS.indexOf(term)}`).toEqual(
        DENIED,
      );
    }
  });
});
