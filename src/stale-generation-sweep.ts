/**
 * 止まったまま残った生成・推敲の行を `failed` に畳む（#681 / 仕様 3.7 / 4.3）。
 *
 * **起こすのは `game-forge-cleanup` の cron（5 分ごと）だけである**（`workers/cleanup/src/index.ts` の
 * `scheduled`）。Pages の要求の中からは呼ばない——**GET が状態を書き換える形にしない**
 * （`src/games.ts` の `STALE_AFTER_SECONDS` の規約）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ要るのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **作品の削除（`src/game-deletion.ts` の `deleteGame`）は `generation_state in ('ready', 'failed')` の行しか
 * 掴まず、推敲ジョブが `pending` / `running` の作品も断る**（#516 / #517。経過時間で区切らない。遅れて届いた
 * コールバックが消えた行に当たると台帳の行を落とすため）。オーケストレータが拒否した・落ちた生成の行は
 * `pending` / `running` のまま残り、**作者はその作品を永久に消せなかった**（2026-09-18 の実例。#242 の行が
 * 17 日残った）。退会の後続の処理（`src/withdrawal-purge.ts`）も進行中の作品を候補から外すので、同じ行が
 * 退会の完了も止める。
 *
 * **畳めば、既存の削除がそのまま通る。** 状態の読み手（作品ページの失敗の案内・削除の導線の
 * `deletionBlockOf`・#455 の進行中の判定）は、どれも `failed` を「終わった」と読む。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 区切り（{@link STALE_GENERATION_SWEEP_SECONDS}）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **コールバックが届きうるのは、オーケストレータの `maximum_event_age`（300 秒）と `timeout`（870 秒）を
 * 足した約 20 分までである**（`terraform/orchestrator.tf`。`maximum_retry_attempts = 0` なので掛け算は無い）。
 * それを十分に過ぎた行には、もう何も届かない。**1 時間**を採る。
 *
 * **画面の区切り（`STALE_AFTER_SECONDS` の 900 秒）を流用しない。** あちらは「表示が中断の可能性を言い始める」
 * 境界で、`timeout`（870 秒）との余裕は 30 秒しかない（`src/games.ts`）。表示は外れても次の読み込みで直るが、
 * **この掃除は行を書き換え、書き換えた行は戻らない。** 書き込む側は、届きうる時間（イベントの待ちと実行を
 * 足した約 20 分）の外側に、時計のずれや配信の遅れを飲み込める幅を持って置く。照合は
 * `test/stale-generation-sweep.test.ts` が terraform の値を読んで行う（食い違えば落ちる）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 規約
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **条件付き UPDATE で畳む。** `where` に `pending` / `running` と区切りを持つので、遅れて claim や完了が
 *   来ても、どちらか一方が 0 行になるだけで二重に書かない
 * - **台帳（`generations`）には書かない。** 台帳を書くのはエッジで、通知が来ていない行に費用は無い
 *   （#242 の constraints）。枠も戻さない（使っていない）
 * - **件数に上限をかける**（{@link STALE_SWEEP_BATCH_LIMIT}）。1 回の起動の D1 の文は **2 本**（batch 1 つ）で、
 *   Workers Free の枠（1 呼び出し 50）に対して十分小さい。溜まっていても 5 分ごとに少しずつ畳む
 * - **公開中の作品の行は畳まない**（`status <> 'published'`）。公開中の作品が `pending` / `running` になる経路は
 *   無いが、あったとしても公開中の作品の状態をこの掃除が変える理由は無い。**推敲ジョブはジョブの行だけを
 *   畳む**（作品の行には触らない。公開中の作品の推敲も含む——作品は `ready` のまま無傷である）
 * - 失敗の分類名は **`internal`**（8.3 の固定語彙。`src/games.ts` の `GENERATION_ERROR_CODES`）。止まった
 *   理由をこちらは知らない
 */
import { PUBLISHED_STATUS } from './games.js';

