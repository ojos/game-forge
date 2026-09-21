/**
 * チャットの Lambda を**同期で**呼ぶ段（#695 / M18-2。仕様 5.16）。
 *
 * これは**エッジ側**の実装である。受け取って走る側は `src/chat/handler.ts`、器は
 * `terraform/chat-function.tf`、配備は `scripts/deploy-chat.sh` にある。
 *
 * ## なぜ Lambda なのか
 *
 * **エッジは Bedrock を呼べない**（`src/chat/handler.ts` の冒頭。#160 / #570 で
 * `BEDROCK_AWS_*` を Pages のシークレットから消した）。
 *
 * ## OGP と違い、応答を待つ（アイコンと同じ）
 *
 * **`X-Amz-Invocation-Type: RequestResponse`。** チャットの返答はその場で画面へ出す必要があり、
 * 1 往復は数秒である。**Worker が応答を待つあいだは CPU 時間を使わない**
 * （`src/avatar-client.ts`）。
 *
 * ## 資格情報は `BUILD_AWS_*` を使う（増やさない）
 *
 * **足すのは許可 1 つだけ**である——`game-forge-build-invoker` に「この関数を
 * `lambda:InvokeFunction` する」を加える（`terraform/chat-function.tf`）。
 * 専用の 4 組目を作ると、**「エッジから長命の鍵が 1 組減る」という #160 の積極的な理由が
 * 薄れる**（`src/avatar-client.ts` / `src/orchestrator/start-job.ts` と同じ判断）。
 *
 * ## 投げ直さない
 *
 * **同時実行の枠で断られても、投げ直さない。** アイコン（#380）は「画像を選び直させない」
 * ために 2 回だけ投げ直したが、**チャットは送信ボタンを押し直すだけである。**
 * 混んでいることは分類名で返し、画面が「混み合っています」と出す。
 *
 * ## 台帳を書くのはここではない
 *
 * **`usage` は応答に載って戻る**。台帳へ積むのは口（`src/chat.ts`）で、**書くのはエッジ**
 * という生成の経路と同じ分担である。
 */
import { AwsClient } from 'aws4fetch';
import {
  CHAT_PAYLOAD_VERSION,
  type ChatRequestPayload,
  type ChatResponsePayload,
} from './chat-payload.js';

/** SigV4 の署名対象サービス名。 */
const SIGNING_SERVICE = 'lambda';

/** Lambda の `Invoke` API の版。 */
const LAMBDA_API_VERSION = '2015-03-31';

/**
 * 同期呼び出しであることを表すヘッダの値。
 *
 * **`Event` に変えると応答に返答が載らない**（202 だけが返る）。定数として置き、
 * `test/chat.test.ts` が署名済み要求のヘッダで照合する。
 */
export const CHAT_SYNC_INVOCATION_TYPE = 'RequestResponse';

/**
 * 呼ぶ相手の名前を持つ環境変数（`wrangler.toml` の `[vars]`）。
 *
 * **秘密ではないので `[vars]` に置く**（`AVATAR_FUNCTION_NAME` と同じ扱い）。正本は
 * `terraform/chat-function.tf` の `local.chat_function_name` で、突き合わせは
 * `scripts/check-chat-copies.sh` が行う。
 */
export const CHAT_FUNCTION_NAME_VAR = 'CHAT_FUNCTION_NAME';

/** 呼ぶために必須の秘密（`src/avatar-client.ts` の 3 つと同じ）。 */
export const CHAT_SECRET_NAMES = [
  'BUILD_AWS_REGION',
  'BUILD_AWS_ACCESS_KEY_ID',
  'BUILD_AWS_SECRET_ACCESS_KEY',
] as const;

/** 呼び出しに必要な設定が足りない。 */
export class ChatNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    // **値は出さない。名前だけ**（`src/avatar-client.ts` と同じ）。
    super(`チャットの呼び出しに必要な設定がありません: ${missing.join(', ')}`);
    this.name = 'ChatNotConfigured';
  }
}

/** 同時実行の枠で断られた。**関数は 1 度も走っていない。** */
export class ChatBusy extends Error {
  constructor() {
    super('チャットが混み合っています');
    this.name = 'ChatBusy';
  }
}

/** 呼び出しに失敗した（送れなかった・関数が落ちた・応答が読めない）。 */
export class ChatCallFailed extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(`チャットの呼び出しに失敗しました（status=${status}）`);
    this.name = 'ChatCallFailed';
  }
}

