import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountRoutes, validateDisplayName } from '../src/account.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { DENIED_TERMS } from '../src/denied-terms.js';
import {
  BIO_MAX_LENGTH,
  PROFILE_CHANGES_TABLE,
  PROFILE_CHANGE_INTERVAL_SECONDS,
  PROFILE_LINKS_UNVERIFIED_NOTICE,
  PROFILE_LINK_MAX_COUNT,
  PROFILE_LINK_MAX_LENGTH,
  changeProfile,
  encodeProfileLinks,
  normalizeProfileLink,
  parseStoredProfileLinks,
  validateBio,
  validateProfile,
} from '../src/profile.js';
import { ACCOUNT_PROFILE_PATH, BIO_FIELD, PROFILE_LINK_FIELD } from '../src/profile-paths.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';
import { pageBodyOf } from './helpers/site-shell.js';

/**
 * 自己紹介と外部リンクの形の検査と保存（#379 / M12-11 / 仕様 5.6・5.10）。
 *
 * # この検査が見ているもの（#379 の acceptance と constraints）
 *
 *   1. **`javascript:` を含むリンクが弾かれる**（**変異で確認した**。`normalizeProfileLink` の
 *      `url.protocol !== 'https:'` の判定を外すと「https 以外のスキーム」「画面の口」の it が赤く
 *      なる。表示の側の二重の守りは `test/author-profile.test.ts` が見る）
 *   2. 自己紹介の HTML がフォームの初期値でそのまま描画されない（作者ページ側は
 *      `test/author-profile.test.ts`）
 *   3. 8.3 の表で断り、**語も分類も応答に出さない**
 *   4. 長さの上限で**切らずに断る**・禁じた文字の組が表示名（と作品の説明）と同じ
 *   5. 変更の間隔（60 秒）と、**断った要求は 1 行も書かない**
 *   6. 変更で履歴が 1 行増え、**履歴の追記に失敗すればプロフィールも変わらない**
 *
 * 画面のタブの構成は `test/account.test.ts`、`/privacy` は `test/privacy.test.ts` が持つ。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-profile-page-00001';

/** このファイルが作る利用者の id の接頭辞（片付けの対象を絞る）。 */
const USER_PREFIX = 'profile-user-';

/** 固定の時刻（UNIX 秒）。60 秒の境界をこれを起点に動かす。 */
const NOW = 1_800_100_000;

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

// **このファイルが作った履歴を片付ける。** `profile_changes` は `users` を外部キーで指すので、
// 残すと `users` を消す別のテストが外部キーに阻まれうる（`test/work-description.test.ts` と同じ）。
afterAll(async () => {
  await env.DB.prepare(
    `delete from ${PROFILE_CHANGES_TABLE} where user_id like '${USER_PREFIX}%'`,
  ).run();
});

/**
 * 利用者を 1 人用意する。
 *
 * @returns 利用者の id
 */
async function seedUser(): Promise<string> {
  const id = `${USER_PREFIX}${crypto.randomUUID()}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, 'プロフィールの人')
    .run();
  return id;
}

/**
 * 利用者のセッション cookie を作る（発行時刻は実時刻。`test/account.test.ts` と同じ理由）。
 *
 * @param userId 利用者の id
 * @returns `名前=値`
 */
async function cookieFor(userId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId, issuedAt, expiresAt: issuedAt + 3600 }, SECRET);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * 保存されているプロフィールを引く。
 *
 * @param userId 利用者の id
 * @returns 自己紹介・リンク（JSON）・時刻
 */
async function profileOf(
  userId: string,
): Promise<{ bio: string; profile_links: string; profile_set_at: number | null }> {
  const row = await env.DB.prepare(
    'select bio, profile_links, profile_set_at from users where id = ?',
  )
    .bind(userId)
    .first<{ bio: string; profile_links: string; profile_set_at: number | null }>();
  expect(row, `${userId} の行`).not.toBeNull();
  return row!;
}

/**
 * その利用者の履歴を書いた順に引く。
 *
 * @param userId 利用者の id
 * @returns 履歴の行
 */
async function historyOf(userId: string): Promise<
  { old_bio: string; new_bio: string; old_links: string; new_links: string; changed_at: number }[]
> {
  const rows = await env.DB.prepare(
    `select old_bio, new_bio, old_links, new_links, changed_at
       from ${PROFILE_CHANGES_TABLE} where user_id = ? order by rowid`,
  )
    .bind(userId)
    .all<{ old_bio: string; new_bio: string; old_links: string; new_links: string; changed_at: number }>();
  return rows.results;
}

/**
 * 自己紹介と外部リンクを POST する（素の `<form>` と同じ形）。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param bio 自己紹介
 * @param links リンクの欄の値
 * @param contentType `Content-Type`
 * @returns レスポンス
 */
async function postProfile(
  routes: readonly Route[],
  cookie: string | null,
  bio: string,
  links: readonly string[],
  contentType = 'application/x-www-form-urlencoded',
): Promise<Response> {
  const body = new URLSearchParams();
  body.append(BIO_FIELD, bio);
  for (const link of links) {
    body.append(PROFILE_LINK_FIELD, link);
  }
  const headers: Record<string, string> = { 'content-type': contentType, accept: 'text/html' };
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_PROFILE_PATH}`, { method: 'POST', headers, body: body.toString() }),
    testEnv(),
  );
}

