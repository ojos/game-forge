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

/**
 * 見た結果、問題なし。露出を戻す。**再び閾値に達しても戻さない。**
 *
 * **例外が 1 つある（#366）。** 作者が題名を変えると `NULL` へ戻る
 * （`src/games.ts` の `renameGame`）——**審査で見たのは改名前の題名**であり、
 * 別の題名になった作品について「見た結果、問題なし」と言い続けることはできない。
 * **戻す先は `NULL` であって {@link REVIEW_QUEUED} ではない**（`queued` は新規露出を
 * 止める状態なので、善意の改名で作品がトップから消える）。
 *
 * **`cleared` のまま付いた通報は、状態を動かさない**（{@link recordReport} は `NULL` の
 * 作品しか `queued` へ上げない）。それを運営へ出すのは
 * {@link REVIEW_REPORTED_AFTER_CLEAR_SQL} である（#394）。
 */
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

  // **先に SELECT して確認する形にしない。** `src/invites.ts` が二重使用の防止について
  // 同じことを書いている——**同じ人の二重送信が同時に走ると、SELECT はどちらもすり抜ける。**
  // 判定は `reports` の一意制約が持ち（`migrations/0017_games_review_state.sql`）、
  // ここは違反を「通報済み」へ翻訳するだけである。
  try {
    await env.DB.prepare(
      'insert into reports (id, game_id, reporter_id, reason, created_at) values (?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), gameId, reporterId, reason, now)
      .run();
  } catch (error) {
    if (isDuplicateReport(error)) {
      return { ok: false, reason: 'already-reported' };
    }
    throw error;
  }

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
 * 例外が「同じ人が同じ作品を 2 度通報した」かを判定する。
 *
 * **D1 はエラーコードを構造化して返さない**ので、メッセージで判定するほかない
 * （`src/invites.ts` の `isCodeCollision` と同じ形）。**索引の名前まで含めて照合し**、
 * 他のテーブルの一意制約を拾わないようにする。
 *
 * @param error 捕まえた値
 * @returns 二重通報なら true
 */
function isDuplicateReport(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('reports_game_reporter_uq') ||
      error.message.includes('UNIQUE constraint failed: reports.game_id, reports.reporter_id'))
  );
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
 * 改名の履歴を持つ表の名前（`migrations/0027_title_changes.sql`）。
 *
 * **書くのは `src/games.ts` の `renameGame` である。** ここが綴りを持つのは、
 * #366 の条件がこの表を引いていた名残であり（#394 で条件は `admin_actions` を引く形へ
 * 変わった）、いまは admin の審査キュー（`src/admin/review.ts`）が「最終改名」の時刻を
 * 出すために借りている。**`src/games.ts` から import しない**——あちらが既にこの
 * モジュールから `reviewVisibleSql` を取っており、逆向きの import は循環参照になる
 * （`src/paths.ts` が値だけの葉に逃がしているのと同じ問題）。
 *
 * **表名の綴りが実在の表と一致することは `test/title-rename.test.ts` が確かめる**（この定数で
 * 表を引いて改名の履歴を読む。書き写した綴りは必ず腐る。`.ai-playbook/shared-ai-rules.md`
 * 12 章）。**審査キューの条件の綴りの照合は、#394 で `test/review-attention.test.ts` へ移した。**
 */
export const TITLE_CHANGES_TABLE = 'title_changes';

