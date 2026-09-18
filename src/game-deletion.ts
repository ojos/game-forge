/**
 * 作品 1 件を消す（仕様 3.7 / 5.3 / #516 / M15-1）。
 *
 * **作者の下書き削除（#517 / M15-2）と退会（#518 / M15-3）の土台である。** この issue の
 * 時点では呼び出し元が無く、本番の挙動は変わらない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 行ごと消すか、行を残して中身だけ消すか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **行を残すのは、次のどちらかがあるときである。**
 *
 * 1. **子がいる**（`parent_id` がこの作品を指す行が、状態を問わず 1 件でもある）。5.3 の
 *    「親の削除は物理削除せず tombstone 化し、子は残す」をそのまま適用する——行が無いと子の
 *    外部キーが宙に浮き、子の作品ページが「削除済みの作品から派生」と言えなくなる。
 * 2. **運営の記録がある**（`reports`・`takedown_requests`・`admin_actions`（`target_kind = 'game'`）・
 *    `moderation_blocks` のどれかにこの作品の行がある）。8.4 は記録を残すことを求めており、
 *    記録が指す先の行を消すと、運営があとから何を判断したのかを辿れなくなる。
 *
 * どちらも無ければ**行ごと消す**（仕様 3.7 の規約 4: 参照する側の表を先に消し、そのあとで作品行）。
 *
 * **判定は D1 を確定する batch の中で行う**（{@link finalizeStatements}）。先に読んで決めてから
 * 書く形にすると、読んだあとに届いた通報やフォークの子を見落として、記録の付いた行を消しうる
 * （外部キーが止めれば batch ごと落ちるが、`takedown_requests` / `admin_actions` は外部キーを
 * 持たない）。**batch は 1 つのトランザクション**なので、「行を残す UPDATE」と「行を消す DELETE」は
 * 同じ瞬間の同じ条件を見て、ちょうど一方だけが当たる。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 中身を消した tombstone（`purged_at`）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - **題名・説明・タグ・`preview_key`・`ogp_key` を公開面に出ない値にする。** 題名は
 *   {@link PURGED_TITLE}（`title` は NOT NULL で、履歴の CHECK が空を拒むため空にしない）
 * - **成果物への参照（`source_key` / `wasm_key`）も落とす。** 5.3 の tombstone は子の再現のために
 *   `source.go` を残していたが、作者の削除・退会は「中身を消す」ことそのものである（仕様 3.7 の
 *   規約 1 の #516 注記）。R2 はその前に被参照判定を通して消してある
 * - `status = 'removed'` にし、`purged_at` を立てる
 * - 版とジョブ（`game_revisions` / `game_revision_jobs`）と `fork_notices` を消す
 * - **運営の記録があれば `title_changes` / `description_changes` を残し、題名と説明を消したことも
 *   履歴に 1 行ずつ積む。** 通報された時点の題名は履歴から復元する（`src/admin/report-evidence.ts`
 *   の規則 3 は「履歴が無ければいまの値」）。履歴を積まずに題名だけを差し替えると、**通報された
 *   時点の題名として {@link PURGED_TITLE} が出る**——証跡を壊すことになる
 * - **子がいるだけなら、履歴も消す**（記録が無ければ、履歴を読む人がいない）
 *
 * **公開面から外すための問い合わせの変更は要らない。** 一覧・作者ページ・検索・`/source/`・
 * 試遊・配信はどれも `status = 'published'` で引き、「あなたの作品」は `status <> 'removed'` で
 * 引く。作品ページは `removed` を取り下げ済みの表示に倒し、本人以外へ題名を渡さない
 * （`src/work-page.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 順序: 掴む → R2 を消す → D1 を確定する
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. **削除の開始を条件付き UPDATE 1 本で掴む**（{@link claimDeletion}）。以降、公開
 *    （`publishGame`）・推敲の枠の取得（`claimRevisionSlot`）・改名（`renameGame`）・版の復元
 *    （`restoreRevision`）の SQL は `deletion_started_at is null` で 0 行になる。**フォーク**の子は
 *    「親が公開済みであること」を条件にしており、掴めるのは `published` ではない行だけなので、
 *    掴んだ行を親にした子は新しく作られない（取り下げと削除のあいだに親を読み終えていた子が
 *    行を作っても、確定の batch がそれを「子がいる」と数えて行を残す）
 * 2. **R2 を消す。** 成果物は `src/build-cache.ts` の `deleteUnreferencedArtifacts`（索引を先に
 *    落とす → 数え直す → 消す → 条件付きで戻す）。**`ogp/<game_id>.png` は被参照判定なしで消す**
 *    （作品 id から決まるキーで、他の作品から参照されない。`src/ogp.ts`）
 * 3. **D1 を確定する**（1 つの batch）
 *
 * **完成の処理の後ろ半分と競合しうる。** 生成の完成は `generation_state = 'ready'` にしたあと、別の文で
 * 索引（`recordBuildCache`）と版（`appendRevision`）を書く。その隙間に掴んで確定すると、
 * **版**は `migrations/0041_game_deletion.sql` のトリガが積ませない（掴まれた行・消えた行への挿入を
 * `RAISE(IGNORE)` で飛ばす）。**索引**は消えたキーを指す行が書かれうるが、`readBuildCache` が R2 の
 * 実在を確かめて落とすので、次の同一ソースの生成で自己修復する（再ビルドが 1 回増えるだけ）。
 * **OGP の撮影のコールバック**が照合と R2 の書き込みのあいだに削除を挟んだ場合は、あちらが
 * 掴まれた行・消えた行を見て書いた画像を消す（`src/ogp.ts`）。
 *
 * **R2 を先にする理由。** D1 を先に確定すると、R2 を消す前に落ちたときに「どのキーを消すはず
 * だったか」を知る行（`games` の行と版）が残らず、**どの行からも指されない成果物が R2 に残り
 * 続ける。** R2 を先に消せば、確定の前に落ちても行と版が残っているので、**同じ呼び出しを
 * もう一度打てば同じ候補から続きをやれる**（掴みは `coalesce` で入り直せる）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 冪等である
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **2 回目の呼び出しは、1 回目と同じ結果を返す。** 行ごと消えていれば `deleted`、中身を
 * 消してあれば `purged` を返し、何も書かない。**行が無いことを「消えた」として返す**ので、
 * 存在しなかった id も `deleted` になる——**作者かどうか・存在したかどうかを確かめるのは
 * 呼び出し側である**（#517 / #518）。この関数は id を受け取るだけで、権限を持たない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 対象にしない行（何も書き換えずに断る）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - `published`（公開中の作品を取り下げずに直接消さない。#516 の scope.out）
 * - 生成中（`generation_state` が `pending` / `running`）。**経過時間で区切らない**
 * - 推敲のジョブが `pending` / `running`。**経過時間で区切らない**
 *
 * **進行中を対象にしないことで、費用台帳を守る。** 生成・推敲のコールバック
 * （`src/generate-callback.ts`）は `games` の行とジョブ行のトークンを照合してから台帳を
 * 書くので、消えた行や消えたジョブに届くと台帳の行を落とす。区切り（`STALE_AFTER_SECONDS`）を
 * 過ぎた行も断るのは、#516 が「`pending` / `running` でないこと」と条件を書いているためである
 * （止まったまま残った行を消せるようにするかは、呼び出し元を作る #517 で決める）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * D1 の文の本数
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **版の数に比例しない。** 掴む 1・R2 の判定 4（`deleteUnreferencedArtifacts`。戻す索引が
 * あればその数だけ増える）・確定の batch 9 の **14 本**である（版が 30 個の作品で
 * `test/game-deletion.test.ts` が実測する。D1 の 1 呼び出しあたりの枠は 50）。
 *
 * **`games` の `meta.changes` をちょうどの値と比べない**（`games` にはトリガがある。
 * `migrations/0037_game_search.sql` と `migrations/0045_user_withdrawal.sql`）。0 か否かだけを見る。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 受け取る env は D1 と R2 だけである（#586）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`Env` をそのまま要求しない。** 退会の後続の処理はこの関数を**別の Worker**
 * （`game-forge-cleanup`。`workers/cleanup/`）から呼ぶ。あちらは Pages の宣言から生成される
 * `Env` を持たず、自分のバインディングだけを持つ手書きの型を使うので、`Env` を要求すると
 * 呼べない。**読んでいるのは `DB` と `BUCKET` の 2 つだけ**なので、
 * {@link StorageEnv}（`src/build-cache.ts`）へ狭める。
 */
