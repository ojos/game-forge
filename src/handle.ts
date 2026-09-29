/**
 * ハンドル名の検査・予約語・保存（#381 / M12-13 / 仕様 5.10）。
 *
 * 画面と口は `src/account-handle.ts`、作者ページ（`/@handle`）は `src/users-page.ts`、綴りと形は
 * `src/handle-paths.ts` が持つ。
 *
 * ## 旧ハンドルの扱い（利用者の決定。#381 のコメント）
 *
 * - **改名から 90 日は、旧ハンドルを本人以外が取れない**（{@link HANDLE_RESERVATION_SECONDS}）。
 *   期限を過ぎたら誰でも取れる。**改名で他人が旧ハンドルを拾えると、なりすましになる**（5.10）
 * - **改名は 30 日に 1 回まで**（{@link HANDLE_RENAME_INTERVAL_SECONDS}）。囲い込める名前は、
 *   いま使っている 1 つと予約中の 3 つの最大 4 つに限られる
 * - **本人は、予約中の旧ハンドルに戻れる。** 予約は「本人以外が取れない」ためのもので、本人を締め出す
 *   理由が無い（戻れないと、改名を取り消したい人が 90 日待つか別の名前を探すことになる）。**戻るのも
 *   改名として数える**（30 日の間隔に入る）——数えないと、2 つの名前を行き来して間隔を迂回できる
 * - **初めて決めるのは改名ではない**（間隔を見ない）。ただし決めた時刻から 30 日は変えられない
 *
 * ## 同じハンドル名を 2 人が同時に取りに来ても、主キーで片方だけが勝つ
 *
 * **表は `handles` 1 つで、主キーがハンドル名である**（`migrations/` の user_handles）。{@link changeHandle} は
 * 空き具合を先に読まず、**取る INSERT をそのまま投げる。** 他人が使っている・他人が予約している名前なら、
 * INSERT が一意制約で落ち、**同じ batch の履歴と「手放す」更新も巻き戻る。** 先に読んでから書く形は、
 * 読みと書きの間にもう 1 本が入ると両方が「空いている」と読む。
 */
import type { Route } from './routes.js';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from './handle-paths.js';
import { NOT_WITHDRAWN_SQL } from './withdrawal-sql.js';

/** 1 日の秒数。 */
const SECONDS_PER_DAY = 24 * 60 * 60;

/** 改名で手放したハンドル名を、本人以外が取れない日数（90 日。利用者の決定。画面と `/privacy` の文言もこれを読む）。 */
export const HANDLE_RESERVATION_DAYS = 90;

/** {@link HANDLE_RESERVATION_DAYS} を秒にしたもの（判定に使う）。 */
export const HANDLE_RESERVATION_SECONDS = HANDLE_RESERVATION_DAYS * SECONDS_PER_DAY;

/** 改名の最短の間隔の日数（30 日。利用者の決定）。 */
export const HANDLE_RENAME_INTERVAL_DAYS = 30;

/** {@link HANDLE_RENAME_INTERVAL_DAYS} を秒にしたもの（判定に使う）。 */
export const HANDLE_RENAME_INTERVAL_SECONDS = HANDLE_RENAME_INTERVAL_DAYS * SECONDS_PER_DAY;

/** ハンドル名の表（`migrations/` の user_handles）。 */
export const HANDLES_TABLE = 'handles';

/** ハンドル名の変更の履歴の表（追記のみ。#405 の申し送り）。 */
export const HANDLE_CHANGES_TABLE = 'handle_changes';

/**
 * **手書きの予約語**——経路表から導けない語だけを並べる（5.10）。
 *
 * **経路の綴りをここへ書かない。** 経路の第 1 セグメント・admin の経路・sandbox の接頭辞・ホストのラベルは
 * {@link reservedHandlesOf} が実行時に導く（手で並べると、経路を足した日に追随が漏れる）。**ここに経路の
 * 語が入っていないことは `test/handle.test.ts` が照合する**——入っていると、その経路を消した日にも
 * 予約語として残り、「導いている」のか「書いている」のかが読めなくなる。
 *
 * ここに並べるのは、**運営やサービスそのものを名乗れてしまう語**である（`/@official` の作者ページが
 * 運営の告知に見える）。語の検査はしない（5.9。表示名は運営の印で見分ける）が、**URL はドメインの一部として
 * 読まれ、印が付かない場所（SNS に貼られた URL）でも運営に見える**ので、ここだけは語で弾く。
 *
 * **綴りの頭でだけ弾きたいものは {@link HAND_WRITTEN_RESERVED_PREFIXES} が持つ**（#778）。ここは完全一致である。
 */
