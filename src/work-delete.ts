/**
 * 作者が自分の作品を削除する画面の部品（#517 / M15-2 / 仕様 5.3 / 5.4 / 5.5）。
 *
 * **このモジュールが持つのは、綴り・表示の条件・確認画面・断りの文言だけである。** 経路（`GET /works/<id>/delete` と
 * `POST /api/works/delete`）は作品ページ（`src/work-page.ts`）が持つ——確認画面は作品ページの前方一致の経路の続きで
 * 開き、断りの画面と本文の読み方は取り下げの口と共有するためである。**このモジュールは `src/work-page.ts` を
 * import しない**（あちらがこちらを import する。逆向きを足すと循環参照になる）。
 *
 * ## 判定は `deleteGame` が持ち、ここは「導線を出すか」だけを決める
 *
 * **消せるかどうかの正本は `src/game-deletion.ts` の `deleteGame`（掴みの条件付き UPDATE）である。** ここの
 * {@link deletionBlockOf} は、押しても必ず断られる導線を出さないための**表示の条件**で、同じ並び
 * （中身を消した → 公開中 → 生成中 → リフォージ中）で読むだけである。**削除の口（POST）はこれを使わない**——
 * 作者本人かを確かめたら、状態を見ずに `deleteGame` を呼び、断られた理由をそのまま文言へ引く。
 *
 * ## 止まったまま残った生成・リフォージは消せない（#516 の申し送り）
 *
 * **区切り（`STALE_AFTER_SECONDS`）を過ぎた `pending` / `running` の行も「生成中」「リフォージ中」として断る。**
 * `deleteGame` の条件（経過時間で区切らない）を変えない——生成・リフォージのコールバックは行とジョブのトークンを
 * 照合してから費用台帳を書くので、遅れて届いたコールバックが消えた行に当たると台帳の行を落とす（#516）。
 * 止まった行を消せるようにするかは、#517 の範囲の外に置いた（#517 の PR の本文）。
 *
 * **#681 注記（2026-09-18）。** 止まった行は、`game-forge-cleanup` の cron（5 分ごと）が区切り（1 時間。
 * `src/stale-generation-sweep.ts` の `STALE_GENERATION_SWEEP_SECONDS`）を過ぎてから `failed` に畳む。
 * **この条件と `deleteGame` の条件は変えていない**——畳まれた後は `failed` として導線が出て、消せる。
 * 900 秒から 1 時間までのあいだは、これまでどおり「生成中」「リフォージ中」として断る。
 */
import type { GameDeletionRejection, GameDeletionResult } from './game-deletion.js';
import { deleteGame } from './game-deletion.js';
import { PUBLISHED_STATUS } from './games.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, siteHead } from './html.js';
import { siteFooter } from './legal.js';
import { workPagePath } from './paths.js';
import { MY_WORKS_PATH } from './works-paths.js';
// **戻る先はエディットページである**（#664。削除の導線はそこにある。綴りは Lambda が import しない葉から取る）。
import { workEditPath } from './work-edit-paths.js';

/**
 * 確認画面のパスの末尾（`/works/<id>/delete`）。
 *
 * **作品ページの前方一致の経路（`/works/`）の続きに置く。** 新しい前方一致の経路を足すと、外枠の検査
 * （`test/page-shell.test.ts`）と幅の検査（`scripts/lib/dev-fixture.sh`）に補う id を足す必要が出るうえ、
 * 確認画面は作者本人の作品でしか本体を開けない（仕込みの利用者で開いても 404 しか見られない）。
 */
export const WORK_DELETE_SUFFIX = '/delete';

/**
 * 確認画面のパスを組み立てる。
 *
 * @param gameId 作品 id
 * @returns パス
 */
export function workDeletePath(gameId: string): string {
  return `${workPagePath(gameId)}${WORK_DELETE_SUFFIX}`;
}

/**
 * 削除の口（`POST`）。**公開をやめる口（`/api/works/unpublish`）と別の経路にする**——あちらは公開をやめて下書きへ戻すだけで中身を残し、
 * 削除は中身を消して戻せない。同じ口にすると、どちらの意思なのかが本文の中身でしか分からなくなる。
 *
 * `/api/works/delete` は作品ページの前方一致（`/works/`）に当たらない綴りである（取り下げ・通報と同じ規約）。
 */
export const WORK_DELETE_PATH = '/api/works/delete';

/** 削除の対象を指す項目名（フォームの `name` と JSON の鍵の両方）。 */
export const WORK_DELETE_GAME_ID_FIELD = 'game_id';

