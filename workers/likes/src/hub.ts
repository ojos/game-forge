/**
 * いいねの正本（5.8 / #339）。**全員のいいねを 1 個の Durable Object に集める（B1）。**
 *
 * # なぜ D1 ではなくここなのか
 *
 * **D1 は日次の書き込み上限を超えると、アカウント全体のクエリがすべて失敗する**（3.6）。
 * いいねの付け外しは索引込みで 1 回最大約 6 行になり、連打だけで生成もログインも
 * 止められる。正本を D1 と別の枠（Durable Objects）に置き、**D1 へは数だけを 5 分おきに
 * 写す**（{@link LikeHub.alarm}）。DO の枠が尽きても止まるのはいいねとプレイ数だけである
 * （プレイ数は同じ Worker の別クラス `PlayHub` に載る。DO の無料枠はアカウント共通なので、
 * 尽きるときは両方が止まる。`./play-hub.ts`。#377）。
 *
 * # 同期と D1 への写しは `PlayHub` と共有する（#377）
 *
 * **「同期待ちの印を 40 件ずつ写し、写している間に変わった作品は印を末尾へ付け直す」**
 * 部分は、いいねとプレイ数で同じである。その部分をこのモジュールの関数
 * （{@link planCountSync} / {@link writeCountSync} / {@link ensureSyncAlarm} /
 * {@link runSyncAlarm}）に切り出し、`PlayHub` が借りる。**違うのは「実数の数え方」と
 * 「どの列へ写すか」だけ**で、それは呼び出し側が渡す。
 *
 * # 1 個にまとめる理由
 *
 * DO は単一スレッドなので、**「二重押しか」と「今日の操作回数」の判定と、その書き込みが
 * 原子的になる**（読んでから書くまでのあいだに `await` を挟まない。SQL の API は同期で、
 * {@link LikeHub.like} は判定から書き込みまでを 1 つの `transactionSync` に収める）。
 * 分割（B2）へ移る契機はピーク毎秒 500 リクエスト（2.3.8）で、移るときは窓口
 * （`src/likes.ts`）とこの Worker の内側だけを変える。
 *
 * # 受け取った利用者 id を信じる
 *
 * **この DO は利用者を確かめない。** 確かめるのは呼び出し側（Pages の `src/likes.ts`。
 * セッションを確かめてから呼ぶ）の責務で、だから `game-forge-likes` には公開の入口を
 * 持たせない（`workers/likes/wrangler.toml` の冒頭）。**RPC の口を増やすときも、
 * 「Pages 以外から届かない」ことを前提にしてよいのはこの宣言が守られている間だけ**である。
 *
 * # 書き込みの行数（3.6 の表の根拠）
 *
 * **状態を変えた付与・取り消し 1 回で、DO の SQLite へ 6 行**（`test/likes-hub.test.ts` が
 * SQLite の `rowsWritten` で実測している）。内訳は、いいねの行＋作品の索引
 * （`likes_game_idx`）＋**本人の一覧の索引**（`likes_user_recent_idx`）＋今日の操作回数＋
 * 同期待ちの印（`dirty_games` は rowid 表なので、行と `game_id` の自動索引で 2 行）。
 * **断った操作と、状態が変わらない操作は 1 行も書かない。**
 *
 * > **#340 で測り直したら 2 つ分かった**（PR #348 のレビュー指摘をきっかけに実測した）。
 * >
 * > 1. **`likes_user_recent_idx` を足して 1 行増えた**（実測 5 → 6）。本人の一覧のための
 * >    索引で、**理由と取引は {@link LikeHub.likedGames} にある**（索引が無いと、開くたびに
 * >    その人の履歴全体を並べ替える）
 * > 2. **起票時の「4 行」は 1 行少なかった。** 索引を足す前の実測は **5 行**である——
 * >    `dirty_games` への `insert` が 2 行を書く（rowid 表の行と、`game_id` の
 * >    `sqlite_autoindex`）ことを数えていなかった。**3.6 の見積もりの「約 4 行」は、この
 * >    2 つを合わせて「約 6 行」へ動く**（+1 はこの PR、+1 は元からの数え落ち）
 * >
 * > **実測を検査に持たせた**ので、次に増えた日に気づける。
 */
import { DurableObject } from 'cloudflare:workers';
import { formatJstMinutes } from '../../../src/jst.js';

