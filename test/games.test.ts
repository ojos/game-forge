import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BuildOutcome } from '../src/build-client.js';
import type { BuildCacheEntry } from '../src/build-cache.js';
import { deleteUnreferencedArtifacts, readBuildCache, recordBuildCache } from '../src/build-cache.js';
import { defaultPipeline } from '../src/generate.js';
import {
  DRAFT_STATUS,
  GENERATION_ERROR_CODES,
  MAX_TITLE_LENGTH,
  PREVIEW_KEY_BYTES,
  UNTITLED_TITLE,
  claimGenerationJob,
  completeGame,
  countPublishedForks,
  createForkedGame,
  createPendingGame,
  UNBUILT_GO_VERSION,
  createPreviewKey,
  draftTitleFromPrompt,
  failGame,
  hashJobToken,
  listAuthoredGames,
  listPublishedForks,
  publishGame,
} from '../src/games.js';
import type { GenerateRequest } from '../src/generate.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

/**
 * 作品行を 1 件、完成した状態まで進める。
 *
 * **#150 で 1 回の `insert` が 3 段に割れた**（作成 → 握る → 完成）。この一群の
 * テストが見ているのは「完成した行と索引がどうなっているか」であって、その 3 段の
 * 刻み方ではない。**刻み方そのものを見るテストは下に別に置いてある**ので、ここは
 * 3 段をまとめた 1 つの呼び出しへ畳む。
 *
 * @param target 書き込み先（R2 の呼び出しを覗くために差し替えることがある）
 * @param userId 作者
 * @param request 生成リクエスト
 * @param built ビルドの結果
 * @param now 記録時刻（UNIX 秒）
 * @returns 作った作品の id
 */
async function createDraftGame(
  target: Env,
  userId: string,
  request: GenerateRequest,
  built: BuildOutcome,
  now?: number,
): Promise<{ readonly id: string }> {
  const pending = await createPendingGame(target, userId, request, now);
  await claimGenerationJob(target, pending.id, await hashJobToken(pending.jobToken), now);
  await completeGame(target, pending.id, built, now);
  return { id: pending.id };
}

/** D1 から読んだ `games` の行（列名は SQL の綴りそのもの）。 */
interface GameRow {
  id: string;
  author_id: string;
  parent_id: string | null;
  status: string;
  title: string;
  go_version: string;
  source_key: string | null;
  wasm_key: string | null;
  fork_count: number;
  created_at: number;
  published_at: number | null;
  preview_key: string | null;
}

/**
 * 利用者を 1 人用意する。
 *
 * `games.author_id` は `users` への外部キーなので、行を作るには要る。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `games-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix)
    .run();
  return id;
}

/**
 * `games` の行を読む。
 *
 * @param id 作品 id
 * @returns 行
 */
async function readGame(id: string): Promise<GameRow> {
  const row = await env.DB.prepare('select * from games where id = ?').bind(id).first<GameRow>();
  if (row === null) {
    throw new Error(`games 行がありません: ${id}`);
  }
  return row;
}

/**
 * 行から「行ごとに必ず異なる列」を除く（残りを「すべて一致」で比べるため）。
 *
 * 除くのは `id` と `preview_key` の 2 つ。**どちらも一致してはいけない値**である
 * （`preview_key` が一致したら、別の作品のプレビュー URL が引けることになる。#28）。
 * 一致しないことは下の別のテストで見る。
 *
 * @param row `games` の行
 * @returns 2 列を除いた行
 */
function withoutIdentity(row: GameRow): Omit<GameRow, 'id' | 'preview_key'> {
  const copy: Partial<GameRow> = { ...row };
  delete copy.id;
  delete copy.preview_key;
  return copy as Omit<GameRow, 'id' | 'preview_key'>;
}

/**
 * キャッシュヒットのビルド結果を作る。
 *
 * @param entry 索引の行
 * @returns ヒットしたときのビルド結果
 */
function cachedOutcome(entry: BuildCacheEntry): BuildOutcome {
  return {
    cached: true,
    sourceSha256: entry.sourceSha256,
    goVersion: entry.goVersion,
    artifact: {
      wasm: { bytes: entry.wasmBytes, sha256: entry.wasmSha256 },
      compressed: {
        bytes: entry.compressedBytes,
        sha256: entry.compressedSha256,
        contentEncoding: entry.contentEncoding,
      },
    },
    entry,
  };
}