/** 外から差し替えられるもの。 */
export interface ChatClientDependencies {
  /** 送信に使う `fetch`（テストの継ぎ目）。 */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** チャットを呼ぶ段。`src/chat.ts` がこの形で受け取る。 */
export type AskChat = (env: Env, payload: ChatRequestPayload) => Promise<ChatResponsePayload>;

/**
 * 不足している設定の名前を返す。
 *
 * @param env バインディングと環境変数
 * @returns 不足している名前（揃っていれば空配列）
 */
export function missingChatSecrets(env: Env): readonly string[] {
  const values = env as unknown as Record<string, unknown>;
  const missing: string[] = CHAT_SECRET_NAMES.filter((name) => {
    const value = values[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  const functionName = values[CHAT_FUNCTION_NAME_VAR];
  if (typeof functionName !== 'string' || functionName.trim() === '') {
    missing.push(CHAT_FUNCTION_NAME_VAR);
  }
  return missing;
}

/**
 * `Invoke` のエンドポイントを組み立てる。
 *
 * @param region リージョン
 * @param functionName 関数名
 * @returns エンドポイントの URL
 */
function invokeEndpoint(region: string, functionName: string): string {
  return `https://lambda.${region}.amazonaws.com/${LAMBDA_API_VERSION}/functions/${encodeURIComponent(functionName)}/invocations`;
}

/**
 * 同時実行の枠（とスロットリング）で断られた応答か。
 *
 * **本文は読まない**（状態と見出しで決める。`src/avatar-client.ts` の `isThrottled` と同じ）。
 *
 * @param response Lambda の応答
 * @returns 混んでいる断りなら true
 */
export function isChatThrottled(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  const type = (response.headers.get('x-amzn-errortype') ?? '').split(':')[0] ?? '';
  return type === 'TooManyRequestsException' || type === 'ThrottlingException';
}

/**
 * 同期呼び出しの段を作る。
 *
 * @param deps 外部依存
 * @returns チャットを呼ぶ関数
 */
export function createAskChat(deps: ChatClientDependencies = {}): AskChat {
  return async (env: Env, payload: ChatRequestPayload): Promise<ChatResponsePayload> => {
    const missing = missingChatSecrets(env);
    if (missing.length > 0) {
      throw new ChatNotConfigured(missing);
    }
    const values = env as unknown as Record<string, string | undefined>;
    const region = values['BUILD_AWS_REGION']!.trim();
    const sessionToken = values['BUILD_AWS_SESSION_TOKEN'];
    const aws = new AwsClient({
      accessKeyId: values['BUILD_AWS_ACCESS_KEY_ID']!.trim(),
      secretAccessKey: values['BUILD_AWS_SECRET_ACCESS_KEY']!.trim(),
      // 空文字を渡すと空の `X-Amz-Security-Token` が署名に入り、長命キーの署名が壊れる。
      sessionToken:
        typeof sessionToken === 'string' && sessionToken.trim() !== '' ? sessionToken.trim() : undefined,
      service: SIGNING_SERVICE,
      region,
    });
    const send = deps.fetch ?? ((request: Request) => fetch(request));
    const endpoint = invokeEndpoint(region, values[CHAT_FUNCTION_NAME_VAR]!.trim());

    let response: Response;
    try {
      const signed = await aws.sign(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // **`Event` に戻さない。** 戻すと応答に返答が載らない。
          'x-amz-invocation-type': CHAT_SYNC_INVOCATION_TYPE,
        },
        body: JSON.stringify({ ...payload, version: CHAT_PAYLOAD_VERSION }),
      });
      response = await send(signed);
    } catch (error) {
      // **会話の本文は例外にもログにも入れない**（1.2.54）。
      throw new ChatCallFailed(
        0,
        error instanceof Error ? `${error.name}: ${error.message}` : 'unknown send error',
      );
    }

    if (isChatThrottled(response)) {
      await response.body?.cancel();
      throw new ChatBusy();
    }

    // 同期呼び出しの成功は 200。**関数の中で投げた例外も 200 で返り、`X-Amz-Function-Error` が付く。**
    const functionError = response.headers.get('x-amz-function-error');
    if (response.status !== 200 || functionError !== null) {
      throw new ChatCallFailed(
        response.status,
        functionError ?? response.headers.get('x-amzn-errortype'),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ChatCallFailed(response.status, 'unreadable payload');
    }
    return readChatPayload(body, response.status);
  };
}

/**
 * 関数の応答を読む。**形が合わなければ例外にする**（読めない応答を「断った」に倒さない）。
 *
 * @param payload JSON を解析した値
 * @param status HTTP の状態（例外に載せる）
 * @returns チャットの結果
 * @throws {ChatCallFailed} 形が合わないとき
 */
export function readChatPayload(payload: unknown, status: number): ChatResponsePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new ChatCallFailed(status, 'payload is not an object');
  }
  const record = payload as Record<string, unknown>;
  if (record['ok'] === false) {
    const error = record['error'];
    if (error === 'prompt-blocked') {
      const categories = record['categories'];
      return {
        ok: false,
        error,
        categories: Array.isArray(categories)
          ? categories.filter((value): value is string => typeof value === 'string')
          : [],
      };
    }
    if (error === 'internal') {
      return { ok: false, error };
    }
    throw new ChatCallFailed(status, 'unknown error classification');
  }
  if (record['ok'] !== true) {
    throw new ChatCallFailed(status, 'ok is missing');
  }
  const usage = record['usage'];
  if (
    typeof record['text'] !== 'string' ||
    typeof record['modelKey'] !== 'string' ||
    typeof record['promptVersion'] !== 'number' ||
    typeof record['stopReason'] !== 'string' ||
    typeof usage !== 'object' ||
    usage === null
  ) {
    throw new ChatCallFailed(status, 'payload is malformed');
  }
  const usageRecord = usage as Record<string, unknown>;
  // **入出力の 2 項目は欠けない**（`src/bedrock.ts` の `readConverseUsage` が既に投げている）。
  // ここで読めないのは、関数と口の版がずれている状態である。
  if (
    typeof usageRecord['inputTokens'] !== 'number' ||
    typeof usageRecord['outputTokens'] !== 'number'
  ) {
    throw new ChatCallFailed(status, 'usage is malformed');
  }
  const cacheOf = (name: string): number | null => {
    const value = usageRecord[name];
    return typeof value === 'number' ? value : null;
  };
  return {
    ok: true,
    text: record['text'],
    modelKey: record['modelKey'],
    promptVersion: record['promptVersion'],
    stopReason: record['stopReason'],
    usage: {
      inputTokens: usageRecord['inputTokens'],
      outputTokens: usageRecord['outputTokens'],
      cacheReadInputTokens: cacheOf('cacheReadInputTokens'),
      cacheWriteInputTokens: cacheOf('cacheWriteInputTokens'),
    },
  };
}
