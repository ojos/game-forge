import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../src/routes.js';
import {
  GENERATE_CALLBACK_PATH,
  createGenerateCallbackRoutes,
  defaultCallbackNotifiers,
  generateCallbackRoutes,
  parseCallbackRequest,
} from '../src/generate-callback.js';
import type { CallbackNotifiers } from '../src/generate-callback.js';
import type { GenerationOutcome } from '../src/mail/generation-notice.js';
import { createPendingGame, hashJobToken } from '../src/games.js';
import {
  DEFAULT_GENERATION_MODEL_KEY,
  findGenerationModel,
} from '../src/generation-models.js';
import { recordBuildCache } from '../src/build-cache.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
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
async function seedPending(
  suffix: string,
): Promise<{ userId: string; id: string; jobToken: string }> {
  const userId = await seedUser(suffix);
  const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
  return { userId, id: pending.id, jobToken: pending.jobToken };
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
    // **既定の通知を使わない**（#148 / #153）。既定は本物の送信経路なので、
    // `.dev.vars` に Resend の鍵がある環境で回すと**テストから本番のメールが出る。**
    // 記録するだけの通知へ差し替え、送信の手前で止める。
    createGenerateCallbackRoutes(notifiers),
    new Request(`${APP_ORIGIN}${GENERATE_CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

/** 通知の呼び出しを記録する。 */
interface NotifierCalls {
  /** 80% 警告の判定が呼ばれた回数（#148）。 */
  costWarnings: number;
  /** 完了通知の呼び出し（#153）。**呼ばれた時点の `generation_state` も残す。** */
  finished: { gameId: string; outcome: GenerationOutcome; stateWhenCalled: string }[];
}

let calls: NotifierCalls;

/** 記録するだけの通知。**送信の手前で止まる。** */
const notifiers: CallbackNotifiers = {
  monthlyCostWarning: async () => {
    calls.costWarnings += 1;
    return 'not-configured';
  },
  generationFinished: async (_env, gameId, outcome) => {
    // **通知が呼ばれた時点で、作品行はもう進んでいるはずである**（#153）。
    // ここで読むことで「行を進める前に通知しない」を機械で確かめる。
    calls.finished.push({ gameId, outcome, stateWhenCalled: (await stateOf(gameId)).state });
    return 'not-configured';
  },
};

beforeEach(() => {
  calls = { costWarnings: 0, finished: [] };
});

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


/**
 * `finish` の成功側の本文。
 *
 * @param overrides 差し替える項目
 * @returns `artifacts` の中身
 */
function artifactsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const built = fakeBuildOutcome();
  return {
    goVersion: built.goVersion,
    sourceKey: built.keys.sourceKey,
    wasmKey: built.keys.wasmKey,
    cacheRecord: {
      sourceSha256: built.sourceSha256,
      goVersion: built.goVersion,
      sourceKey: built.keys.sourceKey,
      wasmKey: built.keys.wasmKey,
      wasmBytes: built.artifact.wasm.bytes,
      wasmSha256: built.artifact.wasm.sha256,
      compressedBytes: built.artifact.compressed.bytes,
      compressedSha256: built.artifact.compressed.sha256,
      contentEncoding: built.artifact.compressed.contentEncoding,
    },
    ...overrides,
  };
}

/**
 * `ledger` の本文。
 *
 * @param overrides 差し替える項目
 * @returns `ledger` の中身
 */
function ledgerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generationId: crypto.randomUUID(),
    prompt: 'ねこが主人公のパズル',
    modelKey: DEFAULT_GENERATION_MODEL_KEY,
    modelId: findGenerationModel(DEFAULT_GENERATION_MODEL_KEY)!.modelId,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    },
    ...overrides,
  };
}

/**
 * その利用者の台帳の行数を数える。
 *
 * @param userId 利用者の id
 * @returns 行数
 */
async function ledgerRowsOf(userId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from generations where user_id = ?')
    .bind(userId)
    .first<{ n: number }>();
  return row!.n;
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

  it('finish は成功と失敗のどちらか一方でなければならない', async () => {
    // 両方あると「成功なのか失敗なのか」を受け取り側が決めることになる。
    const both = await post({
      gameId: 'x',
      jobToken: 'y',
      kind: 'finish',
      errorCode: 'internal',
      artifacts: artifactsBody(),
    });
    expect(await both.json()).toEqual({ error: 'missing-outcome' });

    const neither = await post({ gameId: 'x', jobToken: 'y', kind: 'finish' });
    expect(await neither.json()).toEqual({ error: 'missing-outcome' });
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
    expect(await response.json()).toEqual({ accepted: true, finished: true });
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
    expect(await response.json()).toEqual({ accepted: false });
    expect((await stateOf(id)).state).toBe('running');
  });

  it('分類名も成果物も無い finish は断る', async () => {
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
    expect(await first.json()).toEqual({ accepted: true, finished: true });

    // 2 通目。トークンは既に捨てられているので false になり、**状態は書き換わらない。**
    const second = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      errorCode: 'internal',
    });
    expect(await second.json()).toEqual({ accepted: false });
    expect(await stateOf(id)).toEqual({ state: 'failed', error: 'build-failed' });
  });
});

describe('ledger（3.3-4 / 確定25。届くまで再送される前提）', () => {
  it('台帳へ 1 行書ける', async () => {
    const { userId, id, jobToken } = await seedPending('ledger');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const before = await ledgerRowsOf(userId);
    const response = await post({ gameId: id, jobToken, kind: 'ledger', ledger: ledgerBody() });
    expect(await response.json()).toEqual({ accepted: true, recorded: true });
    expect(await ledgerRowsOf(userId)).toBe(before + 1);
  });

  it('同じ generationId の再送は行を増やさない（費用ゼロの再送を前提にする）', async () => {
    // **LLM を呼んだあとにコールバックが落ち続けると、課金は出ているのに台帳の行が
    // 無い状態になる**（4.3 が崩れ、日次枠も減らない）。再送は費用ゼロなので呼ぶ側は
    // 届くまで送ってよく、こちら側は何度受け取っても 1 行でなければならない。
    const { userId, id, jobToken } = await seedPending('ledger-retry');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const ledger = ledgerBody();
    const before = await ledgerRowsOf(userId);

    const first = await post({ gameId: id, jobToken, kind: 'ledger', ledger });
    expect(await first.json()).toEqual({ accepted: true, recorded: true });

    const second = await post({ gameId: id, jobToken, kind: 'ledger', ledger });
    // 受け付けはするが、行は増えない。
    expect(await second.json()).toEqual({ accepted: true, recorded: false });
    expect(await ledgerRowsOf(userId)).toBe(before + 1);
  });

  it('別の generationId なら別の行になる（リトライ分も必ず計上する）', async () => {
    // 5.2-7 のリトライは LLM 呼び出しの回数だけ行を作る（確定25）。
    const { userId, id, jobToken } = await seedPending('ledger-retries');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const before = await ledgerRowsOf(userId);

    await post({ gameId: id, jobToken, kind: 'ledger', ledger: ledgerBody() });
    await post({ gameId: id, jobToken, kind: 'ledger', ledger: ledgerBody() });
    expect(await ledgerRowsOf(userId)).toBe(before + 2);
  });

  it('作者は本文からではなく games 行から取る', async () => {
    // **本文から取ると、トークンを持つ者が他人の枠を消費できる。**
    const { userId, id, jobToken } = await seedPending('ledger-author');
    await post({ gameId: id, jobToken, kind: 'claim' });
    await post({ gameId: id, jobToken, kind: 'ledger', ledger: ledgerBody() });

    const row = await env.DB.prepare(
      'select user_id from generations order by rowid desc limit 1',
    ).first<{ user_id: string }>();
    expect(row?.user_id).toBe(userId);
  });

  it('壊れた ledger を断る', async () => {
    const { id, jobToken } = await seedPending('ledger-invalid');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const broken: Record<string, unknown>[] = [
      ledgerBody({ modelKey: '知らないモデル' }),
      ledgerBody({ prompt: '' }),
      ledgerBody({ prompt: 'あ'.repeat(2001) }),
      ledgerBody({ usage: { inputTokens: -1, outputTokens: 1, cacheReadInputTokens: null, cacheWriteInputTokens: null } }),
      ledgerBody({ usage: { inputTokens: 1.5, outputTokens: 1, cacheReadInputTokens: null, cacheWriteInputTokens: null } }),
      ledgerBody({ generationId: '' }),
    ];
    for (const ledger of broken) {
      const response = await post({ gameId: id, jobToken, kind: 'ledger', ledger });
      expect(response.status, JSON.stringify(ledger).slice(0, 60)).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid-ledger' });
    }
  });

  it('トークンが違えば台帳を書けない', async () => {
    const { userId, id, jobToken } = await seedPending('ledger-token');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const before = await ledgerRowsOf(userId);

    const response = await post({
      gameId: id,
      jobToken: 'c'.repeat(64),
      kind: 'ledger',
      ledger: ledgerBody(),
    });
    expect(await response.json()).toEqual({ accepted: false });
    expect(await ledgerRowsOf(userId)).toBe(before);
  });
});

describe('cache-lookup（3.8）', () => {
  it('索引が無ければミスを返す', async () => {
    const { id, jobToken } = await seedPending('cache-miss');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'cache-lookup',
      sourceSha256: 'd'.repeat(64),
    });
    expect(await response.json()).toEqual({
      accepted: true,
      lookup: { hit: false, reason: 'not-indexed' },
    });
  });

  it('索引があり成果物も在ればヒットを返す', async () => {
    const { id, jobToken } = await seedPending('cache-hit');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const built = fakeBuildOutcome();
    await env.BUCKET.put(built.keys.sourceKey, 'package main');
    await env.BUCKET.put(built.keys.wasmKey, 'wasm');
    await recordBuildCache(
      env,
      {
        sourceSha256: built.sourceSha256,
        goVersion: built.goVersion,
        sourceKey: built.keys.sourceKey,
        wasmKey: built.keys.wasmKey,
        wasmBytes: built.artifact.wasm.bytes,
        wasmSha256: built.artifact.wasm.sha256,
        compressedBytes: built.artifact.compressed.bytes,
        compressedSha256: built.artifact.compressed.sha256,
        contentEncoding: built.artifact.compressed.contentEncoding,
      },
      1_700_000_000,
    );

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'cache-lookup',
      sourceSha256: built.sourceSha256,
    });
    const body = (await response.json()) as { lookup: { hit: boolean } };
    expect(body.lookup.hit).toBe(true);
  });

  it('ハッシュの綴りが違えば断る', async () => {
    const { id, jobToken } = await seedPending('cache-bad-hash');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const response = await post({
      gameId: id,
      jobToken,
      kind: 'cache-lookup',
      sourceSha256: 'ZZZ',
    });
    expect(await response.json()).toEqual({ error: 'invalid-source-hash' });
  });
});

describe('finish（成功側）', () => {
  it('成果物を書いて完成させ、トークンを捨てる', async () => {
    const { id, jobToken } = await seedPending('finish-ok');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      artifacts: artifactsBody(),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });

    const row = await env.DB.prepare(
      'select generation_state, go_version, wasm_key, preview_key, job_token_hash from games where id = ?',
    )
      .bind(id)
      .first<{
        generation_state: string;
        go_version: string;
        wasm_key: string;
        preview_key: string;
        job_token_hash: string | null;
      }>();
    expect(row?.generation_state).toBe('ready');
    expect(row?.go_version).toBe(fakeBuildOutcome().goVersion);
    expect(row?.wasm_key).toBe(fakeBuildOutcome().keys.wasmKey);
    // **preview_key は完成と同時にしか入らない。**
    expect(row?.preview_key).toMatch(/^[0-9a-f]{32}$/u);
    expect(row?.job_token_hash).toBeNull();
  });

  it('空の go_version で完成させられない（配信側の 500 を作らせない）', async () => {
    // 3.5 の `wasm_exec.js` 出し分けの入力なので、空のまま完成させると
    // `/p/<key>/wasm_exec.js` が 500 になる。
    const { id, jobToken } = await seedPending('finish-empty-version');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      artifacts: artifactsBody({ goVersion: '' }),
    });
    expect(await response.json()).toEqual({ error: 'invalid-artifacts' });
    expect((await stateOf(id)).state).toBe('running');
  });

  it('キャッシュヒット時は索引を書き直さない（cacheRecord = null）', async () => {
    const { id, jobToken } = await seedPending('finish-cached');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      artifacts: artifactsBody({ cacheRecord: null }),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
    expect((await stateOf(id)).state).toBe('ready');
  });

  it('cacheRecord の項目そのものが無ければ断る（索引更新の落としを検出する）', async () => {
    // **欠落（項目なし）とキャッシュヒット（null）を同じ扱いにしない。**
    // 同じにすると、呼ぶ側が索引の更新を落としたことを検出できず、そのまま `ready` へ
    // 進む。次に同じソースが来てもヒットせず、**気づけないまま約 16 円と 21.6 秒を
    // 余計に払い続ける。**
    const { id, jobToken } = await seedPending('finish-missing-record');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const artifacts = artifactsBody();
    delete artifacts['cacheRecord'];

    const response = await post({ gameId: id, jobToken, kind: 'finish', artifacts });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid-artifacts' });
    // 進んでいないこと。
    expect((await stateOf(id)).state).toBe('running');
  });

  it('明示的な null は受け付ける（ヒット時の「書き直さない」）', async () => {
    // 上の検査が厳しすぎないことの確認。**意図した null と書き忘れを区別している。**
    const { id, jobToken } = await seedPending('finish-explicit-null');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const response = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      artifacts: artifactsBody({ cacheRecord: null }),
    });
    expect(await response.json()).toEqual({ accepted: true, finished: true });
  });

  it('壊れた cacheRecord を断る', async () => {
    const { id, jobToken } = await seedPending('finish-bad-record');
    await post({ gameId: id, jobToken, kind: 'claim' });

    const response = await post({
      gameId: id,
      jobToken,
      kind: 'finish',
      artifacts: artifactsBody({
        cacheRecord: { ...(artifactsBody().cacheRecord as object), wasmSha256: 'short' },
      }),
    });
    expect(await response.json()).toEqual({ error: 'invalid-artifacts' });
  });
});

describe('通知の結線（#148 / #153）', () => {
  it('ledger を受け取ると、費用 80% の判定が 1 回走る', async () => {
    const { id, jobToken } = await seedPending('notify-ledger');
    await post({ gameId: id, jobToken, kind: 'claim' });
    expect(calls.costWarnings).toBe(0);

    await post({ gameId: id, jobToken, kind: 'ledger', ledger: ledgerBody() });
    expect(calls.costWarnings).toBe(1);
  });

  it('ledger の再送でも判定へ入る（抑止は通知側が持つ）', async () => {
    // **「行が増えたか」に抑止を兼ねさせない。** 行を書いた直後に落ちた回の警告が
    // 永久に出なくなる（`src/mail/cost-alert.ts` が月ごとの目印で抑止する）。
    const { id, jobToken } = await seedPending('notify-ledger-resend');
    await post({ gameId: id, jobToken, kind: 'claim' });
    const ledger = ledgerBody();

    const first = await post({ gameId: id, jobToken, kind: 'ledger', ledger });
    const second = await post({ gameId: id, jobToken, kind: 'ledger', ledger });
    expect(await first.json()).toEqual({ accepted: true, recorded: true });
    expect(await second.json()).toEqual({ accepted: true, recorded: false });
    expect(calls.costWarnings).toBe(2);
  });

  it('claim と cache-lookup では通知が動かない（費用も結果も変わらない）', async () => {
    const { id, jobToken } = await seedPending('notify-no-op');
    await post({ gameId: id, jobToken, kind: 'claim' });
    await post({ gameId: id, jobToken, kind: 'cache-lookup', sourceSha256: 'a'.repeat(64) });
    expect(calls.costWarnings).toBe(0);
    expect(calls.finished).toHaveLength(0);
  });

  it('finish（成功）は、行を ready にしてから作者へ通知する', async () => {
    const { id, jobToken } = await seedPending('notify-finish-ready');
    await post({ gameId: id, jobToken, kind: 'claim' });

    await post({ gameId: id, jobToken, kind: 'finish', artifacts: artifactsBody() });
    expect(calls.finished).toEqual([
      // **利用者から見える状態は、通知より先に確定している**（#153）。
      { gameId: id, outcome: { kind: 'ready' }, stateWhenCalled: 'ready' },
    ]);
  });

  it('finish（失敗）は、分類名を添えて通知する', async () => {
    const { id, jobToken } = await seedPending('notify-finish-failed');
    await post({ gameId: id, jobToken, kind: 'claim' });

    await post({ gameId: id, jobToken, kind: 'finish', errorCode: 'build-failed' });
    expect(calls.finished).toEqual([
      {
        gameId: id,
        outcome: { kind: 'failed', errorCode: 'build-failed' },
        stateWhenCalled: 'failed',
      },
    ]);
  });

  it('効かなかった finish では通知しない（二重送信の抑止）', async () => {
    // ジョブトークンは完了と同時に捨てられるので、遅れて届いた再送は照合で落ちる
    // （`src/games.ts`）。**通知の抑止はこの性質に乗っている。**
    const { id, jobToken } = await seedPending('notify-finish-twice');
    await post({ gameId: id, jobToken, kind: 'claim' });
    await post({ gameId: id, jobToken, kind: 'finish', artifacts: artifactsBody() });

    const again = await post({ gameId: id, jobToken, kind: 'finish', artifacts: artifactsBody() });
    expect(await again.json()).toEqual({ accepted: false });
    expect(calls.finished).toHaveLength(1);
  });

  it('経路表に登録されるのは既定の通知を持つ 1 本である', async () => {
    // 差し替えられる形にしたことで本番の結線が変わっていないこと。
    expect(generateCallbackRoutes).toHaveLength(1);
    expect(generateCallbackRoutes[0]!.path).toBe(GENERATE_CALLBACK_PATH);
    expect(Object.keys(defaultCallbackNotifiers).sort()).toEqual([
      'generationFinished',
      'monthlyCostWarning',
    ]);
  });
});
