import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH } from '../src/account-paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import {
  VIEWER_SIGNED_IN,
  VIEWER_SIGNED_OUT,
  resolveSiteViewer,
  siteHead,
} from '../src/html.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { MY_WORKS_PATH } from '../src/works-paths.js';

/**
 * ヘッダの出し分けの判定（2.3.7 / #331）。
 *
 * # なぜ経路を通さないのか
 *
 * **全画面にナビが出ることは `test/page-shell.test.ts` が経路表から導いて見る。**
 * ここで見るのは、あの検査では作れない状態である——**`SESSION_SECRET` が壊れている**
 * ときに画面が落ちないこと、**cookie が無いときに鍵へ触らない**こと。どちらも
 * 「外枠が原因で本文まで消える」形を塞ぐための性質で、経路の側からは再現できない。
 */

const SECRET = 'test-secret-value-for-site-viewer-checks-1';

/**
 * 有効なセッション cookie を作る。
 *
 * @param secret 署名に使う秘密鍵
 * @returns `Cookie` ヘッダへ入れる値
 */
async function validCookie(secret: string = SECRET): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signSession({ userId: 'viewer-1', issuedAt, expiresAt: issuedAt + 3600 }, secret);
  return buildSessionCookie(token, 3600).split(';')[0]!;
}

/**
 * cookie を付けた（付けない）要求を作る。
 *
 * @param cookie `Cookie` ヘッダの値（null なら付けない）
 * @returns 要求
 */
function requestWith(cookie: string | null): Request {
  return new Request(`https://${env.APP_HOST}/terms`, {
    headers: cookie === null ? {} : { cookie },
  });
}

/**
 * 秘密鍵だけを差し替えた env。
 *
 * @param secret `SESSION_SECRET` の値
 * @returns 差し替えた env
 */
function envWithSecret(secret: string): Env {
  return { ...env, SESSION_SECRET: secret };
}

describe('ヘッダの出し分けに使う状態（resolveSiteViewer）', () => {
  it('cookie が無ければ未ログインで、秘密鍵に触らない', async () => {
    // **鍵が壊れていても落ちない**ことで「触っていない」を示す。`SESSION_SECRET` が
    // 空のまま `verifySession` を呼ぶと投げる（`src/session.ts` の `importKey`）ので、
    // ここが通ることは鍵の import が走っていないことの証拠である。
    expect(await resolveSiteViewer(requestWith(null), envWithSecret(''))).toEqual(
      VIEWER_SIGNED_OUT,
    );
  });

  it('署名の通った cookie ならログイン済みになる', async () => {
    expect(
      await resolveSiteViewer(requestWith(await validCookie()), envWithSecret(SECRET)),
    ).toEqual(VIEWER_SIGNED_IN);
  });

  it('別の鍵で署名された cookie は未ログインとして扱う', async () => {
    const other = await validCookie('another-secret-value-for-site-viewer-1');
    expect(await resolveSiteViewer(requestWith(other), envWithSecret(SECRET))).toEqual(
      VIEWER_SIGNED_OUT,
    );
  });

  it('期限切れの cookie は未ログインとして扱う', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 7200;
    const token = await signSession({ userId: 'viewer-1', issuedAt, expiresAt: issuedAt + 60 }, SECRET);
    const cookie = buildSessionCookie(token, 3600).split(';')[0]!;
    expect(await resolveSiteViewer(requestWith(cookie), envWithSecret(SECRET))).toEqual(
      VIEWER_SIGNED_OUT,
    );
  });

  it('秘密鍵の設定が壊れていても投げない（画面ごと 500 にしない）', async () => {
    // **外枠が原因で本文まで消える形を作らない**（`src/html.ts` の理由）。
    // ヘッダの 1 行のために、規約や削除申請の画面が 500 になってはいけない。
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    try {
      const viewer = await resolveSiteViewer(requestWith(await validCookie()), envWithSecret(''));
      expect(viewer).toEqual(VIEWER_SIGNED_OUT);
    } finally {
      spy.mockRestore();
    }
    // **黙らせない。** 未ログインへ倒したことは記録する。
    expect(logged.join('\n')).toContain('ヘッダの出し分け');
  });
});

describe('siteHead のヘッダ', () => {
  it('viewer を渡さない画面はナビを出さない（未ログインとして描かない）', () => {
    // **POST の結果を返す画面（`src/publish.ts` など）はログイン済みの利用者しか
    // 踏まない。** 未ログイン用のナビを既定にすると、操作が成功した画面に「ログイン」が
    // 出る。**間違ったことを言うより、言わないほうを既定にする。**
    const head = siteHead({ title: '公開しました - Game Forge' });
    expect(head).toContain('<header class="gf-header">');
    expect(head).not.toContain('gf-header-nav');
    expect(head).not.toContain(`href="${LOGIN_PATH}"`);
    expect(head).not.toContain(`href="${MY_WORKS_PATH}"`);
    expect(head).not.toContain(`href="${ACCOUNT_PATH}"`);
  });

  it('渡せばその状態のナビを出す', () => {
    const anonymous = siteHead({ title: 'x', viewer: VIEWER_SIGNED_OUT });
    expect(anonymous).toContain(`href="${LOGIN_PATH}"`);
    expect(anonymous).not.toContain(`href="${MY_WORKS_PATH}"`);

    const signedIn = siteHead({ title: 'x', viewer: VIEWER_SIGNED_IN });
    expect(signedIn).toContain(`href="${MY_WORKS_PATH}"`);
    expect(signedIn).toContain(`href="${ACCOUNT_PATH}"`);
    expect(signedIn).not.toContain(`href="${LOGIN_PATH}"`);
  });

  it('ヘッダは OGP の meta より後ろに出る（本文が始まる前に meta を置く）', () => {
    // **`extraHead` はヘッダより前**という `siteHead` の規約は、ナビを足しても変わらない。
    const head = siteHead({
      title: 'x',
      extraHead: '\n<meta property="og:title" content="x">',
      viewer: VIEWER_SIGNED_OUT,
    });
    expect(head.indexOf('<meta property="og:title"')).toBeLessThan(
      head.indexOf('<header class="gf-header">'),
    );
  });
});
