import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  latestChatConversation,
  saveChatConversation,
} from '../src/chat-conversation.js';
import { renderChatSection, CHAT_TARGET_LABELS } from '../src/chat-section.js';
import {
  CHAT_FORK_PARAM,
  CHAT_REVISE_PARAM,
  NEW_CHAT_TARGET,
  chatPathFor,
  chatTargetFromBody,
  chatTargetFromUrl,
  loadForkChatContext,
} from '../src/chat-target.js';
import { renderGeneratePage } from '../src/generate-page.js';
import { FORK_PATH, GENERATE_PAGE_PATH, REVISE_PATH } from '../src/paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * 相談の対象（#727 / M20-3。仕様 5.16 の確定38）。
 *
 * **#727 の acceptance を機械判定できる形へ落とす**——他人の最初の指示文が入らない /
 * 求めていないのにソースが入らない / 他人の未公開の作品を対象にできない /
 * 既存の開始の経路を通る。
 */

const GAME_A = '11111111-1111-4111-8111-111111111111';
const GAME_B = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await env.DB.prepare('delete from chat_conversations').run();
  await env.DB.prepare("delete from games where id in (?, ?)").bind(GAME_A, GAME_B).run();
  await env.DB.prepare("delete from users where id like 'chattarget-%'").run();
});

/**
 * 利用者を 1 人作る。
 *
 * @returns 利用者の id
 */
async function createUser(): Promise<string> {
  const id = `chattarget-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '作者')
    .run();
  return id;
}

/**
 * 作品を 1 件仕込む。
 *
 * @param id 作品 id
 * @param authorId 作者
 * @param status 状態
 */
async function seedGame(id: string, authorId: string, status: string): Promise<void> {
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state,
                        prompt, description, tag1)
     values (?, ?, ?, ?, '', 1, 'ready', ?, ?, ?)`,
  )
    .bind(id, authorId, status, '題名', '他人の指示文-ひみつ', '作者が書いた説明', 'puzzle')
    .run();
}

describe('対象の読み取り', () => {
  it('URL の引数から読む', () => {
    expect(chatTargetFromUrl(new URL('https://x.invalid/generate'))).toEqual(NEW_CHAT_TARGET);
    expect(
      chatTargetFromUrl(new URL(`https://x.invalid/generate?${CHAT_REVISE_PARAM}=${GAME_A}`)),
    ).toEqual({ kind: 'revise', id: GAME_A });
    expect(
      chatTargetFromUrl(new URL(`https://x.invalid/generate?${CHAT_FORK_PARAM}=${GAME_A}`)),
    ).toEqual({ kind: 'fork', id: GAME_A });
  });

  it('両方が載っていたら「新しく作る」に倒す（黙ってどちらかを選ばない）', () => {
    const url = new URL(
      `https://x.invalid/generate?${CHAT_REVISE_PARAM}=${GAME_A}&${CHAT_FORK_PARAM}=${GAME_B}`,
    );
    expect(chatTargetFromUrl(url)).toEqual(NEW_CHAT_TARGET);
  });

  it('作品 id の形でなければ「新しく作る」に倒す', () => {
    expect(chatTargetFromUrl(new URL(`https://x.invalid/generate?${CHAT_REVISE_PARAM}=x`))).toEqual(
      NEW_CHAT_TARGET,
    );
  });

  it('本文から読むときは、形が違えば断る（黙って倒さない）', () => {
    expect(chatTargetFromBody(undefined, undefined)).toEqual(NEW_CHAT_TARGET);
    expect(chatTargetFromBody('revise', GAME_A)).toEqual({ kind: 'revise', id: GAME_A });
    expect(chatTargetFromBody('fork', GAME_A)).toEqual({ kind: 'fork', id: GAME_A });
    // **画面が組み立てた値を信じない**（口は画面を通さずに叩ける）。
    expect(chatTargetFromBody('revise', 'x')).toBeNull();
    expect(chatTargetFromBody('unknown', GAME_A)).toBeNull();
    expect(chatTargetFromBody('new', GAME_A)).toBeNull();
  });

  it('パスは対象を引数で持つ', () => {
    expect(chatPathFor(GENERATE_PAGE_PATH, NEW_CHAT_TARGET)).toBe(GENERATE_PAGE_PATH);
    expect(chatPathFor(GENERATE_PAGE_PATH, { kind: 'fork', id: GAME_A })).toBe(
      `${GENERATE_PAGE_PATH}?${CHAT_FORK_PARAM}=${GAME_A}`,
    );
  });
});

