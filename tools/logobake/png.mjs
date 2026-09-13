// png.mjs — 色数の少ないドット絵を、パレット形式の PNG へ符号化・復号する（#438）。
//
// **依存パッケージを持たない。** sharp は devDependencies にあるが、libvips の版で
// 出力が変わりうるうえ、ドット絵に要るのは「数色を 1 画素 1 バイトで並べる」ことだけで
// ある。圧縮は node:zlib に任せる。
//
// **復号も持つ理由は照合のためである。** zlib は版が変わると同じ入力から別のバイト列を
// 出しうるので、コミット済みの PNG との照合をバイト一致だけにすると、Node を上げた日に
// 絵が 1 画素も変わっていないのに落ちる。照合は画素で行う（main.mjs の checkAll）。

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 の表（PNG のチャンク末尾の検査値に使う）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * バイト列の CRC-32 を返す。
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * PNG のチャンクを 1 つ組み立てる。
 * @param {string} type 4 文字のチャンク種別
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * @typedef {object} IndexedImage
 * @property {number} width
 * @property {number} height
 * @property {string[]} palette `#RRGGBB` か、完全な透明を表す `transparent`
 * @property {Uint8Array} pixels 行優先で 1 画素 1 バイトのパレット添字
 */

/**
 * `#RRGGBB` を [r, g, b] に分解する。
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function rgbOf(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`色の書式が #RRGGBB ではない: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * パレット形式（色型 3・8 ビット）の PNG へ符号化する。
 *
 * 各行のフィルタは 0（なし）に固定する。ドット絵は同じ値の連続が長く、deflate だけで
 * 十分に縮むうえ、出力が入力から一通りに決まる。
 * @param {IndexedImage} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, palette, pixels }) {
  if (palette.length === 0 || palette.length > 256) throw new Error(`パレットの色数が範囲外: ${palette.length}`);
  if (pixels.length !== width * height) throw new Error(`画素数が寸法と合わない: ${pixels.length} != ${width}×${height}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 3; // 色型: パレット
  const plte = Buffer.alloc(palette.length * 3);
  const trns = Buffer.alloc(palette.length, 0xff);
  palette.forEach((c, i) => {
    if (c === 'transparent') { trns[i] = 0; return; }
    const [r, g, b] = rgbOf(c);
    plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b;
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (palette.includes('transparent')) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * @typedef {object} RgbaImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} rgba 行優先で 1 画素 4 バイト。完全な透明は色を 0 に揃える
 */

/**
 * パレット画像を RGBA へ展開する。完全な透明の画素は色を持たないものとして 0 に揃える
 * （透明な画素の色の違いは見た目の違いではないため、照合で差にしない）。
 * @param {IndexedImage} image
 * @returns {RgbaImage}
 */
export function toRgba({ width, height, palette, pixels }) {
  const table = palette.map((c) => (c === 'transparent' ? [0, 0, 0, 0] : [...rgbOf(c), 255]));
  const rgba = new Uint8Array(width * height * 4);
  pixels.forEach((p, i) => rgba.set(table[p], i * 4));
  return { width, height, rgba };
}

/**
 * 1 行分のフィルタを外す（PNG 仕様の 5 種）。
 * @param {number} type
 * @param {Uint8Array} line 書き換える行
 * @param {Uint8Array} prev 直前の（フィルタを外した）行
 * @param {number} bpp 1 画素のバイト数
 */
function unfilter(type, line, prev, bpp) {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let add;
    switch (type) {
      case 0: add = 0; break;
      case 1: add = a; break;
      case 2: add = b; break;
      case 3: add = (a + b) >> 1; break;
      case 4: {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        break;
      }
      default: throw new Error(`未知のフィルタ種別: ${type}`);
    }
    line[i] = (line[i] + add) & 0xff;
  }
}

/**
 * PNG を RGBA へ復号する。受け付けるのは 8 ビットのパレット・RGB・RGBA で、
 * インターレースは受け付けない（このツールが書く形と、一般的な最適化ツールが
 * 書き直しうる形だけを読めればよい）。
 * @param {Buffer} buf
 * @returns {RgbaImage}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG の署名ではない');
  let off = 8, width = 0, height = 0, colorType = -1, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
      if (data[8] !== 8) throw new Error(`ビット深度 ${data[8]} は受け付けない`);
      if (data[12] !== 0) throw new Error('インターレースは受け付けない');
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = { 3: 1, 2: 3, 6: 4 }[colorType];
  if (!bpp) throw new Error(`色型 ${colorType} は受け付けない`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const line = Uint8Array.from(raw.subarray(base + 1, base + 1 + stride));
    unfilter(raw[base], line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let px;
      if (colorType === 3) {
        const i = line[x];
        px = [plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], trns && i < trns.length ? trns[i] : 255];
      } else if (colorType === 2) {
        px = [line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255];
      } else {
        px = [line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]];
      }
      if (px[3] === 0) px = [0, 0, 0, 0];
      rgba.set(px, o);
    }
    prev = line;
  }
  return { width, height, rgba };
}