/**
 * 1 人が 1 日（JST）にできる操作の回数（5.8）。**付与と取り消しの合計**である。
 *
 * **状態を変えた操作だけを数える。** 既に押した作品への付与・押していない作品の取り消しは
 * 冪等で「何もしない」ので、数えもしない（数えるには書き込みが要る。書かないと決めた
 * 操作のために書くのは逆である）。
 */
export const DAILY_OPERATION_LIMIT = 100;

/**
 * D1 へ数を写す間隔（ミリ秒）。**5 分**（5.8）。
 *
 * 一覧・カード・作者ページの数は、この間隔だけ遅れる（2.3.4 / 2.3.6）。
 */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 1 回の同期で D1 へ写す作品の上限。
 *
 * **Workers Free の D1 は、1 回の呼び出しで 50 クエリまで**である（D1 の公式の limits。
 * batch の中の文も 1 本ずつ数える）。同期は BAN の読み取り 1 本＋更新 n 本なので、
 * 余裕を残して 40 に置く。溢れた分は同期待ちの印が残り、次の回に写る。
 */
export const MAX_GAMES_PER_SYNC = 40;

/**
 * BAN された利用者を D1 から引く SQL。
 *
 * **`migrations/0020_games_like_count.sql` の部分索引 `users_banned_idx` が効く形**で
 * 書く（`banned_at is not null` をそのまま条件にする）。5 分ごとに走るので、
 * 全表走査だと読み取りが利用者の総数 × 288 回/日 に比例する。索引の上なら BAN された
 * 人数だけで済む。**テストはこの文字列をそのまま実行計画に掛ける**（書き写さない）。
 */
export const BANNED_USERS_SQL = 'select id from users where banned_at is not null';

/**
 * `games.like_count` を上書きする SQL。
 *
 * **加算ではなく上書きにする**（5.8。5.5 が `fork_count` を数え直しにしたのと同じ理由
 * ——加算は取り残しを直せない）。**値が同じなら書かない**（`like_count <> ?`）。
 * 同じ値で UPDATE しても、D1 は行と索引を書いたものとして数える。
 */
export const UPDATE_LIKE_COUNT_SQL =
  'update games set like_count = ? where id = ? and like_count <> ?';

/**
 * ある利用者が押した作品を、押した新しい順に引く SQL（5.8 / M9-8 / #340）。
 *
 * **定数として出しているのは、実行計画を検査できるようにするためである**
 * （{@link BANNED_USERS_SQL} と同じ扱い。`.ai-playbook/shared-ai-rules.md` 12 章）。
 * `test/likes-hub.test.ts` はこの文字列に `EXPLAIN QUERY PLAN` を付けて実行し、
 * **`likes_user_recent_idx` が使われ、並べ替えのための一時的な処理（TEMP B-TREE）が
 * 入らないこと**を確かめる。**書き写すと、索引を落とした日に検査だけが古い SQL を見る。**
 *
 * 並びの末尾に `game_id` を足すのは、同じ秒に押した行の順序を決めるためである（決まって
 * いないと、頁をめくったときに同じ作品が 2 度出たり 1 度も出なかったりする）。
 */
export const LIKED_GAMES_SQL = `select game_id from likes
  where user_id = ?
  order by created_at desc, game_id desc
  limit ? offset ?`;

/** 受け付ける id の最大の長さ。**防御の上限**であって、形の検査は呼び出し側が持つ。 */
const MAX_ID_LENGTH = 128;

/**
 * {@link LikeHub.likedGames} が 1 回に返す作品の上限。
 *
 * **防御の上限である**（{@link MAX_ID_LENGTH} と同じ扱い）。1 頁の件数を決めるのは
 * 画面の側で（`src/liked-works.ts`。仕様 5.8 は 20 件ずつと定める）、ここはその値を
 * 知らない。**それでも上限を置く**のは、`limit` を桁違いに大きくした呼び出し 1 本で
 * DO の単一スレッドを長く占有できないようにするためである（1 個の DO に全員のいいねが
 * 集まっている。5.8 の B1）。
 */
export const MAX_LIKED_GAMES_PER_CALL = 100;

/** 付与・取り消しの結果。 */
export type LikeOperationOutcome =
  /** 付与した（状態が変わった）。 */
  | 'liked'
  /** 取り消した（状態が変わった）。 */
  | 'unliked'
  /** 既にその状態だった。**何も書いていない。** 回数も数えていない。 */
  | 'unchanged'
  /** 今日の上限に達していた。**何も書いていない。** */
  | 'limited';