describe('draft の作品行を作る（3.3-8 / 5.1 / issue acceptance 2）', () => {
  it('status=draft と go_version / source_key / wasm_key が入る', async () => {
    const userId = await seedUser('draft');
    const built = fakeBuildOutcome();

    const game = await createDraftGame(env, userId, { prompt: '弾幕シューティング' }, built, 1_700_000_000);
    const row = await readGame(game.id);

    expect(row.status).toBe(DRAFT_STATUS);
    expect(row.status).toBe('draft');
    expect(row.author_id).toBe(userId);
    expect(row.go_version).toBe('go1.26.5');
    expect(row.source_key).toBe(built.keys.sourceKey);
    expect(row.wasm_key).toBe(built.keys.wasmKey);
    expect(row.created_at).toBe(1_700_000_000);
    // 5.4: 公開はこの経路では起きない。
    expect(row.published_at).toBeNull();
    // 新規生成はフォークではない（5.3 の系統はここでは作らない）。
    expect(row.parent_id).toBeNull();
    expect(row.fork_count).toBe(0);
  });

  it('作品 id は呼び出しごとに違う', async () => {
    const userId = await seedUser('unique');
    const first = await createDraftGame(env, userId, { prompt: 'ゲーム' }, fakeBuildOutcome());
    const second = await createDraftGame(env, userId, { prompt: 'ゲーム' }, fakeBuildOutcome());
    expect(first.id).not.toBe(second.id);
  });

  it('ヒット時も非ヒット時も同じ形の行になる（issue acceptance 3）', async () => {
    const userId = await seedUser('same-shape');
    const missed = fakeBuildOutcome();
    const entry: BuildCacheEntry = {
      sourceSha256: missed.sourceSha256,
      goVersion: missed.goVersion,
      sourceKey: missed.keys.sourceKey,
      wasmKey: missed.keys.wasmKey,
      wasmBytes: missed.artifact.wasm.bytes,
      wasmSha256: missed.artifact.wasm.sha256,
      compressedBytes: missed.artifact.compressed.bytes,
      compressedSha256: missed.artifact.compressed.sha256,
      contentEncoding: 'br',
      createdAt: 1_600_000_000,
    };

    const fromMiss = await readGame(
      (await createDraftGame(env, userId, { prompt: '同じ題' }, missed, 1_700_000_100)).id,
    );
    const fromHit = await readGame(
      (await createDraftGame(env, userId, { prompt: '同じ題' }, cachedOutcome(entry), 1_700_000_100)).id,
    );

    // 行ごとに必ず異なる 2 列（id / preview_key）以外のすべてが一致する。
    // **片方だけキーが欠ける、といった差を作らない。**
    expect(withoutIdentity(fromHit)).toEqual(withoutIdentity(fromMiss));
    // 同じソース（確定26 で R2 のキーは共有される）でも、プレビュー URL は別である。
    expect(fromHit.preview_key).not.toBe(fromMiss.preview_key);
  });
});

describe('作者プレビュー用のキー（5.4 / #28）', () => {
  it('16 進 32 桁（128 ビット）で出る', () => {
    // 配信側（src/sandbox-delivery.ts の PREVIEW_KEY_PATTERN）が受け付ける綴りと
    // **対になっている。** ここが崩れると、作った行のプレビュー URL が 404 になる。
    // 期待する桁数は定数から出す（数字を書き写すと、定数を変えたときに追随漏れる）。
    const key = createPreviewKey();
    expect(key).toMatch(/^[0-9a-f]+$/u);
    expect(key.length).toBe(PREVIEW_KEY_BYTES * 2);
  });

  it('呼び出しごとに違う', () => {
    // 128 ビットの乱数なので衝突しない。定数を返す実装への退化を落とすための検査。
    const keys = new Set(Array.from({ length: 64 }, () => createPreviewKey()));
    expect(keys.size).toBe(64);
  });

  it('作品行に必ず入る', async () => {
    const userId = await seedUser('preview-key');
    const game = await createDraftGame(env, userId, { prompt: 'ゲーム' }, fakeBuildOutcome());
    const row = await readGame(game.id);
    expect(row.preview_key).not.toBeNull();
    expect(row.preview_key).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('games.preview_key が一意である', async () => {
    // 衝突すれば別人の未公開作品が引ける。鍵の長さだけに預けず、索引でも押さえる
    // （migrations/0006_games_preview_key.sql）。
    const userId = await seedUser('preview-unique');
    await env.DB.prepare(
      'insert into games (id, author_id, status, title, go_version, created_at, preview_key) values (?, ?, ?, ?, ?, 1, ?)',
    )
      .bind('g-preview-1', userId, 'draft', 'T', 'go1.26.5', 'a'.repeat(32))
      .run();
    await expect(
      env.DB.prepare(
        'insert into games (id, author_id, status, title, go_version, created_at, preview_key) values (?, ?, ?, ?, ?, 1, ?)',
      )
        .bind('g-preview-2', userId, 'draft', 'T', 'go1.26.5', 'a'.repeat(32))
        .run(),
    ).rejects.toThrow();
  });

  it('preview_key が NULL の行は複数あってよい', async () => {
    // 0006 は既存行を埋め戻さない。SQLite の UNIQUE 索引が NULL を重複と見なさない
    // ことに依存しているので、依存していること自体を検査に残す。
    const userId = await seedUser('preview-null');
    for (const id of ['g-preview-null-1', 'g-preview-null-2']) {
      await env.DB.prepare(
        'insert into games (id, author_id, status, title, go_version, created_at) values (?, ?, ?, ?, ?, 1)',
      )
        .bind(id, userId, 'draft', 'T', 'go1.26.5')
        .run();
    }
    const row = await env.DB.prepare('select preview_key from games where id = ?')
      .bind('g-preview-null-1')
      .first<{ preview_key: string | null }>();
    expect(row?.preview_key).toBeNull();
  });
});

describe('ビルド結果キャッシュの索引（3.8 / issue の範囲 2）', () => {
  it('非ヒットなら索引を記録する（成果物は R2 に入ったあと）', async () => {
    const userId = await seedUser('record');
    const built = fakeBuildOutcome({ sourceSha256: '1'.repeat(64) });

    await createDraftGame(env, userId, { prompt: 'ゲーム' }, built, 1_700_000_200);

    const row = await env.DB.prepare('select * from build_cache where source_sha256 = ?')
      .bind('1'.repeat(64))
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row!['source_key']).toBe(built.keys.sourceKey);
    expect(row!['wasm_key']).toBe(built.keys.wasmKey);
    expect(row!['go_version']).toBe('go1.26.5');
    expect(row!['content_encoding']).toBe('br');
    expect(row!['created_at']).toBe(1_700_000_200);
  });

  it('ヒット時は索引を書き直さない（created_at を若返らせない）', async () => {
    const userId = await seedUser('no-rewrite');
    const entry: BuildCacheEntry = {
      sourceSha256: '2'.repeat(64),
      goVersion: 'go1.26.5',
      sourceKey: 'builds/hit/source.go',
      wasmKey: 'builds/hit/go1.26.5/game.wasm.br',
      wasmBytes: 10,
      wasmSha256: 'a'.repeat(64),
      compressedBytes: 5,
      compressedSha256: 'b'.repeat(64),
      contentEncoding: 'br',
      createdAt: 1_600_000_000,
    };
    await recordBuildCache(env, entry, entry.createdAt);

    await createDraftGame(env, userId, { prompt: 'ゲーム' }, cachedOutcome(entry), 1_700_000_300);

    const row = await env.DB.prepare('select created_at from build_cache where source_sha256 = ?')
      .bind(entry.sourceSha256)
      .first<{ created_at: number }>();
    expect(row?.created_at).toBe(1_600_000_000);
  });

  it('索引より先に games 行がある（確定26 の削除規約と噛み合う順序）', async () => {
    // **順序を入れ替えると、掃除が「参照ゼロ」と数えた直後に行だけができる。**
    // 索引を書く時点で `games` を引いて、自分の行が既にあることを確かめる。
    const userId = await seedUser('order');
    const sourceSha256 = '3'.repeat(64);
    // **このテスト専用のキーにする。** 既定のキーは他のテストが作った行と重なるため、
    // 「数えたら 1 件あった」が自分の行のことだと言えなくなる。
    const built = fakeBuildOutcome({
      sourceSha256,
      keys: {
        sourceKey: `builds/${sourceSha256}/source.go`,
        wasmKey: `builds/${sourceSha256}/go1.26.5/game.wasm.br`,
      },
    });

    // 索引を書く文が用意された**その時点で** `games` を数える。3.3-8 は 2 つの書き込みを
    // 直列に待つので、ここで 1 件見えていれば「行が先」である。
    let gamesWhenIndexed: Promise<{ n: number } | null> | null = null;
    const spy = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (sql.includes('insert or replace into build_cache') && gamesWhenIndexed === null) {
            gamesWhenIndexed = env.DB.prepare('select count(*) as n from games where wasm_key = ?')
              .bind(built.keys.wasmKey)
              .first<{ n: number }>();
          }
          return env.DB.prepare(sql);
        },
      } as unknown as D1Database,
    } as Env;

    await createDraftGame(spy, userId, { prompt: 'ゲーム' }, built);
    expect(gamesWhenIndexed).not.toBeNull();
    expect((await gamesWhenIndexed!)?.n).toBeGreaterThan(0);
  });
});

