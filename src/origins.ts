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
 * サンドボックス用ホストがアプリ用ホストの真のサブドメインであることを、
 * 同一サイト性の判定基準として使う。
 *
 * なぜ登録可能ドメイン（eTLD+1）を直接計算しないか: 正確な算出には Public Suffix
 * List が要る。`co.jp` のような多段の public suffix があるため、末尾 2 ラベルを
 * 取る近似は一般には誤る。一方、本プロダクトが実際に採る構成では
 * サンドボックスがアプリの真のサブドメインであり（本番 `sandbox.game-forge.ojos.jp`
 * ⊂ `game-forge.ojos.jp` / 開発 `sandbox.game-forge.localtest.me` ⊂
 * `game-forge.localtest.me`）、**アプリ用ホスト自身が public suffix でない限り**
 * 両者の登録可能ドメインは必ず一致する。PSL を持ち込まずに構成として保証できる
 * ため、こちらを不変条件に選ぶ。
 *
 * この関数が保証しないのは「アプリ用ホスト自身が public suffix でないこと」だけで、
 * これは `game-forge.ojos.jp` / `game-forge.localtest.me` のいずれも該当しない。
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

  const sameSite = sandbox.endsWith(`.${app}`) && sandbox.length > app.length + 1;
  if (!sameSite) {
    reasons.push(`サンドボックス用ホストがアプリ用ホストの真のサブドメインではありません（${sandbox} ⊄ ${app}）`);
  }

  return { differentOrigin, sameSite, reasons };
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
