/**
 * Amazon Bedrock の `Converse` を SigV4 で叩く生成クライアント（確定19 / 4.1 / #83）。
 *
 * **接続経路は `bedrock-runtime` の `Converse` 1 本である**（4.1）。v1.1 までは
 * 「Claude は Mantle（`@anthropic-ai/bedrock-sdk`）、それ以外は `Converse`」の 2 経路
 * としていたが、**Claude も `Converse` で動き、`usage` 4 種もキャッシュも揃って返る**
 * ことを workerd 上で実測したため 1 本へ統一された。結果として依存は `aws4fetch` だけで
 * 足り、`nodejs_compat` も 106 個の依存も要らない（`@anthropic-ai/bedrock-sdk` は
 * `assert` / `stream` を要求し、`nodejs_compat` 無しではビルドが落ちていた）。
 *
 * **署名は `aws4fetch` で行う。** Workers は AWS の外で動くため IAM ロールを引き受ける
 * 経路が無く、長命のアクセスキーを Pages のシークレットへ置いて SigV4 で署名する
 * （4.1 / `docs/bedrock-access.md`）。AWS SDK v3 は Workers ランタイムで読めない
 * （`@aws-sdk/util-utf8-browser` の export map。4.1 の実測）。
 *
 * **このモジュールはモデルを選ばない。** どのモデルで生成するかは
 * `src/generation-models.ts` の `selectGenerationModel` が決める。ここが持つのは
 * **トランスポート**（接続・署名・リージョン・Bedrock 固有の差分の吸収）だけである。
 *
 * **システムプロンプトの本文も持たない**（#16）。本文と `cachePoint` の配置は
 * `SystemPromptResolver` として外から受け取る。
 *
 * **リトライしない。** `aws4fetch` の `AwsClient.fetch` は再試行を持つが、ここでは
 * `sign` だけを使って送信は自分で行う。**生成の再送はそのまま課金の再発生**であり、
 * 4.3 が「リトライ分も必ず計上する」と定める以上、台帳の外側で黙って再送する経路を
 * 作らない。再試行の判断は #20 が持つ。
 */
import { AwsClient } from 'aws4fetch';
import type {
  GenerationModel,
  GenerationResult,
  GenerationUsage,
  SystemBlock,
  SystemPromptResolver,
} from './generation-models.js';
import { selectGenerationModel, supportsPromptCaching } from './generation-models.js';
import type { GenerateRequest } from './generate.js';

/**
 * SigV4 の署名対象サービス名。
 *
 * **ホスト名は `bedrock-runtime` だが、署名名は `bedrock` である。** 揃っていないので
 * ホスト名から導出しない。
 */
const SIGNING_SERVICE = 'bedrock';

/**
 * Bedrock を呼ぶために必須の秘密（`.dev.vars` / `wrangler pages secret`）。
 *
 * **不足を報告するときは名前だけを出す**（値は決して出さない）。`src/auth/google.ts` の
 * `REQUIRED_SECRETS` と同じ方針。
 *
 * `BEDROCK_AWS_SESSION_TOKEN` は**必須に入れない。** ローカルで SSO の一時資格情報を
 * 使うときだけ要り、本番の長命キーでは存在しない（`docs/bedrock-access.md` 3 章）。
 */
export const BEDROCK_SECRET_NAMES = [
  'BEDROCK_AWS_REGION',
  'BEDROCK_AWS_ACCESS_KEY_ID',
  'BEDROCK_AWS_SECRET_ACCESS_KEY',
] as const;

/** 署名に使う資格情報。 */
interface BedrockCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** SSO の一時資格情報を使うときだけ入る。 */
  readonly sessionToken: string | undefined;
}

