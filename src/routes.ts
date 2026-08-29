/**
 * アプリ用ホストの経路表と、その解決。
 *
 * なぜ `switch` ではなく表なのか: M1（#11〜#14）は認証・招待・待機リストの経路を
 * **並行して**足す。1 つの `switch` へ全員が `case` を書き足すと、同じ行を取り合って
 * 毎回衝突が出る。経路をデータとして持ち、各機能が自分の `Route[]` を持ち寄る形なら、
 * 追加は「配列を 1 つ連結する」だけになり、並列に走る PR が互いの本文を触らない。
 *
 * この分解は経路の**振る舞いを変えない**。既存の経路・レスポンス・ステータスは
 * そのままで、内部の持ち方だけを差し替える（test/worker.test.ts が不変であることの証拠）。
 */

/** 経路が受け付ける HTTP メソッド。必要になった時点で広げる。 */
export type RouteMethod = 'GET' | 'POST';

/** 1 つの経路を処理する関数。 */
export type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>;

/**
 * パスの一致のさせ方。
 *
 * **既定は `exact`（完全一致）である。** M1 以来この表は完全一致しか持たず、
 * 「前方一致やパラメータは扱わない（必要になったら、その時点で設計する）」と
 * 書いてあった。**#150 でその時点が来た**（`/works/<game_id>`）。
 *
 * **`prefix` を後付けにして、既定を変えない。** `match` を省いた経路は今までと
 * 1 ビットも変わらない挙動になるので、既存の経路の振る舞いを見直す必要が無い。
 */
export type RouteMatch = 'exact' | 'prefix';

/** 経路表の 1 行。 */
export interface Route {
  readonly method: RouteMethod;
  /**
   * パス。`match` が `prefix` のときは、ここが**前方一致の接頭辞**になる。
   *
   * 接頭辞は `/` で終える規約にする（`/works/`）。終えないと `/worksmith` のような
   * 別の経路まで飲み込む。**規約で守らず、登録時に機械で確かめる**
   * （{@link findMalformedPrefixRoutes}）。
   */
  readonly path: string;
  /** パスの一致のさせ方（既定は `exact`）。 */
  readonly match?: RouteMatch;
  readonly handler: RouteHandler;
}

/**
 * 経路が前方一致かどうか。
 *
 * @param route 経路
 * @returns 前方一致なら true
 */
function isPrefixRoute(route: Route): boolean {
  return route.match === 'prefix';
}

/**
 * 経路表からハンドラを解決して実行する。
 *
 * パスが無ければ 404、パスはあるがメソッドが違えば 405 を返す。両者を区別するのは、
 * 405 が「経路はあるが呼び方が違う」ことを示し、`Allow` で正しい呼び方まで返せるため。
 * 一律 404 にすると、経路の綴りを間違えたのかメソッドを間違えたのかが読めない。
 *
 * @param routes 経路表
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
export async function dispatch(
  routes: readonly Route[],
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  // HEAD は GET の経路で解決する。HTTP 上 HEAD は「GET と同じヘッダを、本文なしで」
  // 返すものであり、別の経路として登録するものではない。ここで畳まないと、
  // 経路を足す側が毎回 GET と HEAD の 2 行を書くことになり、片方の書き忘れが 405 になる。
  // 本文の除去はランタイムが行うため、ハンドラ側は GET と同じ実装でよい。
  const method = request.method === 'HEAD' ? 'GET' : request.method;

  // **完全一致を先に見る。** 前方一致より優先することで、`/works/` の下に将来
  // `/works/new` のような固定の経路を足しても、前方一致の経路に飲み込まれない。
  // 完全一致が 1 つでもあれば、そこで決める（405 の判定もその集合の中で行う）。
  const exactPath = routes.filter(
    (route) => !isPrefixRoute(route) && route.path === url.pathname,
  );
  // 前方一致は**いちばん長い接頭辞だけ**を採る。短いほうも候補に混ぜると、より具体的な
  // 経路が登録順しだいで届かなくなり、405 の `Allow` にも無関係なメソッドが混ざる。
  const matchedPrefixes = routes.filter(
    (route) => isPrefixRoute(route) && url.pathname.startsWith(route.path),
  );
  const longestPrefix = matchedPrefixes.reduce<string | null>(
    (longest, route) =>
      longest === null || route.path.length > longest.length ? route.path : longest,
    null,
  );
  const prefixPath =
    longestPrefix === null
      ? []
      : matchedPrefixes.filter((route) => route.path === longestPrefix);

  const samePath = exactPath.length > 0 ? exactPath : prefixPath;
  if (samePath.length === 0) {
    return json({ error: 'not found', path: url.pathname }, 404);
  }

  const matched = samePath.find((route) => route.method === method);
  if (matched === undefined) {
    const allow = allowedMethods(samePath);
    return json({ error: 'method not allowed', path: url.pathname, allow }, 405, {
      allow: allow.join(', '),
    });
  }

  return await matched.handler(request, env);
}

/**
 * 同じパスに登録された経路から `Allow` ヘッダの値を組み立てる。
 *
 * GET を受け付ける経路は HEAD も受け付ける（`dispatch` が畳んでいる）ため、
 * 実際に通る呼び方をそのまま列挙する。
 *
 * @param samePath 同一パスの経路
 * @returns 許可するメソッド名（重複なし・登録順）
 */
function allowedMethods(samePath: readonly Route[]): string[] {
  const methods: string[] = [];
  for (const route of samePath) {
    if (!methods.includes(route.method)) {
      methods.push(route.method);
    }
    if (route.method === 'GET' && !methods.includes('HEAD')) {
      methods.push('HEAD');
    }
  }
  return methods;
}

