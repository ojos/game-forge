import { describe, expect, it } from 'vitest';
import {
  CHAT_MARKDOWN_SCRIPT,
  CHAT_MARKDOWN_SPEC,
  buildChatMarkdown,
  chatMarkdownHelperLines,
  parseChatMarkdown,
  renderChatMarkdownHtml,
  type ChatMarkdownDocument,
  type ChatMarkdownElement,
  type ChatMarkdownNode,
} from '../src/chat-markdown.js';
import { escapeHtml } from '../src/html.js';

/**
 * チャットの返答を Markdown として描く（#739 / M21-3。仕様 5.16 の Markdown の小節）。
 *
 * **記法ごとに 1 つずつ**（acceptance）と、**名指しの例外 2 つ**（リンクは `http` / `https` だけ・
 * 画像は `<img>` にしない）、**落とさない・止まらない**、**2 つの描き方が同じ木から同じ構造を作る**こと、
 * **ブラウザへ埋め込む本文が外の名前に頼らない**ことを見る。
 */

/** コードの記号（テンプレート文字列の中へ直に書かない）。 */
const BT = String.fromCharCode(96);

/** 解析して、サーバの描き方で HTML にする。 */
function html(source: string): string {
  return renderChatMarkdownHtml(parseChatMarkdown(source));
}

/** 木に出てくるタグを全部集める。 */
function tagsOf(nodes: readonly ChatMarkdownNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'string') {
      out.push(node.tag, ...tagsOf(node.children));
    }
  }
  return out;
}

/** 木の文字だけをつなぐ（`<br>` は改行）。 */
function textOf(nodes: readonly ChatMarkdownNode[]): string {
  return nodes
    .map((node) => (typeof node === 'string' ? node : node.tag === 'br' ? '\n' : textOf(node.children)))
    .join('');
}

/** `<a>` の `href` を全部集める。 */
function hrefsOf(nodes: readonly ChatMarkdownNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'string') {
      if (node.tag === 'a' && node.attrs.href !== undefined) {
        out.push(node.attrs.href);
      }
      out.push(...hrefsOf(node.children));
    }
  }
  return out;
}

/** ブラウザの `document` の代わり（組んだ結果を HTML の文字列へ戻せる最小のもの）。 */
interface FakeNode {
  readonly kind: 'element' | 'text';
  readonly tag: string;
  readonly text: string;
  readonly attrs: [string, string][];
  readonly children: FakeNode[];
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeNode): FakeNode;
}

/** 呼ばれた API を数える `document`。 */
function fakeDocument(calls: string[]): ChatMarkdownDocument<FakeNode> {
  const make = (kind: 'element' | 'text', tag: string, text: string): FakeNode => {
    const node: FakeNode = {
      kind,
      tag,
      text,
      attrs: [],
      children: [],
      setAttribute(name, value) {
        calls.push('setAttribute');
        const at = node.attrs.findIndex(([existing]) => existing === name);
        if (at >= 0) {
          node.attrs[at] = [name, value];
        } else {
          node.attrs.push([name, value]);
        }
      },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
    };
    return node;
  };
  return {
    createElement(tag) {
      calls.push('createElement');
      return make('element', tag, '');
    },
    createTextNode(text) {
      calls.push('createTextNode');
      return make('text', '', text);
    },
  };
}

/** 組んだ DOM を HTML の文字列へ戻す（ブラウザが `outerHTML` で返すのと同じ形）。 */
function serialize(nodes: readonly FakeNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') {
        return escapeHtml(node.text);
      }
      const attrs = node.attrs.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
      return CHAT_MARKDOWN_SPEC.voids.includes(node.tag)
        ? `<${node.tag}${attrs}>`
        : `<${node.tag}${attrs}>${serialize(node.children)}</${node.tag}>`;
    })
    .join('');
}

