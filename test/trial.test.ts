import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TRIALS_PATH } from '../src/admin-paths.js';
import { handleAdminRequest } from '../src/admin/routes.js';
import { formatJstSeconds } from '../src/admin/trials.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { handleAppRequest } from '../src/app.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { createTrialRoutes, isMobileUserAgent, renderTrialStage } from '../src/trial.js';
import {
  TRIAL_CONSENT_AGREE,
  TRIAL_CONSENT_FIELD,
  TRIAL_FROM_FIELD,
  TRIAL_PATH,
  TRIAL_STEP_API_PATH,
  TRIAL_SURVEY_AI_FIELD,
  TRIAL_SURVEY_API_PATH,
  TRIAL_SURVEY_BROWSER_FIELD,
  TRIAL_SURVEY_MISSED_FIELD,
} from '../src/trial-paths.js';
import type { TrialParticipantRow, TrialStage } from '../src/trial-store.js';
import {
  TRIAL_RETENTION_DAYS,
  TRIAL_STAGES,
  TRIAL_SURVEY_LIMITS,
  nextTrialStage,
  sweepExpiredTrialRecords,
  validateTrialSurvey,
} from '../src/trial-store.js';
import { TRIAL_CONSENT_VERSION, TRIAL_QUESTIONS } from '../src/trial-text.js';
import type { CleanupEnv } from '../workers/cleanup/src/hub.js';
import cleanupWorker from '../workers/cleanup/src/index.js';
import { applySchema } from './helpers/schema.js';

/**
 * 試用モード（#977）の検査。
 *
 * scope.in のテスト: 印の無い利用者に /trial が 404 / 同意の前に何も記録されない / 段を飛ばせない /
 * アンケートの長さの上限 / admin 以外に管理画面が 404 / 90 日の後片付け。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
const SECRET = 'test-secret-value-for-trial-mode-checks-01';

/** PC の Chrome の User-Agent。 */
const PC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/** iPhone の Safari の User-Agent。 */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** 試験の基準時刻（UNIX 秒）。 */
const NOW = 1_800_000_000;

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人入れる。
 *
 * @param label 名前の目印
 * @returns 利用者の id
 */
async function insertUser(label: string): Promise<string> {
  const id = `trial-${label}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.test`, label, NOW)
    .run();
  return id;
}

/**
 * 試用者の印を付ける（運営が D1 で入れる 1 行と同じ形）。
 *
 * @param userId 利用者の id
 * @param markedAt 印を付けた時刻
 */
async function mark(userId: string, markedAt = NOW): Promise<void> {
  await env.DB.prepare('insert into trial_participants (user_id, marked_at) values (?, ?)')
    .bind(userId, markedAt)
    .run();
}

/**
 * 署名付きセッション cookie の `name=value` を作る。
 *
 * @param userId 利用者の id
 * @returns cookie
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 試用者の行を引く。
 *
 * @param userId 利用者の id
 * @returns 行（無ければ null）
 */
async function rowOf(userId: string): Promise<TrialParticipantRow | null> {
  return await env.DB.prepare('select * from trial_participants where user_id = ?')
    .bind(userId)
    .first<TrialParticipantRow>();
}

/** 時計（テストが進める）。 */
let clock = NOW;

/**
 * 試用の経路に要求を投げる（時計を差し替えた経路表を通す）。
 *
 * @param path パス
 * @param options cookie・本文・User-Agent
 * @returns レスポンス
 */
async function call(
  path: string,
  options: { cookie?: string; form?: Record<string, string>; ua?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'user-agent': options.ua ?? PC_UA };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  return await dispatch(
    createTrialRoutes({ now: () => clock }),
    new Request(`${APP_ORIGIN}${path}`, { method: options.form === undefined ? 'GET' : 'POST', headers, body }),
    testEnv(),
  );
}

/**
 * 段を 1 つ進める口を押す。
 *
 * @param cookie cookie
 * @param from 画面が出していた段
 * @param extra 足す項目
 * @returns レスポンス
 */
async function step(cookie: string, from: string, extra: Record<string, string> = {}): Promise<Response> {
  return await call(TRIAL_STEP_API_PATH, { cookie, form: { [TRIAL_FROM_FIELD]: from, ...extra } });
}

/**
 * 同意する。
 *
 * @param cookie cookie
 * @returns レスポンス
 */
async function consent(cookie: string): Promise<Response> {
  return await step(cookie, 'consent', { [TRIAL_CONSENT_FIELD]: TRIAL_CONSENT_AGREE });
}

