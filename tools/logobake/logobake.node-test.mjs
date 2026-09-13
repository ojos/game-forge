// logobake.node-test.mjs — ロゴの書き出しのテスト（#438）。
//
// `node --test tools/logobake/logobake.node-test.mjs` で走る（scripts/acceptance.sh が呼ぶ）。
//
// **名前を `*.test.mjs` にしないのは、vitest に拾わせないため。** vitest はこのリポジトリで
// workerd の上でテストを走らせ、そこには node:fs / node:os が無い。vitest.config.ts の
// exclude に足す手もあるが、あの行は並行する #436 も触っており、名前で避けるほうが衝突しない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SYMBOL, emboldenGlyph, scaleGrid, setText, trimGrid, wordmark } from './logo.mjs';
import { readGlyphs } from './glyphs.mjs';
import { listVariants } from './variants.mjs';
import { renderVariant } from './render.mjs';
import { encodePng, decodePng, toRgba } from './png.mjs';
import { writeAll, checkAll } from './main.mjs';

test('シンボルは 16×16 で、記号は 3 種だけ', () => {
  assert.equal(SYMBOL.length, 16);
  for (const row of SYMBOL) assert.match(row, /^[.KA]{16}$/);
});

test('jpfont のグリフを読める（「G」の上 3 行を固定値で照合）', () => {
  // glyphs_gen.go の U+0047 を手で復号した値。焼き直しで形が変わったら、ここが落ちて気づける。
  const g = readGlyphs().get('G');
  assert.deepEqual(g.slice(1, 4).map((r) => r.slice(0, 8)), ['..###...', '.#...#..', '#.....#.']);
});

