/**
 * 試用モード（#977）のパスとフォームの項目名。
 *
 * **綴りの正本はここだけである**——画面（`src/trial.ts`）・管理画面（`src/admin/trials.ts`）・テストが
 * 同じ定数を読む。後片付けの Worker（`workers/cleanup/`）は D1 の表しか見ないので、ここを読まない。
 */

/** 試用の画面（印のある、ログイン中の利用者だけ。それ以外は 404）。 */
export const TRIAL_PATH = '/trial';

/** 段を 1 つ進める口（`POST`。フォームの {@link TRIAL_FROM_FIELD} に「いまの段」を載せる）。 */
export const TRIAL_STEP_API_PATH = '/api/trial/step';

/** アンケートを送る口（`POST`。アンケートの段でだけ受け付ける）。 */
export const TRIAL_SURVEY_API_PATH = '/api/trial/survey';

/**
 * 段を進める口へ「いまの段」を載せる項目。
 *
 * **進む先はサーバーが決める**（いまの段の次だけ）。載せるのは「どの画面から押したか」で、
 * 2 枚のタブで同じボタンを押し直したときに、2 段進まないようにするためである（`src/trial-store.ts`）。
 */
export const TRIAL_FROM_FIELD = 'from';

/** 同意の段で、同意したことを載せる項目（値は {@link TRIAL_CONSENT_AGREE}）。 */
export const TRIAL_CONSENT_FIELD = 'consent';

/** {@link TRIAL_CONSENT_FIELD} の値。 */
export const TRIAL_CONSENT_AGREE = 'agree';

/** アンケートの項目: 使ったブラウザ。 */
export const TRIAL_SURVEY_BROWSER_FIELD = 'browser';

/** アンケートの項目: AI でものを作った経験。 */
export const TRIAL_SURVEY_AI_FIELD = 'ai_experience';

/** アンケートの項目: 声で言い損ねたこと。 */
export const TRIAL_SURVEY_MISSED_FIELD = 'missed';

/**
 * 録画を始める口（`POST`。JSON の本文 `{ mimeType, displaySurface }`。#978）。
 *
 * 録画 1 本の id を払い出し、始めた時刻をサーバーの時計で残す。**録画の準備〜振り返り 5 の段でだけ受け付ける**
 * （アンケートの段では止めるだけで、始め直さない）。
 */
export const TRIAL_RECORDING_START_API_PATH = '/api/trial/recording/start';

/**
 * 録画の断片を 1 つ送る口（`POST`。本文は断片のバイト列そのもの。#978）。
 *
 * 問い合わせに {@link TRIAL_RECORDING_ID_PARAM} と {@link TRIAL_RECORDING_SEQ_PARAM} を載せる。
 * **録画の準備〜アンケートの段でだけ受け付ける**（アンケートの段では、止めた後の残りを送り切る）。
 */
export const TRIAL_RECORDING_CHUNK_API_PATH = '/api/trial/recording/chunk';

/**
 * 録画が止まったことを伝える口（`POST`。JSON の本文 `{ recordingId, reason }`。#978）。
 *
 * 試用者が「共有を停止」を押した（`share-ended`）ことを、管理画面から読めるように残す。
 */
export const TRIAL_RECORDING_STOP_API_PATH = '/api/trial/recording/stop';

/** 断片の口と管理画面の口で、録画の id を載せる問い合わせの名前。 */
export const TRIAL_RECORDING_ID_PARAM = 'recording';

/** 断片の口で、断片の連番（0 から）を載せる問い合わせの名前。 */
export const TRIAL_RECORDING_SEQ_PARAM = 'seq';

/**
 * 管理画面（admin ホスト）で、録画の断片をつないで返す口（`GET`。#978）。
 *
 * 問い合わせに {@link TRIAL_RECORDING_ID_PARAM} と {@link TRIAL_RECORDING_PART_PARAM} を載せる。
 * **`/api/` の下に置く**——画面ではなくバイト列を返すので、画面の検査（`src/page-paths.ts`）の対象から外れる。
 */
export const ADMIN_TRIAL_RECORDING_PATH = '/api/trials/recording';

/** 管理画面の口で、何番目の部分（断片の束）を返すかを載せる問い合わせの名前（0 から）。 */
export const TRIAL_RECORDING_PART_PARAM = 'part';

/**
 * 管理画面（admin ホスト）で、試用者 1 人の録画をすべて消す口（`POST`。#978）。
 *
 * 試用者に頼まれたとき（同意の文面の「録画の削除は、いつでも頼めます」）に使う。フォームに
 * {@link TRIAL_RECORDING_USER_FIELD} と {@link TRIAL_RECORDING_DELETE_CONFIRM_FIELD} を載せる。
 */
export const ADMIN_TRIAL_RECORDINGS_DELETE_PATH = '/api/trials/recordings/delete';

/** 録画を消す口で、試用者の id を載せる項目。 */
export const TRIAL_RECORDING_USER_FIELD = 'user';

/** 録画を消す口で、確かめたことを載せる項目（値は {@link TRIAL_RECORDING_DELETE_CONFIRM_VALUE}）。 */
export const TRIAL_RECORDING_DELETE_CONFIRM_FIELD = 'confirm';

/** {@link TRIAL_RECORDING_DELETE_CONFIRM_FIELD} の値。 */
export const TRIAL_RECORDING_DELETE_CONFIRM_VALUE = 'delete';

/** 録画を消した後の一覧で、結果を載せる問い合わせの名前（消した本数か `invalid`）。 */
export const TRIAL_RECORDING_DELETED_QUERY = 'deleted';
