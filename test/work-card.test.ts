import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import { PUBLISHED_STATUS } from '../src/games.js';
import type { PublicWork } from '../src/games.js';
import { cachedRows, listCacheKey, purgeListCache } from '../src/list-cache.js';
import { PUBLIC_WORKS_PATH } from '../src/works-paths.js';
import { authorPagePath } from '../src/users-page-paths.js';
import {
  cardAuthorId,
  cardLikeCount,
  cardPlayCount,
  renderWorkCard,
  renderWorkCards,
  workTagListPath,
} from '../src/work-card.js';
import { workPagePath } from '../src/work-page.js';
import { HOME_CACHE_KEY } from '../src/home-feed.js';
import { HOME_PATH } from '../src/paths.js';
import { LIKED_WORKS_PATH } from '../src/liked-works.js';
import { changeLike } from '../src/likes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作品カードのいいねの数（仕様 2.3.6 / 5.8 / M9-8 / #340）。
 *
 * # 何を確かめるか
 *
 * 1. **数が出る**（0 のときは出さない）
 * 2. **`likeCount` を持たない古い行でも「いいね undefined」と描かない**
 *    ——一覧は Cache API に行を載せ、**鍵に行の形の版を持たない**（`src/list-cache.ts`。
 *    TTL 60 秒）。配備の直後、最大 60 秒は `like_count` を選んでいなかった頃の行が
 *    返りうる（#339 からの申し送り。1.2.50「型が必須であることは実行時の保証ではない」）。
 *    **実際に古い形の行をキャッシュへ入れてから一覧を開く**——`?? 0` を書いただけの
 *    検査にしない
 * 3. **表示名は数を足したあともエスケープされる**（5.9。カードが D1 の値を HTML へ
 *    入れるのは題名と作者名の 2 つだけで、いいねの数は数値である）
 *
 * # 数を出す側は DO を呼ばない
 *
 * カードが読むのは `games.like_count`（D1 へ写した値。最大 5 分遅れる）である。
 * **一覧を開くことで DO の枠を減らさない**（5.8）。この性質は
 * `test/work-page.test.ts` が作品ページについて機械判定しており、ここでは
 * 「カードは渡された行だけから描かれる」ことを描画で見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;

beforeAll(async () => {
  await applySchema();
});

/** 公開時刻の払い出し（`test/works-list.test.ts` と同じ理由で、常に最も新しい値を返す）。 */
let publishedAtSeq = 9_500_000_000;

/**
 * 次の公開時刻を返す。
 *
 * @returns UNIX 秒
 */
function nextPublishedAt(): number {
  publishedAtSeq += 1;
  return publishedAtSeq;
}

/**
 * 描画だけを試すための最小の行。
 *
 * **`PublicWork` そのものを組み立てる。** 型が変わったら検査が落ちるので、写しには
 * ならない（`test/work-page.test.ts` の `baseView` と同じ扱い）。
 */
const baseWork: PublicWork = {
  id: '00000000-0000-4000-8000-000000000000',
  title: 'カードの題',
  authorName: 'カードの作者',
  publishedAt: 1_700_000_000,
  forkCount: 0,
  likeCount: 0,
  hasParent: false,
  hasShot: true,
};

/**
 * 作者を 1 人用意する。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName: string): Promise<string> {
  const id = `card-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 公開済みの作品を 1 件入れる。
 *
 * @param authorId 作者
 * @param likeCount `games.like_count`
 * @returns 作った作品の id
 */
async function seedGame(authorId: string, likeCount: number): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into games
       (id, author_id, status, title, go_version, created_at, generation_state,
        published_at, fork_count, like_count, ogp_state)
     values (?, ?, ?, 'カードの題', '', 1, 'ready', ?, 0, ?, 'ready')`,
  )
    .bind(id, authorId, PUBLISHED_STATUS, nextPublishedAt(), likeCount)
    .run();
  return id;
}

/** 1 頁目（新着順）のキャッシュの鍵。 */
const FIRST_PAGE_KEY = listCacheKey('works', { sort: 'recent', page: 1 });

/**
 * 公開一覧を開く（**経路表を通す**）。
 *
 * @returns 本文
 */
async function openList(): Promise<string> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}`, { headers: { accept: 'text/html' } }),
    env,
  );
  return await response.text();
}

