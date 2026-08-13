/**
 * 署名付き Cookie セッション（8.1 / 確定9）。
 *
 * セッションは Workers 側で**署名付き Cookie** として持ち、サーバ側にセッション
 * ストアを置かない。D1 の書き込み無料枠は読み取りより桁で小さく（3.6）、
 * リクエストのたびにセッション行を書く形は真っ先に枯れる。署名で完結させれば
 * 検証は計算だけで済み、書き込みが発生しない。
 *
 * このモジュールは **D1 にも経路表にも依存しない**。#12 の OAuth コールバック
 * （T4）とは別に検証できるようにするためで、M1 の並列作業の前提でもある。
 *
 * トークンの中身は署名されているだけで**暗号化されていない**。base64url を解けば
 * 誰でも読めるため、機密をペイロードへ入れないこと。
 */

/**
 * セッション cookie の名前。
 *
 * `__Host-` 接頭辞は 7.2 の必須要件（2 点目）。サンドボックス用ホストが
 * アプリ用ホストの真のサブドメインであるため、接頭辞なしではサンドボックス側から
 * cookie を上書きされうる。ブラウザは `__Host-` を `Secure` かつ `Domain` 属性なし・
 * `Path=/` のときだけ受理する。
 */
export const SESSION_COOKIE = '__Host-gf_session';

/** 署名対象。ここに機密を入れないこと（base64url を解けば読める）。 */
export interface SessionPayload {
  /** `users.id`。 */
  readonly userId: string;
  /** 発行時刻（UNIX 秒）。 */
  readonly issuedAt: number;
  /** 失効時刻（UNIX 秒）。この時刻を過ぎたトークンは検証で落ちる。 */
  readonly expiresAt: number;
}

/** 検証が失敗した理由。ログに残すためのもので、クライアントへは返さない。 */
export type SessionRejection =
  | 'malformed'
  | 'bad-signature'
  | 'bad-payload'
  | 'expired';

/** 検証の結果。成功なら payload、失敗なら理由を持つ。 */
export type SessionVerification =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: SessionRejection };

/** HMAC の鍵を毎回 import し直さないための小さなキャッシュ。 */
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * 署名鍵を取り出す。
 *
 * 空の秘密鍵を黙って受け入れない。未設定の環境変数は空文字として渡ってくるため、
 * ここで落とさないと「誰でも作れる署名」で全リクエストが通る状態になる。
 * 落とす側に倒すと本番で 500 になるが、通す側に倒すと認証が消える。
 *
 * @param secret 署名の秘密鍵（`SESSION_SECRET`）
 * @returns HMAC-SHA256 の CryptoKey
 * @throws 秘密鍵が空、または短すぎる場合
 */
async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.trim() === '') {
    throw new Error('SESSION_SECRET が未設定です。署名付きセッションを発行できません。');
  }
  // 32 文字未満を拒む。HMAC 自体は短い鍵でも動くため、短さは実行時エラーとして
  // 表面化せず、総当たりの容易さとしてだけ現れる。機構で下限を引く。
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET が短すぎます（32 文字以上が必要です）。');
  }

  const cached = keyCache.get(secret);
  if (cached !== undefined) {
    return await cached;
  }
  const pending = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, pending);
  return await pending;
}

/**
 * ペイロードへ署名し、cookie に載せるトークンを作る。
 *
 * 形式は `<base64url(JSON)>.<base64url(HMAC)>`。署名対象は **base64url 済みの
 * 文字列**であり、JSON を再シリアライズしたものではない。JSON をもう一度作ると
 * キーの順序や空白の違いで署名が一致しなくなり、正規化の問題を持ち込む。
 *
 * @param payload 署名対象
 * @param secret 署名の秘密鍵
 * @returns トークン
 */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const key = await importKey(secret);
  const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * トークンを検証してペイロードを取り出す。
 *
 * 署名の照合には `crypto.subtle.verify` を使う。取り出した署名を自前で比較すると
 * 早期 return による**タイミング差**が出るため、比較を実装側へ委ねる。
 *
 * @param token cookie から取り出したトークン
 * @param secret 署名の秘密鍵
 * @param nowSeconds 現在時刻（UNIX 秒）。既定は実時刻。テストから固定できるようにする
 * @returns 検証結果
 */
