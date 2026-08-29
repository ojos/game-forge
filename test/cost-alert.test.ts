import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COST_ALERT_MARKER_PREFIX,
  costAlertMarkerKey,
  costAlertMessage,
  notifyMonthlyCostWarning,
} from '../src/mail/cost-alert.js';
import type { CostAlertDeps } from '../src/mail/cost-alert.js';
import type { MailMessage, MailOutcome } from '../src/mail/resend.js';
import {
  MONTHLY_COST_LIMIT_JPY,
  MONTHLY_WARNING_RATIO,
  monthlyCostWarningOf,
} from '../src/quota.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { generatePageRoutes } from '../src/generate-page.js';
import { GENERATE_PAGE_PATH } from '../src/paths.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 費用 80% の警告を運用者へ送る（4.3 / #148）。
 *
 * issue の acceptance 3 件をここで押さえる。
 *
 * 1. 80% を超えると 1 通送られ、**その後の生成では送られない**
 * 2. 80% 未満では送られない
 * 3. **利用者の画面に 80% 警告が現れない**
 *
 * **実際にメールを送らない。** 送信そのものは差し替えた `send` で受け止め、
 * `fetcher` は「呼ばれたら落ちる」ものを渡す（本物の経路へ出ていないことの証拠）。
 */

/** 判定の基準時刻。2020-05-15 12:00 JST（= 03:00 UTC）。 */
const AT = Date.UTC(2020, 4, 15, 3) / 1000;

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-cost-alert-1';

/** 送信の設定が入った env（**本物の値ではない**）。 */
function configuredEnv(): Env {
  return {
    ...env,
    RESEND_API_KEY: 'test-api-key',
    MAIL_FROM: 'Game Forge <no-reply@example.com>',
    OPERATOR_EMAIL: 'ops@example.com',
    SESSION_SECRET: SECRET,
  };
}

/** 送信の設定が無い env。 */
function unconfiguredEnv(): Env {
  return { ...env, RESEND_API_KEY: '', MAIL_FROM: '', OPERATOR_EMAIL: '' };
}

/**
 * 送信を受け止める依存。
 *
 * @param outcomes 呼び出しの回数ぶんの結果（足りなければ最後の値を使う）
 * @returns 送られた内容と、差し替えた依存
 */
function fakeSender(...outcomes: MailOutcome[]): {
  sent: MailMessage[];
  deps: CostAlertDeps;
} {
  const sent: MailMessage[] = [];
  return {
    sent,
    deps: {
      // **呼ばれたら落ちる。** 本物の HTTP 経路へ出ていないことをここで担保する。
      fetcher: () => {
        throw new Error('テストからネットワークへ出ました');
      },
      send: async (_env, message) => {
        sent.push(message);
        return outcomes[Math.min(sent.length - 1, outcomes.length - 1)] ?? { sent: true };
      },
    },
  };
}

/**
 * 利用者を 1 人用意する（`generations.user_id` は `users` を参照する）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `cost-alert-user-${suffix}`;
  await env.DB.prepare(
    'insert or ignore into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 台帳へ行を直接置く（`test/quota.test.ts` と同じ理由。金額を作るため）。
 *
 * @param userId 利用者の id
 * @param at 記録時刻（UNIX 秒）
 * @param costJpy 円換算の費用
 */
