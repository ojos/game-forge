/**
 * 利用者が自分で退会する口と画面（`/account/withdraw`・`POST /api/account/withdraw`・
 * `/account/withdrawn`。#518 / M15-3 / 仕様 8.1）。
 *
 * **D1 と R2 の処理は `src/withdrawal.ts` が持つ**（土台は #586 / PR #588 で本番に出ている）。
 * このモジュールが持つのは、**導線から押されたときの認証・文言・画面**だけである。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 段0 を通す（`resolveSessionUser` ではない）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `resolveSessionUser` は**退会を始めた行を拒む**（`src/session-user.ts`）。退会は段1〜3 に
 * 分かれていて、段2（R2）や段3（D1 の確定）の手前で落ちた要求は**同じ cookie で押し直すと
 * 続きから進む**のに、その入口が閉じてしまう。**この口だけが `resolveWithdrawalSession`
 * （段0）を通る**——例外はここ 1 か所に閉じ込め、ほかの 32 か所の呼び出しには波及させない。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 確認画面は D1 の状態を読まない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * **`src/work-delete.ts`（作品の削除）とは違う判断である。** あちらは、作品ページが既に引いて
 * ある 1 行から「押しても必ず断られる導線」を消せる。**退会には、そういう「ついでに引いてある行」
 * が無い**——生成中・リフォージ中を先に見るには、確認画面を開くたびに `games` と
 * `game_revision_jobs` を引くことになり、**断る条件の綴りが `src/withdrawal.ts` の掴みの SQL と
 * 2 か所になる**（shared-ai-rules 12 章）。
 *
 * そこで**判定の正本を掴みの 1 文だけに保ち、断りは押した後に出す。** 黙って失敗するわけでは
 * ない（仕様 1.2.31）——{@link WITHDRAWAL_REFUSALS} が理由ごとに、**何をすれば退会できるように
 * なるか**を書いた画面を返す。確認画面の側にも、生成中・リフォージ中は退会できないことを
 * 先に書いておく。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 完了画面はログインを要求しない
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 退会の応答はセッションの cookie を消すので、303 の先はもう未ログインである。ログインを
 * 要求すると**退会した直後の人がログイン画面へ送られ、そこから戻れない**（同じ Google
 * アカウントでは新しい招待が要る）。**誰が開いても同じ静的な画面**にし、「あなたは退会しました」
 * とは書かない（誰の状態も名乗らない）。
 *
 * **「同じ」なのは本文である**（PR #589 の Copilot の指摘 5 を、こう読み直した）。**ヘッダだけは
 * ほかの全画面と同じく `resolveSiteViewer` が出し分ける**——`test/page-shell.test.ts` は
 * **全 SSR 画面について「ヘッダがログイン状態で変わること」と「ログイン済みならログアウトの
 * フォームが 1 つあること」を経路表から導いて見ており**（2.3.3 の条件 3。HTML を共有キャッシュへ
 * 載せられない理由そのもの）、この 1 枚だけ固定のヘッダにすると**その不変条件が崩れる。**
 *
 * **指摘が心配していた「退会した本人に古い自分のヘッダが出る」ことは起きない。**
 * `resolveSiteViewer` は #518 で**退会した行を未ログインへ倒す**ようになったので、この画面を
 * 開いた退会者のヘッダは（cookie が残っていても）未ログインになる。**D1 の不調でこの画面が
 * 落ちることもない**——`viewerStillSignedIn` は投げず、読めなければ今までの表示のまま返す
 * （`src/html.ts`）。**本文は D1 を 1 行も読まず、誰が開いても同じである。**
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CSRF と JavaScript
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 素の `<form method="post">` で送る（`src/account.ts` と同じ。JavaScript を要求しない。9.3）。
 * CSRF はセッション cookie の `SameSite=Lax` が受ける——他サイトからの POST に cookie が乗らない。
 */
