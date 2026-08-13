import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { WAITLIST_PATH } from '../src/paths.js';
import { dispatch } from '../src/routes.js';
import {
  MAX_EMAIL_LENGTH,
  WAITLIST_COUNT_STEP,
  coarsenWaitlistCount,
  countWaitlist,
  isWaitlistSource,
  normalizeEmail,
  parseWaitlistRequest,
  registerWaitlist,
  waitlistRoutes,
} from '../src/waitlist.js';
import { applySchema } from './helpers/schema.js';

const APP_ORIGIN = `https://${env.APP_HOST}`;
const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';

/**
 * 受け付ける 2 形式。
 *
 * **観点はこの表で両方へ配る。** 片方だけをテストすると、緩いほうの入口が
 * 検証されないまま残る（fetch から叩く JSON と、素の HTML フォームからの
 * urlencoded は、どちらも同じ検証を通ることが要件）。
 */
const CONTENT_TYPES = [
  ['json', JSON_TYPE],
  ['form', FORM_TYPE],
] as const;

beforeAll(async () => {
  await applySchema();
});

/**
 * テスト内で一意なアドレスを組み立てる。
 *
 * 各テストが自分で登録した行だけを見るようにするための道具。他のテストが入れた行に
 * 依存すると、単体で実行したとき（`npx vitest run -t ...`）に落ちる。
 *
 * @param suffix テスト内で一意な接尾辞
 * @returns メールアドレス
 */
function uniqueEmail(suffix: string): string {
  return `waitlist-${suffix}@example.com`;
}

/**
 * 本文を文字列のまま送る POST リクエストを組み立てる。
 *
 * @param body 本文
 * @param contentType `Content-Type` ヘッダ
 * @returns リクエスト
 */
