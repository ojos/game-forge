import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH, OAUTH_COOKIE } from '../src/auth/google.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS, UNTITLED_TITLE } from '../src/games.js';
import { DEFAULT_GENERATION_MODEL_KEY } from '../src/generation-models.js';
import {
  DAILY_QUOTA_MESSAGE_KEY,
  GENERATE_MESSAGES,
  remainingQuotaNotice,
} from '../src/generate-page.js';
import {
  EMPTY_MY_WORKS_STATS,
  LIKES_DELAY_NOTE,
  PLAYS_SINCE_NOTE,
  STATS_UNAVAILABLE_NOTICE,
  STAT_CARDS,
  loadMyWorksStats,
  myWorksStatsBinds,
  myWorksStatsSql,
  renderMyWorksStats,
} from '../src/my-works-stats.js';
import { GENERATE_PAGE_PATH } from '../src/paths.js';
import { DAILY_QUOTA_PER_USER } from '../src/quota.js';
import { HOME_PATH } from '../src/home.js';
import { formatJstMinutes, toIsoTimestamp } from '../src/jst.js';
import {
  MAX_LISTED_WORKS,
  MY_WORKS_PATH,
  displayTitleOf,
  rowStateOf,
} from '../src/my-works.js';
import { LIKED_WORKS_PATH } from '../src/liked-works-paths.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { PUBLIC_WORKS_PATH } from '../src/works-list.js';
import { STALE_AFTER_SECONDS, WORK_PAGE_PREFIX, workPagePath } from '../src/work-page.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 「あなたの作品」一覧（#152）。
 *
 * **#152 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. ログイン済みで開くと自分の作品が新しい順に出る
 * 2. **他人の draft が出ない**
 * 3. 生成中の作品が一覧に出て、そこから URL へ辿れる
 *
 * 2 は `test/games.test.ts` が引く層で押さえており、ここでは**画面まで通した経路**で
 * 重ねて確かめる。層を 1 つに絞らないのは、絞り込みが SQL から画面側へ移された場合に
 * （それ自体が防ぎたい変更である）引く層のテストだけが落ちる形にしたいためである。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-my-works-list-1';

/**
 * セッションの秘密だけを差し替えた env。
 *
 * @returns 差し替えた env
 */
function testEnv(): Env {
  return { ...env, SESSION_SECRET: SECRET };
}

beforeAll(async () => {
  await applySchema();
});

/**
 * 利用者を 1 人用意する。
 *
 * id を毎回ランダムにするのは、`games` が他のテストファイルとも共有されるためである。
 * 作者を一意にしておけば、一覧の絞り込みがそのままテストの独立性になる。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `works-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, id)
    .run();
  return id;
}

/**
 * `games` の行を 1 件入れる。
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
    readonly forkCount?: number;
    readonly likeCount?: number;
    /** `games.play_count`（#377）。 */
    readonly playCount?: number;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state, fork_count, like_count,
        play_count)
     values (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? DRAFT_STATUS,
      overrides.title ?? 'タイトル',
      overrides.createdAt ?? Math.floor(Date.now() / 1000),
      overrides.generationState ?? 'ready',
      overrides.forkCount ?? 0,
      overrides.likeCount ?? 0,
      overrides.playCount ?? 0,
    )
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * 失効時刻は実時刻から取る（固定値にすると、その時刻を過ぎた日から落ちる時限式の
 * テストになる。`test/invite-issuance.test.ts` と同じ理由）。
 *
 * @param userId 利用者の id
 * @returns `Cookie` ヘッダの値
 */
