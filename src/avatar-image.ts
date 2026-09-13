/**
 * アイコン画像の一次判定——**先頭のバイトを読んで、形式・アニメーション・寸法を確かめる**
 * （#380 / M12-12 / 仕様 5.10）。
 *
 * **画像を復号しない。** 読むのはファイルの冒頭の署名とチャンク（セグメント）の見出しだけで、
 * 画素には 1 バイトも触らない。**復号と再エンコードは Lambda が持つ**（`lambda/avatar-encode/`。
 * Worker の CPU 時間（無料枠 10 ms）で 4 MiB の画像を復号する形は取れない）。
 *
 * ## なぜ Worker でも判定するのか（Lambda も同じことを確かめる）
 *
 * 1. **断る画像のために Lambda を呼ばない。** SVG・GIF・アニメーション・上限を超えた寸法は、
 *    ここで断れば AWS に 1 バイトも送らない
 * 2. **断る理由を利用者の言葉で返せる。** Lambda の失敗は「変換できなかった」の 1 種類に畳まれる
 * 3. **workerd の上でテストできる**（`test/avatar-image.test.ts`）。Lambda 側の判定は Node の
 *    テストが持つ（`lambda/avatar-encode/test/`）——**2 つの層のどちらかが緩んでも、もう片方が断る**
 *
 * ## 形式は中身で決める（拡張子も `Content-Type` も見ない）
 *
 * ブラウザが送る `Content-Type` は拡張子から決まり、利用者がどうにでもできる。**PNG / JPEG / WebP の
 * 署名で始まらないものはすべて断る**——SVG（テキスト）も GIF（`GIF8`）も HEIC もここで落ちる。
 * **SVG を名指しで探さない**（許す形式の一覧で判定する。探す形は、探し漏れた綴りを通す）。
 * 断る理由の文言だけは、SVG と GIF を名指しで出す（{@link AvatarImageRejection}）。
 *
 * ## アニメーションを探す場所
 *
 * | 形式 | 印 | 置き場所 |
 * |---|---|---|
 * | PNG（APNG） | `acTL` チャンク | **最初の `IDAT` より前**（APNG の仕様。後ろに置かれた `acTL` はブラウザも無視する） |
 * | WebP | `VP8X` の animation フラグ、または `ANIM` / `ANMF` チャンク | `RIFF` の中のチャンク列 |
 * | GIF | —— | **形式ごと断る**（1 枚の GIF も受け付けない。利用者の決定） |
 *
 * **APNG は `IDAT` の前だけを見る。** そこで打ち切れば、巨大な画素データを読み進めない。
 * WebP はチャンク列を最後まで辿る（見出しだけを読み、中身は長さで飛ばす）。
 *
 * ## 寸法
 *
 * | 形式 | 読む場所 |
 * |---|---|
 * | PNG | `IHDR`（署名の直後。仕様で最初のチャンク） |
 * | JPEG | 最初の SOF マーカー（`FFC0`〜`FFCF` のうち `C4` / `C8` / `CC` を除く） |
 * | WebP | `VP8X` のキャンバス寸法、無ければ `VP8 ` / `VP8L` のビットストリームの見出し |
 *
 * **寸法を読めない画像は断る**（壊れているか、ここが知らない形である）。**幅と高さの両方が
 * 1 以上 {@link AVATAR_MAX_DIMENSION} 以下のときだけ通す。**
 */

/**
 * 受け付けるファイルの最大バイト数（**4 MiB**）。
 *
 * **スマートフォンの写真（1,200 万画素の JPEG で 2〜4 MB）を、縮めずにそのまま上げられる大きさ**
 * にした。**超えたら断る**（黙って縮めない。5.10 / 4.4）。
 *
 * **Lambda の同期呼び出しの上限（要求 6 MB）に収まる。** 画像は base64 で JSON に載るので 4/3 に
 * 太り、4 MiB は 5,592,408 バイトになる（`src/avatar-client.ts`）。
 */
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 幅と高さの上限（px。**それぞれ 4096 まで**）。
 *
 * **1,200 万画素の写真（4032 × 3024）が入る最小の 2 の冪**にした。上限は画素数の爆弾
 * （小さなファイルが復号で数 GB に膨らむ PNG）を Lambda へ渡さないために置く——4096 × 4096 の
 * RGBA は 64 MB で、関数のメモリ（`terraform/avatar-function.tf`）に余裕を持って収まる。
 */
export const AVATAR_MAX_DIMENSION = 4096;

