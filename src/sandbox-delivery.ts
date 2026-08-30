/**
 * サンドボックス用ホストの配信（3.4 / 3.5 / 5.4 / 7.2 / #28 / #29）。
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
 * この経路が受け付けるメソッド。
 *
 * **判定にも `Allow` ヘッダにも本文にも、この 1 つの配列を使う。** 別々に書くと、
 * 「HEAD は通るのに『GET だけを受け付けます』と答える」ような食い違いが生まれる
 * （実際にそうなっていた）。読み取りしか無い経路なので、これ以上増えることはない。
 *
 * `Allow` の綴りは `src/routes.ts` の `allowedMethods` に揃える（`, ` 区切り）。
 * アプリ側とサンドボックス側で 405 の形が違う理由が無い。
 */
const ALLOWED_METHODS = ['GET', 'HEAD'] as const;

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
 * `go_version` の綴り（`go1.26.5` の形）。
 *
 * **R2 のキーへ埋めるので、綴りを限定しないと `../` を含む値でキーを組み立てうる。**
 * 値は `games.go_version` 経由で来る（ビルド関数の応答が出所）ため現実には安全側だが、
 * **キーを組み立てる側で閉じる。**
 */
const GO_VERSION_PATTERN = /^go\d+\.\d+(?:\.\d+)?$/u;

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
  const rawSegments = pathname.replace(/^\//u, '').split('/');

  // **末尾の空要素を許すのは、文書の経路（2 セグメント）のときだけである。**
  // `/p/<key>/` を `/p/<key>` と同じ綴りとして受けるためのもので、それ以外の位置に
  // 空セグメントがあれば下の検査で落ちる。
  //
  // ここを「末尾の空要素を 1 つ落とす」だけにすると `/p/<key>//` と
  // `/g/<id>/game.wasm/` が通ってしまう。**通ると実害がある。** 配信された文書が
  // 埋める資材のパスは正規の綴り（`/p/<key>/game.wasm`）だが、CSP は要求された URL の
  // ほうから組み立てられるため、**CSP が許した URL と実際に読む URL が食い違う。**
  // 結果は「自分の wasm を読めないページ」で、しかも 200 で返るので壊れて見えない。
  const segments =
    rawSegments.length === 3 && rawSegments[2] === '' ? rawSegments.slice(0, 2) : rawSegments;

  if (segments.length < 2 || segments.length > 3) {
    return null;
  }
  // 空セグメント（`//` や先頭の `/` の重なり）はどの位置でも通さない。
  if (segments.some((segment) => segment === '')) {
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

  // 2 セグメントなら文書、3 セグメントなら 3 つ目がファイル名である。
  if (segments.length === 2) {
    return { scope, identifier, asset: 'document' };
  }

  const asset = assetOf(segments[2]!);
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
 * 3 番目のセグメント（ファイル名）から資材の種類を決める。
 *
 * **空文字を受け付けない。** 文書の経路は呼び出し側が 2 セグメントの時点で確定させる。
 * ここで空文字を `document` として扱うと、`/p/<key>//` のように空セグメントが
 * 混ざった綴りまで文書として通る余地が残る。
 *
 * @param name ファイル名
 * @returns 資材の種類。未知の名前なら null
 */
function assetOf(name: string): SandboxAsset | null {
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
  /** 3.5 の `wasm_exec.js` 出し分けに使う。 */
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
 * `go_version` に対応する `wasm_exec.js` の R2 キーを組み立てる（3.5）。
 *
 * # なぜ「対応表」を持たないのか
 *
 * 3.5 は「新バージョンの `wasm_exec.js` を配信側へ追加する（既存バージョンのものは
 * 消さない）」と定める。**すなわち正本は「R2 に何が置かれているか」である。**
 * コード側に版の一覧を持つと、それは R2 の内容の写しになり、Go を上げた日から静かに
 * ずれる（shared-ai-rules.md 12 章「一覧の複製は機械照合で担保する」）。
 * ここが持つのは**綴りの検証とキーの組み立てだけ**にする。
 *
 * # 置き場所を `builds/` の外にする理由
 *
 * `builds/<source_sha256>/...` はビルド結果で、3.7 のゴミ掃除（被参照ゼロで削除）の
 * 対象になる。`wasm_exec.js` は作品に紐づかない**共有のランタイム資材**であり、
 * どの `games` 行からも参照されない。同じ接頭辞の下に置くと、掃除の対象に見える。
 *
 * @param goVersion `games.go_version` の値
 * @returns R2 のキー。綴りが不正なら null
 */
export function wasmExecKey(goVersion: string): string | null {
  if (!GO_VERSION_PATTERN.test(goVersion)) {
    return null;
  }
  return `runtime/${goVersion}/${WASM_EXEC_FILE}`;
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
 * すべてのレスポンスに付ける `Access-Control-Allow-Origin` の値（#180）。
 *
 * # これは緩和ではない。**読んだ人が真っ先に誤読する場所なので、先に書く**
 *
 * 「CORS を足した＝サンドボックスを緩めた」は**誤りである。** 7.2 が塞いでいるのは
 * **生成物が外へ出ていくこと**で、それを塞いでいるのは `connect-src`（`src/sandbox-csp.ts`）
 * である。**この定数はその集合に 1 要素も足さない。** `connect-src` は依然としてその作品の
 * `.wasm` 1 本だけであり、生成物はそれ以外のどこへも到達できない。
 *
 * ACAO が言うのは **「この応答を、要求した不透明オリジンの文書へ渡してよい」** だけである。
 * 宛先を増やす話ではなく、**すでに許した 1 本の宛先から返ってきた応答を、要求元が
 * 読めるかどうか**の話である。
 *
 * # なぜ必要になったのか（#180 の原因）
 *
 * 7.2 の必須要件 1（`sandbox allow-scripts`、`allow-same-origin` なし）により、**この文書は
 * 不透明オリジンになる。** その帰結として、**自分自身のホストへの `fetch` すらクロス
 * オリジン要求になる**（文書のオリジンが `null` なので「同一オリジン」が成立しない）。
 * ブラウザは `Origin: null` を付けて送り、応答に ACAO が無いので**応答を破棄する。**
 * 利用者の画面には `起動できませんでした: TypeError: Failed to fetch` だけが出る。
 *
 * `wasm_exec.js` が動いていたのは `<script src>`（クラシックスクリプト）で読まれ、
 * CORS の対象外だったためである。**落ちるのは `fetch` だけだった。**
 *
 * # なぜ `*` にしたか（`null` を採らない理由）
 *
 * `null` は「不透明オリジンにだけ渡す」ように**見えるが、絞れていない。**
 *
 * - **`null` は誰でも名乗れる。** 他サイトの sandboxed iframe も `data:` URL も
 *   `Origin: null` を送る。攻撃者が自分のページで 1 行書けば手に入る値であり、
 *   **`*` に対して防げる相手が 1 人も増えない。** 絞れているように見えるだけの指定を
 *   置くと、次に読む人が「不透明オリジン限定になっている」と誤解する。
 * - **`*` は定数なので `Vary: Origin` が要らない。** `null` を返す形は「要求の `Origin` に
 *   応じた応答」に見え、`Vary: Origin` の管理が付いて回る。`/g/` の `.wasm` は
 *   `public, max-age=31536000, immutable`（`cacheControlFor`）で共有キャッシュに載るため、
 *   **`Vary` を 1 度落とすと、あるオリジン向けの応答が別のオリジンへ配られる。**
 *   応答が `Origin` に依らないなら、依らないと書くのがいちばん壊れにくい。
 * - **`*` は資格情報付きの要求を構造的に拒む。** `credentials: 'include'` の要求は
 *   `*` に対して必ず失敗する（`Access-Control-Allow-Credentials` と併用もできない）。
 *   この経路は cookie を 1 つも発行しない（下記）ので実害の差は無いが、**将来
 *   `Allow-Credentials` を足す事故が、`*` のままなら成立しない。**
 *
 * # `*` にして何が起きるか（明示的な判断）
 *
 * **プレビュー URL の唯一の資格情報は `preview_key`（16 進 32 桁 = 128 ビット）である。**
 * ACAO は URL を探索可能にはしない。URL を知っている者は ACAO の有無に関係なく
 * サーバ側（curl 等）から取得できたのであり、**CORS が守っていたのは元々
 * 「ブラウザが被害者の環境の資格情報を勝手に添えて読むこと」だけである。** この経路は
 * cookie を発行せず（7.2 必須要件 3）、認証も見ないため、添えられる資格情報が存在しない。
 * したがって `*` が第三者へ渡すのは**「URL を知っている者が元から取れたもの」だけ**である。
 *
 * # 一律に付ける（サブ資材にもエラーにも）
 *
 * `.wasm` だけに付ける形にしない。**理由は 2 つある。**
 *
 *   1. **エラー応答にも要る。** ローダーの `fetch` が読むのは 200 だけではない。
 *      `.wasm` が 404 / 500 のとき、ACAO が無いとブラウザは**その応答も破棄する**ため、
 *      画面には原因の違う失敗が一様に `TypeError: Failed to fetch` として出る。
 *      **配信側が返した診断が利用者にも作者にも届かない。**
 *   2. **分岐を作らない。** CSP を一律に付けているのと同じ考え方である
 *      （`sandboxHeaders` 参照）。「どの資材か」で付け外しすると、資材が増えた日に
 *      付け忘れが生まれ、しかもその失敗は本番のブラウザでしか見えない（#180 そのもの）。
 *
 * # preflight を扱わない（`OPTIONS` を受けない）のは意図である
 *
 * ローダーが出すのは**ヘッダを何も足さない `GET`**（`src/sandbox-loader.ts`）で、
 * これは単純要求なので preflight が発生しない。`ALLOWED_METHODS` に `OPTIONS` を
 * 足さないのは、**preflight が要る要求を将来この経路へ持ち込ませないため**でもある。
 * 持ち込んだ日は 405 で明確に落ちる（黙って通るより短く済む）。
 */
const ALLOW_ORIGIN = '*';

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
 * `Access-Control-Allow-Origin` も同じ理由で一律に付ける。値と、それが 7.2 を
 * 緩めない理由は `ALLOW_ORIGIN` に書いてある。
 *
 * @param csp `Content-Security-Policy` の値
 * @param extra 追加のヘッダ
 * @returns ヘッダ
 */
function sandboxHeaders(csp: string, extra: Record<string, string>): Headers {
  return new Headers({
    'content-security-policy': csp,
    // 不透明オリジン（7.2 必須要件 1 の帰結）の文書が、自分自身の資材を読めるようにする。
    // **宛先を増やす指定ではない**（`ALLOW_ORIGIN` の冒頭）。`Vary: Origin` は要らない
    // ——応答が要求の `Origin` に依らないためである。
    'access-control-allow-origin': ALLOW_ORIGIN,
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
 * @param extra 追加のヘッダ（405 の `Allow` など）
 * @returns レスポンス
 */
function sandboxError(
  status: number,
  message: string,
  context: ResponseContext,
  extra: Record<string, string> = {},
): Response {
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
      ...extra,
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
  //
  // **`Allow` を付ける。** `src/routes.ts` は「経路はあるが呼び方が違う」ことを
  // `Allow` で示す設計を持っており、こちらだけ落とす理由が無い。本文と `Allow` の
  // どちらも `ALLOWED_METHODS` から作るので、実際の判定とずれない。
  if (!(ALLOWED_METHODS as readonly string[]).includes(request.method)) {
    const allow = ALLOWED_METHODS.join(', ');
    return sandboxError(405, `この経路は ${allow} だけを受け付けます。`, context, { allow });
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
      return await wasmResponse(env, target, game, context);
    case 'wasm-exec':
      return await wasmExecResponse(env, target, game, context);
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
 * `.wasm` を R2 から返す（3.4-1 / 3.4-2）。
 *
 * # 2 つのヘッダを R2 のメタデータ任せにしない
 *
 * 置くのはビルド関数で、PUT のヘッダとして両方を送っている（3.4-1 / #21）。それでも
 * ここで**明示的に上書きする。** 3.4-2 が指摘するとおり、`Content-Encoding` だけが
 * 残って `Content-Type` が落ちると、**圧縮は効いているのにストリーミングだけが黙って
 * 失われる。** 配信側が読み取り時の値に依存していると、その事故は配信のコードを読んでも
 * 見つからない。**この経路が返すものは、この経路が決める。**
 *
 * # `Content-Encoding: br` を付けたまま R2 のバイト列をそのまま流す
 *
 * R2 は保存したバイト列をそのまま返す（復号しない）。ブラウザ側が展開する。
 * **`Accept-Encoding` を見て分岐しない。** R2 には br 版しか無く（3.4-1）、
 * 展開して返す手段が Workers 側に無い以上、分岐しても返せるものは変わらない。
 * br を解さないクライアントは wasm も動かせないので、実害のある組み合わせが無い。
 *
 * # **`encodeBody: 'manual'` が要る**（#181。これが無いと二重に圧縮される）
 *
 * ## 何が起きるか
 *
 * **R2 に入っているバイト列は、既にちょうど 1 回 brotli 圧縮されている。** 圧縮するのは
 * ビルド関数で、`.wasm` を圧縮した `.wasm.br` を `Content-Encoding: br` 付きで PUT する
 * （3.4-1 / #21。`docs/build-function.md`「投入」）。**R2 はそれを復号しないので、
 * `object.body` は「既にエンコード済みの本文」である。**
 *
 * ところが `Response` の既定は `encodeBody: 'automatic'` で、これは
 * **「本文は未エンコードなので、宣言された `Content-Encoding` に従ってランタイムが
 * 圧縮せよ」** という意味になる。結果、**既に圧縮済みのバイト列がもう一度圧縮される。**
 *
 * ブラウザは宣言どおり **1 回だけ**展開するので、手元に残るのは brotli ストリームである。
 * `instantiateStreaming` はそれを wasm として読もうとして落ちる。
 *
 * ```text
 * CompileError: WebAssembly.instantiateStreaming():
 *   expected magic word 00 61 73 6d, found 9b df d6 1d @+0
 * ```
 *
 * `9b df d6 1d` は wasm ではなく **brotli の先頭バイト**である。
 *
 * ## なぜ気づけないのか（**この組み合わせは知らないと絶対に見えない**）
 *
 * **ヘッダは全部正しい。** `Content-Type: application/wasm` も `Content-Encoding: br` も
 * 宣言どおりに付いており、`curl -i` で見ても 200 で、本文の大きさも「圧縮された wasm」
 * として妥当に見える。**`Content-Encoding` を正しく付けているのに二重になる**という
 * 形なので、ヘッダを何度確かめても原因に辿り着かない。**1 回展開してもまだ brotli
 * である**ことを見て初めて分かる。
 *
 * 本番の実測（#181。取り込み担当が確認）:
 *
 * ```text
 * 配信      2,229,376 バイト（先頭 a5 ff 7f 09）
 *   1 回展開 2,313,735 バイト（先頭 9f c8 89 b0 ＝ まだ brotli）
 *   2 回展開 11,569,609 バイト（先頭 00 61 73 6d ＝ \0asm）★
 * ```
 *
 * ## `encodeBody: 'manual'` の意味
 *
 * **「本文は既にエンコード済みである。ランタイムは触るな」**と宣言する。ヘッダの
 * `Content-Encoding: br` はそのまま送られ、本文は R2 のバイト列がそのまま流れる。
 * これが 3.4-1 の意図（**事前**圧縮した `.wasm.br` を配る）そのものである。
 *
 * ## 単体テストでは捕まらない（実測）
 *
 * **`SELF.fetch`（vitest の workers pool）はこの不具合を再現しない。** 内部の
 * サブリクエストには HTTP のエンコード境界が無く、R2 のバイト列がそのまま返るため、
 * `encodeBody` の指定に関係なく同じ結果になる（実測で確認）。**#180 と同じ形の
 * 盲点である**——代理は「宣言が正しいか」しか見ておらず、宣言が正しいのに実物が
 * 壊れる組み合わせを構造的に捕まえられない。
 *
 * **捕まえるのは実 HTTP を通る 2 本である。**
 *
 *   - `scripts/check-sandbox-browser.sh`  ローカルの dev サーバ越しに取得し、
 *                                         1 回展開して `00 61 73 6d` を確かめる
 *                                         （ブラウザ不要の層と、実ブラウザの層の両方）
 *   - `scripts/check-sandbox-cors.sh`     配備済みの実物に対して同じことを確かめる
 *
 * # キャッシュ
 *
 * 同じ URL の中身は変わらない。`wasm_key` は作成時に決まり（`src/games.ts`）、以後
 * 書き換わらない。再生成は別の作品行（＝別の URL）になる。したがって長い `max-age` を
 * 付けられる。**ただし `/p/` は `private` にする。** unlisted キーが唯一の資格情報なので、
 * 共有キャッシュへ載せない。3.4-6 のとおり CDN のヒットは元々当てにしていないため、
 * `private` にして失うものが無い。
 *
 * @param env バインディングと環境変数
 * @param target 解釈済みの要求
 * @param game 配信してよい作品
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
async function wasmResponse(
  env: Env,
  target: SandboxTarget,
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

  return new Response(object.body, {
    status: 200,
    // **この 1 行が無いと二重に圧縮される**（#181）。R2 のバイト列は既に 1 回
    // 圧縮済みで、既定の `'automatic'` はそれを未エンコードとみなしてもう一度
    // 圧縮する。因果と本番の実測値は上のドキュメントコメントにある。
    encodeBody: 'manual',
    headers: sandboxHeaders(closedCsp(context), {
      // 3.4-1 が求める 2 つ。**両方を必ず付ける。**
      'content-type': 'application/wasm',
      'content-encoding': 'br',
      'cache-control': cacheControlFor(target.scope),
      etag: object.httpEtag,
    }),
  });
}

/**
 * `go_version` に対応する `wasm_exec.js` を R2 から返す（3.5）。
 *
 * **版が見つからないときに他の版へ落ちない。** 3.5 が言うとおり `wasm_exec.js` は
 * ビルドに使った Go の版と厳密に一致する必要があり、**違う版で動かすと失敗の仕方が
 * 分かりにくい**（読み込みは成功し、実行時に壊れる）。既定の版へ落とすくらいなら、
 * 何が足りないかを言って止めるほうが運用事故が短く済む。
 *
 * # ここに `encodeBody: 'manual'` は要らない（#181）
 *
 * **R2 のバイト列を本文にする点は `wasmResponse` と同じだが、こちらは
 * `Content-Encoding` を宣言しない。** R2 に置く `wasm_exec.js` は非圧縮であり
 * （`scripts/put-wasm-exec.sh`）、本文は未エンコードのままで正しい。二重圧縮は
 * 「**エンコード済みの本文**に `Content-Encoding` を宣言した」ときにだけ起きるので、
 * ここには成立する余地が無い。**同じ形に見える 2 つを、同じ扱いにしないこと。**
 *
 * @param env バインディングと環境変数
 * @param target 解釈済みの要求
 * @param game 配信してよい作品
 * @param context CSP の組み立てに使うオリジン
 * @returns レスポンス
 */
async function wasmExecResponse(
  env: Env,
  target: SandboxTarget,
  game: DeliverableGame,
  context: ResponseContext,
): Promise<Response> {
  const key = wasmExecKey(game.goVersion);
  if (key === null) {
    console.error(`[sandbox] go_version の綴りが不正です: ${game.goVersion}`);
    return sandboxError(500, '作品を配信できませんでした。', context);
  }

  const object = await fetchObject(env, key);
  if (object === null) {
    console.error(
      `[sandbox] ${game.goVersion} の wasm_exec.js が R2 にありません（キー: ${key}）。` +
        ' 3.5 の更新手順「新バージョンの wasm_exec.js を配信側へ追加する」が未実施です。',
    );
    return sandboxError(500, '作品を配信できませんでした。', context);
  }

  return new Response(object.body, {
    status: 200,
    headers: sandboxHeaders(closedCsp(context), {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': cacheControlFor(target.scope),
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

/**
 * 資材の `Cache-Control` を決める。
 *
 * @param scope 配信の種類
 * @returns `Cache-Control` の値
 */
function cacheControlFor(scope: SandboxScope): string {
  // 公開済みは誰が見ても同じものなので共有キャッシュに載せてよい。中身は不変
  // （`wasm_key` は作成時に決まり書き換わらない）なので `immutable` を付ける。
  if (scope === 'published') {
    return 'public, max-age=31536000, immutable';
  }
  // プレビューは unlisted キーが唯一の資格情報なので共有キャッシュへ載せない。
  // 有効期間も短くする。作者が試遊のたびに 2.3MB を取り直さずに済み、かつ
  // 「リンクを止めたのに古いキャッシュで見えている」窓が長く残らない長さにする。
  return 'private, max-age=600';
}
