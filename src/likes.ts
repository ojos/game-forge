/**
 * いいねの窓口（5.8 / #339）。**Pages 側がいいねを読み書きするのは、このモジュールだけ**である。
 *
 * # 形
 *
 * ```text
 * ブラウザ → Pages Functions ─ src/likes.ts（ここ）
 *              │                  ├ D1 を読む: 押せる作品か（公開・自作でない・審査で止めていない）
 *              │                  └ binding ─→ LikeHub（別 Worker game-forge-likes の Durable Object）
 *              └ D1 を読む: 一覧・トップ・カードの数（games.like_count。最大 5 分遅れる）
 * ```
 *
 * **正本は Durable Objects にある**（`workers/likes/src/hub.ts`）。D1 は日次の書き込み上限を
 * 超えるとアカウント全体で止まるので（3.6）、**付与・取り消しの経路で D1 へ書かない。**
 * ここが D1 に対して行うのは読み取り（セッションの確認と、押せる作品かの判定）だけである。
 *
 * # なぜ窓口を 1 つにするのか
 *
 * **分割（B2）への移行を、この窓口と `game-forge-likes` の内側に閉じるため**である（5.8）。
 * 画面は DO の形を知らない。**`env.LIKE_HUB` を読むのはこのファイルだけ**で、
 * `scripts/check-likes-worker.sh` がそれを機械で確かめる。
 *
 * # 断るときは何も書かない
 *
 * | 状況 | 応答 |
 * |---|---|
 * | 未ログイン（BAN を含む） | ログインへ送る（他の操作と同じ。`src/session-user.ts`） |
 * | 本文の形が不正 | 400（形式違いは 415、大きすぎれば 413。`src/publish.ts` と同じ分け方） |
 * | 押せない作品（存在しない・`draft`・自作・審査で止めた） | **404。理由を区別しない** |
 * | 日次の上限（1 人 1 日 100 操作） | 429 |
 *
 * **404 の理由を区別しない**のは、`draft` の存在を外へ漏らさないためである（5.4 の
 * 「公開操作で初めて URL が有効になる」）。判定は 1 本の SQL が持ち、ここに分岐を
 * 書かない（{@link PRESSABLE_GAME_SQL}）。
 *
 * # 連打の防波堤（Workers Rate Limiting）を置いていない
 *
 * 仕様 5.8 は「窓口は DO を呼ぶ前に、Workers Rate Limiting で利用者 id ごとの瞬間的な
 * 連打を断る」とし、**Workers Free で使えるかを実装で確かめる**としていた。
 * **確かめた結果、この窓口には置けない**（2026-09-11）:
 *
 * - **Pages Functions の宣言は Rate Limiting のバインディングを受け付けない。** 公式の
 *   「Pages Functions のバインディング」の一覧（KV / DO / R2 / D1 / Vectorize /
 *   Workers AI / Service / Queue Producer / Hyperdrive / Analytics Engine / 変数 / 秘密）に
 *   無く、wrangler 4.121 の Pages の設定検査（`supportedPagesConfigFields`）も
 *   `ratelimits` / `unsafe` を知らないキーとして落とす
 * - Workers Free で使えるかは、公式の記述（binding の説明・GA の告知）に書かれていない
 *
 * **だから置かず、その状態を受け入れる**: 日次の上限を超えた要求も Pages と DO へ届き、
 * DO のリクエストの枠（1 日 10 万）を減らす。**DO の枠が尽きても止まるのはいいねだけ**
 * で、D1（生成・ログイン）は巻き込まれない（5.8）。置き直すなら、`game-forge-likes` に
 * Service binding の RPC 入口を足してそこで数える形になる（公開の入口ではないが、
 * 呼び出しの段が 1 つ増える。`docs/likes.md`）。
 *
 * # 読み取りが届かなくても、画面ごと落とさない（#340）
 *
 * **5.8 は「DO の枠が尽きても止まるのはいいねだけである」と約束している。** 読み取りの
 * 失敗をそのまま投げると、**その約束が守れない**——作品ページは**ログイン中だけ** DO を
 * 引く（M9-8）ので、DO へ届かない間、**拡散の着地点がログイン中の利用者にだけ 500 に
 * なる。** 止まるのがいいねだけでなくなる。
 *
 * **だから読み取り（{@link readLikeViewerState} / {@link listLikedGameIds}）は、届かな
 * かったときに `null` を返す。** 呼び出し側は D1 の `games.like_count` へ倒し、
 * **ボタンを出さない**（押しても届かないので 4.4）。**握りつぶすが黙らない**
 * （{@link LIKES_UNAVAILABLE_REASON}）。
 *
 * **書き込み（付与・取り消し）は倒さない。** あちらが投げれば 500 になるが、
 * **押した結果が分からないまま「できました」と戻すほうが悪い。** 読み取りを倒せるのは、
 * **倒した先に正しい表示がある**（数は D1 にあり、ボタンは出さないのが正しい）ためで
 * ある（`src/list-cache.ts` が「この層が無くても一覧が正しく出る」を握りつぶしの唯一の
 * 理由に挙げているのと同じ形）。
 *
 * # CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1 / `src/session.ts`）なので、他サイトからの
 * POST には cookie が乗らない。`src/publish.ts` と同じ理由でトークンを足していない。
 */
