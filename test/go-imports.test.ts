import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_SECTION_HEADING,
  GO_IMPORT_ALLOWLIST,
  renderAllowlistSection,
} from '../src/go-import-allowlist.js';
import { inspectGoImports, scanImports } from '../src/go-imports.js';

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

describe('ホワイトリスト外を拒否する（#17 acceptance 1）', () => {
  it('os/exec を含むソースを拒否する', async () => {
    const result = inspectGoImports(source('import "os/exec"'));
    expect(result.ok).toBe(false);
    expect(result.ok || result.offending).toEqual(['os/exec']);
  });

  it('7.1 が塞いでいる経路のパッケージを拒否する', () => {
    // コンテナ（--network=none / --read-only / 非 root）が塞いでいる先へ到達しようと
    // する典型。明示的に許可しないことに意味がある。
    for (const path of ['os', 'net', 'net/http', 'syscall', 'unsafe', 'embed', 'plugin']) {
      const result = inspectGoImports(source(`import "${path}"`));
      expect(result.ok, path).toBe(false);
    }
  });

  it('6.1 が名指しで禁じている fmt と reflect を拒否する', () => {
    for (const path of ['fmt', 'reflect']) {
      const result = inspectGoImports(source(`import "${path}"`));
      expect(result.ok, path).toBe(false);
    }
  });

  it('cgo（import "C"）を拒否する', () => {
    // CGO_ENABLED=0 なのでビルドでも落ちるが、ビルドサーバへ渡す前に弾く。
    expect(inspectGoImports(source('import "C"')).ok).toBe(false);
  });

  it('許可されたものだけなら通る', () => {
    const result = inspectGoImports(
      source(`import (
	"math"
	"math/rand"

	"github.com/hajimehoshi/ebiten/v2"
	"github.com/hajimehoshi/ebiten/v2/vector"
)`),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.imports).toEqual([
      'math',
      'math/rand',
      'github.com/hajimehoshi/ebiten/v2',
      'github.com/hajimehoshi/ebiten/v2/vector',
    ]);
  });

  it('許可されたものと禁止されたものが混ざっていれば拒否し、違反だけを返す', () => {
    const result = inspectGoImports(
      source(`import (
	"math"
	"os/exec"
	"syscall"
)`),
    );
    expect(result.ok).toBe(false);
    expect(result.ok || result.offending).toEqual(['os/exec', 'syscall']);
  });

  it('明示的なセミコロンで検査を迂回できない', () => {
    // Go の文法は `PackageClause ";" { ImportDecl ";" }` で、セミコロンは通常改行で
    // 自動挿入されるが明示的に書いても正当である。**第二意見が実際に見つけた迂回路**で、
    // 修正前は `{ ok: true, imports: [] }` を返して os/exec を素通ししていた。
    for (const bypass of [
      'package main; import "os/exec"\n',
      'package main\n\nimport "math"; import "os/exec"\n',
      'package main;;; import "syscall"\n',
      'package main\n\nimport (\n\t"math"\n);\nimport "os"\n',
    ]) {
      const result = inspectGoImports(bypass);
      expect(result.ok, bypass).toBe(false);
      expect(result.ok || result.reason, bypass).toBe('not-allowed');
    }
  });

  it('セミコロン区切りでも許可されたものは通る', () => {
    const result = inspectGoImports('package main; import "math"; import "strconv"\n');
    expect(result.ok && result.imports).toEqual(['math', 'strconv']);
  });

  it('import が 1 つも無ければ通る', () => {
    expect(inspectGoImports('package main\n\nfunc main() {}\n').ok).toBe(true);
  });
});

describe('import 宣言の読み取り', () => {
  it('別名・空白識別子・ドット付きを読む', () => {
    const result = scanImports(
      source(`import (
	e "github.com/hajimehoshi/ebiten/v2"
	_ "math/rand"
	. "math"
)`),
    );
    expect(result.ok && result.imports).toEqual([
      'github.com/hajimehoshi/ebiten/v2',
      'math/rand',
      'math',
    ]);
  });

  it('import 宣言が複数あっても読む', () => {
    const result = scanImports(source('import "math"\nimport "strconv"'));
    expect(result.ok && result.imports).toEqual(['math', 'strconv']);
  });

  it('コメントの中の import を拾わない', () => {
    // 正規表現で import を探す実装はここで落ちる。
    const result = scanImports(
      source(`// import "os/exec"
/* import (
	"syscall"
) */
import "math"`),
    );
    expect(result.ok && result.imports).toEqual(['math']);
  });

  it('文字列リテラルの中の import を拾わない', () => {
    const withString = `package main

import "math"

const hint = "import \\"os/exec\\""
const raw = ` + '`import "syscall"`' + `
`;
    const result = scanImports(withString);
    expect(result.ok && result.imports).toEqual(['math']);
  });

  it('import より後ろに現れる import らしき語を拾わない', () => {
    // Go は import を他のすべての宣言より前に置くことを要求する。後ろのものは
    // 宣言ではないので読まない。
    const result = scanImports(`package main

import "math"

func f() {
	x := "import"
	_ = x
}
`);
    expect(result.ok && result.imports).toEqual(['math']);
  });

  it('ビルド制約コメントがあっても package 句を見つける', () => {
    const result = scanImports('//go:build js\n\npackage main\n\nimport "math"\n');
    expect(result.ok && result.imports).toEqual(['math']);
  });

  it('BOM が付いていても読める', () => {
    const result = scanImports('\ufeffpackage main\n\nimport "math"\n');
    expect(result.ok && result.imports).toEqual(['math']);
  });
});

