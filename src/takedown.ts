/**
 * 権利者からの削除依頼と、送信防止措置の記録（8.4 / 5.6 / #41）。
 *
 * 8.4 は「**送信防止措置の手順と記録を残す**（情報流通プラットフォーム対処法への対応）。
 * **削除依頼フォームの設置だけでは足りない**」と定める。ここが持つのは受付と記録で、
 * **手順の正本は `docs/takedown.md`** である。
 *
 * ## 依頼者は非ログインである
 *
 * 権利者はこのサービスの利用者とは限らない（通常は違う）。したがって
 * **セッションを要求しない。** その代わり、非ログインの POST を開けることの代償を
 * 2 つ引き受ける。
 *
 * | 代償 | 受け方 |
 * |---|---|
 * | 濫用で行が増える | **記録は全件残す**（8.4 が求めているのは記録である） |
 * | 濫用で送信量が伸びる | **通知メールは同じ作品につき 1 通**（下記） |
 *
 * ## 措置を自動で行わない
 *
 * **依頼が来ても、作品は 1 ビットも動かない。** 8.4 が通報について「自動非表示は
 * 組織的通報で正常なコンテンツを消せてしまう」と書いているのと同じ理由が、削除依頼にも
 * そのまま当てはまる——**依頼は主張であって、認定ではない。** 措置は人が決めて、
 * **運営の管理画面（`/takedowns`）から記録する**（#406。記録の口は `src/admin/actions.ts` の
 * `recordTakedownAction`——実行者と理由を `admin_actions` へ同じ batch で残すため、
 * **履歴の無い措置を書ける関数をここに置かない**）。
 */
import { sendMail } from './mail/resend.js';

/** ログに出す札（`src/mail/resend.ts` の規約）。 */
const LABEL = 'takedown-notice';

/** 依頼者が名乗る値の最大長。**検証しないので、長さだけを縛る。** */
export const MAX_CLAIMANT_LENGTH = 200;

/** 依頼の本文の最大長。 */
export const MAX_BODY_LENGTH = 2000;

/**
 * 採った措置の綴り。**この一覧が正本で、`migrations/0018_takedown_requests.sql` は
 * ここを指しているだけである。**
 *
 * **`rejected` を持つ。** 依頼を認めなかったことも記録する——**残さないと「見ていない」
 * と区別がつかない**（8.4 が求めているのは措置の記録であり、措置をしたことの記録では
 * ない）。
 */
export const TAKEDOWN_ACTIONS = ['removed', 'restricted', 'rejected'] as const;

/** 採った措置。 */
export type TakedownAction = (typeof TAKEDOWN_ACTIONS)[number];

/** 依頼を受け付けなかった理由。 */
export type TakedownRejection =
  | 'invalid-game-id'
  | 'claimant-too-long'
  | 'body-too-long'
  | 'missing-field';

/** 受け付けた依頼。 */
export interface TakedownReceipt {
  /** 記録した行の id。 */
  readonly id: string;
  /** この依頼で通知メールを送ったか。**同じ作品の 2 件目以降は false。** */
  readonly notified: boolean;
}

/** 差し替えられる依存（テスト用）。 */
export interface TakedownDependencies {
  /** 通知の送信。既定は {@link sendMail}。 */
  readonly send?: typeof sendMail;
  /** 現在時刻（UNIX 秒）。 */
  readonly now?: number;
}

/**
 * 削除依頼を 1 件記録し、必要なら運用へ通知する。
 *
 * **作品には触らない**（冒頭の但し書き）。
 *
 * **メールは同じ作品につき 1 通。** #36 の改造通知が「1 フォークにつき 1 通」を採ったのと
 * 同型で、**濫用されても送信量が作品数で頭打ちになる。** 記録のほうは全件残るので、
 * 8.4 の要求は満たしたままである。
 *
 * **送信の失敗で受付を失敗にしない。** 依頼を受け取ったことのほうが重要で、
 * **メールが出ないことを理由に行を捨てると、8.4 が求める記録が消える。**
 *
 * @param env バインディングと環境変数
 * @param input 依頼の中身
 * @param deps 差し替えられる依存
 * @returns 受け付けたら控え、断ったら理由
 */
