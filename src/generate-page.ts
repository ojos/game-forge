/**
 * 生成画面（5.2-1 / 4.4 / 7.2 / 8.3 / #128）。
 *
 * 5.2-1 は「招待コード保有ユーザーが自然文プロンプトを入力」と定めるが、その入力を
 * 受け取る画面が無かった。`/api/generate` は本番で開通済み（3.3 の全段が実装済み）で、
 * 公開トップは「生成機能はまだ公開していません」と出したままだった。**このモジュールが
 * 足すのは、その API を人が呼べる 1 枚**である。API そのものは `src/generate.ts` が持ち、
 * ここからは**読むだけ**である（パスとプロンプト長の上限を import する）。
 *
 * ## 生成物をここで描かない（7.2）
 *
 * 7.2 は「ユーザー生成コンテンツは必ず親と別オリジンから配信する」と定める。したがって
 * この画面は**成果物を一切描画しない。** 成功時に出すのは「下書きとして保存された」こと
 * だけで、作者プレビューの配信は #27 が別オリジン側に作る。
 *
 * ## 応答本文の文字列を表示面へ持ち込まない（8.3）
 *
 * 8.3 の検査（生成コード内の文字列リテラルの NG ワード検査）は**まだ実装されていない**。
 * そして `/api/generate` の失敗応答には、生成物に由来する値が載る（422 の `imports` は
 * 許可外の import パスそのもので、`src/source-inspection.ts` が件数と長さに上限を掛けて
 * いるのはそのためである）。上限は「ログと応答に載せてよい量」を決めるものであって、
 * **画面に出してよいと決めたわけではない。**
 *
 * そこで、この画面は**構造として持ち込みを塞ぐ。**
 *
 * - 文言は**すべてサーバ側で固定文字列として描き**、`hidden` 属性で隠しておく。
 * - 埋め込みスクリプトがするのは **`hidden` の付け外しだけ**で、文字列を DOM へ
 *   書き込む経路を持たない（唯一の例外は経過秒数で、値は数値から作る）。
 * - 応答本文から読むのは `error`（分類名）**1 つだけ**で、しかも**表を引く鍵**に
 *   しか使わない。表に無ければ既定の文言へ倒す（`src/signup.ts` の `REASON_MESSAGES`
 *   と同じ方針）。
 *
 * **「文字列を入れないように気をつける」で担保しない**（shared-ai-rules 12 章）。
 * 書き込む経路が無いことを `test/generate-page.test.ts` が変異させて確かめる。
 *
 * ## JavaScript を要求する（この画面だけ）
 *
 * `src/signup.ts` と `src/invite-issuance.ts` は素の `<form method="post">` で動く。
 * **この画面はそうできない。** `/api/generate` は `application/json` しか受け付けず
 * （`src/generate.ts` の `JSON_MEDIA_TYPE`）、応答も JSON である。素のフォームで
 * 送ると `Content-Type` 違いで 400 になり、ブラウザは JSON を生のまま表示する。
 * 受け口を広げるには `src/generate.ts` を触ることになるが、**API の受け口を画面の
 * 都合で広げない**（費用の出る経路であり、曖昧な入力を推測で受け取らない、という
 * あちらの判断を崩す）。
 *
 * あわせて、**待ち時間の提示そのものが JavaScript を要る**。素のフォーム送信では
 * ブラウザのタブが 20〜30 秒回るだけで、こちらから経過を出す手段が無い。
 *
 * ## 待ち時間（1.2.27 / 3.8）
 *
 * 生成〜ビルドは**実測 20〜30 秒**かかる。1.2.27 のとおり Cloudflare 側に待ち時間の
 * 上限は無く、非同期化（Queues / Workflows）は採らない判断が #19 で済んでいる。
 * **残るのはブラウザ側と利用者の体感**なので、この画面は送信直後に
 *
 * - 生成中であること
 * - 経過秒数（1 秒ごとに更新する）
 * - 通常かかる時間（20〜30 秒）
 *
 * を出す。**作り込みは #30 の範囲**で、ここが持つのは「待っている間に何も出ない」を
 * 塞ぐ最小限である。
 *
 * ## 残枠の表示（4.4 / #24）は乗せない。差し込み口だけを持つ
 *
 * 4.4 は「本日の残り生成枠 N回」の常時表示を求めるが、値を作る経路（D1 から当日の
 * 呼び出し回数を引く）は #24 が持つ。**作らないことと、作れないようにすることは違う**
 * ので、{@link GeneratePageView.quotaNotice} を口として置き、この issue では常に
 * `null` を渡す。#24 はここへ値を渡すだけでよい。
 */