/**
 * 「`cleared` にしたあと、**最後に `cleared` にした時刻以降に**通報が付いた」作品の条件
 * （8.4 / #366 / #394）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * なぜこの条件が要るのか
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **{@link REVIEW_CLEARED} は終端である**（上記「再び閾値に達しても戻さない」）。
 * {@link recordReport} は通報の行を必ず保存するが、`queued` へ上げるのは状態が `NULL` の
 * ときだけなので、**`cleared` の作品に付いた通報は、状態を見る一覧のどこにも出ない。**
 * この条件はそれを拾う。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 基準は「最後に `cleared` にした時刻」である（#394 で改名の時刻から変えた）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **#366 は基準を「最後の改名の時刻」にしていた。** しかし改名は `cleared` を `NULL` へ
 * 戻す（`src/games.ts` の `renameGame`）ので、改名の直後の作品は決して `cleared` では
 * なく、当たるのは**改名のあとに運営がもう一度 `cleared` にした作品だけ**だった。
 * そこには 2 種類が混ざる。
 *
 *   - (a) 改名後の通報で `queued` になり、**運営が見て `cleared` にし直した**（出すべきでない）
 *   - (b) `cleared` にし直した**後に**来た通報（出すべき）
 *
 * **改名の時刻では (a) と (b) を区別できない**——(a) が次の改名まで出続け、運営がこの
 * 一覧を見なくなって (b) を見落とす。**区別に使えるのは、最後に `cleared` にした時刻**
 * である。
 *
 * **改名に絞らず、一般化した。** (b) は改名が無くても成り立つ（`cleared` が終端である
 * ことは #366 より前からの性質）。「最後に `cleared` にした時刻以降の通報」は改名を含む
 * すべての場合を覆い、**`cleared` を `NULL` へ戻す操作をあとから足しても**（作品の説明の
 * 変更など）、条件を書き足さずに効く。
 *
 * **時刻は `admin_actions` の `review-cleared` から引く**（2.4.4 / #361。`src/admin/actions.ts`
 * の `setReviewState` が、状態の UPDATE と 1 つの batch で積む）。**同じ状態への二度押しも
 * 1 行積む**（あちらの「代わりに引き受けたこと」）ので、そのときは基準が後ろへ動く——
 * **運営が実際に見た時刻である**から、それでよい。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 履歴の無い `cleared` は、通報があれば出す（#361 より前の作品）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **#361 より前は、端末から SQL で `cleared` にしていた**ので、`admin_actions` に行が無い。
 * そういう作品には「最後に `cleared` にした時刻」が無い。**`coalesce(…, 0)` で 0 へ倒し、
 * 通報が 1 件でもあれば出す。**
 *
 *   - **黙って落とさない。** 落とすと、その作品に付いた (b) の本物が二度と見えない
 *   - **「最後の改名の時刻」へ倒さない。** 改名（#366）は #361 より後に入ったので、
 *     `cleared` のまま改名の履歴を持つ作品は、改名のあとに誰かが `cleared` にし直した
 *     作品である——その時刻は改名より後で、**改名の時刻へ倒すと (a) を拾う**。
 *     しかも改名の無い大多数は NULL のままで、結局落ちる
 *   - **「移行した時刻」を基準にしない。** 本番へ `0026` を適用した時刻は D1 の外
 *     （運用の記録）にしかなく、定数として埋めると手元とテストの D1 で意味が変わる。
 *     **埋めても、端末で `cleared` にした時刻から移行までの間に付いた (b) を落とす**
 *   - **代償は 1 度きりである。** 画面から審査待ちへ戻して問題なしにし直せば、
 *     履歴が 1 行積まれてこの条件から外れる（2.4.4 の記録の欠けもそこで埋まる）。
 *     閾値は 1 人なので、#361 より前の `cleared` はほぼ必ず通報を持ち、**全件が 1 度出る**
 *
 * **#361 より後に端末で `cleared` にした作品も同じ扱いになる**（画面を通らない操作は
 * 履歴を積まない。`src/admin/actions.ts` の冒頭）。**端末で戻した時刻が画面の最後の
 * `cleared` より後なら、画面の時刻を基準に多く出す**——どちらも見落とす向きではない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 綴りを 2 か所に置かない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **借りる側が 2 つある。**
 *
 *   - `scripts/report-queue.sh` … この定数を**ソースから取り出して** SQL へ差し込む
 *     （`REVIEW_QUEUED` を sed で取り出しているのと同じ規律。書き写すと、片方だけが
 *     古くなったときに**キューに入っているのに 0 件と報告する**）
 *   - admin の審査キュー画面（#367 / `src/admin/review.ts`） … この定数を直接
 *
 * **1 行の文字列リテラルで書く。** 他の定数を差し込むテンプレートリテラルにすると、
 * シェル側が取り出せない（あちらに TypeScript の評価器は無い）。**そのぶん、綴りが
 * {@link REVIEW_CLEARED} / {@link REVIEW_STATE_COLUMN} と、`src/admin/actions.ts` の
 * `ADMIN_ACTIONS` / `ADMIN_ACTION_TARGET_KINDS` と一致していることは
 * `test/review-attention.test.ts` が機械照合する。**
 *
 * **`src/admin/actions.ts` から import しない。** あちらがこのモジュールから状態の綴りを
 * 取っており（循環参照になる）、**このモジュールはオーケストレータの束に入る**——
 * import すると admin の画面のコードが Lambda へ載る。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 別名は `g` に固定する（{@link reviewVisibleSql} と違う）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * あちらは別名を引数で受けるが、こちらは**相関副問い合わせを含む**ので、綴りを可変に
 * すると文字列の組み立てが増える（そしてシェル側から取り出せなくなる）。**借りる側が
 * `games g` に合わせる。** admin の一覧（`src/admin/review.ts`）も
 * `scripts/report-queue.sh` も、既に `g` で書いている。
 *
 * **`reports` と `admin_actions` の別名（`r` / `a`）は副問い合わせの中で閉じている**
 * ので、外側の別名と衝突しない（外側が `r` を使っていても、内側の `r` が優先される
 * ——ただし相関の対象が変わるので、**借りる側は外側で `r` / `a` を別の意味に使わないこと**）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * `not` で使えるように、`exists` で書く
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 画面の「問題なしとした作品」の節は `not` この条件で引く。**`max(r.created_at) >= …` の
 * 形にすると、通報が 1 件も無い作品で NULL になり、`not NULL` も NULL なので、その作品が
 * どちらの節からも消える。** `exists` は真か偽しか返さない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 同じ秒に並んだら拾う側へ倒す（`>=` である。#366 と同じ）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **時刻はどちらも UNIX 秒である**（0001 の方針）。`cleared` にした直後の通報は**同じ秒**に
 * 記録されうるので、`>` で書くと**その通報が一覧から落ちる**。秒より細かい時刻も連番も
 * 持っていない以上、同じ秒の前後は区別できない。
 *
 * **区別できないときは、多く出すほうへ倒す。** 落とす側へ倒すと**見るべき作品が
 * 出ないまま消える**が、拾う側へ倒したときの代償は「`cleared` にした秒と同じ秒の通報で
 * 1 件余計に出る」だけであり、**運営は作品ページを見て判断する**（8.4）。
 * `reviewVisibleSql` が `cleared` を露出させているのと同じで、**この一覧に出ること自体は
 * 作品に何の影響も与えない。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 読み取りは索引で抑える（`migrations/0029`）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`admin_actions` を引く副問い合わせは `cleared` の作品 1 件ごとに走る。** 索引が
 * 無いと 1 回ごとにこの表を全走査し、**`cleared` の作品数 × 履歴の行数**になる
 * （履歴は `cleared` 1 件につき少なくとも 1 行あるので、実質は 2 乗である）。
 * `0029` の索引で、1 件あたりの読み取りは履歴の行数に依らなくなる（実測は 0029 の冒頭）。
 */
