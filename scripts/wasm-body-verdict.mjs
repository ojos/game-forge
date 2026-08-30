// wasm-body-verdict.mjs — 受け取った `.wasm` の本文が正しいかを判定する（#181 / #182）。
//
// ══════════════════════════════════════════════════════════════════════════════
// **応答の `Content-Encoding` を見ずに判定してはならない**
// ══════════════════════════════════════════════════════════════════════════════
//
// **経路（CDN・プロキシ・エッジ）は本文を透過的に展開しうる。** クライアントが
// `Accept-Encoding: br` を送らなければ、エッジは brotli を展開し、`Content-Encoding`
// ヘッダを外して返す。**これは正しい振る舞いである。**
//
// 本番の実測（#182）:
//
// ```text
// Accept-Encoding: br あり → content-encoding: br  /  2,313,735 バイト / 1 回展開で \0asm
// Accept-Encoding  なし    → content-encoding なし  / 11,569,609 バイト / 既に \0asm
// ```
//
// **どちらも正しい状態である。** 同じ URL が、要求の仕方で違う形の本文を返す。
//
// ## この一点で、**両方向に間違えた**（だからこのファイルがある）
//
// **1 回目（#181 を見逃した）。** 「`Accept-Encoding: br` の有無でサイズが違う」のを見て
// 「エッジが再圧縮しているのだろう」と流した。**実際には配信側が二重に圧縮しており、
// 利用者のブラウザでは起動していなかった。**
//
// **2 回目（#182 の偽陽性）。** 逆向きに、`Content-Encoding` が無い応答（＝経路が既に
// 展開した、正しい本文）を brotli として展開しようとして失敗し、**正しい本番を
// 「二重圧縮です」と報告した。**
//
// **根は同じである——「経路が透過的に展開しうる」ことを勘定に入れていない。**
// 次にこの判定を触る人も、同じところで両方向に間違える。**だから判定を 1 箇所に集め、
// 分岐の理由をここに書く。** 呼ぶ側（`check-sandbox-cors.sh` / `check-sandbox-browser.sh`）
// は判定を持たない——2 箇所に書けば、片方だけ直る日が必ず来る。
//
// ## 判定表
//
// `Content-Encoding: br` が宣言されているかで、本文の読み方が変わる。
//
// | 宣言 | 本文 | 判定 | 意味 |
// |---|---|---|---|
// | br   | 1 回展開で `\0asm` | OK | 事前圧縮した `.wasm.br` がそのまま届いている（3.4-1 の意図） |
// | br   | そのまま `\0asm`   | NG | 宣言と本文の食い違い。**ブラウザは展開を試みて落ちる** |
// | br   | 2 回展開で `\0asm` | NG | **二重圧縮**（#181） |
// | なし | そのまま `\0asm`   | OK | 経路が既に展開している。**正しい** |
// | なし | 1 回展開で `\0asm` | NG | 本文は brotli なのに宣言が無い。**ブラウザは展開しない** |
// | —    | どちらでも wasm にならない | NG | 別物が返っている |
//
// **不合格は「二重」と「宣言と本文の食い違い」と「そもそも wasm でない」だけである。**
//
// 使い方:
//   node scripts/wasm-body-verdict.mjs --body <file> --content-encoding <value> --label <prefix>
//
// `--content-encoding` は空文字を渡してよい（ヘッダが無いことを意味する）。
//
// 終了コード: 0 = 合格 / 1 = 不合格・判定不能

import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

/** wasm のマジックナンバー `\0asm`。 */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{body: string, contentEncoding: string, label: string}} 読み取った設定
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error(`引数の形が違います: ${String(name)}`);
    }
    values[name.slice(2)] = value;
  }
  if (values['body'] === undefined) {
    throw new Error('--body は必須です');
  }
  return {
    body: values['body'],
    contentEncoding: values['content-encoding'] ?? '',
    label: values['label'] ?? '[wasm-body]',
  };
}

