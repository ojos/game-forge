/**
 * 招待の発行経路と、発行のための最小の画面（8.1 / #91）。
 *
 * **発行の CRUD は `src/invites.ts` が持つ。ここが足すのは、それを呼ぶ手段だけである。**
 * M1 は招待の関数を実装したが呼び出し元が無く、「登録には招待が要る / 招待を発行するには
 * 利用者が要る / 利用者は 0 人」の循環を、本番 D1 への直接投入で 1 回だけ解除していた
 * （#89）。同じ手作業を 5 人目以降でも繰り返さないために、経路をコードとして置く。
 *
 * ## 認証必須である理由
 *
 * 招待枠は `users.id` に紐づく（`invites.issued_by` は `NOT NULL REFERENCES users(id)`）。
 * 未ログインでは枠の紐づけ先が無く、そもそも発行が成立しない。8.1 が「招待は既存参加者
 * への招待枠付与を基本とする」と定めるのもこの形であり、運用者だけが発行する経路には
 * しない。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）で、他サイトからの
 * POST には**そもそも cookie が乗らない**。したがって「他所のページに置かれたフォームで
 * 勝手に招待が発行される」形は成立せず、この経路にトークンを足していない。cookie の
 * 属性を緩める変更をするなら、その時点でここも見直すこと（属性が唯一の防御である）。
 *
 * ## 画面を Worker から返す
 *
 * `src/signup.ts` と同じ理由で、SSR の素の HTML に留める。9.3 の Next.js / Pages への
 * 寄せ方は M2-1 が持つ判断で、ここで先取りすると捨てる量が増える。JavaScript も
 * スタイルシートも要求しない。
 */
import { siteFooter } from './legal.js';
import type { InviteBalance } from './invite-balance.js';
import { INVITE_RECOVERY_DAYS, computeInviteBalance } from './invite-balance.js';
import { formatInviteCode, isInviteExpired } from './invite-code.js';
import type { InviteRecord } from './invites.js';
import { issueInvite, listIssuedInvites } from './invites.js';
import { participantCapReached, PARTICIPANT_CAP } from './participant-cap.js';
import { inviteQuotaHalted } from './reports.js';
import type { Route, RouteHandler } from './routes.js';
import { html, json } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { escapeHtml, headerAvatarUrl, siteHead, siteViewerAt } from './html.js';
import { formatJstMinutes, toIsoTimestamp } from './jst.js';
import { HOME_PATH } from './home.js';
import { INVITES_PATH, SIGNUP_PATH } from './paths.js';
import { loginRequiredRedirect } from './auth/google.js';

/**
 * 1 人あたりの招待枠が**溜まる上限**（8.1 v1.55 / #396）。
 *
 * **総数の上限ではない。** 枠は使うと `INVITE_RECOVERY_DAYS` 日ごとに 1 本ずつ戻り、この本数まで
 * 溜まる（計算は `src/invite-balance.ts`）。#396 より前は「発行できる総数」で、使い終わった枠は
 * 戻らなかった。**値（3）は変えていない**——変わったのは意味だけである。
 *
 * **環境変数にしない。** 招待枠は 8.1 が定めるコミュニティの設計そのもので、環境ごとに
 * 違ってよい値ではない。変えるときは仕様書の記述とこの定数を同時に変える（両者の一致は
 * `test/invite-issuance.test.ts` が機械照合する）。
 *
 * 3 本にした根拠は 2 つある。ひとつは 7.3 で、招待が費用 DoS に対する一次の防波堤である以上、
 * 1 人あたりの枠は「呼びたい人を呼べる」最小限でよいこと。数十人規模のクローズドβ
 * （2.1）では、3 本 × 招待の連鎖で十分に広がる。もうひとつは、人数に効くのが**発行を止める
 * アプリ側の上限（参加者 50 人）**（8.1 / `src/participant-cap.ts`）だけになったこと。
 * 上限に達すると誰も発行できないので、1 人あたりの枠を大きくしても発行が早く止まるだけである
 * （**実人数の天井ではない**——上限の前に発行された未使用のコードの分だけ 50 人を超えうる）。
 *
 * #478 までは、後者の代わりに「Google の同意画面を Testing で運用しているので、Google 側の
 * 人数の上限（100 人）が全体の天井として先に効く」を根拠にしていた。**2026-09-14 に本番環境へ
 * 切り替えて、Google 側の天井は無くなった**（8.1 v1.70）。値（3）は変えていない。
 *
 * **戻る速さだけでは費用の上限を守れない**（全員が使えば人数は倍々に増える。8.1 の試算）。
 * 全体の人数の上限は `src/participant-cap.ts`（#397）が持つ。
 */
