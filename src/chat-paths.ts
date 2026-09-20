/**
 * 相談の口の綴り（#695 / M18-2。仕様 5.16）。
 *
 * **値だけの葉である**（`src/public-works-api-paths.ts` と同じ役割）。口の実装
 * （`src/chat.ts`）は D1 と Lambda を引き込むので、**綴りだけを要る側**——画面
 * （PR② の `/generate` の区画）やテスト——がここから取る。
 */

/** 相談の 1 往復の口（`POST`）。 */
export const CHAT_API_PATH = '/api/chat';

/**
 * 保存した会話を消す口（`POST`。仕様 5.16「作者が自分で消せる」）。
 *
 * **`DELETE` ではなく `POST` にする。** 画面からの操作で、**このサイトの状態を変える要求は
 * すべて POST である**（`src/account-withdrawal.ts` / ログアウトと同じ。`SameSite=Lax` の
 * cookie が乗る形を 1 つに保つ）。
 */
export const CHAT_CONVERSATION_DELETE_PATH = '/api/chat/conversation/delete';

/**
 * 呼び出しの上限を数えるときの鍵の前半（`src/api-rate-limit.ts` の `scope`）。
 *
 * **口ごとに数え分ける**ので、5.13 の一覧の口（`works`）と枠を食い合わない。
 */
export const CHAT_RATE_LIMIT_SCOPE = 'chat';
