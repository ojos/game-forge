/**
 * 退会の**後続の処理**（仕様 3.7 / 5.8 / #518 / M15-3。土台は #586 / M15-3a）。
 *
 * 退会した利用者の作品を、`src/game-deletion.ts` の {@link deleteGame} で 1 件ずつ最後まで消し、
 * 全部消え終わったら `users.withdrawal_completed_at` を立てる。**アラーム 1 回ぶんの仕事**を
 * {@link runWithdrawalPurgeStep} が持ち、起こすのは `game-forge-cleanup` の Durable Object
 * （`workers/cleanup/src/hub.ts`）である。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜ押した要求の中で終わらせないのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`deleteGame` は 1 件あたり 14 文である**（`src/game-deletion.ts`）。Workers Free の D1 は
 * **1 呼び出し 50 クエリ**なので、要求の中で消せるのは 2〜3 件にすぎない。作品が 60 本ある
 * 利用者を要求の中で消し切ることはできず、途中で落ちれば「どこまで消したか」を知る者もいない。
 *
 * **だから状態の正本を D1 だけに置く。** 「退会済みで未完了の利用者の、中身を消していない作品」は
 * いつでも D1 から引き直せる（`users_withdrawal_pending_idx` と `games.purged_at`）。
 * **Durable Object が持つのは待ち（{@link PurgeBackoff}）だけ**で、それは目安である——
 * 消えても、次のアラームが最初から候補を拾い直す。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * アラーム 1 回の中身（6 段）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. **止まった要求の代打。** 掴んだまま {@link WITHDRAWAL_TAKEOVER_SECONDS} たった処理中の行が
 *    あれば、`withdrawUser` を代わりに打って**この回は終える**（段1〜3 だけで 15 文を超えうる）
 * 2. **取り下げの打ち直し。** 退会済みで未完了の利用者に公開中の作品が残っていれば取り下げる
 *    （段3 の 10 番目と同じ。**確定の直後に公開の途中だった行**を拾う）
 * 3. **候補を引く**（中身を消していない・公開中でない・進行中でない）。{@link CANDIDATE_LIMIT} 件
 * 4. **{@link GAMES_PER_STEP} 件だけ `deleteGame` を呼ぶ**（待ち中の作品は飛ばす）
 * 5. **残りの作品が 0 件の利用者を 1 人だけ完了させる**（アイコンを消し直し、R2 の接頭辞が空だと
 *    確かめ、台帳の指示文を打ち直し、`withdrawal_completed_at` を立てる）
 * 6. **次のアラームを決める**（進んだら {@link PROGRESS_DELAY_MS}、待ちだけなら
 *    {@link BACKOFF_DELAY_MS}、何も無ければ立てない）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * D1 の文を数える
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **残りが {@link DELETE_RESERVE} 文を切ったら、新しい作品を取らない。** `deleteGame` の 14 文は
 * 「戻す索引」の数だけ増えうる（`deleteUnreferencedArtifacts`）ので、**ちょうどで詰めない。**
 * 数えるのはこのモジュールで、`deleteGame` の側は自分の本数を知らせない——本数を返させると、
 * 呼び出し側がそれに合わせて振る舞う結合ができ、削除の実装を変えるたびにこちらが壊れる。
 *
 * 1 回のアラームの実測（`test/withdrawal-purge.test.ts` が数える）は、**代打が無い平常時で
 * 概ね 34 文**である（2 + 1 + 14 × 2 + 1 + 2）。枠の 50 に対して 16 文の余裕がある。
 */
import type { StorageEnv } from './build-cache.js';
import { deleteGame } from './game-deletion.js';
import { PUBLISHED_STATUS, REMOVED_STATUS } from './games.js';
import { avatarObjectsGone, purgeAvatarObjects, withdrawUser } from './withdrawal.js';

/**
 * 掴んだままこの秒数（**10 分**）たった処理中の退会を、後続の処理が代わりに打つ。
 *
 * **押した利用者が確定の前に閉じてしまった要求**を拾うための値である。短すぎると、まだ走って
 * いる要求と二重に走る（段1 の排他と G が防ぐが、R2 を 2 回消しに行く無駄が出る）。長すぎると、
 * 匿名化されないまま「退会処理中」で止まる時間が延びる。**Worker の CPU の上限（数十秒）と
 * アイコンの排他（60 秒）のどちらよりも十分に長く**、人が異変に気づく前の長さとして 10 分を採る。
 */
export const WITHDRAWAL_TAKEOVER_SECONDS = 600;