import { LOGIN_PATH } from './auth/google.js';
import { GENERATE_PATH, MAX_PROMPT_LENGTH } from './generate.js';
import { HOME_PATH } from './home.js';
import { GENERATE_PAGE_PATH, SIGNUP_PATH } from './paths.js';
import type { Route, RouteHandler } from './routes.js';
import { html } from './routes.js';
import { resolveSessionUser } from './session-user.js';
import { escapeHtml } from './signup.js';

/**
 * 文言を選ぶ鍵が 1 つも当たらなかったときに使う鍵。
 *
 * 空文字にしてあるのは、鍵が `"<ステータス>:<分類>"` の形だからである。既定は
 * 「ステータスも分類も指定しない」ものとして、同じ表に同居させる。
 */
export const DEFAULT_MESSAGE_KEY = '';

/**
 * 応答そのものが返らなかったとき（通信断・ブラウザ側のタイムアウト）の鍵。
 *
 * ステータスが無い状態なので、`"<ステータス>:<分類>"` の形とは別の鍵にする。
 */
export const NETWORK_MESSAGE_KEY = 'network';

/**
 * 画面に出す文言の対応表。**鍵は `"<HTTP ステータス>:<応答の error>"`。**
 *
 * `src/signup.ts` の `REASON_MESSAGES` と同じ方針で、**応答の値を画面へそのまま
 * 流さない。** ここに載っている固定文字列だけが画面に出る（モジュール冒頭 8.3）。
 *
 * **4.4 の停止時の文言は、仕様書の言い回しをそのまま使う。** 429 は日次と月次の
 * どちらでも返るため（下記）、両方の言い回しを 1 つの文言に含める。一致は
 * `test/generate-page.test.ts` が仕様書本文から拾って機械照合する
 * （shared-ai-rules 12 章）。
 *
 * **429 が日次か月次かを、この画面は知りようがない。** `/api/generate` は
 * `QuotaExceeded` を一律 `{"error":"quota exceeded"}` で返し、`src/quota.ts` が
 * 持つ区別（`daily-quota` / `monthly-limit`）は応答に出ない。**出し分けは #24 の
 * 範囲**であり、そのときは応答か残枠の取得経路のどちらかが区別を持つ必要がある。
 * いまは「どちらであっても正しい」文言にしてある。
 *
 * **422 は 2 種類ある。** 許可外 import（5.2-5 / `source-rejected`）と、リトライを
 * 使い切ったコンパイル失敗（5.2-7 / `build-failed`）で、利用者から見て起きたことも
 * 消費した枠の数も違う。分類名で出し分ける。
 *
 * **500 には degrade（3.8）を含める。** ビルド関数の失敗・スロットリング・
 * タイムアウトは `BuildRejected` ではないため経路層の既定の catch に落ち、
 * `{"error":"internal error"}` の 500 になる。3.8 は「停止時は生成 UI に
 * 『生成停止中』を表示し、プレイ側には一切影響を出さない」と定めるので、
 * プレイと共有が生きていることをここで言う。
 */
export const GENERATE_MESSAGES: Readonly<Record<string, string>> = {
  '202:':
    '生成しました。作品は下書き（draft）として保存されています。' +
    '試遊と公開の画面は準備中のため、この画面からはまだ開けません。',
  '400:':
    `送信した内容を受け付けられませんでした。プロンプトの長さ（最大 ${MAX_PROMPT_LENGTH} 文字）を` +
    '確かめて、もう一度お試しください。',
  '401:': 'ログインが確認できませんでした。もう一度ログインしてからお試しください。',
  '422:source-rejected':
    '生成されたコードが安全性の検査に通りませんでした（許可していないパッケージが使われています）。' +
    'この試行ぶんの生成枠は消費されています。プロンプトを変えてお試しください。',
  '422:build-failed':
    '生成されたコードがコンパイルできませんでした。自動でやり直しましたが通らなかったため、' +
    '試行した回数ぶんの生成枠を消費しています。プロンプトを変えてお試しください。',
  '422:':
    '生成されたものを受け付けられませんでした。この試行ぶんの生成枠は消費されています。' +
    'プロンプトを変えてお試しください。',
  '429:':
    '生成枠を使い切りました。本日の枠は終了しました（枠は翌日 0 時・日本時間に戻ります）。' +
    '月次の上限に達している場合は、今月の生成は終了しました。プレイと共有は引き続きご利用いただけます。',
  '500:':
    '生成に失敗しました。ビルドの経路が停止している可能性があります。' +
    '時間をおいてお試しください。すでにある作品のプレイと共有には影響ありません。',
  '501:': '生成機能の一部がまだ有効になっていません。時間をおいてお試しください。',
  [NETWORK_MESSAGE_KEY]:
    '応答を受け取れませんでした。生成そのものは続いている可能性があり、その場合は生成枠を消費しています。' +
    '時間をおいて確かめてください。',
  [DEFAULT_MESSAGE_KEY]: '生成に失敗しました。時間をおいてお試しください。',
};

