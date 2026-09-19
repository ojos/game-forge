/**
 * 経路表から「SSR で画面を返す経路」を導く（#282）。
 *
 * # なぜ独立したモジュールなのか
 *
 * 画面の一覧を必要とする検査が 2 つある。**フッタの位置**を見る単体テスト
 * （`test/page-shell.test.ts`）と、**幅 390px での表示**を見る実ブラウザの検査
 * （`scripts/check-page-width.sh` が `/__dev/pages` から受け取る）である。
 *
 * **両者が別々に一覧を持つと、画面を 1 枚足した日に片方だけが追随する。**
 * それは #282 が捕まえたい失敗（足した画面が外枠に乗らない）と同じ形なので、
 * 導出をここへ 1 つだけ置く（`.ai-playbook/shared-ai-rules.md` 12 章）。
 *
 * # 一覧を持つのは画面ではなく例外の側である
 *
 * 「画面はこれ」と並べると、足した画面が漏れても誰も気づかない。ここが並べるのは
 * **画面でない GET 経路**だけで、画面は経路表から自動で入る。**失敗の向きが閉じる側**
 * になり、画面でないものを足したときにだけ説明を求められる。
 *
 * # 導出はホストで分けない（2.4.5 / #356 が決めたこと）
 *
 * **運営の管理画面（`admin.game-forge.ojos.jp`）も、同じ `ssrPagePaths` で導く。**
 * 2.4.5 は「画面の検査は、利用者向けの画面と同じ網に乗せる」と定め、その根拠に
 * 「#282 が捕まえたい失敗（足した画面が外枠に乗らない）は、**運営しか見ない画面でこそ
 * 起きやすい**」を挙げている。
 *
 * **分ける必要が無かった。** {@link ssrPagePaths} は経路表を引数で受け取る関数で、
 * **ホストを 1 つも知らない。** 呼ぶ側が `createAppRoutes(env)` を渡すか
 * `createAdminRoutes()` を渡すかだけの違いになる。ホストごとに導出を分けると、
 * **まさにこのモジュールが避けている「2 つの一覧」が復活する。**
 *
 * **下の例外一覧も両ホストで共有する。** admin ホストも OAuth の 2 経路を持つため
 * （`src/admin/routes.ts` の `ADMIN_OPEN_ROUTES`）、綴りは同じで、外すべき理由も同じ
 * である。**片方のホストにしか無い例外は、いまは 1 つも無い。**
 *
 * **3 検査のすべてに乗っている。** 外枠（`test/admin-page-shell.test.ts`）と画面一覧の
 * 導出（ここ）に加え、**幅 390px の実ブラウザ検査（`scripts/check-page-width.sh`）も
 * #398 で admin を開くようになった**——一覧は `/__dev/pages` の `adminPaths`（`src/app.ts`）
 * から受け取り、dev サーバは 1 つのまま `Host` で振り分ける（`*.localtest.me` は
 * 127.0.0.1 を返す）。
 */
import { AUTHORIZE_RESUME_PATH } from './oauth-paths.js';
import { ROBOTS_PATH } from './robots.js';
import { SITEMAP_PATH } from './sitemap.js';
import type { Route } from './routes.js';

/**
 * 画面ではない GET 経路。
 *
 * ここへ画面を足して検査から逃がさないこと。逃がす理由は「画面ではない」でなければ
 * ならない。
 */
export const NON_PAGE_PATHS: readonly string[] = [
  '/auth/google/start', // Google の同意画面へのリダイレクト
  '/auth/google/callback', // 同上（戻り先）
  '/ogp/', // OGP 画像そのものを配る（`src/ogp.ts` の OGP_IMAGE_PREFIX）
  ROBOTS_PATH, // クローラへの意思表示（#594）。text/plain であって画面ではない
  SITEMAP_PATH, // 載せてよい URL の在処（#595）。XML であって画面ではない
  AUTHORIZE_RESUME_PATH, // ログインから戻った認可の要求を `/authorize?…` へ送り直す 303（#696）
];

/**
 * 画面ではない経路の接頭辞。
 *
 * `/__dev/` は本番で `devRoutes` ごと落ちる（`src/app.ts`）。`/api/` は機械が読む応答で
 * ある。**個別に並べず接頭辞で外す**のは、経路を 1 本足すたびに例外一覧が伸びる形に
 * しないためである。
 */
export const NON_PAGE_PREFIXES: readonly string[] = ['/__dev/', '/api/'];

/**
 * 経路表から SSR 画面のパスを取り出す。
 *
 * `match: 'prefix'` の経路は登録されたままの形（例: `/works/`）で返す。実際に開くには
 * 呼び出し側が続きを補う必要があり、**何を補うべきかは呼び出し側しか知らない**
 * （テストは自分が仕込んだ作品の id、検査スクリプトは自分が仕込んだ id を使う）。
 *
 * @param routes 経路表（`createAppRoutes` の戻り値）
 * @returns パスの配列（重複なし・安定順）
 */
export function ssrPagePaths(routes: readonly Route[]): string[] {
  const paths = routes
    .filter((route) => route.method === 'GET')
    .map((route) => route.path)
    .filter((path) => !NON_PAGE_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !NON_PAGE_PATHS.includes(path));
  return [...new Set(paths)].sort();
}

/**
 * パンくずに出す親の候補を、パスの末尾を 1 段ずつ削って導く（2.3.10 / #372）。
 *
 * # 新しい構造を持ち込まない
 *
 * **階層は URL が既に持っている**（#152 / 2.3.2。`/works/<game_id>` の親は `/works`）。
 * ここはそれを取り出すだけで、「この画面の親はこれ」という表を画面の側に持たせない。
 * **画面を 1 枚足しても、ここへ書き足すものは無い。**
 *
 * # 候補であって、親そのものではない
 *
 * 削って出来たパスが画面とは限らない（`/users/<id>` を削った `/users` は経路表に無い）。
 * **画面かどうかを決めるのは経路表**で、呼び出し側が突き合わせる。実行時の外枠
 * （`src/html.ts` の `siteBreadcrumb`）は親の名前の表を引き、**表に無いものは出さない**。
 * 表が経路表と噛み合っていること（画面である親が 1 つも漏れていないこと、表の行き先が
 * すべて画面であること）は `test/page-shell.test.ts` が {@link ssrPagePaths} と
 * 突き合わせて見る。**一覧を持つのは例外（親になる画面）の側で、葉の画面は自動で乗る。**
 *
 * # トップは返さない
 *
 * `/` は全画面の親なので、呼び出し側が常に先頭へ置く。ここで返すと、`/` だけが
 * 「削って出来た候補」と「必ず出す起点」の 2 役を持つことになる。
 *
 * **末尾の `/` は 1 段として数える。** 前方一致の経路（`/works/`）を渡しても、
 * 実際のパス（`/works/<id>`）を渡しても、同じ親（`/works`）が出る。
 *
 * @param path いま開いている画面のパス（`URL#pathname`。前方一致の経路の接頭辞でもよい）
 * @returns 浅い順の親の候補（`/` は含まない。重複なし）
 */
export function ancestorPathsOf(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  // `segments` の先頭は `/` の前の空文字、末尾はいま開いている画面そのものなので、
  // その間だけを親の候補にする。
  for (let end = 2; end < segments.length; end++) {
    const candidate = segments.slice(0, end).join('/');
    // `//x` のような綴りでは空の段が出来る。`/` と空文字は候補にしない。
    if (candidate !== '' && candidate !== '/' && !ancestors.includes(candidate)) {
      ancestors.push(candidate);
    }
  }
  return ancestors;
}
