/**
 * フォークの操作（`POST /api/fork`）。
 * **5.3 の「他人の公開作品を、親のソース＋差分プロンプトで改造する」の実体である**
 * （#32 / M5-1）。2.2 のコア体験ループの真ん中であり、10.1 の主 KPI（フォーク率）は
 * この経路が動かないと 1 件も測れない。
 *
 * ## 推敲（5.7）とほぼ同じ機構である
 *
 * **生成の形は 5.7 と同一で、作り直したものは何も無い。** 元ソースを `messages` の
 * 先頭へ載せる経路は #192 が通したものをそのまま使う。
 *
 *     GenerateRequest.baseSource
 *       → buildOrchestratorPayload（版 2。`src/orchestrator/payload.ts`）
 *       → buildConverseRequest（`messages[0].content[0]` ＋ 直後の cachePoint。`src/bedrock.ts`）
 *
 * 4.5 のキャッシュが**同じ親の 2 回目で効く**ことも、この経路で実測済みである
 * （仕様 1.2.43）。**同じ親を続けて改造するあいだ、前置きとソースが共有プレフィックス
 * になる**——差分プロンプトはブレークポイントのうしろに置くので、毎回変わってもキャッシュを
 * 割らない。
 *
 * ## 推敲との違いは 2 つだけである（5.7 の表）
 *
 * | | フォーク（本モジュール） | 推敲（`src/revise.ts`） |
 * |---|---|---|
 * | 対象 | 他人の**公開済み**作品 | 自分の **`draft`** |
 * | 結果 | **新しい作品行**が生まれる | 同じ作品行が置き換わる |
 * | `parent_id` | **親を指す** | 張らない |
 * | `fork_count` | 親の値が増える（**#34**。ここでは動かさない） | 動かさない |
 * | 10.1 の分母 | 入る | 入らない |
 *
 * **「自分の作品を親にする」ことを禁じない。** 5.7 が「公開後に手を入れたい作者は
 * フォークする（自分の作品を親にしても親子関係は正しく引ける）」と明示しており、
 * 公開後の作り直しはこの経路しか無い。**条件は「公開済みであること」だけ**で、
 * 誰の作品かは見ない。
 *
 * ## 順序: 日次 → 親の資格 → ソースの取得 → 行の作成 → 起動
 *
 * **日次を先に見る**（3.3-2 / 4.3。`src/revise.ts` と同じ）。断られる要求のために
 * D1 も R2 も引かない。
 *
 * **行を作るのはソースを読み切ったあとである。** 先に作ると、30KB 超や R2 の取りこぼしで
 * 断ったときに、**生成されることのない `pending` の行**が「あなたの作品」（5.5）に
 * 並ぶ。推敲が同じ状況で枠を返す（`releaseRevisionSlot`）のと同じ判断で、
 * **LLM を 1 度も呼んでいない失敗の跡を残さない。**
 *
 * ## 大きい親は、まず知らせる（確定18 の条件 1 / M5-2 / #33）
 *
 * 5.3 は 30KB 超過時に「作者の選択で LLM に整理させる」と定め、その 1 つ目の条件として
 * **入力段階での事前警告**（親ソースが 24KB＝上限の 80% を超えていたら伝える）を課す。
 * **その警告をここに置く。** 5.3 が作品ページではなくこちらを指名しているのは、
 * 作品ページで警告すると**閲覧のたびに親のソースを R2 から測る**ことになり、拡散の
 * 着地点（5.4 の共有 URL）に読み取りの費用が乗るからである。
 *
 * **警告は「やめさせる」ためのものではない。** 5.3 は拒否だけにしない理由を 10.3 の
 * 撤退条件（「3 世代以上の系統が 1 本も出ていない」）に置いている——システムが構造的に
 * 世代数を制限すると、自分で立てた撤退条件を自分の実装で不成立にしうる。したがって
 * ここが伝えるのは**枠を余分に使う可能性**であって、改造をやめる勧めではない。
 *
 * **警告の時点では枠を 1 つも使っていない。** 行も作らない（下記）ので、作者が
 * 「やめる」を選んでも跡が残らない。
 *
 * ## 30KB 超はいまも断るしかない（確定18 の条件 2〜4 は未実装である）
 *
 * 5.3 の整理パスは**この経路からは動かせない。** 2 つとも構造的な理由である。
 *
 * 1. **エッジは Bedrock を呼べない**（`BEDROCK_AWS_*` は #160 で削除された）。整理は
 *    全文再出力の LLM 呼び出しなので、オーケストレータ Lambda の中でしか走らない。
 * 2. **`src/orchestrator/payload.ts` が上限超の `baseSource` を断る。** 整理の入力は
 *    まさに上限超のソースであり、**上限を守るための検査が逃げ道の入口をふさいでいる。**
 *
 * 詳しくは `src/source-size.ts` の冒頭にある。**断るときも「もう一度」と言わない**
 * （何度やっても同じ結果になる）。**枠は減らない**——LLM を呼ぶ前なので `generations`
 * に行が出ない。
 *
 * ## CSRF について
 *
 * セッション cookie は `SameSite=Lax`（8.1）で、他サイトからの POST にはそもそも
 * cookie が乗らない。`src/publish.ts` / `src/revise.ts` と同じ理由でトークンを足していない。
 */