import type {
  LikeHub,
  LikeOperationOutcome,
  LikeViewerState,
} from '../workers/likes/src/hub.js';
import { LOGIN_PATH } from './auth/google.js';
import { PUBLISHED_STATUS } from './games.js';
import { siteHead } from './html.js';
import { siteFooter } from './legal.js';
import {
  LIKE_CANCEL_GAME_ID_FIELD,
  LIKE_CANCEL_PATH,
  LIKE_GAME_ID_FIELD,
  LIKE_PATH,
} from './like-paths.js';
import { workPagePath } from './paths.js';
import { reviewVisibleSql } from './reports.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';

/**
 * 全員のいいねを集める DO の名前（B1。5.8）。
 *
 * **1 個に集める。** 分割（B2）へ移るときは、ここが利用者や作品から名前を導く形に変わる
 * （契機はピーク毎秒 500 リクエスト。2.3.8）。
 */
export const LIKE_HUB_NAME = 'all';

/**
 * 押せる作品かを判定する SQL（5.8）。**読むだけで、何も書かない。**
 *
 * - 公開済み（`status = 'published'`。`draft` と `removed` は押せない）
 * - 自分の作品でない（被いいね数を自己申告にしない）
 * - 8.4 の審査で新規露出を止めていない（{@link reviewVisibleSql}。一覧と同じ断片を借りる
 *   ——条件を書き写すと、片方だけが古くなる）
 *
 * **理由ごとに引き分けない。** どれに当たっても 1 行も返らず、窓口は同じ 404 を返す。
 */
export const PRESSABLE_GAME_SQL = `select 1 as hit from games g
  where g.id = ? and g.status = ? and g.author_id <> ? and ${reviewVisibleSql('g')}
  limit 1`;

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

/** 本文を受け付けられなかった理由（綴りと分け方は `src/publish.ts` に揃えてある）。 */
export type LikeBodyRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'invalid-game-id';

/**
 * 本文の断りのステータスと文言。
 *
 * **ステータスを分岐の式で書かない**（`src/publish.ts` の `BODY_REFUSALS` と同じ理由）。
 */
const BODY_REFUSALS: Readonly<Record<LikeBodyRejection, { status: number; body: string }>> = {
  'unsupported-content-type': { status: 415, body: '要求の形式に対応していません。' },
  'body-too-large': { status: 413, body: '要求が大きすぎます。' },
  'unreadable-body': {
    status: 400,
    body: '要求を最後まで受け取れませんでした。もう一度お試しください。',
  },
  'invalid-game-id': { status: 400, body: '要求の形が正しくありません。' },
};

