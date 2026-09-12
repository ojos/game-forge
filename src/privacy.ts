/**
 * プライバシーポリシー（`/privacy`。2.3.1 v1.57 / M12-5 / #373）。
 *
 * ## 書くのは「いま実際に取得・保存しているもの」だけである
 *
 * #373 の constraints は「**書いていない収集をしないのと同じくらい、していない収集を
 * 書かないことが要る**」と定めている。**M12 でこれから増える項目（アイコン・自己紹介・
 * 外部リンク・作品の説明）は、ここへ先回りして書かない。** 収集を始める issue が、
 * 同じ変更の中でこの本文へ追記する。
 *
 * 各項目が実在することは、2026-09-12 に次の場所で確かめた（PR #373 の本文にも一覧を置く）。
 *
 * | 本文の項目 | 確かめた場所 |
 * |---|---|
 * | Google の識別子・メールアドレス・名前 | `src/auth/google.ts`（scope `openid email profile`、`users` への insert）/ `migrations/0001_init.sql` |
 * | 表示名 | `src/account.ts` / `migrations/0022_*` |
 * | 招待関係 | `migrations/0001_init.sql`（`invites` / `users.invited_by`）/ `src/invites.ts` |
 * | 指示文・生成の記録 | `src/cost-ledger.ts`（`generations.prompt`）/ `migrations/0009_game_revisions.sql` |
 * | 遮断された指示文（90 日） | `migrations/0016_moderation_blocks.sql` / `scripts/moderation-prune.sh` |
 * | 作品・題名の変更履歴 | `migrations/0001_init.sql`（`games`）/ `migrations/0027_title_changes.sql` / R2 |
 * | いいね・1 日の操作回数 | `workers/likes/src/hub.ts`（Durable Object の `likes` / `daily_ops`） |
 * | 通報 | `src/reports.ts` / `migrations/0001_init.sql`（`reports`） |
 * | 待機リスト | `src/waitlist.ts` / `migrations/0001_init.sql`（`waitlist`） |
 * | 削除申請 | `src/takedown.ts` / `migrations/0018_takedown_requests.sql` |
 * | 運営の措置の記録 | `migrations/0026_admin_actions.sql` |
 * | Cookie 2 種 | `src/session.ts`（`__Host-gf_session`、7 日）/ `src/auth/google.ts`（`__Host-gf_oauth`、10 分） |
 * | AWS 上の処理の記録（14 日） | `terraform/orchestrator.tf` / `terraform/build-function.tf` / `terraform/ogp-function.tf` の `retention_in_days` |
 * | 外部サービス | Cloudflare（`wrangler.toml`）/ AWS・Bedrock・Guardrails（`terraform/bedrock.tf` / `terraform/moderation.tf` / `src/generation-models.ts`）/ Google（`src/auth/google.ts`）/ Resend（`src/mail/resend.ts`） |
 *
 * **アクセス解析・広告は使っていない**（外部のスクリプトも解析の cookie も無い）。**使い始めた
 * 日に、この本文の「Cookie」の節も書き換えること。**
 *
 * ## 法的助言ではない
 *
 * `src/legal.ts` の規約と同じく、**書いたのは弁護士ではない。** 画面にも但し書きを出す。
 * **事業者の名称は暫定である**（`src/service-contact.ts` の `OPERATOR_NAME`。正式名称へ差し替えが
 * 必要。住所と代表者はまだ書いていない）。
 *
 * ## D1 を読まない
 *
 * 静的な画面である（#373 の constraints）。読むのはヘッダの出し分けのための cookie だけ。
 */
