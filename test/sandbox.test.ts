import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPreviewKey } from '../src/games.js';
import { parseSandboxPath } from '../src/sandbox-delivery.js';
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
  // 版の出し分けは M4-4（#29）の範囲。いまは 1 つだけ置く。
  await env.BUCKET.put('runtime/wasm_exec.js', '/* wasm_exec.js */');
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
      `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${SANDBOX_ORIGIN}/g/${game.id}/wasm_exec.js`,
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

  it('GET と HEAD 以外は 405 になる', async () => {
    const game = await seedGame({ suffix: 'method', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});

describe('資材の配信（#28）', () => {
  it('.wasm が R2 のオブジェクトとして届く', async () => {
    const game = await seedGame({ suffix: 'bytes', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/game.wasm`);
    expect(response.status).toBe(200);
    // どの R2 オブジェクトを返したかを etag で確かめる。本文で確かめないのは、
    // `Content-Encoding` が付いた本文を受け取り側が展開しうるためで、ここで見たいのは
    // 「キーが指すオブジェクトが届いたか」だけである。
    const stored = await env.BUCKET.get(game.wasmKey!);
    expect(response.headers.get('etag')).toBe(stored!.httpEtag);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('wasm_exec.js が届く', async () => {
    const game = await seedGame({ suffix: 'exec', status: 'published' });
    const response = await SELF.fetch(`${SANDBOX_ORIGIN}/g/${game.id}/wasm_exec.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('wasm_exec.js');
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

describe('ローダー文書（#28）', () => {
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
