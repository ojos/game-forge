import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEV_SESSION_COOKIE, HEALTH_OBJECT_KEY, cookieNames } from '../src/app.js';
import { SANDBOX_CSP } from '../src/sandbox.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;

describe('Worker の env に宣言外の値が混入しない', () => {
  it('env のキーが wrangler.toml の宣言と完全に一致する', () => {
    // 検知層。wrangler は既定（CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=true）で
    // リポジトリ直下の .env を「シークレット」として読み、Worker の env へ流し込む。
    // このリポジトリの .env には開発ツール用の GH_TOKEN / GEMINI_API_KEY が入っており、
    // 混ざるとアプリのコードから参照でき、`wrangler deploy` では本番の secret として
    // アップロードされうる。npm script 側で false に倒しているが、それは「呼び出し方」
    // に依存する対策なので、混入したら落ちる検査をここへ置く。
    //
    // `__VITEST_POOL_WORKERS_*` はテストランナー自身が注入する結線用のバインディングで、
    // wrangler.toml 由来ではないため除外する（実行時には存在しない）。
    const declared = Object.keys(env)
      .filter((key) => !key.startsWith('__VITEST_POOL_WORKERS_'))
      .sort();
    expect(declared).toEqual(['APP_HOST', 'BUCKET', 'DB', 'SANDBOX_HOST']);
  });
});

describe('バインディングの疎通（#51 acceptance 1）', () => {
  it('ローカル D1 へのクエリが通る', async () => {
    const row = await env.DB.prepare('select 1 as ok').first<{ ok: number }>();
    expect(row?.ok).toBe(1);
  });

  it('ローカル D1 が DDL と DML を受け付ける', async () => {
    // スキーマ本体は M1-1 の所有物なので、ここでは使い捨てのテーブルで
    // 「書けること」だけを確かめ、5.1 のテーブル名には一切触れない。
    await env.DB.exec('create table if not exists __dev_probe (id integer primary key, note text)');
    await env.DB.prepare('insert into __dev_probe (note) values (?)').bind('m0.5-3').run();
    const row = await env.DB.prepare('select note from __dev_probe order by id desc limit 1').first<{
      note: string;
    }>();
    expect(row?.note).toBe('m0.5-3');
    await env.DB.exec('drop table __dev_probe');
  });

  it('ローカル R2 へ書き込んだ内容を読み出せる', async () => {
    await env.BUCKET.put('__dev/probe.txt', 'hello');
    const object = await env.BUCKET.get('__dev/probe.txt');
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe('hello');
    await env.BUCKET.delete('__dev/probe.txt');
    expect(await env.BUCKET.get('__dev/probe.txt')).toBeNull();
  });

  it('/__dev/health が D1 と R2 の両方を成功として返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/__dev/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      d1: { ok: boolean; detail: string };
      r2: { ok: boolean; detail: string };
      origins: { differentOrigin: boolean; sameSite: boolean };
    };
    expect(body.d1.ok, body.d1.detail).toBe(true);
    expect(body.r2.ok, body.r2.detail).toBe(true);
    expect(body.origins.differentOrigin).toBe(true);
    expect(body.origins.sameSite).toBe(true);
  });

  it('health の R2 検査が後片付けをしている', async () => {
    await SELF.fetch(`${APP_ORIGIN}/__dev/health`);
    expect(await env.BUCKET.get(HEALTH_OBJECT_KEY)).toBeNull();
  });
});

describe('ホストによる出し分け（#51 acceptance 3）', () => {
  it('アプリ用ホストがアプリ側を返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('app origin');
  });

  it('サンドボックス用ホストがサンドボックス側を返す', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('sandbox origin');
  });

  it('未知のホストはアプリ側へ流さず 404 にする', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('unknown host');
  });

  it('サンドボックス用ホストがアプリ用ホストの真のサブドメインである', () => {
    // 別オリジン（ホスト名が違う）かつ同一サイト（登録可能ドメインが同じ）という、
    // 7.2 が前提にしている関係そのもの。設定値を書き換えたら落ちる。
    expect(env.SANDBOX_HOST).not.toBe(env.APP_HOST);
    expect(env.SANDBOX_HOST.endsWith(`.${env.APP_HOST}`)).toBe(true);
  });
});

describe('CSP sandbox ヘッダ（7.2 必須要件 1）', () => {
  it('サンドボックス側のレスポンスが sandbox allow-scripts を付ける', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    const csp = response.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toBe(SANDBOX_CSP);
  });

  it('サンドボックス側は allow-same-origin を決して付けない', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });

  it('サンドボックス側は connect-src を none に絞る', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
  });

  it('サンドボックス側は cookie を一切設定しない', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('__Host- cookie（7.2 必須要件 2）', () => {
  it('セッション cookie が __Host- の受理条件をすべて満たす', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/__dev/session`);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    const cookie = setCookie!;

    expect(cookie.startsWith(`${DEV_SESSION_COOKIE}=`)).toBe(true);
    // __Host- は Secure・Path=/・Domain 属性なしの 3 つすべてを要求する。
    // どれか 1 つでも欠けるとブラウザは黙って捨てるため、個別に検査する。
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('cookie 名の抽出が値を漏らさない', () => {
    expect(cookieNames(`${DEV_SESSION_COOKIE}=secret-value; other=x`)).toEqual([
      DEV_SESSION_COOKIE,
      'other',
    ]);
    expect(cookieNames(null)).toEqual([]);
    expect(cookieNames('   ')).toEqual([]);
  });

  it('/__dev/cookies が届いた cookie の名前だけを返す', async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/__dev/cookies`, {
      headers: { cookie: `${DEV_SESSION_COOKIE}=must-not-appear` },
    });
    const body = (await response.json()) as { cookieNames: string[] };
    expect(body.cookieNames).toEqual([DEV_SESSION_COOKIE]);
    expect(JSON.stringify(body)).not.toContain('must-not-appear');
  });
});
