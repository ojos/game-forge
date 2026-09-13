/**
 * 参加者の人数の上限（8.1 v1.55 / #355 / #397。M11-3）。
 *
 * **参加者が `PARTICIPANT_CAP` 人に達したら、誰も招待を発行できない。** 1 人あたりの速さ
 * （30 日に 1 本・3 本まで溜まる。#396）だけでは費用の上限を守れない——全員が枠を使うと人数は
 * 倍々に増える（8.1 の試算）。**人数の上限が、この速さに対する唯一の防波堤である。**
 *
 * ## 数え方はここにしか置かない
 *
 * `/invites` の画面と `POST /api/invites` の口は、どちらもこのモジュールの関数で数える。
 * **運営が端末で数えるスクリプト（`scripts/invite-stock.sh`）も、条件の綴り
 * `PARTICIPANT_WHERE_SQL` をここから取り出す**（書き写すと、片方だけが古くなったときに
 * 画面と端末で人数が食い違う）。
 *
 * ## 緩い締め切りである（8.1）
 *
 * **止めるのは発行だけで、使用は止めない。** 上限に達する前に発行された未使用のコードは、
 * そのあとでも使える（招待された人が、自分では分からない理由で登録できなくなるのを避ける）。
 * したがって**参加者は上限を超えうる**。超える幅はそのときの未使用のコードの本数で、運営は
 * `scripts/invite-stock.sh` でそれを数える。
 *
 * **同時の発行も排他しない。** 49 人の時点で 2 人が同時に発行しても、どちらも通りうる。
 * 発行は人数を増やさない（増えるのはコードが使われたとき）ので、上限との差はここでも
 * 「未使用のコードの本数」に吸収される。**締め切りそのものが緩い**以上、発行の判定だけを
 * 厳密にしても守れるものは増えない。
 *
 * ## 上限は生成を止めない
 *
 * 生成を止めるのは 4.3 の四層である。ここは招待の発行だけを見る。
 */

/**
 * 参加者の人数の上限。
 *
 * **環境変数にしない**（8.1。`INVITE_QUOTA` と同じ理由——環境ごとに違ってよい値ではない）。
 * 値の根拠（熱心な利用者が 3 割なら月額が 4.3 の上限に並ぶ）と見直しの契機（40 人に達した時点）は
 * 8.1 が正本で、ここへ複製しない。仕様との一致は `test/participant-cap.test.ts` が機械照合する。
 */
export const PARTICIPANT_CAP = 50;

/**
 * 「参加者」である利用者の条件（`users` の where 句。別名なし）。
 *
 * **BAN 済みは数えない**（8.1）。行を消さずに `banned_at` を立てる設計（0001）なので、
 * 数えると BAN した人数だけ上限が実質的に下がる。
 *
 * **1 行の単一引用符つきリテラルに保つ。** `scripts/invite-stock.sh` が `sed` で取り出す
 * （`scripts/report-queue.sh` が `REVIEW_QUEUED` を取り出すのと同じ形）。
 */
export const PARTICIPANT_WHERE_SQL = 'banned_at is null';

/**
 * 参加者の人数を数える。
 *
 * @param db D1
 * @returns BAN 済みを除いた利用者の人数
 * @throws D1 の失敗
 */
export async function countParticipants(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`select count(*) as participants from users where ${PARTICIPANT_WHERE_SQL}`)
    .first<{ participants: number }>();
  return row?.participants ?? 0;
}

/**
 * 参加者が上限に達しているか。
 *
 * **ちょうど上限の人数で達したとみなす**（50 人で断り、49 人なら発行できる）。
 *
 * @param db D1
 * @returns 達していれば true
 * @throws D1 の失敗
 */
export async function participantCapReached(db: D1Database): Promise<boolean> {
  return (await countParticipants(db)) >= PARTICIPANT_CAP;
}
