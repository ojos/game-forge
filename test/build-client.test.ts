import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_FUNCTION_TIMEOUT_SECONDS,
  BUILD_INVOKE_TIMEOUT_MS,
  BUILD_SECRET_NAMES,
  BuildFunctionFailed,
  BuildNotConfigured,
  BuildRejected,
  BuildResponseUnreadable,
  BuildTimedOut,
  MAX_BUILD_INVOCATIONS_ON_TIMEOUT,
  artifactKeysOf,
  buildCacheRecordOf,
  createLambdaBuild,
  invokeBuildFunction,
  invokeEndpoint,
  missingBuildSecrets,
  readBuildResult,
} from '../src/build-client.js';
import { recordBuildCache, sourceCacheKey } from '../src/build-cache.js';
import type { GenerationResult } from '../src/generation-models.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/**
 * テスト用の env。
 *
 * **実在の鍵を使わない**（`test/bedrock.test.ts` と同じ理由）。D1 と R2 は本物の
 * ローカルバインディングをそのまま使う（キャッシュの検証がそこで成立する）。
 *
 * @param overrides 差し替える値（`null` を渡すとそのキーを消す）
 * @returns 差し替えた env
 */
function buildEnv(overrides: Record<string, string | null> = {}): Env {
  const copy = { ...env } as unknown as Record<string, unknown>;
  const base: Record<string, string> = {
    BUILD_AWS_REGION: 'ap-northeast-1',
    BUILD_AWS_ACCESS_KEY_ID: 'test-access-key-id',
    BUILD_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    BUILD_AWS_SESSION_TOKEN: '',
    BUILD_FUNCTION_NAME: 'game-forge-build',
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === null) {
      delete copy[key];
    } else {
      copy[key] = value;
    }
  }
  return copy as unknown as Env;
}

/** 送られたリクエストを捕まえる `fetch`。**実 Lambda を叩かない**（叩けば課金される）。 */
function capturingFetch(response: () => Response): {
  sent: Request[];
  fetch: (request: Request) => Promise<Response>;
} {
  const sent: Request[] = [];
  return {
    sent,
    fetch: async (request: Request) => {
      sent.push(request);
      return response();
    },
  };
}

/**
 * `.wasm.br` の申告を、本体と辻褄の合う形で作る。
 *
 * @param body 本体の中身
 * @returns 応答の `compressed` ノード
 */
async function compressedNode(body: string): Promise<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(body);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    bytes: bytes.byteLength,
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    contentEncoding: 'br',
    data: btoa(binary),
  };
}

/**
 * 関数の成功応答（`docker/isolated-build/handler/handler.go` の `Result`）。
 *
 * @param overrides 差し替える項目
 * @returns 応答本文
 */
async function buildResponseBody(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    ok: true,
    goVersion: 'go1.26.5',
    wasm: { bytes: 11_404_411, sha256: 'a'.repeat(64) },
    compressed: await compressedNode('brotli-bytes'),
    // 3.3-6: 関数が R2 へ書いたキー。**綴りは関数側が決める**
    // （`docker/isolated-build/handler/r2.go` の `artifactKeys`）。
    storage: {
      sourceKey: `builds/${'d'.repeat(64)}/source.go`,
      wasmKey: `builds/${'d'.repeat(64)}/go1.26.5/game.wasm.br`,
    },
    timings: {
      resetMs: 0,
      prepareMs: 20,
      buildMs: 18_562,
      compressMs: 2_373,
      uploadMs: 310,
      totalMs: 21_265,
    },
    ...overrides,
  };
}

/** 成功応答を返す `Response`。 */
function okResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-1', ...headers },
  });
}

/** 生成結果の雛形（3.3-3 の出力）。 */
function generated(source: string): GenerationResult {
  return {
    modelKey: 'sonnet-4-6',
    modelId: 'jp.anthropic.claude-sonnet-4-6',
    source,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    },
    stopReason: 'end_turn',
  };
}

