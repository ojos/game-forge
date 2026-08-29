import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import {
  GENERATE_CALLBACK_PATH,
  generateCallbackRoutes,
  parseCallbackRequest,
} from '../src/generate-callback.js';
import { createPendingGame, hashJobToken } from '../src/games.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `cb-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * 生成中の作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 作品 id とジョブトークン
 */
async function seedPending(suffix: string): Promise<{ id: string; jobToken: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
  return { id: pending.id, jobToken: pending.jobToken };
}

/**
 * コールバックを送る。
 *
 * @param body 本文（文字列ならそのまま送る）
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function post(body: unknown, contentType = 'application/json'): Promise<Response> {
  return await dispatch(
    generateCallbackRoutes,
    new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

/**
 * `generation_state` を読む。
 *
 * @param id 作品 id
 * @returns 状態と分類名
 */
async function stateOf(id: string): Promise<{ state: string; error: string | null }> {
  const row = await env.DB.prepare(
    'select generation_state, generation_error from games where id = ?',
  )
    .bind(id)
    .first<{ generation_state: string; generation_error: string | null }>();
  return { state: row!.generation_state, error: row!.generation_error };
}

beforeAll(async () => {
  await applySchema();
});

describe('本文の検証（#150）', () => {
  it('JSON 以外は受け付けない', async () => {
    const response = await post('{}', 'text/plain');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported-content-type' });
  });

  it('壊れた JSON を断る', async () => {
    expect((await post('{')).status).toBe(400);
  });

  it('未知の項目を断る（綴り違いが既定値で通らない）', async () => {
    const response = await post({
      gameId: 'x',
      jobToken: 'y',
      kind: 'claim',
      extra: 1,
    });
    expect(await response.json()).toEqual({ error: 'unknown-field' });
  });

  it('id とトークンと種別を必須にする', async () => {
    expect(await (await post({ jobToken: 'y', kind: 'claim' })).json()).toEqual({
      error: 'missing-game-id',
    });
    expect(await (await post({ gameId: 'x', kind: 'claim' })).json()).toEqual({
      error: 'missing-job-token',
    });
    expect(await (await post({ gameId: 'x', jobToken: 'y', kind: 'nope' })).json()).toEqual({
      error: 'unknown-kind',
    });
  });

  it('知らない失敗の分類名を素通ししない', async () => {
    // **素通しすると、画面が知らない値が `generation_error` に入る。**
    // 何が起きたかを利用者にもこちらにも説明できなくなる。
    const response = await post({
      gameId: 'x',
      jobToken: 'y',
      kind: 'finish',
      errorCode: 'とても失敗',
    });
    expect(await response.json()).toEqual({ error: 'unknown-error-code' });
  });

  it('解析だけを単体でも呼べる', async () => {
    const parsed = await parseCallbackRequest(
      new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId: 'g', jobToken: 't', kind: 'claim' }),
      }),
    );
    expect(parsed).toEqual({ ok: true, request: { gameId: 'g', jobToken: 't', kind: 'claim' } });
  });
});

describe('claim（重複実行を止める関門）', () => {
  it('正しいトークンなら握れ、2 通目は握れない', async () => {
    const { id, jobToken } = await seedPending('claim');

    const first = await post({ gameId: id, jobToken, kind: 'claim' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ claimed: true });

    // **2 通目。** AWS は「関数がエラーを返さなくても同じイベントを複数回配信しうる」
    // と明文で書いている。ここが false でなければ、16 円がもう一度出る。
    const second = await post({ gameId: id, jobToken, kind: 'claim' });
    expect(await second.json()).toEqual({ claimed: false });

    expect((await stateOf(id)).state).toBe('running');
  });

  it('トークンが違えば握れない', async () => {
    const { id } = await seedPending('claim-bad-token');
    const response = await post({ gameId: id, jobToken: 'a'.repeat(64), kind: 'claim' });
    expect(await response.json()).toEqual({ claimed: false });
    expect((await stateOf(id)).state).toBe('pending');
  });

  it('存在しない作品でも理由を分けずに false を返す', async () => {
    // 区別すると、任意の id が実在するかを外から確かめられる。
    const response = await post({
      gameId: '9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f',
      jobToken: 'a'.repeat(64),
      kind: 'claim',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: false });
  });
});

describe('finish（失敗の記録）', () => {
  it('握ったジョブを失敗として閉じられる', async () => {
    const { id, jobToken } = await seedPending('finish');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({ gameId: id, jobToken, kind: 'finish', errorCode: 'internal' });
    expect(await response.json()).toEqual({ finished: true });
    expect(await stateOf(id)).toEqual({ state: 'failed', error: 'internal' });
  });

  it('トークンが違えば他人の生成を失敗にできない', async () => {
    // **`failGame` 自体はトークンを見ない**（同期実行では Worker が自分で呼ぶため）。
    // 外から呼ばれるこの経路だけが、先に照合する。
    const { id, jobToken } = await seedPending('finish-bad-token');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken: 'b'.repeat(64),
      kind: 'finish',
      errorCode: 'internal',
    });
    expect(await response.json()).toEqual({ finished: false });
    expect((await stateOf(id)).state).toBe('running');
  });

  it('分類名を省いた finish は断る', async () => {
    const { id, jobToken } = await seedPending('finish-no-code');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const response = await post({ gameId: id, jobToken, kind: 'finish' });
    expect(response.status).toBe(400);
    expect((await stateOf(id)).state).toBe('running');
  });

  it('同じ finish を 2 回受け取っても壊れない（再送を前提にする）', async () => {
    // **コールバックの再送は LLM を呼ばないので費用ゼロである。** 呼ぶ側は届くまで
    // 再送してよく、こちら側は何度受け取っても同じ結果でなければならない。
    const { id, jobToken } = await seedPending('finish-twice');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const first = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      errorCode: 'build-failed',
    });
    expect(await first.json()).toEqual({ finished: true });

    // 2 通目。トークンは既に捨てられているので false になり、**状態は書き換わらない。**
    const second = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      errorCode: 'internal',
    });
    expect(await second.json()).toEqual({ finished: false });
    expect(await stateOf(id)).toEqual({ state: 'failed', error: 'build-failed' });
  });
});
