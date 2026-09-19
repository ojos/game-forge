/**
 * 退会のうち、**押した要求の中で済ませる処理**（仕様 3.7 / 5.10 / #518 / M15-3。土台は #586）。
 *
 * **この issue の時点では、利用者が押せる口が無い。** 呼ぶのは後続の処理
 * （`src/withdrawal-purge.ts` が「始めて 10 分たった処理中の要求」を代わりに打つとき）と
 * テストだけである。確認画面・`POST /api/account/withdraw`・ログインの停止・法務文書は #518 が書く。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * このモジュールは束の外に置く
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **オーケストレータ Lambda の束に入るファイルへ、この SQL を 1 文も置かない。**
 * 束に入るのは `games.ts` / `revisions.ts` / `session-user.ts` / `build-cache.ts` などで
 * （一覧は `scripts/bundle-orchestrator.sh --metafile` が出す）、そこを触ると `CodeSha256` が
 * 変わり、**配り直すまで main の配備が全部止まる**（`docs/handoff.md` 4 章）。生成と推敲の
 * 競合は `migrations/0045_user_withdrawal.sql` のトリガが D1 の側で塞ぐので、アプリの SQL を
 * 変える必要が無い。**このファイルを、束に入るファイルから import しないこと。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 3 つの段と、どこで落ちても打ち直せること
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ```text
 * 段1 掴む   条件付き UPDATE 1 文   … 退会の開始・アイコンの排他・断る条件
 * 段2 R2     アイコンの現行と avatars/history/<id>/ の一覧をすべて消す
 * 段3 確定   1 batch・14 文         … 匿名化・履歴・ハンドル・台帳・作品の指示文・一括の取り下げ・withdrawn_at
 * ```
 *
 * **R2 を D1 の確定より先に消す**（`src/game-deletion.ts` と同じ向き。仕様 3.7 の規約 2）。
 * D1 を先に確定すると、R2 を消す前に落ちたときに「どのキーを消すはずだったか」を知る行
 * （`users.avatar_sha256` と排他の token）が消え、**どの行からも指されない画像が R2 に残る。**
 *
 * | 落ちた位置 | 打ち直しで起きること |
 * |---|---|
 * | 段1 の前 | 最初からやり直す |
 * | 段2 の途中 | {@link AVATAR_LOCK_SECONDS} 後に排他を取り直して消し直す |
 * | 段3 の前 | 段2 は 0 件で素通りし、段3 が確定する |
 * | 応答の前 | もう一度呼べば {@link WITHDRAWAL_ALREADY} が返る（冪等） |
 * | 利用者が押し直さない | 後続の処理が「始めて 10 分たった処理中の行」に段1〜3 を代わりに打つ |
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 確定の batch に置く 2 つの条件
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **G（{@link claimedSql}）**: この試行が排他を持つ、処理中の行である。すべての文に置く——
 * 置かないと、掴めていない行や、並行した打ち直しが先に確定した行に対して、履歴を消す文だけが
 * 当たりうる。
 *
 * **R（{@link withdrawalRecordsSql}）**: 運営の記録がある。**SQL の中で決める**
 * （`src/game-deletion.ts` の `hasRecordsSql` と同じ。`D1.batch` は 1 つのトランザクションなので、
 * 「積む文」と「消す文」は同じ瞬間の同じ条件を見て、ちょうど一方だけが当たる）。先に読んで
 * 決めてから書くと、読んだあとに届いた通報を見落として証跡を消しうる。
 *
 * **記録があるときは、匿名化したことも履歴に積む。** 通報の証跡は「履歴が無ければいまの値」で
 * 当時の表示名を復元する（`src/admin/report-evidence.ts`）。履歴を積まずに表示名だけを
 * {@link WITHDRAWN_DISPLAY_NAME} へ差し替えると、**通報された時点の名前として「退会したユーザー」が
 * 出る**——`src/game-deletion.ts` が題名について採ったのと同じ理由である。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 匿名化の値
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * | 列 | 値 | 理由 |
 * |---|---|---|
 * | `google_sub` | `'withdrawn:' \|\| id` | UNIQUE を満たし、実の sub と衝突しない。同じ Google アカウントで戻ると新しい行になり、招待が要る |
 * | `email` | `''` | 送信の経路が宛先の空で弾く（`src/mail/`） |
 * | `display_name` | {@link WITHDRAWN_DISPLAY_NAME} | id を混ぜると、それ自体が識別子になる |
 * | `x_handle` / `bio` / `profile_links` / `*_set_at` | NULL / `''` / `'[]'` / NULL | 既定値へ戻す |
 * | `avatar_sha256` / `avatar_set_at` / `avatar_lock_*` | NULL | R2 から消した事実に合わせ、排他を外す |
 * | `fork_notice_muted_at` | NULL | メール設定を空にする |
 * | `created_at` / `invited_by` / `is_operator` / `banned_at` | **残す** | 招待の行と、BAN の波及の計算を変えない |
 *
 * **`users` の行そのものは消さない**（0001 の方針。消すと `invited_by` の連鎖と、通報した
 * 記録の行き先が同時に失われる）。
 */
