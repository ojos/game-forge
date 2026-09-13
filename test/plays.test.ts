import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS } from '../src/games.js';
import {
  PLAYABLE_GAME_SQL,
  PLAY_GAME_ID_FIELD,
  PLAY_HUB_NAME,
  PLAY_PATH,
  PLAY_REPORT_WINDOW_MS,
  playReportScript,
  playReportStorageKey,
  shouldReportPlay,
} from '../src/plays.js';
import { findDuplicateRoutes } from '../src/routes.js';
import { LOADER_STARTED_MESSAGE } from '../src/sandbox-loader.js';
import type { PlayHub } from '../workers/likes/src/play-hub.js';
import { applySchema } from './helpers/schema.js';

/**
 * プレイ数の窓口（`src/plays.ts`。#377）。**経路表を通して叩く。**
 *
 * issue #377 の acceptance のうち、窓口が持つものを機械判定できる形へ落とす。
 *
 * - **連打を畳む規則が効く**（{@link shouldReportPlay}。作品ページのスクリプトへそのまま埋め込む）
 * - **D1 への都度書き込みが 1 本も増えていない**（経路の検査。`test/likes.test.ts` と同じ形で、
 *   env の `DB` を記録つきに差し替え、計上の経路が発行した SQL をすべて取る）
 * - 数えるのは公開済みの作品だけで、`draft` / `removed` / 存在しない作品は DO に届かない
 * - 未ログインでも数える
 *
 * **OGP の撮影を数えないこと**は、ローダーが親の無い起動で合図を送らないこと
 * （`test/sandbox.test.ts`）と、合図を受けるのが作品ページの iframe だけであること
 * （`test/work-page.test.ts`）の 2 つで見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

/** 書き込みの文（`with` で始まる書き込みも見逃さないよう、語で探す）。 */
const WRITE_STATEMENT = /\b(insert|update|delete|replace|create|drop|alter)\b/iu;

beforeAll(async () => {
  await applySchema();
});

/** 計上の経路が D1 に対して行ったこと。 */
interface D1Record {
  /** `prepare` に渡された SQL。 */
  readonly statements: string[];
  /** `run` / `all` が返した `rows_written` の合計。 */
  rowsWritten: number;
  /** `batch` / `exec` / `dump` を呼んだ回数。 */
  bulkCalls: number;
}

/**
 * 記録つきの D1 を作る（`test/likes.test.ts` の `recordingDb` と同じ形）。
 *
 * @param db 本物の D1
 * @returns 差し替える D1 と、記録
 */
function recordingDb(db: D1Database): { db: D1Database; record: D1Record } {
  const record: D1Record = { statements: [], rowsWritten: 0, bulkCalls: 0 };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === 'run' || property === 'all') {
          return async () => {
            const result = await target[property]();
            record.rowsWritten += result.meta.rows_written ?? 0;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          record.statements.push(query);
          return wrapStatement(target.prepare(query));
        };
      }
      if (property === 'batch' || property === 'exec' || property === 'dump') {
        record.bulkCalls += 1;
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, record };
}

/**
 * 作品を 1 件用意する。
 *
 * @param status 公開状態
 * @returns 作品の id
 */
async function seedGame(status: string = PUBLISHED_STATUS): Promise<string> {
  const authorId = `plays-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(authorId, `sub-${authorId}`, `${authorId}@example.com`, 'プレイ数の窓口')
    .run();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games (id, author_id, status, title, go_version, created_at, generation_state,
                        published_at)
     values (?, ?, ?, '題', '', 1, 'ready', 1)`,
  )
    .bind(id, authorId, status)
    .run();
  return id;
}

/**
 * 窓口が数えた DO の累計を読む（窓口と同じ名前の DO）。
 *
 * @param gameId 作品
 * @returns 累計
 */
async function hubCount(gameId: string): Promise<number> {
  return await (env.PLAY_HUB as unknown as DurableObjectNamespace<PlayHub>)
    .getByName(PLAY_HUB_NAME)
    .playCount(gameId);
}

/**
 * 計上の口を叩く。
 *
 * @param body 本文（文字列ならそのまま送る）
 * @param options 差し替える env と `Content-Type`
 * @returns レスポンス
 */
