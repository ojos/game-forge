import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { notifyGenerationFinished, workPageUrl } from '../src/mail/generation-notice.js';
import type { GenerationNoticeDeps } from '../src/mail/generation-notice.js';
import type { MailMessage, MailOutcome } from '../src/mail/resend.js';
import { createPendingGame } from '../src/games.js';
import { DAILY_QUOTA_PER_USER, MONTHLY_COST_LIMIT_JPY } from '../src/quota.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import { failureMessageOf } from '../src/generation-failure.js';
import { workPagePath } from '../src/paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 生成の完了を作者へ知らせる（#153）。
 *
 * issue の acceptance のうち、ローカルで機械判定できるものをここで押さえる。
 *
 * - 完了すると作者へ 1 通送られ、**そのリンクから作品へ辿り着ける**
 * - 失敗したときも送り、**枠が消えたのかを利用者が知りようがない文面にしない**
 * - **`/api/generate` を呼ばずに検証できる**（1 回 16 円）
 *
 * **実際にメールを送らない**（`test/cost-alert.test.ts` と同じ形で、`fetcher` は
 * 呼ばれたら落ちるものを渡す）。
 */

/** 送信の設定が入った env（**本物の値ではない**）。 */
function configuredEnv(): Env {
  return {
    ...env,
    RESEND_API_KEY: 'test-api-key',
    MAIL_FROM: 'Game Forge <no-reply@example.com>',
    OPERATOR_EMAIL: 'ops@example.com',
  };
}

/**
 * 送信を受け止める依存。
 *
 * @param outcome 送信の結果
 * @returns 送られた内容と、差し替えた依存
 */
