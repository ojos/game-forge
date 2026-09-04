/**
 * フォーク（5.3 / M5-1 / #32）の検査。
 *
 * # issue の acceptance と、それをどこで見るか
 *
 * | acceptance | 見る場所 |
 * |---|---|
 * | 生成された子の `parent_id` が親を指す | 「子が生まれ、親を指す」 |
 * | 親ソースが `messages` の先頭に置かれ、同一親の 2 回目で `cache_read_input_tokens` が 0 より大きい | 「4.5 のキャッシュ（同じ親の 2 回目）」 |
 * | 親が `published` でない場合に拒否される | 「公開されていない作品はフォークできない」 |
 *
 * # 生成 API を呼ばない
 *
 * **1 回 約 16〜25 円が受け入れ条件に混ざる形にしない**（`src/fork.ts` /
 * `test/revise.test.ts` と同じ方針）。経路層のハンドラを直接叩き、`startJob` を
 * 差し替えて、**起動されたジョブそのものを見る。**
 *
 * キャッシュの検査も同じで、**Bedrock へは 1 回も出ない。** 4.5 の仕組み——
 * 「ブレークポイントより前が前回と同じなら読み出しになる」——を `fetch` の差し替えで
 * 再現し、**フォークの経路が組み立てた本文**をそこへ通す。これが確かめるのは
 * 「同じ親なら共有プレフィックスが実際に一致すること」で、**揮発値（作品 id・
 * ジョブトークン・時刻）が前置きへ混ざれば落ちる。**
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_PATH } from '../src/auth/google.js';
import { createBedrockGenerateSource } from '../src/bedrock.js';
import {
  FORK_SIZE_CONSENT_FIELD,
  FORK_SIZE_CONSENT_PROCEED,
  FORK_SIZE_CONSENT_TIDY,
  createForkRoutes,
} from '../src/fork.js';
import type { GenerationJob, GenerationPipeline } from '../src/generate.js';
import { defaultPipeline } from '../src/generate.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
  publishGame,
  REMOVED_STATUS,
} from '../src/games.js';
import type { SystemBlock } from '../src/generation-models.js';
import {
  buildOrchestratorPayload,
  ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE,
  parseOrchestratorPayload,
} from '../src/orchestrator/payload.js';
import { FORK_PARENT_ID_FIELD, FORK_PATH, FORK_PROMPT_FIELD } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER, QUOTA_EXCEEDED_STATUS } from '../src/quota.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import {
  MAX_SOURCE_BYTES,
  SOURCE_SIZE_WARNING_BYTES,
  TIDY_MAX_SOURCE_BYTES,
} from '../src/source-size.js';
import { workPagePath } from '../src/work-page.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-fork-endpoint-01';
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** 親に置くソース。**この文字列が `messages` の先頭に現れることが acceptance である。** */
const PARENT_SOURCE = 'package main\n\nfunc main() { println("parent") }\n';

beforeAll(async () => {
  await applySchema();
});

/** @returns 秘密を差し替えた env */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET } as Env;
}

/**
 * ジョブの起動を記録する差し替え（`test/revise.test.ts` と同じ形）。
 *
 * @param fail true なら起動が失敗する
 * @returns 起動されたジョブの記録と、差し替えた pipeline
 */
function startSpy(fail = false): { calls: GenerationJob[]; pipeline: GenerationPipeline } {
  const calls: GenerationJob[] = [];
  return {
    calls,
    pipeline: {
      ...defaultPipeline,
      startJob: async (_env: Env, job: GenerationJob) => {
        calls.push(job);
        if (fail) {
          throw new Error('invoke failed');
        }
      },
    },
  };
}

/** @returns セッション cookie を載せたヘッダ */
async function sessionHeaders(userId: string, extra: Record<string, string>): Promise<HeadersInit> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return { ...extra, cookie: buildSessionCookie(token, 3600).split(';')[0]! };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param id 利用者の id
 * @returns 作った利用者の id
 */
async function createUser(id: string): Promise<string> {
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at)
     values (?, ?, ?, ?, 0)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * 完成した作品を 1 件作り、R2 にソースを置く（**まだ公開していない**）。
 *
 * @param userId 作者
 * @param source R2 へ置くソース
 * @returns 作品 id
 */
