/**
 * プレイ数の窓口（2.3.5 / 3.6 / 5.8 / #377。M12-9）。**Pages 側がプレイ数の DO を呼ぶのは、
 * このモジュールだけ**である。
 *
 * # 形
 *
 * ```text
 * 作品ページ（アプリ用ホスト）
 *   └ iframe（サンドボックス用ホスト /g/<id>/。不透明オリジン）
 *        └ ローダーが Wasm を起動した直後に parent.postMessage('gf-loader-started', <app のオリジン>)
 *   ← 作品ページのスクリプト（{@link playReportScript}）が受ける
 *        ├ 自分の iframe から届いたか（event.source）を確かめる
 *        ├ sessionStorage の「この作品を最後に数えた時刻」で連打を畳む（{@link shouldReportPlay}）
 *        └ POST /api/plays ─→ src/plays.ts（ここ）
 *                               ├ D1 を主キーで 1 行読む: 公開済みの作品か（{@link PLAYABLE_GAME_SQL}）
 *                               └ binding ─→ PlayHub（別 Worker game-forge-likes の Durable Object）
 *                                              └ アラーム（5 分ごと）─→ D1 の games.play_count
 * ```
 *
 * **D1 へは都度書かない**（3.6 の禁止は生きている）。ここが D1 に対して行うのは、主キーで
 * 1 行を読むことだけである。
 *
 * # なぜ「起動の合図」を作品ページが受けるのか（OGP の撮影を数えない）
 *
 * issue #377 の constraints は「Wasm が実際に起動したときに数える」と定める。起動を知って
 * いるのはサンドボックスのローダーだが、**`docker/ogp-shot` はまさにその起動の合図を待って
 * 撮る**ので、ローダー自身が数えると公開と撮り直しのたびに 1 加算される。
 *
 * **撮影は `/g/<id>/` をトップレベルで開き、親ページを持たない。** ローダーは親が居るとき
 * だけ合図を送り（`src/sandbox-loader.ts`）、数えるのは合図を受けた作品ページである。
 * **撮影には作品ページが無いので、仕組みの上で数えられない**（撮影側に印を持たせる形は採ら
 * なかった——印は撮影の経路を変えるうえ、印を付け忘れた撮影が数えられる）。
 *
 * **もう 1 つの効果**: ローダーの文書は `connect-src` をその作品の `.wasm` 1 本に絞っており
 * （7.2）、ここへ要求を送れない。**サンドボックスの封じ込めを 1 要素も緩めずに数えられる。**
 *
 * # 受け手は `event.source` で自分の iframe に絞る
 *
 * **iframe は `sandbox="allow-scripts"` なので不透明オリジンで、`event.origin` は必ず
 * `'null'` である。** `origin` の検査だけでは、他の sandbox の iframe（や、`null` を名乗る
 * 任意の文書）と区別できない。**束縛の本体は `event.source === iframe.contentWindow`**
 * （自分が埋め込んだ iframe の窓から届いたこと）であり、`origin` は念のために重ねて見る。
 * 合図の中身は信じない——送り手の文書では UGC が動くので、中身は固定の文字列と一致するかを
 * 見るだけで、作品 id は作品ページが自分で持っている。
 *
 * # 連打を畳む（sessionStorage。Cookie を足さない）
 *
 * **厳密さより、DO への流入を抑えることが目的である**（issue #377 の constraints）。
 * 作品ページのスクリプトは、アプリ用ホストの sessionStorage に「作品ごとの最終計上時刻」を
 * 持ち、{@link PLAY_REPORT_WINDOW_MS} の内側なら要求を出さない。**同じページの中では 1 回
 * しか送らない**（iframe の中で再読み込みされても数え直さない）。
 *
 * - **Cookie を足さない。** サーバは何も覚えない（利用者ごとの履歴を持たない。scope.out）。
 *   sessionStorage はタブを閉じれば消え、サーバへ送られない
 * - **sessionStorage が使えない環境では、ページごとに 1 回数える**（数えすぎを許す。
 *   プレイ数は会計ではない）
 * - **規則は純粋関数で持ち、スクリプトへそのまま埋め込む**（{@link shouldReportPlay}。テストと
 *   本番で同じ関数が動く。書き写さない）
 *
 * **畳めるのは作品ページを通る要求だけである。** この口を直接叩く要求（ボット・`curl`）は
 * 畳めず、公開済みの作品なら 1 ずつ数える。issue の scope.out が「ボット・クローラの除外を
 * 精密にすること」を外しているので、**その状態を受け入れる**。尽きうるのは DO の枠で、
 * 止まるのはいいねとプレイ数だけである（D1 は巻き込まれない。5.8）。
 *
 * # 未ログインも数える
 *
 * **セッションを見ない**（issue #377 の scope.out。プレイ数は全員ぶん数える）。だから
 * スクリプトは cookie を送らない（`credentials: 'omit'`）。
 *
 * # 失敗しても作品ページを壊さない
 *
 * **DO へ届かなければ 503 を返し、ログに残す**（`src/likes.ts` の「握りつぶすが黙らない」と
 * 同じ形）。呼ぶのは作品ページのスクリプトだけで、応答を画面に出さない。**数え漏れを許す**
 * （5.8 が同じ判断をしている）。
 */