import type { StorageEnv } from './build-cache.js';
import { AVATAR_HISTORY_PREFIX, avatarObjectKey } from './avatar-paths.js';
import { AVATAR_LOCK_SECONDS } from './avatar.js';
import { PUBLISHED_STATUS, REMOVED_STATUS } from './games.js';
import { readSessionCookie, verifySession } from './session.js';

/**
 * 退会した利用者の表示名。
 *
 * **id を混ぜない。** 「退会したユーザー #3f2a…」のような値は、それ自体が利用者をまたいで
 * 一意な識別子になり、匿名化した意味が消える。**全員が同じ文字列**になるのが狙いである。
 *
 * **`/privacy` の文言はこの定数を読む**（#518 が書く。文字列を画面へ書き写さない）。
 */
export const WITHDRAWN_DISPLAY_NAME = '退会したユーザー';

/**
 * 匿名化した `google_sub` の接頭辞（`'withdrawn:' || id`）。
 *
 * **`users.google_sub` は UNIQUE である**（0001。`email` にも `display_name` にも UNIQUE は無く、
 * 一意を要求されるのはこの列だけ）。空にも NULL にもできないので、**実の sub と衝突しない形で
 * 一意な値**を入れる。利用者の id はもともと一意なので、接頭辞を付ければそれで足りる。
 *
 * **Google の sub は 10 進の数字列**なので、コロンを含むこの綴りとは形からして重ならない。
 */
export const WITHDRAWN_GOOGLE_SUB_PREFIX = 'withdrawn:';

/**
 * 退会が取るアイコンの排他の token の接頭辞（`'withdrawal:' + ランダムな UUID`）。
 *
 * **`migrations/0045_user_withdrawal.sql` のトリガがこの綴りを読む。** 退会を始めた利用者に
 * 対しては、`acquireAvatarLock`（`src/avatar.ts`）の排他の取得を D1 の側で飛ばす——**そうしないと、
 * 後続の処理が「R2 の接頭辞が空だ」と確かめた直後に、認証を通していた別のタブがアイコンを
 * 書きうる**（PR #588 の Copilot の指摘）。
 *
 * **トリガからは、退会の掴み（段1）と `acquireAvatarLock` を区別できない**（どちらも同じ列を
 * 書き、打ち直しでは `withdrawal_started_at` の値も動かない）。そこで、**退会が取る排他だけが
 * 名乗る**形にした。`src/avatar.ts` が作るのは素の `crypto.randomUUID()` なので衝突しない。
 *
 * **SQL の側との一致は `test/schema-withdrawal.test.ts` が機械照合する**（shared-ai-rules 12 章）。
 */
export const WITHDRAWAL_LOCK_TOKEN_PREFIX = 'withdrawal:';

/** 退会が済んだ状態。**2 回目の呼び出しも同じ値を返す**（冪等）。 */
export const WITHDRAWN = 'withdrawn';

/** 既に退会済みだった（この呼び出しは何も書いていない）。 */
export const WITHDRAWAL_ALREADY = 'already';

/**
 * 退会を断った理由。**断ったときは何も書き換えていない。**
 *
 * - `not-found` … 利用者が居ない
 * - `banned` … BAN されている（BAN の回避に使わせない。#518 の constraints）
 * - `admin` … 管理者（先に D1 で権限を外す運用にする）
 * - `generating` … 生成中・リフォージ中の作品がある（**経過時間で区切らない**）
 * - `avatar-saving` … アイコンを保存中（排他が生きている）
 * - `busy` … 読み直すあいだに状態が動いた（もう一度呼べば、上のどれかか成功になる）
 *
 * **文言の表はここに置かない。** 断り方の日本語は画面が持つ（#518）。ここは理由の語彙だけを
 * 決め、`Record<WithdrawalRejection, …>` で漏れを型に見張らせられる形にしておく。
 */
