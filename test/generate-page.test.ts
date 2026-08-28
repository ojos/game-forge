import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppRoutes, handleAppRequest } from '../src/app.js';
import {
  CANDIDATE_KEYS_EXPRESSION,
  DEFAULT_MESSAGE_KEY,
  GENERATE_MESSAGES,
  NETWORK_MESSAGE_KEY,
  generateMessageKeyCandidates,
  renderGeneratePage,
  selectGenerateMessageKey,
} from '../src/generate-page.js';
import { GENERATE_PATH, MAX_PROMPT_LENGTH } from '../src/generate.js';
import { HOME_PATH } from '../src/home.js';
import { GENERATE_PAGE_PATH, SIGNUP_PATH } from '../src/paths.js';
import { LOGIN_PATH } from '../src/auth/google.js';
import { findDuplicateRoutes } from '../src/routes.js';
import { buildSessionCookie, signSession } from '../src/session.js';
import { applySchema } from './helpers/schema.js';

/**
 * 生成画面（5.2-1 / 4.4 / 8.3 / #128）。
 *
 * issue の acceptance 3 件のうち、ローカルで機械判定できる 2 件をここで押さえる
 * （3 件目は `bash scripts/verify.sh` そのもの）。あわせて、この画面が守ると
 * 宣言した性質——**応答本文の文字列を表示面へ持ち込まない**（8.3）——を、
 * 変異させて確かめる。
 *
 * **`/api/generate` は呼ばない。** 生成経路は本番で開通済みで、呼べば課金が発生する。
 * この画面が持つのは「送る手段」と「返ってきた状態から文言を選ぶ規則」だけなので、
 * 検査もそこで閉じる。
 */

const APP_ORIGIN = `https://${env.APP_HOST}`;
const SECRET = 'test-secret-value-for-generate-page-1';

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
 * @param options BAN 状態
 * @returns 利用者の id
 */
