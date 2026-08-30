/**
 * 生成ジョブから D1 を更新するためのコールバック経路（#150 / A 案）。
 *
 * ## 何のためにあるか
 *
 * 生成の本体（91 秒）は Worker の外——オーケストレータ Lambda——へ移る。**移した先から
 * D1 を書く経路が要る。** 選択肢は 2 つあった。
 *
 *   (a) Cloudflare の API トークンを AWS 側へ置き、D1 の REST API を直接叩く
 *   (b) Worker のコールバック経路を叩く（**これ**）
 *
 * **(a) を採らない。** D1 の編集権限はアカウント単位で、そのトークンは本番を含む
 * **すべての D1 データベースの読み書きと削除**ができる。「1 行を更新したい」に対して
 * 代償が大きすぎる（7.3 / 9.2）。**D1 のバインディングを持つ場所を 1 か所に保つ。**
 *
 * ## 長命の共有シークレットも置かない
 *
 * (b) でも、AWS 側に恒久的な鍵を 1 本置く形は避けられる。**ジョブごとの使い捨て
 * トークン**を使う（`src/games.ts`）。
 *
 * - Worker が行を作るときに 256 ビットの乱数を引き、**ハッシュだけ**を `games` へ保存
 * - 平文はジョブのペイロードにだけ載る
 * - このトークンにできるのは**その 1 行を進めること**だけ。寿命は 1 ジョブ
 * - 完了と同時に `job_token_hash` は NULL になる（**使い捨て**）
 *
 * したがって、この経路が漏れても他の作品にも他のテーブルにも届かない。
 *
 * ## 4 つの種別
 *
 * | 種別 | 何をするか | 冪等性の担保 |
 * |---|---|---|
 * | `claim` | `pending` → `running`。**重複実行を止める関門** | 条件付き UPDATE（`src/games.ts`） |
 * | `ledger` | `generations` へ 1 行（3.3-4 / 確定25） | 呼ぶ側が採番した id ＋ `on conflict do nothing` |
 * | `cache-lookup` | 3.8 のビルド結果キャッシュを引く | 読み取りのみ |
 * | `finish` | `ready` または `failed` へ進める | 条件付き UPDATE ＋ トークンの使い捨て |
 *
 * ## `ledger` は届くまで再送される前提で作る
 *
 * **LLM を呼んだあとにこのコールバックが落ち続けると、課金は出ているのに
 * `generations` の行が無い状態になる。** 4.3 の「リトライ分も必ず計上する」が崩れ、
 * 日次枠も減らない（確定25 は枠を台帳の行数で数える）。利用者には得だが、
 * **費用ガードの前提が壊れる。**
 *
 * **コールバックの再送は LLM を呼ばないので費用ゼロである。** したがって呼ぶ側は
 * 届くまで再送してよい。こちら側は何度受け取っても 1 行にする——**呼ぶ側が LLM
 * 呼び出しごとに 1 つ採番した `generationId`** を鍵にする（`src/cost-ledger.ts` の
 * `RecordGenerationOptions`）。
 *
 * ## プロンプトは呼ぶ側が送り返す
 *
 * `generations.prompt` は `NOT NULL` だが（5.1）、**Worker はプロンプトをどこにも
 * 保持していない**（`games.title` は 40 文字に切った派生物である）。したがって
 * `ledger` はプロンプトを本文で受け取る。
 *
 * **Worker 側に保存しておく形は採らない。** 保存場所が `generations.prompt` と
 * 2 か所になり、**削除申請（M6-5）で消す対象が増える。** プロンプトはどのみち
 * Bedrock へ送るデータであり、戻りは元いた場所へ戻るだけである。
 *
 * ## 呼ぶ側はまだ無い
 *
 * オーケストレータ Lambda・IAM・配備は別 issue である。**それでも 4 種別を揃えて
 * 置くのは、あちらがこの契約を土台として使うためである。** 何を送れば何が起きるかの
 * 正本はここにある。
 */
