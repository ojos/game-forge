import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { dispatch } from '../src/routes.js';
import type { Route } from '../src/routes.js';
import {
  TAKEDOWN_FIELDS,
  TAKEDOWN_PATH,
  TAKEDOWN_SUBMIT_PATH,
  TAKEDOWN_THANKS_PATH,
  TERMS_PATH,
  siteFooter,
  takedownMessageOf,
} from '../src/legal.js';
import { gameIdFromInput } from '../src/takedown-routes.js';
import {
  MAX_BODY_LENGTH,
  MAX_CLAIMANT_LENGTH,
  TAKEDOWN_ACTIONS,
  recordTakedownAction,
  recordTakedownRequest,
} from '../src/takedown.js';
import { applySchema } from './helpers/schema.js';
import type { MailMessage, sendMail } from '../src/mail/resend.js';
import { buildSessionCookie, signSession } from '../src/session.js';

/** 本番と同じ経路表（`/__dev/*` を含まない形）。 */
const ROUTES: readonly Route[] = createAppRoutes(env);

/** セッションの署名鍵。 */
const SECRET = 'test-secret-value-for-legal-endpoint-1';

/**
 * 署名鍵を差した env。
 *
 * @returns バインディングと環境変数
 */
function sessionEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as unknown as Env;
}

/**
 * ログイン済みの cookie を作る。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 経路を GET で叩く。
 *
 * @param path パス
 * @param cookie `Cookie` ヘッダの値（省略すると未ログイン）
 * @returns 本文
 */
async function get(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const res = await dispatch(
    ROUTES,
    new Request(`https://app.example.invalid${path}`, { headers }),
    sessionEnv(),
  );
  return { status: res.status, body: await res.text() };
}

/**
 * 運用者の宛先を差した env。
 *
 * **設定が無いと送らない**のが正しい挙動なので（`src/takedown.ts`）、送信を試す
 * 検査だけがこれを使う。
 *
 * @returns バインディングと環境変数
 */
function mailEnv(): Env {
  return { ...env, OPERATOR_EMAIL: 'ops@example.invalid' } as unknown as Env;
}

/**
 * 送信の記録（メールを実際には送らない）。
 *
 * **`never` で型を捨てない。** `as never` は何にでも代入できるので、
 * `recordTakedownRequest` の依存の型が変わっても**テストが追随しないまま緑になる**
 * （Copilot の指摘。2026-09-04）。**本物の型（`typeof sendMail`）で受ける。**
 *
 * @returns 記録した宛先と、差し替える送信関数
 */
function recordingSend(): {
  readonly sent: MailMessage[];
  readonly send: typeof sendMail;
} {
  const sent: MailMessage[] = [];
  const send: typeof sendMail = async (_env, message) => {
    sent.push(message);
    return { sent: true };
  };
  return { sent, send };
}

beforeAll(async () => {
  await applySchema();
});

describe('規約に、仕様が名指しした条項が含まれている（5.6 / #41 の acceptance 1）', () => {
  it('フォークの許諾条項がある', async () => {
    const { status, body } = await get(TERMS_PATH);
    expect(status).toBe(200);
    // 5.6:「投稿は、他ユーザーによる改変・再配布を許諾するものとする」
    expect(body).toContain('改変（フォーク）');
    expect(body).toContain('許諾');
  });

  it('権利帰属と非独占の利用許諾がある', async () => {
    const { body } = await get(TERMS_PATH);
    // 5.6:「生成物の権利帰属（ユーザーに帰属し、サービスへ非独占の利用許諾）」
    expect(body).toContain('生成した利用者に帰属');
    expect(body).toContain('非独占');
  });

  it('即時削除権限がある', async () => {
    const { body } = await get(TERMS_PATH);
    // 8.4:「利用規約で即時削除権限を明示する」
    expect(body).toContain('事前の通知なく削除');
  });

  it('生成物の正確性についての通知がある', async () => {
    const { body } = await get(TERMS_PATH);
    // 5.6:「Output に含まれる事実の主張は、正確性を独自に確認せずに依拠すべきでない」
    expect(body).toContain('正確性を独自に確認');
  });

  it('専門家の確認を受けていないことが画面に出る', async () => {
    // **読む人が「確認済みのもの」と誤解しないようにする。**
    const { body } = await get(TERMS_PATH);
    expect(body).toContain('暫定版');
    expect(body).toContain('法律の専門家による確認を受ける前');
  });
});

