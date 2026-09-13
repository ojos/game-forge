import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountRoutes } from '../src/account.js';
import { handleAppRequest } from '../src/app.js';
import { renderAuthorProfile } from '../src/author-profile.js';
import { PROFILE_CHANGES_TABLE, PROFILE_LINKS_UNVERIFIED_NOTICE, PROFILE_LINK_REL } from '../src/profile.js';
import { ACCOUNT_PROFILE_PATH, BIO_FIELD, PROFILE_LINK_FIELD } from '../src/profile-paths.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { authorPagePath } from '../src/users-page-paths.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 作者ページに出る自己紹介と外部リンク（#379 / M12-11 / 仕様 5.6・5.10）。
 *
 * # この検査が見ているもの（#379 の acceptance と constraints）
 *
 *   1. **自己紹介に HTML を入れても、そのまま描画されない**（**変異で確認した**。
 *      `src/author-profile.ts` の `bioParagraphs` から `escapeHtml` を外すと「HTML」の it が赤）
 *   2. **未検証である旨の表示が出る**（**変異で確認した**。但し書きの `<p>` を消すと「但し書き」の
 *      it が赤）
 *   3. **リンクに `rel="nofollow ugc noopener"` と `target="_blank"` が付く**
 *   4. **D1 に `javascript:` が入っていても、`href` に出ない**（**変異で確認した**。表示の直前の
 *      `parseStoredProfileLinks` を素の `JSON.parse` に替えると「D1 を直接」の it が赤）
 *   5. 何も設定していない作者には、節も但し書きも出ない
 *   6. `/account` で保存した値が作者ページに出る（往復）
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-author-profile-001';
const USER_PREFIX = 'author-profile-';

beforeAll(async () => {
  await applySchema();
});

afterAll(async () => {
  await env.DB.prepare(
    `delete from ${PROFILE_CHANGES_TABLE} where user_id like '${USER_PREFIX}%'`,
  ).run();
});

/**
 * プロフィールを直接入れた利用者を 1 人用意する（D1 を直接書いた値の検査にも使う）。
 *
 * @param bio `users.bio`
 * @param links `users.profile_links`
 * @returns 利用者の id
 */
