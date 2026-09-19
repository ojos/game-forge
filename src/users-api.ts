/**
 * ユーザー情報を機械が読める口（#700 / M19-3。仕様 5.14）。
 *
 * | 口 | 返すもの |
 * |---|---|
 * | `GET /api/users/<id>` | 作者の公開プロフィール（作者ページ `/users/<id>`・`/@handle` と同じ公開情報） |
 * | `GET /api/me` | 自分の公開プロフィール＋残りの生成枠（生成画面・「あなたの作品」と同じ値） |
 *
 * ## 作者ページと同じものを、同じ読み方で返す
 *
 * **`users` の 1 行は作者ページの SQL（`AUTHOR_USER_SQL`）をそのまま使う。** 選ぶ列を書き写さない
 * ——書き写すと、作者ページに列を足した日にこちらだけが古くなるか、こちらだけに非公開の列が入る。
 * 被いいねの数も作者ページの SQL（`likesReceivedSql`）を使い、公開作品の数は同じ条件
 * （`status = 'published'` と `reviewVisibleSql`）で数える。表示名の倒し方（`displayNameOf`）も借りる。
 *
 * **返さないもの**：メールアドレス（`email`）・Google の識別子（`google_sub`）・招待の関係
 * （`invited_by` と招待の表）・メール配信の設定（`fork_notice_muted_at`）・変更の履歴（表示名・
 * ハンドル名・アイコン）・BAN と退会の時刻・運営と管理者の印。**選ばない列は漏れようがない**
 * （作者ページの冒頭と同じ担保）。`/api/me` でも同じで、メールアドレスは `/account` の画面だけが出す。
 *
 * ## 404 の方針（作者ページと同じ）
 *
 * - **BAN された作者も 404 にしない**（#330。`src/users-page.ts` の冒頭の 4 つの根拠）
 * - **退会を始めた利用者・無い id・形の違う id は、同じ 404（`{"error":"not-found"}`）にする**
 *   （#518。退会したかどうかを外から数えられる口を作らない）
 * - id の形の規則も作者ページのもの（`userIdFromPath`。長さだけを縛り、UUID に決め打ちしない）
 *
 * ## 作者ページと違うところ
 *
 * - **キャッシュを通さない。** 作者ページは作品の行と被いいねの数を Cache API に 60 秒載せるので、
 *   画面のほうが最大 60 秒古い値を出しうる。口は毎回 D1 から読む（主キーの 1 行と、作者の公開作品に
 *   比例する集計 2 本。集計は作者ページと同じ部分索引に乗る）
 * - **表示名が引けないときは `null` を返す**（画面の見出しの「名前のない作者」は画面の文言で、
 *   機械が読む値ではない）
 * - **`/users/<id>` から `/@handle` への 301 はしない。** いまのハンドル名は `handle` と
 *   `links.page` に載せる
 *
 * ## 認証
 *
 * {@link resolveApiCaller} を通す（`src/works-api.ts` と同じ。M19 で MCP のトークンを差し込む場所）。
 * **他人のプロフィールを読む口もログイン必須にする**（#700 の constraints）。未認証は 401。
 */
import { resolveApiCaller } from './api-caller.js';
import { avatarUrl, sandboxOriginOf } from './avatar-paths.js';
import { PUBLISHED_STATUS } from './games.js';
import { parseStoredProfileLinks } from './profile.js';
import { DAILY_QUOTA_PER_USER, DAILY_QUOTA_REASON, MONTHLY_LIMIT_REASON, generationQuotaStatus } from './quota.js';
import { reviewVisibleSql } from './reports.js';
import { json, type Route } from './routes.js';
import { AUTHOR_PAGE_PREFIX, authorPagePathFor } from './users-page-paths.js';
import {
  AUTHOR_USER_SQL,
  type AuthorUserWithHandleRow,
  displayNameOf,
  likesReceivedSql,
  userIdFromPath,
} from './users-page.js';
import { ME_API_PATH, USER_API_PREFIX, userApiPath } from './users-api-paths.js';

/** 無い・退会した・形の違う id に返す本文。**理由を分けない。** */
const NOT_FOUND = { error: 'not-found' } as const;