async function createReadyGame(userId: string, source: string = PARENT_SOURCE): Promise<string> {
  const pending = await createPendingGame(env, userId, { prompt: '玉を避けるゲーム' });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  // **成果物のキーを作品ごとに変える。** 雛形の既定は 1 組の固定キーで、そのまま
  // 使うと 2 件目の R2 への書き込みが 1 件目を上書きし、**別々の親のつもりが同じ
  // ソースを指す**（確定26 が言うのは「共有されうる」ことで、ここでは共有させない）。
  const sha = `${'0'.repeat(56)}${pending.id.slice(0, 8)}`;
  await completeGame(
    env,
    pending.id,
    fakeBuildOutcome({
      sourceSha256: sha,
      keys: { sourceKey: `builds/${sha}/source.go`, wasmKey: `builds/${sha}/go1.26.5/game.wasm.br` },
    }),
  );
  const row = await env.DB.prepare('select source_key from games where id = ?')
    .bind(pending.id)
    .first<{ source_key: string }>();
  await env.BUCKET.put(row!.source_key, source);
  return pending.id;
}

/**
 * 公開済みの作品を 1 件用意する（フォークの親になれる唯一の状態。5.3）。
 *
 * @param userId 作者
 * @param source R2 へ置くソース
 * @returns 作品 id
 */
async function createPublishedGame(
  userId: string,
  source: string = PARENT_SOURCE,
): Promise<string> {
  const id = await createReadyGame(userId, source);
  const published = await publishGame(env, id, userId);
  expect(published.ok).toBe(true);
  return id;
}

/**
 * フォークを要求する。
 *
 * @param userId 送る利用者（null なら未ログイン）
 * @param parentId 親の作品 id
 * @param prompt 差分プロンプト
 * @param pipeline 差し替えた pipeline
 * @param consent 事前警告への同意（確定18 の条件 1）。省くと**送らない**
 * @returns レスポンス
 */
async function postFork(
  userId: string | null,
  parentId: string,
  prompt: string,
  pipeline: GenerationPipeline,
  consent?: string,
): Promise<Response> {
  const base = { 'content-type': FORM_TYPE, accept: 'text/html' };
  const headers = userId === null ? base : await sessionHeaders(userId, base);
  const body = new URLSearchParams({
    [FORK_PARENT_ID_FIELD]: parentId,
    [FORK_PROMPT_FIELD]: prompt,
    ...(consent === undefined ? {} : { [FORK_SIZE_CONSENT_FIELD]: consent }),
  }).toString();
  return await dispatch(
    createForkRoutes(pipeline),
    new Request(`${APP_ORIGIN}${FORK_PATH}`, { method: 'POST', headers, body }),
    testEnv(),
  );
}

/** D1 から読んだ `games` の 1 行（列名は SQL の綴りそのもの）。 */
interface GameRow {
  id: string;
  author_id: string;
  parent_id: string | null;
  status: string;
  generation_state: string;
  fork_count: number;
}

/**
 * ある利用者が作った作品を新しい順に引く。
 *
 * @param userId 作者
 * @returns 行の配列
 */
async function gamesOf(userId: string): Promise<GameRow[]> {
  const { results } = await env.DB.prepare(
    `select id, author_id, parent_id, status, generation_state, fork_count
       from games where author_id = ? order by rowid desc`,
  )
    .bind(userId)
    .all<GameRow>();
  return results;
}