import type { PlayHub } from '../workers/likes/src/play-hub.js';
import { PUBLISHED_STATUS } from './games.js';
import type { Route } from './routes.js';
import { json, readLimitedText } from './routes.js';
import { LOADER_STARTED_MESSAGE } from './sandbox-loader.js';

/** 計上の口（`POST`）。**`/works/` の前方一致に当たらない綴り**にしてある（作品ページの規約）。 */
export const PLAY_PATH = '/api/plays';

/** 本文の項目名（JSON の鍵）。 */
export const PLAY_GAME_ID_FIELD = 'game_id';

/**
 * 全作品のプレイ数を集める DO の名前。
 *
 * **1 個に集める**（いいねの B1 と同じ）。分割へ移る契機は 2.3.8 にあり、移るときはここが
 * 作品から名前を導く形に変わる。
 */
export const PLAY_HUB_NAME = 'all';

/**
 * 同じ閲覧者が同じ作品を数え直さない窓（ミリ秒）。**30 分。**
 *
 * **遊び直しを 1 回と数えるための窓ではなく、DO への流入を抑えるための窓である**
 * （issue #377 の constraints）。短すぎると再読み込みの連打が乗り、長すぎるとタブを開いた
 * まま遊び続ける人の「別の日の 1 回」まで落とす。sessionStorage はタブを閉じれば消えるので、
 * 窓が効くのは同じタブの中だけである。
 */
export const PLAY_REPORT_WINDOW_MS = 30 * 60 * 1000;

/**
 * 数えてよい作品かを判定する SQL。**主キーで 1 行を読むだけで、何も書かない。**
 *
 * **公開済み（`status = 'published'`）だけを数える**（`draft` と `removed` は数えない。
 * `src/likes.ts` の `PRESSABLE_GAME_SQL` と同じ形）。
 *
 * **審査の可視条件（8.4）では絞らない。** 新規露出を止めた作品も URL は生きており、遊ばれた
 * 事実は変わらない。並べ替えと一覧は引く時点で絞る（`reviewVisibleSql`）ので、数が一覧へ
 * 漏れることは無い。**自作も数える**（押す操作ではないので、自己申告の問題が無い）。
 */
export const PLAYABLE_GAME_SQL = 'select 1 as hit from games where id = ? and status = ? limit 1';

/** 受け付ける本文の最大バイト数（**1 KiB**。載るのは UUID 1 つだけ。`src/likes.ts` と同じ）。 */
const MAX_BODY_BYTES = 1024;

/** 受け付ける `Content-Type`（**`fetch` からだけ呼ぶ**。フォームの口は持たない）。 */
const JSON_MEDIA_TYPE = 'application/json';

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * いま数えてよいか（連打を畳む規則。#377）。**純粋関数である。**
 *
 * **この関数の本文は、作品ページのスクリプトへそのまま埋め込まれる**（{@link playReportScript}
 * が `String(shouldReportPlay)` で書き出す）。ブラウザでそのまま動く形に保つこと——**本文の
 * 中で別の関数を定義しない・呼ばない**（束ねる工程が名前を保つための補助呼び出しを本文へ
 * 差し込みうる）。
 *
 * - 前回の記録が無い・数でない（壊れた値・読めなかった）→ 数える
 * - 前回の記録が未来（端末の時計が戻った）→ 数える（記録を今で上書きする）
 * - 前回から `windowMs` 未満 → 数えない
 *
 * @param lastReportedAt 前回数えた時刻（ミリ秒）。記録が無ければ null
 * @param now いまの時刻（ミリ秒）
 * @param windowMs 窓の長さ（ミリ秒）
 * @returns 数えてよければ true
 */
