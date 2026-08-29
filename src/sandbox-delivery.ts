/**
 * サンドボックス用ホストの配信（3.4 / 5.4 / 7.2 / #28）。
 *
 * このモジュールが持つのは 3 つである。
 *
 *   1. **URL の形の解釈**（どの作品の、どの資材への要求か）
 *   2. **その作品を配信してよいかの判定**（5.4 の公開フロー）
 *   3. **R2 から取り出して返すこと**（3.4 のヘッダ規約を含む）
 *
 * CSP の組み立ては `src/sandbox-csp.ts`、文書の中身は `src/sandbox-loader.ts` が持つ。
 *
 * # 配信 URL の形（決定事項）
 *
 * ```text
 * draft（作者プレビュー）  https://sandbox.game-forge.ojos.jp/p/<preview_key>/
 * 公開後                   https://sandbox.game-forge.ojos.jp/g/<game_id>/
 * ```
 *
 * 2 本に分ける理由は 5.4 である。**公開操作で初めて URL が有効になる**以上、公開前後で
 * 同じ URL を使うと「まだ有効でない URL」を作者に見せることになる。別の綴りにすれば、
 * `/g/` は常に公開済みだけを指し、`/p/` は unlisted キーを知っている人だけが引ける。
 *
 * `preview_key` を使う理由（cookie による所有者確認がこの経路では原理的に成立しない）は
 * `migrations/0006_games_preview_key.sql` に書いてある。
 *
 * # サブ資材は絶対パスで同じ接頭辞の下に置く
 *
 * ```text
 * /p/<preview_key>/game.wasm     /p/<preview_key>/wasm_exec.js
 * /g/<game_id>/game.wasm         /g/<game_id>/wasm_exec.js
 * ```
 *
 * 作品ごとに違うパスにするのは、CSP の `connect-src` / `script-src` を**その作品の 1 本の
 * URL だけ**へ絞るためである（`src/sandbox-csp.ts`）。共通のパス（例: `/assets/game.wasm`）に
 * すると、絞れる単位がホスト全体まで戻る。
 */
import { sandboxCsp } from './sandbox-csp.js';
import { loaderHtml } from './sandbox-loader.js';

/** 配信の入口となる接頭辞。`/p/` は unlisted プレビュー、`/g/` は公開済み。 */
const PREVIEW_PREFIX = 'p';
const PUBLISHED_PREFIX = 'g';

/** `.wasm` のパス末尾。 */
export const WASM_FILE = 'game.wasm';

/** `wasm_exec.js` のパス末尾。 */
export const WASM_EXEC_FILE = 'wasm_exec.js';

/**
 * `preview_key` の綴り。**16 進 32 桁 = 128 ビット。**
 *
 * 形を固定するのは推測困難性のためだけではない。この値は URL から取り出して
 * **CSP ヘッダと HTML へ埋め戻す**ので、綴りを限定しておかないとヘッダ注入と
 * HTML 注入の両方を個別に心配することになる。16 進だけなら、どちらの文脈でも
 * 特別な意味を持つ文字が存在しない。
 */
const PREVIEW_KEY_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * `games.id` の綴り。`crypto.randomUUID()` が返す形（小文字の UUID）。
 *
 * `PREVIEW_KEY_PATTERN` と同じ理由で固定する。
 */
const GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * `wasm_exec.js` を置く R2 のキー。
 *
 * **いまは版を 1 つしか持たない。** 3.5 の「`go_version` に応じた出し分け」は M4-4（#29）の
 * 範囲なので、ここでは配信経路が成立することだけを作る。**版を混ぜないために、キーに
 * 版を含めない形にはしない**（後から `runtime/<go_version>/wasm_exec.js` へ寄せるとき、
 * 古いキーが「どの版のものか分からないファイル」として残る）。
 *
 * 置き場所を `builds/` の外にするのは、あちらがビルド結果で 3.7 のゴミ掃除（被参照ゼロで
 * 削除）の対象になるためである。`wasm_exec.js` はどの `games` 行からも参照されない
 * 共有のランタイム資材で、同じ接頭辞の下に置くと掃除の対象に見える。
 */
