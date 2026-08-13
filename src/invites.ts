/**
 * 招待の永続化・二重使用の防止・招待枠の残数管理（8.1 / 7.3 / 11.1）。
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
  | { readonly ok: true; readonly invite: InviteRecord }
  | { readonly ok: false; readonly reason: InviteIssueRejection };

/** D1 から返る生の行。 */
interface InviteRow {
  readonly code: string;
  readonly issued_by: string;
  readonly used_by: string | null;
  readonly used_at: number | null;
  readonly expires_at: number | null;
}

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
    .prepare('select code, issued_by, used_by, used_at, expires_at from invites where code = ?')
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
 * 発行者が発行済みの招待の件数を数える。
 *
 * 使用済みも期限切れも含めた**発行の総数**を数える。招待枠は「同時に持てる未使用の
 * 枚数」ではなく「何人を呼べるか」であり（8.1 の「既存参加者への招待枠付与」）、
 * 使い終わった枠が戻るなら、コードを配り直すだけで無制限に呼べてしまう。
 * `invites_issued_by_idx` がこの数え上げのために張られている。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @returns 発行済みの件数
 */
export async function countIssuedInvites(db: D1Database, issuedBy: string): Promise<number> {
  const row = await db
    .prepare('select count(*) as issued from invites where issued_by = ?')
    .bind(issuedBy)
    .first<{ issued: number }>();
  return row?.issued ?? 0;
}

/**
 * 招待枠の残数を返す（表示用）。
 *
 * **上限値は引数で受け取る。** 招待枠の枚数は仕様書に定義が無く（12 章の未確定事項
 * にも挙がっていない）、ここで定数を決めると、決まったときに直す場所がモジュールの
 * 内側になる。運用で変える値なので、設定を持つ側（経路層）から渡す。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @param quota 招待枠の上限（0 以上の整数）
 * @returns 残数（0 未満にはならない）
 * @throws `quota` が 0 以上の整数でない場合
 */
export async function remainingInviteQuota(
  db: D1Database,
  issuedBy: string,
  quota: number,
): Promise<number> {
  assertQuota(quota);
  return Math.max(0, quota - (await countIssuedInvites(db, issuedBy)));
}

/**
 * 招待コードを発行する（CRUD の C）。
 *
 * 招待枠の判定は、件数を数えてから INSERT する形にしない。`consumeInvite` と同じ
 * 理由で、数えた後に別のリクエストが発行すれば上限を超える。件数の判定を INSERT の
 * `WHERE` へ畳み、**影響行数**で発行できたかを決める。
 *
 * @param db D1
 * @param issuedBy 発行者の `users.id`
 * @param quota 招待枠の上限（0 以上の整数）。呼び出し側が決める
 * @param expiresAt 失効時刻（UNIX 秒）。無期限なら null（既定）
 * @returns 発行の結果
 * @throws `quota` が 0 以上の整数でない場合、または D1 の失敗
 */
export async function issueInvite(
  db: D1Database,
  issuedBy: string,
  quota: number,
  expiresAt: number | null = null,
): Promise<InviteIssuance> {
  assertQuota(quota);

  for (let attempt = 1; attempt <= ISSUE_ATTEMPTS; attempt += 1) {
    const code = generateInviteCode();
    try {
      const inserted = await db
        .prepare(
          'insert into invites (code, issued_by, expires_at)' +
            ' select ?, ?, ?' +
            ' where (select count(*) from invites where issued_by = ?) < ?',
        )
        .bind(code, issuedBy, expiresAt, issuedBy, quota)
        .run();

      if (inserted.meta.changes !== 1) {
        return { ok: false, reason: 'quota-exhausted' };
      }
      return {
        ok: true,
        invite: { code, issuedBy, usedBy: null, usedAt: null, expiresAt },
      };
    } catch (error) {
      // 主キーの衝突だけを再試行する。外部キー違反（発行者が実在しない）や接続の
      // 失敗を再試行しても同じ結果になり、本当の原因を隠すだけになる。
      if (attempt === ISSUE_ATTEMPTS || !isCodeCollision(error)) {
        throw error;
      }
    }
  }

  // ループは必ず return か throw で抜ける。ここへ到達したら制御フローの誤り。
  throw new Error('招待コードの発行が試行回数を使い切りました。');
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
