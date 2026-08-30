/**
 * アプリ用ホスト（本番: `game-forge.ojos.jp`）のレスポンスを組み立てる。
 *
 * M0.5-3 の範囲は「環境が動くこと」の確認に限る。D1 のスキーマ（5.1 の 5 テーブル）は
 * M1-1 が所有するため、ここでは**スキーマに依存しない疎通確認**だけを行う。
 */
import { authRoutes } from './auth/google.js';
import { describeOriginRelation } from './origins.js';
import { generateRoutes } from './generate.js';
import { generateCallbackRoutes } from './generate-callback.js';
import { generatePageRoutes } from './generate-page.js';
import { homeRoutes } from './home.js';
import { inviteRoutes } from './invite-issuance.js';
import { myWorksRoutes } from './my-works.js';
import { ogpRoutes } from './ogp.js';
import { publishRoutes } from './publish.js';
import type { Route } from './routes.js';
import { dispatch, html, json } from './routes.js';
import { signupRoutes } from './signup.js';
import { waitlistRoutes } from './waitlist.js';
import { workPageRoutes } from './work-page.js';

/**
 * 開発用セッション cookie の名前。
 *
 * `__Host-` 接頭辞は 7.2 の必須要件（2 点目）であり、サブドメインからの上書きを防ぐ。
 * ブラウザは `__Host-` を `Secure` かつ `Domain` 属性なし・`Path=/` のときだけ受理する。
 * **`Secure` は HTTPS を要求する**ため、ローカル開発でも自己署名証明書が要る。
 * これが 9.1 の表で「実ドメインでの CSP / cookie 挙動」がローカル検証の限界として
 * 挙げられている一方、`localtest.me` + 自己署名証明書で**構造だけは再現できる**理由である。
 */
export const DEV_SESSION_COOKIE = '__Host-gf_dev_session';

/** 単体テストからも参照できるよう、疎通確認で使う R2 のキーを公開する。 */
export const HEALTH_OBJECT_KEY = '__dev/healthcheck.txt';

/** `/__dev/health` が返す各バインディングの検査結果。 */
interface BindingCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** `/__dev/health` のレスポンス本文。 */
interface HealthReport {
  readonly d1: BindingCheck;
  readonly r2: BindingCheck;
  readonly origins: {
    readonly appHost: string;
    readonly sandboxHost: string;
    readonly differentOrigin: boolean;
    readonly sameSite: boolean;
    readonly reasons: readonly string[];
  };
}

/**
 * ローカル D1 への疎通を確認する。
 *
 * スキーマに依存しない問い合わせだけを使う。M1-1 がテーブルを作る前でも成立し、
 * 作ったあとも壊れない形にしておく（この検査が M1-1 のマイグレーションに
 * 追随を要求すると、環境の検査とスキーマの検査が絡まる）。
 *
 * @param db D1 バインディング
 * @returns 検査結果
 */
async function checkD1(db: D1Database): Promise<BindingCheck> {
  try {
    // sqlite_master を読む。`select 1` のような定数評価だけでは、SQL が通ることしか
    // 分からずストレージ層へ到達したかを確かめられない。カタログの読み出しなら
    // スキーマに依存せずに、実際にデータベースを開けたことまで確認できる。
    //
    // なお D1 は sqlite_version() のような一部の組み込み関数を拒否する
    // （実測: `not authorized to use function: sqlite_version`）。疎通確認に
    // 組み込み関数を使わないこと。
    const row = await db
      .prepare("select count(*) as tables from sqlite_master where type = 'table'")
      .first<{ tables: number }>();
    if (typeof row?.tables !== 'number') {
      return { ok: false, detail: 'クエリは成功しましたが期待した行が返りませんでした' };
    }
    return { ok: true, detail: `sqlite_master にテーブル ${row.tables} 件` };
  } catch (error) {
    console.error('[health] D1 への疎通に失敗しました', error);
    return { ok: false, detail: describeError(error) };
  }
}

