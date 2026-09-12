/**
 * 運営の操作と、その履歴（`admin_actions`。仕様 2.4.3 / 2.4.4 / #361）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * このモジュールが持つ唯一の規律: 操作と履歴を 1 つの batch で書く
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **画面から状態を動かす経路は、すべてここを通る。** 通らない経路を作らないこと
 * ——`games.review_state` や `users.banned_at` を直接 UPDATE するハンドラを書けば、
 * **履歴の無い操作**ができてしまう。それは 2.4.4 が求めている記録を、静かに穴の開いた
 * ものにする（**穴が開いたことは、記録を読んでも分からない**）。
 *
 * **1 つの `D1.batch` で書く。** batch は 1 つのトランザクションなので、
 * **履歴の insert が落ちれば操作の update ごと巻き戻る**（`test/admin-actions.test.ts`
 * が、理由を空にして insert を CHECK で落とし、作品の状態が動いていないことを見る）。
 * 2 回に分けて書く形は、**間で落ちたときに「操作だけ入って履歴が無い」状態を残す。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 逆向き（操作していないのに履歴が残る）も塞ぐ
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **履歴の insert に `where exists (...)` を付ける。** 条件は「**操作した後の状態に
 * なっていること**」で、対象が存在しないとき（id の打ち間違い・消えた行）は
 * **1 行も入らない。**
 *
 * **`changes()` は使わない。** 直前の UPDATE が当たったかを SQLite の関数で見る形は
 * 手元では動くが、**当たらなかったときに履歴だけが落ちる**（＝操作は入るのに履歴が
 * 無い）向きで壊れうる。**D1 の本番で同じ意味になることを、こちらの検査では
 * 確かめられない**——確かめられないものを、いちばん守りたい不変条件の土台に置かない。
 * `exists` なら**素の SQL の意味だけで決まる。**
 *
 * **代わりに引き受けたこと。** 既にその状態になっている対象へもう一度同じ操作を送ると、
 * **状態は動かないが履歴は 1 行積む**（{@link AdminWriteOutcome} の `changed: false`）。
 * **これは正しい記録である**——運営は確かにその操作を行っており、2.4.4 は「取り消しも
 * 1 行として積む」と定めている。画面は「既にその状態でした」と伝える。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 追記のみ（保証できるのは画面と口までである）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **このモジュールは `admin_actions` へ `insert` しか書かない。** `update` も `delete` も
 * 1 文も持たず、ほかのモジュールからこの表を書く経路も無い。
 *
 * **しかし端末からの `wrangler d1 execute` は防げない。** 資格情報を持つ人に対しては
 * 改竄できる——その資格情報は `users.is_admin` を立てられるもの（0025）と同じであり、
 * **この機構より上位にある。** 限界の全文は `migrations/0026_admin_actions.sql` の
 * 「追記のみであり、保証できるのは画面と口までである」と `docs/admin-host.md` の
 * 「限界」にある。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 置かない操作
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **作品の取り下げ（`games.status = 'removed'`）を書く関数をここへ足さないこと**
 * （2.4.3。戻せない操作であり、公開 URL が死ぬ）。`ADMIN_ACTIONS` にも
 * `migrations/0026` の CHECK にも綴りが無いので、**足しても履歴が書けずに batch ごと
 * 落ちる**——足せないことが構造で担保されている。
 *
 * **運営フラグ（`is_operator`）と管理者（`is_admin`）を書く関数も置かない**（2.4.2 /
 * 2.4.3）。引き続き D1 への直接 UPDATE で行う（`docs/admin-host.md`）。
 */
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../reports.js';
import type { ReviewState } from '../reports.js';

/**
 * 履歴に残す操作の綴り（**正本**）。
 *
 * **`migrations/0026_admin_actions.sql` の CHECK と同じ 4 つである。** 一致は
 * `test/admin-actions.test.ts` が機械照合する（`.ai-playbook/shared-ai-rules.md` 12 章。
 * **書き写した一覧は必ず腐る**ので、片方だけ増えた状態を検査で落とす）。
 *
 * **4 つとも「戻せる操作」である**（2.4.3）。`queued` ↔ `cleared` と BAN の付け外しが、
 * それぞれ往復で 2 つずつ。
 */
