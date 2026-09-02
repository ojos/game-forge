/**
 * 自分の作品が改造されたことを、元の作者へ知らせる（5.5 / 2.2-6 / #36 / M5-5）。
 *
 * ## 何のためにあるか
 *
 * **これが無いとコア体験ループが閉じない**（2.2-6 / 5.5）。作品ページの
 * 「このゲームからの改造: N 件」は**再訪しないと見えない**ので、改造されたことは
 * 作者へ届かない。1.3 が差別化の第一位に据えているのは系統であり（確定15）、
 * その系統が伸びたことを当人が知らないままでは、次の改造も次の公開も起きない。
 *
 * ## 契機は「フォークの公開」である
 *
 * **フォークの生成では送らない。** 5.4 が「「公開」操作で初めて URL が有効になる」と
 * 定めており、未公開の子作品は作者以外に開けない——**開けない URL を送ることに
 * なる。** 送る先も内容も、公開が成立して初めて意味を持つ。
 *
 * **経路層（`src/publish.ts`）から呼ぶ。** データ層（`src/games.ts` の `publishGame`）
 * には置かない。あそこは「`games` の 1 行を進める」だけの関数で、OGP の撮影の起動も
 * 置いていない（同関数の「OGP の撮影はここでは起こさない」）。**同じ理由で通知も
 * 置かない。**
 *
 * ## 自分自身のフォークでは送らない
 *
 * **作者が自分の公開作品をフォークすることはできる**（5.3 は他人の作品に限っていない）。
 * そのとき送ると、自分の操作の通知が自分へ返る。受け入れ条件（#36）が明示的に
 * 挙げている形である。
 *
 * **判定は「子の作者 == 親の作者」だけである。** `parent_id` の有無ではない
 * ——推敲（5.7）は `parent_id` を張らないので、そもそもここへ来ない。
 *
 * ## 1 フォークにつき 1 通
 *
 * 抑止は 2 段にある。
 *
 * | 段 | 何を止めるか |
 * |---|---|
 * | `publishGame` の `where status = 'draft'` | **二度押し。** 2 通目の公開は 0 行更新になり、`firstTime` が false になる（`src/publish.ts` はそのときこの関数を呼ばない） |
 * | `fork_notices` の主キー（`migrations/0013_fork_notices.sql`） | **公開の経路を通らない 2 通目。** 送る前に行を握り、握れなかった側は送らない |
 *
 * **2 段目を「念のため」で持っているのではない。** 1 段目は「公開が 2 回成立しない」
 * ことしか言っておらず、**通知の契機を 1 本足した日**（撮り直し・再公開・運用の
 * 手作業）に黙って消える。抑止の正本を通知の側に置く。
 *
 * ## 既存のフォークへ撒かない
 *
 * **「記録が無い＝未送信」と読まない。** この関数は未送信のフォークを探して回らない
 * ——送るのは「いま公開が成立した」ときだけである。`publishGame` は
 * `status = 'draft'` を条件に持つので、**本番に既にある公開済みのフォーク 2 件は
 * 二度とこの経路へ入らない**（`docs/handoff.md` 1 章の系統）。
 *
 * それでも 0013 は適用の時点で公開済みのフォークを `backfilled` として埋めてある。
 * **理由はマイグレーションの本文に書いた**（あとから「未送信を拾う」運用を書いた人が、
 * 空の表を「1 通も送っていない」と読めるため。#202 / #203 と同じ形）。
 *
 * ## 送信の失敗で公開を壊さない
 *
 * **投げない。** 呼び出し元は公開を終えたあとの経路で、通知の失敗で公開を
 * やり直させる理由が無い（やり直しても行はもう進んでいる）。分類として返し、
 * ログに残す。
 */
import { isMailAddress, mailConfigOf, sendMail } from './resend.js';
import type { MailDeps, MailMessage, MailOutcome } from './resend.js';
import { defaultMailDeps } from './resend.js';
import { workPageUrl } from './generation-notice.js';

/**
 * ログに出す、この通知の固定の名前（宛先や本文の代わりに使う）。
 */
const LABEL = 'fork-published';

/**
 * 本文へ載せる表示名の最大文字数。
 *
 * **UGC だから切る。** `users.display_name` は Google から来た値で（`src/auth/google.ts`）、
 * 長さの上限を持たない。本文の 1 行がいくらでも伸びる形をメールへ持ち込まない。
 */
const MAX_NAME_LENGTH = 60;

/**
 * この通知の結末。**呼び出し元はログと検査のためにだけ使う。**
 *
 * - `sent`: 送った
 * - `not-configured`: 送信の設定が無い（ローカル・テスト）
 * - `not-a-fork`: 親を持たない作品だった（新規生成・推敲。**異常ではない**）
 * - `self-fork`: 自分の作品を自分で改造した（送らない）
 * - `no-recipient`: 親の作者の宛先が引けなかった・綴りが壊れていた
 * - `already-sent`: このフォークは通知済み（`fork_notices` に行がある）
 * - `send-failed`: 送信に失敗した
 */