export const INVITE_QUOTA = 3;

/**
 * 招待の発行と一覧の API（確定22 で `/api/*` が正）。
 *
 * 画面のパス（`INVITES_PATH`）とは分ける。片方は JSON を返す API、もう片方は HTML を
 * 返す画面で、同じパスに同居させると `Accept` の中身で応答の種類が変わる経路になる。
 */
export const INVITES_API_PATH = '/api/invites';

/**
 * 画面に出す文言の対応表。
 *
 * `src/signup.ts` の `REASON_MESSAGES` と同じ方針で、**`reason` を画面へそのまま
 * 流さない**。この値は query から来るため、未知の値を出力へ通すと反射型の差し込みに
 * なる。表に無いものは既定の文言へ倒す。
 */
const REASON_MESSAGES: Readonly<Record<string, string>> = {
  'quota-exhausted': `招待枠を使い切りました。枠は ${INVITE_RECOVERY_DAYS} 日ごとに 1 本ずつ戻ります。`,
  // 7.3 の「BAN 時に招待元の招待枠を停止する」（#40）。**「使い切った」と混ぜない**
  // ——利用者にできることが違う（使い切った枠は待てば戻るが、こちらは運用の判断による）。
  'quota-halted':
    '招待枠を停止しています。招待した方の利用が停止されたためです。お心当たりがない場合はお問い合わせください。',
  // 8.1 の人数の上限（#397）。**利用者にできることが違う**——自分の枠でも自分の招待でもなく、
  // サービス全体の状態である。招待したい相手には待機リストを案内してもらう（画面の本文が導く）。
  'participant-cap': `参加者が上限（${PARTICIPANT_CAP} 人）に達したため、いまは招待を発行できません。`,
  failed: '招待を発行できませんでした。時間をおいて試してください。',
};

/** 既定の文言。未知の `reason` を受けたときに使う。 */
const DEFAULT_REASON_MESSAGE = '招待を発行できませんでした。';

/**
 * 招待を発行できない理由のうち、**本人の残高によらないもの**。
 *
 * - `participant-cap`: 参加者が上限に達した（8.1 / #397）
 * - `quota-halted`: 招待した相手が BAN され、招待枠が止まっている（7.3 / #40）
 */
type IssuanceHalt = 'participant-cap' | 'quota-halted';

/**
 * 発行を止める理由があるかを調べる（画面・一覧の API・発行の口が同じものを使う）。
 *
 * **3 か所で別々に判定しない。** 画面だけがこれを見ないと、押しても必ず断られるボタンが出る
 * （#396 までは停止中の画面がそうだった）。口だけが見ないと、画面が隠したものを直接の POST が通す。
 *
 * **人数の上限を先に見る。** どちらも発行を止めるが、上限はサービス全体の状態で、画面は
 * 待機リストへの導線を出す必要がある。停止のほうは、本人に関わる運用の判断である。
 * 2 本の読み取りは独立しているので並べて送る。
 *
 * @param env バインディングと環境変数
 * @param userId 発行しようとしている利用者
 * @returns 止める理由。無ければ null
 * @throws D1 の失敗
 */
async function issuanceHalt(env: Env, userId: string): Promise<IssuanceHalt | null> {
  const [capReached, halted] = await Promise.all([
    participantCapReached(env.DB),
    inviteQuotaHalted(env, userId),
  ]);
  if (capReached) {
    return 'participant-cap';
  }
  return halted ? 'quota-halted' : null;
}

/**
 * 発行を止めている理由を、画面の本文として組み立てる。
 *
 * **人数の上限では、待機リストへの導線を出す**（8.1 / #397）。招待を渡せない相手が次に
 * 取れる行動は、登録の画面から待機リストに登録することだけである。
 *
 * @param halt 止めている理由
 * @returns HTML の断片
 */