export function shouldReportPlay(
  lastReportedAt: number | null,
  now: number,
  windowMs: number,
): boolean {
  if (lastReportedAt === null || !Number.isFinite(lastReportedAt) || lastReportedAt > now) {
    return true;
  }
  return now - lastReportedAt >= windowMs;
}

/**
 * sessionStorage の鍵を組み立てる。
 *
 * @param gameId 作品
 * @returns 鍵
 */
export function playReportStorageKey(gameId: string): string {
  return `gf-play:${gameId}`;
}

/**
 * 作品ページに埋め込む計上のスクリプト（#377）。
 *
 * **作品ページの iframe の直前に `<script>` として置く**（ヘッダには置かない）。**iframe より前に
 * 置くのは、合図より先にリスナーを登録するためである**——iframe の後ろに置くと、キャッシュの
 * 効いた速い起動では合図がリスナーより先に届き、そのページの起動は二度と数えられない
 * （PR #425 の Copilot の指摘）。**だから iframe はスクリプトの時点で引かず、合図が届いた時点で
 * 引く**（スクリプトの時点では iframe がまだ無くてよい）。作品ページはアプリ用ホストにあり、
 * CSP を持たない（生成画面と同じ扱い）。**画面を 1 文字も書き換えない**——DOM へは何も書かず、応答も読まない。
 * JavaScript を切っていても作品ページは同じように遊べる（数えられないだけである）。
 *
 * 素朴な書き方（`var` と関数式）に寄せているのは、この 1 枚がビルド工程を通らずそのまま
 * ブラウザへ届くためである（`src/generate-page.ts` と同じ）。
 *
 * @param gameId 作品（**UUID の形を確かめてから渡す**。形が違えば空文字を返す）
 * @returns `<script>` 要素。埋め込めなければ空文字
 */
export function playReportScript(gameId: string): string {
  if (!GAME_ID_PATTERN.test(gameId)) {
    return '';
  }
  const literal = (value: string): string => JSON.stringify(value).replace(/</gu, '\\u003c');
  return `<script>
(function () {
  if (typeof window.fetch !== 'function') { return; }
  var shouldReport = ${String(shouldReportPlay)};
  var gameId = ${literal(gameId)};
  var storageKey = ${literal(playReportStorageKey(gameId))};
  var reported = false;
  window.addEventListener('message', function (event) {
    if (reported) { return; }
    // **iframe は合図が届いた時点で引く**（このスクリプトは iframe より前にあり、登録の時点では
    // まだ無い）。**自分の iframe から届いた合図だけを受ける。** 不透明オリジンなので origin は
    // 'null' で、それだけでは他の sandbox の iframe と区別できない。束縛の本体は source の一致である。
    var frame = document.querySelector('iframe.gf-frame');
    if (frame === null || event.source !== frame.contentWindow || event.origin !== 'null') { return; }
    if (event.data !== ${literal(LOADER_STARTED_MESSAGE)}) { return; }
    // **このページでは 1 回だけ。** iframe の中で読み直されても数え直さない。
    reported = true;
    var now = Date.now();
    var last = null;
    try {
      var raw = window.sessionStorage.getItem(storageKey);
      last = raw === null ? null : Number(raw);
    } catch (error) {
      last = null;
    }
    if (!shouldReport(last, now, ${PLAY_REPORT_WINDOW_MS})) { return; }
    try {
      window.sessionStorage.setItem(storageKey, String(now));
    } catch (error) {
      // 覚えられなくても数える（ページごとに 1 回）。
    }
    fetch(${literal(PLAY_PATH)}, {
      method: 'POST',
      headers: { 'content-type': ${literal(JSON_MEDIA_TYPE)} },
      body: JSON.stringify({ ${PLAY_GAME_ID_FIELD}: gameId }),
      credentials: 'omit',
      keepalive: true
    }).catch(function () {});
  });
})();
</script>`;
}

/**
 * プレイ数の DO への窓口を返す。
 *
 * **`env.PLAY_HUB` を読むのはここだけである**（`scripts/check-likes-worker.sh` が見る）。
 * 型の当て方は `src/likes.ts` の `likeHub` と同じ理由である（生成物の型は別スクリプトの
 * クラスを知らない）。**`game-forge-likes` の実装は Pages の束に入らない**（`import type`）。
 *
 * @param env バインディングと環境変数
 * @returns DO の stub
 */
