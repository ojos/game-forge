/**
 * 退会の後続の処理を回す Durable Object（仕様 3.7 / 5.8 / #518 / M15-3。土台は #586 / M15-3a）。
 *
 * **仕事の中身は持たない。** 消し方は `src/withdrawal-purge.ts` の `runWithdrawalPurgeStep` が
 * 持ち、ここが持つのは「いつ起きるか」と「どの作品を待たせているか」だけである。
 * **Pages と同じ TypeScript を読む**（`../../../src/`）ので、削除の規則が 2 か所に分かれない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ Durable Object なのか（cron だけで済ませない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **cron の最短は 1 分で、退会は 1 分に 2 件のペースでしか進まない。** 作品 60 件なら 30 分かかる。
 * DO のアラームなら**進んだ回は 1 秒後に次を立てられる**ので、同じ 60 件が約 1 分で終わる。
 *
 * **それでも cron を残すのは、アラームが「立っていない」状態から立ち上がる手段が要るからである。**
 * Pages（`src/`）からこの DO を起こす結線は**作らない**（#518 の J3。Pages に DO のバインディングを
 * 足すと、退会の口が「後続の処理を起こす」責任まで持つことになり、起こし損ねた退会が止まる）。
 * **D1 の状態が受け渡しを兼ねる**——5 分ごとに起きて D1 を見れば、誰がどこまで進んだかは分かる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 待ち（`#backoff`）はメモリに置く
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`ctx.storage` へ書かない。** 状態の正本は D1 だけである（`src/withdrawal-purge.ts` の冒頭）。
 * DO が退避されて待ちが消えても、次のアラームが同じ候補を拾い直し、同じ理由で失敗すれば
 * また待ちに入るだけで、**消えた作品が取り残されることはない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 公開の入口を持たない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * この DO は**利用者 id を受け取らない**（誰を消すかは D1 が決める）ので、`LikeHub` のような
 * 偽装の口にはならない。それでも `workers/cleanup/wrangler.toml` は `workers_dev = false` /
 * `preview_urls = false` / ルートなしを明示する——**この Worker は R2 のバケット全体を消せる
 * 資格情報を持つ**ので、外から叩ける形にしてはならない。宣言は
 * `scripts/check-cleanup-worker.sh` が機械で見る。
 */
import { DurableObject } from 'cloudflare:workers';
import type { PurgeBackoff } from '../../../src/withdrawal-purge.js';
import { runWithdrawalPurgeStep } from '../../../src/withdrawal-purge.js';

/**
 * この Worker のバインディング（`workers/cleanup/wrangler.toml`）。
 *
 * **`wrangler types` が Pages の宣言から作る `Env` を使わない**（`workers/likes/src/hub.ts` の
 * `LikesEnv` と同じ）。別のスクリプトなので持っているバインディングが違い、Pages の型を借りると
 * 「宣言に無いものが型にはある」状態になる。
 *
 * **`BUCKET` は likes には無い。** 作品の成果物とアイコンを消すために要る。
 */
export interface CleanupEnv {
  /** 本番の D1（Pages と同じデータベース）。 */
  readonly DB: D1Database;
  /** 本番の R2（Pages と同じバケット）。 */
  readonly BUCKET: R2Bucket;
  /** 自分自身の DO。`scheduled()` がインスタンス {@link WITHDRAWAL_HUB_INSTANCE} を起こす。 */
  readonly WITHDRAWAL_HUB: DurableObjectNamespace<WithdrawalHub>;
}

/**
 * 退会の後続の処理を回す DO のインスタンス名。
 *
 * **1 個だけにする。** 削除は D1 の枠（1 呼び出し 50 クエリ）と R2 の枠を食うので、利用者ごとに
 * 分けて同時に走らせると、平常の生成と取り合う。順番に消せば足りる（60 件で約 1 分）。
 */
export const WITHDRAWAL_HUB_INSTANCE = 'withdrawal';

/** 失敗した作品を最初に待たせる時間（**1 分**）。 */
export const BACKOFF_BASE_SECONDS = 60;

/** 待ちの上限（**1 時間**）。これ以上は延ばさない——直った作品を何日も放置しない。 */
export const BACKOFF_MAX_SECONDS = 60 * 60;

/** 待ちの帳面 1 件。 */
interface BackoffEntry {
  /** 失敗の回数。 */
  attempts: number;
  /** 次に取ってよい時刻（UNIX 秒）。 */
  until: number;
}

/**
 * 指数的に待つ帳面（**メモリだけ**）。
 *
 * 1 回目は {@link BACKOFF_BASE_SECONDS} 秒、以降は倍々で {@link BACKOFF_MAX_SECONDS} 秒まで。
 */
export class MemoryPurgeBackoff implements PurgeBackoff {
  readonly #entries = new Map<string, BackoffEntry>();

  /**
   * その作品をいま取ってよいか。
   *
   * @param gameId 作品 id
   * @param now 時刻（UNIX 秒）
   * @returns 取ってよければ true
   */
  ready(gameId: string, now: number): boolean {
    const entry = this.#entries.get(gameId);
    return entry === undefined || entry.until <= now;
  }

  /**
   * 失敗を 1 回積む。
   *
   * @param gameId 作品 id
   * @param now 時刻（UNIX 秒）
   */
  fail(gameId: string, now: number): void {
    const attempts = (this.#entries.get(gameId)?.attempts ?? 0) + 1;
    const wait = Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_MAX_SECONDS);
    this.#entries.set(gameId, { attempts, until: now + wait });
  }

  /**
   * 成功したので忘れる。
   *
   * @param gameId 作品 id
   */
  clear(gameId: string): void {
    this.#entries.delete(gameId);
  }

  /** 待たせている作品の数（テストと診断のため）。 */
  get size(): number {
    return this.#entries.size;
  }
}

/**
 * 退会の後続の処理を回す DO。
 *
 * **公開の `fetch` を持たない。** 起こすのは同じ Worker の `scheduled()` だけで、
 * Pages からは呼ばれない（バインディングも張っていない）。
 */
export class WithdrawalHub extends DurableObject<CleanupEnv> {
  readonly #backoff = new MemoryPurgeBackoff();

  /**
   * いますぐアラームを立てる（cron から呼ぶ）。
   *
   * **既に立っているアラームを前へ引く。** 待ち（30 分）で寝ているあいだに cron が来たら、
   * そちらを優先してよい——D1 の状態が変わっている（新しい退会が来た）かもしれない。
   * **アラームは 1 個しか持てない**ので、上書きで足りる。
   */
  async wake(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * アラーム 1 回ぶんの仕事をして、次のアラームを決める。
   *
   * **次のアラームを立てるのはここだけ**（`runWithdrawalPurgeStep` は時間を返すだけで、
   * `ctx.storage` を知らない——あちらをテストするのに DO を要らなくするため）。
   *
   * @throws D1 と R2 の失敗（**そのまま投げる**。DO のアラームは失敗すると自動で再試行する）
   */
  override async alarm(): Promise<void> {
    const result = await runWithdrawalPurgeStep(this.env, this.#backoff);
    if (result.nextDelayMs !== null) {
      await this.ctx.storage.setAlarm(Date.now() + result.nextDelayMs);
    }
  }
}