export type ForkNoticeOutcome =
  | 'sent'
  | 'not-configured'
  | 'not-a-fork'
  | 'self-fork'
  | 'no-recipient'
  | 'already-sent'
  | 'send-failed';

/** 差し替えできる依存（`src/mail/resend.ts` の {@link MailDeps} と同じ理由）。 */
export interface ForkNoticeDeps extends MailDeps {
  /** 送信そのもの。テストは送信の手前で止めるためにここを差し替える。 */
  readonly send: (
    env: Env,
    message: MailMessage,
    label: string,
    deps: MailDeps,
  ) => Promise<MailOutcome>;
}

/** 既定の依存（本物の送信）。 */
export const defaultForkNoticeDeps: ForkNoticeDeps = {
  ...defaultMailDeps,
  send: sendMail,
};

/** 通知に要る、子・親・親の作者の値。 */
interface ForkNoticeTarget {
  /** 改造した人（子の作者）。 */
  readonly forkAuthorId: string;
  /** 改造した人の表示名（`users.display_name`。**公開の画面に出ている値**）。 */
  readonly forkAuthorName: string;
  /** 元の作者（親の作者）。 */
  readonly parentAuthorId: string;
  /** 元の作者の宛先（`users.email`）。 */
  readonly parentAuthorEmail: string;
  /** 元の作品の仮タイトル（**受け取る本人の作品**である）。 */
  readonly parentTitle: string;
}

/**
 * 改行を落とし、長さを切る。
 *
 * **本文の行を偽造させない。** 表示名は UGC なので、改行を含んだ名前は
 * 「元の作品: …」のような行を本文へ足せる。差出人も宛先も件名も UGC を含まないが、
 * **本文の中で行を装う**ことはできる（`src/mail/resend.ts` の
 * `CONTROL_PATTERN` は件名と差出人しか見ない）。
 *
 * @param value 表示名
 * @returns 1 行に収めた表示名
 */
function oneLine(value: string): string {
  const flattened = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return flattened.length > MAX_NAME_LENGTH
    ? `${flattened.slice(0, MAX_NAME_LENGTH)}…`
    : flattened;
}

/**
 * 通知の本文を組み立てる。
 *
 * **載せるのは改造者名と子作品の URL、それに受け取る本人の作品名だけである**
 * （#36 の scope）。**機密を載せない**——宛先以外のメールアドレス、`preview_key`、
 * `ogp_token_hash`、ジョブトークン、改造の差分プロンプトはどれも本文へ出さない
 * （8.1 / 8.3）。子作品の URL は既に公開されている作品ページであり、誰でも開ける。
 *
 * @param forkAuthorName 改造した人の表示名
 * @param parentTitle 元の作品の仮タイトル
 * @param forkUrl 子作品（改造版）の作品ページ URL
 * @returns 件名と本文
 */
export function forkNoticeMessage(
  forkAuthorName: string,
  parentTitle: string,
  forkUrl: string,
): { readonly subject: string; readonly text: string } {
  return {
    // **件名に UGC を入れない**（`src/mail/resend.ts` は件名の改行を弾くが、
    // 弾かれると通知そのものが消える。固定文なら消えようが無い）。
    subject: '[Game Forge] あなたの作品が改造されました',
    text: [
      `${oneLine(forkAuthorName)} さんが、あなたの作品を改造して公開しました。`,
      '',
      `元の作品: ${oneLine(parentTitle)}`,
      `改造された作品: ${forkUrl}`,
      '',
      'このページから遊べます。改造された作品は、改造した人の作品として公開されています。',
    ].join('\n'),
  };
}

/**
 * 子作品から、親の作者の宛先と表示名を 1 回で引く。
 *
 * **1 往復で引く**（`src/mail/generation-notice.ts` の `noticeTarget` と同じ理由。
 * D1 は読み取りも従量である。3.6）。
 *
 * **親の `status` で絞らない。** 親が `removed`（8.4）でも、改造された事実は変わらず、
 * 受け取るべき人も変わらない。絞ると M5-4 の tombstone が入った日に通知が黙って
 * 止まる。
 *
 * @param env バインディングと環境変数
 * @param gameId 子作品（フォーク）の id
 * @returns 通知に要る値。親を持たない・引けないなら null
 */
async function forkNoticeTarget(env: Env, gameId: string): Promise<ForkNoticeTarget | null> {
  const row = await env.DB.prepare(
    `select c.author_id as fork_author_id,
            f.display_name as fork_author_name,
            p.author_id as parent_author_id,
            p.title as parent_title,
            a.email as parent_author_email
       from games c
       join users f on f.id = c.author_id
       join games p on p.id = c.parent_id
       join users a on a.id = p.author_id
      where c.id = ?`,
  )
    .bind(gameId)
    .first<{
      fork_author_id: string;
      fork_author_name: string;
      parent_author_id: string;
      parent_title: string;
      parent_author_email: string;
    }>();
  if (row === null) {
    return null;
  }
  return {
    forkAuthorId: row.fork_author_id,
    forkAuthorName: row.fork_author_name,
    parentAuthorId: row.parent_author_id,
    parentAuthorEmail: row.parent_author_email.trim(),
    parentTitle: row.parent_title,
  };
}

