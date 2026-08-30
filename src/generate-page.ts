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
 * ブラウザのタブが 1 分以上回るだけで、こちらから経過を出す手段が無い。
 *
 * ## 待ち時間（1.2.27 / 3.8）
 *
 * **本番で 1 回通した実測は、リクエスト全体で 90.9 秒である**（2026-08-28。うちビルドが
 * 21.6 秒で、残りは生成側）。#128 の時点でこの画面は「20〜30 秒」と書いていたが、
 * **その数字はビルド単体の実測**（3.8 の 21.1 秒 / 23.7 秒）であり、生成側を含む
 * 待ち時間ではなかった。1.2.27 のとおり Cloudflare 側に待ち時間の上限は無く、
 * 非同期化（Queues / Workflows）は採らない判断が #19 で済んでいる。
 *
 * **送信してから 90 秒、画面が何も言わない状態は「押しても動かないボタン」と同じ問題**
 * なので、この画面は送信直後に
 *
 * - 生成中であること
 * - 経過秒数（1 秒ごとに更新する）
 * - 通常かかる時間（{@link TYPICAL_WAIT_TEXT}）
 * - {@link LONG_WAIT_SECONDS} 秒を過ぎたら「まだ待っている」こと
 *
 * を出す。**作り込みは #30 の範囲**で、ここが持つのは「待っている間に何も出ない」を
 * 塞ぐ最小限である。**実測は n=1 なので、幅を持たせた言い方に留める。**
 *
 * ## 残枠と停止状態を常時出す（4.4 / #24）
 *
 * 4.4 は「本日の残り生成枠 N回」の**常時表示**と、日次・月次それぞれの停止時の文言を
 * 求める。値は `src/quota.ts` の {@link generationQuotaStatus} から取る。**画面が
 * D1 を数え直さない**（同じ「当日とは何か」が 2 か所になり、画面の残数と API の判断が
 * 割れる。shared-ai-rules 12 章）。
 *
 * **1 表示ぶんの D1 読み取りが増える**（月次の集計と、当日の呼び出し回数で 2 回）。
 * `src/home.ts` が「トップに件数を出さない」としたのと逆の判断だが、**ここは 4.4 が
 * 常時表示を要求している画面**であり、開くのはログイン済みの利用者だけである。
 *
 * ## 止まっているときはフォームを描かない
 *
 * #24 の goal は「押しても動かないボタンを無くす」ことである。枠が尽きているとき、
 * 送信ボタンを描いて押させると、返るのは必ず 429 になる。**描くのは状態の説明と、
 * 続けられること（プレイと共有）への導線だけ**にする。
 *
 * ## degrade（3.8）は「ビルド依頼の失敗」で発火する
 *
 * 3.8 は「停止時は生成 UI に『生成停止中』を表示し、プレイ側には一切影響を出さない」と
 * 定める。**発火条件は確定24 で「VPS の死活監視」から「ビルド依頼の失敗」へ変わった。**
 * この画面が観測できるのは自分が投げた要求の結果だけなので、**5xx が返った時点で
 * 生成停止中を出し、ボタンを戻さない**（{@link GENERATE_SCRIPT}）。
 *
 * **#24 の時点でこれは近似だった。** 5xx には D1 の不調（`src/quota.ts` の
 * `readForDecision`）も落ちてくるし、逆に「他の利用者のビルドが軒並み失敗している」
 * ことはこの画面からは見えない。
 *
 * **#140 で信号がサーバ側に置かれた**（`src/build-health.ts` /
 * `migrations/0010_build_health.sql`）。ビルド依頼そのものが失敗した依頼を数え、
 * 窓と閾値で停止を判定する。**画面はそれを読んで、開いた時点で停止していれば
 * 送信フォームを描かない**（{@link canSubmit}）。
 *
 * **5xx を見る近似は残してある。** 2 つは見ているものが違う。
 *
 * | | 見えるもの | 反応 |
 * |---|---|---|
 * | サーバ側の信号（#140） | **他人の依頼を含む**、ビルド依頼の失敗 | 画面を開いた時点で、フォームを描かない |
 * | 埋め込みスクリプトの 5xx（#24） | **自分の要求**がサーバ側の事情で落ちたこと | その場でボタンを戻さない |
 *
 * **後者を落とさない**のは、開いたあとに起きた停止を前者が拾えないためである
 * （画面は 1 回読むだけで、再読み込みまで更新されない）。ただし後者は 5xx なら何でも
 * 反応する近似のままなので、**サービス全体の状態を決めるのは前者だけ**にしてある。
 */
