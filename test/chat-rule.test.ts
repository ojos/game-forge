import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_CHAT_API_PATH,
  ACCOUNT_CHAT_PATH,
  ACCOUNT_TABS,
  CHAT_RULE_FIELD,
} from '../src/account-paths.js';
import { renderAccountChatPage } from '../src/account.js';
import {
  CHAT_RULE_ACKNOWLEDGEMENT,
  CHAT_RULE_MAX_LENGTH,
  CHAT_RULE_PREAMBLE,
  CHAT_RULE_TURNS,
  withChatRule,
} from '../src/chat-payload.js';
import { checkChatRule, readChatRule, saveChatRule } from '../src/chat-rule.js';
import { BIO_MAX_LENGTH } from '../src/profile.js';
import { CHAT_PROMPT_SECTIONS } from '../src/chat-prompt.js';
import { privacyBody } from '../src/privacy.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者ごとの相談のルール（#728 / M20-4。仕様 5.16 の確定38）。
 *
 * **#728 の acceptance を機械判定できる形へ落とす**——保存・復元・上限・空のときの振る舞い・
 * 退会で消えること・本人が消せること。
 */

/** 退会の段3 の本文（列が匿名化の文に入っていることを見るため）。 */
const WITHDRAWAL_SOURCE = import.meta.glob('../src/withdrawal.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await env.DB.prepare("delete from users where id like 'chatrule-%'").run();
});

/**
 * 利用者を 1 人作る。
 *
 * @returns 利用者の id
 */
