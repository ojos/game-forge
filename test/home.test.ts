import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes, devRoutesEnabled, handleAppRequest } from '../src/app.js';
import { HOME_PATH } from '../src/home.js';
import { SIGNUP_PATH } from '../src/paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { findDuplicateRoutes } from '../src/routes.js';

/**
 * 公開トップと、`/__dev/*` の本番遮断（#89）。
 *
 * **受け入れ条件のうち、ローカルで機械判定できる 2 つをここで押さえる。**
 * 「`/` が開発用ページではない」と「`/__dev/*` が本番で 404 になる」は、実配備を
 * 待たなくても経路表の組み立てで決まる。実配備でしか見られないもの（実ドメインの
 * CSP / cookie、カスタムドメインの解決）は 9.1 の表のとおりここでは扱わない。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * `DEV_ROUTES` だけを差し替えた env を作る。
 *
 * `wrangler.toml` のトップレベル（＝ローカル）は `enabled` なので、無効側は
 * テストの中で作るしかない。**バインディングは実物を引き継ぐ**（D1 / R2 を
 * 差し替えると、遮断の検査のはずが疎通の検査になってしまう）。
 *
 * @param devRoutes `DEV_ROUTES` に入れる値
 * @returns 差し替えた env
 */
function envWithDevRoutes(devRoutes: string): Env {
  return { ...env, DEV_ROUTES: devRoutes } as unknown as Env;
}

/** 本番と同じ設定（`[env.production.vars]` の `DEV_ROUTES = "disabled"`）。 */
const productionEnv = envWithDevRoutes('disabled');

describe('公開トップ（#89）', () => {
  it('`/` が開発用の索引ではなく公開トップを返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}${HOME_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const body = await response.text();
    expect(body).toContain('<h1>Game Forge</h1>');
    // 開発用の索引にしか無い文言が残っていないこと。受け入れ条件
    // 「`/` が開発用ページではない」を、見た目ではなく文字列で固定する。
    expect(body).not.toContain('/__dev/health');
    expect(body).not.toContain('ローカル開発用の索引');
  });

  it('`/` から登録とログインの両方へ辿れる', async () => {
    const body = await (await SELF.fetch(`${APP_ORIGIN}${HOME_PATH}`)).text();
    expect(body).toContain(`href="${SIGNUP_PATH}"`);
    expect(body).toContain(`href="${LOGIN_PATH}"`);
  });

  it('`/` が D1 を読まない', async () => {
    // 3.6 の無料枠の理由（トップは URL 拡散の着地点で、1 アクセスごとに読み取りが
    // 増える形にしない）。バインディングを触ったら落ちる env を渡して確かめる。
    const trap = {
      ...env,
      DB: new Proxy(
        {},
        {
          get() {
            throw new Error('公開トップが D1 を参照しました');
          },
        },
      ),
    } as unknown as Env;

    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), trap);
    expect(response.status).toBe(200);
  });
});

describe('`/__dev/*` の本番遮断（#89）', () => {
  it('本番の設定では開発用の経路が 1 つも登録されない', () => {
    expect(devRoutesEnabled(productionEnv)).toBe(false);
    const paths = createAppRoutes(productionEnv).map((route) => route.path);
    expect(paths.filter((path) => path.startsWith('/__dev'))).toEqual([]);
  });

  it('本番の設定では `/__dev/*` が 404 になる', async () => {
    const paths = ['/__dev/', '/__dev/health', '/__dev/session', '/__dev/cookies'];
    await Promise.all(
      paths.map(async (path) => {
        const response = await handleAppRequest(
          new Request(`${APP_ORIGIN}${path}`),
          productionEnv,
        );
        expect(response.status, path).toBe(404);
        // set-cookie が出ないこと。`/__dev/session` は cookie を発行する経路なので、
        // 遮断が「本文だけ変えた」形になっていないかをここで見る。
        expect(response.headers.get('set-cookie'), path).toBeNull();
      }),
    );
  });

  it('本番の設定でも `/` と `/signup` は残る', () => {
    const registered = createAppRoutes(productionEnv).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(registered).toContain(`GET ${HOME_PATH}`);
    expect(registered).toContain(`GET ${SIGNUP_PATH}`);
    expect(registered).toContain(`POST ${SIGNUP_PATH}`);
  });

  it('有効・無効のどちらでも経路が重複しない', () => {
    // `/` の登録が公開トップと開発用の索引で二重にならないこと。dispatch は最初に
    // 一致した経路を使うため、重複しても動いてしまう（#89 で索引を `/__dev/` へ
    // 移した理由そのもの）。
    expect(findDuplicateRoutes(createAppRoutes(env))).toEqual([]);
    expect(findDuplicateRoutes(createAppRoutes(productionEnv))).toEqual([]);
  });

  it('綴りを間違えた値では有効にならない（既定は閉じる側）', () => {
    for (const value of ['', 'ENABLED', 'true', 'enable', 'disabled']) {
      expect(devRoutesEnabled(envWithDevRoutes(value)), value).toBe(false);
    }
    expect(devRoutesEnabled(envWithDevRoutes('enabled'))).toBe(true);
  });
});
