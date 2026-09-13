import { AVATAR_HISTORY_RETENTION_DAYS, AVATAR_OUTPUT_SIZE } from '../src/avatar.js';
import { HANDLE_RESERVATION_DAYS } from '../src/handle.js';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, SESSION_MAX_AGE } from '../src/auth/google.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from '../src/legal-paths.js';
import { PLAY_REPORT_WINDOW_MS } from '../src/plays.js';
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
    // **作品の説明は #388 が、自己紹介と外部リンクは #379 が収集を始め、この一覧から外して
    // 本文へ足した**（下の it）。
    const body = pageBodyOf((await openPrivacy()).body);
    // **プレイ数は #377 が数え始め、この一覧から外して本文へ足した**（下の it）。
    // **アイコンは #380 が収集を始め、この一覧から外して本文へ足した**（下の it）。
    // **ハンドル名は #381 が収集を始め、この一覧から外して本文へ足した**（下の it）。M12 で先回りして
    // 書く恐れのある語は、これで残っていない（一覧は空になった）。
    const notYetCollected: readonly string[] = [];
    for (const notYet of notYetCollected) {
      expect(body, `まだ収集していない「${notYet}」が書いてある`).not.toContain(notYet);
    }
    // 2.3.14 が「収集しない」と決めたもの。
    for (const never of ['誕生', '性別']) {
      expect(body, `収集しないと決めた「${never}」が書いてある`).not.toContain(never);
    }
  });

  it('アイコンの画像・メタデータを落とすこと・前の画像の保存期間・変更の履歴を書く（#380）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。**日数と大きさは実装の値の写しなので、実装と照合する**。
    const body = pageBodyOf((await openPrivacy()).body);
    const entered = body.slice(body.indexOf('利用者が登録・入力する情報'), body.indexOf('利用に伴って記録する情報'));
    expect(entered).toContain('<strong>アイコンの画像</strong>');
    expect(entered).toContain(`${AVATAR_OUTPUT_SIZE} ピクセル四方の WebP に作り直した`);
    expect(entered).toContain('元のファイルは保存せず');
    expect(entered).toContain('Exif などのメタデータ');
    expect(entered).toContain('アイコンの変更の履歴');
    expect(entered).toContain(`前の画像（${AVATAR_HISTORY_RETENTION_DAYS} 日間だけ保存します）`);
    const published = body.slice(body.indexOf('3. 公開される情報'), body.indexOf('4. 第三者への提供'));
    expect(published).toContain('アイコンの画像（作者ページ・作品の一覧・ヘッダに表示されます）');
    expect(published).toContain('差し替える前・外す前のアイコンの画像とアイコンの変更の履歴');
    const services = body.slice(body.indexOf('5. 外部のサービスの利用'), body.indexOf('6. Cookie'));
    expect(services).toContain('アイコンの画像の作り直し');
    const retention = body.slice(body.indexOf('7. 保存期間'), body.indexOf('8. 開示'));
    expect(retention).toContain(`差し替えた・外した日から ${AVATAR_HISTORY_RETENTION_DAYS} 日で自動的に削除されます`);
    expect(retention).toContain('いまのアイコンと前の画像の両方を削除します');
  });

  it('ハンドル名・転送で前後が同じ人だと分かること・予約の日数・変更の履歴を書く（#381）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。**日数は実装の値の写しなので、実装と照合する**。
    const body = pageBodyOf((await openPrivacy()).body);
    const entered = body.slice(body.indexOf('利用者が登録・入力する情報'), body.indexOf('利用に伴って記録する情報'));
    expect(entered).toContain('<strong>ハンドル名</strong>');
    expect(entered).toContain(`前のハンドル名を ${HANDLE_RESERVATION_DAYS} 日間ほかの方が使えないように残し`);
    expect(entered).toContain('ほかの方がそのハンドル名を使うまではデータベースに残ります');
    expect(entered).toContain('<strong>ハンドル名の変更の履歴</strong>');
    const published = body.slice(body.indexOf('3. 公開される情報'), body.indexOf('4. 第三者への提供'));
    expect(published).toContain('前と後のハンドル名が同じ方のものだと分かります');
    expect(published).toContain('ハンドル名の変更の履歴');
  });

  it('プレイ数を、利用者と結び付けずに数えることと、sessionStorage に置く時刻を書く（#377）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。プレイ数は作品ごとの起動回数で、誰が遊んだかを
    // 記録しない（`workers/likes/src/play-hub.ts` の表に利用者の列が無い）。連打を畳むために、作品ページの
    // スクリプトがブラウザの sessionStorage に作品ごとの最終計上時刻を置き、サーバへは送らない
    // （`src/plays.ts` の `playReportScript` は `credentials: 'omit'` で、本文は作品 id だけ）。
    const body = pageBodyOf((await openPrivacy()).body);
    const recorded = body.slice(body.indexOf('利用に伴って記録する情報'), body.indexOf('ログインせずに送っていただく情報'));
    expect(recorded).toContain('<strong>プレイ数</strong>');
    expect(recorded).toContain('誰が遊んだかとは結び付けずに数え');
    expect(recorded).toContain('ログインしていない方の起動も同じく数えます');
    const published = body.slice(
      body.indexOf('3. 公開される情報'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(published).toContain('いいねの数とプレイ数');
    const cookie = body.slice(body.indexOf('6. Cookie'), body.indexOf('7. 保存期間'));
    expect(cookie).toContain('sessionStorage');
    expect(cookie).toContain('作品ごとに最後に数えた時刻');
    expect(cookie).toContain('サーバへは送らず');
    // **窓の長さは実装の値の写しなので、実装と照合する**（shared-ai-rules 12 章）。
    expect(cookie).toContain(`${PLAY_REPORT_WINDOW_MS / 60_000} 分以内は数え直しません`);
    // **Cookie は 2 つのまま**（sessionStorage は Cookie ではない）。
    expect(cookie).toContain('Cookie は次の 2 つだけです');
    const retention = body.slice(body.indexOf('7. 保存期間'), body.indexOf('8. 開示'));
    expect(retention).toContain('sessionStorage に置く時刻は、タブを閉じると消えます');
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

  it('自己紹介と外部リンクとその変更の履歴を、取得する情報・公開される情報・公開しない情報に書く（#379）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。自己紹介と外部リンクは `/account` で
    // 設定し、作者ページで誰でも見られる。履歴（`profile_changes`）は追記だけで D1 に残し、
    // 公開しない。**どの記述が消えても赤くなるように、項目の行ごとに語を見る。**
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    const lineOf = (heading: string): string => {
      const start = collected.indexOf(`<strong>${heading}</strong>`);
      expect(start, `取得する情報に「${heading}」の項目が無い`).toBeGreaterThanOrEqual(0);
      const rest = collected.slice(start);
      return rest.slice(0, rest.indexOf('</li>'));
    };
    const profile = lineOf('自己紹介と外部リンク');
    expect(profile).toContain('3 本まで');
    expect(profile).toContain('作者ページで誰でも見られます');
    expect(profile).toContain('D1');
    const history = lineOf('自己紹介と外部リンクの変更の履歴');
    expect(history).toContain('変える前と後の自己紹介と外部リンクと、変えた日時');
    expect(history).toContain('公開しません');
    expect(history).toContain('追記だけで残します');
    expect(history).toContain('D1');

    const published = body.slice(
      body.indexOf('3. 公開される情報'),
      body.indexOf('<strong>次の情報は公開しません。</strong>'),
    );
    expect(published).toContain('自己紹介と外部リンク（作者ページに表示されます');
    expect(published).toContain('運営者はリンク先がその人のものかを確認していません');
    const notPublished = body.slice(
      body.indexOf('<strong>次の情報は公開しません。</strong>'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(notPublished).toContain('自己紹介と外部リンクの変更の履歴');
  });

  it('メール配信の設定を、取得する情報・利用目的・公開しない情報に書く（#384）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。設定は `/account/mail` で変え、
    // `users.fork_notice_muted_at` に止めた日時を D1 に残し、公開しない。**止められるのは改造の
    // お知らせだけで、生成の完了・失敗は止められない**（5.11 / `src/mail/kinds.ts`）——画面と
    // 食い違わないように、利用目的の側でも言い分ける。
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    const start = collected.indexOf('<strong>メール配信の設定</strong>');
    expect(start, '取得する情報に項目が無い').toBeGreaterThanOrEqual(0);
    const rest = collected.slice(start);
    const line = rest.slice(0, rest.indexOf('</li>'));
    expect(line).toContain('作品が改造されたときのお知らせを受け取るかどうかと、受け取らない設定にした日時');
    expect(line).toContain('公開しません');
    expect(line).toContain('D1');

    const purposes = body.slice(body.indexOf('2. 利用目的'), body.indexOf('3. 公開される情報'));
    expect(purposes).toContain('作品が改造されたことのお知らせは、登録情報の画面で受け取らない設定にできます');
    expect(purposes).toContain('生成の完了・失敗のお知らせは、その設定にかかわらず送ります');

    const notPublished = body.slice(
      body.indexOf('<strong>次の情報は公開しません。</strong>'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(notPublished).toContain('メール配信の設定');
  });

  it('表示名の変更の履歴を、取得する情報に書き、公開しない情報にも挙げる（#405）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。履歴は `/account` での変更と Google の
    // 名前への追随の両方で積み（`migrations/0030`）、運営が審査キューで確かめるだけで公開しない。
    // **どの記述が消えても赤くなるように、語を 1 つずつ見る**（PR #413 の Copilot レビュー）。
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    const item = collected.slice(collected.indexOf('<strong>表示名の変更の履歴</strong>'));
    expect(item, '取得する情報に項目が無い').toContain('<strong>表示名の変更の履歴</strong>');
    const line = item.slice(0, item.indexOf('</li>'));
    expect(line).toContain('変える前と後の表示名と、変えた日時');
    expect(line).toContain('Google アカウントの名前に合わせて表示名が変わった場合も残します');
    expect(line).toContain('公開しません');
    expect(line).toContain('追記だけで残します');
    expect(line).toContain('D1');
    const notPublished = body.slice(
      body.indexOf('<strong>次の情報は公開しません。</strong>'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(notPublished).toContain('表示名の変更の履歴');
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
    // アイコンの作り直し（#380）のロググループも 14 日（`terraform/avatar-function.tf`）。
    expect(body).toContain('作品の生成・ビルド・紹介用の画像の撮影・アイコンの画像の作り直しの記録は 14 日');
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
