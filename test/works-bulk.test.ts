import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { deleteGame } from '../src/game-deletion.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, publishGame, unpublishGame } from '../src/games.js';
import type { ForkNoticeOutcome } from '../src/mail/fork-notice.js';
import { BULK_BUTTONS, MY_WORKS_PATH, MY_WORKS_PER_PAGE } from '../src/my-works.js';
import type { OgpCaptureJob } from '../src/ogp-client.js';
import { dispatch, findDuplicateRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { deleteAuthoredGame, deletionConsequences } from '../src/work-delete.js';
import { PUBLISH_SOURCE_NOTICE } from '../src/work-page.js';
import {
  BULK_CONTINUE_PARAM,
  BULK_FAILED_PARAM,
  createWorksBulkRoutes,
  nextStepPath,
  readFailures,
  readSelection,
} from '../src/works-bulk.js';
import type { BulkAction, BulkTargetRow } from '../src/works-bulk-rules.js';
import {
  BULK_ACTIONS,
  BULK_REASON_TEXTS,
  BULK_STEP_SIZES,
  MAX_BULK_WORKS,
  bulkBlockOf,
  bulkTargetsSql,
} from '../src/works-bulk-rules.js';
import {
  MY_WORKS_BULK_PATH,
  WORKS_BULK_ACTION_FIELD,
  WORKS_BULK_API_PATH,
  WORKS_BULK_GAME_ID_FIELD,
} from '../src/works-bulk-paths.js';
import { D1_QUERY_LIMIT } from '../src/withdrawal-purge.js';
import { countingEnv } from './helpers/d1-counting.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 「あなたの作品」の一括操作（#666）。
 *
 * **#666 の acceptance と constraints を機械判定できる形へ落とす。**
 *
 * - 一括の公開・下書きへ戻す・削除が、**確認を通ってから選んだ作品にだけ効く**
 * - **対象外の作品を混ぜると、その作品を名前付きで示して除外する**（他人の作品は名前を出さない）
 * - 1 件ずつなら許されない操作は、一括でも許さない（1 件ずつの関数と、表示の条件の一致）
 * - 確認の中身を 1 件ずつのときから省かない
 * - 一部だけ失敗したら、どの作品が失敗したかを示す
 * - Workers Free の D1 の枠（1 呼び出し 50 文）を、どの往復も超えない
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-works-bulk-1';

/**
 * テスト用の env（**AWS の資格情報を入れておく**。入れないと撮影の起動が設定不足で降り、「撮影を起こしたか」の
 * 検査が理由の違いで緑になる。`test/publish.test.ts` と同じ理由）。
 *
 * @returns env
 */
function testEnv(): Env {
  return {
    ...env,
    SESSION_SECRET: SECRET,
    BUILD_AWS_REGION: 'ap-northeast-1',
    BUILD_AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    BUILD_AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  } as Env;
}

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `bulk-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/** 作品の下準備。 */
interface SeedGame {
  readonly status?: string;
  readonly generationState?: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
  /** 成果物のキーと版と R2 の実体を持たせるか（削除の文の数を最悪の形で数えるため）。 */
  readonly artifacts?: boolean;
}

/**
 * 作品を 1 件入れる。
 *
 * @param authorId 作者
 * @param seed 下準備
 * @returns 作品 id
 */
async function seedGame(authorId: string, seed: SeedGame = {}): Promise<string> {
  const id = crypto.randomUUID();
  const status = seed.status ?? DRAFT_STATUS;
  const state = seed.generationState ?? 'ready';
  const [tag1, tag2, tag3] = [...(seed.tags ?? []), null, null, null];
  const sourceKey = seed.artifacts === true ? `builds/${id}.go` : null;
  const wasmKey = seed.artifacts === true ? `builds/${id}.wasm.br` : null;
  await env.DB.prepare(
    `insert into games
       (id, author_id, parent_id, status, title, go_version, source_key, wasm_key, created_at, published_at,
        preview_key, generation_state, tag1, tag2, tag3)
     values (?, ?, ?, ?, ?, 'go1.27.0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      seed.parentId ?? null,
      status,
      seed.title ?? `題名-${id.slice(0, 8)}`,
      sourceKey,
      wasmKey,
      Math.floor(Date.now() / 1000),
      status === PUBLISHED_STATUS ? 100 : null,
      crypto.randomUUID().replaceAll('-', ''),
      state,
      tag1 ?? null,
      tag2 ?? null,
      tag3 ?? null,
    )
    .run();
  if (sourceKey !== null && wasmKey !== null) {
    await env.DB.prepare(
      `insert into game_revisions (game_id, seq, source_key, wasm_key, go_version, prompt, created_at)
       values (?, 1, ?, ?, 'go1.27.0', null, 101)`,
    )
      .bind(id, sourceKey, wasmKey)
      .run();
    await env.BUCKET.put(sourceKey, 'source');
    await env.BUCKET.put(wasmKey, 'wasm');
  }
  return id;
}