describe('R2 のオブジェクトは作品をまたいで共有される（確定26 / #116）', () => {
  it('同じソースの 2 作品が同じキーを指す', async () => {
    const author = await seedUser('shared-a');
    const forker = await seedUser('shared-b');
    const built = fakeBuildOutcome({ sourceSha256: '4'.repeat(64) });
    // ヒット判定は R2 の実在確認を含む（3.8 / `src/build-cache.ts`）。
    await env.BUCKET.put(built.keys.sourceKey, 'package main');
    await env.BUCKET.put(built.keys.wasmKey, 'brotli');

    const first = await createDraftGame(env, author, { prompt: '元の作品' }, built);
    // 2 件目は**キャッシュヒット**で来る（同じソースなので関数を呼ばない）。
    const lookup = await readBuildCacheOrThrow('4'.repeat(64));
    const second = await createDraftGame(env, forker, { prompt: '改造した作品' }, cachedOutcome(lookup));

    const firstRow = await readGame(first.id);
    const secondRow = await readGame(second.id);
    expect(secondRow.wasm_key).toBe(firstRow.wasm_key);
    expect(secondRow.source_key).toBe(firstRow.source_key);
    expect(second.id).not.toBe(first.id);
  });

  it('片方を消しても、もう片方が指す成果物は残る（削除側の規約を壊していない）', async () => {
    const author = await seedUser('retain-a');
    const forker = await seedUser('retain-b');
    const sourceSha256 = '5'.repeat(64);
    const built = fakeBuildOutcome({
      sourceSha256,
      keys: {
        sourceKey: `builds/${sourceSha256}/source.go`,
        wasmKey: `builds/${sourceSha256}/go1.26.5/game.wasm.br`,
      },
    });
    const keys = built.keys;

    // R2 に実体を置く（`deleteUnreferencedArtifacts` は R2 を触る）。
    await env.BUCKET.put(keys.sourceKey, 'package main');
    await env.BUCKET.put(keys.wasmKey, 'brotli');

    const first = await createDraftGame(env, author, { prompt: '元の作品' }, built);
    const second = await createDraftGame(
      env,
      forker,
      { prompt: '改造した作品' },
      cachedOutcome(await readBuildCacheOrThrow(sourceSha256)),
    );

    // 1 件目を消そうとする。**2 件目が参照しているので消えない。**
    const plan = await deleteUnreferencedArtifacts(env, first.id);
    expect(plan.deletable).toEqual([]);
    expect(plan.retained.map((item) => item.key).sort()).toEqual(
      [keys.sourceKey, keys.wasmKey].sort(),
    );
    expect(await env.BUCKET.head(keys.wasmKey)).not.toBeNull();

    // 2 件目の作品はそのまま成果物を指し続ける。
    const row = await readGame(second.id);
    expect(row.wasm_key).toBe(keys.wasmKey);
  });
});