/** 付与・取り消しの結果（RPC の戻り値）。 */
export interface LikeOperationResult {
  readonly outcome: LikeOperationOutcome;
}

/** ある利用者から見た、ある作品のいいねの状態（ログイン中の作品ページが引く。5.8）。 */
export interface LikeViewerState {
  /** この利用者が押しているか。 */
  readonly liked: boolean;
  /** 作品のいいねの数（BAN された利用者の分を除いた実数）。 */
  readonly count: number;
}

/** 1 回の同期で何をしたか（いいねとプレイ数で同じ形。#377）。 */
export interface CountSyncReport {
  /** D1 へ数を送った作品の数。 */
  readonly synced: number;
  /** 上限（{@link MAX_GAMES_PER_SYNC}）に当たって次の回へ回した作品の数。 */
  readonly deferred: number;
}

/** 1 回の同期で何をしたか（いいね）。**形は {@link CountSyncReport} と同じである。** */
export type LikeSyncReport = CountSyncReport;

/** 1 回の同期で写す 1 件（作品と、同期の区間で数えた実数）。 */
export interface CountSyncEntry {
  readonly gameId: string;
  readonly count: number;
}

/** 同期の区間で決めた、写す作品と残りの件数。 */
export interface CountSyncPlan {
  readonly planned: readonly CountSyncEntry[];
  readonly deferred: number;
}

/**
 * 同期待ちの印の表を作る SQL（いいねとプレイ数で同じ。#377）。
 *
 * **rowid を残す。** 同期は印を付けた順（rowid の順）に {@link MAX_GAMES_PER_SYNC} 件ずつ
 * 写す。作品 id の順にすると、写しても写しても印が付き直す作品が先頭を占め、後ろの作品が
 * いつまでも写らない（{@link writeCountSync} が印を末尾へ付け直す理由と同じ）。
 */
export const DIRTY_GAMES_TABLE_SQL = `create table if not exists dirty_games (
        game_id text primary key
      );`;

/**
 * 同期待ちの印から、写す作品とその実数を決める（5.8 / #377）。
 *
 * **`transactionSync` の中で呼ぶこと。** 印を読んでから数えるまでに `await` を挟むと、
 * 割り込んだ操作の分を数え落とす。
 *
 * @param sql DO の SQL
 * @param countFor 作品の実数を数える関数（いいねは BAN を除いた数、プレイ数は累計）
 * @returns 写す作品（印を付けた順）と、次の回へ回す件数
 */
export function planCountSync(
  sql: SqlStorage,
  countFor: (gameId: string) => number,
): CountSyncPlan {
  const dirty = sql
    .exec<{ game_id: string }>(
      'select game_id from dirty_games order by rowid limit ?',
      MAX_GAMES_PER_SYNC,
    )
    .toArray();
  const total = sql.exec<{ n: number }>('select count(*) as n from dirty_games').one().n;
  return {
    planned: dirty.map((row) => ({ gameId: row.game_id, count: countFor(row.game_id) })),
    deferred: total - dirty.length,
  };
}

/**
 * 決めた数を D1 へ写し、印を片付ける（5.8 / #377）。
 *
 * # 手順
 *
 * 1. D1 の列を上書きする（batch 1 回。`updateSql` は `(count, gameId, count)` を束縛する形）
 * 2. 写した作品の印を消す。**写したあとに実数が変わっていた作品は、印を末尾へ付け直す**
 *
 * # なぜ 2 で数え直すのか
 *
 * **1 の `await` のあいだに、別の操作が割り込める**（外への I/O を待つ間、DO は次の要求を
 * 受け付ける）。写した値と今の実数が違えば、その作品はまた変わっているので印が要る。
 * **印を先に消す形にすると、割り込んだ操作の分を取り残す。**
 *
 * **残すのではなく、末尾へ付け直す。** 古い印を残すと rowid が古いまま先頭に居座り、
 * 同期のたびに変わり続ける作品が {@link MAX_GAMES_PER_SYNC} 件を超えると、後ろの作品が
 * 1 度も写らない（飢餓）。付け直せば、写し損ねた作品は後ろへ回り、待っていた作品が
 * 次の回に先頭へ来る。
 *
 * @param storage DO の保存領域
 * @param db 本番の D1
 * @param updateSql 列を上書きする SQL（**値が同じなら書かない形**にしておくこと）
 * @param plan {@link planCountSync} が決めたもの
 * @param countFor 作品の実数を数える関数（{@link planCountSync} に渡したものと同じ）
 * @returns 何をしたか
 */
