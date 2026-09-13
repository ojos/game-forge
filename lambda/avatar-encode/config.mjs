/**
 * アイコンの再エンコード関数の設定（5.10 / #380）。
 *
 * **`docker/ogp-shot/config.mjs` と同じ形である。** 重い import（sharp）なしで読めるように分け、
 * **既定値を 1 つも持たない**——宣言（`terraform/avatar-function.tf` の `environment`）が欠けたら
 * 起動の時点で落とす。既定値を置くと、宣言が落ちても関数は自前の値で走り続け、**宣言と実物が
 * ずれたまま検査が緑になる**（あちらの冒頭の全文を参照）。
 *
 * **このファイルにヌル合体演算子を書かないこと。** `scripts/check-avatar-copies.sh` はその記号が
 * 1 つも無いことで既定値の不在を見る。
 */

/**
 * この関数が要求する環境変数の名前。**正本は terraform/avatar-function.tf の `environment` である。**
 *
 * `scripts/check-avatar-copies.sh` がこの配列を読み、terraform の宣言と両方向に突き合わせる。
 */
export const REQUIRED_ENV = ['AVATAR_SIZE', 'MAX_INPUT_BYTES', 'MAX_INPUT_DIMENSION', 'WEBP_QUALITY'];

/**
 * 正の整数として読む（読めない値はそこで落とす。値は出さず、名前だけを出す）。
 *
 * @param {string} name 環境変数の名前
 * @param {Record<string, string | undefined>} source 読み取り元
 * @returns {number} 正の整数
 */
function readPositiveInt(name, source) {
  const value = Number.parseInt(String(source[name]), 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`環境変数が正の整数ではありません: ${name}`);
  }
  return value;
}

/**
 * 環境変数から設定を読む。
 *
 * @param {Record<string, string | undefined>} [source] 読み取り元（既定は process.env）
 * @returns {{ size: number, maxInputBytes: number, maxInputDimension: number, webpQuality: number }} 設定
 * @throws {Error} 宣言が欠けている、あるいは読めない値のとき
 */
export function readConfig(source = process.env) {
  const missing = REQUIRED_ENV.filter((name) => {
    const value = source[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(`必要な環境変数がありません: ${missing.join(', ')}`);
  }
  const webpQuality = readPositiveInt('WEBP_QUALITY', source);
  if (webpQuality > 100) {
    throw new Error('環境変数が 1〜100 の範囲にありません: WEBP_QUALITY');
  }
  return {
    size: readPositiveInt('AVATAR_SIZE', source),
    maxInputBytes: readPositiveInt('MAX_INPUT_BYTES', source),
    maxInputDimension: readPositiveInt('MAX_INPUT_DIMENSION', source),
    webpQuality,
  };
}
