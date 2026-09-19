/**
 * MCP の認可（#696 / 仕様 5.15）の口を、KV の無料枠の使い切りから守る。
 *
 * **KV の無料枠は、書き込みと list がそれぞれ 1 日 1,000 回（アカウント全体で共有）**である。枯れると、全員の同意・
 * code の交換・refresh と、退会の完了の段（cleanup の Worker）がまとめて止まる。1 回ごとに KV を書くか list する口のうち、
 * 利用者（やログインしていない人）が繰り返せるものに、2 段の上限を置く。
 *
 * | 口 | 1 回の KV | 短い窓（Workers Rate Limiting） | 1 日の総量（D1。`migrations/0048_oauth_daily_usage.sql`） |
 * |---|---|---|---|
 * | `POST /register`（DCR。**ログイン不要**） | 書き込み 1 | IP ごと 60 秒 60 回 | **全体で 1 日 {@link DAILY_REGISTER_LIMIT} 回** |
 * | `/account/apps` の一覧と解除 | list 1 以上 | 利用者ごと 60 秒 60 回 | 利用者ごと {@link DAILY_ACCOUNT_APPS_PER_USER} 回・全体で {@link DAILY_ACCOUNT_APPS_TOTAL} 回 |
 * | `POST /authorize` の承諾 | 書き込み 1・list 1 | — | 利用者ごと {@link DAILY_CONSENT_PER_USER} 回・全体で {@link DAILY_CONSENT_TOTAL} 回 |
 *
 * ## 短い窓だけでは守れない
 *
 * 短い窓は 5.13 の `ApiRateLimiter`（いいねの Worker の Workers Rate Limiting。`src/api-rate-limit.ts`）を、口ごとの鍵で
 * 使い回す。**ただし Workers Rate Limiting の窓は 10 秒か 60 秒しか選べず、1 日の総量を縛れない**——60 秒 60 回なら 1 IP でも
 * 1 日 86,400 回になり、1,000 回の枠は 17 分で尽きる。**枠を守るのは 1 日の総量（D1）のほうである。** 短い窓は、1 つの IP や
 * 1 人が全体の 1 日の枠を数分で使い切るのを遅らせる役に留まる。
 *
 * ## 呼べないときの扱い
 *
 * - **短い窓（入口）を呼べなければ通す**（fail-open。`allowApiCall` の既定のまま）。1 日の総量が別に縛っているので、いいねの
 *   Worker の障害で DCR や登録情報まで止めない
 * - **1 日の総量（D1）を数えられなければ断る**（fail-closed）。こちらが枠を守る本体で、数えずに通すと守りが消える。D1 が
 *   落ちているならサイト全体が動いていない
 *
 * ## IP アドレスを保存しない
 *
 * DCR の短い窓の鍵は `oauth-register:<CF-Connecting-IP>` だが、**その鍵はいいねの Worker の Rate Limiting に渡すだけで、
 * D1 にも KV にも書かない**（プライバシーポリシー「IP アドレスを自らのデータベースへ保存していません」）。1 日の総量は IP で
 * 分けず、全体で数える。**代償は、DCR の 1 日の枠を他人が使い切れること**（その日の DCR だけが止まる。CIMD〔Claude が使う〕と、
 * 登録済みのクライアントの同意・refresh は止まらない）。
 */
import { allowApiCall } from './api-rate-limit.js';

/** DCR の本文の上限（バイト）。**8 KB**。クライアントの登録情報（名前・戻り先・連絡先）は 1 KB も要らない。 */
export const REGISTER_MAX_BODY_BYTES = 8 * 1024;

/**
 * DCR の 1 日の総量（**全体で 100 回**）。書き込みの枠 1,000 の 1 割。招待制のあいだ、正規の DCR（Claude Code などが
 * 接続のたびに登録し直す）は 1 日に数回から数十回の見込みである。
 */
export const DAILY_REGISTER_LIMIT = 100;

/** 「接続中のアプリ」の一覧と解除の、利用者ごとの 1 日の回数（**50 回**）。 */
export const DAILY_ACCOUNT_APPS_PER_USER = 50;

/** 「接続中のアプリ」の一覧と解除の、全体の 1 日の回数（**300 回**。list の枠 1,000 の 3 割）。 */
export const DAILY_ACCOUNT_APPS_TOTAL = 300;

/** 同意（承諾）の、利用者ごとの 1 日の回数（**30 回**）。 */
export const DAILY_CONSENT_PER_USER = 30;

