/**
 * オーケストレータへ渡す非同期呼び出しのペイロード（#160 / A 案）。
 *
 * ## なぜ独立したモジュールなのか
 *
 * **この形だけが、Worker（送る側）と Lambda（受ける側）の両方から使われる。**
 * どちらかの側へ書くと、もう一方が同じ形をもう一度書くことになる
 * （shared-ai-rules 12 章「一覧の複製は機械照合で担保する」の、複製を作らない側）。
 *
 * ## 何を載せ、何を載せないか
 *
 * | 項目 | 載せる理由 |
 * |---|---|
 * | `gameId` | どの行を進めるか。コールバックの宛先そのもの |
 * | `jobToken` | **平文**。D1 にはハッシュしか無い（`src/games.ts`） |
 * | `prompt` | 生成の入力。`ledger` で送り返す元でもある（`generations.prompt`） |
 * | `modelKey` | どのモデルで生成するか。**正本は `wrangler.toml` の `GENERATION_MODEL`** |
 *
 * **`userId` を載せない。** 台帳の作者は `games` 行が知っており、そちらが正である
 * （`src/generate-callback.ts` の `ledger`）。載せると、トークンを持つ者が本文で
 * 他人を名指しして枠を消費できる形が生まれる。**要らないものを運ばない。**
 *
 * **コールバックの URL を載せない。** 宛先は Lambda 側の環境変数
 * （`CALLBACK_BASE_URL`）が持つ。ペイロードで受け取る形にすると、**呼び出しの
 * ペイロードを差し替えられる者がジョブトークンの送り先を変えられる。** 宛先は
 * 宣言（`terraform/orchestrator.tf`）が決め、実行時の入力では動かせないほうがよい。
 *
 * **モデルの鍵はペイロードで渡す。** Lambda 側にもう 1 つ `GENERATION_MODEL` を
 * 置くと、確定5 の A/B がどちらの宣言で決まるのか読めなくなる。エッジが選び、
 * オーケストレータは**登録簿に在る鍵かどうかだけ**を確かめて従う。
 *
 * ## 大きさ
 *
 * Lambda の非同期呼び出しのペイロード上限は 256 KB。`prompt` は 2,000 文字
 * （`src/generate.ts` の `MAX_PROMPT_LENGTH`）なので UTF-8 最大でも 8 KB で、
 * 他の項目を足しても桁が 1 つ違う。
 */
import type { GenerationModelKey } from '../generation-models.js';
import { findGenerationModel } from '../generation-models.js';
import { MAX_PROMPT_LENGTH } from '../generate.js';
import { MAX_SOURCE_BYTES } from '../system-prompt.js';
import { TIDY_MAX_SOURCE_BYTES, isTidyPass } from '../source-size.js';

/**
 * ペイロードの版。
 *
 * **受け側が知らない版を黙って処理しない。** 送る側だけを先に配ると、古い Lambda が
 * 新しい形を「知っている項目だけ読んで」処理してしまう。生成は 1 回 約 16 円で、
 * 黙って走り出す形をここに作らない。
 */
export const ORCHESTRATOR_PAYLOAD_VERSION = 1;

/**
 * `baseSource` を載せた本文の版（5.7 の推敲 / #192）。
 *
 * # 版は「この本文を読むのに必要な最小の版」である
 *
 * **一律に上げない。** `baseSource` を持たない本文は版 1 のまま送る。理由は配備の
 * 順序にある。
 *
 * | 側 | 配備 |
 * |---|---|
 * | 送る側（Worker / Pages） | **main へのマージで自動** |
 * | 受ける側（オーケストレータ Lambda） | **利用者が手で叩く**（`scripts/deploy-orchestrator.sh`） |
 *
 * **一律に 2 へ上げると、Lambda を配備し直すまで生成が 1 本残らず落ちる。**
 * 上の「知らない版を黙って処理しない」がそのまま効くからで、これは正しい振る舞いだが、
 * **落ちる範囲が推敲だけであるべきところを全生成へ広げてしまう。**
 *
 * 版を能力の宣言として使えば、**古い Lambda は従来どおり新規生成を処理し、推敲だけが
 * 「知らない版」として断られる**（そして推敲は #193 の画面が入るまで誰も呼べない）。
 *
 * **省略可能な項目だから版を上げなくてよい、ではない。** 上げないと古い受け側が
 * `baseSource` を落としたまま生成を走らせ、推敲したつもりの利用者に**まったく別の
 * ゲーム**が返る。1 回 約 16 円を払ったうえで、である。
 */
