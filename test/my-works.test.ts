import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { DRAFT_STATUS, UNTITLED_TITLE } from '../src/games.js';
import { HOME_PATH } from '../src/home.js';
import {
  MAX_LISTED_WORKS,
  MY_WORKS_PATH,
  displayTitleOf,
  formatJstMinutes,
  rowStateOf,
  toIsoTimestamp,
} from '../src/my-works.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { STALE_AFTER_SECONDS, WORK_PAGE_PREFIX, workPagePath } from '../src/work-page.js';
import { applySchema } from './helpers/schema.js';

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
      overrides.createdAt ?? Math.floor(Date.now() / 1000),
      overrides.generationState ?? 'ready',
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
  it('一覧は作品ページの親の位置にある', () => {
    // 綴りを 2 か所に書かない決定を、導出の結果として固定する。**URL を 1 本でも
    // 覚えている人が末尾を削るだけで一覧に着く**ことが、この位置を選んだ理由である。
    expect(WORK_PAGE_PREFIX).toBe(`${MY_WORKS_PATH}/`);
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
