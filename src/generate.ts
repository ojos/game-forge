/**
 * 生成リクエストの入口とオーケストレーションの骨組み（3.3 / 5.2 / #15）。
 *
 * このモジュールが確定させるのは **順序と境界**であって、生成そのものではない。
 * 3.3 は書き込み経路の順序を「クォータ判定 → 生成 → 費用計上 → ビルド → 行の作成」と
 * 定めており、この順序を守ることが 4.3 の費用上限と 7.1 の封じ込めの前提になっている。
 * 各段の中身は別の issue が持つため、ここでは**差し替え可能な継ぎ目（seam）**として
 * 宣言し、未実装の段は 501 で落とす。
 *
 * 順序を先に固定しておく理由は、後から段を足すときに順序を議論し直さないためである。
 * 例えば費用の計上（3.3-4）はビルドより前にあり、これは**生成が成功してもビルドが
 * 失敗しても課金は発生している**という事実に対応する。順序が緩いと、失敗経路で計上を
 * 飛ばす実装が自然に見えてしまい、4.3 の「リトライ分も必ず計上する」が崩れる。
 *
 * **#83 で 3.3-3（生成）が埋まった。** 実装は `src/bedrock.ts`（Bedrock の `Converse`）と
 * `src/generation-models.ts`（モデル選択）にあり、このモジュールは順序と境界だけを持つ
 * 立場を変えていない。**残りの段は 501 のままである。**
 *
 * **5.2 との差分**: 5.2 は 3.3 に無い「入力の安全性検査（8.1）」をクォータ判定の
 * 手前に置く。これは M6-1 の範囲なので、この骨組みには段を作らず、挿入位置だけを
 * `runGenerationPipeline` のコメントに記す（使われない段を先に作らない）。
 */
