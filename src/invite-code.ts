/**
 * 招待コードの生成・正規化・期限判定（8.1 / 7.3 / 11.1）。
 *
 * 招待コードは 7.3 が「費用 DoS に対する一次の防波堤」と位置づけるものであり、
 * 推測できてしまうと、その防波堤が機能しないまま月次上限だけが最終防御になる。
 *
 * このモジュールは **D1 に依存しない**。`invites` の永続化・二重使用の防止・
 * 招待枠の残数管理は #13 の T5 が持つ。分けているのは、生成と正規化の性質
 * （推測困難さ・入力の揺れの吸収）が、保存の同時実行性とは別に検証できるためで、
 * M1 の並列作業の前提でもある。
 */

/**
 * コードに使う文字集合（Crockford Base32）。
 *
 * `I` `L` `O` `U` を除く 32 文字。前の 3 つは `1` `0` と読み違えるため、`U` は
 * 偶然に不適切な語を綴る確率を下げるために除く。招待コードは口頭や画像で共有される
 * ことがあり、読み違えは「使えない」ではなく「他人のコードを試す」形で表面化する。
 *
 * **32 文字であること自体に意味がある。** 256 は 32 で割り切れるため、乱数バイトを
 * 剰余で写しても分布が偏らない（モジュロバイアスが出ない）。文字数を変える場合は、
 * 256 を割り切る数にするか、偏りを除く実装へ変えること。
 */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * コードの文字数（区切りを含まない）。
 *
 * 32 文字 × 12 桁で約 60 ビット。招待制の母数（数百件規模）に対して、総当たりは
 * 費用の面でも 7.3 の防波堤としても成立しない量になる。
 */
export const INVITE_CODE_LENGTH = 12;

/** 表示するときの区切り幅。`ABCD-EFGH-JKMN` の形にする。 */
const GROUP_SIZE = 4;

/**
 * 読み違えを吸収するための写像。
 *
 * 除外した文字を、対応する数字へ寄せる（Crockford の規定と同じ）。除外文字は
 * 生成側では決して出てこないため、この写像で衝突は起きない。
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  I: '1',
  L: '1',
  O: '0',
};

/**
 * 推測困難な招待コードを生成する。
 *
 * `crypto.getRandomValues` を使う。`Math.random` は暗号用途の保証を持たず、
 * ここでの推測可能性は 7.3 の防波堤を素通しにする。
 *
 * @returns 区切りなしの正規形（例: `ABCDEFGHJKMN`）
 */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    // 256 % 32 === 0 なので、剰余で写しても分布は偏らない。
    code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * 入力された招待コードを正規形へ揃える。
 *
 * 保存も照合も**正規形だけ**で行う。表示用の区切りや大文字小文字の揺れをそのまま
 * 保存すると、同じコードが複数の表現を持ち、二重使用の判定（T5）が
 * 「同じコードなのに別行に見える」形で破れる。
 *
 * @param input 利用者が入力した文字列（区切り・小文字・読み違えを含みうる）
 * @returns 正規形、または形式が不正なら null
 */
export function normalizeInviteCode(input: string): string | null {
  let normalized = '';
  for (const character of input.toUpperCase()) {
    // 区切りと空白は表示のためのものなので落とす。全角空白も含めるため
    // 正規表現ではなく明示した集合で判定する。
    if (character === '-' || character === ' ' || character === '　' || character === '\t') {
      continue;
    }
    const mapped = CONFUSABLES[character] ?? character;
    if (!INVITE_CODE_ALPHABET.includes(mapped)) {
      return null;
    }
    normalized += mapped;
    // 長さ超過はここで打ち切る。長い入力を延々と走査する理由がない。
    if (normalized.length > INVITE_CODE_LENGTH) {
      return null;
    }
  }
  return normalized.length === INVITE_CODE_LENGTH ? normalized : null;
}

/**
 * 正規形を表示用の区切り付きへ整える。
 *
 * 保存する値ではない。表示だけに使い、受け取った側は必ず
 * `normalizeInviteCode` を通すこと。
 *
 * @param code 正規形
 * @returns 区切り付きの文字列（例: `ABCD-EFGH-JKMN`）
 */
export function formatInviteCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += GROUP_SIZE) {
    groups.push(code.slice(index, index + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * 招待コードが期限切れかどうかを判定する。
 *
 * `expiresAt` ちょうどを期限切れとして扱う。境界を「まだ有効」に倒すと、失効時刻の
 * 意味が 1 秒ずれる。この規約（**失効時刻を含めて失効**）は、このプロジェクトで
 * 時刻の境界を扱うすべての判定で揃える。判定ごとに境界の向きが違うと、同じ
 * 「失効」という語が場所によって 1 秒ずれた意味を持つ。
 *
 * `expiresAt` が null の場合は無期限として扱う。`invites.expires_at` は
 * 5.1 で NULL を許す列であり、ここで一律に期限切れとすると、無期限の招待枠が
 * 発行された瞬間に使えなくなる。
 *
 * @param expiresAt 失効時刻（UNIX 秒）。無期限なら null
 * @param nowSeconds 現在時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 期限切れなら true
 */
export function isInviteExpired(
  expiresAt: number | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (expiresAt === null) {
    return false;
  }
  return expiresAt <= nowSeconds;
}