export async function writeCountSync(
  storage: DurableObjectStorage,
  db: D1Database,
  updateSql: string,
  plan: CountSyncPlan,
  countFor: (gameId: string) => number,
): Promise<CountSyncReport> {
  if (plan.planned.length === 0) {
    return { synced: 0, deferred: plan.deferred };
  }

  await db.batch(
    plan.planned.map(({ gameId, count }) => db.prepare(updateSql).bind(count, gameId, count)),
  );

  const sql = storage.sql;
  storage.transactionSync(() => {
    for (const { gameId, count } of plan.planned) {
      sql.exec('delete from dirty_games where game_id = ?', gameId);
      if (countFor(gameId) !== count) {
        // **写している間に変わった。印を末尾へ付け直す**（新しい rowid を取る）。
        // 印を残すだけにすると古い rowid のまま先頭に居座り、変わり続ける作品が
        // {@link MAX_GAMES_PER_SYNC} 件を超えると、後ろの作品がいつまでも写らない
        // （操作の側は `insert or ignore` なので、印が付き直しても rowid は変わらない）。
        sql.exec('insert into dirty_games (game_id) values (?)', gameId);
      }
    }
  });
  return { synced: plan.planned.length, deferred: plan.deferred };
}

/**
 * 同期の予約が無ければ入れる（いいねとプレイ数で同じ。#377）。
 *
 * **既にあれば動かさない。** 操作のたびに 5 分後へずらすと、操作が続く間は 1 度も同期
 * されない。
 *
 * @param storage DO の保存領域
 */
export async function ensureSyncAlarm(storage: DurableObjectStorage): Promise<void> {
  if ((await storage.getAlarm()) === null) {
    await storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }
}

/**
 * アラームの本体（いいねとプレイ数で同じ。#377）。
 *
 * **例外で落とさない。** 失敗しても同期待ちの印は残るので、次の回に写る。落とすと
 * 実行環境の再試行（指数的に間隔を空ける）に任せることになり、5 分おきという約束が
 * 崩れる。**続ける理由があれば、失敗しても必ず次を予約する。**
 *
 * @param label ログの接頭辞（`likes` / `plays`）
 * @param storage DO の保存領域
 * @param sync 同期の本体
 * @param hasPendingWork 次の同期を予約すべきか
 */
export async function runSyncAlarm(
  label: string,
  storage: DurableObjectStorage,
  sync: () => Promise<CountSyncReport>,
  hasPendingWork: () => boolean,
): Promise<void> {
  try {
    const report = await sync();
    if (report.synced > 0 || report.deferred > 0) {
      console.log(`[${label}] 同期しました: ${report.synced} 件（残り ${report.deferred} 件）`);
    }
  } catch (error) {
    console.error(
      `[${label}] 同期に失敗しました。次の回に写します: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (hasPendingWork()) {
    await storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }
}

/** この Worker のバインディング（`workers/likes/wrangler.toml`）。 */
export interface LikesEnv {
  /** 本番の D1。**同期だけが使う**（付与・取り消しでは触らない）。 */
  readonly DB: D1Database;
}

/**
 * UNIX 秒を、日次の上限を数える JST の日付（`YYYY-MM-DD`）にする。
 *
 * **JST の暦日で切る**（5.8。確定25 の生成の日次枠と同じ境界）。表記は `src/jst.ts` の
 * `formatJstMinutes` から切り出す——**時差の足し方を 2 か所に書かない。** 文字列の大小が
 * 日付の前後と一致する形なので、古い日の掃除（{@link LikeHub.sync}）にもそのまま使える。
 *
 * @param at UNIX 秒
 * @returns JST の日付
 * @throws 日付にできない値のとき
 */
export function jstDayKey(at: number): string {
  const day = formatJstMinutes(at).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    throw new RangeError(`日付にできない時刻です: ${at}`);
  }
  return day;
}

/**
 * id の形を確かめる（防御の最後の段）。
 *
 * @param value 受け取った値
 * @param what ログに出す名前
 * @returns 値そのもの
 * @throws 文字列でない・空・長すぎるとき
 */
function assertId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`${what} の形が不正です`);
  }
  return value;
}

/**
 * 時刻の形を確かめる。
 *
 * @param at 受け取った値
 * @returns 値そのもの
 * @throws 0 以上の整数でないとき
 */
function assertEpochSeconds(at: unknown): number {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new TypeError('時刻の形が不正です');
  }
  return at;
}

/**
 * 件数の形を確かめる（`limit` / `offset`）。
 *
 * **SQLite は `LIMIT -1` を「無制限」と解釈する**（`src/games.ts` の `assertLimit` が
 * 同じ理由で置かれている）。負の値を渡すと上限が消えるので、**0 以上の整数だけを通す。**
 * `OFFSET` にも同じ検査が要る——SQLite は `OFFSET -1` を 0 として黙って受け入れる。
 *
 * @param value 受け取った値
 * @param what ログに出す名前
 * @param max 許す最大値
 * @returns 値そのもの
 * @throws 0 以上の整数でない、または `max` を超えるとき
 */
function assertCount(value: unknown, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${what} の形が不正です`);
  }
  return value;
}