/**
 * アラーム 1 回で `deleteGame` を呼ぶ件数（**2 件**）。
 *
 * **D1 の枠（1 呼び出し 50 クエリ）から決めた値である**（14 文 × 2 + 前後の 5 文 = 33 文）。
 * 3 件にすると 47 文で、`deleteUnreferencedArtifacts` が索引を戻す分（1 件あたり最大 2 文）で
 * 超えうる。**Workers Free の CPU 時間で 2 件が収まらなければ 1 件へ落とす**——判断の材料は
 * `test/withdrawal-purge.test.ts` が測る所要時間で、PR に実測値を書く（#586 の acceptance）。
 *
 * 60 件の利用者は 30 回のアラームで終わる。進んだ回は 1 秒後に次を立てるので、**約 1 分**である。
 */
export const GAMES_PER_STEP = 2;

/**
 * 1 回のアラームで引く候補の数（**10 件**）。
 *
 * **{@link GAMES_PER_STEP} より多く引く。** 待ち（{@link PurgeBackoff}）に入っている作品を飛ばして
 * なお 2 件を取れるようにするためで、**候補を引き直す 2 往復目を作らない**。
 */
export const CANDIDATE_LIMIT = 10;

/** D1 の 1 呼び出しあたりのクエリ数の上限（Workers Free。仕様 3.6）。 */
export const D1_QUERY_LIMIT = 50;

/**
 * `deleteGame` 1 件のために空けておく文の数（**20 文**）。
 *
 * 実測は 14 文だが、`deleteUnreferencedArtifacts` が落とした索引を戻す分だけ増える。
 * **余裕を持って予約する**——足りないまま呼ぶと、削除の途中で D1 が断り、R2 だけが消えた
 * 作品が残る（打ち直せば続きからやれるが、無駄な往復である）。
 */
export const DELETE_RESERVE = 20;

/** 進んだときに次のアラームを立てるまでの時間（**1 秒**）。 */
export const PROGRESS_DELAY_MS = 1_000;

/** 待ちだけが残っているときに次のアラームを立てるまでの時間（**30 分**）。 */
export const BACKOFF_DELAY_MS = 30 * 60 * 1_000;

/**
 * 失敗した作品を待たせる帳面（**目安であって正本ではない**）。
 *
 * **Durable Object のメモリに置く**（`workers/cleanup/src/hub.ts`）。消えても害は無い——
 * 次のアラームが同じ候補を拾い直し、同じ理由で失敗すれば、また待ちに入るだけである。
 * **D1 へ書かない**のは、失敗の回数という「進み方の都合」を状態の正本に混ぜないためで、
 * 混ぜると、運営が D1 を見て退会の進み具合を判断できなくなる。
 */
export interface PurgeBackoff {
  /**
   * その作品をいま取ってよいか。
   *
   * @param gameId 作品 id
   * @param now 時刻（UNIX 秒）
   * @returns 取ってよければ true
   */
  ready(gameId: string, now: number): boolean;
  /**
   * 失敗を 1 回積む（次に取れる時刻が指数的に遠くなる）。
   *
   * @param gameId 作品 id
   * @param now 時刻（UNIX 秒）
   */
  fail(gameId: string, now: number): void;
  /**
   * 成功したので忘れる。
   *
   * @param gameId 作品 id
   */
  clear(gameId: string): void;
}

/** アラーム 1 回の結果（**次のアラームを決めるのは呼び出し側**）。 */
export interface PurgeStepResult {
  /** 代わりに打った退会の要求の数（0 か 1）。 */
  readonly tookOver: number;
  /** 消した（または消そうとした）作品の数。 */
  readonly deleted: number;
  /** 完了させた利用者の数（0 か 1）。 */
  readonly completed: number;
  /** この回で使った D1 の文の数（**見積もり**。枠の 50 と比べるための値）。 */
  readonly statements: number;
  /**
   * 次のアラームまでの時間（ミリ秒）。**`null` は「立てない」。**
   *
   * - 進んだ … {@link PROGRESS_DELAY_MS}
   * - 待ちだけが残っている … {@link BACKOFF_DELAY_MS}
   * - 終わっていない退会がもう無い … `null`
   */
  readonly nextDelayMs: number | null;
}