export const ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE = 2;

/**
 * 上限を超えた `baseSource` を載せた本文の版（確定18 の整理パス / 5.3 / M5-2 / #33）。
 *
 * # なぜ版を 1 つ増やすのか
 *
 * **版 2 は `baseSource` が上限（64KB）を超えていたら本文ごと拒否する。** それが正しい——
 * 上限を守るための検査である。しかし**整理パスの入力はまさに上限超のソース**なので、
 * 5.3 が定めた逃げ道は版 2 の受け側では原理的に通れない（#33 で判明した）。
 *
 * **無条件に検査を緩めない。** 緩めると上限そのものが消える。**版 3 を名乗る本文だけ**が
 * {@link TIDY_MAX_SOURCE_BYTES}（上限の 2 倍）までを載せられる、という形にした。
 * 版 1・版 2 の受け入れ条件は 1 つも変えていない。
 *
 * # 配備の順序（**ここを間違えると本番の生成が止まる**）
 *
 * **受け側（オーケストレータ Lambda）を先に配る。送り側（Worker）は後である。**
 *
 * | 側 | 配備 |
 * |---|---|
 * | 送る側（Worker / Pages） | **main へのマージで自動** |
 * | 受ける側（オーケストレータ Lambda） | **利用者が手で叩く**（`scripts/deploy-orchestrator.sh`） |
 *
 * 2026-09-01 に、`wrangler.toml` を変えて Worker を先に配ったところ、**配備済みの
 * オーケストレータがその鍵を知らず、本番の生成が 12 分止まった**（`docs/handoff.md`
 * 1 章）。**「repo に入っている」と「動いている Lambda が知っている」は別である。**
 *
 * **ただし今回、順序を誤っても壊れる範囲は整理パスだけである。** 版を能力の宣言として
 * 使う設計（版 2 の注記）がそのまま効く——古い Lambda は版 1・版 2 を今までどおり
 * 処理し、**版 3 だけが「知らない版」として断られる。** 一律に版を上げないのは
 * このためである。
 */
export const ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY = 3;

/** 受け側が理解できる版。 */
const SUPPORTED_VERSIONS: readonly number[] = [
  ORCHESTRATOR_PAYLOAD_VERSION,
  ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE,
  ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY,
];

/** 非同期呼び出しの本文。 */
export interface OrchestratorPayload {
  /**
   * この本文を読むのに必要な最小の版。
   *
   * {@link ORCHESTRATOR_PAYLOAD_VERSION}、または `baseSource` を載せているなら
   * {@link ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE}。
   */
  readonly version: number;
  /** 作品 id。 */
  readonly gameId: string;
  /** そのジョブだけを進められる使い捨てトークン（平文）。 */
  readonly jobToken: string;
  /** 利用者が入力した自然文プロンプト。 */
  readonly prompt: string;
  /** 生成に使うモデルの鍵（`src/generation-models.ts` の登録簿）。 */
  readonly modelKey: GenerationModelKey;
  /**
   * 元にするソース（5.7 の推敲）。**新規生成では持たない。**
   *
   * 上限は {@link MAX_SOURCE_BYTES}（30 KB。確定18 / 5.3）で、Lambda の非同期呼び出しの
   * ペイロード上限 256 KB に対して桁が 1 つ違う。**プロンプトと合わせても収まる。**
   *
   * **版 3（整理パス）だけは {@link TIDY_MAX_SOURCE_BYTES}（60 KB）まで載る**
   * （{@link ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY}）。それでも 256 KB に対して
   * 桁が 1 つ違う。
   */
  readonly baseSource?: string;
}

