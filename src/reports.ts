/**
 * 通報の受付と、審査キューへの投入（8.4 / #40）。
 *
 * ## 自動非表示にしない
 *
 * 8.4 は「**閾値到達時は『自動非表示』ではなく『審査キューへ投入』とする**」と定める。
 * 理由も書かれている——**自動非表示は組織的通報（通報爆撃）で正常なコンテンツを
 * 消せてしまう。** したがってこのモジュールは `games.status` を 1 度も動かさない。
 * 動かすのは {@link REVIEW_STATE_COLUMN} だけである。
 *
 * **止まるのは新規露出だけである。** `status` が `published` のままなので
 * `/g/<game_id>/` は生き、共有済みの URL は切れない（8.4 の「既存 URL は生かす」）。
 *
 * ## 閾値は「異なる通報者の数」で数える
 *
 * **同じ人が何度押しても 1 である。** 件数で数えると、1 人が連打するだけで閾値へ
 * 届く——8.4 が通報爆撃を警戒しているのに、**1 人でそれを再現できる**形になる。
 *
 * ## 運用画面を作らない
 *
 * 8.4 は画面を要求していない（#40 の intake / 2026-09-03）。キューを読むのは
 * `scripts/report-queue.sh` で、**管理者の識別が要らない**——権限は Cloudflare の
 * 資格情報そのものになる。このリポジトリの運用は既にすべてスクリプトである。
 */

/** `games` の審査状態を持つ列（`migrations/0017_games_review_state.sql`）。 */
export const REVIEW_STATE_COLUMN = 'review_state';

/** 審査待ち。新規露出を止める。 */
export const REVIEW_QUEUED = 'queued' as const;

/** 見た結果、問題なし。露出を戻す。**再び閾値に達しても戻さない。** */
export const REVIEW_CLEARED = 'cleared' as const;

/** 審査状態として入りうる値。 */
export const REVIEW_STATES = [REVIEW_QUEUED, REVIEW_CLEARED] as const;

/** 審査状態。 */
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * 審査キューへ入れる閾値（**異なる通報者の数**）。
 *
 * **1 人である**（#40 の intake / 2026-09-03）。8.4 が「招待制であるため、クローズドβ期の
 * モデレーション負荷は構造的に低く抑えられる」と書いているとおり、**全件見ても回る。**
 *
 * **2 以上にすると、利用者が 3 人のあいだ実質的に発火しない**——「キューに何も入らない」
 * 状態が続き、**機構が動いているのかどうかを確かめられないまま β を始める**ことになる。
 * 通報爆撃の危険は、**自動非表示にしない設計が既に吸収している。**
 */
export const REVIEW_THRESHOLD_REPORTERS = 1;

/** 通報の理由の最大長。**分類ではなく自由記述**なので、長さだけを縛る。 */
export const MAX_REASON_LENGTH = 500;

/** 通報を受け付けなかった理由。 */
export type ReportRejection =
  | 'not-signed-in'
  | 'game-not-found'
  | 'own-work'
  | 'already-reported'
  | 'reason-too-long';

/** 通報の結果。 */
export interface ReportOutcome {
  /** この通報で審査キューへ入ったか。**既に入っていた場合は false。** */
  readonly queued: boolean;
  /** 異なる通報者の数（この通報を含む）。 */
  readonly reporters: number;
}

/**
 * 通報を 1 件記録し、閾値に達していれば審査キューへ入れる。
 *
 * **同じ人の 2 度目を弾く。** `reports` に主キー以外の一意制約は無い（0001）ので、
 * ここで見る。**弾くのは「数えない」ためではなく、押した人に「もう通報済みです」と
 * 返すため**である（黙って 2 行目を作ると、本人には何も起きていないように見える）。
 *
 * **自分の作品は通報できない。** 通報は他者の作品を運用へ回す仕組みで、自分の作品を
 * 消したいなら取り下げ（M5-4）がある。**同じことを 2 つの経路でできるようにしない。**
 *
 * @param env バインディングと環境変数
 * @param gameId 通報された作品
 * @param reporterId 通報した利用者
 * @param reason 理由（自由記述）
 * @param now 現在時刻（UNIX 秒）
 * @returns 受け付けたら結果、断ったら理由
 */