/**
 * 応答から文言の鍵の候補を、**選ぶ順**に並べる。
 *
 * 埋め込みスクリプトも同じ順で引く（{@link CANDIDATE_KEYS_EXPRESSION}）。細かい分類が
 * あればそれを、無ければステータスだけの文言を、それも無ければ既定を選ぶ。
 *
 * @param status HTTP ステータス
 * @param errorCode 応答本文の `error`（無ければ空文字）
 * @returns 鍵の候補（優先順）
 */
export function generateMessageKeyCandidates(status: number, errorCode: string): readonly string[] {
  return [`${status}:${errorCode}`, `${status}:`, DEFAULT_MESSAGE_KEY];
}

/**
 * 応答に対して画面へ出す文言の鍵を選ぶ。
 *
 * **戻すのは鍵であって、応答から来た文字列ではない。** `errorCode` に何が入っていても
 * （生成物由来の文字列、Go の診断、HTML の断片）、戻り値は必ず
 * {@link GENERATE_MESSAGES} の鍵のどれかになる。これがこの画面の 8.3 に対する保証で、
 * `test/generate-page.test.ts` が敵対的な入力で確かめる。
 *
 * @param status HTTP ステータス
 * @param errorCode 応答本文の `error`（無ければ空文字）
 * @returns {@link GENERATE_MESSAGES} に存在する鍵
 */
export function selectGenerateMessageKey(status: number, errorCode: string): string {
  for (const candidate of generateMessageKeyCandidates(status, errorCode)) {
    // 表に無い鍵は選ばない。`hasOwnProperty` で見るのは、`__proto__` のような
    // 名前が分類として送られてきたときに、継承した値を拾わないためである。
    if (Object.prototype.hasOwnProperty.call(GENERATE_MESSAGES, candidate)) {
      return candidate;
    }
  }
  return DEFAULT_MESSAGE_KEY;
}

/**
 * 画面へ渡す値。
 *
 * **いまは 1 つしか無いが、口としてまとめておく。** #24（残枠と停止状態）と #30
 * （ロード中画面）がここへ足すことになる。引数を増やすたびに呼び出し側の並びが
 * 変わる形にすると、足す側が既存の呼び出しを壊す。
 */
export interface GeneratePageView {
  /**
   * 4.4 の「本日の残り生成枠 N回」と停止状態の表示（#24）。
   *
   * **この issue では常に `null`。** 値を作る経路（D1 から当日の呼び出し回数を引く）は
   * #24 が持つ。文字列を受けるのは、日次と月次と停止状態で出す内容が変わるためで、
   * ここで構造を決めると #24 がそれに縛られる。
   *
   * **渡された値は `escapeHtml` を通す。** いまは固定文字列しか来ない想定でも、
   * 値の出どころが変わったときに安全側が既定になるようにしておく
   * （`src/signup.ts` / `src/invite-issuance.ts` と同じ理由）。
   */
  readonly quotaNotice: string | null;
}

/**
 * 埋め込みスクリプトが鍵の候補を作る式。
 *
 * {@link generateMessageKeyCandidates} と**同じ順序**である必要がある。順序が
 * ずれると、細かい分類のある応答に既定の文言が出る（壊れはしないが、利用者に
 * 出る説明が粗くなる）。同じものが 2 か所にある以上、定数として切り出して
 * `test/generate-page.test.ts` が照合する（shared-ai-rules 12 章）。
 */
export const CANDIDATE_KEYS_EXPRESSION = "[status + ':' + code, status + ':', '']";

/**
 * 送信と待ち時間の提示を行う埋め込みスクリプト。
 *
 * **文字列を DOM へ書き込まない。** できるのは
 *
 * 1. `hidden` を付け外しして、サーバが描いた固定の文言を 1 つだけ見せる
 * 2. 経過秒数（数値から作った文字列）を書く
 *
 * の 2 つだけである。応答本文から読むのは `error` だけで、それも
 * {@link CANDIDATE_KEYS_EXPRESSION} の鍵に混ぜるだけで表示しない（モジュール冒頭 8.3）。
 *
 * **`innerHTML` を使わない。** `textContent` すら、経過秒数以外では使わない。
 * この 2 つを `test/generate-page.test.ts` が変異させて確かめる。
 *
 * 素朴な書き方（`var` と関数式）に寄せているのは、この 1 枚がビルド工程を通らず
 * そのままブラウザへ届くためである（9.3 の Next.js / Pages への寄せ方は M2-1 が持つ）。
 */
