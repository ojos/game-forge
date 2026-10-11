/**
 * 試用モード（#977）の D1 の読み書き。
 *
 * **このモジュールは画面を知らない**（文面は `src/trial-text.ts`、画面は `src/trial.ts`）。後片付けの Worker
 * （`workers/cleanup/src/index.ts`）が {@link sweepExpiredTrialRecords} を読むので、HTML や経路表を import しない。
 *
 * ## 段を飛ばせないことは、条件付き UPDATE 1 文が持つ
 *
 * 進む先は「いまの段の次」だけで、書く文は `where user_id = ? and stage = ?` を持つ（{@link advanceTrialStage}）。
 * 画面が古いまま押された（2 枚のタブ・戻るボタン）ときは 0 行になり、何も書かない。**読んでから書く形にしない**
 * ——読んだ後に別のタブが進めると、読んだ段から 2 段進む。
 *
 * ## 書くのは段の移り目とアンケートだけ
 *
 * 画面を開く（GET）たびには書かない。1 人あたりの書き込みは 9 文（同意・録画の準備・触り終えた・2〜5 問・
 * 答え終えた・アンケート）で、3.6 の書き込みの上限に触れない。
 *
 * **録画（#978）は別の表に書く**（`src/trial-recording-store.ts`）。断片 1 つにつき 1 文（5 秒ごと。60 分で 720 文）で、
 * 試用者は数人なので、1 日の書き込みは数千文に収まる。
 */
import { sweepExpiredTrialRecordings } from './trial-recording-store.js';

/** 段（列 `stage` の値。並びが進む順である）。 */
export const TRIAL_STAGES = [
  'consent',
  'recording',
  'explore',
  'q1',
  'q2',
  'q3',
  'q4',
  'q5',
  'survey',
  'done',
] as const;

/** 段。 */
export type TrialStage = (typeof TRIAL_STAGES)[number];

/** 振り返りの問いの段（並びが問いの順である）。 */
export const TRIAL_QUESTION_STAGES = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;

/** 振り返りの問いの段。 */
export type TrialQuestionStage = (typeof TRIAL_QUESTION_STAGES)[number];

/**
 * 段に入った時刻を残す列（段 → 列）。
 *
 * **`consent` には列が無い**（印を付けた時刻 `marked_at` が、同意の画面に入った時刻の代わりである）。
 * `recording` に入る時刻は同意した時刻なので `consented_at` に残す。
 *
 * **SQL へ差し込むのはこの表の値だけである**（利用者の入力は列名にならない）。
 */
export const TRIAL_STAGE_COLUMNS: Readonly<Record<Exclude<TrialStage, 'consent'>, string>> = {
  recording: 'consented_at',
  explore: 'explore_at',
  q1: 'q1_at',
  q2: 'q2_at',
  q3: 'q3_at',
  q4: 'q4_at',
  q5: 'q5_at',
  survey: 'survey_at',
  done: 'completed_at',
};

/**
 * 試用の記録を消すまでの日数（同意した日から。同意していなければ印を付けた日から）。
 *
 * **`/privacy` と試用の同意の文面が、この値を読む**（数字を書き写さない）。
 */
export const TRIAL_RETENTION_DAYS = 90;

/**
 * アンケートの答えの長さの上限（文字数。コードポイントで数える）。
 *
 * ブラウザは名前と版が入れば足りる。AI の経験は数文、言い損ねたことは声で言い損ねた分なので数段落まで。
 */
export const TRIAL_SURVEY_LIMITS = {
  browser: 100,
  aiExperience: 1000,
  missed: 2000,
} as const;

/** 試用者の行（列のうち、画面と管理画面が読むもの）。 */
export interface TrialParticipantRow {
  readonly user_id: string;
  readonly marked_at: number;
  readonly stage: TrialStage;
  readonly consent_version: string | null;
  readonly consented_at: number | null;
  readonly explore_at: number | null;
  readonly q1_at: number | null;
  readonly q2_at: number | null;
  readonly q3_at: number | null;
  readonly q4_at: number | null;
  readonly q5_at: number | null;
  readonly survey_at: number | null;
  readonly completed_at: number | null;
  readonly survey_browser: string | null;
  readonly survey_ai_experience: string | null;
  readonly survey_missed: string | null;
}