describe('読み取れない入力は通さない', () => {
  it('空のソースを拒否する', () => {
    for (const empty of ['', '   ', '\n\n']) {
      expect(scanImports(empty).ok, JSON.stringify(empty)).toBe(false);
    }
  });

  it('package 句が無ければ拒否する', () => {
    for (const broken of ['import "math"', 'func main() {}', 'package']) {
      expect(scanImports(broken).ok, broken).toBe(false);
    }
  });

  it('閉じない括弧を拒否する', () => {
    // 「解析できなかったので通す」にすると、解析器が知らない書き方がそのまま
    // 迂回路になる。判定に迷ったら拒否する。
    const result = scanImports('package main\n\nimport (\n\t"math"\n');
    expect(result).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('閉じない文字列リテラルを拒否する', () => {
    const result = scanImports('package main\n\nimport "math\n');
    expect(result.ok).toBe(false);
  });

  it('import の後ろが文字列でなければ拒否する', () => {
    for (const broken of ['import 123', 'import (\n\t123\n)', 'import alias']) {
      const result = scanImports(source(broken));
      expect(result.ok, broken).toBe(false);
    }
  });
});

describe('一覧の機械照合（#17 acceptance 2）', () => {
  /**
   * 仕様書 6.1 の表からパッケージ名を取り出す。
   *
   * @returns 仕様書に書かれているパッケージ名
   */
  function allowlistFromSpec(): string[] {
    const spec = env.TEST_PRODUCT_SPEC;
    const start = spec.indexOf(ALLOWLIST_SECTION_HEADING);
    expect(start, `仕様書に「${ALLOWLIST_SECTION_HEADING}」の節がありません`).toBeGreaterThan(-1);
    const rest = spec.slice(start + ALLOWLIST_SECTION_HEADING.length);
    const end = rest.search(/\n#{1,4} /u);
    const section = end === -1 ? rest : rest.slice(0, end);
    return [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((matched) => matched[1]!);
  }

  it('仕様書 6.1 の一覧がコード側と一致する', () => {
    // ずれた瞬間に「プロンプトは許すが検査は落とす」パッケージが生まれ、生成が
    // 理由の分からない失敗を繰り返す。一覧を書き写す以上、機械で照合する。
    expect(allowlistFromSpec()).toEqual(GO_IMPORT_ALLOWLIST.map((entry) => entry.path));
  });

  it('仕様書の節が空でない', () => {
    // 上の比較は、節が見つからず両方が空でも通ってしまう。実体があることを別に見る。
    expect(allowlistFromSpec().length).toBeGreaterThan(0);
  });

  it('プロンプトへ埋め込む一節が一覧を漏れなく含む', () => {
    // M2-2 はこの関数の出力を使う。プロンプトへ手書きすると検査とずれる。
    const rendered = renderAllowlistSection();
    for (const entry of GO_IMPORT_ALLOWLIST) {
      expect(rendered, entry.path).toContain(entry.path);
    }
  });

  it('プロンプトへ埋め込む一節に動的な値が含まれない', () => {
    // 6.1 が定めるとおり、システムプロンプトは prompt caching の共有プレフィックスで
    // あり（4.5）、呼び出しごとに変わる値が入るとキャッシュが効かない。
    expect(renderAllowlistSection()).toBe(renderAllowlistSection());
    expect(renderAllowlistSection()).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/u);
  });

  /**
   * Go のソースから import パスを取り出す。
   *
   * `_ "path"` の形も拾う。vendor 焼き込み用のファイルは全部この形である。
   *
   * @param source Go のソース
   * @returns import パスの配列
   */
  function importsOf(source: string): string[] {
    return [...source.matchAll(/^\t(?:_ )?"([^"]+)"$/gmu)].map((matched) => matched[1]!);
  }

  /** 一覧のうち標準ライブラリでないもの。vendor へ焼き込む対象はこれだけ。 */
  const externalPaths = GO_IMPORT_ALLOWLIST.map((entry) => entry.path).filter((path) =>
    path.split('/')[0]!.includes('.'),
  );

  it('vendor 焼き込みの対象が一覧の外部パッケージと一致する', () => {
    // ずれると「プロンプトと AST 検査は許すが、vendor に無いのでビルドが落ちる」
    // 状態になる。--network=none で回す以上、実行時に取りに行くことはできない。
    expect(importsOf(env.TEST_VENDOR_DEPS).sort()).toEqual([...externalPaths].sort());
  });

  it('隔離ビルドの検査用サンプルが外部パッケージをすべて使う', () => {
    // 標準ライブラリだけのサンプルでは vendor が空でもビルドが通る。焼き込みが
    // 効いているかを見るには、外部パッケージを実際に import する必要がある。
    const sample = importsOf(env.TEST_BUILD_SAMPLE);
    for (const path of externalPaths) {
      expect(sample, path).toContain(path);
    }
  });

  it('標準ライブラリを vendor 焼き込みの対象に含めない', () => {
    // 標準ライブラリは vendor されない。混ぜると go mod vendor が落ちる。
    expect(importsOf(env.TEST_VENDOR_DEPS).every((path) => path.split('/')[0]!.includes('.'))).toBe(
      true,
    );
  });

  it('一覧に重複が無い', () => {
    const paths = GO_IMPORT_ALLOWLIST.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
