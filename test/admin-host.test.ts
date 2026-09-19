import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../src/admin/routes.js';
import { createAppRoutes } from '../src/app.js';
import { ADMIN_HOME_PATH } from '../src/admin-paths.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { TAKEDOWN_PATH, TERMS_PATH } from '../src/legal.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { MY_WORKS_PATH, PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * admin ホストが 3 つ目のホストとして立っていること（2.4.1 / #356）。
 *
 * # なぜ 2 方向を見るのか
 *
 * 2.4 の constraints は 2 つ並べている——**`app` ホストで admin の経路が出ないこと**と
 * **admin ホストで `app` の経路が出ないこと。** 片方だけを見ると、**経路表を 1 つに
 * まとめた実装が半分だけ通る**（admin の経路が app に出ていても、admin 側の検査は緑に
 * なる）。
 *
 * # ホスト名はすべて宣言から読む
 *
 * **綴りをここへ書き写さない**（`.ai-playbook/shared-ai-rules.md` 12 章）。ローカルの
 * 値は `env.ADMIN_HOST`、本番の値は `env.TEST_WRANGLER_TOML`（宣言そのもの）から読む。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;

beforeAll(async () => {
  await applySchema();
});

/**
 * `wrangler.toml` から、ある環境の `[vars]` の値を読む。
 *
 * **`test/origins.test.ts` の `productionVar` と同じ形である。** あちらは
 * `[env.production.vars]` 専用なので、preview も見たいここでは節名を引数にする。
 * **期待値をテストへ書き写さない**ための関数である。
 *
 * **正規表現で節を切り出さない。** 行を順に読んで、見出し（`[...]`）で節を切り替える。
 * 節名を正規表現へ埋め込む形は、`.` のエスケープと「次の見出しまで」の表現の両方を
 * 正しく書く必要があり、**間違えても「値が無い」と答えて緑になれる**（見つからなければ
 * null を返す関数なので、判定が静かに反転する）。行を数えるほうが短く、壊れ方が素直である。
 *
 * @param toml `wrangler.toml` の中身
 * @param section 節名（例: `env.production.vars`。トップレベルは `vars`）
 * @param key 変数名
 * @returns 値。見つからなければ null
 */
function varIn(toml: string, section: string, key: string): string | null {
  let current: string | null = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    // **`[[...]]`（配列の節）も見出しとして扱う。** 拾わないと、`[[env.production.
    // d1_databases]]` の中の行が直前の `[env.production.vars]` の宣言として読まれる。
    const heading = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (heading !== null) {
      current = heading[1]!;
      continue;
    }
    if (current !== section) {
      continue;
    }
    // **コメント行は読まない。** `# ADMIN_HOST = "..."` を宣言として読むと、注記に
    // 書いただけの値を「宣言されている」と答える。
    if (line.startsWith('#')) {
      continue;
    }
    const matched = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'u').exec(line);
    if (matched !== null) {
      return matched[1]!;
    }
  }
  return null;
}

describe('ADMIN_HOST の宣言（#356 / 2.4.1）', () => {
  it('節の切り出しが、別の節の値やコメントを拾わない', () => {
    // **この抽出が緩むと、下の検査が「どの環境の値か」を取り違えたまま緑になる。**
    const sample = [
      '[vars]',
      '# A = "commented"',
      'A = "local"',
      '',
      '[env.production.vars]',
      'A = "prod"',
      '',
      '[[env.production.d1_databases]]',
      'A = "not a var"',
    ].join('\n');
    expect(varIn(sample, 'vars', 'A')).toBe('local');
    expect(varIn(sample, 'env.production.vars', 'A')).toBe('prod');
    expect(varIn(sample, 'env.preview.vars', 'A')).toBeNull();
  });

  it('3 つの環境すべてで ADMIN_HOST を宣言している', () => {
    // **vars は名前付き環境へ引き継がれない**（`wrangler.toml` の注記）。1 つ書き忘れると、
    // その環境では `src/index.ts` の振り分けが admin を知らないまま動く。
    for (const section of ['vars', 'env.production.vars', 'env.preview.vars']) {
      expect(varIn(env.TEST_WRANGLER_TOML, section, 'ADMIN_HOST'), section).not.toBeNull();
    }
  });

  it('本番の ADMIN_HOST が app と兄弟で、同一サイトである', () => {
    const appHost = varIn(env.TEST_WRANGLER_TOML, 'env.production.vars', 'APP_HOST');
    const adminHost = varIn(env.TEST_WRANGLER_TOML, 'env.production.vars', 'ADMIN_HOST');
    expect(adminHost).toBe('admin.game-forge.ojos.jp');
    // **別オリジンである**（ホスト名が違う）。
    expect(adminHost).not.toBe(appHost);
    // **同一サイトである**（登録可能ドメインが同じ）。だから `__Host-` が要り、
    // **だからセッションを共有できない**（2.4.1）。
    expect(adminHost!.endsWith('.game-forge.ojos.jp')).toBe(true);
    expect(appHost!.endsWith('.game-forge.ojos.jp')).toBe(true);
  });

  it('ローカルの 3 ホストが互いに違う', () => {
    // 取り違えると、出し分けの検証そのものが成立しない。
    const hosts = [env.APP_HOST, env.SANDBOX_HOST, env.ADMIN_HOST];
    expect(new Set(hosts).size).toBe(3);
  });
});