describe('いいねの数を出す（2.3.6 / 5.8）', () => {
  it('1 以上なら出し、0 なら出さない', () => {
    expect(renderWorkCard({ ...baseWork, likeCount: 4 })).toContain('いいね 4');
    // **全行に「いいね 0」が並ぶ一覧は、区別を何も運ばない**（`fork_count` と同じ扱い）。
    expect(renderWorkCard({ ...baseWork, likeCount: 0 })).not.toContain('いいね');
  });

  it('改造された数と並んで出る（どちらも 0 なら両方出ない）', () => {
    const both = renderWorkCard({ ...baseWork, forkCount: 2, likeCount: 5 });
    expect(both).toContain('改造 2');
    expect(both).toContain('いいね 5');
    const neither = renderWorkCard({ ...baseWork, forkCount: 0, likeCount: 0 });
    expect(neither).not.toContain('改造');
    expect(neither).not.toContain('いいね');
  });

  it('公開一覧のカードに、D1 へ写した数が出る', async () => {
    const author = await seedUser('数の出る作者');
    const liked = await seedGame(author, 6);

    await purgeListCache(FIRST_PAGE_KEY);
    const body = await openList();

    expect(body).toContain(workPagePath(liked));
    expect(body).toContain('いいね 6');
  });
});

describe('likeCount を持たない古い行（キャッシュの 60 秒の窓。#340）', () => {
  it('欠けていても数を出さず、undefined も NaN も本文へ出さない', async () => {
    const author = await seedUser('古い行の作者');
    const id = await seedGame(author, 8);

    // **本番と同じ経路で古い形の行を仕込む。** `src/list-cache.ts` は行を JSON として
    // 保存し、鍵に行の形の版を持たない。`like_count` を選んでいなかった頃の行は、
    // まさにこの形（`likeCount` の無いオブジェクト）で入っている。
    await purgeListCache(FIRST_PAGE_KEY);
    const stale = [
      {
        id,
        title: 'カードの題',
        authorName: '古い行の作者',
        publishedAt: publishedAtSeq,
        forkCount: 0,
        hasParent: false,
        hasShot: true,
      },
    ];
    await cachedRows(FIRST_PAGE_KEY, async () => stale as unknown as readonly PublicWork[]);

    const body = await openList();

    // 仕込みが効いていること（キャッシュを読んでいる）を先に確かめる。**効いていない
    // まま「undefined が無い」を見ても、何も確かめていない**（`docs/handoff.md` 4 章）。
    expect(body).toContain(workPagePath(id));
    expect(body, 'キャッシュを読んでいない（D1 の 8 が出ている）').not.toContain('いいね 8');
    // **0 として扱う**＝数を出さない（誤った数を 1 つも出さない。#340 の判断）。
    //
    // **「いいね」の語だけでは見られない。** 並べ替えの札（「いいねの数」）と
    // `<meta name="description">` が同じ語を持つ（`src/works-list.ts`）。**数が
    // 添えられている形**だけを探す。
    expect(body).not.toMatch(/いいね\s*\d/u);
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('NaN');

    // 窓は 60 秒で閉じる。捨てれば D1 から引き直し、数が出る。
    await purgeListCache(FIRST_PAGE_KEY);
    expect(await openList()).toContain('いいね 8');
  });

  it('数でない値はすべて 0 に倒す（読み方は 1 か所が持つ）', () => {
    for (const broken of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '3', -1, 0]) {
      const work = { ...baseWork, likeCount: broken } as unknown as PublicWork;
      expect(cardLikeCount(work), String(broken)).toBe(0);
      expect(renderWorkCard(work), String(broken)).not.toContain('いいね');
    }
    // 空振りしないことを対で見る。
    expect(cardLikeCount({ ...baseWork, likeCount: 3 })).toBe(3);
    expect(cardLikeCount({ ...baseWork, likeCount: 3.9 }), '整数へ落とす').toBe(3);
  });
});

