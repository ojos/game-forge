/**
 * 招待の永続化・二重使用の防止・招待枠の残高の判定（8.1 / 7.3 / 11.1）。
 *
 * コードの生成・正規化・期限判定は `src/invite-code.ts` が持つ（#13 T3）。こちらは
 * **D1 に触る側**だけを受け持ち、「同じコードが 2 回使われないこと」を保証する。
 * 招待は 7.3 の「費用 DoS に対する一次の防波堤」であり、1 枚のコードが N 回通ると
 * 防波堤の高さが N 分の 1 になる。
 *
 * ## 二重使用を排除する方法
 *
 * **未使用であることを `SELECT` で確かめてから `UPDATE` する形にはしない。** D1 に
 * 対話的トランザクション（`BEGIN` 〜 `COMMIT` を跨いでアプリのロジックを挟む形）は
 * 無く、確認と更新の間に別のリクエストが割り込めば 2 回とも成功する。判定はすべて
 * 1 本の条件付き `UPDATE` の `WHERE` へ畳み、**影響行数（`meta.changes`）が 1 か 0 か**
 * だけで成否を決める。期限の判定も同じ `WHERE` に入れる（別途 `SELECT` で確かめると、
 * 同じ隙間がそこに開く）。
 *
 * `isInviteExpired` は **SQL の外で使う判定**（登録前の事前チェック・表示）に限る。
 * 消費の可否は SQL 側の条件が正であり、こちらは同じ境界規約（失効時刻を含めて失効）を
 * 二重に持っているだけ。境界を変えるときは両方を同時に変えること。
 *
 * ## 保存も照合も正規形だけで行う
 *
 * DB へ触る前に必ず `normalizeInviteCode` を通す。表示用の区切りや大文字小文字の
 * 揺れが混ざると、同じコードが別の行として入りうる。そうなると `code` が主キーでも
 * 二重使用は止まらない（別行なので、どちらの条件付き UPDATE も 1 行を更新する）。
 *
 * ## D1 のエラーを握り潰さない
 *
 * D1 の失敗（接続不良・制約違反）はここで捕まえず、呼び出し側の経路層へ投げる。
 * 「招待が使えなかった」（`ok: false`）と「DB が壊れている」（例外）は別の事象であり、
 * 前者へ畳むと、障害が「コードが無効です」という利用者向けの文言として出てしまい、
 * ログにも残らない。捕まえるのは `issueInvite` のコード衝突だけで、そこは
 * **再試行で回復できる**ことが理由（下記）。
 *
 * 招待の削除（取り消し）は 8.1 にも #13 にも要求が無いため作らない。BAN 時の扱い
 * （7.3 の「BAN 時は招待した側の招待枠も止める」）は運用の検討事項として残っており、
 * 決まっていない仕様を先回りして実装すると、決まったときに作り直しになる。
 */

import { computeInviteBalance, type InviteBalance } from './invite-balance.js';
import { generateInviteCode, isInviteExpired, normalizeInviteCode } from './invite-code.js';

/** `invites` の 1 行。列名は camelCase へ寄せる（SQL の外へ snake_case を漏らさない）。 */
export interface InviteRecord {
  /** 正規形の招待コード。 */
  readonly code: string;
  /** 発行者の `users.id`。 */
  readonly issuedBy: string;
  /** 使用者の `users.id`。未使用なら null。 */
  readonly usedBy: string | null;
  /** 使用時刻（UNIX 秒）。未使用なら null。 */
  readonly usedAt: number | null;
  /** 失効時刻（UNIX 秒）。無期限なら null。 */
  readonly expiresAt: number | null;
  /**
   * 発行時刻（UNIX 秒。`migrations/0034_invites_issued_at.sql`）。
   *
   * **0 は「列ができる前に発行された」**である（既存の行の埋め戻し）。残高の計算では
   * 十分に古い発行として数える（`src/invite-balance.ts`）。列ができた後の INSERT が 0 のまま
   * 残ることは無い（トリガーが時刻を入れる）。
   */
  readonly issuedAt: number;
}