/**
 * 削除の導線を出さない理由（表示の条件）。
 *
 * `deleteGame` が断る理由（{@link GameDeletionRejection} のうち `busy` を除いたもの）に、**中身をもう消した**
 * （`purged`）を足したもの。`busy` は読み直しのあいだに状態が動いたときにだけ返る値で、画面を描く時点の行からは
 * 導けない。
 */
export type DeletionBlock = Exclude<GameDeletionRejection, 'busy'> | 'purged';

/** {@link deletionBlockOf} が読む行の値。 */
export interface DeletionState {
  /** `games.status`。 */
  readonly status: string;
  /** `games.generation_state`。 */
  readonly generationState: string;
  /** `games.purged_at` が入っているか（中身を消した tombstone）。 */
  readonly purged: boolean;
  /**
   * リフォージのジョブが `pending` / `running` か。**区切りの内側か外側かを問わない**（止まった行も含める。
   * `deleteGame` が経過時間で区切らないため）。
   */
  readonly revisionInFlight: boolean;
}

/**
 * 削除の導線を出さない理由を返す（出してよければ null）。
 *
 * **表示の条件である。** 判定の正本は `deleteGame` の掴みの SQL で、並びはその読み直し（`settledOutcome`）に
 * 揃えてある。**作者本人かはここで見ない**（呼ぶ側が先に確かめる）。
 *
 * - `generation_state` が `ready` / `failed` 以外（`pending` / `running` と、CHECK が入れさせない想定外の値）は
 *   「生成中」に倒す——掴みの条件が `generation_state in ('ready', 'failed')` で、それ以外は消せない
 *
 * @param state 行の値
 * @returns 出さない理由、出してよければ null
 */
export function deletionBlockOf(state: DeletionState): DeletionBlock | null {
  if (state.purged) {
    return 'purged';
  }
  if (state.status === PUBLISHED_STATUS) {
    return 'published';
  }
  if (state.generationState !== 'ready' && state.generationState !== 'failed') {
    return 'generating';
  }
  if (state.revisionInFlight) {
    return 'revising';
  }
  return null;
}

/**
 * 確認画面と削除の口が読む 1 行を引く SQL（束縛 1 つ: 作品 id）。
 *
 * **作者の一致は SQL に入れない。** 行が無いことと他人の作品であることを、呼ぶ側で同じ「見つからない」に畳む
 * （`deleteGame` は存在しない id にも `deleted` を返すので、作者を確かめずに呼ぶと他人の id で成功の画面が出る）。
 * 題名は確認画面にだけ使う（作者本人にしか出さない）。
 */
export const DELETION_TARGET_SQL = `select g.author_id, g.status, g.generation_state, g.title,
            (g.purged_at is not null) as purged,
            exists (select 1 from game_revision_jobs j
                     where j.game_id = g.id and j.state in ('pending', 'running')) as revising
       from games g
      where g.id = ?`;

/** {@link DELETION_TARGET_SQL} の 1 行。 */
export interface DeletionTargetRow {
  readonly author_id: string;
  readonly status: string;
  readonly generation_state: string;
  readonly title: string;
  readonly purged: number;
  readonly revising: number;
}

/**
 * 行を {@link deletionBlockOf} の入力へ落とす。
 *
 * **`=== 1` で読む**（結合や式が返しうる null を真へ倒さない）。どちらへ倒れても、最後に断るのは
 * `deleteGame` である——ここで誤るのは導線を出すかどうかだけで、消えるかどうかではない。
 *
 * @param row 引いた行
 * @returns 表示の条件の入力
 */
export function deletionStateOf(row: DeletionTargetRow): DeletionState {
  return {
    status: row.status,
    generationState: row.generation_state,
    purged: row.purged === 1,
    revisionInFlight: row.revising === 1,
  };
}

/** {@link deleteAuthoredGame} の結果。 */
export type AuthoredDeletionOutcome =
  | { readonly ok: true; readonly result: GameDeletionResult }
  | { readonly ok: false; readonly reason: GameDeletionRejection | 'not-found' };