/**
 * ペイロードを組み立てる（送る側）。
 *
 * @param job 起動するジョブ
 * @param modelKey 生成に使うモデルの鍵
 * @returns 非同期呼び出しの本文
 */
export function buildOrchestratorPayload(
  job: {
    readonly gameId: string;
    readonly jobToken: string;
    readonly request: { readonly prompt: string; readonly baseSource?: string };
  },
  modelKey: GenerationModelKey,
): OrchestratorPayload {
  const base = {
    gameId: job.gameId,
    jobToken: job.jobToken,
    prompt: job.request.prompt,
    modelKey,
  };
  // **新規生成では項目ごと載せず、版も上げない**（上記）。`baseSource: undefined` を
  // 置くと `JSON.stringify` が落とすので実害は無いが、**受け側の未知項目の検査を
  // 「値が undefined なら許す」へ緩める必要が出る**（いまは鍵の集合だけを見ている）。
  if (job.request.baseSource === undefined) {
    return { version: ORCHESTRATOR_PAYLOAD_VERSION, ...base };
  }
  // **整理パスだけが版 3 を名乗る**（確定18 / #33）。判定は `isTidyPass` の 1 か所で、
  // ここで大きさを測り直さない——**送る側と受ける側が別々に「整理かどうか」を決めると、
  // 片方だけがそう思っている本文が作れる。**
  return {
    version: isTidyPass(job.request)
      ? ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY
      : ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE,
    ...base,
    baseSource: job.request.baseSource,
  };
}

/**
 * ペイロードから**仕事の宛先だけ**を取り出す（#242）。
 *
 * # なぜ全体の検証と分けるのか
 *
 * **断るときも、行を閉じられるなら閉じるためである。** 2026-09-01、登録簿のずれで
 * {@link parseOrchestratorPayload} が `null` を返し（#241）、**コールバックを 1 通も
 * 送らなかった。** 作品行は `pending` のまま残り、作者の画面は 15 分のあいだ
 * 「生成中です／通常 1〜2 分」を出し続けた。
 *
 * **宛先が読めるなら、失敗したことは伝えられる。** 中身が契約に合っていなくても、
 * `gameId` と `jobToken` の形が正しければ、その行を握って閉じられる。
 *
 * # ここで中身の妥当性を見ない
 *
 * **見るのは「宛先として使える形か」だけである。** 実際に握れるかどうかは
 * `jobToken` の照合が決める（`src/games.ts` の `claimGenerationJob`）——**この関数が
 * 通したからといって、その行を触れるわけではない。**
 *
 * @param value 呼び出しで届いた値
 * @returns 宛先、または読み取れなければ null
 */
export function identifyOrchestratorJob(
  value: unknown,
): { readonly gameId: string; readonly jobToken: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const gameId = record['gameId'];
  const jobToken = record['jobToken'];
  if (typeof gameId !== 'string' || gameId === '') {
    return null;
  }
  if (typeof jobToken !== 'string' || jobToken === '') {
    return null;
  }
  return { gameId, jobToken };
}

/**
 * ペイロードを検証する（受ける側）。
 *
 * **この関数は例外を投げない**（`src/generate.ts` の `parseGenerateRequest`、
 * `src/generate-callback.ts` の `parseCallbackRequest` と同じ方針）。
 *
 * 未知の項目は**断る**。綴り違いが「既定値で通った」形になると、そのまま LLM を
 * 呼んでしまう。
 *
 * @param value 呼び出しで届いた値
 * @returns 検証を通ったペイロード、または null
 */
