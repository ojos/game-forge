import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { dispatch } from '../src/routes.js';
import type { Route } from '../src/routes.js';
import {
  LOGO_FONT_NOTICE,
  TAKEDOWN_FIELDS,
  TAKEDOWN_PATH,
  TAKEDOWN_SUBMIT_PATH,
  TAKEDOWN_THANKS_PATH,
  TERMS_PATH,
  footerItems,
  siteFooter,
  takedownMessageOf,
} from '../src/legal.js';
import { FAQ_PATH, PRIVACY_PATH } from '../src/legal-paths.js';
import { NEWS_ARTICLES } from '../src/news-articles.js';
import { NEWS_PATH } from '../src/news-paths.js';
import { GENERATE_PAGE_PATH, HOME_PATH } from '../src/paths.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '../src/service-contact.js';
import { gameIdFromInput } from '../src/takedown-routes.js';
import { PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import {
  MAX_BODY_LENGTH,
  MAX_CLAIMANT_LENGTH,
  TAKEDOWN_ACTIONS,
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

  it('ロゴの書体の表示が、規約の末尾（フッタの直前）にある（#440 / docs/logo.md 5 章）', async () => {
    const { body } = await get(TERMS_PATH);
    expect(body).toContain(LOGO_FONT_NOTICE);
    // **著作権表示は同梱の NOTICE と同じ綴り**（書き写しがずれると表示の意味が無くなる）。
    expect(LOGO_FONT_NOTICE).toContain('Copyright 2020 The DotGothic16 Project Authors');
    expect(LOGO_FONT_NOTICE).toContain('SIL Open Font License 1.1');
    // **フッタより前の本文だけで見る。** #469 までフッタも区画の見出しに <h2> を使っていた（PR #442 の Copilot code review）。
    const main = body.slice(0, body.indexOf('<footer class="gf-footer">'));
    expect(main, 'フッタより前にある').toContain(LOGO_FONT_NOTICE);
    expect(main.indexOf(LOGO_FONT_NOTICE), '本文の最後の見出しの後にある').toBeGreaterThan(main.lastIndexOf('<h2'));
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

  it('暫定版の但し書きはブロックで、本文は読み物の器に乗る（仕様 2.5.3 / #471 / #564）', async () => {
    const { body } = await get(TERMS_PATH);
    expect(body).toContain('<div class="gf-legal gf-reading">\n<h1>利用規約</h1>\n<p class="gf-block gf-draft-notice">');
  });
});

describe('削除依頼フォームが全ページのフッターから到達できる（#41 の acceptance 2）', () => {
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
        // 1 セグメントの経路（`/@handle`。#381）も続きを補わないと開けない。フッタは外枠の検査
        // （`test/page-shell.test.ts`）がハンドル名を補って見る。
        route.match !== 'segment' &&
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
      // **#373 の受け入れ（訂正後）: フッタから 2 枚と問い合わせ先の 3 つへ辿れる。**
      expect(body, `${page.path} にプライバシーポリシーへの導線が無い`).toContain(
        `href="${PRIVACY_PATH}"`,
      );
      expect(body, `${page.path} によくある質問への導線が無い`).toContain(`href="${FAQ_PATH}"`);
      expect(body, `${page.path} に問い合わせ先が無い`).toContain(`href="${CONTACT_MAILTO}"`);
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

  it('フッターは見出しの無い 6 項目を、この並びと文言で持つ（2.3.7 の #435 注記 / 仕様 2.5.7 / #469）', () => {
    // **並びと文言まで見る。** リンクの有無だけを見ると、並びを崩しても、文言を古いまま残しても通る。
    // **綴りは提供する側の定数から取り、期待値の文言はここに書く**（実装の定数どうしを比べると必ず緑になる）。
    expect(NEWS_ARTICLES.length, 'お知らせの記事が 0 本だと、6 項目の検査が空振りする').toBeGreaterThan(0);
    const footer = siteFooter();
    const links = [...footer.matchAll(/<a class="gf-link-quiet" href="([^"]*)">([^<]*)<\/a>/gu)].map(
      (match) => [match[1], match[2]] as const,
    );
    expect(links).toEqual([
      [NEWS_PATH, 'お知らせ'],
      [FAQ_PATH, 'よくある質問'],
      [TERMS_PATH, '利用規約'],
      [PRIVACY_PATH, 'プライバシーポリシー'],
      [CONTACT_MAILTO, 'お問い合わせ（メール）'],
      [TAKEDOWN_PATH, '削除依頼（権利者の方）'],
    ]);
    // **リンクはこの 6 つだけ**（ロゴはリンクにしない。上の正規表現に当たらないリンクも数える）。
    expect(footer.match(/<a\b/gu)).toHaveLength(6);
    // **区画の見出しを置かない**（#331 の 3 区画を #435 が覆した）。
    expect(footer).not.toMatch(/<h[1-6]\b/u);
    expect(footer).not.toContain('gf-footer-group');
    // **ヘッダと重複する「作品をさがす」「つくる」と、トップへのリンクを持たない。**
    for (const absent of [PUBLIC_WORKS_PATH, GENERATE_PAGE_PATH, HOME_PATH]) {
      expect(footer, `フッターに ${absent} へのリンクがある`).not.toContain(`href="${absent}"`);
    }
    // **お問い合わせのラベルにアドレスを出さない**（#373 の実装注記を #435 が覆した。アドレスは FAQ と /privacy に出る）。
    expect(CONTACT_MAILTO).toBe(`mailto:${CONTACT_EMAIL}`);
    expect(footer).not.toContain(`>メールでのお問い合わせ（${CONTACT_EMAIL}）<`);
  });

  it('お知らせの記事が 0 本なら「お知らせ」を出さず、5 項目になる（2.3.7 の #435 注記）', () => {
    // **記事が 0 本のとき、一覧の経路は登録されない**（`src/news.ts`）。残すと行き先の無いリンクになる。
    const items = footerItems([]);
    expect(items.map((item) => item.label)).toEqual([
      'よくある質問',
      '利用規約',
      'プライバシーポリシー',
      'お問い合わせ（メール）',
      '削除依頼（権利者の方）',
    ]);
    expect(items.map((item) => item.path)).not.toContain(NEWS_PATH);
    // **記事があれば先頭に出る**（画面が渡すのと同じ記事で見る）。
    expect(footerItems(NEWS_ARTICLES)[0]).toEqual({ path: NEWS_PATH, label: 'お知らせ' });
  });

  it('行き先の無い項目を置かない（会社情報・SNS。2.3.7 / 4.4 / 2.2）', () => {
    // **AivisHub の 5 区画のうち、会社情報と SNS はこのサービスに行き先が実在しない**
    // （v1.57 でも #435 でも維持。2.3.14）。
    const footer = siteFooter();
    for (const absent of ['会社情報', 'SNS']) {
      expect(footer, `フッターに ${absent} がある`).not.toContain(absent);
    }
  });

  it('フッターはログイン状態を引数に取らない（出し分けはヘッダだけが持つ）', () => {
    // **同じ呼び出しが同じ HTML を返す。** フッタが出し分かると、POST の結果を返す
    // 画面（`src/publish.ts` など）が状態を知らないまま組むことになる。
    expect(siteFooter.length, 'siteFooter が引数を取るようになっている').toBe(0);
    expect(siteFooter()).toBe(siteFooter());
  });

  it('削除依頼フォームはログイン無しで開ける', async () => {
    const { status, body } = await get(TAKEDOWN_PATH);
    expect(status).toBe(200);
    expect(body).toContain(TAKEDOWN_SUBMIT_PATH);
    expect(body).toContain('ログインは不要');
  });
});

describe('送信防止措置の記録（8.4 / #41 の acceptance 3）', () => {
  it('依頼を追記し、作品には触らない', async () => {
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

  // **措置の記録は運営の管理画面の口へ移した**（#406。`src/admin/actions.ts` の
  // `recordTakedownAction`）。「依頼の内容は書き換わらない」「措置を 2 度上書きしない」は、
  // 実行者と履歴まで含めて `test/admin-actions.test.ts` の「削除依頼の措置の記録」が確かめる
  // ——**履歴を残さずに措置を書ける関数を `src/takedown.ts` に残さない**ため、ここからは外した。

  it('依頼を認めなかったことも記録できる', () => {
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

  it('通知に依頼者の連絡先も本文も載らない', async () => {
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
    // **こちらが 1 行書けば済むことを、依頼者にやらせない。**
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

describe('削除依頼のフォームの見た目（#473 / 仕様 2.5.4 / 2.5.5）', () => {
  it('入力欄はブロックのフォームにあり、「依頼を送る」がこの画面で 1 つだけの主のボタンである', async () => {
    const { status, body } = await get(TAKEDOWN_PATH);
    expect(status).toBe(200);
    expect(body.match(/\bgf-button-primary\b/gu) ?? []).toHaveLength(1);
    const form = /<form class="gf-block" method="post" action="[^"]*">([\s\S]*?)<\/form>/u.exec(body)?.[1] ?? '';
    expect(form, 'フォームがブロックでない').not.toBe('');
    expect(form.match(/<input type="text"/gu) ?? []).toHaveLength(3);
    expect(form).toContain('<textarea');
    expect(form).toContain('<button type="submit" class="gf-button gf-button-primary">依頼を送る</button>');
  });
});

describe('作品の削除（#517）', () => {
  it('規約の 4 章に、下書きと取り下げた作品は削除できることと、派生した作品には及ばないことを書く', async () => {
    const { body } = await get(TERMS_PATH);
    const chapter4 = body.slice(body.indexOf('<h2>4. 改変と再配布の許諾</h2>'), body.indexOf('<h2>5. 生成物の正確性</h2>'));
    expect(chapter4).toContain('公開していない作品と、公開を取り下げた作品を、');
    expect(chapter4).toContain('作品ページから削除できます。');
    expect(chapter4).toContain('削除も、既にフォークされた作品には及びません。');
  });
});

describe('退会（#518 / M15-3）', () => {
  it('規約に退会の条項があり、作品の削除・戻せないこと・派生作品の存続を書く', async () => {
    const { body } = await get(TERMS_PATH);
    const chapter = body.slice(body.indexOf('<h2>8. 退会</h2>'), body.indexOf('<h2>9. 免責</h2>'));
    expect(chapter, '退会の章が無い').not.toBe('');
    expect(chapter).toContain('いつでも自分の意思で退会できます');
    expect(chapter).toContain('利用者の作品はすべて取り下げたうえで削除されます');
    expect(chapter).toContain('退会は取り消せません');
    expect(chapter).toContain('新しい招待コードが必要');
    expect(chapter).toContain('退会も、既にフォークされた作品には及びません');
    // **運営の措置は退会で消えない**（BAN の回避に使われない。#518 の constraints）。
    expect(chapter).toContain('その利用者が退会したかどうかにかかわりません');
  });

  it('章の番号が飛んでいない（退会を足して後ろを繰り下げた）', async () => {
    const { body } = await get(TERMS_PATH);
    const main = body.slice(0, body.indexOf('<footer class="gf-footer">'));
    const numbered = [...main.matchAll(/<h2>(\d+)\. /gu)].map((match) => Number(match[1]));
    expect(numbered).toEqual(Array.from({ length: numbered.length }, (_value, index) => index + 1));
    expect(numbered.length).toBe(11);
  });
});
