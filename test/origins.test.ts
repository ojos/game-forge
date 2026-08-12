import { describe, expect, it } from 'vitest';
import { describeOriginRelation, normalizeHost } from '../src/origins.js';

describe('normalizeHost', () => {
  it('ポートと末尾ドットを落とし、小文字へそろえる', () => {
    expect(normalizeHost('Game-Forge.LocalTest.me:8787')).toBe('game-forge.localtest.me');
    expect(normalizeHost('game-forge.ojos.jp.')).toBe('game-forge.ojos.jp');
    expect(normalizeHost('  game-forge.ojos.jp  ')).toBe('game-forge.ojos.jp');
  });
});

describe('describeOriginRelation', () => {
  it('本番の組み合わせが別オリジン・同一サイトになる', () => {
    const relation = describeOriginRelation('game-forge.ojos.jp', 'sandbox.game-forge.ojos.jp');
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(true);
    expect(relation.reasons).toEqual([]);
  });

  it('開発の組み合わせが本番と同じ関係になる', () => {
    const relation = describeOriginRelation(
      'game-forge.localtest.me',
      'sandbox.game-forge.localtest.me',
    );
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(true);
  });

  it('同一ホストは別オリジンとして扱わない', () => {
    const relation = describeOriginRelation('game-forge.ojos.jp', 'game-forge.ojos.jp');
    expect(relation.differentOrigin).toBe(false);
  });

  it('サブドメイン関係にないホストは同一サイトとして扱わない', () => {
    // 実際には eTLD+1 が一致するため同一サイトだが、この関数は「サブドメインである」
    // という、PSL 無しで保証できる十分条件だけを不変条件にしている（origins.ts の注記）。
    const relation = describeOriginRelation('game-forge.ojos.jp', 'sandbox.ojos.jp');
    expect(relation.sameSite).toBe(false);
    expect(relation.reasons.join('\n')).toContain('真のサブドメインではありません');
  });

  it('別サイトのホストを同一サイトと誤判定しない', () => {
    const relation = describeOriginRelation('game-forge.ojos.jp', 'sandbox.example.com');
    expect(relation.differentOrigin).toBe(true);
    expect(relation.sameSite).toBe(false);
  });

  it('接尾辞が一致するだけのホストを同一サイトと誤判定しない', () => {
    // "evilgame-forge.ojos.jp" は "game-forge.ojos.jp" で終わるが、ラベル境界が
    // 一致しないため別サイトである。ドット無しの endsWith で書くとここが通ってしまう。
    const relation = describeOriginRelation('game-forge.ojos.jp', 'evilgame-forge.ojos.jp');
    expect(relation.sameSite).toBe(false);
  });

  it('サブドメインのラベルが空のホストを同一サイト扱いしない', () => {
    // ".game-forge.ojos.jp" は endsWith("." + appHost) を満たしてしまうが、
    // サブドメインのラベルが空でホスト名として成立しない。長さの下限で弾く。
    const relation = describeOriginRelation('game-forge.ojos.jp', '.game-forge.ojos.jp');
    expect(relation.sameSite).toBe(false);
  });
});