async function postPlay(
  body: unknown,
  options: { readonly env?: Env; readonly contentType?: string } = {},
): Promise<Response> {
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${PLAY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': options.contentType ?? 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    options.env ?? env,
  );
}

describe('連打を畳む規則（#377）', () => {
  const now = 1_800_000_000_000;

  it('記録が無い・読めないときは数える', () => {
    expect(shouldReportPlay(null, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
    expect(shouldReportPlay(Number.NaN, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
    expect(shouldReportPlay(Number.POSITIVE_INFINITY, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
  });

  it('窓の内側では数えず、窓を過ぎたら数える', () => {
    expect(shouldReportPlay(now, now, PLAY_REPORT_WINDOW_MS)).toBe(false);
    expect(shouldReportPlay(now - 1, now, PLAY_REPORT_WINDOW_MS)).toBe(false);
    expect(shouldReportPlay(now - PLAY_REPORT_WINDOW_MS + 1, now, PLAY_REPORT_WINDOW_MS)).toBe(false);
    expect(shouldReportPlay(now - PLAY_REPORT_WINDOW_MS, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
    expect(shouldReportPlay(now - PLAY_REPORT_WINDOW_MS * 10, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
  });

  it('記録が未来（端末の時計が戻った）なら数える（窓に閉じ込めない）', () => {
    expect(shouldReportPlay(now + 60_000, now, PLAY_REPORT_WINDOW_MS)).toBe(true);
  });

  it('窓は 30 分である', () => {
    expect(PLAY_REPORT_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('スクリプトは規則の関数をそのまま埋め込み、窓の長さで呼ぶ（書き写さない）', () => {
    const gameId = crypto.randomUUID();
    const script = playReportScript(gameId);
    const source = String(shouldReportPlay);
    // **テストが確かめた関数と、ブラウザで動く関数が同じ 1 つである。**
    expect(script).toContain(`var shouldReport = ${source};`);
    expect(script).toContain(`shouldReport(last, now, ${PLAY_REPORT_WINDOW_MS})`);
    // **窓の内側なら要求を出さない**（判定の後ろに fetch がある）。
    expect(script.indexOf('if (!shouldReport(')).toBeLessThan(script.indexOf('fetch('));
    // 鍵は作品ごと。記録するのは sessionStorage で、Cookie を足さない。
    expect(script).toContain(JSON.stringify(playReportStorageKey(gameId)));
    expect(script).toContain('window.sessionStorage.setItem(storageKey, String(now))');
    expect(script).not.toContain('document.cookie');
    expect(script).not.toContain('localStorage');
    // 埋め込む本文がブラウザで単独で動く形である（束ねる工程の補助呼び出しが入っていない）。
    expect(source).toMatch(/^function shouldReportPlay\(/u);
    expect(source).not.toContain('__name');
  });

  it('スクリプトは自分の iframe から届いた起動の合図だけを受け、1 ページで 1 回しか送らない', () => {
    const script = playReportScript(crypto.randomUUID());
    // **束縛の本体は source の一致である**（不透明オリジンなので origin は 'null' で、他の
    // sandbox の iframe と区別できない）。
    expect(script).toContain("event.source !== frame.contentWindow || event.origin !== 'null'");
    expect(script).toContain(`event.data !== ${JSON.stringify(LOADER_STARTED_MESSAGE)}`);
    expect(script).toContain("document.querySelector('iframe.gf-frame')");
    expect(script).toContain('reported = true;');
    // 未ログインも数える（cookie を送らない）。送り先は計上の口。
    expect(script).toContain("credentials: 'omit'");
    expect(script).toContain(`fetch(${JSON.stringify(PLAY_PATH)}`);
  });

  it('形の不正な作品 id ではスクリプトを出さない（埋め込みの安全は埋め込む側で閉じる）', () => {
    expect(playReportScript('</script><script>alert(1)</script>')).toBe('');
    expect(playReportScript('')).toBe('');
  });
});

describe('計上の口（#377）', () => {
  it('経路表に 1 本だけ登録されている', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(routes.filter((route) => route.path === PLAY_PATH).map((route) => route.method)).toEqual([
      'POST',
    ]);
  });

  it('公開済みの作品を未ログインで数える（204）', async () => {
    const game = await seedGame();
    const before = await hubCount(game);

    const response = await postPlay({ [PLAY_GAME_ID_FIELD]: game });

    expect(response.status).toBe(204);
    expect(await hubCount(game)).toBe(before + 1);
  });

  it('D1 への都度書き込みが 1 本も無い（主キーで 1 行を読むだけ）', async () => {
    const game = await seedGame();
    const { db, record } = recordingDb(env.DB);
    const rowBefore = await env.DB.prepare('select * from games where id = ?').bind(game).first();

    const response = await postPlay({ [PLAY_GAME_ID_FIELD]: game }, { env: { ...env, DB: db } });

    expect(response.status).toBe(204);
    // **発行した SQL は「数えてよい作品か」の 1 本だけ**で、書き込みの文も一括の呼び出しも無い。
    expect(record.statements).toEqual([PLAYABLE_GAME_SQL]);
    expect(record.statements.filter((sql) => WRITE_STATEMENT.test(sql))).toEqual([]);
    expect(record.bulkCalls).toBe(0);
    expect(record.rowsWritten).toBe(0);
    // **DO の側も計上の途中で D1 へ書いていない**（DO は差し替えていない本物の DB を持つので、
    // 行そのものを前後で比べる。書くのは 5 分おきの同期だけである）。
    const rowAfter = await env.DB.prepare('select * from games where id = ?').bind(game).first();
    expect(rowAfter).toEqual(rowBefore);
  });

  it('数えてよいかの判定は主キーで引く（全表走査しない）', async () => {
    const plan = await env.DB.prepare(`explain query plan ${PLAYABLE_GAME_SQL}`)
      .bind(crypto.randomUUID(), PUBLISHED_STATUS)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');
    expect(detail, detail).toMatch(/SEARCH games USING INDEX sqlite_autoindex_games_1 \(id=\?\)/u);
    expect(detail, detail).not.toMatch(/SCAN games/u);
  });

  it('draft・removed・存在しない作品は 404 で、DO に届かない（理由を区別しない）', async () => {
    for (const game of [
      await seedGame(DRAFT_STATUS),
      await seedGame(REMOVED_STATUS),
      crypto.randomUUID(),
    ]) {
      const response = await postPlay({ [PLAY_GAME_ID_FIELD]: game });
      expect(response.status, game).toBe(404);
      expect(await response.json()).toEqual({ error: 'not-found' });
      expect(await hubCount(game), game).toBe(0);
    }
  });

  it('本文の形が違えば、D1 も DO も触らずに断る', async () => {
    const { db, record } = recordingDb(env.DB);
    const recordingEnv = { ...env, DB: db } as Env;

    expect((await postPlay({ [PLAY_GAME_ID_FIELD]: 'not-a-uuid' }, { env: recordingEnv })).status).toBe(400);
    expect((await postPlay({}, { env: recordingEnv })).status).toBe(400);
    expect((await postPlay('{', { env: recordingEnv })).status).toBe(400);
    expect(
      (
        await postPlay(`${PLAY_GAME_ID_FIELD}=${crypto.randomUUID()}`, {
          env: recordingEnv,
          contentType: 'application/x-www-form-urlencoded',
        })
      ).status,
    ).toBe(415);
    expect((await postPlay('x'.repeat(2048), { env: recordingEnv })).status).toBe(413);
    expect(record.statements).toEqual([]);
  });

  it('DO へ届かなければ 503 を返し、例外で落とさない（数え漏れを許す）', async () => {
    const game = await seedGame();
    const broken = {
      ...env,
      PLAY_HUB: {
        getByName() {
          throw new Error('DO の枠が尽きた');
        },
      },
    } as unknown as Env;

    const response = await postPlay({ [PLAY_GAME_ID_FIELD]: game }, { env: broken });
    expect(response.status).toBe(503);
  });

  it('GET では数えない', async () => {
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${PLAY_PATH}`), env);
    expect(response.status).toBe(405);
  });
});
