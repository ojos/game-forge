/**
 * メール送信の土台（確定14 / 4.6 / 5.5）。
 *
 * ## ここが共有するもの、しないもの
 *
 * **共有するのは「どうやって 1 通を送るか」だけである。** 送信基盤（Resend）・資格情報の
 * 読み方・設定不足のときの振る舞い・失敗の分類・ログに何を出さないか、の 5 つ。
 *
 * **共有しないのは「誰に・いつ・何を送るか」である。** 宛先も契機も文面も、通知ごとに
 * 別物である（費用 80% の警告は運用者へ・生成の完了は作者へ・5.5 の改造通知は元の作者へ）。
 * ここへ文面や宛先を寄せると、3 つの通知が 1 つのテンプレートを取り合うことになる。
 *
 * ## 送信は Resend（確定14）
 *
 * 無料枠は **3,000 通/月・100 通/日**で、**この 1 本を全通知が共有する。** 日次の
 * 見積もりは次のとおりで、100 通に対して余裕がある。
 *
 * | 通知 | 契機 | 日次の上限 |
 * |---|---|---|
 * | 生成の完了（#153） | 生成 1 回につき 1 通 | **約 34 通**（4.3 の全体枠。確定25） |
 * | 費用 80% の警告（#148） | 月に 1 回 | **1 通**（`src/mail/cost-alert.ts` が抑止する） |
 * | 改造の通知（5.5 / #36。未実装） | 改造 1 件につき 1 通 | 改造は生成の一種なので**上の 34 通の内数** |
 *
 * **上限に近づく形は 1 つだけある**——1 通の生成が複数人へ通知を生む場合（5.5 の系統が
 * 深いときに祖先へ配るなど）である。#36 がその形を選ぶなら、**そこで日次の見積もりを
 * 立て直すこと。** 本モジュールは 1 回の呼び出しで 1 通しか送らない。
 *
 * ## 設定が無い環境では送らない（例外にもしない）
 *
 * 資格情報も宛先も `.dev.vars` / `wrangler secret` から読む（`src/env.d.ts`）。
 * **ローカルにもテストにも値は無い。** 値が無いときは {@link MAIL_NOT_CONFIGURED} を
 * 返して**何も送らない**（ネットワークへ出ない）。例外にすると、通知の設定が無いだけで
 * 生成の完了経路が落ちる。
 *
 * ## 送信の失敗で呼び出し元を壊さない
 *
 * この関数は投げない。**通知はどれも「本来の仕事が終わったあとの付け足し」**であり、
 * 台帳の記録や作品行の完成をやり直させる理由にならない。呼び出し元は結果を見て
 * 記録するだけでよい。
 */

/** Resend の送信エンドポイント。 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * 送信をあきらめるまでの時間（ミリ秒）。
 *
 * **上限を置くのは、通知が呼び出し元の応答時間に化けるからである。** 生成の完了通知は
 * コールバック経路（`src/generate-callback.ts`）の中で送るため、Resend が応答しない
 * ときにここで待つと、オーケストレータ側の実行時間が伸びる。**届かなかったことは
 * 分類として返し、待ち続けない。**
 */
export const MAIL_TIMEOUT_MS = 5_000;

/**
 * 送信に要る秘密の名前。
 *
 * **一覧をここに置くのは、`.dev.vars.example` との照合をテストが行うためである**
 * （shared-ai-rules 12 章）。値は持たない。
 */
export const MAIL_SECRET_NAMES = ['RESEND_API_KEY', 'MAIL_FROM'] as const;

/** 送る 1 通。**宛先も文面も呼び出し側が決める。** */
export interface MailMessage {
  /** 宛先（1 件）。**コードにも仕様書にも書かない**（設定として持つ）。 */
  readonly to: string;
  /** 件名。 */
  readonly subject: string;
  /** 本文（プレーンテキスト）。 */
  readonly text: string;
}

/**
 * 送れなかった理由。
 *
 * **「受け付けられたか」で分ける。** 呼び出し側が再送してよいかどうかが、この区別で
 * 決まる（`src/mail/cost-alert.ts` の重複抑止が使う）。
 *
 * - `not-configured`: 資格情報か差出人が未設定。**ネットワークへ出ていない。**
 * - `invalid-message`: 宛先・件名の綴りが契約を満たさない。**ネットワークへ出ていない。**
 * - `rejected`: Resend が受け付けなかった（4xx）。**同じ内容を送り直しても同じ結果になる。**
 * - `unreachable`: 応答が無い・5xx・429。**受け付けられていないので、送り直す意味がある。**
 */
export type MailFailure = 'not-configured' | 'invalid-message' | 'rejected' | 'unreachable';

/** 送信の結果。**例外の代わりにこれを返す。** */
export type MailOutcome =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: MailFailure };

/** 設定が無いときの結果（{@link sendMail} が返す値の別名）。 */
export const MAIL_NOT_CONFIGURED: MailOutcome = { sent: false, reason: 'not-configured' };

/**
 * 送信に使う設定。**値はすべて秘密から読む。**
 */
export interface MailConfig {
  /** Resend の API キー。 */
  readonly apiKey: string;
  /** 差出人。`name <local@domain>` の形も受け付ける（7.2 のとおりドメインは ojos.jp 系）。 */
  readonly from: string;
}

/**
 * 差し替えできる依存。**テストは送信の手前で止めるためにここを差し替える。**
 *
 * 既定はグローバルの `fetch` である。`src/generate.ts` の `GenerationPipeline` と
 * 同じ形（既定を持つ引数）にしてあり、経路の登録は既定のまま変わらない。
 */