/** 資格情報が揃っていない。**名前だけ**を持つ。 */
export class BedrockNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Bedrock の資格情報が設定されていません: ${missing.join(', ')}`);
    this.name = 'BedrockNotConfigured';
  }
}

/**
 * Bedrock が 2xx 以外を返した。
 *
 * **本文を持たない。** AWS の `ValidationException` は入力を引用しうるため、
 * プロンプトがそのまま例外の `message` に乗り、`src/generate.ts` が禁じている
 * 「プロンプトのログ流出」を作る経路になる（8.2 のモデレーション対象の入力を、
 * 保管場所も寿命も違うログへ流さない）。**残すのは状態コードと AWS のエラー種別だけ**で、
 * これだけで「資格情報か・モデルアクセスか・入力の妥当性か」は切り分けられる。
 */
export class BedrockCallFailed extends Error {
  constructor(
    readonly status: number,
    readonly awsErrorType: string | null,
  ) {
    super(`Bedrock の呼び出しに失敗しました: HTTP ${status}（${awsErrorType ?? '種別不明'}）`);
    this.name = 'BedrockCallFailed';
  }
}

/**
 * 応答の形が想定と違う。
 *
 * **どの項目が読めなかったかだけ**を持つ。応答本文には生成された Go ソースが入るので、
 * 例外へ入れると 8.3 の検査を通っていない文字列がログへ出る。
 */
export class BedrockResponseUnreadable extends Error {
  constructor(readonly field: string) {
    super(`Bedrock の応答を読めませんでした: ${field}`);
    this.name = 'BedrockResponseUnreadable';
  }
}

/**
 * 不足している秘密の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingBedrockSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  return BEDROCK_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * env から資格情報を取り出す。
 *
 * @param env バインディングと環境変数
 * @returns 資格情報
 * @throws {BedrockNotConfigured} 必須の値が欠けているとき
 */
function readBedrockCredentials(env: Env): BedrockCredentials {
  const missing = missingBedrockSecrets(env);
  if (missing.length > 0) {
    throw new BedrockNotConfigured(missing);
  }
  const values = env as unknown as Record<string, string | undefined>;
  const sessionToken = values['BEDROCK_AWS_SESSION_TOKEN'];
  return {
    region: values['BEDROCK_AWS_REGION']!.trim(),
    accessKeyId: values['BEDROCK_AWS_ACCESS_KEY_ID']!.trim(),
    secretAccessKey: values['BEDROCK_AWS_SECRET_ACCESS_KEY']!.trim(),
    // 空文字を渡すと `aws4fetch` が `X-Amz-Security-Token: ` という空ヘッダを署名対象に
    // 含めてしまい、長命キーの署名が壊れる。**空は「無い」として扱う。**
    sessionToken:
      typeof sessionToken === 'string' && sessionToken.trim() !== '' ? sessionToken.trim() : undefined,
  };
}

/**
 * `Converse` のエンドポイントを組み立てる。
 *
 * **リージョンはホスト名に現れる。** Bedrock は `inference_geo` のようなパラメータを
 * 持たず、リージョン選択がその役割を担う（4.1）。
 *
 * モデル ID を `encodeURIComponent` に通すのは、推論プロファイル ID に `.` 以外の
 * 文字が入りうるため（`arn:` 形式のプロファイルを指す構成もある）。
 *
 * @param region リージョン
 * @param modelId モデル ID
 * @returns エンドポイントの URL
 */
export function converseEndpoint(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

/**
 * システムプロンプトのブロック列を `Converse` の `system` へ変換する。
 *
 * **Bedrock 固有の差分の吸収その 2。** 自動 prompt caching が無いため `cachePoint` を
 * 手で置くが（4.1 / 4.5）、**キャッシュの課金次元を持たないモデルでは落とす。**
 * DeepSeek にキャッシュは無く（4.1: API ではなくモデルの性質）、置いても意味が無い。
 * **落とす判断をここで持つことで、#16 はモデルごとの可否を知らずに配置だけを決められる。**
 *
 * 先頭の `cachePoint` も落とす。区切りはその前にある内容を指すもので、指す先が無い
 * `cachePoint` は `Converse` に拒否される。
 *
 * @param model 対象のモデル
 * @param blocks #16 が返したブロック列
 * @returns `Converse` の `system` に載せる配列
 */
export function toConverseSystem(
  model: GenerationModel,
  blocks: readonly SystemBlock[],
): readonly Record<string, unknown>[] {
  const cacheable = supportsPromptCaching(model);
  const converted: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if ('cachePoint' in block) {
      if (cacheable && converted.length > 0) {
        converted.push({ cachePoint: { type: 'default' } });
      }
      continue;
    }
    converted.push({ text: block.text });
  }
  return converted;
}

/**
 * 元にするソースを `messages` の先頭へ置くときの前置き。
 *
 * **「これを直せ」と明示する。** 裸のソースを先頭へ置くと、モデルはそれを出力例とも
 * 参考資料とも読める。5.3 / 5.7 が要求しているのは**そのソースを編集した全文**である。
 */
const BASE_SOURCE_PREFACE =
  '次の Go のソースは、あなたが直す対象そのものです。これを編集し、全文を出力してください。';

/**
 * 元にするソースを載せた `content` ブロック列を作る（4.5 / 5.3 / 5.7）。
 *
 * **区切りはソースの直後に 1 つだけ置く。** 4.5 が「親ソース（フォーク）用の 2 つ目の
 * 区切りは `messages` の先頭に置く」と定めているのがこれで、**同じ作品を続けて推敲する
 * あいだ、前置きとソースが共有プレフィックスになる。** 差分プロンプトはそのうしろに
 * 置くので、毎回変わってもキャッシュを割らない。
 *
 * **キャッシュ次元を持たないモデルでは区切りを落とす**（{@link toConverseSystem} と
 * 同じ理由。DeepSeek にキャッシュは無い）。
 *
 * @param model 使うモデル
 * @param baseSource 元にするソース
 * @param prompt 差分プロンプト
 * @returns `messages[0].content` に載せる配列
 */
function baseSourceContent(
  model: GenerationModel,
  baseSource: string,
  prompt: string,
): readonly Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [
    { text: `${BASE_SOURCE_PREFACE}\n\n\`\`\`go\n${baseSource}\n\`\`\`` },
  ];
  if (supportsPromptCaching(model)) {
    content.push({ cachePoint: { type: 'default' } });
  }
  content.push({ text: prompt });
  return content;
}