import { LOGIN_PATH } from './auth/google.js';
import { createForkedGame, failGame, PUBLISHED_STATUS } from './games.js';
import type { GenerationJob, GenerationPipeline } from './generate.js';
import { defaultPipeline, MAX_PROMPT_LENGTH } from './generate.js';
import { FORK_PARENT_ID_FIELD, FORK_PATH, FORK_PROMPT_FIELD } from './paths.js';
import { checkGenerationQuota, describeQuotaRejection, QUOTA_EXCEEDED_STATUS } from './quota.js';
import type { Route } from './routes.js';
import { html, json, readLimitedText } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { escapeHtml } from './signup.js';
import type { SizeConsent } from './source-size.js';
import {
  MAX_SOURCE_BYTES,
  SOURCE_SIZE_WARNING_BYTES,
  decideForkSizeAction,
  measureSourceBytes,
} from './source-size.js';
import type { StoredSourceFailure } from './source-store.js';
import { readStoredSource } from './source-store.js';
import { workPagePath } from './work-page.js';

/**
 * 受け付ける本文の最大バイト数。
 *
 * 差分プロンプト（2,000 文字＝ UTF-8 最大 8 KB）と UUID 1 つが載る。
 * **`src/revise.ts` と同じ理由で同じ値**である（載るものが同じ）。
 */
const MAX_BODY_BYTES = 12 * 1024;

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 素の HTML フォームが送ってくる `Content-Type`。 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/** `fetch` から呼ぶときの `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * 303 See Other を返す（`src/revise.ts` と同じ形）。
 *
 * @param location 遷移先
 * @returns レスポンス
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * 要求がブラウザのナビゲーションかを判定する。
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
 * 残らず、利用者は「押したのに何も起きなかった」としか読めない（`src/publish.ts`）。
 *
 * @param heading 見出し
 * @param body 本文
 * @param status ステータスコード
 * @returns レスポンス
 */