import { LOGIN_PATH } from './auth/google.js';
import { GENERATE_PATH, MAX_PROMPT_LENGTH } from './generate.js';
// 遷移先の綴りの正本は作品ページ側が持つ（`src/work-page.ts`）。ここで書き写さない。
import { WORK_PAGE_PREFIX } from './work-page.js';
import {
  DAILY_QUOTA_REASON,
  MONTHLY_LIMIT_REASON,
  QUOTA_EXCEEDED_STATUS,
  generationQuotaStatus,
  QUOTA_UNKNOWN_NOTICE,
  remainingQuotaNotice,
} from './quota.js';
import { HOME_PATH } from './home.js';
import { buildPathStopped } from './build-health.js';
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
 * 日次クォータで止まったときの文言の鍵。
 *
 * **分類名を書き写さない。** 正本は `src/quota.ts` で、応答の `error` に載るのも
 * 同じ値である（`describeQuotaRejection`）。
 */
export const DAILY_QUOTA_MESSAGE_KEY = `${QUOTA_EXCEEDED_STATUS}:${DAILY_QUOTA_REASON}`;

/** 月次上限で止まったときの文言の鍵（{@link DAILY_QUOTA_MESSAGE_KEY} と同じ作り）。 */
export const MONTHLY_LIMIT_MESSAGE_KEY = `${QUOTA_EXCEEDED_STATUS}:${MONTHLY_LIMIT_REASON}`;

/** 分類を持たない 429 へ倒す鍵（ステータスだけの項目）。 */
export const UNCLASSIFIED_QUOTA_MESSAGE_KEY = `${QUOTA_EXCEEDED_STATUS}:`;

/**
 * 画面に出す文言の対応表。**鍵は `"<HTTP ステータス>:<応答の error>"`。**
 *
 * `src/signup.ts` の `REASON_MESSAGES` と同じ方針で、**応答の値を画面へそのまま
 * 流さない。** ここに載っている固定文字列だけが画面に出る（モジュール冒頭 8.3）。
 *
 * **4.4 の停止時の文言は、仕様書の言い回しをそのまま使う。** 4.4 は日次と月次に
 * **別々のメッセージ**を求めるので、**鍵も文言も分ける**（`429:daily-quota` /
 * `429:monthly-limit`）。一致は `test/generate-page.test.ts` が仕様書本文から拾って
 * 機械照合する（shared-ai-rules 12 章）。**分類ごとの網羅も同じ検査が見る**ので、
 * `src/quota.ts` へ理由を増やして文言を足し忘れると落ちる。
 *
 * **429 は日次と月次で別の文言を出す**（#132）。`/api/generate` が分類名
 * （`daily-quota` / `monthly-limit`。正本は `src/quota.ts`）を `error` に載せるように
 * なったので、**表の鍵がそのまま分かれる。** 4.4 は日次に「翌日の再開時刻」を、
 * 月次に「プレイと共有は継続できる」旨を求めており、**混ぜると片方が必ず誤りになる。**
 *
 * **`429:` の項目は残す。** 分類を持たない 429（段を差し替えた実装が知らない理由を
 * 返した場合。`src/quota.ts` の `UNCLASSIFIED_QUOTA_CODE`）へ倒す先で、**どちらの
 * 主張もしない文言**にしてある（「本日」とも「今月」とも言わない）。
 *
 * **再開時刻は固定文字列で描く。** 応答は `resetsAt`（UNIX 秒）を載せるが、**日次の枠が
 * 戻るのは常に JST の 0 時**（確定25 / `src/quota.ts` の `jstDayRange`）なので、
 * 画面に出す時刻は値によらず決まる。**スクリプトが応答から読むのは `error` の 1 つだけ**
 * という性質（下記 8.3）を、表示のために崩さない。
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
  [DAILY_QUOTA_MESSAGE_KEY]:
    '生成枠を使い切りました。本日の枠は終了しました。' +
    '枠は翌日 0 時（日本時間）に戻ります。',
  [MONTHLY_LIMIT_MESSAGE_KEY]:
    'サービス全体の月次上限に達しました。今月の生成は終了しました。' +
    'プレイと共有は引き続きご利用いただけます。',
  [UNCLASSIFIED_QUOTA_MESSAGE_KEY]:
    '生成の上限に達したため、いまは生成できません。' +
    'プレイと共有は引き続きご利用いただけます。',
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
 * 送信してから応答が返るまでに通常かかる時間の言い方（1.2.27）。
 *
 * **本番の実測は 90.9 秒（2026-08-28）だが、n=1 である。** 「約 91 秒」と書くと、
 * 次の 1 回が 2 分かかった時点で画面の説明が誤りになる。**幅で書く。**
 *
 * **#128 の「20〜30 秒」はビルド単体の実測**（3.8 の 21.1 秒 / 23.7 秒）で、生成側を
 * 含む待ち時間ではなかった。
 *
 * **この定数が文言の正本である。** 公開トップ（`src/home.ts`）も同じ文言を出すが、
 * あちらは**書き写し**である。`src/home.ts` からこの定数を import すると循環参照に
 * なるためで（あちらの `HOME_PATH` をこのモジュールが取っている）、理由と正本の所在は
 * `src/home.ts` 側にも書いてある。**一致は `test/generate-page.test.ts` の公開トップの
 * 検査が機械照合する**（shared-ai-rules 12 章）。ここを動かしてトップを直し忘れると、
 * その検査が落ちる。
 */