/** 受け付ける形式。 */
export type AvatarImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * 一次判定で断る理由（`/account?reason=` に載る綴り）。
 *
 * - `avatar-svg` … SVG（テキストの画像。スクリプトを埋められる）
 * - `avatar-gif` … GIF（アニメーションになりうる形式ごと断る）
 * - `avatar-unsupported` … PNG / JPEG / WebP のどれでもない
 * - `avatar-animated` … APNG・アニメーション WebP
 * - `avatar-too-large-dimensions` … 幅か高さが {@link AVATAR_MAX_DIMENSION} を超える
 * - `avatar-broken` … 署名はあるが、寸法を読めない（途中で切れている・壊れている）
 */
export type AvatarImageRejection =
  | 'avatar-svg'
  | 'avatar-gif'
  | 'avatar-unsupported'
  | 'avatar-animated'
  | 'avatar-too-large-dimensions'
  | 'avatar-broken';

/** 一次判定の結果。 */
export type AvatarImageInspection =
  | {
      readonly ok: true;
      readonly format: AvatarImageFormat;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly reason: AvatarImageRejection };

/** PNG の署名（8 バイト）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 形式の判定で、テキスト（SVG）かを見るために読む先頭のバイト数。 */
const TEXT_SNIFF_BYTES = 512;

/**
 * 先頭のバイトを読んで、受け付けてよい画像かを判定する。
 *
 * **判定の順**: 形式（署名）→ アニメーション → 寸法。**アニメーションを寸法より先に見る**——
 * 大きなアニメーション画像を「大きすぎる」と断ると、縮めて上げ直した人がもう一度断られる。
 *
 * @param bytes ファイルの中身
 * @returns 形式と寸法、または断る理由
 */
export function inspectAvatarImage(bytes: Uint8Array): AvatarImageInspection {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return inspectPng(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return inspectJpeg(bytes);
  }
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return inspectWebp(bytes);
  }
  if (asciiAt(bytes, 0, 4) === 'GIF8') {
    return { ok: false, reason: 'avatar-gif' };
  }
  if (looksLikeSvg(bytes)) {
    return { ok: false, reason: 'avatar-svg' };
  }
  return { ok: false, reason: 'avatar-unsupported' };
}

/**
 * PNG を判定する（`IHDR` の寸法と、最初の `IDAT` より前の `acTL`）。
 *
 * @param bytes ファイルの中身（PNG の署名で始まる）
 * @returns 判定
 */
function inspectPng(bytes: Uint8Array): AvatarImageInspection {
  // 署名（8）の直後が IHDR：長さ（4）・種別（4）・幅（4）・高さ（4）…
  if (bytes.length < 33 || asciiAt(bytes, 12, 4) !== 'IHDR') {
    return { ok: false, reason: 'avatar-broken' };
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);

  let offset = 8;
  // **チャンクの見出しだけを辿る。** 長さ（4）＋種別（4）＋中身（長さ）＋CRC（4）。
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = asciiAt(bytes, offset + 4, 4);
    if (type === 'acTL') {
      return { ok: false, reason: 'avatar-animated' };
    }
    if (type === 'IDAT' || type === 'IEND') {
      // APNG の `acTL` は最初の `IDAT` より前にしか置けない（ここで打ち切る）。
      break;
    }
    offset += 12 + length;
  }
  return dimensionsVerdict('png', width, height);
}

/**
 * JPEG を判定する（最初の SOF マーカーの寸法）。
 *
 * **マーカーを長さで飛ばして辿る。** APP1（Exif）は数十 KB になりうるが、中身は読まない。
 *
 * @param bytes ファイルの中身（`FFD8` で始まる）
 * @returns 判定
 */
function inspectJpeg(bytes: Uint8Array): AvatarImageInspection {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return { ok: false, reason: 'avatar-broken' };
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      // 詰め物の FF。1 バイト進める。
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // 長さを持たないマーカー（SOI / TEM / RSTn）。
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // EOI / SOS に SOF より先に着いた。寸法を持たない壊れた JPEG である。
      return { ok: false, reason: 'avatar-broken' };
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) {
      return { ok: false, reason: 'avatar-broken' };
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // FF Cn・長さ（2）・精度（1）・高さ（2）・幅（2）
      if (offset + 9 > bytes.length) {
        return { ok: false, reason: 'avatar-broken' };
      }
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return dimensionsVerdict('jpeg', width, height);
    }
    offset += 2 + length;
  }
  return { ok: false, reason: 'avatar-broken' };
}