export type WithdrawalRejection =
  | 'not-found'
  | 'banned'
  | 'admin'
  | 'generating'
  | 'avatar-saving'
  | 'busy';

/** 退会の結果。 */
export type WithdrawalOutcome =
  | { readonly ok: true; readonly result: typeof WITHDRAWN | typeof WITHDRAWAL_ALREADY }
  | { readonly ok: false; readonly reason: WithdrawalRejection };

/**
 * 「運営の記録がある利用者である」を表す SQL の条件（**束縛 3 つ。すべて利用者の id**）。
 *
 * **含めるのは 3 つだけである**（#518 の本文のとおり）。
 *
 * 1. 利用者を対象とする運営の措置（`admin_actions` の `target_kind = 'user'`）
 * 2. その利用者の作品への通報（`reports`）
 * 3. その利用者の作品への削除依頼（`takedown_requests`）
 *
 * **`moderation_blocks` と `admin_actions`（`target_kind = 'game'`）は含めない**
 * （`src/game-deletion.ts` の `hasRecordsSql` とは揃わない。#518 の本文の決定で、
 * 入力の検査で止めた記録は既存の 90 日で消えるため）。
 *
 * **#460（`/privacy` の専門家の確認）の回答で変わりうる条件はここに集めてある**
 * ——変えるときに触るのは、この関数と {@link WITHDRAWN_DISPLAY_NAME} と、台帳の
 * `prompt` を空にする文だけで済む。
 *
 * @returns 条件（括弧で閉じてある）
 */
/**
 * 段0 の結果。
 *
 * - `ok` … 退会の口を通してよい（{@link withdrawUser} を呼ぶ）
 * - `unauthorized` … ログインし直してもらう（401 / ログインへの転送）
 * - `hidden` … 口そのものを無かったことにする（404）
 */
export type WithdrawalSession =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'unauthorized' | 'hidden' };

/**
 * 段0: 退会の口だけが使う認証（#518。設計の 2 章）。
 *
 * ## なぜ `resolveSessionUser` を使えないのか
 *
 * **あちらは「退会を始めた行」を拒む**（`src/session-user.ts`。#518 で足した）。拒まないと、
 * 掴んだあと確定するまでの間に別の口から書き込めてしまう。**ところが退会の口自身も同じ
 * 判定に当たる**——段2 や段3 の手前で落ちた要求を、同じ cookie で押し直せなくなる
 * （{@link withdrawUser} は打ち直しで続きから進む設計なのに、その入口が閉じる）。
 *
 * そこで**この口にだけ例外を置く。** `resolveSessionUser` の規律は 1 文字も変えない
 * ——例外を向こうへ足すと、32 か所の呼び出し全部がその例外を持つことになる。
 *
 * ## 判定
 *
 * | 行の状態 | 結果 |
 * |---|---|
 * | cookie が無い・署名が通らない | `unauthorized` |
 * | 行が無い | `unauthorized` |
 * | BAN されている | `unauthorized`（BAN の回避に使わせない。#518 の constraints） |
 * | 管理者（`is_admin`） | `hidden`（404。先に D1 で権限を外す運用にする） |
 * | 退会を始めている・退会済み | **通す**（打ち直しで続きから進む。{@link WITHDRAWAL_ALREADY}） |
 * | それ以外 | 通す |
 *
 * **運営フラグ（`is_operator`）は見ない**（#518 の J7。導線を出さないのは画面の仕事で、
 * ここで断ると運営が自分の意思で退会できなくなる）。
 *
 * **BAN と不在と署名の失敗を区別して返さない**（`resolveSessionUser` と同じ理由。
 * 区別できる応答は、任意の id が生きているかを外から確かめる手がかりになる）。**管理者だけを
 * 分けるのは、返すのが「口が無い」という同じ 404 だから**である——404 は、綴りを知らない
 * 人が受け取る応答と同じ形で、そこから読み取れるものが無い。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 通してよい利用者、または断る形
 * @throws `SESSION_SECRET` が未設定・短すぎる場合（`src/session.ts` の `importKey`）
 */