/**
 * `Converse` のリクエスト本文を組み立てる。
 *
 * @param model 使うモデル
 * @param system システムプロンプトのブロック列
 * @param prompt 利用者の自然文プロンプト
 * @param baseSource 元にするソース（推敲・フォーク。無ければ新規生成）
 * @returns JSON にする直前のオブジェクト
 */
export function buildConverseRequest(
  model: GenerationModel,
  system: readonly SystemBlock[],
  prompt: string,
  baseSource?: string,
): Record<string, unknown> {
  const content =
    baseSource === undefined || baseSource === ''
      ? [{ text: prompt }]
      : baseSourceContent(model, baseSource, prompt);

  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens: model.maxTokens },
  };

  const converted = toConverseSystem(model, system);
  if (converted.length > 0) {
    body['system'] = converted;
  }

  if (model.effort !== null) {
    // **`effort` はモデル固有の項目**であり、`Converse` の共通の
    // `inferenceConfig` には無い。`additionalModelRequestFields` はモデル本来の
    // API の項目をそのまま通す口である。
    //
    // **この綴りは実呼び出しで確かめた**（2026-08-31 / #25。
    // `scripts/verify-effort-spelling.sh`）。**存在しない項目名を送る対照が
    // `ValidationException` で断られたうえで**、`high` / `medium` の両方が受理された
    // ——API は項目名を検証しており、この綴りはその検証を通っている。
    //
    // **受理されることと、生成が変わることは別である。** `effort` が実際に thinking を
    // 増やすかは A/B（#25）が測る。検証に使ったのは "ping" 1 語で、両群とも出力
    // 18 トークンだった（差が出ない題材である）。
    body['additionalModelRequestFields'] = { output_config: { effort: model.effort } };
  }

  return body;
}

/**
 * 応答から `usage` 4 種を読む。
 *
 * **欠けた項目は `null` にする**（`0` にしない）。DeepSeek はキャッシュの 2 項目を
 * 返さず、これは API ではなくモデルの性質である（4.1）。`0` で埋めると、費用台帳
 * （#22）が「キャッシュを使ったが 0 だった」と区別できず、4.5 の
 * 「`cacheReadInputTokens` がゼロのまま推移していないか」という異常検知も死ぬ。
 *
 * 入出力の 2 項目が読めない場合は**例外にする。** 費用の計算に必ず要る値で、
 * 0 として通すと台帳が過少計上になり、4.3 の上限が上振れする。
 *
 * @param payload `Converse` の応答（JSON を解析したもの）
 * @returns 正規化した usage
 * @throws {BedrockResponseUnreadable} 入出力トークンが読めないとき
 */
export function readConverseUsage(payload: unknown): GenerationUsage {
  const usage = pick(payload, 'usage');
  const inputTokens = numberOrNull(pick(usage, 'inputTokens'));
  const outputTokens = numberOrNull(pick(usage, 'outputTokens'));
  if (inputTokens === null || outputTokens === null) {
    throw new BedrockResponseUnreadable('usage.inputTokens / usage.outputTokens');
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: numberOrNull(pick(usage, 'cacheReadInputTokens')),
    cacheWriteInputTokens: numberOrNull(pick(usage, 'cacheWriteInputTokens')),
  };
}

/**
 * 応答から生成された本文を取り出す。
 *
 * `content` は複数ブロックになりうる（thinking を返す構成では `reasoningContent` が
 * 混ざる）。**`text` を持つブロックだけを順に連結する。** 取り出した文字列を Go の
 * ソースとして扱うのは後段（5.2-5 の検査、3.3-5 のビルド）で、ここでは整形しない。
 *
 * @param payload `Converse` の応答
 * @returns 連結した本文
 * @throws {BedrockResponseUnreadable} 本文が 1 つも無いとき
 */