describe('エンドポイント', () => {
  it('リージョンがホスト名に、関数名がパスに現れる', () => {
    expect(invokeEndpoint('ap-northeast-1', 'game-forge-build')).toBe(
      'https://lambda.ap-northeast-1.amazonaws.com/2015-03-31/functions/game-forge-build/invocations',
    );
  });

  it('ARN を URL 用に符号化する', () => {
    expect(invokeEndpoint('ap-northeast-1', 'arn:aws:lambda:ap-northeast-1:1:function:x')).toBe(
      'https://lambda.ap-northeast-1.amazonaws.com/2015-03-31/functions/' +
        'arn%3Aaws%3Alambda%3Aap-northeast-1%3A1%3Afunction%3Ax/invocations',
    );
  });
});

describe('設定の検査', () => {
  it('揃っていれば空を返す', () => {
    expect(missingBuildSecrets(buildEnv())).toEqual([]);
  });

  it('欠けている名前だけを返す（値は出さない）', () => {
    const missing = missingBuildSecrets(buildEnv({ BUILD_AWS_SECRET_ACCESS_KEY: '  ' }));
    expect(missing).toEqual(['BUILD_AWS_SECRET_ACCESS_KEY']);
  });

  it('宛先の欠落も同じ検査で捕まえる', () => {
    expect(missingBuildSecrets(buildEnv({ BUILD_FUNCTION_NAME: null }))).toEqual([
      'BUILD_FUNCTION_NAME',
    ]);
  });

  it('セッショントークンは必須に入れない（長命キーでは存在しない）', () => {
    expect(BUILD_SECRET_NAMES).not.toContain('BUILD_AWS_SESSION_TOKEN');
  });

  it('設定が欠けていれば呼び出しの手前で落ちる', async () => {
    const seam = capturingFetch(() => okResponse({}));
    await expect(
      invokeBuildFunction(buildEnv({ BUILD_AWS_ACCESS_KEY_ID: '' }), 'package main', {
        fetch: seam.fetch,
      }),
    ).rejects.toBeInstanceOf(BuildNotConfigured);
    // 鍵が無いのに送信していたら、資格情報なしのリクエストが AWS へ出る。
    expect(seam.sent).toHaveLength(0);
  });
});

describe('待ち時間の宣言（1.2.24 の申し送り）', () => {
  it('Workers 側の上限が関数のタイムアウトより長い', () => {
    // 短くすると先に諦めるのは呼び出し側になり、関数は走り続けて課金され、
    // しかも「どの段で時間を食ったか」が残らない。
    expect(BUILD_INVOKE_TIMEOUT_MS).toBeGreaterThan(BUILD_FUNCTION_TIMEOUT_SECONDS * 1000);
  });
});

describe('署名と要求の形（3.3-5 / 4.1）', () => {
  it('SigV4 で署名し、同期呼び出しとして POST する', async () => {
    const seam = capturingFetch(() => okResponse({ ok: false, stage: 'build', message: 'x' }));
    await expect(
      invokeBuildFunction(buildEnv(), 'package main', { fetch: seam.fetch }),
    ).rejects.toBeInstanceOf(BuildRejected);

    const [request] = seam.sent;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(invokeEndpoint('ap-northeast-1', 'game-forge-build'));
    // **署名対象サービスは `lambda`。** Bedrock（`bedrock`）と取り違えると 403 になる。
    const authorization = request?.headers.get('authorization') ?? '';
    expect(authorization).toContain('/ap-northeast-1/lambda/aws4_request');
    expect(authorization).toContain('Credential=test-access-key-id/');
    expect(request?.headers.get('x-amz-invocation-type')).toBe('RequestResponse');
    expect(await request!.json()).toEqual({ source: 'package main' });
  });

  it('長命キーでは空のセキュリティトークンを送らない', async () => {
    const body = await buildResponseBody();
    const seam = capturingFetch(() => okResponse(body));
    await invokeBuildFunction(buildEnv(), 'package main', { fetch: seam.fetch });
    expect(seam.sent[0]?.headers.get('x-amz-security-token')).toBeNull();
  });
});

