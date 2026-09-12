import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import { DRAFT_STATUS, PUBLISHED_STATUS, REMOVED_STATUS } from '../src/games.js';
import { purgeListCache } from '../src/list-cache.js';
import { REVIEW_CLEARED, REVIEW_QUEUED } from '../src/reports.js';
import { findDuplicateRoutes, findMalformedPrefixRoutes } from '../src/routes.js';
import {
  AUTHOR_PAGE_PREFIX,
  MAX_USER_ID_LENGTH,
  NO_WORKS_NOTICE,
  UNKNOWN_AUTHOR_HEADING,
  authorCacheKey,
  authorPagePath,
  userIdFromPath,
} from '../src/users-page.js';
import { workPagePath } from '../src/work-page.js';
import { MAX_PAGE, PUBLIC_WORKS_PATH, WORKS_PER_PAGE } from '../src/works-list.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作者ページ（#330 / M9-4 / 仕様 2.3.1 / 2.3.6 / 5.8）。
 *
 * **issue #330 の acceptance を機械判定できる形へ落とす。**
 *
 * 1. `email` と `invited_by` が応答本文に含まれない
 * 2. `draft` が出ない
 * 3. **被いいね数に `draft` と審査で止めた作品が入らない**（#335 が足した項目）
 * 4. 存在しない `user_id` が 404 を返す
 * 5. M8-1 の 3 検査（経路表から導く `test/page-shell.test.ts` が自動で拾う。**この画面を
 *    足したことであちらの対象が 1 枚増える**——前方一致の経路なので、あちらは仕込んだ
 *    id を補って開く）
 *
 * **この issue が決めた 2 つも固定する。**
 *
 * - **BAN 済みの利用者の作者ページは 404 にしない**（`src/users-page.ts` に 4 つの根拠）
 * - **運営の印（`.gf-operator`）はこの画面に出さない**（`docs/operator-account.md` と
 *   食い違わせない）
 *
 * **キャッシュを毎回捨ててから開く。** `caches.default` はテスト間で共有される
 * （`test/works-list.test.ts` と同じ手順）。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

beforeAll(async () => {
  await applySchema();
});

/**
 * 公開時刻を 1 つ払い出す。
 *
 * **必ず「いままでで最も新しい」値を返す。** `games` はテストファイルをまたいで
 * 共有されるので、固定値で仕込むと順序に依存したテストになる
 * （`test/works-list.test.ts` と同じ理由・同じ形。起点はあちらより離してある）。
 */
let publishedAtSeq = 9_100_000_000;

/**
 * 次の公開時刻を返す。
 *
 * @returns UNIX 秒（呼ぶたびに 1 秒ずつ新しくなる）
 */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/**
 * 利用者を 1 人用意する。
 *
 * **`email` と `invited_by` と `x_handle` を必ず入れる。** 入れないと「出ていない」を
 * 見る検査が、**値がそもそも無いだけで**緑になる（検査が空振りする）。
 *
 * @param displayName 表示名
 * @param overrides 列の指定
 * @returns 利用者の id
 */
async function seedUser(
  displayName: string,
  overrides: {
    readonly invitedBy?: string | null;
    readonly bannedAt?: number | null;
    readonly isOperator?: number;
  } = {},
): Promise<string> {
  const id = `author-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, x_handle, invited_by,
                        created_at, banned_at, is_operator)
     values (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      `sub-${id}`,
      `${id}@example.com`,
      displayName,
      `@x_${id}`,
      overrides.invitedBy ?? null,
      overrides.bannedAt ?? null,
      overrides.isOperator ?? 0,
    )
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
    readonly publishedAt?: number | null;
    readonly likeCount?: number;
    readonly reviewState?: string | null;
    readonly ogpState?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state, review_state)
     values (?, ?, ?, ?, '', 1, 'ready', ?, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      authorId,
      overrides.status ?? PUBLISHED_STATUS,
      overrides.title ?? 'タイトル',
      overrides.publishedAt === undefined ? nextPublishedAt() : overrides.publishedAt,
      overrides.likeCount ?? 0,
      overrides.ogpState === undefined ? 'ready' : overrides.ogpState,
      overrides.reviewState ?? null,
    )
    .run();
  return id;
}

/**
 * 作者ページを開く。
 *
 * **経路表を通す。** ハンドラを直接呼ぶと、`src/app.ts` への登録漏れを見逃す。
 *
 * @param userId 利用者 id
 * @param query クエリ文字列（`?` を含む。省略可）
 * @returns レスポンス
 */
async function openAuthor(userId: string, query = ''): Promise<Response> {
  const page = Number.parseInt(new URLSearchParams(query.replace(/^\?/u, '')).get('page') ?? '1', 10);
  await purgeListCache(authorCacheKey(userId, Number.isSafeInteger(page) && page >= 1 ? page : 1));
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${authorPagePath(userId)}${query}`, {
      headers: { accept: 'text/html' },
    }),
    env,
  );
}

