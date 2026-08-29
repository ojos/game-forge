/**
 * 生成ジョブから D1 を更新するためのコールバック経路（#150 / A 案）。
 *
 * ## 何のためにあるか
 *
 * 生成の本体（91 秒）は Worker の外——オーケストレータ Lambda——へ移る。**移した先から
 * D1 を書く経路が要る。** 選択肢は 2 つあった。
 *
 *   (a) Cloudflare の API トークンを AWS 側へ置き、D1 の REST API を直接叩く
 *   (b) Worker のコールバック経路を叩く（**これ**）
 *
 * **(a) を採らない。** D1 の編集権限はアカウント単位で、そのトークンは本番を含む
 * **すべての D1 データベースの読み書きと削除**ができる。「1 行を更新したい」に対して
 * 代償が大きすぎる（7.3 / 9.2）。**D1 のバインディングを持つ場所を 1 か所に保つ。**
 *
 * ## 長命の共有シークレットも置かない
 *
 * (b) でも、AWS 側に恒久的な鍵を 1 本置く形は避けられる。**ジョブごとの使い捨て
 * トークン**を使う（`src/games.ts`）。
 *
 * - Worker が行を作るときに 256 ビットの乱数を引き、**ハッシュだけ**を `games` へ保存
 * - 平文はジョブのペイロードにだけ載る
 * - このトークンにできるのは**その 1 行を進めること**だけ。寿命は 1 ジョブ
 * - 完了と同時に `job_token_hash` は NULL になる（**使い捨て**）
 *
 * したがって、この経路が漏れても他の作品にも他のテーブルにも届かない。
 *
 * ## この PR ではまだ誰も呼ばない
 *
 * オーケストレータ Lambda・IAM・配備は別 issue である。**それでも経路と契約を先に
 * 置くのは、`src/generate.ts` の `startJob` を差し替えるときに、Worker 側で決めるべき
 * ことが残っていない状態にしておくためである。** 契約（何を送れば何が起きるか）は
 * ここが正本になる。
 *
 * ## `ledger` は届くまで再送される前提で作る
 *
 * **LLM を呼んだあとにこのコールバックが落ち続けると、課金は出ているのに
 * `generations` の行が無い状態になる。** 4.3 の「リトライ分も必ず計上する」が崩れ、
 * 日次枠も減らない（確定25 は枠を台帳の行数で数える）。利用者には得だが、
 * **費用ガードの前提が壊れる。**
 *
 * **コールバックの再送は LLM を呼ばないので費用ゼロである。** したがって呼ぶ側は
 * 届くまで再送してよく、**こちら側は何度受け取っても壊れないようにしてある**
 * （`ledger` は呼ぶ側が採番した `generations.id` を主キーにして `insert or ignore`）。
 */
import type { Route } from './routes.js';
import { json, readLimitedText } from './routes.js';
import { claimGenerationJob, failGame, hashJobToken } from './games.js';
import { GENERATION_ERROR_CODES } from './games.js';
import type { GenerationErrorCode } from './games.js';

/** コールバックのパス。 */
export const GENERATE_CALLBACK_PATH = '/api/generate/callback';

/**
 * 受け付ける本文の最大バイト数。
 *
 * 生成ソースも診断も載らない（載せる先は R2 と、呼ぶ側のログである）。載るのは id と
 * トークンと数値だけなので 8 KiB で余る。**`src/generate.ts` の 16 KiB より小さい**
 * ——あちらはプロンプトを受け取るが、こちらは受け取らない。
 */
const MAX_BODY_BYTES = 8 * 1024;

/** 受け付ける `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * コールバックの種別。
 *
 * | 種別 | 何をするか |
 * |---|---|
 * | `claim` | `pending` → `running`。**重複実行を止める関門**（`src/games.ts`） |
 * | `finish` | `running` → `failed`。分類名を添える |
 *
 * **`ledger` と `cache-lookup`、および `finish` の成功側は、この PR には無い。**
 * どれもオーケストレータ Lambda が来て初めて呼ばれるもので、**呼ぶ側が無い段階で
 * 実装すると、検証されない分岐が本番の経路に増える。** `src/generate.ts` が
 * 「空実装を成功にしない」と決めているのと同じ理由で、**まだ受け取らない種別は
 * 受け取らないと言う**（400 で落とす）。契約はモジュール冒頭に書いてある。
 */
export const CALLBACK_KINDS = ['claim', 'finish'] as const;

/** コールバックの種別。 */
export type CallbackKind = (typeof CALLBACK_KINDS)[number];

/** 受け付けられなかった理由。 */
export type CallbackRejection =
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'malformed-json'
  | 'unknown-field'
  | 'missing-game-id'
  | 'missing-job-token'
  | 'unknown-kind'
  | 'unknown-error-code';

/** 検証を通ったコールバック。 */
export interface CallbackRequest {
  readonly gameId: string;
  readonly jobToken: string;
  readonly kind: CallbackKind;
  /** `finish` のときだけ意味を持つ失敗の分類名。 */
  readonly errorCode?: GenerationErrorCode;
}

/** 解析結果。 */
export type CallbackParseResult =
  | { readonly ok: true; readonly request: CallbackRequest }
  | { readonly ok: false; readonly reason: CallbackRejection };

/** 本文で受け取ってよい項目。**これ以外が来たら断る。** */
const ALLOWED_FIELDS = new Set(['gameId', 'jobToken', 'kind', 'errorCode']);