/**
 * 招待コードを受け付けられない理由。
 *
 * 呼び出し側（#14 の T7）が文言と導線を出し分けられる粒度で持つ。とくに `used` と
 * `expired` は、利用者が次に取るべき行動が違う（前者は招待者へ再発行を頼む、後者は
 * 期限内に使い直す）。ひとつの「無効なコード」へ畳むと、その差が消える。
 *
 * `malformed` を `unknown` と分けているのは、桁数や文字種の誤りが**入力の打ち間違い**
 * であり、DB を引くまでもなく確定するため。招待コードの形式は利用者に見えているので、
 * ここを区別しても推測の助けにはならない。
 */
export type InviteRejection = 'malformed' | 'unknown' | 'used' | 'expired' | 'self-use';

/** 事前チェックの結果。 */
export type InviteCheck =
  | { readonly ok: true; readonly invite: InviteRecord }
  | { readonly ok: false; readonly reason: InviteRejection };

/** 消費の結果。 */
export type InviteConsumption =
  | {
      readonly ok: true;
      /** 使用済みになった後の行。 */
      readonly invite: InviteRecord;
      /** `users.invited_by` を今回書き込んだかどうか（下記「既に招待者がいる場合」）。 */
      readonly invitedByRecorded: boolean;
    }
  | { readonly ok: false; readonly reason: InviteRejection };

/** 発行を断る理由。今のところ招待枠の枯渇だけ。 */
export type InviteIssueRejection = 'quota-exhausted';

/** 発行の結果。 */
export type InviteIssuance =
  | {
      readonly ok: true;
      readonly invite: InviteRecord;
      /** 発行した後の残高。呼び出し側が数え直さずに返せるようにする。 */
      readonly balance: InviteBalance;
    }
  | {
      readonly ok: false;
      readonly reason: InviteIssueRejection;
      /** 断った時点の残高（`available` は 0）。次に戻る時刻を画面と API へ出すために返す。 */
      readonly balance: InviteBalance;
    };

/** D1 から返る生の行。 */
interface InviteRow {
  readonly code: string;
  readonly issued_by: string;
  readonly used_by: string | null;
  readonly used_at: number | null;
  readonly expires_at: number | null;
  readonly issued_at: number;
}

/** 行を引くときの列。`InviteRow` と揃える（1 か所に置き、select ごとに書き写さない）。 */
const INVITE_COLUMNS = 'code, issued_by, used_by, used_at, expires_at, issued_at';

/**
 * コード衝突時に発行を試みる回数。
 *
 * 12 桁 × 32 文字（約 60 ビット）に対し、招待制の母数（数百件）で主キーが衝突する
 * 確率は無視できる。それでも 1 回で諦めないのは、衝突が起きたときの結果が
 * 「発行できませんでした」ではなく**例外**になるためで、再試行すれば確実に回復できる
 * 事象を利用者に見せる理由がない。上限を置くのは、乱数源が壊れて同じ値を返し続ける
 * 場合に無限ループへ入らないため（その場合は例外として表面化させる）。
 */
const ISSUE_ATTEMPTS = 3;

/**
 * 行をレコードへ写す。
 *
 * @param row D1 から返った行
 * @returns レコード
 */
function toRecord(row: InviteRow): InviteRecord {
  return {
    code: row.code,
    issuedBy: row.issued_by,
    usedBy: row.used_by,
    usedAt: row.used_at,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
  };
}

/**
 * 招待コードで 1 行を引く（CRUD の R）。
 *
 * @param db D1
 * @param code 利用者が入力した招待コード（区切り・小文字を含んでよい）
 * @returns 行、または存在しない・形式が不正なら null
 */
export async function lookupInvite(db: D1Database, code: string): Promise<InviteRecord | null> {
  const normalized = normalizeInviteCode(code);
  if (normalized === null) {
    return null;
  }
  const row = await db
    .prepare(`select ${INVITE_COLUMNS} from invites where code = ?`)
    .bind(normalized)
    .first<InviteRow>();
  return row === null ? null : toRecord(row);
}