/**
 * 作品の行を読む（無ければ null）。
 *
 * @param id 作品 id
 * @returns 行
 */
async function readGame(
  id: string,
): Promise<{ status: string; preview_key: string | null; tag1: string | null; tag2: string | null } | null> {
  return await env.DB.prepare('select status, preview_key, tag1, tag2 from games where id = ?')
    .bind(id)
    .first<{ status: string; preview_key: string | null; tag1: string | null; tag2: string | null }>();
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

/** 撮影と通知の差し替え。**呼ばれた作品を記録する。** */
interface Spies {
  readonly captured: string[];
  readonly notified: string[];
  readonly start: (env: Env, job: OgpCaptureJob) => Promise<void>;
  readonly notify: (env: Env, gameId: string) => Promise<ForkNoticeOutcome>;
}

/**
 * 撮影と通知の差し替えを作る。
 *
 * **通知は、本物の最悪の文の数（宛先を引く 1・握る 1・結果を記録する 1 の 3 文。`src/mail/fork-notice.ts`）を
 * D1 に打つ**——D1 の枠の検査で、通知の分を 0 文として数えないためである（本物は宛先の設定が無いテストでは D1 を
 * 触らずに降りる）。
 *
 * @returns 差し替え
 */
function spies(): Spies {
  const captured: string[] = [];
  const notified: string[] = [];
  return {
    captured,
    notified,
    start: async (_env: Env, job: OgpCaptureJob) => {
      captured.push(job.gameId);
    },
    notify: async (e: Env, gameId: string) => {
      notified.push(gameId);
      for (let i = 0; i < 3; i += 1) {
        await e.DB.prepare('select 1').first();
      }
      return 'not-configured';
    },
  };
}

/**
 * 確認画面を開く（経路表を通す）。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら undefined）
 * @param action 操作（null なら付けない）
 * @param ids 選んだ作品
 * @returns レスポンス
 */
async function openConfirmation(
  cookie: string | undefined,
  action: string | null,
  ids: readonly string[],
): Promise<Response> {
  const params = new URLSearchParams();
  if (action !== null) {
    params.set(WORKS_BULK_ACTION_FIELD, action);
  }
  for (const id of ids) {
    params.append(WORKS_BULK_GAME_ID_FIELD, id);
  }
  const headers: Record<string, string> = { accept: 'text/html' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const search = params.toString();
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${MY_WORKS_BULK_PATH}${search === '' ? '' : `?${search}`}`, { headers }),
    testEnv(),
  );
}

/** 実行の結果。 */
interface BulkRun {
  /** 最後の応答。 */
  readonly response: Response;
  /** 往復の数。 */
  readonly steps: number;
  /** 往復ごとの D1 の文の数。 */
  readonly statements: readonly number[];
}

/**
 * 実行の口へ送り、**307 をブラウザと同じようにたどる**（同じ本文・同じ POST のまま、Location へ送り直す）。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら undefined）
 * @param action 操作
 * @param ids 選んだ作品
 * @param deps 撮影と通知の差し替え
 * @param firstUrl 最初に送る URL（既定は実行の口）
 * @returns 結果
 */
async function runBulk(
  cookie: string | undefined,
  action: string,
  ids: readonly string[],
  deps: Spies = spies(),
  firstUrl = `${APP_ORIGIN}${WORKS_BULK_API_PATH}`,
): Promise<BulkRun> {
  const body = new URLSearchParams();
  body.set(WORKS_BULK_ACTION_FIELD, action);
  for (const id of ids) {
    body.append(WORKS_BULK_GAME_ID_FIELD, id);
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html,application/xhtml+xml',
  };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const statements: number[] = [];
  let url = firstUrl;
  // Safari がたどれるリダイレクトは 16 回。それより多く往復する形を緑にしない。
  for (let steps = 1; steps <= 16; steps += 1) {
    const counting = countingEnv(testEnv());
    const response = await dispatch(
      createWorksBulkRoutes(deps.start, deps.notify),
      new Request(url, { method: 'POST', headers, body: body.toString() }),
      counting.env,
    );
    statements.push(counting.count());
    if (response.status !== 307) {
      return { response, steps, statements };
    }
    url = new URL(response.headers.get('location')!, url).toString();
  }
  throw new Error('リダイレクトが 16 回を超えました');
}

describe('経路の登録（#666）', () => {
  it('確認画面は「あなたの作品」の子の完全一致で、作品ページの前方一致に飲み込まれない', async () => {
    expect(MY_WORKS_BULK_PATH).toBe(`${MY_WORKS_PATH}/bulk`);
    expect(findDuplicateRoutes(createAppRoutes(testEnv()))).toEqual([]);
    const response = await openConfirmation(await sessionCookie(await seedUser()), null, []);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('まとめて操作する作品を選んでください');
  });

  it('一度に選べる件数は 1 頁の件数と同じ 30 件で、一覧のボタンの値は操作の綴りと同じである', () => {
    expect(MAX_BULK_WORKS).toBe(MY_WORKS_PER_PAGE);
    expect(MAX_BULK_WORKS).toBe(30);
    expect(BULK_BUTTONS.map((button) => button.action)).toEqual([...BULK_ACTIONS]);
  });

  it('未ログインでは確認画面を開けず、ログインへ送る（戻り先は「あなたの作品」）', async () => {
    const response = await openConfirmation(undefined, 'publish', [crypto.randomUUID()]);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('未ログインでは実行できず、何も書き換えない', async () => {
    const userId = await seedUser();
    const id = await seedGame(userId);
    const { response } = await runBulk(undefined, 'publish', [id]);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect((await readGame(id))?.status).toBe(DRAFT_STATUS);
  });
});

describe('確認画面（#666 の acceptance「確認を通ってから」「名前付きで除外する」）', () => {
  it('開いただけでは何も書き換えない', async () => {
    const userId = await seedUser();
    const draft = await seedGame(userId);
    const published = await seedGame(userId, { status: PUBLISHED_STATUS });
    const cookie = await sessionCookie(userId);
    for (const action of BULK_ACTIONS) {
      expect((await openConfirmation(cookie, action, [draft, published])).status).toBe(200);
    }
    expect((await readGame(draft))?.status).toBe(DRAFT_STATUS);
    expect((await readGame(published))?.status).toBe(PUBLISHED_STATUS);
  });

  it('対象と、対象から外す作品（名前と理由）を並べ、送るフォームには対象だけを入れる', async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const ok = await seedGame(userId, { title: '公開できる作品' });
    const generating = await seedGame(userId, { generationState: 'running', title: '生成中の作品' });
    const failed = await seedGame(userId, { generationState: 'failed', title: '失敗した作品' });
    const already = await seedGame(userId, { status: PUBLISHED_STATUS, title: '公開中の作品' });
    const others = await seedGame(stranger, { title: '他人の作品' });

    const body = pageBodyOf(
      await (await openConfirmation(await sessionCookie(userId), 'publish', [ok, generating, failed, already, others])).text(),
    );
    expect(body).toContain('<h1>選んだ作品を公開しますか</h1>');
    expect(body).toContain('<h2>対象の作品（1 件）</h2>');
    expect(body).toContain('<li><strong>公開できる作品</strong></li>');
    expect(body).toContain('<h2>対象から外す作品（4 件）</h2>');
    expect(body).toContain(`<li><strong>生成中の作品</strong> — ${BULK_REASON_TEXTS.generating}</li>`);
    expect(body).toContain(`<li><strong>失敗した作品</strong> — ${BULK_REASON_TEXTS.failed}</li>`);
    expect(body).toContain(`<li><strong>公開中の作品</strong> — ${BULK_REASON_TEXTS['already-published']}</li>`);
    // **他人の作品は名前を出さない**（件数だけ）。
    expect(body).toContain(`<li>見つからない作品 1 件 — ${BULK_REASON_TEXTS['not-found']}</li>`);
    expect(body).not.toContain('他人の作品');
    // 送るフォームには対象だけ。
    const form = /<form method="post" action="\/api\/works\/bulk">[\s\S]*?<\/form>/u.exec(body)?.[0] ?? '';
    expect(form).toContain(`value="${ok}"`);
    for (const id of [generating, failed, already, others]) {
      expect(form).not.toContain(id);
    }
    expect(form).toContain('<button type="submit" class="gf-button gf-button-secondary">1 件を公開する</button>');
    // 確認画面に主のボタンを置かない（`src/work-delete.ts` の確認画面と同じ判断）。
    expect(body).not.toContain('gf-button-primary');
  });

  it('対象が 1 件も無ければ、実行のボタンを出さない', async () => {
    const userId = await seedUser();
    const generating = await seedGame(userId, { generationState: 'pending', title: '生成中の作品' });
    const body = pageBodyOf(await (await openConfirmation(await sessionCookie(userId), 'publish', [generating])).text());
    expect(body).toContain('<h1>公開することができる作品がありません</h1>');
    expect(body).not.toContain('<form method="post"');
  });

  it('確認の中身を 1 件ずつのときから省かない（公開・下書きへ戻す・削除）', async () => {
    const userId = await seedUser();
    const draft = await seedGame(userId);
    const published = await seedGame(userId, { status: PUBLISHED_STATUS });
    const cookie = await sessionCookie(userId);

    const publish = await (await openConfirmation(cookie, 'publish', [draft])).text();
    // ソースが読めるようになる（1 件ずつの公開フォームと同じ文）・公開をやめても元に戻らないこと。
    expect(publish).toContain(PUBLISH_SOURCE_NOTICE);
    expect(publish).toContain('公開をやめても元に戻らないこと');
    expect(publish).toContain('公開しているあいだにフォークされた作品は、あとで公開をやめても残ります。');

    const unpublish = await (await openConfirmation(cookie, 'unpublish', [published])).text();
    // 試遊 URL が作り直される・画像は撮り直す・フォークは残る（作品ページの「公開をやめる」と同じ事柄）。
    expect(unpublish).toContain('試遊用の URL は新しいものに変わります');
    expect(unpublish).toContain('紹介用の画像は、次に公開したときに撮り直します。');
    expect(unpublish).toContain('そのまま公開されたままです');

    const remove = await (await openConfirmation(cookie, 'delete', [draft])).text();
    // 削除で消えるもの・消えないもの（1 件ずつの確認画面と同じ関数の文）。
    expect(remove).toContain(deletionConsequences('選んだ作品'));
    expect(remove).toContain('<strong>元に戻せません。</strong>');
  });

  it('31 件以上・綴りの違う id・知らない操作は断り、何も書き換えない', async () => {
    const userId = await seedUser();
    const cookie = await sessionCookie(userId);
    const ids = Array.from({ length: MAX_BULK_WORKS + 1 }, () => crypto.randomUUID());
    const tooMany = await openConfirmation(cookie, 'publish', ids);
    expect(tooMany.status).toBe(400);
    expect(await tooMany.text()).toContain(`一度に選べるのは ${MAX_BULK_WORKS} 件までです`);
    expect((await openConfirmation(cookie, 'publish', ['not-a-uuid'])).status).toBe(400);
    expect((await openConfirmation(cookie, 'archive', [crypto.randomUUID()])).status).toBe(400);

    const own = await seedGame(userId);
    const run = await runBulk(cookie, 'publish', [own, ...ids.slice(0, MAX_BULK_WORKS)]);
    expect(run.response.status).toBe(400);
    expect((await readGame(own))?.status).toBe(DRAFT_STATUS);
  });

  it('重ねて選ばれた id は 1 つにまとめる（純関数）', () => {
    const id = crypto.randomUUID();
    const read = readSelection([id, id]);
    expect(read.ok && read.ids).toEqual([id]);
  });
});

describe('実行（#666 の acceptance「選んだ作品にだけ効く」）', () => {
  it('一括の公開は、選んだ作品だけを公開し、撮影を起こし、いま付いているタグを保つ', async () => {
    const userId = await seedUser();
    const chosen = await seedGame(userId, { tags: ['puzzle', 'idle'] });
    const chosen2 = await seedGame(userId);
    const untouched = await seedGame(userId);
    const deps = spies();

    const { response } = await runBulk(await sessionCookie(userId), 'publish', [chosen, chosen2], deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>2 件を公開しました</h1>');
    expect((await readGame(chosen))?.status).toBe(PUBLISHED_STATUS);
    expect((await readGame(chosen2))?.status).toBe(PUBLISHED_STATUS);
    expect((await readGame(untouched))?.status).toBe(DRAFT_STATUS);
    // 撮影と通知は 1 件ずつの口と同じ関数（`runPublish`）が起こす。
    expect(deps.captured.sort()).toEqual([chosen, chosen2].sort());
    expect(deps.notified.sort()).toEqual([chosen, chosen2].sort());
    const row = await readGame(chosen);
    expect([row?.tag1, row?.tag2]).toEqual(['puzzle', 'idle']);
  });

  it('一括で下書きへ戻すと、選んだ作品だけが下書きになり、試遊 URL が作り直される', async () => {
    const userId = await seedUser();
    const chosen = await seedGame(userId, { status: PUBLISHED_STATUS });
    const untouched = await seedGame(userId, { status: PUBLISHED_STATUS });
    const before = await readGame(chosen);

    const { response } = await runBulk(await sessionCookie(userId), 'unpublish', [chosen]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>1 件を下書きに戻しました</h1>');
    const after = await readGame(chosen);
    expect(after?.status).toBe(DRAFT_STATUS);
    expect(after?.preview_key).not.toBe(before?.preview_key);
    expect((await readGame(untouched))?.status).toBe(PUBLISHED_STATUS);
  });

  it('一括の削除は、選んだ作品だけを消す', async () => {
    const userId = await seedUser();
    const chosen = await seedGame(userId, { artifacts: true });
    const failed = await seedGame(userId, { generationState: 'failed' });
    const untouched = await seedGame(userId);

    const { response } = await runBulk(await sessionCookie(userId), 'delete', [chosen, failed]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>2 件を削除しました</h1>');
    expect(await readGame(chosen)).toBeNull();
    expect(await readGame(failed)).toBeNull();
    expect(await env.BUCKET.head(`builds/${chosen}.go`)).toBeNull();
    expect((await readGame(untouched))?.status).toBe(DRAFT_STATUS);
  });

  it('対象外の作品を混ぜて送っても、その作品は書き換えず、名前付きで示す（他人の作品は名前を出さない）', async () => {
    // 確認画面を経ずに POST しても（手で足した id）、判定は同じ所を通る。
    const userId = await seedUser();
    const stranger = await seedUser();
    const ok = await seedGame(userId, { title: '消せる作品' });
    const published = await seedGame(userId, { status: PUBLISHED_STATUS, title: '公開中の作品' });
    const generating = await seedGame(userId, { generationState: 'running', title: '生成中の作品' });
    const others = await seedGame(stranger, { title: '他人の下書き' });

    const { response } = await runBulk(await sessionCookie(userId), 'delete', [ok, published, generating, others]);
    const body = pageBodyOf(await response.text());
    expect(body).toContain('<h1>1 件を削除しました（3 件はできませんでした）</h1>');
    expect(body).toContain(`<li><strong>公開中の作品</strong> — ${BULK_REASON_TEXTS.published}</li>`);
    expect(body).toContain(`<li><strong>生成中の作品</strong> — ${BULK_REASON_TEXTS.generating}</li>`);
    expect(body).toContain(`<li>見つからない作品 1 件 — ${BULK_REASON_TEXTS['not-found']}</li>`);
    expect(body).not.toContain('他人の下書き');
    expect(await readGame(ok)).toBeNull();
    expect((await readGame(published))?.status).toBe(PUBLISHED_STATUS);
    expect((await readGame(generating))?.status).toBe(DRAFT_STATUS);
    expect((await readGame(others))?.status).toBe(DRAFT_STATUS);
  });

  it('他人の作品は、公開も下書きへ戻すもできない', async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const draft = await seedGame(stranger);
    const published = await seedGame(stranger, { status: PUBLISHED_STATUS });
    const cookie = await sessionCookie(userId);
    await runBulk(cookie, 'publish', [draft]);
    await runBulk(cookie, 'unpublish', [published]);
    expect((await readGame(draft))?.status).toBe(DRAFT_STATUS);
    expect((await readGame(published))?.status).toBe(PUBLISHED_STATUS);
  });

  it('知らない形式の本文は断る（415）', async () => {
    const userId = await seedUser();
    const response = await dispatch(
      createWorksBulkRoutes(),
      new Request(`${APP_ORIGIN}${WORKS_BULK_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await sessionCookie(userId) },
        body: '{}',
      }),
      testEnv(),
    );
    expect(response.status).toBe(415);
  });
});