/**
 * `/account` を開き、外枠を除いた本文を返す。
 *
 * @param cookie `Cookie` ヘッダ
 * @param query query 文字列
 * @returns 状態と本文
 */
async function openAccount(cookie: string, query = ''): Promise<{ status: number; body: string }> {
  const response = await dispatch(
    createAccountRoutes(),
    new Request(`${APP_ORIGIN}${ACCOUNT_PATH}${query}`, { headers: { cookie } }),
    testEnv(),
  );
  return { status: response.status, body: pageBodyOf(await response.text()) };
}

describe('外部リンクは構文解析してから https: に限る（5.6 / 5.10）', () => {
  it('https の URL は通り、解析した href へ正規化される', () => {
    expect(normalizeProfileLink('https://example.com')).toEqual({ ok: true, href: 'https://example.com/' });
    expect(normalizeProfileLink('  HTTPS://Example.COM/a?b=1#c  ')).toEqual({
      ok: true,
      href: 'https://example.com/a?b=1#c',
    });
  });

  it('https 以外のスキーム（javascript: / data: / http: など）を弾く', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(document.cookie)',
      'javascript://https://example.com/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'http://example.com/',
      'mailto:someone@example.com',
      'ftp://example.com/',
      'vbscript:msgbox(1)',
    ]) {
      expect(normalizeProfileLink(raw), raw).toEqual({ ok: false, reason: 'link-not-https' });
    }
  });

  it('解析できない文字列（相対 URL・スキームの無い綴り）を弾く', () => {
    for (const raw of ['example.com', '/users/me', '//example.com/', 'https://', 'https:// /']) {
      expect(normalizeProfileLink(raw).ok, raw).toBe(false);
    }
  });

  it('制御文字や向きを変える書式文字を含む入力は、解析に除かせずに断る', () => {
    // `new URL` はタブや改行を黙って除く。**`java\tscript:` が `javascript:` として解析される**
    // 綴りも、ここで断る（スキームの判定より前）。
    for (const raw of ['java\tscript:alert(1)', 'https://exa\nmple.com/', `https://example.com/${'\u202e'}moc`]) {
      expect(normalizeProfileLink(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'link-invalid' });
    }
  });

  it('先頭や末尾に置いた禁じた文字も、trim で消さずに断る（前後の普通の空白は除いて通す）', () => {
    // **`String#trim` はタブ・改行・U+2028 / U+2029 も除く**（PR #418 の Copilot レビュー）。
    // 検査を trim の後に置くと、端の禁じた文字が黙って消えて通る。関数と、フォームから受け取った
    // 値をそのまま渡す `validateProfile` の両方で見る。
    for (const raw of ['\thttps://example.com/', 'https://example.com/\n', 'https://example.com/\u2028']) {
      expect(normalizeProfileLink(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'link-invalid' });
      expect(validateProfile('', [raw]), JSON.stringify(raw)).toEqual({ ok: false, reason: 'link-invalid' });
    }
    expect(normalizeProfileLink(' https://example.com/ ')).toEqual({ ok: true, href: 'https://example.com/' });
    expect(validateProfile('', [' https://example.com/ '])).toEqual({
      ok: true,
      profile: { bio: '', links: ['https://example.com/'] },
    });
  });

  it('ユーザー情報を含む URL（見た目の先頭と行き先が違う）を断る', () => {
    for (const raw of ['https://a@b.example/', 'https://example.com@evil.example/', 'https://user:pass@example.com/']) {
      expect(normalizeProfileLink(raw), raw).toEqual({ ok: false, reason: 'link-credentials' });
    }
  });

  it('国際化ドメイン名は punycode の href になる（見た目の似たドメインを見分けられるように）', () => {
    const normalized = normalizeProfileLink('https://例え.jp/パス');
    expect(normalized.ok).toBe(true);
    const href = (normalized as { href: string }).href;
    expect(href.startsWith('https://xn--')).toBe(true);
    expect(href).toContain('/%E3%83%91%E3%82%B9');
    // href は ASCII だけで出来ている（属性値にも文字にもそのまま出す）。
    expect(/^[\x21-\x7e]+$/u.test(href)).toBe(true);
  });

  it(`長さは入力と href の両方で ${PROFILE_LINK_MAX_LENGTH} 文字まで`, () => {
    const base = 'https://example.com/';
    expect(normalizeProfileLink(`${base}${'a'.repeat(PROFILE_LINK_MAX_LENGTH - base.length)}`).ok).toBe(true);
    expect(normalizeProfileLink(`${base}${'a'.repeat(PROFILE_LINK_MAX_LENGTH - base.length + 1)}`)).toEqual({
      ok: false,
      reason: 'link-too-long',
    });
    // 入力は短いが、符号化すると上限を超える（1 文字が 9 文字になる）。
    expect(normalizeProfileLink(`${base}${'あ'.repeat(60)}`)).toEqual({ ok: false, reason: 'link-too-long' });
  });

  it(`空の欄は無視し、${PROFILE_LINK_MAX_COUNT} 本を超えると断る`, () => {
    expect(validateProfile('', ['', ' https://a.example ', '', 'https://b.example/'])).toEqual({
      ok: true,
      profile: { bio: '', links: ['https://a.example/', 'https://b.example/'] },
    });
    const many = Array.from({ length: PROFILE_LINK_MAX_COUNT + 1 }, (_, i) => `https://e${i}.example/`);
    expect(validateProfile('', many)).toEqual({ ok: false, reason: 'too-many-links' });
  });

  it('保存された値を読むときも、同じ検査を通ったものだけを返す', () => {
    expect(parseStoredProfileLinks(encodeProfileLinks(['https://a.example/']))).toEqual(['https://a.example/']);
    expect(parseStoredProfileLinks('["javascript:alert(1)","https://a.example/"]')).toEqual(['https://a.example/']);
    // 正規化で綴りが変わる値は、保存の経路を通っていない。
    expect(parseStoredProfileLinks('["https://A.example"]')).toEqual([]);
    for (const broken of ['not json', '{"a":1}', '[1,null]', null, undefined, 42]) {
      expect(parseStoredProfileLinks(broken), String(broken)).toEqual([]);
    }
  });
});