describe('成功応答の読み取り（3.3-7）', () => {
  it('成果物の申告と Go の版を返す', async () => {
    const result = await readBuildResult(await buildResponseBody(), 'req-1');
    expect(result.goVersion).toBe('go1.26.5');
    expect(result.artifact.wasm.bytes).toBe(11_404_411);
    expect(result.artifact.compressed.contentEncoding).toBe('br');
    expect(result.timings.buildMs).toBe(18_562);
    expect(result.requestId).toBe('req-1');
    expect(new TextDecoder().decode(result.compressedData!)).toBe('brotli-bytes');
  });

  it('Go の版が無ければ読めないとする', async () => {
    // 3.5 の `wasm_exec.js` 出し分けに要る。空文字で埋めると配信できない作品になる。
    await expect(readBuildResult(await buildResponseBody({ goVersion: undefined }))).rejects.toThrow(
      BuildResponseUnreadable,
    );
  });

  it('Content-Encoding が無ければ読めないとする', async () => {
    // 3.4-2: 落とすと圧縮は効いているのにストリーミングだけが黙って失われる。
    const compressed = await compressedNode('brotli-bytes');
    delete compressed['contentEncoding'];
    await expect(readBuildResult(await buildResponseBody({ compressed }))).rejects.toThrow(
      BuildResponseUnreadable,
    );
  });

  it('本体が無くても成功として読む（3.3-6 が本来の形になったとき）', async () => {
    // `compressed.data` は器の段階の暫定である（docs/build-function.md）。関数が
    // R2 へ直接書くようになれば本体は返らない。**その日にここが壊れないこと。**
    const compressed = await compressedNode('brotli-bytes');
    delete compressed['data'];
    const result = await readBuildResult(await buildResponseBody({ compressed }));
    expect(result.compressedData).toBeNull();
    expect(result.artifact.compressed.bytes).toBeGreaterThan(0);
  });

  it('本体が申告と食い違えば読めないとする', async () => {
    // 6 MB 上限に触れて本文が切れても base64 は途中まで復号できる。壊れた
    // `.wasm.br` は R2 へ入るまで誰も気づかない。
    const compressed = await compressedNode('brotli-bytes');
    compressed['data'] = btoa('brotli-byte');
    await expect(readBuildResult(await buildResponseBody({ compressed }))).rejects.toThrow(
      BuildResponseUnreadable,
    );
  });

  it('本体のハッシュが申告と違えば読めないとする', async () => {
    const compressed = await compressedNode('brotli-bytes');
    compressed['sha256'] = 'f'.repeat(64);
    await expect(readBuildResult(await buildResponseBody({ compressed }))).rejects.toThrow(
      BuildResponseUnreadable,
    );
  });

  it('ok が真偽値でなければ読めないとする', async () => {
    await expect(readBuildResult({ goVersion: 'go1.26.5' })).rejects.toThrow(
      BuildResponseUnreadable,
    );
  });

  it('R2 のキーをそのまま運ぶ（3.3-6 / #21）', async () => {
    const result = await readBuildResult(await buildResponseBody());
    expect(result.keys.sourceKey).toBe(`builds/${'d'.repeat(64)}/source.go`);
    expect(result.keys.wasmKey).toBe(`builds/${'d'.repeat(64)}/go1.26.5/game.wasm.br`);
  });

  it('キーが無ければ読めないとする（成果物の無い作品を作らない）', async () => {
    // **空文字で埋めない。** 埋めると 3.3-8 が「どこも指さないキー」で `games` 行を
    // 作り、壊れていることに気づくのは作者の試遊（5.4）かプレイヤーになる。
    await expect(readBuildResult(await buildResponseBody({ storage: undefined }))).rejects.toThrow(
      BuildResponseUnreadable,
    );
    await expect(
      readBuildResult(await buildResponseBody({ storage: { sourceKey: 's', wasmKey: '' } })),
    ).rejects.toThrow(BuildResponseUnreadable);
    await expect(
      readBuildResult(await buildResponseBody({ storage: { wasmKey: 'w' } })),
    ).rejects.toThrow(BuildResponseUnreadable);
  });
});

