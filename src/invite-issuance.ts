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
import { formatInviteCode, isInviteExpired } from './invite-code.js';
import type { InviteRecord } from './invites.js';
import { issueInvite, listIssuedInvites, remainingInviteQuota } from './invites.js';
import type { Route, RouteHandler } from './routes.js';
import { html, json } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { escapeHtml } from './signup.js';
import { HOME_PATH } from './home.js';
import { INVITES_PATH } from './paths.js';
import { LOGIN_PATH } from './auth/google.js';

/**
 * 1 人あたりの招待枠（発行できる総数）。
 *
 * **環境変数にしない。** 招待枠は 8.1 が定めるコミュニティの設計そのもので、環境ごとに
 * 違ってよい値ではない。変えるときは仕様書の記述とこの定数を同時に変える（両者の一致は
 * `test/invite-issuance.test.ts` が機械照合する）。
 *
 * 3 本にした根拠は 2 つある。ひとつは 8.1 の Testing 運用で、招待するたびに Google
 * Console へテストユーザーを手登録する必要があり、**上限 100 人が全体の天井として先に
 * 効く**こと。もうひとつは 7.3 で、招待が費用 DoS に対する一次の防波堤である以上、
 * 1 人あたりの枠は「呼びたい人を呼べる」最小限でよいこと。数十人規模のクローズドβ
 * （2.1）では、3 本 × 招待の連鎖で十分に広がる。
 *
 * 使い終わった枠は戻らない（`countIssuedInvites` が使用済みも数える理由）。
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
  'quota-exhausted': `招待枠を使い切りました（1 人 ${INVITE_QUOTA} 本まで）。`,
  failed: '招待を発行できませんでした。時間をおいて試してください。',
};

/** 既定の文言。未知の `reason` を受けたときに使う。 */
const DEFAULT_REASON_MESSAGE = '招待を発行できませんでした。';

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
 * 招待の画面を組み立てる。
 *
 * @param invites 自分が発行した招待（コード順）
 * @param message 画面上部に出す文言（無ければ null）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns HTML
 */
function invitePage(
  invites: readonly InviteRecord[],
  message: string | null,
  nowSeconds: number,
): string {
  // 文言は上の対応表から選んだ固定文字列だが、`escapeHtml` を通しておく
  // （`src/signup.ts` と同じ理由。引数の出どころが変わっても安全側が既定になる）。
  const error = message === null ? '' : `<p class="error" role="alert">${escapeHtml(message)}</p>`;

  const remaining = Math.max(0, INVITE_QUOTA - invites.length);

  // 枠が残っているときだけフォームを出す。押しても必ず断られるボタンを出すと、
  // 利用者から見て「壊れている」ことと「枠が無い」ことの区別がつかない。
  const form =
    remaining > 0
      ? `<form method="post" action="${INVITES_API_PATH}">
  <button type="submit">招待コードを 1 本発行する</button>
</form>`
      : '<p>招待枠を使い切りました。</p>';

  // コードは正規形（英数字のみ）だが、`escapeHtml` を通す。ここが D1 から来る値を
  // HTML へ入れる唯一の場所であり、「中身は安全なはず」を根拠にしない。
  const list =
    invites.length === 0
      ? '<p>まだ招待を発行していません。</p>'
      : `<ul>
${invites
  .map(
    (invite) =>
      `  <li><code>${escapeHtml(formatInviteCode(invite.code))}</code> — ${inviteState(invite, nowSeconds)}</li>`,
  )
  .join('\n')}
</ul>`;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>招待を発行する</title>
<h1>招待を発行する</h1>
${error}
<p>招待枠は 1 人 ${INVITE_QUOTA} 本です。残り ${remaining} 本（発行済み ${invites.length} 本）。</p>
${form}

<h2>発行した招待</h2>
${list}

<h2>コードを渡す前に</h2>
<p><strong>招待する相手のメールアドレスを、Google Cloud Console のテストユーザーへ登録してください。</strong>
   クローズドβの間、Google の同意画面は Testing のまま運用しているため、登録が無い相手は
   コードを持っていても Google のログイン画面に到達できません（8.1）。</p>

<p><a href="${HOME_PATH}">トップへ戻る</a></p>
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
    return seeOther(LOGIN_PATH);
  }

  const invites = await listIssuedInvites(env.DB, session.userId);
  const reason = new URL(request.url).searchParams.get('reason');
  const message = reason === null ? null : reasonMessage(reason);
  // 失敗の後始末で開かれた画面には、失敗のステータスを付ける（`src/signup.ts` の
  // `GET /signup?reason=` と同じ扱い）。成功したかのようにログへ残さない。
  return html(invitePage(invites, message, nowSeconds()), reason === null ? 200 : 400);
};

/**
 * 自分が発行した招待の一覧と残枠を返す（API）。
 *
 * **残枠を `remainingInviteQuota` で数え直さない。** 一覧を引いた時点で発行済みの
 * 件数は分かっており、同じ行をもう一度 `count(*)` で数えるのは D1 の読み取りを 2 倍に
 * するだけになる（3.6）。
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

  const invites = await listIssuedInvites(env.DB, session.userId);
  const now = nowSeconds();
  return json({
    quota: INVITE_QUOTA,
    issued: invites.length,
    remaining: Math.max(0, INVITE_QUOTA - invites.length),
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
 * **枠の判定を呼び出し側で行わない。** `issueInvite` は件数の判定を INSERT の `WHERE`
 * へ畳んであり、ここで「数えてから入れる」形にすると、同時に 2 本送られたときに上限を
 * 超える。断られたかどうかは戻り値だけで決める。
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
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  try {
    const issued = await issueInvite(env.DB, session.userId, INVITE_QUOTA);
    if (!issued.ok) {
      // 409 を使う。429（Too Many Requests）は時間あたりの制限に対する応答で、
      // 待てば解けることを意味するが、招待枠は**総数**の上限であり待っても戻らない。
      return asHtml
        ? seeOther(`${INVITES_PATH}?reason=${issued.reason}`)
        : json({ error: issued.reason, quota: INVITE_QUOTA, remaining: 0 }, 409);
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
        remaining: await remainingInviteQuota(env.DB, session.userId, INVITE_QUOTA),
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
 * 表示用の期限判定にしか使わない。消費の可否は SQL 側の条件が正である
 * （`src/invites.ts` の `consumeInvite`）。
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