describe('3 つ目のホストとしての振り分け（#356 / 2.4.1）', () => {
  it('admin ホストは admin 側を返す（権限が無いので 404 の JSON）', async () => {
    // **`SELF.fetch` を通す**——`src/index.ts` の振り分けそのものを見たいので、
    // ハンドラを直接呼ばない。
    const response = await SELF.fetch(`${ADMIN_ORIGIN}/`);
    expect(response.status).toBe(404);
    // **未知のホストの 404 と区別する。** あちらは `unknown host` を返す。
    const body = await response.text();
    expect(body).not.toContain('unknown host');
    expect(JSON.parse(body)).toEqual({ error: 'not found', path: '/' });
  });

  it('admin ホストはアプリ側のトップを返さない', async () => {
    // 振り分けが app へ落ちていたら、ここに公開トップの見出しが出る。
    const response = await SELF.fetch(`${ADMIN_ORIGIN}/`);
    expect(await response.text()).not.toContain('<h1 class="gf-header-title">');
  });

  it('admin ホストはサンドボックスの CSP を付けない', async () => {
    // 3 つの分岐のうち、どれへ落ちたかを別の印でも確かめる。
    const response = await SELF.fetch(`${ADMIN_ORIGIN}/`);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('未知のホストの 404 が、期待するホストとして admin も挙げる', async () => {
    // **綴りを間違えた配備に気づけるようにする。** 期待値の一覧に admin が無いと、
    // 「admin のはずが未知のホストだった」ときに何と比べるべきかが読めない。
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      expected: { app: string; sandbox: string; admin: string };
    };
    expect(body.expected.admin).toBe(env.ADMIN_HOST);
  });

  it('サンドボックス用ホストは admin へ落ちない', async () => {
    // 分岐を 1 つ足したことで、既存の出し分けが壊れていないこと。
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  });

  it('ADMIN_HOST を宣言し忘れても、残りのホストは動く（500 にしない）', async () => {
    // **型が `string` であることは、実行時に値があることの根拠ではない**
    // （`src/env.d.ts` の冒頭）。素で `normalizeHost(undefined)` を呼ぶと投げ、
    // **全ホストの全要求が 500 になる。** 事故の範囲を admin の中へ閉じ込める。
    const { default: worker } = await import('../src/index.js');
    const withoutAdmin = { ...env } as Record<string, unknown>;
    delete withoutAdmin['ADMIN_HOST'];
    const asEnv = withoutAdmin as unknown as Env;

    // app は動く。
    const app = await worker.fetch(new Request(`${APP_ORIGIN}/`), asEnv, createExecutionContext());
    expect(app.status).toBe(200);
    // admin は未知のホストとして 404（500 ではない）。
    const admin = await worker.fetch(new Request(`${ADMIN_ORIGIN}/`), asEnv, createExecutionContext());
    expect(admin.status).toBe(404);
    expect(await admin.text()).toContain('unknown host');
  });
});

describe('2 つの経路表が混ざらない（#356 の constraints）', () => {
  /** app ホストにしか無い画面の綴り（**それぞれの提供側の定数から取る**）。 */
  const APP_ONLY_PATHS = [PUBLIC_WORKS_PATH, MY_WORKS_PATH, ACCOUNT_PATH, TERMS_PATH, TAKEDOWN_PATH];

  it('admin の経路表に app の画面が 1 つも無い', () => {
    const adminPaths = createAdminRoutes().map((route) => route.path);
    for (const path of APP_ONLY_PATHS) {
      expect(adminPaths, `admin の経路表に ${path} がある`).not.toContain(path);
    }
  });

  it('app の経路表に admin の画面が 1 つも無い', () => {
    // **`ADMIN_HOME_PATH` は `/` なので、パスの照合では見分けられない**（app も `/` を
    // 持つ）。**ハンドラの同一性で見る**——admin のトップのハンドラが app の表に
    // 入っていないこと。
    const adminHome = createAdminRoutes().find(
      (route) => route.path === ADMIN_HOME_PATH && route.method === 'GET',
    );
    expect(adminHome, 'admin のトップが admin の経路表に無い').toBeDefined();
    const appHandlers = createAppRoutes(env).map((route) => route.handler);
    expect(appHandlers).not.toContain(adminHome!.handler);
  });

  it('admin ホストで app の画面を開くと 404 になる（実際に叩く）', async () => {
    // 表の照合だけでは、**`dispatch` の前方一致が拾う形**を見落とす。実物を叩く。
    for (const path of APP_ONLY_PATHS) {
      const response = await SELF.fetch(`${ADMIN_ORIGIN}${path}`);
      expect(response.status, `admin ホストの ${path}`).toBe(404);
      expect(await response.text(), `admin ホストの ${path}`).not.toContain('<h1>');
    }
  });

  it('app ホストで admin の画面を開くと、admin の中身は出ない', async () => {
    // `ADMIN_HOME_PATH` は `/` なので、**app 側では公開トップが出るのが正しい。**
    // 見るのは「admin の中身が出ていないこと」である。
    const response = await SELF.fetch(`${APP_ORIGIN}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<h1 class="gf-header-title">');
    expect(body).not.toContain('<h1>審査キュー</h1>');
    expect(body).not.toContain('gf-admin-header');
  });

  it('admin の経路表そのものが健全である（重複・接頭辞の綴り）', () => {
    // `src/routes.ts` の 2 つの機械検査を admin の表にも通す。**app の表にしか
    // 掛かっていない状態を作らない**——`dispatch` は重複しても動いてしまうため、
    // 後から連結した側が黙って無視される事故は admin 側でも同じように起きる。
    const routes = createAdminRoutes();
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
  });
});