describe('削除申請フォームが全ページのフッターから到達できる（#41 の acceptance 2）', () => {
  it('経路表から導いた全 SSR 画面にフッターが出る', async () => {
    // **一覧を手で書かない。** 経路表から導くので、**画面を 1 枚足してフッターを
    // 書き忘れると、この検査が赤くなる。**
    //
    // **ログイン済みで叩く。** 最初はセッション無しで叩き、200 でない画面を
    // `continue` で飛ばしていたが、**それだと `/works` や `/invites` が丸ごと
    // 検査から漏れていた**（1 画面のフッターを外す変異が緑のままだった）。
    // 作者が最も長く見る画面がちょうどそこである。
    await env.DB.prepare(
      `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
       values ('legal-user', 'sub-legal-user', 'legal@example.invalid', 'legal', 0, null)`,
    ).run();
    const cookie = await cookieFor('legal-user');

    const pages = ROUTES.filter(
      (route: Route) =>
        route.method === 'GET' &&
        route.match !== 'prefix' &&
        !route.path.startsWith('/api/') &&
        !route.path.startsWith('/auth/') &&
        !route.path.startsWith('/__dev'),
    );
    expect(pages.length).toBeGreaterThan(5);

    // **飛ばした画面を数える。** 黙って飛ばすと、次に増えた画面が検査から漏れても
    // 気づけない（この検査自身がその形で空振りしていた）。
    const skipped: string[] = [];
    for (const page of pages) {
      const { status, body } = await get(page.path, cookie);
      if (status !== 200) {
        skipped.push(`${page.path} (${status})`);
        continue;
      }
      expect(body, `${page.path} にフッターが無い`).toContain(TAKEDOWN_PATH);
      expect(body, `${page.path} に規約への導線が無い`).toContain(TERMS_PATH);
    }
    // **ログイン済みなら、すべての画面が本文を出すはずである。**
    expect(skipped, '本文を出さなかった画面がある').toEqual([]);
  });

  it('作品ページ（前方一致の経路）にもフッターが出る', async () => {
    // 上の検査は完全一致の経路だけを見ている。**前方一致は別に見る**
    // ——`/works/<id>` は拡散の着地点であり、ここに無いと意味が薄い。
    const { body } = await get('/works/no-such-game');
    expect(body).toContain(TAKEDOWN_PATH);
  });

  it('フッターは 1 か所から来ている', () => {
    const footer = siteFooter();
    expect(footer).toContain(TERMS_PATH);
    expect(footer).toContain(TAKEDOWN_PATH);
  });

  it('削除申請フォームはログイン無しで開ける', async () => {
    const { status, body } = await get(TAKEDOWN_PATH);
    expect(status).toBe(200);
    expect(body).toContain(TAKEDOWN_SUBMIT_PATH);
    expect(body).toContain('ログインは不要');
  });
});