describe('フォークの受け口（5.3 / #32）', () => {
  it('未ログインならログインへ送る', async () => {
    const spy = startSpy();
    const response = await postFork(null, crypto.randomUUID(), '敵を増やす', spy.pipeline);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(spy.calls).toHaveLength(0);
  });

  it('どう改造するかが空なら受け付けない', async () => {
    const author = await createUser('fork-empty-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-empty-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '   ', spy.pipeline);

    expect(response.status).toBe(400);
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('親の id の形が違えば、D1 を引く前に落ちる', async () => {
    const forker = await createUser('fork-badid-forker');
    const spy = startSpy();
    const body = new URLSearchParams({
      [FORK_PARENT_ID_FIELD]: '../../etc/passwd',
      [FORK_PROMPT_FIELD]: '敵を増やす',
    }).toString();
    const response = await dispatch(
      createForkRoutes(spy.pipeline),
      new Request(`${APP_ORIGIN}${FORK_PATH}`, {
        method: 'POST',
        headers: await sessionHeaders(forker, { 'content-type': FORM_TYPE, accept: 'text/html' }),
        body,
      }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('子が生まれ、親を指す（acceptance 1 / 5.3）', () => {
  it('生成された子の parent_id が親を指す', async () => {
    const author = await createUser('fork-parent-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-parent-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を 2 体にする', spy.pipeline);

    // **親ではなく子の作品ページへ送る。**
    expect(response.status).toBe(303);
    expect(spy.calls).toHaveLength(1);
    const childId = spy.calls[0]!.gameId;
    expect(response.headers.get('location')).toBe(workPagePath(childId));

    const children = await gamesOf(forker);
    expect(children).toHaveLength(1);
    const child = children[0]!;
    // **これが acceptance 1 である。**
    expect(child.id).toBe(childId);
    expect(child.parent_id).toBe(parentId);
    // 子は改造した人のものである（親の作者のものではない）。
    expect(child.author_id).toBe(forker);
    // 5.4: 生成の経路は `published` を作れない。子は `draft` から始まる。
    expect(child.status).toBe('draft');
    expect(child.generation_state).toBe('pending');
  });

  it('親の系統は 1 本のままである（単一親のツリー。DAG にしない）', async () => {
    const author = await createUser('fork-tree-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-tree-forker');
    const spy = startSpy();

    await postFork(forker, parentId, '1 回目', spy.pipeline);
    await postFork(forker, parentId, '2 回目', spy.pipeline);

    const children = await gamesOf(forker);
    expect(children).toHaveLength(2);
    // **どちらも親を 1 つだけ持つ。** 列が 1 本しか無いので構造として DAG にならない。
    expect(children.map((row) => row.parent_id)).toEqual([parentId, parentId]);
  });

  it('fork_count は動かさない（#34 の担当。M5-1 の境界）', async () => {
    const author = await createUser('fork-count-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-count-forker');

    await postFork(forker, parentId, '色を変える', startSpy().pipeline);

    const parent = await env.DB.prepare('select fork_count from games where id = ?')
      .bind(parentId)
      .first<{ fork_count: number }>();
    // **`pending` の行を数えない。** ビルドが通らずに終わるかもしれない行を数えると、
    // 5.5 の「このゲームからの改造: N 件」（`status='published'` のみ）と食い違う。
    // **この値を動かすのは #34 である**（動かす日にこの検査を更新すること）。
    expect(parent?.fork_count).toBe(0);
  });

  it('自分の公開作品も親にできる（5.7「公開後に手を入れたい作者はフォークする」）', async () => {
    const author = await createUser('fork-self-author');
    const parentId = await createPublishedGame(author);
    const spy = startSpy();

    const response = await postFork(author, parentId, '公開後に直す', spy.pipeline);

    expect(response.status).toBe(303);
    const rows = await gamesOf(author);
    const child = rows.find((row) => row.id !== parentId);
    expect(child?.parent_id).toBe(parentId);
  });

  it('起動に失敗したら、行を pending のまま残さない', async () => {
    const author = await createUser('fork-fail-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-fail-forker');
    const spy = startSpy(true);

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(500);
    const children = await gamesOf(forker);
    expect(children).toHaveLength(1);
    // `pending` のまま残すと、15 分後に「中断したかもしれない」と言い続ける行になる。
    expect(children[0]!.generation_state).toBe('failed');
  });

  it('fetch から叩けば 202 と URL が返る', async () => {
    const author = await createUser('fork-json-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-json-forker');
    const spy = startSpy();

    const response = await dispatch(
      createForkRoutes(spy.pipeline),
      new Request(`${APP_ORIGIN}${FORK_PATH}`, {
        method: 'POST',
        headers: await sessionHeaders(forker, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          [FORK_PARENT_ID_FIELD]: parentId,
          [FORK_PROMPT_FIELD]: '敵を増やす',
        }),
      }),
      testEnv(),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['parentId']).toBe(parentId);
    expect(body['url']).toBe(workPagePath(spy.calls[0]!.gameId));
  });
});

describe('公開されていない作品はフォークできない（acceptance 3 / 5.3）', () => {
  /**
   * 断られたことを確かめる。**行も生成もできていないことまで見る。**
   *
   * @param response 返ってきたレスポンス
   * @param forker 改造しようとした人
   * @param spy 起動の記録
   */
  async function expectRefused(
    response: Response,
    forker: string,
    spy: { calls: GenerationJob[] },
  ): Promise<void> {
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('公開されている作品だけ');
    // **LLM を 1 度も呼んでいない。**
    expect(spy.calls).toHaveLength(0);
    // **生成されることのない `pending` の行を残さない。**
    expect(await gamesOf(forker)).toHaveLength(0);
  }

  it('親が draft なら拒否する', async () => {
    const author = await createUser('fork-draft-author');
    // **公開していない。** 完成済み・ソースも R2 に在るが、それだけでは親になれない。
    const parentId = await createReadyGame(author);
    const forker = await createUser('fork-draft-forker');
    const spy = startSpy();

    await expectRefused(await postFork(forker, parentId, '敵を増やす', spy.pipeline), forker, spy);
  });

  it('親が removed（8.4 の tombstone）なら拒否する', async () => {
    const author = await createUser('fork-removed-author');
    const parentId = await createPublishedGame(author);
    await env.DB.prepare('update games set status = ? where id = ?')
      .bind(REMOVED_STATUS, parentId)
      .run();
    const forker = await createUser('fork-removed-forker');
    const spy = startSpy();

    await expectRefused(await postFork(forker, parentId, '敵を増やす', spy.pipeline), forker, spy);
  });

  it('親が存在しなくても、未公開と同じ断り方をする（実在の手がかりを与えない）', async () => {
    const forker = await createUser('fork-missing-forker');
    const spy = startSpy();

    await expectRefused(
      await postFork(forker, crypto.randomUUID(), '敵を増やす', spy.pipeline),
      forker,
      spy,
    );
  });

  it('自分の未公開作品も親にできない（推敲の口はそちらが持つ。5.7）', async () => {
    const author = await createUser('fork-own-draft');
    const parentId = await createReadyGame(author);
    const spy = startSpy();

    const response = await postFork(author, parentId, '直す', spy.pipeline);
    expect(response.status).toBe(409);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('元のソースの扱い（確定18 / 5.3）', () => {
  it('30KB を超える親には、断る前に整理を問う（確定18 の条件 2）', async () => {
    const author = await createUser('fork-large-author');
    // **上限のちょうど 1 バイト上。** 切り詰めて渡すと、コンパイルが必ず落ちて枠だけが消える。
    const parentId = await createPublishedGame(author, 'x'.repeat(MAX_SOURCE_BYTES + 1));
    const forker = await createUser('fork-large-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('整理して続けますか（生成枠を 1 回使います）');
    // **問うだけで、まだ何も始めない。** 枠も行も使っていない。
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('R2 に実体が無ければ、子を作らずに断る', async () => {
    const author = await createUser('fork-nosrc-author');
    const parentId = await createPublishedGame(author);
    const row = await env.DB.prepare('select source_key from games where id = ?')
      .bind(parentId)
      .first<{ source_key: string }>();
    await env.BUCKET.delete(row!.source_key);
    const forker = await createUser('fork-nosrc-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(500);
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('親のソースがそのままジョブへ載る（切り詰めない・組み替えない）', async () => {
    const author = await createUser('fork-src-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-src-forker');
    const spy = startSpy();

    await postFork(forker, parentId, '敵を 2 体にする', spy.pipeline);

    expect(spy.calls[0]!.request.baseSource).toBe(PARENT_SOURCE);
    // **プロンプトと分けて持つ**（`src/generate.ts` の `GenerateRequest`）。連結すると
    // 4.5 の区切りをソースの直後へ置けず、台帳に残るのが利用者の入力でなくなる。
    expect(spy.calls[0]!.request.prompt).toBe('敵を 2 体にする');
  });
});

/** 警告の閾値を超えるが上限には収まる親ソース（事前警告の帯。確定18 の条件 1）。 */
const NEAR_LIMIT_SOURCE = 'x'.repeat(SOURCE_SIZE_WARNING_BYTES + 1);

describe('大きい親は、始める前に知らせる（確定18 の条件 1 / M5-2 / #33）', () => {
  it('24KB を超える親では、同意を取るまでフォークを始めない', async () => {
    const author = await createUser('fork-warn-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(409);
    const page = await response.text();
    expect(page).toContain('この作品はすでに大きめです');
    // **警告の時点で枠も行も使っていない。** ここが崩れると、確定18 が避けたかった
    // 「知らないうちに枠を使わされた」体験そのものになる。
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('警告の画面が、上限と閾値の実際の値を出す', async () => {
    const author = await createUser('fork-warn-figures-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-figures-forker');
    const spy = startSpy();

    const page = await (await postFork(forker, parentId, '敵を増やす', spy.pipeline)).text();

    // **定数から出ていることを見る。** 手書きの数字だと、上限が動いた日に画面だけが
    // 古い値を出し続ける。**期待値も定数から組み立てる**——直値で並べると、上限が
    // 動くたびにこの 3 行を書き換えることになり、「画面が定数から出 している」と
    // いう本題の検査が値の追随作業に埋もれる（#284）。
    const grouped = (value: number): string =>
      String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
    expect(page).toContain(`${grouped(MAX_SOURCE_BYTES)} バイト`);
    expect(page).toContain(`${grouped(SOURCE_SIZE_WARNING_BYTES)} バイト`);
    expect(page).toContain(grouped(SOURCE_SIZE_WARNING_BYTES + 1));
    // **直値の錨は 1 行だけ持つ。** これが無いと、上限を変えた実装にテストごと
    // 追随されて変異が検出できない（#284 で 30,720 → 65,536）。
    expect(MAX_SOURCE_BYTES).toBe(65_536);
    expect(SOURCE_SIZE_WARNING_BYTES).toBe(52_428);
  });

  it('警告の画面が、書いた差分プロンプトを預かり直す', async () => {
    // 入力し直させると、警告のたびに書いた文章が消える。
    const author = await createUser('fork-warn-keep-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-keep-forker');
    const spy = startSpy();

    const page = await (
      await postFork(forker, parentId, '敵を 3 体にする', spy.pipeline)
    ).text();

    expect(page).toContain(`name="${FORK_PROMPT_FIELD}" value="敵を 3 体にする"`);
    expect(page).toContain(`name="${FORK_PARENT_ID_FIELD}" value="${parentId}"`);
    expect(page).toContain(
      `name="${FORK_SIZE_CONSENT_FIELD}" value="${FORK_SIZE_CONSENT_PROCEED}"`,
    );
  });

  it('預かり直す差分プロンプトを HTML として書き出さない', async () => {
    // 作者が書いた任意の文字列であり、8.3 の検査は**生成物**しか見ていない。
    const author = await createUser('fork-warn-escape-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-escape-forker');
    const spy = startSpy();

    const page = await (
      await postFork(forker, parentId, '"><script>alert(1)</script>', spy.pipeline)
    ).text();

    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('同意を持って戻ってきたら、そのままフォークが始まる', async () => {
    const author = await createUser('fork-warn-ok-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-ok-forker');
    const spy = startSpy();

    const response = await postFork(
      forker,
      parentId,
      '敵を増やす',
      spy.pipeline,
      FORK_SIZE_CONSENT_PROCEED,
    );

    expect(response.status).toBe(303);
    expect(spy.calls).toHaveLength(1);
    // **切り詰めずに丸ごと載る。** 警告は大きさを伝えるだけで、渡すものを変えない。
    expect(spy.calls[0]!.request.baseSource).toBe(NEAR_LIMIT_SOURCE);
  });

  it('知らない綴りの同意は同意として扱わない', async () => {
    // 「送りさえすれば飛ばせる関門」にしない。
    const author = await createUser('fork-warn-bogus-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-bogus-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline, 'yes');

    expect(response.status).toBe(409);
    expect(spy.calls).toHaveLength(0);
  });

  it('24KB ちょうどの親は警告しない（境界は「超えたら」）', async () => {
    const author = await createUser('fork-warn-exact-author');
    const parentId = await createPublishedGame(author, 'x'.repeat(SOURCE_SIZE_WARNING_BYTES));
    const forker = await createUser('fork-warn-exact-forker');
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(303);
    expect(spy.calls).toHaveLength(1);
  });

  it('事前警告への同意では、30KB 超の整理は始まらない（条件 2）', async () => {
    // 条件 1 の画面で押した「このまま改造する」を整理への同意として読むと、
    // **作者が押していない操作で枠が減り、ソースが書き換わる。**
    const author = await createUser('fork-warn-over-author');
    const parentId = await createPublishedGame(author, 'x'.repeat(MAX_SOURCE_BYTES + 1));
    const forker = await createUser('fork-warn-over-forker');
    const spy = startSpy();

    const response = await postFork(
      forker,
      parentId,
      '敵を増やす',
      spy.pipeline,
      FORK_SIZE_CONSENT_PROCEED,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('整理して続けますか');
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('枠切れは警告より先に出る（断られる要求のために R2 を引かない）', async () => {
    const author = await createUser('fork-warn-quota-author');
    const parentId = await createPublishedGame(author, NEAR_LIMIT_SOURCE);
    const forker = await createUser('fork-warn-quota-forker');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at)
         values (?, null, ?, 'x', 'sonnet-4-6', 1, 1, 0, 0, 1.0, 1, ?)`,
      )
        .bind(`gen-fork-warn-quota-${i}`, forker, now)
        .run();
    }
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(QUOTA_EXCEEDED_STATUS);
    expect(await response.text()).not.toContain('この作品はすでに大きめです');
  });
});

/** 上限を 1 バイト超えた親ソース（整理パスの入口。確定18 の条件 2）。 */
const OVER_LIMIT_SOURCE = 'x'.repeat(MAX_SOURCE_BYTES + 1);

/**
 * 作品行の整理の印を読む（`migrations/0014_source_tidy.sql`）。
 *
 * @param gameId 作品 id
 * @returns 記録された時刻、または null
 */
async function tidyRequestedAt(gameId: string): Promise<number | null> {
  const row = await env.DB.prepare('select tidy_requested_at from games where id = ?')
    .bind(gameId)
    .first<{ tidy_requested_at: number | null }>();
  return row!.tidy_requested_at;
}

describe('整理してから改造する（確定18 の条件 2 / M5-2 / #33）', () => {
  it('整理を選んで初めて、上限超の親から改造が始まる', async () => {
    const author = await createUser('fork-tidy-author');
    const parentId = await createPublishedGame(author, OVER_LIMIT_SOURCE);
    const forker = await createUser('fork-tidy-forker');
    const spy = startSpy();

    const response = await postFork(
      forker,
      parentId,
      '敵を増やす',
      spy.pipeline,
      FORK_SIZE_CONSENT_TIDY,
    );

    expect(response.status).toBe(303);
    expect(spy.calls).toHaveLength(1);
    // **切り詰めずに丸ごと載る**（5.3「黙って切り詰めない」）。切れた Go を渡すと
    // コンパイルが必ず落ちて枠だけが消える。
    expect(spy.calls[0]!.request.baseSource).toBe(OVER_LIMIT_SOURCE);
    expect(spy.calls[0]!.request.prompt).toBe('敵を増やす');
  });

  it('整理を選んだことを作品行へ残す（5.3「整理したことは作者に開示する」）', async () => {
    // **通した瞬間にしか観測できない事実である**（`migrations/0014_source_tidy.sql`）。
    // 完成後のソースを見ても分からず、台帳にも残らない。
    const author = await createUser('fork-tidy-mark-author');
    const parentId = await createPublishedGame(author, OVER_LIMIT_SOURCE);
    const forker = await createUser('fork-tidy-mark-forker');
    const spy = startSpy();

    await postFork(forker, parentId, '敵を増やす', spy.pipeline, FORK_SIZE_CONSENT_TIDY);

    const childId = spy.calls[0]!.gameId;
    expect(await tidyRequestedAt(childId)).toBeGreaterThan(0);
  });

  it('整理でないフォークには印を付けない', async () => {
    // 付けると、5.3 の開示が**整理していない作品にも出る。**
    const author = await createUser('fork-tidy-unmarked-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-tidy-unmarked-forker');
    const spy = startSpy();

    await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(await tidyRequestedAt(spy.calls[0]!.gameId)).toBeNull();
  });

  it('問いの画面が、費用と「別物になりうること」を先に言う', async () => {
    const author = await createUser('fork-tidy-page-author');
    const parentId = await createPublishedGame(author, OVER_LIMIT_SOURCE);
    const forker = await createUser('fork-tidy-page-forker');
    const spy = startSpy();

    const page = await (await postFork(forker, parentId, '敵を増やす', spy.pipeline)).text();

    // 条件 2 の文言そのもの。**押す前に何を失うかが見えていなければ、明示的に
    // 選んだことにならない。**
    expect(page).toContain('整理して続けますか（生成枠を 1 回使います）');
    expect(page).toContain('元と細かい部分が変わることがあります');
    // 入力を預かり直し、整理の同意として送り返す。
    expect(page).toContain(`name="${FORK_PROMPT_FIELD}" value="敵を増やす"`);
    expect(page).toContain(`name="${FORK_SIZE_CONSENT_FIELD}" value="${FORK_SIZE_CONSENT_TIDY}"`);
  });

  it('整理しても収まる見込みが無い大きさは、問わずに断る', async () => {
    // 問うだけ問って必ず失敗する選択肢は、条件 2 が守ろうとした「知らないうちに枠を
    // 使わせない」を、知ったうえで確実に捨てさせる形へ裏返す。
    const author = await createUser('fork-tidy-huge-author');
    const parentId = await createPublishedGame(author, 'x'.repeat(TIDY_MAX_SOURCE_BYTES + 1));
    const forker = await createUser('fork-tidy-huge-forker');
    const spy = startSpy();

    const response = await postFork(
      forker,
      parentId,
      '敵を増やす',
      spy.pipeline,
      FORK_SIZE_CONSENT_TIDY,
    );

    expect(response.status).toBe(409);
    const page = await response.text();
    expect(page).toContain('大きさを超えています');
    expect(page).not.toContain('整理して続けますか');
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });

  it('JSON で叩く相手には、整理を知らなくても断りとして読める形で返す', async () => {
    const author = await createUser('fork-tidy-json-author');
    const parentId = await createPublishedGame(author, OVER_LIMIT_SOURCE);
    const forker = await createUser('fork-tidy-json-forker');
    const spy = startSpy();

    const headers = await sessionHeaders(forker, {
      'content-type': 'application/json',
      accept: 'application/json',
    });
    const response = await dispatch(
      createForkRoutes(spy.pipeline),
      new Request(`${APP_ORIGIN}${FORK_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ [FORK_PARENT_ID_FIELD]: parentId, [FORK_PROMPT_FIELD]: '敵' }),
      }),
      testEnv(),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    // **`error` は変えない。** 整理を知らない相手が「始まった」と読む形にしない。
    expect(body['error']).toBe('source-too-large');
    expect(body['tidyConsent']).toBe(FORK_SIZE_CONSENT_TIDY);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('0014 の列（`migrations/0014_source_tidy.sql`）', () => {
  it('games に tidy_requested_at があり、既存行は null である', async () => {
    // #202 / #203 の形を確かめる——**実装より前に完成した行は、その実装の経路を
    // 1 度も通っていない。** この列では NULL がまさに「通っていない」を意味するので、
    // 埋め戻す UPDATE は要らない。**要らないことを、要らないと確かめておく。**
    const author = await createUser('fork-schema-author');
    const existing = await createPublishedGame(author);
    expect(await tidyRequestedAt(existing)).toBeNull();

    const columns = await env.DB.prepare("pragma table_info('games')").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toContain('tidy_requested_at');
  });
});

describe('日次クォータ（確定25 / 4.3）', () => {
  it('枠を使い切っていたら、親を引く前に断る', async () => {
    const author = await createUser('fork-quota-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-quota-forker');
    // 確定25 の日次枠は `generations` の行数で数える。当日ぶんを埋める。
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < DAILY_QUOTA_PER_USER; i += 1) {
      await env.DB.prepare(
        `insert into generations
           (id, game_id, user_id, prompt, model, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens, cost_jpy, succeeded, created_at)
         values (?, null, ?, 'x', 'sonnet-4-6', 1, 1, 0, 0, 1.0, 1, ?)`,
      )
        .bind(`gen-fork-quota-${i}`, forker, now)
        .run();
    }
    const spy = startSpy();

    const response = await postFork(forker, parentId, '敵を増やす', spy.pipeline);

    expect(response.status).toBe(QUOTA_EXCEEDED_STATUS);
    expect(spy.calls).toHaveLength(0);
    expect(await gamesOf(forker)).toHaveLength(0);
  });
});

/**
 * 4.5 のキャッシュを模した Bedrock。**実 HTTP を出さない。**
 *
 * 4.5 が言っているのは「**ブレークポイントより前が前回と同じなら読み出しになる**」
 * ことである。ここではそれをそのまま実装する——`system` と、`messages[0].content` の
 * **最初の `cachePoint` まで**を鍵にし、2 度目以降を `cacheReadInputTokens` > 0 で返す。
 *
 * **ヒットの条件を緩めない。** 前置きに揮発値（作品 id・ジョブトークン・時刻）が
 * 1 文字でも混ざれば鍵が変わり、この模型は 0 を返す。4.5 の
 * 「`cacheReadInputTokens` がゼロのまま推移する場合、プレフィックスに揮発値が
 * 混入している」を、検査として裏返した形である。
 *
 * @returns 送られた本文の記録と、差し替える `fetch`
 */
function cachingBedrock(): {
  bodies: Record<string, unknown>[];
  fetch: (request: Request) => Promise<Response>;
} {
  const bodies: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  return {
    bodies,
    fetch: async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);

      const messages = body['messages'] as { content: Record<string, unknown>[] }[];
      const content = messages[0]!.content;
      const breakpoint = content.findIndex((block) => 'cachePoint' in block);
      const prefix = JSON.stringify([
        body['system'],
        breakpoint === -1 ? null : content.slice(0, breakpoint),
      ]);
      // 区切りが無い本文（新規生成）は共有プレフィックスを持たない。
      const hit = breakpoint !== -1 && seen.has(prefix);
      if (breakpoint !== -1) {
        seen.add(prefix);
      }

      return Response.json({
        output: { message: { role: 'assistant', content: [{ text: 'package main\n' }] } },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1_092,
          outputTokens: 4_171,
          cacheReadInputTokens: hit ? 4_841 : 0,
          cacheWriteInputTokens: hit ? 0 : 4_841,
          totalTokens: 5_263,
        },
      });
    },
  };
}

/** システムプロンプトの代わり。**動的値を 1 つも持たない**（4.5）。 */
const stubSystemPrompt = (): readonly SystemBlock[] => [
  { text: 'あなたは Ebitengine のゲームを書く。' },
  { cachePoint: true },
];

/** Bedrock の資格情報を入れた env。**実在の鍵ではない**（`test/bedrock.test.ts` と同じ）。 */
function bedrockEnv(): Env {
  return {
    ...env,
    BEDROCK_AWS_REGION: 'ap-northeast-1',
    BEDROCK_AWS_ACCESS_KEY_ID: 'test-access-key-id',
    BEDROCK_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    BEDROCK_AWS_SESSION_TOKEN: '',
    GENERATION_MODEL: 'sonnet-4-6',
  } as unknown as Env;
}

describe('親ソースは messages の先頭に載り、2 回目はキャッシュから読まれる（acceptance 2 / 4.5）', () => {
  it('同じ親を続けて改造すると、2 回目の cacheReadInputTokens が 0 より大きい', async () => {
    const author = await createUser('fork-cache-author');
    const parentId = await createPublishedGame(author);
    const forker = await createUser('fork-cache-forker');
    const spy = startSpy();

    // **差分プロンプトは毎回違う。** 同じ文言で 2 回叩くと、キャッシュではなく
    // 「本文がまるごと同じ」ことを見てしまう。
    await postFork(forker, parentId, '敵を 2 体にする', spy.pipeline);
    await postFork(forker, parentId, '玉を速くする', spy.pipeline);
    expect(spy.calls).toHaveLength(2);

    const bedrock = cachingBedrock();
    const generate = createBedrockGenerateSource({
      systemPrompt: stubSystemPrompt,
      fetch: bedrock.fetch,
    });

    const usages = [];
    for (const job of spy.calls) {
      // **オーケストレータへ渡る形をそのまま通す。** 版 2 でなければ受け側は断り
      // （`src/orchestrator/payload.ts`）、`baseSource` はそこで落ちる。
      const payload = parseOrchestratorPayload(buildOrchestratorPayload(job, 'sonnet-4-6'));
      expect(payload?.version).toBe(ORCHESTRATOR_PAYLOAD_VERSION_WITH_BASE_SOURCE);
      expect(payload?.baseSource).toBe(PARENT_SOURCE);

      const result = await generate(bedrockEnv(), {
        prompt: payload!.prompt,
        baseSource: payload!.baseSource!,
      });
      usages.push(result.usage);
    }

    // **1 つ目のブロックが親ソースである**（4.5「親ソースは `messages` の先頭ブロックに
    // 置き、別ブレークポイントを打つ」）。
    const first = bedrock.bodies[0]!['messages'] as { content: Record<string, unknown>[] }[];
    const content = first[0]!.content;
    expect(content[0]!['text']).toContain(PARENT_SOURCE);
    expect(content[1]).toEqual({ cachePoint: { type: 'default' } });
    // 差分プロンプトは区切りのうしろにある（毎回変わってもキャッシュを割らない）。
    expect(content[2]!['text']).toBe('敵を 2 体にする');

    // **これが acceptance 2 である。**
    expect(usages[0]!.cacheReadInputTokens).toBe(0);
    expect(usages[1]!.cacheReadInputTokens).toBeGreaterThan(0);
  });

  it('別の親なら 2 回目でもキャッシュから読まれない（模型が何でも当てていないこと）', async () => {
    const author = await createUser('fork-cache2-author');
    const parentA = await createPublishedGame(author, PARENT_SOURCE);
    const parentB = await createPublishedGame(author, `${PARENT_SOURCE}// 別の作品\n`);
    const forker = await createUser('fork-cache2-forker');
    const spy = startSpy();

    await postFork(forker, parentA, '敵を 2 体にする', spy.pipeline);
    await postFork(forker, parentB, '敵を 2 体にする', spy.pipeline);

    const bedrock = cachingBedrock();
    const generate = createBedrockGenerateSource({
      systemPrompt: stubSystemPrompt,
      fetch: bedrock.fetch,
    });

    const usages = [];
    for (const job of spy.calls) {
      const result = await generate(bedrockEnv(), {
        prompt: job.request.prompt,
        baseSource: job.request.baseSource!,
      });
      usages.push(result.usage);
    }

    expect(usages[0]!.cacheReadInputTokens).toBe(0);
    expect(usages[1]!.cacheReadInputTokens).toBe(0);
  });
});
