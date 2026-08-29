import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BuildOutcome } from '../src/build-client.js';
import type { BuildCacheEntry } from '../src/build-cache.js';
import { deleteUnreferencedArtifacts, readBuildCache, recordBuildCache } from '../src/build-cache.js';
import { defaultPipeline } from '../src/generate.js';
import {
  DRAFT_STATUS,
  MAX_TITLE_LENGTH,
  PREVIEW_KEY_BYTES,
  UNTITLED_TITLE,
  createDraftGame,
  createPreviewKey,
  draftTitleFromPrompt,
} from '../src/games.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

beforeAll(async () => {
  await applySchema();
});

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
  it('createGame が createDraftGame である', () => {
    // **同一性で見る**（`test/quota.test.ts` と同じ形）。外すと、成果物は R2 に入り
    // 費用も計上されたのに作品が残らない状態へ戻る。
    expect(defaultPipeline.createGame).toBe(createDraftGame);
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
