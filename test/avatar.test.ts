import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountRoutes } from '../src/account.js';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { handleAppRequest } from '../src/app.js';
import {
  AVATAR_CHANGES_TABLE,
  AVATAR_CHANGE_INTERVAL_SECONDS,
  AVATAR_CROP_NOTICE,
  AVATAR_HISTORY_RETENTION_DAYS,
  avatarHistoryImageState,
  removeAvatar,
  saveAvatar,
  sha256Hex,
} from '../src/avatar.js';
import type { AvatarEncodeResult, EncodeAvatar } from '../src/avatar-client.js';
import {
  AVATAR_FUNCTION_NAME_VAR,
  AvatarEncodeFailed,
  AvatarNotConfigured,
  SYNC_INVOCATION_TYPE,
  bytesToBase64,
  createAvatarEncode,
} from '../src/avatar-client.js';
import { AVATAR_MAX_BYTES, inspectAvatarImage } from '../src/avatar-image.js';
import {
  ACCOUNT_AVATAR_PATH,
  ACCOUNT_AVATAR_REMOVE_PATH,
  AVATAR_FILE_FIELD,
  AVATAR_HISTORY_PREFIX,
  avatarHistoryKey,
  avatarObjectKey,
} from '../src/avatar-paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { PUBLISHED_STATUS, listPublishedGames } from '../src/games.js';
import { handleSandboxRequest } from '../src/sandbox.js';
import { resolveSiteViewer, siteHead } from '../src/html.js';
import { purgeListCache } from '../src/list-cache.js';
import type { Route } from '../src/routes.js';
import { dispatch } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { authorCacheKey, authorPagePath } from '../src/users-page.js';
import { renderWorkCard } from '../src/work-card.js';
import { ascii, concatBytes, gifBytes, jpegBytes, pngBytes, svgBytes, webpVp8xBytes } from './helpers/avatar-images.js';
import { applySchema } from './helpers/schema.js';

/**
 * アイコン画像（#380 / M12-12 / 仕様 5.10・3.7・7.2・2.3.8）——受け取り・保存・差し替え・外す・配信・表示。
 *
 * # この検査が見ているもの（#380 の acceptance と、利用者の決定）
 *
 *   1. **SVG とアニメーション画像が断られる**——口の段で、**変換（Lambda）を 1 度も呼ばずに**断る
 *      （判定そのものは `test/avatar-image.test.ts`、関数の側は `lambda/avatar-encode/test/`）
 *   2. **上限を超えた画像が断られる**（容量・寸法。黙って縮めない）
 *   3. **差し替えた古い画像は履歴の接頭辞（`avatars/history/`）へ移る**（acceptance の読み替え。30 日で
 *      消えるのはライフサイクル規則で、規則と接頭辞の一致は `scripts/check-avatar-copies.sh` と
 *      `scripts/report-selftest.sh` の 15 節が見る）
 *   4. **変更の履歴を追記だけで持ち、更新と 1 つの batch で書く**（#405 の申し送り）。**履歴の追記に
 *      失敗したら、D1 も R2 の現行の画像も元に戻る**
 *   5. **配信はサンドボックス用ホストだけ**で、`Content-Type` を固定し、`nosniff` とサンドボックスの CSP を
 *      付ける。**版（`?v=`）が一致すれば `immutable`、そうでなければ再検証**（仕様 2.3.8）
 *   6. ヘッダ・カード・作者ページにアイコンが出る（未設定なら出ない）
 *
 * `/privacy` の収集項目と保存期間は `test/privacy.test.ts` が見る。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SANDBOX_ORIGIN = `https://${env.SANDBOX_HOST}`;
const SECRET = 'test-secret-value-for-avatar-page-0000001';

/** 固定の時刻（UNIX 秒）。 */
const NOW = 1_800_200_000;

/** このファイルが作った利用者（片付けの対象）。 */
const createdUsers: string[] = [];

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

// **履歴は `users` を外部キーで指すので、作った分だけ片付ける**（`test/profile.test.ts` と同じ理由）。
afterAll(async () => {
  for (const id of createdUsers) {
    await env.DB.prepare(`delete from ${AVATAR_CHANGES_TABLE} where user_id = ?`).bind(id).run();
  }
});

