import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_BYTES,
  SOURCE_SIZE_WARNING_BYTES,
  SOURCE_SIZE_WARNING_RATIO,
  classifySourceBytes,
  decideForkSizeAction,
  TIDY_ATTEMPTS,
  TIDY_MAX_SOURCE_BYTES,
  composeTidyPrompt,
  isTidyPass,
  measureSourceBytes,
  warningBytesFor,
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

  it('閾値は整数である（上限が動いても端数を作らない）', () => {
    // **バイト数は画面へそのまま出る**（`src/fork.ts` の警告画面）。`* 0.8` は
    // 二進小数なので、上限によっては端数になる。**いまの 30,720 では割り切れるため、
    // 現在値だけを見る検査はこの不具合を捕まえられない**——割り切れない上限を
    // 直接与えて確かめる（#255 のレビュー指摘）。
    expect(Number.isInteger(SOURCE_SIZE_WARNING_BYTES)).toBe(true);
    expect(Number.isInteger(warningBytesFor(31 * 1024))).toBe(true);
    expect(Number.isInteger(warningBytesFor(9 * 1024))).toBe(true);
    // 導出そのものは変えていない（切り下げるだけ）。
    expect(warningBytesFor(30 * 1024)).toBe(24 * 1024);
    expect(warningBytesFor(31 * 1024)).toBe(25_395);
  });

  it('整理の入力上限は上限の 2 倍（＝60KB）である', () => {
    // **直値でも見る。** 帯の検査はどれも `TIDY_MAX_SOURCE_BYTES` を基準に書いてあるので、
    // 定数を緩めるとテストごと追随して通る（実際、2 倍を 4 倍へ変える変異が
    // 1 件も落ちなかった）。`test/generate.test.ts` が
    // 「定数からも直値からも見る」と書いているのと同じ理由である。
    expect(TIDY_MAX_SOURCE_BYTES).toBe(60 * 1024);
    expect(TIDY_MAX_SOURCE_BYTES).toBe(MAX_SOURCE_BYTES * 2);
    // **緩めてよい理由が消えていないこと。** 非同期呼び出しのペイロード上限 256 KB に
    // 対して、プロンプト（最大 2,000 文字＝ UTF-8 で 8 KB）を足しても桁が 1 つ違う。
    expect(TIDY_MAX_SOURCE_BYTES + 8 * 1024).toBeLessThan(256 * 1024);
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

  it('上限超は、まず整理するかどうかを問う（条件 2）', () => {
    // 5.3 は「拒否のみは採らない」と定めている。**問わずに断ると、フォーク連鎖が
    // 30KB で行き止まりになり、10.3 の撤退条件を実装の側で不成立にしうる。**
    expect(decideForkSizeAction({ bytes: MAX_SOURCE_BYTES + 1, consent: 'none' })).toBe(
      'offer-tidy',
    );
  });

  it('事前警告への同意を、整理への同意として読まない（条件 2）', () => {
    // 条件 2 は「作者が明示的に選ぶ」ことを求める。条件 1 の画面で押した
    // 「このまま改造する」を流用すると、**作者が押していない操作で枠が減る。**
    expect(decideForkSizeAction({ bytes: MAX_SOURCE_BYTES + 1, consent: 'proceed' })).toBe(
      'offer-tidy',
    );
  });

  it('整理を選んで初めて整理パスへ入る（条件 2）', () => {
    expect(decideForkSizeAction({ bytes: MAX_SOURCE_BYTES + 1, consent: 'tidy' })).toBe('tidy');
  });

  it('整理しても収まる見込みが無い大きさは、問わずに断る', () => {
    // 問うだけ問って必ず失敗する選択肢は、条件 2 が守ろうとした「知らないうちに枠を
    // 使わせない」を、知ったうえで確実に捨てさせる形へ裏返す。
    expect(decideForkSizeAction({ bytes: TIDY_MAX_SOURCE_BYTES + 1, consent: 'tidy' })).toBe(
      'refuse',
    );
    expect(decideForkSizeAction({ bytes: TIDY_MAX_SOURCE_BYTES, consent: 'tidy' })).toBe('tidy');
  });

  it('近い帯では、整理の同意もそのまま進ませる', () => {
    // 30KB に収まっているなら整理は要らない。**要らない整理で枠を使わせない。**
    expect(decideForkSizeAction({ bytes: SOURCE_SIZE_WARNING_BYTES + 1, consent: 'tidy' })).toBe(
      'proceed',
    );
  });
});

describe('整理パスの見分けと指示（確定18 の条件 2〜4）', () => {
  it('元ソースが上限を超えていれば整理パスである', () => {
    expect(isTidyPass({ baseSource: 'x'.repeat(MAX_SOURCE_BYTES + 1) })).toBe(true);
  });

  it('上限ちょうど・元ソース無しは整理パスではない', () => {
    // **新規生成を整理パスと読まない。** 読むと、元ソースの無い生成に整理の指示が
    // 載り、試行の上限も 1 へ落ちる（5.2-7 のリトライが黙って消える）。
    expect(isTidyPass({ baseSource: 'x'.repeat(MAX_SOURCE_BYTES) })).toBe(false);
    expect(isTidyPass({})).toBe(false);
  });

  it('整理の指示は、利用者のプロンプトを消さずに足す', () => {
    // 差し替えると、収まっても別のゲームができる。
    const composed = composeTidyPrompt('敵を 3 体にする', MAX_SOURCE_BYTES + 500);
    expect(composed.startsWith('敵を 3 体にする')).toBe(true);
    expect(composed).toContain(String(MAX_SOURCE_BYTES));
    expect(composed).toContain(String(MAX_SOURCE_BYTES + 500));
    // 遊べる状態を保たせる（5.4 は作者を唯一のフィルタに据えており、遊べないものを
    // 出すとそのフィルタが働く前に無駄になる）。
    expect(composed).toContain('遊べる状態');
  });

  it('整理パスの試行は 1 回である（条件 3・4）', () => {
    expect(TIDY_ATTEMPTS).toBe(1);
  });
});
