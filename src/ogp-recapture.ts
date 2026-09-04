/**
 * 中断したままの OGP 撮影を撮り直す口（`POST /api/ogp/recapture`。5.4 / #235）。
 *
 * # なぜ口が要るのか
 *
 * 撮影関数は**自分で諦めたときは必ず失敗のコールバックを送る**
 * （`docker/ogp-shot/index.mjs` が `{"error":"capture-failed"}` を送り、`failOgpCapture`
 * が `failed` へ落とす）。**残るのは、送る余地が無かった場合だけ**である——Lambda の
 * タイムアウト（60 秒）で切られた、メモリ不足でプロセスごと死んだ、送信中に切られた。
 *
 * この 3 つでは `games.ogp_state` が **`capturing` のまま残り**、二度撮りの関門
 * （`ogp_state is null`。`src/ogp.ts`）に阻まれて**公開操作からは二度と撮影されない。**
 * これまで進める手段は**本番 D1 への手作業の `UPDATE` だけ**だった
 * （`docs/ogp-capture.md` 7 章）。
 *
 * # なぜ「作者が押す」形なのか
 *
 * 置ける場所は 3 つあり、**採れたのは 1 つだけ**である。
 *
 * | 案 | 採らなかった理由 |
 * |---|---|
 * | 定期実行（cron）で自動回収 | **Pages に `scheduled` は無い**（確定22 でこのプロジェクトは Workers ではなく Pages である。`wrangler.toml`）。口を置く場所そのものが無い |
 * | 作品ページを開いたら回収する | **GET が状態を書き換える形にしない**（`src/work-page.ts` の `STALE_AFTER_SECONDS`）。ページを開いた人が行を壊せることになる |
 * | 運用スクリプトから本番 D1 を直接 UPDATE | **関門の SQL が `src/ogp.ts` の外にもう 1 本できる。** #26 が「撮影の権利は 1 本の UPDATE を通った者だけが得る」と決めた形が崩れる |
 *
 * **押すのは作者本人である。** 判定（誰が・どの行を・いつ掴めるか）は
 * `reclaimStaleOgpCapture` の SQL 1 本が持ち、この経路は**そこへ運ぶだけ**である。
 *
 * # 連打しても費用は増えない
 *
 * 掴み直した瞬間に `ogp_started_at` が現在時刻へ動くので、**同じ行で実際に撮影が
 * 走るのは `OGP_STALE_AFTER_SECONDS`（900 秒）に 1 回だけ**である（`src/ogp.ts`）。
 * ボタンの無効化にも、別のクォータにも依存しない。
 *
 * # 生成の枠は使わない
 *
 * 撮影は LLM を呼ばない（1 枚 約 0.1 円。`docs/ogp-capture.md` 8 章）。台帳
 * （`generations`）に行は増えず、**確定25 の日次 12 回にも当たらない。** 公開そのものが
 * 枠を使わないのと同じ扱いである。
 *
 * # CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）なので、他サイトからの
 * POST には cookie が乗らない。`src/publish.ts` と同じ理由でトークンを足していない。
 */
import { siteFooter } from './legal.js';
import { LOGIN_PATH } from './auth/google.js';
import type { StartOgpCapture } from './ogp-client.js';
import { startOgpCaptureOnLambda } from './ogp-client.js';
import type { CaptureStartOutcome } from './ogp.js';
import { startOgpRecapture } from './ogp.js';
import { OGP_RECAPTURE_GAME_ID_FIELD, OGP_RECAPTURE_PATH } from './paths.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { workPagePath } from './work-page.js';

/**
 * 受け付ける本文の最大バイト数。
 *
 * **1 KiB。** 載るのは UUID 1 つだけである（`src/publish.ts` と同じ値・同じ理由）。
 */
const MAX_BODY_BYTES = 1024;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * 要求を受け付けられなかった理由。
 *
 * 綴りと分け方は `src/publish.ts` の `PublishRejection` に揃えてある。
 */
export type RecaptureRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'invalid-game-id';

/**
 * 断りの理由ごとのステータスと文言。
 *
 * **ステータスを分岐の式で書かない**（`src/publish.ts` の `BODY_REFUSALS` と同じ理由。
 * 理由を 1 つ足したときに既定の側へ黙って落ちる形にしない）。
 */
const BODY_REFUSALS: Readonly<Record<RecaptureRejection, { status: number; body: string }>> = {
  'unsupported-content-type': { status: 415, body: '要求の形式に対応していません。' },
  'body-too-large': { status: 413, body: '要求が大きすぎます。' },
  'unreadable-body': {
    status: 400,
    body: '要求を最後まで受け取れませんでした。もう一度お試しください。',
  },
  'invalid-game-id': { status: 400, body: '要求の形が正しくありません。' },
};

