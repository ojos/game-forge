import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteHead, siteViewerAt } from '../src/html.js';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { ssrPagePaths } from '../src/page-paths.js';
import { AUTHOR_PAGE_PREFIX } from '../src/users-page-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 正規の URL（`<link rel="canonical">`。#595）。
 *
 * **出す・出さないの境界そのものを検査する。** 出し方の細部より、**どの画面に出ないか**が
 * 効く——`noindex` の画面に出すと、要求されたパスが本文へ反射する（下記）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

// 作者ページは D1 を引く（居ない相手でも引きに行く）。表が無いと 500 になり、
// 見たい本文の手前で落ちる。
beforeAll(async () => {
  await applySchema();
});

/**
 * `<link rel="canonical">` の値を取り出す。
 *
 * @param html 文書
 * @returns href の値（無ければ null）
 */
function canonicalOf(html: string): string | null {
  return /<link rel="canonical" href="([^"]*)">/u.exec(html)?.[1] ?? null;
}

describe('canonical を出す画面と、出さない画面', () => {
  it('索引に載る画面には、いま開いているパスを出す', () => {
    const head = siteHead({ title: 'x', viewer: siteViewerAt('/works', false, null) });
    expect(canonicalOf(head)).toBe('/works');
  });

  it('noindex の画面には出さない', () => {
    // 索引に載せない画面に、正規の URL を告げる相手はいない。
    const head = siteHead({ title: 'x', noindex: true, viewer: siteViewerAt('/account', true, null) });
    expect(canonicalOf(head)).toBeNull();
  });

  it('viewer を渡さない応答には出さない（知らないパスを推測して書かない）', () => {
    expect(canonicalOf(siteHead({ title: 'x' }))).toBeNull();
  });

  it('値はエスケープして出す', () => {
    const head = siteHead({ title: 'x', viewer: siteViewerAt('/works"><script>', false, null) });
    expect(head).not.toContain('<script>');
  });
});

describe('要求されたパスを 404 の本文へ反射させない（#330 の acceptance を壊さない）', () => {
  it('綴りの違う要求と、存在しない相手への要求で、本文が 1 バイトも変わらない', async () => {
    // **canonical を `noindex` の画面にも出すと、この検査が落ちる**（実際に落ちた）。
    // `viewer.path` は要求されたパスなので、本文へ書くと**2 つの 404 を区別できる。**
    // 404 の理由を区別させないという性質（2.4.2 と同じ向き）を、canonical で崩さない。
    const missing = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${AUTHOR_PAGE_PREFIX}00000000-0000-4000-8000-000000000000`), env)
    ).text();
    const malformed = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${AUTHOR_PAGE_PREFIX}a/b`), env)
    ).text();
    expect(malformed).toBe(missing);
    expect(canonicalOf(missing)).toBeNull();
  });
});

describe('経路表の全画面を開いて確かめる（#595 の acceptance 6）', () => {
  /**
   * 画面を開いて、canonical と noindex を読む。
   *
   * @param path パス
   * @returns 状態・canonical・noindex
   */
  async function open(path: string): Promise<{ status: number; canonical: string | null; noindex: boolean }> {
    const res = await SELF.fetch(`${APP_ORIGIN}${path}`);
    const body = await res.text();
    return {
      status: res.status,
      canonical: canonicalOf(body),
      noindex: body.includes('<meta name="robots" content="noindex">'),
    };
  }

  it('索引に載る画面には必ず canonical があり、値は開いたパスと一致する', async () => {
    // **一覧を書き写さない。** 経路表から導いて、画面を 1 枚足した日にも自動で乗る形にする。
    const routes = createAppRoutes(env);
    const openEnded = new Set(
      routes.filter((route) => route.match === 'prefix' || route.match === 'segment').map((route) => route.path),
    );
    const exactPages = ssrPagePaths(routes).filter((path) => !openEnded.has(path));
    expect(exactPages.length).toBeGreaterThan(5);

    let checked = 0;
    for (const path of exactPages) {
      const { status, canonical, noindex } = await open(path);
      if (status !== 200) {
        continue;
      }
      if (noindex) {
        expect(canonical, `${path} は noindex なのに canonical が出ている`).toBeNull();
        continue;
      }
      expect(canonical, `${path} に canonical が無い`).toBe(path);
      checked += 1;
    }
    // **1 枚も確かめずに緑にしない。**
    expect(checked).toBeGreaterThan(3);
  });

  it('クエリは canonical から落ちる（同じ中身の URL を 1 つへ寄せる）', async () => {
    // 公開一覧は sort / tag / page でいくつでも URL を作れる。**どれも /works の重複だと伝える。**
    for (const query of ['?sort=likes', '?sort=forks&page=2', '?tag=action']) {
      const { canonical } = await open(`/works${query}`);
      expect(canonical, `/works${query}`).toBe('/works');
    }
  });
});