import {
  ACCOUNT_APPS_PATH,
  ACCOUNT_DETAILS_PATH,
  ACCOUNT_WITHDRAWN_PATH,
  ACCOUNT_WITHDRAW_API_PATH,
  ACCOUNT_WITHDRAW_PATH,
} from './account-paths.js';
import { loginRequiredRedirect } from './auth/google.js';
import { AVATAR_HISTORY_RETENTION_DAYS } from './avatar.js';
import { FAQ_PATH, PRIVACY_PATH } from './legal-paths.js';
import { HANDLE_RESERVATION_DAYS } from './handle.js';
import type { SiteViewer } from './html.js';
import {
  READING_CLASS,
  escapeHtml,
  headerAvatarUrl,
  resolveSiteViewer,
  siteHead,
  siteViewerAt,
} from './html.js';
import { siteFooter } from './legal.js';
import { revokeAllOAuthGrants } from './oauth-provider.js';
import { HOME_PATH } from './paths.js';
import type { Route } from './routes.js';
import { html } from './routes.js';
import { clearSessionCookie } from './session.js';
import { CONTACT_EMAIL, CONTACT_MAILTO } from './service-contact.js';
import type { WithdrawalRejection } from './withdrawal.js';
import { WITHDRAWN_DISPLAY_NAME, resolveWithdrawalSession, withdrawUser } from './withdrawal.js';

/** 断りの画面の中身（`src/work-delete.ts` の `DeleteRefusal` と同じ形）。 */
export interface WithdrawalRefusal {
  /** 返すステータス。 */
  readonly status: number;
  /** 見出し。 */
  readonly heading: string;
  /** 本文。 */
  readonly body: string;
}

/**
 * 画面に出す断りの理由。
 *
 * `not-found` と `banned` を外すのは、**その 2 つが画面を返さないから**である——どちらも
 * 「ログインし直してもらう」しかなく（`resolveWithdrawalSession` の `unauthorized` と同じ扱い）、
 * 理由を分けて出すと、任意の id が生きているかを外から確かめる手がかりになる。
 *
 * **`Exclude` で導く。** `src/withdrawal.ts` が理由を 1 つ増やした日に、この表へ足し忘れると
 * 型検査が落ちる（綴りを書き並べると、増えた理由が黙って `default` の文言になる）。
 */
export type WithdrawalRefusalReason = Exclude<WithdrawalRejection, 'not-found' | 'banned'>;

/**
 * 断ったときの、理由ごとのステータスと文言（#518 の設計 6 章）。
 *
 * - `admin` … 管理者。**404 にする**（導線も出さない。先に D1 で権限を外す運用にする）。
 *   「あなたは管理者なので退会できません」とは言わない——綴りを知らない人が受け取る応答と
 *   同じ形にし、そこから読み取れるものを残さない
 * - `generating` … 生成中・リフォージ中の作品がある。409。**経過時間で区切らない**ので、
 *   止まったまま残った行もここに来る。**窓口を添える**（#517 の削除の断りと揃える）
 * - `avatar-saving` … アイコンを保存中（排他が生きている）。409
 * - `busy` … 読み直すあいだに状態が動いた（別のタブで同時に押した）。409
 */
export const WITHDRAWAL_REFUSALS: Readonly<Record<WithdrawalRefusalReason, WithdrawalRefusal>> = {
  admin: {
    status: 404,
    heading: 'ページが見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  generating: {
    status: 409,
    heading: '生成中の作品があるため退会できません',
    body: `生成中・リフォージ中の作品があります。終わってからもう一度お試しください。時間がたっても終わらない場合は、お手数ですが<a href="${FAQ_PATH}">よくある質問</a>にある窓口（<a href="${CONTACT_MAILTO}">${CONTACT_EMAIL}</a>）までご連絡ください。`,
  },
  'avatar-saving': {
    status: 409,
    heading: 'アイコンの保存中は退会できません',
    body: 'アイコンの保存が進んでいます。少し待ってから、もう一度お試しください。',
  },
  busy: {
    status: 409,
    heading: '退会の手続きを始められませんでした',
    body: 'ちょうどアカウントの状態が変わったため、手続きを始められませんでした。画面を開き直してから、もう一度お試しください。',
  },
};

