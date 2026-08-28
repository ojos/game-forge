import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  forgetBuildCache,
  readBuildCache,
  recordBuildCache,
  sourceCacheKey,
  toHex,
} from '../src/build-cache.js';
import type { BuildCacheRecord } from '../src/build-cache.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/**
 * 索引 1 行分の雛形を作る。
 *
 * テストごとに固有のハッシュを渡して自己完結させる（`test/schema.test.ts` と同じ方針）。
 *
 * @param sourceSha256 キャッシュ鍵
 * @param overrides 差し替える項目
 * @returns 記録する内容
 */
function record(sourceSha256: string, overrides: Partial<BuildCacheRecord> = {}): BuildCacheRecord {
  return {
    sourceSha256,
    goVersion: 'go1.26.5',
    sourceKey: `sources/${sourceSha256}.go`,
    wasmKey: `wasm/${sourceSha256}.wasm.br`,
    wasmBytes: 11_404_411,
    wasmSha256: 'a'.repeat(64),
    compressedBytes: 2_282_980,
    compressedSha256: 'b'.repeat(64),
    contentEncoding: 'br',
    ...overrides,
  };
}

/**
 * 索引が指す 2 つのオブジェクトを R2 へ置く。
 *
 * @param entry 記録した内容
 */
async function putArtifacts(entry: BuildCacheRecord): Promise<void> {
  await env.BUCKET.put(entry.wasmKey, 'compressed-wasm');
  await env.BUCKET.put(entry.sourceKey, 'package main');
}

describe('キャッシュ鍵（3.8「生成ソースのコンテンツハッシュ」）', () => {
  it('UTF-8 のバイト列に対する SHA-256 を小文字 16 進で返す', async () => {
    expect(await sourceCacheKey('package main\n')).toBe(
      'df1d036cbbf3df46e2045071e082245ece204c7f53ecf0a4e022bff9bb228f47',
    );
  });

  it('1 文字の違いで別の鍵になる', async () => {
    expect(await sourceCacheKey('package main\n')).not.toBe(await sourceCacheKey('package main '));
  });

  it('16 進への変換が 0 を詰める', () => {
    // 0x0a を "a" と書くと長さが変わり、ハッシュの比較が静かに壊れる。
    expect(toHex(new Uint8Array([0x00, 0x0a, 0xff]))).toBe('000aff');
  });
});

describe('索引の読み書き（3.8「関数の外に置く」）', () => {
  it('記録した内容をそのまま読み戻せる', async () => {
    const entry = record('1'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry, 1_700_000_000);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup.hit).toBe(true);
    if (!lookup.hit) return;
    expect(lookup.entry).toEqual({ ...entry, createdAt: 1_700_000_000 });
  });

  it('索引に無い鍵はミスになる', async () => {
    const lookup = await readBuildCache(env, '2'.repeat(64));
    expect(lookup).toEqual({ hit: false, reason: 'not-indexed' });
  });

  it('同じ鍵の再記録が古い行を置き換える', async () => {
    const first = record('3'.repeat(64));
    await putArtifacts(first);
    await recordBuildCache(env, first);

    const second = record('3'.repeat(64), { goVersion: 'go1.27.0' });
    await recordBuildCache(env, second);

    const lookup = await readBuildCache(env, first.sourceSha256);
    expect(lookup.hit).toBe(true);
    if (!lookup.hit) return;
    expect(lookup.entry.goVersion).toBe('go1.27.0');

    const rows = await env.DB.prepare('select count(*) as n from build_cache where source_sha256 = ?')
      .bind(first.sourceSha256)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe('成果物が消えている場合（3.7 のライフサイクル / 確定13）', () => {
  it('`.wasm.br` が無ければミスにし、索引の行も落とす', async () => {
    // 14 日間未公開なら自動削除される（確定13）。**索引だけが残る状態は平常である。**
    const entry = record('4'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await env.BUCKET.delete(entry.wasmKey);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup).toEqual({ hit: false, reason: 'artifact-missing' });

    // 次の生成で同じ 2 回の head を繰り返さないよう、行そのものを落としている。
    const row = await env.DB.prepare('select count(*) as n from build_cache where source_sha256 = ?')
      .bind(entry.sourceSha256)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('`source.go` だけが無くてもミスにする', async () => {
    // フォーク（5.3）は source が無ければ再現できない。片方だけでヒットにすると、
    // 「遊べるがフォークできない」作品が生まれる。
    const entry = record('5'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await env.BUCKET.delete(entry.sourceKey);

    const lookup = await readBuildCache(env, entry.sourceSha256);
    expect(lookup).toEqual({ hit: false, reason: 'artifact-missing' });
  });
});

describe('索引の削除', () => {
  it('落とした鍵はミスになる', async () => {
    const entry = record('6'.repeat(64));
    await putArtifacts(entry);
    await recordBuildCache(env, entry);
    await forgetBuildCache(env, entry.sourceSha256);

    expect(await readBuildCache(env, entry.sourceSha256)).toEqual({
      hit: false,
      reason: 'not-indexed',
    });
  });
});
