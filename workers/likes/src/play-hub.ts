/**
 * プレイ数の正本（2.3.5 / 3.6 / 5.8 / #377。M12-9）。**全作品のプレイ数を 1 個の Durable Object
 * に集める。**
 *
 * # なぜ D1 ではなくここなのか
 *
 * **3.6 は「プレイ回数を都度書くと D1 の無料枠が即座に枯れる」と名指しで禁じている。** D1 は
 * 日次の書き込み上限を超えるとアカウント全体のクエリがすべて失敗する。いいね（5.8）が既に
 * 越えた壁と同じなので、**同じ器に載せる**——正本をここに置き、**D1 へは数だけを 5 分おきに
 * 写す**（{@link PlayHub.alarm}）。
 *
 * # いいねと同じ Worker の、別のクラスにする（#377 の利用者の決定）
 *
 * **`LikeHub` と同じ Worker（`game-forge-likes`）に載せ、クラスは分ける。** 理由は 2 つある。
 *
 * - **いいねの同期と、1 本のスレッドや 1 回 40 件の同期枠を取り合わない。** プレイ数は
 *   開くたびに届くので、いいねよりはるかに多い。同じ DO に載せると、プレイ数の流入が
 *   いいねの付与と同期を待たせる
 * - **2.3.8 の分割の契機（ピーク毎秒 500 リクエスト）を、いいねとプレイ数で分けて測れる**
 *
 * **共有するのは「同期待ちの印から D1 へ写す」部分である**（`./hub.ts` の
 * `planCountSync` / `writeCountSync` / `ensureSyncAlarm` / `runSyncAlarm`）。受け口・記録の
 * 形・連打の畳み方は新しく設計した（issue #377 の「着手前に決めること」の 2）。
 *
 * **DO の無料枠はアカウント共通である。** 尽きれば止まるのは**いいねとプレイ数の両方**で、
 * D1（生成・ログイン）は巻き込まれない。
 *
 * # 利用者を知らない
 *
 * **誰が遊んだかを記録しない**（issue #377 の scope.out。利用者ごとの履歴を持たない）。
 * 受け取るのは作品 id だけで、未ログインの閲覧者の起動も同じく数える。**連打を畳むのは
 * 呼び出し側**（作品ページのスクリプトが sessionStorage で畳む。`src/plays.ts`）であり、
 * ここは届いた分を 1 ずつ足すだけである。**数え漏れも数えすぎも許す**——プレイ数は会計では
 * ない（5.8 が同じ判断をしている）。
 *
 * # 公開の入口を持たない
 *
 * **Pages（`src/plays.ts`）がバインディングで直接呼ぶ。** `game-forge-likes` の公開の入口を
 * 閉じている宣言（`workers/likes/wrangler.toml` の冒頭）は、ここにもそのまま効く。受け取る
 * 作品 id を「公開済みの作品か」と確かめるのは呼び出し側の責務である。
 *
 * # 書き込みの行数（3.6 の表の根拠）
 *
 * **計上 1 回で、DO の SQLite へ最大 3 行**（`test/play-hub.test.ts` が SQLite の
 * `rowsWritten` で実測している）。内訳は、作品ごとの累計の行（`without rowid` なので 1 行）＋
 * 同期待ちの印（`dirty_games` は rowid 表なので、行と `game_id` の自動索引で 2 行）。**印が
 * 既にある作品なら 1 行**である（`insert or ignore` は何も書かない）。
 */
import { DurableObject } from 'cloudflare:workers';
import type { CountSyncReport, LikesEnv } from './hub.js';
import {
  DIRTY_GAMES_TABLE_SQL,
  ensureSyncAlarm,
  planCountSync,
  runSyncAlarm,
  writeCountSync,
} from './hub.js';

/**
 * `games.play_count` を上書きする SQL（#377）。
 *
 * **いいねの `UPDATE_LIKE_COUNT_SQL` と同じ形である**——加算ではなく上書きにし（加算は
 * 取り残しを直せない）、**値が同じなら書かない**（`play_count <> ?`。同じ値で UPDATE しても、
 * D1 は行と索引を書いたものとして数える）。
 */
export const UPDATE_PLAY_COUNT_SQL =
  'update games set play_count = ? where id = ? and play_count <> ?';

/** 受け付ける id の最大の長さ。**防御の上限**であって、形の検査は呼び出し側が持つ。 */
const MAX_ID_LENGTH = 128;

/**
 * 作品 id の形を確かめる（防御の最後の段）。
 *
 * @param value 受け取った値
 * @returns 値そのもの
 * @throws 文字列でない・空・長すぎるとき
 */
function assertGameId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new TypeError('gameId の形が不正です');
  }
  return value;
}