export const TYPICAL_WAIT_TEXT = '通常 1〜2 分かかります';

/**
 * 「まだ待っている」ことを追加で出すまでの秒数。
 *
 * 経過秒数は 1 秒ごとに動いているが、**動いている数字だけでは「これは正常なのか」に
 * 答えていない。** 実測（90.9 秒）の手前でもう一言出す。
 */
export const LONG_WAIT_SECONDS = 60;

/**
 * 4.4 の「本日の残り生成枠 N回」。**正本は `src/quota.ts` にある。**
 *
 * **ここから動かしたのは、作品ページ（`src/work-page.ts`）も同じ文言を出すためである**
 * （5.7 の推敲。#193）。あちらからこのモジュールを import すると循環参照になる
 * （このモジュールが `WORK_PAGE_PREFIX` を借りている）。**同じ状態に 2 つの文言を
 * 作らない**という本モジュールの方針（下の `availabilityNotice` の注記）を守るには、
 * 値を持っている側へ文言も置くのが正しい。
 *
 * 再輸出しているのは、`test/generate-page.test.ts` が 4.4 との照合をここで行って
 * いるためである。**照合の場所は動かさない。**
 */
export { remainingQuotaNotice, QUOTA_UNKNOWN_NOTICE };

/**
 * 3.8 の degrade で出す文言。**「生成停止中」は 3.8 の言い回しである。**
 *
 * 一致は `test/generate-page.test.ts` が仕様書 3.8 から拾って機械照合する
 * （shared-ai-rules 12 章）。
 *
 * **プレイ側に影響が無いことは {@link GENERATE_MESSAGES} の `500:` が言う。**
 * ここで重ねて言わないのは、2 つが同時に出るためである。
 */
export const BUILD_STOPPED_NOTICE =
  '生成停止中です（ビルドの経路が応答していません）。' +
  '再開したら、この画面を再読み込みするともう一度生成できます。';

/**
 * いま生成できるかどうか（4.4 / #24）。
 *
 * **文字列ではなく状態で受ける。** #128 は口を `string | null` で開けていたが、
 * 状態ごとに「フォームを描くか」「ボタンを出すか」まで変わるため、文言だけを渡す形では
 * 呼び出し側が同じ分岐をもう一度書くことになる。
 *
 * **分類名は `src/quota.ts` から取る**（`daily-quota` / `monthly-limit`）。書き写すと
 * {@link GENERATE_MESSAGES} の鍵と割れる。
 */