/**
 * 起動の結果ごとの、ステータスと文言。
 *
 * **`started` はここに無い。** あれだけが唯一の成功で、応答の作り方そのものが違う
 * （POST-redirect-GET）。表に混ぜると「成功も断りも同じ形で返せる」ように見える。
 *
 * `skipped` を 409 にするのは、**要求の形は正しいが、いまその行を掴んではいけない**
 * ためである（作者ではない・撮影済み・まだ 900 秒経っていない・設定不足）。
 * **理由を分けない**——他人の作品が「撮影中かどうか」を、404 と 409 の差から
 * 外側で数えられる形にしない（`src/ogp.ts` のコールバックが 404 に寄せたのと同じ）。
 */
const OUTCOME_REFUSALS: Readonly<
  Record<Exclude<CaptureStartOutcome, 'started'>, { status: number; heading: string; body: string }>
> = {
  skipped: {
    status: 409,
    heading: '撮り直せません',
    body:
      'この作品のスクリーンショットは、いま撮り直せません。' +
      '撮影がまだ走っているか、すでに終わっている可能性があります。しばらくしてからご確認ください。',
  },
  failed: {
    // **502 である。** 断ったのではなく、**外側（AWS Lambda）へ投げ込めなかった。**
    // 400 番台にすると「送った内容が悪い」と読めるが、利用者にできることは何も無い。
    status: 502,
    heading: '撮り直せませんでした',
    body: '撮影を呼び出せませんでした。しばらくしてからもう一度お試しください。',
  },
};

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
 * 要求がブラウザのナビゲーションかを判定する（`src/publish.ts` と同じ判定）。
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
 * **作品ページへ 303 で戻さない。** 戻すと、撮り直せなかったことが URL にも
 * ステータスにも残らない（`src/publish.ts` の `refusal` と同じ判断）。
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

/** 本文から取り出した対象。 */
type GameIdResult =
  | { readonly ok: true; readonly gameId: string }
  | { readonly ok: false; readonly reason: RecaptureRejection };

/**
 * 本文から対象の作品 id を取り出す。
 *
 * **形をここで確かめる**（`src/publish.ts` の `readGameId` と同じ方針）。
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
    return { ok: false, reason: read.reason };
  }

  let raw: unknown;
  if (mediaType === FORM_MEDIA_TYPE) {
    raw = new URLSearchParams(read.text).get(OGP_RECAPTURE_GAME_ID_FIELD) ?? undefined;
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)[OGP_RECAPTURE_GAME_ID_FIELD]
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
 * 撮り直す。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @returns レスポンス
 */
async function handleRecapture(
  request: Request,
  env: Env,
  start: StartOgpCapture,
): Promise<Response> {
  const asHtml = wantsHtml(request);

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameId(request);
  if (!target.ok) {
    const refused = BODY_REFUSALS[target.reason];
    return asHtml
      ? refusal('撮り直せません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  // **作者の一致も、期限切れかどうかも、この呼び出しの先の SQL が見る**
  // （`src/ogp.ts` の `reclaimStaleOgpCapture`）。ここに `if` を置かない。
  const outcome = await startOgpRecapture(env, target.gameId, session.userId, start);

  if (outcome === 'started') {
    // POST-redirect-GET。戻り先は作品ページで、そこに撮影中の表示が出る。
    return asHtml
      ? seeOther(workPagePath(target.gameId))
      : json({ recapture: outcome satisfies CaptureStartOutcome }, 202);
  }

  const refused = OUTCOME_REFUSALS[outcome];
  return asHtml
    ? refusal(refused.heading, refused.body, refused.status)
    : json({ recapture: outcome satisfies CaptureStartOutcome }, refused.status);
}

/**
 * 撮り直しの経路を組み立てる。
 *
 * **撮影の段を差し替えられるのはここだけである**（`src/publish.ts` の
 * `createPublishRoutes` と同じ形）。アプリの経路表（`src/app.ts`）は既定の
 * {@link ogpRecaptureRoutes} を連結するので、本番の結線は変わらない。
 *
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @returns 経路表
 */
export function createOgpRecaptureRoutes(
  start: StartOgpCapture = startOgpCaptureOnLambda,
): readonly Route[] {
  return [
    {
      method: 'POST',
      path: OGP_RECAPTURE_PATH,
      handler: (request, env) => handleRecapture(request, env, start),
    },
  ];
}

/** アプリの経路表へ連結する撮り直しの経路。 */
export const ogpRecaptureRoutes: readonly Route[] = createOgpRecaptureRoutes();
