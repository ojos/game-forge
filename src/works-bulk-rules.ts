/**
 * 「あなたの作品」の一括操作（#666）の、操作の種類・対象から外す理由・外すかどうかの判定。
 *
 * **ここは純粋な判定だけを持つ**（D1 も画面も持たない）。確認画面（`src/works-bulk-page.ts`）と実行の口
 * （`src/works-bulk.ts`）が同じ判定を読む。
 *
 * ## 1 件ずつなら許されない操作は、一括でも許さない（#666 の constraints）
 *
 * **判定の正本は、1 件ずつの口が呼ぶ関数の SQL である**——公開は `publishGame`、下書きへ戻すは `unpublishGame`、
 * 削除は `deleteGame`（と作者の検査の `deleteAuthoredGame`）。**一括の口もそれらを 1 件ずつ呼ぶ**ので、ここで誤って
 * 通しても、最後に断るのはあちらである。
 *
 * ここの {@link bulkBlockOf} は、**押す前に「この作品は外します」と名前付きで見せるための表示の条件**である
 * （`src/work-delete.ts` の `deletionBlockOf` と同じ位置づけ。削除はその関数をそのまま使う）。**判定をあちらより
 * 緩めない**——あちらが断る行をここが通すと、確認画面に「公開します」と出た作品が実行で断られ、利用者には
 * 確認画面が嘘をついたように見える。逆向き（ここが外し、あちらは通す）も作らない。**条件は各関数の WHERE を
 * そのまま写してある**（下の各行の注記）。一致は `test/works-bulk.test.ts` が、行の状態ごとに両方を呼んで確かめる。
 */
import { DRAFT_STATUS, PUBLISHED_STATUS, validateWorkTags, workTagsOf } from './games.js';
import type { DeletionTargetRow } from './work-delete.js';
import { deletionBlockOf, deletionStateOf } from './work-delete.js';

/** 一括操作の種類。**URL と本文に載る綴りである**（`src/my-works.ts` の `BULK_BUTTONS` と同じ）。 */
export const BULK_ACTIONS = ['publish', 'unpublish', 'delete'] as const;

/** 一括操作の種類。 */
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * 値を操作の種類へ落とす。**読めない値は null**（確認画面・実行の口がそれぞれの形で断る）。
 *
 * @param value 項目の値
 * @returns 操作の種類。読めなければ null
 */
export function toBulkAction(value: string | null | undefined): BulkAction | null {
  return (BULK_ACTIONS as readonly string[]).includes(value ?? '') ? (value as BulkAction) : null;
}

/**
 * 一度に選べる作品の数（**30 件**）。
 *
 * **「あなたの作品」の 1 頁の件数と同じ値である**（`src/my-works.ts` の `MY_WORKS_PER_PAGE`。値を借りると循環参照に
 * なるので写し、一致は `test/works-bulk.test.ts` が見る）。選べるのは 1 頁に並んだ作品だけなので、これより大きくしても
 * 意味が無く、小さくすると「1 頁を全部選んで押したら断られる」になる。
 *
 * **上限を置く理由**は、1 回の確認画面と実行が読む行の数と、実行の往復の数（{@link BULK_STEP_SIZES}）を縛るためである。
 */
export const MAX_BULK_WORKS = 30;

