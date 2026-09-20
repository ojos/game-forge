/**
 * 相談の対象（#727 / M20-3。仕様 5.16 の確定38「対象——画面は 1 つ、対象は引数」）。
 *
 * **相談の画面は 1 つで、何についての相談かは URL の引数が決める。**
 *
 * | 対象 | 引数 | 何を練るか | 押すと通る経路 |
 * |---|---|---|---|
 * | 新しく作る | 無し | 新しい作品の指示文 | `POST /api/generate`（5.2） |
 * | リフォージ | `?revise=<id>` | **自分の未公開の作品**をどう直すか | `POST /api/revise`（5.7） |
 * | フォーク | `?fork=<id>` | **他人の公開作品**をどう変えるか | `POST /api/fork`（5.3） |
 *
 * ## 判定を持たない
 *
 * **「自分のものか」「公開済みか」を、この画面が独自に判定しない。** リフォージは
 * `myWorkResult`（`author_id` で絞る）、フォークは `status = 'published'` を見る既存の問い合わせを
 * そのまま通す。**2 か所に判定を置くと、片方だけが古くなる**——#690 は作者以外が開いた `/edit`
 * を送り返す判定を 1 か所へ寄せた変更である。
 *
 * ## フォーク元に見せる範囲（確定38）
 *
 * **題名・説明・タグは常に、ソースは作者がその会話で明示的に求めたときだけ。**
 * **最初の指示文は出さない**（1.2.54。指示文は作者本人にしか出さない）。
 *
 * **これは確定37 の「他の作者の作品は情報源にしない」の変更である。** 理由は #711 が 5.15 で
 * 引いた線と同じで、**混入の危険は読ませるものの長さと性質で変わる。** 題名・説明・タグは短く、
 * **既に `/works` の HTML で誰でも読める**——この決定で新しく公開される情報は 1 つも無い。
 */
import type { ChatWorkContext } from './chat-payload.js';
import { loadForkableParent } from './fork.js';
import { GAME_ID_PATTERN } from './work-page.js';
import { myWorkResult } from './works-api.js';

/** 相談の対象の種別（`chat_conversations.target_kind` に入る綴り）。 */
export type ChatTargetKind = 'new' | 'revise' | 'fork';

/** 相談の対象。 */
export type ChatTarget =
  | { readonly kind: 'new'; readonly id: null }
  | { readonly kind: 'revise'; readonly id: string }
  | { readonly kind: 'fork'; readonly id: string };

/** 新しく作る相談（対象なし）。 */
export const NEW_CHAT_TARGET: ChatTarget = { kind: 'new', id: null };

/** リフォージの対象を指す URL の引数の名前。 */
export const CHAT_REVISE_PARAM = 'revise';

/** フォークの対象を指す URL の引数の名前。 */
export const CHAT_FORK_PARAM = 'fork';

/**
 * URL の引数から対象を読む。
 *
 * **両方が載っていたら「新しく作る」に倒す。** どちらかを黙って選ぶと、**押したときに
 * 別の作品が作り直される**——曖昧な要求は、いちばん害の小さい形へ落とす。
 * **綴りが作品 id の形でないものも同じ扱い**である（存在の確認はここでしない。読むときに落ちる）。
 *
 * @param url 画面の URL
 * @returns 対象
 */
export function chatTargetFromUrl(url: URL): ChatTarget {
  const revise = url.searchParams.get(CHAT_REVISE_PARAM);
  const fork = url.searchParams.get(CHAT_FORK_PARAM);
  if (revise !== null && fork !== null) {
    return NEW_CHAT_TARGET;
  }
  if (revise !== null && GAME_ID_PATTERN.test(revise)) {
    return { kind: 'revise', id: revise };
  }
  if (fork !== null && GAME_ID_PATTERN.test(fork)) {
    return { kind: 'fork', id: fork };
  }
  return NEW_CHAT_TARGET;
}

/**
 * 相談の画面のパス（対象つき）を組み立てる。
 *
 * @param basePath 相談の画面のパス
 * @param target 対象
 * @returns パス
 */
export function chatPathFor(basePath: string, target: ChatTarget): string {
  if (target.kind === 'new') {
    return basePath;
  }
  const param = target.kind === 'revise' ? CHAT_REVISE_PARAM : CHAT_FORK_PARAM;
  return `${basePath}?${param}=${encodeURIComponent(target.id)}`;
}

/**
 * 要求の本文から届いた対象を読む（`POST /api/chat`）。
 *
 * **画面が組み立てたものを信じない。** 対象は本文にも載るので、**読むたびに同じ規則で
 * 検証する**——画面を通さずに叩けるためである。**見せてよいかの判定は、文脈を読む側が持つ。**
 *
 * @param kind 本文の `targetKind`
 * @param id 本文の `targetId`
 * @returns 対象（形が違えば null）
 */
