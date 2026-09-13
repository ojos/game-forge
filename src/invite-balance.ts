/**
 * 招待枠の残高の計算（8.1 v1.55 / #355 / #396）。
 *
 * **招待枠は 3 本まで溜まり、使うと 30 日ごとに 1 本ずつ戻る。** 残高は列に持たず、
 * **発行時刻の並び（`invites.issued_at`）と現在時刻から毎回計算する**（8.1「残高は計算して
 * 出す」）。ここはその計算だけを持つ**純粋関数の葉**で、D1 にも時計にも触らない——
 * 境界（ちょうど 30 日）を、時刻を固定したテストで確かめられるようにするためである。
 *
 * ## 数え方（容量のあるバケツ）
 *
 * 残高を「**1 本 / 30 日の速さで連続的に溜まり、上限で溢れた分は消える量**」として追う。
 * 発行するたびに 1 本分を引く。**満杯のあいだの回復は捨てる**（繰り越さない）ので、
 * **次の 1 本が戻るのは、減った時点から 30 日後**になる（8.1。満杯のまま 90 日置いてから
 * 1 本使った人の次の回復は、発行の 30 日後）。続けて使ったときは 1 本ずつ順に戻る——
 * 100 日目と 115 日目に 1 本ずつ使えば、戻るのは 130 日目と 160 日目である。
 *
 * **浮動小数を使わない。** 1 本を `INVITE_RECOVERY_SECONDS` 秒ぶんの持ち分として、
 * 整数の秒で数える。30 日ちょうどで 1 本戻ることを、丸めの誤差に左右させない。
 *
 * ## 登録日時を使わない
 *
 * 8.1 は「登録日時と発行履歴から」計算すると書くが、**登録直後は 3 本すべて使える**
 * （満杯から始まる）以上、**最初の発行より前の時刻は残高に効かない。** 満杯のバケツは
 * どれだけ置いても満杯のままだからである。登録日時を引数に取ると、結果を変えない
 * 読み取り（`users.created_at`）が 1 回増えるだけになる。
 *
 * ## 時刻は UTC の経過秒で判定する
 *
 * 「30 日」は暦の日付（日本時間の 0 時の切り替わり）ではなく、**発行からの経過秒**で決める。
 * 生成枠（4.3）のように日付で区切ると、23 時 59 分に使った人と 0 時 1 分に使った人で
 * 待たされる長さが 1 日ずれる。**画面に出すときだけ日本時間へ直す**（`src/jst.ts`）。
 */

/** 1 本が戻るまでの日数。仕様 8.1 の「30 日ごとに 1 本」と機械照合する（`test/invite-issuance.test.ts`）。 */
export const INVITE_RECOVERY_DAYS = 30;

/** `INVITE_RECOVERY_DAYS` を秒にしたもの。 */
export const INVITE_RECOVERY_SECONDS = INVITE_RECOVERY_DAYS * 24 * 60 * 60;

/** 招待枠の残高。 */
export interface InviteBalance {
  /** いま発行できる本数（0 以上、容量以下）。 */
  readonly available: number;
  /**
   * 次の 1 本が戻る時刻（UNIX 秒）。**満杯なら null**（戻る先が無い）。
   *
   * 容量が 0（招待枠の停止中。#40）のときも null である——待っても戻らない。
   */
  readonly nextRecoveryAt: number | null;
}

/**
 * 発行時刻の並びから、いまの残高と次に戻る時刻を計算する。
 *
 * 発行時刻は**並んでいなくてよい**（ここで並べ替える）。現在時刻より後の発行時刻
 * （時計のずれ）があっても、経過時間を負として数えない——バケツを時間で減らす形に
 * しないためである。
 *
 * **履歴が容量を超えて発行していても例外にしない。** 過去に上限を超えて発行された行
 * （同時の要求をすり抜けた行など）は、その分を「借り」として持ち越す。0 で打ち止めにすると、
 * 超えて発行した人ほど早く枠が戻ることになる。
 *
 * @param issuedAts その人の招待の発行時刻（UNIX 秒）
 * @param capacity 溜まる上限（0 以上の整数）。招待枠の停止中（#40）は 0 を渡す
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 残高と次に戻る時刻
 * @throws `capacity` が 0 以上の整数でない場合
 */
export function computeInviteBalance(
  issuedAts: readonly number[],
  capacity: number,
  nowSeconds: number,
): InviteBalance {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    // 不正な値を「枠が尽きた」として扱わない（`src/invites.ts` の `assertQuota` と同じ理由）。
    throw new Error(`招待枠の上限が不正です: ${capacity}`);
  }

  if (capacity === 0) {
    // 停止中は、履歴に関わらず 0 本で、戻る時刻も無い（待っても解けない。#40）。
    return { available: 0, nextRecoveryAt: null };
  }

  const full = capacity * INVITE_RECOVERY_SECONDS;
  const sorted = [...issuedAts].sort((a, b) => a - b);

  // 持ち分（秒）。満杯から始める——登録直後は 3 本すべて使える（8.1）。
  let credit = full;
  let last: number | null = null;
  for (const issuedAt of sorted) {
    if (last !== null) {
      credit = Math.min(full, credit + Math.max(0, issuedAt - last));
    }
    credit -= INVITE_RECOVERY_SECONDS;
    last = issuedAt;
  }
  if (last !== null) {
    credit = Math.min(full, credit + Math.max(0, nowSeconds - last));
  }

  if (credit >= full) {
    return { available: capacity, nextRecoveryAt: null };
  }

  // 借りがあるあいだは 0 本で、次に 1 本になるのは持ち分が 1 本分に達したときである。
  const whole = Math.max(0, Math.floor(credit / INVITE_RECOVERY_SECONDS));
  const target = (whole + 1) * INVITE_RECOVERY_SECONDS;
  return { available: whole, nextRecoveryAt: nowSeconds + (target - credit) };
}
