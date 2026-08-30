/**
 * 撮影関数の設定（5.4 / 11.2 / #26）。
 *
 * ## なぜ 1 つのファイルに分けてあるのか
 *
 * **ここを、重い import なしで読めるようにするためである。** `index.mjs` は
 * `@sparticuz/chromium` と `puppeteer-core` を import するので、**イメージを組み立てて
 * からでないと実行できない。** 設定の読み取りだけを別に置けば、
 *
 *   - `node` で直接叩いて、**宣言が欠けたときに本当に落ちることを確かめられる**
 *   - `scripts/check-ogp-copies.sh` が「何を要求しているか」を 1 か所から読める
 *
 * ## 既定値を 1 つも持たない
 *
 * **これは #26 のレビューで直した点である。** 当初は撮る大きさと待ち時間に、ヌル合体
 * 演算子による既定値（1200 / 630 / 20000）を置いていた。値そのものは正しかったが、
 * **terraform の宣言と同じ値がここにも書かれている＝写しが 3 つ増えていた。**
 *
 * **このファイルにヌル合体演算子を書かないこと。** それが既定値の唯一の書き方であり、
 * `scripts/check-ogp-copies.sh` は「その記号が 1 つも無いこと」で既定値の不在を見る。
 * **綴りを絞った検査は、対象が別の綴りになった瞬間に何も見なくなる**ので、
 * 記号そのものを禁じる形にしてある（この検査自身が一度その罠を踏んだ）。
 *
 * **そして、その写しは誰も見ていなかった。** `scripts/check-ogp-copies.sh` が照合して
 * いたのは terraform ↔ `src/ogp.ts` の 2 点だけである。つまり
 * `terraform/ogp-function.tf` の `environment` から宣言が落ちても、
 * **関数は落ちずに自前の既定値で走り続け、検査は緑のまま**になる。
 * docs/handoff.md 4 章の「**確かめていない検査は、確かめた証拠として読まれるぶん
 * 赤より悪い**」がそのまま当てはまる形だった。
 *
 * **既定値を消すと、写しが 3 つ消える。** 宣言が欠けた状態は起動の時点で例外になり、
 * CloudWatch に名前が出る（**値は出さない**）。**そして残った結合は「名前」だけ**に
 * なるので、`scripts/check-ogp-copies.sh` が
 * 「{@link REQUIRED_ENV} の名前がすべて terraform の `environment` にあるか」を
 * 静的に照合できる。**実行時に落ちる前に、宣言のテキストで捕まえる。**
 */

/**
 * この関数が要求する環境変数の名前。**正本は terraform/ogp-function.tf の
 * `environment` である。**
 *
 * **一覧をここに置くのは、値ではなく名前だからである。** 値を持つと写しになるが、
 * 名前は「何を要求するか」という、この関数自身の性質である。
 * `scripts/check-ogp-copies.sh` がこの配列を読み、terraform の宣言と突き合わせる。
 */
export const REQUIRED_ENV = [
  'SANDBOX_BASE_URL',
  'CALLBACK_BASE_URL',
  'VIEWPORT_WIDTH',
  'VIEWPORT_HEIGHT',
  'CAPTURE_TIMEOUT_MS',
];

/**
 * 正の整数として読む。
 *
 * **`Number.parseInt` の結果をそのまま使わない。** `parseInt('abc')` は `NaN` を返し、
 * `NaN` を viewport に渡した chromium は既定の大きさで起動する——**撮影は成功し、
 * 大きさだけが黙って違う。** 読めない値は、そこで落とす。
 *
 * @param {string} name 環境変数の名前
 * @param {Record<string, string | undefined>} source 読み取り元
 * @returns {number} 正の整数
 */
function readPositiveInt(name, source) {
  const raw = source[name];
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    // **値は出さない。名前だけ**（src/bedrock.ts / src/build-client.ts と同じ方針）。
    throw new Error(`環境変数が正の整数ではありません: ${name}`);
  }
  return value;
}

/**
 * 環境変数から設定を読む。
 *
 * **既定値を 1 つも持たない**（モジュール冒頭）。値の正本は
 * `terraform/ogp-function.tf` の `environment` であり、**宣言が欠けた状態で
 * 「どこかへ撮りに行く」関数にしない。**
 *
 * @param {Record<string, string | undefined>} [source] 読み取り元（既定は process.env）
 * @returns {{ sandboxBaseUrl: string, callbackBaseUrl: string, width: number, height: number, captureTimeoutMs: number }} 設定
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

  return {
    // 末尾のスラッシュを落として、URL の組み立てで `//` を作らない。
    sandboxBaseUrl: source['SANDBOX_BASE_URL'].replace(/\/+$/u, ''),
    callbackBaseUrl: source['CALLBACK_BASE_URL'].replace(/\/+$/u, ''),
    width: readPositiveInt('VIEWPORT_WIDTH', source),
    height: readPositiveInt('VIEWPORT_HEIGHT', source),
    captureTimeoutMs: readPositiveInt('CAPTURE_TIMEOUT_MS', source),
  };
}