/**
 * ローカル R2 への疎通を確認する。
 *
 * 書き込み・読み出し・削除まで一巡させる。`put` だけでは、エミュレーションが
 * 実際に永続化しているかを確かめられない。
 *
 * @param bucket R2 バインディング
 * @returns 検査結果
 */
async function checkR2(bucket: R2Bucket): Promise<BindingCheck> {
  let wrote = false;
  try {
    const payload = `healthcheck ${new Date().toISOString()}`;
    await bucket.put(HEALTH_OBJECT_KEY, payload);
    wrote = true;
    const object = await bucket.get(HEALTH_OBJECT_KEY);
    if (object === null) {
      return { ok: false, detail: 'put した直後の get が null を返しました' };
    }
    const readBack = await object.text();
    if (readBack !== payload) {
      return { ok: false, detail: '書き込んだ内容と読み出した内容が一致しません' };
    }
    return { ok: true, detail: 'put / get / delete が一巡しました' };
  } catch (error) {
    console.error('[health] R2 への疎通に失敗しました', error);
    return { ok: false, detail: describeError(error) };
  } finally {
    // 後片付けは finally に置く。成功経路にだけ delete を書くと、get が null を
    // 返した場合や text() が投げた場合にオブジェクトが残る。この検査は繰り返し
    // 呼ばれるうえ、「後片付けができている」こと自体をテストが見ているため、
    // 残骸があると次の判定を誤らせる。
    if (wrote) {
      try {
        await bucket.delete(HEALTH_OBJECT_KEY);
      } catch (cleanupError) {
        // 後片付けの失敗で疎通の判定を上書きしない。事実だけ記録する。
        console.error('[health] R2 の後片付けに失敗しました', cleanupError);
      }
    }
  }
}

/**
 * 例外を、機密を含まない 1 行の文字列へ落とす。
 *
 * @param error catch した値（型は unknown）
 * @returns ログとレスポンスに出してよい説明
 */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 開発用の経路を有効にする `DEV_ROUTES` の値。
 *
 * **一致したときだけ有効にする**（既定を「無効」に倒す）。`!== 'disabled'` の形に
 * すると、変数の綴りを間違えた・宣言し忘れた環境で診断経路が黙って公開される。
 * 事故の向きを、開けっ放しではなく閉じっぱなしへ倒しておく。
 */
const DEV_ROUTES_ENABLED = 'enabled';

/**
 * 開発用の経路（`/__dev/*`）を提供してよいかを判定する。
 *
 * 値は `wrangler.toml` の `[vars]` が供給する。ローカル（トップレベル）だけが
 * `enabled` で、`[env.production]` / `[env.preview]` はどちらも `disabled` を明示する
 * （#89）。**ホスト名では判定しない。** `APP_HOST` は「どのホストで待ち受けるか」の
 * 宣言であって、環境の種別ではない。両者を兼ねさせると、ホスト名を変えただけで
 * 診断経路の公開・非公開が変わる。
 *
 * @param env バインディングと環境変数
 * @returns 開発用の経路を登録してよければ true
 */
export function devRoutesEnabled(env: Env): boolean {
  return env.DEV_ROUTES === DEV_ROUTES_ENABLED;
}

/**
 * 開発用の経路（`/__dev/*`）。
 *
 * M0.5-3 が所有する範囲であり、M1 以降が足す経路とは別の配列に置く。機能ごとに
 * `Route[]` を分けておくと、経路表への連結が 1 行で済み、並行する PR が
 * 互いのハンドラ本文を触らずに済む。
 *
 * **`/` をここに置かない**（#89 で `/__dev/` へ移した）。M0.5-3 の時点では索引を `/` に
 * 置いていたが、それは本番でそのまま公開トップになる。公開トップ（`src/home.ts`）と
 * 出し分ける形にすると `/` の登録が 2 つになり、`findDuplicateRoutes` が見ている
 * 「後から連結した側が黙って無視される」事故と区別できなくなる。**この配列を丸ごと
 * 落とせば本番の遮断が完了する**、という 1 つの規則に揃える。
 */
const devRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/__dev/',
    handler: () =>
      html(`<!doctype html>
<meta charset="utf-8">
<title>Game Forge (local dev)</title>
<h1>app origin</h1>
<p>ローカル開発用の索引です。本番では登録されません（#89）。</p>
<ul>
  <li><a href="/">/</a> — 公開トップ</li>
  <li><a href="/__dev/health">/__dev/health</a> — D1 / R2 の疎通</li>
  <li><a href="/__dev/session">/__dev/session</a> — <code>${DEV_SESSION_COOKIE}</code> を発行</li>
  <li><a href="/__dev/cookies">/__dev/cookies</a> — 届いた cookie 名の一覧</li>
</ul>`),
  },
  {
    method: 'GET',
    path: '/__dev/health',
    handler: async (_request, env) => {
      const [d1, r2] = await Promise.all([checkD1(env.DB), checkR2(env.BUCKET)]);
      const relation = describeOriginRelation(env.APP_HOST, env.SANDBOX_HOST);
      const report: HealthReport = {
        d1,
        r2,
        origins: {
          appHost: env.APP_HOST,
          sandboxHost: env.SANDBOX_HOST,
          differentOrigin: relation.differentOrigin,
          sameSite: relation.sameSite,
          reasons: relation.reasons,
        },
      };
      const healthy = d1.ok && r2.ok && relation.differentOrigin && relation.sameSite;
      return json(report, healthy ? 200 : 503);
    },
  },
  {
    method: 'GET',
    path: '/__dev/session',
    handler: () => {
      // `__Host-` の受理条件をすべて満たす形で発行する。1 つでも欠けるとブラウザは
      // 黙って捨てるため、検証にならない（Domain を書かない / Path=/ / Secure）。
      const cookie = [
        `${DEV_SESSION_COOKIE}=local-dev-only`,
        'Path=/',
        'Secure',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=3600',
      ].join('; ');
      return json({ issued: DEV_SESSION_COOKIE }, 200, { 'set-cookie': cookie });
    },
  },
  {
    method: 'GET',
    path: '/__dev/cookies',
    // 値は返さない。名前だけで「届いたか」は判定でき、値を返すと将来この経路が
    // 本物のセッションを覗く穴になる。
    handler: (request) => json({ cookieNames: cookieNames(request.headers.get('cookie')) }),
  },
];

/**
 * アプリ用ホストの経路表を組み立てる。
 *
 * M1 以降で経路を足すときは、機能ごとの `Route[]` を別ファイルに置き、この配列へ
 * 連結する。ここへハンドラ本文を書き足さないこと（並行する PR が同じ行を取り合う）。
 *
 * **定数ではなく関数にしている理由**は `devRoutes` だけである。本番で `/__dev/*` を
 * 遮断する（#89）には env を見る必要があり、モジュール読み込み時には env が無い。
 * 組み立ては配列の連結だけなので、リクエストごとに呼んでも実質的な費用は無い。
 *
 * @param env バインディングと環境変数
 * @returns 経路表
 */
export function createAppRoutes(env: Env): readonly Route[] {
  return [
    ...homeRoutes,
    ...(devRoutesEnabled(env) ? devRoutes : []),
    ...authRoutes,
    ...signupRoutes,
    ...waitlistRoutes,
    ...generateRoutes,
    ...generateCallbackRoutes,
    ...generatePageRoutes,
    ...workPageRoutes,
    ...myWorksRoutes,
    ...publishRoutes,
    ...ogpRoutes,
    ...inviteRoutes,
  ];
}

/**
 * アプリ用ホストへのリクエストを処理する。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
export async function handleAppRequest(request: Request, env: Env): Promise<Response> {
  return await dispatch(createAppRoutes(env), request, env);
}

/**
 * `Cookie` ヘッダから cookie 名だけを取り出す。
 *
 * @param header `Cookie` ヘッダの値（未設定なら null）
 * @returns cookie 名の配列（重複は保持する）
 */
export function cookieNames(header: string | null): string[] {
  if (header === null || header.trim() === '') {
    return [];
  }
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separator = pair.indexOf('=');
      return separator === -1 ? pair : pair.slice(0, separator);
    })
    .filter((name) => name !== '');
}