import type { StorageEnv } from './build-cache.js';
import { deleteUnreferencedArtifacts } from './build-cache.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS, UNBUILT_GO_VERSION } from './games.js';

/**
 * 中身を消した tombstone の題名。
 *
 * **空文字にしない。** `games.title` は NOT NULL で、運営の記録がある作品では消したことを
 * `title_changes` に積む（`new_title` は CHECK で空を拒む。`migrations/0027_title_changes.sql`）。
 * 作品ページは `removed` の題名を本人以外へ渡さないので、この文字列が公開面に出ることは無い。
 */
export const PURGED_TITLE = '削除された作品';

/** 削除が済んだ状態（**2 回目の呼び出しも同じ値を返す**）。 */
export type GameDeletionResult =
  /** 行ごと消えている（参照する側の表も消えている）。 */
  | 'deleted'
  /** 行を残して中身を消した（`purged_at` が立っている）。 */
  | 'purged';

/**
 * 削除を断った理由。**断ったときは何も書き換えていない。**
 *
 * - `published` … 公開中（取り下げてから消す）
 * - `generating` … 生成中（`generation_state` が `pending` / `running`）
 * - `revising` … 推敲のジョブが `pending` / `running`
 * - `busy` … 読み直すあいだに状態が動いた（もう一度呼べば、上のどれかか成功になる）
 */