describe('プレイ数を出す（2.3.6 / #377）', () => {
  it('1 以上なら出し、0・欠けている・数でないなら出さない（いいねの数と同じ扱い）', () => {
    expect(renderWorkCard({ ...baseWork, playCount: 12 })).toContain(
      '<span class="gf-card-plays">プレイ 12</span>',
    );
    // **欠けた行は、配備の直後 60 秒のキャッシュから返りうる**（`playCount` は省略可）。
    expect(renderWorkCard(baseWork)).not.toContain('プレイ');
    for (const broken of [0, -1, Number.NaN, null, '3', undefined]) {
      const work = { ...baseWork, playCount: broken } as unknown as PublicWork;
      expect(cardPlayCount(work), String(broken)).toBe(0);
      expect(renderWorkCard(work), String(broken)).not.toContain('プレイ');
    }
    expect(cardPlayCount({ ...baseWork, playCount: 7.9 }), '整数へ落とす').toBe(7);
  });

  it('いいねの数の隣に並ぶ', () => {
    const card = renderWorkCard({ ...baseWork, likeCount: 5, playCount: 9 });
    expect(card.indexOf('いいね 5')).toBeLessThan(card.indexOf('プレイ 9'));
    expect(card.indexOf('プレイ 9')).toBeLessThan(card.indexOf('<time'));
  });

  it('公開一覧のカードに、D1 へ写したプレイ数が出る', async () => {
    const author = await seedUser('プレイ数の出る作者');
    const played = await seedGame(author, 0);
    await env.DB.prepare('update games set play_count = 31 where id = ?').bind(played).run();

    await purgeListCache(FIRST_PAGE_KEY);
    const body = await openList();

    expect(body).toContain(workPagePath(played));
    expect(body).toContain('プレイ 31');
  });
});