export const REVIEW_REPORTED_AFTER_CLEAR_SQL =
  "(g.review_state = 'cleared' and exists (select 1 from reports r where r.game_id = g.id and r.created_at >= coalesce((select max(a.created_at) from admin_actions a where a.target_kind = 'game' and a.target_id = g.id and a.action = 'review-cleared'), 0)))";

/**
 * 運営が見るべき作品の条件（8.4 / #366 / #394）。
 *
 * **{@link REVIEW_QUEUED} と {@link REVIEW_REPORTED_AFTER_CLEAR_SQL} の和である。** 前者は
 * 「通報が閾値に達した」作品、後者は「問題なしとしたあとに通報が付いた」作品で、
 * **運営がすることは同じ**（作品ページを見て判断する）。
 *
 * **`scripts/report-queue.sh` はこれと同じ形を組み立てる**（定数 2 つを取り出して
 * `or` で繋ぐ）。**条件そのものはどちらもここから来る**ので、片方だけが古くなる形に
 * ならない。
 *
 * @returns where 句に置ける断片（**`games` の別名は `g` である**）
 */
export function reviewAttentionSql(): string {
  return `(g.${REVIEW_STATE_COLUMN} = '${REVIEW_QUEUED}' or ${REVIEW_REPORTED_AFTER_CLEAR_SQL})`;
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
