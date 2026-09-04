/**
 * 公開の操作（`POST /api/publish`）。**5.4 の「「公開」操作で初めて URL が有効になる」の
 * 実体である**（#26 / M4-1）。
 *
 * ## この経路が無かったあいだ何が起きていたか
 *
 * 生成の経路は `status='draft'` しか作らない（`src/games.ts`）。**公開する手段が
 * 無かったので、すべての作品が draft のままだった。** したがって `/g/<game_id>/` は
 * 誰にも使えず、作者が unlisted な `/p/<preview_key>/` を手で配る以外に共有の方法が
 * 無かった（docs/handoff.md 1 章）。この経路が、その 1 本目を通す。
 *
 * ## 4 つのことを同時に守る
 *
 * | 守るもの | どこで守るか |
 * |---|---|
 * | **作者本人だけが公開できる** | `publishGame` の `where author_id = ?`（`src/games.ts`） |
 * | **完成していない作品を公開できない** | 同 `where generation_state = 'ready'` |
 * | **二度押しで二重に撮影・課金しない** | 同 `where status = 'draft'`（2 通目は 0 行更新）＋ `claimOgpCapture` |
 * | **未公開の作品を撮らない** | `claimOgpCapture` の `where status = 'published'`（`src/ogp.ts`） |
 *
 * **すべて SQL の条件である。** この経路のハンドラは**公開の可否を 1 つも判定しない**
 * ——`publishGame` と `startOgpCapture` が返した値を、応答へ写しているだけである。
 * 呼び出し側の `if` で守る形にすると、経路を足した人が書き忘れても動作では気づけない
 * （`src/my-works.ts` が絞り込みを SQL に置いたのと同じ判断）。
 *
 * > **v1 の本文は「この経路のハンドラには 1 つも `if` が無い」と書いていた。**
 * > #36 で改造通知を足したときに `outcome.firstTime` を見る `if` が 1 つ増えたので、
 * > 言い方を改めた。**増えたのは「実際に公開したか」を読む分岐であって、公開してよいか
 * > の判定ではない**（それは今も 1 つ残らず SQL の側にある）。
 *
 * ## 改造の通知はここから起こす（5.5 / #36 / M5-5）
 *
 * **フォークが公開されたら、元の作者へメールを 1 通送る**（`src/mail/fork-notice.ts`）。
 * 契機は撮影とまったく同じ「**この呼び出しが実際に公開したとき**」で、条件も
 * `outcome.firstTime` 1 つである。
 *
 * **`publishGame`（`src/games.ts`）には置かない。** あれは `games` の 1 行を進める
 * だけの関数で、撮影の起動も置いていない（同関数の「OGP の撮影はここでは起こさない」）。
 * データ層へ外部への送信を持ち込むと、行を進めたい別の経路がそのたびにメールを撒く。
 *
 * **「誰に送るか」「送ってよいか」はここに書かない。** 親の作者の解決も、自分自身の
 * フォークの除外も、1 フォーク 1 通の抑止も、すべて `notifyForkPublished` の中にある。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）で、他サイトからの
 * POST には**そもそも cookie が乗らない**。`src/invite-issuance.ts` と同じ理由で
 * トークンを足していない。**cookie の属性を緩めるなら、その時点でここも見直すこと。**
 *
 * ## 公開の取り消しはこの issue の範囲に無い
 *
 * `published` → `draft` へ戻す経路を作らない。**戻せることにすると、共有された URL が
 * 黙って死ぬ**（拡散した先には取り消しが届かない）。8.4 の削除申請は `removed` という
 * 別の状態を持っており、そちらが「もう配らない」を表す。
 */
import { siteFooter } from './legal.js';
import { LOGIN_PATH } from './auth/google.js';
import type { PublishOutcome } from './games.js';
import { publishGame } from './games.js';
import type { ForkNoticeOutcome } from './mail/fork-notice.js';
import { notifyForkPublished } from './mail/fork-notice.js';
import type { StartOgpCapture } from './ogp-client.js';
import { startOgpCaptureOnLambda } from './ogp-client.js';
import type { CaptureStartOutcome } from './ogp.js';
import { startOgpCapture } from './ogp.js';
import { PUBLISH_GAME_ID_FIELD, PUBLISH_PATH } from './paths.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { workPagePath } from './work-page.js';

/**
 * 綴りの正本は `src/paths.ts` にある。
 *
 * **`/works/<id>/publish` にしない。** 作品ページは前方一致で登録されており
 * （`src/work-page.ts`）、その下に POST を足すと、経路表ではなくハンドラが
 * 「ページの要求か公開の要求か」を末尾で見分けることになる。**別の鍵にすれば、
 * 経路表が見分ける**（`src/ogp.ts` の画像パスと同じ判断）。
 *
 * 値そのものを `src/paths.ts` へ置いているのは、フォームを書く側
 * （`src/work-page.ts`）とここが互いを import すると循環参照になるためである。
 */

