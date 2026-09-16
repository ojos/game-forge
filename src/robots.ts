/**
 * クローラに対する意思表示（`/robots.txt` と `X-Robots-Tag`。#594）。
 *
 * # 3 つのホストで中身が違う
 *
 * `src/index.ts` が `Host` で振り分ける 3 つのホストは、クローラに対して言うことが違う。
 *
 * | ホスト | 言うこと |
 * |---|---|
 * | app | 公開面は検索クローラへ許可し、機械が読む口とログインが要る操作の口だけ近寄らせない |
 * | sandbox | 全面拒否（拡散の着地点は作品ページである。仕様 5.4） |
 * | admin | 全面拒否（検索結果に出てよいものではない） |
 *
 * **静的ファイルでは実装できない。** Pages プロジェクトは 1 つで、`public/` へ置いた
 * `robots.txt` は 3 ホストすべてに同じものを返す（`docs/pages-deploy.md` の `_routes.json`
 * の節）。**ホストごとに違うものを返せるのは Worker の経路だけである。**
 *
 * # `robots.txt` と `noindex` を取り違えない
 *
 * **`robots.txt` で `Disallow` したパスは、クロールされないので `<meta name="robots">` も
 * 読まれない。** つまり `noindex` を付けた画面を `Disallow` すると、**すでに索引に載って
 * いるものはかえって消えなくなる。**
 *
 * したがって役割を分ける。
 *
 * - **`noindex`（`src/html.ts` の `siteHead`）**: 索引に載せたくない画面。本人だけの画面・
 *   確認画面・検索結果・エラー。**ここでは `Disallow` しない**（読みに来てもらって
 *   `noindex` を読ませる）
 * - **`Disallow`（ここ）**: そもそも読みに来る意味が無い口。機械が読む応答（`/api/`）と、
 *   ログインしなければ何も返らない操作の口
 *
 * # 用途で分ける。事業者単位で弾かない
 *
 * **主要な事業者は用途ごとに別のクローラを持つ。** OpenAI は `GPTBot`（学習）と
 * `OAI-SearchBot` / `ChatGPT-User`（検索・回答）、Anthropic は `ClaudeBot`（学習）と
 * `Claude-SearchBot` / `Claude-User`、Google は `Google-Extended`（学習）と
 * `Googlebot`（検索）で、**用途が違う。**
 *
 * 利用者の決定（2026-09-16 / #594）は「**学習は拒む。検索と、AI の回答への引用は許す**」
 * なので、**事業者の名前でまとめて弾くと、許すと決めたものを自分で塞ぐ。**
 * {@link AI_TRAINING_CRAWLERS} に並べるのは、**用途が学習であると事業者自身が説明している
 * クローラだけ**である。
 *
 * # 強制力は無い
 *
 * `robots.txt` はクローラ側が読んで自主的に従うものである。**従わないクローラは素通りする。**
 * 通信の入口で実際に遮断する手段（Cloudflare の WAF / Bot Fight Mode / AI Crawler Control）は
 * **このプロジェクトでは使えない**——確定17 で `game-forge.ojos.jp` を Route53 へ委譲しており、
 * これらはいずれも Cloudflare のゾーンに紐づく機能である（`terraform/dns.tf`）。
 * **この限界は `/faq` にも書く**（`src/faq.ts` の `ai-training`）。
 */
import { ACCOUNT_PATH } from './account-paths.js';
import { LIKED_WORKS_PATH } from './liked-works-paths.js';
import { GENERATE_PAGE_PATH, INVITES_PATH } from './paths.js';
import type { Route } from './routes.js';
import { MY_WORKS_PATH } from './works-paths.js';

/** `robots.txt` の綴り。**3 ホストで同じ**（RFC 9309 が位置を定めている）。 */
export const ROBOTS_PATH = '/robots.txt';

/**
 * 機械が読む応答の接頭辞。**画面ではないので、読みに来る意味が無い。**
 *
 * `src/page-paths.ts` の `NON_PAGE_PREFIXES` と綴りが同じだが、**あちらから import しない。**
 * あちらは「画面の検査から外すもの」の一覧で、ここは「クローラへ近寄るなと言うもの」の一覧
 * である。**同じ綴りになっているのは今のところ偶然に近く、片方を変えたときにもう片方が
 * 黙って追随してよい関係ではない。**
 */
const API_PREFIX = '/api/';