export async function resolveWithdrawalSession(
  request: Request,
  env: Env,
): Promise<WithdrawalSession> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === null) {
    return { ok: false, reason: 'unauthorized' };
  }
  const verified = await verifySession(token, env.SESSION_SECRET);
  if (!verified.ok) {
    console.error(`[withdrawal] セッションを受け付けませんでした: ${verified.reason}`);
    return { ok: false, reason: 'unauthorized' };
  }

  const row = await env.DB.prepare('select banned_at, is_admin from users where id = ?')
    .bind(verified.payload.userId)
    .first<{ banned_at: number | null; is_admin: number }>();
  if (row === null) {
    console.error('[withdrawal] セッションが指す利用者が存在しません');
    return { ok: false, reason: 'unauthorized' };
  }
  if (row.banned_at !== null) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (row.is_admin === 1) {
    return { ok: false, reason: 'hidden' };
  }
  return { ok: true, userId: verified.payload.userId };
}

export function withdrawalRecordsSql(): string {
  return `(exists (select 1 from admin_actions where target_kind = 'user' and target_id = ?)
           or exists (select 1 from reports r join games g on g.id = r.game_id where g.author_id = ?)
           or exists (select 1 from takedown_requests t join games g on g.id = t.game_id where g.author_id = ?))`;
}

/**
 * 「この試行が排他を持つ、処理中の行である」を表す SQL の条件（**束縛 2 つ: 利用者の id、排他の token**）。
 *
 * `users` を `from` に置く文では、同じ条件を WHERE へ直に書く（{@link claimedColumnsSql}）。
 *
 * @returns 条件
 */
function claimedSql(): string {
  return `exists (select 1 from users
                   where id = ? and withdrawal_started_at is not null
                     and withdrawn_at is null and avatar_lock_token = ?)`;
}

/**
 * `users` を直に引く文に置く、{@link claimedSql} と同じ条件（**束縛 1 つ: 排他の token**）。
 *
 * @returns 条件（`and` で繋げる形）
 */
function claimedColumnsSql(): string {
  return 'withdrawal_started_at is not null and withdrawn_at is null and avatar_lock_token = ?';
}

/**
 * 退会を実行する（段1〜3）。
 *
 * **この関数は権限を持たない。** 「押したのがその利用者本人か」を確かめるのは呼び出し側である
 * （#518 の `resolveWithdrawalSession`）。ここが見るのは、その行が退会してよい状態かだけである。
 *
 * **運営フラグ（`users.is_operator`）は見ない。** 公式サンプルの作者に退会の導線を出さないのは
 * 画面の仕事で（#518 の J7）、ここで断ると、運営が自分の判断で退会させたいときに D1 を直接
 * 触るしかなくなる。**管理者（`is_admin`）だけは断る**——権限を持ったまま匿名化されると、
 * その行が誰のものか分からないまま管理画面へ入れる鍵が残る。
 *
 * @param env D1 と R2
 * @param userId 退会する利用者の id
 * @param now 時刻（UNIX 秒。既定は現在時刻）
 * @returns 退会の結果
 * @throws R2 と D1 の失敗（**そのまま投げる**。打ち直せば続きからやれる）
 */
