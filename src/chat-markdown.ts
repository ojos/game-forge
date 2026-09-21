/**
 * チャットの返答を Markdown として描く（#739 / M21-3。仕様 5.16「仕上げの 6 つの決定」の Markdown の小節）。
 *
 * ## 形——解析器は 1 つ、描く側は 2 つ
 *
 * **解析の規則はこのファイルの `parseChatMarkdown` だけが持つ。** 返すのは「描く要素の木」
 * （タグ名・属性・子）で、**描く側はその木を機械的に写すだけ**である。
 *
 * - **サーバ**（`renderChatMarkdownHtml`）: 復元した会話を HTML の文字列で描く。本文も属性値も
 *   `escapeHtml` を通す。
 * - **ブラウザ**（`buildChatMarkdown`）: 往復のたびに足す返答を、`createElement` と
 *   `createTextNode` / `setAttribute` だけで組む。**HTML の文字列を解釈させる API は使わない。**
 *
 * **2 か所に規則を書き写さない**——片方だけが古くなると、再読み込みの前後で同じ返答が違って見える
 * （仕様 5.16「2 か所に置くと、片方だけが古くなる」）。
 *
 * ## ブラウザへは関数の本文をそのまま渡す
 *
 * チャットのスクリプトはビルド工程を通らずブラウザへ届く（`src/chat-section.ts`）。そこで
 * **`parseChatMarkdown` と `buildChatMarkdown` の本文を `Function.prototype.toString` で取り出し、
 * スクリプトへ埋め込む**（`CHAT_MARKDOWN_SCRIPT`）。外部のライブラリは入れない。
 *
 * このため、**この 2 つの関数は自分の外の名前を 1 つも参照しない**（モジュールの定数も、ほかの関数も、
 * import したものも使わない）。使えば、ブラウザでは未定義の名前になる。`test/chat-markdown.test.ts`
 * が、埋め込んだ文字列だけを何も無い場所で走らせ、TypeScript 側と同じ木を返すことを見る。
 *
 * **配る束は wrangler（esbuild）の `keep_names` で組まれ、入れ子の関数ごとに `__name(...)` の
 * 呼び出しが本文へ差し込まれる**（2026-09-21 に `wrangler pages functions build` の出力で実測）。
 * 本文だけを取り出すと補助が未定義になるので、**スクリプトの先頭で何もしない補助を定義しておく**
 * （`chatMarkdownHelperLines`）。**補助の名前は束ごとに変わる**（`wrangler pages dev` では `__name2`）ので、
 * 決め打ちせず本文から拾う。
 *
 * ## 名指しの例外 2 つ（仕様 5.16 / 8.3 の #737 注記）
 *
 * | 記法 | どうする |
 * |---|---|
 * | **リンク** | **`http` / `https` だけを `<a>` にする**（`rel="noopener noreferrer"`）。それ以外は元の記法のまま文字で出す |
 * | **画像** | **`<img>` にしない。** 代替テキストと URL を文字で出す（`<span>` の中の文字） |
 *
 * **例外はこの 2 つだけ**で、ほかの記法は文字を要素で囲むだけである。描く側でも、**許した
 * タグと属性の表（`CHAT_MARKDOWN_SPEC`）に無いものは出さず、`href` はもう一度スキームを確かめる**
 * （解析器に穴があっても、押せる `javascript:` にはならない二重の線）。
 *
 * ## 落とさない・止まらない
 *
 * **解析器そのものが穴になりうる**（仕様 5.16）。解析できない記法は**そのままの文字**として残し、
 * **例外は外へ投げない**（中で起きたら、全文を 1 つの段落の文字として返す）。入れ子の深さと、
 * 括弧を探す距離には上限を置き、長い入力で探索が二乗に膨らまないようにしている。
 *
 * ## 送る本文は描いた後の文字ではない
 *
 * **この木は表示のためだけのもの**である。エッジへ送る会話と下書きの取り出しは、**描く前の元の文字列**
 * から読む（`src/chat-section.ts` の `history()` / `draft()`）。描いた後の文字を読むと、送る会話が
 * 記号の落ちた別の文字列に化ける。
 */
import { escapeHtml } from './html.js';