/**
 * 消費せずに招待コードの可否を判定する（登録フローの事前チェック）。
 *
 * 8.1 は登録フローを「招待コードの検証を先、Google OAuth を後」と定める。その「先」に
 * 置く判定がこれで、**まだ利用者が存在しない**（`users.id` が無い）段階で呼べる。
 *
 * **この結果は消費の可否を保証しない。** ここで `ok: true` を得てから
 * `consumeInvite` を呼ぶまでの間に、同じコードが他所で使われうる。最終的な判定は
 * `consumeInvite` の条件付き UPDATE だけが持つ。ここは OAuth へ進ませる前に
 * 明らかに無駄な往復を省くためのもので、排他の役割は持たない。
 *
 * @param db D1
 * @param code 利用者が入力した招待コード
 * @param nowSeconds 現在時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 判定結果
 */
export async function checkInvite(
  db: D1Database,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<InviteCheck> {
  if (normalizeInviteCode(code) === null) {
    return { ok: false, reason: 'malformed' };
  }
  const invite = await lookupInvite(db, code);
  if (invite === null) {
    return { ok: false, reason: 'unknown' };
  }
  if (invite.usedBy !== null) {
    return { ok: false, reason: 'used' };
  }
  if (isInviteExpired(invite.expiresAt, nowSeconds)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, invite };
}

/**
 * 招待コードを使用済みにし、`users.invited_by` を記録する。
 *
 * **このシグネチャは #14 の T7 と約束済み**（名前と引数の順序を変えない）。
 *
 * 二重使用の排除は、次の 1 本の UPDATE の影響行数だけで決める。`used_by is null` が
 * 未使用の条件、`expires_at is null or expires_at > ?` が期限内の条件（`expires_at`
 * ちょうどは失効。`isInviteExpired` の境界規約と揃えている）。SQLite は 1 文の
 * UPDATE を原子的に実行するため、同じコードへ同時に 2 本走っても、影響行数が 1 に
 * なるのは片方だけになる。
 *
 * ## `users.invited_by` をこのモジュールで記録する理由
 *
 * 8.1 の「誰が誰を呼んだかが `users.invited_by` に記録され、コミュニティの初期構造が
 * そのまま資産になる」は、**招待が使われたこと**と一体の事実である。記録を経路層
 * （T7）へ残すと、招待は使用済みなのに招待者が記録されていない行を作る経路が
 * 経路の数だけ増え、しかも後から復元できない（`invites.used_by` から辿れはするが、
 * それは `invited_by` が無くてよい理由ではなく、2 か所の食い違いを生むだけ）。
 * ここで一緒に書けば、書かれ方は 1 通りに固定される。
 *
 * D1 の `batch` は分岐できないため 1 本にまとめられない。**順序で守る。** 招待を
 * 使用済みにできたときにだけ 2 本目を撃つので、「使われていない招待で `invited_by`
 * だけが書かれる」ことは起きない。逆向き（招待は使用済みだが `invited_by` の更新が
 * 落ちる）は D1 の障害時に起こりうるが、その場合は例外が呼び出し側へ届き、
 * `invites.used_by` から復元できる。順序を逆にすると、復元の手がかりが無くなる。
 *
 * `userId` が実在しない場合は、1 本目の時点で外部キー制約（`used_by REFERENCES
 * users(id)`）が例外を投げる。**招待は消費されない**ため、先に利用者を作ってから
 * 呼ぶ順序（8.1 の登録フロー）を守れば整合する。
 *
 * ## 既に招待者がいる場合
 *
 * 2 本目は `invited_by is null` を条件にする。招待者は「最初に誰が呼んだか」であり、
 * 後から別のコードを使っても上書きしない。上書きすると 8.1 の構造が、コードを
 * 使うたびに書き換わる可変の値になる。この場合 `invitedByRecorded` は false になり、
 * 招待自体は使用済みになる（枠は消費される）。
 *
 * @param db D1
 * @param code 利用者が入力した招待コード（区切り・小文字を含んでよい）
 * @param userId 使用者の `users.id`。**この時点で行が存在していること**
 * @param nowSeconds 現在時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 消費の結果。失敗理由は呼び出し側で区別できる
 * @throws D1 の失敗（`userId` が実在しない場合の外部キー違反を含む）
 */
export async function consumeInvite(
  db: D1Database,
  code: string,
  userId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<InviteConsumption> {
  const normalized = normalizeInviteCode(code);
  if (normalized === null) {
    return { ok: false, reason: 'malformed' };
  }

  // 自分で発行したコードを自分で使うことを弾く（`issued_by <> ?`）。放置すると
  // `users.invited_by` が自分自身を指し、招待の系統に長さ 1 の閉路ができる。
  // 8.1 が資産と呼ぶのは「誰が誰を呼んだか」の構造であり、自分を指す辺はそこに
  // 何も足さないまま、辿る側のコードに閉路の考慮を強いる。
  const updated = await db
    .prepare(
      'update invites set used_by = ?, used_at = ?' +
        ' where code = ? and used_by is null and issued_by <> ?' +
        ' and (expires_at is null or expires_at > ?)',
    )
    .bind(userId, nowSeconds, normalized, userId, nowSeconds)
    .run();

  if (updated.meta.changes !== 1) {
    return { ok: false, reason: await explainRejection(db, normalized, userId, nowSeconds) };
  }

  // 使用済みにできた後の行を読み直す。UPDATE の影響行数だけでは、発行者
  // （`invited_by` に書く値）も失効時刻も分からない。読み直す時点でこの行は
  // 使用済みで確定しており、他所から書き換わることはない。
  const consumed = await lookupInvite(db, normalized);
  if (consumed === null) {
    // 主キーで更新した直後の行が消えている状態。整合しない DB を成功として
    // 返すより、例外として表面化させる。
    throw new Error(`使用済みにした招待が読み出せません: ${normalized}`);
  }

  const invitedBy = await db
    .prepare('update users set invited_by = ? where id = ? and invited_by is null')
    .bind(consumed.issuedBy, userId)
    .run();

  return { ok: true, invite: consumed, invitedByRecorded: invitedBy.meta.changes === 1 };
}

/**
 * 条件付き UPDATE が 0 行だった理由を調べる。
 *
 * **排他の判断には使わない。** 排他は影響行数で既に決まっており、これは利用者へ返す
 * 文言を選ぶためだけの読み取り。読み直す時点で行の状態が更に変わっていることは
 * ありうる（例: 直後に他所が使用済みにした）。その場合に報告する理由がずれるが、
 * 「使えなかった」という結論は変わらない。
 *
 * @param db D1
 * @param normalized 正規形の招待コード
 * @param userId 使用者の `users.id`
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 断った理由
 */
async function explainRejection(
  db: D1Database,
  normalized: string,
  userId: string,
  nowSeconds: number,
): Promise<InviteRejection> {
  const invite = await lookupInvite(db, normalized);
  if (invite === null) {
    return 'unknown';
  }
  if (invite.usedBy !== null) {
    return 'used';
  }
  if (isInviteExpired(invite.expiresAt, nowSeconds)) {
    return 'expired';
  }
  if (invite.issuedBy === userId) {
    return 'self-use';
  }
  // ここへ来るのは、UPDATE が弾いた条件がこの読み取りまでの間に消えた場合だけで、
  // 実際に起こすには「使用済みの取り消し」や「期限の延長」といった、このモジュールが
  // 持たない書き込みが要る。それでも排他に負けたこと自体は影響行数で確定している
  // ため、`ok: true` へ倒す選択肢は無い。競合の実体として最も近い `used` を返す。
  return 'used';
}

/**
 * 発行者の招待の発行時刻を、すべて返す（残高の計算の入力）。
 *
 * 使用済みも期限切れも含める。**枠を減らすのは「発行したこと」であって、「使われたこと」
 * ではない**（8.1）。未使用のまま期限が切れたコードを数えないと、期限付きで発行しては
 * 切らす、を繰り返すだけで無制限に配れる。`invites_issued_by_idx` で行を絞る。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @returns 発行時刻（UNIX 秒。並びは保証しない）
 */
async function listIssuedAt(db: D1Database, issuedBy: string): Promise<number[]> {
  const rows = await db
    .prepare('select issued_at from invites where issued_by = ?')
    .bind(issuedBy)
    .all<{ issued_at: number }>();
  return rows.results.map((row) => row.issued_at);
}

/**
 * 発行者が発行した招待を、発行者向けの一覧として返す。
 *
 * **1 人の招待は多くても数十行**（8.1。30 日に 1 本の速さ）で、件数の上限も改ページも
 * 置かない。**残高は、この一覧の `issuedAt` から数え直さずに計算できる**
 * （`src/invite-issuance.ts`）。
 *
 * 並び順は `code` のままにする（#396 で `issued_at` を足したが、並びは変えていない）。
 * 列ができる前の行はすべて `issued_at = 0` で、時刻順にしても古い行どうしの順は決まらない。
 * 順序を指定しなければ SQLite の返す順は保証されず、再読み込みのたびに並びが変わりうる。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @returns 発行した招待（コード順）
 */
export async function listIssuedInvites(
  db: D1Database,
  issuedBy: string,
): Promise<readonly InviteRecord[]> {
  const rows = await db
    .prepare(`select ${INVITE_COLUMNS} from invites where issued_by = ? order by code`)
    .bind(issuedBy)
    .all<InviteRow>();
  return rows.results.map(toRecord);
}

/**
 * 招待枠の残高を読む（8.1。計算は `src/invite-balance.ts`）。
 *
 * **容量は引数で受け取る。** 容量は経路層の定数（`INVITE_QUOTA`）で、招待枠の停止中（#40）は
 * 経路層が 0 を渡す。ここで定数を読むと、停止を「0 を渡す」ことで表す設計が崩れる。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @param capacity 溜まる上限（0 以上の整数）
 * @param nowSeconds 現在時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 残高と次に戻る時刻
 * @throws `capacity` が 0 以上の整数でない場合、または D1 の失敗
 */
export async function readInviteBalance(
  db: D1Database,
  issuedBy: string,
  capacity: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<InviteBalance> {
  assertQuota(capacity);
  return computeInviteBalance(await listIssuedAt(db, issuedBy), capacity, nowSeconds);
}

/**
 * 招待コードを発行する（CRUD の C）。
 *
 * ## 残高の判定を INSERT の `WHERE` で守る
 *
 * **数えてから入れる形にしない**（`consumeInvite` と同じ理由）。数えた後に別の要求が
 * 発行すれば、上限を超える。ただし残高は容量のあるバケツで（`src/invite-balance.ts`）、
 * **SQL の式 1 本では書けない。** そこで次の形にする。
 *
 * 1. 発行時刻の並びを読み、残高を計算する。0 本なら断る
 * 2. INSERT の `WHERE` に「**その人の発行件数が、読んだときの件数のまま**」を置く
 * 3. 影響行数が 0 なら、読んでから入れるまでの間に**別の要求が発行した**。読み直して 1 へ戻る
 *
 * **件数が同じなら、履歴も同じである。** `invites` の行は消さず（招待の取り消しは作らない。
 * 冒頭）、発行は行を足すだけなので、件数が変わっていなければ 1 で読んだ並びは今もそのままで、
 * 計算した残高も正しい。**判定の根拠を INSERT の 1 文に閉じ込める点は、総数の上限だった
 * ころ（`count(*) < quota`）と変わらない。**
 *
 * **競合に負けるたびに、その人の発行は 1 本増えている。** 残高は負けるたびに 1 本ずつ減るので、
 * 読み直しは容量の回数で必ず尽きる（0 本で断る側に抜ける）。それでも上限を置くのは、
 * 前提（行を消さない）が崩れたときに無限に回らないためである。
 *
 * **発行時刻は、判定に使った時刻そのものを書く。** `issued_at` の既定値 0 は「列ができる前の
 * 発行」を表す。書かなければトリガーが INSERT の時点の時刻を入れる（移行の窓の旧 Worker の
 * ため。`migrations/0034_invites_issued_at.sql`）が、それは判定に使った時刻とずれうる。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @param capacity 招待枠の溜まる上限（0 以上の整数）。呼び出し側が決める。停止中（#40）は 0
 * @param expiresAt 失効時刻（UNIX 秒）。無期限なら null（既定）
 * @param nowSeconds 発行時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 発行の結果（どちらの場合も、その時点の残高を持つ）
 * @throws `capacity` が 0 以上の整数でない場合、または D1 の失敗
 */
export async function issueInvite(
  db: D1Database,
  issuedBy: string,
  capacity: number,
  expiresAt: number | null = null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<InviteIssuance> {
  assertQuota(capacity);

  let collisions = 0;
  let conflicts = 0;
  while (conflicts <= capacity + ISSUE_ATTEMPTS) {
    const issuedAts = await listIssuedAt(db, issuedBy);
    const balance = computeInviteBalance(issuedAts, capacity, nowSeconds);
    if (balance.available < 1) {
      return { ok: false, reason: 'quota-exhausted', balance };
    }

    const code = generateInviteCode();
    try {
      const inserted = await db
        .prepare(
          'insert into invites (code, issued_by, expires_at, issued_at)' +
            ' select ?, ?, ?, ?' +
            ' where (select count(*) from invites where issued_by = ?) = ?',
        )
        .bind(code, issuedBy, expiresAt, nowSeconds, issuedBy, issuedAts.length)
        .run();

      if (inserted.meta.changes !== 1) {
        // 読んでから入れるまでの間に、同じ人の別の要求が発行した。読み直す。
        conflicts += 1;
        continue;
      }
      return {
        ok: true,
        invite: { code, issuedBy, usedBy: null, usedAt: null, expiresAt, issuedAt: nowSeconds },
        balance: computeInviteBalance([...issuedAts, nowSeconds], capacity, nowSeconds),
      };
    } catch (error) {
      // 主キーの衝突だけを再試行する。外部キー違反（発行者が実在しない）や接続の
      // 失敗を再試行しても同じ結果になり、本当の原因を隠すだけになる。
      collisions += 1;
      if (collisions >= ISSUE_ATTEMPTS || !isCodeCollision(error)) {
        throw error;
      }
    }
  }

  // 競合に負けるたびに残高は減るので、ここへは来ない。来たら「行を消さない」前提が崩れている。
  throw new Error('招待の発行が、同じ利用者の別の発行との競合に負け続けました。');
}

/**
 * 招待枠の上限として受け取れる値かを検査する。
 *
 * 不正な値を「枠が尽きた」として扱わない。`NaN` を条件式へ渡すと比較が常に偽になり、
 * **設定の誤りが「招待枠を使い切りました」という利用者向けの文言として出る**。
 * 原因の分からない枯渇ほど調べにくいものはない。
 *
 * @param quota 検査する値
 * @throws 0 以上の整数でない場合
 */
function assertQuota(quota: number): void {
  if (!Number.isSafeInteger(quota) || quota < 0) {
    throw new Error(`招待枠の上限が不正です: ${quota}`);
  }
}

/**
 * 例外が招待コードの主キー衝突かを判定する。
 *
 * D1 はエラーコードを構造化して返さないため、メッセージで判定するほかない。
 * `invites.code` まで含めて照合し、他のテーブルの一意制約を拾わないようにする。
 *
 * @param error 捕まえた例外
 * @returns 主キー衝突なら true
 */
function isCodeCollision(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: invites.code');
}