export const HAND_WRITTEN_RESERVED_HANDLES: readonly string[] = [
  'official',
  'admin',
  'administrator',
  'support',
  'operator',
  'staff',
  'moderator',
  'system',
  'security',
  'help',
  'contact',
  'info',
  'root',
  'gameforge',
  'game_forge',
  // ロゴの語（#778）。**金床（`anvil`）と鍛冶場（`forge`）はロゴのシンボルそのもの**で（`docs/logo.md`）、
  // 単体でも運営の作者ページに見える。**ブランドの語なので、経路が増えても導けない。**
  'forge',
  'anvil',
];

/**
 * **手書きの予約の接頭辞**——この綴りで始まるハンドル名を、まるごと断る（#778）。
 *
 * **完全一致の {@link HAND_WRITTEN_RESERVED_HANDLES} では、運営のハンドル名（`@gameforgejp`）に寄せた綴りを
 * 数え上げきれない。** `gameforgejp2` を足せば `gameforge_news` が残り、それを足せば `gameforge2026`
 * （運営が取った X のアカウント名）が残る。**名乗れる綴りが尽きないので、列挙ではなく
 * 接頭辞で弾く**（利用者の決定。2026-09-22）。
 *
 * **判定は小文字にした後の値に掛ける**（`GameForge_JP` も断る）。**先頭でない一致は断らない**
 * （`mygameforge` は通る）——URL を読む人が運営と結びつけるのは先頭の綴りだからである。
 *
 * ## 運営自身も、いまのハンドル名を手放すと画面からは取り直せない
 *
 * **保存済みの値は再検査されない**ので、運営が持っている `gameforgejp` は影響を受けない。ただし改名すると、
 * **予約中の旧ハンドルへ戻る経路も {@link validateHandle} を通る**ので、運営も画面からは戻れなくなる。
 *
 * **例外を作らないのは、例外が「運営だけが通る抜け道」としてコードに残るからである。** `users.is_operator` を
 * 見て通す形にすると、**表示だけの列だった印がハンドル名の可否まで決めることになる**
 * （`docs/operator-account.md` 1 章の「運営だからできることは 1 つも増えません」が崩れる）。**運営が取り直すときは、
 * 印の付け外しと同じく D1 を直接書く**——運用の手順であって、画面の穴ではない（手順は
 * `docs/operator-account.md` 3.6。**2026-09-23 に `gameforge_jp` → `gameforgejp` で実際に通した**）。
 */
export const HAND_WRITTEN_RESERVED_PREFIXES: readonly string[] = ['gameforge', 'game_forge'];

/** {@link reservedHandlesOf} へ渡す、予約語の出どころ。 */
export interface ReservedHandleSources {
  /** アプリ用ホストの経路表（**本番で落とす診断経路も含めて渡す**——環境で予約語を変えない）。 */
  readonly appRoutes: readonly Route[];
  /** 管理画面ホストの経路表（2.4）。 */
  readonly adminRoutes: readonly Route[];
  /** サンドボックス用ホストの接頭辞（`/p/` / `/g/` / `/avatars/`）。 */
  readonly sandboxPrefixes: readonly string[];
  /** 3 つのホスト名（未設定の値は読み飛ばす）。 */
  readonly hosts: readonly (string | undefined)[];
  /**
   * アプリ用ホストで、**経路表の外**が持つ口（MCP の認可の部品の `/token`・`/register`・`/mcp`・`/.well-known/...`。#696）。
   * `src/index.ts` が経路表より先に振り分けるので経路表には載らないが、名前は同じく名乗らせない。
   */
  readonly appOutsidePaths?: readonly string[];
}

/**
 * パスの第 1 セグメントを小文字で取り出す（`/works/<id>` → `works`。`/` → 空文字）。
 *
 * @param path パス（`/` で始まらなくてもよい。sandbox の接頭辞 `p` も受ける）
 * @returns 第 1 セグメント（小文字）
 */
function firstSegmentOf(path: string): string {
  return (path.replace(/^\/+/u, '').split('/')[0] ?? '').toLowerCase();
}

