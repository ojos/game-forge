/**
 * 公開作品の一覧を機械が読める口（#699 / M19-2。仕様 5.13）。
 *
 * 「作品をさがす」（`/works`）が HTML で出している公開作品の一覧を、JSON で読めるようにする。
 * 作品には**作者のユーザー ID（`authorId`）**を付け、ユーザー情報の口（#700 / 仕様 5.14）へたどれるようにする。
 *
 * | 口 | 返すもの |
 * |---|---|
 * | `GET /api/works` | `/works` と同じ並び・タグの絞り込み・キーワード検索・頁送りの、1 頁 20 件 |
 *
 * ## 読み取りは `/works` と同じ関数とキャッシュを通す
 *
 * **可視の判定（公開済み・審査）と並べ方をここに書かない。** 引くのは `src/works-list.ts` の
 * `loadWorksListPage` で、画面と同じ問い合わせ・同じ鍵のキャッシュ（`src/list-cache.ts`）に載る。
 * 書き直すと、審査で止めた作品を画面では隠して口では返す、というずれが生まれても動作では気づけない。
 *
 * ## 返さないもの
 *
 * **指示文・ソース・R2 のキー・ビルドのジョブ ID など内部の識別子は返さない**（1.2.54 / #699 の scope.out）。
 * 返すのは作品カードに出ている情報と説明・リンクだけで、**公開する範囲は `/works` の HTML から増えない。**
 * 作者のユーザー ID は、作者ページの URL（`/users/<user_id>`）とサイトマップで既に公開されている値である。
 *
 * ## 認証と上限
 *
 * {@link resolveApiCaller} を通す（ログイン必須。未認証は 401）。**認証の後で**、利用者の id ごとに
 * 60 秒あたり 60 回の上限を数える（`src/api-rate-limit.ts`。超えたら 429）。数える側を呼べなかった
 * ときは通す（fail-open。理由は同ファイル）。
 *
 * ## 学習に使わないでほしいことを伝える
 *
 * 応答に `Content-Signal`（`src/robots.ts` の {@link CONTENT_SIGNAL}。`ai-train=no`）を付ける。
 * **効くのは行儀のよい相手だけである**——まとめて抜き出しにくくするのは、ログイン必須と上限のほうである。
 */
import { allowApiCall, API_RATE_LIMIT, RATE_LIMITED_BODY } from './api-rate-limit.js';
import { resolveApiCaller } from './api-caller.js';
import { sandboxOriginOf } from './avatar-paths.js';
import type { PublicWork } from './games.js';
import { workPagePath } from './paths.js';
import { PUBLIC_WORKS_API_PATH } from './public-works-api-paths.js';
import { CONTENT_SIGNAL } from './robots.js';
import { json, type Route } from './routes.js';
import { knownWorkTags } from './work-card.js';
import { loadWorksListPage } from './works-list.js';

/** 上限を数えるときの口の名前（鍵の前半。`src/api-rate-limit.ts`）。 */
export const PUBLIC_WORKS_API_SCOPE = 'works';

/** すべての応答に付ける見出し（401 と 429 を含む）。 */
const SIGNAL_HEADERS = { 'content-signal': CONTENT_SIGNAL } as const;

/** 口が返す 1 件（仕様 5.13）。**作品カードの情報と説明・リンクだけ**で、内部の識別子を足さない。 */
export interface PublicWorkApiItem {
  readonly id: string;
  readonly title: string;
  /** 作者が書いた説明。**空文字が「説明が無い」。** */
  readonly description: string;
  /** タグの識別子（語彙にあるものだけ。枠の順）。 */
  readonly tags: readonly string[];
  /** 作者の `users.id`。ユーザー情報の口（#700）へたどる鍵。 */
  readonly authorId: string | null;
  readonly author: { readonly displayName: string | null; readonly handle: string | null };
  /** いいねの数（`games.like_count`。**最大 5 分遅れる**。5.8）。 */
  readonly likeCount: number;
  /** プレイ数（`games.play_count`。**最大 5 分遅れる**。配備の直後の最大 60 秒は null がありうる）。 */
  readonly playCount: number | null;
  /** 公開済みのフォークの数。 */
  readonly forkCount: number;
  /** 最初に公開した時刻（UNIX 秒）。 */
  readonly publishedAt: number | null;
  /** 作品ページ（アプリ用ホスト）と、遊ぶ URL（サンドボックス用ホストの `/g/<id>/`）。どちらも絶対 URL。 */
  readonly links: { readonly page: string; readonly play: string };
}