function postRaw(body: string, contentType: string): Request {
  return new Request(`${APP_ORIGIN}${WAITLIST_PATH}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

/**
 * 項目を `Content-Type` に応じて符号化して送る POST リクエストを組み立てる。
 *
 * 同じ観点を 2 形式へ配るための道具。テスト側が形式ごとに本文を書き分けると、
 * 「両方に同じ観点を通す」ことがテストの書き方に依存してしまう。
 *
 * @param fields 送る項目
 * @param contentType `Content-Type` ヘッダ
 * @returns リクエスト
 */
function postFields(fields: Record<string, string>, contentType: string): Request {
  const body =
    contentType === FORM_TYPE ? new URLSearchParams(fields).toString() : JSON.stringify(fields);
  return postRaw(body, contentType);
}

describe('メールアドレスの正規化', () => {
  it('前後の空白を落として小文字へ揃える', () => {
    // 揃えないと A@example.com と a@example.com が UNIQUE 制約をすり抜けて 2 行になり、
    // 同じ人が 2 人分として数えられる（10.2 の登録率の分子が壊れる）。
    expect(normalizeEmail('  Player@Example.COM ')).toBe('player@example.com');
  });

  it('空と @ を含まないものを弾く', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('@ の前後が空のものを弾く', () => {
    expect(normalizeEmail('@example.com')).toBeNull();
    expect(normalizeEmail('player@')).toBeNull();
  });

  it('長すぎるものを弾き、上限ちょうどは通す', () => {
    const domain = '@example.com';
    const justFits = 'a'.repeat(MAX_EMAIL_LENGTH - domain.length) + domain;
    expect(justFits).toHaveLength(MAX_EMAIL_LENGTH);
    expect(normalizeEmail(justFits)).toBe(justFits);
    expect(normalizeEmail(`a${justFits}`)).toBeNull();
  });

  it('制御文字を含むものを弾く', () => {
    // CR / LF を通すと、このアドレスをメールヘッダへ載せたときにヘッダ挿入になる
    // （2.2-6 の改造通知メール）。入り口で閉じる。
    //
    // 制御文字はエスケープで書く。ソースへ生のバイトを置くと、目で読めないうえ
    // git がファイルを binary と判定して差分が出なくなる（レビューから消える）。
    expect(normalizeEmail('player@example.com\r\nbcc: victim@example.com')).toBeNull();
    expect(normalizeEmail('pla\u0000yer@example.com')).toBeNull();
    expect(normalizeEmail('player@example\u007f.com')).toBeNull();
  });

  it('途中に空白を含むものを弾く', () => {
    // urlencoded は `+` を空白へ復号するため、この判定が無いと
    // `a+b@example.com` が `a b@example.com` として保存される。
    expect(normalizeEmail('pla yer@example.com')).toBeNull();
    expect(normalizeEmail('player@exa\tmple.com')).toBeNull();
    expect(normalizeEmail('player@exa\u3000mple.com')).toBeNull();
  });

  it('置換文字（復号に失敗した跡）を含むものを弾く', () => {
    // 壊れたパーセントエンコードや不正な UTF-8 は例外にならず U+FFFD へ潰れる。
    // 通すと、届かないアドレスが登録される。
    expect(normalizeEmail('\ufffd@example.com')).toBeNull();
    expect(normalizeEmail('player@ex\ufffdample.com')).toBeNull();
  });

  it('引用符付きローカル部（@ を含む）を弾かない', () => {
    // 過剰に厳しい検証で正当なアドレスを落とさないこと。区切りは最後の @ で判定する。
    expect(normalizeEmail('"a@b"@example.com')).toBe('"a@b"@example.com');
  });

  it('ドメインにドットが無くても弾かない', () => {
    // 到達性の確認はここの仕事ではない。文法上正当なものを落とさない。
    expect(normalizeEmail('player@localhost')).toBe('player@localhost');
  });
});

describe('導線（source）の検証', () => {
  it('既知の導線だけを受け付ける', () => {
    expect(isWaitlistSource('fork-cta')).toBe(true);
    expect(isWaitlistSource('signup')).toBe(true);
    expect(isWaitlistSource('landing')).toBe(true);
    expect(isWaitlistSource('forkCta')).toBe(false);
    expect(isWaitlistSource('')).toBe(false);
  });
});

describe.each(CONTENT_TYPES)('リクエスト本文の解析（%s）', (label, contentType) => {
  it('妥当な本文から登録内容を取り出す', async () => {
    const parsed = await parseWaitlistRequest(
      postFields({ email: ' Player@Example.com ', source: 'fork-cta' }, contentType),
    );
    expect(parsed).toEqual({
      ok: true,
      registration: { email: 'player@example.com', source: 'fork-cta' },
    });
  });

  it('導線が未指定なら null として通す', async () => {
    // UI 側の付け忘れで「登録そのもの」を落とさない。失うのは導線の内訳だけにする。
    const email = uniqueEmail(`${label}-no-source`);
    const parsed = await parseWaitlistRequest(postFields({ email }, contentType));
    expect(parsed).toEqual({ ok: true, registration: { email, source: null } });
  });

  it('導線が空文字でも未指定として通す', async () => {
    // HTML フォームは選択されなかった項目を `source=` の形で送る。未知の値として
    // 弾くと、素のフォームからの登録が丸ごと落ちる。
    const email = uniqueEmail(`${label}-empty-source`);
    const parsed = await parseWaitlistRequest(postFields({ email, source: '' }, contentType));
    expect(parsed).toEqual({ ok: true, registration: { email, source: null } });
  });

  it('未知の導線を弾く', async () => {
    const parsed = await parseWaitlistRequest(
      postFields({ email: uniqueEmail(`${label}-bad-source`), source: 'fork_cta' }, contentType),
    );
    expect(parsed).toEqual({ ok: false, reason: 'unknown-source' });
  });

  it('不正なアドレスを弾く', async () => {
    const parsed = await parseWaitlistRequest(postFields({ email: 'not-an-email' }, contentType));
    expect(parsed).toEqual({ ok: false, reason: 'invalid-email' });
  });

  it('email が無い本文を弾く', async () => {
    const parsed = await parseWaitlistRequest(postFields({ source: 'landing' }, contentType));
    expect(parsed).toEqual({ ok: false, reason: 'invalid-email' });
  });

  it('Content-Type のパラメータ付き（charset）は通す', async () => {
    const parsed = await parseWaitlistRequest(
      postFields({ email: uniqueEmail(`${label}-charset`) }, contentType).clone(),
    );
    expect(parsed.ok).toBe(true);

    const withCharset = postRaw(
      contentType === FORM_TYPE
        ? `email=${encodeURIComponent(uniqueEmail(`${label}-charset-2`))}`
        : JSON.stringify({ email: uniqueEmail(`${label}-charset-2`) }),
      `${contentType}; charset=utf-8`,
    );
    await expect(parseWaitlistRequest(withCharset)).resolves.toEqual({
      ok: true,
      registration: { email: uniqueEmail(`${label}-charset-2`), source: null },
    });
  });

  it('巨大な本文を読み切らずに弾く', async () => {
    // 上限は形式によらず同じ。緩いほうができると、そちらだけが使われる。
    const request = postFields(
      { email: uniqueEmail(`${label}-huge`), padding: 'x'.repeat(64 * 1024) },
      contentType,
    );
    await expect(parseWaitlistRequest(request)).resolves.toEqual({
      ok: false,
      reason: 'body-too-large',
    });
  });

  it('本文なしの POST を投げずに弾く', async () => {
    const request = new Request(`${APP_ORIGIN}${WAITLIST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
    });
    const parsed = await parseWaitlistRequest(request);
    // 形式によって理由は違う（JSON は解析不能、フォームは項目が無いだけ）が、
    // どちらも例外を投げずに失敗として返る。
    expect(parsed.ok).toBe(false);
  });
});