/**
 * ホスト名から予約語にするラベルを取り出す（**最後のラベル（TLD）を除いた全部**）。
 *
 * `app.game-forge.ojos.jp` → `app` / `game-forge` / `ojos`。**ハンドル名の形（`-` を含まない）に合わない
 * ラベルも返す**（照合するだけなので害が無い。形で絞ると、形の規則を変えた日に予約語が黙って減る）。
 *
 * @param host ホスト名（ポートが付いていてもよい）
 * @returns ラベル（小文字）
 */
function hostLabelsOf(host: string): string[] {
  const labels = host.trim().toLowerCase().replace(/:\d+$/u, '').replace(/\.$/u, '').split('.');
  return labels.slice(0, -1).filter((label) => label !== '');
}

/**
 * 予約語の一覧を導く（5.10 / #381）。**経路表から実行時に導き、手書きの語を足す。**
 *
 * 1. **アプリ用ホストの経路の第 1 セグメント**（`/works/` → `works`、`/api/...` → `api`、`/__dev/` → `__dev`）
 * 2. **管理画面ホストの経路の第 1 セグメント**（`/users` `/actions` `/takedowns`）
 * 3. **サンドボックス用ホストの接頭辞**（`/avatars/` → `avatars`）と、**アプリ用ホストで経路表の外が持つ口**
 *    （MCP の認可の部品。`/token` → `token`、`/mcp` → `mcp`。#696）
 * 4. **ホストのラベル**（`admin` / `sandbox` / `app`）
 * 5. {@link HAND_WRITTEN_RESERVED_HANDLES}
 *
 * **経路を 1 本足すと、足した経路の第 1 セグメントがそのまま予約語に入る**（`test/handle.test.ts`）。
 * **既に誰かが使っているハンドル名は取り上げない**——`/@handle` は `/` の直下の経路と綴りが衝突しない
 * （`@` が付く）ので、URL は壊れない。予約語が防ぐのは、新しく経路の名前を名乗ることである。
 *
 * **呼ぶ側は `src/app.ts` である。** ここが経路表を import すると循環参照になる（経路表はハンドル名の口を
 * 含む）ので、表は引数で受け取る。
 *
 * @param sources 予約語の出どころ
 * @returns 予約語（小文字）
 */
export function reservedHandlesOf(sources: ReservedHandleSources): ReadonlySet<string> {
  const reserved = new Set<string>();
  for (const route of [...sources.appRoutes, ...sources.adminRoutes]) {
    reserved.add(firstSegmentOf(route.path));
  }
  for (const prefix of sources.sandboxPrefixes) {
    reserved.add(firstSegmentOf(prefix));
  }
  for (const path of sources.appOutsidePaths ?? []) {
    reserved.add(firstSegmentOf(path));
  }
  for (const host of sources.hosts) {
    if (host !== undefined) {
      for (const label of hostLabelsOf(host)) {
        reserved.add(label);
      }
    }
  }
  for (const word of HAND_WRITTEN_RESERVED_HANDLES) {
    reserved.add(word);
  }
  reserved.delete('');
  return reserved;
}

/** ハンドル名を受け付けなかった理由（`/account/handle?reason=` に載る綴り）。 */
export type HandleRejection = 'handle-empty' | 'handle-invalid' | 'handle-length' | 'handle-reserved';

/** ハンドル名の検査の結果。 */
export type HandleValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: HandleRejection };

/** 入力として受け付ける文字（**小文字にする前**。ASCII の英字・数字・`_` だけ）。 */
const HANDLE_INPUT_CHARACTERS = /^[A-Za-z0-9_]+$/u;