/**
 * アンケートの段まで進める。
 *
 * @param cookie cookie
 */
async function advanceToSurvey(cookie: string): Promise<void> {
  await consent(cookie);
  for (const from of ['recording', 'explore', 'q1', 'q2', 'q3', 'q4', 'q5']) {
    await step(cookie, from);
  }
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(() => {
  clock = NOW;
});

describe('印の無い利用者・未ログインには 404', () => {
  it('未ログイン・印の無い利用者は、画面が 404 の HTML で、書き込まない', async () => {
    const unmarked = await insertUser('unmarked');
    for (const cookie of [undefined, await cookieFor(unmarked)]) {
      const page = await call(TRIAL_PATH, { cookie });
      expect(page.status).toBe(404);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('location')).toBeNull();
    }
    // 口は、印の無いログイン中の利用者には 404、未ログインにはログインを求める（ほかの書き込みの口と同じ）。
    const cookie = await cookieFor(unmarked);
    const stepped = await call(TRIAL_STEP_API_PATH, { cookie, form: { [TRIAL_FROM_FIELD]: 'consent' } });
    expect(stepped.status).toBe(404);
    const surveyed = await call(TRIAL_SURVEY_API_PATH, { cookie, form: { [TRIAL_SURVEY_BROWSER_FIELD]: 'x' } });
    expect(surveyed.status).toBe(404);
    for (const path of [TRIAL_STEP_API_PATH, TRIAL_SURVEY_API_PATH]) {
      const anonymous = await call(path, { form: { [TRIAL_FROM_FIELD]: 'consent' } });
      expect(anonymous.status, path).toBe(303);
      expect(anonymous.headers.get('location'), path).toBe(LOGIN_PATH);
    }
    expect(await rowOf(unmarked)).toBeNull();
  });

  it('アプリの経路表にも載っていて、未ログインは 404（ログインへ送らない）', async () => {
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${TRIAL_PATH}`), testEnv());
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('BAN された試用者も 404', async () => {
    const banned = await insertUser('banned');
    await mark(banned);
    await env.DB.prepare('update users set banned_at = ? where id = ?').bind(NOW, banned).run();
    expect((await call(TRIAL_PATH, { cookie: await cookieFor(banned) })).status).toBe(404);
  });

  it('印の無い人の 404 と未ログインの 404 は、本文が同じ（理由を区別しない）', async () => {
    const unmarked = await insertUser('same404');
    const anon = await (await call(TRIAL_PATH)).text();
    const signed = await (await call(TRIAL_PATH, { cookie: await cookieFor(unmarked) })).text();
    const main = (body: string): string => body.slice(body.indexOf('<h1>'), body.indexOf('<footer'));
    expect(main(signed)).toBe(main(anon));
  });
});

describe('同意の前は何も記録しない', () => {
  it('同意の画面を開いても、同意の印の無い送信をしても、行は印を付けたままである', async () => {
    const userId = await insertUser('before-consent');
    await mark(userId);
    const cookie = await cookieFor(userId);
    const before = await rowOf(userId);

    const page = await call(TRIAL_PATH, { cookie });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('録画と記録の扱いについて');
    expect(body).toContain('同意しない場合は、このページを閉じてください。何も記録しません。');

    // 同意の項目が無い・違う値の送信は、同意として扱わない。
    await step(cookie, 'consent');
    await step(cookie, 'consent', { [TRIAL_CONSENT_FIELD]: 'no' });
    expect(await rowOf(userId)).toEqual(before);
    expect(before).toMatchObject({ stage: 'consent', consented_at: null, consent_version: null });
  });

  it('同意すると、同意した時刻と文面の版を残して録画の準備へ進む', async () => {
    const userId = await insertUser('consent');
    await mark(userId);
    const cookie = await cookieFor(userId);
    clock = NOW + 10;
    const response = await consent(cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(TRIAL_PATH);
    expect(await rowOf(userId)).toMatchObject({
      stage: 'recording',
      consented_at: NOW + 10,
      consent_version: TRIAL_CONSENT_VERSION,
    });
    const body = await (await call(TRIAL_PATH, { cookie })).text();
    expect(body).toContain('今回は録画をせずに進みます');
  });
});

describe('段を飛ばせない（サーバー側で見る）', () => {
  it('同意の前に、先の段から押しても進まない', async () => {
    const userId = await insertUser('skip-before');
    await mark(userId);
    const cookie = await cookieFor(userId);
    const before = await rowOf(userId);
    for (const from of ['recording', 'explore', 'q1', 'q5', 'survey', 'done', 'nonsense']) {
      expect((await step(cookie, from)).status).toBe(303);
    }
    expect(await rowOf(userId)).toEqual(before);
  });

  it('いまの段と違う段から押しても、アンケートの段の前にアンケートを送っても、何も書かない', async () => {
    const userId = await insertUser('skip-middle');
    await mark(userId);
    const cookie = await cookieFor(userId);
    await consent(cookie);
    await step(cookie, 'recording');
    const atExplore = await rowOf(userId);
    expect(atExplore?.stage).toBe('explore');

    await step(cookie, 'q4');
    await step(cookie, 'consent', { [TRIAL_CONSENT_FIELD]: TRIAL_CONSENT_AGREE });
    await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: { [TRIAL_SURVEY_BROWSER_FIELD]: 'Chrome', [TRIAL_SURVEY_AI_FIELD]: 'ない' },
    });
    expect(await rowOf(userId)).toEqual(atExplore);
  });

  it('同じボタンを 2 回押しても（古い画面から押し直しても）、1 段しか進まない', async () => {
    const userId = await insertUser('double');
    await mark(userId);
    const cookie = await cookieFor(userId);
    await consent(cookie);
    await step(cookie, 'recording');
    await step(cookie, 'recording');
    expect((await rowOf(userId))?.stage).toBe('explore');
  });

  it('アンケートの段から、段を進める口では終われない（答えを送るしかない）', async () => {
    const userId = await insertUser('survey-step');
    await mark(userId);
    const cookie = await cookieFor(userId);
    await advanceToSurvey(cookie);
    await step(cookie, 'survey');
    expect((await rowOf(userId))?.stage).toBe('survey');
  });
});

describe('最後まで通す', () => {
  it('各段に入った時刻と、5 問を出した時刻と、アンケートの答えが残る', async () => {
    const userId = await insertUser('full');
    await mark(userId, NOW - 100);
    const cookie = await cookieFor(userId);

    const seen: string[] = [];
    clock = NOW;
    seen.push(await (await call(TRIAL_PATH, { cookie })).text());
    await consent(cookie);
    const order = ['recording', 'explore', 'q1', 'q2', 'q3', 'q4', 'q5'] as const;
    for (const [index, from] of order.entries()) {
      seen.push(await (await call(TRIAL_PATH, { cookie })).text());
      clock = NOW + (index + 1) * 60;
      await step(cookie, from);
    }
    const surveyPage = await (await call(TRIAL_PATH, { cookie })).text();
    seen.push(surveyPage);
    expect(surveyPage).toContain('最後に、短いアンケート');

    clock = NOW + 1000;
    const submitted = await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: {
        [TRIAL_SURVEY_BROWSER_FIELD]: '  Chrome 129  ',
        [TRIAL_SURVEY_AI_FIELD]: 'ChatGPT で少し',
        [TRIAL_SURVEY_MISSED_FIELD]: '',
      },
    });
    expect(submitted.status).toBe(303);
    const done = await (await call(TRIAL_PATH, { cookie })).text();
    seen.push(done);
    expect(done).toContain('ありがとうございました');

    expect(await rowOf(userId)).toMatchObject({
      marked_at: NOW - 100,
      stage: 'done',
      consented_at: NOW,
      explore_at: NOW + 60,
      q1_at: NOW + 120,
      q2_at: NOW + 180,
      q3_at: NOW + 240,
      q4_at: NOW + 300,
      q5_at: NOW + 360,
      survey_at: NOW + 420,
      completed_at: NOW + 1000,
      survey_browser: 'Chrome 129',
      survey_ai_experience: 'ChatGPT で少し',
      survey_missed: '',
    });

    // 5 問は 1 問ずつ、`docs/user-trial.md` 6 章の順に出る。
    for (const [index, question] of TRIAL_QUESTIONS.entries()) {
      const page = seen[index + 3]!;
      expect(page).toContain(`振り返り（${index + 1} / 5）`);
      expect(page).toContain(question);
    }
    // 新しいタブで開くボタン（段 3）。
    expect(seen[2]).toContain('target="_blank"');
    expect(seen[2]).toContain('Game Forge を新しいタブで開く');

    // 終わった後に押し直しても、何も変わらない。
    const after = await rowOf(userId);
    await step(cookie, 'q5');
    await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: { [TRIAL_SURVEY_BROWSER_FIELD]: 'Edge', [TRIAL_SURVEY_AI_FIELD]: 'ある' },
    });
    expect(await rowOf(userId)).toEqual(after);
  });

  it('どの段の画面にも、フォークのことを書かない', () => {
    for (const stage of TRIAL_STAGES) {
      expect(renderTrialStage(stage), stage).not.toContain('フォーク');
    }
  });
});

describe('アンケートの長さの上限', () => {
  it('上限ちょうどは通り、1 文字でも超えたら 400 で何も書かない（切り詰めない）', async () => {
    const userId = await insertUser('limit');
    await mark(userId);
    const cookie = await cookieFor(userId);
    await advanceToSurvey(cookie);
    const before = await rowOf(userId);

    for (const [field, limit] of [
      [TRIAL_SURVEY_BROWSER_FIELD, TRIAL_SURVEY_LIMITS.browser],
      [TRIAL_SURVEY_AI_FIELD, TRIAL_SURVEY_LIMITS.aiExperience],
      [TRIAL_SURVEY_MISSED_FIELD, TRIAL_SURVEY_LIMITS.missed],
    ] as const) {
      const form = {
        [TRIAL_SURVEY_BROWSER_FIELD]: 'Chrome',
        [TRIAL_SURVEY_AI_FIELD]: 'ない',
        [TRIAL_SURVEY_MISSED_FIELD]: '',
        [field]: 'あ'.repeat(limit + 1),
      };
      const response = await call(TRIAL_SURVEY_API_PATH, { cookie, form });
      expect(response.status, field).toBe(400);
      const body = await response.text();
      expect(body).toContain('長すぎる答えがあります');
      expect(await rowOf(userId)).toEqual(before);
    }

    const ok = await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: {
        [TRIAL_SURVEY_BROWSER_FIELD]: '😀'.repeat(TRIAL_SURVEY_LIMITS.browser),
        [TRIAL_SURVEY_AI_FIELD]: 'い'.repeat(TRIAL_SURVEY_LIMITS.aiExperience),
        [TRIAL_SURVEY_MISSED_FIELD]: 'う'.repeat(TRIAL_SURVEY_LIMITS.missed),
      },
    });
    expect(ok.status).toBe(303);
    expect((await rowOf(userId))?.stage).toBe('done');
  });

  it('ブラウザと AI の経験が空なら 400 で、入れた値を戻す（エスケープして）', async () => {
    const userId = await insertUser('empty');
    await mark(userId);
    const cookie = await cookieFor(userId);
    await advanceToSurvey(cookie);
    const response = await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: { [TRIAL_SURVEY_BROWSER_FIELD]: '', [TRIAL_SURVEY_AI_FIELD]: '<b>ない</b>' },
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('&lt;b&gt;ない&lt;/b&gt;');
    expect(body).not.toContain('<b>ない</b>');
    expect((await rowOf(userId))?.stage).toBe('survey');
  });

  it('検査は前後の空白を落としてから数える', () => {
    expect(validateTrialSurvey({ browser: '  a  ', aiExperience: ' b ', missed: ' ' })).toEqual({
      ok: true,
      answers: { browser: 'a', aiExperience: 'b', missed: '' },
    });
    expect(validateTrialSurvey({ browser: '   ', aiExperience: 'b', missed: '' })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('スマホでは「PC で開いてください」', () => {
  it('印のある人がスマホで開くと PC の案内が出て、押しても進まない', async () => {
    const userId = await insertUser('mobile');
    await mark(userId);
    const cookie = await cookieFor(userId);
    const page = await call(TRIAL_PATH, { cookie, ua: IPHONE_UA });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('PC で開いてください');
    expect(body).not.toContain('同意して始める');

    await call(TRIAL_STEP_API_PATH, {
      cookie,
      ua: IPHONE_UA,
      form: { [TRIAL_FROM_FIELD]: 'consent', [TRIAL_CONSENT_FIELD]: TRIAL_CONSENT_AGREE },
    });
    expect((await rowOf(userId))?.stage).toBe('consent');
  });

  it('印の無い人は、スマホでも 404（PC の案内で印の有無を漏らさない）', async () => {
    const userId = await insertUser('mobile-unmarked');
    expect((await call(TRIAL_PATH, { cookie: await cookieFor(userId), ua: IPHONE_UA })).status).toBe(404);
  });

  it('User-Agent の判定', () => {
    expect(isMobileUserAgent(IPHONE_UA)).toBe(true);
    expect(
      isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36'),
    ).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/129.0 Safari/537.36')).toBe(
      true,
    );
    expect(isMobileUserAgent(PC_UA)).toBe(false);
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe(
      false,
    );
    expect(isMobileUserAgent(null)).toBe(false);
  });
});

describe('管理画面の試用者の一覧', () => {
  /**
   * admin ホストへ GET する。
   *
   * @param cookie cookie
   * @returns レスポンス
   */
  async function openAdmin(cookie?: string): Promise<Response> {
    return await handleAdminRequest(
      new Request(`${ADMIN_ORIGIN}${ADMIN_TRIALS_PATH}`, { headers: cookie === undefined ? {} : { cookie } }),
      testEnv(),
    );
  }

  it('admin 以外（未ログイン・印のある試用者を含む）には 404', async () => {
    const participant = await insertUser('admin-404');
    await mark(participant);
    for (const cookie of [undefined, await cookieFor(participant)]) {
      const response = await openAdmin(cookie);
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('admin には、段の時刻（秒まで）・同意の版・答えがエスケープされて出る', async () => {
    const admin = await insertUser('admin');
    await env.DB.prepare('update users set is_admin = 1 where id = ?').bind(admin).run();
    const participant = await insertUser('<i>試用者</i>');
    await mark(participant);
    const cookie = await cookieFor(participant);
    clock = NOW + 7;
    await advanceToSurvey(cookie);
    await call(TRIAL_SURVEY_API_PATH, {
      cookie,
      form: {
        [TRIAL_SURVEY_BROWSER_FIELD]: 'Firefox',
        [TRIAL_SURVEY_AI_FIELD]: '<script>x</script>',
        [TRIAL_SURVEY_MISSED_FIELD]: '1 行目\n2 行目',
      },
    });

    const response = await openAdmin(await cookieFor(admin));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('&lt;i&gt;試用者&lt;/i&gt;');
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('1 行目<br>2 行目');
    expect(body).toContain(TRIAL_CONSENT_VERSION);
    expect(body).toContain(formatJstSeconds(NOW + 7));
    expect(body).toContain('aria-current="page"');
  });

  it('時刻は日本時間で秒まで', () => {
    // 2027-01-15 08:00:00 UTC = 17:00:00 JST。
    expect(formatJstSeconds(Date.UTC(2027, 0, 15, 8, 0, 5) / 1000)).toBe('2027-01-15 17:00:05');
  });
});

describe('90 日の後片付け', () => {
  const DAY = 24 * 60 * 60;

  it('同意から（同意していなければ印から）90 日を過ぎた行だけを消す', async () => {
    const oldConsented = await insertUser('old-consented');
    const freshConsented = await insertUser('fresh-consented');
    const oldMarkOnly = await insertUser('old-mark');
    const oldMarkFreshConsent = await insertUser('old-mark-fresh-consent');
    const cutoff = NOW - TRIAL_RETENTION_DAYS * DAY;
    await mark(oldConsented, cutoff - 100);
    await mark(freshConsented, cutoff - 100);
    await mark(oldMarkOnly, cutoff - 1);
    await mark(oldMarkFreshConsent, cutoff - 1000);
    const setConsent = async (userId: string, at: number): Promise<void> => {
      await env.DB.prepare(
        "update trial_participants set stage = 'recording', consented_at = ?, consent_version = 'v' where user_id = ?",
      )
        .bind(at, userId)
        .run();
    };
    await setConsent(oldConsented, cutoff - 1);
    await setConsent(freshConsented, cutoff);
    await setConsent(oldMarkFreshConsent, cutoff + 1);

    // **cron の入口から走らせる**（`workers/cleanup/src/index.ts` に配線したことを確かめる）。
    const fakeEnv = {
      DB: env.DB,
      WITHDRAWAL_HUB: {
        idFromName: (name: string): unknown => ({ name }),
        get: (): { wake: () => Promise<void> } => ({ wake: async (): Promise<void> => {} }),
      },
    } as unknown as CleanupEnv;
    await cleanupWorker.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW * 1000, noRetry: () => {} }, fakeEnv);

    expect(await rowOf(oldConsented)).toBeNull();
    expect(await rowOf(oldMarkOnly)).toBeNull();
    expect(await rowOf(freshConsented)).not.toBeNull();
    expect(await rowOf(oldMarkFreshConsent)).not.toBeNull();
    // 2 度目は何も消さない。
    expect(await sweepExpiredTrialRecords(env.DB, NOW)).toBe(0);
  });
});

describe('段の並び', () => {
  it('done の次は無く、ほかは 1 つ後ろへ進む', () => {
    const stages: readonly TrialStage[] = TRIAL_STAGES;
    for (const [index, stage] of stages.entries()) {
      expect(nextTrialStage(stage)).toBe(stages[index + 1] ?? null);
    }
  });
});