/**
 * アラーム 1 回ぶんの仕事をする。
 *
 * **投げない設計にはしない。** R2 や D1 が落ちたらそのまま投げ、アラームの再試行に任せる
 * （Durable Object のアラームは失敗すると自動で再試行される）。**個々の作品の削除の失敗だけ**は
 * 待ちに積んで先へ進む——1 本の壊れた作品が、残り 59 本の削除を永久に止めないようにする。
 *
 * @param env D1 と R2
 * @param backoff 失敗した作品の待ちの帳面
 * @param now 時刻（UNIX 秒。既定は現在時刻）
 * @returns この回の結果と、次のアラームまでの時間
 * @throws D1 と R2 の失敗（アラームの再試行に任せる）
 */
export async function runWithdrawalPurgeStep(
  env: StorageEnv,
  backoff: PurgeBackoff,
  now: number = Math.floor(Date.now() / 1000),
): Promise<PurgeStepResult> {
  // ── 1. 止まった要求の代打 ────────────────────────────────────────────────
  //
  // **索引の述語をそのまま書く**（`users_withdrawal_pending_idx` は
  // `withdrawal_started_at is not null and withdrawal_completed_at is null`）。`withdrawn_at is null`
  // なら CHECK により完了も NULL だが、**SQLite は CHECK から含意を導かない**ので、書かないと
  // 部分索引に当たらず `users` を全走査する（PR #588 の Copilot の指摘）。
  const stalled = await env.DB.prepare(
    `select id from users
      where withdrawal_started_at is not null and withdrawal_completed_at is null
        and withdrawn_at is null
        and withdrawal_started_at <= ?
      limit 1`,
  )
    .bind(now - WITHDRAWAL_TAKEOVER_SECONDS)
    .first<{ id: string }>();
  if (stalled !== null) {
    // **この回はこれで終える。** 段1〜3 だけで 15 文を超え、削除まで走ると枠に収まらない。
    const outcome = await withdrawUser(env, stalled.id, now);
    if (outcome.ok) {
      return { tookOver: 1, deleted: 0, completed: 0, statements: 16, nextDelayMs: PROGRESS_DELAY_MS };
    }
    // **進まなかったら、短い間隔で戻ってこない。** 掴めない理由（BAN・管理者に昇格した・
    // アイコンの排他が生きている）は次の 1 秒では消えないので、**同じ行を 1 秒ごとに引き続ける
    // 形になる**（PR #588 の Copilot の指摘）。通常の待ちへ落とし、理由を残す。
    console.warn(`[withdrawal] 止まった退会を代打できませんでした: ${outcome.reason}`);
    return { tookOver: 0, deleted: 0, completed: 0, statements: 16, nextDelayMs: BACKOFF_DELAY_MS };
  }
  let statements = 1;

  // ── 2. 取り下げの打ち直し ────────────────────────────────────────────────
  //
  // **確定の直後に公開が通った行**を拾う（段3 の 10 番目が数え終えた後に `publishGame` が
  // 当たる窓が、ログインの停止（#518）が入るまでは残る）。**0 行でも 1 文である。**
  //
  // 副問い合わせの条件も、上と同じ理由で**索引の述語をそのまま書く**。
  await env.DB.batch([
    env.DB.prepare(
      `update games set status = ?
        where status = ?
          and author_id in (select id from users
                             where withdrawal_started_at is not null
                               and withdrawal_completed_at is null
                               and withdrawn_at is not null)`,
    ).bind(REMOVED_STATUS, PUBLISHED_STATUS),
    env.DB.prepare(
      `update games
          set fork_count = (select count(*) from games c
                             where c.parent_id = games.id and c.status = ?)
        where id in (select parent_id from games g
                       join users u on u.id = g.author_id
                      where u.withdrawal_started_at is not null
                        and u.withdrawal_completed_at is null
                        and u.withdrawn_at is not null
                        and g.parent_id is not null)`,
    ).bind(PUBLISHED_STATUS),
  ]);
  statements += 2;

  // ── 3〜4. 候補を引いて消す ───────────────────────────────────────────────
  //
  // **{@link GAMES_PER_STEP} 件が見つかるまで、続きを引く。** 1 回引いて終えると、**先頭の
  // {@link CANDIDATE_LIMIT} 件がすべて待ち中のとき、その後ろの健全な作品が永久に選ばれない**
  // （待ちは指数的に延びるので、いつまでも先頭に居座る。PR #588 の Copilot の指摘）。
  //
  // **続きは id のキーセットで辿る**（`offset` にしない）。取ったそばから行が消えるので、
  // `offset` では消えたぶんだけ後ろの行を飛ばす。
  //
  // **条件は `claimDeletion`（`src/game-deletion.ts`）とそろえてある。** そろえないと、
  // 掴めない作品を毎回引いては待ちに積むだけの回ができる。
  const candidateSql = `select g.id as id from games g
       join users u on u.id = g.author_id
      where u.withdrawal_started_at is not null and u.withdrawal_completed_at is null
        and u.withdrawn_at is not null
        and g.purged_at is null
        and g.status <> ?
        and g.generation_state in ('ready', 'failed')
        and g.id > ?
        and not exists (select 1 from game_revision_jobs j
                         where j.game_id = g.id and j.state in ('pending', 'running'))
      order by g.id
      limit ?`;

  let deleted = 0;
  let attempted = 0;
  let waiting = false;
  let after = '';
  let exhausted = false;
  while (attempted < GAMES_PER_STEP && !exhausted) {
    // **1 文の予算を、候補の取得ぶんも含めて見る。** 残りが `deleteGame` 1 件ぶんに足りなければ、
    // 引くだけ引いて消せない回になる。
    if (D1_QUERY_LIMIT - statements < DELETE_RESERVE + 1) {
      waiting = true;
      break;
    }
    const { results: candidates } = await env.DB.prepare(candidateSql)
      .bind(PUBLISHED_STATUS, after, CANDIDATE_LIMIT)
      .all<{ id: string }>();
    statements += 1;
    if (candidates.length < CANDIDATE_LIMIT) {
      // **これで全部である**（次の頁は無い）。
      exhausted = true;
    }
    if (candidates.length === 0) {
      break;
    }
    after = candidates[candidates.length - 1]!.id;

    for (const candidate of candidates) {
      if (attempted >= GAMES_PER_STEP) {
        // 取らなかった候補は次の回に回る。
        waiting = true;
        break;
      }
      if (D1_QUERY_LIMIT - statements < DELETE_RESERVE) {
        waiting = true;
        break;
      }
      if (!backoff.ready(candidate.id, now)) {
        waiting = true;
        continue;
      }
      attempted += 1;
      statements += DELETE_RESERVE;
      try {
        const outcome = await deleteGame(env, candidate.id, now);
        if (outcome.ok) {
          backoff.clear(candidate.id);
          deleted += 1;
        } else {
          // `published` / `busy` は次の回に打ち直す（**待ちには積まない**——状態が動いただけで、
          // 壊れてはいない）。
          waiting = true;
        }
      } catch (error) {
        // **理由だけを残す。** 作品 id はログに出さない（`src/session-user.ts` と同じ規律）。
        console.error(`[withdrawal] 作品を消せませんでした: ${error instanceof Error ? error.name : 'unknown'}`);
        backoff.fail(candidate.id, now);
        waiting = true;
      }
    }
  }

  // ── 5. 完了 ─────────────────────────────────────────────────────────────
  const completed = await completeOneWithdrawal(env, now, () => {
    statements += 1;
  });

  // ── 6. 次のアラーム ─────────────────────────────────────────────────────
  //
  // **「何も無ければ立てない」を最後に確かめる。** 立てっぱなしにすると、退会が 1 件も無い
  // 平常時にも DO が 30 分おきに起きる（cron が 5 分ごとに起こすので、立てる意味が無い）。
  const progressed = deleted > 0 || completed > 0;
  let nextDelayMs: number | null;
  if (progressed) {
    nextDelayMs = PROGRESS_DELAY_MS;
  } else if (waiting) {
    nextDelayMs = BACKOFF_DELAY_MS;
  } else {
    statements += 1;
    nextDelayMs = (await hasUnfinishedWithdrawal(env.DB)) ? BACKOFF_DELAY_MS : null;
  }

  return { tookOver: 0, deleted, completed, statements, nextDelayMs };
}

