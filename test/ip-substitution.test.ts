import { describe, expect, it } from 'vitest';
import type { IpTerm } from '../src/ip-terms.js';
import { IP_TERMS } from '../src/ip-terms.js';
import {
  IP_NOTICE_SEPARATOR,
  findIpTerms,
  ipNoticeOf,
  normalizeForIpMatch,
  parseIpNotice,
} from '../src/ip-substitution.js';

/**
 * 規則を試すためのダミー。**本物の一覧を使わない。**
 *
 * `src/ip-terms.ts` はデータだけを持ち、`src/ip-substitution.ts` は名前を 1 つも
 * 持たない。その分離が効いていれば、規則の検査は名前を 1 つも要らない
 * （`test/output-moderation.test.ts` と同じ形）。
 */
const DUMMY: readonly IpTerm[] = [
  { label: 'アルファ', aliases: ['アルファ', 'alpha'], word: true },
  { label: 'ベータ', aliases: ['ベータ', 'べーた'] },
  { label: 'ガンマ', aliases: ['gamma game'] },
];

describe('突き合わせの規則（6.2 / #39）', () => {
  it('日本語の綴りは部分一致で当たる', () => {
    expect(findIpTerms('ベータみたいなゲーム', DUMMY)).toEqual(['ベータ']);
  });

  it('表記ゆれも同じ正式名になる', () => {
    expect(findIpTerms('べーた風のやつ', DUMMY)).toEqual(['ベータ']);
  });

  it('全角と半角を同じものとして見る', () => {
    // NFKC で畳む。畳まないと `ＡＬＰＨＡ` が素通りする。
    expect(findIpTerms('ＡＬＰＨＡ のようなゲーム', DUMMY)).toEqual(['アルファ']);
  });

  it('ASCII の綴りは語として現れたときだけ当たる', () => {
    expect(findIpTerms('alpha strike', DUMMY)).toEqual(['アルファ']);
    expect(findIpTerms('alpha-strike', DUMMY)).toEqual(['アルファ']);
  });

  it('ASCII の綴りが別語の一部なら当たらない', () => {
    // **誤検出はこちらが嘘をつくことである**（`src/ip-terms.ts` の但し書き）。
    // 当たると作者へ「置き換えています」と出るので、当たっていないのに出してはならない。
    expect(findIpTerms('alphabet を並べるゲーム', DUMMY)).toEqual([]);
    expect(findIpTerms('subalpha', DUMMY)).toEqual([]);
  });

  it('語境界を要求しない綴りは、空白を含んでいても当たる', () => {
    expect(findIpTerms('gamma game みたいなの', DUMMY)).toEqual(['ガンマ']);
  });

  it('同じ正式名は 1 度しか出ない', () => {
    // 1 つの `IpTerm` に綴りが 2 本当たっても、正式名は 1 度だけ。
    expect(findIpTerms('アルファと alpha', DUMMY)).toEqual(['アルファ']);
  });

  it('一覧の順で返る', () => {
    expect(findIpTerms('ベータと alpha', DUMMY)).toEqual(['アルファ', 'ベータ']);
  });

  it('当たらなければ空配列', () => {
    expect(findIpTerms('ねこが主人公のパズル', DUMMY)).toEqual([]);
  });
});

describe('開示の値（6.2 / #39）', () => {
  it('当たらなければ null であって空文字列ではない', () => {
    // `null` と `''` の 2 通りが「当たらなかった」を意味する状態を作らない
    // （`migrations/0015_games_ip_notice.sql`）。
    expect(ipNoticeOf('ねこが主人公のパズル', DUMMY)).toBeNull();
  });

  it('当たった分を区切り文字で繋ぐ', () => {
    expect(ipNoticeOf('ベータと alpha', DUMMY)).toBe(
      ['アルファ', 'ベータ'].join(IP_NOTICE_SEPARATOR),
    );
  });

  it('書いた値をそのまま読み戻せる', () => {
    const written = ipNoticeOf('ベータと alpha', DUMMY);
    expect(parseIpNotice(written)).toEqual(['アルファ', 'ベータ']);
  });

  it('null と空文字列はどちらも「無い」', () => {
    // 列は null しか入らない設計だが、**読む側が書く側の規約に依存しない**。
    expect(parseIpNotice(null)).toEqual([]);
    expect(parseIpNotice('')).toEqual([]);
    expect(parseIpNotice(undefined)).toEqual([]);
  });
});

describe('本物の一覧そのものに対する不変条件', () => {
  it('正式名に区切り文字が混ざっていない', () => {
    // 混ざると、読み戻したときに 1 件が 2 件に割れる。**規約で守らず機械で見る。**
    for (const term of IP_TERMS) {
      expect(term.label).not.toContain(IP_NOTICE_SEPARATOR);
    }
  });

  it('正式名が重複していない', () => {
    const labels = IP_TERMS.map((term) => term.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('綴りに正式名そのものが含まれている', () => {
    // 規則の側は `label` を綴りとして使わない。**含め忘れると正式名では当たらない。**
    for (const term of IP_TERMS) {
      const normalized = term.aliases.map((alias) => normalizeForIpMatch(alias));
      expect(normalized).toContain(normalizeForIpMatch(term.label));
    }
  });

  it('空の綴りが無い', () => {
    for (const term of IP_TERMS) {
      expect(term.aliases.length).toBeGreaterThan(0);
      for (const alias of term.aliases) {
        expect(alias.trim()).not.toBe('');
      }
    }
  });

  it('ふつうのお題では 1 件も当たらない', () => {
    // **本物の一覧に対する誤検出の見張り。** ここが赤くなったら、足した綴りが
    // 短すぎるか一般的すぎる。
    for (const prompt of [
      'ねこが主人公のパズル',
      '10 秒で地球を破壊するゲーム',
      '逆・弾幕シューティング',
      '単位を落とすな留学生',
      'ゴリラがソーダを振るゲーム',
    ]) {
      expect(findIpTerms(prompt)).toEqual([]);
    }
  });

  it('著名 IP 名を含むお題では当たる', () => {
    expect(findIpTerms('マリオみたいな横スクロール')).toContain('マリオ');
    expect(findIpTerms('pokemon っぽい収集ゲーム')).toContain('ポケモン');
  });
});
