/**
 * アイコンの一次判定（`src/avatar-image.ts`）に食わせる、**見出しだけの画像**を組み立てる（#380）。
 *
 * **workerd には画像のライブラリが無い**（sharp は Node のネイティブ）。一次判定が読むのは署名と
 * チャンクの見出しだけなので、**見出しを仕様どおりに並べたバイト列で足りる**。画素のデータは
 * 中身の無いダミーである（復号するテストは `lambda/avatar-encode/test/` が本物の画像で持つ）。
 */

/**
 * バイト列をつなぐ。
 *
 * @param parts 部分
 * @returns つないだバイト列
 */
export function concatBytes(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const total = arrays.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of arrays) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/**
 * ASCII の文字列をバイト列にする。
 *
 * @param text 文字列
 * @returns バイト列
 */
export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/**
 * 32 ビット（ビッグエンディアン）。
 *
 * @param value 値
 * @returns 4 バイト
 */
function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * 32 ビット（リトルエンディアン）。
 *
 * @param value 値
 * @returns 4 バイト
 */
function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * PNG のチャンク（CRC は 0 のダミー。一次判定は CRC を見ない）。
 *
 * @param type 種別
 * @param data 中身
 * @returns チャンク
 */
function pngChunk(type: string, data: readonly number[]): Uint8Array {
  return concatBytes(u32be(data.length), ascii(type), data, [0, 0, 0, 0]);
}

/**
 * PNG の見出し（IHDR → 任意のチャンク → IDAT → IEND）。
 *
 * @param width 幅
 * @param height 高さ
 * @param options `actl`: IDAT の前に acTL を置く / `actlAfterIdat`: IDAT の後ろに置く
 * @returns PNG
 */
export function pngBytes(
  width: number,
  height: number,
  options: { readonly actl?: boolean; readonly actlAfterIdat?: boolean } = {},
): Uint8Array {
  const actl = pngChunk('acTL', [...u32be(2), ...u32be(0)]);
  return concatBytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    options.actl === true ? actl : [],
    pngChunk('IDAT', [1, 2, 3, 4]),
    options.actlAfterIdat === true ? actl : [],
    pngChunk('IEND', []),
  );
}

/**
 * JPEG の見出し（SOI → APP1(Exif) → SOF → SOS → EOI）。
 *
 * @param width 幅
 * @param height 高さ
 * @param sofMarker SOF のマーカー（既定 0xC0。プログレッシブは 0xC2）
 * @returns JPEG
 */
export function jpegBytes(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  const exif = concatBytes(ascii('Exif'), [0, 0], new Uint8Array(300));
  return concatBytes(
    [0xff, 0xd8],
    [0xff, 0xe1, ((exif.length + 2) >> 8) & 0xff, (exif.length + 2) & 0xff],
    exif,
    [0xff, sofMarker, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3],
    new Uint8Array(9),
    [0xff, 0xda, 0x00, 0x0c],
    new Uint8Array(10),
    [0xff, 0xd9],
  );
}

/**
 * RIFF のチャンク。
 *
 * @param type 種別（4 文字）
 * @param data 中身
 * @returns チャンク（奇数長は詰める）
 */
function riffChunk(type: string, data: Uint8Array | readonly number[]): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  return concatBytes(ascii(type), u32le(bytes.length), bytes, bytes.length % 2 === 1 ? [0] : []);
}

/**
 * WebP を包む。
 *
 * @param chunks チャンク
 * @returns WebP
 */
function webp(...chunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(ascii('WEBP'), ...chunks);
  return concatBytes(ascii('RIFF'), u32le(body.length), body);
}

/**
 * 拡張形式（VP8X）の WebP。
 *
 * @param width キャンバスの幅
 * @param height キャンバスの高さ
 * @param options `animatedFlag`: VP8X のフラグを立てる / `animChunk`: ANIM と ANMF を置く（フラグは立てない）
 * @returns WebP
 */
export function webpVp8xBytes(
  width: number,
  height: number,
  options: { readonly animatedFlag?: boolean; readonly animChunk?: boolean } = {},
): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  const vp8x = riffChunk('VP8X', [
    options.animatedFlag === true ? 0x02 : 0x00,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
  const frames =
    options.animChunk === true
      ? [riffChunk('ANIM', [0, 0, 0, 0, 0, 0]), riffChunk('ANMF', new Uint8Array(16))]
      : [riffChunk('VP8L', [0x2f, 0, 0, 0, 0])];
  return webp(vp8x, ...frames);
}

/**
 * 非可逆（VP8）の WebP。
 *
 * @param width 幅
 * @param height 高さ
 * @returns WebP
 */
export function webpVp8Bytes(width: number, height: number): Uint8Array {
  return webp(
    riffChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f, 0, 0]),
  );
}

/**
 * 可逆（VP8L）の WebP。
 *
 * @param width 幅
 * @param height 高さ
 * @returns WebP
 */
export function webpVp8lBytes(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return webp(riffChunk('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]));
}

/**
 * 1 枚の GIF の見出し。
 *
 * @returns GIF
 */
export function gifBytes(): Uint8Array {
  return concatBytes(ascii('GIF89a'), [16, 0, 16, 0, 0, 0, 0], ascii(';'));
}

/**
 * スクリプトを埋めた SVG。
 *
 * @returns SVG
 */
export function svgBytes(): Uint8Array {
  return ascii('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
}

/**
 * HEIF の見出し（`ftyp` ボックス）。**許していない形式の代表**として使う。
 *
 * @returns HEIF の先頭
 */
export function heifBytes(): Uint8Array {
  return concatBytes(u32be(24), ascii('ftypheic'), new Uint8Array(12));
}