describe('往復に分ける（Workers Free の D1 の枠。1 呼び出し 50 文）', () => {
  /** 操作ごとの最悪の形（30 件）。 */
  const worst: Readonly<Record<BulkAction, SeedGame>> = {
    // 公開はフォーク（親の数え直しが実際に 1 行を書く）で、通知の 3 文も数える（`spies`）。
    publish: {},
    unpublish: { status: PUBLISHED_STATUS },
    // 削除は成果物・版・R2 の実体を持つ作品（`deleteGame` がいちばん多く文を打つ形）。
    delete: { artifacts: true },
  };

  for (const action of BULK_ACTIONS) {
    it(`${action}: 30 件を、どの往復も ${D1_QUERY_LIMIT} 文以内・16 往復以内で処理しきる`, async () => {
      const userId = await seedUser();
      const parentAuthor = await seedUser();
      const parent = await seedGame(parentAuthor, { status: PUBLISHED_STATUS });
      const ids: string[] = [];
      for (let i = 0; i < MAX_BULK_WORKS; i += 1) {
        ids.push(await seedGame(userId, { ...worst[action], parentId: parent }));
      }
      const run = await runBulk(await sessionCookie(userId), action, ids);
      expect(run.response.status).toBe(200);
      expect(run.steps).toBe(Math.ceil(MAX_BULK_WORKS / BULK_STEP_SIZES[action]));
      expect(run.steps).toBeLessThanOrEqual(15);
      expect(Math.max(...run.statements), run.statements.join(',')).toBeLessThanOrEqual(D1_QUERY_LIMIT);
      expect(await run.response.text()).toContain(`<h1>${MAX_BULK_WORKS} 件を`);
      const expected = action === 'publish' ? PUBLISHED_STATUS : DRAFT_STATUS;
      for (const id of ids) {
        const row = await readGame(id);
        expect(action === 'delete' ? row : row?.status).toBe(action === 'delete' ? null : expected);
      }
    }, 30_000);
  }

  it('最初の往復で外した作品も、最後の画面に名前付きで出る（外した作品は往復の数に入らない）', async () => {
    const userId = await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await seedGame(userId, i === 0 ? { status: PUBLISHED_STATUS, title: '最初の公開中の作品' } : {}));
    }
    const run = await runBulk(await sessionCookie(userId), 'delete', ids);
    // 公開中の 1 件は最初の往復で外し、残り 4 件を 2 件ずつ 2 往復で処理する。
    expect(run.steps).toBe(2);
    const body = await run.response.text();
    expect(body).toContain('<h1>4 件を削除しました（1 件はできませんでした）</h1>');
    expect(body).toContain(`<li><strong>最初の公開中の作品</strong> — ${BULK_REASON_TEXTS.published}</li>`);
  });

  it('URL を書き換えても成功は偽れない——成功の件数は D1 の状態から数える（PR #669 の Copilot code review）', async () => {
    const userId = await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await seedGame(userId, { title: `作品${i}` }));
    }
    const cookie = await sessionCookie(userId);
    // 以前の形（`step` と `done`）で先頭 2 件を済んだことにしても、読まない。4 件とも実際に処理して数える。
    const old = await runBulk(cookie, 'delete', ids, spies(), `${APP_ORIGIN}${WORKS_BULK_API_PATH}?step=1&done=2`);
    expect(await old.response.text()).toContain('<h1>4 件を削除しました</h1>');
    for (const id of ids) {
      expect(await readGame(id)).toBeNull();
    }

    // 控え（`ng`）を書き足して先頭を飛ばしても、飛ばした作品は書き換わらず、失敗として名前付きで出る。
    const more: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      more.push(await seedGame(userId, { title: `別の作品${i}` }));
    }
    const forged = `${APP_ORIGIN}${WORKS_BULK_API_PATH}?${BULK_CONTINUE_PARAM}=1&${BULK_FAILED_PARAM}=0.busy&${BULK_FAILED_PARAM}=1.busy`;
    const skipped = await runBulk(cookie, 'delete', more, spies(), forged);
    const body = await skipped.response.text();
    expect(body).toContain('<h1>2 件を削除しました（2 件はできませんでした）</h1>');
    expect(body).toContain(`<li><strong>別の作品0</strong> — ${BULK_REASON_TEXTS.busy}</li>`);
    expect((await readGame(more[0]!))?.status).toBe(DRAFT_STATUS);
    expect((await readGame(more[1]!))?.status).toBe(DRAFT_STATUS);
    expect(await readGame(more[2]!)).toBeNull();

    // 読めない控えは断り、何もしない。
    const bad = await runBulk(cookie, 'delete', [ids[0]!], spies(), `${APP_ORIGIN}${WORKS_BULK_API_PATH}?${BULK_FAILED_PARAM}=9.busy`);
    expect(bad.response.status).toBe(400);
  });

  it('確認画面を経ずに、もう目的の状態にある作品を送っても、成功に数えない', async () => {
    const userId = await seedUser();
    const published = await seedGame(userId, { status: PUBLISHED_STATUS, title: 'もう公開中の作品' });
    const missing = crypto.randomUUID();
    const { response } = await runBulk(await sessionCookie(userId), 'publish', [published]);
    expect(await response.text()).toContain(`<li><strong>もう公開中の作品</strong> — ${BULK_REASON_TEXTS['already-published']}</li>`);
    // 行の無い id の削除は「消した」ではなく「見つからない」。
    const gone = await runBulk(await sessionCookie(userId), 'delete', [missing]);
    const body = await gone.response.text();
    expect(body).toContain('<h1>削除することができませんでした</h1>');
    expect(body).toContain(`<li>見つからない作品 1 件 — ${BULK_REASON_TEXTS['not-found']}</li>`);
  });

  it('控えの読み書き（純関数）', () => {
    const url = (search: string): URL => new URL(`${APP_ORIGIN}${WORKS_BULK_API_PATH}${search}`);
    expect(readFailures(url(''), 5)).toEqual(new Map());
    const failed = new Map([[1, 'published' as const], [0, 'busy' as const]]);
    const path = nextStepPath(failed);
    expect(path).toBe(`${WORKS_BULK_API_PATH}?${BULK_CONTINUE_PARAM}=1&${BULK_FAILED_PARAM}=0.busy&${BULK_FAILED_PARAM}=1.published`);
    expect(readFailures(url(path.slice(WORKS_BULK_API_PATH.length)), 5)).toEqual(failed);
    for (const bad of [
      `?${BULK_FAILED_PARAM}=5.busy`,
      `?${BULK_FAILED_PARAM}=0.unknown`,
      `?${BULK_FAILED_PARAM}=0.busy&${BULK_FAILED_PARAM}=0.busy`,
      `?${BULK_FAILED_PARAM}=01.busy`,
      `?${BULK_FAILED_PARAM}=busy`,
    ]) {
      expect(readFailures(url(bad), 5), bad).toBeNull();
    }
  });
});