/** 行を引くときの列（{@link TrialParticipantRow} と同じ並び）。 */
const PARTICIPANT_COLUMNS = `user_id, marked_at, stage, consent_version, consented_at, explore_at,
       q1_at, q2_at, q3_at, q4_at, q5_at, survey_at, completed_at,
       survey_browser, survey_ai_experience, survey_missed`;

/**
 * 値が段の名前かどうか。
 *
 * @param value 調べる値
 * @returns 段の名前なら true
 */
export function isTrialStage(value: string): value is TrialStage {
  return (TRIAL_STAGES as readonly string[]).includes(value);
}

/**
 * 次の段を返す。
 *
 * @param stage いまの段
 * @returns 次の段（`done` の次は無いので null）
 */
export function nextTrialStage(stage: TrialStage): TrialStage | null {
  const index = TRIAL_STAGES.indexOf(stage);
  return TRIAL_STAGES[index + 1] ?? null;
}

/**
 * 試用者の行を引く（**行が無いことが「印が無い」である**）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @returns 行（印が無ければ null）
 */
export async function findTrialParticipant(db: D1Database, userId: string): Promise<TrialParticipantRow | null> {
  return await db
    .prepare(`select ${PARTICIPANT_COLUMNS} from trial_participants where user_id = ?`)
    .bind(userId)
    .first<TrialParticipantRow>();
}

/** 運営の一覧に並べる行（試用者の行と、利用者の表示名）。 */
export interface TrialParticipantListRow extends TrialParticipantRow {
  readonly display_name: string;
}

/**
 * 試用者を、印を付けた新しい順に引く（管理画面）。
 *
 * @param db D1
 * @param limit 取得件数の上限
 * @returns 行
 */
export async function listTrialParticipants(
  db: D1Database,
  limit: number,
): Promise<readonly TrialParticipantListRow[]> {
  const result = await db
    .prepare(
      `select t.user_id, t.marked_at, t.stage, t.consent_version, t.consented_at, t.explore_at,
              t.q1_at, t.q2_at, t.q3_at, t.q4_at, t.q5_at, t.survey_at, t.completed_at,
              t.survey_browser, t.survey_ai_experience, t.survey_missed, u.display_name
         from trial_participants t join users u on u.id = t.user_id
        order by t.marked_at desc, t.user_id desc
        limit ?`,
    )
    .bind(limit)
    .all<TrialParticipantListRow>();
  return result.results;
}

/** 段を進めるときに一緒に書くもの。 */
export interface TrialAdvanceOptions {
  /** 同意の段から進むときの、同意した文面の版（同意の段から進むときは必須）。 */
  readonly consentVersion?: string;
}

/**
 * 段を 1 つ進める（`from` の次の段へ。アンケートの段からは進めない——{@link completeTrialSurvey} を使う）。
 *
 * **条件付き UPDATE 1 文である**（モジュール冒頭）。`from` がいまの段でなければ 0 行で、何も書かない。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param from 画面が出していた段
 * @param now 時刻（UNIX 秒）
 * @param options 一緒に書くもの
 * @returns 進めたら true（いまの段が `from` でなかった・進めない段だったら false）
 */