export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionVerification> {
  const separator = token.indexOf('.');
  // 区切りが無い、または 2 つ以上あるものは受け付けない。lastIndexOf と一致しない
  // ことで「.` が 2 つ以上」を判定する。
  if (separator <= 0 || separator !== token.lastIndexOf('.') || separator === token.length - 1) {
    return { ok: false, reason: 'malformed' };
  }

  const body = token.slice(0, separator);
  const signature = decodeBase64Url(token.slice(separator + 1));
  if (signature === null) {
    return { ok: false, reason: 'malformed' };
  }

  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(body),
  );
  if (!valid) {
    return { ok: false, reason: 'bad-signature' };
  }

  // 署名を確かめてからペイロードを解く。順序を逆にすると、署名の無い入力に対して
  // JSON パーサを走らせることになる。
  const decoded = decodeBase64Url(body);
  if (decoded === null) {
    return { ok: false, reason: 'bad-payload' };
  }
  const payload = parsePayload(decoded);
  if (payload === null) {
    return { ok: false, reason: 'bad-payload' };
  }

  if (payload.expiresAt <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

/**
 * デコード済みのペイロードを検証する。
 *
 * 署名が通っていても形は信用しない。鍵が漏れた場合だけでなく、こちら側が過去に
 * 別の形で発行したトークンが残っている場合にも、型の合わない値が入ってくる。
 * `as` でキャストするとその値がそのまま下流へ流れる。
 *
 * @param decoded base64url を解いたバイト列
 * @returns 妥当なペイロード、または null
 */
function parsePayload(decoded: Uint8Array): SessionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { userId, issuedAt, expiresAt } = parsed as Record<string, unknown>;
  if (typeof userId !== 'string' || userId === '') {
    return null;
  }
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) {
    return null;
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
    return null;
  }
  return { userId, issuedAt, expiresAt };
}

/**
 * セッション cookie の `Set-Cookie` 値を組み立てる。
 *
 * `__Host-` の受理条件（`Secure` / `Path=/` / `Domain` 属性なし）をすべて満たす。
 * 1 つでも欠けるとブラウザは黙って捨てるため、属性は固定で組み立てて呼び出し側に
 * 選ばせない。`SameSite=Lax` は 8.1 の指定で、OAuth のリダイレクト（トップレベルの
 * GET ナビゲーション）では cookie が送られる。
 *
 * @param token `signSession` が返したトークン
 * @param maxAgeSeconds cookie の寿命（秒）
 * @returns `Set-Cookie` ヘッダの値
 */
export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/**
 * セッション cookie を消す `Set-Cookie` 値を組み立てる（ログアウト）。
 *
 * 属性は発行時と一致させる。`Path` が違うとブラウザは別の cookie とみなし、
 * 古いものが残る。
 *
 * @returns `Set-Cookie` ヘッダの値
 */
export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

/**
 * `Cookie` ヘッダからセッショントークンを取り出す。
 *
 * `src/app.ts` の `cookieNames` とは目的が違う。あちらは診断用に**名前だけ**を返し、
 * 値を決して返さない。こちらは値が要る唯一の経路であり、対象を
 * `SESSION_COOKIE` 1 つに限定する。
 *
 * @param header `Cookie` ヘッダの値（未設定なら null）
 * @returns トークン、または null
 */
export function readSessionCookie(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (trimmed.slice(0, separator) === SESSION_COOKIE) {
      const value = trimmed.slice(separator + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}

/**
 * バイト列を base64url（パディングなし）へ変換する。
 *
 * cookie の値には `,` `;` 空白などが使えないため、素の base64 ではなく base64url を使う。
 *
 * @param bytes 変換するバイト列
 * @returns base64url 文字列
 */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * base64url を解く。
 *
 * 素の base64（`+` `/` `=` を含む形）は**受け付けない**。受け付けると、同じ署名に
 * 対して複数の表現が通ることになり、トークンの一意性が崩れる。
 *
 * パディングを復元しないのは、`atob` が WHATWG の forgiving-base64 decode に従い、
 * **長さを 4 で割った余りが 1 のときだけ失敗する**ためである。HMAC-SHA256 の署名は
 * 32 バイト = 43 文字（余り 3）で、パディングなしでそのまま復号できる。余り 1 の
 * 入力は `atob` が投げ、ここで null になって `malformed` として落ちる（これは
 * 壊れた入力なので、落ちるのが正しい）。両方を test/session.test.ts で固定している。
 *
 * @param text base64url 文字列
 * @returns バイト列、または解けない場合は null
 */
function decodeBase64Url(text: string): Uint8Array | null {
  if (text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}
