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
