/**
 * 公開時に撮る OGP 画像（5.4 / 11.2 / #26）。
 *
 * このモジュールが持つのは 4 つである。
 *
 *   1. **撮影の起動と、その関門**（{@link startOgpCapture}）
 *   2. **撮影の結果を受け取るコールバック**（`POST /api/ogp/callback`）
 *   3. **撮れた画像の配信**（`GET /ogp/<game_id>.png`）
 *   4. 画像の在り処（R2 のキー）と、外から見える URL の綴り
 *
 * 撮影そのもの（headless chromium）は AWS Lambda で走る。投げる側は
 * `src/ogp-client.ts`、走る側は `docker/ogp-shot/` にある。
 *
 * # 「未公開の作品を撮らない」を SQL の条件として持つ
 *
 * 5.4 は「**OGP 画像の生成は「公開」時まで遅延する**」と定める（未公開分の撮影コストが
 * 丸ごと不要になる）。**これを呼び出し側の `if` で守らない。**
 *
 * ```sql
 * update games set ogp_state = 'capturing', ogp_token_hash = ?
 *  where id = ? and status = 'published' and ogp_state is null
 * ```
 *
 * 撮影の権利は**この 1 本の UPDATE を通った者だけ**が得る。`status = 'published'` が
 * 条件に入っているので、**未公開の作品に対してこの関数を呼んでも、撮影は始まらない。**
 * 呼び出し側が条件を書き忘れても動作が変わらない形にしてある——`src/games.ts` 冒頭の
 * 「足す形は、条件を書き忘れた経路が生まれても動作では気づけない。到達しない構造の
 * ほうが堅い」と同じ判断である。
 *
 * `ogp_state is null` のほうは**二度撮らないための関門**である（`claimGenerationJob` と
 * 同じ形）。公開そのものが冪等なので二度目の公開ではここまで来ないが、**関門を
 * 上流の冪等性に依存させない。**
 *
 * # R2 へ書くのは Worker である（撮影関数ではない）
 *
 * ビルド関数は自分で R2 へ書く（`terraform/build-function.tf` が SSM 経由で R2 の
 * 資格情報を渡している）。**撮影関数にはその資格情報を渡さない。** 撮れた PNG は
 * コールバックの本文として Worker へ戻り、**R2 バインディングを持つこの経路が書く。**
 *
 * 理由は `src/generate-callback.ts` が「D1 のバインディングを持つ場所を 1 か所に保つ」
 * と書いたものと同じである。1 枚 100 KB 前後の画像 1 つのために、**新しい場所へ
 * 恒久的な R2 の書き込み権限を置かない。**
 *
 * # キーは作品 id から決める（確定26 の「共有」はここに及ばない）
 *
 * `src/games.ts` は「**キーを組み立てない**」と定めている。あれは 3.8 のビルド結果
 * キャッシュが**内容ハッシュを鍵にしており、成果物が作品をまたいで共有される**
 * （確定26 / #116）ためで、作品 id を混ぜたキーはヒット時に作れない。
 *
 * **OGP 画像は共有されない。** 撮影対象はその作品の `/g/<game_id>/` そのもので、
 * 同じソースから作られた 2 件でも別々に撮る（撮る時刻も、将来のタイトル表示も違う）。
 * したがって `ogp/<game_id>.png` は**衝突しようがなく、他の作品から参照されることも
 * ない。** 3.7 の掃除（`deleteUnreferencedArtifacts`）が数えるのは `source_key` /
 * `wasm_key` だけなので、この接頭辞は掃除の対象にもならない（`runtime/` と同じ扱い）。
 *
 * # 画像はアプリ用ホストから配る
 *
 * サンドボックス用ホスト（`/g/`）へ相乗りさせない。あちらの応答には
 * `Content-Security-Policy: sandbox allow-scripts` が付き、資材のパスは CSP の
 * ソース式と 1 対 1 で対応している（`src/sandbox-delivery.ts`）。**OGP 画像を読むのは
 * クローラであって iframe の中身ではない**ので、その対応を 1 つ増やす理由が無い。
 */
