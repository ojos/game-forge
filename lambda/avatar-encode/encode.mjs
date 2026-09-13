/**
 * アイコンの再エンコード（5.10 / #380）。**受け取った画像をそのまま配らない**ための本体。
 *
 * 1. **署名で形式を絞る**（PNG / JPEG / WebP）。**sharp に渡す前に見る**——sharp（libvips）は SVG も
 *    GIF も HEIF も読めるので、「sharp が読めたら通す」形にすると SVG を librsvg で解釈させることになる
 * 2. **アニメーションを断る**。WebP は `ANIM` / `ANMF` チャンクと VP8X のフラグ、APNG は `acTL` チャンクを
 *    バイト列で探し、**加えて sharp の `pages` も見る**。**libvips は APNG を 1 枚の PNG として読むので
 *    `pages` では見えない**（`test/encode.test.mjs` で実測した）——sharp の読み取りだけに頼らない
 * 3. **寸法と容量の上限を超えたら断る**（黙って縮めない）。復号の前に `limitInputPixels` でも止める
 * 4. **中央を正方形に切り抜き、{@link EncodeConfig.size} の WebP にする**（利用者の決定）。Exif の向きは
 *    画素へ反映してから捨てる（`rotate()`）
 * 5. **メタデータを出力に載せない**——sharp は `keepMetadata` / `withMetadata` を呼ばない限り、Exif・
 *    ICC・XMP を出力へ写さない。**これをテストで確かめる**（`test/encode.test.mjs`。GPS を含む
 *    Exif と XMP を入れた JPEG から、出力に何も残らないこと）
 *
 * **Worker も 1〜3 を先に確かめている**（`src/avatar-image.ts`）。ここでもう一度見るのは、Worker の
 * 判定が緩んだ日にこちらが断るためである（2 つの層のどちらかが緩んでも、もう片方が断る）。
 *
 * **断る理由の綴り（{@link REJECTIONS}）は `src/avatar-client.ts` の `AVATAR_ENCODE_REJECTIONS` と
 * 同じでなければならない**（`scripts/check-avatar-copies.sh` が見る）。
 */
import sharp from 'sharp';

/** 断る理由（`src/avatar-client.ts` の写しと一致させる）。 */
export const REJECTIONS = ['unsupported', 'animated', 'too-large', 'broken'];

/**
 * @typedef {{ size: number, maxInputBytes: number, maxInputDimension: number, webpQuality: number }} EncodeConfig
 * @typedef {{ ok: true, webp: Buffer } | { ok: false, reason: 'unsupported' | 'animated' | 'too-large' | 'broken' }} EncodeResult
 */

/**
 * 署名から形式を決める（PNG / JPEG / WebP 以外は null）。
 *
 * @param {Uint8Array} bytes 入力
 * @returns {'png' | 'jpeg' | 'webp' | null} 形式
 */
export function sniffFormat(bytes) {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  const ascii = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length >= 12 && ascii(0) === 'RIFF' && ascii(8) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/**
 * APNG の `acTL` チャンクが、最初の `IDAT` より前にあるか。
 *
 * @param {Uint8Array} bytes PNG の入力
 * @returns {boolean} アニメーション PNG なら true
 */
export function hasApngControl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL') {
      return true;
    }
    if (type === 'IDAT' || type === 'IEND') {
      return false;
    }
    offset += 12 + length;
  }
  return false;
}

/**
 * WebP がアニメーションか（`ANIM` / `ANMF` チャンク、または VP8X の animation フラグ）。
 *
 * @param {Uint8Array} bytes WebP の入力
 * @returns {boolean} アニメーション WebP なら true
 */
export function hasWebpAnimation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (type === 'ANIM' || type === 'ANMF') {
      return true;
    }
    if (type === 'VP8X' && offset + 9 <= bytes.length && (bytes[offset + 8] & 0x02) !== 0) {
      return true;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

/**
 * 入力を検査し、中央を正方形に切り抜いた WebP にする。
 *
 * @param {Uint8Array} input 利用者が上げた画像
 * @param {EncodeConfig} config 設定（`config.mjs`）
 * @returns {Promise<EncodeResult>} 変換した WebP、または断る理由
 */
export async function encodeAvatar(input, config) {
  if (!(input instanceof Uint8Array) || input.length === 0) {
    return { ok: false, reason: 'broken' };
  }
  if (input.length > config.maxInputBytes) {
    return { ok: false, reason: 'too-large' };
  }
  const format = sniffFormat(input);
  if (format === null) {
    // **sharp に渡さない**（SVG を librsvg に解釈させない。モジュール冒頭）。
    return { ok: false, reason: 'unsupported' };
  }
  if ((format === 'png' && hasApngControl(input)) || (format === 'webp' && hasWebpAnimation(input))) {
    return { ok: false, reason: 'animated' };
  }

  const limitInputPixels = config.maxInputDimension * config.maxInputDimension;
  let metadata;
  try {
    metadata = await sharp(input, { limitInputPixels, failOn: 'error' }).metadata();
  } catch {
    return { ok: false, reason: 'broken' };
  }
  if (metadata.format !== format) {
    // 署名と中身が食い違う（署名だけを付けた別の形式）。
    return { ok: false, reason: 'unsupported' };
  }
  if (typeof metadata.pages === 'number' && metadata.pages > 1) {
    return { ok: false, reason: 'animated' };
  }
  const width = metadata.width;
  const height = metadata.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) {
    return { ok: false, reason: 'broken' };
  }
  if (width > config.maxInputDimension || height > config.maxInputDimension) {
    return { ok: false, reason: 'too-large' };
  }

  try {
    const webp = await sharp(input, { limitInputPixels, failOn: 'error' })
      // Exif の向きを画素へ反映する（メタデータそのものは下の出力に載らない）。
      .rotate()
      // **中央を正方形に切り抜き、縮める**（小さい画像は引き伸ばして同じ大きさに揃える）。
      .resize(config.size, config.size, { fit: 'cover', position: 'centre' })
      .webp({ quality: config.webpQuality })
      .toBuffer();
    return { ok: true, webp };
  } catch {
    return { ok: false, reason: 'broken' };
  }
}