/**
 * 認証の経路の接頭辞。
 *
 * `src/auth/google.ts` の 3 つの定数（`/auth/google/start` など）を個別に並べず、接頭辞で
 * まとめる。**経路が 1 本増えるたびに `robots.txt` へ 1 行足す形にしない。**
 */
const AUTH_PREFIX = '/auth/';

/**
 * app ホストで `Disallow` する綴り（**前方一致**）。
 *
 * **綴りを書き写さない。** 画面のパスは各機能の定数から import する——写すと、パスを変えた日に
 * `robots.txt` だけが古い綴りを言い続ける（`Disallow` が黙って何にも当たらない行になる）。
 * `test/robots.test.ts` が、ここに並ぶ綴りが**経路表に実在すること**を確かめる。
 *
 * **`/account` は 1 行で足りる**（前方一致なので `/account/handle` なども覆う）。
 *
 * **ここに `noindex` の画面を足さないこと**（モジュール冒頭「`robots.txt` と `noindex` を
 * 取り違えない」）。並ぶ資格があるのは、機械が読む口（`/api/`・`/auth/`）と、ログインしな
 * ければ何も返らない操作の口だけである。
 */
export const APP_DISALLOW_PATHS: readonly string[] = [
  API_PREFIX,
  AUTH_PREFIX,
  ACCOUNT_PATH,
  MY_WORKS_PATH,
  LIKED_WORKS_PATH,
  GENERATE_PAGE_PATH,
  INVITES_PATH,
];

/**
 * 学習用の AI クローラ（**全面拒否する相手**）。
 *
 * **用途が学習であると事業者自身が説明しているものだけを並べる**（モジュール冒頭
 * 「用途で分ける。事業者単位で弾かない」）。**検索用・回答用を混ぜないこと**——混ぜると、
 * 利用者が許すと決めた `ai-input` を自分で塞ぐ。
 *
 * | クローラ | 事業者 | 用途 |
 * |---|---|---|
 * | `GPTBot` | OpenAI | 学習 |
 * | `ClaudeBot` | Anthropic | 学習 |
 * | `anthropic-ai` | Anthropic | 学習（古い綴り。名乗り続けるものがあるので残す） |
 * | `CCBot` | Common Crawl | 学習データセットの収集 |
 * | `Google-Extended` | Google | 学習（`Googlebot` とは別。検索には影響しない） |
 * | `Applebot-Extended` | Apple | 学習（`Applebot` とは別） |
 * | `meta-externalagent` | Meta | 学習 |
 * | `Bytespider` | ByteDance | 学習 |
 *
 * **一覧は必ず古くなる。** 新しい学習クローラが現れたらここへ足す。**逆に、ここに無い
 * 相手は素通りする**——だから {@link CONTENT_SIGNAL} を併せて出す（名指しできない相手にも
 * 用途の意思表示は届く）。
 */
export const AI_TRAINING_CRAWLERS: readonly string[] = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'meta-externalagent',
  'Bytespider',
];

/**
 * 用途ごとの意思表示（Content Signals）。
 *
 * **3 つの用途を分けて言える**ので、`User-agent` 別の `Disallow` では表せないことが表せる
 * ——「学習は拒むが、AI の回答に引用されるのは構わない」（利用者の決定。2026-09-16 / #594）。
 *
 * | signal | 意味 | 値 |
 * |---|---|---|
 * | `search` | 検索の索引に載せてよいか | `yes` |
 * | `ai-input` | AI が回答を作るために取得・引用してよいか | `yes` |
 * | `ai-train` | AI の学習データに使ってよいか | **`no`** |
 *
 * **これは標準ではない。** Cloudflare が 2025-09-24 に公開した記法で、IETF の AIPREF で
 * 標準化が進行中（マイルストーンは 2026-08）である。**記法が将来変わりうる**ので、
 * 変わったらここを直す。値の意味（上の表）は変わらない。
 */
export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=no';

/**
 * `X-Robots-Tag` の見出しと値。
 *
 * **HTML 以外の応答に索引拒否を伝える唯一の手段である。** `<meta name="robots">` は HTML の
 * 中にしか書けないので、画像（OGP・アイコン）と、**サンドボックスが配る生成済みの作品**には
 * 使えない——作品の HTML は AI が書いたものをそのまま配るので、こちらから `<meta>` を
 * 差し込む余地が無い。
 *
 * **`robots.txt` の `Disallow` とは別に要る。** あちらは「読みに来るな」で、こちらは
 * 「読んだとしても索引に載せるな」である。従わないクローラが読んでしまった場合に、
 * 残る 2 つ目の意思表示になる。
 */