/** 描く要素のタグ名（`CHAT_MARKDOWN_SPEC.tags` のキーと一致する）。 */
export type ChatMarkdownTag =
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'p'
  | 'ul'
  | 'ol'
  | 'li'
  | 'pre'
  | 'code'
  | 'blockquote'
  | 'table'
  | 'thead'
  | 'tbody'
  | 'tr'
  | 'th'
  | 'td'
  | 'hr'
  | 'br'
  | 'strong'
  | 'em'
  | 'del'
  | 'a'
  | 'span';

/** 描く要素 1 つ。 */
export interface ChatMarkdownElement {
  /** タグ名。 */
  readonly tag: ChatMarkdownTag;
  /** 属性（名前 → 値）。描く側が表で絞る。 */
  readonly attrs: Readonly<Record<string, string>>;
  /** 子（文字列は文字のノード）。 */
  readonly children: readonly ChatMarkdownNode[];
}

/** 木の節。**文字列は文字として描く**（HTML として解釈させない）。 */
export type ChatMarkdownNode = string | ChatMarkdownElement;

/** 描く側が守る表（タグと属性を許した分だけにする）。 */
export interface ChatMarkdownSpec {
  /** 許すタグと、そのタグに許す属性。 */
  readonly tags: Readonly<Record<string, readonly string[]>>;
  /** 閉じタグを持たない要素（サーバの文字列だけが使う）。 */
  readonly voids: readonly string[];
  /** `href` に許す形（大文字小文字を区別しない正規表現の本文）。 */
  readonly href: string;
  /** 付ける `rel` の値。 */
  readonly rel: string;
}

/**
 * 描く側が守る表。**ブラウザへは JSON のまま埋め込む**（`CHAT_MARKDOWN_SCRIPT`）。
 *
 * **`<img>` / `<script>` / `<iframe>` / `style` 属性 / `on*` 属性は、どれも表に無い。**
 */
export const CHAT_MARKDOWN_SPEC: ChatMarkdownSpec = {
  tags: {
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    p: [],
    ul: [],
    ol: ['start'],
    li: [],
    pre: [],
    code: [],
    blockquote: [],
    table: [],
    thead: [],
    tbody: [],
    tr: [],
    th: ['class'],
    td: ['class'],
    hr: [],
    br: [],
    strong: [],
    em: [],
    del: [],
    a: ['href', 'rel'],
    span: ['class'],
  },
  voids: ['hr', 'br'],
  href: '^https?://[^\\s<>"\'`\\u0000-\\u001f\\u007f]+$',
  rel: 'noopener noreferrer',
};

/**
 * 返答の Markdown を、描く要素の木へ解析する。**例外を投げない。**
 *
 * 扱う記法: 見出し（ATX / setext）・段落・箇条書き（順序つき / なし・入れ子）・強調・取り消し線・
 * インラインコード・コードブロック（フェンス / 字下げ）・引用・表・水平線・リンク・画像（文字で出す）・
 * `<https://…>` の自動リンク・バックスラッシュのエスケープ。**生の HTML は解釈せず文字で出す。**
 *
 * **見出しは `<h3>` から始める**（Markdown の `#` が `<h3>`）。チャットの区画の見出しが `<h2>` なので、
 * 返答の見出しはその下に入る。
 *
 * **この関数は外の名前を参照しない**（モジュール冒頭。本文をブラウザへ埋め込むため）。
 *
 * @param source 返答の文字列
 * @returns ブロックの並び
 */
