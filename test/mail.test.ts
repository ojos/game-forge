import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  MAIL_SECRET_NAMES,
  MAIL_TIMEOUT_MS,
  formatJpy,
  isMailAddress,
  mailConfigOf,
  sendMail,
} from '../src/mail/resend.js';

/**
 * メール送信の土台（確定14 / #148 / #153）。
 *
 * **実際にメールを送らない。** 送信は本番の外部サービスへの操作であり、検証の手段に
 * しない。この検査はすべて**送信の手前**で止める——`fetcher` を差し替えて、
 * どんな要求が組み立てられたかだけを見る。
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

/** 送信の設定が無い env（ローカル・テストの既定の状態）。 */
function unconfiguredEnv(): Env {
  return { ...env, RESEND_API_KEY: '', MAIL_FROM: '', OPERATOR_EMAIL: '' };
}

/** 呼ばれた要求を記録する `fetcher`。 */
function recording(status = 200): {
  requests: Request[];
  fetcher: (request: Request) => Promise<Response>;
} {
  const requests: Request[] = [];
  return {
    requests,
    fetcher: async (request) => {
      requests.push(request);
      return new Response('{}', { status });
    },
  };
}

describe('テストからは本物の送信が起きない', () => {
  it('テスト環境にメール送信の設定が無い', () => {
    // **検知層である。** `.dev.vars` に本物の Resend の鍵を置いたまま `npm test` を
    // 回すと、コールバックの検査（`test/orchestrator.test.ts` など既定の通知を通す
    // 経路）から**本番のメールが出る。** 送信は外部サービスへの操作なので、
    // 「気をつける」ではなく落ちる検査で塞ぐ（shared-ai-rules 12 章）。
    //
    // ここが落ちた場合は `.dev.vars` の RESEND_API_KEY / MAIL_FROM を空にすること
    // （`.dev.vars.example` にも同じことが書いてある）。
    expect(mailConfigOf(env)).toBeNull();
  });

  it('秘密の名前が .dev.vars.example に宣言されている', () => {
    // 一覧の複製を機械照合する（shared-ai-rules 12 章）。雛形から鍵を落とすと落ちる。
    const documented = env.TEST_DEV_VARS_EXAMPLE.split('\n')
      .map((line) => /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line))
      .filter((matched): matched is RegExpExecArray => matched !== null)
      .map((matched) => matched[1]!);
    for (const name of MAIL_SECRET_NAMES) {
      expect(documented).toContain(name);
    }
    // 宛先（#148）も設定として持つ。**コードにも仕様書にも書かない。**
    expect(documented).toContain('OPERATOR_EMAIL');
  });
});

describe('設定が無ければネットワークへ出ない', () => {
  it('鍵と差出人が空なら not-configured を返し、要求を組み立てない', async () => {
    const { requests, fetcher } = recording();
    const outcome = await sendMail(
      unconfiguredEnv(),
      { to: 'someone@example.com', subject: '件名', text: '本文' },
      'test',
      { fetcher },
    );
    expect(outcome).toEqual({ sent: false, reason: 'not-configured' });
    expect(requests).toHaveLength(0);
  });

  it('差出人だけが設定されていても送らない', async () => {
    const { requests, fetcher } = recording();
    const half = { ...env, RESEND_API_KEY: '', MAIL_FROM: 'a@example.com' } as Env;
    const outcome = await sendMail(half, { to: 'b@example.com', subject: 'x', text: 'y' }, 'test', {
      fetcher,
    });
    expect(outcome).toEqual({ sent: false, reason: 'not-configured' });
    expect(requests).toHaveLength(0);
  });
});

describe('綴りが契約を満たさない値は送らない', () => {
  it.each([
    ['宛先がアドレスの形でない', 'not-an-address'],
    ['宛先に区切り文字が混ざる', 'a@example.com, b@example.com'],
    ['宛先に表示名が付いている', 'Name <a@example.com>'],
    ['宛先に改行が混ざる', 'a@example.com\nbcc: c@example.com'],
  ])('%s', async (_label, to) => {
    const { requests, fetcher } = recording();
    const outcome = await sendMail(configuredEnv(), { to, subject: '件名', text: '本文' }, 'test', {
      fetcher,
    });
    expect(outcome).toEqual({ sent: false, reason: 'invalid-message' });
    expect(requests).toHaveLength(0);
  });

  it('件名に改行が混ざると送らない', async () => {
    const { requests, fetcher } = recording();
    const outcome = await sendMail(
      configuredEnv(),
      { to: 'a@example.com', subject: '件名\r\nbcc: c@example.com', text: '本文' },
      'test',
      { fetcher },
    );
    expect(outcome).toEqual({ sent: false, reason: 'invalid-message' });
    expect(requests).toHaveLength(0);
  });
});