/** 同意（承諾）の、全体の 1 日の回数（**200 回**。書き込みと list の枠 1,000 のそれぞれ 2 割）。 */
export const DAILY_CONSENT_TOTAL = 200;

/** 1 日の長さ（秒）。日の区切りは UTC。 */
const DAY_SECONDS = 24 * 60 * 60;

/** 上限の判定の結果。 */
export type GuardResult = 'allowed' | 'rate-limited' | 'unavailable';

/**
 * 1 日の回数を 1 つ数え、上限の内なら true を返す（**数える文そのものが上限を見る**。読んでから書かない）。
 *
 * 複数の上限（利用者ごとと全体など）は、**すべてを 1 つの batch で数える**。どれか 1 つでも上限に達していれば false で、
 * そのとき他の上限の数は上がりうる（上がり過ぎても安全側に倒れるだけ）。同じ batch で 2 日より前の行を消す。
 *
 * @param db D1
 * @param limits 数える先と上限
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns すべて上限の内なら true
 * @throws D1 の失敗（呼ぶ側が fail-closed にする）
 */
export async function consumeDailyQuota(
  db: D1Database,
  limits: readonly { readonly bucket: string; readonly limit: number }[],
  nowSeconds: number,
): Promise<boolean> {
  const day = Math.floor(nowSeconds / DAY_SECONDS);
  const results = await db.batch([
    db.prepare('delete from oauth_daily_usage where day < ?').bind(day - 1),
    ...limits.map(({ bucket, limit }) =>
      db
        .prepare(
          `insert into oauth_daily_usage (bucket, day, count) values (?, ?, 1)
             on conflict (bucket, day) do update set count = count + 1 where count < ?`,
        )
        .bind(bucket, day, limit),
    ),
  ]);
  return results.slice(1).every((result) => (result.meta.changes ?? 0) > 0);
}

/**
 * 2 段の上限を見る（短い窓 → 1 日の総量）。
 *
 * @param env バインディング
 * @param shortWindow 短い窓の口の名前と鍵（無ければ見ない）
 * @param daily 1 日の総量
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 判定
 */
async function guard(
  env: Env,
  shortWindow: { readonly scope: string; readonly key: string } | null,
  daily: readonly { readonly bucket: string; readonly limit: number }[],
  nowSeconds: number,
): Promise<GuardResult> {
  if (shortWindow !== null && !(await allowApiCall(env, shortWindow.scope, shortWindow.key))) {
    return 'rate-limited';
  }
  try {
    return (await consumeDailyQuota(env.DB, daily, nowSeconds)) ? 'allowed' : 'rate-limited';
  } catch (error) {
    console.error(`[oauth-guard] 1 日の回数を数えられなかったので断りました: ${error instanceof Error ? error.name : 'unknown'}`);
    return 'unavailable';
  }
}

/**
 * DCR（`POST /register`）の上限を見る。
 *
 * @param env バインディング
 * @param clientIp `CF-Connecting-IP`（無ければ null。すべて同じ鍵 `unknown` にまとめて数える）
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 判定
 */
export async function guardRegistration(env: Env, clientIp: string | null, nowSeconds: number): Promise<GuardResult> {
  return await guard(
    env,
    { scope: 'oauth-register', key: clientIp === null || clientIp.trim() === '' ? 'unknown' : clientIp.trim() },
    [{ bucket: 'register', limit: DAILY_REGISTER_LIMIT }],
    nowSeconds,
  );
}

/**
 * 「接続中のアプリ」の一覧と解除の上限を見る。
 *
 * @param env バインディング
 * @param userId 利用者の id
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 判定
 */
export async function guardAccountApps(env: Env, userId: string, nowSeconds: number): Promise<GuardResult> {
  return await guard(
    env,
    { scope: 'account-apps', key: userId },
    [
      { bucket: `account-apps:${userId}`, limit: DAILY_ACCOUNT_APPS_PER_USER },
      { bucket: 'account-apps', limit: DAILY_ACCOUNT_APPS_TOTAL },
    ],
    nowSeconds,
  );
}

/**
 * 同意（承諾）の上限を見る。
 *
 * @param env バインディング
 * @param userId 利用者の id
 * @param nowSeconds 現在時刻（UNIX 秒）
 * @returns 判定
 */
export async function guardConsent(env: Env, userId: string, nowSeconds: number): Promise<GuardResult> {
  return await guard(
    env,
    null,
    [
      { bucket: `consent:${userId}`, limit: DAILY_CONSENT_PER_USER },
      { bucket: 'consent', limit: DAILY_CONSENT_TOTAL },
    ],
    nowSeconds,
  );
}