/**
 * いいねの正本（SQLite 版の Durable Object）。
 *
 * **Pages からは RPC で呼ぶ**（`src/likes.ts`）。`fetch` は持たない——利用者 id を
 * 受け取る HTTP の口を作らない（5.8）。
 */
export class LikeHub extends DurableObject<LikesEnv> {
  /**
   * @param ctx DO の状態
   * @param env バインディング
   */
  constructor(ctx: DurableObjectState, env: LikesEnv) {
    super(ctx, env);
    // **表は `if not exists` で作る。** DO の SQLite には D1 のマイグレーション台帳が無く、
    // 起動のたびにここが走る。列を足すときは、既存の行を持つ DO で走っても壊れない形
    // （`alter table ... add column` を条件付きで）にすること。
    //
    // - likes: 正本。主キーが「二重押しの判定」と「利用者の押した作品」を兼ねる。
    //   作品ごとの数を数えるために game_id の索引を持ち、**本人の一覧（M9-8）のために
    //   (user_id, created_at desc, game_id desc) の索引を持つ**。主キーは 1 人の行までは
    //   辿れるが `order by created_at desc` を作れないので、索引が無いと**その人の履歴
    //   全体を呼び出しごとに並べ替える**（日次上限 100 操作は溜まった履歴の量を縛らない。
    //   DO は 1 個の共有なので、並べ替えは全員の単一スレッドを占有する。PR #348 の指摘）
    // - daily_ops: 1 人 1 日（JST）の操作回数。古い日は同期のたびに掃除する
    // - dirty_games: 前回の同期から数が変わりうる作品（同期待ちの印）
    // - banned_users: 同期が最後に見た「BAN されている利用者」。D1 と差分を取り、
    //   BAN の状態が変わった利用者の押した作品だけを数え直すために持つ
    //
    // **dirty_games だけは rowid を残す。** 同期は印を付けた順（rowid の順）に
    // {@link MAX_GAMES_PER_SYNC} 件ずつ写す。作品 id の順にすると、写しても写しても
    // 印が付き直す作品が先頭を占め、後ろの作品がいつまでも写らない。同じ理由で、
    // 同期の最中に変わった作品は印を消して付け直し、末尾へ回す（{@link LikeHub.sync}）。
    ctx.storage.sql.exec(`
      create table if not exists likes (
        user_id text not null,
        game_id text not null,
        created_at integer not null,
        primary key (user_id, game_id)
      ) without rowid;
      create index if not exists likes_game_idx on likes (game_id);
      create index if not exists likes_user_recent_idx
        on likes (user_id, created_at desc, game_id desc);
      create table if not exists daily_ops (
        user_id text not null,
        day text not null,
        ops integer not null,
        primary key (user_id, day)
      ) without rowid;
      ${DIRTY_GAMES_TABLE_SQL}
      create table if not exists banned_users (
        user_id text primary key
      ) without rowid;
    `);
  }

