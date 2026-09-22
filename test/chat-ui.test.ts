import { escapeHtml } from '../src/html.js';
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_RETENTION_DAYS,
  CHAT_RETENTION_PATTERN,
  appendChatConversation,
  appendChatTurn,
  deleteChatConversations,
  latestChatConversation,
  parseStoredMessages,
  saveChatConversation,
  sweepExpiredChatConversations,
} from '../src/chat-conversation.js';
import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_SEND_MESSAGES,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_MAX_TOTAL_MESSAGE_LENGTH,
  chatSendWindow,
  type ChatMessage,
} from '../src/chat-payload.js';
import { NEW_CHAT_TARGET } from '../src/chat-target.js';
import {
  CHAT_DRAFT_HEADING,
  chatKeyHint,
  CHAT_KEY_HINT_ID,
  CHAT_MESSAGES,
  CHAT_SCRIPT,
  COMPOSITION_GUARD_MS,
  renderChatSection,
  type ChatComposer,
  type ChatSectionView,
} from '../src/chat-section.js';
import { CHAT_PROMPT_SECTIONS } from '../src/chat-prompt.js';
import { CHAT_QUOTA_REJECTION_REASONS } from '../src/chat-quota.js';
import { GENERATE_PATH } from '../src/generate.js';
import { renderGeneratePage } from '../src/generate-page.js';
import { privacyBody } from '../src/privacy.js';
import { currentDeclarationsIn } from '../src/quota.js';
import { CHAT_MARKDOWN_SCRIPT } from '../src/chat-markdown.js';
import { applySchema } from './helpers/schema.js';

/**
 * 注記が指すテストのファイルが実在することを見るための一覧。
 *
 * **`import.meta.glob` は呼び出し元のファイル自身を含めない**（vite の仕様。実測した）ので、
 * このファイルだけは足す。**足し忘れると「自分を指す注記」が常に落ちる。**

 */
const TEST_FILES = new Set([
  ...Object.keys(
    // **型は `?raw` の形しか宣言していない**（このリポジトリの shim）が、実行時には
    // 引数なしの遅延 glob が使える。**中身は読まない**（名前だけが欲しい）ので、
    // 全部の test を raw で抱え込まずに済むこちらを使う。
    (import.meta as unknown as { readonly glob: (pattern: string) => Record<string, unknown> }).glob(
      './*.test.ts',
    ),
  ).map((path) => path.slice('./'.length)),
  'chat-ui.test.ts',
]);
/**
 * チャットのモジュールの本文（注記が指すテストの実在を見るため）。
 *
 * **1 つずつ名指しにしない。** #718 で `src/chat-quota.ts` が存在しない
 * `test/chat-quota.test.ts` を指しているのを見つけた——**前の検査は 2 ファイルだけを名指ししており、
 * 足したモジュールが黙って対象の外にいた。** チャットのモジュールをまとめて拾う。
 */