/**
 * 残りの作品が 0 件の利用者を**1 人だけ**完了させる。
 *
 * **1 回のアラームで 1 人にする。** 完了の段は R2 の一覧（Class A の操作）を含むので、
 * まとめて回すと 1 回のアラームの重さが利用者の数に比例する。
 *
 * **確かめてから立てる。**
 *
 * 1. アイコンを消し直す（段2 が落ちた回の取りこぼしと、確定の後に届いた保存を拾う）
 * 2. **R2 の接頭辞が空だと確かめる**（空でなければ立てない。次のアラームがやり直す）
 * 3. 台帳の指示文を打ち直す（`withdrawUser` の 9 番目が当たらなかった行のため）
 * 4. `withdrawal_completed_at` を立てる
 *
 * **「確かめる」と「立てる」のあいだの窓は、D1 の側で閉じてある**（`0045` の
 * `users_skip_avatar_lock_for_withdrawal` / `users_skip_avatar_set_for_withdrawal`）。退会を
 * 始めた利用者に対しては**アイコンの排他そのものが取れない**ので、確かめた後に R2 へ書き始める
 * 要求が生まれない。**残る窓**（段1 より前に排他を取り、60 秒を過ぎてもまだ R2 を書いている
 * 要求）は `docs/cleanup-worker.md` の「確かめられていないこと」に書いてある。
 *
 * **印を立てる文にも、D1 から見える裏付けを置く**（`avatar_sha256 is null` と排他が空）。R2 の
 * 確認とは別の層で、同じことを言っている行だけを進める。
 *
 * @param env D1 と R2
 * @param now 時刻（UNIX 秒）
 * @param countStatement D1 の文を 1 つ使ったことを知らせる
 * @returns 完了させた人数（0 か 1）
 */
