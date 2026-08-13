import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  buildSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  signSession,
  verifySession,
} from '../src/session.js';
import type { SessionPayload } from '../src/session.js';

/** テスト用の秘密鍵。実鍵ではなく、長さの下限（32 文字）を満たすためだけの値。 */
const SECRET = 'test-secret-value-for-session-signing-0001';
const OTHER_SECRET = 'test-secret-value-for-session-signing-0002';

const NOW = 1_770_000_000;

const payload: SessionPayload = {
  userId: 'user_01HZY0000000000000000000',
  issuedAt: NOW,
  expiresAt: NOW + 3600,
};

describe('署名と検証の往復', () => {
  it('署名したトークンが検証を通り、同じペイロードを返す', async () => {
    const token = await signSession(payload, SECRET);
    const result = await verifySession(token, SECRET, NOW);
    expect(result).toEqual({ ok: true, payload });
  });

  it('トークンが cookie に載せられる文字だけで構成される', async () => {
    // base64url を使うのは、cookie の値に `,` `;` 空白などが使えないため。
    const token = await signSession(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('同じ入力に対して署名が安定する', async () => {
    expect(await signSession(payload, SECRET)).toBe(await signSession(payload, SECRET));
  });

  it('パディングなしの base64url をそのまま復号できる', async () => {
    // atob は WHATWG の forgiving-base64 decode に従い、長さを 4 で割った余りが
    // 1 のときだけ失敗する。HMAC-SHA256 の署名は 32 バイト = 43 文字（余り 3）で、
    // パディングを復元しなくても復号できる。ここを「復元が要る」と読み違えると、
    // 存在しない不具合の修正が入る。対照は「長さの余りが 1 の base64url を拒否する」。
    const token = await signSession(payload, SECRET);
    const signature = token.split('.')[1]!;
    expect(signature).toHaveLength(43);
    expect(signature.length % 4).toBe(3);
    expect((await verifySession(token, SECRET, NOW)).ok).toBe(true);
  });
});

describe('改竄したトークンを拒否する（#12 acceptance 2）', () => {
  it('ペイロードを差し替えたトークンを拒否する', async () => {
    const token = await signSession(payload, SECRET);
    const forged = { ...payload, userId: 'user_someone_else' };
    const forgedBody = btoa(JSON.stringify(forged))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const tampered = `${forgedBody}.${token.split('.')[1]}`;

    const result = await verifySession(tampered, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('署名部分を書き換えたトークンを拒否する', async () => {
    const token = await signSession(payload, SECRET);
    const [body, signature] = token.split('.');
    // 1 文字だけ変える。全体を差し替えるより、実際に起こる改竄に近い。
    const flipped = signature!.startsWith('A') ? `B${signature!.slice(1)}` : `A${signature!.slice(1)}`;

    const result = await verifySession(`${body}.${flipped}`, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('別の鍵で署名したトークンを拒否する', async () => {
    const token = await signSession(payload, OTHER_SECRET);
    const result = await verifySession(token, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('区切りが無い・多いトークンを拒否する', async () => {
    const token = await signSession(payload, SECRET);
    for (const broken of [token.replace('.', ''), `${token}.extra`, '.', `${token}.`]) {
      const result = await verifySession(broken, SECRET, NOW);
      expect(result, broken).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('base64url でない表現を拒否する', async () => {
    // 素の base64（`+` `/` `=`）を通すと、同じ署名に複数の表現が生まれる。
    const token = await signSession(payload, SECRET);
    const [body, signature] = token.split('.');
    const result = await verifySession(`${body}.${signature}=`, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('長さの余りが 1 の base64url を拒否する', async () => {
    // 下の「パディングなしでも復号できる」の対照。atob が失敗する唯一の長さであり、
    // ここでは null になって malformed として落ちるのが正しい（壊れた入力のため）。
    const token = await signSession(payload, SECRET);
    const [body] = token.split('.');
    const result = await verifySession(`${body}.${'A'.repeat(41)}`, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('署名は通るが形が壊れたペイロードを拒否する', async () => {
    // 鍵を知る側が壊れた形を送ってくる場合（過去に別の形で発行した残骸を含む）。
    // 署名が通っても `as` でキャストせず、形を検証していることを固定する。
    for (const broken of [
      '{"userId":"","issuedAt":1,"expiresAt":2}',
      '{"userId":"u","issuedAt":"1","expiresAt":2}',
      '{"userId":"u","issuedAt":1.5,"expiresAt":2}',
      '{"userId":"u"}',
      '[]',
      'null',
      'not-json',
    ]) {
      const body = btoa(broken).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
      const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');

      const result = await verifySession(`${body}.${encoded}`, SECRET, NOW);
      expect(result, broken).toEqual({ ok: false, reason: 'bad-payload' });
    }
  });
});

describe('失効の判定', () => {
  it('expiresAt を過ぎたトークンを拒否する', async () => {
    const token = await signSession(payload, SECRET);
    const result = await verifySession(token, SECRET, NOW + 3601);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('expiresAt ちょうどを失効として扱う', async () => {
    // 境界を「まだ有効」に倒すと、失効時刻の意味が 1 秒ずれる。
    const token = await signSession(payload, SECRET);
    const result = await verifySession(token, SECRET, NOW + 3600);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('失効の 1 秒前は通す', async () => {
    const token = await signSession(payload, SECRET);
    expect((await verifySession(token, SECRET, NOW + 3599)).ok).toBe(true);
  });
});

describe('秘密鍵の不備を通さない', () => {
  it('空の秘密鍵で署名できない', async () => {
    await expect(signSession(payload, '')).rejects.toThrow(/SESSION_SECRET/);
    await expect(signSession(payload, '   ')).rejects.toThrow(/SESSION_SECRET/);
  });

  it('短い秘密鍵で署名できない', async () => {
    // 短さは実行時エラーとして表面化せず、総当たりの容易さとしてだけ現れる。
    await expect(signSession(payload, 'short-secret')).rejects.toThrow(/短すぎます/);
  });

  it('空の秘密鍵では検証も通さない', async () => {
    const token = await signSession(payload, SECRET);
    await expect(verifySession(token, '', NOW)).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe('cookie の組み立て（7.2 必須要件 2 / 8.1）', () => {
  it('__Host- の受理条件をすべて満たす', async () => {
    const token = await signSession(payload, SECRET);
    const cookie = buildSessionCookie(token, 3600);

    expect(cookie.startsWith(`${SESSION_COOKIE}=${token};`)).toBe(true);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    // どれか 1 つでも欠けるとブラウザは黙って捨てるため、個別に検査する。
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('ログアウト用の cookie が発行時と同じ属性で Max-Age=0 にする', () => {
    // Path が違うとブラウザは別の cookie とみなし、古いものが残る。
    const cookie = clearSessionCookie();
    expect(cookie.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie.toLowerCase()).not.toContain('domain=');
  });
});

describe('Cookie ヘッダからの読み出し', () => {
  it('セッション cookie の値を取り出す', () => {
    expect(readSessionCookie(`other=x; ${SESSION_COOKIE}=abc.def; more=y`)).toBe('abc.def');
  });

  it('セッション cookie が無ければ null を返す', () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
    expect(readSessionCookie('other=x')).toBeNull();
  });

  it('空の値を null として扱う', () => {
    // ログアウト直後の cookie（`=` のみ）を「トークンがある」と読まないこと。
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it('名前の前方一致で別の cookie を拾わない', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}_other=nope`)).toBeNull();
  });
});
