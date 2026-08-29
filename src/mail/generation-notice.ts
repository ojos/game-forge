/**
 * 生成の完了を作者へ知らせる（#153 / 5.2 / 4.4）。
 *
 * ## 何のためにあるか
 *
 * **91 秒は「できたらお知らせします」が成立する長さである**（実測 90.9 秒。1.2.38）。
 * #150 が URL を先に返し、#152 が「あなたの作品」一覧を出したが、**利用者が自発的に
 * 見に戻る必要は残っていた。** 本モジュールがそれを埋めて、「送信したら閉じてよい」が
 * 揃う。
 *
 * ## 送るのは作者本人へだけである
 *
 * 宛先は `users.email`（作品行の `author_id` から引く）。**設定にも書かないし、
 * コードにも書かない**——作者は D1 が知っている。#148 の運用者宛て通知とは宛先も
 * 契機も文面も別物で、共有するのは送信の土台（`src/mail/resend.ts`）だけである。
 *
 * ## 生成経路の応答時間を延ばさない
 *
 * **送るのはコールバック経路（`src/generate-callback.ts` の `finish`）で、利用者の
 * リクエストの中ではない。** `/api/generate` は #160 以降、オーケストレータへ投げて
 * すぐ 202 を返す（`src/generate.ts`）。90.9 秒は Worker の外で流れており、そこへ
 * 通知は載らない。
 *
 * **作品行を進めたあとに送る。** 利用者から見える状態（`ready` / `failed`）は送信の
 * 前に確定しているので、Resend が遅くても作品ページの表示は待たされない。送信自体にも
 * 上限を置いてある（`src/mail/resend.ts` の `MAIL_TIMEOUT_MS`）。
 *
 * ## 失敗したときも送る
 *
 * **送らない選択は「待っている人を待たせ続ける」ことと同じである。** 失敗したまま
 * 何も届かなければ、利用者はいつまで待てばよいかを知る手段を持たない。
 *
 * **ただし「失敗しました」だけにしない。** 枠は台帳の行数で数えるので
 * （確定25 / `src/quota.ts`）、**LLM の呼び出しが起きた以上その 1 回は消えている。**
 * 文面がそこへ触れないと、利用者は枠が減ったのかどうかを知りようがない。**残り回数を
 * 実際に数えて本文へ入れる**（推測で「減っていません」と書かない）。
 *
 * ## 二重送信
 *
 * **`finish` は 1 ジョブにつき 1 回しか通らない。** ジョブトークンは完了と同時に
 * 捨てられ（`src/games.ts`）、遅れて届いた再送は照合で落ちる。したがってこの通知に
 * 独自の抑止は要らない——**通知を送るのは、条件付き UPDATE が実際に行を進めたときだけ**
 * である（`src/generate-callback.ts`）。
 */
import { failureMessageOf, workPagePath } from '../work-page.js';
import { DAILY_QUOTA_REASON, MONTHLY_LIMIT_REASON, generationQuotaStatus } from '../quota.js';
import type { MailDeps, MailMessage, MailOutcome } from './resend.js';
import { defaultMailDeps, mailConfigOf, sendMail } from './resend.js';

/** ログに出す、この通知の固定の名前（宛先や本文の代わりに使う）。 */
const LABEL = 'generation-finished';

/** 生成の結末（`finish` コールバックが運ぶもの）。 */
export type GenerationOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly errorCode: string };

/**
 * この通知の結末。**呼び出し元はログと検査のためにだけ使う。**
 *
 * - `sent`: 送った
 * - `not-configured`: 送信の設定が無い（ローカル・テスト）
 * - `no-recipient`: 作者の行が引けなかった・宛先が空だった
 * - `send-failed`: 送信に失敗した
 */
export type GenerationNoticeOutcome = 'sent' | 'not-configured' | 'no-recipient' | 'send-failed';

/** 差し替えできる依存（`src/mail/resend.ts` の {@link MailDeps} と同じ理由）。 */
export interface GenerationNoticeDeps extends MailDeps {
  /** 送信そのもの。テストは送信の手前で止めるためにここを差し替える。 */
  readonly send: (
    env: Env,
    message: MailMessage,
    label: string,
    deps: MailDeps,
  ) => Promise<MailOutcome>;
}

/** 既定の依存（本物の送信）。 */
export const defaultGenerationNoticeDeps: GenerationNoticeDeps = {
  ...defaultMailDeps,
  send: sendMail,
};

/** 通知に要る、作品と作者の値。 */
interface NoticeTarget {
  readonly authorId: string;
  readonly email: string;
  readonly title: string;
}

/**
 * 作品ページの絶対 URL を組み立てる。
 *
 * **綴りの正本は `src/work-page.ts` の `workPagePath` である**（3 か所に `/works/` と
 * 書かない）。ホスト名は環境の宣言（`APP_HOST`）から取る。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @returns 絶対 URL
 */
export function workPageUrl(env: Env, gameId: string): string {
  return `https://${env.APP_HOST}${workPagePath(gameId)}`;
}

/**
 * 本日の枠の状態を、本文へ入れる 1 文にする（4.4 / 確定25）。
 *
 * **数え直さない。** `src/quota.ts` の `generationQuotaStatus` が返す状態から作る。
 *
 * **画面の文言を写さない。** 生成画面（`src/generate-page.ts`）の文言は「送信した要求が
 * 断られた」ときのもので、こちらは「終わった仕事の結果を、その場にいない人へ知らせる」
 * ときのものである（`src/work-page.ts` が `GENERATE_MESSAGES` を再利用しないのと同じ理由）。
 *
 * @param env バインディングと環境変数
 * @param userId 作者
 * @returns 本文へ入れる 1 文。読み取れなければ null（**推測で書かない**）
 */
