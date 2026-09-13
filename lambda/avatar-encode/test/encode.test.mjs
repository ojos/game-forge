/**
 * アイコンの再エンコード（`lambda/avatar-encode/encode.mjs`）の検査（#380 / 仕様 5.10）。
 *
 * **Node で走る**（sharp はネイティブのライブラリで、workerd では動かない）。`scripts/acceptance.sh` が
 * `node --test` で回す（`scripts/verify.sh` の経路）。sharp はルートの `package.json` の
 * devDependencies が入れる（版は関数の `package.json` と同じ。`scripts/check-avatar-copies.sh` が見る）。
 *
 * # この検査が見ているもの（#380 の acceptance）
 *
 *   1. **再エンコード後の画像に Exif（GPS を含む）も XMP も ICC も残らない**
 *   2. **SVG・GIF・アニメーション WebP・APNG が断られる**（変異で確認。PR の本文）
 *   3. **容量と寸法の上限を超えたら断る**（黙って縮めない）
 *   4. **中央を正方形に切り抜き、256px の WebP にする**（利用者の決定）
 */
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { REQUIRED_ENV, readConfig } from '../config.mjs';
import { encodeAvatar, hasApngControl, hasWebpAnimation, sniffFormat } from '../encode.mjs';

/** 検査に使う設定（宣言と同じ値。宣言そのものとの一致は scripts/check-avatar-copies.sh が見る）。 */
const CONFIG = { size: 256, maxInputBytes: 4 * 1024 * 1024, maxInputDimension: 4096, webpQuality: 80 };

/**
 * 単色の画像を作る。
 *
 * @param {number} width 幅
 * @param {number} height 高さ
 * @param {'png' | 'jpeg' | 'webp' | 'gif'} format 形式
 * @returns {Promise<Buffer>} 画像
 */
async function solid(width, height, format) {
  return await sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .toFormat(format)
    .toBuffer();
}

/**
 * PNG の IHDR の直後に `acTL` を差し込み、APNG の見出しにする。
 *
 * @param {Buffer} png 1 枚の PNG
 * @returns {Buffer} `acTL` を持つ PNG
 */
function withActl(png) {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2, 0); // num_frames
  data.writeUInt32BE(0, 4); // num_plays
  const type = Buffer.from('acTL', 'latin1');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
  // 署名（8）＋ IHDR（長さ 4 ＋ 種別 4 ＋ 中身 13 ＋ CRC 4 = 25）の直後。
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

describe('メタデータを落とす（acceptance: 再エンコード後の画像に Exif が残らない）', () => {
  it('GPS を含む Exif・XMP・ICC を持つ JPEG から、出力に何も残らない', async () => {
    const xmp =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ' +
      'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="35,40.0N" exif:GPSLongitude="139,45.0E"/>' +
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const input = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#cc3333' } })
      .jpeg()
      .withIccProfile('p3')
      .withExif({
        IFD0: { Copyright: 'secret-copyright-marker', Orientation: '1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '35/1 40/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '139/1 45/1 0/1' },
      })
      .withXmp(xmp)
      .toBuffer();
    // **入力には確かに入っている**（入っていない入力から「残らない」を確かめても空振りする）。
    const before = await sharp(input).metadata();
    assert.ok(before.exif && before.exif.length > 0, '入力に Exif がある');
    assert.ok(before.xmp && before.xmp.length > 0, '入力に XMP がある');
    assert.ok(before.icc && before.icc.length > 0, '入力に ICC がある');
    assert.ok(input.includes('secret-copyright-marker'), '入力に Exif の文字列がある');
    assert.ok(input.includes('GPSLatitude'), '入力に XMP の GPS がある');

    const result = await encodeAvatar(input, CONFIG);
    assert.equal(result.ok, true);
    const after = await sharp(result.webp).metadata();
    assert.equal(after.exif, undefined, '出力に Exif が無い');
    assert.equal(after.xmp, undefined, '出力に XMP が無い');
    assert.equal(after.icc, undefined, '出力に ICC が無い');
    // **バイト列でも確かめる**（sharp の読み取りが見落とす置き場所に残っていないこと）。
    for (const marker of ['Exif', 'EXIF', 'XMP ', 'ICCP', 'secret-copyright-marker', 'GPSLatitude']) {
      assert.equal(result.webp.includes(marker), false, `出力に ${marker} が無い`);
    }
  });
});

describe('中央を正方形に切り抜き、256px の WebP にする', () => {
  it('横長の画像は左右が落ち、真ん中の色だけが残る', async () => {
    // 左 200px が赤・真ん中 200px が緑・右 200px が青の 600 × 200。
    const width = 600;
    const height = 200;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        raw[index + (x < 200 ? 0 : x < 400 ? 1 : 2)] = 255;
      }
    }
    const input = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const result = await encodeAvatar(input, CONFIG);
    assert.equal(result.ok, true);
    const { data, info } = await sharp(result.webp).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 256);
    assert.equal(info.height, 256);
    const channels = info.channels;
    for (const [x, y] of [[4, 4], [251, 4], [128, 128], [4, 251], [251, 251]]) {
      const index = (y * 256 + x) * channels;
      assert.ok(data[index + 1] > 200 && data[index] < 60 && data[index + 2] < 60, `(${x}, ${y}) は緑`);
    }
    assert.equal((await sharp(result.webp).metadata()).format, 'webp');
  });

  it('PNG / JPEG / WebP を受け付け、小さい画像も 256px に揃える', async () => {
    for (const format of ['png', 'jpeg', 'webp']) {
      const result = await encodeAvatar(await solid(32, 48, format), CONFIG);
      assert.equal(result.ok, true, format);
      const metadata = await sharp(result.webp).metadata();
      assert.deepEqual([metadata.format, metadata.width, metadata.height], ['webp', 256, 256], format);
    }
  });
});