/**
 * 退会の確認画面を組み立てる（仕様 2.5.4 / 2.5.5 / 8.1）。
 *
 * # 何が消え、何が残り、何が戻せないかを押す前に書く
 *
 * #518 の scope.in のとおり、**消えるもの**・**残るもの**・**戻せないこと**・**同じ Google
 * アカウントで戻るには新しい招待コードが要ること**を、別々のブロックに分けて書く
 * （`src/work-delete.ts` の削除の確認画面と同じ形）。
 *
 * # 退会のボタンを主にしない
 *
 * **破壊的な操作なので副のボタンにする**（仕様 2.5.5 / #473 / #517 と同じ）。「やめる」は
 * 設定へ戻る移動なので `<a>` にする。**この画面に主のボタンを置かない**——いちばん
 * してほしいことが「退会する」でも「やめる」でもなく、読んで決めることだからである。
 *
 * # 消せないものを隠さない
 *
 * 公開済みの作品の Wasm は、ブラウザや中間のキャッシュに最大 1 年残りうる（#518 の
 * constraints）。**書かずに済ませない。**
 *
 * # 読み物の器に乗せる
 *
 * **画面の本文全体が読ませる文で、押す口は末尾に「退会する」と「やめる」だけである**——仕様 2.5.3 の
 * 「対象の画面」の基準に当たるので、`siteHead` の `reading` と、本文全体を包む
 * {@link READING_CLASS} の `<div>` で 42rem の器に乗せる（#590）。**パンくずの後ろからフッタの前までを
 * 1 つの器に収める**（`<h1>` も注意書きの段落も `<section>` も同じ端に揃う。`test/page-shell.test.ts`）。
 *
 * @param viewer いま見ている人の状態（2.3.7 のヘッダの出し分け）
 * @returns HTML
 */