/**
 * 実行の 1 往復で処理する件数（操作ごと）。
 *
 * **Workers Free の D1 の枠（1 呼び出しあたり 50 文。仕様 3.6 / `src/withdrawal-purge.ts` の `D1_QUERY_LIMIT`）から
 * 決めた値である。** 1 件の削除は `deleteGame` だけで 14〜15 文を使う（`src/game-deletion.ts` の冒頭）ので、30 件を
 * 1 回の呼び出しでは消せない。そこで実行の口は**数件ずつ処理しては、同じ本文のまま次の往復へ 307 で送る**
 * （`src/works-bulk.ts` の「往復に分ける」）。
 *
 * 1 往復の文の数（実測。`test/works-bulk.test.ts` が最悪の形で数え、枠と比べる）:
 *
 * | 操作 | 1 件あたり | 件数 | 前後（セッション・行の読み取り・結果の名前） |
 * |---|---|---|---|
 * | 削除 | 作者の検査 1 ＋ `deleteGame` 14〜15。**20 文を予約する**（`src/withdrawal-purge.ts` の `DELETE_RESERVE` と同じ余裕） | 2 | 2 文 |
 * | 公開 | 公開 1・親の数え直し 1・撮影の掴み 1〜2・改造の通知 最大 3 で **最大 7 文** | 5 | 同上 |
 * | 下書きへ戻す | 戻す 1・親の数え直し 1 で **2 文** | 10 | 同上 |
 *
 * **実測（2026-09-18。`test/works-bulk.test.ts`、30 件）は 1 往復あたり 削除 34 文・公開 32 文・下書きへ戻す 22 文**
 * （セッション 1・選んだ作品の行の読み直し 1 を含む。例外が出た作品は、行を読み直す 1 文が増える）。削除は版と成果物を持つ
 * 作品、公開はフォーク（親の数え直しが実際に書く）で、通知の 3 文も打たせて数えた。
 *
 * **往復の数はブラウザがたどれるリダイレクトの数に収める**（Safari は 16 回）。30 件の削除が 15 往復（リダイレクト 14 回）
 * で、いちばん多い（公開は 6 往復、下書きへ戻すは 3 往復）。
 */
export const BULK_STEP_SIZES: Readonly<Record<BulkAction, number>> = {
  publish: 5,
  unpublish: 10,
  delete: 2,
};

/**
 * 対象から外す理由・実行で断られた理由（#666）。**URL に載る綴りである**（往復のあいだ、断られた作品を運ぶ）。
 *
 * - `not-found` … 行が無い・**他人の作品**（区別しない。名前も出さない）
 * - `already-published` / `already-draft` … もうその状態になっている
 * - `generating` … 生成中（公開も削除もできない）
 * - `failed` … 生成に失敗した（公開できない。削除はできる）
 * - `revising` … リフォージ中（削除できない）
 * - `published` … 公開中（削除できない。先に下書きへ戻す）
 * - `removed` … 運営の措置で公開を止めている（公開も下書きへ戻すもできない）
 * - `purged` … 中身をもう消してある
 * - `deleting` … 削除を始めている
 * - `busy` … 読み直すあいだに状態が動いた（`deleteGame` の `busy`）
 * - `tags` … いまの語彙に無いタグが付いている（公開の検査 `validateWorkTags` が断る）
 * - `error` … 処理の途中で例外が出て、行も目的の状態になっていない（その作品だけを失敗にして、残りは続ける）
 * - `post-error` … 例外は出たが、行は目的の状態になっている（公開・下書きへ戻すは行を書き換えてから撮影や通知をする。
 *   **成功に数え**、結果の画面で「後の処理に失敗した」と別に示す。PR #669 の Copilot code review）
 */
export const BULK_REASONS = [
  'not-found',
  'already-published',
  'already-draft',
  'generating',
  'failed',
  'revising',
  'published',
  'removed',
  'purged',
  'deleting',
  'busy',
  'tags',
  'error',
  'post-error',
] as const;

/** 対象から外す理由。 */
export type BulkReason = (typeof BULK_REASONS)[number];

/**
 * 値を理由へ落とす。
 *
 * @param value 値
 * @returns 理由。読めなければ null
 */
export function toBulkReason(value: string): BulkReason | null {
  return (BULK_REASONS as readonly string[]).includes(value) ? (value as BulkReason) : null;
}

/**
 * 理由ごとの文言。**名前の後ろに続ける 1 文である**（「〇〇 — すでに公開中です。」）。`not-found` だけは名前を
 * 出さずに件数で言う（`src/works-bulk-page.ts`）。
 */
export const BULK_REASON_TEXTS: Readonly<Record<BulkReason, string>> = {
  'not-found': '見つかりません（自分の作品でないか、すでに削除されています）。',
  'already-published': 'すでに公開中です。',
  'already-draft': 'すでに下書きです。',
  generating: '生成中です。生成が終わってから操作してください。',
  failed: '生成できなかった作品は公開できません（リフォージするか、削除できます）。',
  revising: 'リフォージ中です。リフォージが終わってから削除してください。',
  published: '公開中の作品は削除できません。先に「下書きに戻す」で下書きにしてください。',
  removed: '公開を停止している作品です。公開も、下書きに戻すこともできません。',
  purged: 'すでに削除されています。',
  deleting: '削除を進めている作品です。',
  busy: 'ちょうど作品の状態が変わったため、操作できませんでした。一覧を開き直してからもう一度お試しください。',
  tags: 'いまは選べないタグが付いています。作品ページでタグを付け直してから公開してください。',
  error: '処理の途中で失敗しました。時間をおいて、もう一度お試しください。',
  'post-error': '操作はできましたが、そのあとの処理（紹介用の画像の撮影など）に失敗しました。',
};