export function parseChatMarkdown(source: string): ChatMarkdownElement[] {
  const MAX_DEPTH = 10;
  const MAX_BRACKET = 1000;
  const MAX_DESTINATION = 2048;
  const BACKTICK = String.fromCharCode(96);
  const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_{|}~' + BACKTICK;
  const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
  const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const QUOTE = /^ {0,3}> ?(.*)$/;
  const LIST = /^( {0,3})([*+-]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
  const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
  const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
  const INDENTED = /^(?: {4}|\t)/;
  const HREF = /^https?:\/\/[^\s<>"'`\u0000-\u001f\u007f]+$/i;
  const AUTOLINK = /<(https?:\/\/[^\s<>]*)>/iy;

  /** 要素を 1 つ作る。 */
  function element(tag: ChatMarkdownTag, children: ChatMarkdownNode[], attrs?: Record<string, string>): ChatMarkdownElement {
    return { tag, attrs: attrs === undefined ? {} : attrs, children };
  }

  /** 文字を足す（直前も文字なら 1 つにまとめる）。 */
  function pushText(out: ChatMarkdownNode[], text: string): void {
    if (text === '') {
      return;
    }
    const last = out.length === 0 ? undefined : out[out.length - 1];
    if (typeof last === 'string') {
      out[out.length - 1] = last + text;
    } else {
      out.push(text);
    }
  }

  /** 改行を `<br>` にして、残りを文字として並べる（解析しない）。 */
  function plain(text: string): ChatMarkdownNode[] {
    const out: ChatMarkdownNode[] = [];
    const lines = text.split('\n');
    for (let k = 0; k < lines.length; k += 1) {
      if (k > 0) {
        out.push(element('br', []));
      }
      pushText(out, lines[k] || '');
    }
    return out;
  }

  /** 空行か。 */
  function isBlank(line: string): boolean {
    return /^[ \t]*$/.test(line);
  }

  /** 行頭の字下げの幅（タブは次の 4 の倍数まで）。 */
  function indentOf(line: string): number {
    let width = 0;
    for (let k = 0; k < line.length; k += 1) {
      const ch = line.charAt(k);
      if (ch === ' ') {
        width += 1;
      } else if (ch === '\t') {
        width += 4 - (width % 4);
      } else {
        break;
      }
    }
    return width;
  }

  /** 行頭から幅 `n` までの字下げを外す。 */
  function dedent(line: string, n: number): string {
    let width = 0;
    let k = 0;
    while (k < line.length && width < n) {
      const ch = line.charAt(k);
      if (ch === ' ') {
        width += 1;
      } else if (ch === '\t') {
        width += 4 - (width % 4);
      } else {
        break;
      }
      k += 1;
    }
    return line.slice(k);
  }

  /** 表の 1 行をセルへ分ける（`\|` はセルの区切りにしない）。 */
  function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.charAt(0) === '|') {
      s = s.slice(1);
    }
    if (s.length > 0 && s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') {
      s = s.slice(0, -1);
    }
    const cells: string[] = [];
    let current = '';
    for (let k = 0; k < s.length; k += 1) {
      const ch = s.charAt(k);
      if (ch === '\\' && s.charAt(k + 1) === '|') {
        current += '|';
        k += 1;
      } else if (ch === '|') {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  /** `lines[at]` から表が始まるなら、見出しのセル数と揃えの並びを返す。 */
  function tableAt(lines: readonly string[], at: number): string[] | null {
    const head = lines[at];
    const rule = lines[at + 1];
    if (head === undefined || rule === undefined || head.indexOf('|') < 0 || rule.indexOf('|') < 0) {
      return null;
    }
    if (indentOf(head) >= 4 || indentOf(rule) >= 4) {
      return null;
    }
    const cells = splitRow(rule);
    if (cells.length !== splitRow(head).length) {
      return null;
    }
    const align: string[] = [];
    for (let k = 0; k < cells.length; k += 1) {
      const cell = cells[k] || '';
      if (!/^:?-+:?$/.test(cell)) {
        return null;
      }
      const left = cell.charAt(0) === ':';
      const right = cell.charAt(cell.length - 1) === ':';
      align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
    }
    return align;
  }

  /** 表のセルを 1 つ作る。 */
  function cell(tag: 'th' | 'td', text: string, align: string, depth: number): ChatMarkdownElement {
    return element(tag, inline(text, depth, false), align === '' ? undefined : { class: 'gf-md-' + align });
  }

  /** 段落を切る行か（段落の途中から別のブロックが始まるか）。 */
  function interrupts(line: string): boolean {
    if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) {
      return true;
    }
    const m = LIST.exec(line);
    if (m === null || (m[4] || '').trim() === '') {
      return false;
    }
    const marker = m[2] || '';
    return !/^\d/.test(marker) || /^0*1[.)]$/.test(marker);
  }

  /** 対応する `]` の位置（無ければ -1）。 */
  function closeBracket(text: string, open: number): number {
    let depth = 0;
    const end = Math.min(text.length, open + MAX_BRACKET);
    for (let k = open; k < end; k += 1) {
      const ch = text.charAt(k);
      if (ch === '\\') {
        k += 1;
      } else if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          return k;
        }
      }
    }
    return -1;
  }

  /** `(url "title")` を読む。`open` は `(` の位置。 */
  function destination(text: string, open: number): { url: string; end: number } | null {
    let k = open + 1;
    const limit = Math.min(text.length, open + MAX_DESTINATION);
    while (k < limit && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) {
      k += 1;
    }
    let url = '';
    if (text.charAt(k) === '<') {
      const close = text.indexOf('>', k + 1);
      if (close < 0 || close >= limit || text.slice(k + 1, close).indexOf('\n') >= 0) {
        return null;
      }
      url = text.slice(k + 1, close);
      k = close + 1;
    } else {
      let parens = 0;
      const start = k;
      while (k < limit) {
        const ch = text.charAt(k);
        if (ch === '\\' && k + 1 < limit) {
          k += 2;
          continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n') {
          break;
        }
        if (ch === '(') {
          parens += 1;
        } else if (ch === ')') {
          if (parens === 0) {
            break;
          }
          parens -= 1;
        }
        k += 1;
      }
      url = text.slice(start, k);
    }
    while (k < limit && (text.charAt(k) === ' ' || text.charAt(k) === '\t' || text.charAt(k) === '\n')) {
      k += 1;
    }
    const quote = text.charAt(k);
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, k + 1);
      if (close < 0 || close >= limit) {
        return null;
      }
      k = close + 1;
      while (k < limit && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) {
        k += 1;
      }
    }
    if (text.charAt(k) !== ')') {
      return null;
    }
    return { url: url.replace(/\\([^A-Za-z0-9\s])/g, '$1'), end: k + 1 };
  }

  /** 英数字か（`_` の語中の判定）。 */
  function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9]/.test(ch);
  }

  /** 空白か（文字列の端は空白として扱う）。 */
  function isSpace(ch: string): boolean {
    return ch === '' || /\s/.test(ch);
  }

  /** 同じ記号がいくつ続くか。 */
  function runLength(text: string, at: number, ch: string): number {
    let n = 0;
    while (text.charAt(at + n) === ch) {
      n += 1;
    }
    return n;
  }

  /**
   * 行内の記法を読む。
   *
   * `inLink` のときはリンクを作らない（リンクの中のリンク）。閉じる記号を探して見つからなかった
   * 位置は `missing` に覚え、**それより後ろからは探し直さない**（同じ記号が並ぶ入力で二乗にならない）。
   */
  function inline(text: string, depth: number, inLink: boolean): ChatMarkdownNode[] {
    if (depth > MAX_DEPTH) {
      return plain(text);
    }
    const out: ChatMarkdownNode[] = [];
    const missing: Record<string, number> = {};
    let buffer = '';
    const flush = (): void => {
      pushText(out, buffer);
      buffer = '';
    };
    let k = 0;
    while (k < text.length) {
      const ch = text.charAt(k);
      if (ch === '\n') {
        buffer = buffer.replace(/[ \t]+$/, '');
        flush();
        out.push(element('br', []));
        k += 1;
        while (text.charAt(k) === ' ' || text.charAt(k) === '\t') {
          k += 1;
        }
        continue;
      }
      if (ch === '\\' && k + 1 < text.length && PUNCTUATION.indexOf(text.charAt(k + 1)) >= 0) {
        buffer += text.charAt(k + 1);
        k += 2;
        continue;
      }
      if (ch === BACKTICK) {
        const n = runLength(text, k, BACKTICK);
        const key = 'code' + n;
        let close = -1;
        if (missing[key] === undefined || k < (missing[key] as number)) {
          let from = k + n;
          while (from < text.length) {
            const at = text.indexOf(BACKTICK, from);
            if (at < 0) {
              break;
            }
            const m = runLength(text, at, BACKTICK);
            if (m === n) {
              close = at;
              break;
            }
            from = at + m;
          }
          if (close < 0) {
            missing[key] = k;
          }
        }
        if (close < 0) {
          buffer += text.slice(k, k + n);
          k += n;
          continue;
        }
        let code = text.slice(k + n, close).replace(/\n/g, ' ');
        if (code.length >= 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        flush();
        out.push(element('code', [code]));
        k = close + n;
        continue;
      }
      if (ch === '<' && !inLink) {
        AUTOLINK.lastIndex = k;
        const m = AUTOLINK.exec(text);
        if (m !== null && HREF.test(m[1] || '')) {
          flush();
          out.push(element('a', [m[1] || ''], { href: m[1] || '', rel: 'noopener noreferrer' }));
          k += m[0].length;
          continue;
        }
      }
      if ((ch === '!' && text.charAt(k + 1) === '[') || (ch === '[' && !inLink)) {
        const open = ch === '!' ? k + 1 : k;
        const close = closeBracket(text, open);
        const target = close >= 0 && text.charAt(close + 1) === '(' ? destination(text, close + 1) : null;
        if (target !== null) {
          const label = text.slice(open + 1, close);
          flush();
          if (ch === '!') {
            // **画像は `<img>` にしない**（仕様 5.16）。代替テキストと URL を文字で出す。
            const alt = label.replace(/\\([^A-Za-z0-9\s])/g, '$1').replace(/\s+/g, ' ').trim();
            out.push(element('span', ['[画像' + (alt === '' ? '' : ': ' + alt) + '] ' + target.url], { class: 'gf-md-image' }));
          } else if (HREF.test(target.url)) {
            out.push(element('a', inline(label, depth + 1, true), { href: target.url, rel: 'noopener noreferrer' }));
          } else {
            // **`http` / `https` 以外は押せる形にしない。** 書かれた記法のまま文字で出す。
            pushText(out, text.slice(k, target.end));
          }
          k = target.end;
          continue;
        }
      }
      if (ch === '*' || ch === '_' || ch === '~') {
        const run = runLength(text, k, ch);
        const before = k === 0 ? '' : text.charAt(k - 1);
        const after = text.charAt(k + run);
        const n = ch === '~' ? (run === 2 ? 2 : 0) : run >= 3 ? 3 : run;
        const opens = n > 0 && !isSpace(after) && !(ch === '_' && isWordChar(before));
        let close = -1;
        const key = ch + n;
        if (opens && (missing[key] === undefined || k < (missing[key] as number))) {
          // 同じ長さの並びで閉じるのを優先する。無ければ、語の終わりにある長い並び（`*斜体***` の
          // `***`）の末尾 n 個で閉じる。
          let longer = -1;
          let from = k + run;
          while (from < text.length) {
            const at = text.indexOf(ch, from);
            if (at < 0) {
              break;
            }
            const m = runLength(text, at, ch);
            const prev = text.charAt(at - 1);
            const next = text.charAt(at + m);
            if (at > k + run && !isSpace(prev) && !(ch === '_' && isWordChar(next))) {
              if (m === n) {
                close = at;
                break;
              }
              if (m > n && longer < 0 && ch !== '~' && (isSpace(next) || /[!-/:-@[-`{-~、。，．！？」』）]/.test(next))) {
                longer = at + m - n;
              }
            }
            from = at + m;
          }
          if (close < 0) {
            close = longer;
          }
          if (close < 0) {
            missing[key] = k;
          }
        }
        if (close < 0 || run !== n) {
          buffer += text.slice(k, k + run);
          k += run;
          continue;
        }
        const inner = inline(text.slice(k + n, close), depth + 1, inLink);
        flush();
        if (ch === '~') {
          out.push(element('del', inner));
        } else if (n === 1) {
          out.push(element('em', inner));
        } else if (n === 2) {
          out.push(element('strong', inner));
        } else {
          out.push(element('em', [element('strong', inner)]));
        }
        k = close + n;
        continue;
      }
      buffer += ch;
      k += 1;
    }
    flush();
    return out;
  }

  /** 箇条書きを 1 つ読む。戻り値は読み終えた次の行。 */
  function list(lines: readonly string[], start: number, depth: number, out: ChatMarkdownElement[]): number {
    const first = LIST.exec(lines[start] || '');
    const firstMarker = first === null ? '-' : first[2] || '-';
    const ordered = /^\d/.test(firstMarker);
    const delimiter = ordered ? firstMarker.slice(-1) : firstMarker;
    const items: string[][] = [];
    let loose = false;
    let at = start;
    while (at < lines.length) {
      const line = lines[at] || '';
      const m = LIST.exec(line);
      if (m === null || HR.test(line)) {
        break;
      }
      const marker = m[2] || '';
      if (/^\d/.test(marker) !== ordered || (ordered ? marker.slice(-1) : marker) !== delimiter) {
        break;
      }
      const spaces = m[3] || '';
      const content = m[4] === undefined ? '' : m[4];
      const wide = spaces.length > 4 || content === '';
      const width = (m[1] || '').length + marker.length + (wide ? 1 : spaces.length);
      const body: string[] = [wide && content !== '' ? spaces.slice(1) + content : content];
      at += 1;
      while (at < lines.length) {
        const next = lines[at] || '';
        if (isBlank(next)) {
          body.push('');
          at += 1;
          continue;
        }
        if (indentOf(next) >= width) {
          body.push(dedent(next, width));
          at += 1;
          continue;
        }
        const previous = body[body.length - 1] || '';
        if (previous.trim() !== '' && !interrupts(next) && !LIST.test(next)) {
          body.push(next.trim());
          at += 1;
          continue;
        }
        break;
      }
      let trailing = 0;
      while (body.length > 1 && (body[body.length - 1] || '').trim() === '') {
        body.pop();
        trailing += 1;
      }
      if (trailing > 0 && at < lines.length && LIST.test(lines[at] || '')) {
        loose = true;
      }
      for (let k = 1; k < body.length; k += 1) {
        if ((body[k] || '').trim() === '' && !/^( {0,3})(`{3,}|~{3,})/.test(body[0] || '')) {
          loose = true;
        }
      }
      items.push(body);
    }
    const children: ChatMarkdownNode[] = [];
    for (let k = 0; k < items.length; k += 1) {
      const blocks = parse(items[k] || [], depth + 1);
      const content: ChatMarkdownNode[] = [];
      for (let b = 0; b < blocks.length; b += 1) {
        const block = blocks[b] as ChatMarkdownElement;
        if (!loose && block.tag === 'p') {
          for (let c = 0; c < block.children.length; c += 1) {
            content.push(block.children[c] as ChatMarkdownNode);
          }
        } else {
          content.push(block);
        }
      }
      children.push(element('li', content));
    }
    const number = ordered ? parseInt(firstMarker, 10) : 1;
    out.push(element(ordered ? 'ol' : 'ul', children, ordered && number !== 1 ? { start: String(number) } : undefined));
    return at;
  }

  /** ブロックの並びを読む。 */
  function parse(lines: readonly string[], depth: number): ChatMarkdownElement[] {
    const out: ChatMarkdownElement[] = [];
    if (depth > MAX_DEPTH) {
      const text = lines.join('\n').trim();
      if (text !== '') {
        out.push(element('p', plain(text)));
      }
      return out;
    }
    let at = 0;
    while (at < lines.length) {
      const line = lines[at] || '';
      if (isBlank(line)) {
        at += 1;
        continue;
      }
      let m = FENCE.exec(line);
      if (m !== null && !((m[2] || '').charAt(0) === BACKTICK && (m[3] || '').indexOf(BACKTICK) >= 0)) {
        const indent = (m[1] || '').length;
        const fence = m[2] || '';
        const body: string[] = [];
        at += 1;
        while (at < lines.length) {
          const close = FENCE_CLOSE.exec(lines[at] || '');
          if (close !== null && (close[1] || '').charAt(0) === fence.charAt(0) && (close[1] || '').length >= fence.length) {
            at += 1;
            break;
          }
          body.push(dedent(lines[at] || '', indent));
          at += 1;
        }
        out.push(element('pre', [element('code', [body.join('\n')])]));
        continue;
      }
      m = ATX.exec(line);
      if (m !== null) {
        const text = (m[2] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
        const level = Math.min(6, (m[1] || '#').length + 2);
        out.push(element(('h' + level) as ChatMarkdownTag, inline(text, depth, false)));
        at += 1;
        continue;
      }
      if (HR.test(line)) {
        out.push(element('hr', []));
        at += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const inner: string[] = [];
        while (at < lines.length) {
          const q = QUOTE.exec(lines[at] || '');
          if (q !== null) {
            inner.push(q[1] || '');
          } else if (!isBlank(lines[at] || '') && (inner[inner.length - 1] || '').trim() !== '' && !interrupts(lines[at] || '')) {
            inner.push(lines[at] || '');
          } else {
            break;
          }
          at += 1;
        }
        out.push(element('blockquote', parse(inner, depth + 1)));
        continue;
      }
      if (LIST.test(line)) {
        at = list(lines, at, depth, out);
        continue;
      }
      if (INDENTED.test(line)) {
        const body: string[] = [];
        while (at < lines.length && (INDENTED.test(lines[at] || '') || isBlank(lines[at] || ''))) {
          body.push(dedent(lines[at] || '', 4));
          at += 1;
        }
        while (body.length > 0 && (body[body.length - 1] || '').trim() === '') {
          body.pop();
        }
        out.push(element('pre', [element('code', [body.join('\n')])]));
        continue;
      }
      const align = tableAt(lines, at);
      if (align !== null) {
        const head = splitRow(line);
        const headCells: ChatMarkdownNode[] = [];
        for (let c = 0; c < align.length; c += 1) {
          headCells.push(cell('th', head[c] || '', align[c] || '', depth));
        }
        at += 2;
        const rows: ChatMarkdownNode[] = [];
        while (at < lines.length && !isBlank(lines[at] || '') && !interrupts(lines[at] || '')) {
          const values = splitRow(lines[at] || '');
          const cells: ChatMarkdownNode[] = [];
          for (let c = 0; c < align.length; c += 1) {
            cells.push(cell('td', values[c] || '', align[c] || '', depth));
          }
          rows.push(element('tr', cells));
          at += 1;
        }
        const parts: ChatMarkdownNode[] = [element('thead', [element('tr', headCells)])];
        if (rows.length > 0) {
          parts.push(element('tbody', rows));
        }
        out.push(element('table', parts));
        continue;
      }
      const paragraph: string[] = [line.trim()];
      let heading = 0;
      at += 1;
      while (at < lines.length) {
        const next = lines[at] || '';
        if (isBlank(next)) {
          break;
        }
        if (SETEXT_1.test(next)) {
          heading = 1;
          at += 1;
          break;
        }
        if (SETEXT_2.test(next)) {
          heading = 2;
          at += 1;
          break;
        }
        if (interrupts(next) || tableAt(lines, at) !== null) {
          break;
        }
        paragraph.push(next.trim());
        at += 1;
      }
      const content = inline(paragraph.join('\n'), depth, false);
      out.push(heading === 0 ? element('p', content) : element(('h' + (heading + 2)) as ChatMarkdownTag, content));
    }
    return out;
  }

  const text = String(source);
  try {
    return parse(text.replace(/\r\n?/g, '\n').split('\n'), 0);
  } catch (error) {
    // **落とさない**（仕様 5.16）。解析の途中で何が起きても、全文を文字として返す。
    return text.trim() === '' ? [] : [element('p', plain(text))];
  }
}

/** ブラウザの `document` のうち、組むのに使う分だけ。 */
export interface ChatMarkdownDocument<N> {
  createElement(tag: string): N & { setAttribute(name: string, value: string): void; appendChild(child: N): unknown };
  createTextNode(text: string): N;
}

/**
 * 木を DOM へ組んで `parent` の子として足す（ブラウザの側の描き方）。
 *
 * **`createElement` / `createTextNode` / `setAttribute` / `appendChild` だけを使う。** 表（`spec`）に
 * 無いタグは要素を作らずに子だけを並べ、無い属性は付けない。**`href` は表の形に合うときだけ付け、
 * 付けたら `rel` を必ず上書きする。**
 *
 * **この関数は外の名前を参照しない**（モジュール冒頭。本文をブラウザへ埋め込むため）。
 *
 * @param parent 足す先
 * @param nodes 木
 * @param doc 要素を作る `document`
 * @param spec 許すタグと属性の表
 */
export function buildChatMarkdown<N>(
  parent: { appendChild(child: N): unknown },
  nodes: readonly ChatMarkdownNode[],
  doc: ChatMarkdownDocument<N>,
  spec: ChatMarkdownSpec,
): void {
  const href = new RegExp(spec.href, 'i');
  const walk = (target: { appendChild(child: N): unknown }, list: readonly ChatMarkdownNode[]): void => {
    for (let k = 0; k < list.length; k += 1) {
      const node = list[k];
      if (typeof node === 'string') {
        target.appendChild(doc.createTextNode(node));
        continue;
      }
      if (node === undefined || node === null) {
        continue;
      }
      const allowed = Object.prototype.hasOwnProperty.call(spec.tags, node.tag) ? spec.tags[node.tag] : undefined;
      if (allowed === undefined) {
        walk(target, node.children);
        continue;
      }
      const made = doc.createElement(node.tag);
      for (let a = 0; a < allowed.length; a += 1) {
        const name = allowed[a] as string;
        if (!Object.prototype.hasOwnProperty.call(node.attrs, name) || name === 'rel') {
          continue;
        }
        const value = String(node.attrs[name]);
        if (name === 'href') {
          if (href.test(value)) {
            made.setAttribute('href', value);
            made.setAttribute('rel', spec.rel);
          }
          continue;
        }
        made.setAttribute(name, value);
      }
      walk(made, node.children);
      target.appendChild(made);
    }
  };
  walk(parent, nodes);
}

/**
 * 木を HTML の文字列にする（サーバの側の描き方）。**本文も属性値も `escapeHtml` を通す。**
 *
 * 規則は `buildChatMarkdown` と同じである（表に無いタグは子だけ・表に無い属性は付けない・
 * `href` は形に合うときだけで `rel` を上書きする）。`test/chat-markdown.test.ts` が、同じ木から
 * 同じ構造を作ることを見る。
 *
 * @param nodes 木
 * @param spec 許すタグと属性の表
 * @returns HTML の断片
 */
export function renderChatMarkdownHtml(nodes: readonly ChatMarkdownNode[], spec: ChatMarkdownSpec = CHAT_MARKDOWN_SPEC): string {
  const href = new RegExp(spec.href, 'i');
  let html = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      html += escapeHtml(node);
      continue;
    }
    const allowed = Object.prototype.hasOwnProperty.call(spec.tags, node.tag) ? spec.tags[node.tag] : undefined;
    if (allowed === undefined) {
      html += renderChatMarkdownHtml(node.children, spec);
      continue;
    }
    let attrs = '';
    for (const name of allowed) {
      if (!Object.prototype.hasOwnProperty.call(node.attrs, name) || name === 'rel') {
        continue;
      }
      const value = String(node.attrs[name]);
      if (name === 'href') {
        if (href.test(value)) {
          attrs += ` href="${escapeHtml(value)}" rel="${escapeHtml(spec.rel)}"`;
        }
        continue;
      }
      attrs += ` ${name}="${escapeHtml(value)}"`;
    }
    html += spec.voids.includes(node.tag)
      ? `<${node.tag}${attrs}>`
      : `<${node.tag}${attrs}>${renderChatMarkdownHtml(node.children, spec)}</${node.tag}>`;
  }
  return html;
}

/**
 * 取り出した関数の本文が呼ぶ `keep_names` の補助（`__name` / `__name2` / …）を、何もしない関数として定義する行。
 *
 * **補助の名前は束ごとに変わる。** 素の esbuild では `__name` だが、`wrangler pages dev` の束では
 * wrangler 自身の包みが先に `__name` を定義しているため、このモジュールの側は **`__name2` に改名される**
 * （2026-09-21 に実ブラウザで実測。固定の `__name` だけを定義していたら、`append()` の中で
 * `ReferenceError: __name2 is not defined` になり、`.catch` に呑まれて「チャットできませんでした」だけが出た）。
 * **だから名前を決め打ちせず、本文に現れた `__name<数字>` をすべて拾って定義する。** `__name` は束に
 * 現れなくても必ず定義する（何もしないので害は無い）。
 *
 * **補助は渡された関数をそのまま返す**（`__name(fn, "fn")` は式の中でも使われる）。関数の `name` を
 * 付け直さないのは、埋め込んだ本文が名前に頼らないためである。
 *
 * @param bodies 取り出した関数の本文
 * @returns 補助を定義する行（`var` の宣言）
 */
export function chatMarkdownHelperLines(bodies: readonly string[]): string[] {
  const names = new Set<string>(['__name']);
  for (const body of bodies) {
    for (const matched of body.matchAll(/\b(__name\d*)\(/gu)) {
      if (matched[1] !== undefined) {
        names.add(matched[1]);
      }
    }
  }
  return [...names].map((name) => `var ${name} = function (target) { return target; };`);
}

/** ブラウザへ埋め込む関数の本文（束が組んだものそのまま）。 */
const CHAT_MARKDOWN_BODIES: readonly string[] = [parseChatMarkdown.toString(), buildChatMarkdown.toString()];

/**
 * ブラウザへ埋め込む部品（`parseChatMarkdown` / `buildChatMarkdown` / `CHAT_MARKDOWN_SPEC`）。
 *
 * **先頭の行は、配る束の `keep_names` が本文へ差し込む呼び出しを受けるためのもの**
 * （`chatMarkdownHelperLines`。モジュール冒頭）。何もせず、渡された関数をそのまま返す。
 *
 * チャットのスクリプトの関数の中へそのまま置く（`var` と関数宣言だけなので、外へ名前を漏らさない）。
 */
export const CHAT_MARKDOWN_SCRIPT = [
  ...chatMarkdownHelperLines(CHAT_MARKDOWN_BODIES),
  `var CHAT_MARKDOWN_SPEC = ${JSON.stringify(CHAT_MARKDOWN_SPEC)};`,
  ...CHAT_MARKDOWN_BODIES,
].join('\n');
