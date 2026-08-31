import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  BEDROCK_SECRET_NAMES,
  BedrockCallFailed,
  BedrockNotConfigured,
  BedrockResponseUnreadable,
  buildConverseRequest,
  converseEndpoint,
  createBedrockGenerateSource,
  missingBedrockSecrets,
  readConverseText,
  readConverseUsage,
  toConverseSystem,
} from '../src/bedrock.js';
import type { GenerationModel, SystemBlock } from '../src/generation-models.js';
import { EFFORT_AB_ARMS, findGenerationModel } from '../src/generation-models.js';

const SONNET = findGenerationModel('sonnet-4-6')!;
const DEEPSEEK = findGenerationModel('deepseek-v3-2')!;

/**
 * テスト用の資格情報。
 *
 * **実在の鍵を使わない。** `.dev.vars` を置いた開発者の env には dev アカウントの
 * 資格情報が入っているが、テストがそれに依存すると、置いていない環境で落ちるうえ、
 * 署名の検査に本物を使う理由が無い。
 *
 * @param overrides 差し替える値（`null` を渡すとそのキーを消す）
 * @returns 差し替えた env
 */
function bedrockEnv(overrides: Record<string, string | null> = {}): Env {
  const copy = { ...env } as unknown as Record<string, unknown>;
  const base: Record<string, string> = {
    BEDROCK_AWS_REGION: 'ap-northeast-1',
    BEDROCK_AWS_ACCESS_KEY_ID: 'test-access-key-id',
    BEDROCK_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    BEDROCK_AWS_SESSION_TOKEN: '',
    GENERATION_MODEL: 'sonnet-4-6',
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

/** `Converse` の成功応答（Claude が返す形。4.1 の実測に合わせて camelCase）。 */
function converseResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output: { message: { role: 'assistant', content: [{ text: 'package main\n' }] } },
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1_092,
      outputTokens: 4_171,
      cacheReadInputTokens: 4_841,
      cacheWriteInputTokens: 0,
      totalTokens: 5_263,
    },
    ...overrides,
  };
}

/** 送られたリクエストを捕まえる `fetch`。**実 HTTP を出さない**（出せば課金される）。 */
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

/** #16 が入るまでの代わりのシステムプロンプト。**本文は #83 の範囲外**。 */
const stubSystemPrompt = (): readonly SystemBlock[] => [
  { text: 'あなたは Ebitengine のゲームを書く。' },
  { cachePoint: true },
];

describe('エンドポイント', () => {
  it('リージョンがホスト名に現れる', () => {
    // Bedrock は `inference_geo` を持たず、リージョン選択がその役割を担う（4.1）。
    expect(converseEndpoint('ap-northeast-1', 'deepseek.v3.2')).toBe(
      'https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/deepseek.v3.2/converse',
    );
  });

  it('モデル ID を URL 用に符号化する', () => {
    expect(converseEndpoint('us-east-1', 'arn:aws:bedrock:us-east-1:1/x')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A1%2Fx/converse',
    );
  });
});