/**
 * 受け付ける本文の最大バイト数。
 *
 * **1 KiB。** 載るのは UUID 1 つだけ（`game_id=` ＋ 36 文字）である。
 * `src/generate-callback.ts` の 16 KiB はプロンプトが載るための値で、
 * **載らないものに合わせた上限を置かない。**
 */
const MAX_BODY_BYTES = 1024;

/**
 * 改造の通知を送る段（5.5 / #36）。
 *
 * **`StartOgpCapture` と同じ形で差し替えられるようにする。** テストは本物の送信を
 * 起こさずに「1 通だけか」「自分のフォークでは呼ばれないか」を見る必要がある
 * （`test/publish.test.ts`）。
 */
export type NotifyForkPublished = (env: Env, gameId: string) => Promise<ForkNoticeOutcome>;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 303 See Other を返す。
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
 * ブラウザのナビゲーションは `Accept` に `text/html` を明示するが、`fetch` の既定は
 * 明示しない（`src/invite-issuance.ts` / `src/waitlist.ts` と同じ判定）。素の
 * `<form method="post">` へ JSON を返すと、ブラウザが本文をそのまま表示してしまう。
 *
 * @param request 受信したリクエスト
 * @returns HTML を返すべきなら true
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * 断りの画面を返す。
 *
 * **作品ページへ 303 で戻さない。** 戻すと、公開できなかったことが URL にも
 * ステータスにも残らず、**利用者は「押したのに何も起きなかった」としか読めない。**
 *
 * @param heading 見出し
 * @param body 本文
 * @param status ステータスコード
 * @returns レスポンス
 */
