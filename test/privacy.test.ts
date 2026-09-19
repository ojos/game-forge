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
import {
  ACCESS_TOKEN_TTL_SECONDS,
  PENDING_AUTHORIZATION_COOKIE,
  PENDING_AUTHORIZATION_MAX_AGE_SECONDS,
  GRANT_IDLE_LIMIT_SECONDS,
  GRANT_MAX_AGE_SECONDS,
} from '../src/oauth-paths.js';
import { oldOperationNamesIn } from './helpers/old-names.js';
import { WITHDRAWN_DISPLAY_NAME } from '../src/withdrawal.js';
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

  it('暫定版の但し書きはブロックである（仕様 2.5.3 / #471）', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain(
      '<p class="gf-block gf-draft-notice"><strong>このプライバシーポリシーはクローズドβ向けの暫定版です。</strong>',
    );
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
    // **sessionStorage は Cookie に数えない**（Cookie の数は #696 で 3 つになった。下の it）。
    expect(cookie).toContain('Cookie は次の 3 つだけです');
    const retention = body.slice(body.indexOf('7. 保存期間'), body.indexOf('8. 開示'));
    expect(retention).toContain('sessionStorage に置く時刻は、タブを閉じると消えます');
  });

  it('作品の説明を、取得する情報と公開される情報の両方に書く（#388）', async () => {
    // **収集を始めた変更で書く**（#373 の constraints）。説明は作者が書き（#673 からは下書きのうちから）、
    // 公開すると作品ページで誰でも見られ、履歴（`description_changes`）を追記だけで D1 に残す。
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    expect(collected).toContain('<strong>作品の説明</strong>');
    expect(collected).toContain('作品ページで誰でも見られます');
    // **下書きのあいだは作者にだけ見える**（#673。下書きのうちから D1 に保存する実装と食い違わせない）。
    expect(collected).toContain('下書きのあいだは作者にだけ見え');
    expect(collected).not.toContain('公開済みの作品に書く説明');
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
    expect(line).toContain('作品がフォークされたときのお知らせを受け取るかどうかと、受け取らない設定にした日時');
    expect(line).toContain('公開しません');
    expect(line).toContain('D1');

    const purposes = body.slice(body.indexOf('2. 利用目的'), body.indexOf('3. 公開される情報'));
    expect(purposes).toContain('作品がフォークされたことのお知らせは、登録情報の画面で受け取らない設定にできます');
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
    expect(body).toContain(`有効期間は ${PENDING_AUTHORIZATION_MAX_AGE_SECONDS / 60} 分です。`);
    // 本文が「3 つだけ」と言っている cookie は、この 3 つである。**名前を足した日に、
    // 本文の数も見直すこと。**（3 つ目は #696 の AI アプリとの接続の手続き中の cookie）
    expect([SESSION_COOKIE, OAUTH_COOKIE, PENDING_AUTHORIZATION_COOKIE]).toEqual([
      '__Host-gf_session',
      '__Host-gf_oauth',
      '__Host-gf_mcp_authz',
    ]);
    expect(body).toContain('Cookie は次の 3 つだけです');
    // 3 つ目（#696）の用途・中身・署名・消す時期を書く。
    const cookie = body.slice(body.indexOf('6. Cookie'), body.indexOf('7. 保存期間'));
    const line = cookie.slice(cookie.indexOf('AI アプリとの接続の手続き中の情報'));
    expect(line).toContain('ログインしていない状態で AI アプリとの接続を始めたとき');
    expect(line).toContain('アプリの識別子・許可した後の戻り先・求めている範囲');
    expect(line).toContain('改ざんを検知できる形');
    expect(line).toContain('ログインから戻ると消します');
    expect(line.slice(0, line.indexOf('</li>'))).toContain(`有効期間は ${PENDING_AUTHORIZATION_MAX_AGE_SECONDS / 60} 分です`);
  });

  it('AI アプリとの接続を、取得する情報・利用目的・公開しない情報・保存期間・退会に書く（#696）', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    const collected = body.slice(body.indexOf('1. 取得する情報'), body.indexOf('2. 利用目的'));
    const line = collected.slice(collected.indexOf('AI アプリとの接続'));
    expect(line).toContain('接続したアプリの名前');
    expect(line).toContain('許可した後の戻り先');
    expect(line).toContain('許可した範囲');
    expect(line).toContain('接続した日時');
    // **トークンはハッシュでだけ保存する**（部品の保存の形。`src/oauth-provider.ts`）。
    expect(line).toContain('鍵そのものは保存せず、照合に使う値（ハッシュ値）だけを保存します');
    expect(line).toContain('接続中のアプリ');
    expect(line).toContain('KV');
    // 1 日の上限を判定するための回数（#696 のセキュリティレビュー。`migrations/0048_oauth_daily_usage.sql`）。
    const usage = body.slice(body.indexOf('AI アプリとの接続の操作回数'));
    expect(usage.slice(0, usage.indexOf('</li>'))).toContain('2 日で削除します');
    const purposes = body.slice(body.indexOf('2. 利用目的'), body.indexOf('3. 公開される情報'));
    expect(purposes).toContain('AI アプリ');
    const notPublished = body.slice(
      body.indexOf('<strong>次の情報は公開しません。</strong>'),
      body.indexOf('4. 第三者への提供'),
    );
    expect(notPublished).toContain('接続した AI アプリ');
    const retention = body.slice(body.indexOf('<h2>7. 保存期間</h2>'), body.indexOf('<h2>8. '));
    // 寿命は発行する側の定数と照合する（本文へ数字を書き写さない）。
    expect(retention).toContain(`最後に使ってから ${GRANT_IDLE_LIMIT_SECONDS / 86400} 日で使えなくなります`);
    expect(retention).toContain(`許可した日から ${GRANT_MAX_AGE_SECONDS / (86400 * 365)} 年で失効します`);
    expect(retention).not.toContain('使っていても延びません');
    expect(retention).toContain(`${ACCESS_TOKEN_TTL_SECONDS / 60} 分で失効します`);
    expect(retention).toContain('解除すると、その時点で削除します');
    const withdrawn = retention.slice(retention.indexOf('退会すると、次の情報を削除します'));
    expect(withdrawn.slice(0, withdrawn.indexOf('退会しても、次の情報は残します'))).toContain('AI アプリとの接続');
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

  it('未公開の作品は、URL を知っている人にも未公開であることだけが見えると書く（題名は見えない。#690）', async () => {
    // `src/work-page.ts` の `unpublishedSection` は、本人以外には未公開であることだけを返し、`loadWorkView` は作者以外に
    // 未公開の作品の題名を渡さない（#150 から）。**旧記述は「題名と、まだ公開されていないことが表示されます」で、
    // 実際より多く書いていた**（#690 で FAQ と一緒に正した）。
    const body = pageBodyOf((await openPrivacy()).body);
    expect(body).toContain(
      '公開する前の作品は、作品ページの URL を知っている人がそのページを開いても、まだ公開されていないことだけが表示されます（題名は表示されず、遊ぶこともできません）。',
    );
    expect(body).not.toContain('題名と、まだ公開されていないことが表示されます');
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

describe('旧い呼び名（改造・推敲・手直し）を出さない（#513）', () => {
  it('画面の出力に旧い呼び名が出ず、フォーク・リフォージと書く（表記の変更だけで、意味は変えていない）', async () => {
    const { body } = await openPrivacy();
    expect(oldOperationNamesIn(body)).toEqual([]);
    expect(body).toContain('作品の生成・フォーク・リフォージ・公開・表示を行うため');
    expect(body).toContain('フォーク元の作品');
  });
});

describe('作者による作品の削除（#517）', () => {
  it('保存期間の節に、作品を削除すると消えるもの・残るもの・残す理由を書く', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    const retention = body.slice(body.indexOf('<h2>7. 保存期間</h2>'), body.indexOf('<h2>8. '));
    expect(retention).toContain('作品は、作者が作品ページから削除すると削除します。');
    expect(retention).toContain('公開中の作品は、公開をやめて下書きに戻してから削除できます');
    expect(retention).toContain('生成されたソースコード・遊ぶためのファイル・紹介用の画像と、リフォージの前の版を削除します');
    // 行を残す 2 つの場合（`src/game-deletion.ts` の「行を残すのは、次のどちらかがあるとき」）。
    expect(retention).toContain('その作品をフォークした作品があるとき');
    expect(retention).toContain('通報・削除依頼・運営者の措置・入力の検査の記録がその作品にあるとき');
    // 生成の記録は作品と結び付けていない（確定27）ので、作品を消しても残る。
    expect(retention).toContain('作品を作るときの指示文と生成の記録は削除しません');
    // #694: 作品と結び付けて保存した指示文（`games.prompt`）は、作品と一緒に消える。
    expect(retention).toContain('作品と結び付けて保存した指示文も、作品と一緒に削除します');
  });
});

describe('退会（#518 / M15-3）', () => {
  it('保存期間の節に、退会の機能・消える情報・残る情報と理由・消せないものを書く', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    const retention = body.slice(body.indexOf('<h2>7. 保存期間</h2>'), body.indexOf('<h2>8. '));

    // 機能そのもの（#373 の constraints「していない収集を書かない」の裏で、**できることは書く**）。
    expect(retention).toContain('利用者はご自身で退会できます');
    expect(retention).toContain('退会は取り消せません');
    expect(retention).toContain('新しい招待コードが必要です');

    // 消える情報。**表示名の代わりの値は実装の定数と照合する**（shared-ai-rules 12 章）。
    expect(retention).toContain('退会すると、次の情報を削除します');
    expect(retention).toContain(WITHDRAWN_DISPLAY_NAME);
    expect(retention).toContain('変更の履歴');
    expect(retention).toContain('待機リスト');

    // 残る情報と理由。
    expect(retention).toContain('退会しても、次の情報は残します');
    expect(retention).toContain('他の利用者の招待枠の計算や、対応済みの通報の確かめができなくなる');
    expect(retention).toContain('1 人あたりの生成枠とサービス全体の費用の上限を管理するために残します');
    expect(retention).toContain(`${HANDLE_RESERVATION_DAYS} 日のあいだ、ほかの方が使えません`);

    // 消せないもの（#518 の constraints）。**隠さない。**
    expect(retention).toContain('次のものは、退会しても消せません');
    expect(retention).toContain('最大 1 年');
  });

  it('「退会する機能がありません」という旧い案内が残っていない', async () => {
    const { body } = await openPrivacy();
    expect(body).not.toContain('退会する機能がありません');
  });

  it('作品の削除では指示文が残り、退会では消えることを、同じ節で書き分ける（利用者の決定）', async () => {
    // **#517 が書いた「作品を削除しても指示文と生成の記録は削除しません」は正しいまま。**
    // 退会だけが例外であることを、同じ場所で書き足す（食い違いを残さない）。
    const body = pageBodyOf((await openPrivacy()).body);
    const retention = body.slice(body.indexOf('<h2>7. 保存期間</h2>'), body.indexOf('<h2>8. '));
    // #694 で「生成の記録に残る、」を足した（作品と結び付けた写しは作品と一緒に消えるため）。
    expect(retention).toContain('作品を削除しても、生成の記録に残る、作品を作るときの指示文と生成の記録は削除しません');
    expect(retention).toContain('退会したときだけは指示文を削除します');
  });

  it('開示などの請求の節が、退会した後の本人確認を書く', async () => {
    const body = pageBodyOf((await openPrivacy()).body);
    const requests = body.slice(body.indexOf('<h2>8. '), body.indexOf('<h2>9. '));
    expect(requests).toContain('本サービスに登録しているメールアドレスからお送りください');
    expect(requests).toContain('退会した後にご請求される場合は、この方法で確かめられません');
    expect(requests).toContain('お応えできないことがあります');
  });
});
