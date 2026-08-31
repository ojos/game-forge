/**
 * 推敲（自作 draft の作り直し）の版と、そのジョブ（5.7 / 確定28 / #192）。
 *
 * ## この経路が無かったあいだ何が起きていたか
 *
 * 5.4 は「コンパイルは通るがゲームとして成立していない」ことを機械判定できないとして、
 * **作者を唯一のフィルタ**に据えた。ところが作者へ渡してあったのは「公開する / しない」
 * の 2 値だけで、**直す手段が無かった。落とすしかないフィルタは、運が悪ければ何も
 * 通さない。** 1 回の生成は 90 秒・約 16 円かかるので（1.2.38 / 4.2）、「気に入らなければ
 * もう 1 本作ればよい」も成立しない。ここがその手当てである。
 *
 * ## `games` の状態機械を触らない
 *
 * **推敲中も `games` は `status='draft'` / `generation_state='ready'` のままである。**
 * 走っているジョブは `game_revision_jobs` が持ち、成果物が差し替わるのは完成した
 * 瞬間だけになる。理由は `migrations/0009_game_revisions.sql` にある——相乗りすると
 * **推敲が失敗した瞬間に、完成していた作品が `failed` になる。**
 *
 * その帰結として、**作者は推敲を待つあいだ現行版を遊び続けられる**（`preview_key` が
 * 生きている）。5.7 の「押したら作り直しが始まり、**完成したら差し替わる**」は
 * この形を指している。
 *
 * ## 守るものは、ぜんぶ SQL の条件に置く
 *
 * | 守るもの | どこで守るか |
 * |---|---|
 * | 作者本人だけが推敲できる | {@link claimRevisionSlot} の `author_id = ?` |
 * | 公開済みは推敲できない（5.7） | 同 `status = 'draft'` |
 * | 完成していない作品は推敲できない | 同 `generation_state = 'ready'` |
 * | 1 作品あたりの上限（5.7） | 同 `revise_count < ?` |
 * | 同時に走る推敲は 1 本 | `game_revision_jobs.game_id` が主キー＋ UPSERT の `where state = 'failed'` |
 * | 戻す操作は費用を出さない | この経路が LLM も台帳も呼ばないこと（{@link restoreRevision}） |
 *
 * **呼び出し側の `if` で守る形にしない**（`src/publish.ts` と同じ判断）。経路を足した人が
 * 書き忘れても、動作では気づけない。
 */
import { createPreviewKey } from './games.js';
import { REVISIONS_PER_GAME } from './quota.js';

/** 推敲ジョブの状態。**成功は状態を持たない**——行が消える（0009）。 */
export type RevisionJobState = 'pending' | 'running' | 'failed';

/** 版 1 つ。**表示にも復元にも同じ形を使う。** */
export interface Revision {
  /** 1 から始まる版の番号。 */
  readonly seq: number;
  /** その版を作った差分プロンプト。**`seq === 1`（初回生成）は null**（0009）。 */
  readonly prompt: string | null;
  /** 作成時刻（UNIX 秒）。 */
  readonly createdAt: number;
  /** いま `games` 行が指している版か。 */
  readonly current: boolean;
}

/** 版が指す成果物（`games` へ書き戻す 3 点）。 */
export interface RevisionArtifacts {
  readonly goVersion: string;
  readonly sourceKey: string;
  readonly wasmKey: string;
}

/**
 * 版を 1 つ積む文（`insert`）。
 *
 * **`seq` は表の中で採る。** 呼び出し側が数えてから入れる形にすると、その隙間に
 * もう 1 本が入ったときに同じ番号を採る。`coalesce(max(seq), 0) + 1` を同じ文の中で
 * 評価すれば、主キーの一意制約が最後の関門として効く。
 *
 * @param gameId 対象の作品 id
 * @param artifacts その版の成果物
 * @param prompt 差分プロンプト（初回生成は null）
 * @param now 作成時刻（UNIX 秒）
 * @returns バインド済みの文を作るための引数一式
 */