describe('仮のタイトル（5.1 の NOT NULL を満たす）', () => {
  it('プロンプトの 1 行目を使う', () => {
    expect(draftTitleFromPrompt('横スクロールのアクション\n主人公は猫')).toBe(
      '横スクロールのアクション',
    );
  });

  it('前後の空白を落とす', () => {
    expect(draftTitleFromPrompt('  パズル  ')).toBe('パズル');
  });

  it('長すぎるプロンプトは切り詰める', () => {
    const title = draftTitleFromPrompt('あ'.repeat(MAX_TITLE_LENGTH * 3));
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('絵文字を半分に割らない', () => {
    const title = draftTitleFromPrompt('🎮'.repeat(MAX_TITLE_LENGTH * 2));
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
    expect(title).not.toContain('�');
    // 壊れたサロゲートが残っていないこと（正規化して同じ長さに戻る）。
    expect([...title].every((char) => char === '🎮')).toBe(true);
  });

  it('制御文字を持ち込まない', () => {
    expect(draftTitleFromPrompt('横\u0001スクロール')).toBe('横 スクロール');
  });

  it('空になるプロンプトでも空文字にしない（NOT NULL の列）', () => {
    expect(draftTitleFromPrompt('\n\n')).toBe(UNTITLED_TITLE);
    expect(draftTitleFromPrompt('   ')).toBe(UNTITLED_TITLE);
  });

  it('作品行のタイトルとして入る', async () => {
    const userId = await seedUser('title');
    const game = await createDraftGame(env, userId, { prompt: '猫が主人公のパズル' }, fakeBuildOutcome());
    expect((await readGame(game.id)).title).toBe('猫が主人公のパズル');
  });
});

describe('既定のパイプラインへ結線されている（3.3-8）', () => {
  it('completeGame が completeGame である', () => {
    // **同一性で見る**（`test/quota.test.ts` と同じ形）。外すと、成果物は R2 に入り
    // 費用も計上されたのに作品が `running` のまま残る状態へ戻る。
    expect(defaultPipeline.completeGame).toBe(completeGame);
  });
});

/**
 * 索引を引き、ヒットしなければ失敗させる。
 *
 * @param sourceSha256 生成ソースのコンテンツハッシュ
 * @returns 索引の行
 */
async function readBuildCacheOrThrow(sourceSha256: string): Promise<BuildCacheEntry> {
  const lookup = await readBuildCache(env, sourceSha256);
  if (!lookup.hit) {
    throw new Error(`索引がヒットしません: ${lookup.reason}`);
  }
  return lookup.entry;
}

describe('生成の身元を先に作る（#150 / 3.3-2.5）', () => {
  /**
   * `games` の 1 行を、生成状態の列まで含めて読む。
   *
   * @param id 作品 id
   * @returns 行
   */
  async function readLifecycle(id: string): Promise<{
    status: string;
    go_version: string;
    source_key: string | null;
    wasm_key: string | null;
    preview_key: string | null;
    generation_state: string;
    generation_error: string | null;
    job_token_hash: string | null;
    generation_started_at: number | null;
  }> {
    const row = await env.DB.prepare(
      `select status, go_version, source_key, wasm_key, preview_key,
              generation_state, generation_error, job_token_hash, generation_started_at
         from games where id = ?`,
    )
      .bind(id)
      .first<{
        status: string;
        go_version: string;
        source_key: string | null;
        wasm_key: string | null;
        preview_key: string | null;
        generation_state: string;
        generation_error: string | null;
        job_token_hash: string | null;
        generation_started_at: number | null;
      }>();
    if (row === null) {
      throw new Error(`行がありません: ${id}`);
    }
    return row;
  }

  it('LLM を呼ぶ前に行が作られ、id が決まる', async () => {
    const userId = await seedUser('pending');
    const pending = await createPendingGame(env, userId, { prompt: '迷路ゲーム' });

    expect(pending.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    const row = await readLifecycle(pending.id);
    // 5.4: 生成中も **`status` は `draft`** である（CHECK を作り直していない）。
    expect(row.status).toBe(DRAFT_STATUS);
    expect(row.generation_state).toBe('pending');
    // 成果物はまだ 1 つも無い。
    expect(row.source_key).toBeNull();
    expect(row.wasm_key).toBeNull();
    expect(row.go_version).toBe(UNBUILT_GO_VERSION);
  });

  it('生成中の行は preview_key を持たない（配信側の 500 へ化けさせないため）', async () => {
    // **これが #150 の「生成中の行が配信側の 500 に化ける」問題への答えである。**
    // `src/sandbox-delivery.ts` の `/p/` は `where preview_key = ?` で引くので、
    // キーが無い行はあの経路から**原理的に引けない**。
    const userId = await seedUser('nopreview');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    expect((await readLifecycle(pending.id)).preview_key).toBeNull();
  });

  it('ジョブトークンは平文で保存されない', async () => {
    const userId = await seedUser('token');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const row = await readLifecycle(pending.id);

    expect(pending.jobToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.job_token_hash).not.toBe(pending.jobToken);
    expect(row.job_token_hash).toBe(await hashJobToken(pending.jobToken));
  });

  it('ジョブを握れるのは 1 回だけである（重複実行が LLM を 2 回呼ばない）', async () => {
    // **設定ではなくデータで担保する層である。** AWS Lambda の非同期呼び出しは
    // 「関数がエラーを返さなくても同じイベントを複数回配信しうる」ので、
    // `MaximumRetryAttempts=0` だけでは重複が止まらない。
    const userId = await seedUser('claim-once');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    const hash = await hashJobToken(pending.jobToken);

    expect(await claimGenerationJob(env, pending.id, hash, 1_700_000_000)).toBe(true);
    // 2 通目。**ここが false でなければ、16 円がもう一度出て日次枠も 1 つ減る。**
    expect(await claimGenerationJob(env, pending.id, hash)).toBe(false);

    const row = await readLifecycle(pending.id);
    expect(row.generation_state).toBe('running');
    expect(row.generation_started_at).toBe(1_700_000_000);
  });

  it('トークンが違えば握れない', async () => {
    const userId = await seedUser('claim-token');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    expect(await claimGenerationJob(env, pending.id, await hashJobToken('別のトークン'))).toBe(
      false,
    );
    expect((await readLifecycle(pending.id)).generation_state).toBe('pending');
  });

  it('完成すると成果物と preview_key が同時に入り、トークンが捨てられる', async () => {
    const userId = await seedUser('complete');
    const built = fakeBuildOutcome();
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));

    expect(await completeGame(env, pending.id, built)).toBe(true);

    const row = await readLifecycle(pending.id);
    expect(row.generation_state).toBe('ready');
    expect(row.go_version).toBe(built.goVersion);
    expect(row.source_key).toBe(built.keys.sourceKey);
    expect(row.wasm_key).toBe(built.keys.wasmKey);
    // **`preview_key` はここで初めて入る。** 成果物と同時であることが要点で、
    // 先に入ると成果物の無い行が配信側から引ける。
    expect(row.preview_key).toMatch(/^[0-9a-f]{32}$/u);
    // 使い捨てである。
    expect(row.job_token_hash).toBeNull();
    // 5.4: 公開はしない。
    expect(row.status).toBe(DRAFT_STATUS);
  });

  it('握られていない行は完成させられない', async () => {
    const userId = await seedUser('complete-unclaimed');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    // `pending` のまま completeGame を呼んでも通らない。
    expect(await completeGame(env, pending.id, fakeBuildOutcome())).toBe(false);
    expect((await readLifecycle(pending.id)).preview_key).toBeNull();
  });

  it('失敗は分類名とともに記録され、行は残る（3.7 の掃除に乗せる）', async () => {
    const userId = await seedUser('failed');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));

    expect(await failGame(env, pending.id, 'build-failed')).toBe(true);

    const row = await readLifecycle(pending.id);
    expect(row.generation_state).toBe('failed');
    expect(row.generation_error).toBe('build-failed');
    expect(row.job_token_hash).toBeNull();
    // **`status` は `draft` のまま。** 失敗用の掃除の規約を作らず、3.7 の
    // 「未公開のまま 14 日で自動削除」にそのまま乗せる。
    expect(row.status).toBe(DRAFT_STATUS);
    // 成果物は無いので、配信側からは引けないままである。
    expect(row.preview_key).toBeNull();
  });

  it('時間切れは build-timeout として記録できる（#164）', async () => {
    // **`internal` へ落とさない。** あちらは「設定不足・関数障害・想定外の例外」で、
    // 運用者が最初にコードと設定を見に行くことになる。時間切れは容量の問題である。
    const userId = await seedUser('failed-timeout');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));

    expect(await failGame(env, pending.id, 'build-timeout')).toBe(true);
    expect((await readLifecycle(pending.id)).generation_error).toBe('build-timeout');
  });

  it('分類名の語彙に build-timeout が入っている（#164）', () => {
    // **`src/generate-callback.ts` はこの配列で受け口を絞る。** ここに無い値は
    // オーケストレータからのコールバックで弾かれ、行は `running` のまま残る。
    expect(GENERATION_ERROR_CODES).toContain('build-timeout');
    expect(GENERATION_ERROR_CODES).toContain('internal');
  });

  it('完了した行は失敗にできない（後から状態を壊さない）', async () => {
    const userId = await seedUser('failed-after');
    const pending = await createPendingGame(env, userId, { prompt: 'ゲーム' });
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
    await completeGame(env, pending.id, fakeBuildOutcome());

    expect(await failGame(env, pending.id, 'internal')).toBe(false);
    expect((await readLifecycle(pending.id)).generation_state).toBe('ready');
  });
});

