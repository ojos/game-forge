import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { MAX_GENERATION_ATTEMPTS } from '../src/build-retry.js';
import { FAQ_ENTRIES, FAQ_TITLE, MCP_SERVER_URL, faqBody } from '../src/faq.js';
import { ACCOUNT_APPS_PATH } from '../src/account-paths.js';
import { MCP_TOOL_NAMES } from '../src/mcp-server.js';
import { PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import { OAUTH_SCOPE_LABELS, SCOPE_WORKS_GENERATE, SCOPE_WORKS_WRITE } from '../src/oauth-paths.js';
import { TYPICAL_WAIT_TEXT } from '../src/generate-page.js';
import { INVITE_RECOVERY_DAYS } from '../src/invite-balance.js';
import { INVITE_QUOTA } from '../src/invite-issuance.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from '../src/legal-paths.js';
import { SIGNUP_PATH } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER } from '../src/quota.js';
import { CONTENT_SIGNAL } from '../src/robots.js';
import { dispatch } from '../src/routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from '../src/service-contact.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { HANDLE_RESERVATION_DAYS } from '../src/handle.js';
import { WITHDRAWN_DISPLAY_NAME } from '../src/withdrawal.js';
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

  it('質問の一覧はブロックで、本文の質問より前にある（仕様 2.5.3 / 2.5.4。#471）', async () => {
    const body = pageBodyOf((await openFaq()).body);
    expect(body.split('<div class="gf-block gf-faq-index">').length - 1).toBe(1);
    expect(body.indexOf('gf-faq-index')).toBeLessThan(body.indexOf('<section class="gf-faq-item"'));
  });

  it('質問はエスケープして出す', () => {
    const body = faqBody([{ id: 'x', question: '<script>', answer: '<p>a</p>' }]);
    expect(body).not.toContain('<script>');
  });
});

describe('トップから移した 2 項目（#471。仕様 2.3.3 の #435 注記の表）', () => {
  it('先頭に「どんなサービスか」「生成した作品はどうなるか」がこの順で並ぶ', () => {
    expect(FAQ_ENTRIES[0]?.id).toBe('about');
    expect(FAQ_ENTRIES[0]?.question).toBe('Game Forge はどんなサービスですか？');
    expect(FAQ_ENTRIES[1]?.id).toBe('after-generation');
    expect(FAQ_ENTRIES[1]?.question).toBe('生成した作品はどうなりますか？');
  });

  it('サービスの説明: 1 行から生まれる・改造して公開できる・クローズドβで遊ぶことと共有に登録は要らない', () => {
    const answer = answerOf('about');
    expect(answer).toContain('プロンプト 1 行から、ブラウザで遊べる 2D ゲームが生まれる');
    expect(answer).toContain('<strong>フォーク</strong>して、自分の 1 本として公開できます');
    expect(answer).toContain('招待制のクローズドβ');
    expect(answer).toContain('作品の URL を共有することには、登録も招待も要りません');
    expect(answer).toContain('href="#invite"');
  });

  it('生成した作品の扱い: 待ち時間は正本の定数から差し込み、下書き・作品ページで確かめて公開・URL の見え方はリンク', () => {
    const answer = answerOf('after-generation');
    // **数字を書き写さない**（正本は生成画面の `TYPICAL_WAIT_TEXT`）。定数を変えた日にここも追随する。
    expect(answer).toContain(`生成には${TYPICAL_WAIT_TEXT}。`);
    expect(TYPICAL_WAIT_TEXT).toContain('1〜2 分');
    expect(answer).toContain('<strong>下書き</strong>として保存されます');
    expect(answer).toContain('作品ページで遊んで確かめてから、公開できます');
    // **URL の見え方は重ねて書かず、既存の項目へリンクする**（同じ表）。
    expect(answer).toContain('href="#no-fork"');
    expect(answer).not.toContain('作った本人にしか表示されません');
  });

  it('画面の本文に、差し込んだ待ち時間が出る', async () => {
    const body = pageBodyOf((await openFaq()).body);
    expect(body).toContain(`生成には${TYPICAL_WAIT_TEXT}。`);
  });
});

