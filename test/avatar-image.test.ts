import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_DIMENSION, inspectAvatarImage } from '../src/avatar-image.js';
import {
  ascii,
  concatBytes,
  gifBytes,
  heifBytes,
  jpegBytes,
  pngBytes,
  svgBytes,
  webpVp8Bytes,
  webpVp8lBytes,
  webpVp8xBytes,
} from './helpers/avatar-images.js';

/**
 * アイコンの一次判定——先頭のバイトで形式・アニメーション・寸法を確かめる（#380 / 仕様 5.10）。
 *
 * # この検査が見ているもの（#380 の acceptance のうち、Worker の層）
 *
 *   1. **SVG と GIF を断る**（許す形式の署名で始まらないものはすべて断る）
 *   2. **アニメーション画像を断る**——APNG（最初の IDAT より前の acTL）、アニメーション WebP（VP8X の
 *      フラグ・ANIM / ANMF チャンク）
 *   3. **寸法の上限を超えたら断る**（黙って縮めない）
 *
 * **変異で確認した**（PR の本文に列挙）。関数の層（sharp で復号する側）の同じ検査は
 * `lambda/avatar-encode/test/encode.test.mjs` が持つ。
 */

describe('受け付ける形式（PNG / JPEG / WebP）と寸法', () => {
  it('PNG・JPEG（ベースラインとプログレッシブ）・WebP（VP8 / VP8L / VP8X）の寸法を読む', () => {
    expect(inspectAvatarImage(pngBytes(640, 480))).toEqual({ ok: true, format: 'png', width: 640, height: 480 });
    expect(inspectAvatarImage(jpegBytes(4032, 3024))).toEqual({ ok: true, format: 'jpeg', width: 4032, height: 3024 });
    expect(inspectAvatarImage(jpegBytes(300, 200, 0xc2))).toEqual({ ok: true, format: 'jpeg', width: 300, height: 200 });
    expect(inspectAvatarImage(webpVp8Bytes(320, 240))).toEqual({ ok: true, format: 'webp', width: 320, height: 240 });
    expect(inspectAvatarImage(webpVp8lBytes(256, 256))).toEqual({ ok: true, format: 'webp', width: 256, height: 256 });
    expect(inspectAvatarImage(webpVp8xBytes(1000, 2000))).toEqual({ ok: true, format: 'webp', width: 1000, height: 2000 });
  });

  it(`幅か高さが ${AVATAR_MAX_DIMENSION} を 1px でも超えれば断り、ちょうどなら通す（黙って縮めない）`, () => {
    const limit = AVATAR_MAX_DIMENSION;
    expect(inspectAvatarImage(pngBytes(limit, limit)).ok).toBe(true);
    for (const bytes of [
      pngBytes(limit + 1, 10),
      pngBytes(10, limit + 1),
      jpegBytes(limit + 1, 10),
      webpVp8xBytes(10, limit + 1),
      webpVp8lBytes(limit + 1, 1),
    ]) {
      expect(inspectAvatarImage(bytes)).toEqual({ ok: false, reason: 'avatar-too-large-dimensions' });
    }
  });

  it('署名はあるが寸法を読めないもの（途中で切れた・0px）は broken', () => {
    expect(inspectAvatarImage(pngBytes(640, 480).subarray(0, 20))).toEqual({ ok: false, reason: 'avatar-broken' });
    expect(inspectAvatarImage(pngBytes(0, 10))).toEqual({ ok: false, reason: 'avatar-broken' });
    expect(inspectAvatarImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ ok: false, reason: 'avatar-broken' });
    expect(inspectAvatarImage(concatBytes(ascii('RIFF'), [4, 0, 0, 0], ascii('WEBP')))).toEqual({
      ok: false,
      reason: 'avatar-broken',
    });
  });
});

describe('SVG とアニメーション画像を断る（acceptance。変異で確認）', () => {
  it('SVG は断る（XML 宣言で始まっても、<svg で始まっても）', () => {
    expect(inspectAvatarImage(svgBytes())).toEqual({ ok: false, reason: 'avatar-svg' });
    expect(inspectAvatarImage(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      ok: false,
      reason: 'avatar-svg',
    });
  });

  it('GIF は 1 枚でも断る', () => {
    expect(inspectAvatarImage(gifBytes())).toEqual({ ok: false, reason: 'avatar-gif' });
  });

  it('APNG（最初の IDAT より前の acTL）を断り、IDAT の後ろの acTL は見ない', () => {
    expect(inspectAvatarImage(pngBytes(64, 64, { actl: true }))).toEqual({ ok: false, reason: 'avatar-animated' });
    // APNG の仕様では acTL は IDAT の前にしか置けず、後ろの acTL はブラウザも無視する。
    expect(inspectAvatarImage(pngBytes(64, 64, { actlAfterIdat: true })).ok).toBe(true);
  });

  it('アニメーション WebP を断る（VP8X のフラグだけでも、ANIM / ANMF のチャンクだけでも）', () => {
    expect(inspectAvatarImage(webpVp8xBytes(64, 64, { animatedFlag: true }))).toEqual({
      ok: false,
      reason: 'avatar-animated',
    });
    expect(inspectAvatarImage(webpVp8xBytes(64, 64, { animChunk: true }))).toEqual({
      ok: false,
      reason: 'avatar-animated',
    });
  });

  it('大きなアニメーション画像は「大きすぎる」より先に「動く画像」として断る', () => {
    expect(inspectAvatarImage(pngBytes(AVATAR_MAX_DIMENSION + 1, 10, { actl: true }))).toEqual({
      ok: false,
      reason: 'avatar-animated',
    });
  });

  it('PNG / JPEG / WebP / GIF / SVG のどれでもないもの（HEIF・BMP・文字列・空）は unsupported', () => {
    for (const bytes of [ascii('hello'), new Uint8Array(0), heifBytes(), ascii('BM6')]) {
      expect(inspectAvatarImage(bytes)).toEqual({ ok: false, reason: 'avatar-unsupported' });
    }
  });
});
