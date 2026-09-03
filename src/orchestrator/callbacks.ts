/**
 * オーケストレータから Worker のコールバック経路を叩く側（#160 / #150）。
 *
 * **契約の正本は `src/generate-callback.ts` にある。** ここはその 4 種別
 * （`claim` / `ledger` / `cache-lookup` / `finish`）を呼ぶだけで、意味は持たない。
 *
 * ## D1 を直接叩かない
 *
 * Cloudflare の API トークンを AWS 側へ置かない（#150 / 7.3 / 9.2）。D1 の編集権限は
 * **アカウント単位**で、本番を含むすべてのデータベースの読み書きと削除ができる。
 * 「1 行を更新したい」に対して代償が大きすぎる。**D1 のバインディングを持つ場所は
 * 1 か所に保つ。**
 *
 * ## 認証はジョブごとの使い捨てトークンだけ
 *
 * D1 にはハッシュしか無く、平文は非同期呼び出しのペイロードにだけ載る
 * （`./payload.ts`）。このトークンにできるのは**その 1 行を進めること**だけで、
 * 完了と同時に `job_token_hash` は NULL になる。
 *
 * **ログへ出さない。** 例外の綴りにも入れない（この経路で漏れると、そのジョブだけは
 * 他人に進められる）。
 *
 * ## 再送の方針は種別ごとに違う
 *
 * | 種別 | 落ちたときに何が壊れるか | 方針 |
 * |---|---|---|
 * | `claim` | 握れたかどうかが分からない | **再送する。** 通信の失敗を「握れなかった」と読むと、生成が黙って消える |
 * | `ledger` | **課金だけ出て日次枠が減らない**（4.3 / 確定25） | **届くまで再送する。** 再送は LLM を呼ばないので費用ゼロ |
 * | `cache-lookup` | 索引を引けない | 再送する（失敗したら降りる。3.8 は費用の話ではない） |
 * | `finish` | 行が `running` のまま残り、作品ページが永久に「生成中」 | **届くまで再送する** |
 *
 * **「届くまで」に上限は要る。** 関数の実行時間には上限があり（15 分。
 * `terraform/orchestrator.tf` は 600 秒）、無限の再送は「再送し続けたまま
 * タイムアウトで消える」ことにしかならない。予算（{@link DEFAULT_RETRY_BUDGET_MS}）を
 * 使い切ったら例外にし、**呼び出し元がそれを OnFailure destination まで運ぶ**
 * （`./handler.ts`）。捨てるのではなく、見える場所へ出す。
 *
 * ## 再送してよい失敗と、してはいけない失敗を分ける
 *
 * 4xx は**こちらの本文が受け付けられなかった**という意味で、同じ本文を送り直しても
 * 結果は変わらない（`src/generate-callback.ts` の `parseCallbackRequest`）。
 * 再送するのは通信の失敗・5xx・429 だけである。
 */
import type { BuildCacheEntry, BuildCacheLookup, BuildCacheRecord } from '../build-cache.js';
import type { GenerationErrorCode } from '../games.js';
import type { GenerationResult } from '../generation-models.js';
import type { CallbackKind } from '../generate-callback.js';
import { GENERATE_CALLBACK_PATH } from '../generate-callback.js';

/** 再送に使える時間の既定（ミリ秒）。 */
export const DEFAULT_RETRY_BUDGET_MS = 120_000;

/** 最初の待ち時間（ミリ秒）。以降は 2 倍ずつ伸ばす。 */
const INITIAL_BACKOFF_MS = 500;

/** 待ち時間の上限（ミリ秒）。 */
const MAX_BACKOFF_MS = 15_000;

/** 1 回の要求を諦めるまでの時間（ミリ秒）。 */
const REQUEST_TIMEOUT_MS = 20_000;

/** コールバックを届けられなかった。**運用が見るべき失敗である。** */
export class CallbackDeliveryFailed extends Error {
  constructor(
    readonly kind: CallbackKind,
    readonly attempts: number,
    readonly lastStatus: number | null,
  ) {
    super(`コールバックを届けられませんでした: ${kind}（${attempts} 回試行）`);
    this.name = 'CallbackDeliveryFailed';
  }
}

/**
 * コールバックは届いたが、この行はもうこのジョブのものではない。
 *
 * `accepted:false`（トークン不一致、または完了済みで `job_token_hash` が NULL）。
 * **再送しても変わらない。** 重複配信の遅れてきたほうが、先に終わったジョブの行を
 * 触ろうとした、という形がこれである。
 */
export class CallbackRejected extends Error {
  constructor(readonly kind: CallbackKind) {
    super(`コールバックが受け付けられませんでした: ${kind}（この行はもうこのジョブのものではありません）`);
    this.name = 'CallbackRejected';
  }
}

/** 外から差し替えられるもの。 */
export interface CallbackDependencies {
  /** 送信に使う `fetch`（テストの継ぎ目）。 */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** 待つ関数（テストの継ぎ目。既定は `setTimeout`）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 現在時刻（ミリ秒。テストの継ぎ目）。 */
  readonly now?: () => number;
}