describe('自己紹介の形（長さは切らずに断る・禁じた文字は表示名と同じ組）', () => {
  it(`${BIO_MAX_LENGTH} 文字ちょうどは通り、1 文字超えると断る（黙って切らない）`, () => {
    expect(validateBio('あ'.repeat(BIO_MAX_LENGTH))).toEqual({ ok: true, value: 'あ'.repeat(BIO_MAX_LENGTH) });
    expect(validateBio('あ'.repeat(BIO_MAX_LENGTH + 1))).toEqual({ ok: false, reason: 'bio-too-long' });
  });

  it('長さはコードポイントで数え、改行（\\r\\n）は 1 文字に数える', () => {
    expect(validateBio('🐱'.repeat(BIO_MAX_LENGTH)).ok).toBe(true);
    expect(validateBio('🐱'.repeat(BIO_MAX_LENGTH + 1)).ok).toBe(false);
    expect(validateBio(`${'あ\r\n'.repeat(BIO_MAX_LENGTH / 2 - 1)}ああ`).ok).toBe(true);
  });

  it('改行（LF / CR / CRLF）は通って LF へ畳まれ、前後の空白は除かれる', () => {
    expect(validateBio('\n a\nb\r\nc\rd \r\n')).toEqual({ ok: true, value: 'a\nb\nc\nd' });
  });

  it('先頭や末尾に置いた禁じた文字も、trim で消さずに断る', () => {
    for (const character of ['\u2028', '\u2029', '\t', '\u202e']) {
      expect(validateBio(`${character}自己紹介`).ok).toBe(false);
      expect(validateBio(`自己紹介${character}`).ok).toBe(false);
    }
  });

  it('改行以外で禁じる文字の組は、表示名の検査と 1 文字も違わない（作品の説明と同じ組）', () => {
    // **書き写した組は必ず腐る**（shared-ai-rules 12 章）。`src/profile.ts` は表示名の検査を
    // import できない（循環する）ので、**振る舞いを文字ごとに突き合わせる。**
    // `test/work-description.test.ts` が作品の説明について同じ突き合わせをしている。
    const mismatches: string[] = [];
    const codePoints: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      codePoints.push(cp);
    }
    codePoints.push(0x1f431, 0xe0001, 0xe007f, 0x10fffd);
    for (const cp of codePoints) {
      if (cp === 0x0a || cp === 0x0d) {
        continue;
      }
      const sample = `a${String.fromCodePoint(cp)}b`;
      const name = validateDisplayName(sample);
      const nameRefused = !name.ok && name.reason === 'control-char';
      const bioRefused = !validateBio(sample).ok;
      if (nameRefused !== bioRefused) {
        mismatches.push(cp.toString(16));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('HTML に効く文字は通す（防ぐのは出力側のエスケープである）', () => {
    expect(validateBio('<script>alert("x")</script>')).toEqual({
      ok: true,
      value: '<script>alert("x")</script>',
    });
  });
});

describe('8.3 の表を掛ける（改名・説明と同じ inspectText）', () => {
  // **表から 1 語借りる**（語を書き写さない）。
  const denied = DENIED_TERMS[0]!;

  it('自己紹介・リンクの綴り・パーセント符号化したリンクのどれに含めても断る', () => {
    expect(validateProfile(`よろしく\n${denied.term}`, [])).toEqual({ ok: false, reason: 'profile-denied-term' });
    expect(validateProfile('', [`https://example.com/${denied.term}`])).toEqual({
      ok: false,
      reason: 'profile-denied-term',
    });
    expect(validateProfile('', [`https://example.com/${encodeURIComponent(denied.term)}`])).toEqual({
      ok: false,
      reason: 'profile-denied-term',
    });
    // 空の自己紹介とリンク無しは掛けない（消す操作を 8.3 の都合で断らない）。
    expect(validateProfile('', []).ok).toBe(true);
  });

  it('断った応答に語も分類も出ず、何も書かない', async () => {
    const userId = await seedUser();
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postProfile(routes, await cookieFor(userId), `これは${denied.term}です`, []);
    expect(response.status).toBe(400);
    const body = pageBodyOf(await response.text());
    // 送った文章は欄へ戻すので、**欄の外**に語が出ていないことを見る。
    const outsideForm = body.replace(/<textarea[\s\S]*?<\/textarea>/u, '');
    expect(outsideForm).not.toContain(denied.term);
    expect(body).not.toContain(denied.category);
    expect(body).toContain('使えない語が含まれています');
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });
});

describe('保存（POST /api/account/profile）', () => {
  it('保存して /account へ戻し、フォームに保存した値と知らせが出る', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });

    const response = await postProfile(routes, cookie, 'ゲームを作っています。\r\nよろしく', [
      'https://example.com/me',
      '',
      'https://example.org',
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=profile`);
    expect(await profileOf(userId)).toEqual({
      bio: 'ゲームを作っています。\nよろしく',
      profile_links: '["https://example.com/me","https://example.org/"]',
      profile_set_at: NOW,
    });

    const { status, body } = await openAccount(cookie, '?saved=profile');
    expect(status).toBe(200);
    expect(body).toContain('自己紹介と外部リンクを保存しました。');
    expect(body).not.toContain('表示名を変更しました。');
    expect(body).toContain('ゲームを作っています。\nよろしく</textarea>');
    expect(body).toContain('value="https://example.com/me"');
    expect(body).toContain('value="https://example.org/"');
    // 書く人にも「運営は検証していない」旨を見せる。
    expect(body).toContain(PROFILE_LINKS_UNVERIFIED_NOTICE);
  });

  it('端にタブ・改行・U+2028 を置いたリンクは画面の口でも断り、何も書かない（前後の普通の空白は通す）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    for (const raw of ['\thttps://example.com/', 'https://example.com/\n', 'https://example.com/\u2028']) {
      const response = await postProfile(routes, cookie, '', [raw]);
      expect(response.status, JSON.stringify(raw)).toBe(400);
      expect(pageBodyOf(await response.text()), JSON.stringify(raw)).toContain(
        '<p class="error" role="alert">外部リンクに、URL として読めないものがあります。',
      );
    }
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });

    const spaced = await postProfile(routes, cookie, '', [' https://example.com/ ']);
    expect(spaced.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=profile`);
    expect((await profileOf(userId)).profile_links).toBe('["https://example.com/"]');
  });

  it('javascript: のリンクは画面の口でも断り、送った値を欄へ戻すだけで何も書かない', async () => {
    const userId = await seedUser();
    const routes = createAccountRoutes({ now: () => NOW });
    const response = await postProfile(routes, await cookieFor(userId), '自己紹介', ['javascript:alert(1)']);
    expect(response.status).toBe(400);
    const body = pageBodyOf(await response.text());
    // **知らせの `<p>` そのものを見る。** フォームの説明文にも「https:// から始まる URL だけを
    // 使えます」があるので、文言だけを探すと、別の理由で断られても緑になる。
    expect(body).toContain('<p class="error" role="alert">外部リンクには https:// から始まる URL だけを使えます。</p>');
    // 欄へ戻す（打ち直させない）が、**リンクとしては出さない**。
    expect(body).toContain('value="javascript:alert(1)"');
    expect(body).not.toContain('href="javascript:');
    expect(body).toContain('自己紹介</textarea>');
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });

  it('断ったときに欄へ戻す値も、フォームの初期値もエスケープする', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });
    const hostile = '</textarea><script>alert(1)</script>"';
    // 長すぎて断られる自己紹介に、HTML を混ぜる。
    const refused = await postProfile(routes, cookie, `${hostile}${'あ'.repeat(BIO_MAX_LENGTH)}`, ['"><img src=x>']);
    expect(refused.status).toBe(400);
    const refusedBody = await refused.text();
    expect(refusedBody).not.toContain('<script>alert(1)</script>');
    // **欄へ戻した値そのもの**を探す。`"><img` の断片だけで探すと、ヘッダのロゴの `<picture>`（`<source …><img …>`）に
    // 当たる（#440）——正当なマークアップと、エスケープされなかった入力を区別できない。
    expect(refusedBody).not.toContain('"><img src=x>');
    expect(refusedBody).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(refusedBody).toContain('&lt;/textarea&gt;&lt;script&gt;');

    // 通る長さなら保存され、次に開いたフォームでもエスケープされる。
    expect((await postProfile(routes, cookie, hostile, [])).status).toBe(303);
    const { body } = await openAccount(cookie);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;</textarea>');
  });

  it('同じ値の入れ直しは成功にし、書かない（履歴も積まない）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });
    await postProfile(routes, cookie, '同じ', ['https://example.com/']);
    // **間隔の内側でも**同じ値なら「待ってください」と言わない。
    now = NOW + 1;
    const again = await postProfile(routes, cookie, '同じ', ['https://example.com']);
    expect(again.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=profile`);
    expect((await profileOf(userId)).profile_set_at).toBe(NOW);
    expect(await historyOf(userId)).toHaveLength(1);
  });

  it(`${PROFILE_CHANGE_INTERVAL_SECONDS} 秒以内の 2 回目は 429 で断って 1 行も書かず、空けば書く`, async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });

    await postProfile(routes, cookie, '1 回目', []);

    now = NOW + PROFILE_CHANGE_INTERVAL_SECONDS - 1;
    const tooSoon = await postProfile(routes, cookie, '2 回目', ['https://example.com/']);
    expect(tooSoon.status).toBe(429);
    const tooSoonBody = pageBodyOf(await tooSoon.text());
    expect(tooSoonBody).toContain(`${PROFILE_CHANGE_INTERVAL_SECONDS} 秒に 1 回まで`);
    // 断っても入力は欄へ戻す。
    expect(tooSoonBody).toContain('2 回目</textarea>');
    expect(await profileOf(userId)).toEqual({ bio: '1 回目', profile_links: '[]', profile_set_at: NOW });
    expect(await historyOf(userId)).toHaveLength(1);

    now = NOW + PROFILE_CHANGE_INTERVAL_SECONDS;
    const later = await postProfile(routes, cookie, '3 回目', ['https://example.com/']);
    expect(later.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=profile`);
    expect(await profileOf(userId)).toEqual({
      bio: '3 回目',
      profile_links: '["https://example.com/"]',
      profile_set_at: now,
    });
  });

  it('自己紹介を空にし、リンクを消すこともできる（それも履歴に残る）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    let now = NOW;
    const routes = createAccountRoutes({ now: () => now });
    await postProfile(routes, cookie, '書いた', ['https://example.com/']);
    now = NOW + PROFILE_CHANGE_INTERVAL_SECONDS;
    await postProfile(routes, cookie, '   ', ['', '', '']);
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: now });
    expect((await historyOf(userId)).at(-1)).toEqual({
      old_bio: '書いた',
      new_bio: '',
      old_links: '["https://example.com/"]',
      new_links: '[]',
      changed_at: now,
    });
  });

  it('未ログイン・BAN された利用者はログインへ送り、何も書かない', async () => {
    const routes = createAccountRoutes({ now: () => NOW });
    const anonymous = await postProfile(routes, null, '自己紹介', []);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe(LOGIN_PATH);

    const userId = await seedUser();
    await env.DB.prepare('update users set banned_at = 1 where id = ?').bind(userId).run();
    const banned = await postProfile(routes, await cookieFor(userId), '自己紹介', []);
    expect(banned.headers.get('location')).toBe(LOGIN_PATH);
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
  });

  it('フォーム以外の形式・大きすぎる本文は /account の理由へ送り、書かない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const routes = createAccountRoutes({ now: () => NOW });

    const plain = await postProfile(routes, cookie, '自己紹介', [], 'text/plain');
    expect(plain.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=invalid-request`);

    const huge = await postProfile(routes, cookie, '🐱'.repeat(2000), []);
    expect(huge.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=profile-too-large`);
    expect((await openAccount(cookie, '?reason=profile-too-large')).body).toContain('送られた内容が大きすぎます。');

    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
  });
});

