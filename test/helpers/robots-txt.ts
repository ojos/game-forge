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
 * - グループの選択は**product token の一致（大文字小文字を無視）を優先し、無ければ `*`**
 * - 判定は**いちばん長く一致したルール**。同じ長さなら `Allow` を優先する
 * - `Disallow:`（値が空）は「何も禁じない」
 *
 * # 部分一致なのはパスであって、User-agent ではない
 *
 * **クローラは自分の product token でグループを選ぶ**（RFC 9309 §2.2.1）。
 *
 * > Crawlers MUST use case-insensitive matching to find the group that matches the product token.
 * > The product token SHOULD be a substring of the identification string that the crawler sends
 * > to the service.
 *
 * つまり `GPTBot/1.0` と名乗るクローラは、**自分で `GPTBot` を取り出してから**照合する。
 * `robots.txt` の側が `GPTBot/1.0` に部分一致を掛けるのではない。**最長一致はパスの規則**
 * （§2.2.2）で、User-agent の規則ではない。
 *
 * **そのうえで、識別文字列をそのまま渡されても正しく動くようにする**（{@link productTokenOf}）。
 * 渡す側が `GPTBot/1.0` と書いたときに静かに `*` のグループへ落ちると、**「拒否したはずの
 * クローラが許可されている」という誤った緑を作る。** 版を落として product token にし、
 * それでも product token の形でなければ投げる。
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
 * product token の綴り（RFC 9309 §2.2.1。英字・`_`・`-` だけ）。
 */
const PRODUCT_TOKEN = /^[A-Za-z_-]+$/u;

/**
 * クローラの識別文字列から product token を取り出す。
 *
 * `GPTBot/1.0` のような実運用の綴りを渡されても、`GPTBot` として照合できるようにする。
 *
 * **product token にならない綴りは投げる。** 静かに `*` のグループへ落とすと、
 * 「そのクローラは許可されている」という**誤った緑**になる（モジュール冒頭）。
 *
 * @param userAgent クローラ名、またはクローラが名乗る識別文字列
 * @returns product token
 */
export function productTokenOf(userAgent: string): string {
  const trimmed = userAgent.trim();
  // **空白を含む綴りからは取り出さない。** `Mozilla/5.0 (compatible; GPTBot/1.1; ...)` のような
  // 完全な識別文字列は、どの product token を指すかがここでは一意に決まらない（先頭を採ると
  // `Mozilla` になり、**GPTBot なのに `*` のグループで判定する**）。**推測せずに投げる。**
  const token = /\s/u.test(trimmed) ? trimmed : trimmed.split('/')[0]!;
  if (!PRODUCT_TOKEN.test(token)) {
    throw new Error(`product token ではありません: ${JSON.stringify(userAgent)}（RFC 9309 §2.2.1）`);
  }
  return token;
}

/**
 * このクローラが従うグループを選ぶ。
 *
 * @param robots 解釈した `robots.txt`
 * @param userAgent クローラ名（識別文字列でもよい）
 * @returns 従うグループ（該当が無ければ null）
 */
function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const name = productTokenOf(userAgent).toLowerCase();
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
 * @param userAgent クローラ名（`GPTBot` でも `GPTBot/1.0` でもよい）
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