describe('形式とアニメーションを断る（acceptance: SVG とアニメーション画像が断られる）', () => {
  it('SVG は sharp に渡さずに断る', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
    assert.equal(sniffFormat(svg), null);
    assert.deepEqual(await encodeAvatar(svg, CONFIG), { ok: false, reason: 'unsupported' });
    // 先頭に XML 宣言や空白を置いても同じ。
    const xml = Buffer.from(`  <?xml version="1.0"?>${svg.toString()}`);
    assert.deepEqual(await encodeAvatar(xml, CONFIG), { ok: false, reason: 'unsupported' });
  });

  it('GIF は 1 枚でも断る', async () => {
    const gif = await solid(16, 16, 'gif');
    assert.deepEqual(await encodeAvatar(gif, CONFIG), { ok: false, reason: 'unsupported' });
  });

  it('アニメーション WebP を断る', async () => {
    // **2 枚の絵を変える**（同じ絵が続くと、符号化器が 1 枚に畳む）。上半分が赤、下半分が黒。
    const raw = Buffer.alloc(16 * 32 * 3, 0);
    for (let index = 0; index < 16 * 16 * 3; index += 3) {
      raw[index] = 255;
    }
    const animated = await sharp(raw, { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } })
      .webp({ loop: 0 })
      .toBuffer();
    // **入力が 2 枚の WebP であることを先に確かめる**（同じ絵が続くと 1 枚に畳まれ、検査が空振りする）。
    assert.equal((await sharp(animated).metadata()).pages, 2, '入力が 2 枚の WebP である');
    assert.equal(hasWebpAnimation(animated), true);
    assert.equal(hasWebpAnimation(await solid(16, 16, 'webp')), false);
    assert.deepEqual(await encodeAvatar(animated, CONFIG), { ok: false, reason: 'animated' });
  });

  it('APNG（最初の IDAT より前に acTL を持つ PNG）を断る', async () => {
    const png = await solid(16, 16, 'png');
    const apng = withActl(png);
    assert.equal(hasApngControl(png), false);
    assert.equal(hasApngControl(apng), true);
    // **libvips は APNG を 1 枚の PNG として読む**（`pages` では見えない）ことを確かめておく。
    assert.notEqual((await sharp(apng).metadata()).pages, 2);
    assert.deepEqual(await encodeAvatar(apng, CONFIG), { ok: false, reason: 'animated' });
  });

  it('署名だけ PNG で中身が壊れたものは broken', async () => {
    const broken = Buffer.concat([(await solid(16, 16, 'png')).subarray(0, 40), Buffer.alloc(40, 7)]);
    assert.deepEqual(await encodeAvatar(broken, CONFIG), { ok: false, reason: 'broken' });
  });
});

describe('上限を超えたら断る（黙って縮めない）', () => {
  it('幅か高さが上限を 1px でも超えれば断り、ちょうどなら通す', async () => {
    const small = { ...CONFIG, maxInputDimension: 64 };
    assert.deepEqual(await encodeAvatar(await solid(65, 10, 'png'), small), { ok: false, reason: 'too-large' });
    assert.deepEqual(await encodeAvatar(await solid(10, 65, 'jpeg'), small), { ok: false, reason: 'too-large' });
    assert.equal((await encodeAvatar(await solid(64, 64, 'webp'), small)).ok, true);
  });

  it('本当の上限（4096）を超える画像を断る', async () => {
    assert.deepEqual(await encodeAvatar(await solid(4097, 8, 'png'), CONFIG), { ok: false, reason: 'too-large' });
  });

  it('容量の上限を超えれば、復号する前に断る', async () => {
    const input = await solid(64, 64, 'png');
    assert.deepEqual(await encodeAvatar(input, { ...CONFIG, maxInputBytes: input.length - 1 }), {
      ok: false,
      reason: 'too-large',
    });
  });
});

describe('設定は既定値を持たない（config.mjs）', () => {
  it('宣言が 1 つでも欠けていれば、名前を出して落ちる', () => {
    const full = { AVATAR_SIZE: '256', MAX_INPUT_BYTES: '4194304', MAX_INPUT_DIMENSION: '4096', WEBP_QUALITY: '80' };
    assert.deepEqual(readConfig(full), CONFIG);
    for (const name of REQUIRED_ENV) {
      const partial = { ...full };
      delete partial[name];
      assert.throws(() => readConfig(partial), new RegExp(name));
    }
    assert.throws(() => readConfig({ ...full, WEBP_QUALITY: '101' }), /WEBP_QUALITY/);
    assert.throws(() => readConfig({ ...full, AVATAR_SIZE: 'abc' }), /AVATAR_SIZE/);
  });

  it('文字列全体が正の整数の綴りでなければ落ちる（parseInt のように先頭の数だけを読まない）', () => {
    const full = { AVATAR_SIZE: '256', MAX_INPUT_BYTES: '4194304', MAX_INPUT_DIMENSION: '4096', WEBP_QUALITY: '80' };
    for (const bad of ['256junk', '4096.9', '', ' ', '0', '-1', '+256', '0256', ' 256', '256 ', '1e3', '0x100']) {
      for (const name of REQUIRED_ENV) {
        assert.throws(() => readConfig({ ...full, [name]: bad }), new RegExp(name), `${name}=${JSON.stringify(bad)}`);
      }
    }
  });
});