import type { Route } from './routes.js';
import { json, readLimitedText } from './routes.js';
import type { GenerationErrorCode } from './games.js';
import {
  GENERATION_ERROR_CODES,
  claimGenerationJob,
  completeGameWithArtifacts,
  failGame,
  hashJobToken,
} from './games.js';
import type { BuildCacheRecord } from './build-cache.js';
import { readBuildCache } from './build-cache.js';
import { recordGeneration } from './cost-ledger.js';
import type { GenerationModelKey, GenerationResult } from './generation-models.js';
import { findGenerationModel } from './generation-models.js';
import { MAX_PROMPT_LENGTH } from './generate.js';
import type { CostAlertOutcome } from './mail/cost-alert.js';
import { notifyMonthlyCostWarning } from './mail/cost-alert.js';
import type { GenerationNoticeOutcome, GenerationOutcome } from './mail/generation-notice.js';
import { notifyGenerationFinished } from './mail/generation-notice.js';
// 3.8 の degrade の発火信号（#140）。**この経路だけが、ビルド依頼の失敗を D1 の側から
// 見られる**——生成の本体はオーケストレータ Lambda で走っており、あちらは D1 を持たない。
import { clearBuildPathFailures, recordBuildPathFailure } from './build-health.js';

/** コールバックのパス。 */
export const GENERATE_CALLBACK_PATH = '/api/generate/callback';

/**
 * 受け付ける本文の最大バイト数。
 *
 * **`src/generate.ts` の `MAX_BODY_BYTES` と同じ 16 KiB にする。** `ledger` が
 * プロンプトを送り返すため、載る最大の本文はあちらと同じ形になる
 * （プロンプトの上限 2,000 文字 × UTF-8 の最大 4 バイト = 8 KiB に、JSON の空白と
 * 他の項目を足しても 16 KiB で余る）。
 *
 * **生成ソースも診断も載らない。** ソースの行き先は R2 で、診断の行き先は呼ぶ側の
 * ログである。どちらもここを通らないので、この上限で足りる。
 */
const MAX_BODY_BYTES = 16 * 1024;

/** 受け付ける `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/** コールバックの種別（モジュール冒頭の表）。 */
export const CALLBACK_KINDS = ['claim', 'ledger', 'cache-lookup', 'finish'] as const;

/** コールバックの種別。 */
export type CallbackKind = (typeof CALLBACK_KINDS)[number];

/** 受け付けられなかった理由。 */
export type CallbackRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'malformed-json'
  | 'unknown-field'
  | 'missing-game-id'
  | 'missing-job-token'
  | 'unknown-kind'
  | 'unknown-error-code'
  | 'invalid-build-signal'
  | 'invalid-ledger'
  | 'invalid-artifacts'
  | 'invalid-source-hash'
  | 'missing-outcome';

/** `ledger` が運ぶもの。 */
export interface LedgerCallback {
  /** 呼ぶ側が LLM 呼び出しごとに 1 つ採番した `generations.id`。**再送の鍵である。** */
  readonly generationId: string;
  /** 利用者が入力した自然文プロンプト（`generations.prompt`）。 */
  readonly prompt: string;
  /** 費用の算出に要る、生成 1 回分の結果。 */
  readonly generated: GenerationResult;
}

/** `finish` の成功側が運ぶもの。 */
export interface FinishArtifacts {
  readonly goVersion: string;
  readonly sourceKey: string;
  readonly wasmKey: string;
  /** 3.8 の索引へ新しく記録する内容。**キャッシュヒット時は null**（書き直さない）。 */
  readonly cacheRecord: BuildCacheRecord | null;
}

/** 検証を通ったコールバック。 */
export type CallbackRequest = {
  readonly gameId: string;
  readonly jobToken: string;
} & (
  | { readonly kind: 'claim' }
  | { readonly kind: 'ledger'; readonly ledger: LedgerCallback }
  | { readonly kind: 'cache-lookup'; readonly sourceSha256: string }
  | {
      readonly kind: 'finish';
      readonly errorCode: GenerationErrorCode;
      /**
       * ビルド依頼そのものが失敗したか（3.8 の degrade の発火信号。#140）。
       *
       * **`errorCode` から導けない。** `internal` には D1 の不調も関数の障害も落ちて
       * くる（`src/games.ts` の `GENERATION_ERROR_CODES`）。判定は呼ぶ側の catch が
       * 例外の種別で行い（`src/build-health.ts`）、ここは受け取るだけである。
       */
      readonly buildPathFailed: boolean;
    }
  | { readonly kind: 'finish'; readonly artifacts: FinishArtifacts }
);

/** 解析結果。 */
export type CallbackParseResult =
  | { readonly ok: true; readonly request: CallbackRequest }
  | { readonly ok: false; readonly reason: CallbackRejection };