import { PUBLISHED_STATUS, createJobToken, hashJobToken } from './games.js';
import type { StartOgpCapture } from './ogp-client.js';
import { missingOgpSecrets, startOgpCaptureOnLambda } from './ogp-client.js';
import type { Route } from './routes.js';
import { json } from './routes.js';

/**
 * 画像の配信パスの接頭辞。
 *
 * **`/works/`（作品ページ）の下に置かない。** あちらは前方一致で登録されており
 * （`src/work-page.ts`）、`/works/<id>/ogp.png` を足すと、同じハンドラが
 * 「作品ページの要求」と「画像の要求」を末尾で見分けることになる。**別の鍵にすれば、
 * 経路表が見分ける。**
 *
 * 末尾の `/` は前方一致の規約である（`src/routes.ts` の `findMalformedPrefixRoutes`）。
 */
export const OGP_IMAGE_PREFIX = '/ogp/';

/** 画像のパスの末尾。**拡張子を綴りに含める**（配る形式が URL から読める）。 */
export const OGP_IMAGE_SUFFIX = '.png';

/** コールバックのパス（確定22 で `/api/*` が正）。 */
export const OGP_CALLBACK_PATH = '/api/ogp/callback';

/** R2 のキーの接頭辞。**`builds/` の外に置く**（3.7 の掃除の対象ではない）。 */
export const OGP_OBJECT_PREFIX = 'ogp/';

/**
 * 撮る画像の大きさ（px）。
 *
 * **1200 × 630。** OGP のカードとして各所が期待する比率（1.91:1）で、これより小さいと
 * 大きなカード（`summary_large_image`）にならない。**撮影関数側にもこの値がある**が、
 * あちらは `terraform/ogp-function.tf` の環境変数から受け取るので、写しは 2 か所
 * （宣言とここ）に留まる。突き合わせは `test/ogp.test.ts` が行う。
 */
export const OGP_IMAGE_WIDTH = 1200;
export const OGP_IMAGE_HEIGHT = 630;

/**
 * コールバックが運ぶ作品 id のヘッダ名。
 *
 * **本文はヘッダではなく画像そのものである。** JSON で包んで base64 にすると 33% 太り、
 * 受け取る側は「復号してから形を確かめる」ことになる。識別子をヘッダへ出しておけば、
 * **本文を 1 バイトも読む前に、宛先の行とトークンを確かめられる。**
 */
export const OGP_GAME_ID_HEADER = 'x-gf-game-id';

/** コールバックが運ぶ使い捨てトークンのヘッダ名。 */
export const OGP_TOKEN_HEADER = 'x-gf-ogp-token';

/**
 * 受け付ける画像の最大バイト数。
 *
 * **2 MiB。** 1200 × 630 の PNG は実測で 100〜400 KB に収まる見込みだが、内容は
 * 生成されたゲームの描画なので、ノイズの多い絵ではもっと太る。**上限が無いと、
 * 撮影関数が壊れた日に R2 の無料枠（10 GB）を削る経路になる。**
 */
export const MAX_OGP_IMAGE_BYTES = 2 * 1024 * 1024;

/** 受け付ける画像の `Content-Type`。 */
const PNG_MEDIA_TYPE = 'image/png';

/** 失敗の通知に使う `Content-Type`。 */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * PNG の先頭 8 バイト（PNG signature）。
 *
 * **中身が PNG であることを確かめてから R2 へ入れる。** ここを見ないと、
 * 何が入っていても `content-type: image/png` を付けて配ることになる。
 * 完全な検証ではない（以降のチャンクは見ない）が、**別の形式が紛れ込む経路は塞ぐ。**
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `games.id` の綴り（`crypto.randomUUID()` が返す形）。 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 使い捨てトークンの綴り（`createJobToken` が返す 16 進 64 桁）。 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

/** `games.ogp_state` が取りうる値（NULL を除く）。正本は `migrations/0009_games_ogp.sql`。 */
export type OgpState = 'capturing' | 'ready' | 'failed';