/**
 * 押せない作品への応答の文言。**存在しない・`draft`・自作・審査で止めた、のどれでも同じ。**
 *
 * 文言で理由を漏らさない（「自分の作品には押せません」と出すと、その id が公開済みの
 * 自作であることを確かめる手段になる——理由を分けないと決めた意味が消える）。
 */
export const NOT_PRESSABLE_MESSAGE = 'この作品には、いまいいねを付けたり取り消したりできません。';

/** 日次の上限に当たったときの文言（5.8 の「上限に達したとき」）。 */
export const DAILY_LIMIT_MESSAGE = '今日はこれ以上いいねを操作できません（明日また押せます）。';

/** 付与か取り消しか。 */
type LikeAction = 'like' | 'unlike';

/** 口ごとの違い（綴りと本文の項目名）。 */
interface LikeEndpoint {
  readonly action: LikeAction;
  readonly path: string;
  readonly field: string;
}

/** 付与の口。 */
const LIKE_ENDPOINT: LikeEndpoint = { action: 'like', path: LIKE_PATH, field: LIKE_GAME_ID_FIELD };

/** 取り消しの口。 */
const LIKE_CANCEL_ENDPOINT: LikeEndpoint = {
  action: 'unlike',
  path: LIKE_CANCEL_PATH,
  field: LIKE_CANCEL_GAME_ID_FIELD,
};

/**
 * いいねの DO への窓口を返す。
 *
 * **`env.LIKE_HUB` を読むのはここだけである。** 生成物（`worker-configuration.d.ts`）の
 * 型は別スクリプトのクラスを知らない（`DurableObjectNamespace<undefined>` になる）ので、
 * ここで `LikeHub` の型を当てる（`unknown` を挟むのは、`undefined` の型引数と
 * 直接には変換できないため）。型は import するが、**`game-forge-likes` の実装は
 * Pages の束に入らない**（`import type` は消える）。
 *
 * @param env バインディングと環境変数
 * @returns DO の stub
 */
function likeHub(env: Env): DurableObjectStub<LikeHub> {
  return (env.LIKE_HUB as unknown as DurableObjectNamespace<LikeHub>).getByName(LIKE_HUB_NAME);
}

/**
 * 押せる作品か（5.8）。**D1 を読むだけで、何も書かない。**
 *
 * @param env バインディングと環境変数
 * @param userId 押そうとしている利用者
 * @param gameId 作品
 * @returns 押せれば true
 */
export async function isPressableGame(env: Env, userId: string, gameId: string): Promise<boolean> {
  const row = await env.DB.prepare(PRESSABLE_GAME_SQL)
    .bind(gameId, PUBLISHED_STATUS, userId)
    .first<{ hit: number }>();
  return row !== null;
}

/** 付与・取り消しの結果（窓口の外へ出す形）。 */
export type LikeRequestOutcome =
  /** 押せない作品だった（理由は区別しない）。**何も書いていない。** */
  | 'not-pressable'
  | LikeOperationOutcome;

/**
 * いいねを付ける・取り消す（5.8）。**D1 へは書かない。**
 *
 * 押せる作品かを D1 で確かめ、通ったものだけを DO へ渡す。日次の上限と二重押しの判定は
 * DO が原子的に行う（`workers/likes/src/hub.ts`）。
 *
 * @param env バインディングと環境変数
 * @param action 付与か取り消しか
 * @param userId **セッションで確かめた**利用者 id
 * @param gameId 作品
 * @param at 操作の時刻（UNIX 秒）
 * @returns 結果
 */
export async function changeLike(
  env: Env,
  action: LikeAction,
  userId: string,
  gameId: string,
  at: number,
): Promise<LikeRequestOutcome> {
  if (!(await isPressableGame(env, userId, gameId))) {
    return 'not-pressable';
  }
  const hub = likeHub(env);
  const result =
    action === 'like' ? await hub.like(userId, gameId, at) : await hub.unlike(userId, gameId, at);
  return result.outcome;
}