/** 本文で受け取ってよい項目。**これ以外が来たら断る。** */
const ALLOWED_FIELDS = new Set([
  'gameId',
  'jobToken',
  'kind',
  'errorCode',
  'ledger',
  'artifacts',
  'sourceSha256',
  // 3.8 の degrade の発火信号（#140）。**失敗側にしか意味が無い**ので、成功側に
  // 付いていたら断る（下記）。
  'buildPathFailed',
]);

/** コンテンツハッシュの綴り（小文字 16 進 64 桁）。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * 値が平たいオブジェクトかを確かめる。
 *
 * @param value 確かめる値
 * @returns オブジェクトなら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 非負の有限な整数かを確かめる。
 *
 * **トークン数とバイト数はここを通す。** 負や NaN をそのまま入れると、費用の
 * 円換算（4.2）と 3.8 の索引が黙って壊れた値を持つ。
 *
 * @param value 確かめる値
 * @returns 非負の整数なら true
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * `ledger` の中身を検証する。
 *
 * **モデルの鍵は登録簿に在るものだけを受け付ける**（`src/generation-models.ts`）。
 * 知らない鍵を通すと、単価を引けないまま費用 0 円の行が積まれる。
 *
 * @param value 本文の `ledger`
 * @returns 検証を通った内容、または null
 */
function parseLedger(value: unknown): LedgerCallback | null {
  if (!isRecord(value)) {
    return null;
  }
  const { generationId, prompt, modelKey, modelId, stopReason, usage } = value;
  if (typeof generationId !== 'string' || generationId === '') {
    return null;
  }
  if (typeof prompt !== 'string' || prompt === '' || [...prompt].length > MAX_PROMPT_LENGTH) {
    return null;
  }
  if (typeof modelKey !== 'string' || findGenerationModel(modelKey) === null) {
    return null;
  }
  if (typeof modelId !== 'string' || modelId === '') {
    return null;
  }
  if (typeof stopReason !== 'string' || stopReason === '') {
    return null;
  }
  if (!isRecord(usage)) {
    return null;
  }
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = usage;
  if (!isCount(inputTokens) || !isCount(outputTokens)) {
    return null;
  }
  // **`null` は「その課金次元が無い」ことを表す**（`src/cost-ledger.ts`）。0 と区別する。
  if (cacheReadInputTokens !== null && !isCount(cacheReadInputTokens)) {
    return null;
  }
  if (cacheWriteInputTokens !== null && !isCount(cacheWriteInputTokens)) {
    return null;
  }

  return {
    generationId,
    prompt,
    generated: {
      modelKey: modelKey as GenerationModelKey,
      modelId,
      // **ソースは運ばない。** 台帳は `generations.prompt` しか持たず（5.1）、
      // 生成物の行き先は R2 である。運ばないものを型の都合で埋める。
      source: '',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheReadInputTokens as number | null,
        cacheWriteInputTokens: cacheWriteInputTokens as number | null,
      },
      stopReason,
    },
  };
}

/**
 * 3.8 の索引へ書く内容を検証する。
 *
 * @param value 本文の `artifacts.cacheRecord`
 * @returns 検証を通った内容、または null
 */
function parseCacheRecord(value: unknown): BuildCacheRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    sourceSha256,
    goVersion,
    sourceKey,
    wasmKey,
    wasmBytes,
    wasmSha256,
    compressedBytes,
    compressedSha256,
    contentEncoding,
  } = value;
  const strings = [goVersion, sourceKey, wasmKey, contentEncoding];
  if (strings.some((entry) => typeof entry !== 'string' || entry === '')) {
    return null;
  }
  if (typeof sourceSha256 !== 'string' || !SHA256_PATTERN.test(sourceSha256)) {
    return null;
  }
  if (typeof wasmSha256 !== 'string' || !SHA256_PATTERN.test(wasmSha256)) {
    return null;
  }
  if (typeof compressedSha256 !== 'string' || !SHA256_PATTERN.test(compressedSha256)) {
    return null;
  }
  if (!isCount(wasmBytes) || !isCount(compressedBytes)) {
    return null;
  }
  return {
    sourceSha256,
    goVersion: goVersion as string,
    sourceKey: sourceKey as string,
    wasmKey: wasmKey as string,
    wasmBytes,
    wasmSha256,
    compressedBytes,
    compressedSha256,
    contentEncoding: contentEncoding as string,
  };
}

/**
 * `finish` の成功側を検証する。
 *
 * @param value 本文の `artifacts`
 * @returns 検証を通った内容、または null
 */
