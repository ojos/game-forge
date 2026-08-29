/**
 * オーケストレータへ渡す非同期呼び出しのペイロード（#160 / A 案）。
 *
 * ## なぜ独立したモジュールなのか
 *
 * **この形だけが、Worker（送る側）と Lambda（受ける側）の両方から使われる。**
 * どちらかの側へ書くと、もう一方が同じ形をもう一度書くことになる
 * （shared-ai-rules 12 章「一覧の複製は機械照合で担保する」の、複製を作らない側）。
 *
 * ## 何を載せ、何を載せないか
 *
 * | 項目 | 載せる理由 |
 * |---|---|
 * | `gameId` | どの行を進めるか。コールバックの宛先そのもの |
 * | `jobToken` | **平文**。D1 にはハッシュしか無い（`src/games.ts`） |
 * | `prompt` | 生成の入力。`ledger` で送り返す元でもある（`generations.prompt`） |
 * | `modelKey` | どのモデルで生成するか。**正本は `wrangler.toml` の `GENERATION_MODEL`** |
 *
 * **`userId` を載せない。** 台帳の作者は `games` 行が知っており、そちらが正である
 * （`src/generate-callback.ts` の `ledger`）。載せると、トークンを持つ者が本文で
 * 他人を名指しして枠を消費できる形が生まれる。**要らないものを運ばない。**
 *
 * **コールバックの URL を載せない。** 宛先は Lambda 側の環境変数
 * （`CALLBACK_BASE_URL`）が持つ。ペイロードで受け取る形にすると、**呼び出しの
 * ペイロードを差し替えられる者がジョブトークンの送り先を変えられる。** 宛先は
 * 宣言（`terraform/orchestrator.tf`）が決め、実行時の入力では動かせないほうがよい。
 *
 * **モデルの鍵はペイロードで渡す。** Lambda 側にもう 1 つ `GENERATION_MODEL` を
 * 置くと、確定5 の A/B がどちらの宣言で決まるのか読めなくなる。エッジが選び、
 * オーケストレータは**登録簿に在る鍵かどうかだけ**を確かめて従う。
 *
 * ## 大きさ
 *
 * Lambda の非同期呼び出しのペイロード上限は 256 KB。`prompt` は 2,000 文字
 * （`src/generate.ts` の `MAX_PROMPT_LENGTH`）なので UTF-8 最大でも 8 KB で、
 * 他の項目を足しても桁が 1 つ違う。
 */
import type { GenerationModelKey } from '../generation-models.js';
import { findGenerationModel } from '../generation-models.js';
import { MAX_PROMPT_LENGTH } from '../generate.js';

/**
 * ペイロードの版。
 *
 * **受け側が知らない版を黙って処理しない。** 送る側だけを先に配ると、古い Lambda が
 * 新しい形を「知っている項目だけ読んで」処理してしまう。生成は 1 回 約 16 円で、
 * 黙って走り出す形をここに作らない。
 */
export const ORCHESTRATOR_PAYLOAD_VERSION = 1;

/** 非同期呼び出しの本文。 */
export interface OrchestratorPayload {
  /** {@link ORCHESTRATOR_PAYLOAD_VERSION}。 */
  readonly version: number;
  /** 作品 id。 */
  readonly gameId: string;
  /** そのジョブだけを進められる使い捨てトークン（平文）。 */
  readonly jobToken: string;
  /** 利用者が入力した自然文プロンプト。 */
  readonly prompt: string;
  /** 生成に使うモデルの鍵（`src/generation-models.ts` の登録簿）。 */
  readonly modelKey: GenerationModelKey;
}

/**
 * ペイロードを組み立てる（送る側）。
 *
 * @param job 起動するジョブ
 * @param modelKey 生成に使うモデルの鍵
 * @returns 非同期呼び出しの本文
 */
export function buildOrchestratorPayload(
  job: { readonly gameId: string; readonly jobToken: string; readonly request: { readonly prompt: string } },
  modelKey: GenerationModelKey,
): OrchestratorPayload {
  return {
    version: ORCHESTRATOR_PAYLOAD_VERSION,
    gameId: job.gameId,
    jobToken: job.jobToken,
    prompt: job.request.prompt,
    modelKey,
  };
}

/**
 * ペイロードを検証する（受ける側）。
 *
 * **この関数は例外を投げない**（`src/generate.ts` の `parseGenerateRequest`、
 * `src/generate-callback.ts` の `parseCallbackRequest` と同じ方針）。
 *
 * 未知の項目は**断る**。綴り違いが「既定値で通った」形になると、そのまま LLM を
 * 呼んでしまう。
 *
 * @param value 呼び出しで届いた値
 * @returns 検証を通ったペイロード、または null
 */
export function parseOrchestratorPayload(value: unknown): OrchestratorPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['version', 'gameId', 'jobToken', 'prompt', 'modelKey'].includes(key)) {
      return null;
    }
  }
  if (record['version'] !== ORCHESTRATOR_PAYLOAD_VERSION) {
    return null;
  }
  const gameId = record['gameId'];
  const jobToken = record['jobToken'];
  const prompt = record['prompt'];
  const modelKey = record['modelKey'];
  if (typeof gameId !== 'string' || gameId === '') {
    return null;
  }
  if (typeof jobToken !== 'string' || jobToken === '') {
    return null;
  }
  if (typeof prompt !== 'string' || prompt === '' || [...prompt].length > MAX_PROMPT_LENGTH) {
    return null;
  }
  if (typeof modelKey !== 'string' || findGenerationModel(modelKey) === null) {
    return null;
  }
  return {
    version: ORCHESTRATOR_PAYLOAD_VERSION,
    gameId,
    jobToken,
    prompt,
    modelKey: modelKey as GenerationModelKey,
  };
}