async function remainingQuotaSentence(env: Env, userId: string): Promise<string | null> {
  let status: Awaited<ReturnType<typeof generationQuotaStatus>>;
  try {
    status = await generationQuotaStatus(env, userId);
  } catch {
    // 集計が読めなかっただけで、枠が尽きたわけではない。**何も書かない。**
    // 「残り 0 回」とも「まだ使えます」とも言わないのは `QUOTA_UNKNOWN_NOTICE` と同じ判断である。
    return null;
  }
  if (status.kind === DAILY_QUOTA_REASON) {
    return '本日の生成枠は残っていません（枠は JST の 0 時に戻ります）。';
  }
  if (status.kind === MONTHLY_LIMIT_REASON) {
    return 'サービス全体の今月の生成枠が上限に達しています（プレイと共有は引き続きご利用いただけます）。';
  }
  return `本日の残りの生成枠は ${status.remaining} 回です。`;
}

/**
 * 完了の本文を組み立てる。
 *
 * @param title 仮タイトル（プロンプト由来）
 * @param url 作品ページの URL
 * @returns 件名と本文
 */
function readyMessage(title: string, url: string): { subject: string; text: string } {
  return {
    subject: '[Game Forge] ゲームができました',
    text: [
      'お待たせしました。ゲームができました。',
      '',
      `お題: ${title}`,
      `作品ページ: ${url}`,
      '',
      'このページから遊べます。URL を知っているのはあなただけで、まだ公開されていません。',
    ].join('\n'),
  };
}

/**
 * 失敗の本文を組み立てる。
 *
 * **失敗の説明は `src/work-page.ts` の `failureMessageOf` から取る。** 作品ページと
 * メールで説明が食い違うと、同じ 1 件の失敗に 2 つの説明ができる（shared-ai-rules 12 章）。
 *
 * @param title 仮タイトル（プロンプト由来）
 * @param url 作品ページの URL
 * @param errorCode 失敗の分類名（8.3）
 * @param quota 枠の状態を表す 1 文（読み取れなければ null）
 * @returns 件名と本文
 */
function failedMessage(
  title: string,
  url: string,
  errorCode: string,
  quota: string | null,
): { subject: string; text: string } {
  return {
    subject: '[Game Forge] 生成できませんでした',
    text: [
      '申し訳ありません。生成できませんでした。',
      '',
      `お題: ${title}`,
      failureMessageOf(errorCode),
      `作品ページ: ${url}`,
      '',
      // **枠の扱いを必ず書く**（モジュール冒頭）。数えるのは台帳の行数なので（確定25）、
      // 失敗しても LLM を呼んだ回数ぶんは消えている。
      '生成が失敗しても、LLM の呼び出しが起きた回数だけ生成枠は消費されます。',
      ...(quota === null ? [] : [quota]),
    ].join('\n'),
  };
}

/**
 * 作品から、宛先と仮タイトルを引く。
 *
 * **`users` と 1 回で引く。** 通知のたびに 2 往復すると、コールバックの応答が
 * そのぶん遅くなる（D1 は読み取りも従量である。3.6）。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @returns 宛先と仮タイトル。引けなければ null
 */
async function noticeTarget(env: Env, gameId: string): Promise<NoticeTarget | null> {
  const row = await env.DB.prepare(
    `select g.author_id as author_id, g.title as title, u.email as email
       from games g join users u on u.id = g.author_id
      where g.id = ?`,
  )
    .bind(gameId)
    .first<{ author_id: string; title: string; email: string }>();
  if (row === null || row.email.trim() === '') {
    return null;
  }
  return { authorId: row.author_id, email: row.email.trim(), title: row.title };
}

/**
 * 生成の完了（または失敗）を作者へ知らせる。
 *
 * **投げない。** 呼び出し元は作品行を進め終えたあとの経路（`src/generate-callback.ts`）で、
 * 通知の失敗で `finish` をやり直させる理由が無い（やり直しても行はもう進んでいる）。
 *
 * @param env バインディングと環境変数
 * @param gameId 作品 id
 * @param outcome 生成の結末
 * @param deps 差し替えできる依存（既定は本物の送信）
 * @returns この呼び出しの結末
 */
export async function notifyGenerationFinished(
  env: Env,
  gameId: string,
  outcome: GenerationOutcome,
  deps: GenerationNoticeDeps = defaultGenerationNoticeDeps,
): Promise<GenerationNoticeOutcome> {
  // **設定の検査を先に置く。** 未設定の環境（ローカル・テスト）で D1 を触らない。
  if (mailConfigOf(env) === null) {
    return 'not-configured';
  }

  try {
    const target = await noticeTarget(env, gameId);
    if (target === null) {
      // **例外にしない。** 作者の行が引けないのは異常だが、作品行はもう進んでいる。
      console.error(`[generation-notice] 宛先を引けませんでした: ${LABEL}`);
      return 'no-recipient';
    }

    const url = workPageUrl(env, gameId);
    const message =
      outcome.kind === 'ready'
        ? readyMessage(target.title, url)
        : failedMessage(
            target.title,
            url,
            outcome.errorCode,
            await remainingQuotaSentence(env, target.authorId),
          );

    const sent = await deps.send(env, { to: target.email, ...message }, LABEL, deps);
    return sent.sent ? 'sent' : 'send-failed';
  } catch (error) {
    // **例外の種類だけを出す。** 本文には利用者のプロンプト由来の仮タイトルが載るので、
    // 例外をそのままログへ流さない（8.3）。
    console.error(
      `[generation-notice] 完了の通知に失敗しました: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return 'send-failed';
  }
}