/**
 * DO へ届かなかったときにログへ出す接頭辞。
 *
 * **握りつぶすが、黙らない。** 何度も出るなら DO の枠（1 日 10 万リクエスト）か結線の
 * 問題で、**それは画面の不具合ではない**（`src/list-cache.ts` が同じ形で理由を書いている）。
 */
export const LIKES_UNAVAILABLE_REASON = '[likes] いいねを読めませんでした';

/**
 * DO へ届かなかったことを記録する。
 *
 * @param what 何を読もうとしたか
 * @param error 投げられたもの
 */
function logLikesUnavailable(what: string, error: unknown): void {
  console.error(
    `${LIKES_UNAVAILABLE_REASON}（${what}）: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * ある利用者から見た作品のいいねの状態を引く（5.8）。**読むだけで、何も書かない。**
 *
 * **ログイン中の作品ページだけが呼ぶ**（M9-8）。未ログインの閲覧では DO を呼ばず、
 * D1 の `games.like_count` を読むこと（閲覧数で DO の枠を減らさない）。
 *
 * **読めなければ null を返す**（{@link LIKES_UNAVAILABLE_REASON}）。呼び出し側は
 * D1 の `games.like_count` へ倒し、**ボタンを出さない**（押しても届かないので 4.4）。
 *
 * @param env バインディングと環境変数
 * @param userId **セッションで確かめた**利用者 id
 * @param gameId 作品
 * @returns 押しているかと、数（BAN された利用者の分を除いた実数）。読めなければ null
 */
export async function readLikeViewerState(
  env: Env,
  userId: string,
  gameId: string,
): Promise<LikeViewerState | null> {
  try {
    const state = await likeHub(env).viewerState(userId, gameId);
    // RPC の戻り値は複製して返す（stub の型が付いたまま画面へ渡さない）。
    return { liked: state.liked, count: state.count };
  } catch (error) {
    logLikesUnavailable('作品ページのいいねの状態', error);
    return null;
  }
}

/**
 * ある利用者が押した作品の id を、押した新しい順に引く（5.8 / M9-8 / #340）。
 * **読むだけで、何も書かない。**
 *
 * **`/works/liked` だけが呼ぶ**（`src/liked-works.ts`）。本人の画面なので、DO を呼ぶことが
 * 「未ログインの閲覧で DO の枠を減らさない」（5.8）に反しない——**未ログインでは
 * この画面そのものがログインへ送られる。**
 *
 * # 返すのは id だけである
 *
 * **絞り込みは呼び出し側が D1 で行う。** DO は D1 の作品を知らないので、公開をやめた
 * 作品・審査で新規露出を止めた作品もこの配列に混ざる。**id を D1 で引き直し、引く時点で
 * 落とすこと**（#152 の規律。5.8）。**したがって、返った件数より画面に並ぶ件数が
 * 少なくなりうる。**
 *
 * **読めなければ null を返す。** 空の配列と区別する——**「1 件も押していない」と
 * 「読めなかった」を同じ値にすると、画面が「まだいいねがありません」と嘘をつく**
 * （`src/home.ts` の「出来ていないものを出来ているように書かない」と同じ規範）。
 *
 * @param env バインディングと環境変数
 * @param userId **セッションで確かめた**利用者 id
 * @param limit 引く最大件数（0 以上 `MAX_LIKED_GAMES_PER_CALL` 以下）
 * @param offset 読み飛ばす件数（0 以上）
 * @returns 作品 id（押した新しい順）。読めなければ null
 */
export async function listLikedGameIds(
  env: Env,
  userId: string,
  limit: number,
  offset: number,
): Promise<readonly string[] | null> {
  try {
    const ids = await likeHub(env).likedGames(userId, limit, offset);
    // RPC の戻り値は複製して返す（`readLikeViewerState` と同じ理由——stub の型が付いたまま
    // 画面へ渡さない）。
    return [...ids];
  } catch (error) {
    logLikesUnavailable('いいねした作品の一覧', error);
    return null;
  }
}

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
 * **作品ページへ 303 で戻さない。** 戻すと、断られたことが URL にもステータスにも
 * 残らない（`src/publish.ts` の `refusal` と同じ判断）。戻り先はリンクで出す。
 *
 * @param heading 見出し
 * @param body 本文
 * @param status ステータスコード
 * @param backTo 戻り先（作品ページ）。無ければ出さない
 * @returns レスポンス
 */
function refusal(heading: string, body: string, status: number, backTo?: string): Response {
  const back = backTo === undefined ? '' : `\n<p><a href="${backTo}">作品ページへ戻る</a></p>`;
  return html(
    `${siteHead({ title: `${heading} - Game Forge`, noindex: true })}
<h1>${heading}</h1>
<p>${body}</p>${back}
${siteFooter()}`,
    status,
  );
}

/** 本文から取り出した対象。 */
type GameIdResult =
  | { readonly ok: true; readonly gameId: string }
  | { readonly ok: false; readonly reason: LikeBodyRejection };

/**
 * 本文から対象の作品 id を取り出す（`src/ogp-recapture.ts` の `readGameId` と同じ形）。
 *
 * @param request 受信したリクエスト
 * @param field 作品 id を載せる項目名（口ごとに別の定数）
 * @returns 作品 id、または理由
 */
async function readGameId(request: Request, field: string): Promise<GameIdResult> {
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
    raw = new URLSearchParams(read.text).get(field) ?? undefined;
  } else {
    try {
      const parsed: unknown = JSON.parse(read.text);
      raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)[field]
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
 * 付与・取り消しの口を処理する。
 *
 * **順序に意味がある**: セッション → 本文 → 押せる作品か（D1 の読み取り）→ DO。
 * 手前で断った要求は DO へ届かない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param endpoint どちらの口か
 * @returns レスポンス
 */
async function handleLike(request: Request, env: Env, endpoint: LikeEndpoint): Promise<Response> {
  const asHtml = wantsHtml(request);

  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    return asHtml ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const target = await readGameId(request, endpoint.field);
  if (!target.ok) {
    const refused = BODY_REFUSALS[target.reason];
    return asHtml
      ? refusal('いいねできません', refused.body, refused.status)
      : json({ error: target.reason }, refused.status);
  }

  const outcome = await changeLike(
    env,
    endpoint.action,
    session.userId,
    target.gameId,
    Math.floor(Date.now() / 1000),
  );

  if (outcome === 'not-pressable') {
    // **戻り先のリンクを出さない。** 押せない作品のページへ送っても、存在しない・
    // 下書き・審査で止めた作品なら 404 である。
    return asHtml
      ? refusal('いいねできません', NOT_PRESSABLE_MESSAGE, 404)
      : json({ error: 'not-found' }, 404);
  }
  if (outcome === 'limited') {
    return asHtml
      ? refusal('いいねできません', DAILY_LIMIT_MESSAGE, 429, workPagePath(target.gameId))
      : json({ error: 'daily-limit' }, 429);
  }

  // POST-redirect-GET。`unchanged`（既にその状態だった）も成功として同じ場所へ戻す——
  // 冪等な口では「2 回目の押下」は失敗ではない。
  return asHtml
    ? seeOther(workPagePath(target.gameId))
    : json({ like: outcome satisfies LikeOperationOutcome }, 200);
}

/**
 * いいねの経路（`src/app.ts` の経路表へ連結する）。
 *
 * **付与と取り消しを 1 つの口に畳まない**（`src/like-paths.ts`）。
 */
export const likeRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: LIKE_ENDPOINT.path,
    handler: (request, env) => handleLike(request, env, LIKE_ENDPOINT),
  },
  {
    method: 'POST',
    path: LIKE_CANCEL_ENDPOINT.path,
    handler: (request, env) => handleLike(request, env, LIKE_CANCEL_ENDPOINT),
  },
];