function playHub(env: Env): DurableObjectStub<PlayHub> {
  return (env.PLAY_HUB as unknown as DurableObjectNamespace<PlayHub>).getByName(PLAY_HUB_NAME);
}

/**
 * 数えてよい作品か。**D1 を主キーで 1 行読むだけで、何も書かない。**
 *
 * @param env バインディングと環境変数
 * @param gameId 作品
 * @returns 公開済みなら true
 */
export async function isPlayableGame(env: Env, gameId: string): Promise<boolean> {
  const row = await env.DB.prepare(PLAYABLE_GAME_SQL)
    .bind(gameId, PUBLISHED_STATUS)
    .first<{ hit: number }>();
  return row !== null;
}

/** 計上の結果。 */
export type PlayRecordOutcome =
  /** 数えた（DO へ渡した）。 */
  | 'recorded'
  /** 数えてよい作品ではなかった（存在しない・`draft`・`removed`）。**何も書いていない。** */
  | 'not-playable';

/**
 * プレイを 1 回数える（#377）。**D1 へは書かない。**
 *
 * @param env バインディングと環境変数
 * @param gameId 作品
 * @returns 結果
 * @throws DO へ届かなかったとき（口が 503 に倒す）
 */
export async function recordPlay(env: Env, gameId: string): Promise<PlayRecordOutcome> {
  if (!(await isPlayableGame(env, gameId))) {
    return 'not-playable';
  }
  await playHub(env).record(gameId);
  return 'recorded';
}

/** DO へ届かなかったときにログへ出す接頭辞（**握りつぶすが、黙らない**）。 */
export const PLAYS_UNAVAILABLE_REASON = '[plays] プレイ数を数えられませんでした';

/**
 * 本文から作品 id を取り出す。
 *
 * @param request 受信したリクエスト
 * @returns 作品 id、または断りの応答
 */
async function readPlayTarget(
  request: Request,
): Promise<{ readonly ok: true; readonly gameId: string } | { readonly ok: false; readonly response: Response }> {
  const mediaType = (request.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return { ok: false, response: json({ error: 'unsupported-content-type' }, 415) };
  }
  const read = await readLimitedText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return {
      ok: false,
      response: json({ error: read.reason }, read.reason === 'body-too-large' ? 413 : 400),
    };
  }
  let raw: unknown;
  try {
    const parsed: unknown = JSON.parse(read.text);
    raw =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[PLAY_GAME_ID_FIELD]
        : undefined;
  } catch {
    raw = undefined;
  }
  if (typeof raw !== 'string' || !GAME_ID_PATTERN.test(raw)) {
    return { ok: false, response: json({ error: 'invalid-game-id' }, 400) };
  }
  return { ok: true, gameId: raw };
}

/**
 * 計上の口を処理する（`POST /api/plays`）。
 *
 * **順序に意味がある**: 本文 → 公開済みの作品か（D1 の読み取り）→ DO。手前で断った要求は
 * DO へ届かない。**セッションは見ない**（未ログインも数える）。
 *
 * | 状況 | 応答 |
 * |---|---|
 * | 数えた | 204 |
 * | 本文の形式が違う / 大きすぎる / 形が不正 | 415 / 413 / 400 |
 * | 数えてよい作品ではない（存在しない・`draft`・`removed`） | **404。理由を区別しない** |
 * | DO へ届かない | 503（ログに残す。数え漏れを許す） |
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handlePlay(request: Request, env: Env): Promise<Response> {
  const target = await readPlayTarget(request);
  if (!target.ok) {
    return target.response;
  }
  let outcome: PlayRecordOutcome;
  try {
    outcome = await recordPlay(env, target.gameId);
  } catch (error) {
    console.error(
      `${PLAYS_UNAVAILABLE_REASON}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return json({ error: 'unavailable' }, 503);
  }
  if (outcome === 'not-playable') {
    return json({ error: 'not-found' }, 404);
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** プレイ数の経路（`src/app.ts` の経路表へ連結する）。 */
export const playRoutes: readonly Route[] = [
  { method: 'POST', path: PLAY_PATH, handler: handlePlay },
];