describe('フォーク元の文脈（確定38。他人の公開作品）', () => {
  it('題名・説明・タグは載り、最初の指示文は載らない', async () => {
    const stranger = await createUser();
    await seedGame(GAME_A, stranger, 'published');
    const context = await loadForkChatContext(env.DB, GAME_A, false, async () => 'ソース');
    expect(context).toEqual({
      title: '題名',
      prompt: null,
      description: '作者が書いた説明',
      tags: ['puzzle'],
      source: null,
    });
    // **1.2.54——指示文は作者本人にしか出さない。**
    expect(JSON.stringify(context)).not.toContain('ひみつ');
  });

  it('ソースは求めたときだけ載る', async () => {
    const stranger = await createUser();
    await seedGame(GAME_A, stranger, 'published');
    expect((await loadForkChatContext(env.DB, GAME_A, false, async () => 'ソース'))?.source).toBeNull();
    expect((await loadForkChatContext(env.DB, GAME_A, true, async () => 'ソース'))?.source).toBe('ソース');
  });

  it('公開されていない作品は対象にできない', async () => {
    const stranger = await createUser();
    await seedGame(GAME_A, stranger, 'draft');
    expect(await loadForkChatContext(env.DB, GAME_A, false, async () => null)).toBeNull();
  });

  it('無い作品も対象にできない（区別できる応答を返さない）', async () => {
    expect(await loadForkChatContext(env.DB, GAME_B, false, async () => null)).toBeNull();
  });
});

describe('会話は対象ごとに分かれる（確定38）', () => {
  it('対象が違えば、別の会話として復元される', async () => {
    const userId = await createUser();
    await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: '新規' }], 1);
    await saveChatConversation(
      env,
      userId,
      null,
      { kind: 'fork', id: GAME_A },
      [{ role: 'user', text: 'フォーク' }],
      2,
    );
    expect((await latestChatConversation(env, userId, NEW_CHAT_TARGET))?.messages[0]?.text).toBe('新規');
    expect(
      (await latestChatConversation(env, userId, { kind: 'fork', id: GAME_A }))?.messages[0]?.text,
    ).toBe('フォーク');
    // **同じ種別でも、別の作品なら別の会話である。**
    expect(await latestChatConversation(env, userId, { kind: 'fork', id: GAME_B })).toBeNull();
  });

  it('別の対象の会話の id を送っても、その中身は書き換わらない', async () => {
    const userId = await createUser();
    const id = await saveChatConversation(
      env,
      userId,
      null,
      NEW_CHAT_TARGET,
      [{ role: 'user', text: '新規' }],
      1,
    );
    // フォークの対象で同じ id を指しても、上書きされず**新しい会話になる**。
    const next = await saveChatConversation(
      env,
      userId,
      id,
      { kind: 'fork', id: GAME_A },
      [{ role: 'user', text: 'フォーク' }],
      2,
    );
    expect(next).not.toBe(id);
    expect((await latestChatConversation(env, userId, NEW_CHAT_TARGET))?.messages[0]?.text).toBe('新規');
  });
});

describe('画面（対象ごとの文言と行き先）', () => {
  it.each([
    ['revise', REVISE_PATH, 'revise-form', 'revise-prompt'],
    ['fork', FORK_PATH, 'fork-form', 'fork-prompt'],
  ])('%s では既存の開始の経路のフォームを描く', (kind, action, formId, promptId) => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      target: { kind: kind as 'revise' | 'fork', id: GAME_A },
      chat: { messages: [], conversationId: null, target: { kind: kind as 'revise' | 'fork', id: GAME_A } },
    });
    // **開始の経路は既存のまま**（送り先も項目名も `src/paths.ts` の値）。
    expect(html).toContain(`action="${action}"`);
    expect(html).toContain(`id="${formId}"`);
    expect(html).toContain(`id="${promptId}"`);
    expect(html).toContain(GAME_A);
    // **主のボタンは相談側の 1 つだけ**（2.5.5）。
    expect(html.match(/gf-button-primary/gu)?.length).toBe(1);
    expect(html).toContain(`form="${formId}"`);
    // **生成のフォームは出さない**（対象がある相談で押せる先は 1 つである）。
    expect(html).not.toContain('id="generate-form"');
  });

  it('対象ごとに見出しと主のボタンの文言が変わる', () => {
    for (const kind of ['new', 'revise', 'fork'] as const) {
      const labels = CHAT_TARGET_LABELS[kind]!;
      const html = renderChatSection({
        messages: [],
        conversationId: null,
        target: kind === 'new' ? NEW_CHAT_TARGET : { kind, id: GAME_A },
      });
      expect(html).toContain(labels.heading);
      expect(html).toContain(labels.apply);
      expect(html).toContain(`form="${labels.form}"`);
      // **対象はスクリプトが要求へ載せる**（サーバは受けた値を同じ規則で検証する）。
      expect(html).toContain(`data-target-kind="${kind}"`);
    }
  });
});