/** クライアントの構成。 */
export interface CallbackClientOptions {
  /** Worker の起点（例 `https://app.game-forge.ojos.jp`）。**宣言が持つ**（`./handler.ts`）。 */
  readonly baseUrl: string;
  /** 作品 id。 */
  readonly gameId: string;
  /** 使い捨てのジョブトークン（平文）。 */
  readonly jobToken: string;
  /** 再送に使える時間（ミリ秒）。既定は {@link DEFAULT_RETRY_BUDGET_MS}。 */
  readonly retryBudgetMs?: number;
}

/** `ledger` へ渡すもの。 */
export interface LedgerEntry {
  /** **LLM 呼び出しごとに 1 つ採番した id。** 再送の鍵である（確定25 / 4.3）。 */
  readonly generationId: string;
  /** 利用者が入力した自然文プロンプト。 */
  readonly prompt: string;
  /** 生成 1 回分の結果。 */
  readonly generated: GenerationResult;
}

/** `finish` の成功側へ渡すもの。 */
export interface FinishArtifacts {
  readonly goVersion: string;
  readonly sourceKey: string;
  readonly wasmKey: string;
  /** 3.8 の索引へ書く内容。**キャッシュヒット時は null**（書き直さない）。 */
  readonly cacheRecord: BuildCacheRecord | null;
}

/**
 * Worker のコールバック経路を叩くクライアント。
 *
 * **1 ジョブにつき 1 つ作る。** `gameId` と `jobToken` を保持し、呼ぶたびに渡さない
 * ようにするためで、状態としては「届かなかった台帳が何件あるか」と「結末を記録
 * できたか」の 2 つだけを持つ（`./handler.ts` がそれで DLQ 送りを決める）。
 */
export class CallbackClient {
  /** 台帳の再送に失敗した回数。**0 でなければ 4.3 の記録規約が壊れている。** */
  private failedLedgers = 0;

  /** `finish` が受け付けられたか。false のまま終わると行が `running` で残る。 */
  private recordedOutcome = false;

  private readonly endpoint: string;

  private readonly budgetMs: number;

  private readonly send: (request: Request) => Promise<Response>;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly now: () => number;

  constructor(
    private readonly options: CallbackClientOptions,
    deps: CallbackDependencies = {},
  ) {
    this.endpoint = new URL(GENERATE_CALLBACK_PATH, options.baseUrl).toString();
    this.budgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    this.send = deps.fetch ?? ((request: Request) => fetch(request));
    this.sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.now = deps.now ?? (() => Date.now());
  }

  /** 台帳を届けられなかった件数。 */
  get ledgerFailures(): number {
    return this.failedLedgers;
  }

  /** 結末（`ready` / `failed`）を記録できたか。 */
  get outcomeRecorded(): boolean {
    return this.recordedOutcome;
  }