export async function recordReport(
  env: Env,
  gameId: string,
  reporterId: string,
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; outcome: ReportOutcome } | { ok: false; reason: ReportRejection }> {
  if ([...reason].length > MAX_REASON_LENGTH) {
    return { ok: false, reason: 'reason-too-long' };
  }

  const game = await env.DB.prepare(
    `select author_id, ${REVIEW_STATE_COLUMN} as review_state from games where id = ?`,
  )
    .bind(gameId)
    .first<{ author_id: string; review_state: string | null }>();
  if (game === null) {
    return { ok: false, reason: 'game-not-found' };
  }
  if (game.author_id === reporterId) {
    return { ok: false, reason: 'own-work' };
  }

  const seen = await env.DB.prepare(
    'select 1 as hit from reports where game_id = ? and reporter_id = ? limit 1',
  )
    .bind(gameId, reporterId)
    .first<{ hit: number }>();
  if (seen !== null) {
    return { ok: false, reason: 'already-reported' };
  }

  await env.DB.prepare(
    'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), gameId, reporterId, reason, now)
    .run();

  const counted = await env.DB.prepare(
    'select count(distinct reporter_id) as reporters from reports where game_id = ?',
  )
    .bind(gameId)
    .first<{ reporters: number }>();
  const reporters = counted?.reporters ?? 0;

  // **`cleared` は戻さない。** 一度見て問題無しとした作品が、同じ通報で何度も
  // キューへ戻ると審査が終わらない（`migrations/0017_games_review_state.sql`）。
  //
  // **条件付き UPDATE で入れる。** 先に読んでから書く形にすると、同時に 2 件の通報が
  // 来たときに 2 度入れうる（`games.status` の遷移が一貫して採っている形）。
  if (reporters < REVIEW_THRESHOLD_REPORTERS || game.review_state !== null) {
    return { ok: true, outcome: { queued: false, reporters } };
  }
  const queued = await env.DB.prepare(
    `update games set ${REVIEW_STATE_COLUMN} = ?
      where id = ? and ${REVIEW_STATE_COLUMN} is null`,
  )
    .bind(REVIEW_QUEUED, gameId)
    .run();

  return { ok: true, outcome: { queued: (queued.meta.changes ?? 0) > 0, reporters } };
}

/**
 * 新規露出してよい作品かどうかを SQL で表す（8.4）。
 *
 * **一覧を引く側がこの断片を借りる。** 条件を書き写すと、次に露出する場所を足した日に
 * **片方だけが古くなる**——8.3 の `denied-terms.ts` が語彙を 1 か所に置いたのと同じ理由。
 *
 * **`cleared` は露出する。** 見た結果、問題なしと判断した状態である。
 *
 * **別名を引数で受ける。** 呼ぶ側の SQL が `from games` のときと `from games g` の
 * ときがあり、**断片の側が片方を決め打ちすると、もう片方が借りられない**（借りられない
 * と書き写しが始まる）。
 *
 * @param alias テーブルの別名（省略すると別名を付けない）
 * @returns where 句に置ける断片
 */
export function reviewVisibleSql(alias = ''): string {
  const column = alias === '' ? REVIEW_STATE_COLUMN : `${alias}.${REVIEW_STATE_COLUMN}`;
  return `(${column} is null or ${column} = '${REVIEW_CLEARED}')`;
}

/**
 * BAN された利用者を招待した人の、招待枠が止まっているか。
 *
 * **列を足さない。** 7.3 の「BAN 時に招待元の招待枠を停止する」は、**招待した相手が
 * BAN されているかどうかから導ける。** 別の列で持つと、BAN を取り消したときに
 * 戻し忘れる余地ができる（**2 か所で同じ事実を持たない**）。
 *
 * **`invited_by` は `users` が持っている**（0001。「コミュニティの初期構造をそのまま
 * 資産にする」ため）。
 *
 * @param env バインディングと環境変数
 * @param userId 招待枠を見たい利用者
 * @returns 招待枠が止まっていれば true
 */
export async function inviteQuotaHalted(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `select 1 as hit from users
      where invited_by = ? and banned_at is not null
      limit 1`,
  )
    .bind(userId)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * その人が既にこの作品を通報しているか（8.4 / #40）。
 *
 * **画面が「通報済み」を出すために引く。** 押せないボタンを黙って消すと、
 * 利用者から見て「壊れている」ことと「もう押した」ことの区別がつかない。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param reporterId 見ている利用者
 * @returns 通報済みなら true
 */
export async function hasReported(
  env: Env,
  gameId: string,
  reporterId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'select 1 as hit from reports where game_id = ? and reporter_id = ? limit 1',
  )
    .bind(gameId, reporterId)
    .first<{ hit: number }>();
  return row !== null;
}
