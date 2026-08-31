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
 * # `keys` は `sourceSha256` と `goVersion` に追随する
 *
 * **固定値にしてはいけない。** 本物の `keys` は内容アドレスで
 * （`builds/<source_sha256>/...`）、**ソースが違えば必ず違うキーになる。**
 * 雛形が固定値を返すと、`sourceSha256` を差し替えて 2 件の作品を作ったテストで
 * **後の R2 書き込みが前を上書きし、別々のソースのつもりが同じ本文を指す。**
 *
 * これは実際に踏みかけた（#32 のフォークで、別々の親を用意したつもりの
 * キャッシュ検査が**偽の緑**になるところだった）。あちらは呼び出し側で `keys` を
 * 書いて避けたが、**避け方を各テストが知っている必要がある形は罠である。**
 *
 * `keys` を明示的に上書きした場合はそちらが勝つ（`...overrides` が後にある）。
 *
 * @param overrides 差し替える項目
 * @returns 非ヒットのビルド結果
 */
export function fakeBuildOutcome(overrides: Partial<BuiltOutcome> = {}): BuiltOutcome {
  // **既定値をここで 1 度だけ決める。** 下のオブジェクトリテラルと `keys` の両方が
  // 同じ値を見るようにするためで、直書きを 2 か所へ散らすと片方だけが古くなる。
  const sourceSha256 = overrides.sourceSha256 ?? 'a'.repeat(64);
  const goVersion = overrides.goVersion ?? 'go1.26.5';

  return {
    cached: false,
    sourceSha256,
    goVersion,
    artifact: {
      wasm: { bytes: 11_404_411, sha256: 'b'.repeat(64) },
      compressed: { bytes: 2_282_839, sha256: 'c'.repeat(64), contentEncoding: 'br' },
    },
    keys: {
      sourceKey: `builds/${sourceSha256}/source.go`,
      wasmKey: `builds/${sourceSha256}/${goVersion}/game.wasm.br`,
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