function refusal(heading: string, body: string, status: number): Response {
  return html(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} - Game Forge</title>
<h1>${heading}</h1>
<p>${body}</p>
<p><a href="/">トップへ</a></p>`,
    status,
  );
}

/**
 * 事前警告に同意したことを送り返す項目名（確定18 の条件 1。#33）。
 *
 * **`src/paths.ts` へ置かない。** あそこに在るのは
 * {@link FORK_PARENT_ID_FIELD} のように**作品ページのフォーム（`src/work-page.ts`）が
 * 同じ綴りを要る**項目で、循環参照を避けるために逃がしたものである。この項目を送る
 * フォームを描くのは**この経路自身**（警告の画面）なので、綴りを共有する相手がいない。
 */
export const FORK_SIZE_CONSENT_FIELD = 'size_consent';

/** {@link FORK_SIZE_CONSENT_FIELD} の値のうち「このまま改造する」を意味するもの。 */
export const FORK_SIZE_CONSENT_PROCEED = 'proceed';

/**
 * 3 桁ごとに区切った数字にする。
 *
 * **`toLocaleString` を使わない。** ロケールデータの有無で出力が変わる値を、テストが
 * 突き合わせる文言の中へ入れない。
 *
 * @param value 0 以上の整数
 * @returns 区切りを入れた文字列
 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * 事前警告を返すときのステータス（確定18 の条件 1）。
 *
 * **200 にしない。** 同意を持たない要求ではフォークが**始まっていない**ので、成功として
 * 読める応答を返すと、`Accept: application/json` で叩く側が「改造が始まった」と扱う。
 * 断りと同じ 409 に寄せておけば、この応答の `error` を知らない相手も**進まない側**へ
 * 倒れる（`not-forkable` と同じ値なのは、どちらも「この要求はこのままでは通せない」
 * だからである。**区別は `error` が持つ**）。
 */
const SIZE_WARNING_STATUS = 409;

/**
 * 事前警告の画面を返す（確定18 の条件 1）。
 *
 * **警告と選択肢を 1 画面に収める**（5.3）。読んだうえで「このまま改造する」を押すと、
 * 同じ入力が同意付きで戻ってくる。**差分プロンプトを預かり直すのはこの画面である**
 * ——作者に入力し直させると、警告のたびに書いた文章が消える。
 *
 * **`escapeHtml` を通す。** 差分プロンプトは作者が書いた任意の文字列で、8.3 の検査を
 * 通っていない（あれは生成物を見る検査である）。**自分にしか返らないから安全、とは
 * 数えない。**
 *
 * @param parentId 親の作品 id
 * @param prompt 作者が入力した差分プロンプト
 * @param bytes 親ソースのバイト数
 * @returns レスポンス
 */
function sizeWarningPage(parentId: string, prompt: string, bytes: number): Response {
  return html(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>この作品はすでに大きめです - Game Forge</title>
<h1>この作品はすでに大きめです</h1>
<p>元のソースは ${groupDigits(bytes)} バイトあり、上限 ${groupDigits(MAX_SOURCE_BYTES)} バイトの 80%（${groupDigits(SOURCE_SIZE_WARNING_BYTES)} バイト）を超えています。</p>
<p>このまま改造できます。ただし出来上がったソースが上限を超えると、収め直すためにもう 1 回ぶんの生成枠が要ることがあります。</p>
<form method="post" action="${FORK_PATH}">
  <input type="hidden" name="${FORK_PARENT_ID_FIELD}" value="${escapeHtml(parentId)}">
  <input type="hidden" name="${FORK_PROMPT_FIELD}" value="${escapeHtml(prompt)}">
  <input type="hidden" name="${FORK_SIZE_CONSENT_FIELD}" value="${FORK_SIZE_CONSENT_PROCEED}">
  <button type="submit">このまま改造する</button>
</form>
<p><a href="${workPagePath(parentId)}">やめる</a></p>`,
    SIZE_WARNING_STATUS,
  );
}

/** フォークを断る理由ごとの、ステータスと文言。 */
const REFUSALS: Readonly<
  Record<
    'not-forkable' | 'source-missing' | 'source-too-large' | 'start-failed',
    { status: number; heading: string; body: string }
  >
