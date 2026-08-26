import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { dispatch, findDuplicateRoutes, json } from '../src/routes.js';
import type { Route } from '../src/routes.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;

/** 経路表の解決だけを見るための、副作用のない経路。 */
const probeRoutes: readonly Route[] = [
  { method: 'GET', path: '/probe', handler: () => json({ hit: 'GET /probe' }) },
  { method: 'POST', path: '/probe', handler: () => json({ hit: 'POST /probe' }) },
  { method: 'POST', path: '/post-only', handler: () => json({ hit: 'POST /post-only' }) },
];

describe('経路表の解決', () => {
  it('メソッドとパスが一致する経路のハンドラを呼ぶ', async () => {
    const response = await dispatch(probeRoutes, new Request(`${APP_ORIGIN}/probe`), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hit: 'GET /probe' });
  });

  it('同じパスでもメソッドが違えば別のハンドラを呼ぶ', async () => {
    const response = await dispatch(
      probeRoutes,
      new Request(`${APP_ORIGIN}/probe`, { method: 'POST' }),
      env,
    );
    expect(await response.json()).toEqual({ hit: 'POST /probe' });
  });

  it('HEAD を GET の経路で解決する', async () => {
    // HEAD を別経路として登録させると、経路を足す側が GET と 2 行書くことになり、
    // 片方の書き忘れが 405 として表面化する。dispatch 側で畳んでいることを固定する。
    const response = await dispatch(
      probeRoutes,
      new Request(`${APP_ORIGIN}/probe`, { method: 'HEAD' }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it('未知のパスは 404 を返す', async () => {
    const response = await dispatch(probeRoutes, new Request(`${APP_ORIGIN}/nope`), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found', path: '/nope' });
  });

  it('パスはあるがメソッドが違えば 405 と Allow を返す', async () => {
    // 一律 404 にすると、経路の綴り間違いとメソッド違いを区別できない。
    const response = await dispatch(probeRoutes, new Request(`${APP_ORIGIN}/post-only`), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('GET を受け付ける経路の Allow は HEAD を含む', async () => {
    const response = await dispatch(
      probeRoutes,
      new Request(`${APP_ORIGIN}/probe`, { method: 'DELETE' }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
  });
});

describe('経路表の重複検出', () => {
  it('重複した経路を検出する', () => {
    const duplicated = findDuplicateRoutes([
      ...probeRoutes,
      { method: 'GET', path: '/probe', handler: () => json({}) },
    ]);
    expect(duplicated).toEqual(['GET /probe']);
  });

  it('重複がなければ空を返す', () => {
    expect(findDuplicateRoutes(probeRoutes)).toEqual([]);
  });

  it('経路表に重複した経路がない', () => {
    // dispatch は最初に一致した経路を使うため、重複しても動いてしまう。M1 は複数の
    // PR が並行して経路を連結するので、後から足した側が黙って無視される事故が起こる。
    // 動作では気づけない以上、ここで落とす。
    expect(findDuplicateRoutes(createAppRoutes(env))).toEqual([]);
  });
});

describe('経路表への差し替えが振る舞いを変えていない', () => {
  it('未知のパスの 404 が分解前と同じ本文を返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found', path: '/does-not-exist' });
  });

  it('既存の経路がすべて GET で登録されている', () => {
    // 完全一致では固定しない。M1 以降で経路が足されるたびにこの行を書き換える
    // ことになり、経路表へ分解して減らしたはずの衝突面をテスト側で作り直してしまう。
    // ここが見たいのは「既存の 4 経路が失われていないこと」だけである。
    //
    // 索引は #89 で `/` から `/__dev/` へ移した（`/` は公開トップになった）。
    // 経路そのものは失われていないので、綴りだけを追随させる。
    const registered = createAppRoutes(env).map((route) => `${route.method} ${route.path}`);
    expect(registered).toEqual(
      expect.arrayContaining([
        'GET /',
        'GET /__dev/',
        'GET /__dev/health',
        'GET /__dev/session',
        'GET /__dev/cookies',
      ]),
    );
  });

  it('非 GET は 405 になる（分解前は 200 を返していた）', () =>
    Promise.all(
      ['/', '/__dev/', '/__dev/health', '/__dev/session', '/__dev/cookies'].map(async (path) => {
        // 分解前の `switch (url.pathname)` はメソッドを見ておらず、POST でも
        // GET と同じレスポンスを返していた。経路表化で 405 に変わる。
        // `/__dev/*` は開発用の診断経路で利用者がいないため互換を残さないが、
        // 変わったこと自体は黙らせずにここで固定する。
        const response = await SELF.fetch(`${APP_ORIGIN}${path}`, { method: 'POST' });
        expect(response.status, path).toBe(405);
        expect(response.headers.get('allow'), path).toBe('GET, HEAD');
      }),
    ));
});
