/**
 * 作者ごとのチャットのルール（#728 / M20-4。仕様 5.16 の確定38「作者ごとのルール」）。
 *
 * **作者が登録情報の「チャット」のタブに書いた文を、チャットの文脈へ毎回入れる。**
 *
 * ## 効くのはチャットだけである
 *
 * **生成の指示文には載せない**（確定38 / 利用者の決定）。載せると **6.1（Go の制約）や
 * 6.2（有名 IP の置き換え）と矛盾する文を作者が書けてしまい**、チャットを使わない経路
 * （MCP・直接のリフォージ・フォーク）も含めた生成のすべてに毎回乗る。**チャットだけなら、
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
import { CHAT_RULE_MAX_LENGTH } from './chat-payload.js';
import { NOT_WITHDRAWN_SQL } from './withdrawal-sql.js';

/**
 * ルールの上限（文字数）。**正本は `src/chat-payload.ts`** である——エッジと Lambda の契約で、
 * **どちらも同じ値で断る必要がある。** **自己紹介（`BIO_MAX_LENGTH`）と同じ 500 であること**は
 * `test/chat-rule.test.ts` が機械照合する。
 */
export { CHAT_RULE_MAX_LENGTH };

/**
 * ルールに使えない文字。
 *
 * **表示名・自己紹介と同じ規則である**（`src/profile.ts` の `BIO_FORBIDDEN_CHARACTER`）。
 * **改行だけは許す**——ルールは箇条書きで書かれるものである。
 */
const CHAT_RULE_FORBIDDEN_CHARACTER = /(?!\n)[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 文字の向きを変える、目に見えない記号（`src/profile.ts` と同じ）。
 *
 * **範囲を手で並べない。** Unicode の属性（`Bidi_Control`）で書く——手で並べると
 * **U+061C（Arabic Letter Mark）のように、範囲の外にある 1 文字が抜ける**（#728 の
 * Copilot の指摘。実際に抜けていた）。**ソースにその文字そのものを書かずに済む**のも利点である。
 */
const DIRECTION_CHARACTER = /\p{Bidi_Control}/u;

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
  // **畳んだ値を、削る前に検査する**（`validateBio` と同じ順序）。**先に削ると、前後に置かれた
  // 禁止文字を `trim()` が黙って落とし、直された値が通る**（#728 の Copilot の指摘）。
  const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (CHAT_RULE_FORBIDDEN_CHARACTER.test(normalized) || DIRECTION_CHARACTER.test(normalized)) {
    return { ok: false, reason: 'invalid-characters' };
  }
  // **数えるのは削った後である**（前後の空白は保存しないので、上限にも数えない）。
  const rule = normalized.trim();
  if ([...rule].length > CHAT_RULE_MAX_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  return { ok: true, rule };
}

/**
 * 本人のルールを読む。
 *
 * **読めなかったら空として扱う**（チャットそのものを止めない。`src/chat-conversation.ts` が
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
 * **退会を始めた人には書かない**（`NOT_WITHDRAWN_SQL` ＝ `withdrawal_started_at is null`）。
 * **`withdrawn_at` で見ない**——あれは段3 の最後まで NULL なので、**掴んでから確定までのあいだ
 * 書けてしまう**（#728 の Copilot の指摘）。ほかのアカウントの書き込みと同じ条件を使う。
 *
 * @param db D1
 * @param userId 利用者の id
 * @param rule 整えたルール
 * @returns 書けたら true
 */
export async function saveChatRule(db: D1Database, userId: string, rule: string): Promise<boolean> {
  const result = await db
    .prepare(`update users set chat_rule = ? where id = ? and ${NOT_WITHDRAWN_SQL}`)
    .bind(rule, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