function parseArtifacts(value: unknown): FinishArtifacts | null {
  if (!isRecord(value)) {
    return null;
  }
  const { goVersion, sourceKey, wasmKey, cacheRecord } = value;
  if (typeof goVersion !== 'string' || goVersion === '') {
    // **空の `go_version` を書かせない。** 3.5 の `wasm_exec.js` 出し分けの入力であり、
    // 空のまま完成させると配信側が 500 になる（`src/games.ts` の `UNBUILT_GO_VERSION`）。
    return null;
  }
  if (typeof sourceKey !== 'string' || sourceKey === '') {
    return null;
  }
  if (typeof wasmKey !== 'string' || wasmKey === '') {
    return null;
  }
  // **項目そのものが無い場合は断る。** 欠落（`undefined`）とキャッシュヒット（`null`）を
  // 同じ扱いにすると、**呼ぶ側が索引の更新を落としたことを検出できない。** そのまま
  // `ready` へ進むと 3.8 の索引が更新されず、次に同じソースが来てもヒットしない
  // ——気づけないまま約 16 円と 21.6 秒を余計に払い続ける。
  //
  // **`null` は明示的な「書き直さない」である**（ヒット時。`buildCacheRecordOf` が
  // null を返す）。意図した null と、書き忘れた undefined を区別する。
  if (!Object.prototype.hasOwnProperty.call(value, 'cacheRecord')) {
    return null;
  }
  if (cacheRecord === null) {
    return { goVersion, sourceKey, wasmKey, cacheRecord: null };
  }
  const record = parseCacheRecord(cacheRecord);
  if (record === null) {
    return null;
  }
  return { goVersion, sourceKey, wasmKey, cacheRecord: record };
}

/**
 * 本文を解析して検証する。
 *
 * **この関数は例外を投げない**（`src/generate.ts` の `parseGenerateRequest` と同じ方針）。
 *
 * 未知の項目を拒否するのは、綴り違いが「既定値で通った」形になるのを防ぐため。
 * この経路は作品行と費用台帳を進めるので、曖昧な入力を推測で受け取らない。
 *
 * @param request 受信したリクエスト
 * @returns 解析結果
 */
export async function parseCallbackRequest(request: Request): Promise<CallbackParseResult> {
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
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'malformed-json' };
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, reason: 'unknown-field' };
    }
  }

  const gameId = parsed['gameId'];
  if (typeof gameId !== 'string' || gameId === '') {
    return { ok: false, reason: 'missing-game-id' };
  }
  const jobToken = parsed['jobToken'];
  if (typeof jobToken !== 'string' || jobToken === '') {
    return { ok: false, reason: 'missing-job-token' };
  }
  const rawKind = parsed['kind'];
  if (typeof rawKind !== 'string' || !(CALLBACK_KINDS as readonly string[]).includes(rawKind)) {
    return { ok: false, reason: 'unknown-kind' };
  }
  const kind = rawKind as CallbackKind;
  const base = { gameId, jobToken } as const;

  if (kind === 'claim') {
    return { ok: true, request: { ...base, kind } };
  }

  if (kind === 'ledger') {
    const ledger = parseLedger(parsed['ledger']);
    if (ledger === null) {
      return { ok: false, reason: 'invalid-ledger' };
    }
    return { ok: true, request: { ...base, kind, ledger } };
  }

  if (kind === 'cache-lookup') {
    const sourceSha256 = parsed['sourceSha256'];
    if (typeof sourceSha256 !== 'string' || !SHA256_PATTERN.test(sourceSha256)) {
      return { ok: false, reason: 'invalid-source-hash' };
    }
    return { ok: true, request: { ...base, kind, sourceSha256 } };
  }

  // kind === 'finish'。**成功と失敗のどちらか一方でなければならない。**
  const hasError = parsed['errorCode'] !== undefined;
  const hasArtifacts = parsed['artifacts'] !== undefined;
  if (hasError === hasArtifacts) {
    // 両方あると「成功なのか失敗なのか」を受け取り側が決めることになる。
    // 両方無ければ何も決まらない。**どちらも断る。**
    return { ok: false, reason: 'missing-outcome' };
  }

  // 3.8 の degrade の発火信号（#140）。**真偽値以外を推測で読まない。** 生成の経路は
  // 差し替えられるので、`"true"` や `1` を true として飲むと、**送った側が意図して
  // いない停止**をサービス全体へ出しうる（#140 の「誤爆のコストは見逃しより高い」）。
  const buildSignal = parsed['buildPathFailed'];
  if (buildSignal !== undefined && typeof buildSignal !== 'boolean') {
    return { ok: false, reason: 'invalid-build-signal' };
  }

  if (hasError) {
    const errorCode = parsed['errorCode'];
    if (
      typeof errorCode !== 'string' ||
      !(GENERATION_ERROR_CODES as readonly string[]).includes(errorCode)
    ) {
      // **知らない分類名を素通ししない。** 素通しすると、`games.generation_error` に
      // 画面が知らない値が入り、作品ページが既定の文言へ落ちる（何が起きたかを
      // 利用者にもこちらにも説明できなくなる）。
      return { ok: false, reason: 'unknown-error-code' };
    }
    // **省略は false として扱う。** 3.8 の停止は「起きたことが分かっている」ときに
    // だけ出すもので、分からない状態を停止へ倒さない。
    return {
      ok: true,
      request: {
        ...base,
        kind,
        errorCode: errorCode as GenerationErrorCode,
        buildPathFailed: buildSignal === true,
      },
    };
  }

  // **成功側に信号が付いていたら断る。** 黙って捨てると、呼ぶ側は「記録された」と
  // 読める応答（`accepted: true`）を受け取る。**成功は停止の証拠になりえない**ので、
  // 意味の無い項目として通さない。
  if (buildSignal !== undefined) {
    return { ok: false, reason: 'invalid-build-signal' };
  }

  const artifacts = parseArtifacts(parsed['artifacts']);
  if (artifacts === null) {
    return { ok: false, reason: 'invalid-artifacts' };
  }
  return { ok: true, request: { ...base, kind, artifacts } };
}