const GENERATE_SCRIPT = `
(function () {
  var form = document.getElementById('generate-form');
  if (form === null) { return; }
  var field = document.getElementById('generate-prompt');
  var button = document.getElementById('generate-submit');
  var progress = document.getElementById('generate-progress');
  var elapsed = document.getElementById('generate-elapsed');
  var messages = document.querySelectorAll('[data-message-key]');
  var ticking = null;

  /** 鍵の候補のうち、実際に描かれている最初の 1 つを選ぶ。 */
  function pick(candidates) {
    for (var c = 0; c < candidates.length; c += 1) {
      for (var m = 0; m < messages.length; m += 1) {
        if (messages[m].getAttribute('data-message-key') === candidates[c]) {
          return candidates[c];
        }
      }
    }
    return '';
  }

  /** 選んだ鍵の文言だけを見せる。文言そのものはサーバが描いたものである。 */
  function show(candidates) {
    var chosen = candidates.length === 0 ? null : pick(candidates);
    for (var m = 0; m < messages.length; m += 1) {
      messages[m].hidden = messages[m].getAttribute('data-message-key') !== chosen;
    }
  }

  /** 待ち時間の提示を始める（20〜30 秒かかるため、無反応の時間を作らない）。 */
  function startWaiting() {
    var startedAt = Date.now();
    elapsed.textContent = '0';
    progress.hidden = false;
    ticking = setInterval(function () {
      elapsed.textContent = String(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
  }

  /** 待ち時間の提示を終える。 */
  function stopWaiting() {
    if (ticking !== null) { clearInterval(ticking); ticking = null; }
    progress.hidden = true;
    button.disabled = false;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (button.disabled) { return; }
    button.disabled = true;
    show([]);
    startWaiting();
    fetch(${JSON.stringify(GENERATE_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: field.value }),
      credentials: 'same-origin'
    }).then(function (response) {
      var status = response.status;
      return response.json().then(function (body) {
        // **読むのは分類名だけ。** 応答本文の他の項目（生成物由来の import パスや
        // 理由）はここで一切触らない（8.3）。
        var code = body !== null && typeof body === 'object' && typeof body.error === 'string'
          ? body.error
          : '';
        return { status: status, code: code };
      }, function () {
        return { status: status, code: '' };
      });
    }).then(function (outcome) {
      var status = outcome.status;
      var code = outcome.code;
      show(${CANDIDATE_KEYS_EXPRESSION});
    }, function () {
      show([${JSON.stringify(NETWORK_MESSAGE_KEY)}]);
    }).then(stopWaiting, stopWaiting);
  });

  // ここで初めてボタンを押せるようにする。HTML 側は disabled で描いてあり、
  // スクリプトが動かない環境では押せないままになる。素のフォーム送信は
  // 生成 API に届かない（JSON しか受け付けない）ので、押しても必ず断られる
  // ボタンを出さない。
  button.disabled = false;
})();
`;

/**
 * 未ログイン・未招待の導線を組み立てる（8.1）。
 *
 * **401 の JSON を返さない。** これは画面であり、未ログインで開かれることは異常では
 * ない（公開トップからここへのリンクがある）。利用者にできるのは登録かログインなので、
 * そこまでを 1 往復で出す。
 *
 * **待機リストへの導線も `/signup` が持つ。** 8.1 は「未招待ユーザーが『改造する』を
 * 押した場合は待機リスト登録へ導線を変換する」と定めており、その受け皿は既に
 * `src/signup.ts` にある。ここで別の入口を作らない。
 *
 * @returns HTML
 */
function signedOutSection(): string {
  return `<h2>生成には招待コードでの登録が必要です</h2>
<p><strong>生成は招待コードをお持ちの方に限ります</strong>（8.1）。遊ぶことと URL の共有に招待は要りません。</p>
<ul>
  <li><a href="${SIGNUP_PATH}">招待コードで登録する</a></li>
  <li><a href="${SIGNUP_PATH}">招待コードをお持ちでない方（待機リストに登録する）</a></li>
  <li><a href="${LOGIN_PATH}">すでにアカウントをお持ちの方（Google でログイン）</a></li>
</ul>`;
}