export const ADMIN_ACTIONS = [
  'review-queued',
  'review-cleared',
  'user-banned',
  'user-unbanned',
] as const;

/** 履歴に残す操作。 */
export type AdminActionName = (typeof ADMIN_ACTIONS)[number];

/** 対象の種類（**正本**。`migrations/0026` の CHECK と機械照合する）。 */
export const ADMIN_ACTION_TARGETS = ['game', 'user'] as const;

/** 対象の種類。 */
export type AdminActionTarget = (typeof ADMIN_ACTION_TARGETS)[number];

/**
 * 理由の最大長（**コードポイントで数える**）。
 *
 * **500 文字。** 通報の理由（`src/reports.ts` の `MAX_REASON_LENGTH`）と同じ値に揃える
 * ——どちらも分類ではなく自由記述で、**長さだけを縛る**という扱いが同じである。
 * **定数を借りずに持つ**のは、片方を変えたときにもう片方が黙って追随しないためである
 * （通報は利用者が書き、これは運営が書く。変える理由が別に来る）。
 *
 * UTF-16 の長さ（`String#length`）で数えないのは `src/account.ts` と同じ理由である。
 */
export const ADMIN_REASON_MAX_LENGTH = 500;

/**
 * 一覧が 1 画面で読む件数の上限（仕様 2.3.3 の条件 1 と同じ考え方）。
 *
 * **50 件。** 母数が増えても 1 回の読み取りが増えない形にする。文字だけの行なので、
 * カードを並べる `/works`（20 件）ではなく `src/my-works.ts` の 50 件に合わせた。
 *
 * **頁送りを置かない。** 審査キューも履歴も、**平常時は数件**である（通報が閾値に
 * 達した作品だけがキューへ入り、履歴は運営が押した回数しか増えない）。
 * **50 件で足りなくなったときが、頁送りを設計する契機である**——先に作ると、
 * 1 度も使われない経路の面倒を見ることになる（0001 の「将来使うかもしれない」で
 * 足さない方針と同じ向き）。
 */
export const ADMIN_LIST_LIMIT = 50;

/** 理由を受け付けなかった理由。 */
export type ReasonRejection = 'reason-empty' | 'reason-too-long';

/** 理由の検査の結果。 */
export type ReasonValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ReasonRejection };

/**
 * 理由を検査し、保存する形（前後の空白を除いたもの）へ落とす（2.4.4）。
 *
 * **空を受け付けない。** 2.4.4 が「理由を必須にする」と定めた理由は、**削除申請への
 * 回答に使うため**である（「誰が何をした」だけでは答えられない）。
 *
 * **`String#trim` で判定する。** 全角空白（U+3000）も空白として落ちるので、
 * **「　」だけの理由は空として断る**（`migrations/0026` の CHECK は `trim` が落とす
 * 半角の空白・改行しか見ない。**口と表の両方で守り、守る範囲が違う**）。
 *
 * @param raw フォームから受け取った値
 * @returns 保存する値、または断る理由
 */
export function validateReason(raw: string): ReasonValidation {
  const value = raw.trim();
  if (value === '') {
    return { ok: false, reason: 'reason-empty' };
  }
  // スプレッドは文字列をコードポイントごとに分ける（サロゲート対を 1 つに数える）。
  if ([...value].length > ADMIN_REASON_MAX_LENGTH) {
    return { ok: false, reason: 'reason-too-long' };
  }
  return { ok: true, value };
}

/**
 * 書き込みの結果。
 *
 * **`changed` は「状態が動いたか」であって、「履歴が残ったか」ではない。**
 * `ok: true` ならどちらの場合も履歴は 1 行残っている（このファイルの冒頭「逆向きも
 * 塞ぐ」）。`changed: false` は**既にその状態だった**ことを意味する。
 */
