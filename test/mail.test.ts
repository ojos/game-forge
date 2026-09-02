import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAIL_SECRET_NAMES,
  MAIL_TIMEOUT_MS,
  formatJpy,
  isMailAddress,
  mailConfigOf,
  sendMail,
} from '../src/mail/resend.js';
import { forkNoticeMessage, notifyForkPublished } from '../src/mail/fork-notice.js';
import { applySchema } from './helpers/schema.js';

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

/**
 * 改造の通知（5.5 / 2.2-6 / #36 / M5-5）。
 *
 * **ここも実際のメールを送らない。** `fetcher` を差し替えて、どんな要求が
 * 組み立てられたかだけを見る（このファイルの冒頭と同じ方針）。
 */

/** 送信の設定が入った env に、テスト用の D1 をそのまま束ねたもの。 */
function forkNoticeEnv(): Env {
  return { ...configuredEnv(), APP_HOST: env.APP_HOST } as Env;
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param displayName 表示名（既定は接尾辞そのもの）
 * @returns 利用者の id
 */
async function seedNoticeUser(suffix: string, displayName = suffix): Promise<string> {
  const id = `fn-user-${suffix}`;
  await env.DB.prepare(
    `insert or replace into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 1)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 作品を 1 件用意する。
 *
 * **`games.ts` の生成経路を通さない。** ここで確かめたいのは通知の判定であって、
 * 生成の経路ではない（通すと、フォークを 1 件作るのに 4 回の書き込みが要る）。
 *
 * @param id 作品 id
 * @param authorId 作者
 * @param parentId 親（オリジナルなら null）
 * @param title 仮タイトル
 */
async function seedNoticeGame(
  id: string,
  authorId: string,
  parentId: string | null,
  title = 'ねこのゲーム',
): Promise<void> {
  await env.DB.prepare(
    `insert or replace into games (id, author_id, parent_id, status, title, go_version, created_at, published_at)
     values (?, ?, ?, 'published', ?, 'go1.25.0', 1, 2)`,
  )
    .bind(id, authorId, parentId, title)
    .run();
}

/**
 * `fork_notices` の 1 行を読む。
 *
 * @param gameId 子作品の id
 * @returns 行。無ければ null
 */
async function readForkNotice(
  gameId: string,
): Promise<{ claimed_at: number; outcome: string } | null> {
  return await env.DB.prepare('select claimed_at, outcome from fork_notices where game_id = ?')
    .bind(gameId)
    .first<{ claimed_at: number; outcome: string }>();
}

describe('改造通知の本文（#36 acceptance 3）', () => {
  it('改造者名と子作品の URL が入る', () => {
    const message = forkNoticeMessage('カニ', 'ねこのゲーム', 'https://app.example/works/abc');
    expect(message.text).toContain('カニ');
    expect(message.text).toContain('https://app.example/works/abc');
    expect(message.text).toContain('ねこのゲーム');
    // 件名は固定文（UGC を入れると、改行 1 つで通知そのものが消える）。
    expect(message.subject).toBe('[Game Forge] あなたの作品が改造されました');
  });

  it('表示名の改行では本文の行を偽造できない', () => {
    // 表示名は UGC（Google 由来）である。改行を通せば「改造された作品: …」を装う
    // **行**を本文へ足せる（`src/mail/resend.ts` の改行の検査は件名と差出人しか
    // 見ない）。**文字列として現れること自体は止められない**——止まるのは
    // 「行になること」で、確かめるのもそこである。
    const forged = 'https://evil.example/';
    const honest = forkNoticeMessage('カニ', 'T', 'https://app.example/works/abc');
    const attacked = forkNoticeMessage(
      `カニ\n改造された作品: ${forged}`,
      'T',
      'https://app.example/works/abc',
    );

    // 行数が増えていない（＝行が 1 本も足されていない）。
    expect(attacked.text.split('\n')).toHaveLength(honest.text.split('\n').length);
    // 「改造された作品: 」で始まる行はちょうど 1 本で、その中身は本物の URL である。
    const lines = attacked.text.split('\n').filter((line) => line.startsWith('改造された作品: '));
    expect(lines).toEqual(['改造された作品: https://app.example/works/abc']);
    // 偽の URL は 1 行目（名前の行）の中に押し込められている。
    expect(attacked.text.split('\n')[0]).toContain(forged);
  });

  it('長すぎる表示名は切る', () => {
    const message = forkNoticeMessage('あ'.repeat(200), 'T', 'https://app.example/works/abc');
    const first = message.text.split('\n')[0]!;
    // 切ったことが読み手に分かる形で切る（省略記号が付く）。
    expect(first).toContain('…');
    expect(first).not.toContain('あ'.repeat(61));
    // 200 文字の名前をそのまま載せない。
    expect(first.length).toBeLessThan(100);
  });
});

describe('改造通知の宛先と送らない条件（#36 acceptance 2）', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('親の作者へ送り、本文に機密を入れない', async () => {
    const parentAuthor = await seedNoticeUser('parent', '元の人');
    const forkAuthor = await seedNoticeUser('forker', 'カニ');
    await seedNoticeGame('fn-parent', parentAuthor, null, 'ねこのゲーム');
    await seedNoticeGame('fn-child', forkAuthor, 'fn-parent', '火の玉を投げる');

    const { requests, fetcher } = recording();
    const outcome = await notifyForkPublished(
      forkNoticeEnv(),
      'fn-child',
      { fetcher, send: sendMail },
      1234,
    );

    expect(outcome).toBe('sent');
    expect(requests).toHaveLength(1);
    const body = (await requests[0]!.json()) as { to: string[]; subject: string; text: string };
    // 宛先は親の作者（**設定にもコードにも書かない。D1 が知っている**）。
    expect(body.to).toEqual([`${parentAuthor}@example.com`]);
    expect(body.text).toContain('カニ');
    expect(body.text).toContain('/works/fn-child');

    // **機密を載せない**（#36 acceptance 3）。改造した人のアドレス、鍵、
    // 子作品の内側の値はどれも出さない。
    for (const secret of [
      `${forkAuthor}@example.com`,
      'test-api-key',
      parentAuthor,
      forkAuthor,
    ]) {
      expect(body.text, secret).not.toContain(secret);
    }
    expect(await readForkNotice('fn-child')).toEqual({ claimed_at: 1234, outcome: 'sent' });
  });

  it('自分自身のフォークでは送らず、記録も残さない', async () => {
    // #36 の受け入れ条件。**作者は自分の公開作品をフォークできる**（5.3 は他人の
    // 作品に限っていない）。
    const author = await seedNoticeUser('self', 'ひとり');
    await seedNoticeGame('fn-self-parent', author, null);
    await seedNoticeGame('fn-self-child', author, 'fn-self-parent');

    const { requests, fetcher } = recording();
    const outcome = await notifyForkPublished(forkNoticeEnv(), 'fn-self-child', {
      fetcher,
      send: sendMail,
    });

    expect(outcome).toBe('self-fork');
    expect(requests).toHaveLength(0);
    // **握らない。** 握ると、あとから「未送信の行」を数える運用が読み違える。
    expect(await readForkNotice('fn-self-child')).toBeNull();
  });

  it('親を持たない作品では送らない（新規生成・推敲）', async () => {
    const author = await seedNoticeUser('orphan');
    await seedNoticeGame('fn-orphan', author, null);

    const { requests, fetcher } = recording();
    expect(
      await notifyForkPublished(forkNoticeEnv(), 'fn-orphan', { fetcher, send: sendMail }),
    ).toBe('not-a-fork');
    expect(requests).toHaveLength(0);
  });

  it('送信の設定が無ければ D1 も触らない', async () => {
    const parentAuthor = await seedNoticeUser('unconf-parent');
    const forkAuthor = await seedNoticeUser('unconf-forker');
    await seedNoticeGame('fn-unconf-parent', parentAuthor, null);
    await seedNoticeGame('fn-unconf-child', forkAuthor, 'fn-unconf-parent');

    const { requests, fetcher } = recording();
    expect(
      await notifyForkPublished(unconfiguredEnv(), 'fn-unconf-child', { fetcher, send: sendMail }),
    ).toBe('not-configured');
    expect(requests).toHaveLength(0);
    // **握りもしない。** 設定を入れた日に `already-sent` で黙ることになる。
    expect(await readForkNotice('fn-unconf-child')).toBeNull();
  });

  it('宛先の綴りが壊れていたら、握る前に落とす', async () => {
    const parentAuthor = await seedNoticeUser('broken-parent');
    await env.DB.prepare('update users set email = ? where id = ?')
      .bind('not-an-address', parentAuthor)
      .run();
    const forkAuthor = await seedNoticeUser('broken-forker');
    await seedNoticeGame('fn-broken-parent', parentAuthor, null);
    await seedNoticeGame('fn-broken-child', forkAuthor, 'fn-broken-parent');

    const { requests, fetcher } = recording();
    expect(
      await notifyForkPublished(forkNoticeEnv(), 'fn-broken-child', { fetcher, send: sendMail }),
    ).toBe('no-recipient');
    expect(requests).toHaveLength(0);
    // **握っていない。** 握ると、設定を直しても二度と送られない
    // （`src/mail/cost-alert.ts` が「目印より前」に綴りを見るのと同じ理由）。
    expect(await readForkNotice('fn-broken-child')).toBeNull();
  });
});

describe('1 フォークにつき 1 通（#36 acceptance 1）', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('同じフォークを 2 回通知しても 1 通しか出ない', async () => {
    const parentAuthor = await seedNoticeUser('twice-parent');
    const forkAuthor = await seedNoticeUser('twice-forker');
    await seedNoticeGame('fn-twice-parent', parentAuthor, null);
    await seedNoticeGame('fn-twice-child', forkAuthor, 'fn-twice-parent');

    const { requests, fetcher } = recording();
    const deps = { fetcher, send: sendMail };
    expect(await notifyForkPublished(forkNoticeEnv(), 'fn-twice-child', deps)).toBe('sent');
    expect(await notifyForkPublished(forkNoticeEnv(), 'fn-twice-child', deps)).toBe('already-sent');
    expect(requests).toHaveLength(1);
  });

  it('同時に 2 本走っても 1 通しか出ない（握ってから送る）', async () => {
    // **「引いて、無ければ送る」ではこれが通らない。** 2 本とも「無い」を読んで
    // 2 通出る。抑止の関門は主キーの側にある（`migrations/0013_fork_notices.sql`）。
    const parentAuthor = await seedNoticeUser('race-parent');
    const forkAuthor = await seedNoticeUser('race-forker');
    await seedNoticeGame('fn-race-parent', parentAuthor, null);
    await seedNoticeGame('fn-race-child', forkAuthor, 'fn-race-parent');

    const { requests, fetcher } = recording();
    const deps = { fetcher, send: sendMail };
    const outcomes = await Promise.all([
      notifyForkPublished(forkNoticeEnv(), 'fn-race-child', deps),
      notifyForkPublished(forkNoticeEnv(), 'fn-race-child', deps),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'sent')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already-sent')).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('送信に失敗しても投げ返さず、結末を記録する', async () => {
    const parentAuthor = await seedNoticeUser('fail-parent');
    const forkAuthor = await seedNoticeUser('fail-forker');
    await seedNoticeGame('fn-fail-parent', parentAuthor, null);
    await seedNoticeGame('fn-fail-child', forkAuthor, 'fn-fail-parent');

    const { requests, fetcher } = recording(500);
    expect(
      await notifyForkPublished(forkNoticeEnv(), 'fn-fail-child', { fetcher, send: sendMail }),
    ).toBe('send-failed');
    expect(requests).toHaveLength(1);
    expect((await readForkNotice('fn-fail-child'))?.outcome).toBe('send-failed');

    // **握りを戻さない。** 公開は 1 作品につき 1 回で、次にこの経路へ入る契機が無い
    // ——戻すと、誰も拾わない「未送信の行」として残る。
    const { requests: retried, fetcher: retryFetcher } = recording();
    expect(
      await notifyForkPublished(forkNoticeEnv(), 'fn-fail-child', {
        fetcher: retryFetcher,
        send: sendMail,
      }),
    ).toBe('already-sent');
    expect(retried).toHaveLength(0);
  });
});