export function renderWithdrawConfirmation(viewer: SiteViewer): string {
  return `${siteHead({ title: '退会しますか - Game Forge', noindex: true, viewer, reading: true })}
<div class="${READING_CLASS}">
<h1>退会しますか</h1>
<p>退会すると、このアカウントでログインできなくなり、あなたの作品はすべて削除されます。</p>
<section class="gf-block gf-block-rows gf-work-settings" aria-label="退会の確認">
<div>
<h2>退会すると消えるもの</h2>
<ul>
  <li><strong>ログインに使っている Google アカウントとの結び付き</strong>と、メールアドレス。</li>
  <li>表示名（<strong>「${escapeHtml(WITHDRAWN_DISPLAY_NAME)}」になります</strong>）・自己紹介・外部リンク。</li>
  <li>アイコンの画像（いま使っているものと、差し替える前の画像の両方を削除します）。</li>
  <li>表示名・自己紹介と外部リンク・アイコン・ハンドル名の<strong>変更の履歴</strong>（公開していない記録です）。ただし、通報・削除依頼・運営者の措置があった方の履歴は残します（下の「退会しても残るもの」）。</li>
  <li>メール配信の設定。</li>
  <li>AI アプリとの接続（<a href="${ACCOUNT_APPS_PATH}">接続中のアプリ</a>）。接続したアプリは、あなたのアカウントを使えなくなります。</li>
  <li><strong>あなたの作品</strong>（公開中の作品は取り下げてから削除します）。題名・説明・タグ・ソースコード・遊ぶためのファイル・紹介用の画像と、リフォージの前の版が消えます。</li>
  <li>作品を作るときに入力した<strong>指示文</strong>。</li>
</ul>
</div>
<div>
<h2>退会しても残るもの</h2>
<ul>
  <li><strong>あなたの作品をフォークして作られた作品は消えません。</strong>フォークした作品の側では、元の作品が「削除済みの作品から派生」と表示されます。</li>
  <li>生成の記録（回数・費用・日時）。サービス全体の費用の上限を管理するために残します。<strong>指示文は上のとおり消します。</strong></li>
  <li>いいね・通報・招待の記録（誰が誰を招待したか）・運営者の措置の記録・入力の検査で止めた記録。<strong>いずれも「${escapeHtml(WITHDRAWN_DISPLAY_NAME)}」になった行に紐づくだけになります。</strong></li>
  <li>通報・削除依頼・運営者の措置があった方は、対応を確かめられるように、上の変更の履歴も残します（公開しません）。</li>
  <li><strong>ハンドル名は、退会してから ${HANDLE_RESERVATION_DAYS} 日のあいだ、ほかの方が使えません</strong>（ハンドル名を変えたときと同じ扱いです）。</li>
</ul>
</div>
<div>
<h2>退会する前にお読みください</h2>
<ul>
  <li><strong>元に戻せません。</strong>退会を取り消す手段はありません。</li>
  <li><strong>同じ Google アカウントでもう一度参加するには、新しい招待コードが必要です。</strong>退会したアカウントには戻れず、まったく別の利用者として登録することになります。</li>
  <li><strong>生成中・リフォージ中の作品があるあいだは退会できません。</strong>終わってからお試しください。</li>
  <li>作品の削除には時間がかかります。取り下げた作品が一覧から消えるまで最大 1 分ほど、すべての作品の中身が消えるまでさらに数分かかることがあります。</li>
  <li><strong>公開したことのある作品の遊ぶためのファイルは、ブラウザや途中のキャッシュに最大 1 年残ることがあります。</strong>本サービスから消しても、既に配られた写しまでは取り消せません。</li>
  <li>差し替える前のアイコンは、通常は ${AVATAR_HISTORY_RETENTION_DAYS} 日で自動的に消えますが、退会ではその期間を待たずに削除します。</li>
  <li>詳しくは<a href="${PRIVACY_PATH}">プライバシーポリシー</a>の「保存期間」をご覧ください。</li>
</ul>
</div>
<div>
<form method="post" action="${ACCOUNT_WITHDRAW_API_PATH}">
  <button type="submit" class="gf-button gf-button-secondary">退会する</button>
</form>
<p><a href="${ACCOUNT_DETAILS_PATH}">退会せずに設定へ戻る</a></p>
</div>
</section>
</div>
${siteFooter()}`;
}

/**
 * 退会の完了画面を組み立てる（`/account/withdrawn`）。
 *
 * **誰の状態も名乗らない**（モジュール冒頭）。ログインへの導線は置かない——退会した人が
 * そこを押しても、同じ Google アカウントでは「招待コードが必要です」としか出ない。
 *
 * **本文はこの引数を 1 つも読まない。** `viewer` は外枠（ヘッダ）だけに渡る——**誰が開いても
 * 同じ本文**であることが、この画面の性質である（モジュール冒頭）。
 *
 * **読み物の器に乗せる**（#590）。確認画面と同じ基準——本文全体が読ませる文で、押す口は末尾の
 * 「トップへ戻る」だけである（仕様 2.5.3 の「対象の画面」）。
 *
 * @param viewer いま見ている人の状態
 * @returns HTML
 */