export async function withdrawUser(
  env: StorageEnv,
  userId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<WithdrawalOutcome> {
  const claim = await claimWithdrawal(env.DB, userId, now);
  if (!claim.claimed) {
    return claim.outcome;
  }

  // 段2。**消す直前に、毎回自分の token を持つことを確かめる**（`docs/takedown.md` 4.5 の順序）。
  if (!(await deleteAvatarObjects(env, userId, claim.token))) {
    // 排他を失った。段3 の G も当たらないので、**14 文を無駄に投げずに**理由を返す。
    // 打ち直せば段2 からやり直す（段1 は `coalesce` で入り直せる）。
    return await settledOutcome(env.DB, userId);
  }

  // 段3。**成功の判定は最後の文（`users` の匿名化）の行数だけを読む**——`games` を書く文は
  // トリガ（`0037` / `0045`）で `meta.changes` が膨らむ（`docs/handoff.md` 4 章）。
  const results = await env.DB.batch(finalizeStatements(env.DB, userId, claim.token, now));
  const settled = (results[results.length - 1]?.meta.changes ?? 0) > 0;
  if (settled) {
    return { ok: true, result: WITHDRAWN };
  }
  // 当たらなかったのは、並行した打ち直しが先に確定したときである。読み直して返す。
  return await settledOutcome(env.DB, userId);
}

/**
 * 段1 の結果。
 *
 * **`WithdrawalOutcome` をそのまま返さない。** 掴めた（`token` を持つ）ことと、既に退会済みで
 * 成功を返すこと（`{ ok: true, result: 'already' }`）は、どちらも「成功」だが**続きの段を走らせるか
 * どうかが逆**である。判別子を分けて、型に取り違えを見張らせる。
 */
type ClaimResult =
  | { readonly claimed: true; readonly token: string }
  | { readonly claimed: false; readonly outcome: WithdrawalOutcome };

/**
 * 段1: 退会の開始とアイコンの排他を、**条件付き UPDATE 1 文で掴む**。
 *
 * **条件はすべて WHERE に置く**（`acquireAvatarLock` / `claimDeletion` と同じ。先に読んでから
 * 書くと、その隙間に生成やアイコンの保存が入る）。
 *
 * - `banned_at is null` / `is_admin = 0` / `withdrawn_at is null`
 * - **アイコンの排他が空いている**（無いか、{@link AVATAR_LOCK_SECONDS} より古い）。段2 で R2 を
 *   触るので、アイコンの保存と同じ排他を使う——`docs/takedown.md` 4.5 が求める「排他 → 読む →
 *   消す」を、既にある仕組みでそのまま満たす
 * - **打ち直しでなければ、生成中・リフォージ中の行が無いこと。** **経過時間で区切らない**
 *   （`src/games.ts` の `inFlightGuardSql` が使う `STALE_AFTER_SECONDS` の区切りを持ち込まない）
 *   ——止まったまま残った行があると退会できないが、費用台帳のコールバックは区切りを過ぎても
 *   届きうるので、**消してよい行と区別できない**。止まった行を運営が閉じる手順は #518 の
 *   scope.out にある
 *
 * **打ち直し（`withdrawal_started_at` が既に立っている）では、進行中の検査を外す。**
 * 段1 の後で新しい生成は始まらない（`0045` のトリガ）ので、残っているとすれば掴む前から
 * 走っていた行で、それを理由に打ち直しを断つと**退会が永久に完了しない。**
 *
 * **`withdrawal_started_at` は最初に掴んだ時刻を残す**（`coalesce`）。後続の処理の「10 分」は
 * この値を読む。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param now 時刻（UNIX 秒）
 * @returns 掴めたら token、掴めなければ結果
 */
async function claimWithdrawal(db: D1Database, userId: string, now: number): Promise<ClaimResult> {
  // **接頭辞を付けて名乗る**（{@link WITHDRAWAL_LOCK_TOKEN_PREFIX}）。`0045` のトリガは、
  // これ以外の token でこの列を書く UPDATE を、退会を始めた利用者に対して飛ばす。
  const token = `${WITHDRAWAL_LOCK_TOKEN_PREFIX}${crypto.randomUUID()}`;
  const result = await db
    .prepare(
      `update users
          set withdrawal_started_at = coalesce(withdrawal_started_at, ?),
              avatar_lock_token = ?, avatar_lock_at = ?
        where id = ?
          and banned_at is null and is_admin = 0 and withdrawn_at is null
          and (avatar_lock_token is null or avatar_lock_at is null or avatar_lock_at <= ?)
          and (withdrawal_started_at is not null
               or (not exists (select 1 from games g
                                where g.author_id = users.id
                                  and g.generation_state in ('pending', 'running'))
                   and not exists (select 1 from game_revision_jobs j
                                     join games og on og.id = j.game_id
                                    where og.author_id = users.id
                                      and j.state in ('pending', 'running'))))`,
    )
    .bind(now, token, now, userId, now - AVATAR_LOCK_SECONDS)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    return { claimed: true, token };
  }
  return { claimed: false, outcome: await settledOutcome(db, userId) };
}

/**
 * 0 行で終わったときに、**理由を分けるためだけに 1 回読む**。
 *
 * **書き込みの判定には使わない**（書くかどうかは段1 の 1 文と段3 の batch が決めている。
 * `src/games.ts` の `removeGame` / `src/handle.ts` の `changeHandle` と同じ形）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @returns 退会の結果
 */