export async function advanceTrialStage(
  db: D1Database,
  userId: string,
  from: TrialStage,
  now: number,
  options: TrialAdvanceOptions = {},
): Promise<boolean> {
  const to = nextTrialStage(from);
  if (to === null || from === 'survey') {
    return false;
  }
  const column = TRIAL_STAGE_COLUMNS[to as Exclude<TrialStage, 'consent'>];
  if (from === 'consent') {
    if (options.consentVersion === undefined || options.consentVersion === '') {
      return false;
    }
    const result = await db
      .prepare(
        `update trial_participants set stage = ?, ${column} = ?, consent_version = ?
          where user_id = ? and stage = ?`,
      )
      .bind(to, now, options.consentVersion, userId, from)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
  const result = await db
    .prepare(`update trial_participants set stage = ?, ${column} = ? where user_id = ? and stage = ?`)
    .bind(to, now, userId, from)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** アンケートの答え（検査済み）。 */
export interface TrialSurveyAnswers {
  readonly browser: string;
  readonly aiExperience: string;
  readonly missed: string;
}

/** アンケートの答えの検査の結果。 */
export type TrialSurveyValidation =
  | { readonly ok: true; readonly answers: TrialSurveyAnswers }
  | { readonly ok: false; readonly reason: 'too-long' | 'empty' };

/**
 * 文字数をコードポイントで数える（絵文字 1 つを 2 と数えない）。
 *
 * @param value 文字列
 * @returns 文字数
 */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * アンケートの答えを検査する（前後の空白を落とし、長さの上限と必須の項目を見る）。
 *
 * **長すぎる答えは切り詰めずに断る**——黙って切ると、言い損ねたことの後半が消えたことに誰も気づかない。
 * 必須はブラウザと AI の経験の 2 つで、言い損ねたことは空でよい。
 *
 * @param raw 送られた値（未検査）
 * @returns 検査済みの答え、または理由
 */
export function validateTrialSurvey(raw: {
  readonly browser: string;
  readonly aiExperience: string;
  readonly missed: string;
}): TrialSurveyValidation {
  const answers: TrialSurveyAnswers = {
    browser: raw.browser.trim(),
    aiExperience: raw.aiExperience.trim(),
    missed: raw.missed.trim(),
  };
  if (
    codePointLength(answers.browser) > TRIAL_SURVEY_LIMITS.browser ||
    codePointLength(answers.aiExperience) > TRIAL_SURVEY_LIMITS.aiExperience ||
    codePointLength(answers.missed) > TRIAL_SURVEY_LIMITS.missed
  ) {
    return { ok: false, reason: 'too-long' };
  }
  if (answers.browser === '' || answers.aiExperience === '') {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, answers };
}

/**
 * アンケートを書いて、試用を終える（アンケートの段にいるときだけ。条件付き UPDATE 1 文）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param answers 検査済みの答え
 * @param now 時刻（UNIX 秒）
 * @returns 書いたら true（アンケートの段でなかったら false）
 */
export async function completeTrialSurvey(
  db: D1Database,
  userId: string,
  answers: TrialSurveyAnswers,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `update trial_participants
          set stage = 'done', completed_at = ?,
              survey_browser = ?, survey_ai_experience = ?, survey_missed = ?
        where user_id = ? and stage = 'survey'`,
    )
    .bind(now, answers.browser, answers.aiExperience, answers.missed, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * {@link TRIAL_RETENTION_DAYS} 日を過ぎた試用の記録を消す（`game-forge-cleanup` の cron。5 分ごと）。
 *
 * **数える起点は同意した日である**（同意していなければ印を付けた日）。同意の文面の「90 日で消します」と、
 * 印だけが付いたまま始めなかった人の印が残り続けないことの 2 つを、1 文で満たす。
 *
 * **行ごと消すので、印も消える**（試用は終わっている）。件数は縛らない——試用者は数人で、桁で増える経路が無い。
 *
 * **録画の目録（`trial_recordings`。#978）も、始めてから同じ日数で消す**（`src/trial-recording-store.ts` の
 * `sweepExpiredTrialRecordings`）。録画の断片そのものは R2 のライフサイクルが、それより前に消す（terraform/trial-recordings.tf）。2 つの表は互いを参照しない
 * ので、どちらを先に消しても外部キーに触れない。
 *
 * @param db D1
 * @param now 時刻（UNIX 秒）
 * @returns 消した行数（試用者の行と録画の目録の行の合計）
 */
export async function sweepExpiredTrialRecords(db: D1Database, now: number): Promise<number> {
  const cutoff = now - TRIAL_RETENTION_DAYS * 24 * 60 * 60;
  const result = await db
    .prepare('delete from trial_participants where coalesce(consented_at, marked_at) < ?')
    .bind(cutoff)
    .run();
  const recordings = await sweepExpiredTrialRecordings(db, now, TRIAL_RETENTION_DAYS);
  return (result.meta.changes ?? 0) + recordings;
}