export function renderWithdrawnPage(viewer: SiteViewer): string {
  return `${siteHead({ title: '退会の手続きが終わりました - Game Forge', noindex: true, viewer, reading: true })}
<div class="${READING_CLASS}">
<h1>退会の手続きが終わりました</h1>
<section class="gf-block gf-block-rows gf-work-settings" aria-label="退会の完了">
<div>
<p>ご利用ありがとうございました。</p>
<p>登録情報の削除は完了しています。<strong>作品の削除は、この後の処理が数分かけて進めます。</strong>取り下げた作品が一覧から消えるまで最大 1 分ほどかかることがあります。</p>
<p>同じ Google アカウントでもう一度参加するには、新しい招待コードが必要です。</p>
<p>ご不明な点は <a href="${CONTACT_MAILTO}">${CONTACT_EMAIL}</a> までご連絡ください（<a href="${PRIVACY_PATH}">プライバシーポリシー</a>）。</p>
<p><a href="${HOME_PATH}">トップへ戻る</a></p>
</div>
</section>
</div>
${siteFooter()}`;
}

/**
 * 断りの画面を組み立てる。
 *
 * **設定へ 303 で戻さない**（`src/work-delete.ts` の `renderDeleteRefusal` と同じ判断。
 * 戻すと、断られたことが URL にもステータスにも残らない）。
 *
 * @param refusal 断りの中身（{@link WITHDRAWAL_REFUSALS} の 1 行）
 * @param viewer いま見ている人の状態
 * @returns HTML
 */
export function renderWithdrawalRefusal(refusal: WithdrawalRefusal, viewer: SiteViewer): string {
  return `${siteHead({ title: `${refusal.heading} - Game Forge`, noindex: true, viewer })}
<h1>${refusal.heading}</h1>
<p class="gf-block">${refusal.body}</p>
<p><a href="${ACCOUNT_DETAILS_PATH}">設定へ戻る</a></p>
${siteFooter()}`;
}

/**
 * 退会の確認画面を返す（`GET /account/withdraw`）。
 *
 * **未ログインならログインへ送る**（`src/account.ts` の各タブと同じ扱い）。**管理者には 404**。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function showWithdrawConfirmation(request: Request, env: Env): Promise<Response> {
  const session = await resolveWithdrawalSession(request, env);
  if (!session.ok) {
    return session.reason === 'hidden'
      ? html(
          renderWithdrawalRefusal(
            WITHDRAWAL_REFUSALS.admin,
            siteViewerAt(ACCOUNT_WITHDRAW_PATH, true, null),
          ),
          WITHDRAWAL_REFUSALS.admin.status,
        )
      : await loginRequiredRedirect(env, ACCOUNT_WITHDRAW_PATH);
  }
  return html(
    renderWithdrawConfirmation(
      siteViewerAt(ACCOUNT_WITHDRAW_PATH, true, headerAvatarUrl(request, env, session.userId)),
    ),
  );
}

/**
 * 退会を実行する（`POST /api/account/withdraw`）。
 *
 * **本文を読まない**（載せるものが無い。`src/account.ts` の「アイコンを外す」と同じ）。
 *
 * **成功したらセッションの cookie を消して 303 で完了画面へ送る。** 押した端末のセッションは
 * これで消え、**別の端末に残ったセッションは `resolveSessionUser` と `resolveSiteViewer` が
 * 行を見て拒む**（署名付き cookie はサーバから失効できない。#518 の constraints）。
 *
 * **冪等である。** 既に退会済みの行で押し直しても、`withdrawUser` は成功を返す
 * （`WITHDRAWAL_ALREADY`）ので、同じ完了画面へ送る。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param now 現在時刻（UNIX 秒）を返す関数
 * @returns レスポンス
 */