/**
 * プロンプトの入力フォームと、結果を出す領域を組み立てる。
 *
 * **文言はすべてここで描き、`hidden` で隠しておく**（モジュール冒頭 8.3）。
 * スクリプトは `hidden` を外すだけで、文字列を作らない。
 *
 * `maxlength` は `src/generate.ts` の `MAX_PROMPT_LENGTH` から取る。書き写すと、
 * あちらを見直したときに画面だけが古い上限で切ることになる。
 *
 * @param view 画面へ渡す値
 * @returns HTML
 */
function signedInSection(view: GeneratePageView): string {
  // #24 の差し込み口。値は渡された文字列で、必ず `escapeHtml` を通す。
  const quota =
    view.quotaNotice === null
      ? ''
      : `<p id="generate-quota">${escapeHtml(view.quotaNotice)}</p>\n`;

  const messages = Object.entries(GENERATE_MESSAGES)
    .map(
      ([key, message]) =>
        `  <p class="generate-message" data-message-key="${escapeHtml(key)}" hidden>${escapeHtml(message)}</p>`,
    )
    .join('\n');

  return `${quota}<form id="generate-form" method="post" action="${GENERATE_PATH}">
  <label for="generate-prompt">どんなゲームを作りますか（日本語で、${MAX_PROMPT_LENGTH} 文字まで）</label>
  <textarea id="generate-prompt" name="prompt" rows="4" maxlength="${MAX_PROMPT_LENGTH}"
            placeholder="例: 左右キーで動く自機が、上から落ちてくるブロックをよけ続けるゲーム" required></textarea>
  <button id="generate-submit" type="submit" disabled>生成する</button>
</form>

<p id="generate-progress" role="status" aria-live="polite" hidden>生成しています…（経過 <span id="generate-elapsed">0</span> 秒）。
   <strong>通常 20〜30 秒かかります。</strong>この画面を閉じたり再読み込みしたりしないでください。</p>

<div id="generate-messages" role="status" aria-live="polite">
${messages}
</div>

<noscript>
  <p><strong>生成の送信には JavaScript が必要です。</strong>
     生成は JSON で受け付ける API（<code>${GENERATE_PATH}</code>）への送信で、
     応答が返るまで 20〜30 秒かかります。その間の経過表示も JavaScript で行っています。</p>
</noscript>`;
}

/**
 * 生成画面の HTML を組み立てる。
 *
 * **成果物をここで描かない**（7.2）。成功時に出すのは「下書きとして保存された」ことだけで、
 * 生成物の配信はサンドボックス側のオリジンが持つ。
 *
 * @param signedIn ログイン済みか
 * @param view 画面へ渡す値
 * @returns HTML
 */
export function renderGeneratePage(signedIn: boolean, view: GeneratePageView): string {
  const body = signedIn ? signedInSection(view) : signedOutSection();
  // スクリプトはログイン済みのときだけ置く。未ログインの画面にはフォームが無く、
  // 動かす対象が無い。
  const script = signedIn ? `\n<script>${GENERATE_SCRIPT}</script>\n` : '';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ゲームを生成する</title>
<h1>ゲームを生成する</h1>
<p>作りたいゲームを 1 行で書くと、ブラウザで遊べる 2D ゲームの下書きができます。
   <strong>生成には 20〜30 秒かかります。</strong></p>

${body}

<p><a href="${HOME_PATH}">トップへ戻る</a></p>${script}`;
}

/**
 * 生成画面を返す。
 *
 * ログインの判定は `resolveSessionUser` に寄せる（署名だけを信じず、BAN と利用者の
 * 不在まで見る。`src/session-user.ts`）。**画面側で別の判定を書かない。**
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const showGeneratePage: RouteHandler = async (request, env) => {
  const session = await resolveSessionUser(request, env);
  // 4.4 の残枠は #24 が入れる。ここでは口だけを通す（モジュール冒頭）。
  return html(renderGeneratePage(session.ok, { quotaNotice: null }));
};

/**
 * 生成画面の経路。
 *
 * `src/app.ts` の経路表へ連結する。**API（`POST /api/generate`）はここに足さない。**
 * あちらは `src/generate.ts` が持ち、画面と API を別のモジュールに置くのは
 * `src/invite-issuance.ts` が `INVITES_PATH` と `INVITES_API_PATH` を分けているのと
 * 同じ理由である（HTML を返す経路と JSON を返す経路を同じパスに同居させない）。
 */
export const generatePageRoutes: readonly Route[] = [
  { method: 'GET', path: GENERATE_PAGE_PATH, handler: showGeneratePage },
];
