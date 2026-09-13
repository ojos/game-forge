import { describe, expect, it } from 'vitest';
import {
  INVITE_RECOVERY_DAYS,
  INVITE_RECOVERY_SECONDS,
  computeInviteBalance,
} from '../src/invite-balance.js';

/**
 * 招待枠の残高の計算（8.1 v1.55 / #396）。
 *
 * **時刻はすべて固定する。** 境界（ちょうど 30 日）を実時刻に左右させない。
 */

const T0 = 1_770_000_000;
const DAY = 24 * 60 * 60;
const CAPACITY = 3;

/**
 * 基準時刻から `days` 日後の UNIX 秒。
 *
 * @param days 日数
 * @returns UNIX 秒
 */
function at(days: number): number {
  return T0 + days * DAY;
}

describe('1 本が戻るまでの長さ', () => {
  it('30 日である', () => {
    expect(INVITE_RECOVERY_DAYS).toBe(30);
    expect(INVITE_RECOVERY_SECONDS).toBe(30 * DAY);
  });
});

describe('登録直後と移行直後（8.1 / #396 acceptance 3）', () => {
  it('1 本も発行していなければ 3 本で、戻る時刻は無い', () => {
    expect(computeInviteBalance([], CAPACITY, T0)).toEqual({ available: 3, nextRecoveryAt: null });
  });

  it('列ができる前の発行（issued_at = 0）は、3 本使っていても 3 本に戻っている', () => {
    // `migrations/0034_invites_issued_at.sql` の既定値 0 が埋め戻しである。
    // **30 日前ちょうどで埋めると 1 本しか戻っていない**——0 はそれより十分に古い。
    expect(computeInviteBalance([0, 0, 0], CAPACITY, T0)).toEqual({
      available: 3,
      nextRecoveryAt: null,
    });
  });
});

describe('3 本を同時に使った後の戻り方（#396 acceptance 1）', () => {
  const issued = [at(0), at(0), at(0)];

  it('直後は 0 本で、次の 1 本は 30 日後に戻る', () => {
    expect(computeInviteBalance(issued, CAPACITY, at(0))).toEqual({
      available: 0,
      nextRecoveryAt: at(30),
    });
  });

  it('30 日ちょうどで 1 本、その 1 秒前は 0 本', () => {
    expect(computeInviteBalance(issued, CAPACITY, at(30) - 1).available).toBe(0);
    expect(computeInviteBalance(issued, CAPACITY, at(30))).toEqual({
      available: 1,
      nextRecoveryAt: at(60),
    });
  });

  it('60 日で 2 本、90 日で 3 本になり、そこで止まる', () => {
    expect(computeInviteBalance(issued, CAPACITY, at(60))).toEqual({
      available: 2,
      nextRecoveryAt: at(90),
    });
    expect(computeInviteBalance(issued, CAPACITY, at(90))).toEqual({
      available: 3,
      nextRecoveryAt: null,
    });
    expect(computeInviteBalance(issued, CAPACITY, at(365))).toEqual({
      available: 3,
      nextRecoveryAt: null,
    });
  });
});

describe('満杯のあいだの回復は捨てる（8.1 のバケツ。#396 acceptance 2）', () => {
  it('満杯のまま 90 日置いてから 1 本使った人の次の回復は、発行の 30 日後', () => {
    // 登録日を起点にすると 120 日目になる形。**8.1 が採るのは発行を起点にする側**である。
    const issued = [at(100)];
    expect(computeInviteBalance(issued, CAPACITY, at(100))).toEqual({
      available: 2,
      nextRecoveryAt: at(130),
    });
    expect(computeInviteBalance(issued, CAPACITY, at(130) - 1).available).toBe(2);
    expect(computeInviteBalance(issued, CAPACITY, at(130))).toEqual({
      available: 3,
      nextRecoveryAt: null,
    });
  });

  it('続けて使ったときは、1 本ずつ順に戻る（100 日目と 115 日目 → 130 日目と 160 日目）', () => {
    const issued = [at(100), at(115)];
    expect(computeInviteBalance(issued, CAPACITY, at(115))).toEqual({
      available: 1,
      nextRecoveryAt: at(130),
    });
    expect(computeInviteBalance(issued, CAPACITY, at(130))).toEqual({
      available: 2,
      nextRecoveryAt: at(160),
    });
    expect(computeInviteBalance(issued, CAPACITY, at(160)).available).toBe(3);
  });

  it('発行と発行のあいだに満杯へ戻った分も、上限を超えて溜めない', () => {
    // 0 日目に 1 本使い、30 日目に満杯へ戻る。そのあと 200 日目まで置いた分は捨てる。
    // **繰り越すと 200 日目に使っても 3 本のまま**に見える（上限を超えて溜まっている）。
    const issued = [at(0), at(200)];
    expect(computeInviteBalance(issued, CAPACITY, at(200))).toEqual({
      available: 2,
      nextRecoveryAt: at(230),
    });
  });

  it('1 本戻った後に使っても、戻りかけの分は失われない', () => {
    // 0 日目に 3 本 → 30 日目に 1 本戻る → 45 日目に使う。2 本目の 30 日は 30 日目から
    // 数えているので、45 日目の時点で半分溜まっている——次は 60 日目。
    const issued = [at(0), at(0), at(0), at(45)];
    expect(computeInviteBalance(issued, CAPACITY, at(45))).toEqual({
      available: 0,
      nextRecoveryAt: at(60),
    });
  });

  it('発行時刻の並びは順不同でよい', () => {
    expect(computeInviteBalance([at(115), at(100)], CAPACITY, at(115))).toEqual(
      computeInviteBalance([at(100), at(115)], CAPACITY, at(115)),
    );
  });
});

describe('例外的な入力', () => {
  it('容量 0（招待枠の停止中。#40）は履歴に関わらず 0 本で、戻る時刻も無い', () => {
    expect(computeInviteBalance([], 0, T0)).toEqual({ available: 0, nextRecoveryAt: null });
    expect(computeInviteBalance([at(-1)], 0, T0)).toEqual({ available: 0, nextRecoveryAt: null });
  });

  it('容量を超えて発行された履歴は借りとして持ち越し、早く戻らない', () => {
    // 4 本が同時に入った（上限をすり抜けた）場合、0 本で打ち止めにすると 30 日で 1 本戻る。
    // 借りを持ち越すので、1 本目が戻るのは 60 日後である。
    const issued = [at(0), at(0), at(0), at(0)];
    expect(computeInviteBalance(issued, CAPACITY, at(30))).toEqual({
      available: 0,
      nextRecoveryAt: at(60),
    });
  });

  it('現在時刻より後の発行時刻（時計のずれ）で、残高を時間で減らさない', () => {
    expect(computeInviteBalance([at(1)], CAPACITY, at(0))).toEqual({
      available: 2,
      nextRecoveryAt: at(30),
    });
  });

  it('容量が 0 以上の整数でなければ例外にする', () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeInviteBalance([], invalid, T0), String(invalid)).toThrow();
    }
  });
});
