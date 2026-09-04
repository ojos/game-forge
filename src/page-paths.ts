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
 */
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
