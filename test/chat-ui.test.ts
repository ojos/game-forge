import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_RETENTION_DAYS,
  CHAT_RETENTION_PATTERN,
  deleteChatConversations,
  latestChatConversation,
  parseStoredMessages,
  saveChatConversation,
  sweepExpiredChatConversations,
} from '../src/chat-conversation.js';
import { CHAT_MAX_MESSAGES } from '../src/chat-payload.js';
import { CHAT_DRAFT_HEADING, CHAT_MESSAGES, CHAT_SCRIPT, renderChatSection } from '../src/chat-section.js';
import { CHAT_PROMPT_SECTIONS } from '../src/chat-prompt.js';
import { CHAT_QUOTA_REJECTION_REASONS } from '../src/chat-quota.js';
import { renderGeneratePage } from '../src/generate-page.js';
import { privacyBody } from '../src/privacy.js';
import { currentDeclarationsIn } from '../src/quota.js';
import { applySchema } from './helpers/schema.js';

/**
 * 相談の画面と会話の保存（#695 / M18-2 / 仕様 5.16）。
 *
 * **#695 の acceptance の 3 つ目**——「この指示で作る」が既存の開始の経路を通ること——を、
 * 機械判定できる形へ落とす。あわせて 5.16 の「会話の保存——30 日で消える」の 4 つの約束を見る。
 */

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await env.DB.prepare('delete from chat_conversations').run();
});

/**
 * 利用者を 1 人作る。
 *
 * @returns 利用者の id
 */