const CHAT_SOURCES = import.meta.glob('../src/chat*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * 区画を単体で描くときの入力の塊（#738）。**本物は `src/generate-page.ts` が組み立てる**ので、ここでは
 * 形だけを持つ最小の部品を渡す（本物の組み合わせは下の「生成画面での出し分け」が `renderGeneratePage` で見る）。
 */
const COMPOSER: ChatComposer = {
  open: `<form id="generate-form" class="gf-generate-form gf-chat-composer" method="post" action="${GENERATE_PATH}">`,
  head: '<label for="generate-prompt">どんなゲームを作りますか</label>',
  field: '<textarea id="generate-prompt" name="prompt" rows="3" required></textarea>',
  submit: '<button id="generate-submit" class="gf-button gf-button-primary" type="submit" disabled>生成する</button>',
  submitLabel: '生成する',
};

/** 区画を描く（入力の塊は {@link COMPOSER}）。 */
function chatSection(view: ChatSectionView): string {
  return renderChatSection(view, COMPOSER);
}

/**
 * チャットの画面と会話の保存（#695 / M18-2 / 仕様 5.16）。
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
    const first = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: '古い' }], 100);
    const second = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: '新しい' }], 200);
    expect(first).not.toBe(second);

    const latest = await latestChatConversation(env, userId, NEW_CHAT_TARGET);
    expect(latest).toMatchObject({ id: second, updatedAt: 200 });
    expect(latest?.messages).toEqual([{ role: 'user', text: '新しい' }]);
  });

  it('同じ id を渡すと上書きし、行を増やさない', async () => {
    const userId = await createUser();
    const id = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: 'あ' }], 100);
    const again = await saveChatConversation(env, userId, id, NEW_CHAT_TARGET, [
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
    const ownerConversation = await saveChatConversation(env, owner, null, NEW_CHAT_TARGET, [{ role: 'user', text: '本人のもの' }], 100);

    const created = await saveChatConversation(env, stranger, ownerConversation, NEW_CHAT_TARGET, [{ role: 'user', text: '乗っ取り' }],
      200,
    );
    expect(created).not.toBe(ownerConversation);

    // **本人の会話は無傷である。**
    const owned = await latestChatConversation(env, owner, NEW_CHAT_TARGET);
    expect(owned?.messages).toEqual([{ role: 'user', text: '本人のもの' }]);
  });

  it('本人の会話をすべて消せる（1 本だけ残さない）', async () => {
    const userId = await createUser();
    await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: 'あ' }], 100);
    await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: 'い' }], 200);

    expect(await deleteChatConversations(env, userId)).toBe(2);
    expect(await latestChatConversation(env, userId, NEW_CHAT_TARGET)).toBeNull();
  });

  it('最後に使ってから 30 日を過ぎた会話だけを掃除する', async () => {
    const userId = await createUser();
    const now = 1_800_000_000;
    const day = 24 * 60 * 60;
    await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: '古い' }], now - CHAT_RETENTION_DAYS * day - 1);
    const kept = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, [{ role: 'user', text: '新しい' }], now - day);

    expect(await sweepExpiredChatConversations(env.DB, now)).toBe(1);
    const latest = await latestChatConversation(env, userId, NEW_CHAT_TARGET);
    expect(latest?.id).toBe(kept);
  });

  it('壊れた JSON は「無かった」として扱う（チャットごと使えなくしない）', async () => {
    const userId = await createUser();
    await env.DB.prepare(
      'insert into chat_conversations (id, user_id, messages, created_at, updated_at) values (?, ?, ?, 1, 1)',
    )
      .bind(crypto.randomUUID(), userId, '{壊れている')
      .run();
    expect(await latestChatConversation(env, userId, NEW_CHAT_TARGET)).toBeNull();
  });

  it.each([
    ['配列でない', '{"role":"user"}'],
    ['空', '[]'],
    ['役割が交互でない', '[{"role":"user","text":"あ"},{"role":"user","text":"い"}]'],
    ['先頭が assistant', '[{"role":"assistant","text":"あ"}]'],
    ['本文が空', '[{"role":"user","text":""}]'],
    [
      '保存の上限より多い',
      JSON.stringify(
        Array.from({ length: CHAT_MAX_STORED_MESSAGES + 1 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: 'あ',
        })),
      ),
    ],
  ])('%s 保存は読まない', (_label, raw) => {
    expect(parseStoredMessages(raw)).toBeNull();
  });

  it.each([22, CHAT_MAX_STORED_MESSAGES])(
    '送る窓より長い会話（%i 通）も読む——読めないと会話が丸ごと消えたように見える（#742）',
    (count) => {
      // **ここは「壊れていたら無かったことにする」枝である。** 以前は送る上限（20 通）を当てていたので、
      // 21 通目から復元が null になった。
      const raw = JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: `発話${index}`,
        })),
      );
      expect(parseStoredMessages(raw)).toHaveLength(count);
    },
  );
});

describe('保存済みの行へ 1 文で追記する（#742 / PR #746 の Copilot の指摘）', () => {
  const U = { role: 'user', text: '新' } as const;
  const A = { role: 'assistant', text: '返' } as const;

  /**
   * @param count 発話の数
   * @returns 役割が交互の会話
   */
  function turns(count: number): ChatMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `発話${index}`,
    }));
  }

  it('末尾へ足し、読み戻せる形のままである', async () => {
    const userId = await createUser();
    const id = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, turns(4), 1);
    expect(await appendChatConversation(env, userId, id, U, A, 2)).toBe(true);
    const latest = await latestChatConversation(env, userId, NEW_CHAT_TARGET);
    expect(latest?.messages).toEqual([...turns(4), U, A]);
    expect(latest?.updatedAt).toBe(2);
  });

  it('上限を超えたら SQL の中で最古の往復を落とす（先頭は user のまま）', async () => {
    const userId = await createUser();
    const id = await saveChatConversation(env, userId, null, NEW_CHAT_TARGET, turns(CHAT_MAX_STORED_MESSAGES), 1);
    expect(await appendChatConversation(env, userId, id, U, A, 2)).toBe(true);
    const latest = await latestChatConversation(env, userId, NEW_CHAT_TARGET);
    expect(latest?.messages).toHaveLength(CHAT_MAX_STORED_MESSAGES);
    expect(latest?.messages[0]).toEqual({ role: 'user', text: '発話2' });
    expect(latest?.messages.slice(-2)).toEqual([U, A]);
  });

  it.each([
    ['奇数の長さ（user で終わる）', JSON.stringify(turns(3))],
    ['JSON として読めない', '{壊れている'],
    ['配列でない', '{"role":"user","text":"あ"}'],
    ['上限を超えている', JSON.stringify(turns(CHAT_MAX_STORED_MESSAGES + 2))],
  ])('%s 行には足さない（交互を崩さない。呼ぶ側が受け取った会話から保存し直す）', async (_label, raw) => {
    const userId = await createUser();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'insert into chat_conversations (id, user_id, messages, created_at, updated_at) values (?, ?, ?, 1, 1)',
    )
      .bind(id, userId, raw)
      .run();
    expect(await appendChatConversation(env, userId, id, U, A, 2)).toBe(false);
    const row = await env.DB.prepare('select messages from chat_conversations where id = ?')
      .bind(id)
      .first<{ messages: string }>();
    expect(row?.messages).toBe(raw);
  });

  it('他人の会話の id には足さない', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const id = await saveChatConversation(env, owner, null, NEW_CHAT_TARGET, turns(2), 1);
    expect(await appendChatConversation(env, stranger, id, U, A, 2)).toBe(false);
    expect((await latestChatConversation(env, owner, NEW_CHAT_TARGET))?.messages).toEqual(turns(2));
  });
});

describe('保存済みの会話へ 1 往復を足す（#742）', () => {
  /**
   * @param turns 往復の数
   * @returns 役割が交互で、assistant で終わる会話
   */
  function storedTurns(turns: number): ChatMessage[] {
    return Array.from({ length: turns * 2 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `発話${index}`,
    }));
  }

  it('末尾へ足す（上限の内側では何も落とさない）', () => {
    const next = appendChatTurn(storedTurns(3), { role: 'user', text: '新' }, { role: 'assistant', text: '返' });
    expect(next).toHaveLength(8);
    expect(next[0]).toEqual({ role: 'user', text: '発話0' });
    expect(next.slice(-2)).toEqual([
      { role: 'user', text: '新' },
      { role: 'assistant', text: '返' },
    ]);
  });

  it('上限を超えたら最古の往復から落とす（先頭は user のまま・断らない）', () => {
    const next = appendChatTurn(
      storedTurns(CHAT_MAX_STORED_MESSAGES / 2),
      { role: 'user', text: '新' },
      { role: 'assistant', text: '返' },
    );
    expect(next).toHaveLength(CHAT_MAX_STORED_MESSAGES);
    expect(next[0]).toEqual({ role: 'user', text: '発話2' });
    expect(next[next.length - 1]).toEqual({ role: 'assistant', text: '返' });
    // **保存したものは、そのまま読み戻せる形である。**
    expect(parseStoredMessages(JSON.stringify(next))).toHaveLength(CHAT_MAX_STORED_MESSAGES);
  });
});