async function seedUser(suffix: string, options: { banned?: boolean } = {}): Promise<string> {
  const id = `page-user-${suffix}`;
  await env.DB.prepare(
    'insert into users (id, google_sub, email, display_name, created_at, banned_at) values (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, `sub-${id}`, `${id}@example.com`, suffix, options.banned === true ? 1 : null)
    .run();
  return id;
}

/**
 * セッション cookie を組み立てる。
 *
 * 失効時刻は実時刻から取る（`test/generate.test.ts` と同じ理由。固定値にすると
 * その日を過ぎた時点で壊れる時限式になる）。
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
 * 生成画面を開く。
 *
 * @param cookie `Cookie` ヘッダ（省略すると未ログイン）
 * @returns レスポンス
 */
async function openPage(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return await handleAppRequest(
    new Request(`${APP_ORIGIN}${GENERATE_PAGE_PATH}`, { headers }),
    testEnv(),
  );
}

/**
 * ページに埋め込まれたスクリプトを取り出す。
 *
 * **定数を直接 import せず、実際に配られる HTML から取る。** 検査したいのは
 * 「利用者のブラウザで動くもの」であって、モジュール内の文字列ではない。
 *
 * @param page ページの HTML
 * @returns `<script>` の中身
 */
function embeddedScript(page: string): string {
  const opened = page.indexOf('<script>');
  const closed = page.indexOf('</script>', opened);
  expect(opened).toBeGreaterThan(-1);
  expect(closed).toBeGreaterThan(opened);
  return page.slice(opened + '<script>'.length, closed);
}

beforeAll(async () => {
  await applySchema();
});

describe('未ログインの導線（acceptance 1 / 8.1）', () => {
  it('未ログインで開くと登録導線が出る', async () => {
    const response = await openPage();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const body = await response.text();
    expect(body).toContain(`href="${SIGNUP_PATH}"`);
    expect(body).toContain(`href="${LOGIN_PATH}"`);
    expect(body).toContain(`href="${HOME_PATH}"`);
    expect(body).toContain('待機リスト');
  });

  it('未ログインにはプロンプトの入力フォームを出さない', async () => {
    // 押しても必ず 401 になるフォームを出すと、利用者から見て「壊れている」ことと
    // 「登録が要る」ことの区別がつかない（`src/invite-issuance.ts` と同じ判断）。
    const body = await (await openPage()).text();
    expect(body).not.toContain('id="generate-form"');
    expect(body).not.toContain(`action="${GENERATE_PATH}"`);
    // 文言を隠し持たせてもいない（`hidden` を外すだけで見える状態にしない）。
    expect(body).not.toContain('data-message-key');
  });

  it('BAN された利用者は未ログインと同じ扱いになる', async () => {
    // 判定は `resolveSessionUser` に寄せてある。画面側で署名だけを見る実装にすると、
    // BAN が最大 7 日効かない（`src/session-user.ts`）。
    const banned = await seedUser('banned', { banned: true });
    const body = await (await openPage(await sessionCookie(banned))).text();
    expect(body).not.toContain('id="generate-form"');
    expect(body).toContain(`href="${SIGNUP_PATH}"`);
  });
});

describe('ログイン済みの入力フォーム（acceptance 2 / 5.2-1）', () => {
  it('プロンプトを送れるフォームが出る', async () => {
    const user = await seedUser('form');
    const body = await (await openPage(await sessionCookie(user))).text();

    expect(body).toContain('id="generate-form"');
    expect(body).toContain(`action="${GENERATE_PATH}"`);
    expect(body).toContain('name="prompt"');
    // 上限は `src/generate.ts` の定数から取る。書き写すと、あちらを見直したときに
    // 画面だけが古い上限で切る。
    expect(body).toContain(`maxlength="${MAX_PROMPT_LENGTH}"`);
  });

  it('待っている間に何も出ない状態を作らない（1.2.27 / #30 の手前）', async () => {
    const user = await seedUser('waiting');
    const body = await (await openPage(await sessionCookie(user))).text();

    // 経過表示の器と、通常かかる時間。生成は同期で 20〜30 秒かかる。
    expect(body).toContain('id="generate-progress"');
    expect(body).toContain('id="generate-elapsed"');
    expect(body).toContain('20〜30 秒');

    const script = embeddedScript(body);
    // 送信直後に器を見せ、1 秒ごとに経過を更新すること。
    expect(script).toContain('startWaiting()');
    expect(script).toContain('progress.hidden = false');
    expect(script).toContain('setInterval');
    // 二重送信で枠を空撃ちしないこと（1 回あたり約 12 円が出る経路である）。
    expect(script).toContain('button.disabled = true');
  });

  it('JavaScript が要ることを画面上で断っている', async () => {
    // `/api/generate` は JSON しか受け付けない（`src/generate.ts`）。素のフォーム送信では
    // 届かないので、動かない環境に黙って空振りさせない。
    const user = await seedUser('noscript');
    const body = await (await openPage(await sessionCookie(user))).text();
    expect(body).toContain('<noscript>');
    expect(body).toContain('JavaScript が必要です');
    // 押しても必ず断られるボタンを出さない。HTML では無効で描き、スクリプトが
    // 動いたときだけ押せるようにする。
    expect(body).toContain('type="submit" disabled');
    expect(embeddedScript(body)).toContain('button.disabled = false;');
  });

  it('生成物をこの画面で描かない（7.2）', async () => {
    const user = await seedUser('sandboxed');
    const body = await (await openPage(await sessionCookie(user))).text();
    // 成果物を読み込む要素を持たない。配信は別オリジン（サンドボックス側）が持つ。
    expect(body).not.toContain('<iframe');
    expect(body).not.toContain('.wasm');
    expect(body).not.toContain('wasm_exec');
  });
});

describe('失敗の種別ごとの文言（acceptance 2 / 4.4 / 3.8）', () => {
  it('429 と 422 が読める文言に対応づく', async () => {
    const user = await seedUser('messages');
    const body = await (await openPage(await sessionCookie(user))).text();

    // 表の鍵がそのまま描かれていること（スクリプトはこれを引くだけである）。
    for (const key of Object.keys(GENERATE_MESSAGES)) {
      expect(body, key).toContain(`data-message-key="${key}"`);
    }
    // 枠切れ（429）と、許可外 import / ビルド失敗（422 の 2 種）を出し分ける。
    expect(selectGenerateMessageKey(429, 'quota exceeded')).toBe('429:');
    expect(selectGenerateMessageKey(422, 'source-rejected')).toBe('422:source-rejected');
    expect(selectGenerateMessageKey(422, 'build-failed')).toBe('422:build-failed');
    // 分類を知らない 422 でも、422 としての文言まではたどり着く。
    expect(selectGenerateMessageKey(422, 'something-new')).toBe('422:');
    // 知らないステータスは既定へ倒す（`src/signup.ts` の `REASON_MESSAGES` と同じ）。
    expect(selectGenerateMessageKey(418, '')).toBe(DEFAULT_MESSAGE_KEY);
  });

  it('422 の 2 種は「消費した枠の数」が違うことまで伝える（5.2-7）', () => {
    // 5.2-7 の注記は「試行回数と、消費した枠の回数を書いた固定の文言を載せる」と
    // 定めている（4.4 の残枠が 3 減る理由が利用者から見て消えないため）。
    expect(GENERATE_MESSAGES['422:source-rejected']).toContain('この試行ぶん');
    expect(GENERATE_MESSAGES['422:build-failed']).toContain('試行した回数ぶん');
  });

  it('500 は degrade（3.8）としても読める', () => {
    // ビルド関数の失敗・タイムアウト・スロットリングは `BuildRejected` ではないため
    // 経路層の既定の catch に落ち、500 になる。3.8 は「プレイ側には一切影響を出さない」
    // と定めるので、そこまでを文言に含める。
    expect(GENERATE_MESSAGES['500:']).toContain('プレイと共有');
  });

  it('応答が返らなかった場合の文言を持つ', () => {
    // ブラウザ側のタイムアウトや通信断。**枠を消費した可能性を隠さない**
    // （生成そのものは Workers 側で走り続けうる。1.2.27）。
    expect(GENERATE_MESSAGES[NETWORK_MESSAGE_KEY]).toContain('生成枠を消費');
  });
});

describe('4.4 の停止時の文言の機械照合', () => {
  /**
   * 仕様書 4.4 の節を切り出す。
   *
   * @param spec 仕様書の本文
   * @returns 4.4 の節
   */
  function section44(spec: string): string {
    const start = spec.indexOf('### 4.4 生成枠の UX 上の扱い');
    const end = spec.indexOf('### 4.5', start);
    return spec.slice(start, end);
  }

  /**
   * 4.4 の中で、ある目印を含む行が鉤括弧で囲んでいる文言を取り出す。
   *
   * @param spec 仕様書の本文
   * @param marker 行を特定する目印
   * @returns 鉤括弧の中身（見つからなければ空文字）
   */
  function quotedWording(spec: string, marker: string): string {
    const line = section44(spec)
      .split('\n')
      .find((candidate) => candidate.includes(marker));
    return line?.match(/「([^」]+)」/u)?.[1] ?? '';
  }

  it('429 の文言が 4.4 の言い回しをそのまま含む', () => {
    // 同じ文言が仕様書と画面の 2 か所にある以上、機械で照合する
    // （shared-ai-rules 12 章）。「更新したか」ではなく「一致しているか」を見る。
    const daily = quotedWording(env.TEST_PRODUCT_SPEC, '枠が尽きたら');
    const monthly = quotedWording(env.TEST_PRODUCT_SPEC, '月次上限に達した場合');
    expect(daily).not.toBe('');
    expect(monthly).not.toBe('');

    const message = GENERATE_MESSAGES['429:']!;
    expect(message).toContain(daily);
    expect(message).toContain(monthly);
    // 4.4 は「翌日の再開時刻を示す」ことも求める。枠が戻るのは JST の 0 時
    // （確定25 / `src/quota.ts` の `jstDayRange`）。
    expect(message).toContain('翌日 0 時');
  });

  it('仕様書側を変異させると照合が破れる', () => {
    // **この検査が効いていることを確かめる。** 上のテストは、抽出が何も拾わない
    // 状態でも `toContain('')` で通ってしまう（空文字の検査はその一部しか塞がない）。
    const doctored = env.TEST_PRODUCT_SPEC.replace(
      '「本日の枠は終了しました」',
      '「本日ぶんの生成は締め切りました」',
    );
    expect(doctored).not.toBe(env.TEST_PRODUCT_SPEC);
    expect(quotedWording(doctored, '枠が尽きたら')).toBe('本日ぶんの生成は締め切りました');
    expect(GENERATE_MESSAGES['429:']).not.toContain(quotedWording(doctored, '枠が尽きたら'));
  });
});

describe('8.3 の検査を通っていない文字列を表示面へ持ち込まない', () => {
  /**
   * DOM へ文字列を書き込みうる経路を数え上げる。
   *
   * @param script 埋め込みスクリプト
   * @returns 見つかった経路の名前
   */
  function sinksIn(script: string): string[] {
    const sinks = [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'createContextualFragment',
    ];
    return sinks.filter((sink) => script.includes(sink));
  }

  /**
   * `textContent` へ代入している式をすべて拾う。
   *
   * @param script 埋め込みスクリプト
   * @returns 代入されている式
   */
  function textAssignments(script: string): string[] {
    return [...script.matchAll(/textContent\s*=\s*([^;]+);/gu)].map((matched) =>
      matched[1]!.trim(),
    );
  }

  /**
   * 代入されてよい式か（数値から作った経過秒数だけを許す）。
   *
   * @param expression 代入されている式
   * @returns 許してよければ true
   */
  function isElapsedOnly(expression: string): boolean {
    return expression === "'0'" || /^String\(/u.test(expression);
  }

  it('スクリプトが HTML を書き込む経路を持たない', async () => {
    const user = await seedUser('sinks');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());
    expect(sinksIn(script)).toEqual([]);
  });

  it('スクリプトが文字を書くのは経過秒数だけである', async () => {
    const user = await seedUser('text');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());

    const assignments = textAssignments(script);
    // 器が空だと「代入が 1 つも無い」状態を合格にしてしまう。
    expect(assignments.length).toBeGreaterThan(0);
    for (const expression of assignments) {
      expect(isElapsedOnly(expression), expression).toBe(true);
    }
    // 応答本文の他の項目（生成物由来の import パスや理由）に触れていないこと。
    for (const field of ['.imports', '.reason', '.step', '.message', '.gameId']) {
      expect(script, field).not.toContain(field);
    }
  });

  it('変異させると上の 2 つの検査が破れる', async () => {
    // **この 2 つの検査が効いていることを確かめる。** 応答から来た文字列を画面へ
    // 書く実装を作り、検出できることを見る。検出できないなら、上の検査は
    // 「たまたま今の書き方が通っている」だけになる。
    const user = await seedUser('mutation');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());

    const leaksText = script.replace("elapsed.textContent = '0';", 'elapsed.textContent = code;');
    expect(leaksText).not.toBe(script);
    expect(textAssignments(leaksText).some((expression) => !isElapsedOnly(expression))).toBe(true);

    const leaksHtml = script.replace(
      "elapsed.textContent = '0';",
      'progress.innerHTML = outcome.code;',
    );
    expect(leaksHtml).not.toBe(script);
    expect(sinksIn(leaksHtml)).toContain('innerHTML');
  });

  it('分類名は鍵にしかならない（敵対的な値でも表の外へ出ない）', () => {
    // 応答の `error` は、経路層が固定文字列で入れている値だが、**画面はそれを
    // 前提にしない。** 生成物由来の文字列や HTML の断片が入っても、選ばれるのは
    // 必ず表の鍵である。
    const hostile = [
      '<img src=x onerror=alert(1)>',
      '__proto__',
      'constructor',
      './main.go:12:2: undefined: foo',
      'github.com/example/not-allowed',
      '"><script>alert(1)</script>',
    ];
    for (const value of hostile) {
      const key = selectGenerateMessageKey(422, value);
      expect(Object.keys(GENERATE_MESSAGES), value).toContain(key);
      const message = GENERATE_MESSAGES[key]!;
      expect(message, value).not.toContain(value);
    }
  });

  it('鍵の候補の順序が、埋め込みスクリプトと一致する', async () => {
    // 同じ順序が TypeScript と埋め込みスクリプトの 2 か所にある。式は文字列の連結
    // だけなので、置換で「その式が作る値」を機械的に再現して突き合わせる。
    const user = await seedUser('candidates');
    const script = embeddedScript(await (await openPage(await sessionCookie(user))).text());
    expect(script).toContain(CANDIDATE_KEYS_EXPRESSION);

    /**
     * 候補キーの式を、与えられた値で評価する（連結だけなので置換で足りる）。
     *
     * @param expression 候補キーの式
     * @returns 式が作る鍵の配列
     */
    function evaluate(expression: string): string[] {
      return expression
        .replace(/[[\]\s]/gu, '')
        .split(',')
        .map((piece) =>
          piece
            .replaceAll("'", '')
            .replaceAll('status', '422')
            .replaceAll('code', 'build-failed')
            .replaceAll('+', ''),
        );
    }

    expect(evaluate(CANDIDATE_KEYS_EXPRESSION)).toEqual([
      ...generateMessageKeyCandidates(422, 'build-failed'),
    ]);

    // **変異検査。** 順序を入れ替えた式では一致しないこと（一致してしまうなら、
    // 上の照合は順序を見ていない）。
    const doctored = "[status + ':', status + ':' + code, '']";
    expect(evaluate(doctored)).not.toEqual([...generateMessageKeyCandidates(422, 'build-failed')]);
  });
});