/**
 * 作者ページを開いて本文を取る（200 であることも見る）。
 *
 * @param userId 利用者 id
 * @param query クエリ文字列
 * @returns HTML
 */
async function bodyOf(userId: string, query = ''): Promise<string> {
  const response = await openAuthor(userId, query);
  // **本文は 1 度しか読めない**ので、先に読んでから状態を見る（失敗時の手掛かりに使う）。
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return body;
}

describe('経路の登録（#330）', () => {
  it('作者ページが前方一致で 1 本だけ登録されている', () => {
    const routes = createAppRoutes(env);
    expect(findDuplicateRoutes(routes)).toEqual([]);
    // 接頭辞は `/` で終わる（`/usersmith` のような別の経路を飲み込まない）。
    expect(findMalformedPrefixRoutes(routes)).toEqual([]);
    expect(routes.filter((route) => route.path === AUTHOR_PAGE_PREFIX)).toHaveLength(1);
  });

  it('綴りは仕様 2.3.1 の `/users/<user_id>` である', () => {
    expect(AUTHOR_PAGE_PREFIX).toBe('/users/');
    expect(authorPagePath('abc')).toBe('/users/abc');
  });

  it('id は URL として閉じられる（`href` を破れない）', () => {
    // 属性値へ入る値なので、`"` を 1 文字含むだけで属性を閉じられる形にしない。
    expect(authorPagePath('a"b')).toBe('/users/a%22b');
    expect(authorPagePath('a/b')).toBe('/users/a%2Fb');
  });

  it('未ログインでも見られる（仕様 2.3.1 の「ログイン: 不要」）', async () => {
    const author = await seedUser('未ログインでも見える作者');
    await seedGame(author);
    // cookie を 1 つも付けずに開く。
    const response = await openAuthor(author);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('出すもの（仕様 2.3.1 / 5.8）', () => {
  it('表示名とその人の公開作品が出る', async () => {
    const author = await seedUser('出す作者');
    const mine = await seedGame(author, { title: 'わたしの作品' });

    const other = await seedUser('別の作者');
    const theirs = await seedGame(other, { title: 'よその作品' });

    const body = await bodyOf(author);
    expect(body).toContain('<h1>出す作者</h1>');
    expect(body).toContain(workPagePath(mine));
    // **他人の作品が混ざらない。** `author_id` で絞っていることの検査である。
    expect(body).not.toContain(workPagePath(theirs));
  });

  it('被いいね数は公開作品の like_count の合計である（5.8）', async () => {
    const author = await seedUser('いいねされる作者');
    await seedGame(author, { likeCount: 3 });
    await seedGame(author, { likeCount: 4 });

    expect(await bodyOf(author)).toContain('受け取ったいいね 7');
  });

  it('1 件もいいねされていなくても 0 を出す', async () => {
    // **カードの「0 のときは出さない」（2.3.6）はここには当たらない。** 被いいね数は
    // この画面が出すと決まっている 2 つの値のうちの 1 つで、消すと「まだ誰にも
    // 押されていない」と「数が出ていない」の区別が付かない。
    const author = await seedUser('まだ押されていない作者');
    await seedGame(author);

    expect(await bodyOf(author)).toContain('受け取ったいいね 0');
  });

  it('作品が 1 件も無い作者でも 200 で、無いことを言う', async () => {
    // **404 にしない。** 取り下げや審査で一時的に 0 件になった作者ページが 404 になると、
    // 共有された URL が壊れる（行は実在している）。
    const author = await seedUser('まだ公開していない作者');
    await seedGame(author, { status: DRAFT_STATUS });

    const body = await bodyOf(author);
    expect(body).toContain(NO_WORKS_NOTICE);
    // **空の `<ul>` を出さない**（`renderWorkCards` が空文字を返す）。
    expect(body).not.toContain('<ul class="gf-cards">');
  });

  it('一覧へ戻る導線がある', async () => {
    const author = await seedUser('戻る導線の作者');
    await seedGame(author);
    expect(await bodyOf(author)).toContain(`href="${PUBLIC_WORKS_PATH}"`);
  });

  it('検索避けを付けない（誰にでも見せる発見の面である）', async () => {
    const author = await seedUser('索引される作者');
    await seedGame(author);
    expect(await bodyOf(author)).not.toContain('name="robots"');
  });
});

describe('出してはいけないもの（仕様 2.3.6 / 5.6 / 8.1）', () => {
  it('email と invited_by が応答本文に含まれない', async () => {
    // **引く側が `display_name` しか選んでいない**ので、画面が誤って出す経路が無い。
    // それを画面まで通して固定する（issue #330 の acceptance の 1 つ目）。
    const inviter = await seedUser('招待した人');
    const author = await seedUser('招待された人', { invitedBy: inviter });
    await seedGame(author);

    const body = await bodyOf(author);
    // **空振りしないことを対で見る**——名前が出ていることまで確かめる。
    expect(body).toContain('招待された人');
    expect(body).not.toContain(`${author}@example.com`);
    expect(body).not.toContain('@example.com');
    // 招待者の id そのものが出ていない（「招待の連鎖が外から辿れる」を作らない）。
    expect(body).not.toContain(inviter);
  });

  it('x_handle が出ない（5.6 / #330 の scope.out）', async () => {
    const author = await seedUser('X を持つ作者');
    await seedGame(author);

    const body = await bodyOf(author);
    expect(body).not.toContain(`@x_${author}`);
    expect(body).not.toContain('x.com');
    expect(body).not.toContain('twitter.com');
  });

  it('カードの作者名も、その作者自身の名前しか出さない', async () => {
    // カードは共通部品である（2.3.6）。**ここで `users` の他の列が混ざる経路が無い**
    // ことを、カードが 1 枚以上並んだ状態で見る。
    const author = await seedUser('カードの作者');
    await seedGame(author);

    const body = await bodyOf(author);
    expect(body).toContain('gf-card-author');
    expect(body).not.toContain('@example.com');
  });
});

describe('絞り込みは引く時点で行う（5.4 / 8.4 / #152 の規律）', () => {
  it('draft の作品が出ない', async () => {
    const author = await seedUser('下書きを持つ作者');
    const draft = await seedGame(author, { status: DRAFT_STATUS, title: 'したがき' });
    const published = await seedGame(author, { title: 'こうかい' });

    const body = await bodyOf(author);
    expect(body).toContain(workPagePath(published));
    expect(body).not.toContain(workPagePath(draft));
  });

  it('removed の作品が出ない（8.4 の削除）', async () => {
    const author = await seedUser('取り下げた作者');
    const removed = await seedGame(author, { status: REMOVED_STATUS });
    const published = await seedGame(author);

    const body = await bodyOf(author);
    expect(body).toContain(workPagePath(published));
    expect(body).not.toContain(workPagePath(removed));
  });

  it('審査で新規露出を止めた作品が出ない（8.4）', async () => {
    const author = await seedUser('通報された作者');
    const queued = await seedGame(author, { reviewState: REVIEW_QUEUED });
    const cleared = await seedGame(author, { reviewState: REVIEW_CLEARED });

    const body = await bodyOf(author);
    expect(body).not.toContain(workPagePath(queued));
    // **`cleared` は露出する**（見た結果、問題なしとした状態。`reviewVisibleSql`）。
    expect(body).toContain(workPagePath(cleared));
  });

  it('被いいね数に draft と審査で止めた作品と removed が入らない（#335 / 5.8）', async () => {
    // **issue #330 の acceptance で名指しされている項目である。** 合計だけが別の条件で
    // 数えると、カードを数えても合計と合わない画面になる。
    const author = await seedUser('隠れたいいねを持つ作者');
    await seedGame(author, { likeCount: 5 });
    await seedGame(author, { status: DRAFT_STATUS, likeCount: 1_000 });
    await seedGame(author, { reviewState: REVIEW_QUEUED, likeCount: 2_000 });
    await seedGame(author, { status: REMOVED_STATUS, likeCount: 4_000 });

    const body = await bodyOf(author);
    expect(body).toContain('受け取ったいいね 5');
    // **合計が漏れた形を名指しで落とす**（7005 / 1005 / 2005 / 4005 のどれも出ない）。
    for (const leaked of [7005, 1005, 2005, 4005, 6005, 3005]) {
      expect(body, `合計に隠れた作品が入っている（${leaked}）`).not.toContain(
        `受け取ったいいね ${leaked}`,
      );
    }
  });
});

describe('存在しない利用者（#330 の acceptance）', () => {
  it('存在しない user_id は 404', async () => {
    const response = await openAuthor(`author-${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('作者が見つかりません');
  });

  it('作品 id を渡しても 404（綴りが違う表を指している）', async () => {
    // `scripts/lib/dev-fixture.sh` は前方一致の経路へ「仕込んだ作品の id」を補うので、
    // **この形が実際に踏まれる。** 500 にならないことを固定しておく。
    const author = await seedUser('作品 id を渡される作者');
    const gameId = await seedGame(author);
    expect((await openAuthor(gameId)).status).toBe(404);
  });

  it('綴りが取れない要求は 404（500 にしない）', async () => {
    for (const path of [
      AUTHOR_PAGE_PREFIX, // 続きが無い
      `${AUTHOR_PAGE_PREFIX}a/b`, // `/` を含む
      `${AUTHOR_PAGE_PREFIX}%`, // 壊れたパーセント符号（decodeURIComponent が投げる）
      `${AUTHOR_PAGE_PREFIX}${'x'.repeat(MAX_USER_ID_LENGTH + 1)}`, // 長すぎる
    ]) {
      const response = await handleAppRequest(new Request(`${APP_ORIGIN}${path}`), env);
      expect(response.status, path).toBe(404);
    }
  });

  it('綴りの取り出しは単体でも同じ判定をする', () => {
    expect(userIdFromPath(`${AUTHOR_PAGE_PREFIX}abc`)).toBe('abc');
    // `authorPagePath` が符号化した値を戻せる（往復する）。
    expect(userIdFromPath(authorPagePath('あいう'))).toBe('あいう');
    expect(userIdFromPath(AUTHOR_PAGE_PREFIX)).toBeNull();
    expect(userIdFromPath(`${AUTHOR_PAGE_PREFIX}a/b`)).toBeNull();
    expect(userIdFromPath(`${AUTHOR_PAGE_PREFIX}%`)).toBeNull();
    expect(userIdFromPath(`${AUTHOR_PAGE_PREFIX}${'x'.repeat(MAX_USER_ID_LENGTH + 1)}`)).toBeNull();
    // **符号化して長くなった形でも、戻した長さで判定する。**
    expect(userIdFromPath(authorPagePath('あ'.repeat(MAX_USER_ID_LENGTH)))).toBeNull();
  });

  it('404 の本文で理由を区別しない', async () => {
    // 「居ない」と「綴りが長すぎる」を区別して返すと、id の総当たりに手掛かりを渡す。
    const missing = await (await openAuthor(`author-${crypto.randomUUID()}`)).text();
    const malformed = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${AUTHOR_PAGE_PREFIX}a/b`), env)
    ).text();
    expect(malformed).toBe(missing);
  });
});

describe('BAN 済みの利用者（issue #330 が決めた / 7.3 / 8.4）', () => {
  it('作者ページを 404 にしない。作品も被いいね数もそのまま出る', async () => {
    // **判断と 4 つの根拠は `src/users-page.ts` にある。** 要点は「BAN が止めるのは
    // 生成と招待であり（7.3）、露出を止める単位は作品である（8.4）」。
    //
    // **404 にすると、一覧・トップ・作品ページに並んだままのカードの作者名が、
    // 押すと 404 へ行くリンクになる**（4.4 が出さないと定めているもの）。
    const author = await seedUser('BAN された作者', { bannedAt: 1 });
    const game = await seedGame(author, { likeCount: 2 });

    const body = await bodyOf(author);
    expect(body).toContain('<h1>BAN された作者</h1>');
    expect(body).toContain(workPagePath(game));
    expect(body).toContain('受け取ったいいね 2');
  });

  it('BAN したあとに作品を取り下げれば、その作品だけが消える（8.4 が持つ単位）', async () => {
    // **露出を止めたいときの手順が 8.4 であることを、機械で示す。**
    const author = await seedUser('BAN されて取り下げられた作者', { bannedAt: 1 });
    const game = await seedGame(author);
    expect(await bodyOf(author)).toContain(workPagePath(game));

    const updated = await env.DB.prepare('update games set status = ? where id = ?')
      .bind(REMOVED_STATUS, game)
      .run();
    // **変異が当たったことを先に確かめる**（0 行の UPDATE のあとで「消えた」を見ても
    // 何も確かめていない。`docs/handoff.md` 4 章）。
    expect(updated.meta.changes).toBe(1);

    const body = await bodyOf(author);
    expect(body).not.toContain(workPagePath(game));
    expect(body).toContain(NO_WORKS_NOTICE);
  });
});

describe('運営の印は出さない（issue #330 が決めた / #334 / docs/operator-account.md）', () => {
  it('運営フラグが立っていても、この画面には印が 1 つも出ない', async () => {
    // **`docs/operator-account.md` の 1 章の表と 5 章に揃えた判断である**（「作者ページの
    // カードには出ない」「見分けられるのは作品ページだけ」）。出すと、#330 の範囲外の
    // 文書 2 か所が同時に誤りになる。
    const author = await seedUser('運営アカウント相当', { isOperator: 1 });
    await seedGame(author);

    const body = await bodyOf(author);
    // 立っていることを先に確かめる（空振りしないことの対）。
    const row = await env.DB.prepare('select is_operator from users where id = ?')
      .bind(author)
      .first<{ is_operator: number }>();
    expect(row?.is_operator).toBe(1);

    expect(body).not.toContain('gf-operator');
    // 文言そのものも出ない（`src/work-page.ts` の `OPERATOR_MARK` の綴り）。
    expect(body).not.toContain('運営アカウント</span>');
  });

  it('引く側が is_operator を選んでいない', async () => {
    // **「出さない」を表示側の注意ではなく、引く形で担保する**（#152 の規律）。
    // 選んでいなければ、画面を書き換えても出しようがない。
    const { authorWorksSql, likesReceivedSql } = await import('../src/users-page.js');
    expect(authorWorksSql()).not.toContain('is_operator');
    expect(likesReceivedSql()).not.toContain('is_operator');
    expect(authorWorksSql()).not.toContain('email');
    expect(authorWorksSql()).not.toContain('invited_by');
    expect(authorWorksSql()).not.toContain('x_handle');
    expect(authorWorksSql()).not.toContain('banned_at');
  });
});

describe('頁送り（仕様 2.3.3 の条件 1）', () => {
  it('21 件目が次の頁で取得できる', async () => {
    const author = await seedUser('たくさん公開した作者');
    const ids: string[] = [];
    for (let count = 0; count < WORKS_PER_PAGE + 1; count += 1) {
      // 新しいほど先に出る。**最後に入れたものが 1 頁目の先頭**になる。
      ids.push(await seedGame(author));
    }
    const oldest = ids[0]!;

    const first = await bodyOf(author, '?page=1');
    const second = await bodyOf(author, '?page=2');

    expect(first).not.toContain(workPagePath(oldest));
    expect(first).toContain(`次の ${WORKS_PER_PAGE} 件`);
    expect(second).toContain(workPagePath(oldest));
    expect(second).toContain(`前の ${WORKS_PER_PAGE} 件`);
  });

  it('1 頁で収まるなら頁送りを出さない（押しても何も起きないものを出さない）', async () => {
    const author = await seedUser('1 頁で収まる作者');
    await seedGame(author);

    const body = await bodyOf(author);
    expect(body).not.toContain('gf-pager');
  });

  it('壊れた `?page=` は既定へ落ちる（400 にしない）', async () => {
    const author = await seedUser('壊れたクエリの作者');
    await seedGame(author);
    // 上限は `src/works-list.ts` と同じ値を借りている（2 か所に持たない）。
    expect(MAX_PAGE).toBeGreaterThan(1);
    expect((await openAuthor(author, '?page=なな')).status).toBe(200);
    expect((await openAuthor(author, '?page=-1')).status).toBe(200);
    expect((await openAuthor(author, '?page=999999')).status).toBe(200);
  });

  it('並びは公開日時の新しい順である（カードが出す日時と同じ軸）', async () => {
    const author = await seedUser('並び順の作者');
    const older = await seedGame(author);
    const newer = await seedGame(author);

    const body = await bodyOf(author);
    expect(body.indexOf(workPagePath(newer))).toBeLessThan(body.indexOf(workPagePath(older)));
  });
});

describe('Cache API の前段（仕様 2.3.3 の条件 3）', () => {
  it('2 回目は D1 を引き直さず、捨てれば引き直す', async () => {
    const author = await seedUser('キャッシュの作者');
    const key = authorCacheKey(author, 1);
    await purgeListCache(key);

    const before = await seedGame(author);
    // `openAuthor` は毎回捨てるので、ここは経路を直接叩いて溜める。
    const url = `${APP_ORIGIN}${authorPagePath(author)}`;
    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(
      workPagePath(before),
    );

    const after = await seedGame(author);
    expect(await (await handleAppRequest(new Request(url), env)).text()).not.toContain(
      workPagePath(after),
    );

    expect(await purgeListCache(key)).toBe(true);
    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(
      workPagePath(after),
    );
  });

  it('表示名はキャッシュを通らない（5.9 の変更が 60 秒遅れない）', async () => {
    const author = await seedUser('名前を変える作者');
    await seedGame(author);
    const url = `${APP_ORIGIN}${authorPagePath(author)}`;
    await purgeListCache(authorCacheKey(author, 1));
    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(
      '<h1>名前を変える作者</h1>',
    );

    const renamed = await env.DB.prepare('update users set display_name = ? where id = ?')
      .bind('変えたあとの名前', author)
      .run();
    expect(renamed.meta.changes).toBe(1);

    // **キャッシュを捨てずに開く。** 作品の行は古いままでよいが、名前は新しくなる。
    expect(await (await handleAppRequest(new Request(url), env)).text()).toContain(
      '<h1>変えたあとの名前</h1>',
    );
  });

  it('鍵は利用者と頁で分かれる', () => {
    expect(authorCacheKey('a', 1)).not.toBe(authorCacheKey('b', 1));
    expect(authorCacheKey('a', 1)).not.toBe(authorCacheKey('a', 2));
    // 一覧・トップの鍵と混ざらない（件数も絞り方も違う行が同居しない）。
    expect(authorCacheKey('a', 1)).toContain('/author?');
  });
});

describe('表示名が引けないとき', () => {
  it('空欄の見出しを出さない', async () => {
    const author = await seedUser('あとで空にする作者');
    await seedGame(author);
    // `display_name` は NOT NULL なので、空白だけの値で試す。
    const updated = await env.DB.prepare('update users set display_name = ? where id = ?')
      .bind('   ', author)
      .run();
    expect(updated.meta.changes).toBe(1);

    expect(await bodyOf(author)).toContain(`<h1>${UNKNOWN_AUTHOR_HEADING}</h1>`);
  });
});

describe('作品から作者へ辿る導線（#330 の goal）', () => {
  it('公開一覧のカードの作者名が作者ページを指す', async () => {
    const author = await seedUser('一覧から辿られる作者');
    await seedGame(author);

    const { listCacheKey } = await import('../src/list-cache.js');
    await purgeListCache(listCacheKey('works', { sort: 'recent', page: 1 }));
    const body = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}?sort=recent&page=1`), env)
    ).text();

    expect(body).toContain(`<a class="gf-card-author" href="${authorPagePath(author)}">`);
  });

  it('作品ページの作者名が作者ページを指す', async () => {
    const author = await seedUser('作品ページから辿られる作者');
    const game = await seedGame(author);

    const body = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${workPagePath(game)}`), env)
    ).text();

    expect(body).toContain(`href="${authorPagePath(author)}"`);
  });

  it('辿った先が 200 である（往復する）', async () => {
    // **リンクを張ったことと、行き先が生きていることは別である。** カードから取り出した
    // パスをそのまま開く（綴りを書き写さない）。
    const author = await seedUser('往復する作者');
    const game = await seedGame(author);

    const workBody = await (
      await handleAppRequest(new Request(`${APP_ORIGIN}${workPagePath(game)}`), env)
    ).text();
    const href = /<a class="gf-author-link" href="([^"]+)"/u.exec(workBody)?.[1];
    expect(href, '作品ページに作者ページへのリンクが無い').toBeDefined();

    await purgeListCache(authorCacheKey(author, 1));
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}${href!}`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>往復する作者</h1>');
  });
});
