import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_BYTES,
  SOURCE_SIZE_WARNING_BYTES,
  SOURCE_SIZE_WARNING_RATIO,
  classifySourceBytes,
  decideForkSizeAction,
  measureSourceBytes,
} from '../src/source-size.js';

/**
 * `src/source-size.ts` の検査（確定18 / 5.3 / M5-2 / #33）。
 *
 * **ここが見るのは境界の読み方だけである。** 経路としての振る舞い（画面・状態コード・
 * 行を作らないこと）は `test/fork.test.ts` が見る。分けているのは、**経路の検査からは
 * 「ちょうどの値がどちら側か」を安く網羅できない**ためで、1 件ごとに D1 と R2 の
 * 用意が要る。
 */
describe('上限と警告の閾値（確定18 の条件 1）', () => {
  it('警告の閾値は上限の 80%（＝24KB）である', () => {
    // 5.3 は値（24KB）と導出（上限の 80%）の両方を書いている。**どちらも確かめる。**
    // 割合からだけ確かめると、上限が動いた日に「80% ではあるが 24KB ではない」ことに
    // 気づけない——それは仕様の書き換えを伴う変更であって、黙って通ってよくない。
    expect(SOURCE_SIZE_WARNING_RATIO).toBe(0.8);
    expect(SOURCE_SIZE_WARNING_BYTES).toBe(24 * 1024);
    expect(SOURCE_SIZE_WARNING_BYTES).toBe(MAX_SOURCE_BYTES * 0.8);
  });

  it('警告の帯が空でない（閾値は上限より小さい）', () => {
    // 閾値が上限以上になると、事前警告（条件 1）は**一度も出ない。**
    // 検査は緑のまま、機能だけが消える形になる。
    expect(SOURCE_SIZE_WARNING_BYTES).toBeLessThan(MAX_SOURCE_BYTES);
  });
});

describe('バイト数で測る（文字数ではない）', () => {
  it('日本語のコメントは 1 文字 3 バイトで数える', () => {
    // 6.1 の上限も `src/orchestrator/payload.ts` のペイロード上限もバイトである。
    // 文字数で数えると、日本語のコメントが多いソースで 3 倍見誤る。
    expect(measureSourceBytes('あ')).toBe(3);
    expect(measureSourceBytes('abc')).toBe(3);
    expect(measureSourceBytes('')).toBe(0);
  });

  it('上限ちょうどの日本語ソースは、文字数で測れば 3 分の 1 に見える', () => {
    const source = 'あ'.repeat(MAX_SOURCE_BYTES / 3);
    expect([...source]).toHaveLength(MAX_SOURCE_BYTES / 3);
    expect(measureSourceBytes(source)).toBe(MAX_SOURCE_BYTES);
    expect(classifySourceBytes(measureSourceBytes(source))).toBe('near-limit');
  });
});

describe('帯の境界は「超えたら」である（`>` であって `>=` ではない）', () => {
  it('24KB ちょうどは警告しない', () => {
    expect(classifySourceBytes(SOURCE_SIZE_WARNING_BYTES)).toBe('within');
  });

  it('24KB の 1 バイト上から警告する', () => {
    expect(classifySourceBytes(SOURCE_SIZE_WARNING_BYTES + 1)).toBe('near-limit');
  });

  it('30KB ちょうどはまだ改造できる', () => {
    // `src/source-store.ts` が上限ちょうどのソースを読むこと
    // （`test/source-store.test.ts`）と、同じ 1 つの判断でなければならない。
    expect(classifySourceBytes(MAX_SOURCE_BYTES)).toBe('near-limit');
  });

  it('30KB の 1 バイト上から超過である', () => {
    expect(classifySourceBytes(MAX_SOURCE_BYTES + 1)).toBe('over-limit');
  });

  it('空のソースは帯の中である', () => {
    expect(classifySourceBytes(0)).toBe('within');
  });
});

describe('入力段階の振る舞い（確定18 の条件 1）', () => {
  it('小さい親は、同意を求めずそのまま進む', () => {
    expect(decideForkSizeAction({ bytes: 1_000, consent: 'none' })).toBe('proceed');
  });

  it('24KB を超えた親は、同意を持たない要求で警告する', () => {
    expect(decideForkSizeAction({ bytes: SOURCE_SIZE_WARNING_BYTES + 1, consent: 'none' })).toBe(
      'warn',
    );
  });

  it('同意を持って戻ってきたら、同じ警告を繰り返さない', () => {
    // 繰り返すと、作者は同じ画面を往復するだけで先へ進めない。
    expect(decideForkSizeAction({ bytes: SOURCE_SIZE_WARNING_BYTES + 1, consent: 'proceed' })).toBe(
      'proceed',
    );
  });

  it('上限超は、同意があっても通さない', () => {
    // 通すと `src/orchestrator/payload.ts` がペイロードごと拒否し、**作品行だけが
    // `pending` で残る。** 同意は警告の帯にしか効かない。
    expect(decideForkSizeAction({ bytes: MAX_SOURCE_BYTES + 1, consent: 'proceed' })).toBe('refuse');
    expect(decideForkSizeAction({ bytes: MAX_SOURCE_BYTES + 1, consent: 'none' })).toBe('refuse');
  });
});