export type GameDeletionRejection = 'published' | 'generating' | 'revising' | 'busy';

/** 削除の結果。 */
export type GameDeletionOutcome =
  | { readonly ok: true; readonly result: GameDeletionResult }
  | { readonly ok: false; readonly reason: GameDeletionRejection };

/**
 * 作品を消す（行ごと、または中身だけ）。
 *
 * 決め方・順序・冪等性・断る条件はモジュールの冒頭にある。
 *
 * @param env バインディングと環境変数
 * @param gameId 消す作品の id（**作者かどうかは呼び出し側が確かめてから渡す**）
 * @param now 時刻（UNIX 秒。既定は現在時刻）
 * @returns 削除の結果
 */
export async function deleteGame(
  env: StorageEnv,
  gameId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<GameDeletionOutcome> {
  if (!(await claimDeletion(env, gameId, now))) {
    return await settledOutcome(env, gameId);
  }

  // **R2 を先に消す**（モジュール冒頭）。どちらも投げたら、そのまま投げる——D1 はまだ
  // 確定していないので、もう一度呼べば同じ候補から続きをやれる。
  await deleteUnreferencedArtifacts(env, gameId);
  await deleteOgpImage(env, gameId);

  const results = await env.DB.batch(finalizeStatements(env, gameId, now));
  // **添字で読む**（`noUncheckedIndexedAccess`）。並びは {@link finalizeStatements} の末尾 2 本。
  const purged = (results[results.length - 2]?.meta.changes ?? 0) > 0;
  const deleted = (results[results.length - 1]?.meta.changes ?? 0) > 0;
  if (purged) {
    return { ok: true, result: 'purged' };
  }
  if (deleted) {
    return { ok: true, result: 'deleted' };
  }
  // どちらも当たらなかったのは、並行した同じ呼び出しが先に確定したときである。読み直して返す。
  return await settledOutcome(env, gameId);
}

/**
 * 紹介用の画像を R2 から消す（#640）。
 *
 * **鍵を組み立てない。行の `ogp_key` を読んで、その 1 本だけを消す。**
 *
 * #640 で鍵が撮影ごとに変わるようになった（`src/ogp.ts` の `newOgpObjectKey`）。**組み立てた鍵を
 * 消す形のままだと、実際の画像が残る**——しかも残るのは「削除したはずの作品の画像」で、5.3 の #516 節と
 * `/privacy` が消すと約束しているものである。**列を読めば、古い形の鍵（`ogp/<game_id>.png`）が入っている
 * 行もそのまま消える**ので、移行は要らない。
 *
 * **撮影中に消しても取りこぼさない。** 掴みの文（{@link claimDeletion}）が `ogp_token_hash` を捨てるので、
 * あとから届いたコールバックは D1 の確定で弾かれ、**自分が書いたオブジェクトを自分で消す**
 * （`src/ogp.ts` の `handleOgpCallback`）。
 *
 * @param env `DB` と `BUCKET`（{@link deleteGame} と同じく {@link StorageEnv} へ狭める）
 * @param gameId 対象の作品 id
 */
async function deleteOgpImage(env: StorageEnv, gameId: string): Promise<void> {
  const row = await env.DB.prepare('select ogp_key from games where id = ?')
    .bind(gameId)
    .first<{ ogp_key: string | null }>();
  if (row?.ogp_key != null) {
    await env.BUCKET.delete(row.ogp_key);
  }
}

/**
 * 削除の開始を掴む（**入り直せる**）。
 *
 * **条件はすべて WHERE に置く**（`claimGenerationJob` と同じ。先に読んでから書くと、その
 * 隙間に公開や推敲が入る）。
 *
 * - `purged_at is null` … 中身を消した行は掴まない（2 回目の呼び出しは何も書かない）
 * - `status in ('draft', 'removed')` … 公開中は掴まない
 * - `generation_state in ('ready', 'failed')` … 生成中は掴まない
 * - 推敲のジョブが `pending` / `running` でない
 *
 * **`deletion_started_at` は最初に掴んだ時刻を残す**（`coalesce`）。途中で落ちた削除を打ち直すと
 * 同じ行をもう一度掴めるが、いつ始まった削除かは変わらない。
 *
 * **OGP の撮影のトークンを捨てる。** 取り下げの直前に始まった撮影のコールバックが、R2 を消した
 * あとに画像を書き戻さないようにする（コールバックは `BUCKET.put` の前にトークンを照合する。
 * `src/ogp.ts`）。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param now 時刻（UNIX 秒）
 * @returns 掴めたら true
 */
async function claimDeletion(env: StorageEnv, gameId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set deletion_started_at = coalesce(deletion_started_at, ?), ogp_token_hash = null
      where id = ? and purged_at is null
        and status in (?, ?)
        and generation_state in ('ready', 'failed')
        and not exists (select 1 from game_revision_jobs j
                         where j.game_id = games.id and j.state in ('pending', 'running'))`,
  )
    .bind(now, gameId, DRAFT_STATUS, REMOVED_STATUS)
    .run();
  // **ちょうどの値と比べない**（`games` にはトリガがある。モジュール冒頭）。
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 掴めなかった（あるいは確定が当たらなかった）ときに、いまの状態を読んで結果を返す。
 *
 * **分類のためだけに読む。** 書き込みの判定は {@link claimDeletion} と確定の batch が済ませている。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @returns 削除の結果
 */
async function settledOutcome(env: StorageEnv, gameId: string): Promise<GameDeletionOutcome> {
  const row = await env.DB.prepare(
    `select g.status as status, g.generation_state as generation_state, g.purged_at as purged_at,
            exists (select 1 from game_revision_jobs j
                     where j.game_id = g.id and j.state in ('pending', 'running')) as revising
       from games g
      where g.id = ?`,
  )
    .bind(gameId)
    .first<{ status: string; generation_state: string; purged_at: number | null; revising: number }>();

  if (row === null) {
    return { ok: true, result: 'deleted' };
  }
  if (row.purged_at !== null) {
    return { ok: true, result: 'purged' };
  }
  if (row.status === PUBLISHED_STATUS) {
    return { ok: false, reason: 'published' };
  }
  if (row.generation_state === 'pending' || row.generation_state === 'running') {
    return { ok: false, reason: 'generating' };
  }
  if (row.revising === 1) {
    return { ok: false, reason: 'revising' };
  }
  return { ok: false, reason: 'busy' };
}

/**
 * 「子がいる」を表す SQL の条件（束縛 1 つ: 作品 id）。**状態を問わない**（下書きの子も数える）。
 *
 * @returns 条件
 */
function hasChildrenSql(): string {
  return 'exists (select 1 from games c where c.parent_id = ?)';
}

/**
 * 「運営の記録がある」を表す SQL の条件（束縛 4 つ: すべて作品 id）。
 *
 * **`takedown_requests` と `moderation_blocks` は索引を持たない**（どちらも平常時ほとんど
 * 増えない表で、全走査で足りると決めてある。0016 / 0018）。`reports` は `(game_id, reporter_id)`
 * の一意索引、`admin_actions` は `(target_kind, target_id, …)` の索引から入る。
 *
 * @returns 条件（括弧で閉じてある）
 */
function hasRecordsSql(): string {
  return `(exists (select 1 from reports where game_id = ?)
           or exists (select 1 from takedown_requests where game_id = ?)
           or exists (select 1 from admin_actions where target_kind = 'game' and target_id = ?)
           or exists (select 1 from moderation_blocks where game_id = ?))`;
}

/**
 * 「この呼び出しが掴んでいて、まだ中身を消していない」を表す SQL の条件（束縛 1 つ: 作品 id）。
 *
 * **確定の batch のすべての文に置く。** 掴めていない行（呼び出し側の不具合）や、並行した同じ
 * 呼び出しが先に確定した行に対して、版や履歴だけを消す文が当たらないようにする。
 *
 * @returns 条件
 */
function claimedSql(): string {
  return 'exists (select 1 from games where id = ? and deletion_started_at is not null and purged_at is null)';
}

/**
 * D1 を確定する batch の文（**末尾の 2 本が「行を残す UPDATE」と「行を消す DELETE」**）。
 *
 * **順序に意味がある。**
 *
 * 1. 記録があるなら、題名と説明を消したことを履歴に積む（`games` を書き換える前でなければ
 *    旧い値が読めない。`renameGame` と同じ理由）
 * 2. 記録が無いなら、履歴を消す
 * 3. 推敲のジョブ・版・改造通知の記録を消す（どちらの場合も消す）
 * 4. 子か記録があるなら、行を残して中身を消す
 * 5. どちらも無いなら、行を消す（**参照する側の表を先に消してある**。仕様 3.7 の規約 4）
 *
 * 4 が当たれば `purged_at` が立つので、5 の条件（`purged_at is null`）は外れる。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param now 時刻（UNIX 秒）
 * @returns 準備済みの文（9 本）
 */
function finalizeStatements(env: StorageEnv, gameId: string, now: number): D1PreparedStatement[] {
  const records = [gameId, gameId, gameId, gameId] as const;
  const keep = `(${hasChildrenSql()} or ${hasRecordsSql()})`;
  const keepBindings = [gameId, ...records] as const;

  return [
    // 1. 記録があれば、題名を消したことを履歴に積む（通報の時点の題名を復元できるように）。
    env.DB.prepare(
      `insert into title_changes (id, game_id, old_title, new_title, changed_at)
       select ?, id, title, ?, ?
         from games
        where id = ? and deletion_started_at is not null and purged_at is null
          and title <> ? and ${hasRecordsSql()}`,
    ).bind(crypto.randomUUID(), PURGED_TITLE, now, gameId, PURGED_TITLE, ...records),
    // 1. 同じく説明（空なら積まない——変わらない）。
    env.DB.prepare(
      `insert into description_changes (id, game_id, old_description, new_description, changed_at)
       select ?, id, description, '', ?
         from games
        where id = ? and deletion_started_at is not null and purged_at is null
          and description <> '' and ${hasRecordsSql()}`,
    ).bind(crypto.randomUUID(), now, gameId, ...records),
    // 2. 記録が無ければ履歴を消す（行ごと消すときも、子がいるだけのときも）。
    env.DB.prepare(
      `delete from title_changes where game_id = ? and ${claimedSql()} and not ${hasRecordsSql()}`,
    ).bind(gameId, gameId, ...records),
    env.DB.prepare(
      `delete from description_changes where game_id = ? and ${claimedSql()} and not ${hasRecordsSql()}`,
    ).bind(gameId, gameId, ...records),
    // 3. 推敲のジョブ・版・改造通知の記録。**掴めた時点で進行中のジョブは無い**（`claimDeletion`）。
    env.DB.prepare(`delete from game_revision_jobs where game_id = ? and ${claimedSql()}`).bind(
      gameId,
      gameId,
    ),
    env.DB.prepare(`delete from game_revisions where game_id = ? and ${claimedSql()}`).bind(
      gameId,
      gameId,
    ),
    env.DB.prepare(`delete from fork_notices where game_id = ? and ${claimedSql()}`).bind(
      gameId,
      gameId,
    ),
    // 4. 子か記録があれば、行を残して中身を消す。
    env.DB.prepare(
      `update games
          set status = ?, purged_at = ?,
              title = ?, description = '', description_set_at = null,
              tag1 = null, tag2 = null, tag3 = null, tags_set_at = null,
              preview_key = null, ogp_key = null, ogp_state = null, ogp_token_hash = null,
              ogp_started_at = null, ip_notice = null, job_token_hash = null,
              source_key = null, wasm_key = null, go_version = ?
        where id = ? and deletion_started_at is not null and purged_at is null and ${keep}`,
    ).bind(REMOVED_STATUS, now, PURGED_TITLE, UNBUILT_GO_VERSION, gameId, ...keepBindings),
    // 5. どちらも無ければ行を消す。
    env.DB.prepare(
      `delete from games
        where id = ? and deletion_started_at is not null and purged_at is null and not ${keep}`,
    ).bind(gameId, ...keepBindings),
  ];
}