/**
 * 経路表の中で重複しているメソッドとパスの組を返す。
 *
 * `dispatch` は最初に一致した経路を使うため、重複しても**動いてしまう**。
 * M1 では複数の PR が並行して経路を足すので、後から連結した側が黙って無視される
 * 事故が起こりうる。動くかどうかでは気づけない以上、機械で検出してテストで落とす。
 *
 * @param routes 経路表
 * @returns 重複している `"METHOD /path"` の一覧（重複なし・出現順）
 */
export function findDuplicateRoutes(routes: readonly Route[]): string[] {
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const route of routes) {
    // **一致のさせ方まで含めて鍵にする。** 同じパスに完全一致と前方一致の両方を
    // 登録するのは正当（`/works/` の下に固定の経路を足す場合）なので、混ぜて重複と
    // 判定しない。`dispatch` も完全一致を先に見るので、この 2 つは共存できる。
    const key = `${route.method} ${route.path}${isPrefixRoute(route) ? '*' : ''}`;
    if (seen.has(key)) {
      if (!duplicated.includes(key)) {
        duplicated.push(key);
      }
    } else {
      seen.add(key);
    }
  }
  return duplicated;
}

/**
 * 接頭辞の綴りが規約に反している前方一致の経路を返す。
 *
 * **接頭辞は `/` で始まり `/` で終わること。** 終えないと、`/works` という接頭辞が
 * `/worksmith` まで飲み込む。**動いてしまう**ので、綴りを間違えても気づけない
 * （飲み込まれた側がまだ存在しないなら、何も壊れていないように見える）。
 * {@link findDuplicateRoutes} と同じ理由で、呼びかけではなく機械で検出してテストで落とす。
 *
 * @param routes 経路表
 * @returns 規約に反している `"METHOD /path"` の一覧（重複なし・出現順）
 */
export function findMalformedPrefixRoutes(routes: readonly Route[]): string[] {
  const malformed: string[] = [];
  for (const route of routes) {
    if (!isPrefixRoute(route)) {
      continue;
    }
    if (route.path.startsWith('/') && route.path.endsWith('/') && route.path.length > 1) {
      continue;
    }
    const key = `${route.method} ${route.path}`;
    if (!malformed.includes(key)) {
      malformed.push(key);
    }
  }
  return malformed;
}

/**
 * JSON レスポンスを組み立てる。
 *
 * `cache-control: no-store` を既定にする。このアプリのレスポンスはセッションや
 * 生成枠の状態に依存するものが大半で、既定を「キャッシュしない」に倒しておくほうが、
 * 個別に付け忘れて共有キャッシュへ載る事故より安全である。キャッシュさせたい経路が
 * 出てきたら、その経路が明示的に上書きする。
 *
 * @param body シリアライズする値
 * @param status HTTP ステータス
 * @param headers 追加のヘッダ
 * @returns レスポンス
 */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * HTML レスポンスを組み立てる。
 *
 * @param body HTML 本文
 * @param status HTTP ステータス
 * @returns レスポンス
 */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 例外を、ログへ出してよい 1 行の文字列へ落とす。
 *
 * 生の `error` を渡すと、スタックや `cause` の連鎖を通じて本文そのものがログへ
 * 入りうる。入る情報の範囲をこちら側で決める。
 *
 * @param error catch した値（型は unknown）
 * @returns ログに残してよい 1 行
 */
function describeBodyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 本文の読み出し結果。 */
export type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'body-too-large' | 'unreadable-body' };

/**
 * リクエスト本文を、上限を超えたら打ち切りながら読む。
 *
 * `request.text()` を使わないのは、上限を超えたかどうかが**読み切ったあと**にしか
 * 分からないためである。`Content-Length` を先に見る形も、ヘッダは省略できる
 * （chunked）うえ実際の本文と一致する保証がない。読みながら数えるのが、
 * 上限を実際に効かせられる唯一の形になる。
 *
 * @param request 受信したリクエスト
 * @param limit 受け付ける最大バイト数
 * @returns 本文の文字列、または打ち切り・読み出し失敗の理由
 */
export async function readLimitedText(request: Request, limit: number): Promise<BodyReadResult> {
  const body: ReadableStream<Uint8Array> | null = request.body;
  if (body === null) {
    // 本文なしの POST。JSON として不正なので、この後の解析で落ちる。
    return { ok: true, text: '' };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    // `getReader()` も try の中に置く。本文が既に読まれていると（ロック済み）
    // ここが投げるため、外に置くと catch を素通りして呼び出し元まで例外が上がる。
    reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        // 残りを受け取らずに切る。読み捨てても上限を超えた分の転送は続くため、
        // ここで止めないと上限を置いた意味が薄れる。
        await reader.cancel();
        return { ok: false, reason: 'body-too-large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    // 通信の切断など。利用者の入力の問題ではないが、こちらから見えるのは
    // 「本文が読めなかった」ことだけなので、400 として扱う。ログは 1 行へ落とす
    // （本文そのものが例外へ入りうる位置なので、生の error を渡さない）。
    console.error(
      `[routes] リクエスト本文の読み出しに失敗しました: ${describeBodyError(error)}`,
    );
    return { ok: false, reason: 'unreadable-body' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 不正なバイト列は置換文字になる（投げない）。JSON として壊れていれば解析側で落ちる。
  return { ok: true, text: new TextDecoder().decode(merged) };
}
