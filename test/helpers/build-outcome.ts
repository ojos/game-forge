import type { BuildOutcome } from '../../src/build-client.js';

/** キャッシュに当たらなかったとき（関数を呼んだとき）の結果。 */
export type BuiltOutcome = Extract<BuildOutcome, { cached: false }>;

/**
 * ビルド段（3.3-5..7）の結果の雛形。
 *
 * **ここに 1 つだけ置く。** 骨組みのテスト（`test/generate.test.ts` /
 * `test/source-inspection.test.ts`）は「順序」を見るために各段を差し替えるが、
 * ビルド段の戻り値は 3.3-8 が読む形（R2 のキーと Go の版）に嵌まっている必要がある。
 * 各テストが独自の雛形を持つと、`BuildOutcome` を変えたときの追随箇所が増える
 * （`test/helpers/schema.ts` と同じ理由）。
 *
 * **非ヒット（`cached: false`）の形を返す。** 呼び出し側が毎回 `cached` で絞らずに
 * `keys` を読めるよう、型も絞った形で返す。
 *
 * @param overrides 差し替える項目
 * @returns 非ヒットのビルド結果
 */
export function fakeBuildOutcome(overrides: Partial<BuiltOutcome> = {}): BuiltOutcome {
  return {
    cached: false,
    sourceSha256: 'a'.repeat(64),
    goVersion: 'go1.26.5',
    artifact: {
      wasm: { bytes: 11_404_411, sha256: 'b'.repeat(64) },
      compressed: { bytes: 2_282_839, sha256: 'c'.repeat(64), contentEncoding: 'br' },
    },
    keys: {
      sourceKey: `builds/${'a'.repeat(64)}/source.go`,
      wasmKey: `builds/${'a'.repeat(64)}/go1.26.5/game.wasm.br`,
    },
    compressedData: null,
    timings: {
      resetMs: 0,
      prepareMs: 20,
      buildMs: 18_562,
      compressMs: 2_373,
      uploadMs: 310,
      totalMs: 21_265,
    },
    requestId: 'req-1',
    ...overrides,
  };
}