describe('リクエスト本文の解析（JSON 固有）', () => {
  it('壊れた JSON を投げずに弾く', async () => {
    await expect(parseWaitlistRequest(postRaw('{"email":', JSON_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'malformed-json',
    });
  });

  it('オブジェクトでない JSON を弾く', async () => {
    // `"文字列"` も `[]` も JSON としては妥当なので、パースの成功だけでは足りない。
    await expect(
      parseWaitlistRequest(postRaw('"player@example.com"', JSON_TYPE)),
    ).resolves.toEqual({ ok: false, reason: 'malformed-json' });
    await expect(parseWaitlistRequest(postRaw('[]', JSON_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'malformed-json',
    });
  });

  it('email が文字列でないものを弾く', async () => {
    await expect(
      parseWaitlistRequest(postRaw(JSON.stringify({ email: 42 }), JSON_TYPE)),
    ).resolves.toEqual({ ok: false, reason: 'invalid-email' });
  });
});

describe('リクエスト本文の解析（urlencoded 固有）', () => {
  it('同じキーが複数回現れる本文を弾く', async () => {
    // URLSearchParams は先頭を返すが、黙って先頭を採ると、利用者が意図していない
    // ほうのアドレスを登録して「成功」と返しうる。
    const body = `email=${encodeURIComponent('a@example.com')}&email=${encodeURIComponent('b@example.com')}`;
    await expect(parseWaitlistRequest(postRaw(body, FORM_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'duplicated-field',
    });
  });

  it('同じキーが複数回現れる導線も弾く', async () => {
    const body = `email=${encodeURIComponent('a@example.com')}&source=landing&source=signup`;
    await expect(parseWaitlistRequest(postRaw(body, FORM_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'duplicated-field',
    });
  });

  it('値が空の本文を弾く', async () => {
    await expect(parseWaitlistRequest(postRaw('email=', FORM_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'invalid-email',
    });
  });

  it('項目が 1 つも無い本文を弾く', async () => {
    await expect(parseWaitlistRequest(postRaw('', FORM_TYPE))).resolves.toEqual({
      ok: false,
      reason: 'invalid-email',
    });
  });

  it('壊れたパーセントエンコードを投げずに弾く', async () => {
    // URL 標準の復号は非可逆で例外を投げない。不正な並びは U+FFFD になるか、
    // そのままの文字として残る。どちらもアドレスの検証で落ちること。
    for (const body of ['email=%FF@example.com', 'email=%E3%81', 'email=%ZZ']) {
      const parsed = await parseWaitlistRequest(postRaw(body, FORM_TYPE));
      expect(parsed, body).toEqual({ ok: false, reason: 'invalid-email' });
    }
  });

  it('パーセントエンコードされた正当なアドレスを通す', async () => {
    const email = uniqueEmail('form-encoded');
    const parsed = await parseWaitlistRequest(
      postRaw(`email=${encodeURIComponent(email)}&source=fork-cta`, FORM_TYPE),
    );
    expect(parsed).toEqual({ ok: true, registration: { email, source: 'fork-cta' } });
  });

  it('+ を空白として復号する（フォームの符号化）', async () => {
    // `a+b@example.com` はフォーム符号化では「a b@example.com」であり、空白を含む
    // ため弾かれる。`+` をそのまま含むアドレスは %2B で送られる。
    await expect(parseWaitlistRequest(postRaw('email=a+b@example.com', FORM_TYPE))).resolves.toEqual(
      { ok: false, reason: 'invalid-email' },
    );
    await expect(
      parseWaitlistRequest(postRaw('email=a%2Bb@example.com', FORM_TYPE)),
    ).resolves.toEqual({ ok: true, registration: { email: 'a+b@example.com', source: null } });
  });
});

describe('未対応の Content-Type', () => {
  it('JSON でもフォームでもない形式を弾く', async () => {
    for (const contentType of ['text/plain', 'multipart/form-data', '']) {
      const parsed = await parseWaitlistRequest(postRaw('email=a@example.com', contentType));
      expect(parsed, contentType).toEqual({ ok: false, reason: 'unsupported-content-type' });
    }
  });
});

describe('保存と登録数（#14 acceptance 2）', () => {
  it('登録が保存され、登録数が 1 増える', async () => {
    const before = await countWaitlist(env.DB);
    await registerWaitlist(env.DB, { email: uniqueEmail('saved'), source: 'fork-cta' }, 1700000000);
    expect(await countWaitlist(env.DB)).toBe(before + 1);

    const row = await env.DB.prepare('select source, created_at from waitlist where email = ?')
      .bind(uniqueEmail('saved'))
      .first<{ source: string | null; created_at: number }>();
    expect(row).toEqual({ source: 'fork-cta', created_at: 1700000000 });
  });

  it('導線が未指定なら NULL で保存される', async () => {
    await registerWaitlist(env.DB, { email: uniqueEmail('null-source'), source: null });
    const row = await env.DB.prepare('select source from waitlist where email = ?')
      .bind(uniqueEmail('null-source'))
      .first<{ source: string | null }>();
    expect(row?.source).toBeNull();
  });

  it('同じアドレスを二度登録しても件数が増えず、例外も投げない', async () => {
    const email = uniqueEmail('duplicate');
    await registerWaitlist(env.DB, { email, source: 'landing' });
    const afterFirst = await countWaitlist(env.DB);

    await expect(registerWaitlist(env.DB, { email, source: 'landing' })).resolves.toBeUndefined();
    expect(await countWaitlist(env.DB)).toBe(afterFirst);

    const rows = await env.DB.prepare('select id from waitlist where email = ?')
      .bind(email)
      .all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
  });

  it('重複登録が最初の導線を上書きしない', async () => {
    // 最初にどの導線から来たかが 10.2 の見たい情報であり、後から押した導線で
    // 上書きすると初回接触の分布が消える。
    const email = uniqueEmail('first-touch');
    await registerWaitlist(env.DB, { email, source: 'fork-cta' });
    await registerWaitlist(env.DB, { email, source: 'landing' });

    const row = await env.DB.prepare('select source from waitlist where email = ?')
      .bind(email)
      .first<{ source: string | null }>();
    expect(row?.source).toBe('fork-cta');
  });

  it('件数が数値で返る', async () => {
    await expect(countWaitlist(env.DB)).resolves.toBeTypeOf('number');
  });

  it('集計が数値で返らなければ落とす', async () => {
    // 0 として流すと、10.2 の分子が黙って 0 になり「登録が無い」ことと区別できない。
    // first<T>() の型引数はこちらの宣言でしかなく、実行時には検査されない。
    for (const broken of [{ total: null }, { total: '3' }, null]) {
      const brokenDb = {
        prepare: () => ({ first: async () => broken }),
      } as unknown as D1Database;
      await expect(countWaitlist(brokenDb), JSON.stringify(broken)).rejects.toThrow();
    }
  });
});

describe('外へ返す件数の丸め', () => {
  it('丸め幅で切り捨てる', () => {
    expect(coarsenWaitlistCount(0)).toBe(0);
    expect(coarsenWaitlistCount(WAITLIST_COUNT_STEP - 1)).toBe(0);
    expect(coarsenWaitlistCount(WAITLIST_COUNT_STEP)).toBe(WAITLIST_COUNT_STEP);
    expect(coarsenWaitlistCount(WAITLIST_COUNT_STEP * 4 + 3)).toBe(WAITLIST_COUNT_STEP * 4);
  });

  it('実際の件数を上回らない', () => {
    // 上回ると「N 人が待っている」という提示（2.2-4）が事実と食い違う。
    for (const exact of [0, 1, 9, 10, 11, 137]) {
      expect(coarsenWaitlistCount(exact)).toBeLessThanOrEqual(exact);
    }
  });
});

describe.each(CONTENT_TYPES)('POST /api/waitlist（%s）', (label, contentType) => {
  it('登録に成功し、丸めた件数を JSON で返す', async () => {
    const email = uniqueEmail(`${label}-http`);
    const response = await SELF.fetch(postFields({ email, source: 'signup' }, contentType));
    expect(response.status).toBe(200);
    // 応答は形式によらず JSON。素のフォーム送信に対する HTML 応答やリダイレクトは
    // 登録画面を所有する T7 の範囲で、ここでは転送先を決めない。
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const body = (await response.json()) as { registered: boolean; waitingCount: number };
    expect(body.registered).toBe(true);
    expect(body.waitingCount).toBe(coarsenWaitlistCount(await countWaitlist(env.DB)));

    const row = await env.DB.prepare('select source from waitlist where email = ?')
      .bind(email)
      .first<{ source: string | null }>();
    expect(row?.source).toBe('signup');
  });

  it('重複登録が新規と区別できない応答を返す', async () => {
    // 区別できる応答（409 や「既に登録済みです」）を返すと、任意のアドレスが
    // 登録済みかどうかを外部から確かめられる（列挙）。
    const email = uniqueEmail(`${label}-http-duplicate`);
    const first = await SELF.fetch(postFields({ email, source: 'landing' }, contentType));
    const countAfterFirst = await countWaitlist(env.DB);
    const second = await SELF.fetch(postFields({ email, source: 'landing' }, contentType));

    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    expect(await countWaitlist(env.DB)).toBe(countAfterFirst);
  });

  it('大文字と小文字の違いだけの再登録でも件数が増えない', async () => {
    const email = uniqueEmail(`${label}-http-case`);
    await SELF.fetch(postFields({ email }, contentType));
    const afterFirst = await countWaitlist(env.DB);
    const response = await SELF.fetch(postFields({ email: email.toUpperCase() }, contentType));

    expect(response.status).toBe(200);
    expect(await countWaitlist(env.DB)).toBe(afterFirst);
  });

  it('別の形式で送っても同じ 1 行として扱われる', async () => {
    // 形式が変わると別の行になる、という抜け道を作らないこと。
    const email = uniqueEmail(`${label}-http-cross-format`);
    await SELF.fetch(postFields({ email }, contentType));
    const afterFirst = await countWaitlist(env.DB);
    const other = contentType === JSON_TYPE ? FORM_TYPE : JSON_TYPE;

    const response = await SELF.fetch(postFields({ email }, other));
    expect(response.status).toBe(200);
    expect(await countWaitlist(env.DB)).toBe(afterFirst);
  });

  it('応答が登録したアドレスを含まない', async () => {
    const email = uniqueEmail(`${label}-http-echo`);
    const response = await SELF.fetch(postFields({ email }, contentType));
    expect(await response.text()).not.toContain(email);
  });

  it('不正な入力を 400 で返し、行を書かない', async () => {
    const before = await countWaitlist(env.DB);
    const rejected: Record<string, string>[] = [
      { email: 'not-an-email' },
      { email: uniqueEmail(`${label}-rejected`), source: 'unknown-path' },
      { source: 'landing' },
    ];
    for (const fields of rejected) {
      const response = await SELF.fetch(postFields(fields, contentType));
      expect(response.status, JSON.stringify(fields)).toBe(400);
    }
    expect(await countWaitlist(env.DB)).toBe(before);
  });

  it('巨大な本文を 400 で返す', async () => {
    const request = postFields(
      { email: uniqueEmail(`${label}-http-huge`), padding: 'x'.repeat(64 * 1024) },
      contentType,
    );
    const response = await SELF.fetch(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'body-too-large' });
  });
});

describe('POST /api/waitlist（形式によらない）', () => {
  it('未対応の Content-Type を 400 で返し、行を書かない', async () => {
    const before = await countWaitlist(env.DB);
    const response = await SELF.fetch(
      postRaw(JSON.stringify({ email: uniqueEmail('http-text') }), 'text/plain'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported-content-type' });
    expect(await countWaitlist(env.DB)).toBe(before);
  });

  it('壊れた本文を 400 で返す', async () => {
    for (const [body, contentType] of [
      ['{"email":', JSON_TYPE],
      [`email=${encodeURIComponent('a@example.com')}&email=${encodeURIComponent('b@example.com')}`, FORM_TYPE],
    ] as const) {
      const response = await SELF.fetch(postRaw(body, contentType));
      expect(response.status, contentType).toBe(400);
    }
  });

  it('保存に失敗したら 500 を返し、例外の中身を漏らさない', async () => {
    // 応答へ SQL のエラーをそのまま載せない。ログ側の方針は
    // src/waitlist.ts の describeWaitlistError に書いてある。
    const failingEnv = {
      APP_HOST: env.APP_HOST,
      SANDBOX_HOST: env.SANDBOX_HOST,
      BUCKET: env.BUCKET,
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error('D1_ERROR: 秘密の値 waitlist-secret@example.com を含む説明');
            },
          }),
        }),
      },
    } as unknown as Env;

    const response = await dispatch(
      waitlistRoutes,
      postFields({ email: uniqueEmail('http-failure') }, JSON_TYPE),
      failingEnv,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ error: 'internal error' }, null, 2));
  });

  it('GET は 405 を返す（一覧の経路を作らない）', async () => {
    // メールアドレスの束は個人情報で、認証機構が無い段階で読み出せる経路を開けない。
    const response = await SELF.fetch(`${APP_ORIGIN}${WAITLIST_PATH}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