async function sessionCookie(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 一覧を開く。
 *
 * **経路表を通す。** ハンドラを直接呼ぶと、`src/app.ts` への登録漏れを見逃す。
 *
 * @param cookie `Cookie` ヘッダ（未ログインなら省略）
 * @returns レスポンス
 */
async function openList(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${MY_WORKS_PATH}`, { headers }),
    testEnv(),
  );
}

describe('経路の登録（#152）', () => {
  it('「あなたの作品」は作品ページと同じ接頭辞の下にある（#328 で移した）', () => {
    // 綴りを 2 か所に書かない決定を、導出の結果として固定する。
    expect(MY_WORKS_PATH.startsWith(WORK_PAGE_PREFIX)).toBe(true);
    // **親の位置は公開作品の一覧が取った**（#328 / 仕様 2.3.2）。「URL を 1 本でも
    // 覚えている人が末尾を削るだけで一覧に着く」（#152）は失われていない——
    // 着く先が、共有 URL を踏んだ未ログインの閲覧者にとって意味のある行き先になった。
    expect(WORK_PAGE_PREFIX).toBe(`${PUBLIC_WORKS_PATH}/`);
  });

  it('経路表に登録されていて、重複も綴り違いも無い', () => {
    const routes = createAppRoutes(env);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain(
      `GET ${MY_WORKS_PATH}`,
    );
    // 完全一致の `/works` と前方一致の `/works/` は別の鍵になる（`src/routes.ts`）。
    expect(findDuplicateRoutes(routes)).toEqual([]);
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
  });

  it('作品ページの前方一致に飲み込まれない', async () => {
    // `/works` は前方一致 `/works/` に一致しないが、**登録順や一致規則を変えた瞬間に
    // 一覧が 404 になる**ため、実際に引いて確かめる。
    const response = await openList();
    expect(response.status).not.toBe(404);
  });
});

describe('ログインの要求（#152）', () => {
  it('未ログインならログインへ送る', async () => {
    const response = await openList();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });

  it('ログインへ送るときに、戻り先を署名付きの一時 cookie へ積む（2.3.11 / #374）', async () => {
    // 戻り先は query へ出さない（オープンリダイレクトの入口を作らない）。着地まで
    // 通す検査は `test/auth-google.test.ts` が持つ。
    const response = await openList();
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${OAUTH_COOKIE}=`))).toBe(
      true,
    );
  });

  it('未ログインの応答に作品の id が 1 つも載らない', async () => {
    const author = await seedUser();
    const gameId = await seedGame(author);
    const body = await (await openList()).text();
    expect(body).not.toContain(gameId);
  });

  it('BAN された利用者には出さない', async () => {
    // 判定は `resolveSessionUser` が持つ（署名だけを信じない）。一覧がその判定を
    // 迂回していないことを見る。
    const userId = await seedUser();
    await seedGame(userId);
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(userId).run();

    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(LOGIN_PATH);
  });
});

describe('他人の draft が出ない（#152 acceptance 2）', () => {
  it('別の利用者の作品は id もタイトルも出ない', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    const myGame = await seedGame(mine, { title: '自分の作品' });
    // 他人の側は「生成中」「完成」の両方を置く。**どちらも draft である**
    // （公開の操作は M4-1 / #26 が持ち、未実装。5.4）。
    const theirReady = await seedGame(theirs, { title: '他人の完成した下書き' });
    const theirPending = await seedGame(theirs, {
      title: '他人の生成中',
      generationState: 'pending',
    });

    const body = await (await openList(await sessionCookie(mine))).text();
    expect(body).toContain(myGame);
    expect(body).toContain('自分の作品');
    expect(body).not.toContain(theirReady);
    expect(body).not.toContain(theirPending);
    expect(body).not.toContain('他人の完成した下書き');
    expect(body).not.toContain('他人の生成中');
  });

  it('作品を 1 件も持たない利用者には空の一覧を出す', async () => {
    // 他人の作品があるときに、**それが 0 件の利用者の一覧へ漏れない**ことを見る。
    const stranger = await seedUser();
    const other = await seedUser();
    const otherGame = await seedGame(other, { title: '無関係な作品' });

    const body = await (await openList(await sessionCookie(stranger))).text();
    expect(body).toContain('まだ作品がありません');
    expect(body).not.toContain(otherGame);
    expect(body).not.toContain('無関係な作品');
  });
});

