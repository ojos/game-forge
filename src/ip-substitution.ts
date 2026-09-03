/**
 * 著名 IP 名の検出と、置換したことの開示（6.2 / #39）。
 *
 * **このモジュールは名前を 1 つも持たない。** 一覧は `src/ip-terms.ts` にある。
 * `src/output-moderation.ts` と `src/denied-terms.ts` の分け方をそのまま倒している。
 *
 * ## 置換そのものはここで行わない
 *
 * **6.2 の置換はシステムプロンプトが行う**（`src/system-prompt.ts` の `COPYRIGHT`。
 * #16 で入った）。ここが決めるのは **「開示を出すかどうか」と「何と書くか」だけ**である。
 *
 * この分担には理由がある。**モデルが実際に何へ置き換えたかを、こちらは知り得ない。**
 * 出力は Go のソース 1 本だけで、置換の報告を返す口が無い（構造化出力を足せば作れるが、
 * それは 4.5 のキャッシュ前提と 5.2 の出力形式を両方動かす）。したがって開示は
 * **「入力に著名 IP 名が含まれていたので、オリジナルへ置き換えています」**という形になる。
 * **「置き換えました」と断定しない**——確かめていないことを、確かめたように書かない
 * （`docs/handoff.md` 4 章）。
 *
 * ## 当たらなかったことを、当たったように出さない
 *
 * 誤検出はこちらが嘘をつくことである（`src/ip-terms.ts` の但し書き）。ASCII の綴りには
 * 語境界を要求し、日本語の綴りは部分一致で見る。**この非対称は意図的で、日本語に
 * 語境界が無いためである。**
 */
import type { IpTerm } from './ip-terms.js';
import { IP_TERMS } from './ip-terms.js';

/**
 * `games.ip_notice` の区切り文字（Unit Separator、U+001F）。
 *
 * **正式名に現れない文字を選ぶ。** 現れる文字（読点やカンマ）を使うと、読み戻した
 * ときに 1 件が 2 件に割れる。**この列は画面へそのまま出るものではない**ので、
 * 読みやすさより「割れないこと」を優先する。区切りが名前へ混ざらないことは
 * `test/ip-substitution.test.ts` が一覧そのものに対して機械照合する（規約で守らない）。
 */
export const IP_NOTICE_SEPARATOR = '\u001f';

/**
 * 突き合わせのために文字列をならす。
 *
 * **NFKC で畳んでから小文字にする。** 全角の `ＭＡＲＩＯ` と半角の `mario` を
 * 同じものとして見るためである。**それ以外は落とさない**——落とし過ぎると別語の
 * 一部に当たりやすくなり、誤検出の側へ倒れる。
 *
 * @param value 元の文字列
 * @returns ならした文字列
 */
export function normalizeForIpMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * ASCII の語として現れているか（語境界を要求する）。
 *
 * **正規表現を組み立てない。** 綴りは一覧から来る任意の文字列で、`RegExp` へ渡すと
 * メタ文字が効いてしまう（`pac-man` の `-` は無害だが、次に足す名前がそうとは限らない）。
 * **添字で探して前後の 1 文字を見る**ほうが、綴りの中身に依存しない。
 *
 * @param haystack ならした対象
 * @param needle ならした綴り
 * @returns 語として現れていれば true
 */
function includesAsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  const isWordChar = (ch: string | undefined): boolean =>
    ch !== undefined && /[0-9a-z]/u.test(ch);

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? undefined : haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * プロンプトに含まれる著名 IP 名の正式名を、一覧の順で返す。
 *
 * **重複しない。** 1 つの `IpTerm` に綴りが何本当たっても、正式名は 1 度だけ出る。
 *
 * @param prompt 利用者が書いたプロンプト
 * @param terms 一覧（既定は {@link IP_TERMS}。テストはダミーを注入する）
 * @returns 当たった正式名（当たらなければ空配列）
 */
export function findIpTerms(
  prompt: string,
  terms: readonly IpTerm[] = IP_TERMS,
): readonly string[] {
  const haystack = normalizeForIpMatch(prompt);
  const found: string[] = [];
  for (const term of terms) {
    const hit = term.aliases.some((alias) => {
      const needle = normalizeForIpMatch(alias);
      return term.word === true
        ? includesAsWord(haystack, needle)
        : needle.length > 0 && haystack.includes(needle);
    });
    if (hit && !found.includes(term.label)) {
      found.push(term.label);
    }
  }
  return found;
}

/**
 * `games.ip_notice` へ入れる値を作る。
 *
 * **当たらなければ `null` を返す。** 空文字列を返さないのは、`null` と `''` の
 * 2 通りが「当たらなかった」を意味する状態を作らないためである
 * （`migrations/0015_games_ip_notice.sql`）。
 *
 * @param prompt 利用者が書いたプロンプト
 * @param terms 一覧
 * @returns 区切り文字で繋いだ正式名、または null
 */
export function ipNoticeOf(
  prompt: string,
  terms: readonly IpTerm[] = IP_TERMS,
): string | null {
  const found = findIpTerms(prompt, terms);
  return found.length === 0 ? null : found.join(IP_NOTICE_SEPARATOR);
}

/**
 * `games.ip_notice` を読み戻す。
 *
 * **`null` と空文字列の両方を「無い」として扱う。** 列は `null` しか入らない設計だが、
 * **読む側が書く側の規約に依存しない**ようにしておく（マイグレーションを手で当て直した
 * 行が混ざっても、画面が空の開示を出さない）。
 *
 * @param value 列の値
 * @returns 正式名の配列（無ければ空配列）
 */
export function parseIpNotice(value: string | null | undefined): readonly string[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  return value.split(IP_NOTICE_SEPARATOR).filter((part) => part !== '');
}