async function settledOutcome(db: D1Database, userId: string): Promise<WithdrawalOutcome> {
  const row = await db
    .prepare(
      `select u.banned_at as banned_at, u.is_admin as is_admin, u.withdrawn_at as withdrawn_at,
              u.avatar_lock_at as avatar_lock_at, u.avatar_lock_token as avatar_lock_token,
              (exists (select 1 from games g
                        where g.author_id = u.id and g.generation_state in ('pending', 'running'))
               or exists (select 1 from game_revision_jobs j
                            join games og on og.id = j.game_id
                           where og.author_id = u.id and j.state in ('pending', 'running'))) as busy_work
         from users u
        where u.id = ?`,
    )
    .bind(userId)
    .first<{
      banned_at: number | null;
      is_admin: number;
      withdrawn_at: number | null;
      avatar_lock_at: number | null;
      avatar_lock_token: string | null;
      busy_work: number;
    }>();

  if (row === null) {
    return { ok: false, reason: 'not-found' };
  }
  if (row.withdrawn_at !== null) {
    // **成功として返す**（冪等。押し直した利用者に「できません」と言わない）。
    return { ok: true, result: WITHDRAWAL_ALREADY };
  }
  if (row.banned_at !== null) {
    return { ok: false, reason: 'banned' };
  }
  if (row.is_admin === 1) {
    return { ok: false, reason: 'admin' };
  }
  if (row.busy_work === 1) {
    return { ok: false, reason: 'generating' };
  }
  if (row.avatar_lock_token !== null && row.avatar_lock_at !== null) {
    return { ok: false, reason: 'avatar-saving' };
  }
  return { ok: false, reason: 'busy' };
}

/**
 * 段2: アイコンの現行と、差し替え前の写しをすべて R2 から消す（`docs/takedown.md` 4.5）。
 *
 * **キーを D1 から写さない。** 現行は {@link avatarObjectKey}、写しは
 * `avatars/history/<user_id>/` の**一覧そのもの**から決める——`avatar_changes.history_key` は
 * 追記の記録であって R2 の実態ではなく、**D1 に記録の無い写し**（履歴の行を書く前に落ちた操作）
 * が残りうる。接頭辞で列挙すれば、それも一緒に消える。
 *
 * **接頭辞と現行のキーの綴りは `src/avatar-paths.ts` から取る**（`scripts/check-avatar-copies.sh`
 * が写しを見張っている値なので、ここへ書き写さない）。
 *
 * **消す直前に、毎回ここで排他を確かめる**（{@link purgeAvatarObjects}）。排他は
 * {@link AVATAR_LOCK_SECONDS} で切れるので、写しが多い利用者では一覧を回しているあいだに
 * 持ち主が変わりうる。**そうなったら途中で止める**——打ち直せば続きからやれる。
 *
 * @param env D1 と R2
 * @param userId 利用者の id
 * @param token 段1 で取った排他の token
 * @returns 最後まで消せたら true
 */
async function deleteAvatarObjects(env: StorageEnv, userId: string, token: string): Promise<boolean> {
  return await purgeAvatarObjects(env, userId, () => holdsWithdrawalLock(env.DB, userId, token));
}

/**
 * いまも自分が退会の排他を持っているか。
 *
 * **読めなければ持っていないとみなす**（`src/avatar.ts` の `holdsAvatarLock` と同じ向き。
 * 消すのは、持っているとはっきり分かるときだけ）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param token 段1 で取った排他の token
 * @returns 持っていれば true
 */