  /**
   * `claim`。**オーケストレータの最初の動作である。**
   *
   * **`false` が返ったら Bedrock を呼ばずに降りる。** これが「1 回の送信につき
   * LLM は 1 回」を担保する唯一の関門で、設定では代替できない（`./start-job.ts`）。
   *
   * @returns 握れたら true
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  async claim(): Promise<boolean> {
    const body = await this.post('claim', {});
    return body['claimed'] === true;
  }

  /**
   * `ledger`。**LLM 呼び出しごとに 1 行**（3.3-4 / 確定25）。
   *
   * **届くまで再送する。** 不達だと課金だけ出て日次枠が減らない（4.3）。
   * 再送は LLM を呼ばないので費用ゼロである。
   *
   * @param entry 記録する内容
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  async ledger(entry: LedgerEntry): Promise<void> {
    const { usage } = entry.generated;
    try {
      const body = await this.post('ledger', {
        ledger: {
          generationId: entry.generationId,
          prompt: entry.prompt,
          modelKey: entry.generated.modelKey,
          modelId: entry.generated.modelId,
          stopReason: entry.generated.stopReason,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
          },
        },
      });
      if (body['accepted'] !== true) {
        this.failedLedgers += 1;
        throw new CallbackRejected('ledger');
      }
    } catch (error) {
      if (error instanceof CallbackDeliveryFailed) {
        this.failedLedgers += 1;
      }
      throw error;
    }
  }

  /**
   * `cache-lookup`。3.8 のビルド結果キャッシュを引く。
   *
   * @param sourceSha256 生成ソースのコンテンツハッシュ
   * @returns 索引の結果
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  async cacheLookup(sourceSha256: string): Promise<BuildCacheLookup> {
    const body = await this.post('cache-lookup', { sourceSha256 });
    if (body['accepted'] !== true) {
      throw new CallbackRejected('cache-lookup');
    }
    // **形を確かめてから返す。** ここは HTTP 越しに来る値で、`hit:true` なのに
    // `entry` が無い形を素通しすると、**成果物の無いキーで `games` 行を完成させる**
    // 経路になる（`src/generate-callback.ts` が `artifacts` を厳しく見ているのと
    // 同じ関心事の、こちら側である）。
    //
    // **形が違えばミスとして扱う。** キャッシュを引けないことは費用ではなく時間の
    // 話で（約 21.6 秒のビルドがもう一度走るだけ）、止める理由にはならない。
    const lookup = body['lookup'];
    if (typeof lookup !== 'object' || lookup === null) {
      return { hit: false, reason: 'not-indexed' };
    }
    const record = lookup as Record<string, unknown>;
    if (record['hit'] !== true) {
      return { hit: false, reason: 'not-indexed' };
    }
    const entry = record['entry'];
    if (typeof entry !== 'object' || entry === null) {
      return { hit: false, reason: 'not-indexed' };
    }
    return { hit: true, entry: entry as BuildCacheEntry };
  }

  /**
   * `finish` の成功側。3.3-8（`games` 行の完成）。
   *
   * @param artifacts 成果物の申告
   * @returns 行を完成させられたら true
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  async finishWithArtifacts(artifacts: FinishArtifacts): Promise<boolean> {
    const body = await this.post('finish', { artifacts });
    if (body['accepted'] !== true) {
      throw new CallbackRejected('finish');
    }
    this.recordedOutcome = true;
    return body['finished'] === true;
  }

  /**
   * `finish` の失敗側（8.3 の分類名）。
   *
   * **書かないと `running` のまま永久に残り、作品ページが「生成中」を出し続ける。**
   *
   * **`buildPathFailed` は 3.8 の degrade の発火信号である**（#140）。`errorCode` では
   * 代われない——`internal` には D1 の不調も関数の障害も落ちてくるので、受け取った側が
   * 区別できない（`src/generate.ts` の `GenerationPipeline.failGame`）。
   * **常に送る。** 省略できる形にすると「送っていない」と「false」が区別できなくなる。
   *
   * @param errorCode 分類名
   * @param buildPathFailed ビルド依頼そのものが失敗したか（3.8 / #140）
   * @returns 行を閉じられたら true
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  /**
   * 入力側モデレーションが遮断したことを記録させる（8.2 / #37）。
   *
   * **状態機械は進めない。** 作品行を失敗にするのは、このあと投げる
   * `PromptBlocked` が `finishWithError('prompt-blocked')` へ落ちる経路である。
   *
   * **本文を送る。** オーケストレータは D1 を持たないので、記録できるのはエッジだけ
   * である。本文は既に {@link ledger} が同じ経路で運んでいるため、運ぶ情報の種類は
   * 増えていない（`migrations/0016_moderation_blocks.sql`）。
   *
   * @param categories Guardrail が挙げたカテゴリの表示名（空にしない）
   * @param prompt 遮断された本文
   * @returns 1 行入ったら true
   */
  async blocked(categories: readonly string[], prompt: string): Promise<boolean> {
    const body = await this.post('blocked', { blocked: { categories, prompt } });
    return body['recorded'] === true;
  }

  async finishWithError(errorCode: GenerationErrorCode, buildPathFailed = false): Promise<boolean> {
    const body = await this.post('finish', { errorCode, buildPathFailed });
    if (body['accepted'] !== true) {
      throw new CallbackRejected('finish');
    }
    this.recordedOutcome = true;
    return body['finished'] === true;
  }

  /**
   * 1 種別を送る。**再送はここが持つ。**
   *
   * @param kind 種別
   * @param extra 種別ごとの追加項目
   * @returns 応答の本文
   * @throws {CallbackDeliveryFailed} 予算内に届かなかったとき
   */
  private async post(kind: CallbackKind, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      gameId: this.options.gameId,
      jobToken: this.options.jobToken,
      kind,
      ...extra,
    });

    const deadline = this.now() + this.budgetMs;
    let backoff = INITIAL_BACKOFF_MS;
    let attempts = 0;
    let lastStatus: number | null = null;

    for (;;) {
      attempts += 1;
      const outcome = await this.attempt(body);
      if (outcome.ok) {
        return outcome.body;
      }
      lastStatus = outcome.status;

      // **4xx は再送しない。** 本文が受け付けられなかったという意味で、同じ本文を
      // 送り直しても結果は変わらない。**呼ぶ側の誤りとして即座に見せる。**
      if (outcome.status !== null && outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429) {
        throw new CallbackDeliveryFailed(kind, attempts, outcome.status);
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new CallbackDeliveryFailed(kind, attempts, lastStatus);
      }
      await this.sleep(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /**
   * 1 回だけ送る。
   *
   * @param body 送る本文
   * @returns 成功なら本文、失敗なら状態コード（通信の失敗は null）
   */
  private async attempt(
    body: string,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number | null }> {
    // 打ち切りを自前の `AbortController` で持つ（`src/build-client.ts` と同じ理由。
    // ランタイムが投げる中断の綴りに頼らずに済む）。
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.send(
        new Request(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        }),
      );
      if (!response.ok) {
        return { ok: false, status: response.status };
      }
      const parsed = (await response.json()) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, status: response.status };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      // **理由を持ち回らない。** 通信の失敗は再送で解ける種類のもので、
      // 種別と回数が分かれば運用には足りる（例外の綴りにトークンを乗せない）。
      return { ok: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