/**
 * 画像の R2 キーを組み立てる。
 *
 * @param gameId 作品 id（検証済み）
 * @returns R2 のキー
 */
export function ogpObjectKey(gameId: string): string {
  return `${OGP_OBJECT_PREFIX}${gameId}${OGP_IMAGE_SUFFIX}`;
}

/**
 * 画像のパスを組み立てる。
 *
 * **綴りを持つのはこのモジュールだけである**（`src/work-page.ts` の `workPagePath` と
 * 同じ方針）。作品ページはここから取る。
 *
 * @param gameId 作品 id
 * @returns アプリ用ホスト上の絶対パス
 */
export function ogpImagePath(gameId: string): string {
  return `${OGP_IMAGE_PREFIX}${gameId}${OGP_IMAGE_SUFFIX}`;
}

/**
 * 画像の絶対 URL を組み立てる。
 *
 * **OGP の `og:image` は絶対 URL でなければならない**（相対パスを解決するクローラも
 * あるが、仕様上は絶対 URL である）。スキームとポートはこのリクエストから借りる
 * （`src/work-page.ts` の `previewUrl` と同じ組み立て方）。
 *
 * @param request 受信したリクエスト
 * @param gameId 作品 id
 * @returns 絶対 URL
 */
export function ogpImageUrl(request: Request, gameId: string): string {
  return new URL(ogpImagePath(gameId), request.url).toString();
}

/** {@link startOgpCapture} の結果。**「撮った」ではなく「投げた」までである。** */
export type CaptureStartOutcome =
  /** 投げた。結果は `games.ogp_state` に現れる。 */
  | 'started'
  /** 撮らなかった（未公開・撮影済み・撮影中・設定不足）。**正常な結果である。** */
  | 'skipped'
  /** 投げ込めなかった。`ogp_state` は `failed` になっている。 */
  | 'failed';

/**
 * 撮影の権利を取る（モジュール冒頭の「SQL の条件として持つ」）。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param tokenHash 使い捨てトークンのハッシュ
 * @returns 権利を取れたら true
 */
export async function claimOgpCapture(
  env: Env,
  gameId: string,
  tokenHash: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set ogp_state = 'capturing', ogp_token_hash = ?
      where id = ? and status = ? and ogp_state is null`,
  )
    .bind(tokenHash, gameId, PUBLISHED_STATUS)
    .run();

  // D1 の `meta.changes` は実際に更新された行数。**存在検査と排他を 1 回の往復で行う**
  // （`src/games.ts` の `claimGenerationJob` と同じ）。
  return (result.meta.changes ?? 0) > 0;
}

/**
 * その作品が、いまこのトークンで撮影中かを確かめる。
 *
 * # なぜ「あとで条件付き UPDATE をするから」では足りないのか
 *
 * **R2 へ書くのが先だからである。** 本文（PNG）を受け取ってから
 * {@link completeOgpCapture} で弾く形にすると、**弾かれる要求も R2 を 1 回書いてから
 * 弾かれる。** キーは作品 id から決まる（{@link ogpObjectKey}）ので、それは
 * **既に公開されている作品の画像を、id を知っているだけの相手が上書きできる**という
 * ことである（D1 は変わらないので、行を見ても気づけない）。
 *
 * **書く前に読む。** これは {@link completeOgpCapture} の条件を置き換えるものではない
 * ——あちらは「2 通目を弾く」ための原子的な関門として残る（select と update の隙間で
 * 状態は動きうる）。ここが止めるのは**書き込みそのもの**である。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param tokenHash 使い捨てトークンのハッシュ
 * @returns 撮影中で、トークンが一致すれば true
 */
export async function ogpCaptureIsPending(
  env: Env,
  gameId: string,
  tokenHash: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'select ogp_token_hash from games where id = ? and ogp_state = ?',
  )
    .bind(gameId, 'capturing' satisfies OgpState)
    .first<{ ogp_token_hash: string | null }>();
  return row !== null && row.ogp_token_hash !== null && row.ogp_token_hash === tokenHash;
}

/**
 * 撮影が終わったことを記録する。
 *
 * **`ogp_token_hash` を NULL へ落とす。** これがコールバックの冪等性である——
 * Lambda の非同期呼び出しは同じイベントを複数回配信しうるが（AWS 明文）、
 * 2 通目のコールバックはトークンが消えているので 0 行更新になる。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param tokenHash 使い捨てトークンのハッシュ
 * @param key 画像の R2 キー
 * @returns 更新できたら true
 */
export async function completeOgpCapture(
  env: Env,
  gameId: string,
  tokenHash: string,
  key: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set ogp_key = ?, ogp_state = 'ready', ogp_token_hash = null
      where id = ? and ogp_state = 'capturing' and ogp_token_hash = ?`,
  )
    .bind(key, gameId, tokenHash)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * 撮影が失敗したことを記録する。
 *
 * **`ogp_key` は書かない。** 撮れていないものの在り処は無い。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param tokenHash 使い捨てトークンのハッシュ
 * @returns 更新できたら true
 */