/**
 * その人の公開作品の数を引く SQL。
 *
 * **作者ページの {@link likesReceivedSql} と同じ条件で数える**（`draft` と、8.4 の審査で新規露出を
 * 止めた作品を入れない）。条件は `reviewVisibleSql` から借り、書き写さない——数と被いいねの合計が
 * 別の条件で数えられると、「数えた作品のいいねを足しても合計と合わない」が起きる。
 *
 * **作者ページはこの数を出していない**（頁送りのカードを並べるだけ）。一致は、作者ページのカードを
 * 全頁数えた数とテストで照合する（`test/users-api.test.ts`）。
 *
 * @returns 束縛パラメータが 2 つ（author_id / status）の SELECT 文
 */
export function publicWorksCountSql(): string {
  return `select count(*) as works
       from games g
      where g.author_id = ? and g.status = ? and ${reviewVisibleSql('g')}`;
}

/** 公開プロフィール（`/api/users/<id>` の本文。`/api/me` はこれに `quota` を足す）。 */
export interface PublicUserProfile {
  readonly id: string;
  /** 表示名（引けなければ null）。 */
  readonly displayName: string | null;
  /** いま使っているハンドル名（決めていなければ null）。 */
  readonly handle: string | null;
  /** 自己紹介（書いていなければ空文字）。**利用者の入力のまま**で、HTML として扱わない。 */
  readonly bio: string;
  /** 外部リンク（作者ページと同じく、読むたびに検査し直した値だけ）。 */
  readonly profileLinks: readonly string[];
  /** アイコンの絶対 URL（版つき。設定していなければ null）。 */
  readonly avatarUrl: string | null;
  /** 公開作品の数。 */
  readonly publicWorks: number;
  /** 被いいねの数（公開作品の `like_count` の合計。5.8 の遅れを含む）。 */
  readonly likesReceived: number;
  readonly links: {
    /** 作者ページ（ハンドル名があれば `/@handle`）。 */
    readonly page: string;
    /** この口。 */
    readonly api: string;
  };
}

/**
 * 公開プロフィールを組み立てる。
 *
 * @param request 受信したリクエスト（アイコンの URL のスキームとポートを借りる）
 * @param env バインディングと環境変数
 * @param userId 利用者 id
 * @returns プロフィール、または null（無い・退会を始めた）
 */
export async function loadPublicUserProfile(
  request: Request,
  env: Env,
  userId: string,
): Promise<PublicUserProfile | null> {
  const user = await env.DB.prepare(AUTHOR_USER_SQL).bind(userId).first<AuthorUserWithHandleRow>();
  if (user === null || user.withdrawal_started_at !== null) {
    return null;
  }
  // **集計の 2 本は 1 回の往復で引く**（どちらも同じ部分索引に乗る）。
  const [likes, works] = await env.DB.batch<{ likes?: number; works?: number }>([
    env.DB.prepare(likesReceivedSql()).bind(userId, PUBLISHED_STATUS),
    env.DB.prepare(publicWorksCountSql()).bind(userId, PUBLISHED_STATUS),
  ]);
  const likesReceived = likes?.results[0]?.likes;
  const publicWorks = works?.results[0]?.works;
  // **版は `avatar_sha256` が無ければ使わない**（外した後も `avatar_set_at` は進む。作者ページと同じ）。
  const avatarVersion = user.avatar_sha256 === null ? null : user.avatar_set_at;
  const handle = typeof user.handle === 'string' ? user.handle : null;
  return {
    id: userId,
    displayName: displayNameOf(user.display_name),
    handle,
    bio: typeof user.bio === 'string' ? user.bio : '',
    profileLinks: parseStoredProfileLinks(user.profile_links),
    avatarUrl:
      avatarVersion === null ? null : avatarUrl(sandboxOriginOf(request, env.SANDBOX_HOST), userId, avatarVersion),
    publicWorks: typeof publicWorks === 'number' ? publicWorks : 0,
    likesReceived: typeof likesReceived === 'number' ? likesReceived : 0,
    links: { page: authorPagePathFor(userId, handle), api: userApiPath(userId) },
  };
}

