import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * `<button>` はすべて部品のクラスを持つ（#473 / 仕様 2.5.5）。
 *
 * # なぜ要るのか
 *
 * **#473 で、部品のクラスを持たない `<button>` の既定の見た目を、主（黒地に白文字）から副へ切り替えた**（`public/assets/app.css` の
 * `@section buttons`）。切り替える前に `src/` のボタンへ部品のクラスを付けて回ったが、**付けて回った事実は次の 1 本で崩れる**
 * ——M14 の「遊ぶ」「閉じる」のように後から足すボタンが既定に寄りかかると、主か副かを誰も決めないまま画面に出る。
 * 既定が副になったので見た目は壊れないが、「主は 1 画面に 1 つまで」（2.5.5）を呼ぶ側が決める規律が抜ける。
 *
 * **だから一覧を持たず、ソースを走査する**（`.ai-playbook/shared-ai-rules.md` 12 章）。ボタンを 1 つ足した人が部品のクラスを
 * 付けなければ、ここが赤くなる。
 *
 * # 何を「部品のクラスを持つ」とするか
 *
 * **`gf-button` と、段のクラス（`gf-button-primary` / `gf-button-secondary` / `gf-button-tertiary`）の 2 つ**を持つこと。
 * `gf-button` だけでも副に見えるが、それは既定に寄りかかるのと同じで、主か副かを決めていない。
 *
 * - `class` の値は、書いてある文字列に加えて、**同じファイルの文字列の定数の差し込み**（`class="${SECONDARY_BUTTON} gf-button-sm"`。
 *   `src/work-page.ts` の作法）を解決して読む。**解決できない差し込みは持たないものとして数える**（迷ったら赤へ倒す）
 * - `document.createElement('button')` で作るボタンも見る。代入した変数に、同じファイルの中で `className` か `classList.add` で
 *   部品のクラスを渡していなければ赤にする
 *
 * # 走査の範囲と例外
 *
 * **ソースは Vite の `import.meta.glob` で文字列として読む**（`test/mail-kinds.test.ts` と同じ。workerd の中にファイルシステムは無い）。
 * `public/` の下は `?raw` で中身が渡らない（`test/admin-screens.test.ts` の注記）が、`public/` に JavaScript も HTML も置いていない。
 *
 * **例外は `/__dev/components`（`src/dev-components.ts`）の既定の見本だけ**で、`data-dev-sample="default"` を持つものに限る。
 * 既定の見た目を確かめるための見本なので、クラスを持たないことが目的である。
 */

declare global {
  interface ImportMeta {
    /** Vite が変換時に展開する（`?raw` で中身の文字列を返す）。 */
    glob(
      pattern: string | readonly string[],
      options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
    ): Record<string, string>;
  }
}

