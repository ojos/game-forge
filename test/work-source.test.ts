/**
 * ソースコードの閲覧（`/source/<game_id>`。仕様 2.3.12 / #383）の検査。
 *
 * # acceptance が確かめたいこと
 *
 * > 公開済みの作品のソースが読める / **`draft` と審査で止めた作品のソースが読めない**（変異で確認）/
 * > システムプロンプト・入力プロンプト・R2 のキーが応答に含まれない
 *
 * **「読めない」の検査は、同じ作品で「読める」を先に見てから倒す。** 最初から 404 の作品だけを
 * 見ると、経路そのものが壊れていても緑になる。
 *
 * **入力プロンプトの検査は「D1 に保存した文字列が応答に出ない」に限る**（#383 の決定 1）。
 * 生成されたコードのコメントに言い換えが写ることは受け入れている（仕様 2.3.12）。
 *
 * **R2 のキーは実際の値で照合する**（`builds/` のような一般的な型で照合しない。#383 の推奨）。
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes } from '../src/app.js';
import {
  claimGenerationJob,
  completeGame,
  createPendingGame,
  hashJobToken,
  publishGame,
  removeGame,
} from '../src/games.js';
import { GENERATION_MODELS } from '../src/generation-models.js';
import { siteViewerAt } from '../src/html.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import { dispatch, findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { validateBio } from '../src/profile.js';
import { MAX_SOURCE_BYTES } from '../src/source-size.js';
import { SYSTEM_PROMPT_SECTIONS } from '../src/system-prompt.js';
import { workPagePath, workPageRoutes } from '../src/work-page.js';
import {
  SOURCE_MISSING_NOTICE,
  SOURCE_TOO_LARGE_NOTICE,
  WORK_SOURCE_PREFIX,
  markDirectionControls,
  renderWorkSourcePage,
  workSourcePath,
  workSourceRoutes,
} from '../src/work-source.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-work-source-page-1';

/** 仕込むソースの目印。**応答にこれがあれば、本文が届いている。** */
const SOURCE_MARK = 'lane-source-marker-383';

/**
 * 仕込むソース。**入力プロンプトもシステムプロンプトも写していない**（検査が見るのは、
 * 画面が D1 や定数からそれらを持ち込まないことである）。HTML として解釈されうる文字列を含める。
 */
const SOURCE = `package main

// ${SOURCE_MARK}
import "github.com/hajimehoshi/ebiten/v2"

type Game struct{ x int }

func (g *Game) Update() error { g.x++; return nil }

var label = "</code></pre><script>alert(1)</script>&amp;"
`;

/**
 * テスト用の env。
 *
 * @returns 秘密を差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

/**
 * 利用者を 1 人用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns 利用者の id
 */
async function seedUser(suffix: string): Promise<string> {
  const id = `source-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, `作者${suffix}`)
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/** 仕込んだ作品。 */
interface SeededWork {
  readonly userId: string;
  readonly id: string;
  readonly jobToken: string;
  readonly prompt: string;
}

/**
 * 完成済みの作品を 1 件用意し、**R2 にソースを置く**。公開はしない（`draft`）。
 *
 * **お題は 2 行にする。** 仮の題名は 1 行目から作られ、公開すれば画面に出る（5.4）。検査が
 * 見たいのは「D1 に保存したプロンプトの文字列」が出ないことで、2 行目はどこにも出てはいけない。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param source R2 に置くソース
 * @returns 作者の id・作品 id・ジョブトークン・お題
 */
async function seedReady(suffix: string, source: string = SOURCE): Promise<SeededWork> {
  const userId = await seedUser(suffix);
  const prompt = `ソース検査${suffix}\nひみつの入力プロンプト本文-${suffix}`;
  const pending = await createPendingGame(env, userId, { prompt });
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  // **ソースの SHA-256 は 64 桁の 16 進にする**（キーの綴りが本番と同じ形になる）。
  const sha = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: sha }));
  const keys = await artifactKeysOf(pending.id);
  await env.BUCKET.put(keys.sourceKey, source);

  // **入力プロンプトを D1 の 2 か所に置く**（費用台帳と推敲の版）。画面がどちらかを読めば出る。
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 1, ?)`,
  )
    .bind(crypto.randomUUID(), pending.id, userId, prompt, GENERATION_MODELS[0]!.key, 1)
    .run();
  await env.DB.prepare(
    `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
     values (?, 99, ?, ?, 'go1.26.5', ?, 1)`,
  )
    .bind(pending.id, keys.sourceKey, keys.wasmKey, `推敲の差分プロンプト-${suffix}`)
    .run();

  return { userId, id: pending.id, jobToken: pending.jobToken, prompt };
}

