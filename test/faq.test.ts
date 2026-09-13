import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { FAQ_ENTRIES, FAQ_TITLE, faqBody } from '../src/faq.js';
import { INVITE_RECOVERY_DAYS } from '../src/invite-balance.js';
import { INVITE_QUOTA } from '../src/invite-issuance.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from '../src/legal-paths.js';
import { SIGNUP_PATH } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER, REVISIONS_PER_GAME } from '../src/quota.js';
import { dispatch } from '../src/routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '../src/service-contact.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * よくある質問（`/faq`。2.3.1 v1.57 / #373）。
 *
 * **外枠は `test/page-shell.test.ts` が経路表から導いて見る**ので、ここは本文だけを見る。
 */

/**
 * D1 に触ると投げる env（`test/privacy.test.ts` と同じ。静的な画面であることを確かめる）。
 *
 * @returns D1 だけを差し替えた env
 */
function envWithoutD1(): Env {
  const broken = new Proxy(
    {},
    {
      get() {
        throw new Error('D1 に触れた');
      },
    },
  );
  return { ...env, DB: broken } as unknown as Env;
}

/**
 * 画面を未ログインで開く。
 *
 * @returns 状態と本文
 */
async function openFaq(): Promise<{ status: number; body: string }> {
  const res = await dispatch(
    createAppRoutes(env),
    new Request(`https://app.example.invalid${FAQ_PATH}`),
    envWithoutD1(),
  );
  return { status: res.status, body: await res.text() };
}

/**
 * id で答えを引く。
 *
 * @param id 質問の id
 * @returns 答えの HTML
 */
function answerOf(id: string): string {
  const entry = FAQ_ENTRIES.find((candidate) => candidate.id === id);
  expect(entry, `質問 ${id} が無い`).toBeDefined();
  return entry!.answer;
}

describe('よくある質問の画面（#373）', () => {
  it('ログイン無しで、D1 を読まずに 200 で開く', async () => {
    const { status, body } = await openFaq();
    expect(status).toBe(200);
    expect(body).toContain(`<title>${FAQ_TITLE}</title>`);
  });

  it('scope.in の 6 つの質問がある', () => {
    // #373 の scope.in:「生成枠はいつ戻るか / 招待はどう得るか / 作った作品の権利は誰のものか /
    // 改造されたくない場合 / 生成に失敗したとき枠は戻るか / 対応ブラウザ」
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    for (const id of ['quota', 'invite', 'rights', 'no-fork', 'failed-generation', 'browser']) {
      expect(ids, `質問 ${id} が無い`).toContain(id);
    }
  });

  it('質問の一覧から、すべての答えへ飛べる（id が重複しない）', async () => {
    const body = pageBodyOf((await openFaq()).body);
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(body, `一覧に #${id} が無い`).toContain(`href="#${id}"`);
      expect(body, `答えに id="${id}" が無い`).toContain(`id="${id}"`);
    }
  });

  it('質問はエスケープして出す', () => {
    const body = faqBody([{ id: 'x', question: '<script>', answer: '<p>a</p>' }]);
    expect(body).not.toContain('<script>');
  });
});

describe('仕様と食い違わない（#373 の constraints。4.3 / 4.4 / 5.6 / 8.1 / 8.4）', () => {
  it('生成枠は正本の定数から出し、JST の 0 時に戻ると書く（4.4 / 確定25）', () => {
    // **定数と仕様書の一致は `test/quota.test.ts` が見ている**ので、ここは定数と本文の一致を見る。
    const answer = answerOf('quota');
    expect(answer).toContain(`1 人 1 日 ${DAILY_QUOTA_PER_USER} 回`);
    expect(answer).toContain('日本時間の 0 時に戻ります');
    expect(answer).toContain(`1 作品につき ${REVISIONS_PER_GAME} 回まで`);
  });

  it('月次の上限はサービス全体のもので、達すると全体の生成が止まると書く（4.3 / 4.4）', () => {
    const answer = answerOf('quota');
    expect(answer).toContain('サービス全体');
    expect(answer).toContain('サービス全体で生成が止まります');
    // 4.4:「プレイと共有は引き続きご利用いただけます」
    expect(answer).toContain('遊ぶことと共有することは引き続きご利用いただけます');
  });

  it('失敗しても枠は戻らず、自動の作り直しは試行の回数だけ使うと書く（確定25 / 5.2-7）', () => {
    const answer = answerOf('failed-generation');
    expect(answer).toContain('戻りません');
    expect(answer).toContain(`最大 ${MAX_GENERATION_ATTEMPTS} 回分`);
    // 8.2: 入力側の検査はモデル呼び出しの前に止まるので、枠を消費しない。
    expect(answer).toContain('枠は減りません');
  });

  it('招待枠は溜まる上限と戻る速さを、定数から書く（8.1。#396 で時限回復を実装した）', () => {
    const answer = answerOf('invite');
    expect(answer).toContain(
      `1 人 ${INVITE_QUOTA} 本まで溜まり、使うと ${INVITE_RECOVERY_DAYS} 日ごとに 1 本ずつ戻ります`,
    );
    expect(answer).toContain(`href="${SIGNUP_PATH}"`);
    // #396 より前の「発行できる総数」の書き方を残さない。
    expect(answer).not.toContain('本まで招待コードを発行できます');
  });

  it('権利は規約（5.6）へ、削除依頼は削除依頼の画面（8.4）へ導く', () => {
    const rights = answerOf('rights');
    expect(rights).toContain('生成した利用者に帰属');
    expect(rights).toContain('非独占');
    expect(rights).toContain(`href="${TERMS_PATH}"`);
    expect(answerOf('contact')).toContain(`href="${TAKEDOWN_PATH}"`);
  });

  it('取り下げは既に改造された作品に及ばないと書く（5.3 / 規約 4）', () => {
    const answer = answerOf('no-fork');
    expect(answer).toContain('公開しなければ、改造されることはありません');
    expect(answer).toContain('取り下げる前に作られた改造作品は消えません');
    // **未公開の作品ページそのものは誰でも開ける**（状態だけを出す。`src/work-page.ts` の
    // `readySection`）。本人に限るのは遊べる URL である（PR #400 の Copilot の指摘）。
    expect(answer).not.toContain('作品ページは作った本人にしか開けません');
    expect(answer).toContain('作品を遊べる URL は作った本人にしか表示されません');
    expect(answer).toContain('題名と「まだ公開されていません」という表示が出るだけ');
  });

  it('問い合わせの窓口は 1 か所の定数から来る', () => {
    const answer = answerOf('contact');
    expect(answer).toContain(`href="${CONTACT_MAILTO}"`);
    expect(answer).toContain(CONTACT_EMAIL);
    expect(answer).toContain(`href="${PRIVACY_PATH}"`);
  });
});