async function seedLedgerRow(userId: string, at: number, costJpy: number): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, ?, 1, ?)`,
  )
    .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, costJpy, at)
    .run();
}

/**
 * 目印が置かれているか。
 *
 * @param at 基準時刻（UNIX 秒）
 * @returns 置かれていれば true
 */
async function markerExists(at: number): Promise<boolean> {
  return (await env.BUCKET.head(costAlertMarkerKey(at))) !== null;
}

beforeAll(async () => {
  await applySchema();
});

afterEach(async () => {
  // 月次はサービス全体の累計なので、行が残ると次のテストの判定に効く
  // （`test/quota.test.ts` と同じ後片付け）。**このファイルが作った行だけを消す。**
  await env.DB.prepare("delete from generations where user_id like 'cost-alert-user-%'").run();
  const listed = await env.BUCKET.list({ prefix: COST_ALERT_MARKER_PREFIX });
  for (const object of listed.objects) {
    await env.BUCKET.delete(object.key);
  }
});

describe('80% 未満では送らない', () => {
  it('しきい値の 1 円手前では送らず、目印も置かない', async () => {
    const userId = await seedUser('below');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO - 1);

    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('below-threshold');
    expect(sent).toHaveLength(0);
    expect(await markerExists(AT)).toBe(false);
  });

  it('台帳が空でも送らない', async () => {
    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('below-threshold');
    expect(sent).toHaveLength(0);
  });

  it('前月の費用は当月の判定に入らない（月の境界は JST）', async () => {
    const userId = await seedUser('prev-month');
    // 5 月 1 日 0 時 JST の 1 秒前＝ 4 月分。
    const lastMonth = Date.UTC(2020, 3, 30, 15) / 1000 - 1;
    await seedLedgerRow(userId, lastMonth, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('below-threshold');
    expect(sent).toHaveLength(0);
  });
});

describe('80% を超えたら 1 通だけ送る', () => {
  it('1 通目は送られ、その後の生成では送られない', async () => {
    const userId = await seedUser('once');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY * MONTHLY_WARNING_RATIO);

    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('sent');
    expect(await markerExists(AT)).toBe(true);

    // **超えている間は生成のたびにここへ入る。** 2 回目以降が送られないことが要件である。
    await seedLedgerRow(userId, AT + 60, 20);
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT + 60, deps)).toBe('already-sent');
    await seedLedgerRow(userId, AT + 120, 20);
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT + 120, deps)).toBe('already-sent');

    expect(sent).toHaveLength(1);
  });

  it('宛先は設定から取る（コードに書かない）', async () => {
    const userId = await seedUser('to');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    await notifyMonthlyCostWarning(configuredEnv(), AT, deps);
    expect(sent[0]!.to).toBe('ops@example.com');
  });

  it('月が変われば、その月の 1 通目として送られる', async () => {
    const userId = await seedUser('next-month');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('sent');

    // 6 月へ入り、その月にも 80% を超える費用が積まれた状態。
    const june = Date.UTC(2020, 5, 15, 3) / 1000;
    await seedLedgerRow(userId, june, MONTHLY_COST_LIMIT_JPY);
    expect(await notifyMonthlyCostWarning(configuredEnv(), june, deps)).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('目印の鍵は JST の暦月で切れる', () => {
    // 2020-06-01 00:00 JST（= 05-31 15:00 UTC）。その 1 秒前はまだ 5 月である。
    const juneStart = Date.UTC(2020, 4, 31, 15) / 1000;
    expect(costAlertMarkerKey(juneStart - 1)).toBe(`${COST_ALERT_MARKER_PREFIX}2020-05`);
    expect(costAlertMarkerKey(juneStart)).toBe(`${COST_ALERT_MARKER_PREFIX}2020-06`);
  });
});

describe('送信に失敗したとき', () => {
  it('受け付けられなかった（unreachable）なら目印を戻し、次の生成で送り直す', async () => {
    const userId = await seedUser('unreachable');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender({ sent: false, reason: 'unreachable' }, { sent: true });
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('send-failed');
    expect(await markerExists(AT)).toBe(false);

    expect(await notifyMonthlyCostWarning(configuredEnv(), AT + 60, deps)).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('拒否（rejected）なら目印を戻さない（同じ内容で叩き続けない）', async () => {
    const userId = await seedUser('rejected');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender({ sent: false, reason: 'rejected' });
    expect(await notifyMonthlyCostWarning(configuredEnv(), AT, deps)).toBe('send-failed');
    expect(await markerExists(AT)).toBe(true);

    expect(await notifyMonthlyCostWarning(configuredEnv(), AT + 60, deps)).toBe('already-sent');
    expect(sent).toHaveLength(1);
  });
});

describe('設定が無い環境では何もしない', () => {
  it('宛先も鍵も無ければ、台帳も R2 も触らずに降りる', async () => {
    const userId = await seedUser('unconfigured');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    expect(await notifyMonthlyCostWarning(unconfiguredEnv(), AT, deps)).toBe('not-configured');
    expect(sent).toHaveLength(0);
    expect(await markerExists(AT)).toBe(false);
  });

  it('宛先だけが無くても送らない', async () => {
    const userId = await seedUser('no-operator');
    await seedLedgerRow(userId, AT, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    const noOperator = { ...configuredEnv(), OPERATOR_EMAIL: '' } as Env;
    expect(await notifyMonthlyCostWarning(noOperator, AT, deps)).toBe('not-configured');
    expect(sent).toHaveLength(0);
  });
});

describe('本文', () => {
  it('対象月・累計・上限・到達率を載せ、利用者を特定する値を載せない', () => {
    const warning = monthlyCostWarningOf(8_500)!;
    const message = costAlertMessage(warning, AT);

    expect(message.subject).toContain('80%');
    expect(message.text).toContain('2020-05');
    expect(message.text).toContain('8,500 円');
    expect(message.text).toContain('10,000 円');
    expect(message.text).toContain('85.0%');
    // 宛先も利用者 id も本文に無い（`src/mail/cost-alert.ts` の方針）。
    expect(message.text).not.toContain('@');
    expect(message.text).not.toContain('cost-alert-user');
  });

  it('件名にも本文にもしきい値の綴りが 1 か所から来る', () => {
    const warning = monthlyCostWarningOf(MONTHLY_COST_LIMIT_JPY)!;
    const message = costAlertMessage(warning, AT);
    const threshold = `${Math.round(MONTHLY_WARNING_RATIO * 100)}%`;
    expect(message.subject).toContain(threshold);
    expect(message.text).toContain(threshold);
  });
});

describe('利用者の画面に 80% 警告が現れない（#148 の決定）', () => {
  it('80% を超えた状態で生成画面を開いても、費用の情報が出ない', async () => {
    const userId = await seedUser('page');
    const now = Math.floor(Date.now() / 1000);
    // **いまの月**へ積む。画面は現在時刻で判定するため。
    await seedLedgerRow(userId, now, 8_500);

    const issuedAt = now;
    const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;
    const response = await dispatch(
      generatePageRoutes,
      new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, { headers: { cookie } }),
      configuredEnv(),
    );
    const body = await response.text();

    // 画面が枠の状態を実際に描いていること（検査が空でないことの証拠）。
    expect(response.status).toBe(200);
    expect(body).toContain('本日の残り生成枠');
    // **費用に触れる表示が 1 つも無いこと。**
    expect(body).not.toContain('8,500');
    expect(body).not.toContain('8500');
    expect(body).not.toContain('80%');
    expect(body).not.toContain('警告');
    expect(body).not.toContain('円');
  });
});