export async function recordTakedownRequest(
  env: Env,
  input: {
    readonly gameId: string;
    readonly claimantName: string;
    readonly claimantContact: string;
    readonly body: string;
  },
  deps: TakedownDependencies = {},
): Promise<{ ok: true; receipt: TakedownReceipt } | { ok: false; reason: TakedownRejection }> {
  // **ならした値を、この先すべてで使う。** 検査だけ `trim()` して記録に生の値を
  // 使うと、**末尾に空白が付いた入力が別作品として記録され**、「作品につき 1 通」の
  // 判定もずれる（Copilot の指摘で気づいた）。
  const gameId = input.gameId.trim();
  const name = input.claimantName.trim();
  const contact = input.claimantContact.trim();
  const body = input.body.trim();

  if (gameId === '') {
    return { ok: false, reason: 'invalid-game-id' };
  }
  // **空を断る。** 誰が何を求めているのか分からない行は、記録として役に立たない。
  if (name === '' || contact === '' || body === '') {
    return { ok: false, reason: 'missing-field' };
  }
  if ([...name].length > MAX_CLAIMANT_LENGTH || [...contact].length > MAX_CLAIMANT_LENGTH) {
    return { ok: false, reason: 'claimant-too-long' };
  }
  if ([...body].length > MAX_BODY_LENGTH) {
    return { ok: false, reason: 'body-too-long' };
  }

  const now = deps.now ?? Math.floor(Date.now() / 1000);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into takedown_requests
       (id, game_id, claimant_name, claimant_contact, body, received_at,
        handled_at, action, note)
     values (?, ?, ?, ?, ?, ?, null, null, null)`,
  )
    .bind(id, gameId, name, contact, body, now)
    .run();

  // **通知の権利をデータ側で取る。** 先に SELECT して確認する形にすると、同じ作品への
  // 依頼が同時に走ったときに**どちらも「まだ誰も送っていない」と読んで 2 通送る**
  // （`src/invites.ts` が二重使用の防止で避けているのと同じ形）。
  //
  // **`insert` が通った側だけが送る。** 主キーが「作品につき 1 通」の担保そのものである。
  const claimed = await env.DB.prepare(
    'insert or ignore into takedown_notices (game_id, notified_at) values (?, ?)',
  )
    .bind(gameId, now)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    return { ok: true, receipt: { id, notified: false } };
  }

  // **宛先は既存の設定を借りる。** `OPERATOR_EMAIL` は費用警告（#148）が既に使って
  // いる運用者の宛先で、**同じ人が読む通知に別の設定を増やす理由が無い**（増やすと、
  // 片方だけ設定し忘れた状態が生まれる）。
  const to = (env.OPERATOR_EMAIL ?? '').trim();
  if (to === '') {
    console.log('[takedown] 宛先の設定がないため通知を送りません（受付は済んでいます）。');
    return { ok: true, receipt: { id, notified: false } };
  }

  const send = deps.send ?? sendMail;
  let notified = false;
  try {
    // **本文も連絡先も載せない。** メールは「見に行け」という合図であり、中身は台帳に
    // ある（`scripts/takedown-queue.sh`）。**依頼者が書いた文字列をメールへ流すと、
    // そこが持ち出しの経路になる**（8.2 / 8.3 の「ログも外である」と同じ線）。
    const outcome = await send(
      env,
      {
        to,
        subject: '[game-forge] 削除依頼を受け付けました',
        text:
          `作品 ${gameId} について、権利者からの削除依頼を受け付けました。\n` +
          `受付 id: ${id}\n\n` +
          '内容は台帳で確認してください:\n' +
          '  bash scripts/takedown-queue.sh --remote\n\n' +
          '手順: docs/takedown.md\n',
      },
      LABEL,
    );
    notified = outcome.sent;
  } catch (error) {
    // **受付は失敗にしない**（冒頭の但し書き）。
    console.error(
      `[takedown] 通知を送れませんでした: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
  }

  return { ok: true, receipt: { id, notified } };
}
