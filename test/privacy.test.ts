import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, SESSION_MAX_AGE } from '../src/auth/google.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from '../src/legal-paths.js';
import { PRIVACY_TITLE, privacyBody } from '../src/privacy.js';
import { dispatch } from '../src/routes.js';
import type { Route } from '../src/routes.js';
import { CONTACT_EMAIL, CONTACT_MAILTO, OPERATOR_NAME } from '../src/service-contact.js';
import { SESSION_COOKIE } from '../src/session.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * プライバシーポリシー（`/privacy`。2.3.1 v1.57 / #373）。
 *
 * **外枠（ヘッダ・パンくず・フッタ・幅）は `test/page-shell.test.ts` が経路表から導いて
 * 見る**ので、ここは本文だけを見る。
 */

/**
 * D1 に触ると投げる env。
 *
 * **静的な画面であることを、D1 を壊して確かめる**（#373 の constraints「D1 を読まない」）。
 * 読んでいれば 500 になる。
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
async function openPrivacy(): Promise<{ status: number; body: string }> {
  const routes: readonly Route[] = createAppRoutes(env);
  const res = await dispatch(
    routes,
    new Request(`https://app.example.invalid${PRIVACY_PATH}`),
    envWithoutD1(),
  );
  return { status: res.status, body: await res.text() };
}

describe('プライバシーポリシーの画面（#373）', () => {
  it('ログイン無しで、D1 を読まずに 200 で開く', async () => {
    const { status, body } = await openPrivacy();
    expect(status).toBe(200);
    expect(body).toContain(`<title>${PRIVACY_TITLE}</title>`);
  });

  it('scope.in の 6 項目が節としてある', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    // #373 の scope.in:「取得する情報、利用目的、第三者提供、Cookie とセッション、
    // 開示等の請求窓口、保存期間」
    for (const heading of ['取得する情報', '利用目的', '第三者への提供', 'Cookie', '開示', '保存期間']) {
      expect(body, `「${heading}」の節が無い`).toMatch(new RegExp(`<h2>[^<]*${heading}`, 'u'));
    }
  });

  it('専門家の確認を受けていないことが画面に出る', async () => {
    // **読む人が「確認済みのもの」と誤解しないようにする**（規約と同じ扱い。`src/legal.ts`）。
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain('暫定版');
    expect(body).toContain('法律の専門家による確認を受ける前');
  });
});

describe('事業者の名称と窓口は 1 か所から来る（#373）', () => {
  it('本番の画面は `src/service-contact.ts` の値を出す', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain(OPERATOR_NAME);
    expect(body).toContain(`href="${CONTACT_MAILTO}"`);
    expect(body).toContain(`>${CONTACT_EMAIL}<`);
  });

  it('値を差し替えると本文が追随する（直書きしていない）', () => {
    // **定数を変えても本文だけが古いまま緑になる形**を塞ぐ。本番の値が 1 つも残らないこと
    // まで見る。
    const body = privacyBody({
      operatorName: '差し替えた運営者',
      email: 'other@example.invalid',
      mailto: 'mailto:other@example.invalid',
    });
    expect(body).toContain('差し替えた運営者');
    expect(body).toContain('href="mailto:other@example.invalid"');
    expect(body).not.toContain(OPERATOR_NAME);
    expect(body).not.toContain(CONTACT_EMAIL);
  });

  it('名称と宛先はエスケープして出す', () => {
    const body = privacyBody({
      operatorName: '<b>運営</b>',
      email: 'a"b@example.invalid',
      mailto: 'mailto:a"b@example.invalid',
    });
    expect(body).not.toContain('<b>運営</b>');
    expect(body).not.toContain('a"b@');
  });

  it('窓口はメールアドレスの形である', () => {
    expect(CONTACT_MAILTO).toBe(`mailto:${CONTACT_EMAIL}`);
    // `test/page-shell.test.ts` が外枠の `mailto:` に課している形と同じ。
    expect(CONTACT_MAILTO).toMatch(/^mailto:[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/u);
  });
});

describe('書いてあるのは、いま実際に取得しているものだけである（#373 の constraints）', () => {
  it('M12 でこれから増える収集項目を先回りして書かない', async () => {
    // **「していない収集を書かない」を機械で見る。** 収集を始める issue（M12-11 / M12-12 /
    // 作品の説明）は、実装と同じ変更でこの一覧から語を外し、本文へ追記すること。
    // **作品の説明は #388 が収集を始め、この一覧から外して本文へ足した**（下の it）。
    const body = pageBodyOf((await openPrivacy()).body);
    for (const notYet of ['アイコン', '自己紹介', '外部リンク', 'プレイ数', 'ハンドル']) {
      expect(body, `まだ収集していない「${notYet}」が書いてある`).not.toContain(notYet);
    }
    // 2.3.14 が「収集しない」と決めたもの。
    for (const never of ['誕生', '性別']) {
      expect(body, `収集しないと決めた「${never}」が書いてある`).not.toContain(never);
    }
  });

  it('作品の説明を、取得する情報と公開される情報の両方に書く（#388）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。説明は作者が公開済みの作品に書き、
    // 作品ページで誰でも見られ、履歴（`description_changes`）を追記だけで D1 に残す。
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    expect(collected).toContain('<strong>作品の説明</strong>');
    expect(collected).toContain('作品ページで誰でも見られます');
    expect(collected).toContain('追記だけで残します');
    expect(collected).toContain('D1');
    const published = body.slice(
      body.indexOf('3. 公開される情報'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(published).toContain('作者が書いた説明');
  });

  it('Cookie の有効期間は、発行する側の定数と一致する', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain(`有効期間は ${SESSION_MAX_AGE / (60 * 60 * 24)} 日です。`);
    expect(body).toContain(`有効期間は ${OAUTH_COOKIE_MAX_AGE / 60} 分です。`);
    // 本文が「2 つだけ」と言っている cookie は、この 2 つである。**名前を足した日に、
    // 本文の数も見直すこと。**
    expect([SESSION_COOKIE, OAUTH_COOKIE]).toEqual(['__Host-gf_session', '__Host-gf_oauth']);
    expect(body).toContain('Cookie は次の 2 つだけです');
  });

  it('外部の委託先を書き漏らさない', async () => {
    // 実在は `src/privacy.ts` の冒頭の表で確かめた（wrangler.toml / terraform/ / src/）。
    const body = pageBodyOf((await openPrivacy()).body);
    for (const service of ['Cloudflare', 'Amazon Web Services', 'Amazon Bedrock', 'Guardrails', 'Google', 'Resend']) {
      expect(body, `${service} が書かれていない`).toContain(service);
    }
  });

  it('保存期間は、宣言にある保持期間と食い違わない', async () => {
    // **AWS のログをひとまとめに「14 日」と書かない。** 生成・ビルド・撮影は 14 日、
    // 費用ガードは 30 日である（`terraform/*.tf` の `retention_in_days`。PR #400 の
    // Copilot の指摘）。
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).not.toContain('AWS 上の処理の記録（ログ）は、14 日');
    expect(body).toContain('作品の生成・ビルド・紹介用の画像の撮影の記録は 14 日');
    expect(body).toContain('費用の上限を監視する処理の記録は 30 日');
    expect(body).toContain('90 日を目安に削除');
  });

  it('第三者への提供の節は、法的な区分を断定せず、外部への送信と矛盾しない', async () => {
    // **委託か外国にある第三者への提供かは専門家が決めること**（PR #400 の Copilot の指摘）。
    // 「同意なく提供しません」と断定しながら次の節で外部への送信を並べる形に戻さない。
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).not.toContain('同意なく');
    expect(body).toContain('本サービスを動かすために、下の 5 に書いた事業者へ、そこに書いた情報を送っています');
    expect(body).toContain('正式公開までに専門家の確認を受け');
  });

  it('未公開の作品でも、URL を知っている人には題名が見えると書く', async () => {
    // `src/work-page.ts` の `readySection` は、本人以外にも題名と未公開の旨を返す。
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain('公開する前の作品でも、作品ページの URL を知っている人がそのページを開くと、題名と');
  });

  it('アクセス解析を使っていると書かない（使っていない）', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain('アクセス解析や広告のための Cookie・外部のスクリプトは使っていません');
  });

  it('関連する画面へ辿れる', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    for (const path of [TERMS_PATH, TAKEDOWN_PATH, FAQ_PATH]) {
      expect(body, `${path} へのリンクが無い`).toContain(`href="${path}"`);
    }
  });
});