export type GenerateAvailability =
  /** 生成できる。4.4 の「本日の残り生成枠 N回」を出す。 */
  | { readonly kind: 'available'; readonly remaining: number }
  /** 日次の枠が尽きた（確定25）。翌日の再開時刻を出す。 */
  | { readonly kind: typeof DAILY_QUOTA_REASON }
  /** 月次上限（4.3）。プレイと共有は続けられることを出す。 */
  | { readonly kind: typeof MONTHLY_LIMIT_REASON }
  /**
   * 3.8 の degrade。**ビルド経路が止まっている**（#140 / 確定24）。
   *
   * **枠の話ではない。** この状態の利用者は枠を持っているが、投げても成果物が
   * 返らない（1 回あたり約 16〜19 円と日次枠 1 回が、成果物なしで消える）。
   * 判定の材料は `src/build-health.ts` が持つ。
   */
  | { readonly kind: 'build-stopped' }
  /** 枠の集計を読めなかった（D1 の不調）。{@link QUOTA_UNKNOWN_NOTICE}。 */
  | { readonly kind: 'unknown' };

/**
 * 画面へ渡す値。
 *
 * **口としてまとめておく。** #30（ロード中画面）がここへ足すことになる。引数を
 * 増やすたびに呼び出し側の並びが変わる形にすると、足す側が既存の呼び出しを壊す。
 */
export interface GeneratePageView {
  /** 4.4 の残枠と停止状態（#24）。 */
  readonly availability: GenerateAvailability;
}

/**
 * 状態に対応する、常時表示の文言を選ぶ（4.4）。
 *
 * **停止時の文言は {@link GENERATE_MESSAGES} と同じものを使う。** 4.4 の言い回しとの
 * 一致はあちらが機械照合の対象になっており、常時表示のために別の文字列を書くと、
 * **同じ状態に 2 つの文言ができて片方だけが古くなる**（shared-ai-rules 12 章）。
 *
 * @param availability いま生成できるかどうか
 * @returns 画面へ出す文言
 */
export function availabilityNotice(availability: GenerateAvailability): string {
  switch (availability.kind) {
    case 'available':
      return remainingQuotaNotice(availability.remaining);
    case DAILY_QUOTA_REASON:
      return GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]!;
    case MONTHLY_LIMIT_REASON:
      return GENERATE_MESSAGES[MONTHLY_LIMIT_MESSAGE_KEY]!;
    case 'build-stopped':
      // 3.8 の degrade（#140）。**残枠と混ぜない**——枠は残っているのに投げられない
      // 状態で、「残り N 回」を並べると利用者は押せない理由を枠だと読む。
      return BUILD_STOPPED_NOTICE;
    default:
      return QUOTA_UNKNOWN_NOTICE;
  }
}

/**
 * その状態で生成を送れるか（＝フォームを描いてよいか）。
 *
 * **`unknown` では描く。** 枠が尽きたことを確かめられたわけではないので、押す機会
 * まで奪うと、D1 の一時的な不調が「生成できない」に化ける。
 *
 * **`build-stopped` では描かない**（3.8 / #140）。この状態で押すと、生成は走って
 * ビルドで落ちる——**約 16〜19 円と日次枠 1 回が、成果物なしで消える。** 枠切れの
 * ときと違って、失うのは「押せること」ではなく利用者の枠と費用である。
 * **誤ってこの状態になったときの代償**（フォームが最大 15 分消える）と、その値の
 * 選び方は `src/build-health.ts` の `BUILD_STOP_WINDOW_SECONDS` にある。
 *
 * @param availability いま生成できるかどうか
 * @returns 送信フォームを描いてよければ true
 */