export const ROBOTS_TAG_HEADER = 'x-robots-tag';

/** {@link ROBOTS_TAG_HEADER} の値（索引に載せない）。 */
export const ROBOTS_TAG_NOINDEX = 'noindex';

/**
 * `robots.txt` の応答を組み立てる。
 *
 * **`no-store` にしない。** クローラは `robots.txt` を繰り返し取りに来るもので、内容は
 * 配備するまで変わらない。1 時間は聞き直させる必要が無い（`src/ogp.ts` の画像と同じ考え方）。
 *
 * @param body `robots.txt` の中身
 * @returns レスポンス
 */
export function robotsResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

/**
 * app ホストの `robots.txt` を組み立てる。
 *
 * **並びに意味がある。** `User-agent: *` のグループを先に置き、そのあとに学習クローラの
 * グループを並べる。**クローラは自分に最も一致するグループ 1 つにだけ従う**ので、
 * `GPTBot` は `*` のグループを読まない（だからこそ、そちらは `Disallow: /` で足りる）。
 *
 * @returns `robots.txt` の中身
 */
export function renderAppRobotsTxt(): string {
  const disallow = APP_DISALLOW_PATHS.map((path) => `Disallow: ${path}`).join('\n');
  const training = AI_TRAINING_CRAWLERS.map((agent) => `User-agent: ${agent}\nDisallow: /`).join('\n\n');
  return `# Game Forge
#
# 公開している作品・作者・一覧は、検索の索引に載せてかまいません。
# AI の学習には使わないでください（下の Content-Signal と、学習用クローラの拒否）。
#
# Content-Signal は Cloudflare が 2025-09-24 に公開した記法で、IETF の AIPREF で
# 標準化が進行中です。記法が変わったら追随します（src/robots.ts）。

User-agent: *
Content-Signal: ${CONTENT_SIGNAL}
${disallow}

# ここから下は、事業者自身が「学習のためのクローラ」と説明しているものです。
# 検索用・回答用のクローラ（Googlebot / Bingbot / OAI-SearchBot / ChatGPT-User /
# Claude-SearchBot / Claude-User / PerplexityBot など）は拒否していません。

${training}
`;
}

/**
 * 全面拒否の `robots.txt` を組み立てる（sandbox / admin）。
 *
 * **理由を書いたコメントを先頭に置く。** 2 つのホストで中身が同じになると、次に読む人が
 * 「どちらかの写しでは」と疑う。**なぜ全面拒否なのかはホストごとに違う**ので、そこだけを
 * 引数で受ける。
 *
 * @param reason 先頭へ置く理由（`#` は呼び出し側で付けない）
 * @returns `robots.txt` の中身
 */
export function renderDisallowAllRobotsTxt(reason: string): string {
  return `# ${reason}

User-agent: *
Disallow: /
`;
}

/** app ホストの `robots.txt` の経路。**ログインを要求しない。** */
export const appRobotsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: ROBOTS_PATH,
    handler: () => robotsResponse(renderAppRobotsTxt()),
  },
];

/**
 * 管理画面ホストの `robots.txt` の経路。
 *
 * **未ログインで通す必要がある**（`src/admin/routes.ts` の `ADMIN_OPEN_ROUTES`）。クローラは
 * ログインしない。守りの既定が「閉」なので、ここへ登録するだけでは 404 のままである。
 */
export const adminRobotsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: ROBOTS_PATH,
    handler: () =>
      robotsResponse(renderDisallowAllRobotsTxt('運営の管理画面。検索結果に出てよいものではありません（2.4）。')),
  },
];

/**
 * サンドボックス用ホストの `robots.txt` の応答。
 *
 * **経路表ではなく関数である。** あちらは経路表を持たず、パスの接頭辞で振り分ける
 * （`src/sandbox.ts`）。
 *
 * @returns レスポンス
 */
export function sandboxRobotsResponse(): Response {
  return robotsResponse(
    renderDisallowAllRobotsTxt(
      '作品の実体を配るホストです。共有と検索の着地点は作品ページ（app 側）なので、ここは索引に載せません（仕様 5.4）。',
    ),
  );
}