/**
 * 先頭 4 バイトを 16 進で表す（診断用）。
 *
 * @param {Buffer} buffer 対象
 * @returns {string} `00 61 73 6d` の形
 */
function head(buffer) {
  return [...buffer.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/**
 * wasm のマジックナンバーで始まるか。
 *
 * @param {Buffer} buffer 対象
 * @returns {boolean} 始まるなら true
 */
function isWasm(buffer) {
  return buffer.subarray(0, 4).equals(WASM_MAGIC);
}

/**
 * brotli として 1 回展開する。展開できなければ null。
 *
 * @param {Buffer} buffer 対象
 * @returns {Buffer | null} 展開結果
 */
function inflateOnce(buffer) {
  try {
    return brotliDecompressSync(buffer);
  } catch {
    return null;
  }
}

/**
 * 本文を判定する。
 *
 * @param {Buffer} body 受け取った本文
 * @param {boolean} declaresBrotli 応答が `Content-Encoding: br` を宣言しているか
 * @returns {{ok: boolean, message: string}} 判定と説明
 */
function verdict(body, declaresBrotli) {
  const declared = declaresBrotli ? 'br' : 'なし';

  // 経路が既に展開した形。宣言が無ければ、これが正しい。
  if (isWasm(body)) {
    if (!declaresBrotli) {
      return {
        ok: true,
        message: `本文が既に wasm です (${body.length} バイト)。経路が展開済みで、Content-Encoding も付いていません（正しい状態）。`,
      };
    }
    return {
      ok: false,
      message:
        `Content-Encoding: br を宣言しているのに、本文は展開済みの wasm です (${body.length} バイト)。` +
        ' **ブラウザは展開を試みて落ちます。** 経路が本文だけ展開してヘッダを外し忘れている可能性があります。',
    };
  }

  const once = inflateOnce(body);
  if (once !== null && isWasm(once)) {
    if (declaresBrotli) {
      return {
        ok: true,
        message: `1 回展開で wasm になりました (配信 ${body.length} → 展開 ${once.length} バイト)。`,
      };
    }
    return {
      ok: false,
      message:
        `本文は brotli ですが Content-Encoding が付いていません (配信 ${body.length} → 展開 ${once.length} バイト)。` +
        ' **ブラウザは展開しないので、そのまま wasm として読もうとして落ちます。**',
    };
  }

  // 1 回展開してもまだ brotli なら二重圧縮（#181 の症状そのもの）。
  if (once !== null) {
    const twice = inflateOnce(once);
    if (twice !== null && isWasm(twice)) {
      return {
        ok: false,
        message:
          `**二重に brotli 圧縮されています（#181）。**` +
          ` 配信 ${body.length} → 1 回展開 ${once.length}（先頭 ${head(once)}、まだ brotli）` +
          ` → 2 回展開 ${twice.length} バイトでようやく wasm。` +
          " src/sandbox-delivery.ts の wasmResponse に encodeBody: 'manual' を含む版を配備してください。",
      };
    }
  }

  return {
    ok: false,
    message:
      `どちらの読み方でも wasm になりません (Content-Encoding: ${declared},` +
      ` ${body.length} バイト, 先頭 ${head(body)})。別のものが返っている可能性があります。`,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const body = readFileSync(options.body);

  // `Content-Encoding: br` の宣言があるか。`br` 以外（gzip 等）は、この経路では
  // 想定していないので「宣言なし」とは別に扱いたいが、実際に返るのは br か無しの
  // 2 通りである（3.4-1）。トークンとして br を含むかだけを見る。
  const declaresBrotli = /(^|[\s,])br([\s,;]|$)/iu.test(options.contentEncoding);

  const result = verdict(body, declaresBrotli);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${options.label} ${result.ok ? 'OK' : 'NG'}: ${result.message}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`[wasm-body] 判定できませんでした: ${String(error)}\n`);
  process.exit(1);
}
