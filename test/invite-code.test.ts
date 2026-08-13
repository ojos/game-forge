import { describe, expect, it } from 'vitest';
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  formatInviteCode,
  generateInviteCode,
  isInviteExpired,
  normalizeInviteCode,
} from '../src/invite-code.js';

const NOW = 1_770_000_000;

describe('コードの生成（推測困難さ）', () => {
  it('文字集合が 32 文字で、読み違えやすい文字を含まない', () => {
    // 32 文字であること自体が、剰余で写したときの分布の偏りを消している
    // （256 % 32 === 0）。文字数を変えるならこの前提も変わる。
    expect(INVITE_CODE_ALPHABET).toHaveLength(32);
    expect(256 % INVITE_CODE_ALPHABET.length).toBe(0);
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(INVITE_CODE_ALPHABET, excluded).not.toContain(excluded);
    }
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(INVITE_CODE_ALPHABET.length);
  });

  it('生成したコードが正規形の条件を満たす', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      for (const character of code) {
        expect(INVITE_CODE_ALPHABET, code).toContain(character);
      }
    }
  });

  it('生成したコードが重複しない', () => {
    // 60 ビットに対して 1000 件では衝突は起こらない。ここで落ちるとしたら
    // 乱数源が定数を返しているなど、桁違いの故障がある。
    const codes = new Set(Array.from({ length: 1000 }, () => generateInviteCode()));
    expect(codes.size).toBe(1000);
  });

  it('生成したコードがそのまま正規化を通る', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      expect(normalizeInviteCode(code)).toBe(code);
      expect(normalizeInviteCode(formatInviteCode(code))).toBe(code);
    }
  });

  it('すべての桁が固定値になっていない', () => {
    // 乱数源の結線ミス（同じバイトで埋まる）を検知する。桁ごとに 2 種類以上
    // 現れることだけを見る。分布の一様性までは主張しない。
    const samples = Array.from({ length: 200 }, () => generateInviteCode());
    for (let position = 0; position < INVITE_CODE_LENGTH; position += 1) {
      const seen = new Set(samples.map((code) => code[position]));
      expect(seen.size, `position ${position}`).toBeGreaterThan(1);
    }
  });
});

describe('入力の正規化', () => {
  it('小文字と区切りを吸収する', () => {
    expect(normalizeInviteCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeInviteCode('ABCD EFGH JKMN')).toBe('ABCDEFGHJKMN');
    expect(normalizeInviteCode('　ABCD\tEFGH-JKMN ')).toBe('ABCDEFGHJKMN');
  });

  it('読み違えやすい文字を数字へ寄せる', () => {
    // 除外した文字は生成側では出てこないため、この写像で衝突は起きない。
    expect(normalizeInviteCode('IL0O23456789')).toBe('110023456789');
    expect(normalizeInviteCode('il0o23456789')).toBe('110023456789');
  });

  it('形式が不正な入力を拒否する', () => {
    for (const invalid of [
      '',
      'ABCDEFGHJKM', // 11 桁
      'ABCDEFGHJKMNP', // 13 桁
      'ABCDEFGHJKM!', // 記号
      'ABCDEFGHJKMU', // 除外した U
      'あいうえおかきくけこさし',
    ]) {
      expect(normalizeInviteCode(invalid), invalid).toBeNull();
    }
  });

  it('区切りだけを増やしても桁数の判定が変わらない', () => {
    expect(normalizeInviteCode('--ABCD--EFGH--JKMN--')).toBe('ABCDEFGHJKMN');
    expect(normalizeInviteCode('----------')).toBeNull();
  });
});

describe('表示用の整形', () => {
  it('4 桁ごとに区切る', () => {
    expect(formatInviteCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('整形した文字列が正規化で元へ戻る', () => {
    expect(normalizeInviteCode(formatInviteCode('ABCDEFGHJKMN'))).toBe('ABCDEFGHJKMN');
  });
});

describe('期限の判定（#13 acceptance 2）', () => {
  it('expires_at を過ぎたコードを期限切れとする', () => {
    expect(isInviteExpired(NOW - 1, NOW)).toBe(true);
  });

  it('expires_at ちょうどを期限切れとする', () => {
    // 境界を「まだ有効」に倒すと、失効時刻の意味が 1 秒ずれる。時刻の境界は
    // 「失効時刻を含めて失効」で、このプロジェクトのすべての判定で揃える。
    expect(isInviteExpired(NOW, NOW)).toBe(true);
  });

  it('期限前は有効とする', () => {
    expect(isInviteExpired(NOW + 1, NOW)).toBe(false);
  });

  it('expires_at が null なら無期限として扱う', () => {
    // invites.expires_at は 5.1 で NULL を許す。一律に期限切れとすると、
    // 無期限の招待枠が発行された瞬間に使えなくなる。
    expect(isInviteExpired(null, NOW)).toBe(false);
  });
});