async function createUser(): Promise<string> {
  const id = `chatrule-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '作者')
    .run();
  return id;
}

describe('保存と復元（5.16 の確定38）', () => {
  it('保存して読み戻せる', async () => {
    const userId = await createUser();
    expect(await readChatRule(env.DB, userId)).toBe('');
    expect(await saveChatRule(env.DB, userId, '短く答えてください。')).toBe(true);
    expect(await readChatRule(env.DB, userId)).toBe('短く答えてください。');
  });

  it('本人が空にできる（設定を消す経路がある）', async () => {
    const userId = await createUser();
    await saveChatRule(env.DB, userId, 'あ');
    expect(await saveChatRule(env.DB, userId, '')).toBe(true);
    expect(await readChatRule(env.DB, userId)).toBe('');
  });

  it('退会を始めた人には書かない（確定を待たずに止める）', async () => {
    const userId = await createUser();
    // **掴んだだけ（`withdrawal_started_at` が立ち、`withdrawn_at` はまだ NULL）の状態。**
    // `withdrawn_at` で見ていると、ここで書けてしまう（Copilot の指摘）。
    await env.DB.prepare('update users set withdrawal_started_at = 1 where id = ?')
      .bind(userId)
      .run();
    expect(await saveChatRule(env.DB, userId, 'あ')).toBe(false);
    expect(await readChatRule(env.DB, userId)).toBe('');
  });

  it('退会が確定した人にも書かない', async () => {
    const userId = await createUser();
    // **`withdrawn_at >= withdrawal_started_at` の CHECK がある**ので、両方を立てる。
    await env.DB.prepare('update users set withdrawal_started_at = 1, withdrawn_at = 2 where id = ?')
      .bind(userId)
      .run();
    expect(await saveChatRule(env.DB, userId, 'あ')).toBe(false);
  });

  it('退会の段3 の匿名化の文に、この列が入っている', () => {
    // **段3 の文の並びを写さない。** 見るのは「`users` を匿名化する 1 文がこの列を空にするか」
    // だけである（`src/withdrawal.ts` の 15 文目。文の数は 15 のまま）。
    const source = Object.values(WITHDRAWAL_SOURCE)[0];
    expect(source).toBeDefined();
    const anonymize = source!.slice(source!.indexOf('update users\n            set google_sub'));
    expect(anonymize.slice(0, anonymize.indexOf('where id = ?'))).toContain("chat_rule = ''");
  });
});

describe('検査', () => {
  it('上限を超えたら断る（改行を畳んでから数える）', () => {
    expect(checkChatRule('あ'.repeat(CHAT_RULE_MAX_LENGTH)).ok).toBe(true);
    expect(checkChatRule('あ'.repeat(CHAT_RULE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
    // **`\r\n` を畳まないと改行が 2 文字になる**（ブラウザは `<textarea>` をこの形で送る）。
    // 畳めば 498 + 改行 1 + 1 = ちょうど上限。畳まないと 1 文字あふれて断られる。
    expect(checkChatRule(`${'あ'.repeat(CHAT_RULE_MAX_LENGTH - 2)}\r\nい`).ok).toBe(true);
    expect(checkChatRule(`${'あ'.repeat(CHAT_RULE_MAX_LENGTH - 1)}\r\nい`).ok).toBe(false);
  });

  it('上限は自己紹介と同じ値である（書き写していないことを機械で見る）', () => {
    expect(CHAT_RULE_MAX_LENGTH).toBe(BIO_MAX_LENGTH);
  });

  it('前後に置かれた禁止文字を、削る前に見つける', () => {
    // **先に `trim()` すると、JavaScript が黙って落とし、直された値が通る**（Copilot の指摘）。
    expect(checkChatRule('\t短く').ok).toBe(false);
    expect(checkChatRule('\u2028短く').ok).toBe(false);
    expect(checkChatRule('短く\u2029').ok).toBe(false);
  });

  it('改行は許し、それ以外の制御文字と向きを変える記号は断る', () => {
    expect(checkChatRule('1 行目\n2 行目').ok).toBe(true);
    expect(checkChatRule('あ\tい')).toEqual({ ok: false, reason: 'invalid-characters' });
    expect(checkChatRule('あ\u0000い')).toEqual({ ok: false, reason: 'invalid-characters' });
    expect(checkChatRule('あ\u202eい')).toEqual({ ok: false, reason: 'invalid-characters' });
  });

  it('範囲で書き並べていない双方向制御文字も断る（U+061C）', () => {
    // **手で範囲を並べると抜ける 1 文字**（Copilot の指摘）。`\p{Bidi_Control}` なら入る。
    expect(checkChatRule('あ\u061cい')).toEqual({ ok: false, reason: 'invalid-characters' });
  });

  it('前後の空白を落とす', () => {
    expect(checkChatRule('  あ  ')).toEqual({ ok: true, rule: 'あ' });
  });
});

describe('相談の文脈への入り方（確定38）', () => {
  it('空なら何も足さない（今までどおり動く）', () => {
    const messages = [{ role: 'user', text: 'あ' }] as const;
    expect(withChatRule('', messages)).toBe(messages);
  });

  it('ルールが使う発話の数は 2 である（エッジがこのぶんを空ける）', () => {
    expect(withChatRule('あ', [{ role: 'user', text: 'い' }])).toHaveLength(1 + CHAT_RULE_TURNS);
  });

  it('会話の先頭へ、作者の発話として入る（役割は交互のまま）', () => {
    const withRule = withChatRule('短く。', [{ role: 'user', text: 'あ' }]);
    expect(withRule).toHaveLength(3);
    expect(withRule[0]!.text).toContain(CHAT_RULE_PREAMBLE);
    expect(withRule[0]!.text).toContain('短く。');
    // **受け答えを 1 つ足して並びを保つ**（足さないと `user` が 2 つ続き、サーバの検査が断る）。
    expect(withRule[1]).toEqual({ role: 'assistant', text: CHAT_RULE_ACKNOWLEDGEMENT });
    expect(withRule[2]).toEqual({ role: 'user', text: 'あ' });
    for (const [index, turn] of withRule.entries()) {
      expect(turn.role).toBe(index % 2 === 0 ? 'user' : 'assistant');
    }
  });

  it('システムプロンプトへ混ぜない（作者の文で話題の制限を解除できないようにする）', () => {
    // **`src/chat-prompt.ts` は固定文のままである**——作者の値を読む経路を持たない。
    for (const section of CHAT_PROMPT_SECTIONS) {
      expect(section).not.toContain(CHAT_RULE_PREAMBLE);
    }
  });
});

describe('画面（相談のタブ）', () => {
  it('タブの一覧に入っている', () => {
    expect(ACCOUNT_TABS.map((tab) => tab.path)).toContain(ACCOUNT_CHAT_PATH);
  });

  it('いまの値を欄へ戻し、エスケープする', () => {
    const html = renderAccountChatPage({
      rule: '<script>あ</script>',
      notice: null,
      headerAvatar: null,
    });
    expect(html).toContain(`name="${CHAT_RULE_FIELD}"`);
    expect(html).toContain(`action="${ACCOUNT_CHAT_API_PATH}"`);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>あ');
    expect(html).toContain(`maxlength="${CHAT_RULE_MAX_LENGTH}"`);
  });

  it('効く範囲を画面で言う（生成には直接渡らないこと）', () => {
    const html = renderAccountChatPage({ rule: '', notice: null, headerAvatar: null });
    expect(html).toContain('相談にだけ効きます');
  });
});

describe('約束の文言（/privacy）', () => {
  const privacy = privacyBody({
    operatorName: '運営',
    email: 'a@example.invalid',
    mailto: 'mailto:a@example.invalid',
  });

  it('取得する情報・保存期間・退会の 3 か所に書いてある', () => {
    expect(privacy.match(/いつも守ってほしいこと/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it('画面の操作の名前と一致する', () => {
    const html = renderAccountChatPage({ rule: '', notice: null, headerAvatar: null });
    expect(html).toContain('いつも守ってほしいこと');
    expect(privacy).toContain('いつも守ってほしいこと');
  });
});