/**
 * 公開済みの作品を 1 件用意する。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param source R2 に置くソース
 * @returns 仕込んだ作品
 */
async function seedPublished(suffix: string, source: string = SOURCE): Promise<SeededWork> {
  const work = await seedReady(suffix, source);
  expect((await publishGame(env, work.id, work.userId)).ok).toBe(true);
  return work;
}

/**
 * 作品の R2 キーを D1 から読む（**実際の値で照合する**ため）。
 *
 * @param gameId 作品 id
 * @returns R2 のキー
 */
async function artifactKeysOf(gameId: string): Promise<{ sourceKey: string; wasmKey: string }> {
  const row = await env.DB.prepare('select source_key, wasm_key from games where id = ?')
    .bind(gameId)
    .first<{ source_key: string; wasm_key: string }>();
  expect(row?.source_key, 'source_key が入っていない').toBeTruthy();
  expect(row?.wasm_key, 'wasm_key が入っていない').toBeTruthy();
  return { sourceKey: row!.source_key, wasmKey: row!.wasm_key };
}

/**
 * 経路表を通してパスを開く。
 *
 * @param path パス
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 状態コードと本文
 */
async function open(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  const response = await dispatch(
    createAppRoutes(testEnv()),
    new Request(`${APP_ORIGIN}${path}`, { headers }),
    testEnv(),
  );
  return { status: response.status, body: await response.text() };
}

/**
 * 審査の状態を置く。
 *
 * @param gameId 作品 id
 * @param state `review_state` の値（null で審査なし）
 */
async function setReviewState(gameId: string, state: string | null): Promise<void> {
  await env.DB.prepare('update games set review_state = ? where id = ?').bind(state, gameId).run();
  // **`meta.changes` で確かめない。** `games` のトリガ（検索の索引。#378）が数を膨らませうるので、
  // 行を読み直して値そのものを見る。
  const row = await env.DB.prepare('select review_state from games where id = ?')
    .bind(gameId)
    .first<{ review_state: string | null }>();
  expect(row, '作品の行が無い').not.toBeNull();
  expect(row!.review_state).toBe(state);
}

beforeAll(async () => {
  await applySchema();
});

describe('経路（2.3.1 / #383）', () => {
  it('前方一致の規約を守り、アプリの経路表に 1 本だけ登録されている', () => {
    expect(WORK_SOURCE_PREFIX.endsWith('/')).toBe(true);
    expect(findMalformedPrefixRoutes(workSourceRoutes)).toEqual([]);
    const routes = createAppRoutes(testEnv());
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(routes.filter((route) => route.path === WORK_SOURCE_PREFIX)).toHaveLength(1);
    expect(workSourcePath('abc')).toBe(`${WORK_SOURCE_PREFIX}abc`);
  });

  it('id の綴りが違えば 404', async () => {
    for (const path of ['/source/', '/source/not-a-uuid', '/source/../etc', '/source/x/y']) {
      expect((await open(path)).status, path).toBe(404);
    }
  });
});