/** ブラウザの描き方で組んで、HTML の文字列へ戻す。 */
function built(nodes: readonly ChatMarkdownNode[], calls: string[] = []): string {
  const doc = fakeDocument(calls);
  const root = doc.createElement('div');
  buildChatMarkdown(root, nodes, doc, CHAT_MARKDOWN_SPEC);
  return serialize(root.children);
}

/** 記法を一通り含む返答（実際の返答に近い形）。 */
const CORPUS: readonly string[] = [
  '# 見出し\n\n段落の**強調**と*斜体*と~~取り消し~~と' + BT + 'code' + BT + '。\n2 行目',
  '## 小見出し ##\n### 三\n#### 四\n##### 五\n###### 六',
  'タイトル\n===\n\n副題\n---',
  '- a\n- b\n  - c\n    - d\n- e',
  '1. x\n2. y\n\n3. z',
  '3) 三\n4) 四',
  '* 一\n+ 別の箇条書き',
  BT.repeat(3) + 'go\nfunc main() {\n\n}\n' + BT.repeat(3),
  '~~~\n' + BT.repeat(3) + ' の中\n~~~',
  '    字下げの\n    コード',
  '> 引用\n> 続き\n>\n> - 中の箇条書き',
  '| 列 | 右 | 中 |\n|:--|--:|:-:|\n| 1 | 2 | 3 |\n| a \\| b | ' + BT + 'c' + BT + ' |',
  '上\n\n---\n\n下\n\n***\n\n___',
  '[ok](https://example.com/a?b=1&c=2) [ng](javascript:alert(1)) <https://example.com> ![alt](https://example.com/x.png)',
  '以下です:\n| a | b |\n|---|---|\n| 1 | 2 |\n\n【指示文】\nシューティングを作ってください。',
  '<img src=x onerror=alert(1)> と <script>alert(1)</script> と & と "',
  '**閉じない強調 と [閉じないリンク](https://example.com と ' + BT + '閉じないコード',
  '\\*エスケープ\\* と \\[括弧\\] と snake_case_name と 2*3*4',
  '',
  '   \n\n  ',
  '- \n- 空の項目',
  '***太字の斜体***',
];