function appendRevisionArgs(
  gameId: string,
  artifacts: RevisionArtifacts,
  prompt: string | null,
  now: number,
): readonly [string, readonly unknown[]] {
  return [
    `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
     select ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?
       from game_revisions where game_id = ?`,
    [gameId, artifacts.sourceKey, artifacts.wasmKey, artifacts.goVersion, prompt, now, gameId],
  ];
}

/**
 * 版を 1 つ積む（5.7 の「完成のたびに版を 1 つ積む」）。
 *
 * **初回生成もここを通る。** `seq = 1` が最初の生成で、`prompt` は null になる
 * （0009）。ここを推敲だけの表にすると「最初の状態へ戻す」が表現できない。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param artifacts その版の成果物
 * @param prompt 差分プロンプト（初回生成は null）
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 */
export async function appendRevision(
  env: Env,
  gameId: string,
  artifacts: RevisionArtifacts,
  prompt: string | null,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const [sql, values] = appendRevisionArgs(gameId, artifacts, prompt, now);
  await env.DB.prepare(sql)
    .bind(...values)
    .run();
}

/**
 * 版の一覧を新しい順で返す（5.7）。
 *
 * **`current` は `games` との突き合わせで決める。** 「いちばん新しい版が現行」とは
 * 限らない——{@link restoreRevision} で古い版へ戻したあとは、現行はその古い版である。
 * 別の列で「現行フラグ」を持つ形は採らない（`games` から導出でき、二重に持つと
 * 静かにずれる。確定26 が参照カウント列を持たないと決めたのと同じ線）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @returns 新しい順の版
 */
export async function listRevisions(env: Env, gameId: string): Promise<readonly Revision[]> {
  const { results } = await env.DB.prepare(
    `select r.seq as seq, r.prompt as prompt, r.created_at as created_at,
            case when g.source_key = r.source_key and g.wasm_key = r.wasm_key
                  and g.go_version = r.go_version then 1 else 0 end as current
       from game_revisions r join games g on g.id = r.game_id
      where r.game_id = ?
      order by r.seq desc`,
  )
    .bind(gameId)
    .all<{ seq: number; prompt: string | null; created_at: number; current: number }>();

  return results.map((row) => ({
    seq: row.seq,
    prompt: row.prompt,
    createdAt: row.created_at,
    current: row.current === 1,
  }));
}

/** 推敲の枠の残り（5.7 / 4.4 の表示に使う）。 */
export interface RevisionStatus {
  /** これまでに走らせた推敲の回数（失敗を含む）。 */
  readonly used: number;
  /** あと何回できるか。 */
  readonly remaining: number;
  /** いま推敲が走っているか。走っていれば新しくは始められない。 */
  readonly running: boolean;
  /** 直前の推敲が失敗していれば、その分類名。 */
  readonly failed: string | null;
}

/**
 * 推敲の枠と、走っているジョブの有無を返す。
 *
 * **判定（{@link claimRevisionSlot}）と同じ値から導く。** 画面が別の数え方をすると、
 * 表示の残数と経路の判断が割れる（`src/quota.ts` が `generationQuotaStatus` と
 * `checkGenerationQuota` を同じ状態から導いているのと同じ理由）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @returns 枠の状態（作品が無ければ used = 0 / remaining = 0）
 */
export async function revisionStatus(env: Env, gameId: string): Promise<RevisionStatus> {
  const row = await env.DB.prepare(
    `select g.revise_count as used, j.state as state, j.error as error
       from games g left join game_revision_jobs j on j.game_id = g.id
      where g.id = ?`,
  )
    .bind(gameId)
    .first<{ used: number; state: string | null; error: string | null }>();

  if (row === null) {
    return { used: 0, remaining: 0, running: false, failed: null };
  }

  const running = row.state === 'pending' || row.state === 'running';
  return {
    used: row.used,
    remaining: Math.max(0, REVISIONS_PER_GAME - row.used),
    running,
    failed: row.state === 'failed' ? row.error : null,
  };
}