describe('公開済みの作品のソースが読める（acceptance 1）', () => {
  it('未ログインでも、R2 のソースがそのまま（エスケープして）出る', async () => {
    const { id } = await seedPublished('read');
    const { status, body } = await open(workSourcePath(id));
    expect(status).toBe(200);
    expect(body).toContain(SOURCE_MARK);
    expect(body).toContain('<pre class="gf-source" tabindex="0" aria-label="ソースコード"><code>package main');
    // **ソースを HTML として解釈させない。** 生成物の文字列リテラルは 8.3 が語を見るだけで、
    // HTML は見ない。
    expect(body).toContain(
      '&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;',
    );
    expect(body).not.toContain('<script>alert(1)</script>');
    // 作品ページへ戻る道がある。
    expect(body).toContain(`href="${workPagePath(id)}"`);
    // 検索避けする（着地点は作品ページ）。
    expect(body).toContain('<meta name="robots" content="noindex">');
  });

  it('ログイン中の作者でも同じものが出る（本人かどうかで中身を変えない）', async () => {
    const { id, userId } = await seedPublished('owner');
    const anon = await open(workSourcePath(id));
    const owner = await open(workSourcePath(id), await sessionCookie(userId));
    expect(owner.status).toBe(200);
    expect(owner.body).toContain(SOURCE_MARK);
    // ヘッダ（ログイン状態の出し分け）の外は同じである。
    const main = (body: string): string => body.slice(body.indexOf('<h1>'));
    expect(main(owner.body)).toBe(main(anon.body));
  });

  it('上限（64KB）ちょうどのソースは切り詰めずに出す', async () => {
    const filler = `// ${'x'.repeat(200)}\n`;
    let source = `package main\n// ${SOURCE_MARK}\n`;
    while (new TextEncoder().encode(source + filler).length <= MAX_SOURCE_BYTES) {
      source += filler;
    }
    const { id } = await seedPublished('limit', source);
    const { status, body } = await open(workSourcePath(id));
    expect(status).toBe(200);
    expect(body).toContain(source.slice(-100));
  });

  it('R2 に実体が無ければ 404 にせず、時間をおいて開き直すよう言う', async () => {
    const missing = await seedPublished('missing');
    await env.BUCKET.delete((await artifactKeysOf(missing.id)).sourceKey);
    const gone = await open(workSourcePath(missing.id));
    expect(gone.status).toBe(200);
    expect(gone.body).toContain(SOURCE_MISSING_NOTICE);
    expect(gone.body).not.toContain(SOURCE_TOO_LARGE_NOTICE);
    expect(gone.body).not.toContain('<pre');
  });

  it('上限超は「大きすぎて表示できない」と言い、再試行を促さない（理由を畳まない）', async () => {
    // 変異: `readPublishedSource` で `source-too-large` を `missing` に倒すと赤（2026-09-13）。
    const large = await seedPublished('too-large', `// ${'y'.repeat(MAX_SOURCE_BYTES)}`);
    const big = await open(workSourcePath(large.id));
    expect(big.status).toBe(200);
    expect(big.body).toContain(SOURCE_TOO_LARGE_NOTICE);
    expect(big.body).not.toContain(SOURCE_MISSING_NOTICE);
    expect(big.body).not.toContain('y'.repeat(100));
    expect(big.body).not.toContain('<pre');
    // **何度開いても同じなので、時間をおいてと言わない。** 上限の値は定数から作っている。
    expect(SOURCE_TOO_LARGE_NOTICE).not.toContain('もう一度');
    expect(SOURCE_TOO_LARGE_NOTICE).toContain(`${MAX_SOURCE_BYTES / 1024}KB`);
    expect(SOURCE_MISSING_NOTICE).toContain('もう一度');
  });

  it('公開済みで source_key が NULL の行でも壊れず、200 で読み出せない旨を言う', async () => {
    const work = await seedPublished('null-key');
    await env.DB.prepare('update games set source_key = null where id = ?').bind(work.id).run();
    const row = await env.DB.prepare('select source_key from games where id = ?')
      .bind(work.id)
      .first<{ source_key: string | null }>();
    expect(row, '作品の行が無い').not.toBeNull();
    expect(row!.source_key).toBeNull();

    const { status, body } = await open(workSourcePath(work.id));
    expect(status).toBe(200);
    expect(body).toContain(SOURCE_MISSING_NOTICE);
    expect(body).not.toContain('<pre');
    // R2 の実体は残っているが、キーが無い以上は読まない（キーを推測しない）。
    expect(body).not.toContain(SOURCE_MARK);
  });

  it('横にスクロールする <pre> はキーボードで焦点を持て、読み上げの名前を持つ', async () => {
    const { id } = await seedPublished('focusable');
    const { body } = await open(workSourcePath(id));
    expect(body).toContain('<pre class="gf-source" tabindex="0" aria-label="ソースコード"><code>');
    // 焦点の枠は app.css の `@section work` が持つ（全画面の `:focus-visible` と同じ形）。
    const focus = /^\.gf-source:focus-visible\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(focus, 'app.css に .gf-source:focus-visible の規則が無い').not.toBeNull();
    expect(focus![1]).toContain('outline: 2px solid var(--gf-ink)');
  });
});