/**
 * 作者本人の作品を消す（#517 の口の本体。#666 で切り出した）。
 *
 * **1 件ずつの口（`POST /api/works/delete`。`src/work-page.ts`）と一括の口（`src/works-bulk.ts`）が同じこの関数を通る。**
 * 一括の口が `deleteGame` を直接呼ぶと、作者の検査を書き忘れても動作では気づけない（自分の作品は正しく消える）。
 *
 * # 作者本人かだけを先に確かめ、状態の判定は `deleteGame` に任せる
 *
 * **`deleteGame` は id を受け取るだけで、権限を持たない。** 存在しない id にも `deleted` を返すので、作者を
 * 確かめずに呼ぶと、他人の id を送った人に成功が返る（行が在れば、他人の作品が消える）。**作者でない・
 * 行が無いは、どちらも `not-found` に畳む**（区別すると、任意の id が実在するかを外から確かめられる）。
 * `author_id` は作品の作成後に変わらないので、読んでから `deleteGame` を呼ぶまでの隙間で結論は変わらない。
 *
 * **状態（公開中・生成中・リフォージ中）の `if` はここに置かない。** 断る理由は `deleteGame` が返す。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param userId 操作している利用者
 * @returns 削除の結果
 */
export async function deleteAuthoredGame(
  env: Env,
  gameId: string,
  userId: string,
): Promise<AuthoredDeletionOutcome> {
  const row = await env.DB.prepare(DELETION_TARGET_SQL).bind(gameId).first<DeletionTargetRow>();
  if (row === null || row.author_id !== userId) {
    return { ok: false, reason: 'not-found' };
  }
  return await deleteGame(env, gameId);
}

/** 断りの画面の中身。 */
export interface DeleteRefusal {
  readonly status: number;
  readonly heading: string;
  readonly body: string;
}

/**
 * 削除を断ったときの、理由ごとのステータスと文言。
 *
 * **鍵を理由の型で縛る**（`deleteGame` が理由を 1 つ増やした日に、表へ足し忘れると型検査が落ちる）。
 *
 * - `not-found` … 行が無い・**他人の作品**（区別すると、任意の id が実在するかを外から確かめられる）。404
 * - `published` / `generating` / `revising` / `busy` … 作品のいまの状態と衝突している。409（`src/quota.ts` の
 *   `IN_FLIGHT_STATUS` と同じ性質の断り）。**何をすれば消せるようになるかを、理由ごとに書く**
 * - `purged` … 中身をもう消してある（確認画面を開き直したとき）。409。**削除の口はこの理由で断らない**
 *   （`deleteGame` は 2 回目の呼び出しに `purged` を返して成功する）
 */
export const DELETE_REFUSALS: Readonly<
  Record<GameDeletionRejection | 'not-found' | 'purged', DeleteRefusal>
> = {
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  published: {
    status: 409,
    heading: '公開中の作品は削除できません',
    body: 'この作品は公開中です。削除するには、先に作品ページの「公開をやめる」で下書きに戻してください。下書きに戻した作品は、作品ページから削除できます。',
  },
  generating: {
    status: 409,
    heading: '生成中の作品は削除できません',
    body: 'この作品は生成中です。生成が終わってから削除してください。時間がたっても生成中のままの場合は、お手数ですがよくある質問にある窓口までご連絡ください。',
  },
  revising: {
    status: 409,
    heading: 'リフォージ中の作品は削除できません',
    body: 'この作品はリフォージ中です。リフォージが終わってから削除してください。',
  },
  busy: {
    status: 409,
    heading: '削除を始められませんでした',
    body: 'ちょうど作品の状態が変わったため、削除を始められませんでした。作品ページを開き直してから、もう一度お試しください。',
  },
  purged: {
    status: 409,
    heading: 'この作品はすでに削除されています',
    body: 'この作品のソースコード・遊ぶためのファイル・紹介用の画像は、すでに削除されています。',
  },
};

/**
 * 削除で起きること・起きないことの 2 つの塊（`<div>` 2 つ。#517 の scope.out の文言）。
 *
 * **1 件ずつの確認画面と一括の確認画面（`src/works-bulk-page.ts`。#666）が同じ文を出す。** 一括のときに省くと、
 * 「まとめて消したらフォークまで消えるのか」を読む場所が無くなる（#666 の constraints「確認の中身は 1 件ずつのときから
 * 省かない」）。主語だけを呼ぶ側が渡す。
 *
 * @param subject 主語（「この作品」「選んだ作品」）。固定の文字列だけを渡す（エスケープしない）
 * @returns HTML
 */
export function deletionConsequences(subject: string): string {
  return `<div>
<h3>削除すると</h3>
<ul>
  <li><strong>元に戻せません。</strong></li>
  <li>${subject}のソースコード・遊ぶためのファイル・紹介用の画像が消えます。リフォージの前の版も消えます。</li>
  <li>「あなたの作品」の一覧に出なくなります。</li>
</ul>
</div>
<div>
<h3>削除しても変わらないこと</h3>
<ul>
  <li><strong>${subject}をフォークした作品は消えません。</strong>フォークした作品の側では、元の作品が「削除済みの作品から派生」と表示されます。</li>
  <li>${subject}を作るために使った 1 日の生成枠は戻りません。</li>
</ul>
</div>`;
}