async function createUser(): Promise<string> {
  const id = `chatui-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '作者')
    .run();
  return id;
}

describe('会話の保存（5.16）', () => {
  it('保存して、いちばん新しい 1 本を復元できる', async () => {
    const userId = await createUser();
    const first = await saveChatConversation(env, userId, null, [{ role: 'user', text: '古い' }], 100);
    const second = await saveChatConversation(env, userId, null, [{ role: 'user', text: '新しい' }], 200);
    expect(first).not.toBe(second);

    const latest = await latestChatConversation(env, userId);
    expect(latest).toMatchObject({ id: second, updatedAt: 200 });
    expect(latest?.messages).toEqual([{ role: 'user', text: '新しい' }]);
  });

  it('同じ id を渡すと上書きし、行を増やさない', async () => {
    const userId = await createUser();
    const id = await saveChatConversation(env, userId, null, [{ role: 'user', text: 'あ' }], 100);
    const again = await saveChatConversation(
      env,
      userId,
      id,
      [
        { role: 'user', text: 'あ' },
        { role: 'assistant', text: 'い' },
        { role: 'user', text: 'う' },
      ],
      200,
    );
    expect(again).toBe(id);
    const rows = await env.DB.prepare('select count(*) as n from chat_conversations where user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('他人の会話の id を渡しても、その会話は書き換わらない（自分の新しい会話になる）', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ownerConversation = await saveChatConversation(env, owner, null, [{ role: 'user', text: '本人のもの' }], 100);

    const created = await saveChatConversation(
      env,
      stranger,
      ownerConversation,
      [{ role: 'user', text: '乗っ取り' }],
      200,
    );
    expect(created).not.toBe(ownerConversation);

    // **本人の会話は無傷である。**
    const owned = await latestChatConversation(env, owner);
    expect(owned?.messages).toEqual([{ role: 'user', text: '本人のもの' }]);
  });

  it('本人の会話をすべて消せる（1 本だけ残さない）', async () => {
    const userId = await createUser();
    await saveChatConversation(env, userId, null, [{ role: 'user', text: 'あ' }], 100);
    await saveChatConversation(env, userId, null, [{ role: 'user', text: 'い' }], 200);

    expect(await deleteChatConversations(env, userId)).toBe(2);
    expect(await latestChatConversation(env, userId)).toBeNull();
  });

  it('最後に使ってから 30 日を過ぎた会話だけを掃除する', async () => {
    const userId = await createUser();
    const now = 1_800_000_000;
    const day = 24 * 60 * 60;
    await saveChatConversation(env, userId, null, [{ role: 'user', text: '古い' }], now - CHAT_RETENTION_DAYS * day - 1);
    const kept = await saveChatConversation(env, userId, null, [{ role: 'user', text: '新しい' }], now - day);

    expect(await sweepExpiredChatConversations(env.DB, now)).toBe(1);
    const latest = await latestChatConversation(env, userId);
    expect(latest?.id).toBe(kept);
  });

  it('壊れた JSON は「無かった」として扱う（相談ごと使えなくしない）', async () => {
    const userId = await createUser();
    await env.DB.prepare(
      'insert into chat_conversations (id, user_id, messages, created_at, updated_at) values (?, ?, ?, 1, 1)',
    )
      .bind(crypto.randomUUID(), userId, '{壊れている')
      .run();
    expect(await latestChatConversation(env, userId)).toBeNull();
  });

  it.each([
    ['配列でない', '{"role":"user"}'],
    ['空', '[]'],
    ['役割が交互でない', '[{"role":"user","text":"あ"},{"role":"user","text":"い"}]'],
    ['先頭が assistant', '[{"role":"assistant","text":"あ"}]'],
    ['本文が空', '[{"role":"user","text":""}]'],
    [
      '多すぎる',
      JSON.stringify(
        Array.from({ length: CHAT_MAX_MESSAGES + 1 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: 'あ',
        })),
      ),
    ],
  ])('%s 保存は読まない', (_label, raw) => {
    expect(parseStoredMessages(raw)).toBeNull();
  });
});

describe('相談の区画（5.16「画面は /generate の中の区画」）', () => {
  it('復元した会話をサーバが描き、本文を必ずエスケープする', () => {
    const html = renderChatSection({
      messages: [
        { role: 'user', text: '<script>alert(1)</script>' },
        { role: 'assistant', text: '"&<>' },
      ],
      conversationId: 'conv-1',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&amp;&lt;&gt;');
    expect(html).toContain('data-conversation="conv-1"');
  });

  it('会話が無ければ、続きの id を持たない', () => {
    const html = renderChatSection({ messages: [], conversationId: null });
    expect(html).not.toContain('data-conversation');
    expect(html).toContain('id="chat-log"');
  });

  it('スクリプトは innerHTML を使わない（このモジュールの線）', () => {
    expect(CHAT_SCRIPT).not.toContain('innerHTML');
    expect(CHAT_SCRIPT).not.toContain('outerHTML');
    expect(CHAT_SCRIPT).not.toContain('insertAdjacentHTML');
    expect(CHAT_SCRIPT).not.toContain('document.write');
    // 本文を入れるのは textContent だけである。
    expect(CHAT_SCRIPT).toContain('textContent');
  });

  it('「この指示で作る」は、生成の欄へ入れるだけで送信しない（既存の開始の経路を通る）', () => {
    // **`prompt.value` へ入れる**（`generate-prompt` は生成のフォームの欄）。
    expect(CHAT_SCRIPT).toContain("document.getElementById('generate-prompt')");
    expect(CHAT_SCRIPT).toContain('prompt.value = text');
    // **相談のスクリプトはフォームを送らない**——送信は作者が「生成する」を押す。
    expect(CHAT_SCRIPT).not.toContain('form.submit');
    expect(CHAT_SCRIPT).not.toContain('requestSubmit');
    expect(CHAT_SCRIPT).not.toMatch(/fetch\([^)]*\/api\/generate/u);
  });

  it('下書きの見出しが、システムプロンプトの綴りと一致する', () => {
    const prompt = CHAT_PROMPT_SECTIONS.join('\n');
    expect(prompt).toContain(CHAT_DRAFT_HEADING);
    expect(CHAT_SCRIPT).toContain(JSON.stringify(CHAT_DRAFT_HEADING));
  });

  it('断りの分類名に、文言が 1 つずつある（増やして書き忘れると落ちる）', () => {
    for (const reason of CHAT_QUOTA_REJECTION_REASONS) {
      expect(Object.keys(CHAT_MESSAGES)).toContain(`429:${reason}`);
    }
    // 既定（分類できないとき）も必ず持つ。
    expect(CHAT_MESSAGES['']).toBeTruthy();
  });
});

describe('生成画面での出し分け', () => {
  it('生成できるときは相談の区画とスクリプトが出る', () => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: { messages: [], conversationId: null },
    });
    expect(html).toContain('id="chat"');
    expect(html).toContain('id="chat-send"');
    expect(html).toContain("document.getElementById('chat')");
  });

  it.each([
    ['未ログイン', false],
    ['枠が尽きている', true],
  ])('%s のときは相談の区画を出さない（押せない導線を増やさない）', (_label, signedIn) => {
    const html = renderGeneratePage(signedIn, {
      availability: signedIn ? { kind: 'daily-quota' } : { kind: 'unknown' },
      headerAvatar: null,
      chat: null,
    });
    expect(html).not.toContain('id="chat"');
    expect(html).not.toContain('id="chat-send"');
  });
});

describe('約束の文言（/privacy と仕様書）', () => {
  const privacy = privacyBody({
    operatorName: '運営',
    email: 'a@example.invalid',
    mailto: 'mailto:a@example.invalid',
  });

  it('`/privacy` の保存期間が、コード側の定数と一致する', () => {
    const found = [...privacy.matchAll(CHAT_RETENTION_PATTERN)].map((match) => Number(match[1]));
    expect(found.length).toBeGreaterThan(0);
    for (const value of found) {
      expect(value).toBe(CHAT_RETENTION_DAYS);
    }
  });

  it('仕様書の保存期間が、コード側の定数と一致する', () => {
    const spec = currentDeclarationsIn(env.TEST_PRODUCT_SPEC);
    const found = [...spec.matchAll(CHAT_RETENTION_PATTERN)].map((match) => Number(match[1]));
    expect(found.length).toBeGreaterThan(0);
    for (const value of found) {
      expect(value).toBe(CHAT_RETENTION_DAYS);
    }
  });

  it('`/privacy` が案内する削除の操作の名前が、画面のボタンと一致する', () => {
    // **画面に無い操作を約束しない。** 文言がずれると、利用者は押す場所を探して見つけられない。
    const section = renderChatSection({ messages: [], conversationId: null });
    expect(section).toContain('相談の記録を消す');
    expect(privacy).toContain('相談の記録を消す');
  });
});
