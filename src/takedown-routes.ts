/**
 * 削除申請の受け口（8.4 / #41）。
 *
 * **画面（GET）は `src/legal.ts` が持ち、ここは POST だけを持つ。** 分けるのは、
 * あちらが D1 に触らないことを構造で保つためである——**画面を足す作業が、
 * うっかり書き込みの経路を増やさない。**
 */
import type { Route } from './routes.js';
import { json, readLimitedText } from './routes.js';
import {
  TAKEDOWN_FIELDS,
  TAKEDOWN_PATH,
  TAKEDOWN_SUBMIT_PATH,
  TAKEDOWN_THANKS_PATH,
} from './legal.js';
import { MAX_BODY_LENGTH, MAX_CLAIMANT_LENGTH, recordTakedownRequest } from './takedown.js';

/**
 * 受け付ける本文の最大バイト数。
 *
 * **項目の上限から導く。** 文字数の上限は `src/takedown.ts` が持つので、ここは
 * UTF-8 の最大 4 バイト/文字を見込んで掛けるだけにする（**数値を書き写さない**）。
 * 余裕として項目名と区切りのぶんを足す。
 */
const MAX_BODY_BYTES = (MAX_CLAIMANT_LENGTH * 2 + MAX_BODY_LENGTH) * 4 + 1024;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * 作品 URL からでも ID を受け取れるようにする。
 *
 * **権利者は作品ページの URL をそのまま貼る。** ID だけを求めると、URL を貼った人が
 * 「受け付けられません」と言われる——**こちらが 1 行書けば済むことを、申請者に
 * やらせない。**
 *
 * @param raw 入力された文字列
 * @returns 取り出した id（見つからなければ入力をそのまま返す）
 */
export function gameIdFromInput(raw: string): string {
  const trimmed = raw.trim();
  const matched = /\/works\/([^/?#\s]+)/u.exec(trimmed);
  return matched === null ? trimmed : matched[1]!;
}

/**
 * 削除申請を受け付ける。
 *
 * **ログインを要求しない**（`src/takedown.ts` の冒頭）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleTakedown(request: Request, env: Env): Promise<Response> {
  const asHtml = (request.headers.get('accept') ?? '').includes('text/html');
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE && mediaType !== JSON_MEDIA_TYPE) {
    return json({ error: 'unsupported-content-type' }, 415);
  }

  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return json({ error: read.reason }, read.reason === 'body-too-large' ? 413 : 400);
  }

  let values: Record<string, unknown>;
  if (mediaType === FORM_MEDIA_TYPE) {
    const form = new URLSearchParams(read.text);
    values = Object.fromEntries([...form.entries()]);
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      values =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return json({ error: 'malformed-json' }, 400);
    }
  }

  const read1 = (key: string): string => {
    const value = values[key];
    return typeof value === 'string' ? value : '';
  };

  const outcome = await recordTakedownRequest(env, {
    gameId: gameIdFromInput(read1(TAKEDOWN_FIELDS.gameId)),
    claimantName: read1(TAKEDOWN_FIELDS.name),
    claimantContact: read1(TAKEDOWN_FIELDS.contact),
    body: read1(TAKEDOWN_FIELDS.body),
  });

  if (!outcome.ok) {
    // POST-redirect-GET。フォームへ戻し、理由を出す。
    return asHtml
      ? new Response(null, {
          status: 303,
          headers: { location: `${TAKEDOWN_PATH}?reason=${outcome.reason}` },
        })
      : json({ error: outcome.reason }, 400);
  }

  // **受付 id を返さない。** 非ログインの経路で id を返すと、それが後から状態を
  // 引く手がかりになる。**受け付けたことだけを伝える。**
  return asHtml
    ? new Response(null, { status: 303, headers: { location: TAKEDOWN_THANKS_PATH } })
    : json({ received: true }, 200);
}

/** 削除申請の受け口の経路。 */
export const takedownRoutes: readonly Route[] = [
  { method: 'POST', path: TAKEDOWN_SUBMIT_PATH, handler: handleTakedown },
];