/** 確認画面を組み立てるのに要るもの。 */
export interface DeleteConfirmationView {
  /** 作品 id（フォームと、戻る先の作品ページに使う）。 */
  readonly gameId: string;
  /** 作品の題名（UGC。作者本人にしか出さない画面なので渡す）。 */
  readonly title: string;
}

/**
 * 確認画面の HTML を組み立てる（仕様 2.5.4 / 2.5.5）。
 *
 * # 何が起き、何が起きないかを押す前に書く
 *
 * #517 の scope.in のとおり、**起きること**（戻せない・ソース・遊ぶためのファイル・紹介用の画像が消える）と
 * **起きないこと**（フォークされた作品は残る・生成に使った日次の枠は戻らない）を分けて書く。取り下げの口が
 * 「連鎖しないことを押す前に書く」のと同じ理由である（仕様 1.2.31「黙って失敗を作らない」）。
 *
 * # 削除のボタンを主にしない
 *
 * **削除は破壊的な操作なので、既定の主ボタンにしない**（仕様 2.5.5 の段。#517 の constraints）。副のボタンにし、
 * 「やめる」は作品ページへ戻る移動なので `<a>` にする。**この画面には主のボタンを置かない**——いちばん
 * してほしいことが「消す」でも「やめる」でもなく、読んで決めることだからである。
 *
 * # JavaScript を要求しない
 *
 * 素の `<form method="post">` で送る。CSRF は他の口と同じく、セッション cookie の `SameSite=Lax` が受ける。
 *
 * # 見た目は既存の部品だけで組む
 *
 * 面は `.gf-block`、行の区切りは `.gf-block-rows`、行の見出しは作品ページの設定のブロック（`.gf-work-settings`）と
 * 同じ形にする。`public/assets/app.css` に規則を足さない。
 *
 * @param view 表示に要る値
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderDeleteConfirmation(view: DeleteConfirmationView, viewer: SiteViewer): string {
  return `${siteHead({ title: 'この作品を削除しますか - Game Forge', noindex: true, viewer })}
<h1>この作品を削除しますか</h1>
<p>削除する作品: <strong>${escapeHtml(view.title)}</strong></p>
<section class="gf-block gf-block-rows gf-work-settings" aria-label="削除の確認">
${deletionConsequences('この作品')}
<div>
<form method="post" action="${WORK_DELETE_PATH}">
  <input type="hidden" name="${WORK_DELETE_GAME_ID_FIELD}" value="${view.gameId}">
  <button type="submit" class="gf-button gf-button-secondary">この作品を削除する</button>
</form>
<p><a href="${workEditPath(view.gameId)}">削除せずに編集へ戻る</a></p>
</div>
</section>
${siteFooter()}`;
}

/**
 * 削除を断る画面の HTML を組み立てる（確認画面を開いたときと、削除の口が断ったときの両方）。
 *
 * **作品ページへ 303 で戻さない。** 戻すと、断られたことが URL にもステータスにも残らない（取り下げの
 * `removeRefusal` と同じ判断）。**作品の状態で断ったときだけ、エディットページへ戻るリンクを添える**（#664）——見つからない
 * ときに添えると、押した先がまた 404 になる。
 *
 * @param refusal 断りの中身（{@link DELETE_REFUSALS} の 1 行）
 * @param backGameId 戻る先の作品 id（添えないなら null）
 * @param viewer いま見ている人の状態（省略するとヘッダは未ログインの形）
 * @returns HTML
 */
export function renderDeleteRefusal(
  refusal: DeleteRefusal,
  backGameId: string | null,
  viewer?: SiteViewer,
): string {
  const back =
    backGameId === null ? '' : `\n<p><a href="${workEditPath(backGameId)}">編集へ戻る</a></p>`;
  return `${siteHead({ title: `${refusal.heading} - Game Forge`, noindex: true, viewer })}
<h1>${refusal.heading}</h1>
<p class="gf-block">${refusal.body}</p>${back}
${siteFooter()}`;
}

/**
 * 削除に成功したときの戻り先（POST-redirect-GET）。**「あなたの作品」一覧**である——削除した作品のページは、
 * 行ごと消えていれば 404 になり、行を残していれば取り下げ済みの表示になる。どちらも削除した直後に見せる画面ではない。
 */
export const WORK_DELETED_REDIRECT = MY_WORKS_PATH;
