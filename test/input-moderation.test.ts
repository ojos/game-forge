import { describe, expect, it } from 'vitest';
import {
  MODERATION_CATEGORY_SEPARATOR,
  ModerationUnavailable,
  PromptBlocked,
  applyGuardrailEndpoint,
  applyInputModeration,
  categoryLabelOf,
  readGuardrailBlocks,
  withInputModeration,
} from '../src/input-moderation.js';
import { MODERATION_TEST_ENV } from './helpers/guardrail.js';

/** `applyInputModeration` が読む env の最小形。 */
function moderationEnv(overrides: Record<string, string | null> = {}): Env {
  const base: Record<string, string> = {
    BEDROCK_AWS_REGION: 'ap-northeast-1',
    BEDROCK_AWS_ACCESS_KEY_ID: 'test-access-key-id',
    BEDROCK_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    ...MODERATION_TEST_ENV,
  };
  const values: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete values[key];
    } else {
      values[key] = value;
    }
  }
  return values as unknown as Env;
}

/** 遮断された応答。 */
function blockedResponse(types: readonly string[] = ['VIOLENCE']): Response {
  return Response.json({
    action: 'GUARDRAIL_INTERVENED',
    assessments: [
      {
        contentPolicy: {
          filters: types.map((type) => ({ type, confidence: 'HIGH', action: 'BLOCKED' })),
        },
      },
    ],
  });
}

describe('応答の読み取り（8.2 / #37）', () => {
  it('遮断されていなければ空配列', () => {
    expect(readGuardrailBlocks({ action: 'NONE' })).toEqual([]);
  });

  it('遮断されたカテゴリを日本語で返す', () => {
    const payload = {
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contentPolicy: {
            filters: [{ type: 'VIOLENCE', confidence: 'HIGH', action: 'BLOCKED' }],
          },
        },
      ],
    };
    expect(readGuardrailBlocks(payload)).toEqual(['暴力表現']);
  });

  it('同じカテゴリは 1 度しか出ない', () => {
    const payload = {
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        { contentPolicy: { filters: [{ type: 'VIOLENCE', action: 'BLOCKED' }] } },
        { contentPolicy: { filters: [{ type: 'VIOLENCE', action: 'BLOCKED' }] } },
      ],
    };
    expect(readGuardrailBlocks(payload)).toEqual(['暴力表現']);
  });

  it('BLOCKED でない検出は数えない', () => {
    // 検出されたが遮断していないものを混ぜると、**止まっていない理由まで**
    // 利用者へ出ることになる。
    const payload = {
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contentPolicy: {
            filters: [
              { type: 'SEXUAL', action: 'NONE' },
              { type: 'VIOLENCE', action: 'BLOCKED' },
            ],
          },
        },
      ],
    };
    expect(readGuardrailBlocks(payload)).toEqual(['暴力表現']);
  });

  it('知らないカテゴリはそのまま出す', () => {
    // AWS がカテゴリを増やしたときに、**分類名が消えて「何かに引っ掛かった」だけに
    // なる**ほうが困る。
    const payload = {
      action: 'GUARDRAIL_INTERVENED',
      assessments: [{ contentPolicy: { filters: [{ type: 'NEW_THING', action: 'BLOCKED' }] } }],
    };
    expect(readGuardrailBlocks(payload)).toEqual(['NEW_THING']);
    expect(categoryLabelOf('NEW_THING')).toBe('NEW_THING');
  });

  it('形が読めなければ「遮断されていない」ではなく例外', () => {
    // **静かに空を返すと、応答の形が変わった日に黙って素通しになる。**
    expect(() => readGuardrailBlocks(null)).toThrow(ModerationUnavailable);
    expect(() => readGuardrailBlocks({})).toThrow(ModerationUnavailable);
    expect(() => readGuardrailBlocks({ action: 'GUARDRAIL_INTERVENED' })).toThrow(
      ModerationUnavailable,
    );
  });

  it('遮断されたのに理由が読めなければ例外', () => {
    expect(() =>
      readGuardrailBlocks({ action: 'GUARDRAIL_INTERVENED', assessments: [] }),
    ).toThrow(ModerationUnavailable);
  });
});

describe('エンドポイント', () => {
  it('id と版が経路に現れる', () => {
    expect(applyGuardrailEndpoint('ap-northeast-1', 'gr-1', '3')).toBe(
      'https://bedrock-runtime.ap-northeast-1.amazonaws.com/guardrail/gr-1/version/3/apply',
    );
  });
});