describe('表示名は数を足したあともエスケープされる（5.9）', () => {
  it('数と並んでも、作者名の HTML はタグにならない', () => {
    const html = renderWorkCard({
      ...baseWork,
      authorName: '<script>alert(1)</script>',
      likeCount: 2,
    });
    expect(html).toContain('いいね 2');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('公開一覧の経路でも、作者名がタグにならない（数が出る行で確かめる）', async () => {
    const author = await seedUser('<img src=x onerror=alert(1)>');
    const id = await seedGame(author, 9);

    await purgeListCache(FIRST_PAGE_KEY);
    const body = await openList();

    expect(body).toContain(workPagePath(id));
    expect(body).toContain('いいね 9');
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('カードを並べても同じ（部品は 1 つである。2.3.6）', () => {
    const cards = renderWorkCards([
      { ...baseWork, id: '00000000-0000-4000-8000-000000000001', likeCount: 1 },
      { ...baseWork, id: '00000000-0000-4000-8000-000000000002', likeCount: 0 },
    ], null);
    expect(cards.match(/いいね /gu) ?? []).toHaveLength(1);
    expect(renderWorkCards([], null)).toBe('');
  });
});

describe('作者名から作者ページへ辿れる（#330 / 仕様 2.3.1）', () => {
  it('`authorId` があれば作者名がリンクになる', () => {
    const html = renderWorkCard({ ...baseWork, authorId: 'u-1' });
    expect(html).toContain(`<a class="gf-card-author gf-link-quiet" href="${authorPagePath('u-1')}">`);
    // 名前はリンクの中身になるだけである（エスケープは変わらない）。
    expect(html).toContain('>カードの作者</a>');
  });

  it('`authorId` が無い行はリンクにしない（`<span>` のまま）', () => {
    // **一覧の行は Cache API に載っており、鍵に行の形の版が無い**（`src/list-cache.ts`。
    // TTL 60 秒）。配備の直後、最大 60 秒は `author_id` を選んでいなかった頃の行が
    // 返りうる（`likeCount` が #340 で踏んだ穴と同じもの。5.8 の v1.52）。
    //
    // **空の `href` や 404 へ行くリンクを出さない**（4.4）。
    expect(renderWorkCard(baseWork)).toContain('<span class="gf-card-author">カードの作者</span>');
    expect(renderWorkCard(baseWork)).not.toContain('<a class="gf-card-author');
  });

  it('数でない値・空文字も同じ扱いにする（キャッシュを経由する値は JSON である）', () => {
    for (const broken of [null, '', 0, {}, []] as unknown[]) {
      const html = renderWorkCard({ ...baseWork, authorId: broken as string });
      expect(html, String(broken)).toContain('<span class="gf-card-author">');
      expect(cardAuthorId({ ...baseWork, authorId: broken as string }), String(broken)).toBeNull();
    }
    // 空振りしないことを対で見る。
    expect(cardAuthorId({ ...baseWork, authorId: 'u-2' })).toBe('u-2');
  });

  it('作者名が引けていない行はリンクにしない（押した人を必ず 404 へ送らない）', () => {
    // `authorName` が null のカードは「不明」と出る。**`users` の行が引けていないので、
    // その id の作者ページは 404 である。**
    const html = renderWorkCard({ ...baseWork, authorName: null, authorId: 'u-3' });
    expect(html).toContain('<span class="gf-card-author">不明</span>');
    expect(cardAuthorId({ ...baseWork, authorName: null, authorId: 'u-3' })).toBeNull();
  });

  it('カード全体のリンクの中に入れ子にしない（HTML として不正にならない）', () => {
    // `.gf-card-link` が包むのはスクリーンショットと題名だけで、下段はその外側にある。
    const html = renderWorkCard({ ...baseWork, authorId: 'u-4' });
    const cardLinkEnd = html.indexOf('</a>');
    const authorLink = html.indexOf('class="gf-card-author');
    expect(cardLinkEnd).toBeGreaterThan(0);
    expect(authorLink, '作者のリンクがカードのリンクより前にある').toBeGreaterThan(cardLinkEnd);
  });

  it('公開一覧の経路でも作者名がリンクになる（引く側が `author_id` を選んでいる）', async () => {
    // **描画の検査だけでは足りない。** `publishedGamesSql` が `g.author_id` を選ばなく
    // なったら、カードは静かに `<span>` へ戻る（画面は正しく出る）。
    const author = await seedUser('一覧から辿られる作者');
    const id = await seedGame(author, 0);

    await purgeListCache(FIRST_PAGE_KEY);
    const body = await openList();

    expect(body).toContain(workPagePath(id));
    expect(body).toContain(`<a class="gf-card-author gf-link-quiet" href="${authorPagePath(author)}">`);
  });
});

describe('カードのタグ（#376 / 仕様 2.3.6）', () => {
  it('語彙にあるタグだけを、絞り込んだ一覧へのリンクとして下段に出す', () => {
    const card = renderWorkCard({ ...baseWork, tags: ['puzzle', 'not-in-vocabulary', 'idle'] });
    expect(card).toContain(`<a class="gf-chip gf-card-genre" href="${workTagListPath('puzzle')}">パズル</a>`);
    expect(card).toContain(`<a class="gf-chip gf-card-genre" href="${workTagListPath('idle')}">放置</a>`);
    expect(card).not.toContain('not-in-vocabulary');
    // **カード全体を包むリンクの外に置く**（入れ子のリンクにしない）。
    const link = card.slice(card.indexOf('<a class="gf-card-link"'), card.indexOf('</a>') + 4);
    expect(link).not.toContain('gf-card-genre');
  });

  it('タグ無し・欠けた値・壊れた値では何も出さず、壊れない', () => {
    for (const broken of [[], undefined, null, 'puzzle', [1, null], { 0: 'puzzle' }]) {
      const card = renderWorkCard({ ...baseWork, tags: broken } as unknown as PublicWork);
      expect(card, JSON.stringify(broken)).not.toContain('gf-card-genre');
      expect(card, JSON.stringify(broken)).not.toContain('undefined');
    }
  });

  it('公開一覧のカードに、D1 の枠から引いたタグが出る', async () => {
    const author = await seedUser('タグの出る作者');
    const id = await seedGame(author, 0);
    await env.DB.prepare("update games set tag1 = 'shooting', tag2 = 'other' where id = ?")
      .bind(id)
      .run();

    await purgeListCache(FIRST_PAGE_KEY);
    const body = await openList();
    const card = body.slice(body.indexOf(`href="${workPagePath(id)}"`));
    const first = card.slice(0, card.indexOf('</li>'));

    expect(first).toContain('>シューティング</a>');
    expect(first).toContain('>その他</a>');
  });

  it('tags を持たない古い行がキャッシュから返っても、一覧は 200 でタグを出さないだけ', async () => {
    // **配備の直後 60 秒の窓**（`likeCount` の #340 と同じ形）。本番と同じ経路で古い形の行を仕込む。
    const author = await seedUser('タグの古い行の作者');
    const id = await seedGame(author, 0);
    await env.DB.prepare("update games set tag1 = 'action' where id = ?").bind(id).run();

    await purgeListCache(FIRST_PAGE_KEY);
    const stale = [
      {
        id,
        title: 'カードの題',
        authorName: 'タグの古い行の作者',
        authorId: author,
        publishedAt: publishedAtSeq,
        forkCount: 0,
        likeCount: 0,
        hasParent: false,
        hasShot: true,
      },
    ];
    await cachedRows(FIRST_PAGE_KEY, async () => stale as unknown as readonly PublicWork[]);

    const response = await handleAppRequest(
      new Request(`${APP_ORIGIN}${PUBLIC_WORKS_PATH}`, { headers: { accept: 'text/html' } }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(workPagePath(id));
    // **左カラムの絞り込みにも同じラベルが並ぶ**ので、カードのタグの形だけを探す。
    const cardTag = `<a class="gf-chip gf-card-genre" href="${workTagListPath('action')}">アクション</a>`;
    expect(body, 'キャッシュを読んでいない（D1 のタグが出ている）').not.toContain(cardTag);
    expect(body).not.toContain('undefined');

    await purgeListCache(FIRST_PAGE_KEY);
    expect(await openList()).toContain(cardTag);
  });
});

describe('4 画面が同じカードの部品を使い、面で区切る（#471 / 仕様 2.5.4）', () => {
  /** セッションの署名に使う秘密（いいねした作品を開くため。この describe だけで使う）。 */
  const SECRET = 'test-secret-value-for-work-card-471-0001';

  /**
   * カード 1 枚を本文から切り出す。
   *
   * @param body 画面の HTML
   * @param id 作品の id
   * @returns その作品の `<li>`（見つからなければ空文字）
   */
  function cardOf(body: string, id: string): string {
    const link = body.indexOf(`<a class="gf-card-link" href="${workPagePath(id)}">`);
    if (link < 0) {
      return '';
    }
    const start = body.lastIndexOf('<li', link);
    return body.slice(start, body.indexOf('</li>', link) + '</li>'.length);
  }

  it('トップ・作品をさがす・作者ページ・いいねした作品が、同じ形のカードを出す', async () => {
    const testEnv = { ...env, SESSION_SECRET: SECRET } as unknown as Env;
    const author = await seedUser('4 画面に並ぶ作者');
    const viewer = await seedUser('いいねする人');
    const id = crypto.randomUUID();
    // **どの一覧でも 1 頁目の先頭に来るよう、公開時刻をいちばん新しくする**（D1 はテストファイルをまたいで共有される）。
    await env.DB.prepare(
      `insert into games
         (id, author_id, status, title, go_version, created_at, generation_state,
          published_at, fork_count, like_count, ogp_state, tag1)
       values (?, ?, ?, '4 画面のカード', '', 1, 'ready', ?, 0, 0, 'ready', 'puzzle')`,
    )
      .bind(id, author, PUBLISHED_STATUS, 9_999_000_000 + Math.floor(Math.random() * 1000))
      .run();
    expect(await changeLike(testEnv, 'like', viewer, id, 1_900_000_000)).toBe('liked');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession({ userId: viewer, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;

    await purgeListCache(HOME_CACHE_KEY);
    await purgeListCache(FIRST_PAGE_KEY);
    const screens: readonly (readonly [string, string])[] = [
      ['トップ', HOME_PATH],
      ['作品をさがす', PUBLIC_WORKS_PATH],
      ['作者ページ', authorPagePath(author)],
      ['いいねした作品', LIKED_WORKS_PATH],
    ];
    for (const [name, path] of screens) {
      const response = await handleAppRequest(
        new Request(`${APP_ORIGIN}${path}`, { headers: { accept: 'text/html', cookie } }),
        testEnv,
      );
      expect(response.status, name).toBe(200);
      const card = cardOf(await response.text(), id);
      // **面はカードの `<li>` が持つブロックの部品**（`.gf-block`）である。
      expect(card, name).toMatch(/^<li class="gf-card gf-block"><a class="gf-card-link" href="/u);
      expect(card, name).toContain('<span class="gf-card-title">4 画面のカード</span></a><p class="gf-card-meta">');
      // 作者名は文章の外のリンク、タグはチップで、補助の行の後ろの別の行（HTML の順＝見た目の順）。
      expect(card, name).toContain(`<a class="gf-card-author gf-link-quiet" href="${authorPagePath(author)}">`);
      expect(card, name).toContain(
        `</p><p class="gf-card-genres"><a class="gf-chip gf-card-genre" href="${workTagListPath('puzzle')}">パズル</a></p></li>`,
      );
    }
    await purgeListCache(HOME_CACHE_KEY);
    await purgeListCache(FIRST_PAGE_KEY);
  });

  it('作品カードの規則は枠線も影も持たず、ホバーで面を濃くしない（app.css の `@section work-card`）', () => {
    const css = env.TEST_APP_CSS;
    // **区画の見出しの行で切る**（コメントの中の「`@section parts`」などの言及で切らない）。
    const start = css.indexOf('\n   @section work-card');
    const end = css.indexOf('\n   @section ', start + 1);
    expect(start, '`@section work-card` が見つかりません').toBeGreaterThan(0);
    const section = css.slice(start, end).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    // **`border-radius` 以外の border の宣言と、影を置かない**（仕様 2.5.4 の表「枠線・影: 使わない」）。
    expect(section).not.toMatch(/border(-(top|right|bottom|left))?(-(width|style|color))?\s*:/u);
    expect(section).not.toMatch(/box-shadow\s*:/u);
    // **ホバーで面の色を変えない・浮かせない**（`.gf-card:hover` の規則を持たない）。
    expect(section).not.toMatch(/\.gf-card(\.gf-block)?:(hover|focus-within)/u);
    expect(section).not.toMatch(/transform\s*:/u);
  });

  it('作者名の項目は縮められ、長い名前はその中で折り返す（PR #496 の Copilot code review）', () => {
    // **補助の行は flex で、項目の既定の `min-width: auto` のままだと**、上限（30 文字）いっぱいの区切りの無い ASCII の
    // 表示名とアイコンが 16rem のカードの内容幅を越える。`body` から継ぐ `overflow-wrap` に寄りかからず、項目が自分で持つ
    // （実ブラウザで継承を外すと、直す前は 1280px の 4 列で 75px ほどはみ出し、直した後は 0 だった）。
    const css = env.TEST_APP_CSS;
    const start = css.indexOf('\n   @section work-card');
    const section = css.slice(start, css.indexOf('\n   @section ', start + 1)).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const rule = /(?:^|\n)\.gf-card-author\s*\{([^}]*)\}/u.exec(section);
    expect(rule, '`@section work-card` に `.gf-card-author` の規則がありません').not.toBeNull();
    expect(rule![1]).toMatch(/min-width:\s*0;/u);
    expect(rule![1]).toMatch(/max-width:\s*100%;/u);
    expect(rule![1]).toMatch(/overflow-wrap:\s*anywhere;/u);
  });
});