> = {
  // **存在しない作品・未公開の作品・取り下げられた作品を区別しない。** 区別すると、
  // 任意の id が存在するかを外から確かめられる手がかりになる（`src/work-page.ts` の
  // `notFound` と同じ考え方）。**公開済みかどうかは画面が出す**——`/works/<id>` は
  // 未公開なら「まだ公開されていません」と言い、そこに改造の口は出ない。
  'not-forkable': {
    status: 409,
    heading: 'この作品は改造できません',
    body: '改造できるのは公開されている作品だけです。',
  },
  'source-missing': {
    status: 500,
    heading: '元のソースを読み出せませんでした',
    body: '時間をおいて、もう一度お試しください。',
  },
  // **「もう一度」と言わない。** 何度やっても同じ結果になる。5.3 の整理パス
  // （確定18 の条件 2〜4）はこの経路からは動かせない——理由はモジュール冒頭と
  // `src/source-size.ts` にある。**「いまは」と書いてあるのはそのためである。**
  'source-too-large': {
    status: 409,
    heading: 'この作品は改造できる大きさを超えています',
    body: 'ソースが大きくなりすぎているため、いまは改造できません。',
  },
  'start-failed': {
    status: 500,
    heading: '改造を始められませんでした',
    body: '時間をおいて、もう一度お試しください。',
  },
};

/** 本文から読み取ったフォークの要求。 */
interface ForkInput {
  /** 親の作品 id。**これから作る作品の id ではない**（`src/paths.ts`）。 */
  readonly parentId: string;
  /** 差分プロンプト。 */
  readonly prompt: string;
  /**
   * 事前警告に対して作者が示した同意（確定18 の条件 1）。
   *
   * **既定は `none` である。** 「送られてこなかった」を「同意した」と読まない
   * ——読むと、警告を 1 度も見ていない作者が同意した扱いになる。
   */
  readonly consent: SizeConsent;
}

/**
 * 本文を読む。**フォームと JSON の両方を受ける**（`src/revise.ts` と同じ）。
 *
 * @param request 受信したリクエスト
 * @returns 読み取れた要求、または null
 */
async function parseForkInput(request: Request): Promise<ForkInput | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return null;
  }
  const body = read.text;

  let parentId: string | null = null;
  let prompt: string | null = null;
  let consent: string | null = null;
  if (contentType.includes(FORM_MEDIA_TYPE)) {
    const form = new URLSearchParams(body);
    parentId = form.get(FORK_PARENT_ID_FIELD);
    prompt = form.get(FORK_PROMPT_FIELD);
    consent = form.get(FORK_SIZE_CONSENT_FIELD);
  } else if (contentType.includes(JSON_MEDIA_TYPE)) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      parentId =
        typeof record[FORK_PARENT_ID_FIELD] === 'string'
          ? (record[FORK_PARENT_ID_FIELD] as string)
          : null;
      prompt =
        typeof record[FORK_PROMPT_FIELD] === 'string' ? (record[FORK_PROMPT_FIELD] as string) : null;
      consent =
        typeof record[FORK_SIZE_CONSENT_FIELD] === 'string'
          ? (record[FORK_SIZE_CONSENT_FIELD] as string)
          : null;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (parentId === null || !GAME_ID_PATTERN.test(parentId)) {
    return null;
  }
  // **`prompt` の上限は新規生成と同じ**（`MAX_PROMPT_LENGTH`）。差分プロンプトだから
  // といって別の値を置くと、同じ性質の入力に 2 つの上限ができる。
  const trimmed = (prompt ?? '').trim();
  if (trimmed === '' || [...trimmed].length > MAX_PROMPT_LENGTH) {
    return null;
  }
  // **知らない値は同意として扱わない。** 綴りが違うものを黙って `proceed` へ寄せると、
  // 事前警告が「送りさえすれば飛ばせる関門」になる。
  return {
    parentId,
    prompt: trimmed,
    consent: consent === FORK_SIZE_CONSENT_PROCEED ? 'proceed' : 'none',
  };
}

/**
 * 親を取れなかった理由。**畳まない**——作者への文言も、状態コードも変わる。
 *
 * `not-forkable` だけがフォーク固有である（前段の資格判定）。残りは
 * `src/source-store.ts` が返すものと同じで、**そちらを書き写さずに合成する**（#217）。
 */
type ParentFailure = 'not-forkable' | StoredSourceFailure;