  /**
   * いいねを付ける。**冪等**（既に押していれば何もしない）。
   *
   * @param userId 押した利用者（**呼び出し側がセッションで確かめた id**）
   * @param gameId 作品（**呼び出し側が「押せる作品」と確かめた id**）
   * @param at 操作の時刻（UNIX 秒）。日次の上限を数える日付を決める
   * @returns 結果
   */
  async like(userId: string, gameId: string, at: number): Promise<LikeOperationResult> {
    return await this.operate('like', userId, gameId, at);
  }

  /**
   * いいねを取り消す。**冪等**（押していなければ何もしない）。
   *
   * @param userId 取り消す利用者（**呼び出し側がセッションで確かめた id**）
   * @param gameId 作品
   * @param at 操作の時刻（UNIX 秒）
   * @returns 結果
   */
  async unlike(userId: string, gameId: string, at: number): Promise<LikeOperationResult> {
    return await this.operate('unlike', userId, gameId, at);
  }

  /**
   * ある利用者から見た作品のいいねの状態を返す。**読むだけで、何も書かない。**
   *
   * ログイン中の作品ページだけが 1 回引く（5.8。未ログインの閲覧では DO を呼ばない）。
   *
   * @param userId 見ている利用者
   * @param gameId 作品
   * @returns 押しているかと、数
   */
  async viewerState(userId: string, gameId: string): Promise<LikeViewerState> {
    assertId(userId, 'userId');
    assertId(gameId, 'gameId');
    return { liked: this.hasLiked(userId, gameId), count: this.countFor(gameId) };
  }