import type { Route, RouteHandler } from './routes.js';
import { json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import type { GenerationResult, SystemPromptResolver } from './generation-models.js';
import { createBedrockGenerateSource } from './bedrock.js';

/** 生成エンドポイントのパス。 */
export const GENERATE_PATH = '/api/generate';

/**
 * 受け付けるプロンプトの最大文字数。
 *
 * 仕様書に明文がないため、ここで決めて根拠を残す。**費用 DoS の入り口を絞るための
 * 値**であり（7.3）、体験上の制約として置いているのではない。自然文でゲームを説明する
 * には 2,000 文字あれば足りる一方、入力トークンは 4.2 が「支配項は出力トークン」と
 * するとおり単価が低く、この長さなら 1 生成あたりの費用に実質的な影響を与えない。
 *
 * M0-4 が 1 生成あたりのコストを実測したら、その結果で見直してよい。**コードの
 * 1 か所にあるので、見直しは定数の変更で済む。**
 */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * 受け付けるリクエスト本文の最大バイト数。
 *
 * プロンプトの上限（2,000 文字）を UTF-8 の最大 4 バイト/文字で見積もっても 8 KiB で、
 * JSON の空白と他の項目を含めて 16 KiB あれば余る。**文字数の検査より手前に置く**
 * ため、本文を読み切る前に打ち切れる。
 */
const MAX_BODY_BYTES = 16 * 1024;

/** 受け付ける `Content-Type`。この経路は fetch から叩かれる API であり、画面ではない。 */
const JSON_MEDIA_TYPE = 'application/json';

/** リクエストを受け付けられなかった理由。 */
export type GenerateRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'malformed-json'
  | 'missing-prompt'
  | 'prompt-too-long'
  | 'unknown-field';

/** 検証を通ったリクエスト。 */
export interface GenerateRequest {
  /** 利用者が入力した自然文プロンプト。前後の空白は落としてある。 */
  readonly prompt: string;
}

/** リクエスト本文の解析結果。 */
export type GenerateParseResult =
  | { readonly ok: true; readonly request: GenerateRequest }
  | { readonly ok: false; readonly reason: GenerateRejection };

/** 日次クォータと月次上限の判定結果（3.3-2 / 4.3）。 */
export type QuotaDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** 生成の各段。**未実装の段は例外を投げる**（黙って成功しない）。 */
export interface GenerationPipeline {
  /** 3.3-2: 日次クォータと月次上限を判定する（M3-2）。 */
  readonly checkQuota: (env: Env, userId: string) => Promise<QuotaDecision>;
  /**
   * 3.3-3: Go ソースを生成し、`usage` を得る（#83 が Bedrock で実装した）。
   *
   * **戻り値の型が「どのモデルで生成したか」を必須にしている**（`GenerationResult`）。
   * #22 の費用台帳がモデル別単価で円換算するため、後段が推測で埋められない。型で
   * 要求しておけば、モデルを落とした実装はコンパイルが通らない。
   */
  readonly generateSource: (env: Env, request: GenerateRequest) => Promise<GenerationResult>;
  /** 3.3-4: 費用を台帳へ加算する。**成功・失敗・リトライを問わず全件**（M3-1）。 */
  readonly recordCost: (env: Env, userId: string, generated: GenerationResult) => Promise<void>;
  /** 5.2-5: AST でパッケージのホワイトリストを検査する（M2-3）。 */
  readonly inspectSource: (generated: GenerationResult) => void;
  /** 3.3-5..7: Lambda でビルドし、そのまま R2 へ書き戻す（確定24 / M2-5）。 */
  readonly build: (env: Env, generated: GenerationResult) => Promise<unknown>;
  /** 3.3-8: `games` 行を `status='draft'` で作成する（M2-7）。 */
  readonly createGame: (env: Env, userId: string, built: unknown) => Promise<{ id: string }>;
}

/**
 * 未実装の段であることを表す例外。
 *
 * 経路層はこれを 501 へ写す。段ごとに名前を持たせるのは、骨組みだけを動かしたときに
 * **どこまで進んだか**が応答から読めるようにするため。
 */
export class PipelineStepNotImplemented extends Error {
  constructor(readonly step: string) {
    super(`生成パイプラインの段が未実装です: ${step}`);
    this.name = 'PipelineStepNotImplemented';
  }
}

/**
 * 既定のパイプライン。**すべての段が未実装**で、順序だけが決まっている。
 *
 * 空の実装を「成功」にしない。成功にすると、段を実装し忘れたまま経路が 200 を返し、
 * 生成できていないのに `games` 行が作られたように見える経路ができる。
 */
export const notImplementedPipeline: GenerationPipeline = {
  checkQuota: () => {
    throw new PipelineStepNotImplemented('checkQuota');
  },
  generateSource: () => {
    throw new PipelineStepNotImplemented('generateSource');
  },
  recordCost: () => {
    throw new PipelineStepNotImplemented('recordCost');
  },
  inspectSource: () => {
    throw new PipelineStepNotImplemented('inspectSource');
  },
  build: () => {
    throw new PipelineStepNotImplemented('build');
  },
  createGame: () => {
    throw new PipelineStepNotImplemented('createGame');
  },
};

/**
 * システムプロンプトが未実装であることを表す解決関数（#16）。
 *
 * **本 issue はプロンプト本文を持たない。** トランスポート（#83）とプロンプト本文（#16）
 * の分担がそこで切れている。空の文字列を返して「成功」にしないのは、
 * `notImplementedPipeline` が空実装を成功にしないのと同じ理由で、**制約の書かれていない
 * プロンプトで生成すると、課金だけが発生してコンパイルできないソースが返る**ためである。
 *
 * #16 はこの関数を差し替えるだけでよい。モデルを引数に取るのは、6.1 が
 * 「システムプロンプトはモデルごとに持つ（確定5）」と定めるためである。
 */
export const notImplementedSystemPrompt: SystemPromptResolver = (model) => {
  throw new PipelineStepNotImplemented(`systemPrompt:${model.key}`);
};

/**
 * 既定のパイプライン。**生成の段（3.3-3）だけが実装済み**である。
 *
 * `notImplementedPipeline` を土台に、`generateSource` を Bedrock の実装で差し替える。
 * **順序は変えない。** 3.3 は「クォータ判定 → 生成 → 費用計上 → ビルド → 行の作成」で、
 * 生成の手前にクォータ判定（#23）が未実装のまま残る。したがってこの既定で経路を
 * 叩いても **501 で止まり、Bedrock は呼ばれない。** これは事故ではなく設計で、
 * **費用の出る段を、費用を止める段より先に開けない。**
 */
export const defaultPipeline: GenerationPipeline = {
  ...notImplementedPipeline,
  generateSource: createBedrockGenerateSource({ systemPrompt: notImplementedSystemPrompt }),
};

/**
 * リクエスト本文を解析して検証する。
 *
 * **この関数は例外を投げない。** 壊れた JSON、`Content-Type` 違い、巨大な本文は
 * すべて理由付きの失敗として返す（`src/waitlist.ts` と同じ方針）。
 *
 * 未知の項目を拒否するのは、`prompt` の綴り違いが「空のプロンプトで生成した」形で
 * 通るのを防ぐため。生成は課金を伴うので、曖昧な入力を推測で受け取らない。
 *
 * @param request 受信したリクエスト
 * @returns 解析結果
 */
export async function parseGenerateRequest(request: Request): Promise<GenerateParseResult> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, reason: body.reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed-json' };
  }

  const fields = parsed as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key !== 'prompt') {
      return { ok: false, reason: 'unknown-field' };
    }
  }

  const prompt = fields['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, reason: 'missing-prompt' };
  }
  // 文字数で数える。バイト数で数えると、同じ内容でも日本語のプロンプトだけが
  // 短く切られる（UTF-8 で 3 バイト/文字）。
  const trimmed = prompt.trim();
  if ([...trimmed].length > MAX_PROMPT_LENGTH) {
    return { ok: false, reason: 'prompt-too-long' };
  }

  return { ok: true, request: { prompt: trimmed } };
}