export function parseOrchestratorPayload(value: unknown): OrchestratorPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['version', 'gameId', 'jobToken', 'prompt', 'modelKey', 'baseSource'].includes(key)) {
      return null;
    }
  }
  const version = record['version'];
  if (typeof version !== 'number' || !SUPPORTED_VERSIONS.includes(version)) {
    return null;
  }
  const gameId = record['gameId'];
  const jobToken = record['jobToken'];
  const prompt = record['prompt'];
  const modelKey = record['modelKey'];
  if (typeof gameId !== 'string' || gameId === '') {
    return null;
  }
  if (typeof jobToken !== 'string' || jobToken === '') {
    return null;
  }
  if (typeof prompt !== 'string' || prompt === '' || [...prompt].length > MAX_PROMPT_LENGTH) {
    return null;
  }
  if (typeof modelKey !== 'string' || findGenerationModel(modelKey) === null) {
    return null;
  }
  // **空文字は断る。** 「載っているが空」は新規生成と推敲のどちらとも読めるので、
  // 送る側の不具合を黙って新規生成として実行させない（1 回 約 16 円が出る）。
  const baseSource = record['baseSource'];
  if (baseSource === undefined) {
    // **版 2 を名乗って `baseSource` が無い本文は断る。** 版が能力の宣言である以上、
    // 名乗りと中身が食い違う本文を「たぶん新規生成だろう」と解釈しない。
    if (version !== ORCHESTRATOR_PAYLOAD_VERSION) {
      return null;
    }
    return {
      version,
      gameId,
      jobToken,
      prompt,
      modelKey: modelKey as GenerationModelKey,
    };
  }
  // **`baseSource` を載せた本文は版 2 か版 3 を名乗らなければならない。** 版 1 で通すと、
  // 古い受け側が読めない項目を「読める版」として受け取ることになる。
  if (
    version !== ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE &&
    version !== ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY
  ) {
    return null;
  }
  if (typeof baseSource !== 'string' || baseSource === '') {
    return null;
  }
  // **上限は版で変わる。** 版 2 は `MAX_SOURCE_BYTES`（確定18 の上限そのもの。64KB）、
  // **版 3＝整理パスだけ**が
  // その 2 倍まで載せられる（`src/source-size.ts` の `TIDY_MAX_SOURCE_BYTES`）。
  //
  // **版 2 の条件は 1 文字も緩めていない。** 緩めると、整理を頼んでいない生成が上限超の
  // ソースを土台にでき、**5.3 の上限そのものが消える。** 版を名乗ることが、その 1 回に
  // 限って上限を外す唯一の口である。
  const bytes = new TextEncoder().encode(baseSource).length;
  const limit =
    version === ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY ? TIDY_MAX_SOURCE_BYTES : MAX_SOURCE_BYTES;
  if (bytes > limit) {
    return null;
  }
  // **版 3 を名乗って上限内のソースを載せた本文も断る**（#258 のレビュー指摘）。
  //
  // **版 2 の規則と同じである**——「版 2 を名乗って `baseSource` が無い本文は断る。
  // 版が能力の宣言である以上、名乗りと中身が食い違う本文を『たぶん新規生成だろう』と
  // 解釈しない」。版 3 は「整理パスである」という宣言なので、整理パスでない中身を
  // 伴った版 3 は同じ食い違いである。
  //
  // **上限そのものが危うかったわけではない。** 振る舞いを決めるのは名乗りではなく
  // 元ソースの大きさ（`isTidyPass`）で、上限内のソースを積んだ版 3 は通しても通常の
  // フォークとして走る。**断る理由は、送る側と受ける側の契約を厳密に保つことである**
  // ——`buildOrchestratorPayload` は整理パスのときしか版 3 を作らないので、そうでない
  // 版 3 が届いたら**それは送り側の不具合か、こちらが作っていない本文**である。
  if (version === ORCHESTRATOR_PAYLOAD_VERSION_WITH_TIDY && bytes <= MAX_SOURCE_BYTES) {
    return null;
  }
  return {
    version,
    gameId,
    jobToken,
    prompt,
    modelKey: modelKey as GenerationModelKey,
    baseSource,
  };
}