/**
 * プレイ数の正本（SQLite 版の Durable Object）。
 *
 * **Pages からは RPC で呼ぶ**（`src/plays.ts`）。`fetch` は持たない。
 */
export class PlayHub extends DurableObject<LikesEnv> {
  /**
   * @param ctx DO の状態
   * @param env バインディング（`LikeHub` と同じ Worker なので同じ形）
   */
  constructor(ctx: DurableObjectState, env: LikesEnv) {
    super(ctx, env);
    // **表は `if not exists` で作る**（`LikeHub` と同じ理由。DO の SQLite には D1 の
    // マイグレーション台帳が無く、起動のたびにここが走る）。
    //
    // - plays: 作品ごとの累計。**利用者の列を持たない**（誰が遊んだかを記録しない）
    // - dirty_games: 前回の同期から数が変わった作品（同期待ちの印。`LikeHub` と同じ定義）
    ctx.storage.sql.exec(`
      create table if not exists plays (
        game_id text primary key,
        count integer not null
      ) without rowid;
      ${DIRTY_GAMES_TABLE_SQL}
    `);
  }

  /**
   * 作品のプレイを 1 回数える。
   *
   * **足すことと同期待ちの印を付けることを、1 つの同期トランザクションに収める。** 途中に
   * `await` を挟まないので、同期の区間（{@link PlayHub.sync}）と食い違わない。
   *
   * @param rawGameId 作品（**呼び出し側が「公開済みの作品」と確かめた id**）
   * @returns 数えたあとの累計
   * @throws id の形が不正なとき
   */
  async record(rawGameId: string): Promise<number> {
    const gameId = assertGameId(rawGameId);
    const sql = this.ctx.storage.sql;
    const count = this.ctx.storage.transactionSync((): number => {
      sql.exec(
        `insert into plays (game_id, count) values (?, 1)
           on conflict (game_id) do update set count = count + 1`,
        gameId,
      );
      sql.exec('insert or ignore into dirty_games (game_id) values (?)', gameId);
      return this.countFor(gameId);
    });
    await ensureSyncAlarm(this.ctx.storage);
    return count;
  }

  /**
   * 作品の累計を返す。**読むだけで、何も書かない。**
   *
   * **画面はこれを呼ばない**（D1 の `games.play_count` を読む。閲覧数で DO の枠を減らさない）。
   * 本番での確かめ（`docs/likes.md`）とテストのために置く。
   *
   * @param rawGameId 作品
   * @returns 累計（1 度も数えていなければ 0）
   */
  async playCount(rawGameId: string): Promise<number> {
    return this.countFor(assertGameId(rawGameId));
  }

  /**
   * D1 へ数を写す。**例外で落とさず、写し残しがあれば次を予約する**（`./hub.ts` の
   * `runSyncAlarm`。`LikeHub` と共有する）。
   */
  override async alarm(): Promise<void> {
    // **写し残しが無ければ止める。** いいねと違って BAN の差分を見ないので、累計の行が
    // 残っていても続ける理由が無い。次に数えたとき `ensureSyncAlarm` が再び予約する。
    await runSyncAlarm(
      'plays',
      this.ctx.storage,
      () => this.sync(),
      () => this.hasPendingWork(),
    );
  }

  /**
   * 同期の本体。{@link PlayHub.alarm} から呼ぶ（テストからも直接呼ぶ）。
   *
   * **手順は `LikeHub.sync` の後半と同じである**（同期待ちの印から 40 件を選んで実数を決め、
   * D1 の列を上書きし、写している間に変わった作品の印を末尾へ付け直す）。その部分を
   * `./hub.ts` から借りる。**何度走っても同じ値に収まる**（冪等）。
   *
   * @returns 何をしたか
   */
  async sync(): Promise<CountSyncReport> {
    const countFor = (gameId: string): number => this.countFor(gameId);
    const plan = this.ctx.storage.transactionSync(() =>
      planCountSync(this.ctx.storage.sql, countFor),
    );
    return await writeCountSync(
      this.ctx.storage,
      this.env.DB,
      UPDATE_PLAY_COUNT_SQL,
      plan,
      countFor,
    );
  }

  /**
   * 写し残しがあるか。
   *
   * @returns 次の同期を予約すべきなら true
   */
  private hasPendingWork(): boolean {
    return this.ctx.storage.sql.exec('select 1 from dirty_games limit 1').toArray().length > 0;
  }

  /**
   * 作品の累計を数える。
   *
   * @param gameId 作品
   * @returns 累計
   */
  private countFor(gameId: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>('select count from plays where game_id = ?', gameId)
        .toArray()[0]?.count ?? 0
    );
  }
}