async function holdsWithdrawalLock(db: D1Database, userId: string, token: string): Promise<boolean> {
  try {
    const row = await db
      .prepare('select 1 as held from users where id = ? and avatar_lock_token = ?')
      .bind(userId, token)
      .first<{ held: number }>();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * ある利用者のアイコンを、現行も写しも R2 から消す。
 *
 * **消す直前に、毎回 `holds` を確かめる**（`docs/takedown.md` 4.5 の「排他 → 読む → 消す」）。
 * 1 回だけ確かめてから一覧を回すと、**排他は 60 秒で切れる**ので、写しが多い利用者では
 * 途中で持ち主が変わり、**別の要求がいま書いている画像を消しうる**（PR #588 の Copilot の指摘）。
 *
 * **失ったら途中で止めて `false` を返す。** 退会は打ち直せる作り（段1 の `coalesce`、段3 の G）
 * なので、止めても次の呼び出しか後続の処理が続きをやる。**消し残したまま完了の印が立つことは
 * 無い**——完了の段は接頭辞が空だと確かめてからしか立てない。
 *
 * **段2 と、後続の処理の完了の段が共有する。** 完了の段では排他をもう使えない（段3 の 13 番目が
 * 外している）ので、あちらは「まだ退会済みで未完了である」ことを `holds` に渡す。
 *
 * @param env D1 と R2
 * @param userId 利用者の id
 * @param holds 消してよいかを毎回確かめる述語
 * @returns 最後まで消せたら true（途中で権利を失ったら false）
 */
export async function purgeAvatarObjects(
  env: StorageEnv,
  userId: string,
  holds: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await holds())) {
    return false;
  }
  await env.BUCKET.delete(avatarObjectKey(userId));

  // **一覧は続きを辿る**（`list` は既定で 1000 件で切れる）。差し替えの回数に上限は無い。
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: avatarHistoryPrefixOf(userId), cursor });
    if (listed.objects.length > 0) {
      if (!(await holds())) {
        return false;
      }
      await env.BUCKET.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return true;
}

/**
 * ある利用者の、差し替え前の画像の接頭辞。
 *
 * @param userId 利用者の id
 * @returns `avatars/history/<user_id>/`
 */
export function avatarHistoryPrefixOf(userId: string): string {
  return `${AVATAR_HISTORY_PREFIX}${userId}/`;
}

/**
 * その利用者の写しが R2 に 1 つも残っていないか（後続の処理の完了の段が使う）。
 *
 * @param env D1 と R2
 * @param userId 利用者の id
 * @returns 現行も写しも無ければ true
 */
export async function avatarObjectsGone(env: StorageEnv, userId: string): Promise<boolean> {
  const current = await env.BUCKET.head(avatarObjectKey(userId));
  if (current !== null) {
    return false;
  }
  const listed = await env.BUCKET.list({ prefix: avatarHistoryPrefixOf(userId), limit: 1 });
  return listed.objects.length === 0;
}

/**
 * 段3: D1 を確定する batch の 14 文（**最後の 1 本が `users` の匿名化**）。
 *
 * **順序に意味がある。**
 *
 * 1〜3. 記録があるなら、表示名・プロフィール・アイコンを消したことを履歴に積む
 *       （`users` を書き換える前でなければ旧い値が読めない）
 * 4〜7. 記録が無いなら、4 つの履歴の表を消す
 * 8.    ハンドル名を手放す（90 日の予約へ移る。行は `handles` に残る）
 * 9.    台帳の指示文を空にする（**行数・費用・時刻は変えない**）
 * 10.   公開中の作品をすべて取り下げる
 * 11.   親の被改造数を数え直す（10 で減った分）
 * 12.   同じメールアドレスの待機リストを消す（**11 までに `users.email` を読み終えている**）
 * 13.   `users` を匿名化し、`withdrawn_at` を立て、排他を外す
 *
 * **13 を最後にする。** これが当たると G が偽になり、以降の打ち直しは 1〜12 を素通りする。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param token 段1 で取った排他の token
 * @param now 時刻（UNIX 秒）
 * @returns 準備済みの文（14 本。#694 で作品の指示文を消す 1 本を足した）
 */