/**
 * 利用者を 1 人用意する（**id は UUID**——アイコンの URL は UUID の形の id でしか組み立てない）。
 *
 * @param displayName 表示名
 * @returns 利用者の id
 */
async function seedUser(displayName = 'アイコンの人'): Promise<string> {
  const id = crypto.randomUUID();
  createdUsers.push(id);
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at) values (?, ?, ?, ?, 1)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, displayName)
    .run();
  return id;
}

/**
 * 利用者のセッション cookie を作る。
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
 * 関数が返したことにする WebP（256 × 256 の見出し。`seed` で中身を変え、SHA-256 を別にする）。
 *
 * @param seed 中身を変える値
 * @returns WebP
 */
function encodedWebp(seed: number): Uint8Array {
  return concatBytes(webpVp8xBytes(256, 256), ascii('JUNK'), [4, 0, 0, 0], [seed & 0xff, (seed >> 8) & 0xff, 0, 0]);
}

/** 呼ばれた回数と、受け取った画像を覚える変換の段。 */
interface FakeEncode {
  readonly encode: EncodeAvatar;
  readonly calls: Uint8Array[];
}

/**
 * 変換の段を差し替える（**実 Lambda を呼ばない**）。
 *
 * @param result 返す結果（関数なら呼ばれるたびに作る。例外を投げてもよい）
 * @returns 差し替えた段と、呼ばれた記録
 */
function fakeEncode(result: AvatarEncodeResult | (() => AvatarEncodeResult)): FakeEncode {
  const calls: Uint8Array[] = [];
  return {
    calls,
    encode: async (_env, image) => {
      calls.push(image);
      return typeof result === 'function' ? result() : result;
    },
  };
}

/**
 * 経路表を作る（時刻と変換の段を差し替える）。
 *
 * @param encode 変換の段
 * @param now 現在時刻
 * @returns 経路表
 */
function routesWith(encode: EncodeAvatar, now = NOW): readonly Route[] {
  return createAccountRoutes({ now: () => now, encodeAvatar: encode });
}

/**
 * 素のフォームと同じ形（`multipart/form-data`）でアイコンを送る。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ（未ログインなら null）
 * @param bytes ファイルの中身（null ならファイルを付けない）
 * @param fileName ファイル名（拡張子は判定に使われない）
 * @returns レスポンス
 */