describe('cachePoint の扱い（4.1 / 4.5）', () => {
  it('キャッシュを持つモデルには cachePoint を置く', () => {
    expect(toConverseSystem(SONNET, stubSystemPrompt())).toEqual([
      { text: 'あなたは Ebitengine のゲームを書く。' },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('キャッシュの課金次元を持たないモデルでは落とす', () => {
    // DeepSeek にキャッシュは無い（4.1。API ではなくモデルの性質）。#16 は配置だけを
    // 決め、モデルごとの可否はトランスポート側が吸収する。
    expect(toConverseSystem(DEEPSEEK, stubSystemPrompt())).toEqual([
      { text: 'あなたは Ebitengine のゲームを書く。' },
    ]);
  });

  it('指す先の無い先頭の cachePoint を落とす', () => {
    expect(toConverseSystem(SONNET, [{ cachePoint: true }, { text: 'a' }])).toEqual([{ text: 'a' }]);
  });

  it('複数のブレークポイントを順に保つ', () => {
    expect(
      toConverseSystem(SONNET, [{ text: 'a' }, { cachePoint: true }, { text: 'b' }, { cachePoint: true }]),
    ).toEqual([
      { text: 'a' },
      { cachePoint: { type: 'default' } },
      { text: 'b' },
      { cachePoint: { type: 'default' } },
    ]);
  });
});

describe('リクエストの組み立て', () => {
  it('プロンプトと出力上限を載せる', () => {
    const body = buildConverseRequest(SONNET, stubSystemPrompt(), 'シューティング');
    expect(body['messages']).toEqual([{ role: 'user', content: [{ text: 'シューティング' }] }]);
    expect(body['inferenceConfig']).toEqual({ maxTokens: SONNET.maxTokens });
  });

  it('effort が未指定なら追加項目を送らない', () => {
    // 未検証の項目を既定で送ると、初回の実呼び出しが ValidationException で落ちて
    // 原因の切り分けが増える（登録簿の既定は null）。
    expect(buildConverseRequest(SONNET, stubSystemPrompt(), 'x')).not.toHaveProperty(
      'additionalModelRequestFields',
    );
  });

  it('effort を設定すればモデル固有の項目として送る', () => {
    // #25（high と medium の A/B）の入り口。`effort` は Converse の共通項目ではない。
    const tuned: GenerationModel = { ...SONNET, effort: 'medium' };
    expect(buildConverseRequest(tuned, stubSystemPrompt(), 'x')['additionalModelRequestFields']).toEqual(
      { output_config: { effort: 'medium' } },
    );
  });

  it('システムプロンプトが空なら system を送らない', () => {
    expect(buildConverseRequest(SONNET, [], 'x')).not.toHaveProperty('system');
  });

  it('A/B の 2 群は、登録簿の要素として選ぶだけで effort が送られる（#25）', () => {
    // 上のテストは `{ ...SONNET, effort: 'medium' }` という**その場で作った**モデルを
    // 使っており、「送る経路がある」ことしか見ていない。**登録簿の要素を引いただけで
    // 送られる**ことは別である——ここが繋がっていないと、`GENERATION_MODEL` を群の鍵に
    // しても既定（effort なし）のまま生成が走り、**両群が同じ生成になる。**
    for (const arm of EFFORT_AB_ARMS) {
      const model = findGenerationModel(`sonnet-4-6-${arm}`)!;
      const body = buildConverseRequest(model, stubSystemPrompt(), 'x');
      expect(body['additionalModelRequestFields'], arm).toEqual({
        output_config: { effort: arm },
      });
      // 送り先は素の sonnet-4-6 と同じでなければならない（比較が別モデルにならない）。
      expect(model.modelId, arm).toBe(SONNET.modelId);
      expect(body['inferenceConfig'], arm).toEqual({ maxTokens: SONNET.maxTokens });
    }
  });
});

describe('usage 4 種の取得（#83 acceptance 1）', () => {
  it('4 種すべてを読む', () => {
    expect(readConverseUsage(converseResponse())).toEqual({
      inputTokens: 1_092,
      outputTokens: 4_171,
      cacheReadInputTokens: 4_841,
      cacheWriteInputTokens: 0,
    });
  });

  it('欠けたキャッシュ項目は null にする（0 にしない）', () => {
    // DeepSeek はキャッシュの 2 項目を返さない。0 で埋めると、費用台帳（#22）が
    // 「キャッシュを使ったが 0 だった」と区別できず、4.5 の異常検知も死ぬ。
    const usage = readConverseUsage({ usage: { inputTokens: 911, outputTokens: 2_159 } });
    expect(usage.cacheReadInputTokens).toBeNull();
    expect(usage.cacheWriteInputTokens).toBeNull();
  });

  it('0 と「項目が無い」を取り違えない', () => {
    expect(readConverseUsage(converseResponse()).cacheWriteInputTokens).toBe(0);
  });

  it('入出力トークンが読めなければ例外にする', () => {
    // 費用の計算に必ず要る値。0 として通すと台帳が過少計上になり、4.3 の上限が上振れする。
    for (const usage of [{}, { inputTokens: 1 }, { outputTokens: 1 }, { inputTokens: 'many', outputTokens: 1 }]) {
      expect(() => readConverseUsage({ usage })).toThrow(BedrockResponseUnreadable);
    }
    expect(() => readConverseUsage({})).toThrow(BedrockResponseUnreadable);
  });
});

describe('本文の取り出し', () => {
  it('text ブロックを順に連結し、text 以外は飛ばす', () => {
    const payload = {
      output: {
        message: {
          content: [{ reasoningContent: { text: '考え中' } }, { text: 'package ' }, { text: 'main' }],
        },
      },
    };
    expect(readConverseText(payload)).toBe('package main');
  });

  it('本文が無ければ例外にする', () => {
    expect(() => readConverseText({})).toThrow(BedrockResponseUnreadable);
    expect(() => readConverseText({ output: { message: { content: [] } } })).toThrow(
      BedrockResponseUnreadable,
    );
  });
});

describe('資格情報', () => {
  it('欠けている名前を返す', () => {
    expect(missingBedrockSecrets(bedrockEnv({ BEDROCK_AWS_ACCESS_KEY_ID: null }))).toEqual([
      'BEDROCK_AWS_ACCESS_KEY_ID',
    ]);
    expect(missingBedrockSecrets(bedrockEnv({ BEDROCK_AWS_SECRET_ACCESS_KEY: '  ' }))).toEqual([
      'BEDROCK_AWS_SECRET_ACCESS_KEY',
    ]);
  });

  it('セッショントークンは必須ではない', () => {
    // 本番の長命キーでは登録しない（docs/bedrock-access.md 3 章）。
    expect(missingBedrockSecrets(bedrockEnv({ BEDROCK_AWS_SESSION_TOKEN: null }))).toEqual([]);
  });

  it('システムプロンプトの未実装が、資格情報の不足より先に出る', async () => {
    // **診断の順序を固定する。** `deps.systemPrompt` を本文の組み立て時に呼ぶと、
    // 鍵を持たない呼び出し側には BedrockNotConfigured が先に飛び、**まだ書いて
    // いない段（#16）を「設定の不備」として診断させてしまう。**
    //
    // 直しただけでは、次に順序を戻されても気づけない。ここで固定する（PR #98 の
    // Copilot code review の指摘）。
    const stub = capturingFetch(() => new Response('{}'));
    const notImplemented = new Error('systemPrompt:not-implemented');
    const generate = createBedrockGenerateSource({
      systemPrompt: () => {
        throw notImplemented;
      },
      fetch: stub.fetch,
    });

    // 鍵が 1 つも無い env。**それでも先に出るのはシステムプロンプト側**であること。
    await expect(
      generate(
        bedrockEnv({
          BEDROCK_AWS_REGION: null,
          BEDROCK_AWS_ACCESS_KEY_ID: null,
          BEDROCK_AWS_SECRET_ACCESS_KEY: null,
        }),
        { prompt: 'ゲーム' },
      ),
    ).rejects.toBe(notImplemented);
    expect(stub.sent).toHaveLength(0);
  });

  it('未設定なら呼び出す前に落とし、値を漏らさない', async () => {
    const stub = capturingFetch(() => new Response('{}'));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    const secret = 'this-value-must-not-appear';
    await expect(
      generate(bedrockEnv({ BEDROCK_AWS_REGION: null, BEDROCK_AWS_SECRET_ACCESS_KEY: secret }), {
        prompt: 'ゲーム',
      }),
    ).rejects.toBeInstanceOf(BedrockNotConfigured);
    // 名前だけを出す（src/auth/google.ts と同じ方針）。
    await generate(bedrockEnv({ BEDROCK_AWS_REGION: null }), { prompt: 'ゲーム' }).catch(
      (error: unknown) => {
        expect(String(error)).toContain('BEDROCK_AWS_REGION');
        expect(String(error)).not.toContain(secret);
      },
    );
    expect(stub.sent).toHaveLength(0);
  });
});

describe('環境変数契約（#83 acceptance 4）', () => {
  /**
   * `.dev.vars.example` に書かれているキー名を取り出す。
   *
   * `test/worker.test.ts` と同じ抽出（`KEY=` の行だけを拾う）。
   *
   * @returns キー名
   */
  function documentedNames(): string[] {
    return env.TEST_DEV_VARS_EXAMPLE.split('\n')
      .map((line) => /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line))
      .filter((matched): matched is RegExpExecArray => matched !== null)
      .map((matched) => matched[1]!);
  }

  it('コードが要求する秘密が雛形に書かれている', () => {
    // **雛形はコードの要求の複製である。** 片方だけ足すと、雛形どおりに環境を作った
    // 開発者の手元でだけ生成が落ち、原因が「鍵の書き忘れ」に見える
    // （shared-ai-rules 12 章）。
    for (const name of BEDROCK_SECRET_NAMES) {
      expect(documentedNames(), name).toContain(name);
    }
  });

  it('任意のセッショントークンも雛形に書かれている', () => {
    // 必須ではないが、SSO で開発するときに要る。雛形に無いと
    // test/worker.test.ts の「宣言外の値の混入」検査が正当な値で落ちる。
    expect(documentedNames()).toContain('BEDROCK_AWS_SESSION_TOKEN');
  });

  it('モデルの選択は秘密として置かない', () => {
    // 秘密ではなく構成である。`.dev.vars` へ置くと、本番でどのモデルを使っているかが
    // 宣言から読めなくなる（wrangler.toml の `[vars]` が正）。
    expect(documentedNames()).not.toContain('GENERATION_MODEL');
  });
});

describe('SigV4 で署名して呼ぶ（#83 acceptance 1 / M2-11）', () => {
  it('署名ヘッダが付き、選んだモデルの宛先へ送る', async () => {
    const stub = capturingFetch(() => Response.json(converseResponse()));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });

    const result = await generate(bedrockEnv(), { prompt: 'シューティング' });

    expect(stub.sent).toHaveLength(1);
    const sent = stub.sent[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(converseEndpoint('ap-northeast-1', SONNET.modelId));
    // 署名名は `bedrock`（ホスト名の `bedrock-runtime` ではない）。取り違えると
    // 署名が通らず、原因が資格情報の不備に見える。
    const authorization = sent.headers.get('authorization') ?? '';
    expect(authorization).toContain('AWS4-HMAC-SHA256');
    expect(authorization).toContain('/ap-northeast-1/bedrock/aws4_request');
    expect(sent.headers.get('x-amz-date')).not.toBeNull();
    // 本文の SHA-256 は正規リクエストへ入るが、`x-amz-content-sha256` ヘッダとしては
    // 送られない（`aws4fetch` は S3 のときだけ付ける）。Bedrock はこれで通る（4.1 の実測）。
    expect(await sent.json()).toHaveProperty('messages');

    expect(result.stopReason).toBe('end_turn');
    expect(result.source).toBe('package main\n');
  });

  it('一時資格情報を使うときだけセキュリティトークンを送る', async () => {
    // 空文字を渡したまま署名すると、空のヘッダが署名対象に混ざって長命キーの
    // 署名が壊れる。
    const stub = capturingFetch(() => Response.json(converseResponse()));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });

    await generate(bedrockEnv(), { prompt: 'x' });
    expect(stub.sent[0]!.headers.get('x-amz-security-token')).toBeNull();

    await generate(bedrockEnv({ BEDROCK_AWS_SESSION_TOKEN: 'temporary-token' }), { prompt: 'x' });
    expect(stub.sent[1]!.headers.get('x-amz-security-token')).toBe('temporary-token');
  });

  it('どのモデルで生成したかを結果に残す（#83 acceptance 3）', async () => {
    // #22 がモデル別単価で円換算し、モデルごとのコンパイル失敗率を分析する（4.2）。
    const stub = capturingFetch(() => Response.json(converseResponse()));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });

    const result = await generate(bedrockEnv(), { prompt: 'x' });
    expect(result.modelKey).toBe('sonnet-4-6');
    expect(result.modelId).toBe(SONNET.modelId);
  });

  it('モデルを切り替えると宛先も本文も結果も変わる（#83 acceptance 2）', async () => {
    const stub = capturingFetch(() =>
      Response.json(converseResponse({ usage: { inputTokens: 911, outputTokens: 2_159 } })),
    );
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });

    const result = await generate(bedrockEnv({ GENERATION_MODEL: 'deepseek-v3-2' }), { prompt: 'x' });

    expect(stub.sent[0]!.url).toBe(converseEndpoint('ap-northeast-1', DEEPSEEK.modelId));
    const body = (await stub.sent[0]!.json()) as Record<string, unknown>;
    // キャッシュを持たないモデルなので cachePoint は落ちている。
    expect(body['system']).toEqual([{ text: 'あなたは Ebitengine のゲームを書く。' }]);
    expect(body['inferenceConfig']).toEqual({ maxTokens: DEEPSEEK.maxTokens });
    expect(result.modelKey).toBe('deepseek-v3-2');
    expect(result.usage.cacheReadInputTokens).toBeNull();
  });

  it('システムプロンプトはモデルごとに解決される（確定5 / 6.1）', async () => {
    const seen: string[] = [];
    const stub = capturingFetch(() => Response.json(converseResponse()));
    const generate = createBedrockGenerateSource({
      systemPrompt: (model) => {
        seen.push(model.key);
        return [{ text: `prompt-for-${model.key}` }];
      },
      fetch: stub.fetch,
    });

    await generate(bedrockEnv(), { prompt: 'x' });
    await generate(bedrockEnv({ GENERATION_MODEL: 'deepseek-v3-2' }), { prompt: 'x' });

    expect(seen).toEqual(['sonnet-4-6', 'deepseek-v3-2']);
    expect(((await stub.sent[1]!.json()) as Record<string, unknown>)['system']).toEqual([
      { text: 'prompt-for-deepseek-v3-2' },
    ]);
  });

  it('リトライしない', async () => {
    // 生成の再送はそのまま課金の再発生である。再試行の判断は #20 が持つ。
    const stub = capturingFetch(() => new Response('{}', { status: 500 }));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    await expect(generate(bedrockEnv(), { prompt: 'x' })).rejects.toBeInstanceOf(BedrockCallFailed);
    expect(stub.sent).toHaveLength(1);
  });
});