export function readConverseText(payload: unknown): string {
  const content = pick(pick(pick(payload, 'output'), 'message'), 'content');
  if (!Array.isArray(content)) {
    throw new BedrockResponseUnreadable('output.message.content');
  }
  const texts = content
    .map((block) => pick(block, 'text'))
    .filter((text): text is string => typeof text === 'string');
  if (texts.length === 0) {
    throw new BedrockResponseUnreadable('output.message.content[].text');
  }
  return texts.join('');
}

/**
 * オブジェクトから項目を取り出す（`null` / 配列 / 非オブジェクトは `undefined`）。
 *
 * @param value 対象
 * @param key 項目名
 * @returns 値
 */
function pick(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * 有限の数値ならそのまま、それ以外は `null`。
 *
 * @param value 対象
 * @returns 数値または null
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 失敗応答から AWS のエラー種別だけを取り出す。
 *
 * **本文（`message`）は読み捨てる。** 入力を引用しうるため（`BedrockCallFailed` の
 * 説明）。種別は `x-amzn-errortype` ヘッダか、本文の `__type` に入る。
 *
 * @param response 失敗した応答
 * @returns エラー種別（読めなければ null）
 */
async function readAwsErrorType(response: Response): Promise<string | null> {
  const header = response.headers.get('x-amzn-errortype');
  if (header !== null && header !== '') {
    // `Type:https://...` の形で返ることがあるので、種別名だけにする。
    return header.split(':')[0]!.split('#').pop() ?? null;
  }
  try {
    const type = pick(await response.json(), '__type');
    return typeof type === 'string' ? (type.split('#').pop() ?? null) : null;
  } catch {
    return null;
  }
}

/** 生成クライアントが外から受け取るもの。 */
export interface BedrockDependencies {
  /** システムプロンプトの解決（本文と `cachePoint` の配置は #16 が持つ）。 */
  readonly systemPrompt: SystemPromptResolver;
  /**
   * 送信に使う `fetch`。
   *
   * **テストから差し替えるための継ぎ目（seam）。** 既定にすると単体テストが Bedrock への
   * 実 HTTP を要求し、**課金が受け入れ条件に混ざる。** `src/auth/google.ts` の
   * `TokenExchange` と同じ方針。
   */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * 3.3-3（生成）の段を作る。
 *
 * @param deps 外部依存
 * @returns `GenerationPipeline['generateSource']` に嵌まる関数
 */
export function createBedrockGenerateSource(
  deps: BedrockDependencies,
): (env: Env, request: GenerateRequest) => Promise<GenerationResult> {
  const send = deps.fetch ?? ((request: Request) => fetch(request));

  return async (env: Env, request: GenerateRequest): Promise<GenerationResult> => {
    // **宣言だけで決まるものを、資格情報より先に解決する。** どちらも「鍵が無い」と
    // 誤診させないためである。
    //
    //   - モデルの決定（`GENERATION_MODEL` の綴り）
    //   - システムプロンプトの解決（#16 が未実装なら `PipelineStepNotImplemented`）
    //
    // **とくに 2 つ目は既定の経路で必ず踏む。** `notImplementedSystemPrompt` を使う
    // 呼び出し側が Bedrock の鍵を持たないと、本来出したい「#16 が未実装」ではなく
    // `BedrockNotConfigured` が先に飛び、**まだ書いていない段を、設定の不備として
    // 診断させてしまう。** 解決した結果は下の本文の組み立てで使い回す。
    const model = selectGenerationModel(env);
    const system = deps.systemPrompt(model);
    const credentials = readBedrockCredentials(env);

    const aws = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: SIGNING_SERVICE,
      region: credentials.region,
    });

    const body = JSON.stringify(
      buildConverseRequest(model, system, request.prompt, request.baseSource),
    );
    const signed = await aws.sign(converseEndpoint(credentials.region, model.modelId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });

    const response = await send(signed);
    if (!response.ok) {
      throw new BedrockCallFailed(response.status, await readAwsErrorType(response));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BedrockResponseUnreadable('本文が JSON ではありません');
    }

    const stopReason = pick(payload, 'stopReason');
    return {
      modelKey: model.key,
      modelId: model.modelId,
      source: readConverseText(payload),
      usage: readConverseUsage(payload),
      // 読めなくても例外にしない。**費用は既に発生している**ので、ここで落として
      // 3.3-4（費用計上）へ進めなくするほうが害が大きい。
      stopReason: typeof stopReason === 'string' ? stopReason : 'unknown',
    };
  };
}