/**
 * 親の最終ソースを読む（5.3 / 確定18 / 確定26）。
 *
 * # 資格の判定とソースの取得を 1 つの関数に閉じる
 *
 * **`status='published'` を確かめてから `source_key` を読む。** `src/revise.ts` が
 * 「枠を取ってから R2 を引く」のと同じ理由である——**確かめる前にキーを読むと、
 * 未公開の作品の R2 キーを引ける経路ができる。**
 *
 * # 30KB 超を「読めなかった」と同じ扱いにしない（確定18 / 5.3）
 *
 * あれは確定した上限で、**何度やっても成功しない。**「時間をおいてもう一度」と案内
 * すると、利用者は成功しない操作を繰り返す。超過時に LLM へ整理させる経路は
 * M5-2（#33）が持つ。
 *
 * **黙って切り詰めない。** 切れた Go のソースを渡すと、コンパイルが必ず落ちて枠だけが
 * 消える。
 *
 * # 読み取りそのものは `src/source-store.ts` にある（#217）
 *
 * 5.7 が「方式はフォークと同じ、扱いだけが違う」と書いているとおりで、**上限も
 * 切り詰めない規約も出典は同じ確定18 である。** その「読んで測る」部分だけを
 * `readStoredSource` へ寄せた。
 *
 * **前後は寄せていない。** 前段（誰の何を読んでよいか）が違い、失敗したときの
 * 後始末も違う——推敲は取った枠を返すが、**こちらはまだ何も取っていない。**
 * ここまで畳むと、フォークが取っていない枠を返す壊れ方をする。
 *
 * @param env バインディングと環境変数
 * @param parentId 親の作品 id
 * @returns 親のソース、または失敗の理由
 */
async function readParentSource(
  env: Env,
  parentId: string,
): Promise<{ ok: true; source: string } | { ok: false; reason: ParentFailure }> {
  const row = await env.DB.prepare('select status, source_key from games where id = ?')
    .bind(parentId)
    .first<{ status: string; source_key: string | null }>();

  // **5.3 の対象条件はこの 1 行である。** `draft`（未公開）も `removed`（8.4 の
  // tombstone）も、行が無いのも、すべてここで落ちる。
  if (row === null || row.status !== PUBLISHED_STATUS) {
    return { ok: false, reason: 'not-forkable' };
  }
  // 公開できるのは `generation_state='ready'` の作品だけなので（5.4 /
  // `src/games.ts` の `publishGame`）、公開済みの行にキーが無いことは通常起こらない。
  // **それでも不変条件に寄りかからない**——無ければ「読めなかった」である。
  if (row.source_key === null) {
    return { ok: false, reason: 'source-missing' };
  }

  return await readStoredSource(env, row.source_key);
}

/**
 * フォークの要求を処理する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @param pipeline 差し替え可能な各段（起動だけを使う）
 * @returns レスポンス
 */
