/**
 * アイコンの再エンコード関数（AWS Lambda。5.10 / #380）。
 *
 * **Worker から同期で呼ばれ**（`src/avatar-client.ts`。`X-Amz-Invocation-Type: RequestResponse`）、
 * 変換した WebP を応答の JSON で返す。**R2 へは書かない**——資格情報を持たない（`terraform/avatar-function.tf`）。
 * 書くのは R2 バインディングを持つ Worker である（`src/avatar.ts`。OGP の撮影と同じ形）。
 *
 * ## 受け取るもの・返すもの
 *
 * ```text
 * 要求: { "image": "<base64>" }
 * 応答: { "ok": true, "webp": "<base64>" } | { "ok": false, "reason": "unsupported" | "animated" | "too-large" | "broken" }
 * ```
 *
 * **出力の大きさ・品質・上限はペイロードで受け取らない**（環境変数が持つ。ペイロードを差し替えられる者に
 * 巨大な出力を作らせない）。
 *
 * ## ログに画像を出さない
 *
 * 出すのは断った理由と、バイト数だけである（利用者の画像はログに残さない）。
 */
import { readConfig } from './config.mjs';
import { encodeAvatar } from './encode.mjs';

/**
 * 設定は起動の時点で読む（**宣言が欠けていたら、最初の呼び出しの前に落ちる**）。
 */
const config = readConfig();

/**
 * Lambda の入口。
 *
 * @param {{ image?: unknown }} event 要求
 * @returns {Promise<{ ok: true, webp: string } | { ok: false, reason: string }>} 応答
 */
export async function handler(event) {
  const image = event !== null && typeof event === 'object' ? event.image : undefined;
  if (typeof image !== 'string' || image === '') {
    console.log('[avatar-encode] 要求に画像がありません');
    return { ok: false, reason: 'broken' };
  }
  const input = Buffer.from(image, 'base64');
  const result = await encodeAvatar(input, config);
  if (!result.ok) {
    console.log(`[avatar-encode] 断りました: ${result.reason}（${input.length} バイト）`);
    return result;
  }
  console.log(`[avatar-encode] 変換しました: ${input.length} → ${result.webp.length} バイト`);
  return { ok: true, webp: result.webp.toString('base64') };
}