describe('宛先の綴りの判定は 1 か所にある（PR #169）', () => {
  it.each([
    ['ops@example.com', true],
    ['a.b+tag@sub.example.co.jp', true],
    ['Ops <ops@example.com>', false],
    ['a@example.com, b@example.com', false],
    ['ops@example.com\nbcc: c@example.com', false],
    ['operator', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isMailAddress(value)).toBe(expected);
  });

  it('送信の手前の検査も同じ判定を使う（綴りの正本を 2 つ作らない）', async () => {
    // 設定から来る宛先は目印を取る前に検査される（`src/mail/cost-alert.ts`）。
    // その検査と、送信直前の検査が食い違うと、片方だけ通る宛先が生まれる。
    for (const value of ['ops@example.com', 'Ops <ops@example.com>', 'operator']) {
      const { requests, fetcher } = recording();
      const outcome = await sendMail(
        configuredEnv(),
        { to: value, subject: '件名', text: '本文' },
        'test',
        { fetcher },
      );
      expect(outcome.sent).toBe(isMailAddress(value));
      expect(requests).toHaveLength(isMailAddress(value) ? 1 : 0);
    }
  });
});

describe('送信の要求の形', () => {
  it('Resend の HTTP API へ、鍵・差出人・宛先・本文を載せて 1 回だけ投げる', async () => {
    const { requests, fetcher } = recording();
    const outcome = await sendMail(
      configuredEnv(),
      { to: 'author@example.com', subject: '件名', text: '本文' },
      'test',
      { fetcher },
    );

    expect(outcome).toEqual({ sent: true });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.headers.get('authorization')).toBe('Bearer test-api-key');
    expect(await request.json()).toEqual({
      from: 'Game Forge <no-reply@example.com>',
      to: ['author@example.com'],
      subject: '件名',
      text: '本文',
    });
  });

  it('応答を待ち続けない（打ち切りの合図が付く）', async () => {
    const { requests, fetcher } = recording();
    await sendMail(configuredEnv(), { to: 'a@example.com', subject: 's', text: 't' }, 'test', {
      fetcher,
    });
    // 値そのものは検査しない（時間の経過に依存する）。**合図が付いていること**が要件で、
    // 付いていなければ Resend の無応答がそのままコールバックの応答時間になる。
    expect(requests[0]!.signal).not.toBeNull();
    expect(MAIL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('失敗は「受け付けられたか」で分ける', () => {
  it.each([
    [400, 'rejected'],
    [401, 'rejected'],
    [422, 'rejected'],
    [429, 'unreachable'],
    [500, 'unreachable'],
    [503, 'unreachable'],
  ])('HTTP %i は %s', async (status, reason) => {
    const { fetcher } = recording(status);
    const outcome = await sendMail(
      configuredEnv(),
      { to: 'a@example.com', subject: 's', text: 't' },
      'test',
      { fetcher },
    );
    expect(outcome).toEqual({ sent: false, reason });
  });

  it('例外は unreachable として扱い、投げ返さない', async () => {
    const outcome = await sendMail(
      configuredEnv(),
      { to: 'a@example.com', subject: 's', text: 't' },
      'test',
      {
        fetcher: () => {
          throw new Error('network down');
        },
      },
    );
    expect(outcome).toEqual({ sent: false, reason: 'unreachable' });
  });
});

describe('円の表示', () => {
  it.each([
    [0, '0'],
    [999.4, '999'],
    [1000, '1,000'],
    [8123.456, '8,123'],
    [10_000, '10,000'],
  ])('%d 円は %s と書く', (value, expected) => {
    expect(formatJpy(value)).toBe(expected);
  });
});