describe('仕様と食い違わない（#373 の constraints。4.3 / 4.4 / 5.6 / 8.1 / 8.4）', () => {
  it('生成枠は正本の定数から出し、JST の 0 時に戻ると書く（4.4 / 確定25）', () => {
    // **定数と仕様書の一致は `test/quota.test.ts` が見ている**ので、ここは定数と本文の一致を見る。
    const answer = answerOf('quota');
    expect(answer).toContain(`1 人 1 日 ${DAILY_QUOTA_PER_USER} 回`);
    expect(answer).toContain('日本時間の 0 時に戻ります');
    // **1 作品あたりの上限はなくした**（#515）。回数の上限を言う文を残さない。
    expect(answer).not.toContain('1 作品につき');
    expect(answer).toContain('新しく作る・フォークする・リフォージする');
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
    // **行き先の画面の名前で呼ぶ**（`/signup` は「ログイン・登録」。#472）。
    expect(answer).toContain(`<a href="${SIGNUP_PATH}">ログイン・登録の画面</a>から待機リストに登録できます`);
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

  it('公開をやめても既に改造された作品に及ばないと書く（5.3 / 5.4 / 規約 4）', () => {
    const answer = answerOf('no-fork');
    expect(answer).toContain('公開しなければ、フォークされることはありません');
    expect(answer).toContain('公開をやめる前に作られたフォーク作品は消えません');
    // **戻る先が下書きであることを言う**（#637 / 確定35）。「もう辿れなくなる」と読ませない。
    expect(answer).toContain('下書きに戻り');
    // **未公開の作品ページそのものは誰でも開ける**（未公開であることだけを出す。`src/work-page.ts` の
    // `unpublishedSection`）。本人に限るのは遊べる URL である（PR #400 の Copilot の指摘）。
    expect(answer).not.toContain('作品ページは作った本人にしか開けません');
    expect(answer).toContain('作品を遊べる URL は作った本人にしか表示されません');
    // **題名は出ない**（#690 で表示と照らした。作者以外の未公開の作品ページは、見出しが既定の「Game Forge の作品」で、
    // 本文は「この作品はまだ公開されていません。」だけである。`loadWorkView` が作者以外には `title` を渡さない）。
    expect(answer).toContain('作品ページの URL を知っている人がそのページを開いても、「まだ公開されていません」という表示が出るだけ');
    expect(answer).not.toContain('題名と「まだ公開されていません」');
  });

  it('問い合わせの窓口は 1 か所の定数から来る', () => {
    const answer = answerOf('contact');
    expect(answer).toContain(`href="${CONTACT_MAILTO}"`);
    expect(answer).toContain(CONTACT_EMAIL);
    expect(answer).toContain(`href="${PRIVACY_PATH}"`);
  });
});

describe('フォークとリフォージの用語集（#513）', () => {
  it('画面の出力に旧い呼び名（改造・推敲・手直し）が出ない', async () => {
    const { body } = await openFaq();
    expect(oldOperationNamesIn(body)).toEqual([]);
    // 空振りしていない: 同じ画面に新しい呼び名が出ている。
    expect(body).toContain('フォーク');
    expect(body).toContain('リフォージ');
  });

  it('画面の出力に、1 作品あたりの回数の上限を出さない（#515）', async () => {
    const { body } = await openFaq();
    expect(body).not.toContain('1 作品につき');
    expect(body).not.toMatch(/(?:リフォージ|推敲|手直し)[^<]{0,20}[0-9]+ ?回まで/u);
  });

  it('用語集の項目があり、2 つの語の対象と結果の違いを仕様 5.3 / 5.7 のとおりに書く', () => {
    const answer = answerOf('glossary');
    // 5.3: 公開済みの作品を親にし、新しい作品行が生まれる（元は残る）。
    expect(answer).toContain('<strong>フォーク</strong>: <strong>公開されている作品</strong>をもとに、<strong>新しい作品</strong>を作ります');
    expect(answer).toContain('元の作品はそのまま残り');
    expect(answer).toContain('「このゲームからのフォーク」に数えられます');
    // 5.7: 自分の draft を対象にし、同じ作品行が置き換わる。版は残り戻せる。系統に載せない。
    expect(answer).toContain('<strong>リフォージ</strong>: <strong>公開する前の自分の作品</strong>を作り直します');
    expect(answer).toContain('<strong>同じ作品が作り直したものに置き換わります</strong>');
    expect(answer).toContain('前の版は残り、作品ページからいつでも戻せます');
    expect(answer).toContain('フォークの数には数えません');
    // 5.7「公開後の作り直しは扱わない。公開後に手を入れたい作者はフォークする」。
    expect(answer).toContain('公開したあとに手を加えたいときは、フォークしてください');
    // 回数は 1 日の枠を共有する（確定25）。
    expect(answer).toContain('新しく作るときと同じ<a href="#quota">1 日の生成枠</a>を共有します');
  });

  it('既存の項目から、ページ内リンクで用語集へ飛べる', () => {
    for (const id of ['about', 'quota', 'no-fork']) {
      expect(answerOf(id), `質問 ${id} から用語集へのリンクが無い`).toContain('href="#glossary"');
    }
  });
});

describe('作品の削除（#517）', () => {
  it('削除できる作品・戻せないこと・公開中は先に公開をやめること・フォークした作品は残ること・枠は戻らないことを書く', () => {
    const answer = answerOf('delete-work');
    expect(answer).toContain('公開していない作品（下書き）は、作品ページから削除できます');
    expect(answer).toContain('削除すると元に戻せません');
    expect(answer).toContain('先に作品ページの「公開をやめる」で下書きに戻してから削除してください');
    expect(answer).toContain('その作品をフォークして作られた作品は消えません');
    expect(answer).toContain('生成枠</a>は戻りません');
    expect(answer).toContain(`href="${PRIVACY_PATH}"`);
    expect(oldOperationNamesIn(answer)).toEqual([]);
  });

  it('公開をやめる答えの直後に置き、そこから辿れる', () => {
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    expect(ids.indexOf('delete-work')).toBe(ids.indexOf('no-fork') + 1);
    expect(answerOf('no-fork')).toContain('href="#delete-work"');
  });
});

describe('退会（#518 / M15-3）', () => {
  it('退会できること・押す場所・消えるもの・戻せないこと・招待が要ることを書く', () => {
    const answer = answerOf('withdraw');
    expect(answer).toContain('設定の「アカウント」から「退会について確かめる」');
    expect(answer).toContain('退会すると元に戻せません');
    expect(answer).toContain('あなたの作品はすべて取り下げられて削除されます');
    // **表示名の代わりの値と予約の日数は実装の定数と照合する**（shared-ai-rules 12 章）。
    expect(answer).toContain(WITHDRAWN_DISPLAY_NAME);
    expect(answer).toContain(`${HANDLE_RESERVATION_DAYS} 日`);
    expect(answer).toContain('新しい招待コードが必要です');
    expect(answer).toContain('生成中・リフォージ中の作品があるあいだは退会できません');
    expect(answer).toContain('フォークして作られた作品は消えません');
    expect(answer).toContain(`href="${PRIVACY_PATH}"`);
    expect(answer).toContain(`href="${TERMS_PATH}"`);
    expect(oldOperationNamesIn(answer)).toEqual([]);
  });

  it('作品の削除の直後に置き、削除の答えと窓口の答えから辿れる', () => {
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    expect(ids.indexOf('withdraw')).toBe(ids.indexOf('delete-work') + 1);
    for (const id of ['delete-work', 'contact']) {
      expect(answerOf(id), `質問 ${id} から退会へのリンクが無い`).toContain('href="#withdraw"');
    }
  });
});

describe('AI の学習（#594）', () => {
  it('拒否を表明していることと、その表明に強制力が無いことの両方を書く', () => {
    const answer = answerOf('ai-training');
    expect(answer).toContain('AI の学習に使わないよう、外部のクローラへ表明しています');
    expect(answer).toContain('<code>robots.txt</code>');
    expect(answer).toContain('AI の学習には使わないでほしい');
    // **できることだけを書いた案内にしない。** 従わないクローラを止める手段は無い
    // （`src/robots.ts` の「強制力は無い」）。
    expect(answer).toContain('この表明に強制力はありません');
    expect(answer).toContain('従わないクローラを技術的に止めるものではありません');
    // 公開しないという選択があることまで案内する（既存の項目へ送る）。
    expect(answer).toContain('href="#no-fork"');
    expect(answer).toContain(`href="${PRIVACY_PATH}"`);
    expect(oldOperationNamesIn(answer)).toEqual([]);
  });

  it('robots.txt の意思表示と食い違わない（検索は許し、学習は拒む）', () => {
    // **画面の文言と実装が食い違わないことを機械で照合する**（shared-ai-rules 12 章）。
    // FAQ は「検索の索引には載せてよい／回答に引用してよい／学習には使わないでほしい」と
    // 書いているので、正本の Content-Signal がそのとおりであることを確かめる。
    expect(CONTENT_SIGNAL).toContain('search=yes');
    expect(CONTENT_SIGNAL).toContain('ai-input=yes');
    expect(CONTENT_SIGNAL).toContain('ai-train=no');
    expect(answerOf('ai-training')).toContain('検索の索引には載せてよい／AI の回答に引用してよい');
  });

  it('権利の答えの直後に置く', () => {
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    expect(ids.indexOf('ai-training')).toBe(ids.indexOf('rights') + 1);
  });
});

describe('AI からの接続（#696 / MCP）', () => {
  /**
   * `wrangler.toml` の表（`[env.production.vars]` など）の中の値を読む。
   *
   * @param table 表の名前
   * @param key 鍵
   * @returns 値（無ければ null）
   */
  function productionVar(table: string, key: string): string | null {
    const lines = env.TEST_WRANGLER_TOML.split('\n');
    const start = lines.findIndex((line) => line.trim() === `[${table}]`);
    if (start < 0) {
      return null;
    }
    for (const line of lines.slice(start + 1)) {
      if (line.trim().startsWith('[')) {
        return null;
      }
      const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'u').exec(line.trim());
      if (match !== null) {
        return match[1]!;
      }
    }
    return null;
  }

  it('接続先の URL は、本番のアプリのホストの /mcp である（宣言と照合する）', () => {
    expect(MCP_SERVER_URL).toBe(`https://${productionVar('env.production.vars', 'APP_HOST')}/mcp`);
    expect(answerOf('ai-connect')).toContain(`<code>${MCP_SERVER_URL}</code>`);
  });

  it('つなぎ方（Claude Code のコマンドと claude.ai のカスタムコネクタ）・できないこと・許可の範囲・枠を書く', () => {
    const answer = answerOf('ai-connect');
    expect(answer).toContain(`<code>claude mcp add --transport http game-forge ${MCP_SERVER_URL}</code>`);
    expect(answer).toContain('カスタムコネクタ');
    // 実測で通ったクライアントだけを載せる（#724。Antigravity CLI 1.2.7 で 2026-09-21 に確認）。
    expect(answer).toContain(`<code>agy mcp add game-forge ${MCP_SERVER_URL}</code>`);
    expect(answer).toContain('公開・削除・退会はできません');
    // 同意画面の scope の名前と同じ綴りで、外せることを案内する。
    expect(answer).toContain(`「${OAUTH_SCOPE_LABELS[SCOPE_WORKS_GENERATE]!.name}」を外す`);
    expect(answer).toContain(`「${OAUTH_SCOPE_LABELS[SCOPE_WORKS_WRITE]!.name}」を外す`);
    expect(answer).toContain('作品名・説明・タグを書き換え');
    expect(answer).toContain('href="#quota"');
    expect(oldOperationNamesIn(answer)).toEqual([]);
    // 道具は 9 本のまま（増やしたら、ここの「できること」を見直す。#755 で update_my_work を足した）。
    expect(MCP_TOOL_NAMES).toHaveLength(9);
  });

  it('AI から読めるもの（自分の作品・公開作品の一覧と検索・作者の公開プロフィール）と、読めないもの（ほかの方のソース）を書く（#711）', () => {
    const answer = answerOf('ai-connect');
    for (const phrase of [
      'AI から読めるもの',
      '公開されている作品の一覧と検索',
      `href="${PUBLIC_WORKS_PATH}"`,
      '作者の公開プロフィール',
      'ほかの方の作品のソースは読めません',
    ]) {
      expect(answer, phrase).toContain(phrase);
    }
    // 公開作品を読む道具が実際にある（#711 で足した 2 本）。FAQ と道具の食い違いを見る。
    expect(MCP_TOOL_NAMES).toContain('list_public_works');
    expect(MCP_TOOL_NAMES).toContain('get_public_user');
    // 他人のソースを読む道具は無いまま（FAQ の「読めません」の裏づけ）。
    expect(MCP_TOOL_NAMES.filter((name) => name.includes('source'))).toEqual(['get_my_work_source']);
  });

  it('接続の解除と、許可が漏れたかもしれないときの手順を書く（#696 の constraints）', () => {
    const answer = answerOf('ai-connect');
    expect(answer).toContain(`href="${ACCOUNT_APPS_PATH}"`);
    expect(answer).toContain('「接続を解除」');
    expect(answer).toContain('許可が他人に渡ったかもしれないとき');
    expect(answer).toContain('30 日');
    expect(answer).toContain('1 年');
  });

  it('窓口の答えの直前に置く（窓口は最後の受け皿）', () => {
    const ids = FAQ_ENTRIES.map((entry) => entry.id);
    expect(ids.indexOf('ai-connect')).toBe(ids.indexOf('contact') - 1);
    expect(ids.at(-1)).toBe('contact');
  });
});

describe('ソースの再利用の項目（#696 の後日談）', () => {
  /** @returns ソースの再利用の項目 */
  function sourceReuse(): { id: string; question: string; answer: string } {
    const found = FAQ_ENTRIES.find((item) => item.id === 'source-reuse');
    expect(found, 'source-reuse の項目').toBeDefined();
    return found!;
  }

  it('読めること・サービス内の許諾・外での条件が無いこと・削除依頼の 4 つを書いている', () => {
    const answer = sourceReuse().answer;
    for (const phrase of [
      '公開した作品のソースコードは、誰でも読めます',
      'フォークして、できた作品を公開できます',
      '本サービスの外での再利用について、本サービスは条件を定めていません',
      TAKEDOWN_PATH,
    ]) {
      expect(answer, phrase).toContain(phrase);
    }
  });

  it('権利の項目（rights）へ案内している', () => {
    expect(sourceReuse().answer).toContain('#rights');
  });
});