export async function failOgpCapture(
  env: Env,
  gameId: string,
  tokenHash: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `update games
        set ogp_state = 'failed', ogp_token_hash = null
      where id = ? and ogp_state = 'capturing' and ogp_token_hash = ?`,
  )
    .bind(gameId, tokenHash)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * OGP 画像の撮影を起動する（5.4 の「公開時まで遅延する」）。
 *
 * # 呼ぶのは公開が成立した直後だけである
 *
 * `src/publish.ts` が `publishGame` の**成功（かつ初回）**のあとに呼ぶ。順序は
 * 逆にできない——撮影対象は `https://<SANDBOX_HOST>/g/<game_id>/` で、その URL は
 * `status='published'` になるまで 404 を返す（`src/sandbox-delivery.ts` の
 * `resolveGame`）。**公開が先、撮影が後である。**
 *
 * # 設定が無い環境では何もしない
 *
 * ローカル（`.dev.vars` に `BUILD_AWS_*` を入れていない）では `skipped` を返し、
 * **`ogp_state` を触らない。** `failed` にしないのは、「撮ろうとして撮れなかった」と
 * 「そもそも撮る経路が無い」を混同しないためである。前者は不具合の手掛かりだが、
 * 後者はローカル開発の通常の状態である。
 *
 * # 投げ込めなかったら `failed` にする
 *
 * 権利を取ったまま投げ込めないと、`capturing` のまま誰も進められない行が残る。
 * **その場で `failed` へ落とす。**
 *
 * # 例外を外へ出さない
 *
 * **公開そのものは成立している。** 撮影の失敗で公開の応答を 5xx にすると、利用者は
 * 「公開できなかった」と読んで押し直す——実際には公開済みなので、押し直しても
 * 何も起きない（冪等）という、**最も分かりにくい形**になる。失敗は戻り値とログに残す。
 *
 * @param env バインディングと環境変数
 * @param gameId 対象の作品 id
 * @param start 撮影を投げる段（既定は AWS Lambda への非同期呼び出し）
 * @returns 起動の結果
 */
export async function startOgpCapture(
  env: Env,
  gameId: string,
  start: StartOgpCapture = startOgpCaptureOnLambda,
): Promise<CaptureStartOutcome> {
  const missing = missingOgpSecrets(env);
  if (missing.length > 0) {
    // **名前だけを出す。値は出さない。**
    console.error(`[ogp] 撮影を起動できません（設定不足）: ${missing.join(', ')}`);
    return 'skipped';
  }

  const token = createJobToken();
  const tokenHash = await hashJobToken(token);
  // **ここが関門である**（モジュール冒頭）。未公開・撮影済み・撮影中はここで止まる。
  if (!(await claimOgpCapture(env, gameId, tokenHash))) {
    return 'skipped';
  }

  try {
    await start(env, { gameId, ogpToken: token });
    return 'started';
  } catch (error) {
    console.error(
      `[ogp] 撮影の呼び出しに失敗しました: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`,
    );
    await failOgpCapture(env, gameId, tokenHash);
    return 'failed';
  }
}