describe('ヒットの有無によらず同じ形でキーが取れる（3.3-8 の前提）', () => {
  it('非ヒットは関数が書いたキー、ヒットは索引のキーを返す', async () => {
    const entry = {
      sourceSha256: 'e'.repeat(64),
      goVersion: 'go1.26.5',
      sourceKey: 'builds/cached/source.go',
      wasmKey: 'builds/cached/go1.26.5/game.wasm.br',
      wasmBytes: 1,
      wasmSha256: 'f'.repeat(64),
      compressedBytes: 2,
      compressedSha256: '0'.repeat(64),
      contentEncoding: 'br',
      createdAt: 1,
    };
    expect(artifactKeysOf({ cached: true, sourceSha256: entry.sourceSha256, goVersion: entry.goVersion, artifact: { wasm: { bytes: 1, sha256: entry.wasmSha256 }, compressed: { bytes: 2, sha256: entry.compressedSha256, contentEncoding: 'br' } }, entry })).toEqual({
      sourceKey: entry.sourceKey,
      wasmKey: entry.wasmKey,
    });

    const built = await readBuildResult(await buildResponseBody());
    expect(artifactKeysOf({ cached: false, sourceSha256: 'a'.repeat(64), ...built })).toEqual(
      built.keys,
    );
  });

  it('索引へ書く内容は非ヒットのときだけ作られる', async () => {
    // ヒット時に書き直すと `created_at` だけが若返る（`buildCacheRecordOf` の注記）。
    const built = await readBuildResult(await buildResponseBody());
    const record = buildCacheRecordOf({ cached: false, sourceSha256: 'a'.repeat(64), ...built });
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      sourceSha256: 'a'.repeat(64),
      goVersion: 'go1.26.5',
      sourceKey: built.keys.sourceKey,
      wasmKey: built.keys.wasmKey,
      contentEncoding: 'br',
    });

    const entry = {
      sourceSha256: 'e'.repeat(64),
      goVersion: 'go1.26.5',
      sourceKey: 'builds/cached/source.go',
      wasmKey: 'builds/cached/go1.26.5/game.wasm.br',
      wasmBytes: 1,
      wasmSha256: 'f'.repeat(64),
      compressedBytes: 2,
      compressedSha256: '0'.repeat(64),
      contentEncoding: 'br',
      createdAt: 1,
    };
    expect(
      buildCacheRecordOf({
        cached: true,
        sourceSha256: entry.sourceSha256,
        goVersion: entry.goVersion,
        artifact: {
          wasm: { bytes: 1, sha256: entry.wasmSha256 },
          compressed: { bytes: 2, sha256: entry.compressedSha256, contentEncoding: 'br' },
        },
        entry,
      }),
    ).toBeNull();
  });
});