export function chatTargetFromBody(kind: unknown, id: unknown): ChatTarget | null {
  if (kind === undefined || kind === null || kind === 'new') {
    return id === undefined || id === null ? NEW_CHAT_TARGET : null;
  }
  if (typeof id !== 'string' || !GAME_ID_PATTERN.test(id)) {
    return null;
  }
  if (kind === 'revise' || kind === 'fork') {
    return { kind, id };
  }
  return null;
}

/**
 * フォーク元（他人の公開作品）の文脈を読む。
 *
 * **公開済みの作品しか読まない**（`status = 'published'`）。**`author_id` では絞らない**
 * ——フォークは他人の作品を対象にする操作である（5.3）。**自分の公開作品も同じ経路を通る。**
 *
 * **最初の指示文（`games.prompt`）は選ばない**（1.2.54）。**選ばなければ、後から
 * 「うっかり載せる」経路が作れない。**
 *
 * @param db D1
 * @param gameId 作品 id
 * @param includeSource ソースも載せるか（作者が明示的に求めたときだけ true）
 * @param readSource ソースを読む段（呼ぶ側が渡す。読めなければ null を返す）
 * @returns 文脈（公開されていなければ null）
 */
export async function loadForkChatContext(
  db: D1Database,
  gameId: string,
  includeSource: boolean,
  readSource: () => Promise<string | null>,
): Promise<ChatWorkContext | null> {
  if (!GAME_ID_PATTERN.test(gameId)) {
    return null;
  }
  // **可否の判定は `src/fork.ts` の `loadForkableParent` が持つ**（#727 の Copilot の指摘で
  // 寄せた）。**ここで `status` を見直さない**——書き写すと、フォークの条件を変えた日に
  // **相談だけが古い条件で通る。**
  const parent = await loadForkableParent(db, gameId);
  if (parent === null) {
    return null;
  }
  const base: ChatWorkContext = {
    title: parent.title,
    // **他人の最初の指示文は出さない**（1.2.54）。正本の問い合わせも選んでいない。
    prompt: null,
    description: parent.description,
    tags: parent.tags,
    source: null,
  };
  if (!includeSource) {
    return base;
  }
  return { ...base, source: await readSource() };
}

/**
 * リフォージの対象（自分の作品）の文脈を読む。
 *
 * **`myWorkResult` をそのまま通す**（`author_id` で絞るのはあちらである）。5.16 の
 * 「見せる情報」の表がそのまま当てはまる——題名と最初の指示文、ソースは求められたときだけ。
 *
 * @param env バインディングと環境変数
 * @param userId 利用者の id
 * @param gameId 作品 id
 * @param includeSource ソースも載せるか
 * @returns 文脈（自分の作品でなければ null）
 */
export async function loadReviseChatContext(
  env: Env,
  userId: string,
  gameId: string,
  includeSource: boolean,
): Promise<ChatWorkContext | null> {
  const detail = await myWorkResult(env, userId, gameId, 'detail');
  if (detail.status !== 200) {
    return null;
  }
  // **「自分のもの」だけでは足りない**（#727 の Copilot の指摘）。`myWorkResult` は公開済みも
  // 失敗した行も返すが、**リフォージできるのは自作の `draft` で `generation_state = 'ready'`
  // のものだけ**である（5.7。判定の正本は `src/revisions.ts` の `claimRevisionSlot`）。
  // **揃えないと、開いても押した先が必ず 409 になる画面を出すことになる**（4.4 が無くそうと
  // しているものである）。
  const revisable = await env.DB.prepare(
    `select 1 from games where id = ? and author_id = ? and status = 'draft'
        and generation_state = 'ready'`,
  )
    .bind(gameId, userId)
    .first<{ 1: number }>();
  if (revisable === null) {
    return null;
  }
  const body = detail.body as { title?: unknown; prompt?: unknown };
  const base: ChatWorkContext = {
    title: typeof body.title === 'string' ? body.title : '',
    prompt: typeof body.prompt === 'string' ? body.prompt : null,
    description: null,
    tags: [],
    source: null,
  };
  if (!includeSource) {
    return base;
  }
  const source = await myWorkResult(env, userId, gameId, 'source');
  if (source.status !== 200) {
    return base;
  }
  const sourceBody = source.body as { source?: unknown };
  return {
    ...base,
    source: typeof sourceBody.source === 'string' ? sourceBody.source : null,
  };
}