/** 走査するソース（パス → 中身）。Pages Functions の入口と、別スクリプトの Worker も含める。 */
const SOURCES: Readonly<Record<string, string>> = import.meta.glob(
  ['../src/**/*.ts', '../functions/**/*.ts', '../workers/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
);

/** 既定の見本を置いてよい唯一のファイル。 */
const DEFAULT_SAMPLE_FILE = '../src/dev-components.ts';

/** 既定の見本の印。 */
const DEFAULT_SAMPLE_MARK = 'data-dev-sample="default"';

/** 開始タグの長さの上限（これを超えて閉じ括弧が無ければタグではない）。 */
const MAX_TAG_LENGTH = 600;

/** 段のクラス（仕様 2.5.5 の 3 段）。 */
const KIND_CLASSES = ['gf-button-primary', 'gf-button-secondary', 'gf-button-tertiary'] as const;

/** 見つけた `<button>` の開始タグ 1 つ。 */
interface ButtonTag {
  /** ファイルのパス。 */
  readonly path: string;
  /** 1 始まりの行番号。 */
  readonly line: number;
  /** 開始タグの文字列（`<button` から `>` まで）。 */
  readonly tag: string;
}

/**
 * ソースから `<button` の開始タグを取り出す。
 *
 * **`${ ... }` の中の `>` でタグを閉じない。** 差し込みの式（`${a > b ? ...}`）が `>` を含んでも、波括弧の対応を数えて読み飛ばす。
 * コメントの中の `<button>`（`src/work-page.ts` の注記など）は、閉じ括弧の直前が `button` だけの**属性を持たない形**なので、
 * 下の {@link isCommentMention} で除く。
 *
 * @param path ファイルのパス
 * @param text ソース
 * @returns 開始タグの一覧
 */
function buttonTagsOf(path: string, text: string): ButtonTag[] {
  const tags: ButtonTag[] = [];
  for (const match of text.matchAll(/<button\b/gu)) {
    const start = match.index;
    let depth = 0;
    let end = -1;
    // 開始タグは長くても数百文字である。閉じ括弧が見つからない言及（文の途中の `<button`）で、ファイルの残りを読まない。
    const limit = Math.min(text.length, start + MAX_TAG_LENGTH);
    for (let index = start + match[0].length; index < limit; index += 1) {
      const character = text[index];
      if (character === '$' && text[index + 1] === '{') {
        depth += 1;
        index += 1;
      } else if (character === '}' && depth > 0) {
        depth -= 1;
      } else if (character === '>' && depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) {
      continue;
    }
    tags.push({ path, line: text.slice(0, start).split('\n').length, tag: text.slice(start, end + 1) });
  }
  return tags;
}

/**
 * コメントや文章の中で要素の名前として書いた `<button>` か（HTML ではない）。
 *
 * **判定は行の形で行う。** 行の先頭が `*` か `//` のコメント行で、しかもバッククォートで囲んだ `` `<button>` `` や
 * 属性を持たない `<button>` だけのものを除く。**テンプレートの中の `<button>` は必ず属性（`type`）を持つ**
 * （`type` を省くと `submit` になる。既存のボタンはすべて `type` を書いている）ので、取り違えない。
 *
 * @param text ソース
 * @param tag 開始タグ
 * @returns コメントの中の言及なら true
 */
function isCommentMention(text: string, tag: ButtonTag): boolean {
  const lineText = text.split('\n')[tag.line - 1] ?? '';
  const comment = /^\s*(\*|\/\/)/u.test(lineText);
  return comment && !/\stype=/u.test(tag.tag);
}

/**
 * 同じファイルの文字列の定数を読む（`const NAME = 'gf-button gf-button-secondary';`）。
 *
 * @param text ソース
 * @returns 名前 → 値
 */
function stringConstantsOf(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const matched of text.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['"])([^'"\n]*)\2\s*;/gu)) {
    constants.set(matched[1]!, matched[3]!);
  }
  return constants;
}

/**
 * クラスの値から、書いてある語と解決できた定数の語を集める。**解決できない差し込みは何も足さない。**
 *
 * @param value `class` の値（差し込みを含みうる）
 * @param constants 同じファイルの文字列の定数
 * @returns クラスの語の集合
 */
function classTokensOf(value: string, constants: ReadonlyMap<string, string>): Set<string> {
  const resolved = value.replaceAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/gu, (_whole, name: string) => ` ${constants.get(name) ?? ''} `);
  // 解決できなかった式（`${cls}` や三項演算子）は語として数えない。
  const literal = resolved.replaceAll(/\$\{[^}]*\}/gu, ' ');
  return new Set(literal.split(/\s+/u).filter((token) => token !== ''));
}

/**
 * クラスの語が部品のクラス（`gf-button` と段のクラス）を満たすか。
 *
 * @param tokens クラスの語
 * @returns 満たせば true
 */
function hasPartClasses(tokens: ReadonlySet<string>): boolean {
  return tokens.has('gf-button') && KIND_CLASSES.some((kind) => tokens.has(kind));
}

/**
 * 開始タグが部品のクラスを持つか。
 *
 * **`class="…"` のほかに、`class="gf-button ${cls}"` のように段を式で渡す形**（`src/dev-components.ts` の `buttonOf`）がある。
 * その式は同じファイルの中で段のクラスの一覧から来ているので、**`gf-button` が書いてあり、残りの差し込みがどれも解決できない式**
 * のときは、ファイルに段のクラスの綴りが現れていることを条件に認める。
 *
 * @param tag 開始タグ
 * @param text ソース
 * @returns 持てば true
 */
function tagHasPartClasses(tag: ButtonTag, text: string): boolean {
  const classAttribute = /\sclass="((?:[^"$]|\$\{[^}]*\}|\$(?!\{))*)"/u.exec(tag.tag);
  if (classAttribute === null) {
    return false;
  }
  const value = classAttribute[1]!;
  const tokens = classTokensOf(value, stringConstantsOf(text));
  if (hasPartClasses(tokens)) {
    return true;
  }
  const dynamic = /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/u.test(value);
  return dynamic && tokens.has('gf-button') && KIND_CLASSES.every((kind) => text.includes(`'${kind}'`));
}