describe('draft と審査で止めた作品のソースは読めない（acceptance 2。変異で確認）', () => {
  /*
   * 変異の記録（2026-09-13 / #383。当てて赤を見てから戻した）
   *
   * 1. `PUBLISHED_SOURCE_SQL` の `status = ?` を `? is not null` にする（status を見ない）
   *    → 「draft」「取り下げた」「理由を分けない」の it が赤
   * 2. `PUBLISHED_SOURCE_SQL` から `reviewVisibleSql()` を外す
   *    → 「審査で止めた」「理由を分けない」の it が赤
   * 3. `renderWorkSourcePage` の `escapeHtml(view.source)` を `view.source` にする
   *    → acceptance 1 の「エスケープして」の it が赤
   */

  it('draft の作品は、R2 にソースがあっても 404（公開すると読めるようになる）', async () => {
    const work = await seedReady('draft');
    const draft = await open(workSourcePath(work.id), await sessionCookie(work.userId));
    // **作者本人でも読めない**（公開の前は、公開した作品の扱いにしない。5.4）。
    expect(draft.status).toBe(404);
    expect(draft.body).not.toContain(SOURCE_MARK);

    // 同じ作品を公開すると読める（**この検査が空振りしていない**）。
    expect((await publishGame(env, work.id, work.userId)).ok).toBe(true);
    const published = await open(workSourcePath(work.id));
    expect(published.status).toBe(200);
    expect(published.body).toContain(SOURCE_MARK);
  });

  it('審査で新規露出を止めた作品は 404。問題なしにすると読める', async () => {
    const { id } = await seedPublished('queued');
    expect((await open(workSourcePath(id))).status).toBe(200);

    await setReviewState(id, REVIEW_QUEUED);
    const queued = await open(workSourcePath(id));
    expect(queued.status).toBe(404);
    expect(queued.body).not.toContain(SOURCE_MARK);

    // `cleared` は露出する（`reviewVisibleSql` と同じ条件）。
    await setReviewState(id, REVIEW_CLEARED);
    expect((await open(workSourcePath(id))).status).toBe(200);
  });

  it('取り下げた作品は 404（取り下げても source_key は残るが、引く時点で落ちる）', async () => {
    const { id, userId } = await seedPublished('removed');
    expect((await open(workSourcePath(id))).status).toBe(200);
    expect((await removeGame(env, id, userId)).ok).toBe(true);
    // **実装は取り下げで `source_key` を消さない**（`removeGame`。仕様 2.3.12 の実装注記）。
    expect((await artifactKeysOf(id)).sourceKey).not.toBe('');

    const removed = await open(workSourcePath(id));
    expect(removed.status).toBe(404);
    expect(removed.body).not.toContain(SOURCE_MARK);
  });

  it('理由を分けない（存在しない・draft・審査で止めた・取り下げたの本文が同じ）', async () => {
    const draft = await seedReady('same-draft');
    const queued = await seedPublished('same-queued');
    await setReviewState(queued.id, REVIEW_QUEUED);
    const removed = await seedPublished('same-removed');
    expect((await removeGame(env, removed.id, removed.userId)).ok).toBe(true);

    const bodies = await Promise.all(
      ['9ffe7c2a-59a9-4a58-b82c-d4a8cea7c62f', draft.id, queued.id, removed.id].map(
        async (id) => {
          const { status, body } = await open(workSourcePath(id));
          expect(status, id).toBe(404);
          // パンくずの末尾は `<title>` から取るので同じになる。パス（id）だけが違ってよい。
          return body.replaceAll(id, '<id>');
        },
      ),
    );
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('システムプロンプト・入力プロンプト・内部の識別子を出さない（acceptance 3）', () => {
  it('ソースの画面にも作品ページにも、D1 のプロンプト・R2 のキー・ジョブの識別子・モデルが出ない', async () => {
    const work = await seedPublished('secrets');
    const keys = await artifactKeysOf(work.id);
    const jobHash = await env.DB.prepare('select job_token_hash from games where id = ?')
      .bind(work.id)
      .first<{ job_token_hash: string | null }>();

    // **D1 に保存した入力プロンプトを、D1 から読み直して照合する**（書き写した文字列で見ない）。
    const prompts = [
      ...(
        await env.DB.prepare('select prompt from generations where game_id = ?')
          .bind(work.id)
          .all<{ prompt: string }>()
      ).results.map((row) => row.prompt),
      ...(
        await env.DB.prepare('select prompt from game_revisions where game_id = ? and prompt is not null')
          .bind(work.id)
          .all<{ prompt: string }>()
      ).results.map((row) => row.prompt),
    ];
    expect(prompts.length, 'D1 にプロンプトが仕込めていない').toBeGreaterThanOrEqual(2);

    const forbidden: string[] = [
      ...prompts,
      // 2 行目（題名にならない側）も単独で見る。
      work.prompt.split('\n')[1]!,
      keys.sourceKey,
      keys.wasmKey,
      work.jobToken,
      ...(jobHash?.job_token_hash ? [jobHash.job_token_hash] : []),
      ...GENERATION_MODELS.flatMap((model) => [model.modelId]),
      'arn:aws:',
    ];

    const pages = [
      await open(workSourcePath(work.id)),
      await open(workSourcePath(work.id), await sessionCookie(work.userId)),
      await open(workPagePath(work.id)),
      await open(workPagePath(work.id), await sessionCookie(work.userId)),
    ];
    for (const { status, body } of pages) {
      expect(status).toBe(200);
      for (const value of forbidden) {
        expect(body.includes(value), `応答に含まれている: ${value}`).toBe(false);
      }
      // **システムプロンプト（6.1）。** 節の全文と、文章の行（日本語を含む 20 字以上）を見る。
      // コードの行（`func (g *Game) Update() error {` など）は、生成物が同じ形を持ちうるので見ない。
      for (const section of SYSTEM_PROMPT_SECTIONS) {
        expect(body.includes(section)).toBe(false);
        for (const line of section.split('\n').map((text) => text.trim())) {
          if (line.length >= 20 && /[぀-ヿ一-鿿]/u.test(line)) {
            expect(body.includes(line), `システムプロンプトの行が出ている: ${line}`).toBe(false);
          }
        }
      }
    }
    // 作品ページの 1 つ目は空振りしていない（ソースの画面は本文を持つ）。
    expect(pages[0]!.body).toContain(SOURCE_MARK);
  });

  it('画面の型に R2 のキーの置き場所が無い（描画は id・題名・本文だけで決まる）', () => {
    const body = renderWorkSourcePage(
      {
        gameId: '00000000-0000-4000-8000-000000000383',
        title: '<b>題</b>',
        source: { kind: 'ok', text: 'x := 1' },
      },
      siteViewerAt('/source/00000000-0000-4000-8000-000000000383', false),
    );
    expect(body).toContain('<h1>&lt;b&gt;題&lt;/b&gt; のソースコード</h1>');
    expect(body).toContain('<code>x := 1</code>');
  });
});

describe('作品ページからの導線（#383）', () => {
  it('公開済みの作品ページのリンクは、実際に開ける', async () => {
    const { id } = await seedPublished('link');
    const page = await dispatch(
      workPageRoutes,
      new Request(`${APP_ORIGIN}${workPagePath(id)}`),
      testEnv(),
    );
    const body = await page.text();
    expect(body).toContain(`<a href="${workSourcePath(id)}">ソースコードを見る</a>`);
    expect((await open(workSourcePath(id))).status).toBe(200);
  });
});

describe('文字の向きを変える制御文字を、表示のときだけ見える印にする（#383 / Trojan Source）', () => {
  /** `\p{Bidi_Control}` に当たる符号位置（BMP を総当たりで数える。組の正本は Unicode のデータ）。 */
  function bidiControls(): number[] {
    const found: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (/\p{Bidi_Control}/u.test(String.fromCharCode(code))) {
        found.push(code);
      }
    }
    return found;
  }

  it('判定の組は、自己紹介（src/profile.ts の DIRECTION_CHARACTER）が弾く組と同じである', () => {
    const controls = bidiControls();
    // 親の指示に挙がった 12 個（U+061C / U+200E / U+200F / U+202A〜202E / U+2066〜2069）。
    expect(controls).toEqual([
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ]);
    // **import せずに突き合わせる**（あちらの定数は非公開）。`validateBio` が「向きの文字」として弾く
    // 符号位置（制御文字・行区切り・段落区切りとして弾くものを除く）と、この画面が印にする符号位置が
    // 一致すること。
    const rejectedByBio: number[] = [];
    const markedHere: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const character = String.fromCharCode(code);
      if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(character)) {
        continue;
      }
      if (!validateBio(`a${character}b`).ok) {
        rejectedByBio.push(code);
      }
      if (markDirectionControls(`a${character}b`) !== `a${character}b`) {
        markedHere.push(code);
      }
    }
    expect(markedHere).toEqual(controls);
    expect(rejectedByBio).toEqual(controls);
  });

  it('画面では印に置き換わり、生の制御文字は 1 つも残らない。R2 のソースは変えない', async () => {
    // 変異: `renderWorkSourcePage` から `markDirectionControls(...)` を外すと赤（2026-09-13）。
    const tricky = `package main\n// ${SOURCE_MARK}\nvar s = "admin\u202e \u2066// user\u2069\u2066"\nvar t = "<b>\u200f</b>"\n`;
    const work = await seedPublished('bidi', tricky);
    const { status, body } = await open(workSourcePath(work.id));
    expect(status).toBe(200);
    expect(body).not.toMatch(/\p{Bidi_Control}/u);
    for (const code of ['U+202E', 'U+2066', 'U+2069', 'U+200F']) {
      expect(body).toContain(
        `<span class="gf-source-bidi" title="文字の向きを変える制御文字 ${code}">⟨${code}⟩</span>`,
      );
    }
    // **印の `<span>` はエスケープされていない**（エスケープの後に置き換える）。周りのソースは
    // エスケープされたままである。
    expect(body).not.toContain('&lt;span class=&quot;gf-source-bidi');
    expect(body).toContain('&lt;b&gt;<span class="gf-source-bidi"');

    // **R2 の生のソース（フォークで渡るもの）は 1 文字も変わっていない。**
    const stored = await env.BUCKET.get((await artifactKeysOf(work.id)).sourceKey);
    expect(await stored!.text()).toBe(tricky);
  });

  it('印の見た目は app.css に規則を持ち、色の値を直に書かない', () => {
    const rule = /^\.gf-source-bidi\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS);
    expect(rule, 'app.css に .gf-source-bidi の規則が無い').not.toBeNull();
    expect(rule![1]!).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  });
});