/**
 * 一覧の 1 件を口の形へ落とす。
 *
 * **項目を 1 つずつ選ぶ**（`...work` で広げない）。`PublicWork` に列が増えた日に、口の応答へ黙って
 * 載らないようにする。
 *
 * **欠けている項目は null か空に倒す。** 一覧の行は Cache API に載っており、配備の直後の最大 60 秒は
 * 列を選んでいなかった頃の行が返りうる（`src/games.ts` の `PublicWork` の注記）。
 *
 * @param work 一覧の 1 件
 * @param appOrigin アプリ用ホストのオリジン
 * @param sandboxOrigin サンドボックス用ホストのオリジン
 * @returns 口の 1 件
 */
export function toPublicWorkApiItem(work: PublicWork, appOrigin: string, sandboxOrigin: string): PublicWorkApiItem {
  return {
    id: work.id,
    title: work.title,
    description: work.description ?? '',
    tags: knownWorkTags(work.tags).map((tag) => tag.id),
    authorId: work.authorId ?? null,
    author: { displayName: work.authorName, handle: work.authorHandle ?? null },
    likeCount: work.likeCount,
    playCount: work.playCount ?? null,
    forkCount: work.forkCount,
    publishedAt: work.publishedAt,
    links: {
      page: `${appOrigin}${workPagePath(work.id)}`,
      // 作品ページの iframe と同じ綴り（`src/work-page.ts` の `publishedUrl`。`/g/` は公開済みしか返さない）。
      play: `${sandboxOrigin}/g/${work.id}/`,
    },
  };
}

/**
 * `GET /api/works` — 公開作品の一覧。
 *
 * **引数の読み方は `/works` と同じである**（知らない `sort` / `tag` は落とし、`page` は 1〜50 に丸める）。
 * 実際に使った値を応答に書き戻すので、呼び出し側は落とされたかを確かめられる。**断った検索（1 文字だけ・
 * 語が多すぎる・長すぎる）だけは 400 にする**——画面は理由を書いて空の一覧を出すが、機械には空の一覧と
 * 「当たらなかった」が区別できない。どちらも D1 を引かない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns 一覧
 */
export async function handleListPublicWorks(request: Request, env: Env): Promise<Response> {
  const caller = await resolveApiCaller(request, env);
  if (!caller.ok) {
    return json({ error: 'unauthorized' }, 401, SIGNAL_HEADERS);
  }
  if (!(await allowApiCall(env, PUBLIC_WORKS_API_SCOPE, caller.userId))) {
    return json(RATE_LIMITED_BODY, 429, { ...SIGNAL_HEADERS, 'retry-after': String(API_RATE_LIMIT.periodSeconds) });
  }

  const url = new URL(request.url);
  const list = await loadWorksListPage(env, url);
  if (list.search.kind === 'rejected') {
    return json({ error: 'invalid-query', reason: list.search.reason }, 400, SIGNAL_HEADERS);
  }
  const sandboxOrigin = sandboxOriginOf(request, env.SANDBOX_HOST);
  return json(
    {
      sort: list.sort,
      tag: list.tag,
      q: list.search.kind === 'accepted' ? list.search.text : null,
      page: list.page,
      works: list.works.map((work) => toPublicWorkApiItem(work, url.origin, sandboxOrigin)),
      nextPage: list.hasNext ? list.page + 1 : null,
    },
    200,
    SIGNAL_HEADERS,
  );
}

/** 公開作品の一覧を機械が読める口の経路。 */
export const publicWorksApiRoutes: readonly Route[] = [
  { method: 'GET', path: PUBLIC_WORKS_API_PATH, handler: handleListPublicWorks },
];