/** コールバックを受け付けられなかった理由。 */
export type OgpCallbackRejection =
  | 'missing-game-id'
  | 'missing-token'
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'unreadable-body'
  | 'not-png';

/**
 * 上限を決めて本文をバイト列として読む。
 *
 * `src/routes.ts` の `readLimitedText` と同じ形だが、**復号しない。** 受け取るのは
 * 画像であり、文字列として読むと壊れる。
 *
 * @param request 受信したリクエスト
 * @param limit 受け付ける最大バイト数
 * @returns 読めたバイト列、または理由
 */
async function readLimitedBytes(
  request: Request,
  limit: number,
): Promise<
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: OgpCallbackRejection }
> {
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        // 残りを受け取らずに切る（`readLimitedText` と同じ）。
        await reader.cancel();
        return { ok: false, reason: 'body-too-large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    console.error(
      `[ogp] コールバックの本文を読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return { ok: false, reason: 'unreadable-body' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * 先頭が PNG の署名かを見る。
 *
 * @param bytes 本文
 * @returns PNG なら true
 */
function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) {
    return false;
  }
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * `Content-Type` の型だけを取り出す（`; charset=` を落とす）。
 *
 * @param header ヘッダの値
 * @returns 小文字の媒体型
 */
function mediaTypeOf(header: string | null): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * 撮影の結果を受け取る。
 *
 * # 認証はトークンだけである
 *
 * セッションも共有シークレットも見ない。**トークンが `games` 行のハッシュと一致する
 * ことが、そのまま「この 1 行を進めてよい」の証明になる**（`migrations/0009_games_ogp.sql`）。
 * 一致しなければ 404 を返す——理由を分けると、任意の id が撮影中かどうかを外から
 * 確かめられる手掛かりになる。
 *
 * # 順序: 照合 → R2 → D1
 *
 * **R2 と D1 の順序を入れ替えない。** 先に `ogp_key` を書くと、その隙間に作品ページを
 * 開いた人へ「まだ存在しないオブジェクト」を指すメタタグが出る。R2 を先に書けば、
 * `ogp_state='ready'` になった瞬間には必ず実体がある（`src/games.ts` の
 * `completeGameWithArtifacts` が「`games` を先に、索引をあとに」と決めているのと
 * 同じ種類の判断で、**向きが逆になるのは読む側の依存が逆だから**である）。
 *
 * **そして照合は R2 より前に置く**（{@link ogpCaptureIsPending}）。あとで弾く形は、
 * 弾かれる要求にも R2 を 1 回書かせる。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function handleOgpCallback(request: Request, env: Env): Promise<Response> {
  const gameId = request.headers.get(OGP_GAME_ID_HEADER) ?? '';
  if (!GAME_ID_PATTERN.test(gameId)) {
    return json({ error: 'missing-game-id' satisfies OgpCallbackRejection }, 400);
  }
  const token = request.headers.get(OGP_TOKEN_HEADER) ?? '';
  if (!TOKEN_PATTERN.test(token)) {
    return json({ error: 'missing-token' satisfies OgpCallbackRejection }, 400);
  }
  const tokenHash = await hashJobToken(token);

  const mediaType = mediaTypeOf(request.headers.get('content-type'));

  // 失敗の通知。**本文は読まない**（読むのは「撮れなかった」という事実だけで、
  // 撮影関数が書いた文字列を D1 にも画面にも入れない。8.3）。
  if (mediaType === JSON_MEDIA_TYPE) {
    const recorded = await failOgpCapture(env, gameId, tokenHash);
    return recorded
      ? json({ accepted: true, state: 'failed' satisfies OgpState }, 200)
      : json({ error: 'not found' }, 404);
  }

  if (mediaType !== PNG_MEDIA_TYPE) {
    return json({ error: 'unsupported-content-type' satisfies OgpCallbackRejection }, 415);
  }

  // **本文を読む前に照合する。** R2 のキーは作品 id から決まるので、照合を後回しに
  // すると「弾かれるが上書きはされる」経路になる（{@link ogpCaptureIsPending}）。
  if (!(await ogpCaptureIsPending(env, gameId, tokenHash))) {
    return json({ error: 'not found' }, 404);
  }

  const read = await readLimitedBytes(request, MAX_OGP_IMAGE_BYTES);
  if (!read.ok) {
    return json({ error: read.reason }, read.reason === 'body-too-large' ? 413 : 400);
  }
  if (!looksLikePng(read.bytes)) {
    return json({ error: 'not-png' satisfies OgpCallbackRejection }, 400);
  }

  const key = ogpObjectKey(gameId);
  await env.BUCKET.put(key, read.bytes, {
    // **配信側でヘッダを組み立て直さずに済む形で入れる。**
    httpMetadata: { contentType: PNG_MEDIA_TYPE },
  });

  const recorded = await completeOgpCapture(env, gameId, tokenHash, key);
  if (!recorded) {
    // トークンが合わない・既に終わっている。**R2 のオブジェクトは消さない**——
    // キーは作品 id から決まるので、上書きしたのは同じ作品の画像である。
    return json({ error: 'not found' }, 404);
  }
  return json({ accepted: true, state: 'ready' satisfies OgpState }, 200);
}

/**
 * 撮れた画像を配る。
 *
 * # `status='published'` を SQL の条件に置く
 *
 * `src/sandbox-delivery.ts` の `/g/` と**同じ形**にする。5.4 の「公開操作で初めて
 * URL が有効になる」は作品本体だけの話ではない——**未公開の作品の画面が画像として
 * 見えるのも公開である。**
 *
 * 実際には未公開の行に `ogp_key` は入らない（撮影の関門が `status='published'` を
 * 条件に持つ）ので、この条件は二重の守りである。**それでも置く**のは、条件が
 * 1 つしか無い状態を作らないためである。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
async function serveOgpImage(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const rest = pathname.slice(OGP_IMAGE_PREFIX.length);
  if (!rest.endsWith(OGP_IMAGE_SUFFIX)) {
    return notFound();
  }
  const gameId = rest.slice(0, -OGP_IMAGE_SUFFIX.length);
  if (!GAME_ID_PATTERN.test(gameId)) {
    return notFound();
  }

  const row = await env.DB.prepare(
    'select ogp_key from games where id = ? and status = ? and ogp_state = ?',
  )
    .bind(gameId, PUBLISHED_STATUS, 'ready' satisfies OgpState)
    .first<{ ogp_key: string | null }>();
  if (row === null || row.ogp_key === null) {
    return notFound();
  }

  const object = await env.BUCKET.get(row.ogp_key);
  if (object === null) {
    // 行は ready だが実体が無い。**黙って 200 の空を返さない。**
    console.error(`[ogp] ogp_state=ready ですが R2 に実体がありません: ${row.ogp_key}`);
    return notFound();
  }

  return new Response(object.body, {
    headers: {
      'content-type': PNG_MEDIA_TYPE,
      // **クローラは何度も取りに来る。** 内容は撮り直すまで変わらないので、
      // 1 時間は聞き直させない。`immutable` は付けない（撮り直しの余地を残す）。
      'cache-control': 'public, max-age=3600',
      etag: object.httpEtag,
    },
  });
}

/**
 * 画像が見つからないときの応答。
 *
 * **理由を分けない**（`src/work-page.ts` の `notFound` と同じ考え方）。
 *
 * @returns レスポンス
 */
function notFound(): Response {
  return json({ error: 'not found' }, 404);
}

/**
 * OGP の経路（#26）。
 *
 * 画像は**前方一致**で登録する（`/ogp/<game_id>.png` の id は 1 件ごとに違う）。
 * コールバックは完全一致である。
 */
export const ogpRoutes: readonly Route[] = [
  { method: 'GET', path: OGP_IMAGE_PREFIX, match: 'prefix', handler: serveOgpImage },
  { method: 'POST', path: OGP_CALLBACK_PATH, handler: handleOgpCallback },
];