async function handleWithdraw(request: Request, env: Env, now: () => number): Promise<Response> {
  const session = await resolveWithdrawalSession(request, env);
  if (!session.ok) {
    return session.reason === 'hidden'
      ? html(
          renderWithdrawalRefusal(
            WITHDRAWAL_REFUSALS.admin,
            siteViewerAt(ACCOUNT_WITHDRAW_PATH, true, null),
          ),
          WITHDRAWAL_REFUSALS.admin.status,
        )
      : await loginRequiredRedirect(env, ACCOUNT_WITHDRAW_PATH);
  }

  let outcome;
  try {
    outcome = await withdrawUser(env, session.userId, now());
  } catch (error) {
    // D1 / R2 の失敗。**打ち直せば続きから進む**ので、同じ画面へ案内する。
    // **利用者の値はログに出さない**（`src/account.ts` と同じ規律）。
    console.error(
      `[account-withdrawal] 退会に失敗しました: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return html(
      renderWithdrawalRefusal(
        WITHDRAWAL_REFUSALS.busy,
        siteViewerAt(ACCOUNT_WITHDRAW_PATH, true, null),
      ),
      500,
    );
  }

  if (outcome.ok) {
    // **MCP の接続（KV の許可）をすべて消す**（#696 / 仕様 5.15「退会」）。**確定の後に、口の側で行う**——
    // D1 と R2 の処理（`src/withdrawal.ts`）とは別の保存先で、あちらに混ぜると退会の段の説明が変わる。
    // **ベストエフォートである。** 消せなくても、トークンは使うたびの確認（`src/oauth-user.ts`）で止まり、
    // **退会の完了の段（cleanup の Worker。`src/withdrawal-purge.ts`）が、完了の印を立てる前に必ず消す。**
    // 失敗はログだけにし、退会の応答は変えない。
    await revokeOAuthGrantsAfterWithdrawal(env, session.userId);
    return new Response(null, {
      status: 303,
      headers: [
        ['location', ACCOUNT_WITHDRAWN_PATH],
        ['cache-control', 'no-store'],
        ['set-cookie', clearSessionCookie()],
      ],
    });
  }

  if (outcome.reason === 'not-found' || outcome.reason === 'banned') {
    // 掴む直前に行が消えた・BAN された。**理由を画面に出さない**（{@link WithdrawalRefusalReason}）。
    return await loginRequiredRedirect(env, ACCOUNT_WITHDRAW_PATH);
  }
  const refusal = WITHDRAWAL_REFUSALS[outcome.reason];
  return html(
    renderWithdrawalRefusal(refusal, siteViewerAt(ACCOUNT_WITHDRAW_PATH, true, null)),
    refusal.status,
  );
}

/**
 * 退会が確定した利用者の MCP の接続をすべて消す（#696）。**投げない**（失敗はログだけ）。
 *
 * @param env バインディングと環境変数
 * @param userId 退会した利用者の id
 */
async function revokeOAuthGrantsAfterWithdrawal(env: Env, userId: string): Promise<void> {
  try {
    await revokeAllOAuthGrants(env, userId);
  } catch (error) {
    console.error(
      `[account-withdrawal] MCP の接続を消せませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}

/**
 * 退会の経路を組み立てる（#518）。
 *
 * **時刻を差し替えられるのはここだけである**（`src/account.ts` の `createAccountRoutes` と
 * 同じ形）。
 *
 * @param options 差し替え
 * @returns 経路表
 */
export function createWithdrawalRoutes(
  options: { readonly now?: () => number } = {},
): readonly Route[] {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return [
    { method: 'GET', path: ACCOUNT_WITHDRAW_PATH, handler: showWithdrawConfirmation },
    {
      method: 'GET',
      path: ACCOUNT_WITHDRAWN_PATH,
      // **ログインを要求しない**（モジュール冒頭）。**本文は誰が開いても同じ**で、外枠だけが
      // ほかの全画面と同じ規則で出し分かれる（退会した行は未ログインへ倒る。`src/html.ts`）。
      handler: async (request, env) =>
        html(renderWithdrawnPage(await resolveSiteViewer(request, env))),
    },
    {
      method: 'POST',
      path: ACCOUNT_WITHDRAW_API_PATH,
      handler: (request, env) => handleWithdraw(request, env, now),
    },
  ];
}

/** アプリの経路表へ連結する退会の経路（#518）。 */
export const withdrawalRoutes: readonly Route[] = createWithdrawalRoutes();