/**
 * このフォークの通知を握る（無いときだけ書く）。
 *
 * **「引いて、無ければ書く」にしない。** 2 つの要求がほぼ同時に来ると両方が
 * 「無い」を読み、2 通出る（`src/mail/cost-alert.ts` の R2 の条件付き書き込みと
 * 同じ判断で、ここでは主キーがその役をする）。
 *
 * @param env バインディングと環境変数
 * @param gameId 子作品（フォーク）の id
 * @param now 現在時刻（UNIX 秒）
 * @returns 握れたら true
 */
async function claimForkNotice(env: Env, gameId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `insert into fork_notices (game_id, claimed_at, outcome)
     values (?, ?, 'claimed')
     on conflict (game_id) do nothing`,
  )
    .bind(gameId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 握った行へ結末を書き戻す。
 *
 * **判定には使わない**（0013 の本文）。運用があとから「握ったまま落ちた行」を
 * 読めるようにするためだけのものなので、ここが失敗しても通知の結末は変えない。
 *
 * @param env バインディングと環境変数
 * @param gameId 子作品（フォーク）の id
 * @param outcome `sent` か `send-failed`
 */
async function recordOutcome(
  env: Env,
  gameId: string,
  outcome: 'sent' | 'send-failed',
): Promise<void> {
  try {
    await env.DB.prepare('update fork_notices set outcome = ? where game_id = ?')
      .bind(outcome, gameId)
      .run();
  } catch (error) {
    console.error(
      `[fork-notice] 結末を記録できませんでした: ${LABEL} / game ${gameId} / ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
  }
}

/**
 * フォークが公開されたことを、元の作者へ知らせる（1 フォークにつき 1 通）。
 *
 * **投げない**（モジュール冒頭）。
 *
 * @param env バインディングと環境変数
 * @param gameId 公開された子作品（フォーク）の id
 * @param deps 差し替えできる依存（既定は本物の送信）
 * @param now 現在時刻（UNIX 秒。既定は現在時刻）
 * @returns この呼び出しの結末
 */
export async function notifyForkPublished(
  env: Env,
  gameId: string,
  deps: ForkNoticeDeps = defaultForkNoticeDeps,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ForkNoticeOutcome> {
  // **設定の検査を先に置く。** 未設定の環境（ローカル・テスト）で D1 を触らない
  // （`src/mail/generation-notice.ts` と同じ順序）。**握りもしない**——送れない
  // 環境で行だけが残ると、設定を入れた日に `already-sent` で黙る。
  if (mailConfigOf(env) === null) {
    return 'not-configured';
  }

  try {
    const target = await forkNoticeTarget(env, gameId);
    if (target === null) {
      // 親を持たない作品（新規生成・推敲）。**異常ではないのでログを出さない。**
      return 'not-a-fork';
    }
    if (target.forkAuthorId === target.parentAuthorId) {
      // 自分の作品を自分で改造した（#36 の受け入れ条件）。
      return 'self-fork';
    }
    if (!isMailAddress(target.parentAuthorEmail)) {
      // **握る前に落とす**（`src/mail/cost-alert.ts` の「目印より前」と同じ判断）。
      // 握ってしまうと、宛先を直しても `already-sent` になり二度と送られない。
      //
      // **`gameId` はログへ出す**（`src/mail/generation-notice.ts` と同じ理由。
      // `crypto.randomUUID()` が引いた値であって、それ自体は誰かを指さない）。
      // **アドレスそのものは出さない**（8.1 の個人情報）。
      console.error(`[fork-notice] 宛先を引けませんでした: ${LABEL} / game ${gameId}`);
      return 'no-recipient';
    }

    if (!(await claimForkNotice(env, gameId, now))) {
      return 'already-sent';
    }

    const message = forkNoticeMessage(
      target.forkAuthorName,
      target.parentTitle,
      workPageUrl(env, gameId),
    );
    const outcome = await deps.send(env, { to: target.parentAuthorEmail, ...message }, LABEL, deps);
    if (outcome.sent) {
      await recordOutcome(env, gameId, 'sent');
      return 'sent';
    }

    // **送り直さない。** 公開は 1 作品につき 1 回で、次にこの経路へ入る契機が無い
    // （`src/mail/cost-alert.ts` は月内の次の生成で再試行できるので目印を戻すが、
    // ここには戻す相手がいない）。**握りを戻すと、戻した先が誰も拾わないまま
    // 「未送信の行」として残る**——0013 が避けようとしている形そのものである。
    console.error(`[fork-notice] 改造の通知を送れませんでした: ${LABEL} / game ${gameId}`);
    await recordOutcome(env, gameId, 'send-failed');
    return 'send-failed';
  } catch (error) {
    // **例外の種類だけを出す。** 本文には利用者の入力由来の表示名と仮タイトルが
    // 載るので、例外をそのままログへ流さない（8.3）。
    console.error(
      `[fork-notice] 改造の通知に失敗しました: ${
        error instanceof Error ? error.name : typeof error
      }`,
    );
    return 'send-failed';
  }
}
