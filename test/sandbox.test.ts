import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPreviewKey } from '../src/games.js';
import { parseSandboxPath, wasmExecKey } from '../src/sandbox-delivery.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;

/** 検査に使う Go の版。`test/helpers/build-outcome.ts` の版に合わせてある。 */
const GO_VERSION = 'go1.26.5';

/**
 * `.wasm.br` の代わりに置く、**本物の brotli ストリーム**。
 *
 * 中身は wasm のマジックナンバー 8 バイト（`\0asm` + version）を brotli で圧縮したもの。
 * ダミーのテキストではなく本物の圧縮列を置くのは、配信レスポンスに
 * `Content-Encoding: br` を付けるためである。**経路のどこかが展開を試みたときに、
 * 展開できないバイト列だと「ヘッダの検査」ではなく「壊れた本文」で落ちる。**
 * 何を見ているのか分からない赤を作らない。
 *
 * 生成: `zlib.brotliCompressSync(Buffer.from([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00]))`
 */
const WASM_BR_BASE64 = 'iwOAAGFzbQEAAAAD';

/** 上を展開したときのバイト列（wasm のマジックナンバー）。 */
const WASM_PLAIN_BASE64 = 'AGFzbQEAAAA=';

/**
 * base64 をバイト列へ戻す。
 *
 * @param value base64 文字列
 * @returns バイト列
 */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * CSP から 1 つのディレクティブを取り出す。
 *
 * **`toContain` で済ませない。** 「`connect-src` に何かが含まれる」ことと
 * 「`connect-src` がそれ**だけ**を許す」ことは別で、#28 が保証したいのは後者である。
 * 部分一致で書くと、`connect-src https:` のような全開の指定でも通ってしまう。
 *
 * @param csp `Content-Security-Policy` ヘッダの値
 * @param name ディレクティブ名
 * @returns ディレクティブ 1 行（見つからなければ空文字）
 */
function directiveOf(csp: string, name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? '';
}

/** テストが作る `games` 行の指定。 */
interface SeedGame {
  readonly suffix: string;
  readonly status: 'draft' | 'published' | 'removed';
  readonly goVersion?: string;
  /** `null` を渡すと tombstone（5.3 / M5-4）の行になる。 */
  readonly wasmKey?: string | null;
}

/** 作った行の識別子。 */
interface SeededGame {
  readonly id: string;
  readonly previewKey: string;
  readonly wasmKey: string | null;
}

/**
 * `games` 行を 1 つ作る。
 *
 * `createDraftGame` を使わないのは、この検査が見たいのが**配信側**であり、
 * `published` や `removed`、tombstone といった生成経路が作らない状態も要るためである。
 *
 * @param seed 作る行の指定
 * @returns 作った行の識別子
 */
async function seedGame(seed: SeedGame): Promise<SeededGame> {
  const id = crypto.randomUUID();
  const previewKey = createPreviewKey();
  const wasmKey =
    seed.wasmKey === undefined ? `builds/${seed.suffix.padEnd(64, '0')}/${GO_VERSION}/game.wasm.br` : seed.wasmKey;

  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, source_key, wasm_key, created_at, preview_key)
     values (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      'sandbox-author',
      seed.status,
      'タイトル',
      seed.goVersion ?? GO_VERSION,
      `builds/${seed.suffix.padEnd(64, '0')}/source.go`,
      wasmKey,
      previewKey,
    )
    .run();

  if (wasmKey !== null) {
    await env.BUCKET.put(wasmKey, fromBase64(WASM_BR_BASE64));
  }
  return { id, previewKey, wasmKey };
}

beforeAll(async () => {
  await applySchema();
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind('sandbox-author', 'sub-sandbox-author', 'sandbox@example.com', 'author')
    .run();
  // 3.5 の出し分けの土台。**配信側は R2 に置かれたものを正本とする**ので、
  // ここで置いた版だけが引ける。
  await env.BUCKET.put(`runtime/${GO_VERSION}/wasm_exec.js`, '/* wasm_exec.js go1.26.5 */');
});