test('ASCII のグリフは送り幅 8 ドットの外に点を持たない（切り出しで欠けない）', () => {
  for (const [ch, rows] of readGlyphs()) {
    if (ch.codePointAt(0) > 0x7e) continue;
    for (const row of rows) assert.doesNotMatch(row.slice(8), /#/, `U+${ch.codePointAt(0).toString(16)}`);
  }
});

test('太らせると幅が 1 列増え、各点の右隣が点になり、元の点は消えない', () => {
  assert.deepEqual(emboldenGlyph(['#.#.', '....']), ['KKKK.', '.....']);
  assert.deepEqual(emboldenGlyph(['..#.']), ['..KK.']);
});

test('文字は jpfont のグリフを 1 文字ずつ太らせて並べたもので、語間だけを詰める', () => {
  const glyphs = readGlyphs();
  const half = (ch) => glyphs.get(ch).map((r) => r.slice(0, 8));
  const expected = Array.from({ length: 16 }, (_, y) =>
    [...'Game Forge'].map((ch) => (ch === ' ' ? '....' : emboldenGlyph(half(ch))[y])).join(''));
  assert.deepEqual(setText('Game Forge', { glyphs }), expected);
  assert.deepEqual(wordmark(glyphs), trimGrid(expected));
});

test('書体に無い文字は黙って空けず、例外にする', () => {
  assert.throws(() => setText('漢', { glyphs: readGlyphs() }), /書体に無い文字/);
});

test('拡大は整数倍だけを受け付ける', () => {
  assert.deepEqual(scaleGrid(['K.'], 2), ['KK..', 'KK..']);
  assert.throws(() => scaleGrid(['K'], 1.5));
});

test('一覧: 名前が重複せず、どの項目も画像に収まり、寸法が名前と一致する', () => {
  const variants = listVariants();
  assert.equal(new Set(variants.map((v) => v.path)).size, variants.length);
  for (const v of variants) {
    const img = renderVariant(v);
    assert.ok(Number.isInteger(v.scale) && v.scale >= 1, v.path);
    const px = v.path.match(/-(\d+)(?:x(\d+))?-/);
    if (px && !/-x\d+-/.test(v.path)) {
      assert.equal(img.width, Number(px[1]), v.path);
      assert.equal(img.height, Number(px[2] ?? px[1]), v.path);
    }
  }
});

test('一覧: 標準セットの種類と枚数', () => {
  const byDir = {};
  for (const v of listVariants()) byDir[v.path.split('/')[0]] = (byDir[v.path.split('/')[0]] ?? 0) + 1;
  assert.deepEqual(byDir, {
    symbol: 14, 'app-icon': 6, 'lockup-horizontal': 8, 'lockup-stacked': 6, wordmark: 8, social: 4,
  });
});

test('PNG: 書いたものを復号すると同じ画素に戻る', () => {
  for (const v of listVariants().filter((x) => x.path.includes('x1-') || x.path.includes('-16-') || x.path.includes('ogp'))) {
    const img = renderVariant(v);
    const got = decodePng(encodePng(img));
    const want = toRgba(img);
    assert.equal(got.width, want.width);
    assert.ok(Buffer.from(got.rgba).equals(Buffer.from(want.rgba)), v.path);
  }
});

test('PNG: フィルタ付きの RGBA でも画素で読める（別の道具で書き直された場合）', () => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  // 2×1 の RGBA、フィルタ 1（左との差分）。画素 [10,20,30,255] と [15,25,35,255]。
  const raw = Buffer.from([1, 10, 20, 30, 255, 5, 5, 5, 0]);
  const png = Buffer.concat([header, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  assert.deepEqual([...decodePng(png).rgba], [10, 20, 30, 255, 15, 25, 35, 255]);
});

test('照合: 書き出した直後は一致し、1 画素・欠落・余分をそれぞれ検出する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logobake-'));
  try {
    writeAll(dir);
    assert.deepEqual(checkAll(dir), []);

    // 画素を 1 つ変える（再圧縮してバイト列を変え、復号の経路を通す）。
    const target = 'symbol/symbol-16-for-light-bg.png';
    const v = listVariants().find((x) => x.path === target);
    const img = renderVariant(v);
    img.pixels[0] = 1;
    writeFileSync(join(dir, target), encodePng(img));
    assert.deepEqual(checkAll(dir), [`画素が違う: ${target}`]);

    // 圧縮だけが違う（画素は同じ）なら一致とみなす。
    const same = renderVariant(v);
    const recompressed = encodeWithLevel(same, 1);
    assert.notDeepEqual(recompressed, encodePng(same));
    writeFileSync(join(dir, target), recompressed);
    assert.deepEqual(checkAll(dir), []);

    rmSync(join(dir, target));
    assert.deepEqual(checkAll(dir), [`無い: ${target}`]);

    writeAll(dir);
    copyFileSync(join(dir, target), join(dir, 'symbol/old-name.png'));
    assert.deepEqual(checkAll(dir), ['一覧に無い PNG がある: symbol/old-name.png']);
    // 書き出し直すと余分は消える。
    writeAll(dir);
    assert.deepEqual(checkAll(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('照合: コミット済みの brand/logo/ が一覧と一致する', () => {
  assert.deepEqual(checkAll(), []);
});

/**
 * PNG のチャンクを組む（テストで壊れた・別形式の PNG を作るため）。
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  // decodePng は CRC を検査しないので 0 で埋める。
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

/**
 * encodePng と同じ画素を、圧縮の強さだけ変えて書く（バイト列だけが違う PNG を作るため）。
 * @param {import('./png.mjs').IndexedImage} img
 * @param {number} level
 * @returns {Buffer}
 */
function encodeWithLevel(img, level) {
  const buf = encodePng(img);
  const out = [];
  let off = 8;
  out.push(buf.subarray(0, 8));
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') {
      const raw = Buffer.alloc((img.width + 1) * img.height);
      for (let y = 0; y < img.height; y++) raw.set(img.pixels.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1);
      out.push(pngChunk('IDAT', deflateSync(raw, { level })));
    } else {
      out.push(buf.subarray(off, off + 12 + len));
    }
    off += 12 + len;
  }
  return Buffer.concat(out);
}