/**
 * ハンドル名を検査し、保存する形（小文字）へ落とす（5.10）。
 *
 * **判定の順:** 前後の空白を除く → 先頭の `@` を 1 つだけ除く（`@foo` と打つ人がいる）→ 空 → 文字 →
 * 長さ → 予約語（完全一致と、{@link HAND_WRITTEN_RESERVED_PREFIXES} の接頭辞）。
 *
 * ## 小文字にするのは、文字を確かめた後である
 *
 * **`String#toLowerCase` は ASCII の外の文字を ASCII へ落とすことがある**——ケルビン記号（U+212A `K`）は
 * `k` に、トルコ語の `İ`（U+0130）は `i` と結合文字の 2 文字になる。**先に小文字にしてから許可リストで
 * 確かめると、`K` を含む見た目の違う入力が `k` のハンドル名として通る。** 許可リストは小文字にする前の
 * 入力に掛け、ASCII の英字・数字・`_` だけを通してから小文字にする。
 *
 * **全角英数・ゼロ幅の文字・文字の向きを変える書式文字は、許可リストの外なので構造的に落ちる**
 * （5.9 の表示名の検査が禁じる文字を並べているのに対し、こちらは通す文字だけを書く）。
 *
 * @param raw フォームから受け取った値
 * @param reserved 予約語（{@link reservedHandlesOf}）
 * @returns 保存する値（小文字）、または断る理由
 */
export function validateHandle(raw: string, reserved: ReadonlySet<string>): HandleValidation {
  const trimmed = raw.trim();
  const unprefixed = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (unprefixed === '') {
    return { ok: false, reason: 'handle-empty' };
  }
  if (!HANDLE_INPUT_CHARACTERS.test(unprefixed)) {
    return { ok: false, reason: 'handle-invalid' };
  }
  if (unprefixed.length < HANDLE_MIN_LENGTH || unprefixed.length > HANDLE_MAX_LENGTH) {
    return { ok: false, reason: 'handle-length' };
  }
  const value = unprefixed.toLowerCase();
  if (reserved.has(value) || HAND_WRITTEN_RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return { ok: false, reason: 'handle-reserved' };
  }
  return { ok: true, value };
}

/** ハンドル名の書き込みの結果。 */
export type HandleChange =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'handle-too-soon' | 'handle-taken' };

/**
 * D1 の例外が、ハンドル名の主キーの一意制約で落ちたことを示すか。
 *
 * **綴りは列名までで、値を含まない**（`src/invites.ts` / `src/reports.ts` と同じ判定の形）。
 *
 * @param error catch した値
 * @returns 主キーの衝突なら true
 */
function isHandleTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${HANDLES_TABLE}.handle`);
}

/**
 * ハンドル名を書き込む（初めて決める・改名する・予約中の旧ハンドルへ戻る）。
 *
 * ## 1 つの `D1.batch` で 4 文を書き、断る判定は WHERE と主キーに置く
 *
 * 1. **期限の切れた予約（誰のものでも）と、本人の予約を消す**（取る名前の行だけ）
 * 2. **履歴を積む**（旧いハンドル名は手放す前の行からしか取れないので、先に置く）
 * 3. **いま使っている行を手放す**（`released_at` を入れる。行は予約として残る）
 * 4. **取る**（INSERT。**他人が使っている・予約している名前ならここが主キーで落ち、1〜3 も巻き戻る**）
 *
 * **1〜3 は同じ条件 G を共有する**——「本人のいま使っている行が、取ろうとしている名前でも、30 日より
 * 新しくもない」。G が偽（間隔が足りない・同じ名前の入れ直し）なら 1〜3 は 0 行で、4 も本人のいま使って
 * いる行が残っているので 0 行になる。**断った変更で履歴を書かない**（#405 の申し送り）。G は 1〜3 の
 * どれよりも前の状態を見る（1 は本人のいま使っている行を触らず、2 は `handle_changes` にしか書かない）。
 *
 * **0 行で終わったときだけ、理由を分けるために 1 回読む**（`src/account.ts` の
 * `changeForkNoticePreference` と同じ形）。同じ名前なら成功（変更なし）、それ以外は間隔が足りない。
 *
 * **BAN の検査はここに無い。** 呼び出し側が `resolveSessionUser` を通した後にしか呼ばない。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @param handle 検査済みのハンドル名（{@link validateHandle} の `value`。小文字）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 書いたか、断った理由
 * @throws 主キーの衝突以外の D1 の失敗
 */
export async function changeHandle(
  db: D1Database,
  userId: string,
  handle: string,
  nowSeconds: number,
): Promise<HandleChange> {
  // **条件 G の綴りを 1 つにする**（`src/account.ts` の `changeDisplayName` と同じ理由）。
  //
  // **退会した行では 1 文も当たらない**（#518 の PR #589 の Copilot の指摘。`src/withdrawal-sql.ts`）。
  // 入口の `resolveSessionUser` を通った後に別のタブで退会が確定すると、**退会が 90 日の予約へ移した
  // ハンドル名を、通過済みの要求が取り直せてしまう**（履歴も 1 行積まれる）。**束縛が 1 つ増える**
  // （末尾に利用者の id）。
  const guard = `not exists (select 1 from ${HANDLES_TABLE}
                              where user_id = ? and released_at is null and (handle = ? or claimed_at > ?))
                 and exists (select 1 from users where id = ? and ${NOT_WITHDRAWN_SQL})`;
  const guardBindings = [userId, handle, nowSeconds - HANDLE_RENAME_INTERVAL_SECONDS, userId] as const;

  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `delete from ${HANDLES_TABLE}
            where handle = ? and released_at is not null and (user_id = ? or released_at <= ?) and ${guard}`,
        )
        .bind(handle, userId, nowSeconds - HANDLE_RESERVATION_SECONDS, ...guardBindings),
      db
        .prepare(
          `insert into ${HANDLE_CHANGES_TABLE} (id, user_id, old_handle, new_handle, changed_at)
           select ?, ?, (select handle from ${HANDLES_TABLE} where user_id = ? and released_at is null), ?, ?
            where ${guard}`,
        )
        .bind(crypto.randomUUID(), userId, userId, handle, nowSeconds, ...guardBindings),
      db
        .prepare(`update ${HANDLES_TABLE} set released_at = ? where user_id = ? and released_at is null and ${guard}`)
        .bind(nowSeconds, userId, ...guardBindings),
      db
        .prepare(
          // **4 番目にも退会の条件を置く。** ここだけは G を使わない（いま使っているハンドル名が
          // 無いことだけを見る）ので、置かないと**退会でハンドル名を手放した行が、そのまま新しい
          // 名前を取れてしまう**（1〜3 が 0 行でも、この文だけが当たる）。
          `insert into ${HANDLES_TABLE} (handle, user_id, claimed_at)
           select ?, ?, ?
            where not exists (select 1 from ${HANDLES_TABLE} where user_id = ? and released_at is null)
              and exists (select 1 from users where id = ? and ${NOT_WITHDRAWN_SQL})`,
        )
        .bind(handle, userId, nowSeconds, userId, userId),
    ]);
  } catch (error) {
    if (isHandleTaken(error)) {
      return { ok: false, reason: 'handle-taken' };
    }
    throw error;
  }

  // **添字で読む**（`noUncheckedIndexedAccess`）。**行数は `> 0` で比べる**（トリガが `meta.changes` を
  // 膨らませうる。`docs/handoff.md` 4 章）。
  const claimed = (results[3]?.meta.changes ?? 0) > 0;
  const historyRows = results[1]?.meta.changes ?? 0;
  if (claimed) {
    if (historyRows === 0) {
      // **構造上ありえない**（履歴と取る INSERT は同じ状態から G で決まる）。出るとすれば D1 の batch の
      // 意味が変わったときで、それは気づきたい。
      console.error('[handle] ハンドル名を取ったのに履歴が入りませんでした（batch の意味が変わっています）');
    }
    return { ok: true, changed: true };
  }

  const current = await currentHandleOf(db, userId);
  return current !== null && current.handle === handle
    ? { ok: true, changed: false }
    : { ok: false, reason: 'handle-too-soon' };
}

/** 利用者がいま使っているハンドル名。 */
export interface CurrentHandle {
  /** ハンドル名（小文字）。 */
  readonly handle: string;
  /** 取った時刻（UNIX 秒）。**次に変えられるのは、これに {@link HANDLE_RENAME_INTERVAL_SECONDS} を足した時刻。** */
  readonly claimedAt: number;
}

/**
 * 利用者がいま使っているハンドル名を引く（無ければ null）。
 *
 * **部分索引（`handles_user_current_idx`）の 1 行を引く**（`user_id = ? and released_at is null`）。
 *
 * @param db D1 バインディング
 * @param userId 利用者の id
 * @returns いま使っているハンドル名（無ければ null）
 */
export async function currentHandleOf(db: D1Database, userId: string): Promise<CurrentHandle | null> {
  const row = await db
    .prepare(`select handle, claimed_at from ${HANDLES_TABLE} where user_id = ? and released_at is null`)
    .bind(userId)
    .first<{ handle: string; claimed_at: number }>();
  return row === null ? null : { handle: row.handle, claimedAt: row.claimed_at };
}