export type AdminWriteOutcome =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'not-applicable' | 'write-failed' };

/** 履歴の 1 行に要る値。 */
interface AdminActionRecord {
  readonly actorId: string;
  readonly action: AdminActionName;
  readonly targetType: AdminActionTarget;
  readonly targetId: string;
  /** **未検査でよい**（下記 {@link runWithHistory}）。 */
  readonly reason: string;
  readonly createdAt: number;
}

/**
 * 履歴の insert を組み立てる。
 *
 * **`where exists` で「操作した後の状態」を確かめる**（このファイルの冒頭）。
 * 束縛の順は `select` の並び（id / actor / created_at / action / target_type は定数 /
 * target_id / reason）に続けて、`exists` の条件が取る。
 *
 * @param db D1 バインディング
 * @param record 履歴に残す値
 * @param guardSql `exists` の中身（対象が「操作後の状態」であることを表す SELECT）
 * @param guardBindings `guardSql` の束縛値
 * @returns 準備済みの文
 */
function historyInsert(
  db: D1Database,
  record: AdminActionRecord,
  guardSql: string,
  guardBindings: readonly unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `insert into admin_actions
         (id, actor_id, created_at, action, target_type, target_id, reason)
       select ?, ?, ?, ?, ?, ?, ?
        where exists (${guardSql})`,
    )
    .bind(
      crypto.randomUUID(),
      record.actorId,
      record.createdAt,
      record.action,
      record.targetType,
      record.targetId,
      record.reason,
      ...guardBindings,
    );
}

/**
 * 操作と履歴を 1 つの batch で書く。
 *
 * **理由をここで検査しない。** 検査は口の側（{@link validateReason} を呼ぶ
 * `src/admin/review.ts` / `src/admin/users.ts`）が行い、**ここは `migrations/0026` の
 * CHECK に委ねる。** そうしてある理由は 2 つある。
 *
 *   - **表の側にも必須が要る**（口を 1 つ足し忘れても空が積めない。0026 の「CHECK を
 *     3 つ張る」）
 *   - **`test/admin-actions.test.ts` が、空の理由でここを直接叩いて batch の原子性を
 *     確かめる**——ここで弾いてしまうと、**D1 まで届かず、確かめたいことが確かめられない**
 *
 * @param db D1 バインディング
 * @param update 操作の UPDATE（**当たる条件まで含めて呼び出し側が決める**）
 * @param history 履歴の INSERT（{@link historyInsert} が組んだもの）
 * @returns 書き込みの結果
 */
async function runWithHistory(
  db: D1Database,
  update: D1PreparedStatement,
  history: D1PreparedStatement,
): Promise<AdminWriteOutcome> {
  let results: readonly D1Result[];
  try {
    // **順序に意味がある。** 先に状態を動かし、そのうえで「動いた後の状態」を
    // `exists` が見る。逆にすると `exists` は操作前の状態を見ることになる。
    results = await db.batch([update, history]);
  } catch (error) {
    // 履歴の CHECK 違反（理由が空）や D1 の障害。**batch ごと巻き戻っているので、
    // 操作も入っていない。** 呼び出し側は断りの画面を返す。
    console.error('[admin] 操作と履歴を書けませんでした', error);
    return { ok: false, reason: 'write-failed' };
  }

  const changedRows = results[0]?.meta.changes ?? 0;
  const historyRows = results[1]?.meta.changes ?? 0;

  if (changedRows > 0) {
    // **履歴が入っていないのに状態が動いた形は、構造上ありえない**（同じ
    // トランザクションの中で `exists` が新しい状態を見る）。ありえない形を
    // 黙って通さない——出るとすれば D1 の意味が変わったときで、それは気づきたい。
    if (historyRows === 0) {
      console.error('[admin] 履歴の無い操作が入りました（batch の意味が変わっています）');
    }
    return { ok: true, changed: true };
  }

  // 状態は動かなかった。**履歴が入っていれば「既にその状態だった」**である
  // （このファイルの冒頭「代わりに引き受けたこと」）。
  if (historyRows > 0) {
    return { ok: true, changed: false };
  }

  // 対象が見つからないか、往復の対象外の状態である（例: まだ 1 度も審査キューへ
  // 入っていない作品を `cleared` にしようとした）。**どちらも書いていない。**
  return { ok: false, reason: 'not-applicable' };
}