describe('残枠の差し込み口（#24 が乗る形）', () => {
  it('渡された文言を出す口がある', () => {
    // #24 は「本日の残り生成枠 N回」を出す（4.4）。値を作る経路はあちらが持ち、
    // この画面は差し込み口だけを持つ。
    const page = renderGeneratePage(true, { quotaNotice: '本日の残り生成枠 7回' });
    expect(page).toContain('id="generate-quota"');
    expect(page).toContain('本日の残り生成枠 7回');
  });

  it('渡さなければ何も出ない', () => {
    expect(renderGeneratePage(true, { quotaNotice: null })).not.toContain('id="generate-quota"');
  });

  it('差し込まれた値を無害化する', () => {
    // いまは固定文字列しか来ない想定でも、安全側を既定にしておく
    // （`src/signup.ts` / `src/invite-issuance.ts` と同じ理由）。
    const hostile = '<img src=x onerror=alert(1)>';
    const page = renderGeneratePage(true, { quotaNotice: hostile });
    expect(page).not.toContain(hostile);
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('経路の登録', () => {
  it('本番の設定でも生成画面が登録され、経路が重複しない', () => {
    const productionEnv = { ...env, DEV_ROUTES: 'disabled' } as unknown as Env;
    const registered = createAppRoutes(productionEnv).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(registered).toContain(`GET ${GENERATE_PAGE_PATH}`);
    // API の経路は画面と別のパスに置く（`src/invite-issuance.ts` と同じ理由）。
    expect(registered).toContain(`POST ${GENERATE_PATH}`);
    expect(findDuplicateRoutes(createAppRoutes(productionEnv))).toEqual([]);
    expect(findDuplicateRoutes(createAppRoutes(env))).toEqual([]);
  });
});

describe('公開トップの書き換え（#128）', () => {
  it('「生成機能はまだ公開していません」が消え、生成画面への導線がある', async () => {
    const body = await (await handleAppRequest(new Request(`${APP_ORIGIN}${HOME_PATH}`), env)).text();
    expect(body).not.toContain('生成機能はまだ公開していません');
    expect(body).toContain(`href="${GENERATE_PAGE_PATH}"`);
    // 押した先で何十秒も待つことを、押す前に知らせる（1.2.27）。
    expect(body).toContain('20〜30 秒');
  });
});
