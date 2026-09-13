/**
 * 表示名の変更の履歴（`display_name_changes`。仕様 5.9 / 8.4 / #405）を書く側の部品。
 *
 * ## なぜ 1 か所に置くのか
 *
 * **表示名を変える経路は 2 つある**——利用者が `/account` で変える（`src/account.ts` の
 * `changeDisplayName`）のと、Google の名前への追随（`src/auth/google.ts` の
 * `refreshExistingUser`）である。**どちらも同じ形の行を、同じ「名前が実際に変わるときだけ」の
 * 条件で書く。** 2 か所に insert を書き写すと、片方だけが条件を落として「ログインのたびに
 * 1 行増える」形になりうる。
 *
 * **`src/account.ts` へ置かない。** あちらは `src/auth/google.ts` を import しており
 * （`loginRequiredRedirect`）、Google の経路からあちらを import すると循環参照になる。
 *
 * ## 規律（詳細は `migrations/0030_display_name_changes.sql`）
 *
 * - **更新と 1 つの `D1.batch` に入れ、履歴を先に置く**（旧い名前は UPDATE の前の行から取る）
 * - **履歴の WHERE は、UPDATE の WHERE に「名前が変わる」を足しただけにする**
 *   ——UPDATE が当たらない要求（頻度の上限で断られた変更）では、履歴も 0 行になる
 * - **追記のみ**（このモジュールは `insert` しか組み立てない）
 */

/** 表示名の変更の履歴を持つ表（`migrations/0030_display_name_changes.sql`）。 */
export const DISPLAY_NAME_CHANGES_TABLE = 'display_name_changes';

/**
 * 表示名の履歴を書き始めた時刻を 1 行持つ表（`migrations/0030_display_name_changes.sql`）。
 *
 * **アプリは読むだけで書かない**（migration が適用の時刻を書く）。読むのは審査キューの
 * 通報の時点の値の復元（`src/admin/report-evidence.ts`）である。
 */
export const DISPLAY_NAME_HISTORY_START_TABLE = 'display_name_history_start';

/** {@link displayNameHistoryInsert} に渡す値。 */
export interface DisplayNameHistoryInput {
  /**
   * **組にする UPDATE が `display_name` を {@link newName} へ書き換える条件**（`users` の WHERE）。
   *
   * `/account` の経路では UPDATE の WHERE そのものである。Google の経路の UPDATE は
   * `google_sub` で行を選び、`case when display_name_set_at is null` で名前を書き換えるか
   * 決めるので、**その `case` の条件まで含めて渡す**（`google_sub = ? and display_name_set_at is null`）。
   *
   * **別名を付けない `users` の列で書く**（`from users` が 1 つだけなので曖昧さが無い）。
   * **定数だけから組み立てること**——利用者の入力は {@link bindings} で渡す。
   */
  readonly where: string;
  /** {@link where} の束縛値（出てくる順）。 */
  readonly bindings: readonly (string | number)[];
  /** 書き込む新しい名前（UPDATE が `display_name` に入れる値と同じもの）。 */
  readonly newName: string;
  /** 変更の時刻（UNIX 秒）。 */
  readonly changedAt: number;
}

/**
 * 表示名の変更の履歴を 1 行積む文を組み立てる（**名前が実際に変わるときだけ積む**）。
 *
 * **呼び出し側は、同じ WHERE を持つ UPDATE を、この文の後ろに並べて 1 つの `D1.batch` で
 * 送る。** この文の条件は `where` に `display_name <> ?` を足しただけなので、
 *
 *   - UPDATE が当たらない（行が無い・頻度の上限で断った）→ **この文も 0 行**
 *   - UPDATE は当たるが名前が変わらない（同じ名前の入れ直し・名前の変わらないログイン）→
 *     **この文は 0 行**
 *   - 名前が変わる → **1 行**
 *
 * になる。**逆（履歴が入ったのに名前が変わらない）は、同じ batch の中で 2 文が同じ行を
 * 見る限り起こらない。**
 *
 * @param db D1 バインディング
 * @param input 対象の選び方・新しい名前・時刻
 * @returns 準備済みの文
 */
export function displayNameHistoryInsert(
  db: D1Database,
  input: DisplayNameHistoryInput,
): D1PreparedStatement {
  return db
    .prepare(
      `insert into ${DISPLAY_NAME_CHANGES_TABLE}
              (id, user_id, old_display_name, new_display_name, changed_at)
       select ?, id, display_name, ?, ?
         from users
        where ${input.where} and display_name <> ?`,
    )
    .bind(crypto.randomUUID(), input.newName, input.changedAt, ...input.bindings, input.newName);
}