/**
 * 審査状態を切り替える（`queued` ↔ `cleared`。2.4.3）。
 *
 * **往復の 2 方向だけを受ける。** `from` に「いまこうであるはず」を取り、UPDATE の
 * 条件に置く——**画面を開いたまま別の管理者が動かした場合に、上書きしない**
 * （`src/invites.ts` の二重使用の防止と同じ形で、**先に SELECT して確認する形にしない**。
 * 読みと書きの間にもう 1 本入ると、両方が「まだ動いていない」と読む）。
 *
 * **`null`（まだ通報の閾値に達していない）からは入れない。** 画面が並べるのは
 * `queued` と `cleared` の作品だけで、**審査していない作品を運営が手で止める操作は
 * 置いていない**（8.4 は「閾値到達で審査キューへ投入」と定めており、投入するのは
 * 通報の側である）。
 *
 * **`games.status` を 1 ビットも動かさない**（0017 / 8.4）。止まるのは新規露出だけで、
 * `/works/<id>` は生き続ける。
 *
 * @param env バインディングと環境変数
 * @param params 対象・向き・実行者・理由・時刻
 * @returns 書き込みの結果
 */
export async function setReviewState(
  env: Env,
  params: {
    readonly gameId: string;
    readonly from: ReviewState;
    readonly to: ReviewState;
    readonly actorId: string;
    readonly reason: string;
    readonly now?: number;
  },
): Promise<AdminWriteOutcome> {
  const createdAt = params.now ?? Math.floor(Date.now() / 1000);
  const update = env.DB.prepare(
    'update games set review_state = ? where id = ? and review_state = ?',
  ).bind(params.to, params.gameId, params.from);

  return await runWithHistory(
    env.DB,
    update,
    historyInsert(
      env.DB,
      {
        actorId: params.actorId,
        action: params.to === REVIEW_QUEUED ? 'review-queued' : 'review-cleared',
        targetType: 'game',
        targetId: params.gameId,
        reason: params.reason,
        createdAt,
      },
      'select 1 from games where id = ? and review_state = ?',
      [params.gameId, params.to],
    ),
  );
}

/**
 * BAN を付け外しする（`users.banned_at`。2.4.3 / 7.3）。
 *
 * **BAN は露出を止めない**（7.3 / #330 の決定）。この関数が触るのは `users.banned_at`
 * だけで、**その人の作品は一覧からも作品ページからも消えない**——止まるのは
 * ログインである（`src/session-user.ts`）。`test/admin-actions.test.ts` が、BAN した
 * 直後に公開一覧を引いて作品が残っていることを確かめる。
 *
 * **行を消さない**（0001。消すと `invited_by` の連鎖と生成履歴が同時に失われ、
 * BAN の波及先を追えなくなる）。
 *
 * **管理者自身を BAN できてしまう。** 画面の側で自分を対象に出さないことで避ける
 * （`src/admin/users.ts`）——**この関数は対象を選ばない**。ここへ判定を足すと、
 * 「誰を BAN できるか」の決定が画面と口の 2 か所に分かれる。
 *
 * @param env バインディングと環境変数
 * @param params 対象・向き・実行者・理由・時刻
 * @returns 書き込みの結果
 */