describe('失敗の区別（#20 / 3.8 の degrade 判定）', () => {
  it('コンパイル失敗は kind=build で、診断を持つ', async () => {
    const seam = capturingFetch(() =>
      okResponse({
        ok: false,
        stage: 'build',
        message: './main.go:7:2: undefined: ebiten.RunGam',
        timings: { totalMs: 4_000 },
      }),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildRejected);
    const rejected = error as BuildRejected;
    expect(rejected.kind).toBe('build');
    expect(rejected.stage).toBe('build');
    expect(rejected.diagnostics).toContain('undefined: ebiten.RunGam');
    // **診断を message に載せない。** 8.3 の検査を通っていない文字列がログへ出る。
    expect(rejected.message).not.toContain('undefined');
  });

  it('ok:false でも stage が無ければ kind=build にしない（診断の無い再生成を起こさない）', async () => {
    // **`'unknown'` で埋めていた経路の回帰**（レビュー指摘 / #19）。埋めると、契約を
    // 満たしていない応答が `kind='build'` として #20 へ渡り、**手がかりの無いまま
    // 生成と課金をもう一度起こす**（3.3-4 の費用計上はビルドより前にある）。
    const seam = capturingFetch(() =>
      okResponse({ ok: false, message: './main.go:7:2: undefined: ebiten.RunGam' }),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildResponseUnreadable);
    expect((error as BuildResponseUnreadable).field).toBe('stage');
    // #20 が拾わない側であること。ここが 'build' に戻ると上の害が復活する。
    expect((error as BuildResponseUnreadable).kind).toBe('function');
    expect(error).not.toBeInstanceOf(BuildRejected);
  });

  it('ok:false で stage があれば、診断が空でも kind=build のまま', async () => {
    // **空の診断は契約違反ではない。** stage と違い、関数が診断を持たずに落ちる段が
    // ある。ここまで「読めない」にすると、本物のビルド失敗が function 扱いになり
    // 3.8 の degrade が誤爆する。
    const seam = capturingFetch(() => okResponse({ ok: false, stage: 'compress' }));

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildRejected);
    expect((error as BuildRejected).stage).toBe('compress');
    expect((error as BuildRejected).diagnostics).toBe('');
  });

  it('プラットフォームの時間切れは kind=timeout になる', async () => {
    const seam = capturingFetch(() =>
      okResponse(
        {
          errorMessage: '2026-08-28T00:00:00Z Task timed out after 30.00 seconds',
          errorType: 'Sandbox.Timedout',
        },
        { 'x-amz-function-error': 'Unhandled' },
      ),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildTimedOut);
    expect((error as BuildTimedOut).where).toBe('function');
    expect((error as BuildTimedOut).requestId).toBe('req-1');
  });

  it('関数が自分の deadline で打ち切った場合も kind=timeout になる', async () => {
    // 通常はこちらの経路になる（main.go の deadlineMargin が 500 ms 手前で切る）。
    const seam = capturingFetch(() =>
      okResponse(
        {
          errorMessage:
            'ビルドが時間内に終わりませんでした（29500 ms 経過。この呼び出しの内部期限は ' +
            '44500 ms（Lambda の残り時間から 500ms 手前。宣言の正本は ' +
            'terraform/build-function.tf の build_function_timeout_seconds））: context deadline exceeded',
          errorType: 'BuildFunctionError',
        },
        { 'x-amz-function-error': 'Unhandled' },
      ),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildTimedOut);
    expect((error as BuildTimedOut).kind).toBe('timeout');
  });

  it('それ以外の関数のエラーは kind=function になる', async () => {
    const seam = capturingFetch(() =>
      okResponse(
        { errorMessage: 'テンプレートを複製できません', errorType: 'BuildFunctionError' },
        { 'x-amz-function-error': 'Unhandled' },
      ),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildFunctionFailed);
    const failed = error as BuildFunctionFailed;
    expect(failed.kind).toBe('function');
    expect(failed.functionErrorType).toBe('BuildFunctionError');
    expect(failed.requestId).toBe('req-1');
    // **本文を持たない**（brotli の標準エラーなど外から来た文字列が混ざりうる）。
    expect(failed.message).not.toContain('テンプレート');
  });

  it('スロットリングは呼び出しの失敗として返る（3.8 の停止事象）', async () => {
    const seam = capturingFetch(
      () =>
        new Response('{"__type":"TooManyRequestsException"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-amzn-errortype': 'TooManyRequestsException:https://example.invalid/doc',
            'x-amzn-requestid': 'req-429',
          },
        }),
    );

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildFunctionFailed);
    expect((error as BuildFunctionFailed).status).toBe(429);
    expect((error as BuildFunctionFailed).awsErrorType).toBe('TooManyRequestsException');
  });

  it('送信そのものの失敗も kind=function になる', async () => {
    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: () => Promise.reject(new TypeError('network')),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildFunctionFailed);
    expect((error as BuildFunctionFailed).status).toBe(0);
    expect((error as BuildFunctionFailed).awsErrorType).toBe('TypeError');
  });

  it('Workers 側の上限を過ぎたら打ち切って kind=timeout を返す', async () => {
    // 応答が返らない状態（AWS 側の異常）。**関数のタイムアウトより長く待つので、
    // ここへ来るのは関数側から理由が返らなかったときだけである。**
    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      timeoutMs: 5,
      fetch: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildTimedOut);
    expect((error as BuildTimedOut).where).toBe('worker');
  });
});

