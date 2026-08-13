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

/** 経路表の 1 行。 */
export interface Route {
  readonly method: RouteMethod;
  /** パス。前方一致やパラメータは扱わない（必要になったら、その時点で設計する）。 */
  readonly path: string;
  readonly handler: RouteHandler;
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

  const samePath = routes.filter((route) => route.path === url.pathname);
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
    const key = `${route.method} ${route.path}`;
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