describe('パスの解釈（#28）', () => {
  it('プレビューと公開の 2 つの接頭辞だけを受ける', () => {
    const previewKey = 'a'.repeat(32);
    const gameId = '0189d3f2-9c1a-4b7e-8f0d-1a2b3c4d5e6f';

    expect(parseSandboxPath(`/p/${previewKey}/`)).toEqual({
      scope: 'preview',
      identifier: previewKey,
      asset: 'document',
    });
    expect(parseSandboxPath(`/g/${gameId}/game.wasm`)).toEqual({
      scope: 'published',
      identifier: gameId,
      asset: 'wasm',
    });
    expect(parseSandboxPath(`/g/${gameId}/wasm_exec.js`)).toEqual({
      scope: 'published',
      identifier: gameId,
      asset: 'wasm-exec',
    });
  });

  it('末尾スラッシュの有無で結果が変わらない', () => {
    // どちらか一方だけが動く状態は、リンクを踏む体験として意味が無い。
    const previewKey = 'b'.repeat(32);
    expect(parseSandboxPath(`/p/${previewKey}`)).toEqual(parseSandboxPath(`/p/${previewKey}/`));
  });

  it('空のセグメントはどの位置でも通さない', () => {
    // **ここが緩むと実害がある。** `/p/<key>//` が文書として通ると、返す文書が埋める
    // 資材のパスは正規の綴り（`/p/<key>/game.wasm`）である一方、CSP は要求された URL の
    // ほうから組み立てられるため、**CSP が許した URL と実際に読む URL が食い違う。**
    // 結果は「自分の wasm を読めないページ」で、200 で返るぶん壊れて見えない。
    const previewKey = 'd'.repeat(32);
    const gameId = '0189d3f2-9c1a-4b7e-8f0d-1a2b3c4d5e6f';
    for (const path of [
      `/p/${previewKey}//`, // 末尾スラッシュの重なり
      `/g/${gameId}//`,
      `/g/${gameId}/game.wasm/`, // ファイル名に末尾スラッシュは付かない
      `/p/${previewKey}/wasm_exec.js/`,
      `/p//${previewKey}/`,
      `/p/${previewKey}//game.wasm`,
    ]) {
      expect(parseSandboxPath(path), path).toBeNull();
    }
  });

  it('末尾スラッシュを許すのは文書の経路だけである', () => {
    // 文書は `/p/<key>` と `/p/<key>/` の両方を受ける（リンクを踏む体験のため）。
    // 資材は 1 つの綴りしか受けない。
    const previewKey = 'e'.repeat(32);
    expect(parseSandboxPath(`/p/${previewKey}`)).not.toBeNull();
    expect(parseSandboxPath(`/p/${previewKey}/`)).not.toBeNull();
    expect(parseSandboxPath(`/p/${previewKey}/game.wasm`)).not.toBeNull();
    expect(parseSandboxPath(`/p/${previewKey}/game.wasm/`)).toBeNull();
  });

  it('綴りが違えば必ず null を返す', () => {
    const previewKey = 'c'.repeat(32);
    const gameId = '0189d3f2-9c1a-4b7e-8f0d-1a2b3c4d5e6f';
    for (const path of [
      '/',
      '/p/',
      `/p/${previewKey.slice(0, 31)}/`, // 桁が足りない
      `/p/${previewKey.toUpperCase()}/`, // 大文字は綴りが違う
      `/p/${gameId}/`, // プレビュー経路に作品 id は入らない
      `/g/${previewKey}/`, // 公開経路に 16 進 32 桁は入らない
      `/p/${previewKey}/../../etc`, // 経路の外へ出ようとするもの
      `/p/${previewKey}/game.wasm.br`, // 綴りが 1 文字でも違えば通さない
      `/p/${previewKey}/game.wasm/x`,
      `/x/${previewKey}/`,
      `//p/${previewKey}/`,
    ]) {
      expect(parseSandboxPath(path), path).toBeNull();
    }
  });
});