describe('チャットの区画（5.16「画面は /generate の中の区画」）', () => {
  it('復元した会話をサーバが描き、本文を必ずエスケープする', () => {
    const html = chatSection({
      messages: [
        { role: 'user', text: '<script>alert(1)</script>' },
        { role: 'assistant', text: '"&<>' },
      ],
      conversationId: 'conv-1',
      target: NEW_CHAT_TARGET,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&amp;&lt;&gt;');
    expect(html).toContain('data-conversation="conv-1"');
  });

  it('会話が無ければ、続きの id を持たない', () => {
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    expect(html).not.toContain('data-conversation');
    expect(html).toContain('id="chat-log"');
  });

  it('会話が無いときの `<ol>` は本当に空である（`:empty` が成立する）', () => {
    // **空白のテキストノードが 1 つでもあると `:empty` は成立しない**（CSS の定義）。
    // `public/assets/app.css` の `.gf-chat-log:empty` が案内を出せるのは、ここが空のときだけである（#771）。
    // **属性の増減で外れない形で見る**（#726 で `tabindex` と `aria-label` を足したときに
    // 外れた）。見たいのは「`<ol>` の開きタグの直後が閉じタグであること」だけである。
    const empty = /<ol id="chat-log"[^>]*><\/ol>/u;
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    expect(html).toMatch(empty);
    // 会話があるときは、当然ながら中身がある（この検査が「常に空」で通らないこと）。
    const filled = chatSection({
      messages: [{ role: 'user', text: 'あ' }],
      conversationId: null,
      target: NEW_CHAT_TARGET,
    });
    expect(filled).not.toMatch(empty);
  });

  it('コメントが指す検査のファイルが実在する（腐った参照を残さない）', () => {
    // **#715 の Copilot が見つけた形**——存在しないテストファイルを注記が指していた。
    expect(Object.keys(CHAT_SOURCES).length).toBeGreaterThan(3);
    for (const source of Object.values(CHAT_SOURCES)) {
      for (const matched of source.matchAll(/`(test\/[A-Za-z0-9._-]+\.test\.ts)`/gu)) {
        const path = matched[1]!;
        expect([...TEST_FILES], `注記が指す ${path} が無い`).toContain(path.slice('test/'.length));
      }
    }
  });

  it('スクリプトが JavaScript として構文が通る', () => {
    // **テンプレートリテラルの中身は、TypeScript が中身まで見ない。** バッククォートを 1 つ
    // 書き足しただけで文字列がそこで終わる（実際に踏んだ）。**解析だけして実行はしない**
    // （`document` も `fetch` も無い環境で走らせる必要は無い）。
    expect(() => new Function(CHAT_SCRIPT)).not.toThrow();
  });

  it('スクリプトは innerHTML を使わない（このモジュールの線）', () => {
    expect(CHAT_SCRIPT).not.toContain('innerHTML');
    expect(CHAT_SCRIPT).not.toContain('outerHTML');
    expect(CHAT_SCRIPT).not.toContain('insertAdjacentHTML');
    expect(CHAT_SCRIPT).not.toContain('document.write');
    // 本文を入れるのは textContent だけである。
    expect(CHAT_SCRIPT).toContain('textContent');
  });

  it('下書きは欄へ入れるだけで送らず、チャットのスクリプトは生成を始めない（#738 / 5.16）', () => {
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    // **「この指示で作る」は無い**（#738 で「欄の中身を『生成する』で送る」へ戻した）。
    expect(html).not.toContain('id="chat-apply"');
    expect(html).not.toContain('この指示で');
    // **下書きを欄へ入れる手段は残す**——控えめのボタンで、`type="button"`（フォームを送らない）。
    expect(html).toMatch(/<button id="chat-draft" class="gf-button gf-button-tertiary" type="button" hidden>/u);
    expect(CHAT_SCRIPT).toContain('input.value = text;');
    // **チャットのスクリプトは、自分で生成を始めない**——生成の API を叩かず、フォームも送らず、
    // 「生成する」も押さない（開始の経路は `GENERATE_SCRIPT` と素のフォーム送信だけ）。
    expect(CHAT_SCRIPT).not.toMatch(/fetch\([^)]*\/api\/(?:generate|revise|fork)/u);
    expect(CHAT_SCRIPT).not.toMatch(/requestSubmit|\.submit\(|generate-submit|\.click\(\)/u);
  });

  it('欄は区画の中にただ 1 つで、スクリプトは id を書き写さずに区画の中から引く（#738）', () => {
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    expect(html.match(/<textarea\b/gu)?.length).toBe(1);
    expect(html).not.toContain('id="chat-input"');
    expect(CHAT_SCRIPT).toContain("section.querySelector('textarea')");
    expect(CHAT_SCRIPT).not.toContain("getElementById('chat-input')");
  });

  it('ボタンは「チャットする」（副）と「生成する」（主）の 2 つで、主は右端に来る（#738 / 2.5.5）', () => {
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    const row = /<div class="gf-chat-composer-row">([\s\S]*?)<\/div>/u.exec(html)?.[1];
    expect(row).toBeDefined();
    const buttons = [...row!.matchAll(/<button [^>]*>[^<]*<\/button>/gu)].map((matched) => matched[0]);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBe('<button id="chat-send" class="gf-button gf-button-secondary" type="button">チャットする</button>');
    expect(buttons[1]).toContain('gf-button-primary');
    expect(buttons[1]).toContain('type="submit"');
    // **主は 1 画面に 1 つ**——区画のほかのボタンは主を持たない。
    expect(html.match(/gf-button-primary/gu)?.length).toBe(1);
    // **欄とボタンはフォームの中**にあり、フォームは区画の最後の子である（入力は常にいちばん下）。
    expect(html.indexOf('<form ')).toBeGreaterThan(html.indexOf('id="chat-log"'));
    expect(html.trimEnd().endsWith('</form>\n</section>')).toBe(true);
  });

  describe('キー: Enter ＝ 改行 / Shift+Enter ＝ チャットを送る / 生成にキーは割り当てない（#738 / 5.16）', () => {
    /** キーの押下のうち、判定が読む項目だけ（テストの環境は DOM の型を持たない）。 */
    interface KeyLike {
      readonly key: string;
      readonly shiftKey: boolean;
      readonly ctrlKey: boolean;
      readonly altKey: boolean;
      readonly metaKey: boolean;
      readonly isComposing: boolean;
      readonly keyCode: number;
      readonly timeStamp: number;
    }
    /** スクリプトの中の判定をそのまま取り出す（DOM は要らない関数である）。 */
    function loadSendsChat(): (event: KeyLike, composedAt: number) => boolean {
      const source = /function sendsChat\(event, composedAt\) \{[\s\S]*?\n {2}\}/u.exec(CHAT_SCRIPT)?.[0];
      expect(source).toBeDefined();
      return new Function(`${source!}\nreturn sendsChat;`)() as (
        event: KeyLike,
        composedAt: number,
      ) => boolean;
    }
    const long = -Infinity;
    const key = (init: Partial<KeyLike>): KeyLike => ({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 13,
      timeStamp: 10_000,
      ...init,
    });

    it('Shift+Enter はチャットを送る', () => {
      expect(loadSendsChat()(key({ shiftKey: true }), long)).toBe(true);
    });

    it('Enter は送らない（改行のまま。既定の動きを止めない）', () => {
      const sendsChat = loadSendsChat();
      expect(sendsChat(key({}), long)).toBe(false);
      // Enter 以外のキーも送らない。
      expect(sendsChat(key({ key: 'a', shiftKey: true }), long)).toBe(false);
    });

    it('生成にはキーを割り当てない（Ctrl / Cmd / Alt と組み合わせても送らず、生成へも行かない）', () => {
      const sendsChat = loadSendsChat();
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
        expect(sendsChat(key({ [modifier]: true }), long)).toBe(false);
        expect(sendsChat(key({ shiftKey: true, [modifier]: true }), long)).toBe(false);
      }
      // **キーの受け手はチャットを送る 1 つだけ**で、生成へ行く経路が無い（上の「生成を始めない」と組）。
      expect(CHAT_SCRIPT.match(/addEventListener\('keydown'/gu)?.length).toBe(1);
      expect(CHAT_SCRIPT).toMatch(/if \(!sendsChat\(event, composedAt\)\) \{ return; \}\s*\/\/[^\n]*\n\s*event\.preventDefault\(\);\s*sendChat\(\);/u);
    });

    it('IME の防御 1 段目: 変換中（isComposing）は送らない', () => {
      expect(loadSendsChat()(key({ shiftKey: true, isComposing: true }), long)).toBe(false);
    });

    it('IME の防御 2 段目: keyCode が 229（変換中の押下）なら送らない', () => {
      expect(loadSendsChat()(key({ shiftKey: true, keyCode: 229 }), long)).toBe(false);
    });

    it('IME の防御 3 段目: 変換の確定（compositionend）の直後に来た Enter は送らない', () => {
      const sendsChat = loadSendsChat();
      const at = 10_000;
      expect(sendsChat(key({ shiftKey: true, timeStamp: at + 1 }), at)).toBe(false);
      expect(sendsChat(key({ shiftKey: true, timeStamp: at + COMPOSITION_GUARD_MS - 1 }), at)).toBe(false);
      // 間を空けて押し直せば送れる。
      expect(sendsChat(key({ shiftKey: true, timeStamp: at + COMPOSITION_GUARD_MS }), at)).toBe(true);
      // 確定の時刻は、欄の compositionend から取る。
      expect(CHAT_SCRIPT).toContain("input.addEventListener('compositionend', function (event) { composedAt = event.timeStamp; });");
    });

    it('キーの案内を欄のそばに出し、生成にキーが無いことも言う', () => {
      const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
      expect(html).toContain(`id="${CHAT_KEY_HINT_ID}"`);
      expect(chatKeyHint('生成する')).toContain('Shift+Enter');
      expect(chatKeyHint('生成する')).toContain('Enter は改行');
      expect(html).toContain(escapeHtml(chatKeyHint('生成する')));
    });

    it('キーの案内は、その画面に実在する主のボタンだけを指す（PR #754 の Copilot の指摘）', () => {
      // **リフォージ／フォークの画面の主は「リフォージする」「フォークする」**で、「生成する」は無い。
      // 案内と主のボタンが同じ文言（`submitLabel`）から作られていることを、描いた HTML で突き合わせる。
      for (const label of ['生成する', 'リフォージする', 'フォークする']) {
        const composer = {
          ...COMPOSER,
          submit: `<button id="generate-submit" class="gf-button gf-button-primary" type="submit">${label}</button>`,
          submitLabel: label,
        };
        const html = renderChatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET }, composer);
        expect(html).toContain(escapeHtml(chatKeyHint(label)));
        expect(html).toContain(`>${label}</button>`);
        for (const other of ['生成する', 'リフォージする', 'フォークする'].filter((l) => l !== label)) {
          expect(html).not.toContain(`「${other}」`);
        }
      }
    });
  });

  it('通らなかった往復は、断られたときも通信が落ちたときも取り消す（第二意見の指摘）', () => {
    // **`user` の発話を DOM へ残すと、次の送信で `user` が 2 連続になり、サーバの検査が
    // 400 を返し続ける**——再読み込みするまでチャットが回復しない。**後始末は 1 か所に置き、
    // 2 つの枝の両方から呼ぶ。**
    expect(CHAT_SCRIPT).toContain('function rollback(text)');
    const calls = [...CHAT_SCRIPT.matchAll(/\brollback\(text\)/gu)];
    // 定義の 1 つと、呼び出しの 2 つ（断られた枝・通信が落ちた枝）。
    expect(calls).toHaveLength(3);
    expect(CHAT_SCRIPT).toMatch(/\.catch\(function \(\) \{[\s\S]*?rollback\(text\)/u);
  });

  it('下書きの見出しが、システムプロンプトの綴りと一致する', () => {
    const prompt = CHAT_PROMPT_SECTIONS.join('\n');
    expect(prompt).toContain(CHAT_DRAFT_HEADING);
    expect(CHAT_SCRIPT).toContain(JSON.stringify(CHAT_DRAFT_HEADING));
  });

  it('通数では送信を止めない（#742。以前は 20 通で止め、10 往復で行き止まりになった）', () => {
    // **見張りそのものが無いこと**を見る。以前は `turns.length + 1 > 20` で `notify(400, …)` を出して
    // 送らなかった。
    expect(CHAT_SCRIPT).not.toMatch(/notify\(400/u);
    expect(CHAT_SCRIPT).toContain('messages: windowOf(history())');
  });

  it('送る本文は chatSendWindow と同じ規則で切る——上限以内なら全部、超えたら最古の往復から（#742 / #749）', () => {
    // **スクリプトの中の関数を取り出して、そのまま走らせる**（DOM は要らない関数である）。
    // **#742 ではここが「常に 7 通以下」だった。** #749 で上限を超えたときだけ落とすへ戻したので、
    // エッジの正本（`chatSendWindow`）と同じ結果を返すことを、通数と文字数の両方で突き合わせる。
    const source = /function windowOf\(list\) \{[\s\S]*?\n {2}\}/u.exec(CHAT_SCRIPT)?.[0];
    expect(source).toBeDefined();
    const windowOf = new Function(`${source!}\nreturn windowOf;`)() as (
      list: readonly ChatMessage[],
    ) => readonly ChatMessage[];
    const lengths = [1, 3, 5, 25, 60, 500, CHAT_MAX_MESSAGE_LENGTH];
    for (let length = 1; length <= CHAT_MAX_STORED_MESSAGES + 1; length += 2) {
      for (const size of lengths) {
        const list = Array.from({ length }, (_, index) => ({
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          // **コードポイントで数える**（サロゲートペアを混ぜる）。
          text: `${index}`.padEnd(size, index % 3 === 0 ? '𠮷' : 'あ'),
        }));
        const sent = windowOf(list);
        expect(sent).toEqual(chatSendWindow(list));
        expect(sent[0]!.role).toBe('user');
        expect(sent[sent.length - 1]).toEqual(list[list.length - 1]);
      }
    }
  });

  it('上限以内の会話は、1 通も落とさずに送る（#749。#742 の窓では 7 通へ切り、決まったことを聞き直した）', () => {
    const source = /function windowOf\(list\) \{[\s\S]*?\n {2}\}/u.exec(CHAT_SCRIPT)?.[0];
    const windowOf = new Function(`${source!}\nreturn windowOf;`)() as (
      list: readonly ChatMessage[],
    ) => readonly ChatMessage[];
    // **実際に踏んだ大きさ（約 1,500 字）を、実効の上限（19 通）の中で送る。**
    const list = Array.from({ length: CHAT_MAX_SEND_MESSAGES - 1 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `${index}`.padEnd(80, 'あ'),
    }));
    expect(list.reduce((total, message) => total + message.text.length, 0)).toBeLessThan(CHAT_MAX_TOTAL_MESSAGE_LENGTH);
    expect(windowOf(list)).toEqual(list);
    // **上限を 1 往復超えたら、最古の 1 往復だけが落ちる。**
    const over = [...list, { role: 'assistant' as const, text: '返答' }, { role: 'user' as const, text: '次' }];
    expect(windowOf(over)).toEqual(over.slice(2));
  });

  it('送る前に、各発話の前後の空白を落とす——エッジと同じ数え方にする（#749 の Copilot の指摘）', () => {
    // **エッジは trim してから窓を切る**（`parseChatRequest`）。返答は trim せずに描くので、画面が
    // `textContent` をそのまま数えると、12,000 字の境目で**画面だけが古い往復を落とす。**
    const source = /function history\(\) \{[\s\S]*?\n {2}\}/u.exec(CHAT_SCRIPT)?.[0];
    expect(source).toBeDefined();
    const turn = (role: 'user' | 'assistant', text: string) => ({
      className: `gf-chat-turn gf-chat-${role}`,
      querySelector: () => ({ textContent: text }),
    });
    const log = {
      querySelectorAll: () => [turn('user', '  最初  '), turn('assistant', '\n返答\n\n'), turn('user', '次')],
    };
    const history = new Function('log', `${source!}\nreturn history;`)(log) as () => readonly ChatMessage[];
    expect(history()).toEqual([
      { role: 'user', text: '最初' },
      { role: 'assistant', text: '返答' },
      { role: 'user', text: '次' },
    ]);
  });

  describe('枠の表示は「今日の残り NN%」で、円もトークンも出さない（#751）', () => {
    it('区画の HTML に「トークン」の語も円の額も出ない（開いた時点では残りを隠しておく）', () => {
      const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
      expect(html).not.toContain('トークン');
      expect(html).not.toMatch(/[¥￥]|[0-9] ?円/u);
      expect(html).toMatch(/<p class="gf-generate-quota" id="chat-quota" hidden><\/p>/u);
    });

    it('スクリプトは残りの割合だけを書き、「トークン」も円も書かない', () => {
      expect(CHAT_SCRIPT).toContain("'今日の残り ' + value + '%'");
      expect(CHAT_SCRIPT).toContain('result.payload.remainingPercent');
      expect(CHAT_SCRIPT).not.toContain('remainingTokens');
      expect(CHAT_SCRIPT).not.toContain('costJpy');
      // **スクリプトは本文ごと画面へ届く**ので、コメントにも書かない（`test/cost-alert.test.ts` が
      // 生成画面に「円」が無いことを見ている。実際に踏んだ）。
      expect(CHAT_SCRIPT).not.toMatch(/トークン|[¥￥円]/u);
    });

    it('残りの割合を 0〜100 の整数で出し、壊れた値では書き換えない', () => {
      const source = /function showRemaining\(percent\) \{[\s\S]*?\n {2}\}/u.exec(CHAT_SCRIPT)?.[0];
      expect(source).toBeDefined();
      const quota = { textContent: '', hidden: true };
      const showRemaining = new Function('quota', `${source!}\nreturn showRemaining;`)(quota) as (
        percent: number,
      ) => void;
      showRemaining(42);
      expect(quota).toEqual({ textContent: '今日の残り 42%', hidden: false });
      showRemaining(150);
      expect(quota.textContent).toBe('今日の残り 100%');
      showRemaining(-3);
      expect(quota.textContent).toBe('今日の残り 0%');
      showRemaining(Number.NaN);
      expect(quota.textContent).toBe('今日の残り 0%');
    });

    it('1 日の枠に当たったら 0% を出す（案内の文は今のまま）', () => {
      expect(CHAT_SCRIPT).toContain("result.payload.error === \"chat-daily-tokens\") { showRemaining(0); }");
      expect(CHAT_MESSAGES['429:chat-daily-tokens']).toBe(
        '本日のチャットの枠は終了しました。日付が変わると戻ります（生成はこれまでどおり行えます）。',
      );
    });
  });

  it('「受け取れませんでした」の文言は、通数ではなく 1 通の長さを言う（#742）', () => {
    // **通数で止まっているのに「文字数を減らして」と言うのは誤誘導だった。** 通数ではもう断らない。
    const message = CHAT_MESSAGES['400:invalid-request']!;
    expect(message).not.toContain('文字数を減らして');
    expect(message).toContain(CHAT_MAX_MESSAGE_LENGTH.toLocaleString('en-US'));
  });

  it('断りの分類名に、文言が 1 つずつある（増やして書き忘れると落ちる）', () => {
    for (const reason of CHAT_QUOTA_REJECTION_REASONS) {
      expect(Object.keys(CHAT_MESSAGES)).toContain(`429:${reason}`);
    }
    // 既定（分類できないとき）も必ず持つ。
    expect(CHAT_MESSAGES['']).toBeTruthy();
  });
});

/**
 * CSS の宣言の塊を、セレクタで引く。
 *
 * **見たいのは「その規則があるか」であって、値の全文一致ではない**ので、コメントを落として
 * `セレクタ { 中身 }` に切り分けるだけにする（`test/button-parts.test.ts` と同じ形）。
 *
 * @param selector 引きたいセレクタ（前後の空白は詰めて比べる）
 * @returns 宣言の中身（同じセレクタが複数あればすべて）
 */
function cssRules(selector: string): string[] {
  const withoutComments = env.TEST_APP_CSS.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((matched) =>
      matched[1]!.split(',').some((one) => one.trim().replaceAll(/\s+/gu, ' ') === selector),
    )
    .map((matched) => matched[2]!);
}

/**
 * チャットを主役にする（#726 / M20-2。仕様 5.16 の確定38）。
 *
 * **#726 の acceptance を機械判定できる形へ落とす。** 見た目そのものは測れないので、
 * **見た目を作っている規則が在ること**と、**スクリプトが約束どおりに動かす対象**を見る。
 * 実際の見え方は `scripts/check-page-width.sh`（実ブラウザ）と本番の目視が持つ。
 */
describe('チャットを主役にする（#726 / 確定38）', () => {
  it('利用者はカプセルで右、AI は囲いを持たず左に流れる（利用者が示した画面に合わせた）', () => {
    // **確定38 の「利用者は右・AI は左」。** 置き場所は `align-self` が決める
    // （`.gf-chat-log` が縦の flex なので、交差軸は横である）。
    const user = cssRules('.gf-chat-user').join('');
    expect(user).toContain('align-self: flex-end');
    expect(user).toContain('max-width');
    // **AI は囲いを持たず、版面の幅をそのまま使う**（返答は長く、囲うと読みにくい）。
    expect(cssRules('.gf-chat-assistant').join('')).toContain('align-self: stretch');
    // **カプセルになるのは利用者の発話だけ**で、地は会話の窓と別の段にする
    // （同じ地を敷くとカプセルが消える。1280px で撮って気づいた）。#771 で窓が `--gf-ground` になったので、カプセルは面の色。
    const bubble = cssRules('.gf-chat-user .gf-chat-text').join('');
    expect(bubble).toContain('border-radius');
    expect(bubble).toContain('background: var(--gf-surface)');
    expect(cssRules('.gf-chat .gf-chat-log').join('')).toContain('background: var(--gf-ground)');
    expect(cssRules('.gf-chat-text').join('')).not.toContain('background');
    // **色では示さない**（`@section work` の「ここだけが色を持つ」）。
    for (const rule of [user, bubble, cssRules('.gf-chat-assistant').join('')]) {
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    }
    const html = chatSection({
      messages: [
        { role: 'user', text: 'あ' },
        { role: 'assistant', text: 'い' },
      ],
      conversationId: null,
      target: NEW_CHAT_TARGET,
    });
    expect(html).toContain('gf-chat-user');
    expect(html).toContain('gf-chat-assistant');
    // **名前は消していない**——目には出さず、読み上げには残す（形だけに寄りかからない）。
    expect(html.match(/gf-chat-who/gu)?.length).toBe(2);
    const who = cssRules('.gf-chat-who').join('');
    expect(who).toContain('clip-path: inset(50%)');
    expect(who).not.toContain('display: none');
  });

  it('入力は区画のいちばん下にあり、浮かせない（実測で sticky を取り下げた）', () => {
    // **縦に並べ、会話だけが自分でスクロールする箱**という形で「下に固定」を作る。
    const section = cssRules('.gf-chat').join('');
    expect(section).toContain('flex-direction: column');
    // **高さの上限は会話の箱が持ち、区画は持たない**（#738。区画に置くと、背の伸びた入力の塊が
    // 区画の面の外へはみ出した——390×800 で 200px。実測）。
    expect(section).not.toContain('max-height');
    const log = cssRules('.gf-chat-log').join('');
    expect(log).toContain('flex: 1 1 auto');
    expect(log).toMatch(/max-height: min\(/u);
    expect(log).toContain('overflow-y: auto');
    // **入力は浮かせない。** 浮かせると会話の末尾を覆い、覆われた発話に手が届かなくなる
    // （390×800 の実測で踏んだ。理由は `.gf-chat` の冒頭）。#738 から入力の塊は生成のフォームそのものである。
    const composer = cssRules('.gf-chat-composer').join('');
    expect(composer).not.toContain('position: sticky');
    expect(composer).not.toContain('position: fixed');
    expect(composer).toContain('flex: 0 0 auto');
    // **入力が区画の最後の子であること**（「いちばん下」をこの並びが作っている）。
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    const at = html.indexOf('<form ');
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at)).toContain('id="generate-prompt"');
    expect(html.slice(at)).toContain('id="chat-send"');
    expect(html.slice(at)).toContain('id="generate-submit"');
    expect(html.indexOf('id="chat-log"')).toBeLessThan(at);
  });

  it('`hidden` で配るボタンが、本当に消える（部品の display は UA の [hidden] に勝つ）', () => {
    // **#726 から本番で出ていた不具合**——下書きがまだ無いのに主のボタンが見え、押しても
    // 何も起きない導線になっていた（#727 で実物を撮って気づいた）。**リポジトリの中で 3 回目の罠**
    // （`.gf-play-open[hidden]` / `.gf-play-orient-toggle[hidden]`）。
    expect(cssRules('.gf-button[hidden]').join('')).toContain('display: none');
    // 画面の側は `hidden` で配っている（規則だけ在って誰も使っていない、を通さない）。
    const html = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    expect(html).toMatch(/id="chat-draft"[^>]*hidden/u);
  });

  it('`:has()` を使わない（互換性のため避ける決め。Copilot が見つけた）', () => {
    // **対応しないブラウザでは畳まれず、余白だけが残る**（`.gf-watch-player` と同じ理由）。
    // **チャットの塊だけでなく、app.css 全体で使わない。**
    const withoutComments = env.TEST_APP_CSS.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    expect(withoutComments).not.toContain(':has(');
  });

  it('履歴は自分でスクロールする箱で、往復のたびに下まで送る（画面は動かさない）', () => {
    // 箱であること。
    expect(cssRules('.gf-chat-log').join('')).toContain('overflow-y: auto');
    // **動かすのは箱の `scrollTop` だけ。** 1 往復足すたびと、開いた時点の 2 か所から呼ぶ。
    expect(CHAT_SCRIPT).toContain('log.scrollTop = log.scrollHeight');
    expect(CHAT_SCRIPT.match(/toBottom\(\);/gu)?.length).toBeGreaterThanOrEqual(2);
    // **画面ごと動かさない**——下に貼り付いた入力欄が往復のたびに跳ねる。
    expect(CHAT_SCRIPT).not.toContain('scrollIntoView');
  });
});

describe('生成画面での出し分け', () => {
  it('生成できるときはチャットの区画とスクリプトが出る', () => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: { messages: [], conversationId: null, target: NEW_CHAT_TARGET },
      target: NEW_CHAT_TARGET,
    });
    expect(html).toContain('id="chat"');
    expect(html).toContain('id="chat-send"');
    expect(html).toContain("document.getElementById('chat')");
  });

  it.each([
    ['未ログイン', false],
    ['枠が尽きている', true],
  ])('%s のときはチャットの区画を出さない（押せない導線を増やさない）', (_label, signedIn) => {
    const html = renderGeneratePage(signedIn, {
      availability: signedIn ? { kind: 'daily-quota' } : { kind: 'unknown' },
      headerAvatar: null,
      chat: null,
      target: NEW_CHAT_TARGET,
    });
    expect(html).not.toContain('id="chat"');
    expect(html).not.toContain('id="chat-send"');
  });

  it('チャットを出すときは、欄は 1 つで、生成のフォームがチャットの区画の最後の子になる（#738）', () => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: { messages: [], conversationId: null, target: NEW_CHAT_TARGET },
      target: NEW_CHAT_TARGET,
    });
    // **欄は 1 つ**——「チャットせずに指示文を直接書く」の `<details>` も、チャット専用の欄も無い。
    expect(html.match(/<textarea\b/gu)?.length).toBe(1);
    expect(html).not.toContain('id="generate-direct"');
    expect(html).not.toContain('直接書く');
    expect(html).not.toContain('<details class="gf-generate-direct"');
    // **生成のフォームはチャットの区画の中**にある（面を重ねないので `.gf-block` を持たない）。
    const section = html.slice(html.indexOf('<section id="chat"'), html.indexOf('</section>'));
    expect(section).toContain('<form id="generate-form" class="gf-generate-form gf-chat-composer"');
    expect(section).toContain('id="generate-prompt"');
    // **欄の説明にキーの案内が入る**（読み上げで欄に入ったときに伝わる）。
    expect(html).toContain(`aria-describedby="generate-title-hint ${CHAT_KEY_HINT_ID}"`);
    // **開始の経路は変えない**——送り先も、受けるスクリプトも今までどおりである。
    expect(html).toContain(`action="${GENERATE_PATH}"`);
    expect(html).toContain("document.getElementById('generate-form')");
  });

  it('チャットを出すときの主のボタンは「生成する」の 1 つだけで、「チャットする」は副である（2.5.5 / #738）', () => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: { messages: [], conversationId: null, target: NEW_CHAT_TARGET },
      target: NEW_CHAT_TARGET,
    });
    // **主は 1 画面に 1 つまで。** 確定38 で「この指示で作る」へ移っていたのが「生成する」へ戻った。
    expect(html.match(/gf-button-primary/gu)?.length).toBe(1);
    expect(html).toContain('<button id="generate-submit" class="gf-button gf-button-primary" type="submit" disabled>生成する</button>');
    expect(html).toContain('<button id="chat-send" class="gf-button gf-button-secondary" type="button">チャットする</button>');
    expect(html).not.toContain('id="chat-apply"');
  });

  it('チャットを出さないときは、フォームだけを面に置き、主のボタンは「生成する」のまま', () => {
    // **`chat` が null なのに畳むと、その画面に生成の入口が 1 つも見えなくなる。**
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: null,
      target: NEW_CHAT_TARGET,
    });
    expect(html).not.toContain('id="generate-direct"');
    expect(html).not.toContain('id="chat-send"');
    expect(html).toContain('<form id="generate-form" class="gf-block gf-generate-form"');
    expect(html).toMatch(/id="generate-submit" class="gf-button gf-button-primary"/u);
    expect(html).toContain('aria-describedby="generate-title-hint"');
  });

  it('画面は左端から器いっぱいに組む 1 カラムで、パンくずも同じ端に揃う（#738 / #764 / 5.16「レイアウト」）', () => {
    const html = renderGeneratePage(true, {
      availability: { kind: 'available', remaining: 5 },
      headerAvatar: null,
      chat: { messages: [], conversationId: null, target: NEW_CHAT_TARGET },
      target: NEW_CHAT_TARGET,
    });
    expect(html).toContain('<nav class="gf-breadcrumb gf-column"');
    // 見出しから入力の塊までが 1 つの器に入る。
    const start = html.indexOf('<div class="gf-column">');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(html.indexOf('<h1>'));
    expect(start).toBeLessThan(html.indexOf('id="chat"'));
    // 器は器いっぱいの幅で左端から組む（#764。#738 の中央寄せを覆した）。**パンくずも同じ値**——片方だけを
    // 変えると、パンくずと見出しの左端がずれる（#738 が 1280px で見つけた回帰）。
    const column = cssRules('.gf-column').join('');
    expect(column).toContain('max-width: none');
    expect(column).toContain('margin-inline: 0');
    expect(cssRules('.gf-breadcrumb.gf-column').join('')).toContain('margin-inline: 0');
    // 会話のログは面の内側いっぱいの窓（#771。#764 の「ログだけは版面で止める」を覆した）。
    expect(cssRules('.gf-chat .gf-chat-log').join('')).not.toContain('max-width');
    expect(cssRules('.gf-chat-log').join('')).not.toContain('max-width: var(--gf-measure)');
    // **履歴が無いときは窓の中に案内を出す**（#771）。生成内容なので、最初の発話が入れば `:empty` でなくなって消える。
    expect(cssRules('.gf-chat-log:empty::before').join('')).toMatch(/content: '[^']*チャット[^']*'/u);
    // 指示文の欄は面の内側いっぱい。**入力欄はどれも上限を持たない**（#767。#763 の 42rem の上限を外した）ので、
    // 欄ごとの逃がし規則も要らない。
    expect(cssRules('textarea').join('')).not.toContain('max-width');
    expect(cssRules('.gf-chat-composer textarea').join('')).not.toContain('max-width');
  });
});