function haltNotice(halt: IssuanceHalt): string {
  // **残りの本数と同じブロックの中の段落にする**（#473。{@link invitePage}）。面の上にもう 1 段の知らせの形を重ねない。
  if (halt === 'participant-cap') {
    return `<p><strong>参加者が上限（${PARTICIPANT_CAP} 人）に達したため、いまは招待を発行できません。</strong>
   招待したい方には、<a href="${SIGNUP_PATH}">登録の画面</a>から待機リストに登録してもらってください。
   枠が空いたらご連絡します。</p>`;
  }
  return `<p>${escapeHtml(reasonMessage(halt))}</p>`;
}

/** 招待 1 本の表示用の状態。 */
type InviteState = '未使用' | '使用済み' | '期限切れ';

/**
 * 招待の状態を表示用に決める。
 *
 * 期限の判定は `isInviteExpired`（SQL の外で使う判定）に寄せる。ここで
 * `expiresAt < now` のような比較を書き下すと、境界規約（失効時刻を含めて失効）の
 * 写しが 3 か所目になる。
 *
 * @param invite 招待の行
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 表示用の状態
 */
function inviteState(invite: InviteRecord, nowSeconds: number): InviteState {
  if (invite.usedBy !== null) {
    return '使用済み';
  }
  return isInviteExpired(invite.expiresAt, nowSeconds) ? '期限切れ' : '未使用';
}

/**
 * 自分の招待の一覧から、残高を計算する。
 *
 * **D1 を引き直さない。** 一覧は発行時刻を持っており（`InviteRecord.issuedAt`）、同じ行を
 * もう一度読むのは D1 の読み取りを 2 倍にするだけになる（3.6）。
 *
 * @param invites 自分が発行した招待
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 残高と次に戻る時刻
 */
function balanceOf(invites: readonly InviteRecord[], nowSeconds: number): InviteBalance {
  return computeInviteBalance(
    invites.map((invite) => invite.issuedAt),
    INVITE_QUOTA,
    nowSeconds,
  );
}

/**
 * 残高の 1 文を組み立てる（「いま何本」と「次の 1 本が戻る日時」。8.1）。
 *
 * **戻る日時は分まで出す。** 日付だけだと、その日の朝に開いた人には「今日のはずなのに
 * 0 本」と見える。日時は日本時間で出し、機械が読む `datetime` には UTC の絶対時刻を入れる
 * （`src/jst.ts`）。
 *
 * @param balance 残高
 * @returns HTML の断片
 */
function balanceLine(balance: InviteBalance): string {
  const next =
    balance.nextRecoveryAt === null
      ? ''
      : ` 次の 1 本は <time datetime="${toIsoTimestamp(balance.nextRecoveryAt)}">${formatJstMinutes(balance.nextRecoveryAt)}</time> に戻ります。`;
  return `<p>招待枠は 1 人 ${INVITE_QUOTA} 本まで溜まり、使うと ${INVITE_RECOVERY_DAYS} 日ごとに 1 本ずつ戻ります。</p>
<p>いま発行できるのは <strong>${balance.available} 本</strong>です。${next}</p>`;
}

/**
 * 招待の画面を組み立てる。
 *
 * @param invites 自分が発行した招待（コード順）
 * @param message 画面上部に出す文言（無ければ null）
 * @param halt 発行を止めている理由（無ければ null）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @param headerAvatar ヘッダのアバターの画像の URL（#380）
 * @returns HTML
 */