/**
 * WebP を判定する（`VP8X` のフラグとキャンバス寸法、`ANIM` / `ANMF`、`VP8 ` / `VP8L` の見出し）。
 *
 * @param bytes ファイルの中身（`RIFF....WEBP` で始まる）
 * @returns 判定
 */
function inspectWebp(bytes: Uint8Array): AvatarImageInspection {
  let width: number | null = null;
  let height: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = asciiAt(bytes, offset, 4);
    const size = readUint32Le(bytes, offset + 4);
    const data = offset + 8;
    if (type === 'ANIM' || type === 'ANMF') {
      return { ok: false, reason: 'avatar-animated' };
    }
    if (type === 'VP8X' && data + 10 <= bytes.length) {
      // フラグ（1）・予約（3）・キャンバス幅-1（3）・キャンバス高さ-1（3）。animation は 0x02。
      if ((bytes[data]! & 0x02) !== 0) {
        return { ok: false, reason: 'avatar-animated' };
      }
      width ??= readUint24Le(bytes, data + 4) + 1;
      height ??= readUint24Le(bytes, data + 7) + 1;
    } else if (type === 'VP8 ' && data + 10 <= bytes.length) {
      // フレームタグ（3）・開始コード 9D 01 2A（3）・幅（14 ビット）・高さ（14 ビット）
      if (bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        width ??= ((bytes[data + 7]! << 8) | bytes[data + 6]!) & 0x3fff;
        height ??= ((bytes[data + 9]! << 8) | bytes[data + 8]!) & 0x3fff;
      }
    } else if (type === 'VP8L' && data + 5 <= bytes.length) {
      // 署名 0x2F・幅-1（14 ビット）・高さ-1（14 ビット）（リトルエンディアンのビット列）
      if (bytes[data] === 0x2f) {
        const bits = bytes[data + 1]! | (bytes[data + 2]! << 8) | (bytes[data + 3]! << 16) | (bytes[data + 4]! << 24);
        width ??= (bits & 0x3fff) + 1;
        height ??= ((bits >>> 14) & 0x3fff) + 1;
      }
    }
    // チャンクは偶数長へ詰める（RIFF の規約）。
    offset = data + size + (size % 2);
  }
  if (width === null || height === null) {
    return { ok: false, reason: 'avatar-broken' };
  }
  return dimensionsVerdict('webp', width, height);
}

/**
 * 寸法の上限を当てる。
 *
 * @param format 形式
 * @param width 幅
 * @param height 高さ
 * @returns 判定
 */
function dimensionsVerdict(format: AvatarImageFormat, width: number, height: number): AvatarImageInspection {
  if (width < 1 || height < 1) {
    return { ok: false, reason: 'avatar-broken' };
  }
  if (width > AVATAR_MAX_DIMENSION || height > AVATAR_MAX_DIMENSION) {
    return { ok: false, reason: 'avatar-too-large-dimensions' };
  }
  return { ok: true, format, width, height };
}

/**
 * テキストの SVG に見えるか（**断る理由の文言を選ぶためだけに使う**。判定そのものは署名の一覧で済んでいる）。
 *
 * @param bytes ファイルの中身
 * @returns `<svg` か `<?xml` を先頭近くに含めば true
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, TEXT_SNIFF_BYTES))
    .toLowerCase();
  return head.includes('<svg') || head.trimStart().startsWith('<?xml');
}

/**
 * 先頭が指定のバイト列と一致するか。
 *
 * @param bytes ファイルの中身
 * @param prefix 期待するバイト列
 * @returns 一致すれば true
 */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

/**
 * 指定の位置から ASCII の文字列を読む（範囲外は空文字）。
 *
 * @param bytes ファイルの中身
 * @param offset 位置
 * @param length バイト数
 * @returns 文字列
 */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) {
    return '';
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * 32 ビットの符号なし整数（ビッグエンディアン）を読む。
 *
 * @param bytes ファイルの中身
 * @param offset 位置
 * @returns 値
 */
function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

/**
 * 32 ビットの符号なし整数（リトルエンディアン）を読む。
 *
 * @param bytes ファイルの中身
 * @param offset 位置
 * @returns 値
 */
function readUint32Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 3]! << 24) >>> 0) + (bytes[offset + 2]! << 16) + (bytes[offset + 1]! << 8) + bytes[offset]!;
}

/**
 * 24 ビットの符号なし整数（リトルエンディアン）を読む。
 *
 * @param bytes ファイルの中身
 * @param offset 位置
 * @returns 値
 */
function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset + 2]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset]!;
}