describe('呼び出し（8.2 / #37）', () => {
  it('通れば何も起きない', async () => {
    await expect(
      applyInputModeration(moderationEnv(), 'ねこが主人公のパズル', {
        fetch: async () => Response.json({ action: 'NONE' }),
      }),
    ).resolves.toBeUndefined();
  });

  it('当てるのはプロンプト本文だけである', async () => {
    // **親ソースを混ぜない。** ゲームのソースには enemy / kill / shoot が普通に
    // 現れるので、混ぜると暴力フィルタが構造的に誤爆する。
    let sent: unknown = null;
    await applyInputModeration(moderationEnv(), 'ねこのパズル', {
      fetch: async (request) => {
        sent = await request.json();
        return Response.json({ action: 'NONE' });
      },
    });
    expect(sent).toEqual({ source: 'INPUT', content: [{ text: { text: 'ねこのパズル' } }] });
  });

  it('遮断されたら PromptBlocked を投げ、カテゴリを持つ', async () => {
    await expect(
      applyInputModeration(moderationEnv(), 'なにか', {
        fetch: async () => blockedResponse(['VIOLENCE', 'HATE']),
      }),
    ).rejects.toMatchObject({
      name: 'PromptBlocked',
      categories: ['暴力表現', '憎悪表現'],
    });
  });

  it('環境変数が欠けていたら素通ししない', async () => {
    // **「検査していない」は「検査して通った」ではない。**
    await expect(
      applyInputModeration(moderationEnv({ MODERATION_GUARDRAIL_ID: null }), 'なにか', {
        fetch: async () => Response.json({ action: 'NONE' }),
      }),
    ).rejects.toBeInstanceOf(ModerationUnavailable);
  });

  it('HTTP が失敗しても素通ししない（fail-closed）', async () => {
    // **本体は正しい JSON にしておく。** `new Response('nope', …)` にすると、
    // 状態コードの検査を外しても `response.json()` が落ちて同じ例外になり、
    // **検査が空振りしていることに気づけない**（変異で実際に踏んだ）。
    // ここは「通ったように見える本体を、状態コードだけで弾く」ことを見る。
    await expect(
      applyInputModeration(moderationEnv(), 'なにか', {
        fetch: async () => Response.json({ action: 'NONE' }, { status: 500 }),
      }),
    ).rejects.toBeInstanceOf(ModerationUnavailable);
  });

  it('送信そのものが落ちても素通ししない（fail-closed）', async () => {
    await expect(
      applyInputModeration(moderationEnv(), 'なにか', {
        fetch: async () => {
          throw new TypeError('network down');
        },
      }),
    ).rejects.toBeInstanceOf(ModerationUnavailable);
  });

  it('例外の文言に本文が入らない', async () => {
    // ここはログへ出る（8.3 の「ログも外である」）。
    const secret = 'ここが本文である';
    const error = await applyInputModeration(moderationEnv(), secret, {
      fetch: async () => blockedResponse(),
    }).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(secret);
  });
});

describe('生成の段を包む（8.2 / #37）', () => {
  const generated = { source: 'package main', stopReason: 'end_turn' } as never;

  it('通れば内側が呼ばれる', async () => {
    let called = 0;
    const wrapped = withInputModeration(
      async () => {
        called += 1;
        return generated;
      },
      { fetch: async () => Response.json({ action: 'NONE' }) },
    );
    await wrapped(moderationEnv(), { prompt: 'ねこのパズル' });
    expect(called).toBe(1);
  });

  it('遮断されたら内側は呼ばれない（モデルへ到達しない）', async () => {
    // #37 の acceptance 1。**枠を消費しないのは、ここでモデルへ到達しないからである**
    // （`generations` の行はモデル呼び出しの後にしか作られない。確定25）。
    let called = 0;
    const wrapped = withInputModeration(
      async () => {
        called += 1;
        return generated;
      },
      { fetch: async () => blockedResponse() },
    );
    await expect(wrapped(moderationEnv(), { prompt: 'なにか' })).rejects.toBeInstanceOf(
      PromptBlocked,
    );
    expect(called).toBe(0);
  });

  it('呼べなかったときも内側は呼ばれない（fail-closed）', async () => {
    let called = 0;
    const wrapped = withInputModeration(
      async () => {
        called += 1;
        return generated;
      },
      { fetch: async () => Response.json({ action: 'NONE' }, { status: 500 }) },
    );
    await expect(wrapped(moderationEnv(), { prompt: 'なにか' })).rejects.toBeInstanceOf(
      ModerationUnavailable,
    );
    expect(called).toBe(0);
  });

  it('遮断を記録する', async () => {
    const seen: Array<{ categories: readonly string[]; prompt: string }> = [];
    const wrapped = withInputModeration(async () => generated, {
      fetch: async () => blockedResponse(['VIOLENCE']),
      record: async (categories, prompt) => {
        seen.push({ categories, prompt });
      },
    });
    await expect(wrapped(moderationEnv(), { prompt: 'なにか' })).rejects.toBeInstanceOf(
      PromptBlocked,
    );
    expect(seen).toEqual([{ categories: ['暴力表現'], prompt: 'なにか' }]);
  });

  it('記録に失敗しても遮断は取り下げない', async () => {
    // **記録が書けないことを理由に素通しにしない。**
    const wrapped = withInputModeration(async () => generated, {
      fetch: async () => blockedResponse(),
      record: async () => {
        throw new Error('D1 down');
      },
    });
    await expect(wrapped(moderationEnv(), { prompt: 'なにか' })).rejects.toBeInstanceOf(
      PromptBlocked,
    );
  });
});

describe('区切り文字', () => {
  it('カテゴリの表示名に混ざっていない', () => {
    // 混ざると、読み戻したときに 1 件が 2 件に割れる。
    for (const type of ['VIOLENCE', 'HATE', 'INSULTS', 'SEXUAL', 'MISCONDUCT', 'PROMPT_ATTACK']) {
      expect(categoryLabelOf(type)).not.toContain(MODERATION_CATEGORY_SEPARATOR);
    }
  });
});