function invitePage(
  invites: readonly InviteRecord[],
  message: string | null,
  halt: IssuanceHalt | null,
  nowSeconds: number,
  headerAvatar: string | null,
): string {
  // 文言は上の対応表から選んだ固定文字列だが、`escapeHtml` を通しておく
  // （`src/signup.ts` と同じ理由。引数の出どころが変わっても安全側が既定になる）。
  const error = message === null ? '' : `<p class="error" role="alert">${escapeHtml(message)}</p>`;

  const balance = balanceOf(invites, nowSeconds);

  // 発行できるときだけフォームを出す。押しても必ず断られるボタンを出すと、
  // 利用者から見て「壊れている」ことと「枠が無い」ことの区別がつかない（4.4）。
  // **止めている理由を、枠の残りより先に見る**——枠が残っていても、上限や停止では断られる。
  const form =
    halt !== null
      ? haltNotice(halt)
      : balance.available > 0
        ? `<form method="post" action="${INVITES_API_PATH}">
  <button type="submit" class="gf-button gf-button-primary">招待コードを 1 本発行する</button>
</form>`
        : '<p>招待枠を使い切りました。</p>';

  // コードは正規形（英数字のみ）だが、`escapeHtml` を通す。ここが D1 から来る値を
  // HTML へ入れる唯一の場所であり、「中身は安全なはず」を根拠にしない。
  const list =
    invites.length === 0
      ? '<p>まだ招待を発行していません。</p>'
      : `<ul class="gf-block gf-block-rows gf-invites">
${invites
  .map(
    (invite) =>
      `  <li><code>${escapeHtml(formatInviteCode(invite.code))}</code> <span class="gf-chip">${inviteState(invite, nowSeconds)}</span></li>`,
  )
  .join('\n')}
</ul>`;

  // **ログイン済みとして組む**（`src/my-works.ts` と同じ扱い。2.3.7 / #331）。
  //
  // **コードを渡す前の手順は案内しない**（#478）。2026-09-14 に Google OAuth を本番環境へ
  // 切り替えたので、コードを渡すだけで相手は登録できる（8.1）。#478 までは、Google Console への
  // 手登録を促す節をここに置いていた——参加者は Console を触れないうえ、もう要らない作業である。
  //
  // **残りの本数と「招待コードを 1 本発行する」（主のボタン）を 1 つのブロックに、発行した招待をブロックの行にし、状態
  // （未使用・使用済み・期限切れ）をチップにする**（仕様 2.5.4 / 2.5.5 / #473。承認したモックアップ Version 6）。**主はこの画面で
  // この 1 つだけ**で、発行を止めているときと使い切ったときは主のボタンを出さない（上）。状態のチップは押せない札で、
  // どれも地を塗らない（まだ動いている状態ではない）。
  return `${siteHead({ title: '招待を発行する', viewer: siteViewerAt(INVITES_PATH, true, headerAvatar) })}
<h1>招待を発行する</h1>
${error}
<div class="gf-block gf-invite-balance">
${balanceLine(balance)}
${form}
</div>

<h2>発行した招待</h2>
${list}

${siteFooter()}
`;
}

/**
 * 分類から画面に出す文言を選ぶ。
 *
 * @param reason query から受け取った分類
 * @returns 画面に出す文言
 */
function reasonMessage(reason: string): string {
  return REASON_MESSAGES[reason] ?? DEFAULT_REASON_MESSAGE;
}