function fakeSender(outcome: MailOutcome = { sent: true }): {
  sent: MailMessage[];
  deps: GenerationNoticeDeps;
} {
  const sent: MailMessage[] = [];
  return {
    sent,
    deps: {
      fetcher: () => {
        throw new Error('テストからネットワークへ出ました');
      },
      send: async (_env, message) => {
        sent.push(message);
        return outcome;
      },
    },
  };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id とメールアドレス
 */
async function seedUser(suffix: string): Promise<{ id: string; email: string }> {
  const id = `notice-user-${suffix}`;
  const email = `${id}@example.com`;
  await env.DB.prepare(
    'insert or ignore into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, email, suffix)
    .run();
  return { id, email };
}

/**
 * 生成中の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param prompt お題
 * @returns 作者と作品 id
 */
async function seedGame(
  suffix: string,
  prompt = 'よけるゲーム',
): Promise<{ userId: string; email: string; gameId: string }> {
  const user = await seedUser(suffix);
  const pending = await createPendingGame(env, user.id, { prompt });
  return { userId: user.id, email: user.email, gameId: pending.id };
}

/**
 * 台帳へ行を直接置く（`test/quota.test.ts` と同じ理由）。
 *
 * @param userId 利用者の id
 * @param at 記録時刻（UNIX 秒）
 * @param costJpy 円換算の費用
 */
async function seedLedgerRow(userId: string, at: number, costJpy = 0): Promise<void> {
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

beforeAll(async () => {
  await applySchema();
});

afterEach(async () => {
  // 月次はサービス全体の累計なので、行が残ると他のテストの判定に効く。
  await env.DB.prepare("delete from generations where user_id like 'notice-user-%'").run();
  await env.DB.prepare("delete from games where author_id like 'notice-user-%'").run();
});

describe('完成したとき', () => {
  it('作者本人へ 1 通送り、作品ページの URL を載せる', async () => {
    const { gameId, email } = await seedGame('ready');
    const { sent, deps } = fakeSender();

    expect(await notifyGenerationFinished(configuredEnv(), gameId, { kind: 'ready' }, deps)).toBe(
      'sent',
    );
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    // **宛先は D1 の users.email である**（設定でもコードでもない）。
    expect(message.to).toBe(email);
    expect(message.text).toContain(`https://${env.APP_HOST}${workPagePath(gameId)}`);
    // お題（仮タイトル）で、どの生成の結果かが分かる。
    expect(message.text).toContain('よけるゲーム');
  });

  it('リンクの綴りは work-page の正本から組み立てる', async () => {
    const { gameId } = await seedGame('url');
    expect(workPageUrl(env, gameId)).toBe(`https://${env.APP_HOST}${workPagePath(gameId)}`);
  });
});

describe('失敗したとき', () => {
  it('送る。そして枠がどうなったかを本文で答える', async () => {
    const { gameId, userId } = await seedGame('failed');
    const now = Math.floor(Date.now() / 1000);
    await seedLedgerRow(userId, now);
    await seedLedgerRow(userId, now);
    await seedLedgerRow(userId, now);

    const { sent, deps } = fakeSender();
    expect(
      await notifyGenerationFinished(
        configuredEnv(),
        gameId,
        { kind: 'failed', errorCode: 'build-failed' },
        deps,
      ),
    ).toBe('sent');

    const message = sent[0]!;
    // 失敗の説明は作品ページと同じ正本から取る（説明を 2 つ作らない）。
    expect(message.text).toContain(failureMessageOf('build-failed'));
    // **「失敗しました」だけで終わらせない**（確定25。枠は台帳の行数で数える）。
    expect(message.text).toContain('生成枠は消費されます');
    expect(message.text).toContain(`本日の残りの生成枠は ${DAILY_QUOTA_PER_USER - 3} 回です。`);
    expect(message.text).toContain(`https://${env.APP_HOST}${workPagePath(gameId)}`);
  });

  it('本日の枠を使い切っていれば、その旨を書く', async () => {
    const { gameId, userId } = await seedGame('failed-exhausted');
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(userId, now);
    }

    const { sent, deps } = fakeSender();
    await notifyGenerationFinished(
      configuredEnv(),
      gameId,
      { kind: 'failed', errorCode: 'internal' },
      deps,
    );
    expect(sent[0]!.text).toContain('本日の生成枠は残っていません');
    expect(sent[0]!.text).not.toContain('本日の残りの生成枠は');
  });

  it('月次上限に達していれば、プレイと共有が続くことを書く', async () => {
    const { gameId, userId } = await seedGame('failed-monthly');
    const now = Math.floor(Date.now() / 1000);
    await seedLedgerRow(userId, now, MONTHLY_COST_LIMIT_JPY);

    const { sent, deps } = fakeSender();
    await notifyGenerationFinished(
      configuredEnv(),
      gameId,
      { kind: 'failed', errorCode: 'internal' },
      deps,
    );
    expect(sent[0]!.text).toContain('今月の生成枠が上限に達しています');
    expect(sent[0]!.text).toContain('プレイと共有は引き続きご利用いただけます');
  });

  it('知らない分類名でも、既定の説明で送る', async () => {
    const { gameId } = await seedGame('failed-unknown');
    const { sent, deps } = fakeSender();
    await notifyGenerationFinished(
      configuredEnv(),
      gameId,
      { kind: 'failed', errorCode: 'not-a-known-code' },
      deps,
    );
    expect(sent[0]!.text).toContain(failureMessageOf('not-a-known-code'));
  });
});

/**
 * 台帳の集計だけが落ちる D1。
 *
 * **宛先の解決（`games` と `users` の結合）は通す。** 通らないと外側の catch へ落ち、
 * 見たい「枠の状態だけが読めなかった」経路にならない。
 *
 * @returns 差し替えた D1
 */
function dbFailingOnLedger(): D1Database {
  const real = env.DB;
  return {
    prepare: (sql: string) => {
      if (sql.includes('from generations')) {
        return {
          bind: () => ({
            first: async () => {
              throw new Error('D1 down');
            },
          }),
        } as unknown as D1PreparedStatement;
      }
      return real.prepare(sql);
    },
  } as unknown as D1Database;
}

describe('送れないとき', () => {
  it('作品が引けなければ送らず、例外にもしない', async () => {
    const { sent, deps } = fakeSender();
    expect(
      await notifyGenerationFinished(configuredEnv(), crypto.randomUUID(), { kind: 'ready' }, deps),
    ).toBe('no-recipient');
    expect(sent).toHaveLength(0);
  });

  it('宛先を引けなかったログに作品 id が残る（PR #170）', async () => {
    // 固定のラベルだけだと、どの作品で宛先の解決に失敗したのかを追えない。
    // **id は誰かを指す値ではない**ので、ログへ出してよい。
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gameId = crypto.randomUUID();
    try {
      await notifyGenerationFinished(configuredEnv(), gameId, { kind: 'ready' }, fakeSender().deps);
      expect(logged.mock.calls.flat().join(' ')).toContain(gameId);
    } finally {
      logged.mockRestore();
    }
  });

  it('設定が無ければ D1 を触らずに降りる', async () => {
    const { gameId } = await seedGame('unconfigured');
    const { sent, deps } = fakeSender();
    const blank = { ...env, RESEND_API_KEY: '', MAIL_FROM: '' } as Env;
    expect(await notifyGenerationFinished(blank, gameId, { kind: 'ready' }, deps)).toBe(
      'not-configured',
    );
    expect(sent).toHaveLength(0);
  });

  it('枠の集計が読めなかったら、その一文を落として送り、ログを残す（PR #170）', async () => {
    // **黙って落とさない。** 文面から 1 文が消えるだけだと、D1 の集計障害が静かに進む。
    const { gameId } = await seedGame('quota-unreadable');
    const { sent, deps } = fakeSender();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = { ...configuredEnv(), DB: dbFailingOnLedger() } as Env;
      expect(
        await notifyGenerationFinished(
          broken,
          gameId,
          { kind: 'failed', errorCode: 'internal' },
          deps,
        ),
      ).toBe('sent');
      // 枠の一文は落ちるが、**推測で書かない**（「残り 0 回」とも「まだ使えます」とも言わない）。
      expect(sent[0]!.text).not.toContain('本日の残りの生成枠は');
      expect(sent[0]!.text).not.toContain('本日の生成枠は残っていません');
      expect(sent[0]!.text).toContain('生成枠は消費されます');
      // 例外の種類だけがログに出る（利用者 id も本文も出さない）。
      const output = logged.mock.calls.flat().join(' ');
      expect(output).toContain('枠の状態を読めませんでした');
      expect(output).toContain('Error');
      expect(output).not.toContain('notice-user-quota-unreadable');
    } finally {
      logged.mockRestore();
    }
  });

  it('送信が失敗しても投げ返さない', async () => {
    const { gameId } = await seedGame('send-failed');
    const { deps } = fakeSender({ sent: false, reason: 'unreachable' });
    expect(await notifyGenerationFinished(configuredEnv(), gameId, { kind: 'ready' }, deps)).toBe(
      'send-failed',
    );
  });
});