/**
 * 推敲の枠を 1 つ取り、ジョブ行を作る（5.7）。
 *
 * **ここが「推敲してよいか」を決める唯一の場所である。** 5.7 の対象条件（自作・
 * `draft`・完成済み）と上限を、**すべて SQL の条件として**同時に評価する。
 *
 * # 2 文を 1 つの batch で走らせる
 *
 * D1 の `batch` は暗黙のトランザクションで走る。**分けると、枠だけ減ってジョブが
 * 立たない状態が作れる**（1 文目が通り 2 文目が落ちる）。
 *
 * 1 文目（ジョブ行の UPSERT）が 5.7 の条件をすべて持ち、`insert ... select ... from games
 * where ...` の形で**条件を満たす作品が無ければ 1 行も入らない。** 2 文目の枠の加算は
 * **いま入れたトークンが在ることを条件にする**ので、1 文目が空振りすれば加算もされない。
 * トークンは使い捨ての乱数なので、他のジョブの行に当たることはない。
 *
 * # 走っている推敲があれば断る
 *
 * `game_id` が主キーなので 2 本目は衝突する。**`state = 'failed'` のときだけ上書きする**
 * ので、走っている最中の要求は 0 行で返る。失敗した行は次の推敲が引き取る。
 *
 * # 版が 1 つも無ければ、いまの成果物を `seq = 1` として先に積む（#202）
 *
 * **これが無いと、本番で元の版が消えた。** #192 より前に完成した作品は
 * `appendRevision` を通っていないので版を 1 つも持たない。そこへ推敲が走ると
 * `coalesce(max(seq), 0) + 1` が 1 を採り、{@link completeRevision} が `games` の
 * 成果物を上書きする。**元の版はどこにも残らない。**
 *
 * 帰結は 2 つあった（2026-08-31 に本番で 2 件観測）。
 *
 * 1. **5.7 の「任意の版へ戻せる」が成立しない。** 版が 1 つでは一覧すら出ない
 * 2. **確定26 の掃除（M5-4 / #35）が、元の成果物を「参照ゼロ」と正しく判定して消す**
 *
 * **初回完成の経路（`src/generate-callback.ts`）は変えない。** これから生まれる作品は
 * そちらで `seq = 1` を得ており、ここが足すのは**その経路を通っていない行への保険**である。
 * 積むのは推敲を始める直前——**上書きされる前の最後の瞬間**である。
 *
 * `created_at` には `games.created_at` を使う。**完成した時刻は `games` に無い**
 * （`generation_started_at` はあるが、完成時刻を持つ列は無い）。版の並びは `seq` が
 * 決めるので（0009）、時刻がずれても順序は壊れない。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param userId 要求した利用者（作者本人でなければ通らない）
 * @param prompt 差分プロンプト（完成時に版へ書き写す）
 * @param jobTokenHash ジョブトークンのハッシュ
 * @param now 作成時刻（UNIX 秒。既定は現在時刻）
 * @returns 枠を取れたら true
 */
export async function claimRevisionSlot(
  env: Env,
  gameId: string,
  userId: string,
  prompt: string,
  jobTokenHash: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const [, claim] = await env.DB.batch([
    // **枠を取るより先に積む。** 同じ batch なので、枠が取れなければこの行も残らない
    // （D1 の `batch` は暗黙のトランザクションで走る）。
    //
    // **条件は下の UPSERT とそろえてある。** そろえないと、断られた要求で版だけが
    // 積まれる経路ができる。`source_key` / `wasm_key` の非 NULL を足しているのは、
    // `generation_state = 'ready'` なら入っているはずの値に**寄りかからない**ためである
    // （0007 の不変条件を画面が前提にしないのと同じ線）。
    env.DB.prepare(
      `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
       select g.id, 1, g.source_key, g.wasm_key, g.go_version, null, g.created_at
         from games g
        where g.id = ? and g.author_id = ? and g.status = 'draft'
          and g.generation_state = 'ready' and g.revise_count < ?
          and g.source_key is not null and g.wasm_key is not null
          and not exists (select 1 from game_revisions r where r.game_id = g.id)`,
    ).bind(gameId, userId, REVISIONS_PER_GAME),
    env.DB.prepare(
      `insert into game_revision_jobs (game_id, job_token_hash, prompt, state, error, started_at, created_at)
       select g.id, ?, ?, 'pending', null, null, ?
         from games g
        where g.id = ? and g.author_id = ? and g.status = 'draft'
          and g.generation_state = 'ready' and g.revise_count < ?
       on conflict(game_id) do update
          set job_token_hash = excluded.job_token_hash,
              prompt = excluded.prompt,
              state = 'pending', error = null, started_at = null,
              created_at = excluded.created_at
        where game_revision_jobs.state = 'failed'`,
    ).bind(jobTokenHash, prompt, now, gameId, userId, REVISIONS_PER_GAME),
    env.DB.prepare(
      `update games set revise_count = revise_count + 1
        where id = ?
          and exists (select 1 from game_revision_jobs j
                       where j.game_id = games.id and j.job_token_hash = ? and j.state = 'pending')`,
    ).bind(gameId, jobTokenHash),
  ]);

  return ((claim as D1Result).meta.changes ?? 0) > 0;
}

