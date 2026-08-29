import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import {
  dispatch,
  findDuplicateRoutes,
  findMalformedPrefixRoutes,
  json,
} from '../src/routes.js';
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

describe('前方一致の経路（#150）', () => {
  /** 前方一致と完全一致を混ぜた経路表。 */
  const prefixRoutes: readonly Route[] = [
    { method: 'GET', path: '/exact', handler: () => json({ hit: 'exact' }) },
    { method: 'GET', path: '/pre/', match: 'prefix', handler: () => json({ hit: 'pre' }) },
    {
      method: 'GET',
      path: '/pre/deep/',
      match: 'prefix',
      handler: () => json({ hit: 'pre-deep' }),
    },
    { method: 'GET', path: '/pre/fixed', handler: () => json({ hit: 'fixed' }) },
    { method: 'POST', path: '/pre/', match: 'prefix', handler: () => json({ hit: 'pre-post' }) },
  ];

  /**
   * 経路を 1 つ引く。
   *
   * @param path パス
   * @param method メソッド
   * @returns レスポンス
   */
  async function hit(path: string, method = 'GET'): Promise<Response> {
    return await dispatch(prefixRoutes, new Request(`${APP_ORIGIN}${path}`, { method }), env);
  }

  it('接頭辞に一致すれば、その先が何であってもハンドラへ届く', async () => {
    expect(await (await hit('/pre/anything')).json()).toEqual({ hit: 'pre' });
    expect(await (await hit('/pre/a/b/c')).json()).toEqual({ hit: 'pre' });
  });

  it('完全一致を前方一致より優先する', async () => {
    // **これが無いと、`/pre/` の下に固定の経路を足せなくなる。** 前方一致が先に
    // 当たると、より具体的な経路が永久に届かない。
    expect(await (await hit('/pre/fixed')).json()).toEqual({ hit: 'fixed' });
  });

  it('いちばん長い接頭辞を採る（登録順に依存しない）', async () => {
    // `/pre/` は `/pre/deep/x` にも一致するが、より具体的なほうが勝つ。
    expect(await (await hit('/pre/deep/x')).json()).toEqual({ hit: 'pre-deep' });
  });

  it('接頭辞に一致しなければ 404 のままである', async () => {
    // **`/pre` は `/pre/` に一致しない。** 接頭辞を `/` で終える規約が効いていること。
    expect((await hit('/pre')).status).toBe(404);
    expect((await hit('/prefix-like/x')).status).toBe(404);
  });

  it('前方一致でもメソッド違いは 405 になり、Allow が出る', async () => {
    const response = await hit('/pre/anything', 'DELETE');
    expect(response.status).toBe(405);
    // 同じ接頭辞に登録されたメソッドだけが並ぶ（`/pre/deep/` の分は混ざらない）。
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
  });

  it('完全一致の経路は今までどおり動く（既定を変えていない）', async () => {
    expect(await (await hit('/exact')).json()).toEqual({ hit: 'exact' });
    expect((await hit('/exact/more')).status).toBe(404);
  });

  it('同じパスの完全一致と前方一致を重複と見なさない', () => {
    // 併用は正当（`/pre/fixed` と `/pre/`）なので、重複検出で落としてはいけない。
    expect(findDuplicateRoutes(prefixRoutes)).toEqual([]);
  });

  it('前方一致どうしの重複は今までどおり検出する', () => {
    const duplicated: readonly Route[] = [
      { method: 'GET', path: '/dup/', match: 'prefix', handler: () => json({}) },
      { method: 'GET', path: '/dup/', match: 'prefix', handler: () => json({}) },
    ];
    expect(findDuplicateRoutes(duplicated)).toEqual(['GET /dup/*']);
  });
});

describe('前方一致の接頭辞の綴り（#150）', () => {
  it('アプリの経路表に規約違反の接頭辞が無い', () => {
    // **`/` で終えないと、`/works` が `/worksmith` まで飲み込む。** 動いてしまうので、
    // 綴りを間違えても気づけない（飲み込まれた側がまだ存在しないなら壊れて見えない）。
    expect(findMalformedPrefixRoutes(createAppRoutes(env))).toEqual([]);
  });

  it('規約違反を実際に検出する（この検査が効いていることの確認）', () => {
    const malformed: readonly Route[] = [
      { method: 'GET', path: '/works', match: 'prefix', handler: () => json({}) },
      { method: 'GET', path: 'works/', match: 'prefix', handler: () => json({}) },
      { method: 'GET', path: '/', match: 'prefix', handler: () => json({}) },
      // 完全一致は対象外（末尾の `/` を要求しない）。
      { method: 'GET', path: '/fine', handler: () => json({}) },
    ];
    expect(findMalformedPrefixRoutes(malformed)).toEqual([
      'GET /works',
      'GET works/',
      'GET /',
    ]);
  });
});