/**
 * このコールバックが起こす通知（#148 / #153）。
 *
 * # なぜ通知の口がここにあるのか
 *
 * **費用が増えるのも、生成が終わるのも、この経路だからである。**
 *
 * - 80% 警告（#148）は**費用が増えた直後**にしか変わらない。生成の入口
 *   （`/api/generate` のクォータ判定）で回すと、超過中は利用者のリクエストの中で
 *   毎回判定と R2 の読み書きを走らせることになる。
 * - 完了通知（#153）は**結果が確定した瞬間**に送るものである。
 *
 * **どちらも利用者のリクエストの中ではない。** `/api/generate` は #160 以降
 * オーケストレータへ投げてすぐ 202 を返し（`src/generate.ts`）、この経路を叩くのは
 * AWS 側である。**90.9 秒の待ち時間に通知は載らない。**
 *
 * # 差し替えられる形にしてある
 *
 * `src/generate.ts` の `GenerationPipeline` と同じ形である。**テストは送信の手前で
 * 止めるためにここを差し替える**（既定のまま経路を登録するので、本番の結線は変わらない）。
 *
 * # 判定時刻は呼び出し側が渡す
 *
 * **台帳へ書いた時刻と、警告を判定する時刻を同じにする**（PR #169 のレビュー指摘）。
 * どちらも既定で現在時刻を取る形にすると、**JST の月境界では 1 秒のずれで台帳の行が
 * 前月に入り、警告の判定と目印の鍵が翌月で動く。** その月の警告が出ないか、翌月の
 * 目印を先に消費する——どちらも「80% を超えたのに運用者へ届かない」形である。
 * ハンドラで 1 つ捕まえた時刻を、記録と判定の両方へ渡す。
 *
 * # 通知の失敗でコールバックを失敗にしない
 *
 * 台帳の記録も作品行の完成も、通知より先に終わっている。**通知が落ちたことを理由に
 * 呼ぶ側へ再送させると、届いている台帳と作品行に対して同じ処理をもう一度やらせる
 * ことになる。** どちらの関数も投げない契約である（`src/mail/` の 2 つ）。
 */
export interface CallbackNotifiers {
  /** 月次費用の 80% 警告（#148）。 */
  readonly monthlyCostWarning: (env: Env, at: number) => Promise<CostAlertOutcome>;
  /** 生成の完了・失敗（#153）。 */
  readonly generationFinished: (
    env: Env,
    gameId: string,
    outcome: GenerationOutcome,
  ) => Promise<GenerationNoticeOutcome>;
}