/** コードの記号（テンプレート文字列の中へ直に書かない）。 */
const BACKTICK = String.fromCharCode(96);

/** Markdown を含む返答（見出し・箇条書き・コード・表・リンク・押せないリンク・画像・下書き）。 */
const MARKDOWN_REPLY = [
  '## 決めること',
  '',
  '- **時間**: 30 秒',
  '- 操作は ' + BACKTICK + '矢印キー' + BACKTICK,
  '',
  BACKTICK.repeat(3) + 'go',
  'func update() {}',
  BACKTICK.repeat(3),
  '',
  '| 項目 | 案 |',
  '|:--|--:|',
  '| 玉 | 赤 |',
  '',
  '[参考](https://ebitengine.org/) と [押せない](javascript:alert(1)) と ![絵](https://example.com/x.png)',
  '',
  '【指示文】',
  '- 赤い玉を**避ける**ゲーム',
  '- 残り時間を画面の上に出す',
  '',
].join('\n');

/** ブラウザの要素の代わり（`append()` / `history()` / `draft()` が触る分だけ）。 */
class FakeElement {
  className = '';
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  readonly attrs: [string, string][] = [];
  children: (FakeElement | string)[] = [];

  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value: string) {
    this.children = value === '' ? [] : [String(value)];
  }

  appendChild<T extends FakeElement | string>(child: T): T {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.push([name, value]);
  }

  /** 子孫をすべて（文書順で）。 */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => (typeof child === 'string' ? [] : [child, ...child.descendants()]));
  }

  /** `.a` と `.a .b` の 2 つの形だけを解く。 */
  querySelectorAll(selector: string): FakeElement[] {
    const classes = selector.split(' ').map((part) => part.replace(/^\./u, ''));
    const has = (element: FakeElement, name: string): boolean => element.className.split(' ').includes(name);
    const first = this.descendants().filter((element) => has(element, classes[0]!));
    if (classes.length === 1) {
      return first;
    }
    return first.flatMap((element) => element.descendants().filter((inner) => has(inner, classes[1]!)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** 組んだ要素を、サーバが書く HTML と同じ形の文字列へ戻す。 */
function serializeFake(node: FakeElement | string): string {
  if (typeof node === 'string') {
    return escapeHtml(node);
  }
  const attrs =
    (node.className === '' ? '' : ` class="${escapeHtml(node.className)}"`) +
    node.attrs.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('') +
    (node.hidden ? ' hidden' : '');
  return ['hr', 'br'].includes(node.tag)
    ? `<${node.tag}${attrs}>`
    : `<${node.tag}${attrs}>${node.children.map(serializeFake).join('')}</${node.tag}>`;
}

/** スクリプトの中の関数を、名前で 1 つ取り出す。 */
function scriptFunction(name: string): string {
  const source = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`, 'u').exec(CHAT_SCRIPT)?.[0];
  expect(source, name).toBeDefined();
  return source!;
}

/** `append()` / `history()` / `draft()` を、本物のスクリプトから取り出して偽の DOM の上で走らせる。 */
function runChatScript(): {
  log: FakeElement;
  append: (role: 'user' | 'assistant', text: string) => void;
  history: () => readonly ChatMessage[];
  draft: () => string;
} {
  const log = new FakeElement('ol');
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => text,
  };
  const api = new Function(
    'document',
    'log',
    `${CHAT_MARKDOWN_SCRIPT}\n${scriptFunction('append')}\n${scriptFunction('history')}\n${scriptFunction('draft')}\n` +
      'function toBottom() {}\nreturn { append: append, history: history, draft: draft };',
  )(doc, log) as Omit<ReturnType<typeof runChatScript>, 'log'>;
  return { log, ...api };
}

describe('返答を Markdown として描く（#739 / 仕様 5.16）', () => {
  it('復元した返答はサーバが Markdown として描き、元の文字列は隠した本文に残す', () => {
    const html = chatSection({
      messages: [
        { role: 'user', text: '# 見出しのつもりの発話' },
        { role: 'assistant', text: MARKDOWN_REPLY },
      ],
      conversationId: 'conv-md',
      target: NEW_CHAT_TARGET,
    });
    expect(html).toContain('<div class="gf-chat-md"><h4>決めること</h4><ul><li><strong>時間</strong>: 30 秒</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code>func update() {}</code></pre>');
    expect(html).toContain('<a href="https://ebitengine.org/" rel="noopener noreferrer">参考</a>');
    // **押せないリンクと画像は、押せる形にも読み込む形にもならない**（名指しの例外 2 つ）。
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toMatch(/<img/iu);
    // **元の文字列は隠した本文に、記号ごと残る。**
    expect(html).toContain(`<p class="gf-chat-text" hidden>${escapeHtml(MARKDOWN_REPLY)}</p>`);
    // **利用者の発話は Markdown として描かない**（今までどおり文字のまま）。
    expect(html).toContain('<p class="gf-chat-text"># 見出しのつもりの発話</p>');
  });

  it('描いた後でも、送る本文と欄へ入れる下書きは元の Markdown の文字列である', () => {
    // **ここがずれると、エッジへ送る会話が描いた後の文字（記号と改行の落ちたもの）に化ける。**
    const { log, append, history, draft } = runChatScript();
    append('user', '  決めたいです  ');
    append('assistant', MARKDOWN_REPLY);
    expect(history()).toEqual([
      { role: 'user', text: '決めたいです' },
      { role: 'assistant', text: MARKDOWN_REPLY.trim() },
    ]);
    expect(draft()).toBe('- 赤い玉を**避ける**ゲーム\n- 残り時間を画面の上に出す\n');
    // **見えている方は描いた後の文字で、元の文字列とは違う**——こちらを読めば上が落ちる。
    const shown = log.querySelector('.gf-chat-md');
    expect(shown).not.toBeNull();
    expect(shown!.textContent).not.toBe(MARKDOWN_REPLY);
    expect(shown!.textContent).not.toContain('**');
    // 元の文字列は隠れている（見えるのは描いた方だけ）。
    expect(log.querySelector('.gf-chat-assistant .gf-chat-text')!.hidden).toBe(true);
    expect(log.querySelector('.gf-chat-user .gf-chat-text')!.hidden).toBe(false);
  });

  it('往復のたびに足す返答と、サーバが描く返答が同じ構造になる', () => {
    const { log, append } = runChatScript();
    append('assistant', MARKDOWN_REPLY);
    const server = /<li class="gf-chat-turn gf-chat-assistant">[\s\S]*<\/li>/u.exec(
      chatSection({ messages: [{ role: 'assistant', text: MARKDOWN_REPLY }], conversationId: null, target: NEW_CHAT_TARGET }),
    )?.[0];
    expect(server).toBeDefined();
    expect(serializeFake(log.children[0]!)).toBe(server);
  });

  it('スクリプトは解析器と組み立てを埋め込み、HTML を解釈させる API を持たないまま描く', () => {
    expect(CHAT_SCRIPT).toContain(CHAT_MARKDOWN_SCRIPT);
    expect(CHAT_SCRIPT).toContain('buildChatMarkdown(shown, parseChatMarkdown(body.textContent');
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(CHAT_SCRIPT, forbidden).not.toContain(forbidden);
    }
  });

  it('返答の Markdown の見た目が 390px ではみ出さない（表とコードは箱の中で横に送る）', () => {
    const md = cssRules('.gf-chat-md').join('');
    expect(md).toContain('overflow-wrap: anywhere');
    expect(cssRules('.gf-chat-md pre').join('')).toContain('overflow-x: auto');
    expect(cssRules('.gf-chat-md table').join('')).toContain('overflow-x: auto');
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
    const section = chatSection({ messages: [], conversationId: null, target: NEW_CHAT_TARGET });
    expect(section).toContain('チャットの記録を消す');
    expect(privacy).toContain('チャットの記録を消す');
  });
});