  /**
   * ある利用者が押した作品を、**押した新しい順**に返す（5.8 / M9-8 / #340）。
   *
   * **読むだけで、何も書かない。** 日次の操作回数（{@link DAILY_OPERATION_LIMIT}）にも、
   * 同期待ちの印（`dirty_games`）にも触れない——**回数を数えるには書き込みが要る**ので、
   * 「読むだけ」と「数える」は両立しない（{@link DAILY_OPERATION_LIMIT} の冒頭が
   * 冪等な操作について同じことを書いている）。
   *
   * # 返すのは id だけである
   *
   * **題名も作者名も、公開状態も返さない。** それらは D1 の `games` にあり、**この DO は
   * D1 の作品を知らない**（知っているのは「誰がどの id を押したか」だけである）。
   * 呼び出し側（`src/liked-works.ts`）が id を D1 で引き直し、**引く時点で
   * 「公開をやめた作品・審査で新規露出を止めた作品」を落とす**（#152 の規律。5.8）。
   * **したがって、ここが返した件数より画面に並ぶ件数が少なくなりうる。**
   *
   * # BAN された利用者の一覧を空にしない
   *
   * {@link LikeHub.countFor} は BAN された利用者の分を数に入れないが、**ここでは
   * `banned_users` を見ない。** 除くのは**他人に見せる数**であって（5.8）、
   * **本人が自分の押した作品を見る一覧**は別である。いいねの行は消さないので、
   * BAN が解ければ数にも戻る。
   *
   * # 並びは `created_at` の降順である
   *
   * 同じ秒に複数を押した場合の順序を決めるため、末尾に `game_id` を足す
   * （`src/games.ts` の一覧が `id desc` を末尾に置いているのと同じ理由——**同値の行の
   * 順序が決まっていないと、頁をめくったときに同じ作品が 2 度出たり 1 度も出なかったり
   * する**）。
   *
   * # 索引を持つ（PR #348 のレビュー指摘）
   *
   * **`(user_id, created_at desc, game_id desc)` の索引を持つ**（`likes_user_recent_idx`。
   * 表の定義はコンストラクタにある）。
   *
   * > **起票時の記述は誤りだった。** 「索引は要らない——主キー `(user_id, game_id)` で
   * > `where user_id = ?` は前方一致で引けるし、1 人が押せるのは 1 日 100 件までである」と
   * > 書いていた。**前半は正しいが、後半が理由になっていない。** 主キーは 1 人の行までは
   * > 辿れるが、**`order by created_at desc` を作れない**（主キーの 2 列目は `game_id`）。
   * > **日次の上限は 1 日の操作回数を縛るだけで、溜まった履歴の量を縛らない**——押し続けた
   * > 利用者の行は数千件になり、**その全体を呼び出しごとに並べ替える。** DO は 1 個の共有
   * > （5.8 の B1）なので、その並べ替えは**全員の単一スレッドを占有する。**
   *
   * **書き込みが 1 行増える**（このモジュール冒頭。実測で付与 1 回あたり 5 行 → 6 行）。
   * **それでも足す**——増えるのは押したときだけの 1 行で、減るのは**開くたびに全履歴を
   * 並べ替える処理**である。
   *
   * **列に `desc` を書いてあるが、昇順の索引でも同じ計画になる**（SQLite は索引を逆向きに
   * 走れる。実測で確かめた）。**それでも `order by` と同じ向きで書く**——読む側が
   * 「この索引はこの並べ替えのためにある」と 1 行で読めるようにするためである。
   *
   * @param userId 見ている利用者（**呼び出し側がセッションで確かめた id**）
   * @param limit 引く最大件数（0 以上 {@link MAX_LIKED_GAMES_PER_CALL} 以下）
   * @param offset 読み飛ばす件数（0 以上）
   * @returns 作品 id（押した新しい順）
   * @throws 引数の形が不正なとき
   */
  async likedGames(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<readonly string[]> {
    assertId(userId, 'userId');
    assertCount(limit, 'limit', MAX_LIKED_GAMES_PER_CALL);
    assertCount(offset, 'offset', Number.MAX_SAFE_INTEGER);
    return this.ctx.storage.sql
      .exec<{ game_id: string }>(LIKED_GAMES_SQL, userId, limit, offset)
      .toArray()
      .map((row) => row.game_id);
  }

  /**
   * D1 へ数を写す（5.8）。**例外で落とさず、続ける理由があれば次を予約する**
   * （{@link runSyncAlarm}。`PlayHub` と共有する）。
   */
  override async alarm(): Promise<void> {
    // **いいねが 1 件も無ければ止める。** BAN の差分も、写す数も無い。次に押されたとき
    // {@link ensureSyncAlarm} が再び予約する。
    await runSyncAlarm(
      'likes',
      this.ctx.storage,
      () => this.sync(Math.floor(Date.now() / 1000)),
      () => this.hasPendingWork(),
    );
  }

  /**
   * 同期の本体。{@link LikeHub.alarm} から呼ぶ（テストからも直接呼ぶ）。
   *
   * **DO の公開メソッドなので RPC からも呼べる**（呼べるのはバインディングを持つ Pages
   * だけ）。呼ばれても害は無い——D1 へ書くのは DO の中で数えた実数だけで、何度走っても
   * 同じ値に収まる（冪等）。窓口（`src/likes.ts`）は呼ばない。
   *
   * # 手順
   *
   * 1. D1 から BAN されている利用者を引く（{@link BANNED_USERS_SQL}）
   * 2. **同期の区間で**（`await` を挟まずに）、前回見た BAN の一覧と比べ、状態が変わった
   *    利用者の押した作品に同期待ちの印を付ける。一覧を置き換える。古い日の操作回数を
   *    消す。写す作品と、その実数を決める（{@link planCountSync}）
   * 3. D1 の `games.like_count` を上書きし、印を片付ける（{@link writeCountSync}。
   *    **写している間に変わった作品の印を末尾へ付け直す理由は、そちらにある**）
   *
   * **3 は `PlayHub` と共有する**（#377）。いいねに固有なのは 1 と 2 の BAN の扱いと、
   * 日次の操作回数の掃除だけである。
   *
   * @param at 同期の時刻（UNIX 秒）。古い日の操作回数を消す境界に使う
   * @returns 何をしたか
   */
  async sync(at: number): Promise<LikeSyncReport> {
    const today = jstDayKey(assertEpochSeconds(at));
    const banned = await this.env.DB.prepare(BANNED_USERS_SQL).all<{ id: string }>();
    const bannedNow = new Set(banned.results.map((row) => row.id));

    const sql = this.ctx.storage.sql;
    const countFor = (gameId: string): number => this.countFor(gameId);
    const plan = this.ctx.storage.transactionSync(() => {
      const known = new Set(
        sql
          .exec<{ user_id: string }>('select user_id from banned_users')
          .toArray()
          .map((row) => row.user_id),
      );
      const newlyBanned = [...bannedNow].filter((id) => !known.has(id));
      const unbanned = [...known].filter((id) => !bannedNow.has(id));
      for (const userId of [...newlyBanned, ...unbanned]) {
        sql.exec(
          'insert or ignore into dirty_games (game_id) select game_id from likes where user_id = ?',
          userId,
        );
      }
      for (const userId of newlyBanned) {
        sql.exec('insert into banned_users (user_id) values (?)', userId);
      }
      for (const userId of unbanned) {
        sql.exec('delete from banned_users where user_id = ?', userId);
      }

      // 日次の上限は当日の行しか読まない。前日以前の行は同期のたびに掃除する
      // （消すのは日が変わった後の最初の 1 回だけで、以後は 0 行）。
      sql.exec('delete from daily_ops where day < ?', today);

      return planCountSync(sql, countFor);
    });

    return await writeCountSync(
      this.ctx.storage,
      this.env.DB,
      UPDATE_LIKE_COUNT_SQL,
      plan,
      countFor,
    );
  }

  /**
   * 付与と取り消しの共通の段。
   *
   * **判定から書き込みまでを 1 つの同期トランザクションに収める。** 途中に `await` を
   * 挟まないので、同じ利用者の要求が並んで届いても、二重押しの判定と日次の上限は
   * 1 件ずつ正確に効く。**断るとき（`limited`）と状態が変わらないとき（`unchanged`）は
   * 1 行も書かない。**
   *
   * @param kind 付与か取り消しか
   * @param rawUserId 利用者
   * @param rawGameId 作品
   * @param rawAt 時刻（UNIX 秒）
   * @returns 結果
   */
  private async operate(
    kind: 'like' | 'unlike',
    rawUserId: string,
    rawGameId: string,
    rawAt: number,
  ): Promise<LikeOperationResult> {
    const userId = assertId(rawUserId, 'userId');
    const gameId = assertId(rawGameId, 'gameId');
    const at = assertEpochSeconds(rawAt);
    const day = jstDayKey(at);
    const sql = this.ctx.storage.sql;

    const outcome = this.ctx.storage.transactionSync((): LikeOperationOutcome => {
      const liked = this.hasLiked(userId, gameId);
      if ((kind === 'like') === liked) {
        return 'unchanged';
      }
      const used =
        sql
          .exec<{ ops: number }>(
            'select ops from daily_ops where user_id = ? and day = ?',
            userId,
            day,
          )
          .toArray()[0]?.ops ?? 0;
      if (used >= DAILY_OPERATION_LIMIT) {
        return 'limited';
      }

      if (kind === 'like') {
        sql.exec(
          'insert into likes (user_id, game_id, created_at) values (?, ?, ?)',
          userId,
          gameId,
          at,
        );
      } else {
        sql.exec('delete from likes where user_id = ? and game_id = ?', userId, gameId);
      }
      sql.exec(
        `insert into daily_ops (user_id, day, ops) values (?, ?, 1)
           on conflict (user_id, day) do update set ops = ops + 1`,
        userId,
        day,
      );
      sql.exec('insert or ignore into dirty_games (game_id) values (?)', gameId);
      return kind === 'like' ? 'liked' : 'unliked';
    });

    if (outcome === 'liked' || outcome === 'unliked') {
      await ensureSyncAlarm(this.ctx.storage);
    }
    return { outcome };
  }

  /**
   * 同期を続ける理由があるか（いいねが 1 件でもあるか、写し残しがあるか）。
   *
   * @returns 次の同期を予約すべきなら true
   */
  private hasPendingWork(): boolean {
    const sql = this.ctx.storage.sql;
    return (
      sql.exec('select 1 from likes limit 1').toArray().length > 0 ||
      sql.exec('select 1 from dirty_games limit 1').toArray().length > 0
    );
  }

  /**
   * 押しているか。
   *
   * @param userId 利用者
   * @param gameId 作品
   * @returns 押していれば true
   */
  private hasLiked(userId: string, gameId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec('select 1 from likes where user_id = ? and game_id = ?', userId, gameId)
        .toArray().length > 0
    );
  }

  /**
   * 作品のいいねの実数を数える。**BAN された利用者の分は数えない**（5.8）。
   *
   * BAN の一覧は同期が最後に D1 から見たものである（{@link LikeHub.sync}）。いいねの
   * 行は消さないので、解除されれば次の同期で数に戻る。
   *
   * @param gameId 作品
   * @returns 数
   */
  private countFor(gameId: string): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        `select count(*) as n from likes
          where game_id = ? and user_id not in (select user_id from banned_users)`,
        gameId,
      )
      .one().n;
  }
}
