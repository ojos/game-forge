/**
 * 公開トップ（`/`）。**本番で最初に見られる 1 枚**であり、招待制クローズドβの
 * 入口を示すことだけを担う（1 章 / 確定7 / 8.1）。
 *
 * ## なぜ独立したモジュールにするのか
 *
 * `/` は M0.5-3 の時点で開発用の索引ページだった（`src/app.ts` の `devRoutes`）。
 * 本番の配備（#89）でそれが公開トップになる事故を、**同じ配列の中で出し分ける**形で
 * 塞ぐと、`/` の登録が 2 つになって `findDuplicateRoutes` の検出対象になる。
 * 公開トップを独立させ、開発用の索引を `/__dev/` へ寄せると、
 * **「`/` は常に公開トップ、`/__dev/*` は開発時のみ」**という 1 つの規則で済む。
 *
 * ## D1 を読まない
 *
 * 待機リストの件数（`src/signup.ts` が出しているもの）をここへ出さない。トップは
 * 未ログインの閲覧者が最初に踏む経路で、URL 拡散の着地点にもなる（2.2-1）。
 * 1 アクセスごとに D1 の読み取りが増える形は、3.6 が挙げる無料枠の圧迫に直結する。
 * 件数は登録の判断に効く `/signup` にだけ置く。
 *
 * ## JavaScript もスタイルシートも要求しない
 *
 * MVP の画面は SSR の素の HTML に留める（9.3 / #89 の scope.out）。Next.js / React へ
 * 寄せる判断は M2-1 以降が持ち、ここで先取りすると捨てる量が増える。
 */
import type { Route } from './routes.js';
import { html } from './routes.js';
import { LOGIN_PATH } from './auth/google.js';
import { INVITES_PATH, SIGNUP_PATH } from './paths.js';

/** 公開トップのパス。 */
export const HOME_PATH = '/';

/**
 * 公開トップの HTML。
 *
 * **まだ出来ていないものを出来ているように書かない。** 生成機能（`/api/generate`）は
 * 骨組みだけで、#83 / #16 が未完了である（#89 の scope.out）。この時点で「1 行の
 * プロンプトからゲームが作れます」と書くと、登録した人が最初に踏むのが「何もできない」
 * になる。いま提供できるのは登録と待機リストだけなので、そこまでを書く。
 *
 * 招待の発行（#91）への導線をここに置くのは、**ログイン後の着地点が `/` だから**である
 * （`src/auth/google.ts` のコールバックは `/` へ戻す）。導線が無いと、実装した経路へ
 * ブラウザから辿り着けない。未ログインにも見えるリンクになるが、押した先で
 * ログインへ送られるだけで、D1 の読み取りはここでは起きない。
 *
 * **招待枠の本数をここに書かない。** 書けば `INVITE_QUOTA`（`src/invite-issuance.ts`）の
 * 写しになり、変えたときに片方だけが古くなる。本数は発行の画面が出す。
 */
const HOME_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game Forge</title>
<meta name="description" content="プロンプト1行で生まれるブラウザ2Dゲームと、フォーク型 UGC コミュニティ。招待制クローズドβ。">
<h1>Game Forge</h1>
<p>プロンプト 1 行から、ブラウザで遊べる 2D ゲームが生まれます。
   気に入った作品は<strong>改造（フォーク）</strong>して、自分の 1 本として公開できます。</p>

<h2>いまの状態</h2>
<p><strong>招待制のクローズドβを準備しています。</strong>
   遊ぶことと URL の共有に招待は要りませんが、<strong>生成は招待コードをお持ちの方に限ります。</strong></p>
<p>生成機能はまだ公開していません。いまできるのは、招待コードでの登録と、待機リストへの登録です。</p>

<h2>はじめる</h2>
<ul>
  <li><a href="${SIGNUP_PATH}">招待コードで登録する</a></li>
  <li><a href="${SIGNUP_PATH}">招待コードをお持ちでない方（待機リストに登録する）</a></li>
  <li><a href="${LOGIN_PATH}">すでにアカウントをお持ちの方（Google でログイン）</a></li>
</ul>

<h2>参加している方へ</h2>
<p><a href="${INVITES_PATH}">招待コードを発行する</a>（ログインが必要です）</p>
`;

/**
 * 公開トップの経路。
 *
 * `src/app.ts` の経路表へ連結する。ここに `/__dev/*` を混ぜないこと（本番で遮断する
 * 単位が `devRoutes` なので、混ざると遮断の対象から漏れる）。
 */
export const homeRoutes: readonly Route[] = [
  { method: 'GET', path: HOME_PATH, handler: () => html(HOME_HTML) },
];