import { siteFooter } from './legal.js';
import { FAQ_PATH, PRIVACY_PATH, TAKEDOWN_PATH, TERMS_PATH } from './legal-paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import type { SiteViewer } from './html.js';
import { escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { CONTACT_EMAIL, CONTACT_MAILTO, OPERATOR_NAME } from './service-contact.js';
import { OAUTH_COOKIE_MAX_AGE, SESSION_MAX_AGE } from './auth/google.js';

/** 画面の `<title>`（パンくずの末尾にもこの名前が出る）。 */
export const PRIVACY_TITLE = 'プライバシーポリシー - Game Forge';

/**
 * プライバシーポリシーの本文に使う値。
 *
 * **引数で受ける**のは、名称や宛先を差し替えたときに本文がそれに追随することを、
 * テストが別の値を渡して確かめられるようにするためである（値を本文へ直書きすると、
 * 定数を変えても本文だけが古いまま緑になる）。
 */
export interface PrivacyContact {
  /** 事業者の名称。 */
  readonly operatorName: string;
  /** 窓口のメールアドレス。 */
  readonly email: string;
  /** 窓口へのリンク（`mailto:`）。 */
  readonly mailto: string;
}

/** 本番で使う値（`src/service-contact.ts`）。 */
const SERVICE_PRIVACY_CONTACT: PrivacyContact = {
  operatorName: OPERATOR_NAME,
  email: CONTACT_EMAIL,
  mailto: CONTACT_MAILTO,
};

/**
 * プライバシーポリシーの本文を組み立てる。
 *
 * @param contact 事業者の名称と窓口
 * @returns HTML（外枠を含まない）
 */
export function privacyBody(contact: PrivacyContact): string {
  const operator = escapeHtml(contact.operatorName);
  const mail = `<a href="${escapeHtml(contact.mailto)}">${escapeHtml(contact.email)}</a>`;
  // 寿命の正本は発行する側（`src/auth/google.ts`）である。本文へ数字を書き写さない。
  const sessionDays = Math.round(SESSION_MAX_AGE / (60 * 60 * 24));
  const oauthMinutes = Math.round(OAUTH_COOKIE_MAX_AGE / 60);
  return `<div class="gf-legal">
<h1>プライバシーポリシー</h1>
<p class="gf-draft-notice"><strong>このプライバシーポリシーはクローズドβ向けの暫定版です。</strong>
   法律の専門家による確認を受ける前の文面であり、正式公開までに変更されることがあります。</p>

<p>${operator}（以下「運営者」）は、Game Forge（以下「本サービス」）における利用者の情報の
   取り扱いを、次のとおり定めます。</p>

<h2>1. 取得する情報</h2>
<p><strong>本サービスが取得・保存している情報は、次のものだけです。</strong></p>

<h3>Google アカウントでのログイン時に受け取る情報</h3>
<ul>
  <li>Google アカウントの識別子（利用者を同じ人として見分けるために使います）</li>
  <li>メールアドレス（Google が確認済みのものに限ります）</li>
  <li>Google アカウントに設定された名前（表示名の最初の値として使います）</li>
</ul>
<p>パスワードは受け取りません。プロフィール画像など、上に挙げた以外の Google アカウントの情報は保存しません。</p>

<h3>利用者が登録・入力する情報</h3>
<ul>
  <li><strong>表示名</strong>（登録情報の画面で変更できます）</li>
  <li><strong>招待の情報</strong>: 招待コード、誰が誰を招待したか、コードを使った日時</li>
  <li><strong>作品を作るときの指示文</strong>（生成・改造・推敲の指示）</li>
  <li><strong>作品</strong>: 題名とその変更履歴、生成されたソースコード、遊ぶためのファイル、紹介用の画像、公開・取り下げの状態、改造元の作品</li>
  <li><strong>いいね</strong>: どの作品にいいねしたかと、その日時</li>
  <li><strong>通報</strong>: 通報した作品と、書いていただいた理由</li>
</ul>

<h3>利用に伴って記録する情報</h3>
<ul>
  <li><strong>生成の記録</strong>: 日時、使ったモデル、処理した文字量（トークン数）、費用、成否</li>
  <li><strong>入力の検査で止めた指示文</strong>と、止めた理由の分類</li>
  <li><strong>いいねの操作回数</strong>（1 日の上限を判定するため）</li>
  <li><strong>登録日時</strong>、および運営者が行った措置（利用停止など）とその理由</li>
  <li><strong>処理の記録（ログ）</strong>: 障害を調べるための、作品の識別子や処理の結果</li>
</ul>
<p>本サービスは、閲覧した画面の履歴・IP アドレス・ブラウザの種類を、自らのデータベースへ保存していません。</p>

<h3>ログインせずに送っていただく情報</h3>
<ul>
  <li><strong>待機リスト</strong>: メールアドレスと、どの画面から登録したか</li>
  <li><strong>削除申請</strong>（<a href="${TAKEDOWN_PATH}">権利者の方へ</a>）: お名前または団体名、ご連絡先、申請の内容</li>
  <li><strong>お問い合わせ</strong>: メールでお送りいただいた内容と、送信元のメールアドレス</li>
</ul>

<h2>2. 利用目的</h2>
<ul>
  <li>ログインの状態を保ち、利用者を見分けるため</li>
  <li>作品の生成・改造・推敲・公開・表示を行うため</li>
  <li>1 人あたりの生成枠と、サービス全体の費用の上限を管理するため</li>
  <li>生成の完了・失敗や、作品が改造されたことを、メールでお知らせするため</li>
  <li>招待の仕組みを運用し、待機リストに登録された方へ招待についてご連絡するため</li>
  <li>不正な利用や規約に反する内容を防ぎ、通報・削除申請に対応するため</li>
  <li>お問い合わせに回答するため</li>
  <li>障害の調査と、利用状況の集計によるサービスの改善のため</li>
</ul>

<h2>3. 公開される情報と、公開されない情報</h2>
<p><strong>次の情報は、ログインしていない人を含め、誰でも見られます。</strong></p>
<ul>
  <li>表示名（作者ページや、公開した作品の作者名として表示されます）</li>
  <li>公開した作品（題名・遊べる形・紹介用の画像・改造元の作品）と、そのいいねの数</li>
</ul>
<p>作品の題名は、最初は指示文から作られます。題名は作品ページで変えられます。</p>
<p>公開した作品のソースコードは、他の利用者がその作品を改造するときに、生成の材料として使われます。</p>
<p><strong>次の情報は公開しません。</strong>メールアドレス、指示文、いいねした作品の一覧、
   誰が誰を招待したか、通報の内容。</p>

<h2>4. 第三者への提供</h2>
<p>運営者は、法令に基づく場合を除き、利用者の同意なく個人情報を第三者へ提供しません。
   上の「公開される情報」は、利用者が作品を公開したり表示名を設定したりすることで公開されるものです。</p>

<h2>5. 外部のサービスの利用</h2>
<p>本サービスは、次の事業者のサービスを使って運営しています。
   <strong>それぞれに、下に書いた情報が送られ、または保存されます。</strong></p>
<ul>
  <li><strong>Cloudflare</strong>: 本サービスの配信（ホスティング）と、データベース・ファイル・いいねの記録の保存。上の 1 に挙げた情報の主な保存先です。</li>
  <li><strong>Amazon Web Services（AWS）</strong>: 作品の生成・ビルド・紹介用の画像の撮影を行う処理の実行。
    <ul>
      <li>生成には <strong>Amazon Bedrock</strong>（Anthropic 社の Claude モデル）を使います。指示文と、改造・推敲のときは元の作品のソースコードを送ります。</li>
      <li>指示文は、生成の前に <strong>Amazon Bedrock Guardrails</strong> で有害な内容かどうかを検査します。この検査は、アジア太平洋地域の複数のリージョンで処理されることがあります。</li>
    </ul>
  </li>
  <li><strong>Google</strong>: Google アカウントによるログイン。</li>
  <li><strong>Resend</strong>: お知らせのメールの送信。宛先のメールアドレスと、メールの本文（作品の題名など）を送ります。</li>
</ul>

<h2>6. Cookie</h2>
<p>本サービスが発行する Cookie は次の 2 つだけです。どちらもログインのためのもので、
   本サービスのドメインだけに送られ、ページのスクリプトからは読めません。</p>
<ul>
  <li><strong>ログインの状態</strong>: 利用者の識別子と有効期限を、改ざんを検知できる形で持ちます。有効期間は ${sessionDays} 日です。</li>
  <li><strong>ログイン手続き中の一時的な情報</strong>: Google のログイン画面との往復のあいだだけ使います（入力された招待コードと、ログイン後に戻る画面を含みます）。有効期間は ${oauthMinutes} 分です。</li>
</ul>
<p><strong>アクセス解析や広告のための Cookie・外部のスクリプトは使っていません。</strong></p>

<h2>7. 保存期間</h2>
<ul>
  <li>入力の検査で止めた指示文は、90 日を目安に削除します。</li>
  <li>AWS 上の処理の記録（ログ）は、14 日で自動的に削除されます。</li>
  <li>Cookie は、上の 6 に書いた有効期間で失効します。</li>
  <li>それ以外の情報は、期限を定めた自動の削除を行っておらず、本サービスの提供に必要なあいだ保存します。</li>
</ul>
<p>本サービスには、現在、利用者自身で退会する機能がありません。
   アカウントや情報の削除を希望される場合は、下の窓口までご連絡ください。</p>

<h2>8. 開示・訂正・利用停止・削除などのご請求</h2>
<p>ご自身の情報について、利用目的の通知、開示、訂正、追加、削除、利用の停止、第三者への提供の停止を
   求める場合は、${mail} までメールでご連絡ください。
   ご本人であることを確かめるため、本サービスに登録しているメールアドレスからお送りいただくようお願いします。</p>

<h2>9. 改定</h2>
<p>このプライバシーポリシーは変更されることがあります。変更後の内容は本ページに掲示した時点で効力を生じます。
   収集する情報を増やすときは、収集を始める前に本ページへ記載します。</p>

<h2>10. お問い合わせ窓口</h2>
<dl class="gf-legal-contact">
  <dt>事業者の名称</dt>
  <dd>${operator}</dd>
  <dt>メールアドレス</dt>
  <dd>${mail}</dd>
</dl>
<p>作品の生成物の権利については<a href="${TERMS_PATH}">利用規約</a>を、
   よくあるご質問は<a href="${FAQ_PATH}">よくある質問</a>をご覧ください。</p>
</div>`;
}

/**
 * プライバシーポリシーの画面を組み立てる。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
function privacyPage(viewer: SiteViewer): string {
  return `${siteHead({ title: PRIVACY_TITLE, viewer })}
${privacyBody(SERVICE_PRIVACY_CONTACT)}
${siteFooter()}
`;
}

/** プライバシーポリシーの経路。**ログインを要求しない**（2.3.1）。 */
export const privacyRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: PRIVACY_PATH,
    handler: async (request, env) => html(privacyPage(await resolveSiteViewer(request, env))),
  },
];