/**
 * 残りの生成枠（`/api/me` の `quota`）。
 *
 * `state` は `src/quota.ts` の {@link generationQuotaStatus} の綴りのまま（`available` /
 * `daily-quota` / `monthly-limit`）。読めなかったときは `unknown`（生成画面の `resolveAvailability`
 * と同じく、表示のための読み取りで口ごと 500 にしない）。
 *
 * **80% 警告（`warning`）は返さない。** 中身はサービス全体の当月の費用で、生成画面も出していない。
 */
interface QuotaView {
  readonly state: 'available' | typeof DAILY_QUOTA_REASON | typeof MONTHLY_LIMIT_REASON | 'unknown';
  /** 本日の残り回数（日次で止まっていれば 0。月次で止まった・読めなければ null）。 */
  readonly remaining: number | null;
  /** 1 日の回数（確定25）。 */
  readonly dailyLimit: number;
  /** 日次の枠が戻る時刻（UNIX 秒。日次で止まっているときだけ）。 */
  readonly resetsAt: number | null;
}

/**
 * 残りの生成枠を読む。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者 id
 * @returns 枠の状態
 */
async function quotaViewOf(env: Env, userId: string): Promise<QuotaView> {
  const base = { dailyLimit: DAILY_QUOTA_PER_USER };
  try {
    const status = await generationQuotaStatus(env, userId);
    switch (status.kind) {
      case 'available':
        return { ...base, state: 'available', remaining: status.remaining, resetsAt: null };
      case DAILY_QUOTA_REASON:
        return { ...base, state: DAILY_QUOTA_REASON, remaining: 0, resetsAt: status.resetsAt };
      case MONTHLY_LIMIT_REASON:
        return { ...base, state: MONTHLY_LIMIT_REASON, remaining: null, resetsAt: null };
      default:
        // 知らない状態を「残っている」とも「止まっている」とも言わない（`resolveAvailability` と同じ）。
        return { ...base, state: 'unknown', remaining: null, resetsAt: null };
    }
  } catch (error) {
    // 例外の種類だけを出す（`src/quota.ts` の `readForDecision` がすでに記録している）。
    console.error(
      `[users-api] 残枠を取得できませんでした: ${error instanceof Error ? error.name : typeof error}`,
    );
    return { ...base, state: 'unknown', remaining: null, resetsAt: null };
  }
}

/**
 * `GET /api/users/<id>` — 作者の公開プロフィール。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 応答
 */
export async function handleUserProfile(request: Request, env: Env): Promise<Response> {
  const caller = await resolveApiCaller(request, env);
  if (!caller.ok) {
    return json({ error: 'unauthorized' }, 401);
  }
  // **id の形の規則は作者ページのものを使う**（`/users/` の後ろと同じ綴りを、同じ関数で読む）。
  const rest = new URL(request.url).pathname.slice(USER_API_PREFIX.length);
  const userId = userIdFromPath(`${AUTHOR_PAGE_PREFIX}${rest}`);
  if (userId === null) {
    return json(NOT_FOUND, 404);
  }
  const profile = await loadPublicUserProfile(request, env, userId);
  return profile === null ? json(NOT_FOUND, 404) : json(profile);
}

/**
 * `GET /api/me` — 自分の公開プロフィールと残りの生成枠。
 *
 * **自分の情報でも、足すのは残りの枠だけである**（メールアドレスや配信の設定は返さない。モジュール冒頭）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 応答
 */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const caller = await resolveApiCaller(request, env);
  if (!caller.ok) {
    return json({ error: 'unauthorized' }, 401);
  }
  const profile = await loadPublicUserProfile(request, env, caller.userId);
  if (profile === null) {
    // 呼び出し元の解決の後に退会を掴んだ（競合）。**未認証と同じ扱いにする**（もう利用者ではない）。
    return json({ error: 'unauthorized' }, 401);
  }
  return json({ ...profile, quota: await quotaViewOf(env, caller.userId) });
}

/** ユーザー情報を機械が読める口の経路。 */
export const usersApiRoutes: readonly Route[] = [
  { method: 'GET', path: ME_API_PATH, handler: handleMe },
  { method: 'GET', path: USER_API_PREFIX, match: 'prefix', handler: handleUserProfile },
];