describe('一覧の中身（#152 acceptance 1・3）', () => {
  it('自分の作品が新しい順に出る', async () => {
    const userId = await seedUser();
    const oldest = await seedGame(userId, { createdAt: 1_700_000_000 });
    const middle = await seedGame(userId, { createdAt: 1_700_000_100 });
    const newest = await seedGame(userId, { createdAt: 1_700_000_200 });

    const body = await (await openList(await sessionCookie(userId))).text();
    const positions = [newest, middle, oldest].map((id) => body.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('生成中の作品が出て、そこから作品の URL へ辿れる', async () => {
    const userId = await seedUser();
    const pending = await seedGame(userId, { generationState: 'pending' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain(`href="${workPagePath(pending)}"`);
    expect(body).toContain('生成中');
  });

  it('状態ごとの札が出る', async () => {
    const userId = await seedUser();
    await seedGame(userId, { generationState: 'ready' });
    await seedGame(userId, { generationState: 'failed' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain('できました');
    expect(body).toContain('生成できませんでした');
  });

  it('長く動いていない生成は「時間がかかっています」と出す', async () => {
    // 閾値の判断は `src/work-page.ts` の `looksStalled` を共有する（文言だけが別）。
    const userId = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    await seedGame(userId, {
      generationState: 'running',
      createdAt: now - STALE_AFTER_SECONDS - 60,
    });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain('時間がかかっています');
  });

  it('生成日時が機械可読な形と日本時間の両方で出る', async () => {
    // **「もうすぐ消える」を出さない代わりに置いている事実である**（`src/my-works.ts`）。
    // 14 日の掃除（3.7 / 確定13）は M5-4（#35）が未着手で、残り日数を出すと
    // 動いていない削除を動いているように書くことになる。
    const userId = await seedUser();
    await seedGame(userId, { createdAt: 1_700_000_000 });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain('datetime="2023-11-14T22:13:20.000Z"');
    expect(body).toContain('2023-11-15 07:13');
  });

  it('タイトルを HTML へそのまま入れない', async () => {
    // 仮タイトルはプロンプト由来の利用者入力である（`draftTitleFromPrompt`）。
    const userId = await seedUser();
    await seedGame(userId, { title: '<script>alert(1)</script>' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('removed は一覧に出ない', async () => {
    const userId = await seedUser();
    const removed = await seedGame(userId, { status: 'removed', title: '取り下げた作品' });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).not.toContain(removed);
    expect(body).not.toContain('取り下げた作品');
  });
});

describe('件数の上限（#152 constraints）', () => {
  it('上限を超えると切り、切ったことを画面に出す', async () => {
    const userId = await seedUser();
    const ids: string[] = [];
    for (let index = 0; index <= MAX_LISTED_WORKS; index += 1) {
      ids.push(await seedGame(userId, { createdAt: 1_600_000_000 + index }));
    }

    const body = await (await openList(await sessionCookie(userId))).text();
    const shown = ids.filter((id) => body.includes(id));
    expect(shown).toHaveLength(MAX_LISTED_WORKS);
    // 落ちるのは**いちばん古い 1 件**である。
    expect(shown).not.toContain(ids[0]);
    expect(body).toContain(`新しい ${MAX_LISTED_WORKS} 件`);
  });

  it('上限ちょうどでは「切った」と言わない', async () => {
    // 1 件多く引いているのは、この 2 つを区別するためである。区別せずに注記を出すと
    // **溢れていないのに溢れたと言う**ことになる。
    const userId = await seedUser();
    for (let index = 0; index < MAX_LISTED_WORKS; index += 1) {
      await seedGame(userId, { createdAt: 1_600_000_000 + index });
    }

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).not.toContain(`新しい ${MAX_LISTED_WORKS} 件`);
  });
});

describe('索引（migrations/0008）', () => {
  it('一覧の問い合わせが索引を使い、並べ替えのための一時 B-tree を作らない', async () => {
    // **索引が「存在すること」を見ない。** 存在の検査は、索引を使えない形へ問い合わせを
    // 書き換えても通る。ここで見たいのは「この問い合わせが実際にそれを使うか」である
    // （shared-ai-rules 12 章）。
    const plan = await env.DB.prepare(
      `explain query plan
       select id, title, generation_state, created_at, generation_started_at
         from games
        where author_id = ? and status <> 'removed'
        order by created_at desc, id desc
        limit ?`,
    )
      .bind('someone', 1)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');

    expect(detail).toContain('games_author_id_created_at_idx');
    // 一時 B-tree が出るなら、`limit` があっても**その作者の全行を読んでから並べている**。
    expect(detail).not.toContain('TEMP B-TREE');
  });
});

describe('トップからの導線（#152 goal）', () => {
  it('公開トップから一覧へ辿れる', async () => {
    // 導線が無ければ「その URL を知っている人だけが使える一覧」になり、#152 が
    // 解こうとしている問題をそのまま繰り返す。
    const body = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), env)
    ).text();
    expect(body).toContain(`href="${MY_WORKS_PATH}"`);
  });
});

describe('表示のための純関数', () => {
  it('知らない `generation_state` は「生成中」に落とさない', () => {
    expect(rowStateOf('pending', false)).toBe('working');
    expect(rowStateOf('running', false)).toBe('working');
    expect(rowStateOf('running', true)).toBe('stalled');
    expect(rowStateOf('ready', false)).toBe('ready');
    expect(rowStateOf('failed', false)).toBe('failed');
    expect(rowStateOf('generating', false)).toBe('unknown');
    // 完了した行は、閾値を超えていても「生成中」に見えてはいけない。
    expect(rowStateOf('ready', true)).toBe('ready');
    expect(rowStateOf('failed', true)).toBe('failed');
  });

  it('空のタイトルを無地の行にしない', () => {
    expect(displayTitleOf('   ')).toBe(UNTITLED_TITLE);
    expect(displayTitleOf('ゴリラソーダ')).toBe('ゴリラソーダ');
  });

  it('日本時間の表記が ICU に依存しない', () => {
    expect(formatJstMinutes(0)).toBe('1970-01-01 09:00');
    expect(formatJstMinutes(1_700_000_000)).toBe('2023-11-15 07:13');
    expect(formatJstMinutes(Number.NaN)).toBe('');
  });

  it('Date の範囲外でも投げずに空文字を返す', () => {
    // **`toISOString()` は範囲外の Date で `RangeError` を投げる。** 有限な数でも
    // ±8.64e15 ミリ秒の外に出れば Invalid Date になるため、`Number.isFinite` だけでは
    // 足りない。1 行の異常で一覧全体が 500 になる形を塞ぐ。
    for (const value of [1e15, -1e15, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatJstMinutes(value)).not.toThrow();
      expect(() => toIsoTimestamp(value)).not.toThrow();
      expect(formatJstMinutes(value), String(value)).toBe('');
      expect(toIsoTimestamp(value), String(value)).toBe('');
    }
  });

  it('読める日時では ISO と日本時間の両方を返す', () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('壊れた行が一覧全体を落とさない（#161 レビュー指摘 1）', () => {
  it('日時が読めない行があっても 200 で、他の作品は出る', async () => {
    // #152 が作ろうとしているのは「URL を控えていなくても戻れる道」である。**1 行の
    // 異常で道ごと消える形はその性質と噛み合わない。** 日時は行の付加情報であって、
    // 行を出す条件ではない。
    const userId = await seedUser();
    const broken = await seedGame(userId, { createdAt: 1e15, title: '壊れた日時の作品' });
    const normal = await seedGame(userId, { createdAt: 1_700_000_000, title: '普通の作品' });

    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(200);

    const body = await response.text();
    // 壊れた行も落とさない（作品へは辿れる）。落とすのは `<time>` だけである。
    expect(body).toContain(broken);
    expect(body).toContain('壊れた日時の作品');
    expect(body).toContain(normal);
    expect(body).toContain('普通の作品');
    expect(body).not.toContain('datetime=""');
  });
});

describe('「いいねした作品」への導線（2.3.7 / 5.8 / #340）', () => {
  it('「あなたの作品」から `/works/liked` へ行ける', async () => {
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(body).toContain(`href="${LIKED_WORKS_PATH}"`);
    expect(body).toContain('いいねした作品');
  });

  it('本文の導線は、ヘッダのメニューへ移さずに残す（2.3.7 v1.57 / #372）', async () => {
    // **v1.57 はヘッダのアカウントのメニューにも「いいねした作品」を置いた**（ドロップダウンの
    // 中身はヘッダの項目ではない）。**本文の導線はそのまま残す**——メニューは閉じているので、
    // 「あなたの作品」を見ている人の目に入る導線が要る。外枠の側は `test/page-shell.test.ts`。
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(pageBodyOf(body)).toContain(`href="${LIKED_WORKS_PATH}"`);
  });

  it('未ログインの応答には出さない（ログインへ送るだけである）', async () => {
    const response = await openList();
    expect(response.status).toBe(303);
    expect(await response.text()).not.toContain(LIKED_WORKS_PATH);
  });
});

/**
 * 生成の台帳に 1 行置く（枠の判定が数える単位。確定25）。
 *
 * **`/api/generate` を呼ばない**（呼べば実際に課金される）。枠の判定が見るのは
 * `user_id` / `created_at` / `cost_jpy` だけなので、そこを直接置く
 * （`test/generate-page.test.ts` の `seedLedgerRow` と同じ方針）。**費用は 0 円にする**——
 * 月次上限はサービス全体の金額なので、ここで積むと同じ D1 を見る他の検査の状態を変える。
 *
 * @param userId 利用者の id
 * @returns なし
 */
async function seedLedgerRow(userId: string): Promise<void> {
  await env.DB.prepare(
    `insert into generations
       (id, game_id, user_id, prompt, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        cost_jpy, succeeded, created_at)
     values (?, null, ?, 'ゲーム', ?, 0, 0, 0, 0, 0, 1, ?)`,
  )
    .bind(crypto.randomUUID(), userId, DEFAULT_GENERATION_MODEL_KEY, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * 画面から、指定した `id` の `<p>` の中身を取り出す。
 *
 * @param page 画面の HTML
 * @param id 取り出す要素の id
 * @returns 中身（出ていなければ「(出ていない)」）
 */
function paragraphById(page: string, id: string): string {
  return page.match(new RegExp(`<p[^>]* id="${id}">([^<]*)</p>`, 'u'))?.[1] ?? '(出ていない)';
}

/**
 * 統計カードを「見出し: 数」の並びへ落とす。
 *
 * @param page 画面の HTML
 * @returns 見出しから数への対応
 */
function statCardsOf(page: string): Record<string, string> {
  const cards: Record<string, string> = {};
  for (const match of pageBodyOf(page).matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/gu)) {
    cards[match[1]!] = match[2]!;
  }
  return cards;
}

/**
 * `DB.prepare` に渡った SQL を記録する（あるいは、指定した SQL で失敗させる）env を作る。
 *
 * @param options `failOn` に一致した SQL の `prepare` で投げる
 * @returns 差し替えた env と、記録した SQL
 */
function recordingEnv(options: { readonly failOn?: string } = {}): {
  readonly env: Env;
  readonly prepared: string[];
} {
  const prepared: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          prepared.push(sql);
          if (sql === options.failOn) {
            throw new Error('D1 の不調を模した失敗');
          }
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...testEnv(), DB: db }, prepared };
}

describe('統計カード（2.3.13 / #382）', () => {
  it('作品が 0 本でも 200 で、全部のカードが 0 を出す', async () => {
    const userId = await seedUser();
    const response = await openList(await sessionCookie(userId));
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(statCardsOf(body)).toEqual(
      Object.fromEntries(STAT_CARDS.map(({ label }) => [label, '0'])),
    );
    // 一覧の空の案内も残る（統計が一覧を押しのけていない）。
    expect(body).toContain('まだ作品がありません');
    // 枠はまだ 1 回も使っていない。
    expect(paragraphById(body, 'works-quota')).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });

  it('作品数・公開中・下書き・合計改造された数・合計いいね数・合計プレイ数を、自分の作品だけで数える', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await seedGame(userId, { status: DRAFT_STATUS, likeCount: 0 });
    // 生成中・生成に失敗した作品も下書きである（一覧にも出ている行）。
    await seedGame(userId, { status: DRAFT_STATUS, generationState: 'failed' });
    await seedGame(userId, { status: PUBLISHED_STATUS, forkCount: 2, likeCount: 5, playCount: 30 });
    await seedGame(userId, { status: PUBLISHED_STATUS, forkCount: 1, likeCount: 7, playCount: 12 });
    // **removed は数えない**（一覧に出ない作品を数に入れると、作品数と行数が合わない）。
    await seedGame(userId, { status: REMOVED_STATUS, forkCount: 100, likeCount: 100, playCount: 100 });
    // 他人の作品は数えない。
    await seedGame(other, { status: PUBLISHED_STATUS, forkCount: 50, likeCount: 50, playCount: 50 });

    const body = await (await openList(await sessionCookie(userId))).text();
    expect(statCardsOf(body)).toEqual({
      作品数: '4',
      公開中: '2',
      下書き: '2',
      合計改造された数: '3',
      合計いいね数: '12',
      合計プレイ数: '42',
    });
  });

  it('合計プレイ数のカードを出し、数え始めた時期を書き添える（#377。#382 の申し送り）', async () => {
    // **#382 は列が無いのでカードを出さなかった**（0 と出すと「遊ばれていない」と「数えていない」を
    // 区別できない）。列を持ったので出す。**数え始める前の起動は含まないので、時期を書き添える。**
    const userId = await seedUser();
    await seedGame(userId, { status: PUBLISHED_STATUS });
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(STAT_CARDS.map(({ label }) => label)).toContain('合計プレイ数');
    expect(statCardsOf(body)['合計プレイ数']).toBe('0');
    expect(pageBodyOf(body)).toContain(PLAYS_SINCE_NOTE);
    expect(PLAYS_SINCE_NOTE).toContain('から数えています');
  });

  it('いいね数が遅れて反映されることを書き添える（5.8）', async () => {
    const userId = await seedUser();
    const body = await (await openList(await sessionCookie(userId))).text();
    expect(pageBodyOf(body)).toContain(LIKES_DELAY_NOTE);
  });

  it('統計を読めなくても画面ごと落とさず、「0 本」とも言わない', async () => {
    const userId = await seedUser();
    const gameId = await seedGame(userId, { title: '読めても出る作品' });
    const { env: failing } = recordingEnv({ failOn: myWorksStatsSql() });

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${MY_WORKS_PATH}`, {
        headers: { accept: 'text/html', cookie: await sessionCookie(userId) },
      }),
      failing,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(STATS_UNAVAILABLE_NOTICE);
    expect(statCardsOf(body)).toEqual({});
    // 作品へ戻る道は残る。
    expect(body).toContain(gameId);
  });

  it('描画は作品 0 本の統計でも、読めなかったときでも壊れない（純関数）', () => {
    const empty = renderMyWorksStats(EMPTY_MY_WORKS_STATS, remainingQuotaNotice(3));
    expect(statCardsOf(empty)).toEqual(
      Object.fromEntries(STAT_CARDS.map(({ label }) => [label, '0'])),
    );
    const unavailable = renderMyWorksStats(null, remainingQuotaNotice(3));
    expect(unavailable).toContain(STATS_UNAVAILABLE_NOTICE);
    expect(paragraphById(unavailable, 'works-quota')).toBe(remainingQuotaNotice(3));
  });
});

describe('今日の残り生成回数は、生成画面と同じ経路から引く（2.3.13 / 4.4 / #382）', () => {
  /**
   * 生成画面と「あなたの作品」を同じ利用者で開き、残枠の文言を並べる。
   *
   * @param userId 利用者の id
   * @returns 両画面の文言
   */
  async function quotaOnBothPages(
    userId: string,
  ): Promise<{ readonly generate: string; readonly mine: string }> {
    const cookie = await sessionCookie(userId);
    const generate = await (
      await handleAppRequest(
        new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, {
          headers: { accept: 'text/html', cookie },
        }),
        testEnv(),
      )
    ).text();
    const mine = await (await openList(cookie)).text();
    return {
      generate: paragraphById(generate, 'generate-quota'),
      mine: paragraphById(mine, 'works-quota'),
    };
  }

  it('枠が残っているとき、生成画面と同じ「本日の残り生成枠 N回」を出す', async () => {
    const userId = await seedUser();
    for (let index = 0; index < 3; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(shown.generate);
    expect(shown.mine).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER - 3));
  });

  it('日次の枠が尽きたとき、生成画面と同じ文言を出す（「残り 0 回」を別に作らない）', async () => {
    const userId = await seedUser();
    for (let index = 0; index < DAILY_QUOTA_PER_USER; index += 1) {
      await seedLedgerRow(userId);
    }
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(shown.generate);
    // **同じ状態に 2 つの文言を作らない**（`src/generate-page.ts` の `availabilityNotice`）。
    expect(shown.mine).toBe(GENERATE_MESSAGES[DAILY_QUOTA_MESSAGE_KEY]);
  });

  it('他人の生成は自分の残り回数を減らさない', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await seedLedgerRow(other);
    const shown = await quotaOnBothPages(userId);
    expect(shown.mine).toBe(remainingQuotaNotice(DAILY_QUOTA_PER_USER));
  });
});

describe('統計の読み取り（2.3.3 の条件 1 / #382 の訂正）', () => {
  it('統計は集計 1 回で引く（カードの数だけ問い合わせを出さない）', async () => {
    const userId = await seedUser();
    await seedGame(userId, { status: PUBLISHED_STATUS });
    await seedGame(userId, { status: DRAFT_STATUS });
    const { env: recording, prepared } = recordingEnv();

    await loadMyWorksStats(recording, userId);
    expect(prepared).toEqual([myWorksStatsSql()]);
  });

  it('作者で絞った SEARCH であり、games を全件 SCAN しない（公開作品の総数に比例しない）', async () => {
    // **索引が「存在すること」ではなく、この問い合わせが実際に使うことを見る。**
    // SEARCH（`author_id=?`）であれば、読む行はその作者の作品に限られる——自分の作品数には
    // 比例するが、母数（公開作品の総数）には比例しない（#382 の訂正で読み替えた基準）。
    const plan = await env.DB.prepare(`explain query plan ${myWorksStatsSql()}`)
      .bind(...myWorksStatsBinds('someone'))
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');

    expect(detail).toContain('SEARCH');
    expect(detail).toContain('games_author_id_created_at_idx');
    expect(detail).toContain('author_id=?');
    expect(detail).not.toMatch(/\bSCAN games\b/u);
  });
});