describe('記法ごとに描く（#739 の acceptance）', () => {
  it('見出し——`#` は `<h3>` から始まり、`######` は `<h6>` で止まる（区画の見出しが `<h2>` のため）', () => {
    expect(html('# 一')).toBe('<h3>一</h3>');
    expect(html('## 二 ##')).toBe('<h4>二</h4>');
    expect(html('### 三')).toBe('<h5>三</h5>');
    expect(html('###### 六')).toBe('<h6>六</h6>');
    expect(html('#タグ')).toBe('<p>#タグ</p>');
    expect(html('####### 七')).toBe('<p>####### 七</p>');
  });

  it('見出し——下線の形（setext）', () => {
    expect(html('大\n===')).toBe('<h3>大</h3>');
    expect(html('中\n---')).toBe('<h4>中</h4>');
  });

  it('段落——空行で分け、段落の中の改行は `<br>` にする', () => {
    expect(html('一行目\n二行目\n\n次の段落')).toBe('<p>一行目<br>二行目</p><p>次の段落</p>');
  });

  it('箇条書き（順序なし）——入れ子も描く', () => {
    expect(html('- a\n- b\n  - c\n- d')).toBe('<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
    expect(html('* 一\n* 二')).toBe('<ul><li>一</li><li>二</li></ul>');
  });

  it('箇条書き（順序つき）——1 以外から始まるなら `start` を付ける', () => {
    expect(html('1. x\n2. y')).toBe('<ol><li>x</li><li>y</li></ol>');
    expect(html('3) 三\n4) 四')).toBe('<ol start="3"><li>三</li><li>四</li></ol>');
    // 項目の間に空行があれば、各項目は段落になる（loose）。
    expect(html('1. x\n\n2. y')).toBe('<ol><li><p>x</p></li><li><p>y</p></li></ol>');
  });

  it('強調・斜体・取り消し線', () => {
    expect(html('**太** と __太__')).toBe('<p><strong>太</strong> と <strong>太</strong></p>');
    expect(html('*斜* と _斜_')).toBe('<p><em>斜</em> と <em>斜</em></p>');
    expect(html('~~消~~')).toBe('<p><del>消</del></p>');
    expect(html('***両方***')).toBe('<p><em><strong>両方</strong></em></p>');
    expect(html('**太字の中の *斜体***')).toBe('<p><strong>太字の中の <em>斜体</em></strong></p>');
    expect(html('*a **b** c*')).toBe('<p><em>a <strong>b</strong> c</em></p>');
    // 語の中の `_` は強調にしない（識別子がそのまま出る）。
    expect(html('snake_case_name')).toBe('<p>snake_case_name</p>');
  });

  it('インラインコード——中の記号は解釈しない', () => {
    expect(html(`${BT}**a** <b>${BT}`)).toBe('<p><code>**a** &lt;b&gt;</code></p>');
    expect(html(`${BT.repeat(2)} a${BT}b ${BT.repeat(2)}`)).toBe(`<p><code>a${BT}b</code></p>`);
  });

  it('コードブロック——フェンス・チルダ・字下げ。中の記号は解釈しない', () => {
    expect(html(`${BT.repeat(3)}go\nfunc main() {\n  # no\n}\n${BT.repeat(3)}`)).toBe(
      '<pre><code>func main() {\n  # no\n}</code></pre>',
    );
    expect(html(`~~~\n${BT.repeat(3)}\n~~~`)).toBe(`<pre><code>${BT.repeat(3)}</code></pre>`);
    expect(html('    a\n      b')).toBe('<pre><code>a\n  b</code></pre>');
    // 閉じないフェンスは、終わりまでをコードにする（CommonMark と同じ）。本文は落とさない。
    expect(html(`${BT.repeat(3)}\n閉じない\n- x`)).toBe('<pre><code>閉じない\n- x</code></pre>');
  });

  it('引用——中身もブロックとして読む', () => {
    expect(html('> 引用\n> 続き')).toBe('<blockquote><p>引用<br>続き</p></blockquote>');
    expect(html('> # 見出し\n>\n> - 項目')).toBe('<blockquote><h3>見出し</h3><ul><li>項目</li></ul></blockquote>');
  });

  it('表——揃えはクラスで持ち、セルの中の `\\|` は区切りにしない', () => {
    expect(html('| a | b | c |\n|:--|--:|:-:|\n| 1 | x \\| y | **3** |')).toBe(
      '<table><thead><tr><th class="gf-md-left">a</th><th class="gf-md-right">b</th><th class="gf-md-center">c</th></tr></thead>' +
        '<tbody><tr><td class="gf-md-left">1</td><td class="gf-md-right">x | y</td><td class="gf-md-center"><strong>3</strong></td></tr></tbody></table>',
    );
    // 段落の直後に空行なしで始まる表も拾う（返答によく出る形）。
    expect(html('表です:\n| a |\n|---|\n| 1 |')).toBe(
      '<p>表です:</p><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    );
    // 区切りの行と列の数が合わないものは表にしない（文字のまま）。
    expect(html('| a | b |\n|---|')).toBe('<p>| a | b |<br>|---|</p>');
  });

  it('表は空行か別のブロックで終わる——GFM 4.10 の例 202（PR #756 の Copilot の指摘を却下した根拠）', () => {
    // **`|` の無い行も、空行の前なら表の行になる**（GFM 4.10「The table is broken at the first empty line,
    // or beginning of another block-level structure」）。欠けたセルは空の `<td>` になる。空行の後は段落へ戻る。
    expect(html('| abc | def |\n| --- | --- |\n| bar | baz |\nbar\n\nbar')).toBe(
      '<table><thead><tr><th>abc</th><th>def</th></tr></thead>' +
        '<tbody><tr><td>bar</td><td>baz</td></tr><tr><td>bar</td><td></td></tr></tbody></table><p>bar</p>',
    );
  });

  it('水平線——`---` / `***` / `___`', () => {
    expect(html('---')).toBe('<hr>');
    expect(html('* * *')).toBe('<hr>');
    expect(html('___')).toBe('<hr>');
  });

  it('リンク——`http` / `https` は `<a>` にし、`rel="noopener noreferrer"` を付ける', () => {
    expect(html('[例](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">例</a></p>',
    );
    expect(html('[**太い**](http://example.com "題")')).toBe(
      '<p><a href="http://example.com" rel="noopener noreferrer"><strong>太い</strong></a></p>',
    );
    expect(html('<https://example.com>')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">https://example.com</a></p>',
    );
    // リンクの中にリンクは作らない。
    expect(tagsOf(parseChatMarkdown('[[内](https://a.example)](https://b.example)')).filter((tag) => tag === 'a')).toHaveLength(1);
  });

  it('生の HTML は解釈せず、文字として出す', () => {
    const out = html('<img src=x onerror=alert(1)> と <script>alert(1)</script>');
    expect(out).toBe('<p>&lt;img src=x onerror=alert(1)&gt; と &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('バックスラッシュのエスケープ', () => {
    expect(html('\\*a\\* \\# \\[b\\]')).toBe('<p>*a* # [b]</p>');
  });
});

describe('名指しの例外 2 つ（仕様 5.16 / 8.3 の #737 注記）', () => {
  const REJECTED = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'javascript&#58;alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/',
    '/relative',
    'https:evil.example',
    'mailto:a@example.com',
    '<javascript:alert(1)>',
    'https://ok.example/"onmouseover="alert(1)',
  ];

  it('`javascript:` と `data:` ほか、`http` / `https` 以外は押せる形（`<a href>`）にならない', () => {
    for (const url of REJECTED) {
      const tree = parseChatMarkdown(`[押す](${url})`);
      expect(hrefsOf(tree), url).toEqual([]);
      expect(html(`[押す](${url})`), url).not.toContain('<a');
      // **押せないリンクは、書かれた記法のまま文字で出る**（落とさない）。
      expect(textOf(tree), url).toContain('押す');
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x']) {
      expect(html(`<${url}>`)).not.toContain('<a');
    }
  });

  it('`http` / `https` は大文字でも通す', () => {
    expect(hrefsOf(parseChatMarkdown('[a](HTTPS://EXAMPLE.COM) [b](Http://example.com)'))).toEqual([
      'HTTPS://EXAMPLE.COM',
      'Http://example.com',
    ]);
  });

  it('画像の記法は `<img>` を作らず、代替テキストと URL を文字で出す', () => {
    for (const source of [
      '![猫の絵](https://example.com/cat.png)',
      '![](https://example.com/x.png)',
      '![x](javascript:alert(1))',
      '[![入れ子](https://example.com/i.png)](https://example.com)',
    ]) {
      const tree = parseChatMarkdown(source);
      expect(tagsOf(tree), source).not.toContain('img');
      expect(html(source), source).not.toMatch(/<img/iu);
    }
    expect(html('![猫の絵](https://example.com/cat.png)')).toBe(
      '<p><span class="gf-md-image">[画像: 猫の絵] https://example.com/cat.png</span></p>',
    );
    // 画像の URL は押せる形にもしない。
    expect(hrefsOf(parseChatMarkdown('![猫](https://example.com/cat.png)'))).toEqual([]);
  });

  it('表に無いタグ・属性は、どちらの描き方でも出さない（解析器に穴があっても通さない二重の線）', () => {
    const crafted: ChatMarkdownNode[] = [
      { tag: 'img' as ChatMarkdownElement['tag'], attrs: { src: 'https://evil.example/x.png' }, children: ['画像'] },
      { tag: 'script' as ChatMarkdownElement['tag'], attrs: {}, children: ['alert(1)'] },
      { tag: 'a', attrs: { href: 'javascript:alert(1)', onclick: 'alert(1)', rel: 'opener' }, children: ['押す'] },
      { tag: 'a', attrs: { href: 'https://ok.example', rel: 'opener', target: '_blank' }, children: ['良い'] },
      { tag: 'p', attrs: { style: 'color:red', onclick: 'alert(1)' }, children: ['段落'] },
    ];
    const expected = '画像alert(1)<a>押す</a><a href="https://ok.example" rel="noopener noreferrer">良い</a><p>段落</p>';
    expect(renderChatMarkdownHtml(crafted)).toBe(expected);
    expect(built(crafted)).toBe(expected);
  });
});

describe('落とさない・止まらない（仕様 5.16「解析器そのものが穴になりうる」）', () => {
  it('解析できない記法は、そのままの文字として出る', () => {
    for (const source of [
      '**閉じない強調',
      '[閉じないリンク](https://example.com',
      `${BT}閉じないコード`,
      '~~閉じない取り消し',
      '[ラベルだけ]',
      '![画像の記法だけ]',
      '<div>生の HTML</div>',
      '| 表のようで | 表でない |',
    ]) {
      expect(textOf(parseChatMarkdown(source)), source).toBe(source);
    }
  });

  it('どんな入力でも例外を投げず、ブロックの並びを返す', () => {
    // 記号だけを混ぜた入力を決まった種で作る（毎回同じものを見る）。
    const alphabet = ['*', '_', '~', BT, '[', ']', '(', ')', '!', '<', '>', '#', '-', '+', '|', ':', '\\', '\n', ' ', '\t', '1.', 'a', 'あ', 'https://x.example', '='];
    let seed = 739;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      let source = '';
      const length = next() % 120;
      for (let k = 0; k < length; k += 1) {
        source += alphabet[next() % alphabet.length];
      }
      const tree = parseChatMarkdown(source);
      expect(Array.isArray(tree)).toBe(true);
      expect(() => renderChatMarkdownHtml(tree)).not.toThrow();
      expect(() => built(tree)).not.toThrow();
      expect(tagsOf(tree)).not.toContain('img');
    }
    // 文字列でないものが来ても止まらない（型の外から呼ばれたとき）。
    expect(() => parseChatMarkdown(undefined as unknown as string)).not.toThrow();
  });

  it('記号が大量に並んでも、探索が膨らまずに終わる（二乗にならない）', () => {
    const inputs = [
      '*'.repeat(20000),
      '*a'.repeat(10000),
      '_a '.repeat(8000),
      '['.repeat(20000),
      '![x]('.repeat(5000),
      BT.repeat(20000),
      `${BT}a`.repeat(10000),
      '~~a'.repeat(8000),
      '>'.repeat(5000) + ' 深い',
      '- '.repeat(2000) + '深い',
      '| a '.repeat(3000) + '\n' + '|---'.repeat(3000),
    ];
    for (const source of inputs) {
      const started = Date.now();
      const tree = parseChatMarkdown(source);
      expect(Date.now() - started, source.slice(0, 20)).toBeLessThan(1500);
      expect(tree.length).toBeGreaterThan(0);
    }
  });

  it('入れ子が深すぎる入力は、深さの上限から先を文字として出す（落とさない）', () => {
    const tree = parseChatMarkdown('>'.repeat(50) + ' 深い');
    expect(textOf(tree)).toContain('深い');
    const list = parseChatMarkdown('- '.repeat(50) + '深い');
    expect(textOf(list)).toContain('深い');
  });
});

describe('描き方は 2 つ、解析器は 1 つ', () => {
  it('サーバの描き方とブラウザの描き方が、同じ木から同じ構造を作る', () => {
    for (const source of CORPUS) {
      const tree = parseChatMarkdown(source);
      expect(built(tree), source).toBe(renderChatMarkdownHtml(tree));
    }
  });

  it('ブラウザの描き方は、要素・文字・属性を作る API だけを呼ぶ', () => {
    const calls: string[] = [];
    for (const source of CORPUS) {
      built(parseChatMarkdown(source), calls);
    }
    expect(new Set(calls)).toEqual(new Set(['createElement', 'createTextNode', 'setAttribute']));
  });

  it('ブラウザへ埋め込む本文は、何も無い場所で走り、TypeScript 側と同じ木を返す', () => {
    // **`new Function` の中は、グローバルのほかに何も見えない。** 本文が外の名前（モジュールの定数や
    // import）を 1 つでも参照していれば、ここで ReferenceError になる。
    const api = new Function(`${CHAT_MARKDOWN_SCRIPT}\nreturn { parse: parseChatMarkdown, build: buildChatMarkdown, spec: CHAT_MARKDOWN_SPEC };`)() as {
      parse: typeof parseChatMarkdown;
      build: typeof buildChatMarkdown;
      spec: typeof CHAT_MARKDOWN_SPEC;
    };
    expect(api.spec).toEqual(CHAT_MARKDOWN_SPEC);
    for (const source of CORPUS) {
      const tree = api.parse(source);
      expect(tree, source).toEqual(parseChatMarkdown(source));
      const doc = fakeDocument([]);
      const root = doc.createElement('div');
      api.build(root, tree, doc, api.spec);
      expect(serialize(root.children), source).toBe(renderChatMarkdownHtml(tree));
    }
  });

  it('配る束の `keep_names` が差し込む `__name(...)` を、何もせず受ける', () => {
    // **wrangler は入れ子の関数ごとに `__name(fn, "fn")` を本文へ差し込む**（2026-09-21 に実測。
    // `src/chat-markdown.ts` の冒頭）。本文だけを取り出したときに未定義にならないよう、スクリプトの
    // 先頭で定義している。**渡したものをそのまま返すこと**（式の中で使われるため）。
    const passthrough = new Function(
      `${CHAT_MARKDOWN_SCRIPT}\nvar f = function () { return 1; };\nreturn __name(f, 'f') === f && typeof __name(function () {}, 'g') === 'function';`,
    )() as boolean;
    expect(passthrough).toBe(true);
    expect(CHAT_MARKDOWN_SCRIPT.split('\n')[0]).toContain('var __name = function (target) { return target; };');
  });

  it('束が補助を改名しても（`__name2` など）、本文に現れた名前をすべて定義する', () => {
    // **`wrangler pages dev` の束では、wrangler 自身の包みが先に `__name` を定義するので、このモジュールの
    // 側は `__name2` に改名される**（2026-09-21 に実ブラウザで実測。固定の `__name` だけでは `append()` の中で
    // ReferenceError になり、`.catch` に呑まれて「チャットできませんでした」だけが出た）。
    const body = [
      'function parse(source) {',
      '  function inner(a) { return a + 1; }',
      '  __name2(inner, "inner");',
      '  const arrow = /* @__PURE__ */ __name3((x) => x * 2, "arrow");',
      '  return arrow(inner(source));',
      '}',
    ].join('\n');
    const lines = chatMarkdownHelperLines([body]);
    expect(lines).toEqual([
      'var __name = function (target) { return target; };',
      'var __name2 = function (target) { return target; };',
      'var __name3 = function (target) { return target; };',
    ]);
    const parse = new Function(`${lines.join('\n')}\n${body}\nreturn parse;`)() as (value: number) => number;
    expect(parse(1)).toBe(4);
    // 本文に補助が無くても `__name` は定義する（何もしないので害は無い）。
    expect(chatMarkdownHelperLines(['function f() {}'])).toEqual(['var __name = function (target) { return target; };']);
  });

  it('埋め込む本文は、HTML の文字列を解釈させる API と、枠の額の語を持たない', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'eval(']) {
      expect(CHAT_MARKDOWN_SCRIPT, forbidden).not.toContain(forbidden);
    }
    // **チャットのスクリプトへ入るので、円もトークンも書かない**（#751。`test/cost-alert.test.ts`）。
    expect(CHAT_MARKDOWN_SCRIPT).not.toContain('円');
    expect(CHAT_MARKDOWN_SCRIPT).not.toContain('トークン');
    expect(() => new Function(CHAT_MARKDOWN_SCRIPT)).not.toThrow();
  });
});
