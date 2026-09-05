import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DEV_SESSION_COOKIE,
  HEALTH_OBJECT_KEY,
  cookieNames,
  handleAppRequest,
} from '../src/app.js';
import { TEMPLATE_MODULE_PATH } from '../src/go-import-allowlist.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;

/**
 * `.dev.vars.example` から、文書化されている秘密のキー名を取り出す。
 *
 * 一覧をテストへ書き写さないための関数。雛形（`vitest.config.ts` が
 * `TEST_DEV_VARS_EXAMPLE` として渡す）を毎回解析するので、鍵を足しても
 * 追随の作業が要らず、削った鍵は自動的に許容されなくなる。
 *
 * `KEY=` の形の行だけを拾う。コメント行（`#` 始まり）は拾わない。ここを
 * 緩めると、コメントに書いただけの名前まで env への混入が許されてしまう。
 *
 * @param text `.dev.vars.example` の中身
 * @returns キー名の配列
 */
function documentedSecretNames(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line))
    .filter((matched): matched is RegExpExecArray => matched !== null)
    .map((matched) => matched[1]!);
}

describe('Worker の env に宣言外の値が混入しない', () => {
  it('文書化された秘密名の抽出が KEY= の行だけを拾う', () => {
    // この抽出が緩むと、下の検査が「宣言外の値の混入」を通すようになる。
    expect(
      documentedSecretNames(
        ['# COMMENTED_KEY=', '# 説明の中の A_KEY= も拾わない', 'REAL_KEY=', '\tTABBED_KEY = ', '', 'no-key-here'].join(
          '\n',
        ),
      ),
    ).toEqual(['REAL_KEY', 'TABBED_KEY']);
  });

  it('env のキーが wrangler.toml と .dev.vars.example の宣言だけで構成される', () => {
    // 検知層。wrangler は既定（CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=true）で
    // リポジトリ直下の .env を「シークレット」として読み、Worker の env へ流し込む。
    // このリポジトリの .env には開発ツール用の GH_TOKEN / GEMINI_API_KEY が入っており、
    // 混ざるとアプリのコードから参照でき、`wrangler deploy` では本番の secret として
    // アップロードされうる。npm script 側で false に倒しているが、それは「呼び出し方」
    // に依存する対策なので、混入したら落ちる検査をここへ置く。
    //
    // `__VITEST_POOL_WORKERS_*` はテストランナー自身が注入する結線用のバインディングで、
    // wrangler.toml 由来ではないため除外する（実行時には存在しない）。
    //
    // `TEST_` で始まるものも同じ理由で除外する。いずれも vitest.config.ts が
    // Node 側で読んで注入するもので、workerd 内にファイルシステムが無い以上これが
    // 唯一の経路になる。**除外は名前を明示したものに限る。** 前方一致や正規表現で
    // （たとえば `TEST_` の接頭辞で）緩めると、この検査が見ている「.env の混入」まで
    // 通してしまう。足すたびにこの配列へ 1 行書くのは、その明示の代償である。
    const injectedByRunner = [
      'TEST_MIGRATIONS',
      'TEST_DEV_VARS_EXAMPLE',
      'TEST_PRODUCT_SPEC',
      'TEST_VENDOR_DEPS',
      'TEST_BUILD_SAMPLE',
      'TEST_TEMPLATE_GO_MOD',
      'TEST_WRANGLER_TOML',
      'TEST_APP_CSS',
      'TEST_ROUTES_JSON',
    ];

    // `.dev.vars.example` に**書かれている**秘密名は許容する。
    //
    // 緩める理由: .dev.vars.example をコピーした開発者の環境では、wrangler が
    // .dev.vars を読んでアプリの env へ渡すため、これらのキーは正当に現れる
    // （むしろ現れないと #12 の認証が動かない）。許容しないと、雛形どおりに
    // 環境を作った開発者の手元だけがこのテストで落ちる。
    //
    // 緩めても検知の目的は保たれる: 許容するのは雛形に書かれた名前だけで、
    // .env 側のキー（GH_TOKEN / GEMINI_API_KEY など）は雛形に無いため、
    // 混入すれば従来どおり落ちる。一覧はテストへ書き写さず、雛形そのものから
    // 取り出す（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
    const documented = documentedSecretNames(env.TEST_DEV_VARS_EXAMPLE);

    const declared = Object.keys(env)
      .filter((key) => !key.startsWith('__VITEST_POOL_WORKERS_'))
      .filter((key) => !injectedByRunner.includes(key))
      .filter((key) => !documented.includes(key))
      .sort();
    expect(declared).toEqual([
      'APP_HOST',
      'BUCKET',
      // ビルド関数の宛先（#19）。**秘密ではなく構成**なので wrangler.toml が宣言する。
      'BUILD_FUNCTION_NAME',
      'DB',
      'DEV_ROUTES',
      'GENERATION_MODEL',
      // OGP 撮影関数の宛先（#26）。**秘密ではなく構成**なので wrangler.toml が
      // 宣言する（BUILD_FUNCTION_NAME と同じ扱い）。
      'OGP_FUNCTION_NAME',
      // オーケストレータの宛先（#160）。**秘密ではなく構成**なので wrangler.toml が
      // 宣言する（BUILD_FUNCTION_NAME と同じ扱い）。
      'ORCHESTRATOR_FUNCTION_NAME',
      'SANDBOX_HOST',
    ]);
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
    //
    // 後片付けは finally に置く。ローカル D1 の状態は .wrangler 配下に残るため、
    // 途中の assert が落ちるとテーブルが残り、以降のテストや手動確認へ影響する。
    await env.DB.exec('create table if not exists __dev_probe (id integer primary key, note text)');
    try {
      await env.DB.prepare('insert into __dev_probe (note) values (?)').bind('m0.5-3').run();
      const row = await env.DB.prepare(
        'select note from __dev_probe order by id desc limit 1',
      ).first<{ note: string }>();
      expect(row?.note).toBe('m0.5-3');
    } finally {
      await env.DB.exec('drop table __dev_probe');
    }
  });

  it('ローカル R2 へ書き込んだ内容を読み出せる', async () => {
    await env.BUCKET.put('__dev/probe.txt', 'hello');
    try {
      const object = await env.BUCKET.get('__dev/probe.txt');
      expect(object).not.toBeNull();
      expect(await object!.text()).toBe('hello');
    } finally {
      await env.BUCKET.delete('__dev/probe.txt');
    }
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

  it('R2 の疎通が途中で失敗しても後片付けする', async () => {
    // 上のテストは成功経路しか通らないため、put のあとで失敗する経路を注入する。
    // 後片付けを成功経路にだけ書くと、get が null を返した場合や text() が投げた
    // 場合にオブジェクトが残り、次回以降の判定を誤らせる。
    const deleted: string[] = [];
    const failingEnv = {
      APP_HOST: env.APP_HOST,
      SANDBOX_HOST: env.SANDBOX_HOST,
      // `/__dev/health` は開発用の経路なので、有効な設定を渡さないと 404 になる（#89）。
      DEV_ROUTES: env.DEV_ROUTES,
      DB: env.DB,
      BUCKET: {
        put: async () => undefined,
        // put した直後の get が null を返す（実際に起こりうる失敗経路）
        get: async () => null,
        delete: async (key: string) => {
          deleted.push(key);
        },
      },
    } as unknown as Env;

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}/__dev/health`),
      failingEnv,
    );

    expect(response.status).toBe(503);
    expect(deleted).toContain(HEALTH_OBJECT_KEY);
  });
});

describe('ホストによる出し分け（#51 acceptance 3）', () => {
  it('アプリ用ホストがアプリ側を返す', async () => {
    // `/` は #89 で開発用の索引から公開トップ（src/home.ts）へ変わった。ここが
    // 見たいのは Host による出し分けなので、アプリ側にしか無い見出しで判定する。
    const response = await SELF.fetch(`${APP_ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Game Forge</h1>');
  });

  it('サンドボックス用ホストがサンドボックス側を返す', async () => {
    // **`/` は 404 になる。** #28 で本物の配信が入り、サンドボックス用ホストは
    // `/p/<preview_key>/` と `/g/<game_id>/` しか持たなくなった（M0.5-3 の
    // プレースホルダ「sandbox origin」は役目を終えて消えている）。
    //
    // ここが見たいのは Host による出し分けなので、**サンドボックス側にしか無い
    // 印**で判定する。アプリ側の 404 は JSON、未知ホストの 404 も JSON で、
    // どちらも CSP `sandbox` ヘッダを持たない。
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
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
  // **配信レスポンス（作品を返す経路）の検査は test/sandbox.test.ts にある。**
  // ここに残すのは「サンドボックス用ホストへ来た要求は、作品が引けなくても
  // 必ず CSP を伴って返る」という入口側の性質だけである。
  it('サンドボックス側のレスポンスが sandbox allow-scripts を付ける', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    const csp = response.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(csp).toContain('sandbox allow-scripts');
  });

  it('サンドボックス側は allow-same-origin を決して付けない', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/`);
    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });

  it('作品を返さないレスポンスは connect-src を none に絞る', async () => {
    // 緩めるのはローダー文書だけである（#28 / src/sandbox-csp.ts）。それ以外は
    // 7.2 の記述どおり `'none'` のままであることを、入口の位置でも押さえておく。
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

/**
 * `go.mod` の `module` 行からモジュールパスを取り出す。
 *
 * **行頭に錨を打つ。** `go.mod` の注記は `//` で始まる散文で、`module` という語を
 * 本文に含む行がある。錨を外すと注記の一語を宣言として読み、照合が実体を見なくなる。
 *
 * @param goMod `go.mod` の中身
 * @returns モジュールパス。`module` 行が無ければ null
 */
function modulePathOf(goMod: string): string | null {
  const matched = /^module[ \t]+(\S+)[ \t]*$/mu.exec(goMod);
  return matched === null ? null : matched[1]!;
}

describe('隔離ビルドのテンプレートのモジュールパス（#285 / #298）', () => {
  // **この検査がここにある理由は、値の出どころが Node 側にしかないことである。**
  // workerd 内にファイルシステムが無いため、`docker/isolated-build/template/go.mod` は
  // `vitest.config.ts` が `TEST_TEMPLATE_GO_MOD` として注入する経路でしか読めない。
  // 注入するバインディングの員数を数えているのはこのファイル（上の env キー検査）なので、
  // 通し先もここへ置く。

  it('module 行の抽出が宣言だけを拾う', () => {
    // この抽出が緩むと、下の照合が「注記に現れた語」と比べるようになる。
    expect(
      modulePathOf(
        ['// module gameforge.local/注記の中の語', 'module example.com/real', '', 'go 1.27.0'].join(
          '\n',
        ),
      ),
    ).toBe('example.com/real');
    expect(modulePathOf('go 1.27.0\n')).toBeNull();
  });

  it('TEMPLATE_MODULE_PATH が go.mod の module 行と一致する', () => {
    // `src/go-import-allowlist.ts` の `TEMPLATE_MODULE_PATH` は module 行の**写し**で、
    // それが写しであることは、これまで記述にしか無かった（#298）。ずれても静かには
    // 壊れない（`vendor-deps.go` との照合が赤くなる）が、**赤の出方から写しへ辿る**
    // 必要があった。ここで直接照合する。
    expect(
      modulePathOf(env.TEST_TEMPLATE_GO_MOD),
      'src/go-import-allowlist.ts の TEMPLATE_MODULE_PATH は docker/isolated-build/template/go.mod の module 行の写しです。どちらかを変えたら両方を合わせてください',
    ).toBe(TEMPLATE_MODULE_PATH);
  });

  it('go.mod をずらすと照合が破れる（この検査が効いていることの確認）', () => {
    // 変異検査。**セグメント境界の 1 文字違いで落ちる**ことを見る
    // （`isTemplatePackage` が先頭一致ではなく境界で見ている理由と同じ形）。
    const doctored = env.TEST_TEMPLATE_GO_MOD.replace(
      /^module[ \t]+\S+[ \t]*$/mu,
      `module ${TEMPLATE_MODULE_PATH}foo`,
    );
    expect(doctored).not.toBe(env.TEST_TEMPLATE_GO_MOD);
    expect(modulePathOf(doctored)).not.toBe(TEMPLATE_MODULE_PATH);
  });
});