async function completeOneWithdrawal(
  env: StorageEnv,
  now: number,
  countStatement: () => void,
): Promise<number> {
  // **索引の述語をそのまま書く**（`withdrawn_at is not null` だけだと `users` を全走査しうる。
  // SQLite は CHECK から「掴んでいる」を導かない。PR #588 の Copilot の指摘）。
  const row = await env.DB.prepare(
    `select u.id as id from users u
      where u.withdrawal_started_at is not null and u.withdrawal_completed_at is null
        and u.withdrawn_at is not null
        and not exists (select 1 from games g where g.author_id = u.id and g.purged_at is null)
      limit 1`,
  ).first<{ id: string }>();
  countStatement();
  if (row === null) {
    return 0;
  }

  // **消す直前に毎回「まだ退会済みで未完了か」を確かめる**（`purgeAvatarObjects` の述語）。
  // 完了の印が立った後の利用者の R2 を、遅れて届いたアラームが消しに行かないようにする。
  let guardStatements = 0;
  const stillWithdrawing = async (): Promise<boolean> => {
    guardStatements += 1;
    const alive = await env.DB.prepare(
      `select 1 as alive from users
        where id = ? and withdrawal_started_at is not null
          and withdrawal_completed_at is null and withdrawn_at is not null`,
    )
      .bind(row.id)
      .first<{ alive: number }>();
    return alive !== null;
  };

  const purged = await purgeAvatarObjects(env, row.id, stillWithdrawing);
  for (let index = 0; index < guardStatements; index += 1) {
    countStatement();
  }
  if (!purged || !(await avatarObjectsGone(env, row.id))) {
    // **立てない。** 「R2 の接頭辞が空だった」ことがこの列の意味である（`0045`）。
    console.warn('[withdrawal] アイコンが R2 に残っているので、完了の印を立てません');
    return 0;
  }

  const results = await env.DB.batch([
    env.DB.prepare(
      `update generations set prompt = ''
        where user_id = ? and prompt <> ''
          and exists (select 1 from users
                       where id = ? and withdrawn_at is not null and withdrawal_completed_at is null)`,
    ).bind(row.id, row.id),
    // **`max` で確定の時刻より前にならないようにする**（`0045` の CHECK。
    // 押した要求と後続の処理は別の機械で、時計がずれると確定より前の完了を書きうる。
    // 投げると、アラームが同じ行でずっと落ち続ける形になる）。
    //
    // **`avatar_sha256 is null` と排他が空であることも見る。** R2 の確認とは別の層で、
    // 「この利用者はアイコンを持っていない」と D1 も言っていることを確かめる。
    env.DB.prepare(
      `update users set withdrawal_completed_at = max(?, withdrawn_at)
        where id = ? and withdrawn_at is not null and withdrawal_completed_at is null
          and avatar_sha256 is null and avatar_lock_token is null`,
    ).bind(now, row.id),
  ]);
  countStatement();
  countStatement();
  return (results[1]?.meta.changes ?? 0) > 0 ? 1 : 0;
}

/**
 * 終わっていない退会がまだあるか（**次のアラームを立てるかどうかだけに使う**）。
 *
 * **部分索引（`users_withdrawal_pending_idx`）の 1 行を引く。** 平常時は 0 行なので、
 * 5 分ごとの cron はこの 1 文と、上の 4 文だけで終わる。
 *
 * @param db D1
 * @returns 掴んだまま完了していない行があれば true
 */
async function hasUnfinishedWithdrawal(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `select id from users
        where withdrawal_started_at is not null and withdrawal_completed_at is null
        limit 1`,
    )
    .first<{ id: string }>();
  return row !== null;
}