function refusal(heading: string, body: string, status: number): Response {
  return html(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} - Game Forge</title>
<h1>${heading}</h1>
<p>${body}</p>
${siteFooter()}`,
    status,
  );
}

/** 断りの理由ごとの、ステータスと文言。 */
const REFUSALS: Readonly<
  Record<'not-found' | 'not-ready' | 'removed', { status: number; heading: string; body: string }>
> = {
  // **他人の作品と、存在しない作品を区別しない**（`src/games.ts` の `publishGame`）。
  'not-found': {
    status: 404,
    heading: '作品が見つかりません',
    body: 'URL が正しいかご確認ください。',
  },
  'not-ready': {
    status: 409,
    heading: 'まだ公開できません',
    body: 'この作品はまだ完成していません。生成が終わってからもう一度お試しください。',
  },
  removed: {
    status: 409,
    heading: '公開できません',
    body: 'この作品は公開を停止しています。',
  },
};

/**
 * 要求を受け付けられなかった理由。
 *
 * **`readLimitedText` が区別して返すものを、こちらで潰さない。** 上限を超えた本文は
 * 413（Payload Too Large）であり、400 にすると「送った内容が悪い」と読める——
 * 実際には**大きさだけ**の問題で、直し方が違う。
 *
 * 綴りと分け方は `src/ogp.ts` の `OgpCallbackRejection` に揃えてある。**同じ PR の
 * 2 つの入口が違う流儀になっていた**ので、あちらへ寄せた（#26 のレビュー指摘）。
 */
export type PublishRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'invalid-game-id';

/**
 * 断りの理由ごとのステータスと、画面に出す文言。
 *
 * **ステータスを分岐の式で書かない**（`reason === 'x' ? 415 : 400` の形にすると、
 * 理由を 1 つ足したときに既定の側へ黙って落ちる）。表にしておけば、足した理由は
 * ここに現れる。
 */
const BODY_REFUSALS: Readonly<Record<PublishRejection, { status: number; body: string }>> = {
  'unsupported-content-type': {
    status: 415,
    body: '要求の形式に対応していません。',
  },
  'body-too-large': {
    // **413 である。** 載るのは UUID 1 つだけ（{@link MAX_BODY_BYTES}）なので、
    // ここへ来るのは通常の操作ではない。
    status: 413,
    body: '要求が大きすぎます。',
  },
  'unreadable-body': {
    status: 400,
    body: '要求を最後まで受け取れませんでした。もう一度お試しください。',
  },
  'invalid-game-id': {
    status: 400,
    body: '要求の形が正しくありません。',
  },
};

/** 本文から取り出した対象。 */
type GameIdResult =
  | { readonly ok: true; readonly gameId: string }
  | { readonly ok: false; readonly reason: PublishRejection };

/**
 * 本文から対象の作品 id を取り出す。
 *
 * **形をここで確かめる。** 確かめずに SQL のプレースホルダへ渡しても injection には
 * ならないが、任意の文字列が D1 への問い合わせとして通ることになる
 * （`src/work-page.ts` / `src/sandbox-delivery.ts` と同じ方針）。
 *
 * @param request 受信したリクエスト
 * @returns 作品 id、または理由
 */
async function readGameId(request: Request): Promise<GameIdResult> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    // **理由をそのまま運ぶ。** `body-too-large` と `unreadable-body` は
    // `readLimitedText` が区別して返しており、こちらで潰す理由が無い。
    return { ok: false, reason: read.reason };
  }

  let raw: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    raw = new URLSearchParams(read.text).get(PUBLISH_GAME_ID_FIELD) ?? undefined;
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)[PUBLISH_GAME_ID_FIELD]
          : undefined;
    } catch {
      return { ok: false, reason: 'invalid-game-id' };
    }
  }

  if (typeof raw !== 'string' || !GAME_ID_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid-game-id' };
  }
  return { ok: true, gameId: raw };
}

/**
 * 公開の応答を組み立てる。
 *
 * @param request 受信したリクエスト
 * @param gameId 作品 id
 * @param outcome 公開の結果
 * @param capture 撮影の起動の結果（公開が成立しなかったときは null）
 * @returns レスポンス
 */
function respond(
  request: Request,
  gameId: string,
  outcome: PublishOutcome,
  capture: CaptureStartOutcome | null,
): Response {
  if (!outcome.ok) {
    const refused = REFUSALS[outcome.reason];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: outcome.reason }, refused.status);
  }

  if (wantsHtml(request)) {
    // POST-redirect-GET。公開の結果を同じ URL に描くと、再読み込みで再送信の確認が
    // 出る（`src/invite-issuance.ts` と同じ扱い）。**戻り先は作品ページ**で、
    // そこが公開後の共有 URL そのものになる（`src/work-page.ts`）。
    return seeOther(workPagePath(gameId));
  }

  return json(
    {
      published: true,
      // **二度押しを成功として返しつつ、区別できる形で返す。** 呼ぶ側が
      // 「実際に公開したのは自分か」を知りたい場面がある（撮影の起動もこれに従う）。
      firstPublish: outcome.firstTime,
      publishedAt: outcome.publishedAt,
      // 撮影は投げただけである（`src/ogp.ts`）。**撮れたとは言わない。**
      ogp: capture,
    },
    200,
  );
}

/**
 * 公開する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @param notify 改造の通知を送る段（既定は本物の送信）
 * @returns レスポンス
 */
async function handlePublish(
  request: Request,
  env: Env,
  start: StartOgpCapture,
  notify: NotifyForkPublished,
): Promise<Response> {
  const asHtml = wantsHtml(request);

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // 画面から来たならログインへ送る（`src/invite-issuance.ts` と同じ扱い）。
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameId(request);
  if (!target.ok) {
    const refused = BODY_REFUSALS[target.reason];
    return asHtml
      ? refusal('公開できません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await publishGame(env, target.gameId, session.userId);

  // **撮影は「この呼び出しが実際に公開したとき」だけ起こす**（5.4 の「公開時まで
  // 遅延する」）。二度押しの 2 回目で呼んでも `claimOgpCapture` が止めるが、
  // **止まることに依存して呼びに行かない。**
  const capture =
    outcome.ok && outcome.firstTime ? await startOgpCapture(env, target.gameId, start) : null;

  // **改造の通知も同じ条件で起こす**（5.5 / #36。上の撮影と同じ「実際に公開したとき
  // だけ」である）。**判定をここに増やさない**——「親を持つか」「自分のフォークか」
  // 「既に送ったか」はすべて `notifyForkPublished` の中にあり、この経路は
  // 「公開が成立したかどうか」しか知らない。
  //
  // **結果を応答へ載せない。** 公開の結果は公開の結果であって、元の作者へ通知が
  // 届いたかどうかは要求した側（改造した人）の関知するところではない。載せると、
  // 他人の宛先が有効かどうかを外から確かめる手掛かりになる。
  if (outcome.ok && outcome.firstTime) {
    await notify(env, target.gameId);
  }

  return respond(request, target.gameId, outcome, capture);
}

/**
 * 公開の経路を組み立てる。
 *
 * **撮影の段と通知の段を差し替えられるのはここだけである**（`src/generate-callback.ts` の
 * `createGenerateCallbackRoutes` と同じ形）。アプリの経路表（`src/app.ts`）は既定の
 * {@link publishRoutes} を連結するので、本番の結線は変わらない。
 *
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @param notify 改造の通知を送る段（既定は本物の送信）
 * @returns 経路表
 */
export function createPublishRoutes(
  start: StartOgpCapture = startOgpCaptureOnLambda,
  notify: NotifyForkPublished = notifyForkPublished,
): readonly Route[] {
  return [
    {
      method: 'POST',
      path: PUBLISH_PATH,
      handler: (request, env) => handlePublish(request, env, start, notify),
    },
  ];
}

/** アプリの経路表へ連結する公開の経路。 */
export const publishRoutes: readonly Route[] = createPublishRoutes();