export function canSubmit(availability: GenerateAvailability): boolean {
  return availability.kind === 'available' || availability.kind === 'unknown';
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
 * 埋め込みスクリプトが作品 id の綴りを確かめる式（#150）。
 *
 * **応答本文の文字列を遷移先へそのまま渡さないための関門である**（8.3）。
 * 読むのは `gameId` だけで、しかも `crypto.randomUUID()` が返す形に一致したときしか
 * 使わない。飛び先は**サーバが描いた固定の接頭辞**（`/works/`）との連結で作る。
 *
 * `body.url` を使わないのは、応答の文字列がそのまま `location.href` になる形だと、
 * 本文しだいで `javascript:` を含む任意の URL へ飛ばせる経路が生まれるためである。
 * いまその本文を作っているのは自分のサーバだが、**この画面が「応答の文字列を
 * 表示にも遷移にも使わない」ことを、実装の性質として保つ。**
 *
 * `src/work-page.ts` の `GAME_ID_PATTERN` と同じ形である。**同じものが 2 か所に
 * ある以上、定数として切り出して `test/generate-page.test.ts` が照合する**
 * （shared-ai-rules 12 章）。
 */
export const GAME_ID_EXPRESSION =
  '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

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
  var longWait = document.getElementById('generate-long-wait');
  var degraded = document.getElementById('generate-degraded');
  var messages = document.querySelectorAll('[data-message-key]');
  var ticking = null;
  // 3.8 の degrade を観測したか。**観測したらボタンを戻さない。**
  var stopped = false;

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

  /** 待ち時間の提示を始める（実測 90 秒台のため、無反応の時間を作らない）。 */
  function startWaiting() {
    var startedAt = Date.now();
    elapsed.textContent = '0';
    longWait.hidden = true;
    progress.hidden = false;
    ticking = setInterval(function () {
      var seconds = Math.round((Date.now() - startedAt) / 1000);
      elapsed.textContent = String(seconds);
      // 長引いていることを、サーバが描いた固定の文言で言う（文字列は作らない）。
      if (seconds >= ${LONG_WAIT_SECONDS}) { longWait.hidden = false; }
    }, 1000);
  }

  /** 待ち時間の提示を終える。 */
  function stopWaiting() {
    if (ticking !== null) { clearInterval(ticking); ticking = null; }
    progress.hidden = true;
    longWait.hidden = true;
    // **停止を観測したらボタンを戻さない**（3.8 / 押しても動かないボタンを無くす）。
    button.disabled = stopped;
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
        // **読むのは分類名と作品 id だけ。** 応答本文の他の項目（生成物由来の
        // import パスや理由）はここで一切触らない（8.3）。
        var code = body !== null && typeof body === 'object' && typeof body.error === 'string'
          ? body.error
          : '';
        // **応答が返す url の項目は読まない**（#150）。応答の文字列をそのまま遷移先に
        // すると、
        // 本文しだいで任意の URL へ飛ばせる形になる。**id だけを受け取り、綴りを
        // 確かめてから、サーバが描いた固定の接頭辞と連結する。**
        var id = body !== null && typeof body === 'object' && typeof body.gameId === 'string'
          ? body.gameId
          : '';
        return { status: status, code: code, id: id };
      }, function () {
        return { status: status, code: '', id: '' };
      });
    }).then(function (outcome) {
      var status = outcome.status;
      var code = outcome.code;

      // **受け付けられたら作品ページへ送る**（#150）。ここから先の待ち時間と結果は
      // あの画面が持つので、**この画面は結果を表示しない。**
      if (status === 202 && ${GAME_ID_EXPRESSION}.test(outcome.id)) {
        window.location.href = ${JSON.stringify(WORK_PAGE_PREFIX)} + outcome.id;
        return;
      }
      // 3.8 の degrade。**発火条件は「ビルド依頼の失敗」**（確定24）で、この画面から
      // 観測できるのは「自分の要求がサーバ側の事情で落ちた」＝ 5xx である。
      if (status >= 500) { stopped = true; degraded.hidden = false; }
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
 * 生成が止まっているときに出す導線（4.4 / 3.8）。
 *
 * **止まっているのは生成だけである。** 4.4 は月次上限に「プレイと共有は引き続き
 * ご利用いただけます」を求め、3.8 は degrade について「プレイ側には一切影響を出さない」
 * と定める。**言うだけでなく、押せるリンクとして出す**（#24 の acceptance 2）。
 *
 * **いまの行き先はトップだけである。** 試遊の画面（#27）はまだ無く、無いものへの
 * リンクを置くと、それこそ「押しても動かない」導線になる。#27 が入ったらここへ足す。
 *
 * @returns HTML
 */
function stillAvailableSection(): string {
  return `<h2>プレイと共有は続けられます</h2>
<p>止まっているのは<strong>生成だけ</strong>です。すでにある作品を遊ぶことと、
   URL を共有することには影響ありません（4.4 / 3.8）。</p>
<ul>
  <li><a href="${HOME_PATH}">作品を見る（トップへ）</a></li>
</ul>`;
}

/**
 * プロンプトの入力フォームと、結果を出す領域を組み立てる。
 *
 * **文言はすべてここで描き、`hidden` で隠しておく**（モジュール冒頭 8.3）。
 * スクリプトは `hidden` を外すだけで、文字列を作らない。
 *
 * **枠が尽きているときはフォームを描かない**（モジュール冒頭）。押せば必ず 429 になる
 * ボタンは、#24 の goal が無くそうとしているものそのものである。
 *
 * `maxlength` は `src/generate.ts` の `MAX_PROMPT_LENGTH` から取る。書き写すと、
 * あちらを見直したときに画面だけが古い上限で切ることになる。
 *
 * @param view 画面へ渡す値
 * @returns HTML
 */
function signedInSection(view: GeneratePageView): string {
  // 4.4 の常時表示。**状態にかかわらず必ず 1 つ出る。** 文言は固定文字列だが、
  // `escapeHtml` は通す（`src/signup.ts` / `src/invite-issuance.ts` と同じ理由で、
  // 値の出どころが変わったときに安全側が既定になるようにしておく）。
  const quota = `<p id="generate-quota">${escapeHtml(availabilityNotice(view.availability))}</p>`;

  if (!canSubmit(view.availability)) {
    return `${quota}

${stillAvailableSection()}`;
  }

  const messages = Object.entries(GENERATE_MESSAGES)
    .map(
      ([key, message]) =>
        `  <p class="generate-message" data-message-key="${escapeHtml(key)}" hidden>${escapeHtml(message)}</p>`,
    )
    .join('\n');

  return `${quota}
<form id="generate-form" method="post" action="${GENERATE_PATH}">
  <label for="generate-prompt">どんなゲームを作りますか（日本語で、${MAX_PROMPT_LENGTH} 文字まで）</label>
  <textarea id="generate-prompt" name="prompt" rows="4" maxlength="${MAX_PROMPT_LENGTH}"
            placeholder="例: 左右キーで動く自機が、上から落ちてくるブロックをよけ続けるゲーム" required></textarea>
  <button id="generate-submit" type="submit" disabled>生成する</button>
</form>

<p id="generate-progress" role="status" aria-live="polite" hidden>生成しています…（経過 <span id="generate-elapsed">0</span> 秒）。
   <strong>${TYPICAL_WAIT_TEXT}。</strong>この画面を閉じたり再読み込みしたりしないでください。</p>
<p id="generate-long-wait" role="status" aria-live="polite" hidden>まだ生成しています。
   <strong>失敗したわけではありません。</strong>生成の待ち時間に上限は無いため、応答が返るまで待っています。</p>
<p id="generate-degraded" role="status" aria-live="polite" hidden>${escapeHtml(BUILD_STOPPED_NOTICE)}</p>

<div id="generate-messages" role="status" aria-live="polite">
${messages}
</div>

<noscript>
  <p><strong>生成の送信には JavaScript が必要です。</strong>
     生成は JSON で受け付ける API（<code>${GENERATE_PATH}</code>）への送信で、
     応答が返るまで ${TYPICAL_WAIT_TEXT}。その間の経過表示も JavaScript で行っています。</p>
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
  // スクリプトはフォームを描いたときだけ置く。未ログインの画面と、枠が尽きている
  // 画面にはフォームが無く、動かす対象が無い（`getElementById` が `null` を返す）。
  const script =
    signedIn && canSubmit(view.availability) ? `\n<script>${GENERATE_SCRIPT}</script>\n` : '';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ゲームを生成する</title>
<h1>ゲームを生成する</h1>
<p>作りたいゲームを 1 行で書くと、ブラウザで遊べる 2D ゲームの下書きができます。
   <strong>生成には ${TYPICAL_WAIT_TEXT}。</strong></p>

${body}

<p><a href="${HOME_PATH}">トップへ戻る</a></p>${script}`;
}

/**
 * いま生成できるかどうかを求める（4.4 / #24）。
 *
 * **判定は `src/quota.ts` に寄せる。** 画面が D1 を数え直すと、同じ「当日とは何か」が
 * 2 か所になり、画面の残数と API の判断が割れる（shared-ai-rules 12 章）。
 *
 * **読めなかったときに画面ごと落とさない。** `src/quota.ts` は「迷ったら止まる側へ
 * 倒す」ために例外を投げ直すが、**それは生成を通すかどうかの判断だからである。**
 * こちらは表示で、費用は出ない。集計を読めないことを理由に画面を 500 にすると、
 * 4.4 が求める常時表示どころか画面そのものが消え、**プレイと共有への導線まで
 * 巻き添えになる**（3.8 の degrade が守ろうとしているものである）。
 *
 * @param env バインディングと環境変数
 * @param userId 対象の利用者
 * @returns いま生成できるかどうか
 */
async function resolveAvailability(env: Env, userId: string): Promise<GenerateAvailability> {
  try {
    const status = await generationQuotaStatus(env, userId);
    switch (status.kind) {
      case 'available':
        // 3.8 の degrade（#140）。**枠が残っているときだけ引く。**
        //
        // - 枠が尽きているなら、押せない理由は枠である。**そちらのほうが具体的**で
        //   （日次なら再開時刻が言える）、停止の文言に差し替えると利用者は待つ先を
        //   間違える。
        // - 読めなかった（`unknown`）ときも引かない。**同じ D1 である。**
        //   引いても読めないだけで、問い合わせが 1 つ増える（3.6）。
        //
        // **止まっていても「残り N 回」は消えるが、枠は消えていない。** 停止が解けた
        // あとの再読み込みで元に戻る（`BUILD_STOPPED_NOTICE`）。
        if (await buildPathStopped(env, Math.floor(Date.now() / 1000))) {
          return { kind: 'build-stopped' };
        }
        return { kind: 'available', remaining: status.remaining };
      case DAILY_QUOTA_REASON:
        // **`resetsAt` は渡さない。** 枠が戻るのは常に JST の 0 時なので、画面が出す
        // 時刻は値によらず決まる（{@link GENERATE_MESSAGES}）。渡すと、同じ時刻を
        // 表す経路が固定文字列と値の 2 つになる。
        return { kind: DAILY_QUOTA_REASON };
      case MONTHLY_LIMIT_REASON:
        return { kind: MONTHLY_LIMIT_REASON };
      default:
        // **知らない状態を月次上限として描かない。** `src/quota.ts` へ状態が増えた
        // ときに、画面が「今月の生成は終了しました」と嘘をつく経路になる。読めなかった
        // ときと同じ扱いにして、判断は API へ委ねる。
        return { kind: 'unknown' };
    }
  } catch (error) {
    // 例外の種類だけを出す（`src/quota.ts` の `readForDecision` と同じ方針。
    // 利用者のプロンプトも生成物もここには無い）。
    console.error(
      `[generate-page] 残枠を取得できませんでした: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return { kind: 'unknown' };
  }
}

/**
 * 生成画面を返す。
 *
 * ログインの判定は `resolveSessionUser` に寄せる（署名だけを信じず、BAN と利用者の
 * 不在まで見る。`src/session-user.ts`）。**画面側で別の判定を書かない。**
 *
 * **未ログインでは枠を読まない。** 出すのは登録の導線だけで、残枠を出す相手が
 * 居ない。D1 は読み取りも従量である（3.6）。
 *
 * @param request 受信したリクエスト
 * @param env バインディングと環境変数
 * @returns レスポンス
 */
const showGeneratePage: RouteHandler = async (request, env) => {
  const session = await resolveSessionUser(request, env);
  if (!session.ok) {
    // 未ログインの画面は残枠を出さない。`availability` は使われないが、型として
    // 1 つ選ぶ必要があるので「読めていない」を渡す（「残り N 回」を作らない値）。
    return html(renderGeneratePage(false, { availability: { kind: 'unknown' } }));
  }
  return html(
    renderGeneratePage(true, { availability: await resolveAvailability(env, session.userId) }),
  );
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