const WASM_EXEC_KEY = `runtime/${WASM_EXEC_FILE}`;

/** 作品が draft のときだけ配信する経路か、公開済みだけを配信する経路か。 */
export type SandboxScope = 'preview' | 'published';

/** 要求された資材の種類。 */
export type SandboxAsset = 'document' | 'wasm' | 'wasm-exec';

/** URL から読み取った配信の要求。 */
export interface SandboxTarget {
  readonly scope: SandboxScope;
  /** `preview` なら `preview_key`、`published` なら `games.id`。検証済み。 */
  readonly identifier: string;
  readonly asset: SandboxAsset;
}

/**
 * サンドボックス用ホストのパスを解釈する。
 *
 * **綴りが違えば必ず null を返す**（既定を「配信しない」へ倒す）。前方一致や
 * 正規化での救済をしないのは、URL の形が CSP のソース式と 1 対 1 で対応しているためで、
 * ここで揺れを許すと「CSP が許した URL と、実際に配信される URL が違う」状態を作れる。
 *
 * `/p/<key>` と `/p/<key>/` はどちらも文書として受ける。末尾スラッシュだけが違う URL で
 * 片方が 404 になるのは、リンクを踏む体験として意味が無い。**リダイレクトで揃えない**
 * 理由は `src/sandbox-loader.ts` にある。
 *
 * @param pathname URL のパス部分
 * @returns 解釈できた要求。できなければ null
 */