/**
 * `document.createElement('button')` で作ったボタンのうち、部品のクラスを渡していないもの。
 *
 * @param path ファイルのパス
 * @param text ソース
 * @returns 渡していない箇所の説明
 */
function scriptButtonsWithoutParts(path: string, text: string): string[] {
  const offenders: string[] = [];
  const constants = stringConstantsOf(text);
  const all = [...text.matchAll(/createElement\(\s*(['"])button\1\s*\)/gu)];
  const assigned = [
    ...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\.)?createElement\(\s*(['"])button\2\s*\)/gu),
  ];
  if (all.length > assigned.length) {
    offenders.push(`${path}（createElement('button') を変数へ代入していないので、クラスを渡したか読めない）`);
  }
  for (const matched of assigned) {
    const name = matched[1]!;
    const line = text.slice(0, matched.index).split('\n').length;
    const escaped = name.replaceAll('$', '\\$');
    const values = [
      ...[...text.matchAll(new RegExp(`\\b${escaped}\\.className\\s*=\\s*(['"])([^'"]*)\\1`, 'gu'))].map((found) => found[2]!),
      ...[...text.matchAll(new RegExp(`\\b${escaped}\\.classList\\.add\\(([^)]*)\\)`, 'gu'))].map((found) =>
        (found[1] ?? '').replaceAll(/['",]/gu, ' '),
      ),
    ];
    const tokens = new Set(
      values
        .flatMap((value) => value.split(/\s+/u))
        .flatMap((token) => (constants.get(token) ?? token).split(/\s+/u))
        .filter((token) => token !== ''),
    );
    if (!hasPartClasses(tokens)) {
      offenders.push(`${path}:${line}（${name} に部品のクラスを渡していない）`);
    }
  }
  return offenders;
}

describe('`<button>` はすべて部品のクラスを持つ（#473 / 仕様 2.5.5）', () => {
  it('走査の対象が空でない（glob が何も拾わずに緑になるのを防ぐ）', () => {
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(50);
    // ボタンを持つことが分かっているファイルが入っている。
    expect(paths).toContain('../src/html.ts');
    expect(paths).toContain('../src/work-page.ts');
    const found = Object.entries(SOURCES).flatMap(([path, text]) => buttonTagsOf(path, text));
    expect(found.length, '`<button` を 1 つも見つけられない').toBeGreaterThan(20);
  });

  it('src/ に、部品のクラスを持たない `<button>` が無い', () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      for (const tag of buttonTagsOf(path, text)) {
        if (isCommentMention(text, tag)) {
          continue;
        }
        if (path === DEFAULT_SAMPLE_FILE && tag.tag.includes(DEFAULT_SAMPLE_MARK) && !/\sclass=/u.test(tag.tag)) {
          continue;
        }
        if (!tagHasPartClasses(tag, text)) {
          offenders.push(`${path}:${tag.line} ${tag.tag}`);
        }
      }
    }
    expect(offenders, '部品のクラス（gf-button と段のクラス）を付ける').toEqual([]);
  });

  it('スクリプトで作る `<button>` も、部品のクラスを渡している', () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, text]) => scriptButtonsWithoutParts(path, text));
    expect(offenders).toEqual([]);
  });

  it('既定の見本の例外は `/__dev/components` にしか無い', () => {
    const elsewhere = Object.entries(SOURCES)
      .filter(([path, text]) => path !== DEFAULT_SAMPLE_FILE && text.includes(DEFAULT_SAMPLE_MARK))
      .map(([path]) => path);
    expect(elsewhere).toEqual([]);
    expect(SOURCES[DEFAULT_SAMPLE_FILE]).toContain(DEFAULT_SAMPLE_MARK);
  });

  describe('検査そのものが、持たないボタンを捕まえる（変異）', () => {
    /**
     * 1 つのソースを検査にかける。
     *
     * @param text ソース
     * @returns 部品のクラスを持たないタグ
     */
    function offendersIn(text: string): string[] {
      return buttonTagsOf('../src/sample.ts', text)
        .filter((tag) => !isCommentMention(text, tag) && !tagHasPartClasses(tag, text))
        .map((tag) => tag.tag);
    }

    it('クラスの無いボタン・gf-button だけのボタン・解決できない差し込みを捕まえる', () => {
      expect(offendersIn('const a = `<button type="submit">送る</button>`;')).toHaveLength(1);
      expect(offendersIn('const a = `<button type="submit" class="gf-button">送る</button>`;')).toHaveLength(1);
      expect(offendersIn('const a = `<button type="submit" class="${other}">送る</button>`;')).toHaveLength(1);
      // 差し込みの式の中の `>` でタグを閉じない（閉じると、後ろの class を読み落として緑にしうる）。
      expect(offendersIn('const a = `<button type="submit" ${x > 1 ? "disabled" : ""} class="gf-button">送る</button>`;')).toHaveLength(1);
      expect(
        offendersIn('const a = `<button type="submit" ${x > 1 ? "disabled" : ""} class="gf-button gf-button-primary">送る</button>`;'),
      ).toEqual([]);
    });

    it('書いてあるクラスと、同じファイルの定数の差し込みは通す', () => {
      expect(offendersIn('const a = `<button type="submit" class="gf-button gf-button-primary">送る</button>`;')).toEqual([]);
      expect(
        offendersIn("const B = 'gf-button gf-button-secondary';\nconst a = `<button type=\"submit\" class=\"${B} gf-button-sm\">送る</button>`;"),
      ).toEqual([]);
    });

    it('コメントの中の要素の名前は数えない', () => {
      expect(offendersIn('/**\n * 動作は `<button>` にする。\n */')).toEqual([]);
    });

    it('スクリプトで作るボタンにクラスを渡していなければ捕まえる', () => {
      expect(scriptButtonsWithoutParts('x', "var b = document.createElement('button');")).toHaveLength(1);
      expect(
        scriptButtonsWithoutParts('x', "var b = document.createElement('button');\nb.className = 'gf-button gf-button-tertiary';"),
      ).toEqual([]);
    });
  });
});

describe('`<button>` の既定は副の見た目である（#473 / public/assets/app.css の @section buttons）', () => {
  /**
   * セレクタの一覧に `sel` を含む規則の中身を集める。
   *
   * @param css app.css
   * @param predicate セレクタの一覧を受けて対象かを返す
   * @returns 規則の中身
   */
  function ruleBodies(css: string, predicate: (selectors: string[]) => boolean): string[] {
    const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter((matched) => predicate(matched[1]!.split(',').map((selector) => selector.trim())))
      .map((matched) => matched[2]!);
  }

  it('クラスを持たない `<button>` の既定は、地の色に 1px の枠線（副）で、詳細度 0 の `:where()` に置く', () => {
    const [base] = ruleBodies(env.TEST_APP_CSS, (selectors) => selectors.includes(':where(button)'));
    expect(base, ':where(button) の規則が無い').toBeDefined();
    expect(base).toMatch(/border:\s*1px solid var\(--gf-rule\);/u);
    expect(base).toMatch(/background:\s*var\(--gf-ground\);/u);
    expect(base).toMatch(/color:\s*var\(--gf-ink\);/u);
    // 副ボタンの部品と同じ規則を共有する（値を書き写さない）。
    const [sharedWithPart] = ruleBodies(
      env.TEST_APP_CSS,
      (selectors) => selectors.includes(':where(button)') && selectors.includes('.gf-button'),
    );
    expect(sharedWithPart, '既定と .gf-button が同じ規則でない').toBeDefined();
  });

  it('主の見た目（地を文字色で塗る）は、要素の `button` を狙う規則に無い', () => {
    const elementRules = ruleBodies(env.TEST_APP_CSS, (selectors) =>
      selectors.some((selector) => /(^|[\s(>+~,])button\b/u.test(selector) && !selector.includes('.gf-account-menu-list')),
    );
    expect(elementRules.length).toBeGreaterThan(0);
    for (const body of elementRules) {
      expect(body).not.toMatch(/background:\s*var\(--gf-ink\)/u);
      expect(body).not.toMatch(/color:\s*var\(--gf-ground\)/u);
    }
    // 要素の既定を詳細度つきで書かない（控えめのボタンのホバーに既定の枠の色が勝つ。app.css の注記）。
    const bare = ruleBodies(env.TEST_APP_CSS, (selectors) => selectors.some((selector) => /^button(:[a-z-]+)?$/u.test(selector)));
    expect(bare).toEqual([]);
  });
});
