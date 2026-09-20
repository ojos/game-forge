/**
 * 作者ごとの相談のルール（#728 / M20-4。仕様 5.16 の確定38「作者ごとのルール」）。
 *
 * **作者が登録情報の「相談」のタブに書いた文を、相談の文脈へ毎回入れる。**
 *
 * ## 効くのは相談だけである
 *
 * **生成の指示文には載せない**（確定38 / 利用者の決定）。載せると **6.1（Go の制約）や
 * 6.2（有名 IP の置き換え）と矛盾する文を作者が書けてしまい**、相談を使わない経路
 * （MCP・直接のリフォージ・フォーク）も含めた生成のすべてに毎回乗る。**相談だけなら、
 * 効いた結果は下書きとして作者の目に見えてから生成へ渡る。**
 *
 * ## システムプロンプトへ混ぜない
 *
 * **会話の先頭の作者の発話として入れる**（確定38）。`src/chat-prompt.ts` の中へ混ぜると、
 * **作者自身の文で 5.16 の「話題の制限」を解除できる**（システムプロンプトは会話より
 * 強く効く）。発話として入れれば、上に置いた制限が優先する。**8.2 の Guardrail は
 * 今までどおり入力に掛かる**（1 枚目は動かさない）。
 *
 * ## 版に含めない
 *
 * **`CHAT_PROMPT_VERSION` に作者の文を混ぜない**（確定38）。混ぜると**版が人ごとに割れ、
 * 1 往復の費用の実測が比べられなくなる**（5.16 の「実測」が版ごとの比較を前提にしている）。
 */
import { BIO_MAX_LENGTH } from './profile.js';

/**
 * ルールの上限（文字数）。
 *
 * **自己紹介（`BIO_MAX_LENGTH`）と同じ 500 文字にする。** 書き写さずに借りるのは、
 * **どちらも「自分のことを数行で書く欄」で、上限を別々に動かす理由が無い**ためである。
 *
 * **枠の側からも見ておく。** ルールは**1 往復ごとに文脈へ乗る**ので、見積もり
 * （`estimateChatTokens`。1 文字 1 トークンで数える）では 1 往復あたり最大 500 トークンに
 * なる。**1 日 30,000 トークンの蓋に対して、17 往復で約 8,500 トークン（28%）である。**
 * **実際にはもっと安い**——ルールは会話の先頭に固定されるので、**4.5 のキャッシュの
 * 共有プレフィックスに乗る**（2 往復目以降は読み取りになる。5.16 の「実測」でシステム
 * プロンプトがそうなった）。**見積もりが高い側へ倒れているのは 4.3 のとおりである。**
 */
export const CHAT_RULE_MAX_LENGTH = BIO_MAX_LENGTH;

/**
 * ルールに使えない文字。
 *
 * **表示名・自己紹介と同じ規則である**（`src/profile.ts` の `BIO_FORBIDDEN_CHARACTER`）。
 * **改行だけは許す**——ルールは箇条書きで書かれるものである。
 */
const CHAT_RULE_FORBIDDEN_CHARACTER = /(?!\n)[\p{Cc}\p{Zl}\p{Zp}]/u;

/** 文字の向きを変える、目に見えない記号（`src/profile.ts` と同じ）。 */
const DIRECTION_CHARACTER = /[‎‏‪-‮⁦-⁩]/u;

/** ルールを断る理由。 */
export type ChatRuleRejection = 'too-long' | 'invalid-characters';

/** ルールの検査の結果。 */
export type ChatRuleCheck =
  | { readonly ok: true; readonly rule: string }
  | { readonly ok: false; readonly reason: ChatRuleRejection };

/**
 * 送られたルールを整えて検査する。
 *
 * **畳んでから数える**（`src/games.ts` の指示文と同じ）。ブラウザは `<textarea>` の改行を
 * `\r\n` で送るので、畳まずに数えると**改行が 2 文字になる。**
 *
 * @param raw フォームから届いた値
 * @returns 整えたルール、または断る理由
 */
export function checkChatRule(raw: string): ChatRuleCheck {
  const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if ([...normalized].length > CHAT_RULE_MAX_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (CHAT_RULE_FORBIDDEN_CHARACTER.test(normalized) || DIRECTION_CHARACTER.test(normalized)) {
    return { ok: false, reason: 'invalid-characters' };
  }
  return { ok: true, rule: normalized };
}

/**
 * 相談の文脈の先頭へ置く、作者の発話の前置き。
 *
 * **これが何であるかを名乗る。** 名乗らずにルールだけを置くと、**AI はそれを「いまの相談の
 * 依頼」として読む**——「短いゲームが好きです」とだけ書いた人が、毎回その話から始められる。
 */
export const CHAT_RULE_PREAMBLE = 'これは、わたしがいつも守ってほしいことです。このあとの相談すべてに当てはめてください。';

/**
 * 前置きに対する、AI 側の受け答え。
 *
 * **役割が交互であることは、エッジもサーバも確かめている**（`src/chat.ts`）。作者の発話を
 * 1 つ足すだけでは `user` が 2 つ続くので、**受け答えを 1 つ足して並びを保つ。**
 *
 * **中身を約束にしない。** 「承知しました」とだけ返させ、**ルールの本文を復唱させない**
 * ——復唱させると、そのぶん出力トークンを使ったのと同じ文脈が毎回積まれる。
 */
export const CHAT_RULE_ACKNOWLEDGEMENT = '承知しました。以降の相談でそのとおりにします。';

/** 会話の 1 往復ぶんの発話（`src/chat-payload.ts` の `ChatMessage` と同じ形）。 */
interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * 作者のルールを、会話の先頭へ 2 通の発話として足す。
 *
 * **空なら何も足さない**（確定38「空のときは今までどおり動く」）。**保存する会話には
 * 入れない**——呼ぶ側（`src/chat.ts`）は、Lambda へ送る配列にだけこれを使う。入れると
 * **画面の履歴にルールの往復が出て、作者が消せない発話が 2 つ増える。**
 *
 * @param rule 作者のルール（空なら何もしない）
 * @param messages 会話
 * @returns Lambda へ送る会話
 */
export function withChatRule(rule: string, messages: readonly Turn[]): readonly Turn[] {
  if (rule === '') {
    return messages;
  }
  return [
    { role: 'user', text: `${CHAT_RULE_PREAMBLE}\n\n${rule}` },
    { role: 'assistant', text: CHAT_RULE_ACKNOWLEDGEMENT },
    ...messages,
  ];
}

/**
 * 本人のルールを読む。
 *
 * **読めなかったら空として扱う**（相談そのものを止めない。`src/chat-conversation.ts` が
 * 壊れた JSON を「無かった」として扱うのと同じ判断）。
 *
 * @param db D1
 * @param userId 利用者の id
 * @returns ルール（無ければ空文字）
 */
export async function readChatRule(db: D1Database, userId: string): Promise<string> {
  try {
    const row = await db
      .prepare('select chat_rule from users where id = ?')
      .bind(userId)
      .first<{ chat_rule: string | null }>();
    return row?.chat_rule ?? '';
  } catch (error) {
    console.error(
      `[chat-rule] ルールを読めませんでした: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return '';
  }
}

/**
 * 本人のルールを保存する。
 *
 * **退会した人には書かない**（`withdrawn_at is null`）。段3 が消した後に書き戻る窓を作らない。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param rule 整えたルール
 * @returns 書けたら true
 */
export async function saveChatRule(db: D1Database, userId: string, rule: string): Promise<boolean> {
  const result = await db
    .prepare('update users set chat_rule = ? where id = ? and withdrawn_at is null')
    .bind(rule, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