/**
 * 止まったと見なして `failed` に畳むまでの秒数（開始から数える。**1 時間**）。
 *
 * **オーケストレータの `maximum_event_age`（300 秒）＋ `timeout`（870 秒）＝ 1,170 秒より長くなければならない**
 * （それより短いと、まだ届きうるコールバックの行を畳む）。照合は `test/stale-generation-sweep.test.ts` が
 * `terraform/orchestrator.tf` を読んで行う。
 */
export const STALE_GENERATION_SWEEP_SECONDS = 60 * 60;

/**
 * 1 回の起動で畳む行の上限（**表ごとに 25 行**）。
 *
 * 行数は D1 の文の本数に効かない（1 表 1 文）が、1 文が書く行を抑えて、溜まった行を一度に書き換える
 * 書き込みの山を作らない。5 分ごとに 25 行なら 1 時間で 300 行畳める。
 */
export const STALE_SWEEP_BATCH_LIMIT = 25;

/** 畳むときに入れる失敗の分類名（8.3 の固定語彙）。 */
export const STALE_SWEEP_ERROR_CODE = 'internal';

/** {@link sweepStaleGenerations} が読むバインディング。 */
export interface StaleSweepEnv {
  /** 本番の D1。 */
  readonly DB: D1Database;
}

/** {@link sweepStaleGenerations} の結果。 */
export interface StaleSweepResult {
  /** `failed` に畳んだ作品の行の数。 */
  readonly games: number;
  /** `failed` に畳んだ推敲ジョブの行の数。 */
  readonly revisionJobs: number;
}

/**
 * 作品の行を畳む文（束縛 3 つ: 分類名・区切り・上限）。
 *
 * **内側の select は部分索引 `games_generation_state_idx`（0007。`pending` / `running` だけ）から入る。**
 * 外側の `where` にも状態を書き直すのは、条件付き UPDATE の規約を文の上で読めるようにするためである
 * （同じ文の中なので結果は変わらない）。
 */
export const SWEEP_GAMES_SQL = `update games
        set generation_state = 'failed', generation_error = ?, job_token_hash = null
      where id in (select id from games
                    where generation_state in ('pending', 'running')
                      and status <> '${PUBLISHED_STATUS}'
                      and coalesce(generation_started_at, created_at) <= ?
                    limit ?)
        and generation_state in ('pending', 'running')`;

/**
 * 推敲ジョブの行を畳む文（束縛 3 つ: 分類名・区切り・上限）。
 *
 * **作品の行には触らない**（`src/revisions.ts` の `failRevision` と同じ。作品は `ready` のまま）。
 * `game_revision_jobs` は 1 作品 1 行（主キー `game_id`）で、成功した行は消えるので、表の大きさは
 * 「推敲に失敗したことのある作品の数」で頭打ちになる。索引は足していない。
 */
export const SWEEP_REVISION_JOBS_SQL = `update game_revision_jobs
        set state = 'failed', error = ?
      where game_id in (select game_id from game_revision_jobs
                         where state in ('pending', 'running')
                           and coalesce(started_at, created_at) <= ?
                         limit ?)
        and state in ('pending', 'running')`;

/**
 * 区切りを過ぎた `pending` / `running` の作品の行と推敲ジョブの行を `failed` に畳む。
 *
 * **D1 の文は 2 本（batch 1 つ）である。**
 *
 * @param env バインディング（D1 だけ）
 * @param now 判定時刻（UNIX 秒）
 * @returns 畳んだ行の数
 */
export async function sweepStaleGenerations(env: StaleSweepEnv, now: number): Promise<StaleSweepResult> {
  const cutoff = now - STALE_GENERATION_SWEEP_SECONDS;
  const [games, jobs] = await env.DB.batch([
    env.DB.prepare(SWEEP_GAMES_SQL).bind(STALE_SWEEP_ERROR_CODE, cutoff, STALE_SWEEP_BATCH_LIMIT),
    env.DB.prepare(SWEEP_REVISION_JOBS_SQL).bind(STALE_SWEEP_ERROR_CODE, cutoff, STALE_SWEEP_BATCH_LIMIT),
  ]);
  return {
    games: games?.meta.changes ?? 0,
    revisionJobs: jobs?.meta.changes ?? 0,
  };
}