async function handleFork(
  request: Request,
  env: Env,
  pipeline: GenerationPipeline,
): Promise<Response> {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // **未ログインをここで待機リストへ送らない。** 2.2-4 の受け皿（`from=fork-cta`）へ
    // 送るのは作品ページの導線であって、この経路ではない（`src/work-page.ts`）。
    // ここへ cookie 無しで届くのは API を直接叩いた場合で、10.2 が数える訪問ではない。
    return wantsHtml(request) ? seeOther(LOGIN_PATH) : json({ error: 'unauthorized' }, 401);
  }

  const input = await parseForkInput(request);
  if (input === null) {
    return wantsHtml(request)
      ? refusal('入力を読み取れませんでした', 'どう改造したいかを入力してから送信してください。', 400)
      : json({ error: 'invalid request' }, 400);
  }

  // 3.3-2 と同じ順序。**断られる要求のために D1 も R2 も引かない。**
  const quota = await checkGenerationQuota(env, session.userId);
  if (!quota.allowed) {
    const body = describeQuotaRejection(
      quota.reason,
      'resetsAt' in quota ? quota.resetsAt : undefined,
    );
    return wantsHtml(request)
      ? refusal('生成枠を使い切りました', '枠が戻ってから、もう一度お試しください。', QUOTA_EXCEEDED_STATUS)
      : json(body, QUOTA_EXCEEDED_STATUS);
  }

  const base = await readParentSource(env, input.parentId);
  if (!base.ok) {
    const refused = REFUSALS[base.reason];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: base.reason }, refused.status);
  }

  // 確定18 の条件 1。**行を作る前・枠を使う前に測って知らせる。**
  //
  // **`readStoredSource` が測った値を持ち出さない。** あちらの戻り値は
  // `src/revise.ts`（所有外）も受け取る形で、ここの都合で広げると推敲側の検査まで
  // 巻き込む。測り直しの費用は 30KB の `TextEncoder` 1 回で、R2 の読み出しより桁が
  // 小さい。**上限そのものは超えていない**（超えていれば上で断られている）ので、
  // ここへ来る文字列の大きさには天井がある。
  const bytes = measureSourceBytes(base.source);
  if (decideForkSizeAction({ bytes, consent: input.consent }) === 'warn') {
    return wantsHtml(request)
      ? sizeWarningPage(input.parentId, input.prompt, bytes)
      : json(
          {
            error: 'source-near-limit',
            bytes,
            limit: MAX_SOURCE_BYTES,
            warnAt: SOURCE_SIZE_WARNING_BYTES,
          },
          SIZE_WARNING_STATUS,
        );
  }

  // **ここで初めて行ができる。** 5.3 の「新しい作品行が生まれる」であり、
  // 5.7 の推敲と分かれる唯一の点である（`src/games.ts` の `createForkedGame`）。
  const child = await createForkedGame(env, session.userId, { prompt: input.prompt }, input.parentId);

  const job: GenerationJob = {
    gameId: child.id,
    jobToken: child.jobToken,
    userId: session.userId,
    // **親のソースを載せる。** 載らなければ、差分プロンプトだけでまったく別のゲームが
    // 生成される（`src/orchestrator/payload.ts` の版 2 の注記）。
    request: { prompt: input.prompt, baseSource: base.source },
  };

  try {
    await pipeline.startJob(env, job, pipeline);
  } catch (error) {
    // **行を放置しない**（`src/generate.ts` の `startGeneration` と同じ後始末）。
    // ここで閉じないと、`pending` のまま 15 分後に「中断したかもしれない」と表示され
    // 続ける行が残る（`src/work-page.ts` の `looksStalled`）。
    console.error(`[fork] ジョブを起動できませんでした: ${error instanceof Error ? error.name : typeof error}`);
    await failGame(env, child.id, 'internal');
    const refused = REFUSALS['start-failed'];
    return wantsHtml(request)
      ? refusal(refused.heading, refused.body, refused.status)
      : json({ error: 'start failed' }, refused.status);
  }

  // **親ではなく子の作品ページへ送る。** 待つのは利用者ではない（3.3 の非同期経路。
  // #150）ので、着地点は「これから出来上がる作品」の恒久的な URL である。
  return wantsHtml(request)
    ? seeOther(workPagePath(child.id))
    : json({ gameId: child.id, parentId: input.parentId, url: workPagePath(child.id) }, 202);
}

/**
 * フォークの経路を組み立てる。
 *
 * **`pipeline` を差し替えられるのはここだけである**（`src/generate.ts` の
 * `createGenerateRoutes`、`src/revise.ts` の `createReviseRoutes` と同じ形）。既定に
 * すると単体テストが Lambda への実呼び出しを要求し、**1 回 約 16 円が受け入れ条件に
 * 混ざる。**
 *
 * @param pipeline 差し替える各段（既定は `defaultPipeline`）
 * @returns 経路表へ連結する `Route[]`
 */
export function createForkRoutes(
  pipeline: GenerationPipeline = defaultPipeline,
): readonly Route[] {
  return [
    { method: 'POST', path: FORK_PATH, handler: (request, env) => handleFork(request, env, pipeline) },
  ];
}

/** アプリの経路表へ連結するフォークの経路（既定の依存）。 */
export const forkRoutes: readonly Route[] = createForkRoutes();