/**
 * 303 See Other を返す。
 *
 * 302 ではなく 303 を使う理由は `src/waitlist.ts` の `redirectTo` と同じで、302 に
 * 対するブラウザの実装は POST を POST のまま追う余地があり、遷移先で同じ要求が
 * 再送されうる。**招待の発行は行を作る操作**なので、再送は枠の空撃ちになる。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 要求がブラウザのナビゲーションかを判定する。
 *
 * ブラウザのナビゲーションは `Accept` に `text/html` を明示するが、`fetch` の既定
 * （すべてを受け付けるワイルドカード）は明示しない（`src/waitlist.ts` と同じ判定）。
 * 素の `<form method="post">` へ JSON を返すと、ブラウザが本文をそのまま表示してしまう。
 *
 * @param request 受信したリクエスト
 * @returns HTML を返すべきなら true
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * 招待の画面を返す。
 *
 * 未ログインならログインへ送る。画面に対して 401 の JSON を返しても、利用者にできる
 * ことは結局ログインなので、そこまでを 1 往復で済ませる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const showInvitePage: RouteHandler = async (request, env) => {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // ログイン後はこの画面へ戻す（2.3.11 / #374）。
    return await loginRequiredRedirect(env, INVITES_PATH);
  }

  const [invites, halt] = await Promise.all([
    listIssuedInvites(env.DB, session.userId),
    issuanceHalt(env, session.userId),
  ]);
  const reason = new URL(request.url).searchParams.get('reason');
  // 断られた理由が、いま止めている理由と同じなら上部の文言を出さない。本文（`haltNotice`）が
  // 同じことを言っており、2 回並ぶだけになる。
  const message = reason === null || reason === halt ? null : reasonMessage(reason);
  // 失敗の後始末で開かれた画面には、失敗のステータスを付ける（`src/signup.ts` の
  // `GET /signup?reason=` と同じ扱い）。成功したかのようにログへ残さない。
  return html(
    invitePage(invites, message, halt, nowSeconds(), headerAvatarUrl(request, env, session.userId)),
    reason === null ? 200 : 400,
  );
};

/**
 * 自分が発行した招待の一覧と残枠を返す（API）。
 *
 * **残枠を D1 から数え直さない。** 一覧が発行時刻を持っているので、そこから計算する
 * （`balanceOf`）。
 *
 * `quota` は**溜まる上限**（#396 より前は発行の総数）、`remaining` は**いま発行できる本数**、
 * `nextRecoveryAt` は次の 1 本が戻る時刻（UNIX 秒。満杯なら null）、`halt` は残高によらず
 * 発行を止めている理由（`participant-cap` / `quota-halted`。無ければ null。#397）である。
 * **`halt` があるとき、`remaining` が 1 以上でも発行は断られる。**
 *
 * **`used_by` をそのまま返さない。** 誰が使ったかは招待者に見える情報だが、返すのは
 * 他人の `users.id` そのものであり、この画面が必要としているのは「使われたかどうか」
 * だけである。系統の表示は 5.5 が別に持つ。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const listInvites: RouteHandler = async (request, env) => {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return json({ error: 'unauthorized' }, 401);
  }

  const [invites, halt] = await Promise.all([
    listIssuedInvites(env.DB, session.userId),
    issuanceHalt(env, session.userId),
  ]);
  const now = nowSeconds();
  const balance = balanceOf(invites, now);
  return json({
    quota: INVITE_QUOTA,
    issued: invites.length,
    remaining: balance.available,
    nextRecoveryAt: balance.nextRecoveryAt,
    halt,
    invites: invites.map((invite) => ({
      code: invite.code,
      state: inviteState(invite, now),
      usedAt: invite.usedAt,
      expiresAt: invite.expiresAt,
    })),
  });
};

/**
 * 招待を 1 本発行する。
 *
 * **枠の判定を呼び出し側で行わない。** `issueInvite` は残高の判定を INSERT の `WHERE`
 * で守っており（`src/invites.ts`）、ここで「数えてから入れる」形にすると、同時に 2 本
 * 送られたときに上限を超える。断られたかどうかは戻り値だけで決める。
 *
 * 本文を読まないのは、発行に**引数が無い**ためである。受け取らない値のために
 * `Content-Type` や本文の検査を置くと、素のフォームからの空の POST を弾く条件を
 * 増やすだけになる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const handleIssueInvite: RouteHandler = async (request, env) => {
  const asHtml = wantsHtml(request);

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // 未ログインでは `invites` に行を作らない（枠の紐づけ先が無い）。画面から来た
    // 場合はログインへ送り、API には 401 を返す。
    return asHtml
      ? await loginRequiredRedirect(env, INVITES_PATH)
      : json({ error: 'unauthorized' }, 401);
  }

  try {
    const halt = await issuanceHalt(env, session.userId);
    if (halt === 'participant-cap') {
      // 8.1 の人数の上限（#397）。**行を作らずに断る。** 409 を使う——待っても解けない
      // （人数は減らない。上限を見直すのは運営の判断である）ので、429 ではない。
      // **判定は INSERT に閉じ込めない**（緩い締め切り。`src/participant-cap.ts`）。
      return asHtml
        ? seeOther(`${INVITES_PATH}?reason=participant-cap`)
        : json({ error: 'participant-cap', cap: PARTICIPANT_CAP }, 409);
    }
    // 7.3 の招待枠の停止（#40）。**`issueInvite` は枠を引数で受ける**ので、
    // 止めることは「0 を渡す」ことに等しい。**別の分岐を足さない**——枠の判定を
    // INSERT の `WHERE` に閉じ込めた設計（`src/invites.ts`）がそのまま効く。
    const halted = halt === 'quota-halted';
    const quota = halted ? 0 : INVITE_QUOTA;
    const now = nowSeconds();
    const issued = await issueInvite(env.DB, session.userId, quota, null, now);
    if (!issued.ok) {
      // **「使い切った」と「止められた」を分けて返す。** `issueInvite` はどちらも
      // `quota-exhausted` として返す（あちらは理由を知らない）ので、ここで言い分ける。
      if (halted) {
        // 409 のまま。**停止は待っても解けない**（運用の判断による。#40）ので、
        // 待てば解けることを意味する 429 を返さない。
        return asHtml
          ? seeOther(`${INVITES_PATH}?reason=quota-halted`)
          : json({ error: 'quota-halted', quota, remaining: 0 }, 409);
      }
      // **使い切ったほうは 429 にする**（#396）。#396 より前は、招待枠が総数の上限で
      // **待っても戻らない**ことを理由に 409 を返していた。枠は時間で戻るようになったので、
      // その理由は成り立たない。429 は「時間あたりの制限。待てば解ける」を意味し、
      // **`Retry-After` で次の 1 本が戻るまでの秒数を示せる**。
      return asHtml
        ? seeOther(`${INVITES_PATH}?reason=${issued.reason}`)
        : quotaExhausted(issued.balance, quota, now);
    }
    if (asHtml) {
      // POST-redirect-GET。発行の結果を同じ URL に描くと、再読み込みで再送信の確認が
      // 出て、利用者が枠を空撃ちすることになる。
      return seeOther(INVITES_PATH);
    }
    // 表示用の区切りを入れた形は返さない。コードの正は正規形であり（`invites.code`）、
    // 2 つの表現を返すと、受け取った側がどちらを配ればよいか決められなくなる。
    // 区切りは表示する側が `formatInviteCode` で足す。
    return json(
      {
        code: issued.invite.code,
        quota: INVITE_QUOTA,
        // 発行した後の残高。**D1 から数え直さない**（`issueInvite` が入れた行を知っている）。
        remaining: issued.balance.available,
        nextRecoveryAt: issued.balance.nextRecoveryAt,
      },
      201,
    );
  } catch (error) {
    // D1 の失敗（接続不良・制約違反）。`issueInvite` はこれを握り潰さずに投げてくるので、
    // 「枠が尽きた」と混同しないよう別の応答にする。
    console.error(`[invites] 招待の発行に失敗しました: ${describeIssueError(error)}`);
    return asHtml
      ? seeOther(`${INVITES_PATH}?reason=failed`)
      : json({ error: 'internal error' }, 500);
  }
};

/**
 * 招待枠を使い切ったときの応答（API。429）を組み立てる。
 *
 * `Retry-After` は**秒数**で入れる（HTTP 日付の形も許されるが、時計のずれに左右されない）。
 * 次に戻る時刻が無い（容量 0 など）ときは付けない——待っても解けないのに「待て」と言わない。
 *
 * @param balance 断った時点の残高
 * @param quota 判定に使った容量
 * @param nowSeconds 判定に使った現在時刻（UNIX 秒）
 * @returns レスポンス
 */