/**
 * 3.3 の順序で各段を呼ぶ。
 *
 * 段の中身は持たない。**ここが持つのは順序と、段の間で何が渡るかだけ**である。
 *
 * M6-1（入力側モデレーション）は 5.2 が定める位置、すなわち `checkQuota` の**手前**へ
 * 入れる。生成前に弾くことに意味があるので、費用の発生する段より後ろへ置かないこと。
 *
 * @param env バインディングと環境変数
 * @param userId 生成する利用者
 * @param request 検証済みのリクエスト
 * @param pipeline 差し替え可能な各段
 * @returns 作成した作品の id
 */
export async function runGenerationPipeline(
  env: Env,
  userId: string,
  request: GenerateRequest,
  pipeline: GenerationPipeline,
): Promise<{ readonly id: string }> {
  // 3.3-2: 超過なら即座に拒否する。生成より先に判定することが 4.3 の前提。
  const quota = await pipeline.checkQuota(env, userId);
  if (!quota.allowed) {
    throw new QuotaExceeded(quota.reason);
  }

  // 3.3-3: 生成。
  const generated = await pipeline.generateSource(env, request);

  // 3.3-4: 費用の計上。**生成が返った直後に、成否によらず行う。** ここより後ろの段が
  // 失敗しても課金は済んでいるため、後ろへ動かすと計上漏れになる。
  await pipeline.recordCost(env, userId, generated);

  // 5.2-5: ホワイトリスト検査。違反は再生成に回さず即拒否する。
  pipeline.inspectSource(generated);

  // 3.3-5..7: ビルドと R2 への書き戻し。#76 で 8 段へ戻った（v1.9 は 3.3-5..8 だった）。
  const built = await pipeline.build(env, generated);

  // 3.3-8: `games` 行の作成（#76 で採番が戻った。v1.9 は 3.3-9 だった）。
  return await pipeline.createGame(env, userId, built);
}

/** クォータ超過（3.3-2 / 4.3）。 */
export class QuotaExceeded extends Error {
  constructor(readonly detail: string) {
    super(`生成枠を超えています: ${detail}`);
    this.name = 'QuotaExceeded';
  }
}

/**
 * 生成リクエストを処理する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param pipeline 差し替え可能な各段
 * @returns レスポンス
 */
async function handleGenerate(
  request: Request,
  env: Env,
  pipeline: GenerationPipeline,
): Promise<Response> {
  // **認証を先に見る。** 本文の検証より前に置くのは、未認証の相手に本文を読ませて
  // 解析まで行う理由が無いためで、7.3 の費用 DoS に対する入口の絞りでもある。
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return json({ error: 'unauthorized' }, 401);
  }

  const parsed = await parseGenerateRequest(request);
  if (!parsed.ok) {
    return json({ error: parsed.reason }, 400);
  }

  try {
    const game = await runGenerationPipeline(env, session.userId, parsed.request, pipeline);
    return json({ gameId: game.id }, 202);
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      // 4.4 は停止時も「プレイと拡散は継続する」とする。止まるのは生成だけなので、
      // 認証の失敗（401）とは別の応答にする。
      return json({ error: 'quota exceeded' }, 429);
    }
    if (error instanceof PipelineStepNotImplemented) {
      // 骨組みだけが動いている状態。どこまで進んだかを返す（段の名前は実装の内部名
      // だが、公開前の開発中に到達する応答であり、利用者向けの文言ではない）。
      console.error(`[generate] ${error.message}`);
      return json({ error: 'not implemented', step: error.step }, 501);
    }
    console.error('[generate] 生成の処理に失敗しました', describeGenerateError(error));
    return json({ error: 'internal error' }, 500);
  }
}

/**
 * 例外を、ログへ出してよい 1 行の文字列へ落とす。
 *
 * **`message` を出さない。** ここは各段が投げた例外を受ける位置であり、中身は
 * こちらで決まらない。利用者のプロンプトは 8.2 のモデレーション対象になる入力で、
 * `generations.prompt` として D1 に持つのとは保管場所も寿命も違うログへ、段の実装
 * しだいで流れてよいものではない。
 *
 * 「段はプロンプトを例外へ入れないこと」という呼びかけで担保しない
 * （shared-ai-rules 12 章）。**段の診断情報は段自身が、何が安全か知っている場所で
 * ログに出す。** ここが出すのは「どの種類の例外で落ちたか」だけでよい。
 *
 * @param error catch した値（型は unknown）
 * @returns ログに残してよい 1 行
 */
function describeGenerateError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 生成の経路を組み立てる。
 *
 * @param pipeline 差し替える各段（既定は `defaultPipeline`）
 * @returns 経路表へ連結する `Route[]`
 */
export function createGenerateRoutes(
  pipeline: GenerationPipeline = defaultPipeline,
): readonly Route[] {
  const handler: RouteHandler = (request, env) => handleGenerate(request, env, pipeline);
  return [{ method: 'POST', path: GENERATE_PATH, handler }];
}

/** アプリの経路表へ連結する生成の経路（既定の依存）。 */
export const generateRoutes: readonly Route[] = createGenerateRoutes();