export function parseSandboxPath(pathname: string): SandboxTarget | null {
  // 先頭の `/` を落としてから分解する。`/p/x/` は ['p', 'x', ''] になるので、
  // 末尾の空要素だけを 1 つ許して落とす（`//` のような綴りは救わない）。
  const rawSegments = pathname.replace(/^\//u, '').split('/');
  const segments =
    rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === ''
      ? rawSegments.slice(0, -1)
      : rawSegments;

  if (segments.length < 2 || segments.length > 3) {
    return null;
  }

  const scope = scopeOf(segments[0]!);
  if (scope === null) {
    return null;
  }

  const identifier = segments[1]!;
  const pattern = scope === 'preview' ? PREVIEW_KEY_PATTERN : GAME_ID_PATTERN;
  if (!pattern.test(identifier)) {
    return null;
  }

  const asset = assetOf(segments.length === 3 ? segments[2]! : '');
  if (asset === null) {
    return null;
  }

  return { scope, identifier, asset };
}

/**
 * 接頭辞から配信の種類を決める。
 *
 * @param prefix パスの 1 番目のセグメント
 * @returns 配信の種類。未知の接頭辞なら null
 */
function scopeOf(prefix: string): SandboxScope | null {
  if (prefix === PREVIEW_PREFIX) {
    return 'preview';
  }
  if (prefix === PUBLISHED_PREFIX) {
    return 'published';
  }
  return null;
}

/**
 * 3 番目のセグメントから資材の種類を決める。
 *
 * @param name ファイル名（空文字なら文書そのもの）
 * @returns 資材の種類。未知の名前なら null
 */
function assetOf(name: string): SandboxAsset | null {
  if (name === '') {
    return 'document';
  }
  if (name === WASM_FILE) {
    return 'wasm';
  }
  if (name === WASM_EXEC_FILE) {
    return 'wasm-exec';
  }
  return null;
}

/** 配信に要る `games` 行の中身。 */
export interface DeliverableGame {
  readonly id: string;
  readonly status: string;
  /** 3.5 の `wasm_exec.js` 出し分け（M4-4 / #29）に使う。 */
  readonly goVersion: string;
  /** R2 のキー。tombstone 化（5.3 / M5-4）で NULL になりうる。 */
  readonly wasmKey: string | null;
}

/** `games` から読む列（列名は SQL の綴りそのもの）。 */
interface GameRow {
  id: string;
  status: string;
  go_version: string;
  wasm_key: string | null;
}

/**
 * 要求された作品を引く。**配信してよいものだけを返す。**
 *
 * # `/g/` は `status='published'` だけを返す
 *
 * 5.4 の「公開操作で初めて URL が有効になる」を SQL の条件として持つ。アプリ側で
 * 引いてから判定する形にしないのは、判定を忘れた経路が生まれうるためである。
 *
 * # `/p/` は `removed` 以外を返す
 *
 * `draft` だけに絞らないのは、**公開した瞬間に作者のプレビュー URL が壊れる**ためである。
 * 作者が開いたままのタブが 404 になるのは、公開操作の結果として不自然である。
 * `removed`（8.4 の審査で落ちたもの）は、キーを知っていても返さない。
 *
 * @param env バインディングと環境変数
 * @param target 解釈済みの要求
 * @returns 配信してよい作品。無ければ null
 */
export async function resolveGame(env: Env, target: SandboxTarget): Promise<DeliverableGame | null> {
  const statement =
    target.scope === 'preview'
      ? env.DB.prepare(
          "select id, status, go_version, wasm_key from games where preview_key = ? and status <> 'removed'",
        ).bind(target.identifier)
      : env.DB.prepare(
          "select id, status, go_version, wasm_key from games where id = ? and status = 'published'",
        ).bind(target.identifier);

  const row = await statement.first<GameRow>();
  if (row === null) {
    return null;
  }
  return { id: row.id, status: row.status, goVersion: row.go_version, wasmKey: row.wasm_key };
}

/**
 * 作品の資材が並ぶパスの接頭辞を組み立てる。
 *
 * @param target 解釈済みの要求
 * @returns `/p/<key>` か `/g/<id>`（末尾にスラッシュを付けない）
 */
function basePathOf(target: SandboxTarget): string {
  const prefix = target.scope === 'preview' ? PREVIEW_PREFIX : PUBLISHED_PREFIX;
  return `/${prefix}/${target.identifier}`;
}

/** 1 つのレスポンスに付ける CSP を決めるための材料。 */
interface ResponseContext {
  /** リクエストのオリジン（`https://host[:port]`）。CSP のソース式に使う。 */
  readonly origin: string;
  /** 親アプリのオリジン。`frame-ancestors` に使う。 */
  readonly appOrigin: string;
}

/**
 * リクエストから、CSP の組み立てに使うオリジンを取り出す。
 *
 * **ホスト名は `src/index.ts` が `SANDBOX_HOST` と一致することを確認済み**の状態で
 * ここへ来る。スキームとポートを URL から取るのは、ローカル（自己署名証明書 + 任意の
 * ポート）と本番で同じコードが正しい CSP を吐くようにするためである。ポートまで
 * 含めないと、CSP のホスト一致は既定ポート以外で成立しない。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns CSP の組み立てに使うオリジン
 */
function responseContextOf(request: Request, env: Env): ResponseContext {
  const url = new URL(request.url);
  return {
    origin: url.origin,
    // 親アプリはスキームとポートをサンドボックスと共有する（同じ Worker が両方を
    // 受けている）。ホスト名だけ差し替える。
    appOrigin: `${url.protocol}//${env.APP_HOST}${url.port === '' ? '' : `:${url.port}`}`,
  };
}

/**
 * サンドボックス用ホストのレスポンスに必ず付けるヘッダを組み立てる。
 *
 * **cookie は一切設定しない。** 7.2 の 3 点目（`Domain=ojos.jp` の cookie をどこにも
 * 置かない）に照らし、この経路が cookie を発行する余地を最初から作らない。
 *
 * CSP はすべてのレスポンスへ付ける。サブ資材（`.wasm` / `.js`）ではブラウザが多くの
 * ディレクティブを無視するが、**付けない理由が「無視されるから」だと、文書とサブ資材の
 * どちらを返しているかで挙動が分かれる分岐が増える。** 一律に付けて分岐を作らない。
 *
 * @param csp `Content-Security-Policy` の値
 * @param extra 追加のヘッダ
 * @returns ヘッダ
 */
function sandboxHeaders(csp: string, extra: Record<string, string>): Headers {
  return new Headers({
    'content-security-policy': csp,
    // MIME type の推測を止める。`instantiateStreaming` は `Content-Type` を検証するため、
    // 推測で書き換えられるとストリーミングだけが黙って失われる（3.4-2）。
    'x-content-type-options': 'nosniff',
    ...extra,
  });
}

/**
 * サンドボックス用ホストのエラーレスポンス。
 *
 * 本文は最小限にする。**存在しないのか、公開されていないのか、消されたのかを区別しない。**
 * `/p/` は unlisted キーが唯一の資格情報なので、区別を返すとキーの総当たりに手がかりを
 * 与える。`/g/` 側も同じ綴りに揃える（経路ごとに違う応答を返すと、それ自体が手がかりになる）。
 *
 * @param status HTTP ステータス
 * @param message 本文（利用者向けの短い日本語）
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
function sandboxError(status: number, message: string, context: ResponseContext): Response {
  const csp = sandboxCsp({
    // エラー文書は何も読み込まない。ここは `'none'` のままである（7.2 のとおり）。
    scriptUrl: null,
    connectUrl: null,
    frameAncestorOrigin: context.appOrigin,
  });
  return new Response(`${message}\n`, {
    status,
    headers: sandboxHeaders(csp, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    }),
  });
}

/**
 * サンドボックス用ホストへのリクエストを配信する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
export async function deliverSandboxRequest(request: Request, env: Env): Promise<Response> {
  const context = responseContextOf(request, env);

  // 読み取りしか無い経路である。POST / PUT の類は受けない。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sandboxError(405, 'この経路は GET だけを受け付けます。', context);
  }

  const target = parseSandboxPath(new URL(request.url).pathname);
  if (target === null) {
    return sandboxError(404, '作品が見つかりません。', context);
  }

  const game = await resolveGame(env, target);
  if (game === null) {
    return sandboxError(404, '作品が見つかりません。', context);
  }

  switch (target.asset) {
    case 'document':
      return documentResponse(target, context);
    case 'wasm':
      return await wasmResponse(env, game, context);
    case 'wasm-exec':
      return await wasmExecResponse(env, context);
  }
}

/**
 * ローダー文書を返す。
 *
 * **ここだけが `connect-src` と `script-src` を緩める。** 緩める幅は、この作品が使う
 * 2 本の URL に限る（`src/sandbox-csp.ts`）。
 *
 * @param target 解釈済みの要求
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
function documentResponse(target: SandboxTarget, context: ResponseContext): Response {
  const base = basePathOf(target);
  const wasmPath = `${base}/${WASM_FILE}`;
  const wasmExecPath = `${base}/${WASM_EXEC_FILE}`;

  const csp = sandboxCsp({
    scriptUrl: `${context.origin}${wasmExecPath}`,
    connectUrl: `${context.origin}${wasmPath}`,
    frameAncestorOrigin: context.appOrigin,
  });

  return new Response(loaderHtml({ wasmPath, wasmExecPath }), {
    status: 200,
    headers: sandboxHeaders(csp, {
      'content-type': 'text/html; charset=utf-8',
      // 文書は状態（公開・削除）で変わりうるうえ小さい。キャッシュしない。
      'cache-control': 'no-store',
    }),
  });
}

/**
 * `.wasm` を R2 から返す（3.4-1）。
 *
 * # ヘッダは R2 のオブジェクトメタデータを写す
 *
 * 3.4-1 のとおり、`Content-Type: application/wasm` と `Content-Encoding: br` は
 * **置く側（ビルド関数）が PUT のヘッダとして送っている**（#21）。ここではそれを
 * `writeHttpMetadata` でレスポンスへ写す。
 *
 * **この経路が正しいことは、置く側が正しいことに依存している。** 3.4-2 は
 * 「`Content-Encoding` だけが残って `Content-Type` が落ちると、圧縮は効いているのに
 * ストリーミングだけが黙って失われる」と警告しており、その保証を配信側で閉じるのは
 * M4-4（#29）の範囲である。
 *
 * @param env バインディングと環境変数
 * @param game 配信してよい作品
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
async function wasmResponse(
  env: Env,
  game: DeliverableGame,
  context: ResponseContext,
): Promise<Response> {
  if (game.wasmKey === null) {
    // tombstone 化された作品（5.3 / M5-4）。ソースは残るが実体は無い。
    return sandboxError(404, '作品が見つかりません。', context);
  }

  const object = await fetchObject(env, game.wasmKey);
  if (object === null) {
    // **D1 に行があるのに R2 に実体が無い。** 3.7 が「残る隙間を隠さない」と書いた
    // 状態そのもので、利用者の要求の問題ではない。404 にすると運用の異常が
    // 「消えた作品」に見えるため、5xx で出す。
    console.error(`[sandbox] wasm_key が指す R2 オブジェクトがありません: ${game.wasmKey}`);
    return sandboxError(500, '作品を配信できませんでした。', context);
  }

  const headers = sandboxHeaders(closedCsp(context), {
    // UGC は常に個別ファイルであり、CDN キャッシュはヒットしない前提（3.4-6）。
    'cache-control': 'no-store',
    etag: object.httpEtag,
  });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { status: 200, headers });
}

/**
 * `wasm_exec.js` を R2 から返す。
 *
 * **版の出し分けはまだ無い**（3.5 / M4-4 の範囲）。いまは置かれている 1 つを返す。
 * 見つからないときに何かで代替しないのは、`wasm_exec.js` はビルドに使った Go の版と
 * 厳密に一致する必要があり（3.5）、違うものを配ると読み込みは成功して実行時に壊れる
 * ためである。
 *
 * @param env バインディングと環境変数
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
async function wasmExecResponse(env: Env, context: ResponseContext): Promise<Response> {
  const object = await fetchObject(env, WASM_EXEC_KEY);
  if (object === null) {
    console.error(`[sandbox] wasm_exec.js が R2 にありません（キー: ${WASM_EXEC_KEY}）。`);
    return sandboxError(500, '作品を配信できませんでした。', context);
  }

  return new Response(object.body, {
    status: 200,
    headers: sandboxHeaders(closedCsp(context), {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      etag: object.httpEtag,
    }),
  });
}

/**
 * R2 からオブジェクトを 1 つ読む。
 *
 * 例外を握って null にはしない。**取得の失敗（R2 の障害）と不在は別物**で、前者を
 * 404 として返すと障害が「作品が無い」に見える。呼び出し側は不在だけを扱い、
 * 例外は入口（`src/index.ts`）の 500 へ抜ける。
 *
 * @param env バインディングと環境変数
 * @param key R2 のキー
 * @returns オブジェクト。存在しなければ null
 */
async function fetchObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return await env.BUCKET.get(key);
}

/**
 * サブ資材（文書でないもの）に付ける CSP。
 *
 * **`connect-src` は `'none'` のままである。** 緩めるのはローダー文書だけでよい。
 *
 * @param context CSP の組み立てに使うオリジン
 * @returns CSP ヘッダの値
 */
function closedCsp(context: ResponseContext): string {
  return sandboxCsp({
    scriptUrl: null,
    connectUrl: null,
    frameAncestorOrigin: context.appOrigin,
  });
}