/** 既定の通知（本物の送信経路）。 */
export const defaultCallbackNotifiers: CallbackNotifiers = {
  monthlyCostWarning: (env, at) => notifyMonthlyCostWarning(env, at),
  generationFinished: (env, gameId, outcome) => notifyGenerationFinished(env, gameId, outcome),
};

/**
 * コールバックを処理する。
 *
 * # 認証はジョブトークンだけである
 *
 * セッション cookie を見ない。**呼ぶのはブラウザではなく AWS だからである。**
 * 逆に言うと、この経路はログインしていない相手からの POST を受け付ける。
 * 通るのは `gameId` と `jobToken` の組が一致したときだけで、どちらも推測できない。
 *
 * # 失敗の理由を細かく返さない
 *
 * トークンが違うのか、行が無いのか、既に完了しているのかを区別して返さない。
 * 区別すると、任意の id が存在するかを外から確かめられる手がかりになる
 * （`src/session-user.ts` と同じ考え方）。**呼ぶ側にとっても区別は要らない**
 * ——`claim` が通らなければ降りる、それだけである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param notifiers 通知（既定は本物の送信経路）
 * @returns レスポンス
 */
async function handleCallback(
  request: Request,
  env: Env,
  notifiers: CallbackNotifiers = defaultCallbackNotifiers,
): Promise<Response> {
  const parsed = await parseCallbackRequest(request);
  if (!parsed.ok) {
    return json({ error: parsed.reason }, 400);
  }
  const callback = parsed.request;
  const tokenHash = await hashJobToken(callback.jobToken);

  if (callback.kind === 'claim') {
    // **握れたかどうかをそのまま返す。** 呼ぶ側は false を受け取ったら LLM を呼ばずに
    // 降りる。これが「1 回の送信につき LLM は 1 回」を担保する唯一の関門である
    // （`src/games.ts` の `claimGenerationJob`）。
    return json({ claimed: await claimGenerationJob(env, callback.gameId, tokenHash) }, 200);
  }

  // `claim` 以外は、先に「このジョブの持ち主か」を確かめる。**`claim` だけが
  // 1 回の UPDATE で照合まで済ませられる**（条件に入れられるため）。
  const job = await runningJob(env, callback.gameId, tokenHash);
  if (job === null) {
    return json({ accepted: false }, 200);
  }

  if (callback.kind === 'ledger') {
    // 3.3-4: **1 回の LLM 呼び出しにつき 1 行**（確定25 / 4.3）。呼ぶ側が採番した
    // id を鍵にするので、**同じ呼び出しの再送は行を増やさない。**
    //
    // **`userId` は本文から取らない。** 作者は `games` 行が知っており、そちらが正である。
    // 本文から取ると、トークンを持つ者が他人の枠を消費できる。
    // **時刻はここで 1 つだけ捕まえる。** 記録と判定が別々に現在時刻を取ると、JST の
    // 月境界で行が前月に入り、判定と目印の鍵が翌月で動く（PR #169 のレビュー指摘。
    // 上の {@link CallbackNotifiers} の「判定時刻は呼び出し側が渡す」）。
    const now = Math.floor(Date.now() / 1000);
    const record = await recordGeneration(
      env,
      {
        userId: job.authorId,
        prompt: callback.ledger.prompt,
        generated: callback.ledger.generated,
      },
      now,
      { id: callback.ledger.generationId },
    );
    // 4.3 の 80% 警告（#148）。**費用が増えた直後にだけ判定する。**
    //
    // **`record.written` で絞らない。** 再送でも判定へ入れる。抑止は月ごとの目印が
    // 持っており（`src/mail/cost-alert.ts`）、「行が増えたか」に抑止を兼ねさせると、
    // 行を書いた直後に落ちた回の警告が**永久に出なくなる**。
    await notifiers.monthlyCostWarning(env, now);
    return json({ accepted: true, recorded: record.written }, 200);
  }

  if (callback.kind === 'cache-lookup') {
    // 3.8: 索引を引き、成果物が R2 に実在することまで確かめる（`src/build-cache.ts`）。
    const lookup = await readBuildCache(env, callback.sourceSha256);
    return json({ accepted: true, lookup }, 200);
  }

  // kind === 'finish'。
  //
  // **通知は行を進めたあとに送る**（#153）。利用者から見える状態は送信の前に確定して
  // いるので、Resend が遅くても作品ページの表示は待たされない。
  //
  // **進まなかったときは送らない。** `finished` が false なのは、条件付き UPDATE が
  // 1 行も変えなかった＝この `finish` が効かなかったということである。効かなかった
  // 仕事の完了を知らせない。
  if ('errorCode' in callback) {
    const finished = await failGame(env, callback.gameId, callback.errorCode);
    if (finished && callback.buildPathFailed) {
      // 3.8 の degrade の発火信号（#140 / 確定24）。**`finished` で絞る**——false は
      // 重複配信（0007）であり、同じ依頼を 2 件として数えると、**1 人の要求だけで
      // 閾値へ届く。**（`build_health` の主キーでも止まるが、数え方の理由はここにある。）
      //
      // **`errorCode` を見ない。** 見ると、D1 の不調で `internal` になった失敗まで
      // 停止として数えることになる（#140 の acceptance が区別せよと言う 2 つ）。
      await recordBuildPathFailure(env, callback.gameId, Math.floor(Date.now() / 1000));
    }
    if (finished) {
      await notifiers.generationFinished(env, callback.gameId, {
        kind: 'failed',
        errorCode: callback.errorCode,
      });
    }
    return json({ accepted: true, finished }, 200);
  }

  const { goVersion, sourceKey, wasmKey, cacheRecord } = callback.artifacts;
  // **ビルド関数を実際に呼んで成功したときだけ、停止の信号を捨てる**（3.8 / #140）。
  //
  // **`cacheRecord` が非 null であることが「関数を呼んだ」の同義語である**
  // （`src/orchestrator/pipeline.ts` はヒット時に null を送る＝索引を書き直さない）。
  // ヒットは D1 と R2 を引いただけなので、**AWS Lambda が生きている証拠にならない。**
  //
  // **`finished` で絞らない。** 経路が生きていたという事実は、`games` 行が既に
  // 確定していたかどうか（重複配信）と関係しない。**平常時は表が空で、削除は 0 行・
  // 行書き込みも 0 なので、生成 1 回あたりの書き込みは増えない**（3.6 /
  // `src/build-health.ts`）。
  if (cacheRecord !== null) {
    await clearBuildPathFailures(env);
  }
  const finished = await completeGameWithArtifacts(
    env,
    callback.gameId,
    { goVersion, sourceKey, wasmKey },
    cacheRecord,
  );
  if (finished) {
    await notifiers.generationFinished(env, callback.gameId, { kind: 'ready' });
  }
  return json({ accepted: true, finished }, 200);
}

