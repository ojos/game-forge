import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAppRequest } from '../src/app.js';
import {
  claimGenerationJob,
  completeGame,
  createForkedGame,
  createPendingGame,
  hashJobToken,
  publishGame,
} from '../src/games.js';
import { PLAY_PATH } from '../src/plays.js';
import { REVIEW_QUEUED } from '../src/reports.js';
import { RELATED_FORKS_LIMIT, RELATED_TAG_LIMIT, listRelatedWorks, sameTagSql } from '../src/related-works.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { FORK_PARENT_ID_FIELD, FORK_PATH } from '../src/paths.js';
import { WORK_REPORT_ANCHOR, WORK_REPORT_PATH, workPagePath } from '../src/work-page.js';
import { workSourcePath } from '../src/work-source.js';
import { fakeBuildOutcome } from './helpers/build-outcome.js';
import { markGameRemoved } from './helpers/removed-work.js';
import { applySchema } from './helpers/schema.js';

/**
 * 作品ページの視聴ページの配置と関連作品（#665 / レイアウト改修 2/3）。
 *
 * acceptance の「関連作品は、フォーク元・フォーク先・同じタグの順に出る。下書きと取り下げ済みの作品は出ない」
 * 「「フォークする」を押すまで入力欄は閉じている。開いてから送ると、いまと同じフォークが走る」
 * 「通報とソースコードの表示は、「…」メニューからいまと同じ経路で動く」を見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-related-works-1';

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
  const id = `related-user-${suffix}`;
  await env.DB.prepare(
    `insert or ignore into users (id, google_sub, email, display_name, created_at, banned_at)
     values (?, ?, ?, ?, 1, null)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, `作者 ${suffix}`)
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

/**
 * 完成した作品を 1 件用意する（公開するかは引数で決める）。
 *
 * @param suffix テスト内で一意な接尾辞
 * @param options 公開・タグ・親・公開日時
 * @returns 作者の id と作品 id
 */
async function seedWork(
  suffix: string,
  options: { publish?: boolean; tags?: readonly string[]; parentId?: string; publishedAt?: number } = {},
): Promise<{ userId: string; id: string }> {
  const userId = await seedUser(suffix);
  const pending =
    options.parentId === undefined
      ? await createPendingGame(env, userId, { prompt: `関連 ${suffix}` })
      : await createForkedGame(env, userId, { prompt: `関連 ${suffix}` }, options.parentId);
  await claimGenerationJob(env, pending.id, await hashJobToken(pending.jobToken));
  await completeGame(env, pending.id, fakeBuildOutcome({ sourceSha256: `sha-related-${suffix}` }));
  if (options.publish !== false) {
    expect((await publishGame(env, pending.id, userId, options.publishedAt ?? 1_000, options.tags ?? [])).ok).toBe(true);
  }
  return { userId, id: pending.id };
}

/**
 * 作品ページを開く。
 *
 * @param id 作品 id
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns 本文
 */