describe('送信防止措置の記録（8.4 / #41 の acceptance 3）', () => {
  it('申請を追記し、作品には触らない', async () => {
    const { sent, send } = recordingSend();
    const outcome = await recordTakedownRequest(
      env,
      {
        gameId: 'td-game-1',
        claimantName: '権利者A',
        claimantContact: 'a@example.invalid',
        body: '当社の著作物です。削除を求めます。',
      },
      { send, now: 100 },
    );
    expect(outcome.ok).toBe(true);

    const row = await env.DB.prepare(
      'select game_id, claimant_name, handled_at, action from takedown_requests where game_id = ?',
    )
      .bind('td-game-1')
      .first<{ game_id: string; claimant_name: string; handled_at: number | null; action: string | null }>();
    expect(row?.claimant_name).toBe('権利者A');
    // **未対応であることが NULL の唯一の意味である。**
    expect(row?.handled_at).toBeNull();
    expect(row?.action).toBeNull();
    void sent;
  });

  it('措置を追記できる。申請の内容は書き換わらない', async () => {
    const { send } = recordingSend();
    const outcome = await recordTakedownRequest(
      env,
      {
        gameId: 'td-game-2',
        claimantName: '権利者B',
        claimantContact: 'b@example.invalid',
        body: '削除を求めます。',
      },
      { send, now: 100 },
    );
    expect(outcome.ok).toBe(true);
    const id = outcome.ok ? outcome.receipt.id : '';

    expect(await recordTakedownAction(env, id, 'removed', '権利者からの申請により削除', 200)).toBe(
      true,
    );

    const row = await env.DB.prepare(
      'select claimant_name, body, handled_at, action, note from takedown_requests where id = ?',
    )
      .bind(id)
      .first<{
        claimant_name: string;
        body: string;
        handled_at: number;
        action: string;
        note: string;
      }>();
    // **申請の内容は 1 文字も変わっていない。** これが「追記のみ」の実体である。
    expect(row?.claimant_name).toBe('権利者B');
    expect(row?.body).toBe('削除を求めます。');
    expect(row?.handled_at).toBe(200);
    expect(row?.action).toBe('removed');
  });

  it('措置を 2 度上書きしない', async () => {
    const { send } = recordingSend();
    const outcome = await recordTakedownRequest(
      env,
      { gameId: 'td-game-3', claimantName: 'C', claimantContact: 'c@example.invalid', body: 'x' },
      { send, now: 100 },
    );
    const id = outcome.ok ? outcome.receipt.id : '';
    expect(await recordTakedownAction(env, id, 'rejected', '権利の根拠が不明', 200)).toBe(true);
    // 2 度目は 0 行更新。
    expect(await recordTakedownAction(env, id, 'removed', 'やっぱり削除', 300)).toBe(false);

    const row = await env.DB.prepare('select action from takedown_requests where id = ?')
      .bind(id)
      .first<{ action: string }>();
    expect(row?.action).toBe('rejected');
  });

  it('申請を認めなかったことも記録できる', () => {
    // **残さないと「見ていない」と区別がつかない。**
    expect(TAKEDOWN_ACTIONS).toContain('rejected');
  });
});