describe('プロフィールと履歴は 1 つの batch で書く（#405 の申し送り）', () => {
  it('変えると、旧い値と新しい値と時刻を 1 行積む', async () => {
    const userId = await seedUser();
    const profile = { bio: 'はじめまして', links: ['https://example.com/'] };
    expect(await changeProfile(env.DB, userId, profile, NOW)).toEqual({ ok: true, changed: true });
    expect(await historyOf(userId)).toEqual([
      {
        old_bio: '',
        new_bio: 'はじめまして',
        old_links: '[]',
        new_links: '["https://example.com/"]',
        changed_at: NOW,
      },
    ]);
  });

  it('間隔で断った変更は、履歴を書かない', async () => {
    const userId = await seedUser();
    await changeProfile(env.DB, userId, { bio: '1', links: [] }, NOW);
    expect(await changeProfile(env.DB, userId, { bio: '2', links: [] }, NOW + 1)).toEqual({
      ok: false,
      reason: 'profile-too-soon',
    });
    expect((await historyOf(userId)).map((row) => row.new_bio)).toEqual(['1']);
  });

  it('履歴の追記に失敗したら、プロフィールも変わらない', async () => {
    // **`changed_at > 0` の CHECK を踏ませる。** 時刻 0 でも間隔の条件は `profile_set_at is null`
    // で通るので、落ちるのは履歴の insert だけで、batch ごと巻き戻る。
    const userId = await seedUser();
    await expect(changeProfile(env.DB, userId, { bio: '書けない', links: [] }, 0)).rejects.toThrow();
    expect(await profileOf(userId)).toEqual({ bio: '', profile_links: '[]', profile_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });
});