describe('例外とタグ（PR #669 の Copilot code review）', () => {
  it('公開の後の処理（通知）が投げても、公開できた作品は成功に数え、後の処理の失敗を名前付きで示す', async () => {
    const userId = await seedUser();
    const id = await seedGame(userId, { title: '通知で落ちる作品' });
    const deps = spies();
    const throwing: Spies = { ...deps, notify: async () => { throw new Error('通知の不調を模した失敗'); } };
    const { response } = await runBulk(await sessionCookie(userId), 'publish', [id], throwing);
    const body = await response.text();
    expect(body).toContain('<h1>1 件を公開しました</h1>');
    expect(body).toContain('<h2>後の処理に失敗した作品（1 件）</h2>');
    expect(body).toContain('<li><strong>通知で落ちる作品</strong></li>');
    expect((await readGame(id))?.status).toBe(PUBLISHED_STATUS);
  });

  it('行を書き換える前に投げたら、失敗として名前付きで示す', async () => {
    const userId = await seedUser();
    const id = await seedGame(userId, { status: PUBLISHED_STATUS, title: '戻せない作品' });
    const failing = { ...testEnv() };
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('update games as g')) {
              throw new Error('D1 の不調を模した失敗');
            }
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const body = new URLSearchParams({ [WORKS_BULK_ACTION_FIELD]: 'unpublish', [WORKS_BULK_GAME_ID_FIELD]: id });
    const response = await dispatch(
      createWorksBulkRoutes(spies().start, spies().notify),
      new Request(`${APP_ORIGIN}${WORKS_BULK_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: await sessionCookie(userId) },
        body: body.toString(),
      }),
      { ...failing, DB: db } as Env,
    );
    const text = await response.text();
    expect(text).toContain('<h1>下書きに戻すことができませんでした</h1>');
    expect(text).toContain(`<li><strong>戻せない作品</strong> — ${BULK_REASON_TEXTS.error}</li>`);
    expect((await readGame(id))?.status).toBe(PUBLISHED_STATUS);
  });

  it('語彙に無いタグが付いた作品は、黙ってタグを落とさず、確認画面でも実行でも名前付きで外す', async () => {
    const userId = await seedUser();
    const id = await seedGame(userId, { title: '古いタグの作品', tags: ['puzzle', 'retired-tag'] });
    const cookie = await sessionCookie(userId);
    const confirm = await (await openConfirmation(cookie, 'publish', [id])).text();
    expect(confirm).toContain(`<li><strong>古いタグの作品</strong> — ${BULK_REASON_TEXTS.tags}</li>`);
    const { response } = await runBulk(cookie, 'publish', [id]);
    expect(await response.text()).toContain(`<li><strong>古いタグの作品</strong> — ${BULK_REASON_TEXTS.tags}</li>`);
    const row = await readGame(id);
    expect(row?.status).toBe(DRAFT_STATUS);
    expect([row?.tag1, row?.tag2]).toEqual(['puzzle', 'retired-tag']);
  });
});

describe('表示の条件と、1 件ずつの関数が同じ結論を出す（1 件ずつなら許されない操作は一括でも許さない）', () => {
  /** 状態の組み合わせ。 */
  const shapes: readonly SeedGame[] = [
    { status: DRAFT_STATUS, generationState: 'ready' },
    { status: DRAFT_STATUS, generationState: 'pending' },
    { status: DRAFT_STATUS, generationState: 'running' },
    { status: DRAFT_STATUS, generationState: 'failed' },
    { status: PUBLISHED_STATUS, generationState: 'ready' },
    { status: 'removed', generationState: 'ready' },
  ];

  /**
   * 1 件ずつの関数を呼び、書き換えが起きたかを返す。
   *
   * @param action 操作
   * @param id 作品 id
   * @param userId 操作している利用者
   * @returns 書き換えたなら true
   */
  async function applied(action: BulkAction, id: string, userId: string): Promise<boolean> {
    switch (action) {
      case 'publish': {
        const outcome = await publishGame(env, id, userId);
        return outcome.ok && outcome.firstTime;
      }
      case 'unpublish': {
        const outcome = await unpublishGame(env, id, userId);
        return outcome.ok && outcome.firstTime;
      }
      case 'delete':
        return (await deleteAuthoredGame(env, id, userId)).ok;
    }
  }

  for (const action of BULK_ACTIONS) {
    it(`${action}: 表示の条件が通す作品だけを、1 件ずつの関数も書き換える`, async () => {
      const userId = await seedUser();
      const stranger = await seedUser();
      for (const shape of shapes) {
        for (const owner of [userId, stranger]) {
          const id = await seedGame(owner, shape);
          const row = await env.DB.prepare(bulkTargetsSql(1)).bind(id).first<BulkTargetRow>();
          const allowed = bulkBlockOf(action, row, userId) === null;
          expect(await applied(action, id, userId), `${JSON.stringify(shape)} / 作者=${owner === userId}`).toBe(allowed);
        }
      }
    });
  }

  it('削除の表示の条件は、行の無い作品を「見つからない」にする（`deleteGame` は無い id にも成功を返す）', async () => {
    const userId = await seedUser();
    const missing = crypto.randomUUID();
    expect(bulkBlockOf('delete', null, userId)).toBe('not-found');
    expect((await deleteGame(env, missing)).ok).toBe(true);
    expect(await deleteAuthoredGame(env, missing, userId)).toEqual({ ok: false, reason: 'not-found' });
  });
});