async function postAvatar(
  routes: readonly Route[],
  cookie: string | null,
  bytes: Uint8Array | null,
  fileName = 'icon.png',
): Promise<Response> {
  const form = new FormData();
  if (bytes !== null) {
    form.append(AVATAR_FILE_FIELD, new File([bytes], fileName, { type: 'image/png' }));
  }
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = cookie;
  }
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_AVATAR_PATH}`, { method: 'POST', headers, body: form }),
    testEnv(),
  );
}

/**
 * アイコンを外す口を叩く。
 *
 * @param routes 経路表
 * @param cookie `Cookie` ヘッダ
 * @returns レスポンス
 */
async function postRemove(routes: readonly Route[], cookie: string): Promise<Response> {
  return await dispatch(
    routes,
    new Request(`${APP_ORIGIN}${ACCOUNT_AVATAR_REMOVE_PATH}`, { method: 'POST', headers: { cookie } }),
    testEnv(),
  );
}

/**
 * `users` のアイコンの 2 列。
 *
 * @param userId 利用者の id
 * @returns 2 列
 */
async function avatarColumns(userId: string): Promise<{ avatar_sha256: string | null; avatar_set_at: number | null }> {
  const row = await env.DB.prepare('select avatar_sha256, avatar_set_at from users where id = ?')
    .bind(userId)
    .first<{ avatar_sha256: string | null; avatar_set_at: number | null }>();
  expect(row).not.toBeNull();
  return row!;
}

/**
 * 履歴を古い順に引く。
 *
 * @param userId 利用者の id
 * @returns 履歴
 */
async function historyOf(
  userId: string,
): Promise<{ old_sha256: string | null; new_sha256: string | null; history_key: string | null; changed_at: number }[]> {
  const result = await env.DB.prepare(
    `select old_sha256, new_sha256, history_key, changed_at from ${AVATAR_CHANGES_TABLE}
      where user_id = ? order by changed_at, rowid`,
  )
    .bind(userId)
    .all<{ old_sha256: string | null; new_sha256: string | null; history_key: string | null; changed_at: number }>();
  return result.results;
}

/**
 * R2 のオブジェクトの中身を読む（無ければ null）。
 *
 * @param key キー
 * @returns 中身
 */
async function r2Bytes(key: string): Promise<Uint8Array | null> {
  const object = await env.BUCKET.get(key);
  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}

describe('設定する（POST /api/account/avatar）', () => {
  it('初めて設定すると、変換した画像を現行のキーへ置き、列と履歴を 1 つの batch で書く', async () => {
    const userId = await seedUser();
    const webp = encodedWebp(1);
    const fake = fakeEncode({ ok: true, webp });
    const uploaded = pngBytes(800, 600);

    const response = await postAvatar(routesWith(fake.encode), await cookieFor(userId), uploaded);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=avatar`);

    // **変換へ渡したのは送られたバイト列そのもの**で、**置いたのは変換の出力**である（受け取った画像をそのまま配らない）。
    expect(fake.calls).toHaveLength(1);
    expect([...fake.calls[0]!]).toEqual([...uploaded]);
    expect(await r2Bytes(avatarObjectKey(userId))).toEqual(webp);
    const object = await env.BUCKET.head(avatarObjectKey(userId));
    expect(object?.customMetadata?.['setAt']).toBe(String(NOW));

    const sha = await sha256Hex(webp);
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: sha, avatar_set_at: NOW });
    expect(await historyOf(userId)).toEqual([{ old_sha256: null, new_sha256: sha, history_key: null, changed_at: NOW }]);
  });

  it('差し替えると、古い画像は履歴の接頭辞へ移り、現行のキーは新しい画像になる（acceptance の読み替え）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const first = encodedWebp(2);
    const second = encodedWebp(3);
    await postAvatar(routesWith(fakeEncode({ ok: true, webp: first }).encode), cookie, pngBytes(10, 10));

    const later = NOW + AVATAR_CHANGE_INTERVAL_SECONDS;
    const response = await postAvatar(routesWith(fakeEncode({ ok: true, webp: second }).encode, later), cookie, jpegBytes(10, 10));
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=avatar`);

    const firstSha = await sha256Hex(first);
    const secondSha = await sha256Hex(second);
    const historyKey = avatarHistoryKey(userId, later, firstSha);
    expect(historyKey.startsWith(AVATAR_HISTORY_PREFIX)).toBe(true);
    // **古い画像は現行のキーから消え（上書き）、履歴の接頭辞にだけ残る。**
    expect(await r2Bytes(avatarObjectKey(userId))).toEqual(second);
    expect(await r2Bytes(historyKey)).toEqual(first);
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: secondSha, avatar_set_at: later });
    expect((await historyOf(userId)).at(-1)).toEqual({
      old_sha256: firstSha,
      new_sha256: secondSha,
      history_key: historyKey,
      changed_at: later,
    });
  });

  it(`${AVATAR_CHANGE_INTERVAL_SECONDS} 秒以内の 2 回目は、変換を呼ばずに断り、何も書かない`, async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    await postAvatar(routesWith(fakeEncode({ ok: true, webp: encodedWebp(4) }).encode), cookie, pngBytes(10, 10));

    const fake = fakeEncode({ ok: true, webp: encodedWebp(5) });
    const response = await postAvatar(routesWith(fake.encode, NOW + AVATAR_CHANGE_INTERVAL_SECONDS - 1), cookie, pngBytes(10, 10));
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=avatar-too-soon`);
    expect(fake.calls).toHaveLength(0);
    expect(await r2Bytes(avatarObjectKey(userId))).toEqual(encodedWebp(4));
    expect(await historyOf(userId)).toHaveLength(1);
  });

  it('SVG・GIF・アニメーション画像・上限を超えた寸法は、変換を 1 度も呼ばずに断る（acceptance）', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const cases: readonly [Uint8Array, string][] = [
      [svgBytes(), 'avatar-svg'],
      [gifBytes(), 'avatar-gif'],
      [pngBytes(64, 64, { actl: true }), 'avatar-animated'],
      [webpVp8xBytes(64, 64, { animatedFlag: true }), 'avatar-animated'],
      [webpVp8xBytes(64, 64, { animChunk: true }), 'avatar-animated'],
      [pngBytes(4097, 10), 'avatar-too-large-dimensions'],
    ];
    for (const [bytes, reason] of cases) {
      const fake = fakeEncode({ ok: true, webp: encodedWebp(6) });
      // **ファイル名を .png にしておく**——拡張子では判定しない。
      const response = await postAvatar(routesWith(fake.encode), cookie, bytes, 'innocent.png');
      expect(response.headers.get('location'), reason).toBe(`${ACCOUNT_PATH}?reason=${reason}`);
      expect(fake.calls, reason).toHaveLength(0);
    }
    expect(await r2Bytes(avatarObjectKey(userId))).toBeNull();
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: null, avatar_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });

  it(`容量の上限（${AVATAR_MAX_BYTES} バイト）を 1 バイトでも超えれば、変換を呼ばずに断る（黙って縮めない）`, async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const header = pngBytes(64, 64);
    const oversized = concatBytes(header, new Uint8Array(AVATAR_MAX_BYTES + 1 - header.length));
    const fake = fakeEncode({ ok: true, webp: encodedWebp(7) });
    const response = await postAvatar(routesWith(fake.encode), cookie, oversized);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=avatar-too-large`);
    expect(fake.calls).toHaveLength(0);

    // ちょうど上限なら、形の判定まで進む（ここでは変換まで届く）。
    const exact = concatBytes(header, new Uint8Array(AVATAR_MAX_BYTES - header.length));
    const accepted = await postAvatar(routesWith(fake.encode), cookie, exact);
    expect(accepted.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=avatar`);
    expect(fake.calls).toHaveLength(1);
  });

  it('ファイルが無い・フォームでない要求は断り、変換を呼ばない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const fake = fakeEncode({ ok: true, webp: encodedWebp(8) });
    expect((await postAvatar(routesWith(fake.encode), cookie, null)).headers.get('location')).toBe(
      `${ACCOUNT_PATH}?reason=avatar-missing`,
    );
    expect((await postAvatar(routesWith(fake.encode), cookie, new Uint8Array(0))).headers.get('location')).toBe(
      `${ACCOUNT_PATH}?reason=avatar-missing`,
    );
    const json = await dispatch(
      routesWith(fake.encode),
      new Request(`${APP_ORIGIN}${ACCOUNT_AVATAR_PATH}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      }),
      testEnv(),
    );
    expect(json.headers.get('location')).toBe(`${ACCOUNT_PATH}?reason=avatar-invalid-request`);
    expect(fake.calls).toHaveLength(0);
  });

  it('関数が断った理由を利用者の言葉へ引き直し、落ちた・変な形を返したときは保存しない', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const cases: readonly [FakeEncode, string][] = [
      [fakeEncode({ ok: false, reason: 'animated' }), 'avatar-animated'],
      [fakeEncode({ ok: false, reason: 'unsupported' }), 'avatar-unsupported'],
      [fakeEncode({ ok: false, reason: 'too-large' }), 'avatar-too-large-dimensions'],
      [fakeEncode({ ok: false, reason: 'broken' }), 'avatar-broken'],
      [
        fakeEncode(() => {
          throw new AvatarEncodeFailed(500, 'Unhandled');
        }),
        'avatar-failed',
      ],
      // **関数を信じ切らない**——256 × 256 の WebP でなければ置かない。
      [fakeEncode({ ok: true, webp: webpVp8xBytes(512, 512) }), 'avatar-failed'],
      [fakeEncode({ ok: true, webp: pngBytes(256, 256) }), 'avatar-failed'],
    ];
    for (const [fake, reason] of cases) {
      const response = await postAvatar(routesWith(fake.encode), cookie, pngBytes(32, 32));
      expect(response.headers.get('location'), reason).toBe(`${ACCOUNT_PATH}?reason=${reason}`);
    }
    expect(await r2Bytes(avatarObjectKey(userId))).toBeNull();
    expect(await historyOf(userId)).toEqual([]);
  });

  it('未ログインはログインへ送り、変換を呼ばない', async () => {
    const fake = fakeEncode({ ok: true, webp: encodedWebp(9) });
    const response = await postAvatar(routesWith(fake.encode), null, pngBytes(10, 10));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain(LOGIN_PATH);
    expect(fake.calls).toHaveLength(0);
  });

  it('同じ画像の上げ直しは成功にし、書かない（履歴も積まない）', async () => {
    const userId = await seedUser();
    const webp = encodedWebp(10);
    expect(await saveAvatar(env, userId, webp, NOW)).toEqual({ ok: true, changed: true });
    expect(await saveAvatar(env, userId, webp, NOW + 1)).toEqual({ ok: true, changed: false });
    expect(await historyOf(userId)).toHaveLength(1);
  });
});

describe('履歴と R2 は食い違わない（#405 の申し送り）', () => {
  it('履歴の追記が落ちたら、列も R2 の現行の画像も元に戻る（初めての設定では画像が消える）', async () => {
    // **`changed_at > 0` の CHECK を踏ませる**（時刻 0。間隔の条件は `avatar_set_at is null` で通る）。
    const userId = await seedUser();
    await expect(saveAvatar(env, userId, encodedWebp(11), 0)).rejects.toThrow();
    expect(await r2Bytes(avatarObjectKey(userId))).toBeNull();
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: null, avatar_set_at: null });
    expect(await historyOf(userId)).toEqual([]);
  });

  it('差し替えで履歴の追記が落ちたら、現行のキーは前の画像へ戻る', async () => {
    const userId = await seedUser();
    const first = encodedWebp(12);
    await saveAvatar(env, userId, first, NOW);
    // 間隔の条件を通すために時刻の列だけを空にし、時刻 0 で CHECK を踏ませる。
    await env.DB.prepare('update users set avatar_set_at = null where id = ?').bind(userId).run();
    await expect(saveAvatar(env, userId, encodedWebp(13), 0)).rejects.toThrow();
    expect(await r2Bytes(avatarObjectKey(userId))).toEqual(first);
    expect((await env.BUCKET.head(avatarObjectKey(userId)))?.customMetadata?.['setAt']).toBe(String(NOW));
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: await sha256Hex(first), avatar_set_at: null });
    expect(await historyOf(userId)).toHaveLength(1);
  });

  it('読んでから書くまでに別の変更が入った要求は、先に勝った画像を壊さない', async () => {
    const userId = await seedUser();
    await saveAvatar(env, userId, encodedWebp(14), NOW);
    // 別の要求が先に勝った状態を作る（列だけが進んでいる）。
    const winner = encodedWebp(15);
    await saveAvatar(env, userId, winner, NOW + AVATAR_CHANGE_INTERVAL_SECONDS);
    // 間隔の内側の 3 本目は断られ、現行のキーは勝った側のまま。
    expect(await saveAvatar(env, userId, encodedWebp(16), NOW + AVATAR_CHANGE_INTERVAL_SECONDS + 1)).toEqual({
      ok: false,
      reason: 'avatar-too-soon',
    });
    expect(await r2Bytes(avatarObjectKey(userId))).toEqual(winner);
  });
});

describe('外す（POST /api/account/avatar/remove）', () => {
  it('外すと、現行のキーは消え、画像は履歴の接頭辞に残り、履歴に「無い」への変更が積まれる', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const webp = encodedWebp(17);
    await saveAvatar(env, userId, webp, NOW);
    const later = NOW + AVATAR_CHANGE_INTERVAL_SECONDS;

    const response = await postRemove(routesWith(fakeEncode({ ok: false, reason: 'broken' }).encode, later), cookie);
    expect(response.headers.get('location')).toBe(`${ACCOUNT_PATH}?saved=avatar-removed`);

    const sha = await sha256Hex(webp);
    const historyKey = avatarHistoryKey(userId, later, sha);
    expect(await r2Bytes(avatarObjectKey(userId))).toBeNull();
    expect(await r2Bytes(historyKey)).toEqual(webp);
    expect(await avatarColumns(userId)).toEqual({ avatar_sha256: null, avatar_set_at: later });
    expect((await historyOf(userId)).at(-1)).toEqual({
      old_sha256: sha,
      new_sha256: null,
      history_key: historyKey,
      changed_at: later,
    });
  });

  it('設定していなければ成功にして何も書かず、外した直後の設定は間隔で断る', async () => {
    const userId = await seedUser();
    expect(await removeAvatar(env, userId, NOW)).toEqual({ ok: true, changed: false });
    expect(await historyOf(userId)).toEqual([]);

    await saveAvatar(env, userId, encodedWebp(18), NOW);
    await removeAvatar(env, userId, NOW + AVATAR_CHANGE_INTERVAL_SECONDS);
    expect(await saveAvatar(env, userId, encodedWebp(19), NOW + AVATAR_CHANGE_INTERVAL_SECONDS + 1)).toEqual({
      ok: false,
      reason: 'avatar-too-soon',
    });
  });
});

describe('配信（サンドボックス用ホストの /avatars/）', () => {
  /**
   * 画像を置いた利用者を用意する。
   *
   * @returns 利用者の id と画像
   */
  async function seededAvatar(): Promise<{ userId: string; webp: Uint8Array }> {
    const userId = await seedUser();
    const webp = encodedWebp(20);
    await saveAvatar(env, userId, webp, NOW);
    return { userId, webp };
  }

  it('版が一致すれば immutable で配り、Content-Type を固定し、nosniff とサンドボックスの CSP を付ける', async () => {
    const { userId, webp } = await seededAvatar();
    const response = await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp?v=${NOW}`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webp);
  });

  it('版が無い（ヘッダ）・一致しない要求は再検証にし、If-None-Match が合えば 304', async () => {
    const { userId } = await seededAvatar();
    for (const query of ['', `?v=${NOW - 1}`, '?v=abc']) {
      const response = await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp${query}`), env);
      expect(response.status, query).toBe(200);
      expect(response.headers.get('cache-control'), query).toBe('public, no-cache');
    }
    const first = await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`), env);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    const again = await handleSandboxRequest(
      new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`, { headers: { 'if-none-match': etag! } }),
      env,
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('無いアイコンは透明な 1px の WebP を再検証で返す（ヘッダの壊れた画像の印を出さない）', async () => {
    const userId = crypto.randomUUID();
    const missing = await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`), env);
    expect(missing.status).toBe(200);
    expect(missing.headers.get('content-type')).toBe('image/webp');
    expect(missing.headers.get('cache-control')).toBe('public, no-cache');
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await missing.arrayBuffer());
    expect(inspectAvatarImage(bytes)).toEqual({ ok: true, format: 'webp', width: 1, height: 1 });
    const etag = missing.headers.get('etag');
    const again = await handleSandboxRequest(
      new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`, { headers: { 'if-none-match': etag! } }),
      env,
    );
    expect(again.status).toBe(304);

    // **付けたら、同じ ETag を持つ再検証にも本物を返す**（透明な画像が張り付かない）。
    await env.BUCKET.put(avatarObjectKey(userId), encodedWebp(25), { customMetadata: { setAt: String(NOW) } });
    const after = await handleSandboxRequest(
      new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`, { headers: { 'if-none-match': etag! } }),
      env,
    );
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(encodedWebp(25));
  });

  it('綴りの違う id・履歴の接頭辞は 404、GET / HEAD 以外は 405', async () => {
    const { userId, webp } = await seededAvatar();
    for (const path of [
      `/avatars/${userId}.png`,
      `/avatars/${userId.toUpperCase()}.webp`,
      `/avatars/history/${userId}/${NOW}-${await sha256Hex(webp)}.webp`,
    ]) {
      expect((await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}${path}`), env)).status, path).toBe(404);
    }
    const post = await handleSandboxRequest(new Request(`${SANDBOX_ORIGIN}/avatars/${userId}.webp`, { method: 'POST' }), env);
    expect(post.status).toBe(405);
  });

  it('アプリ用ホストからは配らない（7.2。利用者が上げた画像をアプリのオリジンで解釈させない）', async () => {
    const { userId } = await seededAvatar();
    const response = await handleAppRequest(new Request(`${APP_ORIGIN}/avatars/${userId}.webp?v=${NOW}`), testEnv());
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('image/');
  });
});

describe('表示（ヘッダ・カード・作者ページ・登録情報）', () => {
  it('ヘッダのアバターは、ログイン済みの本人の URL（版なし）を既定の図形の中へ差し込む', async () => {
    const userId = await seedUser();
    const request = new Request(`${APP_ORIGIN}/terms`, { headers: { cookie: await cookieFor(userId) } });
    const signedIn = siteHead({ title: 'x', viewer: await resolveSiteViewer(request, testEnv()) });
    expect(signedIn).toContain(`<span class="gf-avatar" aria-hidden="true"><img src="${SANDBOX_ORIGIN}/avatars/${userId}.webp"`);
    expect(signedIn).toContain('alt=""');

    const signedOut = siteHead({
      title: 'x',
      viewer: await resolveSiteViewer(new Request(`${APP_ORIGIN}/terms`), testEnv()),
    });
    expect(signedOut).not.toContain('/avatars/');
  });

  it('カードは版つきの URL を名前の前に置き、設定していない作者・読めない版には何も足さない', () => {
    const authorId = crypto.randomUUID();
    const base = {
      id: crypto.randomUUID(),
      title: '作品',
      authorName: '作者',
      authorId,
      publishedAt: 1,
      forkCount: 0,
      likeCount: 0,
      hasParent: false,
      hasShot: false,
    };
    expect(renderWorkCard({ ...base, authorAvatarSetAt: NOW }, SANDBOX_ORIGIN)).toContain(
      `<a class="gf-card-author" href="${authorPagePath(authorId)}"><span class="gf-avatar" aria-hidden="true"><img src="${SANDBOX_ORIGIN}/avatars/${authorId}.webp?v=${NOW}"`,
    );
    for (const version of [null, undefined, '1800200000', 0, -1, 1.5]) {
      const html = renderWorkCard({ ...base, authorAvatarSetAt: version as never }, SANDBOX_ORIGIN);
      expect(html, String(version)).not.toContain('gf-avatar');
    }
    expect(renderWorkCard({ ...base, authorAvatarSetAt: NOW }, null)).not.toContain('gf-avatar');
  });

  it('一覧の SQL は、外したあとの作者の版を null に倒す（avatar_set_at は進んでいても）', async () => {
    const userId = await seedUser();
    const gameId = crypto.randomUUID();
    await env.DB.prepare(
      `insert into games (id, author_id, status, title, go_version, created_at, generation_state, published_at,
                          fork_count, like_count, ogp_state, review_state)
       values (?, ?, ?, 'アイコンの作品', '', 1, 'ready', ?, 0, 0, null, null)`,
    )
      .bind(gameId, userId, PUBLISHED_STATUS, 4_000_000_000)
      .run();
    const find = async () => (await listPublishedGames(env, 'recent', 50)).find((work) => work.id === gameId);

    expect((await find())?.authorAvatarSetAt).toBeNull();
    await saveAvatar(env, userId, encodedWebp(21), NOW);
    expect((await find())?.authorAvatarSetAt).toBe(NOW);
    await removeAvatar(env, userId, NOW + AVATAR_CHANGE_INTERVAL_SECONDS);
    expect((await find())?.authorAvatarSetAt).toBeNull();
  });

  it('作者ページは見出しの前にアイコンを出し、外したら出さない', async () => {
    const userId = await seedUser('アイコンの作者');
    const open = async (): Promise<string> => {
      await purgeListCache(authorCacheKey(userId, 1));
      const response = await handleAppRequest(new Request(`${APP_ORIGIN}${authorPagePath(userId)}`), testEnv());
      expect(response.status).toBe(200);
      return await response.text();
    };
    expect(await open()).not.toContain('gf-author-avatar');
    await saveAvatar(env, userId, encodedWebp(22), NOW);
    const body = await open();
    expect(body).toContain(`<p class="gf-author-avatar"><span class="gf-avatar" aria-hidden="true"><img src="${SANDBOX_ORIGIN}/avatars/${userId}.webp?v=${NOW}"`);
    expect(body).toContain('<h1>アイコンの作者</h1>');
    await removeAvatar(env, userId, NOW + AVATAR_CHANGE_INTERVAL_SECONDS);
    expect(await open()).not.toContain('gf-author-avatar');
  });

  it('登録情報の画面は、切り抜きの断りと、設定したアイコン・外すボタンを出す', async () => {
    const userId = await seedUser();
    const cookie = await cookieFor(userId);
    const open = async (): Promise<string> =>
      await (
        await dispatch(routesWith(fakeEncode({ ok: false, reason: 'broken' }).encode), new Request(`${APP_ORIGIN}${ACCOUNT_PATH}`, { headers: { cookie } }), testEnv())
      ).text();
    const before = await open();
    expect(before).toContain(AVATAR_CROP_NOTICE);
    expect(before).toContain('enctype="multipart/form-data"');
    expect(before).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(before).not.toContain(ACCOUNT_AVATAR_REMOVE_PATH);

    await saveAvatar(env, userId, encodedWebp(23), NOW);
    const after = await open();
    expect(after).toContain(`${SANDBOX_ORIGIN}/avatars/${userId}.webp?v=${NOW}`);
    expect(after).toContain(`action="${ACCOUNT_AVATAR_REMOVE_PATH}"`);
  });
});

describe('差し替え前の画像の保存期間（30 日）', () => {
  it(`履歴の行は ${AVATAR_HISTORY_RETENTION_DAYS} 日を過ぎたら「消えた」と扱い、写していない行は「無い」`, () => {
    const day = 24 * 60 * 60;
    const key = avatarHistoryKey(crypto.randomUUID(), NOW, 'a'.repeat(64));
    expect(avatarHistoryImageState(key, NOW, NOW + AVATAR_HISTORY_RETENTION_DAYS * day - 1)).toBe('available');
    expect(avatarHistoryImageState(key, NOW, NOW + AVATAR_HISTORY_RETENTION_DAYS * day)).toBe('expired');
    expect(avatarHistoryImageState(null, NOW, NOW)).toBe('none');
  });
});

describe('変換の呼び出し（src/avatar-client.ts）', () => {
  /**
   * 資格情報と関数名を入れた env。
   *
   * @returns env
   */
  function invokeEnv(): Env {
    return {
      ...env,
      BUILD_AWS_REGION: 'ap-northeast-1',
      BUILD_AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      BUILD_AWS_SECRET_ACCESS_KEY: 'secret-example',
      [AVATAR_FUNCTION_NAME_VAR]: 'game-forge-avatar',
    } as Env;
  }

  it('同期呼び出し（RequestResponse）で画像を base64 にして送り、応答の WebP を戻す', async () => {
    const webp = encodedWebp(24);
    const image = pngBytes(10, 10);
    let seen: Request | null = null;
    let payload: unknown = null;
    const encode = createAvatarEncode({
      fetch: async (request) => {
        seen = request;
        payload = await request.clone().json();
        return new Response(JSON.stringify({ ok: true, webp: bytesToBase64(webp) }), { status: 200 });
      },
    });
    expect(await encode(invokeEnv(), image)).toEqual({ ok: true, webp });
    expect(seen!.headers.get('x-amz-invocation-type')).toBe(SYNC_INVOCATION_TYPE);
    expect(seen!.url).toContain('/functions/game-forge-avatar/invocations');
    expect(seen!.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(payload).toEqual({ image: bytesToBase64(image) });
  });

  it('断った理由はそのまま返し、関数の例外・読めない応答は例外にする（「断った」に倒さない）', async () => {
    const respond = (body: string, headers: Record<string, string> = {}) =>
      createAvatarEncode({ fetch: async () => new Response(body, { status: 200, headers }) });
    expect(await respond('{"ok":false,"reason":"animated"}')(invokeEnv(), pngBytes(1, 1))).toEqual({
      ok: false,
      reason: 'animated',
    });
    await expect(respond('{"errorMessage":"x"}', { 'x-amz-function-error': 'Unhandled' })(invokeEnv(), pngBytes(1, 1))).rejects.toBeInstanceOf(AvatarEncodeFailed);
    await expect(respond('{"ok":false,"reason":"svg"}')(invokeEnv(), pngBytes(1, 1))).rejects.toBeInstanceOf(AvatarEncodeFailed);
    await expect(respond('not json')(invokeEnv(), pngBytes(1, 1))).rejects.toBeInstanceOf(AvatarEncodeFailed);
  });

  it('設定が足りなければ、送る前に名前だけを出して落ちる', async () => {
    const encode = createAvatarEncode({ fetch: async () => new Response('{}') });
    const broken = { ...invokeEnv(), [AVATAR_FUNCTION_NAME_VAR]: '' } as unknown as Env;
    await expect(encode(broken, pngBytes(1, 1))).rejects.toBeInstanceOf(AvatarNotConfigured);
  });
});