describe('0007 のスキーマ（#150）', () => {
  it('既存の行は ready として埋め戻される', async () => {
    // **0007 が NOT NULL + DEFAULT を選んだ根拠がここである。** 旧 `createDraftGame` は
    // 3.3 の最後の段だったので、行があること自体が「成果物が揃っている」ことを
    // 意味していた。既定値 `ready` は事実として正しい。
    const userId = await seedUser('legacy');
    const id = 'legacy-game-0007';
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at)
       values (?, ?, 'draft', '旧来の行', 'go1.26.7', 1)`,
    )
      .bind(id, userId)
      .run();

    const row = await env.DB.prepare('select generation_state from games where id = ?')
      .bind(id)
      .first<{ generation_state: string }>();
    expect(row?.generation_state).toBe('ready');
  });

  it('知らない状態は CHECK が拒否する', async () => {
    const userId = await seedUser('check');
    await expect(
      env.DB.prepare(
        `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
         values ('bogus-state-0007', ?, 'draft', 'x', 'go1.26.7', 1, 'generating')`,
      )
        .bind(userId)
        .run(),
    ).rejects.toThrow();
  });
});

describe('listAuthoredGames（#152）', () => {
  /**
   * `games` の行を直接 1 件入れる。
   *
   * **生成の経路（`createPendingGame`）を通さない。** ここで確かめたいのは一覧の
   * 引き方であって、行の作られ方ではない。`status` や `created_at` を自由に置ける
   * ほうが、除外と並び順の条件を少ない行数で網羅できる。
   *
   * @param authorId 作者
   * @param overrides 列の指定
   * @returns 作った作品の id
   */
  async function seedGame(
    authorId: string,
    overrides: {
      readonly status?: string;
      readonly title?: string;
      readonly createdAt?: number;
      readonly generationState?: string;
    } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state)
       values (?, ?, ?, ?, '', ?, ?)`,
    )
      .bind(
        id,
        authorId,
        overrides.status ?? DRAFT_STATUS,
        overrides.title ?? 'タイトル',
        overrides.createdAt ?? 1000,
        overrides.generationState ?? 'ready',
      )
      .run();
    return id;
  }

  it('他人の作品を 1 行も返さない', async () => {
    // **5.4 の担保そのものである。** 公開前の作品が本人以外から辿れてはいけない以上、
    // 一覧が抜け道になっていないことを、画面ではなく**引く層**で固定する。
    const mine = await seedUser('list-mine');
    const theirs = await seedUser('list-theirs');
    const myGame = await seedGame(mine);
    const theirDraft = await seedGame(theirs, { title: '他人の下書き' });
    const theirPending = await seedGame(theirs, { generationState: 'pending' });

    const listed = await listAuthoredGames(env, mine, 50);
    const ids = listed.map((work) => work.id);
    expect(ids).toContain(myGame);
    expect(ids).not.toContain(theirDraft);
    expect(ids).not.toContain(theirPending);
    // 作者が違う行が 1 つも混ざっていないことを、id の照合だけに任せない。
    const authors = await Promise.all(
      ids.map(async (id) => (await readGame(id)).author_id),
    );
    expect(new Set(authors)).toEqual(new Set([mine]));
  });

  it('新しい順に並び、同じ秒は id の降順で決まる', async () => {
    const userId = await seedUser('list-order');
    const older = await seedGame(userId, { createdAt: 100 });
    const newer = await seedGame(userId, { createdAt: 200 });
    // `created_at` が UNIX 秒である以上、同じ秒の 2 件がありうる。並びが決まらないと
    // 「並びが変わった」と「作品が消えた」を利用者が区別できない。
    const tieA = await seedGame(userId, { createdAt: 300 });
    const tieB = await seedGame(userId, { createdAt: 300 });
    const expectedTieOrder = [tieA, tieB].sort().reverse();

    const listed = await listAuthoredGames(env, userId, 50);
    expect(listed.map((work) => work.id)).toEqual([...expectedTieOrder, newer, older]);
  });

  it('生成中の作品も返す', async () => {
    // #152 の acceptance。**91 秒待っている最中の作品こそ戻る道が要る。**
    const userId = await seedUser('list-pending');
    const pending = await seedGame(userId, { generationState: 'pending' });
    const running = await seedGame(userId, { generationState: 'running' });
    const failed = await seedGame(userId, { generationState: 'failed' });

    const listed = await listAuthoredGames(env, userId, 50);
    expect(listed.map((work) => work.id).sort()).toEqual([pending, running, failed].sort());
    expect(listed.find((work) => work.id === pending)?.generationState).toBe('pending');
  });

  it('removed は返さない', async () => {
    // 行き先の無いリンクを一覧に並べない（`/p/` も `/g/` も removed を配信しない）。
    const userId = await seedUser('list-removed');
    const kept = await seedGame(userId);
    const removed = await seedGame(userId, { status: 'removed' });

    const ids = (await listAuthoredGames(env, userId, 50)).map((work) => work.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(removed);
  });

  it('limit を超えて返さない', async () => {
    const userId = await seedUser('list-limit');
    await seedGame(userId, { createdAt: 10 });
    await seedGame(userId, { createdAt: 20 });
    await seedGame(userId, { createdAt: 30 });

    const listed = await listAuthoredGames(env, userId, 2);
    // 切るのは**古いほう**である。新しい順に並べてから切っていることを見る。
    expect(listed.map((work) => work.createdAt)).toEqual([30, 20]);
  });

  it('作品が無ければ空を返す', async () => {
    const userId = await seedUser('list-empty');
    expect(await listAuthoredGames(env, userId, 50)).toEqual([]);
  });

  it('不正な limit は問い合わせる前に落とす', async () => {
    // **SQLite は `LIMIT -1` を「無制限」と解釈する。** 負の値が通ると、上限を掛けた
    // つもりの問い合わせがその作者の**全行の読み取り**に化ける。しかも一覧は正しく
    // 見えるので、**動作では気づけない**（増えるのは読み取り行数だけ）。
    const userId = await seedUser('list-bad-limit');
    await seedGame(userId);

    for (const limit of [-1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(listAuthoredGames(env, userId, limit)).rejects.toThrow(
        /一覧の取得件数が不正です/u,
      );
    }
  });

  it('limit が 0 なら 1 行も返さない（例外にはしない）', async () => {
    // 0 は「不正」ではなく「0 件でよい」である。`LIMIT 0` は SQLite でも 0 件を返す。
    const userId = await seedUser('list-zero-limit');
    await seedGame(userId);
    expect(await listAuthoredGames(env, userId, 0)).toEqual([]);
  });
});

describe('フォークの子は親を指す（5.3 / M5-1 / #32）', () => {
  it('createForkedGame は parent_id に親を入れる', async () => {
    const author = await seedUser('fork-parent');
    const forker = await seedUser('fork-child');
    const parent = await createPendingGame(env, author, { prompt: '親のお題' });

    const child = await createForkedGame(env, forker, { prompt: '敵を増やす' }, parent.id);

    const row = await readGame(child.id);
    expect(row.parent_id).toBe(parent.id);
    // 子は改造した人のものである。
    expect(row.author_id).toBe(forker);
    // **5.4 は変わらない。** フォークの経路も `published` を作れない。
    expect(row.status).toBe(DRAFT_STATUS);
    // **`fork_count` は親のものであって、子の値ではない**（子の被フォーク数は 0）。
    expect(row.fork_count).toBe(0);
  });

  it('新規生成の parent_id は NULL のままである（5.7 の推敲も同じ）', async () => {
    // **系統に載るかどうかを、呼び出し側の引数ではなく呼んだ関数が決める。**
    // 推敲（5.7）はそもそも行を作らないので、この 2 つ以外に `parent_id` を書く経路が無い。
    const userId = await seedUser('fork-original');
    const original = await createPendingGame(env, userId, { prompt: 'オリジナル' });
    expect((await readGame(original.id)).parent_id).toBeNull();
  });

  it('同じ親から 2 件フォークしても、どちらも親を 1 つだけ持つ（DAG にしない）', async () => {
    const author = await seedUser('fork-tree-parent');
    const forker = await seedUser('fork-tree-child');
    const parent = await createPendingGame(env, author, { prompt: '親のお題' });

    const first = await createForkedGame(env, forker, { prompt: '1 回目' }, parent.id);
    const second = await createForkedGame(env, forker, { prompt: '2 回目' }, parent.id);

    expect(first.id).not.toBe(second.id);
    expect((await readGame(first.id)).parent_id).toBe(parent.id);
    expect((await readGame(second.id)).parent_id).toBe(parent.id);
  });
});

describe('系統の近傍と fork_count（5.5 / M5-3 / #34）', () => {
  /**
   * 完成させて公開した作品を 1 件用意する。
   *
   * **経路を通す。** ここで確かめたいのは「`fork_count` が公開の経路で動くか」で
   * あって一覧の引き方ではないので、行を直接 insert しない
   * （`listAuthoredGames` の `seedGame` とは逆の判断である）。
   *
   * @param userId 作者
   * @param prompt 仮タイトルの元になるプロンプト
   * @param parentId 親の作品 id（オリジナルなら null）
   * @param now 時刻（UNIX 秒。`published_at` になるので並び順を決める）
   * @returns 作った作品の id
   */
  async function publishNew(
    userId: string,
    prompt: string,
    parentId: string | null,
    now: number,
  ): Promise<string> {
    const pending =
      parentId === null
        ? await createPendingGame(env, userId, { prompt }, now)
        : await createForkedGame(env, userId, { prompt }, parentId, now);
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken), now);
    await completeGame(
      env,
      pending.id,
      fakeBuildOutcome({ sourceSha256: `f${pending.id.replace(/-/gu, '')}`.padEnd(64, '0') }),
      now,
    );
    const outcome = await publishGame(env, pending.id, userId, now);
    expect(outcome.ok).toBe(true);
    return pending.id;
  }

  /**
   * 完成させたが公開していないフォークの子を 1 件用意する。
   *
   * @param userId 作者
   * @param parentId 親の作品 id
   * @param now 時刻（UNIX 秒）
   * @returns 作った作品の id
   */
  async function forkDraft(userId: string, parentId: string, now: number): Promise<string> {
    const pending = await createForkedGame(env, userId, { prompt: '未公開の改造' }, parentId, now);
    await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken), now);
    await completeGame(
      env,
      pending.id,
      fakeBuildOutcome({ sourceSha256: `d${pending.id.replace(/-/gu, '')}`.padEnd(64, '0') }),
      now,
    );
    return pending.id;
  }

  it('子が公開された瞬間に親の fork_count が動く（フォークの起動では動かない）', async () => {
    const author = await seedUser('fc-publish-author');
    const forker = await seedUser('fc-publish-forker');
    const parent = await publishNew(author, '親のゲーム', null, 1000);

    // **起動では動かない**（#32 が置いた境界。`pending` の行を数えると 5.5 の
    // 「N 件」と食い違う）。この不変条件は `test/fork.test.ts` も見ている。
    const child = await createForkedGame(env, forker, { prompt: '色を変える' }, parent, 1100);
    expect((await readGame(parent)).fork_count).toBe(0);

    await claimGenerationJob(env, child.id, await hashJobToken(child.jobToken), 1100);
    await completeGame(env, child.id, fakeBuildOutcome({ sourceSha256: 'e'.repeat(64) }), 1100);
    // ここまで（完成しただけ）でも動かない。
    expect((await readGame(parent)).fork_count).toBe(0);

    await publishGame(env, child.id, forker, 1200);
    expect((await readGame(parent)).fork_count).toBe(1);
  });

  it('draft の子は fork_count に入らない（実件数と一致する）', async () => {
    const author = await seedUser('fc-draft-author');
    const forker = await seedUser('fc-draft-forker');
    const parent = await publishNew(author, '親のゲーム', null, 2000);

    await publishNew(forker, '公開された改造', parent, 2100);
    await forkDraft(forker, parent, 2200);
    await forkDraft(forker, parent, 2300);

    expect((await readGame(parent)).fork_count).toBe(1);
    expect(await countPublishedForks(env, parent)).toBe(1);
  });

  it('二度押しでは増えない（遷移が起きたときだけ数え直す）', async () => {
    const author = await seedUser('fc-twice-author');
    const forker = await seedUser('fc-twice-forker');
    const parent = await publishNew(author, '親のゲーム', null, 3000);
    const child = await publishNew(forker, '改造', parent, 3100);

    const second = await publishGame(env, child, forker, 3200);
    expect(second).toEqual({ ok: true, firstTime: false, publishedAt: 3100 });
    expect((await readGame(parent)).fork_count).toBe(1);
  });

  it('この実装より前に作られた行も、次の 1 件が公開された時点で実件数に揃う', async () => {
    // **「実装より前に完成した行は、その実装の経路を 1 度も通っていない」**
    // （#202 / #203 と同じ形）。`fork_count` は 0001 からある列だが、これを動かす
    // 経路は #34 で初めてできた。本番には既に 3 世代の系統が 1 本ある。
    //
    // **加算（`fork_count + 1`）ならここが赤になる**（0 のまま残った親に 1 を足すので
    // 2 件目の公開で 1 にしかならない）。数え直しなので実件数へ収束する。
    const author = await seedUser('fc-legacy-author');
    const forker = await seedUser('fc-legacy-forker');
    const parent = await publishNew(author, '親のゲーム', null, 4000);

    // 「#34 より前に公開された子」を、経路を通さずに置く。
    const legacy = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games
         (id, author_id, parent_id, status, title, go_version, fork_count,
          created_at, published_at, generation_state)
       values (?, ?, ?, 'published', '昔の改造', '', 0, 4100, 4100, 'ready')`,
    )
      .bind(legacy, forker, parent)
      .run();
    // 親の非正規化列は取り残されている（本番と同じ状態）。
    expect((await readGame(parent)).fork_count).toBe(0);

    await publishNew(forker, '新しい改造', parent, 4200);

    // 1 ではなく 2 になる。**取り残されていた 1 件も数え直しに含まれた。**
    expect((await readGame(parent)).fork_count).toBe(2);
    expect(await countPublishedForks(env, parent)).toBe(2);
  });

  it('オリジナル（parent_id が NULL）の公開では誰の値も動かない', async () => {
    const author = await seedUser('fc-orphan-author');
    const before = await env.DB.prepare('select sum(fork_count) as n from games')
      .first<{ n: number | null }>();
    await publishNew(author, '親を持たないゲーム', null, 5000);
    const after = await env.DB.prepare('select sum(fork_count) as n from games')
      .first<{ n: number | null }>();
    expect(after?.n ?? 0).toBe(before?.n ?? 0);
  });

  it('listPublishedForks は published の子だけを新しい順に返す', async () => {
    const author = await seedUser('fl-order-author');
    const forker = await seedUser('fl-order-forker');
    const parent = await publishNew(author, '親のゲーム', null, 6000);

    const older = await publishNew(forker, '古い改造', parent, 6100);
    const newer = await publishNew(forker, '新しい改造', parent, 6300);
    const hidden = await forkDraft(forker, parent, 6200);

    const listed = await listPublishedForks(env, parent, 20);
    expect(listed.map((child) => child.id)).toEqual([newer, older]);
    // **draft は 1 行も出ない**（#34 の acceptance）。題名はプロンプト由来なので、
    // 出すと 5.4 の「公開して初めて有効になる」の抜け道になる。
    expect(listed.map((child) => child.id)).not.toContain(hidden);
    expect(listed[0]?.title).toBe('新しい改造');
    expect(listed[0]?.publishedAt).toBe(6300);
  });

  it('同じ秒に公開された 2 件は id の降順で決まる', async () => {
    const author = await seedUser('fl-tie-author');
    const forker = await seedUser('fl-tie-forker');
    const parent = await publishNew(author, '親のゲーム', null, 7000);
    const a = await publishNew(forker, '同時 A', parent, 7100);
    const b = await publishNew(forker, '同時 B', parent, 7100);

    const listed = await listPublishedForks(env, parent, 20);
    expect(listed.map((child) => child.id)).toEqual([a, b].sort().reverse());
  });

  it('21 件目は offset で取れる（20 件＋もっと見る）', async () => {
    const author = await seedUser('fl-page-author');
    const forker = await seedUser('fl-page-forker');
    const parent = await publishNew(author, '親のゲーム', null, 8000);
    const children: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      children.push(await publishNew(forker, `改造 ${i}`, parent, 8100 + i));
    }
    // 新しい順なので、最後に公開したものが先頭に来る。
    const newestFirst = [...children].reverse();

    const first = await listPublishedForks(env, parent, 20, 0);
    expect(first.map((child) => child.id)).toEqual(newestFirst.slice(0, 20));

    const second = await listPublishedForks(env, parent, 20, 20);
    expect(second.map((child) => child.id)).toEqual([newestFirst[20]]);
    expect(await countPublishedForks(env, parent)).toBe(21);
  });

  it('子が 1 件も無ければ 0 件と空を返す', async () => {
    const author = await seedUser('fl-empty-author');
    const parent = await publishNew(author, '誰も改造していないゲーム', null, 9000);
    expect(await countPublishedForks(env, parent)).toBe(0);
    expect(await listPublishedForks(env, parent, 20)).toEqual([]);
  });

  it('不正な limit / offset は問い合わせる前に落とす', async () => {
    // **SQLite は `OFFSET -1` を 0 として黙って受け入れる。** 落とさないと、
    // 負の位置を渡した呼び出しが 1 頁目を返して「動いて」しまう。
    const author = await seedUser('fl-bad-args-author');
    const parent = await publishNew(author, '親のゲーム', null, 9500);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(listPublishedForks(env, parent, bad)).rejects.toThrow(/取得件数が不正です/u);
      await expect(listPublishedForks(env, parent, 20, bad)).rejects.toThrow(
        /読み飛ばし件数が不正です/u,
      );
    }
  });
});
