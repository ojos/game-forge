/**
 * `robots.txt` を解釈して「このクローラはこのパスを取りに来てよいか」を判定する（#594）。
 *
 * # なぜ文字列の一致で済ませないのか
 *
 * `expect(body).toContain('Disallow: /api/')` は、**その行が効いているかを何も確かめない。**
 * `robots.txt` は行の集まりではなくグループの集まりで、**クローラは自分に最も一致する
 * グループ 1 つにだけ従う**（RFC 9309）。つまり次はどちらも「`Disallow: /api/` を含む」が、
 * 意味が正反対である。
 *
 * ```text
 * User-agent: *          User-agent: *
 * Disallow: /api/        Disallow: /api/
 *                        （ここで終わり）
 * User-agent: GPTBot
 * Disallow: /            ← GPTBot は上のグループを読まない
 * ```
 *
 * **意図を検査するには、同じ規則で読む側が要る。** ここはその読む側で、
 * `test/robots.test.ts` が自分自身を先に検査してから使う。
 *
 * # 実装したのは RFC 9309 の部分集合である
 *
 * - `#` 以降はコメント。`field: value` の形の行だけを見る
 * - `user-agent` が連続したら、それらは同じグループの別名になる
 * - グループの選択は**完全一致（大文字小文字を無視）を優先し、無ければ `*`**
 * - 判定は**いちばん長く一致したルール**。同じ長さなら `Allow` を優先する
 * - `Disallow:`（値が空）は「何も禁じない」
 *
 * **実装していないもの:** ワイルドカード（`*` `$`）、`Crawl-delay`、`Sitemap`。
 * 必要になった時点で足す（いまの `robots.txt` はどれも使っていない）。
 */

/** 1 つのグループ（`User-agent` の並びと、そのルール）。 */
interface RobotsGroup {
  /** このグループが対象とするクローラ名（小文字）。 */
  readonly agents: string[];
  /** ルール（宣言順）。 */
  readonly rules: { readonly allow: boolean; readonly path: string }[];
}

/** 解釈した `robots.txt`。 */
export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  /** グループに属さない行の値（`Sitemap` など。field は小文字）。 */
  readonly directives: readonly { readonly field: string; readonly value: string }[];
}

/**
 * `robots.txt` を解釈する。
 *
 * @param text `robots.txt` の中身
 * @returns 解釈した結果
 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const directives: { field: string; value: string }[] = [];
  // 直前の行も `user-agent` だったか（連続する `user-agent` は同じグループの別名になる）。
  let collectingAgents = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]!.trim();
    if (line === '') {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (collectingAgents && groups.length > 0) {
        groups[groups.length - 1]!.agents.push(value.toLowerCase());
      } else {
        groups.push({ agents: [value.toLowerCase()], rules: [] });
      }
      collectingAgents = true;
      continue;
    }

    collectingAgents = false;
    if (field === 'allow' || field === 'disallow') {
      if (groups.length > 0) {
        groups[groups.length - 1]!.rules.push({ allow: field === 'allow', path: value });
      }
      continue;
    }
    // グループの中にある `Content-Signal` などもここへ入れる（判定には使わない）。
    directives.push({ field, value });
  }

  return { groups, directives };
}

/**
 * このクローラが従うグループを選ぶ。
 *
 * @param robots 解釈した `robots.txt`
 * @param userAgent クローラ名
 * @returns 従うグループ（該当が無ければ null）
 */
function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const name = userAgent.toLowerCase();
  const exact = robots.groups.find((group) => group.agents.includes(name));
  if (exact !== undefined) {
    return exact;
  }
  return robots.groups.find((group) => group.agents.includes('*')) ?? null;
}

/**
 * このクローラがこのパスを取りに来てよいか。
 *
 * @param robots 解釈した `robots.txt`
 * @param userAgent クローラ名
 * @param path 判定するパス
 * @returns 取りに来てよければ true
 */
export function isAllowed(robots: RobotsTxt, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent);
  if (group === null) {
    // どのグループにも当たらない = 何も禁じられていない（RFC 9309）。
    return true;
  }
  let matched: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    // 値が空の `Disallow:` は「何も禁じない」。長さ 0 の一致として扱わない。
    if (rule.path === '') {
      continue;
    }
    if (!path.startsWith(rule.path)) {
      continue;
    }
    if (matched === null || rule.path.length > matched.length) {
      matched = { allow: rule.allow, length: rule.path.length };
      continue;
    }
    // 同じ長さなら Allow を優先する（RFC 9309）。
    if (rule.path.length === matched.length && rule.allow) {
      matched = { allow: true, length: rule.path.length };
    }
  }
  return matched === null ? true : matched.allow;
}

/**
 * グループに書かれた値を 1 つ取り出す（`Content-Signal` など）。
 *
 * @param robots 解釈した `robots.txt`
 * @param field 見出し（小文字）
 * @returns 値（無ければ null）
 */
export function directiveOf(robots: RobotsTxt, field: string): string | null {
  return robots.directives.find((directive) => directive.field === field)?.value ?? null;
}