/**
 * 推敲のジョブを握る（`pending → running`）。
 *
 * `claimGenerationJob`（`src/games.ts`）と同じ形で、**存在検査と排他を 1 回の往復で
 * 行う。** 先に select してから update する形にすると、その隙間で 2 通目が通りうる。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param jobTokenHash ジョブトークンのハッシュ
 * @param now 開始時刻（UNIX 秒。既定は現在時刻）
 * @returns 握れたら true
 */
export async function claimRevisionJob(
  env: Env,
  gameId: string,
  jobTokenHash: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update game_revision_jobs set state = 'running', started_at = ?
      where game_id = ? and state = 'pending' and job_token_hash = ?`,
  )
    .bind(now, gameId, jobTokenHash)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * 推敲が完成した（5.7 の「完成したら差し替わる」）。
 *
 * **3 つを 1 つの batch で行う。**
 *
 * 1. 版を積む（{@link appendRevision} と同じ文）
 * 2. `games` の成果物を差し替え、**新しい `preview_key` を引く**
 * 3. ジョブ行を消す（成功の記録は版が持つ。0009）
 *
 * **`preview_key` を引き直す理由は 5.4 と同じである。** 版が変われば配る URL も別で
 * なければならない——片方を止めたときにもう片方まで止まる形を作らない。
 *
 * **`generation_state` は触らない。** ここへ来る行は `ready` のままであり、
 * 0007 の不変条件は動かない（モジュール冒頭）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param jobTokenHash ジョブトークンのハッシュ
 * @param artifacts 新しい成果物
 * @param now 完成時刻（UNIX 秒。既定は現在時刻）
 * @returns 差し替えられたら true（握られていなければ false）
 */
export async function completeRevision(
  env: Env,
  gameId: string,
  jobTokenHash: string,
  artifacts: RevisionArtifacts,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const job = await env.DB.prepare(
    `select prompt from game_revision_jobs
      where game_id = ? and state = 'running' and job_token_hash = ?`,
  )
    .bind(gameId, jobTokenHash)
    .first<{ prompt: string }>();

  if (job === null) {
    return false;
  }

  const [sql, values] = appendRevisionArgs(gameId, artifacts, job.prompt, now);
  const [, swapped] = await env.DB.batch([
    env.DB.prepare(sql).bind(...values),
    env.DB.prepare(
      `update games set go_version = ?, source_key = ?, wasm_key = ?, preview_key = ?
        where id = ?`,
    ).bind(artifacts.goVersion, artifacts.sourceKey, artifacts.wasmKey, createPreviewKey(), gameId),
    env.DB.prepare(
      `delete from game_revision_jobs where game_id = ? and job_token_hash = ?`,
    ).bind(gameId, jobTokenHash),
  ]);

  return ((swapped as D1Result).meta.changes ?? 0) > 0;
}

/**
 * 推敲が失敗した。**作品には触らない。**
 *
 * 5.3 が 30KB の整理パスについて「コンパイルに失敗しても元のソースへ戻して拒否する」
 * と定めているのと同じ扱いである。**失敗の記録はジョブ行にだけ残り、作品は無傷のまま。**
 *
 * **枠は戻さない。** 5.7 の上限は推敲という行為にかかっており、失敗した推敲でも
 * 費用は出ている（確定25 が「リトライは含む」としているのと同じ線。0009）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param code 失敗の分類名（8.3 の固定語彙）
 * @returns 記録できたら true
 */
export async function failRevision(env: Env, gameId: string, code: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `update game_revision_jobs set state = 'failed', error = ?
      where game_id = ? and state in ('pending', 'running')`,
  )
    .bind(code, gameId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * 取った枠を返す（起動前に確定的に失敗したとき）。
 *
 * **確定28 が失敗した推敲を回数に数える根拠は「費用は出ている」ことである。**
 * LLM を 1 度も呼んでいない失敗には、その根拠が当てはまらない。**呼ぶ前に確定的に
 * 失敗する経路（元のソースが読めない・大きすぎる）で枠を食うと、作者は 1 回も
 * 生成させないまま上限へ達する。**
 *
 * **「失敗を繰り返して上限を迂回できる」にはならない。** 迂回して得られるのは
 * 費用の出る生成の回数だが、ここで返すのは**費用が 1 円も出ていない試行**である。
 *
 * **起動を試みたあとには使わない。** 非同期呼び出しは、こちらがエラーとして受け取っても
 * 相手が走り出している可能性を否定できない。走っているジョブの枠を返すと、
 * 完成したときに回数が 1 つ足りない状態になる。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param jobTokenHash 返す枠を取ったときのトークンのハッシュ
 * @returns 返せたら true
 */
export async function releaseRevisionSlot(
  env: Env,
  gameId: string,
  jobTokenHash: string,
): Promise<boolean> {
  const [released] = await env.DB.batch([
    env.DB.prepare(
      `delete from game_revision_jobs
        where game_id = ? and job_token_hash = ? and state = 'pending'`,
    ).bind(gameId, jobTokenHash),
    env.DB.prepare(
      `update games set revise_count = max(0, revise_count - 1)
        where id = ?
          and not exists (select 1 from game_revision_jobs j where j.game_id = games.id)`,
    ).bind(gameId),
  ]);
  return ((released as D1Result).meta.changes ?? 0) > 0;
}

/** 復元の結果。**「見つからない」と「他人の作品」を区別しない**（`src/games.ts` と同じ）。 */
export type RestoreOutcome = 'restored' | 'not-found' | 'busy';

/**
 * 指定の版へ戻す（5.7）。
 *
 * **LLM を呼ばない。** したがって費用台帳の行を作らず、日次クォータも
 * `revise_count` も動かさない——4.2 の 1 段目（費用ゼロの機械修正）と同じ層である。
 * 動かすのは `games` の成果物 3 点と `preview_key` だけで、**版は 1 つも消えない**
 * （戻したあとにまた新しい版へ戻せる）。
 *
 * **推敲が走っている最中は断る。** 走っているジョブが完成すると成果物を差し替える
 * ので、その手前で戻しても**90 秒後に黙って上書きされる。** 作者から見れば
 * 「戻したのに戻っていない」であり、それは戻せないより悪い。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param userId 要求した利用者（作者本人でなければ通らない）
 * @param seq 戻したい版の番号
 * @returns 復元の結果
 */
export async function restoreRevision(
  env: Env,
  gameId: string,
  userId: string,
  seq: number,
): Promise<RestoreOutcome> {
  const busy = await env.DB.prepare(
    `select 1 as running from game_revision_jobs
      where game_id = ? and state in ('pending', 'running')`,
  )
    .bind(gameId)
    .first<{ running: number }>();

  if (busy !== null) {
    return 'busy';
  }

  const result = await env.DB.prepare(
    `update games
        set go_version = (select r.go_version from game_revisions r
                           where r.game_id = games.id and r.seq = ?),
            source_key = (select r.source_key from game_revisions r
                           where r.game_id = games.id and r.seq = ?),
            wasm_key = (select r.wasm_key from game_revisions r
                          where r.game_id = games.id and r.seq = ?),
            preview_key = ?
      where id = ? and author_id = ? and status = 'draft' and generation_state = 'ready'
        and exists (select 1 from game_revisions r where r.game_id = games.id and r.seq = ?)`,
  )
    .bind(seq, seq, seq, createPreviewKey(), gameId, userId, seq)
    .run();

  return (result.meta.changes ?? 0) > 0 ? 'restored' : 'not-found';
}