/** 進行中のジョブと、その作者。 */
interface RunningJob {
  readonly authorId: string;
}

/**
 * その `gameId` の現在のジョブトークンが一致するかを確かめ、作者を返す。
 *
 * **`claim` のように 1 回の UPDATE で済ませられない。** `failGame` も
 * `completeGameWithArtifacts` もトークンを見ない（同期実行では Worker が自分で
 * 呼ぶため、トークンを持ち回る意味が無い）。外から呼ばれるこの経路だけが先に照合する。
 *
 * **`job_token_hash` が NULL の行は通さない。** 完了と同時に捨てているので、
 * 完了済みのジョブに対する遅れた再送はここで止まる。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param tokenHash ジョブトークンのハッシュ
 * @returns 一致すれば作者、しなければ null
 */
async function runningJob(
  env: Env,
  gameId: string,
  tokenHash: string,
): Promise<RunningJob | null> {
  const row = await env.DB.prepare('select author_id, job_token_hash from games where id = ?')
    .bind(gameId)
    .first<{ author_id: string; job_token_hash: string | null }>();
  if (row === null || row.job_token_hash === null || row.job_token_hash !== tokenHash) {
    return null;
  }
  return { authorId: row.author_id };
}

/**
 * コールバックの経路を組み立てる。
 *
 * **通知を差し替えられるのはここだけである。** アプリの経路表（`src/app.ts`）は
 * 既定の {@link generateCallbackRoutes} を連結するので、本番の結線は変わらない。
 *
 * @param notifiers 通知（既定は本物の送信経路）
 * @returns 経路表
 */
export function createGenerateCallbackRoutes(
  notifiers: CallbackNotifiers = defaultCallbackNotifiers,
): readonly Route[] {
  return [
    {
      method: 'POST',
      path: GENERATE_CALLBACK_PATH,
      handler: (request, env) => handleCallback(request, env, notifiers),
    },
  ];
}

/** アプリの経路表へ連結するコールバックの経路。 */
export const generateCallbackRoutes: readonly Route[] = createGenerateCallbackRoutes();
