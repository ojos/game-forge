import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readStoredSource } from '../src/source-store.js';
import { MAX_SOURCE_BYTES } from '../src/system-prompt.js';

/**
 * `src/source-store.ts` の検査（#217 / #216 のレビュー指摘）。
 *
 * **フォークと推敲の経路からの検査は `test/fork.test.ts` / `test/revise.test.ts` が
 * 持っている。** ここが見るのは、あの 2 つからは**観測できない**性質である——
 * 上限超過を「本文を読む前に」断ること。経路層の検査は結果（409 / 断り）しか見えず、
 * 途中で本文を読んだかどうかを区別しない。
 */
describe('R2 からソースを読む（#217）', () => {
  it('上限を超える大きさなら、本文を読まずに断る', async () => {
    // **本文を読んだら落ちるオブジェクト**を返すバケツを渡す。読まずに断てば通り、
    // 読んでから測る実装なら `text()` が投げて落ちる。
    let bodyRead = false;
    const bucket = {
      get: async () => ({
        size: MAX_SOURCE_BYTES + 1,
        text: async () => {
          bodyRead = true;
          throw new Error('上限を超えているのに本文を読みました');
        },
      }),
    };

    const result = await readStoredSource(
      { ...env, BUCKET: bucket } as unknown as Env,
      'builds/huge/source.go',
    );

    expect(result).toEqual({ ok: false, reason: 'source-too-large' });
    expect(bodyRead).toBe(false);
  });

  it('上限ちょうどなら読む（境界で切りすぎない）', async () => {
    const source = 'x'.repeat(MAX_SOURCE_BYTES);
    const bucket = {
      get: async () => ({ size: MAX_SOURCE_BYTES, text: async () => source }),
    };

    const result = await readStoredSource(
      { ...env, BUCKET: bucket } as unknown as Env,
      'builds/exact/source.go',
    );

    expect(result).toEqual({ ok: true, source });
  });

  it('保存された大きさが上限内でも、読み出した本文が超えていれば断る', async () => {
    // **`size` は保存時のバイト数で、判定したいのは「いま LLM へ渡そうとしている
    // 文字列」の大きさである。** 同じはずだが、同じはずだからと省くと、確かめて
    // いないものを確かめた証拠として使うことになる。
    const bucket = {
      get: async () => ({ size: 1, text: async () => 'あ'.repeat(MAX_SOURCE_BYTES) }),
    };

    const result = await readStoredSource(
      { ...env, BUCKET: bucket } as unknown as Env,
      'builds/lying/source.go',
    );

    expect(result).toEqual({ ok: false, reason: 'source-too-large' });
  });
});