async function openWork(id: string, cookie?: string): Promise<string> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${workPagePath(id)}`, { headers: cookie === undefined ? {} : { cookie } }),
    testEnv(),
  );
  return await response.text();
}

beforeAll(async () => {
  await applySchema();
});

describe('関連作品は、フォーク元・フォーク先・同じタグの順に出る（#665 の acceptance）', () => {
  it('並びはフォーク元 → フォーク先（新しい順）→ 同じタグ（新しい順）で、同じ作品は 2 度出さない', async () => {
    const parent = await seedWork('order-parent', { tags: ['idle'], publishedAt: 100 });
    const self = await seedWork('order-self', { tags: ['idle'], parentId: parent.id, publishedAt: 200 });
    const olderFork = await seedWork('order-fork-old', { parentId: self.id, publishedAt: 300 });
    const newerFork = await seedWork('order-fork-new', { parentId: self.id, tags: ['idle'], publishedAt: 400 });
    const olderTag = await seedWork('order-tag-old', { tags: ['idle'], publishedAt: 5_000_000_000 });
    const newerTag = await seedWork('order-tag-new', { tags: ['puzzle', 'idle'], publishedAt: 5_000_000_100 });

    const related = await listRelatedWorks(env, self.id, parent.id, ['idle']);
    const ids = related.map((work) => work.id);
    expect(ids[0]).toBe(parent.id);
    expect(ids.slice(1, 3)).toEqual([newerFork.id, olderFork.id]);
    expect(related.slice(0, 3).map((work) => work.relation)).toEqual(['parent', 'fork', 'fork']);
    // 同じタグの作品は、その後ろに新しい順で並ぶ（別のテストの作品が混ざりうるので、相対の順だけを見る）。
    expect(ids.indexOf(newerTag.id)).toBeGreaterThan(2);
    expect(ids.indexOf(newerTag.id)).toBeLessThan(ids.indexOf(olderTag.id));
    // **親とフォーク先は同じタグでも、2 度出さない**（関係の近い側で 1 度だけ）。自分自身も出さない。
    expect(ids.filter((id) => id === parent.id || id === newerFork.id)).toHaveLength(2);
    expect(ids).not.toContain(self.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('下書き・取り下げ済み・審査で新規露出を止めた作品は出ない', async () => {
    const parent = await seedWork('hidden-parent', { tags: ['rhythm-sound'] });
    const self = await seedWork('hidden-self', { tags: ['rhythm-sound'], parentId: parent.id });
    const draftFork = await seedWork('hidden-draft-fork', { parentId: self.id, publish: false });
    const removedFork = await seedWork('hidden-removed-fork', { parentId: self.id });
    await markGameRemoved(removedFork.id);
    const queuedTag = await seedWork('hidden-queued-tag', { tags: ['rhythm-sound'] });
    await env.DB.prepare('update games set review_state = ? where id = ?').bind(REVIEW_QUEUED, queuedTag.id).run();
    const removedTag = await seedWork('hidden-removed-tag', { tags: ['rhythm-sound'] });
    await markGameRemoved(removedTag.id);

    const ids = (await listRelatedWorks(env, self.id, parent.id, ['rhythm-sound'])).map((work) => work.id);
    expect(ids).toContain(parent.id);
    for (const hidden of [draftFork.id, removedFork.id, queuedTag.id, removedTag.id]) {
      expect(ids).not.toContain(hidden);
    }

    // **親が下書きへ戻れば、フォーク元にも出さない**（題名はプロンプト由来。公開していない作品を出さない）。
    await env.DB.prepare("update games set status = 'draft' where id = ?").bind(parent.id).run();
    expect((await listRelatedWorks(env, self.id, parent.id, [])).map((work) => work.id)).not.toContain(parent.id);
  });

  it('フォーク先は上限で切る', async () => {
    const self = await seedWork('limit-self');
    for (let i = 0; i < RELATED_FORKS_LIMIT + 2; i += 1) {
      await seedWork(`limit-fork-${i}`, { parentId: self.id, publishedAt: 1_000 + i });
    }
    const related = await listRelatedWorks(env, self.id, null, []);
    expect(related.filter((work) => work.relation === 'fork')).toHaveLength(RELATED_FORKS_LIMIT);
  });

  it('同じタグは上限（8 件）で切り、タグの枠をまたいで当たった作品も 1 度だけ出す', async () => {
    // **2 つのタグを両方持つ作品を 10 件**（上限より多い）。どれも `tag1 = action` と `tag2 = puzzle` の 2 つの文に当たる。
    const self = await seedWork('tag-limit-self', { tags: ['action', 'puzzle'], publishedAt: 1 });
    const mine: string[] = [];
    for (let i = 0; i < RELATED_TAG_LIMIT + 2; i += 1) {
      // 別のテストの作品より新しくして、上位を自分の作品で埋める。
      mine.push((await seedWork(`tag-limit-${i}`, { tags: ['action', 'puzzle'], publishedAt: 9_000_000_000 + i })).id);
    }
    const related = await listRelatedWorks(env, self.id, null, ['action', 'puzzle']);
    const tagged = related.filter((work) => work.relation === 'tag').map((work) => work.id);
    expect(tagged).toHaveLength(RELATED_TAG_LIMIT);
    expect(new Set(tagged).size).toBe(tagged.length);
    // 新しい順に 8 件（古い 2 件は落ちる）。
    expect(tagged).toEqual([...mine].reverse().slice(0, RELATED_TAG_LIMIT));
  });

  it('同じタグの問い合わせは、タグの枠ごとの部分索引を使う（索引を足していない）', async () => {
    for (const slot of ['tag1', 'tag2', 'tag3'] as const) {
      const plan = await env.DB.prepare(`explain query plan ${sameTagSql(slot)}`)
        .bind('idle', 'x', 10)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join('\n');
      expect(details, slot).toContain(`USING INDEX games_${slot}_published_at_idx`);
      expect(details, slot).not.toMatch(/SCAN g\b/u);
    }
  });

  it('作品ページの右カラムに、関係の札を付けて並べる（題名はエスケープする）', async () => {
    const parent = await seedWork('page-parent', { tags: ['board-card'] });
    await env.DB.prepare('update games set title = ? where id = ?').bind('<b>親</b>', parent.id).run();
    const self = await seedWork('page-self', { tags: ['board-card'], parentId: parent.id });
    await seedWork('page-fork', { parentId: self.id });

    const body = await openWork(self.id);
    const aside = body.slice(body.indexOf('<aside class="gf-related"'), body.indexOf('</aside>'));
    expect(aside).toContain('<h2 id="gf-related-heading">関連作品</h2>');
    const labels = [...aside.matchAll(/<span class="gf-chip">([^<]*)<\/span>/gu)].map((found) => found[1]);
    expect(labels.slice(0, 2)).toEqual(['フォーク元', 'この作品のフォーク']);
    expect(aside).toContain(`href="${workPagePath(parent.id)}"`);
    expect(aside).toContain('&lt;b&gt;親&lt;/b&gt;');
    expect(aside).not.toContain('<b>親</b>');
    // **本文が先、右カラムが後**（狭い段では本文の下に積む）。
    expect(body.indexOf('<aside class="gf-related"')).toBeGreaterThan(body.indexOf('このゲームからのフォーク'));
  });
});

describe('「フォークする」を押すまで入力欄は閉じている（#665 の acceptance）', () => {
  it('入力欄は閉じた `<details>` の中にあり、開いて送るといまと同じ口へ同じ項目で送る', async () => {
    const { id } = await seedWork('fork-closed');
    const visitor = await seedUser('fork-closed-visitor');
    const body = await openWork(id, await sessionCookie(visitor));

    expect(body).not.toContain('<details class="gf-fork-open" open');
    const opened = body.slice(body.indexOf('<details class="gf-fork-open">'), body.indexOf('</details>', body.indexOf('<details class="gf-fork-open">')));
    expect(opened).toContain('<summary class="gf-fork gf-button gf-button-primary">フォークする</summary>');
    expect(opened).toContain(`<form method="post" action="${FORK_PATH}">`);
    expect(opened).toContain(`<input type="hidden" name="${FORK_PARENT_ID_FIELD}" value="${id}">`);
    expect(opened).toContain('<textarea id="fork-prompt"');
    // **入力欄は `<summary>` の後ろ**＝閉じているあいだは描かれない。
    expect(opened.indexOf('<textarea')).toBeGreaterThan(opened.indexOf('</summary>'));
    // JavaScript を要求しない。
    expect(opened).not.toContain('<script');
  });
});

describe('通報とソースコードの表示は、「…」メニューからいまと同じ経路で動く（#665 の acceptance）', () => {
  it('ログイン済みの他人には、「…」の中に「ソースコードを見る」「この作品を通報する」の 2 行だけがあり、通報のフォームはメニューの外で開く', async () => {
    const { id } = await seedWork('menu');
    const visitor = await seedUser('menu-visitor');
    const body = await openWork(id, await sessionCookie(visitor));

    const start = body.indexOf('<details class="gf-watch-more">');
    expect(start).toBeGreaterThan(0);
    const menu = body.slice(start, body.indexOf('</details>', start));
    expect(menu).toContain('<summary class="gf-button gf-button-secondary gf-button-sm" aria-label="その他の操作">…</summary>');
    const items = [...menu.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((found) => found[1]);
    expect(items).toEqual([
      `<a class="gf-link-quiet" href="${workSourcePath(id)}">ソースコードを見る</a>`,
      `<a class="gf-link-quiet" href="#${WORK_REPORT_ANCHOR}">この作品を通報する</a>`,
    ]);
    // **通報のフォームはメニューの外**（概要欄の下の `<details id="report">`）。経路は同じ `POST /api/works/report`。
    expect(menu).not.toContain('<form');
    const report = body.indexOf(`<details class="gf-report" id="${WORK_REPORT_ANCHOR}">`);
    expect(report).toBeGreaterThan(body.indexOf('<section class="gf-watch-overview'));
    expect(body.slice(report)).toMatch(new RegExp(`^<details class="gf-report" id="${WORK_REPORT_ANCHOR}">[\\s\\S]*?<form class="gf-form-fields" method="post" action="${WORK_REPORT_PATH}">`, 'u'));
    // **同じ口を 2 つ出さない。**
    expect(body.split(`action="${WORK_REPORT_PATH}"`).length - 1).toBe(1);
    expect(body.split(`href="${workSourcePath(id)}"`).length - 1).toBe(1);
    // 押した先は実際に開く。
    const source = await handleAppRequest(new Request(`${APP_ORIGIN}${workSourcePath(id)}`), testEnv());
    expect(source.status).toBe(200);
  });

  it('通報できない人（未ログイン・作者）には「この作品を通報する」を出さない', async () => {
    const { userId, id } = await seedWork('menu-no-report');
    for (const cookie of [undefined, await sessionCookie(userId)]) {
      const body = await openWork(id, cookie);
      expect(body).not.toContain('この作品を通報する</a>');
      expect(body).toContain('ソースコードを見る');
    }
  });

  it('「…」の中身は本文の上に浮かぶ（押し下げない）。影は使わず、右端に揃える（app.css）', () => {
    const rule = /^\.gf-watch-more-menu\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*absolute/u);
    expect(rule).toMatch(/right:\s*0/u);
    expect(rule).not.toMatch(/box-shadow/u);
    expect(/^\.gf-watch-more\s*\{([^}]*)\}/mu.exec(env.TEST_APP_CSS)?.[1] ?? '').toMatch(/position:\s*relative/u);
  });

  it('中身が無ければ「…」を出さない（下書きのプレビュー: 通報もソースも無い）', async () => {
    const { userId, id } = await seedWork('menu-preview', { publish: false });
    const body = await openWork(id, await sessionCookie(userId));
    expect(body).toContain('gf-draft-banner');
    expect(body).not.toContain('gf-watch-more');
    expect(body).not.toContain(PLAY_PATH);
  });
});