export interface MailDeps {
  /** HTTP を投げる関数。 */
  readonly fetcher: (request: Request) => Promise<Response>;
}

/** 既定の依存（本物の `fetch`）。 */
export const defaultMailDeps: MailDeps = {
  fetcher: (request) => fetch(request),
};

/**
 * 宛先として受け付ける綴り。
 *
 * **表示名付きの形（`名前 <a@b>`）を宛先には許さない。** 宛先は設定か D1 から来る
 * 生の住所であり、表示名を付ける必要が無い。許すと、区切り文字を含む値が
 * そのまま Resend の `to` へ載る経路ができる。
 */
const ADDRESS_PATTERN = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/u;

/** 件名・差出人に混ぜてはいけない文字（改行）。 */
const CONTROL_PATTERN = /[\r\n]/u;

/**
 * 環境から送信の設定を読む。
 *
 * **どちらか一方でも欠けたら null を返す。** 片方だけで送ろうとすると、Resend へ
 * 出てから 4xx で落ちる（＝設定不足が「送信の失敗」として記録される）。設定不足は
 * 送信の失敗と別物なので、手前で分ける。
 *
 * @param env バインディングと環境変数
 * @returns 設定。欠けていれば null
 */
export function mailConfigOf(env: Env): MailConfig | null {
  const apiKey = (env.RESEND_API_KEY ?? '').trim();
  const from = (env.MAIL_FROM ?? '').trim();
  if (apiKey === '' || from === '') {
    return null;
  }
  if (CONTROL_PATTERN.test(from) || !from.includes('@')) {
    return null;
  }
  return { apiKey, from };
}

/**
 * 送る値が契約を満たしているか。
 *
 * @param message 送る 1 通
 * @returns 満たしていれば true
 */
function isSendable(message: MailMessage): boolean {
  if (!ADDRESS_PATTERN.test(message.to)) {
    return false;
  }
  return message.subject !== '' && !CONTROL_PATTERN.test(message.subject);
}

/**
 * 失敗をログへ落とす。
 *
 * **宛先も本文も出さない。** 出してよいのは、どの通知が・どの分類で失敗したかだけである
 * （`src/generate.ts` の `describeGenerateError` と同じ方針）。メールアドレスは
 * 8.1 の個人情報で、ログは 8.3 が言う「出してよい範囲」の外にある。
 *
 * @param label 呼び出し元を識別する固定の名前
 * @param reason 失敗の分類
 * @param status HTTP のステータス（分かる場合）
 */
function logFailure(label: string, reason: MailFailure, status?: number): void {
  const suffix = status === undefined ? '' : ` (status ${status})`;
  console.error(`[mail] 送信できませんでした: ${label} / ${reason}${suffix}`);
}

/**
 * 1 通送る。
 *
 * **投げない**（モジュール冒頭）。設定不足・綴り不正・拒否・不達のいずれも
 * {@link MailOutcome} として返す。
 *
 * @param env バインディングと環境変数
 * @param message 送る 1 通
 * @param label ログに出す、呼び出し元の固定の名前（宛先や本文の代わりに使う）
 * @param deps 差し替えできる依存（既定は本物の `fetch`）
 * @returns 送信の結果
 */
export async function sendMail(
  env: Env,
  message: MailMessage,
  label: string,
  deps: MailDeps = defaultMailDeps,
): Promise<MailOutcome> {
  const config = mailConfigOf(env);
  if (config === null) {
    // **ログを error にしない。** ローカルとテストではこれが正常な状態である。
    console.log(`[mail] 送信の設定がないため送りません: ${label}`);
    return MAIL_NOT_CONFIGURED;
  }
  if (!isSendable(message)) {
    logFailure(label, 'invalid-message');
    return { sent: false, reason: 'invalid-message' };
  }

  const request = new Request(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
    // 待ち続けない（{@link MAIL_TIMEOUT_MS}）。
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });

  let response: Response;
  try {
    response = await deps.fetcher(request);
  } catch {
    // **例外の中身をログへ出さない。** 送信要求には API キーと宛先が載っており、
    // 実装によっては例外や `cause` からそれらが読める。
    logFailure(label, 'unreachable');
    return { sent: false, reason: 'unreachable' };
  }

  if (response.ok) {
    return { sent: true };
  }
  // **429 と 5xx は「受け付けられていない」側へ入れる。** 前者は送信枠の一時的な
  // 制限で、あとから送り直せば通る。同じ内容が必ず断られる 4xx とは扱いが違う。
  const reason: MailFailure =
    response.status >= 500 || response.status === 429 ? 'unreachable' : 'rejected';
  logFailure(label, reason, response.status);
  return { sent: false, reason };
}

/**
 * 円の額を、桁区切り付きの整数へ整える。
 *
 * **`Intl` を使わない。** このモジュールは Worker（workerd）と、束ね直して
 * Lambda の Node 22 でも読まれる（`scripts/bundle-orchestrator.sh`）。両者で
 * ロケールの既定が同じである保証を、文面の見た目のために持ち込まない。
 *
 * **丸めるのは表示のときだけである**（4.3 の記録規約）。台帳の値は丸めない。
 *
 * @param value 円の額
 * @returns 桁区切り付きの文字列
 */
export function formatJpy(value: number): string {
  const rounded = Math.round(value);
  return `${rounded}`.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}