function finalizeStatements(
  db: D1Database,
  userId: string,
  token: string,
  now: number,
): D1PreparedStatement[] {
  const records = [userId, userId, userId] as const;
  const guard = claimedSql();
  const guardBindings = [userId, token] as const;
  const columns = claimedColumnsSql();

  return [
    // 1. 表示名を消したことを積む（**同じ名前なら積まない**。`display_name_changes` の
    //    「古い名前とは必ず違う」を守る）。
    db
      .prepare(
        `insert into display_name_changes (id, user_id, old_display_name, new_display_name, changed_at)
         select ?, id, display_name, ?, ?
           from users
          where id = ? and ${columns} and display_name <> ? and ${withdrawalRecordsSql()}`,
      )
      .bind(crypto.randomUUID(), WITHDRAWN_DISPLAY_NAME, now, userId, token, WITHDRAWN_DISPLAY_NAME, ...records),
    // 2. 自己紹介と外部リンク（どちらも既定値なら積まない——変わらない）。
    db
      .prepare(
        `insert into profile_changes (id, user_id, old_bio, new_bio, old_links, new_links, changed_at)
         select ?, id, bio, '', profile_links, '[]', ?
           from users
          where id = ? and ${columns} and (bio <> '' or profile_links <> '[]')
            and ${withdrawalRecordsSql()}`,
      )
      .bind(crypto.randomUUID(), now, userId, token, ...records),
    // 3. アイコン（**`history_key` は NULL**——写しは段2 で消してあり、指す先が無い）。
    db
      .prepare(
        `insert into avatar_changes (id, user_id, old_sha256, new_sha256, history_key, changed_at)
         select ?, id, avatar_sha256, null, null, ?
           from users
          where id = ? and ${columns} and avatar_sha256 is not null and ${withdrawalRecordsSql()}`,
      )
      .bind(crypto.randomUUID(), now, userId, token, ...records),
    // 4〜7. 記録が無ければ、4 つの履歴の表を消す。
    db
      .prepare(`delete from display_name_changes where user_id = ? and ${guard} and not ${withdrawalRecordsSql()}`)
      .bind(userId, ...guardBindings, ...records),
    db
      .prepare(`delete from profile_changes where user_id = ? and ${guard} and not ${withdrawalRecordsSql()}`)
      .bind(userId, ...guardBindings, ...records),
    db
      .prepare(`delete from avatar_changes where user_id = ? and ${guard} and not ${withdrawalRecordsSql()}`)
      .bind(userId, ...guardBindings, ...records),
    db
      .prepare(`delete from handle_changes where user_id = ? and ${guard} and not ${withdrawalRecordsSql()}`)
      .bind(userId, ...guardBindings, ...records),
    // 8. ハンドル名を手放す（**行は予約として残る**。改名と同じ 90 日。`src/handle.ts`）。
    db
      .prepare(`update handles set released_at = ? where user_id = ? and released_at is null and ${guard}`)
      .bind(now, userId, ...guardBindings),
    // 9. 台帳の指示文を空にする（**退会のときだけ**。作品の削除では残す。#518 の利用者の決定）。
    db
      .prepare(`update generations set prompt = '' where user_id = ? and prompt <> '' and ${guard}`)
      .bind(userId, ...guardBindings),
    // 9b. 作品の行に残した最初の指示文も消す（#694 / `0047`）。作品そのものは後続の処理が消すが、
    // **指示文は台帳と同じくこの時点で消す**（`/privacy` の「退会したときは指示文を削除します」）。
    db
      .prepare(`update games set prompt = null where author_id = ? and prompt is not null and ${guard}`)
      .bind(userId, ...guardBindings),
    // 10. 公開中の作品をすべて取り下げる（**中身を消すのは後続の処理**）。
    db
      .prepare(`update games set status = ? where author_id = ? and status = ? and ${guard}`)
      .bind(REMOVED_STATUS, userId, PUBLISHED_STATUS, ...guardBindings),
    // 11. 親の被改造数を数え直す（`src/games.ts` の `refreshParentForkCount` と同じ数え方）。
    db
      .prepare(
        `update games
            set fork_count = (select count(*) from games c
                               where c.parent_id = games.id and c.status = ?)
          where id in (select parent_id from games
                        where author_id = ? and parent_id is not null)
            and ${guard}`,
      )
      .bind(PUBLISHED_STATUS, userId, ...guardBindings),
    // 12. 待機リストのメールアドレス（#518 の利用者の決定）。**空の宛先は消さない。**
    db
      .prepare(
        `delete from waitlist
          where email <> ''
            and email = (select email from users where id = ? and ${columns})`,
      )
      .bind(userId, token),
    // 13. 匿名化し、`withdrawn_at` を立て、排他を外す（**最後**）。
    db
      .prepare(
        `update users
            set google_sub = ? || id, email = '', display_name = ?, display_name_set_at = null,
                x_handle = null, bio = '', profile_links = '[]', profile_set_at = null,
                avatar_sha256 = null, avatar_set_at = null,
                avatar_lock_token = null, avatar_lock_at = null,
                fork_notice_muted_at = null,
                withdrawn_at = ?
          where id = ? and ${columns}`,
      )
      .bind(WITHDRAWN_GOOGLE_SUB_PREFIX, WITHDRAWN_DISPLAY_NAME, now, userId, token),
  ];
}