describe('失敗の扱い', () => {
  it('状態コードと AWS のエラー種別を残す', async () => {
    const stub = capturingFetch(
      () =>
        new Response(JSON.stringify({ message: 'boom' }), {
          status: 403,
          headers: { 'x-amzn-errortype': 'AccessDeniedException:http://internal.amazon.com/x' },
        }),
    );
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    await generate(bedrockEnv(), { prompt: 'x' }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(BedrockCallFailed);
      expect((error as BedrockCallFailed).status).toBe(403);
      expect((error as BedrockCallFailed).awsErrorType).toBe('AccessDeniedException');
    });
  });

  it('ヘッダが無ければ本文の __type を読む', async () => {
    const stub = capturingFetch(
      () =>
        new Response(JSON.stringify({ __type: 'com.amazon.x#ValidationException', message: 'bad' }), {
          status: 400,
        }),
    );
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    await generate(bedrockEnv(), { prompt: 'x' }).catch((error: unknown) => {
      expect((error as BedrockCallFailed).awsErrorType).toBe('ValidationException');
    });
  });

  it('失敗の本文をメッセージへ入れない', async () => {
    // AWS の ValidationException は入力を引用しうる。プロンプトが例外の message へ
    // 乗ると、src/generate.ts が禁じているログ流出の経路になる（8.2）。
    const quoted = 'プロンプトの断片-must-not-leak';
    const stub = capturingFetch(
      () => new Response(JSON.stringify({ __type: 'ValidationException', message: quoted }), { status: 400 }),
    );
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    await generate(bedrockEnv(), { prompt: quoted }).catch((error: unknown) => {
      expect(String(error)).not.toContain(quoted);
      expect((error as Error).stack ?? '').not.toContain(quoted);
    });
  });

  it('JSON でない応答を例外にする', async () => {
    const stub = capturingFetch(() => new Response('<html>502</html>', { status: 200 }));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    await expect(generate(bedrockEnv(), { prompt: 'x' })).rejects.toBeInstanceOf(
      BedrockResponseUnreadable,
    );
  });

  it('stopReason が読めなくても結果を返す', async () => {
    // 費用は既に発生している。ここで落とすと 3.3-4（費用計上）へ進めなくなる。
    const stub = capturingFetch(() => Response.json(converseResponse({ stopReason: undefined })));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    expect((await generate(bedrockEnv(), { prompt: 'x' })).stopReason).toBe('unknown');
  });

  it('max_tokens で切れても例外にせず結果に残す', async () => {
    // 切れたソースはコンパイルできないが、判断は #20（リトライ）が持つ。
    const stub = capturingFetch(() => Response.json(converseResponse({ stopReason: 'max_tokens' })));
    const generate = createBedrockGenerateSource({ systemPrompt: stubSystemPrompt, fetch: stub.fetch });
    expect((await generate(bedrockEnv(), { prompt: 'x' })).stopReason).toBe('max_tokens');
  });
});