/**
 * 応答を呼び出しごとに切り替える `fetch`。
 *
 * **呼び直しの検査に要る。** {@link capturingFetch} は毎回同じ応答を返すので、
 * 「1 回目は時間切れ、2 回目は成功」を作れない。
 *
 * @param responses 呼び出しの順に返す応答（尽きたら最後のものを返し続ける）
 * @returns 送られたリクエストと `fetch`
 */
function sequencedFetch(responses: readonly (() => Response)[]): {
  sent: Request[];
  fetch: (request: Request) => Promise<Response>;
} {
  const sent: Request[] = [];
  return {
    sent,
    fetch: async (request: Request) => {
      sent.push(request);
      const next = responses[Math.min(sent.length, responses.length) - 1];
      // 応答を 1 つも渡さない使い方はテスト側の誤りである。**黙って成功にしない。**
      if (next === undefined) {
        throw new Error('sequencedFetch に応答が渡されていません');
      }
      return next();
    },
  };
}

/** 関数側の時間切れ（`main.go` の内部期限）を模した応答。 */
function functionTimeoutResponse(): Response {
  return okResponse(
    {
      errorMessage: 'ビルドが時間内に終わりませんでした: context deadline exceeded',
      errorType: 'BuildFunctionError',
    },
    { 'x-amz-function-error': 'Unhandled' },
  );
}

describe('関数側の時間切れは同じソースで呼び直す（#164）', () => {
  it('2 回目が通れば成功として返る', async () => {
    const success = await buildResponseBody();
    const seam = sequencedFetch([functionTimeoutResponse, () => okResponse(success)]);

    const result = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    });

    expect(result.goVersion).toBe('go1.26.5');
    // **2 回呼んでいる。** 1 回で返っていたら呼び直しが効いていない。
    expect(seam.sent).toHaveLength(2);
  });

  it('同じソースを投げ直す（別のものを組み立て直さない）', async () => {
    const success = await buildResponseBody();
    const seam = sequencedFetch([functionTimeoutResponse, () => okResponse(success)]);

    await invokeBuildFunction(buildEnv(), 'package main // 目印', { fetch: seam.fetch });

    const bodies = await Promise.all(seam.sent.map(async (request) => await request.text()));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({ source: 'package main // 目印' });
  });

  it('呼び直しても時間切れなら BuildTimedOut を返し、そこで止める', async () => {
    const seam = sequencedFetch([functionTimeoutResponse]);

    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      fetch: seam.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildTimedOut);
    expect((error as BuildTimedOut).where).toBe('function');
    // **上限は宣言した値である。** ここを回数で書くと、定数を変えたときに
    // 検査だけが古い上限で緑になる（shared-ai-rules 12 章）。
    expect(seam.sent).toHaveLength(MAX_BUILD_INVOCATIONS_ON_TIMEOUT);
  });

  it('呼び直しの上限は 2（初回＋1 回）である', () => {
    // **3 回目は上限に当たる。** オーケストレータの 600 秒は
    // 「3 試行 ×（生成 91 秒 ＋ ビルド最大 45 秒 ×2）」で組んである。
    expect(MAX_BUILD_INVOCATIONS_ON_TIMEOUT).toBe(2);
  });

  it('呼び出し側の打ち切り（where=worker）は呼び直さない', async () => {
    // 関数がまだ走っている可能性がある。投げ直すと同じビルドを 2 本並走させる。
    let calls = 0;
    const error = await invokeBuildFunction(buildEnv(), 'package main', {
      timeoutMs: 5,
      fetch: (request) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BuildTimedOut);
    expect((error as BuildTimedOut).where).toBe('worker');
    expect(calls).toBe(1);
  });

  it('コンパイル失敗は呼び直さない（#20 が診断付きで受け取る）', async () => {
    const seam = capturingFetch(() =>
      okResponse({ ok: false, stage: 'build', message: 'main.go:3:2: undefined: x' }),
    );

    await expect(
      invokeBuildFunction(buildEnv(), 'package main', { fetch: seam.fetch }),
    ).rejects.toBeInstanceOf(BuildRejected);
    expect(seam.sent).toHaveLength(1);
  });

  it('スロットリング（429）は呼び直さない（滞留を増やすだけである）', async () => {
    const seam = capturingFetch(
      () =>
        new Response('{"__type":"TooManyRequestsException"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-amzn-errortype': 'TooManyRequestsException',
            'x-amzn-requestid': 'req-429',
          },
        }),
    );

    await expect(
      invokeBuildFunction(buildEnv(), 'package main', { fetch: seam.fetch }),
    ).rejects.toBeInstanceOf(BuildFunctionFailed);
    expect(seam.sent).toHaveLength(1);
  });
});