async function seedUser(bio = '', links = '[]'): Promise<string> {
  const id = `${USER_PREFIX}${crypto.randomUUID()}`;
  await env.DB.prepare(
    `insert into users (id, google_sub, email, display_name, created_at, bio, profile_links)
     values (?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, '自己紹介の作者', bio, links)
    .run();
  return id;
}

/**
 * 作者ページを開き、外枠を除いた本文を返す。
 *
 * **キャッシュを捨てる手順は要らない。** プロフィールは表示名と同じ主キー 1 行から毎回引き、
 * Cache API に載せていない（`src/users-page.ts`）。どの it も作ったばかりの利用者を開く。
 *
 * @param userId 利用者の id
 * @returns 本文
 */
async function openAuthor(userId: string): Promise<string> {
  const response = await handleAppRequest(
    new Request(`${APP_ORIGIN}${authorPagePath(userId)}`),
    { ...env, SESSION_SECRET: SECRET },
  );
  expect(response.status).toBe(200);
  return pageBodyOf(await response.text());
}

/**
 * 本文から外部リンクの `<a>` の開始タグを取り出す。
 *
 * @param body 本文
 * @returns 開始タグの列
 */
function linkTags(body: string): string[] {
  const list = /<ul class="gf-author-links"[\s\S]*?<\/ul>/u.exec(body)?.[0] ?? '';
  return list.match(/<a [^>]*>/gu) ?? [];
}

describe('作者ページの自己紹介（#379）', () => {
  it('自己紹介に入れた HTML は、そのまま描画されない', async () => {
    const userId = await seedUser('<script>alert(1)</script>\n<b onclick="x">太字</b>');
    const body = await openAuthor(userId);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<b onclick');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>\n&lt;b onclick=&quot;x&quot;&gt;太字&lt;/b&gt;');
  });

  it('改行は <br>、空行は段落の区切りになる', () => {
    const html = renderAuthorProfile({ bio: '1 行目\n2 行目\n\n次の段落', links: '[]' });
    expect(html).toContain('<p>1 行目<br>\n2 行目</p>\n<p>次の段落</p>');
  });

  it('何も設定していなければ、節も但し書きも出さない', async () => {
    const body = await openAuthor(await seedUser());
    expect(body).not.toContain('gf-author-profile');
    expect(body).not.toContain(PROFILE_LINKS_UNVERIFIED_NOTICE);
    expect(renderAuthorProfile(undefined)).toBe('');
    expect(renderAuthorProfile({ bio: null, links: null })).toBe('');
  });
});

describe('作者ページの外部リンク（#379 / 5.6 の覆しの受け方）', () => {
  it('リンクに rel="nofollow ugc noopener" と target="_blank" が付き、文字は href そのもの', async () => {
    const userId = await seedUser('', '["https://example.com/me","https://xn--r8jz45g.jp/"]');
    const body = await openAuthor(userId);
    const tags = linkTags(body);
    expect(tags).toEqual([
      `<a href="https://example.com/me" rel="${PROFILE_LINK_REL}" target="_blank">`,
      `<a href="https://xn--r8jz45g.jp/" rel="${PROFILE_LINK_REL}" target="_blank">`,
    ]);
    expect(PROFILE_LINK_REL).toBe('nofollow ugc noopener');
    expect(body).toContain('target="_blank">https://xn--r8jz45g.jp/</a>');
  });

  it('リンクがあれば、運営は検証していない旨の但し書きが出る', async () => {
    const body = await openAuthor(await seedUser('', '["https://example.com/"]'));
    expect(body).toContain(`<p class="gf-author-links-note">${PROFILE_LINKS_UNVERIFIED_NOTICE}</p>`);
    expect(PROFILE_LINKS_UNVERIFIED_NOTICE).toContain('本人の申告');
    expect(PROFILE_LINKS_UNVERIFIED_NOTICE).toContain('運営はリンク先が本人のものかを確認していません');
    // 但し書きはリンクの直後に置く（離れた場所の注記は、リンクを踏む人に読まれない）。
    const list = body.indexOf('<ul class="gf-author-links"');
    const note = body.indexOf('gf-author-links-note');
    expect(list).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThan(list);
    expect(body.slice(list, note)).not.toContain('<h');
  });

  it('D1 を直接書き換えた javascript: / data: / 属性を閉じる綴りは、href に出さない', async () => {
    const stored = JSON.stringify([
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://example.com/"><script>alert(1)</script>',
      'https://ok.example/',
    ]);
    const body = await openAuthor(await seedUser('', stored));
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('data:text/html');
    expect(body).not.toContain('<script>');
    expect(linkTags(body)).toEqual([`<a href="https://ok.example/" rel="${PROFILE_LINK_REL}" target="_blank">`]);
  });

  it('壊れた JSON でも画面を落とさず、自己紹介は出す', async () => {
    const body = await openAuthor(await seedUser('自己紹介は出る', '{broken'));
    expect(body).toContain('自己紹介は出る');
    expect(linkTags(body)).toEqual([]);
    expect(body).not.toContain(PROFILE_LINKS_UNVERIFIED_NOTICE);
  });
});

describe('/account で保存した値が作者ページに出る（往復）', () => {
  it('保存した自己紹介とリンクが、次に開いた作者ページに出る', async () => {
    const userId = await seedUser();
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;
    const form = new URLSearchParams();
    form.append(BIO_FIELD, '往復した自己紹介');
    form.append(PROFILE_LINK_FIELD, 'https://example.net/profile');
    const response = await dispatch(
      createAccountRoutes(),
      new Request(`${APP_ORIGIN}${ACCOUNT_PROFILE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: form.toString(),
      }),
      { ...env, SESSION_SECRET: SECRET },
    );
    expect(response.status).toBe(303);

    const body = await openAuthor(userId);
    expect(body).toContain('<p>往復した自己紹介</p>');
    expect(linkTags(body)).toEqual([
      `<a href="https://example.net/profile" rel="${PROFILE_LINK_REL}" target="_blank">`,
    ]);
  });
});