export async function setUserBan(
  env: Env,
  params: {
    readonly userId: string;
    readonly banned: boolean;
    readonly actorId: string;
    readonly reason: string;
    readonly now?: number;
  },
): Promise<AdminWriteOutcome> {
  const createdAt = params.now ?? Math.floor(Date.now() / 1000);
  const update = params.banned
    ? env.DB.prepare('update users set banned_at = ? where id = ? and banned_at is null').bind(
        createdAt,
        params.userId,
      )
    : env.DB.prepare(
        'update users set banned_at = null where id = ? and banned_at is not null',
      ).bind(params.userId);

  return await runWithHistory(
    env.DB,
    update,
    historyInsert(
      env.DB,
      {
        actorId: params.actorId,
        action: params.banned ? 'user-banned' : 'user-unbanned',
        targetType: 'user',
        targetId: params.userId,
        reason: params.reason,
        createdAt,
      },
      `select 1 from users where id = ? and banned_at is ${params.banned ? 'not null' : 'null'}`,
      [params.userId],
    ),
  );
}

/** 履歴の 1 行（画面が出す形）。 */
export interface AdminActionEntry {
  readonly id: string;
  readonly actorId: string;
  /** 実行者の表示名（`users` を結合して取る。**行が消えていれば null**）。 */
  readonly actorName: string | null;
  readonly createdAt: number;
  readonly action: AdminActionName;
  readonly targetType: AdminActionTarget;
  readonly targetId: string;
  readonly reason: string;
}

/**
 * 履歴を新しい順に引く（2.4.4 の「画面から読めるようにする」）。
 *
 * **件数を固定する**（{@link ADMIN_LIST_LIMIT}。2.3.3 の条件 1 と同じ考え方）。
 *
 * **`users` は表示名 1 列のために結合する。** 行ごと持ってこない（`email` を管理画面にも
 * 出さない——**出す理由が無いものを出さない**。`src/games.ts` の一覧が `users` から
 * 表示名しか選ばないのと同じ形である）。
 *
 * **同じ秒に 2 件積んだときは、積んだ順の逆で出す。** 同値の行の順序を決める必要があり
 * （`src/games.ts` の一覧が `id desc` を末尾に置いているのと同じ理由）、**ここでは
 * `id` を使えない**——id は `crypto.randomUUID()` なので、**押した順と無関係な順に
 * 並ぶ**（BAN の直後に解除を押すと、履歴では解除が先に見えることがある。実際に
 * `test/admin-screens.test.ts` がその形で落ちた）。
 *
 * **`rowid` で並べる。** SQLite の暗黙の列で、**insert の順に単調増加する**
 * （この表は `WITHOUT ROWID` ではない）。**時刻を増やして誤魔化さない**
 * ——`created_at` は「いつ押したか」であって、順序を作るための値ではない。
 *
 * @param env バインディングと環境変数
 * @param limit 取得件数の上限
 * @returns 履歴（新しい順）
 */
export async function listAdminActions(
  env: Env,
  limit: number = ADMIN_LIST_LIMIT,
): Promise<readonly AdminActionEntry[]> {
  const result = await env.DB.prepare(
    `select a.id, a.actor_id, a.created_at, a.action, a.target_type, a.target_id, a.reason,
            u.display_name as actor_name
       from admin_actions a
       left join users u on u.id = a.actor_id
      order by a.created_at desc, a.rowid desc
      limit ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      actor_id: string;
      created_at: number;
      action: AdminActionName;
      target_type: AdminActionTarget;
      target_id: string;
      reason: string;
      actor_name: string | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    createdAt: row.created_at,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
  }));
}

/**
 * 審査状態の往復の相手を返す。
 *
 * **`queued` の相手は `cleared`、`cleared` の相手は `queued`。** 画面と口の両方が
 * 使うので、**どちらかへ書き写さない**（写すと、片方だけが向きを取り違える形で
 * 壊れる。動作では「押したのに何も起きない」としか見えない）。
 *
 * @param state いまの状態
 * @returns 切り替えた先の状態
 */
export function oppositeReviewState(state: ReviewState): ReviewState {
  return state === REVIEW_QUEUED ? REVIEW_CLEARED : REVIEW_QUEUED;
}