describe('ビルド結果キャッシュ（3.8）', () => {
  it('1 回目は関数を呼び、2 回目は呼ばない', async () => {
    const source = `package main // ${crypto.randomUUID()}`;
    let calls = 0;
    const build = createLambdaBuild({
      fetch: async () => {
        calls += 1;
        return okResponse(await buildResponseBody());
      },
    });

    const first = await build(buildEnv(), generated(source));
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(first.sourceSha256).toBe(await sourceCacheKey(source));

    // **索引を書くのは #21 である**（成果物が R2 へ入ったあと）。ここでは同じことを
    // テストが代行して、2 回目がヒットすることを確かめる。
    const sourceKey = `sources/${first.sourceSha256}.go`;
    const wasmKey = `wasm/${first.sourceSha256}.wasm.br`;
    await env.BUCKET.put(sourceKey, source);
    await env.BUCKET.put(wasmKey, 'compressed');
    await recordBuildCache(buildEnv(), {
      sourceSha256: first.sourceSha256,
      goVersion: first.goVersion,
      sourceKey,
      wasmKey,
      wasmBytes: first.artifact.wasm.bytes,
      wasmSha256: first.artifact.wasm.sha256,
      compressedBytes: first.artifact.compressed.bytes,
      compressedSha256: first.artifact.compressed.sha256,
      contentEncoding: first.artifact.compressed.contentEncoding,
    });

    const second = await build(buildEnv(), generated(source));
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.goVersion).toBe('go1.26.5');
    if (!second.cached) return;
    expect(second.entry.wasmKey).toBe(wasmKey);
  });

  it('索引が指す成果物が消えていれば呼び直す（3.7 のライフサイクル）', async () => {
    const source = `package main // ${crypto.randomUUID()}`;
    const sourceSha256 = await sourceCacheKey(source);
    await recordBuildCache(buildEnv(), {
      sourceSha256,
      goVersion: 'go1.26.5',
      sourceKey: `sources/${sourceSha256}.go`,
      wasmKey: `wasm/${sourceSha256}.wasm.br`,
      wasmBytes: 1,
      wasmSha256: 'a'.repeat(64),
      compressedBytes: 1,
      compressedSha256: 'b'.repeat(64),
      contentEncoding: 'br',
    });

    let calls = 0;
    const build = createLambdaBuild({
      fetch: async () => {
        calls += 1;
        return okResponse(await buildResponseBody());
      },
    });

    const outcome = await build(buildEnv(), generated(source));
    expect(calls).toBe(1);
    expect(outcome.cached).toBe(false);
  });
});
