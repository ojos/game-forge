/**
 * 管理画面のフォームの読み取り（#361）。
 *
 * # 素の `<form method="post">` だけを受ける
 *
 * **JavaScript を要求しない**（9.3。`src/account.ts` と同じ形）。押した結果は
 * POST-redirect-GET で画面へ戻す。**`fetch` から呼ぶ画面が 1 つも無い**ので、
 * JSON の解析経路を足さない——**呼ぶ側が無い形式のために経路を増やさない。**
 *
 * # CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）で、他サイトからの POST に
 * **そもそも cookie が乗らない。** `src/account.ts` / `src/publish.ts` /
 * `src/invite-issuance.ts` と同じ理由でトークンを足していない。**cookie の属性を
 * 緩めるなら、その時点でここも見直すこと**——管理画面の口は、他の口と違って
 * 他人のアカウントを止められる。
 *
 * # 上限を置く理由
 *
 * 本文に載るのは対象の id 1 つ・向き 1 つ・理由 1 つである。**理由は 500 文字まで**
 * （`src/admin/actions.ts` の `ADMIN_REASON_MAX_LENGTH`）で、4 バイト文字ばかりでも
 * 2,000 バイト、パーセント符号化で約 6,000 バイトだから、**8 KiB に収まる。**
 *
 * **上限をぎりぎりに置かない。** 当たった本文は「理由が長すぎる」として返すが、
 * **413 ではなく「500 文字までです」と伝えたい**ので、少し余裕を持たせてある
 * （`src/account.ts` の `MAX_BODY_BYTES` と同じ考え方）。上限そのものは、本文を
 * 際限なく読まないために置く。
 */
import { readLimitedText } from '../routes.js';

/**
 * 素の HTML フォームが送ってくる `Content-Type`。
 *
 * **これ以外を受けない。** 受ける形式が 1 つなら、解析の分岐が増えない。
 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * 受け付ける本文の最大バイト数。
 *
 * **8 KiB。** 理由 500 文字（4 バイト文字なら 2,000 バイト、パーセント符号化で
 * 6,000 バイト）に、id と向きの余地を足した値である。
 */
const MAX_BODY_BYTES = 8192;

/** フォームの読み取り結果。 */
export type AdminFormRead =
  | { readonly ok: true; readonly fields: URLSearchParams }
  | { readonly ok: false; readonly reason: 'invalid-request' | 'reason-too-long' };

/**
 * 管理画面のフォームの本文を読む。
 *
 * **項目が無い本文は空文字として返す**（呼び出し側が「空の理由」「空の対象」として
 * 断る）。ここが返す `URLSearchParams` は未検査の値である。
 *
 * @param request 受信したリクエスト
 * @returns フォームの項目、または断る理由
 */
export async function readAdminForm(request: Request): Promise<AdminFormRead> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return { ok: false, reason: 'invalid-request' };
  }

  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    // **大きすぎる本文は「長すぎる理由」として返す**（載るのが理由しかない。上記）。
    return {
      ok: false,
      reason: read.reason === 'body-too-large' ? 'reason-too-long' : 'invalid-request',
    };
  }
  return { ok: true, fields: new URLSearchParams(read.text) };
}
