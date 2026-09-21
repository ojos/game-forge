import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  latestChatConversation,
  saveChatConversation,
} from '../src/chat-conversation.js';
import { CHAT_SCRIPT, CHAT_TARGET_LABELS } from '../src/chat-section.js';
import { loadForkableParent } from '../src/fork.js';
import {
  CHAT_FORK_PARAM,
  CHAT_REVISE_PARAM,
  NEW_CHAT_TARGET,
  chatPathFor,
  chatTargetFromBody,
  chatTargetFromUrl,
  loadForkChatContext,
  loadReviseChatContext,
  type ChatTarget,
} from '../src/chat-target.js';
import { renderGeneratePage } from '../src/generate-page.js';
import { FORK_PATH, GENERATE_PAGE_PATH, REVISE_PATH } from '../src/paths.js';
import { applySchema } from './helpers/schema.js';

/**
 * チャットの対象（#727 / M20-3。仕様 5.16 の確定38）。
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

/**
 * チャットを出した生成画面を描く（#738 から、区画の入力の塊は生成画面が組み立てて渡す）。
 *
 * @param target チャットの対象
 * @returns HTML
 */
function chatPage(target: ChatTarget): string {
  return renderGeneratePage(true, {
    availability: { kind: 'available', remaining: 5 },
    headerAvatar: null,
    target,
    chat: { messages: [], conversationId: null, target },
  });
}

describe('Copilot が見つけた穴（#727）', () => {
  it('ソースを求める操作が画面にある（#695 から無かった）', () => {
    // **口は `includeSource` を受けていたのに、送る側がどこにも無かった**
    // ——「作者が明示的に求めたときだけ渡す」という決定が 1 度も届いていなかった。
    // **区画は生成画面が描く形で見る**（#738 から、入力の塊は生成のフォームそのもので、画面が渡す）。
    for (const kind of ['revise', 'fork'] as const) {
      expect(chatPage({ kind, id: GAME_A })).toContain('id="chat-source"');
    }
    // **新規のチャットには出さない**（見せる作品が無い）。
    expect(chatPage(NEW_CHAT_TARGET)).not.toContain('id="chat-source"');
    // **名前を持たない**——リフォージとフォークは素のフォーム送信なので、名前があると送信に載ってしまう。
    expect(chatPage({ kind: 'revise', id: GAME_A })).toContain('<input type="checkbox" id="chat-source">');
    // スクリプトが、チェックされたときだけ載せる。
    expect(CHAT_SCRIPT).toContain("document.getElementById('chat-source')");
    expect(CHAT_SCRIPT).toContain('body.includeSource = true');
  });

  it('フォーク可否の判定を書き写していない（正本は src/fork.ts）', async () => {
    const stranger = await createUser();
    await seedGame(GAME_A, stranger, 'published');
    // **正本（`loadForkableParent`）とチャットの読み取りが、同じ作品で同じ答えを返す。**
    expect(await loadForkableParent(env.DB, GAME_A)).not.toBeNull();
    expect(await loadForkChatContext(env.DB, GAME_A, false, async () => null)).not.toBeNull();
    await env.DB.prepare("update games set status = 'draft' where id = ?").bind(GAME_A).run();
    expect(await loadForkableParent(env.DB, GAME_A)).toBeNull();
    expect(await loadForkChatContext(env.DB, GAME_A, false, async () => null)).toBeNull();
  });

  it('リフォージの対象は「本当に直せる作品」だけである', async () => {
    const owner = await createUser();
    // 公開済みの自作は、開けても `/api/revise` が 409 を返す——**画面も断る。**
    await seedGame(GAME_A, owner, 'published');
    expect(await loadReviseChatContext(env as Env, owner, GAME_A, false)).toBeNull();
    // 下書きで完成しているものだけが対象。
    await env.DB.prepare("update games set status = 'draft', generation_state = 'ready' where id = ?")
      .bind(GAME_A)
      .run();
    expect(await loadReviseChatContext(env as Env, owner, GAME_A, false)).not.toBeNull();
    // 完成していない下書きは対象にしない。
    await env.DB.prepare("update games set generation_state = 'running' where id = ?").bind(GAME_A).run();
    expect(await loadReviseChatContext(env as Env, owner, GAME_A, false)).toBeNull();
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

  it('別の対象で自分の会話の id を送ると、その会話の続きとして書く（#740 で変えた）', async () => {
    // **#727 は上書きの条件に対象も入れており、当たらなければ新しい会話になっていた。**
    // **#740 で条件から対象を外した**——付け替え（`attachChatConversationsToWork`）で行の対象が
    // 動いた後、**古い画面が `('new', null)` のまま同じ id を送ると `'new'` の行が作り直され**、
    // 次に `/generate` を開いたときに復元されてしまうためである（「必ず空」が崩れる）。
    //
    // **残っている線は「他人の会話は書き換わらない」ことで、それは `user_id` が担保する**
    // （`test/chat-ui.test.ts` が見ている）。**対象は上書きしない**ので、行は属する対象に
    // 留まったまま、続きの発話だけが載る。
    const userId = await createUser();
    const id = await saveChatConversation(
      env,
      userId,
      null,
      NEW_CHAT_TARGET,
      [{ role: 'user', text: '新規' }],
      1,
    );
    const next = await saveChatConversation(
      env,
      userId,
      id,
      { kind: 'fork', id: GAME_A },
      [{ role: 'user', text: 'フォーク' }],
      2,
    );

    // **同じ行が続く**（行は増えない）。
    expect(next).toBe(id);
    const rows = await env.DB.prepare(
      'select count(*) as n from chat_conversations where user_id = ?',
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // **対象は動かない**——行は「新しく作る」のままである。
    expect((await latestChatConversation(env, userId, NEW_CHAT_TARGET))?.messages[0]?.text).toBe(
      'フォーク',
    );
    expect(await latestChatConversation(env, userId, { kind: 'fork', id: GAME_A })).toBeNull();
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
    // **形は新規と同じ**（#738）——欄は 1 つ、ボタンは「チャットする」（副）と送る側（主）の 2 つ。
    expect(html.match(/<textarea\b/gu)?.length).toBe(1);
    expect(html.match(/gf-button-primary/gu)?.length).toBe(1);
    expect(html).toContain('<button id="chat-send" class="gf-button gf-button-secondary" type="button">チャットする</button>');
    expect(html).toContain(
      `<button id="generate-submit" class="gf-button gf-button-primary" type="submit">${kind === 'revise' ? 'リフォージする' : 'フォークする'}</button>`,
    );
    expect(html).not.toContain('直接書く');
    // 欄はチャットの区画の中のフォームにある。
    const section = html.slice(html.indexOf('<section id="chat"'), html.indexOf('</section>'));
    expect(section).toContain(`<form id="${formId}"`);
    // **生成のフォームは出さない**（対象があるチャットで押せる先は 1 つである）。
    expect(html).not.toContain('id="generate-form"');
  });

  it('対象ごとに見出しが変わる', () => {
    for (const kind of ['new', 'revise', 'fork'] as const) {
      const labels = CHAT_TARGET_LABELS[kind]!;
      const html = chatPage(kind === 'new' ? NEW_CHAT_TARGET : { kind, id: GAME_A });
      expect(html).toContain(labels.heading);
      // **対象はスクリプトが要求へ載せる**（サーバは受けた値を同じ規則で検証する）。
      expect(html).toContain(`data-target-kind="${kind}"`);
    }
  });
});