/**
 * 対象の行（確認画面と実行の口が読む）。**`src/work-delete.ts` の `DELETION_TARGET_SQL` と同じ列に、公開の判定に
 * 要る列（削除の掴み・タグ）と id を足したもの。**
 */
export interface BulkTargetRow extends DeletionTargetRow {
  readonly id: string;
  /** `games.deletion_started_at`（削除を掴まれた時刻）。 */
  readonly deletion_started_at: number | null;
  readonly tag1: string | null;
  readonly tag2: string | null;
  readonly tag3: string | null;
}

/**
 * 対象の行を引く SQL（束縛: 作品 id を `count` 個）。
 *
 * **作者の一致は SQL に入れない**（`DELETION_TARGET_SQL` と同じ理由。行が無いことと他人の作品であることを、
 * {@link bulkBlockOf} が同じ `not-found` に畳む）。**題名は作者本人の行のときだけ画面に出す**（`src/works-bulk-page.ts`）。
 *
 * @param count id の数（1 以上 {@link MAX_BULK_WORKS} 以下。D1 の束縛の上限 100 に収まる）
 * @returns SELECT 文
 */
export function bulkTargetsSql(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BULK_WORKS) {
    throw new Error(`一括操作の対象の数が不正です: ${count}`);
  }
  const placeholders = Array.from({ length: count }, () => '?').join(', ');
  return `select g.id, g.author_id, g.status, g.generation_state, g.title, g.deletion_started_at,
            g.tag1, g.tag2, g.tag3,
            (g.purged_at is not null) as purged,
            exists (select 1 from game_revision_jobs j
                     where j.game_id = g.id and j.state in ('pending', 'running')) as revising
       from games g
      where g.id in (${placeholders})`;
}

/**
 * この作品を対象から外す理由を返す（外さなければ null）。**表示の条件である**（冒頭）。
 *
 * @param action 操作
 * @param row 行（無ければ null）
 * @param userId 操作している利用者
 * @returns 外す理由。外さなければ null
 */
export function bulkBlockOf(action: BulkAction, row: BulkTargetRow | null, userId: string): BulkReason | null {
  if (row === null || row.author_id !== userId) {
    return 'not-found';
  }
  const generation = row.generation_state;
  switch (action) {
    case 'publish':
      // `publishGame` の WHERE: `status = 'draft' and generation_state = 'ready' and deletion_started_at is null`。
      if (row.status === PUBLISHED_STATUS) {
        return 'already-published';
      }
      if (row.status !== DRAFT_STATUS) {
        return row.purged === 1 ? 'purged' : 'removed';
      }
      if (row.deletion_started_at !== null) {
        return 'deleting';
      }
      if (generation === 'failed') {
        return 'failed';
      }
      if (generation !== 'ready') {
        return 'generating';
      }
      // **いま付いているタグで公開する**ので、`publishGame` と同じ検査（`validateWorkTags`）を掛ける。語彙に無いタグを
      // 黙って落とすと、1 件ずつの口（`unknown-tag` で断る）より緩くなる（PR #669 の Copilot code review）。
      return validateWorkTags(workTagsOf(row)).ok ? null : 'tags';
    case 'unpublish':
      // `unpublishGame` の WHERE: `status = 'published' and deletion_started_at is null`。
      if (row.status === DRAFT_STATUS) {
        return 'already-draft';
      }
      if (row.status !== PUBLISHED_STATUS) {
        return row.purged === 1 ? 'purged' : 'removed';
      }
      return row.deletion_started_at !== null ? 'deleting' : null;
    case 'delete': {
      // 削除は 1 件ずつの確認画面と同じ判定をそのまま使う（`deletionBlockOf`）。
      const block = deletionBlockOf(deletionStateOf(row));
      return block === null ? null : block;
    }
  }
}
