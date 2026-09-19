/**
 * プライバシーポリシー（`/privacy`。2.3.1 v1.57 / M12-5 / #373）。
 *
 * ## 書くのは「いま実際に取得・保存しているもの」だけである
 *
 * #373 の constraints は「**書いていない収集をしないのと同じくらい、していない収集を
 * 書かないことが要る**」と定めている。**M12 でこれから増える項目（アイコンなど）は、
 * ここへ先回りして書かない。** 収集を始める issue が、同じ変更の中でこの本文へ追記する
 * （自己紹介と外部リンクは #379 が、メール配信の設定は #384 が、プレイ数は #377 が追記した）。
 *
 * 各項目が実在することは、2026-09-12 に次の場所で確かめた（PR #373 の本文にも一覧を置く）。
 *
 * | 本文の項目 | 確かめた場所 |
 * |---|---|
 * | Google の識別子・メールアドレス・名前 | `src/auth/google.ts`（scope `openid email profile`、`users` への insert）/ `migrations/0001_init.sql` |
 * | 表示名 | `src/account.ts` / `migrations/0022_*` |
 * | 表示名の変更履歴（Google の名前への追随を含む・公開しない） | `migrations/0030_display_name_changes.sql`（追記のみの `display_name_changes`）/ `src/display-name-changes.ts` / `src/account.ts` の `changeDisplayName` / `src/auth/google.ts` の `refreshExistingUser` / 読むのは管理画面の審査キューだけ（`src/admin/report-evidence.ts`。#405 が同じ変更で追記した） |
 * | 自己紹介と外部リンク（作者ページで誰でも見られる）とその変更の履歴（公開しない） | `migrations/` の user_profile（`users.bio` / `users.profile_links` / 追記のみの `profile_changes`）/ `src/profile.ts` の `changeProfile` / `src/account.ts` の `/account` / `src/author-profile.ts`（作者ページ）。**履歴を読む画面はまだ無い**（運営が D1 で確かめる。#379 が同じ変更で追記した） |
 * | ハンドル名（作者ページの URL。誰でも見られる）と、改名で手放したハンドル名の予約（90 日は本人以外が取れず、旧い URL を転送する）と、その変更の履歴（公開しない） | `migrations/` の user_handles（`handles` の主キーがハンドル名で、手放した行は `released_at` を持つ。**予約が切れた行は、ほかの人がその名前を取るときに消す**——それまでは残る / 追記のみの `handle_changes`）/ `src/handle.ts` の `changeHandle` / `src/account-handle.ts` の `/account/handle` / `src/users-page.ts`（`/@handle` と転送）。**履歴を読む画面はまだ無い**（運営が D1 で確かめる。#381 が同じ変更で追記した） |
 * | メール配信の設定（改造のお知らせを受け取るかと、止めた日時・公開しない）と、止められないお知らせ | `migrations/` の fork_notice_mute（`users.fork_notice_muted_at`）/ `src/account.ts` の `/account/mail` / 送信の口で読むのは `src/mail/fork-notice.ts` だけ / 種別の一覧は `src/mail/kinds.ts`（#384 が同じ変更で追記した） |
 * | 招待関係 | `migrations/0001_init.sql`（`invites` / `users.invited_by`）/ `src/invites.ts` |
 * | 指示文・生成の記録 | `src/cost-ledger.ts`（`generations.prompt`）/ `migrations/0009_game_revisions.sql` / `migrations/0047_games_prompt.sql`（最初の指示を作品と結び付けた写し。作者本人にだけ `src/works-api.ts` が返す。削除・退会・入力の検査での止めで消える。#694 が同じ変更で追記した） |
 * | 遮断された指示文（90 日） | `migrations/0016_moderation_blocks.sql` / `scripts/moderation-prune.sh` |
 * | 作品・題名の変更履歴 | `migrations/0001_init.sql`（`games`）/ `migrations/0027_title_changes.sql` / R2 |
 * | 作者による作品の削除（下書きと取り下げた作品だけ・子や運営の記録があれば行と履歴を残す・指示文と生成の記録は残る） | `src/game-deletion.ts` の `deleteGame`（行を残す条件・消す表）/ `migrations/0041_game_deletion.sql`（`purged_at`）/ `src/work-page.ts` の `POST /api/works/delete`（作者の確認）/ `generations` は作品と結び付けていない（確定27）（#517 が同じ変更で追記した） |
 * | 作品の説明とその変更履歴（下書きのうちから書け、下書きのあいだは作者にだけ見える・公開すると作品ページで誰でも見られる） | `migrations/0028_game_descriptions.sql`（`games.description` / 追記のみの `description_changes`）/ `src/games.ts` の `describeGame`（下書きに書くのは `src/work-save.ts` の `allowDraft` だけ）/ `src/work-page.ts`（#388 が同じ変更で追記した。下書きの分は #673 が同じ変更で直した） |
 * | いいね・1 日の操作回数 | `workers/likes/src/hub.ts`（Durable Object の `likes` / `daily_ops`） |
 * | プレイ数（作品ごとの起動回数・利用者と結び付けない・カードと作品ページで誰でも見られる）と、ブラウザの sessionStorage に置く作品ごとの最終計上時刻（30 分・サーバへ送らない） | `workers/likes/src/play-hub.ts`（Durable Object の `plays(game_id, count)`。利用者の列が無い）/ `migrations/` の games_play_count（`games.play_count`）/ `src/plays.ts` の `playReportScript`（`sessionStorage` の鍵 `gf-play:<作品 id>`、`credentials: 'omit'`、`PLAY_REPORT_WINDOW_MS`）（#377 が同じ変更で追記した） |
 * | 通報 | `src/reports.ts` / `migrations/0001_init.sql`（`reports`） |
 * | 待機リスト | `src/waitlist.ts` / `migrations/0001_init.sql`（`waitlist`） |
 * | 退会（本人が押す。識別子・メール・表示名の匿名化・アイコンの削除・履歴の削除・ハンドル名の予約・指示文を空にする・作品の全件削除） | `src/account-withdrawal.ts` の `/account/withdraw` と `POST /api/account/withdraw` / `src/withdrawal.ts`（段1〜3 と匿名化の値）/ `src/withdrawal-purge.ts` と `workers/cleanup/`（後続の処理）/ `migrations/0045_user_withdrawal.sql`（#518 が同じ変更で追記した） |
 * | 削除依頼 | `src/takedown.ts` / `migrations/0018_takedown_requests.sql` |
 * | 運営の措置の記録 | `migrations/0026_admin_actions.sql` |
 * | AI アプリとの接続（MCP。接続したアプリの名前・戻り先・許可した範囲・日時と、発行した鍵のハッシュ・最後に使ってから 30 日で使えなくなり、同意から 1 年で失効して記録も消える・解除と退会で消える） | `src/oauth-provider.ts`（`@cloudflare/workers-oauth-provider` 0.10.3。KV `OAUTH_KV` の `client:` / `grant:` / `token:`。トークンは `generateTokenId` の SHA-256 だけを鍵にし、props は暗号化）/ `src/oauth-authorize.ts`（同意のときに許可へ写すアプリ名と戻り先のホスト名）/ `src/account-apps.ts`（解除）/ `src/account-withdrawal.ts`（退会で消す）/ 寿命は `src/oauth-paths.ts`（#696 が同じ変更で追記した） |
 * | Cookie 3 種 | `src/session.ts`（`__Host-gf_session`、7 日）/ `src/auth/google.ts`（`__Host-gf_oauth`、10 分）/ `src/oauth-paths.ts`（`__Host-gf_mcp_authz`、10 分。#696 が足した） |
 * | AWS 上の処理の記録（生成・ビルド・撮影は 14 日 / 費用ガードは 30 日） | `terraform/orchestrator.tf`・`terraform/build-function.tf`・`terraform/ogp-function.tf` の `retention_in_days = 14` と、`terraform/bedrock-guard.tf` の `retention_in_days = 30`（**ひとまとめに 14 日と書いていた誤りを PR #400 の Copilot の指摘で分けた。値を変えたら本文も直すこと**） |
 * | 外部サービス | Cloudflare（`wrangler.toml`）/ AWS・Bedrock・Guardrails（`terraform/bedrock.tf` / `terraform/moderation.tf` / `src/generation-models.ts`）/ Google（`src/auth/google.ts`）/ Resend（`src/mail/resend.ts`） |
 *
 * **アクセス解析・広告は使っていない**（外部のスクリプトも解析の cookie も無い）。**使い始めた
 * 日に、この本文の「Cookie」の節も書き換えること。**
 *
 * ## 法的助言ではない
 *
 * `src/legal.ts` の規約と同じく、**書いたのは弁護士ではない。** 画面にも但し書きを出す。
 * **一般公開の前に専門家の確認が要る。** とくに外部の事業者への送信が「委託」か「外国にある
 * 第三者への提供」かは**断定しない**——事実（誰へ何を送るか）だけを書き、区分は確認後に書く。
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
import { READING_CLASS, escapeHtml, resolveSiteViewer, siteHead } from './html.js';
import { CONTACT_EMAIL, CONTACT_MAILTO, OPERATOR_NAME } from './service-contact.js';
import { OAUTH_COOKIE_MAX_AGE, SESSION_MAX_AGE } from './auth/google.js';
import { AVATAR_HISTORY_RETENTION_DAYS, AVATAR_OUTPUT_SIZE } from './avatar.js';
import { HANDLE_RESERVATION_DAYS } from './handle.js';
import { WITHDRAWN_DISPLAY_NAME } from './withdrawal.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  PENDING_AUTHORIZATION_MAX_AGE_SECONDS,
  GRANT_IDLE_LIMIT_SECONDS,
  GRANT_MAX_AGE_SECONDS,
} from './oauth-paths.js';

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
  // AI アプリとの接続の寿命の正本は `src/oauth-paths.ts`（#696）。
  const idleDays = Math.round(GRANT_IDLE_LIMIT_SECONDS / (60 * 60 * 24));
  const maxAgeYears = Math.round(GRANT_MAX_AGE_SECONDS / (60 * 60 * 24 * 365));
  const accessTokenMinutes = Math.round(ACCESS_TOKEN_TTL_SECONDS / 60);
  const pendingMinutes = Math.round(PENDING_AUTHORIZATION_MAX_AGE_SECONDS / 60);
  // **暫定版の但し書きはブロック（`.gf-block`）で、器の幅いっぱいに面を置く**（仕様 2.5.3 / #471）。本文は 42rem のまま。
  // **器は読み物の器**（`READING_CLASS`。42rem の幅で中央に置く。仕様 2.5.3 / #564）。
  return `<div class="gf-legal ${READING_CLASS}">
<h1>プライバシーポリシー</h1>
<p class="gf-block gf-draft-notice"><strong>このプライバシーポリシーはクローズドβ向けの暫定版です。</strong>
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
  <li><strong>表示名の変更の履歴</strong>: 表示名が変わったときの、変える前と後の表示名と、変えた日時。登録情報の画面で変えた場合のほか、Google アカウントの名前に合わせて表示名が変わった場合も残します。通報への対応のために運営者が確かめるもので、公開しません。変更の履歴は書き換えず、追記だけで残します。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>自己紹介と外部リンク</strong>（登録情報の画面で設定できます）: 自己紹介の文章と、外部のページへのリンク（3 本まで）。作者ページで誰でも見られます。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>アイコンの画像</strong>（登録情報の画面で設定できます）: 選んでいただいた画像を、中央で正方形に切り抜いて ${AVATAR_OUTPUT_SIZE} ピクセル四方の WebP に作り直したもの。<strong>元のファイルは保存せず、撮影した場所や機種などの情報（Exif などのメタデータ）は作り直すときに取り除きます。</strong>作者ページ・作品の一覧・ヘッダで誰でも見られます。作り直しは Amazon Web Services（AWS）上の処理で行い、作り直した画像を Cloudflare のファイルの保存場所（R2）に保存します</li>
  <li><strong>差し替える前・外す前のアイコンの画像と、アイコンの変更の履歴</strong>: アイコンを差し替えたり外したりしたときの、前の画像（${AVATAR_HISTORY_RETENTION_DAYS} 日間だけ保存します）と、変える前と後の画像を見分ける値（ハッシュ値）と、変えた日時。通報への対応のために運営者が確かめるもので、公開しません。変更の履歴は書き換えず、追記だけで残します。前の画像は Cloudflare のファイルの保存場所（R2）に、履歴は Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>自己紹介と外部リンクの変更の履歴</strong>: 自己紹介か外部リンクを変えたときの、変える前と後の自己紹介と外部リンクと、変えた日時。通報への対応のために運営者が確かめるもので、公開しません。変更の履歴は書き換えず、追記だけで残します。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>ハンドル名</strong>（登録情報の画面で設定できます）: 作者ページの URL（<code>/@ハンドル名</code>）に使う名前。作者ページの URL として、作品の一覧や作品ページのリンクにも表れ、誰でも見られます。ハンドル名を変えたときは、前のハンドル名を ${HANDLE_RESERVATION_DAYS} 日間ほかの方が使えないように残し、前の URL を開いた方を新しいハンドル名の作者ページへ転送します。${HANDLE_RESERVATION_DAYS} 日を過ぎた前のハンドル名も、ほかの方がそのハンドル名を使うまではデータベースに残ります。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>ハンドル名の変更の履歴</strong>: ハンドル名を決めたり変えたりしたときの、変える前と後のハンドル名と、変えた日時。通報への対応のために運営者が確かめるもので、公開しません。変更の履歴は書き換えず、追記だけで残します。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>メール配信の設定</strong>（登録情報の画面で変更できます）: 作品がフォークされたときのお知らせを受け取るかどうかと、受け取らない設定にした日時。公開しません。Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>AI アプリとの接続</strong>（Claude などの AI アプリに、あなたの作品の読み取りや生成を許可した場合）: 接続したアプリの名前（アプリ自身が名乗った名前）・許可した後の戻り先・許可した範囲・接続した日時と、アプリへ発行した鍵（トークン）の記録。<strong>鍵そのものは保存せず、照合に使う値（ハッシュ値）だけを保存します。</strong>登録情報の「接続中のアプリ」で確かめ、解除できます。Cloudflare のキーと値の保存場所（KV）に保存します</li>
  <li><strong>招待の情報</strong>: 招待コード、誰が誰を招待したか、コードを使った日時</li>
  <li><strong>作品を作るときの指示文</strong>（生成・フォーク・リフォージの指示）。作品ごとに、最初の指示とリフォージの指示を、作者本人が見返せるように作品と結び付けて保存します（公開しません。入力の検査で止めた指示は、作品と結び付けて保存しません）</li>
  <li><strong>作品</strong>: 題名とその変更履歴、生成されたソースコード、遊ぶためのファイル、紹介用の画像、公開・下書き・公開停止の状態、フォーク元の作品</li>
  <li><strong>作品の説明</strong>: 作者が作品に書く説明（遊び方やクレジットなど）と、その変更の履歴（変える前と後の説明、変えた日時）。説明は下書きのうちから書けます。下書きのあいだは作者にだけ見え、公開すると作品ページで誰でも見られます。変更の履歴は書き換えず、追記だけで残します。どちらも Cloudflare のデータベース（D1）に保存します</li>
  <li><strong>いいね</strong>: どの作品にいいねしたかと、その日時</li>
  <li><strong>通報</strong>: 通報した作品と、書いていただいた理由</li>
</ul>

<h3>利用に伴って記録する情報</h3>
<ul>
  <li><strong>生成の記録</strong>: 日時、使ったモデル、処理した文字量（トークン数）、費用、成否</li>
  <li><strong>入力の検査で止めた指示文</strong>と、止めた理由の分類</li>
  <li><strong>いいねの操作回数</strong>（1 日の上限を判定するため）</li>
  <li><strong>プレイ数</strong>: 作品ごとの、ゲームが起動した回数。誰が遊んだかとは結び付けずに数え、ログインしていない方の起動も同じく数えます。数は作品カードと作品ページで誰でも見られます。Cloudflare（Durable Objects とデータベース（D1））に保存します</li>
  <li><strong>登録日時</strong>、および運営者が行った措置（利用停止など）とその理由</li>
  <li><strong>処理の記録（ログ）</strong>: 障害を調べるための、作品の識別子や処理の結果</li>
</ul>
<p>本サービスは、閲覧した画面の履歴・IP アドレス・ブラウザの種類を、自らのデータベースへ保存していません。</p>

<h3>ログインせずに送っていただく情報</h3>
<ul>
  <li><strong>待機リスト</strong>: メールアドレスと、どの画面から登録したか</li>
  <li><strong>削除依頼</strong>（<a href="${TAKEDOWN_PATH}">権利者の方へ</a>）: お名前または団体名、ご連絡先、依頼の内容</li>
  <li><strong>お問い合わせ</strong>: メールでお送りいただいた内容と、送信元のメールアドレス</li>
</ul>

<h2>2. 利用目的</h2>
<ul>
  <li>ログインの状態を保ち、利用者を見分けるため</li>
  <li>作品の生成・フォーク・リフォージ・公開・表示を行うため</li>
  <li>1 人あたりの生成枠と、サービス全体の費用の上限を管理するため</li>
  <li>生成の完了・失敗や、作品がフォークされたことを、メールでお知らせするため（作品がフォークされたことのお知らせは、登録情報の画面で受け取らない設定にできます。生成の完了・失敗のお知らせは、その設定にかかわらず送ります）</li>
  <li>あなたが許可した AI アプリから、あなたの作品の読み取りや生成を行えるようにするため</li>
  <li>招待の仕組みを運用し、待機リストに登録された方へ招待についてご連絡するため</li>
  <li>不正な利用や規約に反する内容を防ぎ、通報・削除依頼に対応するため</li>
  <li>お問い合わせに回答するため</li>
  <li>障害の調査と、利用状況の集計によるサービスの改善のため</li>
</ul>

<h2>3. 公開される情報と、公開されない情報</h2>
<p><strong>次の情報は、ログインしていない人を含め、誰でも見られます。</strong></p>
<ul>
  <li>表示名（作者ページや、公開した作品の作者名として表示されます）</li>
  <li>公開した作品（題名・遊べる形・紹介用の画像・フォーク元の作品）と、そのいいねの数とプレイ数</li>
  <li>公開した作品に作者が書いた説明（作品ページに表示されます）</li>
  <li>自己紹介と外部リンク（作者ページに表示されます。外部リンクは本人の申告として表示し、運営者はリンク先がその人のものかを確認していません）</li>
  <li>アイコンの画像（作者ページ・作品の一覧・ヘッダに表示されます）</li>
  <li>ハンドル名（作者ページの URL として表示されます。ハンドル名を変えてから ${HANDLE_RESERVATION_DAYS} 日間は、前の URL を開いた方を新しいハンドル名の作者ページへ転送するため、前と後のハンドル名が同じ方のものだと分かります）</li>
</ul>
<p>作品の題名は、最初は指示文から作られます。題名は作品ページで変えられます。</p>
<p>公開する前の作品は、作品ページの URL を知っている人がそのページを開いても、まだ公開されていないことだけが表示されます（題名は表示されず、遊ぶこともできません）。</p>
<p>公開した作品のソースコードは、他の利用者がその作品をフォークするときに、生成の材料として使われます。</p>
<p><strong>次の情報は公開しません。</strong>メールアドレス、指示文、いいねした作品の一覧、
   誰が誰を招待したか、通報の内容、表示名の変更の履歴、自己紹介と外部リンクの変更の履歴、差し替える前・外す前のアイコンの画像とアイコンの変更の履歴、ハンドル名の変更の履歴、メール配信の設定、接続した AI アプリ。</p>

<h2>4. 第三者への提供と、外部の事業者への送信</h2>
<p>上の 3 に書いた情報は、利用者が表示名や自己紹介・外部リンク・アイコン・ハンドル名を設定したり作品を公開したりすることで、誰でも見られるようになります。</p>
<p>また、本サービスを動かすために、下の 5 に書いた事業者へ、そこに書いた情報を送っています。
   これらの送信が法令上どのように位置づけられるか（業務の委託にあたるか、外国にある第三者への提供にあたるかなど）は、
   正式公開までに専門家の確認を受け、本ページに記載します。</p>

<h2>5. 外部のサービスの利用</h2>
<p>本サービスは、次の事業者のサービスを使って運営しています。
   <strong>それぞれに、下に書いた情報が送られ、または保存されます。</strong></p>
<ul>
  <li><strong>Cloudflare</strong>: 本サービスの配信（ホスティング）と、データベース・ファイル・いいねとプレイ数の記録・AI アプリとの接続の記録の保存。上の 1 に挙げた情報の主な保存先です。</li>
  <li><strong>Amazon Web Services（AWS）</strong>: 作品の生成・ビルド・紹介用の画像の撮影と、アイコンの画像の作り直しを行う処理の実行（アイコンの画像は、作り直すあいだだけ送り、AWS 上には保存しません）。
    <ul>
      <li>生成には <strong>Amazon Bedrock</strong>（Anthropic 社の Claude モデル）を使います。指示文と、フォーク・リフォージのときは元の作品のソースコードを送ります。</li>
      <li>指示文は、生成の前に <strong>Amazon Bedrock Guardrails</strong> で有害な内容かどうかを検査します。この検査は、アジア太平洋地域の複数のリージョンで処理されることがあります。</li>
    </ul>
  </li>
  <li><strong>Google</strong>: Google アカウントによるログイン。</li>
  <li><strong>Resend</strong>: お知らせのメールの送信。宛先のメールアドレスと、メールの本文（作品の題名など）を送ります。</li>
</ul>

<h2>6. Cookie</h2>
<p>本サービスが発行する Cookie は次の 3 つだけです。どれもログインのためのもので、
   本サービスのドメインだけに送られ、ページのスクリプトからは読めません。</p>
<ul>
  <li><strong>ログインの状態</strong>: 利用者の識別子と有効期限を、改ざんを検知できる形で持ちます。有効期間は ${sessionDays} 日です。</li>
  <li><strong>ログイン手続き中の一時的な情報</strong>: Google のログイン画面との往復のあいだだけ使います（入力された招待コードと、ログイン後に戻る画面を含みます）。有効期間は ${oauthMinutes} 分です。</li>
  <li><strong>AI アプリとの接続の手続き中の情報</strong>: ログインしていない状態で AI アプリとの接続を始めたときに、Google のログイン画面との往復のあいだだけ、アプリからの接続の要求（アプリの識別子・許可した後の戻り先・求めている範囲など）を、改ざんを検知できる形で持ちます。ログインから戻ると消します。有効期間は ${pendingMinutes} 分です。</li>
</ul>
<p><strong>ブラウザの保存領域（sessionStorage）</strong>: 同じ作品を短い時間に何度も開いたときにプレイ数を重ねて数えないよう、
   作品ページを開いたブラウザの sessionStorage に、作品ごとに最後に数えた時刻を置きます（30 分以内は数え直しません）。
   この値はサーバへは送らず、ブラウザのタブを閉じると消えます。Cookie ではありません。</p>
<p><strong>アクセス解析や広告のための Cookie・外部のスクリプトは使っていません。</strong></p>

<h2>7. 保存期間</h2>
<ul>
  <li>入力の検査で止めた指示文は、90 日を目安に削除します。</li>
  <li>AWS 上の処理の記録（ログ）のうち、作品の生成・ビルド・紹介用の画像の撮影・アイコンの画像の作り直しの記録は 14 日で、費用の上限を監視する処理の記録は 30 日で、自動的に削除されます（アイコンの作り直しの記録に画像そのものは含みません）。</li>
  <li><strong>差し替える前・外す前のアイコンの画像は、差し替えた・外した日から ${AVATAR_HISTORY_RETENTION_DAYS} 日で自動的に削除されます</strong>（削除の処理の都合で、実際に消えるまでさらに 1 日ほどかかることがあります）。アイコンの変更の履歴（ハッシュ値と日時）は削除しません。不適切な画像を運営者が削除する場合と、アカウントの削除を希望された場合は、この期間を待たずに、いまのアイコンと前の画像の両方を削除します。</li>
  <li><strong>AI アプリとの接続は、最後に使ってから ${idleDays} 日で使えなくなります。使い続けていても、許可した日から ${maxAgeYears} 年で失効します。</strong>使えなくなった接続の記録は、アプリがもう一度使おうとしたときか、許可した日から ${maxAgeYears} 年たったときに自動的に削除されます。続けて使うには、もう一度許可してください。アプリへ発行する鍵は ${accessTokenMinutes} 分で失効します。登録情報の「接続中のアプリ」で解除すると、その時点で削除します。</li>
  <li>Cookie は、上の 6 に書いた有効期間で失効します。ブラウザの sessionStorage に置く時刻は、タブを閉じると消えます。</li>
  <li><strong>作品は、作者が作品ページから削除すると削除します。</strong>削除できるのは、公開していない作品（下書き）です（公開中の作品は、公開をやめて下書きに戻してから削除できます）。削除すると、題名・説明・タグ・生成されたソースコード・遊ぶためのファイル・紹介用の画像と、リフォージの前の版を削除します。ただし、次の場合は作品の行（作品の識別子・作者・フォーク元・作った日時など。題名や中身は含みません）を残します。
    <ul>
      <li>その作品をフォークした作品があるとき（フォークした作品に「削除済みの作品から派生」と表示するため）</li>
      <li>通報・削除依頼・運営者の措置・入力の検査の記録がその作品にあるとき（対応を確かめられるようにするため。題名と説明の変更の履歴も残します）</li>
    </ul>
    作品と結び付けて保存した指示文も、作品と一緒に削除します。
    <strong>作品を削除しても、生成の記録に残る、作品を作るときの指示文と生成の記録は削除しません</strong>（1 人あたりの生成枠とサービス全体の費用の上限を管理するため）。<strong>退会したときだけは指示文を削除します</strong>（生成の記録の行・費用・日時は残します。下の「退会」）。</li>
  <li>それ以外の情報は、期限を定めた自動の削除を行っておらず、本サービスの提供に必要なあいだ保存します。</li>
</ul>
<h3>退会</h3>
<p><strong>利用者はご自身で退会できます。</strong>ログインしたうえで、登録情報の「アカウント」から
   「退会について確かめる」を開き、消えるものと残るものを確認してから手続きしてください。
   <strong>退会は取り消せません。</strong>同じ Google アカウントでもう一度参加するには、
   新しい招待コードが必要です（退会前のアカウントには戻れません）。</p>
<p><strong>退会すると、次の情報を削除します。</strong></p>
<ul>
  <li>Google アカウントの識別子との結び付きと、メールアドレス。</li>
  <li>表示名（「${escapeHtml(WITHDRAWN_DISPLAY_NAME)}」に置き換えます）・自己紹介・外部リンク。</li>
  <li>アイコンの画像（いま使っているものと、差し替える前・外す前の画像の両方を、上の ${AVATAR_HISTORY_RETENTION_DAYS} 日を待たずに削除します）。</li>
  <li>表示名・自己紹介と外部リンク・アイコン・ハンドル名の変更の履歴。</li>
  <li>メール配信の設定。</li>
  <li>AI アプリとの接続（許可と、アプリへ発行した鍵の記録）。</li>
  <li>作品を作るときに入力した指示文（生成の記録の行・費用・日時は残します）。</li>
  <li>作品（公開中の作品は公開を停止してから削除します。削除の範囲は、上の「作品は、作者が作品ページから削除すると削除します」と同じです）。</li>
  <li>待機リストに同じメールアドレスの登録が残っていれば、あわせて削除します。</li>
</ul>
<p><strong>退会しても、次の情報は残します。</strong></p>
<ul>
  <li>いいね・通報（通報した記録）・招待の記録（誰が誰を招待したか）・運営者の措置の記録・入力の検査で止めた記録（上のとおり 90 日を目安に削除します）。<strong>いずれも、匿名化した行に紐づくだけになります。</strong>これらを消すと、他の利用者の招待枠の計算や、対応済みの通報の確かめができなくなるためです。</li>
  <li>生成の記録（回数・費用・日時）。1 人あたりの生成枠とサービス全体の費用の上限を管理するために残します。</li>
  <li>あなたの作品をフォークして作られた作品。フォークした作品の側では、元の作品が「削除済みの作品から派生」と表示されます。</li>
  <li>通報・削除依頼・運営者の措置があった方については、対応を確かめられるように、上の変更の履歴を残します（公開しません）。このとき、匿名化したことも履歴に残します。</li>
  <li>ハンドル名は、退会してから ${HANDLE_RESERVATION_DAYS} 日のあいだ、ほかの方が使えません（ハンドル名を変えたときと同じ扱いです）。</li>
</ul>
<p><strong>次のものは、退会しても消せません。</strong>公開したことのある作品の遊ぶためのファイルは、
   ブラウザや途中のキャッシュに最大 1 年残ることがあります（本サービスから削除しても、
   既に配られた写しまでは取り消せません）。上に書いた処理の記録（ログ）も、
   それぞれの保存期間が過ぎるまで残ります。</p>

<h2>8. 開示・訂正・利用停止・削除などのご請求</h2>
<p>ご自身の情報について、利用目的の通知、開示、訂正、追加、削除、利用の停止、第三者への提供の停止を
   求める場合は、${mail} までメールでご連絡ください。</p>
<p>ご本人であることを確かめるため、<strong>本サービスに登録しているメールアドレスからお送りください。</strong></p>
<p><strong>退会した後にご請求される場合は、この方法で確かめられません</strong>（退会でメールアドレスを
   削除しているため、お送りいただいた宛先と照らし合わせるものが残っていません）。その場合は、
   退会前に使っていたメールアドレス・ハンドル名・作品の URL など、ご本人だけが分かる事項を
   添えてご連絡ください。<strong>いただいた内容だけではご本人だと確かめられないときは、
   お応えできないことがあります。</strong>退会によって削除済みの情報については、
   開示や削除の対象となるものがそもそも残っていません。</p>

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
  return `${siteHead({ title: PRIVACY_TITLE, viewer, reading: true })}
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