describe('配信オリジンが親と異なる（#28 acceptance 1）', () => {
  it('サンドボックス用ホストとアプリ用ホストが別オリジンである', () => {
    expect(env.SANDBOX_HOST).not.toBe(env.APP_HOST);
  });

  it('同じパスがアプリ用ホストでは配信されない', async () => {
    const game = await seedGame({ suffix: 'origin', status: 'published' });

    const fromSandbox = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`);
    expect(fromSandbox.status).toBe(200);
    expect(fromSandbox.headers.get('content-type')).toContain('text/html');

    // **UGC が親オリジンから出る経路が無いこと**が 7.2 の一番外側の要件である。
    const fromApp = await SELF.fetch(`${APP_ORIGIN}/g/${game.id}/`);
    expect(fromApp.status).toBe(404);
    expect(await fromApp.text()).not.toContain('instantiateStreaming');
  });
});

describe('CSP（#28 acceptance 2 / 3、7.2）', () => {
  it('allow-same-origin を決して付けない', async () => {
    const game = await seedGame({ suffix: 'same-origin', status: 'published' });
    for (const path of [`/g/${game.id}/`, `/g/${game.id}/game.wasm`, `/g/${game.id}/wasm_exec.js`, '/']) {
      const response = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain('sandbox allow-scripts');
      expect(csp, path).not.toContain('allow-same-origin');
    }
  });

  it('connect-src がその作品の .wasm 1 本だけを許す', async () => {
    // #28 acceptance 2「iframe 内からの fetch が CSP で遮断されること」の機械的な形。
    // ブラウザを起動できないので、**許可の集合そのもの**を検査する。
    // 集合が 1 要素で、それが自分の .wasm であるなら、任意の宛先への fetch は届かない。
    const game = await seedGame({ suffix: 'connect', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`);
    const csp = response.headers.get('content-security-policy') ?? '';

    // **完全一致で見る。** 「含む」で書くと `connect-src https: <url>` のような
    // 全開の指定でも通ってしまい、集合が 1 要素であることを保証できない。
    expect(directiveOf(csp, 'connect-src')).toBe(
      `connect-src ${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`,
    );
  });

  it('別の作品の .wasm は許可されない', async () => {
    // ホスト全体を許すのではなく URL 1 本に絞ったことの帰結。ここが崩れると、
    // 1 つの作品が同じホスト上の他の作品を読める。
    const mine = await seedGame({ suffix: 'mine', status: 'published' });
    const other = await seedGame({ suffix: 'other', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${mine.id}/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain(other.id);
  });

  it('script-src がその作品の wasm_exec.js 1 本だけを許す', async () => {
    const game = await seedGame({ suffix: 'script', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(directiveOf(csp, 'script-src')).toBe(
      `script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${SANDBOX_ORIGIN}/g/${game.id}/wasm_exec.js`,
    );
  });

  it('script-src が blob: を許す（#306。AudioWorklet のモジュール読み込み）', async () => {
    // **この検査は「書いてあること」しか見ていない。** ワークレットが実際に読めるかは
    // CSP の文字列からは導けない（#180 と同じ形。`scripts/check-sandbox-browser.sh` の
    // 層 5 が実ブラウザで見る）。ここで押さえるのは**うっかり消えないこと**である。
    const game = await seedGame({ suffix: 'worklet', status: 'published' });
    const csp =
      (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).headers.get(
        'content-security-policy',
      ) ?? '';
    expect(directiveOf(csp, 'script-src').split(' ')).toContain('blob:');
    // **`connect-src` は道連れで緩んでいない。** `blob:` の取得は `connect-src` の管轄に
    // 入らないため、外へ出られる宛先は 1 つも増えない。
    expect(directiveOf(csp, 'connect-src')).toBe(
      `connect-src ${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`,
    );
  });

  it('default-src / base-uri / form-action を閉じたままにする', async () => {
    const game = await seedGame({ suffix: 'closed', status: 'published' });
    const csp = (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).headers.get(
      'content-security-policy',
    ) ?? '';
    expect(directiveOf(csp, 'default-src')).toBe("default-src 'none'");
    expect(directiveOf(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directiveOf(csp, 'form-action')).toBe("form-action 'none'");
  });

  it('frame-ancestors を親アプリのオリジンだけに絞る', async () => {
    const game = await seedGame({ suffix: 'ancestors', status: 'published' });
    const csp = (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).headers.get(
      'content-security-policy',
    ) ?? '';
    expect(directiveOf(csp, 'frame-ancestors')).toBe(`frame-ancestors ${APP_ORIGIN}`);
  });

  it('作品を返さないレスポンスは connect-src を none に保つ', async () => {
    const game = await seedGame({ suffix: 'closed-sub', status: 'published' });
    for (const path of [`/g/${game.id}/game.wasm`, `/g/${game.id}/wasm_exec.js`, '/', '/p/zz/']) {
      const csp =
        (await SELF.fetch(`${SANDBOX_ORIGIN}${path}`)).headers.get('content-security-policy') ?? '';
      expect(directiveOf(csp, 'connect-src'), path).toBe("connect-src 'none'");
    }
  });

  it('cookie を一切設定しない（7.2 必須要件 3）', async () => {
    const game = await seedGame({ suffix: 'cookie', status: 'published' });
    for (const path of [`/g/${game.id}/`, `/g/${game.id}/game.wasm`, '/']) {
      const response = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`);
      expect(response.headers.get('set-cookie'), path).toBeNull();
    }
  });
});

describe('不透明オリジンからの自己資材の取得（#180）', () => {
  // **この検査群が塞ぐ穴は、CSP の検査では原理的に捕まらない。**
  //
  // #28 / #29 の検査は「CSP が許しているか」だけを見ていた。7.2 必須要件 1 の帰結で
  // 文書が不透明オリジンになるため、**CSP が許していても CORS が別の理由で塞ぐ**という
  // 組み合わせが成立する。実際に本番でそうなり（#180）、`起動できませんでした:
  // TypeError: Failed to fetch` だけが利用者に見えていた。
  //
  // **ここで見るのは CSP ではなく応答ヘッダである。** ブラウザが応答を読めるかどうかを
  // 決めるのは ACAO であり、それは curl でも CSP の照合でも確かめられない
  // （どちらも CORS を評価しない）。**実ブラウザでの確認は scripts/check-sandbox-browser.sh。**

  it('.wasm の応答に Access-Control-Allow-Origin が付く', async () => {
    // #180 の本体。**これが無いとプレイ経路が動かない。**
    const game = await seedGame({ suffix: 'cors-wasm', status: 'published' });
    for (const path of [`/g/${game.id}/game.wasm`, `/p/${game.previewKey}/game.wasm`]) {
      const response = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`, {
        // 不透明オリジンの文書が実際に送る形。ブラウザは `Origin: null` を付ける。
        headers: { origin: 'null' },
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });

  it('Origin ヘッダの有無や値で応答が変わらない', async () => {
    // **`*` を選んだ判断そのものを固定する。** 要求ごとに値を変える形（`Origin` の
    // 反射や `null` の出し分け）へ寄ると `Vary: Origin` の管理が付いて回り、
    // `/g/` の `.wasm` は共有キャッシュに載る（`public, immutable`）ため、`Vary` を
    // 1 度落とした日に別のオリジン向けの応答が配られる。
    const game = await seedGame({ suffix: 'cors-vary', status: 'published' });
    const url = `${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`;
    const values = await Promise.all(
      [undefined, 'null', 'https://evil.example', APP_ORIGIN].map(async (origin) => {
        const response = await SELF.fetch(
          url,
          origin === undefined ? {} : { headers: { origin } },
        );
        return response.headers.get('access-control-allow-origin');
      }),
    );
    expect(new Set(values)).toEqual(new Set(['*']));
  });

  it('Vary に Origin を入れない', async () => {
    // 上の裏返し。応答が `Origin` に依らないなら、依らないと書くのが壊れにくい。
    const game = await seedGame({ suffix: 'cors-novary', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect((response.headers.get('vary') ?? '').toLowerCase()).not.toContain('origin');
  });

  it('すべての応答に付く（文書・wasm_exec・エラー）', async () => {
    // **一律に付ける**という判断を固定する。資材ごとの付け外しにすると、資材が
    // 増えた日の付け忘れが本番のブラウザでしか見えない（#180 そのもの）。
    const game = await seedGame({ suffix: 'cors-all', status: 'published' });
    for (const path of [
      `/g/${game.id}/`,
      `/g/${game.id}/wasm_exec.js`,
      `/p/${game.previewKey}/`,
      '/', // 404
      `/p/${'f'.repeat(32)}/`, // 404（知らないキー）
    ]) {
      const response = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`);
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });

  it('.wasm が 404 / 500 のときも応答が読める', async () => {
    // **診断が利用者へ届くために要る。** ACAO が無いとブラウザは 404 も 500 も
    // 破棄するため、原因の違う失敗が一様に `TypeError: Failed to fetch` になる。
    // 配信側が 3.7 の「隙間を隠さない」で 500 を返しても、誰にも見えない。
    const tomb = await seedGame({ suffix: 'cors-404', status: 'published', wasmKey: null });
    const missing = await seedGame({ suffix: 'cors-500', status: 'published' });
    await env.BUCKET.delete(missing.wasmKey!);

    const notFound = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${tomb.id}/game.wasm`, {
      headers: { origin: 'null' },
    });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('access-control-allow-origin')).toBe('*');

    const serverError = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${missing.id}/game.wasm`, {
      headers: { origin: 'null' },
    });
    expect(serverError.status).toBe(500);
    expect(serverError.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('Access-Control-Allow-Credentials を決して付けない', async () => {
    // `*` は資格情報付きの要求を構造的に拒む（`*` と `Allow-Credentials` は併用できない）。
    // **その性質を頼りにしている**ので、片方だけが足された状態を作らせない。
    const game = await seedGame({ suffix: 'cors-cred', status: 'published' });
    for (const path of [`/g/${game.id}/`, `/g/${game.id}/game.wasm`, '/']) {
      const response = await SELF.fetch(`${SANDBOX_ORIGIN}${path}`, {
        headers: { origin: 'null' },
      });
      expect(response.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
  });

  it('CORS を足しても connect-src は 1 本のままである', async () => {
    // **「CORS を足した＝緩めた」という誤読を機械で塞ぐ。** 7.2 が塞いでいるのは
    // 生成物が外へ出ることで、それを塞ぐのは `connect-src` である。ACAO は
    // 「この応答を要求元へ渡してよい」と言うだけで、宛先の集合に 1 要素も足さない。
    const game = await seedGame({ suffix: 'cors-connect', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(directiveOf(csp, 'connect-src')).toBe(
      `connect-src ${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`,
    );
    expect(csp).not.toContain('allow-same-origin');
  });
});

describe('公開状態による出し分け（5.4 / #28）', () => {
  it('/g/ は published だけを返す', async () => {
    const published = await seedGame({ suffix: 'pub', status: 'published' });
    const draft = await seedGame({ suffix: 'dft', status: 'draft' });
    const removed = await seedGame({ suffix: 'rmv', status: 'removed' });

    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/g/${published.id}/`)).status).toBe(200);
    // 5.4:「公開」操作で初めて URL が有効になる。
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/g/${draft.id}/`)).status).toBe(404);
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/g/${removed.id}/`)).status).toBe(404);
  });

  it('/p/ は draft と published を返し、removed は返さない', async () => {
    const draft = await seedGame({ suffix: 'pdft', status: 'draft' });
    const published = await seedGame({ suffix: 'ppub', status: 'published' });
    const removed = await seedGame({ suffix: 'prmv', status: 'removed' });

    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/p/${draft.previewKey}/`)).status).toBe(200);
    // 公開した瞬間に作者のプレビュー URL が壊れないこと。
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/p/${published.previewKey}/`)).status).toBe(200);
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/p/${removed.previewKey}/`)).status).toBe(404);
  });

  it('知らないキーは 404 になる', async () => {
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/p/${'f'.repeat(32)}/`);
    expect(response.status).toBe(404);
  });

  it('不在の理由を本文で区別しない', async () => {
    // unlisted キーが唯一の資格情報なので、「存在するが未公開」と「存在しない」を
    // 区別して返すと総当たりの手がかりになる。
    const draft = await seedGame({ suffix: 'opaque', status: 'draft' });
    const unknown = await SELF.fetch(`${SANDBOX_ORIGIN}/p/${'e'.repeat(32)}/`);
    const notPublished = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${draft.id}/`);
    expect(await unknown.text()).toBe(await notPublished.text());
  });

  it('空セグメントの混ざった URL は配信経路でも 404 になる', async () => {
    // 上の `parseSandboxPath` の検査と同じことを、入口から通して見る。
    const game = await seedGame({ suffix: 'empty-seg', status: 'published' });
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).status).toBe(200);
    for (const path of [`/g/${game.id}//`, `/g/${game.id}/game.wasm/`]) {
      expect((await SELF.fetch(`${SANDBOX_ORIGIN}${path}`)).status, path).toBe(404);
    }
  });

  it('HEAD は受け付ける', async () => {
    // 405 の本文と `Allow` が「HEAD も受ける」と言っている以上、実際に受けること。
    const game = await seedGame({ suffix: 'head', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  });

  it('GET と HEAD 以外は Allow 付きの 405 になる', async () => {
    const game = await seedGame({ suffix: 'method', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`, { method: 'POST' });
    expect(response.status).toBe(405);
    // `src/routes.ts` の 405 と同じ形（「経路はあるが呼び方が違う」ことを示す）。
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    // **本文が実際の判定とずれていないこと。** 受け付けるメソッドを本文でも名乗る。
    expect(await response.text()).toContain('GET, HEAD');
  });
});

describe('.wasm の配信（#29 acceptance 1）', () => {
  it('Content-Type と Content-Encoding の両方が付く', async () => {
    // 3.4-2:「`Content-Encoding` だけを設定して `Content-Type` を落とすと、圧縮は
    // 効いているのにストリーミングだけが黙って失われる」。両方を個別に見る。
    const game = await seedGame({ suffix: 'headers', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(response.headers.get('content-encoding')).toBe('br');
    // MIME type の推測でどちらかが書き換わらないこと。
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('R2 のメタデータに何も入っていなくても両方が付く', async () => {
    // 置くのはビルド関数だが（3.4-1 / #21）、**配信側が返すものは配信側が決める。**
    // メタデータ任せにすると、置き方が変わった日に静かにストリーミングだけが落ちる。
    const game = await seedGame({ suffix: 'nometa', status: 'published' });
    const stored = await env.BUCKET.get(game.wasmKey!);
    expect(stored?.httpMetadata?.contentType).toBeUndefined();
    expect(stored?.httpMetadata?.contentEncoding).toBeUndefined();

    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(response.headers.get('content-encoding')).toBe('br');
  });

  it('R2 に置いたバイト列がそのまま届く', async () => {
    // **この検査は二重圧縮（#181）を捕まえられない。実測で確認済みである。**
    //
    // `SELF.fetch` は内部のサブリクエストで、**HTTP のエンコード境界を通らない。**
    // そのため `encodeBody` の指定に関係なく R2 のバイト列がそのまま返り、
    // `encodeBody: 'manual'` を外しても、この検査は緑のままである。
    //
    // **#180 と同じ形の盲点である**（代理は「宣言が正しいか」しか見ておらず、
    // 宣言が正しいのに実物が壊れる組み合わせを構造的に捕まえられない）。
    // **緑を「配信が正しい」と読まないこと。** 実 HTTP で確かめるのは
    // `scripts/check-sandbox-browser.sh` と `scripts/check-sandbox-cors.sh` である。
    const game = await seedGame({ suffix: 'bytes', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    const received = new Uint8Array(await response.arrayBuffer());
    // `Content-Encoding: br` を宣言しているため、受け取り側が展開していることも、
    // 圧縮列のまま届くこともありうる。**どちらでも、元のバイト列に対応していること**を
    // 見る（ここで確かめたいのは「R2 のオブジェクトが届いている」ことである）。
    const compressed = fromBase64(WASM_BR_BASE64);
    const plain = fromBase64(WASM_PLAIN_BASE64);
    const matched =
      received.length === compressed.length
        ? received.every((byte, index) => byte === compressed[index])
        : received.every((byte, index) => byte === plain[index]) && received.length === plain.length;
    expect(matched, `received ${received.length} bytes`).toBe(true);
  });

  it('公開済みは共有キャッシュ可、プレビューは private にする', async () => {
    const game = await seedGame({ suffix: 'cache', status: 'published' });
    const published = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect(published.headers.get('cache-control')).toContain('public');
    expect(published.headers.get('cache-control')).toContain('immutable');

    // unlisted キーが唯一の資格情報なので、共有キャッシュへ載せない。
    const preview = await SELF.fetch(`${SANDBOX_ORIGIN}/p/${game.previewKey}/game.wasm`);
    expect(preview.headers.get('cache-control')).toContain('private');
    expect(preview.headers.get('cache-control')).not.toContain('public');
  });

  it('tombstone された作品は 404 になる', async () => {
    // 5.3 / M5-4: 親の削除は物理削除せず tombstone 化し、`wasm_key` だけを落とす。
    const game = await seedGame({ suffix: 'tomb', status: 'published', wasmKey: null });
    expect((await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`)).status).toBe(404);
  });

  it('D1 に行があるのに R2 に実体が無ければ 5xx にする', async () => {
    // 3.7 が「残る隙間を隠さない」と書いた状態。404 にすると運用の異常が
    // 「消えた作品」に見え、気づかれないまま残る。
    const game = await seedGame({ suffix: 'missing', status: 'published' });
    await env.BUCKET.delete(game.wasmKey!);
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect(response.status).toBe(500);
  });
});

describe('wasm_exec.js の出し分け（3.5 / #29）', () => {
  it('go_version から R2 のキーを組み立てる', () => {
    expect(wasmExecKey('go1.26.5')).toBe('runtime/go1.26.5/wasm_exec.js');
    expect(wasmExecKey('go1.27')).toBe('runtime/go1.27/wasm_exec.js');
  });

  it('綴りが不正な go_version ではキーを作らない', () => {
    // R2 のキーへ埋める値なので、経路の外へ出る綴りを組み立てさせない。
    for (const value of ['', '1.26.5', 'go1.26.5/../../secret', '../runtime', 'go1.26.5 ']) {
      expect(wasmExecKey(value), value).toBeNull();
    }
  });

  it('作品の go_version に対応するファイルを返す', async () => {
    const game = await seedGame({ suffix: 'exec', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/wasm_exec.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toContain(GO_VERSION);
  });

  it('版が違えば違うファイルを返す', async () => {
    // 3.5 の要点。`go_version` を無視して 1 つのファイルを配ると、Go を上げた日に
    // 過去の全作品が壊れる。
    await env.BUCKET.put('runtime/go1.27.0/wasm_exec.js', '/* wasm_exec.js go1.27.0 */');
    const newer = await seedGame({ suffix: 'newer', status: 'published', goVersion: 'go1.27.0' });
    const older = await seedGame({ suffix: 'older', status: 'published' });

    expect(await (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${newer.id}/wasm_exec.js`)).text()).toContain(
      'go1.27.0',
    );
    expect(await (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${older.id}/wasm_exec.js`)).text()).toContain(
      GO_VERSION,
    );
  });

  it('置かれていない版へは別の版を配らずに失敗する', async () => {
    // **フォールバックを作らない。** 版が違う `wasm_exec.js` は読み込みに成功して
    // 実行時に壊れるため、いちばん原因が読めない失敗になる（3.5）。
    const game = await seedGame({ suffix: 'unknown', status: 'published', goVersion: 'go1.99.0' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/wasm_exec.js`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(GO_VERSION);
  });
});

describe('ローダー文書（3.4-2 / #29 acceptance 2）', () => {
  it('instantiateStreaming を使う', async () => {
    const game = await seedGame({ suffix: 'loader', status: 'published' });
    const body = await (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).text();
    expect(body).toContain('WebAssembly.instantiateStreaming(fetch(');
  });

  it('非ストリーミングのフォールバック経路を持たない', async () => {
    // 受け入れ条件「`instantiateStreaming` がフォールバック経路に落ちないこと」。
    // 巷のテンプレートは `if (!WebAssembly.instantiateStreaming) { ... arrayBuffer ... }`
    // を書いており、これがあるとヘッダを 1 つ落としただけで**黙って**非ストリーミングに
    // なる。文字列として存在しないことを見る。
    const game = await seedGame({ suffix: 'nofallback', status: 'published' });
    const body = await (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).text();
    expect(body).not.toContain('arrayBuffer');
    expect(body).not.toContain('WebAssembly.instantiate(');
    expect(body).not.toContain('WebAssembly.compile');
    expect(body).not.toContain('XMLHttpRequest');
  });

  it('CSP が許した URL とローダーが読む URL が一致する', async () => {
    // 一方だけを直すと、CSP は通るのに読めない（あるいはその逆）状態になる。
    const game = await seedGame({ suffix: 'match', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/p/${game.previewKey}/`);
    const body = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(body).toContain(`"/p/${game.previewKey}/game.wasm"`);
    expect(body).toContain(`src="/p/${game.previewKey}/wasm_exec.js"`);
    expect(directiveOf(csp, 'connect-src')).toBe(
      `connect-src ${SANDBOX_ORIGIN}/p/${game.previewKey}/game.wasm`,
    );
  });

  it('UGC 由来の文字列を文書へ入れない', async () => {
    // `script-src 'unsafe-inline'` を許している以上、UGC を混ぜるとエスケープ漏れが
    // そのままスクリプト実行になる。3.4-5 の文脈提示は親ページの責務である。
    const game = await seedGame({ suffix: 'ugc', status: 'published' });
    const body = await (await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`)).text();
    expect(body).not.toContain('タイトル');
    expect(body).not.toContain('sandbox-author');
  });

  it('文書はキャッシュしない', async () => {
    const game = await seedGame({ suffix: 'nostore', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