function quotaExhausted(balance: InviteBalance, quota: number, nowSeconds: number): Response {
  const headers: Record<string, string> =
    balance.nextRecoveryAt === null
      ? {}
      : { 'retry-after': String(Math.max(1, balance.nextRecoveryAt - nowSeconds)) };
  return json(
    {
      error: 'quota-exhausted',
      quota,
      remaining: balance.available,
      nextRecoveryAt: balance.nextRecoveryAt,
    },
    429,
    headers,
  );
}

/**
 * 例外を、ログへ出してよい 1 行の文字列へ落とす。
 *
 * 生の `error` を渡すと、スタックや `cause` の連鎖を通じて、こちらが決めていない情報が
 * ログへ入る（`src/routes.ts` の `describeBodyError` と同じ方針）。
 *
 * `message` は残す。**招待コードは D1 のメッセージに現れない**（SQLite が返すのは
 * 「UNIQUE constraint failed: invites.code」のように列名までで、値を含まない）一方、
 * 「枠が尽きた」ではない失敗の原因はここにしか出ない。
 *
 * @param error catch した値（型は unknown）
 * @returns ログに残してよい 1 行
 */
function describeIssueError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 現在時刻（UNIX 秒）。
 *
 * 表示用の期限判定と、招待枠の残高の計算・発行時刻に使う。消費の可否は SQL 側の
 * 条件が正である（`src/invites.ts` の `consumeInvite`）。
 *
 * @returns UNIX 秒
 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 招待の発行の経路。
 *
 * `src/app.ts` の `createAppRoutes` へ 1 行で連結する。ハンドラの本文を `src/app.ts`
 * へ書き足さないのは、並行する PR が同じ行を取り合わないようにするためである
 * （`src/routes.ts` が経路を表にしている理由そのもの）。
 */
export const inviteRoutes: readonly Route[] = [
  { method: 'GET', path: INVITES_PATH, handler: showInvitePage },
  { method: 'GET', path: INVITES_API_PATH, handler: listInvites },
  { method: 'POST', path: INVITES_API_PATH, handler: handleIssueInvite },
];