describe('通知は同じ作品につき 1 通（#41 の intake）', () => {
  it('2 件目以降は送らないが、記録は全件残る', async () => {
    const { sent, send } = recordingSend();
    const input = {
      gameId: 'td-game-mail',
      claimantName: 'D',
      claimantContact: 'd@example.invalid',
      body: 'x',
    };
    const first = await recordTakedownRequest(mailEnv(), input, { send, now: 100 });
    const second = await recordTakedownRequest(mailEnv(), input, { send, now: 200 });

    expect(first.ok && first.receipt.notified).toBe(true);
    // **濫用されても送信量は作品数で頭打ちになる。**
    expect(second.ok && second.receipt.notified).toBe(false);
    expect(sent).toHaveLength(1);

    // **記録は全件残る**（8.4 が求めているのは記録である）。
    const rows = await env.DB.prepare(
      'select count(*) as n from takedown_requests where game_id = ?',
    )
      .bind('td-game-mail')
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('宛先の設定が無ければ送らない（受付は成功する）', async () => {
    // **メールが出ないことを理由に行を捨てない**（8.4 が求める記録が消える）。
    const { sent, send } = recordingSend();
    const outcome = await recordTakedownRequest(
      env,
      { gameId: 'td-no-mail', claimantName: 'G', claimantContact: 'g@example.invalid', body: 'x' },
      { send, now: 100 },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.receipt.notified).toBe(false);
    expect(sent).toHaveLength(0);

    const row = await env.DB.prepare('select game_id from takedown_requests where game_id = ?')
      .bind('td-no-mail')
      .first<{ game_id: string }>();
    expect(row?.game_id).toBe('td-no-mail');
  });

  it('同時に走っても 1 通に収束する（先に SELECT する形では防げない）', async () => {
    // **`src/invites.ts` が二重使用の防止で避けているのと同じ形。** SELECT で見てから
    // 送ると、同時の 3 本はどれも「まだ誰も送っていない」と読む。
    const { sent, send } = recordingSend();
    const input = {
      gameId: 'td-race',
      claimantName: 'R',
      claimantContact: 'r@example.invalid',
      body: 'x',
    };
    const outcomes = await Promise.all([
      recordTakedownRequest(mailEnv(), input, { send, now: 100 }),
      recordTakedownRequest(mailEnv(), input, { send, now: 100 }),
      recordTakedownRequest(mailEnv(), input, { send, now: 100 }),
    ]);
    expect(outcomes.filter((o) => o.ok && o.receipt.notified)).toHaveLength(1);
    expect(sent).toHaveLength(1);

    // **記録は 3 件とも残る**（8.4 が求めているのは記録である）。
    const rows = await env.DB.prepare(
      'select count(*) as n from takedown_requests where game_id = ?',
    )
      .bind('td-race')
      .first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });

  it('通知に申請者の連絡先も本文も載らない', async () => {
    const { sent, send } = recordingSend();
    await recordTakedownRequest(
      mailEnv(),
      {
        gameId: 'td-game-privacy',
        claimantName: 'ヒミツの名前',
        claimantContact: 'secret@example.invalid',
        body: 'ヒミツの本文',
      },
      { send, now: 100 },
    );
    expect(sent).toHaveLength(1);
    const mail = `${sent[0]!.subject}\n${sent[0]!.text}`;
    expect(mail).not.toContain('ヒミツの名前');
    expect(mail).not.toContain('secret@example.invalid');
    expect(mail).not.toContain('ヒミツの本文');
  });
});

describe('受付の入口（非ログイン）', () => {
  it('作品 URL を貼っても ID を取り出せる', () => {
    // **こちらが 1 行書けば済むことを、申請者にやらせない。**
    expect(gameIdFromInput('https://app.example.invalid/works/abc-123')).toBe('abc-123');
    expect(gameIdFromInput('  /works/abc-123?forks=20  ')).toBe('abc-123');
    expect(gameIdFromInput('abc-123')).toBe('abc-123');
  });

  it('フォームから送ると 303 で受付画面へ行き、行が残る', async () => {
    const form = new URLSearchParams({
      [TAKEDOWN_FIELDS.gameId]: 'https://app.example.invalid/works/td-form',
      [TAKEDOWN_FIELDS.name]: 'E',
      [TAKEDOWN_FIELDS.contact]: 'e@example.invalid',
      [TAKEDOWN_FIELDS.body]: '削除を求めます。',
    });
    const res = await dispatch(
      ROUTES,
      new Request(`https://app.example.invalid${TAKEDOWN_SUBMIT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: form.toString(),
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(TAKEDOWN_THANKS_PATH);

    const row = await env.DB.prepare('select game_id from takedown_requests where game_id = ?')
      .bind('td-form')
      .first<{ game_id: string }>();
    expect(row?.game_id).toBe('td-form');
  });

  it('前後の空白をならしてから記録する', async () => {
    // **検査だけ trim して記録に生の値を使うと、末尾の空白が付いた入力が
    // 別作品として記録され、「作品につき 1 通」の判定もずれる。**
    const { sent, send } = recordingSend();
    await recordTakedownRequest(
      mailEnv(),
      { gameId: '  td-trim  ', claimantName: 'T', claimantContact: 't@example.invalid', body: 'x' },
      { send, now: 100 },
    );
    await recordTakedownRequest(
      mailEnv(),
      { gameId: 'td-trim', claimantName: 'T', claimantContact: 't@example.invalid', body: 'x' },
      { send, now: 200 },
    );
    // 同じ作品として扱われるので、通知は 1 通。
    expect(sent).toHaveLength(1);
    const row = await env.DB.prepare(
      'select count(*) as n from takedown_requests where game_id = ?',
    )
      .bind('td-trim')
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it('空の項目は断る（行も作らない）', async () => {
    const before = await env.DB.prepare('select count(*) as n from takedown_requests').first<{
      n: number;
    }>();
    const outcome = await recordTakedownRequest(env, {
      gameId: 'td-empty',
      claimantName: '',
      claimantContact: 'x@example.invalid',
      body: 'x',
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('missing-field');

    const after = await env.DB.prepare('select count(*) as n from takedown_requests').first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });

  it('長すぎる入力は断る', async () => {
    const tooLongName = await recordTakedownRequest(env, {
      gameId: 'td-long',
      claimantName: 'あ'.repeat(MAX_CLAIMANT_LENGTH + 1),
      claimantContact: 'x@example.invalid',
      body: 'x',
    });
    expect(!tooLongName.ok && tooLongName.reason).toBe('claimant-too-long');

    const tooLongBody = await recordTakedownRequest(env, {
      gameId: 'td-long',
      claimantName: 'F',
      claimantContact: 'x@example.invalid',
      body: 'あ'.repeat(MAX_BODY_LENGTH + 1),
    });
    expect(!tooLongBody.ok && tooLongBody.reason).toBe('body-too-long');
  });

  it('知らない理由は既定の文言へ倒す（反射型の差し込みを作らない）', () => {
    expect(takedownMessageOf('<script>')).not.toContain('<script>');
    expect(takedownMessageOf('missing-field')).toContain('すべての項目');
  });
});