/**
 * 本文を解析して検証する。
 *
 * **この関数は例外を投げない**（`src/generate.ts` の `parseGenerateRequest` と同じ方針）。
 *
 * 未知の項目を拒否するのは、綴り違いが「既定値で通った」形になるのを防ぐため。
 * この経路は作品行を進めるので、曖昧な入力を推測で受け取らない。
 *
 * @param request 受信したリクエスト
 * @returns 解析結果
 */
export async function parseCallbackRequest(request: Request): Promise<CallbackParseResult> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: 'unsupported-content-type' };
  }

  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, reason: body.reason };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed-json' };
  }

  const fields = parsed as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, reason: 'unknown-field' };
    }
  }

  const gameId = fields['gameId'];
  if (typeof gameId !== 'string' || gameId === '') {
    return { ok: false, reason: 'missing-game-id' };
  }
  const jobToken = fields['jobToken'];
  if (typeof jobToken !== 'string' || jobToken === '') {
    return { ok: false, reason: 'missing-job-token' };
  }
  const rawKind = fields['kind'];
  if (typeof rawKind !== 'string' || !(CALLBACK_KINDS as readonly string[]).includes(rawKind)) {
    return { ok: false, reason: 'unknown-kind' };
  }
  const kind = rawKind as CallbackKind;

  const errorCode = fields['errorCode'];
  if (errorCode !== undefined) {
    if (
      typeof errorCode !== 'string' ||
      !(GENERATION_ERROR_CODES as readonly string[]).includes(errorCode)
    ) {
      // **知らない分類名を素通ししない。** 素通しすると、`games.generation_error` に
      // 画面が知らない値が入り、作品ページが既定の文言へ落ちる（何が起きたかを
      // 利用者にもこちらにも説明できなくなる）。
      return { ok: false, reason: 'unknown-error-code' };
    }
    return {
      ok: true,
      request: { gameId, jobToken, kind, errorCode: errorCode as GenerationErrorCode },
    };
  }

  return { ok: true, request: { gameId, jobToken, kind } };
}

/**
 * コールバックを処理する。
 *
 * # 認証はジョブトークンだけである
 *
 * セッション cookie を見ない。**呼ぶのはブラウザではなく AWS だからである。**
 * 逆に言うと、この経路はログインしていない相手からの POST を受け付ける。
 * 通るのは `gameId` と `jobToken` の組が一致したときだけで、どちらも推測できない。
 *
 * # 失敗の理由を細かく返さない
 *
 * トークンが違うのか、行が無いのか、既に完了しているのかを区別して返さない。
 * 区別すると、任意の id が存在するかを外から確かめられる手がかりになる
 * （`src/session-user.ts` と同じ考え方）。**呼ぶ側にとっても区別は要らない**
 * ——`claim` が通らなければ降りる、それだけである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const parsed = await parseCallbackRequest(request);
  if (!parsed.ok) {
    return json({ error: parsed.reason }, 400);
  }
  const { gameId, jobToken, kind, errorCode } = parsed.request;

  const tokenHash = await hashJobToken(jobToken);

  if (kind === 'claim') {
    // **握れたかどうかをそのまま返す。** 呼ぶ側は false を受け取ったら LLM を呼ばずに
    // 降りる。これが「1 回の送信につき LLM は 1 回」を担保する唯一の関門である
    // （`src/games.ts` の `claimGenerationJob`）。
    const claimed = await claimGenerationJob(env, gameId, tokenHash);
    return json({ claimed }, 200);
  }

  // kind === 'finish'。**この PR では失敗側だけを受け取る。**
  //
  // 成功側（成果物のキーと Go の版を書いて `ready` にする）を実装しないのは、
  // 呼ぶ側がまだ無く、**検証されない分岐を本番の経路へ増やさない**ためである。
  // 同期実行の既定では `completeGame` が Worker の中で直接呼ばれている
  // （`src/generate.ts`）。
  if (errorCode === undefined) {
    return json({ error: 'unknown-error-code' }, 400);
  }

  // **トークンを照合してから落とす。** `failGame` はトークンを見ないので、
  // ここで確かめないと id を知っているだけで他人の生成を失敗させられる。
  const owns = await ownsJob(env, gameId, tokenHash);
  if (!owns) {
    return json({ finished: false }, 200);
  }

  const finished = await failGame(env, gameId, errorCode);
  return json({ finished }, 200);
}

/**
 * その `gameId` の現在のジョブトークンが一致するかを確かめる。
 *
 * **`claim` のように 1 回の UPDATE で済ませられない。** `failGame` は
 * `pending` / `running` のどちらからでも遷移させるうえ、トークンの照合を
 * 条件に含めていない（同期実行では Worker が自分で呼ぶため、トークンを持ち回る
 * 意味が無い）。外から呼ばれるこの経路だけが、先に照合する。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param tokenHash ジョブトークンのハッシュ
 * @returns 一致すれば true
 */
async function ownsJob(env: Env, gameId: string, tokenHash: string): Promise<boolean> {
  const row = await env.DB.prepare('select job_token_hash from games where id = ?')
    .bind(gameId)
    .first<{ job_token_hash: string | null }>();
  return row !== null && row.job_token_hash !== null && row.job_token_hash === tokenHash;
}

/** アプリの経路表へ連結するコールバックの経路。 */
export const generateCallbackRoutes: readonly Route[] = [
  { method: 'POST', path: GENERATE_CALLBACK_PATH, handler: handleCallback },
];
