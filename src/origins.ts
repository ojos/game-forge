/**
 * アプリ用ホストとサンドボックス用ホストの関係を判定する。
 *
 * 7.2 が要求するのは「**別オリジン**であり、かつ同一サイトであることの帰結を
 * 引き受ける」構成である。ローカル開発環境（M0.5-3）はこの関係を再現しないと
 * `__Host-` cookie と CSP `sandbox` ヘッダの検証ができない。
 */

/** ホスト名の関係の判定結果。 */
export interface OriginRelation {
  /** 別オリジンか（ホスト名が異なれば、同一スキーム・同一ポートでも別オリジン）。 */
  readonly differentOrigin: boolean;
  /** 同一サイトか（登録可能ドメインが一致するか）。 */
  readonly sameSite: boolean;
  /** 判定の根拠。失敗時に「何が成立しなかったか」を読めるようにする。 */
  readonly reasons: readonly string[];
}

/**
 * 同一サイト性を「**両者が同じ親ドメインの下にあること**」で判定する。
 *
 * ## なぜ eTLD+1 を直接計算しないか
 *
 * 正確な算出には Public Suffix List が要る。`co.jp` のような多段の public suffix が
 * あるため、末尾 2 ラベルを取る近似は一般には誤る。PSL を Worker へ持ち込むのは
 * この判定の目的（設定の取り違えに気づくこと）に対して重い。
 *
 * ## 判定に使う近似
 *
 * 両ホストの**ラベル境界で揃えた最長共通接尾辞**を親ドメインとみなし、それが
 * 2 ラベル以上あれば同一サイトとする。1 ラベル（`jp` / `com`＝ TLD）で終わる場合は
 * 明らかに別サイトなので落とす。**この近似が保証しないのは「共通の親自身が public
 * suffix でないこと」だけ**で、`game-forge.ojos.jp` / `game-forge.localtest.me` の
 * いずれも該当しない。
 *
 * ## v1.4（#89）で緩めた点と、その埋め合わせ
 *
 * それ以前は「サンドボックスがアプリの**真のサブドメイン**であること」を条件に
 * していた。本番のアプリ用ホストが `app.game-forge.ojos.jp` になり（確定16 の改訂。
 * `game-forge.ojos.jp` は Route53 ゾーンの apex で CNAME を張れない）、サンドボックスと
 * **兄弟**の関係になったため、その条件では本番の組み合わせが落ちる。
 *
 * 緩めた分、この関数は「綴りを間違えた設定」を捕まえる力を失う（`ojos.jp` 配下なら
 * 何でも同一サイトと答える）。**その役目は `test/origins.test.ts` の
 * 「wrangler.toml の本番値」の検査へ移した**。あちらは宣言そのものを読んで
 * ホスト名の組を固定するので、近似の緩さと関係なく取り違えが落ちる。
 *
 * なお 7.2 が要求する対策（`__Host-` cookie / CSP `sandbox`）は、サブドメイン関係でも
 * 兄弟関係でも同じである。兄弟でも `Domain=game-forge.ojos.jp` の cookie は相手へ
 * 届くため、防ぐべきものは変わらない。
 *
 * @param appHost アプリ用ホスト名（ポートを含まない）
 * @param sandboxHost サンドボックス用ホスト名（ポートを含まない）
 * @returns 別オリジン・同一サイトの判定結果
 */
export function describeOriginRelation(appHost: string, sandboxHost: string): OriginRelation {
  const app = normalizeHost(appHost);
  const sandbox = normalizeHost(sandboxHost);
  const reasons: string[] = [];

  const differentOrigin = app !== sandbox && app.length > 0 && sandbox.length > 0;
  if (!differentOrigin) {
    reasons.push(`ホスト名が同一かまたは空です（app=${app || '(空)'} / sandbox=${sandbox || '(空)'}）`);
  }

  // 空のラベルを持つ値（`.game-forge.ojos.jp` など）は、共通接尾辞の計算では
  // 一致してしまうがホスト名として成立しない。先に落とす。
  const wellFormed = hasOnlyNonEmptyLabels(app) && hasOnlyNonEmptyLabels(sandbox);
  const parent = wellFormed ? longestCommonDomainSuffix(app, sandbox) : '';
  const sameSite = parent.includes('.');
  if (!sameSite) {
    reasons.push(
      `共通の親ドメインがありません（app=${app || '(空)'} / sandbox=${sandbox || '(空)'} / 共通=${parent || '(なし)'}）`,
    );
  }

  return { differentOrigin, sameSite, reasons };
}

/**
 * ホスト名が空のラベルを含まないことを確かめる。
 *
 * @param host 正規化済みのホスト名
 * @returns ラベルがすべて非空なら true
 */
function hasOnlyNonEmptyLabels(host: string): boolean {
  return host.length > 0 && host.split('.').every((label) => label.length > 0);
}

/**
 * 2 つのホスト名の、**ラベル境界で揃えた**最長共通接尾辞を返す。
 *
 * 文字列の `endsWith` で書くと `evilgame-forge.ojos.jp` が `game-forge.ojos.jp` で
 * 終わるように見える。ラベルの配列を末尾から突き合わせると、その取り違えが起きない。
 *
 * @param a ホスト名
 * @param b ホスト名
 * @returns 共通接尾辞（無ければ空文字）
 */
function longestCommonDomainSuffix(a: string, b: string): string {
  const left = a.split('.').reverse();
  const right = b.split('.').reverse();
  const shared: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      break;
    }
    shared.push(left[index]!);
  }
  return shared.reverse().join('.');
}

/**
 * `Host` ヘッダや設定値からポートと末尾ドットを落とし、小文字へそろえる。
 *
 * @param host ポートを含みうるホスト文字列
 * @returns 比較に使える正規化済みホスト名
 */
export function normalizeHost(host: string): string {
  const withoutPort = host.trim().toLowerCase().replace(/:\d+$/, '');
  return withoutPort.replace(/\.$/, '');
}
